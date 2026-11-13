import type { Request } from "@opensteer/core";
import type { HostClient, MachineAccessUpdateOutcome } from "../host/client.js";

export async function answerDeviceAccessRequest(
  client: Pick<HostClient, "dispatch" | "getSnapshot" | "updateMachineAccess">,
  request: Request,
  decision: "fulfilled" | "declined",
): Promise<MachineAccessUpdateOutcome | void> {
  if (request.status !== "pending" || request.payload.kind !== "device.access")
    throw new Error("Device access Request is no longer pending.");
  if (decision === "declined") {
    await client.dispatch({
      type: "request.respond",
      idempotencyKey: globalThis.crypto.randomUUID(),
      requestId: request.id,
      response: { kind: "external", value: { decision: "declined" } },
    });
    return;
  }
  const { machineId, access } = request.payload;
  const machine = client.getSnapshot().machines.find((entry) => entry.id === machineId);
  if (!machine?.access)
    throw new Error("Device access settings are unavailable. Refresh and try again.");
  return client.updateMachineAccess({
    runnerId: machineId,
    expectedRevision: machine.access.revision,
    policy:
      access === "files"
        ? { ...machine.access.policy, reach: "owner" }
        : { ...machine.access.policy, [access]: true },
  });
}
