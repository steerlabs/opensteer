import { assignmentTitle, workerAssignment } from "./assignment-presentation.js";
import {
  CHAT_THREAD_TITLE,
  requestTitleText,
  type WorkspaceIconName,
  type MarkColor,
  type WaitingRequest,
} from "@opensteer/core";
import type { HostSnapshot, TaskEntry, TaskListState, ThreadSummary } from "./client.js";
import { threadStartHold } from "./thread-activity.js";
import { mergeTaskEntries } from "./task-entries.js";
import { conversationSurfaces, type SurfaceItem } from "./surfaces.js";
import { formatRelativeTime } from "./thread-list-model.js";
import { isThreadUnread } from "./thread-read-state.js";

/**
 * The reader's sidebar: Chat, then their tasks grouped by what each asks of
 * the reader — Working, with anything waiting on them first; Ready; and
 * Done, out of the way.
 *
 * A row is one line: its tone is a mark a reader sees without reading, and
 * `line` says the same in words for a screen reader or a tooltip. Web and
 * mobile both read this, so a task can never read differently on two screens.
 */

/** What a task is doing, in the order a reader has to care. */
export type TaskTone = "needs-you" | "working" | "waiting" | "failed" | "finished";

/**
 * A task's mark reads quietly once it is settled and seen, or put in Done;
 * needing someone or having failed stays loud wherever it sits.
 */
export function taskMarkQuiet(row: Pick<TaskRow, "tone" | "unread">, done: boolean): boolean {
  return (
    (done || (row.tone === "finished" && !row.unread)) &&
    row.tone !== "needs-you" &&
    row.tone !== "failed"
  );
}

export interface TaskRow {
  readonly threadId: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly icon: WorkspaceIconName | null;
  readonly color: MarkColor | null;
  readonly tone: TaskTone;
  /** What is happening, in words: what it needs, where it works, why it stopped, what it said. */
  readonly line: string;
  /** Where a working task is acting, as briefly as a person would say it: a site, an app or a phone. */
  readonly place: string | null;
  /** Something arrived this reader has not opened. */
  readonly unread: boolean;
  /**
   * Nothing more happens until someone writes to it or resumes it: finished,
   * failed, or stopped by a person and left paused.
   */
  readonly stopped: boolean;
  readonly done: boolean;
  readonly canBeDone: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkspaceTaskList {
  /**
   * Work under way: tasks waiting on the reader first, then the ones working
   * or waiting on someone else, each newest first. A row moves only when what
   * it is doing changes.
   */
  readonly working: readonly TaskRow[];
  /** Stopped open tasks and unread Done tasks, most recently changed first. */
  readonly ready: readonly TaskRow[];
  /** Shared Done tasks the reader has seen, most recently changed first. */
  readonly done: readonly TaskRow[];
  /** How many tasks are working right now. */
  readonly running: number;
  /** Whether the Host holds more of these tasks than this client has read. */
  readonly hasMore: boolean;
}

export interface TaskList extends WorkspaceTaskList {
  /** The reader's Chat, once the task list has reported it. */
  readonly chat: TaskRow | null;
}

/** Everything a task list is drawn from, and nothing else. */
const taskListSourceKeys = [
  "sharedTaskDoneAvailable",
  "activeTasks",
  "assignments",
  "browserSessions",
  "browserProfiles",
  "connection",
  "homeThreadId",
  "machines",
  "tasks",
  "threadReadStates",
  "waitingRequests",
  "workspaceTasks",
  "threads",
  "environments",
  "runQueue",
  "requests",
] as const satisfies readonly (keyof HostSnapshot)[];

export type TaskListSource = Pick<HostSnapshot, (typeof taskListSourceKeys)[number]>;

/**
 * Whether two snapshots draw the same task list. A surface that shows it
 * subscribes with this, so it redraws for exactly what the list reads and for
 * nothing else a snapshot carries.
 */
export function sameTaskListSource(previous: TaskListSource, next: TaskListSource): boolean {
  return taskListSourceKeys.every((key) => previous[key] === next[key]);
}

/** The reader's tasks across every Workspace, with their Chat apart. */
export function taskList(snapshot: TaskListSource): TaskList {
  return arrange(snapshot, snapshot.tasks, snapshot.activeTasks);
}

/**
 * One Workspace's tasks, as `loadWorkspaceTasks` read them, by the same rules
 * as the reader's whole list. Chat is never one of them.
 */
export function workspaceTaskList(
  snapshot: TaskListSource,
  workspaceId: string,
): WorkspaceTaskList {
  const { chat: _chat, ...list } = arrange(
    snapshot,
    snapshot.workspaceTasks[workspaceId] ?? null,
    snapshot.activeTasks.filter(({ thread }) => thread.workspaceId === workspaceId),
  );
  return list;
}

/**
 * The freshest copy this client holds of one Thread, whichever of an open
 * conversation or a task list loaded it, so Done works on a task no list holds:
 * delegated work, or a Done task past the loaded pages.
 */
export function heldThread(snapshot: TaskListSource, threadId: string): ThreadSummary | null {
  return (
    snapshot.threads.find(({ id }) => id === threadId) ??
    [
      ...snapshot.activeTasks,
      ...(snapshot.tasks?.entries ?? []),
      ...Object.values(snapshot.workspaceTasks).flatMap(({ entries }) => entries),
    ].find(({ thread }) => thread.id === threadId)?.thread ??
    null
  );
}

/**
 * The row a list shows for a Thread: its own when it is listed, otherwise its
 * nearest listed ancestor's, Chat's for work under Chat. A helper has no row,
 * so the task it works for stands in for it. A chain this client cannot
 * follow, through a parent it does not hold or round a loop, leaves the
 * Thread itself, which then matches no row.
 */
export function listedRowThreadId(snapshot: TaskListSource, threadId: string): string {
  const seen = new Set<string>();
  let current = heldThread(snapshot, threadId);
  while (current !== null && !current.listed && current.id !== snapshot.homeThreadId) {
    const parent = current.parentThreadId;
    if (parent === null || seen.has(current.id)) return threadId;
    seen.add(current.id);
    if (parent === snapshot.homeThreadId) return parent;
    current = heldThread(snapshot, parent);
  }
  return current?.id ?? threadId;
}

/** A conversation a reader can go back to, by the name they know it by. */
export interface RequesterLink {
  readonly threadId: string;
  readonly title: string;
}

/**
 * The way back from a Thread: the one it lives under, where the sidebar shows
 * it, even when another conversation (an automation's, say) handed it its
 * current task. Only when this client does not hold the Thread does its task's
 * requester stand in. A link never leads to a Thread the reader cannot open.
 */
export function threadRequester(snapshot: TaskListSource, threadId: string): RequesterLink | null {
  const held = heldThread(snapshot, threadId);
  const parent =
    held === null
      ? (workerAssignment(snapshot.assignments, threadId)?.parentThreadId ?? null)
      : held.parentThreadId;
  return parent === null || parent === threadId ? null : requesterLink(snapshot, parent);
}

/** A Thread as a way back, when this reader can open it: Chat by name, else a Thread it holds. */
export function requesterLink(snapshot: TaskListSource, threadId: string): RequesterLink | null {
  if (threadId === snapshot.homeThreadId) return { threadId, title: CHAT_THREAD_TITLE };
  const held = heldThread(snapshot, threadId);
  return held === null ? null : { threadId, title: held.title };
}

/**
 * Whether a person may mark a Thread Done or reopen it: any work Thread that
 * is no Workspace's Chat. The Host also refuses an active channel
 * conversation, which a client cannot tell apart.
 */
export function taskCanBeDone(
  snapshot: Pick<HostSnapshot, "homeThreadId" | "workspaces" | "sharedTaskDoneAvailable">,
  thread: Pick<ThreadSummary, "id" | "role">,
): boolean {
  return (
    snapshot.sharedTaskDoneAvailable === true &&
    thread.role === "work" &&
    thread.id !== snapshot.homeThreadId &&
    !snapshot.workspaces.some(({ homeThreadId }) => homeThreadId === thread.id)
  );
}

/** Work that marking the task Done would stop, which a person confirms first. */
export function taskUnderWay(thread: Pick<ThreadSummary, "doneAt" | "status">): boolean {
  return thread.doneAt === null && (thread.status === "running" || thread.status === "waiting");
}

function arrange(
  snapshot: TaskListSource,
  tasks: TaskListState | null,
  activeTasks: readonly TaskEntry[],
): TaskList {
  const entries = mergeTaskEntries(tasks?.entries ?? [], activeTasks).filter(
    ({ thread }) => thread.listed || thread.id === snapshot.homeThreadId,
  );
  const asks = attributedRequests(snapshot, entries);
  let chat: TaskRow | null = null;
  const working: TaskRow[] = [];
  const ready: TaskRow[] = [];
  const done: TaskRow[] = [];
  for (const entry of entries) {
    const row = rowOf(snapshot, entry, asks.get(entry.thread.id) ?? []);
    if (entry.thread.id === snapshot.homeThreadId) chat = row;
    else if (row.done) (row.unread ? ready : done).push(row);
    else if (row.stopped) ready.push(row);
    else working.push(row);
  }
  // `sort` mutates the fresh arrays above, which Hermes needs because it
  // lacks the change-by-copy array methods.
  working.sort(attentionThenNewest);
  ready.sort(latestChange);
  done.sort(latestChange);
  return {
    chat,
    working,
    ready,
    done,
    running: working.filter((row) => row.tone === "working").length,
    hasMore: tasks?.window.hasMore ?? false,
  };
}

/** A question for the reader comes before everything else under way; new work arrives on top. */
function attentionThenNewest(left: TaskRow, right: TaskRow): number {
  const asks = Number(right.tone === "needs-you") - Number(left.tone === "needs-you");
  return asks || right.createdAt.localeCompare(left.createdAt);
}

/** The most recently changed first, so the times a list shows read in order. */
function latestChange(left: TaskRow, right: TaskRow): number {
  return right.updatedAt.localeCompare(left.updatedAt);
}

/**
 * Each question, on exactly one row of a list: the first Thread the list
 * holds on the way from where it was asked up the work that handed it out,
 * innermost first. Chat therefore shows only what was asked in Chat or in
 * unlisted work under it, never what its tasks ask on their own rows.
 */
function attributedRequests(
  snapshot: TaskListSource,
  entries: readonly TaskEntry[],
): ReadonlyMap<string, WaitingRequest[]> {
  const listed = new Set(
    entries
      .filter(({ thread }) => thread.listed || thread.id === snapshot.homeThreadId)
      .map(({ thread }) => thread.id),
  );
  const byThread = new Map<string, WaitingRequest[]>();
  for (const waiting of snapshot.waitingRequests) {
    const threadId = [
      waiting.request.originatingThreadId,
      ...waiting.assignments.map(({ parentThreadId }) => parentThreadId),
    ].find((candidate) => listed.has(candidate));
    if (threadId === undefined) continue;
    byThread.set(threadId, [...(byThread.get(threadId) ?? []), waiting]);
  }
  return byThread;
}

function rowOf(
  snapshot: TaskListSource,
  entry: TaskEntry,
  asks: readonly WaitingRequest[],
): TaskRow {
  const { thread } = entry;
  const held = snapshot.threads.find(({ id }) => id === thread.id) ?? thread;
  const tone = taskTone(thread, asks);
  const chat = thread.id === snapshot.homeThreadId;
  const surface = tone === "working" && !chat ? workingSurface(snapshot, thread.id) : null;
  return {
    threadId: thread.id,
    workspaceId: thread.workspaceId,
    title: held.title,
    icon: held.icon,
    color: held.color,
    tone,
    line:
      tone === "waiting"
        ? (taskWaitingReason(snapshot, thread.id)?.label ?? "Waiting")
        : taskLine(entry, tone, asks, chat, surface),
    place: surface === null ? null : placeName(surface),
    done: snapshot.sharedTaskDoneAvailable === true && thread.doneAt !== null,
    // The Host also refuses an active channel conversation, which a client cannot tell apart.
    canBeDone: !chat && snapshot.sharedTaskDoneAvailable === true && thread.role === "work",
    unread: isThreadUnread(snapshot.threadReadStates[thread.id]),
    // A Stop pauses the queue: the task waits for the person alone, as a finished one does.
    stopped:
      tone === "finished" ||
      tone === "failed" ||
      (tone === "waiting" && thread.inputQueuePaused && thread.status !== "waiting"),
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

/**
 * Where a task works, as long as it works there: the page or app it is acting
 * in, else the one it opened, so what a row says does not flicker between steps.
 */
function workingSurface(snapshot: TaskListSource, threadId: string): SurfaceItem | null {
  const surfaces = conversationSurfaces(snapshot, threadId);
  return surfaces.find((item) => item.acting) ?? surfaces[0] ?? null;
}

function placeName(surface: SurfaceItem): string | null {
  switch (surface.kind) {
    case "browser":
      return surface.site?.replace(/^www\./, "") ?? null;
    case "phone":
      return surface.machine.name;
    case "app":
      return surface.app.displayName;
  }
}

function taskTone(thread: ThreadSummary, asks: readonly WaitingRequest[]): TaskTone {
  if (asks.length > 0) return "needs-you";
  if (thread.status === "running") return "working";
  if (thread.status === "waiting" || thread.inputQueuePaused) return "waiting";
  if (thread.status === "failed") return "failed";
  return "finished";
}

function taskLine(
  entry: TaskEntry,
  tone: TaskTone,
  asks: readonly WaitingRequest[],
  chat: boolean,
  surface: SurfaceItem | null,
): string {
  switch (tone) {
    case "needs-you": {
      const [first] = asks;
      const more = new Set(asks.map(({ request }) => request.id)).size - 1;
      const title = first ? requestTitleText(first.request.presentation) : "";
      return more > 0 ? `${title} · ${more} more` : title;
    }
    case "working":
      if (chat) return "Replying";
      if (surface?.kind === "browser")
        return surface.site ? `On ${surface.site}` : `In ${surface.title}`;
      if (surface?.kind === "phone") return `Using ${surface.machine.name}`;
      if (surface?.kind === "app") return `Using ${surface.app.displayName}`;
      return "Working";
    case "waiting":
      return "Waiting";
    case "failed":
      return entry.failure ?? "Couldn’t finish";
    case "finished":
      return entry.lastReply ?? (chat ? "Ask me anything to get started" : "Finished");
  }
}

/**
 * How long ago a task finished or failed, as of `now`; a task still under way
 * shows no time. A list reads it as it draws rather than a row keeping it, so
 * a row that has not changed still ages.
 */
export function taskTime(row: TaskRow, now: number): string | null {
  return row.stopped ? formatRelativeTime(row.updatedAt, new Date(now)) : null;
}

/**
 * The row read aloud as one sentence: its title, then the state its mark
 * shows, then what is happening. "Reply to Ana about the contract, needs you:
 * Approve sending the reply to Ana".
 */
export function taskRowLabel(row: TaskRow, options: { readonly chat?: boolean } = {}): string {
  const chat = options.chat === true;
  const title = chat ? CHAT_THREAD_TITLE : row.title;
  const head = row.unread && row.tone !== "needs-you" ? `${title}, unread` : title;
  const state = stateWord(row.tone, chat);
  if (state === null) return `${head}: ${row.line}`;
  return row.line.toLocaleLowerCase() === state.toLocaleLowerCase()
    ? `${head}, ${state}`
    : `${head}, ${state}: ${row.line}`;
}

function stateWord(tone: TaskTone, chat: boolean): string | null {
  switch (tone) {
    case "needs-you":
      return "needs you";
    case "working":
      return chat ? "replying" : "working";
    case "waiting":
      // The line already says it.
      return null;
    case "failed":
      return "couldn’t finish";
    case "finished":
      return chat ? null : "finished";
  }
}

/**
 * Rows are rebuilt from the task list on every change a list hears, so
 * identity says nothing; a row redraws only when something it shows does.
 */
export function sameTaskRow(left: TaskRow, right: TaskRow): boolean {
  return (
    left.threadId === right.threadId &&
    left.workspaceId === right.workspaceId &&
    left.title === right.title &&
    left.icon === right.icon &&
    left.color === right.color &&
    left.tone === right.tone &&
    left.line === right.line &&
    left.place === right.place &&
    left.unread === right.unread &&
    left.stopped === right.stopped &&
    left.done === right.done &&
    left.canBeDone === right.canBeDone &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt
  );
}

/**
 * How many questions wait on this reader: each pending Request once, however
 * many tasks up its chain it holds up. A badge on the app or a collapsed
 * sidebar shows this number.
 */
export function attentionCount(waitingRequests: readonly WaitingRequest[]): number {
  return new Set(waitingRequests.map(({ request }) => request.id)).size;
}

export interface TaskAttention {
  readonly threadId: string;
  readonly requestId: string;
  /** The request's own short title: who proposed it stays on the request itself. */
  readonly title: string;
}
/** Distinct listed rows with a reader-actionable request, including Chat once. */
export function taskAttention(snapshot: TaskListSource): readonly TaskAttention[] {
  const entries = mergeTaskEntries(snapshot.tasks?.entries ?? [], snapshot.activeTasks);
  const byThread = attributedRequests(snapshot, entries);
  return [...byThread].flatMap(([threadId, asks]) => {
    const first = asks[0];
    return first
      ? [
          {
            threadId,
            requestId: first.request.id,
            title: first.request.presentation.title,
          },
        ]
      : [];
  });
}
export type TaskWaitingReasonKind =
  "paused-queue" | "other-reader" | "account-preparing" | "computer-offline" | "open-helper";
export interface TaskWaitingReason {
  readonly kind: TaskWaitingReasonKind;
  readonly label: string;
}
/** A cause line is present only when current facts establish the cause. */
export function taskWaitingReason(
  snapshot: Pick<
    HostSnapshot,
    | "threads"
    | "tasks"
    | "activeTasks"
    | "environments"
    | "runQueue"
    | "requests"
    | "waitingRequests"
    | "assignments"
  >,
  threadId: string,
): TaskWaitingReason | null {
  const thread =
    snapshot.threads.find((thread) => thread.id === threadId) ??
    mergeTaskEntries(snapshot.tasks?.entries ?? [], snapshot.activeTasks).find(
      ({ thread }) => thread.id === threadId,
    )?.thread;
  if (
    !thread ||
    (thread.status !== "waiting" && thread.status !== "running" && !thread.inputQueuePaused)
  )
    return null;
  const readerRequests = new Set(snapshot.waitingRequests.map(({ request }) => request.id));
  if (
    snapshot.requests[threadId]?.some(
      (request) => request.status === "pending" && !readerRequests.has(request.id),
    )
  )
    return { kind: "other-reader", label: "Waiting for another person to answer" };
  const helper = Object.values(snapshot.assignments).find(
    (assignment) => assignment.parentThreadId === threadId && assignment.status === "open",
  );
  if (helper && thread.status === "waiting")
    return { kind: "open-helper", label: `Waiting for ${assignmentTitle(helper, snapshot)}` };
  if (thread.inputQueuePaused) return { kind: "paused-queue", label: "Queue paused" };
  const queued = snapshot.runQueue.some((entry) => entry.threadId === threadId);
  if (!queued) return null;
  const preparing = threadStartHold({
    thread,
    runQueue: snapshot.runQueue,
    environments: snapshot.environments,
  });
  if (preparing) return { kind: "account-preparing", label: preparing };
  const environment = snapshot.environments.find(
    (environment) => environment.id === thread.environmentId,
  );
  if (environment && !environment.connected)
    return { kind: "computer-offline", label: `${environment.name} is offline` };
  return null;
}
