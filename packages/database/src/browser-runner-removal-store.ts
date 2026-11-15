import type { BrowserProfileId, RunnerId } from "@opensteer/core";
import type { Transaction } from "kysely";
import { randomUUID } from "node:crypto";
import { profileStorage } from "./browser-profile-storage-store.js";
import type { DatabaseSchema } from "./schema.js";
import { databaseOperationOptions } from "./operation-budget.js";

export async function archiveRunnerBrowserProfiles(
  transaction: Transaction<DatabaseSchema>,
  profileIds: readonly BrowserProfileId[],
  now: Date,
) {
  if (!profileIds.length) return [];
  const profiles = await transaction
    .selectFrom("browserProfiles")
    .selectAll()
    .where("id", "in", profileIds)
    .orderBy("id")
    .forNoKeyUpdate()
    .execute(databaseOperationOptions());
  await transaction
    .selectFrom("browserHistoryEntries")
    .select("url")
    .where("profileId", "in", profileIds)
    .orderBy("profileId")
    .orderBy("url")
    // FOR UPDATE: The archived profiles' history is deleted below.
    .forUpdate()
    .execute(databaseOperationOptions());
  await transaction
    .selectFrom("browserHistoryIcons")
    .select("origin")
    .where("profileId", "in", profileIds)
    .orderBy("profileId")
    .orderBy("origin")
    // FOR UPDATE: The archived profiles' icons are deleted below.
    .forUpdate()
    .execute(databaseOperationOptions());
  await transaction
    .updateTable("browserProfiles")
    .set({ archivedAt: now, updatedAt: now })
    .where("id", "in", profileIds)
    .where("archivedAt", "is", null)
    .execute(databaseOperationOptions());
  await transaction
    .deleteFrom("browserHistoryEntries")
    .where("profileId", "in", profileIds)
    .execute(databaseOperationOptions());
  await transaction
    .deleteFrom("browserHistoryIcons")
    .where("profileId", "in", profileIds)
    .execute(databaseOperationOptions());
  await transaction
    .selectFrom("browserSessionAttachments")
    .select("sessionId")
    .where(
      "sessionId",
      "in",
      transaction.selectFrom("browserSessions").select("id").where("profileId", "in", profileIds),
    )
    .orderBy("sessionId")
    .orderBy("agentBindingId")
    // FOR UPDATE: Revocation deletes the affected sessions' attachments.
    .forUpdate()
    .execute(databaseOperationOptions());
  return profiles;
}

export async function lockRunnerBrowserProfileRemoval(
  transaction: Transaction<DatabaseSchema>,
  runnerId: RunnerId,
) {
  await transaction
    .selectFrom("browserProfileDeletions")
    .select("deletionId")
    .where("runnerId", "=", runnerId)
    .orderBy("deletionId")
    .forNoKeyUpdate()
    .execute(databaseOperationOptions());
}

export async function finishRunnerBrowserProfileRemoval(
  transaction: Transaction<DatabaseSchema>,
  runnerId: RunnerId,
  profiles: Awaited<ReturnType<typeof archiveRunnerBrowserProfiles>>,
  now: Date,
) {
  await lockRunnerBrowserProfileRemoval(transaction, runnerId);
  const values = profiles.flatMap((profile) => {
    const storage = profileStorage(profile);
    if (storage.kind === "unbound") return [];
    const binding = storage.binding;
    return [
      {
        deletionId: randomUUID(),
        profileId: profile.id,
        bindingVersion: binding.version,
        deploymentId: binding.deploymentId,
        runnerId: binding.runnerId,
        storageInstanceId: binding.storageInstanceId,
        bindingId: binding.bindingId,
        engine: binding.engine,
        state: "unconfirmed" as const,
        deletedAt: null,
      },
    ];
  });
  if (values.length)
    await transaction
      .insertInto("browserProfileDeletions")
      .values(values)
      .onConflict((oc) => oc.column("profileId").doNothing())
      .execute(databaseOperationOptions());
  await transaction
    .updateTable("browserProfileDeletions")
    .set({ state: "unconfirmed", updatedAt: now })
    .where("runnerId", "=", runnerId)
    .where("state", "!=", "deleted")
    .execute(databaseOperationOptions());
}
