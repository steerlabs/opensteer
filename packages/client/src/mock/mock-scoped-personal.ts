import {
  MessageIdSchema,
  ExecutionNodeViewSchema,
  RunAttemptIdSchema,
  type AgentEventView,
  type ContentPart,
  RunIdSchema,
  RequestIdSchema,
  ExecutionNodeIdSchema,
  AppIdSchema,
  DelegationIdSchema,
  ThreadIdSchema,
  AuthSessionIdSchema,
  DeploymentIdSchema,
  utf8ByteLength,
  type Thread,
  type Request,
  type ThreadInputQueue,
} from "@opensteer/core";
import {
  PersonalNetworkShellSnapshotSchema,
  PersonalDetailSnapshotSchema,
  type ScopedHostMessage,
} from "@opensteer/protocol/personal-sync";
import type { PersonalResourceKind } from "@opensteer/protocol/resources";
import {
  TranscriptItemSchema,
  transcriptMessageRefLimits,
  type TranscriptItem,
} from "@opensteer/protocol/transcript";
import { type PersonalInputQueue } from "@opensteer/protocol";
import type { TranscriptFixtureSnapshot, ThreadSummary, TranscriptEntry } from "../host/client.js";
import { messageBody } from "../host/transcript.js";

type MockTranscriptSnapshot = TranscriptFixtureSnapshot;
const itemRevisions = new WeakMap<TranscriptEntry, string>();
const requestRevisions = new WeakMap<Request, string>();

export function mockRequestRevision(request: Request, through: string) {
  const revision = requestRevisions.get(request) ?? through;
  requestRevisions.set(request, revision);
  return revision;
}

export const mockPersonalEpoch = "4eae39b7-8771-4ed4-9f87-632a36e0818e";

export function mockScopedTask(
  thread: Thread,
  revision: string,
  lastReplyPreview: string | null,
  failurePreview: string | null,
) {
  return {
    title: thread.title,
    id: thread.id,
    revision,
    status: thread.status,
    inputQueuePaused: thread.inputQueuePaused,
    purpose: thread.purpose,
    askedAt: thread.askedAt,
    doneAt: thread.doneAt,
    pendingRequestCount: thread.pendingRequests,
    lastReplyPreview: lastReplyPreview?.slice(0, 500) ?? null,
    failurePreview: failurePreview?.slice(0, 500) ?? null,
    latestRunCompletedAt: thread.latestRunCompletedAt,
  };
}

/** Every listed task as a row; the client sorts its lists from the rows themselves. */
export function mockScopedShell(
  snapshot: MockTranscriptSnapshot,
  toThread: (summary: ThreadSummary) => Thread,
  selected?: string,
  revision = String(snapshot.revision),
) {
  const recent = (snapshot.tasks?.entries ?? []).slice(0, 25);
  const active = snapshot.activeTasks;
  const threads = new Map([...recent, ...active].map((entry) => [entry.thread.id, entry]));
  for (const thread of snapshot.threads)
    if ((thread.listed || thread.id === selected) && !threads.has(thread.id))
      threads.set(thread.id, { thread, lastReply: null, failure: null });
  const tasks = [...threads.values()]
    .slice(0, 256)
    .map(({ thread, lastReply, failure }) =>
      mockScopedTask(toThread(thread), revision, lastReply, failure),
    );
  const listed = new Set<string>(tasks.map(({ id }) => id));
  const activeIds = active.map(({ thread }) => thread.id).filter((id) => listed.has(id));
  const attention = (snapshot.needsYou?.entries ?? []).slice(0, 200).map((entry) =>
    entry.kind === "request"
      ? {
          id: entry.request.id,
          kind: "request",
          threadId: entry.originThreadId,
          revision,
          title: entry.title,
        }
      : {
          id: entry.requestId,
          kind: "team-ask",
          threadId: entry.task?.threadId ?? null,
          revision,
          title: "Teammate ask",
        },
  );

  return PersonalNetworkShellSnapshotSchema.parse({
    deploymentId: snapshot.deploymentId,
    viewerId: snapshot.user?.id,
    session: {
      user: snapshot.user,
      sessionSurface: snapshot.sessionSurface ?? "canonical",
      can: snapshot.can,
      sessionId: AuthSessionIdSchema.parse(
        snapshot.sessionId ?? "auth_session_mock_preview_000000000000",
      ),
    },
    epoch: mockPersonalEpoch,
    tasks,
    recentTaskIds: recent.map(({ thread }) => thread.id).filter((id) => listed.has(id)),
    activeTaskIds: activeIds,
    activeHasMore: false,
    nextBefore: snapshot.tasks?.window.nextBefore ?? null,
    taskCounts: {
      active: activeIds.length,
      open: snapshot.tasks?.window.totalItems ?? recent.length,
    },
    visits: Object.entries(snapshot.threadVisits).flatMap(([threadId, lastVisitedAt]) =>
      listed.has(threadId) ? [{ threadId, lastVisitedAt, revision }] : [],
    ),
    counts: {
      pendingRequestCount: snapshot.waitingRequests.length,
      needsYouCount: snapshot.needsYou?.count ?? 0,
      unreadTaskCount: [...threads.values()].filter(({ thread }) => thread.unread).length,
    },
    attention,
    attentionHasMore: (snapshot.needsYou?.entries.length ?? 0) > attention.length,
  });
}

export function mockScopedItems(
  snapshot: MockTranscriptSnapshot,
  threadId: string,
  nodeId?: string,
  revision = String(snapshot.revision),
  nodeEvents: readonly AgentEventView[] = [],
) {
  const rows = (snapshot.transcripts[threadId] ?? []).flatMap((entry, index) => {
    if (
      (entry.kind === "reasoning" && entry.state === "streaming") ||
      (entry.kind === "message" && entry.streaming)
    )
      return [];
    const item = mockScopedItem(entry, String(index + 1), revision);
    return item && item.nodeId === (nodeId ?? null) ? [item] : [];
  });
  if (!nodeId) return rows;
  return [...mockScopedNodeItems(threadId, nodeId, nodeEvents, revision), ...rows]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((row, index) => ({ ...row, position: String(index + 1) }));
}

function mockScopedItem(
  entry: TranscriptEntry,
  position: string,
  revision: string,
): TranscriptItem | undefined {
  const itemRevision = itemRevisions.get(entry) ?? revision;
  itemRevisions.set(entry, itemRevision);
  const value = {
    id: entry.id,
    position,
    revision: itemRevision,
    nodeId: null,
    attemptId: null,
    runId: "runId" in entry && entry.runId ? RunIdSchema.parse(entry.runId) : null,
    createdAt: entry.createdAt,
    isTurnStart: entry.kind === "message" && entry.messageKind === "input",
  };
  switch (entry.kind) {
    case "message": {
      const refs = {
        attachments: entry.attachments?.slice(0, transcriptMessageRefLimits.attachments) ?? [],
        pages: entry.pages?.slice(0, transcriptMessageRefLimits.pages) ?? [],
        places: entry.places?.slice(0, transcriptMessageRefLimits.places) ?? [],
      };
      return TranscriptItemSchema.parse({
        ...value,
        kind: entry.kind,
        messageId: MessageIdSchema.parse(entry.id),
        messageKind: entry.messageKind,
        author: entry.author,
        ...Object.fromEntries(Object.entries(refs).filter(([, list]) => list.length)),
        view: {
          preview: entry.body.slice(0, 400),
          truncated:
            entry.body.length > 400 ||
            refs.attachments.length < (entry.attachments?.length ?? 0) ||
            refs.pages.length < (entry.pages?.length ?? 0) ||
            refs.places.length < (entry.places?.length ?? 0),
          published: entry.published ?? true,
        },
      });
    }
    case "tool":
      return TranscriptItemSchema.parse({
        ...value,
        kind: entry.kind,
        toolCallId: entry.callId,
        tool: entry.tool,
        nodeId: entry.nodeId ?? null,
        view: { title: entry.tool?.name, status: entry.state, truncated: !!entry.output },
      });
    case "reasoning":
      return TranscriptItemSchema.parse({
        ...value,
        kind: entry.kind,
        blockId: entry.id.slice(0, 255),
        bindingGeneration: null,
        view: { preview: entry.text.slice(0, 400), truncated: entry.text.length > 400 },
      });
    case "request":
    case "request-wait":
      return TranscriptItemSchema.parse({
        ...value,
        kind: "request",
        requestId: RequestIdSchema.parse(entry.requestId),
        view:
          entry.kind === "request"
            ? { title: entry.title.slice(0, 192), preview: entry.outcome.slice(0, 400) }
            : { status: "pending" },
      });
    case "run":
      return TranscriptItemSchema.parse({
        ...value,
        kind: entry.kind,
        view: { status: entry.status },
        replyMessageId: entry.replyMessageId,
        endedAt: entry.endedAt,
      });
    case "node":
      return TranscriptItemSchema.parse({
        ...value,
        kind: entry.kind,
        executionNodeId: ExecutionNodeIdSchema.parse(entry.nodeId),
        nodeId: entry.parentNodeId,
        ...(entry.runId
          ? {
              node: ExecutionNodeViewSchema.parse({
                id: entry.nodeId,
                attemptId: RunAttemptIdSchema.parse(entry.runId?.replace(/^run_/, "rat_")),
                kind: entry.nodeKind,
                runId: entry.runId,
                parentNodeId: entry.parentNodeId,
                startedAt: entry.createdAt,
                endedAt: entry.completedAt,
                status: entry.status,
                title: entry.title,
                phaseIndex: entry.phaseIndex,
                phases: entry.phases,
                model: entry.model,
                effort: entry.effort,
                usage: entry.usage ?? null,
                prompt: entry.prompt,
                result: entry.result,
                stopSupported: entry.stopSupported,
                stopping: entry.stopping,
              }),
            }
          : {}),
        view: {
          title: entry.title.slice(0, 192),
          status: entry.status,
          preview: entry.result?.slice(0, 400),
        },
      });
    case "assignment":
      return TranscriptItemSchema.parse({
        ...value,
        kind: entry.kind,
        delegationId: DelegationIdSchema.parse(entry.assignment.id),
        assignment: entry.assignment,
        view: {},
      });
    case "app":
      return TranscriptItemSchema.parse({
        ...value,
        kind: entry.kind,
        appId: AppIdSchema.parse(entry.appId),
        view: { title: entry.title.slice(0, 192) },
      });
    case "place":
      return TranscriptItemSchema.parse({
        ...value,
        kind: entry.kind,
        place: { title: entry.title, tabId: entry.tabId, site: entry.site },
        view: {},
      });
    default:
      return undefined;
  }
}

type MockLive = Extract<ScopedHostMessage, { type: "host.live" }>;
const mockLiveBoot = "4eae39b7-8771-4ed4-9f87-632a36e0819e";

export function mockScopedLive(
  snapshot: MockTranscriptSnapshot,
  scope: MockLive["scope"],
  subscriptionId: MockLive["subscriptionId"],
  generation: number,
  afterSequence: string,
): MockLive[] {
  if (scope.kind === "node") return [];
  return (snapshot.transcripts[scope.threadId] ?? []).flatMap((entry, index): MockLive[] => {
    if (entry.kind !== "reasoning" || entry.state !== "streaming" || !entry.runId) return [];
    const runId = RunIdSchema.parse(entry.runId);
    const attemptId = RunAttemptIdSchema.parse(runId.replace(/^run_/, "rat_"));
    const item = mockScopedItem(entry, String(index + 1), afterSequence);
    if (!item) return [];
    const text = entry.text.slice(-4000);
    return [
      {
        type: "host.live",
        scope,
        subscriptionId,
        generation,
        afterSequence,
        runId,
        attemptId,
        liveBootId: mockLiveBoot,
        bindingGeneration: 1,
        streamId: entry.id,
        itemId: item.id,
        item: { ...item, attemptId, view: {} },
        update: {
          operation: "replace",
          offset: entry.text.length - text.length,
          totalLength: entry.text.length,
          text,
          incomplete: text.length !== entry.text.length,
        },
      },
    ];
  });
}

export function mockScopedCursor(
  snapshot: MockTranscriptSnapshot,
  threadId: string,
  nodeId: string | undefined,
  oldest: TranscriptItem | undefined,
) {
  return oldest
    ? {
        deploymentId: DeploymentIdSchema.parse(snapshot.deploymentId),
        viewerId: snapshot.user!.id,
        epoch: mockPersonalEpoch,
        threadId: ThreadIdSchema.parse(threadId),
        nodeId: nodeId ? ExecutionNodeIdSchema.parse(nodeId) : null,
        beforePosition: oldest.position,
        beforeId: oldest.id,
      }
    : null;
}

export function mockScopedDetail(
  snapshot: MockTranscriptSnapshot,
  toThread: (summary: ThreadSummary) => Thread,
  threadId: string,
  nodeId?: string,
  anchor?: string,
  revision = String(snapshot.revision),
  nodeEvents: readonly AgentEventView[] = [],
  ownsLease: (leaseId: string, messageId: string) => boolean = () => false,
) {
  const thread = snapshot.threads.find(({ id }) => id === threadId);
  if (!thread) return;
  const queued = snapshot.inputQueues[threadId];
  const inputQueue = queued ? mockInputQueue(queued, revision, ownsLease) : undefined;
  const node = nodeId
    ? snapshot.transcripts[threadId]?.find(
        (entry) => entry.kind === "node" && entry.nodeId === nodeId,
      )
    : undefined;
  if (nodeId && !node) return;
  const all = mockScopedItems(snapshot, threadId, nodeId, revision, nodeEvents);
  const requests = mockOverlayRows(snapshot, threadId, nodeId, "requests", revision, nodeEvents);
  const tools = mockOverlayRows(snapshot, threadId, nodeId, "tools", revision, nodeEvents);
  const nodes = mockOverlayRows(snapshot, threadId, nodeId, "nodes", revision, nodeEvents);
  const overlayCursors = Object.fromEntries(
    (
      [
        ["requests", requests],
        ["tools", tools],
        ["nodes", nodes],
      ] as const
    ).flatMap(([kind, entries]) => (entries.length > 20 ? [[kind, `${revision}:20`]] : [])),
  );
  const anchorIndex = anchor ? all.findIndex(({ id }) => id === anchor) : -1;
  const end = anchorIndex < 0 ? all.length : Math.min(all.length, anchorIndex + 25);
  const start = Math.max(0, end - 50);
  const items = all.slice(start, end);
  return PersonalDetailSnapshotSchema.parse({
    thread: { ...mockScopedTask(toThread(thread), revision, null, null), thread: toThread(thread) },
    ...(anchor ? { anchorItemId: anchorIndex === -1 ? null : anchor } : {}),
    items,
    activeItems: [...tools, ...nodes].slice(0, 20),
    ...(node ? { nodeSubject: mockScopedItem(node, "1", revision) } : {}),
    pendingRequests: requests.slice(0, 20),
    nextBefore: start ? mockScopedCursor(snapshot, threadId, nodeId, items[0]) : null,
    nextAfter: end < all.length ? mockScopedCursor(snapshot, threadId, nodeId, items.at(-1)) : null,
    overlayCursors,
    ...(nodeId ? {} : { inputQueue: inputQueue?.items ?? [] }),
    queue: {
      revision,
      paused: thread.inputQueuePaused,
      steerRunId: inputQueue?.steerRunId ?? null,
      inputs: inputQueue?.items.map(({ message }) => message.id) ?? [],
      runs: snapshot.runQueue
        .filter((run) => run.threadId === threadId)
        .slice(0, 2)
        .map(({ id, status, createdAt, runOrdinal }) => ({
          id,
          status,
          createdAt,
          runOrdinal,
          revision,
          finishing: false,
        })),
    },
  });
}

export function mockOverlayRows(
  snapshot: MockTranscriptSnapshot,
  threadId: string,
  nodeId: string | undefined,
  kind: "requests" | "tools" | "nodes",
  revision: string,
  nodeEvents: readonly AgentEventView[],
) {
  if (kind === "requests")
    return (snapshot.requests[threadId] ?? [])
      .filter(
        (request) =>
          request.status === "pending" && (!nodeId || request.originatingNodeId === nodeId),
      )
      .map((request) => ({
        id: request.id,
        kind: request.kind,
        status: request.status,
        threadId: ThreadIdSchema.parse(threadId),
        title: request.kind,
        revision: mockRequestRevision(request, revision),
      }));
  return mockScopedItems(snapshot, threadId, nodeId, revision, nodeEvents).filter(
    (item) => item.kind === (kind === "tools" ? "tool" : "node") && item.view.status === "running",
  );
}

function mockScopedNodeItems(
  threadId: string,
  nodeId: string,
  events: readonly AgentEventView[],
  revision: string,
) {
  const items: TranscriptItem[] = [];
  for (const event of events) {
    if (event.threadId !== threadId || !("nodeId" in event.data) || event.data.nodeId !== nodeId)
      continue;
    const base = {
      id: event.eventId,
      revision,
      position: event.sequence,
      runId: event.runId,
      attemptId: null,
      nodeId,
      isTurnStart: false,
      createdAt: event.createdAt,
    };
    switch (event.type) {
      case "node.message":
        items.push(
          TranscriptItemSchema.parse({
            ...base,
            kind: "node-message",
            view: {
              preview: event.data.text.slice(0, 400),
              truncated: event.data.text.length > 400,
            },
          }),
        );
        break;
      case "reasoning.completed":
        items.push(
          TranscriptItemSchema.parse({
            ...base,
            kind: "reasoning",
            blockId: event.data.blockId,
            bindingGeneration: null,
            view: {
              preview: event.data.text.slice(0, 400),
              truncated: event.data.text.length > 400,
            },
          }),
        );
        break;
      case "tool.started": {
        const callId = event.data.callId;
        const complete = events.find(
          (candidate) =>
            candidate.type === "tool.completed" &&
            candidate.runId === event.runId &&
            candidate.data.nodeId === nodeId &&
            candidate.data.callId === callId,
        );
        items.push(
          TranscriptItemSchema.parse({
            ...base,
            kind: "tool",
            toolCallId: event.data.callId,
            tool: event.data.tool,
            view: {
              status:
                complete?.type === "tool.completed"
                  ? complete.data.isError
                    ? "failed"
                    : "done"
                  : "running",
              truncated: true,
            },
          }),
        );
        break;
      }
    }
  }
  return items;
}

export function mockMessageContent(
  entry: Extract<TranscriptEntry, { kind: "message" }>,
): ContentPart[] {
  return [
    ...(entry.body ? [{ type: "text" as const, text: entry.body }] : []),
    ...(entry.attachments ?? []),
    ...(entry.pages ?? []),
    ...(entry.places ?? []),
  ];
}

export function mockScopedResource(
  bootstrap: Record<
    | "personalSettings"
    | "quietTaskDays"
    | "executionPreferences"
    | "identityConfig"
    | "environments"
    | "harnesses"
    | "machines"
    | "tabs",
    unknown
  > & {
    ownerProfile?: unknown;
    browser: {
      profiles: unknown;
      profileDeletions?: unknown;
      placements: unknown;
      profileHomes: unknown;
      available: boolean;
    };
  },
  kind: PersonalResourceKind,
) {
  switch (kind) {
    case "settings":
      return {
        kind,
        settings: bootstrap.personalSettings,
        quietTaskDays: bootstrap.quietTaskDays,
        executionPreferences: bootstrap.executionPreferences,
      };
    case "identity":
      return { kind, identity: bootstrap.identityConfig };
    case "owner-profile":
      return { kind, ownerProfile: bootstrap.ownerProfile ?? null };
    case "environment":
    case "harness-catalog":
      return { kind, environments: bootstrap.environments };
    case "harness":
      return { kind, harnesses: bootstrap.harnesses };
    case "machine":
      return { kind, machines: bootstrap.machines };
    case "tab":
    case "tab-layout":
      return { kind, tabs: bootstrap.tabs };
    case "browser-profile":
      return {
        kind,
        profiles: bootstrap.browser.profiles,
        deletions: bootstrap.browser.profileDeletions,
      };
    case "browser-placement":
      return { kind, placements: bootstrap.browser.placements };
    case "browser-home":
      return { kind, homes: bootstrap.browser.profileHomes };
    case "plugin":
    case "plugin-scheduled-runs":
    case "plugin-workflow-runs":
    case "plugin-webhooks":
    case "plugin-webhook-sources":
    case "plugin-schedules":
    case "team-replies":
      return { kind };
    case "plugin-engine":
      return { kind, engine: { status: "idle" } };
    case "browser-availability":
      return { kind, available: bootstrap.browser.available };
  }
}

export function boundedMockPage(items: TranscriptItem[], ascending = false) {
  const ordered = ascending ? items : items.slice().reverse();
  let size = 0;
  const bounded = ordered.filter((item) => {
    size += utf8ByteLength(JSON.stringify(item));
    return size <= 64 * 1024;
  });
  return ascending ? bounded : bounded.reverse();
}

export function mockInputQueue(
  queue: ThreadInputQueue,
  revision: string,
  ownsLease: (leaseId: string, messageId: string) => boolean,
): PersonalInputQueue {
  return {
    threadId: queue.threadId,
    paused: queue.paused,
    steerRunId: queue.steerRunId,
    revision,
    items: queue.items.map(({ message, input, lease, ...actions }, index) => ({
      message: {
        id: message.id,
        revision: message.edit?.revision ?? 0,
        ...(message.edit ? { edit: message.edit } : {}),
        author: message.author,
        createdAt: message.createdAt,
        preview: messageBody(message.content),
        attachments: message.content.filter((part) => part.type === "artifact").slice(0, 6),
        truncated: false,
      },
      input: { messageId: input.messageId, queueRank: String(index), state: input.state },
      ask:
        input.teamRequestId && input.teamSource
          ? {
              requestId: input.teamRequestId,
              teamId: input.teamSource.teamId,
              audience: input.teamSource.audience,
            }
          : null,
      lease: lease
        ? {
            deviceLabel: lease.deviceLabel,
            expiresAt: lease.expiresAt,
            ownedBySession: ownsLease(lease.leaseId, message.id),
          }
        : null,
      ...actions,
    })),
  };
}
