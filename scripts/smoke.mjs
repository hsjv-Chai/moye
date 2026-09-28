import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
const data = fs.mkdtempSync(path.join(os.tmpdir(), "moye-smoke-"));
fs.mkdirSync("test-results", { recursive: true });
const server = http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw),
    prompt = body.messages[0].content;
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  let output = "连接成功。";
  if (prompt.includes("任务：生成初稿"))
    output = "风穿过旧邮局。林舟拆开信，信上写着：别相信明天的自己。";
  if (prompt.includes("任务：润色选段")) output = "清晨的风悄然穿过旧邮局。";
  if (prompt.includes("任务：生成章节摘要"))
    output = "林舟收到一封警告自己的来信，新的悬念由此展开。";
  if (prompt.includes("任务：拆分章节"))
    output =
      "## 第三章 雾中足迹\n追查来信来源。\n\n## 第四章 钟楼\n揭开时钟停止的原因。";
  for (const chunk of output.match(/[\s\S]{1,5}/gu) || []) {
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`,
    );
    await new Promise((r) => setTimeout(r, 12));
  }
  res.end("data: [DONE]\n\n");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const env = { ...process.env, MOYE_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
let app;
async function poll(page, fn) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await page.evaluate(fn)) return;
    await page.waitForTimeout(80);
  }
  throw new Error("Timed out waiting for persisted state: " + String(fn));
}
const launch = async () => {
  app = await electron.launch({ args: ["."], env, timeout: 30000 });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  page.setDefaultTimeout(15000);
  return page;
};
const button = (p, name) => p.getByRole("button", { name, exact: true });
try {
  let page = await launch();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await button(page, "创建新作品").click();
  await page.getByLabel("作品名称", { exact: true }).fill("端到端验证");
  await button(page, "开始创作").click();
  await page
    .getByLabel("章节正文", { exact: true })
    .fill("这是需要保留的原稿。");
  await poll(page, async () => {
    const b = (await window.moye.listBooks())[0];
    return b?.chapters[0]?.body === "这是需要保留的原稿。";
  });
  await page.getByRole("button", { name: /故事设定/ }).click();
  await button(page, "添加设定").click();
  await page.getByLabel("名称", { exact: true }).fill("林舟");
  await page.getByLabel("详细设定").fill("邮差，谨慎而好奇。");
  await page.getByRole("button", { name: "大纲规划", exact: true }).click();
  await page
    .getByLabel("全书情节脉络")
    .fill("邮差循着一封来信，探索城市被遗忘的历史。");
  await button(page, "添加分卷").click();
  await page.getByLabel("分卷名称").fill("第一卷 来信");
  await page.getByLabel("这一卷的故事走向").fill("发现异常来信，开始调查。");
  await page.getByRole("button", { name: /正文创作/ }).click();
  await page.getByLabel("章节所属分卷").selectOption({ label: "第一卷 来信" });
  // Configure a real HTTP mock through the UI, exercising preload + main-process adapters.
  await page.getByTitle("AI 连接与偏好", { exact: true }).click();
  await button(page, "添加第一个连接").click();
  await page.getByLabel("服务商").selectOption("custom");
  await page.getByLabel("连接名称").fill("本地模拟");
  await page.getByLabel("API 基础地址").fill(`http://127.0.0.1:${port}/v1`);
  await page.getByLabel("模型名称").fill("mock");
  await button(page, "保存并测试").click();
  await page.getByText("连接成功，已收到模型响应。", { exact: true }).waitFor();
  await page
    .getByRole("dialog", { name: "AI 连接与偏好" })
    .getByLabel("关闭窗口")
    .click();
  await button(page, "开始生成").click();
  await page.getByLabel("AI 候选稿").waitFor();
  await button(page, "替换目标内容").waitFor({ state: "visible" });
  await page.waitForFunction(
    () => !document.querySelector(".candidate-text")?.readOnly,
  );
  assert.equal(
    await page.getByLabel("章节正文", { exact: true }).inputValue(),
    "这是需要保留的原稿。",
  );
  // Change the manuscript during a candidate's lifetime and require explicit conflict resolution.
  await page
    .getByLabel("章节正文", { exact: true })
    .fill("作者在生成后写下的新内容。");
  await button(page, "替换目标内容").click();
  await page.getByRole("dialog", { name: "请确认" }).waitFor();
  await button(page, "取消").click();
  assert.equal(
    await page.getByLabel("章节正文", { exact: true }).inputValue(),
    "作者在生成后写下的新内容。",
  );
  await button(page, "替换目标内容").click();
  await button(page, "确认").click();
  await page.waitForFunction(() =>
    document
      .querySelector('[aria-label="章节正文"]')
      ?.value.includes("别相信明天"),
  );
  // Selection rewriting through the editor.
  await page.getByLabel("章节正文", { exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("ArrowLeft");
  for (let i = 0; i < 8; i++) await page.keyboard.press("Shift+ArrowRight");
  await button(page, "润色选段").click();
  await button(page, "开始生成").click();
  await page.waitForFunction(
    () =>
      document.querySelector(".candidate-text")?.value ===
        "清晨的风悄然穿过旧邮局。" &&
      !document.querySelector(".candidate-text")?.readOnly,
  );
  await button(page, "替换选段").click();
  await page.waitForFunction(() =>
    document
      .querySelector('[aria-label="章节正文"]')
      ?.value.startsWith("清晨的风"),
  );
  // Summary generation and staleness after editing.
  await button(page, "生成章节摘要").click();
  await button(page, "开始生成").click();
  await page.waitForFunction(
    () =>
      document.querySelector(".candidate-text")?.value.includes("新的悬念") &&
      !document.querySelector(".candidate-text")?.readOnly,
  );
  await page
    .getByLabel("章节正文", { exact: true })
    .fill("生成摘要以后作者修改了正文。");
  await button(page, "替换目标内容").click();
  await page.getByRole("button", { name: "章节摘要", exact: true }).click();
  await page.getByText(/正文已修改，此摘要已过期/).waitFor();
  await page.getByLabel("章节摘要", { exact: true }).waitFor();
  assert.match(
    await page.getByLabel("章节摘要", { exact: true }).inputValue(),
    /林舟/,
  );
  await button(page, "正文").click();
  await page.getByLabel("章节正文", { exact: true }).fill("修改后的正文。");
  await page.getByRole("button", { name: "章节摘要", exact: true }).click();
  await page.getByText(/正文已修改，此摘要已过期/).waitFor();
  await button(page, "正文").click();
  // Simulate a disk failure. Unsaved text must remain editable and retryable.
  await app.evaluate(() => {
    const fs = process.getBuiltinModule("fs");
    global.__moyeRename = fs.renameSync;
    fs.renameSync = (...args) => {
      if (String(args[1]).endsWith("moye.sqlite"))
        throw new Error("模拟磁盘写入失败");
      return global.__moyeRename(...args);
    };
  });
  await page
    .getByLabel("章节正文", { exact: true })
    .fill("磁盘失败时仍保留的正文。");
  await page.getByRole("button", { name: /保存失败/ }).waitFor();
  assert.equal(
    await page.getByLabel("章节正文", { exact: true }).inputValue(),
    "磁盘失败时仍保留的正文。",
  );
  await app.evaluate(() => {
    process.getBuiltinModule("fs").renameSync = global.__moyeRename;
  });
  await page.getByRole("button", { name: /保存失败/ }).click();
  await poll(
    page,
    async () =>
      (await window.moye.listBooks())[0].chapters[0].body ===
      "磁盘失败时仍保留的正文。",
  );
  await page.getByRole("alert").getByRole("button").click();
  // Native export dialogs are redirected only for this test.
  const exportPath = path.join(data, "export.md"),
    backupPath = path.join(data, "backup.moye.json"),
    inputPath = path.join(data, "import.txt");
  fs.writeFileSync(
    inputPath,
    "第三章 导入一\n新增章节正文\n第四章 导入二\n另一章正文",
  );
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, exportPath);
  await page.getByTitle("导出作品", { exact: true }).click();
  await page.getByLabel("导出格式").selectOption("md");
  await button(page, "导出整部作品").click();
  await page.waitForTimeout(200);
  assert.match(fs.readFileSync(exportPath, "utf8"), /磁盘失败时仍保留/);
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, inputPath);
  await page.getByTitle("更多作品操作").click();
  await button(page, "导入章节").click();
  await page.getByRole("dialog", { name: "预览导入章节" }).waitFor();
  await page
    .getByRole("button", { name: "确认导入 2 章", exact: true })
    .click();
  await poll(
    page,
    async () => (await window.moye.listBooks())[0].chapters.length === 3,
  );
  await page.getByRole("button", { name: "大纲规划", exact: true }).click();
  await page.getByLabel("正在编辑").selectOption("synopsis");
  await button(page, "拆分章节").click();
  await button(page, "开始生成").click();
  await page.waitForFunction(
    () =>
      document.querySelector(".candidate-text")?.value.includes("时钟停止") &&
      !document.querySelector(".candidate-text")?.readOnly,
  );
  await button(page, "确认创建章节").click();
  await button(page, "确认").click();
  await poll(
    page,
    async () => (await window.moye.listBooks())[0].chapters.length === 5,
  );
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, backupPath);
  await page.getByTitle("更多作品操作").click();
  await button(page, "备份作品与历史").click();
  await page.waitForTimeout(250);
  const backup = JSON.parse(fs.readFileSync(backupPath, "utf8"));
  assert.equal(backup.book.chapters.length, 5);
  assert(backup.versions.length >= 5);
  assert.equal(backup.connections, undefined);
  await page.getByTitle("版本记录").click();
  await page.getByRole("dialog", { name: "作品版本记录" }).waitFor();
  await page.getByRole("button", { name: "恢复", exact: true }).last().click();
  await button(page, "确认").click();
  await poll(
    page,
    async () =>
      (await window.moye.listBooks())[0].chapters[0].body ===
      "作者在生成后写下的新内容。",
  );
  await button(page, "返回书架").click();
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, backupPath);
  await page.getByTitle("恢复作品备份").click();
  await poll(page, async () => (await window.moye.listBooks()).length === 2);
  await button(page, "返回书架").click();
  await app.close();
  page = await launch();
  await page.getByRole("button", { name: /端到端验证（恢复副本）/ }).waitFor();
  assert.equal(
    await page.evaluate(async () => (await window.moye.listBooks()).length),
    2,
  );
  // An authored example makes the screenshot useful for visual QA.
  await page.evaluate(async () => {
    for (const b of await window.moye.listBooks())
      await window.moye.deleteBook(b.id);
  });
  await page.reload();
  await button(page, "探索示例").click();
  await page.getByLabel("章节正文", { exact: true }).waitFor();
  await page.waitForFunction(() =>
    document
      .querySelector('[aria-label="章节正文"]')
      ?.value.includes("雾还没有散"),
  );
  await page.screenshot({ path: "test-results/workspace.png" });
  await button(page, "返回书架").click();
  await page.getByRole("button", { name: /MOYE ORIGINAL/ }).waitFor();
  await page.screenshot({ path: "test-results/library.png" });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: desktop UI, local save, settings/outline, AI test & streaming, acceptance/conflict, selection rewrite, summaries, disk failure recovery, import/export, snapshots, backup/restore, restart persistence.",
  );
} catch (error) {
  console.error(error);
  if (app) {
    const p = await app.firstWindow();
    await p.screenshot({ path: "test-results/failure.png" }).catch(() => {});
    console.error((await p.locator("body").innerText()).slice(-8000));
  }
  throw error;
} finally {
  if (app) await app.close().catch(() => {});
  server.closeAllConnections();
  server.close();
  if (!process.env.MOYE_KEEP_TEST_DATA)
    fs.rmSync(data, { recursive: true, force: true });
}
