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
