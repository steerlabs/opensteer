import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  agentCardLabel,
  agentMemberWord,
  agentPhaseLabel,
  assignmentPresentation,
  assignmentSubagentCard,
  currentAssignment,
  formatDuration,
  subagentGroup,
  visibleAgentMembers,
  type AgentCard,
  type AgentGroup,
  type AgentTone,
  type AssignmentEntry,
  type AssignmentTone,
  type WorkflowView,
  taskOwner,
} from "@opensteer/client/host";
import type { AssignmentSummary } from "@opensteer/core";
import { useShell } from "./app-shell.js";
import { SubagentStop } from "./subagent-stop.js";
import { Icon } from "./icon.js";
import { LifecycleNews, ObservedWorker, TaskLineState, TaskMenu } from "./task-line.js";
import { AreaLink } from "./workspace/area-link.js";
import { TaskMark } from "./workspace/task-mark.js";
import { useOptionalWorkspace } from "./workspace/workspace-context.js";

/** Whether the screen still hears its Host: elapsed time stops ticking when it does not. */
export const AgentsLive = createContext(true);

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

/* ---- Returning to the card a view was opened from ---- */

let opener: { readonly threadId: string; readonly key: string } | null = null;

export function rememberOpener(card: AgentCard) {
  const threadId = card.opens?.kind === "subagent" ? card.opens.threadId : null;
  if (threadId) opener = { threadId, key: card.key };
}

/**
 * Back from a subagent's view, the transcript brings the card it was opened
 * from into view and focuses it, or the group header that holds it.
 */
export function useReturnToAgentCard(threadId: string | null) {
  useLayoutEffect(() => {
    if (!opener || opener.threadId !== threadId) return;
    const { key } = opener;
    opener = null;
    const card = document.querySelector<HTMLElement>(
      `[data-agent-key="${CSS.escape(key)}"] .agent-row__open`,
    );
    const target =
      card ??
      document.querySelector<HTMLElement>(
        `[data-agent-members~="${CSS.escape(key)}"] .agent-group__head`,
      );
    target?.scrollIntoView?.({ block: "center" });
    target?.focus({ preventScroll: true });
  }, [threadId]);
}

/* ---- A card ---- */

const dotTones = {
  working: "working",
  "needs-you": "waiting",
  waiting: "queued",
  finished: "completed",
  failed: "failed",
  stopped: "stopped",
} as const satisfies Record<AgentTone, AssignmentTone>;

export function AgentState({ card, word = card.word }: { card: AgentCard; word?: string }) {
  return (
    <span className="agent-state" data-tone={card.tone}>
      <TaskLineState moving={card.moving} tone={dotTones[card.tone]} word={word} />
    </span>
  );
}

export function AgentMark({ card }: { card: AgentCard }) {
  if (card.task) return <TaskMark size={20} mark={card.task.mark} />;
  return <Icon name={card.kind === "workflow" ? "list" : "sparkles"} />;
}

/** Where a card leads: its own view, or a task's conversation. */
export function useAgentDestination(card: Pick<AgentCard, "opens">): string | null {
  const workspace = useOptionalWorkspace();
  const opens = card.opens;
  if (!opens) return null;
  if (opens.kind === "thread")
    return workspace
      ? workspace.nav.threadPath(opens.threadId)
      : `/threads/${encodeURIComponent(opens.threadId)}`;
  return workspace
    ? workspace.nav.subagentPath(opens.threadId, opens.nodeId)
    : `/threads/${encodeURIComponent(opens.threadId)}/subagents/${encodeURIComponent(opens.nodeId)}`;
}

function hoverTitle(card: AgentCard, owner: string | null = null): string {
  return [card.title, owner, card.modelLabel, card.word, card.line?.text]
    .filter(Boolean)
    .join(" · ");
}

/**
 * One helper as one row: its mark, title, where it stands, model and time,
 * and one line of what it is doing. The link covers the row, so anything on
 * it opens the helper; a task's More sits above the link.
 */
export function AgentRow({
  card,
  menuOpen = false,
  more = null,
  onContextMenu,
  owner = null,
}: {
  card: AgentCard;
  /** Who does a delegated task, named in its label and tooltip. */
  owner?: string | null;
  menuOpen?: boolean;
  more?: ReactNode;
  onContextMenu?: (event: React.MouseEvent) => void;
}) {
  const to = useAgentDestination(card);
  const kind = card.origin === "task" ? "Task" : card.kind === "workflow" ? "Workflow" : null;
  const line = card.line;
  return (
    <div
      className={[
        "agent-row",
        line ? "" : "agent-row--single-line",
        menuOpen ? "agent-row--menu" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-tone={card.tone}
      onContextMenu={onContextMenu}
    >
      <span aria-hidden className="agent-row__mark">
        <AgentMark card={card} />
      </span>
      <span className="agent-row__head">
        {to ? (
          <AreaLink
            aria-label={agentCardLabel(card, Date.now(), owner)}
            className="agent-row__open agent-row__title"
            onClick={() => rememberOpener(card)}
            title={hoverTitle(card, owner)}
            to={to}
          >
            {card.title}
          </AreaLink>
        ) : (
          <span className="agent-row__title" title={hoverTitle(card)}>
            {card.title}
          </span>
        )}
        {kind ? <span className="agent-kind">{kind}</span> : null}
        <AgentState card={card} />
      </span>
      <span className="agent-row__end">
        {card.modelLabel ? <span className="agent-row__model">{card.modelLabel}</span> : null}
        <Elapsed className="agent-row__time" endedAt={card.endedAt} startedAt={card.startedAt} />
        {more ?? (card.origin === "subagent" ? <SubagentStop card={card} /> : null)}
      </span>
      <span aria-hidden className="agent-row__chevron">
        {to ? <Icon name="chevron-right" /> : null}
      </span>
      {line ? (
        <span
          className={`agent-row__line${line.kind === "progress" && card.moving ? " trace-step__detail--live" : ""}`}
          data-kind={line.kind}
          key={line.kind === "progress" && card.moving ? line.text : undefined}
        >
          <span className="agent-row__lead">
            <AgentState card={card} />
            <span aria-hidden>·</span>
          </span>
          {line.text}
        </span>
      ) : null}
    </div>
  );
}

/* ---- A workflow ---- */

function WorkflowBody({ card }: { card: AgentCard }) {
  const workflow = card.workflow;
  return (
    <>
      <AgentRow card={card} />
      {workflow?.phases.map((phase) => (
        <WorkflowPhase
          cardKey={card.key}
          key={phase.index}
          openPhase={workflow.openPhase}
          phase={phase}
        />
      ))}
    </>
  );
}

function WorkflowPhase({
  cardKey,
  openPhase,
  phase,
}: {
  cardKey: string;
  openPhase: number | null;
  phase: WorkflowView["phases"][number];
}) {
  const [open, setOpen] = useAgentFold(
    `${cardKey}:phase:${phase.index}`,
    openPhase === phase.index,
  );
  const [all, setAll] = useAgentFold(`${cardKey}:phase:${phase.index}:all`, false);
  const { cards, remaining } = visibleAgentMembers(phase.members, all);
  return (
    <>
      <button
        aria-expanded={open}
        aria-label={agentPhaseLabel(phase)}
        className="agent-phase"
        onClick={() => setOpen(!open)}
        type="button"
      >
        <span aria-hidden className="agent-chevron">
          <Icon name="chevron-right" />
        </span>
        <span aria-hidden className="agent-phase__number">
          {phase.index + 1}
        </span>
        <span aria-hidden className="agent-phase__title">
          {phase.title}
        </span>
        <span aria-hidden className="agent-phase__count" data-tone={phase.tone}>
          {phase.word} · {phase.settled}/{phase.total}
        </span>
      </button>
      {open ? (
        <div className="agent-phase__members">
          {cards.map((member) => (
            <WorkflowMember card={member} key={member.key} />
          ))}
          {remaining > 0 ? (
            <button
              className="agent-more agent-more--member"
              onClick={() => setAll(true)}
              type="button"
            >
              Show {remaining} more
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function WorkflowMember({ card }: { card: AgentCard }) {
  const to = useAgentDestination(card);
  return (
    <div className="agent-member" data-agent-key={card.key} data-tone={card.tone}>
      <AgentState card={card} word={agentMemberWord(card)} />
      {to ? (
        <AreaLink
          aria-label={agentCardLabel(card, Date.now())}
          className="agent-row__open agent-member__title"
          onClick={() => rememberOpener(card)}
          title={hoverTitle(card)}
          to={to}
        >
          {card.title}
        </AreaLink>
      ) : (
        <span className="agent-member__title">{card.title}</span>
      )}
      <Elapsed className="agent-row__time" endedAt={card.endedAt} startedAt={card.startedAt} />
      <span aria-hidden className="agent-row__chevron">
        {to ? <Icon name="chevron-right" /> : null}
      </span>
    </div>
  );
}

/** A workflow's phases on their own plate, for the workflow's own view. */
export function WorkflowPhases({ card }: { card: AgentCard }) {
  const workflow = card.workflow;
  if (!workflow || workflow.phases.length === 0) return null;
  return (
    <AgentFolds>
      <div className="agent-card agent-card--phases">
        {workflow.phases.map((phase) => (
          <WorkflowPhase
            cardKey={card.key}
            key={phase.index}
            openPhase={workflow.openPhase}
            phase={phase}
          />
        ))}
      </div>
    </AgentFolds>
  );
}

/* ---- Cards, groups and lists ---- */

type RowRenderer = (card: AgentCard) => ReactNode;

const defaultRow: RowRenderer = (card) =>
  card.kind === "workflow" ? <WorkflowBody card={card} /> : <AgentRow card={card} />;

/** One helper alone: the plate with its one row, and a workflow with its phases. */
export function AgentCardView({
  card,
  renderRow = defaultRow,
}: {
  card: AgentCard;
  renderRow?: RowRenderer;
}) {
  return (
    <div className="agent-card" data-agent-key={card.key}>
      {card.origin === "subagent" ? <LifecycleNews text={card.announcement} /> : null}
      {renderRow(card)}
    </div>
  );
}

function GroupSummary({ summary }: { summary: string }) {
  const [noun, ...counts] = summary.split(" · ");
  return (
    <span className="agent-group__summary">
      <span className="agent-group__noun">{noun}</span>
      {counts.map((count) => (
        <Fragment key={count}>
          {" · "}
          <span className={count.endsWith(" you") ? "agent-group__attention" : undefined}>
            {count}
          </span>
        </Fragment>
      ))}
    </span>
  );
}

/**
 * Helpers that started together. One alone has no header; several share a
 * plate whose header counts them and opens or closes the list. It starts open
 * while any is live; the person's choice holds after that.
 */
export function AgentGroupView({
  group,
  renderRow = defaultRow,
}: {
  group: AgentGroup;
  renderRow?: RowRenderer;
}) {
  const [open, setOpen] = useAgentFold(group.key, group.live);
  const [all, setAll] = useAgentFold(`${group.key}:all`, false);
  const only = group.cards.length === 1 ? group.cards[0] : undefined;
  if (only) return <AgentCardView card={only} renderRow={renderRow} />;
  const { cards, remaining } = visibleAgentMembers(group.cards, all);
  return (
    <div
      aria-label={group.summary}
      className={
        group.live ? "agent-card agent-group" : "agent-card agent-group agent-group--settled"
      }
      data-agent-members={group.cards.map((card) => card.key).join(" ")}
      role="group"
    >
      {group.cards.map((card) =>
        card.origin === "subagent" ? (
          <LifecycleNews key={card.key} text={card.announcement} />
        ) : null,
      )}
      <button
        aria-expanded={open}
        aria-label={group.summary}
        className="agent-group__head"
        onClick={() => setOpen(!open)}
        title={group.summary}
        type="button"
      >
        <span aria-hidden className="agent-group__glyph">
          <Icon name="users" />
        </span>
        <GroupSummary summary={group.summary} />
        <Elapsed
          className="agent-group__time"
          endedAt={group.endedAt}
          startedAt={group.startedAt}
        />
        <span aria-hidden className="agent-chevron">
          <Icon name="chevron-right" />
        </span>
      </button>
      {open ? (
        <div className="agent-group__body">
          {cards.map((card) => (
            <div className="agent-list__item" data-agent-key={card.key} key={card.key}>
              {renderRow(card)}
            </div>
          ))}
          {remaining > 0 ? (
            <button className="agent-more" onClick={() => setAll(true)} type="button">
              Show {remaining} more
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ---- Delegated tasks ---- */

/** The tasks one turn handed out, as agent cards that keep the task's menu. */
export function TaskCards({ entries }: { entries: readonly AssignmentEntry[] }) {
  const { snapshot } = useShell();
  const tasks = useMemo(
    () =>
      entries.map((entry) => {
        const assignment = currentAssignment(entry, snapshot.assignments);
        return { entry, assignment, card: assignmentSubagentCard(assignment, snapshot) };
      }),
    [entries, snapshot],
  );
  const byKey = useMemo(() => new Map(tasks.map((task) => [task.card.key, task])), [tasks]);
  if (tasks.length === 0) return null;
  return (
    <div className="agent-tasks">
      {tasks.map(({ entry }) => (
        <ObservedWorker entry={entry} key={entry.id} />
      ))}
      <AgentGroupView
        group={subagentGroup(tasks.map(({ card }) => card))}
        renderRow={(card) => {
          const task = byKey.get(card.key);
          return task ? <TaskAgentRow assignment={task.assignment} card={card} /> : null;
        }}
      />
    </div>
  );
}

function TaskAgentRow({ assignment, card }: { assignment: AssignmentSummary; card: AgentCard }) {
  const { snapshot } = useShell();
  const [menuOpen, setMenuOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <AgentRow
        card={card}
        owner={taskOwner(assignment, snapshot)}
        menuOpen={menuOpen}
        more={
          <button
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            aria-label={`More for ${card.title}`}
            className="agent-row__more"
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
      />
      {menuOpen && moreRef.current ? (
        <TaskMenu
          anchor={moreRef.current}
          assignment={assignment}
          onClose={() => setMenuOpen(false)}
          presentation={assignmentPresentation(assignment, snapshot)}
        />
      ) : null}
    </>
  );
}

/** A roster row: the card's mark, title and one line, and where it stands. */
export function AgentRosterRow({ card, onOpen }: { card: AgentCard; onOpen: () => void }) {
  const to = useAgentDestination(card);
  const content = (
    <>
      <span aria-hidden className="agent-roster__mark">
        <AgentMark card={card} />
      </span>
      <span className="task-family__text">
        <span className="task-family__title">{card.title}</span>
        {card.line ? (
          <span className="picker__detail" data-kind={card.line.kind}>
            {card.line.text}
          </span>
        ) : null}
      </span>
      <span className="task-family__state">
        <AgentState card={card} />
      </span>
    </>
  );
  return to ? (
    <AreaLink
      aria-label={agentCardLabel(card, Date.now())}
      className="task-family__row picker__row agent-roster__row"
      onClick={() => {
        rememberOpener(card);
        onOpen();
      }}
      title={hoverTitle(card)}
      to={to}
    >
      {content}
    </AreaLink>
  ) : (
    <div className="task-family__row picker__row agent-roster__row">{content}</div>
  );
}
