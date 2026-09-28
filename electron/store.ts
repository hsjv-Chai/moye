import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  bookSchema,
  connectionSchema,
  defaultPreferences,
  draftSchema,
  preferencesSchema,
  type Book,
  type Connection,
  type Draft,
  type Preferences,
  type Version,
} from "../shared/model";
export interface Vault {
  available(): boolean;
  encrypt(s: string): string;
  decrypt(s: string): string;
}
const backupSchema = z.object({
  format: z.literal("moye-book"),
  version: z.literal(1),
  book: bookSchema,
  versions: z
    .array(
      z.object({
        id: z.string(),
        bookId: z.string(),
        createdAt: z.string(),
        reason: z.string(),
        book: bookSchema,
      }),
    )
    .max(10000),
});
export class Store {
  private db: Database;
  private sessionKeys = new Map<string, string>();
  private constructor(
    private SQL: SqlJsStatic,
    private filename: string,
    private vault: Vault,
  ) {
    this.db = fs.existsSync(filename)
      ? new SQL.Database(fs.readFileSync(filename))
      : new SQL.Database();
    const version = Number(
      this.db.exec("PRAGMA user_version")[0]?.values[0][0] || 0,
    );
    if (version > 1) throw new Error("资料库来自更新版本，请升级应用后打开。");
    if (version < 1) {
      if (fs.existsSync(filename))
        fs.copyFileSync(filename, `${filename}.before-v1-${Date.now()}.bak`);
      this.db.run(
        `CREATE TABLE IF NOT EXISTS books(id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY, book_id TEXT NOT NULL, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS connections(id TEXT PRIMARY KEY, data TEXT NOT NULL, secret TEXT); CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY, book_id TEXT NOT NULL, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS preferences(id INTEGER PRIMARY KEY, data TEXT NOT NULL); PRAGMA user_version=1;`,
      );
      this.persist();
    }
  }
  static async open(filename: string, wasmPath: string, vault: Vault) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const SQL = await initSqlJs({ locateFile: () => wasmPath });
    return new Store(SQL, filename, vault);
  }
  private persist() {
    const temp = `${this.filename}.tmp`;
    const fd = fs.openSync(temp, "w", 0o600);
    try {
      fs.writeFileSync(fd, this.db.export());
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, this.filename);
  }
  private transaction<T>(fn: () => T): T {
    const before = this.db.export();
    try {
      this.db.run("BEGIN");
      const result = fn();
      this.db.run("COMMIT");
      this.persist();
      return result;
    } catch (e) {
      this.db.close();
      this.db = new this.SQL.Database(before);
      throw e;
    }
  }
  private rows(
    sql: string,
    params: (string | number)[] = [],
  ): Record<string, unknown>[] {
    const statement = this.db.prepare(sql);
    try {
      statement.bind(params);
      const rows = [];
      while (statement.step()) rows.push(statement.getAsObject());
      return rows;
    } finally {
      statement.free();
    }
  }
  listBooks(): Book[] {
    return this.rows("SELECT data FROM books")
      .map((r) => bookSchema.parse(JSON.parse(String(r.data))))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  getBook(id: string): Book {
    const row = this.rows("SELECT data FROM books WHERE id=?", [id])[0];
    if (!row) throw new Error("作品不存在");
    return bookSchema.parse(JSON.parse(String(row.data)));
  }
  private putBook(b: Book) {
    this.db.run("INSERT OR REPLACE INTO books VALUES (?,?)", [
      b.id,
      JSON.stringify(b),
    ]);
  }
  saveBook(input: unknown) {
    const b = bookSchema.parse(input);
    b.updatedAt = new Date().toISOString();
    this.transaction(() => this.putBook(b));
    return b;
  }
  deleteBook(id: string) {
    this.transaction(() => {
      this.db.run("DELETE FROM books WHERE id=?", [id]);
      this.db.run("DELETE FROM versions WHERE book_id=?", [id]);
      this.db.run("DELETE FROM drafts WHERE book_id=?", [id]);
    });
  }
  private putVersion(b: Book, reason: string): Version {
    const v = {
      id: randomUUID(),
      bookId: b.id,
      createdAt: new Date().toISOString(),
      reason,
      book: b,
    };
    this.db.run("INSERT INTO versions VALUES (?,?,?)", [
      v.id,
      b.id,
      JSON.stringify(v),
    ]);
    return v;
  }
  snapshot(id: string, reason: string) {
    return this.transaction(() => this.putVersion(this.getBook(id), reason));
  }
  versions(id: string): Version[] {
    return this.rows("SELECT data FROM versions WHERE book_id=?", [id])
      .map((r) => JSON.parse(String(r.data)) as Version)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  restoreVersion(bookId: string, id: string) {
    return this.transaction(() => {
      const current = this.getBook(bookId);
      const row = this.rows(
        "SELECT data FROM versions WHERE id=? AND book_id=?",
        [id, bookId],
      )[0];
      if (!row) throw new Error("找不到这个版本");
      const version = JSON.parse(String(row.data)) as Version;
      this.putVersion(current, "恢复前自动备份");
      const restored = bookSchema.parse({
        ...version.book,
        id: bookId,
        updatedAt: new Date().toISOString(),
      });
      this.putBook(restored);
      this.db.run("DELETE FROM drafts WHERE book_id=?", [bookId]);
      return restored;
    });
  }
  backup(id: string) {
    return JSON.stringify(
      {
        format: "moye-book",
        version: 1,
        book: this.getBook(id),
        versions: this.versions(id),
      },
      null,
      2,
    );
  }
  importBackup(raw: string) {
    const backup = backupSchema.parse(JSON.parse(raw));
    const remap = new Map<string, string>();
    const map = (id: string) => {
      if (!remap.has(id)) remap.set(id, randomUUID());
      return remap.get(id)!;
    };
    const copy = (b: Book): Book => ({
      ...b,
      id: map(backup.book.id),
      title: `${b.title}（恢复副本）`,
      archived: false,
      updatedAt: new Date().toISOString(),
      settings: b.settings.map((x) => ({ ...x, id: map(x.id) })),
      volumes: b.volumes.map((x) => ({ ...x, id: map(x.id) })),
      chapters: b.chapters.map((x) => ({
        ...x,
        id: map(x.id),
        volumeId: x.volumeId ? map(x.volumeId) : "",
      })),
    });
    const book = bookSchema.parse(copy(backup.book));
    this.transaction(() => {
      this.putBook(book);
      for (const v of backup.versions) {
        if (v.bookId !== backup.book.id || v.book.id !== backup.book.id)
          throw new Error("备份中包含不属于本作品的版本");
        const restored = {
          ...v,
          id: randomUUID(),
          bookId: book.id,
          book: bookSchema.parse(copy(v.book)),
        };
        this.db.run("INSERT INTO versions VALUES (?,?,?)", [
          restored.id,
          book.id,
          JSON.stringify(restored),
        ]);
      }
    });
    return book;
  }
  connections(): Connection[] {
    return this.rows("SELECT * FROM connections").map((r) => {
      const c = connectionSchema.parse(JSON.parse(String(r.data)));
      return {
        ...c,
        hasKey: !!r.secret || this.sessionKeys.has(c.id),
        sessionOnly: !r.secret && this.sessionKeys.has(c.id),
      };
    });
  }
  saveConnection(input: unknown, key?: string) {
    const c = connectionSchema.parse(input);
    const previous = this.rows(
      "SELECT secret,data FROM connections WHERE id=?",
      [c.id],
    )[0];
    let secret = String(previous?.secret || "");
    const old = previous
      ? connectionSchema.parse(JSON.parse(String(previous.data)))
      : null;
    // Credentials must not follow an edited endpoint unless the user supplies them again.
    const endpointChanged =
      old && (old.baseUrl !== c.baseUrl || old.provider !== c.provider);
    if (endpointChanged) {
      secret = "";
      if (key === undefined) key = "";
    }
    let session: string | undefined = this.sessionKeys.get(c.id);
    if (key !== undefined) {
      if (key && this.vault.available()) {
        secret = this.vault.encrypt(key);
        session = undefined;
      } else {
        secret = "";
        session = key || undefined;
      }
    }
    const { hasKey: _, sessionOnly: __, ...safe } = c;
    this.transaction(() =>
      this.db.run("INSERT OR REPLACE INTO connections VALUES (?,?,?)", [
        c.id,
        JSON.stringify(safe),
        secret,
      ]),
    );
    if (session) this.sessionKeys.set(c.id, session);
    else this.sessionKeys.delete(c.id);
    return this.connections();
  }
  removeConnection(id: string) {
    this.transaction(() =>
      this.db.run("DELETE FROM connections WHERE id=?", [id]),
    );
    this.sessionKeys.delete(id);
    const p = this.preferences();
    for (const key of ["setting", "outline", "body"] as const)
      if (p.defaults[key] === id) p.defaults[key] = "";
    this.savePreferences(p);
  }
  credentials(id: string) {
    const row = this.rows("SELECT * FROM connections WHERE id=?", [id])[0];
    if (!row) throw new Error("请先保存 AI 连接");
    const connection = connectionSchema.parse(JSON.parse(String(row.data)));
    let key = this.sessionKeys.get(id) || "";
    if (row.secret) {
      try {
        key = this.vault.decrypt(String(row.secret));
      } catch {
        throw new Error("密钥无法解密，请重新填写 API Key。");
      }
    }
    return { connection, key };
  }
  preferences(): Preferences {
    const row = this.rows("SELECT data FROM preferences WHERE id=1")[0];
    return row
      ? preferencesSchema.parse(JSON.parse(String(row.data)))
      : structuredClone(defaultPreferences);
  }
  savePreferences(p: unknown) {
    const prefs = preferencesSchema.parse(p);
    this.transaction(() =>
      this.db.run("INSERT OR REPLACE INTO preferences VALUES (1,?)", [
        JSON.stringify(prefs),
      ]),
    );
    return prefs;
  }
  saveDraft(input: unknown) {
    const d = draftSchema.parse(input);
    this.getBook(d.bookId);
    this.transaction(() =>
      this.db.run("INSERT OR REPLACE INTO drafts VALUES (?,?,?)", [
        d.id,
        d.bookId,
        JSON.stringify(d),
      ]),
    );
  }
  drafts(bookId: string): Draft[] {
    return this.rows("SELECT data FROM drafts WHERE book_id=?", [bookId])
      .map((r) => draftSchema.parse(JSON.parse(String(r.data))))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  deleteDraft(id: string) {
    this.transaction(() => this.db.run("DELETE FROM drafts WHERE id=?", [id]));
  }
  close() {
    this.db.close();
  }
}
