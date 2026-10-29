import {
  canRespondToRequests,
  describeHostConnection,
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
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { SurfaceGrid } from "../browser/surface-grid.js";
import { workspaceRoute } from "../browser/surface-route.js";
import { placeTile, type TabTile } from "../browser/tab-tiles.js";
import { useSidebarMenu } from "../navigation-header.js";
import { space } from "../theme.js";
import { Notice } from "../ui/primitives.js";
import { Screen } from "../ui/screen.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";
import { useAppForeground } from "../ui/foreground.js";

export type TabsScreenProps = StaticScreenProps<{
  readonly deploymentId: string;
  /**
   * The conversation Tabs was opened from — a task, or Chat once it exists —
   * which a tab opened from here talks to. Null where there was none.
   */
  readonly threadId: string | null;
}>;

/**
 * Tabs: every tab, app and phone this person may see on the Deployment, in
 * their own order — tabs they opened by hand, tasks' and delegated work's
 * tabs, saved tabs and the person's own views — from the shared place list
 * web and desktop read. A tile opens exactly its tab, over the conversation
 * Tabs was opened from. Nothing here chooses a conversation from who is in a
 * tab.
 */
export function TabsScreen(props: TabsScreenProps): ReactNode {
  const { deploymentId, threadId } = props.route.params;
  const hostClient = useAttachedHost(deploymentId);
  useSidebarMenu(hostClient);
  if (hostClient === null) return <DeploymentGate deploymentId={deploymentId} />;
  return <AttachedTabs deploymentId={deploymentId} hostClient={hostClient} threadId={threadId} />;
}

const selectReader = (snapshot: HostSnapshot) =>
  snapshot.session === "authenticated" ? (snapshot.user?.id ?? null) : null;

function AttachedTabs(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
  readonly threadId: string | null;
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
      threadId={props.threadId}
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
  readonly threadId: string | null;
}): ReactNode {
  const { deploymentId, hostClient, threadId } = props;
  const navigation = useNavigation();
  const places = usePlaceList(hostClient);
  const sessions = useHostSelector(hostClient, selectSessions);
  const placements = useHostSelector(hostClient, selectPlacements);
  const loaded = useHostSelector(hostClient, selectLoaded);
  const offline = useHostSelector(hostClient, selectConnection);
  const tiles = useMemo(
    () =>
      places.map((place) =>
        placeTile(place, { browserPlacements: placements, browserSessions: sessions }),
      ),
    [placements, places, sessions],
  );
  const open = useCallback(
    (tile: TabTile) =>
      navigation.dispatch(
        StackActions.push(
          "WorkspaceBrowser",
          workspaceRoute(deploymentId, threadId, tile.destination),
        ),
      ),
    [deploymentId, navigation, threadId],
  );
  return (
    <Screen edgeToEdge>
      <SurfaceGrid
        active={props.active && offline === null}
        emptyDetail="Tabs you and your agents open appear here."
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

const styles = StyleSheet.create({
  notices: { gap: space[8] },
});
