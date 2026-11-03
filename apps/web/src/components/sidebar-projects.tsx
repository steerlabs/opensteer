import { memo, useCallback, useState } from "react";
import { Link } from "react-router";
import {
  folderSignalWords,
  projectStatusLabel,
  taskRowLabel,
  type ProjectFolder,
  type TaskRow,
} from "@opensteer/client/host";
import { Icon } from "./icon.js";
import { WorkspaceOrb } from "./workspace-orb.js";
import { ChatOrb, TaskState } from "./workspace/task-mark.js";
import type { WorkspaceNavigation } from "./workspace/navigation.js";

const closedKey = "opensteer.sidebar-projects-closed";

/** How many of a folder's rows show before it hands the rest to the Project's page. */
export const folderRowLimit = 5;

/**
 * The Projects the reader has folded away, remembered on this device. Open is
 * the default, so a new Project's first task is never hidden; the folder only
 * lists work under way, so an idle Project costs one row either way.
 */
export function useClosedProjects(): readonly [ReadonlySet<string>, (workspaceId: string) => void] {
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(closedKey) ?? "[]");
      return new Set(Array.isArray(stored) ? stored.filter((id) => typeof id === "string") : []);
    } catch {
      return new Set();
    }
  });
  const toggle = useCallback((workspaceId: string) => {
    setClosed((current) => {
      const next = new Set(current);
      if (!next.delete(workspaceId)) next.add(workspaceId);
      try {
        localStorage.setItem(closedKey, JSON.stringify([...next]));
      } catch {
        // A fold that did not save costs one press next time.
      }
      return next;
    });
  }, []);
  return [closed, toggle];
}

/**
 * A Project as a folder: its mark and name open its page, the chevron folds
 * its rows away, and + starts a task in it. Folded, it still says the one
 * thing worth knowing about what it hides — something needs you, is working,
 * failed or is new — so closing a folder never hides an ask.
 */
export const ProjectFolderHeader = memo(function ProjectFolderHeader({
  folder,
  hiddenCount,
  holdsOpenRow,
  nav,
  onNavigate,
  onToggle,
  open,
  current,
}: {
  readonly folder: ProjectFolder;
  /** Rows folded away, counted beside the chevron. */
  readonly hiddenCount: number;
  /** A folded folder holds the conversation on screen. */
  readonly holdsOpenRow: boolean;
  readonly nav: WorkspaceNavigation;
  readonly onNavigate: () => void;
  readonly onToggle: (workspaceId: string) => void;
  readonly open: boolean;
  /** The Project's own page is the one showing. */
  readonly current: boolean;
}) {
  const { workspace, signal, needsYou } = folder;
  const foldable = folder.chat !== null || folder.rows.length > 0;
  const words = folderSignalWords(signal, needsYou);
  const path = `/workspaces/${encodeURIComponent(workspace.id)}`;
  const go = (to: string) => (event: React.MouseEvent<HTMLAnchorElement>) => {
    onNavigate();
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    nav.openConversation(to);
  };
  const classes = [
    "side-folder",
    current ? "is-filled" : "",
    holdsOpenRow && !open ? "holds-open" : "",
    workspace.status === "ready" ? "" : "is-unready",
  ];
  return (
    <li
      className={classes.filter(Boolean).join(" ")}
      data-motion-key={`folder:${workspace.id}`}
      data-workspace-id={workspace.id}
    >
      <Link
        aria-current={current ? "page" : undefined}
        aria-label={[workspace.name, words, projectStatusLabel(workspace)]
          .filter(Boolean)
          .join(" — ")}
        className="side-folder__main"
        onClick={go(path)}
        title={workspace.name}
        to={nav.conversationHref(path)}
      >
        <WorkspaceOrb
          color={workspace.color}
          icon={workspace.icon}
          name={workspace.name}
          size="tiny"
        />
        <span className="side-folder__title">{workspace.name}</span>
        {/* Open, its rows say it themselves; folded, the folder says it for them. */}
        {open && foldable ? null : <FolderSignal folder={folder} />}
      </Link>
      <Link
        aria-label={`New task in ${workspace.name}`}
        className="side-row-action side-folder__new"
        onClick={go(path)}
        title={`New task in ${workspace.name}`}
        to={nav.conversationHref(path)}
      >
        <Icon name="plus" />
      </Link>
      {foldable ? (
        <button
          aria-expanded={open}
          aria-label={`${open ? "Fold" : "Unfold"} ${workspace.name}${!open && hiddenCount > 0 ? `, ${hiddenCount} hidden` : ""}`}
          className="side-folder__toggle"
          onClick={() => onToggle(workspace.id)}
          type="button"
        >
          {/* Beside a "needs you" count, a second number would read as the same one. */}
          {!open && hiddenCount > 0 && signal !== "needs-you" ? (
            <span aria-hidden className="side-folder__count">
              {hiddenCount}
            </span>
          ) : null}
          <Icon name={open ? "chevron-down" : "chevron-right"} />
        </button>
      ) : (
        <span aria-hidden className="side-folder__toggle side-folder__toggle--empty" />
      )}
    </li>
  );
});

function FolderSignal({ folder }: { readonly folder: ProjectFolder }) {
  switch (folder.signal) {
    case "needs-you":
      return (
        <span aria-hidden className="side-needs side-needs--inline side-folder__needs">
          <span className="side-needs__bang">!</span>
          {folder.needsYou}
        </span>
      );
    case "working":
      return <TaskState state="working" />;
    case "failed":
      return <TaskState state="failed" />;
    case "unread":
      return <span aria-hidden className="task-row__unread" />;
    case null:
      return null;
  }
}

/** A Project's own chat, first in its folder. */
export const ProjectChatRow = memo(function ProjectChatRow({
  nav,
  onNavigate,
  open,
  row,
  work,
}: {
  readonly nav: WorkspaceNavigation;
  readonly onNavigate: () => void;
  readonly open: boolean;
  readonly row: TaskRow;
  readonly work: boolean;
}) {
  const path = nav.threadPath(row.threadId);
  return (
    <li
      className={[
        "side-task",
        "side-task--nested",
        `side-task--${row.tone}`,
        open ? (work ? "is-open" : "is-filled") : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-motion-key={row.threadId}
      data-thread-id={row.threadId}
    >
      <Link
        aria-current={open ? "page" : undefined}
        aria-label={taskRowLabel(row, { chat: true })}
        className="side-task__main"
        onClick={(event) => {
          onNavigate();
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
          event.preventDefault();
          nav.openConversation(path);
        }}
        to={nav.conversationHref(path)}
      >
        <ChatOrb size={20} />
        <span className="side-task__text">
          <span className="side-task__title">Chat</span>
        </span>
        <TaskState state={row.tone} unread={row.unread} />
      </Link>
    </li>
  );
});

/** The rest of a long folder, on the Project's own page. */
export function FolderMoreRow({
  count,
  nav,
  onNavigate,
  workspaceId,
}: {
  readonly count: number;
  readonly nav: WorkspaceNavigation;
  readonly onNavigate: () => void;
  readonly workspaceId: string;
}) {
  const path = `/workspaces/${encodeURIComponent(workspaceId)}`;
  return (
    <li className="side-folder-more" data-motion-key={`more:${workspaceId}`}>
      <Link
        className="side-folder-more__main"
        onClick={(event) => {
          onNavigate();
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
          event.preventDefault();
          nav.openConversation(path);
        }}
        to={nav.conversationHref(path)}
      >
        {count} more
      </Link>
    </li>
  );
}
