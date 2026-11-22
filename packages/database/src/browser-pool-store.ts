import type { HostedBrowserSessionState } from "@opensteer/protocol";
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
import { databaseOperationOptions } from "./operation-budget.js";
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
  readonly surfaces: readonly {
    readonly surfaceId: string;
    readonly documentId: string | null;
    /** Typed text that was not sent, when known; written with the loss. Absent: not known. */
    readonly typed?: boolean;
  }[];
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
    .executeTakeFirst(databaseOperationOptions());
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
        .executeTakeFirst(databaseOperationOptions());
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
        .executeTakeFirstOrThrow(databaseOperationOptions());
    },
    undefined,
    "once-bounded",
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
        .executeTakeFirst(databaseOperationOptions());
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
        .executeTakeFirstOrThrow(databaseOperationOptions());
    },
    undefined,
    "once-bounded",
  );
}

export interface BrowserPoolSlotChange {
  readonly phase: BrowserPoolSlot["phase"];
  readonly retained?: BrowserPoolSlot["retained"];
  readonly savedState?: BrowserPoolSlot["savedState"];
  readonly outcome?: BrowserPoolSlot["outcome"];
  readonly attachmentGeneration?: number;
  /** A new fence from the controller: a resume (epoch) or a fresh start (the whole fence). */
  readonly fence?: Pick<BrowserPoolTargetIdentity, "instanceId" | "epoch"> &
    Partial<Pick<BrowserPoolTargetIdentity, "slotId" | "term">>;
  readonly lastStart?: BrowserPoolSlot["lastStart"];
  readonly failedStarts?: number;
  readonly restartKeys?: readonly string[];
  readonly restartWanted?: readonly string[];
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
    async (tx, mutation) => {
      const current = await tx
        .selectFrom("browserPoolSlots")
        .selectAll()
        .where("runnerId", "=", slot.runnerId)
        .forNoKeyUpdate()
        .executeTakeFirst(databaseOperationOptions());
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
          ...(next.lastStart !== undefined ? { lastStart: next.lastStart } : {}),
          ...(next.failedStarts !== undefined ? { failedStarts: next.failedStarts } : {}),
          ...(next.restartKeys !== undefined
            ? { restartKeys: sql<readonly string[]>`${JSON.stringify(next.restartKeys)}::jsonb` }
            : {}),
          ...(next.restartWanted !== undefined
            ? {
                restartWanted: sql<readonly string[]>`${JSON.stringify(next.restartWanted)}::jsonb`,
              }
            : {}),
          ...(next.phase !== current.phase ? { phaseSince: new Date() } : {}),
        })
        .where("runnerId", "=", slot.runnerId)
        .returningAll()
        .executeTakeFirstOrThrow(databaseOperationOptions());
      const noted = await recordBrowserPoolLosses(tx, slot, losses);
      // Clients read a pooled browser's phase with its placement: they are told only when
      // something a person sees changed (P20). Sessions ended tell them on their own.
      if (
        noted ||
        advanced.phase !== current.phase ||
        advanced.failedStarts !== current.failedStarts ||
        JSON.stringify(advanced.lastStart) !== JSON.stringify(current.lastStart)
      )
        mutation.bumpResource("browser-placement");
      // Parked, the guest is paused and its next adoption leaves out every session not ready: a
      // Stop that landed while the park was under way has the same evidence as one on a parked
      // guest. Under the slot's lock, so no Stop falls between this and its own write.
      if (next.phase === "parked" && current.phase !== "parked") {
        const stopped = await tx
          .selectFrom("browserSessions")
          .select("id")
          .where("runnerId", "=", slot.runnerId)
          .where("runtimeId", "=", slot.runtimeId)
          .where("state", "=", "closing")
          .orderBy("id")
          .execute(databaseOperationOptions());
        await endBrowserPoolSessions(
          tx,
          stopped.map(({ id }) => ({ id, from: ["closing"], state: "closed" })),
        );
      }
      return advanced;
    },
    undefined,
    "once-bounded",
  );
}

/**
 * A browser Stop of a pooled session with no channel here, under the slot's lock: on a parked
 * guest it is closed (the next adoption leaves it out), otherwise it is closing until its
 * runtime answers. Returns the state written, or undefined for a row already ended.
 */
export async function stopBrowserPoolSession(
  database: Kysely<DatabaseSchema>,
  input: { readonly sessionId: BrowserSessionId; readonly runnerId: RunnerId },
): Promise<"closing" | "closed" | undefined> {
  return commitPersonalMutation(
    database,
    async (tx) => {
      // Lock order: the slot first, then the session.
      const slot = await tx
        .selectFrom("browserPoolSlots")
        .select("phase")
        .where("runnerId", "=", input.runnerId)
        .forShare()
        .executeTakeFirst(databaseOperationOptions());
      const state = slot?.phase === "parked" ? ("closed" as const) : ("closing" as const);
      const row = await tx
        .selectFrom("browserSessions")
        .select("state")
        .where("id", "=", input.sessionId)
        .executeTakeFirst(databaseOperationOptions());
      if (!row || row.state === "closed" || row.state === "failed") return undefined;
      if (row.state === state) return state;
      await transitionBrowserSession(tx, {
        from: ["starting", "ready", "closing"],
        sessionId: input.sessionId,
        state,
      });
      return state;
    },
    undefined,
    "once-bounded",
  );
}

/**
 * Notes per tab, and the end of each lost session, inside the caller's transaction; whether a
 * note was written.
 */
async function recordBrowserPoolLosses(
  tx: Kysely<DatabaseSchema>,
  slot: BrowserPoolSlot,
  losses: readonly BrowserPoolSessionLoss[],
  /** False when the guest's end is not known yet (a removal's start): closing rows stay. */
  guestEnded = true,
): Promise<boolean> {
  let noted = false;
  if (losses.length) {
    const ownerId = await readBrowserPoolOwner(tx);
    const sessions = await tx
      .selectFrom("browserSessions")
      .select(["id", "state"])
      .where("id", "in", [...new Set(losses.map(({ sessionId }) => sessionId))])
      .where("runnerId", "=", slot.runnerId)
      .where("runtimeId", "=", slot.runtimeId)
      .orderBy("id")
      .execute(databaseOperationOptions());
    const known = new Set(sessions.map(({ id }) => id));
    // Every loss has its own notice id: a later loss on the same tab is a new notice.
    const noteId = randomUUID();
    const notes = losses.flatMap(({ sessionId, reason, surfaces }) => {
      return ownerId && known.has(sessionId)
        ? surfaces.map(({ surfaceId, documentId, typed }) => ({
            intentId: noteId,
            runnerId: slot.runnerId,
            ownerId,
            sessionId,
            surfaceId: surfaceId as BrowserSurfaceId,
            documentId,
            reason,
            typed: typed ?? null,
          }))
        : [];
    });
    if (notes.length) {
      await tx
        .insertInto("browserPoolDocumentLosses")
        .values(notes)
        .onConflict((conflict) => conflict.columns(["intentId", "surfaceId"]).doNothing())
        .execute(databaseOperationOptions());
      noted = true;
    }
    // A ready row with no browser behind it is a defect: the lost session ends here.
    const ended = new Set(
      losses.filter((loss) => loss.endSession !== false).map(({ sessionId }) => sessionId),
    );
    // One a Stop left closing is answered by this end: it closed, as the person asked. Without
    // the guest's end it stays closing; the removal's finish closes it.
    await endBrowserPoolSessions(
      tx,
      sessions
        .filter(({ id, state }) => ended.has(id) && (guestEnded || state !== "closing"))
        .map(({ id, state }) => ({
          id,
          from: ["starting", "ready", "closing"],
          state: state === "closing" ? "closed" : "failed",
        })),
    );
  }
  return noted;
}

/**
 * Ends several sessions in one transaction in the declared lock order (P19): every session row
 * first, in id order, then all their attachments, in key order; as transitionBrowserSession does
 * for one.
 */
async function endBrowserPoolSessions(
  tx: Kysely<DatabaseSchema>,
  ends: readonly {
    readonly id: BrowserSessionId;
    readonly from: readonly HostedBrowserSessionState[];
    readonly state: "closed" | "failed";
  }[],
): Promise<void> {
  if (!ends.length) return;
  const ordered = [...ends].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  await commitPersonalMutation(tx, async (transaction, mutation) => {
    await transaction
      .selectFrom("browserSessions")
      .select("id")
      .where(
        "id",
        "in",
        ordered.map(({ id }) => id),
      )
      .orderBy("id")
      .forNoKeyUpdate()
      .execute(databaseOperationOptions());
    const now = new Date();
    const ended: BrowserSessionId[] = [];
    for (const end of ordered) {
      const row = await transaction
        .updateTable("browserSessions")
        .set({ closedAt: now, state: end.state, updatedAt: now })
        .where("id", "=", end.id)
        .where("state", "not in", ["closed", "failed"])
        .where("state", "in", [...end.from])
        .returning("id")
        .executeTakeFirst(databaseOperationOptions());
      if (row) ended.push(row.id);
    }
    if (!ended.length) return;
    await transaction
      .selectFrom("browserSessionAttachments")
      .select(["agentBindingId", "sessionId"])
      .where("sessionId", "in", ended)
      .orderBy("agentBindingId", "asc")
      .orderBy("sessionId", "asc")
      // FOR UPDATE: these attachments are deleted below; their keys are locked in order.
      .forUpdate()
      .execute(databaseOperationOptions());
    await transaction
      .deleteFrom("browserSessionAttachments")
      .where("sessionId", "in", ended)
      .execute(databaseOperationOptions());
    mutation.bumpResource("browser-placement");
    mutation.bumpResource("browser-availability");
    mutation.bumpResource("tab");
  });
}

/** Tells clients a pooled browser's shown phase changed, with nothing else written. */
export async function announceBrowserPool(database: Kysely<DatabaseSchema>): Promise<void> {
  await commitPersonalMutation(database, async (_tx, mutation) => {
    mutation.bumpResource("browser-placement");
  });
}

/** A fresh start that did not come up: counted until one does. */
export async function recordBrowserPoolStartFailure(
  database: Kysely<DatabaseSchema>,
  runnerId: RunnerId,
): Promise<void> {
  await commitPersonalMutation(database, async (tx, mutation) => {
    mutation.bumpResource("browser-placement");
    await tx
      .updateTable("browserPoolSlots")
      .set({ failedStarts: sql`failed_starts + 1` })
      .where("runnerId", "=", runnerId)
      .execute(databaseOperationOptions());
  });
}

/**
 * A removed device: its sessions end with their notes, and the slot is marked releasing, in one
 * transaction. The row stays until the guest is known stopped (`finishBrowserPoolRelease`).
 */
export async function beginBrowserPoolRelease(
  database: Kysely<DatabaseSchema>,
  slot: BrowserPoolSlot,
  losses: readonly BrowserPoolSessionLoss[],
): Promise<BrowserPoolSlot | undefined> {
  return commitPersonalMutation(
    database,
    async (tx, mutation) => {
      // Lock order: the slot first, then the notes, then the sessions.
      mutation.bumpResource("browser-placement");
      const released = await tx
        .updateTable("browserPoolSlots")
        .set({ phase: "releasing", phaseSince: new Date() })
        .where("runnerId", "=", slot.runnerId)
        .returningAll()
        .executeTakeFirst(databaseOperationOptions());
      await recordBrowserPoolLosses(tx, slot, losses, false);
      return released;
    },
    undefined,
    "once-bounded",
  );
}

/** The removed device's guest is known stopped: the slot goes with its journal and relay rows. */
export async function finishBrowserPoolRelease(
  database: Kysely<DatabaseSchema>,
  runnerId: RunnerId,
): Promise<void> {
  await commitPersonalMutation(
    database,
    async (tx, mutation) => {
      mutation.bumpResource("browser-placement");
      await tx
        .deleteFrom("browserPoolSlots")
        .where("runnerId", "=", runnerId)
        .where("phase", "=", "releasing")
        .execute(databaseOperationOptions());
      // Rows are locked in key order before they go, as every multi-row write here.
      const calls = await tx
        .selectFrom("browserPoolControllerCalls")
        .select("id")
        .where("runnerId", "=", runnerId)
        .orderBy("id")
        // FOR UPDATE: these rows are deleted with the slot.
        .forUpdate()
        .execute(databaseOperationOptions());
      if (calls.length)
        await tx
          .deleteFrom("browserPoolControllerCalls")
          .where(
            "id",
            "in",
            calls.map(({ id }) => id),
          )
          .execute(databaseOperationOptions());
      const relays = await tx
        .selectFrom("browserPoolRelays")
        .select("id")
        .where("runnerId", "=", runnerId)
        .orderBy("id")
        // FOR UPDATE: these rows are deleted with the slot.
        .forUpdate()
        .execute(databaseOperationOptions());
      if (relays.length)
        await tx
          .deleteFrom("browserPoolRelays")
          .where(
            "id",
            "in",
            relays.map(({ id }) => id),
          )
          .execute(databaseOperationOptions());

      // The guest is known stopped: a session a Stop left closing has its end now.
      const closing = await tx
        .selectFrom("browserSessions")
        .select("id")
        .where("runnerId", "=", runnerId)
        .where("state", "=", "closing")
        .orderBy("id")
        .execute(databaseOperationOptions());
      await endBrowserPoolSessions(
        tx,
        closing.map(({ id }) => ({ id, from: ["closing"], state: "closed" })),
      );
    },
    undefined,
    "once-bounded",
  );
}

/**
 * Journal row written before a controller call is sent. With `closeOpen`, every call still open
 * for this Runner is closed in the same write, with what the status read showed: a call that
 * replaces the guest leaves nothing for a later recovery to replay against the new one.
 */
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
    /** A restart's Start: the keys it answers, durable with the call before it is sent. */
    readonly restartKeys?: readonly string[];
  },
  closeOpen?: Readonly<Record<string, unknown>>,
): Promise<void> {
  const { restartKeys, ...row } = call;
  const insert = (executor: Kysely<DatabaseSchema>) =>
    executor
      .insertInto("browserPoolControllerCalls")
      .values({
        ...row,
        result: null,
        settledAt: null,
        restartKeys: restartKeys?.length
          ? sql<readonly string[]>`${JSON.stringify(restartKeys)}::jsonb`
          : null,
      })
      .onConflict((conflict) => conflict.column("id").doNothing())
      .execute(databaseOperationOptions());
  if (!closeOpen) {
    await insert(database);
    return;
  }
  // Under the deployment fence, as the release that deletes these rows is.
  await commitPersonalMutation(
    database,
    async (tx) => {
      const open = await tx
        .selectFrom("browserPoolControllerCalls")
        .select("id")
        .where("runnerId", "=", call.runnerId)
        .where("settledAt", "is", null)
        .orderBy("id")
        .forNoKeyUpdate()
        .execute(databaseOperationOptions());
      // The guest is replaced: whether an open call applied is not known, and never claimed.
      // Open Starts are never among them: the caller settled each by its id first.
      for (const { id } of open)
        await tx
          .updateTable("browserPoolControllerCalls")
          .set({
            result: { id, outcome: "unknown", reason: "superseded", status: closeOpen },
            settledAt: new Date(),
          })
          .where("id", "=", id)
          .execute(databaseOperationOptions());
      await insert(tx);
    },
    undefined,
    "once-bounded",
  );
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
    .execute(databaseOperationOptions());
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
    .execute(databaseOperationOptions());
}

/**
 * The newest Starts the controller applied for this Runner and no slot has held yet, newest
 * first: one whose guest is the one running now is installed, never replaced again.
 */
export function listAppliedBrowserPoolStarts(database: Kysely<DatabaseSchema>, runnerId: RunnerId) {
  return database
    .selectFrom("browserPoolControllerCalls")
    .selectAll()
    .where("runnerId", "=", runnerId)
    .where("kind", "=", "start")
    .where("settledAt", "is not", null)
    .where("installedAt", "is", null)
    .where(sql<boolean>`result->>'applied' = 'true'`)
    .orderBy("createdAt", "desc")
    .orderBy("id", "desc")
    .limit(4)
    .execute(databaseOperationOptions());
}

/** The slot holds this Start's guest now: it is no replacement still to be installed. */
export async function markBrowserPoolStartInstalled(
  database: Kysely<DatabaseSchema>,
  id: string,
): Promise<void> {
  await database
    .updateTable("browserPoolControllerCalls")
    .set({ installedAt: new Date() })
    .where("id", "=", id)
    .where("installedAt", "is", null)
    .execute(databaseOperationOptions());
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
    .executeTakeFirst(databaseOperationOptions());
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
    .executeTakeFirst(databaseOperationOptions());
  return row?.tabGroupId;
}

/** A pooled browser belongs to a personal Home, so its sessions have its one owner. */
export async function readBrowserPoolOwner(
  database: Kysely<DatabaseSchema>,
): Promise<UserId | undefined> {
  const row = await database
    .selectFrom("personalSettings")
    .select("ownerId")
    .executeTakeFirst(databaseOperationOptions());
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
    .execute(databaseOperationOptions());
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
    .execute(databaseOperationOptions());
  return rows.map(({ id }) => id);
}

/**
 * A pooled Runner that was revoked (a removal the Home did not finish): the sessions that
 * revocation ended, which the release still owes a note. Undefined while the Runner stands.
 */
export async function readBrowserPoolRevocation(
  database: Kysely<DatabaseSchema>,
  runnerId: RunnerId,
): Promise<readonly BrowserSessionId[] | undefined> {
  const runner = await database
    .selectFrom("runners")
    .select("revokedAt")
    .where("id", "=", runnerId)
    .executeTakeFirst(databaseOperationOptions());
  if (!runner?.revokedAt) return undefined;
  const ended = await database
    .selectFrom("browserSessions")
    .select("id")
    .where("runnerId", "=", runnerId)
    .where("closedAt", "=", runner.revokedAt)
    .orderBy("id")
    .execute(databaseOperationOptions());
  return ended.map(({ id }) => id);
}

/** The ready sessions of this runtime: the ones a channel can be missing from. */
export async function listBrowserPoolReadySessions(
  database: Kysely<DatabaseSchema>,
  runnerId: RunnerId,
  runtimeId: string,
): Promise<readonly BrowserSessionId[]> {
  const rows = await database
    .selectFrom("browserSessions")
    .select("id")
    .where("runnerId", "=", runnerId)
    .where("runtimeId", "=", runtimeId)
    .where("state", "=", "ready")
    .orderBy("id")
    .execute(databaseOperationOptions());
  return rows.map(({ id }) => id);
}

/**
 * The sessions of this runtime a Stop is ending: closing until the runtime answers that each is
 * gone, whatever the Home's clock says.
 */
export async function listBrowserPoolClosingSessions(
  database: Kysely<DatabaseSchema>,
  runnerId: RunnerId,
  runtimeId: string,
): Promise<readonly BrowserSessionId[]> {
  const rows = await database
    .selectFrom("browserSessions")
    .select("id")
    .where("runnerId", "=", runnerId)
    .where("runtimeId", "=", runtimeId)
    .where("state", "=", "closing")
    .orderBy("id")
    .execute(databaseOperationOptions());
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
    .execute(databaseOperationOptions());
}

/**
 * The person sees a loss once. A notice stays until the client says it showed it (by its id);
 * a reply lost on the way is answered with the same notice again.
 */
/**
 * The person was shown this notice: it, and every older unseen notice of the same tab, are seen.
 * Clients reading the pool report drop the note.
 */
export async function seeBrowserPoolDocumentLoss(
  database: Kysely<DatabaseSchema>,
  ownerId: UserId,
  surfaceId: BrowserSurfaceId,
  seen: string,
): Promise<void> {
  await commitPersonalMutation(database, async (tx, mutation) => {
    // Compared in the database: the seen notice's time keeps its full precision.
    const rows = await tx
      .selectFrom("browserPoolDocumentLosses")
      .select(["intentId", "surfaceId"])
      .where("ownerId", "=", ownerId)
      .where("surfaceId", "=", surfaceId)
      .where("noticedAt", "is", null)
      .where(
        sql<boolean>`lost_at <= (
          select seen.lost_at from browser_pool_document_losses seen
          where seen.owner_id = ${ownerId} and seen.surface_id = ${surfaceId}
            and seen.intent_id::text = ${seen}
        )`,
      )
      .orderBy("intentId")
      .forNoKeyUpdate()
      .execute(databaseOperationOptions());
    if (!rows.length) return;
    mutation.bumpResource("browser-placement");
    await tx
      .updateTable("browserPoolDocumentLosses")
      .set({ noticedAt: new Date() })
      .where("ownerId", "=", ownerId)
      .where("surfaceId", "=", surfaceId)
      .where(
        "intentId",
        "in",
        rows.map(({ intentId }) => intentId),
      )
      .execute(databaseOperationOptions());
  });
}

/** At most this many notices reach a pool report: the newest unseen one of each tab. */
export const browserPoolReportedNotices = 100;

/** The newest unseen notice of each tab of this Runner, newest first, bounded. */
export async function listBrowserPoolReportedNotices(
  database: Kysely<DatabaseSchema>,
  runnerId: RunnerId,
) {
  const newest = database
    .selectFrom("browserPoolDocumentLosses")
    .select(["surfaceId", "sessionId", "intentId", "typed", "lostAt"])
    .distinctOn("surfaceId")
    .where("runnerId", "=", runnerId)
    .where("noticedAt", "is", null)
    .orderBy("surfaceId")
    .orderBy("lostAt", "desc")
    .as("newest");
  return database
    .selectFrom(newest)
    .selectAll()
    .orderBy("lostAt", "desc")
    .limit(browserPoolReportedNotices)
    .execute(databaseOperationOptions());
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
  // The last intent's calls are kept only while it is still going; once the slot runs again they
  // age out like the rest.
  if (slot.intentId && slot.phase !== "running")
    calls = calls.where("intentId", "is distinct from", slot.intentId);
  await calls.execute(databaseOperationOptions());
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
    .execute(databaseOperationOptions());
  // A seen note ages out from when it was seen; one never seen, from when it was written.
  await database
    .deleteFrom("browserPoolDocumentLosses")
    .where("runnerId", "=", slot.runnerId)
    .where((eb) =>
      eb.or([
        eb("noticedAt", "<", before),
        eb.and([eb("noticedAt", "is", null), eb(sql<Date>`lost_at`, "<", before)]),
      ]),
    )
    .execute(databaseOperationOptions());
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
      .execute(databaseOperationOptions());
  });
}

export async function settleBrowserPoolRelay(database: Kysely<DatabaseSchema>, id: string) {
  await database
    .deleteFrom("browserPoolRelays")
    .where("id", "=", id)
    .execute(databaseOperationOptions());
}

// ---- A pooled Cloud Computer's target --------------------------------------------------------

export type BrowserPoolTargetRow = Selectable<DatabaseSchema["browserPoolTargets"]>;

/** What the Home last recorded of its registration and target; undefined before the first. */
export async function readBrowserPoolTarget(
  database: Kysely<DatabaseSchema>,
  cloudComputerId: string,
): Promise<BrowserPoolTargetRow | undefined> {
  return database
    .selectFrom("browserPoolTargets")
    .selectAll()
    .where("cloudComputerId", "=", cloudComputerId)
    .executeTakeFirst(databaseOperationOptions());
}

/** Written before a registration leaves the Home: until its answer is read, it is open. */
export async function recordBrowserPoolRegistrationAttempt(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly cloudComputerId: string;
    readonly keys: Readonly<Record<string, unknown>>;
    readonly issuedAt: Date;
  },
): Promise<void> {
  const keys = input.keys;
  await database
    .insertInto("browserPoolTargets")
    .values({
      cloudComputerId: input.cloudComputerId,
      attemptKeys: keys,
      attemptIssuedAt: input.issuedAt,
      status: "unregistered",
    })
    .onConflict((conflict) =>
      conflict
        .column("cloudComputerId")
        .doUpdateSet({ attemptKeys: keys, attemptIssuedAt: input.issuedAt, updatedAt: new Date() }),
    )
    .execute(databaseOperationOptions());
}

/**
 * What the account answered: a registration's (its keys are then the registered ones, and the
 * attempt is closed) or a read of the target (an open attempt stays open: only its own answer, or
 * a read that shows it was not received, settles it).
 */
export async function recordBrowserPoolTargetAnswer(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly cloudComputerId: string;
    readonly status: BrowserPoolTargetRow["status"];
    readonly target: Readonly<Record<string, unknown>> | null;
    /** The registration this answers: its keys are registered now. */
    readonly registered?: Readonly<Record<string, unknown>>;
    /** A read that shows nothing registered: an open attempt was not received. */
    readonly attemptUnreceived?: boolean;
  },
): Promise<void> {
  const settle = input.registered !== undefined || input.attemptUnreceived === true;
  const row = await readBrowserPoolTarget(database, input.cloudComputerId);
  // Objects are sent as JSON by the driver (only arrays need the cast).
  const values = {
    cloudComputerId: input.cloudComputerId,
    status: input.status,
    target: input.target,
    registeredKeys: input.registered ?? row?.registeredKeys ?? null,
    attemptKeys: settle ? null : (row?.attemptKeys ?? null),
    attemptIssuedAt: settle ? null : (row?.attemptIssuedAt ?? null),
    updatedAt: new Date(),
  };
  await database
    .insertInto("browserPoolTargets")
    .values(values)
    .onConflict((conflict) =>
      conflict.column("cloudComputerId").doUpdateSet({
        status: values.status,
        target: values.target,
        registeredKeys: values.registeredKeys,
        attemptKeys: values.attemptKeys,
        attemptIssuedAt: values.attemptIssuedAt,
        updatedAt: values.updatedAt,
      }),
    )
    .execute(databaseOperationOptions());
}

/**
 * A pooled target replaced by a different one (a new term, a replaced host): its slot row goes,
 * its open calls are closed as unknown (never sent to the new target), and its relays go. The
 * sessions already ended with their notes (`BrowserPoolCoordinator.retire`).
 */
export async function retireBrowserPoolTarget(
  database: Kysely<DatabaseSchema>,
  runnerId: RunnerId,
): Promise<void> {
  await commitPersonalMutation(
    database,
    async (tx, mutation) => {
      mutation.bumpResource("browser-placement");
      await tx
        .deleteFrom("browserPoolSlots")
        .where("runnerId", "=", runnerId)
        .execute(databaseOperationOptions());
      const open = await tx
        .selectFrom("browserPoolControllerCalls")
        .select("id")
        .where("runnerId", "=", runnerId)
        .where("settledAt", "is", null)
        .orderBy("id")
        .forNoKeyUpdate()
        .execute(databaseOperationOptions());
      for (const { id } of open)
        await tx
          .updateTable("browserPoolControllerCalls")
          .set({
            result: { id, outcome: "unknown", reason: "target-replaced" },
            settledAt: new Date(),
          })
          .where("id", "=", id)
          .execute(databaseOperationOptions());
      const relays = await tx
        .selectFrom("browserPoolRelays")
        .select("id")
        .where("runnerId", "=", runnerId)
        .orderBy("id")
        // FOR UPDATE: these relays are deleted below; their keys are locked in order.
        .forUpdate()
        .execute(databaseOperationOptions());
      if (relays.length)
        await tx
          .deleteFrom("browserPoolRelays")
          .where(
            "id",
            "in",
            relays.map(({ id }) => id),
          )
          .execute(databaseOperationOptions());
    },
    undefined,
    "once-bounded",
  );
}
