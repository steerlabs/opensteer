import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { characters, NativeField, type Packet, type Span } from "./remote-input-port.js";

/*
 * CU3: the port's half that models UIKit (NativeField's effects of UITextView's own calls) held to
 * what UIKit's real UITextView did, as UIKitRecordingTests.swift recorded it on Mac Catalyst
 * (ios/Tests/Cases/uikit-recordings.json, compared there with UIKit on every run). Each case runs
 * settled, every event answered at once, so the view's own carrying of the person's caret plays
 * no part except where it overrides UIKit: after replace(_:withText:) UIKit leaves the caret at
 * the replacement's end, and the view puts the person's back on its side (checked on the real
 * view by RemoteTextInputReplayTests.swift); there only the text is UIKit's. Likewise UIKit takes
 * a caret set inside a character (between an emoji's surrogates), and the view moves the caret
 * the distance moved, in whole characters: there it lands on the end of that character.
 *
 * The recording also shows what UIKit does not do: none of these calls names a range to the
 * delegate, so a range UIKit names by itself (a mark alone for deletion) is generated nowhere.
 */

interface State {
  text: string;
  selection: Span;
  marked?: Span;
}
interface Step extends State {
  call: [string, ...unknown[]];
  named: { start: number; end: number; text: string }[];
}
const recording = JSON.parse(
  readFileSync(new URL("../ios/Tests/Cases/uikit-recordings.json", import.meta.url), "utf8"),
) as { cases: { name: string; start: State; steps: Step[] }[] };

function settled() {
  const packets: Packet[] = [];
  const field = new NativeField((packet) => packets.push(packet));
  const answer = () => {
    while (packets.length > 0) field.respond({ id: packets.shift()!.id });
  };
  return { field, answer };
}
const state = (field: NativeField): State => ({
  text: field.text,
  selection: { ...field.selection },
  ...(field.marked ? { marked: { ...field.marked } } : {}),
});

describe("UIKit's own UITextView, as recorded, in the port", () => {
  it("has the recording", () => expect(recording.cases.length).toBeGreaterThan(20));
  it("never names a range to the delegate for these calls", () => {
    for (const { steps } of recording.cases)
      for (const step of steps) expect(step.named).toEqual([]);
  });
  for (const { name, start, steps } of recording.cases)
    it(name, () => {
      const { field, answer } = settled();
      field.respond({
        id: 0,
        set: {
          value: start.marked
            ? start.text.slice(0, start.marked.start) + start.text.slice(start.marked.end)
            : start.text,
          selectionStart: start.marked ? start.marked.start : start.selection.start,
          selectionEnd: start.marked ? start.marked.start : start.selection.end,
        },
      });
      if (start.marked) {
        field.setMarkedText(start.text.slice(start.marked.start, start.marked.end));
        answer();
      }
      expect(state(field)).toEqual(start);
      for (const step of steps) {
        const [call, ...args] = step.call;
        if (call === "insertText") field.insertText(args[0] as string);
        else if (call === "setMarkedText") {
          // The port's input method puts its caret at the marked text's end, as every recorded
          // call here asks.
          expect(args[1]).toBe((args[0] as string).length);
          field.setMarkedText(args[0] as string);
        } else if (call === "unmarkText") field.unmarkText();
        else if (call === "deleteBackward") field.deleteBackward();
        else if (call === "replace")
          field.replaceRange(args[0] as number, args[1] as number, args[2] as string);
        else if (call === "select")
          field.moveSelection(
            args[0] as number,
            (args[1] as number | undefined) ?? (args[0] as number),
          );
        else throw new Error(`unknown call ${call}`);
        answer();
        const { call: _call, named: _named, ...expected } = step;
        if (call === "replace") expect(field.text).toBe(expected.text);
        else if (
          call === "select" &&
          expected.selection.start === expected.selection.end &&
          !characters(expected.text).some(({ end }) => end === expected.selection.end)
        ) {
          const inside = characters(expected.text).find(
            ({ start, end }) => start < expected.selection.end && end > expected.selection.end,
          )!;
          expect(state(field)).toEqual({
            ...expected,
            selection: { start: inside.end, end: inside.end },
          });
        } else expect(state(field)).toEqual(expected);
      }
    });
});
