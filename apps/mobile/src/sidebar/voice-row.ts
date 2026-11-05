import {
  heldThread,
  isThreadUnread,
  requestsWaitingOn,
  type HostSnapshot,
} from "@opensteer/client/host";

export type VoiceRowMark = "needs-you" | "working" | "unread" | null;

/**
 * What the Voice row says, by the rules Chat's row keeps. The task list holds no
 * row for this unlisted Thread, and a question stands on the first listed Thread
 * on its way up, so a task the Voice Thread started says "Needs you" on its own row.
 */
export function voiceRowMark(snapshot: HostSnapshot): VoiceRowMark {
  const threadId = snapshot.voiceThreadId;
  if (threadId === null) return null;
  const asked = requestsWaitingOn(snapshot.waitingRequests, threadId).some(
    ({ assignments, presentation, request }) =>
      [
        request.originatingThreadId,
        ...(presentation ? [presentation.threadId] : []),
        ...assignments.map(({ parentThreadId }) => parentThreadId),
      ].find((id) => id === threadId || heldThread(snapshot, id)?.listed === true) === threadId,
  );
  if (asked) return "needs-you";
  if (heldThread(snapshot, threadId)?.status === "running") return "working";
  return isThreadUnread(snapshot.threadReadStates[threadId]) ? "unread" : null;
}
