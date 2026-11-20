import { DeviceIdSchema } from "@opensteer/core";
import { createId, OpensteerError } from "@opensteer/core";
import { agentToolFailureResult } from "@opensteer/agent-tools";
import { BrowserActionErrorSchema, ComputerUseErrorSchema } from "@opensteer/protocol";
import { expect, it } from "vitest";
import { DeviceAccessRefusal } from "../administration/device-access.js";
import { deviceVisibleTo } from "../devices/device-visibility.js";
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

it("tells an agent a Device whose person stopped agents is stopped, not offline", () => {
  const machineId = createId("runner");
  const error = new DeviceAccessRefusal("device-stopped", DeviceIdSchema.parse(machineId), "files");
  const result = agentToolFailureResult(agentToolFailure(error, "write"));
  expect(result.structuredContent.error).toEqual({
    code: "computer_stopped",
    message: error.message,
    next: expect.stringContaining("wait until the person resumes agents there"),
  });
  expect(error.message).toMatch(/Agents are stopped on this device/u);
});

it.each(["device-asleep", "device-stopped"] as const)(
  "names the %s Device in detail to a caller that may know it, and to no one else",
  (reason) => {
    const machineId = DeviceIdSchema.parse(createId("runner"));
    const error = new DeviceAccessRefusal(reason, machineId, "browser", "Studio Mac mini");
    const code = reason === "device-asleep" ? "computer_asleep" : "computer_stopped";
    const named = agentToolFailureResult(
      agentToolFailure(error, "write", deviceVisibleTo(undefined)),
    ).structuredContent.error;
    expect(named).toMatchObject({ code, device: { id: machineId, name: "Studio Mac mini" } });
    // The sentence an agent reads is the same either way.
    const unnamed = agentToolFailureResult(agentToolFailure(error, "write")).structuredContent
      .error;
    expect(unnamed).not.toHaveProperty("device");
    expect(named.message).toBe(unnamed.message);

    // A selected grant learns of a Device only when its apps or phone screens name it.
    const selected = (deviceId: string) =>
      ({
        scope: "selected",
        resources: [
          {
            kind: "computer-app",
            deviceId,
            approvalId: "app-approval",
            app: { kind: "phone-screen", definitionId: "screen" },
          },
        ],
      }) as never;
    const selectedRefusal = agentToolFailureResult(
      agentToolFailure(error, "write", deviceVisibleTo(selected(createId("runner")))),
    );
    expect(selectedRefusal.structuredContent.error).toMatchObject({ code });
    expect(JSON.stringify(selectedRefusal)).not.toContain(machineId);
    expect(JSON.stringify(selectedRefusal)).not.toContain("Studio Mac mini");
    expect(agentToolFailure(error, "write", deviceVisibleTo(selected(machineId)))).toMatchObject({
      device: { id: machineId, name: "Studio Mac mini" },
    });
  },
);

it("names no Device for refusals other than asleep and stopped", () => {
  const machineId = DeviceIdSchema.parse(createId("runner"));
  for (const reason of ["device-access-off", "device-offline"] as const)
    expect(
      agentToolFailure(
        new DeviceAccessRefusal(reason, machineId, "apps", "Studio Mac mini"),
        "write",
        deviceVisibleTo(undefined),
      ),
    ).not.toHaveProperty("device");
});
