import { threadMark, assignmentTitle } from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { waitingRequestSource, type HostClient, type SurfaceModel } from "@opensteer/client/host";
import type { AuthenticatedUser, WaitingRequest } from "@opensteer/core";
import type { MachineSummary } from "@opensteer/protocol";
import { useMemo, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import type { ThreadDraftStore } from "../client/thread-drafts.js";
import { color, space } from "../theme.js";
import { appear } from "../ui/motion.js";
import { AppText } from "../ui/primitives.js";
import { TaskMark } from "../ui/task-mark.js";
import { Symbol } from "../ui/symbol.js";
import { waitingQuestion } from "./docked-requests.js";
import { RequestCard } from "./request-card.js";
import { useThreadMutation } from "./thread-mutation-registry.js";

/**
 * What the work a Thread handed out is waiting on its reader for, asked by one
 * of its tasks or by anything working inside one. It sits above the composer
 * without joining it: typing there still talks to this Thread, so a task's
 * question is answered here by choosing, and answered as that task's — through
 * the task's own mutation gate, so a message still sending there blocks it.
 */
export function WaitingQuestions(props: {
  readonly canRespond: boolean;
  readonly deploymentId: string;
  readonly drafts: ThreadDraftStore;
  readonly hostClient: HostClient;
  readonly machines: readonly MachineSummary[];
  readonly onOpenTask: (threadId: string) => void;
  readonly threadId: string;
  readonly user: AuthenticatedUser;
  readonly waitingRequests: readonly WaitingRequest[];
}): ReactNode {
  const snapshot = useHostSelector(props.hostClient, (snapshot) => snapshot);
  const { threads } = snapshot;
  const question = useMemo(
    () => waitingQuestion(props.waitingRequests, props.threadId, props.user),
    [props.threadId, props.user, props.waitingRequests],
  );
  if (question === null) return null;
  const { surface, waiting: focused } = question;
  const task = focused ? waitingRequestSource(focused, props.threadId) : null;
  return (
    <Animated.View entering={appear} style={styles.question}>
      {task === null ? null : (
        <Pressable
          accessibilityHint="Opens the task that is asking"
          accessibilityRole="link"
          hitSlop={space[8]}
          onPress={() => props.onOpenTask(task.workerThread.id)}
          style={styles.source}
        >
          <TaskMark mark={threadMark(task.workerThread.id, snapshot)} size={16} />
          <AppText numberOfLines={1} role="caption" style={styles.sourceTitle}>
            {assignmentTitle(task, { threads })}
          </AppText>
          <Symbol name="chevron.right" size={11} tint={color.amber} />
        </Pressable>
      )}
      <QuestionCard
        canRespond={props.canRespond}
        deploymentId={props.deploymentId}
        drafts={props.drafts}
        hostClient={props.hostClient}
        key={surface.request.id}
        machines={props.machines}
        subagentTitle={focused?.subagent?.title ?? null}
        surface={surface}
        userId={props.user.id}
      />
    </Animated.View>
  );
}

function QuestionCard(props: {
  readonly canRespond: boolean;
  readonly deploymentId: string;
  readonly drafts: ThreadDraftStore;
  readonly hostClient: HostClient;
  readonly machines: readonly MachineSummary[];
  readonly subagentTitle: string | null;
  readonly surface: SurfaceModel;
  readonly userId: string;
}): ReactNode {
  const threadId = props.surface.request.originatingThreadId;
  const { gate } = useThreadMutation({
    deploymentId: props.deploymentId,
    threadId,
    userId: props.userId,
  });
  return (
    <View>
      <RequestCard
        canRespond={props.canRespond}
        canStartResponse={() =>
          props.canRespond &&
          props.drafts.readPending(props.deploymentId, props.userId, threadId) === null
        }
        disabledReason={null}
        highlighted={false}
        hostClient={props.hostClient}
        machines={props.machines}
        mutationGate={gate}
        onPresent={() => undefined}
        onSettle={() => undefined}
        subagentTitle={props.subagentTitle}
        surface={props.surface}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  question: { gap: space[6] },
  source: {
    alignItems: "center",
    alignSelf: "flex-start",
    flexDirection: "row",
    gap: space[4],
    paddingHorizontal: space[4],
  },
  sourceTitle: { color: color.amber, flexShrink: 1 },
});
