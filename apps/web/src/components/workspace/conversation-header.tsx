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
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  assignmentPresentation,
  assignmentRequester,
  placeList,
  threadRequester,
  threadStopTarget,
  workerAssignment,
  type HostClient,
  type HostSnapshot,
  type RequesterLink,
} from "@opensteer/client/host";
import { useActionReview } from "@opensteer/client/react";
import { useShell } from "../app-shell.js";
import { Icon } from "../icon.js";
import { Popover } from "../popover.js";
import { SidebarRestoreButton } from "../sidebar-chrome.js";
import { TaskFamilyButton } from "./task-family.js";
import { sameTaskFamilyGlance, taskFamilyGlance } from "@opensteer/client/host";
import { TaskBadge, TaskMark, ChatOrb, WorkingRing, taskStateWords } from "./task-mark.js";
import { AreaLink } from "./area-link.js";
import { destinationPlaceKey, type WorkspaceNavigation } from "./navigation.js";
import { DrawerButton } from "./place-stage.js";
import { homeThreadKind, useTaskDirectory } from "./task-directory.js";
import { useWorkspace } from "./workspace-context.js";

/**
 * The conversation's head: one bar of a fixed height holding its mark, which
 * also shows how the task is doing, its name and the menu under it, why it is
 * not plainly working when that is known, its tasks, and its own controls. The
 * way back to the conversation it works for is a quiet row above the bar, so
 * the head grows by that row instead of crowding the name. Docked beside the
 * computer the name gets the width: the computer's bar holds the way to put
 * the conversation away, and Expand and Find join the name's menu, where ⌘.
 * and ⌘F still reach them.
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
  const { drawer, nav, phone, work } = useWorkspace();
  const directory = useTaskDirectory(hostClient);
  const homeKind = homeThreadKind(threadId, directory.snapshot);
  const home = homeKind === "main";
  const row = directory.rows.get(threadId);
  const [menuOpen, setMenuOpen] = useState(false);
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
  const menuRef = useRef<HTMLButtonElement | null>(null);
  const docked = work && !phone;
  const tone = !home && row ? row.tone : null;
  const selectRequester = useCallback(
    (snapshot: HostSnapshot) =>
      homeThreadKind(threadId, snapshot) === null ? threadRequester(snapshot, threadId) : null,
    [threadId],
  );
  const requester = useHostSelector(hostClient, selectRequester, sameRequester);
  const selectFamily = useCallback(
    (snapshot: HostSnapshot) => taskFamilyGlance(snapshot, threadId),
    [threadId],
  );
  const family = useHostSelector(hostClient, selectFamily, sameTaskFamilyGlance);
  const menu = !home || docked;
  const taskMark = threadMark(threadId, directory.snapshot);
  const specialistOrb = homeKind === "specialized" && specialist;
  return (
    <header className="conv-header">
      {requester ? (
        <nav aria-label="Task lineage" className="conv-header__trail">
          <AreaLink
            aria-label={`Back to ${requester.title}`}
            className="conv-header__back"
            title={requester.title}
            to={nav.threadPath(requester.threadId)}
          >
            <Icon name="arrow-left" />
            {requester.threadId === directory.homeThreadId ? (
              <ChatOrb size={16} />
            ) : (
              <TaskMark size={16} mark={threadMark(requester.threadId, directory.snapshot)} />
            )}
            <span className="conv-header__back-title">{requester.title}</span>
          </AreaLink>
        </nav>
      ) : null}
      <div className="conv-header__bar">
        {/* In Work the place's own bar carries the way back to the sidebar. */}
        {work ? null : drawer ? <DrawerButton /> : <SidebarRestoreButton />}
        <span className="conv-header__mark">
          {home ? (
            <ChatOrb size={20} />
          ) : specialistOrb ? (
            <WorkspaceOrb
              icon={specialist.icon}
              name={specialist.name}
              color={specialist.color}
              size="small"
            />
          ) : (
            <TaskMark size={20} mark={taskMark} />
          )}
          {tone === "working" ? (
            <WorkingRing mark={specialistOrb ? null : taskMark} />
          ) : tone ? (
            <TaskBadge state={tone} />
          ) : null}
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
                  requestAnimationFrame(() => menuRef.current?.focus());
                }}
              />
            ) : menu ? (
              <button
                aria-expanded={menuOpen}
                aria-haspopup="dialog"
                aria-label={`${title}${tone ? `, ${taskStateWords(tone)}` : ""}`}
                className="conv-header__menu"
                onClick={() => setMenuOpen((value) => !value)}
                ref={menuRef}
                title={title}
                type="button"
              >
                <span className="conv-header__name">{title}</span>
                <Icon className="conv-header__chevron" name="chevron-down" />
              </button>
            ) : (
              <span className="conv-header__name conv-header__name--static" title={title}>
                {title}
              </span>
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
        <div className="conv-header__end">
          {/* Only a state that asks something of the reader is said in words; the
              mark shows the rest. */}
          {tone === "needs-you" ? <span className="conv-header__state">Needs you</span> : null}
          {family ? (
            <TaskFamilyButton
              key={threadId}
              hostClient={hostClient}
              threadId={threadId}
              glance={family}
            />
          ) : null}
          {docked ? null : (
            <div className="conv-header__actions">
              {phone ? null : (
                <button
                  aria-label="Show computer"
                  className="icon-btn"
                  onClick={() => showComputer(hostClient, nav)}
                  title="Show computer · ⌘."
                  type="button"
                >
                  <Icon name="desktop" />
                </button>
              )}
              <button
                aria-label="Find in conversation"
                className="icon-btn"
                onClick={onFind}
                title="Find in conversation · ⌘F"
                type="button"
              >
                <Icon name="search" />
              </button>
            </div>
          )}
        </div>
      </div>
      {changingIcon && menuRef.current && canChangeIcon ? (
        <TaskIconEditor
          anchor={menuRef.current}
          hostClient={hostClient}
          threadId={threadId}
          onClose={() => setChangingIcon(false)}
        />
      ) : null}
      {menuOpen && menuRef.current ? (
        <ConversationMenu
          actions={
            home
              ? null
              : (confirming) => (
                  <TaskActions
                    key={threadId}
                    onConfirming={confirming}
                    onDone={() => setMenuOpen(false)}
                    onChangeIcon={
                      canChangeIcon
                        ? () => {
                            setMenuOpen(false);
                            setChangingIcon(true);
                          }
                        : null
                    }
                    onRename={
                      canRename
                        ? () => {
                            setMenuOpen(false);
                            setEditing(true);
                          }
                        : null
                    }
                    threadId={threadId}
                    title={title}
                  />
                )
          }
          anchor={menuRef.current}
          label={title}
          view={
            docked
              ? {
                  expand: () => {
                    setMenuOpen(false);
                    nav.hideComputer();
                    focusAfterExpand();
                  },
                  find: () => {
                    setMenuOpen(false);
                    onFind();
                  },
                }
              : null
          }
          onClose={() => setMenuOpen(false)}
        />
      ) : null}
    </header>
  );
}

function sameRequester(left: RequesterLink | null, right: RequesterLink | null): boolean {
  return left === right || (left?.threadId === right?.threadId && left?.title === right?.title);
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
        className="conversation-menu__confirm"
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
    <div aria-label="This task" className="conversation-menu__actions" role="group">
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

/**
 * The actions available under this conversation's name.
 */
function ConversationMenu({
  actions,
  anchor,
  label,
  onClose,
  view,
}: {
  /** The open task's own actions, last; told when one asks first. */
  readonly actions: ((asking: (on: boolean) => void) => ReactNode) | null;
  readonly anchor: HTMLElement;
  readonly label: string;
  readonly onClose: () => void;
  /** Docked beside the computer, the header keeps only the name, so the view's own actions are here. */
  readonly view: { readonly expand: () => void; readonly find: (() => void) | null } | null;
}) {
  const [asking, setAsking] = useState(false);
  return (
    <Popover
      anchor={anchor}
      className="popover--conversation-menu"
      label={label}
      onClose={onClose}
      role="dialog"
    >
      <div className="conversation-menu">
        {asking || !view ? null : (
          <div aria-label="This conversation" className="conversation-menu__actions" role="group">
            <button className="picker__row" onClick={view.expand} type="button">
              <span className="picker__glyph">
                <Icon name="expand" />
              </span>
              <span className="picker__label">Expand chat</span>
              <kbd aria-hidden className="kbd">
                ⌘.
              </kbd>
            </button>
            {view.find ? (
              <button className="picker__row" onClick={view.find} type="button">
                <span className="picker__glyph">
                  <Icon name="search" />
                </span>
                <span className="picker__label">Find in conversation</span>
                <kbd aria-hidden className="kbd">
                  ⌘F
                </kbd>
              </button>
            ) : null}
          </div>
        )}
        {actions ? actions(setAsking) : null}
      </div>
    </Popover>
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
  readonly title: string;
}) {
  const { drawer, nav, phone, work } = useWorkspace();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLButtonElement | null>(null);
  // Docked, its name opens the menu a conversation's does, so Expand is found
  // in one place beside the computer.
  const docked = work && !phone;
  return (
    <header className="conv-header conv-header--area">
      <div className="conv-header__bar">
        {work ? null : drawer ? <DrawerButton /> : <SidebarRestoreButton />}
        {mark ? <span className="conv-header__mark">{mark}</span> : null}
        <div className="conv-header__text">
          <h1 className="conv-header__title" tabIndex={-1}>
            {docked ? (
              <button
                aria-expanded={menuOpen}
                aria-haspopup="dialog"
                className="conv-header__menu"
                onClick={() => setMenuOpen((value) => !value)}
                ref={menuRef}
                type="button"
              >
                <span className="conv-header__name">{title}</span>
                <Icon className="conv-header__chevron" name="chevron-down" />
              </button>
            ) : (
              <span className="conv-header__name conv-header__name--static">{title}</span>
            )}
          </h1>
        </div>
        {work || phone ? null : (
          <div className="conv-header__end">
            <div className="conv-header__actions">
              <button
                aria-label="Show computer"
                className="icon-btn"
                onClick={() => showComputer(hostClient, nav)}
                title="Show computer · ⌘."
                type="button"
              >
                <Icon name="desktop" />
              </button>
            </div>
          </div>
        )}
      </div>
      {docked && menuOpen && menuRef.current ? (
        <ConversationMenu
          actions={null}
          anchor={menuRef.current}
          label={title}
          onClose={() => setMenuOpen(false)}
          view={{
            expand: () => {
              setMenuOpen(false);
              nav.hideComputer();
              focusAfterExpand();
            },
            find: null,
          }}
        />
      ) : null}
    </header>
  );
}

/**
 * Expanding can take away the menu's own button (Chat and a page name it only
 * while docked), so focus goes where the reader carries on: the composer, or
 * else the page's name.
 */
function focusAfterExpand() {
  requestAnimationFrame(() =>
    (
      document.querySelector<HTMLElement>("[data-composer-input]") ??
      document.querySelector<HTMLElement>(".workspace__conversation .conv-header__title")
    )?.focus(),
  );
}

/** Brings the computer back beside the conversation, at a place that still exists. */
function showComputer(hostClient: HostClient, nav: WorkspaceNavigation) {
  const keys = new Set(placeList(hostClient.getSnapshot()).map((place) => place.key));
  nav.showComputer((destination) => {
    const key = destinationPlaceKey(destination);
    return key !== null && keys.has(key);
  });
}

/** The neutral subject while a task has not started yet. */
export function NewTaskMark() {
  return <TaskMark size={20} mark={taskMark({ icon: null })} />;
}
