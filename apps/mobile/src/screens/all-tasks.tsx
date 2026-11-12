import {
  sameTaskListSource,
  taskList,
  taskTime,
  type HostClient,
  type HostSnapshot,
  type TaskList,
  type TaskRow,
} from "@opensteer/client/host";
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
  type ReactNode,
} from "react";
import { FlatList, Pressable, ScrollView, StyleSheet, Text } from "react-native";
import type { RootParamList } from "../navigation.js";
import { useSidebarMenu } from "../navigation-header.js";
import { allTasks, allTasksFilters, type AllTasksFilter } from "../sidebar/live-tasks.js";
import { useTeamsSnapshot } from "../team/team-context.js";
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
  readonly list: TaskList;
  readonly home: TaskFolder | null;
} {
  const cached = useRef<{
    snapshot: HostSnapshot;
    value: { list: TaskList; home: TaskFolder | null };
  } | null>(null);
  const read = useCallback(() => {
    const snapshot = hostClient.getSnapshot();
    const held = cached.current;
    if (held !== null && sameTaskListSource(held.snapshot, snapshot)) return held.value;
    const value = {
      list: taskList(snapshot),
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
  const { list, home } = useTaskList(hostClient);
  // Done is its own read; asked for once a reader looks at it.
  useEffect(() => {
    if (filter === "done") void hostClient.loadDoneTasks().catch(() => undefined);
  }, [filter, hostClient]);
  const channels = useChannelNames();
  const rows = useMemo(() => allTasks(list, filter), [filter, list]);
  const counts = useMemo(
    () =>
      Object.fromEntries(
        allTasksFilters.map(({ id }) => [id, allTasks(list, id).length]),
      ) as Record<AllTasksFilter, number>,
    [list],
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
  return (
    <FlatList
      contentContainerStyle={[styles.list, insets]}
      data={rows}
      initialNumToRender={20}
      keyExtractor={(row) => row.threadId}
      ListEmptyComponent={
        <AppText role="secondary" style={styles.empty} tone="muted">
          {filter === "needs-you" ? "Nothing needs you" : "No tasks here"}
        </AppText>
      }
      ListHeaderComponent={<FilterChips counts={counts} filter={filter} onFilter={setFilter} />}
      onEndReached={() => {
        if (filter === "done") void hostClient.loadEarlierDoneTasks().catch(() => undefined);
        else if (list.hasMore) void hostClient.loadEarlierTasks().catch(() => undefined);
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
      {allTasksFilters.map(({ id, label }) => {
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
