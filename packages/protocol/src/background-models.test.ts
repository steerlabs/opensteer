import { expect, it } from "vitest";
import {
  BackgroundTextResultSchema,
  HostBackgroundTextSchema,
  RunnerBackgroundTextResultSchema,
} from "./runner.js";
import { BackgroundModelModeSchema } from "@opensteer/core";
it("bounds background output and has closed typed failures", () => {
  for (const failure of [
    "capacity",
    "refused",
    "signed-out",
    "usage-limit",
    "timeout",
    "unavailable",
    "failed",
  ])
    expect(BackgroundTextResultSchema.parse({ ok: false, failure })).toEqual({
      ok: false,
      failure,
    });
  expect(BackgroundTextResultSchema.safeParse({ ok: true, text: "a".repeat(20_001) }).success).toBe(
    false,
  );
  expect(BackgroundTextResultSchema.safeParse({ ok: false, failure: "other" }).success).toBe(false);
});
it("keeps opaque attempts independent of Runs and refuses the removed pin flag", () => {
  expect(HostBackgroundTextSchema.shape.attemptId.safeParse("opaque-attempt").success).toBe(true);
  expect(RunnerBackgroundTextResultSchema.shape.attemptId.safeParse("").success).toBe(false);
  expect(BackgroundModelModeSchema.safeParse({ kind: "automatic", fallback: true }).success).toBe(
    false,
  );
});
