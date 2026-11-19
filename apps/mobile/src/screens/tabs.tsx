import type {
  HostClient,
  HostSnapshot,
  TabFilter as SharedTabFilter,
} from "@opensteer/client/host";
import {
  useHostSelector,
  useTabDeviceChoice,
  useTabFilterMatches,
  useTabsSyncing,
  useUnreadableResources,
} from "@opensteer/client/react";
import type { TabId } from "@opensteer/core";
import {
  StackActions,
  useIsFocused,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { tabRoute } from "../browser/surface-route.js";
import { TabList } from "../tabs/tab-list.js";
import { color, space, touchTarget } from "../theme.js";
import { NativeMenu, type NativeMenuOption } from "../thread/composer-menu.js";
import { ActionLine } from "../ui/action-line.js";
import { Gated } from "../ui/connection-gate.js";
import { useConnectionReady } from "../ui/connection-live.js";
import { useScreenAction } from "../ui/client-feedback.js";
import { PlaceholderRows } from "../ui/placeholder.js";
import { AppText, Notice, SecondaryButton } from "../ui/primitives.js";
import { ConnectionRouteGate } from "../ui/route-gate.js";
import { tabActionKey, tabActionSpecs } from "../tabs/tab-actions.js";
import { Symbol } from "../ui/symbol.js";
import { Screen, useListContentInsets, useReadingColumn } from "../ui/screen.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";

export type TabsScreenProps = StaticScreenProps<{ readonly deploymentId: string }>;

/**
 * Tabs: the person's one tab list, as web and desktop show it — pages, Mac
 * windows, Agent Phones and apps in the Host's one order, groups mixing any
 * of them. A row opens exactly its tab, alone; nothing here chooses a
 * conversation. The list draws no pictures: on cellular a picture per row
 * costs a stream per row.
 */
export function TabsScreen(props: TabsScreenProps): ReactNode {
  const { deploymentId } = props.route.params;
  const hostClient = useAttachedHost(deploymentId);
  return (
    <Gated gate={hostClient === null ? <DeploymentGate deploymentId={deploymentId} /> : null}>
      {hostClient === null ? null : (
        <AttachedTabs deploymentId={deploymentId} hostClient={hostClient} />
      )}
    </Gated>
  );
}

const selectReader = (snapshot: HostSnapshot) =>
  snapshot.session === "authenticated" ? (snapshot.user?.id ?? null) : null;

const tabKinds = ["tab", "tab-layout"] as const;

function AttachedTabs(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
}): ReactNode {
  const { hostClient } = props;
  // Only who is reading: a streamed token re-renders nothing here.
  const reader = useHostSelector(hostClient, selectReader);
  // Tabs never listed and no connection to list them: the gate is the one explanation.
  const syncing = useTabsSyncing(hostClient);
  const ready = useConnectionReady(hostClient.connection);
  const tabsRead = useUnreadableResources(hostClient, tabKinds);
  useEffect(() => {
    void hostClient.load().catch(() => undefined);
  }, [hostClient]);
  // Tabs that could not be read are said so, with Try again, never listed empty or stale.
  if (reader !== null && tabsRead.unreadable)
    return (
      <Screen>
        <Notice
          action={{ label: "Try again", onPress: tabsRead.retry }}
          detail="Your computer sent a tab list this phone couldn't read."
          title="Couldn't load your tabs."
        />
      </Screen>
    );
  const gate =
    reader === null || (syncing && !ready) ? (
      <ConnectionRouteGate connection={hostClient.connection} />
    ) : null;
  return (
    <Gated gate={gate}>
      {/* Nothing one person was shown is ever shown to another. */}
      {reader === null ? null : (
        <TabsForReader deploymentId={props.deploymentId} hostClient={hostClient} key={reader} />
      )}
    </Gated>
  );
}

/** The list's narrowing: every tab or only those agents use, on every computer or one. */
export interface TabFilter {
  readonly agents: boolean;
  readonly computerId: string | null;
}

const allTabs: TabFilter = { agents: false, computerId: null };

function TabsForReader(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
}): ReactNode {
  const { deploymentId, hostClient } = props;
  const navigation = useNavigation();
  const focused = useIsFocused();
  const column = useReadingColumn();
  const insets = useListContentInsets(space[32]);
  const syncing = useTabsSyncing(hostClient);
  const [filter, setFilter] = useState<TabFilter>(allTabs);
  const reopen = useScreenAction(
    hostClient,
    tabActionKey("reopenLast", "list"),
    tabActionSpecs.reopenLast,
  );
  // The shared filter: it reads only what it matches on, so a title arriving recomputes nothing.
  const shared = useMemo<SharedTabFilter>(
    () => ({ agents: filter.agents, device: filter.computerId, profile: null }),
    [filter],
  );
  const matches = useTabFilterMatches(hostClient, shared);
  // The computers the list spans; offered only for more than one.
  const choice = useTabDeviceChoice(hostClient, null, null, shared);
  const computers = useMemo(
    () => choice.devices.map((device) => ({ id: device.id, name: device.name })),
    [choice],
  );
  const canOpen = useHostSelector(hostClient, selectCanOpen);
  const openApp = useCallback(
    () => navigation.dispatch(StackActions.push("OpenApp", { deploymentId })),
    [deploymentId, navigation],
  );
  const { run: runReopen } = reopen;
  const reopenClosed = useCallback(
    () => void runReopen(() => hostClient.reopenTab()),
    [hostClient, runReopen],
  );
  useTabsBar({
    computers,
    filter,
    focused,
    onChange: setFilter,
    onOpen: canOpen ? openApp : null,
    onReopen: reopenClosed,
  });
  const open = useCallback(
    (tabId: TabId) =>
      navigation.dispatch(StackActions.push("WorkspaceBrowser", tabRoute(deploymentId, tabId))),
    [deploymentId, navigation],
  );
  const filtering = filter.agents || filter.computerId !== null;
  // Reopen is a bar action, so its answer stands at the head of the list.
  const notices =
    reopen.line === null ? null : <ActionLine line={reopen.line} onDismiss={reopen.dismiss} />;
  return (
    <Screen edgeToEdge>
      <TabList
        contentStyle={[styles.content, column, insets]}
        empty={
          syncing ? (
            <PlaceholderRows />
          ) : (
            <View style={styles.empty}>
              <AppText role="bodyMedium">{filtering ? "No tabs match" : "No tabs yet"}</AppText>
              <AppText role="secondary" style={styles.centred} tone="muted">
                {filtering
                  ? "Tabs appear here while a task works in them."
                  : "Tabs you and your agents open appear here."}
              </AppText>
              {filtering ? (
                <SecondaryButton compact label="Show all tabs" onPress={() => setFilter(allTabs)} />
              ) : (
                <View style={styles.emptyActions}>
                  {canOpen ? <SecondaryButton compact label="Open" onPress={openApp} /> : null}
                  <SecondaryButton
                    busy={reopen.running}
                    compact
                    label="Reopen closed tab"
                    onPress={reopenClosed}
                  />
                </View>
              )}
            </View>
          )
        }
        header={notices}
        hostClient={hostClient}
        matches={matches}
        onOpen={open}
        shown={focused}
      />
    </Screen>
  );
}

/**
 * The bar: Open, for a new tab or the person's own Mac apps and phones, and a
 * menu to narrow the list — every tab or only those agents use, every computer
 * or one, which the title then names — and to reopen the last closed tab. iOS
 * draws native bar items; Android the same in its own bar.
 */
function useTabsBar(props: {
  readonly computers: readonly { readonly id: string; readonly name: string }[];
  readonly filter: TabFilter;
  readonly focused: boolean;
  readonly onChange: (filter: TabFilter) => void;
  readonly onOpen: (() => void) | null;
  readonly onReopen: () => void;
}): void {
  const { computers, filter } = props;
  const navigation = useNavigation();
  const latest = useRef(props);
  latest.current = props;
  const openOffered = props.onOpen !== null;
  useLayoutEffect(() => {
    const computer = computers.find(({ id }) => id === filter.computerId)?.name ?? null;
    const words = [filter.agents ? "Tabs with agents" : "Tabs", computer]
      .filter((part) => part !== null)
      .join(" · ");
    const active = filter.agents || filter.computerId !== null;
    const label = active ? `More: ${words}` : "More";
    const choose = (next: TabFilter) => () => latest.current.onChange(next);
    const sections: readonly (readonly NativeMenuOption[])[] = [
      [
        {
          id: "all",
          label: "All tabs",
          onPress: choose({ ...filter, agents: false }),
          selected: !filter.agents,
        },
        {
          id: "agents",
          label: "Tabs with agents",
          onPress: choose({ ...filter, agents: true }),
          selected: filter.agents,
        },
      ],
      computers.length < 2
        ? []
        : [
            {
              id: "computer:all",
              label: "All computers",
              onPress: choose({ ...filter, computerId: null }),
              selected: filter.computerId === null,
            },
            ...computers.map((option): NativeMenuOption => ({
              id: `computer:${option.id}`,
              label: option.name,
              onPress: choose({ ...filter, computerId: option.id }),
              selected: filter.computerId === option.id,
            })),
          ],
      [
        {
          icon: "arrow.uturn.backward",
          id: "reopen",
          label: "Reopen closed tab",
          onPress: () => latest.current.onReopen(),
        },
      ],
    ];
    navigation.setOptions({
      title: words,
      headerRight: () => (
        <View style={styles.barItems}>
          <NativeMenu accessibilityLabel={label} options={sections} style={styles.barItem}>
            <Symbol name="line.3.horizontal.decrease" tint={color.ember} />
          </NativeMenu>
          {openOffered ? (
            <Pressable
              accessibilityHint="Opens a new tab, or an app on your Mac or an Agent Phone"
              accessibilityLabel="Open"
              accessibilityRole="button"
              onPress={() => latest.current.onOpen?.()}
              style={styles.barItem}
            >
              <Symbol name="plus" tint={color.ember} />
            </Pressable>
          ) : null}
        </View>
      ),
      unstable_headerRightItems: () => [
        ...(openOffered
          ? [
              {
                accessibilityHint: "Opens a new tab, or an app on your Mac or an Agent Phone",
                accessibilityLabel: "Open",
                icon: { name: "plus", type: "sfSymbol" as const },
                label: "Open",
                onPress: () => latest.current.onOpen?.(),
                type: "button" as const,
              },
            ]
          : []),
        {
          accessibilityLabel: label,
          icon: {
            name: active
              ? "line.3.horizontal.decrease.circle.fill"
              : "line.3.horizontal.decrease.circle",
            type: "sfSymbol" as const,
          },
          label: "More",
          menu: {
            items: sections
              .filter((section) => section.length > 0)
              .map((section) => ({
                inline: true,
                items: section.map((choice) => ({
                  ...(choice.icon === undefined
                    ? {}
                    : { icon: { name: choice.icon, type: "sfSymbol" as const } }),
                  label: choice.label,
                  onPress: choice.onPress,
                  state: choice.selected === true ? ("on" as const) : ("off" as const),
                  type: "action" as const,
                })),
                label: "",
                type: "submenu" as const,
              })),
          },
          type: "menu" as const,
        },
      ],
    });
  }, [computers, filter, navigation, openOffered, props.focused]);
}

/**
 * Whether there is anything to open: a browser to start a tab in, or a Mac or
 * Agent Phone of their own, which they own or is their Personal deployment's
 * Main computer.
 */
function selectCanOpen(snapshot: HostSnapshot): boolean {
  if (snapshot.browserAvailable) return true;
  return snapshot.machines.some(
    (machine) =>
      machine.computerUse !== undefined &&
      machine.computerUse !== null &&
      (machine.ownership === "mine" || machine.ownership === "deployment"),
  );
}

const styles = StyleSheet.create({
  barItem: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: touchTarget,
    minWidth: touchTarget,
  },
  barItems: { alignItems: "center", flexDirection: "row" },
  centred: { textAlign: "center" },
  content: { paddingTop: space[8] },
  empty: {
    alignItems: "center",
    gap: space[8],
    paddingHorizontal: space[16],
    paddingVertical: space[48],
  },
  emptyActions: { flexDirection: "row", gap: space[8], paddingTop: space[8] },
});
