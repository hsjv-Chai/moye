import * as Y from "yjs";
import { z } from "zod";
import { bookSchema, type Book, type Target } from "./model";
export type User = {
  id: string;
  username: string;
  displayName: string;
  admin: boolean;
  active: boolean;
  mustChangePassword: boolean;
};
export type Role = "admin" | "editor" | "reader";
export type SharedBook = {
  id: string;
  title: string;
  archived: boolean;
  epoch: number;
  revision: number;
  updatedAt: string;
  role: Role;
};
export type Room = {
  book: Book;
  epoch: number;
  revision: number;
  state: string;
  role: Role;
};
export type Peer = {
  id: string;
  userId: string;
  name: string;
  color: string;
  field: string;
  awareness?: string;
};
export type CollabStatus = {
  server: string;
  user: User | null;
  online: boolean;
  error?: string;
};
export type RoomEvent =
  | { type: "room"; room: Room; pending: number }
  | { type: "update"; bookId: string; update: string; pending: number }
  | { type: "status"; status: CollabStatus }
  | { type: "peers"; peers: Peer[] }
  | { type: "recovery"; message: string; bookId: string }
  | { type: "error"; message: string };
export type Member = {
  userId: string;
  username: string;
  displayName: string;
  role: "editor" | "reader";
};
export type SharedVersion = {
  id: string;
  reason: string;
  createdAt: string;
  createdBy: string;
  book: Book;
};
export const loginSchema = z.object({
  server: z.string().url(),
  username: z.string().min(1).max(80),
  password: z.string().min(1).max(300),
});
export const userInputSchema = z.object({
  username: z.string().regex(/^[a-zA-Z0-9_.-]{3,50}$/),
  displayName: z
    .string()
    .trim()
    .min(1, "请输入显示名称")
    .max(80, "显示名称最多 80 字符"),
  password: z.string().min(12).max(200),
  admin: z.boolean().default(false),
});
export const userPatchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80).optional(),
    active: z.boolean().optional(),
    password: z.string().min(12).max(200).optional(),
  })
  .strict()
  .refine(
    (value) => Object.values(value).some((v) => v !== undefined),
    "更新不能为空",
  );
export type UserBook = Omit<SharedBook, "role"> & { role: Role | null };
export const structureSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("addChapter"),
    chapter: bookSchema.innerType().shape.chapters.element,
  }),
  z.object({
    kind: z.literal("addSetting"),
    setting: bookSchema.innerType().shape.settings.element,
  }),
  z.object({
    kind: z.literal("addVolume"),
    volume: bookSchema.innerType().shape.volumes.element,
  }),
  z.object({
    kind: z.literal("delete"),
    collection: z.enum(["chapters", "settings", "volumes"]),
    id: z.string(),
  }),
  z.object({
    kind: z.literal("move"),
    collection: z.enum(["chapters", "settings", "volumes"]),
    id: z.string(),
    delta: z.union([z.literal(-1), z.literal(1)]),
  }),
  z.object({
    kind: z.literal("assignVolume"),
    id: z.string(),
    volumeId: z.string(),
  }),
  z.object({
    kind: z.literal("category"),
    id: z.string(),
    category: bookSchema.innerType().shape.settings.element.shape.category,
  }),
  z.object({ kind: z.literal("archive"), archived: z.boolean() }),
  z.object({
    kind: z.literal("import"),
    chapters: bookSchema.innerType().shape.chapters,
  }),
]);
export type Structure = z.infer<typeof structureSchema>;
export type AtomicEdit = {
  field: string;
  baseline: string;
  text: string;
  mode: "replace" | "append" | "selection";
  anchor?: string;
  head?: string;
  selectionText?: string;
  reason: string;
  sourceFingerprint?: string;
};
export const atomicSchema = z.object({
  field: z.string().max(300),
  baseline: z.string().max(10000000),
  text: z.string().max(10000000),
  mode: z.enum(["replace", "append", "selection"]),
  anchor: z.string().optional(),
  head: z.string().optional(),
  selectionText: z.string().optional(),
  reason: z.string().max(200),
  sourceFingerprint: z.string().optional(),
});
export interface CollabAPI {
  status(): Promise<CollabStatus>;
  login(
    server: string,
    username: string,
    password: string,
  ): Promise<CollabStatus>;
  logout(): Promise<void>;
  changePassword(oldPassword: string, newPassword: string): Promise<void>;
  books(): Promise<SharedBook[]>;
  publish(book: Book): Promise<SharedBook>;
  open(id: string): Promise<Room>;
  leave(): Promise<void>;
  update(id: string, epoch: number, update: string): Promise<void>;
  presence(field: string, awareness?: string): Promise<void>;
  flush(): Promise<void>;
  structure(
    id: string,
    epoch: number,
    revision: number,
    action: Structure,
  ): Promise<Room>;
  atomic(id: string, epoch: number, edit: AtomicEdit): Promise<Room>;
  deleteBook(id: string): Promise<void>;
  users(): Promise<User[]>;
  createUser(input: z.infer<typeof userInputSchema>): Promise<User>;
  updateUser(id: string, patch: z.infer<typeof userPatchSchema>): Promise<void>;
  userBooks(id: string): Promise<UserBook[]>;
  members(id: string): Promise<Member[]>;
  setMember(
    id: string,
    userId: string,
    role: "editor" | "reader" | null,
  ): Promise<void>;
  versions(id: string): Promise<SharedVersion[]>;
  snapshot(id: string): Promise<void>;
  restore(id: string, versionId: string): Promise<Room>;
  onEvent(fn: (e: RoomEvent) => void): () => void;
}
const bookFields = [
  "title",
  "genre",
  "description",
  "requirements",
  "synopsis",
] as const;
const settingFields = ["title", "role", "traits", "content"] as const;
const volumeFields = ["title", "outline"] as const;
const chapterFields = [
  "title",
  "outline",
  "body",
  "summary",
  "summarySource",
] as const;
export function fields(b: Book): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of bookFields) m.set(`book:${b.id}:${f}`, b[f]);
  for (const [kind, items, keys] of [
    ["setting", b.settings, settingFields],
    ["volume", b.volumes, volumeFields],
    ["chapter", b.chapters, chapterFields],
  ] as const) {
    for (const item of items)
      for (const f of keys)
        m.set(`${kind}:${item.id}:${f}`, String((item as any)[f]));
  }
  return m;
}
export function createDoc(b: Book) {
  const d = new Y.Doc();
  d.transact(() => {
    for (const [key, value] of fields(b)) {
      const t = new Y.Text();
      d.getMap<Y.Text>("texts").set(key, t);
      if (value) t.insert(0, value);
    }
  });
  return d;
}
export function project(b: Book, d: Y.Doc): Book {
  const out = structuredClone(b),
    m = d.getMap<Y.Text>("texts");
  for (const f of bookFields)
    out[f] = m.get(`book:${b.id}:${f}`)?.toString() ?? b[f];
  for (const [kind, items, keys] of [
    ["setting", out.settings, settingFields],
    ["volume", out.volumes, volumeFields],
    ["chapter", out.chapters, chapterFields],
  ] as const)
    for (const item of items)
      for (const f of keys)
        (item as any)[f] =
          m.get(`${kind}:${item.id}:${f}`)?.toString() ?? (item as any)[f];
  return bookSchema.parse(out);
}
export function validDoc(b: Book, d: Y.Doc) {
  const allowed = fields(b),
    m = d.getMap<Y.Text>("texts");
  if (d.share.size !== 1 || m.size !== allowed.size)
    throw new Error("作品结构已变化，请重新同步");
  for (const [key, value] of m) {
    if (
      !allowed.has(key) ||
      !(value instanceof Y.Text) ||
      value.toString().length > 10000000
    )
      throw new Error("非法文档更新");
  }
  project(b, d);
}
export function reconcileDoc(before: Book, after: Book, d: Y.Doc) {
  const m = d.getMap<Y.Text>("texts"),
    next = fields(after);
  d.transact(() => {
    for (const k of fields(before).keys()) if (!next.has(k)) m.delete(k);
    for (const [key, value] of next)
      if (!m.has(key)) {
        const t = new Y.Text();
        m.set(key, t);
        if (value) t.insert(0, value);
      }
  });
}
export function targetField(b: Book, t: Target) {
  return t.kind === "synopsis"
    ? `book:${b.id}:synopsis`
    : t.kind === "setting"
      ? `setting:${t.id}:content`
      : t.kind === "volume"
        ? `volume:${t.id}:outline`
        : `chapter:${t.id}:${t.kind}`;
}
export function changeText(t: Y.Text, next: string) {
  const before = t.toString();
  if (before === next) return;
  let start = 0;
  while (
    start < before.length &&
    start < next.length &&
    before[start] === next[start]
  )
    start++;
  let end = 0;
  while (
    end < before.length - start &&
    end < next.length - start &&
    before[before.length - 1 - end] === next[next.length - 1 - end]
  )
    end++;
  if (before.length - start - end) t.delete(start, before.length - start - end);
  const insert = next.slice(start, next.length - end);
  if (insert) t.insert(start, insert);
}
export function structuralChange(b: Book, a: Structure): Book {
  const out = structuredClone(b);
  switch (a.kind) {
    case "addChapter":
      out.chapters.push(a.chapter);
      break;
    case "addSetting":
      out.settings.push(a.setting);
      break;
    case "addVolume":
      out.volumes.push(a.volume);
      break;
    case "import":
      out.chapters.push(...a.chapters);
      break;
    case "delete":
      (out as any)[a.collection] = out[a.collection].filter(
        (x) => x.id !== a.id,
      );
      if (a.collection === "volumes")
        out.chapters.forEach((c) => {
          if (c.volumeId === a.id) c.volumeId = "";
        });
      break;
    case "move": {
      const arr = out[a.collection];
      const group =
        a.collection === "chapters"
          ? (arr as Book["chapters"]).filter(
              (c) =>
                c.volumeId ===
                out.chapters.find((x) => x.id === a.id)?.volumeId,
            )
          : arr;
      const i = group.findIndex((x) => x.id === a.id),
        j = i + a.delta;
      if (i >= 0 && j >= 0 && j < group.length) {
        const x = arr.findIndex((x) => x.id === group[i].id),
          y = arr.findIndex((x) => x.id === group[j].id);
        [arr[x], arr[y]] = [arr[y], arr[x]];
      }
      break;
    }
    case "assignVolume": {
      const c = out.chapters.find((c) => c.id === a.id);
      if (c) c.volumeId = a.volumeId;
      break;
    }
    case "category": {
      const s = out.settings.find((s) => s.id === a.id);
      if (s) s.category = a.category;
      break;
    }
    case "archive":
      out.archived = a.archived;
      break;
  }
  return bookSchema.parse(out);
}
export function remapBook(b: Book, id = crypto.randomUUID()): Book {
  const ids = new Map<string, string>();
  for (const x of [...b.settings, ...b.volumes, ...b.chapters])
    ids.set(x.id, crypto.randomUUID());
  return {
    ...structuredClone(b),
    id,
    archived: false,
    settings: b.settings.map((s) => ({ ...s, id: ids.get(s.id)! })),
    volumes: b.volumes.map((v) => ({ ...v, id: ids.get(v.id)! })),
    chapters: b.chapters.map((c) => ({
      ...c,
      id: ids.get(c.id)!,
      volumeId: ids.get(c.volumeId) || "",
    })),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
