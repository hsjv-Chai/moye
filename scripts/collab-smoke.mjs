import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import WebSocket, { WebSocketServer } from "ws";
const config = JSON.parse(fs.readFileSync(".runtime/collab-test.json", "utf8"));
const httpRequest = async (url, body, method = "POST") => {
  const r = await fetch(config.base + url, {
    method,
    headers: {
      Authorization: "Bearer " + config.admin.token,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
};
const ai = http.createServer(async (req, res) => {
  let raw = "";
  for await (const part of req) raw += part;
  const prompt = JSON.parse(raw).messages[0].content;
  const output = prompt.includes("润色选段")
    ? "清晨"
    : prompt.includes("请只回复")
      ? "连接成功"
      : "雾色渐浓，灯塔仍为归航的人亮着。";
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const c of output) {
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`,
    );
    await new Promise((r) => setTimeout(r, 30));
  }
  res.end("data: [DONE]\n\n");
});
await new Promise((r) => ai.listen(0, "127.0.0.1", r));
let online = true;
const sockets = new Set();
const proxy = http.createServer(async (req, res) => {
  if (!online) {
    req.socket.destroy();
    return;
  }
  try {
    let body = "";
    for await (const chunk of req) body += chunk;
    const r = await fetch(config.base + req.url, {
      method: req.method,
      headers: {
        Authorization: req.headers.authorization || "",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body || undefined,
    });
    res.writeHead(r.status, { "Content-Type": "application/json" });
    res.end(await r.text());
  } catch {
    res.writeHead(502);
    res.end("{}");
  }
});
const wss = new WebSocketServer({ noServer: true });
proxy.on("upgrade", (req, socket, head) => {
  if (!online) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (local) => {
    const remote = new WebSocket(config.base.replace(/^http/, "ws") + req.url, {
      headers: {
        Authorization: req.headers.authorization || "",
        ...(req.headers["x-moye-vector"]
          ? {
              "X-Moye-Vector": req.headers["x-moye-vector"],
              "X-Moye-Epoch": req.headers["x-moye-epoch"],
              "X-Moye-Revision": req.headers["x-moye-revision"],
            }
          : {}),
      },
    });
    sockets.add(local);
    sockets.add(remote);
    const queue = [];
    local.on("message", (data) => {
      if (remote.readyState === 1) remote.send(data.toString());
      else queue.push(data.toString());
    });
    remote.on("open", () => queue.forEach((m) => remote.send(m)));
    remote.on("message", (data) => {
      if (local.readyState === 1) local.send(data.toString());
    });
    for (const [a, b] of [
      [local, remote],
      [remote, local],
    ]) {
      a.on("close", () => {
        sockets.delete(a);
        b.terminate();
      });
      a.on("error", () => b.terminate());
    }
  });
});
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
const server = `http://127.0.0.1:${proxy.address().port}`;
const dirs = [0, 1, 2].map(() =>
  fs.mkdtempSync(path.join(os.tmpdir(), "moye-collab-e2e-")),
);
const apps = [];
const errors = [];
async function launch(index, user) {
  const env = { ...process.env, MOYE_DATA_DIR: dirs[index] };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    ...(process.env.MOYE_TEST_EXECUTABLE
      ? { executablePath: process.env.MOYE_TEST_EXECUTABLE, args: [] }
      : { args: ["."] }),
    env,
  });
  apps[index] = app;
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByRole("button", { name: "多人协作", exact: true }).click();
  if (await page.getByLabel("协作用户名").isVisible()) {
    await page.getByLabel("协作服务器").fill(server);
    await page.getByLabel("协作用户名").fill(user.username);
    await page.getByLabel("协作密码").fill(user.password);
    await page
      .getByRole("button", { name: "登录协作空间", exact: true })
      .click();
  }
  await page.locator(".collab-book").first().click();
  await page.getByRole("textbox", { name: "协作正文", exact: true }).waitFor();
  return page;
}
const text = (p) => p.getByRole("textbox", { name: "协作正文", exact: true });
const bodyText = (p) =>
  text(p).evaluate((el) =>
    Array.from(el.querySelectorAll(".cm-line"))
      .map((line) => {
        const copy = line.cloneNode(true);
        copy
          .querySelectorAll('[contenteditable="false"]')
          .forEach((n) => n.remove());
        return copy.textContent.replace(/\u2060/g, "");
      })
      .join("\n"),
  );
async function wait(fn) {
  const end = Date.now() + 25000;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("E2E convergence timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}
async function append(page, value) {
  await text(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText(value);
}
try {
  const initial = await httpRequest(
    `/api/books/${config.bookId}`,
    undefined,
    "GET",
  );
  await httpRequest(`/api/books/${config.bookId}/edit`, {
    epoch: initial.epoch,
    edit: {
      field: `chapter:${initial.book.chapters[0].id}:body`,
      baseline: initial.book.chapters[0].body,
      text: "原稿从这里开始。",
      mode: "replace",
      reason: "桌面验收初始化",
    },
  });
  let a = await launch(0, config.admin),
    b = await launch(1, config.editor);
  await a.getByText("已同步", { exact: true }).waitFor();
  await b.getByText("已同步", { exact: true }).waitFor();
  await Promise.all([append(a, "桌面甲"), append(b, "桌面乙")]);
  await wait(async () => {
    const x = await bodyText(a),
      y = await bodyText(b);
    return x === y && x.includes("桌面甲") && x.includes("桌面乙");
  });
  await append(a, "本人撤销");
  await wait(async () => (await bodyText(b)).includes("本人撤销"));
  await a.keyboard.press("ControlOrMeta+z");
  await wait(
    async () =>
      !(await bodyText(a)).includes("本人撤销") &&
      (await bodyText(a)) === (await bodyText(b)),
  );
  assert.ok((await bodyText(a)).includes("桌面乙"));
  await text(a).click();
  await a.keyboard.press("ArrowLeft");
  await wait(async () => (await b.locator(".cm-ySelectionCaret").count()) > 0);
  // Composition event queues remote updates until composition commits.
  await text(a).dispatchEvent("compositionstart");
  await append(b, "组合期远程稿");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await bodyText(a)).includes("组合期远程稿"), false);
  await text(a).dispatchEvent("compositionend");
  await wait(async () => (await bodyText(a)).includes("组合期远程稿"));
  // AI candidates stay private; acceptance compares current text and saves a server version.
  await a.getByTitle("AI 连接与偏好", { exact: true }).click();
  await a.getByRole("button", { name: "添加第一个连接", exact: true }).click();
  await a.getByLabel("服务商").selectOption("custom");
  await a.getByLabel("连接名称").fill("私有模拟服务");
  await a
    .getByLabel("API 基础地址")
    .fill(`http://127.0.0.1:${ai.address().port}/v1`);
  await a.getByLabel("模型名称").fill("mock");
  await a.getByRole("button", { name: "保存并测试", exact: true }).click();
  await a.getByText("连接成功，已收到模型响应。", { exact: true }).waitFor();
  await a
    .getByRole("dialog", { name: "AI 连接与偏好" })
    .getByLabel("关闭窗口")
    .click();
  await a.getByRole("button", { name: "开始生成", exact: true }).click();
  await append(b, "生成期间他人修改");
  await a.waitForFunction(
    () =>
      document.querySelector(".candidate-text") &&
      !document.querySelector(".candidate-text").readOnly,
  );
  assert.equal(
    await b.evaluate(
      (id) => window.moye.drafts(id).then((x) => x.length),
      config.bookId,
    ),
    0,
  );
  const beforeAI = await bodyText(b);
  assert.ok(!beforeAI.includes("雾色渐浓"));
  await a.getByRole("button", { name: "替换目标内容", exact: true }).click();
  await a.getByRole("dialog", { name: "请确认" }).waitFor();
  await a
    .getByRole("dialog", { name: "请确认" })
    .getByRole("button", { name: "取消", exact: true })
    .click();
  assert.equal(await bodyText(b), beforeAI);
  await a.getByRole("button", { name: "替换目标内容", exact: true }).click();
  await a
    .getByRole("dialog", { name: "请确认" })
    .getByRole("button", { name: "确认", exact: true })
    .click();
  await wait(
    async () => (await bodyText(b)) === "雾色渐浓，灯塔仍为归航的人亮着。",
  );
  await text(a).focus();
  await a.keyboard.press("ControlOrMeta+Home");
  await a.keyboard.press("Shift+ArrowRight");
  await a.keyboard.press("Shift+ArrowRight");
  await a.getByRole("button", { name: "润色选段", exact: true }).click();
  await a.getByRole("button", { name: "开始生成", exact: true }).click();
  await append(b, "远程尾声");
  await a.waitForFunction(
    () =>
      document.querySelector(".candidate-text") &&
      !document.querySelector(".candidate-text").readOnly,
  );
  await a.getByRole("button", { name: "替换选段", exact: true }).click();
  await wait(
    async () =>
      (await bodyText(b)).startsWith("清晨渐浓") &&
      (await bodyText(b)).endsWith("远程尾声"),
  );
  const backup = await httpRequest(
    `/api/books/${config.bookId}/backup`,
    undefined,
    "GET",
  );
  assert.ok(backup.versions.length > 0);
  assert.equal(JSON.stringify(backup).includes("私有模拟服务"), false);
  const backupPath = path.join(dirs[0], "shared.moye.json");
  fs.writeFileSync(backupPath, JSON.stringify(backup));
  await apps[0].evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, backupPath);
  const restored = await a.evaluate(() => window.moye.restoreBackup());
  assert.notEqual(restored.id, config.bookId);
  assert.equal(restored.chapters[0].body, backup.book.chapters[0].body);
  await a.screenshot({ path: "test-results/collab-desktop.png" });
  online = false;
  for (const socket of sockets) socket.terminate();
  await a.getByText("已保存本机 · 离线", { exact: true }).waitFor();
  await append(a, "离线退出重启稿");
  await append(b, "双方离线稿");
  await new Promise((r) => setTimeout(r, 400));
  await apps[0].close();
  apps[0] = null;
  a = await launch(0, config.admin);
  assert.ok((await bodyText(a)).includes("离线退出重启稿"));
  online = true;
  await wait(async () => {
    const x = await bodyText(a),
      y = await bodyText(b);
    return x === y && x.includes("双方离线稿") && x.includes("离线退出重启稿");
  });
  await a.getByText("已同步", { exact: true }).waitFor();
  const ro = await launch(2, config.reader);
  assert.equal(await text(ro).getAttribute("contenteditable"), "false");
  // Stale offline operations must become a personal recovery copy after restore.
  const versions = await httpRequest(
    `/api/books/${config.bookId}/versions`,
    undefined,
    "GET",
  );
  online = false;
  for (const socket of sockets) socket.terminate();
  await new Promise((r) => setTimeout(r, 300));
  await append(b, "旧代次恢复副本测试");
  await new Promise((r) => setTimeout(r, 300));
  await httpRequest(`/api/books/${config.bookId}/restore`, {
    versionId: versions[0].id,
  });
  online = true;
  await wait(
    async () =>
      await b.evaluate(async () =>
        (await window.moye.listBooks()).some((x) =>
          x.chapters.some((c) => c.body.includes("旧代次恢复副本测试")),
        ),
      ),
  );
  await wait(async () => (await bodyText(a)) === (await bodyText(b)));
  console.log(
    "PASS: AI acceptance, offline restart and restore; checking long editor.",
  );
  // CodeMirror must remain editable on a long Chinese chapter, including its last line.
  const longText = "春潮带雨晚来急。\n".repeat(25000);
  await text(a).focus();
  await a.keyboard.press("ControlOrMeta+a");
  await text(a).evaluate((el, value) => {
    const data = new DataTransfer();
    data.setData("text/plain", value);
    el.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
  }, longText);
  console.log("Long chapter inserted");
  await append(a, "长篇编辑器末尾");
  await wait(async () => {
    const r = await httpRequest(
      `/api/books/${config.bookId}`,
      undefined,
      "GET",
    );
    return r.book.chapters[0].body === longText + "长篇编辑器末尾";
  });
  console.log("Long chapter persisted");
  await b.getByText("175007 字", { exact: true }).first().waitFor();
  await text(b).focus();
  await b.keyboard.press("ControlOrMeta+End");
  console.log("Long chapter end focused");
  await wait(async () => (await bodyText(b)).includes("长篇编辑器末尾"));
  await text(a).focus();
  await a.keyboard.press("ControlOrMeta+a");
  await text(a).evaluate((el) => {
    const data = new DataTransfer();
    data.setData("text/plain", "长篇编辑器验证完成。");
    el.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
  });
  await wait(async () => (await bodyText(b)) === "长篇编辑器验证完成。");
  assert.deepEqual(errors, []);
  console.log(
    "PASS: two macOS Electron clients, concurrent editing, self-only undo, remote cursor, composition queue, offline restart, two-sided offline merge, reader protection, epoch recovery copy, private AI drafts, atomic AI conflict, relative selection rewrite, shared backup restore, 225000-character editor.",
  );
} catch (e) {
  for (let i = 0; i < apps.length; i++)
    if (apps[i]) {
      const p = await apps[i].firstWindow();
      await p
        .screenshot({ path: `test-results/collab-failure-${i}.png` })
        .catch(() => {});
      console.error(
        "UI",
        i,
        (await p.locator("body").innerText()).slice(0, 2600),
      );
    }
  throw e;
} finally {
  online = true;
  for (const app of apps) if (app) await app.close().catch(() => {});
  for (const s of sockets) s.terminate();
  wss.close();
  proxy.close();
  ai.close();
}
