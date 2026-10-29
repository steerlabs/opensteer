import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
interface Sample {
  scenario: { expected: string; composition?: boolean; compositionTransactions?: number };
  events: readonly { type: string; trusted: boolean }[];
  final: { value: string; composing: boolean };
}
const require = createRequire(import.meta.url);
const qualify: (sample: Sample) => boolean =
  require("./native-trace-qualification.cjs").qualifyNativeTrace;
const event = (type: string, trusted = true) => ({ type, trusted });
const complete = [event("compositionstart"), event("input"), event("compositionend")];
describe("scripted capture-classification regression checks", () => {
  const sample: Sample = {
    scenario: { expected: "a" },
    events: [event("input")],
    final: { value: "a", composing: false },
  };
  it("accepts a trusted completed native observation", () => expect(qualify(sample)).toBe(true));
  it("rejects untrusted input", () =>
    expect(qualify({ ...sample, events: [event("input", false)] })).toBe(false));
  it("rejects a wrong native result", () =>
    expect(qualify({ ...sample, final: { value: "x", composing: false } })).toBe(false));
  it("rejects empty observations", () => expect(qualify({ ...sample, events: [] })).toBe(false));
  it("rejects focus-only observations", () =>
    expect(qualify({ ...sample, events: [event("focus")] })).toBe(false));
  it("rejects a still-active preedit even with the expected visible value", () =>
    expect(qualify({ ...sample, final: { value: "a", composing: true } })).toBe(false));
  it("rejects a composition that never ended", () =>
    expect(
      qualify({
        ...sample,
        scenario: { expected: "a", composition: true },
        events: [event("compositionstart"), event("input")],
      }),
    ).toBe(false));
  it("accepts a completed composition", () =>
    expect(
      qualify({ ...sample, scenario: { expected: "a", composition: true }, events: complete }),
    ).toBe(true));
  it("rejects reconversion when only the initial transaction happened", () =>
    expect(
      qualify({
        ...sample,
        scenario: { expected: "a", composition: true, compositionTransactions: 2 },
        events: complete,
      }),
    ).toBe(false));
  it("accepts both completed reconversion transactions", () =>
    expect(
      qualify({
        ...sample,
        scenario: { expected: "a", composition: true, compositionTransactions: 2 },
        events: [...complete, ...complete],
      }),
    ).toBe(true));
  it("rejects an unmatched end", () =>
    expect(qualify({ ...sample, events: [event("input"), event("compositionend")] })).toBe(false));
  it("rejects nested starts", () =>
    expect(
      qualify({
        ...sample,
        events: [event("compositionstart"), ...complete, event("compositionend")],
      }),
    ).toBe(false));
  it("rejects a complete transaction followed by an unfinished one", () =>
    expect(qualify({ ...sample, events: [...complete, event("compositionstart")] })).toBe(false));
});
