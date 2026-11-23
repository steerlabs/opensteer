import {
  SequenceSchema,
  contentSaysSomething,
  utf8Prefix,
  type ContentPart,
  type MessageId,
  deriveThreadStatus,
  nonTerminalRunStatuses,
  type RunId,
  type ThreadId,
  type ExecutionNodeId,
} from "@opensteer/core";
import { plainTextExcerpt } from "@opensteer/shared/plainTextExcerpt";
import { taskLineMaxLength } from "@opensteer/protocol";
import { sql, type Kysely, type Transaction, type UpdateObject } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { activePersonalMutation, commitPersonalMutation } from "./personal-mutation.js";
import { isOfflineSettlement } from "./personal-transaction.js";
import { refreshLatestRunCompletion, unreadTaskSql } from "./personal-attention-store.js";
import { refreshAssignmentWorkerSummaries } from "./assignment-store.js";
import {
  taskExternalWorkSelection,
  taskPageThreadSelections,
  taskPageThreadsFromRows,
  threadProviderRetry,
  threadRunQueued,
  threadRunStartHoldReason,
} from "./personal-task-store.js";
import { detailThreadValue, taskView } from "./personal-snapshot-store.js";
import { publishThreadQueues } from "./personal-queue-view.js";

type Tx = Transaction<DatabaseSchema>;

/** Publishes the task once per commit, after every change this commit makes to it. */
export async function publishThreadSummary(tx: Tx, threadId: ThreadId): Promise<void> {
  if (isOfflineSettlement(tx)) return;
  await commitPersonalMutation(tx, async (_tx, mutation) => mutation.deferSummary(threadId));
}

/** Publishes the task now, folding the caller's own task update into the publishing one. */
export async function writeThreadSummary(
  tx: Tx,
  threadId: ThreadId,
  changes: UpdateObject<DatabaseSchema, "threads"> = {},
): Promise<{ readonly nextTranscriptPosition: string }> {
  if (isOfflineSettlement(tx))
    return tx
      .updateTable("threads")
      .set(changes)
      .where("id", "=", threadId)
      .returning("nextTranscriptPosition")
      .executeTakeFirstOrThrow();
  return commitPersonalMutation(tx, async (tx, mutation) => {
    mutation.summaryWritten(threadId);
    const row = await tx
      .updateTable("threads")
      .set({ ...changes, revision: mutation.sequence })
      .where("id", "=", threadId)
      // The task row and the derived columns its `thread` value needs, in the one update.
      .returningAll()
      .returning(taskPageThreadSelections())
      .returning(threadRunQueued.as("runQueued"))
      .returning(threadRunStartHoldReason.as("runStartHoldReason"))
      .returning(taskExternalWorkSelection)
      .returning(threadProviderRetry.as("retry"))
      .executeTakeFirstOrThrow();
    const threadScope = `thread:${threadId}` as const;
    const view = taskView(row);
    const thread = row.removedAt
      ? undefined
      : (await taskPageThreadsFromRows(tx, [row])).get(threadId);
    if (!thread) {
      mutation.change({
        scopeKey: threadScope,
        entityKind: "thread",
        entityId: threadId,
        operation: "remove",
      });
    } else {
      mutation.change(
        { scopeKey: threadScope, entityKind: "thread", entityId: threadId, operation: "upsert" },
        () => ({ ...view, thread }),
      );
    }
    if (row.listed && row.status !== "archived" && !row.removedAt) {
      mutation.change(
        { scopeKey: "shell", entityKind: "task", entityId: threadId, operation: "upsert" },
        () => view,
      );
    } else if (row.listed) {
      mutation.change({
        scopeKey: "shell",
        entityKind: "task",
        entityId: threadId,
        operation: "remove",
      });
    }
    return row;
  });
}

export function replyPreview(content: readonly ContentPart[]) {
  const firstText = content.find((part) => part.type === "text" && /\S/u.test(part.text));
  return firstText?.type === "text"
    ? plainTextExcerpt(utf8Prefix(firstText.text, 16_384), taskLineMaxLength)
    : null;
}

/**
 * Republishes the `thread` value each viewed scope shows, so its viewers see a derived change:
 * a task's own scope through its summary, a node scope with the same value.
 */
export function republishThreads(
  database: Kysely<DatabaseSchema>,
  scopes: readonly (
    | { readonly kind: "thread"; readonly threadId: ThreadId }
    | { readonly kind: "node"; readonly threadId: ThreadId; readonly nodeId: ExecutionNodeId }
  )[],
) {
  return commitPersonalMutation(database, async (tx, mutation) => {
    if (!scopes.length) return;
    const live = await tx
      .selectFrom("threads")
      .select(["id", "createdBy"])
      .where("id", "in", [...new Set(scopes.map(({ threadId }) => threadId))])
      .where("removedAt", "is", null)
      .orderBy("id")
      .execute();
    for (const { id, createdBy } of live) {
      await publishThreadSummary(tx, id);
      const nodes = scopes.flatMap((scope) =>
        scope.kind === "node" && scope.threadId === id ? [scope.nodeId] : [],
      );
      const value = nodes.length ? await detailThreadValue(tx, createdBy, id) : undefined;
      for (const nodeId of value ? nodes : [])
        mutation.change(
          { scopeKey: `node:${nodeId}`, entityKind: "thread", entityId: id, operation: "upsert" },
          () => ({ ...value!, revision: mutation.sequence }),
        );
    }
  });
}

export async function projectLastReply(
  tx: Tx,
  reply: {
    readonly id: MessageId;
    readonly threadId: ThreadId;
    readonly content: readonly ContentPart[];
  },
): Promise<void> {
  if (!contentSaysSomething(reply.content)) return;
  await tx
    .updateTable("threads")
    .set({ lastReplyMessageId: reply.id, lastReplyPreview: replyPreview(reply.content) })
    .where("id", "=", reply.threadId)
    .execute();
  await publishThreadSummary(tx, reply.threadId);
}

export async function publishRunQueue(tx: Tx, threadId: ThreadId, runId?: RunId) {
  if (isOfflineSettlement(tx)) return;
  await commitPersonalMutation(tx, async (tx, mutation) => {
    mutation.react({ type: "executionCommandsChanged" });
    if (runId)
      await tx
        .updateTable("runs")
        .set({ revision: mutation.sequence })
        .where("id", "=", runId)
        .where("threadId", "=", threadId)
        .execute();
    await publishThreadQueues(tx, threadId);
    // A Run phase change can flip the shell row's `runQueued` without moving the task status.
    mutation.deferSummary(threadId);
  });
}

/** Callers hold the domain locks. Intrinsic summary facts are read from the same commit. */
export async function projectThreadState(
  tx: Tx,
  threadId: ThreadId,
  updatedAt = new Date(),
  force = false,
): Promise<void> {
  if (isOfflineSettlement(tx)) return;
  await commitPersonalMutation(tx, async (tx, mutation) => {
    // The task, whether it counts as unread, its earliest active Run and its last Run: one read.
    const row = await tx
      .selectFrom("threads")
      .leftJoinLateral(
        (eb) =>
          eb
            .selectFrom("runs")
            .select("runs.status as activeStatus")
            .where("runs.threadId", "=", threadId)
            .where("runs.maintenance", "is", null)
            .where("runs.status", "in", nonTerminalRunStatuses)
            .orderBy("runs.runOrdinal")
            .limit(1)
            .as("active"),
        (join) => join.onTrue(),
      )
      .leftJoinLateral(
        (eb) =>
          eb
            .selectFrom("runs")
            .select([
              "runs.status as lastStatus",
              "runs.maintenance as lastMaintenance",
              "runs.failure as lastFailure",
            ])
            .where("runs.threadId", "=", threadId)
            .orderBy("runs.runOrdinal", "desc")
            .limit(1)
            .as("last"),
        (join) => join.onTrue(),
      )
      .select([
        sql<string | null>`(
          select case when exists (
            select 1 from requests
            where requests.originating_agent_session_id = agent_sessions.id
              and requests.status = 'pending'
          ) then 'waiting' else 'active' end
          from agent_sessions
          where agent_sessions.thread_id = threads.id and agent_sessions.status = 'active'
        )`.as("agentSession"),
        "threads.status",
        "threads.inputQueuePaused",
        "threads.failureCode",
        "threads.failurePreview",
        "threads.latestRunCompletedAt",
        "active.activeStatus",
        "last.lastStatus",
        "last.lastMaintenance",
        "last.lastFailure",
        unreadTaskSql.as("unread"),
      ])
      .where("threads.id", "=", threadId)
      .executeTakeFirstOrThrow();
    const before = Number(row.unread ?? false);
    const thread = row;
    const active = row.activeStatus ? { status: row.activeStatus } : undefined;
    const last = row.lastStatus
      ? { status: row.lastStatus, maintenance: row.lastMaintenance, failure: row.lastFailure }
      : undefined;
    const failed = last?.status === "failed" && last.maintenance === null;
    const status =
      thread.status === "archived"
        ? "archived"
        : deriveThreadStatus({
            earliestActiveRunStatus: active?.status ?? null,
            inputQueuePaused: thread.inputQueuePaused,
            lastRunFailed: failed,
            agentSession: row.agentSession as "active" | "waiting" | null,
          });
    const failure = last?.failure;
    const failureCode = failed && failure ? failure.code : null;
    const failurePreview =
      failed && failure ? plainTextExcerpt(failure.message, taskLineMaxLength) : null;
    const changed =
      status !== thread.status ||
      failureCode !== thread.failureCode ||
      failurePreview !== thread.failurePreview;
    if (changed || force) {
      await tx
        .updateTable("threads")
        .set({
          status,
          failureCode,
          failurePreview,
          ...(last?.maintenance ? {} : { updatedAt }),
        })
        .where("id", "=", threadId)
        .execute();
    }
    // Status never moves to or from archived here, so unread can only follow the completion.
    const current = (await refreshLatestRunCompletion(tx, mutation, threadId, before, true)) ?? {
      latestRunCompletedAt: thread.latestRunCompletedAt,
    };
    if (
      changed ||
      force ||
      current.latestRunCompletedAt?.getTime() !== thread.latestRunCompletedAt?.getTime()
    )
      await publishThreadSummary(tx, threadId);
    if (status !== thread.status) await refreshAssignmentWorkerSummaries(tx, threadId);
  });
}

export async function threadMutationHead(tx: Tx, threadId: ThreadId) {
  // A summary this commit has yet to write already belongs to its head.
  const mutation = activePersonalMutation(tx);
  if (mutation?.summaryPending(threadId)) return SequenceSchema.parse(mutation.sequence);
  const state = await tx
    .selectFrom("clientSyncState")
    .select(
      sql<string>`greatest(sequence, (select revision from threads where id = ${threadId}))`.as(
        "sequence",
      ),
    )
    .limit(1)
    .executeTakeFirstOrThrow();
  return SequenceSchema.parse(state.sequence);
}
