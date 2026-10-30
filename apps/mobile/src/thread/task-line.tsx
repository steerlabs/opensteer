import {
  assignmentTitle,
  assignmentMark,
  assignmentPresentation,
  assignmentRequester,
  assignmentStatusLine,
  currentAssignment,
  delegationPresentation,
  requestWaitingOnAssignment,
  taskGroupSummary,
  taskRowNote,
  threadMark,
  type AssignmentEntry,
  type AssignmentPresentation,
  type AssignmentTone,
  type DelegationEntry,
  type HostClient,
  type HostSnapshot,
  type TaskMark as ResolvedTaskMark,
} from "@opensteer/client/host";
import { useActionReview, useHostSelector } from "@opensteer/client/react";
import { MenuView } from "@expo/ui/community/menu";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo, Alert, Pressable, StyleSheet, View } from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import { color, radius, space, touchTarget } from "../theme.js";
import { ActionReviewSheet } from "../ui/action-review.js";
import { AppText, StatusDot } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { TaskMark } from "../ui/task-mark.js";

/** What task lines need from the pane that owns the Host client. */
export interface TaskScope {
  readonly hostClient: HostClient;
  /** Opens a task's own Thread over this one, so back returns here. */
  readonly onViewWork: (threadId: string) => void;
  /**
   * The question this pane already shows above its composer, by id. A task
   * held up by it says only "Needs you", so the question is not read twice.
   */
  readonly dockedRequestId: string | null;
}

export const TaskScopeContext = createContext<TaskScope | null>(null);

const selectSnapshot = (snapshot: HostSnapshot): HostSnapshot => snapshot;

/**
 * Work handed to other Threads, under the turn that handed it out: one quiet
 * line per task — its mark, its title, a dot and a word for where it stands —
 * that changes in place. A tap opens the task's own screen, and back returns
 * here; a long press offers what else it can do. Tasks one turn handed out
 * together read as one line until opened in place. Lines read the Host
 * themselves, since transcript rows are memoized on their entries and a task
 * moves without touching its entry.
 */
export function AssignmentLines(props: {
  readonly entries: readonly AssignmentEntry[];
}): ReactNode {
  const scope = useContext(TaskScopeContext);
  if (scope === null || props.entries.length === 0) return null;
  return props.entries.length === 1 ? (
    <>
      <ObservedWorker entry={props.entries[0]!} scope={scope} />
      <AssignmentLine entry={props.entries[0]!} scope={scope} />
    </>
  ) : (
    <LineGroup entries={props.entries} scope={scope} />
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

/** A task's presentation, without the question this pane already shows above its composer. */
function linePresentation(
  snapshot: HostSnapshot,
  entry: AssignmentEntry,
  dockedRequestId: string | null,
) {
  const assignment = currentAssignment(entry, snapshot.assignments);
  const asked = assignmentPresentation(assignment, snapshot);
  const docked =
    asked.detail?.kind === "decision" &&
    dockedRequestId !== null &&
    requestWaitingOnAssignment(snapshot.waitingRequests, assignment.id)?.request.id ===
      dockedRequestId;
  return { assignment, presentation: docked ? { ...asked, detail: null } : asked };
}

function AssignmentLine(props: {
  readonly entry: AssignmentEntry;
  readonly scope: TaskScope;
}): ReactNode {
  const { hostClient, onViewWork } = props.scope;
  const snapshot = useHostSelector(hostClient, selectSnapshot);
  const { assignment, presentation } = linePresentation(
    snapshot,
    props.entry,
    props.scope.dockedRequestId,
  );
  const workerThreadId = assignment.workerThread.id;
  const { open } = presentation;
  const title = assignmentTitle(assignment, snapshot);
  const status = assignmentStatusLine(assignment, presentation);
  // Who does it is said, not drawn: the line keeps to the task's own mark.
  const worker = snapshot.threads.find(({ id }) => id === workerThreadId);
  const workspaceId = worker?.workspaceId ?? assignment.workerThread.workspaceId;
  const workspace = snapshot.workspaces.find(({ id }) => id === workspaceId) ?? null;
  const main = workspaceId === snapshot.homeWorkspaceId || workspace?.kind === "main";
  const owner = main ? "Opensteer" : (workspace?.name ?? null);
  const stop = useAssignmentStop(hostClient, {
    assignmentId: assignment.id,
    requester: assignmentRequester(assignment, snapshot),
    title,
  });
  const canStop = open && presentation.stopBlocked === null;
  return (
    <>
      {stop.sheet}
      <MenuView
        actions={[
          { id: "open", image: "arrow.up.right", title: "Open Task" },
          ...(open
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
        <TaskLine
          accessibilityActions={canStop ? [{ label: "Stop task", name: "stop" }] : []}
          accessibilityLabel={[title, owner, status].filter((part) => part !== null).join(", ")}
          mark={assignmentMark(assignment, snapshot)}
          onAccessibilityAction={(name) => {
            if (name === "stop") stop.ask();
          }}
          onPress={() => onViewWork(workerThreadId)}
          presentation={presentation}
          title={title}
        />
      </MenuView>
    </>
  );
}

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

/** Only these say anything in a group's counts; the rest are the quiet default. */
const signalTones = new Set<AssignmentTone>(["failed", "waiting", "working"]);

/**
 * Tasks one turn handed out together, as one line: their marks stacked, how
 * many, and how many read each word. A tap opens it in place to a line for
 * each; every open one stays observed while it is closed.
 */
function LineGroup(props: {
  readonly entries: readonly AssignmentEntry[];
  readonly scope: TaskScope;
}): ReactNode {
  const snapshot = useHostSelector(props.scope.hostClient, selectSnapshot);
  const [open, setOpen] = useState(false);
  const lines = props.entries.map((entry) =>
    linePresentation(snapshot, entry, props.scope.dockedRequestId),
  );
  const summary = taskGroupSummary(lines.map(({ presentation }) => presentation));
  const counts = summary.parts.map(({ text }) => text).join(", ");
  return (
    <View>
      {props.entries.map((entry) => (
        <ObservedWorker entry={entry} key={entry.id} scope={props.scope} />
      ))}
      <Pressable
        accessibilityHint={open ? "Hides the tasks" : "Shows the tasks"}
        accessibilityLabel={`${summary.label}: ${counts}`}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        style={({ pressed }) => [styles.line, pressed && styles.linePressed]}
      >
        <View style={styles.lineRow}>
          <View style={styles.stack}>
            {lines.slice(0, 3).map(({ assignment }, index) => (
              <View
                key={assignment.id}
                style={[styles.stackMark, index > 0 && styles.stackMarkOverlap]}
              >
                <TaskMark mark={assignmentMark(assignment, snapshot)} size={16} />
              </View>
            ))}
          </View>
          <AppText numberOfLines={1} role="secondaryMedium" tone="soft">
            {summary.label}
          </AppText>
          <View style={styles.groupCounts}>
            {summary.parts.map((part, index) => (
              <View key={part.text} style={styles.state}>
                {index > 0 ? (
                  <AppText role="caption" tone="muted">
                    ·
                  </AppText>
                ) : null}
                {signalTones.has(part.tone) ? (
                  <TaskDot moving={part.moving} tone={part.tone} />
                ) : null}
                <AppText numberOfLines={1} role="caption" tone="muted">
                  {part.text}
                </AppText>
              </View>
            ))}
          </View>
          <View style={styles.chevron}>
            <Symbol
              name={open ? "chevron.down" : "chevron.right"}
              size={11}
              tint={color.mutedDim}
            />
          </View>
        </View>
      </Pressable>
      {open ? (
        <View style={styles.groupLines}>
          {props.entries.map((entry) => (
            <AssignmentLine entry={entry} key={entry.id} scope={props.scope} />
          ))}
        </View>
      ) : null}
    </View>
  );
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
  // A narrow pane wraps a group's counts between parts, keeping its label and chevron in view.
  groupCounts: {
    alignItems: "center",
    columnGap: space[6],
    flexDirection: "row",
    flexShrink: 1,
    flexWrap: "wrap",
    minWidth: 0,
    rowGap: space[2],
  },
  groupLines: { paddingLeft: space[28] },
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
  stack: { flexDirection: "row" },
  stackMark: {
    alignItems: "center",
    backgroundColor: color.surfaceElevated,
    borderColor: color.background,
    borderRadius: radius.full,
    borderWidth: 2,
    height: 24,
    justifyContent: "center",
    width: 24,
  },
  stackMarkOverlap: { marginLeft: -space[6] },
  state: { alignItems: "center", flexDirection: "row", flexShrink: 0, gap: space[6] },
  title: { flexShrink: 1 },
});
