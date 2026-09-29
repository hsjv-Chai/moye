import { contextBridge, ipcRenderer } from "electron";
import type { API } from "../shared/api";
const call = (name: string, ...args: unknown[]) =>
  ipcRenderer.invoke(`moye:${name}`, ...args);
const api: API = {
  collab: {
    status: () => call("collab:status"),
    login: (server, username, password) =>
      call("collab:login", server, username, password),
    logout: () => call("collab:logout"),
    changePassword: (oldPassword, newPassword) =>
      call("collab:password", oldPassword, newPassword),
    books: () => call("collab:books"),
    publish: (book) => call("collab:publish", book),
    open: (id) => call("collab:open", id),
    leave: () => call("collab:leave"),
    update: (id, epoch, update) => call("collab:update", id, epoch, update),
    presence: (field, awareness) => call("collab:presence", field, awareness),
    flush: () => call("collab:flush"),
    structure: (id, epoch, revision, action) =>
      call("collab:structure", id, epoch, revision, action),
    atomic: (id, epoch, edit) => call("collab:atomic", id, epoch, edit),
    deleteBook: (id) => call("collab:delete", id),
    users: () => call("collab:users"),
    createUser: (input) => call("collab:createUser", input),
    updateUser: (id, patch) => call("collab:updateUser", id, patch),
    members: (id) => call("collab:members", id),
    setMember: (id, userId, role) => call("collab:setMember", id, userId, role),
    versions: (id) => call("collab:versions", id),
    snapshot: (id) => call("collab:snapshot", id),
    restore: (id, versionId) => call("collab:restore", id, versionId),
    onEvent: (fn) => {
      const listener = (_: unknown, event: Parameters<typeof fn>[0]) =>
        fn(event);
      ipcRenderer.on("moye:collab", listener);
      return () => ipcRenderer.removeListener("moye:collab", listener);
    },
  },
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
