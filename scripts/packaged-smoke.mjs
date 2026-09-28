import { _electron as electron } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
const executablePath =
  process.argv[2] ||
  path.resolve("release/mac-arm64/墨页.app/Contents/MacOS/墨页");
const data = fs.mkdtempSync(path.join(os.tmpdir(), "moye-packaged-"));
const env = { ...process.env, MOYE_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
let instance;
try {
  instance = await electron.launch({
    executablePath,
    args: [],
    env,
    timeout: 30000,
  });
  let page = await instance.firstWindow();
  await page.getByRole("button", { name: "创建新作品", exact: true }).waitFor();
  const metadata = await instance.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    name: app.getName(),
    version: app.getVersion(),
    arch: process.arch,
  }));
  assert.equal(metadata.packaged, true);
  await page.getByRole("button", { name: "创建新作品", exact: true }).click();
  await page.getByLabel("作品名称", { exact: true }).fill("安装包验证");
  await page.getByRole("button", { name: "开始创作", exact: true }).click();
  await page
    .getByLabel("章节正文", { exact: true })
    .fill("安装包内的 SQLite 与编辑器工作正常。");
  // Closing immediately must flush the pending one-second autosave.
  await instance.close();
  instance = await electron.launch({
    executablePath,
    args: [],
    env,
    timeout: 30000,
  });
  page = await instance.firstWindow();
  await page
    .getByRole("button", { name: /安装包验证.*MOYE ORIGINAL/ })
    .waitFor();
  const books = await page.evaluate(() => window.moye.listBooks());
  assert.equal(
    books[0].chapters[0].body,
    "安装包内的 SQLite 与编辑器工作正常。",
  );
  await page.getByRole("button", { name: /安装包验证.*MOYE ORIGINAL/ }).click();
  await page.getByLabel("章节正文", { exact: true }).waitFor();
  await page.getByTitle("切换主题").click();
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  await instance.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1060, 720),
  );
  await page.screenshot({ path: "test-results/packaged-dark-compact.png" });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  assert.equal(overflow, false);
  console.log(
    "PASS: packaged launch, bundled SQLite WASM, close-flush and restart persistence, dark theme, minimum window width.",
    metadata,
  );
} finally {
  if (instance) await instance.close().catch(() => {});
  fs.rmSync(data, { recursive: true, force: true });
}
