import { useEffect, useMemo, useRef, useState } from "react";
import {
  Sparkles,
  Square,
  ChevronDown,
  SlidersHorizontal,
  ArrowUpRight,
  Check,
  Copy,
  X,
} from "lucide-react";
import {
  buildPrompt,
  estimateTokens,
  getTarget,
  setTarget,
  uid,
  newChapter,
  orderedChapters,
  fingerprint,
  splitChapters,
  type Book,
  type Target,
  type Draft,
  type Connection,
  type Preferences,
} from "../shared/model";
import { Busy } from "./components";
export default function AIPanel({
  book,
  target,
  selection,
  connections,
  prefs,
  flush,
  onBook,
  notify,
  confirm,
  onBusy,
  onSettings,
  onClose,
}: {
  book: Book;
  target: Target;
  selection: { start: number; end: number } | null;
  connections: Connection[];
  prefs: Preferences;
  flush: () => Promise<void>;
  onBook: (b: Book) => void;
  notify: (s: string) => void;
  confirm: (s: string) => Promise<boolean>;
  onBusy: (b: boolean) => void;
  onSettings: () => void;
  onClose: () => void;
}) {
  const [action, setAction] = useState("生成初稿"),
    [connectionId, setConnectionId] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [words, setWords] = useState("2000"),
    [perspective, setPerspective] = useState("第三人称"),
    [style, setStyle] = useState(""),
    [extra, setExtra] = useState(""),
    [preview, setPreview] = useState(false),
    [contextOpen, setContextOpen] = useState(false),
    [draft, setDraft] = useState<Draft | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const draftRef = useRef<Draft | null>(null),
    bookRef = useRef(book);
  bookRef.current = book;
  const setCandidate = (d: Draft | null) => {
    draftRef.current = d;
    setDraft(d);
  };
  const actions =
    target.kind === "body"
      ? ["生成初稿", "续写", "改写选段", "扩写选段", "润色选段", "生成章节摘要"]
      : target.kind === "setting"
        ? ["生成设定", "补全设定", "改写设定"]
        : target.kind === "summary"
          ? ["生成章节摘要", "精炼摘要"]
          : ["生成大纲", "展开大纲", "拆分章节"];
  useEffect(() => {
    setAction(
      target.kind === "body"
        ? "生成初稿"
        : target.kind === "setting"
          ? "生成设定"
          : target.kind === "summary"
            ? "生成章节摘要"
            : "生成大纲",
    );
    const category =
      target.kind === "setting"
        ? "setting"
        : ["body", "summary"].includes(target.kind)
          ? "body"
          : "outline";
    setConnectionId(prefs.defaults[category] || connections[0]?.id || "");
  }, [target.kind, prefs.defaults, connections]);
  useEffect(() => {
    const chapter = book.chapters.find((c) => c.id === target.id);
    const ordered = orderedChapters(book);
    const index = chapter ? ordered.findIndex((c) => c.id === chapter.id) : 0;
    setSelected([
      "synopsis",
      ...book.settings.map((s) => s.id),
      ...ordered
        .slice(Math.max(0, index - 3), index)
        .filter((c) => c.summary)
        .map((c) => `summary:${c.id}`),
    ]);
  }, [book.id, target.id]);
  useEffect(() => {
    let active = true;
    window.moye
      .drafts(book.id)
      .then((ds) => {
        if (active && ds.length)
          setCandidate({
            ...ds[0],
            status: ds[0].status === "running" ? "stopped" : ds[0].status,
          });
      })
      .catch((e) => notify(String(e)));
    return () => {
      active = false;
    };
  }, [book.id]);
  useEffect(
    () =>
      window.moye.onAI((event) => {
        const d = draftRef.current;
        if (!d || d.id !== event.id) return;
        if (event.type === "chunk")
          setCandidate({ ...d, text: d.text + (event.text || "") });
        else {
          setCandidate({
            ...d,
            status:
              event.type === "error"
                ? "error"
                : event.stopped
                  ? "stopped"
                  : "complete",
          });
          setBusy(false);
          onBusy(false);
          if (event.type === "error") setError(event.text || "生成失败");
        }
      }),
    [onBusy],
  );
  const effectiveTarget =
    action === "生成章节摘要"
      ? { kind: "summary" as const, id: target.id }
      : target;
  const selectedText =
    target.kind === "body" && selection && selection.end > selection.start
      ? getTarget(book, target).slice(selection.start, selection.end)
      : "";
  const needsSelection = action.includes("选段");
  const prompt = useMemo(
    () =>
      buildPrompt(book, effectiveTarget, action, selected, {
        words,
        perspective,
        style,
        extra:
          (action === "拆分章节"
            ? "按“## 第X章 标题”分节，每节只写章节大纲，不写正文。\n"
            : "") + extra,
        selection: needsSelection ? selectedText : "",
      }),
    [
      book,
      target,
      action,
      selected,
      words,
      perspective,
      style,
      extra,
      selectedText,
    ],
  );
  const connection = connections.find((c) => c.id === connectionId),
    tokens = estimateTokens(prompt),
    over =
      !!connection &&
      tokens + connection.outputTokens > connection.contextTokens;
  const run = async () => {
    setError("");
    const exists =
      effectiveTarget.kind === "synopsis" ||
      (effectiveTarget.kind === "setting"
        ? book.settings
        : effectiveTarget.kind === "volume"
          ? book.volumes
          : book.chapters
      ).some((x) => x.id === effectiveTarget.id);
    if (!exists) {
      setError("请先创建并选择一个设定或章节。");
      return;
    }
    if (!connection) {
      onSettings();
      return;
    }
    if (needsSelection && !selectedText) {
      setError("请先在正文中选中需要修改的段落。");
      return;
    }
    if (over) {
      setPreview(true);
      return;
    }
    try {
      await flush();
      const d: Draft = {
        id: uid(),
        bookId: book.id,
        target: effectiveTarget,
        baseline: getTarget(book, effectiveTarget),
        text: "",
        action,
        selection: needsSelection ? selection : null,
        sourceFingerprint:
          effectiveTarget.kind === "summary"
            ? fingerprint(
                book.chapters.find((c) => c.id === effectiveTarget.id)?.body ||
                  "",
              )
            : undefined,
        createdAt: new Date().toISOString(),
        status: "running",
      };
      await window.moye.saveDraft(d);
      setCandidate(d);
      setBusy(true);
      onBusy(true);
      await window.moye.generate({
        id: d.id,
        bookId: book.id,
        connectionId,
        prompt,
      });
    } catch (e) {
      setBusy(false);
      onBusy(false);
      setError(String(e));
    }
  };
  const discard = async () => {
    if (!draft) return;
    if (
      draft.text &&
      !(await confirm("放弃这份 AI 候选稿？已经写入作品的内容不受影响。"))
    )
      return;
    try {
      await window.moye.deleteDraft(draft.id);
      setCandidate(null);
      setError("");
    } catch (e) {
      setError(String(e));
    }
  };
  const adopt = async (mode: "insert" | "replace" | "chapters") => {
    if (!draft || busy) return;
    try {
      let current = bookRef.current;
      const original = getTarget(current, draft.target);
      let next = original;
      const exists =
        draft.target.kind === "synopsis" ||
        (draft.target.kind === "setting"
          ? current.settings
          : draft.target.kind === "volume"
            ? current.volumes
            : current.chapters
        ).some((x) => x.id === draft.target.id);
      if (!exists) throw new Error("原目标已被删除，请复制候选稿到其他位置。");
      if (mode === "chapters") {
        const chapters = splitChapters(draft.text);
        if (
          !(await confirm(
            `将创建 ${chapters.length} 个章节，生成内容保存到章节大纲。正文保持空白。`,
          ))
        )
          return;
        await flush();
        await window.moye.snapshot(current.id, "AI 拆分章节前");
        const volumeId =
          draft.target.kind === "volume"
            ? draft.target.id
            : current.chapters.find((c) => c.id === draft.target.id)
                ?.volumeId || "";
        current = {
          ...current,
          chapters: [
            ...current.chapters,
            ...chapters.map((c) => ({
              ...newChapter(c.title, volumeId),
              outline: c.body,
            })),
          ],
        };
      } else {
        if (mode === "insert")
          next = original + (original ? "\n\n" : "") + draft.text;
        else if (draft.selection) {
          let range = draft.selection;
          if (original !== draft.baseline) {
            if (
              target.id !== draft.target.id ||
              target.kind !== draft.target.kind ||
              !selection ||
              selection.end === selection.start
            )
              throw new Error(
                "生成期间正文已修改。请重新选中替换范围，或使用“追加”保留当前正文。",
              );
            if (
              !(await confirm(
                `正文已变化，确认用候选稿替换现在选中的 ${selection.end - selection.start} 个字符？`,
              ))
            )
              return;
            range = selection;
          }
          next =
            original.slice(0, range.start) +
            draft.text +
            original.slice(range.end);
        } else {
          if (
            original !== draft.baseline &&
            !(await confirm(
              "目标内容在生成后已变化，仍要用候选稿替换当前全部内容？替换前会保存版本。",
            ))
          )
            return;
          next = draft.text;
        }
        await flush();
        await window.moye.snapshot(current.id, `AI ${draft.action}采纳前`);
        current = setTarget(current, draft.target, next);
        if (draft.target.kind === "summary") {
          current = {
            ...current,
            chapters: current.chapters.map((c) =>
              c.id === draft.target.id
                ? { ...c, summarySource: draft.sourceFingerprint || "" }
                : c,
            ),
          };
        }
      }
      // Save the adopted content before removing its recoverable draft.
      onBook(current);
      await flush();
      await window.moye.deleteDraft(draft.id);
      setCandidate(null);
      setError("");
      notify("已采纳，替换前的内容可在版本记录中恢复。");
    } catch (e) {
      setError(String(e));
    }
  };
  const summaryCandidates = orderedChapters(book)
    .slice(
      0,
      Math.max(
        0,
        orderedChapters(book).findIndex((c) => c.id === target.id),
      ),
    )
    .filter((c) => c.summary);
  const toggle = (id: string) =>
    setSelected((s) =>
      s.includes(id) ? s.filter((x) => x !== id) : [...s, id],
    );
  return (
    <aside className="ai-panel">
      <header className="ai-heading">
        <span className="ai-icon">
          <Sparkles size={18} />
        </span>
        <div>
          <strong>灵感助手</strong>
          <small>让故事，向前一步</small>
        </div>
        <button className="icon" title="收起 AI 面板" onClick={onClose}>
          <X size={17} />
        </button>
      </header>
      <div className="ai-scroll">
        <div className="ai-intro">
          你掌握故事的方向。
          <br />
          <span>AI 帮你探索下一种可能。</span>
        </div>
        <label>
          创作伙伴
          <select
            value={connectionId}
            onChange={(e) => setConnectionId(e.target.value)}
            disabled={busy}
          >
            {connections.length ? (
              connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {c.model}
                </option>
              ))
            ) : (
              <option value="">尚未配置 AI 服务</option>
            )}
          </select>
        </label>
        {!connections.length && (
          <button className="text-button" onClick={onSettings}>
            连接自己的 AI <ArrowUpRight size={14} />
          </button>
        )}
        {!draft ? (
          <>
            <div className="section-label">这次，我们做什么</div>
            <div className="action-grid">
              {actions.map((a) => (
                <button
                  key={a}
                  className={action === a ? "active" : ""}
                  onClick={() => setAction(a)}
                >
                  {a}
                </button>
              ))}
            </div>
            {needsSelection && (
              <p className="tiny muted">
                {selectedText
                  ? `已选中 ${selectedText.length} 个字符`
                  : "在正文中选择一段文字，再开始生成。"}
              </p>
            )}
            <div className="form-grid">
              <label>
                目标字数
                <input
                  type="number"
                  min="50"
                  max="30000"
                  value={words}
                  onChange={(e) => setWords(e.target.value)}
                />
              </label>
              <label>
                叙事视角
                <select
                  value={perspective}
                  onChange={(e) => setPerspective(e.target.value)}
                >
                  <option>第三人称</option>
                  <option>第一人称</option>
                  <option>遵循原文</option>
                </select>
              </label>
            </div>
            <label>
              文风
              <input
                value={style}
                onChange={(e) => setStyle(e.target.value)}
                placeholder="例如：克制、细腻，保留悬念"
              />
            </label>
            <label>
              给 AI 的补充要求
              <textarea
                rows={3}
                value={extra}
                onChange={(e) => setExtra(e.target.value)}
                placeholder="这一段，你希望故事如何发生？"
              />
            </label>
            <button
              className="context-toggle"
              onClick={() => setContextOpen(!contextOpen)}
            >
              <SlidersHorizontal size={15} />
              参考资料 <span>{selected.length} 项</span>
              <ChevronDown size={15} />
            </button>
            {contextOpen && (
              <div className="context-list">
                <label>
                  <input
                    type="checkbox"
                    checked={selected.includes("synopsis")}
                    onChange={() => toggle("synopsis")}
                  />
                  全书大纲
                </label>
                {book.settings.map((s) => (
                  <label key={s.id}>
                    <input
                      type="checkbox"
                      checked={selected.includes(s.id)}
                      onChange={() => toggle(s.id)}
                    />
                    {s.category} · {s.title || "未命名"}
                  </label>
                ))}
                {summaryCandidates.map((c) => (
                  <label key={c.id}>
                    <input
                      type="checkbox"
                      checked={selected.includes(`summary:${c.id}`)}
                      onChange={() => toggle(`summary:${c.id}`)}
                    />
                    {c.title} 摘要
                    {c.summarySource !== fingerprint(c.body) ? " · 已过期" : ""}
                  </label>
                ))}
                <p className="tiny muted">
                  简介、写作要求和当前目标内容始终包含。章节任务另附当前卷与章纲。
                </p>
              </div>
            )}
            <button
              className="text-button tiny"
              onClick={() => setPreview(!preview)}
            >
              预览发送内容 · 约 {tokens.toLocaleString()} tokens
            </button>
            {preview && <pre className="prompt-preview">{prompt}</pre>}
            {over && (
              <p className="error">
                内容与输出上限合计超过上下文预算，请减少资料或调整连接设置。
              </p>
            )}
            <button
              className="primary generate"
              disabled={over}
              onClick={() => void run()}
            >
              <Sparkles size={16} />
              开始生成
            </button>
            <p className="ai-note">
              只向选定服务发送本次参考内容
              <br />
              生成结果由你决定是否采纳
            </p>
          </>
        ) : (
          <div className="candidate">
            <div className="candidate-heading">
              <span>
                {busy ? <Busy /> : <Check size={15} />} {draft.action} ·{" "}
                {busy
                  ? "生成中"
                  : draft.status === "stopped"
                    ? "已停止"
                    : "待审阅"}
              </span>
              {busy && (
                <button
                  onClick={() =>
                    void window.moye
                      .cancel(draft.id)
                      .catch((e) => setError(String(e)))
                  }
                >
                  <Square size={12} />
                  停止
                </button>
              )}
            </div>
            <p className="tiny muted">候选稿独立保存，正文尚未改变。</p>
            <textarea
              aria-label="AI 候选稿"
              className="candidate-text"
              value={draft.text}
              readOnly={busy}
              onChange={(e) => {
                const next = { ...draft, text: e.target.value };
                setCandidate(next);
                void window.moye
                  .saveDraft(next)
                  .catch((e) => setError(String(e)));
              }}
              onBlur={() => {
                if (!busy && draftRef.current)
                  void window.moye
                    .saveDraft(draftRef.current)
                    .catch((e) => setError(String(e)));
              }}
              placeholder="正在等待模型回应…"
            />
            {draft.action === "拆分章节" && draft.text && (
              <div className="chapter-preview">
                {splitChapters(draft.text).map((c, i) => (
                  <div key={i}>
                    {i + 1}. {c.title}
                  </div>
                ))}
              </div>
            )}
            <div className="candidate-buttons">
              <button
                className="primary"
                disabled={busy || !draft.text}
                onClick={() =>
                  void adopt(
                    draft.action === "拆分章节"
                      ? "chapters"
                      : draft.action === "续写"
                        ? "insert"
                        : "replace",
                  )
                }
              >
                {draft.action === "拆分章节"
                  ? "确认创建章节"
                  : draft.action === "续写"
                    ? "接续正文"
                    : draft.selection
                      ? "替换选段"
                      : "替换目标内容"}
              </button>
              <button
                disabled={busy || !draft.text}
                onClick={() => void adopt("insert")}
              >
                追加
              </button>
              <button
                className="icon"
                title="复制候选稿"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(draft.text)
                    .then(() => notify("已复制候选稿"))
                    .catch((e) => setError(String(e)))
                }
              >
                <Copy size={15} />
              </button>
              <button disabled={busy} onClick={() => void discard()}>
                放弃
              </button>
            </div>
          </div>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
      <footer className="ai-footer">
        <span className="status-dot" /> 独立候选稿 · 采纳前不覆盖作品
      </footer>
    </aside>
  );
}
