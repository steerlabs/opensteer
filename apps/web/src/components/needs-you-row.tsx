import { isolatedPlainSentence, needsYouEntryKey } from "@opensteer/client/host";
import type { NeedsYouEntry } from "@opensteer/protocol";
import { SentenceText } from "../ui/address-text.js";
import { TaskMark, TaskState } from "./workspace/task-mark.js";
import { useNeedsYouAgentRequest } from "./agent-work.js";
import { AgentMark } from "./settings/agent-mark.js";

/** One thing waiting on the person. It opens where it is answered. */
export function NeedsYouRow({
  entry,
  onOpen,
}: {
  readonly entry: NeedsYouEntry;
  readonly onOpen: () => void;
}) {
  const agentRequest = useNeedsYouAgentRequest(entry);
  const title = agentRequest ? isolatedPlainSentence(agentRequest.listTitleParts) : entry.title;
  return (
    <li className="side-task side-task--needs-you" data-motion-key={needsYouEntryKey(entry)}>
      <button
        aria-label={agentRequest ? title : undefined}
        className="side-task__main"
        type="button"
        title={title}
        onClick={onOpen}
      >
        {agentRequest ? (
          <AgentMark identity={agentRequest.agent} />
        ) : (
          <TaskMark size={20} mark={{ icon: null, color: null }} />
        )}
        <span className="side-task__text">
          <span className="side-task__title">
            {agentRequest ? <SentenceText parts={agentRequest.listTitleParts} /> : entry.title}
          </span>
        </span>
        <TaskState state="needs-you" />
      </button>
    </li>
  );
}
