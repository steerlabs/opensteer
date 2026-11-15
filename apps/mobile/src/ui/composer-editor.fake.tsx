import { replaceComposerRange, type ComposerSelection } from "@opensteer/client/references";
import { useImperativeHandle, useRef, useState, type ReactNode } from "react";
import type { ComposerEditorProps } from "./composer-editor.js";

/**
 * A textarea standing in for the native editor in DOM tests, with the same handle:
 * what the composers ask of the field (previews, restores, carets) is recorded here.
 */
export const composerEditorFake = {
  /** Moves the caret, as a tap in the field would. */
  select: null as null | ((selection: ComposerSelection) => void),
  blur: (): void => undefined,
  /** Carets and texts the composer placed: `setSelection`, `preview` and `restore`. */
  calls: [] as { text: string; start: number; end: number }[],
  /** Text native holds but has not reported yet; only a flush delivers it. */
  ahead: null as string | null,
  composing: false,
};

export function dismissKeyboard(): void {}

export function ComposerEditor(props: ComposerEditorProps): ReactNode {
  const [preview, setPreview] = useState<string | null>(null);
  const shown = preview ?? props.value;
  const latest = useRef({ text: shown, selection: { start: shown.length, end: shown.length } });
  latest.current.text = shown;
  const change = (text: string): void => {
    latest.current = { text, selection: { start: text.length, end: text.length } };
    setPreview(null);
    props.onChangeText(text);
  };
  composerEditorFake.select = (selection) => {
    latest.current.selection = selection;
    props.onSelectionChange?.(selection);
  };
  const record = (text: string, selection: ComposerSelection) =>
    composerEditorFake.calls.push({ text, ...selection });
  useImperativeHandle(props.ref, () => ({
    focus: () => undefined,
    blur: () => composerEditorFake.blur(),
    containsFocus: () => false,
    readSnapshot: () => ({
      ...latest.current,
      generation: 0,
      composing: composerEditorFake.composing,
    }),
    replace: (range, insert) => {
      const next = replaceComposerRange(latest.current.text, range, insert, []);
      change(next.text);
      composerEditorFake.select?.(next.selection);
    },
    setSelection: (selection) => record(latest.current.text, selection),
    preview: (snapshot) => {
      record(snapshot.text, snapshot.selection);
      setPreview(snapshot.text);
    },
    restore: (snapshot) => {
      record(snapshot.text, snapshot.selection);
      setPreview(null);
    },
    flushPendingInput: async () => {
      const ahead = composerEditorFake.ahead;
      composerEditorFake.ahead = null;
      if (ahead !== null) change(ahead);
      return { ...latest.current, generation: 0, composing: composerEditorFake.composing };
    },
  }));
  return (
    <textarea
      aria-label={props.accessibilityLabel}
      disabled={props.editable === false}
      onBlur={props.onBlur}
      onChange={(event) => change(event.currentTarget.value)}
      onFocus={props.onFocus}
      placeholder={props.placeholder}
      value={shown}
    />
  );
}
