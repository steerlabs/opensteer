import { useState } from "react";
import { otherProjectLine } from "@opensteer/client/host";
import { usePagedList } from "@opensteer/client/react";
import { Icon } from "../icon.js";
import { WorkspaceOrb } from "../workspace-orb.js";
import { AreaLink } from "../workspace/area-link.js";
import { ShowMore, TeamError, useShellTeam } from "./team-ui.js";

/**
 * An administrator's names-only list of the team's Projects they aren't on.
 * Adding oneself happens on the Project's own page, where it is confirmed and
 * audited. Open when the reader is on no Project; folded otherwise.
 */
export function OtherProjects({ open: openFirst }: { readonly open: boolean }) {
  const { team, summary, identity, generation } = useShellTeam();
  const [open, setOpen] = useState(openFirst);
  // The read is an administrator's; nothing is asked unless the Host lets this person see people.
  const allowed = summary?.can.people.allowed === true;
  const list = usePagedList(
    team && allowed && open
      ? (cursor: string | null) => team.projects({ limit: 50, ...(cursor ? { cursor } : {}) })
      : null,
    `team-projects:${identity}:${generation}`,
  );
  if (!summary || !allowed) return null;
  const teamName = summary.team.name;
  const others = list.items.filter(({ myLevel }) => myLevel === null);
  if (!open)
    return (
      <button
        className="btn btn--ghost btn--small team-others__toggle"
        onClick={() => setOpen(true)}
        type="button"
      >
        Other projects in {teamName}
        <Icon name="chevron-down" />
      </button>
    );
  return (
    <section aria-labelledby="team-others" className="team-others">
      <h2 className="team-others__title" id="team-others">
        Other projects in {teamName}
      </h2>
      <p className="team-others__lead">
        You can see their names and who is on them. Add yourself to see their work; their managers
        are told.
      </p>
      <TeamError error={list.error} team={teamName} />
      {list.first && others.length === 0 && !list.nextCursor ? (
        <p className="automations-list__empty">You’re on every project in {teamName}.</p>
      ) : (
        <ul aria-label={`Other projects in ${teamName}`} className="projects-list">
          {others.map((project) => (
            <li className="team-others__row" key={project.id}>
              <AreaLink
                className="project-row"
                to={`/workspaces/${encodeURIComponent(project.id)}/settings`}
              >
                <WorkspaceOrb color={project.color} name={project.name} size="small" />
                <span className="project-row__body">
                  <span className="project-row__name">{project.name}</span>
                  <span className="project-row__line">{otherProjectLine(project)}</span>
                </span>
                <span className="btn btn--small team-others__add">Add myself…</span>
              </AreaLink>
            </li>
          ))}
        </ul>
      )}
      <ShowMore list={list} team={teamName} />
    </section>
  );
}
