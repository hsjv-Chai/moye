import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import {
  Users,
  ArrowLeft,
  Plus,
  Cloud,
  CloudOff,
  Settings2,
  BookOpen,
  History,
  Download,
  Upload,
  Trash2,
  ArrowUp,
  ArrowDown,
  Sparkles,
  Network,
  Layers,
  FileText,
  LogOut,
  ShieldCheck,
  Sun,
  Moon,
  Maximize2,
  Minimize2,
  Search,
} from "lucide-react";
import {
  newBook,
  newChapter,
  uid,
  orderedChapters,
  wordCount,
  fingerprint,
  type Book,
  type Connection,
  type Preferences,
  type Target,
  type Draft,
  type ImportChapter,
} from "../shared/model";
import {
  project,
  targetField,
  type CollabStatus,
  type SharedBook,
  type Room,
  type Peer,
  type Structure,
  type SharedVersion,
  type AtomicEdit,
} from "../shared/collab";
import SharedEditor, { toBase64, fromBase64 } from "./SharedEditor";
import { Modal, Empty, date } from "./components";
import Settings from "./Settings";
import { UserManagement, MemberManagement } from "./UserManagement";
import AIPanel from "./AIPanel";
const api = () => window.moye.collab;
const initialStatus: CollabStatus = {
  server: "https://114.215.182.66",
  user: null,
  online: false,
};
export default function Collaboration({
  onBack,
  prefs,
  onPrefs,
  connections,
  onConnections,
}: {
  onBack: () => void;
  prefs: Preferences;
  onPrefs: (p: Preferences) => Promise<void>;
  connections: Connection[];
  onConnections: (c: Connection[]) => void;
}) {
  const [status, setStatus] = useState(initialStatus),
    [server, setServer] = useState(initialStatus.server),
    [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [newPassword, setNewPassword] = useState(""),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [books, setBooks] = useState<SharedBook[]>([]),
    [room, setRoom] = useState<Room | null>(null),
    [book, setBook] = useState<Book | null>(null),
    [doc, setDoc] = useState<Y.Doc | null>(null),
    [pending, setPending] = useState(0),
    [peers, setPeers] = useState<Peer[]>([]),
    [target, setTarget] = useState<Target>({ kind: "synopsis", id: "" }),
    [view, setView] = useState<"overview" | "text">("text"),
    [selection, setSelection] = useState<{ start: number; end: number } | null>(
      null,
    ),
    [aiOpen, setAiOpen] = useState(true),
    [aiBusy, setAiBusy] = useState(false),
    [focus, setFocus] = useState(false);
  const [modal, setModal] = useState<
      | "users"
      | "members"
      | "versions"
      | "create"
      | "publish"
      | "import"
      | "export"
      | null
    >(null),
    [settingsOpen, setSettingsOpen] = useState(false),
    [versions, setVersions] = useState<SharedVersion[]>([]),
    [personal, setPersonal] = useState<Book[]>([]),
    [title, setTitle] = useState(""),
    [imported, setImported] = useState<ImportChapter[]>([]),
    [exportIds, setExportIds] = useState<string[]>([]),
    [exportFormat, setExportFormat] = useState<"txt" | "md">("txt"),
    [find, setFind] = useState(""),
    [replacement, setReplacement] = useState(""),
    [findOpen, setFindOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    text: string;
    resolve: (ok: boolean) => void;
  } | null>(null);
  const active = useRef<Room | null>(null),
    documentRef = useRef<Y.Doc | null>(null),
    localWrites = useRef<Promise<unknown>[]>([]),
    failedUpdates = useRef<{ epoch: number; update: string; id: string }[]>([]),
    remoteQueue = useRef<(() => void)[]>([]),
    composing = useRef(false),
    closing = useRef(false);
  const safe = async (fn: () => Promise<unknown>) => {
    try {
      setError("");
      await fn();
    } catch (e) {
      setError(String(e));
    }
  };
  const confirm = (text: string) =>
    new Promise<boolean>((resolve) => setConfirmation({ text, resolve }));
  const refresh = async () => {
    setBooks(await api().books());
  };
  const flushLocal = async () => {
    await Promise.all(localWrites.current);
    if (failedUpdates.current.length) {
      const ops = [...failedUpdates.current];
      for (const op of ops) {
        await api().update(op.id, op.epoch, op.update);
        failedUpdates.current = failedUpdates.current.filter((x) => x !== op);
      }
    }
  };
  const flush = async () => {
    await flushLocal();
    await api().flush();
  };
  const install = (next: Room) => {
    let d = documentRef.current;
    const previous = active.current;
    const reset =
      !d || previous?.book.id !== next.book.id || previous.epoch !== next.epoch;
    if (reset) {
      d?.destroy();
      d = new Y.Doc();
      Y.applyUpdate(d, fromBase64(next.state), "remote");
      const owned = d;
      d.on("update", (update: Uint8Array, origin: unknown) => {
        if (origin === "remote") return;
        const current = active.current;
        if (!current) return;
        const op = {
          id: current.book.id,
          epoch: current.epoch,
          update: toBase64(update),
        };
        setPending((n) => n + 1);
        const saving = api()
          .update(op.id, op.epoch, op.update)
          .catch((e) => {
            failedUpdates.current.push(op);
            setError(
              "本机保存失败，内容仍在窗口中。请点击同步状态重试。" + String(e),
            );
          })
          .finally(() => {
            localWrites.current = localWrites.current.filter(
              (p) => p !== saving,
            );
          });
        localWrites.current.push(saving);
        setBook(project(current.book, owned));
      });
      documentRef.current = d;
      setDoc(d);
      setSelection(null);
      setTarget({ kind: "body", id: orderedChapters(next.book)[0]?.id || "" });
      setView("text");
    } else Y.applyUpdate(d!, fromBase64(next.state), "remote");
    active.current = next;
    setRoom(next);
    setBook(project(next.book, d!));
  };
  useEffect(() => {
    let disposed = false;
    api()
      .status()
      .then((s) => {
        if (disposed) return;
        setStatus(s);
        setServer(s.server);
        if (s.user) void refresh().catch((e) => setError(String(e)));
      });
    const unsubscribe = api().onEvent((event) => {
      const work = () => {
        if (event.type === "status") setStatus(event.status);
        else if (event.type === "room") {
          install(event.room);
          setPending(event.pending);
        } else if (event.type === "update") {
          const d = documentRef.current,
            current = active.current;
          if (!d || !current || current.book.id !== event.bookId) return;
          if (event.update)
            Y.applyUpdate(d, fromBase64(event.update), "remote");
          setBook(project(current.book, d));
          setPending(event.pending);
        } else if (event.type === "peers") setPeers(event.peers);
        else if (event.type === "recovery") setMessage(event.message);
        else if (event.type === "error") setError(event.message);
      };
      if (
        composing.current &&
        (event.type === "update" || event.type === "room")
      )
        remoteQueue.current.push(work);
      else work();
    });
    const close = window.moye.onClosing(() => {
      closing.current = true;
      void flushLocal()
        .then(() => window.moye.closeReady())
        .catch((e) => {
          closing.current = false;
          setError(String(e));
        });
    });
    return () => {
      disposed = true;
      unsubscribe();
      close();
      documentRef.current?.destroy();
      void api().leave();
    };
  }, []);
  const open = async (id: string) => {
    await flushLocal();
    const next = await api().open(id);
    install(next);
  };
  const leave = async () => {
    if (aiBusy) {
      setError("请先停止 AI 生成");
      return;
    }
    await flushLocal();
    await api().leave();
    documentRef.current?.destroy();
    documentRef.current = null;
    active.current = null;
    setDoc(null);
    setRoom(null);
    setBook(null);
    setPeers([]);
    await refresh();
  };
  const structure = async (action: Structure) => {
    if (!active.current) return;
    await flush();
    const current = active.current;
    await api().structure(
      current.book.id,
      current.epoch,
      current.revision,
      action,
    );
  };
  const readOnly = room?.role === "reader",
    canStructure = status.online && !readOnly;
  const select = (t: Target) => {
    setTarget(t);
    setView("text");
    setSelection(null);
  };
  const field = book ? targetField(book, target) : "";
  const editor = (f: string, label: string, oneLine = false) =>
    doc && status.user ? (
      <SharedEditor
        key={`${room?.epoch}/${f}`}
        doc={doc}
        field={f}
        label={label}
        readOnly={!!readOnly}
        user={status.user}
        peers={peers}
        prefs={prefs}
        oneLine={oneLine}
        onSelection={(s) => {
          if (f === field) setSelection(s);
        }}
      />
    ) : null;
  const chapter = book?.chapters.find((c) => c.id === target.id),
    setting = book?.settings.find((s) => s.id === target.id),
    volume = book?.volumes.find((v) => v.id === target.id);
  const showMembers = async () => {
    if (!book) return;
    setModal("members");
  };
  const candidateMeta = () => {
    if (!doc || !book) return {};
    const t = doc.getMap<Y.Text>("texts").get(field);
    return {
      collaborationEpoch: room!.epoch,
      ...(t && selection && selection.end > selection.start
        ? {
            anchor: toBase64(
              Y.encodeRelativePosition(
                Y.createRelativePositionFromTypeIndex(t, selection.start),
              ),
            ),
            head: toBase64(
              Y.encodeRelativePosition(
                Y.createRelativePositionFromTypeIndex(t, selection.end),
              ),
            ),
          }
        : {}),
    };
  };
  const adopt = async (
    draft: Draft,
    mode: "insert" | "replace" | "chapters",
  ) => {
    await flush();
    const current = active.current;
    if (!current || draft.collaborationEpoch !== current.epoch)
      throw new Error("共享版本已变化，请重新生成候选稿或复制到新位置");
    if (mode === "chapters") {
      const { splitChapters } = await import("../shared/model");
      const chapters = splitChapters(draft.text);
      if (!(await confirm(`确认新增 ${chapters.length} 个章节大纲？`)))
        return false;
      await structure({
        kind: "import",
        chapters: chapters.map((c) => ({
          ...newChapter(
            c.title,
            draft.target.kind === "volume" ? draft.target.id : "",
          ),
          outline: c.body,
        })),
      });
    } else {
      const edit: AtomicEdit = {
        field: targetField(current.book, draft.target),
        baseline: draft.baseline,
        text: draft.text,
        mode:
          mode === "insert"
            ? "append"
            : draft.selection
              ? "selection"
              : "replace",
        reason: `AI ${draft.action}采纳前`,
        anchor: draft.anchor,
        head: draft.head,
        selectionText: draft.selection
          ? draft.baseline.slice(draft.selection.start, draft.selection.end)
          : undefined,
        sourceFingerprint: draft.sourceFingerprint,
      };
      try {
        await api().atomic(current.book.id, current.epoch, edit);
      } catch (e) {
        if (!/目标内容已被其他成员修改|选区已被修改|选区已变化/.test(String(e)))
          throw e;
        const latest = documentRef.current
          ?.getMap<Y.Text>("texts")
          .get(edit.field);
        if (
          !latest ||
          !active.current ||
          active.current.epoch !== current.epoch
        )
          throw e;
        if (edit.mode === "selection") {
          if (
            !selection ||
            selection.end <= selection.start ||
            field !== edit.field
          )
            throw new Error(
              "原选区已变化。请重新选中要替换的文本，再点击采纳。",
            );
          const nextText = latest
            .toString()
            .slice(selection.start, selection.end);
          const anchor = toBase64(
            Y.encodeRelativePosition(
              Y.createRelativePositionFromTypeIndex(latest, selection.start),
            ),
          );
          const head = toBase64(
            Y.encodeRelativePosition(
              Y.createRelativePositionFromTypeIndex(latest, selection.end),
            ),
          );
          if (
            !(await confirm(
              `原选区已变化。确认将当前选中的以下文本替换为候选稿？替换前会保存版本。\n\n${nextText.slice(0, 1500)}`,
            ))
          )
            return false;
          await api().atomic(current.book.id, current.epoch, {
            ...edit,
            anchor,
            head,
            selectionText: nextText,
          });
          return true;
        }
        const baseline = latest.toString();
        if (
          !(await confirm(
            `原文已发生变化。请审核当前原文后确认替换（替换前会保存共享版本）：\n\n${baseline.slice(0, 1500)}${baseline.length > 1500 ? "\n……其余原文请在编辑器中查看" : ""}`,
          ))
        )
          return false;
        await api().atomic(current.book.id, current.epoch, {
          ...edit,
          baseline,
        });
      }
    }
    return true;
  };
  const peerLocation = (value: string) => {
    if (!book || !value) return "浏览中";
    const [kind, id, key] = value.split(":");
    const name =
      kind === "chapter"
        ? book.chapters.find((c) => c.id === id)?.title
        : kind === "setting"
          ? book.settings.find((c) => c.id === id)?.title
          : kind === "volume"
            ? book.volumes.find((c) => c.id === id)?.title
            : book.title;
    const labels: Record<string, string> = {
      body: "正文",
      outline: "大纲",
      summary: "摘要",
      content: "设定",
      title: "名称",
      synopsis: "全书大纲",
      description: "简介",
      requirements: "写作要求",
      role: "定位",
      traits: "特征",
      genre: "题材",
    };
    return `${name || "已删除条目"} · ${labels[key] || "资料"}`;
  };
  const navTarget =
    target.kind === "setting"
      ? "故事设定"
      : ["synopsis", "volume", "outline"].includes(target.kind)
        ? "大纲规划"
        : "正文创作";
  return (
    <div
      className={`collaboration app ${book ? "collab-writing" : ""} ${focus ? "collab-focus" : ""}`}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
        setTimeout(() => {
          const queue = remoteQueue.current.splice(0);
          queue.forEach((fn) => fn());
        }, 0);
      }}
    >
      {!book ? (
        <>
          <header className="library-header">
            <div className="row">
              <button
                onClick={() =>
                  void safe(async () => {
                    await flushLocal();
                    onBack();
                  })
                }
              >
                <ArrowLeft size={16} />
                个人书架
              </button>
              <h2 style={{ margin: 0 }}>协作空间</h2>
            </div>
            <div className="row">
              {status.user && (
                <>
                  <span className="muted tiny">
                    {status.user.displayName}
                    {status.user.admin ? " · 管理员" : ""}
                  </span>
                  {status.user.admin && (
                    <button
                      onClick={() =>
                        void safe(async () => {
                          setModal("users");
                        })
                      }
                    >
                      <ShieldCheck size={16} />
                      管理账号
                    </button>
                  )}
                  <button
                    onClick={() =>
                      void safe(async () => {
                        await api().logout();
                        setBooks([]);
                      })
                    }
                  >
                    <LogOut size={16} />
                    退出登录
                  </button>
                </>
              )}
            </div>
          </header>
          <main className="library">
            {!status.user ? (
              <div className="login-card">
                <Cloud size={34} />
                <h1>一起，把故事写下去</h1>
                <p className="muted">
                  使用管理员分配的账号登录。个人作品不会自动上传。
                </p>
                <label>
                  协作服务器
                  <input
                    aria-label="协作服务器"
                    value={server}
                    onChange={(e) => setServer(e.target.value)}
                  />
                </label>
                <label>
                  用户名
                  <input
                    aria-label="协作用户名"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete="username"
                  />
                </label>
                <label>
                  密码
                  <input
                    aria-label="协作密码"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                  />
                </label>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    void safe(async () => {
                      setBusy(true);
                      try {
                        const s = await api().login(server, username, password);
                        setStatus(s);
                        if (!s.user?.mustChangePassword) {
                          setPassword("");
                          await refresh();
                        }
                      } finally {
                        setBusy(false);
                      }
                    })
                  }
                >
                  登录协作空间
                </button>
              </div>
            ) : status.user.mustChangePassword ? (
              <div className="login-card">
                <h2>设置你的新密码</h2>
                <p className="muted">
                  首次登录或管理员重置后，需修改临时密码。
                </p>
                <label>
                  临时密码
                  <input
                    type="password"
                    aria-label="临时密码"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
                <label>
                  新密码（至少 12 位）
                  <input
                    type="password"
                    aria-label="新密码"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                  />
                </label>
                <button
                  className="primary"
                  onClick={() =>
                    void safe(async () => {
                      await api().changePassword(password, newPassword);
                      setStatus(await api().status());
                      setPassword("");
                      setNewPassword("");
                      await refresh();
                    })
                  }
                >
                  更新密码
                </button>
              </div>
            ) : (
              <>
                <div className="shelf-heading">
                  <div>
                    <div className="eyebrow">SHARED STORIES</div>
                    <h1>共同创作的世界</h1>
                    <p className="muted">
                      {status.online
                        ? "已连接协作服务器"
                        : "离线 · 可打开已缓存作品继续写作"}
                    </p>
                  </div>
                  <div className="row">
                    <button onClick={() => void safe(refresh)}>刷新</button>
                    {status.user.admin && (
                      <>
                        <button
                          onClick={() => {
                            setTitle("");
                            setModal("create");
                          }}
                        >
                          <Plus size={16} />
                          新建协作作品
                        </button>
                        <button
                          onClick={() =>
                            void safe(async () => {
                              setPersonal(await window.moye.listBooks());
                              setModal("publish");
                            })
                          }
                        >
                          <Upload size={16} />
                          发布个人作品副本
                        </button>
                      </>
                    )}
                  </div>
                </div>
                <div className="collab-books">
                  {books.map((b) => (
                    <button
                      key={b.id}
                      className="collab-book"
                      onClick={() => void safe(() => open(b.id))}
                    >
                      <BookOpen size={28} />
                      <div>
                        <h2>{b.title}</h2>
                        <p>
                          {b.role === "admin"
                            ? "管理员"
                            : b.role === "editor"
                              ? "可编辑"
                              : "只读"}
                          {b.archived ? " · 已归档" : ""} · {date(b.updatedAt)}
                        </p>
                      </div>
                    </button>
                  ))}
                  {!books.length && (
                    <Empty icon={<Users size={32} />} title="还没有协作作品">
                      管理员创建作品并分配成员后，会显示在这里。
                    </Empty>
                  )}
                </div>
              </>
            )}
          </main>
        </>
      ) : (
        <>
          <aside className="sidebar">
            <div className="sidebar-top">
              <button className="back-button" onClick={() => void safe(leave)}>
                <ArrowLeft size={15} />
                协作书架
              </button>
              <Users size={18} />
            </div>
            <div className="project-title">
              <div className="eyebrow">SHARED WORKSPACE</div>
              <h2>{book.title}</h2>
              <span className="genre-tag">
                {readOnly ? "只读成员" : "共同创作"}
              </span>
            </div>
            <nav className="workspace-nav">
              <button
                className={view === "overview" ? "active" : ""}
                onClick={() => setView("overview")}
              >
                <BookOpen size={17} />
                作品概览
              </button>
              <button
                className={
                  view === "text" && navTarget === "故事设定" ? "active" : ""
                }
                onClick={() =>
                  select({ kind: "setting", id: book.settings[0]?.id || "" })
                }
              >
                <Network size={17} />
                故事设定
              </button>
              <button
                className={
                  view === "text" && navTarget === "大纲规划" ? "active" : ""
                }
                onClick={() => select({ kind: "synopsis", id: book.id })}
              >
                <Layers size={17} />
                大纲规划
              </button>
              <button
                className={
                  view === "text" && navTarget === "正文创作" ? "active" : ""
                }
                onClick={() =>
                  select({
                    kind: "body",
                    id: orderedChapters(book)[0]?.id || "",
                  })
                }
              >
                <FileText size={17} />
                正文创作
              </button>
            </nav>
            <div className="chapters-label">
              <span>章节目录</span>
              <button
                className="icon"
                disabled={!canStructure}
                title="新增协作章节"
                onClick={() =>
                  void safe(async () => {
                    const c = newChapter(`第${book.chapters.length + 1}章`);
                    await structure({ kind: "addChapter", chapter: c });
                    select({ kind: "body", id: c.id });
                  })
                }
              >
                <Plus size={16} />
              </button>
            </div>
            <div className="chapters-scroll">
              {orderedChapters(book).map((c, i) => (
                <div
                  key={c.id}
                  className={`chapter-item ${target.id === c.id ? "active" : ""}`}
                >
                  <button
                    className="chapter-main"
                    onClick={() => select({ kind: "body", id: c.id })}
                  >
                    <span className="chapter-number">{i + 1}</span>
                    <span>
                      {c.title}
                      <small>{wordCount(c.body)} 字</small>
                    </span>
                  </button>
                </div>
              ))}
            </div>
            <div className="sidebar-bottom">
              <div className="progress-label">
                <span>已写下</span>
                <strong>
                  {book.chapters.reduce((n, c) => n + wordCount(c.body), 0)}{" "}
                  <small>字</small>
                </strong>
              </div>
              <div className="row">
                <button
                  className="icon"
                  title="AI 连接与偏好"
                  onClick={() => setSettingsOpen(true)}
                >
                  <Settings2 size={18} />
                </button>
                <button
                  className="icon"
                  title="切换主题"
                  onClick={() =>
                    void onPrefs({
                      ...prefs,
                      theme: prefs.theme === "light" ? "dark" : "light",
                    })
                  }
                >
                  {prefs.theme === "light" ? (
                    <Moon size={17} />
                  ) : (
                    <Sun size={17} />
                  )}
                </button>
                {status.user?.admin && (
                  <button
                    className="icon"
                    title="协作成员管理"
                    onClick={() => void safe(showMembers)}
                  >
                    <Users size={18} />
                  </button>
                )}
              </div>
            </div>
          </aside>
          <main className="workspace">
            <header className="workspace-header">
              <div className="row">
                <strong>{book.title}</strong>
                <span className="pill">{navTarget}</span>
              </div>
              <div className="row">
                <button
                  className="save-status"
                  onClick={() => void safe(flushLocal)}
                >
                  {status.online ? <Cloud size={14} /> : <CloudOff size={14} />}{" "}
                  {failedUpdates.current.length
                    ? "本机保存失败 · 重试"
                    : pending
                      ? `已保存本机 · 待同步 ${pending}`
                      : status.online
                        ? "已同步"
                        : "已保存本机 · 离线"}
                </button>
                <button
                  className="icon"
                  title="协作版本记录"
                  onClick={() =>
                    void safe(async () => {
                      await flushLocal();
                      setVersions(await api().versions(book.id));
                      setModal("versions");
                    })
                  }
                >
                  <History size={18} />
                </button>
                <button
                  className="icon"
                  title="导出协作作品"
                  onClick={() => {
                    setExportIds([]);
                    setModal("export");
                  }}
                >
                  <Download size={18} />
                </button>
                <button
                  disabled={!status.online}
                  title="备份协作作品与历史"
                  onClick={() =>
                    void safe(async () => {
                      await flush();
                      await window.moye.backup(book.id);
                    })
                  }
                >
                  备份
                </button>
                <button
                  className="icon"
                  title="导入协作章节"
                  disabled={!canStructure}
                  onClick={() =>
                    void safe(async () => {
                      const result = await window.moye.importText();
                      if (result) {
                        setImported(result.chapters);
                        setModal("import");
                      }
                    })
                  }
                >
                  <Upload size={18} />
                </button>
              </div>
            </header>
            <div className="presence-bar">
              <Users size={14} />
              <span>{peers.length} 人在线</span>
              {peers.map((p) => (
                <span
                  key={p.id}
                  className="peer"
                  style={{ borderColor: p.color }}
                  title={peerLocation(p.field)}
                >
                  <i style={{ background: p.color }} />
                  {p.name}
                  <small>{peerLocation(p.field)}</small>
                </span>
              ))}
            </div>
            <div className="workspace-content">
              <section className="editor-area">
                <div className="editor-toolbar">
                  <span className="toolbar-label">
                    {readOnly
                      ? "只读浏览"
                      : status.online
                        ? "修改实时同步给团队"
                        : "离线编辑，联网后自动合并"}
                  </span>
                  <div className="row">
                    <button
                      className="icon"
                      title="查找替换"
                      onClick={() => setFindOpen(!findOpen)}
                    >
                      <Search size={16} />
                    </button>
                    <button
                      className="icon"
                      title="专注模式"
                      onClick={() => setFocus(!focus)}
                    >
                      {focus ? (
                        <Minimize2 size={16} />
                      ) : (
                        <Maximize2 size={16} />
                      )}
                    </button>
                    <button
                      className="ai-toggle"
                      disabled={!!readOnly}
                      onClick={() => setAiOpen(!aiOpen)}
                    >
                      <Sparkles size={15} />
                      AI 助手
                    </button>
                  </div>
                </div>
                {findOpen && (
                  <div className="find-bar">
                    <input
                      placeholder="查找文本"
                      value={find}
                      onChange={(e) => setFind(e.target.value)}
                    />
                    <input
                      placeholder="替换为"
                      value={replacement}
                      onChange={(e) => setReplacement(e.target.value)}
                    />
                    <button
                      disabled={!canStructure || !find}
                      onClick={() =>
                        void safe(async () => {
                          await flush();
                          const current = active.current!,
                            text = documentRef
                              .current!.getMap<Y.Text>("texts")
                              .get(field)
                              ?.toString();
                          if (text === undefined) return;
                          await api().atomic(current.book.id, current.epoch, {
                            field,
                            baseline: text,
                            text: text.split(find).join(replacement),
                            mode: "replace",
                            reason: "协作批量替换前",
                          });
                        })
                      }
                    >
                      全部替换
                    </button>
                  </div>
                )}
                <div className="document-scroll">
                  <div className="form-document">
                    {view === "overview" ? (
                      <>
                        <div className="eyebrow">SHARED STORY</div>
                        <h1>作品概览</h1>
                        {(
                          [
                            "title",
                            "genre",
                            "description",
                            "requirements",
                          ] as const
                        ).map((f, i) => (
                          <label key={f}>
                            {
                              ["作品名称", "题材类型", "故事简介", "写作要求"][
                                i
                              ]
                            }
                            {editor(
                              `book:${book.id}:${f}`,
                              [
                                "协作作品名称",
                                "协作题材",
                                "协作简介",
                                "协作写作要求",
                              ][i],
                              i < 2,
                            )}
                          </label>
                        ))}
                        {status.user?.admin && (
                          <div className="row" style={{ marginTop: 25 }}>
                            <button
                              disabled={!status.online}
                              onClick={() =>
                                void safe(() =>
                                  structure({
                                    kind: "archive",
                                    archived: !book.archived,
                                  }),
                                )
                              }
                            >
                              {book.archived ? "取消归档" : "归档作品"}
                            </button>
                            <button
                              className="danger"
                              onClick={() =>
                                void safe(async () => {
                                  if (
                                    !(await confirm(
                                      "永久删除此协作作品及其共享历史？",
                                    ))
                                  )
                                    return;
                                  await api().deleteBook(book.id);
                                  await leave();
                                })
                              }
                            >
                              <Trash2 size={15} />
                              删除协作作品
                            </button>
                          </div>
                        )}
                      </>
                    ) : (
                      <>
                        <div className="collab-target-bar">
                          <select
                            aria-label="协作编辑目标"
                            value={`${target.kind}/${target.id}`}
                            onChange={(e) => {
                              const [kind, id] = e.target.value.split("/");
                              select({ kind: kind as Target["kind"], id });
                            }}
                          >
                            <option value={`synopsis/${book.id}`}>
                              全书大纲
                            </option>
                            {book.volumes.map((v) => (
                              <option key={v.id} value={`volume/${v.id}`}>
                                卷纲 · {v.title}
                              </option>
                            ))}
                            {book.settings.map((s) => (
                              <option key={s.id} value={`setting/${s.id}`}>
                                {s.category} · {s.title}
                              </option>
                            ))}
                            {orderedChapters(book).flatMap((c) =>
                              ["body", "outline", "summary"].map((kind, i) => (
                                <option
                                  key={kind + c.id}
                                  value={`${kind}/${c.id}`}
                                >
                                  {["正文", "章纲", "摘要"][i]} · {c.title}
                                </option>
                              )),
                            )}
                          </select>
                          <button
                            disabled={!canStructure}
                            onClick={() =>
                              void safe(async () => {
                                const s = {
                                  id: uid(),
                                  category: "人物" as const,
                                  title: "新设定",
                                  role: "",
                                  traits: "",
                                  content: "",
                                };
                                await structure({
                                  kind: "addSetting",
                                  setting: s,
                                });
                                select({ kind: "setting", id: s.id });
                              })
                            }
                          >
                            + 设定
                          </button>
                          <button
                            disabled={!canStructure}
                            onClick={() =>
                              void safe(async () => {
                                const v = {
                                  id: uid(),
                                  title: "新分卷",
                                  outline: "",
                                };
                                await structure({
                                  kind: "addVolume",
                                  volume: v,
                                });
                                select({ kind: "volume", id: v.id });
                              })
                            }
                          >
                            + 分卷
                          </button>
                        </div>
                        {doc?.getMap("texts").has(field) ? (
                          <>
                            <div
                              className="eyebrow"
                              style={{ margin: "26px 0 10px" }}
                            >
                              {navTarget} ·{" "}
                              {wordCount(
                                doc
                                  .getMap<Y.Text>("texts")
                                  .get(field)
                                  ?.toString() || "",
                              )}{" "}
                              字
                            </div>
                            {chapter && (
                              <>
                                {editor(
                                  `chapter:${chapter.id}:title`,
                                  "协作章节标题",
                                  true,
                                )}
                                <div
                                  className="row"
                                  style={{ margin: "15px 0" }}
                                >
                                  {(
                                    ["body", "outline", "summary"] as const
                                  ).map((kind, i) => (
                                    <button
                                      key={kind}
                                      className={
                                        target.kind === kind ? "selected" : ""
                                      }
                                      onClick={() =>
                                        select({ kind, id: chapter.id })
                                      }
                                    >
                                      {["正文", "章纲", "摘要"][i]}
                                    </button>
                                  ))}
                                  <select
                                    aria-label="协作章节分卷"
                                    disabled={!canStructure}
                                    value={chapter.volumeId}
                                    onChange={(e) =>
                                      void safe(() =>
                                        structure({
                                          kind: "assignVolume",
                                          id: chapter.id,
                                          volumeId: e.target.value,
                                        }),
                                      )
                                    }
                                  >
                                    <option value="">未分卷</option>
                                    {book.volumes.map((v) => (
                                      <option key={v.id} value={v.id}>
                                        {v.title}
                                      </option>
                                    ))}
                                  </select>
                                </div>
                                {target.kind === "summary" &&
                                  chapter.summary &&
                                  chapter.summarySource !==
                                    fingerprint(chapter.body) && (
                                    <p className="notice">
                                      正文已变化，此摘要已过期。
                                    </p>
                                  )}
                              </>
                            )}
                            {setting && (
                              <>
                                <label>
                                  名称
                                  {editor(
                                    `setting:${setting.id}:title`,
                                    "协作设定名称",
                                    true,
                                  )}
                                </label>
                                <label>
                                  类别
                                  <select
                                    disabled={!canStructure}
                                    value={setting.category}
                                    onChange={(e) =>
                                      void safe(() =>
                                        structure({
                                          kind: "category",
                                          id: setting.id,
                                          category: e.target
                                            .value as typeof setting.category,
                                        }),
                                      )
                                    }
                                  >
                                    {[
                                      "世界观",
                                      "人物",
                                      "地点",
                                      "组织",
                                      "物品",
                                      "规则",
                                      "自定义",
                                    ].map((c) => (
                                      <option key={c}>{c}</option>
                                    ))}
                                  </select>
                                </label>
                                <label>
                                  定位
                                  {editor(
                                    `setting:${setting.id}:role`,
                                    "协作设定定位",
                                    true,
                                  )}
                                </label>
                                <label>
                                  特征
                                  {editor(
                                    `setting:${setting.id}:traits`,
                                    "协作设定特征",
                                    true,
                                  )}
                                </label>
                              </>
                            )}
                            {volume && (
                              <label>
                                分卷名称
                                {editor(
                                  `volume:${volume.id}:title`,
                                  "协作分卷名称",
                                  true,
                                )}
                              </label>
                            )}
                            <div className="shared-manuscript">
                              {editor(field, "协作正文")}
                            </div>
                            {(chapter || setting || volume) && (
                              <div className="row">
                                <button
                                  disabled={!canStructure}
                                  title="上移条目"
                                  onClick={() =>
                                    void safe(() =>
                                      structure({
                                        kind: "move",
                                        collection: chapter
                                          ? "chapters"
                                          : setting
                                            ? "settings"
                                            : "volumes",
                                        id: target.id,
                                        delta: -1,
                                      }),
                                    )
                                  }
                                >
                                  <ArrowUp size={14} />
                                </button>
                                <button
                                  disabled={!canStructure}
                                  title="下移条目"
                                  onClick={() =>
                                    void safe(() =>
                                      structure({
                                        kind: "move",
                                        collection: chapter
                                          ? "chapters"
                                          : setting
                                            ? "settings"
                                            : "volumes",
                                        id: target.id,
                                        delta: 1,
                                      }),
                                    )
                                  }
                                >
                                  <ArrowDown size={14} />
                                </button>
                                <button
                                  className="danger"
                                  disabled={!canStructure}
                                  onClick={() =>
                                    void safe(async () => {
                                      if (
                                        !(await confirm(
                                          "删除当前条目？删除前将保存共享版本。",
                                        ))
                                      )
                                        return;
                                      await structure({
                                        kind: "delete",
                                        collection: chapter
                                          ? "chapters"
                                          : setting
                                            ? "settings"
                                            : "volumes",
                                        id: target.id,
                                      });
                                      select({ kind: "synopsis", id: book.id });
                                    })
                                  }
                                >
                                  <Trash2 size={14} />
                                  删除条目
                                </button>
                              </div>
                            )}
                          </>
                        ) : (
                          <Empty
                            icon={<FileText size={30} />}
                            title="请选择或创建一个条目"
                          >
                            新增条目需要连接协作服务器。
                          </Empty>
                        )}
                      </>
                    )}
                  </div>
                </div>
                <footer className="editor-footer">
                  <span>
                    {status.user?.displayName} · {readOnly ? "只读" : "编辑中"}
                  </span>
                  <div className="row">
                    <select
                      aria-label="协作正文字体"
                      value={prefs.font}
                      onChange={(e) =>
                        void onPrefs({
                          ...prefs,
                          font: e.target.value as Preferences["font"],
                        })
                      }
                    >
                      <option value="serif">宋体</option>
                      <option value="sans">黑体</option>
                    </select>
                    <select
                      aria-label="协作字号"
                      value={prefs.fontSize}
                      onChange={(e) =>
                        void onPrefs({
                          ...prefs,
                          fontSize: Number(e.target.value),
                        })
                      }
                    >
                      {[16, 18, 20, 22, 24].map((n) => (
                        <option key={n} value={n}>
                          {n}px
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label="协作行距"
                      value={prefs.lineHeight}
                      onChange={(e) =>
                        void onPrefs({
                          ...prefs,
                          lineHeight: Number(e.target.value),
                        })
                      }
                    >
                      {[1.6, 1.8, 2.1, 2.4, 2.8].map((n) => (
                        <option key={n} value={n}>
                          {n} 倍
                        </option>
                      ))}
                    </select>
                  </div>
                </footer>
              </section>
              <div
                className={`ai-wrapper ${!aiOpen || readOnly || focus ? "hidden" : ""}`}
              >
                <AIPanel
                  key={`${book.id}/${room?.epoch}`}
                  book={book}
                  target={target}
                  selection={selection}
                  connections={connections}
                  prefs={prefs}
                  flush={flushLocal}
                  onBook={() => {
                    throw new Error("协作作品需要通过协作协议更新");
                  }}
                  notify={setMessage}
                  confirm={confirm}
                  onBusy={setAiBusy}
                  onSettings={() => setSettingsOpen(true)}
                  onClose={() => setAiOpen(false)}
                  candidateMeta={candidateMeta}
                  adoptOverride={adopt}
                />
              </div>
            </div>
          </main>
        </>
      )}
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button onClick={() => setError("")}>关闭</button>
        </div>
      )}
      {message && (
        <div className="toast" onClick={() => setMessage("")}>
          {message}
        </div>
      )}
      {settingsOpen && (
        <Settings
          connections={connections}
          prefs={prefs}
          onConnections={onConnections}
          onPrefs={onPrefs}
          onClose={() => setSettingsOpen(false)}
          notify={setMessage}
        />
      )}
      {modal === "create" && (
        <Modal title="新建协作作品" onClose={() => setModal(null)}>
          <div className="modal-body">
            <label>
              作品名称
              <input
                aria-label="新协作作品名称"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <button
              className="primary"
              disabled={!title.trim()}
              onClick={() =>
                void safe(async () => {
                  const b = await api().publish(newBook(title.trim()));
                  setModal(null);
                  await refresh();
                  await open(b.id);
                })
              }
            >
              创建协作作品
            </button>
          </div>
        </Modal>
      )}
      {modal === "publish" && (
        <Modal title="发布个人作品副本" onClose={() => setModal(null)}>
          <div className="modal-body">
            <p className="muted">
              仅上传作品内容，不上传 AI
              密钥、候选稿和个人版本记录。原作保留在本机。
            </p>
            {personal.map((b) => (
              <button
                className="publish-row"
                key={b.id}
                onClick={() =>
                  void safe(async () => {
                    if (
                      !(await confirm(`将「${b.title}」发布为独立协作副本？`))
                    )
                      return;
                    const result = await api().publish(b);
                    setModal(null);
                    await refresh();
                    await open(result.id);
                  })
                }
              >
                {b.title}
                <Upload size={15} />
              </button>
            ))}
          </div>
        </Modal>
      )}
      {modal === "users" && status.user && (
        <UserManagement
          currentUser={status.user}
          onClose={() => setModal(null)}
          confirm={confirm}
        />
      )}
      {modal === "members" && book && (
        <MemberManagement
          bookId={book.id}
          onClose={() => setModal(null)}
          confirm={confirm}
        />
      )}
      {modal === "versions" && book && (
        <Modal title="共享版本记录" onClose={() => setModal(null)}>
          <div className="modal-body">
            <p className="muted">
              恢复由管理员执行，恢复前自动备份。旧版本的离线修改会保留为个人副本。
            </p>
            <button
              disabled={!canStructure}
              onClick={() =>
                void safe(async () => {
                  await flush();
                  await api().snapshot(book.id);
                  setVersions(await api().versions(book.id));
                })
              }
            >
              保存共享版本
            </button>
            <div className="version-list">
              {versions.map((v) => (
                <div key={v.id}>
                  <span>
                    <strong>{v.reason}</strong>
                    <small>
                      {v.createdBy} · {date(v.createdAt)}
                    </small>
                  </span>
                  <button
                    disabled={!status.user?.admin || !status.online || aiBusy}
                    onClick={() =>
                      void safe(async () => {
                        if (
                          !(await confirm(
                            "恢复此版本的整部协作作品？所有在线成员会切换到恢复后的版本。",
                          ))
                        )
                          return;
                        await flush();
                        await api().restore(book.id, v.id);
                        setModal(null);
                      })
                    }
                  >
                    恢复
                  </button>
                </div>
              ))}
            </div>
          </div>
        </Modal>
      )}
      {modal === "import" && book && (
        <Modal title="预览协作章节导入" onClose={() => setModal(null)}>
          <div className="modal-body">
            <p className="muted">
              将追加以下 {imported.length} 章，导入前保存共享版本。
            </p>
            <div className="check-list">
              {imported.map((c, i) => (
                <p key={i}>
                  {c.title} · {wordCount(c.body)} 字
                </p>
              ))}
            </div>
            <button
              className="primary"
              onClick={() =>
                void safe(async () => {
                  await structure({
                    kind: "import",
                    chapters: imported.map((c) => ({
                      ...newChapter(c.title),
                      body: c.body,
                    })),
                  });
                  setModal(null);
                })
              }
            >
              确认导入
            </button>
          </div>
        </Modal>
      )}
      {modal === "export" && book && (
        <Modal title="导出协作作品" onClose={() => setModal(null)}>
          <div className="modal-body">
            <label>
              格式
              <select
                value={exportFormat}
                onChange={(e) =>
                  setExportFormat(e.target.value as "txt" | "md")
                }
              >
                <option value="txt">TXT</option>
                <option value="md">Markdown</option>
              </select>
            </label>
            <p className="muted">
              未选择章节时导出全书。离线时导出本机已有内容。
            </p>
            <div className="check-list">
              {orderedChapters(book).map((c) => (
                <label key={c.id}>
                  <input
                    type="checkbox"
                    checked={exportIds.includes(c.id)}
                    onChange={() =>
                      setExportIds((ids) =>
                        ids.includes(c.id)
                          ? ids.filter((x) => x !== c.id)
                          : [...ids, c.id],
                      )
                    }
                  />
                  {c.title}
                </label>
              ))}
            </div>
            <button
              className="primary"
              onClick={() =>
                void safe(async () => {
                  await flushLocal();
                  if (
                    await window.moye.exportText(
                      book.id,
                      exportIds,
                      exportFormat,
                    )
                  )
                    setModal(null);
                })
              }
            >
              导出
            </button>
          </div>
        </Modal>
      )}
      {confirmation && (
        <Modal
          title="请确认"
          onClose={() => {
            confirmation.resolve(false);
            setConfirmation(null);
          }}
        >
          <div className="modal-body">
            <p>{confirmation.text}</p>
            <div className="modal-actions">
              <button
                onClick={() => {
                  confirmation.resolve(false);
                  setConfirmation(null);
                }}
              >
                取消
              </button>
              <button
                className="primary"
                onClick={() => {
                  confirmation.resolve(true);
                  setConfirmation(null);
                }}
              >
                确认
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
