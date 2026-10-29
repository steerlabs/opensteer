import { TaskState } from "./workspace/task-mark.js";
import { useMemo, useState } from "react";
import { taskList, type TaskRow, type WorkspaceSummary } from "@opensteer/client/host";
import { useShell } from "./app-shell.js";
import { Icon } from "./icon.js";
import { PageHeader, PageTopbar } from "./page-header.js";
import { useTaskSnapshot } from "./task-rows.js";
import { WorkspaceOrb } from "./workspace-orb.js";
import { AreaLink } from "./workspace/area-link.js";

/**
 * Every specialist the reader belongs to, each with one line saying whether
 * its tasks need them, are working, or are idle, with the sidebar's mark. A card opens the specialist;
 * the last one starts a new one.
 */
export function SpecialistsPage() {
  const { hostClient, openMobileNavigation, openNewWorkspace, reportActionError } = useShell();
  const snapshot = useTaskSnapshot(hostClient);
  const [loadingMore, setLoadingMore] = useState(false);
  const working = useMemo(() => taskList(snapshot).working, [snapshot]);
  const specialists = snapshot.workspaces.filter((workspace) => workspace.kind === "specialized");
  return (
    <div className="page specialists-page">
      <PageTopbar onOpenNavigation={openMobileNavigation} title="Specialists" />
      <div className="page__inner">
        <PageHeader
          description="A specialist is Opensteer set up for one kind of work, with its own instructions, files and accounts. Give one a task, or let Opensteer hand work to it."
          title="Specialists"
        />
        <ul className="specialist-cards">
          {specialists.map((workspace) => (
            <li key={workspace.id}>
              <SpecialistCard
                rows={working.filter((row) => row.workspaceId === workspace.id)}
                workspace={workspace}
              />
            </li>
          ))}
          <li>
            <button
              className="specialist-card specialist-card--new"
              onClick={openNewWorkspace}
              type="button"
            >
              <Icon name="plus" />
              New specialist
            </button>
          </li>
        </ul>
        {snapshot.workspaceWindow.hasMore ? (
          <button
            className="btn btn--ghost btn--small specialists-page__more"
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
            {loadingMore ? "Loading…" : "Show more"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function SpecialistCard({
  rows,
  workspace,
}: {
  /** The specialist's work under way, as the task list reads it. */
  readonly rows: readonly TaskRow[];
  readonly workspace: WorkspaceSummary;
}) {
  const state = rows.some((row) => row.tone === "needs-you")
    ? "needs-you"
    : rows.some((row) => row.tone === "working")
      ? "working"
      : null;
  return (
    <AreaLink className="specialist-card" to={`/workspaces/${encodeURIComponent(workspace.id)}`}>
      <WorkspaceOrb
        icon={workspace.icon}
        name={workspace.name}
        size="large"
        color={workspace.color}
      />
      <span className="specialist-card__name">{workspace.name}</span>
      {workspace.description ? (
        <span className="specialist-card__about">{workspace.description}</span>
      ) : null}
      <span className={`specialist-card__state specialist-card__state--${state ?? "idle"}`}>
        {state === null ? null : <TaskState state={state} />}
        {state === "needs-you" ? "Needs you" : state === "working" ? "Working" : "Nothing running"}
      </span>
    </AreaLink>
  );
}
