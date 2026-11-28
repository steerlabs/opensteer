import { agentSessionSlot } from "@opensteer/client/host";
import { TabAgentStatus } from "../agent-work.js";
import {
  actingOccupants,
  tabAskStep,
  tabAsleepAfterAnswer,
  tabViewerStands,
  threadMark,
  type TabAsk,
} from "@opensteer/client/host";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router";
import type { ReactNode } from "react";
import type { HostClient, PlaceItem } from "@opensteer/client/host";
import { BrowserSurfaceIdSchema, type TabId } from "@opensteer/core";
import {
  useHostSelector,
  useOwnerViewReconnect,
  usePlace,
  usePlaceActivity,
  usePlaceList,
} from "@opensteer/client/react";
import { usePageVisible } from "../../ui-utils.js";
import {
  BrowserOpening,
  PlaceBrowserView,
  type BrowserChromeSignIn,
} from "../browser/browser-view.js";
import { Icon } from "../icon.js";
import { useToastToolbar } from "../toast.js";
import { ConnectedAgentsHeader, SidebarRestoreButton } from "../sidebar-chrome.js";
import { TaskMark, TaskBadge } from "./task-mark.js";
import { AppTab } from "./app-tab.js";
import { useListedBrowserPresentations } from "./identity.js";
import { OwnerView } from "./owner-view.js";
import { StartPage } from "./start-page.js";
import { TaskAppWatchPane } from "./task-app-watch.js";
import { useWatchPlaceWait } from "./watch-follow.js";
import {
  destinationPlaceKey,
  startPageLink,
  startPageOpening,
  startPageOrigin,
  type StartPageLink,
} from "./navigation.js";
import { OccupantMarks } from "./occupant-marks.js";
import { conversationAt, useTaskDirectory, type TaskDirectory } from "./task-directory.js";
import { useWorkspace, useWorkspaceAttention } from "./workspace-context.js";

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
      leading={tabId === selected ? leading : null}
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
  const { nav, phone, selection } = useWorkspace();
  const toolbarRef = useToastToolbar();
  const presentations = useListedBrowserPresentations(hostClient);
  const pageVisible = usePageVisible();
  const { pathname, state: entryState } = useLocation();
  const watchPlaceWait = useWatchPlaceWait(hostClient, conversationAt(pathname));
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
  const [activation, setActivation] = useState<{
    readonly tabId: string;
    readonly state: "activating" | "failed";
    readonly message?: string;
    /** The ask this state belongs to: only its own answer may end it. */
    readonly request?: unknown;
  } | null>(null);
  const [retry, setRetry] = useState(0);
  // The person's Open of this tab: spent by its first activation, renewed by Try again or Reopen.
  // Only it may wake a phone; reactivating an expired view never does.
  const open = useRef<{ tabId: string | null; wake: boolean }>({ tabId: placeKey, wake: true });
  if (open.current.tabId !== placeKey) open.current = { tabId: placeKey, wake: true };
  const tabState = live?.tab.state;
  const kind = live?.kind;
  const reconnect = useOwnerViewReconnect(
    hostClient,
    pageVisible &&
      (kind === "window" || kind === "phone") &&
      (tabState !== "unavailable" || live?.tab.unavailableCode === "computer-offline")
      ? placeKey
      : null,
  );
  // V8: this device's last answered ask for the tab in the middle, with what its answer said of
  // the tab and the Try again it answered. What comes next is decided by it and the tab's row.
  const [ask, setAsk] = useState<{
    readonly tabId: string;
    readonly retry: number;
    readonly answer: TabAsk;
  } | null>(null);
  const askOf = ask?.tabId === placeKey ? ask : null;
  // Selecting a tab opens (or wakes) this device's view of it; an unavailable tab says why instead.
  // A viewer this device's own ask did not answer stands as long as its tab is open.
  const step =
    viewer === null
      ? ("ask-again" as const)
      : askOf
        ? tabAskStep(viewer, askOf.answer, live?.tab)
        : tabViewerStands(viewer, tabState)
          ? ("show" as const)
          : ("ask-again" as const);
  // A tab still asleep after its answer is asked for again only by Try again. Nothing asks while
  // the page is hidden: the Home lets a tab nobody sees sleep, and asking would wake it again.
  // The moment the page is seen, it asks.
  const needsActivation =
    pageVisible &&
    placeKey !== null &&
    !!kind &&
    tabState !== "unavailable" &&
    (step === "ask-again" || (step === "asleep" && askOf?.retry !== retry));
  // A re-render, StrictMode or a second opening while one activation is on its way joins it.
  const pendingActivation = useRef<{
    readonly tabId: string;
    readonly done: Promise<unknown>;
    answeredState: TabAsk["answeredState"];
  } | null>(null);
  useLayoutEffect(() => {
    if (!needsActivation || placeKey === null || reconnect.getSnapshot() !== "idle") return;
    let cancelled = false;
    let pending = pendingActivation.current;
    if (pending?.tabId !== placeKey) {
      const asked: {
        tabId: string;
        done: Promise<unknown>;
        answeredState: TabAsk["answeredState"];
      } = { tabId: placeKey, done: Promise.resolve(), answeredState: null };
      asked.done = hostClient.activateTab(placeKey, {
        wake: open.current.wake,
        answered: (tab) => {
          asked.answeredState = tab.state;
        },
      });
      const done = asked.done;
      open.current.wake = false;
      pending = pendingActivation.current = asked;
      const settled = () => {
        if (pendingActivation.current === pending) pendingActivation.current = null;
      };
      done.then(settled, settled);
    }
    const answered = pending;
    setActivation({ tabId: placeKey, state: "activating", request: answered });
    // An activation this run began ends with its answer even when the run was left: a tab that
    // turned unavailable on its way (its app quit) asks nothing more, and must not say Opening.
    // Only its own: a newer ask of the same tab keeps saying Opening until its own answer.
    const ended = () =>
      setActivation((current) =>
        current?.request === answered && current.state === "activating" ? null : current,
      );
    pending.done.then(
      () => {
        if (cancelled) {
          ended();
          return;
        }
        setActivation(null);
        setAsk({
          tabId: placeKey,
          retry,
          answer: {
            answeredState: answered.answeredState,
            rowAtAnswer: hostClient.getSnapshot().tabs.get(placeKey as TabId),
          },
        });
      },
      () => {
        // The tab's own fact; why the browser didn't start is never shown as raw text.
        if (cancelled) ended();
        else
          setActivation({ tabId: placeKey, state: "failed", message: "This tab could not open." });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [hostClient, needsActivation, placeKey, reconnect.getSnapshot, retry]);
  const activationError =
    activation?.tabId === placeKey && activation.state === "failed"
      ? (activation.message ?? null)
      : step === "asleep" && !(activation?.tabId === placeKey && activation.state === "activating")
        ? tabAsleepAfterAnswer
        : null;
  const reopenView = useCallback(async () => {
    reconnect.reset();
    if (placeKey !== null) await hostClient.activateTab(placeKey, { wake: true });
  }, [hostClient, placeKey, reconnect.reset]);
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

  if (nav.pendingPlace !== null) {
    return (
      <section aria-label="Opening tab" className="place place--page">
        <div className="browser-view">
          <div className="browser-toolbar surface-row">
            {leading}
            <span className="browser-pending-address">{nav.pendingPlace}</span>
            {trailing}
          </div>
          <div className="browser-stage">
            <div className="place-state" role="status">
              <BrowserOpening address={nav.pendingPlace} />
            </div>
          </div>
        </div>
      </section>
    );
  }
  if (selection.kind === "talk") return null;
  if (selection.kind === "launcher") {
    if (watchPlaceWait && startPageOpening(entryState) === "") {
      return (
        <section aria-label="Watch" className="place place--page">
          <div className="browser-toolbar surface-row">
            {leading}
            {trailing}
          </div>
          <div className="browser-stage">
            <div className="place-state" role="status">
              {watchPlaceWait === "waiting"
                ? "Waiting for the agent’s page…"
                : "The agent’s work ended before anything was available to watch."}
            </div>
          </div>
        </section>
      );
    }
    const startPage = (
      <section aria-label="New tab" className="place place--launcher">
        <StartPageSlot hostClient={hostClient} leading={leading} trailing={trailing} />
      </section>
    );
    // A start page the person asked for (New tab) is one. Otherwise a task whose agent is using
    // a Mac app shows that app where the launcher would be: Watch, the monitor button, a reload.
    if (startPageOpening(entryState) !== "") return startPage;
    const threadId = conversationAt(pathname);
    const slot = threadId ? agentSessionSlot(directory.snapshot, threadId) : null;
    return (
      <TaskAppWatchPane
        agentName={slot?.connection.label ?? null}
        agentSessionId={slot?.status === "active" ? slot.sessionId : null}
        fallback={startPage}
        hostClient={hostClient}
        hostConnected={hostConnected}
        leading={leading}
        onTakeOver={(target) => {
          // Their own view of the same window, as a tab of theirs; a later choice supersedes it.
          const show = nav.beginPlaceOperation({ replace: true });
          void hostClient
            .openTab(target)
            .then((tab) => show({ kind: "tab", tabId: tab.tabId }), onReportError);
        }}
        threadId={threadId}
        trailing={trailing}
        visible={pageVisible}
      />
    );
  }
  const { destination } = selection;
  if (place?.kind === "app") return null;
  // The address is the person's to type; a tab id it names is checked before use.
  const tabId = BrowserSurfaceIdSchema.safeParse(destination.tabId).data ?? null;
  // A connected agent's own task in this tab: who, for which task, and its Stop.
  const sessionOccupant =
    live?.occupants.find(
      ({ threadId }) => agentSessionSlot(directory.snapshot, threadId) !== null,
    ) ?? null;
  return (
    <section
      aria-label={place?.title ?? "Tab"}
      className={`place place--${place?.kind ?? "tab"}`}
      data-place-key={placeKey ?? ""}
    >
      {tabId && sessionOccupant ? (
        <TabAgentStatus
          occupant={{
            threadId: sessionOccupant.threadId,
            title: directory.rows.get(sessionOccupant.threadId)?.title ?? "",
          }}
          tabId={tabId}
        />
      ) : null}
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
          reconnect={reconnect}
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
                <BrowserOpening
                  address={place.asleep ? (place.tab.url ?? place.title) : place.title}
                  waking={place.asleep}
                />
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
  const { openDrawer } = useWorkspace();
  const count = useWorkspaceAttention();
  return (
    <>
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
      <ConnectedAgentsHeader />
    </>
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
