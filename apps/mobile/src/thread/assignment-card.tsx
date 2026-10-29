import {
  assignmentTitle,
  assignmentMark,
  assignmentPresentation,
  assignmentRequester,
  assignmentStatusLine,
  currentAssignment,
  requestWaitingOnAssignment,
  type AssignmentEntry,
  type AssignmentPresentation,
  type HostClient,
  type HostSnapshot,
} from "@opensteer/client/host";
import { useActionReview, useHostSelector } from "@opensteer/client/react";
import { MenuView } from "@expo/ui/community/menu";
import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { AccessibilityInfo, Alert, Pressable, StyleSheet, View } from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import { color, space } from "../theme.js";
import { ActionReviewSheet } from "../ui/action-review.js";
import { AppText } from "../ui/primitives.js";
import { TaskMark } from "../ui/task-mark.js";
import { WorkspaceMark } from "../ui/workspace-mark.js";
import { ChatOrb } from "../ui/chat-orb.js";

/** What task rows need from the pane that owns the Host client. */
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
 * Work handed to another Thread, under the reply that handed it out: one
 * bubble that changes in place. A tap opens the task's own screen, and back
 * returns here; a long press offers what else it can do. It reads the Host
 * itself, since transcript rows are memoized on their entries and a task moves
 * without touching its entry; while open it keeps the worker observed, so its
 * state and current step arrive wherever the task works.
 */
export function AssignmentCard(props: { readonly entry: AssignmentEntry }): ReactNode {
  const scope = useContext(TaskScopeContext);
  return scope === null ? null : <Bubble entry={props.entry} scope={scope} />;
}

function Bubble(props: { readonly entry: AssignmentEntry; readonly scope: TaskScope }): ReactNode {
  const { hostClient, onViewWork } = props.scope;
  const snapshot = useHostSelector(hostClient, selectSnapshot);
  const assignment = currentAssignment(props.entry, snapshot.assignments);
  const asked = assignmentPresentation(assignment, snapshot);
  const docked =
    asked.detail?.kind === "decision" &&
    props.scope.dockedRequestId !== null &&
    requestWaitingOnAssignment(snapshot.waitingRequests, assignment.id)?.request.id ===
      props.scope.dockedRequestId;
  const presentation = docked ? { ...asked, detail: null } : asked;
  const workerThreadId = assignment.workerThread.id;
  const { open } = presentation;
  useEffect(
    () => (open ? hostClient.observeThread(workerThreadId) : undefined),
    [hostClient, open, workerThreadId],
  );
  useLifecycleNews(presentation.announcement);
  const title = assignmentTitle(assignment, snapshot);
  const status = assignmentStatusLine(assignment, presentation);
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
        style={styles.bubbleMenu}
      >
        <Pressable
          accessibilityActions={canStop ? [{ label: "Stop task", name: "stop" }] : []}
          accessibilityHint="Opens the task"
          accessibilityLabel={[title, owner, status].filter((part) => part !== null).join(", ")}
          accessibilityRole="link"
          onAccessibilityAction={({ nativeEvent }) => {
            if (nativeEvent.actionName === "stop") stop.ask();
          }}
          onPress={() => onViewWork(workerThreadId)}
          style={({ pressed }) => [
            styles.bubble,
            presentation.tone === "waiting" && styles.bubbleWaiting,
            pressed && styles.bubblePressed,
          ]}
        >
          <TaskMark mark={assignmentMark(assignment, snapshot)} size={22} />
          <View style={styles.bubbleText}>
            <AppText numberOfLines={1} role="secondaryMedium">
              {title}
            </AppText>
            <View style={styles.byline}>
              {owner === null ? null : workspace?.kind === "specialized" ? (
                <WorkspaceMark
                  icon={workspace.icon}
                  color={workspace.color}
                  name={workspace.name}
                  size="mini"
                />
              ) : (
                <ChatOrb size={16} />
              )}
              <AppText
                numberOfLines={1}
                role="caption"
                style={[styles.statusText, { color: statusColor(presentation) }]}
              >
                {owner === null ? null : (
                  <AppText role="caption" tone="muted">{`${owner} · `}</AppText>
                )}
                {status}
              </AppText>
            </View>
          </View>
        </Pressable>
      </MenuView>
    </>
  );
}

/**
 * Stopping ends the task for good and tells the conversation that asked, so
 * a controlled native sheet asks first and dismisses when that task state ends. The task then shows whatever
 * the Host settled on, which may be a result that got there first. The card
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

function statusColor(presentation: AssignmentPresentation): string {
  switch (presentation.tone) {
    case "waiting":
      return color.amber;
    case "failed":
      return color.red;
    default:
      return color.muted;
  }
}

const styles = StyleSheet.create({
  bubble: {
    alignItems: "center",
    backgroundColor: color.surfaceElevated,
    borderBottomLeftRadius: 6,
    borderColor: color.lineStrong,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: space[12],
    maxWidth: 360,
    minHeight: 52,
    paddingLeft: space[8],
    paddingRight: space[16],
    paddingVertical: space[8],
  },
  bubbleMenu: { alignSelf: "flex-start", maxWidth: "100%" },
  bubblePressed: { opacity: 0.7 },
  bubbleText: { flexShrink: 1, gap: space[2] },
  byline: { alignItems: "center", flexDirection: "row", gap: space[4] },
  statusText: { flexShrink: 1 },
  bubbleWaiting: { borderColor: color.amberLine, borderWidth: 1 },
});
