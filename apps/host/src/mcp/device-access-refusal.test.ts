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
    const error = new DeviceAccessRefusal(reason, machineId, "apps");
    const failure = agentToolFailure(error, "write");
    expect(failure).toMatchObject({ reason, machineId, capability: "apps" });
    const wire = { code: reason, machineId, capability: "apps", message: error.message };
    expect(ComputerUseErrorSchema.parse({ error: wire }).error).toEqual(wire);
    expect(BrowserActionErrorSchema.parse(wire)).toEqual(wire);
    const result = agentToolFailureResult(failure);
    expect(result.structuredContent.error).toMatchObject({ reason, machineId, capability: "apps" });
    expect(result.content[0]!.text).toContain(machineId);
    expect(result.content[0]!.text).toContain(reason);
    expect(result.content[0]!.text).toContain("apps");
    expect(result.content[0]!.text).toMatch(
      reason === "device-access-off" ? /device_access_request/u : /do not request access/iu,
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
    ).toMatchObject({ reason, machineId, capability: "apps" });
  },
);
