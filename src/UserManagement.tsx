import { useCallback, useEffect, useRef, useState } from "react";
import {
  userInputSchema,
  type User,
  type UserBook,
  type Member,
} from "../shared/collab";
import { Modal } from "./components";
const api = () => window.moye.collab;
type Confirm = (text: string) => Promise<boolean>;

function useOperation() {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const run = async (
    action: () => Promise<unknown>,
    refresh?: () => Promise<unknown>,
    message = "已保存",
  ) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if ((await action()) === false) return;
      setNotice(message);
      if (refresh) {
        try {
          await refresh();
        } catch (e) {
          setError(`操作已成功，但列表刷新失败，请刷新重试：${String(e)}`);
        }
      }
    } catch (e) {
      setError(String(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return { busy, error, notice, run };
}
function Feedback({ error, notice }: { error: string; notice: string }) {
  return (
    <>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </>
  );
}
function matches(user: User, search: string) {
  return `${user.username} ${user.displayName}`
    .toLocaleLowerCase()
    .includes(search.trim().toLocaleLowerCase());
}
// Both entry points use the same save, refresh, confirmation and disabled-account rules.
function PermissionRow({
  title,
  active,
  role,
  bookId,
  userId,
  refresh,
  confirm,
}: {
  title: string;
  active: boolean;
  role: "editor" | "reader" | null;
  bookId: string;
  userId: string;
  refresh: () => Promise<unknown>;
  confirm: Confirm;
}) {
  const op = useOperation();
  return (
    <div className="management-permission">
      <label>
        {title}
        {!active && <small> · 已停用</small>}
        <select
          aria-label={`权限-${title}`}
          value={role || ""}
          disabled={op.busy}
          onChange={(e) => {
            const next = (e.target.value || null) as typeof role;
            void op.run(async () => {
              if (
                (next === null || (role === "editor" && next === "reader")) &&
                !(await confirm(
                  `确认将「${title}」设为${next === null ? "无权限" : "只读"}？现有协作连接将重新验证权限。`,
                ))
              )
                return false;
              await api().setMember(bookId, userId, next);
            }, refresh);
          }}
        >
          <option value="">无权限</option>
          <option value="reader" disabled={!active && role === null}>
            只读
          </option>
          <option value="editor" disabled={!active && role !== "editor"}>
            可编辑
          </option>
        </select>
      </label>
      <Feedback {...op} />
      {op.error && (
        <button
          disabled={op.busy}
          onClick={() => void op.run(refresh, undefined, "已刷新")}
        >
          刷新权限
        </button>
      )}
    </div>
  );
}

export function UserManagement({
  currentUser,
  onClose,
  confirm,
}: {
  currentUser: User;
  onClose: () => void;
  confirm: Confirm;
}) {
  const [users, setUsers] = useState<User[]>([]);
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("all");
  const [state, setState] = useState("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const op = useOperation();
  const refresh = useCallback(async () => setUsers(await api().users()), []);
  useEffect(() => {
    void op.run(refresh, undefined, "");
  }, [refresh]);
  const user = users.find((u) => u.id === selected);
  return (
    <Modal title="管理员 · 账号管理" wide onClose={onClose}>
      <div className="modal-body management">
        {creating ? (
          <CreateUser onBack={() => setCreating(false)} refresh={refresh} />
        ) : user ? (
          <UserDetail
            key={user.id}
            user={user}
            self={user.id === currentUser.id}
            refresh={refresh}
            onBack={() => setSelected(null)}
            confirm={confirm}
          />
        ) : (
          <>
            <div className="row">
              <button className="primary" onClick={() => setCreating(true)}>
                创建账号
              </button>
              <button
                disabled={op.busy}
                onClick={() => void op.run(refresh, undefined, "已刷新")}
              >
                刷新列表
              </button>
              <span className="muted">共 {users.length} 个账号</span>
            </div>
            <div className="management-filters">
              <label>
                搜索账号
                <input
                  aria-label="搜索账号"
                  placeholder="用户名或显示名称"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
              <label>
                账号类型
                <select
                  aria-label="账号类型"
                  value={kind}
                  onChange={(e) => setKind(e.target.value)}
                >
                  <option value="all">全部类型</option>
                  <option value="admin">管理员</option>
                  <option value="member">普通成员</option>
                </select>
              </label>
              <label>
                账号状态
                <select
                  value={state}
                  onChange={(e) => setState(e.target.value)}
                >
                  <option value="all">全部状态</option>
                  <option value="active">正常</option>
                  <option value="inactive">已停用</option>
                </select>
              </label>
            </div>
            <Feedback {...op} />
            <div className="version-list">
              {users
                .filter(
                  (u) =>
                    matches(u, search) &&
                    (kind === "all" || u.admin === (kind === "admin")) &&
                    (state === "all" || u.active === (state === "active")),
                )
                .map((u) => (
                  <div key={u.id}>
                    <span>
                      <strong>
                        {u.displayName} · {u.username}
                        {u.id === currentUser.id ? "（本人）" : ""}
                      </strong>
                      <small>
                        {u.admin ? "管理员" : "普通成员"} ·{" "}
                        {u.active ? "正常" : "已停用"}
                        {u.mustChangePassword ? " · 需修改密码" : ""}
                      </small>
                    </span>
                    <button onClick={() => setSelected(u.id)}>管理</button>
                  </div>
                ))}
            </div>
            {!op.busy &&
              !users.some(
                (u) =>
                  matches(u, search) &&
                  (kind === "all" || u.admin === (kind === "admin")) &&
                  (state === "all" || u.active === (state === "active")),
              ) && <p className="muted">没有符合条件的账号</p>}
          </>
        )}
      </div>
    </Modal>
  );
}
function CreateUser({
  onBack,
  refresh,
}: {
  onBack: () => void;
  refresh: () => Promise<void>;
}) {
  const [form, setForm] = useState({
    username: "",
    displayName: "",
    password: "",
    admin: false,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const op = useOperation();
  return (
    <>
      <button disabled={op.busy} onClick={onBack}>
        返回账号列表
      </button>
      <h3>创建账号</h3>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const parsed = userInputSchema.safeParse(form);
          if (!parsed.success) {
            setErrors(
              Object.fromEntries(
                parsed.error.issues.map((i) => [String(i.path[0]), i.message]),
              ),
            );
            return;
          }
          setErrors({});
          void op.run(
            async () => {
              await api().createUser(parsed.data);
              setForm({
                username: "",
                displayName: "",
                password: "",
                admin: false,
              });
            },
            refresh,
            "账号已创建，首次登录需修改临时密码",
          );
        }}
      >
        <fieldset disabled={op.busy} className="management-fields">
          <label>
            用户名
            <input
              aria-label="新用户名"
              autoComplete="off"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
            />
            <small>3–50 位英文字母、数字、下划线、点或短横线</small>
            {errors.username && (
              <span role="alert" className="error">
                用户名格式不符合要求
              </span>
            )}
          </label>
          <label>
            显示名称
            <input
              aria-label="显示名称"
              maxLength={80}
              value={form.displayName}
              onChange={(e) =>
                setForm({ ...form, displayName: e.target.value })
              }
            />
            {errors.displayName && (
              <span role="alert" className="error">
                {errors.displayName}
              </span>
            )}
          </label>
          <label>
            临时密码
            <input
              aria-label="新账号临时密码"
              type="password"
              autoComplete="new-password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
            <small>12–200 字符，首次登录必须修改</small>
            {errors.password && (
              <span role="alert" className="error">
                临时密码需要 12–200 字符
              </span>
            )}
          </label>
          <label>
            账号类型
            <select
              value={String(form.admin)}
              onChange={(e) =>
                setForm({ ...form, admin: e.target.value === "true" })
              }
            >
              <option value="false">普通成员</option>
              <option value="true">管理员</option>
            </select>
            <small>
              用户名和账号类型创建后不可修改；管理员可访问全部作品。
            </small>
          </label>
          <button className="primary" type="submit">
            {op.busy ? "正在创建…" : "创建账号"}
          </button>
        </fieldset>
      </form>
      <Feedback {...op} />
      {op.error && (
        <button
          disabled={op.busy}
          onClick={() => void op.run(refresh, undefined, "已刷新")}
        >
          刷新列表
        </button>
      )}
    </>
  );
}
function UserDetail({
  user,
  self,
  refresh,
  onBack,
  confirm,
}: {
  user: User;
  self: boolean;
  refresh: () => Promise<void>;
  onBack: () => void;
  confirm: Confirm;
}) {
  const [name, setName] = useState(user.displayName);
  const [passwordMode, setPasswordMode] = useState(false);
  const [books, setBooks] = useState<UserBook[]>([]);
  const [search, setSearch] = useState("");
  const op = useOperation();
  const load = useOperation();
  const refreshBooks = useCallback(
    async () => setBooks(await api().userBooks(user.id)),
    [user.id],
  );
  useEffect(() => {
    if (!user.admin) void load.run(refreshBooks, undefined, "");
  }, [refreshBooks, user.admin]);
  return (
    <>
      <button disabled={op.busy} onClick={onBack}>
        返回账号列表
      </button>
      <h3>
        {user.displayName} · {user.username}
      </h3>
      <p className="muted">
        {user.admin ? "管理员 · 可访问全部作品" : "普通成员"} ·{" "}
        {user.active ? "正常" : "已停用"}
        {user.mustChangePassword ? " · 需修改密码" : ""}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void op.run(async () => {
            const value = name.trim();
            if (!value || value.length > 80)
              throw new Error("显示名称需要 1–80 字符");
            await api().updateUser(user.id, { displayName: value });
            setName(value);
          }, refresh);
        }}
      >
        <label>
          显示名称
          <input
            aria-label="编辑显示名称"
            value={name}
            maxLength={80}
            disabled={op.busy}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <button disabled={op.busy} type="submit">
          保存名称
        </button>
      </form>
      <div className="row">
        <button
          disabled={self || op.busy}
          onClick={() =>
            void op.run(async () => {
              if (
                !(await confirm(
                  user.active
                    ? `确认停用 ${user.username}？现有登录将失效，作品权限保留。`
                    : `确认启用 ${user.username}？原作品权限将恢复生效。`,
                ))
              )
                return false;
              await api().updateUser(user.id, { active: !user.active });
            }, refresh)
          }
        >
          {user.active ? "停用账号" : "启用账号"}
        </button>
        <button
          disabled={op.busy}
          onClick={() => setPasswordMode(!passwordMode)}
        >
          {passwordMode ? "关闭密码表单" : self ? "修改密码" : "重置密码"}
        </button>
        <button
          disabled={op.busy}
          onClick={() => void op.run(refresh, undefined, "已刷新")}
        >
          刷新资料
        </button>
      </div>
      <Feedback {...op} />
      {passwordMode && (
        <PasswordForm user={user} self={self} refresh={refresh} />
      )}
      {!user.admin && (
        <section>
          <h3>作品权限</h3>
          <label>
            搜索作品
            <input value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <button
            disabled={load.busy}
            onClick={() => void load.run(refreshBooks, undefined, "已刷新")}
          >
            刷新作品权限
          </button>
          <Feedback {...load} />
          {books
            .filter((b) =>
              b.title
                .toLocaleLowerCase()
                .includes(search.trim().toLocaleLowerCase()),
            )
            .map((b) => (
              <PermissionRow
                key={b.id}
                title={`${b.title}${b.archived ? "（已归档）" : ""}`}
                active={user.active}
                role={b.role === "admin" ? null : b.role}
                bookId={b.id}
                userId={user.id}
                refresh={refreshBooks}
                confirm={confirm}
              />
            ))}
          {!load.busy && !books.length && <p className="muted">暂无作品</p>}
        </section>
      )}
    </>
  );
}
function PasswordForm({
  user,
  self,
  refresh,
}: {
  user: User;
  self: boolean;
  refresh: () => Promise<void>;
}) {
  const [old, setOld] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const op = useOperation();
  return (
    <form
      className="management-password"
      onSubmit={(e) => {
        e.preventDefault();
        void op.run(
          async () => {
            if (password.length < 12 || password.length > 200)
              throw new Error("新密码需要 12–200 字符");
            if (password !== repeat) throw new Error("两次输入的密码不一致");
            if (self) await api().changePassword(old, password);
            else await api().updateUser(user.id, { password });
            setOld("");
            setPassword("");
            setRepeat("");
          },
          refresh,
          self
            ? "密码已修改，其他登录会话已失效"
            : "密码已重置，原会话已失效，下次登录需修改临时密码",
        );
      }}
    >
      <h4>{self ? "修改密码" : `重置 ${user.username} 的密码`}</h4>
      <fieldset disabled={op.busy} className="management-fields">
        {self && (
          <label>
            原密码
            <input
              type="password"
              autoComplete="current-password"
              value={old}
              onChange={(e) => setOld(e.target.value)}
            />
          </label>
        )}
        <label>
          {self ? "新密码" : "新临时密码"}
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label>
          确认新密码
          <input
            type="password"
            autoComplete="new-password"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
          />
        </label>
        <small>12–200 字符。提交后其他登录会话失效。</small>
        <button type="submit">确认{self ? "修改" : "重置"}密码</button>
      </fieldset>
      <Feedback {...op} />
      {op.error && (
        <button
          type="button"
          disabled={op.busy}
          onClick={() => void op.run(refresh, undefined, "已刷新")}
        >
          刷新资料
        </button>
      )}
    </form>
  );
}
export function MemberManagement({
  bookId,
  onClose,
  confirm,
}: {
  bookId: string;
  onClose: () => void;
  confirm: Confirm;
}) {
  const [users, setUsers] = useState<User[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [search, setSearch] = useState("");
  const op = useOperation();
  const refresh = useCallback(async () => {
    const [u, m] = await Promise.all([api().users(), api().members(bookId)]);
    setUsers(u);
    setMembers(m);
  }, [bookId]);
  useEffect(() => {
    void op.run(refresh, undefined, "");
  }, [refresh]);
  return (
    <Modal title="作品成员与权限" onClose={onClose}>
      <div className="modal-body management">
        <p className="muted">
          管理员可访问全部作品。停用账号保留原权限，可降低或移除权限。
        </p>
        <label>
          搜索成员
          <input
            placeholder="用户名或显示名称"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <button
          disabled={op.busy}
          onClick={() => void op.run(refresh, undefined, "已刷新")}
        >
          刷新成员
        </button>
        <Feedback {...op} />
        {[true, false].map((assigned) => {
          const list = users.filter(
            (u) =>
              !u.admin &&
              matches(u, search) &&
              members.some((m) => m.userId === u.id) === assigned,
          );
          return (
            <section key={String(assigned)}>
              <h3>{assigned ? "已有成员" : "待添加用户"}</h3>
              {!op.busy && !list.length && (
                <p className="muted">暂无匹配用户</p>
              )}
              {list.map((u) => (
                <PermissionRow
                  key={u.id}
                  title={`${u.displayName} · ${u.username}`}
                  active={u.active}
                  role={members.find((m) => m.userId === u.id)?.role || null}
                  bookId={bookId}
                  userId={u.id}
                  refresh={refresh}
                  confirm={confirm}
                />
              ))}
            </section>
          );
        })}
      </div>
    </Modal>
  );
}
