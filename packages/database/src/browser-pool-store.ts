import type { RunnerId } from "@opensteer/core";
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

export class BrowserPoolAdmissionClosed extends Error {
  constructor() {
    super("The pooled browser is waiting for recovery.");
    this.name = "BrowserPoolAdmissionClosed";
  }
}

/** Pooled variants call this after the deployment fence and before locking any child. */
export async function requireBrowserPoolAdmission(
  tx: Kysely<DatabaseSchema>,
  runnerId: RunnerId,
): Promise<void> {
  if (
    !tx.isTransaction ||
    !activePersonalMutation(tx as Parameters<typeof activePersonalMutation>[0])
  )
    throw new Error("Browser pool admission requires the deployment fence.");
  const row = await readBrowserPoolSlot(tx, runnerId);
  if (row && row.phase !== "running") throw new BrowserPoolAdmissionClosed();
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
        select 1 from agent_operations
        where handed_off_at is not null and terminal_evidence_at is null
          and target->'grant'->>'kind' = 'browser-profile'
      ) as blocked
    `.execute(tx);
      // Existing hand-offs lack an exact runtime witness. Any unresolved browser-profile
      // hand-off conservatively vetoes parking; Chrome and plugins have independent evidence.
      if (demanded() || blockers.rows[0]?.blocked !== false) return undefined;
      const next = {
        ...target,
        intentId,
        intentSequence: (current?.intentSequence ?? 0) + 1,
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
  next: Pick<BrowserPoolSlot, "phase" | "epoch" | "retained">,
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
        current.phase !== slot.phase
      )
        throw new BrowserPoolAdmissionClosed();
      const { phase, epoch, retained } = next;
      return tx
        .updateTable("browserPoolSlots")
        .set({ phase, epoch, retained })
        .where("runnerId", "=", slot.runnerId)
        .returningAll()
        .executeTakeFirstOrThrow();
    },
    undefined,
    "non-retrying",
  );
}
