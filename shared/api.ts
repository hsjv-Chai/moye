import type { CollabAPI } from "./collab";
import type {
  Book,
  Connection,
  Preferences,
  Version,
  Draft,
  Generation,
  AIEvent,
  ImportChapter,
} from "./model";
export interface API {
  collab: CollabAPI;
  listBooks(): Promise<Book[]>;
  saveBook(b: Book): Promise<Book>;
  deleteBook(id: string): Promise<void>;
  snapshot(id: string, reason: string): Promise<Version>;
  versions(id: string): Promise<Version[]>;
  restoreVersion(bookId: string, id: string): Promise<Book>;
  connections(): Promise<Connection[]>;
  saveConnection(c: Connection, key?: string): Promise<Connection[]>;
  removeConnection(id: string): Promise<void>;
  testConnection(id: string): Promise<string>;
  preferences(): Promise<Preferences>;
  savePreferences(p: Preferences): Promise<Preferences>;
  importText(): Promise<{
    chapters: ImportChapter[];
    name: string;
    encoding: string;
  } | null>;
  exportText(id: string, ids: string[], format: "txt" | "md"): Promise<boolean>;
  backup(id: string): Promise<boolean>;
  restoreBackup(): Promise<Book | null>;
  drafts(id: string): Promise<Draft[]>;
  saveDraft(draft: Draft): Promise<void>;
  deleteDraft(id: string): Promise<void>;
  generate(g: Generation): Promise<void>;
  cancel(id: string): Promise<void>;
  onAI(fn: (e: AIEvent) => void): () => void;
  onClosing(fn: () => void): () => void;
  closeReady(): void;
}
declare global {
  interface Window {
    moye: API;
  }
}
