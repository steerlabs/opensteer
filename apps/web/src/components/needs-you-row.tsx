import { needsYouEntryKey } from "@opensteer/client/host";
import type { NeedsYouEntry } from "@opensteer/protocol";
import { TaskMark, TaskState } from "./workspace/task-mark.js";
import { useNeedsYouOperation } from "./agent-work.js";
import { AgentMark } from "./settings/agent-mark.js";

/** One thing waiting on the person. It opens where it is answered. */
export function NeedsYouRow({
  entry,
  onOpen,
}: {
  readonly entry: NeedsYouEntry;
  readonly onOpen: () => void;
}) {
  // A connected agent's direct operation names the agent and the Home's question.
  const operation = useNeedsYouOperation(entry);
  const title = operation?.listTitle ?? entry.title;
  return (
    <li className="side-task side-task--needs-you" data-motion-key={needsYouEntryKey(entry)}>
      <button className="side-task__main" type="button" title={title} onClick={onOpen}>
        {operation ? (
          <AgentMark identity={operation.agent} />
        ) : (
          <TaskMark size={20} mark={{ icon: null, color: null }} />
        )}
        <span className="side-task__text">
          <span className="side-task__title">{title}</span>
        </span>
        <TaskState state="needs-you" />
      </button>
    </li>
  );
}
