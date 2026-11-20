import { OpensteerError, type BrowserProfileId, type UserId } from "@opensteer/core";
import type { BrowserSessionId } from "@opensteer/protocol";
import { sql, type Kysely } from "kysely";
import { lockBrowserProfile } from "./browser-profile-storage-store.js";
import { databaseOperationOptions } from "./operation-budget.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import type { DatabaseSchema } from "./schema.js";

export async function requireNoBrowserStandardCdpLease(
  database: Kysely<DatabaseSchema>,
  profileId: BrowserProfileId,
  bindingId?: string,
): Promise<void> {
  const active = await database
    .selectFrom("browserSessions")
    .select("id")
    .where("profileId", "=", profileId)
    .where(
      sql<boolean>`
      exists (select 1 from jsonb_each(standard_cdp_attempts) as lease
        where lease.value ? 'exclusiveGeneration'
        and lease.value->>'bindingId' is distinct from ${bindingId ?? null})
    `,
    )
    .executeTakeFirst(databaseOperationOptions());
  if (active) throw exclusiveLeaseConflict();
}

/** The attempt stays recorded if the Home loses contact before Runtime settlement. */
export function acquireBrowserStandardCdpLease(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly profileId: BrowserProfileId;
    readonly sessionId: BrowserSessionId;
    readonly ownerId: UserId;
    readonly bindingId: string;
    readonly generation: number;
  },
): Promise<void> {
  return commitPersonalMutation(database, async (transaction) => {
    await lockBrowserProfile(transaction, input.profileId);
    await requireNoBrowserStandardCdpLease(transaction, input.profileId);
    const profile = await transaction
      .selectFrom("browserProfiles")
      .select("id")
      .where("id", "=", input.profileId)
      .where("ownerId", "=", input.ownerId)
      .where("archivedAt", "is", null)
      .executeTakeFirst(databaseOperationOptions());
    if (!profile) throw exclusiveLeaseConflict();
    const other = await transaction
      .selectFrom("browserSessions")
      .select("id")
      .where("profileId", "=", input.profileId)
      .where("id", "!=", input.sessionId)
      .where("state", "not in", ["closed", "failed"])
      .executeTakeFirst(databaseOperationOptions());
    if (other) throw exclusiveLeaseConflict();
    const holders = await transaction
      .selectFrom("browserSessionAttachments")
      .select("agentBindingId")
      .where("sessionId", "=", input.sessionId)
      .execute(databaseOperationOptions());
    if (holders.length !== 1 || holders[0]?.agentBindingId !== input.bindingId)
      throw exclusiveLeaseConflict();
    const changed = await transaction
      .updateTable("browserSessions")
      .set({
        standardCdpAttempts: sql`standard_cdp_attempts || jsonb_build_object(
          ${String(input.generation)}::text,
          jsonb_build_object('bindingId', ${input.bindingId}::text, 'exclusiveGeneration', ${input.generation}::bigint)
        )`,
      })
      .where("id", "=", input.sessionId)
      .where("profileId", "=", input.profileId)
      .where("state", "=", "ready")
      .executeTakeFirst(databaseOperationOptions());
    if (changed.numUpdatedRows !== 1n) throw exclusiveLeaseConflict();
  });
}

export function releaseBrowserStandardCdpLease(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly profileId: BrowserProfileId;
    readonly sessionId: BrowserSessionId;
    readonly generation: number;
  },
): Promise<void> {
  return commitPersonalMutation(database, async (transaction) => {
    await lockBrowserProfile(transaction, input.profileId);
    await transaction
      .updateTable("browserSessions")
      .set({ standardCdpAttempts: sql`standard_cdp_attempts - ${String(input.generation)}::text` })
      .where("id", "=", input.sessionId)
      .where("profileId", "=", input.profileId)
      .execute(databaseOperationOptions());
  });
}

function exclusiveLeaseConflict(): OpensteerError {
  return new OpensteerError({
    code: "conflict",
    reason: "browser-profile-exclusively-held",
    message: "Another attachment holds exclusive access to this browser profile.",
  });
}
