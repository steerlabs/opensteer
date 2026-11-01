import {
  formatMoment,
  schedulesClient,
  type HostClient,
  type HostSnapshot,
  type ScheduleAnchor,
  type ScheduleItem,
  type ScheduleState,
} from "@opensteer/client/host";
import { useHostSelector, useSchedules } from "@opensteer/client/react";
import {
  StackActions,
  useIsFocused,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { memo, useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  View,
  type SectionListRenderItemInfo,
} from "react-native";
import { useSidebarMenu } from "../navigation-header.js";
import { color, controlFontScaleLimit, radius, space, touchTarget } from "../theme.js";
import { ChatOrb } from "../ui/chat-orb.js";
import { useAppForeground } from "../ui/foreground.js";
import { AppText, Notice } from "../ui/primitives.js";
import { Screen, useListContentInsets, useReadingColumn } from "../ui/screen.js";
import { Symbol, type SFSymbolName } from "../ui/symbol.js";
import { TaskMark } from "../ui/task-mark.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";

export type SchedulesScreenProps = StaticScreenProps<{ readonly deploymentId: string }>;

/**
 * Schedules: everything set to run on this Deployment on its own, from the
 * sidebar like Tabs — what runs next, then what is paused and why, each with
 * the thread it runs in. A row opens the schedule; its thread is one tap from
 * there.
 *
 * It reads only while it is in front: the list is a Host read this screen
 * asks for, never part of attaching, and a screen covered by another releases
 * it.
 */
export function SchedulesScreen(props: SchedulesScreenProps): ReactNode {
  const { deploymentId } = props.route.params;
  const hostClient = useAttachedHost(deploymentId);
  useSidebarMenu(hostClient);
  if (hostClient === null) return <DeploymentGate deploymentId={deploymentId} />;
  return <SchedulesForHost deploymentId={deploymentId} hostClient={hostClient} />;
}

const selectReader = (snapshot: HostSnapshot) =>
  snapshot.session === "authenticated" ? (snapshot.user?.id ?? null) : null;

/** Nothing one person was shown is ever shown to another: each reader starts afresh. */
function SchedulesForHost(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
}): ReactNode {
  const reader = useHostSelector(props.hostClient, selectReader);
  if (reader === null) {
    return (
      <Screen>
        <Notice
          detail="Your schedules appear once you are signed in."
          title="Connecting…"
          tone="neutral"
        />
      </Screen>
    );
  }
  return <ScheduleList key={reader} {...props} />;
}

/**
 * What a schedule screen shows of the Host's answer. A re-read — after any
 * schedule changes, or a run starts or ends — keeps the last answer in view
 * rather than blanking to a spinner, and so does losing the connection, where
 * the screen says it is offline and offers nothing that would change the Host.
 * A refusal or a failure replaces it: what it showed can no longer be vouched
 * for. Only ever Host answers for this reader, since each reader remounts.
 */
export function useShownSchedule<T>(state: ScheduleState<T>): T | null {
  const held = useRef<T | null>(null);
  if (state.status === "ready") held.current = state.data;
  else if (state.status === "error" || state.status === "unavailable") held.current = null;
  return state.status === "ready" ? state.data : held.current;
}

/** The read the Host refused or failed, as one notice with the way on from it. */
export function ScheduleProblem(props: {
  readonly onRetry: () => void;
  readonly state: ScheduleState<unknown>;
}): ReactNode {
  const { state } = props;
  if (state.status === "unavailable") {
    return (
      <Notice
        detail="This Host doesn’t offer schedules. Update Opensteer on the computer it runs on to see them here."
        title="Schedules aren’t available here"
        tone="neutral"
      />
    );
  }
  if (state.status === "offline") {
    return <Notice detail={state.error ?? ""} title="Offline" tone="neutral" />;
  }
  return (
    <Notice
      action={{ label: "Try again", onPress: props.onRetry }}
      detail={state.error ?? "Schedules could not be loaded."}
      title="Schedules didn’t load"
    />
  );
}

interface ScheduleSection {
  readonly data: readonly ScheduleItem[];
  readonly title: string;
}

/**
 * The Host's order, cut into what will run and what will not: active
 * schedules by their next run, then the ones that wait for an event, then
 * everything paused.
 */
function scheduleSections(items: readonly ScheduleItem[]): readonly ScheduleSection[] {
  return [
    { data: items.filter(({ status }) => status === "active"), title: "Next up" },
    { data: items.filter(({ status }) => status === "paused"), title: "Paused" },
  ].filter(({ data }) => data.length > 0);
}

/** The most `triggers.list` answers with; a full answer may not be all of them. */
const hostListCap = 100;

function ScheduleList(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
}): ReactNode {
  const { deploymentId, hostClient } = props;
  const navigation = useNavigation();
  const column = useReadingColumn();
  const insets = useListContentInsets(space[32]);
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const state = useSchedules(hostClient, undefined, focused && foreground);
  const items = useShownSchedule(state);
  const sections = useMemo(() => (items === null ? [] : scheduleSections(items)), [items]);
  const [refreshing, setRefreshing] = useState(false);

  // A failed re-read is the resource's state; the screen shows it from there.
  const reload = useCallback(
    () =>
      schedulesClient(hostClient)
        .list.refresh()
        .catch(() => undefined),
    [hostClient],
  );
  const pull = useCallback(() => {
    setRefreshing(true);
    void reload().finally(() => setRefreshing(false));
  }, [reload]);
  const open = useCallback(
    (triggerId: string) =>
      navigation.dispatch(StackActions.push("Schedule", { deploymentId, triggerId })),
    [deploymentId, navigation],
  );

  // Times are read as the list draws, so "next today" turns into "next
  // tomorrow" whenever the list is drawn again.
  const now = Date.now();
  const renderItem = useCallback(
    ({ index, item, section }: SectionListRenderItemInfo<ScheduleItem, ScheduleSection>) => (
      <ScheduleRow
        first={index === 0}
        item={item}
        last={index === section.data.length - 1}
        now={now}
        onOpen={open}
      />
    ),
    [now, open],
  );

  return (
    <Screen edgeToEdge>
      <SectionList<ScheduleItem, ScheduleSection>
        contentContainerStyle={[styles.content, column, insets]}
        contentInsetAdjustmentBehavior="automatic"
        keyExtractor={(item) => item.id}
        ListEmptyComponent={
          items === null ? (
            state.status === "loading" ? (
              <View accessibilityLabel="Loading schedules" style={styles.loading}>
                <ActivityIndicator color={color.muted} />
              </View>
            ) : (
              <ScheduleProblem onRetry={() => void reload()} state={state} />
            )
          ) : (
            <View style={styles.empty}>
              <Symbol name="clock" size={30} tint={color.mutedDim} />
              <AppText role="title">No schedules yet</AppText>
              <AppText role="secondary" style={styles.centred} tone="muted">
                Ask in Chat for something to happen on its own — “every weekday at 8, sum up my
                email” — and it shows up here.
              </AppText>
            </View>
          )
        }
        ListFooterComponent={
          items !== null && items.length >= hostListCap ? (
            <AppText role="caption" style={styles.footnote} tone="muted">
              Showing the first {hostListCap} schedules.
            </AppText>
          ) : undefined
        }
        ListHeaderComponent={
          items !== null && state.status === "offline" ? (
            <ScheduleProblem onRetry={() => void reload()} state={state} />
          ) : undefined
        }
        refreshControl={
          <RefreshControl onRefresh={pull} refreshing={refreshing} tintColor={color.muted} />
        }
        renderItem={renderItem}
        renderSectionHeader={({ section }) => <ScheduleGroupHead title={section.title} />}
        sections={sections}
        stickySectionHeadersEnabled={false}
      />
    </Screen>
  );
}

/** A group's name over its rows, announced as a heading. */
export function ScheduleGroupHead(props: { readonly title: string }): ReactNode {
  return (
    <View accessibilityLabel={props.title} accessibilityRole="header" style={styles.groupHead}>
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        role="caption"
        style={styles.groupTitle}
        tone="muted"
      >
        {props.title}
      </AppText>
    </View>
  );
}

/** What a schedule is, by its glyph; paused ones all wear pause. */
export function scheduleGlyph(item: Pick<ScheduleItem, "kind" | "status">): SFSymbolName {
  if (item.status === "paused") return "pause";
  return item.kind === "webhook" ? "bolt" : item.kind === "watch" ? "eye" : "clock";
}

/** The thread a schedule runs in, by the mark the sidebar gives it: Chat's orb, or the task's. */
export function AnchorMark(props: {
  readonly anchor: ScheduleAnchor;
  readonly size: 16 | 20 | 22;
}): ReactNode {
  return props.anchor.home ? (
    <ChatOrb size={props.size} />
  ) : (
    <TaskMark mark={props.anchor.mark} quiet={!props.anchor.visible} size={props.size} />
  );
}

/** When it next does something, or why it will not. */
function scheduleWhen(item: ScheduleItem, now: number): string | null {
  if (item.status === "paused") return item.pauseReason ?? item.statusWord;
  return item.nextFireAt === null ? null : `Next ${formatMoment(item.nextFireAt, now, true)}`;
}

interface ScheduleRowProps {
  readonly first: boolean;
  readonly item: ScheduleItem;
  readonly last: boolean;
  readonly now: number;
  readonly onOpen: (triggerId: string) => void;
}

const ScheduleRow = memo(function ScheduleRow(props: ScheduleRowProps): ReactNode {
  const { item } = props;
  const when = scheduleWhen(item, props.now);
  const attention = item.status === "paused" && item.pauseReason !== null;
  return (
    <Pressable
      accessibilityHint="Opens this schedule"
      accessibilityLabel={[item.name, item.timing, when, `Runs in ${item.anchor.title}`]
        .filter((part) => part !== null)
        .join(". ")}
      accessibilityRole="button"
      onPress={() => props.onOpen(item.id)}
      style={({ pressed }) => [
        styles.row,
        props.first && styles.rowFirst,
        props.last && styles.rowLast,
        !props.first && styles.rowSeparated,
        pressed && styles.pressed,
      ]}
    >
      <View style={styles.glyph}>
        <Symbol name={scheduleGlyph(item)} size={17} tint={color.muted} />
      </View>
      <View style={styles.words}>
        <AppText numberOfLines={2} role="bodyMedium">
          {item.name}
        </AppText>
        <AppText numberOfLines={2} role="caption" tone="muted">
          {item.timing}
        </AppText>
        <View style={styles.line}>
          {when === null ? null : (
            <AppText
              numberOfLines={1}
              role="caption"
              style={[styles.when, attention && styles.attention]}
              tone="muted"
            >
              {`${when} ·`}
            </AppText>
          )}
          <AnchorMark anchor={item.anchor} size={16} />
          <AppText numberOfLines={1} role="caption" style={styles.anchor} tone="muted">
            {item.anchor.title}
          </AppText>
        </View>
      </View>
      <Symbol name="chevron.right" size={13} tint={color.mutedDim} />
    </Pressable>
  );
}, sameRowProps);

function sameRowProps(left: ScheduleRowProps, right: ScheduleRowProps): boolean {
  const a = left.item;
  const b = right.item;
  return (
    left.first === right.first &&
    left.last === right.last &&
    left.onOpen === right.onOpen &&
    // The next run's words change with the day, not the minute.
    new Date(left.now).toDateString() === new Date(right.now).toDateString() &&
    a.id === b.id &&
    a.name === b.name &&
    a.status === b.status &&
    a.statusWord === b.statusWord &&
    a.pauseReason === b.pauseReason &&
    a.timing === b.timing &&
    a.nextFireAt === b.nextFireAt &&
    a.anchor.title === b.anchor.title &&
    a.anchor.visible === b.anchor.visible &&
    a.anchor.home === b.anchor.home &&
    a.anchor.mark.icon === b.anchor.mark.icon &&
    a.anchor.mark.color === b.anchor.mark.color
  );
}

const styles = StyleSheet.create({
  anchor: { flexShrink: 1 },
  attention: { color: color.amber },
  centred: { textAlign: "center" },
  content: { paddingTop: space[8] },
  empty: {
    alignItems: "center",
    gap: space[8],
    paddingHorizontal: space[16],
    paddingVertical: space[48],
  },
  footnote: { paddingHorizontal: space[4], paddingTop: space[16] },
  glyph: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.sm,
    height: 32,
    justifyContent: "center",
    width: 32,
  },
  groupHead: { paddingBottom: space[6], paddingHorizontal: space[4], paddingTop: space[16] },
  groupTitle: { fontWeight: "600" },
  line: { alignItems: "center", flexDirection: "row", gap: space[6], minWidth: 0 },
  loading: { alignItems: "center", paddingVertical: space[48] },
  pressed: { backgroundColor: color.surfacePressed },
  // One plate per group, as the platform's grouped lists draw it.
  row: {
    alignItems: "center",
    backgroundColor: color.surface,
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget + space[20],
    paddingHorizontal: space[12],
    paddingVertical: space[10],
  },
  rowFirst: { borderTopLeftRadius: radius.md, borderTopRightRadius: radius.md },
  rowLast: { borderBottomLeftRadius: radius.md, borderBottomRightRadius: radius.md },
  rowSeparated: { borderColor: color.line, borderTopWidth: StyleSheet.hairlineWidth },
  when: { flexShrink: 1, maxWidth: "60%" },
  words: { flex: 1, gap: space[2], minWidth: 0 },
});
