import { turnState, type TranscriptGroup } from "./agent-activity-model.js";
import type {
  EnvironmentSummary,
  RunQueueEntry,
  ThreadSummary,
  TranscriptEntry,
} from "./client.js";
import { accountGettingReady, threadAccountPreparing } from "./thread-placement.js";

/**
 * What a Thread is doing, as every surface shows it. `background` is a Run
 * whose turn has ended while work it started carries on.
 */
export type ThreadActivity =
  "background" | "idle" | "queued" | "stopping" | "waiting_for_you" | "working";

export interface ThreadActivityInput {
  /** The Thread's transcript, which carries a Stop already asked for. */
  readonly entries: readonly TranscriptEntry[];
  readonly runQueue: readonly RunQueueEntry[];
  readonly thread: Pick<ThreadSummary, "id" | "status">;
}

/**
 * The Host's word on the Thread decides whether it is at work at all; the Run
 * queue and the transcript the client keeps live only say how. A Run the
 * client still holds for a Thread the Host calls idle is therefore never shown
 * as executing.
 */
export function threadActivity(input: ThreadActivityInput): ThreadActivity {
  const { status } = input.thread;
  if (status !== "running" && status !== "waiting") return "idle";
  const runs = threadRuns(input.runQueue, input.thread.id);
  const executing = runs.find((run) => run.status !== "queued");
  const earliest = executing ?? runs[0];
  if (earliest && stopRequested(input.entries, earliest.id)) return "stopping";
  if (status === "waiting") return "waiting_for_you";
  if (executing && inBackground(input.entries, executing.id)) return "background";
  return !executing && runs.length > 0 ? "queued" : "working";
}

export interface ThreadStopTargetInput {
  readonly runQueue: readonly RunQueueEntry[];
  readonly thread: Pick<ThreadSummary, "id" | "inputQueuePaused" | "status">;
}

/**
 * The Run a Stop interrupts, while the Host says the Thread is at work: its
 * earliest executing Run, else the one waiting to start, which the Host ends
 * at once. Null exactly when no surface offers a Stop.
 */
export function threadStopTarget(input: ThreadStopTargetInput): RunQueueEntry | null {
  const { status } = input.thread;
  if (status !== "running" && status !== "waiting") return null;
  return (
    threadRuns(input.runQueue, input.thread.id).find((run) => run.status !== "queued") ??
    nextQueuedRun(input)
  );
}

/**
 * Why the Thread's next Run has not started, in words, when the client knows
 * the Host is holding it: its AI account is still getting ready. Null for an
 * ordinary start, which takes a moment and needs no reason, and once the Run
 * has been handed to its computer.
 */
export function threadStartHold(
  input: ThreadStopTargetInput & {
    readonly environments: readonly EnvironmentSummary[];
    readonly thread: Pick<ThreadSummary, "environmentId" | "harnessInstanceId" | "harnessLabel">;
  },
): string | null {
  return nextQueuedRun(input) !== null && threadAccountPreparing(input.environments, input.thread)
    ? accountGettingReady(input.thread.harnessLabel)
    : null;
}

/**
 * The Run that starts next while none is executing, which can wait for
 * minutes on its computer or AI account. A paused queue holds its Runs for
 * the person instead, so none is next.
 */
function nextQueuedRun(input: ThreadStopTargetInput): RunQueueEntry | null {
  const { inputQueuePaused, status } = input.thread;
  if (inputQueuePaused || (status !== "running" && status !== "waiting")) return null;
  const runs = threadRuns(input.runQueue, input.thread.id);
  return runs.some((run) => run.status !== "queued") ? null : (runs[0] ?? null);
}

export type ThreadActivityIndicator =
  { readonly kind: "status"; readonly label: string } | { readonly kind: "typing" };

/**
 * The line under a Thread's transcript while it is at work, or null. The
 * latest turn already says what it is doing while it is live, so the line
 * stands in only until there is one. A conversation shows Opensteer typing
 * instead, and nothing while it waits: the question is docked in the composer.
 * Work held back from starting says why, as `threadStartHold` words it:
 * typing would claim a reply nobody is writing yet.
 */
export function threadActivityIndicator(
  activity: ThreadActivity,
  options: {
    readonly conversation: boolean;
    readonly groups: readonly TranscriptGroup[];
    readonly startHold?: string | null;
  },
): ThreadActivityIndicator | null {
  if (activity === "idle") return null;
  const latest = options.groups.at(-1);
  if (
    options.conversation &&
    options.groups.findLast((group) => group.kind === "turn")?.turn.personWaiting === false &&
    !(
      latest?.kind === "message" &&
      latest.entry.messageKind === "input" &&
      latest.entry.author.kind === "human"
    )
  )
    return null;
  // A conversation draws no turn head, so this line says the work carries on.
  if (options.conversation && activity === "background") {
    return { kind: "status", label: activityLabels.background };
  }
  const last = options.groups.at(-1);
  if (last?.kind === "turn" && turnState(last.turn) !== "settled") return null;
  if (activity === "queued" && options.startHold) {
    return { kind: "status", label: options.startHold };
  }
  if (options.conversation) {
    // The reader's waiting message is drawn after the reply at work, which
    // already types where it stands.
    const replying = options.groups.some(
      (group) =>
        group.kind === "turn" &&
        group.turn.personWaiting !== false &&
        group.turn.continued !== true &&
        turnState(group.turn) !== "settled",
    );
    return replying || activity === "waiting_for_you" ? null : { kind: "typing" };
  }
  return { kind: "status", label: activityLabels[activity] };
}

const activityLabels: Readonly<Record<Exclude<ThreadActivity, "idle">, string>> = {
  background: "Working in the background",
  queued: "Starting",
  stopping: "Stopping",
  waiting_for_you: "Waiting for you",
  working: "Working",
};

function threadRuns(runQueue: readonly RunQueueEntry[], threadId: string): RunQueueEntry[] {
  return runQueue
    .filter((run) => run.threadId === threadId)
    .sort((left, right) => left.runOrdinal - right.runOrdinal);
}

function inBackground(entries: readonly TranscriptEntry[], runId: string): boolean {
  return entries.some(
    (entry) => entry.kind === "run" && entry.runId === runId && entry.background === true,
  );
}

function stopRequested(entries: readonly TranscriptEntry[], runId: string): boolean {
  return entries.some(
    (entry) => entry.kind === "run" && entry.runId === runId && entry.stopping === true,
  );
}
