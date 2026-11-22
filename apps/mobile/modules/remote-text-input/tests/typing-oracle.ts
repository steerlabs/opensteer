import { characters, type Span } from "./remote-input-port.js";

/*
 * The random typing test's oracle for regime A (one field; the page does nothing by itself): the
 * person. It does not come from the code under test. It is a plain text, selection and
 * composition to which each generated action is applied as a person means it, at once, by these
 * rules, written from what a person is promised, not from RemoteInputEdits:
 *
 * - A caret stays on the side of the text where the person put it: before the start of a range
 *   that is then replaced it stays before the replacement; after its end, after; inside, at the
 *   replacement's end. Text inserted where the caret stands goes before it: what the person typed
 *   first stays first.
 * - A selected range that is replaced (typed over) becomes a caret at the replacement's end.
 * - Backspace is the page's: it removes the character before the caret, and from a letter written
 *   with combining marks only the last mark, as the page's own Backspace does (the Chromium
 *   recording in tests/editing-far-model.test.ts).
 *
 * UIKit names some places in the native field's text as it stands when it calls: a caret moved,
 * a word autocorrect replaces, a mark deleted. The native field mirrors a window of the person's
 * text, lagging by the actions still waiting their turn. To read such a place as the person meant
 * it, the oracle keeps the same person delayed to the native field's turns (`applied`) and where
 * the mirror's window starts in it (the delayed person's own caret when the mirror was last
 * cleared), and carries the place over what the person has done since, by the rules above.
 */

/** The offset `distance` composed characters from `from` in `text`, held inside it. */
function advance(text: string, from: number, distance: number): number {
  const boundaries = [0, ...characters(text).map(({ end }) => end)];
  let index = boundaries.findIndex((boundary) => boundary >= from);
  if (index < 0) index = boundaries.length - 1;
  return boundaries[Math.min(Math.max(0, index + distance), boundaries.length - 1)]!;
}

/** A change of `removed` code units at `start` into `inserted` ones. */
export interface Change {
  readonly start: number;
  readonly removed: number;
  readonly inserted: number;
}

/** Where an offset goes when `change` is applied, by the person's rules. `end`: a range's end. */
function carry(offset: number, change: Change, kind: "caret" | "start" | "end"): number {
  const { start, removed, inserted } = change;
  const end = start + removed;
  if (removed === 0) {
    // An insertion: before it stays; where it stands, a caret or a range's start goes after it
    // (typing order), a range's end stays before it (the range does not grow).
    if (offset < start || (kind === "end" && offset === start)) return offset;
    return offset + inserted;
  }
  if (offset >= end) return offset - removed + inserted;
  if (offset < start) return offset;
  // At the start of the replaced range: a caret stays before it; a range's start or end there is
  // part of what was replaced.
  if (offset === start && kind === "caret") return offset;
  if (offset === start && kind === "end") return offset;
  return start + inserted;
}

/** The person's field: text, selection and composition, each action applied at once. */
export class Person {
  text = "";
  selection: Span = { start: 0, end: 0 };
  marked: Span | null = null;
  /** The caret as the person last left it. */
  caret = 0;

  /** The person's own edit at their selection: the caret ends after what they typed. */
  replace(target: Span, text: string): Change[] {
    this.text = this.text.slice(0, target.start) + text + this.text.slice(target.end);
    const at = target.start + text.length;
    this.selection = { start: at, end: at };
    this.marked = null;
    this.caret = at;
    return [{ start: target.start, removed: target.end - target.start, inserted: text.length }];
  }
  /** A replacement made elsewhere (autocorrect): the person's caret is carried over it. */
  edit(target: Span, text: string): Change[] {
    const change = {
      start: target.start,
      removed: target.end - target.start,
      inserted: text.length,
    };
    this.text = this.text.slice(0, target.start) + text + this.text.slice(target.end);
    const caret = this.selection.start === this.selection.end;
    this.selection = caret
      ? {
          start: carry(this.selection.start, change, "caret"),
          end: carry(this.selection.start, change, "caret"),
        }
      : {
          start: carry(this.selection.start, change, "start"),
          end: Math.max(
            carry(this.selection.start, change, "start"),
            carry(this.selection.end, change, "end"),
          ),
        };
    if (this.marked)
      this.marked = {
        start: carry(this.marked.start, change, "start"),
        end: carry(this.marked.end, change, "end"),
      };
    this.caret = carry(this.caret, change, "caret");
    return [change];
  }
  select(selection: Span) {
    this.selection = { ...selection };
    if (selection.start === selection.end) this.caret = selection.start;
  }
  /** Backspace, the page's: the selection, or the character before the caret (its last mark). */
  backspace(): Change[] {
    const { start, end } = this.selection;
    if (end > start) return this.replace(this.selection, "");
    if (start === 0) return [];
    const character = characters(this.text).find((span) => span.end === start);
    const from = character?.start ?? start - 1;
    const points = Array.from(this.text.slice(from, start));
    const last = points.at(-1)!;
    if (points.length > 1 && /\p{M}/u.test(last))
      return this.replace({ start: start - last.length, end: start }, "");
    return this.replace({ start: from, end: start }, "");
  }
  /** Composes `text` over the composition, or over the selection when none is open. */
  compose(text: string): Change[] {
    const target = this.marked ?? this.selection;
    const changes = this.replace(target, text);
    this.marked = text ? { start: target.start, end: target.start + text.length } : null;
    return changes;
  }
}

/** One of the person's actions: what it does to a person's field. */
export type Action = (person: Person) => Change[];

export class Oracle {
  /** The person, every action applied at once. */
  readonly person = new Person();
  /** The same person, each action applied when the native field takes its turn. */
  readonly applied = new Person();
  private readonly actions: { act: Action; changes: Change[] }[] = [];
  /** How many actions the native field has taken. */
  private turns = 0;
  /** Where the native mirror's text begins in the delayed person's text. */
  private window = 0;
  /** The newest caret move, as the person meant it. */
  private move: Span | null = null;

  /** The person does `act` now; its turn in the native field comes later. */
  act(act: Action) {
    this.actions.push({ act, changes: act(this.person) });
  }
  /**
   * The person moves the selection. A caret move is the distance they moved it (`distance`,
   * composed characters, as UIKit measured it in the text it had), from their own caret; a range
   * is the place UIKit named in the native text as it stands.
   */
  select(native: Span, distance?: number) {
    const selection =
      distance === undefined
        ? this.toPerson(native)
        : (() => {
            const at = advance(this.person.text, this.person.selection.end, distance);
            return { start: at, end: at };
          })();
    this.person.select(selection);
    this.move = selection;
  }
  /** A place UIKit names in the native field's text now, as the person meant it. */
  toPerson(native: Span): Span {
    let start = this.window + native.start;
    let end = this.window + native.end;
    const caret = start === end;
    for (const { changes } of this.actions.slice(this.turns))
      for (const change of changes) {
        start = carry(start, change, caret ? "caret" : "start");
        end = caret ? start : carry(end, change, "end");
      }
    return { start, end: Math.max(start, end) };
  }

  // The native field's turns, as the port reports them.
  turn() {
    const next = this.actions[this.turns++];
    if (next) next.act(this.applied);
  }
  /** A selection report ran: the newest move reached the reducer, after everything typed before it. */
  report() {
    if (this.move) this.applied.select(this.move);
  }
  /** The mirror was cleared: it begins again at the delayed person's caret. */
  reset() {
    this.window = this.applied.caret;
  }
}
