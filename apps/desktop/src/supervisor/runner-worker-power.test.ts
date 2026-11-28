import { describe, expect, it } from "vitest";
import { RunnerWorkerPowerMessageSchema } from "./runner-worker-secrets.js";

describe("runner worker power sleeping IPC message", () => {
  it("parses the strict power sleeping message and rejects unknown fields", () => {
    expect(RunnerWorkerPowerMessageSchema.parse({ type: "runner.worker.power.sleeping" })).toEqual({
      type: "runner.worker.power.sleeping",
    });
    expect(RunnerWorkerPowerMessageSchema.parse({ type: "runner.worker.power.awake" })).toEqual({
      type: "runner.worker.power.awake",
    });
    expect(
      RunnerWorkerPowerMessageSchema.safeParse({
        type: "runner.worker.power.sleeping",
        extra: 1,
      }).success,
    ).toBe(false);
  });
});
