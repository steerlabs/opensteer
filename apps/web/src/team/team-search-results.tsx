import { useNavigate } from "react-router";
import { ChannelGlyph, TeamTile } from "../components/team/team-marks.js";
import { Icon } from "../components/icon.js";
import { useTeams } from "./team-attachments.js";
import { teamTile } from "./team-people.js";
import { channelPath, teamPath } from "./team-paths.js";
import { channelKind } from "./team-view-models.js";

const channelLimit = 5;

/** ⌘K's team part: channels whose names match, and a full message search in each team. */
export function TeamSearchResults({
  onNavigate,
  query,
}: {
  readonly onNavigate: () => void;
  readonly query: string;
}) {
  const { teams } = useTeams();
  const navigate = useNavigate();
  const words = query.trim().toLocaleLowerCase();
  const live = teams.filter((team) => team.client !== null);
  if (!words || live.length === 0) return null;
  const go = (path: string) => {
    onNavigate();
    void navigate(path);
  };
  return (
    <div aria-label="Teams" className="side-results__group" role="group">
      {live.map((team) => {
        const channels = (team.client!.getSnapshot().sidebar?.channels ?? [])
          .filter((row) => row.channel.name.toLocaleLowerCase().includes(words))
          .slice(0, channelLimit);
        return (
          <div key={team.teamId}>
            <div className="side-head">
              <span className="side-head__title">{team.name}</span>
            </div>
            {channels.map((row) => (
              <div className="side-task side-result" key={row.channel.id}>
                <button
                  className="side-task__main"
                  onClick={() => go(channelPath(team.teamId, row.channel.id))}
                  type="button"
                >
                  <ChannelGlyph kind={channelKind(row.channel.kind)} />
                  <span className="side-task__text">
                    <span className="side-task__title">{row.channel.name}</span>
                  </span>
                </button>
              </div>
            ))}
            <div className="side-task side-result">
              <button
                className="side-task__main"
                onClick={() =>
                  go(teamPath(team.teamId, `search?q=${encodeURIComponent(query.trim())}`))
                }
                type="button"
              >
                <TeamTile size={14} tile={teamTile(team.teamId, team.name)} />
                <span className="side-task__text">
                  <span className="side-task__title">Search messages in {team.name}</span>
                </span>
                <Icon name="arrow-right" />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
