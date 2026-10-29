// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditingOperation, EditingTargetAbilities } from "@opensteer/client/editing";
import type { EditingContext } from "@opensteer/protocol/editing";
import { RemoteEditingProxy, type RemoteEditingProxyHandle } from "./remote-editing-proxy.js";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const abilities: EditingTargetAbilities = {
  composition: true,
  rangeEdits: true,
  commands: true,
  clipboard: "full",
};
const context: EditingContext = {
  contextId: "00000000-0000-4000-8000-000000000001",
  field: {
    kind: "text",
    multiline: true,
    sensitive: false,
    inputMode: "email",
    enterKeyHint: "send",
    autocapitalize: "words",
  },
  caret: { x: 0.2, y: 0.3, height: 0.03 },
};
let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "opensteerDesktop");
});
function setup(
  options: {
    context?: EditingContext | null;
    insideForm?: boolean;
    abilities?: EditingTargetAbilities;
    enabled?: boolean;
  } = {},
) {
  const container = document.createElement(options.insideForm ? "form" : "div");
  document.body.append(container);
  root = createRoot(container);
  const operations: EditingOperation[] = [];
  const leave = vi.fn();
  let handle: RemoteEditingProxyHandle | null = null;
  const wire = {
    send: vi.fn(async (operation: EditingOperation) => {
      operations.push(operation);
      return undefined;
    }),
  };
  const render = (next: typeof options = {}) =>
    act(() => {
      root?.render(
        <RemoteEditingProxy
          abilities={next.abilities ?? options.abilities ?? abilities}
          caret={{ left: 120, top: 65, height: 18 }}
          context={
            next.context === undefined
              ? options.context === undefined
                ? context
                : options.context
              : next.context
          }
          enabled={next.enabled ?? options.enabled ?? true}
          label="Remote keyboard"
          onLeave={leave}
          platform="mac"
          ref={(value) => {
            handle = value;
          }}
          wire={wire}
        />,
      );
    });
  render();
  const element = () =>
    container.querySelector<HTMLTextAreaElement | HTMLInputElement>("textarea,input")!;
  return {
    container,
    operations,
    wire,
    leave,
    element,
    render,
    focusTouch: () => act(() => handle?.focus(true)),
    pointerDown: () => act(() => handle?.pointerDown()),
    pasteFromMenu: () => act(() => handle?.pasteFromMenu()),
  };
}
function input(
  element: HTMLTextAreaElement | HTMLInputElement,
  value: string,
  composing = false,
  inputType = "insertText",
) {
  act(() => {
    element.value = value;
    element.setSelectionRange(value.length, value.length);
    element.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType, isComposing: composing, data: value }),
    );
  });
}
function composition(element: HTMLElement, type: string, data = "") {
  const event = new CompositionEvent(type, { bubbles: true, data });
  Object.defineProperty(event, "data", { value: data });
  act(() => {
    element.dispatchEvent(event);
  });
}

describe("real shared proxy element", () => {
  it.each([
    {
      name: "range-editable text",
      target: abilities,
      fieldContext: context,
      spellcheck: "true",
      autocomplete: null,
      autocorrect: "on",
      capitalization: "words",
      tag: "TEXTAREA",
    },
    {
      name: "local preedit with range edits",
      target: { ...abilities, composition: false },
      fieldContext: context,
      spellcheck: "true",
      autocomplete: null,
      autocorrect: "on",
      capitalization: "words",
      tag: "TEXTAREA",
    },
    {
      name: "sensitive password",
      target: abilities,
      fieldContext: { ...context, field: { ...context.field!, sensitive: true } },
      spellcheck: "false",
      autocomplete: "off",
      autocorrect: "off",
      capitalization: "off",
      tag: "INPUT",
    },
    {
      name: "legacy text",
      target: { ...abilities, rangeEdits: false },
      fieldContext: context,
      spellcheck: "false",
      autocomplete: "off",
      autocorrect: "off",
      capitalization: "off",
      tag: "TEXTAREA",
    },
    {
      name: "legacy password",
      target: { ...abilities, rangeEdits: false },
      fieldContext: { ...context, field: { ...context.field!, sensitive: true } },
      spellcheck: "false",
      autocomplete: "off",
      autocorrect: "off",
      capitalization: "off",
      tag: "INPUT",
    },
    {
      name: "non-editable surface",
      target: abilities,
      fieldContext: { ...context, field: null },
      spellcheck: "false",
      autocomplete: "off",
      autocorrect: "off",
      capitalization: "off",
      tag: "TEXTAREA",
    },
    {
      name: "no target context",
      target: abilities,
      fieldContext: null,
      spellcheck: "false",
      autocomplete: "off",
      autocorrect: "off",
      capitalization: "off",
      tag: "TEXTAREA",
    },
    {
      name: "text without capitalization hint",
      target: abilities,
      fieldContext: {
        ...context,
        field: { kind: "text" as const, multiline: true, sensitive: false },
      },
      spellcheck: "true",
      autocomplete: null,
      autocorrect: "on",
      capitalization: "off",
      tag: "TEXTAREA",
    },
    {
      name: "password without keyboard hints",
      target: abilities,
      fieldContext: {
        ...context,
        field: { kind: "text" as const, multiline: false, sensitive: true },
      },
      spellcheck: "false",
      autocomplete: "off",
      autocorrect: "off",
      capitalization: "off",
      tag: "INPUT",
    },
  ])(
    "keyboard suggestions follow mirror authority: $name",
    ({ target, fieldContext, spellcheck, autocomplete, autocorrect, capitalization, tag }) => {
      const { element, container } = setup({
        abilities: target,
        context: fieldContext,
        insideForm: true,
      });
      expect(element().tagName).toBe(tag);
      expect(element().getAttribute("autocomplete")).toBe(autocomplete);
      expect(element().getAttribute("spellcheck")).toBe(spellcheck);
      expect(element().getAttribute("autocorrect")).toBe(autocorrect);
      expect(element().getAttribute("autocapitalize")).toBe(capitalization);
      expect(element().getAttribute("inputmode")).toBe(
        fieldContext?.field ? (fieldContext.field.inputMode ?? null) : "none",
      );
      expect(element().getAttribute("enterkeyhint")).toBe(
        fieldContext?.field?.enterKeyHint ?? null,
      );
      expect(element().getAttribute("name")).toBeNull();
      expect(element().getAttribute("id")).toBeNull();
      // Happy DOM 20 ignores explicit form owners; the native probe checks form === null.
      expect(element().getAttribute("form")).toBe("");
      expect(container.querySelector("label")).toBeNull();
      if (tag === "INPUT") expect(element().getAttribute("type")).toBe("password");
    },
  );
  it("sends a printable key with text once and keeps its native echo as context", () => {
    const { element, operations } = setup();
    const field = element();
    act(() => {
      field.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "a", code: "KeyA" }),
      );
    });
    input(field, "a");
    expect(operations).toMatchObject([{ kind: "key", keystroke: { text: "a" } }]);
    expect(field.value).toBe("a");
  });
  it("never clears preedit in input/composition handlers and commits repeated syllables", () => {
    const { element, operations } = setup();
    const field = element();
    composition(field, "compositionstart");
    input(field, "한", true, "insertCompositionText");
    expect(field.value).toBe("한");
    composition(field, "compositionend", "한");
    composition(field, "compositionstart");
    input(field, "한한", true, "insertCompositionText");
    composition(field, "compositionend", "한");
    expect(operations.filter((op) => op.kind === "edit")).toHaveLength(2);
  });
  it("uses remote caret and field hints, then replaces sensitive fields with a password proxy", () => {
    const { element, render } = setup();
    expect(element().style.left).toBe("120px");
    expect(element().inputMode).toBe("email");
    expect(element().getAttribute("enterkeyhint")).toBe("send");
    render({ context: { ...context, field: { ...context.field!, sensitive: true } } });
    expect(element().tagName).toBe("INPUT");
    expect(element().getAttribute("type")).toBe("password");
  });
  it("opens a touch keyboard only for editables and leaves on unmodified F6 only", () => {
    const { element, focusTouch, render, leave, operations } = setup({ context: null });
    focusTouch();
    expect(document.activeElement).not.toBe(element());
    render({ context });
    focusTouch();
    expect(document.activeElement).toBe(element());
    act(() => {
      element().dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "F6",
          code: "F6",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(leave).not.toHaveBeenCalled();
    expect(operations.at(-1)).toMatchObject({ kind: "key", keystroke: { key: "F6" } });
    act(() => {
      element().dispatchEvent(
        new KeyboardEvent("keydown", { key: "F6", code: "F6", bubbles: true, cancelable: true }),
      );
    });
    expect(leave).toHaveBeenCalledOnce();
  });
  it("retires a composing textarea when a sensitive context replaces its DOM element", () => {
    const { element, render, operations } = setup();
    const old = element();
    old.focus();
    composition(old, "compositionstart");
    input(old, "한", true, "insertCompositionText");
    render({
      context: {
        ...context,
        contextId: crypto.randomUUID(),
        field: { ...context.field!, sensitive: true },
      },
    });
    const next = element();
    act(() => {
      next.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "b", code: "KeyB" }),
      );
    });
    input(next, "b");
    expect(operations.filter((operation) => operation.kind === "edit")).toHaveLength(1);
    expect(operations.at(-1)).toMatchObject({ kind: "key", keystroke: { text: "b" } });
  });
  it("asks the native text control to end composition before pointer focus moves", () => {
    const { element, pointerDown, operations } = setup();
    const field = element();
    field.focus();
    composition(field, "compositionstart");
    input(field, "한", true, "insertCompositionText");
    pointerDown();
    expect(document.activeElement).not.toBe(field);
    composition(field, "compositionend", "한");
    expect(operations.filter((operation) => operation.kind === "edit")).toHaveLength(1);
  });
  it("releases an admitted key when the viewer becomes disabled", () => {
    const { element, render, operations } = setup();
    act(() => {
      element().dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    render({ enabled: false });
    expect(
      operations.map((operation) =>
        operation.kind === "key" ? operation.keystroke.action : operation.kind,
      ),
    ).toEqual(["down", "up"]);
  });
  it("uses the desktop native paste command from the streamed menu", async () => {
    const paste = vi.fn(async () => undefined);
    Object.defineProperty(window, "opensteerDesktop", {
      configurable: true,
      value: { pasteViewerClipboard: paste },
    });
    const { pasteFromMenu, operations } = setup();
    pasteFromMenu();
    await act(async () => Promise.resolve());
    expect(paste).toHaveBeenCalledOnce();
    expect(operations).toEqual([]);
  });
  it("renders local preedit when the target has no composition ability", () => {
    const { element, container, operations } = setup({
      abilities: { ...abilities, composition: false },
    });
    composition(element(), "compositionstart");
    input(element(), "かな", true, "insertCompositionText");
    expect(container.querySelector("[data-remote-preedit]")?.textContent).toBe("かな");
    expect(operations).toEqual([]);
  });
});
