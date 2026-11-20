import { teamAskerLabel } from "@opensteer/client/team";
import { needsYouEntryKey } from "@opensteer/client/host";
import type { NeedsYouEntry } from "@opensteer/protocol";
import { TaskMark, TaskState } from "./workspace/task-mark.js";
import { useNeedsYouOperation } from "./agent-work.js";
import { AgentMark } from "./settings/agent-mark.js";

/**
 * One thing waiting on the person. It opens where it is answered. A failed
 * ask says why and can be dismissed, which declines it, and still opens the
 * task it left behind; one that never became a task has nowhere to open.
 */
export function NeedsYouRow({
  dismissing = false,
  entry,
  onDismiss,
  onOpen,
}: {
  readonly dismissing?: boolean;
  readonly entry: NeedsYouEntry;
  readonly onDismiss: () => void;
  readonly onOpen: () => void;
}) {
  // A connected agent's direct operation names the agent and the Home's question.
  const operation = useNeedsYouOperation(entry);
  const title =
    entry.kind === "team-ask"
      ? `${teamAskerLabel(entry.presentation.asker)} · #${entry.presentation.audience.channelName}`
      : (operation?.listTitle ?? entry.title);
  const opens = entry.kind === "request" || entry.task !== undefined;
  const dismissible = entry.kind === "team-ask" && (entry.failureReason !== undefined || !opens);
  const text = (
    <>
      {operation ? (
        <AgentMark identity={operation.agent} />
      ) : (
        <TaskMark size={20} mark={{ icon: null, color: null }} />
      )}
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
      {opens ? (
        <button className="side-task__main" type="button" title={title} onClick={onOpen}>
          {text}
          <TaskState state="needs-you" />
        </button>
      ) : (
        <div className="side-task__main" title={title}>
          {text}
        </div>
      )}
      {dismissible ? (
        <button
          aria-label={`Dismiss ${title}`}
          className="btn btn--small btn--ghost side-task__dismiss"
          disabled={dismissing}
          onClick={onDismiss}
          type="button"
        >
          {dismissing ? "Dismissing…" : "Dismiss"}
        </button>
      ) : null}
    </li>
  );
}
