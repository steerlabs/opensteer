// @vitest-environment happy-dom
import { act, useImperativeHandle } from "react";
import type { EditingOperation, EditingProxyInstruction } from "@opensteer/client/editing";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * Text typed into a remote page arrives in the order typed, at any speed. The walk typed
 * 0123456789 fast and the target received 1023456789: UIKit names a keystroke's place in the text
 * as it stands when it calls, while the keystrokes before it still wait for JavaScript's answer.
 *
 * The native view here is RemoteInputGate.swift and RemoteInputTextView.swift as they behave,
 * ported: every default waits for its numbered answer, the answers arrive only when the test lets
 * them, late and out of step with the keystrokes, and the keyboard names places in the text as it
 * stands at the moment it types.
 *
 * Keep this port in step with ios/Core/RemoteInputGate.swift, RemoteInputTextView.swift and
 * RemoteInputEdits.swift: nothing checks one against the other.
 */

interface Packet {
  id: number;
  contextId?: string;
  event: Record<string, unknown>;
}
type Answer = EditingProxyInstruction & { id: number };

interface Proxy {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  markedRange?: { start: number; end: number };
}

/** RemoteInputEdits.swift: a place named in the text after `revision` edits. */
interface Place {
  revision: number;
  start: number;
  end: number;
}

class NativeField {
  // RemoteInputGate.swift
  private jobs: (() => void)[] = [];
  private next = 0;
  private waiting: [number, () => void] | null = null;
  private running = false;
  private insertion = 0;
  contextId: string | null = null;
  // RemoteInputTextView.swift
  text = "";
  selection = { start: 0, end: 0 };
  marked: { start: number; end: number } | null = null;
  private mutating = false;
  // RemoteInputEdits.swift
  private edits: { start: number; removed: number; inserted: number }[] = [];
  private base = 0;

  constructor(private readonly deliver: (packet: Packet) => void) {}

  // The gate, line for line.
  private enqueue(job: () => void) {
    if (this.running) this.jobs.splice(this.insertion++, 0, job);
    else this.jobs.push(job);
    this.drain();
  }
  private event(event: Record<string, unknown>, action: () => void = () => undefined) {
    this.next += 1;
    this.waiting = [this.next, action];
    this.deliver({
      id: this.next,
      ...(this.contextId === null ? {} : { contextId: this.contextId }),
      event,
    });
  }
  private notify(event: Record<string, unknown>) {
    this.enqueue(() => this.event(event));
  }
  respond(instruction: Answer) {
    if (instruction.id === 0) {
      this.apply(instruction);
      return;
    }
    const current = this.waiting;
    if (current === null || instruction.id !== current[0]) return;
    this.waiting = null;
    this.running = true;
    this.insertion = 0;
    if (instruction.preventDefault !== true) current[1]();
    this.apply(instruction);
    this.running = false;
    this.drain();
  }
  private drain() {
    if (this.running) return;
    while (this.waiting === null && this.jobs.length > 0) {
      this.running = true;
      this.insertion = 0;
      this.jobs.shift()!();
      this.running = false;
    }
    if (this.waiting === null && this.jobs.length === 0) this.settle();
  }

  // The edits, as RemoteInputEdits.swift moves a place.
  private get revision() {
    return this.base + this.edits.length;
  }
  private settle() {
    this.base = this.revision;
    this.edits = [];
  }
  private place(start: number, end: number): Place {
    return { revision: this.revision, start, end };
  }
  private current(place: Place): { start: number; end: number } {
    let { start, end } = place;
    if (place.revision >= this.base) {
      const caret = start === end;
      const move = (offset: number, before: boolean, edit: (typeof this.edits)[number]) => {
        if (offset < edit.start || (before && offset === edit.start)) return offset;
        if (offset >= edit.start + edit.removed) return offset - edit.removed + edit.inserted;
        return edit.start + edit.inserted;
      };
      for (const edit of this.edits.slice(place.revision - this.base)) {
        start = move(start, false, edit);
        end = move(end, !caret, edit);
      }
    }
    start = Math.min(Math.max(0, start), this.text.length);
    end = Math.min(Math.max(start, end), this.text.length);
    return { start, end };
  }
  private replace(start: number, end: number, text: string) {
    const before = this.text.length;
    this.text = this.text.slice(0, start) + text + this.text.slice(end);
    this.edits.push({
      start,
      removed: end - start,
      inserted: this.text.length - before + end - start,
    });
  }
  /** RemoteInputTextView.select: the marked text while there is some, else the place named. */
  private select(place: Place) {
    if (this.marked) return { ...this.marked };
    const target = this.current(place);
    this.selection = { ...target };
    return target;
  }
  snapshot(): Proxy {
    return {
      value: this.text,
      selectionStart: this.selection.start,
      selectionEnd: this.selection.end,
      ...(this.marked ? { markedRange: { ...this.marked } } : {}),
    };
  }
  private apply(instruction: Answer) {
    const set = instruction.set;
    if (this.marked || !set) return;
    this.mutating = true;
    this.replace(0, this.text.length, set.value);
    this.selection = { start: set.selectionStart, end: set.selectionEnd };
    this.mutating = false;
  }
  private change(inputType: string, data: string | null, action: () => void) {
    this.enqueue(() =>
      this.event({ type: "beforeinput", inputType, data }, () => {
        const wasComposing = this.marked !== null;
        this.mutating = true;
        action();
        this.mutating = false;
        const composing = this.marked !== null;
        if (!wasComposing && composing)
          this.notify({ type: "compositionstart", proxy: this.snapshot() });
        if (composing)
          this.notify({
            type: "compositionupdate",
            data: this.text.slice(this.marked!.start, this.marked!.end),
            proxy: this.snapshot(),
          });
        if (wasComposing && !composing)
          this.notify({ type: "compositionend", data: data ?? "", proxy: this.snapshot() });
        this.notify({ type: "input", inputType, composing, proxy: this.snapshot() });
      }),
    );
  }

  // What UIKit calls, naming places in the text as it stands at that moment.

  /** textView(_:shouldChangeTextIn:replacementText:) over the selection: a keystroke. */
  type(replacement: string) {
    const typed = this.place(this.selection.start, this.selection.end);
    this.change(
      replacement ? "insertReplacementText" : "deleteContentBackward",
      replacement,
      () => {
        const target = this.current(typed);
        if (target.end > this.text.length) return;
        this.replace(target.start, target.end, replacement);
        this.selection = {
          start: target.start + replacement.length,
          end: target.start + replacement.length,
        };
      },
    );
  }
  /**
   * RemoteInputEdits.deletion: the place, until an earlier deletion took its text; then the
   * character before where it now stands.
   */
  private deletion(place: Place): { start: number; end: number } {
    const current = this.current(place);
    if (current.end > current.start || place.end === place.start) return current;
    if (current.start === 0) return { start: 0, end: 0 };
    return { start: previousCharacter(this.text, current.start), end: current.start };
  }
  /**
   * A backspace as UIKit asks the delegate for it: the character before the caret (or the
   * selection), named in the text as it stands now. UIKit asks nothing where it sees nothing.
   */
  backspace() {
    const { start, end } = this.selection;
    if (end === 0) return;
    const from = start < end ? start : previousCharacter(this.text, end);
    const typed = this.place(from, end);
    this.change("deleteContentBackward", "", () => {
      const target = this.deletion(typed);
      this.replace(target.start, target.end, "");
      this.selection = { start: target.start, end: target.start };
    });
  }
  /** replace(_:withText:): UIKit replaces a range it names, as autocorrect does. */
  replaceRange(start: number, end: number, replacement: string) {
    const typed = this.place(start, end);
    this.change("insertReplacementText", replacement, () => {
      const target = this.current(typed);
      this.replace(target.start, target.end, replacement);
    });
  }
  deleteBackward() {
    const typed = this.place(this.selection.start, this.selection.end);
    this.change("deleteContentBackward", null, () => {
      const target = this.select(typed);
      const start = target.end > target.start ? target.start : Math.max(0, target.start - 1);
      this.replace(start, target.end, "");
      this.selection = { start, end: start };
    });
  }
  setMarkedText(text: string) {
    const typed = this.place(this.selection.start, this.selection.end);
    this.change("insertCompositionText", text, () => {
      const target = this.select(typed);
      this.replace(target.start, target.end, text);
      this.marked = { start: target.start, end: target.start + text.length };
      this.selection = { start: this.marked.end, end: this.marked.end };
    });
  }
  unmarkText() {
    this.enqueue(() => {
      if (!this.marked) return;
      const data = this.text.slice(this.marked.start, this.marked.end);
      this.marked = null;
      this.notify({ type: "compositionend", data, proxy: this.snapshot() });
    });
  }
  paste(text: string) {
    this.enqueue(() => {
      const data = Buffer.from(text, "utf8").toString("base64");
      this.notify({ type: "paste", items: [{ type: "text/plain", data }] });
    });
  }
}

/** Where the composed character before `offset` starts (NSString.rangeOfComposedCharacterSequence). */
function previousCharacter(text: string, offset: number): number {
  let start = 0;
  for (const { index } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
    text.slice(0, offset),
  ))
    start = index;
  return start;
}

/** The remote field: it takes an edit only where its own text says it goes. */
class RemoteField {
  value = "";
  caret = 0;
  composition: { start: number; end: number } | null = null;
  refused: EditingOperation[] = [];
  take = (operation: EditingOperation): boolean => {
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

async function open() {
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
      <NativeEditingProxy context={context} sendOperation={remote.take} onDone={() => undefined} />,
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
