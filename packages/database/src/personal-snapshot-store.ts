import { AgentConnectionIdentityAtConsentSchema } from "@opensteer/control-plane-protocol";
import type { ThreadId, UserId } from "@opensteer/core";
import type { DurablePersonalResourceKind } from "@opensteer/protocol/resources";
import { utf8Prefix } from "@opensteer/core";
import {
  PersonalDetailSnapshotSchema,
  PersonalShellSnapshotSchema,
} from "@opensteer/protocol/personal-sync";
import { activeRunQueue, encodeOverlayCursor, overlayPage } from "./personal-overlay-store.js";
import { threadQueueView } from "./personal-queue-view.js";
import { nodeSubjectView } from "./execution-nodes.js";
import { clientSendKeyWireReserve } from "@opensteer/protocol/transcript";
import type { PersonalMutationTransaction } from "./personal-mutation.js";
import { readAttentionKeys } from "./personal-attention-store.js";
import {
  type authorizedSyncState,
  type PersonalReadScope,
  readTranscriptPage,
} from "./personal-sync-store.js";
import {
  currentTasks,
  readInitialTaskWindows,
  taskExternalWorkSelection,
  taskPageThreadSelections,
  taskPageThreadsFromRows,
  threadProviderRetry,
  threadRunQueued,
  type TaskExternalWork,
} from "./personal-task-store.js";

type Tx = PersonalMutationTransaction;
type SyncState = Awaited<ReturnType<typeof authorizedSyncState>>;
type Task = Awaited<ReturnType<ReturnType<typeof currentTasks>["executeTakeFirstOrThrow"]>>;

function encodeTaskBoundary(
  boundary: { readonly at: string; readonly id: ThreadId } | null,
  window: "active" | "recent",
) {
  return boundary
    ? Buffer.from(JSON.stringify({ ...boundary, window })).toString("base64url")
    : null;
}

export function taskView(task: Task) {
  return {
    id: task.id,
    title: task.title,
    revision: task.revision,
    status: task.status,
    inputQueuePaused: task.inputQueuePaused,
    purpose: task.purpose,
    askedAt: task.askedAt.toISOString(),
    doneAt: task.doneAt?.toISOString() ?? null,
    doneReason: task.doneReason,
    pendingRequestCount: task.pendingRequestCount,
    lastReplyPreview: task.lastReplyPreview,
    failurePreview: task.failurePreview,
    latestRunCompletedAt: task.latestRunCompletedAt?.toISOString() ?? null,
    environmentId: task.environmentId,
    harnessInstanceId: task.harnessInstanceId,
    runQueued: task.runQueued,
    ...(task.externalWork?.status === "active"
      ? { agentSessionId: task.externalWork.sessionId }
      : {}),
    ...(task.externalWork ? { externalWork: externalWorkView(task.externalWork) } : {}),
    retry: task.retry ?? null,
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
  const attention = await readPendingAttention(tx);
  const { pendingRequestCount, pendingRequestsRevision, needsYouCount, unreadTaskCount } = state;
  return PersonalShellSnapshotSchema.parse({
    deploymentId: state.deploymentId,
    viewerId,
    epoch: state.epoch,
    tasks: window.tasks.map(taskView),
    recentTaskIds: window.recent,
    activeTaskIds: window.active,
    activeNextBefore: encodeTaskBoundary(window.activeNextBefore, "active"),
    taskCounts: window.taskCounts,
    nextBefore: encodeTaskBoundary(window.recentNextBefore, "recent"),
    visits: window.visits.map((visit) => ({
      ...visit,
      lastVisitedAt: visit.lastVisitedAt.toISOString(),
      revision: state.sequence,
    })),
    attention: attention.items,
    attentionHasMore: attention.hasMore,
    counts: { pendingRequestCount, pendingRequestsRevision, needsYouCount, unreadTaskCount },
  });
}

const inputQueueSnapshotBytes = 24 * 1024;

/**
 * Resources a task's compaction return hint reads besides the task itself: the owner's idle
 * compaction policy, the harness, its environment and the hosting computer's capabilities.
 */
export const returnHintResources: ReadonlySet<DurablePersonalResourceKind> = new Set([
  "settings",
  "environment",
  "machine",
  "harness",
  "harness-catalog",
]);

/** A task's detail value: its row and full Thread view, return hint included. */
export async function detailThreadValue(tx: Tx, viewerId: UserId, threadId: ThreadId) {
  // One read of the row serves both the task fields and the thread value derived from it.
  const row = await tx
    .selectFrom("threads")
    .selectAll("threads")
    .select(taskPageThreadSelections())
    .select(threadRunQueued.as("runQueued"))
    .select(taskExternalWorkSelection)
    .select(threadProviderRetry.as("retry"))
    .where("threads.id", "=", threadId)
    .where("threads.createdBy", "=", viewerId)
    .where("threads.removedAt", "is", null)
    .executeTakeFirst();
  const view = row && (await taskPageThreadsFromRows(tx, [row])).get(row.id);
  return row && view ? { ...taskView(row), thread: view } : undefined;
}

/**
 * A resumed detail gets its current thread value when a return-hint input changed since its
 * cursor: the hint is derived, so no feed row of this scope carried the change.
 */
export async function resumedThreadValue(
  tx: Tx,
  state: SyncState,
  viewerId: UserId,
  threadId: ThreadId,
  after: string,
) {
  const changed = [...returnHintResources].some(
    (kind) => BigInt(state.resourceRevisions[kind] ?? "0") > BigInt(after),
  );
  const value = changed ? await detailThreadValue(tx, viewerId, threadId) : undefined;
  // The task row did not change, its derived hint did: stamp the cut so a reader holding the
  // row's own revision takes this value.
  return value
    ? {
        entityKind: "thread" as const,
        entityId: threadId,
        operation: "upsert" as const,
        value: { ...value, revision: state.sequence },
      }
    : null;
}

/** The queue values that fit, budgeted for the send key each reader's own messages gain. */
function queueSnapshot(queue: NonNullable<Awaited<ReturnType<typeof threadQueueView>>>) {
  const inputQueue = [];
  let bytes = 2;
  for (const entry of queue.entries) {
    const size =
      Buffer.byteLength(JSON.stringify(entry)) +
      1 +
      (entry.message.author.kind === "human" ? clientSendKeyWireReserve : 0);
    if (bytes + size > inputQueueSnapshotBytes) break;
    bytes += size;
    inputQueue.push(entry);
  }
  return {
    queue: queue.queue,
    inputQueue,
    inputQueueComplete: inputQueue.length === queue.entries.length,
  };
}

export async function buildPersonalDetailSnapshot(
  tx: Tx,
  state: SyncState,
  viewerId: UserId,
  scope: Exclude<PersonalReadScope, { kind: "shell" }>,
  anchorItemId?: string,
) {
  const detailThread = await detailThreadValue(tx, viewerId, scope.threadId);
  if (!detailThread) throw new Error("The selected task changed in its read cut");
  const thread = detailThread;
  const page = await readTranscriptPage(tx, {
    viewerId,
    scope,
    // A task's own read is authorized above; a node's still checks its node.
    ...(scope.kind === "thread" ? { authorized: { state, thread } } : {}),
    limit: 50,
    maxBytes: 768 * 1024,
    maxTurns: 10,
    ...(anchorItemId ? { anchorItemId } : {}),
  });
  if (page.kind !== "page") throw new Error("The selected transcript changed in its read cut");
  const root = scope.kind === "thread";
  const address = {
    deploymentId: state.deploymentId,
    epoch: state.epoch,
    viewerId,
    threadId: thread.id,
    nodeId: scope.kind === "node" ? scope.nodeId : null,
    revision: thread.revision,
  };
  const requests = await overlayPage(tx, scope, address, "requests");
  const tools = await overlayPage(tx, scope, address, "tools", 10, 8 * 1024);
  // The task's Runs serve both its top-level subagents and its queue: read once.
  const activeRuns = root ? await activeRunQueue(tx, thread.id) : undefined;
  const nodes = await overlayPage(tx, scope, address, "nodes", 10, 8 * 1024, undefined, activeRuns);
  const queue = root ? await threadQueueView(tx, thread.id, state.sequence, activeRuns) : null;
  const nodeSubject =
    scope.kind === "node" ? await nodeSubjectView(tx, thread.id, scope.nodeId) : undefined;
  return PersonalDetailSnapshotSchema.parse({
    thread: detailThread,
    ...(queue ? queueSnapshot(queue) : {}),
    ...(nodeSubject ? { nodeSubject } : {}),
    items: page.items,
    pendingRequests: requests.items,
    activeItems: [...tools.items, ...nodes.items],
    overlayCursors: {
      ...(requests.nextBefore ? { requests: encodeOverlayCursor(requests.nextBefore) } : {}),
      ...(tools.nextBefore ? { tools: encodeOverlayCursor(tools.nextBefore) } : {}),
      ...(nodes.nextBefore ? { nodes: encodeOverlayCursor(nodes.nextBefore) } : {}),
    },
    nextBefore: page.nextBefore,
    nextAfter: page.nextAfter,
    anchorItemId: "anchorItemId" in page ? page.anchorItemId : null,
  });
}

const attentionSnapshotBytes = 16 * 1024;
const attentionSnapshotRows = 200;

/** Every pending attention row while it fits the shell frame. */
async function readPendingAttention(tx: Tx) {
  const items: {
    id: string;
    kind: "request";
    threadId: ThreadId | null;
    revision: string;
    title: string;
  }[] = [];
  let bytes = 2;
  let before: { at: string; id: string } | undefined;
  for (;;) {
    const page = await readAttentionKeys(tx, { limit: 50, ...(before ? { before } : {}) });
    for (const entry of page.slice(0, 50)) {
      const row = {
        id: entry.id,
        kind: entry.kind,
        threadId: entry.threadId,
        revision: entry.revision,
        title: utf8Prefix(entry.title || "Request", 240),
      };
      const size = Buffer.byteLength(JSON.stringify(row)) + 1;
      if (bytes + size > attentionSnapshotBytes || items.length === attentionSnapshotRows)
        return { items, hasMore: true };
      bytes += size;
      items.push(row);
    }
    if (page.length <= 50) return { items, hasMore: false };
    const last = page[49]!;
    before = { at: last.at, id: last.id };
  }
}

/** A session task's connection as clients name it: no credential, only what the Home proved. */
function externalWorkView(work: TaskExternalWork) {
  const { connection } = work;
  let redirectOrigin: string | null = null;
  try {
    redirectOrigin = connection.redirectUri ? new URL(connection.redirectUri).origin : null;
  } catch {
    redirectOrigin = null;
  }
  const identity = AgentConnectionIdentityAtConsentSchema.safeParse(connection.identityAtConsent);
  return {
    sessionId: work.sessionId,
    status: work.status,
    endReason: work.endReason,
    connection: {
      id: connection.id,
      label: connection.label,
      clientName: connection.clientName,
      client: { fingerprint: connection.clientFingerprint, redirectOrigin },
      ...(identity.success ? { identityAtConsent: identity.data } : {}),
    },
  };
}
