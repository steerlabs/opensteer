// @vitest-environment happy-dom
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
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
  harness.take = null;
  harness.renewed = null;
});

/**
 * The product's targets, as the Host's negotiation and the display integration pick them
 * (packages/client/src/host/browser-editing.ts, integrations/display-editing.ts): the random
 * test draws only these.
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
  const render = () =>
    root.render(
      <NativeEditingProxy
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
        // The far field honours a command's context, as a far side that negotiated it does.
        commandContext
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
      else unexpected.push(turn);
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
        if (selection.start === selection.end && marked === null)
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
      else if (choice < 0.54) await run.moveSelection(pick(boundaries));
      else if (choice < 0.58) {
        const [start, end] = [pick(boundaries), pick(boundaries)].sort((x, y) => x - y);
        if (!display) await run.moveSelection(start!, end!);
      } else if (choice < 0.62) {
        const [start, end] = [pick(boundaries), pick(boundaries)].sort((x, y) => x - y);
        const word = pick(["the", "ab", "é"]);
        // No autocorrect on a target without range edits: the keyboard's is turned off there.
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
   * generator's actions, with the page acting between them.
   *
   * B, the field changes: the page rotates its context, or the person arrives in another field
   * (a second far field; an operation under any other context is refused there as stale, as the
   * real applier refuses it, and rotates its context). The promise: the field the person left
   * holds a prefix of what they did there, in order; the field they arrived in holds exactly
   * what they did after arriving; nothing crosses. Each context the page publishes begins a
   * segment (the focused far field as it then stands, and the person's actions from there): a
   * segment another change cut must be some prefix of its actions applied to its start, the
   * last one all of them. No model of what was in flight.
   *
   * C, the page interferes: it rewrites its own value under the person (a mask that adds a
   * character, one that deletes one, one that moves the caret), and the field gets a new context
   * for it, as the real applier gives it (tests/editing-far-model.test.ts). The promise (CV1):
   * everything the person typed or pasted is in the page, in order: the page took it. Only a
   * replacement (an autocorrect, a composition's update) may be missing.
   *
   * What UIKit selects or replaces by itself is drawn only before the page first acts: after it
   * the native mirror is no longer the person's text from a known place.
   */
  interface Segment {
    field: FarField;
    start: { text: string; caret: number };
    actions: Action[];
    end?: string;
  }
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
    const segments: Segment[] = [{ field: focused, start: { text: "", caret: 0 }, actions: [] }];
    harness.take = (operation) => focused.take(operation as EditingOperation);
    harness.renewed = () => {
      const current = segments.at(-1)!;
      current.end = current.field.value;
      segments.push({
        field: focused,
        start: { text: focused.value, caret: focused.caret },
        actions: [],
      });
    };
    // Every action of the person, in the segment it was done in.
    const act0 = oracle.act.bind(oracle);
    const choose0 = oracle.choose.bind(oracle);
    oracle.act = (action) => {
      segments.at(-1)!.actions.push(action);
      act0(action);
    };
    oracle.choose = (action) => {
      segments.at(-1)!.actions.push(action);
      choose0(action);
    };
    let acted = false;
    let composing = false;
    /** What the person typed or pasted, in order (regime C's promise). */
    const typed: string[] = [];
    const length = 1 + Math.floor(next() * 28);
    for (let step = 0; step < length; step++) {
      if (next() < 0.12) {
        if (which === "B") {
          acted = true;
          const id = fresh();
          if (next() < 0.5) {
            steps.push("the page rotates its context");
            focused.contextId = id;
          } else {
            steps.push("the person arrives in another field");
            const field = new FarField();
            field.contextId = id;
            field.nextContextId = fresh;
            field.onRotate = opened.renew;
            focused = field;
          }
          await opened.publish(id);
        } else if (!focused.composition) {
          acted = true;
          const text = focused.value;
          const spots = [0, ...characters(text).map(({ end }) => end)];
          const at = pick(spots);
          const way = next();
          if (way < 1 / 3) {
            steps.push(`the page adds "Z" at ${at}`);
            focused.value = text.slice(0, at) + "Z" + text.slice(at);
            if (focused.caret >= at) focused.caret += 1;
          } else if (way < 2 / 3 && at > 0) {
            const from = spots[spots.indexOf(at) - 1]!;
            steps.push(`the page deletes ${from} to ${at}`);
            focused.value = text.slice(0, from) + text.slice(at);
            focused.caret =
              focused.caret >= at
                ? focused.caret - (at - from)
                : focused.caret > from
                  ? from
                  : focused.caret;
          } else {
            steps.push(`the page moves its caret to ${at}`);
            focused.caret = at;
          }
          // The page rewrote the field: a new context for it, the old one an earlier one.
          const id = fresh();
          if (focused.contextId !== null) focused.earlier.add(focused.contextId);
          focused.contextId = id;
          await opened.publish(id);
        }
      }
      const boundaries = [0, ...characters(run.native.text).map(({ end }) => end)];
      let choice = next();
      composing = oracle.person.marked !== null;
      if (composing && !(choice < 0.22 || (choice >= 0.4 && choice < 0.45) || choice >= 0.65))
        choice = next() < 0.5 ? 0.1 : 0.67;
      if (composing && choice >= 0.73 && choice < 0.78) choice = 0.9;
      if (choice < 0.22) {
        const letter = pick(letters);
        if (!composing) typed.push(letter);
        await run.insertText(letter);
      } else if (choice < 0.32) {
        if (!display) {
          const letter = pick(letters);
          if (!composing) typed.push(letter);
          await run.type(letter);
        }
      } else if (choice < 0.4) await run.backspace();
      else if (choice < 0.45 && composing) {
        const marked = oracle.person.marked;
        const text = marked ? oracle.person.text.slice(marked.start, marked.end) : "";
        const way = next();
        if (way < 1 / 3) await run.setMarkedText("");
        else if (way < 2 / 3 && characters(text).length > 1)
          await run.setMarkedText(text.slice(0, characters(text).at(-2)!.end));
        else await run.deleteBackward();
      } else if (choice < 0.45) await run.deleteBackward();
      else if (choice < 0.54) await run.moveSelection(pick(boundaries));
      else if (choice < 0.58) {
        const [start, end] = [pick(boundaries), pick(boundaries)].sort((x, y) => x - y);
        if (!display && !acted) await run.moveSelection(start!, end!);
      } else if (choice < 0.62) {
        const [start, end] = [pick(boundaries), pick(boundaries)].sort((x, y) => x - y);
        const word = pick(["the", "ab", "é"]);
        if (!display && !acted) await run.replaceRange(start!, end!, word);
      } else if (choice < 0.65) {
        const text = pick(["pasted", "א b"]);
        typed.push(text);
        await run.paste(text);
      } else if (choice < 0.7) await run.setMarkedText(pick(["に", "日本"]));
      else if (choice < 0.73) await run.unmarkText();
      else if (choice < 0.78) await run.answer(1);
      else await run.answer(1 + Math.floor(next() * 3));
    }
    while (harness.answers.length > 0) await opened.answerAll();
    const last = segments.at(-1)!;
    last.end = last.field.value;
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
      return shown(p);
    };
    let failure: string | null = null;
    const said = (text: string) => JSON.stringify(escape(text));
    if (which === "B") {
      for (const [index, segment] of segments.entries()) {
        const all = replay(segment, segment.actions.length);
        const ok =
          index === segments.length - 1
            ? segment.end === all
            : Array.from({ length: segment.actions.length + 1 }, (_, count) =>
                replay(segment, count),
              ).includes(segment.end!);
        if (!ok) {
          failure = `segment ${index + 1} of ${segments.length} (${index === segments.length - 1 ? "the field arrived in: exactly" : "a field left: a prefix"}): the field holds ${said(segment.end!)}, the person did ${said(all)} from ${said(segment.start.text)} at ${segment.start.caret}`;
          break;
        }
      }
    } else {
      // What the page took, in order: the insertions and pastes it did not refuse. Everything
      // the person typed or pasted is among them, in the order they did it.
      const fields = [opened.remote, ...segments.map((segment) => segment.field)].filter(
        (field, index, all) => all.indexOf(field) === index,
      );
      const taken = fields
        .flatMap((field) => field.sent.filter((operation) => !field.refused.includes(operation)))
        .map((operation) =>
          operation.kind === "edit" && !operation.edit.before && !operation.edit.after
            ? operation.edit.text
            : operation.kind === "paste"
              ? new TextDecoder().decode(
                  operation.items.find((item) => item.type === "text/plain")?.bytes,
                )
              : "",
        )
        .join("");
      let at = 0;
      for (const unit of typed.join("")) {
        at = taken.indexOf(unit, at);
        if (at < 0) break;
        at += unit.length;
      }
      if (at < 0)
        failure = `typed text missing from what the page took: typed ${said(typed.join(""))}, the page took ${said(taken)} and holds ${said(last.field.value)}`;
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
      // How much the page did: contexts it published, and operations it refused.
      changes: segments.length - 1,
      refused: [opened.remote, ...segments.map((segment) => segment.field)]
        .filter((field, index, all) => all.indexOf(field) === index)
        .reduce((sum, field) => sum + field.refused.length, 0),
    };
  }
  // Regimes B and C over OPENSTEER_TYPING_REGIME_RUNS sequences each (100 by default), 100 to a
  // test, counted per target. OPENSTEER_TYPING_FUZZ_REPORT appends each failure, and each
  // chunk's tally, to that file.
  const regimeRuns = Number(process.env.OPENSTEER_TYPING_REGIME_RUNS ?? 100);
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
