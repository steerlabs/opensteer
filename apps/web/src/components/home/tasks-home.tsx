import { useRef, type ReactNode } from "react";
import { TaskMark, TaskState } from "../workspace/task-mark.js";
import { useWindowedRows } from "../workspace/windowed-rows.js";
import { age } from "../team/team-time.js";
import type { NeedsYouItemView, TaskRowView } from "./home-models.js";
import { NeedsYouCard, type NeedsYouActions } from "./needs-you.js";
import { TaskSource } from "./personal-sidebar.js";

/** What a first ask can be, to fill the draft (never to send it). */
export const firstRunSuggestions = [
  "Find a flight to Kyoto in mid-March under $1,200 and hold the best two options",
  "Clean up my Downloads folder: sort by type, bin installers older than a month",
  "Read my last 20 emails from school and list every date I need to remember",
  "Set up a small website for my photos in a new folder",
] as const;

/**
 * Home: what should your agent do, and the composer that starts it. The live
 * tasks are in the sidebar; everything else is on All tasks.
 */
export function TasksHome({
  composer,
  firstRun,
  header,
  needsAccount = false,
  onConnectAccount,
  onSuggestion,
}: {
  /** The new-task composer, its folder chip in the leading slot. */
  readonly composer: ReactNode;
  /** No task yet: a line about where the agent works, and a few asks to start from. */
  readonly firstRun: boolean;
  readonly header?: ReactNode;
  /** No AI account is connected yet. */
  readonly needsAccount?: boolean;
  readonly onConnectAccount?: (() => void) | undefined;
  readonly onSuggestion: (text: string) => void;
}) {
  return (
    <div className={firstRun ? "thread tasks-home tasks-home--first" : "thread tasks-home"}>
      {header}
      <div className="tasks-home__scroll">
        <div className="tasks-home__inner">
          <div className="tasks-home__hero">
            <h1 className="hero__title">What should your agent do?</h1>
            {firstRun ? (
              <p className="hero__subtitle">
                Your agent works on this computer, in folders you choose.
                {needsAccount ? (
                  <>
                    {" "}
                    <button className="tasks-home__link" onClick={onConnectAccount} type="button">
                      Connect an AI account
                    </button>{" "}
                    to start.
                  </>
                ) : null}
              </p>
            ) : null}
          </div>
          {composer}
          {firstRun ? (
            <div className="hero__suggestions">
              {firstRunSuggestions.map((text) => (
                <button
                  className="hero__suggestion"
                  key={text}
                  onClick={() => onSuggestion(text)}
                  type="button"
                >
                  {text}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export type AllTasksFilterView = "all" | "needs-you" | "running" | "unread" | "read" | "done";

const filterWords: readonly (readonly [AllTasksFilterView, string])[] = [
  ["all", "All"],
  ["needs-you", "Needs you"],
  ["running", "Running"],
  ["unread", "Unread"],
  ["read", "Read"],
  ["done", "Done"],
];

const emptyWords: Readonly<Record<AllTasksFilterView, string>> = {
  all: "Tasks you start show up here.",
  "needs-you": "Nothing needs you",
  running: "Nothing is running.",
  unread: "No new results.",
  read: "No read results waiting to be marked Done.",
  done: "Nothing in Done yet.",
};

export interface AllTasksActions extends NeedsYouActions {
  readonly onFilter: (filter: AllTasksFilterView) => void;
  readonly taskHref?: ((taskId: string) => string) | undefined;
  readonly onLoadMore?: (() => void) | undefined;
}

/**
 * Every task, open until it is Done, with a chip per question a person asks
 * of the list. Needs you shows each ask with its controls.
 */
export function AllTasksPage({
  actions,
  counts,
  filter,
  header,
  loadingMore = false,
  needsYou,
  pending = null,
  rows,
}: {
  readonly actions: AllTasksActions;
  readonly counts: Readonly<Partial<Record<AllTasksFilterView, number>>>;
  readonly filter: AllTasksFilterView;
  readonly header?: ReactNode;
  readonly loadingMore?: boolean;
  readonly needsYou: readonly NeedsYouItemView[];
  /** The ask whose answer is on its way. */
  readonly pending?: string | null;
  readonly rows: readonly TaskRowView[];
}) {
  const list = useRef<HTMLUListElement | null>(null);
  const keys = rows.map((row) => row.id);
  const plan = useWindowedRows({ list, keys, estimate: () => 52, pinned: [], all: false });
  return (
    <div className="thread all-tasks">
      {header}
      <div aria-label="Filter tasks" className="all-tasks__chips" role="group">
        {filterWords.map(([value, label]) => (
          <button
            aria-pressed={filter === value}
            className={value === "needs-you" ? "chip chip--needs" : "chip"}
            key={value}
            onClick={() => actions.onFilter(value)}
            type="button"
          >
            {label}
            {counts[value] ? <span className="chip__count">{counts[value]}</span> : null}
          </button>
        ))}
      </div>
      {filter === "needs-you" ? (
        needsYou.length === 0 ? (
          <p className="all-tasks__empty">{emptyWords[filter]}</p>
        ) : (
          <ul aria-label="Needs you" className="needs-you-list all-tasks__list">
            {needsYou.map((item) => (
              <li key={item.id}>
                <NeedsYouCard actions={actions} item={item} pending={pending === item.id} />
              </li>
            ))}
          </ul>
        )
      ) : rows.length === 0 ? (
        <p className="all-tasks__empty">{emptyWords[filter]}</p>
      ) : (
        <ul aria-label="Tasks" className="home-tasks all-tasks__list" ref={list}>
          {plan.map((item) => {
            if ("spacer" in item)
              return (
                <li aria-hidden key={`spacer:${item.spacer}`} style={{ height: item.spacer }} />
              );
            const row = rows[item.index]!;
            return (
              <li data-motion-key={row.id} key={row.id}>
                <AllTasksRow actions={actions} task={row} />
              </li>
            );
          })}
        </ul>
      )}
      {actions.onLoadMore ? (
        <button
          className="sidebar__more"
          disabled={loadingMore}
          onClick={actions.onLoadMore}
          type="button"
        >
          {loadingMore ? "Loading…" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

/** A task on All tasks: where it came from or works, what it is doing, and when. */
function AllTasksRow({
  actions,
  task,
}: {
  readonly actions: AllTasksActions;
  readonly task: TaskRowView;
}) {
  const href = actions.taskHref?.(task.id);
  const needs = task.tone === "needs-you" && task.ask;
  const body = (
    <>
      <TaskMark mark={task.mark} size={22} />
      <span className="home-task__text">
        <span className="home-task__title">{task.title}</span>
        <span className="home-task__line">
          {task.source ? (
            <TaskSource source={task.source} thread />
          ) : task.folder ? (
            <span className="home-task__folder">{task.folder}</span>
          ) : null}
          {needs ? (
            <span className="home-task__ask">{task.ask}</span>
          ) : task.status ? (
            <span className="home-task__status">{task.status}</span>
          ) : null}
        </span>
      </span>
      <TaskState state={task.tone} unread={task.unread} />
      <time className="home-task__age" dateTime={task.updatedAt}>
        {age(task.updatedAt)}
      </time>
    </>
  );
  const open = (event: React.MouseEvent<HTMLElement>) => {
    if (href && (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)) return;
    event.preventDefault();
    actions.onOpenTask(task.id);
  };
  return href ? (
    <a className={`home-task home-task--${task.tone}`} href={href} onClick={open}>
      {body}
    </a>
  ) : (
    <button className={`home-task home-task--${task.tone}`} onClick={open} type="button">
      {body}
    </button>
  );
}
