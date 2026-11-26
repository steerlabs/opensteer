import { OpensteerError, type DeviceId, type RunnerId } from "@opensteer/core";
import type { DatabaseSchema } from "@opensteer/database";
import { deviceAccess } from "@opensteer/protocol";
import type { Kysely } from "kysely";

export type DeviceCapability = "browser" | "apps" | "files";
export class DeviceAccessRefusal extends OpensteerError {
  override readonly reason:
    "device-access-off" | "device-asleep" | "device-offline" | "device-stopped";
  readonly machineId: DeviceId;
  readonly capability: DeviceCapability;
  /** The device's name, when the refusal knows it. */
  readonly machineName: string | undefined;
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
              ? "Device is offline. Do not request access."
              : `${capability} is off. Use computer_access_request if needed.`,
      details: { machineId, capability, ...(machineName ? { machineName } : {}) },
    });
    this.reason = reason;
    this.machineId = machineId;
    this.capability = capability;
    this.machineName = machineName;
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
    throw new DeviceAccessRefusal("device-access-off", machineId, capability, runner.name);
}

/**
 * Resolves the Runner's active self Device and checks its capability access in
 * a single query rather than reading `deviceDrivers`/`devices` twice.
 */
export async function requireRunnerDeviceAccess(
  database: Kysely<DatabaseSchema>,
  runnerId: RunnerId,
  capability: DeviceCapability,
  online: boolean,
  options: { readonly asleep?: boolean; readonly stopped?: boolean } = {},
): Promise<void> {
  const runner = await database
    .selectFrom("deviceDrivers")
    .innerJoin("devices", "devices.id", "deviceDrivers.deviceId")
    .innerJoin("runners", "runners.id", "deviceDrivers.runnerId")
    .select(["devices.id", "devices.accessPolicy", "devices.name"])
    .where("deviceDrivers.runnerId", "=", runnerId)
    .where("deviceDrivers.role", "=", "self")
    .where("deviceDrivers.detachedAt", "is", null)
    .where("devices.removedAt", "is", null)
    .where("runners.revokedAt", "is", null)
    .executeTakeFirst();
  if (!runner)
    throw new OpensteerError({ code: "not_found", message: "Active self Device not found" });
  if (options.stopped)
    throw new DeviceAccessRefusal("device-stopped", runner.id, capability, runner.name);
  if (!online)
    throw new DeviceAccessRefusal(
      options.asleep ? "device-asleep" : "device-offline",
      runner.id,
      capability,
      runner.name,
    );
  if (!deviceAccess(runner.accessPolicy)[capability])
    throw new DeviceAccessRefusal("device-access-off", runner.id, capability, runner.name);
}
