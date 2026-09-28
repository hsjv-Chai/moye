import { useCallback, useEffect, useRef, useState } from "react";
import {
  BookOpen,
  Plus,
  Settings2,
  Search,
  ArrowLeft,
  ArrowUpRight,
  Feather,
  Library,
  Archive,
  MoreHorizontal,
  FileText,
  Network,
  Sparkles,
  PanelRightClose,
  PanelRightOpen,
  Maximize2,
  Minimize2,
  Sun,
  Moon,
  Download,
  Upload,
  History,
  ChevronDown,
  ChevronRight,
  Trash2,
  ArrowUp,
  ArrowDown,
  FolderOpen,
  Check,
  Save,
  Undo2,
  Redo2,
  X,
  Layers,
  PackageOpen,
} from "lucide-react";
import {
  newBook,
  newChapter,
  uid,
  wordCount,
  fingerprint,
  getTarget,
  setTarget,
  orderedChapters,
  defaultPreferences,
  type Book,
  type Connection,
  type Preferences,
  type Target,
  type Version,
  type ImportChapter,
  type Setting,
} from "../shared/model";
import "./api";
import { Modal, Empty, date } from "./components";
import Settings from "./Settings";
import AIPanel from "./AIPanel";
type Page = "body" | "settings" | "outline" | "overview";
type ConfirmState = { message: string; resolve: (b: boolean) => void };
const categories: Setting["category"][] = [
  "世界观",
  "人物",
  "地点",
  "组织",
  "物品",
  "规则",
  "自定义",
];
const coverColors = ["#425b50", "#b27152", "#616578", "#8b7660", "#57777a"];
export default function App() {
  const [books, setBooks] = useState<Book[]>([]),
    [book, setBookState] = useState<Book | null>(null),
    [bookEpoch, setBookEpoch] = useState(0),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [toast, setToast] = useState("");
  const [page, setPage] = useState<Page>("body"),
    [chapterId, setChapterId] = useState(""),
    [settingId, setSettingId] = useState(""),
    [outlineId, setOutlineId] = useState("synopsis"),
    [tab, setTab] = useState<"body" | "summary">("body");
  const [connections, setConnections] = useState<Connection[]>([]),
    [prefs, setPrefs] = useState<Preferences>(defaultPreferences),
    [settingsOpen, setSettingsOpen] = useState(false),
    [aiOpen, setAiOpen] = useState(true),
    [focus, setFocus] = useState(false),
    [aiBusy, setAiBusy] = useState(false);
  const [query, setQuery] = useState(""),
    [archived, setArchived] = useState(false),
    [menu, setMenu] = useState(false),
    [saveStatus, setSaveStatus] = useState("已保存"),
    [modal, setModal] = useState<
      "new" | "versions" | "export" | "import" | null
    >(null),
    [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [newTitle, setNewTitle] = useState(""),
    [newGenre, setNewGenre] = useState("幻想 / 奇幻"),
    [newDescription, setNewDescription] = useState(""),
    [versions, setVersions] = useState<Version[]>([]),
    [imported, setImported] = useState<{
      chapters: ImportChapter[];
      name: string;
      encoding: string;
    } | null>(null),
    [importChecked, setImportChecked] = useState<number[]>([]),
    [exportIds, setExportIds] = useState<string[]>([]),
    [exportFormat, setExportFormat] = useState<"txt" | "md">("txt");
  const [searchOpen, setSearchOpen] = useState(false),
    [find, setFind] = useState(""),
    [replacement, setReplacement] = useState(""),
    [selection, setSelection] = useState<{ start: number; end: number } | null>(
      null,
    );
  const bookRef = useRef<Book | null>(null),
    dirty = useRef(false),
    savePromise = useRef<Promise<void> | null>(null),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null),
    editor = useRef<HTMLTextAreaElement>(null),
    toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    history = useRef<Record<string, { undo: string[]; redo: string[] }>>({}),
    lastEdit = useRef({ key: "", time: 0 });
  const notify = useCallback((s: string) => {
    setToast(s);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 4500);
  }, []);
  const confirm = useCallback(
    (message: string) =>
      new Promise<boolean>((resolve) => setConfirmState({ message, resolve })),
    [],
  );
  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    if (savePromise.current) await savePromise.current;
    if (!dirty.current || !bookRef.current) return;
    const save = async () => {
      while (dirty.current && bookRef.current) {
        const captured = bookRef.current;
        setSaveStatus("保存中…");
        try {
          const saved = await window.moye.saveBook(captured);
          setBooks((items) => [
            saved,
            ...items.filter((b) => b.id !== saved.id),
          ]);
          if (bookRef.current === captured) {
            bookRef.current = saved;
            setBookState(saved);
            dirty.current = false;
          }
        } catch (e) {
          setSaveStatus("保存失败 · 点击重试");
          setError(`自动保存失败，编辑内容仍在窗口中。${String(e)}`);
          throw e;
        }
      }
      setSaveStatus("已保存");
    };
    const promise = save();
    savePromise.current = promise;
    try {
      await promise;
    } finally {
      if (savePromise.current === promise) savePromise.current = null;
    }
  }, []);
  const updateBook = useCallback(
    (b: Book) => {
      bookRef.current = b;
      setBookState(b);
      dirty.current = true;
      setSaveStatus("尚未保存");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush().catch(() => {}), 1000);
    },
    [flush],
  );
  const safe = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    }
  };
  useEffect(() => {
    if (!window.moye) {
      setError("请使用桌面应用打开墨页。运行 npm run dev 启动 Electron。");
      setLoading(false);
      return;
    }
    Promise.all([
      window.moye.listBooks(),
      window.moye.connections(),
      window.moye.preferences(),
    ])
      .then(([b, c, p]) => {
        setBooks(b);
        setConnections(c);
        setPrefs(p);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = prefs.theme;
  }, [prefs.theme]);
  useEffect(() => {
    if (!window.moye) return;
    return window.moye.onClosing(() => {
      void flush()
        .then(() => window.moye.closeReady())
        .catch(() =>
          setError("保存失败，窗口已保持打开。请重试保存后再关闭。"),
        );
    });
  }, [flush]);
  const savePrefs = async (p: Preferences) => {
    try {
      const saved = await window.moye.savePreferences(p);
      setPrefs(saved);
    } catch (e) {
      setError(`偏好设置保存失败：${String(e)}`);
    }
  };
  const canNavigate = async () => {
    if (aiBusy) {
      notify("请先停止当前 AI 生成，再切换作品。");
      return false;
    }
    await flush();
    return true;
  };
  const openBook = async (b: Book) => {
    if (!(await canNavigate())) return;
    bookRef.current = b;
    dirty.current = false;
    setBookState(b);
    setBookEpoch((v) => v + 1);
    setChapterId(orderedChapters(b)[0]?.id || "");
    setSettingId(b.settings[0]?.id || "");
    setPage("body");
    setTab("body");
    setOutlineId("synopsis");
    setSelection(null);
    setMenu(false);
    setSaveStatus("已保存");
  };
  const home = () =>
    void safe(async () => {
      if (!(await canNavigate())) return;
      bookRef.current = null;
      setBookState(null);
      setFocus(false);
      setBooks(await window.moye.listBooks());
    });
  const chapter = book?.chapters.find((c) => c.id === chapterId),
    setting = book?.settings.find((s) => s.id === settingId),
    volume = book?.volumes.find((v) => v.id === outlineId);
  const target: Target =
    page === "settings"
      ? { kind: "setting", id: settingId }
      : page === "outline"
        ? outlineId === "synopsis"
          ? { kind: "synopsis", id: book?.id || "" }
          : volume
            ? { kind: "volume", id: outlineId }
            : { kind: "outline", id: outlineId }
        : page === "overview"
          ? { kind: "synopsis", id: book?.id || "" }
          : { kind: tab, id: chapterId };
  const targetKey = `${book?.id}/${target.kind}/${target.id}`,
    targetText = book ? getTarget(book, target) : "";
  const changeText = (value: string, record = true) => {
    if (!book) return;
    if (record) {
      const h = (history.current[targetKey] ??= { undo: [], redo: [] });
      const now = Date.now();
      if (
        lastEdit.current.key !== targetKey ||
        now - lastEdit.current.time > 600
      ) {
        h.undo.push(targetText);
        if (h.undo.length > 100) h.undo.shift();
      }
      h.redo = [];
      lastEdit.current = { key: targetKey, time: now };
    }
    updateBook(setTarget(book, target, value));
  };
  const undo = (redo = false) => {
    const h = history.current[targetKey];
    if (!h) return;
    const source = redo ? h.redo : h.undo,
      dest = redo ? h.undo : h.redo;
    const value = source.pop();
    if (value === undefined) return;
    dest.push(targetText);
    changeText(value, false);
    lastEdit.current = { key: "", time: 0 };
  };
  const navigate = async (fn: () => void) => {
    await flush();
    fn();
    setSelection(null);
    lastEdit.current = { key: "", time: 0 };
  };
  const addChapter = () =>
    void safe(async () => {
      if (!book) return;
      await flush();
      const c = newChapter(
        `第${book.chapters.length + 1}章 未命名`,
        chapter?.volumeId || "",
      );
      updateBook({ ...book, chapters: [...book.chapters, c] });
      setChapterId(c.id);
      setPage("body");
      setTab("body");
      setSelection(null);
    });
  const move = <T,>(items: T[], index: number, delta: number) => {
    const result = [...items];
    if (index + delta < 0 || index + delta >= items.length) return result;
    [result[index], result[index + delta]] = [
      result[index + delta],
      result[index],
    ];
    return result;
  };
  const reorderChapter = (id: string, delta: number) => {
    if (!book) return;
    const c = book.chapters.find((c) => c.id === id)!;
    const group = book.chapters.filter((x) => x.volumeId === c.volumeId);
    const reordered = move(
      group,
      group.findIndex((x) => x.id === id),
      delta,
    );
    let index = 0;
    updateBook({
      ...book,
      chapters: book.chapters.map((x) =>
        x.volumeId === c.volumeId ? reordered[index++] : x,
      ),
    });
  };
  const importText = () =>
    void safe(async () => {
      const result = await window.moye.importText();
      if (result) {
        setImported(result);
        setImportChecked(result.chapters.map((_, i) => i));
        setModal("import");
      }
    });
  const restoreBackup = () =>
    void safe(async () => {
      if (!(await canNavigate())) return;
      const b = await window.moye.restoreBackup();
      if (b) {
        setBooks(await window.moye.listBooks());
        await openBook(b);
        notify("已恢复为独立作品副本");
      }
    });
  const snapshot = () =>
    void safe(async () => {
      if (!book) return;
      await flush();
      await window.moye.snapshot(book.id, "手动保存版本");
      notify("已保存整部作品的版本快照");
    });
  const showVersions = () =>
    void safe(async () => {
      if (!book) return;
      await flush();
      setVersions(await window.moye.versions(book.id));
      setModal("versions");
    });
  const create = () =>
    void safe(async () => {
      if (!newTitle.trim()) return;
      const b = await window.moye.saveBook(
        newBook(newTitle.trim(), newGenre, newDescription),
      );
      setBooks((items) => [b, ...items]);
      setModal(null);
      setNewTitle("");
      setNewDescription("");
      await openBook(b);
    });
  const demo = () =>
    void safe(async () => {
      const b = newBook(
        "雾海来信",
        "幻想 · 悬疑",
        "在海雾吞没记忆的城市，一位邮差收到了一封来自明天的信。",
      );
      b.requirements =
        "第三人称有限视角。以具体动作和细节推进悬念，避免直接解释世界规则。";
      b.settings = [
        {
          id: uid(),
          category: "世界观",
          title: "被雾包围的港城",
          role: "故事舞台",
          traits: "潮湿、静谧，记忆不可靠",
          content:
            "每到黄昏，海雾便穿过街道。人们会忘记当天的一件小事。邮局保存着城里唯一不受雾影响的文字。",
        },
        {
          id: uid(),
          category: "人物",
          title: "林舟",
          role: "主角 · 邮差",
          traits: "敏锐、寡言，对时间有近乎偏执的习惯",
          content:
            "二十七岁，住在旧邮局阁楼。他记得每一个收件人的地址，却忘了自己为何来到这座城市。",
        },
      ];
      b.synopsis =
        "一封提前一天送达的信，将林舟引向城市被抹去的过去。他必须在海雾彻底吞没港城之前，找到那个不断写信的自己。";
      b.volumes = [
        {
          id: uid(),
          title: "第一卷 潮声未至",
          outline: "从一封异常的信开始，揭开邮局与海雾的联系。",
        },
      ];
      b.chapters = [
        {
          ...newChapter("第一章 来自明天的信", b.volumes[0].id),
          outline:
            "林舟在清晨整理邮袋时，发现一封写着明天日期的信。收件人是他自己。",
          body: "雾还没有散。\n\n林舟推开邮局的木门，门轴发出一声低而长的叹息。海风把盐粒留在玻璃上，远处的钟楼只露出一个模糊的轮廓。\n\n他把邮袋放在柜台上，像往常一样，先数了一遍信件。\n\n二十三封。\n\n昨夜装袋时，明明只有二十二封。\n\n多出来的那封信没有邮票。信封是旧式的米黄色，边角微微卷起，像被人攥在手心很久。上面的字迹，他再熟悉不过。\n\n那是他自己的字。\n\n林舟翻过信封。封口处写着一行日期。\n\n明天。",
        },
        newChapter("第二章 消失的街道", b.volumes[0].id),
      ];
      await window.moye.saveBook(b);
      await openBook(b);
    });
  const total = books.reduce(
    (s, b) => s + b.chapters.reduce((n, c) => n + wordCount(c.body), 0),
    0,
  );
  const renderChapter = (c: Book["chapters"][number], i: number) => (
    <div
      className={`chapter-item ${page === "body" && chapterId === c.id ? "active" : ""}`}
      key={c.id}
    >
      <button
        className="chapter-main"
        onClick={() =>
          void safe(() =>
            navigate(() => {
              setChapterId(c.id);
              setPage("body");
              setTab("body");
            }),
          )
        }
      >
        <span className="chapter-number">{String(i + 1).padStart(2, "0")}</span>
        <span>
          {c.title}
          <small>
            {wordCount(c.body).toLocaleString()} 字
            {c.body ? " · 已起笔" : " · 待创作"}
          </small>
        </span>
        {c.body && <span className="written-dot" />}
      </button>
      <div className="chapter-actions">
        <button title="上移章节" onClick={() => reorderChapter(c.id, -1)}>
          <ArrowUp size={12} />
        </button>
        <button title="下移章节" onClick={() => reorderChapter(c.id, 1)}>
          <ArrowDown size={12} />
        </button>
      </div>
    </div>
  );
  return (
    <div className={`app ${focus ? "focus-mode" : ""}`}>
      {!book ? (
        <>
          <header className="library-header">
            <div className="brand">
              <div className="brand-mark">
                <Feather size={22} />
              </div>
              <strong>墨页</strong>
              <span>把想象，写成故事</span>
            </div>
            <div className="row">
              <button
                className="icon"
                title="切换主题"
                onClick={() =>
                  void savePrefs({
                    ...prefs,
                    theme: prefs.theme === "light" ? "dark" : "light",
                  })
                }
              >
                {prefs.theme === "light" ? (
                  <Moon size={18} />
                ) : (
                  <Sun size={18} />
                )}
              </button>
              <button onClick={() => setSettingsOpen(true)}>
                <Settings2 size={16} />
                AI 连接与偏好
              </button>
            </div>
          </header>
          <main className="library">
            <div className="library-hero">
              <div className="eyebrow">YOUR STORIES, YOUR WORLD</div>
              <h1>
                每一个世界，
                <br />
                都从一页开始<span>。</span>
              </h1>
              <p>安放你的灵感，构建你的世界，写下下一章。</p>
              <div className="row">
                <button className="primary" onClick={() => setModal("new")}>
                  <Plus size={17} />
                  创建新作品
                </button>
                <button onClick={importText}>
                  <Upload size={16} />
                  导入作品
                </button>
              </div>
              <div className="hero-decoration">
                <div className="drawn-book">
                  <Feather size={58} />
                  <span>故事尚未结束</span>
                </div>
                <span className="deco-star">✳</span>
              </div>
            </div>
            <div className="shelf-heading">
              <div className="row">
                <h2>我的书架</h2>
                <span className="pill">
                  {books.filter((b) => b.archived === archived).length} 部作品
                </span>
              </div>
              <div className="row">
                <div className="search">
                  <Search size={16} />
                  <input
                    aria-label="搜索作品"
                    placeholder="寻找一个故事…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
                <button
                  className={archived ? "selected" : ""}
                  onClick={() => setArchived(!archived)}
                >
                  <Archive size={16} />
                  {archived ? "已归档" : "归档"}
                </button>
                <button
                  className="icon"
                  title="恢复作品备份"
                  onClick={restoreBackup}
                >
                  <PackageOpen size={19} />
                </button>
              </div>
            </div>
            {loading ? (
              <p className="muted">正在打开本地书架…</p>
            ) : (
              <div className="book-grid">
                {books
                  .filter(
                    (b) =>
                      b.archived === archived &&
                      `${b.title}${b.genre}`.includes(query),
                  )
                  .map((b, i) => (
                    <button
                      className="book-card"
                      key={b.id}
                      onClick={() => void safe(() => openBook(b))}
                    >
                      <div
                        className="book-cover"
                        style={{
                          background: coverColors[i % coverColors.length],
                        }}
                      >
                        <div className="cover-line" />
                        <span className="cover-genre">
                          {b.genre || "未分类"}
                        </span>
                        <h3>{b.title}</h3>
                        <div className="cover-art">
                          <span />
                          <span />
                          <span />
                        </div>
                        <div className="cover-bottom">
                          MOYE ORIGINAL <Feather size={18} />
                        </div>
                      </div>
                      <div className="book-info">
                        <h3>
                          {b.title}
                          <ArrowUpRight size={16} />
                        </h3>
                        <p>{b.description || "故事正在这里生长。"}</p>
                        <div>
                          <span>
                            {b.chapters
                              .reduce((n, c) => n + wordCount(c.body), 0)
                              .toLocaleString()}{" "}
                            字 · {b.chapters.length} 章
                          </span>
                          <span>{date(b.updatedAt)}</span>
                        </div>
                      </div>
                    </button>
                  ))}
                <button
                  className="new-book-card"
                  onClick={() => setModal("new")}
                >
                  <span>
                    <Plus size={28} />
                  </span>
                  <h3>新的故事</h3>
                  <p>给想象一个开始的地方</p>
                </button>
              </div>
            )}
            {!books.length && !loading && (
              <div className="demo-banner">
                <BookOpen size={20} />
                <div>
                  <strong>第一次来到墨页？</strong>
                  <p>打开示例作品，体验设定、大纲与正文的创作流程。</p>
                </div>
                <button onClick={demo}>
                  探索示例 <ArrowUpRight size={16} />
                </button>
              </div>
            )}
            <footer className="library-footer">
              <span>
                <span className="status-dot" /> 所有作品保存在本机
              </span>
              <span>{total.toLocaleString()} 字，都是你的想象。</span>
            </footer>
          </main>
        </>
      ) : (
        <>
          <aside className="sidebar">
            <div className="sidebar-top">
              <button className="back-button" onClick={home}>
                <ArrowLeft size={16} />
                返回书架
              </button>
              <span className="mini-brand">
                <Feather size={19} />
                墨页
              </span>
            </div>
            <div className="project-title">
              <span className="eyebrow">我的创作空间</span>
              <h2>{book.title}</h2>
              <span className="genre-tag">{book.genre || "未分类"}</span>
            </div>
            <nav className="workspace-nav">
              <button
                className={page === "overview" ? "active" : ""}
                onClick={() =>
                  void safe(() => navigate(() => setPage("overview")))
                }
              >
                <Library size={17} />
                作品概览
              </button>
              <button
                className={page === "settings" ? "active" : ""}
                onClick={() =>
                  void safe(() =>
                    navigate(() => {
                      setPage("settings");
                      setSettingId(book.settings[0]?.id || "");
                    }),
                  )
                }
              >
                <Network size={17} />
                故事设定<span>{book.settings.length}</span>
              </button>
              <button
                className={page === "outline" ? "active" : ""}
                onClick={() =>
                  void safe(() => navigate(() => setPage("outline")))
                }
              >
                <Layers size={17} />
                大纲规划
              </button>
              <button
                className={page === "body" ? "active" : ""}
                onClick={() => void safe(() => navigate(() => setPage("body")))}
              >
                <FileText size={17} />
                正文创作<span>{book.chapters.length}</span>
              </button>
            </nav>
            <div className="chapters-label">
              <span>章节目录</span>
              <button className="icon" title="新增章节" onClick={addChapter}>
                <Plus size={16} />
              </button>
            </div>
            <div className="chapters-scroll">
              {book.chapters.filter((c) => !c.volumeId).map(renderChapter)}
              {book.volumes.map((v) => (
                <div key={v.id}>
                  <div className="volume-label">
                    <ChevronDown size={14} />
                    <span>{v.title}</span>
                  </div>
                  {book.chapters
                    .filter((c) => c.volumeId === v.id)
                    .map(renderChapter)}
                </div>
              ))}
              <button className="add-chapter" onClick={addChapter}>
                <Plus size={15} />
                写下新一章
              </button>
            </div>
            <div className="sidebar-bottom">
              <div className="progress-label">
                <span>已写下</span>
                <strong>
                  {book.chapters
                    .reduce((s, c) => s + wordCount(c.body), 0)
                    .toLocaleString()}{" "}
                  <small>字</small>
                </strong>
              </div>
              <div className="progress-line" />
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
                    void savePrefs({
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
                <span className="local-label">
                  <span className="status-dot" />
                  本地存储
                </span>
              </div>
            </div>
          </aside>
          <main className="workspace">
            <header className="workspace-header">
              <div className="breadcrumb">
                <span>{book.title}</span>
                <ChevronRight size={14} />
                <strong>
                  {
                    {
                      body: "正文创作",
                      settings: "故事设定",
                      outline: "大纲规划",
                      overview: "作品概览",
                    }[page]
                  }
                </strong>
              </div>
              <div className="row">
                <button
                  className="save-status"
                  onClick={() => void safe(flush)}
                >
                  <span
                    className={
                      saveStatus.includes("失败") ? "error-dot" : "status-dot"
                    }
                  />
                  {saveStatus}
                </button>
                <button
                  className="icon"
                  title="版本记录"
                  onClick={showVersions}
                >
                  <History size={18} />
                </button>
                <button
                  className="icon"
                  title="导出作品"
                  onClick={() => {
                    setExportIds([]);
                    setModal("export");
                  }}
                >
                  <Download size={18} />
                </button>
                <div className="menu-wrap">
                  <button
                    className="icon"
                    title="更多作品操作"
                    onClick={() => setMenu(!menu)}
                  >
                    <MoreHorizontal size={20} />
                  </button>
                  {menu && (
                    <div className="dropdown">
                      <button
                        onClick={() => {
                          setMenu(false);
                          snapshot();
                        }}
                      >
                        <Save size={15} />
                        保存版本
                      </button>
                      <button
                        onClick={() => {
                          setMenu(false);
                          importText();
                        }}
                      >
                        <Upload size={15} />
                        导入章节
                      </button>
                      <button
                        onClick={() =>
                          void safe(async () => {
                            await flush();
                            if (await window.moye.backup(book.id))
                              notify("作品备份已导出");
                            setMenu(false);
                          })
                        }
                      >
                        <Download size={15} />
                        备份作品与历史
                      </button>
                      <button
                        onClick={() =>
                          void safe(async () => {
                            if (!(await canNavigate())) return;
                            await window.moye.saveBook({
                              ...book,
                              archived: !book.archived,
                            });
                            home();
                          })
                        }
                      >
                        <Archive size={15} />
                        {book.archived ? "取消归档" : "归档作品"}
                      </button>
                      <button
                        className="danger"
                        onClick={() =>
                          void safe(async () => {
                            if (!(await canNavigate())) return;
                            if (
                              !(await confirm(
                                "永久删除这部作品及其全部版本记录？此操作无法撤销。",
                              ))
                            )
                              return;
                            await window.moye.deleteBook(book.id);
                            bookRef.current = null;
                            setBookState(null);
                            setBooks(await window.moye.listBooks());
                          })
                        }
                      >
                        <Trash2 size={15} />
                        删除作品
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </header>
            <div className="workspace-content">
              <section className="editor-area">
                <div className="editor-toolbar">
                  <div className="row">
                    {page === "body" ? (
                      <>
                        <button
                          className={
                            tab === "body" ? "text-tab active" : "text-tab"
                          }
                          onClick={() =>
                            void safe(() => navigate(() => setTab("body")))
                          }
                        >
                          正文
                        </button>
                        <button
                          className={
                            tab === "summary" ? "text-tab active" : "text-tab"
                          }
                          onClick={() =>
                            void safe(() => navigate(() => setTab("summary")))
                          }
                        >
                          章节摘要
                          {chapter?.summary &&
                            chapter.summarySource !==
                              fingerprint(chapter.body) && (
                              <span className="outdated-dot" />
                            )}
                        </button>
                      </>
                    ) : (
                      <span className="toolbar-label">
                        {page === "settings"
                          ? "构建故事的每一处细节"
                          : page === "outline"
                            ? "让灵感成为清晰的路径"
                            : "故事的起点，由你定义"}
                      </span>
                    )}
                  </div>
                  <div className="row">
                    {page === "body" && (
                      <>
                        <button
                          className="icon"
                          title="撤销"
                          onClick={() => undo()}
                        >
                          <Undo2 size={16} />
                        </button>
                        <button
                          className="icon"
                          title="重做"
                          onClick={() => undo(true)}
                        >
                          <Redo2 size={16} />
                        </button>
                        <button
                          className="icon"
                          title="查找替换"
                          onClick={() => setSearchOpen(!searchOpen)}
                        >
                          <Search size={16} />
                        </button>
                      </>
                    )}
                    <button
                      className="icon"
                      title={focus ? "退出专注" : "专注模式"}
                      onClick={() => setFocus(!focus)}
                    >
                      {focus ? (
                        <Minimize2 size={17} />
                      ) : (
                        <Maximize2 size={17} />
                      )}
                    </button>
                    <button
                      className={`ai-toggle ${aiOpen ? "active" : ""}`}
                      onClick={() => setAiOpen(!aiOpen)}
                    >
                      <Sparkles size={15} />
                      AI 助手
                      {aiOpen ? (
                        <PanelRightClose size={15} />
                      ) : (
                        <PanelRightOpen size={15} />
                      )}
                    </button>
                  </div>
                </div>
                {searchOpen && page === "body" && (
                  <div className="find-bar">
                    <input
                      placeholder="查找文本"
                      aria-label="查找文本"
                      value={find}
                      onChange={(e) => setFind(e.target.value)}
                    />
                    <input
                      placeholder="替换为"
                      aria-label="替换为"
                      value={replacement}
                      onChange={(e) => setReplacement(e.target.value)}
                    />
                    <span>
                      {find ? targetText.split(find).length - 1 : 0} 处
                    </span>
                    <button
                      disabled={!find}
                      onClick={() => {
                        const start = targetText.indexOf(
                          find,
                          editor.current?.selectionEnd || 0,
                        );
                        const index =
                          start < 0 ? targetText.indexOf(find) : start;
                        if (index >= 0) {
                          editor.current?.focus();
                          editor.current?.setSelectionRange(
                            index,
                            index + find.length,
                          );
                          setSelection({
                            start: index,
                            end: index + find.length,
                          });
                        }
                      }}
                    >
                      下一处
                    </button>
                    <button
                      disabled={!find || !targetText.includes(find)}
                      onClick={() =>
                        void safe(async () => {
                          await flush();
                          await window.moye.snapshot(book.id, "查找替换前");
                          changeText(targetText.split(find).join(replacement));
                          notify("替换完成，原文已存入版本记录");
                        })
                      }
                    >
                      全部替换
                    </button>
                    <button
                      className="icon"
                      onClick={() => setSearchOpen(false)}
                    >
                      <X size={16} />
                    </button>
                  </div>
                )}
                <div
                  className={`document-scroll ${page === "body" ? "writing-scroll" : ""}`}
                >
                  {page === "body" ? (
                    chapter ? (
                      <div className="manuscript">
                        <div className="chapter-kicker">
                          {book.volumes.find((v) => v.id === chapter.volumeId)
                            ?.title || "正文"}
                          <span> / </span>
                          {String(
                            orderedChapters(book).findIndex(
                              (c) => c.id === chapter.id,
                            ) + 1,
                          ).padStart(2, "0")}
                        </div>
                        <input
                          aria-label="章节标题"
                          className="chapter-title"
                          value={chapter.title}
                          onChange={(e) =>
                            updateBook({
                              ...book,
                              chapters: book.chapters.map((c) =>
                                c.id === chapter.id
                                  ? { ...c, title: e.target.value }
                                  : c,
                              ),
                            })
                          }
                        />
                        <div className="chapter-subline">
                          <span>
                            {wordCount(chapter.body).toLocaleString()} 字
                          </span>
                          <span>每一句，都是故事的一部分</span>
                        </div>
                        {tab === "summary" && (
                          <p className="notice">
                            摘要供后续章节生成参考。
                            {chapter.summary &&
                            chapter.summarySource !== fingerprint(chapter.body)
                              ? "正文已修改，此摘要已过期，请更新后使用。"
                              : "可手动编写，或在 AI 助手中生成后采纳。"}
                          </p>
                        )}
                        <textarea
                          ref={editor}
                          aria-label={tab === "body" ? "章节正文" : "章节摘要"}
                          className={`writing-input ${prefs.font}`}
                          spellCheck={false}
                          value={targetText}
                          onChange={(e) => changeText(e.target.value)}
                          onSelect={(e) =>
                            setSelection({
                              start: e.currentTarget.selectionStart,
                              end: e.currentTarget.selectionEnd,
                            })
                          }
                          onKeyDown={(e) => {
                            if (
                              (e.metaKey || e.ctrlKey) &&
                              e.key.toLowerCase() === "z"
                            ) {
                              e.preventDefault();
                              undo(e.shiftKey);
                            }
                            if (
                              (e.metaKey || e.ctrlKey) &&
                              e.key.toLowerCase() === "s"
                            ) {
                              e.preventDefault();
                              void safe(flush);
                            }
                            if (
                              (e.metaKey || e.ctrlKey) &&
                              e.key.toLowerCase() === "f"
                            ) {
                              e.preventDefault();
                              setSearchOpen(true);
                            }
                          }}
                          style={{
                            fontSize: prefs.fontSize,
                            lineHeight: prefs.lineHeight,
                          }}
                          placeholder={
                            tab === "body"
                              ? "写下第一句话，让故事从这里发生……"
                              : "记录这一章发生了什么、人物有哪些变化，以及尚未解开的疑问。"
                          }
                        />
                        <div className="end-mark">✦</div>
                      </div>
                    ) : (
                      <Empty icon={<FileText size={30} />} title="故事等待开篇">
                        <button onClick={addChapter}>创建第一章</button>
                      </Empty>
                    )
                  ) : page === "overview" ? (
                    <div className="form-document">
                      <div className="eyebrow">THE BEGINNING OF A WORLD</div>
                      <h1>作品概览</h1>
                      <p className="muted">
                        记录最初的灵感，也为 AI 指明创作方向。
                      </p>
                      <label>
                        作品名称
                        <input
                          value={book.title}
                          onChange={(e) =>
                            updateBook({ ...book, title: e.target.value })
                          }
                        />
                      </label>
                      <label>
                        题材与类型
                        <input
                          value={book.genre}
                          onChange={(e) =>
                            updateBook({ ...book, genre: e.target.value })
                          }
                        />
                      </label>
                      <label>
                        故事简介
                        <textarea
                          rows={5}
                          value={book.description}
                          onChange={(e) =>
                            updateBook({ ...book, description: e.target.value })
                          }
                          placeholder="用几句话，描述你的故事。"
                        />
                      </label>
                      <label>
                        全书写作要求
                        <textarea
                          rows={5}
                          value={book.requirements}
                          onChange={(e) =>
                            updateBook({
                              ...book,
                              requirements: e.target.value,
                            })
                          }
                          placeholder="叙事视角、文风、节奏，或希望避免的写法……"
                        />
                      </label>
                      <div className="overview-stats">
                        <div>
                          <strong>{book.settings.length}</strong>
                          <span>条故事设定</span>
                        </div>
                        <div>
                          <strong>{book.chapters.length}</strong>
                          <span>个章节</span>
                        </div>
                        <div>
                          <strong>
                            {book.chapters
                              .reduce((s, c) => s + wordCount(c.body), 0)
                              .toLocaleString()}
                          </strong>
                          <span>字已落笔</span>
                        </div>
                      </div>
                    </div>
                  ) : page === "settings" ? (
                    <div className="form-document">
                      <div className="section-top">
                        <div>
                          <div className="eyebrow">WORLD BUILDING</div>
                          <h1>故事设定</h1>
                        </div>
                        <button
                          onClick={() => {
                            const s: Setting = {
                              id: uid(),
                              category: "人物",
                              title: "未命名设定",
                              role: "",
                              traits: "",
                              content: "",
                            };
                            updateBook({
                              ...book,
                              settings: [...book.settings, s],
                            });
                            setSettingId(s.id);
                          }}
                        >
                          <Plus size={16} />
                          添加设定
                        </button>
                      </div>
                      <div className="setting-chips">
                        {book.settings.map((s) => (
                          <button
                            key={s.id}
                            className={settingId === s.id ? "active" : ""}
                            onClick={() =>
                              void safe(() =>
                                navigate(() => setSettingId(s.id)),
                              )
                            }
                          >
                            <span>{s.category}</span>
                            {s.title || "未命名"}
                          </button>
                        ))}
                      </div>
                      {setting ? (
                        <>
                          <div className="form-grid">
                            <label>
                              名称
                              <input
                                value={setting.title}
                                onChange={(e) =>
                                  updateBook({
                                    ...book,
                                    settings: book.settings.map((s) =>
                                      s.id === setting.id
                                        ? { ...s, title: e.target.value }
                                        : s,
                                    ),
                                  })
                                }
                              />
                            </label>
                            <label>
                              类别
                              <select
                                value={setting.category}
                                onChange={(e) =>
                                  updateBook({
                                    ...book,
                                    settings: book.settings.map((s) =>
                                      s.id === setting.id
                                        ? {
                                            ...s,
                                            category: e.target
                                              .value as Setting["category"],
                                          }
                                        : s,
                                    ),
                                  })
                                }
                              >
                                {categories.map((c) => (
                                  <option key={c}>{c}</option>
                                ))}
                              </select>
                            </label>
                          </div>
                          <label>
                            定位 / 身份
                            <input
                              value={setting.role}
                              onChange={(e) =>
                                updateBook({
                                  ...book,
                                  settings: book.settings.map((s) =>
                                    s.id === setting.id
                                      ? { ...s, role: e.target.value }
                                      : s,
                                  ),
                                })
                              }
                              placeholder="在故事中扮演什么角色？"
                            />
                          </label>
                          <label>
                            特征 / 关键词
                            <input
                              value={setting.traits}
                              onChange={(e) =>
                                updateBook({
                                  ...book,
                                  settings: book.settings.map((s) =>
                                    s.id === setting.id
                                      ? { ...s, traits: e.target.value }
                                      : s,
                                  ),
                                })
                              }
                            />
                          </label>
                          <label>
                            详细设定
                            <textarea
                              rows={13}
                              value={setting.content}
                              onChange={(e) => changeText(e.target.value)}
                              placeholder="背景、动机、关系、秘密……"
                            />
                          </label>
                          <button
                            className="danger text-button"
                            onClick={() =>
                              void safe(async () => {
                                if (
                                  !(await confirm(
                                    "删除这条设定？删除前将保存作品版本。",
                                  ))
                                )
                                  return;
                                await flush();
                                await window.moye.snapshot(
                                  book.id,
                                  "删除设定前",
                                );
                                const settings = book.settings.filter(
                                  (s) => s.id !== setting.id,
                                );
                                updateBook({ ...book, settings });
                                setSettingId(settings[0]?.id || "");
                              })
                            }
                          >
                            <Trash2 size={14} />
                            删除此设定
                          </button>
                        </>
                      ) : (
                        <Empty
                          icon={<Network size={32} />}
                          title="让你的世界有迹可循"
                        >
                          从一个人物、一座城市，或一条独特的规则开始。
                        </Empty>
                      )}
                    </div>
                  ) : (
                    <div className="form-document">
                      <div className="section-top">
                        <div>
                          <div className="eyebrow">STORY ARCHITECTURE</div>
                          <h1>大纲规划</h1>
                        </div>
                        <button
                          onClick={() => {
                            const v = {
                              id: uid(),
                              title: `第${book.volumes.length + 1}卷 未命名`,
                              outline: "",
                            };
                            updateBook({
                              ...book,
                              volumes: [...book.volumes, v],
                            });
                            setOutlineId(v.id);
                          }}
                        >
                          <Plus size={16} />
                          添加分卷
                        </button>
                      </div>
                      <label>
                        正在编辑
                        <select
                          value={outlineId}
                          onChange={(e) => {
                            const value = e.target.value;
                            void safe(() =>
                              navigate(() => setOutlineId(value)),
                            );
                          }}
                        >
                          <option value="synopsis">全书大纲</option>
                          {book.volumes.map((v) => (
                            <option value={v.id} key={v.id}>
                              分卷 · {v.title}
                            </option>
                          ))}
                          {orderedChapters(book).map((c) => (
                            <option value={c.id} key={c.id}>
                              章纲 · {c.title}
                            </option>
                          ))}
                        </select>
                      </label>
                      {volume && (
                        <>
                          <label>
                            分卷名称
                            <input
                              value={volume.title}
                              onChange={(e) =>
                                updateBook({
                                  ...book,
                                  volumes: book.volumes.map((v) =>
                                    v.id === volume.id
                                      ? { ...v, title: e.target.value }
                                      : v,
                                  ),
                                })
                              }
                            />
                          </label>
                          <div className="row">
                            <button
                              onClick={() =>
                                updateBook({
                                  ...book,
                                  volumes: move(
                                    book.volumes,
                                    book.volumes.findIndex(
                                      (v) => v.id === volume.id,
                                    ),
                                    -1,
                                  ),
                                })
                              }
                            >
                              <ArrowUp size={14} />
                              上移
                            </button>
                            <button
                              onClick={() =>
                                updateBook({
                                  ...book,
                                  volumes: move(
                                    book.volumes,
                                    book.volumes.findIndex(
                                      (v) => v.id === volume.id,
                                    ),
                                    1,
                                  ),
                                })
                              }
                            >
                              <ArrowDown size={14} />
                              下移
                            </button>
                            <button
                              className="danger"
                              onClick={() =>
                                void safe(async () => {
                                  if (
                                    !(await confirm(
                                      "删除此分卷？卷内章节将移至未分卷区域。",
                                    ))
                                  )
                                    return;
                                  await flush();
                                  await window.moye.snapshot(
                                    book.id,
                                    "删除分卷前",
                                  );
                                  updateBook({
                                    ...book,
                                    volumes: book.volumes.filter(
                                      (v) => v.id !== volume.id,
                                    ),
                                    chapters: book.chapters.map((c) =>
                                      c.volumeId === volume.id
                                        ? { ...c, volumeId: "" }
                                        : c,
                                    ),
                                  });
                                  setOutlineId("synopsis");
                                })
                              }
                            >
                              <Trash2 size={14} />
                              删除分卷
                            </button>
                          </div>
                        </>
                      )}
                      <label>
                        {outlineId === "synopsis"
                          ? "全书情节脉络"
                          : volume
                            ? "这一卷的故事走向"
                            : "这一章将发生什么"}
                        <textarea
                          rows={18}
                          value={targetText}
                          onChange={(e) => changeText(e.target.value)}
                          placeholder="起点、转折、冲突和结局。先让故事有一个方向。"
                        />
                      </label>
                      <p className="tiny muted">
                        在右侧选择“拆分章节”，可将大纲展开成待确认的章节列表。
                      </p>
                    </div>
                  )}
                </div>
                <footer className="editor-footer">
                  <span>
                    <span className="status-dot" />
                    创作属于你
                  </span>
                  <div className="row">
                    {page === "body" && chapter && (
                      <>
                        <select
                          aria-label="章节所属分卷"
                          value={chapter.volumeId}
                          onChange={(e) =>
                            updateBook({
                              ...book,
                              chapters: book.chapters.map((c) =>
                                c.id === chapter.id
                                  ? { ...c, volumeId: e.target.value }
                                  : c,
                              ),
                            })
                          }
                        >
                          <option value="">未分卷</option>
                          {book.volumes.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.title}
                            </option>
                          ))}
                        </select>
                        <button
                          className="icon"
                          title="删除当前章节"
                          onClick={() =>
                            void safe(async () => {
                              if (
                                !(await confirm(
                                  "删除当前章节？删除前会保存作品版本。",
                                ))
                              )
                                return;
                              await flush();
                              await window.moye.snapshot(book.id, "删除章节前");
                              const chapters = book.chapters.filter(
                                (c) => c.id !== chapter.id,
                              );
                              updateBook({ ...book, chapters });
                              setChapterId(chapters[0]?.id || "");
                            })
                          }
                        >
                          <Trash2 size={13} />
                        </button>
                        <select
                          aria-label="正文字体"
                          value={prefs.font}
                          onChange={(e) =>
                            void savePrefs({
                              ...prefs,
                              font: e.target.value as Preferences["font"],
                            })
                          }
                        >
                          <option value="serif">宋体</option>
                          <option value="sans">黑体</option>
                        </select>
                        <select
                          aria-label="字号"
                          value={prefs.fontSize}
                          onChange={(e) =>
                            void savePrefs({
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
                          aria-label="行距"
                          value={prefs.lineHeight}
                          onChange={(e) =>
                            void savePrefs({
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
                      </>
                    )}
                  </div>
                </footer>
              </section>
              <div
                className={
                  !aiOpen || focus ? "ai-wrapper hidden" : "ai-wrapper"
                }
              >
                <AIPanel
                  key={`${book.id}-${bookEpoch}`}
                  book={book}
                  target={target}
                  selection={selection}
                  connections={connections}
                  prefs={prefs}
                  flush={flush}
                  onBook={updateBook}
                  notify={notify}
                  confirm={confirm}
                  onBusy={setAiBusy}
                  onSettings={() => setSettingsOpen(true)}
                  onClose={() => setAiOpen(false)}
                />
              </div>
            </div>
          </main>
        </>
      )}
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button onClick={() => setError("")}>
            <X size={16} />
          </button>
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
      {settingsOpen && (
        <Settings
          connections={connections}
          prefs={prefs}
          onConnections={setConnections}
          onPrefs={savePrefs}
          notify={notify}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {modal === "new" && (
        <Modal title="开启一个新故事" onClose={() => setModal(null)}>
          <div className="modal-body">
            <p className="muted">
              不用急着想好一切。给它一个名字，就可以开始。
            </p>
            <label>
              作品名称
              <input
                autoFocus
                placeholder="你的故事叫什么？"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") create();
                }}
              />
            </label>
            <label>
              题材 / 类型
              <input
                value={newGenre}
                onChange={(e) => setNewGenre(e.target.value)}
              />
            </label>
            <label>
              一句话灵感
              <textarea
                rows={3}
                placeholder="一个角色，一次相遇，一场意外……"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
              />
            </label>
            <div className="modal-actions">
              <button onClick={() => setModal(null)}>稍后再说</button>
              <button
                className="primary"
                disabled={!newTitle.trim()}
                onClick={create}
              >
                <Feather size={16} />
                开始创作
              </button>
            </div>
          </div>
        </Modal>
      )}
      {modal === "versions" && book && (
        <Modal title="作品版本记录" onClose={() => setModal(null)}>
          <div className="modal-body">
            <p className="muted">
              每个版本包含整部作品的设定、大纲和正文。恢复前会自动备份当前版本。
            </p>
            <button
              onClick={() =>
                void safe(async () => {
                  await flush();
                  await window.moye.snapshot(book.id, "手动保存版本");
                  setVersions(await window.moye.versions(book.id));
                })
              }
            >
              <Plus size={16} />
              保存当前版本
            </button>
            <div className="version-list">
              {versions.map((v) => (
                <div key={v.id}>
                  <History size={17} />
                  <span>
                    <strong>{v.reason}</strong>
                    <small>
                      {date(v.createdAt)} ·{" "}
                      {v.book.chapters.reduce(
                        (s, c) => s + wordCount(c.body),
                        0,
                      )}{" "}
                      字
                    </small>
                  </span>
                  <button
                    disabled={aiBusy}
                    onClick={() =>
                      void safe(async () => {
                        if (
                          !(await confirm(
                            "恢复此版本的整部作品？当前内容会先保存为一个新版本。",
                          ))
                        )
                          return;
                        await flush();
                        const restored = await window.moye.restoreVersion(
                          book.id,
                          v.id,
                        );
                        history.current = {};
                        await openBook(restored);
                        setModal(null);
                        notify("作品版本已恢复");
                      })
                    }
                  >
                    恢复
                  </button>
                </div>
              ))}
              {!versions.length && (
                <p className="muted">
                  还没有版本记录。保存一个版本，留住此刻的故事。
                </p>
              )}
            </div>
          </div>
        </Modal>
      )}
      {modal === "export" && book && (
        <Modal title="导出作品" onClose={() => setModal(null)}>
          <div className="modal-body">
            <label>
              导出格式
              <select
                value={exportFormat}
                onChange={(e) =>
                  setExportFormat(e.target.value as "txt" | "md")
                }
              >
                <option value="txt">纯文本 TXT</option>
                <option value="md">Markdown</option>
              </select>
            </label>
            <p className="muted">不勾选章节时导出整部作品；也可以指定章节。</p>
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
            <div className="modal-actions">
              <button
                className="primary"
                onClick={() =>
                  void safe(async () => {
                    await flush();
                    if (
                      await window.moye.exportText(
                        book.id,
                        exportIds,
                        exportFormat,
                      )
                    ) {
                      setModal(null);
                      notify("作品已导出");
                    }
                  })
                }
              >
                <Download size={16} />
                导出{exportIds.length ? "选定章节" : "整部作品"}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {modal === "import" && imported && (
        <Modal title="预览导入章节" wide onClose={() => setModal(null)}>
          <div className="modal-body">
            <p className="muted">
              {imported.name} · {imported.encoding} · 识别到{" "}
              {imported.chapters.length} 章。
              {book ? "将追加到当前作品。" : "将创建新作品。"}
            </p>
            <div className="import-list">
              {imported.chapters.map((c, i) => (
                <div key={i}>
                  <input
                    type="checkbox"
                    aria-label={`导入第${i + 1}项`}
                    checked={importChecked.includes(i)}
                    onChange={() =>
                      setImportChecked((ids) =>
                        ids.includes(i)
                          ? ids.filter((x) => x !== i)
                          : [...ids, i],
                      )
                    }
                  />
                  <div>
                    <input
                      aria-label={`导入标题${i + 1}`}
                      value={c.title}
                      onChange={(e) =>
                        setImported({
                          ...imported,
                          chapters: imported.chapters.map((x, j) =>
                            j === i ? { ...x, title: e.target.value } : x,
                          ),
                        })
                      }
                    />
                    <p>{c.body.slice(0, 150) || "空章节"}</p>
                    <small>{wordCount(c.body)} 字</small>
                  </div>
                </div>
              ))}
            </div>
            <div className="modal-actions">
              <button
                onClick={() => {
                  setImported({
                    ...imported,
                    chapters: [
                      {
                        title: imported.name,
                        body: imported.chapters
                          .map((c) => c.title + "\n\n" + c.body)
                          .join("\n\n"),
                      },
                    ],
                  });
                  setImportChecked([0]);
                }}
              >
                合并为单章
              </button>
              <button
                className="primary"
                disabled={!importChecked.length}
                onClick={() =>
                  void safe(async () => {
                    const chapters = imported.chapters
                      .filter((_, i) => importChecked.includes(i))
                      .map((c) => ({ ...newChapter(c.title), body: c.body }));
                    if (!chapters.length) return;
                    if (book) {
                      await flush();
                      await window.moye.snapshot(book.id, "导入章节前");
                      updateBook({
                        ...book,
                        chapters: [...book.chapters, ...chapters],
                      });
                      await flush();
                      setChapterId(chapters[0].id);
                      setPage("body");
                    } else {
                      const b = { ...newBook(imported.name), chapters };
                      await window.moye.saveBook(b);
                      await openBook(b);
                    }
                    setModal(null);
                    notify(`已导入 ${chapters.length} 个章节`);
                  })
                }
              >
                确认导入{" "}
                {
                  importChecked.filter((i) => i < imported.chapters.length)
                    .length
                }{" "}
                章
              </button>
            </div>
          </div>
        </Modal>
      )}
      {confirmState && (
        <Modal
          title="请确认"
          onClose={() => {
            confirmState.resolve(false);
            setConfirmState(null);
          }}
        >
          <div className="modal-body">
            <p className="confirm-message">{confirmState.message}</p>
            <div className="modal-actions">
              <button
                onClick={() => {
                  confirmState.resolve(false);
                  setConfirmState(null);
                }}
              >
                取消
              </button>
              <button
                className="primary"
                onClick={() => {
                  confirmState.resolve(true);
                  setConfirmState(null);
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
