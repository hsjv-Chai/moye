// Isolated Electron UI smoke test; never reads deployment credentials.
import { _electron as electron } from "playwright";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moye-users-"));
await build({
  stdin: {
    contents:
      'export { newBook } from "./shared/model"; export { createDoc } from "./shared/collab"; export { encodeStateAsUpdate } from "yjs";',
    resolveDir: process.cwd(),
  },
  outfile: path.join(dir, "fixture.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
});
const { newBook, createDoc, encodeStateAsUpdate } = createRequire(
  import.meta.url,
)(path.join(dir, "fixture.cjs"));
const admin = {
  id: randomUUID(),
  username: "admin",
  displayName: "管理员",
  admin: true,
  active: true,
  mustChangePassword: false,
};
const member = {
  id: randomUUID(),
  username: "writer",
  displayName: "测试作者",
  admin: false,
  active: true,
  mustChangePassword: false,
};
const users = [admin, member];
const book = newBook("测试协作作品");
const doc = createDoc(book);
const room = {
  book,
  state: Buffer.from(encodeStateAsUpdate(doc)).toString("base64"),
  epoch: 1,
  revision: 1,
  role: "admin",
};
const summary = {
  id: book.id,
  title: book.title,
  archived: false,
  epoch: 1,
  revision: 1,
  updatedAt: new Date().toISOString(),
  role: "admin",
};
const roles = new Map();
let writes = 0,
  failPatch = false,
  failRefresh = false;
const server = http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  const url = req.url;
  let result = { ok: true };
  let status = 200;
  if (url === "/api/login") result = { token: "isolated-token", user: admin };
  else if (url === "/api/me") result = { user: admin };
  else if (url === "/api/books") result = [summary];
  else if (url === "/api/users" && req.method === "GET") {
    if (failRefresh) {
      failRefresh = false;
      status = 503;
      result = { error: "模拟刷新失败" };
    } else result = users;
  } else if (url === "/api/users" && req.method === "POST") {
    writes++;
    await new Promise((r) => setTimeout(r, 200));
    result = {
      id: randomUUID(),
      ...body,
      active: true,
      mustChangePassword: true,
    };
    delete result.password;
    users.push(result);
  } else if (/^\/api\/users\/[^/]+\/books$/.test(url)) {
    const id = url.split("/")[3];
    result = [
      { ...summary, role: id === admin.id ? "admin" : roles.get(id) || null },
    ];
  } else if (url.startsWith("/api/users/") && req.method === "PATCH") {
    writes++;
    if (failPatch) {
      failPatch = false;
      status = 503;
      result = { error: "模拟保存失败" };
    } else {
      const user = users.find((u) => u.id === url.split("/")[3]);
      if (body.password) user.mustChangePassword = true;
      else Object.assign(user, body);
    }
  } else if (url === `/api/books/${book.id}/members`)
    result = users
      .filter((u) => roles.has(u.id))
      .map((u) => ({
        userId: u.id,
        username: u.username,
        displayName: u.displayName,
        role: roles.get(u.id),
      }));
  else if (url.startsWith(`/api/books/${book.id}/members/`)) {
    const id = url.split("/")[5];
    body.role ? roles.set(id, body.role) : roles.delete(id);
  } else if (
    url === `/api/books/${book.id}` ||
    url === `/api/books/${book.id}/sync`
  )
    result = room;
  else if (url === "/api/password") result = { ok: true };
  else {
    status = 404;
    result = { error: `Unexpected test request: ${req.method} ${url}` };
  }
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result));
});
const wss = new WebSocketServer({ server });
wss.on("connection", (socket) => {
  socket.send(JSON.stringify({ type: "ready", room }));
});
let app;
try {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const env = { ...process.env, MOYE_DATA_DIR: path.join(dir, "data") };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ["."], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByRole("button", { name: "多人协作", exact: true }).click();
  await page
    .getByLabel("协作服务器")
    .fill(`http://127.0.0.1:${server.address().port}`);
  await page.getByLabel("协作用户名").fill("admin");
  await page.getByLabel("协作密码").fill("test-password");
  await page.getByRole("button", { name: "登录协作空间" }).click();
  await page.getByRole("button", { name: "管理账号" }).click();
  let dialog = page.getByRole("dialog", { name: "管理员 · 账号管理" });
  await dialog.getByText("测试作者 · writer", { exact: true }).waitFor();
  await dialog.getByLabel("搜索账号").fill("missing");
  await dialog.getByText("没有符合条件的账号").waitFor();
  await dialog.getByLabel("搜索账号").fill("writer");
  await dialog.getByRole("button", { name: "管理", exact: true }).click();
  await dialog.getByLabel("编辑显示名称").fill("新作者");
  failPatch = true;
  await dialog.getByRole("button", { name: "保存名称" }).click();
  await dialog.getByRole("alert").filter({ hasText: "模拟保存失败" }).waitFor();
  assert.equal(await dialog.getByLabel("编辑显示名称").inputValue(), "新作者");
  failRefresh = true;
  await dialog.getByRole("button", { name: "保存名称" }).click();
  await dialog.getByText(/操作已成功，但列表刷新失败/).waitFor();
  await dialog.getByRole("button", { name: "刷新资料", exact: true }).click();
  await dialog.getByRole("heading", { name: "新作者 · writer" }).waitFor();
  await dialog.getByLabel("权限-测试协作作品").selectOption("editor");
  await page.waitForFunction(
    () =>
      document.querySelector('select[aria-label="权限-测试协作作品"]').value ===
      "editor",
  );
  await dialog.getByRole("button", { name: "重置密码", exact: true }).click();
  await dialog
    .getByLabel("新临时密码", { exact: true })
    .fill("replacement-password");
  await dialog.getByLabel("确认新密码").fill("mismatch-password");
  await dialog.getByRole("button", { name: "确认重置密码" }).click();
  await dialog.getByText(/两次输入的密码不一致/).waitFor();
  await dialog.getByLabel("确认新密码").fill("replacement-password");
  await dialog.getByRole("button", { name: "确认重置密码" }).click();
  await dialog
    .getByText("密码已重置，原会话已失效，下次登录需修改临时密码", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await dialog.getByLabel("新临时密码", { exact: true }).inputValue(),
    "",
  );
  await dialog.getByRole("button", { name: "停用账号" }).click();
  await page
    .getByRole("dialog", { name: "请确认" })
    .getByRole("button", { name: "确认", exact: true })
    .click();
  await dialog.getByRole("button", { name: "启用账号" }).waitFor();
  await dialog.getByLabel("权限-测试协作作品").selectOption("reader");
  await page
    .getByRole("dialog", { name: "请确认" })
    .getByRole("button", { name: "确认", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector('select[aria-label="权限-测试协作作品"]').value ===
      "reader",
  );
  await page.waitForFunction(
    () =>
      document.querySelector(
        'select[aria-label="权限-测试协作作品"] option[value="editor"]',
      ).disabled,
  );
  await dialog.getByRole("button", { name: "启用账号" }).click();
  await page
    .getByRole("dialog", { name: "请确认" })
    .getByRole("button", { name: "确认", exact: true })
    .click();
  await dialog.getByRole("button", { name: "停用账号" }).waitFor();
  await dialog.getByRole("button", { name: "返回账号列表" }).click();
  await dialog.getByLabel("搜索账号").fill("");
  await dialog.getByLabel("账号类型", { exact: true }).selectOption("admin");
  assert.equal(
    await dialog.getByRole("button", { name: "管理", exact: true }).count(),
    1,
  );
  await dialog.getByLabel("账号类型", { exact: true }).selectOption("all");
  await dialog.getByRole("button", { name: "创建账号", exact: true }).click();
  await dialog.getByLabel("新用户名").fill("new_writer");
  await dialog.getByLabel("显示名称", { exact: true }).fill("新账号");
  await dialog.getByLabel("新账号临时密码").fill("temporary-password");
  const before = writes;
  await dialog
    .getByRole("button", { name: "创建账号", exact: true })
    .evaluate((el) => {
      el.click();
      el.click();
    });
  await dialog
    .getByText("账号已创建，首次登录需修改临时密码", { exact: true })
    .waitFor();
  assert.equal(writes - before, 1);
  await dialog.getByRole("button", { name: "返回账号列表" }).click();
  await dialog.getByText("新账号 · new_writer", { exact: true }).waitFor();
  fs.mkdirSync("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/user-management.png" });
  await dialog.getByRole("button", { name: "关闭窗口" }).click();
  await page.locator(".collab-book").first().click();
  await page.getByTitle("协作成员管理", { exact: true }).click();
  dialog = page.getByRole("dialog", { name: "作品成员与权限" });
  await dialog.getByLabel("权限-新作者 · writer").waitFor();
  assert.equal(
    await dialog.getByLabel("权限-新作者 · writer").inputValue(),
    "reader",
  );
  await dialog.getByLabel("权限-新作者 · writer").selectOption("");
  await page
    .getByRole("dialog", { name: "请确认" })
    .getByRole("button", { name: "确认", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector('select[aria-label="权限-新作者 · writer"]')
        .value === "",
  );
  assert.equal(roles.has(member.id), false);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: "test-results/member-management.png" });
  console.log(
    "User management Electron smoke passed: search, filters, create, duplicate submission, edit, failure/retry, reset, disable/enable, both permission entry points.",
  );
} finally {
  await app?.close();
  for (const socket of wss.clients) socket.terminate();
  await new Promise((r) => wss.close(r));
  await new Promise((r) => server.close(r));
  doc.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
}
