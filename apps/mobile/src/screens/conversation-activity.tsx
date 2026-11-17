import { classifyClientFailure } from "@opensteer/client/connections";
import { presentClientIssue } from "@opensteer/client/feedback";
import { TranscriptImageContext } from "@opensteer/client/react";
import {
  conversationActivityTurn,
  formatClockTime,
  groupTranscriptEntries,
  visibleTranscript,
  withoutOwnAssignment,
  type HostClient,
  type TabDestination,
} from "@opensteer/client/host";
import { useHostSnapshot, useThreadInputQueue } from "@opensteer/client/react";
import {
  StackActions,
  useIsFocused,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useOpenPlace } from "../tabs/viewer-open.js";
import { color, space } from "../theme.js";
import { TranscriptHostClientContext } from "../thread/attachment-views.js";
import {
  ReplySurfaces,
  TranscriptSurfacesContext,
  type TranscriptSurfaces,
} from "../thread/surface-chips.js";
import { ConversationSteps } from "../thread/transcript.js";
import { AgentEngine, AgentGround, threadEngine } from "../thread/agent-mark.js";
import { AgentMemoryContext } from "../thread/subagent-rows.js";
import { TaskScopeContext, type TaskScope } from "../thread/task-line.js";
import { useMobileState } from "../ui/mobile-client-context.js";
import { AppText, Notice } from "../ui/primitives.js";
import { useContentInsets } from "../ui/pane.js";
import { useGutter } from "../ui/screen.js";
import { UnavailableState } from "../ui/unavailable-state.js";
import { ActionLine } from "../ui/action-line.js";
import { PlaceholderRows } from "../ui/placeholder.js";
import { useShowsLive } from "../ui/connection-live.js";

export type ConversationActivityScreenProps = StaticScreenProps<{
  readonly deploymentId: string;
  readonly threadId: string;
  /** The reply to show, by its turn's key. Absent, the reply under way or else the latest. */
  readonly turnKey?: string | undefined;
  readonly messageId?: string | undefined;
  /** A Run a link named, found once the transcript around its first message is loaded. */
  readonly runId?: string | undefined;
  readonly anchorMessageId?: string | undefined;
}>;

/**
 * Run details: what one of Opensteer's replies did on the way to it, opened
 * on purpose from the reply's menu or the reply under way, with the pages and
 * apps it used.
 *
 * It reads the reply from the live transcript rather than taking its steps as
 * a route parameter, so a reply still being written keeps adding to it here.
 */
export function ConversationActivityScreen(props: ConversationActivityScreenProps): ReactNode {
  const { anchorMessageId, deploymentId, runId, threadId, turnKey } = props.route.params;
  const { selection } = useMobileState();
  if (selection.deploymentId !== deploymentId || selection.hostClient === null) {
    return <Unavailable detail="This deployment is no longer open." />;
  }
  return (
    <ReplyActivity
      messageId={props.route.params.messageId ?? null}
      deploymentId={deploymentId}
      hostClient={selection.hostClient}
      run={runId && anchorMessageId ? { anchorMessageId, runId } : null}
      threadId={threadId}
      turnKey={turnKey ?? null}
    />
  );
}

type RunLoad = "loading" | "loaded" | "unavailable" | "failed";

/**
 * A Run a link named may be from long ago: the conversation is held while
 * this sheet is open, and when the Run is not among what is loaded, the
 * window around its first message is read before deciding it is gone.
 */
function useRunLoad(
  hostClient: HostClient,
  threadId: string,
  run: { readonly anchorMessageId: string; readonly runId: string } | null,
  found: boolean,
): { readonly state: RunLoad; readonly retry: () => void } {
  const [state, setState] = useState<RunLoad>(run === null || found ? "loaded" : "loading");
  const [attempt, setAttempt] = useState(0);
  const foundNow = useRef(found);
  foundNow.current = found;
  useEffect(
    () => (run === null ? undefined : hostClient.observeThread(threadId)),
    [hostClient, run, threadId],
  );
  const anchor = run?.anchorMessageId ?? null;
  useEffect(() => {
    if (anchor === null || foundNow.current) return;
    let current = true;
    setState("loading");
    hostClient.loadTranscriptAround(threadId, anchor).then(
      () => current && setState("loaded"),
      // Gone or not the reader's is a fact about the run; anything else may pass.
      (error: unknown) =>
        current &&
        setState(
          ["forbidden", "not_found"].includes(classifyClientFailure(error).code)
            ? "unavailable"
            : "failed",
        ),
    );
    return () => {
      current = false;
    };
  }, [anchor, attempt, hostClient, threadId]);
  return { state, retry: () => setAttempt((count) => count + 1) };
}

function ReplyActivity(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
  readonly threadId: string;
  readonly turnKey: string | null;
  readonly messageId: string | null;
  readonly run: { readonly anchorMessageId: string; readonly runId: string } | null;
}): ReactNode {
  const { deploymentId, hostClient, run, threadId, turnKey } = props;
  const navigation = useNavigation();
  const { snapshot } = useHostSnapshot(hostClient);
  const queue = useThreadInputQueue(hostClient, threadId);
  const thread = snapshot.threads.find(({ id }) => id === threadId) ?? null;
  const entries = snapshot.transcripts[threadId];
  const inputQueuePaused = thread?.inputQueuePaused ?? false;
  // The conversation's own turns, so a key its rows hand over finds its reply.
  const groups = useMemo(
    () =>
      groupTranscriptEntries(
        withoutOwnAssignment(
          visibleTranscript(entries ?? [], queue, { conversation: true }),
          threadId,
        ),
        { inputQueuePaused },
      ),
    [entries, inputQueuePaused, queue, threadId],
  );
  const activity = useMemo(
    () =>
      conversationActivityTurn(
        groups,
        run !== null
          ? { kind: "run", runId: run.runId }
          : turnKey === null
            ? { kind: "latest" }
            : { key: turnKey, kind: "turn" },
      ),
    [groups, run, turnKey],
  );
  const load = useRunLoad(hostClient, threadId, run, activity !== null);
  const environment = snapshot.environments.find(({ id }) => id === thread?.environmentId);
  const engine = threadEngine(snapshot, threadId);
  const live = useShowsLive(hostClient.connection) && environment?.status === "connected";
  const openStep = useCallback(
    (entryId: string) => navigation.navigate("ThreadStep", { deploymentId, entryId, threadId }),
    [deploymentId, navigation, threadId],
  );
  // A page opens over the conversation, not inside this sheet: the sheet
  // closes first, so Back from the page returns to the conversation.
  // A helper opens over the conversation too: its card in this sheet closes the sheet first.
  const focused = useIsFocused();
  const scope = useMemo<TaskScope>(
    () => ({
      focused,
      hostClient,
      threadId,
      onOpenSubagent: (parentThreadId: string, nodeId: string) => {
        navigation.goBack();
        navigation.dispatch(
          StackActions.push("Subagent", { deploymentId, nodeId, threadId: parentThreadId }),
        );
      },
      onViewWork: (workerThreadId: string) => {
        navigation.goBack();
        navigation.dispatch(
          StackActions.push("Thread", { deploymentId, threadId: workerThreadId }),
        );
      },
    }),
    [deploymentId, focused, hostClient, navigation, threadId],
  );
  const memory = useRef(new Map<string, boolean>()).current;
  const leave = useCallback(() => navigation.goBack(), [navigation]);
  const openPlace = useOpenPlace(deploymentId, threadId, leave);
  const surfaces = useMemo<TranscriptSurfaces>(
    () => ({
      hostClient,
      threadId,
      open: (destination: TabDestination) => openPlace(destination),
    }),
    [hostClient, openPlace, threadId],
  );

  if (activity === null && run !== null) {
    return load.state === "loading" ? (
      <Frame status={null}>
        <PlaceholderRows count={2} />
      </Frame>
    ) : load.state === "failed" ? (
      <Frame status={null}>
        <ActionLine
          line={{
            key: "run-failed",
            text: presentClientIssue({ code: "read-failed", resource: "these run details" }).title,
            tone: "muted",
            link: { label: "Try again", onPress: load.retry },
          }}
        />
      </Frame>
    ) : (
      <View style={styles.sheet}>
        <UnavailableState onBack={() => navigation.goBack()} />
      </View>
    );
  }
  if (activity === null) {
    return turnKey === null ? (
      <Frame status={null}>
        <AppText role="secondary" tone="muted">
          Nothing yet.
        </AppText>
      </Frame>
    ) : (
      <Unavailable detail="That reply is no longer loaded. Open the conversation again to see it." />
    );
  }
  return (
    <TranscriptImageContext value={{ client: hostClient, threadId }}>
      <TaskScopeContext value={scope}>
        <AgentEngine value={engine}>
          <AgentGround value={color.surfaceElevated}>
            <AgentMemoryContext value={memory}>
              <TranscriptHostClientContext value={hostClient}>
                <Frame
                  status={
                    activity.live
                      ? "Now"
                      : activity.reply === null
                        ? null
                        : formatClockTime(activity.reply.createdAt)
                  }
                >
                  <TranscriptSurfacesContext.Provider value={surfaces}>
                    <ReplySurfaces turn={activity.turn} turnKey={activity.key} />
                  </TranscriptSurfacesContext.Provider>
                  {activity.steps.length === 0 ? (
                    <AppText role="secondary" tone="muted">
                      {activity.live ? "Nothing yet." : "Opensteer answered without any steps."}
                    </AppText>
                  ) : (
                    <ConversationSteps
                      reveal={props.messageId}
                      entries={activity.steps}
                      highlightRequestId={null}
                      live={live}
                      onOpenStep={openStep}
                      turn={activity.turn}
                    />
                  )}
                </Frame>
              </TranscriptHostClientContext>
            </AgentMemoryContext>
          </AgentGround>
        </AgentEngine>
      </TaskScopeContext>
    </TranscriptImageContext>
  );
}

function Frame(props: { readonly children: ReactNode; readonly status: string | null }): ReactNode {
  const insets = useContentInsets();
  const gutter = useGutter();
  return (
    <ScrollView
      contentContainerStyle={[
        styles.content,
        {
          paddingBottom: insets.bottom + space[24],
          paddingLeft: gutter + insets.left,
          paddingRight: gutter + insets.right,
        },
      ]}
      style={styles.sheet}
    >
      <View style={styles.head}>
        <AppText role="title">Run details</AppText>
        {props.status === null ? null : (
          <AppText role="caption" tone="muted">
            {props.status}
          </AppText>
        )}
      </View>
      {props.children}
    </ScrollView>
  );
}

function Unavailable(props: { readonly detail: string }): ReactNode {
  const navigation = useNavigation();
  return (
    <View style={[styles.sheet, styles.unavailable]}>
      <Notice
        action={{ label: "Close", onPress: () => navigation.goBack() }}
        detail={props.detail}
        title="These run details can't be shown"
        tone="neutral"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  content: { gap: space[16], paddingTop: space[24] },
  head: { gap: space[4] },
  sheet: { backgroundColor: color.surfaceElevated, flex: 1 },
  unavailable: { justifyContent: "center", padding: space[24] },
});
