import { OpensteerError, type RunnerId } from "@opensteer/core";
import type { DatabaseSchema } from "@opensteer/database";
import { deviceAccess } from "@opensteer/protocol";
import type { Kysely } from "kysely";

export type DeviceCapability = "browser" | "apps" | "files";
export class DeviceAccessRefusal extends OpensteerError {
  override readonly reason: "device-access-off" | "device-offline";
  readonly machineId: RunnerId;
  readonly capability: DeviceCapability;
  constructor(
    reason: "device-access-off" | "device-offline",
    machineId: RunnerId,
    capability: DeviceCapability,
  ) {
    super({
      code: reason === "device-offline" ? "runner_offline" : "forbidden",
      reason,
      message:
        reason === "device-offline"
          ? "Device is offline. Do not request access."
          : `${capability} is off. Use device_access_request if needed.`,
      details: { machineId, capability },
    });
    this.reason = reason;
    this.machineId = machineId;
    this.capability = capability;
  }
}
export async function requireDeviceAccess(
  database: Kysely<DatabaseSchema>,
  machineId: RunnerId,
  capability: DeviceCapability,
  online: boolean,
): Promise<void> {
  const runner = await database
    .selectFrom("runners")
    .select(["accessPolicy", "revokedAt"])
    .where("id", "=", machineId)
    .executeTakeFirst();
  if (!runner || runner.revokedAt)
    throw new OpensteerError({ code: "not_found", message: "Active device not found" });
  if (!online) throw new DeviceAccessRefusal("device-offline", machineId, capability);
  if (!deviceAccess(runner.accessPolicy)[capability])
    throw new DeviceAccessRefusal("device-access-off", machineId, capability);
}
