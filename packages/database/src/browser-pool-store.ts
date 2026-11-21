import {
  OpensteerError,
  type BrowserSessionId,
  type BrowserSurfaceId,
  type RunnerId,
  type UserId,
} from "@opensteer/core";
import { sql, type Kysely, type Selectable } from "kysely";
import { randomUUID } from "node:crypto";
import { transitionBrowserSession } from "./browser-session-store.js";
import { activePersonalMutation, commitPersonalMutation } from "./personal-mutation.js";
import type { DatabaseSchema } from "./schema.js";

/** The fence of one pooled browser: issued by its physical controller, never read from it. */
export interface BrowserPoolTargetIdentity {
  readonly runnerId: RunnerId;
  readonly runtimeId: string;
  readonly slotId: string;
  readonly term: number;
  readonly instanceId: string;
  readonly epoch: number;
}

export type BrowserPoolSlot = Selectable<DatabaseSchema["browserPoolSlots"]>;
export type BrowserPoolControllerCallRow = Selectable<DatabaseSchema["browserPoolControllerCalls"]>;

export interface BrowserPoolSessionLoss {
  readonly sessionId: BrowserSessionId;
  readonly reason: string;
  readonly surfaces: readonly { readonly surfaceId: string; readonly documentId: string | null }[];
  /** False for a tab lost inside a session that was otherwise adopted. */
  readonly endSession?: boolean;
}

/**
 * A refusal before any effect: the operation that receives it settles as refused, never as
 * failed or unknown, because nothing reached the browser.
 */
export class BrowserPoolAdmissionClosed extends OpensteerError {
  constructor(message = "The pooled browser could not be reached in time.", cause?: unknown) {
    super({
      code: "runner_offline",
      message,
      reason: "browser-pool-unavailable",
      retryable: true,
      cause,
    });
    this.name = "BrowserPoolAdmissionClosed";
  }
}

/** A pending pooled tab open older than every open deadline no longer vetoes D. */
export const browserPoolTabOpenDeadlineMs = 30_000;
/** A relay command older than every agent request deadline no longer vetoes D. */
export const browserPoolRelayDeadlineMs = 60_000;
/** How long finished controller calls and seen loss notes are kept. */
export const browserPoolRetentionMs = 7 * 24 * 60 * 60_000;

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
  if (!row || row.phase !== "running" || (target && !sameRuntime(row, target)))
    throw new BrowserPoolAdmissionClosed("The pooled browser is between states. Try again.");
}

export function readBrowserPoolSlot(database: Kysely<DatabaseSchema>, runnerId: RunnerId) {
  return database
    .selectFrom("browserPoolSlots")
    .selectAll()
    .where("runnerId", "=", runnerId)
    .executeTakeFirst();
}

export function browserPoolSlotIdentity(slot: BrowserPoolSlot): BrowserPoolTargetIdentity {
  const { runnerId, runtimeId, slotId, term, instanceId, epoch } = slot;
  return { runnerId, runtimeId, slotId, term, instanceId, epoch };
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

/** Records the first installed fence of a slot. A slot already recorded is never replaced here. */
export async function installBrowserPoolSlot(
  database: Kysely<DatabaseSchema>,
  target: BrowserPoolTargetIdentity,
): Promise<BrowserPoolSlot> {
  return commitPersonalMutation(
    database,
    async (tx) => {
      const current = await tx
        .selectFrom("browserPoolSlots")
        .selectAll()
        .where("runnerId", "=", target.runnerId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (current) {
        if (!sameRuntime(current, target)) throw new BrowserPoolAdmissionClosed();
        return current;
      }
      return tx
        .insertInto("browserPoolSlots")
        .values({
          ...target,
          intentSequence: 0,
          intentId: null,
          attachmentGeneration: 1,
          phase: "running",
          retained: null,
          savedState: null,
          outcome: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    },
    undefined,
    "non-retrying",
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
      const current = await tx
        .selectFrom("browserPoolSlots")
        .selectAll()
        .where("runnerId", "=", target.runnerId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!current || !sameRuntime(current, target)) throw new BrowserPoolAdmissionClosed();
      if (current.intentId === intentId) return current;
      if (current.phase !== "running") throw new BrowserPoolAdmissionClosed();
      const { runnerId, runtimeId } = target;
      const blockers = await sql<{ blocked: boolean }>`
      select exists (
        select 1 from browser_sessions session
        where session.runner_id = ${runnerId} and session.runtime_id = ${runtimeId}
          and (
            session.state in ('starting', 'closing')
            -- Adoption does not rebuild a Trigger or Watch program's session yet.
            or (session.origin = 'trigger' and session.state = 'ready')
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
          and created_at > now() - make_interval(secs => ${browserPoolTabOpenDeadlineMs / 1000})
        union all
        select 1 from browser_profile_deletions
        where runner_id = ${runnerId} and state <> 'deleted'
        union all
        -- A relay whose reply was lost vetoes until the relay deadline: by then the runtime's
        -- own command drain decides, and the retire vetoes anything still in flight.
        select 1 from browser_pool_relays relay
        where (relay.runner_id, relay.runtime_id, relay.slot_id, relay.term,
               relay.instance_id, relay.epoch) =
              (${runnerId}, ${runtimeId}, ${target.slotId}, ${target.term},
               ${target.instanceId}::uuid, ${target.epoch})
          and relay.created_at > now() - make_interval(secs => ${browserPoolRelayDeadlineMs / 1000})
        union all
        -- Only an executor that has not returned vetoes; a settled unknown is settled.
        select 1 from agent_operations operation
        where operation.state = 'handed-off'
          and operation.target->'grant'->>'kind' = 'browser-profile'
      ) as blocked
    `.execute(tx);
      if (demanded() || blockers.rows[0]?.blocked !== false) return undefined;
      return tx
        .updateTable("browserPoolSlots")
        .set({
          intentId,
          intentSequence: current.intentSequence + 1,
          phase: "preparing",
          retained: null,
          savedState: null,
        })
        .where("runnerId", "=", runnerId)
        .returningAll()
        .executeTakeFirstOrThrow();
    },
    undefined,
    "non-retrying",
  );
}

export interface BrowserPoolSlotChange {
  readonly phase: BrowserPoolSlot["phase"];
  readonly retained?: BrowserPoolSlot["retained"];
  readonly savedState?: BrowserPoolSlot["savedState"];
  readonly outcome?: BrowserPoolSlot["outcome"];
  readonly attachmentGeneration?: number;
  /** A new fence from the controller: a resume (epoch) or a fresh start (instance). */
  readonly fence?: Pick<BrowserPoolTargetIdentity, "instanceId" | "epoch">;
}

/**
 * Advances the slot by compare-and-set on its intent, phase, fence and attachment generation.
 * Sessions that could not be brought back end in the same transaction, with a note per tab.
 */
export async function advanceBrowserPoolSlot(
  database: Kysely<DatabaseSchema>,
  slot: BrowserPoolSlot,
  next: BrowserPoolSlotChange,
  losses: readonly BrowserPoolSessionLoss[] = [],
): Promise<BrowserPoolSlot> {
  return commitPersonalMutation(
    database,
    async (tx) => {
      const current = await tx
        .selectFrom("browserPoolSlots")
        .selectAll()
        .where("runnerId", "=", slot.runnerId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (
        !current ||
        !sameRuntime(current, slot) ||
        current.intentId !== slot.intentId ||
        current.intentSequence !== slot.intentSequence ||
        current.attachmentGeneration !== slot.attachmentGeneration ||
        current.phase !== slot.phase
      )
        throw new BrowserPoolAdmissionClosed("The pooled browser state changed.");
      const advanced = await tx
        .updateTable("browserPoolSlots")
        .set({
          phase: next.phase,
          ...(next.retained !== undefined ? { retained: next.retained } : {}),
          ...(next.savedState !== undefined ? { savedState: next.savedState } : {}),
          ...(next.outcome !== undefined ? { outcome: next.outcome } : {}),
          ...(next.attachmentGeneration !== undefined
            ? { attachmentGeneration: next.attachmentGeneration }
            : {}),
          ...(next.fence ? next.fence : {}),
        })
        .where("runnerId", "=", slot.runnerId)
        .returningAll()
        .executeTakeFirstOrThrow();
      await recordBrowserPoolLosses(tx, slot, losses);
      return advanced;
    },
    undefined,
    "non-retrying",
  );
}

/** Notes per tab, and the end of each lost session, inside the caller's transaction. */
async function recordBrowserPoolLosses(
  tx: Kysely<DatabaseSchema>,
  slot: BrowserPoolSlot,
  losses: readonly BrowserPoolSessionLoss[],
): Promise<void> {
  if (losses.length) {
    const ownerId = await readBrowserPoolOwner(tx);
    const sessions = await tx
      .selectFrom("browserSessions")
      .select("id")
      .where("id", "in", [...new Set(losses.map(({ sessionId }) => sessionId))])
      .where("runnerId", "=", slot.runnerId)
      .where("runtimeId", "=", slot.runtimeId)
      .orderBy("id")
      .execute();
    const known = new Set(sessions.map(({ id }) => id));
    // A loss outside a park (a lost Runner channel, a removed device) has its own note id.
    const noteId = slot.intentId ?? randomUUID();
    const notes = losses.flatMap(({ sessionId, reason, surfaces }) => {
      return ownerId && known.has(sessionId)
        ? surfaces.map(({ surfaceId, documentId }) => ({
            intentId: noteId,
            runnerId: slot.runnerId,
            ownerId,
            sessionId,
            surfaceId: surfaceId as BrowserSurfaceId,
            documentId,
            reason,
          }))
        : [];
    });
    if (notes.length)
      await tx
        .insertInto("browserPoolDocumentLosses")
        .values(notes)
        .onConflict((conflict) => conflict.columns(["intentId", "surfaceId"]).doNothing())
        .execute();
    // A ready row with no browser behind it is a defect: the lost session ends here.
    const ended = new Set(
      losses.filter((loss) => loss.endSession !== false).map(({ sessionId }) => sessionId),
    );
    for (const { id } of sessions.filter(({ id }) => ended.has(id)))
      await transitionBrowserSession(tx, {
        from: ["starting", "ready", "closing"],
        sessionId: id,
        state: "failed",
      });
  }
}

/** A removed device: its sessions end with their notes and the slot row goes with them. */
export async function releaseBrowserPoolSlot(
  database: Kysely<DatabaseSchema>,
  slot: BrowserPoolSlot,
  losses: readonly BrowserPoolSessionLoss[],
): Promise<void> {
  await commitPersonalMutation(
    database,
    async (tx) => {
      // Lock order: the slot first, then the notes, then the sessions.
      await tx.deleteFrom("browserPoolSlots").where("runnerId", "=", slot.runnerId).execute();
      await recordBrowserPoolLosses(tx, slot, losses);
    },
    undefined,
    "non-retrying",
  );
}

/** Journal row written before a controller call is sent. */
export async function recordBrowserPoolControllerCall(
  database: Kysely<DatabaseSchema>,
  call: {
    readonly id: string;
    readonly runnerId: RunnerId;
    readonly slotId: string;
    readonly term: number;
    readonly intentId: string | null;
    readonly kind: string;
    readonly request: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  await database
    .insertInto("browserPoolControllerCalls")
    .values({ ...call, result: null, settledAt: null })
    .onConflict((conflict) => conflict.column("id").doNothing())
    .execute();
}

export async function settleBrowserPoolControllerCall(
  database: Kysely<DatabaseSchema>,
  id: string,
  result: Readonly<Record<string, unknown>>,
): Promise<void> {
  await database
    .updateTable("browserPoolControllerCalls")
    .set({ result, settledAt: new Date() })
    .where("id", "=", id)
    .where("settledAt", "is", null)
    .execute();
}

export function listOpenBrowserPoolControllerCalls(
  database: Kysely<DatabaseSchema>,
  runnerId: RunnerId,
) {
  return database
    .selectFrom("browserPoolControllerCalls")
    .selectAll()
    .where("runnerId", "=", runnerId)
    .where("settledAt", "is", null)
    .orderBy("createdAt")
    .orderBy("id")
    .execute();
}

/** The settled result of an intent's call of one kind, if the controller applied it. */
export async function readAppliedBrowserPoolControllerCall(
  database: Kysely<DatabaseSchema>,
  runnerId: RunnerId,
  intentId: string,
  kind: string,
) {
  return database
    .selectFrom("browserPoolControllerCalls")
    .selectAll()
    .where("runnerId", "=", runnerId)
    .where("intentId", "=", intentId)
    .where("kind", "=", kind)
    .where(sql<boolean>`result->>'applied' = 'true'`)
    .orderBy("createdAt", "desc")
    .executeTakeFirst();
}

/** The persistent tab lineage of a session: person use is keyed by it, not by the session. */
export async function readBrowserPoolSessionLineage(
  database: Kysely<DatabaseSchema>,
  sessionId: BrowserSessionId,
): Promise<BrowserSessionId | undefined> {
  const row = await database
    .selectFrom("browserSessions")
    .select("tabGroupId")
    .where("id", "=", sessionId)
    .executeTakeFirst();
  return row?.tabGroupId;
}

/** A pooled browser belongs to a personal Home, so its sessions have its one owner. */
export async function readBrowserPoolOwner(
  database: Kysely<DatabaseSchema>,
): Promise<UserId | undefined> {
  const row = await database.selectFrom("personalSettings").select("ownerId").executeTakeFirst();
  return (row?.ownerId ?? undefined) as UserId | undefined;
}

/** The Home's own open tab rows of these sessions: what a lost session's notes attach to. */
export async function listBrowserPoolSessionTabs(
  database: Kysely<DatabaseSchema>,
  sessionIds: readonly BrowserSessionId[],
): Promise<ReadonlyMap<BrowserSessionId, readonly string[]>> {
  const tabs = new Map<BrowserSessionId, string[]>();
  if (!sessionIds.length) return tabs;
  const rows = await database
    .selectFrom("personalTabs")
    .select(["id", sql<BrowserSessionId>`page_binding->>'sessionId'`.as("sessionId")])
    .where(sql<string>`page_binding->>'sessionId'`, "in", [...sessionIds])
    .where("closedAt", "is", null)
    .orderBy("id")
    .execute();
  for (const { id, sessionId } of rows) tabs.set(sessionId, [...(tabs.get(sessionId) ?? []), id]);
  return tabs;
}

/** Every session of a pooled runtime that is not yet terminal. */
export async function listBrowserPoolRuntimeSessions(
  database: Kysely<DatabaseSchema>,
  runnerId: RunnerId,
  runtimeId: string,
): Promise<readonly BrowserSessionId[]> {
  const rows = await database
    .selectFrom("browserSessions")
    .select("id")
    .where("runnerId", "=", runnerId)
    .where("runtimeId", "=", runtimeId)
    .where("state", "in", ["starting", "ready", "closing"])
    .orderBy("id")
    .execute();
  return rows.map(({ id }) => id);
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

/**
 * The person sees a loss once. A notice stays until the client says it showed it (by its id);
 * a reply lost on the way is answered with the same notice again.
 */
export async function nextBrowserPoolDocumentLoss(
  database: Kysely<DatabaseSchema>,
  ownerId: UserId,
  surfaceId: BrowserSurfaceId,
  seen?: string,
): Promise<{ readonly id: string; readonly reason: string } | undefined> {
  if (seen)
    await database
      .updateTable("browserPoolDocumentLosses")
      .set({ noticedAt: new Date() })
      .where("ownerId", "=", ownerId)
      .where("surfaceId", "=", surfaceId)
      .where(sql<string>`intent_id::text`, "=", seen)
      .where("noticedAt", "is", null)
      .execute();
  const row = await database
    .selectFrom("browserPoolDocumentLosses")
    .select(["intentId", "reason"])
    .where("ownerId", "=", ownerId)
    .where("surfaceId", "=", surfaceId)
    .where("noticedAt", "is", null)
    .orderBy("lostAt")
    .executeTakeFirst();
  return row ? { id: row.intentId, reason: row.reason } : undefined;
}

/**
 * Pool code cleans up its own bookkeeping: finished calls of earlier intents, relays of other
 * fences or past their deadline, and loss notes the person has seen, after the retention.
 */
export async function pruneBrowserPoolBookkeeping(
  database: Kysely<DatabaseSchema>,
  slot: BrowserPoolSlot,
): Promise<void> {
  const before = new Date(Date.now() - browserPoolRetentionMs);
  let calls = database
    .deleteFrom("browserPoolControllerCalls")
    .where("runnerId", "=", slot.runnerId)
    .where("settledAt", "is not", null)
    .where("settledAt", "<", before);
  if (slot.intentId) calls = calls.where("intentId", "is distinct from", slot.intentId);
  await calls.execute();
  await database
    .deleteFrom("browserPoolRelays")
    .where("runnerId", "=", slot.runnerId)
    .where((eb) =>
      eb.or([
        eb("instanceId", "!=", slot.instanceId),
        eb("epoch", "!=", slot.epoch),
        eb("term", "!=", slot.term),
        eb(sql<Date>`created_at`, "<", new Date(Date.now() - browserPoolRelayDeadlineMs)),
      ]),
    )
    .execute();
  await database
    .deleteFrom("browserPoolDocumentLosses")
    .where("runnerId", "=", slot.runnerId)
    .where("noticedAt", "<", before)
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
