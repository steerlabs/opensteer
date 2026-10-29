import { compareSequence, type Sequence, type ThreadReadState } from "@opensteer/core";

function later(left: Sequence | null, right: Sequence | null): Sequence | null {
  if (left === null) return right;
  if (right === null) return left;
  return compareSequence(left, right) >= 0 ? left : right;
}

export function isThreadUnread(state: ThreadReadState | null | undefined): boolean {
  return (
    state?.unreadSequence != null &&
    (state.readSequence === null || compareSequence(state.unreadSequence, state.readSequence) > 0)
  );
}

/** Read positions advance independently of the workspace's content cut. A
 * cancellation can lower its unread candidate; an older HTTP response cannot
 * restore it. At one content cut, keeping the greatest candidate is safe
 * because the greatest read position suppresses candidates already read.
 */
export function mergeThreadReadState(
  previous: ThreadReadState | undefined,
  incoming: ThreadReadState,
): ThreadReadState {
  if (!previous) return incoming;
  const order = compareSequence(incoming.asOfSequence, previous.asOfSequence);
  return {
    threadId: incoming.threadId,
    readSequence: later(previous.readSequence, incoming.readSequence),
    asOfSequence: order > 0 ? incoming.asOfSequence : previous.asOfSequence,
    unreadSequence:
      order > 0
        ? incoming.unreadSequence
        : order < 0
          ? previous.unreadSequence
          : later(previous.unreadSequence, incoming.unreadSequence),
  };
}
