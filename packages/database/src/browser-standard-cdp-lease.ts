import { OpensteerError, type BrowserProfileId, type RunnerId, type UserId } from "@opensteer/core";
import type { BrowserSessionId } from "@opensteer/protocol";
import { sql, type Kysely } from "kysely";
import { lockBrowserProfile } from "./browser-profile-storage-store.js";
import { recordReconciledConnectionCdpAttempt } from "./connection-disconnect.js";
import { databaseOperationOptions } from "./operation-budget.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import type { DatabaseSchema } from "./schema.js";

export interface BrowserStandardCdpLease {
  readonly profileId: BrowserProfileId;
  readonly sessionId: BrowserSessionId;
  readonly generation: number;
  readonly bootId?: string;
  readonly relayId?: string;
  readonly attemptId?: string;
}

export async function listBrowserStandardCdpLeases(
  database: Kysely<DatabaseSchema>,
  runnerId: RunnerId,
): Promise<BrowserStandardCdpLease[]> {
  const { rows } = await sql<
    Omit<BrowserStandardCdpLease, "bootId" | "relayId" | "attemptId"> & {
      bootId: string | null;
      relayId: string | null;
      attemptId: string | null;
    }
  >`
    select b.profile_id as "profileId", b.id as "sessionId",
      (lease.value->>'exclusiveGeneration')::bigint::float8 as generation,
      lease.value->>'bootId' as "bootId", lease.value->>'relayId' as "relayId",
      lease.value->>'attemptId' as "attemptId"
    from browser_sessions b
    cross join lateral jsonb_each(b.standard_cdp_attempts) as lease
    where b.runner_id = ${runnerId} and b.profile_id is not null
      and lease.value ? 'exclusiveGeneration'
    order by generation
  `.execute(database);
  return rows.map(({ profileId, sessionId, generation, bootId, relayId, attemptId }) => ({
    profileId,
    sessionId,
    generation,
    ...(bootId ? { bootId } : {}),
    ...(relayId ? { relayId } : {}),
    ...(attemptId ? { attemptId } : {}),
  }));
}

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
  input: BrowserStandardCdpLease & { readonly ownerId: UserId; readonly bindingId: string },
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
          ${JSON.stringify({
            bindingId: input.bindingId,
            exclusiveGeneration: input.generation,
            bootId: input.bootId,
            relayId: input.relayId,
            attemptId: input.attemptId,
          })}::jsonb
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
  input: BrowserStandardCdpLease,
  reconciliation?: { readonly contactLost: boolean },
): Promise<void> {
  return commitPersonalMutation(database, async (transaction) => {
    await lockBrowserProfile(transaction, input.profileId);
    const result = await transaction
      .updateTable("browserSessions")
      .set({ standardCdpAttempts: sql`standard_cdp_attempts - ${String(input.generation)}::text` })
      .where("id", "=", input.sessionId)
      .where("profileId", "=", input.profileId)
      .where(sql<boolean>`standard_cdp_attempts ? ${String(input.generation)}`)
      .executeTakeFirst(databaseOperationOptions());
    if (result.numUpdatedRows === 1n && reconciliation && input.attemptId)
      await recordReconciledConnectionCdpAttempt(
        transaction,
        input.sessionId,
        input.attemptId,
        reconciliation.contactLost,
      );
  });
}

function exclusiveLeaseConflict(): OpensteerError {
  return new OpensteerError({
    code: "conflict",
    reason: "browser-profile-exclusively-held",
    message: "Another attachment holds exclusive access to this browser profile.",
  });
}
