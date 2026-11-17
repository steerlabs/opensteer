import {
  MessageIdSchema,
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
} from "@opensteer/core";
import {
  PersonalShellSnapshotSchema,
  PersonalDetailSnapshotSchema,
} from "@opensteer/protocol/personal-sync";
import {
  PersonalResourceDataSchema,
  PersonalResourceRevisionsSchema,
  personalResourceKinds,
  type PersonalResourceKind,
} from "@opensteer/protocol/resources";
import { TranscriptItemSchema, type TranscriptItem } from "@opensteer/protocol/transcript";
import { type HostBootstrap } from "@opensteer/protocol";
import type { TranscriptFixtureSnapshot, ThreadSummary, TranscriptEntry } from "../host/client.js";
import type { z } from "zod";

type MockTranscriptSnapshot = TranscriptFixtureSnapshot;
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
    thread,
    status: thread.status,
    purpose: thread.purpose,
    askedAt: thread.askedAt,
    doneAt: thread.doneAt,
    pendingRequestCount: thread.pendingRequests,
    lastReplyPreview: lastReplyPreview?.slice(0, 500) ?? null,
    failurePreview: failurePreview?.slice(0, 500) ?? null,
    latestRunCompletedAt: thread.latestRunCompletedAt,
  };
}

export function mockScopedShell(
  snapshot: MockTranscriptSnapshot,
  toThread: (summary: ThreadSummary) => Thread,
  selected?: string,
  revision = String(snapshot.revision),
) {
  const recent = (snapshot.tasks?.entries ?? []).slice(0, 25);
  const active = snapshot.activeTasks.slice(0, 10);
  const threads = new Map([...recent, ...active].map((entry) => [entry.thread.id, entry]));
  const pinned = snapshot.threads.find(({ id }) => id === selected);
  if (pinned && !threads.has(pinned.id))
    threads.set(pinned.id, { thread: pinned, lastReply: null, failure: null });
  const tasks = [...threads.values()].map(({ thread, lastReply, failure }) =>
    mockScopedTask(toThread(thread), revision, lastReply, failure),
  );

  return PersonalShellSnapshotSchema.parse({
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
    recentTaskIds: recent.map(({ thread }) => thread.id),
    activeTaskIds: active.map(({ thread }) => thread.id),
    nextBefore: snapshot.tasks?.window.nextBefore ?? null,
    visits: Object.entries(snapshot.threadVisits).flatMap(([threadId, lastVisitedAt]) =>
      threads.has(threadId) ? [{ threadId, lastVisitedAt, revision }] : [],
    ),
    counts: {
      pendingRequestCount: snapshot.waitingRequests.length,
      needsYouCount: snapshot.needsYou?.count ?? 0,
      unreadTaskCount: tasks.filter(({ thread }) => threads.get(thread.id)?.thread.unread).length,
    },
    attention: (snapshot.needsYou?.entries ?? []).slice(0, 20).map((entry) =>
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
    ),
    resourceRevisions: PersonalResourceRevisionsSchema.parse(
      Object.fromEntries(personalResourceKinds.map((kind) => [kind, revision])),
    ),
  });
}

export function mockScopedItems(
  snapshot: MockTranscriptSnapshot,
  threadId: string,
  nodeId?: string,
  revision = String(snapshot.revision),
) {
  return (snapshot.transcripts[threadId] ?? []).flatMap((entry, index) => {
    const item = mockScopedItem(entry, String(index + 1), revision);
    return item && item.nodeId === (nodeId ?? null) ? [item] : [];
  });
}

function mockScopedItem(
  entry: TranscriptEntry,
  position: string,
  revision: string,
): TranscriptItem | undefined {
  const value = {
    id: entry.id,
    position,
    revision,
    nodeId: null,
    attemptId: null,
    runId: "runId" in entry && entry.runId ? RunIdSchema.parse(entry.runId) : null,
    createdAt: entry.createdAt,
    isTurnStart: entry.kind === "message" && entry.messageKind === "input",
  };
  switch (entry.kind) {
    case "message":
      return TranscriptItemSchema.parse({
        ...value,
        kind: entry.kind,
        messageId: MessageIdSchema.parse(entry.id),
        messageKind: entry.messageKind,
        author: entry.author,
        view: {
          preview: entry.body.slice(0, 400),
          truncated:
            entry.body.length > 400 || !!entry.attachments?.length || !!entry.pages?.length,
          published: entry.published ?? true,
        },
      });
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
      });
    case "node":
      return TranscriptItemSchema.parse({
        ...value,
        kind: entry.kind,
        executionNodeId: ExecutionNodeIdSchema.parse(entry.nodeId),
        view: {
          title: entry.title.slice(0, 192),
          status: entry.status,
          preview: entry.result?.slice(0, 400),
        },
      });
    case "assignment":
    case "delegation":
      return TranscriptItemSchema.parse({
        ...value,
        kind: entry.kind,
        delegationId: DelegationIdSchema.parse(
          entry.kind === "delegation" ? entry.delegationId : entry.assignment.id,
        ),
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

export function mockScopedCursor(
  snapshot: MockTranscriptSnapshot,
  threadId: string,
  nodeId: string | undefined,
  revision: string,
  oldest: TranscriptItem | undefined,
) {
  return oldest
    ? {
        deploymentId: DeploymentIdSchema.parse(snapshot.deploymentId),
        viewerId: snapshot.user!.id,
        epoch: mockPersonalEpoch,
        threadId: ThreadIdSchema.parse(threadId),
        nodeId: nodeId ? ExecutionNodeIdSchema.parse(nodeId) : null,
        orderRevision: revision,
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
) {
  const thread = snapshot.threads.find(({ id }) => id === threadId);
  if (!thread) return;
  const all = mockScopedItems(snapshot, threadId, nodeId, revision);
  const anchorIndex = anchor ? all.findIndex(({ id }) => id === anchor) : -1;
  const end = anchorIndex < 0 ? all.length : Math.min(all.length, anchorIndex + 25);
  const start = Math.max(0, end - 50);
  const items = all.slice(start, end);
  return PersonalDetailSnapshotSchema.parse({
    thread: mockScopedTask(toThread(thread), revision, null, null),
    ...(anchor ? { anchorItemId: anchorIndex === -1 ? null : anchor } : {}),
    orderRevision: revision,
    inputQueueRevision: revision,
    items,
    activeItems: [],
    pendingRequests: (snapshot.requests[threadId] ?? [])
      .filter(({ status }) => status === "pending")
      .slice(0, 20)
      .map(({ id, kind, status }) => ({ id, kind, status, title: kind, revision, threadId })),
    nextBefore: start ? mockScopedCursor(snapshot, threadId, nodeId, revision, items[0]) : null,
    queue: {
      revision,
      paused: thread.inputQueuePaused,
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

export function mockScopedResource(
  bootstrap: HostBootstrap,
  kind: PersonalResourceKind,
): z.input<typeof PersonalResourceDataSchema> {
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
    case "harness-auth":
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
    case "browser-availability":
      return { kind, available: bootstrap.browser.available };
    case "agent-home-settings":
      return { kind, settings: bootstrap.personalSettings };
  }
}

export function boundedMockPage(items: TranscriptItem[]) {
  let size = 0;
  return items
    .slice()
    .reverse()
    .filter((item) => {
      size += utf8ByteLength(JSON.stringify(item));
      return size <= 64 * 1024;
    })
    .reverse();
}
