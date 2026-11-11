import { useMemo, useState } from "react";
import {
  folderSignalWords,
  formatRelativeTime,
  groupTasksByProject,
  projectStatusLabel,
  taskList,
  type ProjectFolder,
  isTeamPlace,
  runtimeRowLabel,
  teamHomeEmpty,
} from "@opensteer/client/host";
import type { RuntimeState } from "@opensteer/protocol";
import { useMinuteClock } from "../ui-utils.js";
import { useShell } from "./app-shell.js";
import { Icon } from "./icon.js";
import { PageHeader, PageTopbar } from "./page-header.js";
import { useTaskSnapshot } from "./task-rows.js";
import { WorkspaceOrb } from "./workspace-orb.js";
import { AreaLink } from "./workspace/area-link.js";
import { TaskState } from "./workspace/task-mark.js";
import { OtherProjects } from "./team/other-projects.js";
import { TeamSetupChecklist } from "./team/team-setup.js";
import { TeamMark, useShellTeam } from "./team/team-ui.js";

/** Past this many, the directory offers to narrow itself by name. */
const filterFrom = 7;

/**
 * Every Project the reader belongs to, one row each: its mark and name, what
 * it is for, and the one thing worth knowing now — it needs you, it is
 * working, or it cannot take work and why. A row opens the Project.
 */
export function ProjectsPage() {
  const { hostClient, openMobileNavigation, openNewWorkspace, reportActionError } = useShell();
  const snapshot = useTaskSnapshot(hostClient);
  const now = useMinuteClock();
  const [loadingMore, setLoadingMore] = useState(false);
  const [query, setQuery] = useState("");
  const { summary } = useShellTeam();
  const team = isTeamPlace(snapshot);
  const canCreate = !team || summary?.can.createProject.allowed === true;
  // Known before the first paint from the place's own identity; the summary may follow.
  const teamName = snapshot.identityConfig?.deployment.name ?? summary?.team.name ?? null;
  const folders = useMemo(
    () => groupTasksByProject(snapshot, taskList(snapshot)).folders,
    [snapshot],
  );
  const runtimes = new Map<string, RuntimeState | undefined>(
    summary?.projects.map(({ id, runtime }) => [id, runtime]),
  );
  const empty = teamHomeEmpty({
    canCreate,
    listsOthers: summary?.can.people.allowed === true,
  });
  const needle = query.trim().toLocaleLowerCase();
  const shown = needle
    ? folders.filter(({ workspace }) =>
        `${workspace.name} ${workspace.description}`.toLocaleLowerCase().includes(needle),
      )
    : folders;
  return (
    <div className="page projects-page">
      <PageTopbar
        onOpenNavigation={openMobileNavigation}
        title={team ? (teamName ?? "Projects") : "Projects"}
      />
      <div className="page__inner">
        <div className="automations-head">
          {team ? (
            <PageHeader
              description={`Projects you can use. Each one does its work on ${teamName ?? "the team"}’s computer.`}
              title={
                <span className="team-home__title">
                  {teamName ? <TeamMark name={teamName} size="large" /> : null}
                  {teamName ?? "Projects"}
                </span>
              }
            />
          ) : (
            <PageHeader
              description="Each Project is a folder inside Main with its own chat, tasks, people and access. Agents can start work in one, or you can."
              title="Projects"
            />
          )}
          {canCreate ? (
            <div className="automations-head__actions">
              <button
                className="btn btn--primary btn--small"
                onClick={openNewWorkspace}
                type="button"
              >
                <Icon name="plus" /> New project
              </button>
            </div>
          ) : null}
        </div>

        {team ? <TeamSetupChecklist /> : null}

        {folders.length >= filterFrom ? (
          <label className="projects-page__filter">
            <Icon name="search" />
            <input
              aria-label="Find a project"
              className="text-input"
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Find a project"
              type="search"
              value={query}
            />
          </label>
        ) : null}

        {folders.length === 0 ? (
          <div className="projects-empty">
            <span aria-hidden className="projects-empty__mark">
              <Icon name="folder" />
            </span>
            <h2 className="projects-empty__title">{team ? empty.title : "No projects yet"}</h2>
            <p className="projects-empty__body">
              {team
                ? empty.body
                : "Give recurring or long-running work its own folder, chat and instructions — a launch, your finances, a client. Opensteer can also make one when work calls for it."}
            </p>
            {canCreate ? (
              <button className="btn btn--primary" onClick={openNewWorkspace} type="button">
                <Icon name="plus" /> New project
              </button>
            ) : null}
          </div>
        ) : shown.length === 0 ? (
          <p className="automations-list__empty" role="status">
            No project matches “{query.trim()}”.
          </p>
        ) : (
          <ul aria-label="Projects" className="projects-list">
            {shown.map((folder) => (
              <li key={folder.workspace.id}>
                <ProjectRow
                  folder={folder}
                  now={new Date(now)}
                  runtime={team ? runtimes.get(folder.workspace.id) : undefined}
                />
              </li>
            ))}
          </ul>
        )}

        {snapshot.workspaceWindow.hasMore ? (
          <button
            className="btn btn--ghost btn--small projects-page__more"
            disabled={loadingMore}
            onClick={() => {
              setLoadingMore(true);
              void hostClient
                .loadEarlierWorkspaces()
                .catch(reportActionError)
                .finally(() => setLoadingMore(false));
            }}
            type="button"
          >
            {loadingMore ? "Loading…" : "Show more projects"}
          </button>
        ) : null}

        {team ? <OtherProjects open={folders.length === 0} /> : null}
      </div>
    </div>
  );
}

function ProjectRow({
  folder,
  now,
  runtime,
}: {
  readonly folder: ProjectFolder;
  readonly now: Date;
  readonly runtime: RuntimeState | undefined;
}) {
  const { workspace, signal, needsYou, rows } = folder;
  // Something it needs from the reader comes first; it can't run tasks says why it is quiet.
  const problem =
    projectStatusLabel(workspace) ?? (signal === "needs-you" ? null : runtimeRowLabel(runtime));
  const working = rows.filter((row) => row.tone === "working").length;
  const state = problem ?? folderSignalWords(signal, needsYou);
  const line =
    workspace.description.trim() ||
    (rows.length > 0
      ? `${rows.length} ${rows.length === 1 ? "task" : "tasks"} open`
      : `Active ${formatRelativeTime(workspace.updatedAt, now)}`);
  return (
    <AreaLink
      aria-label={[workspace.name, state].filter(Boolean).join(" — ")}
      className={`project-row${problem ? " project-row--attention" : ""}`}
      to={`/workspaces/${encodeURIComponent(workspace.id)}`}
    >
      <WorkspaceOrb
        color={workspace.color}
        icon={workspace.icon}
        name={workspace.name}
        size="small"
      />
      <span className="project-row__body">
        <span className="project-row__name">{workspace.name}</span>
        <span className="project-row__line">{line}</span>
      </span>
      <span
        className={`project-row__state project-row__state--${problem ? "problem" : (signal ?? "idle")}`}
      >
        {problem ? (
          <>
            <Icon name="alert-circle" />
            {problem}
          </>
        ) : signal === "needs-you" ? (
          <>
            <TaskState state="needs-you" />
            {needsYou === 1 ? "Needs you" : `${needsYou} need you`}
          </>
        ) : signal === "working" ? (
          <>
            <TaskState state="working" />
            {working > 1 ? `${working} working` : "Working"}
          </>
        ) : signal === "failed" ? (
          <>
            <TaskState state="failed" />
            Couldn’t finish
          </>
        ) : signal === "unread" ? (
          <>
            <span aria-hidden className="task-row__unread" />
            New
          </>
        ) : null}
      </span>
      <Icon className="project-row__chevron" name="chevron-right" />
    </AreaLink>
  );
}
