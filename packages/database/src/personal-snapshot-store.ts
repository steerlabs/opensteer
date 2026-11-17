import type { ThreadId, UserId } from "@opensteer/core";
import { utf8Prefix } from "@opensteer/core";
import {
  PersonalDetailSnapshotSchema,
  PersonalShellSnapshotSchema,
} from "@opensteer/protocol/personal-sync";
import { sql } from "kysely";
import { boundedSerializedPrefix } from "./message-window.js";
import type { PersonalMutationTransaction } from "./personal-mutation.js";
import { readAttentionKeys } from "./personal-attention-store.js";
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

async function attentionPreview(
  tx: Tx,
  entry: Awaited<ReturnType<typeof readAttentionKeys>>[number],
) {
  if (entry.requestId) {
    const request = await tx
      .selectFrom("requests")
      .select(["originatingThreadId", "revision"])
      .select(sql<string>`left(presentation->>'title',192)`.as("title"))
      .where("id", "=", entry.requestId)
      .executeTakeFirstOrThrow();
    return {
      id: entry.id,
      kind: entry.kind,
      threadId: request.originatingThreadId,
      revision: request.revision,
      title: utf8Prefix(request.title || "Request", 240),
    };
  }
  const request = await tx
    .selectFrom("personalTeamRequests")
    .select("localTaskId")
    .select(sql<string>`left(presentation->>'title',192)`.as("title"))
    .select(sql<string>`left(blocked_reason,160)`.as("reason"))
    .where("teamDeploymentId", "=", entry.teamDeploymentId!)
    .where("requestId", "=", entry.teamRequestId!)
    .executeTakeFirstOrThrow();
  const revision = await tx
    .selectFrom("personalAttention")
    .select("revision")
    .where("id", "=", entry.id)
    .executeTakeFirstOrThrow();
  return {
    id: entry.id,
    kind: entry.kind,
    threadId: request.localTaskId,
    revision: revision.revision,
    title: utf8Prefix(request.title || "Team ask", 240),
    ...(request.reason ? { preview: utf8Prefix(request.reason, 500) } : {}),
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
  const selected = (await readAttentionKeys(tx, { limit: 20 })).slice(0, 20);
  const attention = [];
  for (const entry of selected) attention.push(await attentionPreview(tx, entry));
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
