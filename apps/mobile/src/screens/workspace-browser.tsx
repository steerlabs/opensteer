import { PendingBrowserTabView, showPendingBrowserTab } from "../browser/pending-browser-tab.js";
import {
  browserPlaceUnavailableReason,
  canRespondToRequests,
  conversationSurfaces,
  describeHostConnection,
  placeDestinationEnded,
  surfaceDestination,
  threadInDirectory,
  type BrowserTabOpenHandle,
  type HostClient,
  type HostSnapshot,
  type PlaceItem,
  type WorkspaceSurfaceDestination,
} from "@opensteer/client/host";
import { useConversationSurfaces, useHostSnapshot, usePlaceList } from "@opensteer/client/react";
import { CHAT_THREAD_TITLE, type BrowserPageContentPart } from "@opensteer/core";
import { isRecord } from "@opensteer/shared/isRecord";
import { useHeaderHeight } from "@react-navigation/elements";
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
import {
  ActivityIndicator,
  I18nManager,
  KeyboardAvoidingView,
  PanResponder,
  Platform,
  StyleSheet,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from "react-native";
import {
  ReservedRegionsProvider,
  useReservedRegions,
  useReservedRegionsReady,
  type ReservedRegion,
} from "react-native-reserved-regions";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BrowserPage } from "../browser/browser-page.js";
import { SurfaceGrid } from "../browser/surface-grid.js";
import { useSurfaceHeader } from "../browser/surface-header.js";
import {
  routeDestination,
  sameDestination,
  surfaceRoute,
  type SurfacesRoute,
} from "../browser/surface-route.js";
import { surfaceTile, tabSiteLabel, type TabTile } from "../browser/tab-tiles.js";
import { MacAppView } from "../computers/mac-app-view.js";
import { color, headerFontScaleLimit, radius, space } from "../theme.js";
import {
  derivePagePair,
  edgesAround,
  noInsets,
  occlusionClearance,
  surfaceRegions,
  type EdgeInsets,
  type PagePair as PagePairArrangement,
  type Rect,
  type Size,
} from "../layout.js";
import { ThreadPane, type ThreadHeaderState } from "../thread/thread-pane.js";
import { useKeyboardVisible } from "../ui/keyboard.js";
import { InsetView, Pane } from "../ui/pane.js";
import { useMobileState } from "../ui/mobile-client-context.js";
import { AppText, Notice, SecondaryButton } from "../ui/primitives.js";
import { Screen } from "../ui/screen.js";
import { useAppForeground } from "../ui/foreground.js";

/**
 * Tabs, as the route says: a conversation's own grid of tabs and apps, or
 * exactly one tab, app or phone over a conversation's sheet. The route is the
 * selection — a tile pushes the tab it names, Back returns to the grid — so
 * nothing here chooses or swaps what is shown.
 *
 * A focused tab fills the screen above the conversation, folded to its latest
 * reply and its composer, which can be opened over the page to read the rest.
 * Talking to the agent never means leaving the page. A tab opened from Tabs
 * or the sidebar belongs to no conversation and stands alone, so it is
 * exactly the page that was chosen, with nothing folded over it.
 */
export function WorkspaceBrowserScreen({ route }: StaticScreenProps<SurfacesRoute>): ReactNode {
  const { selection } = useMobileState();
  if (selection.deploymentId !== route.params.deploymentId || selection.hostClient === null) {
    return (
      <Screen>
        <Notice
          title="This deployment is no longer open"
          detail="Return to your thread to reconnect."
          tone="neutral"
        />
      </Screen>
    );
  }
  return (
    <Surfaces
      // The conversation is part of what this screen is; the tab is not, so a
      // saved tab moving to its restored session keeps the conversation mounted.
      key={
        route.params.scope === "workspace"
          ? `${route.params.deploymentId}:workspace`
          : `${route.params.deploymentId}:task:${route.params.threadId}`
      }
      hostClient={selection.hostClient}
      route={route.params}
    />
  );
}

function Surfaces(props: {
  readonly hostClient: HostClient;
  readonly route: SurfacesRoute;
}): ReactNode {
  const { snapshot, loadError, reload } = useHostSnapshot(props.hostClient);
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const authorized = snapshot.session === "authenticated" && snapshot.user !== null;
  useEffect(() => {
    if (focused && foreground && authorized) void reload().catch(() => undefined);
  }, [authorized, focused, foreground, reload]);
  if (!authorized)
    return (
      <Screen>
        <Notice
          title={snapshot.session === "checking" ? "Connecting…" : "Sign in to view this page"}
          detail="Return to your thread to continue."
          tone="neutral"
        />
      </Screen>
    );
  // Nothing one person was shown is ever shown to another.
  return (
    <SurfacesForUser
      key={snapshot.user?.id}
      active={focused && foreground}
      hostClient={props.hostClient}
      loadError={loadError}
      reload={reload}
      route={props.route}
      snapshot={snapshot}
    />
  );
}

interface ForUserProps {
  readonly active: boolean;
  readonly hostClient: HostClient;
  readonly loadError: string | null;
  readonly reload: () => Promise<void>;
  readonly route: SurfacesRoute;
  readonly snapshot: HostSnapshot;
}

function SurfacesForUser(props: ForUserProps): ReactNode {
  const { snapshot } = props;
  const connected = canRespondToRequests(snapshot);
  const notices = (
    <>
      {props.loadError ? (
        <Notice
          title="Tabs could not be refreshed"
          detail={props.loadError}
          action={{ label: "Try again", onPress: () => void props.reload().catch(() => undefined) }}
        />
      ) : null}
      {connected ? null : (
        <Notice
          title={describeHostConnection(snapshot).label}
          detail="Tabs reconnect when the deployment is available."
          tone="neutral"
        />
      )}
    </>
  );
  if (props.route.pendingBrowserTab)
    return <PendingBrowserTabView hostClient={props.hostClient} route={props.route} />;
  return props.route.scope === "workspace" ? (
    <WorkspaceTab {...props} connected={connected} notices={notices} />
  ) : (
    <ConversationTabs
      {...props}
      connected={connected}
      notices={notices}
      route={props.route}
      threadId={props.route.threadId}
    />
  );
}

/** A conversation's own tabs: its grid, or one of them over its sheet. */
function ConversationTabs(
  props: ForUserProps & {
    readonly connected: boolean;
    readonly notices: ReactNode;
    readonly threadId: string;
  },
): ReactNode {
  const { hostClient, route, snapshot, threadId } = props;
  const navigation = useNavigation();
  const surfaces = useConversationSurfaces(hostClient, threadId);
  const tiles = useMemo(() => surfaces.map(surfaceTile), [surfaces]);
  const openSurface = useCallback(
    (tile: TabTile) => {
      const item = surfaces.find(({ key }) => key === tile.key);
      if (item === undefined) return;
      navigation.dispatch(
        StackActions.push(
          "WorkspaceBrowser",
          surfaceRoute(route.deploymentId, threadId, surfaceDestination(item)),
        ),
      );
    },
    [navigation, route.deploymentId, surfaces, threadId],
  );
  const destination = routeDestination(route);
  if (destination === null) {
    return (
      <Grid
        active={props.active && props.connected}
        hostClient={hostClient}
        loading={snapshot.deploymentShape === null}
        notices={props.notices}
        onOpen={openSurface}
        title={conversationTitle(snapshot, threadId)}
        tiles={tiles}
      />
    );
  }
  return (
    <Focused
      active={props.active}
      connected={props.connected}
      destination={destination}
      hostClient={hostClient}
      notices={props.notices}
      others={surfaces.some((item) => !sameDestination(surfaceDestination(item), destination))}
      remaining={() =>
        conversationSurfaces(hostClient.getSnapshot(), threadId).some(
          (item) => !sameDestination(surfaceDestination(item), destination),
        )
      }
      route={route}
      snapshot={snapshot}
      threadId={threadId}
    />
  );
}

/**
 * A tab opened from Tabs or the sidebar, alone. A conversation a previous
 * release's route still names is not shown with it.
 */
function WorkspaceTab(
  props: ForUserProps & { readonly connected: boolean; readonly notices: ReactNode },
): ReactNode {
  const { hostClient, route, snapshot } = props;
  const places = usePlaceList(hostClient);
  const destination = routeDestination(route);
  if (destination === null)
    return (
      <Screen>
        <Notice title="This tab isn’t available" detail="Return to Tabs to choose another." />
      </Screen>
    );
  return (
    <Focused
      active={props.active}
      connected={props.connected}
      destination={destination}
      hostClient={hostClient}
      notices={props.notices}
      others={places.some((place) => !sameDestination(place.destination, destination))}
      remaining={() => true}
      route={route}
      snapshot={snapshot}
      threadId={null}
    />
  );
}

/** A conversation's name as its own bar says it, or null before it is known. */
function conversationTitle(snapshot: HostSnapshot, threadId: string): string | null {
  if (snapshot.homeThreadId === threadId) return CHAT_THREAD_TITLE;
  return threadInDirectory(threadId, snapshot)?.title ?? null;
}

function Grid(props: {
  readonly active: boolean;
  readonly hostClient: HostClient;
  readonly loading: boolean;
  readonly notices: ReactNode;
  readonly onOpen: (tile: TabTile) => void;
  readonly tiles: readonly TabTile[];
  /** The conversation these tabs are, said under the bar's title. */
  readonly title: string | null;
}): ReactNode {
  const navigation = useNavigation();
  const { title } = props;
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => null,
      headerTitle: () => <GridTitle subtitle={title} />,
      title: "Tabs",
      unstable_headerRightItems: () => [],
    });
  }, [navigation, title]);
  return (
    <Screen edgeToEdge>
      <SurfaceGrid
        active={props.active}
        emptyDetail="Tabs and apps this conversation uses appear here."
        header={<View style={styles.notices}>{props.notices}</View>}
        hostClient={props.hostClient}
        loading={props.loading && props.tiles.length === 0}
        onOpen={props.onOpen}
        tiles={props.tiles}
      />
    </Screen>
  );
}

/** "Tabs", with the conversation they belong to under it. */
function GridTitle(props: { readonly subtitle: string | null }): ReactNode {
  return (
    <View
      accessibilityLabel={props.subtitle === null ? "Tabs" : `Tabs, ${props.subtitle}`}
      accessible
      style={styles.gridTitle}
    >
      <AppText
        maxFontSizeMultiplier={headerFontScaleLimit}
        numberOfLines={1}
        role="secondaryMedium"
      >
        Tabs
      </AppText>
      {props.subtitle === null ? null : (
        <AppText
          maxFontSizeMultiplier={headerFontScaleLimit}
          numberOfLines={1}
          role="caption"
          tone="muted"
        >
          {props.subtitle}
        </AppText>
      )}
    </View>
  );
}

/**
 * One tab, app or phone over the folded conversation. A page takes its own
 * height at the top and the folded conversation the rest, so a wide page
 * leaves room to read more of it. Typing into the page puts the conversation
 * away until the keyboard is done, so the page has the room.
 */
function Focused(props: {
  readonly active: boolean;
  readonly connected: boolean;
  readonly destination: WorkspaceSurfaceDestination;
  readonly hostClient: HostClient;
  readonly notices: ReactNode;
  /** The grid this tab came from holds others, so it is worth returning to. */
  readonly others: boolean;
  /** Whether the grid still holds another tab, read when this one closes. */
  readonly remaining: () => boolean;
  readonly route: SurfacesRoute;
  readonly snapshot: HostSnapshot;
  /** The conversation the sheet talks to; none for a tab shown alone. */
  readonly threadId: string | null;
}): ReactNode {
  const { destination, hostClient, route, snapshot, threadId } = props;
  const navigation = useNavigation();
  const headerHeight = useHeaderHeight();
  const workspace = route.scope === "workspace";
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState<BrowserPageContentPart | null>(null);
  const [typing, setTyping] = useState(false);
  const [title, setTitle] = useState<string | null>(null);
  // The sheet says whom it talks to in the words its own bar would use.
  const onHeader = useCallback((header: ThreadHeaderState) => setTitle(header.title), []);
  const showGrid = useCallback(() => {
    const state = navigation.getState();
    const below = state?.routes[state.index - 1];
    if (workspace) {
      if (below?.name === "Tabs") navigation.goBack();
      else navigation.dispatch(StackActions.popTo("Tabs", { deploymentId: route.deploymentId }));
      return;
    }
    if (
      below?.name === "WorkspaceBrowser" &&
      isRecord(below.params) &&
      below.params["threadId"] === threadId &&
      below.params["scope"] === undefined &&
      below.params["sessionId"] === undefined &&
      below.params["machineId"] === undefined
    ) {
      navigation.goBack();
      return;
    }
    navigation.dispatch(
      StackActions.replace("WorkspaceBrowser", { deploymentId: route.deploymentId, threadId }),
    );
  }, [navigation, route.deploymentId, threadId, workspace]);
  const onClosed = useCallback(() => {
    if (workspace || props.remaining()) {
      showGrid();
      return;
    }
    // Nothing of this conversation is left to show: back to the conversation
    // itself, past every page and grid of it on the way.
    const state = navigation.getState();
    const index = state?.index ?? 0;
    let depth = 1;
    while (depth <= index && isConversationSurfaces(state?.routes[index - depth], threadId))
      depth += 1;
    navigation.dispatch(StackActions.pop(depth));
  }, [navigation, props, showGrid, threadId, workspace]);
  const onOpenTab = useCallback(
    (opening: BrowserTabOpenHandle) => {
      if (!navigation.isFocused()) {
        void opening.result.catch(() => undefined);
        return;
      }
      showPendingBrowserTab(navigation, route, opening);
    },
    [navigation, route],
  );
  const { body, pageShaped } =
    destination.kind !== "browser"
      ? {
          body: (
            <MacAppView
              active={props.active}
              destination={destination}
              hostClient={hostClient}
              key={JSON.stringify(destination)}
            />
          ),
          pageShaped: false,
        }
      : {
          body: (
            <BrowserTab
              active={props.active}
              connected={props.connected}
              editAddress={route.editAddress === true}
              hostClient={hostClient}
              onBackToTabs={props.others ? showGrid : undefined}
              onClosed={onClosed}
              onOpenTab={onOpenTab}
              onTyping={setTyping}
              onViewing={setPage}
              sessionId={destination.sessionId}
              snapshot={snapshot}
              tabId={destination.tabId}
            />
          ),
          pageShaped: browserShowsPage(snapshot, destination.sessionId, destination.tabId),
        };
  // Built where the arrangement is known: beside the page it is always open.
  const conversation =
    threadId === null
      ? null
      : (open: boolean) => (
          <ThreadPane
            deploymentId={route.deploymentId}
            hostClient={hostClient}
            onHeader={onHeader}
            onOpenThread={(id) =>
              navigation.dispatch(
                StackActions.push("Thread", { deploymentId: route.deploymentId, threadId: id }),
              )
            }
            requestId={null}
            sheet={{
              expanded: open,
              onExpand: setExpanded,
              page: destination.kind === "browser" ? page : null,
            }}
            threadId={threadId}
          />
        );
  return (
    <PagePairSurface
      body={body}
      conversation={conversation}
      conversationTitle={title}
      expanded={expanded}
      keyboardVerticalOffset={headerHeight}
      notices={props.notices}
      onExpand={setExpanded}
      pageShaped={pageShaped}
      typing={typing}
    />
  );
}

/** Whether a browser tab is drawn as a page now: listed by a running browser. */
function browserShowsPage(snapshot: HostSnapshot, sessionId: string, tabId: string): boolean {
  const session = snapshot.browserSessions.find(({ id }) => id === sessionId);
  return (
    session !== undefined &&
    session.state !== "closed" &&
    session.state !== "failed" &&
    !(session.state === "ready" && !tabListed(session, tabId))
  );
}

function tabListed(session: HostSnapshot["browserSessions"][number], tabId: string): boolean {
  return (
    session.tabCatalog?.tabs.some((tab) => tab.id === tabId) ??
    session.tabs.some((tab) => tab.id === tabId)
  );
}

/**
 * One browser tab, found by its own id as the web finds it: live in its
 * browser, saved and restoring through the shared activation, or ended. A
 * saved tab's lineage moving to a new session moves the route with it; the
 * tab is the same, so nothing else changes.
 */
function BrowserTab(props: {
  readonly active: boolean;
  readonly connected: boolean;
  readonly editAddress: boolean;
  readonly hostClient: HostClient;
  /** Offered when the grid holds other tabs. */
  readonly onBackToTabs: (() => void) | undefined;
  readonly onClosed: () => void;
  readonly onOpenTab: (opening: BrowserTabOpenHandle) => void;
  readonly onTyping: (typing: boolean) => void;
  readonly onViewing: (page: BrowserPageContentPart | null) => void;
  readonly sessionId: string;
  readonly snapshot: HostSnapshot;
  readonly tabId: string;
}): ReactNode {
  const { hostClient, snapshot, tabId } = props;
  const navigation = useNavigation();
  const places = usePlaceList(hostClient);
  const place =
    places.find(
      (candidate) =>
        candidate.destination.kind === "browser" && candidate.destination.tabId === tabId,
    ) ?? null;
  const saved = place?.workspaceTab;
  const lineageSession =
    saved?.state === "live" && place?.destination.kind === "browser"
      ? place.destination.sessionId
      : null;
  // The session that shows this tab: its lineage's live one, else the route's.
  const sessionId = lineageSession ?? props.sessionId;
  useLayoutEffect(() => {
    if (lineageSession !== null && lineageSession !== props.sessionId)
      navigation.setParams({ sessionId: lineageSession });
  }, [lineageSession, navigation, props.sessionId]);

  const currentPage = useRef<string | null>(null);
  const pageKey = `${sessionId}:${tabId}`;
  currentPage.current = pageKey;
  useEffect(() => {
    currentPage.current = pageKey;
    return () => {
      if (currentPage.current === pageKey) currentPage.current = null;
    };
  }, [pageKey]);

  const session = snapshot.browserSessions.find(({ id }) => id === sessionId) ?? null;
  const live = session !== null && browserShowsPage(snapshot, sessionId, tabId);
  const restorable = saved !== undefined && saved.state !== "live";
  const unknown =
    !live &&
    !restorable &&
    place === null &&
    snapshot.workspaceTabRestoreVersion === 1 &&
    !placeDestinationEnded(snapshot, { kind: "browser", sessionId, tabId });
  const lookup = useBoundedLineageRead(hostClient, unknown, sessionId, tabId);
  const onClosed = () => {
    if (currentPage.current === pageKey && navigation.isFocused()) props.onClosed();
  };

  if (live && session !== null)
    return (
      <BrowserPage
        active={props.active}
        connected={props.connected}
        hostClient={hostClient}
        key={pageKey}
        editAddress={props.editAddress}
        onClosed={onClosed}
        onOpenTab={props.onOpenTab}
        onTyping={props.onTyping}
        onViewing={props.onViewing}
        session={session}
        tabId={tabId}
        workspaceName={
          snapshot.workspaces.find(({ id }) => id === session.workspaceId)?.name ?? "this workspace"
        }
      />
    );
  if (restorable && place !== null)
    return (
      <SavedTab
        connected={props.connected}
        hostClient={hostClient}
        key={tabId}
        onClosed={onClosed}
        place={place}
        snapshot={snapshot}
        tabId={tabId}
      />
    );
  if (unknown && lookup.closed !== true)
    return (
      <TabStatus
        {...(lookup.error === null
          ? {}
          : { action: { label: "Try again", onPress: lookup.retry } })}
        title={
          lookup.error ??
          (lookup.closed === null ? "Looking for this tab…" : "This tab isn’t available here")
        }
        waiting={lookup.error === null && lookup.closed === null}
      />
    );
  return (
    <BrowserEnded
      detail={session?.state === "failed" ? session.error : null}
      failed={session?.state === "failed"}
      onBackToTabs={props.onBackToTabs}
    />
  );
}

/**
 * A lineage the bounded catalog leaves out, read once, as the web reads it:
 * true when the Host says the tab is gone, false when it still lists it or
 * cannot say, null while it is being asked. Nothing is chosen in its place.
 */
function useBoundedLineageRead(
  hostClient: HostClient,
  unknown: boolean,
  sessionId: string,
  tabId: string,
): { readonly closed: boolean | null; readonly error: string | null; readonly retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [answer, setAnswer] = useState<{
    readonly key: string;
    readonly attempt: number;
    readonly closed: boolean | null;
    readonly error: string | null;
  } | null>(null);
  const asked = useRef<{
    readonly key: string;
    readonly attempt: number;
    readonly hostClient: HostClient;
    readonly promise: ReturnType<NonNullable<HostClient["readWorkspaceTabs"]>>;
  } | null>(null);
  const key = `${sessionId}:${tabId}`;
  useEffect(() => {
    if (!unknown || hostClient.readWorkspaceTabs === undefined) return;
    if (
      asked.current?.key !== key ||
      asked.current.attempt !== attempt ||
      asked.current.hostClient !== hostClient
    )
      asked.current = {
        key,
        attempt,
        hostClient,
        promise: hostClient.readWorkspaceTabs(sessionId),
      };
    let cancelled = false;
    // A restarted effect observes the same request rather than abandoning it.
    void asked.current.promise
      .then((lineage) => {
        if (cancelled) return;
        const listed = lineage?.tabs === undefined || lineage.tabs.some(({ id }) => id === tabId);
        setAnswer({ closed: lineage === null || !listed, error: null, attempt, key });
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setAnswer({
            closed: null,
            error: error instanceof Error ? error.message : "This tab could not be found.",
            attempt,
            key,
          });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, hostClient, key, sessionId, tabId, unknown]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const current = answer?.key === key && answer.attempt === attempt ? answer : null;
  return {
    closed: hostClient.readWorkspaceTabs === undefined ? false : (current?.closed ?? null),
    error: current?.error ?? null,
    retry,
  };
}

/**
 * A saved tab, restored on its saved computer through the client's one
 * activation owner (`activateWorkspaceTab`), which waits for the connection
 * and the computer and keeps one attempt per tab. Opening it asks once; a
 * lasting reason asks never. The answer moves the route to the restored
 * session; one that arrives after the person left changes nothing.
 */
function SavedTab(props: {
  readonly connected: boolean;
  readonly hostClient: HostClient;
  readonly onClosed: () => void;
  readonly place: PlaceItem;
  readonly snapshot: HostSnapshot;
  readonly tabId: string;
}): ReactNode {
  const { hostClient, place, snapshot, tabId } = props;
  const navigation = useNavigation();
  const placement = snapshot.browserPlacements.find(
    ({ runnerId }) => runnerId === place.device?.machineId,
  );
  const lasting = browserPlaceUnavailableReason(
    place.identity,
    place.workspaceTab?.unavailableReason,
    placement?.unavailableReason,
  );
  const [failure, setFailure] = useState<string | null>(null);
  const [closeFailure, setCloseFailure] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const closingNow = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const activate = hostClient.activateWorkspaceTab;
  useLayoutEffect(() => {
    if (activate === undefined || lasting !== null) return;
    let cancelled = false;
    setFailure(null);
    void activate
      .call(hostClient, tabId)
      .then((result) => {
        if (cancelled || result === null) return;
        navigation.setParams({ sessionId: result.session.id, tabId: result.tabId });
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setFailure(error instanceof Error ? error.message : "This tab could not reopen.");
      });
    return () => {
      cancelled = true;
    };
  }, [activate, attempt, hostClient, lasting, navigation, tabId]);
  const close = () => {
    if (closingNow.current) return;
    closingNow.current = true;
    setClosing(true);
    setCloseFailure(null);
    void hostClient
      .closeWorkspaceTabs([tabId])
      .then((result) => {
        if (result.closed.includes(tabId)) props.onClosed();
        else
          throw new Error(
            result.failed.find((item) => item.tabId === tabId)?.message ??
              "This tab could not be closed.",
          );
      })
      .catch((error: unknown) =>
        setCloseFailure(error instanceof Error ? error.message : "This tab could not be closed."),
      )
      .finally(() => {
        closingNow.current = false;
        setClosing(false);
      });
  };
  useSurfaceHeader({
    acting: false,
    glyph: "globe",
    menu: [
      {
        destructive: true,
        disabled: !props.connected || closing,
        icon: "xmark",
        id: "close",
        label: "Close tab",
        onPress: close,
      },
    ],
    secondary: tabSiteLabel(place.site),
    title: place.title,
  });
  const waitingFor =
    !props.connected || placement?.available !== true
      ? `Waiting for ${place.device?.name ?? "its computer"}…`
      : null;
  return closeFailure !== null ? (
    <TabStatus title={closeFailure} action={{ label: "Try again", onPress: close }} />
  ) : lasting !== null ? (
    <TabStatus title={lasting} />
  ) : failure !== null ? (
    <TabStatus
      action={{ label: "Try again", onPress: () => setAttempt((value) => value + 1) }}
      title={failure}
    />
  ) : (
    <TabStatus title={waitingFor ?? "Opening…"} waiting />
  );
}

/** What a tab with no picture says, centred where the page would be. */
function TabStatus(props: {
  readonly action?: { readonly label: string; readonly onPress: () => void };
  readonly title: string;
  readonly waiting?: boolean;
}): ReactNode {
  return (
    <View accessibilityLiveRegion="polite" style={styles.ended}>
      {props.waiting === true ? <ActivityIndicator color={color.muted} /> : null}
      <AppText role="bodyMedium" style={styles.centred}>
        {props.title}
      </AppText>
      {props.action === undefined ? null : (
        <SecondaryButton label={props.action.label} onPress={props.action.onPress} />
      )}
    </View>
  );
}

/**
 * The page and its conversation, in the pair's own surface: stacked, the
 * conversation a sheet under the page; side by side, the page leading; or
 * tabletop, the page above a fold and the conversation below. This view
 * measures its own surface and the regions reserved in it — its origin is
 * under the navigation bar, not the window's — and is the only thing that
 * decides which.
 *
 * Every arrangement is the same three children in the same order, so the
 * page's live channel and the conversation's transcript, draft and stream
 * stay mounted through a fold. The reader's choice to open or fold the sheet
 * is kept for when the pair is stacked again; beside the page there is room
 * for all of the conversation, so it is open there.
 *
 * The keyboard belongs to whichever pane is typing: the page while its address
 * or the remote page's keyboard is up, the conversation otherwise. Only that
 * pane makes room for it. In tabletop the conversation is under the fold, where
 * the keyboard comes up, so while the composer is typing the page gives up its
 * half rather than leave the composer no room.
 */
function PagePairSurface(props: {
  readonly body: ReactNode;
  /**
   * The conversation, open or folded as this arrangement draws it; null for a
   * tab opened directly from Tabs or the sidebar.
   */
  readonly conversation: ((open: boolean) => ReactNode) | null;
  /** The conversation's name, so the sheet says whom it talks to. */
  readonly conversationTitle: string | null;
  readonly expanded: boolean;
  readonly keyboardVerticalOffset: number;
  readonly notices: ReactNode;
  readonly onExpand: (expanded: boolean) => void;
  readonly pageShaped: boolean;
  readonly typing: boolean;
}): ReactNode {
  const [bounds, setBounds] = useState<Size>({ height: 0, width: 0 });
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { height, width } = event.nativeEvent.layout;
    setBounds((current) =>
      current.height === height && current.width === width ? current : { height, width },
    );
  }, []);
  if (props.conversation === null)
    return (
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        enabled={props.typing}
        keyboardVerticalOffset={props.keyboardVerticalOffset}
        style={styles.fill}
        testID="page-slot"
      >
        <InsetView style={styles.fill} testID="page-content">
          {props.notices}
          <View style={props.pageShaped ? styles.page : styles.fill}>{props.body}</View>
        </InsetView>
      </KeyboardAvoidingView>
    );
  return (
    <ReservedRegionsProvider onLayout={onLayout} style={styles.fill}>
      <PagePair {...props} bounds={bounds} conversation={props.conversation} />
    </ReservedRegionsProvider>
  );
}

function PagePair(
  props: Parameters<typeof PagePairSurface>[0] & {
    readonly bounds: Size;
    readonly conversation: (open: boolean) => ReactNode;
  },
): ReactNode {
  const { bounds, expanded, pageShaped, typing } = props;
  const regions = useReservedRegions();
  const ready = useReservedRegionsReady();
  const { fontScale } = useWindowDimensions();
  const keyboard = useKeyboardVisible();
  const rtl = I18nManager.isRTL;
  // The pair's own safe area, measured where the pair is: what a pane at each
  // edge cannot use, so a fit is judged on the room the panes really have.
  const insets = useSafeAreaInsets();
  const previous = useRef<PagePairArrangement>({ mode: "stacked" });
  const { pair, region } = derivePagePair({
    bounds,
    fontScale,
    insets,
    previous: previous.current,
    ready,
    regions,
    rtl,
  });
  useLayoutEffect(() => {
    previous.current = pair;
  });
  // The folded conversation's height, held while it is open so the page under
  // it keeps its size rather than reflowing behind the sheet.
  const [foldedHeight, setFoldedHeight] = useState(0);

  const stacked = pair.mode === "stacked";
  // Tabletop, with the composer typing under the fold.
  const yielding = pair.mode === "tabletop" && keyboard && !typing;
  const { pageClearance, conversationClearance } = pairClearances(
    bounds,
    regions,
    yielding ? { mode: "stacked" } : pair,
    region,
    rtl,
  );
  // Off every fold the arrangement is not split at: the pair is drawn in its region.
  const around = edgesAround(bounds, region, rtl);
  const placed = {
    paddingBottom: around.bottom,
    paddingEnd: around.end,
    paddingStart: around.start,
    paddingTop: around.top,
  };
  // Changes exactly when a pane moves, so whatever was aimed at the old place
  // (a touch held on the page) is let go.
  const geometry = `${pair.mode}:${
    pair.mode === "side" ? pair.pageWidth : pair.mode === "tabletop" ? pair.pageHeight : 0
  }:${region.x},${region.y},${region.width},${region.height}:${yielding ? "yielding" : "set"}`;

  const pageStyle =
    pair.mode === "side"
      ? { width: pair.pageWidth }
      : pair.mode === "tabletop"
        ? yielding
          ? { flexShrink: 1, maxHeight: pair.pageHeight, minHeight: 0 }
          : { height: pair.pageHeight }
        : pageShaped
          ? styles.page
          : styles.fill;
  const gapStyle =
    pair.mode === "side"
      ? { width: pair.gap }
      : pair.mode === "tabletop" && !yielding
        ? { height: pair.gap }
        : null;
  const conversationStyle =
    pair.mode === "side"
      ? styles.besidePage
      : pair.mode === "tabletop"
        ? yielding
          ? styles.underKeyboard
          : styles.belowFold
        : [
            expanded ? styles.sheetOpen : styles.sheet,
            !expanded && pageShaped && styles.sheetFills,
            typing && styles.hidden,
          ];
  const behavior = Platform.OS === "ios" ? "padding" : "height";
  return (
    <View
      style={[styles.fill, pair.mode === "side" ? styles.row : null, placed]}
      testID={`pair-${pair.mode}`}
    >
      <KeyboardAvoidingView
        behavior={behavior}
        enabled={typing}
        keyboardVerticalOffset={props.keyboardVerticalOffset}
        style={pageStyle}
        testID="page-slot"
      >
        <Pane clearance={pageClearance} geometry={`${geometry}:page`} style={styles.fill}>
          {/* The page's own controls and picture keep to the pane's insets: its
              address, its dialogs and the remote picture a tap is mapped into. */}
          <InsetView style={styles.fill} testID="page-content">
            {props.notices}
            <View style={pageShaped ? styles.page : styles.fill}>{props.body}</View>
          </InsetView>
        </Pane>
      </KeyboardAvoidingView>
      <View style={gapStyle} />
      {stacked && expanded ? <View style={{ height: foldedHeight }} /> : null}
      <KeyboardAvoidingView
        behavior={behavior}
        enabled={!typing}
        keyboardVerticalOffset={props.keyboardVerticalOffset}
        onLayout={
          stacked && !expanded
            ? (event: LayoutChangeEvent) => setFoldedHeight(event.nativeEvent.layout.height)
            : undefined
        }
        style={conversationStyle}
        testID="conversation-slot"
      >
        <Pane
          clearance={conversationClearance}
          geometry={`${geometry}:conversation`}
          style={styles.fill}
        >
          {stacked ? (
            <Grabber
              expanded={expanded}
              onExpand={props.onExpand}
              title={props.conversationTitle}
            />
          ) : (
            <ConversationName title={props.conversationTitle} />
          )}
          {props.conversation(!stacked || expanded)}
        </Pane>
      </KeyboardAvoidingView>
    </View>
  );
}

/** What the pair's reserved regions ask of each pane's edges, in its own place. */
function pairClearances(
  bounds: Size,
  regions: readonly ReservedRegion[],
  pair: PagePairArrangement,
  region: Rect,
  rtl: boolean,
): { readonly conversationClearance: EdgeInsets; readonly pageClearance: EdgeInsets } {
  if (bounds.width <= 0 || bounds.height <= 0)
    return { conversationClearance: noInsets, pageClearance: noInsets };
  const { occlusions } = surfaceRegions(bounds, regions);
  if (occlusions.length === 0) return { conversationClearance: noInsets, pageClearance: noInsets };
  if (pair.mode === "side") {
    const conversationWidth = region.width - pair.pageWidth - pair.gap;
    const page = {
      ...region,
      width: pair.pageWidth,
      x: rtl ? region.x + region.width - pair.pageWidth : region.x,
    };
    const conversation = {
      ...region,
      width: conversationWidth,
      x: rtl ? region.x : region.x + pair.pageWidth + pair.gap,
    };
    return {
      conversationClearance: occlusionClearance(conversation, occlusions),
      pageClearance: occlusionClearance(page, occlusions),
    };
  }
  if (pair.mode === "tabletop") {
    const top = pair.pageHeight + pair.gap;
    return {
      conversationClearance: occlusionClearance(
        { ...region, height: region.height - top, y: region.y + top },
        occlusions,
      ),
      pageClearance: occlusionClearance({ ...region, height: pair.pageHeight }, occlusions),
    };
  }
  // Stacked — or tabletop giving way to the keyboard — each pane's place moves
  // with its content, so both clear the whole region.
  const clearance = occlusionClearance(region, occlusions);
  return { conversationClearance: clearance, pageClearance: clearance };
}

/**
 * The sheet's handle: a tap opens or folds the conversation, and so does a
 * drag up or down. One responder owns both, so a drag is never also a tap.
 */
function Grabber(props: {
  readonly expanded: boolean;
  readonly onExpand: (expanded: boolean) => void;
  readonly title: string | null;
}): ReactNode {
  const { expanded, onExpand } = props;
  const current = useRef({ expanded, onExpand });
  current.current = { expanded, onExpand };
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderRelease: (_event, gesture) => {
          const { expanded: open, onExpand: expand } = current.current;
          if (Math.abs(gesture.dy) < 8) expand(!open);
          else expand(gesture.dy < 0);
        },
      }),
    [],
  );
  const conversation = props.title === null ? "the conversation" : props.title;
  return (
    <View
      accessibilityActions={[{ name: "activate" }]}
      accessibilityLabel={`${expanded ? "Hide" : "Show"} ${conversation}`}
      accessibilityRole="button"
      accessible
      onAccessibilityAction={() => onExpand(!expanded)}
      style={styles.grabberZone}
      {...responder.panHandlers}
    >
      <View style={styles.grabber} />
      <ConversationName title={props.title} />
    </View>
  );
}

/**
 * Whom the sheet talks to, in the conversation's own name: a tab can be
 * opened over any conversation, and the composer under it says nothing else.
 */
function ConversationName(props: { readonly title: string | null }): ReactNode {
  if (props.title === null) return null;
  return (
    <View style={styles.conversationName} testID="conversation-name">
      <AppText
        maxFontSizeMultiplier={headerFontScaleLimit}
        numberOfLines={1}
        role="caption"
        tone="muted"
      >
        {props.title}
      </AppText>
    </View>
  );
}

/**
 * A tab that is gone stays gone: one line says so, with why when it failed,
 * and the grid is offered only when it holds others. Nothing takes its place.
 */
function BrowserEnded(props: {
  readonly detail: string | null;
  readonly failed: boolean;
  readonly onBackToTabs: (() => void) | undefined;
}): ReactNode {
  useSurfaceHeader({ acting: false, glyph: "globe", menu: [], secondary: null, title: "Tab" });
  return (
    <View accessibilityLiveRegion="polite" style={styles.ended}>
      <AppText role="bodyMedium" style={styles.centred}>
        {props.failed ? "This page stopped working" : "This tab was closed"}
      </AppText>
      {props.failed && props.detail ? (
        <AppText role="secondary" style={styles.centred} tone="muted">
          {props.detail}
        </AppText>
      ) : null}
      {props.onBackToTabs === undefined ? null : (
        <SecondaryButton label="Back to tabs" onPress={props.onBackToTabs} />
      )}
    </View>
  );
}

/** A conversation's own grid or tab, as the stack holds it. */
function isConversationSurfaces(
  route: { readonly name: string; readonly params?: object | undefined } | undefined,
  threadId: string | null,
): boolean {
  return (
    route?.name === "WorkspaceBrowser" &&
    isRecord(route.params) &&
    route.params["scope"] === undefined &&
    route.params["threadId"] === threadId
  );
}

const styles = StyleSheet.create({
  // Beside the page, the conversation is a column of its own, edged by one hairline.
  besidePage: {
    backgroundColor: color.background,
    borderColor: color.lineStrong,
    borderStartWidth: StyleSheet.hairlineWidth,
    flex: 1,
  },
  belowFold: { backgroundColor: color.background, flex: 1 },
  centred: { textAlign: "center" },
  conversationName: { alignItems: "center", paddingHorizontal: space[16] },
  ended: {
    alignItems: "center",
    flex: 1,
    gap: space[12],
    justifyContent: "center",
    padding: space[24],
  },
  fill: { flex: 1 },
  grabber: {
    backgroundColor: color.lineHover,
    borderRadius: radius.full,
    height: 5,
    width: 36,
  },
  grabberZone: { alignItems: "center", gap: space[4], justifyContent: "center", minHeight: 44 },
  gridTitle: { alignItems: "center", maxWidth: 240 },
  hidden: { display: "none" },
  notices: { gap: space[8] },
  page: { flexShrink: 1, minHeight: 0 },
  row: { flexDirection: "row" },
  sheet: {
    backgroundColor: color.background,
    borderColor: color.lineStrong,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  // Under a page, the folded conversation takes everything the page leaves,
  // and never less than its own latest line and composer.
  sheetFills: { flexGrow: 1, flexShrink: 0 },
  // Tabletop with the composer typing: the conversation keeps at least its
  // composer and dock, and the page above gives up height to make room.
  underKeyboard: { backgroundColor: color.background, flexGrow: 1, flexShrink: 0 },
  // Open over the page, leaving its top in view: the page is still there.
  sheetOpen: {
    backgroundColor: color.background,
    borderColor: color.lineStrong,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderTopWidth: StyleSheet.hairlineWidth,
    bottom: 0,
    elevation: 12,
    left: 0,
    position: "absolute",
    right: 0,
    shadowColor: "#000",
    shadowOffset: { height: -4, width: 0 },
    shadowOpacity: 0.45,
    shadowRadius: 16,
    top: "14%",
  },
});
