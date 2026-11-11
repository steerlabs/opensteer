import { placeList } from "@opensteer/client/host";
import { CHAT_THREAD_TITLE } from "@opensteer/core";
import {
  browserTabPicture,
  browserThreadAgentTab,
  browserThreadTabs,
  placeAgents,
  placeAgentsWords,
  samePlaceAgents,
  taskMark,
  threadInDirectory,
  transcriptPlaces,
  type BrowserThreadTabs,
  type HostClient,
  type HostSnapshot,
  type PlaceAgent,
  type PlaceEntry,
} from "@opensteer/client/host";
import {
  useBrowserSessionGroupId,
  useBrowserTab,
  useBrowserTabIcon,
  useBrowserTabs,
  useHostSelector,
  usePlace,
  useSyncingPlaceholder,
} from "@opensteer/client/react";
import {
  CommonActions,
  StackActions,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FlatList, Image, Platform, Pressable, StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { AgentMarks } from "../browser/agent-marks.js";
import { useHereDeviceId } from "../computers/here-device.js";
import { pageSite } from "../browser/surface-route.js";
import { color, radius, space, touchTarget } from "../theme.js";
import { ChatOrb } from "../ui/chat-orb.js";
import { enter, exit } from "../ui/motion.js";
import { useContentInsets } from "../ui/pane.js";
import { useMobileState } from "../ui/mobile-client-context.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { TaskMark } from "../ui/task-mark.js";
import { TabPicture } from "./tab-picture.js";

export type BrowserTabsScreenProps = StaticScreenProps<{
  readonly deploymentId: string;
  readonly sessionId: string;
  readonly tabId: string;
  /** The task the browser is shown beside: the sheet lists its tabs, the rest folded away. */
  readonly threadId?: string;
}>;

/** One of the browser's tabs as the sheet lists it; its row reads the rest by key. */
interface TabRowItem {
  readonly id: string;
  /** Who is in the tab is shown, when the sheet lists everyone rather than one task's agent. */
  readonly occupants: boolean;
}

type ListItem =
  | {
      readonly kind: "tab";
      readonly first: boolean;
      readonly key: string;
      readonly last: boolean;
      readonly other: boolean;
      readonly row: TabRowItem;
    }
  | { readonly kind: "more"; readonly key: string; readonly count: number }
  | { readonly kind: "label"; readonly key: string };

/** The task the sheet is for, and the tab its agent is in, if in this browser. */
interface TaskView {
  readonly agent: PlaceAgent;
  readonly agentTabId: string | null;
}

/**
 * One browser's tabs, over the page they were opened from, as Safari's tab
 * button shows them: in the browser's own order, the one in front checked.
 * Opened for a task, it lists that task's tabs and folds the browser's others
 * under one row. Choosing one puts it in front in the page's place; All tabs
 * goes to every computer's.
 */
export function BrowserTabsScreen(props: BrowserTabsScreenProps): ReactNode {
  const { deploymentId, sessionId, tabId, threadId } = props.route.params;
  const { selection } = useMobileState();
  if (selection.deploymentId !== deploymentId || selection.hostClient === null) return null;
  return (
    <BrowserTabs
      deploymentId={deploymentId}
      hostClient={selection.hostClient}
      sessionId={sessionId}
      tabId={tabId}
      threadId={threadId ?? null}
    />
  );
}

const noPlaces: readonly PlaceEntry[] = [];

function sameTaskView(left: TaskView | null, right: TaskView | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.agentTabId === right.agentTabId &&
    samePlaceAgents(
      { agents: [left.agent], unnamedActing: false },
      { agents: [right.agent], unnamedActing: false },
    )
  );
}

function catalogRows(
  tabs: readonly { readonly id: string }[],
  occupants: boolean,
): readonly TabRowItem[] {
  return tabs.map(({ id }) => ({ id, occupants }));
}

function tabCount(count: number): string {
  return count === 0 ? "No tabs" : count === 1 ? "1 tab" : `${count} tabs`;
}

function BrowserTabs(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
  readonly sessionId: string;
  readonly tabId: string;
  readonly threadId: string | null;
}): ReactNode {
  const { deploymentId, hostClient, sessionId, tabId, threadId } = props;
  const navigation = useNavigation();
  const insets = useContentInsets();
  const selectSession = useCallback(
    (snapshot: HostSnapshot) => snapshot.browserSessions.find(({ id }) => id === sessionId) ?? null,
    [sessionId],
  );
  const session = useHostSelector(hostClient, selectSession);
  // The browser's tabs by key; each row reads its own, so a title repaints only its row.
  const groupId = useBrowserSessionGroupId(hostClient, sessionId);
  const list = useBrowserTabs(hostClient, groupId ?? "");
  // The pages this task's transcript says it worked in, when its transcript is held.
  const selectTaskPlaces = useCallback(
    (snapshot: HostSnapshot) => {
      const entries = threadId === null ? undefined : snapshot.transcripts[threadId];
      return entries === undefined ? noPlaces : transcriptPlaces(entries);
    },
    [threadId],
  );
  const taskPlaces = useHostSelector(hostClient, selectTaskPlaces);
  const selectTask = useCallback(
    (snapshot: HostSnapshot): TaskView | null => {
      if (threadId === null) return null;
      const home = snapshot.homeThreadId === threadId;
      const thread = home ? null : threadInDirectory(threadId, snapshot);
      const at = browserThreadAgentTab(snapshot.browserSessions, threadId);
      const here = at?.sessionId === sessionId ? at : null;
      const occupant = here?.tab.occupants.find((value) => value.threadId === threadId);
      return {
        agent: {
          acting: occupant?.acting ?? false,
          home,
          lastActiveAt: occupant?.lastActiveAt ?? "",
          mark: home ? null : taskMark(thread ?? { icon: null, color: null }),
          threadId,
          title: home ? CHAT_THREAD_TITLE : thread?.title.trim() || "Task",
        },
        agentTabId: here?.tabId ?? null,
      };
    },
    [sessionId, threadId],
  );
  const task = useHostSelector(hostClient, selectTask, sameTaskView);

  // Membership seen once is kept while the agent is briefly out of a tab.
  const remembered = useRef<BrowserThreadTabs | undefined>(undefined);
  const groups = useMemo(
    () =>
      threadId === null || session === null || !list.whole
        ? null
        : browserThreadTabs(session, threadId, taskPlaces, remembered.current),
    [list.whole, session, taskPlaces, threadId],
  );
  useEffect(() => {
    if (groups !== null) remembered.current = groups;
  }, [groups]);

  const rows = useMemo(
    (): readonly TabRowItem[] =>
      session === null || groups !== null ? [] : list.ids.map((id) => ({ id, occupants: true })),
    [groups, list.ids, session],
  );
  // Still syncing with nothing to list: no count, and past a moment the list's loading line.
  const syncing = list.syncing && rows.length === 0 && groups === null;
  const finding = useSyncingPlaceholder(list.syncing && groups === null, rows.length);
  // A task's rows name only its own agent, so they look nobody else up.
  const taskRows = useMemo(
    () => (groups === null || session === null ? [] : catalogRows(groups.taskTabs, false)),
    [groups, session],
  );
  const otherRows = useMemo(
    () => (groups === null || session === null ? [] : catalogRows(groups.otherTabs, false)),
    [groups, session],
  );
  // Opens unfolded when the tab in front, or every tab, is not the task's.
  const [expanded, setExpanded] = useState(
    () => taskRows.length === 0 || !taskRows.some(({ id }) => id === tabId),
  );
  const [toggled, setToggled] = useState(false);
  const toggle = useCallback(() => {
    setToggled(true);
    setExpanded((value) => !value);
  }, []);

  const items = useMemo((): readonly ListItem[] => {
    const group = (list: readonly TabRowItem[], other: boolean): ListItem[] =>
      list.map((row, index) => ({
        first: index === 0,
        key: row.id,
        kind: "tab",
        last: index === list.length - 1,
        other,
        row,
      }));
    if (groups === null) return group(rows, false);
    if (otherRows.length === 0) return group(taskRows, false);
    return [
      ...group(taskRows, false),
      { count: otherRows.length, key: "more", kind: "more" },
      ...(expanded ? [{ key: "label", kind: "label" } as const, ...group(otherRows, true)] : []),
    ];
  }, [expanded, groups, otherRows, rows, taskRows]);

  // The device the browser runs on, when that is not this phone, and the profile it is signed in as.
  const hereId = useHereDeviceId(deploymentId);
  const selectWhere = useCallback(
    (snapshot: HostSnapshot) => {
      const owner = placeList(snapshot).find((place) => place.browser?.sessionId === sessionId);
      const device = owner?.device && owner.device.machineId !== hereId ? owner.device.name : null;
      return [device, owner?.identity?.name ?? null]
        .filter((part): part is string => part !== null && part !== "")
        .join(" · ");
    },
    [hereId, sessionId],
  );
  const where = useHostSelector(hostClient, selectWhere);

  // The page under this sheet takes the chosen tab; it is the screen the sheet
  // was presented over, so it is found by where it is rather than by name.
  const choose = useCallback(
    (id: string) => {
      const state = navigation.getState();
      const page = state?.routes[state.index - 1];
      if (id !== tabId && page !== undefined)
        navigation.dispatch({
          ...CommonActions.setParams({ editAddress: false, popup: false, tabId: id }),
          source: page.key,
        });
      navigation.goBack();
    },
    [navigation, tabId],
  );
  const allTabs = useCallback(() => {
    navigation.goBack();
    navigation.dispatch(StackActions.push("Tabs", { deploymentId }));
  }, [deploymentId, navigation]);

  const agent = task?.agent ?? null;
  const subtitle =
    groups === null ? where : [tabCount(taskRows.length), where].filter(Boolean).join(" · ");

  return (
    <View style={styles.sheet}>
      <View style={styles.head}>
        <View style={styles.headWords}>
          {groups === null || agent === null ? (
            <AppText role="title">{syncing ? "Tabs" : tabCount(rows.length)}</AppText>
          ) : (
            <View style={styles.taskName}>
              {agent.mark === null ? (
                <ChatOrb size={20} />
              ) : (
                <TaskMark mark={agent.mark} size={20} />
              )}
              <AppText numberOfLines={1} role="title" style={styles.shrink}>
                {agent.title}
              </AppText>
            </View>
          )}
          {subtitle === "" ? null : (
            <AppText numberOfLines={1} role="caption" tone="muted">
              {subtitle}
            </AppText>
          )}
        </View>
        <Pressable
          accessibilityHint="Shows the tabs on every computer"
          accessibilityLabel="All tabs"
          accessibilityRole="button"
          hitSlop={space[6]}
          onPress={allTabs}
          style={({ pressed }) => [styles.all, pressed && styles.dim]}
        >
          <AppText role="secondaryMedium" tone="ember">
            All tabs
          </AppText>
        </Pressable>
      </View>
      <FlatList
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + space[16] }]}
        data={items}
        keyExtractor={(item) => item.key}
        ListEmptyComponent={
          finding ? (
            <AppText role="secondary" style={styles.finding} tone="muted">
              Finding tabs…
            </AppText>
          ) : undefined
        }
        renderItem={({ item }) => {
          if (item.kind === "more")
            return (
              <Pressable
                accessibilityHint={expanded ? "Hides the other tabs" : "Shows the other tabs"}
                accessibilityLabel={`All tabs in this browser, ${item.count}`}
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                onPress={toggle}
                style={({ pressed }) => [styles.more, pressed && styles.dim]}
              >
                <AppText numberOfLines={1} role="secondary" style={styles.shrink} tone="muted">
                  {`All tabs in this browser · ${item.count}`}
                </AppText>
                <Symbol
                  name={expanded ? "chevron.up" : "chevron.down"}
                  size={12}
                  tint={color.muted}
                  weight="semibold"
                />
              </Pressable>
            );
          const content =
            item.kind === "label" ? (
              <AppText role="caption" style={styles.label} tone="muted">
                Other tabs
              </AppText>
            ) : (
              <TabRow
                agentHere={
                  agent !== null && task?.agentTabId === item.row.id && !item.other ? agent : null
                }
                current={item.row.id === tabId}
                first={item.first}
                groupId={groupId}
                hostClient={hostClient}
                last={item.last}
                onChoose={choose}
                row={item.row}
                sessionId={sessionId}
              />
            );
          return item.kind === "label" || item.other ? (
            <Animated.View {...(toggled ? { entering: enter } : {})} exiting={exit}>
              {content}
            </Animated.View>
          ) : (
            content
          );
        }}
      />
    </View>
  );
}

const noAgents = { agents: [], unnamedActing: false } as const;

const TabRow = memo(function TabRow(props: {
  /** This task's agent, when it is in this tab. */
  readonly agentHere: PlaceAgent | null;
  readonly current: boolean;
  readonly first: boolean;
  readonly groupId: string | undefined;
  readonly hostClient: HostClient;
  readonly last: boolean;
  readonly onChoose: (id: string) => void;
  readonly row: TabRowItem;
  readonly sessionId: string;
}): ReactNode {
  const { agentHere, hostClient, sessionId } = props;
  const tab = useBrowserTab(hostClient, props.groupId, props.row.id);
  const place = usePlace(
    hostClient,
    props.row.occupants ? `browser:${sessionId}:${props.row.id}` : null,
  );
  const favicon = useBrowserTabIcon(hostClient, sessionId, tab?.iconRef ?? null);
  const site = tab ? pageSite(tab.site) : null;
  const row = { id: props.row.id, favicon, site, title: tab?.title || site || "New tab" };
  // The last picture held of it, a sleeping tab's included: reading it never wakes the tab.
  const picture = browserTabPicture(hostClient, sessionId, row.id);
  const selectAgents = useCallback(
    (snapshot: HostSnapshot) => (place == null ? noAgents : placeAgents(place, snapshot)),
    [place],
  );
  const agents = useHostSelector(hostClient, selectAgents, samePlaceAgents);
  const label = [
    row.title,
    row.site,
    props.current ? "Shown" : null,
    agentHere === null ? null : "Agent is here",
    placeAgentsWords(agents)?.label ?? null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={() => props.onChoose(row.id)}
      style={({ pressed }) => [
        styles.row,
        props.first && styles.rowFirst,
        props.last && styles.rowLast,
        !props.first && styles.rowSeparated,
        pressed && styles.pressed,
      ]}
    >
      {picture ? (
        <TabPicture picture={picture} size={32} />
      ) : row.favicon === null ? (
        <View style={styles.icon}>
          <Symbol name="globe" size={16} tint={color.muted} />
        </View>
      ) : (
        <Image accessibilityIgnoresInvertColors source={{ uri: row.favicon }} style={styles.icon} />
      )}
      <View style={styles.words}>
        <AppText numberOfLines={1} role="bodyMedium">
          {row.title}
        </AppText>
        {row.site === null ? null : (
          <AppText numberOfLines={1} role="caption" tone="muted">
            {row.site}
          </AppText>
        )}
      </View>
      <AgentMarks agents={agents.agents} />
      {agentHere === null ? null : (
        <View style={styles.agent}>
          <AgentMarks agents={[agentHere]} size={16} />
          <AppText role="caption" tone="soft">
            Agent
          </AppText>
        </View>
      )}
      {props.current ? (
        <Symbol name="checkmark" size={15} tint={color.ember} weight="semibold" />
      ) : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  agent: { alignItems: "center", flexDirection: "row", gap: space[6] },
  all: { justifyContent: "center", minHeight: touchTarget },
  dim: { opacity: 0.6 },
  finding: { paddingHorizontal: space[14], paddingTop: space[12] },
  head: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    paddingBottom: space[8],
    paddingHorizontal: space[20],
    paddingTop: space[20],
  },
  headWords: { flex: 1, minWidth: 0 },
  icon: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.sm,
    height: 32,
    justifyContent: "center",
    width: 32,
  },
  label: { paddingBottom: space[6], paddingHorizontal: space[14], paddingTop: space[8] },
  list: { paddingHorizontal: space[16], paddingTop: space[8] },
  more: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[8],
    marginTop: space[8],
    minHeight: Platform.OS === "android" ? 48 : touchTarget,
    paddingHorizontal: space[14],
  },
  pressed: { backgroundColor: color.surfacePressed },
  row: {
    alignItems: "center",
    backgroundColor: color.surface,
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget + space[16],
    paddingHorizontal: space[14],
    paddingVertical: space[8],
  },
  rowFirst: { borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg },
  rowLast: { borderBottomLeftRadius: radius.lg, borderBottomRightRadius: radius.lg },
  rowSeparated: { borderColor: color.line, borderTopWidth: StyleSheet.hairlineWidth },
  sheet: { backgroundColor: color.surfaceElevated, flex: 1 },
  shrink: { flexShrink: 1 },
  taskName: { alignItems: "center", flexDirection: "row", gap: space[8], minWidth: 0 },
  words: { flex: 1, gap: space[2], minWidth: 0 },
});
