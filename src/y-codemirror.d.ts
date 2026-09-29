declare module "y-codemirror.next" {
  import type { Extension } from "@codemirror/state";
  import type { KeyBinding } from "@codemirror/view";
  import type { Text, UndoManager } from "yjs";
  import type { Awareness } from "y-protocols/awareness";
  export function yCollab(
    text: Text,
    awareness: Awareness | null,
    opts?: { undoManager: UndoManager | false },
  ): Extension;
  export const yUndoManagerKeymap: KeyBinding[];
}
