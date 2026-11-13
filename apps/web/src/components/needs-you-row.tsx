import { needsYouEntryKey } from "@opensteer/client/host";
import type { NeedsYouEntry } from "@opensteer/protocol";
import { TaskMark, TaskState } from "./workspace/task-mark.js";

export function NeedsYouRow({
  entry,
  onOpen,
}: {
  readonly entry: NeedsYouEntry;
  readonly onOpen: () => void;
}) {
  const title =
    entry.kind === "team-ask"
      ? `${entry.presentation.asker.displayName}${entry.presentation.asker.actor === "agent" ? "'s agent" : ""} · #${entry.presentation.audience.channelName}`
      : entry.title;
  return (
    <li className="side-task side-task--needs-you" data-motion-key={needsYouEntryKey(entry)}>
      <button className="side-task__main" type="button" title={title} onClick={onOpen}>
        <TaskMark size={20} mark={{ icon: null, color: null }} />
        <span className="side-task__text">
          <span className="side-task__title">{title}</span>
        </span>
        <TaskState state="needs-you" />
      </button>
    </li>
  );
}
