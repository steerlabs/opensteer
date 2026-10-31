import {
  canRespondToRequests,
  describeHostConnection,
  placeHasAgents,
  type HostClient,
  type HostSnapshot,
} from "@opensteer/client/host";
import { useHostSelector, usePlaceList } from "@opensteer/client/react";
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
import { StyleSheet, View } from "react-native";
import { SurfaceGrid } from "../browser/surface-grid.js";
import { workspaceRoute } from "../browser/surface-route.js";
import { placeTile, type TabTile } from "../browser/tab-tiles.js";
import { useSidebarMenu } from "../navigation-header.js";
import { color, space, touchTarget } from "../theme.js";
import { NativeMenu, type NativeMenuOption } from "../thread/composer-menu.js";
import { Notice } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { Screen } from "../ui/screen.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";
import { useAppForeground } from "../ui/foreground.js";

export type TabsScreenProps = StaticScreenProps<{ readonly deploymentId: string }>;

/**
 * Tabs: every tab, app and phone this person may see on the Deployment, in
 * their own order — tabs they opened by hand, tasks' and delegated work's
 * tabs, saved tabs and the person's own views — from the shared place list
 * web and desktop read. A tile opens exactly its tab, alone. Nothing here
 * chooses a conversation, from who is in a tab or from what was in front.
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

const selectSessions = (snapshot: HostSnapshot) => snapshot.browserSessions;
const selectPlacements = (snapshot: HostSnapshot) => snapshot.browserPlacements;
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
  const places = usePlaceList(hostClient);
  const sessions = useHostSelector(hostClient, selectSessions);
  const placements = useHostSelector(hostClient, selectPlacements);
  const loaded = useHostSelector(hostClient, selectLoaded);
  const offline = useHostSelector(hostClient, selectConnection);
  const [agents, setAgents] = useState(false);
  const withAgents = useMemo(() => places.filter(placeHasAgents), [places]);
  useAgentsFilter(agents, agents || withAgents.length > 0, setAgents);
  const shown = agents ? withAgents : places;
  const tiles = useMemo(
    () =>
      shown.map((place) =>
        placeTile(place, { browserPlacements: placements, browserSessions: sessions }),
      ),
    [placements, shown, sessions],
  );
  const open = useCallback(
    (tile: TabTile) =>
      navigation.dispatch(
        StackActions.push("WorkspaceBrowser", workspaceRoute(deploymentId, tile.destination)),
      ),
    [deploymentId, navigation],
  );
  return (
    <Screen edgeToEdge>
      <SurfaceGrid
        active={props.active && offline === null}
        empty={
          agents
            ? {
                title: "No tasks are using tabs",
                detail: "Tabs appear here while a task works in them.",
                action: { label: "Show all tabs", onPress: () => setAgents(false) },
              }
            : { title: "No tabs yet", detail: "Tabs you and your agents open appear here." }
        }
        header={
          offline === null && props.failure === null ? undefined : (
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
          )
        }
        hostClient={hostClient}
        loading={!loaded && tiles.length === 0}
        onOpen={open}
        tiles={tiles}
      />
    </Screen>
  );
}

/**
 * The bar's filter: every tab, or only those agents are in, which the title
 * then names. iOS draws a native bar menu; Android the same choices in its own
 * menu. Offered while an agent is in a tab, and while it filters, so the way
 * back is always there.
 */
function useAgentsFilter(
  agents: boolean,
  offered: boolean,
  onChange: (agents: boolean) => void,
): void {
  const navigation = useNavigation();
  const change = useRef(onChange);
  change.current = onChange;
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
      headerRight: () =>
        offered ? (
          <NativeMenu
            accessibilityLabel={label}
            onPresent={noop}
            onSettle={noop}
            options={choices}
            style={styles.filter}
          >
            <Symbol name="line.3.horizontal.decrease" tint={color.ember} />
          </NativeMenu>
        ) : null,
      unstable_headerRightItems: () =>
        offered
          ? [
              {
                accessibilityLabel: label,
                icon: {
                  name: agents
                    ? "line.3.horizontal.decrease.circle.fill"
                    : "line.3.horizontal.decrease.circle",
                  type: "sfSymbol",
                },
                label: "Filter",
                menu: {
                  items: choices.map((choice) => ({
                    label: choice.label,
                    onPress: choice.onPress,
                    state: choice.selected === true ? "on" : "off",
                    type: "action",
                  })),
                },
                type: "menu",
              },
            ]
          : [],
    });
  }, [agents, navigation, offered]);
}

function noop(): void {}

const styles = StyleSheet.create({
  filter: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: touchTarget,
    minWidth: touchTarget,
  },
  notices: { gap: space[8] },
});
