import { withPersonalTransaction } from "./personal-transaction.js";
import "./connection.js";
import {
  deriveThreadStatus,
  nonTerminalRunStatuses,
  type AgentEvent,
  type ThreadId,
} from "@opensteer/core";
import type { Kysely, Transaction } from "kysely";
import { assignmentStateEventsForThread } from "./assignment-store.js";
import type { DatabaseSchema } from "./schema.js";
import { appendHostDeploymentEvent } from "./deployment-events.js";

/** Callers hold the fences in ./lock-order.ts; Run and Request facts are unlocked reads. */
export async function projectThreadState(
  transaction: Transaction<DatabaseSchema>,
  threadId: ThreadId,
  updatedAt = new Date(),
): Promise<readonly AgentEvent[]> {
  await transaction
    .selectFrom("delegations")
    .select("id")
    .where("childThreadId", "=", threadId)
    .where("status", "=", "open")
    .orderBy("id", "asc")
    .forNoKeyUpdate()
    .execute();
  // Every Request mutation records its marker after appending its event under
  // the Deployment fence; a later commit therefore cannot lose its wakeup here.
  await transaction.deleteFrom("threadStatePending").where("threadId", "=", threadId).execute();
  const thread = await transaction
    .selectFrom("threads")
    .select([
      "status",
      "title",
      "icon",
      "doneAt",
      "doneReason",
      "inputQueuePaused",
      "projectedInputQueuePaused",
      "pendingRequestCount",
      "environmentId",
    ])
    .where("id", "=", threadId)
    .executeTakeFirstOrThrow();
  const active = await transaction
    .selectFrom("runs")
    .select("status")
    .where("threadId", "=", threadId)
    .where("status", "in", nonTerminalRunStatuses)
    .orderBy("runOrdinal", "asc")
    .limit(1)
    .executeTakeFirst();
  const last = await transaction
    .selectFrom("runs")
    .select("status")
    .where("threadId", "=", threadId)
    .orderBy("runOrdinal", "desc")
    .limit(1)
    .executeTakeFirst();
  const status =
    thread.status === "archived"
      ? "archived"
      : deriveThreadStatus({
          earliestActiveRunStatus: active?.status ?? null,
          inputQueuePaused: thread.inputQueuePaused,
          lastRunFailed: last?.status === "failed",
        });
  const pending = await transaction
    .selectFrom("requests")
    .select(({ fn }) => fn.countAll<string>().as("count"))
    .where("originatingThreadId", "=", threadId)
    .where("status", "=", "pending")
    .executeTakeFirstOrThrow();
  const pendingRequests = Number(pending.count);
  const changed =
    status !== thread.status ||
    pendingRequests !== thread.pendingRequestCount ||
    thread.inputQueuePaused !== thread.projectedInputQueuePaused;
  await transaction
    .updateTable("threads")
    .set({
      status,
      pendingRequestCount: pendingRequests,
      projectedInputQueuePaused: thread.inputQueuePaused,
      updatedAt,
    })
    .where("id", "=", threadId)
    .executeTakeFirstOrThrow();
  if (!changed) return [];
  return [
    await appendHostDeploymentEvent(transaction, {
      data: {
        status,
        title: thread.title,
        icon: thread.icon,
        doneAt: thread.doneAt?.toISOString() ?? null,
        doneReason: thread.doneReason,
        inputQueuePaused: thread.inputQueuePaused,
        pendingRequests,
      },
      environmentId: thread.environmentId,
      runId: null,
      threadId,
      type: "thread.state-changed",
    }),
    ...(pendingRequests !== thread.pendingRequestCount
      ? await assignmentStateEventsForThread(transaction, threadId)
      : []),
  ];
}

/** Request events already hold the Deployment sequence fence. */
export { markThreadStatePending } from "./thread-state-pending.js";

/** How many Threads one drain pass projects; the next pass takes the rest. */
const threadStateDrainBatch = 100;

/**
 * Projects the Threads whose state is pending, oldest first. Each is its own
 * transaction, so one that fails is reported after the others are done and
 * never holds them back.
 */
export async function drainPendingThreadStates(
  database: Kysely<DatabaseSchema>,
  onCommitted?: (events: readonly AgentEvent[]) => void,
): Promise<readonly AgentEvent[]> {
  // Discover without a marker lock: Request writers own the Deployment fence before
  // touching the marker, so taking the marker first would reverse that order.
  const pending = await database
    .selectFrom("threadStatePending")
    .innerJoin("threads", "threads.id", "threadStatePending.threadId")
    .select(["threadStatePending.threadId"])
    .orderBy("threadStatePending.requestedAt", "asc")
    .orderBy("threadStatePending.threadId", "asc")
    .limit(threadStateDrainBatch)
    .execute();
  const events: AgentEvent[] = [];
  const failures: unknown[] = [];
  for (const row of pending) {
    let committed: readonly AgentEvent[];
    try {
      committed = await withPersonalTransaction(database, async (transaction) => {
        const thread = await transaction
          .selectFrom("threads")
          .select("id")
          .where("id", "=", row.threadId)
          .forNoKeyUpdate()
          .executeTakeFirst();
        if (!thread) return [];
        const marker = await transaction
          .selectFrom("threadStatePending")
          .select("threadId")
          .where("threadId", "=", row.threadId)
          .executeTakeFirst();
        return marker ? projectThreadState(transaction, row.threadId) : [];
      });
    } catch (error) {
      failures.push(error);
      continue;
    }
    events.push(...committed);
    // Deliver each committed transaction even if a later Thread blocks or fails.
    onCommitted?.(committed);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Some Thread states could not be projected");
  }
  return events;
}
