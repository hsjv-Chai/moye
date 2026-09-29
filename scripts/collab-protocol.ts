import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID, randomBytes } from "node:crypto";
import WebSocket from "ws";
import * as Y from "yjs";
import { newBook, newChapter } from "../shared/model";
const base = process.env.MOYE_TEST_SERVER || "https://114.215.182.66";
const adminFile = ".runtime/test-admin-bootstrap.json";
const admin = JSON.parse(fs.readFileSync(adminFile, "utf8"));
async function request(
  path: string,
  token = "",
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
  expected = 200,
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  assert.equal(response.status, expected, JSON.stringify(data));
  return data as any;
}
const auth = await request("/api/login", "", {
  username: admin.username,
  password: admin.password,
});
if (auth.user.mustChangePassword) {
  const password = randomBytes(24).toString("base64url");
  await request("/api/password", auth.token, {
    oldPassword: admin.password,
    newPassword: password,
  });
  admin.password = password;
  fs.writeFileSync(adminFile, JSON.stringify(admin), { mode: 0o600 });
}
const suffix = Date.now().toString(36);
const users: any[] = [];
for (const role of ["editor", "reader"]) {
  const input = {
    username: `validation_${role}_${suffix}`,
    displayName: role === "editor" ? "验收编辑者" : "验收只读者",
    password: randomBytes(24).toString("base64url"),
    admin: false,
  };
  const u = await request("/api/users", auth.token, input);
  const a = await request("/api/login", "", input);
  const password = randomBytes(24).toString("base64url");
  await request("/api/password", a.token, {
    oldPassword: input.password,
    newPassword: password,
  });
  users.push({ ...input, password, id: u.id, token: a.token, role });
}
const editor = users[0],
  reader = users[1];
const published = await request(
  "/api/books",
  auth.token,
  newBook("协作自动验收 " + suffix),
);
const id = published.id;
for (const u of users)
  await request(
    `/api/books/${id}/members/${u.id}`,
    auth.token,
    { role: u.role },
    "PUT",
  );
const other = await request("/api/books", auth.token, newBook("权限隔离验收"));
await request(`/api/books/${other.id}`, editor.token, undefined, "GET", 403);
await request("/api/users", editor.token, undefined, "GET", 403);
let room = await request(`/api/books/${id}`, editor.token);
const field = `chapter:${room.book.chapters[0].id}:body`;
await request(
  `/api/books/${id}/structure`,
  reader.token,
  {
    epoch: room.epoch,
    revision: room.revision,
    action: { kind: "addChapter", chapter: newChapter("越权") },
  },
  "POST",
  403,
);
class Client {
  socket: WebSocket;
  doc = new Y.Doc();
  messages: any[] = [];
  epoch = 1;
  pending = new Map<string, number>();
  latencies: number[] = [];
  delay = 0;
  constructor(token: string, delay = 0) {
    this.delay = delay;
    this.socket = new WebSocket(base.replace(/^http/, "ws") + "/sync/" + id, {
      headers: { Authorization: "Bearer " + token },
    });
    this.socket.on("message", (raw) =>
      setTimeout(() => {
        const m = JSON.parse(raw.toString());
        this.messages.push(m);
        if (m.type === "ready" || m.type === "room") {
          const r = m.room;
          if (this.epoch !== r.epoch) {
            this.doc.destroy();
            this.doc = new Y.Doc();
          }
          this.epoch = r.epoch;
          Y.applyUpdate(this.doc, Buffer.from(r.state, "base64"));
        }
        if (m.type === "update")
          Y.applyUpdate(this.doc, Buffer.from(m.update, "base64"));
        if (m.type === "ack") {
          const started = this.pending.get(m.id);
          if (started) this.latencies.push(performance.now() - started);
          this.pending.delete(m.id);
        }
      }, delay),
    );
  }
  async wait(fn: () => boolean) {
    const end = Date.now() + 15000;
    while (!fn()) {
      if (Date.now() > end)
        throw new Error(
          "Protocol wait timed out: " + JSON.stringify(this.messages.slice(-3)),
        );
      await new Promise((r) => setTimeout(r, 15));
    }
  }
  async ready() {
    await this.wait(() => this.messages.some((m) => m.type === "ready"));
  }
  text() {
    return this.doc.getMap<Y.Text>("texts").get(field)!;
  }
  send(update: Uint8Array, opId = randomUUID()) {
    this.pending.set(opId, performance.now());
    setTimeout(
      () =>
        this.socket.send(
          JSON.stringify({
            type: "update",
            id: opId,
            epoch: this.epoch,
            update: Buffer.from(update).toString("base64"),
          }),
        ),
      this.delay,
    );
    return opId;
  }
  edit(text: string) {
    const vector = Y.encodeStateVector(this.doc);
    this.text().insert(this.text().length, text);
    return this.send(Y.encodeStateAsUpdate(this.doc, vector));
  }
  close() {
    this.socket.close();
    this.doc.destroy();
  }
}
const clients = Array.from({ length: 10 }, () => new Client(editor.token, 50));
await Promise.all(clients.map((c) => c.ready()));
for (let round = 0; round < 8; round++) {
  for (let i = 0; i < clients.length; i++)
    clients[i].edit(`【${round}-${i}中文】`);
  await new Promise((r) => setTimeout(r, 220));
}
await Promise.all(clients.map((c) => c.wait(() => c.pending.size === 0)));
await new Promise((r) => setTimeout(r, 300));
const text = clients[0].text().toString();
for (const c of clients) assert.equal(c.text().toString(), text);
assert.equal((text.match(/中文/g) || []).length, 80);
const latency = clients.flatMap((c) => c.latencies).sort((a, b) => a - b);
const p95 = latency[Math.ceil(latency.length * 0.95) - 1];
assert.ok(p95 <= 1000, `P95 ${p95}`);
const c = clients[0];
const vector = Y.encodeStateVector(c.doc);
c.text().insert(0, "重复只出现一次");
const update = Y.encodeStateAsUpdate(c.doc, vector),
  op = c.send(update);
await c.wait(() => !c.pending.has(op));
c.send(update, op);
await c.wait(() => !c.pending.has(op));
room = await request(`/api/books/${id}`, auth.token);
assert.equal(room.book.chapters[0].body.split("重复只出现一次").length, 2);
// Two offline replicas merge on reconnect, and duplicated messages are harmless.
const offline = [new Y.Doc(), new Y.Doc()];
for (const d of offline) Y.applyUpdate(d, Buffer.from(room.state, "base64"));
const updates = offline.map((d, i) => {
  const sv = Y.encodeStateVector(d);
  d.getMap<Y.Text>("texts").get(field)!.insert(0, `离线${i}稿`);
  return Y.encodeStateAsUpdate(d, sv);
});
for (const u of updates) c.send(u);
await c.wait(() => c.pending.size === 0);
room = await request(`/api/books/${id}`, auth.token);
assert.match(room.book.chapters[0].body, /离线0稿/);
assert.match(room.book.chapters[0].body, /离线1稿/);
await request(
  `/api/books/${id}/edit`,
  auth.token,
  {
    epoch: room.epoch,
    edit: {
      field,
      baseline: "过时原文",
      text: "不可覆盖",
      mode: "replace",
      reason: "AI验收",
    },
  },
  "POST",
  409,
);
await request(`/api/books/${id}/versions`, auth.token, {});
const versions = await request(`/api/books/${id}/versions`, auth.token);
const beforeRestore = room.book.chapters[0].body;
await request(`/api/books/${id}/edit`, auth.token, {
  epoch: room.epoch,
  edit: {
    field,
    baseline: beforeRestore,
    text: "新版",
    mode: "replace",
    reason: "AI验收",
  },
});
room = await request(`/api/books/${id}/restore`, auth.token, {
  versionId: versions[0].id,
});
assert.equal(room.book.chapters[0].body, beforeRestore);
assert.equal(room.epoch, 2);
await request(
  `/api/books/${id}/edit`,
  editor.token,
  {
    epoch: 1,
    edit: {
      field,
      baseline: "",
      text: "旧代次",
      mode: "append",
      reason: "旧客户端",
    },
  },
  "POST",
  409,
);
const ro = new Client(reader.token);
await ro.ready();
ro.edit("只读越权");
await ro.wait(() => ro.messages.some((m) => m.type === "rejected"));
assert.equal(
  (
    await request(`/api/books/${id}`, auth.token)
  ).book.chapters[0].body.includes("只读越权"),
  false,
);
ro.close();
await request(
  `/api/books/${id}/members/${editor.id}`,
  auth.token,
  { role: null },
  "PUT",
);
await c.wait(() => c.messages.some((m) => m.type === "denied"));
await request(`/api/books/${id}`, editor.token, undefined, "GET", 403);
await request(
  `/api/books/${id}/members/${editor.id}`,
  auth.token,
  { role: "editor" },
  "PUT",
);
for (const client of clients) client.close();
for (const d of offline) d.destroy();
await request(`/api/books/${other.id}`, auth.token, undefined, "DELETE");
fs.writeFileSync(
  ".runtime/collab-test.json",
  JSON.stringify({
    base,
    admin: { ...admin, token: auth.token },
    editor,
    reader,
    bookId: id,
  }),
  { mode: 0o600 },
);
fs.mkdirSync("test-results", { recursive: true });
fs.writeFileSync(
  "test-results/collab-protocol.json",
  JSON.stringify(
    {
      date: new Date().toISOString(),
      server: base,
      clients: 10,
      updates: 80,
      addedRoundTripDelayMs: 100,
      p95Ms: Math.round(p95),
      converged: true,
      checks: [
        "HTTPS/WSS",
        "permissions",
        "10 clients",
        "duplicate delivery",
        "offline merge",
        "atomic conflict",
        "history epoch",
        "reader rejection",
        "revocation",
      ],
    },
    null,
    2,
  ),
);
console.log(
  `PASS: HTTPS/WSS, 10 concurrent clients, 80 Chinese edits, 100ms added RTT, P95=${Math.round(p95)}ms, convergence, offline merge, duplicate update, authorization, AI conflict, restore epoch, revocation.`,
);
