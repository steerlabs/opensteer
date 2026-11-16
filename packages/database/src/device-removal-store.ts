import {
  administrationCommand,
  type AdministrationCommandIdentity,
} from "./administration-command.js";
import {
  createId,
  OpensteerError,
  type DeviceId,
  type DeviceDriverIdentity,
  type RunnerId,
  type UserId,
} from "@opensteer/core";
import { sql, type Kysely, type Transaction } from "kysely";
import { cancelPending } from "./request-cancellation.js";
import { deviceOwnershipIn } from "./machine-ownership.js";
import { revokeComputerConnectionsInTransaction } from "./integration-platform-stores.js";
import { revokeRunner } from "./runner-store.js";
import { withPersonalTransaction } from "./personal-transaction.js";
import type { DatabaseSchema } from "./schema.js";
import { jsonValue, type ChannelLinks } from "./store-primitives.js";

export async function lockDeviceRemovalInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: { readonly runnerId?: RunnerId; readonly deviceId?: DeviceId },
) {
  const slots = await transaction
    .selectFrom("deviceDrivers")
    .selectAll()
    .where((eb) =>
      eb.or([
        ...(input.runnerId ? [eb("runnerId", "=", input.runnerId)] : []),
        ...(input.deviceId ? [eb("deviceId", "=", input.deviceId)] : []),
      ]),
    )
    .where("detachedAt", "is", null)
    .execute();
  const removedDeviceIds = input.deviceId
    ? [input.deviceId]
    : slots.filter((s) => s.role === "self").map((s) => s.deviceId);
  const allSlots = removedDeviceIds.length
    ? await transaction
        .selectFrom("deviceDrivers")
        .selectAll()
        .where("deviceId", "in", removedDeviceIds)
        .where("detachedAt", "is", null)
        .execute()
    : [];
  const runnerIds = [
    ...new Set(
      [...slots, ...allSlots].map((s) => s.runnerId).concat(input.runnerId ? [input.runnerId] : []),
    ),
  ].sort();
  if (runnerIds.length)
    await transaction
      .selectFrom("runners")
      .select("id")
      .where("id", "in", runnerIds)
      .orderBy("id")
      .forNoKeyUpdate()
      .execute();
  const deviceIds = [
    ...new Set([...slots, ...allSlots].map((s) => s.deviceId).concat(removedDeviceIds)),
  ].sort();
  if (deviceIds.length) {
    await transaction
      .selectFrom("devices")
      .select("id")
      .where("id", "in", deviceIds)
      .orderBy("id")
      .forNoKeyUpdate()
      .execute();
    await transaction
      .selectFrom("deviceDrivers")
      .select(["deviceId", "role"])
      .where("deviceId", "in", deviceIds)
      .orderBy("deviceId")
      .orderBy("role")
      .forNoKeyUpdate()
      .execute();
  }
  const detachedDeviceBindings: DeviceDriverIdentity[] = [];
  for (const slot of slots
    .filter((s) => s.role === "screen" && !removedDeviceIds.includes(s.deviceId))
    .sort((a, b) => a.deviceId.localeCompare(b.deviceId))) {
    const generation = Number(slot.generation) + 1;
    await transaction
      .updateTable("deviceDrivers")
      .set({ generation, detachedAt: new Date(), updatedAt: new Date() })
      .where("deviceId", "=", slot.deviceId)
      .where("role", "=", slot.role)
      .execute();
    detachedDeviceBindings.push({
      deviceId: slot.deviceId,
      role: slot.role,
      runnerId: slot.runnerId,
      generation,
    });
  }
  for (const id of removedDeviceIds.sort()) {
    await transaction
      .updateTable("devices")
      .set({ removedAt: new Date(), updatedAt: new Date() })
      .where("id", "=", id)
      .where("removedAt", "is", null)
      .execute();
    await transaction
      .updateTable("deviceDrivers")
      .set({ generation: sql`generation + 1`, detachedAt: new Date(), updatedAt: new Date() })
      .where("deviceId", "=", id)
      .where("detachedAt", "is", null)
      .execute();
  }
  return { removedDeviceIds, detachedDeviceBindings };
}
export async function clearRemovedDeviceStopsInTransaction(
  transaction: Transaction<DatabaseSchema>,
  deviceIds: readonly DeviceId[],
) {
  if (deviceIds.length)
    await transaction
      .deleteFrom("computerUseStops")
      .where("deviceId", "in", [...deviceIds])
      .execute();
}
export type DeviceRemovalEffects = Awaited<ReturnType<typeof revokeRunner>>;

export async function removeDevice(
  database: Kysely<DatabaseSchema>,
  links: ChannelLinks,
  deviceId: DeviceId,
  ownerId: UserId,
  options: { readonly administration?: AdministrationCommandIdentity } = {},
): Promise<DeviceRemovalEffects> {
  return withPersonalTransaction(database, (transaction) =>
    administrationCommand(transaction, options.administration, async () => {
      const device = await transaction
        .selectFrom("devices")
        .selectAll()
        .where("id", "=", deviceId)
        .executeTakeFirst();
      if (
        !device ||
        (device.ownerKind === "user" && device.ownerUserId !== ownerId) ||
        (!device.removedAt &&
          (await deviceOwnershipIn(transaction, deviceId))?.effectiveOwner !== ownerId)
      )
        throw new OpensteerError({ code: "not_found", message: "Device not found" });
      const self = await transaction
        .selectFrom("deviceDrivers")
        .select("runnerId")
        .where("deviceId", "=", deviceId)
        .where("role", "=", "self")
        .executeTakeFirst();
      if (self)
        return revokeRunner(transaction, links, self.runnerId, ownerId, { allowDeployment: true });
      const effects = device.removedAt
        ? { removedDeviceIds: [deviceId], detachedDeviceBindings: [] as DeviceDriverIdentity[] }
        : await lockDeviceRemovalInTransaction(transaction, { deviceId });
      if (!device.removedAt)
        await transaction
          .insertInto("securityAudit")
          .values({
            id: createId("securityAudit"),
            action: "device.removed",
            actorSessionId: null,
            actorUserId: ownerId,
            requestId: createId("command"),
            targetType: "device",
            targetId: deviceId,
            metadata: jsonValue({ kind: device.kind }),
          })
          .execute();
      await clearRemovedDeviceStopsInTransaction(transaction, [deviceId]);
      const revoked = await revokeComputerConnectionsInTransaction(transaction, { deviceId });
      const pending = await transaction
        .selectFrom("requests")
        .select("id")
        .where("kind", "=", "device.access")
        .where("status", "=", "pending")
        .where(sql<string>`payload->>'machineId'`, "=", deviceId)
        .execute();
      const events = await cancelPending(transaction, {
        requestIds: pending.map((r) => r.id),
        reason: "resource-deleted",
        resolvedAt: new Date(),
      });
      await transaction
        .selectFrom("authSessions")
        .select("id")
        .where("deviceId", "=", deviceId)
        .orderBy("id")
        // FOR UPDATE: Device removal deletes only this Device's bound sessions.
        .forUpdate()
        .execute();
      const ended = await transaction
        .deleteFrom("authSessions")
        .where("deviceId", "=", deviceId)
        .returning("id")
        .execute();
      return {
        ...effects,
        endedSessionIds: ended.map((r) => r.id),
        deletedBrowserProfiles: [],
        cancelledRequestIds: [...revoked.cancelledRequestIds, ...pending.map((r) => r.id)],
        closedBrowserSessions: [],
        events: [],
        requestEvents: [...revoked.requestEvents, ...events],
        revokedComputerConnectionIds: revoked.connectionIds,
      };
    }),
  );
}
