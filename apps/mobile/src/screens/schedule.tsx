import type { ActionOutcome } from "@opensteer/client/actions";
import {
  describeEvent,
  describeRepeating,
  formatFullMoment,
  formatMoment,
  mutationIdempotencyKey,
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
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  color,
  controlFontScaleLimit,
  material,
  radius,
  space,
  touchTarget,
  type,
} from "../theme.js";
import { useAppForeground } from "../ui/foreground.js";
import { ActionLine, type ActionLineValue } from "../ui/action-line.js";
import { actionLine, notDone, useScreenAction } from "../ui/client-feedback.js";
import { PlaceholderRows } from "../ui/placeholder.js";
import { AppText, StatusDot } from "../ui/primitives.js";
import { Screen, useListContentInsets, useReadingColumn } from "../ui/screen.js";
import { Symbol, type SFSymbolName } from "../ui/symbol.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";
import { AnchorMark, ScheduleGroupHead } from "./automation-parts.js";
import { ScheduleProblem, useShownSchedule } from "./schedules.js";

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
        <PlaceholderRows />
      </Screen>
    );
  }
  return <ScheduleView key={`${reader}:${props.triggerId}`} {...props} />;
}

type ScheduleAction = "pause" | "resume" | "run";
const scheduleDone: Record<ScheduleAction, string> = {
  pause: "paused",
  resume: "resumed",
  run: "started",
};
const scheduleHappened: Record<ScheduleAction, string> = {
  pause: "this schedule was paused",
  resume: "this schedule was resumed",
  run: "this schedule started",
};

function ScheduleView(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
  readonly triggerId: string;
}): ReactNode {
  const { deploymentId, hostClient, triggerId } = props;
  const navigation = useNavigation();
  const column = useReadingColumn();
  const insets = useListContentInsets(space[32]);
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const state = useSchedule(hostClient, triggerId, focused && foreground);
  const detail = useShownSchedule(state);
  const [pending, setPending] = useState<ScheduleAction | null>(null);
  const [answer, setAnswer] = useState<{
    readonly action: ScheduleAction;
    readonly outcome: ActionOutcome<unknown>;
  } | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const name =
    detail?.item.systemRole === "memory-light"
      ? "Light memory pass"
      : detail?.item.systemRole === "memory-nightly"
        ? "Nightly memory pass"
        : (detail?.item.name ?? "");
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

  // An unanswered change keeps its idempotency key, so asking again is the check:
  // the Host answers for the first attempt instead of doing it twice.
  const act = useCallback(
    (action: ScheduleAction) => {
      setPending(action);
      setAnswer(null);
      void schedulesClient(hostClient)
        .act(triggerId, action)
        .then((outcome) => setAnswer({ action, outcome }))
        .finally(() => setPending(null));
    },
    [hostClient, triggerId],
  );
  const line = useMemo(() => {
    if (answer === null || answer.outcome.kind === "confirmed") return null;
    const issue = answer.outcome.issue && {
      ...answer.outcome.issue,
      done: scheduleDone[answer.action],
      happened: scheduleHappened[answer.action],
    };
    return actionLine(
      { outcome: { ...answer.outcome, issue }, issue },
      { check: () => act(answer.action) },
      answer.action,
    );
  }, [act, answer]);

  /**
   * A conversation directly under this screen is returned to rather than
   * opened a second time; anything else is pushed, so Back comes here.
   */
  const openThread = useCallback(
    (threadId: string, messageId?: string) => {
      const at = messageId === undefined ? {} : { messageId };
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
    [deploymentId, navigation],
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
          <ScheduleProblem onRetry={() => void reload()} state={state} />
        ) : (
          <>
            {state.issue === null ? null : (
              <ScheduleProblem onRetry={() => void reload()} state={state} />
            )}
            <ScheduleBody
              detail={detail}
              line={line}
              onDismissLine={() => setAnswer(null)}
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
  readonly detail: ScheduleDetail;
  readonly line: ActionLineValue | null;
  readonly onDismissLine: () => void;
  readonly hostClient: HostClient;
  readonly onAct: (action: ScheduleAction) => void;
  readonly onOpenThread: (threadId: string, messageId?: string) => void;
  readonly pending: ScheduleAction | null;
}): ReactNode {
  const { detail, pending } = props;
  const { item, definition } = detail;
  const managed = item.systemRole != null;
  const worker = definition.anchorThread;
  // Reopen and Resume are separate actions, so an outcome keeps the words of the verb tapped.
  const verb = worker?.doneAt ? "reopen" : "resume";
  const done = verb === "reopen" ? "reopened" : "resumed";
  const recovery = useScreenAction<"reopen" | "resume", void>(
    props.hostClient,
    `schedule-worker:${verb}:${worker?.id ?? item.id}`,
    {
      label: "restart the worker",
      done,
      happened: `the worker was ${done}`,
      execute: async (kind) => {
        if (!worker) return;
        if (kind === "reopen") await props.hostClient.setTaskDone(worker.id, false);
        else await props.hostClient.resumeThreadInputQueue(worker.id);
        void schedulesClient(props.hostClient).detail(item.id).refresh();
      },
      reconcile: async (kind) => {
        const resource = schedulesClient(props.hostClient).detail(item.id);
        await resource.refresh();
        const shown = resource.getSnapshot();
        const anchor = shown.status === "ready" ? shown.data.definition.anchorThread : null;
        if (!anchor) return null;
        const stillStopped = kind === "reopen" ? anchor.doneAt !== null : anchor.inputQueuePaused;
        return stillStopped
          ? notDone(kind === "reopen" ? "reopened" : "resumed")
          : { kind: "confirmed", value: undefined };
      },
      retry: () => void recovery.run(verb),
    },
  );
  const recovering = recovery.running;
  const recover = () => recovery.run(verb);
  const source = definition.revision.source;
  const now = Date.now();
  const watch =
    item.kind === "watch" && definition.activation !== null
      ? watchState(definition.activation.observed, definition.activation.contactLostAt, now)
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
      : (item.waitingReason ??
        (watch?.tone === "warn" ? (definition.activation?.lastError ?? null) : null));
  const changeable = item.status !== "archived";
  const reachable = useReachableThreads(props.hostClient, detail);

  return (
    <View style={styles.body}>
      {managed ? (
        <AppText role="secondary" tone="muted">
          {item.systemRole === "memory-light"
            ? "Light memory pass — checks what’s new and tells you when something matters."
            : "Nightly memory pass — tidies memory and prepares tomorrow."}
        </AppText>
      ) : null}
      <View accessible accessibilityLabel={status} style={styles.status}>
        <StatusDot
          live={watch?.text === "Watching"}
          tone={
            item.waitingReason
              ? "amber"
              : item.status === "active"
                ? "green"
                : item.pauseReason === null
                  ? "muted"
                  : "amber"
          }
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
              ? managed
                ? "It tells you when something matters"
                : "Each run posts its result there"
              : "That task isn’t available to you"}
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
                disabled={pending !== null && pending !== "resume"}
                icon="play"
                label="Resume"
                onPress={() => props.onAct("resume")}
              />
            ) : (
              <ActionButton
                busy={pending === "pause"}
                disabled={pending !== null && pending !== "pause"}
                icon="pause"
                label="Pause"
                onPress={() => props.onAct("pause")}
              />
            )}
            {managed ? null : (
              <ActionButton
                busy={pending === "run"}
                disabled={pending !== null && pending !== "run"}
                icon="play"
                label="Run now"
                onPress={() => props.onAct("run")}
              />
            )}
          </View>
          {props.line === null ? null : (
            <ActionLine
              line={props.line}
              onDismiss={props.line.tone === "danger" ? props.onDismissLine : undefined}
            />
          )}
        </View>
      ) : null}

      {managed && worker && (worker.doneAt || worker.inputQueuePaused) ? (
        <View style={styles.actionsBlock}>
          <ActionButton
            busy={recovering}
            disabled={pending !== null}
            icon="play"
            label={worker.doneAt ? "Reopen worker" : "Resume worker"}
            onPress={() => void recover()}
          />
          <AppText role="caption" tone="muted">
            {worker.doneAt
              ? "Reopening the worker leaves the memory pass paused until you resume it."
              : "Resuming the worker leaves the memory pass’s schedule unchanged."}
          </AppText>
        </View>
      ) : null}
      {recovery.line === null ? null : (
        <ActionLine line={recovery.line} onDismiss={recovery.dismiss} />
      )}
      {managed ? (
        <View style={styles.plate}>
          <Fact
            label="Source"
            value={definition.revision.script?.text ?? definition.revision.legacySource ?? ""}
          />
        </View>
      ) : (
        <AutomationSecretsCard
          changeable={changeable}
          hostClient={props.hostClient}
          names={definition.secretNames ?? []}
          triggerId={item.id}
          unreadable={definition.secretsUnreadable === true}
        />
      )}
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
 * The reply threads this reader can open: those the Host lists for them. A reply elsewhere is still told, just not offered as a way in.
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
        ids.filter((id) => threadInDirectory(id, snapshot) !== null).join("\n"),
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
  unknown: { name: "questionmark.circle", tint: color.amber },
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
  const { occurrence, outcome, error, output, replies } = props.run;
  const outputNotice = occurrence.outputPrunedAt ? output : null;
  const reply = replies[0];
  const openable = reply !== undefined && props.reachable.split("\n").includes(reply.run.threadId);
  const when = formatMoment(occurrence.createdAt, props.now);
  const glyph = runGlyph[occurrence.status];
  return (
    <Pressable
      accessibilityHint={openable ? "Opens the reply" : undefined}
      accessibilityLabel={[when, outcome, error, outputNotice]
        .filter((part) => part !== null)
        .join(". ")}
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
        {outputNotice === null ? null : (
          <AppText numberOfLines={3} role="caption" tone="muted">
            {outputNotice}
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
  secretActions: { flexDirection: "row", gap: space[8] },
  secretBtn: {
    ...material.control,
    borderRadius: radius.sm,
    justifyContent: "center",
    minHeight: 32,
    paddingHorizontal: space[10],
  },
  secretError: { color: color.red },
  secretForm: { gap: space[10], padding: space[14] },
  secretHead: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  secretInput: {
    backgroundColor: color.background,
    borderColor: color.line,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    color: color.text,
    minHeight: touchTarget,
    paddingHorizontal: space[12],
  },
  secretRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[10],
    justifyContent: "space-between",
    minHeight: touchTarget,
    paddingHorizontal: space[14],
    paddingVertical: space[8],
  },
  secretSection: { gap: space[8] },
  separated: { borderColor: color.line, borderTopWidth: StyleSheet.hairlineWidth },
  status: { alignItems: "center", flexDirection: "row", gap: space[8] },
  statusWords: { flexShrink: 1 },
  words: { flex: 1, gap: space[2], minWidth: 0 },
});

/** Write-only secrets for one automation: names are listed; values are never shown again. */
function AutomationSecretsCard(props: {
  readonly changeable: boolean;
  readonly hostClient: HostClient;
  readonly names: readonly string[];
  readonly triggerId: string;
  readonly unreadable: boolean;
}): ReactNode {
  const [editing, setEditing] = useState<{
    readonly mode: "add" | "replace";
    readonly name: string;
  } | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);
  const [confirmingClearAll, setConfirmingClearAll] = useState(false);
  const [unreadableDetected, setUnreadableDetected] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [valueInput, setValueInput] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  // Keep the typed value ONLY in a transient local ref cleared immediately before dispatch and on
  // unmount, never in `useScreenAction`'s retained input (R7).
  const pendingValueRef = useRef<string | null>(null);
  useEffect(
    () => () => {
      pendingValueRef.current = null;
    },
    [],
  );

  const isUnreadable = props.unreadable || unreadableDetected;

  const refreshSecretDetail = async () => {
    const resource = schedulesClient(props.hostClient).detail(props.triggerId);
    await resource.refresh();
    const shown = resource.getSnapshot();
    if (shown.status !== "ready") return null;
    return {
      names: shown.data.definition.secretNames ?? [],
      unreadable: shown.data.definition.secretsUnreadable === true,
    };
  };

  const saveAction = useScreenAction<
    { readonly mode: "add" | "replace"; readonly name: string },
    void
  >(props.hostClient, `trigger-secrets-save:${props.triggerId}`, {
    label: "save this secret",
    done: "saved",
    happened: "the secret was saved",
    execute: async ({ name }) => {
      const value = pendingValueRef.current;
      pendingValueRef.current = null;
      if (value === null) return;
      try {
        await props.hostClient.dispatch({
          idempotencyKey: mutationIdempotencyKey(`trigger-secrets:${props.triggerId}`),
          set: { [name]: value },
          triggerId: props.triggerId,
          type: "trigger.secrets.set",
        });
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "reason" in error &&
          (error as { readonly reason?: unknown }).reason === "automation-secrets-unreadable"
        ) {
          setUnreadableDetected(true);
          setEditing(null);
        }
        throw error;
      }
      setEditing(null);
      setNameInput("");
      setValueInput("");
      setValidationError(null);
      // A refresh error after a committed write must never turn the write into an unconfirmed or failed action (R7).
      try {
        await schedulesClient(props.hostClient).detail(props.triggerId).refresh();
      } catch {
        // Detail will refresh on next focus or pull.
      }
    },
    reconcile: async ({ mode, name }) => {
      try {
        const fresh = await refreshSecretDetail();
        if (!fresh) return null;
        if (fresh.unreadable) {
          setUnreadableDetected(true);
          return null;
        }
        // For a replacement, the name already existed before the save so `secretNames` gives no
        // evidence whether the old or new value is stored; preserve uncertainty so the person can save again (R7).
        if (mode === "replace") return null;
        if (fresh.names.includes(name)) {
          setEditing(null);
          setNameInput("");
          setValueInput("");
          return { kind: "confirmed", value: undefined };
        }
        // Rule 4: absence of the name is not evidence that the save did not happen (the lost
        // request may still be running at the Home); stay unknown rather than saying "Not saved."
        return null;
      } catch {
        return null;
      }
    },
  });
  const removeAction = useScreenAction<string, void>(
    props.hostClient,
    `trigger-secrets-remove:${props.triggerId}`,
    {
      label: "remove this secret",
      done: "removed",
      happened: "the secret was removed",
      execute: async (name) => {
        try {
          await props.hostClient.dispatch({
            idempotencyKey: mutationIdempotencyKey(`trigger-secrets:${props.triggerId}`),
            remove: [name],
            triggerId: props.triggerId,
            type: "trigger.secrets.set",
          });
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "reason" in error &&
            (error as { readonly reason?: unknown }).reason === "automation-secrets-unreadable"
          ) {
            setUnreadableDetected(true);
            setConfirmingRemove(null);
          }
          throw error;
        }
        setConfirmingRemove(null);
        try {
          await schedulesClient(props.hostClient).detail(props.triggerId).refresh();
        } catch {
          // Detail will refresh on next focus or pull.
        }
      },
      reconcile: async (name) => {
        try {
          const fresh = await refreshSecretDetail();
          if (!fresh) return null;
          if (!fresh.names.includes(name)) {
            setConfirmingRemove(null);
            return { kind: "confirmed", value: undefined };
          }
          return null;
        } catch {
          return null;
        }
      },
    },
  );
  const clearAllAction = useScreenAction<void, void>(
    props.hostClient,
    `trigger-secrets-clear:${props.triggerId}`,
    {
      label: "clear all secrets",
      done: "cleared",
      happened: "the secrets were cleared",
      execute: async () => {
        await props.hostClient.dispatch({
          clearAll: true,
          idempotencyKey: mutationIdempotencyKey(`trigger-secrets:${props.triggerId}`),
          triggerId: props.triggerId,
          type: "trigger.secrets.set",
        });
        setConfirmingClearAll(false);
        setUnreadableDetected(false);
        try {
          await schedulesClient(props.hostClient).detail(props.triggerId).refresh();
        } catch {
          // Detail will refresh on next focus or pull.
        }
      },
      reconcile: async () => {
        try {
          const fresh = await refreshSecretDetail();
          if (!fresh) return null;
          if (!fresh.unreadable && fresh.names.length === 0) {
            setConfirmingClearAll(false);
            setUnreadableDetected(false);
            return { kind: "confirmed", value: undefined };
          }
          return null;
        } catch {
          return null;
        }
      },
    },
  );
  const busy = saveAction.running || removeAction.running || clearAllAction.running;

  const openAdd = () => {
    setConfirmingRemove(null);
    setConfirmingClearAll(false);
    setEditing({ mode: "add", name: "" });
    setNameInput("");
    setValueInput("");
    setValidationError(null);
  };
  const openReplace = (name: string) => {
    setConfirmingRemove(null);
    setConfirmingClearAll(false);
    setEditing({ mode: "replace", name });
    setNameInput(name);
    setValueInput("");
    setValidationError(null);
  };
  const close = () => {
    pendingValueRef.current = null;
    setEditing(null);
    setNameInput("");
    setValueInput("");
    setValidationError(null);
  };

  const trimmedAddName = editing?.mode === "add" ? nameInput.trim() : "";
  const existingMatch =
    trimmedAddName.length > 0
      ? (props.names.find((existing) => existing.toLowerCase() === trimmedAddName.toLowerCase()) ??
        null)
      : null;

  const save = () => {
    if (!editing || busy || isUnreadable) return;
    const targetName = editing.mode === "add" ? nameInput.trim() : editing.name;
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(targetName)) {
      setValidationError(
        "Use 1 to 64 letters, digits, or underscores starting with a letter or underscore.",
      );
      return;
    }
    if (valueInput.length === 0) {
      setValidationError("Enter a value.");
      return;
    }
    const effectiveMode: "add" | "replace" =
      editing.mode === "add" && props.names.includes(targetName) ? "replace" : editing.mode;
    pendingValueRef.current = valueInput;
    setValueInput("");
    setValidationError(null);
    void saveAction.run({ mode: effectiveMode, name: targetName });
  };

  const remove = (name: string) => {
    if (busy || isUnreadable) return;
    setValidationError(null);
    void removeAction.run(name);
  };

  const clearAll = () => {
    if (busy) return;
    setValidationError(null);
    void clearAllAction.run(undefined);
  };

  return (
    <View style={styles.secretSection}>
      <View style={styles.secretHead}>
        <ScheduleGroupHead title="Secrets" />
        {props.changeable && editing === null && !isUnreadable ? (
          <Pressable
            accessibilityLabel="Add"
            accessibilityRole="button"
            disabled={busy}
            onPress={openAdd}
            style={({ pressed }) => [styles.secretBtn, pressed && styles.pressed]}
          >
            <AppText role="secondaryMedium">Add</AppText>
          </Pressable>
        ) : null}
      </View>
      <AppText role="caption" tone="muted">
        Values are added to the script’s environment as OPENSTEER_SECRET_&lt;NAME&gt; and aren’t
        shown again. The script, and any agent that can change it, can read them there. A script
        that prints a secret puts it in its run’s record, where agents that can read this automation
        can see it.
      </AppText>
      {isUnreadable ? (
        <View style={styles.plate}>
          <View style={styles.secretRow}>
            <AppText role="secondary" style={styles.words} tone="muted">
              These secrets can no longer be read. Clear all secrets before saving new ones.
            </AppText>
            <View style={styles.secretActions}>
              {confirmingClearAll ? (
                <>
                  <Pressable
                    accessibilityLabel="Cancel clear all"
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={() => setConfirmingClearAll(false)}
                    style={({ pressed }) => [styles.secretBtn, pressed && styles.pressed]}
                  >
                    <AppText role="secondary">Cancel</AppText>
                  </Pressable>
                  <Pressable
                    accessibilityLabel="Confirm clear all"
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={clearAll}
                    style={({ pressed }) => [styles.secretBtn, pressed && styles.pressed]}
                  >
                    <AppText role="secondaryMedium" style={styles.secretError}>
                      Confirm clear all
                    </AppText>
                  </Pressable>
                </>
              ) : (
                <Pressable
                  accessibilityLabel="Clear all secrets"
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => setConfirmingClearAll(true)}
                  style={({ pressed }) => [styles.secretBtn, pressed && styles.pressed]}
                >
                  <AppText role="secondaryMedium" style={styles.secretError}>
                    Clear all secrets
                  </AppText>
                </Pressable>
              )}
            </View>
          </View>
        </View>
      ) : (
        <>
          {editing !== null ? (
            <View style={[styles.plate, styles.secretForm]}>
              {editing.mode === "add" ? (
                <>
                  <TextInput
                    accessibilityLabel="Secret name"
                    autoCapitalize="none"
                    autoCorrect={false}
                    onChangeText={setNameInput}
                    placeholder="API_TOKEN"
                    placeholderTextColor={color.mutedDim}
                    style={styles.secretInput}
                    value={nameInput}
                  />
                  {existingMatch !== null ? (
                    <AppText role="caption" tone="muted">
                      {existingMatch === trimmedAddName
                        ? `Saving replaces the existing ${existingMatch} secret.`
                        : `Conflicts with existing ${existingMatch} (names are case-insensitive).`}
                    </AppText>
                  ) : null}
                </>
              ) : (
                <AppText role="secondaryMedium">Replacing {editing.name}</AppText>
              )}
              <TextInput
                accessibilityLabel={editing.mode === "add" ? "Secret value" : "New value"}
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={setValueInput}
                placeholder="Secret value"
                placeholderTextColor={color.mutedDim}
                secureTextEntry
                style={styles.secretInput}
                value={valueInput}
              />
              <View style={styles.secretActions}>
                <Pressable
                  accessibilityLabel="Cancel"
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={close}
                  style={({ pressed }) => [styles.secretBtn, pressed && styles.pressed]}
                >
                  <AppText role="secondary">Cancel</AppText>
                </Pressable>
                <Pressable
                  accessibilityLabel="Save"
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={save}
                  style={({ pressed }) => [styles.secretBtn, pressed && styles.pressed]}
                >
                  <AppText role="secondaryMedium">{busy ? "Saving…" : "Save"}</AppText>
                </Pressable>
              </View>
            </View>
          ) : null}
          {validationError !== null ? (
            <AppText role="caption" style={styles.secretError}>
              {validationError}
            </AppText>
          ) : null}
          {saveAction.line !== null ? (
            <ActionLine line={saveAction.line} onDismiss={saveAction.dismiss} />
          ) : removeAction.line !== null ? (
            <ActionLine line={removeAction.line} onDismiss={removeAction.dismiss} />
          ) : clearAllAction.line !== null ? (
            <ActionLine line={clearAllAction.line} onDismiss={clearAllAction.dismiss} />
          ) : null}
          <View style={styles.plate}>
            {props.names.length === 0 ? (
              <View style={styles.secretRow}>
                <AppText role="secondary" tone="muted">
                  No secrets yet.
                </AppText>
              </View>
            ) : (
              props.names.map((name, index) => (
                <View key={name} style={[styles.secretRow, index > 0 && styles.separated]}>
                  <AppText numberOfLines={1} role="secondaryMedium" style={styles.words}>
                    {name}
                  </AppText>
                  <View style={styles.secretActions}>
                    {confirmingRemove === name ? (
                      <>
                        <Pressable
                          accessibilityLabel={`Cancel remove ${name}`}
                          accessibilityRole="button"
                          disabled={busy}
                          onPress={() => setConfirmingRemove(null)}
                          style={({ pressed }) => [styles.secretBtn, pressed && styles.pressed]}
                        >
                          <AppText role="secondary">Cancel</AppText>
                        </Pressable>
                        <Pressable
                          accessibilityLabel="Confirm remove"
                          accessibilityRole="button"
                          disabled={busy}
                          onPress={() => remove(name)}
                          style={({ pressed }) => [styles.secretBtn, pressed && styles.pressed]}
                        >
                          <AppText role="secondaryMedium" style={styles.secretError}>
                            Confirm remove
                          </AppText>
                        </Pressable>
                      </>
                    ) : (
                      <>
                        {props.changeable ? (
                          <Pressable
                            accessibilityLabel={`Replace ${name}`}
                            accessibilityRole="button"
                            disabled={busy}
                            onPress={() => openReplace(name)}
                            style={({ pressed }) => [styles.secretBtn, pressed && styles.pressed]}
                          >
                            <AppText role="secondary">Replace</AppText>
                          </Pressable>
                        ) : null}
                        <Pressable
                          accessibilityLabel={`Remove ${name}`}
                          accessibilityRole="button"
                          disabled={busy}
                          onPress={() => {
                            close();
                            setConfirmingRemove(name);
                          }}
                          style={({ pressed }) => [styles.secretBtn, pressed && styles.pressed]}
                        >
                          <AppText role="secondary">Remove</AppText>
                        </Pressable>
                      </>
                    )}
                  </View>
                </View>
              ))
            )}
          </View>
        </>
      )}
    </View>
  );
}
