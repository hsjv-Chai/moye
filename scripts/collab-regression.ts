import fs from "node:fs";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import WebSocket from "ws";
import * as Y from "yjs";
import { newChapter } from "../shared/model";
const config = JSON.parse(fs.readFileSync(".runtime/collab-test.json", "utf8"));
const base = config.base,
  id = config.bookId,
  token = config.admin.token;
async function req(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
  auth = token,
  status = 200,
) {
  const r = await fetch(base + path, {
    method,
    headers: {
      Authorization: "Bearer " + auth,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json();
  assert.equal(r.status, status, JSON.stringify(data));
  return data as any;
}
let room = await req(`/api/books/${id}`);
async function structure(action: any) {
  room = await req(`/api/books/${id}/structure`, {
    epoch: room.epoch,
    revision: room.revision,
    action,
  });
}
const chapter = newChapter("不同章节同步测试");
await structure({ kind: "addChapter", chapter });
const setting = {
  id: randomUUID(),
  title: "世界规则",
  category: "世界观",
  role: "",
  traits: "",
  content: "海边的世界",
};
await structure({ kind: "addSetting", setting });
const volume = { id: randomUUID(), title: "卷一", outline: "起点" };
await structure({ kind: "addVolume", volume });
await structure({ kind: "assignVolume", id: chapter.id, volumeId: volume.id });
await structure({
  kind: "move",
  collection: "volumes",
  id: volume.id,
  delta: -1,
});
const doc = new Y.Doc();
Y.applyUpdate(doc, Buffer.from(room.state, "base64"));
const bodyKey = `chapter:${room.book.chapters[0].id}:body`;
const manuscript = "春潮带雨晚来急。\n".repeat(25000);
await req(`/api/books/${id}/edit`, {
  epoch: room.epoch,
  edit: {
    field: bodyKey,
    baseline: room.book.chapters[0].body,
    text: manuscript,
    mode: "replace",
    reason: "中文长篇协作验收",
  },
});
room = await req(`/api/books/${id}`);
assert.equal(room.book.chapters[0].body, manuscript);
class Peer {
  doc = new Y.Doc();
  ws: WebSocket;
  messages: any[] = [];
  pending = new Set<string>();
  constructor(auth: string) {
    this.ws = new WebSocket(base.replace(/^http/, "ws") + "/sync/" + id, {
      headers: { Authorization: "Bearer " + auth },
    });
    this.ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      this.messages.push(m);
      if (m.type === "ready" || m.type === "room")
        Y.applyUpdate(this.doc, Buffer.from(m.room.state, "base64"));
      if (m.type === "update")
        Y.applyUpdate(this.doc, Buffer.from(m.update, "base64"));
      if (m.type === "ack") this.pending.delete(m.id);
    });
  }
  async wait(f: () => boolean) {
    const until = Date.now() + 20000;
    while (!f()) {
      if (Date.now() > until) throw new Error("Regression timeout");
      await new Promise((r) => setTimeout(r, 40));
    }
  }
  async ready() {
    await this.wait(() => this.messages.some((m) => m.type === "ready"));
  }
  edit(key: string, value: string) {
    const sv = Y.encodeStateVector(this.doc);
    const t = this.doc.getMap<Y.Text>("texts").get(key)!;
    t.insert(t.length, value);
    const op = randomUUID();
    this.pending.add(op);
    this.ws.send(
      JSON.stringify({
        type: "update",
        id: op,
        epoch: room.epoch,
        update: Buffer.from(Y.encodeStateAsUpdate(this.doc, sv)).toString(
          "base64",
        ),
      }),
    );
  }
  close() {
    this.ws.close();
    this.doc.destroy();
  }
}
const a = new Peer(token),
  b = new Peer(config.editor.token);
await Promise.all([a.ready(), b.ready()]);
a.edit(bodyKey, "长篇末尾");
b.edit(`chapter:${chapter.id}:body`, "另一个章节");
a.edit(`setting:${setting.id}:content`, "潮汐由月亮决定");
b.edit(`volume:${volume.id}:outline`, "远航");
await Promise.all([
  a.wait(() => a.pending.size === 0),
  b.wait(() => b.pending.size === 0),
]);
await a.wait(
  () =>
    a.doc
      .getMap<Y.Text>("texts")
      .get(`chapter:${chapter.id}:body`)!
      .toString() === "另一个章节",
);
await b.wait(() =>
  b.doc.getMap<Y.Text>("texts").get(bodyKey)!.toString().endsWith("长篇末尾"),
);
const before = await req(`/api/books/${id}`);
a.close();
b.close();
await promisify(execFile)(
  "bash",
  ["scripts/ecs.sh", "cd /opt/moye/deploy && sudo docker compose restart app"],
  { timeout: 45000 },
);
let after: any;
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    after = await req(`/api/books/${id}`);
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}
assert.deepEqual(after.book, before.book);
const stale = new Peer(config.editor.token);
await stale.ready();
await structure({ kind: "delete", collection: "settings", id: setting.id });
await stale.wait(() => stale.messages.some((m) => m.type === "room"));
assert.equal(
  stale.doc.getMap("texts").has(`setting:${setting.id}:content`),
  false,
);
stale.close();
const temporary = {
  username: "validation_disabled_" + Date.now(),
  displayName: "停用验证",
  password: randomBytes(24).toString("base64url"),
  admin: false,
};
const u = await req("/api/users", temporary);
let login = await req("/api/login", temporary);
await req(
  "/api/password",
  { oldPassword: temporary.password, newPassword: temporary.password + "new" },
  "POST",
  login.token,
);
await req(`/api/books/${id}/members/${u.id}`, { role: "editor" }, "PUT");
const disabled = new Peer(login.token);
await disabled.ready();
await req(`/api/users/${u.id}`, { active: false }, "PATCH");
await disabled.wait(() => disabled.messages.some((m) => m.type === "denied"));
await req(`/api/books/${id}`, undefined, "GET", login.token, 401);
disabled.close();
const backup = await req(`/api/books/${id}/backup`);
assert.ok(backup.versions.some((v: any) => v.reason === "中文长篇协作验收"));
assert.equal(backup.book.chapters[0].body, manuscript + "长篇末尾");
// Return the validation book to a small text to keep the desktop fixture readable.
room = await req(`/api/books/${id}`);
await req(`/api/books/${id}/edit`, {
  epoch: room.epoch,
  edit: {
    field: bodyKey,
    baseline: room.book.chapters[0].body,
    text: "协作长篇测试完成。",
    mode: "replace",
    reason: "验收清理",
  },
});
console.log(
  "PASS: 225000-character Chinese manuscript, independent chapters, shared settings/outline, structure updates/deletion, persisted acknowledgements after server restart, account disable closes session, complete shared-history backup.",
);
doc.destroy();
