import { randomUUID } from "node:crypto";
import type {
  ThreadId,
  TriggerId,
  TriggerOccurrenceId,
  TriggerWatchActivationId,
  UserId,
} from "@opensteer/core";
import { TriggerScriptEventSchema, TriggerSourceSchema } from "@opensteer/triggers";
import { sql, type Kysely, type Transaction } from "kysely";
import { commitPersonalMutation } from "./personal-mutation.js";
import type { DatabaseSchema } from "./schema.js";
import { nearestListedThread } from "./thread-lineage.js";

export type AutomationFailureReason =
  | "final-occurrence-failed"
  | "final-occurrence-interrupted"
  | "paused"
  | "started-failing"
  | "started-unknown"
  | "overran-schedule"
  | "watch-crash-loop"
  | "watch-halted"
  | "outcome-unknown";

/**
 * Records, in the transaction that ended it, that an automation stopped
 * working. Its owner is told later, by the Host, because queueing a message
 * takes locks this transaction may not take after its own.
 */
export async function recordAutomationFailure(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly activationId?: TriggerWatchActivationId;
    readonly detail: string;
    readonly occurrenceId?: TriggerOccurrenceId;
    readonly reason: AutomationFailureReason;
    readonly triggerId: TriggerId;
  },
): Promise<void> {
  const detail = [...(input.detail.trim() || "No error was reported.")].slice(0, 2_000).join("");
  await commitPersonalMutation(transaction, async (tx, mutation) => {
    const inserted = await tx
      .insertInto("automationFailureNotices")
      .values({
        activationId: input.activationId ?? null,
        detail,
        id: randomUUID(),
        occurrenceId: input.occurrenceId ?? null,
        reason: input.reason,
        triggerId: input.triggerId,
      })
      .onConflict((conflict) => conflict.column("occurrenceId").doNothing())
      .returning("id")
      .executeTakeFirst();
    if (inserted) mutation.react({ type: "automationFailuresChanged" });
  });
}

/**
 * Whether this Occurrence was its Trigger's only scheduled run: a one-shot
 * schedule fires once, so when that run fails nothing will ever run again.
 */
export function isFinalScheduledOccurrence(input: {
  readonly event: unknown;
  readonly revisionSource: unknown;
}): boolean {
  const source = TriggerSourceSchema.safeParse(input.revisionSource);
  const event = TriggerScriptEventSchema.safeParse(input.event);
  return (
    source.success &&
    source.data.kind === "schedule" &&
    source.data.schedule.kind === "at" &&
    event.success &&
    event.data.source.kind === "schedule"
  );
}

/** One notice owed to where its owner finds the automation, with what queueing it there needs. */
export interface PendingAutomationFailure {
  readonly anchorThreadId: ThreadId;
  readonly anchorThreadTitle: string;
  /** The anchor, or the nearest listed task above an automation that runs in its own task. */
  readonly destinationThreadId: ThreadId;
  readonly attempts: number;
  readonly createdBy: UserId;
  readonly detail: string;
  readonly id: string;
  readonly reason: AutomationFailureReason;
  readonly triggerId: TriggerId;
  readonly triggerName: string;
}

export class AutomationFailureStore {
  readonly #database: Kysely<DatabaseSchema>;

  constructor(database: Kysely<DatabaseSchema>) {
    this.#database = database;
  }

  #pendingNotices() {
    return this.#database
      .selectFrom("automationFailureNotices")
      .innerJoin("triggers", "triggers.id", "automationFailureNotices.triggerId")
      .innerJoin("threads", "threads.id", "triggers.anchorThreadId")
      .where("automationFailureNotices.settledAt", "is", null);
  }

  /**
   * Notices are stamped and found due on PostgreSQL's clock, and the Host times its wake on
   * its own: the deadline is returned as the database's remaining wait from the Host's now.
   */
  async nextDeadline(): Promise<Date | null> {
    const row = await this.#pendingNotices()
      .select(
        sql<number>`extract(epoch from (automation_failure_notices.next_attempt_at - now())) * 1000`.as(
          "waitMs",
        ),
      )
      .orderBy("automationFailureNotices.nextAttemptAt")
      .limit(1)
      .executeTakeFirst();
    return row ? new Date(Date.now() + Math.max(0, Number(row.waitMs))) : null;
  }

  /** Notices due now, oldest first. */
  async listDue(limit = 50): Promise<readonly PendingAutomationFailure[]> {
    const rows = await this.#pendingNotices()
      .select([
        "automationFailureNotices.attempts",
        "automationFailureNotices.detail",
        "automationFailureNotices.id",
        "automationFailureNotices.reason",
        "triggers.anchorThreadId",
        "threads.title as anchorThreadTitle",
        "triggers.createdBy",
        "triggers.id as triggerId",
        "triggers.name",
      ])
      .where("automationFailureNotices.nextAttemptAt", "<=", sql<Date>`now()`)
      .orderBy("automationFailureNotices.createdAt", "asc")
      .limit(limit)
      .execute();
    // The Inbox checks this destination again when it admits the notice.
    const destinations = await Promise.all(
      rows.map(async (row) => {
        const found = await nearestListedThread(this.#database, row.anchorThreadId);
        return found?.threadId ?? row.anchorThreadId;
      }),
    );
    return rows.map((row, index) => ({
      anchorThreadId: row.anchorThreadId,
      anchorThreadTitle: row.anchorThreadTitle,
      destinationThreadId: destinations[index]!,
      attempts: row.attempts,
      createdBy: row.createdBy,
      detail: row.detail,
      id: row.id,
      reason: row.reason,
      triggerId: row.triggerId,
      triggerName: row.name,
    }));
  }

  /** Done: queued in its Thread, or impossible to queue there, with why. */
  async settle(input: { readonly id: string; readonly reason: string | null }): Promise<void> {
    await this.#database
      .updateTable("automationFailureNotices")
      .set({
        lastError: input.reason ? input.reason.trim().slice(0, 2_000) : null,
        settledAt: new Date(),
      })
      .where("id", "=", input.id)
      .where("settledAt", "is", null)
      .execute();
  }

  /** Not yet: tries again after a backoff that grows with each attempt. */
  async retryLater(input: { readonly error: string; readonly id: string }): Promise<void> {
    await this.#database
      .updateTable("automationFailureNotices")
      .set({
        attempts: sql`attempts + 1`,
        lastError: input.error.trim().slice(0, 2_000) || "Delivery failed",
        nextAttemptAt: sql<Date>`now() + least(interval '1 hour', interval '5 seconds' * power(2, least(attempts, 10)))`,
      })
      .where("id", "=", input.id)
      .where("settledAt", "is", null)
      .execute();
  }
}
