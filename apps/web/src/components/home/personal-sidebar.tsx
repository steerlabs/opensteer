import { TeamTile } from "../team/team-marks.js";
import { channelLabel } from "../team/team-models.js";
import type { TaskSourceView } from "./home-models.js";

/** "A #support": the team's tile and the channel a task came from. */
export function TaskSource({
  source,
  thread = false,
}: {
  readonly source: TaskSourceView;
  /** Add whose thread it is, where there is room. */
  readonly thread?: boolean;
}) {
  return (
    <span className={source.available ? "task-source" : "task-source task-source--gone"}>
      <TeamTile size={14} tile={source.team} />
      <span className="task-source__channel">{channelLabel(source.channel)}</span>
      {!source.available ? (
        <span className="task-source__note">· no longer available</span>
      ) : thread && source.threadAuthor ? (
        <span className="task-source__note">· thread from {source.threadAuthor}</span>
      ) : null}
    </span>
  );
}
