import type { ThreadId, UserId } from "@opensteer/core";
import { utf8Prefix } from "@opensteer/core";
import {
  PersonalDetailSnapshotSchema,
  PersonalShellSnapshotSchema,
} from "@opensteer/protocol/personal-sync";
import type { PersonalResourceKind, PersonalResourceView } from "@opensteer/protocol/resources";
import { encodeOverlayCursor, overlayPage } from "./personal-overlay-store.js";
import { threadQueueView } from "./personal-queue-view.js";
import { nodeSubjectView } from "./execution-nodes.js";
import { boundedSerializedPrefix } from "./message-window.js";
import type { PersonalMutationTransaction } from "./personal-mutation.js";
import { readAttentionKeys, requireFreshPersonalAttention } from "./personal-attention-store.js";
import {
  type authorizedSyncState,
  type PersonalReadScope,
  readTranscriptPage,
} from "./personal-sync-store.js";
import {
  currentTasks,
  readInitialTaskWindows,
  readTaskPageThreads,
} from "./personal-task-store.js";

type Tx = PersonalMutationTransaction;
type SyncState = Awaited<ReturnType<typeof authorizedSyncState>>;
type Task = Awaited<ReturnType<ReturnType<typeof currentTasks>["executeTakeFirstOrThrow"]>>;

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
    pendingRequestCount: task.pendingRequestCount,
    lastReplyPreview: task.lastReplyPreview,
    failurePreview: task.failurePreview,
    latestRunCompletedAt: task.latestRunCompletedAt?.toISOString() ?? null,
  };
}

export type InitialPersonalResourcesReader = (
  tx: Tx,
  viewerId: UserId,
) => Promise<readonly { kind: PersonalResourceKind; view: PersonalResourceView }[]>;

export async function buildPersonalShellSnapshot(
  tx: Tx,
  state: SyncState,
  viewerId: UserId,
  selectedThreadId?: ThreadId,
  readResources?: InitialPersonalResourcesReader,
) {
  const window = await readInitialTaskWindows(tx, {
    viewerId,
    ...(selectedThreadId ? { selectedThreadId } : {}),
  });
  await requireFreshPersonalAttention(tx);
  const attention = await readPendingAttention(tx);
  const { pendingRequestCount, needsYouCount, unreadTaskCount } = state;
  const resources: { kind: PersonalResourceKind; revision: string; view: PersonalResourceView }[] =
    [];
  let resourceBytes = 2;
  for (const { kind, view } of await (readResources?.(tx, viewerId) ?? [])) {
    const entry = { kind, revision: state.resourceRevisions[kind], view };
    const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (resourceBytes + size > 24 * 1024) continue;
    resourceBytes += size;
    resources.push(entry);
  }
  return PersonalShellSnapshotSchema.parse({
    deploymentId: state.deploymentId,
    viewerId,
    epoch: state.epoch,
    tasks: window.tasks.map(taskView),
    recentTaskIds: window.recent,
    activeTaskIds: window.active,
    activeHasMore: window.activeHasMore,
    taskCounts: window.taskCounts,
    nextBefore: window.recentNextBefore
      ? Buffer.from(JSON.stringify({ ...window.recentNextBefore, window: "recent" })).toString(
          "base64url",
        )
      : null,
    visits: window.visits.map((visit) => ({
      ...visit,
      lastVisitedAt: visit.lastVisitedAt.toISOString(),
      revision: state.sequence,
    })),
    attention: attention.items,
    attentionHasMore: attention.hasMore,
    counts: { pendingRequestCount, needsYouCount, unreadTaskCount },
    resourceRevisions: state.resourceRevisions,
    ...(readResources ? { resources } : {}),
  });
}

const inputQueueSnapshotBytes = 24 * 1024;

export async function buildPersonalDetailSnapshot(
  tx: Tx,
  state: SyncState,
  viewerId: UserId,
  scope: Exclude<PersonalReadScope, { kind: "shell" }>,
  anchorItemId?: string,
) {
  const thread = await currentTasks(tx, viewerId)
    .where("id", "=", scope.threadId)
    .executeTakeFirstOrThrow();
  const view = (await readTaskPageThreads(tx, viewerId, [thread.id])).get(thread.id);
  if (!view) throw new Error("The selected task changed in its read cut");
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
  const nodes = await overlayPage(tx, scope, address, "nodes", 10, 8 * 1024);
  const queue = root ? await threadQueueView(tx, thread.id, state.sequence) : null;
  const nodeSubject =
    scope.kind === "node" ? await nodeSubjectView(tx, thread.id, scope.nodeId) : undefined;
  return PersonalDetailSnapshotSchema.parse({
    thread: { ...taskView(thread), thread: view },
    ...(queue
      ? {
          queue: queue.queue,
          inputQueue: boundedSerializedPrefix(
            queue.entries,
            queue.entries.length,
            inputQueueSnapshotBytes,
          ).items,
        }
      : {}),
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
    kind: "request" | "team-ask" | "failed-ask";
    threadId: ThreadId | null;
    revision: string;
    title: string;
    preview?: string;
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
        title: utf8Prefix(entry.title || (entry.kind === "request" ? "Request" : "Team ask"), 240),
        ...(entry.blockedReason ? { preview: utf8Prefix(entry.blockedReason, 500) } : {}),
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
