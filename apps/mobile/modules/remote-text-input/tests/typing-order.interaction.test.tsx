// @vitest-environment happy-dom
import { act, useImperativeHandle } from "react";
import type { EditingOperation } from "@opensteer/client/editing";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeField, type Answer, type Packet, type Proxy } from "./remote-input-port.js";

/*
 * Text typed into a remote page arrives in the order typed, at any speed. The walk typed
 * 0123456789 fast and the target received 1023456789: UIKit names a keystroke's place in the text
 * as it stands when it calls, while the keystrokes before it still wait for JavaScript's answer.
 *
 * The native view here is the port in remote-input-port.ts: every default waits for its numbered
 * answer, the answers arrive only when the test lets them, late and out of step with the
 * keystrokes, and the keyboard names places in the text as it stands at the moment it types. The
 * truth for the view is RemoteTextInputTests.swift; these check the JavaScript adapter and reducer
 * over it.
 */

/** The remote field: it takes an edit only where its own text says it goes. */
class RemoteField {
  value = "";
  caret = 0;
  composition: { start: number; end: number } | null = null;
  refused: EditingOperation[] = [];
  /** Every operation the field was sent, in order. */
  sent: EditingOperation[] = [];
  take = (operation: EditingOperation): boolean => {
    this.sent.push(operation);
    switch (operation.kind) {
      case "edit": {
        const { before = "", after = "", text } = operation.edit;
        const range = this.composition ?? {
          start: this.caret - before.length,
          end: this.caret + after.length,
        };
        if (
          !this.composition &&
          (this.value.slice(range.start, this.caret) !== before ||
            this.value.slice(this.caret, range.end) !== after)
        ) {
          this.refused.push(operation);
          return false;
        }
        this.value = this.value.slice(0, range.start) + text + this.value.slice(range.end);
        this.caret = range.start + text.length;
        this.composition = null;
        return true;
      }
      case "compose": {
        const { before = "", after = "", text } = operation.composition;
        const range = this.composition ?? {
          start: this.caret - before.length,
          end: this.caret + after.length,
        };
        this.value = this.value.slice(0, range.start) + text + this.value.slice(range.end);
        this.composition = text ? { start: range.start, end: range.start + text.length } : null;
        this.caret = range.start + text.length;
        return true;
      }
      case "command":
        if (operation.command === "moveBackward") this.caret = Math.max(0, this.caret - 1);
        else if (operation.command === "moveForward")
          this.caret = Math.min(this.value.length, this.caret + 1);
        return true;
      case "paste": {
        const item = operation.items.find((candidate) => candidate.type === "text/plain");
        const text = item ? new TextDecoder().decode(item.bytes) : "";
        this.value = this.value.slice(0, this.caret) + text + this.value.slice(this.caret);
        this.caret += text.length;
        return true;
      }
      default:
        return true;
    }
  };
}

const harness = vi.hoisted(() => ({
  field: null as null | {
    deliver(packet: unknown): void;
    respond(instruction: unknown): Promise<void>;
    finishComposition(): Promise<void>;
  },
  mounted: false,
  answers: [] as (() => void)[],
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: ({ children }: { children?: import("react").ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../../src/ui/primitives.js", () => ({
  AppText: ({ children }: { children?: import("react").ReactNode }) => <span>{children}</span>,
}));
vi.mock("expo", async () => {
  const React = await import("react");
  return {
    // The view's own functions: the same answers the by-tag functions give, in the same order.
    requireOptionalNativeModule: () => null,
    requireNativeView: () =>
      React.forwardRef(
        (props: { onProxyEvent(event: { nativeEvent: unknown }): void; onLayout(): void }, ref) => {
          const onProxyEvent = React.useRef(props.onProxyEvent);
          onProxyEvent.current = props.onProxyEvent;
          React.useEffect(() => {
            harness.field!.deliver = (packet) => onProxyEvent.current({ nativeEvent: packet });
            harness.mounted = true;
            props.onLayout();
          }, []);
          useImperativeHandle(ref, () => ({
            respond: (instruction: unknown) => harness.field!.respond(instruction),
            finishComposition: () => harness.field!.finishComposition(),
          }));
          return <div />;
        },
      ),
  };
});
const { NativeEditingProxy } = await import("../src/editing-proxy.js");
// The proxy loads the native input lazily: load it once here, outside any test's act.
await import("../src/remote-text-input.js");

const context = {
  contextId: "00000000-0000-4000-8000-000000000001",
  field: { kind: "text", multiline: false, sensitive: false },
  caret: null,
} as const;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
afterEach(async () => {
  await act(async () => root.render(null));
  harness.answers = [];
  harness.field = null;
  harness.mounted = false;
});

/** A Mac app or a phone screen: no range edits, so a replacement in the middle is refused. */
const displayAbilities = {
  composition: true,
  rangeEdits: false,
  commands: true,
  clipboard: "text",
} as const;

async function open(abilities?: typeof displayAbilities) {
  const remote = new RemoteField();
  let native: NativeField | null = null;
  const pending: Packet[] = [];
  harness.field = {
    // Packets before the view is laid out wait for it, as Expo's event dispatcher's do.
    deliver: (packet) => pending.push(packet as Packet),
    // Each answer reaches the main queue only when the test lets it.
    respond: (instruction) =>
      new Promise<void>((resolve) =>
        harness.answers.push(() => {
          native!.respond(instruction as Answer);
          resolve();
        }),
      ),
    finishComposition: async () => native!.unmarkText(),
  };
  native = new NativeField((packet) => harness.field!.deliver(packet));
  native.contextId = context.contextId;
  await act(async () =>
    root.render(
      <NativeEditingProxy
        context={context}
        sendOperation={remote.take}
        onDone={() => undefined}
        {...(abilities ? { abilities } : {})}
      />,
    ),
  );
  await vi.waitFor(() => expect(harness.mounted).toBe(true));
  expect(pending).toEqual([]);
  /** The keyboard does something, inside React's act like any native event. */
  const keyboard = (what: (field: NativeField) => void) => act(async () => what(native!));
  /** The oldest `count` answers arrive; all of them when no count is given. */
  const answer = (count = Infinity) =>
    act(async () => {
      for (let index = 0; index < count && harness.answers.length > 0; index++) {
        harness.answers.shift()!();
        await Promise.resolve();
      }
    });
  const answerAll = async () => {
    while (harness.answers.length > 0) await answer();
  };
  return { remote, native: native as NativeField, keyboard, answer, answerAll };
}

describe("typing into a remote field", () => {
  it("delivers a burst of ten with every answer late, as typed", async () => {
    const { remote, native, keyboard, answer, answerAll } = await open();
    for (const digit of "0123456789") {
      await keyboard((field) => field.type(digit));
      // The answer to what came before arrives only after this keystroke.
      await answer(1);
    }
    await answerAll();
    expect(native.text).toBe("0123456789");
    expect(remote.refused).toEqual([]);
    expect(remote.value).toBe("0123456789");
  });

  it("delivers ten typed before any answer, as typed", async () => {
    const { remote, native, keyboard, answerAll } = await open();
    for (const digit of "0123456789") await keyboard((field) => field.type(digit));
    await answerAll();
    expect(native.text).toBe("0123456789");
    expect(remote.value).toBe("0123456789");
  });

  it("never moves the caret back over newer text when an older answer arrives", async () => {
    const { native, keyboard, answer } = await open();
    for (const letter of "abc") await keyboard((field) => field.type(letter));
    const seen: Proxy[] = [];
    while (harness.answers.length > 0) {
      await answer(1);
      seen.push(native.snapshot());
    }
    for (const state of seen) {
      expect("abc".startsWith(state.value)).toBe(true);
      expect(state.selectionEnd).toBe(state.value.length);
    }
    expect(native.text).toBe("abc");
  });

  it("keeps the order when a composition finishes in the middle of a burst", async () => {
    const { remote, native, keyboard, answerAll } = await open();
    await keyboard((field) => field.type("x"));
    await keyboard((field) => field.setMarkedText("に"));
    await keyboard((field) => field.setMarkedText("日"));
    await keyboard((field) => field.unmarkText());
    await keyboard((field) => field.type("y"));
    await keyboard((field) => field.type("z"));
    await answerAll();
    expect(native.text).toBe("x日yz");
    expect(remote.value).toBe("x日yz");
  });

  it("keeps the order around a paste typed in the middle of a burst", async () => {
    const { remote, keyboard, answerAll } = await open();
    const pasted = "The quick brown fox jumps over a lazy do";
    expect(pasted).toHaveLength(40);
    await keyboard((field) => field.type("a"));
    await keyboard((field) => field.type("b"));
    await keyboard((field) => field.paste(pasted));
    await keyboard((field) => field.type("c"));
    await answerAll();
    expect(remote.value).toBe(`ab${pasted}c`);
  });

  // An edit that begins where a named range ends is outside it, whatever it removed.
  it("replaces only the word named when the space beside it was replaced first", async () => {
    const { native, keyboard, answerAll } = await open();
    await keyboard((field) => field.type("ab cd"));
    await answerAll();
    await keyboard((field) => field.replaceRange(2, 3, "\n\n"));
    await keyboard((field) => field.replaceRange(0, 2, "AB"));
    await answerAll();
    expect(native.text).toBe("AB\n\ncd");
  });

  // The walk: 0123456789, then five backspaces in one burst, and 0123456 arrived.
  it("deletes five for five backspaces named before any answer", async () => {
    const { remote, native, keyboard, answerAll } = await open();
    for (const digit of "0123456789") await keyboard((field) => field.type(digit));
    await answerAll();
    for (let press = 0; press < 5; press++) await keyboard((field) => field.backspace());
    await answerAll();
    expect(native.text).toBe("01234");
    expect(remote.value).toBe("01234");
  });

  it("deletes five for five backspaces pressed while the ten still wait", async () => {
    const { remote, native, keyboard, answerAll } = await open();
    for (const digit of "0123456789") await keyboard((field) => field.type(digit));
    for (let press = 0; press < 5; press++) await keyboard((field) => field.deleteBackward());
    await answerAll();
    expect(native.text).toBe("01234");
    expect(remote.value).toBe("01234");
  });

  // The review's fault 1: a typo then Backspace at once erased the character before the typo.
  it("erases the typo when Backspace follows it at once", async () => {
    const { remote, native, keyboard, answerAll } = await open();
    await keyboard((field) => field.type("a"));
    await answerAll();
    await keyboard((field) => field.type("b"));
    await keyboard((field) => field.backspace());
    await answerAll();
    expect(native.text).toBe("a");
    expect(remote.value).toBe("a");
  });

  it("erases the last of nine still waiting when Backspace follows them", async () => {
    const { remote, native, keyboard, answerAll } = await open();
    await keyboard((field) => field.type("0"));
    await answerAll();
    for (const digit of "123456789") await keyboard((field) => field.type(digit));
    await keyboard((field) => field.backspace());
    await answerAll();
    expect(native.text).toBe("012345678");
    expect(remote.value).toBe("012345678");
  });

  // The review's fault 2: a queued selection report moved the caret back under the next keystroke.
  it("types where a drag of the caret ended", async () => {
    const { remote, native, keyboard, answer, answerAll } = await open();
    await keyboard((field) => field.type("hello"));
    await answerAll();
    await keyboard((field) => field.moveSelection(0));
    await answerAll();
    for (let offset = 1; offset <= 5; offset++)
      await keyboard((field) => field.moveSelection(offset));
    expect(native.queued).toBe(1);
    await answer(1);
    await keyboard((field) => field.insertText("!"));
    await answerAll();
    expect(native.text).toBe("hello!");
    expect(remote.value).toBe("hello!");
  });

  it("types at a tap made while an earlier keystroke waits", async () => {
    const { remote, native, keyboard, answer, answerAll } = await open();
    await keyboard((field) => field.type("hello"));
    await answerAll();
    await keyboard((field) => field.insertText("a"));
    await keyboard((field) => field.moveSelection(0));
    await answer(1);
    await keyboard((field) => field.insertText("X"));
    await answerAll();
    expect(native.text).toBe("Xhelloa");
    expect(remote.value).toBe("Xhelloa");
  });

  // The recheck's fault 1: an edit's event carried a caret chosen after it, so the remote caret
  // moved back before the second character and the second arrived as a rewrite, or was refused.
  it.each([
    ["a page (range edits)", undefined],
    ["a Mac app or phone screen (no range edits)", displayAbilities],
  ] as const)(
    "on %s, delivers two characters typed before a tap, then moves once",
    async (_name, abilities) => {
      const { remote, native, keyboard, answerAll } = await open(abilities);
      await keyboard((field) => field.type("hello"));
      await answerAll();
      const before = remote.sent.length;
      await keyboard((field) => field.insertText("a"));
      await keyboard((field) => field.insertText("b"));
      await keyboard((field) => field.moveSelection(0));
      await answerAll();
      const sent = remote.sent.slice(before);
      expect(remote.refused).toEqual([]);
      // A target without range edits keeps no mirror: the field is cleared after each edit.
      expect(native.text).toBe(abilities ? "" : "helloab");
      expect(remote.value).toBe("helloab");
      // Both characters, as plain appends, then the caret's moves, all after the second.
      const edits = sent.filter((operation) => operation.kind === "edit");
      expect(edits.map((operation) => operation.kind === "edit" && operation.edit)).toEqual(
        ["a", "b"].map((text) => ({ contextId: context.contextId, text, before: "", after: "" })),
      );
      const lastEdit = sent.lastIndexOf(edits.at(-1)!);
      expect(sent.slice(0, lastEdit).some((operation) => operation.kind === "command")).toBe(false);
      expect(sent.slice(lastEdit + 1).every((operation) => operation.kind === "command")).toBe(
        true,
      );
      // A page follows the tap; a target without range edits gets no caret moves from a selection
      // (the reducer keeps no mirror to measure them against), so it stays after the "b".
      expect(remote.caret).toBe(abilities ? 7 : 0);
    },
  );

  it("deletes what was typed last, however late its turn", async () => {
    const { remote, native, keyboard, answerAll } = await open();
    for (const letter of "abcd") await keyboard((field) => field.type(letter));
    await keyboard((field) => field.deleteBackward());
    await keyboard((field) => field.type("e"));
    await answerAll();
    expect(native.text).toBe("abce");
    expect(remote.value).toBe("abce");
  });
});
