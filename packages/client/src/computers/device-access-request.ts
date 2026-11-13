import type { Request } from "@opensteer/core";
import type { MachineAccessPolicy } from "@opensteer/protocol";
import type { HostClient, MachineAccessUpdateOutcome } from "../host/client.js";

export type DeviceSwitchName = "browser" | "apps" | "files";

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
  client: Pick<HostClient, "dispatch" | "getSnapshot" | "refresh" | "updateMachineAccess">,
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
  return turnOnDeviceAccess(client, request.payload.machineId, request.payload.access);
}

export async function turnOnDeviceAccess(
  client: Pick<HostClient, "getSnapshot" | "refresh" | "updateMachineAccess">,
  machineId: string,
  access: DeviceSwitchName,
): Promise<MachineAccessUpdateOutcome> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const machine = client.getSnapshot().machines.find((entry) => entry.id === machineId);
    if (!machine?.access) throw new Error("This device can’t be changed from here right now.");
    const result = await client.updateMachineAccess({
      runnerId: machineId,
      expectedRevision: machine.access.revision,
      policy: withDeviceSwitch(machine.access.policy, access, true),
    });
    if (result.outcome === "updated") return result;
    await client.refresh();
  }
  throw new Error("It changed on another device. Look again and try once more.");
}
