import {
  canRespondToRequests,
  deriveSurface,
  formatDuration,
  showsHostLive,
  subagentDetail,
  transcriptNodes,
  type AgentCard,
  type HostClient,
  type HostSnapshot,
  type NodeDetailSnapshot,
  type SubagentDetail,
  type SurfaceModel,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { isRecord } from "@opensteer/shared/isRecord";
import {
  StackActions,
  useIsFocused,
  useNavigationState,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { useHeaderHeight } from "@react-navigation/elements";
import { useCallback, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import {
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type ScrollViewInstance,
} from "react-native";
import Animated from "react-native-reanimated";
import { Markdown } from "../markdown/markdown.js";
import { barHeight, color, headerFontScaleLimit, material, radius, space } from "../theme.js";
import { WorkflowCard, dotProps, useClock, type AgentScope } from "../thread/agent-cards.js";
import { SubagentStop } from "../thread/subagent-stop.js";
import { samePlain } from "../thread/agent-select.js";
import { barOverContentOptions } from "../thread/around-button.js";
import { AnswerPill } from "../thread/answer-pill.js";
import { ComposerDockLayout } from "../thread/composer-dock.js";
import { useNodeWatch } from "../thread/node-watch.js";
import { SubagentSteps } from "../thread/transcript.js";
import { QuestionCard } from "../thread/waiting-questions.js";
import { useAppForeground } from "../ui/foreground.js";
import { useLiquidGlass } from "../ui/glass.js";
import { useMobileClient } from "../ui/mobile-client-context.js";
import { appear } from "../ui/motion.js";
import { AppText, StatusDot } from "../ui/primitives.js";
import { Screen, useGutter, useReadingColumn } from "../ui/screen.js";
import { useContentInsets } from "../ui/pane.js";
import { Symbol } from "../ui/symbol.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";

export type SubagentScreenProps = StaticScreenProps<{
  readonly deploymentId: string;
  readonly nodeId: string;
  readonly threadId: string;
}>;

/**
 * A subagent's own conversation, read-only: what its parent asked of it, what
 * it said, thought and ran, the subagents it started, and what it returned.
 * Its steps are watched from the Host only while this screen is in front of
 * the reader with the app open; the header and prompt draw at once from the
 * card the parent already holds.
 *
 * Where a composer would be, it says the subagent runs on its own and leads
 * back to its parent; while it waits on the reader, that bar is the question
 * itself, answered here as it would be in the parent.
 */
export function SubagentScreen(props: SubagentScreenProps): ReactNode {
  const { deploymentId, nodeId, threadId } = props.route.params;
  const headerHeight = useHeaderHeight();
  const hostClient = useAttachedHost(deploymentId);
  if (hostClient === null)
    return <DeploymentGate deploymentId={deploymentId} paddingTop={headerHeight} />;
  return (
    <AttachedSubagent
      deploymentId={deploymentId}
      hostClient={hostClient}
      nodeId={nodeId}
      threadId={threadId}
    />
  );
}

/** What the Host holds of the subagent before its own steps arrive. */
function loadingSnapshot(threadId: string, nodeId: string): NodeDetailSnapshot {
  return {
    entries: [],
    error: null,
    hasMore: false,
    loadingOlder: false,
    node: null,
    nodeId,
    status: "loading",
    threadId,
  };
}

function AttachedSubagent(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
  readonly nodeId: string;
  readonly threadId: string;
}): ReactNode {
  const { deploymentId, hostClient, nodeId, threadId } = props;
  const navigation = useNavigation();
  const focused = useIsFocused();
  const foreground = useAppForeground();
  // Its own step sheet covers this screen without leaving the subagent, so the watch stays
  // and the sheet shares what is loaded, earlier steps included.
  const ownStepOpen = useNavigationState((state) => {
    const top = state.routes[state.index];
    return (
      top?.name === "ThreadStep" &&
      (top.params as { readonly nodeId?: string } | undefined)?.nodeId === nodeId
    );
  });
  const watched = useNodeWatch(
    hostClient,
    threadId,
    nodeId,
    (focused || ownStepOpen) && foreground,
  );
  const snapshot = watched.snapshot;
  const select = useCallback(
    (host: HostSnapshot): SubagentDetail | null => {
      const summary =
        transcriptNodes(host.transcripts[threadId] ?? []).find((node) => node.nodeId === nodeId) ??
        snapshot?.node ??
        null;
      if (summary === null || summary.nodeKind === "task") return null;
      return subagentDetail(snapshot ?? loadingSnapshot(threadId, nodeId), summary, host);
    },
    [nodeId, snapshot, threadId],
  );
  const detail = useHostSelector(hostClient, select, samePlain);
  const live = useHostSelector(hostClient, showsHostLive);
  const state: SubagentDetail["state"] | "absent" =
    detail === null
      ? watched.unreachable || (snapshot !== null && snapshot.status !== "loading")
        ? "missing"
        : "absent"
      : watched.unreachable
        ? "missing"
        : detail.state;

  const openParent = useCallback(() => {
    const parentNodeId = detail?.parent.nodeId ?? null;
    const state = navigation.getState();
    const below = state?.routes[state.index - 1];
    const params = isRecord(below?.params) ? below.params : null;
    const home = hostClient.getSnapshot().homeThreadId === threadId;
    const belowIsParent =
      params?.["deploymentId"] === deploymentId &&
      (parentNodeId === null
        ? (below?.name === "Thread" && params["threadId"] === threadId) ||
          (below?.name === "Home" && home)
        : below?.name === "Subagent" && params["nodeId"] === parentNodeId);
    if (belowIsParent) {
      navigation.goBack();
      return;
    }
    if (parentNodeId !== null) {
      navigation.dispatch(
        StackActions.replace("Subagent", { deploymentId, nodeId: parentNodeId, threadId }),
      );
      return;
    }
    navigation.dispatch(
      home
        ? StackActions.popTo("Home", { deploymentId })
        : StackActions.replace("Thread", { deploymentId, threadId }),
    );
  }, [deploymentId, detail?.parent.nodeId, hostClient, navigation, threadId]);

  const agentScope = useMemo<AgentScope>(
    () => ({
      live,
      hostClient,
      onOpen: (card: AgentCard) => {
        if (card.opens === null) return;
        navigation.dispatch(
          card.opens.kind === "thread"
            ? StackActions.push("Thread", { deploymentId, threadId: card.opens.threadId })
            : StackActions.push("Subagent", {
                deploymentId,
                nodeId: card.opens.nodeId,
                threadId: card.opens.threadId,
              }),
        );
      },
    }),
    [deploymentId, hostClient, live, navigation],
  );
  const openStep = useCallback(
    (entryId: string) =>
      navigation.navigate("ThreadStep", { deploymentId, entryId, nodeId, threadId }),
    [deploymentId, navigation, nodeId, threadId],
  );

  const glass = useLiquidGlass();
  const card = detail?.card ?? null;
  useLayoutEffect(() => {
    navigation.setOptions({
      ...barOverContentOptions(glass),
      headerTransparent: true,
      headerRight: () => (card ? <SubagentStop card={card} hostClient={hostClient} /> : null),
      headerTitle: () =>
        card === null ? (
          <AppText maxFontSizeMultiplier={headerFontScaleLimit} numberOfLines={1} role="title">
            Subagent
          </AppText>
        ) : (
          <SubagentHeading card={card} live={live} />
        ),
      title: card?.title ?? "Subagent",
    });
  }, [card, glass, hostClient, live, navigation]);

  const question = useHostSelector(
    hostClient,
    useCallback(
      (host: HostSnapshot) =>
        card?.requestId == null
          ? null
          : (host.waitingRequests.find(({ request }) => request.id === card.requestId)?.request ??
            null),
      [card?.requestId],
    ),
  );
  const user = useHostSelector(hostClient, selectUser);
  const canRespond = useHostSelector(hostClient, canRespondToRequests);
  const surface = useMemo<SurfaceModel | null>(
    () => (question === null || user === null ? null : deriveSurface([question], user)),
    [question, user],
  );
  const { drafts } = useMobileClient();

  if (state === "missing")
    return (
      <Screen>
        <View style={styles.missing}>
          <AppText role="title">This subagent can't be shown</AppText>
          <AnswerPill label="Open parent" onPress={openParent} tone="secondary" />
        </View>
      </Screen>
    );
  return (
    <Screen edgeToEdge>
      <ComposerDockLayout
        avoidKeyboard
        dock={
          surface !== null && user !== null ? (
            <QuestionCard
              canRespond={canRespond}
              deploymentId={deploymentId}
              drafts={drafts}
              hostClient={hostClient}
              subagentTitle={null}
              surface={surface}
              userId={user.id}
            />
          ) : (
            <ReadOnlyBar onOpenParent={openParent} />
          )
        }
      >
        {(clearance) => (
          <Body
            agentScope={agentScope}
            clearance={clearance}
            detail={detail}
            onLoadEarlier={() => void watched.watch?.loadOlder()}
            onOpenStep={openStep}
            onRetry={() => watched.watch?.retry()}
            state={state}
          />
        )}
      </ComposerDockLayout>
    </Screen>
  );
}

const selectUser = (snapshot: HostSnapshot) => snapshot.user;

/** The bar's title and, under it, where the subagent stands, how long, on what model. */
function SubagentHeading(props: { readonly card: AgentCard; readonly live: boolean }): ReactNode {
  const { card } = props;
  const now = useClock(props.live && card.endedAt === null);
  const time = formatDuration(
    Math.max(
      0,
      (card.endedAt === null ? now : Date.parse(card.endedAt)) - Date.parse(card.startedAt),
    ),
  );
  return (
    <View accessibilityRole="header" style={styles.heading}>
      <AppText maxFontSizeMultiplier={headerFontScaleLimit} numberOfLines={1} role="title">
        {card.title}
      </AppText>
      <View style={styles.subtitle}>
        <StatusDot live={card.moving} size={6} {...dotProps(card.tone)} />
        <AppText
          maxFontSizeMultiplier={headerFontScaleLimit}
          numberOfLines={1}
          role="caption"
          style={styles.subtitleWords}
          tone="muted"
        >
          <AppText
            maxFontSizeMultiplier={headerFontScaleLimit}
            role="caption"
            style={card.tone === "needs-you" ? styles.amber : undefined}
            tone="soft"
          >
            {card.word}
          </AppText>
          {[time, card.modelLabel].filter(Boolean).map((part) => ` · ${part}`)}
        </AppText>
      </View>
    </View>
  );
}

/** Where the composer would be: the reader watches a subagent, and its parent steers it. */
function ReadOnlyBar(props: { readonly onOpenParent: () => void }): ReactNode {
  const narrow = useWindowDimensions().width < 340;
  return (
    <View style={styles.bar}>
      <View
        accessibilityLabel="Runs on its own. You can't message a subagent. Its parent decides what it does."
        accessible
        style={styles.barWords}
      >
        <View style={styles.barTitle}>
          <Symbol name="eye" size={14} tint={color.muted} />
          <AppText role="secondaryMedium" tone="soft">
            Runs on its own
          </AppText>
        </View>
        {narrow ? null : (
          <AppText role="caption" tone="muted">
            You can't message a subagent. Its parent decides what it does.
          </AppText>
        )}
      </View>
      <AnswerPill label="Open parent" onPress={props.onOpenParent} tone="secondary" />
    </View>
  );
}

/**
 * The prompt, then the steps as they page in and stream, then the result.
 * Like the transcript it follows the newest step only while the reader is at
 * the end, and an earlier page arriving above keeps their place.
 */
function Body(props: {
  readonly agentScope: AgentScope;
  readonly clearance: number;
  readonly detail: SubagentDetail | null;
  readonly onLoadEarlier: () => void;
  readonly onOpenStep: (entryId: string) => void;
  readonly onRetry: () => void;
  readonly state: SubagentDetail["state"] | "absent";
}): ReactNode {
  const { detail, state } = props;
  const headerHeight = useHeaderHeight();
  const gutter = useGutter();
  const insets = useContentInsets();
  const column = useReadingColumn();
  const list = useRef<ScrollViewInstance>(null);
  const atEnd = useRef(true);
  const card = detail?.card ?? null;
  return (
    <ScrollView
      contentContainerStyle={[
        column,
        styles.body,
        {
          paddingBottom: props.clearance + space[16],
          paddingLeft: gutter + insets.left,
          paddingRight: gutter + insets.right,
          paddingTop: headerHeight + space[8],
        },
      ]}
      contentInsetAdjustmentBehavior="never"
      maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
      onContentSizeChange={() => {
        if (atEnd.current) list.current?.scrollToEnd({ animated: false });
      }}
      onScroll={({ nativeEvent }) => {
        const { contentOffset, contentSize, layoutMeasurement } = nativeEvent;
        atEnd.current =
          contentOffset.y + layoutMeasurement.height >= contentSize.height - space[48];
      }}
      ref={list}
      scrollEventThrottle={32}
      scrollIndicatorInsets={{ bottom: props.clearance, top: headerHeight }}
    >
      {detail?.prompt ? (
        <View style={styles.prompt}>
          <AppText numberOfLines={1} role="caption" tone="muted">
            From {detail.parent.title}
          </AppText>
          <View style={styles.promptBubble}>
            <Markdown text={detail.prompt} />
          </View>
        </View>
      ) : null}
      {card?.workflow ? (
        <WorkflowCard card={card} phasesOnly scope={props.agentScope} workflow={card.workflow} />
      ) : null}
      {state === "loading" || state === "absent" ? (
        <View
          accessibilityLabel="Loading this subagent's steps"
          accessibilityRole="progressbar"
          accessible
          style={styles.skeleton}
        >
          {[68, 84, 54].map((width) => (
            <View key={width} style={[styles.skeletonLine, { width: `${width}%` }]} />
          ))}
        </View>
      ) : state === "summary-only" || state === "unavailable" ? (
        <Note
          detail={
            state === "summary-only"
              ? "This subagent's steps weren't recorded."
              : "Update Opensteer on this computer to see a subagent's steps."
          }
          title="Only a summary is available."
        />
      ) : state === "error" ? (
        <Note title="Couldn't load this subagent's steps.">
          <View style={styles.retry}>
            <AnswerPill label="Try again" onPress={props.onRetry} tone="secondary" />
          </View>
        </Note>
      ) : null}
      {state === "ready" && detail !== null ? (
        <>
          {detail.hasEarlier ? (
            <AnswerPill
              busy={detail.loadingEarlier}
              label="Show earlier steps"
              onPress={props.onLoadEarlier}
              tone="secondary"
            />
          ) : null}
          <SubagentSteps
            active={detail.card.endedAt === null}
            agentScope={props.agentScope}
            entries={detail.entries}
            onOpenStep={props.onOpenStep}
          />
        </>
      ) : null}
      {detail?.result && state !== "loading" && state !== "error" ? (
        <Animated.View entering={appear} style={styles.result}>
          <AppText role="caption" style={styles.eyebrow} tone="muted">
            Result
          </AppText>
          <Markdown text={detail.result} />
        </Animated.View>
      ) : null}
    </ScrollView>
  );
}

function Note(props: {
  readonly children?: ReactNode;
  readonly detail?: string;
  readonly title: string;
}): ReactNode {
  return (
    <View style={styles.note}>
      <Symbol name="exclamationmark.circle" size={14} tint={color.muted} />
      <View style={styles.noteWords}>
        <AppText role="secondaryMedium" tone="soft">
          {props.title}
        </AppText>
        {props.detail === undefined ? null : (
          <AppText role="caption" tone="muted">
            {props.detail}
          </AppText>
        )}
        {props.children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  amber: { color: color.amber },
  heading: { alignItems: "center", maxWidth: "100%" },
  subtitle: { alignItems: "center", flexDirection: "row", gap: space[4], maxWidth: "100%" },
  subtitleWords: { flexShrink: 1 },
  body: { gap: space[8] },
  prompt: { alignItems: "flex-end", alignSelf: "flex-end", gap: space[4], maxWidth: "82%" },
  promptBubble: {
    ...material.plate,
    borderBottomEndRadius: radius.xs,
    borderCurve: "continuous",
    borderRadius: radius.xl,
    paddingHorizontal: space[16] - 1,
    paddingVertical: space[12] - 1,
  },
  skeleton: { gap: space[12], paddingVertical: space[8] },
  skeletonLine: { ...material.quiet, borderRadius: radius.xs, height: 12 },
  note: { flexDirection: "row", gap: space[8], paddingVertical: space[8] },
  noteWords: { flex: 1, gap: space[2] },
  retry: { alignItems: "flex-start", paddingTop: space[8] },
  result: { gap: space[4], paddingTop: space[8] },
  eyebrow: { fontWeight: "700", letterSpacing: 0.8, textTransform: "uppercase" },
  bar: {
    ...material.float,
    alignItems: "center",
    borderCurve: "continuous",
    borderRadius: radius.xxl,
    flexDirection: "row",
    gap: space[10],
    minHeight: barHeight,
    paddingLeft: space[16],
    paddingRight: space[8],
    paddingVertical: space[10],
  },
  barWords: { flex: 1, gap: space[2] },
  barTitle: { alignItems: "center", flexDirection: "row", gap: space[8] },
  missing: {
    alignItems: "center",
    flex: 1,
    gap: space[14],
    justifyContent: "center",
    padding: space[24],
  },
});
