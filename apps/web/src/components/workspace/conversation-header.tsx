import {
  heldThread,
  taskCanBeDone,
  taskMark,
  taskUnderWay,
  threadMark,
  threadInDirectory,
} from "@opensteer/client/host";
import { TaskIconEditor } from "../task-icon-editor.js";
import { WorkspaceOrb } from "../workspace-orb.js";
import { ThreadTitleEditor } from "../thread-title-editor.js";
import { useHostSelector } from "@opensteer/client/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  assignmentPresentation,
  assignmentRequester,
  conversationName,
  placeList,
  threadStopTarget,
  workerAssignment,
  type HostClient,
  type TaskRow,
} from "@opensteer/client/host";
import { useActionReview } from "@opensteer/client/react";
import { useShell } from "../app-shell.js";
import { Icon } from "../icon.js";
import { Popover } from "../popover.js";
import { SidebarRestoreButton } from "../sidebar-chrome.js";
import { TaskBadge, TaskMark, TaskState, ChatOrb, taskStateWords } from "./task-mark.js";
import { destinationPlaceKey } from "./navigation.js";
import { DrawerButton } from "./place-stage.js";
import { homeThreadKind, useTaskDirectory } from "./task-directory.js";
import { useWorkspace } from "./workspace-context.js";

/**
 * The conversation's head: its mark, which also shows how the task is doing,
 * its name, switching and renaming, why it is not plainly working when that is
 * known, and the conversation's own controls. Docked beside the computer, the
 * name gets the width: the dock keeps only Expand and Close, and Find joins
 * the name's menu, where ⌘F still reaches it.
 */
export function ConversationHeader({
  cause,
  hostClient,
  onFind,
  threadId,
  title,
  titleRef,
}: {
  /** One muted line: a real reason it waits, the failure, or why it cannot be reached. */
  readonly cause: ReactNode;
  readonly hostClient: HostClient;
  readonly onFind: () => void;
  readonly threadId: string;
  readonly title: string;
  readonly titleRef?: React.Ref<HTMLHeadingElement>;
}) {
  const { dock, drawer, nav, phone, work } = useWorkspace();
  const directory = useTaskDirectory(hostClient);
  const homeKind = homeThreadKind(threadId, directory.snapshot);
  const home = homeKind === "main";
  const row = directory.rows.get(threadId);
  const [switching, setSwitching] = useState(false);
  const [editing, setEditing] = useState(false);
  const [changingIcon, setChangingIcon] = useState(false);
  const canChangeIcon = homeKind === null && directory.snapshot.taskMarksAvailable;
  const thread = threadInDirectory(threadId, directory.snapshot);
  const specialist = directory.snapshot.workspaces.find(
    (workspace) => workspace.id === thread?.workspaceId && workspace.kind !== "main",
  );
  const canRename = useHostSelector(
    hostClient,
    (snapshot) => homeThreadKind(threadId, snapshot) === null && snapshot.threadRenameAvailable,
  );
  const switcherRef = useRef<HTMLButtonElement | null>(null);
  const toggleComputer = () => {
    if (work) {
      nav.hideComputer();
      return;
    }
    const keys = new Set(placeList(hostClient.getSnapshot()).map((place) => place.key));
    nav.showComputer((destination) => {
      const key = destinationPlaceKey(destination);
      return key !== null && keys.has(key);
    });
  };
  const docked = work && !phone;
  const tone = !home && row ? row.tone : null;
  return (
    <header className="conv-header">
      {/* In Work the place's own bar carries the way back to the sidebar. */}
      {work ? null : drawer ? <DrawerButton /> : <SidebarRestoreButton />}
      <span className="conv-header__mark">
        {home ? (
          <ChatOrb size={20} />
        ) : homeKind === "specialized" && specialist ? (
          <WorkspaceOrb
            icon={specialist.icon}
            name={specialist.name}
            color={specialist.color}
            size="small"
          />
        ) : (
          <TaskMark size={20} mark={threadMark(threadId, directory.snapshot)} />
        )}
        {tone === "working" ? <WorkingRing /> : tone ? <TaskBadge state={tone} /> : null}
      </span>
      <div className="conv-header__text">
        <h1 className="conv-header__title" ref={titleRef} tabIndex={-1}>
          {editing && canRename ? (
            <ThreadTitleEditor
              key={threadId}
              hostClient={hostClient}
              threadId={threadId}
              title={title}
              onClose={() => {
                setEditing(false);
                requestAnimationFrame(() => switcherRef.current?.focus());
              }}
            />
          ) : (
            <button
              aria-expanded={switching}
              aria-haspopup="dialog"
              aria-label={`${title}${tone ? `, ${taskStateWords(tone)}` : ""}. Switch conversation`}
              className="conv-header__switcher"
              onClick={() => setSwitching((value) => !value)}
              ref={switcherRef}
              title={title}
              type="button"
            >
              <span className="conv-header__name">{title}</span>
              <Icon className="conv-header__chevron" name="chevron-down" />
            </button>
          )}
        </h1>
        {(cause ?? (row?.tone === "failed" ? row.line : null)) ? (
          <p
            className="conv-header__cause"
            ref={(node) => {
              if (node) node.title = node.textContent ?? "";
            }}
          >
            {cause ?? (row?.tone === "failed" ? row.line : null)}
          </p>
        ) : null}
      </div>
      {specialist && homeKind === null ? (
        <span className="conv-header__specialist">
          <WorkspaceOrb
            icon={specialist.icon}
            name={specialist.name}
            size="tiny"
            color={specialist.color}
          />
          <span>{specialist.name}</span>
        </span>
      ) : null}
      {/* Only a state that asks something of the reader is said in words; the
          mark shows the rest. */}
      {tone === "needs-you" ? <span className="conv-header__state">Needs you</span> : null}
      <div className="conv-header__actions">
        {phone ? null : docked ? (
          <button
            aria-label="Expand chat"
            className="icon-btn"
            onClick={toggleComputer}
            title="Expand chat · ⌘."
            type="button"
          >
            <Icon name="expand" />
          </button>
        ) : (
          <button
            aria-label="Show computer"
            className="icon-btn"
            onClick={toggleComputer}
            title="Show computer · ⌘."
            type="button"
          >
            <Icon name="desktop" />
          </button>
        )}
        {docked ? null : (
          <button
            aria-label="Find in conversation"
            className="icon-btn"
            onClick={onFind}
            title="Find in conversation · ⌘F"
            type="button"
          >
            <Icon name="search" />
          </button>
        )}
        {docked ? (
          <button
            aria-label="Close conversation"
            className="icon-btn"
            onClick={() => {
              dock.close();
              requestAnimationFrame(() =>
                document.querySelector<HTMLElement>(".chat-btn")?.focus(),
              );
            }}
            title="Close · Esc"
            type="button"
          >
            <Icon name="close" />
          </button>
        ) : null}
      </div>
      {changingIcon && switcherRef.current && canChangeIcon ? (
        <TaskIconEditor
          anchor={switcherRef.current}
          hostClient={hostClient}
          threadId={threadId}
          onClose={() => setChangingIcon(false)}
        />
      ) : null}
      {switching && switcherRef.current ? (
        <TaskSwitcher
          actions={
            home
              ? null
              : (confirming) => (
                  <TaskActions
                    key={threadId}
                    onConfirming={confirming}
                    onDone={() => setSwitching(false)}
                    onChangeIcon={
                      canChangeIcon
                        ? () => {
                            setSwitching(false);
                            setChangingIcon(true);
                          }
                        : null
                    }
                    onRename={
                      canRename
                        ? () => {
                            setSwitching(false);
                            setEditing(true);
                          }
                        : null
                    }
                    threadId={threadId}
                    title={title}
                  />
                )
          }
          anchor={switcherRef.current}
          current={threadId}
          onFind={
            docked
              ? () => {
                  setSwitching(false);
                  onFind();
                }
              : null
          }
          onChoose={(next) => {
            setSwitching(false);
            if (next !== threadId) nav.openConversation(nav.threadPath(next));
          }}
          onClose={() => setSwitching(false)}
          rows={[
            ...(directory.list.chat ? [directory.list.chat] : []),
            ...directory.list.working,
            ...directory.list.ready,
          ]}
          homeThreadId={directory.homeThreadId}
        />
      ) : null}
    </header>
  );
}

/**
 * What can be done to the task on screen, under the list that switches away
 * from it: renaming, stopping it (asked once, as a task card asks), and moving
 * it to Done or back. A task handed out by someone stops
 * for good and they are told; any other running task stops as the composer's
 * Stop stops it, its run ended and its queue paused, and from there it can be
 * resumed or moved to Done.
 */
function TaskActions({
  onConfirming,
  onDone,
  onRename,
  onChangeIcon,
  threadId,
  title,
}: {
  /** Asking takes the whole menu, so the question is all there is to read. */
  readonly onConfirming: (asking: boolean) => void;
  readonly onDone: () => void;
  readonly onRename: (() => void) | null;
  readonly onChangeIcon: (() => void) | null;
  readonly threadId: string;
  readonly title: string;
}) {
  const { hostClient, reportActionError, setTaskDone, snapshot } = useShell();
  const { review, ask, dismiss } = useActionReview(hostClient);
  useEffect(() => {
    onConfirming(review !== null);
  }, [onConfirming, review]);
  const assignment = workerAssignment(snapshot.assignments, threadId);
  const presentation = assignment ? assignmentPresentation(assignment, snapshot) : null;
  const handedOut = assignment !== null && presentation?.open === true;
  const thread = snapshot.threads.find((item) => item.id === threadId);
  const running =
    !handedOut &&
    thread !== undefined &&
    threadStopTarget({ runQueue: snapshot.runQueue, thread }) !== null;
  const stoppable = handedOut || running;
  // The task itself decides, not a list row: delegated work and Done tasks
  // past the loaded pages are open here without one.
  const held = heldThread(snapshot, threadId);
  const canBeDone = held !== null && taskCanBeDone(snapshot, held);
  const isDone = held?.doneAt != null;
  if (!stoppable && !canBeDone && onRename === null && onChangeIcon === null) return null;
  if (review) {
    return (
      <div
        className="switcher__confirm"
        role="group"
        aria-label={review.action.kind === "task-done" ? "Stop and mark Done?" : `Stop ${title}?`}
      >
        <p className="task-stop__question">
          {review.action.kind === "task-done" ? "Stop and mark Done?" : `Stop “${title}”?`}
        </p>
        <p className="task-stop__detail">
          {review.action.kind === "task-done"
            ? "This stops its work and the tasks it handed out, and pauses its schedules."
            : review.action.kind === "stop-assignment" && assignment
              ? `It stops for good, and ${assignmentRequester(assignment, snapshot)} is told. Nothing it already did is undone.`
              : "Its run stops now and it waits for you. Nothing it already did is undone."}
        </p>
        <div className="task-stop__actions">
          <button autoFocus className="btn btn--small btn--ghost" onClick={dismiss} type="button">
            Keep working
          </button>
          <button
            className="btn btn--small btn--danger"
            onClick={() => {
              const result = review.confirm();
              onDone();
              void result.catch(reportActionError);
            }}
            type="button"
          >
            {review.action.kind === "task-done" ? "Mark Done" : "Stop task"}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div aria-label="This task" className="switcher__actions" role="group">
      {onRename ? (
        <button
          aria-label="Rename task"
          className="picker__row"
          data-action="rename"
          type="button"
          onClick={onRename}
        >
          <span className="picker__glyph">
            <Icon name="pencil" />
          </span>
          <span className="picker__label">Rename</span>
        </button>
      ) : null}
      {onChangeIcon ? (
        <button
          aria-label="Change task icon"
          className="picker__row"
          data-action="change-icon"
          type="button"
          onClick={onChangeIcon}
        >
          <span className="picker__glyph">
            <Icon name="pencil" />
          </span>
          <span className="picker__label">Change icon…</span>
        </button>
      ) : null}
      {stoppable ? (
        <button
          aria-disabled={presentation?.stopBlocked ? true : undefined}
          className="picker__row picker__row--danger"
          onClick={() => {
            if (!presentation?.stopBlocked)
              ask(
                handedOut && assignment
                  ? { kind: "stop-assignment", assignmentId: assignment.id }
                  : { kind: "stop-run", threadId },
              );
          }}
          type="button"
        >
          <span className="picker__glyph">
            <Icon name="stop" />
          </span>
          <span className="picker__label-stack">
            <span className="picker__label">Stop task…</span>
            {presentation?.stopBlocked ? (
              <span className="picker__detail">{presentation.stopBlocked}</span>
            ) : null}
          </span>
        </button>
      ) : null}
      {canBeDone ? (
        <button
          className="picker__row"
          onClick={() => {
            if (!isDone && held !== null && taskUnderWay(held))
              ask({ kind: "task-done", threadId, done: true });
            else {
              onDone();
              setTaskDone(threadId, !isDone);
            }
          }}
          type="button"
        >
          <span className="picker__glyph">
            <Icon name={isDone ? "arrow-up" : "check"} />
          </span>
          <span className="picker__label">{isDone ? "Reopen" : "Mark Done"}</span>
        </button>
      ) : null}
    </div>
  );
}

/** The Tasks list in a popover, with search; choosing changes only the conversation. */
function TaskSwitcher({
  actions,
  anchor,
  current,
  homeThreadId,
  onChoose,
  onClose,
  onFind,
  rows,
}: {
  /** The open task's own actions, under the list; told when one asks first. */
  readonly actions: ((asking: (on: boolean) => void) => ReactNode) | null;
  readonly anchor: HTMLElement;
  readonly current: string;
  readonly homeThreadId: string | null;
  readonly onChoose: (threadId: string) => void;
  readonly onClose: () => void;
  /** Given where the header has no room for Find: it is offered here instead. */
  readonly onFind: (() => void) | null;
  readonly rows: readonly TaskRow[];
}) {
  const [query, setQuery] = useState("");
  const [asking, setAsking] = useState(false);
  const shown = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle
      ? rows.filter((row) =>
          conversationName(row.threadId, row.title, homeThreadId)
            .toLocaleLowerCase()
            .includes(needle),
        )
      : rows;
  }, [homeThreadId, query, rows]);
  return (
    <Popover
      anchor={anchor}
      className="popover--switcher"
      label="Switch conversation"
      onClose={onClose}
      role="dialog"
    >
      <div className="switcher">
        {asking ? null : (
          <>
            <input
              aria-label="Search tasks"
              autoFocus
              className="text-input switcher__search"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && shown[0]) {
                  event.preventDefault();
                  onChoose(shown[0].threadId);
                }
              }}
              placeholder="Search tasks…"
              type="search"
              value={query}
            />
            <div className="switcher__list" role="list">
              {shown.map((row) => {
                const home = row.threadId === homeThreadId;
                const name = conversationName(row.threadId, row.title, homeThreadId);
                const words = taskStateWords(row.tone);
                return (
                  <button
                    aria-current={row.threadId === current ? "true" : undefined}
                    aria-label={`${name}${words && !home ? `, ${words}` : ""}`}
                    className="switcher__row"
                    key={row.threadId}
                    onClick={() => onChoose(row.threadId)}
                    role="listitem"
                    type="button"
                  >
                    {home ? <ChatOrb size={20} /> : <TaskMark size={20} mark={taskMark(row)} />}
                    <span className="switcher__title">{name}</span>
                    {home ? null : <TaskState state={row.tone} unread={row.unread} />}
                    {row.threadId === current ? <Icon name="check" /> : null}
                  </button>
                );
              })}
              {shown.length === 0 ? <p className="switcher__empty">No tasks match.</p> : null}
            </div>
            {onFind ? (
              <div aria-label="This conversation" className="switcher__actions" role="group">
                <button className="picker__row" onClick={onFind} type="button">
                  <span className="picker__glyph">
                    <Icon name="search" />
                  </span>
                  <span className="picker__label">Find in conversation</span>
                  <kbd aria-hidden className="kbd">
                    ⌘F
                  </kbd>
                </button>
              </div>
            ) : null}
          </>
        )}
        {actions ? actions(setAsking) : null}
      </div>
    </Popover>
  );
}

/** A task at work: a slow arc around its mark, where the eye already is. */
function WorkingRing() {
  return (
    <svg aria-hidden className="conv-header__ring" data-state="working" viewBox="0 0 32 32">
      <circle cx="16" cy="16" fill="none" r="14.5" stroke="var(--line-strong)" strokeWidth="1.5" />
      <path
        d="M16 1.5a14.5 14.5 0 0 1 14.5 14.5"
        fill="none"
        stroke="var(--ember)"
        strokeLinecap="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

/**
 * The head of a conversation-area page that is not a conversation yet — New
 * task, a specialist's page: its name, and the computer's toggle.
 */
export function AreaHeader({
  hostClient,
  mark,
  title,
}: {
  readonly hostClient: HostClient;
  readonly mark?: ReactNode;
  readonly title: ReactNode;
}) {
  const { drawer, nav, phone, work } = useWorkspace();
  const toggleComputer = () => {
    if (work) {
      nav.hideComputer();
      return;
    }
    const keys = new Set(placeList(hostClient.getSnapshot()).map((place) => place.key));
    nav.showComputer((destination) => {
      const key = destinationPlaceKey(destination);
      return key !== null && keys.has(key);
    });
  };
  return (
    <header className="conv-header conv-header--area">
      {work ? null : drawer ? <DrawerButton /> : <SidebarRestoreButton />}
      {mark ? <span className="conv-header__mark">{mark}</span> : null}
      <div className="conv-header__text">
        <h1 className="conv-header__title">
          <span className="conv-header__name conv-header__name--static">{title}</span>
        </h1>
      </div>
      <div className="conv-header__actions">
        {phone ? null : (
          <button
            aria-label={work ? "Expand" : "Show computer"}
            className="icon-btn"
            onClick={toggleComputer}
            title={work ? "Expand · ⌘." : "Show computer · ⌘."}
            type="button"
          >
            <Icon name={work ? "expand" : "desktop"} />
          </button>
        )}
      </div>
    </header>
  );
}

/** The neutral subject while a task has not started yet. */
export function NewTaskMark() {
  return <TaskMark size={20} mark={taskMark({ icon: null })} />;
}
