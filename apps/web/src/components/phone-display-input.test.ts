import { describe, expect, it } from "vitest";
import { DisplayInputEventsSchema, type DisplayInputEvent } from "@opensteer/protocol";
import {
  PhoneDisplayInput,
  committedInput,
  editKey,
  fittedPicture,
  pictureFraction,
  wheelFraction,
} from "./phone-display-input.js";

/*
 * Ways owner input can go wrong, each answered below:
 *
 * - A pointer maps against the element instead of the picture drawn inside
 *   it, so letterboxing (a portrait phone on a wide stage, a landscape phone
 *   on a tall one) shifts every touch.
 * - A coordinate leaves [0, 1] or becomes NaN (an empty box), which the Host
 *   refuses as a protocol violation and closes the viewer for.
 * - A press in the letterbox lands on the phone's edge instead of nothing.
 * - Moves flood the socket one message per pointermove, or the last move
 *   before a lift is lost.
 * - Cancel or lift is sent with no stroke, twice, or not at all when the
 *   pointer is cancelled; a stroke continues across a geometry change, or
 *   its cancel is sent in the old geometry, which the Host drops.
 * - Time goes backwards or negative.
 * - Wheel deltas ignore line and page units, exceed one picture, or are NaN.
 * - Shortcuts (Cmd+C, Ctrl+V) type letters; Shift, Option or AltGr
 *   characters are lost; Tab, Escape and arrows are swallowed; an IME's
 *   partial composition is typed, or its commit typed twice; a paste or
 *   commit longer than one text event breaks the contract, or is split
 *   inside a character.
 * - Typing is sent per keystroke, out of order, or in text events larger
 *   than the contract allows.
 * - Events of two geometries share one batch.
 * - A navigation button overtakes typing still waiting for its frame.
 */

const box = { left: 100, top: 50, width: 1000, height: 500 };

describe("pointer mapping", () => {
  it("maps an exactly fitted picture edge to edge", () => {
    const picture = fittedPicture(
      { left: 10, top: 20, width: 360, height: 640 },
      { width: 720, height: 1280 },
    );
    expect(picture).toEqual({ left: 10, top: 20, width: 360, height: 640 });
    expect(pictureFraction({ x: 10, y: 20 }, picture, false)).toEqual({ x: 0, y: 0 });
    expect(pictureFraction({ x: 370, y: 660 }, picture, false)).toEqual({ x: 1, y: 1 });
    expect(pictureFraction({ x: 190, y: 340 }, picture, false)).toEqual({ x: 0.5, y: 0.5 });
  });

  it("maps a portrait phone pillarboxed on a wide stage", () => {
    const picture = fittedPicture(box, { width: 720, height: 1280 });
    expect(picture.height).toBe(500);
    expect(picture.width).toBeCloseTo(281.25);
    expect(picture.left).toBeCloseTo(459.375);
    expect(picture.top).toBe(50);
    expect(pictureFraction({ x: 459.375 + 281.25 / 4, y: 300 }, picture, false)).toEqual({
      x: 0.25,
      y: 0.5,
    });
    expect(pictureFraction({ x: 120, y: 300 }, picture, false)).toBeNull();
    expect(pictureFraction({ x: 120, y: 300 }, picture, true)).toEqual({ x: 0, y: 0.5 });
  });

  it("maps a landscape phone letterboxed on a tall stage", () => {
    const picture = fittedPicture(
      { left: 0, top: 0, width: 400, height: 900 },
      { width: 1280, height: 720 },
    );
    expect(picture).toEqual({ left: 0, top: 337.5, width: 400, height: 225 });
    expect(pictureFraction({ x: 300, y: 337.5 + 225 * 0.75 }, picture, false)).toEqual({
      x: 0.75,
      y: 0.75,
    });
    expect(pictureFraction({ x: 300, y: 100 }, picture, false)).toBeNull();
    expect(pictureFraction({ x: 900, y: 2000 }, picture, true)).toEqual({ x: 1, y: 1 });
  });

  it("never produces a coordinate for an empty picture", () => {
    const empty = fittedPicture(
      { left: 0, top: 0, width: 0, height: 300 },
      { width: 720, height: 1280 },
    );
    expect(pictureFraction({ x: 0, y: 0 }, empty, true)).toBeNull();
    expect(
      pictureFraction(
        { x: 5, y: 5 },
        fittedPicture({ left: 0, top: 0, width: 300, height: 300 }, { width: 0, height: 0 }),
        true,
      ),
    ).toBeNull();
  });

  it("turns wheel movement into at most one picture of scroll per event, in its sense", () => {
    const picture = { left: 0, top: 0, width: 400, height: 800 };
    expect(wheelFraction({ deltaMode: 0, deltaX: 40, deltaY: -200 }, picture)).toEqual({
      dx: 0.1,
      dy: -0.25,
    });
    expect(wheelFraction({ deltaMode: 1, deltaX: 0, deltaY: 5 }, picture)).toEqual({
      dx: 0,
      dy: 0.1,
    });
    expect(wheelFraction({ deltaMode: 2, deltaX: 0, deltaY: 3 }, picture)).toEqual({
      dx: 0,
      dy: 1,
    });
    expect(wheelFraction({ deltaMode: 0, deltaX: -9000, deltaY: Number.NaN }, picture)).toEqual({
      dx: -1,
      dy: 0,
    });
    expect(
      wheelFraction({ deltaMode: 0, deltaX: 10, deltaY: 10 }, { ...picture, width: 0, height: 0 }),
    ).toEqual({ dx: 0, dy: 0 });
  });
});

describe("keyboard mapping", () => {
  const key = (value: string, modifiers: Partial<Record<string, boolean>> = {}) =>
    editKey({
      key: value,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      isComposing: false,
      ...modifiers,
    });

  it.each([
    ["Enter", {}, { submit: true }],
    ["Enter", { shiftKey: true }, { submit: true }],
    ["Backspace", {}, { deleteBackward: 1 }],
  ] as const)("edits with %j", (value, modifiers, expected) => {
    expect(key(value, modifiers)).toEqual(expected);
  });

  it.each([
    // Characters arrive as committed text, never keystroke by keystroke.
    ["a", {}],
    ["c", { metaKey: true }],
    ["v", { ctrlKey: true }],
    ["Enter", { ctrlKey: true }],
    ["Backspace", { metaKey: true }],
    ["Tab", {}],
    ["Escape", {}],
    ["ArrowLeft", {}],
    ["Dead", {}],
    ["Enter", { isComposing: true }],
    ["Backspace", { isComposing: true }],
  ] as const)("leaves %j to the page or the IME", (value, modifiers) => {
    expect(key(value, modifiers)).toBeNull();
  });

  const input = (inputType: string, data: string | null = null, isComposing = false) =>
    committedInput({ inputType, data, isComposing });

  it.each([
    ["insertText", "a", { insert: "a" }],
    ["insertText", "A", { insert: "A" }],
    ["insertText", " ", { insert: " " }],
    ["insertText", "é", { insert: "é" }],
    ["insertText", "@", { insert: "@" }],
    ["insertText", "😀", { insert: "😀" }],
    ["insertReplacementText", "their", { insert: "their" }],
    ["insertLineBreak", null, { submit: true }],
    ["insertParagraph", null, { submit: true }],
    ["deleteContentBackward", null, { deleteBackward: 1 }],
  ] as const)("types committed %s %j", (inputType, data, expected) => {
    expect(input(inputType, data)).toEqual(expected);
  });

  it("lets an IME compose, and types nothing until it commits", () => {
    expect(input("insertCompositionText", "に", true)).toBe("compose");
    expect(input("insertText", "日本", true)).toBe("compose");
    expect(input("deleteContentBackward", null, true)).toBe("compose");
  });

  it.each([
    "insertFromPaste",
    "insertFromDrop",
    "historyUndo",
    "deleteByCut",
    "deleteWordBackward",
  ])("prevents %s without typing it here", (inputType) => {
    expect(input(inputType, "x")).toBeNull();
  });
});

describe("owner input batching", () => {
  function harness() {
    const sent: { geometry: number; events: DisplayInputEvent[] }[] = [];
    const frames: (() => void)[] = [];
    const input = new PhoneDisplayInput({
      send: (geometry, events) => {
        expect(DisplayInputEventsSchema.safeParse(events).success || events.length > 64).toBe(true);
        sent.push({ geometry, events: [...events] });
      },
      requestFrame: (callback) => {
        frames.push(callback);
        return () => frames.splice(frames.indexOf(callback), 1);
      },
    });
    const frame = () => {
      for (const callback of frames.splice(0)) callback();
    };
    return { input, sent, frame, frames };
  }
  const at = (x: number, y = 0.5) => ({ x, y });

  it("sends a press at once and coalesces moves to one per frame", () => {
    const { input, sent, frame } = harness();
    input.down(2, at(0.1), 10);
    expect(sent).toEqual([
      { geometry: 2, events: [{ kind: "pointer", phase: "down", x: 0.1, y: 0.5, t: 10 }] },
    ]);
    input.move(at(0.2), 11);
    input.move(at(0.3), 12);
    input.move(at(0.4), 13);
    expect(sent).toHaveLength(1);
    frame();
    expect(sent[1]).toEqual({
      geometry: 2,
      events: [{ kind: "pointer", phase: "move", x: 0.4, y: 0.5, t: 13 }],
    });
    frame();
    expect(sent).toHaveLength(2);
  });

  it("lifts after the last move in the same batch", () => {
    const { input, sent, frames } = harness();
    input.down(1, at(0.1), 1);
    input.move(at(0.2), 2);
    input.up(at(0.25), 3);
    expect(sent[1]?.events).toEqual([
      { kind: "pointer", phase: "move", x: 0.2, y: 0.5, t: 2 },
      { kind: "pointer", phase: "up", x: 0.25, y: 0.5, t: 3 },
    ]);
    expect(frames).toHaveLength(0);
    input.up(at(0.3), 4);
    input.cancel(5);
    input.move(at(0.4), 6);
    expect(sent).toHaveLength(2);
  });

  it("merges same-button mouse moves in a frame and preserves modifier, button and press boundaries", () => {
    const { input, sent, frame } = harness();
    const move: Extract<DisplayInputEvent, { kind: "mouse" }> = {
      kind: "mouse",
      phase: "move",
      button: "none",
      modifiers: [],
      x: 0.1,
      y: 0.5,
    };
    input.mouse(1, move);
    input.mouse(1, { ...move, x: 0.2 });
    input.mouse(1, { ...move, x: 0.3 });
    frame();
    expect(sent[0]?.events).toEqual([{ ...move, x: 0.3 }]);
    const shifted: typeof move = { ...move, modifiers: ["shift"] };
    const left: typeof move = { ...shifted, button: "left" };
    input.mouse(1, move);
    input.mouse(1, shifted);
    input.mouse(1, left);
    input.mouse(1, { ...left, phase: "down", clickCount: 1 });
    input.mouse(1, left);
    frame();
    expect(sent.slice(1).flatMap((batch) => batch.events)).toEqual([
      move,
      shifted,
      left,
      { ...left, phase: "down", clickCount: 1 },
      left,
    ]);
  });

  it("cancels at the last point it sent, once", () => {
    const { input, sent, frame } = harness();
    input.down(1, at(0.1), 1);
    input.move(at(0.6, 0.7), 2);
    frame();
    input.cancel(3);
    input.cancel(4);
    expect(sent.at(-1)?.events).toEqual([
      { kind: "pointer", phase: "cancel", x: 0.6, y: 0.7, t: 3 },
    ]);
    expect(sent).toHaveLength(3);
    expect(input.pressing).toBe(false);
  });

  it("cancels a stroke in the new geometry when the stream changes it", () => {
    const { input, sent, frame } = harness();
    input.down(1, at(0.1), 1);
    input.move(at(0.2), 2);
    input.geometryChanged(1);
    expect(input.pressing).toBe(true);
    input.geometryChanged(2);
    expect(input.pressing).toBe(false);
    // The Host and phone drop input in a superseded geometry; a cancel sent
    // there would leave the finger down until the phone's watchdog lifts it.
    expect(sent.slice(-2)).toEqual([
      { geometry: 1, events: [{ kind: "pointer", phase: "move", x: 0.2, y: 0.5, t: 2 }] },
      { geometry: 2, events: [{ kind: "pointer", phase: "cancel", x: 0.2, y: 0.5, t: 2 }] },
    ]);
    input.move(at(0.3), 3);
    frame();
    input.down(2, at(0.5), 4);
    expect(sent.at(-1)).toEqual({
      geometry: 2,
      events: [{ kind: "pointer", phase: "down", x: 0.5, y: 0.5, t: 4 }],
    });
  });

  it("keeps time from going backwards or below zero", () => {
    const { input, sent } = harness();
    input.down(1, at(0.1), -5);
    input.up(at(0.1), -10);
    expect(sent.map(({ events }) => (events.at(-1) as { t: number }).t)).toEqual([0, 0]);
  });

  it("merges a frame's wheel turns into one scroll at the newest point", () => {
    const { input, sent, frame } = harness();
    input.scroll(1, at(0.2), { dx: 0, dy: 0.25 });
    input.scroll(1, at(0.3), { dx: 0.1, dy: 0.9 });
    frame();
    expect(sent).toEqual([
      { geometry: 1, events: [{ kind: "scroll", x: 0.3, y: 0.5, dx: 0.1, dy: 1 }] },
    ]);
  });

  it("types a frame's keystrokes in order, in the fewest contract-sized events", () => {
    const { input, sent, frame } = harness();
    for (const key of [
      { insert: "h" },
      { insert: "i" },
      { deleteBackward: 1 },
      { deleteBackward: 1 },
      { insert: "!" },
      { submit: true },
    ] as const)
      input.key(1, key);
    expect(sent).toHaveLength(0);
    frame();
    expect(sent).toEqual([
      {
        geometry: 1,
        events: [
          { kind: "text", insert: "hi" },
          { kind: "text", deleteBackward: 2 },
          { kind: "text", insert: "!" },
          { kind: "text", submit: true },
        ],
      },
    ]);
  });

  it("splits committed text longer than one text event, never inside a character", () => {
    const { input, sent, frame } = harness();
    const pasted = `${"x".repeat(999)}😀${"y".repeat(1_500)}`;
    input.key(1, { insert: pasted });
    frame();
    const inserts = sent[0]!.events.map((event) => ("insert" in event ? event.insert : ""));
    expect(inserts.join("")).toBe(pasted);
    expect(inserts.map((text) => text.length)).toEqual([999, 1_000, 502]);
    expect(DisplayInputEventsSchema.safeParse(sent[0]!.events).success).toBe(true);
  });

  it("splits long typing at the contract's bounds", () => {
    const { input, sent, frame } = harness();
    for (let index = 0; index < 1_001; index += 1) input.key(1, { insert: "x" });
    for (let index = 0; index < 101; index += 1) input.key(1, { deleteBackward: 1 });
    frame();
    expect(sent[0]?.events).toEqual([
      { kind: "text", insert: "x".repeat(1_000) },
      { kind: "text", insert: "x" },
      { kind: "text", deleteBackward: 100 },
      { kind: "text", deleteBackward: 1 },
    ]);
  });

  it("navigates at once, after what was typed before it", () => {
    const { input, sent, frames } = harness();
    input.key(1, { insert: "a" });
    input.nav(1, "back");
    expect(frames).toHaveLength(0);
    expect(sent).toEqual([
      {
        geometry: 1,
        events: [
          { kind: "text", insert: "a" },
          { kind: "nav", to: "back" },
        ],
      },
    ]);
  });

  it("never mixes geometries in one batch", () => {
    const { input, sent, frame } = harness();
    input.key(1, { insert: "a" });
    input.key(2, { insert: "b" });
    frame();
    expect(sent).toEqual([
      { geometry: 1, events: [{ kind: "text", insert: "a" }] },
      { geometry: 2, events: [{ kind: "text", insert: "b" }] },
    ]);
  });

  it("ends the stroke and sends what was typed when disposed, then nothing more", () => {
    const { input, sent, frames } = harness();
    input.key(1, { insert: "a" });
    input.down(1, at(0.4), 2);
    input.dispose(3);
    expect(frames).toHaveLength(0);
    expect(sent.flatMap(({ events }) => events)).toEqual([
      { kind: "text", insert: "a" },
      { kind: "pointer", phase: "down", x: 0.4, y: 0.5, t: 2 },
      { kind: "pointer", phase: "cancel", x: 0.4, y: 0.5, t: 3 },
    ]);
    input.down(1, at(0.4), 4);
    input.key(1, { insert: "b" });
    expect(sent).toHaveLength(2);
  });
});
