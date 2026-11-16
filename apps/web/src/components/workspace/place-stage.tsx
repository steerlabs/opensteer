import { actingOccupants, threadMark } from "@opensteer/client/host";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router";
import type { ReactNode } from "react";
import type { HostClient, PlaceItem } from "@opensteer/client/host";
import { BrowserSurfaceIdSchema, type TabId } from "@opensteer/core";
import { useHostSelector, usePlace, usePlaceActivity, usePlaceList } from "@opensteer/client/react";
import { usePageVisible } from "../../ui-utils.js";
import { PlaceBrowserView, type BrowserChromeSignIn } from "../browser/browser-view.js";
import { useBrowserThreadPair } from "../browser/browser-thread-pair.js";
import { Icon } from "../icon.js";
import { useToastToolbar } from "../toast.js";
import { SidebarRestoreButton } from "../sidebar-chrome.js";
import { TaskMark, TaskBadge } from "./task-mark.js";
import { AppTab } from "./app-tab.js";
import { useListedBrowserPresentations } from "./identity.js";
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
      place.kind === "app" ? [[place.key as string, place] as const] : [],
    ),
  );
  const selected =
    selection.kind === "place" && open.has(selection.destination.tabId)
      ? selection.destination.tabId
      : null;
  const shown = useRef(new Set<string>());
  for (const appId of shown.current) if (!open.has(appId)) shown.current.delete(appId);
  if (selected && open.has(selected)) shown.current.add(selected);
  return [...shown.current].map((tabId) => (
    <AppTab
      directory={directory}
      hostClient={hostClient}
      key={tabId}
      leading={leading}
      place={open.get(tabId)!}
      selected={tabId === selected}
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
  const presentations = useListedBrowserPresentations(hostClient);
  const pageVisible = usePageVisible();
  const known = useRef(new Map<string, PlaceItem>());
  const placeKey = selection.kind === "place" ? destinationPlaceKey(selection.destination) : null;
  const live = usePlace(hostClient, placeKey) ?? null;
  const activity = usePlaceActivity(hostClient, placeKey ?? "");
  const liveOccupants = useMemo(
    () => (live ? actingOccupants(live.occupants, activity) : null),
    [live, activity],
  );
  const viewer = useHostSelector(hostClient, () =>
    placeKey === null ? null : hostClient.tabViewer(placeKey),
  );
  const pageSession = viewer?.kind === "page" ? viewer.sessionId : null;
  // The page view stays mounted from page to page, as a browser's does: while a newly selected
  // page activates, it holds the last page's picture and waits for this page's own binding.
  const lastPageSession = useRef<string | null>(null);
  if (pageSession) lastPageSession.current = pageSession;
  const dockedThread = !phone && dock.open ? conversationAt(pathname) : null;
  const showBrowserTab = useCallback(
    (destination: { readonly tabId: TabId }, options: { replace: boolean }) =>
      nav.showPlace({ kind: "tab", tabId: destination.tabId }, options),
    [nav],
  );
  const pair = useBrowserThreadPair({
    hostClient,
    mark: dockedThread ? (
      <TaskMark mark={threadMark(dockedThread, directory.snapshot)} size={16} />
    ) : null,
    onShow: showBrowserTab,
    shown: live?.kind === "page" ? { tabId: live.key } : null,
    threadId: live?.kind === "page" ? dockedThread : null,
  });
  const [activation, setActivation] = useState<{
    readonly tabId: string;
    readonly state: "activating" | "failed";
    readonly message?: string;
  } | null>(null);
  const [retry, setRetry] = useState(0);
  // The person's Open of this tab: spent by its first activation, renewed by Try again or Reopen.
  // Only it may wake a phone; reactivating an expired view never does.
  const open = useRef<{ tabId: string | null; wake: boolean }>({ tabId: placeKey, wake: true });
  if (open.current.tabId !== placeKey) open.current = { tabId: placeKey, wake: true };
  const tabState = live?.tab.state;
  const kind = live?.kind;
  // Selecting a tab opens (or wakes) this device's view of it; an unavailable tab says why instead.
  const viewerReady =
    viewer !== null &&
    (viewer.kind === "app" ||
      (viewer.kind === "page" && tabState === "open") ||
      ((viewer.kind === "window" || viewer.kind === "phone") &&
        viewer.view.state !== "closed" &&
        viewer.view.state !== "expired"));
  const needsActivation = placeKey !== null && !!kind && tabState !== "unavailable" && !viewerReady;
  // A re-render, StrictMode or a second opening while one activation is on its way joins it.
  const pendingActivation = useRef<{
    readonly tabId: string;
    readonly done: Promise<unknown>;
  } | null>(null);
  useLayoutEffect(() => {
    if (!needsActivation || placeKey === null) return;
    let cancelled = false;
    setActivation({ tabId: placeKey, state: "activating" });
    let pending = pendingActivation.current;
    if (pending?.tabId !== placeKey) {
      const done = hostClient.activateTab(placeKey, { wake: open.current.wake });
      open.current.wake = false;
      pending = pendingActivation.current = { tabId: placeKey, done };
      const settled = () => {
        if (pendingActivation.current === pending) pendingActivation.current = null;
      };
      done.then(settled, settled);
    }
    pending.done.then(
      () => {
        if (!cancelled) setActivation(null);
      },
      (error: unknown) => {
        if (!cancelled)
          setActivation({
            tabId: placeKey,
            state: "failed",
            message: error instanceof Error ? error.message : "This tab could not open.",
          });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [hostClient, needsActivation, placeKey, retry]);
  const activationError =
    activation?.tabId === placeKey && activation.state === "failed"
      ? (activation.message ?? null)
      : null;
  const reopenView = useCallback(async () => {
    if (placeKey !== null) await hostClient.activateTab(placeKey, { wake: true });
  }, [hostClient, placeKey]);
  if (live && placeKey) known.current.set(placeKey, live);
  // A tab just closed keeps its chrome until its successor takes the middle.
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
  const marks =
    live && liveOccupants ? (
      <OccupantMarks
        className="place__marks"
        directory={directory}
        fallbackFocus={markFallback}
        onOpen={openMark}
        occupants={liveOccupants}
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
  if (place?.kind === "app") return null;
  // The address is the person's to type; a tab id it names is checked before use.
  const tabId = BrowserSurfaceIdSchema.safeParse(destination.tabId).data ?? null;
  return (
    <section
      aria-label={place?.title ?? "Tab"}
      className={`place place--${place?.kind ?? "tab"}`}
      data-place-key={placeKey ?? ""}
    >
      {place?.kind === "window" || place?.kind === "phone" ? (
        <OwnerView
          hostClient={hostClient}
          hostConnected={hostConnected}
          key={placeKey}
          leading={leading}
          machineId={place.device.machineId}
          marks={marks}
          onReopen={reopenView}
          opening={activation?.tabId === placeKey && activation.state === "activating"}
          phone={place.kind === "phone"}
          place={place}
          source={
            (viewer?.kind === "window" || viewer?.kind === "phone") && viewer.view
              ? {
                  kind: "owner-view",
                  viewId: viewer.view.viewId,
                  generation: viewer.view.generation,
                }
              : null
          }
          trailing={trailing}
        />
      ) : place?.kind === "page" && tabId && !(pageSession ?? lastPageSession.current) ? (
        <div className="browser-view">
          <div className="browser-toolbar surface-row" ref={toolbarRef}>
            {leading}
            <span className="launcher__spacer" />
            {trailing}
          </div>
          <div className="browser-stage">
            <div className="place-state" role="status">
              {place.unavailableReason || activationError ? (
                <>
                  <p className="place-state__title">{place.unavailableReason ?? activationError}</p>
                  {activationError ? (
                    <button
                      className="btn btn--small"
                      onClick={() => {
                        open.current.wake = true;
                        setRetry((value) => value + 1);
                      }}
                      type="button"
                    >
                      Try again
                    </button>
                  ) : null}
                </>
              ) : (
                <span aria-label={`Opening ${place.title}`} className="spinner" />
              )}
            </div>
          </div>
        </div>
      ) : place?.kind === "page" && tabId ? (
        <PlaceBrowserView
          activationError={activationError}
          awaitingBinding={pageSession === null}
          chromeSignIn={chromeSignIn}
          connected={hostConnected}
          lastingReason={place.unavailableReason}
          onRetry={() => {
            open.current.wake = true;
            setRetry((value) => value + 1);
          }}
          compact={phone}
          pair={pair}
          marks={marks}
          hostClient={hostClient}
          leading={leading}
          onLeavePage={leaveToComposer}
          onReportError={onReportError}
          place={place}
          presentation={presentations.byTab.get(tabId) ?? null}
          sessionId={(pageSession ?? lastPageSession.current)!}
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
      )}
    </section>
  );
}

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
  const threadId = conversationAt(pathname);
  const row = threadId ? directory.rows.get(threadId) : undefined;
  const title = row?.title ?? (pathname === "/" ? "New task" : "Conversation");
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
      {threadId ? (
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
