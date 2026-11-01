import { PendingBrowserTabView, showPendingBrowserTab } from "../browser/pending-browser-tab.js";
import {
  browserPlaceUnavailableReason,
  canRespondToRequests,
  describeHostConnection,
  mainWorkspace,
  placeAgents,
  placeDestinationEnded,
  samePlaceAgents,
  type BrowserTabOpenHandle,
  type HostClient,
  type HostSnapshot,
  type PlaceItem,
  type WorkspaceSurfaceDestination,
} from "@opensteer/client/host";
import { useHostSelector, useHostSnapshot, usePlaceList } from "@opensteer/client/react";
import type { BrowserPageContentPart } from "@opensteer/core";
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
  Platform,
  Pressable,
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
import { PageBar, type AskTarget } from "../browser/page-bar.js";
import { useSurfaceHeader } from "../browser/surface-header.js";
import {
  paramsDestination,
  routeDestination,
  sameDestination,
  type SurfacesRoute,
} from "../browser/surface-route.js";
import { tabSiteLabel } from "../browser/site-label.js";
import { newTaskDraftKey } from "../client/thread-drafts.js";
import { MacAppView } from "../computers/mac-app-view.js";
import { color, headerFontScaleLimit, space, touchTarget } from "../theme.js";
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
import { useMobileClient, useMobileState } from "../ui/mobile-client-context.js";
import { AppText, Notice, SecondaryButton } from "../ui/primitives.js";
import { Screen } from "../ui/screen.js";
import { Symbol } from "../ui/symbol.js";
import { useAppForeground } from "../ui/foreground.js";
import { NewTaskPane } from "./new-task.js";

/**
 * Exactly one tab, Mac app or phone, as the route names it: the native bar,
 * the page, and one bar under it with who is here and Ask. The route is the
 * selection, so nothing here chooses or swaps what is shown.
 *
 * How the page was reached — from a conversation, from Tabs, from the sidebar
 * — changes only where Back goes, which is the stack's own business. Who is in
 * the page comes from its occupants alone. Where the room fits two panes, the
 * agent's own Thread sits beside the page; on a phone, tapping the agent goes
 * to it.
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
      // A saved tab moving to its restored session is the same page, so the
      // screen stays mounted through it.
      key={route.params.deploymentId}
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

function SurfacesForUser(props: {
  readonly active: boolean;
  readonly hostClient: HostClient;
  readonly loadError: string | null;
  readonly reload: () => Promise<void>;
  readonly route: SurfacesRoute;
  readonly snapshot: HostSnapshot;
}): ReactNode {
  const { route, snapshot } = props;
  const connected = canRespondToRequests(snapshot);
  // One value per place the route names, so the page below is not handed a
  // new destination on every snapshot.
  const destinationKey = JSON.stringify(routeDestination(route));
  const destination = useMemo(
    () => JSON.parse(destinationKey) as WorkspaceSurfaceDestination | null,
    [destinationKey],
  );
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
  if (route.pendingBrowserTab)
    return <PendingBrowserTabView hostClient={props.hostClient} route={route} />;
  // A previous release's route for a conversation's grid of tabs names no
  // place; there is no grid any more, and nothing is picked in its place.
  if (destination === null)
    return (
      <Screen>
        <Notice title="This tab isn’t available" detail="Return to Tabs to choose another." />
      </Screen>
    );
  return (
    <Focused
      active={props.active}
      connected={connected}
      destination={destination}
      hostClient={props.hostClient}
      notices={notices}
      route={route}
      snapshot={snapshot}
    />
  );
}

/** What is beside the page: a Thread, or a task being started from it. */
type Companion = { readonly kind: "thread"; readonly threadId: string } | { readonly kind: "task" };

const selectHomeThreadId = (snapshot: HostSnapshot) => snapshot.homeThreadId;

/**
 * One tab, app or phone, its bar, and — where a pair fits — a second pane.
 * Typing into the page puts the bar away until the keyboard is done, so the
 * page has the room.
 */
function Focused(props: {
  readonly active: boolean;
  readonly connected: boolean;
  readonly destination: WorkspaceSurfaceDestination;
  readonly hostClient: HostClient;
  readonly notices: ReactNode;
  readonly route: SurfacesRoute;
  readonly snapshot: HostSnapshot;
}): ReactNode {
  const { destination, hostClient, route, snapshot } = props;
  const { deploymentId } = route;
  const navigation = useNavigation();
  const headerHeight = useHeaderHeight();
  const drafts = useMobileClient().drafts;
  const [page, setPage] = useState<BrowserPageContentPart | null>(null);
  const [typing, setTyping] = useState(false);
  // The beside Thread's name as its own bar would say it, kept with whose it
  // is so another Thread never wears it while its own is on the way.
  const [named, setNamed] = useState<{ readonly threadId: string; readonly title: string } | null>(
    null,
  );

  // Who is here, from this place's occupants alone. A saved tab is found by
  // its own id, wherever its lineage lives now.
  const places = usePlaceList(hostClient);
  const place = useMemo(
    () => places.find((candidate) => samePlace(candidate, destination)) ?? null,
    [destination, places],
  );
  const occupied = useMemo(
    () => ({ destination, occupants: place?.occupants ?? [] }),
    [destination, place?.occupants],
  );
  const selectAgents = useCallback(
    (current: HostSnapshot) => placeAgents(occupied, current),
    [occupied],
  );
  const agents = useHostSelector(hostClient, selectAgents, samePlaceAgents);
  const homeThreadId = useHostSelector(hostClient, selectHomeThreadId);

  // Chosen from the pill's menu or by Ask, and kept until the person closes
  // it; otherwise the acting agent, else the most recent one.
  const [chosen, setChosen] = useState<Companion | null>(null);
  const firstAgent = agents.agents[0]?.threadId ?? null;
  const companion: Companion | null =
    chosen ?? (firstAgent === null ? null : { kind: "thread", threadId: firstAgent });

  const besideId = companion?.kind === "thread" ? companion.threadId : null;
  const onHeader = useCallback(
    (header: ThreadHeaderState) => {
      if (besideId !== null) setNamed({ threadId: besideId, title: header.title });
    },
    [besideId],
  );

  const shownPage = destination.kind === "browser" ? page : null;
  const latest = useRef({ homeThreadId, shownPage });
  latest.current = { homeThreadId, shownPage };

  /**
   * An agent's Thread, as its own screen. The screen directly under this one
   * may be that very Thread — the page was opened from it — and then Back is
   * the way there, not a second copy. Chat is the root under everything, so
   * it is returned to rather than pushed.
   */
  const openThread = useCallback(
    (threadId: string) => {
      const state = navigation.getState();
      const below = state?.routes[state.index - 1];
      if (threadId === latest.current.homeThreadId) {
        if (below?.name === "Home") navigation.goBack();
        else navigation.dispatch(StackActions.popTo("Home", { deploymentId }));
        return;
      }
      if (
        below?.name === "Thread" &&
        isRecord(below.params) &&
        below.params["threadId"] === threadId
      )
        navigation.goBack();
      else navigation.dispatch(StackActions.push("Thread", { deploymentId, threadId }));
    },
    [deploymentId, navigation],
  );
  const showBeside = useCallback((threadId: string) => setChosen({ kind: "thread", threadId }), []);
  /**
   * Ask's page goes on the draft it is for — Chat's, or the new task's — and
   * is this reader's, so it is shown, removed and sent from that draft like
   * the words with it, and survives leaving it unsent. A page Ask cannot name,
   * such as a Mac app's, takes any earlier one off rather than leaving it to
   * stand for what was asked about. Answers whether there is such a draft.
   */
  const putPageOnDraft = useCallback(
    (target: AskTarget): boolean => {
      const { homeThreadId: home, shownPage: included } = latest.current;
      const current = hostClient.getSnapshot();
      const userId = current.user?.id;
      const workspaceId = mainWorkspace(current)?.id;
      const draftKey =
        target === "chat" ? home : workspaceId === undefined ? null : newTaskDraftKey(workspaceId);
      if (userId === undefined || draftKey === null) return false;
      void drafts.writeDraftPage(deploymentId, userId, draftKey, included).catch(() => undefined);
      return true;
    },
    [deploymentId, drafts, hostClient],
  );
  /** Ask, on a phone: that composer's own screen, with the page on its draft. */
  const askAway = useCallback(
    (target: AskTarget) => {
      if (!putPageOnDraft(target)) return;
      const workspaceId = mainWorkspace(hostClient.getSnapshot())?.id;
      if (target === "chat") navigation.dispatch(StackActions.popTo("Home", { deploymentId }));
      else if (workspaceId !== undefined)
        navigation.dispatch(StackActions.push("NewTask", { deploymentId, workspaceId }));
    },
    [deploymentId, hostClient, navigation, putPageOnDraft],
  );
  /** Ask, where a pair fits: the composer opens beside the page, with the page on its draft. */
  const askBeside = useCallback(
    (target: AskTarget) => {
      if (!putPageOnDraft(target)) return;
      const home = latest.current.homeThreadId;
      if (target === "task") setChosen({ kind: "task" });
      else if (home !== null) setChosen({ kind: "thread", threadId: home });
    },
    [putPageOnDraft],
  );
  const closeCompanion = useCallback(() => setChosen(null), []);
  const onStarted = useCallback(
    (threadId: string) => {
      setChosen({ kind: "thread", threadId });
      return navigation.isFocused();
    },
    [navigation],
  );

  /**
   * Back from a page that closed, past every page under it that has ended
   * too: each was opened from the screen below it, which is where the person
   * is going.
   */
  const onClosed = useCallback(() => {
    const state = navigation.getState();
    const index = state?.index ?? 0;
    const current = hostClient.getSnapshot();
    let depth = 1;
    while (depth <= index) {
      const below = state?.routes[index - depth];
      const ended = below?.name === "WorkspaceBrowser" ? paramsDestination(below.params) : null;
      if (ended === null || !placeDestinationEnded(current, ended)) break;
      depth += 1;
    }
    navigation.dispatch(StackActions.pop(depth));
  }, [hostClient, navigation]);
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
              onClosed={onClosed}
              onOpenTab={onOpenTab}
              onTyping={setTyping}
              onViewing={setPage}
              place={place}
              sessionId={destination.sessionId}
              snapshot={snapshot}
              tabId={destination.tabId}
            />
          ),
          pageShaped: browserShowsPage(snapshot, destination.sessionId, destination.tabId),
        };
  const mainWorkspaceId = mainWorkspace(snapshot)?.id ?? null;
  const second =
    companion === null ? null : companion.kind === "task" ? (
      mainWorkspaceId === null ? null : (
        <NewTaskPane
          autoFocus
          deploymentId={deploymentId}
          hostClient={hostClient}
          key="new-task"
          onStarted={onStarted}
          underHeader={false}
          workspaceId={mainWorkspaceId}
        />
      )
    ) : (
      <ThreadPane
        deploymentId={deploymentId}
        hostClient={hostClient}
        // Another Thread is another conversation: its draft, stream and scroll
        // are its own.
        key={companion.threadId}
        onHeader={onHeader}
        onOpenThread={(id) =>
          navigation.dispatch(StackActions.push("Thread", { deploymentId, threadId: id }))
        }
        requestId={null}
        withPage={{ page: shownPage }}
        threadId={companion.threadId}
      />
    );
  return (
    <PagePairSurface
      body={body}
      bar={(paired) => (
        <PageBar
          agents={agents}
          beside={paired ? besideId : null}
          chat={homeThreadId !== null}
          intent={paired ? "beside" : "open"}
          onAsk={paired ? askBeside : askAway}
          onOpenAgent={paired ? showBeside : openThread}
        />
      )}
      companion={
        second === null
          ? null
          : {
              content: second,
              onClose: chosen === null ? null : closeCompanion,
              title:
                companion?.kind === "task"
                  ? "New task"
                  : named?.threadId === besideId
                    ? named.title
                    : null,
            }
      }
      keyboardVerticalOffset={headerHeight}
      notices={props.notices}
      pageShaped={pageShaped}
      typing={typing}
    />
  );
}

/** Whether a place is the one a route names: a tab by its own id, else exactly. */
function samePlace(place: PlaceItem, destination: WorkspaceSurfaceDestination): boolean {
  if (destination.kind === "browser")
    return place.destination.kind === "browser" && place.destination.tabId === destination.tabId;
  return sameDestination(place.destination, destination);
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
  readonly onClosed: () => void;
  readonly onOpenTab: (opening: BrowserTabOpenHandle) => void;
  readonly onTyping: (typing: boolean) => void;
  readonly onViewing: (page: BrowserPageContentPart | null) => void;
  /** This tab in the place list, found by its own id; null while it is not listed. */
  readonly place: PlaceItem | null;
  readonly sessionId: string;
  readonly snapshot: HostSnapshot;
  readonly tabId: string;
}): ReactNode {
  const { hostClient, place, snapshot, tabId } = props;
  const navigation = useNavigation();
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

/** The second pane beside a page, and how it is closed when the person opened it. */
interface PairCompanion {
  readonly content: ReactNode;
  /** Given when the person chose what is shown; null for the agent shown by default. */
  readonly onClose: (() => void) | null;
  /** Whom the pane talks to, in its own words, once it has said. */
  readonly title: string | null;
}

/**
 * The page and its bar, and the second pane where the surface fits two: side
 * by side, the page leading; or tabletop, the page above a fold and the pane
 * below. Compact, it is the page alone. This view measures its own surface and
 * the regions reserved in it — its origin is under the navigation bar, not the
 * window's — and is the only thing that decides which.
 *
 * The page is always the first child of the same tree, so its live channel
 * stays mounted through a fold, a rotation, and the second pane coming and
 * going. Each pane is given its size by the arrangement, never by measuring
 * the other.
 *
 * The keyboard belongs to whichever pane is typing: the page while its address
 * or the remote page's keyboard is up, the second pane otherwise. Only that
 * pane makes room for it. In tabletop the second pane is under the fold, where
 * the keyboard comes up, so while its composer is typing the page gives up its
 * half rather than leave the composer no room.
 */
function PagePairSurface(props: {
  readonly body: ReactNode;
  /** The bar under the page, told whether a second pane fits beside it. */
  readonly bar: (paired: boolean) => ReactNode;
  readonly companion: PairCompanion | null;
  readonly keyboardVerticalOffset: number;
  readonly notices: ReactNode;
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
  return (
    <ReservedRegionsProvider onLayout={onLayout} style={styles.fill}>
      <PagePair {...props} bounds={bounds} />
    </ReservedRegionsProvider>
  );
}

function PagePair(
  props: Parameters<typeof PagePairSurface>[0] & { readonly bounds: Size },
): ReactNode {
  const { bounds, companion, pageShaped, typing } = props;
  const regions = useReservedRegions();
  const ready = useReservedRegionsReady();
  const { fontScale } = useWindowDimensions();
  const keyboard = useKeyboardVisible();
  const rtl = I18nManager.isRTL;
  // The pair's own safe area, measured where the pair is: what a pane at each
  // edge cannot use, so a fit is judged on the room the panes really have.
  const insets = useSafeAreaInsets();
  const previous = useRef<PagePairArrangement>({ mode: "stacked" });
  const derived = derivePagePair({
    bounds,
    fontScale,
    insets,
    previous: previous.current,
    ready,
    regions,
    rtl,
  });
  useLayoutEffect(() => {
    previous.current = derived.pair;
  });
  const paired = derived.pair.mode !== "stacked";
  // Room for two with nothing to put beside the page: the page takes it all.
  const pair: PagePairArrangement =
    paired && companion !== null ? derived.pair : { mode: "stacked" };
  const region = paired && companion === null ? wholeOf(bounds) : derived.region;
  // Once beside the page, the companion stays mounted through a window too
  // narrow for two, as the page does, so its draft, stream and scroll are
  // there when the pair returns. Out of view it is inert: unseen, untouchable,
  // unreachable by a screen reader, and — told by its pane — claiming nothing
  // and marking nothing read. It keeps the size it had beside the page, so
  // nothing in it is measured afresh. A phone that never pairs never draws it.
  const beside = pair.mode !== "stacked";
  const kept = useRef(false);
  kept.current = companion !== null && (beside || kept.current);
  const besideSize = useRef<Size | null>(null);
  const onCompanionLayout = useCallback((event: LayoutChangeEvent) => {
    const { height, width } = event.nativeEvent.layout;
    besideSize.current = { height, width };
  }, []);

  // Tabletop, with the second pane's composer typing under the fold.
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
        : styles.pageAlone;
  const behavior = Platform.OS === "ios" ? "padding" : "height";
  return (
    <View
      style={[styles.fill, pair.mode === "side" ? styles.row : null, placed]}
      testID={`pair-${derived.pair.mode}`}
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
            <View style={pageShaped ? styles.pageCentred : styles.fill}>{props.body}</View>
            <View style={typing ? styles.hidden : null}>{props.bar(paired)}</View>
          </InsetView>
        </Pane>
      </KeyboardAvoidingView>
      {companion === null || !kept.current ? null : (
        <>
          <View
            style={
              pair.mode === "side"
                ? { width: pair.gap }
                : pair.mode === "stacked" || yielding
                  ? null
                  : { height: pair.gap }
            }
          />
          <KeyboardAvoidingView
            accessibilityElementsHidden={!beside}
            behavior={behavior}
            enabled={beside && !typing}
            importantForAccessibility={beside ? "auto" : "no-hide-descendants"}
            keyboardVerticalOffset={props.keyboardVerticalOffset}
            onLayout={onCompanionLayout}
            pointerEvents={beside ? "auto" : "none"}
            style={
              pair.mode === "side"
                ? styles.besidePage
                : pair.mode === "stacked"
                  ? [styles.outOfView, besideSize.current]
                  : yielding
                    ? styles.underKeyboard
                    : styles.belowFold
            }
            testID="conversation-slot"
          >
            <Pane
              clearance={conversationClearance}
              geometry={`${geometry}:conversation`}
              hidden={!beside}
              style={styles.fill}
            >
              <CompanionName onClose={companion.onClose} title={companion.title} />
              {companion.content}
            </Pane>
          </KeyboardAvoidingView>
        </>
      )}
    </View>
  );
}

function wholeOf(bounds: Size): Rect {
  return { height: bounds.height, width: bounds.width, x: 0, y: 0 };
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
  // The page alone — or tabletop giving way to the keyboard — each pane's
  // place moves with its content, so both clear the whole region.
  const clearance = occlusionClearance(region, occlusions);
  return { conversationClearance: clearance, pageClearance: clearance };
}

/**
 * Whom the pane beside a page talks to, in its own name — the bar above names
 * the page — and, when the person chose it, the way to put it away.
 */
function CompanionName(props: {
  readonly onClose: (() => void) | null;
  readonly title: string | null;
}): ReactNode {
  if (props.title === null && props.onClose === null) return null;
  return (
    <View style={styles.companionName} testID="conversation-name">
      <AppText
        maxFontSizeMultiplier={headerFontScaleLimit}
        numberOfLines={1}
        role="caption"
        style={styles.companionTitle}
        tone="muted"
      >
        {props.title ?? ""}
      </AppText>
      {props.onClose === null ? null : (
        <Pressable
          accessibilityLabel={props.title === null ? "Close" : `Close ${props.title}`}
          accessibilityRole="button"
          hitSlop={space[8]}
          onPress={props.onClose}
          style={styles.close}
        >
          <Symbol name="xmark" size={12} tint={color.muted} />
        </Pressable>
      )}
    </View>
  );
}

/**
 * A tab that is gone stays gone: one line says so, with why when it failed.
 * Nothing takes its place; Back returns to wherever it was opened from.
 */
function BrowserEnded(props: {
  readonly detail: string | null;
  readonly failed: boolean;
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
    </View>
  );
}

const styles = StyleSheet.create({
  // Beside the page, the second pane is a column of its own, edged by one hairline.
  besidePage: {
    backgroundColor: color.background,
    borderColor: color.lineStrong,
    borderStartWidth: StyleSheet.hairlineWidth,
    flex: 1,
  },
  belowFold: { backgroundColor: color.background, flex: 1 },
  centred: { textAlign: "center" },
  close: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: touchTarget,
    minWidth: touchTarget,
  },
  companionName: {
    alignItems: "center",
    flexDirection: "row",
    minHeight: touchTarget,
    paddingHorizontal: space[16],
  },
  companionTitle: { flex: 1, textAlign: "center" },
  ended: {
    alignItems: "center",
    flex: 1,
    gap: space[12],
    justifyContent: "center",
    padding: space[24],
  },
  fill: { flex: 1 },
  hidden: { display: "none" },
  // Laid out, so its native views and scroll position stay, but not drawn.
  outOfView: { left: 0, opacity: 0, position: "absolute", top: 0 },
  // Alone, the page has the whole surface but the bar under it. It has no
  // floor: with the keyboard up on a short screen, a floor is what pushes the
  // page's own address field under the keyboard.
  pageAlone: { flex: 1, minHeight: 0 },
  // The page at its own shape, centred in the room it is given, as a picture
  // is: the bands above and below are even.
  pageCentred: { flex: 1, justifyContent: "center", minHeight: 0 },
  row: { flexDirection: "row" },
  // Tabletop with the composer typing: the second pane keeps at least its
  // composer, and the page above gives up height to make room.
  underKeyboard: { backgroundColor: color.background, flexGrow: 1, flexShrink: 0 },
});
