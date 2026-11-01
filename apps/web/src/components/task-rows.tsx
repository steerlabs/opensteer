import { memo, type ReactNode } from "react";
import { NavLink } from "react-router";
import {
  sameStableHostSnapshot,
  sameTaskListSource,
  sameTaskRow,
  taskRowLabel,
  type HostClient,
  type HostSnapshot,
  type TaskRow,
  taskMark,
  taskMarkQuiet,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { conversationPath } from "../ui-utils.js";
import { Icon } from "./icon.js";
import { TaskMark, TaskState } from "./workspace/task-mark.js";
import { useOptionalWorkspace } from "./workspace/workspace-context.js";

/**
 * The reader's tasks as rows of one line: a mark for what the task is doing,
 * its title, and beside it only what the reader needs — "Needs you", where it
 * is working, a dot for something unread, when it stopped. Every row draws
 * what `taskList` says and nothing else, so the sidebar, search and a
 * specialist's page can never read differently.
 */

const selectSnapshot = (snapshot: HostSnapshot) => snapshot;

/** The page's stable chrome, and everything a task list is drawn from. */
function sameTaskSnapshot(previous: HostSnapshot, next: HostSnapshot): boolean {
  return sameStableHostSnapshot(previous, next) && sameTaskListSource(previous, next);
}

/** The snapshot task rows read, repainted whenever what a row says changes. */
export function useTaskSnapshot(hostClient: HostClient): HostSnapshot {
  return useHostSelector(hostClient, selectSnapshot, sameTaskSnapshot);
}

/** A labelled run of rows: Working, Ready, Done. */
export function TaskGroup({
  children,
  count = null,
  id,
  title,
}: {
  readonly children: ReactNode;
  readonly count?: number | null;
  readonly id: string;
  readonly title: string;
}) {
  return (
    <section aria-labelledby={id} className="task-group">
      <div className="task-group__head">
        <h2 className="task-group__title" id={id}>
          {title}
          {count === null ? null : <span className="task-group__count">{count}</span>}
        </h2>
      </div>
      <ul aria-labelledby={id} className="task-rows">
        {children}
      </ul>
    </section>
  );
}

interface TaskRowLinkProps {
  /** It sits in Done, so it reads quietly and its action takes it back. */
  readonly done: boolean;
  readonly onNavigate?: (() => void) | undefined;
  readonly onSetDone: (threadId: string, done: boolean) => void;
  readonly row: TaskRow;
  /** When it stopped, from `taskTime`, read by the list as it draws. */
  readonly time: string | null;
}

/**
 * One task on one line. A task offers Mark Done or Reopen, in place of its time while it is hovered or focused.
 */
export const TaskRowLink = memo(function TaskRowLink({
  done,
  onNavigate,
  onSetDone,
  row,
  time,
}: TaskRowLinkProps) {
  const workspace = useOptionalWorkspace();
  const classes = ["task-row", `task-row--${row.tone}`];
  if (row.unread) classes.push("task-row--unread");
  if (done) classes.push("task-row--done");
  if (row.canBeDone) classes.push("task-row--has-action");
  return (
    <div className={classes.join(" ")}>
      <NavLink
        aria-label={taskRowLabel(row)}
        className="task-row__link"
        onClick={onNavigate}
        title={row.line}
        to={
          workspace
            ? workspace.nav.conversationHref(workspace.nav.threadPath(row.threadId))
            : conversationPath(row.threadId, null)
        }
      >
        <TaskMark size={20} mark={taskMark(row)} quiet={taskMarkQuiet(row, done)} />
        <span className="task-row__text">
          <span className="task-row__title">{row.title}</span>
          {row.tone === "needs-you" ? <span className="task-row__ask">{row.line}</span> : null}
        </span>
        <TaskState state={row.tone} unread={row.unread} />
        {time === null ? null : <span className="task-row__time">{time}</span>}
      </NavLink>
      {row.canBeDone ? (
        <button
          aria-label={`${row.done ? "Reopen" : "Mark Done"}: ${row.title}`}
          className="row-action"
          onClick={() => onSetDone(row.threadId, !row.done)}
          title={row.done ? "Reopen" : "Mark Done"}
          type="button"
        >
          <Icon name={row.done ? "undo" : "check"} />
        </button>
      ) : null}
    </div>
  );
}, sameTaskRowLinkProps);

/**
 * Rows are rebuilt from the task list on every change a list hears, so a row
 * redraws only when something it shows does.
 */
function sameTaskRowLinkProps(left: TaskRowLinkProps, right: TaskRowLinkProps): boolean {
  return (
    left.done === right.done &&
    left.onNavigate === right.onNavigate &&
    left.onSetDone === right.onSetDone &&
    left.time === right.time &&
    sameTaskRow(left.row, right.row)
  );
}
