import {
  canRespondToRequests,
  describeEvent,
  describeRepeating,
  formatFullMoment,
  formatMoment,
  schedulesClient,
  threadInDirectory,
  watchState,
  type HostClient,
  type HostSnapshot,
  type ScheduleDetail,
} from "@opensteer/client/host";
import { useHostSelector, useSchedule } from "@opensteer/client/react";
import { isRecord } from "@opensteer/shared/isRecord";
import {
  StackActions,
  useIsFocused,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { memo, useCallback, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import {
  color,
  controlFontScaleLimit,
  material,
  radius,
  space,
  touchTarget,
  type,
} from "../theme.js";
import { AppText, Notice, StatusDot } from "../ui/primitives.js";
import { Screen, useListContentInsets, useReadingColumn } from "../ui/screen.js";
import { Symbol, type SFSymbolName } from "../ui/symbol.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";
import { AnchorMark, ScheduleGroupHead, ScheduleProblem, useShownSchedule } from "./schedules.js";

/**
 * The `Schedule` route: one schedule, by the id the Host gave it. Anything
 * that lists a schedule — Schedules, or a thread's own Around sheet — opens
 * it by pushing this route with these params.
 */
export type ScheduleDestination = {
  readonly deploymentId: string;
  readonly triggerId: string;
};

export type ScheduleScreenProps = StaticScreenProps<ScheduleDestination>;

/**
 * One schedule: whether it is on, the thread it runs in, when it runs, and
 * what each recent run did. Pause, Resume and Run now are asked of the Host
 * and settle only on what the Host then says, never on the tap alone; pausing
 * stops future runs, not one already going.
 */
export function ScheduleScreen(props: ScheduleScreenProps): ReactNode {
  const { deploymentId, triggerId } = props.route.params;
  const hostClient = useAttachedHost(deploymentId);
  if (hostClient === null) return <DeploymentGate deploymentId={deploymentId} />;
  return (
    <ScheduleForHost deploymentId={deploymentId} hostClient={hostClient} triggerId={triggerId} />
  );
}

const selectReader = (snapshot: HostSnapshot) =>
  snapshot.session === "authenticated" ? (snapshot.user?.id ?? null) : null;

function ScheduleForHost(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
  readonly triggerId: string;
}): ReactNode {
  const reader = useHostSelector(props.hostClient, selectReader);
  if (reader === null) {
    return (
      <Screen>
        <Notice
          detail="This schedule appears once you are signed in."
          title="Connecting…"
          tone="neutral"
        />
      </Screen>
    );
  }
  return <ScheduleView key={reader} {...props} />;
}

const selectHomeThreadId = (snapshot: HostSnapshot) => snapshot.homeThreadId;
const selectChangeBlocked = (snapshot: HostSnapshot): string | null =>
  canRespondToRequests(snapshot) ? null : "Connect to the Host to change schedules.";

type ScheduleAction = "pause" | "resume" | "run";

function ScheduleView(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
  readonly triggerId: string;
}): ReactNode {
  const { deploymentId, hostClient, triggerId } = props;
  const navigation = useNavigation();
  const column = useReadingColumn();
  const insets = useListContentInsets(space[32]);
  const state = useSchedule(hostClient, triggerId, useIsFocused());
  const detail = useShownSchedule(state);
  const blocked = useHostSelector(hostClient, selectChangeBlocked);
  const homeThreadId = useHostSelector(hostClient, selectHomeThreadId);
  const [pending, setPending] = useState<ScheduleAction | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const name = detail?.item.name ?? "";
  useLayoutEffect(() => {
    navigation.setOptions({ title: name });
  }, [name, navigation]);

  const reload = useCallback(
    () =>
      schedulesClient(hostClient)
        .detail(triggerId)
        .refresh()
        .catch(() => undefined),
    [hostClient, triggerId],
  );
  const pull = useCallback(() => {
    setRefreshing(true);
    void reload().finally(() => setRefreshing(false));
  }, [reload]);

  const act = useCallback(
    (action: ScheduleAction) => {
      setPending(action);
      setFailure(null);
      void schedulesClient(hostClient)
        .act(triggerId, action)
        .catch((error: unknown) =>
          setFailure(operationDetail(error, "The schedule could not be changed.")),
        )
        .finally(() => setPending(null));
    },
    [hostClient, triggerId],
  );

  /**
   * Chat is the root under every stack, so it is returned to. A conversation
   * directly under this screen is returned to rather than opened a second
   * time; anything else is pushed, so Back comes here.
   */
  const openThread = useCallback(
    (threadId: string, messageId?: string) => {
      const at = messageId === undefined ? {} : { messageId };
      if (threadId === homeThreadId) {
        navigation.dispatch(StackActions.popTo("Home", { deploymentId, ...at }));
        return;
      }
      const stack = navigation.getState();
      const under = stack === undefined ? undefined : stack.routes[stack.index - 1];
      const params = { deploymentId, threadId, ...at };
      if (
        under?.name === "Thread" &&
        isRecord(under.params) &&
        under.params["deploymentId"] === deploymentId &&
        under.params["threadId"] === threadId
      ) {
        navigation.dispatch(StackActions.popTo("Thread", params));
        return;
      }
      navigation.dispatch(StackActions.push("Thread", params));
    },
    [deploymentId, homeThreadId, navigation],
  );

  return (
    <Screen edgeToEdge>
      <ScrollView
        contentContainerStyle={[styles.content, column, insets]}
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={
          <RefreshControl onRefresh={pull} refreshing={refreshing} tintColor={color.muted} />
        }
      >
        {detail === null ? (
          state.status === "loading" ? (
            <View accessibilityLabel="Loading schedule" style={styles.loading}>
              <ActivityIndicator color={color.muted} />
            </View>
          ) : (
            <ScheduleProblem onRetry={() => void reload()} state={state} />
          )
        ) : (
          <>
            {state.status === "offline" ? (
              <ScheduleProblem onRetry={() => void reload()} state={state} />
            ) : null}
            <ScheduleBody
              blocked={blocked}
              detail={detail}
              failure={failure}
              hostClient={hostClient}
              onAct={act}
              onOpenThread={openThread}
              pending={pending}
            />
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

function ScheduleBody(props: {
  readonly blocked: string | null;
  readonly detail: ScheduleDetail;
  readonly failure: string | null;
  readonly hostClient: HostClient;
  readonly onAct: (action: ScheduleAction) => void;
  readonly onOpenThread: (threadId: string, messageId?: string) => void;
  readonly pending: ScheduleAction | null;
}): ReactNode {
  const { detail, pending } = props;
  const { item, definition } = detail;
  const source = definition.revision.source;
  const now = Date.now();
  const watch =
    item.kind === "watch" && definition.activation !== null
      ? watchState(definition.activation.observed)
      : null;
  const status = [
    item.statusWord,
    item.status === "active" ? watch?.text : null,
    definition.createdByThreadTitle === null
      ? null
      : `created by ${definition.createdByThreadTitle}`,
  ]
    .filter((part) => part !== null && part !== undefined)
    .join(" · ");
  // A watch's last error matters while it is struggling, not once it runs again.
  const problem =
    item.status === "paused"
      ? item.pauseReason
      : watch?.tone === "warn"
        ? (definition.activation?.lastError ?? null)
        : null;
  const changeable = item.status !== "archived";
  const reachable = useReachableThreads(props.hostClient, detail);

  return (
    <View style={styles.body}>
      <View accessible accessibilityLabel={status} style={styles.status}>
        <StatusDot
          live={watch?.text === "Watching"}
          tone={item.status === "active" ? "green" : item.pauseReason === null ? "muted" : "amber"}
        />
        <AppText role="secondary" style={styles.statusWords} tone="muted">
          {status}
        </AppText>
      </View>
      {problem === null ? null : (
        <AppText role="secondary" style={styles.problem}>
          {problem}
        </AppText>
      )}

      <Pressable
        accessibilityHint={item.anchor.visible ? "Opens the thread" : undefined}
        accessibilityLabel={`Runs in ${item.anchor.title}`}
        accessibilityRole={item.anchor.visible ? "button" : "text"}
        accessibilityState={{ disabled: !item.anchor.visible }}
        disabled={!item.anchor.visible}
        onPress={() => props.onOpenThread(item.anchor.threadId)}
        style={({ pressed }) => [styles.plate, styles.anchor, pressed && styles.pressed]}
      >
        <AnchorMark anchor={item.anchor} size={22} />
        <View style={styles.words}>
          <AppText numberOfLines={2} role="bodyMedium">
            Runs in {item.anchor.title}
          </AppText>
          <AppText role="caption" tone="muted">
            {item.anchor.visible
              ? "Each run posts its result there"
              : "That thread isn’t available to you"}
          </AppText>
        </View>
        {item.anchor.visible ? (
          <Symbol name="chevron.right" size={13} tint={color.mutedDim} />
        ) : null}
      </Pressable>

      <View style={styles.plate}>
        <Fact
          label="When"
          value={
            source.kind === "schedule"
              ? source.schedule.kind === "cron"
                ? describeRepeating(source.schedule)
                : formatFullMoment(source.schedule.at)
              : describeEvent(source.kind, null)
          }
        />
        {source.kind === "schedule" && source.schedule.kind === "cron" ? (
          <Fact label="Time zone" separated value={source.schedule.timezone} />
        ) : null}
        {item.nextFireAt === null ? null : (
          <Fact label="Next run" separated value={formatMoment(item.nextFireAt, now)} />
        )}
      </View>

      {changeable ? (
        <View style={styles.actionsBlock}>
          <View style={styles.actions}>
            {item.status === "paused" ? (
              <ActionButton
                busy={pending === "resume"}
                disabled={props.blocked !== null || (pending !== null && pending !== "resume")}
                icon="play"
                label="Resume"
                onPress={() => props.onAct("resume")}
              />
            ) : (
              <ActionButton
                busy={pending === "pause"}
                disabled={props.blocked !== null || (pending !== null && pending !== "pause")}
                icon="pause"
                label="Pause"
                onPress={() => props.onAct("pause")}
              />
            )}
            <ActionButton
              busy={pending === "run"}
              disabled={props.blocked !== null || (pending !== null && pending !== "run")}
              icon="play"
              label="Run now"
              onPress={() => props.onAct("run")}
            />
          </View>
          {props.blocked === null ? null : (
            <AppText role="caption" tone="muted">
              {props.blocked}
            </AppText>
          )}
          {props.failure === null ? null : (
            <AppText
              accessibilityLabel={`Not changed. ${props.failure}`}
              role="caption"
              tone="danger"
            >
              {props.failure}
            </AppText>
          )}
        </View>
      ) : null}

      <View style={styles.runs}>
        <ScheduleGroupHead title="Recent runs" />
        {detail.occurrences.length === 0 ? (
          <AppText role="secondary" style={styles.none} tone="muted">
            It hasn’t run yet.
          </AppText>
        ) : (
          <View>
            {detail.occurrences.map((run, index) => (
              <RunRow
                first={index === 0}
                key={run.occurrence.id}
                last={index === detail.occurrences.length - 1}
                now={now}
                onOpen={props.onOpenThread}
                reachable={reachable}
                run={run}
              />
            ))}
          </View>
        )}
        {definition.downstreamRunsTruncated ? (
          <AppText role="caption" style={styles.note} tone="muted">
            Replies to older runs aren’t listed.
          </AppText>
        ) : null}
      </View>
    </View>
  );
}

/**
 * The reply threads this reader can open: Chat, or a thread the Host lists
 * for them. A reply elsewhere is still told, just not offered as a way in.
 */
function useReachableThreads(hostClient: HostClient, detail: ScheduleDetail): string {
  const ids = useMemo(
    () => [
      ...new Set(
        detail.occurrences.flatMap(({ replies }) => replies.map(({ run }) => run.threadId)),
      ),
    ],
    [detail],
  );
  return useHostSelector(
    hostClient,
    useCallback(
      (snapshot: HostSnapshot) =>
        ids
          .filter((id) => id === snapshot.homeThreadId || threadInDirectory(id, snapshot) !== null)
          .join("\n"),
      [ids],
    ),
  );
}

function Fact(props: {
  readonly label: string;
  readonly separated?: boolean;
  readonly value: string;
}): ReactNode {
  return (
    <View
      accessible
      accessibilityLabel={`${props.label}, ${props.value}`}
      style={[styles.fact, props.separated === true && styles.separated]}
    >
      <AppText role="secondary" tone="muted">
        {props.label}
      </AppText>
      <AppText role="secondary" style={styles.factValue}>
        {props.value}
      </AppText>
    </View>
  );
}

/** One of the schedule's two acts: it shows its own wait, and is the only one live while it does. */
function ActionButton(props: {
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly icon: SFSymbolName;
  readonly label: string;
  readonly onPress: () => void;
}): ReactNode {
  const off = props.disabled || props.busy;
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      accessibilityState={{ busy: props.busy, disabled: off }}
      disabled={off}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.action,
        pressed && styles.actionPressed,
        props.disabled && styles.actionDisabled,
      ]}
    >
      {props.busy ? (
        <ActivityIndicator color={color.ember} size="small" />
      ) : (
        <Symbol name={props.icon} size={14} tint={color.text} weight="semibold" />
      )}
      <Text
        maxFontSizeMultiplier={controlFontScaleLimit}
        numberOfLines={1}
        style={[type.secondaryMedium, styles.actionLabel]}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

const runGlyph: Record<
  ScheduleDetail["occurrences"][number]["occurrence"]["status"],
  { readonly name: SFSymbolName; readonly tint: string }
> = {
  canceled: { name: "stop.circle", tint: color.muted },
  failed: { name: "xmark", tint: color.red },
  pending: { name: "clock", tint: color.muted },
  running: { name: "circle.dotted", tint: color.ember },
  succeeded: { name: "checkmark", tint: color.green },
};

const RunRow = memo(function RunRow(props: {
  readonly first: boolean;
  readonly last: boolean;
  readonly now: number;
  readonly onOpen: (threadId: string, messageId?: string) => void;
  /** Newline-joined ids of the reply threads this reader can open. */
  readonly reachable: string;
  readonly run: ScheduleDetail["occurrences"][number];
}): ReactNode {
  const { occurrence, outcome, error, replies } = props.run;
  const reply = replies[0];
  const openable = reply !== undefined && props.reachable.split("\n").includes(reply.run.threadId);
  const when = formatMoment(occurrence.createdAt, props.now);
  const glyph = runGlyph[occurrence.status];
  return (
    <Pressable
      accessibilityHint={openable ? "Opens the reply" : undefined}
      accessibilityLabel={[when, outcome, error].filter((part) => part !== null).join(". ")}
      accessibilityRole={openable ? "button" : "text"}
      accessibilityState={{ disabled: !openable }}
      disabled={!openable}
      onPress={() => {
        if (reply !== undefined) props.onOpen(reply.run.threadId, reply.run.seedInputId);
      }}
      style={({ pressed }) => [
        styles.run,
        props.first && styles.rowFirst,
        props.last && styles.rowLast,
        !props.first && styles.separated,
        pressed && styles.pressed,
      ]}
    >
      <View style={styles.runGlyph}>
        <Symbol name={glyph.name} size={15} tint={glyph.tint} weight="semibold" />
      </View>
      <View style={styles.words}>
        <AppText numberOfLines={2} role="secondaryMedium">
          {when} · {outcome}
        </AppText>
        {error === null ? null : (
          <AppText numberOfLines={3} role="caption" tone="muted">
            {error}
          </AppText>
        )}
      </View>
      {openable ? <Symbol name="chevron.right" size={13} tint={color.mutedDim} /> : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  action: {
    ...material.control,
    alignItems: "center",
    borderRadius: radius.full,
    flex: 1,
    flexDirection: "row",
    gap: space[8],
    justifyContent: "center",
    minHeight: touchTarget,
    paddingHorizontal: space[16],
  },
  actionDisabled: { opacity: 0.45 },
  actionLabel: { color: color.text },
  actionPressed: { ...material.platePressed },
  actions: { flexDirection: "row", gap: space[12] },
  actionsBlock: { gap: space[8] },
  anchor: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget + space[16],
    paddingHorizontal: space[14],
    paddingVertical: space[10],
  },
  body: { gap: space[16] },
  content: { paddingTop: space[8] },
  fact: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space[12],
    justifyContent: "space-between",
    minHeight: touchTarget,
    paddingHorizontal: space[14],
    paddingVertical: space[10],
  },
  factValue: { color: color.text, flexShrink: 1, textAlign: "right" },
  loading: { alignItems: "center", paddingVertical: space[48] },
  none: { paddingHorizontal: space[4] },
  note: { paddingHorizontal: space[4], paddingTop: space[8] },
  plate: { backgroundColor: color.surface, borderRadius: radius.md, overflow: "hidden" },
  pressed: { backgroundColor: color.surfacePressed },
  problem: { color: color.amber, marginTop: -space[8] },
  rowFirst: { borderTopLeftRadius: radius.md, borderTopRightRadius: radius.md },
  rowLast: { borderBottomLeftRadius: radius.md, borderBottomRightRadius: radius.md },
  runs: { marginTop: -space[16] },
  run: {
    alignItems: "center",
    backgroundColor: color.surface,
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget + space[12],
    paddingHorizontal: space[14],
    paddingVertical: space[10],
  },
  runGlyph: { alignItems: "center", width: 20 },
  separated: { borderColor: color.line, borderTopWidth: StyleSheet.hairlineWidth },
  status: { alignItems: "center", flexDirection: "row", gap: space[8] },
  statusWords: { flexShrink: 1 },
  words: { flex: 1, gap: space[2], minWidth: 0 },
});
