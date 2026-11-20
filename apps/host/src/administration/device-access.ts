import { OpensteerError, type DeviceId } from "@opensteer/core";
import type { DatabaseSchema } from "@opensteer/database";
import { deviceAccess } from "@opensteer/protocol";
import type { Kysely } from "kysely";

export type DeviceCapability = "browser" | "apps" | "files";
export class DeviceAccessRefusal extends OpensteerError {
  override readonly reason:
    "device-access-off" | "device-asleep" | "device-offline" | "device-stopped";
  readonly machineId: DeviceId;
  readonly capability: DeviceCapability;
  constructor(
    reason: "device-access-off" | "device-asleep" | "device-offline" | "device-stopped",
    machineId: DeviceId,
    capability: DeviceCapability,
    machineName?: string,
  ) {
    super({
      code:
        reason === "device-offline" || reason === "device-asleep" || reason === "device-stopped"
          ? "runner_offline"
          : "forbidden",
      reason,
      message:
        reason === "device-stopped"
          ? "Agents are stopped on this device. Wait until the person resumes them there."
          : reason === "device-asleep"
            ? "This device is asleep. Wait until it wakes before using it."
            : reason === "device-offline"
              ? "This device is offline. Continue other work until it returns."
              : `${capability} is off. Use computer_access_request if needed.`,
      details: { machineId, capability, ...(machineName ? { machineName } : {}) },
    });
    this.reason = reason;
    this.machineId = machineId;
    this.capability = capability;
  }
}
export async function requireDeviceAccess(
  database: Kysely<DatabaseSchema>,
  machineId: DeviceId,
  capability: DeviceCapability,
  online: boolean,
  options: { readonly asleep?: boolean; readonly stopped?: boolean } = {},
): Promise<void> {
  const runner = await database
    .selectFrom("devices")
    .select(["accessPolicy", "name", "removedAt"])
    .where("id", "=", machineId)
    .executeTakeFirst();
  if (!runner || runner.removedAt)
    throw new OpensteerError({ code: "not_found", message: "Active computer not found" });
  // The person's Stop on the computer itself holds whether or not it is connected.
  if (options.stopped)
    throw new DeviceAccessRefusal("device-stopped", machineId, capability, runner.name);
  if (!online)
    throw new DeviceAccessRefusal(
      options.asleep ? "device-asleep" : "device-offline",
      machineId,
      capability,
      runner.name,
    );
  if (!deviceAccess(runner.accessPolicy)[capability])
    throw new DeviceAccessRefusal("device-access-off", machineId, capability);
}
