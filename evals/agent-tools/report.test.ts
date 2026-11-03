import { expect, it } from "vitest";
import { compareBaseline, fingerprint } from "./report.js";
it("rejects incompatible and incomplete baselines, allows changed treatment, fails majority regressions", () => {
  const identity = {
    engine: "codex",
    model: "gpt-6.1-sol",
    effort: "default",
    corpus: "abc",
    engineVersion: "1",
  };
  const row = {
    caseId: "one",
    sample: 1,
    pass: true,
    complete: true,
    fingerprint: fingerprint(identity),
    treatment: { prompt: "old", schema: "old" },
  };
  const now = [{ ...row, pass: false, treatment: { prompt: "new", schema: "new" } }];
  expect(compareBaseline([row], now, ["one"], row.fingerprint)).toEqual(["one"]);
  expect(() =>
    compareBaseline([{ ...row, fingerprint: "wrong" }], now, ["one"], row.fingerprint),
  ).toThrow(/fingerprint/);
  expect(() => compareBaseline([], now, ["one"], row.fingerprint)).toThrow(/missing/);
  expect(() =>
    compareBaseline([{ ...row, complete: false }], now, ["one"], row.fingerprint),
  ).toThrow(/incomplete/);
  expect(() => compareBaseline([row, row], now, ["one"], row.fingerprint)).toThrow(/duplicate/);
});

it("never classifies missing or incomplete required current samples as pass or regression", async () => {
  const { caseOutcome, summary } = await import("./report.js");
  const { parseCases } = await import("./cases.js");
  const row = {
    caseId: "one",
    sample: 1,
    samplePolicy: "adaptive" as const,
    pass: true,
    complete: true,
    fingerprint: "f",
    treatment: { prompt: "p", schema: "s" },
  };
  const baseline = [row, { ...row, sample: 2 }];
  for (const rows of [
    [],
    [row],
    [row, { ...row, sample: 2, complete: false }],
    [row, { ...row, sample: 2, pass: false }],
  ]) {
    expect(caseOutcome(rows)).toBe("incomplete");
    expect(() => compareBaseline(baseline, rows, ["one"], "f")).toThrow(/Current incomplete/);
    const cases = parseCases(
      JSON.stringify({
        id: "one",
        area: "report",
        kind: "control",
        profile: "main",
        role: "work",
        source: { commit: "a".repeat(40), note: "control" },
        turns: ["hello"],
        expect: {},
      }),
    );
    expect(summary(cases, rows, baseline, [], {})).toContain("| case:one | incomplete |");
    expect(summary(cases, rows, baseline, [], {})).toContain("Case majority passes: 0/1");
  }
  expect(caseOutcome(baseline)).toBe("pass");
  expect(
    caseOutcome([row, { ...row, sample: 2, pass: false }, { ...row, sample: 3, pass: false }]),
  ).toBe("fail");
});
