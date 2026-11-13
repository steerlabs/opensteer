import type { Request } from "@opensteer/core";
import {
  deviceAccess,
  type DeviceInitialAccess,
  type MachineAccessPolicy,
} from "@opensteer/protocol";
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

/** Makes a device's switches match a setup's choices, whatever an earlier enrollment applied. */
export async function applyDeviceAccess(
  client: Pick<HostClient, "getSnapshot" | "refresh" | "updateMachineAccess">,
  machineId: string,
  wanted: DeviceInitialAccess,
): Promise<DeviceInitialAccess> {
  await client.refresh();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const access = client
      .getSnapshot()
      .machines.find((machine) => machine.id === machineId)?.access;
    if (!access) throw new Error("This device’s access couldn’t be confirmed. Try again.");
    const current = deviceAccess(access.policy);
    if (
      current.browser === wanted.browser &&
      current.apps === wanted.apps &&
      current.files === wanted.files
    )
      return current;
    const result = await client.updateMachineAccess({
      runnerId: machineId,
      expectedRevision: access.revision,
      policy: {
        ...withDeviceSwitch(access.policy, "files", wanted.files),
        browser: wanted.browser,
        apps: wanted.apps,
      },
    });
    if (result.outcome === "updated") {
      const stored = client.getSnapshot().machines.find((machine) => machine.id === machineId);
      return stored?.access ? deviceAccess(stored.access.policy) : wanted;
    }
    await client.refresh();
  }
  throw new Error("This device’s access changed on another device. Try again.");
}
