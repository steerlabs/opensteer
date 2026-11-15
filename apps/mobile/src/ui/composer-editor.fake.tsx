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
  /**
   * Native has input React has not heard yet, so it refuses a plain change of the
   * value and keeps its text until a reset with a newer generation, as the native view does.
   */
  runningAhead: false,
};

export function dismissKeyboard(): void {}

export function ComposerEditor(props: ComposerEditorProps): ReactNode {
  const [preview, setPreview] = useState<string | null>(null);
  const generation = useRef(0);
  const kept = useRef<string | null>(null);
  const latest = useRef({
    text: props.value,
    selection: { start: props.value.length, end: props.value.length },
  });
  if (
    composerEditorFake.runningAhead &&
    kept.current === null &&
    props.value !== latest.current.text
  )
    kept.current = latest.current.text;
  const shown = preview ?? kept.current ?? props.value;
  latest.current.text = shown;
  const change = (text: string): void => {
    kept.current = null;
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
      generation: generation.current,
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
      if (snapshot.generation > generation.current) {
        generation.current = snapshot.generation;
        kept.current = null;
        composerEditorFake.runningAhead = false;
      }
      record(snapshot.text, snapshot.selection);
      setPreview(null);
    },
    flushPendingInput: async () => {
      const ahead = composerEditorFake.ahead;
      composerEditorFake.ahead = null;
      if (ahead !== null) change(ahead);
      return {
        ...latest.current,
        generation: generation.current,
        composing: composerEditorFake.composing,
      };
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
