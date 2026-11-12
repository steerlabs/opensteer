import { randomUUID } from "node:crypto";
import { PrincipalIdSchema } from "@opensteer/channel-core";
import { systemPrincipalId } from "@opensteer/database";
import { mkdir, realpath } from "node:fs/promises";
import { OpensteerError, type EnvironmentId } from "@opensteer/core";
import {
  personalDeploymentOwner,
  personalSettings,
  requirePersonalOwner,
  withPersonalTransaction,
  type DatabaseSchema,
} from "@opensteer/database";
import type { Kysely } from "kysely";
import { FolderAdmissionService } from "../threads/folder-admission-service.js";

export async function initializePersonalState(
  database: Kysely<DatabaseSchema>,
  config: {
    readonly environmentId: EnvironmentId;
    readonly agentHome: string;
  },
): Promise<FolderAdmissionService | null> {
  const ownerId = await personalDeploymentOwner(database);
  const hosting = await database
    .selectFrom("runners")
    .select("id")
    .where("kind", "=", "main")
    .where("ownerKind", "=", "deployment")
    .where("revokedAt", "is", null)
    .executeTakeFirst();
  if (!ownerId || !hosting) return null;
  const existing = await database
    .selectFrom("personalSettings")
    .select("singletonKey")
    .where("singletonKey", "=", "personal")
    .executeTakeFirst();
  if (!existing) await mkdir(config.agentHome, { recursive: true });
  const path = await realpath(config.agentHome);
  await withPersonalTransaction(database, async (transaction) => {
    const owner = await transaction
      .selectFrom("users")
      .select("displayName")
      .where("id", "=", ownerId)
      .executeTakeFirstOrThrow();
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
    await transaction
      .insertInto("personalSettings")
      .values({
        singletonKey: "personal",
        ownerId,
        agentHomeComputerId: hosting.id,
        agentHomePath: path,
        voiceThreadId: null,
        timeZone: null,
        quietTaskDays: 0,
        executionPreferences: { accessMode: "approval-required", history: [] },
        backgroundModelPreferences: { roles: {}, excludedAccounts: [] },
      })
      .onConflict((c) => c.column("singletonKey").doNothing())
      .execute();
  });
  const settings = await personalSettings(database);
  if (
    settings.ownerId !== ownerId ||
    settings.agentHome.computerId !== hosting.id ||
    settings.agentHome.path !== path
  )
    throw new OpensteerError({
      code: "conflict",
      message: "Personal owner and agent home do not match durable Host state",
    });
  return new FolderAdmissionService({
    hostingComputerId: hosting.id,
    ownerId,
    environmentId: config.environmentId,
    agentHome: settings.agentHome,
    assertOwner: (userId) => requirePersonalOwner(database, userId),
  });
}
