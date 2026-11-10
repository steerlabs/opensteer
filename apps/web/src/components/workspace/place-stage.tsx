import { PendingBrowserTabView } from "./pending-browser-tab.js";
import {
  browserPlaceUnavailableReason,
  browserThreadAgentTab,
  threadMark,
} from "@opensteer/client/host";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router";
import type { ReactNode } from "react";
import type { HostClient, PlaceItem, WorkspaceSurfaceDestination } from "@opensteer/client/host";
import { BrowserSurfaceIdSchema, CHAT_THREAD_TITLE } from "@opensteer/core";
import { useHostSelector, usePhoneTabView, usePlaceList } from "@opensteer/client/react";
import { usePageVisible } from "../../ui-utils.js";
import { PlaceBrowserView, type BrowserChromeSignIn } from "../browser/browser-view.js";
import { BrowserFollowBand, useBrowserThreadPair } from "../browser/browser-thread-pair.js";
import { ComputerWatchView } from "../computer-watch.js";
import { Icon } from "../icon.js";
import { useToastToolbar } from "../toast.js";
import { SidebarRestoreButton } from "../sidebar-chrome.js";
import { TaskMark, TaskBadge, ChatOrb } from "./task-mark.js";
import { AppTab, AppTabGone } from "./app-tab.js";
import { useBrowserPresentations } from "./identity.js";
import { OwnerView } from "./owner-view.js";
import { StartPage } from "./start-page.js";
import {
  destinationPlaceKey,
  startPageLink,
  startPageOpening,
  startPageOrigin,
  type StartPageLink,
} from "./navigation.js";
import { OccupantMarks } from "./occupant-marks.js";
import { conversationAt, useTaskDirectory, type TaskDirectory } from "./task-directory.js";
import { useWorkspace } from "./workspace-context.js";

/**
 * The middle: the one raised object, showing exactly the place the address
 * names. It is mounted above the conversation routes, so changing
 * conversation never remounts it; it never picks another place by itself
 * (the address does, when the place goes: [succession](./place-succession.ts)).
 */
export const PlaceStage = memo(function PlaceStage({
  chromeSignIn,
  hostClient,
  hostConnected,
  onReportError,
}: {
  readonly chromeSignIn: BrowserChromeSignIn | null;
  readonly hostClient: HostClient;
  readonly hostConnected: boolean;
  readonly onReportError: (error: unknown) => void;
}) {
  const { drawer, phone } = useWorkspace();
  const directory = useTaskDirectory(hostClient);
  const leading = drawer ? <DrawerButton /> : <SidebarRestoreButton />;
  const trailing = phone ? null : <ChatToggle directory={directory} />;
  return (
    <>
      <SelectedPlace
        chromeSignIn={chromeSignIn}
        directory={directory}
        hostClient={hostClient}
        hostConnected={hostConnected}
        leading={leading}
        onReportError={onReportError}
        trailing={trailing}
      />
      <AppTabs
        directory={directory}
        hostClient={hostClient}
        leading={leading}
        trailing={trailing}
      />
    </>
  );
});

/** Kept in the order first shown, never the list's: moving an iframe reloads it. */
function AppTabs({
  directory,
  hostClient,
  leading,
  trailing,
}: {
  readonly directory: TaskDirectory;
  readonly hostClient: HostClient;
  readonly leading: ReactNode;
  readonly trailing: ReactNode;
}) {
  const { selection } = useWorkspace();
  const open = new Map(
    usePlaceList(hostClient).flatMap((place) =>
      place.opensteerApp ? [[place.opensteerApp.appId, place] as const] : [],
    ),
  );
  const selected =
    selection.kind === "place" && selection.destination.kind === "opensteer-app"
      ? selection.destination.appId
      : null;
  const shown = useRef(new Set<string>());
  for (const appId of shown.current) if (!open.has(appId)) shown.current.delete(appId);
  if (selected && open.has(selected)) shown.current.add(selected);
  return [...shown.current].map((appId) => (
    <AppTab
      directory={directory}
      hostClient={hostClient}
      key={appId}
      leading={leading}
      place={open.get(appId)!}
      selected={appId === selected}
      trailing={trailing}
    />
  ));
}

function SelectedPlace({
  chromeSignIn,
  directory,
  hostClient,
  hostConnected,
  leading,
  onReportError,
  trailing,
}: {
  readonly chromeSignIn: BrowserChromeSignIn | null;
  readonly directory: TaskDirectory;
  readonly hostClient: HostClient;
  readonly hostConnected: boolean;
  readonly leading: ReactNode;
  readonly onReportError: (error: unknown) => void;
  readonly trailing: ReactNode;
}) {
  const { dock, nav, phone, selection } = useWorkspace();
  const { pathname } = useLocation();
  const toolbarRef = useToastToolbar();
  const places = usePlaceList(hostClient);
  const presentations = useBrowserPresentations(places);
  const pageVisible = usePageVisible();
  const known = useRef(new Map<string, PlaceItem>());
  const placeKey = selection.kind === "place" ? destinationPlaceKey(selection.destination) : null;
  const selectedTab =
    selection.kind === "place" && selection.destination.kind === "browser"
      ? selection.destination.tabId
      : null;
  const shownBrowser =
    selection.kind === "place" && selection.destination.kind === "browser" && selectedTab
      ? { sessionId: selection.destination.sessionId, tabId: selectedTab }
      : null;
  const dockedThread =
    !phone && dock.open ? conversationAt(pathname, directory.homeThreadId) : null;
  const showBrowserTab = useCallback(
    (
      destination: { readonly sessionId: string; readonly tabId: string },
      options: { replace: boolean },
    ) => nav.showPlace({ kind: "browser", ...destination }, options),
    [nav],
  );
  const pair = useBrowserThreadPair({
    hostClient,
    mark: dockedThread ? (
      dockedThread === directory.homeThreadId ? (
        <ChatOrb size={16} />
      ) : (
        <TaskMark mark={threadMark(dockedThread, directory.snapshot)} size={16} />
      )
    ) : null,
    onShow: showBrowserTab,
    shown: shownBrowser,
    threadId: shownBrowser ? dockedThread : null,
  });
  const browserSessions = useHostSelector(hostClient, (snapshot) => snapshot.browserSessions);
  const launcherAgentTab = useMemo(
    () => (dockedThread ? browserThreadAgentTab(browserSessions, dockedThread) : null),
    [browserSessions, dockedThread],
  );
  const launcherBand = launcherAgentTab ? (
    <BrowserFollowBand
      pair={{
        elsewhere: launcherAgentTab,
        mark:
          dockedThread === directory.homeThreadId ? (
            <ChatOrb size={16} />
          ) : dockedThread ? (
            <TaskMark mark={threadMark(dockedThread, directory.snapshot)} size={16} />
          ) : null,
        resume: () => showBrowserTab(launcherAgentTab, { replace: false }),
      }}
    />
  ) : null;
  const live = placeKey
    ? (places.find(
        (item) =>
          item.key === placeKey ||
          (selectedTab &&
            item.destination.kind === "browser" &&
            item.destination.tabId === selectedTab),
      ) ?? null)
    : null;
  const placements = useHostSelector(hostClient, (snapshot) => snapshot.browserPlacements);
  const [activationError, setActivationError] = useState<{ tabId: string; message: string } | null>(
    null,
  );
  const [retry, setRetry] = useState(0);
  const opening = useMemo(() => crypto.randomUUID(), [nav.placeOpening, retry, selectedTab]);
  const durable = live?.workspaceTab;
  const rowState = durable?.state;
  const currentSessionId = live?.destination.kind === "browser" ? live.destination.sessionId : null;
  const placement = placements.find((value) => value.runnerId === live?.device?.machineId);
  const connected = hostConnected && placement?.available === true;
  const lastingReason = browserPlaceUnavailableReason(
    live?.identity ?? null,
    durable?.unavailableReason,
    placement?.unavailableReason,
  );
  const activate = hostClient.activateWorkspaceTab;
  useLayoutEffect(() => {
    if (rowState === "live") {
      if (
        selection.kind === "place" &&
        selection.destination.kind === "browser" &&
        currentSessionId &&
        currentSessionId !== selection.destination.sessionId &&
        selectedTab
      )
        nav.succeedPlace({ kind: "browser", sessionId: currentSessionId, tabId: selectedTab });
    }
  }, [currentSessionId, nav, rowState, selectedTab, selection]);
  const canActivate = !!selectedTab && !!durable && rowState !== "live" && !lastingReason;
  const beginPlaceOperation = nav.beginPlaceOperation;
  useLayoutEffect(() => {
    if (!canActivate || !selectedTab || !activate) return;
    let cancelled = false;
    const finish = beginPlaceOperation({ replace: true });
    setActivationError(null);
    void activate
      .call(hostClient, selectedTab, { opening })
      .then((result) => {
        if (!cancelled && result)
          finish({ kind: "browser", sessionId: result.session.id, tabId: result.tabId });
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setActivationError({
            tabId: selectedTab,
            message: error instanceof Error ? error.message : "This tab could not reopen.",
          });
      });
    return () => {
      cancelled = true;
    };
  }, [activate, beginPlaceOperation, canActivate, hostClient, opening, selectedTab]);
  useEffect(() => {
    if (
      selection.kind !== "place" ||
      selection.destination.kind !== "app" ||
      selection.destination.windowId !== undefined ||
      selection.destination.source?.kind !== "owner-view"
    )
      return;
    const source = selection.destination.source;
    const resolved = places.find(
      (place) =>
        place.ownerView?.viewId === source.viewId &&
        place.ownerView.generation === source.generation,
    );
    if (resolved?.destination.kind === "app" && resolved.destination.windowId !== undefined)
      nav.succeedPlace(resolved.destination);
  }, [nav, places, selection]);
  if (live && placeKey) known.current.set(placeKey, live);
  const place = live ?? (placeKey ? (known.current.get(placeKey) ?? null) : null);
  // The window is named for the tab in the middle, as a browser's window is.
  const windowTitle =
    selection.kind === "place" && place ? `${place.title} — Opensteer` : "Opensteer";
  useEffect(() => {
    document.title = windowTitle;
  }, [windowTitle]);
  useEffect(
    () => () => {
      document.title = "Opensteer";
    },
    [],
  );

  const openMark = useCallback(
    (threadId: string) => {
      if (place) nav.showPlaceWithConversation(place.destination, nav.threadPath(threadId));
    },
    [nav, place],
  );
  const markFallback = useCallback(
    () => document.querySelector<HTMLElement>(".place .browser-address__input, .place button"),
    [],
  );
  // Who is there now: an ended place has nobody in it.
  const marks = live ? (
    <OccupantMarks
      className="place__marks"
      directory={directory}
      fallbackFocus={markFallback}
      onOpen={openMark}
      occupants={live.occupants}
      placeTitle={live.title}
      size={20}
    />
  ) : null;

  if (selection.kind === "talk") return null;
  if (selection.kind === "launcher") {
    return (
      <section aria-label="New tab" className="place place--launcher">
        <StartPageSlot
          band={launcherBand}
          hostClient={hostClient}
          leading={leading}
          trailing={trailing}
        />
      </section>
    );
  }
  if (selection.kind === "pending")
    return (
      <PendingBrowserTabView
        hostClient={hostClient}
        idempotencyKey={selection.idempotencyKey}
        leading={leading}
        trailing={trailing}
      />
    );
  const { destination } = selection;
  if (destination.kind === "opensteer-app" && live) return null;
  // The address is the person's to type; a tab id it names is checked before use.
  const tabId =
    destination.kind === "browser" && destination.tabId
      ? (BrowserSurfaceIdSchema.safeParse(destination.tabId).data ?? null)
      : null;
  return (
    <section
      aria-label={place?.title ?? "Place"}
      className={`place place--${destination.kind}`}
      data-place-key={placeKey ?? ""}
    >
      {destination.kind === "browser" ? (
        tabId ? (
          <PlaceBrowserView
            activationError={activationError?.tabId === tabId ? activationError.message : null}
            chromeSignIn={chromeSignIn}
            connected={connected}
            lastingReason={lastingReason}
            onRetry={() => setRetry((value) => value + 1)}
            compact={phone}
            pair={pair}
            marks={marks}
            hostClient={hostClient}
            leading={leading}
            onLeavePage={leaveToComposer}
            onReportError={onReportError}
            place={place}
            presentation={presentations.bySession.get(destination.sessionId) ?? null}
            sessionId={destination.sessionId}
            tabId={tabId}
            trailing={trailing}
            visible={pageVisible}
          />
        ) : (
          <div className="browser-view">
            <div className="browser-toolbar surface-row" ref={toolbarRef}>
              {leading}
              <span className="launcher__spacer" />
              {trailing}
            </div>
            <div className="browser-stage">
              <div className="place-state" role="status">
                <p className="place-state__title">This tab isn’t available</p>
              </div>
            </div>
          </div>
        )
      ) : destination.kind === "opensteer-app" ? (
        <AppTabGone
          destination={destination}
          hostClient={hostClient}
          leading={leading}
          trailing={trailing}
        />
      ) : destination.kind === "phone" ? (
        <PhoneTab
          destination={destination}
          hostClient={hostClient}
          hostConnected={hostConnected}
          inFront={pageVisible}
          leading={leading}
          marks={marks}
          place={live}
          trailing={trailing}
        />
      ) : destination.source?.kind === "owner-view" ? (
        <OwnerView
          destination={destination}
          marks={marks}
          hostClient={hostClient}
          hostConnected={hostConnected}
          key={`${destination.source.viewId}:${destination.source.generation}`}
          leading={leading}
          place={place}
          trailing={trailing}
        />
      ) : destination.computerSessionId === undefined ? (
        <>
          <div className="surface-row">
            {leading}
            <span className="launcher__spacer" />
            {trailing}
          </div>
          <div className="place-state" role="status">
            This view is not available in this client.
          </div>
        </>
      ) : (
        <ComputerWatchView
          app={place?.icon.kind === "app" ? place.icon.app : null}
          appKey={destination.appKey}
          marks={marks}
          hostClient={hostClient}
          hostConnected={hostConnected}
          key={placeKey}
          leading={leading}
          machineId={destination.machineId || null}
          machines={hostClient.getSnapshot().machines}
          sessionId={destination.computerSessionId}
          trailing={trailing}
          visible
        />
      )}
    </section>
  );
}

/**
 * The start page, fresh for each opening and kept through a change of
 * conversation, which carries no history state of its own: the opening's id,
 * the place it was opened from and any link it opens are read once, as it opens.
 */
/** A phone's one tab: the person's own view, with the task's Watch until that view is there. */
function PhoneTab({
  destination,
  hostClient,
  hostConnected,
  inFront,
  leading,
  marks,
  place,
  trailing,
}: {
  readonly destination: Extract<WorkspaceSurfaceDestination, { kind: "phone" }>;
  readonly hostClient: HostClient;
  readonly hostConnected: boolean;
  readonly inFront: boolean;
  readonly leading: ReactNode;
  readonly marks: ReactNode;
  readonly place: PlaceItem | null;
  readonly trailing: ReactNode;
}) {
  const opening = usePhoneTabView(hostClient, destination.machineId, inFront);
  if (place?.task && !place.ownerView)
    return (
      <ComputerWatchView
        app={null}
        appKey={null}
        marks={marks}
        hostClient={hostClient}
        hostConnected={hostConnected}
        key={place.task.sessionId}
        leading={leading}
        machineId={destination.machineId}
        machines={hostClient.getSnapshot().machines}
        sessionId={place.task.sessionId}
        trailing={trailing}
        visible
      />
    );
  const view = place?.ownerView ?? null;
  return (
    <OwnerView
      destination={destination}
      marks={marks}
      hostClient={hostClient}
      hostConnected={hostConnected}
      key={view ? `${view.viewId}:${view.generation}` : "open"}
      leading={leading}
      opening={opening}
      place={place}
      source={
        view ? { kind: "owner-view", viewId: view.viewId, generation: view.generation } : null
      }
      trailing={trailing}
    />
  );
}

function StartPageSlot({
  band,
  hostClient,
  leading,
  trailing,
}: {
  readonly hostClient: HostClient;
  readonly leading: ReactNode;
  readonly trailing: ReactNode;
  readonly band: ReactNode;
}) {
  const { state } = useLocation();
  const opening = useRef<{
    readonly id: string;
    readonly from: string | null;
    readonly link: StartPageLink | null;
  } | null>(null);
  const id = startPageOpening(state);
  if (opening.current === null || (id !== "" && id !== opening.current.id))
    opening.current = { id, from: startPageOrigin(state), link: startPageLink(state) };
  return (
    <StartPage
      band={band}
      link={opening.current.link}
      from={opening.current.from}
      hostClient={hostClient}
      key={opening.current.id}
      leading={leading}
      trailing={trailing}
    />
  );
}

/** F6 from inside a page hands the keyboard to the conversation's composer. */
function leaveToComposer() {
  const composer = document.querySelector<HTMLElement>("[data-composer-input]");
  if (composer) composer.focus();
  else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

/** Below 1200px: the sidebar's way in, carrying how many tasks need the reader. */
/** `countYield` is the rank at which a bar may give up the count for room; the sidebar shows it too. */
export function DrawerButton({ countYield }: { readonly countYield?: number } = {}) {
  const { attention: count, openDrawer } = useWorkspace();
  return (
    <button
      aria-controls="app-sidebar"
      aria-label={count > 0 ? `Open sidebar, ${count} need you` : "Open sidebar"}
      className="drawer-btn"
      onClick={openDrawer}
      type="button"
    >
      <Icon name="panel" />
      {count > 0 ? (
        <span aria-hidden className="side-needs side-needs--inline" data-yield={countYield}>
          <span className="side-needs__bang">!</span>
          {count}
        </span>
      ) : null}
    </button>
  );
}

/**
 * The conversation beside the computer is put away and brought back from one
 * spot at the end of the computer's bar: a quiet panel button while it is
 * open, and its mark and name, a press from coming back, while it is away.
 */
function ChatToggle({ directory }: { readonly directory: TaskDirectory }) {
  const { dock } = useWorkspace();
  const { pathname } = useLocation();
  if (dock.open)
    return (
      <button
        aria-controls="workspace-conversation"
        aria-expanded
        aria-label="Hide the conversation"
        className="icon-btn chat-toggle"
        onClick={() => {
          dock.close();
          requestAnimationFrame(() => document.querySelector<HTMLElement>(".chat-btn")?.focus());
        }}
        title="Hide the conversation"
        type="button"
      >
        <Icon name="panel" />
      </button>
    );
  const threadId = conversationAt(pathname, directory.homeThreadId);
  // "/" is Chat even before Chat has a Thread.
  const home = pathname === "/" || (threadId !== null && threadId === directory.homeThreadId);
  const row = threadId ? directory.rows.get(threadId) : undefined;
  const title = home ? CHAT_THREAD_TITLE : (row?.title ?? "Conversation");
  return (
    <button
      aria-controls="workspace-conversation"
      aria-expanded={false}
      aria-label={`Show the conversation: ${title}`}
      className="chat-btn"
      onClick={() => {
        dock.show();
        requestAnimationFrame(() =>
          document.querySelector<HTMLElement>("[data-composer-input]")?.focus(),
        );
      }}
      title="Show the conversation"
      type="button"
    >
      {home ? (
        <ChatOrb size={16} />
      ) : threadId ? (
        <span className="task-request-mark">
          <TaskMark size={16} mark={threadMark(threadId, directory.snapshot)} />
          <TaskBadge state={row?.tone ?? "working"} />
        </span>
      ) : (
        <Icon name="message" />
      )}
      <span>{title}</span>
    </button>
  );
}
