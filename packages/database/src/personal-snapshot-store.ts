import type { ThreadId, UserId } from "@opensteer/core";
import { utf8Prefix } from "@opensteer/core";
import {
  PersonalDetailSnapshotSchema,
  PersonalShellSnapshotSchema,
} from "@opensteer/protocol/personal-sync";
import { sql } from "kysely";
import { boundedSerializedPrefix } from "./message-window.js";
import type { PersonalMutationTransaction } from "./personal-mutation.js";
import { readAttentionKeys, requireFreshPersonalAttention } from "./personal-attention-store.js";
import {
  type authorizedSyncState,
  drawableItems,
  itemView,
  type PersonalReadScope,
  readTranscriptPage,
} from "./personal-sync-store.js";
import { currentTasks, readInitialTaskWindows } from "./personal-task-store.js";

type Tx = PersonalMutationTransaction;
type SyncState = Awaited<ReturnType<typeof authorizedSyncState>>;
type Task = Awaited<ReturnType<ReturnType<typeof currentTasks>["executeTakeFirstOrThrow"]>>;

function taskView(task: Task) {
  return {
    id: task.id,
    title: task.title,
    revision: task.revision,
    status: task.status,
    purpose: task.purpose,
    askedAt: task.askedAt.toISOString(),
    doneAt: task.doneAt?.toISOString() ?? null,
    pendingRequestCount: task.pendingRequestCount,
    lastReplyPreview: task.lastReplyPreview,
    failurePreview: task.failurePreview,
    latestRunCompletedAt: task.latestRunCompletedAt?.toISOString() ?? null,
  };
}

export async function buildPersonalShellSnapshot(
  tx: Tx,
  state: SyncState,
  viewerId: UserId,
  selectedThreadId?: ThreadId,
) {
  const window = await readInitialTaskWindows(tx, {
    viewerId,
    ...(selectedThreadId ? { selectedThreadId } : {}),
  });
  await requireFreshPersonalAttention(tx);
  const attention = (await readAttentionKeys(tx, { limit: 20 })).slice(0, 20).map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    threadId: entry.threadId,
    revision: entry.revision,
    title: utf8Prefix(entry.title || (entry.kind === "request" ? "Request" : "Team ask"), 240),
    ...(entry.blockedReason ? { preview: utf8Prefix(entry.blockedReason, 500) } : {}),
  }));
  const { pendingRequestCount, needsYouCount, unreadTaskCount } = state;
  return PersonalShellSnapshotSchema.parse({
    deploymentId: state.deploymentId,
    viewerId,
    epoch: state.epoch,
    tasks: window.tasks.map(taskView),
    visits: window.visits.map((visit) => ({
      ...visit,
      lastVisitedAt: visit.lastVisitedAt.toISOString(),
      revision: state.sequence,
    })),
    attention: boundedSerializedPrefix(attention, 20, 16 * 1024).items,
    counts: { pendingRequestCount, needsYouCount, unreadTaskCount },
    resourceRevisions: state.resourceRevisions,
  });
}

export async function buildPersonalDetailSnapshot(
  tx: Tx,
  state: SyncState,
  viewerId: UserId,
  scope: Exclude<PersonalReadScope, { kind: "shell" }>,
  anchorItemId?: string,
) {
  const thread = await currentTasks(tx, viewerId)
    .where("id", "=", scope.threadId)
    .select(["inputQueueRevision", "inputQueuePaused"])
    .executeTakeFirstOrThrow();
  const page = await readTranscriptPage(tx, {
    viewerId,
    scope,
    limit: 50,
    maxBytes: 64 * 1024,
    maxTurns: 10,
    ...(anchorItemId ? { anchorItemId } : {}),
  });
  if (page.kind !== "page") throw new Error("The selected transcript changed in its read cut");
  const root = scope.kind === "thread";
  const pending = tx
    .selectFrom("requests")
    .select(["id", "kind", "status", "revision", "originatingThreadId as threadId"])
    .select(sql<string>`left(presentation->>'title',192)`.as("title"))
    .where("originatingThreadId", "=", thread.id)
    .where(sql<boolean>`status='pending'`)
    .orderBy("id")
    .limit(20);
  const requests = await (
    root
      ? pending.where("originatingNodeId", "is", null)
      : pending.where("originatingNodeId", "=", scope.nodeId)
  ).execute();
  const open = tx
    .selectFrom("toolCalls")
    .select("id")
    .where("threadId", "=", thread.id)
    .where(sql<boolean>`status='open'`)
    .orderBy("id")
    .limit(20);
  const running = tx
    .selectFrom("executionNodes")
    .select("id")
    .where(sql<boolean>`status='running'`)
    .orderBy("id")
    .limit(20);
  const activeTools = await (
    root ? open.where("nodeId", "is", null) : open.where("nodeId", "=", scope.nodeId)
  ).execute();
  const queue = root
    ? await tx
        .selectFrom("runs")
        .select(["id", "status", "revision"])
        .select(sql<boolean>`finish_intent is not null`.as("finishing"))
        .where("threadId", "=", thread.id)
        .where(sql<boolean>`status in ('queued','starting','running','waiting')`)
        .orderBy("runOrdinal")
        .limit(2)
        .execute()
    : [];
  const activeNodes = root
    ? queue.length
      ? await running
          .where(
            "runId",
            "in",
            queue.map(({ id }) => id),
          )
          .where("parentNodeId", "is", null)
          .execute()
      : []
    : await running.where("parentNodeId", "=", scope.nodeId).execute();
  const itemIds = [
    ...activeTools.map(({ id }) => `tool:${id}`),
    ...activeNodes.map(({ id }) => `node:${id}`),
  ];
  const overlays = itemIds.length
    ? await drawableItems(tx, scope)
        .where("id", "in", itemIds)
        .orderBy("position", "desc")
        .orderBy("id", "desc")
        .limit(20)
        .execute()
    : [];
  return PersonalDetailSnapshotSchema.parse({
    thread: taskView(thread),
    orderRevision: page.orderRevision,
    inputQueueRevision: thread.inputQueueRevision,
    ...(root
      ? { queue: { revision: state.sequence, runs: queue, paused: thread.inputQueuePaused } }
      : {}),
    items: page.items,
    pendingRequests: boundedSerializedPrefix(
      requests.map((row) => ({ ...row, title: utf8Prefix(row.title || "Request", 240) })),
      20,
      16 * 1024,
    ).items,
    activeItems: boundedSerializedPrefix(overlays.map(itemView), 20, 16 * 1024).items,
    nextBefore: page.nextBefore,
  });
}
