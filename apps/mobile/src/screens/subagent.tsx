import {
  canRespondToRequests,
  conversationName,
  deriveSurface,
  showsHostLive,
  subagentDetail,
  subagentFooter,
  subagentSiblings,
  transcriptNodes,
  type AgentCard,
  type HostClient,
  type HostSnapshot,
  type NodeDetailSnapshot,
  type SubagentDetail,
  type SubagentSiblings,
  type SurfaceModel,
} from "@opensteer/client/host";
import { harnessCatalogEntry } from "@opensteer/core";
import { useHostSelector } from "@opensteer/client/react";
import { isRecord } from "@opensteer/shared/isRecord";
import {
  StackActions,
  useIsFocused,
  useNavigation,
  useNavigationState,
  type StaticScreenProps,
} from "@react-navigation/native";
import { useHeaderHeight } from "@react-navigation/elements";
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type ScrollViewInstance,
} from "react-native";
import Animated from "react-native-reanimated";
import { Markdown } from "../markdown/markdown.js";
import {
  barHeight,
  color,
  headerFontScaleLimit,
  material,
  radius,
  space,
  touchTarget,
  type,
} from "../theme.js";
import { samePlain } from "../thread/agent-select.js";
import { barOverContentOptions } from "../thread/around-button.js";
import { AnswerPill } from "../thread/answer-pill.js";
import { ComposerDockLayout } from "../thread/composer-dock.js";
import { useNodeWatch } from "../thread/node-watch.js";
import { AgentEngine, AgentMark, threadEngine } from "../thread/agent-mark.js";
import {
  AgentScopeProvider,
  AgentsLive,
  Elapsed,
  WorkflowPhases,
  type AgentScope,
} from "../thread/subagent-rows.js";
import { SubagentStop } from "../thread/subagent-stop.js";
import { SubagentSteps } from "../thread/transcript.js";
import { QuestionCard } from "../thread/waiting-questions.js";
import { useAppForeground } from "../ui/foreground.js";
import { useLiquidGlass } from "../ui/glass.js";
import { useMobileClient } from "../ui/mobile-client-context.js";
import { appear } from "../ui/motion.js";
import { AppText } from "../ui/primitives.js";
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
 * A subagent, opened: who started it, what it was asked, what it found and
 * its own steps, with the subagents beside it one hop away. Where a composer
 * would be, it says it can be watched, not messaged, with Stop where its
 * engine allows one; while it waits on the reader, its question stands there
 * too. The header draws at once from what the conversation already holds;
 * its steps are watched from the Host only while this screen is in front.
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

const selectUser = (snapshot: HostSnapshot) => snapshot.user;

function sameSiblings(left: SubagentSiblings | null, right: SubagentSiblings | null): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.index === right.index &&
      left.total === right.total &&
      left.previous === right.previous &&
      left.next === right.next)
  );
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
  // Out of reach of the conversation's computer, everything here is what was last known.
  const live = useHostSelector(
    hostClient,
    useCallback(
      (host: HostSnapshot) => {
        const thread = host.threads.find(({ id }) => id === threadId);
        const environment = host.environments.find(({ id }) => id === thread?.environmentId);
        return showsHostLive(host) && environment?.status === "connected";
      },
      [threadId],
    ),
  );
  const select = useCallback(
    (host: HostSnapshot): SubagentDetail | null => {
      const summary =
        transcriptNodes(host.transcripts[threadId] ?? []).find((node) => node.nodeId === nodeId) ??
        snapshot?.node ??
        null;
      if (summary === null || summary.nodeKind === "task") return null;
      return subagentDetail(
        snapshot ?? loadingSnapshot(threadId, nodeId),
        summary,
        live ? host : { ...host, connection: "offline" },
      );
    },
    [live, nodeId, snapshot, threadId],
  );
  const detail = useHostSelector(hostClient, select, samePlain);
  const siblings = useHostSelector(
    hostClient,
    useCallback(
      (host: HostSnapshot) => subagentSiblings(host, threadId, nodeId),
      [nodeId, threadId],
    ),
    sameSiblings,
  );
  const engine = useHostSelector(
    hostClient,
    useCallback((host: HostSnapshot) => threadEngine(host, threadId), [threadId]),
  );
  const threadTitle = useHostSelector(
    hostClient,
    useCallback(
      (host: HostSnapshot) => {
        const thread = host.threads.find(({ id }) => id === threadId);
        return thread ? conversationName(thread.id, thread.title, host.homeThreadId) : null;
      },
      [threadId],
    ),
  );
  const state: SubagentDetail["state"] | "absent" =
    detail === null
      ? watched.unreachable || (snapshot !== null && snapshot.status !== "loading")
        ? "missing"
        : "absent"
      : watched.unreachable
        ? "missing"
        : detail.state;

  // A workflow's members report to the conversation; a subagent's own, to it.
  const parentNodeId = useHostSelector(
    hostClient,
    useCallback(
      (host: HostSnapshot) => {
        const parent = detail?.parent.nodeId;
        return parent !== undefined &&
          transcriptNodes(host.transcripts[threadId] ?? []).some(
            (node) => node.nodeId === parent && node.nodeKind !== "workflow",
          )
          ? parent
          : null;
      },
      [detail?.parent.nodeId, threadId],
    ),
  );
  const reportsTo =
    parentNodeId !== null && detail !== null
      ? detail.parent.title
      : (threadTitle ?? detail?.parent.title ?? "this conversation");

  /**
   * Goes to the conversation (null) or a subagent above this one: back down
   * the stack when it is already there, else in this screen's place.
   */
  const openAncestor = useCallback(
    (target: string | null) => {
      const stack = navigation.getState();
      const routes = stack?.routes ?? [];
      const home = hostClient.getSnapshot().homeThreadId === threadId;
      const index = routes.findLastIndex((route, at) => {
        if (at >= (stack?.index ?? 0)) return false;
        const params = isRecord(route.params) ? route.params : null;
        if (params?.["deploymentId"] !== deploymentId) return false;
        return target === null
          ? (route.name === "Thread" && params["threadId"] === threadId) ||
              (route.name === "Home" && home)
          : route.name === "Subagent" && params["nodeId"] === target;
      });
      if (index >= 0 && stack) {
        navigation.dispatch(StackActions.pop(stack.index - index));
        return;
      }
      navigation.dispatch(
        target !== null
          ? StackActions.replace("Subagent", { deploymentId, nodeId: target, threadId })
          : home
            ? StackActions.popTo("Home", { deploymentId })
            : StackActions.replace("Thread", { deploymentId, threadId }),
      );
    },
    [deploymentId, hostClient, navigation, threadId],
  );
  const hop = useCallback(
    (target: string) =>
      navigation.dispatch(
        StackActions.replace("Subagent", { deploymentId, nodeId: target, threadId }),
      ),
    [deploymentId, navigation, threadId],
  );

  const agentScope = useMemo<AgentScope>(
    () => ({
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
    [deploymentId, hostClient, navigation],
  );
  const openStep = useCallback(
    (entryId: string) =>
      navigation.navigate("ThreadStep", { deploymentId, entryId, nodeId, threadId }),
    [deploymentId, navigation, nodeId, threadId],
  );

  const glass = useLiquidGlass();
  const card = detail?.card ?? null;
  const noun = card?.noun ?? "Subagent";
  const title = card?.title ?? null;
  const shownHop = siblings !== null && siblings.total > 1 ? siblings : null;
  useLayoutEffect(() => {
    navigation.setOptions({
      ...barOverContentOptions(glass),
      headerTransparent: true,
      // iOS leads with the way back, titled with where it goes; Android names what this is.
      headerTitle:
        Platform.OS === "ios"
          ? () => null
          : () => (
              <AppText maxFontSizeMultiplier={headerFontScaleLimit} numberOfLines={1} role="title">
                {noun}
              </AppText>
            ),
      headerRight: () =>
        shownHop === null ? null : <SiblingHop noun={noun} onHop={hop} siblings={shownHop} />,
      // What the back control of a screen opened from this one says.
      title: title ?? noun,
    });
  }, [glass, hop, navigation, noun, shownHop, title]);

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
        <View accessibilityRole="alert" style={styles.missing}>
          <AppText role="title">This subagent can't be shown</AppText>
          <AppText role="secondary" style={styles.center} tone="muted">
            It's no longer part of this conversation.
          </AppText>
          <AnswerPill
            label={`Back to ${threadTitle ?? "the conversation"}`}
            onPress={() => openAncestor(null)}
            tone="secondary"
          />
        </View>
      </Screen>
    );
  return (
    <AgentsLive value={live}>
      <AgentEngine value={engine}>
        <AgentScopeProvider value={agentScope}>
          <Screen edgeToEdge>
            <ComposerDockLayout
              avoidKeyboard
              dock={
                <>
                  {surface !== null && user !== null ? (
                    <QuestionCard
                      asker={false}
                      canRespond={canRespond}
                      deploymentId={deploymentId}
                      drafts={drafts}
                      hostClient={hostClient}
                      surface={surface}
                      userId={user.id}
                    />
                  ) : null}
                  {card === null ? null : (
                    <WatchFooter
                      card={card}
                      engine={engine}
                      hostClient={hostClient}
                      reportsTo={reportsTo}
                    />
                  )}
                </>
              }
            >
              {(clearance) => (
                <Body
                  agentScope={agentScope}
                  clearance={clearance}
                  detail={detail}
                  live={live}
                  onLoadEarlier={() => void watched.watch?.loadOlder()}
                  onOpenAncestor={openAncestor}
                  onOpenStep={openStep}
                  onRetry={() => watched.watch?.retry()}
                  rootTitle={threadTitle ?? detail?.parent.title ?? "Conversation"}
                  state={state}
                />
              )}
            </ComposerDockLayout>
          </Screen>
        </AgentScopeProvider>
      </AgentEngine>
    </AgentsLive>
  );
}

/** "‹ 2 of 3 ›": the subagents started beside this one, a hop away in this screen's place. */
function SiblingHop(props: {
  readonly noun: string;
  readonly onHop: (nodeId: string) => void;
  readonly siblings: SubagentSiblings;
}): ReactNode {
  const { siblings } = props;
  const noun = props.noun.toLowerCase();
  return (
    <View style={styles.hop}>
      <HopButton
        icon="chevron.left"
        label={`Previous ${noun}`}
        onPress={siblings.previous === null ? null : () => props.onHop(siblings.previous!)}
      />
      <View
        accessibilityLabel={`${siblings.index + 1} of ${siblings.total}`}
        accessibilityLiveRegion="polite"
        accessible
      >
        <AppText
          maxFontSizeMultiplier={headerFontScaleLimit}
          role="secondary"
          style={styles.hopCount}
          tone="muted"
        >
          {`${siblings.index + 1}/${siblings.total}`}
        </AppText>
      </View>
      <HopButton
        icon="chevron.right"
        label={`Next ${noun}`}
        onPress={siblings.next === null ? null : () => props.onHop(siblings.next!)}
      />
    </View>
  );
}

function HopButton(props: {
  readonly icon: "chevron.left" | "chevron.right";
  readonly label: string;
  readonly onPress: (() => void) | null;
}): ReactNode {
  const disabled = props.onPress === null;
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={props.onPress ?? undefined}
      style={({ pressed }) => [styles.hopButton, pressed && styles.pressed]}
    >
      <Symbol
        name={props.icon}
        size={15}
        tint={disabled ? color.lineControl : color.textSoft}
        weight="semibold"
      />
    </Pressable>
  );
}

/**
 * In the composer's place: it can be watched, not messaged, and who it
 * reports to. Stop stands beside it where its engine allows; where it can't,
 * one plain sentence says why.
 */
function WatchFooter(props: {
  readonly card: AgentCard;
  readonly engine: string | null;
  readonly hostClient: HostClient;
  readonly reportsTo: string;
}): ReactNode {
  const { card } = props;
  const footer = subagentFooter(
    card,
    props.reportsTo,
    props.engine === null ? null : (harnessCatalogEntry(props.engine)?.label ?? null),
  );
  const noun = card.kind === "workflow" ? "workflow" : "subagent";
  const narrow = useWindowDimensions().width < 340;
  return (
    <View style={styles.bar}>
      {narrow ? null : <Symbol name="eye" size={14} tint={color.muted} />}
      <AppText role="caption" style={styles.barWords} tone="muted">
        {`A ${noun} reports to `}
        <AppText role="caption" style={styles.strong} tone="soft">
          {footer.reportsTo}
        </AppText>
        {". You can watch it, not message it."}
        {footer.noStop === null ? null : ` ${footer.noStop}`}
      </AppText>
      <SubagentStop card={card} hostClient={props.hostClient} look="button" />
    </View>
  );
}

/**
 * Its lineage, title and one line of where it stands; what it was asked; its
 * result once settled; then its own steps as they page in and stream. Like
 * the transcript it follows the newest step only while the reader is at the
 * end, and an earlier page arriving above keeps their place.
 */
function Body(props: {
  readonly agentScope: AgentScope;
  readonly clearance: number;
  readonly detail: SubagentDetail | null;
  readonly live: boolean;
  readonly onLoadEarlier: () => void;
  readonly onOpenAncestor: (nodeId: string | null) => void;
  readonly onOpenStep: (entryId: string) => void;
  readonly onRetry: () => void;
  readonly rootTitle: string;
  readonly state: SubagentDetail["state"] | "absent";
}): ReactNode {
  const { detail, state } = props;
  const headerHeight = useHeaderHeight();
  const gutter = useGutter();
  const insets = useContentInsets();
  const column = useReadingColumn();
  const list = useRef<ScrollViewInstance>(null);
  const atEnd = useRef(false);
  const card = detail?.card ?? null;
  const settled = card !== null && card.endedAt !== null;
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
          contentOffset.y > 0 &&
          contentOffset.y + layoutMeasurement.height >= contentSize.height - space[48];
      }}
      ref={list}
      scrollEventThrottle={32}
      scrollIndicatorInsets={{ bottom: props.clearance, top: headerHeight }}
    >
      {detail === null || card === null ? (
        <Skeleton label="Loading this subagent" />
      ) : (
        <>
          {detail.lineage.length > 0 ? (
            <Lineage
              lineage={detail.lineage}
              onOpen={props.onOpenAncestor}
              rootTitle={props.rootTitle}
            />
          ) : null}
          <View style={styles.heading}>
            <View accessibilityRole="header">
              <AppText role="displaySmall">{card.title}</AppText>
            </View>
            <Meta card={card} />
          </View>
          {detail.prompt ? (
            <Section title="Asked to">
              <Fold text={detail.prompt} />
            </Section>
          ) : null}
          {card.workflow ? (
            <Section title="Phases">
              <View>
                <WorkflowPhases card={card} />
              </View>
            </Section>
          ) : null}
          {settled && (detail.result || card.tone !== "finished") ? (
            <Section title={card.tone === "finished" ? "Result" : "What happened"}>
              <Outcome card={card} result={detail.result} />
            </Section>
          ) : null}
          {card.workflow ? null : (
            <Section title="Steps">
              <Steps
                agentScope={props.agentScope}
                detail={detail}
                live={props.live}
                onLoadEarlier={props.onLoadEarlier}
                onOpenStep={props.onOpenStep}
                onRetry={props.onRetry}
                settled={settled}
                state={state}
              />
            </Section>
          )}
        </>
      )}
    </ScrollView>
  );
}

/** "Fix checkout on mobile › Trace the payment flow": who started it, each a way back up. */
function Lineage(props: {
  readonly lineage: SubagentDetail["lineage"];
  readonly onOpen: (nodeId: string | null) => void;
  readonly rootTitle: string;
}): ReactNode {
  const steps = [{ nodeId: null, title: props.rootTitle }, ...props.lineage];
  return (
    <View style={styles.path}>
      {steps.map((step, index) => (
        <View key={step.nodeId ?? "root"} style={styles.pathStep}>
          {index === 0 ? null : <Symbol name="chevron.right" size={9} tint={color.mutedDim} />}
          <Pressable
            accessibilityLabel={index === 0 ? `Started by ${step.title}` : step.title}
            accessibilityRole="link"
            hitSlop={{ bottom: space[12], top: space[12] }}
            onPress={() => props.onOpen(step.nodeId)}
            style={({ pressed }) => [styles.pathLink, pressed && styles.pressed]}
          >
            <AppText numberOfLines={1} role="caption" tone="muted">
              {step.title}
            </AppText>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

/** Where it stands, how long, what it is and on what model, in one line. */
function Meta(props: { readonly card: AgentCard }): ReactNode {
  const { card } = props;
  return (
    <View style={styles.meta}>
      <AgentMark card={card} />
      <AppText role="caption" style={[styles.word, toneInk(card)]} tone="soft">
        {card.word}
      </AppText>
      <Elapsed endedAt={card.endedAt} startedAt={card.startedAt} style={styles.metaTime} />
      <AppText role="caption" tone="muted">
        {["", card.noun, card.modelLabel].filter((part) => part !== null).join(" · ")}
      </AppText>
    </View>
  );
}

function toneInk(card: AgentCard) {
  return card.tone === "needs-you"
    ? styles.attention
    : card.tone === "failed"
      ? styles.failed
      : undefined;
}

function Section(props: { readonly children: ReactNode; readonly title: string }): ReactNode {
  return (
    <View style={styles.section}>
      <View accessibilityRole="header">
        <AppText role="caption" style={styles.eyebrow} tone="muted">
          {props.title}
        </AppText>
      </View>
      {props.children}
    </View>
  );
}

/** What it was asked, three lines at first; the rest one tap away. */
function Fold(props: { readonly text: string }): ReactNode {
  const { fontScale } = useWindowDimensions();
  const [open, setOpen] = useState(false);
  const [height, setHeight] = useState<number | null>(null);
  const fold = 3 * type.secondary.lineHeight * fontScale;
  const overflowing = height !== null && height > fold + 1;
  return (
    <View>
      <View style={open ? undefined : [styles.fold, { maxHeight: fold }]}>
        <View onLayout={(event) => setHeight(event.nativeEvent.layout.height)}>
          <AppText role="secondary" selectable tone="soft">
            {props.text}
          </AppText>
        </View>
      </View>
      {overflowing ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen(!open)}
          style={styles.foldToggle}
        >
          <AppText role="secondaryMedium" tone="ember">
            {open ? "Show less" : "Show more"}
          </AppText>
        </Pressable>
      ) : null}
    </View>
  );
}

/** A settled subagent's full result; a failed or stopped one leads with how it ended. */
function Outcome(props: { readonly card: AgentCard; readonly result: string | null }): ReactNode {
  const { card, result } = props;
  if (result)
    return (
      <Animated.View entering={appear}>
        {card.tone === "finished" || !card.detail[0] ? null : (
          <AppText
            role="secondary"
            style={card.detail[0].tone === "failed" ? styles.failed : undefined}
            tone="soft"
          >
            {`${card.detail[0].text}.`}
          </AppText>
        )}
        <Markdown text={result} />
      </Animated.View>
    );
  return (
    <AppText role="secondary" tone="soft">
      {card.detail.map((phrase, index) => (
        <AppText
          key={index}
          role="secondary"
          style={phrase.tone === "failed" ? styles.failed : undefined}
          tone="soft"
        >
          {`${index > 0 ? " " : ""}${phrase.text}.`}
        </AppText>
      ))}
    </AppText>
  );
}

function Steps(props: {
  readonly agentScope: AgentScope;
  readonly detail: SubagentDetail;
  readonly live: boolean;
  readonly onLoadEarlier: () => void;
  readonly onOpenStep: (entryId: string) => void;
  readonly onRetry: () => void;
  readonly settled: boolean;
  readonly state: SubagentDetail["state"] | "absent";
}): ReactNode {
  const { detail, state } = props;
  const now = detail.card.moving ? detail.card.detail[0] : undefined;
  switch (state) {
    case "loading":
    case "absent":
      return <Skeleton label="Loading this subagent's steps" />;
    case "error":
      return (
        <Note title="Couldn't load its steps.">
          <View style={styles.retry}>
            <AnswerPill label="Try again" onPress={props.onRetry} tone="secondary" />
          </View>
        </Note>
      );
    case "summary-only":
    case "unavailable":
      return (
        <Note
          title={
            state === "unavailable"
              ? "Update Opensteer on this computer to see a subagent's steps."
              : "Only its summary was recorded."
          }
        />
      );
    case "ready":
    case "missing":
      return (
        <>
          {detail.hasEarlier || detail.loadingEarlier ? (
            <View style={styles.earlier}>
              <AnswerPill
                busy={detail.loadingEarlier}
                label="Show earlier steps"
                onPress={props.onLoadEarlier}
                tone="secondary"
              />
            </View>
          ) : null}
          <SubagentSteps
            active={!props.settled}
            agentScope={props.agentScope}
            entries={detail.entries}
            live={props.live}
            onOpenStep={props.onOpenStep}
          />
          {now === undefined ? null : (
            <Animated.View
              accessibilityLabel={`Subagent status: ${now.text}`}
              entering={appear}
              key={now.text}
              style={styles.now}
            >
              <AppText role="secondaryMedium" tone="soft">
                {now.text}
              </AppText>
            </Animated.View>
          )}
          {detail.entries.length === 0 && !props.settled && now === undefined ? (
            <AppText role="secondary" tone="muted">
              Nothing to show yet.
            </AppText>
          ) : null}
        </>
      );
  }
}

function Skeleton(props: { readonly label: string }): ReactNode {
  return (
    <View
      accessibilityLabel={props.label}
      accessibilityRole="progressbar"
      accessible
      style={styles.skeleton}
    >
      {[68, 84, 54].map((width) => (
        <View key={width} style={[styles.skeletonLine, { width: `${width}%` }]} />
      ))}
    </View>
  );
}

function Note(props: { readonly children?: ReactNode; readonly title: string }): ReactNode {
  return (
    <View style={styles.note}>
      <Symbol name="eye" size={14} tint={color.muted} />
      <View style={styles.noteWords}>
        <AppText role="secondary" tone="muted">
          {props.title}
        </AppText>
        {props.children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  attention: { color: color.amber },
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
    paddingVertical: space[6],
  },
  barWords: { flex: 1 },
  body: { gap: space[16] },
  center: { textAlign: "center" },
  earlier: { alignItems: "flex-start", paddingBottom: space[4] },
  eyebrow: { fontWeight: "700", letterSpacing: 0.6, textTransform: "uppercase" },
  failed: { color: color.red },
  fold: { overflow: "scroll" },
  foldToggle: { justifyContent: "center", minHeight: touchTarget },
  heading: { gap: space[6] },
  hop: { alignItems: "center", flexDirection: "row" },
  hopButton: {
    alignItems: "center",
    borderRadius: radius.full,
    height: touchTarget,
    justifyContent: "center",
    width: 36,
  },
  hopCount: { fontVariant: ["tabular-nums"], minWidth: space[28], textAlign: "center" },
  meta: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: space[6] },
  metaTime: { alignSelf: "center", paddingTop: 0 },
  missing: {
    alignItems: "center",
    flex: 1,
    gap: space[14],
    justifyContent: "center",
    padding: space[24],
  },
  note: { flexDirection: "row", gap: space[8], paddingVertical: space[4] },
  noteWords: { flex: 1, gap: space[4] },
  now: { paddingTop: space[4] },
  path: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: space[4] },
  pathLink: { maxWidth: 220 },
  pathStep: { alignItems: "center", flexDirection: "row", gap: space[4] },
  pressed: { opacity: 0.6 },
  retry: { alignItems: "flex-start", paddingTop: space[4] },
  section: { gap: space[6] },
  skeleton: { gap: space[12], paddingVertical: space[8] },
  skeletonLine: { ...material.quiet, borderRadius: radius.xs, height: 12 },
  strong: { fontWeight: "500" },
  word: { fontWeight: "600" },
});
