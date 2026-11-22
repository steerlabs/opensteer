// @vitest-environment happy-dom
import { act, useImperativeHandle } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  characters,
  FarField,
  NativeField,
  type Answer,
  type Packet,
  type Proxy,
} from "./remote-input-port.js";

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

/** The remote field: the page's own applier, as the port models it. */
class RemoteField extends FarField {}

const harness = vi.hoisted(() => ({
  field: null as null | {
    deliver(packet: unknown): void;
    respond(instruction: unknown): Promise<void>;
    finishComposition(): Promise<void>;
    configure?(contextId: string | null): void;
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
        (
          props: {
            onProxyEvent(event: { nativeEvent: unknown }): void;
            onLayout(): void;
            context?: { contextId: string } | null;
          },
          ref,
        ) => {
          const onProxyEvent = React.useRef(props.onProxyEvent);
          onProxyEvent.current = props.onProxyEvent;
          // The context prop reaches the view's configure, as RemoteTextInputModule's Prop does.
          const contextId = props.context?.contextId ?? null;
          React.useEffect(() => harness.field?.configure?.(contextId), [contextId]);
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
  remote.contextId = context.contextId;
  let native: NativeField | null = null;
  const pending: Packet[] = [];
  /**
   * The far text the native mirror does not hold: what was there when the reducer last cleared
   * the native field (a reset, a paste, a new context) or acted outside it (a deletion command).
   * The far field must always equal before + the native text + after.
   */
  let base = { before: "", after: "" };
  const split = () => {
    base = { before: remote.value.slice(0, remote.caret), after: remote.value.slice(remote.caret) };
  };
  let current: typeof context = context;
  const render = () =>
    root.render(
      <NativeEditingProxy
        context={current}
        sendOperation={(operation) => {
          const sent = remote.take(operation);
          if (operation.kind === "command" && !operation.command.startsWith("move")) split();
          return sent;
        }}
        onDone={() => undefined}
        {...(abilities ? { abilities } : {})}
      />,
    );
  /** A new context, as the page publishes it after a refusal or when its field changes. */
  const renew = (contextId: string) => {
    current = { ...context, contextId };
    queueMicrotask(() => {
      // The new context's mirror starts empty at the far caret.
      split();
      render();
    });
  };
  remote.onRotate = renew;
  harness.field = {
    // Packets before the view is laid out wait for it, as Expo's event dispatcher's do.
    deliver: (packet) => pending.push(packet as Packet),
    // Each answer reaches the main queue only when the test lets it.
    respond: (instruction) => {
      if ((instruction as Answer).set) split();
      return new Promise<void>((resolve) =>
        harness.answers.push(() => {
          native!.respond(instruction as Answer);
          resolve();
        }),
      );
    },
    finishComposition: async () => native!.unmarkText(),
    configure: (contextId) => native!.configure(contextId),
  };
  native = new NativeField((packet) => harness.field!.deliver(packet));
  native.contextId = context.contextId;
  await act(async () => render());
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
  /** The page's field changes under the edits still waiting: a new context from the page. */
  const rotate = (contextId: string) =>
    act(async () => {
      remote.contextId = contextId;
      renew(contextId);
    });
  return {
    remote,
    native: native as NativeField,
    keyboard,
    answer,
    answerAll,
    rotate,
    mirror: () => base,
  };
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

// The far-field model, where it differed from the page's applier (the review of d5df54299).
describe("the far-field model", () => {
  it("deletes on a Backspace command, as the page does for a target without range edits", async () => {
    const { remote, keyboard, answerAll } = await open(displayAbilities);
    await keyboard((field) => field.type("a"));
    await keyboard((field) => field.type("b"));
    await answerAll();
    await keyboard((field) => field.deleteBackward());
    await answerAll();
    expect(remote.value).toBe("a");
    expect(remote.caret).toBe(1);
  });
  it("verifies a first composition's before and after, and refuses one that does not match", () => {
    const far = new FarField();
    far.contextId = context.contextId;
    far.take({
      kind: "edit",
      edit: { contextId: context.contextId, text: "ab", before: "", after: "" },
    });
    far.take({
      kind: "compose",
      composition: {
        contextId: context.contextId,
        text: "に",
        selectionStart: 1,
        selectionEnd: 1,
        before: "zz",
        after: "",
      },
    });
    expect(far.refused).toHaveLength(1);
    expect(far.value).toBe("ab");
  });
  it("rotates its context after a refusal and refuses what comes under the old one", () => {
    const far = new FarField();
    far.contextId = context.contextId;
    far.take({
      kind: "edit",
      edit: { contextId: context.contextId, text: "x", before: "q", after: "" },
    });
    expect(far.contextId).not.toBe(context.contextId);
    far.take({
      kind: "edit",
      edit: { contextId: context.contextId, text: "y", before: "", after: "" },
    });
    expect(far.value).toBe("");
    expect(far.refused).toHaveLength(2);
  });
});

// The walk's caret variants, as the native field took them (its accessibility value after each
// attempt): the far side ends with the native text and caret either way.
describe("a person's caret moves and selections in the native field", () => {
  async function settled(text: string) {
    const opened = await open();
    for (const character of text) await opened.keyboard((field) => field.type(character));
    await opened.answerAll();
    return opened;
  }
  const same = (remote: RemoteField, native: NativeField) => {
    expect(remote.refused).toEqual([]);
    expect(remote.value).toBe(native.text);
    if (native.selection.start === native.selection.end)
      expect(remote.caret).toBe(native.selection.start);
  };

  it("(a) a tap that leaves the caret where it was: the character goes there on both sides", async () => {
    const { remote, native, keyboard, answerAll } = await settled("hello");
    await keyboard((field) => field.moveSelection(5));
    await keyboard((field) => field.insertText("!"));
    await answerAll();
    expect(native.text).toBe("hello!");
    same(remote, native);
  });

  it("(b) a tap that selects the misspelled word: typing replaces it on both sides", async () => {
    const { remote, native, keyboard, answer, answerAll } = await settled("hello");
    await keyboard((field) => field.insertText("a"));
    await keyboard((field) => field.insertText("b"));
    await answer(2);
    await keyboard((field) => field.moveSelection(0, 7));
    await keyboard((field) => field.insertText("!"));
    await answerAll();
    expect(native.text).toBe("!");
    same(remote, native);
  });

  it("moves the far caret to a caret put in the middle, and types there", async () => {
    const { remote, native, keyboard, answerAll } = await settled("hello");
    await keyboard((field) => field.moveSelection(2));
    await keyboard((field) => field.insertText("X"));
    await answerAll();
    expect(native.text).toBe("heXllo");
    same(remote, native);
  });

  it("types over a range the person selected", async () => {
    const { remote, native, keyboard, answerAll } = await settled("hello");
    await keyboard((field) => field.moveSelection(1, 4));
    await keyboard((field) => field.insertText("X"));
    await answerAll();
    expect(native.text).toBe("hXo");
    same(remote, native);
  });

  it("types where the person put the caret while a composition's commit waited", async () => {
    // A tap during a composition: UIKit commits it (unmarkText), then moves the caret, both
    // before the composition's own turn. The commit must not leave the native caret at the end
    // of the composition while the far caret goes where the person put it.
    const { remote, native, keyboard, answerAll } = await settled("ab");
    await keyboard((field) => field.setMarkedText("日本"));
    await keyboard((field) => field.unmarkText());
    await keyboard((field) => field.moveSelection(1));
    await answerAll();
    expect(native.selection).toEqual({ start: 1, end: 1 });
    await keyboard((field) => field.insertText("x"));
    await answerAll();
    expect(native.text).toBe("axb日本");
    same(remote, native);
  });

  /*
   * The family's structural test: random sequences of typing (UIKit's insertText and the
   * delegate), Backspace (the delegate) and deleteBackward, the person's caret moves and range
   * selections, with the answers arriving late and in random numbers. After everything settles,
   * the far field holds the native text, and the native caret where it is a caret.
   */
  const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const alphabet = ["a", "b", "é", " ", "👩‍💻"];
  /**
   * The first generator, kept as it was so the seeds it found still replay what they found: one
   * seeded sequence through the real proxy, reducer and port, to a settled comparison.
   */
  async function sequence(seed: number) {
    const next = random(seed);
    const pick = <T,>(items: readonly T[]) => items[Math.floor(next() * items.length)]!;
    const steps: string[] = [];
    const { remote, native, keyboard, answer, answerAll } = await open();
    const length = 1 + Math.floor(next() * 24);
    for (let step = 0; step < length; step++) {
      const boundaries = [0, ...characters(native.text).map(({ end }) => end)];
      const choice = next();
      if (choice < 0.3) {
        const character = pick(alphabet);
        steps.push(`insertText(${JSON.stringify(character)})`);
        await keyboard((field) => field.insertText(character));
      } else if (choice < 0.45) {
        const character = pick(alphabet);
        steps.push(`type(${JSON.stringify(character)})`);
        await keyboard((field) => field.type(character));
      } else if (choice < 0.55) {
        steps.push("backspace()");
        await keyboard((field) => field.backspace());
      } else if (choice < 0.62) {
        steps.push("deleteBackward()");
        await keyboard((field) => field.deleteBackward());
      } else if (choice < 0.74) {
        const at = pick(boundaries);
        steps.push(`moveSelection(${at})`);
        await keyboard((field) => field.moveSelection(at));
      } else if (choice < 0.8) {
        const [start, end] = [pick(boundaries), pick(boundaries)].sort((x, y) => x - y);
        steps.push(`moveSelection(${start}, ${end})`);
        await keyboard((field) => field.moveSelection(start!, end!));
      } else {
        const count = 1 + Math.floor(next() * 3);
        steps.push(`answer(${count})`);
        await answer(count);
      }
    }
    await answerAll();
    const failure = `seed ${seed}: ${steps.join("; ")}`;
    expect(remote.refused, failure).toEqual([]);
    expect(remote.value, failure).toBe(native.text);
    if (native.selection.start === native.selection.end)
      expect(remote.caret, failure).toBe(native.selection.start);
    await act(async () => root.render(null));
    harness.answers = [];
    harness.mounted = false;
  }

  /*
   * The second generator: also a target without range edits, a multi-character replacement at a
   * range (autocorrect), paste, composition between other steps, a context rotation while edits
   * wait, right-to-left letters, and decomposed é with the mark alone named for deletion, as
   * UIKit can name it. The far field must equal the far text outside the native mirror plus the
   * native text, and refuse no edit for its text (refusals for a stale context are the fence).
   */
  const letters = ["a", "b", "\u00e9", "e\u0301", " ", "👩‍💻", "א", "ب"];
  async function sequence2(seed: number) {
    const next = random(seed * 2654435761);
    const pick = <T,>(items: readonly T[]) => items[Math.floor(next() * items.length)]!;
    const steps: string[] = [];
    const display = next() < 0.2;
    if (display) steps.push("display");
    const { remote, native, keyboard, answer, answerAll, rotate, mirror } = await open(
      display ? displayAbilities : undefined,
    );
    let rotations = 0;
    /** The input method is composing from its own setMarkedText on, whatever the field holds yet. */
    let composing = false;
    const length = 1 + Math.floor(next() * 28);
    for (let step = 0; step < length; step++) {
      const boundaries = [0, ...characters(native.text).map(({ end }) => end)];
      let choice = next();
      // While text is marked, UIKit's input method updates or commits it (setMarkedText,
      // insertText) or deletes inside it (deleteBackward); nothing else reaches the field.
      if (composing && !(choice < 0.22 || (choice >= 0.4 && choice < 0.45) || choice >= 0.65))
        choice = next() < 0.5 ? 0.1 : 0.67;
      if (composing && choice >= 0.73 && choice < 0.78) choice = 0.9;
      if (choice < 0.22) {
        const character = pick(letters);
        steps.push(`insertText(${JSON.stringify(character)})`);
        composing = false;
        await keyboard((field) => field.insertText(character));
      } else if (choice < 0.32) {
        const character = pick(letters);
        steps.push(`type(${JSON.stringify(character)})`);
        await keyboard((field) => field.type(character));
      } else if (choice < 0.4) {
        steps.push("backspace()");
        await keyboard((field) => field.backspace());
      } else if (choice < 0.45 && composing) {
        // An input method deletes inside its composition by setting shorter marked text; with
        // one character marked, it cancels the composition.
        steps.push('setMarkedText("")');
        composing = false;
        await keyboard((field) => field.setMarkedText(""));
      } else if (choice < 0.45) {
        steps.push("deleteBackward()");
        await keyboard((field) => field.deleteBackward());
      } else if (choice < 0.54) {
        const at = pick(boundaries);
        steps.push(`moveSelection(${at})`);
        await keyboard((field) => field.moveSelection(at));
      } else if (choice < 0.58) {
        const [start, end] = [pick(boundaries), pick(boundaries)].sort((x, y) => x - y);
        steps.push(`moveSelection(${start}, ${end})`);
        await keyboard((field) => field.moveSelection(start!, end!));
      } else if (choice < 0.62) {
        const [start, end] = [pick(boundaries), pick(boundaries)].sort((x, y) => x - y);
        const word = pick(["the", "ab", "\u00e9"]);
        steps.push(`replaceRange(${start}, ${end}, ${JSON.stringify(word)})`);
        await keyboard((field) => field.replaceRange(start!, end!, word));
      } else if (choice < 0.65) {
        const text = pick(["pasted", "א b"]);
        steps.push(`paste(${JSON.stringify(text)})`);
        await keyboard((field) => field.paste(text));
      } else if (choice < 0.7) {
        const text = pick(["に", "日本"]);
        steps.push(`setMarkedText(${JSON.stringify(text)})`);
        composing = true;
        await keyboard((field) => field.setMarkedText(text));
      } else if (choice < 0.73) {
        steps.push("unmarkText()");
        composing = false;
        await keyboard((field) => field.unmarkText());
      } else if (choice < 0.75) {
        rotations += 1;
        const id = `00000000-0000-4000-9000-${String(seed * 100 + rotations).padStart(12, "0")}`;
        steps.push("rotate()");
        await rotate(id);
      } else if (choice < 0.78) {
        const mark = [...native.text].findIndex((point) => /\p{M}/u.test(point));
        if (mark >= 0) {
          const at = [...native.text].slice(0, mark).join("").length;
          steps.push(`deleteMark(${at})`);
          await keyboard((field) => field.shouldChangeText({ start: at, end: at + 1 }, ""));
        }
      } else {
        const count = 1 + Math.floor(next() * 3);
        steps.push(`answer(${count})`);
        await answer(count);
      }
    }
    await answerAll();
    const failure = `seed ${seed}: ${steps.join("; ")}`;
    expect(remote.mismatched, failure).toEqual([]);
    const { before, after } = mirror();
    expect(remote.value, failure).toBe(before + native.text + after);
    if (native.selection.start === native.selection.end && native.marked === null)
      expect(remote.caret, failure).toBe(before.length + native.selection.start);
    await act(async () => root.render(null));
    harness.answers = [];
    harness.mounted = false;
  }

  // What the random sequences found, kept: seed 32, a prevented Backspace on an empty field whose
  // suppression swallowed a later deletion; seed 4363, a replacement next to a repeated character
  // the reducer could not verify, refused and the field cleared.
  it.each([32, 4363])("replays the sequence the random test found at seed %i", (seed) =>
    sequence(seed),
  );

  // What the second generator found, kept: seed 81, a space typed as a composition committed,
  // named insertFromComposition when typed and lost on the far side; seed 2195, a deletion inside
  // a composition recorded at a caret moved while it waited, so a later keystroke split an emoji;
  // seed 9944, a composition over a selection cancelled, which took the restated text with it;
  // seeds 4021, 15915 and 16868, a caret moved while a composition's commit (unmarkText) waited,
  // left at the composition's end natively while the far caret went where the person put it.
  it.each([81, 2195, 9944, 4021, 15915, 16868])(
    "replays the sequence the second generator found at seed %i",
    (seed) => sequence2(seed),
  );

  // 300 sequences a run; OPENSTEER_TYPING_FUZZ_RUNS and _SEED run more, 300 to a test.
  const runs = Number(process.env.OPENSTEER_TYPING_FUZZ_RUNS ?? 300);
  const firstSeed = Number(process.env.OPENSTEER_TYPING_FUZZ_SEED ?? 1);
  for (let chunk = firstSeed; chunk < firstSeed + runs; chunk += 300) {
    const last = Math.min(chunk + 300, firstSeed + runs) - 1;
    it(`keeps the far field equal to the native one over random sequences ${chunk} to ${last}`, async () => {
      for (let seed = chunk; seed <= last; seed++) await sequence2(seed);
    });
  }
});
