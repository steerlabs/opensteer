import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  agentCardLabel,
  agentPhaseLabel,
  assignmentPresentation,
  assignmentSubagentCard,
  currentAssignment,
  taskOwner,
  formatDuration,
  subagentGroup,
  type AgentCard,
  type AgentGroup,
  type AgentPhrase,
  type AssignmentEntry,
  type WorkflowView,
} from "@opensteer/client/host";
import type { AssignmentSummary } from "@opensteer/core";
import { useShell } from "./app-shell.js";
import { Icon } from "./icon.js";
import { EngineMark } from "./model-picker.js";
import { LifecycleNews, ObservedWorker, TaskMenu } from "./task-line.js";
import { AreaLink } from "./workspace/area-link.js";
import { TaskMark } from "./workspace/task-mark.js";
import { useOptionalWorkspace } from "./workspace/workspace-context.js";

/** Whether the screen still hears its Host: elapsed time stops ticking when it does not. */
export const AgentsLive = createContext(true);
/** The engine the conversation runs on, whose mark every subagent in it wears. */
export const AgentEngine = createContext<string | null>(null);

/** Each group's and phase's open state, kept by key for the life of the view that provides it. */
interface AgentFoldState {
  readonly get: (key: string) => boolean | undefined;
  readonly set: (key: string, open: boolean) => void;
}
const AgentFoldsContext = createContext<AgentFoldState | null>(null);

export function AgentFolds({ children }: { children: ReactNode }) {
  const [folds, setFolds] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const value = useMemo<AgentFoldState>(
    () => ({
      get: (key) => folds.get(key),
      set: (key, open) => setFolds((current) => new Map(current).set(key, open)),
    }),
    [folds],
  );
  return <AgentFoldsContext value={value}>{children}</AgentFoldsContext>;
}

/** Open state for one key: the person's choice once made, else `initial`. */
function useAgentFold(key: string, initial: boolean): [boolean, (open: boolean) => void] {
  const folds = useContext(AgentFoldsContext);
  const [own, setOwn] = useState<boolean | null>(null);
  const chosen = folds ? folds.get(key) : own;
  const set = useCallback(
    (open: boolean) => (folds ? folds.set(key, open) : setOwn(open)),
    [folds, key],
  );
  return [chosen ?? initial, set];
}

/* ---- Elapsed time: one clock for every label on screen ---- */

const ticking = new Map<HTMLElement, number>();
let clock: number | null = null;

function tick() {
  const now = Date.now();
  for (const [element, start] of ticking) element.textContent = formatDuration(now - start);
}

/** Time since `startedAt`, written in place by one shared clock: ticking never re-renders. */
export function Elapsed({
  className,
  endedAt,
  startedAt,
}: {
  className: string;
  endedAt: string | null;
  startedAt: string;
}) {
  const live = useContext(AgentsLive);
  const ref = useRef<HTMLSpanElement | null>(null);
  const start = Date.parse(startedAt);
  const running = endedAt === null && live;
  useEffect(() => {
    const element = ref.current;
    if (!running || !element) return;
    ticking.set(element, start);
    clock ??= window.setInterval(tick, 1_000);
    return () => {
      ticking.delete(element);
      if (ticking.size === 0 && clock !== null) {
        window.clearInterval(clock);
        clock = null;
      }
    };
  }, [running, start]);
  return (
    <span aria-hidden className={className} ref={ref}>
      {formatDuration((endedAt ? Date.parse(endedAt) : Date.now()) - start)}
    </span>
  );
}

/* ---- Opening a row, and coming back to it ---- */

let opener: string | null = null;

/** The row focus returns to when the open subagent closes: the last one viewed. */
export function rememberAgentRow(nodeId: string) {
  opener = `node:${nodeId}`;
}

/** Opens a subagent in its conversation's place, or a task's own conversation. */
export function useOpenAgent(): (
  card: AgentCard,
  options?: { readonly replace?: boolean },
) => void {
  const workspace = useOptionalWorkspace();
  return useCallback(
    (card, options) => {
      const opens = card.opens;
      if (!opens || !workspace) return;
      opener = card.key;
      const path = workspace.nav.threadPath(opens.threadId);
      if (opens.kind === "thread") workspace.nav.openConversation(path);
      else
        workspace.nav.openConversation(path, {
          subagent: opens.nodeId,
          ...(options?.replace ? { replace: true } : {}),
        });
    },
    [workspace],
  );
}

/**
 * Back from a subagent's view, focus returns to the row it was opened from,
 * or to the group or phase that now holds it. The transcript never moved.
 */
export function returnToAgentRow(scope: ParentNode | null) {
  const key = opener;
  opener = null;
  if (!key || !scope) return;
  const row = scope.querySelector<HTMLElement>(
    `[data-agent-key="${CSS.escape(key)}"] > .trace-step__row > .trace-step__head`,
  );
  const target =
    row ??
    scope.querySelector<HTMLElement>(
      `[data-agent-members~="${CSS.escape(key)}"] > .trace-step__row > .trace-step__head`,
    );
  target?.focus({ preventScroll: !isOffscreen(target) });
}

function isOffscreen(element: HTMLElement): boolean {
  const box = element.getBoundingClientRect();
  return box.bottom < 0 || box.top > window.innerHeight;
}

/* ---- The mark: the engine's glyph, quiet like every trace icon, with one status dot ---- */

type Dot = "working" | "needs" | "waiting" | "failed" | "stopped" | "last-known" | null;

export function agentDot(card: AgentCard): Dot {
  if (card.lastKnown) return "last-known";
  if (card.stopping) return "waiting";
  switch (card.tone) {
    case "working":
      return "working";
    case "needs-you":
      return "needs";
    case "waiting":
      return "waiting";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
    case "finished":
      return null;
  }
}

export function AgentMark({ card }: { card: AgentCard }) {
  const engine = useContext(AgentEngine);
  const dot = agentDot(card);
  return (
    <span aria-hidden className="agent-mark" data-dot={dot ?? undefined}>
      {card.task ? (
        <TaskMark size={16} mark={card.task.mark} />
      ) : card.workflow ? (
        <Icon name="list" />
      ) : engine ? (
        <EngineMark driverKind={engine} />
      ) : (
        <Icon name="sparkles" />
      )}
      {dot ? <span className="agent-mark__dot" /> : null}
    </span>
  );
}

/** The conversation engine's mark with one status dot, for a subagent known only by name. */
export function EngineDotMark({ dot }: { dot: Exclude<Dot, null> }) {
  const engine = useContext(AgentEngine);
  return (
    <span aria-hidden className="agent-mark" data-dot={dot}>
      {engine ? <EngineMark driverKind={engine} /> : <Icon name="sparkles" />}
      <span className="agent-mark__dot" />
    </span>
  );
}

/** A row's second line: its phrases, each in words, separated as the trace separates. */
export function AgentPhrases({
  after = false,
  noun = null,
  phrases,
}: {
  /** Something already stands before the first phrase, so it starts with a separator. */
  after?: boolean;
  noun?: string | null;
  phrases: readonly AgentPhrase[];
}) {
  return (
    <>
      {noun ? <span className="agent-step__noun">{noun}</span> : null}
      {phrases.map((phrase, index) => (
        <span className="agent-step__phrase" data-tone={phrase.tone} key={index}>
          {index > 0 || noun || after ? (
            <span aria-hidden className="agent-step__sep">
              ·
            </span>
          ) : null}
          <span
            className={phrase.tone === "live" ? "agent-step__live" : undefined}
            // Each new report arrives as itself rather than overwriting the last in place.
            key={phrase.tone === "live" ? phrase.text : undefined}
          >
            {phrase.text}
          </span>
        </span>
      ))}
    </>
  );
}

/* ---- Rows ---- */

/**
 * One subagent, workflow member or task: a trace step with two lines, the
 * engine's mark, and the time. It opens the subagent; the ones it started
 * itself hang one step in under it.
 */
export const AgentRow = memo(function AgentRow({
  card,
  compact = false,
  noun = false,
}: {
  card: AgentCard;
  /** Thirty or more beside it: one line, title and state. */
  compact?: boolean;
  /** Alone in its place, so line two says what it is. */
  noun?: boolean;
}) {
  const open = useOpenAgent();
  const tasks = useContext(TaskAssignments);
  const task = card.task ? tasks.get(card.task.assignmentId) : undefined;
  const assignment = task?.assignment;
  const label = agentCardLabel(card, Date.now(), task?.owner ?? null);
  const children = card.children;
  const workspace = useOptionalWorkspace();
  const more = useRef<HTMLButtonElement | null>(null);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const taskPath =
    card.opens?.kind === "thread"
      ? (workspace?.nav.threadPath(card.opens.threadId) ??
        `/threads/${encodeURIComponent(card.opens.threadId)}`)
      : null;
  return (
    <div
      className={compact ? "trace-step trace-step--compact agent-step" : "trace-step agent-step"}
      data-agent-key={card.key}
      data-tone={card.tone}
      onContextMenu={
        assignment
          ? (event) => {
              event.preventDefault();
              setMenu(more.current);
            }
          : undefined
      }
    >
      {card.origin === "subagent" ? <LifecycleNews text={card.announcement} /> : null}
      <div className="trace-step__row">
        <RowHead
          label={label}
          onOpen={() => open(card)}
          title={task?.owner ? `${card.title} · ${task.owner}` : card.title}
          to={taskPath}
        >
          <span className="trace-step__icon">
            <AgentMark card={card} />
          </span>
          {compact ? (
            <span className="agent-step__text agent-step__text--one">
              <span className="trace-step__label agent-step__title">{card.title}</span>
              <span className="trace-step__detail agent-step__inline">
                <AgentPhrases phrases={compactPhrases(card)} />
              </span>
            </span>
          ) : (
            <span className="agent-step__text">
              <span className="trace-step__label agent-step__title">{card.title}</span>
              <span className="agent-step__l2">
                <AgentPhrases noun={noun ? card.noun : null} phrases={card.detail} />
              </span>
            </span>
          )}
          <Elapsed
            className="trace-step__duration agent-step__time"
            endedAt={card.endedAt}
            startedAt={card.startedAt}
          />
          <span aria-hidden className="trace-step__chevron">
            <Icon name="chevron-right" />
          </span>
        </RowHead>
        {assignment ? (
          <TaskMore
            anchor={menu}
            assignment={assignment}
            buttonRef={more}
            onAnchor={setMenu}
            title={card.title}
          />
        ) : null}
      </div>
      {children.length > 0 ? (
        <div className="trace-step__lines trace-step__lines--timeline agent-step__lines">
          {children.map((child) => (
            <AgentRow card={child} compact={children.length >= 30} key={child.key} />
          ))}
        </div>
      ) : null}
    </div>
  );
});

/** A subagent's row opens it in place; a task's row is a link to its own conversation. */
function RowHead({
  children,
  label,
  onOpen,
  title,
  to,
}: {
  children: ReactNode;
  label: string;
  onOpen: () => void;
  title: string;
  to: string | null;
}) {
  return to ? (
    <AreaLink
      aria-label={label}
      className="trace-step__head agent-step__head"
      title={title}
      to={to}
    >
      {children}
    </AreaLink>
  ) : (
    <button
      aria-label={label}
      className="trace-step__head agent-step__head"
      onClick={onOpen}
      title={title}
      type="button"
    >
      {children}
    </button>
  );
}

/** The tasks a transcript's rows were drawn from, so a task's row keeps its menu. */
const TaskAssignments = createContext<
  ReadonlyMap<string, { readonly assignment: AssignmentSummary; readonly owner: string | null }>
>(new Map());

/** A task's own actions, beside its row and on a right click: pause, stop, open. */
function TaskMore({
  anchor,
  assignment,
  buttonRef,
  onAnchor,
  title,
}: {
  anchor: HTMLElement | null;
  assignment: AssignmentSummary;
  buttonRef: React.RefObject<HTMLButtonElement | null>;
  onAnchor: (anchor: HTMLElement | null) => void;
  title: string;
}) {
  const { snapshot } = useShell();
  return (
    <>
      <button
        aria-expanded={anchor !== null}
        aria-haspopup="menu"
        aria-label={`More for ${title}`}
        className="icon-btn icon-btn--small agent-step__more"
        onClick={(event) => onAnchor(anchor ? null : event.currentTarget)}
        ref={buttonRef}
        type="button"
      >
        <Icon name="more" />
      </button>
      {anchor ? (
        <TaskMenu
          anchor={anchor}
          assignment={assignment}
          onClose={() => onAnchor(null)}
          presentation={assignmentPresentation(assignment, snapshot)}
        />
      ) : null}
    </>
  );
}

/** A compact row says only where it stands, unless it is working and has said what on. */
function compactPhrases(card: AgentCard): readonly AgentPhrase[] {
  const [first] = card.detail;
  if (card.tone === "working" && first?.tone === "live") return [first];
  if (card.tone === "finished") return card.detail;
  if (card.tone === "needs-you") return [{ text: "Needs you", tone: "attention" }];
  if (card.tone === "failed") return [{ text: "Couldn't finish", tone: "failed" }];
  return [{ text: card.word, tone: "quiet" }];
}

/** A disclosure row on the trace: a group, a workflow or a phase. */
function FoldRow({
  children,
  detail,
  label,
  mark,
  members,
  name,
  noun = null,
  open,
  onToggle,
  time,
}: {
  children: ReactNode;
  detail: readonly AgentPhrase[];
  label: string;
  mark: ReactNode;
  members?: string;
  name: string;
  noun?: string | null;
  open: boolean;
  onToggle: () => void;
  time?: ReactNode;
}) {
  return (
    <div
      className={open ? "trace-step trace-step--open agent-step" : "trace-step agent-step"}
      data-agent-members={members}
    >
      <div className="trace-step__row">
        <button
          aria-expanded={open}
          aria-label={name}
          className="trace-step__head agent-step__head"
          onClick={onToggle}
          type="button"
        >
          <span className="trace-step__icon">{mark}</span>
          <span className="agent-step__text">
            <span className="trace-step__label agent-step__title">{label}</span>
            <span className="agent-step__l2">
              <AgentPhrases noun={noun} phrases={detail} />
            </span>
          </span>
          {time ?? <span className="trace-step__duration agent-step__time" />}
          <span aria-hidden className="trace-step__chevron">
            <Icon name="chevron-right" />
          </span>
        </button>
      </div>
      {open ? (
        <div className="trace-step__lines trace-step__lines--timeline agent-step__lines">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Subagents or tasks that started together: one alone is its own row; several
 * share one row that counts them and opens in place onto the trace's guide.
 * It starts open while any is live; the person's choice holds after that.
 */
export const AgentGroupRow = memo(function AgentGroupRow({ group }: { group: AgentGroup }) {
  const [open, setOpen] = useAgentFold(group.key, group.live);
  const only = group.cards.length === 1 ? group.cards[0] : undefined;
  if (only) return only.workflow ? <WorkflowRow card={only} /> : <AgentRow card={only} noun />;
  const nouns = group.noun === "task" ? "tasks" : "subagents";
  return (
    <FoldRow
      detail={group.detail}
      label={group.label}
      mark={<AgentMark card={group.lead} />}
      members={group.cards.map((card) => card.key).join(" ")}
      name={`${group.name}. ${open ? "Hide" : "Show"} ${nouns}`}
      onToggle={() => setOpen(!open)}
      open={open}
      time={
        <Elapsed
          className="trace-step__duration agent-step__time"
          endedAt={group.endedAt}
          startedAt={group.startedAt}
        />
      }
    >
      {group.cards.map((card) =>
        card.workflow ? (
          <WorkflowRow card={card} key={card.key} />
        ) : (
          <AgentRow card={card} compact={group.compact} key={card.key} />
        ),
      )}
    </FoldRow>
  );
});

/** A workflow: its row, and its phases as numbered rows with their members under them. */
export const WorkflowRow = memo(function WorkflowRow({ card }: { card: AgentCard }) {
  const workflow = card.workflow;
  const [open, setOpen] = useAgentFold(card.key, card.endedAt === null);
  if (!workflow) return null;
  return (
    <FoldRow
      detail={card.detail}
      label={card.title}
      mark={<AgentMark card={card} />}
      members={workflow.phases.flatMap((phase) => phase.members.map((m) => m.key)).join(" ")}
      name={`${agentCardLabel(card, Date.now())}. ${open ? "Hide" : "Show"} phases`}
      noun="Workflow"
      onToggle={() => setOpen(!open)}
      open={open}
      time={
        <Elapsed
          className="trace-step__duration agent-step__time"
          endedAt={card.endedAt}
          startedAt={card.startedAt}
        />
      }
    >
      <WorkflowPhases card={card} />
    </FoldRow>
  );
});

/** A workflow's phases, for its row and for its own opened view. */
export function WorkflowPhases({ card }: { card: AgentCard }) {
  const workflow = card.workflow;
  if (!workflow) return null;
  return (
    <>
      {workflow.phases.map((phase, position) => (
        <PhaseRow
          cardKey={card.key}
          key={phase.index}
          open={workflow.openPhase === phase.index}
          phase={phase}
          position={position + 1}
        />
      ))}
    </>
  );
}

function PhaseRow({
  cardKey,
  open: initial,
  phase,
  position,
}: {
  cardKey: string;
  open: boolean;
  phase: WorkflowView["phases"][number];
  position: number;
}) {
  const [open, setOpen] = useAgentFold(`${cardKey}:phase:${phase.index}`, initial);
  const number = <span className="agent-step__number">{position}</span>;
  if (phase.members.length === 0)
    return (
      <div className="trace-step trace-step--compact agent-step agent-step--pending">
        <div className="trace-step__row">
          <div
            aria-label={agentPhaseLabel(phase, position)}
            className="trace-step__head"
            role="note"
          >
            <span aria-hidden className="trace-step__icon">
              {number}
            </span>
            <span className="trace-step__label agent-step__title">{phase.title}</span>
            <span className="trace-step__detail">
              <AgentPhrases phrases={phase.detail} />
            </span>
          </div>
        </div>
      </div>
    );
  return (
    <FoldRow
      detail={phase.detail}
      label={phase.title}
      mark={number}
      members={phase.members.map((member) => member.key).join(" ")}
      name={`${agentPhaseLabel(phase, position)}. ${open ? "Hide" : "Show"} subagents`}
      onToggle={() => setOpen(!open)}
      open={open}
    >
      {phase.members.map((member) => (
        <AgentRow card={member} compact={phase.members.length >= 30} key={member.key} />
      ))}
    </FoldRow>
  );
}

/* ---- Delegated tasks ---- */

/** The tasks one turn handed out, as rows that open each task's own conversation. */
export function TaskRows({ entries }: { entries: readonly AssignmentEntry[] }) {
  const { snapshot } = useShell();
  const tasks = useMemo(
    () => entries.map((entry) => currentAssignment(entry, snapshot.assignments)),
    [entries, snapshot.assignments],
  );
  const group = useMemo(
    () =>
      tasks.length
        ? subagentGroup(tasks.map((assignment) => assignmentSubagentCard(assignment, snapshot)))
        : null,
    [tasks, snapshot],
  );
  const byId = useMemo(
    () =>
      new Map(
        tasks.map((assignment) => [
          assignment.id,
          { assignment, owner: taskOwner(assignment, snapshot) },
        ]),
      ),
    [tasks, snapshot],
  );
  if (!group) return null;
  return (
    <TaskAssignments value={byId}>
      <div className="agent-tasks turn__content">
        {entries.map((entry) => (
          <ObservedWorker entry={entry} key={entry.id} />
        ))}
        <AgentGroupRow group={group} />
      </div>
    </TaskAssignments>
  );
}
