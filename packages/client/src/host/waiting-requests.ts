import type { HeldAssignment, WaitingRequest } from "@opensteer/core";

/**
 * The questions waiting on a Thread's reader: asked there, or by work it
 * handed out at any depth. Home shows what its tasks ask above its composer and
 * a task shows what its helpers ask, so a question is answered wherever its
 * reader is watching the work it holds up.
 */
export function requestsWaitingOn(
  waiting: readonly WaitingRequest[],
  threadId: string,
): WaitingRequest[] {
  return waiting.filter(
    ({ assignments, request }) =>
      request.originatingThreadId === threadId ||
      assignments.some(({ parentThreadId }) => parentThreadId === threadId),
  );
}

/** A question holding up one piece of handed-out work, wherever in it it was asked. */
export function requestWaitingOnAssignment(
  waiting: readonly WaitingRequest[],
  assignmentId: string,
): WaitingRequest | null {
  return (
    waiting.find(({ assignments }) => assignments.some(({ id }) => id === assignmentId)) ?? null
  );
}

/**
 * The work a Thread handed out that a question arrived through, as that
 * Thread's reader knows it: its own task, even when a helper inside that task
 * asked. Null for a question asked in the Thread itself.
 */
export function waitingRequestSource(
  waiting: WaitingRequest,
  threadId: string,
): HeldAssignment | null {
  if (waiting.request.originatingThreadId === threadId) return null;
  return waiting.assignments.find(({ parentThreadId }) => parentThreadId === threadId) ?? null;
}

/**
 * Every Thread a question waits on: where it was asked, and each Thread that
 * handed out the work it holds up. A task's row says "Needs you" when a helper
 * inside it asks, because that task is where its reader finds the helper.
 */
export function threadsWaitingOnReader(waiting: readonly WaitingRequest[]): ReadonlySet<string> {
  const threadIds = new Set<string>();
  for (const { assignments, request } of waiting) {
    threadIds.add(request.originatingThreadId);
    for (const { parentThreadId } of assignments) threadIds.add(parentThreadId);
  }
  return threadIds;
}
