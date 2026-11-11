import { useState } from "react";
import {
  audienceLabel,
  canDeleteProject,
  runtimeStateForUser,
  teamErrorText,
  type ProjectAccessView,
} from "@opensteer/client/host";
import { useShell } from "../app-shell.js";
import { Dialog } from "../dialog.js";
import { Icon } from "../icon.js";
import { LoadingRows } from "../loading-rows.js";
import { PageTopbar } from "../page-header.js";
import { WorkspaceOrb } from "../workspace-orb.js";
import { AreaLink, useAreaNavigate } from "../workspace/area-link.js";
import {
  ProjectAccessNotices,
  ProjectAccessSection,
  WhoCanSeeChip,
  projectUnavailable,
  useProjectAccess,
  type ProjectAccessRead,
} from "./project-access.js";
import { ProjectRuntimeSection } from "./project-runtime.js";
import { TeamError, TeamStateNotice, useShellTeam } from "./team-ui.js";

/** Who can use a shared Project and how it runs, on its settings page. */
export function TeamProjectSections({ access }: { readonly access: ProjectAccessRead }) {
  const { snapshot } = useShell();
  const { summary } = useShellTeam();
  const teamName = summary?.team.name ?? "the team";
  const [appointing, setAppointing] = useState(false);
  if (access.error && projectUnavailable(access.error))
    return <ProjectGone error={access.error} teamName={teamName} />;
  return (
    <>
      <TeamStateNotice error={access.error} team={teamName} />
      {access.data ? (
        <ProjectAccessNotices
          access={access.data}
          onAppoint={() => setAppointing(true)}
          teamName={teamName}
        />
      ) : null}
      {access.data && !access.data.can.manage.allowed ? (
        <UseOnlyRuntime access={access.data} teamName={teamName} />
      ) : null}
      <ProjectAccessSection
        access={access}
        appointing={appointing}
        onAppointDone={() => setAppointing(false)}
        teamName={teamName}
        viewerId={snapshot.user?.id ?? null}
      />
      {access.data ? <ProjectRuntimeSection access={access.data} teamName={teamName} /> : null}
      {access.data && canDeleteProject(access.data) ? (
        <TeamDeleteProject access={access.data} teamName={teamName} />
      ) : null}
    </>
  );
}

/**
 * Deleting a shared Project, offered only where the Host allows it, including
 * one that never finished setting up. It goes for everyone, with its tasks
 * and files, and the person lands on the team's Projects.
 */
function TeamDeleteProject({
  access,
  teamName,
}: {
  readonly access: ProjectAccessView;
  readonly teamName: string;
}) {
  const { team } = useShellTeam();
  const navigate = useAreaNavigate();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const name = access.project.name;
  return (
    <section aria-labelledby="team-project-delete" className="section">
      <div className="section__head">
        <h2 className="section__title" id="team-project-delete">
          Delete project
        </h2>
      </div>
      <div className="card">
        <div className="card__row">
          <span className="card__row-body">
            <span className="card__row-detail">
              Removes {name}, its tasks and its files, for everyone on it. This can’t be undone.
            </span>
          </span>
          <span className="card__row-actions">
            <button
              className="btn btn--small btn--danger"
              onClick={() => setConfirming(true)}
              type="button"
            >
              Delete…
            </button>
          </span>
        </div>
      </div>
      {confirming ? (
        <Dialog
          labelledBy="team-project-delete-title"
          onClose={() => !pending && setConfirming(false)}
          title={`Delete ${name}?`}
        >
          <p className="section__hint">
            {name}, its tasks and its files are deleted for everyone in {teamName} who uses it. This
            can’t be undone.
          </p>
          {error ? (
            <p className="notice notice--error" role="alert">
              {teamErrorText(error, teamName)}
            </p>
          ) : null}
          <div className="form-actions">
            <button
              className="btn"
              disabled={pending}
              onClick={() => setConfirming(false)}
              type="button"
            >
              Cancel
            </button>
            <button
              className="btn btn--danger"
              disabled={pending || !team}
              onClick={() => {
                if (!team) return;
                setPending(true);
                setError(null);
                void team
                  .deleteProject(access.accessRevision, access.project.id)
                  .then(() => navigate("/"))
                  .catch((reason: unknown) => {
                    setError(reason);
                    setPending(false);
                  });
              }}
              type="button"
            >
              {pending ? "Deleting…" : `Delete ${name}`}
            </button>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}

/**
 * The marker on a shared Project's own page. The snapshot's audience paints
 * with the page; a Host that doesn't send it is read after the page paints.
 */
export function TeamProjectHomeMarker({ workspaceId }: { readonly workspaceId: string }) {
  const { snapshot } = useShell();
  const { identity } = useShellTeam();
  const workspace = snapshot.workspaces.find(({ id }) => id === workspaceId);
  if (workspace?.audience)
    return (
      <AreaLink
        className="team-marker"
        title="Who can see this"
        to={`/workspaces/${encodeURIComponent(workspaceId)}/settings`}
      >
        <Icon name="users" />
        {audienceLabel(workspace.audience, workspace.name)}
      </AreaLink>
    );
  return <HomeMarker key={identity ?? ""} workspaceId={workspaceId} />;
}

function HomeMarker({ workspaceId }: { readonly workspaceId: string }) {
  const access = useProjectAccess(workspaceId);
  return <TeamProjectMarker access={access} />;
}

/** Why tasks can't run, for someone who can use but not change the Project, and who can fix it. */
function UseOnlyRuntime({
  access,
  teamName,
}: {
  readonly access: ProjectAccessView;
  readonly teamName: string;
}) {
  const state = runtimeStateForUser(access.runtime, access.managerNames, teamName);
  if (!state) return null;
  return (
    <div className="notice notice--warn team-banner" role="status">
      <Icon name="alert-circle" />
      <div>
        <strong>{access.project.name} can’t run tasks right now.</strong>
        <p>
          {state.why} {state.fix}
        </p>
      </div>
    </div>
  );
}

export function TeamProjectMarker({ access }: { readonly access: ProjectAccessRead }) {
  const { summary } = useShellTeam();
  if (!access.data || !summary) return null;
  return <WhoCanSeeChip access={access.data} teamName={summary.team.name} />;
}

function ProjectGone({ error, teamName }: { readonly error: unknown; readonly teamName: string }) {
  return (
    <div className="team-gone" role="status">
      <h2>This project isn’t available</h2>
      <TeamError error={error} team={teamName} />
      <AreaLink className="btn" to="/">
        Back to projects
      </AreaLink>
    </div>
  );
}

/**
 * A shared Project this device doesn't hold: an admin who isn't on it sees its
 * name and list but none of its work, and can add themselves.
 */
export function TeamProjectPage({ workspaceId }: { readonly workspaceId: string }) {
  const { openMobileNavigation } = useShell();
  const { summary } = useShellTeam();
  const access = useProjectAccess(workspaceId);
  const view = access.data;
  const teamName = summary?.team.name ?? "the team";
  return (
    <div className="page project-settings">
      <PageTopbar
        onOpenNavigation={openMobileNavigation}
        title={view ? view.project.name : "Project"}
      />
      <div className="page__inner">
        <header className="project-settings__head">
          <AreaLink className="page__back" to="/projects">
            <Icon name="arrow-left" />
            Projects
          </AreaLink>
          {view ? (
            <div className="project-settings__identity">
              <WorkspaceOrb color={view.project.color} name={view.project.name} size="large" />
              <div className="project-settings__identity-copy">
                <h1 className="page__title">{view.project.name}</h1>
                <p className="page__description">
                  A shared project in {teamName}.{" "}
                  {view.audience.myLevel
                    ? null
                    : "You can see who is on it, not its chats or files."}
                </p>
                <TeamProjectMarker access={access} />
              </div>
            </div>
          ) : access.error ? null : (
            <LoadingRows label="Loading project" rows={2} />
          )}
        </header>
        <TeamProjectSections access={access} />
      </div>
    </div>
  );
}
