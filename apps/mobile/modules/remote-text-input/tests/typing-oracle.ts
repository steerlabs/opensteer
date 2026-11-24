import { characters, type Span } from "./remote-input-port.js";

/*
 * The random typing test's oracle for regime A (one field; the page does nothing by itself): the
 * person, by the plainest rule. The person's actions are applied in order to one text and one
 * caret, each relative to that caret: type at it (over the selection), delete before it, move it
 * by a distance, paste at it, compose at it. A distance that would pass the start or the end
 * stops there, as the page's own caret does. Backspace is the page's: it removes the character
 * before the caret, and from a letter written with combining marks only the last mark (the
 * Chromium recording in tests/editing-far-model.test.ts).
 *
 * What UIKit does by itself (an autocorrect, a range it selects) names a range in the native
 * field's text; the generator makes it only when the native field has taken every action of the
 * person, so that text is the person's own from where the mirror begins (`window`: the person's
 * caret when the mirror was last cleared), and it is applied to the text as it stood at that point
 * in the order. A caret stays on the side of such a replacement where the person put it: before
 * its start it stays before; after its end, after; inside, at the replacement's end.
 *
 * Nothing here comes from the code under test.
 */

/** The offset `distance` composed characters from `from` in `text`, held inside it. */
function advance(text: string, from: number, distance: number): number {
  const boundaries = [0, ...characters(text).map(({ end }) => end)];
  let index = boundaries.findIndex((boundary) => boundary >= from);
  if (index < 0) index = boundaries.length - 1;
  return boundaries[Math.min(Math.max(0, index + distance), boundaries.length - 1)]!;
}

/** Where a caret goes when `[start, end)` is replaced by `inserted` code units, by the rule above. */
function keep(caret: number, start: number, end: number, inserted: number): number {
  // Text inserted where the caret stands goes before it, as typed text does.
  if (start === end && caret === start) return caret + inserted;
  if (caret <= start) return caret;
  if (caret >= end) return caret - (end - start) + inserted;
  return start + inserted;
}

/** The person's field: text, selection and composition, each action applied at once, in order. */
export class Person {
  text = "";
  selection: Span = { start: 0, end: 0 };
  marked: Span | null = null;

  private put(target: Span, text: string) {
    this.text = this.text.slice(0, target.start) + text + this.text.slice(target.end);
    const at = target.start + text.length;
    this.selection = { start: at, end: at };
    this.marked = null;
  }
  /** Types `text` at the caret, over the selection (or over the composition, committing it). */
  type(text: string) {
    this.put(this.marked ?? this.selection, text);
  }
  /** Pastes at the caret, over the selection. */
  paste(text: string) {
    this.marked = null;
    this.put(this.selection, text);
  }
  /** Backspace, the page's: the selection, or the character before the caret (its last mark). */
  backspace() {
    const { start, end } = this.selection;
    if (end > start) return this.put(this.selection, "");
    if (start === 0) return;
    const character = characters(this.text).find((span) => span.end === start);
    const from = character?.start ?? start - 1;
    const points = Array.from(this.text.slice(from, start));
    const last = points.at(-1)!;
    if (points.length > 1 && /\p{M}/u.test(last))
      return this.put({ start: start - last.length, end: start }, "");
    this.put({ start: from, end: start }, "");
  }
  /** What an open composition replaced when it began: the page holds it until the commit. */
  replaced = "";
  /** Composes `text` at the caret: over the composition, or over the selection when none is open. */
  compose(text: string) {
    const target = this.marked ?? this.selection;
    if (!this.marked) this.replaced = this.text.slice(target.start, target.end);
    this.put(target, text);
    this.marked = text ? { start: target.start, end: target.start + text.length } : null;
  }
  /** Ends the composition, keeping its text. */
  commit() {
    this.marked = null;
  }
  /** Moves the caret by `distance` composed characters, from where it is. */
  move(distance: number) {
    const at = advance(this.text, this.selection.end, distance);
    this.selection = { start: at, end: at };
  }
  /** Selects a range (UIKit's), in the person's text. */
  select(range: Span) {
    this.selection = { ...range };
  }
  /** UIKit replaces a range by itself (an autocorrect): the caret keeps its side. */
  replace(range: Span, text: string) {
    this.text = this.text.slice(0, range.start) + text + this.text.slice(range.end);
    const { start, end } = this.selection;
    // A selection the replacement covers is gone: a caret at the replacement's end.
    const covered = start < end && start >= range.start && end <= range.end;
    const caret = start === end || covered;
    const from = covered
      ? range.start + text.length
      : keep(start, range.start, range.end, text.length);
    this.selection = caret
      ? { start: from, end: from }
      : { start: from, end: Math.max(from, keep(end, range.start, range.end, text.length)) };
  }
}

/** What an action does to a person's field. */
export type Action = (person: Person) => void;

export class Oracle {
  /** The person, every action applied at once. */
  readonly person = new Person();
  /** The same person, each action applied when the native field takes its turn: where the mirror begins. */
  private readonly applied = new Person();
  private readonly actions: Action[] = [];
  private turns = 0;
  /** Where the native mirror's text begins in the person's text. */
  private window = 0;

  /** Moves waiting for their report, grouped as the reports coalesce them. */
  private readonly reports: Action[][] = [];
  /** Whether an action came since the last move: a new move then gets a report of its own. */
  private since = true;

  /** The person does `act` now; its turn in the native field comes later. */
  act(act: Action) {
    this.actions.push(act);
    this.since = true;
    act(this.person);
  }
  /** The person moves the caret or selects; it reaches the native field's order with its report. */
  choose(act: Action) {
    if (this.since || this.reports.length === 0) this.reports.push([]);
    this.reports.at(-1)!.push(act);
    this.since = false;
    act(this.person);
  }
  /** A selection report ran: the moves it stands for are applied in the native field's order. */
  report() {
    for (const act of this.reports.shift() ?? []) act(this.applied);
  }
  /** Whether the native field has taken every action of the person. */
  get caughtUp(): boolean {
    return this.turns === this.actions.length;
  }
  /** A range in the native field's text, caught up, in the person's text. */
  fromNative(range: Span): Span {
    return { start: this.window + range.start, end: this.window + range.end };
  }

  // The native field's turns, as the port reports them.
  turn() {
    const next = this.actions[this.turns++];
    if (next) next(this.applied);
  }
  /** The mirror was cleared: it begins again at the person's caret as the native field had it. */
  reset() {
    this.window = this.applied.selection.end;
  }
}
