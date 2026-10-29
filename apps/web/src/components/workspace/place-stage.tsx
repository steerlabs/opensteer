import { browserPlaceUnavailableReason, threadMark } from "@opensteer/client/host";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import type { ReactNode } from "react";
import type { HostClient, PlaceItem } from "@opensteer/client/host";
import { BrowserSurfaceIdSchema, CHAT_THREAD_TITLE } from "@opensteer/core";
import { useHostSelector, usePlaceList } from "@opensteer/client/react";
import { usePageVisible } from "../../ui-utils.js";
import { PlaceBrowserView, type BrowserChromeSignIn } from "../browser/browser-view.js";
import { ComputerWatchView } from "../computer-watch.js";
import { Icon } from "../icon.js";
import { useToastToolbar } from "../toast.js";
import { SidebarRestoreButton } from "../sidebar-chrome.js";
import { TaskMark, TaskBadge, ChatOrb } from "./task-mark.js";
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
import { useTaskDirectory, type TaskDirectory } from "./task-directory.js";
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
  const { dock, drawer, localMachine, nav, phone, selection } = useWorkspace();
  const toolbarRef = useToastToolbar();
  const places = usePlaceList(hostClient);
  const directory = useTaskDirectory(hostClient);
  const presentations = useBrowserPresentations(places, localMachine?.machineId ?? null);
  const pageVisible = usePageVisible();
  const known = useRef(new Map<string, PlaceItem>());
  const placeKey = selection.kind === "place" ? destinationPlaceKey(selection.destination) : null;
  const selectedTab =
    selection.kind === "place" && selection.destination.kind === "browser"
      ? selection.destination.tabId
      : null;
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
    if (!selectedTab || !durable || !activate) return;
    if (rowState === "live") {
      if (
        selection.kind === "place" &&
        selection.destination.kind === "browser" &&
        currentSessionId &&
        currentSessionId !== selection.destination.sessionId
      )
        nav.succeedPlace({ kind: "browser", sessionId: currentSessionId, tabId: selectedTab });
      return;
    }
    if (lastingReason) return;
    let cancelled = false;
    const finish = nav.beginPlaceOperation({ replace: true });
    setActivationError(null);
    void activate
      .call(hostClient, selectedTab)
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
  }, [
    activate,
    currentSessionId,
    durable?.lineageId,
    hostClient,
    lastingReason,
    nav,
    retry,
    rowState,
    selectedTab,
    selection,
  ]);
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

  const leading = drawer ? <DrawerButton /> : <SidebarRestoreButton />;
  const trailing = !dock.open && !phone ? <ChatButton directory={directory} /> : null;
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
        <StartPageSlot hostClient={hostClient} leading={leading} trailing={trailing} />
      </section>
    );
  }
  const { destination } = selection;
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
        <div className="place-state" role="status">
          This view is not available in this client.
        </div>
      ) : (
        <ComputerWatchView
          app={place?.icon.kind === "app" ? place.icon.app : null}
          appKey={destination.kind === "app" ? destination.appKey : null}
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
});

/**
 * The start page, fresh for each opening and kept through a change of
 * conversation, which carries no history state of its own: the opening's id,
 * the place it was opened from and any link it opens are read once, as it opens.
 */
function StartPageSlot({
  hostClient,
  leading,
  trailing,
}: {
  readonly hostClient: HostClient;
  readonly leading: ReactNode;
  readonly trailing: ReactNode;
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
export function DrawerButton() {
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
        <span aria-hidden className="side-needs side-needs--inline">
          <span className="side-needs__bang">!</span>
          {count}
        </span>
      ) : null}
    </button>
  );
}

/** The conversation, put away: its mark and name, a press from coming back. */
function ChatButton({ directory }: { readonly directory: TaskDirectory }) {
  const { dock } = useWorkspace();
  const { pathname } = useLocation();
  const threadId =
    pathname === "/"
      ? directory.homeThreadId
      : pathname.startsWith("/threads/")
        ? decodeURIComponent(pathname.slice("/threads/".length))
        : null;
  // "/" is Chat even before Chat has a Thread.
  const home = pathname === "/" || (threadId !== null && threadId === directory.homeThreadId);
  const row = threadId ? directory.rows.get(threadId) : undefined;
  const title = home ? CHAT_THREAD_TITLE : (row?.title ?? "Conversation");
  return (
    <button
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
