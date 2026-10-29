import { WorkspaceOrb } from "./workspace-orb.js";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Link, useNavigate } from "react-router";
import type { AssignmentSummary } from "@opensteer/core";
import {
  assignmentTitle,
  assignmentMark,
  assignmentPresentation,
  assignmentRequester,
  assignmentStatusLine,
  currentAssignment,
  type AssignmentEntry,
  type AssignmentPresentation,
  type TaskTone,
} from "@opensteer/client/host";
import { useActionReview } from "@opensteer/client/react";
import { useShell } from "./app-shell.js";
import { Icon } from "./icon.js";
import { Popover } from "./popover.js";
import { TaskMark, TaskState, ChatOrb } from "./workspace/task-mark.js";
import { useOptionalWorkspace } from "./workspace/workspace-context.js";

/**
 * A task in a transcript: one bubble where it was handed out. Its outcome
 * changes the bubble in place; the reply that follows says what came back.
 */
export function TaskView({ entry }: { entry: AssignmentEntry }) {
  return <TaskBubble entry={entry} />;
}

function taskHref(assignment: AssignmentSummary): string {
  return `/threads/${assignment.workerThread.id}`;
}

/**
 * Work handed to another Thread, under the reply that handed it out: one
 * bubble that changes in place, and opens the task. It reads the Host's newest
 * summary, and while the task is open it keeps the worker observed, so its
 * state and current step arrive wherever the task works. Stopping it lives in
 * its menu — right-click, or the button beside it — never on its mark.
 */
function TaskBubble({ entry }: { entry: AssignmentEntry }) {
  const { hostClient, snapshot } = useShell();
  const workspace = useOptionalWorkspace();
  const assignment = currentAssignment(entry, snapshot.assignments);
  const presentation = assignmentPresentation(assignment, snapshot);
  const workerThreadId = assignment.workerThread.id;
  const workerWorkspace = snapshot.workspaces.find(
    (workspace) => workspace.id === assignment.workerThread.workspaceId,
  );
  const owner = workerWorkspace
    ? workerWorkspace.kind === "main"
      ? "Opensteer"
      : workerWorkspace.name
    : null;
  const { open } = presentation;
  // Completed workers can belong to a Workspace beyond the loaded catalog.
  // Holding one opens its Workspace channel without changing the conversation.
  const observeWorker = open || workerWorkspace === undefined;
  useEffect(
    () => (observeWorker ? hostClient.observeThread(workerThreadId) : undefined),
    [hostClient, observeWorker, workerThreadId],
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const title = assignmentTitle(assignment, snapshot);
  const status = assignmentStatusLine(assignment, presentation);
  // Keep the concrete ask beside the task; the full status stays in its name.
  const line =
    presentation.open && presentation.detail?.kind === "decision"
      ? presentation.detail.text
      : status;
  return (
    <div
      className={menuOpen ? "task-bubble-row task-bubble-row--menu" : "task-bubble-row"}
      onContextMenu={(event: MouseEvent) => {
        event.preventDefault();
        setMenuOpen(true);
      }}
    >
      <Link
        aria-label={`${title}${owner ? `, ${owner}` : ""}, ${status}. Open task`}
        className={`task-bubble task-bubble--${presentation.tone}`}
        to={
          workspace
            ? workspace.nav.conversationHref(workspace.nav.threadPath(workerThreadId))
            : taskHref(assignment)
        }
      >
        <TaskMark size={22} mark={assignmentMark(assignment, snapshot)} />
        <span className="task-bubble__text">
          <span className="task-bubble__title">{title}</span>
          <span className="task-bubble__attribution">
            {workerWorkspace ? (
              <span className="task-bubble__byline">
                {workerWorkspace.kind === "main" ? (
                  <ChatOrb size={16} />
                ) : (
                  <WorkspaceOrb
                    icon={workerWorkspace.icon}
                    name={workerWorkspace.name}
                    size="tiny"
                    color={workerWorkspace.color}
                  />
                )}
                {owner}
                <span>·</span>
              </span>
            ) : null}
            <span className="task-bubble__status">{line}</span>
          </span>
        </span>
        <TaskState state={assignmentStates[presentation.tone]} />
      </Link>
      <button
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        aria-label={`More for ${title}`}
        className="task-bubble__more"
        onClick={() => setMenuOpen((value) => !value)}
        ref={moreRef}
        type="button"
      >
        <Icon name="more" />
      </button>
      {menuOpen && moreRef.current ? (
        <TaskMenu
          anchor={moreRef.current}
          assignment={assignment}
          onClose={() => setMenuOpen(false)}
          presentation={presentation}
        />
      ) : null}
      <LifecycleNews text={presentation.announcement} />
    </div>
  );
}

/**
 * What a task offers beyond opening it. Stopping asks once, in the menu, with
 * focus on the answer that changes nothing; it is offered only while the task
 * can still change, and said to be unavailable, with why, while it cannot be
 * sent.
 */
function TaskMenu({
  anchor,
  assignment,
  onClose,
  presentation,
}: {
  anchor: HTMLElement;
  assignment: AssignmentSummary;
  onClose: () => void;
  presentation: AssignmentPresentation;
}) {
  const { hostClient, reportActionError, snapshot } = useShell();
  const navigate = useNavigate();
  const workspace = useOptionalWorkspace();
  const { review, ask } = useActionReview(hostClient);
  const title = assignmentTitle(assignment, snapshot);
  const stop = async () => {
    const result = review?.confirm();
    onClose();
    try {
      await result;
    } catch (error) {
      reportActionError(error);
    }
  };
  if (review) {
    return (
      // Its own panel, not the menu's: focus starts again, on the answer that changes nothing.
      <Popover
        anchor={anchor}
        className="task-stop"
        key="confirm"
        label={`Stop ${title}?`}
        onClose={onClose}
        role="dialog"
      >
        <p className="task-stop__question">Stop “{title}”?</p>
        <p className="task-stop__detail">
          It stops for good, and {assignmentRequester(assignment, snapshot)} is told. Nothing it
          already did is undone.
        </p>
        <div className="task-stop__actions">
          <button
            className="btn btn--small btn--ghost"
            data-autofocus
            onClick={onClose}
            type="button"
          >
            Keep working
          </button>
          <button className="btn btn--small btn--danger" onClick={() => void stop()} type="button">
            Stop task
          </button>
        </div>
      </Popover>
    );
  }
  return (
    <Popover anchor={anchor} className="task-menu" label={`${title} actions`} onClose={onClose}>
      <button
        className="picker__row"
        onClick={() => {
          onClose();
          if (workspace)
            workspace.nav.openConversation(workspace.nav.threadPath(assignment.workerThread.id));
          else void navigate(taskHref(assignment));
        }}
        role="menuitem"
        type="button"
      >
        <span className="picker__glyph">
          <Icon name="arrow-right" />
        </span>
        <span className="picker__label">Open task</span>
      </button>
      {presentation.open ? (
        <button
          aria-disabled={presentation.stopBlocked !== null}
          className="picker__row picker__row--danger"
          onClick={() => {
            if (presentation.stopBlocked === null)
              ask({ kind: "stop-assignment", assignmentId: assignment.id });
          }}
          role="menuitem"
          type="button"
        >
          <span className="picker__glyph">
            <Icon name="stop" />
          </span>
          <span className="picker__label-stack">
            <span className="picker__label">Stop task…</span>
            {presentation.stopBlocked ? (
              <span className="picker__detail">{presentation.stopBlocked}</span>
            ) : null}
          </span>
        </button>
      ) : null}
    </Popover>
  );
}

/**
 * A lifecycle change, said once to a screen reader. The transcript's log
 * announces a bubble when it arrives; one that changes in place does not,
 * so its region stays empty until the word actually moves.
 */
function LifecycleNews({ text }: { text: string }) {
  const [news, setNews] = useState("");
  const said = useRef(text);
  useEffect(() => {
    if (said.current === text) return;
    said.current = text;
    setNews(text);
  }, [text]);
  return (
    <span className="visually-hidden" role="status">
      {news}
    </span>
  );
}

const assignmentStates: Record<AssignmentPresentation["tone"], TaskTone> = {
  completed: "finished",
  failed: "failed",
  paused: "waiting",
  queued: "waiting",
  stopped: "finished",
  waiting: "needs-you",
  working: "working",
};
