import { useState } from "react";
import { Plus, Trash2, Plug, ShieldCheck } from "lucide-react";
import {
  providers,
  uid,
  type Connection,
  type Preferences,
} from "../shared/model";
import { Modal, Busy } from "./components";
export default function Settings({
  connections,
  prefs,
  onConnections,
  onPrefs,
  onClose,
  notify,
}: {
  connections: Connection[];
  prefs: Preferences;
  onConnections: (c: Connection[]) => void;
  onPrefs: (p: Preferences) => Promise<void>;
  onClose: () => void;
  notify: (s: string) => void;
}) {
  const [editing, setEditing] = useState<Connection | null>(
      connections[0] || null,
    ),
    [key, setKey] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const edit = (c: Connection) => {
    setEditing({ ...c });
    setKey("");
    setMessage("");
  };
  const add = () =>
    edit({
      id: uid(),
      name: "新连接",
      provider: "openai",
      baseUrl: providers[0].baseUrl,
      model: "",
      temperature: null,
      outputTokens: 4096,
      contextTokens: 32000,
      tokenParam: "max_completion_tokens",
    });
  const change = (v: Partial<Connection>) =>
    setEditing((c) => (c ? { ...c, ...v } : c));
  const save = async (test = false) => {
    if (!editing) return;
    setBusy(true);
    setMessage("");
    try {
      const items = await window.moye.saveConnection(editing, key || undefined);
      onConnections(items);
      setKey("");
      setEditing(items.find((c) => c.id === editing.id)!);
      setMessage(
        test ? await window.moye.testConnection(editing.id) : "连接已保存。",
      );
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="AI 连接与偏好" wide onClose={onClose}>
      <div className="settings-layout">
        <aside className="connection-list">
          <div className="eyebrow">我的 AI 服务</div>
          {connections.map((c) => (
            <button
              key={c.id}
              className={editing?.id === c.id ? "selected" : ""}
              onClick={() => edit(c)}
            >
              <Plug size={16} />
              <span>
                {c.name}
                <small>{c.model}</small>
              </span>
            </button>
          ))}
          <button className="dashed" onClick={add}>
            <Plus size={16} />
            添加连接
          </button>
          <p className="muted tiny">服务由你选择，作品留在本机。</p>
        </aside>
        <div className="connection-form">
          {editing ? (
            <>
              <div className="form-grid">
                <label>
                  服务商
                  <select
                    value={editing.provider}
                    onChange={(e) => {
                      const p = providers.find((p) => p.id === e.target.value)!;
                      change({
                        provider: p.id,
                        name: p.name,
                        baseUrl: p.baseUrl,
                        model: p.model,
                        temperature: null,
                        tokenParam:
                          p.id === "openai"
                            ? "max_completion_tokens"
                            : "max_tokens",
                      });
                    }}
                  >
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  连接名称
                  <input
                    value={editing.name}
                    onChange={(e) => change({ name: e.target.value })}
                  />
                </label>
                <label className="span-2">
                  API 基础地址
                  <input
                    value={editing.baseUrl}
                    onChange={(e) => change({ baseUrl: e.target.value })}
                  />
                </label>
                <label>
                  模型名称
                  <input
                    placeholder="填写服务商提供的模型 ID"
                    value={editing.model}
                    onChange={(e) => change({ model: e.target.value })}
                  />
                </label>
                <label>
                  API Key
                  <input
                    type="password"
                    autoComplete="off"
                    placeholder={
                      editing.hasKey
                        ? "已保存 · 留空保留"
                        : "填入 API Key（本地服务可留空）"
                    }
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                  />
                </label>
                <label>
                  上下文预算（估算 tokens）
                  <input
                    type="number"
                    min="1000"
                    value={editing.contextTokens}
                    onChange={(e) =>
                      change({ contextTokens: Number(e.target.value) })
                    }
                  />
                </label>
                <label>
                  输出上限（tokens）
                  <input
                    type="number"
                    min="64"
                    value={editing.outputTokens}
                    onChange={(e) =>
                      change({ outputTokens: Number(e.target.value) })
                    }
                  />
                </label>
                <label>
                  温度（留空使用模型默认）
                  <input
                    type="number"
                    min="0"
                    max="2"
                    step="0.1"
                    value={editing.temperature ?? ""}
                    onChange={(e) =>
                      change({
                        temperature:
                          e.target.value === "" ? null : Number(e.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  输出参数
                  <select
                    disabled={editing.provider === "claude"}
                    value={editing.tokenParam}
                    onChange={(e) =>
                      change({
                        tokenParam: e.target.value as Connection["tokenParam"],
                      })
                    }
                  >
                    <option value="max_tokens">max_tokens</option>
                    <option value="max_completion_tokens">
                      max_completion_tokens
                    </option>
                    <option value="omit">不发送（模型默认）</option>
                  </select>
                </label>
              </div>
              <p className="tiny muted">
                <ShieldCheck size={14} /> 密钥由系统加密，不随备份导出。
                {editing.sessionOnly
                  ? "当前系统无法加密，此密钥仅在本次运行有效。"
                  : ""}
                修改地址或协议后需要重新填写密钥。
              </p>
              <div className="row">
                <button
                  className="primary"
                  disabled={busy || !editing.model || !editing.name}
                  onClick={() => void save()}
                >
                  {busy ? <Busy /> : null}保存连接
                </button>
                <button
                  disabled={busy || !editing.model || !editing.name}
                  onClick={() => void save(true)}
                >
                  保存并测试
                </button>
                {connections.some((c) => c.id === editing.id) && (
                  <button
                    className="danger icon"
                    title="删除连接"
                    onClick={async () => {
                      try {
                        await window.moye.removeConnection(editing.id);
                        onConnections(await window.moye.connections());
                        await onPrefs(await window.moye.preferences());
                        setEditing(null);
                        notify("连接已删除");
                      } catch (e) {
                        setMessage(String(e));
                      }
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
              {message && (
                <p className="notice" role="status">
                  {message}
                </p>
              )}
            </>
          ) : (
            <div className="empty">
              <Plug size={36} />
              <h3>连接你的创作伙伴</h3>
              <p>支持五家服务商及自定义兼容接口。</p>
              <button onClick={add}>添加第一个连接</button>
            </div>
          )}
        </div>
      </div>
      <div className="settings-footer">
        <h3>按创作任务选择默认连接</h3>
        <div className="form-grid three">
          {(["setting", "outline", "body"] as const).map((key, i) => (
            <label key={key}>
              {["设定生成", "大纲生成", "正文辅助"][i]}
              <select
                value={prefs.defaults[key]}
                onChange={(e) =>
                  void onPrefs({
                    ...prefs,
                    defaults: { ...prefs.defaults, [key]: e.target.value },
                  })
                }
              >
                <option value="">使用第一个连接</option>
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </div>
    </Modal>
  );
}
