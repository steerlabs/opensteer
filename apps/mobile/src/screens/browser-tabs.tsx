import {
  browserTabTitle,
  placeAgents,
  samePlaceAgents,
  type HostClient,
  type HostSnapshot,
  type PlaceItem,
} from "@opensteer/client/host";
import { useHostSelector, usePlaceList } from "@opensteer/client/react";
import {
  CommonActions,
  StackActions,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { memo, useCallback, useMemo, type ReactNode } from "react";
import { FlatList, Image, Pressable, StyleSheet, View } from "react-native";
import { AgentMarks } from "../browser/agent-marks.js";
import { pageSite } from "../browser/surface-route.js";
import { color, radius, space, touchTarget } from "../theme.js";
import { useContentInsets } from "../ui/pane.js";
import { useMobileState } from "../ui/mobile-client-context.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";

export type BrowserTabsScreenProps = StaticScreenProps<{
  readonly deploymentId: string;
  readonly sessionId: string;
  readonly tabId: string;
}>;

/** One of the browser's tabs as the sheet lists it. */
interface TabRowItem {
  readonly favicon: string | null;
  readonly id: string;
  readonly place: PlaceItem | null;
  readonly site: string | null;
  readonly title: string;
}

/**
 * One browser's tabs, over the page they were opened from, as Safari's tab
 * button shows them: in the browser's own order, the one in front checked,
 * and who is in each. Choosing one puts it in front in the page's place; All
 * tabs goes to every computer's.
 */
export function BrowserTabsScreen(props: BrowserTabsScreenProps): ReactNode {
  const { deploymentId, sessionId, tabId } = props.route.params;
  const { selection } = useMobileState();
  if (selection.deploymentId !== deploymentId || selection.hostClient === null) return null;
  return (
    <BrowserTabs
      deploymentId={deploymentId}
      hostClient={selection.hostClient}
      sessionId={sessionId}
      tabId={tabId}
    />
  );
}

function BrowserTabs(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
  readonly sessionId: string;
  readonly tabId: string;
}): ReactNode {
  const { deploymentId, hostClient, sessionId, tabId } = props;
  const navigation = useNavigation();
  const insets = useContentInsets();
  const selectSession = useCallback(
    (snapshot: HostSnapshot) => snapshot.browserSessions.find(({ id }) => id === sessionId) ?? null,
    [sessionId],
  );
  const session = useHostSelector(hostClient, selectSession);
  const places = usePlaceList(hostClient);
  const rows = useMemo((): readonly TabRowItem[] => {
    if (session === null) return [];
    const placeOf = (id: string) =>
      places.find(
        (place) => place.destination.kind === "browser" && place.destination.tabId === id,
      ) ?? null;
    const catalog = session.tabCatalog?.tabs;
    if (catalog !== undefined)
      return [...catalog]
        .sort((left, right) => left.order - right.order)
        .map((tab) => ({
          favicon: session.tabs.find(({ id }) => id === tab.id)?.favicon ?? null,
          id: tab.id,
          place: placeOf(tab.id),
          site: pageSite(tab.site),
          title: tab.title || pageSite(tab.site) || "New tab",
        }));
    return session.tabs.map((tab) => ({
      favicon: tab.favicon ?? null,
      id: tab.id,
      place: placeOf(tab.id),
      site: pageSite(tab.url),
      title: browserTabTitle(tab),
    }));
  }, [places, session]);
  // The computer the browser runs on, and the profile it is signed in as.
  const owner = places.find((place) => place.browser?.sessionId === sessionId);
  const where = [owner?.device?.name ?? null, owner?.identity?.name ?? null]
    .filter((part): part is string => part !== null && part !== "")
    .join(" · ");

  // The page under this sheet takes the chosen tab; it is the screen the sheet
  // was presented over, so it is found by where it is rather than by name.
  const choose = useCallback(
    (id: string) => {
      const state = navigation.getState();
      const page = state?.routes[state.index - 1];
      if (id !== tabId && page !== undefined)
        navigation.dispatch({
          ...CommonActions.setParams({ editAddress: false, tabId: id }),
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
          <AppText role="title">{rows.length === 1 ? "1 tab" : `${rows.length} tabs`}</AppText>
          {where === "" ? null : (
            <AppText numberOfLines={1} role="caption" tone="muted">
              {where}
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
        data={rows}
        keyExtractor={(row) => row.id}
        renderItem={({ index, item }) => (
          <TabRow
            current={item.id === tabId}
            first={index === 0}
            hostClient={hostClient}
            last={index === rows.length - 1}
            onChoose={choose}
            row={item}
          />
        )}
      />
    </View>
  );
}

const noAgents = { agents: [], unnamedActing: false } as const;

const TabRow = memo(function TabRow(props: {
  readonly current: boolean;
  readonly first: boolean;
  readonly hostClient: HostClient;
  readonly last: boolean;
  readonly onChoose: (id: string) => void;
  readonly row: TabRowItem;
}): ReactNode {
  const { row } = props;
  const { place } = row;
  const selectAgents = useCallback(
    (snapshot: HostSnapshot) => (place === null ? noAgents : placeAgents(place, snapshot)),
    [place],
  );
  const agents = useHostSelector(props.hostClient, selectAgents, samePlaceAgents);
  return (
    <Pressable
      accessibilityLabel={[row.title, row.site].filter(Boolean).join(", ")}
      accessibilityRole="button"
      accessibilityState={{ selected: props.current }}
      onPress={() => props.onChoose(row.id)}
      style={({ pressed }) => [
        styles.row,
        props.first && styles.rowFirst,
        props.last && styles.rowLast,
        !props.first && styles.rowSeparated,
        pressed && styles.pressed,
      ]}
    >
      {row.favicon === null ? (
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
      {props.current ? (
        <Symbol name="checkmark" size={15} tint={color.ember} weight="semibold" />
      ) : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  all: { justifyContent: "center", minHeight: touchTarget },
  dim: { opacity: 0.6 },
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
  list: { paddingHorizontal: space[16], paddingTop: space[8] },
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
  words: { flex: 1, gap: space[2], minWidth: 0 },
});
