import { commitPersonalMutation } from "./personal-mutation.js";
import { publishThreadSummary } from "./thread-status.js";
import { requirePersonalOwner } from "./personal-settings-store.js";
import {
  createId,
  ModelSelectionSchema,
  OpensteerError,
  type HarnessInstanceId,
  type ModelSelection,
  TriggerOccurrenceIdSchema,
  type ThreadId,
  type TriggerId,
  type TriggerOccurrenceId,
  type UserId,
} from "@opensteer/core";
import {
  MANAGED_MEMORY_WAKE_SKIPPED,
  memoryPassWakeText,
  TriggerSystemRoleSchema,
  type TriggerProgram,
  type TriggerSource,
  type TriggerSystemRole,
} from "@opensteer/triggers";
import { sql, type Kysely, type Transaction } from "kysely";
import "./connection.js";
import type { DatabaseSchema, ThreadRow } from "./schema.js";
import { jsonValue, lockCommandIdempotency } from "./store-primitives.js";
import { changedTasksSubquery } from "./changed-tasks.js";

import { createThreadInTransaction } from "./thread-store.js";
import { createTriggerInTransaction } from "./trigger-store.js";

/** The role row is the receipt, including paused schedules and Done workers. */

export async function createMemoryPass(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly ownerId: UserId;
    readonly execution: import("@opensteer/core").ExecutionSelection;
    readonly systemRole: TriggerSystemRole;
    readonly program: TriggerProgram;
    readonly source: TriggerSource;
    readonly pauseReason: string | null;
  },
) {
  return commitPersonalMutation(database, async (transaction) => {
    await requirePersonalOwner(transaction, input.ownerId);
    const key = `memory:${input.systemRole}`;
    await sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["trigger-create", input.ownerId, key])}, 0))`.execute(
      transaction,
    );
    await lockCommandIdempotency(transaction, input.ownerId, key);
    const existing = await transaction
      .selectFrom("triggers")
      .select("id")
      .where("systemRole", "=", input.systemRole)
      .executeTakeFirst();
    if (existing) return null;
    const created = await createThreadInTransaction(
      transaction,
      {
        createdBy: input.ownerId,
        ...input.execution,
        purpose: "background-job",
        idempotencyKey: key,
        title: input.systemRole === "memory-light" ? "Memory light pass" : "Memory nightly pass",
      },
      { unlisted: true },
    );
    const trigger = await createTriggerInTransaction(
      transaction,
      {
        actorThreadId: null,
        anchorThreadId: created.thread.id,
        createdBy: input.ownerId,
        idempotencyKey: key,
        name: created.thread.title,
        program: input.program,
        source: input.source,
      },
      {
        systemRole: input.systemRole,
        paused: input.pauseReason !== null,
        pauseReason: input.pauseReason,
      },
    );
    return trigger;
  });
}

export interface MemoryPassExecution {
  readonly harnessInstanceId: HarnessInstanceId;
  readonly harnessRevision: number;
  readonly modelSelection: ModelSelection;
}

/**
 * Puts an admitted pass on the model the Host resolved for it, in a fresh
 * native session. No engine context carries from one pass to the next: a pass's
 * continuity is Agent home's files and its worker's own task history, which it
 * reads deliberately. The Run then freezes this choice for the pass and its
 * recovery. The caller holds the worker's Thread lock.
 */
export async function startMemoryPassInTransaction(
  transaction: Transaction<DatabaseSchema>,
  worker: ThreadRow,
  execution: MemoryPassExecution,
): Promise<{
  readonly worker: ThreadRow;
}> {
  // The input's preconditions already hold this row: harness_instances precede threads.
  const harness = await transaction
    .selectFrom("harnessInstances")
    .select(["enabled", "environmentId", "removedAt", "runtimeRevision"])
    .where("id", "=", execution.harnessInstanceId)
    .executeTakeFirst();
  if (
    !harness?.enabled ||
    harness.removedAt ||
    harness.environmentId !== worker.environmentId ||
    harness.runtimeRevision !== execution.harnessRevision
  )
    throw new OpensteerError({
      code: "conflict",
      message: MANAGED_MEMORY_WAKE_SKIPPED,
    });
  await transaction
    .updateTable("triggers")
    .set({
      waitingReason: null,
      updatedAt: new Date(),
    })
    .where("anchorThreadId", "=", worker.id)
    .where("systemRole", "is not", null)
    .where("waitingReason", "is not", null)
    .execute();
  await transaction
    .selectFrom("providerSessions")
    .select("id")
    .where("threadId", "=", worker.id)
    .orderBy("id", "asc")
    .forNoKeyUpdate()
    .execute();
  await transaction
    .updateTable("providerSessions")
    .set({
      active: false,
      updatedAt: new Date(),
    })
    .where("threadId", "=", worker.id)
    .where("active", "=", true)
    .execute();
  const providerSessionId = createId("providerSession");
  await transaction
    .insertInto("providerSessions")
    .values({
      active: true,
      bindingGeneration: 0,
      continuationIdentity: null,
      harnessInstanceId: execution.harnessInstanceId,
      id: providerSessionId,
      leaseExpiresAt: null,
      leaseTokenHash: null,
      providerSessionReference: null,
      runnerBootId: null,
      runnerId: null,
      status: "starting",
      stateLayout: "session",
      threadId: worker.id,
    })
    .executeTakeFirstOrThrow();
  const updated = await transaction
    .updateTable("threads")
    .set({
      harnessInstanceId: execution.harnessInstanceId,
      modelSelection: jsonValue(ModelSelectionSchema.parse(execution.modelSelection)),
      updatedAt: new Date(),
    })
    .where("id", "=", worker.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await commitPersonalMutation(transaction, async (tx, mutation) => {
    await tx
      .updateTable("threads")
      .set({ revision: mutation.sequence })
      .where("id", "=", updated.id)
      .execute();
    await publishThreadSummary(tx, updated.id);
  });
  return { worker: updated };
}
const lightSourceCheck = 2 * 60 * 60 * 1000;
const firstPassWindow = {
  "memory-light": 24 * 60 * 60 * 1000,
  "memory-nightly": 28 * 24 * 60 * 60 * 1000,
};
/** A message can commit after a wake with an earlier timestamp; rereading one is harmless. */
const commitOverlap = 10 * 60 * 1000;
const maxConversations = 100;

/**
 * What a pass must read, as text for its wake, so positions live here and not in a model's
 * notes. It counts from the last pass that completed, so a failed pass is read again, and a first
 * pass's window starts from its first wake, so a retry reads no less. Refuses a quiet light wake
 * until connected sources, which only a model can read, are due again.
 */
export async function memoryPassWakeContext(
  transaction: Transaction<DatabaseSchema>,
  worker: ThreadRow,
): Promise<string> {
  const trigger = await transaction
    .selectFrom("triggers")
    .select(["id", "systemRole"])
    .where("anchorThreadId", "=", worker.id)
    .where("systemRole", "is not", null)
    .executeTakeFirstOrThrow();
  const role = TriggerSystemRoleSchema.parse(trigger.systemRole);
  const wakes = await transaction
    .selectFrom("threadInputs")
    .innerJoin("messages", "messages.id", "threadInputs.messageId")
    .innerJoin("triggerOccurrences", (join) =>
      join.on(
        sql<boolean>`trigger_occurrences.id = thread_inputs.authority_source->>'occurrenceId'`,
      ),
    )
    .leftJoin("runs", "runs.id", "threadInputs.runId")
    .select(({ fn }) => [
      fn.min("messages.createdAt").as("first"),
      sql<Date | null>`max(messages.created_at) filter (where runs.status = 'completed')`.as(
        "completed",
      ),
      sql<
        string | null
      >`(array_agg(runs.id order by messages.created_at desc) filter (where runs.status = 'completed'))[1]`.as(
        "completedRunId",
      ),
    ])
    .where("threadInputs.threadId", "=", worker.id)
    .where(sql<string>`thread_inputs.authority_source->>'kind'`, "=", "trigger-occurrence")
    .where("triggerOccurrences.triggerId", "=", trigger.id)
    .executeTakeFirstOrThrow();
  const now = Date.now();
  const since = new Date(
    (wakes.completed?.getTime() ?? (wakes.first?.getTime() ?? now) - firstPassWindow[role]) -
      commitOverlap,
  );
  const conversations = await changedTasksSubquery(transaction, since, {
    excludeSystemWorkers: true,
  })
    .orderBy("newest", "desc")
    .limit(maxConversations + 1)
    .execute();
  const quiet = conversations.every(
    ({ newest }) => wakes.completed && newest.getTime() <= wakes.completed.getTime(),
  );
  if (
    role === "memory-light" &&
    quiet &&
    wakes.completed &&
    now - wakes.completed.getTime() < lightSourceCheck
  )
    throw new OpensteerError({
      code: "conflict",
      message: MANAGED_MEMORY_WAKE_SKIPPED,
    });
  return memoryPassWakeText({
    since,
    completedRunId: wakes.completed ? wakes.completedRunId : null,
    changes: conversations.slice(0, maxConversations).map((change) => ({
      id: change.threadId,
      title: change.title,
      count: Number(change.newMessages),
      first: change.firstNewAt,
      questionsAnswered: Number(change.questionsAnswered),
      questionsDismissed: Number(change.questionsDismissed),
      doneAt: change.doneSinceAt,
      doneBy: change.doneSinceBy,
    })),
    more: conversations.length > maxConversations,
  });
}

/** A pass reads its own earlier passes deliberately, so its Run starts without the worker's old wakes. */
export async function isMemoryPassWake(
  transaction: Transaction<DatabaseSchema>,
  threadId: ThreadId,
  authoritySource: Readonly<Record<string, unknown>>,
): Promise<boolean> {
  if (authoritySource.kind !== "trigger-occurrence") return false;
  const trigger = await transaction
    .selectFrom("triggerOccurrences")
    .innerJoin("triggers", "triggers.id", "triggerOccurrences.triggerId")
    .select("triggers.id")
    .where(
      "triggerOccurrences.id",
      "=",
      TriggerOccurrenceIdSchema.parse(authoritySource.occurrenceId),
    )
    .where("triggers.anchorThreadId", "=", threadId)
    .where("triggers.systemRole", "is not", null)
    .executeTakeFirst();
  return trigger !== undefined;
}

/**
 * Waiting is not a pause: the schedule keeps waking and each wake resolves again.
 * Admission holds this occurrence's row until its receipt commits, so a pass that
 * was accepted, or is being accepted, always wins over a retry's waiting decision.
 */
export async function recordMemoryPassWake(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly occurrenceId: TriggerOccurrenceId;
    readonly triggerId: TriggerId;
    readonly workerId: ThreadId;
    readonly waitingReason: string | null;
  },
): Promise<{
  readonly accepted: boolean;
  readonly changed: boolean;
}> {
  return commitPersonalMutation(database, async (transaction) => {
    await transaction
      .selectFrom("triggerOccurrences")
      .select("id")
      .where("id", "=", input.occurrenceId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    const receipt = await transaction
      .selectFrom("threadInputs")
      .select("messageId")
      .where("threadId", "=", input.workerId)
      .where(sql<string>`authority_source->>'occurrenceId'`, "=", input.occurrenceId)
      .executeTakeFirst();
    if (receipt)
      return {
        accepted: true,
        changed: false,
      };
    const result = await transaction
      .updateTable("triggers")
      .set({
        waitingReason: input.waitingReason,
        updatedAt: new Date(),
      })
      .where("id", "=", input.triggerId)
      .where("systemRole", "is not", null)
      .where(sql<boolean>`waiting_reason is distinct from ${input.waitingReason}`)
      .executeTakeFirst();
    return {
      accepted: false,
      changed: result.numUpdatedRows > 0n,
    };
  });
}
