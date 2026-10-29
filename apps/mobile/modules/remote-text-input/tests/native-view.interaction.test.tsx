// @vitest-environment happy-dom
import { act, useImperativeHandle } from "react";
import {
  createEditingState,
  reduceEditing,
  type EditingProxyEvent,
  type EditingProxyInstruction,
} from "@opensteer/client/editing";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({
  props: null as null | { onProxyEvent(event: { nativeEvent: unknown }): void; onLayout(): void },
  respond: vi.fn(async (_instruction: unknown): Promise<void> => undefined),
  finishComposition: vi.fn(async () => undefined),
}));
vi.mock("expo", async () => {
  const React = await import("react");
  return {
    requireNativeView: () =>
      React.forwardRef((props: NonNullable<typeof native.props>, ref) => {
        native.props = props;
        useImperativeHandle(ref, () => ({
          respond: native.respond,
          finishComposition: native.finishComposition,
        }));
        return <div />;
      }),
  };
});
import { RemoteTextInput } from "../src/remote-text-input.js";
const context = {
  contextId: "00000000-0000-4000-8000-000000000001",
  field: { kind: "text", multiline: true, sensitive: false },
  caret: null,
} as const;
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
afterEach(async () => {
  await act(async () => root.render(null));
  native.respond.mockReset();
  native.respond.mockImplementation(async () => undefined);
  native.finishComposition.mockClear();
});
it("applies the reset in the numbered acknowledgement before draining native input", async () => {
  const set = { value: "", selectionStart: 0, selectionEnd: 0 };
  const event = {
    type: "input",
    inputType: "insertText",
    composing: false,
    proxy: { value: "x", selectionStart: 1, selectionEnd: 1 },
  };
  await act(async () =>
    root.render(
      <RemoteTextInput
        context={context}
        focused
        onError={() => {
          throw new Error("native error");
        }}
        onEvent={() => ({ set })}
      />,
    ),
  );
  await act(async () => {
    native.props!.onLayout();
    native.props!.onProxyEvent({ nativeEvent: { id: 1, contextId: context.contextId, event } });
    expect(native.respond.mock.calls).toEqual([[{ id: 1, set }]]);
  });
  expect(native.respond.mock.calls).toEqual([[{ id: 1, set }]]);
});
it.each(["ios", "android"] as const)(
  "%s preserves ab when a is queued behind a context-change composition ending",
  async (platform) => {
    let state = createEditingState(platform, {
      composition: true,
      rangeEdits: true,
      commands: true,
      clipboard: "full",
    });
    const next = { ...context, contextId: "00000000-0000-4000-8000-000000000002" };
    let target = "";
    const edits: unknown[] = [];
    const step = (event: EditingProxyEvent) => {
      const result = reduceEditing(state, event);
      state = result.state;
      for (const operation of result.operations) {
        if (operation.kind === "edit" && operation.edit.contextId === next.contextId) {
          const { before = "", text } = operation.edit;
          expect(target.endsWith(before)).toBe(true);
          target = target.slice(0, target.length - before.length) + text;
          edits.push(operation.edit);
        }
      }
      return result.instruction;
    };
    step({ type: "context", context });
    step({ type: "compositionstart", proxy: { value: "", selectionStart: 0, selectionEnd: 0 } });
    step({
      type: "compositionupdate",
      data: "に",
      proxy: { value: "に", selectionStart: 1, selectionEnd: 1, markedRange: { start: 0, end: 1 } },
    });
    step({ type: "context", context: next });
    await act(async () =>
      root.render(
        <RemoteTextInput
          context={next}
          focused
          onEvent={step}
          onError={() => {
            throw new Error("native error");
          }}
        />,
      ),
    );
    let value = "に";
    let queued = true;
    let id = 1;
    const emit = (event: EditingProxyEvent, contextId = next.contextId) =>
      native.props!.onProxyEvent({ nativeEvent: { id: id++, contextId, event } });
    const insert = (text: string) => {
      value += text;
      emit({
        type: "input",
        inputType: "insertText",
        composing: false,
        proxy: { value, selectionStart: value.length, selectionEnd: value.length },
      });
    };
    native.respond.mockImplementation(async (raw: unknown) => {
      const instruction = raw as EditingProxyInstruction & { id: number };
      if (instruction.set) value = instruction.set.value;
      if (instruction.id === 1 && queued) {
        queued = false;
        // Native configure clears the old field, then drains a queued keystroke.
        value = "";
        insert("a");
      }
    });
    await act(async () => {
      native.props!.onLayout();
      emit(
        {
          type: "compositionend",
          data: "に",
          proxy: { value, selectionStart: 1, selectionEnd: 1 },
        },
        context.contextId,
      );
    });
    await act(async () => insert("b"));
    expect(target).toBe("ab");
    expect(edits).toEqual(
      ["a", "b"].map((text) => ({ contextId: next.contextId, before: "", after: "", text })),
    );
    expect(native.respond.mock.calls.every(([raw]) => (raw as { id: number }).id > 0)).toBe(true);
  },
);
it("fences stale text but delivers old-context composition endings and hardware releases", async () => {
  const events: unknown[] = [];
  await act(async () =>
    root.render(
      <RemoteTextInput
        context={context}
        focused
        onError={() => {
          throw new Error("native error");
        }}
        onEvent={(event) => {
          events.push(event);
          return {};
        }}
      />,
    ),
  );
  const ending = {
    type: "compositionend",
    data: "한",
    proxy: { value: "한", selectionStart: 1, selectionEnd: 1 },
  };
  const key = {
    type: "keyup",
    key: "a",
    code: "KeyA",
    control: false,
    alt: false,
    meta: false,
    shift: false,
    altGraph: false,
    location: 0,
    repeat: false,
    composing: false,
  };
  await act(async () => {
    native.props!.onProxyEvent({
      nativeEvent: {
        id: 1,
        contextId: "old",
        event: {
          type: "input",
          inputType: "insertText",
          composing: false,
          proxy: { value: "bad", selectionStart: 3, selectionEnd: 3 },
        },
      },
    });
    native.props!.onProxyEvent({ nativeEvent: { id: 2, contextId: "old", event: ending } });
    native.props!.onProxyEvent({ nativeEvent: { id: 3, contextId: "old", event: key } });
  });
  expect(events).toEqual([ending, key]);
  expect(native.respond.mock.calls[0]).toEqual([{ id: 1, preventDefault: true }]);
});

it("requests the native composition ending outside the event handler once per interruption", async () => {
  const event = () => ({});
  await act(async () =>
    root.render(
      <RemoteTextInput
        context={context}
        focused
        onError={() => undefined}
        onEvent={event}
        finishCompositionRequest={1}
      />,
    ),
  );
  expect(native.finishComposition).not.toHaveBeenCalled();
  await act(async () => native.props!.onLayout());
  expect(native.finishComposition).toHaveBeenCalledOnce();
  await act(async () =>
    root.render(
      <RemoteTextInput
        context={context}
        focused
        onError={() => undefined}
        onEvent={event}
        finishCompositionRequest={1}
      />,
    ),
  );
  expect(native.finishComposition).toHaveBeenCalledOnce();
});

it("does not reset a view before registration and ignores late rejection after removal", async () => {
  let reject: ((error: Error) => void) | undefined;
  native.respond.mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      }),
  );
  const error = vi.fn();
  await act(async () =>
    root.render(
      <RemoteTextInput
        context={context}
        focused
        onError={error}
        onEvent={() => ({})}
        instruction={{ set: { value: "", selectionStart: 0, selectionEnd: 0 } }}
      />,
    ),
  );
  expect(native.respond).not.toHaveBeenCalled();
  await act(async () => native.props!.onLayout());
  expect(native.respond).toHaveBeenCalledOnce();
  await act(async () => root.render(null));
  await act(async () => reject!(new Error("Unable to find view with tag")));
  expect(error).not.toHaveBeenCalled();
});
