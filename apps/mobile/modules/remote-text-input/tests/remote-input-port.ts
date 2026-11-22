import type { EditingOperation, EditingProxyInstruction } from "@opensteer/client/editing";

/*
 * A TypeScript port of ios/Core/RemoteInputEdits.swift (Edits), RemoteInputGate.swift and
 * RemoteInputTextView.swift (NativeField), for the JavaScript adapter's tests. Keep it in step with
 * them. The arithmetic (Edits) cannot drift unnoticed: ios/Tests/Cases/remote-input-edits.json is
 * run against both (edits-cases.test.ts and RemoteInputEditsCasesTests.swift). NativeField mirrors
 * the view's UIKit entry points (insertText, the delegate's shouldChangeTextIn, replace,
 * deleteBackward, setMarkedText, unmarkText, paste and the selection callback) with UIKit's own
 * effects as UITextView has them on Mac Catalyst: nothing checks that half against the Swift but
 * review, and the view's own tests (RemoteTextInputTests.swift) are the truth for it.
 */

export interface Place {
  revision: number;
  order: number;
  start: number;
  end: number;
}
interface Edit {
  start: number;
  removed: number;
  inserted: number;
}
export interface Span {
  start: number;
  end: number;
}

/** The composed characters (grapheme clusters) of `text`, as UTF-16 spans. */
export function characters(text: string): Span[] {
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(
    ({ index, segment }) => ({ start: index, end: index + segment.length }),
  );
}
/** NSString.rangeOfComposedCharacterSequence(at:). */
function characterAt(text: string, offset: number): Span {
  return (
    characters(text).find(({ start, end }) => offset >= start && offset < end) ?? {
      start: offset,
      end: offset,
    }
  );
}

/** RemoteInputEdits.swift. */
export class Edits {
  private edits: Edit[] = [];
  private base = 0;
  private named = 0;
  private chosen: Place | null = null;
  get revision() {
    return this.base + this.edits.length;
  }
  place(start: number, end: number): Place {
    this.named += 1;
    return { revision: this.revision, order: this.named, start, end };
  }
  choose(selection: Place) {
    this.chosen = selection;
  }
  chosenAfter(place: Place): Place | null {
    return this.chosen && this.chosen.order > place.order ? this.chosen : null;
  }
  record(start: number, removed: number, inserted: number) {
    this.edits.push({
      start: Math.max(0, start),
      removed: Math.max(0, removed),
      inserted: Math.max(0, inserted),
    });
  }
  current(place: Place, length: number): Span {
    let { start, end } = place;
    const caret = start === end;
    if (place.revision >= this.base) {
      for (const edit of this.edits.slice(place.revision - this.base)) {
        start = Edits.move(start, edit, false);
        end = Edits.move(end, edit, !caret);
      }
    }
    start = Math.min(Math.max(0, start), length);
    end = Math.min(Math.max(start, end), length);
    return { start, end };
  }
  /** One composed character, exactly, ending at a collapsed selection. */
  static isBackspace(named: Span, selection: Span, text: string): boolean {
    if (
      selection.start !== selection.end ||
      named.end <= named.start ||
      named.end !== selection.start
    )
      return false;
    const covering = characters(text).filter(
      ({ start, end }) => start < named.end && end > named.start,
    );
    return (
      covering.length === 1 && covering[0]!.start === named.start && covering[0]!.end === named.end
    );
  }
  static deletesSelection(named: Span, selection: Span): boolean {
    return (
      selection.end > selection.start &&
      named.start === selection.start &&
      named.end === selection.end
    );
  }
  static composedCount(text: string, range: Span): number {
    if (range.start < 0 || range.end < range.start || range.end > text.length) return 0;
    return characters(text).filter(({ start, end }) => start < range.end && end > range.start)
      .length;
  }
  backspace(caret: Place, text: string): Span {
    const at = this.current(caret, text.length).start;
    return at > 0 ? { start: characterAt(text, at - 1).start, end: at } : { start: at, end: at };
  }
  static deletedStart(selection: Span, removed: number, marked: Span | null = null): number {
    if (marked) return Math.max(marked.start, marked.end - removed);
    return selection.end > selection.start
      ? selection.start
      : Math.max(0, selection.start - removed);
  }
  deletion(place: Place, text: string): Span {
    const current = this.current(place, text.length);
    if (current.end > current.start || place.end === place.start) return current;
    if (current.start === 0) return { start: 0, end: 0 };
    return { start: characterAt(text, current.start - 1).start, end: current.start };
  }
  settle() {
    this.base = this.revision;
    this.edits = [];
    this.chosen = null;
  }
  private static move(offset: number, edit: Edit, before: boolean): number {
    if (offset < edit.start || (before && offset === edit.start)) return offset;
    if (offset >= edit.start + edit.removed) return offset - edit.removed + edit.inserted;
    return edit.start + edit.inserted;
  }
}

export interface Packet {
  id: number;
  contextId?: string;
  event: Record<string, unknown>;
}
export type Answer = EditingProxyInstruction & { id: number };
export interface Proxy {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  markedRange?: { start: number; end: number };
}

/** RemoteInputGate.swift and RemoteInputTextView.swift, with UITextView's own effects. */
export class NativeField {
  // RemoteInputGate.swift
  private jobs: { run: () => void; report: boolean }[] = [];
  private next = 0;
  private waiting: [number, () => void] | null = null;
  private running = false;
  private insertion = 0;
  contextId: string | null = null;
  // RemoteInputTextView.swift
  readonly edits = new Edits();
  text = "";
  selection: Span = { start: 0, end: 0 };
  marked: Span | null = null;
  private mutating = false;
  /** The selection the view itself last left (RemoteInputTextView.ownSelection). */
  private ownSelection: Span | null = null;

  private readonly deliver: (packet: Packet) => void;
  constructor(deliver: (packet: Packet) => void) {
    this.deliver = deliver;
  }

  get queued() {
    return this.jobs.length;
  }
  private enqueue(job: () => void) {
    this.add(job, false);
  }
  private report(job: () => void) {
    this.add(job, true);
  }
  private add(run: () => void, report: boolean) {
    const last = this.running ? this.insertion - 1 : this.jobs.length - 1;
    if (report && last >= 0 && last < this.jobs.length && this.jobs[last]!.report)
      this.jobs[last] = { run, report };
    else if (this.running) this.jobs.splice(this.insertion++, 0, { run, report });
    else this.jobs.push({ run, report });
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
      this.jobs.shift()!.run();
      this.running = false;
    }
    if (this.waiting === null && this.jobs.length === 0) this.edits.settle();
  }

  // The view.
  private place(span: Span): Place {
    return this.edits.place(span.start, span.end);
  }
  private range(place: Place): Span {
    return this.edits.current(place, this.text.length);
  }
  private select(place: Place): Span {
    if (this.marked) return { ...this.marked };
    const target = this.range(place);
    this.selection = { ...target };
    return target;
  }
  snapshot(selection: Span = this.selection): Proxy {
    return {
      value: this.text,
      selectionStart: selection.start,
      selectionEnd: selection.end,
      ...(this.marked ? { markedRange: { ...this.marked } } : {}),
    };
  }
  /** UITextView's own replacement: the caret ends after the new text. */
  private replace(target: Span, text: string) {
    const before = this.text.length;
    this.text = this.text.slice(0, target.start) + text + this.text.slice(target.end);
    const removed = target.end - target.start;
    this.edits.record(target.start, removed, this.text.length - before + removed);
    this.selection = { start: target.start + text.length, end: target.start + text.length };
  }
  private apply(instruction: Answer) {
    const set = instruction.set;
    if (this.marked || !set) return;
    this.mutating = true;
    this.replace({ start: 0, end: this.text.length }, set.value);
    this.selection = { start: set.selectionStart, end: set.selectionEnd };
    this.ownSelection = { ...this.selection };
    this.mutating = false;
  }
  private keepChosen(typed: Place | null) {
    if (!typed || this.marked) return;
    const chosen = this.edits.chosenAfter(typed);
    if (chosen) this.selection = this.range(chosen);
  }
  private change(
    named: string | (() => string),
    data: string | null,
    typed: Place | null,
    action: () => void,
  ) {
    this.enqueue(() => {
      const inputType = typeof named === "string" ? named : named();
      this.event({ type: "beforeinput", inputType, data }, () => {
        const wasComposing = this.marked !== null;
        this.mutating = true;
        action();
        // The state right after this edit, before the chosen selection is put back.
        const composing = this.marked !== null;
        const proxy = this.snapshot();
        const marked = this.marked ? this.text.slice(this.marked.start, this.marked.end) : "";
        this.keepChosen(typed);
        this.ownSelection = { ...this.selection };
        this.mutating = false;
        if (!wasComposing && composing) this.notify({ type: "compositionstart", proxy });
        if (composing) this.notify({ type: "compositionupdate", data: marked, proxy });
        if (wasComposing && !composing)
          this.notify({ type: "compositionend", data: data ?? "", proxy });
        this.notify({ type: "input", inputType, composing, proxy });
      });
    });
  }

  // What UIKit calls, naming places in the text as it stands at that moment.

  insertText(text: string) {
    const typed = this.place(this.selection);
    // Named when its turn comes, as the field then stands (RemoteInputTextView.change).
    const inputType = () =>
      this.marked ? "insertFromComposition" : text === "\n" ? "insertLineBreak" : "insertText";
    this.change(inputType, text, typed, () => {
      this.replace(this.select(typed), text);
      this.marked = null;
    });
  }
  /** textView(_:shouldChangeTextIn:replacementText:). */
  shouldChangeText(named: Span, replacement: string) {
    if (replacement === "" && Edits.isBackspace(named, this.selection, this.text)) {
      const caret = this.place(this.selection);
      this.change("deleteContentBackward", replacement, caret, () =>
        this.replace(this.edits.backspace(caret, this.text), ""),
      );
      return;
    }
    const again = replacement === "" && Edits.deletesSelection(named, this.selection);
    const typed = this.place(named);
    this.change(
      replacement ? "insertReplacementText" : "deleteContentBackward",
      replacement,
      typed,
      () =>
        this.replace(
          again ? this.edits.deletion(typed, this.text) : this.range(typed),
          replacement,
        ),
    );
  }
  /** A keystroke over the selection, through the delegate. */
  type(replacement: string) {
    this.shouldChangeText(this.selection, replacement);
  }
  /** A Backspace as UIKit asks the delegate: the composed character before the caret, or the selection. */
  backspace() {
    const { start, end } = this.selection;
    if (end === 0) return;
    this.shouldChangeText(
      start < end ? this.selection : { start: characterAt(this.text, end - 1).start, end },
      "",
    );
  }
  /** replace(_:withText:): never a deletion of a neighbour when what it named is gone. */
  replaceRange(start: number, end: number, replacement: string) {
    const typed = this.place({ start, end });
    this.change("insertReplacementText", replacement, typed, () =>
      this.replace(this.range(typed), replacement),
    );
  }
  deleteBackward() {
    const typed = this.place(this.selection);
    this.change("deleteContentBackward", null, typed, () => {
      this.select(typed);
      const selection = { ...this.selection };
      const marked = this.marked ? { ...this.marked } : null;
      const before = this.text.length;
      // UITextView without an input method: the marked text, the selection, or the composed
      // character before the caret.
      const target = this.marked
        ? { ...this.marked }
        : selection.end > selection.start
          ? selection
          : selection.start > 0
            ? { start: characterAt(this.text, selection.start - 1).start, end: selection.start }
            : selection;
      this.text = this.text.slice(0, target.start) + this.text.slice(target.end);
      this.marked = null;
      this.selection = { start: target.start, end: target.start };
      const removed = before - this.text.length;
      this.edits.record(Edits.deletedStart(selection, removed, marked), removed, 0);
    });
  }
  setMarkedText(text: string) {
    const typed = this.place(this.selection);
    this.change("insertCompositionText", text, typed, () => {
      const target = this.select(typed);
      this.replace(target, text);
      this.marked = text ? { start: target.start, end: target.start + text.length } : null;
    });
  }
  unmarkText() {
    this.enqueue(() => {
      if (!this.marked) return;
      const data = this.text.slice(this.marked.start, this.marked.end);
      this.marked = null;
      this.ownSelection = { ...this.selection };
      this.notify({ type: "compositionend", data, proxy: this.snapshot() });
    });
  }
  /**
   * RemoteInputTextView.configure with a new context: the composition ends under the old one,
   * then the field is cleared for the new one, each in its turn.
   */
  configure(contextId: string | null) {
    this.enqueue(() => {
      if (contextId === this.contextId) return;
      if (this.marked) {
        const data = this.text.slice(this.marked.start, this.marked.end);
        this.marked = null;
        this.notify({ type: "compositionend", data, proxy: this.snapshot() });
      }
      this.enqueue(() => {
        this.contextId = contextId;
        this.mutating = true;
        this.replace({ start: 0, end: this.text.length }, "");
        this.selection = { start: 0, end: 0 };
        this.ownSelection = { ...this.selection };
        this.mutating = false;
      });
    });
  }
  paste(text: string) {
    this.enqueue(() => {
      const data = Buffer.from(text, "utf8").toString("base64");
      this.notify({ type: "paste", items: [{ type: "text/plain", data }] });
    });
  }
  /** UIKit or the person moves the selection, then UIKit tells the delegate. */
  moveSelection(start: number, end = start) {
    this.selection = { start, end };
    const own = this.ownSelection;
    if (this.mutating || (own !== null && own.start === start && own.end === end)) return;
    this.ownSelection = null;
    const moved = this.place(this.selection);
    this.edits.choose(moved);
    this.report(() => this.event({ type: "selection", proxy: this.snapshot(this.range(moved)) }));
  }
}

/**
 * The far side: a page's text field as packages/browser-runtime-core's editing observer applies
 * operations to it (PageEditingObserver.edit and editingOwner.prepare, the control path, and
 * the controller's commands). An operation under any but the current context is refused; an
 * edit, or a first composition, is taken only where the field's own text matches its `before`
 * and `after` around a collapsed caret, and replaces exactly that span. A refusal rotates the
 * context, as #stale() does: the app learns it from the new context, not from the send. A caret
 * command moves by one grapheme and a deletion command deletes one, as Blink's do. Paste inserts
 * at the caret. tests/editing-far-model.test.ts holds this model to the real applier in Chromium.
 */
export class FarField {
  value = "";
  caret = 0;
  composition: Span | null = null;
  /** The field's context; null takes any (a test that does not rotate). */
  contextId: string | null = null;
  /** Told the new context after a refusal, as the page publishes it. */
  onRotate: ((contextId: string) => void) | null = null;
  refused: EditingOperation[] = [];
  /** Refused because the text did not match its before and after: always a fault upstream. */
  mismatched: EditingOperation[] = [];
  /** Every operation the field was sent, in order. */
  sent: EditingOperation[] = [];
  private rotations = 0;
  private refuse(operation: EditingOperation) {
    this.refused.push(operation);
    this.composition = null;
    this.rotations += 1;
    this.contextId = `00000000-0000-4000-8000-${String(100000000000 + this.rotations).slice(-12)}`;
    this.onRotate?.(this.contextId);
  }
  private replace(start: number, end: number, text: string) {
    this.value = this.value.slice(0, start) + text + this.value.slice(end);
    this.caret = start + text.length;
  }
  take = (operation: EditingOperation): boolean => {
    this.sent.push(operation);
    const context =
      operation.kind === "edit"
        ? operation.edit.contextId
        : operation.kind === "compose"
          ? operation.composition.contextId
          : null;
    if (context !== null && this.contextId !== null && context !== this.contextId) {
      this.refuse(operation);
      return true;
    }
    switch (operation.kind) {
      case "edit":
      case "compose": {
        const change = operation.kind === "edit" ? operation.edit : operation.composition;
        const { before = "", after = "", text } = change;
        const range = this.composition ?? {
          start: this.caret - before.length,
          end: this.caret + after.length,
        };
        if (
          !this.composition &&
          (range.start < 0 ||
            this.value.slice(range.start, this.caret) !== before ||
            this.value.slice(this.caret, range.end) !== after)
        ) {
          this.mismatched.push(operation);
          this.refuse(operation);
          return true;
        }
        if (operation.kind === "compose") {
          this.replace(range.start, range.end, text);
          this.composition = text ? { start: range.start, end: range.start + text.length } : null;
          const at = Math.min(Math.max(0, operation.composition.selectionEnd), text.length);
          this.caret = range.start + at;
        } else if (text || range.end > range.start) {
          this.replace(range.start, range.end, text);
          this.composition = null;
        } else this.deleteBackward();
        return true;
      }
      case "command":
        if (operation.command === "moveBackward")
          this.caret = this.caret > 0 ? characterAt(this.value, this.caret - 1).start : 0;
        else if (operation.command === "moveForward")
          this.caret =
            this.caret < this.value.length ? characterAt(this.value, this.caret).end : this.caret;
        else if (operation.command === "deleteBackward") this.deleteBackward();
        else if (operation.command === "deleteForward" && this.caret < this.value.length)
          this.replace(this.caret, characterAt(this.value, this.caret).end, "");
        return true;
      case "paste": {
        const item = operation.items.find((candidate) => candidate.type === "text/plain");
        const text = item ? new TextDecoder().decode(item.bytes) : "";
        this.replace(this.caret, this.caret, text);
        return true;
      }
      default:
        return true;
    }
  };
  /**
   * Blink's Backspace: a base with combining marks loses its last mark (e + U+0301 becomes e),
   * anything else its whole grapheme (an emoji sequence, a flag, a precomposed letter).
   */
  private deleteBackward() {
    if (this.caret === 0) return;
    const character = characterAt(this.value, this.caret - 1);
    const text = this.value.slice(character.start, this.caret);
    const points = [...text];
    const last = points.at(-1)!;
    const start =
      points.length > 1 && /\p{M}/u.test(last) ? this.caret - last.length : character.start;
    this.replace(start, this.caret, "");
  }
}
