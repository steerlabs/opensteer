import { moveQueueItem, type ThreadInputQueue } from "@opensteer/core";
import type { HostApiCommandInput } from "@opensteer/protocol";
import type {
  BrowserProfileGrantSummary,
  BrowserProfileSummary,
  BrowserSessionSummary,
  HarnessSummary,
  HostSnapshot,
  MessageEntry,
  RunQueueEntry,
  ThreadSummary,
  TaskEntry,
  TaskListState,
  WorkspaceSummary,
} from "./client.js";
import { isTerminalRunEntryStatus, upsertEntry } from "./transcript.js";

import type { ThreadName } from "./thread-state.js";

type CommandType = HostApiCommandInput["type"];
type ThreadInputQueueItem = ThreadInputQueue["items"][number];

type OptimisticCommandPatch =
  | {
      readonly harness: HarnessSummary;
      readonly type: Extract<
        CommandType,
        "harness.rename" | "harness.enabled.set" | "harness.default.set"
      >;
    }
  | { readonly harnessInstanceId: string; readonly type: Extract<CommandType, "harness.delete"> }
  | {
      readonly session: BrowserSessionSummary;
      readonly type: Extract<CommandType, "browser.session.start">;
      readonly workspaceId: string;
    }
  | {
      readonly profile: BrowserProfileSummary;
      readonly type: Extract<
        CommandType,
        "browser.profile.create" | "browser.session.profile.save"
      >;
    }
  | {
      readonly grant: BrowserProfileGrantSummary;
      readonly type: Extract<CommandType, "browser.profile.grant">;
    }
  | { readonly grantId: string; readonly type: Extract<CommandType, "browser.profileGrant.revoke"> }
  | { readonly sessionId: string; readonly type: Extract<CommandType, "browser.session.close"> }
  | {
      readonly type: Extract<CommandType, "workspace.create">;
      readonly workspace: WorkspaceSummary;
    }
  | {
      readonly type: Extract<CommandType, "workspace.storage.retry">;
      readonly workspace: WorkspaceSummary;
    }
  | {
      readonly type: Extract<CommandType, "workspace.icon.set">;
      readonly workspace: WorkspaceSummary;
    }
  | {
      readonly type: Extract<CommandType, "workspace.color.set">;
      readonly workspace: WorkspaceSummary;
    }
  | {
      readonly type: Extract<CommandType, "workspace.delete">;
      readonly workspace: WorkspaceSummary;
    }
  | {
      readonly type: Extract<CommandType, "workspace.deletion.recover">;
      readonly workspace: WorkspaceSummary;
    }
  | { readonly thread: ThreadSummary; readonly type: Extract<CommandType, "thread.create"> }
  | {
      readonly acceptedRunCreatedAt: string | null;
      readonly message: MessageEntry | null;
      /** The send as a queue item when the Host held it rather than ran it. */
      readonly queueItem: ThreadInputQueueItem | null;
      readonly run: RunQueueEntry | null;
      readonly threadId: string;
      readonly type: Extract<CommandType, "thread.sendMessage">;
    }
  | {
      readonly messageId: string;
      readonly threadId: string;
      readonly type: Extract<CommandType, "thread.input.steer">;
    }
  | {
      readonly messageId: string;
      readonly threadId: string;
      readonly type: Extract<CommandType, "thread.input.cancel">;
      /** When the Host recorded the withdrawal; the marker stands at that moment. */
      readonly withdrawnAt: string;
    }
  | {
      readonly beforeMessageId: string | null;
      readonly messageId: string;
      readonly threadId: string;
      readonly type: Extract<CommandType, "thread.input.move">;
    }
  | {
      readonly thread: ThreadSummary;
      readonly type: Extract<
        CommandType,
        | "thread.execution.update"
        | "thread.access.update"
        | "thread.inputQueue.resume"
        | "thread.shared-done.set"
        | "thread.rename"
        | "thread.icon.set"
      >;
    }
  | {
      readonly runId: string;
      readonly threadId: string;
      readonly type: Extract<CommandType, "run.interrupt">;
    }
  | { readonly requestId: string; readonly type: Extract<CommandType, "request.respond"> };

type PatchMap = {
  readonly [Type in OptimisticCommandPatch["type"]]: (
    snapshot: HostSnapshot,
    patch: Extract<OptimisticCommandPatch, { readonly type: Type }>,
  ) => HostSnapshot;
};

export const optimisticCommandPatches = {
  "browser.profile.create": upsertBrowserProfile,
  "browser.profile.grant": (snapshot, { grant }) => ({
    ...snapshot,
    browserProfileGrants: [
      grant,
      ...snapshot.browserProfileGrants.filter((existing) => existing.id !== grant.id),
    ],
  }),
  "browser.profileGrant.revoke": (snapshot, { grantId }) => ({
    ...snapshot,
    browserProfileGrants: snapshot.browserProfileGrants.filter((grant) => grant.id !== grantId),
  }),
  "browser.session.close": (snapshot, { sessionId }) => ({
    ...snapshot,
    browserSessions: snapshot.browserSessions.map((session) =>
      session.id === sessionId ? { ...session, state: "closed" } : session,
    ),
  }),
  "browser.session.profile.save": upsertBrowserProfile,
  "browser.session.start": (snapshot, { session }) => ({
    ...snapshot,
    browserSessions: [
      session,
      ...snapshot.browserSessions.filter((candidate) => candidate.id !== session.id),
    ],
  }),
  "harness.delete": deleteHarness,
  "harness.default.set": setDefaultHarness,
  "harness.enabled.set": replaceHarnessAndNormalizeDefaults,
  "harness.rename": replaceHarness,
  "request.respond": resolveRequest,
  "run.interrupt": (snapshot, { runId, threadId }) => ({
    ...snapshot,
    transcripts: {
      ...snapshot.transcripts,
      [threadId]: (snapshot.transcripts[threadId] ?? []).map((entry) =>
        entry.kind === "run" && entry.runId === runId && !isTerminalRunEntryStatus(entry.status)
          ? { ...entry, stopping: true }
          : entry,
      ),
    },
  }),
  "thread.shared-done.set": (snapshot: HostSnapshot, patch: Parameters<typeof replaceThread>[1]) =>
    snapshot.sharedTaskDoneAvailable ? replaceThread(snapshot, patch) : snapshot,
  "thread.rename": replaceThread,
  "thread.icon.set": replaceThread,
  "thread.access.update": replaceThread,
  "thread.create": (snapshot, { thread }) => {
    if (snapshot.threads.some((candidate) => candidate.id === thread.id)) {
      return replaceThread(snapshot, { thread });
    }
    return {
      ...snapshot,
      threads: [thread, ...snapshot.threads],
      transcripts: { ...snapshot.transcripts, [thread.id]: snapshot.transcripts[thread.id] ?? [] },
    };
  },
  "thread.execution.update": replaceThread,
  "thread.input.cancel": withdrawQueuedInput,
  "thread.input.move": moveQueuedInput,
  "thread.input.steer": dropQueuedInput,
  "thread.inputQueue.resume": replaceThread,
  "thread.sendMessage": patchSentMessage,
  "workspace.create": (snapshot, { workspace }) => ({
    ...snapshot,
    workspaces: [
      workspace,
      ...snapshot.workspaces.filter((candidate) => candidate.id !== workspace.id),
    ],
    workspaceWindow: {
      ...snapshot.workspaceWindow,
      itemCount: snapshot.workspaceWindow.itemCount + 1,
      totalItems: snapshot.workspaceWindow.totalItems + 1,
    },
  }),
  "workspace.storage.retry": (snapshot, { workspace }) => ({
    ...snapshot,
    workspaces: snapshot.workspaces.map((candidate) =>
      candidate.id === workspace.id ? workspace : candidate,
    ),
  }),
  "workspace.color.set": (snapshot, { workspace }) => ({
    ...snapshot,
    workspaces: snapshot.workspaces.map((candidate) =>
      candidate.id === workspace.id ? workspace : candidate,
    ),
  }),
  "workspace.icon.set": (snapshot, { workspace }) => ({
    ...snapshot,
    workspaces: snapshot.workspaces.map((candidate) =>
      candidate.id === workspace.id ? workspace : candidate,
    ),
  }),
  "workspace.delete": (snapshot, { workspace }) => ({
    ...snapshot,
    workspaces: snapshot.workspaces.map((candidate) =>
      candidate.id === workspace.id ? workspace : candidate,
    ),
  }),
  "workspace.deletion.recover": (snapshot, { workspace }) => ({
    ...snapshot,
    workspaces: snapshot.workspaces.map((candidate) =>
      candidate.id === workspace.id ? workspace : candidate,
    ),
  }),
} satisfies PatchMap;

export function applyOptimisticCommandPatch(
  snapshot: HostSnapshot,
  patch: OptimisticCommandPatch,
): HostSnapshot {
  switch (patch.type) {
    case "browser.profile.create":
      return optimisticCommandPatches[patch.type](snapshot, patch);
    case "browser.profile.grant":
      return optimisticCommandPatches[patch.type](snapshot, patch);
    case "browser.profileGrant.revoke":
      return optimisticCommandPatches[patch.type](snapshot, patch);
    case "browser.session.close":
      return optimisticCommandPatches[patch.type](snapshot, patch);
    case "browser.session.profile.save":
      return optimisticCommandPatches[patch.type](snapshot, patch);
    case "browser.session.start":
      return optimisticCommandPatches[patch.type](snapshot, patch);
    case "harness.delete":
      return optimisticCommandPatches[patch.type](snapshot, patch);
    case "harness.default.set":
      return optimisticCommandPatches[patch.type](snapshot, patch);
    case "harness.enabled.set":
      return optimisticCommandPatches[patch.type](snapshot, patch);
    case "harness.rename":
      return optimisticCommandPatches[patch.type](snapshot, patch);
    case "request.respond":
      return optimisticCommandPatches[patch.type](snapshot, patch);
    case "run.interrupt":
      return optimisticCommandPatches[patch.type](snapshot, patch);
    case "thread.icon.set":
    case "thread.shared-done.set":
    case "thread.rename":
      return optimisticCommandPatches[patch.type](snapshot, patch);
    case "thread.access.update":
      return optimisticCommandPatches[patch.type](snapshot, patch);
    case "thread.create":
      return optimisticCommandPatches[patch.type](snapshot, patch);
    case "thread.execution.update":
      return optimisticCommandPatches[patch.type](snapshot, patch);
    case "thread.input.cancel":
      return optimisticCommandPatches[patch.type](snapshot, patch);
    case "thread.input.move":
      return optimisticCommandPatches[patch.type](snapshot, patch);
    case "thread.input.steer":
      return optimisticCommandPatches[patch.type](snapshot, patch);
    case "thread.inputQueue.resume":
      return optimisticCommandPatches[patch.type](snapshot, patch);
    case "thread.sendMessage":
      return optimisticCommandPatches[patch.type](snapshot, patch);
    case "workspace.create":
      return optimisticCommandPatches[patch.type](snapshot, patch);
    case "workspace.storage.retry":
      return optimisticCommandPatches[patch.type](snapshot, patch);
    case "workspace.color.set":
      return optimisticCommandPatches[patch.type](snapshot, patch);
    case "workspace.icon.set":
      return optimisticCommandPatches[patch.type](snapshot, patch);
    case "workspace.delete":
      return optimisticCommandPatches[patch.type](snapshot, patch);
    case "workspace.deletion.recover":
      return optimisticCommandPatches[patch.type](snapshot, patch);
  }
}

function replaceHarness(
  snapshot: HostSnapshot,
  { harness }: { readonly harness: HarnessSummary },
): HostSnapshot {
  return {
    ...snapshot,
    harnesses: snapshot.harnesses.map((candidate) =>
      candidate.id === harness.id ? harness : candidate,
    ),
  };
}

function replaceHarnessAndNormalizeDefaults(
  snapshot: HostSnapshot,
  { harness }: { readonly harness: HarnessSummary },
): HostSnapshot {
  return {
    ...snapshot,
    harnesses: normalizeHarnessDefaults(
      snapshot.harnesses.map((candidate) => (candidate.id === harness.id ? harness : candidate)),
      harness.environmentId,
      harness.driverKind,
      harness.enabled && harness.isDefault ? harness.id : undefined,
    ),
  };
}

function deleteHarness(
  snapshot: HostSnapshot,
  { harnessInstanceId }: { readonly harnessInstanceId: string },
): HostSnapshot {
  const removed = snapshot.harnesses.find(({ id }) => id === harnessInstanceId);
  const remaining = snapshot.harnesses.filter(({ id }) => id !== harnessInstanceId);
  return {
    ...snapshot,
    harnesses: removed
      ? normalizeHarnessDefaults(remaining, removed.environmentId, removed.driverKind)
      : remaining,
  };
}

/** Keeps the same one-enabled-default invariant as the Host during an optimistic patch. */
function normalizeHarnessDefaults(
  harnesses: readonly HarnessSummary[],
  environmentId: string,
  driverKind: string,
  preferredId?: string,
): HarnessSummary[] {
  const group = harnesses.filter(
    (candidate) => candidate.environmentId === environmentId && candidate.driverKind === driverKind,
  );
  const chosen =
    group.find((candidate) => candidate.enabled && candidate.id === preferredId) ??
    group.find((candidate) => candidate.enabled && candidate.isDefault) ??
    group.find((candidate) => candidate.enabled);
  return harnesses.map((candidate) => {
    if (candidate.environmentId !== environmentId || candidate.driverKind !== driverKind) {
      return candidate;
    }
    const isDefault = candidate.id === chosen?.id;
    return candidate.isDefault === isDefault ? candidate : { ...candidate, isDefault };
  });
}

/**
 * The default moves within one `(work location, engine)` pair, so the profile
 * that held it has to lose it in the same patch. Leaving that to the next
 * refresh would show two defaults for the same engine in between.
 */
function setDefaultHarness(
  snapshot: HostSnapshot,
  { harness }: { readonly harness: HarnessSummary },
): HostSnapshot {
  return {
    ...snapshot,
    harnesses: snapshot.harnesses.map((candidate) => {
      if (candidate.id === harness.id) return harness;
      if (
        candidate.environmentId !== harness.environmentId ||
        candidate.driverKind !== harness.driverKind
      ) {
        return candidate;
      }
      return candidate.isDefault ? { ...candidate, isDefault: false } : candidate;
    }),
  };
}

/**
 * Drops the answered Request and decrements its Thread's pending count in the
 * same step, exactly as the `request.resolved` event reducer does. The two have
 * to move together: the client compares the Requests it holds against
 * `pendingRequests` to decide whether a Thread still owes it a page, and a
 * count left one too high orders a refetch of the page it just patched.
 */
function resolveRequest(
  snapshot: HostSnapshot,
  { requestId }: { readonly requestId: string },
): HostSnapshot {
  // A question answered from another conversation may be one this client
  // only holds as waiting on its reader, never in its Thread's own list.
  const waitingRequests = snapshot.waitingRequests.filter(
    ({ request }) => request.id !== requestId,
  );
  const request = Object.values(snapshot.requests)
    .flat()
    .find((candidate) => candidate.id === requestId);
  if (!request) return { ...snapshot, waitingRequests };
  const threadId = request.originatingThreadId;
  return {
    ...snapshot,
    waitingRequests,
    requests: {
      ...snapshot.requests,
      [threadId]: (snapshot.requests[threadId] ?? []).filter(
        (candidate) => candidate.id !== requestId,
      ),
    },
  };
}

function upsertBrowserProfile(
  snapshot: HostSnapshot,
  { profile }: { readonly profile: BrowserProfileSummary },
): HostSnapshot {
  return {
    ...snapshot,
    browserProfiles: [
      profile,
      ...snapshot.browserProfiles.filter((existing) => existing.id !== profile.id),
    ],
  };
}

/** Names, symbols and shared Done follow every held copy without replacing activity or reply previews. */
export function withThreadNames(
  snapshot: HostSnapshot,
  nameOf: (thread: ThreadSummary) => ThreadName,
): HostSnapshot {
  const threadName = <T extends ThreadSummary>(thread: T): T => {
    const name = nameOf(thread);
    return name.title === thread.title &&
      name.icon === thread.icon &&
      (name.doneAt === undefined || name.doneAt === thread.doneAt)
      ? thread
      : { ...thread, ...name };
  };
  const entries = (held: readonly TaskEntry[]): readonly TaskEntry[] => {
    const updated = held.map((entry) => {
      const thread = threadName(entry.thread);
      return thread === entry.thread ? entry : { ...entry, thread };
    });
    return updated.every((entry, index) => entry === held[index]) ? held : updated;
  };
  const taskList = (held: TaskListState): TaskListState => {
    const updated = entries(held.entries);
    return updated === held.entries ? held : { ...held, entries: updated };
  };
  const threads = snapshot.threads.map(threadName);
  const workspaceTasks = Object.fromEntries(
    Object.entries(snapshot.workspaceTasks).map(([id, held]) => [id, taskList(held)]),
  );
  const tasks = snapshot.tasks ? taskList(snapshot.tasks) : null;
  const activeTasks = entries(snapshot.activeTasks);
  const assignments = Object.fromEntries(
    Object.entries(snapshot.assignments).map(([id, assignment]) => {
      const held = threads.find(({ id }) => id === assignment.workerThread.id);
      const workerThread =
        held &&
        (held.title !== assignment.workerThread.title || held.icon !== assignment.workerThread.icon)
          ? { ...assignment.workerThread, title: held.title, icon: held.icon }
          : assignment.workerThread;
      return [
        id,
        workerThread === assignment.workerThread ? assignment : { ...assignment, workerThread },
      ];
    }),
  );
  return {
    ...snapshot,
    threads: threads.every((thread, index) => thread === snapshot.threads[index])
      ? snapshot.threads
      : threads,
    assignments: Object.entries(assignments).every(
      ([id, assignment]) => assignment === snapshot.assignments[id],
    )
      ? snapshot.assignments
      : assignments,
    tasks,
    activeTasks,
    workspaceTasks: Object.entries(workspaceTasks).every(
      ([id, held]) => held === snapshot.workspaceTasks[id],
    )
      ? snapshot.workspaceTasks
      : workspaceTasks,
  };
}

function replaceThread(
  snapshot: HostSnapshot,
  { thread }: { readonly thread: ThreadSummary },
): HostSnapshot {
  return {
    ...snapshot,
    threads: snapshot.threads.map((candidate) =>
      candidate.id === thread.id
        ? {
            ...thread,
            updatedAt:
              thread.updatedAt > candidate.updatedAt ? thread.updatedAt : candidate.updatedAt,
          }
        : candidate,
    ),
  };
}

function patchSentMessage(
  snapshot: HostSnapshot,
  patch: Extract<OptimisticCommandPatch, { readonly type: "thread.sendMessage" }>,
): HostSnapshot {
  const transcript = snapshot.transcripts[patch.threadId] ?? [];
  // Realtime may already have placed, delivered or withdrawn this input. The
  // admission-time reply fills a gap; it cannot replace that later lifecycle.
  const nextTranscript =
    patch.message && !transcript.some((entry) => entry.id === patch.message?.id)
      ? [...transcript, patch.message]
      : transcript;
  const existingRun = patch.run
    ? nextTranscript.find((entry) => entry.id === `run:${patch.run?.id}`)
    : undefined;
  const terminalRunProjected =
    existingRun?.kind === "run" && isTerminalRunEntryStatus(existingRun.status);
  const runAlreadyProjected = patch.run
    ? snapshot.runQueue.some((entry) => entry.id === patch.run?.id)
    : false;
  const runQueue =
    patch.run && !terminalRunProjected && !runAlreadyProjected
      ? upsertRunQueueEntry(snapshot.runQueue, patch.run)
      : snapshot.runQueue;
  const currentThread = snapshot.threads.find((thread) => thread.id === patch.threadId);
  const shouldPatchThread =
    currentThread && patch.run && !terminalRunProjected && !runAlreadyProjected;
  return {
    ...snapshot,
    inputQueues: appendQueuedInput(snapshot.inputQueues, patch.threadId, patch.queueItem),
    runQueue,
    threads: shouldPatchThread
      ? snapshot.threads.map((thread) =>
          thread.id === patch.threadId
            ? {
                ...thread,
                updatedAt:
                  patch.acceptedRunCreatedAt &&
                  thread.updatedAt.localeCompare(patch.acceptedRunCreatedAt) < 0
                    ? patch.acceptedRunCreatedAt
                    : thread.updatedAt,
              }
            : thread,
        )
      : snapshot.threads,
    transcripts: { ...snapshot.transcripts, [patch.threadId]: nextTranscript },
  };
}

/**
 * Only a queue this client has read can take the item: a queue never read
 * has no truth to patch, and its first read will include the message anyway.
 */
function appendQueuedInput(
  inputQueues: HostSnapshot["inputQueues"],
  threadId: string,
  item: ThreadInputQueueItem | null,
): HostSnapshot["inputQueues"] {
  const queue = inputQueues[threadId];
  if (!item || !queue) return inputQueues;
  if (queue.items.some((existing) => existing.message.id === item.message.id)) return inputQueues;
  return { ...inputQueues, [threadId]: { ...queue, items: [...queue.items, item] } };
}

function dropQueuedInput(
  snapshot: HostSnapshot,
  { messageId, threadId }: { readonly messageId: string; readonly threadId: string },
): HostSnapshot {
  const queue = snapshot.inputQueues[threadId];
  if (!queue?.items.some((item) => item.message.id === messageId)) return snapshot;
  return {
    ...snapshot,
    inputQueues: {
      ...snapshot.inputQueues,
      [threadId]: { ...queue, items: queue.items.filter((item) => item.message.id !== messageId) },
    },
  };
}

/**
 * The queue takes the new order as soon as the person drops a message, so the
 * tray never snaps back while the Host confirms it. A neighbour the queue no
 * longer holds leaves it as it was; the Host's refusal and reread settle it.
 */
function moveQueuedInput(
  snapshot: HostSnapshot,
  patch: {
    readonly beforeMessageId: string | null;
    readonly messageId: string;
    readonly threadId: string;
  },
): HostSnapshot {
  const queue = snapshot.inputQueues[patch.threadId];
  const moving = queue?.items.find((item) => item.message.id === patch.messageId);
  const before =
    patch.beforeMessageId === null
      ? null
      : queue?.items.find((item) => item.message.id === patch.beforeMessageId);
  if (!queue || !moving || before === undefined) return snapshot;
  return {
    ...snapshot,
    inputQueues: {
      ...snapshot.inputQueues,
      [patch.threadId]: { ...queue, items: moveQueueItem(queue.items, moving, before) },
    },
  };
}

/**
 * A withdrawn message was never sent, so it leaves the queue and the
 * conversation together: what stays under its id is the same marker the
 * withdrawal event will fold, so the Host's word changes nothing on arrival.
 */
function withdrawQueuedInput(
  snapshot: HostSnapshot,
  patch: { readonly messageId: string; readonly threadId: string; readonly withdrawnAt: string },
): HostSnapshot {
  const dropped = dropQueuedInput(snapshot, patch);
  const transcript = dropped.transcripts[patch.threadId];
  if (!transcript?.some((entry) => entry.id === patch.messageId)) return dropped;
  return {
    ...dropped,
    transcripts: {
      ...dropped.transcripts,
      [patch.threadId]: upsertEntry(transcript, {
        createdAt: patch.withdrawnAt,
        id: patch.messageId,
        kind: "withdrawn",
      }),
    },
  };
}

export function upsertRunQueueEntry(
  runQueue: readonly RunQueueEntry[],
  entry: RunQueueEntry,
): RunQueueEntry[] {
  return [...runQueue.filter((run) => run.id !== entry.id), entry].sort(
    (left, right) =>
      left.threadId.localeCompare(right.threadId) || left.runOrdinal - right.runOrdinal,
  );
}
