import * as Y from "yjs";
import WebSocket from "ws";
import { createHash, randomUUID } from "node:crypto";
import { Store } from "./store";
import { bookSchema, type Book, type Draft } from "../shared/model";
import {
  project,
  fields,
  validDoc,
  remapBook,
  type User,
  type Room,
  type RoomEvent,
  type CollabStatus,
  type SharedBook,
  type Structure,
  type AtomicEdit,
} from "../shared/collab";
type Cache = {
  room: Room;
  pending: { id: string; epoch: number; update: string }[];
};
export class CollaborationClient {
  private server = "https://114.215.182.66";
  private token = "";
  private user: User | null = null;
  private online = false;
  private error = "";
  private socket: WebSocket | null = null;
  private active: Cache | null = null;
  private document: Y.Doc | null = null;
  private ready = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private wanted = "";
  private stopping = false;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  constructor(
    private store: Store,
    private emit: (event: RoomEvent) => void,
  ) {
    const session = store.kv<{ server: string; user: User; secret: string }>(
      "session",
    );
    if (session) {
      this.server = session.server;
      this.user = session.user;
      try {
        this.token = store.unprotect(session.secret);
      } catch {
        this.error = "登录凭据无法解密，请重新登录";
      }
    }
  }
  status(): CollabStatus {
    return {
      server: this.server,
      user: this.user,
      online: this.online,
      error: this.error || undefined,
    };
  }
  private state(online: boolean, error = "") {
    this.online = online;
    this.error = error;
    this.emit({ type: "status", status: this.status() });
  }
  private scope() {
    if (!this.user) throw new Error("请先登录协作服务器");
    return createHash("sha256")
      .update(`${this.server}/${this.user.id}`)
      .digest("hex");
  }
  private key(id: string) {
    return `room:${this.scope()}:${id}`;
  }
  private persist() {
    if (this.active && this.document) {
      this.active.room.state = Buffer.from(
        Y.encodeStateAsUpdate(this.document),
      ).toString("base64");
      this.active.room.book = project(this.active.room.book, this.document);
      this.store.putKV(this.key(this.active.room.book.id), this.active);
    }
  }
  private broadcast() {
    if (this.active)
      this.emit({
        type: "room",
        room: this.active.room,
        pending: this.active.pending.length,
      });
  }
  async request(path: string, method = "GET", body?: unknown): Promise<any> {
    if (!this.token) throw new Error("请先登录");
    try {
      const response = await fetch(this.server + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      });
      const data = (await response.json()) as any;
      if (!response.ok) {
        if (response.status === 401) {
          this.state(false, "登录已失效，请重新登录");
          this.closeSocket();
        }
        const e = new Error(data.error || `HTTP ${response.status}`);
        (e as any).status = response.status;
        throw e;
      }
      this.state(true);
      return data;
    } catch (e: any) {
      if (!e.status) this.state(false, "无法连接服务器，修改保存在本机");
      throw e;
    }
  }
  async login(server: string, username: string, password: string) {
    this.leave();
    const url = new URL(server);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      !["https:", "http:"].includes(url.protocol)
    )
      throw new Error("请输入服务器基础地址");
    if (
      url.protocol === "http:" &&
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
      throw new Error("公网协作必须使用 HTTPS");
    const response = await fetch(url.origin + "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    const data = (await response.json()) as any;
    if (!response.ok) throw new Error(data.error || "登录失败");
    this.server = url.origin;
    this.token = data.token;
    this.user = data.user;
    const secret = this.store.protect(this.token);
    if (secret)
      this.store.putKV("session", {
        server: this.server,
        user: this.user,
        secret,
      });
    else this.store.deleteKV("session");
    this.state(true);
    return this.status();
  }
  async logout() {
    if (this.token) await this.request("/api/logout", "POST").catch(() => {});
    this.leave();
    this.token = "";
    this.user = null;
    this.store.deleteKV("session");
    this.state(false);
  }
  async changePassword(oldPassword: string, newPassword: string) {
    await this.request("/api/password", "POST", { oldPassword, newPassword });
    this.user = (await this.request("/api/me")).user;
    const secret = this.store.protect(this.token);
    if (secret)
      this.store.putKV("session", {
        server: this.server,
        user: this.user,
        secret,
      });
    this.state(true);
  }
  async books(): Promise<SharedBook[]> {
    try {
      this.user = (await this.request("/api/me")).user;
      if (this.user!.mustChangePassword) return [];
      const books = await this.request("/api/books");
      this.store.putKV(`books:${this.scope()}`, books);
      return books;
    } catch (e: any) {
      if (e.status && e.status < 500 && e.status !== 429) throw e;
      return this.store.kv<SharedBook[]>(`books:${this.scope()}`) || [];
    }
  }
  async publish(book: Book) {
    return this.request("/api/books", "POST", bookSchema.parse(book));
  }
  async open(id: string): Promise<Room> {
    this.leave();
    this.wanted = id;
    const cached = this.store.kv<Cache>(this.key(id));
    if (cached) {
      this.active = cached;
      this.document = new Y.Doc();
      Y.applyUpdate(this.document, Buffer.from(cached.room.state, "base64"));
    }
    try {
      const fresh =
        cached && this.document
          ? await this.request(`/api/books/${id}/sync`, "POST", {
              epoch: cached.room.epoch,
              revision: cached.room.revision,
              vector: Buffer.from(Y.encodeStateVector(this.document)).toString(
                "base64",
              ),
            })
          : await this.request(`/api/books/${id}`);
      this.acceptRoom(fresh);
    } catch (e: any) {
      const denied = [401, 403, 404].includes(e.status);
      if (!cached || denied) {
        if (cached && denied) this.recover("作品权限或状态已变化");
        throw e;
      }
      this.broadcast();
    }
    this.connect();
    if (!this.active) throw new Error("此作品尚未缓存，请联网打开");
    return this.active.room;
  }
  private recover(message: string) {
    if (this.active?.pending.length && this.document) {
      const copy = remapBook(project(this.active.room.book, this.document));
      copy.title += "（离线恢复副本）";
      this.store.saveBook(copy);
      this.emit({
        type: "recovery",
        message: message + "，未同步内容已保存到个人书架",
        bookId: copy.id,
      });
      this.active.pending = [];
      this.persist();
    }
  }
  private acceptRoom(room: Room) {
    if (!this.active || this.active.room.book.id !== room.book.id) {
      this.document?.destroy();
      this.document = new Y.Doc();
      Y.applyUpdate(this.document, Buffer.from(room.state, "base64"));
      this.active = { room, pending: [] };
    } else {
      const previous = this.document!;
      if (
        this.active.room.epoch !== room.epoch ||
        (room.role === "reader" && this.active.pending.length) ||
        (this.active.pending.length > 0 &&
          [...fields(this.active.room.book).keys()].some(
            (key) => !fields(room.book).has(key),
          ))
      ) {
        this.recover("共享版本或编辑权限已变化");
        this.document = new Y.Doc();
        Y.applyUpdate(this.document, Buffer.from(room.state, "base64"));
        this.active = { room, pending: [] };
        previous.destroy();
      } else {
        const merged = new Y.Doc();
        Y.applyUpdate(merged, Buffer.from(room.state, "base64"));
        try {
          Y.applyUpdate(merged, Y.encodeStateAsUpdate(previous));
          validDoc(room.book, merged);
          this.document = merged;
          this.active.room = room;
          previous.destroy();
        } catch {
          merged.destroy();
          this.recover("章节或设定已被删除");
          this.document = new Y.Doc();
          Y.applyUpdate(this.document, Buffer.from(room.state, "base64"));
          this.active = { room, pending: [] };
          previous.destroy();
        }
      }
    }
    this.persist();
    this.broadcast();
  }
  private connect() {
    if (!this.wanted || !this.token || this.stopping) return;
    this.closeSocket();
    const generation = this.wanted;
    const vector = this.document
      ? Buffer.from(Y.encodeStateVector(this.document)).toString("base64")
      : "";
    const socket = new WebSocket(
      this.server.replace(/^http/, "ws") + "/sync/" + generation,
      {
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(vector && vector.length <= 6000 && this.active
            ? {
                "X-Moye-Vector": vector,
                "X-Moye-Epoch": String(this.active.room.epoch),
                "X-Moye-Revision": String(this.active.room.revision),
              }
            : {}),
        },
        handshakeTimeout: 15000,
        maxPayload: 25 * 1024 * 1024,
        followRedirects: false,
      },
    );
    this.socket = socket;
    this.ready = false;
    this.state(false, "正在连接协作服务，修改已保存本机");
    socket.on("message", (raw) => {
      if (this.socket !== socket) return;
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === "ready" || message.type === "room") {
          this.acceptRoom(message.room);
          this.ready = true;
          this.reconnectAttempt = 0;
          this.state(true);
          this.sendPending();
        } else if (message.type === "update") {
          if (!this.active || !this.document) return;
          if (message.epoch !== this.active.room.epoch) {
            socket.close();
            return;
          }
          Y.applyUpdate(this.document, Buffer.from(message.update, "base64"));
          this.persist();
          this.emit({
            type: "update",
            bookId: this.active.room.book.id,
            update: message.update,
            pending: this.active.pending.length,
          });
        } else if (message.type === "ack") {
          if (!this.active) return;
          this.active.pending = this.active.pending.filter(
            (p) => p.id !== message.id,
          );
          this.persist();
          this.emit({
            type: "update",
            bookId: this.active.room.book.id,
            update: "",
            pending: this.active.pending.length,
          });
        } else if (message.type === "peers") {
          this.emit({ type: "peers", peers: message.peers });
        } else if (message.type === "denied") {
          this.ready = false;
          this.recover(message.message);
          this.state(false, message.message);
          this.wanted = "";
          if (this.active) {
            this.active.room.role = "reader";
            this.persist();
            this.broadcast();
          }
          socket.close();
          this.emit({ type: "error", message: message.message });
        } else if (message.type === "rejected") {
          this.ready = false;
          if (message.recover) this.recover(message.message);
          this.emit({ type: "error", message: message.message });
          socket.close();
        }
      } catch (e) {
        this.ready = false;
        this.state(false, "本地保存或同步失败，保留窗口内容后重试");
        this.emit({ type: "error", message: String(e) });
        socket.close();
      }
    });
    socket.on("error", () => {
      if (this.socket === socket) this.state(false, "连接异常，修改保存在本机");
    });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.ready = false;
      this.state(false, this.error || "离线编辑，联网后自动同步");
      if (this.wanted && !this.stopping) {
        const delay = Math.min(1000 * 2 ** this.reconnectAttempt++, 15000);
        this.retry = setTimeout(() => this.connect(), delay);
      }
    });
    this.heartbeat = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: "ping" }));
    }, 20000);
    this.heartbeat.unref();
  }
  private sendPending() {
    if (this.ready && this.socket?.readyState === WebSocket.OPEN)
      for (const op of this.active?.pending || [])
        this.socket.send(JSON.stringify({ type: "update", ...op }));
  }
  async update(id: string, epoch: number, update: string) {
    if (
      !this.active ||
      !this.document ||
      this.active.room.book.id !== id ||
      epoch !== this.active.room.epoch
    )
      throw new Error("作品状态已变化，请重新打开");
    if (this.active.room.role === "reader") throw new Error("只读作品不可修改");
    const before = Y.encodeStateAsUpdate(this.document);
    const pending = [...this.active.pending];
    try {
      Y.applyUpdate(this.document, Buffer.from(update, "base64"));
      validDoc(this.active.room.book, this.document);
      const op = { id: randomUUID(), epoch, update };
      this.active.pending.push(op);
      this.persist();
      this.emit({
        type: "update",
        bookId: id,
        update: "",
        pending: this.active.pending.length,
      });
      if (this.ready && this.socket?.readyState === WebSocket.OPEN)
        this.socket.send(JSON.stringify({ type: "update", ...op }));
    } catch (e) {
      this.document.destroy();
      this.document = new Y.Doc();
      Y.applyUpdate(this.document, before);
      this.active.pending = pending;
      throw e;
    }
  }
  presence(field: string, awareness?: string) {
    if (this.ready && this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify({ type: "presence", field, awareness }));
  }
  async flush() {
    const until = Date.now() + 15000;
    while (this.active?.pending.length) {
      if (!this.ready) throw new Error("请等待协作连接恢复后再执行此操作");
      if (Date.now() > until) throw new Error("同步尚未完成，请稍后重试");
      await new Promise((r) => setTimeout(r, 40));
    }
  }
  async structure(
    id: string,
    epoch: number,
    revision: number,
    action: Structure,
  ) {
    await this.flush();
    const room = await this.request(`/api/books/${id}/structure`, "POST", {
      epoch,
      revision,
      action,
    });
    this.acceptRoom(room);
    return room;
  }
  async atomic(id: string, epoch: number, edit: AtomicEdit) {
    await this.flush();
    const room = await this.request(`/api/books/${id}/edit`, "POST", {
      epoch,
      edit,
    });
    this.acceptRoom(room);
    return room;
  }
  async restore(id: string, versionId: string) {
    await this.flush();
    const room = await this.request(`/api/books/${id}/restore`, "POST", {
      versionId,
    });
    this.acceptRoom(room);
    return room;
  }
  private closeSocket() {
    if (this.retry) clearTimeout(this.retry);
    if (this.heartbeat) clearInterval(this.heartbeat);
    const s = this.socket;
    this.socket = null;
    s?.close();
    this.ready = false;
  }
  leave() {
    this.wanted = "";
    this.closeSocket();
    this.document?.destroy();
    this.document = null;
    this.active = null;
  }
  stop() {
    this.stopping = true;
    this.leave();
  }
  cachedBook(id: string): Book | null {
    if (!this.user) return null;
    if (this.active?.room.book.id === id && this.document)
      return project(this.active.room.book, this.document);
    return this.store.kv<Cache>(this.key(id))?.room.book || null;
  }
  saveDraft(d: Draft) {
    if (!this.cachedBook(d.bookId)) throw new Error("作品未缓存");
    this.store.putKV(`draft:${this.scope()}:${d.id}`, d);
  }
  drafts(id: string) {
    return this.store
      .listKV<Draft>(`draft:${this.scope()}:`)
      .filter((d) => d.bookId === id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  deleteDraft(id: string) {
    if (this.user) this.store.deleteKV(`draft:${this.scope()}:${id}`);
  }
}
