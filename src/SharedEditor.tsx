import { readPresence } from "../shared/awareness";
import { useEffect, useRef } from "react";
import * as Y from "yjs";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import {
  Awareness,
  encodeAwarenessUpdate,
  applyAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import type { Peer, User } from "../shared/collab";
import type { Preferences } from "../shared/model";
export const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
};
export const fromBase64 = (s: string) =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export default function SharedEditor({
  doc,
  field,
  label,
  readOnly,
  user,
  peers,
  prefs,
  onSelection,
  onFocus,
  oneLine = false,
}: {
  doc: Y.Doc;
  field: string;
  label: string;
  readOnly: boolean;
  user: User;
  peers: Peer[];
  prefs: Preferences;
  onSelection?: (s: { start: number; end: number }) => void;
  onFocus?: () => void;
  oneLine?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null),
    instance = useRef<EditorView | null>(null),
    presence = useRef<Awareness | null>(null),
    callbacks = useRef({ onSelection, onFocus });
  callbacks.current = { onSelection, onFocus };
  const options = useRef(new Compartment());
  useEffect(() => {
    const text = doc.getMap<Y.Text>("texts").get(field);
    if (!text || !host.current) return;
    const awareness = new Awareness(doc);
    presence.current = awareness;
    awareness.setLocalState({
      user: {
        name: user.displayName,
        color: "#71966b",
        colorLight: "#71966b33",
      },
    });
    const manager = new Y.UndoManager(text, { trackedOrigins: new Set() });
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: text.toString(),
        extensions: [
          EditorView.lineWrapping,
          placeholder(oneLine ? "未命名" : "在这里继续你的故事……"),
          EditorView.contentAttributes.of({
            "aria-label": label,
            role: "textbox",
            "aria-multiline": String(!oneLine),
          }),
          options.current.of([
            EditorState.readOnly.of(readOnly),
            EditorView.editable.of(!readOnly),
          ]),
          keymap.of([...yUndoManagerKeymap, ...defaultKeymap]),
          yCollab(text, awareness, { undoManager: manager }),
          ...(oneLine
            ? [
                EditorState.transactionFilter.of((tr) =>
                  tr.docChanged && tr.newDoc.lines > 1 ? [] : tr,
                ),
              ]
            : []),
          EditorView.updateListener.of((update) => {
            if (update.selectionSet || update.focusChanged) {
              const s = update.state.selection.main;
              callbacks.current.onSelection?.({ start: s.from, end: s.to });
              if (update.view.hasFocus) callbacks.current.onFocus?.();
            }
          }),
        ],
      }),
    });
    instance.current = view;
    const announce = (_changes: unknown, origin: unknown) => {
      if (origin === "remote") return;
      void window.moye.collab
        .presence(
          field,
          toBase64(encodeAwarenessUpdate(awareness, [doc.clientID])),
        )
        .catch(() => {});
    };
    awareness.on("update", announce);
    return () => {
      awareness.off("update", announce);
      view.destroy();
      manager.destroy();
      awareness.destroy();
      presence.current = null;
      instance.current = null;
    };
  }, [doc, field]);
  useEffect(() => {
    instance.current?.dispatch({
      effects: options.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);
  useEffect(() => {
    const awareness = presence.current;
    if (!awareness) return;
    const present = new Set<number>([doc.clientID]);
    for (const peer of peers)
      if (peer.field === field && peer.awareness) {
        try {
          present.add(readPresence(fromBase64(peer.awareness)).id);
        } catch {}
      }
    removeAwarenessStates(
      awareness,
      [...awareness.getStates().keys()].filter((id) => !present.has(id)),
      "remote",
    );
    for (const peer of peers) {
      if (peer.field !== field || !peer.awareness) continue;
      try {
        applyAwarenessUpdate(awareness, fromBase64(peer.awareness), "remote");
      } catch {}
    }
  }, [peers, doc, field]);
  return (
    <div
      ref={host}
      className={`shared-editor ${oneLine ? "one-line" : ""} ${prefs.font}`}
      style={{
        fontSize: oneLine ? 14 : prefs.fontSize,
        lineHeight: prefs.lineHeight,
      }}
    />
  );
}
