import { Navigate } from "react-router";
import { isTeamPlace } from "@opensteer/client/host";
import { useShell } from "../app-shell.js";
import { HomeRoute, NewTaskRoute } from "../home-view.js";
import { Icon } from "../icon.js";
import { PageHeader, PageTopbar } from "../page-header.js";
import { ProjectsPage } from "../projects-page.js";
import { WorkspaceOrb } from "../workspace-orb.js";
import { AreaLink } from "../workspace/area-link.js";

/** `/`: Chat in Main on a Personal place; the Projects on a team place, which has no Main. */
export function PlaceHomeRoute() {
  const { snapshot } = useShell();
  return isTeamPlace(snapshot) ? <ProjectsPage /> : <HomeRoute />;
}

/** New task: into Main on a Personal place; on a team place, into a Project the person picks. */
export function PlaceNewTaskRoute() {
  const { snapshot } = useShell();
  return isTeamPlace(snapshot) ? <StartTaskIn /> : <NewTaskRoute />;
}

function StartTaskIn() {
  const { openMobileNavigation, snapshot } = useShell();
  const projects = snapshot.workspaces.filter(({ kind }) => kind === "project");
  if (projects.length === 0) return <Navigate replace to="/" />;
  if (projects.length === 1)
    return <Navigate replace to={`/workspaces/${encodeURIComponent(projects[0]!.id)}`} />;
  return (
    <div className="page projects-page">
      <PageTopbar onOpenNavigation={openMobileNavigation} title="New task" />
      <div className="page__inner">
        <PageHeader
          description="A task runs in a project, with its files and people."
          title="Start a task in…"
        />
        <div className="card">
          {projects.map((project) => (
            <AreaLink
              className="card__row team-person-row"
              key={project.id}
              to={`/workspaces/${encodeURIComponent(project.id)}`}
            >
              <WorkspaceOrb color={project.color} icon={project.icon} name={project.name} />
              <span className="card__row-body">
                <span className="card__row-title">{project.name}</span>
                {project.description ? (
                  <span className="card__row-detail">{project.description}</span>
                ) : null}
              </span>
              <Icon name="chevron-right" />
            </AreaLink>
          ))}
        </div>
      </div>
    </div>
  );
}
