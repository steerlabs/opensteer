import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Edits, type Place, type Span } from "./remote-input-port.js";

/*
 * The arithmetic cases RemoteInputEditsCasesTests.swift runs against RemoteInputEdits.swift, run
 * here against the TypeScript port: a change to either that the cases notice fails one side.
 */

type Pair = [number, number];
type Step =
  | { place: string; at: Pair }
  | { record: [number, number, number] }
  | { settle: true }
  | { choose: string }
  | { current: string; length: number; is: Pair }
  | { deletion: string; text: string; is: Pair }
  | { backspace: string; text: string; count?: number; is: Pair }
  | { chosenAfter: string; is: string | null }
  | { isBackspace: { named: Pair; selection: Pair }; is: boolean }
  | { deletesSelection: { named: Pair; selection: Pair }; is: boolean }
  | { composedCount: { text: string; range: Pair }; is: number }
  | { deletedStart: { selection: Pair; removed: number }; is: number };

const file = JSON.parse(
  readFileSync(new URL("../ios/Tests/Cases/remote-input-edits.json", import.meta.url), "utf8"),
) as { cases: { name: string; steps: Step[] }[] };

/** An NSRange [location, length] as a span. */
const span = ([location, length]: Pair): Span => ({ start: location, end: location + length });
const pair = ({ start, end }: Span): Pair => [start, end - start];

describe("RemoteInputEdits' shared cases, in the port", () => {
  it("has cases", () => expect(file.cases.length).toBeGreaterThan(10));
  for (const { name, steps } of file.cases)
    it(name, () => {
      const edits = new Edits();
      const places = new Map<string, Place>();
      const named = (key: string) => {
        const place = places.get(key);
        if (!place) throw new Error(`No place ${key}`);
        return place;
      };
      for (const step of steps) {
        if ("place" in step) places.set(step.place, edits.place(step.at[0], step.at[1]));
        else if ("record" in step) edits.record(...step.record);
        else if ("settle" in step) edits.settle();
        else if ("choose" in step) edits.choose(named(step.choose));
        else if ("current" in step) {
          const { start, end } = edits.current(named(step.current), step.length);
          expect([start, end]).toEqual(step.is);
        } else if ("deletion" in step)
          expect(pair(edits.deletion(named(step.deletion), step.text))).toEqual(step.is);
        else if ("backspace" in step)
          expect(pair(edits.backspace(named(step.backspace), step.count ?? 1, step.text))).toEqual(
            step.is,
          );
        else if ("chosenAfter" in step)
          expect(edits.chosenAfter(named(step.chosenAfter))).toEqual(
            step.is === null ? null : named(step.is),
          );
        else if ("isBackspace" in step)
          expect(
            Edits.isBackspace(span(step.isBackspace.named), span(step.isBackspace.selection)),
          ).toBe(step.is);
        else if ("deletesSelection" in step)
          expect(
            Edits.deletesSelection(
              span(step.deletesSelection.named),
              span(step.deletesSelection.selection),
            ),
          ).toBe(step.is);
        else if ("composedCount" in step)
          expect(Edits.composedCount(step.composedCount.text, span(step.composedCount.range))).toBe(
            step.is,
          );
        else if ("deletedStart" in step)
          expect(
            Edits.deletedStart(span(step.deletedStart.selection), step.deletedStart.removed),
          ).toBe(step.is);
        else throw new Error(`Unknown step ${JSON.stringify(step)}`);
      }
    });
});
