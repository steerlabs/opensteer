import { assignmentTitle, workerAssignment } from "./assignment-presentation.js";
import {
  requestTitleText,
  type IconName,
  type MarkColor,
  type WaitingRequest,
} from "@opensteer/core";
import {
  mainDoneTasks,
  type HostSnapshot,
  type TaskEntry,
  type TaskListState,
  type ThreadSummary,
} from "./client.js";
import { startOfDay } from "./automation-presentation.js";
import { threadStartHold } from "./thread-activity.js";
import { compareTaskOrder, mergeTaskEntries } from "./task-entries.js";
import { conversationSurfaces, type SurfaceItem } from "./surfaces.js";
import { formatRelativeTime } from "./thread-list-model.js";
import { isThreadUnread } from "./thread-read-state.js";

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
  readonly folder: import("@opensteer/core").TaskFolder;
  readonly teamOrigin: import("@opensteer/core").TeamTaskOrigin | null;
  readonly title: string;
  readonly icon: IconName | null;
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
  /** When it was put in Done, while it is there. */
  readonly doneAt: string | null;
  /** The Host put it in Done because nothing touched it. */
  readonly quietlyDone: boolean;
  readonly canBeDone: boolean;
  readonly askedAt: string;
}

export interface FolderTaskList {
  /**
   * Work under way: tasks waiting on the reader first, then the ones working
   * or waiting on someone else, each newest asked first.
   */
  readonly working: readonly TaskRow[];
  /** Stopped tasks and unread or currently open Done tasks, newest asked first. */
  readonly ready: readonly TaskRow[];
  /** Shared Done tasks the reader has seen and closed, newest asked first. */
  readonly done: readonly TaskRow[];
  /** How many tasks are working right now. */
  readonly running: number;
  /** Whether the Host holds more of these tasks than this client has read. */
  readonly hasMore: boolean;
}

export type TaskList = FolderTaskList;

/** Everything a task list is drawn from, and nothing else. */
const taskListSourceKeys = [
  "quietTasksAvailable",
  "doneTasks",
  "activeTasks",
  "assignments",
  "browserSessions",
  "browserUses",
  "browserProfiles",
  "connection",
  "machines",
  "tasks",
  "threadReadStates",
  "waitingRequests",
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

export interface TaskListOptions {
  /** The task this screen shows. */
  readonly openThreadId?: string | null | undefined;
  /**
   * The list this screen last drew. An unread Done task waits in Ready, and
   * reading it would move it to Done under the reader who just opened it, so
   * while it is open it stays where that list showed it.
   */
  readonly previous?: Pick<FolderTaskList, "ready"> | null | undefined;
}

export function taskList(snapshot: TaskListSource, options: TaskListOptions = {}): TaskList {
  return arrange(
    snapshot,
    snapshot.tasks,
    snapshot.activeTasks,
    options,
    Object.values(snapshot.doneTasks).flatMap(({ entries }) => entries),
  );
}

export function folderTaskList(
  snapshot: TaskListSource,
  folder: import("@opensteer/core").TaskFolder,
  options: TaskListOptions = {},
): FolderTaskList {
  const list = taskList(snapshot, options);
  const matches = (row: TaskRow) =>
    row.folder.computerId === folder.computerId && row.folder.path === folder.path;
  return {
    ...list,
    working: list.working.filter(matches),
    ready: list.ready.filter(matches),
    done: list.done.filter(matches),
  };
}

/**
 * The freshest copy this client holds of one Thread, whichever of an open
 * conversation or a task list loaded it, so Done works on a task no list holds:
 * delegated work, or a Done task past the loaded pages.
 */
export function heldThread(
  snapshot: Pick<HostSnapshot, "threads" | "tasks" | "activeTasks" | "doneTasks">,
  threadId: string,
): ThreadSummary | null {
  return (
    snapshot.threads.find(({ id }) => id === threadId) ??
    [
      ...snapshot.activeTasks,
      ...Object.values(snapshot.doneTasks).flatMap(({ entries }) => entries),
      ...(snapshot.tasks?.entries ?? []),
    ].find(({ thread }) => thread.id === threadId)?.thread ??
    null
  );
}

export function listedRowThreadId(
  snapshot: Pick<HostSnapshot, "threads" | "tasks" | "activeTasks" | "doneTasks">,
  threadId: string,
): string {
  const seen = new Set<string>();
  let current = heldThread(snapshot, threadId);
  while (current !== null && !current.listed) {
    const parent = current.parentThreadId;
    if (parent === null || seen.has(current.id)) return threadId;
    seen.add(current.id);
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

export function requesterLink(snapshot: TaskListSource, threadId: string): RequesterLink | null {
  const held = heldThread(snapshot, threadId);
  return held === null ? null : { threadId, title: held.title };
}

export function taskCanBeDone(
  _snapshot: Pick<HostSnapshot, "quietTasksAvailable">,
  thread: Pick<ThreadSummary, "purpose">,
): boolean {
  return thread.purpose === "task";
}

/** Work that marking the task Done would stop, which a person confirms first. */
export function taskUnderWay(thread: Pick<ThreadSummary, "doneAt" | "status">): boolean {
  return thread.doneAt === null && (thread.status === "running" || thread.status === "waiting");
}

function arrange(
  snapshot: TaskListSource,
  tasks: TaskListState | null,
  activeTasks: readonly TaskEntry[],
  options: TaskListOptions,
  doneEntries: readonly TaskEntry[] = [],
): TaskList {
  // An unread Done task waits in Ready, though only a Done list may hold it.
  const unreadDone = doneEntries.filter(({ thread }) =>
    isThreadUnread(snapshot.threadReadStates[thread.id]),
  );
  const entries = mergeTaskEntries(tasks?.entries ?? [], activeTasks, unreadDone).filter(
    ({ thread }) => thread.listed && thread.purpose === "task",
  );
  const asks = attributedRequests(snapshot, entries);
  const working: TaskRow[] = [];
  const ready: TaskRow[] = [];
  const done: TaskRow[] = [];
  const { openThreadId, previous } = options;
  const holdOpen =
    openThreadId != null &&
    previous?.ready.some(({ threadId, done }) => done && threadId === openThreadId) === true;
  for (const entry of entries) {
    const row = rowOf(snapshot, entry, asks.get(entry.thread.id) ?? []);
    if (row.done)
      (row.unread || (holdOpen && row.threadId === openThreadId) ? ready : done).push(row);
    else if (row.stopped) ready.push(row);
    else working.push(row);
  }
  // `sort` mutates the fresh arrays above, which Hermes needs because it
  // lacks the change-by-copy array methods.
  working.sort(
    (left, right) =>
      Number(right.tone === "needs-you") - Number(left.tone === "needs-you") ||
      newestAsked(left, right),
  );
  ready.sort(newestAsked);
  done.sort(newestAsked);
  return {
    working,
    ready,
    done,
    running: working.filter((row) => row.tone === "working").length,
    hasMore: tasks?.window.hasMore ?? false,
  };
}

function newestAsked(left: TaskRow, right: TaskRow): number {
  return compareTaskOrder(
    { askedAt: left.askedAt, id: left.threadId },
    { askedAt: right.askedAt, id: right.threadId },
  );
}

function attributedRequests(
  snapshot: TaskListSource,
  entries: readonly TaskEntry[],
): ReadonlyMap<string, WaitingRequest[]> {
  const listed = new Set(
    entries
      .filter(({ thread }) => thread.listed && thread.purpose === "task")
      .map(({ thread }) => thread.id),
  );
  const byThread = new Map<string, WaitingRequest[]>();
  for (const waiting of snapshot.waitingRequests) {
    const threadId = [
      waiting.request.originatingThreadId,
      ...(waiting.presentation ? [waiting.presentation.threadId] : []),
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
  const surface = tone === "working" ? workingSurface(snapshot, thread.id) : null;
  return {
    threadId: thread.id,
    folder: thread.folder,
    teamOrigin: thread.teamOrigin,
    title: held.title,
    icon: held.icon,
    color: held.color,
    tone,
    line:
      tone === "waiting"
        ? (taskWaitingReason(snapshot, thread.id)?.label ?? "Waiting")
        : taskLine(entry, tone, asks, surface),
    place: surface === null ? null : placeName(surface),
    done: thread.doneAt !== null,
    doneAt: thread.doneAt,
    quietlyDone: thread.doneAt !== null && thread.doneReason === "quiet",
    // The Host also refuses an active channel conversation, which a client cannot tell apart.
    canBeDone: thread.purpose === "task",
    unread: isThreadUnread(snapshot.threadReadStates[thread.id]),
    // A Stop pauses the queue: the task waits for the person alone, as a finished one does.
    stopped:
      tone === "finished" ||
      tone === "failed" ||
      (tone === "waiting" && thread.inputQueuePaused && thread.status !== "waiting"),
    askedAt: thread.askedAt,
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
      return entry.lastReply ?? "Finished";
  }
}

/**
 * How long ago a person asked for work, as of `now`; a task still under way
 * shows no time. A list reads it as it draws rather than a row keeping it, so
 * a row that has not changed still ages.
 */
export function taskTime(row: TaskRow, now: number): string | null {
  return row.stopped ? formatRelativeTime(row.askedAt, new Date(now)) : null;
}

/**
 * The row read aloud as one sentence: its title, then the state its mark
 * shows, then what is happening. "Reply to Ana about the contract, needs you:
 * Approve sending the reply to Ana".
 */
export function taskRowLabel(row: TaskRow): string {
  const title = row.title;
  const head = row.unread && row.tone !== "needs-you" ? `${title}, unread` : title;
  const state = stateWord(row.tone);
  if (state === null) return `${head}: ${row.line}`;
  return row.line.toLocaleLowerCase() === state.toLocaleLowerCase()
    ? `${head}, ${state}`
    : `${head}, ${state}: ${row.line}`;
}

function stateWord(tone: TaskTone): string | null {
  switch (tone) {
    case "needs-you":
      return "needs you";
    case "working":
      return "working";
    case "waiting":
      // The line already says it.
      return null;
    case "failed":
      return "couldn’t finish";
    case "finished":
      return "finished";
  }
}

/**
 * Rows are rebuilt from the task list on every change a list hears, so
 * identity says nothing; a row redraws only when something it shows does.
 */
export function sameTaskRow(left: TaskRow, right: TaskRow): boolean {
  return (
    left.threadId === right.threadId &&
    left.folder.computerId === right.folder.computerId &&
    left.folder.path === right.folder.path &&
    left.teamOrigin?.teamId === right.teamOrigin?.teamId &&
    left.teamOrigin?.channelId === right.teamOrigin?.channelId &&
    left.teamOrigin?.threadRootId === right.teamOrigin?.threadRootId &&
    left.title === right.title &&
    left.icon === right.icon &&
    left.color === right.color &&
    left.tone === right.tone &&
    left.line === right.line &&
    left.place === right.place &&
    left.unread === right.unread &&
    left.stopped === right.stopped &&
    left.done === right.done &&
    left.doneAt === right.doneAt &&
    left.quietlyDone === right.quietlyDone &&
    left.canBeDone === right.canBeDone &&
    left.askedAt === right.askedAt
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

export interface DoneTaskList {
  /** Newest Done first. A Done task with something unread waits in Ready instead. */
  readonly rows: readonly TaskRow[];
  /** Every Done task the Host holds for this list, read or not. */
  readonly total: number;
  readonly hasMore: boolean;
}

export function doneTaskList(snapshot: TaskListSource, deploymentId?: string): DoneTaskList | null {
  if (!snapshot.quietTasksAvailable) return null;
  const list = snapshot.doneTasks[deploymentId ?? mainDoneTasks];
  if (!list) return null;
  const rows = list.entries
    .filter(({ thread }) => thread.listed && thread.doneAt !== null)
    .map((entry) => rowOf(snapshot, entry, []))
    .filter((row) => row.done && !row.unread)
    // Pages merge in asked order; Done reads newest Done first.
    .sort(
      (left, right) =>
        (right.doneAt ?? "").localeCompare(left.doneAt ?? "") ||
        right.threadId.localeCompare(left.threadId),
    );
  return { rows, total: list.window.totalItems, hasMore: list.window.hasMore };
}

export interface DoneDay {
  readonly id: "today" | "week" | "earlier";
  readonly title: string;
  readonly rows: readonly TaskRow[];
}

/** Done rows by the day they were put there, in the reader's own days: Today, This week, Earlier. */
export function doneDays(rows: readonly TaskRow[], now: number): readonly DoneDay[] {
  const today = startOfDay(now);
  const week = today - 6 * 24 * 60 * 60 * 1_000;
  const days: Record<DoneDay["id"], TaskRow[]> = { today: [], week: [], earlier: [] };
  for (const row of rows) {
    const doneAt = row.doneAt ? Date.parse(row.doneAt) : Number.NaN;
    days[doneAt >= today ? "today" : doneAt >= week ? "week" : "earlier"].push(row);
  }
  const titles = { today: "Today", week: "This week", earlier: "Earlier" } as const;
  return (["today", "week", "earlier"] as const)
    .filter((id) => days[id].length > 0)
    .map((id) => ({ id, title: titles[id], rows: days[id] }));
}

/** How long ago a Done row was put in Done, as its list reads it while drawing. */
export function doneTime(row: TaskRow, now: number): string | null {
  return row.doneAt ? formatRelativeTime(row.doneAt, new Date(now)) : null;
}

/** How far back a device that has shown nothing yet still tells of quiet moves. */
const unseenQuietWindowMs = 7 * 24 * 60 * 60 * 1_000;

/**
 * The tasks the Host moved to Done quietly since this device last showed
 * them: newer than `seenThrough`, the newest such Done time it has shown, or
 * than a week ago before it has shown any. Read from the Done list, so it
 * counts as far as that list has been read.
 */
export function quietlyMoved(
  list: DoneTaskList | null,
  seenThrough: string | null,
  now: number,
): readonly TaskRow[] {
  if (!list) return [];
  const since = seenThrough ? Date.parse(seenThrough) : now - unseenQuietWindowMs;
  return list.rows.filter(
    (row) => row.quietlyDone && row.doneAt !== null && Date.parse(row.doneAt) > since,
  );
}

/** The newest Done time among rows a device just showed, to remember as seen. */
export function seenThroughOf(rows: readonly TaskRow[], previous: string | null): string | null {
  return rows.reduce<string | null>(
    (latest, { doneAt }) => (doneAt && (!latest || doneAt > latest) ? doneAt : latest),
    previous,
  );
}

/** Where a device keeps what it has shown of quiet moves: per Deployment and person. */
export function quietSeenScope(
  snapshot: Pick<HostSnapshot, "deploymentId" | "user">,
): string | null {
  return snapshot.deploymentId && snapshot.user
    ? `${snapshot.deploymentId}:${snapshot.user.id}`
    : null;
}
