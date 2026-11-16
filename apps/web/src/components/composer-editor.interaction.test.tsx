// @vitest-environment happy-dom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./composer.js";
import {
  ComposerEditor,
  type ComposerChange,
  type ComposerEditorControl,
} from "./composer-editor.js";
import type { ComposerScope } from "./composer-editor-document.js";
import {
  clipboardEvent,
  composerField,
  composerText,
  mod,
  paste,
  pressKey,
  selectSource,
  typeInto,
} from "./composer-editor.test-support.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

const task = "[Fix \\[the\\] build 🦊](opensteer:thr_12345678-1234-4234-8234-123456789abc)";
const channel = "[design](https://team.example/c/tch_12345678-1234-4234-8234-123456789abc)";

function mount(initial: string, scope: ComposerScope = "personal", className?: string) {
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  const ref = createRef<ComposerEditorControl>();
  const changes: { text: string; change: ComposerChange }[] = [];
  let value = initial;
  const render = () =>
    act(() =>
      root.render(
        <ComposerEditor
          {...(className ? { className } : {})}
          fieldAttributes={{ "aria-label": "Message" }}
          onChange={(text, change) => {
            changes.push({ text, change });
            value = text;
            render();
          }}
          ref={ref}
          scope={scope}
          value={value}
        />,
      ),
    );
  render();
  return {
    changes,
    editor: ref.current!,
    field: composerField(node),
    /** A new value from outside, as a sent draft clearing is. */
    reset(next: string) {
      value = next;
      render();
    },
  };
}

describe("composer editor", () => {
  it("styles the editable element itself, so its whole box takes the caret", () => {
    const { field } = mount("", "personal", "composer__input");
    expect(field.classList.contains("composer__input")).toBe(true);
    expect(field.isContentEditable || field.getAttribute("contenteditable")).toBeTruthy();
  });

  it("rebuilds references from Markdown and gives the source back byte for byte", () => {
    const source = `Before ${task}\nthen ${channel} and \\[not a link\\](x) \`${task}\``;
    const { editor, field } = mount(source);
    expect(composerText(field)).toBe(source);
    // A caret placed inside a reference lands on its nearer edge.
    const start = source.indexOf(task);
    editor.setSelection({ start: start + 2, end: start + 2 });
    expect(editor.readSnapshot().selection).toEqual({ start, end: start });
    editor.setSelection({ start: start + task.length - 2, end: start + task.length - 2 });
    expect(editor.readSnapshot().selection).toEqual({
      start: start + task.length,
      end: start + task.length,
    });
    // A range that cuts into one takes all of it.
    editor.setSelection({ start: start - 3, end: start + 4 });
    expect(editor.readSnapshot().selection).toEqual({ start: start - 3, end: start + task.length });
  });

  it("steps over a reference in one key press and deletes it whole, as one undo step", () => {
    const source = `a ${task} b`;
    const { field } = mount(source);
    const after = 2 + task.length;
    selectSource(field, after);
    pressKey(field, "ArrowLeft");
    typeInto(field, "x");
    expect(composerText(field)).toBe(`a x${task} b`);
    pressKey(field, "ArrowRight");
    pressKey(field, "Backspace");
    expect(composerText(field)).toBe("a x b");
    pressKey(field, "z", mod);
    expect(composerText(field)).toBe(`a x${task} b`);
    selectSource(field, 3);
    pressKey(field, "Delete");
    expect(composerText(field)).toBe("a x b");
  });

  it("turns a typed link into a reference only once the caret has left it", () => {
    const { field } = mount("");
    typeInto(field, `see ${task}`);
    expect(composerText(field)).toBe(`see ${task}`);
    // Still being written: Backspace takes one character.
    pressKey(field, "Backspace");
    expect(composerText(field)).toBe(`see ${task.slice(0, -1)}`);
    typeInto(field, ") ok");
    expect(composerText(field)).toBe(`see ${task} ok`);
    selectSource(field, 4 + task.length);
    pressKey(field, "Backspace");
    expect(composerText(field)).toBe("see  ok");
  });

  it("keeps personal references as editable source in a team draft", () => {
    const { field } = mount(`${task} ${channel} `, "team");
    selectSource(field, task.length);
    pressKey(field, "Backspace");
    expect(composerText(field)).toBe(`${task.slice(0, -1)} ${channel} `);
    selectSource(field, composerText(field).length - 1);
    pressKey(field, "Backspace");
    expect(composerText(field)).toBe(`${task.slice(0, -1)}  `);
  });

  it("pastes plain-text Markdown as one undo step and never pasted HTML", () => {
    const { field } = mount("hi ");
    selectSource(field, 3);
    typeInto(field, "there ");
    paste(field, { "text/plain": `${task}\r\nnext`, "text/html": "<b>bold</b>" });
    expect(composerText(field)).toBe(`hi there ${task}\nnext`);
    // The pasted reference is whole at once, without the caret leaving it first.
    selectSource(field, 9 + task.length);
    pressKey(field, "Backspace");
    expect(composerText(field)).toBe("hi there \nnext");
    pressKey(field, "z", mod);
    pressKey(field, "z", mod);
    expect(composerText(field)).toBe("hi there ");
  });

  it("copies and cuts the exact source, so a reference pastes back whole", () => {
    const source = `one ${task} two`;
    const { field } = mount(source);
    selectSource(field, 2, 4 + task.length + 2);
    const copy = clipboardEvent("copy");
    act(() => {
      field.dispatchEvent(copy);
    });
    expect(copy.clipboardData?.getData("text/plain")).toBe(`e ${task} t`);
    const cut = clipboardEvent("cut");
    act(() => {
      field.dispatchEvent(cut);
    });
    expect(composerText(field)).toBe("onwo");
    paste(field, { "text/plain": cut.clipboardData?.getData("text/plain") ?? "" });
    expect(composerText(field)).toBe(source);
  });

  it("inserts a picked reference as one undo step with the caret after it", () => {
    const { editor, field } = mount("ask @fi");
    selectSource(field, 7);
    act(() => editor.replace({ start: 4, end: 7 }, `${task} `, { historyGroup: "edit" }));
    expect(editor.readSnapshot()).toMatchObject({
      text: `ask ${task} `,
      selection: { start: 5 + task.length, end: 5 + task.length },
    });
    typeInto(field, "now");
    pressKey(field, "z", mod);
    expect(composerText(field)).toBe(`ask ${task} `);
    pressKey(field, "z", mod);
    expect(composerText(field)).toBe("ask @fi");
  });

  it("shows dictation without touching history, and commits it as one step", () => {
    const { changes, editor, field } = mount("");
    typeInto(field, "hello");
    const base = editor.readSnapshot();
    act(() => editor.preview({ ...base, text: "hello wor", selection: { start: 9, end: 9 } }));
    act(() => editor.preview({ ...base, text: "hello world", selection: { start: 11, end: 11 } }));
    expect(composerText(field)).toBe("hello world");
    act(() => editor.restore(base));
    expect(editor.readSnapshot()).toMatchObject({ text: "hello", selection: { start: 5, end: 5 } });
    // Previews never reported a change of the words.
    expect(changes.map((change) => change.text)).not.toContain("hello world");
    pressKey(field, "z", mod);
    expect(composerText(field)).toBe("");
    typeInto(field, "a b");
    act(() => editor.replace({ start: 0, end: 3 }, `a ${task} b`, { historyGroup: "dictation" }));
    expect(composerText(field)).toBe(`a ${task} b`);
    pressKey(field, "z", mod);
    expect(composerText(field)).toBe("a b");
  });

  it("flushes input the view has not read yet and refuses a replaced draft", async () => {
    const { editor, field, reset } = mount("draft");
    const paragraph = field.querySelector("p")!;
    paragraph.firstChild!.textContent = "draft!";
    const { generation } = editor.readSnapshot();
    await expect(editor.flushPendingInput(generation)).resolves.toMatchObject({
      text: "draft!",
      composing: false,
    });
    reset("");
    expect(composerText(field)).toBe("");
    await expect(editor.flushPendingInput(generation)).rejects.toThrow();
    await expect(editor.flushPendingInput(editor.readSnapshot().generation)).resolves.toMatchObject(
      { text: "" },
    );
  });

  it("does not send on an Enter that ends an IME composition", async () => {
    const node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
    const send = vi.fn(async () => undefined);
    act(() => root.render(<Composer onSend={send} placeholder="Reply…" />));
    const field = composerField(node);
    typeInto(field, "こんにちは");
    act(() => {
      field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    });
    // The Enter that chooses the IME's candidate is the IME's, not a send or a new line.
    const composing = pressKey(field, "Enter", {
      isComposing: true,
      keyCode: 229,
    } as KeyboardEventInit);
    expect(composing.defaultPrevented).toBe(false);
    act(() => {
      field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
    });
    expect(send).not.toHaveBeenCalled();
    expect(composerText(field)).toBe("こんにちは");
    await act(async () => {
      pressKey(field, "Enter");
    });
    expect(send).toHaveBeenCalledWith("こんにちは", expect.anything());
  });
});
