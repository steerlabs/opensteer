import type { ActionReview, HostClient, ReviewedAction } from "@opensteer/client/host";
import { useActionReview } from "@opensteer/client/react";
import { useCallback } from "react";
import type { ActionLineValue } from "../ui/action-line.js";
import { screenAction, useScreenAction, type ActionWords } from "../ui/client-feedback.js";

/** One subagent's or task's Stop, keyed so its row and its screen say how it went. */
export interface StopTarget {
  readonly key: string;
  readonly words: ActionWords;
}

const spec = (words: ActionWords) => ({
  ...words,
  execute: (work: () => Promise<boolean>) => work(),
});

export function subagentStopTarget(card: {
  readonly key: string;
  readonly title: string;
}): StopTarget {
  return {
    key: `stop-node:${card.key}`,
    words: { label: `stop ${card.title}`, done: "stopped", happened: `${card.title} stopped` },
  };
}

export function assignmentStopTarget(assignmentId: string, title: string): StopTarget {
  return {
    key: `stop-assignment:${assignmentId}`,
    words: { label: `stop ${title}`, done: "stopped", happened: `${title} stopped` },
  };
}

/**
 * What the last Stop came to, until what it stops shows it stopping or
 * settled (`settled`), which answers a lost reply better than any line.
 */
export function useStopLine(
  hostClient: HostClient | null,
  target: StopTarget | null,
  settled: boolean,
): ActionLineValue | null {
  const { line } = useScreenAction(
    target === null ? null : hostClient,
    target?.key ?? "",
    spec(target?.words ?? { label: "stop this" }),
  );
  return settled ? null : line;
}

/** What a task's last Stop came to, until it shows stopped; for its row and its header. */
export function useAssignmentStopLine(
  hostClient: HostClient | null,
  task: { readonly assignmentId: string; readonly title: string; readonly open: boolean } | null,
): ActionLineValue | null {
  return useStopLine(
    hostClient,
    task === null ? null : assignmentStopTarget(task.assignmentId, task.title),
    task === null || !task.open,
  );
}

/**
 * Asks before stopping, then stops under that review. Out of reach there is
 * nothing to review, and the tap is answered at once as not sent.
 */
export function useReviewedStop(
  hostClient: HostClient,
  target: StopTarget,
  action: ReviewedAction | null,
  onStopped?: () => void,
): {
  readonly review: ActionReview | null;
  readonly request: () => void;
  readonly dismiss: () => void;
  readonly confirm: (review: ActionReview) => void;
} {
  const { review, ask, dismiss } = useActionReview(hostClient);
  const { key, words } = target;
  const request = useCallback(() => {
    if (action === null) return;
    const stop = screenAction(hostClient, key, spec(words));
    stop.dismiss();
    if (stop.preflight() !== null) void stop.run(() => Promise.resolve(false));
    else ask(action);
    // The words are fixed per key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, ask, hostClient, key]);
  const confirm = (held: ActionReview) => {
    const stop = screenAction(hostClient, key, spec(words));
    if (stop.preflight() !== null || stop.getSnapshot().running) {
      held.cancel();
      void stop.run(() => Promise.resolve(false));
      return;
    }
    // Begun before the sheet closes, since closing ends the review.
    const result = held.confirm();
    void stop
      .run(() => result)
      .then((outcome) => {
        if (outcome.kind === "confirmed" && outcome.value) onStopped?.();
      });
  };
  return { review, request, dismiss, confirm };
}
