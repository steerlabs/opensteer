import type { HeldAssignment, WaitingRequest } from "@opensteer/core";

export function requestsWaitingOn(
  waiting: readonly WaitingRequest[],
  threadId: string,
): WaitingRequest[] {
  return waiting.filter(
    ({ assignments, presentation, request }) =>
      presentation?.threadId === threadId ||
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

export function waitingRequestPresentationSource(waiting: WaitingRequest, threadId: string) {
  return waiting.presentation?.threadId === threadId ? waiting.presentation.workerThread : null;
}

/**
 * Every Thread a question waits on: where it was asked, and each Thread that
 * handed out the work it holds up. A task's row says "Needs you" when a helper
 * inside it asks, because that task is where its reader finds the helper.
 */
export function threadsWaitingOnReader(waiting: readonly WaitingRequest[]): ReadonlySet<string> {
  const threadIds = new Set<string>();
  for (const { assignments, presentation, request } of waiting) {
    if (presentation) threadIds.add(presentation.threadId);
    threadIds.add(request.originatingThreadId);
    for (const { parentThreadId } of assignments) threadIds.add(parentThreadId);
  }
  return threadIds;
}
