import { contextBridge, ipcRenderer } from "electron";
import type { API } from "../shared/api";
const call = (name: string, ...args: unknown[]) =>
  ipcRenderer.invoke(`moye:${name}`, ...args);
const api: API = {
  listBooks: () => call("listBooks"),
  saveBook: (b) => call("saveBook", b),
  deleteBook: (id) => call("deleteBook", id),
  snapshot: (id, r) => call("snapshot", id, r),
  versions: (id) => call("versions", id),
  restoreVersion: (b, id) => call("restoreVersion", b, id),
  connections: () => call("connections"),
  saveConnection: (c, k) => call("saveConnection", c, k),
  removeConnection: (id) => call("removeConnection", id),
  testConnection: (id) => call("testConnection", id),
  preferences: () => call("preferences"),
  savePreferences: (p) => call("savePreferences", p),
  importText: () => call("importText"),
  exportText: (id, ids, f) => call("exportText", id, ids, f),
  backup: (id) => call("backup", id),
  restoreBackup: () => call("restoreBackup"),
  drafts: (id) => call("drafts", id),
  saveDraft: (d) => call("saveDraft", d),
  deleteDraft: (id) => call("deleteDraft", id),
  generate: (g) => call("generate", g),
  cancel: (id) => call("cancel", id),
  onAI: (fn) => {
    const listener = (_: unknown, event: Parameters<typeof fn>[0]) => fn(event);
    ipcRenderer.on("moye:ai", listener);
    return () => ipcRenderer.removeListener("moye:ai", listener);
  },
  onClosing: (fn) => {
    const listener = () => fn();
    ipcRenderer.on("moye:closing", listener);
    return () => ipcRenderer.removeListener("moye:closing", listener);
  },
  closeReady: () => ipcRenderer.send("moye:closeReady"),
};
contextBridge.exposeInMainWorld("moye", api);
