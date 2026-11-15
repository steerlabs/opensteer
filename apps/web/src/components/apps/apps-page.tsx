import { useState, type FormEvent } from "react";
import {
  threadInDirectory,
  threadMark,
  type AppAction,
  type HostSnapshot,
} from "@opensteer/client/host";
import { useAppsList, useHostSelector } from "@opensteer/client/react";
import type { App } from "@opensteer/core";
import { useShell } from "../app-shell.js";
import { Dialog } from "../dialog.js";
import { Icon } from "../icon.js";
import { LoadingRows } from "../loading-rows.js";
import { PageTopbar } from "../page-header.js";
import { AreaLink } from "../workspace/area-link.js";
import { taskPath } from "../workspace/navigation.js";
import { TaskMark } from "../workspace/task-mark.js";
import { useOptionalWorkspace } from "../workspace/workspace-context.js";

const stateWords: Record<App["state"], { readonly label: string; readonly tone: string }> = {
  running: { label: "Running", tone: "ok" },
  stopped: { label: "Stopped", tone: "muted" },
  failed: { label: "Failed", tone: "bad" },
  offline: { label: "Computer offline", tone: "warn" },
};
const pendingWords: Record<AppAction, string> = {
  open: "Opening…",
  rename: "Renaming…",
  start: "Starting…",
  stop: "Stopping…",
  delete: "Deleting…",
};

/**
 * Every app the person published, whichever chat made it: what it is, where
 * it runs and whether it runs now. Open shows it as a tab; Start and Stop run
 * a server on its own computer; Delete stops it and removes it, keeping its
 * folder. The list is read only while this page is shown.
 */
export function AppsPage() {
  const { hostClient, openMobileNavigation } = useShell();
  const { list, state } = useAppsList(hostClient);
  const [deleting, setDeleting] = useState<App | null>(null);
  const apps = state.apps;
  return (
    <div className="page">
      <PageTopbar onOpenNavigation={openMobileNavigation} title="Apps" />
      <div className="page__inner automations-page apps-page">
        <header className="automations-head">
          <h1 className="page__title">Apps</h1>
        </header>
        {state.error ? (
          <p aria-live="assertive" className="notice notice--error" role="alert">
            <Icon name="alert-circle" />
            <span>{state.error}</span>
            <button className="btn btn--small" onClick={() => void list.reload()} type="button">
              Try again
            </button>
          </p>
        ) : null}
        {apps === null && !state.error ? (
          <div className="automations-list">
            <LoadingRows label="Loading apps" />
          </div>
        ) : null}
        {apps?.length === 0 ? (
          <div className="automations-list">
            <p className="automations-list__empty">
              No apps yet. Ask your agent to build one, and it appears here.
            </p>
          </div>
        ) : null}
        {apps && apps.length > 0 ? (
          <div className="automations-list apps-list">
            {apps.map((app) => (
              <AppRow app={app} key={app.appId} onDelete={() => setDeleting(app)} />
            ))}
          </div>
        ) : null}
      </div>
      {deleting ? (
        <Dialog
          footer={
            <>
              <button className="btn" onClick={() => setDeleting(null)} type="button">
                Cancel
              </button>
              <button
                className="btn btn--danger"
                onClick={() => {
                  void list.delete(deleting.appId);
                  setDeleting(null);
                }}
                type="button"
              >
                Delete app
              </button>
            </>
          }
          labelledBy="app-delete-title"
          onClose={() => setDeleting(null)}
          title={`Delete ${deleting.name}?`}
        >
          <p className="browser-dialog__message">
            {deleting.kind === "server"
              ? "Its server stops and its tab closes."
              : "Its tab closes."}{" "}
            Its folder and data stay on its computer.
          </p>
        </Dialog>
      ) : null}
    </div>
  );
}

function AppRow({ app, onDelete }: { readonly app: App; readonly onDelete: () => void }) {
  const { hostClient } = useShell();
  const workspace = useOptionalWorkspace();
  const { list, state } = useAppsList(hostClient);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(app.name);
  const computer = useHostSelector(
    hostClient,
    (snapshot) => snapshot.machines.find((machine) => machine.id === app.computerId)?.name ?? null,
  );
  const origin = useHostSelector(hostClient, (snapshot) => originOf(snapshot, app.taskId));
  const pending = state.pending.get(app.appId) ?? null;
  const failure = state.failures.get(app.appId) ?? null;
  const words = stateWords[app.state];
  const server = app.kind === "server";
  const open = () => {
    if (!workspace) return;
    const show = workspace.nav.beginPlaceOperation();
    void list.track(app.appId, "open", async () => {
      const tab = await hostClient.openTab({ kind: "app", appId: app.appId });
      show({ kind: "tab", tabId: tab.tabId });
    });
  };
  const rename = (event: FormEvent) => {
    event.preventDefault();
    const next = name.trim();
    setRenaming(false);
    if (next && next !== app.name) void list.rename(app.appId, next);
    else setName(app.name);
  };
  return (
    <div className="automation-row app-row" data-app-id={app.appId}>
      <span className="automation-row__glyph">
        <Icon name="app" />
      </span>
      <span className="automation-row__body">
        {renaming ? (
          <form className="app-row__rename" onSubmit={rename}>
            <input
              aria-label="App name"
              autoFocus
              maxLength={160}
              onBlur={rename}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setName(app.name);
                  setRenaming(false);
                }
              }}
              value={name}
            />
          </form>
        ) : (
          <span className="automation-row__name">{app.name}</span>
        )}
        <span className="automation-row__line">
          <span>{server ? "Server" : "HTML page"}</span>
          {computer ? <span>{computer}</span> : null}
          {origin === null ? (
            <span className="app-row__origin app-row__origin--gone">Chat deleted</span>
          ) : (
            <span className="automation-row__where">
              <AreaLink to={taskPath(origin.threadId)}>
                <TaskMark mark={origin.mark} size={16} />
                {origin.title}
              </AreaLink>
            </span>
          )}
        </span>
        {failure ? (
          <span className="app-row__failure" role="alert">
            {failure.message}
            <button
              aria-label="Dismiss"
              className="icon-btn"
              onClick={() => list.dismissFailure(app.appId)}
              type="button"
            >
              <Icon name="close" />
            </button>
          </span>
        ) : null}
      </span>
      <span className="app-row__side">
        <span className={`chip chip--${words.tone}`}>
          {pending ? pendingWords[pending] : words.label}
        </span>
        <span className="app-row__actions">
          <button
            className="btn btn--small"
            disabled={pending !== null || !workspace}
            onClick={open}
            type="button"
          >
            Open
          </button>
          {server ? (
            app.server?.desiredState === "running" && app.state !== "failed" ? (
              <button
                className="btn btn--small"
                disabled={pending !== null}
                onClick={() => void list.stop(app.appId)}
                type="button"
              >
                Stop
              </button>
            ) : (
              <button
                className="btn btn--small"
                disabled={pending !== null}
                onClick={() => void list.start(app.appId)}
                type="button"
              >
                Start
              </button>
            )
          ) : null}
          <button
            aria-label={`Rename ${app.name}`}
            className="icon-btn"
            disabled={pending !== null}
            onClick={() => {
              setName(app.name);
              setRenaming(true);
            }}
            title="Rename"
            type="button"
          >
            <Icon name="pencil" />
          </button>
          <button
            aria-label={`Delete ${app.name}`}
            className="icon-btn"
            disabled={pending !== null}
            onClick={onDelete}
            title="Delete"
            type="button"
          >
            <Icon name="trash" />
          </button>
        </span>
      </span>
    </div>
  );
}

/** The chat that published an app, while it exists; null once it was deleted. */
function originOf(
  snapshot: HostSnapshot,
  threadId: string | null,
): {
  readonly threadId: string;
  readonly title: string;
  readonly mark: ReturnType<typeof threadMark>;
} | null {
  if (threadId === null) return null;
  const thread = threadInDirectory(threadId, snapshot);
  return {
    threadId,
    title: thread?.title.trim() || "Chat",
    mark: threadMark(threadId, snapshot),
  };
}
