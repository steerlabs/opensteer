import { NavLink } from "react-router";
import { Icon } from "../components/icon.js";
import { useTeams } from "./team-attachments.js";

/** Settings gets one group per team this computer joined, then a way to join another. */
export function TeamSettingsNavigation() {
  const { surface, teams } = useTeams();
  if (surface === "team-web") return null;
  return (
    <div
      aria-labelledby="settings-navigation-teams"
      className="settings-navigation__group"
      role="group"
    >
      <span className="settings-navigation__caption" id="settings-navigation-teams">
        Teams
      </span>
      {teams.map((team) => (
        <NavLink
          className={({ isActive }) => `settings-navigation__link${isActive ? " is-active" : ""}`}
          key={team.teamId}
          to={`/settings/teams/${encodeURIComponent(team.teamId)}/profile`}
        >
          <Icon name="users" />
          <span>
            <span className="settings-navigation__label">{team.name}</span>
          </span>
        </NavLink>
      ))}
      <NavLink
        className={({ isActive }) => `settings-navigation__link${isActive ? " is-active" : ""}`}
        to="/join"
      >
        <Icon name="plus" />
        <span>
          <span className="settings-navigation__label">Join a team</span>
        </span>
      </NavLink>
    </div>
  );
}
