import { teamAskerLabel } from "@opensteer/client/team";
import { needsYouEntryKey } from "@opensteer/client/host";
import type { NeedsYouEntry } from "@opensteer/protocol";
import { TaskMark, TaskState } from "./workspace/task-mark.js";

/**
 * One thing waiting on the person. It opens where it is answered; an ask that
 * never became a task has nowhere to open, so it says why and can be dismissed.
 */
export function NeedsYouRow({
  dismissing = false,
  entry,
  onDismiss,
  onOpen,
}: {
  readonly dismissing?: boolean;
  readonly entry: NeedsYouEntry;
  readonly onDismiss?: (() => void) | undefined;
  readonly onOpen?: (() => void) | undefined;
}) {
  const title =
    entry.kind === "team-ask"
      ? `${teamAskerLabel(entry.presentation.asker)} · #${entry.presentation.audience.channelName}`
      : entry.title;
  const text = (
    <>
      <TaskMark size={20} mark={{ icon: null, color: null }} />
      <span className="side-task__text">
        <span className="side-task__title">{title}</span>
        {entry.kind === "team-ask" && entry.failureReason ? (
          <span className="side-task__ask">{entry.failureReason}</span>
        ) : null}
      </span>
    </>
  );
  return (
    <li className="side-task side-task--needs-you" data-motion-key={needsYouEntryKey(entry)}>
      {onOpen ? (
        <button className="side-task__main" type="button" title={title} onClick={onOpen}>
          {text}
          <TaskState state="needs-you" />
        </button>
      ) : (
        <div className="side-task__main" title={title}>
          {text}
          {onDismiss ? (
            <button
              aria-label={`Dismiss ${title}`}
              className="btn btn--small btn--ghost"
              disabled={dismissing}
              onClick={onDismiss}
              type="button"
            >
              {dismissing ? "Dismissing…" : "Dismiss"}
            </button>
          ) : null}
        </div>
      )}
    </li>
  );
}
