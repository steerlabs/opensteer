import {
  CHAT_THREAD_TITLE,
  requestTitleText,
  type AssignmentStatus,
  type AssignmentSummary,
  type DelegationOutcome,
} from "@opensteer/core";
import { formatDuration, groupTranscriptEntries, workSummary } from "./agent-activity-model.js";
import type { AssignmentEntry, DelegationEntry, HostSnapshot, TranscriptEntry } from "./client.js";
import { accountGettingReady, threadAccountPreparing } from "./thread-placement.js";
import { taskMark, type TaskMark } from "./task-marks.js";
import { requestWaitingOnAssignment } from "./waiting-requests.js";

/**
 * How a task reads on its row, its own title, its return row and its detail, so
 * web and mobile say the same thing about the same Host facts.
 *
 * The word is the assignment's own lifecycle. While it is open, what is added
 * is only what the Host stated: its current Run's status, the decisions it is
 * waiting on, and the step the worker's own transcript shows it taking.
 * Nothing is guessed from quiet, timing or the absence of events.
 */
export type AssignmentTone =
  "completed" | "failed" | "paused" | "queued" | "stopped" | "waiting" | "working";

export interface AssignmentPresentation {
  /** The one status word, always shown as text. */
  readonly word: string;
  readonly tone: AssignmentTone;
  /** Whether the task can still change, and so whether Stop belongs to it. */
  readonly open: boolean;
  /** Whether its mark may pulse: a Run working now, on a Host and computer this client can see. */
  readonly moving: boolean;
  /**
   * One line under the title, or null. A surface that shows the worker's own
   * work or its decision already says a `step` or a `decision`; what blocks
   * the task, or a result that could not be returned, it says nowhere else.
   */
  readonly detail: AssignmentDetail | null;
  /** Why Stop cannot be pressed right now, or null. The detail line says it too. */
  readonly stopBlocked: string | null;
  /**
   * The task's latest Run model. For a Run assignment it is named when it
   * differs from the assigning Run; automated work always names its model.
   */
  readonly model: string | null;
  /** What a screen reader is told when the lifecycle moves. Steps within it are not news. */
  readonly announcement: string;
}

export interface AssignmentDetail {
  readonly kind: "decision" | "offline" | "preparing" | "step" | "unreachable" | "undeliverable";
  readonly text: string;
}

/**
 * What only the task's own line can say, for a surface that also shows the
 * worker's work and its docked decision: those already show the step it is on
 * and what it asks.
 */
export function blockingDetail(presentation: AssignmentPresentation): AssignmentDetail | null {
  const { detail } = presentation;
  return detail?.kind === "step" || detail?.kind === "decision" ? null : detail;
}

/** What a client holds that a task's presentation depends on. */
export type AssignmentReader = Pick<
  HostSnapshot,
  | "connection"
  | "environments"
  | "homeThreadId"
  | "network"
  | "requests"
  | "threads"
  | "transcripts"
  | "waitingRequests"
>;

export function assignmentTitle(
  assignment: { readonly workerThread: Pick<AssignmentSummary["workerThread"], "id" | "title"> },
  reader: Pick<HostSnapshot, "threads">,
): string {
  return (
    reader.threads.find(({ id }) => id === assignment.workerThread.id)?.title ??
    assignment.workerThread.title
  );
}

/** A held worker is current; completed or unlisted work can use its embedded mark. */
export function assignmentMark(
  assignment: {
    readonly workerThread: Pick<AssignmentSummary["workerThread"], "icon" | "color"> & {
      readonly id: string;
    };
  },
  reader: Pick<HostSnapshot, "threads">,
): TaskMark {
  return taskMark(
    reader.threads.find(({ id }) => id === assignment.workerThread.id) ?? assignment.workerThread,
  );
}

/**
 * Stopping is a Host command, so only the Host connection gates it: the Host
 * records the cancellation even while the worker's computer is offline. That
 * computer being offline only means nothing is moving.
 */
export function assignmentPresentation(
  assignment: AssignmentSummary,
  reader: AssignmentReader,
): AssignmentPresentation {
  const title = assignmentTitle(assignment, reader);
  const model = assignment.modelLabel;
  if (assignment.status !== "open") {
    const [word, tone] = settledState(assignment.status);
    return {
      announcement: `${title}: ${word}`,
      detail:
        assignment.returnStatus === "undeliverable"
          ? {
              kind: "undeliverable",
              text: `The result could not be returned to ${assignmentRequester(assignment, reader)}.`,
            }
          : null,
      model,
      moving: false,
      open: false,
      stopBlocked: null,
      tone,
      word,
    };
  }
  const waiting = requestWaitingOnAssignment(reader.waitingRequests, assignment.id);
  const [word, tone] = openState(assignment, waiting !== null);
  // Only a Host known to be out of reach makes the word old news; a stream
  // that is still connecting has missed nothing yet.
  const hostReachable = reader.network !== "offline" && reader.connection !== "offline";
  const environment = reader.environments.find(
    ({ id }) => id === assignment.workerThread.environmentId,
  );
  // With the Host unreachable its environment status is as old as the word.
  const offline = hostReachable && environment?.status === "disconnected";
  const stopBlocked = hostReachable ? null : "Reconnect to stop this task.";
  // The worker's own account, which need not be the one that handed it out.
  const worker = reader.threads.find(({ id }) => id === assignment.workerThread.id);
  const preparing =
    assignment.currentRunStatus === "queued" &&
    worker !== undefined &&
    threadAccountPreparing(reader.environments, worker);
  const step = tone === "working" ? currentStep(assignment, reader.transcripts) : null;
  const detail: AssignmentDetail | null =
    stopBlocked !== null
      ? { kind: "unreachable", text: stopBlocked }
      : offline && environment
        ? { kind: "offline", text: `${environment.name} is offline.` }
        : waiting !== null
          ? { kind: "decision", text: requestTitleText(waiting.request.presentation) }
          : preparing
            ? { kind: "preparing", text: `${accountGettingReady(worker.harnessLabel)}.` }
            : step === null
              ? null
              : { kind: "step", text: step };
  return {
    announcement: `${title}: ${word}`,
    detail,
    model,
    moving: hostReachable && !offline && assignment.currentRunStatus === "running",
    open: true,
    stopBlocked,
    tone,
    word: hostReachable ? word : `Last known: ${word}`,
  };
}

/**
 * The one line under a task's title in the conversation that handed it out:
 * the step it is taking while it works, the question while it waits on its
 * reader, and otherwise its word — with how long a finished task took, and
 * why its result never came back, when that is so.
 */
export function assignmentStatusLine(
  assignment: AssignmentSummary,
  presentation: AssignmentPresentation,
): string {
  const { detail, model, word } = presentation;
  const withModel = (line: string) => (model === null ? line : `${line} · ${model}`);
  if (!presentation.open) {
    const took =
      assignment.finishedAt === null
        ? null
        : formatDuration(Date.parse(assignment.finishedAt) - Date.parse(assignment.createdAt));
    return withModel(
      [word, took, detail?.text].filter((part) => part !== null && part !== undefined).join(" · "),
    );
  }
  switch (detail?.kind) {
    case "step":
    case "offline":
    case "preparing":
      return withModel(detail.text);
    case "decision":
      return withModel(`${word} · ${detail.text}`);
    default:
      return withModel(word);
  }
}

/** What the reader calls the conversation a task reports back to. */
export function assignmentRequester(
  assignment: AssignmentSummary,
  reader: Pick<HostSnapshot, "homeThreadId" | "threads">,
): string {
  const parent = assignment.parentThreadId;
  if (parent === reader.homeThreadId) return CHAT_THREAD_TITLE;
  return (
    reader.threads.find(({ id }) => id === parent)?.title ??
    (assignment.origin === "run" ? "the conversation that asked for it" : "its automation")
  );
}

/**
 * An open task's word, as the summary states it. Its Run ending leaves it
 * open only while something is still owed — a decision, a queued input, work
 * it handed on — so a Run that completed or failed there means it is waiting
 * on that work, and a Run the person interrupted means it is paused.
 *
 * "Needs you" is only ever a question its reader is the one to answer,
 * anywhere in the work; one someone else must answer holds it just the same.
 */
function openState(
  assignment: AssignmentSummary,
  waitsOnReader: boolean,
): [string, AssignmentTone] {
  if (waitsOnReader) return [needsYou, "waiting"];
  if (assignment.currentRunStatus === "waiting" || assignment.workerThread.pendingRequests > 0)
    return ["Waiting for approval", "queued"];
  switch (assignment.currentRunStatus) {
    case "running":
    case "starting":
    case "completed":
    case "failed":
      return ["Working", "working"];
    case "interrupted":
      return ["Paused", "paused"];
    case "queued":
    case null:
      return ["Waiting to start", "queued"];
  }
}

function settledState(status: Exclude<AssignmentStatus, "open">): [string, AssignmentTone] {
  switch (status) {
    case "completed":
      return ["Finished", "completed"];
    case "failed":
      return ["Couldn’t finish", "failed"];
    case "cancelled":
      return ["Stopped", "stopped"];
  }
}

const delegationStatus: Record<DelegationOutcome, Exclude<AssignmentStatus, "open">> = {
  completed: "completed",
  failed: "failed",
  interrupted: "cancelled",
};

/**
 * Work handed out before Assignments existed, which settled when its one Run
 * ended. It reads in an Assignment's words, so an old conversation says what
 * a new one would about the same ending.
 */
export function delegationPresentation(
  delegation: DelegationEntry,
  reader: Pick<HostSnapshot, "threads">,
): AssignmentPresentation {
  const title =
    reader.threads.find(({ id }) => id === delegation.childThread.id)?.title ??
    delegation.childThread.title;
  const [word, tone] = settledState(delegationStatus[delegation.outcome]);
  return {
    announcement: `${title}: ${word}`,
    detail:
      delegation.delivery.status === "undeliverable"
        ? { kind: "undeliverable", text: "Its result could not be returned here." }
        : null,
    model: null,
    moving: false,
    open: false,
    stopBlocked: null,
    tone,
    word,
  };
}

/**
 * What a task's row adds under its title, or null: the question it waits on,
 * or what keeps it from going on or from reporting back. The step it is
 * taking is the task's own news; "Working" already says it works.
 */
export function taskRowNote(presentation: AssignmentPresentation): AssignmentDetail | null {
  return presentation.detail?.kind === "step" ? null : presentation.detail;
}

/** One state in a group's summary: how many tasks read that word. */
export interface TaskGroupPart {
  readonly tone: AssignmentTone;
  /** Whether a task counted here is working now, so its dot may pulse. */
  readonly moving: boolean;
  readonly text: string;
}

/**
 * Tasks one turn handed out, read as one: how many, and how many read each
 * word, what asks for the reader or went wrong first. The counts use each
 * task's own word, so a group never says what its rows would not.
 */
export function taskGroupSummary(presentations: readonly AssignmentPresentation[]): {
  readonly label: string;
  readonly parts: readonly TaskGroupPart[];
} {
  const byWord = new Map<string, { count: number; moving: boolean; tone: AssignmentTone }>();
  for (const { moving, tone, word } of presentations) {
    const held = byWord.get(word);
    byWord.set(word, {
      count: (held?.count ?? 0) + 1,
      moving: (held?.moving ?? false) || moving,
      tone,
    });
  }
  // A copy sorted in place: Hermes, which the phone runs, has no `toSorted`.
  const parts = [...byWord]
    .sort(([, left], [, right]) => groupOrder[left.tone] - groupOrder[right.tone])
    .map(([word, { count, moving, tone }]) => ({
      moving,
      text: `${count} ${(word === needsYou && count > 1 ? "Need you" : word).toLowerCase()}`,
      tone,
    }));
  return { label: `${presentations.length} tasks`, parts };
}

const needsYou = "Needs you";

/** What a reader looks for first in a group: what asks for them, then what went wrong. */
const groupOrder: Record<AssignmentTone, number> = {
  waiting: 0,
  failed: 1,
  completed: 2,
  working: 3,
  paused: 4,
  queued: 5,
  stopped: 6,
};

/**
 * The step the worker is taking now, from its own transcript, held while a
 * card observes it. Only a named step is worth a line: "Working" already is
 * the word.
 */
function currentStep(
  assignment: AssignmentSummary,
  transcripts: Readonly<Record<string, readonly TranscriptEntry[]>>,
): string | null {
  const runId = assignment.currentRunId;
  const entries = transcripts[assignment.workerThread.id];
  if (runId === null || entries === undefined) return null;
  const turn = groupTranscriptEntries(
    entries.filter((entry) => entry.kind !== "withdrawn" && entry.runId === runId),
  ).findLast((group) => group.kind === "turn");
  if (turn?.kind !== "turn") return null;
  const summary = workSummary(turn.turn);
  return summary.state === "live" && summary.label !== "Working" && summary.label !== "Starting"
    ? summary.label
    : null;
}

/**
 * The newest of what this client holds for one assignment. The snapshot's copy
 * can be ahead of a transcript entry (a cancel receipt, a list read) and never
 * behind it; revision alone orders them, so an older event cannot reopen a card.
 */
export function currentAssignment(
  entry: AssignmentEntry,
  assignments: Readonly<Record<string, AssignmentSummary>>,
): AssignmentSummary {
  const held = assignments[entry.assignment.id];
  return held !== undefined && held.revision >= entry.assignment.revision ? held : entry.assignment;
}

/**
 * The assignment a work Thread is doing now: its open one, else the one it
 * finished most recently. Null when this client holds none for it.
 */
export function workerAssignment(
  assignments: Readonly<Record<string, AssignmentSummary>>,
  threadId: string,
): AssignmentSummary | null {
  let open: AssignmentSummary | null = null;
  let latest: AssignmentSummary | null = null;
  for (const assignment of Object.values(assignments)) {
    if (assignment.workerThread.id !== threadId) continue;
    if (assignment.status === "open" && (open === null || assignment.createdAt > open.createdAt))
      open = assignment;
    if (latest === null || assignment.createdAt > latest.createdAt) latest = assignment;
  }
  return open ?? latest;
}

/**
 * A task's own Thread, without the entries its assignment left there: the
 * task is what that Thread is doing, which its title says, not a card inside
 * the work it describes. Nothing to drop hands back the same array.
 */
export function withoutOwnAssignment<Entry extends TranscriptEntry>(
  entries: readonly Entry[],
  threadId: string,
): readonly Entry[] {
  const own = (entry: Entry) =>
    entry.kind === "assignment" && entry.assignment.workerThread.id === threadId;
  return entries.some(own) ? entries.filter((entry) => !own(entry)) : entries;
}
