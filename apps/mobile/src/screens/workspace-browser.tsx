import { contactSupport } from "../report-mail.js";
import { PendingBrowserTabView, showPendingBrowserTab } from "../browser/pending-browser-tab.js";
import {
  browserPlaceUnavailableReason,
  browserThreadAgentTab,
  browserThreadTabs,
  canRespondToRequests,
  describeHostConnection,
  mainWorkspace,
  placeAgents,
  placeAgentState,
  placeDestinationEnded,
  samePlaceAgents,
  transcriptPlaces,
  type BrowserTabDestination,
  type BrowserTabOpenHandle,
  type BrowserThreadTab,
  type BrowserThreadTabs,
  type HostClient,
  type HostSnapshot,
  type PlaceEntry,
  type PlaceItem,
  type WorkspaceSurfaceDestination,
} from "@opensteer/client/host";
import {
  useBrowserAgentFollow,
  useBrowserPopupFollow,
  useHostSelector,
  useHostSnapshot,
  usePlaceList,
} from "@opensteer/client/react";
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
  ActivityIndicator,
  I18nManager,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  TextInput,
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
import { opensteerAppGlyph } from "../browser/agent-surface.js";
import { BrowserPage, type PageFollow, type PagePairChrome } from "../browser/browser-page.js";
import { askChoices, usePageHeader, type AskTarget } from "../browser/page-header.js";
import { CompanionCapsule } from "../browser/pair-chrome.js";
import { Toolbar, ToolbarButton, ToolbarCapsule, ToolbarMenu } from "../browser/toolbar.js";
import {
  pageSite,
  paramsDestination,
  routeDestination,
  sameDestination,
  type SurfacesRoute,
} from "../browser/surface-route.js";
import { tabSiteLabel } from "../browser/site-label.js";
import { newTaskDraftBlank, newTaskDraftId, newTaskDraftKey } from "../client/thread-drafts.js";
import { MacAppView } from "../computers/mac-app-view.js";
import { color, space, touchTarget } from "../theme.js";
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
import { AppFrame } from "../thread/app-frame.js";
import type { NativeMenuOption, NativeMenuSection } from "../thread/composer-menu.js";
import { ThreadPane, type ThreadHeaderState } from "../thread/thread-pane.js";
import { useKeyboardVisible } from "../ui/keyboard.js";
import { InsetView, Pane, useContentInsets } from "../ui/pane.js";
import { useMobileClient, useMobileState } from "../ui/mobile-client-context.js";
import { AppText, Notice, SecondaryButton } from "../ui/primitives.js";
import { Screen } from "../ui/screen.js";
import { Symbol } from "../ui/symbol.js";
import { useAppForeground } from "../ui/foreground.js";
import { NewTaskPane } from "./new-task.js";
import { ThreadTitlePill } from "./thread-header.js";

/**
 * Exactly one tab, Mac app, phone or Opensteer App, as the route names it: the
 * native bar with who is here and Ask, and the place itself with the bar it is
 * used through. The route is the selection, so nothing here chooses or swaps
 * what is shown.
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
type Companion =
  | { readonly kind: "thread"; readonly threadId: string }
  | { readonly draftId: string; readonly kind: "task" };

const selectHomeThreadId = (snapshot: HostSnapshot) => snapshot.homeThreadId;

/**
 * One tab, app or phone with its own bar, and — where a pair fits — a second
 * pane. The place's view makes room for its own keyboard; this screen only
 * hears that it is typing, so the pane being typed in is the one that lifts.
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
  // The beside Thread's header as its own bar would say it, kept with whose it
  // is so another Thread never wears it while its own is on the way.
  const [named, setNamed] = useState<{
    readonly header: ThreadHeaderState;
    readonly threadId: string;
  } | null>(null);

  // Who is here, from this place's occupants alone. A saved tab is found by
  // its own id, wherever its lineage lives now.
  const places = usePlaceList(hostClient);
  const place = useMemo(
    () => places.find((candidate) => samePlace(candidate, destination)) ?? null,
    [destination, places],
  );
  // A closed app keeps its name and its Thread: the bar still says what ended,
  // and Ask still reaches whoever made it.
  const lastApp = useRef<PlaceItem | null>(null);
  if (place?.opensteerApp !== undefined) lastApp.current = place;
  const appThreadId = lastApp.current?.opensteerApp?.threadId ?? null;
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

  const [chosen, setChosen] = useState<Companion | null>(null);
  const [remembered, setRemembered] = useState<string | null | undefined>(undefined);
  const firstAgent = agents.agents[0]?.threadId ?? null;
  if (remembered === undefined && firstAgent !== null) setRemembered(firstAgent);
  const automatic = remembered === undefined ? firstAgent : remembered;
  const companion: Companion | null =
    chosen ?? (automatic === null ? null : { kind: "thread", threadId: automatic });

  const besideId = companion?.kind === "thread" ? companion.threadId : null;
  const onHeader = useCallback(
    (header: ThreadHeaderState) => {
      if (besideId !== null) setNamed({ header, threadId: besideId });
    },
    [besideId],
  );

  const shownPage = destination.kind === "browser" ? page : null;
  const latest = useRef({ appThreadId, homeThreadId, shownPage });
  latest.current = { appThreadId, homeThreadId, shownPage };

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
    (target: AskTarget, taskDraftId: string): boolean => {
      const { appThreadId: origin, homeThreadId: home, shownPage: included } = latest.current;
      const current = hostClient.getSnapshot();
      const userId = current.user?.id;
      const workspaceId = mainWorkspace(current)?.id;
      const draftKey =
        target === "thread"
          ? origin
          : target === "chat"
            ? home
            : workspaceId === undefined
              ? null
              : newTaskDraftKey(taskDraftId);
      if (userId === undefined || draftKey === null) return false;
      if (target === "task" && workspaceId !== undefined) {
        drafts.placeNewTaskDraft(deploymentId, userId, taskDraftId, workspaceId);
      }
      void drafts.writeDraftPage(deploymentId, userId, draftKey, included).catch(() => undefined);
      return true;
    },
    [deploymentId, drafts, hostClient],
  );
  /** Ask, on a phone: that composer's own screen, with the page on its draft. */
  const askAway = useCallback(
    (target: AskTarget) => {
      const draftId = newTaskDraftId();
      if (!putPageOnDraft(target, draftId)) return;
      const { appThreadId: origin } = latest.current;
      const workspaceId = mainWorkspace(hostClient.getSnapshot())?.id;
      if (target === "thread") {
        if (origin !== null) openThread(origin);
      } else if (target === "chat")
        navigation.dispatch(StackActions.popTo("Home", { deploymentId }));
      else if (workspaceId !== undefined)
        navigation.dispatch(StackActions.push("NewTask", { deploymentId, draftId, workspaceId }));
    },
    [deploymentId, hostClient, navigation, openThread, putPageOnDraft],
  );
  /** Ask, where a pair fits: the composer opens beside the page, with the page on its draft. */
  const askBeside = useCallback(
    (target: AskTarget) => {
      const userId = hostClient.getSnapshot().user?.id;
      // A blank draft already beside the page takes this one; one with words waits in the sidebar.
      const draftId =
        chosen?.kind === "task" &&
        userId !== undefined &&
        newTaskDraftBlank(drafts, deploymentId, userId, chosen.draftId)
          ? chosen.draftId
          : newTaskDraftId();
      if (!putPageOnDraft(target, draftId)) return;
      const { appThreadId: origin, homeThreadId: home } = latest.current;
      const threadId = target === "thread" ? origin : home;
      if (target === "task") setChosen({ draftId, kind: "task" });
      else if (threadId !== null) setChosen({ kind: "thread", threadId });
    },
    [chosen, deploymentId, drafts, hostClient, putPageOnDraft],
  );
  const closeCompanion = useCallback(() => {
    setChosen(null);
    setRemembered(null);
  }, []);
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
  // Another tab of the same browser takes this one's place in the route, as
  // Safari's tab swipe does; Back still returns where the page came from.
  const onSwitchTab = useCallback(
    (tabId: string) => navigation.setParams({ editAddress: false, popup: false, tabId }),
    [navigation],
  );
  /**
   * Keeping up with the beside Thread's agent: the route moves in place to
   * whichever tab it is on, until the person moves the page themselves.
   */
  const selectAgentTab = useCallback(
    (current: HostSnapshot) =>
      besideId === null ? null : browserThreadAgentTab(current.browserSessions, besideId),
    [besideId],
  );
  const agentTab = useHostSelector(hostClient, selectAgentTab, sameAgentTab);
  const shownTab = destination.kind === "browser" ? destination : null;
  const followedTo = useRef<BrowserTabDestination | null>(null);
  const onFollow = useCallback(
    (tab: BrowserTabDestination) => {
      followedTo.current = tab;
      navigation.setParams({
        editAddress: false,
        popup: false,
        sessionId: tab.sessionId,
        tabId: tab.tabId,
      });
    },
    [navigation],
  );
  const follow = useBrowserAgentFollow({ agentTab, onFollow, shownTab, threadId: besideId });
  const { pause } = follow;
  // Any other way the tab in front changed — a chip, a swipe, the tab sheet,
  // a suggestion — was the person's. A layout effect, so following stops
  // before the follow hook's own effect sees the new tab and pulls them back.
  const shownTabId = shownTab?.tabId ?? null;
  const lastShown = useRef(shownTabId);
  useLayoutEffect(() => {
    if (lastShown.current === shownTabId) return;
    lastShown.current = shownTabId;
    if (followedTo.current?.tabId !== shownTabId) pause();
  }, [pause, shownTabId]);
  // Over the page that opened it, so Back and its ending both return there.
  const onPopup = useCallback(
    (tabId: string) => {
      pause();
      navigation.dispatch(
        StackActions.push("WorkspaceBrowser", { ...route, editAddress: false, popup: true, tabId }),
      );
    },
    [navigation, pause, route],
  );
  const onShowTabs = useCallback(() => {
    if (destination.kind === "browser")
      navigation.dispatch(
        StackActions.push("BrowserTabs", {
          deploymentId,
          sessionId: destination.sessionId,
          tabId: destination.tabId,
        }),
      );
  }, [deploymentId, destination, navigation]);
  const [paired, setPaired] = useState(false);
  const selectPlaces = useCallback(
    (current: HostSnapshot): readonly PlaceEntry[] => {
      const entries = besideId === null ? undefined : current.transcripts[besideId];
      return entries === undefined ? noPlaces : transcriptPlaces(entries);
    },
    [besideId],
  );
  const besidePlaces = useHostSelector(hostClient, selectPlaces);
  const shownSession =
    shownTab === null
      ? undefined
      : snapshot.browserSessions.find(({ id }) => id === shownTab.sessionId);
  // Kept from one render to the next, so a tab the task used stays its own
  // through a moment no occupant says so.
  const previousTabs = useRef<BrowserThreadTabs | undefined>(undefined);
  const threadTabs =
    besideId === null || shownSession === undefined
      ? null
      : browserThreadTabs(shownSession, besideId, besidePlaces, previousTabs.current);
  useEffect(() => {
    if (threadTabs !== null) previousTabs.current = threadTabs;
  });
  const title =
    place?.title ??
    lastApp.current?.title ??
    shownPage?.title ??
    (destination.kind === "browser" ? "Tab" : "");
  usePageHeader({
    agents,
    asksThread: appThreadId !== null,
    beside: paired ? besideId : null,
    chat: homeThreadId !== null,
    intent: paired ? "beside" : "open",
    onAsk: paired ? askBeside : askAway,
    onOpenAgent: paired ? showBeside : openThread,
    title,
  });
  const mainWorkspaceId = mainWorkspace(snapshot)?.id ?? null;
  const companionShown =
    companion !== null && (companion.kind === "thread" || mainWorkspaceId !== null);
  // Beside a Thread, a page's own bar takes the native bar's place, and Back.
  const pairedChrome = paired && companionShown && destination.kind === "browser";
  useLayoutEffect(() => {
    if (!pairedChrome) return;
    navigation.setOptions({ headerShown: false });
    return () => navigation.setOptions({ headerShown: true });
  }, [navigation, pairedChrome]);
  const others = agents.agents.some(({ threadId }) => threadId !== besideId);
  const pairMenu: NativeMenuSection[] = [
    askChoices({ asksThread: appThreadId !== null, chat: homeThreadId !== null, onAsk: askBeside }),
    others
      ? agents.agents.map((agent) => ({
          id: `beside:${agent.threadId}`,
          label: `${agent.title} · ${placeAgentState(agent)}`,
          onPress: () => showBeside(agent.threadId),
          selected: agent.threadId === besideId,
        }))
      : [],
  ];
  const pair: PagePairChrome | null = pairedChrome
    ? {
        menu: pairMenu,
        onBack: () => navigation.goBack(),
        taskTabIds: threadTabs?.taskTabs.map(({ id }) => id) ?? [],
      }
    : null;
  const agentAway =
    besideId === null ||
    agentTab === null ||
    follow.following ||
    (shownTab !== null &&
      agentTab.tabId === shownTab.tabId &&
      agentTab.sessionId === shownTab.sessionId)
      ? null
      : agentTab;
  const followAgent =
    besideId === null || agentTab === null
      ? null
      : (placeAgents(
          {
            destination: { kind: "browser", sessionId: agentTab.sessionId, tabId: agentTab.tabId },
            occupants: agentTab.tab.occupants.filter(({ threadId }) => threadId === besideId),
          },
          snapshot,
        ).agents[0] ?? null);
  const pageFollow: PageFollow | null =
    besideId === null
      ? null
      : {
          agent: followAgent,
          away:
            agentAway === null
              ? null
              : {
                  title:
                    agentAway.tab.title.trim() || pageSite(agentAway.tab.site) || "another tab",
                },
          following: follow.following,
          onResume: () => void follow.resume(),
        };
  const body =
    destination.kind === "opensteer-app" ? (
      <AppTab
        appId={destination.appId}
        connected={props.connected}
        hostClient={hostClient}
        key={destination.appId}
        onClosed={onClosed}
        onTyping={setTyping}
        title={title}
      />
    ) : destination.kind !== "browser" ? (
      <MacAppView
        active={props.active}
        destination={destination}
        hostClient={hostClient}
        key={JSON.stringify(destination)}
        onClosed={onClosed}
        onTyping={setTyping}
      />
    ) : (
      <BrowserTab
        active={props.active}
        connected={props.connected}
        editAddress={route.editAddress === true}
        follow={pageFollow}
        hostClient={hostClient}
        onClosed={onClosed}
        onOpenTab={onOpenTab}
        onPopup={onPopup}
        onShowTabs={onShowTabs}
        onSteer={pause}
        onSwitchTab={onSwitchTab}
        onTyping={setTyping}
        onViewing={setPage}
        pair={pair}
        place={place}
        popup={route.popup === true}
        sessionId={destination.sessionId}
        snapshot={snapshot}
        tabId={destination.tabId}
      />
    );
  const companionActions = (threadId: string): readonly NativeMenuOption[] => [
    { id: "open", label: "Open as its own screen", onPress: () => openThread(threadId) },
    { icon: "xmark.circle", id: "close", label: "Close", onPress: closeCompanion },
  ];
  const closeOnly: readonly NativeMenuOption[] = [
    { icon: "xmark.circle", id: "close", label: "Close", onPress: closeCompanion },
  ];
  const second: PairCompanion | null =
    companion === null || !companionShown
      ? null
      : companion.kind === "task"
        ? {
            content: () =>
              mainWorkspaceId === null ? null : (
                <NewTaskPane
                  autoFocus
                  deploymentId={deploymentId}
                  draftId={companion.draftId}
                  hostClient={hostClient}
                  key={companion.draftId}
                  onStarted={onStarted}
                  underHeader={false}
                  workspaceId={mainWorkspaceId}
                />
              ),
            floating: false,
            pill: <CompanionCapsule actions={closeOnly} title="New task" />,
          }
        : {
            content: (headerClearance) => (
              <ThreadPane
                deploymentId={deploymentId}
                headerClearance={headerClearance}
                hostClient={hostClient}
                // Another Thread is another conversation: its draft, stream and
                // scroll are its own.
                key={companion.threadId}
                onHeader={onHeader}
                onOpenThread={(id) =>
                  navigation.dispatch(StackActions.push("Thread", { deploymentId, threadId: id }))
                }
                requestId={null}
                withPage={{ page: shownPage }}
                threadId={companion.threadId}
              />
            ),
            floating: true,
            pill:
              named?.threadId === companion.threadId ? (
                <ThreadTitlePill
                  {...named.header}
                  deploymentId={deploymentId}
                  extraActions={companionActions(companion.threadId)}
                  floating
                  hostClient={hostClient}
                  maxWidth={companionPillWidth}
                  onFind={() =>
                    navigation.navigate("ThreadFind", {
                      deploymentId,
                      threadId: companion.threadId,
                    })
                  }
                  onOpenThread={openThread}
                  threadId={companion.threadId}
                />
              ) : (
                <CompanionCapsule
                  actions={companionActions(companion.threadId)}
                  title={
                    agents.agents.find(({ threadId }) => threadId === companion.threadId)?.title ??
                    ""
                  }
                />
              ),
          };
  return (
    <PagePairSurface
      body={body}
      companion={second}
      keyboardVerticalOffset={headerHeight}
      notices={props.notices}
      onPaired={setPaired}
      typing={typing}
    />
  );
}

const noPlaces: readonly PlaceEntry[] = [];
/** Wide enough for a task's name, never wider than a pane beside a page leaves it. */
const companionPillWidth = 320;

/** The agent's tab is the same one, under the same name: nothing to follow or redraw. */
function sameAgentTab(left: BrowserThreadTab | null, right: BrowserThreadTab | null): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.sessionId === right.sessionId &&
      left.tabId === right.tabId &&
      left.tab.title === right.tab.title &&
      left.tab.site === right.tab.site &&
      left.tab.occupants === right.tab.occupants)
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
  readonly follow: PageFollow | null;
  readonly hostClient: HostClient;
  readonly onClosed: () => void;
  readonly onOpenTab: (opening: BrowserTabOpenHandle) => void;
  readonly onPopup: (tabId: string) => void;
  readonly onShowTabs: () => void;
  readonly onSteer: () => void;
  readonly onSwitchTab: (tabId: string) => void;
  readonly onTyping: (typing: boolean) => void;
  readonly onViewing: (page: BrowserPageContentPart | null) => void;
  /** The page's bar in place of the native one, while a Thread is beside it. */
  readonly pair: PagePairChrome | null;
  /** This tab in the place list, found by its own id; null while it is not listed. */
  readonly place: PlaceItem | null;
  readonly popup: boolean;
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
  // Which way the page came from the tab before it, by the browser's own order.
  const shown = useRef<{ readonly arrival: -1 | 0 | 1; readonly tabId: string }>({
    arrival: 0,
    tabId,
  });
  if (shown.current.tabId !== tabId) {
    const order = session === null ? [] : tabOrder(session);
    const from = order.indexOf(shown.current.tabId);
    const to = order.indexOf(tabId);
    shown.current = { arrival: from >= 0 && to >= 0 && to < from ? -1 : 1, tabId };
  }
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
  useBrowserPopupFollow(
    hostClient,
    live && props.active ? { sessionId, tabId } : null,
    props.onPopup,
  );
  const popupEnded =
    props.popup && placeDestinationEnded(snapshot, { kind: "browser", sessionId, tabId });
  const latestClosed = useRef(onClosed);
  latestClosed.current = onClosed;
  useEffect(() => {
    if (popupEnded && props.active) latestClosed.current();
  }, [popupEnded, props.active]);

  if (live && session !== null)
    return (
      <BrowserPage
        active={props.active}
        arrival={shown.current.arrival}
        connected={props.connected}
        follow={props.follow}
        hostClient={hostClient}
        key={pageKey}
        editAddress={props.editAddress}
        onClosed={onClosed}
        onOpenTab={props.onOpenTab}
        onShowTabs={props.onShowTabs}
        onSteer={props.onSteer}
        onSwitchTab={props.onSwitchTab}
        pair={props.pair}
        onTyping={props.onTyping}
        onViewing={props.onViewing}
        session={session}
        tabId={tabId}
        workspaceName={
          snapshot.workspaces.find(({ id }) => id === session.workspaceId)?.name ?? "this workspace"
        }
      />
    );
  return (
    <WithBack onBack={props.pair?.onBack ?? null}>
      {restorable && place !== null ? (
        <SavedTab
          connected={props.connected}
          hostClient={hostClient}
          key={tabId}
          onClosed={onClosed}
          place={place}
          snapshot={snapshot}
          tabId={tabId}
        />
      ) : unknown && lookup.closed !== true ? (
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
      ) : (
        <BrowserEnded
          detail={session?.state === "failed" ? session.error : null}
          failed={session?.state === "failed"}
        />
      )}
    </WithBack>
  );
}

/** A tab with no page to drive, under the one control the put-away native bar took: Back. */
function WithBack(props: {
  readonly children: ReactNode;
  readonly onBack: (() => void) | null;
}): ReactNode {
  if (props.onBack === null) return props.children;
  return (
    <View style={styles.fill}>
      <Toolbar edge="top" testID="page-toolbar">
        <ToolbarButton
          accessibilityHint="Returns to the previous screen"
          label="Back"
          onPress={props.onBack}
          symbol="chevron.left"
        />
      </Toolbar>
      {props.children}
    </View>
  );
}

/** A browser's tab ids in its own order, as its tab strip shows them. */
function tabOrder(session: HostSnapshot["browserSessions"][number]): readonly string[] {
  const catalog = session.tabCatalog?.tabs;
  return catalog === undefined
    ? session.tabs.map(({ id }) => id)
    : [...catalog].sort((a, b) => a.order - b.order).map(({ id }) => id);
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
  const waitingFor =
    !props.connected || placement?.available !== true
      ? `Waiting for ${place.device?.name ?? "its computer"}…`
      : null;
  return (
    <View style={styles.fill}>
      {closeFailure !== null ? (
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
      )}
      {/* The page's own bar, resting until the page is back: only Close works. */}
      <CloseBar closeDisabled={!props.connected || closing} onClose={close}>
        <AppText numberOfLines={1} role="secondaryMedium" tone="muted">
          {tabSiteLabel(place.site) ?? place.title}
        </AppText>
      </CloseBar>
    </View>
  );
}

/** The bar of a place with nothing else to drive: its name, and Close. */
function CloseBar(props: {
  readonly children: ReactNode;
  readonly closeDisabled: boolean;
  readonly onClose: () => void;
  readonly onReport?: () => void;
}): ReactNode {
  return (
    <Toolbar edge="bottom" testID="page-toolbar">
      <ToolbarCapsule style={styles.restingAddress}>{props.children}</ToolbarCapsule>
      <ToolbarMenu
        label="More"
        sections={[
          [
            ...(props.onReport
              ? [{ id: "report", label: "Report…", onPress: props.onReport }]
              : []),
            {
              destructive: true,
              disabled: props.closeDisabled,
              icon: "xmark.circle",
              id: "close",
              label: "Close tab",
              onPress: props.onClose,
            },
          ],
        ]}
        symbol="ellipsis"
      />
    </Toolbar>
  );
}

/**
 * An Opensteer App open as a tab, with the bar every place has. It reads only
 * whether it has ended, so a streamed token never reaches its WebView, which
 * goes the moment Close is pressed: the card under this page comes back at
 * once, and two copies never run.
 */
const AppTab = memo(function AppTab(props: {
  readonly appId: string;
  readonly connected: boolean;
  readonly hostClient: HostClient;
  readonly onClosed: () => void;
  readonly onTyping: (typing: boolean) => void;
  readonly title: string;
}): ReactNode {
  const { appId, hostClient, onClosed, onTyping } = props;
  const navigation = useNavigation();
  const focused = useIsFocused();
  const ended = useHostSelector(
    hostClient,
    useCallback(
      (snapshot: HostSnapshot) => placeDestinationEnded(snapshot, { appId, kind: "opensteer-app" }),
      [appId],
    ),
  );
  const known = useHostSelector(hostClient, (snapshot) => snapshot.deploymentShape !== null);
  const [closing, setClosing] = useState(false);
  const [closeFailure, setCloseFailure] = useState<string | null>(null);
  const close = () => {
    setClosing(true);
    setCloseFailure(null);
    void hostClient.closeAppTab(appId).then(
      () => {
        if (navigation.isFocused()) onClosed();
        else setClosing(false);
      },
      (error: unknown) => {
        setClosing(false);
        setCloseFailure(error instanceof Error ? error.message : "Try again in a moment.");
      },
    );
  };
  // A composer beside the app can hold the keyboard too; only a field in the
  // app leaves no native input focused.
  const typing = useKeyboardVisible() && TextInput.State.currentlyFocusedInput() === null;
  useEffect(() => {
    onTyping(typing);
    return () => onTyping(false);
  }, [onTyping, typing]);
  // A covered page could run a second copy; locking the phone must not lose the app's state.
  if (!focused) return null;
  if (!known) return <TabStatus title="Loading app…" waiting />;
  if (closing) return <TabStatus title="Closing…" waiting />;
  if (ended) return <BrowserEnded detail={null} failed={false} />;
  return (
    <View style={styles.fill}>
      {closeFailure === null ? null : (
        <Notice
          action={{ label: "Try again", onPress: close }}
          detail={closeFailure}
          title="This tab could not be closed"
        />
      )}
      <AppFrame appId={appId} client={hostClient} fill />
      {typing ? null : (
        <CloseBar
          closeDisabled={!props.connected}
          onClose={close}
          onReport={() => contactSupport({ kind: "app", id: appId })}
        >
          <Symbol name={opensteerAppGlyph} size={15} tint={color.muted} />
          <AppText numberOfLines={1} role="secondaryMedium" style={styles.appName}>
            {props.title}
          </AppText>
        </CloseBar>
      )}
    </View>
  );
});

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

/** The second pane beside a page, under the pill that names it and puts it away. */
interface PairCompanion {
  /** Given how far down the floating pill covers the pane. */
  readonly content: (headerClearance: number) => ReactNode;
  /** The pill floats over content that scrolls under it, rather than standing above it. */
  readonly floating: boolean;
  readonly pill: ReactNode;
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
  readonly companion: PairCompanion | null;
  readonly keyboardVerticalOffset: number;
  readonly notices: ReactNode;
  /** Whether a second pane fits beside the page, which changes what the bar's agent and Ask do. */
  readonly onPaired: (paired: boolean) => void;
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
  const { bounds, companion, onPaired, typing } = props;
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
  useLayoutEffect(() => onPaired(paired), [onPaired, paired]);
  // Nothing to put beside the page: it takes the most room it has off the folds.
  const pair: PagePairArrangement = companion !== null ? derived.pair : { mode: "stacked" };
  const region = companion !== null ? derived.region : derived.alone;
  // Once beside the page, the companion stays mounted through a window too
  // narrow for two, as the page does, so its draft, stream and scroll are
  // there when the pair returns. Out of view it is inert: unseen, untouchable,
  // unreachable by a screen reader, and — told by its pane — claiming nothing
  // and marking nothing read. It keeps the size it had beside the page, so its
  // text does not reflow; it still follows its transcript, which is the cost of
  // keeping it. A phone that never pairs never draws it.
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
            {props.body}
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
              <CompanionPane companion={companion} />
            </Pane>
          </KeyboardAvoidingView>
        </>
      )}
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
  // The page alone — or tabletop giving way to the keyboard — each pane's
  // place moves with its content, so both clear the whole region.
  const clearance = occlusionClearance(region, occlusions);
  return { conversationClearance: clearance, pageClearance: clearance };
}

/**
 * The pane beside a page under its pill: the pill in the pane's own top safe
 * area, and a transcript that starts below it and scrolls beneath it, as the
 * standalone Thread's does under its bar.
 */
function CompanionPane(props: { readonly companion: PairCompanion }): ReactNode {
  const { companion } = props;
  const insets = useContentInsets();
  // What the pill covers, top inset and gaps included, as last measured.
  const [covered, setCovered] = useState<number | null>(null);
  const onPillLayout = useCallback((event: LayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    if (height > 0) setCovered(height);
  }, []);
  const pill = (
    <View
      onLayout={onPillLayout}
      pointerEvents="box-none"
      style={[
        styles.pill,
        companion.floating ? styles.floatingPill : null,
        { paddingTop: insets.top + space[8] },
      ]}
      testID="conversation-name"
    >
      {companion.pill}
    </View>
  );
  if (!companion.floating)
    return (
      <>
        {pill}
        {companion.content(0)}
      </>
    );
  return (
    <>
      {companion.content(covered ?? insets.top + space[8] + touchTarget + space[4])}
      {pill}
    </>
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
  appName: { flex: 1, marginStart: space[10] },
  // Beside the page, the second pane is a column of its own, edged by one hairline.
  besidePage: {
    backgroundColor: color.background,
    borderColor: color.lineStrong,
    borderStartWidth: StyleSheet.hairlineWidth,
    flex: 1,
  },
  belowFold: { backgroundColor: color.background, flex: 1 },
  centred: { textAlign: "center" },
  ended: {
    alignItems: "center",
    flex: 1,
    gap: space[12],
    justifyContent: "center",
    padding: space[24],
  },
  fill: { flex: 1 },
  floatingPill: { end: 0, position: "absolute", start: 0, top: 0 },
  // Laid out, so its native views and scroll position stay, but not drawn.
  outOfView: { left: 0, opacity: 0, position: "absolute", top: 0 },
  // Alone, the page and its bar have the whole surface. It has no
  // floor: with the keyboard up on a short screen, a floor is what pushes the
  // page's own address field under the keyboard.
  pageAlone: { flex: 1, minHeight: 0 },
  // Centred over the pane, clear of its edges.
  pill: { alignItems: "center", paddingBottom: space[4], paddingHorizontal: space[12] },
  // The resting page's address, standing where the live page's will be.
  restingAddress: { flex: 1, justifyContent: "center", minWidth: 0, paddingHorizontal: space[16] },
  row: { flexDirection: "row" },
  // Tabletop with the composer typing: the second pane keeps at least its
  // composer, and the page above gives up height to make room.
  underKeyboard: { backgroundColor: color.background, flexGrow: 1, flexShrink: 0 },
});
