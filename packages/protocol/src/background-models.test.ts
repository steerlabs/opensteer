import { hostApi } from "./host-api.js";
import { automaticModelsCapability } from "./automatic-models.js";
import { HostCapabilitySchema } from "@opensteer/deployment-authority";
import { expect, it } from "vitest";
import {
  BackgroundTextResultSchema,
  HostBackgroundTextSchema,
  RunnerBackgroundTextResultSchema,
} from "./runner.js";
import { AutomaticModelConfigSchema } from "@opensteer/core";
it("bounds background output and has closed typed failures", () => {
  for (const failure of [
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
  expect(
    AutomaticModelConfigSchema.safeParse({ roles: {}, excludedAccounts: [], fallback: true })
      .success,
  ).toBe(false);
});

it("exposes one strict automatic config command and a gated read contract", () => {
  const command = {
    type: "automaticModels.set",
    idempotencyKey: "automatic-test",
    config: { roles: {}, excludedAccounts: [] },
  };
  expect(hostApi["commands.dispatch"].payload.parse(command)).toEqual(command);
  expect(
    hostApi["commands.dispatch"].payload.safeParse({
      ...command,
      config: { ...command.config, consent: [] },
    }).success,
  ).toBe(false);
  expect(
    hostApi["commands.dispatch"].payload.safeParse({
      type: "backgroundModels.consent.set",
      idempotencyKey: "old",
      providerId: "openai",
      acknowledged: true,
    }).success,
  ).toBe(false);
  expect("backgroundModels.get" in hostApi).toBe(false);
  expect("automaticModels.get" in hostApi).toBe(true);
  expect(HostCapabilitySchema.parse(automaticModelsCapability)).toBe("automatic-models-v1");
});
