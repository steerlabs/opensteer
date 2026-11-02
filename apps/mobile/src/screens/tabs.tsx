import { PendingBrowserTabRows } from "../browser/pending-browser-tab.js";
import {
  canRespondToRequests,
  describeHostConnection,
  placeAgents,
  placeAgentsWords,
  placeHasAgents,
  profileBadgesVisible,
  samePlaceAgents,
  type HostClient,
  type HostSnapshot,
  type PlaceItem,
  type PlaceKind,
} from "@opensteer/client/host";
import { useHostSelector, usePlaceList } from "@opensteer/client/react";
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
import { tabSiteLabel } from "../browser/site-label.js";
import { workspaceRoute } from "../browser/surface-route.js";
import { MacAppIcon } from "../computers/app-mark.js";
import { useSidebarMenu } from "../navigation-header.js";
import { color, controlFontScaleLimit, radius, space, touchTarget } from "../theme.js";
import { NativeMenu, type NativeMenuOption } from "../thread/composer-menu.js";
import { NeedsYouTag } from "../threads/task-row.js";
import { AppText, Notice, SecondaryButton } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { Screen, useListContentInsets, useReadingColumn } from "../ui/screen.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";
import { useAppForeground } from "../ui/foreground.js";

export type TabsScreenProps = StaticScreenProps<{ readonly deploymentId: string }>;

/**
 * Tabs: every tab, app and phone this person may see on the Deployment, from
 * the shared place list web and desktop read — tabs they opened by hand,
 * tasks' and delegated work's tabs, saved tabs and the person's own views —
 * grouped by the computer each is on, in their own order within a group.
 *
 * It is words and marks only. A picture costs a stream per row on a phone
 * that may be on cellular, so the list asks for none; the one page in front
 * is the only picture. A row opens exactly its place, alone. Nothing here
 * chooses a conversation, from who is in a place or from what was in front.
 */
export function TabsScreen(props: TabsScreenProps): ReactNode {
  const { deploymentId } = props.route.params;
  const hostClient = useAttachedHost(deploymentId);
  useSidebarMenu(hostClient);
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

/** One computer's places of one kind, under a header naming both. */
export interface PlaceGroup {
  readonly key: string;
  readonly title: string;
  readonly data: readonly PlaceItem[];
}

/**
 * Places grouped by the computer they are on, and on a Mac its tabs apart
 * from its apps, so an app never passes for a tab. Groups come in the order
 * their first place does, and each keeps the person's own order.
 */
export function placeGroups(places: readonly PlaceItem[]): readonly PlaceGroup[] {
  const groups = new Map<string, { title: string; data: PlaceItem[] }>();
  for (const place of places) {
    const key = `${place.kind}:${place.device?.machineId ?? ""}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { data: [place], title: groupTitle(place) });
    else group.data.push(place);
  }
  return [...groups].map(([key, { data, title }]) => ({ data, key, title }));
}

const kindWord: Record<Exclude<PlaceKind, "phone">, string> = { app: "Apps", browser: "Browser" };

function groupTitle(place: PlaceItem): string {
  const computer = place.device?.name ?? "Computer unavailable";
  return place.kind === "phone"
    ? `Agent Phone · ${computer}`
    : `${computer} · ${kindWord[place.kind]}`;
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
const selectConnection = (snapshot: HostSnapshot) =>
  canRespondToRequests(snapshot) ? null : describeHostConnection(snapshot).label;

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
  const places = usePlaceList(hostClient);
  const loaded = useHostSelector(hostClient, selectLoaded);
  const offline = useHostSelector(hostClient, selectConnection);
  const signInKeys = useHostSelector(hostClient, selectSignIns);
  const [agents, setAgents] = useState(false);
  const withAgents = useMemo(() => places.filter(placeHasAgents), [places]);
  const canOpen = useHostSelector(hostClient, selectCanOpen);
  const openApp = useCallback(
    () => navigation.dispatch(StackActions.push("OpenApp", { deploymentId })),
    [deploymentId, navigation],
  );
  useTabsBar({
    agents,
    filterOffered: agents || withAgents.length > 0,
    onChange: setAgents,
    onOpen: canOpen ? openApp : null,
  });
  const shown = agents ? withAgents : places;
  const sections = useMemo(() => placeGroups(shown), [shown]);
  const signIns = useMemo(() => new Set(signInKeys.split("\n")), [signInKeys]);
  const showProfile = useMemo(() => profileBadgesVisible(places), [places]);
  const open = useCallback(
    (place: PlaceItem) =>
      navigation.dispatch(
        StackActions.push("WorkspaceBrowser", workspaceRoute(deploymentId, place.destination)),
      ),
    [deploymentId, navigation],
  );
  const renderItem = useCallback(
    ({ index, item, section }: SectionListRenderItemInfo<PlaceItem, PlaceGroup>) => (
      <PlaceRow
        first={index === 0}
        hostClient={hostClient}
        last={index === section.data.length - 1}
        needsYou={
          item.destination.kind === "browser" &&
          signIns.has(`${item.destination.sessionId}:${item.destination.tabId}`)
        }
        onOpen={open}
        place={item}
        showProfile={showProfile}
      />
    ),
    [hostClient, open, showProfile, signIns],
  );
  const loading = !loaded && places.length === 0;
  return (
    <Screen edgeToEdge>
      <SectionList<PlaceItem, PlaceGroup>
        contentContainerStyle={[styles.content, column, insets]}
        contentInsetAdjustmentBehavior="automatic"
        keyExtractor={(item) => item.key}
        ListEmptyComponent={
          <View style={styles.empty}>
            <AppText role="bodyMedium" tone={loading ? "muted" : "default"}>
              {loading ? "Finding tabs…" : agents ? "No tasks are using tabs" : "No tabs yet"}
            </AppText>
            {loading ? null : (
              <AppText role="secondary" style={styles.centred} tone="muted">
                {agents
                  ? "Tabs appear here while a task works in them."
                  : "Tabs you and your agents open appear here."}
              </AppText>
            )}
            {loading ? null : agents ? (
              <View style={styles.emptyAction}>
                <SecondaryButton compact label="Show all tabs" onPress={() => setAgents(false)} />
              </View>
            ) : canOpen ? (
              <View style={styles.emptyAction}>
                <SecondaryButton compact label="Open an app" onPress={openApp} />
              </View>
            ) : null}
          </View>
        }
        ListHeaderComponent={
          <>
            <PendingBrowserTabRows hostClient={hostClient} deploymentId={deploymentId} />
            {offline === null && props.failure === null ? null : (
              <View style={styles.notices}>
                {props.failure === null ? null : (
                  <Notice
                    title="Tabs could not be refreshed"
                    detail={props.failure}
                    action={{ label: "Try again", onPress: props.onRetry }}
                  />
                )}
                {offline === null ? null : (
                  <Notice
                    title={offline}
                    detail="Tabs reconnect when the deployment is available."
                    tone="neutral"
                  />
                )}
              </View>
            )}
          </>
        }
        renderItem={renderItem}
        renderSectionHeader={({ section }) => <GroupHead title={section.title} />}
        sections={sections}
        stickySectionHeadersEnabled={false}
      />
    </Screen>
  );
}

/** A computer's name over its places, announced as a heading. */
function GroupHead(props: { readonly title: string }): ReactNode {
  return (
    <View accessibilityLabel={props.title} accessibilityRole="header" style={styles.groupHead}>
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        numberOfLines={1}
        role="caption"
        style={styles.groupTitle}
        tone="muted"
      >
        {props.title}
      </AppText>
    </View>
  );
}

const kindHint: Record<PlaceKind, string> = {
  app: "Opens this app",
  browser: "Opens this tab",
  phone: "Opens this phone",
};

/** Under a row's title: the site, or what kind of place it is, then anything not ordinary. */
function placeDetail(place: PlaceItem, showProfile: boolean): readonly string[] {
  const where =
    place.kind === "browser"
      ? tabSiteLabel(place.site)
      : place.kind === "app"
        ? "Mac app"
        : "Agent Phone";
  const state =
    place.availability === "unavailable"
      ? "Unavailable"
      : place.loading || place.availability === "starting"
        ? "Opening…"
        : null;
  return [where, showProfile ? (place.identity?.name ?? null) : null, state].filter(
    (part): part is string => part !== null && part !== "",
  );
}

interface PlaceRowProps {
  readonly first: boolean;
  readonly hostClient: HostClient;
  readonly last: boolean;
  /** A pending sign-in Request names this very tab. */
  readonly needsYou: boolean;
  readonly onOpen: (place: PlaceItem) => void;
  readonly place: PlaceItem;
  readonly showProfile: boolean;
}

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
  const detail = placeDetail(place, props.showProfile);
  const unavailable = place.availability === "unavailable";
  return (
    <Pressable
      accessibilityHint={kindHint[place.kind]}
      accessibilityLabel={[
        place.title,
        ...detail,
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
        {place.icon.kind === "app" ? (
          <MacAppIcon
            app={place.icon.app}
            hostClient={props.hostClient}
            machineId={place.icon.machineId}
            size={32}
          />
        ) : (
          <View style={styles.glyph}>
            <Symbol
              name={place.kind === "phone" ? "smartphone" : "globe"}
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
 * every tab, or only those agents are in, which the title then names. iOS
 * draws native bar items; Android the same in its own bar. The filter is
 * offered while an agent is in a tab, and while it filters, so the way back
 * is always there.
 */
function useTabsBar(props: {
  readonly agents: boolean;
  readonly filterOffered: boolean;
  readonly onChange: (agents: boolean) => void;
  readonly onOpen: (() => void) | null;
}): void {
  const { agents, filterOffered } = props;
  const navigation = useNavigation();
  const change = useRef(props.onChange);
  change.current = props.onChange;
  const open = useRef(props.onOpen);
  open.current = props.onOpen;
  const openOffered = props.onOpen !== null;
  useLayoutEffect(() => {
    const label = agents ? "Filter, showing tabs with agents" : "Filter";
    const choices: NativeMenuOption[] = [
      { id: "all", label: "All tabs", onPress: () => change.current(false), selected: !agents },
      {
        id: "agents",
        label: "Tabs with agents",
        onPress: () => change.current(true),
        selected: agents,
      },
    ];
    navigation.setOptions({
      title: agents ? "Tabs with agents" : "Tabs",
      headerRight: () => (
        <View style={styles.barItems}>
          {filterOffered ? (
            <NativeMenu
              accessibilityLabel={label}
              onPresent={noop}
              onSettle={noop}
              options={choices}
              style={styles.barItem}
            >
              <Symbol name="line.3.horizontal.decrease" tint={color.ember} />
            </NativeMenu>
          ) : null}
          {openOffered ? (
            <Pressable
              accessibilityHint="Opens an app on your Mac or an Agent Phone"
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
                accessibilityHint: "Opens an app on your Mac or an Agent Phone",
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
                  name: agents
                    ? "line.3.horizontal.decrease.circle.fill"
                    : "line.3.horizontal.decrease.circle",
                  type: "sfSymbol" as const,
                },
                label: "Filter",
                menu: {
                  items: choices.map((choice) => ({
                    label: choice.label,
                    onPress: choice.onPress,
                    state: choice.selected === true ? ("on" as const) : ("off" as const),
                    type: "action" as const,
                  })),
                },
                type: "menu" as const,
              },
            ]
          : []),
      ],
    });
  }, [agents, filterOffered, navigation, openOffered]);
}

/**
 * Whether this person has a Mac or Agent Phone of their own to open things
 * on: one they own, or the Main computer of their Personal deployment.
 */
function selectCanOpen(snapshot: HostSnapshot): boolean {
  return snapshot.machines.some(
    (machine) =>
      machine.computerUse !== undefined &&
      machine.computerUse !== null &&
      (machine.ownership === "mine" ||
        (snapshot.deploymentShape?.kind === "personal" && machine.ownership === "deployment")),
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
  groupHead: { paddingBottom: space[6], paddingHorizontal: space[4], paddingTop: space[16] },
  groupTitle: { fontWeight: "600" },
  mark: { height: 32, width: 32 },
  notices: { gap: space[8], paddingBottom: space[8] },
  pressed: { backgroundColor: color.surfacePressed },
  // One plate per computer, as the platform's grouped lists draw it. Each line
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
