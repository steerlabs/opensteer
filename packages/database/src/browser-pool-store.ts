import type { BrowserSurfaceId, RunnerId, UserId } from "@opensteer/core";
import { sql, type Kysely, type Selectable } from "kysely";
import { activePersonalMutation, commitPersonalMutation } from "./personal-mutation.js";
import type { DatabaseSchema } from "./schema.js";

export interface BrowserPoolTargetIdentity {
  readonly runnerId: RunnerId;
  readonly runtimeId: string;
  readonly slotId: string;
  readonly term: number;
  readonly instanceId: string;
  readonly epoch: number;
}

export type BrowserPoolSlot = Selectable<DatabaseSchema["browserPoolSlots"]>;
type LostBrowserDocument = Pick<
  DatabaseSchema["browserPoolDocumentLosses"],
  "sessionId" | "surfaceId" | "documentId"
>;

export class BrowserPoolAdmissionClosed extends Error {
  constructor(cause?: unknown) {
    super("The pooled browser is waiting for recovery.", { cause });
    this.name = "BrowserPoolAdmissionClosed";
  }
}

/** Pooled variants call this after the deployment fence and before locking any child. */
export async function requireBrowserPoolAdmission(
  tx: Kysely<DatabaseSchema>,
  runnerId: RunnerId,
  target?: BrowserPoolTargetIdentity,
): Promise<void> {
  if (
    !tx.isTransaction ||
    !activePersonalMutation(tx as Parameters<typeof activePersonalMutation>[0])
  )
    throw new Error("Browser pool admission requires the deployment fence.");
  const row = await readBrowserPoolSlot(tx, runnerId);
  if (row && (row.phase !== "running" || (target && !sameRuntime(row, target))))
    throw new BrowserPoolAdmissionClosed();
}

export function readBrowserPoolSlot(database: Kysely<DatabaseSchema>, runnerId: RunnerId) {
  return database
    .selectFrom("browserPoolSlots")
    .selectAll()
    .where("runnerId", "=", runnerId)
    .executeTakeFirst();
}

function sameRuntime(slot: BrowserPoolSlot, target: BrowserPoolTargetIdentity): boolean {
  return (
    slot.slotId === target.slotId &&
    slot.runtimeId === target.runtimeId &&
    slot.term === target.term &&
    slot.instanceId === target.instanceId &&
    slot.epoch === target.epoch
  );
}

/** D is ordered by the same deployment fence that admits browser work. */
export async function beginBrowserPoolPark(
  database: Kysely<DatabaseSchema>,
  target: BrowserPoolTargetIdentity,
  intentId: string,
  demanded: () => boolean,
): Promise<BrowserPoolSlot | undefined> {
  return commitPersonalMutation(
    database,
    async (tx) => {
      const current = await readBrowserPoolSlot(tx, target.runnerId);
      if (current && !sameRuntime(current, target)) throw new BrowserPoolAdmissionClosed();
      if (current?.intentId === intentId) return current;
      if (current && current.phase !== "running") throw new BrowserPoolAdmissionClosed();
      const { runnerId, runtimeId } = target;
      const blockers = await sql<{ blocked: boolean }>`
      select exists (
        select 1 from browser_sessions session
        where session.runner_id = ${runnerId} and session.runtime_id = ${runtimeId}
          and (
            session.state in ('starting', 'closing')
            or exists (
              select 1 from browser_session_attachments attachment
              where attachment.session_id = session.id
            )
            or exists (
              select 1 from jsonb_each(session.standard_cdp_attempts) attempt
              where attempt.value ? 'exclusiveGeneration'
                or attempt.value->>'terminalEvidenceAt' is null
            )
          )
        union all
        select 1 from browser_tab_opens
        where runner_id = ${runnerId} and binding->'outcome'->>'kind' = 'pending'
        union all
        select 1 from browser_profile_deletions
        where runner_id = ${runnerId} and state <> 'deleted'
        union all
        select 1 from browser_pool_relays relay
        where (relay.runner_id, relay.runtime_id, relay.slot_id, relay.term,
               relay.instance_id, relay.epoch) =
              (${runnerId}, ${runtimeId}, ${target.slotId}, ${target.term},
               ${target.instanceId}::uuid, ${target.epoch})
        union all
        select 1 from agent_operations operation
        left join browser_pool_agent_operations runtime on runtime.operation_id = operation.id
        where operation.handed_off_at is not null and operation.terminal_evidence_at is null
          and operation.target->'grant'->>'kind' = 'browser-profile'
          and (
            runtime.operation_id is null or
            (runtime.runner_id, runtime.runtime_id, runtime.slot_id, runtime.term,
             runtime.instance_id, runtime.epoch) =
            (${runnerId}, ${runtimeId}, ${target.slotId}, ${target.term},
             ${target.instanceId}::uuid, ${target.epoch})
          )
      ) as blocked
    `.execute(tx);
      // An older browser-profile hand-off without a runtime witness can still belong here.
      if (demanded() || blockers.rows[0]?.blocked !== false) return undefined;
      const next = {
        ...target,
        intentId,
        intentSequence: (current?.intentSequence ?? 0) + 1,
        attachmentGeneration: current?.attachmentGeneration ?? 1,
        phase: "preparing",
        retained: null,
      } as const;
      return tx
        .insertInto("browserPoolSlots")
        .values(next)
        .onConflict((oc) => oc.column("runnerId").doUpdateSet(next))
        .returningAll()
        .executeTakeFirstOrThrow();
    },
    undefined,
    "non-retrying",
  );
}

export async function advanceBrowserPoolSlot(
  database: Kysely<DatabaseSchema>,
  slot: BrowserPoolSlot,
  next: Pick<BrowserPoolSlot, "phase" | "epoch" | "retained"> &
    Partial<Pick<BrowserPoolSlot, "attachmentGeneration">>,
  losses?: readonly LostBrowserDocument[],
): Promise<BrowserPoolSlot> {
  return commitPersonalMutation(
    database,
    async (tx) => {
      const current = await readBrowserPoolSlot(tx, slot.runnerId);
      if (
        !current ||
        !sameRuntime(current, slot) ||
        current.intentId !== slot.intentId ||
        current.intentSequence !== slot.intentSequence ||
        current.attachmentGeneration !== slot.attachmentGeneration ||
        current.phase !== slot.phase
      )
        throw new BrowserPoolAdmissionClosed();
      const { phase, epoch, retained, attachmentGeneration = slot.attachmentGeneration } = next;
      const advanced = await tx
        .updateTable("browserPoolSlots")
        .set({ phase, epoch, retained, attachmentGeneration })
        .where("runnerId", "=", slot.runnerId)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (losses?.length) {
        const { ownerId } = await tx
          .selectFrom("personalSettings")
          .select("ownerId")
          .executeTakeFirstOrThrow();
        const sessions = await tx
          .selectFrom("browserSessions")
          .select("id")
          .where("id", "in", [...new Set(losses.map(({ sessionId }) => sessionId))])
          .where("runnerId", "=", slot.runnerId)
          .where("runtimeId", "=", slot.runtimeId)
          .execute();
        const owned = new Set(sessions.map(({ id }) => id));
        const notices = losses
          .filter(({ sessionId }) => owned.has(sessionId))
          .map(({ sessionId, surfaceId, documentId }) => ({
            sessionId,
            surfaceId,
            documentId,
            ownerId,
            intentId: slot.intentId,
            runnerId: slot.runnerId,
          }));
        if (notices.length) {
          await tx
            .insertInto("browserPoolDocumentLosses")
            .values(notices)
            .onConflict((conflict) => conflict.columns(["intentId", "surfaceId"]).doNothing())
            .execute();
        }
      }
      return advanced;
    },
    undefined,
    "non-retrying",
  );
}

export function listBrowserPoolDocumentLosses(
  database: Kysely<DatabaseSchema>,
  ownerId: UserId,
  surfaceId: BrowserSurfaceId,
) {
  return database
    .selectFrom("browserPoolDocumentLosses")
    .selectAll()
    .where("ownerId", "=", ownerId)
    .where("surfaceId", "=", surfaceId)
    .orderBy("lostAt", "desc")
    .execute();
}

export async function openBrowserPoolRelay(
  database: Kysely<DatabaseSchema>,
  id: string,
  target: BrowserPoolTargetIdentity,
) {
  await commitPersonalMutation(database, async (tx) => {
    await requireBrowserPoolAdmission(tx, target.runnerId, target);
    await tx
      .insertInto("browserPoolRelays")
      .values({ id, ...target })
      .execute();
  });
}

export async function settleBrowserPoolRelay(database: Kysely<DatabaseSchema>, id: string) {
  await database.deleteFrom("browserPoolRelays").where("id", "=", id).execute();
}
