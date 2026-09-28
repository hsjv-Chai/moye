import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store, type Vault } from "../electron/store";
import {
  newBook,
  newChapter,
  uid,
  splitChapters,
  exportText,
  fingerprint,
  buildPrompt,
  bookSchema,
  type Connection,
} from "../shared/model";
let folder: string, store: Store;
const vault: Vault = {
  available: () => true,
  encrypt: (s) => Buffer.from(`protected:${s}`).toString("base64"),
  decrypt: (s) => Buffer.from(s, "base64").toString().slice(10),
};
const wasm = path.resolve("node_modules/sql.js/dist/sql-wasm.wasm");
const connection: Connection = {
  id: "conn",
  name: "Mock",
  provider: "custom",
  baseUrl: "http://localhost:3333/v1",
  model: "mock",
  temperature: null,
  outputTokens: 1000,
  contextTokens: 10000,
  tokenParam: "max_tokens",
};
beforeEach(async () => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), "moye-test-"));
  store = await Store.open(path.join(folder, "moye.sqlite"), wasm, vault);
});
afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  fs.rmSync(folder, { recursive: true, force: true });
});
describe("persistent workspace", () => {
  it("isolates books and survives closing/reopening a real SQLite file", async () => {
    const a = newBook("甲"),
      b = newBook("乙");
    a.chapters[0].body = "一个故事";
    store.saveBook(a);
    store.saveBook(b);
    store.close();
    expect(
      fs
        .readFileSync(path.join(folder, "moye.sqlite"))
        .subarray(0, 15)
        .toString(),
    ).toBe("SQLite format 3");
    store = await Store.open(path.join(folder, "moye.sqlite"), wasm, vault);
    expect(store.getBook(a.id).chapters[0].body).toBe("一个故事");
    expect(store.getBook(b.id).chapters[0].body).toBe("");
    store.deleteBook(a.id);
    expect(store.listBooks().map((b) => b.title)).toEqual(["乙"]);
  });
  it("preserves current content before restoring a complete version", () => {
    const b = newBook("书");
    store.saveBook(b);
    const v = store.snapshot(b.id, "manual");
    b.chapters[0].body = "最新文字";
    store.saveBook(b);
    store.restoreVersion(b.id, v.id);
    expect(store.getBook(b.id).chapters[0].body).toBe("");
    expect(
      store.versions(b.id).find((x) => x.reason === "恢复前自动备份")?.book
        .chapters[0].body,
    ).toBe("最新文字");
    const other = newBook("另一部");
    store.saveBook(other);
    expect(() => store.restoreVersion(other.id, v.id)).toThrow();
  });
  it("rolls back memory and disk when atomic save fails", async () => {
    const b = newBook("保存测试");
    store.saveBook(b);
    const spy = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("Disk full");
    });
    expect(() => store.saveBook({ ...b, title: "不可保存" })).toThrow(
      "Disk full",
    );
    expect(store.getBook(b.id).title).toBe("保存测试");
    spy.mockRestore();
    store.close();
    store = await Store.open(path.join(folder, "moye.sqlite"), wasm, vault);
    expect(store.getBook(b.id).title).toBe("保存测试");
  });
  it("restores backups with independent entity IDs and all versions but no credentials", () => {
    const b = newBook("有历史的作品");
    const v = { id: uid(), title: "第一卷", outline: "卷纲" };
    b.volumes = [v];
    b.chapters[0].volumeId = v.id;
    store.saveBook(b);
    store.snapshot(b.id, "before");
    store.saveConnection(connection, "secret-not-in-backup");
    const raw = store.backup(b.id);
    expect(raw).not.toContain("secret-not-in-backup");
    expect(raw).not.toContain("connections");
    const restored = store.importBackup(raw);
    expect(restored.id).not.toBe(b.id);
    expect(restored.chapters[0].id).not.toBe(b.chapters[0].id);
    expect(restored.chapters[0].volumeId).toBe(restored.volumes[0].id);
    expect(store.versions(restored.id)).toHaveLength(1);
    expect(store.listBooks()).toHaveLength(2);
  });
  it("validates backups and entity references before importing", () => {
    const b = newBook("非法");
    b.chapters[0].volumeId = "missing";
    expect(() => bookSchema.parse(b)).toThrow();
    expect(() => store.importBackup('{"format":"unknown"}')).toThrow();
    expect(store.listBooks()).toHaveLength(0);
  });
  it("encrypts keys, omits them from renderer configuration, and clears them on endpoint change", () => {
    store.saveConnection(connection, "very-secret");
    expect(JSON.stringify(store.connections())).not.toContain("very-secret");
    expect(store.connections()[0].hasKey).toBe(true);
    expect(store.credentials(connection.id).key).toBe("very-secret");
    store.saveConnection({ ...connection, name: "renamed" });
    expect(store.credentials(connection.id).key).toBe("very-secret");
    store.saveConnection({ ...connection, baseUrl: "https://new.example/v1" });
    expect(store.credentials(connection.id).key).toBe("");
  });
  it("keeps keys only in memory when encryption is unavailable", async () => {
    store.close();
    const filename = path.join(folder, "session.sqlite");
    store = await Store.open(filename, wasm, {
      ...vault,
      available: () => false,
    });
    store.saveConnection(connection, "session-secret");
    expect(store.connections()[0].sessionOnly).toBe(true);
    expect(store.credentials(connection.id).key).toBe("session-secret");
    expect(
      fs.readFileSync(filename).includes(Buffer.from("session-secret")),
    ).toBe(false);
    store.close();
    store = await Store.open(filename, wasm, vault);
    expect(store.credentials(connection.id).key).toBe("");
  });
  it("persists recoverable candidates without changing the manuscript", () => {
    const b = newBook("候选");
    store.saveBook(b);
    store.saveDraft({
      id: "draft",
      bookId: b.id,
      target: { kind: "body", id: b.chapters[0].id },
      baseline: "",
      text: "未采纳的文字",
      action: "初稿",
      selection: null,
      createdAt: new Date().toISOString(),
      status: "stopped",
    });
    expect(store.getBook(b.id).chapters[0].body).toBe("");
    expect(store.drafts(b.id)[0].text).toBe("未采纳的文字");
    store.deleteBook(b.id);
    expect(store.drafts(b.id)).toEqual([]);
  });
});
describe("manuscript processing", () => {
  it("splits Chinese headings and Markdown while keeping a preface", () => {
    expect(
      splitChapters(
        "引言\r\n\r\n第一章 初见\r\n正文一\r\n## 第二章 重逢\r\n正文二",
      ),
    ).toEqual([
      { title: "导入正文", body: "引言" },
      { title: "第一章 初见", body: "正文一" },
      { title: "第二章 重逢", body: "正文二" },
    ]);
    expect(splitChapters("没有章节标题的故事")).toEqual([
      { title: "导入正文", body: "没有章节标题的故事" },
    ]);
  });
  it("exports by volume and chapter order and respects selected IDs", () => {
    const b = newBook("导出");
    b.volumes = [
      { id: "v2", title: "二", outline: "" },
      { id: "v1", title: "一", outline: "" },
    ];
    b.chapters = [
      { ...newChapter("A", "v1"), body: "aaa" },
      { ...newChapter("B", "v2"), body: "bbb" },
    ];
    expect(exportText(b, [], true).indexOf("## B")).toBeLessThan(
      exportText(b, [], true).indexOf("## A"),
    );
    expect(exportText(b, [b.chapters[0].id], false)).not.toContain("bbb");
  });
  it("marks stale summaries and includes only selected context without truncating", () => {
    const b = newBook("素材");
    b.settings = [
      {
        id: "s",
        category: "人物",
        title: "角色",
        role: "主角",
        traits: "好奇",
        content: "选定人设",
      },
    ];
    b.chapters[0].body = "已更改正文";
    b.chapters[0].summary = "前章摘要";
    b.chapters[0].summarySource = fingerprint("旧正文");
    const c = newChapter("第二章");
    b.chapters.push(c);
    const prompt = buildPrompt(
      b,
      { kind: "body", id: c.id },
      "初稿",
      ["summary:" + b.chapters[0].id],
      {
        words: "2000",
        perspective: "第三人称",
        style: "",
        extra: "",
        selection: "",
      },
    );
    expect(prompt).toContain("已过期");
    expect(prompt).not.toContain("选定人设");
  });
  it("handles a long Chinese manuscript without losing content", () => {
    const body = "长篇创作中的一段文字。\n".repeat(30000);
    const b = newBook("长篇");
    b.chapters[0].body = body;
    store.saveBook(b);
    expect(store.getBook(b.id).chapters[0].body).toBe(body);
    expect(exportText(b, [], false)).toContain(body);
  });
});
