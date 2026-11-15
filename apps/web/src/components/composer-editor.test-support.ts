import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { act } from "react";
import {
  composerInline,
  composerSource,
  composerTokens,
  docPosAt,
  sourceOffsetAt,
} from "./composer-editor-document.js";

/**
 * Drives a composer field the way the browser does: text through the view's
 * text-input path, keys and clipboard events through its DOM listeners.
 */
function editorOf(field: Element): Editor {
  const editor: unknown = Reflect.get(field, "editor");
  if (!editor || typeof editor !== "object" || !("view" in editor))
    throw new Error("Not a composer field");
  return editor as Editor;
}

/** The editable element of the first composer field (or the one labelled `label`) in `scope`. */
export function composerField(scope: ParentNode, label?: string): HTMLElement {
  const field = scope.querySelector<HTMLElement>(
    label ? `.composer-editor__field[aria-label="${label}"]` : ".composer-editor__field",
  );
  if (!field) throw new Error(`No composer field${label ? ` labelled ${label}` : ""}`);
  return field;
}

/** The Markdown source the field holds. */
export function composerText(field: Element): string {
  return composerSource(editorOf(field).state.doc);
}

/** Types at the caret, a character at a time; "\n" is Shift+Enter. */
export function typeInto(field: Element, text: string): void {
  const { view } = editorOf(field);
  for (const character of text)
    act(() => {
      if (character === "\n") {
        field.dispatchEvent(
          new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "Enter",
            shiftKey: true,
          }),
        );
        return;
      }
      const { from, to } = view.state.selection;
      const insert = () => view.state.tr.insertText(character, from, to);
      if (!view.someProp("handleTextInput", (handle) => handle(view, from, to, character, insert)))
        view.dispatch(insert());
    });
}

/**
 * Replaces everything with `text` in one input, as a person selecting all and
 * pasting over it would; the caret ends after it.
 */
export function rewrite(field: Element, text: string): void {
  const { view } = editorOf(field);
  act(() => {
    const { doc, schema } = view.state;
    const nodes = composerInline(schema, text, composerTokens(text, "personal"));
    const tr = view.state.tr.replaceWith(1, doc.content.size - 1, nodes);
    view.dispatch(tr.setSelection(TextSelection.create(tr.doc, tr.doc.content.size - 1)));
  });
}

/** Puts the selection at source offsets. */
export function selectSource(field: Element, start: number, end = start): void {
  const { view } = editorOf(field);
  act(() => {
    const { doc } = view.state;
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(doc, docPosAt(doc, start), docPosAt(doc, end)),
      ),
    );
  });
}

/** The selection as source offsets. */
export function sourceSelection(field: Element): { start: number; end: number } {
  const { doc, selection } = editorOf(field).state;
  return { start: sourceOffsetAt(doc, selection.from), end: sourceOffsetAt(doc, selection.to) };
}

/**
 * A composer field read and driven as the textarea it replaced was: its
 * Markdown source and UTF-16 selection offsets.
 */
export function textareaView(element: HTMLElement) {
  return {
    element,
    get value() {
      return composerText(element);
    },
    get selectionStart() {
      return sourceSelection(element).start;
    },
    get selectionEnd() {
      return sourceSelection(element).end;
    },
    /** The editor never disables its field; it only stops taking edits. */
    get disabled() {
      return element.getAttribute("aria-disabled") === "true";
    },
    get readOnly() {
      return element.getAttribute("contenteditable") !== "true";
    },
    setSelectionRange: (start: number, end: number) => selectSource(element, start, end),
    get placeholder() {
      return element.getAttribute("aria-placeholder") ?? "";
    },
    closest: (selector: string) => element.closest(selector),
    dispatchEvent: (event: Event) => element.dispatchEvent(event),
    focus: () => element.focus(),
  };
}

/**
 * A key press. Backspace and Delete that the editor leaves to the browser
 * delete a character, as a browser's own editing would.
 */
export function pressKey(field: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...init });
  act(() => {
    field.dispatchEvent(event);
    if (event.defaultPrevented || (key !== "Backspace" && key !== "Delete")) return;
    const { view } = editorOf(field);
    const { from, to, empty } = view.state.selection;
    if (!empty) {
      view.dispatch(view.state.tr.deleteSelection());
      return;
    }
    const text = view.state.doc.textBetween(
      Math.max(0, from - 2),
      Math.min(view.state.doc.content.size, from + 2),
    );
    const offset = from - Math.max(0, from - 2);
    const width = (character: string | undefined) =>
      character && /[\uD800-\uDFFF]/u.test(character) ? 2 : 1;
    if (key === "Backspace" && from > 1)
      view.dispatch(view.state.tr.delete(from - width(text[offset - 1]), to));
    else if (key === "Delete" && to < view.state.doc.content.size - 1)
      view.dispatch(view.state.tr.delete(from, to + width(text[offset])));
  });
  return event;
}

/** The platform's undo modifier, as the editor's key bindings read it. */
export const mod: KeyboardEventInit = /Mac|iP(?:hone|[oa]d)/u.test(navigator.platform)
  ? { metaKey: true }
  : { ctrlKey: true };

export function clipboardEvent(
  type: "copy" | "cut" | "paste",
  data: Readonly<Record<string, string>> = {},
  files: readonly File[] = [],
): ClipboardEvent {
  const transfer = new DataTransfer();
  for (const [format, value] of Object.entries(data)) transfer.setData(format, value);
  for (const file of files) transfer.items.add(file);
  return new ClipboardEvent(type, { bubbles: true, cancelable: true, clipboardData: transfer });
}

export function paste(
  field: Element,
  data: Readonly<Record<string, string>>,
  files: readonly File[] = [],
) {
  const event = clipboardEvent("paste", data, files);
  act(() => {
    field.dispatchEvent(event);
  });
  return event;
}
