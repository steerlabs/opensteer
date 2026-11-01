import { OpensteerError, type BrowserProfileId, type RunnerId, type UserId } from "@opensteer/core";
import {
  BrowserProfileStorageSchema,
  type BrowserProfileStorage,
  type BrowserSessionId,
  type HeldLocalProfile,
  type LocalProfileBinding,
  type PendingBrowserProfileDeletion,
} from "@opensteer/protocol";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import { randomUUID } from "node:crypto";
import { deleteBrowserProfileInTransaction } from "./browser-session-store.js";
import { withDatabaseTransaction } from "./connection.js";
import { databaseOperationOptions } from "./operation-budget.js";
import type { BrowserProfileDeletionTable, BrowserProfileTable, DatabaseSchema } from "./schema.js";

export interface NativeProfileDeletionResult {
  readonly sessionIds: readonly BrowserSessionId[];
  readonly deletion?: PendingBrowserProfileDeletion;
}

export function lockBrowserProfile(
  transaction: Transaction<DatabaseSchema>,
  profileId: BrowserProfileId,
) {
  return sql`select pg_advisory_xact_lock(hashtextextended(${`browser-profile-session:${profileId}`}, 0))`.execute(
    transaction,
    databaseOperationOptions(),
  );
}

export function profileStorage(row: Selectable<BrowserProfileTable>): BrowserProfileStorage {
  return BrowserProfileStorageSchema.parse(
    row.storageState === "unbound"
      ? { kind: "unbound" }
      : {
          kind: row.storageState,
          binding: {
            version: row.storageBindingVersion,
            deploymentId: row.storageDeploymentId,
            profileId: row.id,
            runnerId: row.storageRunnerId,
            storageInstanceId: row.storageInstanceId,
            bindingId: row.storageBindingId,
            engine: row.storageEngine,
          },
          initialized: row.initialized,
        },
  );
}

export function sameProfileBinding(left: LocalProfileBinding, right: LocalProfileBinding): boolean {
  return (
    left.version === right.version &&
    left.deploymentId === right.deploymentId &&
    left.profileId === right.profileId &&
    left.runnerId === right.runnerId &&
    left.storageInstanceId === right.storageInstanceId &&
    left.bindingId === right.bindingId &&
    left.engine === right.engine
  );
}
function conflict(message: string): never {
  throw new OpensteerError({ code: "conflict", message });
}
function bindingColumns(binding: LocalProfileBinding) {
  return {
    storageBindingVersion: binding.version,
    storageDeploymentId: binding.deploymentId,
    storageRunnerId: binding.runnerId,
    storageInstanceId: binding.storageInstanceId,
    storageBindingId: binding.bindingId,
    storageEngine: binding.engine,
  };
}

async function validateBindingOwner(
  transaction: Transaction<DatabaseSchema>,
  binding: LocalProfileBinding,
  ownerId: UserId,
) {
  const runner = await transaction
    .selectFrom("runners")
    .select(["ownerKind", "ownerUserId", "allowedModules", "revokedAt"])
    .where("id", "=", binding.runnerId)
    .executeTakeFirst(databaseOperationOptions());
  const deployment = await transaction
    .selectFrom("deployments")
    .select("id")
    .where("id", "=", binding.deploymentId)
    .executeTakeFirst(databaseOperationOptions());
  if (
    !deployment ||
    !runner ||
    runner.revokedAt ||
    !runner.allowedModules.includes("browser") ||
    (runner.ownerKind === "user" && runner.ownerUserId !== ownerId)
  )
    conflict(
      "Browser profile inventory requires the original computer ownership and browser grant.",
    );
}

export async function getBrowserProfileStorage(
  database: Kysely<DatabaseSchema>,
  profileId: BrowserProfileId,
) {
  const row = await database
    .selectFrom("browserProfiles")
    .selectAll()
    .where("id", "=", profileId)
    .executeTakeFirst(databaseOperationOptions());
  if (!row || row.archivedAt)
    throw new OpensteerError({ code: "not_found", message: "Browser profile not found" });
  return profileStorage(row);
}

export function deletionBinding(row: Selectable<BrowserProfileDeletionTable>): LocalProfileBinding {
  return {
    version: row.bindingVersion,
    deploymentId: row.deploymentId,
    runnerId: row.runnerId,
    profileId: row.profileId,
    storageInstanceId: row.storageInstanceId,
    bindingId: row.bindingId,
    engine: row.engine,
  };
}
export function publicProfileDeletion(
  row: Selectable<BrowserProfileDeletionTable>,
): PendingBrowserProfileDeletion | undefined {
  return row.state === "deleted"
    ? undefined
    : { profileId: row.profileId, computerId: row.runnerId, state: row.state };
}
export async function recordBrowserProfileDeletion(
  transaction: Transaction<DatabaseSchema>,
  binding: LocalProfileBinding,
  deletionId: string = randomUUID(),
) {
  const row = await transaction
    .insertInto("browserProfileDeletions")
    .values({
      deletionId,
      profileId: binding.profileId,
      bindingVersion: binding.version,
      deploymentId: binding.deploymentId,
      runnerId: binding.runnerId,
      storageInstanceId: binding.storageInstanceId,
      bindingId: binding.bindingId,
      engine: binding.engine,
      state: "pending-computer",
      deletedAt: null,
    })
    .onConflict((oc) => oc.column("profileId").doNothing())
    .returningAll()
    .executeTakeFirst(databaseOperationOptions());
  const deletion =
    row ??
    (await transaction
      .selectFrom("browserProfileDeletions")
      .selectAll()
      .where("profileId", "=", binding.profileId)
      .executeTakeFirstOrThrow(databaseOperationOptions()));
  if (!sameProfileBinding(deletionBinding(deletion), binding))
    conflict("Browser profile erasure binding does not match.");
  return deletion;
}
export async function listBrowserProfileErasureJobs(
  database: Kysely<DatabaseSchema>,
  runnerId: RunnerId,
) {
  const rows = await database
    .selectFrom("browserProfileDeletions")
    .selectAll()
    .where("runnerId", "=", runnerId)
    .where("state", "!=", "deleted")
    .execute(databaseOperationOptions());
  return rows.map((row) => ({
    binding: deletionBinding(row),
    deletionId: row.deletionId,
    state: row.state,
  }));
}
export async function listPendingBrowserProfileDeletions(
  database: Kysely<DatabaseSchema>,
  ownerId: UserId,
) {
  const rows = await database
    .selectFrom("browserProfileDeletions as deletion")
    .innerJoin("browserProfiles as profile", "profile.id", "deletion.profileId")
    .select(["deletion.profileId", "deletion.runnerId as computerId", "deletion.state"])
    .where("profile.ownerId", "=", ownerId)
    .where("deletion.state", "!=", "deleted")
    .execute(databaseOperationOptions());
  return rows.flatMap((row) => (row.state === "deleted" ? [] : [{ ...row, state: row.state }]));
}
export async function acknowledgeBrowserProfileDeletion(
  database: Kysely<DatabaseSchema>,
  input: { binding: LocalProfileBinding; deletionId: string; state: "pending-restart" | "deleted" },
) {
  return withDatabaseTransaction(database, async (transaction) => {
    await lockBrowserProfile(transaction, input.binding.profileId);
    const row = await transaction
      .selectFrom("browserProfileDeletions")
      .selectAll()
      .where("profileId", "=", input.binding.profileId)
      .executeTakeFirst(databaseOperationOptions());
    if (
      !row ||
      row.deletionId !== input.deletionId ||
      !sameProfileBinding(deletionBinding(row), input.binding)
    )
      conflict("Browser profile erasure binding does not match.");
    if (row.state === "deleted") return;
    await transaction
      .updateTable("browserProfileDeletions")
      .set({
        state: input.state,
        updatedAt: new Date(),
        deletedAt: input.state === "deleted" ? new Date() : null,
      })
      .where("deletionId", "=", row.deletionId)
      .execute(databaseOperationOptions());
  });
}

export async function reconcileBrowserProfileInventory(
  database: Kysely<DatabaseSchema>,
  claim: HeldLocalProfile,
) {
  return withDatabaseTransaction(database, async (transaction) => {
    await lockBrowserProfile(transaction, claim.binding.profileId);
    const row = await transaction
      .selectFrom("browserProfiles")
      .selectAll()
      .where("id", "=", claim.binding.profileId)
      .executeTakeFirst(databaseOperationOptions());
    // Inventory is evidence of storage, never authority to create an identity or grant.
    if (!row)
      conflict(
        "This computer holds an unknown browser profile. Restore its Host ownership records before opening it.",
      );
    await validateBindingOwner(transaction, claim.binding, row.ownerId);
    const storage = profileStorage(row);
    if (storage.kind !== "local" || !sameProfileBinding(storage.binding, claim.binding))
      conflict(
        "This computer's browser profile binding conflicts with the Host. Restore the matching storage instance.",
      );
    if (claim.phase === "deleted") {
      // Retain the tombstone identity when rolling forward a pre-conversion database.
      await deleteBrowserProfileInTransaction(transaction, {
        ownerId: row.ownerId,
        profileId: row.id,
        deletionId: claim.deletionId,
        binding: claim.binding,
      });
      const deletion = await transaction
        .selectFrom("browserProfileDeletions")
        .selectAll()
        .where("profileId", "=", row.id)
        .executeTakeFirstOrThrow(databaseOperationOptions());
      if (deletion.deletionId !== claim.deletionId)
        conflict("This computer's deletion tombstone conflicts with the Host.");
      if (deletion.state !== "deleted")
        await transaction
          .updateTable("browserProfileDeletions")
          .set({
            state: claim.erasure,
            deletedAt: claim.erasure === "deleted" ? new Date() : null,
            updatedAt: new Date(),
          })
          .where("profileId", "=", row.id)
          .execute(databaseOperationOptions());
      return;
    }
    if (row.archivedAt) {
      await recordBrowserProfileDeletion(transaction, claim.binding);
      return;
    }
    await transaction
      .updateTable("browserProfiles")
      .set({ initialized: true })
      .where("id", "=", row.id)
      .execute(databaseOperationOptions());
  });
}

/** Bind metadata once, before issuing signed first-open authority. */
export async function bindBrowserProfile(
  database: Kysely<DatabaseSchema>,
  binding: LocalProfileBinding,
) {
  return withDatabaseTransaction(database, async (transaction) => {
    await lockBrowserProfile(transaction, binding.profileId);
    const row = await transaction
      .selectFrom("browserProfiles")
      .selectAll()
      .where("id", "=", binding.profileId)
      .executeTakeFirst(databaseOperationOptions());
    if (!row || row.archivedAt)
      throw new OpensteerError({ code: "not_found", message: "Browser profile not found" });
    await validateBindingOwner(transaction, binding, row.ownerId);
    const storage = profileStorage(row);
    if (storage.kind === "local") {
      if (
        storage.binding.runnerId !== binding.runnerId ||
        storage.binding.storageInstanceId !== binding.storageInstanceId ||
        storage.binding.engine !== binding.engine
      )
        conflict("This profile is bound to its original computer and storage instance.");
      return storage;
    }
    const bound = await transaction
      .updateTable("browserProfiles")
      .set({
        ...bindingColumns(binding),
        storageState: "local",
        initialized: false,
        updatedAt: new Date(),
      })
      .where("id", "=", row.id)
      .returningAll()
      .executeTakeFirstOrThrow(databaseOperationOptions());
    return profileStorage(bound);
  });
}
export async function acknowledgeBrowserProfileReady(
  database: Kysely<DatabaseSchema>,
  binding: LocalProfileBinding,
): Promise<void> {
  await withDatabaseTransaction(database, async (transaction) => {
    await lockBrowserProfile(transaction, binding.profileId);
    const row = await transaction
      .selectFrom("browserProfiles")
      .selectAll()
      .where("id", "=", binding.profileId)
      .executeTakeFirst(databaseOperationOptions());
    if (!row || row.archivedAt) conflict("This browser profile is unavailable.");
    const storage = profileStorage(row);
    if (storage.kind !== "local" || !sameProfileBinding(storage.binding, binding))
      conflict("The native browser profile binding does not match.");
    await validateBindingOwner(transaction, binding, row.ownerId);
    await transaction
      .updateTable("browserProfiles")
      .set({ initialized: true, updatedAt: new Date() })
      .where("id", "=", row.id)
      .execute(databaseOperationOptions());
  });
}
