import type { AssignmentSummary } from "@opensteer/core";
import type {
  BrowserSessionUseSummary,
  HostSnapshot,
  ThreadSummary,
  TranscriptEntry,
  WaitingRequestView,
} from "./client.js";
import type { SubagentReader } from "./subagent-model.js";
import { requestsWaitingOn } from "./waiting-requests.js";

/*
 * One task's view reads a handful of the snapshot's app-wide collections. These read exactly the
 * part that concerns it, keyed to the task, so the open task redraws when its own work changes and
 * never because another task, tab or assignment did.
 */

/**
 * What cards about handed-out work read: those assignments as held, the Threads they name (the
 * worker and the conversation it reports to), the questions holding them up, the work locations,
 * and whether the Host is in reach. It is a `SubagentReader`, narrowed.
 */
export type WorkScope = SubagentReader & {
  readonly assignments: Readonly<Record<string, AssignmentSummary>>;
  readonly waitingRequests: readonly WaitingRequestView[];
};

/** A task's own work: its scope, and the browsers its Runs used. */
export interface ThreadScope extends WorkScope {
  readonly browserUses: readonly BrowserSessionUseSummary[];
}

/** The work a transcript names by id: assignments it shows or hears back from, and older delegations' Threads. */
export interface TranscriptWork {
  readonly assignmentIds: readonly string[];
  readonly threadIds: readonly string[];
}

const noWork: TranscriptWork = { assignmentIds: [], threadIds: [] };

export function transcriptWork(entries: readonly TranscriptEntry[]): TranscriptWork {
  const assignments = new Set<string>();
  const threads = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "assignment") assignments.add(entry.assignment.id);
    else if (entry.kind === "assignment-return") assignments.add(entry.assignmentId);
    else if (entry.kind === "delegation") threads.add(entry.childThread.id);
    else if (
      entry.kind === "run" &&
      entry.startedBy?.kind === "platform" &&
      entry.startedBy.cause === "assignment-result" &&
      entry.startedBy.referenceId
    )
      assignments.add(entry.startedBy.referenceId);
  }
  if (assignments.size === 0 && threads.size === 0) return noWork;
  return { assignmentIds: [...assignments].sort(), threadIds: [...threads].sort() };
}

/**
 * Everything one task's view reads of handed-out work and browsers: the work it handed out, the
 * assignment it works on, whatever its transcript names, and the questions waiting on any of it.
 */
export function threadScope(
  snapshot: HostSnapshot,
  threadId: string,
  work: TranscriptWork = noWork,
): ThreadScope {
  const named = new Set(work.assignmentIds);
  const assignments = Object.values(snapshot.assignments).filter(
    (assignment) =>
      assignment.parentThreadId === threadId ||
      assignment.workerThread.id === threadId ||
      named.has(assignment.id),
  );
  const parent = snapshot.threads.find(({ id }) => id === threadId)?.parentThreadId ?? null;
  return {
    ...workScope(
      snapshot,
      assignments,
      [threadId, ...(parent === null ? [] : [parent]), ...work.threadIds],
      (waiting) => requestsWaitingOn([waiting], threadId).length > 0,
    ),
    browserUses: snapshot.browserUses.filter((use) => use.threadId === threadId),
  };
}

/** What cards about these assignments read; see `WorkScope`. */
export function assignmentScope(
  snapshot: HostSnapshot,
  assignmentIds: readonly string[],
): WorkScope {
  return workScope(
    snapshot,
    assignmentIds.flatMap((id) => snapshot.assignments[id] ?? []),
    [],
  );
}

function workScope(
  snapshot: HostSnapshot,
  assignments: readonly AssignmentSummary[],
  threadIds: readonly string[],
  alsoWaiting?: (waiting: WaitingRequestView) => boolean,
): WorkScope {
  const ids = new Set(assignments.map(({ id }) => id));
  const threads = new Set(threadIds);
  for (const assignment of assignments) {
    threads.add(assignment.workerThread.id);
    if (assignment.parentThreadId) threads.add(assignment.parentThreadId);
  }
  return {
    assignments: Object.fromEntries(assignments.map((assignment) => [assignment.id, assignment])),
    connection: snapshot.connection,
    environments: snapshot.environments,
    network: snapshot.network,
    threads: snapshot.threads.filter(({ id }) => threads.has(id)),
    waitingRequests: snapshot.waitingRequests.filter(
      (waiting) =>
        waiting.assignments.some(({ id }) => ids.has(id)) || alsoWaiting?.(waiting) === true,
    ),
  };
}

export function sameWorkScope(left: WorkScope, right: WorkScope): boolean {
  return (
    left.connection === right.connection &&
    left.network === right.network &&
    left.environments === right.environments &&
    sameRecord(left.assignments, right.assignments) &&
    sameItems<ThreadSummary>(left.threads, right.threads) &&
    sameItems(left.waitingRequests, right.waitingRequests)
  );
}

export function sameThreadScope(left: ThreadScope, right: ThreadScope): boolean {
  return sameWorkScope(left, right) && sameItems(left.browserUses, right.browserUses);
}

/** The same items, in order, each the same object. */
export function sameItems<Item>(left: readonly Item[], right: readonly Item[]): boolean {
  return (
    left === right ||
    (left.length === right.length && left.every((item, index) => item === right[index]))
  );
}

/** The same fields, each the same value: for a selection of a few facts. */
export function sameFields<Value extends object>(left: Value, right: Value): boolean {
  if (left === right) return true;
  const keys = Object.keys(left) as (keyof Value)[];
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.is(left[key], right[key]))
  );
}

function sameRecord<Value>(
  left: Readonly<Record<string, Value>>,
  right: Readonly<Record<string, Value>>,
): boolean {
  if (left === right) return true;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}
