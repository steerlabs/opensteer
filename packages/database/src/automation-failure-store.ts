import { randomUUID } from "node:crypto";
import type {
  ThreadId,
  TriggerId,
  TriggerOccurrenceId,
  TriggerWatchActivationId,
  UserId,
} from "@opensteer/core";
import { TriggerProgramEventSchema, TriggerSourceSchema } from "@opensteer/triggers";
import { sql, type Kysely, type Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";

export type AutomationFailureReason =
  "final-occurrence-failed" | "final-occurrence-interrupted" | "paused";

/**
 * Records, in the transaction that ended it, that an automation stopped
 * working. The anchor Thread is told later, by the Host, because queueing a
 * message there takes locks this transaction may not take after its own.
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
  await transaction
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
    .execute();
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
  const event = TriggerProgramEventSchema.safeParse(input.event);
  return (
    source.success &&
    source.data.kind === "schedule" &&
    source.data.schedule.kind === "at" &&
    event.success &&
    event.data.source.kind === "schedule"
  );
}

/** One notice owed to its anchor Thread, with what queueing it there needs. */
export interface PendingAutomationFailure {
  readonly anchorThreadId: ThreadId;
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

  /** Notices due now, oldest first. */
  async listDue(limit = 50): Promise<readonly PendingAutomationFailure[]> {
    const rows = await this.#database
      .selectFrom("automationFailureNotices")
      .innerJoin("triggers", "triggers.id", "automationFailureNotices.triggerId")
      .select([
        "automationFailureNotices.attempts",
        "automationFailureNotices.detail",
        "automationFailureNotices.id",
        "automationFailureNotices.reason",
        "triggers.anchorThreadId",
        "triggers.createdBy",
        "triggers.id as triggerId",
        "triggers.name",
      ])
      .where("automationFailureNotices.settledAt", "is", null)
      .where("automationFailureNotices.nextAttemptAt", "<=", sql<Date>`now()`)
      .orderBy("automationFailureNotices.createdAt", "asc")
      .limit(limit)
      .execute();
    return rows.map((row) => ({
      anchorThreadId: row.anchorThreadId,
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
