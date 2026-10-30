import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useNavigate } from "react-router";
import type { AssignmentSummary } from "@opensteer/core";
import {
  assignmentTitle,
  assignmentMark,
  assignmentPresentation,
  assignmentRequester,
  assignmentStatusLine,
  currentAssignment,
  delegationPresentation,
  taskGroupSummary,
  taskRowNote,
  threadMark,
  type AssignmentEntry,
  type AssignmentPresentation,
  type AssignmentTone,
  type DelegationEntry,
  type HostSnapshot,
  type TaskMark as ResolvedTaskMark,
} from "@opensteer/client/host";
import { useActionReview } from "@opensteer/client/react";
import { useShell } from "./app-shell.js";
import { Icon } from "./icon.js";
import { Popover } from "./popover.js";
import { AreaLink } from "./workspace/area-link.js";
import { TaskMark } from "./workspace/task-mark.js";
import { useOptionalWorkspace } from "./workspace/workspace-context.js";

/**
 * Another Thread's work, where it was handed out: one quiet line per task —
 * its mark, its title, a dot and a word for where it stands — that opens the
 * task. Only the dot and the word change as the task moves. Tasks one turn
 * handed out together read as one line until opened in place, and a task
 * waiting on the reader says what it asks under its title.
 */
export function TaskLines({ entries }: { entries: readonly AssignmentEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <div className="task-lines">
      {entries.length === 1 ? (
        <>
          <ObservedWorker entry={entries[0]!} />
          <AssignmentLine entry={entries[0]!} />
        </>
      ) : (
        <TaskLineGroup entries={entries} />
      )}
    </div>
  );
}

function taskHref(assignment: AssignmentSummary): string {
  return `/threads/${assignment.workerThread.id}`;
}

/**
 * Keeps a task's worker observed while the task is open, so its state and
 * current step arrive wherever the task works. Completed workers can belong
 * to a Workspace beyond the loaded catalog; holding one opens its Workspace
 * channel without changing the conversation.
 */
function useObservedWorker(entry: AssignmentEntry): void {
  const { hostClient, snapshot } = useShell();
  const assignment = currentAssignment(entry, snapshot.assignments);
  const workerThreadId = assignment.workerThread.id;
  const observe =
    assignment.status === "open" ||
    !snapshot.workspaces.some(({ id }) => id === assignment.workerThread.workspaceId);
  useEffect(
    () => (observe ? hostClient.observeThread(workerThreadId) : undefined),
    [hostClient, observe, workerThreadId],
  );
}

/**
 * What a task keeps doing whether or not its line is drawn: its worker stays
 * observed, and a change in where it stands is said to a screen reader. One
 * per task, so a closed group still speaks and an opened one never twice.
 */
function ObservedWorker({ entry }: { entry: AssignmentEntry }) {
  const { snapshot } = useShell();
  useObservedWorker(entry);
  const presentation = assignmentPresentation(
    currentAssignment(entry, snapshot.assignments),
    snapshot,
  );
  return <LifecycleNews text={presentation.announcement} />;
}

/**
 * Who does a task, when it says something: the reader's own Opensteer or a
 * specialist. The line keeps it to its name and tooltip; null while the
 * Workspace is not loaded, rather than a guess.
 */
function taskOwner(assignment: AssignmentSummary, snapshot: HostSnapshot): string | null {
  const workspace = snapshot.workspaces.find(
    ({ id }) => id === assignment.workerThread.workspaceId,
  );
  return workspace ? (workspace.kind === "main" ? "Opensteer" : workspace.name) : null;
}

/**
 * One task as a line. It reads the Host's newest summary. Its menu — a right
 * click, or the button beside it — opens it or stops it; its mark never does.
 * What the line leaves out, who does it, the model and how long it took,
 * stays in its name and tooltip.
 */
function AssignmentLine({ entry }: { entry: AssignmentEntry }) {
  const { snapshot } = useShell();
  const workspace = useOptionalWorkspace();
  const assignment = currentAssignment(entry, snapshot.assignments);
  const presentation = assignmentPresentation(assignment, snapshot);
  const [menuOpen, setMenuOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const title = assignmentTitle(assignment, snapshot);
  const owner = taskOwner(assignment, snapshot);
  const status = assignmentStatusLine(assignment, presentation);
  const workerThreadId = assignment.workerThread.id;
  return (
    <TaskLine
      label={`${title}${owner ? `, ${owner}` : ""}, ${status}. Open task`}
      mark={assignmentMark(assignment, snapshot)}
      menuOpen={menuOpen}
      more={
        <button
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          aria-label={`More for ${title}`}
          className="task-line__more"
          onClick={() => setMenuOpen((value) => !value)}
          ref={moreRef}
          type="button"
        >
          <Icon name="more" />
        </button>
      }
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuOpen(true);
      }}
      presentation={presentation}
      title={title}
      to={workspace ? workspace.nav.threadPath(workerThreadId) : taskHref(assignment)}
      tooltip={[title, owner, status].filter(Boolean).join(" · ")}
    >
      {menuOpen && moreRef.current ? (
        <TaskMenu
          anchor={moreRef.current}
          assignment={assignment}
          onClose={() => setMenuOpen(false)}
          presentation={presentation}
        />
      ) : null}
    </TaskLine>
  );
}

/**
 * The line every task shares. The link covers the whole line, so the line
 * and anything under it open the task; the button beside it sits above.
 */
function TaskLine({
  children,
  label,
  mark,
  menuOpen = false,
  more = null,
  onContextMenu,
  presentation,
  title,
  to,
  tooltip,
}: {
  children?: ReactNode;
  label: string;
  mark: ResolvedTaskMark;
  menuOpen?: boolean;
  more?: ReactNode;
  onContextMenu?: (event: MouseEvent) => void;
  presentation: AssignmentPresentation;
  title: string;
  /** The task's conversation path; inside the workspace it keeps the place in the middle. */
  to: string;
  tooltip: string;
}) {
  const note = taskRowNote(presentation);
  return (
    <div
      className={menuOpen ? "task-line task-line--menu" : "task-line"}
      data-tone={presentation.tone}
      onContextMenu={onContextMenu}
    >
      <div className="task-line__row">
        <AreaLink aria-label={label} className="task-line__open" title={tooltip} to={to}>
          <TaskMark size={20} mark={mark} />
          <span className="task-line__title">{title}</span>
          <TaskLineState
            moving={presentation.moving}
            tone={presentation.tone}
            word={presentation.word}
          />
        </AreaLink>
        {more}
        <Icon className="task-line__chevron" name="chevron-right" />
      </div>
      {note ? (
        <p className="task-line__note" data-kind={note.kind}>
          {note.text}
        </p>
      ) : null}
      {children}
    </div>
  );
}

function TaskLineState({
  moving,
  tone,
  word,
}: {
  moving: boolean;
  tone: AssignmentTone;
  word: string;
}) {
  return (
    <span className="task-line__state">
      <TaskDot moving={moving} tone={tone} />
      {word}
    </span>
  );
}

/** A task's state at a glance: the colour says its tone, and only work under way now pulses. */
function TaskDot({ moving, tone }: { moving: boolean; tone: AssignmentTone }) {
  return (
    <span
      aria-hidden="true"
      className="task-dot"
      data-moving={moving ? "true" : undefined}
      data-tone={tone}
    />
  );
}

/** Only these say anything in a group's counts; the rest are the quiet default. */
const signalTones = new Set<AssignmentTone>(["failed", "waiting", "working"]);

/**
 * Tasks one turn handed out together, as one line: their marks stacked, how
 * many, and how many read each word. It opens in place to a line for each,
 * and keeps every open one observed while it is closed.
 */
function TaskLineGroup({ entries }: { entries: readonly AssignmentEntry[] }) {
  const { snapshot } = useShell();
  const [open, setOpen] = useState(false);
  const assignments = entries.map((entry) => currentAssignment(entry, snapshot.assignments));
  const summary = taskGroupSummary(
    assignments.map((assignment) => assignmentPresentation(assignment, snapshot)),
  );
  const counts = summary.parts.map(({ text }) => text).join(", ");
  return (
    <div className="task-line-group">
      {entries.map((entry) => (
        <ObservedWorker entry={entry} key={entry.id} />
      ))}
      <div className="task-line" data-group="true">
        <div className="task-line__row">
          <button
            aria-expanded={open}
            aria-label={`${summary.label}: ${counts}. ${open ? "Hide" : "Show"} tasks`}
            className="task-line__open"
            onClick={() => setOpen((value) => !value)}
            type="button"
          >
            <span aria-hidden="true" className="task-stack">
              {assignments.slice(0, 3).map((assignment) => (
                <span className="task-stack__mark" key={assignment.id}>
                  <TaskMark size={16} mark={assignmentMark(assignment, snapshot)} />
                </span>
              ))}
            </span>
            <span className="task-line__title">{summary.label}</span>
            <span className="task-line__state">
              {summary.parts.map((part, index) => (
                <span className="task-line__part" key={part.text}>
                  {index > 0 ? <span className="task-line__sep">·</span> : null}
                  {signalTones.has(part.tone) ? (
                    <TaskDot moving={part.moving} tone={part.tone} />
                  ) : null}
                  {part.text}
                </span>
              ))}
            </span>
          </button>
          <Icon
            className={open ? "task-line__chevron task-line__chevron--open" : "task-line__chevron"}
            name="chevron-right"
          />
        </div>
      </div>
      {open ? (
        <div aria-label={summary.label} className="task-line-group__lines" role="group">
          {entries.map((entry) => (
            <AssignmentLine entry={entry} key={entry.id} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Work handed out before Assignments existed, in the same line. Its task,
 * its result and the pages its Run used are all in its own Thread, which the
 * line opens; the line says only how it ended.
 */
export function DelegationLine({
  delegation,
  snapshot,
}: {
  delegation: DelegationEntry;
  snapshot: Pick<HostSnapshot, "activeTasks" | "tasks" | "threads" | "workspaceTasks">;
}) {
  const workspace = useOptionalWorkspace();
  const presentation = delegationPresentation(delegation, snapshot);
  const childThreadId = delegation.childThread.id;
  const title =
    snapshot.threads.find(({ id }) => id === delegation.childThread.id)?.title ??
    delegation.childThread.title;
  const result = delegation.failure?.message ?? delegation.resultPreview;
  const summary = [title, presentation.word, result?.split("\n").find(Boolean)]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="task-lines">
      <TaskLine
        label={`${title}, ${presentation.word}. Open task`}
        mark={threadMark(childThreadId, snapshot)}
        presentation={presentation}
        title={title}
        to={workspace ? workspace.nav.threadPath(childThreadId) : `/threads/${childThreadId}`}
        tooltip={summary}
      />
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
 * announces a line when it arrives; one that changes in place does not,
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
