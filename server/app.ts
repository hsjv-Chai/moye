import { trustedPresence, readPresence } from "../shared/awareness";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import rateLimit from "@fastify/rate-limit";
import * as Y from "yjs";
import { z } from "zod";
import { randomUUID, randomBytes } from "node:crypto";
import type { WebSocket } from "ws";
import {
  pool,
  migrate,
  transaction,
  passwordMatches,
  passwordHash,
  tokenHash,
  publicUser,
} from "./db";
import { bookSchema } from "../shared/model";
import {
  createDoc,
  project,
  validDoc,
  reconcileDoc,
  structuralChange,
  remapBook,
  structureSchema,
  atomicSchema,
  userInputSchema,
  userPatchSchema,
  type User,
  type Room,
  type Peer,
} from "../shared/collab";
const uuid = z.string().uuid();
const binary = z
  .string()
  .max(20000000)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/);
class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
const fail = (code: number, message: string): never => {
  throw new HttpError(code, message);
};
type SocketClient = {
  socket: WebSocket;
  bookId: string;
  token: string;
  user: User;
  peer: Peer;
};
const clients = new Set<SocketClient>(),
  locks = new Map<string, Promise<unknown>>();
export async function locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(id) || Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  locks.set(id, next);
  try {
    return await next;
  } finally {
    if (locks.get(id) === next) locks.delete(id);
  }
}
function send(socket: WebSocket, data: unknown) {
  if (socket.readyState === 1) {
    if (socket.bufferedAmount > 20 * 1024 * 1024) {
      socket.close(1013, "slow client");
      return;
    }
    socket.send(JSON.stringify(data));
  }
}
function peers(id: string) {
  const peers = [...clients]
    .filter((c) => c.bookId === id && c.socket.readyState === 1)
    .map((c) => c.peer);
  for (const c of clients)
    if (c.bookId === id) send(c.socket, { type: "peers", peers });
}
function disconnectUser(id: string, bookId?: string) {
  for (const c of clients)
    if (c.user.id === id && (!bookId || c.bookId === bookId)) {
      send(c.socket, {
        type: "denied",
        message: "权限或会话已变更，请重新登录或联系管理员",
      });
      c.socket.close(1008, "revoked");
    }
}
async function authenticate(token: string, allowChange = false) {
  const { rows } = await pool.query(
    "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=$1 AND s.expires_at>now() AND u.active=true",
    [tokenHash(token)],
  );
  if (!rows[0]) fail(401, "登录已失效，请重新登录");
  const user = publicUser(rows[0]);
  if (user.mustChangePassword && !allowChange) fail(403, "请先修改临时密码");
  return user;
}
async function access(user: User, id: string, write = false) {
  if (user.admin) return "admin" as const;
  const { rows } = await pool.query(
    "SELECT role FROM members WHERE book_id=$1 AND user_id=$2",
    [id, user.id],
  );
  const role = rows[0]?.role;
  if (!role) fail(403, "没有这部作品的访问权限");
  if (write && role !== "editor") fail(403, "此账号只有阅读权限");
  return role as "reader" | "editor";
}
async function load(id: string) {
  const { rows } = await pool.query("SELECT * FROM books WHERE id=$1", [id]);
  if (!rows[0]) fail(404, "作品已被删除");
  return rows[0];
}
function doc(row: any) {
  const d = new Y.Doc();
  Y.applyUpdate(d, new Uint8Array(row.state));
  return d;
}
function room(
  row: any,
  role: Room["role"],
  sync?: { epoch: number; revision: number; vector: string },
): Room {
  const d = doc(row);
  try {
    return {
      book: project(bookSchema.parse(row.book), d),
      epoch: row.epoch,
      revision: row.revision,
      state: Buffer.from(
        sync &&
          sync.epoch === row.epoch &&
          sync.revision === row.revision &&
          role !== "reader"
          ? Y.encodeStateAsUpdate(d, Buffer.from(sync.vector, "base64"))
          : row.state,
      ).toString("base64"),
      role,
    };
  } finally {
    d.destroy();
  }
}
async function broadcastRoom(id: string) {
  const row = await load(id);
  for (const c of clients) {
    if (c.bookId !== id) continue;
    try {
      const user = await authenticate(c.token);
      const role = await access(user, id);
      send(c.socket, { type: "room", room: room(row, role) });
    } catch {
      c.socket.close(1008, "revoked");
    }
  }
}
async function version(db: any, row: any, user: User, reason: string) {
  await db.query(
    "INSERT INTO versions(id,book_id,book,reason,created_by) VALUES($1,$2,$3,$4,$5)",
    [randomUUID(), row.id, room(row, "admin").book, reason, user.id],
  );
}
async function audit(db: any, user: User, action: string, bookId?: string) {
  await db.query("INSERT INTO audit(user_id,action,book_id) VALUES($1,$2,$3)", [
    user.id,
    action,
    bookId || null,
  ]);
}
export async function buildServer() {
  await migrate();
  const app = Fastify({
    logger: false,
    bodyLimit: 25 * 1024 * 1024,
    trustProxy: ["127.0.0.1", "172.16.0.0/12"],
  });
  await app.register(websocket, { options: { maxPayload: 20 * 1024 * 1024 } });
  await app.register(rateLimit, { max: 600, timeWindow: "1 minute" });
  app.setErrorHandler((error: any, _request, reply) => {
    const status = error instanceof z.ZodError ? 400 : error.statusCode || 500;
    reply.code(status).send({
      error:
        status >= 500
          ? "服务器暂时无法保存，请稍后重试"
          : error instanceof z.ZodError
            ? "请求数据格式不正确"
            : error.message,
    });
  });
  const auth = async (req: any, allow = false) =>
    authenticate(
      String(req.headers.authorization || "").replace(/^Bearer /, ""),
      allow,
    );
  const admin = async (req: any) => {
    const user = await auth(req);
    if (!user.admin) fail(403, "此操作仅限管理员");
    return user;
  };
  const bookId = (req: any) => uuid.parse(req.params.id);
  app.get("/health", async () => {
    await pool.query("SELECT 1");
    return { ok: true, version: "0.2.0" };
  });
  app.post(
    "/api/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req) => {
      const input = z
        .object({ username: z.string().max(80), password: z.string().max(300) })
        .parse(req.body);
      const { rows } = await pool.query(
        "SELECT * FROM users WHERE username=$1",
        [input.username],
      );
      if (
        !rows[0] ||
        !rows[0].active ||
        !passwordMatches(input.password, rows[0].password)
      )
        fail(401, "用户名或密码不正确");
      const token = randomBytes(32).toString("hex");
      await pool.query(
        "INSERT INTO sessions VALUES($1,$2,now()+interval '7 days')",
        [tokenHash(token), rows[0].id],
      );
      return { token, user: publicUser(rows[0]) };
    },
  );
  app.get("/api/me", async (req) => ({ user: await auth(req, true) }));
  app.post("/api/logout", async (req) => {
    await auth(req, true);
    await pool.query("DELETE FROM sessions WHERE token=$1", [
      tokenHash(String(req.headers.authorization).replace(/^Bearer /, "")),
    ]);
    for (const c of clients)
      if (
        c.token === String(req.headers.authorization).replace(/^Bearer /, "")
      ) {
        send(c.socket, { type: "denied", message: "已退出登录" });
        c.socket.close(1008, "logout");
      }
    return { ok: true };
  });
  app.post("/api/password", async (req) => {
    const user = await auth(req, true);
    const input = z
      .object({
        oldPassword: z.string().max(300),
        newPassword: z.string().min(12).max(200),
      })
      .parse(req.body);
    const { rows } = await pool.query(
      "SELECT password FROM users WHERE id=$1",
      [user.id],
    );
    if (!passwordMatches(input.oldPassword, rows[0].password))
      fail(400, "原密码不正确");
    const currentToken = tokenHash(
      String(req.headers.authorization).replace(/^Bearer /, ""),
    );
    await transaction(async (db) => {
      await db.query(
        "UPDATE users SET password=$1,must_change=false WHERE id=$2",
        [passwordHash(input.newPassword), user.id],
      );
      await db.query("DELETE FROM sessions WHERE user_id=$1 AND token<>$2", [
        user.id,
        currentToken,
      ]);
    });
    disconnectUser(user.id);
    return { ok: true };
  });
  app.get("/api/users", async (req) => {
    await admin(req);
    return (await pool.query("SELECT * FROM users ORDER BY username")).rows.map(
      publicUser,
    );
  });
  app.post("/api/users", async (req) => {
    const actor = await admin(req),
      input = userInputSchema.parse(req.body);
    const id = randomUUID();
    try {
      await transaction(async (db) => {
        await db.query(
          "INSERT INTO users(id,username,display_name,password,admin) VALUES($1,$2,$3,$4,$5)",
          [
            id,
            input.username,
            input.displayName,
            passwordHash(input.password),
            input.admin,
          ],
        );
        await audit(db, actor, "create-user");
      });
    } catch (e: any) {
      if (e.code === "23505") fail(409, "用户名已存在");
      throw e;
    }
    return publicUser(
      (await pool.query("SELECT * FROM users WHERE id=$1", [id])).rows[0],
    );
  });
  app.patch("/api/users/:id", async (req) => {
    const actor = await admin(req),
      id = bookId(req),
      input = userPatchSchema.parse(req.body);
    if (id === actor.id && input.active === false)
      fail(400, "不能停用自己的账号");
    const updated = await transaction(async (db) => {
      const target = (
        await db.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [id])
      ).rows[0];
      if (!target) fail(404, "账号不存在");
      if (input.displayName !== undefined)
        await db.query("UPDATE users SET display_name=$1 WHERE id=$2", [
          input.displayName,
          id,
        ]);
      if (input.active !== undefined)
        await db.query("UPDATE users SET active=$1 WHERE id=$2", [
          input.active,
          id,
        ]);
      if (input.password)
        await db.query(
          "UPDATE users SET password=$1,must_change=true WHERE id=$2",
          [passwordHash(input.password), id],
        );
      if (input.password || input.active === false)
        await db.query("DELETE FROM sessions WHERE user_id=$1", [id]);
      await audit(db, actor, "update-user");
      return publicUser(
        (await db.query("SELECT * FROM users WHERE id=$1", [id])).rows[0],
      );
    });
    if (input.password || input.active === false) disconnectUser(id);
    else if (input.displayName !== undefined) {
      const rooms = new Set<string>();
      for (const c of clients)
        if (c.user.id === id) {
          c.user = updated;
          c.peer.name = updated.displayName;
          rooms.add(c.bookId);
          // Refresh trusted awareness names on reconnect without revoking access.
          c.socket.close(1012, "profile updated");
        }
      for (const roomId of rooms) peers(roomId);
    }
    return { ok: true };
  });
  app.get("/api/users/:id/books", async (req) => {
    await admin(req);
    const id = bookId(req);
    const user = (await pool.query("SELECT * FROM users WHERE id=$1", [id]))
      .rows[0];
    if (!user) fail(404, "账号不存在");
    const rows = (
      await pool.query(
        "SELECT b.*, m.role FROM books b LEFT JOIN members m ON m.book_id=b.id AND m.user_id=$1 ORDER BY b.updated_at DESC",
        [id],
      )
    ).rows;
    return rows.map((r) => ({
      id: r.id,
      title: r.book.title,
      archived: !!r.book.archived,
      epoch: r.epoch,
      revision: r.revision,
      updatedAt: r.updated_at,
      role: user.admin ? "admin" : r.role || null,
    }));
  });
  app.get("/api/books", async (req) => {
    const user = await auth(req);
    const { rows } = await pool.query(
      user.admin
        ? "SELECT b.*, 'admin' AS role FROM books b ORDER BY updated_at DESC"
        : "SELECT b.*, m.role FROM books b JOIN members m ON m.book_id=b.id WHERE m.user_id=$1 ORDER BY b.updated_at DESC",
      user.admin ? [] : [user.id],
    );
    return rows.map((r) => ({
      id: r.id,
      title: r.book.title,
      archived: r.book.archived,
      epoch: r.epoch,
      revision: r.revision,
      updatedAt: r.updated_at,
      role: r.role,
    }));
  });
  app.post("/api/books", async (req) => {
    const user = await admin(req),
      book = remapBook(bookSchema.parse(req.body)),
      d = createDoc(book);
    try {
      await transaction(async (db) => {
        await db.query("INSERT INTO books(id,book,state) VALUES($1,$2,$3)", [
          book.id,
          book,
          Buffer.from(Y.encodeStateAsUpdate(d)),
        ]);
        await audit(db, user, "create-book", book.id);
      });
      return {
        id: book.id,
        title: book.title,
        archived: false,
        epoch: 1,
        revision: 1,
        updatedAt: book.updatedAt,
        role: "admin",
      };
    } finally {
      d.destroy();
    }
  });
  app.get("/api/books/:id", async (req) => {
    const user = await auth(req),
      id = bookId(req),
      role = await access(user, id);
    return room(await load(id), role);
  });
  app.post("/api/books/:id/sync", async (req) => {
    const user = await auth(req),
      id = bookId(req),
      role = await access(user, id);
    const input = z
      .object({
        epoch: z.number().int(),
        revision: z.number().int(),
        vector: binary.max(1000000),
      })
      .parse(req.body);
    return room(await load(id), role, input);
  });
  app.delete("/api/books/:id", async (req) => {
    const user = await admin(req),
      id = bookId(req);
    await locked(id, () =>
      transaction(async (db) => {
        await db.query("DELETE FROM books WHERE id=$1", [id]);
        await audit(db, user, "delete-book", id);
      }),
    );
    for (const c of clients)
      if (c.bookId === id) {
        send(c.socket, { type: "denied", message: "作品已被管理员删除" });
        c.socket.close(1008, "deleted");
      }
    return { ok: true };
  });
  app.get("/api/books/:id/backup", async (req) => {
    const user = await auth(req),
      id = bookId(req);
    await access(user, id);
    return locked(id, async () => ({
      format: "moye-book",
      version: 1,
      book: room(await load(id), "reader").book,
      versions: (
        await pool.query(
          'SELECT id,book_id AS "bookId",created_at AS "createdAt",reason,book FROM versions WHERE book_id=$1 ORDER BY created_at',
          [id],
        )
      ).rows,
    }));
  });
  app.get("/api/books/:id/members", async (req) => {
    await admin(req);
    const id = bookId(req);
    return (
      await pool.query(
        'SELECT m.user_id AS "userId",u.username,u.display_name AS "displayName",m.role FROM members m JOIN users u ON u.id=m.user_id WHERE book_id=$1',
        [id],
      )
    ).rows;
  });
  app.put("/api/books/:id/members/:userId", async (req) => {
    const user = await admin(req),
      id = bookId(req),
      memberId = uuid.parse((req.params as any).userId),
      input = z
        .object({ role: z.enum(["editor", "reader"]).nullable() })
        .parse(req.body);
    await locked(id, () =>
      transaction(async (db) => {
        if (
          !(await db.query("SELECT id FROM books WHERE id=$1", [id])).rows
            .length
        )
          fail(404, "作品不存在");
        const target = (
          await db.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [
            memberId,
          ])
        ).rows[0];
        if (!target) fail(404, "账号不存在");
        if (target.admin) fail(400, "管理员可访问全部作品，无需单独授权");
        const old = (
          await db.query(
            "SELECT role FROM members WHERE book_id=$1 AND user_id=$2",
            [id, memberId],
          )
        ).rows[0]?.role;
        if (
          !target.active &&
          input.role &&
          !(old === input.role || (old === "editor" && input.role === "reader"))
        )
          fail(400, "停用账号不能新增或提升权限");
        if (input.role)
          await db.query(
            "INSERT INTO members VALUES($1,$2,$3) ON CONFLICT(book_id,user_id) DO UPDATE SET role=excluded.role",
            [id, memberId, input.role],
          );
        else
          await db.query(
            "DELETE FROM members WHERE book_id=$1 AND user_id=$2",
            [id, memberId],
          );
        await audit(db, user, "set-member", id);
      }),
    );
    disconnectUser(memberId, id);
    return { ok: true };
  });
  app.post("/api/books/:id/structure", async (req) => {
    const user = await auth(req),
      id = bookId(req),
      input = z
        .object({
          epoch: z.number().int(),
          revision: z.number().int(),
          action: structureSchema,
        })
        .parse(req.body);
    const result = await locked(id, async () => {
      const role = await access(user, id, true);
      if (input.action.kind === "archive" && !user.admin)
        fail(403, "只有管理员可归档作品");
      const row = await load(id);
      if (row.epoch !== input.epoch || row.revision !== input.revision)
        fail(409, "作品结构已变化，请刷新后重试");
      const d = doc(row);
      try {
        const before = project(row.book, d),
          after = structuralChange(before, input.action);
        reconcileDoc(before, after, d);
        await transaction(async (db) => {
          await version(db, row, user, `结构修改：${input.action.kind}`);
          await db.query(
            "UPDATE books SET book=$1,state=$2,revision=revision+1,updated_at=now() WHERE id=$3",
            [after, Buffer.from(Y.encodeStateAsUpdate(d)), id],
          );
          await audit(db, user, "structure", id);
        });
        return room(await load(id), role);
      } finally {
        d.destroy();
      }
    });
    await broadcastRoom(id);
    return result;
  });
  app.post("/api/books/:id/edit", async (req) => {
    const user = await auth(req),
      id = bookId(req),
      input = z
        .object({ epoch: z.number().int(), edit: atomicSchema })
        .parse(req.body);
    const result = await locked(id, async () => {
      const role = await access(user, id, true),
        row = await load(id);
      if (row.epoch !== input.epoch) fail(409, "作品已恢复到其他版本，请刷新");
      const d = doc(row);
      try {
        const edit = input.edit,
          t = d.getMap<Y.Text>("texts").get(edit.field);
        if (!t) fail(409, "目标已删除");
        const old = t!.toString();
        let start = 0,
          end = old.length;
        if (edit.mode === "replace" && old !== edit.baseline)
          fail(409, "目标内容已被其他成员修改，请重新审阅候选稿");
        if (edit.mode === "selection") {
          if (!edit.anchor || !edit.head) fail(400, "缺少选区位置");
          const a = Y.createAbsolutePositionFromRelativePosition(
              Y.decodeRelativePosition(Buffer.from(edit.anchor!, "base64")),
              d,
            ),
            h = Y.createAbsolutePositionFromRelativePosition(
              Y.decodeRelativePosition(Buffer.from(edit.head!, "base64")),
              d,
            );
          if (!a || !h || a.type !== t || h.type !== t)
            fail(409, "选区已变化，请重新选择");
          start = Math.min(a!.index, h!.index);
          end = Math.max(a!.index, h!.index);
          if (old.slice(start, end) !== edit.selectionText)
            fail(409, "选区已被修改，请重新选择");
        }
        if (edit.mode === "append") start = end = old.length;
        const vector = Y.encodeStateVector(d);
        d.transact(() => {
          if (end > start) t!.delete(start, end - start);
          t!.insert(
            start,
            (edit.mode === "append" && old ? "\n\n" : "") + edit.text,
          );
          if (
            edit.field.endsWith(":summary") &&
            edit.sourceFingerprint !== undefined
          ) {
            const s = d
              .getMap<Y.Text>("texts")
              .get(edit.field.replace(/:summary$/, ":summarySource"));
            if (s) {
              s.delete(0, s.length);
              s.insert(0, edit.sourceFingerprint);
            }
          }
        });
        validDoc(row.book, d);
        const book = project(row.book, d),
          update = Y.encodeStateAsUpdate(d, vector);
        await transaction(async (db) => {
          await version(db, row, user, edit.reason);
          await db.query(
            "UPDATE books SET book=$1,state=$2,updated_at=now() WHERE id=$3",
            [book, Buffer.from(Y.encodeStateAsUpdate(d)), id],
          );
          await audit(db, user, "atomic-edit", id);
        });
        for (const c of clients)
          if (c.bookId === id)
            send(c.socket, {
              type: "update",
              epoch: row.epoch,
              update: Buffer.from(update).toString("base64"),
            });
        return room(await load(id), role);
      } finally {
        d.destroy();
      }
    });
    return result;
  });
  app.get("/api/books/:id/versions", async (req) => {
    const user = await auth(req),
      id = bookId(req);
    await access(user, id);
    return (
      await pool.query(
        'SELECT v.id,v.book,v.reason,v.created_at AS "createdAt",u.display_name AS "createdBy" FROM versions v LEFT JOIN users u ON u.id=v.created_by WHERE book_id=$1 ORDER BY v.created_at DESC LIMIT 100',
        [id],
      )
    ).rows;
  });
  app.post("/api/books/:id/versions", async (req) => {
    const user = await auth(req),
      id = bookId(req);
    await locked(id, async () => {
      await access(user, id, true);
      await transaction(async (db) => {
        await version(db, await load(id), user, "手动版本");
      });
    });
    return { ok: true };
  });
  app.post("/api/books/:id/restore", async (req) => {
    const user = await admin(req),
      id = bookId(req),
      input = z.object({ versionId: uuid }).parse(req.body);
    const result = await locked(id, async () => {
      const row = await load(id);
      const { rows } = await pool.query(
        "SELECT book FROM versions WHERE id=$1 AND book_id=$2",
        [input.versionId, id],
      );
      if (!rows[0]) fail(404, "版本不存在");
      const b = bookSchema.parse(rows[0].book),
        d = createDoc(b);
      try {
        await transaction(async (db) => {
          await version(db, row, user, "恢复前自动备份");
          await db.query(
            "UPDATE books SET book=$1,state=$2,epoch=epoch+1,revision=revision+1,updated_at=now() WHERE id=$3",
            [b, Buffer.from(Y.encodeStateAsUpdate(d)), id],
          );
          await audit(db, user, "restore", id);
        });
        return room(await load(id), "admin");
      } finally {
        d.destroy();
      }
    });
    await broadcastRoom(id);
    return result;
  });
  app.get("/sync/:id", { websocket: true }, (socket, req) => {
    let client: SocketClient | undefined;
    const id = uuid.safeParse((req.params as any).id);
    const token = String(req.headers.authorization || "").replace(
      /^Bearer /,
      "",
    );
    const ready = locked(id.data || "invalid", async () => {
      if (!id.success) fail(400, "无效作品");
      const user = await authenticate(token),
        role = await access(user, id.data!),
        row = await load(id.data!);
      const peerId = randomUUID(),
        colors = ["#c77449", "#637ac3", "#3c956c", "#a563ac", "#968427"];
      client = {
        socket,
        bookId: id.data!,
        token,
        user,
        peer: {
          id: peerId,
          userId: user.id,
          name: user.displayName,
          color: colors[user.id.charCodeAt(0) % colors.length],
          field: "",
        },
      };
      clients.add(client!);
      const vector = req.headers["x-moye-vector"],
        epoch = Number(req.headers["x-moye-epoch"]),
        revision = Number(req.headers["x-moye-revision"]);
      const sync =
        typeof vector === "string" &&
        vector.length <= 6000 &&
        Number.isInteger(epoch) &&
        Number.isInteger(revision)
          ? { epoch, revision, vector }
          : undefined;
      send(socket, { type: "ready", room: room(row, role, sync) });
      peers(id.data!);
    });
    ready.catch((e: any) => {
      const denied = [400, 401, 403, 404].includes(e.statusCode);
      send(socket, {
        type: denied ? "denied" : "rejected",
        recover: false,
        message: denied ? e.message : "服务器暂时不可用，正在重连",
      });
      socket.close(denied ? 1008 : 1011, denied ? "unauthorized" : "retry");
    });
    socket.on("message", (raw) => {
      void ready
        .then(async () => {
          if (!client) return;
          const message = JSON.parse(raw.toString());
          if (message.type === "ping") {
            send(socket, { type: "pong" });
            return;
          }
          if (message.type === "presence") {
            await authenticate(token);
            await access(client.user, client.bookId);
            const p = z
              .object({
                field: z.string().max(300),
                awareness: binary.max(20000).optional(),
              })
              .parse(message);
            if (p.awareness) {
              const clean = trustedPresence(
                Buffer.from(p.awareness, "base64"),
                client.peer,
              );
              if (
                [...clients].some(
                  (c) =>
                    c !== client &&
                    c.bookId === client!.bookId &&
                    c.peer.awareness &&
                    readPresence(Buffer.from(c.peer.awareness, "base64")).id ===
                      clean.id,
                )
              )
                fail(400, "光标标识冲突，请重新打开作品");
              p.awareness = Buffer.from(clean.bytes).toString("base64");
            }
            client.peer = { ...client.peer, ...p };
            peers(client.bookId);
            return;
          }
          const m = z
            .object({
              type: z.literal("update"),
              id: uuid,
              epoch: z.number().int(),
              update: binary,
            })
            .parse(message);
          await locked(client.bookId, async () => {
            const user = await authenticate(token);
            await access(user, client!.bookId, true);
            const row = await load(client!.bookId);
            if (row.epoch !== m.epoch) fail(409, "作品已恢复，请重新同步");
            const d = doc(row);
            try {
              try {
                Y.applyUpdate(d, Buffer.from(m.update, "base64"));
                validDoc(row.book, d);
              } catch {
                fail(400, "更新与当前作品结构不兼容，已保留本地稿件");
              }
              const book = project(row.book, d);
              await transaction(async (db) => {
                await db.query(
                  "INSERT INTO updates(book_id,op_id,user_id,epoch,data) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
                  [
                    row.id,
                    m.id,
                    user.id,
                    m.epoch,
                    Buffer.from(m.update, "base64"),
                  ],
                );
                await db.query(
                  "UPDATE books SET book=$1,state=$2,updated_at=now() WHERE id=$3",
                  [book, Buffer.from(Y.encodeStateAsUpdate(d)), row.id],
                );
              });
              for (const other of clients)
                if (other.bookId === row.id && other !== client)
                  send(other.socket, {
                    type: "update",
                    epoch: m.epoch,
                    update: m.update,
                  });
              send(socket, { type: "ack", id: m.id });
            } finally {
              d.destroy();
            }
          });
        })
        .catch((e: any) => {
          send(socket, {
            type: "rejected",
            message:
              e instanceof z.ZodError
                ? "更新格式无效"
                : e.statusCode
                  ? e.message
                  : "同步失败，已保留本地修改",
            recover:
              [400, 403, 404, 409].includes(e.statusCode) ||
              e instanceof z.ZodError,
          });
          if (e.statusCode === 401) socket.close(1008, "expired");
        });
    });
    socket.on("close", () => {
      if (client) {
        clients.delete(client);
        peers(client.bookId);
      }
    });
  });
  const monitor = setInterval(() => {
    for (const c of clients) {
      void authenticate(c.token)
        .then(() => access(c.user, c.bookId))
        .catch((e: any) => {
          if ([401, 403, 404].includes(e.statusCode)) {
            send(c.socket, { type: "denied", message: "会话已失效" });
            c.socket.close(1008, "expired");
          } else c.socket.close(1011, "retry");
        });
    }
  }, 30000);
  monitor.unref();
  app.addHook("onClose", async () => {
    clearInterval(monitor);
    for (const c of clients) c.socket.close(1001, "shutdown");
    clients.clear();
  });
  return app;
}
