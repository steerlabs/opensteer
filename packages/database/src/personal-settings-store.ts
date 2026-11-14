import { randomUUID } from "node:crypto";
import { PrincipalIdSchema } from "@opensteer/channel-core";
import {
  OpensteerError,
  PersonalSettingsSchema,
  emptyAutomaticModelConfig,
  emptyExecutionPreferences,
  localMachineOwnerEmail,
  type ComputerFolder,
  type UserId,
} from "@opensteer/core";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { personalDeploymentOwner } from "./machine-store.js";
import { systemPrincipalId } from "./store-primitives.js";

export async function initializePersonalSettings(
  transaction: Kysely<DatabaseSchema>,
  ownerId: UserId,
  agentHome: ComputerFolder,
) {
  const owner = await transaction
    .selectFrom("users")
    .select(["displayName", "email"])
    .where("id", "=", ownerId)
    .executeTakeFirstOrThrow();
  // A desktop's implicit owner has only a placeholder; anyone who signed up gave a name.
  const named = owner.email !== localMachineOwnerEmail;
  await transaction
    .insertInto("principals")
    .values({ id: systemPrincipalId, kind: "system", userId: null, displayName: "Opensteer" })
    .onConflict((c) => c.doNothing())
    .execute();
  await transaction
    .insertInto("principals")
    .values({
      id: PrincipalIdSchema.parse(`pri_${randomUUID()}`),
      kind: "user",
      userId: ownerId,
      displayName: owner.displayName,
    })
    .onConflict((c) => c.doNothing())
    .execute();
  const inserted = await transaction
    .insertInto("personalSettings")
    .values({
      singletonKey: "personal",
      ownerId,
      agentHomeComputerId: agentHome.computerId,
      agentHomePath: agentHome.path,
      voiceThreadId: null,
      timeZone: null,
      quietTaskDays: 0,
      executionPreferences: emptyExecutionPreferences,
      backgroundModelPreferences: emptyAutomaticModelConfig,
      ...(named ? { ownerName: owner.displayName, ownerNameSetAt: new Date() } : {}),
    })
    .onConflict((c) => c.column("singletonKey").doNothing())
    .executeTakeFirstOrThrow();
  return (inserted.numInsertedOrUpdatedRows ?? 0n) > 0n;
}

export async function findPersonalSettings(database: Kysely<DatabaseSchema>) {
  const row = await database
    .selectFrom("personalSettings")
    .selectAll()
    .where("singletonKey", "=", "personal")
    .executeTakeFirst();
  return row
    ? PersonalSettingsSchema.parse({
        idleCompactionPolicy: row.idleCompactionPolicy,
        ownerId: row.ownerId,
        agentHome: { computerId: row.agentHomeComputerId, path: row.agentHomePath },
        voiceThreadId: row.voiceThreadId,
      })
    : null;
}

export async function personalSettings(database: Kysely<DatabaseSchema>) {
  const settings = await findPersonalSettings(database);
  if (!settings)
    throw new OpensteerError({ code: "conflict", message: "The hosting computer is not ready." });
  return settings;
}

export async function requirePersonalOwner(database: Kysely<DatabaseSchema>, userId: UserId) {
  if ((await personalDeploymentOwner(database)) !== userId)
    throw new OpensteerError({ code: "forbidden", message: "The personal owner is required." });
}
