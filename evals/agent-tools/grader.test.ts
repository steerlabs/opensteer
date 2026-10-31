import { describe, expect, it } from "vitest";
import { parseCases } from "./cases.js";
import { grade, majority, partialMatch } from "./grader.js";

const base = {
  id: "one",
  area: "routing",
  kind: "bad",
  source: { commit: "a".repeat(40), note: "incident" },
  profile: "main",
  role: "work",
  turns: ["Do it"],
  expect: {},
};
const line = (patch: Record<string, unknown> = {}) => JSON.stringify({ ...base, ...patch });
describe("case boundary failure modes", () => {
  it("rejects malformed JSON, duplicate IDs, unknown fields and absent provenance", () => {
    for (const text of [
      "{",
      `${line()}\n${line()}`,
      line({ typo: true }),
      line({ source: undefined }),
    ])
      expect(() => parseCases(text)).toThrow();
  });
  it("rejects unsafe fixture paths and broken regexes", () => {
    for (const path of ["../escape", "/tmp/escape", "a/../../escape", "a\\escape"])
      expect(() => parseCases(line({ fixtures: { [path]: "x" } }))).toThrow();
    expect(() => parseCases(line({ expect: { textMust: ["["] } }))).toThrow();
  });
  it("parses defaults and identifies line numbers", () => {
    expect(parseCases(line())[0]?.expect.maxInvalidCalls).toBe(0);
    expect(() => parseCases(`${line()}\n{`)).toThrow(/line 2/);
  });
});
describe("trajectory grading failure modes", () => {
  it("matches recursive partial objects without coercion", () => {
    expect(
      partialMatch({ nested: { x: 1, y: 2 }, a: ["b", "c"] }, { nested: { x: 1 }, a: ["b"] }),
    ).toBe(true);
    expect(partialMatch({ x: null }, { x: "null" })).toBe(false);
    expect(partialMatch({}, { x: null })).toBe(false);
  });
  it("excludes invalid calls from expectations but counts and forbids them", () => {
    const c = parseCases(line({ expect: { calls: [{ tool: "foo" }], notCalls: ["foo"] } }))[0]!;
    const checks = grade(c.expect, [{ tool: "foo", args: {}, valid: false }], "");
    expect(checks.every((c) => c.pass)).toBe(false);
    expect(checks.filter((c) => !c.pass)).toHaveLength(3);
  });
  it("orders repeated occurrences and enforces counts and final text", () => {
    const c = parseCases(
      line({
        expect: {
          order: ["a", "b", "a"],
          minCalls: { a: 2 },
          maxCalls: { b: 1 },
          textMust: ["done"],
          textMustNot: ["pending"],
        },
      }),
    )[0]!;
    const calls = ["a", "b", "a"].map((tool) => ({ tool, args: {}, valid: true }));
    expect(grade(c.expect, calls, "done").every((c) => c.pass)).toBe(true);
    expect(grade(c.expect, calls.slice(0, 2), "pending").every((c) => c.pass)).toBe(false);
  });
  it("fails ties and empty sets", () => {
    expect(majority([])).toBe(false);
    expect(majority([true, false])).toBe(false);
    expect(majority([true, false, true])).toBe(true);
  });
});
