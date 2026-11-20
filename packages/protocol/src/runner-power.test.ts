import { createId } from "@opensteer/core";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DeviceAvailabilityViewSchema,
  MachineSummarySchema,
  RunnerPowerSleepingSchema,
  RunnerToHostMessageSchema,
  runnerPowerStateCapability,
} from "./index.js";

describe("runner power state protocol", () => {
  it("validates fenced runner.power.sleeping frames and rejects unfenced or extra fields", () => {
    const valid = {
      bootId: `rbt_${randomUUID()}`,
      connectionGeneration: 2,
      connectionId: `rcn_${randomUUID()}`,
      connectionLeaseId: `rls_${randomUUID()}`,
      runnerId: createId("runner"),
      type: "runner.power.sleeping" as const,
    };
    expect(RunnerPowerSleepingSchema.parse(valid)).toEqual(valid);
    expect(RunnerToHostMessageSchema.parse(valid)).toEqual(valid);
    expect(runnerPowerStateCapability).toBe("runner-power-state-v1");
    expect(
      RunnerPowerSleepingSchema.safeParse({
        type: "runner.power.sleeping",
      }).success,
    ).toBe(false);
    expect(
      RunnerPowerSleepingSchema.safeParse({
        ...valid,
        extra: true,
      }).success,
    ).toBe(false);
  });

  it("parses additive asleepSince on MachineSummary and driver-asleep on DeviceAvailabilityView", () => {
    const asleepSince = "2026-04-12T10:15:00.000Z";
    const summary = MachineSummarySchema.parse({
      access: null,
      allowedModules: ["browser", "integrations"],
      apps: null,
      asleepSince,
      computerUse: null,
      detail: null,
      device: { app: "opensteer", form: "laptop", platform: "macos" },
      enrollmentId: null,
      expiresAt: null,
      fullDiskAccess: null,
      id: createId("runner"),
      lastSeenAt: asleepSince,
      modules: {},
      name: "Studio MacBook",
      ownership: "mine",
      revocable: true,
      runtimeVersion: null,
      status: "offline",
    });
    expect(summary.status).toBe("offline");
    expect(summary.asleepSince).toBe(asleepSince);

    const availability = DeviceAvailabilityViewSchema.parse({
      reason: { kind: "driver-asleep" },
      state: "unavailable",
    });
    expect(availability).toEqual({
      reason: { kind: "driver-asleep" },
      state: "unavailable",
    });
  });
});
