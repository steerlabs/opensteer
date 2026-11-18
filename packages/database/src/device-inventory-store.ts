import { computerConnectionDeviceId } from "./integration-store.js";
import {
  administrationCommand,
  type AdministrationCommandIdentity,
} from "./administration-command.js";
import { renameRunner } from "./runner-store.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import { deviceOwnershipIn } from "./machine-ownership.js";
import {
  DeviceIdSchema,
  deploymentPolicy,
  OpensteerError,
  sameStringSet,
  type DeviceId,
  type RunnerId,
  type UserId,
} from "@opensteer/core";
import {
  MachineAccessPolicySchema,
  machineAccessPolicyDefault,
  type MachineAccessPolicy,
  type RunnerDevice,
  type RunnerModuleName,
} from "@opensteer/protocol";
import { sql, type Kysely, type Selectable } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { jsonValue } from "./store-primitives.js";

export type DeviceInventoryRecord = Selectable<DatabaseSchema["devices"]>;
export interface DeviceDriverRecord {
  readonly deviceId: DeviceId;
  readonly role: "self" | "screen";
  readonly runnerId: RunnerId;
  readonly generation: number;
  readonly detachedAt: Date | null;
}
export async function getDevice(
  database: Kysely<DatabaseSchema>,
  deviceId: DeviceId,
): Promise<DeviceInventoryRecord | null> {
  const row = await database
    .selectFrom("devices")
    .selectAll()
    .where("id", "=", deviceId)
    .executeTakeFirst();
  return row ? { ...row, accessPolicy: MachineAccessPolicySchema.parse(row.accessPolicy) } : null;
}
export async function listDevices(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly ownerId: UserId;
    readonly includeDeployment: boolean;
    readonly includeRemoved?: boolean;
    readonly ids?: readonly DeviceId[];
    readonly after?: DeviceId;
    readonly limit: number;
  },
): Promise<{
  readonly devices: readonly DeviceInventoryRecord[];
  readonly nextCursor: DeviceId | null;
}> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
    throw new OpensteerError({ code: "bad_request", message: "Device page limit is invalid" });
  if (input.ids?.length === 0) return { devices: [], nextCursor: null };
  const rows = await database
    .selectFrom("devices")
    .selectAll()
    .where((eb) =>
      eb.or([
        eb("ownerUserId", "=", input.ownerId),
        ...(input.includeDeployment ? [eb("ownerKind", "=", "deployment")] : []),
      ]),
    )
    .$if(!input.includeRemoved, (q) => q.where("removedAt", "is", null))
    .$if(input.ids !== undefined, (q) => q.where("id", "in", input.ids!))
    .$if(input.after !== undefined, (q) => q.where("id", ">", input.after!))
    .orderBy("id")
    .limit(input.limit + 1)
    .execute();
  return {
    devices: rows
      .slice(0, input.limit)
      .map((row) => ({ ...row, accessPolicy: MachineAccessPolicySchema.parse(row.accessPolicy) })),
    nextCursor: rows.length > input.limit ? rows[input.limit - 1]!.id : null,
  };
}
export function readMachineResourceKeys(
  database: Kysely<DatabaseSchema>,
  ownerId: UserId,
  input: {
    readonly asOf: Date;
    readonly limit: number;
    readonly after?: string;
    readonly id?: string;
  },
) {
  const devices = database
    .selectFrom("devices")
    .select([
      sql<string>`id`.as("id"),
      "name",
      sql<string>`kind`.as("status"),
      sql<"device" | "pending">`'device'`.as("source"),
    ])
    .where("removedAt", "is", null)
    .where((eb) => eb.or([eb("ownerUserId", "=", ownerId), eb("ownerKind", "=", "deployment")]));
  const pending = database
    .selectFrom("runnerEnrollments")
    .select(["id", "name", sql<string>`'pending'`.as("status")])
    .select(sql<"pending">`'pending'`.as("source"))
    .where("consumedAt", "is", null)
    .where("expiresAt", ">", input.asOf)
    .where((eb) => eb.or([eb("ownerUserId", "=", ownerId), eb("ownerKind", "=", "deployment")]));
  const query = database.selectFrom(devices.unionAll(pending).as("machine")).selectAll();
  return query
    .$if(input.after !== undefined, (q) => q.where("id", ">", input.after!))
    .$if(input.id !== undefined, (q) => q.where("id", "=", input.id!))
    .orderBy("id")
    .limit(input.limit)
    .execute();
}

export async function getSelfDeviceId(
  database: Kysely<DatabaseSchema>,
  runnerId: RunnerId,
): Promise<DeviceId | null> {
  const row = await database
    .selectFrom("deviceDrivers")
    .innerJoin("devices", "devices.id", "deviceDrivers.deviceId")
    .innerJoin("runners", "runners.id", "deviceDrivers.runnerId")
    .select("devices.id")
    .where("deviceDrivers.runnerId", "=", runnerId)
    .where("deviceDrivers.role", "=", "self")
    .where("deviceDrivers.detachedAt", "is", null)
    .where("devices.removedAt", "is", null)
    .where("runners.revokedAt", "is", null)
    .executeTakeFirst();
  return row?.id ?? null;
}
export async function requireSelfDeviceId(
  database: Kysely<DatabaseSchema>,
  runnerId: RunnerId,
): Promise<DeviceId> {
  const id = await getSelfDeviceId(database, runnerId);
  if (!id) throw new OpensteerError({ code: "not_found", message: "Active self Device not found" });
  return id;
}
export async function getDeviceSelfRunnerId(
  database: Kysely<DatabaseSchema>,
  deviceId: DeviceId,
): Promise<RunnerId | null> {
  const row = await database
    .selectFrom("deviceDrivers")
    .innerJoin("devices", "devices.id", "deviceDrivers.deviceId")
    .innerJoin("runners", "runners.id", "deviceDrivers.runnerId")
    .select("runners.id")
    .where("deviceDrivers.deviceId", "=", deviceId)
    .where("deviceDrivers.role", "=", "self")
    .where("deviceDrivers.detachedAt", "is", null)
    .where("devices.removedAt", "is", null)
    .where("runners.revokedAt", "is", null)
    .executeTakeFirst();
  return row?.id ?? null;
}
export async function requireDeviceSelfRunnerId(
  database: Kysely<DatabaseSchema>,
  deviceId: DeviceId,
): Promise<RunnerId> {
  const id = await getDeviceSelfRunnerId(database, deviceId);
  if (!id) throw new OpensteerError({ code: "not_found", message: "Active self Runner not found" });
  return id;
}
export async function listDeviceDrivers(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly deviceId?: DeviceId;
    readonly deviceIds?: readonly DeviceId[];
    readonly runnerId?: RunnerId;
    readonly includeDetached?: boolean;
  } = {},
): Promise<readonly DeviceDriverRecord[]> {
  if (input.deviceIds?.length === 0) return [];
  const rows = await database
    .selectFrom("deviceDrivers")
    .selectAll()
    .$if(input.deviceId !== undefined, (q) => q.where("deviceId", "=", input.deviceId!))
    .$if(input.deviceIds !== undefined, (q) => q.where("deviceId", "in", input.deviceIds!))
    .$if(input.runnerId !== undefined, (q) => q.where("runnerId", "=", input.runnerId!))
    .$if(!input.includeDetached, (q) => q.where("detachedAt", "is", null))
    .orderBy("deviceId")
    .orderBy("role")
    .execute();
  return rows.map((row) => ({ ...row, generation: Number(row.generation) }));
}
export function classifySelfDevice(input: {
  readonly kind: "main" | "local" | "managed";
  readonly ownerKind: "deployment" | "user";
  readonly allowedModules: readonly RunnerModuleName[];
  readonly device: RunnerDevice | null;
}) {
  const device = input.device;
  const kind =
    input.kind === "main" && input.ownerKind === "deployment"
      ? "home"
      : sameStringSet(input.allowedModules, ["browser", "integrations"]) && device?.form === "phone"
        ? device.app === "opensteer"
          ? "phone"
          : device.platform === "android"
            ? "agent-phone"
            : "unknown"
        : device?.app === "opensteer"
          ? "computer"
          : device?.form === "server"
            ? "server"
            : "unknown";
  return { kind, platform: device?.platform ?? null, form: device?.form ?? null } as const;
}
export async function upsertSelfDeviceInTransaction(
  transaction: Kysely<DatabaseSchema>,
  runnerId: RunnerId,
  initialPolicy: MachineAccessPolicy = machineAccessPolicyDefault,
): Promise<void> {
  const deployment = await transaction
    .selectFrom("deployments")
    .select(["id", "deploymentShape"])
    .where("singletonKey", "=", "primary")
    .executeTakeFirstOrThrow();
  if (!deploymentPolicy(deployment.deploymentShape).services.personal) return;
  const runner = await transaction
    .selectFrom("runners")
    .selectAll()
    .where("id", "=", runnerId)
    .executeTakeFirstOrThrow();
  if (runner.ownerKind === "deployment" && !runner.allowedModules.includes("agents")) return;
  const existing = await transaction
    .selectFrom("deviceDrivers")
    .select("deviceId")
    .where("runnerId", "=", runnerId)
    .where("role", "=", "self")
    .executeTakeFirst();
  const id = existing?.deviceId ?? DeviceIdSchema.parse(runnerId);
  const classification = classifySelfDevice(runner);
  const values = { name: runner.name, ...classification, updatedAt: runner.updatedAt };
  await transaction
    .insertInto("devices")
    .values({
      id,
      deploymentId: deployment.id,
      ownerKind: runner.ownerKind,
      ownerUserId: runner.ownerUserId,
      ...values,
      accessPolicy: jsonValue(initialPolicy),
      accessPolicyRevision: 1,
      removedAt: runner.revokedAt,
      createdAt: runner.createdAt,
    })
    .onConflict((c) => c.column("id").doUpdateSet(values).where("devices.removedAt", "is", null))
    .execute();
  await transaction
    .insertInto("deviceDrivers")
    .values({
      deviceId: id,
      role: "self",
      runnerId,
      generation: 1,
      detachedAt: runner.revokedAt,
      createdAt: runner.createdAt,
      updatedAt: runner.updatedAt,
    })
    .onConflict((c) => c.columns(["deviceId", "role"]).doNothing())
    .execute();
}

export async function renameDevice(
  database: Kysely<DatabaseSchema>,
  deviceId: DeviceId,
  ownerId: UserId,
  name: string,
  options: { readonly administration?: AdministrationCommandIdentity } = {},
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 120)
    throw new OpensteerError({ code: "bad_request", message: "Device name is invalid" });
  await commitPersonalMutation(database, (transaction, mutation) =>
    administrationCommand(transaction, options.administration, async () => {
      if ((await deviceOwnershipIn(transaction, deviceId))?.effectiveOwner !== ownerId)
        throw new OpensteerError({ code: "not_found", message: "Device not found" });
      const self = await getDeviceSelfRunnerId(transaction, deviceId);
      if (self) return renameRunner(transaction, self, ownerId, trimmed, { allowDeployment: true });
      await transaction
        .selectFrom("devices")
        .select("id")
        .where("id", "=", deviceId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("devices")
        .set({ name: trimmed, updatedAt: new Date() })
        .where("id", "=", deviceId)
        .where("removedAt", "is", null)
        .execute();
      await transaction
        .selectFrom("integrationConnections")
        .select("id")
        .where(computerConnectionDeviceId, "=", deviceId)
        .where("status", "!=", "revoked")
        .orderBy("id")
        .forNoKeyUpdate()
        .execute();
      await transaction
        .updateTable("integrationConnections")
        .set({ displayName: trimmed, updatedAt: new Date() })
        .where(computerConnectionDeviceId, "=", deviceId)
        .where("status", "!=", "revoked")
        .execute();
      mutation.bumpResource("machine");
    }),
  );
}
