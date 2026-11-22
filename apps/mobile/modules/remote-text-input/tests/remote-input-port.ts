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
  /** The mirror it was named in (Edits.generation). */
  generation: number;
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
/** Signed grapheme count from `from` to `to` in `text`. */
function graphemesBetween(text: string, from: number, to: number): number {
  const count = characters(text.slice(Math.min(from, to), Math.max(from, to))).length;
  return to < from ? -count : count;
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
  /** The mirror's generation: every clear of the field begins a new one. */
  private generation = 0;
  /** The places a new context fenced out: every one named before the call that changed it. */
  private fence = 0;
  /** How many places have been named: a fence is drawn at the call that changes the context. */
  get order() {
    return this.named;
  }
  get revision() {
    return this.base + this.edits.length;
  }
  place(start: number, end: number): Place {
    this.named += 1;
    return { revision: this.revision, order: this.named, start, end, generation: this.generation };
  }
  /** The field was cleared: a new mirror. */
  clear() {
    this.generation += 1;
  }
  /** A new context: every place named so far is fenced out, from this call on. */
  fenceNow() {
    this.fence = this.named;
  }
  /** Named in an older mirror: it names nothing in this one. */
  stale(place: Place): boolean {
    return place.generation < this.generation;
  }
  /** Named under an older context: dropped with it, whatever it is. */
  fenced(place: Place): boolean {
    return place.order <= this.fence;
  }
  choose(selection: Place) {
    this.chosen = selection;
  }
  chosenAfter(place: Place): Place | null {
    return this.chosen && this.chosen.order > place.order && !this.stale(this.chosen)
      ? this.chosen
      : null;
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
    if (marked) {
      // A caret inside the marked text deletes before itself; anywhere else (moved away while
      // the deletion waited) the deletion is at the marked text's end.
      const inside =
        selection.start === selection.end &&
        selection.start > marked.start &&
        selection.start <= marked.end;
      return Math.max(marked.start, (inside ? selection.start : marked.end) - removed);
    }
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
  private waiting: [number, () => void, boolean] | null = null;
  private running = false;
  private insertion = 0;
  contextId: string | null = null;
  /** The context the last configure call asked for, ahead of its turn. */
  private pendingContext: string | null = null;
  // RemoteInputTextView.swift
  readonly edits = new Edits();
  text = "";
  selection: Span = { start: 0, end: 0 };
  marked: Span | null = null;
  private mutating = false;
  /** The selection the view itself last left (RemoteInputTextView.ownSelection). */
  private ownSelection: Span | null = null;
  /**
   * The selection the person chose after an edit that has since been applied inside a
   * composition (RemoteInputTextView.held): UIKit's selection is in the composition until it
   * ends, the person's is here, and what they type meanwhile is named here.
   */
  private held: Place | null = null;
  /** The caret's moves since the last report ran, in graphemes; none once a range is chosen. */
  private distance: number | undefined = 0;
  /**
   * For the typing test's oracle: told when a call's job takes its turn ("action", answered or
   * prevented), when a selection report runs ("report"), when an answer clears the field
   * ("reset") and when a new context clears it ("context"). Nothing in the view depends on it.
   */
  onTurn:
    | ((
        turn: "action" | "report" | "reset" | "context" | "finish" | "dropped" | "dropped-report",
      ) => void)
    | null = null;

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
  private event(
    event: Record<string, unknown>,
    action: () => void = () => undefined,
    turn = false,
  ) {
    this.next += 1;
    this.waiting = [this.next, action, turn];
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
    if (current[2]) this.onTurn?.("action");
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
    if (this.waiting === null && this.jobs.length === 0) {
      this.edits.settle();
      this.held = null;
    }
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
    // Typing and deleting backward are relative to the caret: named in an older mirror, they go
    // where the caret is now.
    if (this.edits.stale(place)) return { ...this.selection };
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
  /**
   * A replacement the view applies. The selection is carried over it (RemoteInputTextView.edit):
   * at the caret that is where UIKit leaves it (after typed text, at a deletion's start, after a
   * selection typed over); a replacement elsewhere (autocorrect, a mark UIKit names for
   * deletion) leaves the person's caret where it was, where UIKit would move it to the
   * replacement.
   */
  private replace(target: Span, text: string) {
    const kept = this.place(this.selection);
    const before = this.text.length;
    this.text = this.text.slice(0, target.start) + text + this.text.slice(target.end);
    const removed = target.end - target.start;
    this.edits.record(target.start, removed, this.text.length - before + removed);
    this.selection = this.range(kept);
  }
  /**
   * An answer's text, applied as the edit it is (RemoteInputTextView.apply): a paste is the
   * pasted text where it went, so the places still waiting are carried over it. An empty answer
   * clears the mirror: a new generation, in which no place named before names anything.
   */
  private apply(instruction: Answer) {
    const set = instruction.set;
    if (this.marked || !set) return;
    this.mutating = true;
    let start = 0;
    while (
      start < this.text.length &&
      start < set.value.length &&
      this.text[start] === set.value[start]
    )
      start++;
    let end = 0;
    while (
      end < this.text.length - start &&
      end < set.value.length - start &&
      this.text[this.text.length - 1 - end] === set.value[set.value.length - 1 - end]
    )
      end++;
    this.replace(
      { start, end: this.text.length - end },
      set.value.slice(start, set.value.length - end),
    );
    const cleared = set.value === "";
    if (cleared) this.edits.clear();
    this.selection = { start: set.selectionStart, end: set.selectionEnd };
    this.ownSelection = { ...this.selection };
    this.held = null;
    this.mutating = false;
    if (cleared) this.onTurn?.("reset");
  }
  /**
   * Nothing is applied across a reset. A place named in an older mirror is never applied to a
   * newer one: a positional place (a caret moved, a range replaced, a mark deleted) is dropped;
   * typing and deleting backward go where the caret is now, unless a new context fenced them out.
   */
  private dropped(place: Place, positional: boolean): boolean {
    if (!this.edits.fenced(place) && !(positional && this.edits.stale(place))) return false;
    this.onTurn?.("dropped");
    return true;
  }
  private keepChosen(typed: Place | null) {
    if (!typed) return;
    const chosen = this.edits.chosenAfter(typed);
    // Inside a composition UIKit's selection stays in it; the person's choice is held for what
    // they type meanwhile, and put back once the composition ends.
    if (this.marked) {
      if (chosen) this.held = chosen;
      return;
    }
    this.held = null;
    if (chosen) this.selection = this.range(chosen);
  }
  /** Where the person's selection is: the one held while a composition hides it, or UIKit's. */
  private personSelection(): Span {
    return this.held && !this.edits.stale(this.held) ? this.range(this.held) : this.selection;
  }
  private change(
    named: string | (() => string),
    data: string | null,
    typed: Place | null,
    action: () => void,
  ) {
    this.enqueue(() => {
      const inputType = typeof named === "string" ? named : named();
      this.event(
        { type: "beforeinput", inputType, data },
        () => {
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
        },
        true,
      );
    });
  }

  // What UIKit calls, naming places in the text as it stands at that moment.

  insertText(text: string) {
    const typed = this.place(this.personSelection());
    // Named when its turn comes, as the field then stands (RemoteInputTextView.change).
    const inputType = () =>
      this.marked ? "insertFromComposition" : text === "\n" ? "insertLineBreak" : "insertText";
    this.change(inputType, text, typed, () => {
      if (this.dropped(typed, false)) return;
      this.replace(this.select(typed), text);
      this.marked = null;
    });
  }
  /** textView(_:shouldChangeTextIn:replacementText:). */
  shouldChangeText(named: Span, replacement: string) {
    // UIKit names what it does at its own selection; while a composition hides the person's,
    // typing over the selection or a Backspace is the person's, at theirs.
    const uikit = this.selection;
    const selection = this.personSelection();
    if (replacement === "" && Edits.isBackspace(named, uikit, this.text)) {
      const caret = this.place(selection);
      this.change("deleteContentBackward", replacement, caret, () => {
        if (this.dropped(caret, false)) return;
        const at = this.edits.stale(caret) ? this.place(this.selection) : caret;
        this.replace(this.edits.backspace(at, this.text), "");
      });
      return;
    }
    if (this.held && named.start === uikit.start && named.end === uikit.end) named = selection;
    // Typing over the selection, or deleting it, is relative; any other range UIKit names is a
    // place in the text.
    const relative = named.start === selection.start && named.end === selection.end;
    const again = replacement === "" && Edits.deletesSelection(named, selection);
    const typed = this.place(named);
    this.change(
      replacement ? "insertReplacementText" : "deleteContentBackward",
      replacement,
      typed,
      () => {
        if (this.dropped(typed, !relative)) return;
        if (this.edits.stale(typed)) {
          const { start, end } = this.selection;
          const target =
            replacement || end > start || start === 0
              ? { start, end }
              : { start: characterAt(this.text, start - 1).start, end: start };
          this.replace(target, replacement);
          return;
        }
        this.replace(
          again ? this.edits.deletion(typed, this.text) : this.range(typed),
          replacement,
        );
      },
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
    this.change("insertReplacementText", replacement, typed, () => {
      if (this.dropped(typed, true)) return;
      this.replace(this.range(typed), replacement);
    });
  }
  deleteBackward() {
    const typed = this.place(this.personSelection());
    this.change("deleteContentBackward", null, typed, () => {
      if (this.dropped(typed, false)) return;
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
    const typed = this.place(this.personSelection());
    this.change("insertCompositionText", text, typed, () => {
      if (this.dropped(typed, false)) return;
      const target = this.select(typed);
      this.replace(target, text);
      this.marked = text ? { start: target.start, end: target.start + text.length } : null;
    });
  }
  /** `person`: the input method's commit; false when the app ends the composition. */
  unmarkText(person = true) {
    // A tap during a composition commits it, then moves the caret, both before the commit's turn:
    // once the composition ends, the caret goes back where the person put it.
    const named = this.place(this.selection);
    this.enqueue(() => {
      if (person) this.onTurn?.("action");
      if (!this.marked) return;
      const data = this.text.slice(this.marked.start, this.marked.end);
      this.marked = null;
      // Its event reports its own caret; the caret the person chose is reported in its turn.
      const proxy = this.snapshot();
      this.keepChosen(named);
      this.ownSelection = { ...this.selection };
      if (!person) this.onTurn?.("finish");
      this.notify({ type: "compositionend", data, proxy });
    });
  }
  /**
   * RemoteInputTextView.configure with a new context: the composition ends under the old one,
   * then the field is cleared for the new one, each in its turn.
   */
  configure(contextId: string | null) {
    // A new context fences out what was named before this call, from now: no edit typed for the
    // old context is applied to the new one.
    if (contextId !== this.pendingContext) this.edits.fenceNow();
    this.pendingContext = contextId;
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
        this.edits.clear();
        this.selection = { start: 0, end: 0 };
        this.ownSelection = { ...this.selection };
        this.held = null;
        this.mutating = false;
        this.onTurn?.("context");
      });
    });
  }
  paste(text: string) {
    this.enqueue(() => {
      const data = Buffer.from(text, "utf8").toString("base64");
      // Its turn, for the oracle, is when its answer brings the pasted text.
      this.event({ type: "paste", items: [{ type: "text/plain", data }] }, () => undefined, true);
    });
  }
  /** UIKit or the person moves the selection, then UIKit tells the delegate. */
  moveSelection(start: number, end = start) {
    // UIKit tells the delegate only of a change.
    if (this.selection.start === start && this.selection.end === end) return;
    const previous = this.selection;
    this.selection = { start, end };
    const own = this.ownSelection;
    if (this.mutating || (own !== null && own.start === start && own.end === end)) return;
    this.ownSelection = null;
    this.held = null;
    // A move is where UIKit put the caret in the text it had: the distance the person moved it
    // there. While that mirror lives the place is carried; after a reset it is sent as the
    // distance (summed over the moves one report stands for), never dropped. A range selected in
    // text that is gone selects nothing.
    const caret = previous.start === previous.end && start === end;
    this.distance =
      this.distance === undefined || !caret
        ? undefined
        : this.distance + graphemesBetween(this.text, previous.end, end);
    const distance = this.distance;
    const moved = this.place(this.selection);
    this.edits.choose(moved);
    this.report(() => {
      this.distance = 0;
      if (this.edits.stale(moved)) {
        if (distance === undefined) {
          this.onTurn?.("dropped-report");
          return;
        }
        this.onTurn?.("report");
        this.event({ type: "selection", proxy: this.snapshot(), move: distance });
        return;
      }
      this.onTurn?.("report");
      this.event({ type: "selection", proxy: this.snapshot(this.range(moved)) });
    });
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
 * at the caret. An edit during a composition replaces it (an empty one removes it).
 *
 * A composition belongs to the context (and producer) that composed it. The field composes
 * from a composition's start until it is committed or cancelled, whatever is refused meanwhile:
 * a refusal does not end it. When another context's (or producer's) operation comes while it is
 * open, the old context closes it first (PageEditingObserver.#close): its text is committed as
 * it stands, the caret after it, and the operation is then taken as usual.
 * tests/editing-far-model.test.ts holds this model to the real applier in Chromium.
 */
export class FarField {
  value = "";
  caret = 0;
  /** The open composition. */
  composition: Span | null = null;
  /** Who composed it: its context and producer. */
  private composer: { contextId: string | null; producer: string | undefined } | null = null;
  /** The field's context; null takes any (a test that does not rotate). */
  contextId: string | null = null;
  /** Told the new context after a refusal, as the page publishes it. */
  onRotate: ((contextId: string) => void) | null = null;
  refused: EditingOperation[] = [];
  /** Refused because the text did not match its before and after: always a fault upstream. */
  mismatched: EditingOperation[] = [];
  /** Every operation the field was sent, in order. */
  sent: EditingOperation[] = [];
  /** Deletion commands that removed a decomposed letter's last mark alone, as Blink's do. */
  markOnly = 0;
  /** Compositions another context closed, as each closed them: the record of who composed what. */
  closed: { contextId: string | null; producer: string | undefined; text: string }[] = [];
  private rotations = 0;
  private refuse(operation: EditingOperation) {
    this.refused.push(operation);
    this.rotations += 1;
    this.contextId = `00000000-0000-4000-8000-${String(100000000000 + this.rotations).slice(-12)}`;
    this.onRotate?.(this.contextId);
  }
  private replace(start: number, end: number, text: string) {
    this.value = this.value.slice(0, start) + text + this.value.slice(end);
    this.caret = start + text.length;
  }
  /** The composing context closes its composition before another context's operation. */
  private close(producer: string | undefined) {
    const composer = this.composer;
    if (!this.composition || !composer) return;
    if (composer.contextId === this.contextId && composer.producer === producer) return;
    this.closed.push({
      ...composer,
      text: this.value.slice(this.composition.start, this.composition.end),
    });
    this.caret = this.composition.end;
    this.composition = null;
    this.composer = null;
  }
  take = (operation: EditingOperation, producer?: string): boolean => {
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
    this.close(producer);
    switch (operation.kind) {
      case "edit":
      case "compose": {
        const change = operation.kind === "edit" ? operation.edit : operation.composition;
        const { before = "", after = "", text } = change;
        // Taken in the composition while the field composes, else verified around the caret.
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
          this.composer = text ? { contextId: this.contextId, producer } : null;
          const at = Math.min(Math.max(0, operation.composition.selectionEnd), text.length);
          this.caret = range.start + at;
        } else if (text || range.end > range.start) {
          this.replace(range.start, range.end, text);
          this.composition = null;
          this.composer = null;
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
    const mark = points.length > 1 && /\p{M}/u.test(last);
    if (mark) this.markOnly += 1;
    const start = mark ? this.caret - last.length : character.start;
    this.replace(start, this.caret, "");
  }
}
