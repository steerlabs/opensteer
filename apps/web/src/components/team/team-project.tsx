import { useState } from "react";
import { useShell } from "../app-shell.js";
import { Icon } from "../icon.js";
import { LoadingRows } from "../loading-rows.js";
import { PageTopbar } from "../page-header.js";
import { WorkspaceOrb } from "../workspace-orb.js";
import { AreaLink } from "../workspace/area-link.js";
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
      <ProjectAccessSection
        access={access}
        appointing={appointing}
        onAppointDone={() => setAppointing(false)}
        teamName={teamName}
        viewerId={snapshot.user?.id ?? null}
      />
      {access.data ? <ProjectRuntimeSection access={access.data} teamName={teamName} /> : null}
    </>
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
        Back to Chat
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
