import { memo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Icon } from "../icon.js";
import { Popover } from "../popover.js";
import { ChatOrb, TaskMark, TaskState } from "../workspace/task-mark.js";
import { TeamTile } from "../team/team-marks.js";
import { channelLabel } from "../team/team-models.js";
import type { FolderGroupView, TaskRowView, TaskSourceView } from "./home-models.js";

/** A plain click goes through `onOpen`; a modified one keeps the link's own behaviour. */
function opener(href: string | undefined, onOpen: () => void) {
  return (event: MouseEvent<HTMLElement>) => {
    if (href && (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)) return;
    event.preventDefault();
    onOpen();
  };
}

function RowLink({
  children,
  className,
  href,
  label,
  onOpen,
  open,
  title,
}: {
  readonly children: ReactNode;
  readonly className: string;
  readonly href?: string | undefined;
  readonly label?: string | undefined;
  readonly onOpen: () => void;
  readonly open: boolean;
  readonly title?: string | undefined;
}) {
  const props = {
    "aria-current": open ? ("page" as const) : undefined,
    "aria-label": label,
    className,
    onClick: opener(href, onOpen),
    title,
  };
  return href ? (
    <a {...props} href={href}>
      {children}
    </a>
  ) : (
    <button {...props} type="button">
      {children}
    </button>
  );
}

/**
 * The sidebar's first rows: New task is the way home (Opensteer's orb, ⌘N),
 * Needs you is a real list with its amber count, Voice is its own place.
 */
export function PersonalTopRows({
  needsYou,
  onOpenNeedsYou,
  onOpenNewTask,
  onOpenVoice,
  open,
  voice,
}: {
  readonly needsYou: number;
  readonly onOpenNeedsYou: () => void;
  readonly onOpenNewTask: () => void;
  readonly onOpenVoice?: (() => void) | undefined;
  readonly open: "new-task" | "needs-you" | "voice" | null;
  /** A live call's clock, or "!" when Voice asked something; null when quiet. */
  readonly voice?: { readonly asked: boolean; readonly live: ReactNode } | null | undefined;
}) {
  const row = (key: typeof open) => ["side-home", open === key ? "is-filled" : ""].join(" ");
  return (
    <>
      <div className={row("new-task")}>
        <RowLink
          className="side-home__main"
          onOpen={onOpenNewTask}
          open={open === "new-task"}
          title="New task · ⌘N"
        >
          <ChatOrb size={20} />
          <span className="side-home__title">New task</span>
          <kbd className="side-key">⌘N</kbd>
        </RowLink>
      </div>
      <div className={row("needs-you")}>
        <RowLink
          className="side-home__main"
          label={needsYou > 0 ? `Needs you, ${needsYou}` : "Needs you"}
          onOpen={onOpenNeedsYou}
          open={open === "needs-you"}
        >
          <Icon className="side-home__glyph" name="alert-circle" />
          <span className="side-home__title side-home__title--quiet">Needs you</span>
          {needsYou > 0 ? (
            <span aria-hidden className="side-needs side-needs--inline">
              <span className="side-needs__bang">!</span>
              {needsYou}
            </span>
          ) : null}
        </RowLink>
      </div>
      {onOpenVoice ? (
        <div className={row("voice")}>
          <RowLink className="side-home__main" onOpen={onOpenVoice} open={open === "voice"}>
            <Icon className="side-home__glyph" name="waveform" />
            <span className="side-home__title side-home__title--quiet">Voice</span>
            {voice?.live ? (
              voice.live
            ) : voice?.asked ? (
              <span aria-hidden className="side-bang">
                !
              </span>
            ) : null}
          </RowLink>
        </div>
      ) : null}
    </>
  );
}

/** "A #support": the team's tile and the channel a task came from. */
export function TaskSource({
  source,
  thread = false,
}: {
  readonly source: TaskSourceView;
  /** Add whose thread it is, where there is room. */
  readonly thread?: boolean;
}) {
  return (
    <span className={source.available ? "task-source" : "task-source task-source--gone"}>
      <TeamTile size={14} tile={source.team} />
      <span className="task-source__channel">{channelLabel(source.channel)}</span>
      {!source.available ? (
        <span className="task-source__note">· no longer available</span>
      ) : thread && source.threadAuthor ? (
        <span className="task-source__note">· thread from {source.threadAuthor}</span>
      ) : null}
    </span>
  );
}

export interface FolderMenuActions {
  readonly onNewTask: (folderId: string) => void;
  readonly onCopyPath?: ((folderId: string) => void) | undefined;
  /** Only on the computer the folder is on. */
  readonly onReveal?: ((folderId: string) => void) | undefined;
  readonly onHide?: ((folderId: string) => void) | undefined;
}

/**
 * A folder's head: its name, its quiet detail (the path for Agent home, the
 * computer otherwise), + to start a task there, and the fold. Folded, it
 * keeps saying the loudest thing it holds.
 */
export const FolderHeaderRow = memo(function FolderHeaderRow({
  actions,
  group,
  onToggle,
  open,
}: {
  readonly actions: FolderMenuActions;
  readonly group: FolderGroupView;
  readonly onToggle: (folderId: string) => void;
  readonly open: boolean;
}) {
  const [menu, setMenu] = useState(false);
  const more = useRef<HTMLButtonElement | null>(null);
  const { folder } = group;
  const hidden = group.tasks.length + group.more;
  const hasMenu = actions.onCopyPath || actions.onReveal || actions.onHide;
  return (
    <li className="side-dir" data-folder-id={folder.id}>
      <button
        aria-expanded={open}
        className="side-dir__main"
        onClick={() => onToggle(folder.id)}
        title={`${folder.path} · ${folder.computerName}`}
        type="button"
      >
        <Icon className="side-dir__glyph" name={folder.agentHome ? "home" : "folder"} />
        <span className="side-dir__title">{folder.label}</span>
        {open ? (
          <span className="side-dir__detail">
            {folder.agentHome ? folder.path : folder.computerName}
          </span>
        ) : (
          <FolderSignalMark count={hidden} group={group} />
        )}
        <Icon className="side-dir__chevron" name={open ? "chevron-down" : "chevron-right"} />
      </button>
      <button
        aria-label={`New task in ${folder.label}`}
        className="side-row-action"
        onClick={() => actions.onNewTask(folder.id)}
        title={`New task in ${folder.label}`}
        type="button"
      >
        <Icon name="plus" />
      </button>
      {hasMenu ? (
        <button
          aria-expanded={menu}
          aria-haspopup="menu"
          aria-label={`${folder.label} menu`}
          className="side-row-action"
          onClick={() => setMenu((value) => !value)}
          ref={more}
          type="button"
        >
          <Icon name="more" />
        </button>
      ) : null}
      {menu && more.current ? (
        <Popover
          align="end"
          anchor={more.current}
          below
          label={folder.label}
          onClose={() => setMenu(false)}
        >
          {(
            [
              ["Copy path", actions.onCopyPath],
              ["Reveal in Finder", actions.onReveal],
              ["Hide folder", actions.onHide],
            ] as const
          ).map(([label, run]) =>
            run ? (
              <button
                className="picker__row"
                key={label}
                onClick={() => {
                  setMenu(false);
                  run(folder.id);
                }}
                role="menuitem"
                type="button"
              >
                {label}
              </button>
            ) : null,
          )}
        </Popover>
      ) : null}
    </li>
  );
});

function FolderSignalMark({
  count,
  group,
}: {
  readonly count: number;
  readonly group: FolderGroupView;
}) {
  switch (group.signal) {
    case "needs-you":
      return (
        <span aria-hidden className="side-needs side-needs--inline">
          <span className="side-needs__bang">!</span>
          {group.needsYou}
        </span>
      );
    case "working":
      return <TaskState state="working" />;
    case "failed":
      return <TaskState state="failed" />;
    case "unread":
      return <span aria-hidden className="task-row__unread" />;
    case null:
      return count > 0 ? <span className="side-dir__count">{count}</span> : null;
  }
}

/**
 * A task in the sidebar: its mark, its name, and one more line only when it
 * has something to say — the amber ask when it needs the person, or the team
 * channel it came from.
 */
export const SidebarTaskRow = memo(function SidebarTaskRow({
  href,
  onOpen,
  onSetDone,
  open,
  task,
}: {
  readonly href?: string | undefined;
  readonly onOpen: (taskId: string) => void;
  readonly onSetDone?: ((taskId: string) => void) | undefined;
  readonly open: boolean;
  readonly task: TaskRowView;
}) {
  const ask = task.tone === "needs-you" && task.ask ? task.ask : null;
  const second = ask ? (
    <span className="side-task__ask">{ask}</span>
  ) : task.source ? (
    <span className="side-task__source">
      <TaskSource source={task.source} />
    </span>
  ) : null;
  return (
    <li
      className={[
        "side-task",
        `side-task--${task.tone}`,
        open ? "is-filled" : "",
        second ? "has-ask" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-task-id={task.id}
    >
      <RowLink
        className="side-task__main"
        href={href}
        label={[task.title, task.unread ? "unread" : null, ask].filter(Boolean).join(" — ")}
        onOpen={() => onOpen(task.id)}
        open={open}
        title={ask ? `${task.title}\n${ask}` : task.title}
      >
        <TaskMark mark={task.mark} size={20} />
        <span className="side-task__text">
          <span className="side-task__title">{task.title}</span>
          {second}
        </span>
        <TaskState state={task.tone} unread={task.unread} />
      </RowLink>
      {task.canBeDone && onSetDone ? (
        <button
          aria-label={`Mark Done: ${task.title}`}
          className="side-row-action"
          onClick={() => onSetDone(task.id)}
          title="Mark Done"
          type="button"
        >
          <Icon name="check" />
        </button>
      ) : null}
    </li>
  );
});

/** The rest of a long folder. */
export function FolderMoreRow({
  count,
  onOpen,
}: {
  readonly count: number;
  readonly onOpen: () => void;
}) {
  return (
    <li>
      <button className="side-dir-more" onClick={onOpen} type="button">
        {count} more
      </button>
    </li>
  );
}

/** Done: one quiet line with its count. */
export function DoneRow({
  count,
  onOpen,
}: {
  readonly count: number;
  readonly onOpen: () => void;
}) {
  return (
    <li className="side-task side-done">
      <button className="side-task__main side-done__main" onClick={onOpen} type="button">
        <Icon name="check-circle" />
        <span className="side-task__text">Done</span>
      </button>
      <span className="side-done__count">{count}</span>
    </li>
  );
}
