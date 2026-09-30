// Run only against a disposable database named moye_users_verify_*.
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import WebSocket from "ws";
import { buildServer } from "../server/app";
import { pool, passwordHash } from "../server/db";
import { newBook } from "../shared/model";
assert.match(
  new URL(process.env.DATABASE_URL!).pathname,
  /^\/moye_users_verify_[a-z0-9_]+$/,
);
const app = await buildServer();
const sockets: WebSocket[] = [];
let token = "";
const password = randomBytes(24).toString("hex");
const adminId = randomUUID();
async function request(
  url: string,
  method: "GET" | "POST" | "PATCH" | "PUT" = "GET",
  payload?: unknown,
  auth = token,
  status = 200,
) {
  const r = await app.inject({
    method,
    url,
    payload,
    headers: { authorization: `Bearer ${auth}` },
  });
  assert.equal(r.statusCode, status, `${method} ${url}: ${r.body}`);
  return r.json();
}
async function connect(bookId: string, auth: string) {
  const socket = new WebSocket(`${base.replace("http", "ws")}/sync/${bookId}`, {
    headers: { Authorization: `Bearer ${auth}` },
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("WebSocket ready timeout")),
      8000,
    );
    socket.on("error", reject);
    socket.on("message", (raw) => {
      if (JSON.parse(raw.toString()).type === "ready") {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  return socket;
}
function closed(socket: WebSocket) {
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("WebSocket close timeout")),
      8000,
    );
    socket.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}
const base = await app.listen({ host: "127.0.0.1", port: 0 });
try {
  await pool.query(
    "INSERT INTO users(id,username,display_name,password,admin,must_change) VALUES($1,'verify_admin','验证管理员',$2,true,false)",
    [adminId, passwordHash(password)],
  );
  token = (
    await request("/api/login", "POST", { username: "verify_admin", password })
  ).token;
  const payload = {
    username: "verify_member",
    displayName: " 验证成员 ",
    password,
  };
  const user = await request("/api/users", "POST", payload);
  assert.equal(user.displayName, "验证成员");
  assert.equal(user.mustChangePassword, true);
  assert.equal(user.password, undefined);
  await request("/api/users", "POST", payload, token, 409);
  const login = await request("/api/login", "POST", {
    username: payload.username,
    password,
  });
  const memberToken = login.token;
  const newPassword = randomBytes(24).toString("hex");
  await request(
    "/api/password",
    "POST",
    { oldPassword: password, newPassword },
    memberToken,
  );
  await request("/api/users", "GET", undefined, memberToken, 403);
  const b = await request("/api/books", "POST", newBook("账号管理隔离验证"));
  const memberUrl = `/api/books/${b.id}/members/${user.id}`;
  await request(memberUrl, "PUT", { role: "editor" });
  const socket = await connect(b.id, memberToken);
  const nameClosed = closed(socket);
  await request(`/api/users/${user.id}`, "PATCH", {
    displayName: " 更新名称 ",
  });
  assert.equal(await nameClosed, 1012);
  assert.equal(
    (await request("/api/me", "GET", undefined, memberToken)).user.displayName,
    "更新名称",
  );
  const reconnect = await connect(b.id, memberToken);
  const roleClosed = closed(reconnect);
  await request(memberUrl, "PUT", { role: "reader" });
  assert.equal(await roleClosed, 1008);
  assert.equal(
    (await request(`/api/users/${user.id}/books`))[0].role,
    "reader",
  );
  assert.equal((await request(`/api/books/${b.id}/members`))[0].role, "reader");
  assert.equal(
    (await request(`/api/books/${b.id}`, "GET", undefined, memberToken)).role,
    "reader",
  );
  const reader = await connect(b.id, memberToken);
  const revoked = closed(reader);
  await request(memberUrl, "PUT", { role: null });
  assert.equal(await revoked, 1008);
  await request(`/api/books/${b.id}`, "GET", undefined, memberToken, 403);
  await request(memberUrl, "PUT", { role: "editor" });
  const enabled = await connect(b.id, memberToken);
  const disabled = closed(enabled);
  await request(`/api/users/${user.id}`, "PATCH", { active: false });
  assert.equal(await disabled, 1008);
  await request("/api/me", "GET", undefined, memberToken, 401);
  await request(memberUrl, "PUT", { role: "reader" });
  await request(memberUrl, "PUT", { role: "editor" }, token, 400);
  await request(memberUrl, "PUT", { role: null });
  await request(memberUrl, "PUT", { role: "reader" }, token, 400);
  await request(`/api/users/${user.id}`, "PATCH", { active: true });
  const relogin = await request("/api/login", "POST", {
    username: payload.username,
    password: newPassword,
  });
  await request(`/api/users/${user.id}`, "PATCH", { password });
  await request("/api/me", "GET", undefined, relogin.token, 401);
  const resetLogin = await request("/api/login", "POST", {
    username: payload.username,
    password,
  });
  assert.equal(resetLogin.user.mustChangePassword, true);
  for (const patch of [
    {},
    { displayName: " " },
    { admin: true },
    { displayName: "a".repeat(81) },
  ])
    await request(`/api/users/${user.id}`, "PATCH", patch, token, 400);
  await request(
    `/api/users/${randomUUID()}`,
    "PATCH",
    { displayName: "无账号" },
    token,
    404,
  );
  await request(
    `/api/users/${randomUUID()}/books`,
    "GET",
    undefined,
    token,
    404,
  );
  await request(
    `/api/books/${randomUUID()}/members/${user.id}`,
    "PUT",
    { role: "reader" },
    token,
    404,
  );
  await request(
    `/api/books/${b.id}/members/${randomUUID()}`,
    "PUT",
    { role: "reader" },
    token,
    404,
  );
  await request(
    `/api/books/${b.id}/members/${adminId}`,
    "PUT",
    { role: "reader" },
    token,
    400,
  );
  await request(
    `/api/users/${adminId}`,
    "PATCH",
    { active: false },
    token,
    400,
  );
  console.log(
    "PASS: real PostgreSQL account lifecycle, validation, both permission views, session retention/revocation, WebSocket rename/reconnect and access revocation.",
  );
} finally {
  for (const socket of sockets) socket.terminate();
  await app.close();
  await pool.end();
}
