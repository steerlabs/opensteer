import { describe, expect, it } from "vitest";
import {
  RunnerWorkerPowerSleepingMessageSchema,
  runnerWorkerPowerSleepingMessage,
} from "./runner-worker-secrets.js";

describe("runner worker power sleeping IPC message", () => {
  it("parses the strict power sleeping message and rejects unknown fields", () => {
    expect(RunnerWorkerPowerSleepingMessageSchema.parse(runnerWorkerPowerSleepingMessage)).toEqual({
      type: "runner.worker.power.sleeping",
    });
    expect(
      RunnerWorkerPowerSleepingMessageSchema.safeParse({
        type: "runner.worker.power.sleeping",
        extra: 1,
      }).success,
    ).toBe(false);
  });
});
