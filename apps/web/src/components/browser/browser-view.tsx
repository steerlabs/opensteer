import { NativeAgentCursors } from "./native-agent-cursors.js";
import {
  nativeBrowserGeometry,
  useBrowserPresentationMode,
  useNativeBrowserPresentation,
} from "./native-browser-presentation.js";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  browserSessionIdentity,
  browserSiteForUrl,
  browserSiteLabel,
  browserTabCloseImpact,
  mutationIdempotencyKey,
  type BrowserCommand,
  type BrowserFrameView,
  type BrowserSessionSummary,
  type BrowserTabSummary,
  type HostClient,
  type HostSnapshot,
  type PlaceItem,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import type { BrowserSurfaceId } from "@opensteer/core";
import type { ChromeConnectEnvironment } from "../chrome/chrome-environment.js";
import { Icon } from "../icon.js";
import { SurfaceMenu, type SurfaceMenuItem } from "../surface-menu.js";
import { useToast } from "../toast.js";
import { AgentCursors } from "../workspace/agent-cursors.js";
import type { BrowserPresentation } from "../workspace/identity.js";
import { PlaceMark } from "../workspace/place-mark.js";
import { ProfileChip } from "../workspace/profile-chip.js";
import { useTabCloseAsking, useTabCloser } from "../workspace/tab-closer.js";
import { useBrowserCommandKeys } from "./browser-command-keys.js";
import { BrowserDownloads } from "./browser-downloads.js";
import { BrowserToolbar } from "./browser-chrome.js";
import { BrowserPageDialog } from "./browser-page-dialog.js";
import {
  BrowserProfilesDialog,
  SaveBrowserProfileDialog,
  runBrowserAction,
  type BrowserActionRunner,
} from "./browser-profiles.js";
import {
  BrowserSignInPopover,
  browserSignInLabel,
  signedInMessage,
  type BrowserSignInClient,
} from "./browser-sign-in.js";
import {
  BrowserViewport,
  NativeBrowserViewport,
  browserTargetViewport,
  type BrowserKeyboardHandle,
} from "./browser-viewport.js";

/** What signing a page in with Chrome needs from the Deployment on screen. */
export interface BrowserChromeSignIn {
  readonly client: BrowserSignInClient;
  readonly environment: ChromeConnectEnvironment;
  readonly online: boolean;
}

type BrowserSheet = "profiles" | "save";

interface BrowserReads {
  readonly session: BrowserSessionSummary | null;
  readonly profiles: HostSnapshot["browserProfiles"];
  readonly profileGrants: HostSnapshot["browserProfileGrants"];
  readonly workspaces: HostSnapshot["workspaces"];
  readonly workspaceId: string | null;
  readonly available: boolean;
}

function sameReads(left: BrowserReads, right: BrowserReads): boolean {
  return (
    left.session === right.session &&
    left.profiles === right.profiles &&
    left.profileGrants === right.profileGrants &&
    left.workspaces === right.workspaces &&
    left.workspaceId === right.workspaceId &&
    left.available === right.available
  );
}

/**
 * One exact browser tab in the middle: the desktop presents its local page;
 * other viewers draw its stream. Navigation and dialog answers name this tab,
 * without activating it for another viewer. Its marks say who is in the page.
 */
export function PlaceBrowserView({
  activationError,
  connected,
  lastingReason,
  onRetry,
  chromeSignIn,
  compact,
  marks,
  hostClient,
  leading,
  onLeavePage,
  onReportError,
  place,
  presentation,
  sessionId,
  tabId,
  trailing,
  visible,
}: {
  readonly activationError: string | null;
  readonly connected: boolean;
  readonly lastingReason: string | null;
  readonly onRetry: () => void;
  readonly chromeSignIn: BrowserChromeSignIn | null;
  /** A phone: navigation moves into the page's menu. */
  readonly compact: boolean;
  /** The tasks in this page, as buttons. */
  readonly marks: ReactNode;
  readonly hostClient: HostClient;
  /** First in the row: the drawer's button on narrow screens. */
  readonly leading: ReactNode;
  /** F6 in the page: where the keyboard goes next. */
  readonly onLeavePage: () => void;
  readonly onReportError: (error: unknown) => void;
  /** What the catalog last said about this tab, so the chrome outlives it. */
  readonly place: PlaceItem | null;
  /** Who the page browses as, in words: its profile and computer. */
  readonly presentation: BrowserPresentation | null;
  readonly sessionId: string;
  readonly tabId: BrowserSurfaceId;
  /** Last in the row: the conversation's button while it is put away. */
  readonly trailing: ReactNode;
  readonly visible: boolean;
}) {
  const select = useCallback(
    (snapshot: HostSnapshot): BrowserReads => ({
      available: snapshot.browserAvailable,
      profileGrants: snapshot.browserProfileGrants,
      profiles: snapshot.browserProfiles,
      session: snapshot.browserSessions.find((session) => session.id === sessionId) ?? null,
      workspaces: snapshot.workspaces,
      workspaceId:
        snapshot.workspaceTabs?.find((group) => group.tabs?.some((tab) => tab.id === tabId))
          ?.session.workspaceId ?? null,
    }),
    [sessionId, tabId],
  );
  const reads = useHostSelector(hostClient, select, sameReads);
  const { session } = reads;
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;
  const toast = useToast();
  const [actionError, setActionError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<BrowserSheet | null>(null);
  const [signInOpen, setSignInOpen] = useState(false);
  const [menuButton, setMenuButton] = useState<HTMLButtonElement | null>(null);
  const closeTab = useTabCloser();
  const askingClose = useTabCloseAsking();
  const [keyboardOffered, setKeyboardOffered] = useState(false);
  const [savedProfileName, setSavedProfileName] = useState<string | null>(null);
  const [fitAvailable, setFitAvailable] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const keyboardRef = useRef<BrowserKeyboardHandle | null>(null);
  const dormant = !!place?.workspaceTab && place.workspaceTab.state !== "live";
  const sessionReady = !dormant && session?.state === "ready";
  const mode = useBrowserPresentationMode(hostClient, sessionId, sessionReady);
  const native = mode.mode === "native";
  const [paintedTab, setPaintedTab] = useState<string | null>(null);
  const [fitPreview, setFitPreview] = useState(false);
  const [finding, setFinding] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const retained = useRef<{
    key: string;
    sessionId: string;
    surfaceId: string;
    release: () => void;
  } | null>(null);
  const retired = useRef<(() => void)[]>([]);
  const [retentionFailure, setRetentionFailure] = useState<{
    hostClient: HostClient;
    key: string;
    message: string;
  } | null>(null);
  const viewerKey = JSON.stringify([sessionId, tabId, native]);
  const retentionError =
    retentionFailure?.hostClient === hostClient && retentionFailure.key === viewerKey
      ? retentionFailure.message
      : null;

  const tabListed =
    session?.tabCatalog?.tabs.some((tab) => tab.id === tabId) ??
    session?.tabs.some((tab) => tab.id === tabId) ??
    false;
  // Held while the page is hidden as well: the client pauses its picture then and
  // keeps the last one, so showing the page again shows the tab at once.
  const watchable = sessionReady && tabListed;
  useLayoutEffect(() => {
    if (!watchable) {
      retained.current?.release();
      retained.current = null;
      for (const release of retired.current.splice(0)) release();
      return;
    }
    if (mode.error) {
      retained.current?.release();
      retained.current = null;
      for (const release of retired.current.splice(0)) release();
      return;
    }
    if (mode.mode === "pending") return;
    const key = viewerKey;
    if (retained.current?.key === key) return;
    try {
      const release = hostClient.retainBrowserViewer(sessionId, tabId, {
        picture: !native,
        captureRegion: true,
      });
      const previous = retained.current;
      if (previous) {
        const status = hostClient.browserViewerState(previous.sessionId, previous.surfaceId);
        if (status.admitted || status.status === "live") retired.current.push(previous.release);
        else previous.release();
      }
      retained.current = { key, release, sessionId, surfaceId: tabId };
      setRetentionFailure(null);
    } catch (error) {
      retained.current?.release();
      retained.current = null;
      for (const release of retired.current.splice(0)) release();
      setRetentionFailure({
        hostClient,
        key,
        message: error instanceof Error ? error.message : "This tab can’t be shown.",
      });
      onReportError(error);
    }
  }, [
    hostClient,
    mode.error,
    mode.mode,
    native,
    onReportError,
    sessionId,
    tabId,
    watchable,
    viewerKey,
  ]);
  useLayoutEffect(
    () => () => {
      retained.current?.release();
      retained.current = null;
      for (const release of retired.current.splice(0)) release();
    },
    [],
  );
  const subscribeViewer = useCallback(
    (listener: () => void) =>
      hostClient.subscribeBrowserViewer?.(sessionId, tabId, listener) ??
      hostClient.browserFrames.subscribe(sessionId, listener, tabId),
    [hostClient, sessionId, tabId],
  );
  const readViewer = useCallback(
    () => hostClient.browserViewerState(sessionId, tabId),
    [hostClient, sessionId, tabId],
  );
  const viewer = useSyncExternalStore(subscribeViewer, readViewer, readViewer);
  const handoff =
    !watchable || mode.error || viewer.error || retentionError
      ? "terminal"
      : viewer.admitted || viewer.status === "live"
        ? "admitted"
        : "pending";
  useLayoutEffect(() => {
    if (handoff !== "pending") for (const release of retired.current.splice(0)) release();
  }, [sessionId, tabId, handoff]);
  const nativePresentation = useNativeBrowserPresentation({
    active: mode.mode !== "streamed" && watchable && !mode.error,
    handoff,
    admissionId: viewer.admissionId,
    sessionId,
    surfaceId: tabId,
    stageRef,
  });
  const nativeTarget = nativePresentation.target;
  const focusPage = () => (native ? nativePresentation.focusPage() : keyboardRef.current?.focus());
  const live = sessionReady && tabListed && viewer.status === "live";
  const closeFind = () => {
    setFinding(false);
    setFindQuery("");
    if (nativePresentation.bridge && nativeTarget.current)
      void nativePresentation.bridge
        .stopFind(nativeTarget.current)
        .then(nativePresentation.focusPage)
        .catch(onReportError);
  };
  const find = (query: string, forward: boolean, findNext: boolean) => {
    const target = nativeTarget.current;
    if (!target || !nativePresentation.bridge) return;
    if (!query) {
      void nativePresentation.bridge.stopFind(target).catch(onReportError);
      return;
    }
    void nativePresentation.bridge
      .find({ ...target, query, forward, findNext })
      .catch(onReportError);
  };
  useEffect(() => {
    setFinding(false);
    setFindQuery("");
    setActionError(null);
    setSheet(null);
    setSignInOpen(false);
    setKeyboardOffered(false);
    setFitPreview(false);
    setDismissedError(null);
  }, [sessionId, tabId]);
  useEffect(() => {
    setSavedProfileName(null);
  }, [sessionId]);

  useEffect(() => {
    if (!visible) {
      setSheet(null);
      setSignInOpen(false);
    }
  }, [visible]);
  // Shift+F6 brings the keyboard back to the page it left.
  const pageReady = visible && live;
  // A page opened from the start page takes the keyboard its field gave up,
  // as a browser hands it to the page, once its first picture can take keys;
  // never from somewhere the keyboard is in use.
  const takeKeyboard = useRef(false);
  useEffect(() => {
    takeKeyboard.current =
      document.activeElement === null || document.activeElement === document.body;
  }, [sessionId, tabId]);
  useEffect(() => {
    if (!native || !nativePresentation.placement || !takeKeyboard.current) return;
    takeKeyboard.current = false;
    const active = document.activeElement;
    if (active === null || active === document.body) nativePresentation.focusPage();
  }, [native, nativePresentation.placement, nativePresentation.focusPage]);
  useEffect(() => {
    if (!pageReady) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== "F6" || !event.shiftKey || event.defaultPrevented) return;
      event.preventDefault();
      if (native) nativePresentation.focusPage();
      else keyboardRef.current?.focus();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [pageReady, native, nativePresentation.focusPage]);
  useEffect(() => {
    if (!keyboardOffered) return;
    const timer = window.setTimeout(() => setKeyboardOffered(false), 8_000);
    return () => window.clearTimeout(timer);
  }, [keyboardOffered]);

  const send = useCallback(
    (command: BrowserCommand) => {
      try {
        hostClient.sendBrowserCommand(sessionId, command);
      } catch (error) {
        onReportError(error);
      }
    },
    [hostClient, onReportError, sessionId],
  );
  const acceptFrame = useCallback(
    (frame: BrowserFrameView) => {
      setPaintedTab(`${sessionId}:${tabId}`);
      const token = frame.header.watchToken;
      if (token) hostClient.acceptBrowserWatchFrame(sessionId, token, tabId);
      if (!takeKeyboard.current) return;
      takeKeyboard.current = false;
      // After the presented picture has rendered, when the page can take keys.
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active === null || active === document.body) keyboardRef.current?.focus();
      });
    },
    [hostClient, sessionId, tabId],
  );
  const performAction: BrowserActionRunner = async (action) => {
    setActionError(null);
    return runBrowserAction(action, (error) => {
      if (currentSession.current === sessionId) setActionError(error);
    });
  };

  const tab: BrowserTabSummary | undefined = dormant
    ? undefined
    : session?.tabs.find((candidate) => candidate.id === tabId);
  const catalogTab = dormant
    ? undefined
    : session?.tabCatalog?.tabs.find((candidate) => candidate.id === tabId);
  const url = tab?.url ?? "";
  const shownTab: BrowserTabSummary | undefined =
    tab ??
    (catalogTab
      ? {
          active: false,
          id: catalogTab.id,
          title: catalogTab.title,
          url: catalogTab.site ?? "",
        }
      : place
        ? { active: false, id: tabId, title: place.title, url: place.site ?? "" }
        : undefined);
  const site = url ? browserSiteForUrl(url) : null;
  const dialog = session?.dialog && session.dialog.surfaceId === tabId ? session.dialog : null;
  const signIn = chromeSignIn && signInOpen && site !== null && live ? chromeSignIn : null;
  const blocked = sheet !== null || signIn !== null || askingClose;
  const pageReachable = live && !dialog;
  const workspace = reads.workspaces.find(
    (candidate) => candidate.id === (session?.workspaceId ?? reads.workspaceId),
  );
  const identity = browserSessionIdentity(session?.profileId ?? null, reads.profiles);
  const pageFollowsView = tab?.sizedByAgent !== undefined;
  const loading = place?.loading === true;
  useBrowserCommandKeys({
    visible,
    live: live && !dialog,
    native,
    loading,
    hardReload: session?.navigationVersion === 1,
    canGoBack: catalogTab?.canGoBack,
    canGoForward: catalogTab?.canGoForward,
    stageRef,
    surfaceId: tabId,
    finding,
    findQuery,
    setFinding,
    find,
    closeFind,
    stopFind: () => {
      if (nativePresentation.bridge && nativeTarget.current)
        void nativePresentation.bridge.stopFind(nativeTarget.current).catch(onReportError);
    },
    fullscreen: nativePresentation.fullscreen,
    exitFullscreen: () => {
      if (nativeTarget.current)
        void nativePresentation.bridge?.exitFullscreen(nativeTarget.current).catch(onReportError);
    },
    onLeavePage,
    // Declared below; called only from a key event, after render.
    stop: () => stop(),
    send,
    onReportError,
  });
  // The person's own address-bar navigation joins their recent sites when
  // the load it started ends, after any redirects —
  // not when it is asked for, and never for what an agent does in the page.
  // The intent lives for that one load; Stop clears it.
  const visit = useRef<{
    readonly from: string;
    readonly typed: boolean;
    readonly document: string | null;
    readonly at: number;
    readonly epoch: number;
    loading: boolean;
  } | null>(null);
  const documentId = catalogTab?.documentId ?? null;
  const visitIdentity = presentation?.identity ?? null;
  useEffect(() => {
    visit.current = null;
  }, [sessionId, tabId]);
  useEffect(() => {
    const pending = visit.current;
    if (!pending) return;
    if (!pending.loading) {
      // Nothing has happened in the page yet: the load it asked for has not begun.
      if (!loading && url === pending.from && documentId === pending.document) return;
      if (performance.now() - pending.at > visitStartMs) {
        visit.current = null;
        return;
      }
      pending.loading = true;
    }
    if (loading) return;
    visit.current = null;
    if (!url || !/^https?:\/\//iu.test(url)) return;
    if (visitIdentity?.kind === "profile")
      hostClient.recentSites.record(
        { kind: "profile", profileId: visitIdentity.profileId },
        url,
        pending.epoch,
        { title: tab?.title ?? "", typed: pending.typed },
      );
  }, [documentId, hostClient, loading, url, tab?.title, visitIdentity]);
  const navigateTo = (next: string, typed = true) => {
    visit.current = {
      at: performance.now(),
      document: documentId,
      epoch: hostClient.recentSites.epoch,
      from: url,
      typed,
      loading: false,
    };
    send({ surfaceId: tabId, type: "navigation.go", url: next });
  };
  const stop = () => {
    visit.current = null;
    send({ surfaceId: tabId, type: "navigation.stop" });
  };

  // Fit takes the page back from an agent's or another view's size: the
  // same floor-aware size this view follows on a desktop, the phone's own.
  const fit = () => {
    const rect = stageRef.current?.getBoundingClientRect();
    const size =
      native && rect
        ? { width: Math.round(rect.width), height: Math.round(rect.height) }
        : browserTargetViewport(rect ?? null, compact);
    if (size) send({ ...size, surfaceId: tabId, type: "viewport.set" });
  };
  const openSheet = (next: BrowserSheet) => {
    setActionError(null);
    setSheet(next);
  };

  const hasBrowser = session !== null || dormant;
  const menu: SurfaceMenuItem[] = hasBrowser
    ? [
        ...(compact
          ? [
              {
                disabled: !pageReachable || catalogTab?.canGoBack === false,
                icon: "arrow-left" as const,
                label: "Back",
                onSelect: () => send({ surfaceId: tabId, type: "navigation.back" }),
              },
              {
                disabled: !pageReachable || catalogTab?.canGoForward === false,
                icon: "arrow-right" as const,
                label: "Forward",
                onSelect: () => send({ surfaceId: tabId, type: "navigation.forward" }),
              },
              loading
                ? {
                    disabled: !pageReachable,
                    icon: "close" as const,
                    label: "Stop",
                    onSelect: stop,
                  }
                : {
                    disabled: !pageReachable,
                    icon: "reload" as const,
                    label: "Reload",
                    onSelect: () => send({ surfaceId: tabId, type: "navigation.reload" }),
                  },
              // A phone never resizes the page by itself, so a page an agent
              // sized wider than the screen is fitted from here.
              ...(fitAvailable
                ? [
                    {
                      disabled: !live,
                      icon: "fit" as const,
                      label: "Fit page to view",
                      onSelect: fit,
                    },
                  ]
                : []),
            ]
          : []),
        ...(chromeSignIn
          ? [
              {
                detail: site ? browserSiteLabel(site) : "Open a website first",
                disabled: !live || !chromeSignIn.online || dialog !== null || site === null,
                icon: "unlock" as const,
                label: browserSignInLabel,
                onSelect: () => setSignInOpen(true),
              },
            ]
          : []),
        ...(identity.fresh && !dormant
          ? savedProfileName !== null
            ? [
                {
                  detail: `Saved to “${savedProfileName}”`,
                  disabled: true,
                  icon: "check" as const,
                  label: "Sign-ins saved",
                },
              ]
            : [
                {
                  detail: "Keep what you signed in to for next time",
                  disabled: !sessionReady,
                  icon: "key" as const,
                  label: "Save sign-ins as a profile…",
                  onSelect: () => openSheet("save"),
                },
              ]
          : []),
        {
          icon: "shield",
          label: "Profiles and agent access…",
          onSelect: () => openSheet("profiles"),
        },
        {
          danger: true,
          detail:
            session && browserTabCloseImpact(session).discardsFreshSignIns
              ? "Its sign-ins are discarded"
              : undefined,
          disabled: !place?.closable,
          icon: "close",
          label: "Close tab",
          onSelect: () => {
            if (place) closeTab(place);
          },
        },
      ]
    : [];

  const sheets = (
    <>
      {sheet === "profiles" && workspace ? (
        <WorkspaceBrowserProfiles
          available={reads.available}
          hostClient={hostClient}
          onClose={() => setSheet(null)}
          profileGrants={reads.profileGrants}
          profiles={reads.profiles}
          workspace={workspace}
        />
      ) : null}
      {sheet === "save" && session ? (
        <SaveBrowserProfileDialog
          actionError={actionError}
          onClose={() => setSheet(null)}
          onSave={(name) =>
            hostClient
              .dispatch({
                idempotencyKey: mutationIdempotencyKey(`browser-save:${sessionId}`),
                input: { name },
                sessionId,
                type: "browser.session.profile.save",
              })
              .then(() => undefined)
          }
          onSaved={(name) => {
            if (currentSession.current !== sessionId) return;
            setSavedProfileName(name);
            setSheet(null);
          }}
          performAction={performAction}
        />
      ) : null}
    </>
  );

  const ended = lastingReason
    ? { title: lastingReason, detail: null }
    : activationError
      ? { title: activationError, detail: null }
      : dormant
        ? null
        : placeEnded(
            session,
            tabListed,
            viewer.error ?? retentionError ?? mode.error ?? nativePresentation.error,
          );
  const placement = nativePresentation.placement;
  const geometry = nativeBrowserGeometry(placement);
  const prePaint =
    !ended &&
    (dormant || !(mode.mode !== "streamed" ? placement : paintedTab === `${sessionId}:${tabId}`));
  const [waitingTab, setWaitingTab] = useState<string | null>(null);
  useEffect(() => {
    setWaitingTab(null);
    if (!prePaint || !visible) return;
    const timer = window.setTimeout(() => setWaitingTab(tabId), 1000);
    return () => window.clearTimeout(timer);
  }, [prePaint, tabId, visible]);
  const waiting = prePaint && waitingTab === tabId;

  const fitLabel = placement
    ? `Fit page to view: ${tab?.sizedByAgent ? "an agent set" : "page is"} ${placement.viewport.width} × ${placement.viewport.height}`
    : "Fit page to view";
  const nativeFitAvailable =
    geometry && (geometry.fitAvailable || geometry.sized || tab?.sizedByAgent === true);
  const notice =
    (sheet === null ? actionError : null) ??
    (!ended && session?.error !== dismissedError ? session?.error : null);
  const blankPage = url === "" || url === "about:blank";
  return (
    <>
      <div
        className={`browser-view${native ? " browser-view--native" : ""}`}
        data-browser-session={sessionId}
        data-browser-tab={tabId}
      >
        <BrowserToolbar
          activeTab={shownTab}
          omnibox={{
            hostClient,
            choice: session?.profileId
              ? { kind: "profile", profileId: session.profileId }
              : { kind: "guest" },
          }}
          chip={
            presentation ? (
              <ProfileChip
                disabled={!live}
                hostClient={hostClient}
                onManageProfiles={() => openSheet("profiles")}
                place={place}
                presentation={presentation}
              />
            ) : null
          }
          compact={compact}
          disabled={!pageReachable}
          focusAddress={live && blankPage}
          find={
            finding && native
              ? {
                  query: findQuery,
                  activeMatch: nativePresentation.findResult?.activeMatch ?? 0,
                  matches: nativePresentation.findResult?.matches ?? 0,
                  onQuery: (query) => {
                    setFindQuery(query);
                    find(query, true, false);
                  },
                  onStep: (forward) => find(findQuery, forward, true),
                  onClose: closeFind,
                }
              : null
          }
          notice={
            notice ? (
              <>
                <span>{notice}</span>
                <button
                  aria-label="Dismiss notice"
                  className="icon-btn"
                  type="button"
                  onClick={() => {
                    if (actionError) setActionError(null);
                    else setDismissedError(session?.error ?? null);
                  }}
                >
                  <Icon name="close" />
                </button>
              </>
            ) : null
          }
          leading={leading}
          loading={loading}
          mark={
            !shownTab?.url || shownTab.url === "about:blank" ? (
              <Icon name="search" />
            ) : place ? (
              <PlaceMark hostClient={hostClient} icon={place.icon} site={place.site} />
            ) : null
          }
          canGoBack={catalogTab?.canGoBack}
          canGoForward={catalogTab?.canGoForward}
          onBack={() => send({ surfaceId: tabId, type: "navigation.back" })}
          onForward={() => send({ surfaceId: tabId, type: "navigation.forward" })}
          onNavigate={navigateTo}
          onNavigated={focusPage}
          onReload={() => send({ surfaceId: tabId, type: "navigation.reload" })}
          onStop={stop}
          trailing={
            <>
              {marks}
              {(compact && !nativePresentation.fullscreen) ||
              !(native
                ? nativeFitAvailable || nativePresentation.fullscreen
                : fitAvailable) ? null : (
                <button
                  aria-label={
                    nativePresentation.fullscreen ? "Exit full screen" : "Fit page to view"
                  }
                  className="icon-btn browser-fit"
                  disabled={!live}
                  onClick={() => {
                    if (nativePresentation.fullscreen && nativeTarget.current)
                      void nativePresentation.bridge
                        ?.exitFullscreen(nativeTarget.current)
                        .catch(onReportError);
                    else fit();
                  }}
                  onMouseEnter={() => setFitPreview(true)}
                  onMouseLeave={() => setFitPreview(false)}
                  onFocus={() => setFitPreview(true)}
                  onBlur={() => setFitPreview(false)}
                  title={
                    nativePresentation.fullscreen
                      ? "Exit full screen"
                      : native
                        ? fitLabel
                        : "Fit page to view"
                  }
                  type="button"
                >
                  <Icon name={nativePresentation.fullscreen ? "compact" : "fit"} />
                </button>
              )}
              <BrowserDownloads />
              {menu.length > 0 ? (
                <SurfaceMenu
                  buttonRef={setMenuButton}
                  items={menu}
                  label="Browser options"
                  onOpen={() => setSignInOpen(false)}
                />
              ) : null}
              {trailing}
            </>
          }
        />
        <div className="browser-stage" ref={stageRef}>
          {!native && viewer.inputError ? (
            <div className="browser-action-error" role="status">
              {viewer.inputError}
            </div>
          ) : null}
          {ended ? (
            <div className="place-state" role="status">
              <p className="place-state__title">{ended.title}</p>
              {ended.detail ? <p className="place-state__detail">{ended.detail}</p> : null}
              {activationError && !lastingReason ? (
                <button className="btn" onClick={onRetry} type="button">
                  Try again
                </button>
              ) : null}
            </div>
          ) : dormant ? null : mode.mode !== "streamed" ? (
            <>
              <NativeBrowserViewport
                bounds={placement?.bounds ?? null}
                stage={placement?.stage ?? null}
                sized={geometry?.sized ?? false}
                previewing={fitPreview}
              />
              {placement && geometry ? (
                <NativeAgentCursors
                  geometry={geometry}
                  hostClient={hostClient}
                  // Each page is new cursors: none glides from the page before.
                  key={`browser:${placement.sessionId}:${placement.surfaceId}`}
                  placeKey={`browser:${placement.sessionId}:${placement.surfaceId}`}
                  placement={placement}
                />
              ) : null}
            </>
          ) : (
            <>
              <BrowserViewport
                activeSurfaceId={tabId}
                canInput={visible && pageReachable && !blocked}
                frames={hostClient.browserFrames}
                keyboardRef={keyboardRef}
                live={live}
                occluded={blocked}
                onCommand={send}
                onOpenLink={(url) => {
                  void hostClient.openBrowserTab(sessionId, { url }).catch(onReportError);
                }}
                onFitAvailable={setFitAvailable}
                onFramePresented={acceptFrame}
                onLeave={onLeavePage}
                onTouchTap={() => setKeyboardOffered(true)}
                pageFollowsView={pageFollowsView}
                phoneLayout={compact}
                sessionId={sessionId}
                targeted
                visible={visible}
              />
              <AgentCursors
                hostClient={hostClient}
                placeKey={place?.key ?? `browser:${sessionId}:${tabId}`}
                sessionId={sessionId}
                tabId={tabId}
                variant="middle"
              />
            </>
          )}
          {waiting ? (
            <div className="browser-status" role="status">
              {connected && (dormant || session?.state === "starting")
                ? "Starting browser…"
                : `Waiting for ${place?.device?.name ?? "computer"}…`}
            </div>
          ) : null}
          {!native && compact && keyboardOffered && pageReachable && !blocked ? (
            <button
              className="browser-keyboard-offer"
              onClick={() => {
                setKeyboardOffered(false);
                keyboardRef.current?.focus();
              }}
              type="button"
            >
              <Icon name="keyboard" />
              Keyboard
            </button>
          ) : null}
          {dialog && !ended ? (
            <BrowserPageDialog
              dialog={dialog}
              key={dialog.id}
              live={live}
              onAnswer={(accept, promptText) =>
                send({
                  accept,
                  dialogId: dialog.id,
                  ...(promptText === undefined ? {} : { promptText }),
                  surfaceId: tabId,
                  type: "dialog.respond",
                })
              }
              site={site ? browserSiteLabel(site) : null}
            />
          ) : null}
        </div>
      </div>
      {signIn && site !== null && menuButton && session ? (
        <BrowserSignInPopover
          anchor={menuButton}
          client={signIn.client}
          environment={signIn.environment}
          onClose={() => setSignInOpen(false)}
          onSignedIn={(outcome) => {
            send({ surfaceId: tabId, type: "navigation.reload" });
            toast.success(signedInMessage(outcome));
          }}
          sessionId={sessionId}
          site={site}
          url={url}
          workspaceId={session.workspaceId}
          workspaceName={workspace?.name ?? "this Workspace"}
        />
      ) : null}
      {sheets}
    </>
  );
}

/** A navigation that takes longer than this to commit is no longer the one asked for. */
/** A person's navigation that has not begun loading by now did not happen. */
const visitStartMs = 10_000;

/**
 * Why this exact tab cannot be shown, specifically, or null while it can.
 * Nothing here picks another tab: a tab that goes while shown hands the
 * middle to its successor, so this is what an address naming a tab never
 * listed here (an old link, Back to a closed tab) shows.
 */
function placeEnded(
  session: BrowserSessionSummary | null,
  tabListed: boolean,
  viewerError: string | null,
): { readonly title: string; readonly detail: string | null } | null {
  if (!session || session.state === "closed")
    return { detail: null, title: "This browser was closed" };
  if (session.state === "failed")
    return { detail: session.error, title: "This browser stopped working" };
  if (session.state === "ready" && !tabListed && session.tabCatalog)
    return { detail: null, title: "This tab was closed" };
  if (viewerError) return { detail: viewerError, title: "This tab can’t be shown" };
  return null;
}

/** Profiles and which agents may use them, for one Workspace's browsers. */
export function WorkspaceBrowserProfiles({
  available,
  hostClient,
  onClose,
  profileGrants,
  profiles,
  workspace,
}: {
  readonly available: boolean;
  readonly hostClient: HostClient;
  readonly onClose: () => void;
  readonly profileGrants: HostSnapshot["browserProfileGrants"];
  readonly profiles: HostSnapshot["browserProfiles"];
  readonly workspace: HostSnapshot["workspaces"][number];
}) {
  const [actionError, setActionError] = useState<string | null>(null);
  return (
    <BrowserProfilesDialog
      actionError={actionError}
      canCreate={available}
      onClose={onClose}
      onCreate={(name) =>
        hostClient
          .dispatch({
            idempotencyKey: mutationIdempotencyKey("browser-profile"),
            input: { name },
            type: "browser.profile.create",
          })
          .then(() => undefined)
      }
      onGrant={(input) =>
        hostClient
          .dispatch({
            idempotencyKey: mutationIdempotencyKey(`browser-grant:${workspace.id}`),
            profileId: input.profileId,
            type: "browser.profile.grant",
            workspaceId: workspace.id,
          })
          .then(() => undefined)
      }
      onRevoke={(grantId) =>
        hostClient
          .dispatch({
            grantId,
            idempotencyKey: mutationIdempotencyKey(`browser-grant:${grantId}`),
            type: "browser.profileGrant.revoke",
          })
          .then(() => undefined)
      }
      performAction={(action) => {
        setActionError(null);
        return runBrowserAction(action, setActionError);
      }}
      profileGrants={profileGrants.filter((grant) => grant.workspaceId === workspace.id)}
      profiles={profiles}
      workspaceKind={workspace.kind}
      workspaceName={workspace.name}
    />
  );
}
