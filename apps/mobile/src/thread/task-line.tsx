import {
  assignmentPresentation,
  taskOwner,
  assignmentRequester,
  assignmentSubagentCard,
  currentAssignment,
  delegationPresentation,
  subagentGroup,
  subagentTurnModel,
  SubagentCache,
  taskRowNote,
  threadMark,
  type AgentCard,
  type AssignmentEntry,
  type AssignmentPresentation,
  type AssignmentTone,
  type DelegationEntry,
  type HostClient,
  type HostSnapshot,
  type TaskMark as ResolvedTaskMark,
  type Turn,
  type TurnAgents,
} from "@opensteer/client/host";
import { useActionReview, useHostSelector } from "@opensteer/client/react";
import { MenuView } from "@expo/ui/community/menu";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { AccessibilityInfo, Alert, Pressable, StyleSheet, View } from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import { color, radius, space, touchTarget } from "../theme.js";
import { ActionReviewSheet } from "../ui/action-review.js";
import { ChatOrb } from "../ui/chat-orb.js";
import { AppText, StatusDot } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { TaskMark } from "../ui/task-mark.js";
import {
  AgentGroupRow,
  AgentMemoryContext,
  AgentScopeProvider,
  AgentStep,
  AgentsLive,
  type AgentScope,
} from "./subagent-rows.js";
import { heldSelector } from "./agent-select.js";

/** What task and subagent cards need from the pane that owns the Host client. */
export interface TaskScope {
  readonly hostClient: HostClient;
  /** The conversation these cards stand in. */
  readonly threadId: string;
  /** Opens a task's own Thread over this one, so back returns here. */
  readonly onViewWork: (threadId: string) => void;
  /** Opens a subagent's own read-only view over this one. */
  readonly onOpenSubagent: (threadId: string, nodeId: string) => void;
  /** Whether this conversation is in front of the reader, so a helper's news is said aloud. */
  readonly focused: boolean;
}

export const TaskScopeContext = createContext<TaskScope | null>(null);

const selectSnapshot = (snapshot: HostSnapshot): HostSnapshot => snapshot;

/**
 * Where a row goes: a task opens its conversation, a subagent or workflow
 * its own view. Null outside a pane that holds the Host.
 */
export function useAgentScope(): AgentScope | null {
  const scope = useContext(TaskScopeContext);
  return useMemo(
    () =>
      scope === null
        ? null
        : {
            hostClient: scope.hostClient,
            onOpen: (card: AgentCard) => {
              if (card.opens === null) return;
              if (card.opens.kind === "thread") scope.onViewWork(card.opens.threadId);
              else scope.onOpenSubagent(card.opens.threadId, card.opens.nodeId);
            },
          },
    [scope],
  );
}

/**
 * A turn's helpers as the subagent model draws them, read from the Host so a
 * memoized transcript row still moves as they do. Folded, the ones still at
 * work are kept outside the fold, and stay kept for as long as the pane is.
 * One subagent's progress leaves every other row the same object, so only
 * its row draws again.
 */
export function useTurnAgents(scope: TaskScope, turn: Turn, folded: boolean): TurnAgents | null {
  const memory = useContext(AgentMemoryContext);
  const cache = useMemo(() => new SubagentCache(), []);
  const select = useMemo(() => {
    const own: Turn = { ...turn, assignments: [] };
    const drawn = turn.work.some((entry) => entry.kind === "node" && entry.nodeKind !== "task");
    if (!drawn) return noAgents;
    return heldSelector((snapshot): TurnAgents | null => {
      const keptKeys = turn.work.flatMap((entry) =>
        entry.kind === "node" && memory.get(`kept:node:${entry.nodeId}`) === true
          ? [`node:${entry.nodeId}`]
          : [],
      );
      const agents = subagentTurnModel(own, scope.threadId, snapshot, { folded, keptKeys }, cache);
      if (folded) for (const key of agents.keptKeys) memory.set(`kept:${key}`, true);
      return agents;
    });
  }, [cache, folded, memory, scope.threadId, turn]);
  return useHostSelector(scope.hostClient, select, sameTurnAgents);
}

const noAgents = (): null => null;

function sameTurnAgents(left: TurnAgents | null, right: TurnAgents | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.foldLabel === right.foldLabel &&
    left.keptOutside === right.keptOutside &&
    left.rows.length === right.rows.length &&
    left.rows.every((row, index) => {
      const other = right.rows[index];
      if (other === undefined || other.kind !== row.kind) return false;
      if (row.kind === "work") return other.kind === "work" && row.entry === other.entry;
      if (row.kind === "agents") return other.kind === "agents" && row.group === other.group;
      return other.kind === "workflow" && row.card === other.card;
    })
  );
}

/**
 * Work handed to other Threads, under the turn that handed it out: one task
 * is its card, several share a group. A tap opens the task's own screen, and
 * back returns here; a long press offers what else it can do. Cards read the
 * Host themselves, since transcript rows are memoized on their entries and a
 * task moves without touching its entry.
 */
export function TaskCards(props: {
  readonly entries: readonly AssignmentEntry[];
  readonly live: boolean;
}): ReactNode {
  const scope = useContext(TaskScopeContext);
  const agents = useAgentScope();
  if (scope === null || agents === null || props.entries.length === 0) return null;
  return (
    <>
      {props.entries.map((entry) => (
        <ObservedWorker entry={entry} key={entry.id} scope={scope} />
      ))}
      <AgentsLive value={props.live}>
        <HeldTaskCards agents={agents} entries={props.entries} scope={scope} />
      </AgentsLive>
    </>
  );
}

function HeldTaskCards(props: {
  readonly agents: AgentScope;
  readonly entries: readonly AssignmentEntry[];
  readonly scope: TaskScope;
}): ReactNode {
  const { agents, entries, scope } = props;
  const cache = useMemo(() => new SubagentCache(), []);
  const select = useMemo(
    () =>
      heldSelector((snapshot) =>
        cache.keep(
          "tasks",
          subagentGroup(
            entries.map((entry) =>
              assignmentSubagentCard(
                currentAssignment(entry, snapshot.assignments),
                snapshot,
                cache,
              ),
            ),
          ),
        ),
      ),
    [cache, entries],
  );
  const group = useHostSelector(scope.hostClient, select);
  const byId = useMemo(
    () => new Map<string, AssignmentEntry>(entries.map((entry) => [entry.assignment.id, entry])),
    [entries],
  );
  const withTasks = useMemo<AgentScope>(
    () => ({
      ...agents,
      renderTask: (card, row) => {
        const entry = card.task === null ? undefined : byId.get(card.task.assignmentId);
        return entry === undefined ? (
          <AgentStep {...row} card={card} />
        ) : (
          <TaskCardRow {...row} card={card} entry={entry} scope={scope} />
        );
      },
    }),
    [agents, byId, scope],
  );
  return (
    <AgentScopeProvider value={withTasks}>
      <AgentGroupRow group={group} />
    </AgentScopeProvider>
  );
}

/**
 * A Thread's own mark, as the task list draws it: Chat's orb, or the task's
 * subject. Nothing without the Host to read it from.
 */
export function ThreadMark(props: { readonly threadId: string }): ReactNode {
  const scope = useContext(TaskScopeContext);
  return scope === null ? null : (
    <HeldThreadMark hostClient={scope.hostClient} threadId={props.threadId} />
  );
}

function HeldThreadMark(props: {
  readonly hostClient: HostClient;
  readonly threadId: string;
}): ReactNode {
  const { threadId } = props;
  const mark = useHostSelector(
    props.hostClient,
    (snapshot) => (snapshot.homeThreadId === threadId ? null : threadMark(threadId, snapshot)),
    sameMark,
  );
  return mark === null ? <ChatOrb size={16} /> : <TaskMark mark={mark} size={16} />;
}

function sameMark(left: ResolvedTaskMark | null, right: ResolvedTaskMark | null): boolean {
  return (
    left === right ||
    (left !== null && right !== null && left.icon === right.icon && left.color === right.color)
  );
}

/**
 * Keeps an open task's worker observed, so its state and current step arrive
 * wherever the task works.
 */
function useObservedWorker(
  hostClient: HostClient,
  assignment: { readonly status: string; readonly workerThread: { readonly id: string } },
): void {
  const open = assignment.status === "open";
  const workerThreadId = assignment.workerThread.id;
  useEffect(
    () => (open ? hostClient.observeThread(workerThreadId) : undefined),
    [hostClient, open, workerThreadId],
  );
}

/**
 * What a task keeps doing whether or not its line is drawn: its worker stays
 * observed, and a change in where it stands is said aloud. One per task, so a
 * closed group still speaks and an opened one never twice.
 */
function ObservedWorker(props: { readonly entry: AssignmentEntry; readonly scope: TaskScope }) {
  const snapshot = useHostSelector(props.scope.hostClient, selectSnapshot);
  const assignment = currentAssignment(props.entry, snapshot.assignments);
  useObservedWorker(props.scope.hostClient, assignment);
  useLifecycleNews(assignmentPresentation(assignment, snapshot).announcement);
  return null;
}

/** A task's row, with the menu its line always had: open it, or stop it after asking. */
function TaskCardRow(props: {
  readonly card: AgentCard;
  readonly compact?: boolean;
  readonly noun?: boolean;
  readonly entry: AssignmentEntry;
  readonly scope: TaskScope;
}): ReactNode {
  const { card, scope } = props;
  const { hostClient, onViewWork } = scope;
  const snapshot = useHostSelector(hostClient, selectSnapshot);
  const assignment = currentAssignment(props.entry, snapshot.assignments);
  const presentation = assignmentPresentation(assignment, snapshot);
  const workerThreadId = assignment.workerThread.id;
  const stop = useAssignmentStop(hostClient, {
    assignmentId: assignment.id,
    requester: assignmentRequester(assignment, snapshot),
    title: card.title,
  });
  const canStop = presentation.open && presentation.stopBlocked === null;
  const onAccessibilityAction = useCallback(
    (name: string) => {
      if (name === "stop") stop.ask();
    },
    [stop],
  );
  return (
    <>
      {stop.sheet}
      <MenuView
        actions={[
          { id: "open", image: "arrow.up.right", title: "Open Task" },
          ...(presentation.open
            ? [
                {
                  attributes: { destructive: true, disabled: !canStop },
                  id: "stop",
                  image: "stop" as const,
                  title: "Stop Task…",
                  ...(presentation.stopBlocked ? { subtitle: presentation.stopBlocked } : {}),
                },
              ]
            : []),
        ]}
        colorScheme="dark"
        onPressAction={({ nativeEvent }) => {
          if (nativeEvent.event === "open") onViewWork(workerThreadId);
          if (nativeEvent.event === "stop" && canStop) stop.ask();
        }}
        shouldOpenOnLongPress
        style={styles.menu}
      >
        <AgentStep
          accessibilityActions={canStop ? stopAction : noActions}
          card={card}
          compact={props.compact === true}
          noun={props.noun === true}
          onAccessibilityAction={onAccessibilityAction}
          owner={taskOwner(assignment, snapshot)}
        />
      </MenuView>
    </>
  );
}

const stopAction = [{ label: "Stop task", name: "stop" }] as const;
const noActions = [] as const;

/** The line every task shares: only the dot and the word change as it moves. */
function TaskLine(props: {
  readonly accessibilityActions?: readonly { readonly label: string; readonly name: string }[];
  readonly accessibilityLabel: string;
  readonly mark: ResolvedTaskMark;
  readonly onAccessibilityAction?: (name: string) => void;
  readonly onPress: () => void;
  readonly presentation: AssignmentPresentation;
  readonly title: string;
}): ReactNode {
  const { presentation } = props;
  const note = taskRowNote(presentation);
  return (
    <Pressable
      accessibilityActions={props.accessibilityActions ?? []}
      accessibilityHint="Opens the task"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="link"
      onAccessibilityAction={({ nativeEvent }) =>
        props.onAccessibilityAction?.(nativeEvent.actionName)
      }
      onPress={props.onPress}
      style={({ pressed }) => [styles.line, pressed && styles.linePressed]}
    >
      <View style={styles.lineRow}>
        <TaskMark mark={props.mark} size={20} />
        <AppText numberOfLines={1} role="secondaryMedium" style={styles.title} tone="soft">
          {props.title}
        </AppText>
        <LineState moving={presentation.moving} tone={presentation.tone} word={presentation.word} />
        <View style={styles.chevron}>
          <Symbol name="chevron.right" size={11} tint={color.mutedDim} />
        </View>
      </View>
      {note === null ? null : (
        <AppText
          role={note.kind === "decision" ? "secondary" : "caption"}
          style={styles.note}
          tone={note.kind === "decision" ? "default" : "muted"}
        >
          {note.text}
        </AppText>
      )}
    </Pressable>
  );
}

function LineState(props: {
  readonly moving: boolean;
  readonly tone: AssignmentTone;
  readonly word: string;
}): ReactNode {
  return (
    <View style={styles.state}>
      <TaskDot moving={props.moving} tone={props.tone} />
      <AppText numberOfLines={1} role="caption" tone="muted">
        {props.word}
      </AppText>
    </View>
  );
}

/** A task's state at a glance: the colour says its tone, and only work under way now breathes. */
function TaskDot(props: { readonly moving: boolean; readonly tone: AssignmentTone }): ReactNode {
  return <StatusDot live={props.moving} size={6} tone={dotTone(props.tone)} />;
}

function dotTone(tone: AssignmentTone): "amber" | "ember" | "muted" | "red" {
  switch (tone) {
    case "working":
      return "ember";
    case "waiting":
      return "amber";
    case "failed":
      return "red";
    case "completed":
    case "paused":
    case "queued":
    case "stopped":
      return "muted";
  }
}

/**
 * Work handed out before Assignments existed, in the same line. Its task,
 * its result and the pages its Run used are all in its own Thread, which a
 * tap opens; the line says only how it ended.
 */
export function DelegationLine(props: {
  readonly delegation: DelegationEntry;
  readonly onOpenThread: (threadId: string) => void;
}): ReactNode {
  const scope = useContext(TaskScopeContext);
  return scope === null ? (
    <DelegationLineFrom {...props} snapshot={nothingHeld} />
  ) : (
    <HeldDelegationLine {...props} hostClient={scope.hostClient} />
  );
}

function HeldDelegationLine(props: {
  readonly delegation: DelegationEntry;
  readonly hostClient: HostClient;
  readonly onOpenThread: (threadId: string) => void;
}): ReactNode {
  const snapshot = useHostSelector(props.hostClient, selectSnapshot);
  return <DelegationLineFrom {...props} snapshot={snapshot} />;
}

const nothingHeld = { activeTasks: [], tasks: null, threads: [], workspaceTasks: {} };

function DelegationLineFrom(props: {
  readonly delegation: DelegationEntry;
  readonly onOpenThread: (threadId: string) => void;
  readonly snapshot: Pick<HostSnapshot, "activeTasks" | "tasks" | "threads" | "workspaceTasks">;
}): ReactNode {
  const { delegation, snapshot } = props;
  const presentation = delegationPresentation(delegation, snapshot);
  const childThreadId = delegation.childThread.id;
  const title =
    snapshot.threads.find(({ id }) => id === childThreadId)?.title ?? delegation.childThread.title;
  return (
    <TaskLine
      accessibilityLabel={`${title}, ${presentation.word}`}
      mark={threadMark(childThreadId, snapshot)}
      onPress={() => props.onOpenThread(childThreadId)}
      presentation={presentation}
      title={title}
    />
  );
}

/**
 * Stopping ends the task for good and tells the conversation that asked, so
 * a controlled native sheet asks first and dismisses when that task state ends. The task then shows whatever
 * the Host settled on, which may be a result that got there first. The line
 * in that conversation and the task's own title both stop it this way.
 */
export function useAssignmentStop(
  hostClient: HostClient,
  task: { readonly assignmentId: string; readonly requester: string; readonly title: string },
) {
  const { review, ask, dismiss } = useActionReview(hostClient);
  const { assignmentId, requester, title } = task;
  return {
    ask: () => ask({ kind: "stop-assignment", assignmentId }),
    sheet: (
      <ActionReviewSheet
        review={review}
        title={`Stop ${title}?`}
        detail={`It stops for good, and ${requester} is told. Nothing it already did is undone.`}
        confirmLabel="Stop task"
        cancelLabel="Keep working"
        onClose={dismiss}
        onError={(error) =>
          Alert.alert(`${title} was not stopped`, operationDetail(error, "Try again."))
        }
      />
    ),
  };
}

/**
 * A lifecycle change, said once. The transcript announces a row when it
 * arrives; a task that changes in place would otherwise change silently.
 */
export function useLifecycleNews(text: string): void {
  const said = useRef(text);
  useEffect(() => {
    if (said.current === text) return;
    said.current = text;
    if (text !== "") AccessibilityInfo.announceForAccessibility(text);
  }, [text]);
}

const styles = StyleSheet.create({
  chevron: { marginLeft: "auto" },
  line: {
    borderRadius: radius.sm,
    gap: space[2],
    justifyContent: "center",
    marginHorizontal: -space[8],
    minHeight: touchTarget,
    paddingHorizontal: space[8],
    paddingVertical: space[4],
  },
  lineRow: { alignItems: "center", flexDirection: "row", gap: space[8] },
  linePressed: { backgroundColor: color.surfacePressed },
  menu: { alignSelf: "stretch" },
  note: { marginLeft: space[28] },
  state: { alignItems: "center", flexDirection: "row", flexShrink: 0, gap: space[6] },
  title: { flexShrink: 1 },
});
