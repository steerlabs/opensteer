import type { ReactNode } from "react";
import { Icon } from "../icon.js";
import { TaskMark, TaskState } from "../workspace/task-mark.js";
import { age } from "../team/team-time.js";
import type { FolderGroupView, NeedsYouItemView, TaskRowView } from "./home-models.js";
import { NeedsYouCard, type NeedsYouActions } from "./needs-you.js";
import { TaskSource } from "./personal-sidebar.js";

/** What a first ask can be, to fill the draft (never to send it). */
export const firstRunSuggestions = [
  "Find a flight to Kyoto in mid-March under $1,200 and hold the best two options",
  "Clean up my Downloads folder: sort by type, bin installers older than a month",
  "Read my last 20 emails from school and list every date I need to remember",
  "Set up a small website for my photos in a new folder",
] as const;

const needsYouPreview = 2;

export interface TasksHomeActions extends NeedsYouActions {
  readonly onOpenNeedsYou: () => void;
  readonly onNewTaskIn: (folderId: string) => void;
  readonly onOpenDone: () => void;
  readonly onSuggestion: (text: string) => void;
  readonly onConnectAccount?: (() => void) | undefined;
  readonly taskHref?: ((taskId: string) => string) | undefined;
}

/**
 * The landing screen on every surface: what should your agent do, the
 * composer that starts it, what waits on you, then every task by folder with
 * Agent home first. Any ask becomes a task with its own title.
 */
export function TasksHome({
  actions,
  composer,
  doneCount,
  folders,
  header,
  needsAccount = false,
  needsYou,
}: {
  readonly actions: TasksHomeActions;
  /** The new-task composer, its folder chip in the leading slot. */
  readonly composer: ReactNode;
  readonly doneCount: number;
  readonly folders: readonly FolderGroupView[];
  readonly header?: ReactNode;
  /** No AI account is connected yet. */
  readonly needsAccount?: boolean;
  readonly needsYou: readonly NeedsYouItemView[];
}) {
  const tasks = folders.reduce((sum, group) => sum + group.tasks.length, 0);
  const firstRun = tasks === 0 && doneCount === 0 && needsYou.length === 0;
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
                    <button
                      className="tasks-home__link"
                      onClick={actions.onConnectAccount}
                      type="button"
                    >
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
                  onClick={() => actions.onSuggestion(text)}
                  type="button"
                >
                  {text}
                </button>
              ))}
            </div>
          ) : null}
          {needsYou.length > 0 ? (
            <section aria-labelledby="home-needs-you" className="home-section">
              <header className="home-section__head">
                <h2 className="home-section__title" id="home-needs-you">
                  Needs you <span className="home-section__count">{needsYou.length}</span>
                </h2>
                <button
                  className="home-section__more"
                  onClick={actions.onOpenNeedsYou}
                  type="button"
                >
                  See all
                </button>
              </header>
              <ul className="home-needs">
                {needsYou.slice(0, needsYouPreview).map((item) => (
                  <li key={item.id}>
                    <NeedsYouCard actions={actions} compact item={item} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {folders.map((group) => (
            <FolderSection actions={actions} group={group} key={group.folder.id} />
          ))}
          {doneCount > 0 ? (
            <button className="home-done" onClick={actions.onOpenDone} type="button">
              <Icon name="check-circle" />
              Done
              <span className="home-done__count">{doneCount}</span>
            </button>
          ) : null}
          {!firstRun && tasks === 0 ? (
            <p className="home-quiet">Tasks you start show up here, by the folder they work in.</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function FolderSection({
  actions,
  group,
}: {
  readonly actions: TasksHomeActions;
  readonly group: FolderGroupView;
}) {
  const { folder } = group;
  if (group.tasks.length === 0) return null;
  return (
    <section aria-label={folder.label} className="home-section home-folder">
      <header className="home-section__head">
        <h2 className="home-folder__title">
          <Icon name={folder.agentHome ? "home" : "folder"} />
          <span className="home-folder__name">{folder.label}</span>
          <span className="home-folder__detail">
            {folder.path} · {folder.computerName}
          </span>
        </h2>
        <button
          aria-label={`New task in ${folder.label}`}
          className="icon-btn icon-btn--small"
          onClick={() => actions.onNewTaskIn(folder.id)}
          title={`New task in ${folder.label}`}
          type="button"
        >
          <Icon name="plus" />
        </button>
      </header>
      <ul className="home-tasks">
        {group.tasks.map((task) => (
          <li key={task.id}>
            <HomeTaskRow actions={actions} task={task} />
          </li>
        ))}
        {group.more > 0 ? (
          <li className="home-tasks__more">{group.more} more in the sidebar</li>
        ) : null}
      </ul>
    </section>
  );
}

/** Home's task row says more than the sidebar's: the source, whose thread, and the live status. */
function HomeTaskRow({
  actions,
  task,
}: {
  readonly actions: TasksHomeActions;
  readonly task: TaskRowView;
}) {
  const href = actions.taskHref?.(task.id);
  const needs = task.tone === "needs-you" && task.ask;
  const line = (
    <span className="home-task__line">
      {task.source ? <TaskSource source={task.source} thread /> : null}
      {needs ? (
        <span className="home-task__ask">{task.ask}</span>
      ) : task.status ? (
        <span className="home-task__status">{task.status}</span>
      ) : null}
    </span>
  );
  const body = (
    <>
      <TaskMark mark={task.mark} size={22} />
      <span className="home-task__text">
        <span className="home-task__title">{task.title}</span>
        {line}
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
