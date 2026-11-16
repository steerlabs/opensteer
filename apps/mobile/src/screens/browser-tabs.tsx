import type { HostClient } from "@opensteer/client/host";
import type { TabId } from "@opensteer/core";
import {
  CommonActions,
  StackActions,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { useCallback, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { TabList } from "../tabs/tab-list.js";
import { useTabStrip, useTabsSyncing } from "@opensteer/client/react";
import { space, touchTarget } from "../theme.js";
import { useMobileState } from "../ui/mobile-client-context.js";
import { useContentInsets } from "../ui/pane.js";
import { AppText } from "../ui/primitives.js";

export type BrowserTabsScreenProps = StaticScreenProps<{
  readonly deploymentId: string;
  readonly tabId: TabId;
  /** The task the tab is shown beside: the sheet can narrow to the tabs it uses. */
  readonly threadId?: string;
}>;

/**
 * The one tab list over the tab it was opened from, that tab marked, as
 * Safari's tab button shows tabs. Choosing any tab — a page, a window, a
 * phone or an app — puts it in front in that tab's place; All tabs goes to
 * the Tabs screen.
 */
export function BrowserTabsScreen(props: BrowserTabsScreenProps): ReactNode {
  const { deploymentId, tabId, threadId } = props.route.params;
  const { selection } = useMobileState();
  if (selection.deploymentId !== deploymentId || selection.hostClient === null) return null;
  return (
    <BrowserTabs
      deploymentId={deploymentId}
      hostClient={selection.hostClient}
      tabId={tabId}
      threadId={threadId ?? null}
    />
  );
}

function tabCount(count: number): string {
  return count === 0 ? "No tabs" : count === 1 ? "1 tab" : `${count} tabs`;
}

function BrowserTabs(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
  readonly tabId: TabId;
  readonly threadId: string | null;
}): ReactNode {
  const { deploymentId, hostClient, tabId, threadId } = props;
  const navigation = useNavigation();
  const insets = useContentInsets();
  const syncing = useTabsSyncing(hostClient);
  const [taskOnly, setTaskOnly] = useState(threadId !== null);
  const matches = useTaskTabs(hostClient, taskOnly ? threadId : null, tabId);
  const count = useTabStrip(hostClient).ordered.length;

  // The tab under this sheet takes the chosen one; it is the screen the sheet
  // was presented over, so it is found by where it is rather than by name.
  const choose = useCallback(
    (id: TabId) => {
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

  return (
    <View style={styles.sheet}>
      <View style={styles.head}>
        <View style={styles.headWords}>
          <AppText role="title">{syncing ? "Tabs" : tabCount(count)}</AppText>
          {threadId === null ? null : (
            <Pressable
              accessibilityHint={
                taskOnly ? "Shows every tab" : "Shows only the tabs this task uses"
              }
              accessibilityLabel={taskOnly ? "This task's tabs" : "Every tab"}
              accessibilityRole="button"
              onPress={() => setTaskOnly((value) => !value)}
              style={styles.scope}
            >
              <AppText role="caption" tone="ember">
                {taskOnly ? "This task's tabs · Show all" : "Every tab · Only this task's"}
              </AppText>
            </Pressable>
          )}
        </View>
        <Pressable
          accessibilityHint="Shows the Tabs screen"
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
      <TabList
        contentStyle={[styles.list, { paddingBottom: insets.bottom + space[16] }]}
        empty={
          syncing ? (
            <AppText role="secondary" style={styles.finding} tone="muted">
              Finding tabs…
            </AppText>
          ) : null
        }
        hostClient={hostClient}
        matches={matches}
        onOpen={choose}
        selectedTabId={tabId}
      />
    </View>
  );
}

const styles = StyleSheet.create({
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
  list: { paddingHorizontal: space[16], paddingTop: space[8] },
  scope: { justifyContent: "center", minHeight: touchTarget },
  sheet: { flex: 1 },
});

/**
 * The tabs a task uses, with the one this sheet covers; null while not
 * narrowing. A string key, so only a change in who matches redraws the list.
 */
function useTaskTabs(
  hostClient: HostClient,
  threadId: string | null,
  tabId: TabId,
): ReadonlySet<string> | null {
  const tabs = hostClient.getSnapshot().tabs;
  const read = () =>
    threadId === null
      ? null
      : [...tabs.rows.values()]
          .filter(
            (tab) => tab.tabId === tabId || tab.usedBy.some(({ taskId }) => taskId === threadId),
          )
          .map((tab) => tab.tabId)
          .join("\n");
  const subscribe = useCallback((listener: () => void) => tabs.subscribe(listener), [tabs]);
  const key = useSyncExternalStore(subscribe, read, read);
  return useMemo(() => (key === null ? null : new Set(key.split("\n"))), [key]);
}
