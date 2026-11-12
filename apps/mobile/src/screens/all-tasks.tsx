import {
  canRespondToRequests,
  sameTaskListSource,
  taskTime,
  type HostClient,
  type HostSnapshot,
  type TaskRow,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import type { TaskFolder } from "@opensteer/core";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { RootParamList } from "../navigation.js";
import { useSidebarMenu } from "../navigation-header.js";
import { allTasksFilters, type AllTasksFilter } from "@opensteer/client/host";
import { useTeamsSnapshot } from "../team/team-context.js";
import { QuestionCard } from "../thread/waiting-questions.js";
import { useMobileClient } from "../ui/mobile-client-context.js";
import { Symbol } from "../ui/symbol.js";
import { TaskMark } from "../ui/task-mark.js";
import {
  allTasksCounts,
  allTasksFilterRows,
  allTasksView,
  needsYouCards,
  type AllTasksView,
  type NeedsYouCard,
} from "./all-tasks-model.js";
import { folderLabel } from "../home/folder-label.js";
import { color, controlFontScaleLimit, material, radius, space, type } from "../theme.js";
import { setTaskDone, TaskRowView } from "../threads/task-row.js";
import { AppText } from "../ui/primitives.js";
import { Screen, useListContentInsets } from "../ui/screen.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";

export type AllTasksScreenProps = StaticScreenProps<{
  readonly deploymentId: string;
  readonly filter?: AllTasksFilter | undefined;
}>;

/**
 * Every task, on one filter: All, Needs you, Running, Unread, Read or Done.
 * The drawer holds only the live handful; this is the rest, newest asked
 * first, each row saying where it came from (`#support · thread`) or which
 * folder it works in, and what it is doing.
 */
export function AllTasksScreen(props: AllTasksScreenProps): ReactNode {
  const { deploymentId } = props.route.params;
  const hostClient = useAttachedHost(deploymentId);
  useSidebarMenu(hostClient);
  if (hostClient === null) return <DeploymentGate deploymentId={deploymentId} />;
  return (
    <Screen edgeToEdge>
      <AllTasksList
        deploymentId={deploymentId}
        filter={props.route.params.filter ?? "all"}
        hostClient={hostClient}
      />
    </Screen>
  );
}

function useTaskList(hostClient: HostClient): {
  readonly view: AllTasksView;
  readonly home: TaskFolder | null;
} {
  const cached = useRef<{
    snapshot: HostSnapshot;
    value: { view: AllTasksView; home: TaskFolder | null };
  } | null>(null);
  const read = useCallback(() => {
    const snapshot = hostClient.getSnapshot();
    const held = cached.current;
    if (held !== null && sameTaskListSource(held.snapshot, snapshot)) return held.value;
    const value = {
      view: allTasksView(snapshot),
      home: snapshot.personalSettings?.agentHome ?? null,
    };
    cached.current = { snapshot, value };
    return value;
  }, [hostClient]);
  return useSyncExternalStore(hostClient.subscribe, read, read);
}

function AllTasksList(props: {
  readonly deploymentId: string;
  readonly filter: AllTasksFilter;
  readonly hostClient: HostClient;
}): ReactNode {
  const { hostClient } = props;
  const navigation = useNavigation<NativeStackNavigationProp<RootParamList>>();
  const [filter, setFilter] = useState<AllTasksFilter>(props.filter);
  useEffect(() => setFilter(props.filter), [props.filter]);
  const { view, home } = useTaskList(hostClient);
  const needsYou = useHostSelector(hostClient, selectNeedsYou);
  // Done is its own read; asked for once a reader looks at it.
  useEffect(() => {
    if (filter === "done") void hostClient.loadDoneTasks().catch(() => undefined);
  }, [filter, hostClient]);
  const channels = useChannelNames();
  const rows = useMemo(() => allTasksFilterRows(view, filter), [filter, view]);
  const counts = useMemo(
    () => allTasksCounts(view, needsYou?.count ?? allTasksFilterRows(view, "needs-you").length),
    [needsYou?.count, view],
  );
  const insets = useListContentInsets(space[24]);
  const open = useCallback(
    (threadId: string) =>
      navigation.navigate("Thread", { deploymentId: props.deploymentId, threadId }),
    [navigation, props.deploymentId],
  );
  const setDone = useCallback(
    (row: TaskRow, done: boolean) => setTaskDone(hostClient, row.threadId, done),
    [hostClient],
  );
  const now = Date.now();
  const chips = <FilterChips counts={counts} filter={filter} onFilter={setFilter} />;
  if (filter === "needs-you")
    return (
      <NeedsYouList
        channels={channels}
        deploymentId={props.deploymentId}
        header={chips}
        home={home}
        hostClient={hostClient}
        onOpen={open}
      />
    );
  return (
    <FlatList
      contentContainerStyle={[styles.list, insets]}
      data={rows}
      initialNumToRender={20}
      keyExtractor={(row) => row.threadId}
      ListEmptyComponent={
        <AppText role="secondary" style={styles.empty} tone="muted">
          No tasks here
        </AppText>
      }
      ListHeaderComponent={chips}
      onEndReached={() => {
        if (filter === "done") {
          if (view.doneHasMore) void hostClient.loadEarlierDoneTasks().catch(() => undefined);
        } else if (view.list.hasMore) void hostClient.loadEarlierTasks().catch(() => undefined);
      }}
      renderItem={({ item }) => (
        <TaskRowView
          ask={item.tone === "needs-you" ? item.line : null}
          detail={taskDetail(item, home, channels)}
          onOpen={open}
          onSetDone={setDone}
          row={item}
          selected={false}
          shelf={filter === "done" ? "done" : "open"}
          time={taskTime(item, now)}
        />
      )}
      windowSize={9}
    />
  );
}

const selectNeedsYou = (snapshot: HostSnapshot) => snapshot.needsYou;
const selectNeedsYouCards = (snapshot: HostSnapshot) => ({
  cards: needsYouCards(snapshot),
  canRespond: canRespondToRequests(snapshot),
  hasMore: snapshot.needsYou?.window.hasMore ?? false,
  userId: snapshot.user?.id ?? null,
});
type NeedsYouState = ReturnType<typeof selectNeedsYouCards>;
const sameNeedsYouState = (left: NeedsYouState, right: NeedsYouState): boolean =>
  left.canRespond === right.canRespond &&
  left.hasMore === right.hasMore &&
  left.userId === right.userId &&
  left.cards.length === right.cards.length &&
  left.cards.every(
    (card, index) =>
      card.surface.request === right.cards[index]!.surface.request &&
      card.taskTitle === right.cards[index]!.taskTitle &&
      card.mark === right.cards[index]!.mark,
  );

/**
 * Needs you: one card per Request, with its own answer controls, newest asked
 * first. Two questions from one task are two cards, each naming the task.
 */
function NeedsYouList(props: {
  readonly channels: ReadonlyMap<string, string>;
  readonly deploymentId: string;
  readonly header: ReactElement;
  readonly home: TaskFolder | null;
  readonly hostClient: HostClient;
  readonly onOpen: (threadId: string) => void;
}): ReactNode {
  const { hostClient } = props;
  const drafts = useMobileClient().drafts;
  const state = useHostSelector(hostClient, selectNeedsYouCards, sameNeedsYouState);
  const insets = useListContentInsets(space[24]);
  return (
    <FlatList
      contentContainerStyle={[styles.list, styles.cards, insets]}
      data={state.cards}
      initialNumToRender={6}
      keyExtractor={(card) => card.surface.request.id}
      ListEmptyComponent={
        <AppText role="secondary" style={styles.empty} tone="muted">
          Nothing needs you
        </AppText>
      }
      ListHeaderComponent={props.header}
      onEndReached={() => {
        if (state.hasMore) void hostClient.loadEarlierNeedsYou().catch(() => undefined);
      }}
      renderItem={({ item }) =>
        state.userId === null ? null : (
          <NeedsYouCardView
            canRespond={state.canRespond}
            card={item}
            channels={props.channels}
            deploymentId={props.deploymentId}
            drafts={drafts}
            home={props.home}
            hostClient={hostClient}
            onOpen={props.onOpen}
            userId={state.userId}
          />
        )
      }
      windowSize={7}
    />
  );
}

const NeedsYouCardView = memo(function NeedsYouCardView(props: {
  readonly canRespond: boolean;
  readonly card: NeedsYouCard;
  readonly channels: ReadonlyMap<string, string>;
  readonly deploymentId: string;
  readonly drafts: ReturnType<typeof useMobileClient>["drafts"];
  readonly home: TaskFolder | null;
  readonly hostClient: HostClient;
  readonly onOpen: (threadId: string) => void;
  readonly userId: string;
}): ReactNode {
  const { card } = props;
  const where =
    card.folder === null
      ? null
      : taskDetail(
          { folder: card.folder, teamOrigin: card.teamOrigin, line: "" },
          props.home,
          props.channels,
        );
  return (
    <View style={styles.ask}>
      <Pressable
        accessibilityHint="Opens the task that is asking"
        accessibilityRole="link"
        hitSlop={space[8]}
        onPress={() => props.onOpen(card.taskId)}
        style={styles.askSource}
      >
        <TaskMark mark={card.mark} size={16} />
        <AppText numberOfLines={1} role="caption" style={styles.askTitle}>
          {where === null ? card.taskTitle : `${card.taskTitle} · ${where}`}
        </AppText>
        <Symbol name="chevron.right" size={11} tint={color.amber} />
      </Pressable>
      <QuestionCard
        canRespond={props.canRespond}
        deploymentId={props.deploymentId}
        drafts={props.drafts}
        hostClient={props.hostClient}
        key={card.surface.request.id}
        showQueue={false}
        surface={card.surface}
        userId={props.userId}
      />
    </View>
  );
});

/** Channel names this phone knows, for a team task's source. */
function useChannelNames(): ReadonlyMap<string, string> {
  const { teams } = useTeamsSnapshot();
  return useMemo(() => {
    const names = new Map<string, string>();
    for (const team of teams)
      for (const row of team.session?.getSnapshot().sidebar?.channels ?? [])
        names.set(row.channel.id, row.channel.name);
    return names;
  }, [teams]);
}

/** Where a task came from (`#support · thread`) or the folder it works in, then what it is doing. */
export function taskDetail(
  row: Pick<TaskRow, "folder" | "teamOrigin" | "line">,
  home: TaskFolder | null,
  channels: ReadonlyMap<string, string>,
): string {
  const where =
    row.teamOrigin !== null
      ? `#${channels.get(row.teamOrigin.channelId) ?? "channel"} · thread`
      : folderLabel(row.folder, home);
  return row.line === "" ? where : `${where} · ${row.line}`;
}

const filterLabels: Readonly<Record<AllTasksFilter, string>> = {
  all: "All",
  "needs-you": "Needs you",
  running: "Running",
  unread: "Unread",
  read: "Read",
  done: "Done",
};

const FilterChips = memo(function FilterChips(props: {
  readonly counts: Readonly<Record<AllTasksFilter, number>>;
  readonly filter: AllTasksFilter;
  readonly onFilter: (filter: AllTasksFilter) => void;
}): ReactNode {
  return (
    <ScrollView
      contentContainerStyle={styles.chips}
      horizontal
      showsHorizontalScrollIndicator={false}
    >
      {allTasksFilters.map((id) => {
        const label = filterLabels[id];
        const selected = id === props.filter;
        const count = props.counts[id];
        return (
          <Pressable
            accessibilityLabel={`${label}, ${count}`}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            key={id}
            onPress={() => props.onFilter(id)}
            style={({ pressed }) => [
              styles.chip,
              selected && styles.chipSelected,
              id === "needs-you" && count > 0 && styles.chipAmber,
              pressed && styles.pressed,
            ]}
          >
            <Text
              maxFontSizeMultiplier={controlFontScaleLimit}
              numberOfLines={1}
              style={[type.secondary, selected ? styles.chipLabelSelected : styles.chipLabel]}
            >
              {label}
            </Text>
            {id === "done" || count === 0 ? null : (
              <Text
                maxFontSizeMultiplier={controlFontScaleLimit}
                style={[type.caption, styles.chipCount]}
              >
                {String(count)}
              </Text>
            )}
          </Pressable>
        );
      })}
    </ScrollView>
  );
});

const styles = StyleSheet.create({
  ask: { gap: space[6] },
  askSource: {
    alignItems: "center",
    alignSelf: "flex-start",
    flexDirection: "row",
    gap: space[4],
    maxWidth: "100%",
    paddingHorizontal: space[4],
  },
  askTitle: { color: color.amber, flexShrink: 1 },
  cards: { gap: space[16] },
  chip: {
    ...material.plate,
    alignItems: "center",
    borderRadius: radius.full,
    flexDirection: "row",
    gap: space[6],
    minHeight: 32,
    paddingHorizontal: space[12],
  },
  chipAmber: { borderColor: color.amber },
  chipCount: { color: color.muted, fontVariant: ["tabular-nums"] },
  chipLabel: { color: color.textSoft },
  chipLabelSelected: { color: color.text, fontWeight: "600" },
  chipSelected: { ...material.selected },
  chips: { gap: space[8], paddingBottom: space[12], paddingHorizontal: space[4] },
  empty: { padding: space[16], textAlign: "center" },
  list: { paddingHorizontal: space[8] },
  pressed: { ...material.quiet },
});
