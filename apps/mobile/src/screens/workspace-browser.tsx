import { useVerticalBar } from "../ui/vertical-bar.js";
import { contactSupport } from "../report-mail.js";
import {
  canRespondToRequests,
  describeHostConnection,
  placeAgentState,
  samePlaceAgents,
  threadMark,
  type BrowserTabDestination,
  type BrowserTabStore,
  type HostClient,
  type LegacyHostSnapshot as HostSnapshot,
} from "@opensteer/client/host";
import {
  useBrowserAgentFollow,
  useBrowserPopupFollow,
  useHostSelector,
  useHostSnapshot,
  useThreadAgentTab,
} from "@opensteer/client/react";
import { deviceElsewhere } from "@opensteer/client/computers";
import {
  TabIdSchema,
  type BrowserPageContentPart,
  type Tab,
  type TabId,
  type TabLayout,
  type TabTarget,
} from "@opensteer/core";
import { computerAppIdentityKey, type TabViewer } from "@opensteer/protocol";
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
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
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
import { BrowserPage, type PageFollowing, type PagePairChrome } from "../browser/browser-page.js";
import {
  AppPill,
  appMenuSections,
  askChoices,
  PageAsk,
  usePageHeader,
  type AppMenu,
  type AskTarget,
} from "../browser/page-header.js";
import { CompanionCapsule } from "../browser/pair-chrome.js";
import { usePlaceStatusRow } from "../browser/place-status.js";
import type { PageDevice } from "../browser/address-bar.js";
import { PlaceBarProvider, ToolbarLeave } from "../browser/place-bar.js";
import { tabRoute, type TabRoute } from "../browser/surface-route.js";
import { newTaskDraftKey } from "../client/thread-drafts.js";
import { homeDraftId } from "../home/home-draft.js";
import { useHereDeviceId } from "../computers/here-device.js";
import { usePhoneBrowserManager } from "../phone-browser/runtime.js";
import { usePhoneTabPresentation } from "../phone-browser/presentation.js";
import { ComputerOwnerView } from "../computers/phone-display.js";
import { adjacentTabId, layoutTabIds, tabTitle } from "../tabs/tab-entries.js";
import { tabAgents } from "../tabs/tab-agents.js";
import { tabsClient } from "../tabs/tabs-host.js";
import {
  useOperation,
  useTab,
  useTabLayout,
  useTabsModel,
  useTabsSyncing,
} from "../tabs/use-tabs.js";
import { useTabViewer } from "../tabs/use-tab-viewer.js";
import { computerSymbols } from "./settings-model.js";
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
import { useScreenPresence, type PagePresence } from "../ui/page-presence.js";
import { NewTaskPane } from "./new-task.js";
import { ThreadTitlePill } from "./thread-header.js";

/**
 * Exactly one tab, Mac app, phone or Opensteer App, as the route names it: the
 * place itself with the one bar it is used through. The route is the selection,
 * so nothing here chooses or swaps what is shown.
 *
 * How the page was reached — from a conversation, from Tabs, from the sidebar
 * — changes only where Back goes, which is the stack's own business. Who is in
 * the page comes from its occupants alone. Where the room fits two panes, the
 * agent's own Thread sits beside the page; on a phone, tapping the agent goes
 * to it.
 */
export function WorkspaceBrowserScreen({ route }: StaticScreenProps<TabRoute>): ReactNode {
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

function Surfaces(props: { readonly hostClient: HostClient; readonly route: TabRoute }): ReactNode {
  const { snapshot, loadError, reload } = useHostSnapshot(props.hostClient);
  const presence = useScreenPresence();
  const authorized = snapshot.session === "authenticated" && snapshot.user !== null;
  // Coming back into view, not out from under a sheet: the page never left the stream.
  useEffect(() => {
    if (presence.shown && authorized) void reload().catch(() => undefined);
  }, [authorized, presence.shown, reload]);
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
      presence={presence}
      hostClient={props.hostClient}
      loadError={loadError}
      reload={reload}
      route={props.route}
      snapshot={snapshot}
    />
  );
}

function SurfacesForUser(props: {
  readonly presence: PagePresence;
  readonly hostClient: HostClient;
  readonly loadError: string | null;
  readonly reload: () => Promise<void>;
  readonly route: TabRoute;
  readonly snapshot: HostSnapshot;
}): ReactNode {
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
  return (
    <TabSurface
      connected={connected}
      hostClient={props.hostClient}
      notices={notices}
      presence={props.presence}
      route={props.route}
      snapshot={snapshot}
    />
  );
}

interface TabSurfaceProps {
  readonly presence: PagePresence;
  readonly connected: boolean;
  readonly hostClient: HostClient;
  readonly notices: ReactNode;
  readonly route: TabRoute;
  readonly snapshot: HostSnapshot;
}

/**
 * The tab the route names, found by its tabId in the Host's one list. A tab
 * that leaves the list while it is in front takes this device's selection to
 * the entry beside it, or back when there is none; a popup goes back to the
 * page that opened it. Arriving at a tab that is already closed says so, with
 * Reopen: nothing else is ever shown in its place.
 */
function TabSurface(props: TabSurfaceProps): ReactNode {
  const { hostClient, route } = props;
  const navigation = useNavigation();
  const model = useTabsModel(hostClient);
  const listed = useTab(model, route.tabId);
  const syncing = useTabsSyncing(model);
  const layout = useTabLayout(model);
  // The last layout that held this tab, to find its neighbour once it is gone.
  const held = useRef<{
    readonly layout: TabLayout;
    readonly tab: Tab;
    readonly tabId: TabId;
  } | null>(null);
  if (held.current !== null && held.current.tabId !== route.tabId) held.current = null;
  if (listed !== undefined && layoutTabIds(layout).includes(route.tabId))
    held.current = { layout, tab: listed, tabId: route.tabId };
  // While the list catches up after a reconnect, the tab in front stays as it was.
  const tab = listed ?? (syncing ? held.current?.tab : undefined);
  const left = tab === undefined && !syncing && held.current !== null;
  const shown = props.presence.shown;
  useEffect(() => {
    if (!left || !shown || !navigation.isFocused()) return;
    const from = held.current;
    held.current = null;
    const next =
      route.popup === true || from === null ? null : adjacentTabId(from.layout, from.tabId);
    if (next !== null) navigation.setParams({ editAddress: false, popup: false, tabId: next });
    else if (navigation.canGoBack()) navigation.goBack();
  }, [left, navigation, route.popup, shown]);
  if (tab === undefined)
    return (
      <Screen>
        {props.notices}
        {syncing || left ? (
          <TabStatus title="Opening…" waiting />
        ) : (
          <ClosedTab hostClient={hostClient} key={route.tabId} tabId={route.tabId} />
        )}
      </Screen>
    );
  if (tab.state === "unavailable")
    return (
      <Screen>
        {props.notices}
        <UnavailableTab hostClient={hostClient} key={tab.tabId} tab={tab} />
      </Screen>
    );
  // One mounted screen across tab changes in place, so the page's companion stays.
  return <ViewedTab {...props} tab={tab} />;
}

/** A tab no longer in the list: only the person's Reopen brings this same tab back. */
function ClosedTab(props: { readonly hostClient: HostClient; readonly tabId: TabId }): ReactNode {
  const reopening = useOperation();
  const { hostClient, tabId } = props;
  return (
    <TabStatus
      action={{
        label: reopening.busy ? "Reopening…" : "Reopen",
        onPress: () =>
          void reopening.run(
            () => tabsClient(hostClient).reopenTab(tabId),
            "This tab could not reopen.",
          ),
      }}
      detail={reopening.failure}
      title="This tab was closed"
    />
  );
}

/** A tab that cannot open now says why; closing it is the one thing left to do. */
function UnavailableTab(props: { readonly hostClient: HostClient; readonly tab: Tab }): ReactNode {
  const closing = useTabClose(props.hostClient, props.tab.tabId);
  return (
    <TabStatus
      action={{ label: closing.closing ? "Closing…" : "Close tab", onPress: closing.close }}
      detail={closing.failure}
      title={props.tab.unavailableReason ?? "This tab can’t open right now"}
    />
  );
}

/**
 * A listed tab, opened through the Host, then shown as its kind is shown.
 * Moving between pages of one browser keeps showing that browser while the
 * Host answers for the next page, so nothing remounts in between.
 */
function ViewedTab(props: TabSurfaceProps & { readonly tab: Tab }): ReactNode {
  const { state, retry } = useTabViewer(props.hostClient, props.tab.tabId, true);
  const last = useRef<TabViewer | null>(null);
  const viewer: TabViewer | null =
    state.status === "ready"
      ? state.viewer
      : state.status === "activating" && props.tab.kind === "page" && last.current?.kind === "page"
        ? { ...last.current, surfaceId: props.tab.tabId }
        : null;
  last.current = viewer ?? last.current;
  if (viewer === null)
    return (
      <Screen>
        {props.notices}
        {state.status === "failed" ? (
          <TabStatus action={{ label: "Try again", onPress: retry }} title={state.error} />
        ) : (
          <TabStatus title="Opening…" waiting />
        )}
      </Screen>
    );
  return <Focused {...props} onReactivate={retry} viewer={viewer} />;
}

/** What is beside the page: a Thread, or Home's new task being started from it. */
type Companion = { readonly kind: "thread"; readonly threadId: string } | { readonly kind: "task" };

/**
 * One tab with its own bar, and — where a pair fits — a second pane. The
 * tab's view makes room for its own keyboard; this screen only hears that it
 * is typing, so the pane being typed in is the one that lifts.
 */
function Focused(
  props: TabSurfaceProps & {
    readonly onReactivate: () => void;
    readonly tab: Tab;
    readonly viewer: TabViewer;
  },
): ReactNode {
  const { hostClient, route, snapshot, tab, viewer } = props;
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

  // Who is here: the tasks the Host says use this tab, and nothing nearby.
  const usedBy = tab.usedBy;
  const selectAgents = useCallback((current: HostSnapshot) => tabAgents(usedBy, current), [usedBy]);
  const agents = useHostSelector(hostClient, selectAgents, samePlaceAgents);

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

  const shownPage = viewer.kind === "page" ? page : null;
  const latest = useRef({ shownPage });
  latest.current = { shownPage };

  /**
   * An agent's Thread, as its own screen. The screen directly under this one
   * may be that very Thread — the page was opened from it — and then Back is
   * the way there, not a second copy.
   */
  const openThread = useCallback(
    (threadId: string) => {
      const state = navigation.getState();
      const below = state?.routes[state.index - 1];
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
   * Ask's page goes on Home's new task draft, and is this reader's, so it is
   * shown, removed and sent from that draft like the words with it, and
   * survives leaving it unsent. A page Ask cannot name, such as a Mac app's,
   * takes any earlier one off rather than leaving it to stand for what was
   * asked about. Answers whether there is such a draft.
   */
  const putPageOnDraft = useCallback(
    (target: AskTarget): boolean => {
      const userId = hostClient.getSnapshot().user?.id;
      if (userId === undefined || target === "thread") return false;
      void drafts
        .writeDraftPage(
          deploymentId,
          userId,
          newTaskDraftKey(homeDraftId),
          latest.current.shownPage,
        )
        .catch(() => undefined);
      return true;
    },
    [deploymentId, drafts, hostClient],
  );
  /** Ask, on a phone: that composer's own screen, with the page on its draft. */
  const askAway = useCallback(
    (target: AskTarget) => {
      if (putPageOnDraft(target)) navigation.dispatch(StackActions.popToTop());
    },
    [navigation, putPageOnDraft],
  );
  /** Ask, where a pair fits: the composer opens beside the page, with the page on its draft. */
  const askBeside = useCallback(
    (target: AskTarget) => {
      if (putPageOnDraft(target)) setChosen({ kind: "task" });
    },
    [putPageOnDraft],
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

  // A new tab of this page's profile, over this one, so Back returns here.
  const opening = useOperation();
  const onOpenTab = useCallback(
    (url: string) => {
      if (tab.kind !== "page") return;
      const target: TabTarget = tab.profile
        ? { kind: "page", profileId: tab.profile.profileId, url }
        : { computerId: tab.computer.computerId, guest: true, kind: "page", url };
      void opening.run(
        () => tabsClient(hostClient).openTab(target),
        "A new tab could not be opened.",
        (opened) => {
          if (navigation.isFocused())
            navigation.dispatch(
              StackActions.push(
                "WorkspaceBrowser",
                tabRoute(deploymentId, opened.tabId, route.threadId),
              ),
            );
        },
      );
    },
    [deploymentId, hostClient, navigation, opening, route.threadId, tab],
  );
  // Another tab of the same browser takes this one's place in the route, as
  // Safari's tab swipe does; Back still returns where the page came from.
  const onSwitchTab = useCallback(
    (tabId: string) =>
      navigation.setParams({ editAddress: false, popup: false, tabId: TabIdSchema.parse(tabId) }),
    [navigation],
  );
  /**
   * Keeping up with the beside Thread's agent: the route moves in place to
   * whichever tab it is on, until the person moves the page themselves. It
   * waits while something is over the page, such as the tab sheet.
   */
  const shownTab =
    viewer.kind === "page" ? { sessionId: viewer.sessionId, tabId: route.tabId } : null;
  const showTab = useCallback(
    (shown: BrowserTabDestination) => onSwitchTab(shown.tabId),
    [onSwitchTab],
  );
  const agentTab = useThreadAgentTab(hostClient, besideId);
  const follow = useBrowserAgentFollow({
    agentTab,
    held: !props.presence.interactive,
    onFollow: showTab,
    shownTab,
    threadId: besideId,
  });
  // Over the page that opened it, so Back and its ending both return there.
  const onPopup = useCallback(
    (tabId: string) => {
      navigation.dispatch(
        StackActions.push("WorkspaceBrowser", {
          ...tabRoute(deploymentId, TabIdSchema.parse(tabId), route.threadId),
          popup: true,
        }),
      );
    },
    [deploymentId, navigation, route.threadId],
  );
  const onShowTabs = useCallback(() => {
    navigation.dispatch(
      StackActions.push("BrowserTabs", {
        deploymentId,
        tabId: route.tabId,
        ...(besideId === null ? {} : { threadId: besideId }),
      }),
    );
  }, [besideId, deploymentId, navigation, route.tabId]);
  const [paired, setPaired] = useState(false);
  const title = tab.title.trim() || shownPage?.title || tabTitle(tab);
  // Closing only takes the tab off the list: an app's server and an agent's work go on.
  const closing = useTabClose(hostClient, tab.tabId);
  const appId = viewer.kind === "app" ? viewer.appId : null;
  const appReload = useRef<(() => void) | null>(null);
  const reloadApp = useCallback(() => appReload.current?.(), []);
  const reportApp = useCallback(() => {
    if (appId !== null) contactSupport({ kind: "app", id: appId });
  }, [appId]);
  const appMenu = useMemo(
    (): AppMenu | null =>
      appId === null
        ? null
        : {
            closable: props.connected && !closing.closing,
            live: !closing.closing,
            onClose: closing.close,
            onOpenThread: null,
            onReload: reloadApp,
            onReport: reportApp,
          },
    [appId, closing.close, closing.closing, props.connected, reloadApp, reportApp],
  );
  const onAsk = paired ? askBeside : askAway;
  const onOpenAgent = paired ? showBeside : openThread;
  const verticalBar = useVerticalBar();
  const companionShown = companion !== null;
  const pairedChrome = paired && companionShown && viewer.kind === "page";
  usePageHeader({
    agents,
    app: appMenu,
    asksThread: false,
    noAsk: pairedChrome,
    onAsk,
    onOpenAgent,
    title,
    verticalBar,
  });
  // The conversation the page was opened from, unless it is already beside the page.
  const watchedId =
    route.threadId === undefined ||
    appId !== null ||
    (paired && companionShown && besideId === route.threadId)
      ? null
      : route.threadId;
  const status = usePlaceStatusRow({
    agents,
    hostClient,
    onAnswer: openThread,
    threadId: watchedId,
  });
  const hereId = useHereDeviceId(deploymentId);
  const ask = useMemo(
    () => <PageAsk agents={agents} onAsk={onAsk} onOpenAgent={onOpenAgent} />,
    [agents, onAsk, onOpenAgent],
  );
  const appPaired = paired && companionShown && appId !== null;
  // Beside its Thread an app has its own row, with Back, wherever the screen is.
  useLayoutEffect(() => {
    if (!appPaired) return;
    navigation.setOptions({ headerShown: false });
    return () => navigation.setOptions({ headerShown: true });
  }, [appPaired, navigation]);
  const appPair = useMemo(
    (): AppPairChrome | null =>
      appPaired && appMenu !== null
        ? {
            sections: appMenuSections(appMenu, askChoices({ asksThread: false, onAsk: askBeside })),
          }
        : null,
    [appMenu, appPaired, askBeside],
  );
  const others = agents.agents.some(({ threadId }) => threadId !== besideId);
  const pairMenu: NativeMenuSection[] = [
    askChoices({ asksThread: false, onAsk: askBeside }),
    others
      ? agents.agents.map((agent) => ({
          id: `beside:${agent.threadId}`,
          label: `${agent.title} · ${placeAgentState(agent)}`,
          onPress: () => showBeside(agent.threadId),
          selected: agent.threadId === besideId,
        }))
      : [],
  ];
  const pair: PagePairChrome | null = pairedChrome ? { menu: pairMenu } : null;
  // The Thread's own mark, as web draws it: the page's occupants can lag the agent arriving.
  const following: PageFollowing | null =
    follow.following && besideId !== null ? { mark: threadMark(besideId, snapshot) } : null;
  const closeItem: NativeMenuOption = {
    destructive: true,
    disabled: closing.closing,
    icon: "xmark.circle",
    id: "close",
    label: "Close tab",
    onPress: closing.close,
  };
  const body =
    viewer.kind === "app" ? (
      <AppTab
        appId={viewer.appId}
        closeFailure={closing.failure}
        closing={closing.closing}
        hostClient={hostClient}
        key={viewer.appId}
        onRetryClose={closing.close}
        onTyping={setTyping}
        pair={appPair}
        reloadRef={appReload}
        title={title}
      />
    ) : viewer.kind !== "page" ? (
      <ComputerOwnerView
        active={props.presence.interactive}
        appKey={
          viewer.view.target.kind === "app" ? computerAppIdentityKey(viewer.view.target.app) : null
        }
        generation={viewer.view.generation}
        hostClient={hostClient}
        key={`${viewer.view.viewId}:${viewer.view.generation}`}
        machineId={viewer.view.machineId}
        menu={[closeItem]}
        onReopen={props.onReactivate}
        onTyping={setTyping}
        viewId={viewer.view.viewId}
      />
    ) : (
      <BrowserTab
        presence={props.presence}
        connected={props.connected}
        deploymentId={deploymentId}
        hereId={hereId}
        editAddress={route.editAddress === true}
        following={following}
        hostClient={hostClient}
        onOpenTab={onOpenTab}
        onPopup={onPopup}
        onReactivate={props.onReactivate}
        onShowTabs={onShowTabs}
        onSteer={follow.steer}
        onSwitchTab={onSwitchTab}
        onTyping={setTyping}
        onViewing={setPage}
        pair={pair}
        sessionId={viewer.sessionId}
        snapshot={snapshot}
        tabId={route.tabId}
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
            content: () => (
              <NewTaskPane
                autoFocus
                deploymentId={deploymentId}
                hostClient={hostClient}
                onStarted={onStarted}
                underHeader={false}
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
                onGone={closeCompanion}
                onHeader={onHeader}
                onOpenThread={(id) =>
                  navigation.dispatch(StackActions.push("Thread", { deploymentId, threadId: id }))
                }
                requestId={null}
                withPage={{ page: shownPage, showTab: shownTab === null ? null : showTab }}
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
  const notices = (
    <>
      {props.notices}
      {opening.failure === null ? null : (
        <Notice
          action={{ label: "Dismiss", onPress: opening.dismiss }}
          detail={opening.failure}
          title="A new tab could not be opened"
        />
      )}
    </>
  );
  return (
    <PlaceBarProvider ask={ask} status={status} verticalBar={verticalBar}>
      <PagePairSurface
        bleed={appId !== null}
        body={body}
        companion={second}
        // Only Android's app bar is in the room's way: on iOS an app runs under a
        // transparent bar, from the screen's top, and every other place has its own bar.
        keyboardVerticalOffset={appId !== null && Platform.OS !== "ios" ? headerHeight : 0}
        notices={notices}
        onPaired={setPaired}
        typing={typing}
      />
    </PlaceBarProvider>
  );
}

/** Wide enough for a task's name, never wider than a pane beside a page leaves it. */
const companionPillWidth = 320;

/**
 * Whether a browser tab is drawn as a page now: listed awake, with a page, by
 * a running browser.
 */
function browserShowsPage(
  snapshot: HostSnapshot,
  store: BrowserTabStore,
  sessionId: string,
  tabId: string,
): boolean {
  const session = snapshot.browserSessions.find(({ id }) => id === sessionId);
  const row = store.sessionTab(sessionId, tabId);
  return (
    session !== undefined &&
    session.state !== "closed" &&
    session.state !== "failed" &&
    !(session.state === "ready" && (row?.documentId == null || row.state !== "live"))
  );
}

const LocalPhoneTab = lazy(() =>
  import("../phone-browser/local-tab.js").then(({ LocalPhoneTab }) => ({ default: LocalPhoneTab })),
);

/**
 * One page, in the browser session the Host's activation named. A page whose
 * browser has not caught up yet says it is opening; one whose browser ended
 * offers to open it again, which the Host restores in place.
 */
function BrowserTab(props: {
  readonly presence: PagePresence;
  readonly connected: boolean;
  readonly deploymentId: string;
  /** This phone's own device in the Deployment, which needs no name beside a page. */
  readonly hereId: string | null;
  readonly editAddress: boolean;
  readonly following: PageFollowing | null;
  readonly hostClient: HostClient;
  readonly onOpenTab: (url: string) => void;
  readonly onPopup: (tabId: string) => void;
  /** Ask the Host to open this tab again, as the person's own Open. */
  readonly onReactivate: () => void;
  readonly onShowTabs: () => void;
  readonly onSteer: () => void;
  readonly onSwitchTab: (tabId: string) => void;
  readonly onTyping: (typing: boolean) => void;
  readonly onViewing: (page: BrowserPageContentPart | null) => void;
  /** What the page's bar adds while a Thread is beside it. */
  readonly pair: PagePairChrome | null;
  readonly sessionId: string;
  readonly snapshot: HostSnapshot;
  readonly tabId: TabId;
}): ReactNode {
  const { hostClient, snapshot, tabId } = props;
  const phoneManager = usePhoneBrowserManager();
  usePhoneTabPresentation(phoneManager, tabId);
  const local = phoneManager?.localPresentation(props.deploymentId, tabId) ?? null;
  const navigation = useNavigation();
  const sessionId = local?.sessionId ?? props.sessionId;
  const pageKey = `${sessionId}:${tabId}`;

  const session = snapshot.browserSessions.find(({ id }) => id === sessionId) ?? null;
  const live =
    session !== null && browserShowsPage(snapshot, hostClient.browserTabs, sessionId, tabId);
  const elsewhere =
    session === null
      ? null
      : deviceElsewhere(snapshot.machines, session.placement.runnerId, props.hereId);
  const { deploymentId } = props;
  const device: PageDevice | null =
    elsewhere === null
      ? null
      : {
          glyph: computerSymbols[elsewhere.glyph],
          name: elsewhere.name,
          online: elsewhere.online,
          onOpen: () =>
            navigation.dispatch(
              StackActions.push("Computer", { deploymentId, machineId: elsewhere.id }),
            ),
        };
  // Which way the page came from the tab before it, by the browser's own order.
  const shown = useRef<{ readonly arrival: -1 | 0 | 1; readonly tabId: string }>({
    arrival: 0,
    tabId,
  });
  if (shown.current.tabId !== tabId) {
    const order = session === null ? [] : hostClient.browserTabs.sessionList(sessionId).ids;
    const from = order.indexOf(shown.current.tabId);
    const to = order.indexOf(tabId);
    shown.current = { arrival: from >= 0 && to >= 0 && to < from ? -1 : 1, tabId };
  }
  useBrowserPopupFollow(
    hostClient,
    live && props.presence.interactive ? { sessionId, tabId } : null,
    props.onPopup,
  );
  // The browser it was opened in is gone while the tab stays listed: the Host
  // restored it elsewhere, so ask once where it is now.
  const asked = useRef<string | null>(null);
  const vanished = session === null && local === null && snapshot.browserSessions.length > 0;
  const { onReactivate } = props;
  useEffect(() => {
    if (!vanished || asked.current === sessionId) return;
    asked.current = sessionId;
    onReactivate();
  }, [onReactivate, sessionId, vanished]);

  if ((live || local) && session !== null)
    return (
      <BrowserPage
        nativeContent={
          local && phoneManager ? (
            <Suspense fallback={<TabStatus title="Opening…" waiting />}>
              <LocalPhoneTab
                presence={props.presence}
                available={snapshot.browserPlacements.some(
                  (placement) =>
                    placement.runnerId === phoneManager.runnerId && placement.available,
                )}
                deploymentId={props.deploymentId}
                liveSession={
                  session.state === "ready" && phoneManager.hasLiveSession(local.sessionId)
                }
                hostClient={hostClient}
                manager={phoneManager}
                admission={local}
                status={(message) => <TabStatus title={message} />}
              />
            </Suspense>
          ) : undefined
        }
        presence={props.presence}
        arrival={shown.current.arrival}
        connected={props.connected}
        device={device}
        following={props.following}
        hostClient={hostClient}
        key={pageKey}
        editAddress={props.editAddress}
        onOpenTab={props.onOpenTab}
        onShowTabs={props.onShowTabs}
        onSteer={props.onSteer}
        onSwitchTab={props.onSwitchTab}
        pair={props.pair}
        onTyping={props.onTyping}
        onViewing={props.onViewing}
        session={session}
        tabId={tabId}
      />
    );
  if (local && phoneManager)
    return (
      <Suspense fallback={<TabStatus title="Opening…" waiting />}>
        <LocalPhoneTab
          presence={props.presence}
          available={snapshot.browserPlacements.some(
            (placement) => placement.runnerId === phoneManager.runnerId && placement.available,
          )}
          deploymentId={props.deploymentId}
          liveSession={false}
          hostClient={hostClient}
          manager={phoneManager}
          admission={local}
          status={(message) => <TabStatus title={message} />}
        />
      </Suspense>
    );
  if (session?.state === "closed" || session?.state === "failed")
    return (
      <TabStatus
        action={{ label: "Open again", onPress: props.onReactivate }}
        detail={session.state === "failed" ? session.error : null}
        title={session.state === "failed" ? "This page stopped working" : "This page is asleep"}
      />
    );
  return <TabStatus title="Opening…" waiting />;
}

/** An app's menu, beside the way out in its pane's own top row while a Thread is beside it. */
interface AppPairChrome {
  readonly sections: readonly NativeMenuSection[];
}

/**
 * Closing this tab: it leaves the list, and the screen moves on when the
 * list says so. A refusal stays here with why; an answer for a tab no longer
 * shown changes nothing.
 */
function useTabClose(
  hostClient: HostClient,
  tabId: TabId,
): { readonly close: () => void; readonly closing: boolean; readonly failure: string | null } {
  const operation = useOperation();
  const { run } = operation;
  const [attempted, setAttempted] = useState<TabId | null>(null);
  const close = useCallback(() => {
    setAttempted(tabId);
    void run(async () => {
      const result = await tabsClient(hostClient).closeTabs([tabId]);
      const failed = result.failed.find((item) => item.tabId === tabId);
      if (failed) throw new Error(failed.error.message);
    }, "This tab could not be closed.");
  }, [hostClient, run, tabId]);
  const current = attempted === tabId;
  return {
    close,
    closing: current && operation.busy,
    failure: current ? operation.failure : null,
  };
}

/**
 * An Opensteer App open as a tab, edge to edge. Its name and menu are the
 * native bar's title, or beside a Thread a row of its pane's own; on iOS the
 * app scrolls under either, and elsewhere it starts below. It reads only
 * whether it has ended, so a streamed token never reaches its WebView.
 */
const AppTab = memo(function AppTab(props: {
  readonly appId: string;
  readonly closeFailure: string | null;
  readonly closing: boolean;
  readonly hostClient: HostClient;
  readonly onRetryClose: () => void;
  readonly onTyping: (typing: boolean) => void;
  readonly pair: AppPairChrome | null;
  readonly reloadRef: RefObject<(() => void) | null>;
  readonly title: string;
}): ReactNode {
  const { appId, hostClient, onTyping, pair } = props;
  const focused = useIsFocused();
  const insets = useContentInsets();
  const headerHeight = useHeaderHeight();
  const known = useHostSelector(hostClient, (snapshot) => snapshot.deploymentShape !== null);
  // What the pane's own row covers, its top inset included, as last measured.
  const [row, setRow] = useState<number | null>(null);
  const onRowLayout = useCallback((event: LayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    if (height > 0) setRow(height);
  }, []);
  const top =
    pair !== null
      ? (row ?? insets.top + space[4] + touchTarget + space[8])
      : // Under a transparent bar, the pane's safe area is the bar's height.
        Platform.OS === "ios"
        ? Math.max(insets.top, headerHeight)
        : insets.top;
  const chrome = useMemo(
    () => ({ bottom: insets.bottom, left: insets.left, right: insets.right, top }),
    [insets.bottom, insets.left, insets.right, top],
  );
  const tab = useMemo(() => ({ chrome, reloadRef: props.reloadRef }), [chrome, props.reloadRef]);
  // A composer beside the app can hold the keyboard too; only a field in the
  // app leaves no native input focused.
  const typing = useKeyboardVisible() && TextInput.State.currentlyFocusedInput() === null;
  useEffect(() => {
    onTyping(typing);
    return () => onTyping(false);
  }, [onTyping, typing]);
  // A covered page could run a second copy; locking the phone must not lose the app's state.
  if (!focused) return null;
  const clear = {
    paddingBottom: chrome.bottom,
    paddingLeft: chrome.left,
    paddingRight: chrome.right,
    paddingTop: chrome.top,
  };
  return (
    <View style={styles.fill}>
      {!known ? (
        <View style={[styles.fill, clear]}>
          <TabStatus title="Loading app…" waiting />
        </View>
      ) : props.closing ? (
        <View style={[styles.fill, clear]}>
          <TabStatus title="Closing…" waiting />
        </View>
      ) : (
        <AppFrame appId={appId} client={hostClient} tab={tab} />
      )}
      {props.closeFailure === null ? null : (
        <View
          pointerEvents="box-none"
          style={[
            styles.overApp,
            { paddingLeft: chrome.left, paddingRight: chrome.right, top: chrome.top },
          ]}
        >
          <Notice
            action={{ label: "Try again", onPress: props.onRetryClose }}
            detail={props.closeFailure}
            title="This tab could not be closed"
          />
        </View>
      )}
      {pair === null ? null : (
        <View
          onLayout={onRowLayout}
          pointerEvents="box-none"
          style={[
            styles.appRow,
            {
              paddingLeft: space[12] + insets.left,
              paddingRight: space[12] + insets.right,
              paddingTop: insets.top + space[4],
            },
          ]}
          testID="app-pane-bar"
        >
          <ToolbarLeave ownRow />
          <View pointerEvents="box-none" style={styles.appRowTitle}>
            <AppPill
              floating
              maxWidth={companionPillWidth}
              sections={pair.sections}
              title={props.title}
            />
          </View>
          {/* Balances Back, so the name is centred over the pane as a bar's title is. */}
          <View style={styles.appRowBalance} />
        </View>
      )}
    </View>
  );
});

/** What a tab with no picture says, centred where the page would be. */
function TabStatus(props: {
  readonly action?: { readonly label: string; readonly onPress: () => void };
  /** Why, under the title, when there is more to say. */
  readonly detail?: string | null;
  readonly title: string;
  readonly waiting?: boolean;
}): ReactNode {
  return (
    <View accessibilityLiveRegion="polite" style={styles.ended}>
      {props.waiting === true ? <ActivityIndicator color={color.muted} /> : null}
      <AppText role="bodyMedium" style={styles.centred}>
        {props.title}
      </AppText>
      {props.detail ? (
        <AppText role="secondary" style={styles.centred} tone="muted">
          {props.detail}
        </AppText>
      ) : null}
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
  /** The page places itself in its insets, running under its chrome, as an app does. */
  readonly bleed: boolean;
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
          {props.bleed ? (
            <View style={styles.fill} testID="page-content">
              {props.body}
              <NoticesOver>{props.notices}</NoticesOver>
            </View>
          ) : (
            // The page's own controls and picture keep to the pane's insets: its
            // address, its dialogs and the remote picture a tap is mapped into.
            <InsetView style={styles.fill} testID="page-content">
              {props.notices}
              {props.body}
            </InsetView>
          )}
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

/** Notices over a page that runs under its chrome: at the foot, where it has none. */
function NoticesOver(props: { readonly children: ReactNode }): ReactNode {
  const insets = useContentInsets();
  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.overApp,
        { bottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right },
      ]}
    >
      {props.children}
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
        // A vertical bar or a notch stands at one side of the pane, as at its top.
        {
          paddingLeft: insets.left + space[12],
          paddingRight: insets.right + space[12],
          paddingTop: insets.top + space[8],
        },
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

const styles = StyleSheet.create({
  // Over the app, which scrolls under it; Back and a balancing slot keep the name centred.
  appRow: {
    alignItems: "center",
    end: 0,
    flexDirection: "row",
    paddingBottom: space[8],
    position: "absolute",
    start: 0,
    top: 0,
  },
  appRowBalance: { width: touchTarget },
  appRowTitle: { alignItems: "center", flex: 1, minWidth: 0, paddingHorizontal: space[8] },
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
  overApp: { end: 0, position: "absolute", start: 0 },
  // Laid out, so its native views and scroll position stay, but not drawn.
  outOfView: { left: 0, opacity: 0, position: "absolute", top: 0 },
  // Alone, the page and its bar have the whole surface. It has no
  // floor: with the keyboard up on a short screen, a floor is what pushes the
  // page's own address field under the keyboard.
  pageAlone: { flex: 1, minHeight: 0 },
  // Centred over the pane, clear of its edges.
  pill: { alignItems: "center", paddingBottom: space[4] },
  row: { flexDirection: "row" },
  // Tabletop with the composer typing: the second pane keeps at least its
  // composer, and the page above gives up height to make room.
  underKeyboard: { backgroundColor: color.background, flexGrow: 1, flexShrink: 0 },
});
