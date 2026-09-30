import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { userPatchSchema } from "../shared/collab";
const data = vi.hoisted(() => ({
  users: new Map<string, any>(),
  sessions: new Map<string, string>(),
  members: new Map<string, string>(),
  books: new Map<string, any>(),
}));
vi.mock("../server/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("../server/db")>();
  const query = async (sql: string, args: any[] = []) => {
    let rows: any[] = [];
    if (sql.startsWith("SELECT u.* FROM sessions")) {
      const u = data.users.get(data.sessions.get(args[0]) || "");
      if (u?.active) rows = [u];
    } else if (sql.startsWith("SELECT * FROM users WHERE username"))
      rows = [...data.users.values()].filter((u) => u.username === args[0]);
    else if (sql.startsWith("SELECT * FROM users WHERE id"))
      rows = data.users.has(args[0]) ? [{ ...data.users.get(args[0]) }] : [];
    else if (sql.startsWith("SELECT * FROM users ORDER"))
      rows = [...data.users.values()];
    else if (sql.startsWith("INSERT INTO users")) {
      if ([...data.users.values()].some((u) => u.username === args[1]))
        throw Object.assign(new Error("duplicate"), { code: "23505" });
      data.users.set(args[0], {
        id: args[0],
        username: args[1],
        display_name: args[2],
        password: args[3],
        admin: args[4],
        active: true,
        must_change: true,
      });
    } else if (sql.startsWith("UPDATE users SET display_name"))
      data.users.get(args[1]).display_name = args[0];
    else if (sql.startsWith("UPDATE users SET active"))
      data.users.get(args[1]).active = args[0];
    else if (sql.startsWith("UPDATE users SET password"))
      Object.assign(data.users.get(args[1]), {
        password: args[0],
        must_change: true,
      });
    else if (sql.startsWith("DELETE FROM sessions WHERE user_id")) {
      for (const [token, id] of data.sessions)
        if (id === args[0]) data.sessions.delete(token);
    } else if (sql.startsWith("SELECT b.*, m.role FROM books b LEFT"))
      rows = [...data.books.values()].map((b) => ({
        ...b,
        role: data.members.get(`${b.id}/${args[0]}`),
      }));
    else if (sql.startsWith("SELECT id FROM books"))
      rows = data.books.has(args[0]) ? [{ id: args[0] }] : [];
    else if (sql.startsWith("SELECT role FROM members")) {
      const role = data.members.get(`${args[0]}/${args[1]}`);
      if (role) rows = [{ role }];
    } else if (sql.startsWith("INSERT INTO members"))
      data.members.set(`${args[0]}/${args[1]}`, args[2]);
    else if (sql.startsWith("DELETE FROM members"))
      data.members.delete(`${args[0]}/${args[1]}`);
    else if (sql.startsWith("SELECT m.user_id"))
      rows = [...data.users.values()]
        .filter((u) => data.members.has(`${args[0]}/${u.id}`))
        .map((u) => ({
          userId: u.id,
          username: u.username,
          displayName: u.display_name,
          role: data.members.get(`${args[0]}/${u.id}`),
        }));
    else if (!sql.startsWith("INSERT INTO audit"))
      throw new Error(`Unimplemented test SQL: ${sql}`);
    return { rows };
  };
  return {
    ...original,
    pool: { query },
    migrate: async () => {},
    transaction: async (fn: any) => fn({ query }),
  };
});
import { buildServer } from "../server/app";
import { tokenHash, passwordMatches } from "../server/db";
let app: Awaited<ReturnType<typeof buildServer>>;
let adminId: string, userId: string, bookId: string;
const call = (
  url: string,
  method: "GET" | "POST" | "PATCH" | "PUT" = "GET",
  payload?: any,
  token = "admin",
) =>
  app.inject({
    method,
    url,
    payload,
    headers: { authorization: `Bearer ${token}` },
  });
beforeEach(async () => {
  for (const map of Object.values(data)) map.clear();
  adminId = randomUUID();
  userId = randomUUID();
  bookId = randomUUID();
  for (const [id, admin, token] of [
    [adminId, true, "admin"],
    [userId, false, "member"],
  ] as const) {
    data.users.set(id, {
      id,
      username: token,
      display_name: token,
      admin,
      active: true,
      must_change: false,
    });
    data.sessions.set(tokenHash(token), id);
  }
  data.books.set(bookId, {
    id: bookId,
    book: { title: "测试作品", archived: true },
    epoch: 1,
    revision: 1,
    updated_at: new Date().toISOString(),
  });
  app = await buildServer();
});
afterEach(async () => {
  await app.close();
});
describe("account management routes (in-memory database substitute)", () => {
  it("requires administrator access for every management route", async () => {
    for (const [url, method, payload] of [
      ["/api/users", "GET"],
      ["/api/users", "POST", {}],
      [`/api/users/${userId}`, "PATCH", { displayName: "新名" }],
      [`/api/users/${userId}/books`, "GET"],
      [`/api/books/${bookId}/members`, "GET"],
      [`/api/books/${bookId}/members/${userId}`, "PUT", { role: "reader" }],
    ] as const)
      expect((await call(url, method, payload, "member")).statusCode).toBe(403);
    expect(
      (await call("/api/users", "GET", undefined, "unknown")).statusCode,
    ).toBe(401);
  });
  it("validates creation, rejects duplicates, and never returns password hashes", async () => {
    const payload = {
      username: "new_user",
      displayName: " 新成员 ",
      password: "temporary-password",
    };
    const created = await call("/api/users", "POST", payload);
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      displayName: "新成员",
      mustChangePassword: true,
    });
    expect(created.json()).not.toHaveProperty("password");
    expect((await call("/api/users", "POST", payload)).statusCode).toBe(409);
    expect(
      (
        await call("/api/users", "POST", {
          ...payload,
          username: "another",
          displayName: "  ",
        })
      ).statusCode,
    ).toBe(400);
  });
  it("trims names without revoking sessions and rejects invalid or missing targets", async () => {
    expect(
      (await call(`/api/users/${userId}`, "PATCH", { displayName: " 新名称 " }))
        .statusCode,
    ).toBe(200);
    expect(
      (await call("/api/me", "GET", undefined, "member")).json().user
        .displayName,
    ).toBe("新名称");
    for (const patch of [
      {},
      { displayName: " " },
      { displayName: "a".repeat(81) },
      { admin: true },
    ])
      expect(
        (await call(`/api/users/${userId}`, "PATCH", patch)).statusCode,
      ).toBe(400);
    expect(
      (
        await call(`/api/users/${randomUUID()}`, "PATCH", {
          displayName: "名字",
        })
      ).statusCode,
    ).toBe(404);
    expect((await call(`/api/users/${randomUUID()}/books`)).statusCode).toBe(
      404,
    );
    expect(userPatchSchema.safeParse({ displayName: undefined }).success).toBe(
      false,
    );
  });
  it("revokes sessions on reset and disable, preserving permissions on re-enable", async () => {
    data.members.set(`${bookId}/${userId}`, "editor");
    expect(
      (
        await call(`/api/users/${userId}`, "PATCH", {
          password: "new-temporary-password",
        })
      ).statusCode,
    ).toBe(200);
    expect(
      passwordMatches(
        "new-temporary-password",
        data.users.get(userId).password,
      ),
    ).toBe(true);
    expect(data.users.get(userId).must_change).toBe(true);
    expect((await call("/api/me", "GET", undefined, "member")).statusCode).toBe(
      401,
    );
    data.sessions.set(tokenHash("member"), userId);
    await call(`/api/users/${userId}`, "PATCH", { active: false });
    expect(data.sessions.has(tokenHash("member"))).toBe(false);
    await call(`/api/users/${userId}`, "PATCH", { active: true });
    expect(data.members.get(`${bookId}/${userId}`)).toBe("editor");
    expect(
      (await call(`/api/users/${adminId}`, "PATCH", { active: false }))
        .statusCode,
    ).toBe(400);
  });
  it("keeps both permission views consistent and enforces disabled-user restrictions", async () => {
    const url = `/api/books/${bookId}/members/${userId}`;
    for (const role of ["reader", "editor", "reader", null]) {
      expect((await call(url, "PUT", { role })).statusCode).toBe(200);
      expect(
        (await call(`/api/users/${userId}/books`)).json()[0],
      ).toMatchObject({ role, archived: true });
      expect((await call(`/api/books/${bookId}/members`)).json().length).toBe(
        role ? 1 : 0,
      );
    }
    await call(url, "PUT", { role: "editor" });
    await call(`/api/users/${userId}`, "PATCH", { active: false });
    expect((await call(url, "PUT", { role: "reader" })).statusCode).toBe(200);
    expect((await call(url, "PUT", { role: "editor" })).statusCode).toBe(400);
    expect((await call(url, "PUT", { role: null })).statusCode).toBe(200);
    expect((await call(url, "PUT", { role: "reader" })).statusCode).toBe(400);
    expect(
      (
        await call(`/api/books/${bookId}/members/${adminId}`, "PUT", {
          role: "reader",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call(`/api/books/${bookId}/members/${randomUUID()}`, "PUT", {
          role: "reader",
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await call(`/api/books/${randomUUID()}/members/${userId}`, "PUT", {
          role: null,
        })
      ).statusCode,
    ).toBe(404);
    expect((await call(`/api/users/${adminId}/books`)).json()[0].role).toBe(
      "admin",
    );
  });
});
