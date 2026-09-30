import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import * as Y from "yjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Store } from "../electron/store";
import { CollaborationClient } from "../electron/collaboration";
import { newBook, newChapter, uid } from "../shared/model";
import {
  createDoc,
  project,
  fields,
  reconcileDoc,
  structuralChange,
  validDoc,
  type Room,
} from "../shared/collab";
const clone = (d: Y.Doc) => {
  const out = new Y.Doc();
  Y.applyUpdate(out, Y.encodeStateAsUpdate(d));
  return out;
};
describe("collaborative documents", () => {
  it("converges concurrent Chinese edits, duplicate updates, and independent chapters", () => {
    const b = newBook("多人");
    b.chapters.push(newChapter("第二章"));
    const seed = createDoc(b),
      a = clone(seed),
      c = clone(seed);
    a.getMap<Y.Text>("texts")
      .get(`chapter:${b.chapters[0].id}:body`)!
      .insert(0, "甲的故事");
    c.getMap<Y.Text>("texts")
      .get(`chapter:${b.chapters[0].id}:body`)!
      .insert(0, "乙的故事");
    c.getMap<Y.Text>("texts")
      .get(`chapter:${b.chapters[1].id}:body`)!
      .insert(0, "另一章");
    const update = Y.encodeStateAsUpdate(c);
    Y.applyUpdate(a, update);
    Y.applyUpdate(a, update);
    Y.applyUpdate(c, Y.encodeStateAsUpdate(a));
    expect(project(b, a)).toEqual(project(b, c));
    expect(project(b, a).chapters[0].body).toHaveLength(8);
    expect(project(b, a).chapters[1].body).toBe("另一章");
    [a, c, seed].forEach((d) => d.destroy());
  });
  it("undo removes only local changes", () => {
    const b = newBook("撤销"),
      a = createDoc(b),
      c = clone(a),
      key = `chapter:${b.chapters[0].id}:body`,
      t = a.getMap<Y.Text>("texts").get(key)!;
    const undo = new Y.UndoManager(t, { trackedOrigins: new Set(["self"]) });
    a.transact(() => t.insert(0, "甲"), "self");
    c.getMap<Y.Text>("texts").get(key)!.insert(0, "乙");
    Y.applyUpdate(a, Y.encodeStateAsUpdate(c), "remote");
    undo.undo();
    expect(t.toString()).toBe("乙");
    undo.destroy();
    a.destroy();
    c.destroy();
  });
  it("structure uses stable IDs and deletion cannot be resurrected by offline text", () => {
    const b = newBook("删除"),
      d = createDoc(b),
      offline = clone(d),
      key = `chapter:${b.chapters[0].id}:body`;
    offline.getMap<Y.Text>("texts").get(key)!.insert(0, "离线文本");
    const next = structuralChange(b, {
      kind: "delete",
      collection: "chapters",
      id: b.chapters[0].id,
    });
    reconcileDoc(b, next, d);
    Y.applyUpdate(d, Y.encodeStateAsUpdate(offline));
    validDoc(next, d);
    expect(d.getMap("texts").has(key)).toBe(false);
    d.destroy();
    offline.destroy();
  });
  it("rejects document-level map replacement and extraneous fields", () => {
    const b = newBook("验证"),
      d = createDoc(b);
    d.getMap("unauthorized").set("x", 1);
    expect(() => validDoc(b, d)).toThrow();
    d.destroy();
  });
});
let folder: string, store: Store, client: CollaborationClient;
const user = {
  id: uid(),
  username: "test",
  displayName: "测试",
  admin: false,
  active: true,
  mustChangePassword: false,
};
const vault = {
  available: () => true,
  encrypt: (s: string) => Buffer.from(s).toString("base64"),
  decrypt: (s: string) => Buffer.from(s, "base64").toString(),
};
const scope = createHash("sha256")
  .update(`https://example.com/${user.id}`)
  .digest("hex");
function setupRoom() {
  const b = newBook("离线作品"),
    d = createDoc(b);
  const room: Room = {
    book: b,
    state: Buffer.from(Y.encodeStateAsUpdate(d)).toString("base64"),
    epoch: 1,
    revision: 1,
    role: "editor",
  };
  store.putKV("session", {
    server: "https://example.com",
    user,
    secret: vault.encrypt("test-token"),
  });
  store.putKV(`room:${scope}:${b.id}`, { room, pending: [] });
  client = new CollaborationClient(store, () => {});
  (client as any).active = { room, pending: [] };
  (client as any).document = d;
  return { b, d, room };
}
beforeEach(async () => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), "moye-collab-"));
  store = await Store.open(
    path.join(folder, "test.sqlite"),
    path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"),
    vault,
  );
});
afterEach(() => {
  client?.stop();
  store.close();
  fs.rmSync(folder, { recursive: true, force: true });
  vi.restoreAllMocks();
});
describe("durable offline cache", () => {
  it("persists outbox before send and retains it across SQLite reopen", async () => {
    const { b, d } = setupRoom(),
      replica = clone(d),
      vector = Y.encodeStateVector(replica);
    replica
      .getMap<Y.Text>("texts")
      .get(`chapter:${b.chapters[0].id}:body`)!
      .insert(0, "断网也不丢稿");
    client.update(
      b.id,
      1,
      Buffer.from(Y.encodeStateAsUpdate(replica, vector)).toString("base64"),
    );
    client.stop();
    store.close();
    store = await Store.open(
      path.join(folder, "test.sqlite"),
      path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"),
      vault,
    );
    const cache = store.kv<any>(`room:${scope}:${b.id}`);
    expect(cache.pending).toHaveLength(1);
    expect(cache.room.book.chapters[0].body).toBe("断网也不丢稿");
    replica.destroy();
  });
  it("keeps the offline outbox editable during a transient server failure", async () => {
    const { b, d } = setupRoom(),
      replica = clone(d),
      vector = Y.encodeStateVector(replica);
    replica
      .getMap<Y.Text>("texts")
      .get(`chapter:${b.chapters[0].id}:body`)!
      .insert(0, "服务器维护期间");
    await client.update(
      b.id,
      1,
      Buffer.from(Y.encodeStateAsUpdate(replica, vector)).toString("base64"),
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "暂时不可用" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
    );
    (client as any).connect = vi.fn();
    const room = await client.open(b.id);
    expect(room.role).toBe("editor");
    expect(room.book.chapters[0].body).toBe("服务器维护期间");
    expect((client as any).active.pending).toHaveLength(1);
    expect(store.listBooks()).toHaveLength(0);
    replica.destroy();
  });
  it("updates own profile in status and durable session without losing the token", async () => {
    setupRoom();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true })),
    );
    await client.updateUser(user.id, { displayName: "新名称" });
    expect(client.status().user?.displayName).toBe("新名称");
    expect(store.kv<any>("session").user.displayName).toBe("新名称");
    expect(vault.decrypt(store.kv<any>("session").secret)).toBe("test-token");
  });
  it("preserves pending text in a personal copy when access is revoked", async () => {
    const { b, d } = setupRoom();
    const replica = clone(d),
      vector = Y.encodeStateVector(replica);
    replica
      .getMap<Y.Text>("texts")
      .get(`chapter:${b.chapters[0].id}:body`)!
      .insert(0, "被撤权前的离线文字");
    await client.update(
      b.id,
      1,
      Buffer.from(Y.encodeStateAsUpdate(replica, vector)).toString("base64"),
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "没有这部作品的访问权限" }), {
        status: 403,
      }),
    );
    await expect(client.open(b.id)).rejects.toThrow();
    expect(store.listBooks()).toHaveLength(1);
    expect(store.listBooks()[0].chapters[0].body).toBe("被撤权前的离线文字");
    replica.destroy();
  });
  it("isolates cached works when the collaboration account changes", () => {
    const { b } = setupRoom();
    expect(client.cachedBook(b.id)?.id).toBe(b.id);
    (client as any).user = { ...user, id: uid() };
    client.leave();
    expect(client.cachedBook(b.id)).toBeNull();
  });
  it("rolls back local document and outbox when persistence fails", async () => {
    const { b, d } = setupRoom(),
      replica = clone(d),
      vector = Y.encodeStateVector(replica);
    replica
      .getMap<Y.Text>("texts")
      .get(`chapter:${b.chapters[0].id}:body`)!
      .insert(0, "保存失败");
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    await expect(
      client.update(
        b.id,
        1,
        Buffer.from(Y.encodeStateAsUpdate(replica, vector)).toString("base64"),
      ),
    ).rejects.toThrow("disk full");
    expect(client.cachedBook(b.id)?.chapters[0].body).toBe("");
    expect((client as any).active.pending).toHaveLength(0);
    replica.destroy();
  });
  it("restored epoch preserves unsent text in an independent personal recovery copy", () => {
    const { b, d, room } = setupRoom(),
      replica = clone(d),
      vector = Y.encodeStateVector(replica);
    replica
      .getMap<Y.Text>("texts")
      .get(`chapter:${b.chapters[0].id}:body`)!
      .insert(0, "旧代次未同步");
    client.update(
      b.id,
      1,
      Buffer.from(Y.encodeStateAsUpdate(replica, vector)).toString("base64"),
    );
    const restored = createDoc(b);
    (client as any).acceptRoom({
      ...room,
      book: b,
      state: Buffer.from(Y.encodeStateAsUpdate(restored)).toString("base64"),
      epoch: 2,
    });
    restored.destroy();
    const copies = store.listBooks();
    expect(copies).toHaveLength(1);
    expect(copies[0].id).not.toBe(b.id);
    expect(copies[0].chapters[0].body).toBe("旧代次未同步");
    expect(client.cachedBook(b.id)?.chapters[0].body).toBe("");
    replica.destroy();
  });
  it("deleted item preserves offline work without reviving server item", () => {
    const { b, d, room } = setupRoom(),
      replica = clone(d),
      vector = Y.encodeStateVector(replica);
    replica
      .getMap<Y.Text>("texts")
      .get(`chapter:${b.chapters[0].id}:body`)!
      .insert(0, "删除前的稿件");
    client.update(
      b.id,
      1,
      Buffer.from(Y.encodeStateAsUpdate(replica, vector)).toString("base64"),
    );
    const server = clone(d),
      next = structuralChange(b, {
        kind: "delete",
        collection: "chapters",
        id: b.chapters[0].id,
      });
    reconcileDoc(b, next, server);
    (client as any).acceptRoom({
      ...room,
      book: next,
      revision: 2,
      state: Buffer.from(Y.encodeStateAsUpdate(server)).toString("base64"),
    });
    expect(store.listBooks()[0].chapters[0].body).toBe("删除前的稿件");
    expect(client.cachedBook(b.id)?.chapters).toHaveLength(0);
    replica.destroy();
    server.destroy();
  });
});
