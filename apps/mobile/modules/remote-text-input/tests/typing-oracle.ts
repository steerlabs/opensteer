import { characters, type Span } from "./remote-input-port.js";

/*
 * The random typing test's oracle: the person. It does not come from the code under test (the
 * reducer, the port's RemoteInputEdits, the far field): it is a plain text, selection and
 * composition to which each generated action is applied as a person means it, at once.
 *
 * UIKit names some places in the native field's text as it stands when it calls: a caret moved,
 * a word autocorrect replaces, a mark deleted. The native field is the mirror of a window of the
 * person's text, lagging by the actions still waiting their turn. To read such a place as the
 * person meant it, the oracle keeps the same person delayed (`applied`: the same actions,
 * applied as the native field takes each one's turn) and where the mirror's window starts in
 * it (the delayed person's own caret when the mirror was last cleared, never the far field's).
 * The place is then carried over the actions the person has taken and the native field has
 * not, as typing order puts them.
 */

/** A change of `removed` code units at `start` into `inserted` ones. */
export interface Change {
  readonly start: number;
  readonly removed: number;
  readonly inserted: number;
}

/** The person's field: text, selection and composition, each action applied at once. */
export class Person {
  text = "";
  selection: Span = { start: 0, end: 0 };
  marked: Span | null = null;
  /** The caret as the person last left it: where the far caret belongs, a range or not. */
  caret = 0;

  replace(target: Span, text: string): Change[] {
    this.text = this.text.slice(0, target.start) + text + this.text.slice(target.end);
    const at = target.start + text.length;
    this.selection = { start: at, end: at };
    this.marked = null;
    this.caret = at;
    return [{ start: target.start, removed: target.end - target.start, inserted: text.length }];
  }
  /**
   * Replaces `target` without moving the person's caret or composition: an autocorrect, or a
   * deletion UIKit names elsewhere. They are carried over it as typing order puts them.
   */
  edit(target: Span, text: string): Change[] {
    const change = {
      start: target.start,
      removed: target.end - target.start,
      inserted: text.length,
    };
    this.text = this.text.slice(0, target.start) + text + this.text.slice(target.end);
    const caret = this.selection.start === this.selection.end;
    this.selection = {
      start: carry(this.selection.start, change, false),
      end: carry(this.selection.end, change, !caret),
    };
    if (this.marked)
      this.marked = {
        start: carry(this.marked.start, change, false),
        end: carry(this.marked.end, change, true),
      };
    this.caret = carry(this.caret, change, false);
    return [change];
  }
  select(selection: Span) {
    this.selection = { ...selection };
    if (selection.start === selection.end) this.caret = selection.start;
  }
  /** Backspace: the selection, or the character before the caret. */
  backspace(): Change[] {
    const { start, end } = this.selection;
    if (end > start) return this.replace(this.selection, "");
    if (start === 0) return [];
    const character = characters(this.text).find((span) => span.end === start);
    return this.replace({ start: character?.start ?? start - 1, end: start }, "");
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

/** Carries an offset over a change; `before`: a change beginning at it lies after it. */
function carry(offset: number, change: Change, before: boolean): number {
  if (offset < change.start || (before && offset === change.start)) return offset;
  if (offset >= change.start + change.removed) return offset - change.removed + change.inserted;
  return change.start + change.inserted;
}

export class Oracle {
  /** The person, every action applied at once. */
  readonly person = new Person();
  /** The same person, each action applied when the native field takes its turn. */
  readonly applied = new Person();
  private readonly actions: { kind: string; act: Action; changes: Change[] }[] = [];
  /** How many actions the native field has taken. */
  private turns = 0;
  /** Where the native mirror's text begins in the delayed person's text. */
  private window = 0;
  /** The newest caret move, as the person meant it. */
  private move: Span | null = null;
  /** Whether that move's report has not run yet. */
  private moving = false;
  /**
   * Whether the mirror was ever cleared while something the person did waited its turn: places
   * UIKit named in the text it cleared. A classification for the volume's report.
   */
  acrossReset = false;

  /** The person does `act` now; its turn in the native field comes later. */
  act(kind: string, act: Action) {
    this.actions.push({ kind, act, changes: act(this.person) });
  }
  /** The person moves the selection to a place UIKit named in the native text as it stands. */
  select(native: Span) {
    const selection = this.toPerson(native);
    this.person.select(selection);
    this.move = selection;
    this.moving = true;
  }
  /** A place UIKit names in the native field's text now, as the person meant it. */
  toPerson(native: Span): Span {
    let start = this.window + native.start;
    let end = this.window + native.end;
    const caret = start === end;
    for (const { changes } of this.actions.slice(this.turns))
      for (const change of changes) {
        start = carry(start, change, false);
        end = carry(end, change, !caret);
      }
    return { start, end: Math.max(start, end) };
  }
  /** Whether every action has taken its turn in the native field. */
  get caughtUp(): boolean {
    return this.turns === this.actions.length;
  }

  // The native field's turns, as the port reports them.
  turn() {
    const next = this.actions[this.turns++];
    if (next) next.act(this.applied);
  }
  /** A selection report ran: the newest move reached the reducer, after everything typed before it. */
  report() {
    if (this.move) this.applied.select(this.move);
    this.moving = false;
  }
  /** The mirror was cleared: it begins again at the delayed person's caret. */
  reset() {
    if (!this.caughtUp || this.moving) this.acrossReset = true;
    this.window = this.applied.caret;
  }
  /** The app ended the composition in the native field (not one of the person's actions). */
  finish() {
    this.applied.marked = null;
    if (this.caughtUp) this.person.marked = null;
  }
  /** A new context cleared the mirror: the generator's rotation, or the page's own. */
  context() {
    if (this.actions[this.turns]?.kind === "rotate") this.turn();
    else {
      // The page's own: the composition ends in the native field.
      this.applied.marked = null;
      if (this.caughtUp) this.person.marked = null;
    }
    this.reset();
  }
}
