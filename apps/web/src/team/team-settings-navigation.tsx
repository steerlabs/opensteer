import { NavLink } from "react-router";
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
          {team.name}
        </NavLink>
      ))}
      <NavLink
        className={({ isActive }) => `settings-navigation__link${isActive ? " is-active" : ""}`}
        to="/teams"
      >
        Create or join a team
      </NavLink>
    </div>
  );
}
