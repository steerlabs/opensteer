// @vitest-environment happy-dom
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { act, createRef, useImperativeHandle } from "react";
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
import { splitGraphemes } from "unicode-segmenter/grapheme";
import {
  caretRelativeEditingCommands,
  committedRemainder,
  editingTextMaxLength,
} from "@opensteer/protocol/editing";
import { Oracle, Person, type Action } from "./typing-oracle.js";
import { browserEditingAbilities } from "../../../../../packages/client/src/host/browser-editing.js";
import { displayEditingAbilities } from "../../../../../packages/client/src/integrations/display-editing.js";
import {
  editingRefusalMessages,
  type EditingOperation,
  type EditingTargetAbilities,
} from "@opensteer/client/editing";

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

type Sabotage = "lose" | "drop" | "refuse" | "double" | "misplace" | "shift" | "recommit" | null;
const harness = vi.hoisted(() => ({
  field: null as null | {
    deliver(packet: unknown): void;
    respond(instruction: unknown): Promise<void>;
    finishComposition(): Promise<void>;
    configure?(contextId: string | null): void;
  },
  mounted: false,
  answers: [] as (() => void)[],
  /** Every text the proxy rendered: refusals among them. */
  texts: [] as string[],
  /** A sequence being recorded for the view's own replay (CU2). */
  recording: null as null | {
    answers: unknown[];
    packets: unknown[];
    steps: {
      call: unknown[];
      answers: unknown[];
      packets: unknown[];
      text: string;
      selection: unknown;
      marked: unknown;
    }[];
  },
  /** The far field of the open test, for a generator to look at. */
  remote: null as null | { composition: unknown },
  /** Regime B's page of several fields: it takes the operations instead of the one far field. */
  take: null as null | ((operation: unknown) => boolean),
  /** Told of every context the page publishes, as it publishes it (regime B's segments). */
  renewed: null as null | ((contextId: string) => void),
  /** CZ9: told, in the view's commit, of the context React has just given it. */
  committed: null as null | ((contextId: string | null) => void),
  /**
   * For the regimes' own tests: an operation that never reaches the page ("lose"), a far side that
   * loses one without a word ("drop": as if taken, never applied), refuses it ("refuse"), applies it twice ("double"), applies it a
   * character before the caret ("misplace"), shifts the caret a character off after it
   * ("shift") or is sent a composition's commit twice by the phone ("recommit"), to show each check catches it. `arrived`: made in a field the person arrived in,
   * with no composition open there. `field`: the far field it reaches.
   */
  sabotage: null as null | ((operation: unknown, arrived: boolean, field: unknown) => Sabotage),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: ({ children }: { children?: import("react").ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../../src/ui/primitives.js", () => ({
  // The proxy renders its refusal, and a preedit the target cannot show, as text.
  AppText: ({ children }: { children?: import("react").ReactNode }) => {
    harness.texts.push(String(children));
    return <span>{children}</span>;
  },
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
          React.useLayoutEffect(() => harness.committed?.(contextId), [contextId]);
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
const { NativeEditingProxy, lateTooLarge } = await import("../src/editing-proxy.js");
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
  harness.take = null;
  harness.renewed = null;
  harness.sabotage = null;
});

/**
 * The product's targets, as the Host's negotiation and the display integration pick them
 * (packages/client/src/host/browser-editing.ts, integrations/display-editing.ts): the random
 * test draws only these.
 *
 * What `display` shows (CX3): a Mac app or a phone screen viewed from the phone. Its numbers here
 * are the phone's half only: the native field, the editing proxy and the reducer with display's
 * abilities, sending to the same far field as every other target, the model of a Chromium page
 * (FarField, held to the real page by tests/editing-far-model.test.ts). They do not show what a
 * Mac app (MacOwnerInput.swift) or an Android app behind a phone screen (OwnerEditing.kt) does
 * with those operations: nothing here compares either with the model. What exists for them is
 * the Mac journey (WindowGroupJourney, typing into a Mac app from a phone, in a VM) and the phone
 * screen's JVM test of what its focused app is sent (OwnerStrokesTest); the rest is on the manual
 * list.
 */
const targets = {
  full: browserEditingAbilities.full,
  textClipboard: browserEditingAbilities.textClipboard,
  basic: browserEditingAbilities.basic,
  baseline: browserEditingAbilities.baseline,
  display: displayEditingAbilities,
} as const satisfies Record<string, EditingTargetAbilities>;
/** An older Host's browser: no range edits, so a replacement in the middle is refused. */
const displayAbilities = targets.baseline;

async function open(abilities?: EditingTargetAbilities) {
  const remote = new RemoteField();
  remote.contextId = context.contextId;
  let native: NativeField | null = null;
  const pending: Packet[] = [];
  harness.remote = remote;
  let current: typeof context = context;
  const handle = createRef<import("../src/editing-proxy.js").NativeEditingProxyHandle>();
  const render = () =>
    root.render(
      <NativeEditingProxy
        ref={handle}
        context={current}
        sendOperation={(operation) => {
          if (process.env.OPENSTEER_TYPING_TRACE)
            console.log(
              "    OP",
              JSON.stringify(operation, (k, v) => (k === "bytes" ? "…" : v)),
            );
          return harness.take ? harness.take(operation) : remote.take(operation);
        }}
        onDone={() => undefined}
        {...(abilities ? { abilities } : {})}
      />,
    );
  /** A new context, as the page publishes it after a refusal or when its field changes. */
  const renew = (contextId: string) => {
    harness.renewed?.(contextId);
    current = { ...context, contextId };
    queueMicrotask(render);
  };
  remote.onRotate = renew;
  harness.field = {
    // Packets before the view is laid out wait for it, as Expo's event dispatcher's do.
    deliver: (packet) => pending.push(packet as Packet),
    // Each answer reaches the main queue only when the test lets it.
    respond: (instruction) => {
      return new Promise<void>((resolve) =>
        harness.answers.push(() => {
          harness.recording?.answers.push(instruction as Answer);
          native!.respond(instruction as Answer);
          resolve();
        }),
      );
    },
    // The app ends the composition: not one of the person's actions.
    finishComposition: async () => native!.unmarkText(false),
    configure: (contextId) => native!.configure(contextId),
  };
  native = new NativeField((packet) => {
    if (process.env.OPENSTEER_TYPING_TRACE) console.log("    PACKET", JSON.stringify(packet.event));
    harness.recording?.packets.push(packet);
    harness.field!.deliver(packet);
  });
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
    /** The app interrupts the field (a tap on the page, a blur), as its handle does. */
    interrupt: (type: "pointerdown" | "blur") => act(async () => handle.current!.interrupt(type)),
    keyboard,
    answer,
    answerAll,
    rotate,
    /** The page publishes a context of its own choosing (another field), inside act. */
    publish: (contextId: string) => act(async () => renew(contextId)),
    /** The same, from inside a far field's refusal (already inside act). */
    renew,
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

  // CX1, the walk's paste: the answer to the native field's paste event is the phone's own
  // reducer's (set plus edit), returned by the editing proxy through the adapter to the same
  // packet; no far side delivers it. Once it arrives both sides read the same.
  it("leaves both sides equal after the walk's paste", async () => {
    const { remote, native, keyboard, answerAll } = await open();
    for (const letter of "hello") await keyboard((field) => field.type(letter));
    await answerAll();
    await keyboard((field) => field.paste("fixture clipboard 👩‍💻"));
    await answerAll();
    expect(remote.value).toBe("hellofixture clipboard 👩‍💻");
    expect(native.text).toBe(remote.value);
    expect(native.selection).toEqual({ start: 28, end: 28 });
    expect(remote.caret).toBe(28);
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

  // A tap moves nothing in the hidden field (C1); a swipe moves the caret by its distance, from
  // where the person's caret is: here after the "a" still waiting, five characters back.
  it("moves by the distance swiped while an earlier keystroke waits, and types there", async () => {
    const { remote, native, keyboard, answer, answerAll } = await open();
    await keyboard((field) => field.type("hello"));
    await answerAll();
    await keyboard((field) => field.insertText("a"));
    await keyboard((field) => field.moveSelection(0));
    await answer(1);
    await keyboard((field) => field.insertText("X"));
    await answerAll();
    expect(native.text).toBe("hXelloa");
    expect(remote.value).toBe("hXelloa");
  });

  // The recheck's fault 1: an edit's event carried a caret chosen after it, so the remote caret
  // moved back before the second character and the second arrived as a rewrite, or was refused.
  it.each([
    ["a page (range edits)", undefined],
    ["an older Host's browser (no range edits)", displayAbilities],
  ] as const)(
    "on %s, delivers two characters typed before a swipe, then moves by its distance",
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
      // A page: the swipe went five characters back from the person's caret, after the "b". A
      // target without range edits keeps the hidden field empty after each edit, so the swipe has
      // nothing to cross and UIKit reports no move: the caret stays after the "b" (what a person
      // there loses with the space bar's trackpad; the arrow keys still go to the page).
      expect(remote.caret).toBe(abilities ? 7 : 2);
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
  // CV1: a refusal gives the field a new context; what the person typed under the old one is
  // still an insertion at its caret, and a replacement under it is refused alone (no rotation).
  it("rotates its context after a refusal and still takes an insertion under the old one", () => {
    const far = new FarField();
    far.contextId = context.contextId;
    far.take({
      kind: "edit",
      edit: { contextId: context.contextId, text: "x", before: "q", after: "" },
    });
    const rotated = far.contextId;
    expect(rotated).not.toBe(context.contextId);
    far.take({
      kind: "edit",
      edit: { contextId: context.contextId, text: "y", before: "", after: "" },
    });
    expect(far.value).toBe("y");
    far.take({
      kind: "edit",
      edit: { contextId: context.contextId, text: "z", before: "y", after: "" },
    });
    expect(far.value).toBe("y");
    expect(far.contextId).toBe(rotated);
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

  it("types where the person swiped the caret while a composition's commit waited", async () => {
    // The input method commits the composition (unmarkText), then the person swipes one back,
    // both before the composition's own turn: from after the composition, one back.
    const { remote, native, keyboard, answerAll } = await settled("ab");
    await keyboard((field) => field.setMarkedText("日本"));
    await keyboard((field) => field.unmarkText());
    await keyboard((field) => field.moveSelection(1));
    await answerAll();
    expect(native.selection).toEqual({ start: 3, end: 3 });
    await keyboard((field) => field.insertText("x"));
    await answerAll();
    expect(native.text).toBe("ab日x本");
    same(remote, native);
  });

  const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /*
   * The family's structural test. The person's actions go to the native field (the port, through
   * the real proxy and reducer, the answers late and in random numbers) and to the oracle
   * (typing-oracle.ts), which applies each as a person means it. After everything settles the
   * far field holds the person's text and caret; the far field matched every edit's text, and
   * the reducer refused nothing (no action here is one a target cannot take). That is regime A's
   * promise; regimes B and C (below) have their own, and no sequence is excused from its regime's.
   */
  async function person(abilities?: EditingTargetAbilities) {
    const opened = await open(abilities);
    const target = abilities ?? targets.full;
    const { remote, native, keyboard } = opened;
    const oracle = new Oracle();
    // Regime A has no context change and no exception: anything the native field drops, or a
    // composition the app ends by itself, fails the sequence.
    const unexpected: string[] = [];
    native.onTurn = (turn) => {
      if (turn === "action") oracle.turn();
      else if (turn === "report") oracle.report();
      else if (turn === "reset") oracle.reset();
      // A job's beginning is for the regimes' record of who sent what.
      else if (turn !== "begin") unexpected.push(turn);
    };
    harness.texts = [];
    const steps: string[] = [];
    const trace = (label: string) => {
      if (!process.env.OPENSTEER_TYPING_TRACE) return;
      const p = oracle.person;
      console.log(
        `${label.padEnd(26)} P ${JSON.stringify(p.text)} ${p.selection.start}-${p.selection.end} | N ${JSON.stringify(native.text)} ${native.selection.start}-${native.selection.end} | far ${JSON.stringify(remote.value)} ${remote.caret}`,
      );
    };
    const traced = native.onTurn;
    const labels: string[] = [];
    native.onTurn = (turn) => {
      traced?.(turn);
      trace(`  <${turn}${turn === "action" ? ` ${labels.shift() ?? ""}` : ""}>`);
    };
    /** The native field has taken every action and every answer: its text is the person's. */
    const settledHere = () => oracle.caughtUp && harness.answers.length === 0;
    /** For the view's own replay: the call, then what it left and delivered. */
    const record = (call: unknown[]) => {
      const recording = harness.recording;
      if (!recording) return;
      recording.steps.push({
        call,
        answers: recording.answers.splice(0),
        packets: recording.packets.splice(0),
        text: native.text,
        selection: { ...native.selection },
        marked: native.marked ? { ...native.marked } : null,
      });
    };
    const does = async (step: string, act: Action, call: (field: NativeField) => void) => {
      steps.push(step);
      labels.push(step);
      oracle.act(act);
      trace(step);
      await keyboard(call);
      record(
        JSON.parse(
          `[${step.replace(/^(\w+)\((.*)\)$/, '"$1"$2').replace(/^("\w+")(?!$)/, "$1,")}]`,
        ),
      );
    };
    const said = JSON.stringify;
    return {
      opened,
      /** What the view dropped (an action's place, a move's report): never sent. */
      dropped: () => unexpected.filter((turn) => turn === "dropped" || turn === "dropped-report"),
      native,
      oracle,
      steps,
      insertText: (c: string) =>
        does(
          `insertText(${said(c)})`,
          (p) => p.type(c),
          (f) => f.insertText(c),
        ),
      type: (c: string) =>
        does(
          `type(${said(c)})`,
          (p) => p.type(c),
          (f) => f.type(c),
        ),
      backspace: async () => {
        // UIKit asks the delegate only for a character before the native caret.
        if (native.selection.end === 0) return steps.push("backspace()");
        return does(
          "backspace()",
          (p) => p.backspace(),
          (f) => f.backspace(),
        );
      },
      deleteBackward: () =>
        does(
          "deleteBackward()",
          // Without an input method UITextView deletes the whole marked text.
          (p) => (p.marked ? p.compose("") : p.backspace()),
          (f) => f.deleteBackward(),
        ),
      /** A caret swiped by the distance UIKit moved it, or a range UIKit selects (caught up). */
      moveSelection: async (start: number, end = start) => {
        // A move to where the caret already is makes no callback: it is no event.
        if (native.selection.start === start && native.selection.end === end) return;
        const previous = native.selection;
        const caret = previous.start === previous.end && start === end;
        if (!caret && !settledHere()) return;
        steps.push(start === end ? `moveSelection(${start})` : `moveSelection(${start}, ${end})`);
        const count = characters(
          native.text.slice(Math.min(previous.end, end), Math.max(previous.end, end)),
        ).length;
        const distance = end < previous.end ? -count : count;
        const range = oracle.fromNative({ start, end });
        oracle.choose(caret ? (p) => p.move(distance) : (p) => p.select(range));
        trace(steps.at(-1)!);
        await keyboard((f) => f.moveSelection(start, end));
        record(["moveSelection", start, end]);
      },
      /**
       * CW6 (a): the person swipes the caret by `distance` characters. The oracle applies exactly
       * that distance; where it lands in the native field is counted with another segmenter than
       * the port's (unicode-segmenter's), and a swipe the native field would stop short of is not
       * drawn (UIKit stops at the ends of its text).
       */
      swipe: async (distance: number) => {
        const ends = [0];
        for (const grapheme of splitGraphemes(native.text))
          ends.push(ends.at(-1)! + grapheme.length);
        const { start, end } = native.selection;
        if (start !== end) return;
        const index = ends.indexOf(end);
        const to = ends[index + distance];
        if (index < 0 || to === undefined || index + distance < 0) return;
        steps.push(`swipe(${distance})`);
        oracle.choose((p) => p.move(distance));
        trace(steps.at(-1)!);
        await keyboard((f) => f.moveSelection(to));
        record(["moveSelection", to, to]);
      },
      /** UIKit's own replacement (an autocorrect), made when the native field has caught up. */
      replaceRange: async (start: number, end: number, word: string, ahead = false) => {
        // `ahead`: made before an answer, on purpose (F5), where nothing waiting changes the text.
        if (!(ahead ? oracle.caughtUp : settledHere())) return;
        const range = oracle.fromNative({ start, end });
        return does(
          `replaceRange(${start}, ${end}, ${said(word)})`,
          (p) => p.replace(range, word),
          (f) => f.replaceRange(start, end, word),
        );
      },
      /** The field resigns (the person dismisses the keyboard), then takes focus again. */
      blur: async () => {
        steps.push("blur()");
        await keyboard((f) => f.blur());
      },
      paste: (text: string) =>
        does(
          `paste(${said(text)})`,
          (p) => p.paste(text),
          (f) => f.paste(text),
        ),
      setMarkedText: (text: string) =>
        does(
          `setMarkedText(${said(text)})`,
          (p) => p.compose(text),
          (f) => f.setMarkedText(text),
        ),
      unmarkText: () =>
        does(
          "unmarkText()",
          (p) => p.commit(),
          (f) => f.unmarkText(),
        ),
      answer: async (count: number) => {
        steps.push(`answer(${count})`);
        await opened.answer(count);
        record(["answer", count]);
      },
      /**
       * Everything settles. The promise of regime A, exactly: the far text and caret are the
       * person's, nothing was dropped, no edit was mismatched and nothing refused.
       */
      async check(seed: number | string) {
        await opened.answerAll();
        record(["answerAll"]);
        const failure = `seed ${seed}: ${steps.join("; ")}`;
        expect(remote.mismatched, failure).toEqual([]);
        expect(remote.refused, `${failure}: refused`).toEqual([]);
        expect(unexpected, `${failure}: dropped`).toEqual([]);
        const refusals = new Set(Object.values(editingRefusalMessages));
        expect(
          [...new Set(harness.texts.filter((text) => refusals.has(text)))],
          `${failure}: the reducer refused`,
        ).toEqual([]);
        const { text, selection, marked } = oracle.person;
        // A target that cannot show a composition live gets it at its commit; one still open is
        // the viewer's preedit, not the page's.
        const shown =
          marked && !target.composition
            ? text.slice(0, marked.start) + oracle.person.replaced + text.slice(marked.end)
            : text;
        expect(
          remote.value,
          `${failure} (far ${JSON.stringify(escape(remote.value))}, person ${JSON.stringify(escape(shown))})`,
        ).toBe(shown);
        // CW6 (b): the far caret wherever the person has one, a composition's included on a
        // target that shows it live (its caret is the person's, in the marked text). A target
        // without live composition holds the composition only at its commit: no caret there yet.
        if (selection.start === selection.end && (marked === null || target.composition))
          expect(remote.caret, `${failure}: caret`).toBe(selection.start);
        await act(async () => root.render(null));
        harness.answers = [];
        harness.mounted = false;
      },
    };
  }

  const alphabet = ["a", "b", "é", " ", "👩‍💻"];
  /**
   * The first generator, its draws kept as they were so the seeds it found still replay what
   * they found.
   */
  async function sequence(seed: number): Promise<void> {
    const next = random(seed);
    const pick = <T,>(items: readonly T[]) => items[Math.floor(next() * items.length)]!;
    const run = await person();
    const length = 1 + Math.floor(next() * 24);
    for (let step = 0; step < length; step++) {
      const boundaries = [0, ...characters(run.native.text).map(({ end }) => end)];
      const choice = next();
      if (choice < 0.3) await run.insertText(pick(alphabet));
      else if (choice < 0.45) await run.type(pick(alphabet));
      else if (choice < 0.55) await run.backspace();
      else if (choice < 0.62) await run.deleteBackward();
      else if (choice < 0.74) await run.moveSelection(pick(boundaries));
      else if (choice < 0.8) {
        const [start, end] = [pick(boundaries), pick(boundaries)].sort((x, y) => x - y);
        await run.moveSelection(start!, end!);
      } else await run.answer(1 + Math.floor(next() * 3));
    }
    await run.check(seed);
  }

  /*
   * The second generator: also a target without range edits, a multi-character replacement at a
   * range (autocorrect), paste, composition between other steps, a context rotation while edits
   * wait, right-to-left letters and decomposed é. Its draws are kept as they were for the seeds it found. On a target
   * without range edits it skips what such a target cannot take (a range selected, replaced or
   * deleted), drawing nothing more.
   */
  const letters = ["a", "b", "é", "é", " ", "👩‍💻", "א", "ب"];
  async function sequence2(seed: number, third = false): Promise<void> {
    const next = random(seed * (third ? 40503 : 2654435761));
    const pick = <T,>(items: readonly T[]) => items[Math.floor(next() * items.length)]!;
    // The second generator's own draw, kept: its "display" is now a real target without range
    // edits (baseline). The third draws any of the product's targets.
    // OPENSTEER_TYPING_TARGET runs one target alone (the draw is still made, so the sequences match).
    const drawn: keyof typeof targets = third
      ? pick(["full", "textClipboard", "basic", "baseline", "display"] as const)
      : next() < 0.2
        ? "baseline"
        : "full";
    const only = process.env.OPENSTEER_TYPING_TARGET as keyof typeof targets | undefined;
    const name = third && only && only in targets ? only : drawn;
    const target = targets[name];
    const display = !target.rangeEdits;
    const run = await person(target);
    if (name !== "full") run.steps.push(`target ${name}`);
    /** The input method is composing from its own setMarkedText on, whatever the field holds yet. */
    let composing = false;
    const length = 1 + Math.floor(next() * 28);
    for (let step = 0; step < length; step++) {
      const boundaries = [0, ...characters(run.native.text).map(({ end }) => end)];
      let choice = next();
      if (third) composing = run.oracle.person.marked !== null;
      // While text is marked, UIKit's input method updates or commits it (setMarkedText,
      // insertText) or deletes inside it; nothing else reaches the field.
      if (composing && !(choice < 0.22 || (choice >= 0.4 && choice < 0.45) || choice >= 0.65))
        choice = next() < 0.5 ? 0.1 : 0.67;
      if (composing && choice >= 0.73 && choice < 0.78) choice = 0.9;
      if (choice < 0.22) {
        composing = false;
        await run.insertText(pick(letters));
      } else if (choice < 0.32) {
        // A replacement through the delegate: the keyboard's, which a target without range
        // edits turns off.
        if (!display) await run.type(pick(letters));
      } else if (choice < 0.4) await run.backspace();
      else if (choice < 0.45 && composing) {
        const marked = run.oracle.person.marked;
        const text = marked ? run.oracle.person.text.slice(marked.start, marked.end) : "";
        const way = third ? next() : 0;
        if (way < 1 / 3) {
          // An input method deletes inside its composition by setting shorter marked text; with
          // one character marked, it cancels the composition.
          composing = false;
          await run.setMarkedText("");
        } else if (way < 2 / 3 && characters(text).length > 1) {
          await run.setMarkedText(text.slice(0, characters(text).at(-2)!.end));
        } else {
          // Without an input method, deleteBackward with marked text (RemoteInputTextView's
          // deletedStart with a marked range).
          composing = false;
          await run.deleteBackward();
        }
      } else if (choice < 0.45) await run.deleteBackward();
      else if (choice < 0.54)
        // A swipe of a distance the person chose (CW6 a); the draw is one, as the boundary's was.
        await (third
          ? run.swipe(pick([-3, -2, -1, 1, 2, 3]))
          : run.moveSelection(pick(boundaries)));
      else if (choice < 0.58) {
        const [start, end] = [pick(boundaries), pick(boundaries)].sort((x, y) => x - y);
        if (!display) await run.moveSelection(start!, end!);
      } else if (choice < 0.62) {
        const [start, end] = [pick(boundaries), pick(boundaries)].sort((x, y) => x - y);
        const word = pick(["the", "ab", "é"]);
        // No autocorrect on a target without range edits: the keyboard's is turned off there.
        // NOT FROM A RECORDING (CV2): what UITextView does with replace(_:withText:) is recorded
        // (uikit-recordings.json), but which range a device keyboard's autocorrect names is not;
        // any range is drawn, the harder case. Device list: type "teh " on a real keyboard with
        // autocorrect on and record the range the device names.
        if (!display) await run.replaceRange(start!, end!, word);
      } else if (choice < 0.65) await run.paste(pick(["pasted", "א b"]));
      else if (choice < 0.7) {
        composing = true;
        await run.setMarkedText(pick(["に", "日本"]));
      } else if (choice < 0.73) {
        composing = false;
        await run.unmarkText();
      } else if (choice < 0.75) {
        // Regime A: the page does nothing by itself, so no context change; an answer instead.
        await run.answer(1);
      } else if (choice < 0.78) {
        // Once a combining mark named alone for deletion, as UIKit was thought to name it; no
        // recording of the real view shows UIKit naming a range by itself
        // (ios/Tests/Cases/uikit-recordings.json), so nothing is drawn. The draw is kept so the
        // other seeds still replay what they found.
      } else await run.answer(1 + Math.floor(next() * 3));
    }
    await run.check(third ? `${seed} (third)` : seed);
  }

  // What the random sequences found, kept: seed 32, a prevented Backspace on an empty field whose
  // suppression swallowed a later deletion; seed 4363, a replacement next to a repeated character
  // the reducer could not verify, refused and the field cleared.
  it.each([32, 4363])("replays the sequence the random test found at seed %i", (seed) =>
    sequence(seed),
  );

  // What the second generator found, kept: seed 81, a space typed as a composition committed,
  // named insertFromComposition when typed and lost on the far side; seed 9944, a composition
  // over a selection cancelled, which took the restated text with it; seeds 4021, 15915 and
  // 16868, a caret moved while a composition's commit (unmarkText) waited, left at the
  // composition's end natively while the far caret went where the person put it.
  it.each([81, 9944, 4021, 15915, 16868])(
    "replays the sequence the second generator found at seed %i",
    (seed) => sequence2(seed),
  );

  // Seed 2195's sequence, as it was found: the second generator then deleted inside a
  // composition with deleteBackward, which it no longer reaches at that seed. A deletion inside
  // a composition recorded at a caret moved while it waited, so a later keystroke split an emoji.
  it("replays the sequence the second generator found at seed 2195", async () => {
    const run = await person();
    await run.insertText("👩‍💻");
    await run.answer(3);
    await run.setMarkedText("に");
    await run.answer(4);
    await run.deleteBackward();
    await run.insertText("👩‍💻");
    await run.moveSelection(5);
    await run.insertText("א");
    await run.check(2195);
  });

  // What the person oracle found, kept (third generator): seed 750, an autocorrect elsewhere
  // moved the caret into the replaced word; seed 988, a keystroke typed while an applied
  // composition hid the person's caret was named in the composition; seed 697, a paste over a
  // selection did not replace it.
  it.each([750, 988, 697])("replays the sequence the person oracle found at seed %i", (seed) =>
    sequence2(seed, true),
  );

  // The review of b17ce6c8d (F2, F4, F5): a caret move or an autocorrect made before the previous
  // answer, lost. Each must hold what the person meant.
  it("F2: a caret moved before the previous answer on a target without range edits", async () => {
    const run = await person(targets.baseline);
    await run.insertText("a");
    await run.answer(1);
    await run.moveSelection(0);
    await run.insertText("b");
    await run.check("F2");
    expect(harness.remote).toMatchObject({ value: "ba" });
  });
  it("F4: a caret moved while a paste waits", async () => {
    const run = await person(targets.full);
    await run.insertText("abc");
    await run.answer(Infinity);
    await run.paste("P");
    await run.moveSelection(1);
    await run.insertText("x");
    await run.check("F4");
    // The swipe was two back from the person's caret, after the "P": a distance (the lead's
    // ruling), not the place UIKit named in "abc".
    expect(harness.remote).toMatchObject({ value: "abxcP" });
  });
  it("F5: an autocorrect made before the previous answer, on a Mac app or phone screen", async () => {
    const run = await person(targets.display);
    await run.insertText("a");
    await run.answer(1);
    await run.replaceRange(0, 0, "the", true);
    await run.check("F5");
    expect(harness.remote).toMatchObject({ value: "thea" });
  });

  // CU2: regime A's sequences, recorded from the port for the real view's replay
  // (ios/Tests/Cases/typing-sequences.json, RemoteTextInputReplayTests.swift, which compares every
  // step on the real view). Here the port must still record exactly what is committed, so the two
  // compare the same thing; OPENSTEER_TYPING_EXPORT=1 writes it again after a deliberate change.
  it("records regime A for the view's replay, as committed", async () => {
    const sequences: unknown[] = [];
    const run = async (name: string, play: () => Promise<void>) => {
      harness.recording = { answers: [], packets: [], steps: [] };
      await play();
      sequences.push({ name, steps: harness.recording.steps });
      harness.recording = null;
    };
    for (const seed of [32, 4363]) await run(`first ${seed}`, () => sequence(seed));
    for (const seed of [81, 9944, 4021, 15915, 16868])
      await run(`second ${seed}`, () => sequence2(seed));
    for (const seed of [750, 988, 697]) await run(`third ${seed}`, () => sequence2(seed, true));
    for (let seed = 1; seed <= 300; seed++) await run(`third ${seed}`, () => sequence2(seed, true));
    const file =
      // Under this file's DOM environment import.meta.url is not a file URL: the root runs the tests.
      `${process.cwd()}/apps/mobile/modules/remote-text-input/ios/Tests/Cases/typing-sequences.json`;
    const recorded = `${JSON.stringify({ about: "Regime A sequences recorded from the TypeScript port (typing-order.interaction.test.tsx); RemoteTextInputReplayTests.swift replays each on the real view and compares every step.", contextId: context.contextId, sequences })}\n`;
    if (process.env.OPENSTEER_TYPING_EXPORT === "1") writeFileSync(file, recorded);
    expect(
      recorded === readFileSync(file, "utf8"),
      "the port no longer records the committed sequences",
    ).toBe(true);
  });

  /*
   * Regimes B and C (CU1), drawn apart from A and reported apart, per target: the third
   * generator's actions, with the page acting between them. Every operation is attributed to the
   * action whose turn it came in (the native field's action and report turns), so each promise is
   * checked as stated, never as "some prefix".
   *
   * B, the field changes: the person arrives in another field (a second far field; what comes
   * under another field's context is refused there alone, as the real applier refuses it). The
   * promise (CW2, CY9), from what the person did: each of their actions in a field that sends
   * something (typed text, a Backspace at a caret, a swipe where the target takes moves) reached
   * the page, and each of its operations was applied or refused, never absent. A field left holds
   * exactly the person's actions up to the last one the page applied there, none of them refused
   * (operations fall off the end, never out of the middle); the field arrived in holds exactly what
   * the person did after arriving, text and caret (during a composition too, where the target
   * shows it), with nothing refused or mismatched there.
   *
   * C, the page interferes in the same field: it rewrites its value under the person (a mask
   * that adds a character, one that deletes one, one that moves the caret) or rotates its context,
   * and the field gets a new context for it, as the real applier gives it
   * (tests/editing-far-model.test.ts). The promise (CV1, CW3, CY2): the far field's text and caret
   * are exactly what PageModel makes of the page's acts and the operations the far field applied,
   * in the order they happened; each typed or pasted text was applied exactly once, in the order
   * typed; every Backspace at a caret was applied; no typed text, Backspace or move was refused.
   * Only a replacement (an autocorrect, a selection's deletion, a composition's update) may be
   * missing.
   *
   * What UIKit selects or replaces by itself is drawn only before the page first acts: after it
   * the native mirror is no longer the person's text from a known place.
   */
  /** What the page did to its field, as regime C draws it. */
  type PageAct =
    | { kind: "insert"; at: number; text: string }
    | { kind: "delete"; from: number; to: number }
    | { kind: "caret"; at: number }
    | { kind: "context"; contextId: string };
  /**
   * CY2: regime C's own model of the page, built apart from the far field's code: the page's acts
   * and the operations the far field accepted, in the order it applied them, from the field's
   * start. What the far field holds at the end is compared with it exactly, text and caret.
   * Operations mean what the protocol says and the page applier does
   * (tests/editing-far-model.test.ts): an insertion at the caret, a range edit verified around
   * it, a composition replacing the marked text, a Backspace deleting a grapheme (only the last
   * mark of a decomposed one), the caret moves by a grapheme, a paste inserting at the caret;
   * another context's operation first closes the open composition, leaving the caret at its end.
   */
  class PageModel {
    value: string;
    caret: number;
    private composition: { start: number; end: number } | null = null;
    private composer: string | null = null;
    /** A composition the page's rewrite ended, its text kept, until its composer's next operation. */
    private ended: { composer: string | null; text: string } | null = null;
    constructor(
      start: { text: string; caret: number },
      private context: string | null,
    ) {
      this.value = start.text;
      this.caret = start.caret;
    }
    private ends(): number[] {
      const ends = [0];
      for (const grapheme of splitGraphemes(this.value)) ends.push(ends.at(-1)! + grapheme.length);
      return ends;
    }
    private splice(start: number, end: number, text: string) {
      this.value = this.value.slice(0, start) + text + this.value.slice(end);
      this.caret = start + text.length;
    }
    page(act: PageAct) {
      if (act.kind === "context") this.context = act.contextId;
      else if (act.kind === "caret") this.caret = act.at;
      else if (act.kind === "insert") {
        if (this.composition)
          this.ended = {
            composer: this.composer,
            text: this.value.slice(this.composition.start, this.composition.end),
          };
        this.value = this.value.slice(0, act.at) + act.text + this.value.slice(act.at);
        if (this.caret >= act.at) this.caret += act.text.length;
        // A rewrite of the value ends an open composition, its text kept (Blink's, CY4).
        this.composition = null;
        this.composer = null;
      } else {
        if (this.composition)
          this.ended = {
            composer: this.composer,
            text: this.value.slice(this.composition.start, this.composition.end),
          };
        this.value = this.value.slice(0, act.from) + this.value.slice(act.to);
        const map = (offset: number) =>
          offset >= act.to ? offset - (act.to - act.from) : offset > act.from ? act.from : offset;
        this.caret = map(this.caret);
        this.composition = null;
        this.composer = null;
      }
    }
    private backspace() {
      if (this.caret === 0) return;
      const from = this.ends().findLast((end) => end < this.caret) ?? 0;
      const points = Array.from(this.value.slice(from, this.caret));
      const last = points.at(-1)!;
      this.splice(
        points.length > 1 && /\p{M}/u.test(last) ? this.caret - last.length : from,
        this.caret,
        "",
      );
    }
    /** Applies an operation the far field took; returns the text it put in the field for good. */
    apply(operation: EditingOperation): string {
      const ended = this.ended;
      this.ended = null;
      const own =
        operation.kind === "edit"
          ? operation.edit.contextId
          : operation.kind === "compose"
            ? operation.composition.contextId
            : operation.kind === "command"
              ? (operation.contextId ?? null)
              : null;
      if (this.composition && this.composer !== (own ?? this.context)) {
        this.caret = this.composition.end;
        this.composition = null;
        this.composer = null;
      }
      if (operation.kind === "edit" || operation.kind === "compose") {
        const change = operation.kind === "edit" ? operation.edit : operation.composition;
        const { before = "", after = "", text } = change;
        const range = this.composition ?? {
          start: this.caret - before.length,
          end: this.caret + after.length,
        };
        if (operation.kind === "compose") {
          this.splice(range.start, range.end, text);
          this.composition = text ? { start: range.start, end: range.start + text.length } : null;
          this.composer = text ? this.context : null;
          this.caret =
            range.start + Math.min(Math.max(0, operation.composition.selectionEnd), text.length);
          return "";
        }
        // What the page kept of a composition it ended is applied: its composer's commit adds
        // only the rest.
        if (ended && text && !before && !after && ended.composer === (own ?? this.context)) {
          const rest = committedRemainder(ended.text, text);
          this.splice(this.caret, this.caret, rest);
          return rest;
        }
        if (text || range.end > range.start) {
          this.splice(range.start, range.end, text);
          this.composition = null;
          this.composer = null;
          return text;
        }
        this.backspace();
      } else if (operation.kind === "command") {
        const ends = this.ends();
        if (operation.command === "moveBackward")
          this.caret = ends.findLast((end) => end < this.caret) ?? 0;
        else if (operation.command === "moveForward")
          this.caret = ends.find((end) => end > this.caret) ?? this.caret;
        else if (operation.command === "deleteBackward") this.backspace();
        else if (operation.command === "deleteForward") {
          const to = ends.find((end) => end > this.caret);
          if (to !== undefined) {
            const at = this.caret;
            this.splice(at, to, "");
          }
        }
      } else if (operation.kind === "paste") {
        const item = operation.items.find((candidate) => candidate.type === "text/plain");
        const text = item ? new TextDecoder().decode(item.bytes) : "";
        this.splice(this.caret, this.caret, text);
        return text;
      }
      return "";
    }
  }
  /** The page's own rewrite of its far field, as regime C draws it (the far field has no code for it). */
  function pageAct(field: FarField, act: PageAct) {
    if (act.kind === "insert" || act.kind === "delete") field.endComposition();
    if (act.kind === "caret") field.caret = act.at;
    else if (act.kind === "insert") {
      field.value = field.value.slice(0, act.at) + act.text + field.value.slice(act.at);
      if (field.caret >= act.at) field.caret += act.text.length;
    } else if (act.kind === "delete") {
      field.value = field.value.slice(0, act.from) + field.value.slice(act.to);
      field.caret =
        field.caret >= act.to
          ? field.caret - (act.to - act.from)
          : field.caret > act.from
            ? act.from
            : field.caret;
    }
  }
  interface Segment {
    field: FarField;
    start: { text: string; caret: number };
    /** The index of its first action among all of the person's. */
    first: number;
    actions: Action[];
    /** What the person holds in it, each action applied at once (the generator's composing). */
    person: Person;
    end?: { text: string; caret: number };
  }
  type Kind = "typed" | "delete" | "move" | "other";
  async function regime(
    seed: number,
    which: "B" | "C",
  ): Promise<{ target: string; failure: string | null; changes: number; refused: number }> {
    const next = random(seed * (which === "B" ? 69069 : 1103515245));
    const pick = <T,>(items: readonly T[]) => items[Math.floor(next() * items.length)]!;
    const drawn = pick(["full", "textClipboard", "basic", "baseline", "display"] as const);
    const only = process.env.OPENSTEER_TYPING_TARGET as keyof typeof targets | undefined;
    const name = only && only in targets ? only : drawn;
    const target = targets[name];
    const display = !target.rangeEdits;
    const run = await person(target);
    const { opened, oracle, steps } = run;
    if (name !== "full") steps.push(`target ${name}`);
    let ids = 0;
    const fresh = () => `00000000-0000-4000-8000-${String(200000000000 + ++ids).slice(-12)}`;
    let focused: FarField = opened.remote;
    focused.nextContextId = fresh;
    const segment = (field: FarField, first: number): Segment => {
      const start = { text: field.value, caret: field.caret };
      const person = new Person();
      person.text = start.text;
      person.selection = { start: start.caret, end: start.caret };
      return { field, start, first, actions: [], person };
    };
    const segments: Segment[] = [segment(focused, 0)];
    // Each action of the person, in order: its kind, and the segment it was done in.
    const kinds: Kind[] = [];
    /** What each typed action typed or pasted. */
    const texts: string[] = [];
    let kind: Kind = "other";
    let text = "";
    const acts: number[] = [];
    /** Which action each moveSelection call of the native field was. */
    const moves = new Map<number, number>();
    /**
     * Compositions the person committed, in order (CY4, ruling 2): the action that committed it,
     * its text, and what the field already held from it (the change of context committed it, or
     * the page ended it keeping its text). A target that cannot show a composition inserts it.
     */
    interface Lineage {
      /** The texts it has had, in order: what a change of context could commit. */
      marked: string[];
      /** The page's acts before it began, and the action that ended it (committed or cancelled). */
      start: number;
      end?: number;
      /** What the person committed of it, and the action that did; none if cancelled or open. */
      committed?: { index: number; text: string };
    }
    /** The page's acts so far, and how many there had been at each action's turn. */
    let clock = 0;
    const turnClock = new Map<number, number>();
    const lineages: Lineage[] = [];
    let open: Lineage | null = null;
    /** The actions that composed or committed: what they insert is a composition's. */
    const composing = new Set<number>();
    /** The texts of far compositions a rewrite of the page ended, keeping them. */
    const ended: string[] = [];
    /** The distance of each swipe, by action. */
    const distances = new Map<number, number>();
    let swiped = 0;
    /** The moves each report of the native field stood for, by action. */
    const reported = new Map<number, number[]>();
    const record = (action: Action) => {
      const index = kinds.length;
      kinds.push(kind);
      texts.push(kind === "typed" ? text : "");
      kind = "other";
      const current = segments.at(-1)!;
      current.actions.push(action);
      const p = current.person;
      const before = { text: p.text, marked: p.marked };
      action(p);
      if (before.marked || p.marked) composing.add(index);
      if (!before.marked && p.marked) {
        open = { marked: [], start: clock };
        lineages.push(open);
      }
      if (p.marked && open) open.marked.push(p.text.slice(p.marked.start, p.marked.end));
      if (before.marked && !p.marked) {
        // What now stands where the composition was: its text kept, or what replaced it.
        const prefix = before.text.slice(0, before.marked.start);
        const suffix = before.text.slice(before.marked.end);
        const committed =
          p.text.startsWith(prefix) &&
          p.text.endsWith(suffix) &&
          p.text.length >= prefix.length + suffix.length
            ? p.text.slice(prefix.length, p.text.length - suffix.length)
            : before.text.slice(before.marked.start, before.marked.end);
        if (open) {
          if (committed) open.committed = { index, text: committed };
          open.end = index;
        }
        open = null;
      }
      return index;
    };
    const act0 = oracle.act.bind(oracle);
    const choose0 = oracle.choose.bind(oracle);
    oracle.act = (action) => {
      acts.push(record(action));
      act0(action);
    };
    // A move's own call to the native field is the next one.
    oracle.choose = (action) => {
      const index = record(action);
      moves.set(run.native.moveCalls + 1, index);
      // A selection the person makes is no distance: a report standing for one moves something.
      distances.set(index, kinds[index] === "move" ? swiped : Number.NaN);
      choose0(action);
    };
    // The action whose turn it is: what is sent now is its.
    let owner = -1;
    let owners: number[] = [];
    const turned = run.native.onTurn;
    run.native.onTurn = (turn, calls) => {
      if (turn === "begin") owners = [acts.shift() ?? owner];
      else if (turn === "report" || turn === "dropped-report") {
        owners = (calls ?? []).flatMap((call) => {
          const index = moves.get(call);
          return index === undefined ? [] : [index];
        });
        for (const index of owners) reported.set(index, owners);
      }
      owner = owners.at(-1) ?? owner;
      // The latest turn of each action: when the native field applied it.
      for (const index of owners) turnClock.set(index, clock);
      turned?.(turn);
    };
    const sent: {
      operation: EditingOperation;
      owners: number[];
      field: FarField;
      /** Whether it was made in the field it reached (its context that field's, now or earlier). */
      own: boolean;
      /** Regime C: where in the log the far field applied it, and what PageModel says it inserted. */
      at?: number;
      put?: string;
    }[] = [];
    /** Regime C (CY2): what the page did and what its field applied, in the order it happened. */
    const log: (
      { act: PageAct } | { operation: EditingOperation; entry: (typeof sent)[number] }
    )[] = [];
    const startContext = focused.contextId;
    let logged = focused.contextId;
    /** A context the far field rotated to by itself (a refusal), in its place in the log. */
    const rotated = () => {
      if (focused.contextId !== logged && focused.contextId !== null)
        log.push({ act: { kind: "context", contextId: focused.contextId } });
      logged = focused.contextId;
    };
    /** What an insertion or a plain paste puts in: the text a typed action promises. */
    const inserted = (operation: EditingOperation) =>
      operation.kind === "edit" &&
      operation.edit.text !== "" &&
      !operation.edit.before &&
      !operation.edit.after
        ? operation.edit.text
        : operation.kind === "paste"
          ? new TextDecoder().decode(
              operation.items.find((item) => item.type === "text/plain")?.bytes,
            )
          : null;
    const graphemeEnds = (text: string) => {
      const ends = [0];
      for (const grapheme of splitGraphemes(text)) ends.push(ends.at(-1)! + grapheme.length);
      return ends;
    };
    /** The far field's caret one grapheme off where it is: back, or forward at the start. */
    const off = (field: FarField) => {
      const ends = graphemeEnds(field.value);
      return (
        ends.findLast((end) => end < field.caret) ??
        ends.find((end) => end > field.caret) ??
        field.caret
      );
    };
    harness.take = (operation) => {
      const made = operation as EditingOperation;
      const context =
        made.kind === "edit"
          ? made.edit.contextId
          : made.kind === "compose"
            ? made.composition.contextId
            : made.kind === "command"
              ? made.contextId
              : undefined;
      const entry: (typeof sent)[number] = {
        operation: made,
        owners,
        field: focused,
        own: context === undefined || context === focused.contextId || focused.earlier.has(context),
      };
      sent.push(entry);
      const edit = made.kind === "edit";
      const sabotage = harness.sabotage?.(
        operation,
        segments.length > 1 &&
          focused !== opened.remote &&
          focused.composition === null &&
          edit &&
          (operation as { edit: { contextId: string } }).edit.contextId === focused.contextId,
        focused,
      );
      if (sabotage === "lose") {
        sent.pop();
        return true;
      }
      if (sabotage === "drop") return true;
      if (sabotage === "refuse") {
        focused.refused.push(made);
        return true;
      }
      if (sabotage === "misplace") focused.caret = off(focused);
      const result = focused.take(made);
      if (sabotage === "double") focused.take(made);
      if (sabotage === "shift") focused.caret = off(focused);
      const took = (taken: typeof entry) => {
        if (which !== "C" || !applied(taken)) return;
        taken.at = log.length;
        log.push({ operation: made, entry: taken });
      };
      took(entry);
      if (sabotage === "recommit") {
        const again = { ...entry };
        sent.push(again);
        focused.take(made);
        took(again);
      }
      rotated();
      return result;
    };
    // What the page applied: it received the operation and did not refuse it (its own record).
    const applied = (entry: (typeof sent)[number]) =>
      entry.field.sent.includes(entry.operation) && !entry.field.refused.includes(entry.operation);
    let acted = false;
    const length = 1 + Math.floor(next() * 28);
    for (let step = 0; step < length; step++) {
      if (next() < 0.12) {
        acted = true;
        // CV3: the field resigns and takes focus again, while nothing is marked (what UIKit does
        // to marked text when the field resigns is not recorded). It is the same field: nothing
        // the person did there may be lost.
        if (which === "B" && next() < 0.3) {
          if (segments.at(-1)!.person.marked === null) {
            // A range UIKit selected in the hidden field does not outlive the blur (the mirror is
            // begun again): the person's selection is where the page's caret is, its end.
            record((p) => {
              const at = p.selection.end;
              p.selection = { start: at, end: at };
            });
            await run.blur();
          }
        } else if (which === "B") {
          steps.push("the person arrives in another field");
          const id = fresh();
          const field = new FarField();
          field.contextId = id;
          field.nextContextId = fresh;
          field.onRotate = opened.renew;
          segments.at(-1)!.end = { text: focused.value, caret: focused.caret };
          focused = field;
          segments.push(segment(field, kinds.length));
          // What the change itself sends (the old context's composition committed) is no action's.
          const before = owners;
          owners = [];
          await opened.publish(id);
          owners = before;
        } else if (which === "C") {
          // CY4: also while a composition is open, where a rewrite of the value ends it. A move of
          // the caret alone keeps it open in Blink, which refuses the next update then: not
          // modelled by the far field, so not drawn while it composes.
          const text = focused.value;
          const spots = [0, ...characters(text).map(({ end }) => end)];
          const at = pick(spots);
          const way = next();
          let rewrite: PageAct | null = null;
          if (way < 0.25) {
            steps.push(`the page adds "Z" at ${at}`);
            rewrite = { kind: "insert", at, text: "Z" };
          } else if (way < 0.5 && at > 0) {
            const from = spots[spots.indexOf(at) - 1]!;
            steps.push(`the page deletes ${from} to ${at}`);
            rewrite = { kind: "delete", from, to: at };
          } else if (way < 0.75 && !focused.composition) {
            steps.push(`the page moves its caret to ${at}`);
            rewrite = { kind: "caret", at };
          } else steps.push("the page rotates its context");
          if (rewrite) {
            // The page's rewrite ends an open composition, its text kept.
            const composition = focused.composition;
            if (composition && rewrite.kind !== "caret")
              ended.push(focused.value.slice(composition.start, composition.end));
            pageAct(focused, rewrite);
            log.push({ act: rewrite });
          }
          clock += 1;
          // The page rewrote the field: a new context for it, the old one an earlier one.
          const id = fresh();
          if (focused.contextId !== null) focused.earlier.add(focused.contextId);
          focused.contextId = id;
          log.push({ act: { kind: "context", contextId: id } });
          logged = id;
          const before = owners;
          owners = [];
          await opened.publish(id);
          owners = before;
        }
      }
      const boundaries = [0, ...characters(run.native.text).map(({ end }) => end)];
      const here = segments.at(-1)!.person;
      let choice = next();
      const composing = here.marked !== null;
      const caret = here.selection.start === here.selection.end;
      if (composing && !(choice < 0.22 || (choice >= 0.4 && choice < 0.45) || choice >= 0.65))
        choice = next() < 0.5 ? 0.1 : 0.67;
      if (composing && choice >= 0.73 && choice < 0.78) choice = 0.9;
      if (choice < 0.22) {
        text = pick(letters);
        if (!composing) kind = "typed";
        await run.insertText(text);
      } else if (choice < 0.32) {
        if (!display) {
          text = pick(letters);
          if (!composing) kind = "typed";
          await run.type(text);
        }
      } else if (choice < 0.4) {
        if (!composing && caret) kind = "delete";
        await run.backspace();
      } else if (choice < 0.45 && composing) {
        const marked = here.marked;
        const text = marked ? here.text.slice(marked.start, marked.end) : "";
        const way = next();
        if (way < 1 / 3) await run.setMarkedText("");
        else if (way < 2 / 3 && characters(text).length > 1)
          await run.setMarkedText(text.slice(0, characters(text).at(-2)!.end));
        else await run.deleteBackward();
      } else if (choice < 0.45) {
        if (caret) kind = "delete";
        await run.deleteBackward();
      } else if (choice < 0.54) {
        // CY9: a swipe of a distance the person chose, as in regime A (CW6 a).
        kind = "move";
        swiped = pick([-3, -2, -1, 1, 2, 3]);
        await run.swipe(swiped);
      } else if (choice < 0.58) {
        const [start, end] = [pick(boundaries), pick(boundaries)].sort((x, y) => x - y);
        if (!display && !acted) await run.moveSelection(start!, end!);
      } else if (choice < 0.62) {
        const [start, end] = [pick(boundaries), pick(boundaries)].sort((x, y) => x - y);
        const word = pick(["the", "ab", "é"]);
        // Not from a recording (CV2): any range, as in the third generator. In C also after the
        // page acted: a replacement it then refuses may be missing, never what was typed.
        if (!display && (!acted || which === "C")) await run.replaceRange(start!, end!, word);
      } else if (choice < 0.65) {
        text = pick(["pasted", "א b"]);
        kind = "typed";
        await run.paste(text);
      } else if (choice < 0.7) await run.setMarkedText(pick(["に", "日本"]));
      else if (choice < 0.73) await run.unmarkText();
      else if (choice < 0.78) await run.answer(1);
      else await run.answer(1 + Math.floor(next() * 3));
      // A kind drawn for an action the person did not take (nothing to delete) goes with it.
      kind = "other";
    }
    while (harness.answers.length > 0) await opened.answerAll();
    const last = segments.at(-1)!;
    last.end = { text: last.field.value, caret: last.field.caret };
    /** What the page shows of a person's text: a composition a target cannot show is not there yet. */
    const shown = (p: Person) =>
      p.marked && !target.composition
        ? p.text.slice(0, p.marked.start) + p.replaced + p.text.slice(p.marked.end)
        : p.text;
    const replay = (segment: Segment, count: number) => {
      const p = new Person();
      p.text = segment.start.text;
      p.selection = { start: segment.start.caret, end: segment.start.caret };
      for (const action of segment.actions.slice(0, count)) action(p);
      return p;
    };
    const refusedOf = (index: number) =>
      sent.filter((entry) => entry.owners.includes(index) && !applied(entry));
    /** Relative to the caret: an insertion, a paste, a command in the protocol's relative list. */
    const relativeOp = (operation: EditingOperation) =>
      (operation.kind === "edit" &&
        operation.edit.text !== "" &&
        !operation.edit.before &&
        !operation.edit.after) ||
      operation.kind === "paste" ||
      (operation.kind === "command" && caretRelativeEditingCommands.has(operation.command));
    let failure: string | null = null;
    const said = (text: string) => JSON.stringify(escape(text));
    const describe = (operation: EditingOperation) =>
      JSON.stringify(operation, (key, value: unknown) => (key === "bytes" ? "…" : value));
    if (which === "B") {
      for (const [index, part] of segments.entries()) {
        const arrival = index === segments.length - 1;
        const appliedHere = sent.filter(
          (entry) => entry.field === part.field && applied(entry) && entry.owners.length > 0,
        );
        // Up to the last of its actions the page applied there (all of them, where it arrived).
        const reached = Math.max(
          ...appliedHere.flatMap((entry) => entry.owners).map((owner) => owner + 1),
          part.first,
        );
        const count = arrival
          ? part.actions.length
          : Math.min(reached - part.first, part.actions.length);
        const holds = replay(part, count);
        const dropped = Array.from({ length: count }, (_, offset) => part.first + offset).flatMap(
          refusedOf,
        );
        const end = part.end!;
        // Made in this field and sent to it: the page applied it, unless it was a replacement.
        const lost = sent.filter(
          (entry) =>
            entry.field === part.field &&
            entry.own &&
            !applied(entry) &&
            relativeOp(entry.operation),
        );
        // CY9: from what the person did, not from what was sent: each of their actions here that
        // sends something (a typed text, a Backspace at a caret, a swipe where the target takes
        // moves) reached the page, and each of its operations was applied or refused there.
        const absent = part.actions.flatMap((_, offset) => {
          const action = part.first + offset;
          const each = kinds[action];
          if (each !== "typed" && each !== "delete" && !(each === "move" && target.commands))
            return [];
          const its = sent.filter((entry) => entry.owners.includes(action));
          // Swipes one report stands for that end where they began move nothing: none is sent.
          const group = reported.get(action);
          const still =
            each === "move" &&
            group !== undefined &&
            group.reduce((sum, index) => sum + (distances.get(index) ?? 0), 0) === 0 &&
            !sent.some((entry) => group.some((index) => entry.owners.includes(index)));
          if (its.length === 0 && still) return [];
          if (its.length === 0) return [`action ${action + 1} (${each}) never reached the page`];
          const lostHere = its.filter(
            (entry) => !applied(entry) && !entry.field.refused.includes(entry.operation),
          );
          return lostHere.length === 0
            ? []
            : [
                `action ${action + 1} (${each}) was neither applied nor refused: ${lostHere.map((entry) => describe(entry.operation)).join(", ")}`,
              ];
        });
        if (part.field.mismatched.length > 0)
          failure = `field ${index + 1}: mismatched ${part.field.mismatched.map(describe).join(", ")}`;
        else if (absent.length > 0) failure = `field ${index + 1}: ${absent.join("; ")}`;
        else if (lost.length > 0)
          failure = `field ${index + 1}: lost while it had focus: ${lost.map((entry) => describe(entry.operation)).join(", ")}`;
        else if (dropped.length > 0)
          failure = `field ${index + 1}: refused before the end: ${dropped.map((entry) => describe(entry.operation)).join(", ")}`;
        else if (end.text !== shown(holds))
          failure = `field ${index + 1} (${arrival ? "arrived in: exactly" : `left: the first ${count} actions`}): holds ${said(end.text)}, the person did ${said(shown(holds))}`;
        // The caret where it arrived, during a composition too where the target shows it.
        else if (
          arrival &&
          (holds.marked === null || target.composition) &&
          holds.selection.start === holds.selection.end &&
          end.caret !== holds.selection.start
        )
          failure = `field ${index + 1} (arrived in): caret ${end.caret}, the person's ${holds.selection.start}`;
        if (failure) break;
      }
    } else {
      // CY2: the page's acts and what its field applied, in order, give its text and caret.
      const model = new PageModel(segments[0]!.start, startContext);
      for (const item of log) {
        if ("act" in item) model.page(item.act);
        else item.entry.put = model.apply(item.operation);
      }
      // CY2: each typed action's text applied exactly once, in the order typed. Its turn may also
      // carry compositions committed before it, which a target that cannot show a composition
      // inserts with the next text: what goes ahead of it is a composition's, checked below.
      let promise: string | null = null;
      let previous = -1;
      /** What went ahead of each typed text in its own turn, where it went. */
      const ahead = new Map<number, string>();
      for (const [index, each] of kinds.entries()) {
        if (each !== "typed" || texts[index] === "") continue;
        const landed = sent.filter(
          (entry) =>
            entry.owners.includes(index) && applied(entry) && inserted(entry.operation) !== null,
        );
        let got = landed.map((entry) => inserted(entry.operation)).join("");
        if (got.endsWith(texts[index]!)) {
          ahead.set(landed[0]!.at!, got.slice(0, got.length - texts[index]!.length));
          got = texts[index]!;
        }
        if (got !== texts[index]) {
          promise = `action ${index + 1} typed ${said(texts[index]!)}, the page applied ${landed.length === 0 ? "nothing of it" : said(got)}`;
          break;
        }
        if (landed[0]!.at! <= previous) {
          promise = `action ${index + 1} typed ${said(texts[index]!)} was applied before what was typed before it`;
          break;
        }
        previous = landed.at(-1)!.at!;
      }
      // Ruling 2: each composition the person committed is applied exactly once, in order. In the
      // order the far field applied them, what composing turns (and a change of context, no one's
      // turn) put in, with what went ahead of typed text, reads as each committed text in turn:
      // the commit itself; what was marked when the context changed and then the commit, where
      // the person chose another candidate (CY4); or only the rest, where a rewrite of the page
      // ended the composition keeping its text (committedRemainder). Nothing else is left.
      if (!promise) {
        let put = "";
        for (const item of log) {
          if ("act" in item) continue;
          const { entry } = item;
          if (ahead.has(entry.at!)) put += ahead.get(entry.at!)!;
          if (inserted(entry.operation) === null || !entry.put) continue;
          if (entry.owners.length === 0 || entry.owners.some((owner) => composing.has(owner)))
            if (!entry.owners.some((owner) => kinds[owner] === "typed")) put += entry.put;
        }
        let rest = put;
        for (const lineage of lineages) {
          // What its changes of context committed: up to one marked text each, in order.
          let last: string | null = null;
          // The changes of context between its start and the turn of the action that ended it,
          // when the phone ended it (to the end of the sequence for one left open). Each may
          // commit two of its marked texts: what the phone's reducer had marked then, and what
          // the native field had marked when its configure ended the composition (one mark
          // further on, CY4's insertion of a commit that differs).
          const ending = lineage.end === undefined ? undefined : turnClock.get(lineage.end);
          let changes = 2 * ((ending ?? clock) - lineage.start);
          let at = 0;
          const commit = lineage.committed;
          while (changes > 0 && rest !== "") {
            const marked = lineage.marked.slice(at);
            // The longest marked text the field took next, leaving room for the commit's form.
            const next = marked
              .map((text, offset) => ({ text, offset }))
              .filter(({ text }) => rest.startsWith(text))
              .sort((a, b) => b.text.length - a.text.length)[0];
            if (!next) break;
            const after = rest.slice(next.text.length);
            // A change's text equal to the commit, with the commit adding nothing, ends here.
            if (commit && commit.text === next.text && !after.startsWith(commit.text)) {
              last = next.text;
              rest = after;
              break;
            }
            if (
              commit &&
              after.startsWith(committedRemainder(next.text, commit.text)) === false &&
              rest.startsWith(commit.text)
            )
              break;
            last = next.text;
            rest = after;
            at += next.offset + 1;
            changes -= 1;
          }
          if (!commit) continue;
          const forms =
            last !== null
              ? [committedRemainder(last, commit.text)]
              : [
                  commit.text,
                  ...lineage.marked
                    .filter((text) => ended.includes(text))
                    .map((text) => committedRemainder(text, commit.text)),
                ];
          const form = forms
            .sort((a, b) => b.length - a.length)
            .find((candidate) => rest.startsWith(candidate));
          if (form === undefined) {
            promise = `action ${commit.index + 1} committed ${said(commit.text)}${last !== null ? ` after a change committed ${said(last)}` : ""}, and what the page took of compositions from there is ${said(rest)}`;
            break;
          }
          rest = rest.slice(form.length);
        }
        if (!promise && rest !== "")
          promise = `the page took ${said(rest)} of compositions beyond what the person committed (${lineages.flatMap((lineage) => (lineage.committed ? [said(lineage.committed.text)] : [])).join(", ")})`;
      }
      // Relative to the caret: an insertion, a paste, a move or deletion command. A refused
      // replacement (a selection's deletion, a composition's update) is allowed.
      const relative = ({ operation }: (typeof sent)[number]) => relativeOp(operation);
      const refused = kinds.flatMap((each, index) =>
        each === "other"
          ? []
          : refusedOf(index)
              .filter(relative)
              .map((entry) => ({ each, entry })),
      );
      const unapplied = kinds
        .map((each, index) => ({ each, index }))
        .filter(
          ({ each, index }) =>
            each === "delete" &&
            !sent.some((entry) => entry.owners.includes(index) && applied(entry)),
        );
      if (refused.length > 0)
        failure = `refused: ${refused.map(({ each, entry }) => `${each} ${describe(entry.operation)}`).join(", ")}`;
      else if (unapplied.length > 0)
        failure = `a Backspace the page never applied: action ${unapplied.map(({ index }) => index + 1).join(", ")}${process.env.OPENSTEER_TYPING_TRACE ? ` (sent ${JSON.stringify(sent.map((entry) => [entry.operation.kind, entry.owners, applied(entry)]))}, kinds ${JSON.stringify(kinds)})` : ""}`;
      else if (promise) failure = promise;
      else if (model.value !== last.field.value || model.caret !== last.field.caret)
        failure = `the page holds ${said(last.field.value)} with its caret at ${last.field.caret}; what it did and applied makes ${said(model.value)} at ${model.caret}`;
    }
    await act(async () => root.render(null));
    harness.answers = [];
    harness.mounted = false;
    harness.take = null;
    harness.renewed = null;
    return {
      target: name,
      failure:
        failure && `regime ${which}, seed ${seed}, target ${name}: ${failure}; ${steps.join("; ")}`,
      // How much the page did: fields it changed to or contexts it published, operations refused.
      changes: segments.length - 1 + steps.filter((step) => step.startsWith("the page ")).length,
      refused: sent.filter((entry) => !applied(entry)).length,
    };
  }
  // CV3: the field resigning while an edit waits, as the real view does it: the edit keeps its
  // turn, the blur comes after it, and what the person typed reaches the page.
  it("keeps an edit that waits when the field resigns", async () => {
    const { remote, native, keyboard, answerAll } = await open();
    await keyboard((field) => field.insertText("a"));
    await keyboard((field) => field.blur());
    await answerAll();
    expect(native.text === "" || native.text === "a").toBe(true);
    expect(remote.value).toBe("a");
    expect(remote.refused).toEqual([]);
  });

  // Ruling 2's promise found it (regime C, seed 170): the page's new context arrives while a
  // commit and the letters after it still wait under the context left. The commit ends the
  // composition in both reducers, but the native field holds the context left's mirror: that
  // reducer's answer is the one it takes, or its mirror is never cleared and the next letter
  // carries what was committed again.
  it.each(["full", "basic", "baseline", "display"] as const)(
    "on %s, applies a commit once and the next letter alone across a change of context",
    async (name) => {
      const { remote, keyboard, answerAll, publish } = await open(targets[name]);
      await keyboard((field) => field.setMarkedText("に"));
      await keyboard((field) => field.unmarkText());
      await keyboard((field) => field.insertText("a"));
      await keyboard((field) => field.insertText("a"));
      const next = "00000000-0000-4000-8000-000000000782";
      remote.earlier.add(remote.contextId!);
      remote.contextId = next;
      await publish(next);
      await answerAll();
      expect(remote.value).toBe("にaa");
    },
  );

  // CY4, the lead's ruling 2: the page rewrites its field under "に", ending the composition and
  // keeping its text; the phone commits "に" at the change of context. Applied once: "Zにx".
  it("applies once a composition the page ended itself, then types after it", async () => {
    const { remote, keyboard, answerAll, publish } = await open();
    await keyboard((field) => field.setMarkedText("に"));
    await answerAll();
    expect(remote.composition).not.toBeNull();
    // The page's rewrite ends the composition, its text kept, as Blink does.
    remote.endComposition();
    remote.value = `Z${remote.value}`;
    remote.caret += 1;
    const next = "00000000-0000-4000-8000-000000000779";
    remote.earlier.add(remote.contextId!);
    remote.contextId = next;
    await publish(next);
    await answerAll();
    await keyboard((field) => field.unmarkText());
    await answerAll();
    await keyboard((field) => field.insertText("x"));
    await answerAll();
    expect(remote.value).toBe("Zにx");
    expect(remote.caret).toBe(3);
  });

  // CZ6: never a partial paste. A paste that comes late (named under the context just left) goes
  // as one insertion under that context; one larger than one operation may carry is refused
  // whole, nothing of it lands, and the person is told to paste again.
  it.each([
    [10_000, true],
    [10_001, false],
  ] as const)(
    "delivers a late paste of %i characters whole, or refuses it whole",
    async (length, lands) => {
      const { remote, keyboard, answerAll, publish } = await open();
      harness.texts = [];
      const text = Array.from({ length }, (_, index) => String(index % 10)).join("");
      await keyboard((field) => {
        field.insertText("a");
        field.paste(text);
      });
      const next = "00000000-0000-4000-8000-000000000780";
      remote.earlier.add(remote.contextId!);
      remote.contextId = next;
      await publish(next);
      await answerAll();
      expect(remote.value).toBe(lands ? `a${text}` : "a");
      for (const operation of remote.sent)
        if (operation.kind === "edit")
          expect(operation.edit.text.length).toBeLessThanOrEqual(editingTextMaxLength);
      if (!lands) expect(harness.texts).toContain(lateTooLarge);
    },
  );

  // CY8: a send the transport refuses on the late path reaches that context's reducer, as on the
  // ordinary path (CU5): the composition it carried goes again as a fresh start.
  it("tells the late reducer of a send the transport refused", async () => {
    const { remote, keyboard, answerAll, publish } = await open();
    const before = remote.contextId;
    await keyboard((field) => {
      field.insertText("a");
      field.setMarkedText("に");
      field.setMarkedText("にほ");
    });
    const next = "00000000-0000-4000-8000-000000000781";
    remote.earlier.add(remote.contextId!);
    remote.contextId = next;
    await publish(next);
    const composed: EditingOperation[] = [];
    let refused = false;
    harness.take = (operation) => {
      const made = operation as EditingOperation;
      if (made.kind === "compose" && made.composition.contextId === before) {
        composed.push(made);
        if (!refused) {
          refused = true;
          return false;
        }
      }
      return remote.take(made);
    };
    await answerAll();
    expect(composed.length).toBeGreaterThan(1);
    // Refused, the first never left: the next is a fresh start, restating what it replaces.
    expect(composed[1]).toMatchObject({ kind: "compose", composition: { before: "", after: "" } });
  });

  // CZ9: a keystroke of the context just left that reaches the view right after React commits
  // the new context, before its passive effects, is reduced there: the context left is retired
  // in the same step the new one is taken, with no window between.
  it("keeps a keystroke of the context left that arrives between the commit and its effects", async () => {
    const { remote, keyboard, answerAll } = await open();
    await keyboard((field) => field.insertText("a"));
    await answerAll();
    // The page's new context for the same field; React commits it with no act around it.
    const next = "00000000-0000-4000-8000-000000000786";
    remote.earlier.add(remote.contextId!);
    remote.contextId = next;
    let delivered = false;
    harness.committed = (contextId) => {
      if (contextId !== next || delivered) return;
      delivered = true;
      // After the commit's layout phase, before the passive effects: what the bridge would do.
      queueMicrotask(() =>
        harness.field!.deliver({
          id: 3,
          contextId: "00000000-0000-4000-8000-000000000001",
          event: { type: "beforeinput", inputType: "insertText", data: "b" },
        }),
      );
    };
    const seen: { id: number; preventDefault?: boolean }[] = [];
    const respond = harness.field!.respond;
    harness.field!.respond = (instruction) => {
      seen.push(instruction as { id: number; preventDefault?: boolean });
      return respond(instruction);
    };
    root.render(
      <NativeEditingProxy
        context={{ ...context, contextId: next }}
        sendOperation={(operation) => remote.take(operation)}
        onDone={() => undefined}
      />,
    );
    await vi.waitFor(() => expect(seen.some((answer) => answer.id === 3)).toBe(true));
    await act(async () => undefined);
    // Its answer came from the context left's reducer, which lets the keystroke go: not
    // prevented for want of one.
    expect(seen.find((answer) => answer.id === 3)?.preventDefault).not.toBe(true);
    harness.committed = null;
  });

  // CZ2: a composition a tap, a blur or a refusal already ended has no commit, whatever comes
  // after it: the input method's own commit of it that arrives under the context left inserts
  // nothing (the person walked away from it).
  const rotate = async (opened: Awaited<ReturnType<typeof open>>, contextId: string) => {
    opened.remote.earlier.add(opened.remote.contextId!);
    opened.remote.contextId = contextId;
    await opened.publish(contextId);
  };
  it("commits nothing more of a composition a tap ended, after the context changes", async () => {
    const opened = await open();
    const { remote, keyboard, answerAll, interrupt } = opened;
    await keyboard((field) => field.setMarkedText("に"));
    await answerAll();
    // The input method's commit of a candidate waits behind an update still unanswered; the
    // tap ends the composition, then the context changes, before that commit's turn.
    await keyboard((field) => {
      field.setMarkedText("にほ");
      field.insertText("日本");
    });
    await interrupt("pointerdown");
    await rotate(opened, "00000000-0000-4000-8000-000000000783");
    await answerAll();
    // What the tap committed (the reducer had "に" then) stays; the later commit adds nothing.
    expect(remote.value).toBe("に");
  });
  it("commits nothing more of a composition a blur ended on the late path", async () => {
    const opened = await open();
    const { remote, keyboard, answerAll } = opened;
    await keyboard((field) => field.setMarkedText("に"));
    await answerAll();
    // The composition is live when the context changes; the blur comes after, on the late path.
    await keyboard((field) => {
      field.setMarkedText("にほ");
      field.blur();
      field.insertText("日本");
    });
    await rotate(opened, "00000000-0000-4000-8000-000000000784");
    await answerAll();
    // What the change of context committed stays; the commit after the blur adds nothing.
    expect(remote.value).toBe("に");
  });
  it("commits nothing of a composition the target refused, after the context changes", async () => {
    const opened = await open();
    const { remote, keyboard, answerAll } = opened;
    await keyboard((field) => field.insertText("a"));
    await answerAll();
    // Larger than one operation may carry: refused, and the composition ends there.
    await keyboard((field) => field.setMarkedText("x".repeat(editingTextMaxLength + 1)));
    await answerAll();
    await keyboard((field) => field.insertText("日本"));
    await rotate(opened, "00000000-0000-4000-8000-000000000785");
    await answerAll();
    expect(remote.value).toBe("a");
  });

  // CY4: what a person commits is never dropped. The page rotates while "に" is marked and the
  // person's commit of "日本" waits in the gate under the old context: the rotation committed "に"
  // on the page, and "日本" goes as an insertion under its own context, deleting nothing (the
  // person sees both and may correct it). A commit of what the rotation committed adds nothing.
  it.each([
    ["日本", "に日本"],
    ["にほん", "にほん"],
    ["に", "に"],
  ] as const)(
    "inserts %s, committed while the field rotated under its composition",
    async (committed, expected) => {
      const { remote, keyboard, answer, answerAll, publish } = await open();
      await keyboard((field) => field.setMarkedText("に"));
      for (let index = 0; index < 10 && remote.composition === null; index++) await answer(1);
      expect(remote.composition).not.toBeNull();
      await keyboard((field) => field.insertText(committed));
      const next = "00000000-0000-4000-8000-000000000778";
      remote.earlier.add(remote.contextId!);
      remote.contextId = next;
      await publish(next);
      await answerAll();
      expect(remote.value).toBe(expected);
      expect(remote.refused).toEqual([]);
    },
  );

  // CY9 found it (regime B, seed 826): the field resigns while what was typed before the page's
  // new context still waits in the gate. The blur clears the native mirror of the context left;
  // that context's late reducer must know, or the letter typed next there looks like no change.
  it.each(["full", "display"] as const)(
    "on %s, sends the letter typed after a blur under the context just left",
    async (name) => {
      const { remote, keyboard, answer, answerAll, publish } = await open(targets[name]);
      await keyboard((field) => field.insertText("a"));
      await keyboard((field) => field.blur());
      await keyboard((field) => field.insertText("b"));
      for (let index = 0; index < 10 && remote.sent.length === 0; index++) await answer(1);
      expect(remote.value).toBe("a");
      // The page's new context for the same field, while the blur and the "b" wait.
      const next = "00000000-0000-4000-8000-000000000777";
      remote.earlier.add(remote.contextId!);
      remote.contextId = next;
      await publish(next);
      await answerAll();
      expect(remote.value).toBe("ab");
      expect(remote.refused).toEqual([]);
    },
  );

  // CV1, the walk: a word the keyboard replaces by range after the page rewrote the field is
  // refused as a replacement; the letters typed stay, and what is typed next lands.
  it("keeps the typed word when the page refuses the keyboard's replacement of it", async () => {
    const { remote, keyboard, answerAll, publish } = await open();
    for (const letter of "teh") await keyboard((field) => field.insertText(letter));
    await answerAll();
    await keyboard((field) => field.replaceRange(0, 3, "the"));
    // The page rewrites the field before the replacement reaches it: a new context.
    remote.value = `Z${remote.value}`;
    remote.caret += 1;
    remote.earlier.add(remote.contextId!);
    remote.contextId = "00000000-0000-4000-8000-000000000999";
    await publish(remote.contextId);
    await answerAll();
    await keyboard((field) => field.insertText(" "));
    await answerAll();
    expect(remote.value).toBe("Zteh ");
    expect(remote.refused).toMatchObject([{ kind: "edit", edit: { text: "the", before: "teh" } }]);
  });

  // CY2, the fault the 37 replays pinned, end to end: the page rewrites its field without a word,
  // the keyboard's replacement made for the old text is refused as mismatched and the page
  // rotates, while the next two keystrokes wait in the native gate, named under the old context.
  // They cross the rotation and land, each once, in order, at the page's caret.
  it("keeps typing that waits in the gate across a rotation a mismatched replacement causes", async () => {
    const { remote, native, keyboard, answer, answerAll } = await open();
    for (const letter of "teh") await keyboard((field) => field.insertText(letter));
    await answerAll();
    // The page adds "Z" after the "t" and has not published it.
    remote.value = "tZeh";
    remote.caret = 4;
    const before = remote.contextId;
    await keyboard((field) => {
      field.replaceRange(0, 3, "the");
      field.insertText(" ");
      field.insertText("x");
    });
    // The replacement's answers come one at a time until it reaches the page and is refused; the
    // two keystrokes are still in the gate then, named under the old context.
    for (let index = 0; index < 10 && remote.mismatched.length === 0; index++) await answer(1);
    expect(remote.mismatched).toMatchObject([
      { kind: "edit", edit: { text: "the", before: "teh" } },
    ]);
    expect(remote.contextId).not.toBe(before);
    expect(native.queued).toBeGreaterThan(0);
    const sentBefore = remote.sent.length;
    await answerAll();
    const typed = remote.sent.slice(sentBefore);
    expect(typed).toEqual([
      { kind: "edit", edit: { contextId: before, text: " ", before: "", after: "" } },
      { kind: "edit", edit: { contextId: before, text: "x", before: "", after: "" } },
    ]);
    expect(remote.value).toBe("tZeh x");
    expect(remote.caret).toBe(6);
    expect(remote.refused).toHaveLength(1);
  });

  // CW2, CW3: each check catches a loss. A far side that drops or refuses one operation makes
  // the regime fail on the first seed where that operation is sent.
  const insertion = (operation: unknown) => {
    const edit =
      (operation as EditingOperation).kind === "edit"
        ? (operation as { edit: { text: string; before?: string; after?: string } }).edit
        : null;
    return edit !== null && edit.text !== "" && !edit.before && !edit.after;
  };
  it.each([
    [
      "B",
      "drop",
      "the first insertion after arriving",
      (operation: unknown, arrived: boolean) => arrived && insertion(operation),
    ],
    ["C", "drop", "a typed insertion", (operation: unknown) => insertion(operation)],
    // CY2: what only a comparison of the far text and caret catches.
    ["C", "double", "an insertion", (operation: unknown) => insertion(operation)],
    [
      "C",
      "misplace",
      "an insertion",
      (operation: unknown, _arrived: boolean, field: unknown) =>
        insertion(operation) && (field as FarField).value !== "",
    ],
    // Ruling 2: what only the commit promise catches (the far field and the model agree on it).
    [
      "C",
      "recommit",
      "a composition's commit, sent twice",
      (operation: unknown, _arrived: boolean, field: unknown) =>
        insertion(operation) && (field as FarField).composition !== null,
    ],
    [
      "C",
      "shift",
      "the caret after an insertion",
      (operation: unknown, _arrived: boolean, field: unknown) =>
        insertion(operation) && (field as FarField).value !== "",
    ],
    [
      "C",
      "refuse",
      "a Backspace",
      (operation: unknown) =>
        (operation as EditingOperation).kind === "command" &&
        (operation as { command: string }).command === "deleteBackward",
    ],
  ] as const)("regime %s fails when the page would %s %s", async (which, what, _name, matches) => {
    let failure: string | null = null;
    for (let seed = 1; seed <= 50 && failure === null; seed++) {
      let triggered = false;
      harness.sabotage = (operation, arrived, field) => {
        if (triggered || !matches(operation, arrived, field)) return null;
        triggered = true;
        return what;
      };
      const result = await regime(seed, which);
      harness.sabotage = null;
      if (triggered) {
        failure = result.failure;
        expect(failure, `seed ${seed}`).not.toBeNull();
      }
    }
    expect(failure).not.toBeNull();
  });

  // CY9: regime B starts from what the person did. Every insertion to the first field never reaches
  // the page: where the person left that field, nothing of what they typed there was sent, and
  // regime B fails all the same (its floor is no longer what was sent).
  it("regime B fails when what the person typed in a field they left never reaches the page", async () => {
    let left = 0;
    for (let seed = 1; seed <= 50; seed++) {
      let lost = false;
      harness.sabotage = (operation, _arrived, field) => {
        if (field !== harness.remote || !insertion(operation)) return null;
        lost = true;
        return "lose";
      };
      const result = await regime(seed, "B");
      harness.sabotage = null;
      if (!lost) continue;
      expect(result.failure, `seed ${seed}`).not.toBeNull();
      if (result.changes > 0) left += 1;
    }
    expect(left).toBeGreaterThan(0);
  });

  // Regimes B and C over OPENSTEER_TYPING_REGIME_RUNS sequences each (1,000 by default, every
  // push: about 7 seconds a regime on this Mac at a load of 28), 100 to a test, counted per target.
  // OPENSTEER_TYPING_FUZZ_REPORT appends each failure, and each chunk's tally, to that file.
  const regimeRuns = Number(process.env.OPENSTEER_TYPING_REGIME_RUNS ?? 1_000);
  // OPENSTEER_TYPING_REGIME_SEED starts elsewhere (one seed, traced, with _RUNS=1).
  const regimeFirst = Number(process.env.OPENSTEER_TYPING_REGIME_SEED ?? 1);
  for (const which of ["B", "C"] as const)
    for (let chunk = regimeFirst; chunk < regimeFirst + regimeRuns; chunk += 100) {
      const last = Math.min(chunk + 99, regimeFirst + regimeRuns - 1);
      it(`regime ${which}: its promise over random sequences ${chunk} to ${last}`, async () => {
        const tally: Record<
          string,
          { run: number; failing: number; changes: number; refused: number }
        > = {};
        const failures: string[] = [];
        for (let seed = chunk; seed <= last; seed++) {
          let result: { target: string; failure: string | null; changes: number; refused: number };
          try {
            result = await regime(seed, which);
          } catch (error) {
            result = {
              target: "thrown",
              failure: `regime ${which}, seed ${seed}: ${String(error instanceof Error ? error.message : error)}`,
              changes: 0,
              refused: 0,
            };
            await act(async () => root.render(null));
            harness.answers = [];
            harness.mounted = false;
            harness.take = null;
            harness.renewed = null;
          }
          const entry = (tally[result.target] ??= { run: 0, failing: 0, changes: 0, refused: 0 });
          entry.run += 1;
          entry.changes += result.changes;
          entry.refused += result.refused;
          if (result.failure) {
            entry.failing += 1;
            failures.push(result.failure);
          }
        }
        if (process.env.OPENSTEER_TYPING_FUZZ_REPORT)
          appendFileSync(
            process.env.OPENSTEER_TYPING_FUZZ_REPORT,
            `${failures.map((failure) => `${failure}\n`).join("")}regime ${which} tally ${JSON.stringify(tally)}\n`,
          );
        expect(failures).toEqual([]);
      });
    }

  // 300 sequences of the third generator a run; OPENSTEER_TYPING_FUZZ_RUNS and _SEED run more,
  // 300 to a test. The third is the second with deletion inside a composition both ways.
  const runs = Number(process.env.OPENSTEER_TYPING_FUZZ_RUNS ?? 300);
  const firstSeed = Number(process.env.OPENSTEER_TYPING_FUZZ_SEED ?? 1);
  for (let chunk = firstSeed; chunk < firstSeed + runs; chunk += 300) {
    const last = Math.min(chunk + 300, firstSeed + runs) - 1;
    it(`regime A: the far field is the person's over random sequences ${chunk} to ${last}`, async () => {
      // Every failing seed in the chunk, not just the first.
      const failures: string[] = [];
      for (let seed = chunk; seed <= last; seed++) {
        try {
          await sequence2(seed, true);
        } catch (error) {
          failures.push(String(error instanceof Error ? error.message : error));
          await act(async () => root.render(null));
          harness.answers = [];
          harness.mounted = false;
        }
      }
      if (process.env.OPENSTEER_TYPING_FUZZ_REPORT)
        for (const failure of failures)
          require("node:fs").appendFileSync(
            process.env.OPENSTEER_TYPING_FUZZ_REPORT,
            `${failure}\n`,
          );
      expect(failures).toEqual([]);
    });
  }
});
