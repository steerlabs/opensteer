import { randomUUID } from "node:crypto";
import { OpensteerError, type BrowserProfileId, type RunnerId, type UserId } from "@opensteer/core";
import {
  BrowserProfileStorageSchema,
  type BrowserProfileStorage,
  type FrozenProfileSeed,
  type HeldLocalProfile,
  type LocalProfileBinding,
  type PendingBrowserProfileDeletion,
  type BrowserSessionId,
} from "@opensteer/protocol";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import { withDatabaseTransaction } from "./connection.js";
import type { BrowserProfileTable, BrowserProfileDeletionTable, DatabaseSchema } from "./schema.js";
import { deleteBrowserProfileInTransaction } from "./browser-session-store.js";

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
  );
}

export function profileStorage(row: Selectable<BrowserProfileTable>): BrowserProfileStorage {
  return BrowserProfileStorageSchema.parse(
    row.storageState === "vault"
      ? { kind: "vault" }
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
          seed: { revision: Number(row.frozenSeedRevision), digest: row.frozenSeedDigest },
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
function sameSeed(left: FrozenProfileSeed, right: FrozenProfileSeed): boolean {
  return left.revision === right.revision && left.digest === right.digest;
}
function conflict(message: string): never {
  throw new OpensteerError({ code: "conflict", message });
}
function bindingColumns(binding: LocalProfileBinding, seed: FrozenProfileSeed) {
  return {
    storageBindingVersion: binding.version,
    storageDeploymentId: binding.deploymentId,
    storageRunnerId: binding.runnerId,
    storageInstanceId: binding.storageInstanceId,
    storageBindingId: binding.bindingId,
    storageEngine: binding.engine,
    frozenSeedRevision: seed.revision,
    frozenSeedDigest: seed.digest,
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
    .executeTakeFirst();
  const deployment = await transaction
    .selectFrom("deployments")
    .select("id")
    .where("id", "=", binding.deploymentId)
    .executeTakeFirst();
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
    .executeTakeFirst();
  if (!row || row.archivedAt)
    throw new OpensteerError({ code: "not_found", message: "Browser profile not found" });
  return profileStorage(row);
}

export async function reserveBrowserProfileInitialization(
  database: Kysely<DatabaseSchema>,
  input: {
    binding: LocalProfileBinding;
    seed: FrozenProfileSeed;
    tokenHash: string;
    expiresAt: Date;
    adoptExistingBinding?: boolean;
  },
): Promise<BrowserProfileStorage> {
  return withDatabaseTransaction(database, async (transaction) => {
    await lockBrowserProfile(transaction, input.binding.profileId);
    const row = await transaction
      .selectFrom("browserProfiles")
      .selectAll()
      .where("id", "=", input.binding.profileId)
      .executeTakeFirst();
    if (!row || row.archivedAt)
      throw new OpensteerError({ code: "not_found", message: "Browser profile not found" });
    await validateBindingOwner(transaction, input.binding, row.ownerId);
    const storage = profileStorage(row);
    if (storage.kind !== "vault") {
      if (
        input.adoptExistingBinding &&
        storage.binding.deploymentId === input.binding.deploymentId &&
        storage.binding.runnerId === input.binding.runnerId &&
        storage.binding.storageInstanceId === input.binding.storageInstanceId &&
        storage.binding.engine === input.binding.engine
      )
        return storage;
      if (
        !sameProfileBinding(storage.binding, input.binding) ||
        !sameSeed(storage.seed, input.seed)
      )
        conflict("Browser profile binding changed. Open it on its owning computer.");
      if (storage.kind === "local") return storage;
    } else {
      const holder = await transaction
        .selectFrom("browserSessions")
        .select("id")
        .where("profileId", "=", row.id)
        .where("leaseTokenHash", "is not", null)
        .where((eb) =>
          eb.or([
            eb("state", "in", ["starting", "ready", "closing"]),
            eb("profileLeaseExpiresAt", ">", new Date()),
          ]),
        )
        .executeTakeFirst();
      if (holder)
        conflict(
          "Close this profile's existing browser and wait for its final save before converting it.",
        );
      if (row.revision !== input.seed.revision)
        conflict("Browser profile revision changed. Open the profile again.");
    }
    await transaction
      .updateTable("browserProfiles")
      .set({
        ...bindingColumns(input.binding, input.seed),
        storageState: "initializing",
        initializationTokenHash: input.tokenHash,
        initializationTokenExpiresAt: input.expiresAt,
        updatedAt: new Date(),
      })
      .where("id", "=", row.id)
      .execute();
    return { kind: "initializing", binding: input.binding, seed: input.seed };
  });
}

export async function readBrowserProfileInitialization(
  database: Kysely<DatabaseSchema>,
  input: { profileId: BrowserProfileId; tokenHash: string },
) {
  return withDatabaseTransaction(database, async (transaction) => {
    await lockBrowserProfile(transaction, input.profileId);
    const row = await transaction
      .selectFrom("browserProfiles")
      .selectAll()
      .where("id", "=", input.profileId)
      .executeTakeFirst();
    if (
      !row ||
      row.archivedAt ||
      row.storageState !== "initializing" ||
      row.initializationTokenHash !== input.tokenHash ||
      !row.initializationTokenExpiresAt ||
      row.initializationTokenExpiresAt <= new Date()
    )
      throw new OpensteerError({
        code: "forbidden",
        message: "Profile initialization authorization expired or is no longer valid.",
      });
    const storage = profileStorage(row);
    if (storage.kind !== "initializing") throw new Error("Profile is not initializing");
    const revision =
      storage.seed.revision === 0
        ? null
        : await transaction
            .selectFrom("browserProfileRevisions")
            .selectAll()
            .where("profileId", "=", input.profileId)
            .where("revision", "=", storage.seed.revision)
            .executeTakeFirst();
    if (storage.seed.revision > 0 && !revision)
      conflict(
        "The frozen profile seed is unavailable. Restore this computer's profile storage; another revision cannot be used.",
      );
    return { ...storage, revision };
  });
}

export async function completeBrowserProfileInitialization(
  database: Kysely<DatabaseSchema>,
  input: { binding: LocalProfileBinding; seed: FrozenProfileSeed; tokenHash: string },
): Promise<BrowserProfileStorage> {
  return withDatabaseTransaction(database, async (transaction) => {
    await lockBrowserProfile(transaction, input.binding.profileId);
    const row = await transaction
      .selectFrom("browserProfiles")
      .selectAll()
      .where("id", "=", input.binding.profileId)
      .executeTakeFirst();
    if (!row || row.archivedAt)
      throw new OpensteerError({ code: "not_found", message: "Browser profile not found" });
    const storage = profileStorage(row);
    if (
      storage.kind === "vault" ||
      !sameProfileBinding(storage.binding, input.binding) ||
      !sameSeed(storage.seed, input.seed)
    )
      conflict("Browser profile initialization binding does not match.");
    if (storage.kind === "local") return storage;
    if (
      row.initializationTokenHash !== input.tokenHash ||
      !row.initializationTokenExpiresAt ||
      row.initializationTokenExpiresAt <= new Date()
    )
      throw new OpensteerError({
        code: "forbidden",
        message: "Profile initialization authorization expired.",
      });
    await transaction
      .updateTable("browserProfiles")
      .set({
        storageState: "local",
        initializationTokenHash: null,
        initializationTokenExpiresAt: null,
        updatedAt: new Date(),
      })
      .where("id", "=", row.id)
      .execute();
    return { ...storage, kind: "local" };
  });
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
    .executeTakeFirst();
  const deletion =
    row ??
    (await transaction
      .selectFrom("browserProfileDeletions")
      .selectAll()
      .where("profileId", "=", binding.profileId)
      .executeTakeFirstOrThrow());
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
    .execute();
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
    .execute();
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
      .executeTakeFirst();
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
      .execute();
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
      .executeTakeFirst();
    // Inventory is evidence of storage, never authority to create an identity or grant.
    if (!row)
      conflict(
        "This computer holds an unknown browser profile. Restore its Host ownership records before opening it.",
      );
    await validateBindingOwner(transaction, claim.binding, row.ownerId);
    const storage = profileStorage(row);
    if (
      storage.kind !== "vault" &&
      (!sameProfileBinding(storage.binding, claim.binding) ||
        (claim.phase !== "deleted" && !sameSeed(storage.seed, claim.seed)))
    )
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
        .executeTakeFirstOrThrow();
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
          .execute();
      return;
    }
    if (row.archivedAt) {
      await recordBrowserProfileDeletion(transaction, claim.binding);
      return;
    }
    if (storage.kind === "local") return;
    // A restored legacy writer must lose both execution and final-save authority.
    await transaction
      .updateTable("browserSessions")
      .set({
        state: "failed",
        leaseTokenHash: null,
        profileLeaseExpiresAt: new Date(),
        updatedAt: new Date(),
      })
      .where("profileId", "=", row.id)
      .where("leaseTokenHash", "is not", null)
      .execute();
    await transaction
      .updateTable("browserProfiles")
      .set({
        ...bindingColumns(claim.binding, claim.seed),
        storageState: claim.phase === "ready" ? "local" : "initializing",
        initializationTokenHash: null,
        initializationTokenExpiresAt: null,
        updatedAt: new Date(),
      })
      .where("id", "=", row.id)
      .execute();
  });
}
