import { useShell } from "../app-shell.js";
import { Icon } from "../icon.js";
import { PageTopbar } from "../page-header.js";
import { Navigate, NavLink } from "react-router";
import { TeamGroupPage, TeamGroupsPage } from "./team-groups.js";
import { TeamPeoplePage, TeamPersonPage } from "./team-people.js";
import { teamReasonOf, isTeamPlace } from "@opensteer/client/host";
import { TeamError, TeamMark, TeamStateNotice, useShellTeam } from "./team-ui.js";

/** The team's own group in the Settings rail, drawn only from what the Host allows. */
export function TeamSettingsNavigation() {
  const { summary } = useShellTeam();
  if (!summary || (!summary.can.people.allowed && !summary.can.groups.allowed)) return null;
  const link = (to: string, label: string) => (
    <NavLink
      className={({ isActive }) => `settings-navigation__link${isActive ? " is-active" : ""}`}
      to={to}
    >
      <Icon name={to.endsWith("people") ? "user" : "users"} />
      <span>
        <span className="settings-navigation__label">{label}</span>
      </span>
    </NavLink>
  );
  return (
    <div
      aria-labelledby="settings-navigation-team"
      className="settings-navigation__group"
      role="group"
    >
      <span
        className="settings-navigation__caption team-navigation__caption"
        id="settings-navigation-team"
      >
        <TeamMark name={summary.team.name} /> {summary.team.name}
      </span>
      {summary.can.people.allowed ? link("/settings/team/people", "People") : null}
      {summary.can.groups.allowed ? link("/settings/team/groups", "Groups") : null}
    </div>
  );
}

export function TeamSettingsRoute({
  page,
}: {
  readonly page: "people" | "person" | "groups" | "group";
}) {
  const { openMobileNavigation, snapshot } = useShell();
  const { summary, error, identity, loading, refresh } = useShellTeam();
  if (!isTeamPlace(snapshot)) return <Navigate replace to="/settings" />;
  const people = page === "people" || page === "person";
  const title = people ? "People" : "Groups";
  // The Host's answer for this person decides; until it arrives, nothing team-shaped renders.
  const can = summary ? (people ? summary.can.people : summary.can.groups) : null;
  if (can && !can.allowed) return <Navigate replace to="/settings" />;
  return (
    <div className="page settings">
      <PageTopbar onOpenNavigation={openMobileNavigation} title={title} />
      <div className="settings-content">
        <div className="settings-content__inner team-settings" key={identity ?? "signed-out"}>
          {can ? null : error ? (
            teamReasonOf(error) === "member-suspended" ||
            teamReasonOf(error) === "member-removed" ? (
              <TeamStateNotice error={error} />
            ) : (
              <TeamError error={error} onRetry={refresh} />
            )
          ) : loading ? (
            <p className="settings-footnote" role="status">
              Loading…
            </p>
          ) : null}
          {!can ? null : page === "people" ? (
            <TeamPeoplePage />
          ) : page === "person" ? (
            <TeamPersonPage />
          ) : page === "groups" ? (
            <TeamGroupsPage />
          ) : (
            <TeamGroupPage />
          )}
        </div>
      </div>
    </div>
  );
}
