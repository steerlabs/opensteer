import type { DisplayInputEvent } from "@opensteer/protocol";

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

/** The contract's bounds on one text event (`DisplayInputEventSchema`). */
const maxInsertCharacters = 1_000;
const maxDeleteBackward = 100;
/** A wheel "line" in CSS pixels, as browsers scroll a page by it. */
const wheelLinePixels = 16;

/**
 * Where a picture is drawn inside its element when fitted whole and centred,
 * as `object-fit: contain` draws it: the stage around a portrait phone, or
 * the phone's own box mid-rotation, may be another shape.
 */
export function fittedPicture(box: Rect, picture: { width: number; height: number }): Rect {
  if (!(box.width > 0 && box.height > 0 && picture.width > 0 && picture.height > 0))
    return { left: box.left, top: box.top, width: 0, height: 0 };
  const scale = Math.min(box.width / picture.width, box.height / picture.height);
  const width = picture.width * scale;
  const height = picture.height * scale;
  return {
    left: box.left + (box.width - width) / 2,
    top: box.top + (box.height - height) / 2,
    width,
    height,
  };
}

/**
 * A client point as a fraction of the picture. Outside it there is nothing
 * to touch, unless `clamp` holds a stroke that left the picture to its edge.
 */
export function pictureFraction(point: Point, picture: Rect, clamp: boolean): Point | null {
  if (!(picture.width > 0 && picture.height > 0)) return null;
  const x = (point.x - picture.left) / picture.width;
  const y = (point.y - picture.top) / picture.height;
  if (clamp) return { x: unit(x), y: unit(y) };
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
}

/**
 * A wheel turn as fractions of the picture, in the wheel's own sense, which
 * is the contract's: turning down gives positive `dy` and reveals content below.
 */
export function wheelFraction(
  event: { readonly deltaMode: number; readonly deltaX: number; readonly deltaY: number },
  picture: Rect,
): { dx: number; dy: number } {
  if (!(picture.width > 0 && picture.height > 0)) return { dx: 0, dy: 0 };
  // Pages scroll by the picture; lines and pixels by their size on screen.
  if (event.deltaMode === 2) return { dx: signed(event.deltaX), dy: signed(event.deltaY) };
  const pixels = event.deltaMode === 1 ? wheelLinePixels : 1;
  return {
    dx: signed((event.deltaX * pixels) / picture.width),
    dy: signed((event.deltaY * pixels) / picture.height),
  };
}

export type DisplayKey =
  { readonly insert: string } | { readonly deleteBackward: 1 } | { readonly submit: true };

/**
 * What a keystroke in the phone's keyboard target edits. Characters are not
 * keystrokes here: they arrive as committed text, so dead keys, AltGr and
 * IMEs type what they compose. Shortcuts and a composing IME's keys stay theirs.
 */
export function editKey(event: {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly isComposing: boolean;
}): Exclude<DisplayKey, { readonly insert: string }> | null {
  if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return null;
  if (event.key === "Enter") return { submit: true };
  if (event.key === "Backspace") return { deleteBackward: 1 };
  return null;
}

/**
 * What an edit of the keyboard target types on the phone. `compose` lets an
 * IME build its text in place, which is sent only once committed; null is an
 * edit with nothing to type, kept off the target. Paste arrives separately.
 */
export function committedInput(event: {
  readonly inputType: string;
  readonly data: string | null;
  readonly isComposing: boolean;
}): DisplayKey | "compose" | null {
  if (event.isComposing || event.inputType === "insertCompositionText") return "compose";
  switch (event.inputType) {
    case "insertText":
    case "insertReplacementText":
      return event.data ? { insert: event.data } : null;
    case "insertLineBreak":
    case "insertParagraph":
      return { submit: true };
    case "deleteContentBackward":
      return { deleteBackward: 1 };
    default:
      return null;
  }
}

interface Stroke {
  readonly geometry: number;
  last: Point;
}
type MouseInput = Extract<DisplayInputEvent, { kind: "mouse" }>;

/**
 * One view's owner input while it holds control, batched for the socket: a
 * press, lift or cancel goes at once with whatever was waiting before it;
 * moves, wheel turns and typing wait for the next frame and merge there, the
 * newest move standing for the others. A batch names one picture geometry.
 */
export class PhoneDisplayInput {
  readonly #send: (geometry: number, events: DisplayInputEvent[]) => void;
  readonly #requestFrame: (callback: () => void) => () => void;
  #stroke: Stroke | null = null;
  readonly #mouse = new Map<MouseInput["button"], { geometry: number; event: MouseInput }>();
  #batch: { geometry: number; events: DisplayInputEvent[] } | null = null;
  #cancelFrame: (() => void) | null = null;
  #time = 0;
  #disposed = false;

  constructor(options: {
    readonly send: (geometry: number, events: DisplayInputEvent[]) => void;
    readonly requestFrame: (callback: () => void) => () => void;
  }) {
    this.#send = options.send;
    this.#requestFrame = options.requestFrame;
  }

  /** A finger, pen or button is down on the phone. */
  get pressing(): boolean {
    return this.#stroke !== null;
  }

  down(geometry: number, point: Point, time: number): void {
    if (this.#disposed) return;
    this.cancel(time);
    this.#stroke = { geometry, last: point };
    this.#add(geometry, this.#pointer("down", point, time), true);
  }

  move(point: Point, time: number): void {
    const stroke = this.#stroke;
    if (!stroke) return;
    stroke.last = point;
    this.#add(stroke.geometry, this.#pointer("move", point, time), false);
  }

  up(point: Point, time: number): void {
    const stroke = this.#stroke;
    if (!stroke) return;
    this.#stroke = null;
    this.#add(stroke.geometry, this.#pointer("up", point, time), true);
  }

  /** Ends the stroke where the phone last heard it was. */
  cancel(time: number = this.#time): void {
    const stroke = this.#stroke;
    if (stroke) this.#cancel(stroke.geometry, time);
    this.#cancelMouse();
  }

  /**
   * The stream moved to another picture geometry: a stroke in the old one
   * ends, cancelled in the new geometry, the only one the Host and phone
   * still accept input in.
   */
  geometryChanged(geometry: number): void {
    if (this.#stroke && this.#stroke.geometry !== geometry) this.#cancel(geometry, this.#time);
    if ([...this.#mouse.values()].some((stroke) => stroke.geometry !== geometry))
      this.#cancelMouse(geometry);
  }

  mouse(geometry: number, event: MouseInput): void {
    if (this.#disposed) return;
    if (event.phase === "down") this.#mouse.set(event.button, { geometry, event });
    else if (event.phase === "up" || event.phase === "cancel") this.#mouse.delete(event.button);
    else
      for (const stroke of this.#mouse.values())
        stroke.event = { ...stroke.event, x: event.x, y: event.y, modifiers: event.modifiers };
    this.#add(geometry, event, event.phase !== "move");
  }

  #cancelMouse(geometry?: number): void {
    for (const stroke of this.#mouse.values())
      this.#add(geometry ?? stroke.geometry, { ...stroke.event, phase: "cancel" }, true);
    this.#mouse.clear();
  }

  /** Editing and pointer batches share the lease's order. */
  flush(): void {
    this.#flush();
  }

  #cancel(geometry: number, time: number): void {
    const stroke = this.#stroke;
    if (!stroke) return;
    this.#stroke = null;
    this.#add(geometry, this.#pointer("cancel", stroke.last, time), true);
  }

  scroll(geometry: number, point: Point, delta: { dx: number; dy: number }): void {
    if (this.#disposed) return;
    this.#add(geometry, { kind: "scroll", ...point, ...delta }, false);
  }

  key(geometry: number, key: DisplayKey): void {
    if (this.#disposed) return;
    if (!("insert" in key)) {
      this.#add(geometry, { kind: "text", ...key }, false);
      return;
    }
    for (const insert of textChunks(key.insert))
      this.#add(geometry, { kind: "text", insert }, false);
  }

  nav(geometry: number, to: "back" | "home" | "recents"): void {
    if (this.#disposed) return;
    this.#add(geometry, { kind: "nav", to }, true);
  }

  /** Ends any stroke and sends what is waiting; nothing is sent afterwards. */
  dispose(time: number = this.#time): void {
    if (this.#disposed) return;
    this.cancel(time);
    this.#flush();
    this.#disposed = true;
  }

  #pointer(phase: "down" | "move" | "up" | "cancel", point: Point, time: number) {
    // Viewer time must not run backwards within the session, whatever an event says.
    this.#time = Math.max(this.#time, time);
    return { kind: "pointer", phase, x: point.x, y: point.y, t: this.#time } as const;
  }

  #add(geometry: number, event: DisplayInputEvent, now: boolean): void {
    if (this.#batch && this.#batch.geometry !== geometry) this.#flush();
    const batch = (this.#batch ??= { geometry, events: [] });
    const last = batch.events.at(-1);
    const merged = last ? merge(last, event) : null;
    if (merged) batch.events[batch.events.length - 1] = merged;
    else batch.events.push(event);
    if (now) this.#flush();
    else
      this.#cancelFrame ??= this.#requestFrame(() => {
        this.#cancelFrame = null;
        this.#flush();
      });
  }

  #flush(): void {
    this.#cancelFrame?.();
    this.#cancelFrame = null;
    const batch = this.#batch;
    this.#batch = null;
    if (batch && !this.#disposed) this.#send(batch.geometry, batch.events);
  }
}

/** One event standing for two in a row, or null when both must be sent. */
function merge(last: DisplayInputEvent, next: DisplayInputEvent): DisplayInputEvent | null {
  if (last.kind === "pointer" && next.kind === "pointer")
    return last.phase === "move" && next.phase === "move" ? next : null;
  if (last.kind === "scroll" && next.kind === "scroll")
    return { ...next, dx: signed(last.dx + next.dx), dy: signed(last.dy + next.dy) };
  if (last.kind !== "text" || next.kind !== "text") return null;
  if ("insert" in last && "insert" in next)
    return last.insert.length + next.insert.length <= maxInsertCharacters
      ? { kind: "text", insert: last.insert + next.insert }
      : null;
  if ("deleteBackward" in last && "deleteBackward" in next)
    return last.deleteBackward + next.deleteBackward <= maxDeleteBackward
      ? { kind: "text", deleteBackward: last.deleteBackward + next.deleteBackward }
      : null;
  return null;
}

/** Text in pieces one text event can carry, never split inside a character. */
function textChunks(text: string): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const character of text) {
    if (current.length + character.length > maxInsertCharacters) {
      chunks.push(current);
      current = "";
    }
    current += character;
  }
  if (current) chunks.push(current);
  return chunks;
}

function unit(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function signed(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(-1, value)) : 0;
}
