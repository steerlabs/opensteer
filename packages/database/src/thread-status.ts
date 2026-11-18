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
} from "@opensteer/core";
import { plainTextExcerpt } from "@opensteer/shared/plainTextExcerpt";
import { taskLineMaxLength } from "@opensteer/protocol";
import { sql, type Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import { isOfflineSettlement } from "./personal-transaction.js";
import { refreshLatestRunCompletion, unreadTaskContribution } from "./personal-attention-store.js";
import { refreshAssignmentWorkerSummaries } from "./assignment-store.js";

type Tx = Transaction<DatabaseSchema>;

export async function invalidateThreadCollection(tx: Tx, threadId: ThreadId, collection: string) {
  if (isOfflineSettlement(tx)) return;
  await commitPersonalMutation(tx, async (_tx, mutation) => {
    mutation.change(
      {
        scopeKey: `thread:${threadId}`,
        entityKind: "collection",
        entityId: collection,
        operation: "invalidate",
      },
      () => ({ revision: mutation.sequence }),
    );
  });
}

export async function publishThreadSummary(tx: Tx, threadId: ThreadId): Promise<void> {
  if (isOfflineSettlement(tx)) return;
  await commitPersonalMutation(tx, async (tx, mutation) => {
    const row = await tx
      .updateTable("threads")
      .set({ revision: mutation.sequence })
      .where("id", "=", threadId)
      .returning([
        "id",
        "title",
        "revision",
        "status",
        "inputQueuePaused",
        "purpose",
        "askedAt",
        "doneAt",
        "pendingRequestCount",
        "lastReplyPreview",
        "failurePreview",
        "latestRunCompletedAt",
        "listed",
        "removedAt",
      ])
      .executeTakeFirstOrThrow();
    const threadScope = `thread:${threadId}` as const;
    const view = {
      id: row.id,
      title: row.title,
      revision: row.revision,
      status: row.status,
      inputQueuePaused: row.inputQueuePaused,
      purpose: row.purpose,
      askedAt: row.askedAt.toISOString(),
      doneAt: row.doneAt?.toISOString() ?? null,
      pendingRequestCount: row.pendingRequestCount,
      lastReplyPreview: row.lastReplyPreview,
      failurePreview: row.failurePreview,
      latestRunCompletedAt: row.latestRunCompletedAt?.toISOString() ?? null,
    };
    if (row.removedAt) {
      mutation.change({
        scopeKey: threadScope,
        entityKind: "thread",
        entityId: threadId,
        operation: "remove",
      });
    } else {
      mutation.change(
        { scopeKey: threadScope, entityKind: "thread", entityId: threadId, operation: "upsert" },
        () => view,
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
  const firstText = reply.content.find((part) => part.type === "text" && /\S/u.test(part.text));
  const preview =
    firstText?.type === "text"
      ? plainTextExcerpt(utf8Prefix(firstText.text, 16_384), taskLineMaxLength)
      : null;
  await tx
    .updateTable("threads")
    .set({ lastReplyMessageId: reply.id, lastReplyPreview: preview })
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
    const thread = await tx
      .selectFrom("threads")
      .select("inputQueuePaused")
      .where("id", "=", threadId)
      .executeTakeFirstOrThrow();
    const runs = await tx
      .selectFrom("runs")
      .select(["id", "status", "revision"])
      .select(sql<boolean>`finish_intent is not null`.as("finishing"))
      .where("threadId", "=", threadId)
      .where(sql<boolean>`status in ('queued','starting','running','waiting')`)
      .orderBy("runOrdinal")
      .limit(2)
      .execute();
    mutation.change(
      {
        scopeKey: `thread:${threadId}`,
        entityKind: "run-queue",
        entityId: threadId,
        operation: "upsert",
      },
      () => ({ revision: mutation.sequence, runs, paused: thread.inputQueuePaused }),
    );
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
    const before = await unreadTaskContribution(tx, threadId);
    const thread = await tx
      .selectFrom("threads")
      .select(["status", "inputQueuePaused", "failurePreview", "latestRunCompletedAt"])
      .where("id", "=", threadId)
      .executeTakeFirstOrThrow();
    const active = await tx
      .selectFrom("runs")
      .select("status")
      .where("threadId", "=", threadId)
      .where("maintenance", "is", null)
      .where("status", "in", nonTerminalRunStatuses)
      .orderBy("runOrdinal")
      .limit(1)
      .executeTakeFirst();
    const last = await tx
      .selectFrom("runs")
      .select(["status", "maintenance", "failure"])
      .where("threadId", "=", threadId)
      .orderBy("runOrdinal", "desc")
      .limit(1)
      .executeTakeFirst();
    const failed = last?.status === "failed" && last.maintenance === null;
    const status =
      thread.status === "archived"
        ? "archived"
        : deriveThreadStatus({
            earliestActiveRunStatus: active?.status ?? null,
            inputQueuePaused: thread.inputQueuePaused,
            lastRunFailed: failed,
          });
    const failure = last?.failure;
    const failurePreview =
      failed && failure ? plainTextExcerpt(failure.message, taskLineMaxLength) : null;
    const changed = status !== thread.status || failurePreview !== thread.failurePreview;
    if (changed || force) {
      await tx
        .updateTable("threads")
        .set({
          status,
          failurePreview,
          ...(last?.maintenance ? {} : { updatedAt }),
        })
        .where("id", "=", threadId)
        .execute();
    }
    await refreshLatestRunCompletion(tx, mutation, threadId, before);
    const current = await tx
      .selectFrom("threads")
      .select("latestRunCompletedAt")
      .where("id", "=", threadId)
      .executeTakeFirstOrThrow();
    if (
      changed ||
      force ||
      current.latestRunCompletedAt?.getTime() !== thread.latestRunCompletedAt?.getTime()
    )
      await publishThreadSummary(tx, threadId);
    if (changed || force) await invalidateThreadCollection(tx, threadId, "return-hint");
    if (status !== thread.status) await refreshAssignmentWorkerSummaries(tx, threadId);
  });
}

export async function threadMutationHead(tx: Tx, threadId: ThreadId) {
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
