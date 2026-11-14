import { placeList } from "@opensteer/client/host";
import { PendingBrowserTabRows } from "../browser/pending-browser-tab.js";
import {
  allTabs,
  browserTabPicture,
  placeAgents,
  placeAgentsWords,
  devicesElsewhere,
  placeDeviceLabels,
  sameDevicesElsewhere,
  tabListHomeId,
  placeHasAgents,
  profileBadgesVisible,
  samePlaceAgents,
  tabFilterActive,
  tabFilterEmptyWords,
  tabFilterWords,
  type HostClient,
  type HostSnapshot,
  type PlaceItem,
  type PlaceKind,
  type PlaceDescriptor,
  type TabFilter,
  type TabFilterDevice,
} from "@opensteer/client/host";
import type { DeviceElsewhere } from "@opensteer/client/computers";
import {
  useBrowserGroups,
  useHostSelector,
  usePlace,
  usePlaceStructure,
  useSyncingPlaceholder,
  useTabDeviceChoice,
  useTabFilterMatches,
} from "@opensteer/client/react";
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
  Pressable,
  SectionList,
  StyleSheet,
  View,
  type SectionListRenderItemInfo,
} from "react-native";
import { ActingDot } from "../browser/acting-dot.js";
import { AgentMarks } from "../browser/agent-marks.js";
import { opensteerAppGlyph } from "../browser/agent-surface.js";
import { tabSiteLabel } from "../browser/site-label.js";
import { tabsRoute } from "../browser/surface-route.js";
import { MacAppIcon } from "../computers/app-mark.js";
import { useHereDeviceId } from "../computers/here-device.js";
import { color, radius, space, touchTarget } from "../theme.js";
import { NativeMenu, type NativeMenuOption } from "../thread/composer-menu.js";
import { NeedsYouTag } from "../threads/task-row.js";
import { AppText, Notice, SecondaryButton } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { Screen, useListContentInsets, useReadingColumn } from "../ui/screen.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";
import { useAppForeground } from "../ui/foreground.js";
import { homeName } from "./profile-home-menu.js";
import { computerSymbols } from "./settings-model.js";
import { TabPicture } from "./tab-picture.js";

export type TabsScreenProps = StaticScreenProps<{ readonly deploymentId: string }>;

/**
 * Tabs: every tab, app and phone this person may see on the Deployment, from
 * the shared place list web and desktop read — tabs they opened by hand,
 * tasks' and delegated work's tabs, saved tabs and the person's own views —
 * in one list in the person's own order, browser tabs first, then the Mac
 * apps, phones and Opensteer Apps. Each row names its device while the list
 * spans more than one; the filter narrows it to one device, or to agents.
 *
 * A row shows a picture of its page only when this phone already holds one;
 * it never asks for one, because a picture costs a stream per row on a phone
 * that may be on cellular. A row opens exactly its place, alone. Nothing here
 * chooses a conversation, from who is in a place or from what was in front.
 */
export function TabsScreen(props: TabsScreenProps): ReactNode {
  const { deploymentId } = props.route.params;
  const hostClient = useAttachedHost(deploymentId);
  if (hostClient === null) return <DeploymentGate deploymentId={deploymentId} />;
  return <AttachedTabs deploymentId={deploymentId} hostClient={hostClient} />;
}

const selectReader = (snapshot: HostSnapshot) =>
  snapshot.session === "authenticated" ? (snapshot.user?.id ?? null) : null;

function AttachedTabs(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
}): ReactNode {
  const { hostClient } = props;
  // Only who is reading: a streamed token re-renders nothing here.
  const reader = useHostSelector(hostClient, selectReader);
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const [failure, setFailure] = useState<string | null>(null);
  const reload = useCallback(() => {
    setFailure(null);
    void hostClient
      .refresh()
      .catch((error: unknown) =>
        setFailure(error instanceof Error ? error.message : "Unable to connect to the Host."),
      );
  }, [hostClient]);
  useEffect(() => {
    void hostClient.load().catch(() => undefined);
  }, [hostClient]);
  useEffect(() => {
    if (focused && foreground && reader !== null) reload();
  }, [focused, foreground, reader, reload]);
  if (reader === null) {
    return (
      <Screen>
        <Notice
          title="Connecting…"
          detail="Your tabs appear once you are signed in."
          tone="neutral"
        />
      </Screen>
    );
  }
  // Nothing one person was shown is ever shown to another.
  return (
    <TabsForReader
      active={focused && foreground}
      deploymentId={props.deploymentId}
      failure={failure}
      hostClient={hostClient}
      key={reader}
      onRetry={reload}
    />
  );
}

/**
 * The list's two runs, as the sidebar's hairline parts them on web: browser
 * tabs, then the Mac apps, phones and Opensteer Apps. An empty run is left out.
 */
interface PlaceRun {
  readonly key: "web" | "native";
  readonly data: readonly PlaceDescriptor[];
}

function placeRuns(places: readonly PlaceDescriptor[]): readonly PlaceRun[] {
  const runs: PlaceRun[] = [
    { key: "web", data: places.filter((place) => place.kind === "browser") },
    { key: "native", data: places.filter((place) => place.kind !== "browser") },
  ];
  return runs.filter((run) => run.data.length > 0);
}

/**
 * The tabs a pending sign-in Request names, as `session:tab`. Only a Request
 * that names its tab marks one: a session-wide one could be any of its tabs.
 * A string, so a streamed token, which leaves it equal, redraws nothing.
 */
function selectSignIns(snapshot: HostSnapshot): string {
  return snapshot.waitingRequests
    .flatMap(({ request: { payload } }) =>
      payload.kind === "browser.sign-in" && payload.tabId !== undefined
        ? [`${payload.sessionId}:${payload.tabId}`]
        : [],
    )
    .sort()
    .join("\n");
}

const selectLoaded = (snapshot: HostSnapshot) => snapshot.deploymentShape !== null;
const selectAnyAgents = (snapshot: HostSnapshot) => placeList(snapshot).some(placeHasAgents);

function TabsForReader(props: {
  readonly active: boolean;
  readonly deploymentId: string;
  /** Why the last refresh failed, offered again with Try again. */
  readonly failure: string | null;
  readonly hostClient: HostClient;
  readonly onRetry: () => void;
}): ReactNode {
  const { deploymentId, hostClient } = props;
  const navigation = useNavigation();
  const column = useReadingColumn();
  const insets = useListContentInsets(space[32]);
  // The list arranges slots; each row reads its own place, so a title repaints one row.
  const places = usePlaceStructure(hostClient);
  const groupList = useBrowserGroups(hostClient);
  const hereId = useHereDeviceId(deploymentId);
  const selectHome = useCallback(
    (snapshot: HostSnapshot) => tabListHomeId(snapshot, hereId),
    [hereId],
  );
  const homeId = useHostSelector(hostClient, selectHome);
  const selectElsewhere = useCallback(
    (snapshot: HostSnapshot) => devicesElsewhere(snapshot.machines, homeId),
    [homeId],
  );
  // Labels keep their identity while their devices stay the same, so rows stay undrawn.
  const elsewhere = useHostSelector(hostClient, selectElsewhere, sameDevicesElsewhere);
  const loaded = useHostSelector(hostClient, selectLoaded);
  const signInKeys = useHostSelector(hostClient, selectSignIns);
  const [chosenFilter, setFilter] = useState<TabFilter>(allTabs);
  const choice = useTabDeviceChoice(hostClient, hereId, homeId, chosenFilter);
  const filter = choice.filter;
  const filtering = tabFilterActive(filter);
  const deviceName = choice.devices.find(({ id }) => id === filter.device)?.name ?? null;
  const matched = useTabFilterMatches(hostClient, filter);
  const anyAgents = useHostSelector(hostClient, selectAnyAgents);
  const canOpen = useHostSelector(hostClient, selectCanOpen);
  const openApp = useCallback(
    () => navigation.dispatch(StackActions.push("OpenApp", { deploymentId })),
    [deploymentId, navigation],
  );
  useTabsBar({
    devices: choice.devices,
    filter,
    filterOffered: filtering || choice.devices.length > 0 || anyAgents,
    onChange: setFilter,
    onOpen: canOpen ? openApp : null,
  });
  const shown = useMemo(
    () => (matched ? places.filter((place) => matched.has(place.key)) : places),
    [matched, places],
  );
  const sections = useMemo(() => placeRuns(shown), [shown]);
  const deviceLabels = useMemo(() => placeDeviceLabels(shown, elsewhere), [elsewhere, shown]);
  const signIns = useMemo(() => new Set(signInKeys.split("\n")), [signInKeys]);
  const selectShowProfile = useCallback(
    () => profileBadgesVisible(placeList(hostClient.getSnapshot())),
    [hostClient],
  );
  const showProfile = useHostSelector(hostClient, selectShowProfile);
  const open = useCallback(
    (place: PlaceItem) =>
      navigation.dispatch(
        StackActions.push("WorkspaceBrowser", tabsRoute(deploymentId, place.destination)),
      ),
    [deploymentId, navigation],
  );
  const renderItem = useCallback(
    ({ index, item, section }: SectionListRenderItemInfo<PlaceDescriptor, PlaceRun>) => (
      <KeyedPlaceRow
        device={deviceLabels.get(item.key) ?? null}
        first={index === 0}
        hostClient={hostClient}
        last={index === section.data.length - 1}
        needsYou={
          item.destination.kind === "browser" &&
          signIns.has(`${item.destination.sessionId}:${item.destination.tabId}`)
        }
        onOpen={open}
        placeKey={item.key}
        shown={props.active}
        showProfile={showProfile}
      />
    ),
    [deviceLabels, hostClient, open, props.active, showProfile, signIns],
  );
  // Still syncing with nothing to list: no empty state, and past a moment the loading line.
  const loading = (!loaded || groupList.syncing) && places.length === 0;
  const finding = useSyncingPlaceholder(!loaded || groupList.syncing, places.length);
  return (
    <Screen edgeToEdge>
      <SectionList<PlaceDescriptor, PlaceRun>
        contentContainerStyle={[styles.content, column, insets]}
        contentInsetAdjustmentBehavior="automatic"
        keyExtractor={(item) => item.key}
        ListEmptyComponent={
          loading && !finding ? undefined : (
            <View style={styles.empty}>
              <AppText role="bodyMedium" tone={loading ? "muted" : "default"}>
                {loading
                  ? "Finding tabs…"
                  : filtering
                    ? tabFilterEmptyWords(filter, deviceName)
                    : "No tabs yet"}
              </AppText>
              {loading || (filtering && !filter.agents) ? null : (
                <AppText role="secondary" style={styles.centred} tone="muted">
                  {filtering
                    ? "Tabs appear here while a task works in them."
                    : "Tabs you and your agents open appear here."}
                </AppText>
              )}
              {loading ? null : filtering ? (
                <View style={styles.emptyAction}>
                  <SecondaryButton
                    compact
                    label="Show all tabs"
                    onPress={() => setFilter(allTabs)}
                  />
                </View>
              ) : canOpen ? (
                <View style={styles.emptyAction}>
                  <SecondaryButton compact label="Open an app" onPress={openApp} />
                </View>
              ) : null}
            </View>
          )
        }
        ListHeaderComponent={
          <>
            <PendingBrowserTabRows hostClient={hostClient} deploymentId={deploymentId} />
            {props.failure === null ? null : (
              <View style={styles.notices}>
                <Notice
                  title="Tabs could not be refreshed"
                  detail={props.failure}
                  action={{ label: "Try again", onPress: props.onRetry }}
                />
              </View>
            )}
          </>
        }
        renderItem={renderItem}
        renderSectionHeader={({ section }) =>
          section.key === sections[0]?.key ? null : <View style={styles.groupGap} />
        }
        sections={sections}
        stickySectionHeadersEnabled={false}
      />
    </Screen>
  );
}

const kindHint: Record<PlaceKind, string> = {
  "opensteer-app": "Opens this app",
  app: "Opens this app",
  browser: "Opens this tab",
  phone: "Opens this phone",
};

/**
 * Under a row's title: the site, or what kind of place it is, who it browses
 * as when that tells rows apart, then anything not ordinary. Where it runs is
 * the row's trailing device shape, not words.
 */
function placeDetail(
  place: PlaceItem,
  showProfile: boolean,
  device: DeviceElsewhere | null,
): readonly string[] {
  const where =
    place.kind === "browser"
      ? tabSiteLabel(place.site)
      : place.kind === "app"
        ? "Mac app"
        : place.kind === "phone"
          ? "Agent Phone"
          : "Opensteer app";
  const state =
    place.availability === "unavailable"
      ? device && !device.online
        ? "Offline"
        : "Unavailable"
      : place.loading || place.availability === "starting"
        ? "Opening…"
        : null;
  return [where, showProfile ? (place.identity?.name ?? null) : null, state].filter(
    (part): part is string => part !== null && part !== "",
  );
}

interface PlaceRowProps {
  /** The device it runs on, when that is not the main computer. */
  readonly device: DeviceElsewhere | null;
  readonly first: boolean;
  readonly hostClient: HostClient;
  readonly last: boolean;
  /** A pending sign-in Request names this very tab. */
  readonly needsYou: boolean;
  readonly onOpen: (place: PlaceItem) => void;
  readonly place: PlaceItem;
  /** The list is on screen: a row looks again for a picture this phone has kept. */
  readonly shown: boolean;
  readonly showProfile: boolean;
}

/** A row reads its own place, so one tab's title or loading repaints only it. */
const KeyedPlaceRow = memo(function KeyedPlaceRow({
  placeKey,
  ...props
}: Omit<PlaceRowProps, "place"> & { readonly placeKey: string }): ReactNode {
  const place = usePlace(props.hostClient, placeKey);
  return place ? <PlaceRow {...props} place={place} /> : null;
});

/**
 * One place: its mark, its title, its site or kind, and who is in it as the
 * page's own pill marks them. It reads only its own occupants, so an agent
 * arriving redraws this row alone and a streamed token redraws none.
 */
const PlaceRow = memo(function PlaceRow(props: PlaceRowProps): ReactNode {
  const { hostClient, place } = props;
  const selectAgents = useCallback(
    (snapshot: HostSnapshot) => placeAgents(place, snapshot),
    [place],
  );
  const agents = useHostSelector(hostClient, selectAgents, samePlaceAgents);
  const words = placeAgentsWords(agents);
  const acting = agents.unnamedActing || agents.agents.some((agent) => agent.acting);
  const detail = placeDetail(place, props.showProfile, props.device);
  const unavailable = place.availability === "unavailable";
  const picture =
    props.shown && place.destination.kind === "browser" && place.destination.tabId
      ? browserTabPicture(hostClient, place.destination.sessionId, place.destination.tabId)
      : null;
  return (
    <Pressable
      accessibilityHint={kindHint[place.kind]}
      accessibilityLabel={[
        place.title,
        ...detail,
        props.device?.name ?? null,
        words?.label ?? null,
        props.needsYou ? "needs you" : null,
      ]
        .filter((part) => part !== null)
        .join(", ")}
      accessibilityRole="button"
      onPress={() => props.onOpen(place)}
      style={({ pressed }) => [
        styles.row,
        props.first && styles.rowFirst,
        props.last && styles.rowLast,
        !props.first && styles.rowSeparated,
        pressed && styles.pressed,
      ]}
      testID={`place:${acting ? "acting" : "idle"}`}
    >
      <View style={[styles.mark, unavailable && styles.dimmed]}>
        {picture ? (
          <TabPicture picture={picture} size={32} />
        ) : place.icon.kind === "app" ? (
          <MacAppIcon
            app={place.icon.app}
            hostClient={props.hostClient}
            machineId={place.icon.machineId}
            size={32}
          />
        ) : (
          <View style={styles.glyph}>
            <Symbol
              name={
                place.kind === "opensteer-app"
                  ? opensteerAppGlyph
                  : place.kind === "phone"
                    ? "smartphone"
                    : "globe"
              }
              size={17}
              tint={color.muted}
            />
          </View>
        )}
      </View>
      <View style={styles.words}>
        <AppText numberOfLines={1} role="bodyMedium" tone={unavailable ? "muted" : "default"}>
          {place.title}
        </AppText>
        {detail.length === 0 ? null : (
          <AppText numberOfLines={1} role="caption" tone="muted">
            {detail.join(" · ")}
          </AppText>
        )}
      </View>
      {props.device ? (
        <Symbol name={computerSymbols[props.device.glyph]} size={15} tint={color.muted} />
      ) : null}
      {props.needsYou ? <NeedsYouTag /> : null}
      {agents.agents.length > 0 ? (
        <AgentMarks agents={agents.agents} />
      ) : agents.unnamedActing ? (
        <ActingDot grouped />
      ) : null}
    </Pressable>
  );
});

/**
 * The bar: Open, for the person's own Mac apps and phones, and the filter —
 * every tab, or only those agents are in, or one device's, which the title
 * then names. iOS draws native bar items; Android the same in its own bar.
 * The filter is offered while there is something to narrow, and while it
 * narrows, so the way back is always there.
 */
function useTabsBar(props: {
  readonly devices: readonly TabFilterDevice[];
  readonly filter: TabFilter;
  readonly filterOffered: boolean;
  readonly onChange: (filter: TabFilter) => void;
  readonly onOpen: (() => void) | null;
}): void {
  const { devices, filter, filterOffered } = props;
  const navigation = useNavigation();
  const change = useRef(props.onChange);
  change.current = props.onChange;
  const open = useRef(props.onOpen);
  open.current = props.onOpen;
  const openOffered = props.onOpen !== null;
  useLayoutEffect(() => {
    const active = tabFilterActive(filter);
    const deviceName = devices.find(({ id }) => id === filter.device)?.name ?? null;
    const words = tabFilterWords(filter, deviceName);
    const label = active ? `Filter: ${words}` : "Filter";
    const choose = (next: TabFilter) => () => change.current(next);
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
      devices.length === 0
        ? []
        : [
            {
              id: "device:all",
              label: "All devices",
              onPress: choose({ ...filter, device: null }),
              selected: filter.device === null,
            },
            ...devices.map((device): NativeMenuOption => ({
              icon: computerSymbols[device.glyph],
              id: `device:${device.id}`,
              label: deviceChoiceLabel(device),
              onPress: choose({ ...filter, device: device.id }),
              selected: filter.device === device.id,
            })),
          ],
    ];
    navigation.setOptions({
      title: words,
      headerRight: () => (
        <View style={styles.barItems}>
          {filterOffered ? (
            <NativeMenu
              accessibilityLabel={label}
              onPresent={noop}
              onSettle={noop}
              options={sections}
              style={styles.barItem}
            >
              <Symbol name="line.3.horizontal.decrease" tint={color.ember} />
            </NativeMenu>
          ) : null}
          {openOffered ? (
            <Pressable
              accessibilityHint="Opens a new tab, or an app on your Mac or an Agent Phone"
              accessibilityLabel="Open"
              accessibilityRole="button"
              onPress={() => open.current?.()}
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
                onPress: () => open.current?.(),
                type: "button" as const,
              },
            ]
          : []),
        ...(filterOffered
          ? [
              {
                accessibilityLabel: label,
                icon: {
                  name: active
                    ? "line.3.horizontal.decrease.circle.fill"
                    : "line.3.horizontal.decrease.circle",
                  type: "sfSymbol" as const,
                },
                label: "Filter",
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
            ]
          : []),
      ],
    });
  }, [devices, filter, filterOffered, navigation, openOffered]);
}

/** A device in the filter: this phone as the phone says it, and Offline when it is away. */
function deviceChoiceLabel(device: TabFilterDevice): string {
  const name = homeName(device);
  return device.online ? name : `${name} · Offline`;
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

function noop(): void {}

const styles = StyleSheet.create({
  centred: { textAlign: "center" },
  content: { paddingTop: space[8] },
  dimmed: { opacity: 0.45 },
  empty: {
    alignItems: "center",
    gap: space[8],
    paddingHorizontal: space[16],
    paddingVertical: space[48],
  },
  emptyAction: { paddingTop: space[8] },
  barItem: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: touchTarget,
    minWidth: touchTarget,
  },
  barItems: { alignItems: "center", flexDirection: "row" },
  glyph: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.sm,
    height: 32,
    justifyContent: "center",
    width: 32,
  },
  groupGap: { height: space[16] },
  mark: { height: 32, width: 32 },
  notices: { gap: space[8], paddingBottom: space[8] },
  pressed: { backgroundColor: color.surfacePressed },
  // One plate per run, as the platform's grouped lists draw it. Each line
  // is held to one, so a row is as tall as its text size and no taller.
  row: {
    alignItems: "center",
    backgroundColor: color.surface,
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget + space[12],
    paddingHorizontal: space[12],
    paddingVertical: space[8],
  },
  rowFirst: { borderTopLeftRadius: radius.md, borderTopRightRadius: radius.md },
  rowLast: { borderBottomLeftRadius: radius.md, borderBottomRightRadius: radius.md },
  rowSeparated: { borderColor: color.line, borderTopWidth: StyleSheet.hairlineWidth },
  words: { flex: 1, gap: space[2], minWidth: 0 },
});
