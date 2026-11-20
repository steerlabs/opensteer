import { DeviceIdSchema } from "@opensteer/core";
import { createId, OpensteerError } from "@opensteer/core";
import { agentToolFailureResult } from "@opensteer/agent-tools";
import { BrowserActionErrorSchema, ComputerUseErrorSchema } from "@opensteer/protocol";
import { expect, it } from "vitest";
import { DeviceAccessRefusal } from "../administration/device-access.js";
import { agentToolFailure } from "./agent-tool-failure.js";

it.each(["device-access-off", "device-offline"] as const)(
  "carries %s through strict envelopes and both engine result halves",
  (reason) => {
    const machineId = createId("runner");
    const error = new DeviceAccessRefusal(reason, DeviceIdSchema.parse(machineId), "apps");
    const failure = agentToolFailure(error, "write");
    expect(failure).toMatchObject({ reason, computerId: machineId, capability: "apps" });
    const wire = { code: reason, machineId, capability: "apps", message: error.message };
    expect(ComputerUseErrorSchema.parse({ error: wire }).error).toEqual(wire);
    expect(BrowserActionErrorSchema.parse(wire)).toEqual(wire);
    const result = agentToolFailureResult(failure);
    expect(result.structuredContent.error).toEqual({
      code: reason === "device-offline" ? "computer_offline" : "access_denied",
      message: error.message,
      next: expect.stringContaining(machineId),
    });
    expect(result.content[0]!.text).toContain(machineId);
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
    expect(result.content[0]!.text).toContain("apps");
    expect(result.content[0]!.text).toMatch(
      reason === "device-access-off" ? /computer_access_request/u : /do not request access/iu,
    );
    expect(
      agentToolFailure(
        new OpensteerError({
          code: "runner_offline",
          reason,
          message: error.message,
          details: { machineId, capability: "apps" },
        }),
        "write",
      ),
    ).toMatchObject({ reason, computerId: machineId, capability: "apps" });
  },
);

it("distinguishes device-asleep refusals with computer_asleep and calm wake guidance", () => {
  const machineId = createId("runner");
  const error = new DeviceAccessRefusal("device-asleep", DeviceIdSchema.parse(machineId), "apps");
  expect(error.code).toBe("runner_offline");
  const failure = agentToolFailure(error, "write");
  expect(failure).toMatchObject({
    capability: "apps",
    computerId: machineId,
    reason: "device-asleep",
  });
  const result = agentToolFailureResult(failure);
  expect(result.structuredContent.error).toEqual({
    code: "computer_asleep",
    message: error.message,
    next: expect.stringContaining(machineId),
  });
  expect(result.content[0]!.text).toMatch(/asleep/iu);
  expect(result.content[0]!.text).toMatch(/wakes/iu);
  expect(result.content[0]!.text).toMatch(/do not request access/iu);
});
