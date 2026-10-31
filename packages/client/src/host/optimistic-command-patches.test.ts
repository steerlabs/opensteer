import {
  SequenceSchema,
  createId,
  emptyExecutionPreferences,
  type ThreadInputQueue,
} from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import type { BrowserSessionSummary, HostSnapshot, MessageEntry, ThreadSummary } from "./client.js";
import { applyOptimisticCommandPatch, withThreadNames } from "./optimistic-command-patches.js";

const now = "2026-08-09T20:00:00.000Z";
const threadId = createId("thread");
const runId = createId("run");

describe("independent browser creation", () => {
  it("keeps another session in the same workspace when a new browser starts", () => {
    const original: BrowserSessionSummary = {
      access: "full-control",
      attachedRunIds: [],
      dialog: null,
      error: null,
      id: "original",
      origin: "workspace",
      placement: { kind: "runner", runnerId: "runner" },
      profileId: null,
      runtimeId: "runtime",
      state: "ready",
      tabs: [],
      viewerError: null,
      viewerState: "synchronized",
      workspaceId: "shared",
    };
    const opened: BrowserSessionSummary = { ...original, id: "opened" };
    const snapshot = { ...baseSnapshot(), browserSessions: [original] };
    const result = applyOptimisticCommandPatch(snapshot, {
      type: "browser.session.start",
      session: opened,
      workspaceId: "shared",
    });
    expect(result.browserSessions.map((session) => session.id)).toEqual(["opened", "original"]);
    expect(result.browserSessions[1]).toBe(original);
  });
});

describe("browser profile patches", () => {
  it("renames a profile in place and forgets a deleted one with its grants", () => {
    const work = { id: "bpr_work", name: "Work", revision: 3 };
    const shopping = { id: "bpr_shopping", name: "Shopping", revision: 1 };
    const grant = (id: string, profileId: string) => ({
      access: "full-control" as const,
      createdAt: now,
      id,
      profileId,
      workspaceId: "specialist",
    });
    const snapshot = {
      ...baseSnapshot(),
      browserProfiles: [work, shopping],
      browserProfileGrants: [grant("work-grant", work.id), grant("shopping-grant", shopping.id)],
    };

    const renamed = applyOptimisticCommandPatch(snapshot, {
      profile: { ...work, name: "Office" },
      type: "browser.profile.rename",
    });
    expect(renamed.browserProfiles.map((profile) => profile.name)).toEqual(["Office", "Shopping"]);

    const deleted = applyOptimisticCommandPatch(renamed, {
      profileId: shopping.id,
      type: "browser.profile.delete",
    });
    expect(deleted.browserProfiles.map((profile) => profile.id)).toEqual([work.id]);
    expect(deleted.browserProfileGrants.map((entry) => entry.id)).toEqual(["work-grant"]);
  });
});

describe("task mark patches", () => {
  it("keeps names in every task copy and completed assignment worker without changing page state", () => {
    const mock = new MockHostClient({ latencyMs: 0 });
    try {
      const base = mock.getSnapshot();
      const thread: ThreadSummary = { ...base.threads[1]!, icon: "hotel", color: "blue" };
      const entry = { thread, failure: null, lastReply: "Found it" };
      const page = { entries: [entry], window: base.workspaceWindow };
      const assignment = {
        workerThread: { id: thread.id, title: thread.title, icon: "hotel", color: "blue" },
        status: "completed",
      } as unknown as HostSnapshot["assignments"][string];
      const snapshot = {
        ...base,
        threads: [thread],
        tasks: page,
        activeTasks: [entry],
        workspaceTasks: { [thread.workspaceId]: page },
        assignments: { completed: assignment },
      };
      const result = withThreadNames(snapshot, (name) =>
        name.id === thread.id ? { title: name.title, icon: "plane" } : name,
      );
      expect(result.threads[0]?.icon).toBe("plane");
      expect(result.tasks?.entries[0]?.thread).toMatchObject({
        icon: "plane",
        color: "blue",
        status: thread.status,
        updatedAt: thread.updatedAt,
      });
      expect(result.activeTasks[0]?.thread.icon).toBe("plane");
      expect(result.workspaceTasks[thread.workspaceId]?.entries[0]?.thread.icon).toBe("plane");
      expect(result.assignments.completed?.workerThread.icon).toBe("plane");
      expect(result.tasks?.window).toBe(page.window);
    } finally {
      mock.dispose();
    }
  });
});

describe("thread input queue patches", () => {
  it("appends an acknowledged queued send to a loaded queue once", () => {
    const item = queuedItem("Then rename the branch");
    const snapshot = withQueue(baseSnapshot(), { items: [], steerRunId: runId });

    const appended = applyOptimisticCommandPatch(snapshot, sendPatch(item));
    expect(appended.inputQueues[threadId]?.items).toEqual([item]);
    expect(appended.transcripts[threadId]).toEqual([messageEntry(item)]);

    const again = applyOptimisticCommandPatch(appended, sendPatch(item));
    expect(again.inputQueues[threadId]?.items).toEqual([item]);
  });

  it("leaves an unread queue alone and patches nothing for a send a Run took", () => {
    const item = queuedItem("Then rename the branch");
    const unread = baseSnapshot();
    expect(applyOptimisticCommandPatch(unread, sendPatch(item)).inputQueues).toBe(
      unread.inputQueues,
    );

    const loaded = withQueue(baseSnapshot(), { items: [], steerRunId: null });
    expect(applyOptimisticCommandPatch(loaded, sendPatch(null)).inputQueues).toBe(
      loaded.inputQueues,
    );
  });

  it("drops a steered message from the queue and keeps it in the conversation", () => {
    const item = queuedItem("Steer this in");
    const snapshot = applyOptimisticCommandPatch(
      withQueue(baseSnapshot(), { items: [], steerRunId: runId }),
      sendPatch(item),
    );

    const steered = applyOptimisticCommandPatch(snapshot, {
      messageId: item.message.id,
      threadId,
      type: "thread.input.steer",
    });
    expect(steered.inputQueues[threadId]?.items).toEqual([]);
    expect(steered.transcripts[threadId]).toEqual([messageEntry(item)]);
  });

  it("drops a withdrawn message from the queue and leaves its marker in the conversation", () => {
    const item = queuedItem("Never mind");
    const other = queuedItem("Keep this one");
    const snapshot = [item, other].reduce(
      (current, queued) => applyOptimisticCommandPatch(current, sendPatch(queued)),
      withQueue(baseSnapshot(), { items: [], steerRunId: runId }),
    );

    const withdrawn = applyOptimisticCommandPatch(snapshot, {
      messageId: item.message.id,
      threadId,
      type: "thread.input.cancel",
      withdrawnAt: now,
    });
    expect(withdrawn.inputQueues[threadId]?.items).toEqual([other]);
    expect(withdrawn.transcripts[threadId]).toEqual([
      { createdAt: now, id: item.message.id, kind: "withdrawn" },
      messageEntry(other),
    ]);

    const unknown = applyOptimisticCommandPatch(withdrawn, {
      messageId: createId("message"),
      threadId,
      type: "thread.input.cancel",
      withdrawnAt: now,
    });
    expect(unknown).toBe(withdrawn);
  });
});

function sendPatch(item: ThreadInputQueue["items"][number] | null) {
  return {
    acceptedRunCreatedAt: null,
    message: item ? messageEntry(item) : null,
    queueItem: item,
    run: null,
    threadId,
    type: "thread.sendMessage" as const,
  };
}

function messageEntry(item: ThreadInputQueue["items"][number]): MessageEntry {
  return {
    author: item.message.author,
    body: item.message.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join(""),
    createdAt: item.message.createdAt,
    id: item.message.id,
    kind: "message",
    messageKind: "input",
    runId: null,
  };
}

function queuedItem(text: string): ThreadInputQueue["items"][number] {
  const messageId = createId("message");
  return {
    canCancel: true,
    canMove: true,
    canSteer: true,
    input: {
      assignmentId: null,
      cancelReason: null,
      causalChainId: createId("causalChain"),
      createdAt: now,
      deliveredAt: null,
      messageId,
      policy: "queue",
      replyTarget: null,
      runId: null,
      state: "pending",
      threadId,
      updatedAt: now,
    },
    message: {
      author: { displayName: "Owner", kind: "human", principalId: "user:test-owner" },
      content: [{ text, type: "text" }],
      createdAt: now,
      id: messageId,
      kind: "input",
      runId: null,
      sequence: SequenceSchema.parse("1"),
      threadId,
    },
  };
}

function withQueue(
  snapshot: HostSnapshot,
  queue: Pick<ThreadInputQueue, "items" | "steerRunId">,
): HostSnapshot {
  return {
    ...snapshot,
    inputQueues: { ...snapshot.inputQueues, [threadId]: { ...queue, paused: false, threadId } },
  };
}

function baseSnapshot(): HostSnapshot {
  return {
    threadRenameAvailable: true,
    taskMarksAvailable: true,
    iphoneAppsAvailable: true,
    assignments: {},
    waitingRequests: [],
    browserAvailable: false,
    browserPlacements: [],
    browserProfileGrants: [],
    browserProfiles: [],
    browserSessions: [],
    connection: "connected",
    deploymentShape: null,
    deploymentId: null,
    environments: [],
    executionPreferences: emptyExecutionPreferences,
    harnesses: [],
    homeWorkspaceId: null,
    homeThreadId: null,
    notificationMutes: [],
    threadReadStates: {},
    tasks: null,
    activeTasks: [],
    workspaceTasks: {},
    identityConfig: null,
    inputQueues: {},
    machineRevision: 0,
    machines: [],
    network: "unknown",
    ownerName: null,
    requests: {},
    revision: 0,
    runQueue: [],
    session: "authenticated",
    sessionSurface: null,
    threadLookups: {},
    threads: [],
    transcriptWindows: {},
    transcripts: { [threadId]: [] },
    triggerRevision: 0,
    user: null,
    workspaceSharingAvailable: false,
    workspaceWindow: {
      byteCount: 2,
      hasMore: false,
      itemCount: 0,
      nextBefore: null,
      totalItems: 0,
    },
    workspaces: [],
  };
}
