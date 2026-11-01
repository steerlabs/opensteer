// @vitest-environment happy-dom
import { act, createRef, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { createMobileBrowserEditing } from "../../../src/browser/browser-editing.js";
import type { BrowserCommand } from "@opensteer/client/host";
const harness = vi.hoisted(() => ({
  proxy: null as null | {
    onEvent: (event: import("@opensteer/client/editing").EditingProxyEvent) => void;
    context: unknown;
    finishCompositionRequest?: number;
  },
  contexts: [] as unknown[],
  legacy: null as null | {
    value: string;
    onKeyPress(event: { nativeEvent: { key: string } }): void;
    onChangeText(text: string): void;
    onSubmitEditing(): void;
  },
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  StyleSheet: { create: (v: unknown) => v, hairlineWidth: 1 },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TextInput: (props: NonNullable<typeof harness.legacy>) => {
    harness.legacy = props;
    return <input aria-label="Type into the page" value={props.value} readOnly />;
  },
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => (
    <button aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("../src/remote-text-input.js", () => ({
  RemoteTextInput: (props: {
    onEvent: (event: import("@opensteer/client/editing").EditingProxyEvent) => void;
    context: unknown;
    finishCompositionRequest?: number;
  }) => {
    harness.proxy = props;
    harness.contexts.push(props.context);
    return <div data-native-proxy />;
  },
}));
vi.mock("../../../src/ui/primitives.js", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Notice: () => null,
}));
vi.mock("../../../src/ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("../../../src/browser/browser-stream.js", () => ({
  BrowserStream: () => null,
  submitBrowserCommand: () => true,
  useBrowserFeedState: () => ({ status: "live" }),
}));
vi.mock("../../../src/browser/chrome-sign-in-action.js", () => ({
  ChromeSignInAction: () => null,
}));
vi.mock("../../../src/browser/surface-header.js", () => ({ useSurfaceHeader: () => undefined }));
vi.mock("../../../src/client/mobile-client.js", () => ({ operationDetail: () => "error" }));
vi.mock("../../../src/ui/action-review.js", () => ({ ActionReviewSheet: () => null }));
import { PageTyping } from "../../../src/browser/browser-page.js";
const context = {
  contextId: "00000000-0000-4000-8000-000000000001",
  field: { kind: "text", multiline: true, sensitive: true },
  caret: { x: 0.2, y: 0.3, height: 0.04 },
} as const;
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
afterEach(async () => {
  await act(async () => root.render(null));
  harness.proxy = null;
  harness.legacy = null;
});

it("preserves baseline Backspace intent through the production page and shared transport", async () => {
  const commands: BrowserCommand[] = [];
  const done = vi.fn();
  const port = createMobileBrowserEditing(
    {},
    "session",
    "srf_00000000-0000-4000-8000-000000000001",
    (command) => {
      commands.push(command);
      return true;
    },
    { write: async () => "written" },
  );
  const stop = port.activate(done);
  try {
    await act(async () =>
      root.render(<PageTyping legacy context={null} onDone={done} sendOperation={port.send} />),
    );
    const change = async (value: string) => act(async () => harness.legacy?.onChangeText(value));
    const backspace = async (value: string) => {
      await act(async () => harness.legacy?.onKeyPress({ nativeEvent: { key: "Backspace" } }));
      await change(value);
    };
    await change("a");
    await change("ab");
    await backspace("a");
    await backspace("");
    await backspace("");
    await change("👩‍💻");
    await backspace("");
    await change("c");
    await act(async () => harness.legacy?.onSubmitEditing());
    expect(done).not.toHaveBeenCalled();
    expect(harness.legacy?.value).toBe("");
    expect(
      commands
        .filter((command) => command.type === "clipboard.paste")
        .map((command) => command.text),
    ).toEqual(["a", "b", "👩‍💻", "c"]);
    expect(
      commands
        .filter((command) => command.type === "input.key")
        .map((command) => ({ action: command.action, key: command.key })),
    ).toEqual(
      ["Backspace", "Backspace", "Backspace", "Backspace", "Enter"].flatMap((key) => [
        { action: "down", key },
        { action: "up", key },
      ]),
    );
    const directory =
      process.env.OPENSTEER_MOBILE_EDITING_EVIDENCE_DIR ?? "/tmp/opensteer-mobile-editing";
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      `${directory}/baseline-journey.json`,
      JSON.stringify({ status: "passed-scripted-component-journey", commands }, null, 2),
    );
  } finally {
    stop();
  }
});

it("refuses a baseline replacement without an explicit Backspace intent", async () => {
  const send = vi.fn(() => true);
  const done = vi.fn();
  await act(async () =>
    root.render(<PageTyping legacy context={null} onDone={done} sendOperation={send} />),
  );
  await act(async () => harness.legacy?.onChangeText("ab"));
  await act(async () => harness.legacy?.onChangeText("a"));
  expect(done).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledTimes(1);
});
it("the page forwards native edits once and configures its sensitive field", async () => {
  const send = vi.fn(() => true);
  await act(async () =>
    root.render(<PageTyping context={context} onDone={() => undefined} sendOperation={send} />),
  );
  expect(harness.proxy?.context).toEqual(context);
  await act(async () =>
    harness.proxy?.onEvent({
      type: "input",
      inputType: "insertText",
      composing: false,
      proxy: { value: "👩‍💻", selectionStart: 5, selectionEnd: 5 },
    }),
  );
  expect(send).toHaveBeenCalledExactlyOnceWith({
    kind: "edit",
    edit: { contextId: context.contextId, text: "👩‍💻", before: "", after: "" },
  });
});
it("keeps the native proxy open when the remote operation is refused", async () => {
  const done = vi.fn();
  await act(async () =>
    root.render(<PageTyping context={context} onDone={done} sendOperation={() => false} />),
  );
  await act(async () =>
    harness.proxy?.onEvent({
      type: "input",
      inputType: "insertText",
      composing: false,
      proxy: { value: "a", selectionStart: 1, selectionEnd: 1 },
    }),
  );
  expect(done).not.toHaveBeenCalled();
});

it("ends native preedit when a remote pointer interrupts it", async () => {
  const send = vi.fn((_operation: import("@opensteer/client/editing").EditingOperation) => true);
  const control = createRef<import("../src/editing-proxy.js").NativeEditingProxyHandle>();
  await act(async () =>
    root.render(
      <PageTyping ref={control} context={context} onDone={() => undefined} sendOperation={send} />,
    ),
  );
  await act(async () => {
    harness.proxy?.onEvent({
      type: "compositionstart",
      proxy: { value: "", selectionStart: 0, selectionEnd: 0 },
    });
    harness.proxy?.onEvent({
      type: "compositionupdate",
      data: "に",
      proxy: { value: "に", selectionStart: 1, selectionEnd: 1, markedRange: { start: 0, end: 1 } },
    });
  });
  const previous = harness.proxy?.finishCompositionRequest ?? 0;
  await act(async () => control.current?.interrupt());
  expect(harness.proxy?.finishCompositionRequest ?? 0).toBeGreaterThan(previous);
  expect(
    send.mock.calls
      .map(([operation]) => operation)
      .filter((operation) => operation.kind === "edit"),
  ).toEqual([
    { kind: "edit", edit: { contextId: context.contextId, text: "に", before: "", after: "" } },
  ]);
});

it("lets native configuration end the old context without an extra unscoped finish request", async () => {
  const send = vi.fn((_operation: import("@opensteer/client/editing").EditingOperation) => true);
  const next = { ...context, contextId: "00000000-0000-4000-8000-000000000002" };
  const render = (field: typeof next) =>
    act(async () =>
      root.render(<PageTyping context={field} onDone={() => undefined} sendOperation={send} />),
    );
  await render(context);
  await act(async () => {
    harness.proxy?.onEvent({
      type: "compositionstart",
      proxy: { value: "", selectionStart: 0, selectionEnd: 0 },
    });
    harness.proxy?.onEvent({
      type: "compositionupdate",
      data: "に",
      proxy: { value: "に", selectionStart: 1, selectionEnd: 1, markedRange: { start: 0, end: 1 } },
    });
  });
  const requested = harness.proxy?.finishCompositionRequest;
  await render(next);
  expect(harness.proxy?.finishCompositionRequest).toBe(requested);
  await act(async () => {
    harness.proxy?.onEvent({
      type: "compositionend",
      data: "に",
      proxy: { value: "に", selectionStart: 1, selectionEnd: 1 },
    });
    harness.proxy?.onEvent({
      type: "input",
      inputType: "insertText",
      composing: false,
      proxy: { value: "a", selectionStart: 1, selectionEnd: 1 },
    });
    harness.proxy?.onEvent({
      type: "compositionstart",
      proxy: { value: "a", selectionStart: 1, selectionEnd: 1 },
    });
    harness.proxy?.onEvent({
      type: "compositionupdate",
      data: "한",
      proxy: {
        value: "a한",
        selectionStart: 2,
        selectionEnd: 2,
        markedRange: { start: 1, end: 2 },
      },
    });
    harness.proxy?.onEvent({
      type: "compositionend",
      data: "한",
      proxy: { value: "a한", selectionStart: 2, selectionEnd: 2 },
    });
  });
  expect(
    send.mock.calls
      .map(([operation]) => operation)
      .filter((operation) => operation.kind === "edit"),
  ).toEqual([
    { kind: "edit", edit: { contextId: context.contextId, text: "に", before: "", after: "" } },
    { kind: "edit", edit: { contextId: next.contextId, text: "a", before: "", after: "" } },
    { kind: "edit", edit: { contextId: next.contextId, text: "한", before: "", after: "" } },
  ]);
});
