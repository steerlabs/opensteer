import type { Request } from "@opensteer/core";
import type { MachineAccessPolicy } from "@opensteer/protocol";
import type { HostClient, MachineAccessUpdateOutcome } from "../host/client.js";

export type DeviceSwitchName = "browser" | "apps" | "files";

/**
 * The policy one "Your agent can use" switch writes. Only the changed one of
 * the optional switches rides along, so the Host keeps whatever the other is
 * now. Files is reach alone: turning it back on restores the commands,
 * forwarding and folders saved underneath, which only new enrollment sets.
 */
export function withDeviceSwitch(
  policy: MachineAccessPolicy,
  name: DeviceSwitchName,
  on: boolean,
): MachineAccessPolicy {
  const base = {
    reach: policy.reach,
    commands: policy.commands,
    forwarding: policy.forwarding,
    shares: policy.shares,
  };
  if (name === "files") return { ...base, reach: on ? "owner" : "nobody" };
  return { ...base, [name]: on };
}

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
    policy: withDeviceSwitch(machine.access.policy, access, true),
  });
}
