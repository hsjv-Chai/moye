import { app, BrowserWindow, dialog, ipcMain, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { Store } from "./store";
import { streamAI } from "./ai";
import {
  idSchema,
  bookSchema,
  draftSchema,
  generationSchema,
  splitChapters,
  exportText,
} from "../shared/model";
if (process.env.MOYE_DATA_DIR)
  app.setPath("userData", path.resolve(process.env.MOYE_DATA_DIR));
let window: BrowserWindow,
  store: Store,
  allowClose = false;
const runs = new Map<
  string,
  { controller: AbortController; done: Promise<void> }
>();
const single = app.requestSingleInstanceLock();
if (!single) app.quit();
app.on("second-instance", () => {
  window?.show();
  window?.focus();
});
const cleanName = (s: string) =>
  s.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 100) || "作品";
function register() {
  const handle = (name: string, fn: (...args: any[]) => unknown) =>
    ipcMain.handle(`moye:${name}`, (event, ...args) => {
      if (
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error("非法请求来源");
      return fn(...args);
    });
  handle("listBooks", () => store.listBooks());
  handle("saveBook", (b) => store.saveBook(bookSchema.parse(b)));
  handle("deleteBook", (id) => store.deleteBook(idSchema.parse(id)));
  handle("snapshot", (id, reason) =>
    store.snapshot(idSchema.parse(id), z.string().max(200).parse(reason)),
  );
  handle("versions", (id) => store.versions(idSchema.parse(id)));
  handle("restoreVersion", (bookId, id) =>
    store.restoreVersion(idSchema.parse(bookId), idSchema.parse(id)),
  );
  handle("connections", () => store.connections());
  handle("saveConnection", (c, key) =>
    store.saveConnection(c, z.string().max(10000).optional().parse(key)),
  );
  handle("removeConnection", (id) =>
    store.removeConnection(idSchema.parse(id)),
  );
  handle("preferences", () => store.preferences());
  handle("savePreferences", (p) => store.savePreferences(p));
  handle("drafts", (id) => store.drafts(idSchema.parse(id)));
  handle("saveDraft", (d) => store.saveDraft(draftSchema.parse(d)));
  handle("deleteDraft", (id) => store.deleteDraft(idSchema.parse(id)));
  handle("testConnection", async (id) => {
    const { connection, key } = store.credentials(idSchema.parse(id));
    await streamAI(
      { ...connection, outputTokens: 256 },
      key,
      "请只回复：连接成功。",
      new AbortController().signal,
      () => {},
      20000,
    );
    return "连接成功，已收到模型响应。";
  });
  handle("generate", (g) => {
    const input = generationSchema.parse(g);
    if (runs.size) throw new Error("已有生成任务正在运行");
    const { connection, key } = store.credentials(input.connectionId);
    const draft = store.drafts(input.bookId).find((d) => d.id === input.id);
    if (!draft) throw new Error("请先保存候选稿");
    const controller = new AbortController();
    let lastSave = Date.now();
    const send = (event: unknown) => {
      if (!window.isDestroyed()) window.webContents.send("moye:ai", event);
    };
    const done = (async () => {
      try {
        await streamAI(
          connection,
          key,
          input.prompt,
          controller.signal,
          (chunk) => {
            draft.text += chunk;
            send({ id: input.id, type: "chunk", text: chunk });
            if (Date.now() - lastSave > 1000) {
              store.saveDraft(draft);
              lastSave = Date.now();
            }
          },
        );
        draft.status = controller.signal.aborted ? "stopped" : "complete";
        store.saveDraft(draft);
        send({
          id: input.id,
          type: "done",
          stopped: controller.signal.aborted,
        });
      } catch (e) {
        draft.status = "error";
        let message = e instanceof Error ? e.message : "生成失败";
        try {
          store.saveDraft(draft);
        } catch {
          message += "；候选稿保存失败，请复制内容后重试。";
        }
        send({ id: input.id, type: "error", text: message });
      } finally {
        runs.delete(input.id);
      }
    })();
    runs.set(input.id, { controller, done });
  });
  handle("cancel", async (id) => {
    const run = runs.get(idSchema.parse(id));
    if (run) {
      run.controller.abort();
      await run.done;
    }
  });
  handle("importText", async () => {
    const result = await dialog.showOpenDialog(window, {
      title: "导入小说文本",
      properties: ["openFile"],
      filters: [{ name: "小说文本", extensions: ["txt", "md", "markdown"] }],
    });
    if (result.canceled) return null;
    const file = result.filePaths[0];
    if (fs.statSync(file).size > 50 * 1024 * 1024)
      throw new Error("文件超过 50 MB，请拆分后导入。");
    const bytes = fs.readFileSync(file);
    let text,
      encoding = "UTF-8";
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      text = new TextDecoder("gb18030", { fatal: true }).decode(bytes);
      encoding = "GB18030";
    }
    return {
      chapters: splitChapters(text),
      name: path.basename(file, path.extname(file)),
      encoding,
    };
  });
  handle("exportText", async (id, ids, format) => {
    const b = store.getBook(idSchema.parse(id));
    const selected = z.array(idSchema).parse(ids);
    const f = z.enum(["txt", "md"]).parse(format);
    const result = await dialog.showSaveDialog(window, {
      title: "导出小说",
      defaultPath: `${cleanName(b.title)}.${f}`,
      filters: [{ name: f.toUpperCase(), extensions: [f] }],
    });
    if (result.canceled || !result.filePath) return false;
    fs.writeFileSync(
      result.filePath,
      exportText(b, selected, f === "md"),
      "utf8",
    );
    return true;
  });
  handle("backup", async (id) => {
    const b = store.getBook(idSchema.parse(id));
    const result = await dialog.showSaveDialog(window, {
      title: "备份作品与版本",
      defaultPath: `${cleanName(b.title)}.moye.json`,
      filters: [{ name: "墨页备份", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) return false;
    fs.writeFileSync(result.filePath, store.backup(b.id), "utf8");
    return true;
  });
  handle("restoreBackup", async () => {
    const result = await dialog.showOpenDialog(window, {
      title: "恢复作品备份",
      properties: ["openFile"],
      filters: [{ name: "墨页备份", extensions: ["json"] }],
    });
    if (result.canceled) return null;
    const file = result.filePaths[0];
    if (fs.statSync(file).size > 200 * 1024 * 1024)
      throw new Error("备份文件超过 200 MB。");
    return store.importBackup(fs.readFileSync(file, "utf8"));
  });
  ipcMain.on("moye:closeReady", async (event) => {
    if (event.sender !== window.webContents) return;
    for (const run of runs.values()) run.controller.abort();
    await Promise.all([...runs.values()].map((r) => r.done));
    allowClose = true;
    window.close();
  });
}
if (single)
  app
    .whenReady()
    .then(async () => {
      const wasm = app.isPackaged
        ? path.join(process.resourcesPath, "sql-wasm.wasm")
        : path.join(app.getAppPath(), "node_modules/sql.js/dist/sql-wasm.wasm");
      store = await Store.open(
        path.join(app.getPath("userData"), "moye.sqlite"),
        wasm,
        {
          available: () => safeStorage.isEncryptionAvailable(),
          encrypt: (s) => safeStorage.encryptString(s).toString("base64"),
          decrypt: (s) => safeStorage.decryptString(Buffer.from(s, "base64")),
        },
      );
      window = new BrowserWindow({
        width: 1440,
        height: 940,
        minWidth: 1060,
        minHeight: 720,
        title: "墨页 · 小说创作",
        backgroundColor: "#f5f4f0",
        webPreferences: {
          preload: path.join(__dirname, "preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      register();
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      window.webContents.session.setPermissionRequestHandler((_wc, _p, cb) =>
        cb(false),
      );
      window.on("close", (event) => {
        if (!allowClose) {
          event.preventDefault();
          window.webContents.send("moye:closing");
        }
      });
      if (!app.isPackaged && process.env.VITE_DEV_SERVER_URL)
        await window.loadURL(process.env.VITE_DEV_SERVER_URL);
      else await window.loadFile(path.join(__dirname, "../dist/index.html"));
    })
    .catch((error) => {
      dialog.showErrorBox(
        "墨页启动失败",
        error instanceof Error ? error.message : "无法打开本地资料库",
      );
      app.exit(1);
    });
app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => store?.close());
