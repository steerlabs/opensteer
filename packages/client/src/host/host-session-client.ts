import type { TranscriptItem } from "@opensteer/protocol/transcript";
import { MessageIdSchema, utf8ByteLength } from "@opensteer/core";
import type { PersonalStreamCache } from "./personal-stream-cache.js";
import { needsYouEntryKey, settleTeamAsk } from "./needs-you.js";
import { withThreadNames } from "./optimistic-command-patches.js";
import { ScopedThreadReader, TranscriptBodies, transcriptBodyKey } from "./scoped-thread-reader.js";
import { nodeTranscriptCard, transcriptCard } from "./transcript-item-view.js";
import {
  scopedPersonalApiVersion,
  PersonalShellSnapshotSchema,
  affectedPersonalSubscriptions,
} from "@opensteer/protocol/personal-sync";
import type { PersonalResourceKind } from "@opensteer/protocol/resources";
import type { PersonalShellStore } from "./personal-shell-store.js";
import { ScopedPersonalStream } from "./scoped-personal-stream.js";
import type { ClientCommandInput } from "./device-commands.js";
import type { HostClient } from "./client.js";
import {
  clientCommandSchema,
  deviceAccessCommand,
  type MachineAccessUpdateInput,
} from "./device-commands.js";
import { DeviceIdSchema } from "@opensteer/core";
import { createIphoneSetupPort, type IphoneSetupPort } from "./iphone-setup.js";
import { clearRunPageViews } from "./run-page-memory.js";
import { clearRunPlacePictures } from "./run-place-picture.js";
import { ReferenceStore } from "../references/store.js";
import { TranscriptFileController } from "./transcript-files.js";
import { AssetUrlStore, type AssetRoute } from "./asset-urls.js";
import {
  isSettledInputMutationError,
  openWaitingMessageEditor,
  type WaitingMessageEditorPort,
} from "./waiting-message-editor.js";
import { familyAutomations } from "./task-family.js";
import { catalogModelDisplayName } from "./model-catalog.js";
import type { NodeDetailSubscription, NodeDetailSnapshot } from "./node-detail.js";
import { BrowserCursorStore } from "./browser-cursor.js";
import type { PersonShowMessage } from "@opensteer/protocol";
import { sharedDisplayStreams } from "../integrations/phone-display-stream.js";
import { BrowserPasskeys, type BrowserPasskeyPort } from "./browser-passkeys.js";
import { emptySavedViewReadiness } from "./saved-host-view.js";
import { BrowserEditingStore } from "./browser-editing.js";
import { BrowserPreferences } from "./browser-preferences.js";
import type { HostCapability as AuthorityHostCapability } from "@opensteer/deployment-authority";
import type { NativeViewerSource } from "./surfaces.js";
import { TabStore } from "./tab-store.js";
import { createTabsClient, type TabsClientPort } from "./tabs-client.js";
import { TabViewers } from "./tab-viewers.js";
import { BrowserSurfaceIdSchema, type App, type Tab, type TabId } from "@opensteer/core";
import { BrowserHistoryClient } from "./browser-history.js";
import type { BrowserPreferencesStorage } from "./browser-preferences.js";
import { computerViewMethods } from "./computer-views.js";
import { OwnerViewRecords } from "./owner-view-records.js";
import { ViewerScope, viewerScopeOf } from "./viewer-scope.js";
import {
  DeploymentIdSchema,
  ModelSelectionSchema,
  ExecutionNodeIdSchema,
  TeamAgentRequestIdSchema,
  RequestIdSchema,
  type QuietTaskDays,
  type PersonName,
  RunIdSchema,
  SequenceSchema,
  ThreadIdSchema,
  ThreadTitleSchema,
  TimeZoneSchema,
  type MessageOrigin,
  defaultTaskSymbol,
  emptyExecutionPreferences,
  zeroSequence,
  type AssignmentSummary,
  type AssignmentView,
  type Attachment,
  type ExecutionPreferences,
  type NotificationView,
  type Request,
  type RunId,
  type Sequence,
  type Thread,
  type ThreadAccessMode,
  type ThreadVisit,
  type IconName,
  type MessageRevisionView,
} from "@opensteer/core";
import { apiVersionQueryParameter } from "@opensteer/deployment-authority";
import {
  DisplaySourceSchema,
  HostToClientMessageSchema,
  browserUsageRunBatchSize,
  type BrowserSessionUsageProjection,
  type HostApiClient,
  type HostApiCommand,
  type HostApiCommandInput,
  type HostApiCommandOutput,
  type HostToClientMessage,
  type RealtimeFrameDiagnostic,
  type RpcResult,
} from "@opensteer/protocol";
import { BrowserWatchStore, browserCommandNeedsNoView } from "./browser-watch.js";
import type {
  BrowserCommand,
  BrowserFrameStore,
  BrowserSessionSummary,
  CreateThreadInput,
  EnvironmentSummary,
  HarnessSummary,
  HostSnapshot,
  MachineAccessHistoryPage,
  MachineAccessUpdateOutcome,
  HostClient as OwnerViewHostClient,
  TaskEntry,
  TaskListState,
  ThreadSummary,
  TeamAskDecision,
  WaitingMessageEditor,
} from "./client.js";
import { HostClientRequestError, mainDoneTasks } from "./client.js";
import { browserProfileHomeCommand } from "./browser-access.js";
import type { ExecutionChoice, ExecutionSelection } from "./execution-preferences.js";
import { createHttpHostApiClient } from "./host-api-client.js";
import { threadInDirectory } from "./host-snapshot-selectors.js";
import { RunPlaceStore } from "./run-place.js";
import {
  type ClientLifecycle,
  type ClientNetworkPath,
  type ClientNetworkState,
  type ClientVisibility,
} from "./lifecycle.js";
import { PlaceActivityStore } from "./place-activity.js";
import { placeByKey } from "./places.js";
import { reconcileBrowserLastPictures } from "./browser-last-picture.js";
import { mergeTaskEntries } from "./task-entries.js";
import { threadStopTarget } from "./thread-activity.js";
import { isThreadUnread } from "./thread-unread.js";
import { ThreadStateProjection } from "./thread-state.js";

type HostCapability = AuthorityHostCapability;

const defaultReconnectBaseDelayMs = 300;
const defaultReconnectMaxDelayMs = 12_000;

/** Notification ids remembered after delivery, enough to cover every socket's copy. */
const rememberedNotificationIds = 256;
const scopedRealtimeTypes = new Set([
  "host.snapshot",
  "host.changes",
  "host.synchronized",
  "host.snapshot-required",
  "host.removed",
  "host.resource",
  "host.live",
]);

type Fetch = typeof globalThis.fetch;
type Timer = ReturnType<typeof globalThis.setTimeout>;

interface SocketEventMap {
  close: CloseEvent;
  error: Event;
  message: { readonly data: unknown };
  open: Event;
}

export interface WebSocketClient {
  binaryType: "arraybuffer" | "blob";
  readonly readyState: number;
  addEventListener<Type extends keyof SocketEventMap>(
    type: Type,
    listener: (event: SocketEventMap[Type]) => void,
    options?: AddEventListenerOptions,
  ): void;
  close(code?: number, reason?: string): void;
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
}

/** Whom a realtime socket was opened for. */
interface SocketViewer {
  readonly deploymentId: string | null;
  readonly userId: string | null;
}

export type HostCapabilityReader = (options?: {
  readonly revalidate: boolean;
}) => Promise<readonly HostCapability[]>;

export interface HttpHostClientOptions {
  readonly iphoneSetup?: import("@opensteer/protocol/desktop").DesktopIphoneSetupBridge;
  readonly assetRoute?: AssetRoute;
  readonly desktopMedia?: boolean;
  readonly streamCache?: PersonalStreamCache;
  readonly cacheDeploymentId?: string;
  readonly passkeys?: BrowserPasskeyPort;
  /** The viewer's command platform for exact baseline shortcut projection. */
  readonly viewerPlatform?: "mac" | "pc";
  /** This app and device, stated with each message a person sends from it. */
  readonly origin?: Omit<MessageOrigin, "timeZone">;
  /** Verified by the connection owner for this client’s attachment. Null is unknown. */
  readonly capabilities?: readonly HostCapability[] | null | HostCapabilityReader;
  readonly browserPreferencesStorage?: BrowserPreferencesStorage;
  /** The Host's origin. There is no ambient default: a React Native bundle has
   * no document to read one from, and a renderer may address another Host. */
  readonly baseUrl: string | URL;
  readonly fetch?: Fetch;
  readonly bufferedResponses?: boolean;
  /** Absent means the platform reports nothing, and the client never suspends. */
  readonly lifecycle?: ClientLifecycle;
  readonly random?: () => number;

  readonly reconnectBaseDelayMs?: number;
  readonly reconnectMaxDelayMs?: number;
  /** Where a platform keeps a record of realtime frames this client could not read. */
  readonly reportRealtimeFrame?: (record: RealtimeFrameDiagnostic) => void;

  readonly prepareSocket?: () => Promise<unknown>;
  readonly webSocketFactory?: (url: string) => WebSocketClient;
}

// Keep thumbnails across remounts without retaining unbounded file bytes on phones.
const attachmentCacheByteBudget = 32 * 1024 * 1024;
const resourceInventoryByteBudget = 1024 * 1024;
const returnHintResources: ReadonlySet<PersonalResourceKind> = new Set([
  "settings",
  "environment",
  "harness",
  "harness-catalog",
  "machine",
]);

type AttachmentRead = {
  readonly controller: AbortController;
  readonly promise: Promise<Blob>;
  callers: number;
};

export class HttpHostClient {
  readonly browserPasskeys: BrowserPasskeys;
  readonly iphoneSetup: IphoneSetupPort | undefined;
  readonly browserHistory: BrowserHistoryClient;
  readonly browserPreferences: BrowserPreferences;
  readonly retainComputerView: OwnerViewHostClient["retainComputerView"];
  readonly #viewer = new ViewerScope();
  readonly #attachmentReads = new Map<string, AttachmentRead>();
  readonly #attachmentCache = new Map<string, Blob>();
  #attachmentCacheBytes = 0;
  readonly #ownerViews = new OwnerViewRecords();
  #computerViews: { clear(): void; setConnected(connected: boolean): void } = {
    clear: () => undefined,
    setConnected: () => undefined,
  };
  readonly closeComputerView: OwnerViewHostClient["closeComputerView"];
  readonly renewComputerView: OwnerViewHostClient["renewComputerView"];
  readonly listComputerAppWindows: OwnerViewHostClient["listComputerAppWindows"];
  readonly listApprovedComputerApps: OwnerViewHostClient["listApprovedComputerApps"];
  readonly assetUrls: AssetUrlStore;
  readonly references: ReferenceStore;
  readonly transcriptFiles: TranscriptFileController;
  readonly rpc: HostApiClient;
  readonly #baseUrl: URL;
  readonly #stream: ScopedPersonalStream;
  readonly #prepareSocket: HttpHostClientOptions["prepareSocket"];
  #socketGeneration = 0;
  #probe: { nonce: string; timer: Timer } | undefined;
  #attachDeadline: Timer | undefined;
  #warmRead: AbortController | undefined;
  readonly #cacheDeploymentId: string | undefined;
  readonly #reportRealtimeFrame: HttpHostClientOptions["reportRealtimeFrame"];
  #socket: WebSocketClient | null = null;
  #reconnect: Timer | undefined;
  #attempt = 0;
  #started = false;
  #refused = false;
  #load: Promise<void> | undefined;
  #resolveLoad: (() => void) | undefined;
  readonly #resourceReads = new Map<
    PersonalResourceKind,
    { controller: AbortController; revision: string }
  >();
  readonly #environmentCatalogs = new Map<string, EnvironmentSummary["harnessCatalogs"]>();
  readonly #environmentAuth = new Map<string, boolean>();
  readonly #scopeReaders = new Map<string, ScopedThreadReader>();
  readonly #bodies = new TranscriptBodies();
  readonly #resourceRevisions = new Map<PersonalResourceKind, string>();
  readonly #returnHintRevisions = new Map<PersonalResourceKind, string>();
  readonly #threadReaders = new Map<string, () => void>();
  readonly #shellEntries = new WeakMap<Parameters<typeof compactThread>[0], TaskEntry>();
  #publishedShell: ReturnType<ScopedPersonalStream["shell"]["getSnapshot"]> | undefined;
  readonly #fetch: Fetch;
  readonly #listeners = new Set<() => void>();
  readonly #assignmentReads = new Map<string, "read" | AbortController>();
  readonly #automationReads = new Map<string, { again: boolean }>();
  readonly #readAutomations = new Set<string>();
  /**
   * Per shown conversation whose browser usage has been read, the Runs that
   * read covered. A conversation not here is read whole when it is shown.
   */
  readonly #browserUsageRead = new Map<string, Set<string>>();
  readonly #browserUsageReads = new Map<string, { again: "full" | "missing" | null }>();
  readonly #browserUses = new Map<string, readonly BrowserSessionUsageProjection[]>();
  /**
   * The shape a conversation's Runs were last collected from: a streamed reply
   * changes none of it, so it is not walked again for each word.
   */
  readonly #browserUsageRunSources = new Map<string, readonly unknown[]>();
  /**
   * When each Mac session last had its presence patched, against a
   * counter a bootstrap notes before it reads: a bootstrap answer older than a
   * patch keeps the patch rather than putting the older page back.
   */
  readonly #presenceMarks = new Map<string, number>();
  #presenceCounter = 0;
  readonly #tabs = new TabStore();
  /** The page session each tab's viewer was bound to by this device's own activation. */
  readonly #pageSessions = new Map<string, string>();
  readonly #viewers = new TabViewers();
  tabViewer(tabId: string) {
    return this.#viewers.get(tabId, this.#snapshot.machines);
  }
  #tabRows: ReadonlyMap<TabId, Tab> | null = null;
  #tabInventoryComplete = false;
  browserViewerSurface(sessionId: string, surfaceId: string) {
    return (
      this.#targetedControl.surface(sessionId, surfaceId) ??
      this.#targetedWatch.surface(sessionId, surfaceId)
    );
  }
  readonly #placeActivity = new PlaceActivityStore();
  readonly #runPlaces = new RunPlaceStore();
  readonly #targetedControl = new BrowserWatchStore(
    (sessionId, surfaceId, asleep) =>
      this.#targetedBrowserSocket(sessionId, surfaceId, "control", asleep),
    "control",
    (sessionId, message, surfaceId) => {
      this.#browserCursor.receive(sessionId, message);
      this.browserPasskeys.receive(sessionId, surfaceId, message);
      if (message.type === "browser.popup.opened")
        for (const listener of this.#browserPopups.get(`${sessionId}:${surfaceId}`) ?? [])
          listener(message.surfaceId);
      if (message.type === "browser.snapshot")
        this.#browserEditing.negotiate(
          sessionId,
          message.editingVersion,
          surfaceId,
          message.clipboard,
          message.basicInput,
        );
      else this.#browserEditing.receive(sessionId, message, surfaceId);
      if (message.type === "browser.surface") this.#update(this.#snapshot);
      if (message.type === "browser.snapshot" || message.type === "browser.dialog.changed")
        this.#patchBrowserSession(sessionId, { dialog: message.dialog });
    },
    (attempt, unreadableFrames) =>
      this.#reconnectDelay(attempt, unreadableFrames ? 5 * 60_000 : undefined),
    () => this.#capabilities?.includes("browser-capture-region-v1") === true,
    (sessionId, surfaceId, hadSurface) => {
      this.#browserEditing.disconnect(sessionId, surfaceId);
      this.browserPasskeys.disconnect(sessionId, surfaceId);
      if (hadSurface) this.#update(this.#snapshot);
    },
    () => this.#capabilities?.includes("browser-frame-window-v1") === true,
    () => this.#capabilities?.includes("browser-raster-demand-v1") === true,
  );
  readonly #targetedWatch = new BrowserWatchStore(
    (sessionId, surfaceId) => this.#targetedBrowserSocket(sessionId, surfaceId, "watch"),
    "watch",
    (_sessionId, message) => {
      if (message.type === "browser.surface") this.#update(this.#snapshot);
    },
    (attempt, unreadableFrames) =>
      this.#reconnectDelay(attempt, unreadableFrames ? 5 * 60_000 : undefined),
    () => this.#capabilities?.includes("browser-capture-region-v1") === true,
    (_sessionId, _surfaceId, hadSurface) => {
      if (hadSurface) this.#update(this.#snapshot);
    },
    () => this.#capabilities?.includes("browser-frame-window-v1") === true,
    () => this.#capabilities?.includes("browser-raster-demand-v1") === true,
  );
  #targetedBrowserSocket(
    sessionId: string,
    surfaceId: string,
    mode: "control" | "watch",
    asleep = false,
  ): WebSocketClient {
    if (
      this.#disposed ||
      this.#snapshot.session !== "authenticated" ||
      !this.#browserTargetAllowed(sessionId, surfaceId, asleep)
    )
      throw new Error("The browser target is unavailable.");
    const url = new URL(
      this.#webSocketUrl(`/v1/browser-sessions/${encodeURIComponent(sessionId)}/connect`),
    );
    if (mode === "watch") url.searchParams.set("mode", mode);
    const passkeys = this.browserPasskeys.optIn(this.#capabilities ?? undefined);
    if (mode === "control" && passkeys) url.searchParams.set("passkeys", passkeys);
    if (mode === "control") {
      url.searchParams.set("popups", "1");
      url.searchParams.set("basicInput", "1");
      // Person fill 2 adds offers to save a login the person typed.
      url.searchParams.set("autofill", "2");
    }
    url.searchParams.set("editing", "2");
    return this.#webSocketFactory(url.toString());
  }
  /** A page viewer may attach only to a listed page tab this device activated into that session. */
  #browserTargetAllowed(sessionId: string, surfaceId: string, asleep: boolean): boolean {
    const tab = this.#tabs.get(surfaceId as TabId);
    return (
      tab?.kind === "page" &&
      this.#pageSessions.get(surfaceId) === sessionId &&
      (tab.state === "open" || (asleep && tab.state === "asleep"))
    );
  }
  readonly #browserPopups = new Map<string, Set<(popupId: string) => void>>();
  readonly subscribeBrowserPopups = (
    sessionId: string,
    surfaceId: string,
    listener: (popupId: string) => void,
  ): (() => void) => {
    const key = `${sessionId}:${surfaceId}`;
    const listeners = this.#browserPopups.get(key) ?? new Set();
    listeners.add(listener);
    this.#browserPopups.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.#browserPopups.delete(key);
    };
  };
  readonly connectComputerDisplay = (
    source: NativeViewerSource,
    options?: { readonly editing?: 1 },
  ): WebSocketClient => {
    if (this.#disposed) throw new Error("The Host client is disposed.");
    const ref = DisplaySourceSchema.parse(source);
    const path =
      ref.kind === "task-session"
        ? `/v1/computer-use/sessions/${encodeURIComponent(ref.sessionId)}/display`
        : `/v1/computer-use/views/${encodeURIComponent(ref.viewId)}/${ref.generation}/display`;
    const url = new URL(this.#webSocketUrl(path));
    url.searchParams.set("sharedInput", "1");
    url.searchParams.set("phoneOwnerControl", "1");
    url.searchParams.set("displayWindow", "1");
    if (options?.editing === 1) {
      url.searchParams.set("editing", "1");
      url.searchParams.set("displayCut", "1");
    }
    if (ref.kind === "task-session" && ref.appKey !== undefined)
      url.searchParams.set("appKey", ref.appKey);
    return this.#webSocketFactory(url.toString());
  };
  readonly subscribeLifecycle = (
    listener: (event: "background" | "foreground" | "network") => void,
  ): (() => void) => {
    this.#lifecycleListeners.add(listener);
    if (this.#visibility === "background") listener("background");
    return () => this.#lifecycleListeners.delete(listener);
  };
  readonly placeActivity = this.#placeActivity.get;
  readonly subscribePlaceActivity = this.#placeActivity.subscribe;
  readonly runPlace = this.#runPlaces.get;
  readonly subscribeRunPlace = this.#runPlaces.subscribe;
  readonly browserWatchState = this.#targetedWatch.get;
  readonly browserViewerState = this.#targetedControl.status;
  readonly subscribeBrowserViewer = this.#targetedControl.subscribeStatus;
  readonly browserWatchFrame = (sessionId: string, surfaceId: string) =>
    this.#targetedWatch.get(sessionId, surfaceId).frame;
  readonly subscribeBrowserWatch = this.#targetedWatch.subscribe;
  async readBrowserContextCandidate(sessionId: string, tabId: string) {
    return unwrapRpcResult(await this.rpc["browser.contextCandidate.get"]({ sessionId, tabId }));
  }
  readonly #tabsClient = createTabsClient({
    store: this.#tabs,
    dispatch: async (command) => {
      const viewer = this.#viewer.generation;
      const result = unwrapRpcResult(await this.rpc["commands.dispatch"](command));
      if (viewer !== this.#viewer.generation)
        throw new HostClientRequestError({
          code: "unauthorized",
          status: 401,
          message: "The signed-in account changed while the tab command was under way.",
        });
      return result as Awaited<ReturnType<TabsClientPort["dispatch"]>>;
    },
    listApps: async (query) =>
      unwrapRpcResult(await this.rpc["apps.list"](query ? { query } : {})).apps as App[],
    getApp: async (appId) => unwrapRpcResult(await this.rpc["apps.get"]({ appId })) as App,
    activated: (tab, viewer, wake) => {
      // A tab the stream closed while its activation was answering stays closed;
      // one a still-loading list has not reached yet is bound as answered.
      if (this.#tabs.complete && !this.#tabs.get(tab.tabId)) return;
      this.#viewers.set(tab.tabId, viewer, this.#snapshot.machines);
      if (viewer.kind === "page") this.#bindPage(tab, viewer.sessionId);
      else if (viewer.kind !== "app") this.#acceptOwnerView(viewer.view, wake);
      else this.#update(this.#snapshot);
    },
  });
  readonly openTab = this.#tabsClient.openTab;
  readonly closeTabs = this.#tabsClient.closeTabs;
  readonly reopenTab = this.#tabsClient.reopenTab;
  readonly activateTab = this.#tabsClient.activateTab;
  readonly organizeTabs = this.#tabsClient.organizeTabs;
  readonly updateTabGroup = this.#tabsClient.updateTabGroup;
  readonly deleteTabGroup = this.#tabsClient.deleteTabGroup;
  readonly listApps = this.#tabsClient.listApps;
  readonly getApp = this.#tabsClient.getApp;
  readonly renameApp = this.#tabsClient.renameApp;
  readonly startApp = this.#tabsClient.startApp;
  readonly stopApp = this.#tabsClient.stopApp;
  readonly deleteApp = this.#tabsClient.deleteApp;
  /** A person's own view of a window or phone, opened by activating its tab. */
  #acceptOwnerView(view: import("@opensteer/protocol").ComputerView, wake: boolean): void {
    this.#update({
      ...this.#snapshot,
      machines: [...this.#ownerViews.accept(this.#snapshot.machines, view)],
    });
    // Only the person's explicit Open may wake a phone, and only once.
    if (
      wake &&
      view.target.kind === "phone" &&
      view.state === "ready" &&
      this.#snapshot.machines.some(
        (machine) =>
          machine.id === view.machineId &&
          machine.phoneDisplay?.wake === true &&
          machine.computerUse?.ownerViews?.some(
            (held) => held.viewId === view.viewId && held.generation === view.generation,
          ),
      )
    )
      sharedDisplayStreams(this).armAutoWake({
        kind: "owner-view",
        viewId: view.viewId,
        generation: view.generation,
      });
  }
  /**
   * The page session a tab's activation bound: viewers attach to it, and the
   * snapshot names it so the page's view can follow its dialog and viewer state.
   */
  #bindPage(tab: Tab, sessionId: string): void {
    this.#pageSessions.set(tab.tabId, sessionId);
    if (this.#snapshot.browserSessions.some((session) => session.id === sessionId)) {
      this.#update(this.#snapshot);
      return;
    }
    const session: BrowserSessionSummary = {
      id: sessionId,
      access: "read-write",
      attachedRunIds: [],
      dialog: null,
      error: null,
      origin: "person",
      placement: { kind: "runner", runnerId: tab.computer.computerId },
      profileId: tab.profile?.profileId ?? null,
      runtimeId: sessionId,
      state: "ready",
      viewerError: null,
      viewerState: "disconnected",
    };
    this.#update({
      ...this.#snapshot,
      browserSessions: [...this.#snapshot.browserSessions, session],
    });
  }
  async readBrowserTabIcon(tabId: string, iconRef: string): Promise<string | null> {
    return unwrapRpcResult(
      await this.rpc["browser.tabIcon.get"]({
        tabId: BrowserSurfaceIdSchema.parse(tabId),
        iconRef,
      }),
    ).favicon;
  }
  /** Holds on Threads observed beside the active one, counted per Thread. */
  readonly #observedThreads = new Map<string, number>();
  readonly #threadInputMutationKeys = new Map<string, string>();
  /** The edit leases this device holds, so its own edit never reads as another device's. */
  readonly #editLeases = new Set<string>();
  readonly #deniedAssignments = new Set<string>();
  readonly #threadDeployment = new Map<string, string>();
  #viewerGeneration = 0;
  #savedViewReadiness = emptySavedViewReadiness();
  readonly #notificationListeners = new Set<(notification: NotificationView) => void>();
  readonly #pluginsChangedListeners = new Set<
    (message: { type: "host.plugins-changed" }) => void
  >();
  readonly #personalRemoteAccessListeners = new Set<() => void>();
  readonly #connectionsListeners = new Set<() => void>();
  readonly #personShowListeners = new Set<(message: PersonShowMessage) => void>();
  readonly #lifecycleListeners = new Set<
    (event: "background" | "foreground" | "network") => void
  >();

  readonly #deliveredNotifications = new Set<string>();
  /**
   * The Deployment, viewer and time zone last reported, or being reported.
   * Every bootstrap compares against it, so only a new viewer or a moved clock
   * sends again.
   */
  readonly #threadState = new ThreadStateProjection();
  readonly #threadRenames = new Map<string, { readonly title: string; readonly token: symbol }>();
  readonly #threadIcons = new Map<string, { readonly icon: IconName; readonly token: symbol }>();

  #activeThreadId: string | null = null;
  readonly #random: () => number;
  readonly #reconnectBaseDelayMs: number;
  readonly #reconnectMaxDelayMs: number;
  readonly #webSocketFactory: (url: string) => WebSocketClient;
  readonly #lifecycleDisposers: (() => void)[] = [];
  #network: ClientNetworkState;
  #visibility: ClientVisibility;

  /** Per task list, the one read of a later page in flight, for the viewer that asked. */
  readonly #taskPageLoads = new Map<
    string | null,
    { readonly generation: number; readonly promise: Promise<void> }
  >();

  #disposed = false;
  #snapshot: HostSnapshot = emptySnapshot(this.#tabs);
  #remembering: Promise<unknown> = Promise.resolve();

  readonly #viewerPlatform: "mac" | "pc" | null;
  readonly #origin: Omit<MessageOrigin, "timeZone"> | undefined;
  constructor(options: HttpHostClientOptions) {
    this.#origin = options.origin;
    this.#prepareSocket = options.prepareSocket;
    this.#cacheDeploymentId = options.cacheDeploymentId;
    this.#reportRealtimeFrame = options.reportRealtimeFrame;
    this.#stream = new ScopedPersonalStream(options.streamCache, (kind) =>
      this.#resourceChanged(kind),
    );
    this.browserPasskeys = new BrowserPasskeys(options.passkeys);
    this.iphoneSetup = options.iphoneSetup
      ? createIphoneSetupPort(options.iphoneSetup, (command) => this.dispatch(command))
      : undefined;
    this.#viewerPlatform = options.viewerPlatform ?? null;
    this.#readCapabilities =
      typeof options.capabilities === "function" ? options.capabilities : null;
    this.#capabilities = Array.isArray(options.capabilities) ? [...options.capabilities] : null;
    this.browserPreferences = new BrowserPreferences(options.browserPreferencesStorage);
    this.browserHistory = new BrowserHistoryClient({
      get: async (profileId) =>
        unwrapRpcResult(await this.rpc["browser.history.get"]({ profileId })),
      icons: async (profileId, iconRefs) =>
        unwrapRpcResult(await this.rpc["browser.history.icons.get"]({ profileId, iconRefs })),
      remove: async (profileId, url) => {
        await this.dispatch({
          type: "browser.history.remove",
          profileId,
          url,
          idempotencyKey: crypto.randomUUID(),
        });
      },
      clear: async (profileId) => {
        await this.dispatch({
          type: "browser.history.clear",
          profileId,
          idempotencyKey: crypto.randomUUID(),
        });
      },
    });
    this.#tabs.subscribe(() => {
      this.#update(this.#snapshot);
    });
    this.#baseUrl = new URL(options.baseUrl);
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.rpc = createHttpHostApiClient({
      baseUrl: this.#baseUrl,
      fetch: this.#fetch,
      personalVersion: scopedPersonalApiVersion,
      ...(options.bufferedResponses === undefined
        ? {}
        : { bufferedResponses: options.bufferedResponses }),
      onSignedOut: () => this.#expireSession(),
      onAuthenticationRequired: () => {
        this.#expireSession();
        this.#reverifyCapabilities();
      },
      onVersionMismatch: () => this.#reverifyCapabilities(),
    });
    this.assetUrls = new AssetUrlStore(
      async (input, signal) =>
        unwrapRpcResult(await this.rpc["asset.urls"](input, signal ? { signal } : undefined)),
      options.assetRoute
        ? {
            origin: async (deploymentId) => {
              const { resolved } = await options.assetRoute!.current();
              if (resolved.deploymentId !== deploymentId)
                throw new Error("The image belongs to another Deployment.");
              return resolved.origin;
            },
            subscribe: (listener) => options.assetRoute!.onAttachmentInvalidated(listener),
          }
        : { origin: async () => this.#baseUrl.origin },
      options.desktopMedia,
    );
    this.transcriptFiles = new TranscriptFileController({
      images: { store: this.assetUrls, deploymentId: () => this.#snapshot.deploymentId },
      rpc: {
        openFile: async (input, signal) =>
          unwrapRpcResult(await this.rpc["file.open"](input, signal ? { signal } : undefined)),
        readFile: async (input, signal) =>
          unwrapRpcResult(await this.rpc["file.content"](input, signal ? { signal } : undefined)),
      },
    });
    const initialReferenceSnapshot = this.#snapshot;
    let referenceOwner = JSON.stringify([
      initialReferenceSnapshot.deploymentId,
      initialReferenceSnapshot.user?.id,
      initialReferenceSnapshot.sessionId,
      initialReferenceSnapshot.session,
    ]);
    this.references = new ReferenceStore({
      getSnapshot: () => this.#snapshot,
      resolveReferences: async (input, signal) =>
        unwrapRpcResult(
          await this.rpc["references.resolve"](input, signal ? { signal } : undefined),
        ),
      subscribe: (listener) =>
        this.subscribe(() => {
          const snapshot = this.#snapshot;
          const owner = JSON.stringify([
            snapshot.deploymentId,
            snapshot.user?.id,
            snapshot.sessionId,
            snapshot.session,
          ]);
          if (owner !== referenceOwner) {
            referenceOwner = owner;
            this.assetUrls.reset();
            this.transcriptFiles.reset();
          }
          listener();
        }),
    });
    this.#random = options.random ?? Math.random;
    this.#reconnectBaseDelayMs = Math.max(
      0,
      options.reconnectBaseDelayMs ?? defaultReconnectBaseDelayMs,
    );
    this.#reconnectMaxDelayMs = Math.max(
      this.#reconnectBaseDelayMs,
      options.reconnectMaxDelayMs ?? defaultReconnectMaxDelayMs,
    );
    this.#webSocketFactory = options.webSocketFactory ?? ((url) => new globalThis.WebSocket(url));
    const lifecycle = options.lifecycle?.getSnapshot();
    this.#network = lifecycle?.network ?? "unknown";
    this.#snapshot = {
      ...this.#snapshot,
      network: this.#network,
      savedViewReadiness: this.#savedViewReadiness,
      threadRenameAvailable: this.#capabilities?.includes("thread-titles-v1") === true,
      taskMarksAvailable: this.#capabilities?.includes("task-marks-v1") === true,
      integrationAppFinishAvailable:
        this.#capabilities?.includes("integration-app-finish-v1") === true,
      integrationAppReturnPortAvailable:
        this.#capabilities?.includes("integration-app-return-port-v1") === true,

      quietTasksAvailable: this.#capabilities?.includes("quiet-tasks-v1") === true,
      harnessUpdateAvailable: this.#capabilities?.includes("harness-update-v1") === true,
      agentImagesAvailable: this.#capabilities?.includes("agent-images-v1") === true,
      tabReopenAvailable: this.#capabilities?.includes("tab-reopen-v1") === true,
      browserProfileManageAvailable:
        this.#capabilities?.includes("browser-profile-manage-v1") === true,
      searchSuggestionsAvailable:
        this.#capabilities?.includes("browser-search-suggestions-v1") === true,
      iphoneAppsAvailable: this.#capabilities?.includes("iphone-apps-v1") === true,
      devicesAvailable: this.#capabilities?.includes("devices-v1") === true,
      voiceAvailable: this.#capabilities?.includes("voice-run-v1") === true,

      ownerViewWindowsAvailable: this.#capabilities?.includes("ownerViewWindows") === true,
    };
    this.#visibility = lifecycle?.visibility ?? "foreground";
    this.#stream.setBackground(this.#visibility === "background");
    this.#stream.shell.subscribe(() => this.#publishShell());
    this.#targetedControl.suspend(this.#reconnectSuspended(), this.#network !== "offline");
    this.#targetedWatch.suspend(this.#reconnectSuspended());
    if (options.lifecycle) this.#observeLifecycle(options.lifecycle);
    const views = computerViewMethods(
      this.rpc,
      (view) =>
        this.#update({
          ...this.#snapshot,
          machines: [...this.#ownerViews.accept(this.#snapshot.machines, view)],
        }),
      () => this.#viewer.generation,
      (viewId) =>
        this.#snapshot.machines
          .flatMap((machine) => machine.computerUse?.ownerViews ?? [])
          .find((view) => view.viewId === viewId),
      () => this.#capabilities?.includes("ownerViewWindows") === true,
      (viewId, generation) =>
        sharedDisplayStreams(this).cancelAutoWake({ kind: "owner-view", viewId, generation }),
    );
    this.#computerViews = views;
    this.retainComputerView = views.retainComputerView;
    this.closeComputerView = (...args) => {
      sharedDisplayStreams(this).cancelAutoWake({
        kind: "owner-view",
        viewId: args[0],
        generation: args[1],
      });
      return views.closeComputerView(...args);
    };
    this.renewComputerView = views.renewComputerView;
    this.listApprovedComputerApps = views.listApprovedComputerApps;
    this.listComputerAppWindows = views.listComputerAppWindows;
  }

  readonly getSnapshot = (): HostSnapshot => this.#snapshot;

  readonly #browserCursor = new BrowserCursorStore();
  readonly #browserEditing = new BrowserEditingStore(
    (sessionId, surfaceId, command) => {
      if (this.#targetedControl.has(sessionId, surfaceId))
        this.#targetedControl.send(sessionId, surfaceId, command);
      else this.sendBrowserCommand(sessionId, command);
    },
    () => this.#viewerPlatform,
  );
  readonly #browserPresentationScope = {};
  readonly browserFrames: BrowserFrameStore = {
    invalidationKey: this.#targetedControl.invalidationKey,
    editing: this.#browserEditing,
    cursor: this.#browserCursor,
    scope: this.#browserPresentationScope,
    claim: (sessionId, surfaceId, token) =>
      this.#targetedControl.claim(sessionId, surfaceId, token),
    accept: (sessionId, surfaceId, token) =>
      this.#targetedControl.accept(sessionId, surfaceId, token),
    get: (sessionId, surfaceId) => this.#targetedControl.get(sessionId, surfaceId).frame,
    rasterDemand: (sessionId, surfaceId) =>
      this.#targetedControl.rasterDemand(sessionId, surfaceId),
    subscribe: (sessionId, listener, surfaceId) =>
      this.#targetedControl.subscribe(sessionId, surfaceId, listener),
  };
  readonly browserWatchFrames: BrowserFrameStore = {
    invalidationKey: this.#targetedWatch.invalidationKey,
    scope: this.#browserPresentationScope,
    claim: (sessionId, surfaceId, token) => this.#targetedWatch.claim(sessionId, surfaceId, token),
    accept: (sessionId, surfaceId, token) =>
      this.acceptBrowserWatchFrame(sessionId, token, surfaceId),
    get: (sessionId, surfaceId) => this.#targetedWatch.get(sessionId, surfaceId).frame,
    rasterDemand: (sessionId, surfaceId) => this.#targetedWatch.rasterDemand(sessionId, surfaceId),
    subscribe: (sessionId, listener, surfaceId) =>
      this.#targetedWatch.subscribe(sessionId, surfaceId, listener),
  };

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  async dispatch(command: ClientCommandInput): Promise<HostApiCommandOutput> {
    const parsedCommand = clientCommandSchema.parse(
      this.#withOrigin(browserProfileHomeCommand(command, this.#snapshot.browserProfileHomes)),
    );
    if (
      (parsedCommand.type === "request.respond" ||
        parsedCommand.type === "browser.sign-in.respond" ||
        parsedCommand.type === "browser.password-sign-in.respond") &&
      parsedCommand.expectedRevision === undefined
    )
      throw new HostClientRequestError({
        code: "conflict",
        status: 409,
        message: "Review the latest request before answering.",
      });
    const needsDevices =
      parsedCommand.type === "machine.session.bind" ||
      (parsedCommand.type === "machine.access.update" &&
        (parsedCommand.policy.browser !== undefined || parsedCommand.policy.apps !== undefined)) ||
      ((parsedCommand.type === "runner.enrollment.createLocal" ||
        parsedCommand.type === "runner.enrollment.createPhone") &&
        parsedCommand.access !== undefined);
    if (needsDevices && !this.#capabilities?.includes("devices-v1"))
      throw new Error("Update this Opensteer to use device setup and access switches.");
    if (parsedCommand.type === "thread.icon.set") {
      if (!this.#snapshot.taskMarksAvailable)
        throw new Error("This Host does not support task marks.");
      return this.#setThreadIcon(parsedCommand);
    }
    return this.#dispatchCommand(parsedCommand);
  }

  /** The zone is read at send time: a phone that crossed zones says so on its next message. */
  messageOrigin(): MessageOrigin | undefined {
    if (!this.#origin || !this.#capabilities?.includes("message-origin-v1")) return undefined;
    const timeZone = TimeZoneSchema.safeParse(deviceTimeZone());
    return { ...this.#origin, ...(timeZone.success ? { timeZone: timeZone.data } : {}) };
  }

  #withOrigin(command: HostApiCommandInput): HostApiCommandInput {
    if (command.type !== "thread.sendMessage" || command.origin) return command;
    const origin = this.messageOrigin();
    return origin ? { ...command, origin } : command;
  }

  async #dispatchCommand(command: HostApiCommand): Promise<HostApiCommandOutput> {
    const viewer = this.#viewerGeneration;
    const result = await this.#dispatch(command);
    if (viewer !== this.#viewerGeneration || this.#disposed) return result;
    if ("thread" in result && "asOfSequence" in result) {
      const thread = this.#threadState.reconcile(
        toThreadSummary(result.thread, this.#snapshot.environments, this.#snapshot.harnesses),
        result.asOfSequence,
      );
      this.#update({ ...this.#snapshot, threads: upsertThread(this.#snapshot.threads, thread) });
    }
    if (result.type === "teams.ask.decide" && command.type === result.type) {
      const needsYou = settleTeamAsk(this.#snapshot.needsYou, command.teamId, command.requestId);
      if (needsYou !== this.#snapshot.needsYou) this.#update({ ...this.#snapshot, needsYou });
    }
    if (result.type === "execution.preferences.remember")
      this.#update({ ...this.#snapshot, executionPreferences: result.preferences });
    if (result.type === "assignment.cancel")
      this.#update({
        ...this.#snapshot,
        assignments: mergeAssignments(this.#snapshot.assignments, [result.assignment]),
      });
    if (result.type === "browser.profile.delete" && command.type === result.type)
      this.browserHistory.drop(command.profileId);
    if (
      "threadId" in command &&
      (command.type.startsWith("thread.input") || command.type === "thread.sendMessage")
    )
      this.#reloadInputQueue(command.threadId);
    return result;
  }

  async createAttachment(input: {
    readonly deploymentId: string;
    readonly name: string;
    readonly mediaType: string;
    readonly sizeBytes: number;
    readonly idempotencyKey: string;
  }): Promise<Attachment> {
    const result = await this.dispatch({ ...input, type: "attachment.upload.create" });
    if (result.type !== "attachment.upload.create")
      throw new Error("Attachment reservation response mismatch.");
    return result.attachment;
  }

  async uploadAttachment(input: {
    readonly attachmentId: string;
    readonly source: Blob;
    readonly signal?: AbortSignal;
  }): Promise<Attachment> {
    return unwrapRpcResult(
      await this.rpc["attachment.upload"](
        { attachmentId: input.attachmentId },
        { body: input.source, ...(input.signal ? { signal: input.signal } : {}) },
      ),
    );
  }

  async viewApp(appId: string, theme: "light" | "dark", signal?: AbortSignal) {
    const view = unwrapRpcResult(
      await this.rpc["apps.view"]({ appId, theme }, signal ? { signal } : undefined),
    );
    return { title: view.app.name, url: view.entryUrl ?? this.#url(view.path) };
  }

  async getAttachment(attachmentId: string): Promise<Attachment> {
    return unwrapRpcResult(await this.rpc["attachment.get"]({ attachmentId }));
  }

  async readAttachment(attachmentId: string, signal?: AbortSignal): Promise<Blob> {
    if (this.#disposed || signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const cached = this.#attachmentCache.get(attachmentId);
    if (cached) {
      this.#attachmentCache.delete(attachmentId);
      this.#attachmentCache.set(attachmentId, cached);
      return cached;
    }
    let read = this.#attachmentReads.get(attachmentId);
    if (!read) {
      const controller = new AbortController();
      const promise = this.rpc["attachment.content"](
        { attachmentId },
        { signal: controller.signal },
      )
        .then(unwrapRpcResult)
        .then((content) => new Blob([content.bytes], { type: content.metadata.contentType }));
      read = { controller, promise, callers: 0 };
      this.#attachmentReads.set(attachmentId, read);
      const current = read;
      void promise.then(
        (blob) => {
          if (this.#attachmentReads.get(attachmentId) !== current) return;
          this.#attachmentReads.delete(attachmentId);
          if (blob.size > attachmentCacheByteBudget) return;
          this.#attachmentCache.set(attachmentId, blob);
          this.#attachmentCacheBytes += blob.size;
          while (this.#attachmentCacheBytes > attachmentCacheByteBudget) {
            const oldest = this.#attachmentCache.keys().next().value!;
            this.#attachmentCacheBytes -= this.#attachmentCache.get(oldest)!.size;
            this.#attachmentCache.delete(oldest);
          }
        },
        () => {
          if (this.#attachmentReads.get(attachmentId) === current)
            this.#attachmentReads.delete(attachmentId);
        },
      );
    }
    const current = read;
    current.callers += 1;
    return new Promise<Blob>((resolve, reject) => {
      let attached = true;
      const detach = () => {
        if (!attached) return false;
        attached = false;
        signal?.removeEventListener("abort", abort);
        current.controller.signal.removeEventListener("abort", abort);
        current.callers -= 1;
        // React cleans up and mounts passive effects in the same commit.
        queueMicrotask(() => {
          if (current.callers !== 0 || this.#attachmentReads.get(attachmentId) !== current) return;
          this.#attachmentReads.delete(attachmentId);
          current.controller.abort();
        });
        return true;
      };
      const abort = () => {
        if (detach()) reject(new DOMException("Aborted", "AbortError"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      current.controller.signal.addEventListener("abort", abort, { once: true });
      void current.promise.then(
        (blob) => {
          if (detach()) resolve(blob);
        },
        (error: unknown) => {
          if (detach()) reject(error);
        },
      );
    });
  }

  #clearAttachmentReads(): void {
    const reads = [...this.#attachmentReads.values()];
    this.#attachmentReads.clear();
    this.#attachmentCache.clear();
    this.#attachmentCacheBytes = 0;
    for (const read of reads) read.controller.abort();
  }

  async discardAttachment(attachmentId: string): Promise<void> {
    const result = await this.dispatch({
      attachmentId,
      idempotencyKey: `attachment:discard:${attachmentId}`,
      type: "attachment.upload.discard",
    });
    if (result.type !== "attachment.upload.discard")
      throw new Error("Attachment discard response mismatch.");
  }

  activateThread(threadId: string): void {
    const id = ThreadIdSchema.safeParse(threadId);
    if (!id.success) return;
    const previous = this.#activeThreadId;
    this.#activeThreadId = threadId;
    if (previous && previous !== threadId) this.#releaseDetail(previous);
    this.#watchDetail(threadId);
    this.#stream.select({ kind: "thread", threadId: id.data });
  }

  deactivateThread(threadId: string) {
    if (threadId !== this.#activeThreadId) return;
    this.#activeThreadId = null;
    this.#stream.select(undefined);
    this.#releaseDetail(threadId);
  }

  deploymentPosition(): Sequence | null {
    const state = this.#stream.shell.getSnapshot();
    return state.synchronized ? SequenceSchema.parse(state.through) : null;
  }

  observeThread(threadId: string): () => void {
    const id = ThreadIdSchema.safeParse(threadId);
    if (!id.success) return () => {};
    this.#watchDetail(threadId);
    this.#observedThreads.set(threadId, (this.#observedThreads.get(threadId) ?? 0) + 1);
    const release = this.#stream.observe({ kind: "thread", threadId: id.data });
    return () => {
      release();
      const count = this.#observedThreads.get(threadId) ?? 0;
      if (count <= 1) this.#observedThreads.delete(threadId);
      else this.#observedThreads.set(threadId, count - 1);
      this.#releaseDetail(threadId);
    };
  }

  getThreadTranscript(threadId: string) {
    return this.#scopeReaders.get(threadId);
  }

  getThreadItemText(threadId: string, nodeId?: string) {
    const scope = this.#detailScope(threadId, nodeId);
    return scope && this.#stream.peekDetail(scope)?.text;
  }

  getCachedTranscriptItem(threadId: string, itemId: string, nodeId?: string) {
    const scope = this.#detailScope(threadId, nodeId);
    const state = scope && this.#stream.peekDetail(scope)?.transcript.getSnapshot();
    const item = state?.items.get(itemId);
    if (!scope || !state?.synchronized || !item) return;
    return this.#bodies.peek(transcriptBodyKey(scope, state.generation, itemId), item.revision);
  }

  subscribeTranscriptBody(
    threadId: string,
    _itemId: string,
    nodeId: string | undefined,
    listener: () => void,
  ) {
    const scope = this.#detailScope(threadId, nodeId);
    const releaseScope = scope && this.#stream.peekDetail(scope)?.transcript.subscribe(listener);
    const releaseCache = this.#bodies.subscribe(listener);
    return () => {
      releaseScope?.();
      releaseCache();
    };
  }

  async readTranscriptItem(threadId: string, itemId: string, nodeId?: string) {
    if (!nodeId) return this.#reader(threadId)?.body(itemId);
    const scope = this.#detailScope(threadId, nodeId);
    const detail = scope && this.#stream.peekDetail(scope);
    if (!detail) return;
    const reader = new ScopedThreadReader(detail, this.rpc, this.#bodies, false);
    try {
      return await reader.body(itemId);
    } finally {
      reader.dispose();
    }
  }

  setTranscriptAnchor(threadId: string, itemId: string | undefined) {
    this.#reader(threadId)?.setAnchor(itemId);
  }

  async loadMoreOverlays(threadId: string, kind: "requests" | "tools" | "nodes") {
    await this.#reader(threadId)?.loadMoreOverlays(kind);
  }

  loadEarlierTranscript(threadId: string) {
    return this.#reader(threadId)?.history("earlier") ?? Promise.resolve();
  }

  loadNewerTranscript(threadId: string) {
    return this.#reader(threadId)?.history("newer") ?? Promise.resolve();
  }

  loadTranscriptAround(threadId: string, messageId: string) {
    return this.#reader(threadId)?.history("around", messageId) ?? Promise.resolve();
  }

  loadLatestTranscript(threadId: string) {
    return this.#reader(threadId)?.history("latest") ?? Promise.resolve();
  }

  loadThreadInputQueue(threadId: string) {
    const reader = this.#reader(threadId);
    return reader ? reader.queue() : Promise.reject(new Error("Conversation unavailable."));
  }

  #detailScope(threadId: string, nodeId?: string) {
    const thread = ThreadIdSchema.safeParse(threadId);
    if (!thread.success) return;
    if (!nodeId) return { kind: "thread", threadId: thread.data } as const;
    const node = ExecutionNodeIdSchema.safeParse(nodeId);
    return node.success
      ? ({ kind: "node", threadId: thread.data, nodeId: node.data } as const)
      : undefined;
  }

  #reader(threadId: string) {
    const scope = this.#detailScope(threadId);
    if (!scope) return;
    return this.#scopeReaders.get(threadId);
  }

  #watchDetail(threadId: string) {
    const scope = this.#detailScope(threadId);
    if (!scope || this.#threadReaders.has(threadId)) return;
    const detail = this.#stream.detail(scope);
    this.#scopeReaders.set(threadId, new ScopedThreadReader(detail, this.rpc, this.#bodies));
    let placeItems: ReturnType<typeof detail.transcript.getSnapshot>["items"] | undefined;
    let placeQueue: NonNullable<
      ReturnType<typeof detail.transcript.getSnapshot>["snapshot"]
    >["queue"];
    let placedRuns = new Set<RunId>();
    let previousThread:
      | NonNullable<ReturnType<typeof detail.transcript.getSnapshot>["snapshot"]>["thread"]
      | undefined;
    let detailGeneration = 0;
    const clearPlaces = () => {
      for (const runId of placedRuns) this.#runPlaces.forget(runId);
      placedRuns.clear();
      placeItems = undefined;
      placeQueue = undefined;
      this.#runPlaces.flush();
    };
    const release = detail.transcript.subscribe(() => {
      const state = detail.transcript.getSnapshot();
      if (state.removed) {
        clearPlaces();
        this.#clearDetailReads(threadId);
        const threads = this.#snapshot.threads.filter(({ id }) => id !== threadId);
        const lookups = Object.entries(this.#snapshot.threadLookups)
          .filter(([id]) => id !== threadId)
          .slice(-127);
        this.#update({
          ...this.#snapshot,
          threads,
          threadLookups: { ...Object.fromEntries(lookups), [threadId]: "missing" },
        });
        return;
      }
      const row = state.snapshot?.thread;
      if (row && row !== previousThread) {
        previousThread = row;
        const thread = this.#threadState.reconcile(
          row.thread
            ? toThreadSummary(row.thread, this.#snapshot.environments, this.#snapshot.harnesses)
            : compactThread(row),
          SequenceSchema.parse(row.revision),
        );
        const threads = upsertThread(this.#snapshot.threads, thread);
        if (threads !== this.#snapshot.threads) this.#update({ ...this.#snapshot, threads });
      }
      if (!state.synchronized || !this.#showsThread(threadId)) return;
      if (placeItems !== state.items || placeQueue !== state.snapshot?.queue) {
        placeItems = state.items;
        placeQueue = state.snapshot?.queue;
        const next = new Set<RunId>();
        const runIds = new Set(placeQueue?.runs.map(({ id }) => id));
        for (let i = state.ids.length - 1; i >= 0 && next.size < runIds.size; i--) {
          const item = state.items.get(state.ids[i]!);
          if (
            item?.kind !== "place" ||
            !item.place ||
            !item.runId ||
            !runIds.has(item.runId) ||
            next.has(item.runId)
          )
            continue;
          next.add(item.runId);
          this.#runPlaces.accept(
            { runId: item.runId, sequence: SequenceSchema.parse(item.revision), data: item.place },
            false,
          );
        }
        for (const runId of placedRuns) {
          if (!runIds.has(runId)) this.#runPlaces.end(runId, false);
          else next.add(runId);
        }
        placedRuns = next;
        this.#runPlaces.flush();
      }

      if (detailGeneration !== state.generation) {
        detailGeneration = state.generation;
        this.#ensureAssignments(threadId);
        this.#ensureAutomations(threadId);
        this.#ensureBrowserUsage(threadId, "missing");
      }
    });
    this.#threadReaders.set(threadId, () => {
      release();
      clearPlaces();
    });
  }

  #releaseDetail(threadId: string) {
    if (this.#showsThread(threadId)) return;
    this.#threadReaders.get(threadId)?.();
    this.#threadReaders.delete(threadId);
    this.#scopeReaders.get(threadId)?.dispose();
    this.#scopeReaders.delete(threadId);
    this.#clearDetailReads(threadId);
  }

  #clearDetailReads(threadId: string) {
    const read = this.#assignmentReads.get(threadId);
    if (read && read !== "read") read.abort();
    this.#assignmentReads.delete(threadId);
    this.#automationReads.delete(threadId);
    this.#readAutomations.delete(threadId);
    this.#browserUsageRead.delete(threadId);
    this.#browserUsageReads.delete(threadId);
    this.#browserUsageRunSources.delete(threadId);
    const browserUsesChanged = this.#browserUses.delete(threadId);
    const { [threadId]: browserState, ...browserUsage } = this.#snapshot.browserUsage ?? {};
    const { [threadId]: automationState, ...threadAutomations } = this.#snapshot.threadAutomations;
    if (browserState || automationState || browserUsesChanged)
      this.#update({
        ...this.#snapshot,
        browserUsage,
        threadAutomations,
        browserUses: browserUsesChanged
          ? [...this.#browserUses.values()].flat()
          : this.#snapshot.browserUses,
      });
  }

  #clearViewerReads() {
    for (const read of this.#assignmentReads.values()) if (read !== "read") read.abort();
    this.#assignmentReads.clear();
    this.#automationReads.clear();
    this.#readAutomations.clear();
    this.#browserUsageRead.clear();
    this.#browserUsageReads.clear();
    this.#browserUsageRunSources.clear();
    this.#browserUses.clear();
    this.#deniedAssignments.clear();
  }

  watchNode(threadId: string, nodeId: string): NodeDetailSubscription {
    const scope = this.#detailScope(threadId, nodeId);
    if (scope?.kind !== "node") throw new Error("Invalid subagent scope.");
    const detail = this.#stream.detail(scope);
    const reader = new ScopedThreadReader(detail, this.rpc, this.#bodies);
    const release = this.#stream.observe(scope);
    let previous: ReturnType<typeof detail.transcript.getSnapshot> | undefined;
    const cards = new WeakMap<TranscriptItem, ReturnType<typeof nodeTranscriptCard>>();
    let view: NodeDetailSnapshot = {
      threadId,
      nodeId,
      node: null,
      status: "loading",
      entries: [],
      hasMore: false,
      error: null,
      loadingOlder: false,
    };
    return {
      getSnapshot: () => {
        const state = detail.transcript.getSnapshot();
        if (previous === state) return view;
        const structureChanged =
          previous?.items !== state.items || previous.liveItems !== state.liveItems;
        const subject = state.snapshot?.nodeSubject;
        const node =
          subject === previous?.snapshot?.nodeSubject
            ? view.node
            : subject
              ? transcriptCard(subject)
              : null;
        const status = state.removed ? "missing" : state.synchronized ? "ready" : "loading";
        const hasMore = state.snapshot?.nextBefore != null;
        previous = state;
        if (
          !structureChanged &&
          node === view.node &&
          status === view.status &&
          hasMore === view.hasMore
        )
          return view;
        const entries = !structureChanged
          ? view.entries
          : [...state.ids, ...state.liveItems.keys()].flatMap((id) => {
              const item = state.items.get(id) ?? state.liveItems.get(id);
              if (!item) return [];
              if (!cards.has(item)) cards.set(item, nodeTranscriptCard(item));
              return cards.get(item) ?? [];
            });
        view = {
          ...view,
          entries,
          status,
          hasMore,
          generation: state.generation,
          node: node?.kind === "node" ? node : null,
        };
        return view;
      },
      subscribe: detail.transcript.subscribe,
      loadOlder: () => reader.history("earlier"),
      retry: () => {
        void reader.history("latest");
      },
      release: () => {
        release();
        reader.dispose();
      },
    };
  }

  readonly watchPersonalResource = (kind: PersonalResourceKind, listener: () => void) => {
    const release = this.#stream.watchResource(kind, listener);
    this.#readResource(kind);
    return () => {
      release();
      if (!this.#stream.resources.isObserved(kind)) {
        this.#resourceReads.get(kind)?.controller.abort();
        this.#resourceReads.delete(kind);
      }
    };
  };

  #publishShell() {
    const state = this.#stream.shell.getSnapshot();
    const old = this.#publishedShell;
    this.#publishedShell = state;
    const shellAuthority = state.snapshot;
    if (
      shellAuthority &&
      this.#snapshot.user &&
      (this.#snapshot.user.id !== shellAuthority.viewerId ||
        this.#snapshot.deploymentId !== shellAuthority.deploymentId ||
        old?.snapshot?.epoch !== shellAuthority.epoch ||
        (shellAuthority.session && this.#snapshot.sessionId !== shellAuthority.session.sessionId))
    ) {
      this.#viewerGeneration++;
      this.#threadState.clear();
      this.#resourceRevisions.clear();
      this.#returnHintRevisions.clear();
      for (const kind of returnHintResources)
        this.#returnHintRevisions.set(kind, shellAuthority.resourceRevisions[kind]);
      this.#environmentCatalogs.clear();
      this.#environmentAuth.clear();
      this.#bodies.clear();
      this.#clearAttachmentReads();
      this.#threadDeployment.clear();
      this.#clearViewerReads();
      this.#invalidateAttention();
      for (const { controller } of this.#resourceReads.values()) controller.abort();
      this.#resourceReads.clear();
      this.#update(emptySnapshot(this.#tabs));
    }
    const shell = state.snapshot;
    if (!shell || this.#disposed) return;
    const connection = state.synchronized
      ? "connected"
      : this.#snapshot.connection === "connected"
        ? "connecting"
        : this.#snapshot.connection;
    const session = shell.session;
    const tasksChanged =
      old?.tasks !== state.tasks ||
      old.taskIds !== state.taskIds ||
      old.snapshot?.recentTaskIds !== shell.recentTaskIds ||
      old.snapshot?.activeTaskIds !== shell.activeTaskIds ||
      old.snapshot?.nextBefore !== shell.nextBefore;
    const visitsChanged = old?.visits !== state.visits;
    if (
      session &&
      (this.#snapshot.user?.id !== session.user.id ||
        this.#snapshot.sessionId !== session.sessionId)
    ) {
      this.#update({
        ...this.#snapshot,
        deploymentId: shell.deploymentId,
        deploymentShape: { kind: "personal" },
        user: session.user,
        can: session.can,
        session: "authenticated",
        sessionId: session.sessionId,
        sessionSurface: session.sessionSurface,
      });
    }
    const attentionChanged =
      old?.attention !== state.attention ||
      old.snapshot?.counts.pendingRequestCount !== shell.counts.pendingRequestCount ||
      old.snapshot?.counts.needsYouCount !== shell.counts.needsYouCount;
    if (
      tasksChanged ||
      visitsChanged ||
      attentionChanged ||
      connection !== this.#snapshot.connection
    ) {
      let taskLists: Pick<HostSnapshot, "tasks" | "activeTasks"> | undefined;
      if (tasksChanged) {
        const entries = state.taskIds.flatMap((id) => {
          const row = state.tasks.get(id);
          if (!row) return [];
          const cached = this.#shellEntries.get(row);
          if (cached) return [cached];
          const thread = this.#threadState.reconcile(
            row.thread
              ? toThreadSummary(row.thread, this.#snapshot.environments, this.#snapshot.harnesses)
              : compactThread(row),
            SequenceSchema.parse(row.revision),
          );
          const entry = { thread, lastReply: row.lastReplyPreview, failure: row.failurePreview };
          this.#shellEntries.set(row, entry);
          return [entry];
        });
        const byId = new Map(entries.map((entry) => [entry.thread.id, entry]));
        const members = (ids: readonly string[]) => ids.flatMap((id) => byId.get(id) ?? []);
        const recent = shell.recentTaskIds
          ? members(shell.recentTaskIds)
          : entries.filter(({ thread }) => thread.doneAt === null);
        taskLists = {
          tasks: {
            entries: recent,
            window: {
              nextBefore: shell.nextBefore ?? null,
              hasMore: shell.nextBefore != null,
              totalItems: recent.length,
              byteCount: 0,
              itemCount: recent.length,
            },
          },
          activeTasks: shell.activeTaskIds
            ? members(shell.activeTaskIds)
            : entries.filter(
                ({ thread }) => thread.status === "running" || thread.status === "waiting",
              ),
        };
      }
      if (state.synchronized) this.#savedViewReadiness = { tasksReady: true };
      this.#update({
        ...this.#snapshot,
        connection,
        connectionInterrupted: state.synchronized ? false : this.#snapshot.connectionInterrupted,
        ...taskLists,
        ...(attentionChanged
          ? {
              attentionSummaries: [...state.attention.values()],
              pendingRequestCount: shell.counts.pendingRequestCount,
              needsYouCount: shell.counts.needsYouCount,
            }
          : {}),
        ...(visitsChanged
          ? {
              threadVisits: Object.fromEntries(
                [...state.visits].map(([id, visit]) => [id, visit.lastVisitedAt]),
              ),
            }
          : {}),
      });
    }
    if (state.synchronized && !old?.synchronized) {
      this.#attempt = 0;
      this.#finishLoad();
      this.references.reconnect();
      this.#invalidatePersonalRemoteAccess();
      this.#reverifyCapabilities();
      const { interests } = this.#stream.resources.getInterests();
      for (const kind of interests) this.#readResource(kind);
    }
    if (
      state.synchronized &&
      (shell.counts.needsYouCount || this.#snapshot.needsYou) &&
      (!old?.synchronized || attentionChanged)
    )
      this.#invalidateAttention(true);
  }

  #attentionRead: { controller: AbortController; promise: Promise<void> } | undefined;
  #attentionTarget = 0;

  #invalidateAttention(refresh = false) {
    this.#attentionRead?.controller.abort();
    this.#attentionRead = undefined;
    if (!refresh) {
      this.#attentionTarget = 0;
      if (this.#snapshot.needsYou) this.#update({ ...this.#snapshot, needsYou: null });
      return;
    }
    if (this.#attentionTarget) void this.#readAttention(true).catch(() => undefined);
  }

  #resourceChanged(kind: PersonalResourceKind) {
    const installed = this.#stream.resources.get(kind);
    const revision = this.#stream.resources.getKnownRevision(kind);
    const summary =
      installed && BigInt(installed.revision) >= BigInt(revision ?? "0")
        ? installed.view
        : undefined;
    if (this.#snapshot.resourceSummaries?.[kind] !== summary) {
      const summaries = { ...this.#snapshot.resourceSummaries };
      if (summary) summaries[kind] = summary;
      else delete summaries[kind];
      this.#update({ ...this.#snapshot, resourceSummaries: summaries });
    }
    const read = this.#resourceReads.get(kind);
    if (read && (!summary || read.revision !== installed?.revision)) {
      read.controller.abort();
      this.#resourceReads.delete(kind);
    }
    const details = this.#resourceRevisions.get(kind);
    if (
      details &&
      (!installed ||
        BigInt(details) < BigInt(revision ?? "0") ||
        BigInt(details) < BigInt(installed.revision))
    ) {
      this.#resourceRevisions.delete(kind);
      this.#clearResource(kind);
    }
    if (returnHintResources.has(kind)) {
      const known = summary ? installed?.revision : revision;
      const previous = this.#returnHintRevisions.get(kind);
      if (known && (!previous || BigInt(known) > BigInt(previous))) {
        this.#returnHintRevisions.set(kind, known);
        const id = this.#activeThreadId;
        if (
          previous &&
          id &&
          this.#snapshot.threads.some((row) => row.id === id && row.returnHint)
        ) {
          this.#threadState.forget(id);
          this.#update({
            ...this.#snapshot,
            threads: this.#snapshot.threads.map((row) =>
              row.id === id ? { ...row, returnHint: null } : row,
            ),
          });
          const scope = this.#detailScope(id);
          if (scope) this.#stream.repairDetail(scope);
        }
      }
    }
    this.#readResource(kind);
  }

  #clearResource(kind: PersonalResourceKind) {
    const snapshot = this.#snapshot;
    switch (kind) {
      case "machine":
        this.#update({ ...snapshot, machines: [], machineRevision: snapshot.machineRevision + 1 });
        break;
      case "environment":
        this.#update({ ...snapshot, environments: [] });
        break;
      case "harness":
        this.#update({ ...snapshot, harnesses: [] });
        break;
      case "harness-catalog":
        this.#environmentCatalogs.clear();
        this.#update({
          ...snapshot,
          environments: snapshot.environments.map((row) => ({ ...row, harnessCatalogs: [] })),
        });
        break;
      case "harness-auth":
        this.#environmentAuth.clear();
        this.#update({
          ...snapshot,
          environments: snapshot.environments.map((row) => ({
            ...row,
            harnessAuthenticationAllowed: false,
          })),
        });
        break;
      case "browser-placement":
        this.#update({ ...snapshot, browserPlacements: [] });
        break;
      case "browser-profile":
        this.#update({ ...snapshot, browserProfiles: [], browserProfileDeletions: [] });
        break;
      case "browser-home":
        this.#update({ ...snapshot, browserProfileHomes: [] });
        break;
      case "browser-availability":
        this.#update({ ...snapshot, browserAvailable: false });
        break;
      case "identity":
        this.#update({ ...snapshot, identityConfig: null });
        break;
      case "owner-profile":
        this.#update({ ...snapshot, ownerProfile: null });
        break;
      case "settings":
        this.#update({
          ...snapshot,
          personalSettings: null,
          quietTaskDays: null,
          executionPreferences: emptyExecutionPreferences,
          voiceThreadId: null,
        });
        break;
      case "tab":
        this.#tabs.invalidateInventory();
        break;
      case "tab-layout":
        this.#tabs.invalidateLayout();
        break;
    }
  }

  #readResource(kind: PersonalResourceKind) {
    const installed = this.#stream.resources.get(kind);
    if (
      !installed ||
      !this.#stream.resources.isObserved(kind) ||
      !this.#stream.shell.getSnapshot().synchronized ||
      BigInt(installed.revision) < BigInt(this.#stream.resources.getKnownRevision(kind) ?? "0") ||
      this.#visibility === "background" ||
      this.#resourceReads.has(kind) ||
      this.#resourceRevisions.get(kind) === installed.revision
    )
      return;
    const controller = new AbortController();
    const request = { controller, revision: installed.revision };
    this.#resourceReads.set(kind, request);
    const scope = this.#stream.shell.getSnapshot().generation;
    const current = () =>
      !controller.signal.aborted &&
      this.#resourceReads.get(kind) === request &&
      this.#stream.shell.getSnapshot().generation === scope &&
      this.#stream.resources.get(kind)?.revision === installed.revision &&
      BigInt(installed.revision) >= BigInt(this.#stream.resources.getKnownRevision(kind) ?? "0");
    const read = async () => {
      let cursor: string | undefined;
      let retainedBytes = 0;
      const cursors = new Set<string>();
      do {
        const result = await this.rpc["resources.detail.get"](
          { kind, expectedRevision: installed.revision, ...(cursor ? { cursor } : {}) },
          { signal: controller.signal },
        );
        if (
          !result.ok ||
          !current() ||
          result.data.data.kind !== kind ||
          result.data.revision !== installed.revision ||
          (result.data.next && cursors.has(result.data.next))
        )
          return;
        this.#resourceRevisions.set(kind, result.data.revision);
        retainedBytes += utf8ByteLength(JSON.stringify(result.data));
        if (retainedBytes > resourceInventoryByteBudget) return;
        this.#applyResource(result.data.data, cursor !== undefined, result.data.next !== null);
        cursor = result.data.next ?? undefined;
        if (cursor) cursors.add(cursor);
      } while (cursor);
    };
    void read()
      .catch(() => undefined)
      .finally(() => {
        if (this.#resourceReads.get(kind) === request) {
          this.#resourceReads.delete(kind);
          if (
            this.#stream.resources.get(kind)?.revision !== installed.revision ||
            this.#stream.shell.getSnapshot().generation !== scope
          )
            this.#readResource(kind);
        }
      });
  }

  #applyResource(
    data: import("zod").infer<
      typeof import("@opensteer/protocol/resources").PersonalResourceDataSchema
    >,
    append: boolean,
    hasMore: boolean,
  ) {
    const snapshot = this.#snapshot;
    switch (data.kind) {
      case "settings":
        this.#update({
          ...snapshot,
          personalSettings: data.settings,
          quietTaskDays: data.quietTaskDays,
          executionPreferences: data.executionPreferences,
          voiceThreadId: data.settings?.voiceThreadId ?? null,
        });
        break;
      case "identity":
        this.#update({ ...snapshot, identityConfig: data.identity });
        break;
      case "owner-profile":
        this.#update({ ...snapshot, ownerProfile: data.ownerProfile });
        break;
      case "environment":
        this.#update({
          ...snapshot,
          environments: mergeResourceRows(
            append ? snapshot.environments : [],
            data.environments.map((row) => this.#withEnvironmentCapabilities(row)),
            (row) => row.id,
          ),
        });
        break;
      case "harness-catalog":
      case "harness-auth":
        for (const row of data.environments)
          if (data.kind === "harness-catalog")
            this.#environmentCatalogs.set(row.id, row.harnessCatalogs);
          else this.#environmentAuth.set(row.id, row.harnessAuthenticationAllowed);
        this.#update({
          ...snapshot,
          environments: snapshot.environments.map((row) => this.#withEnvironmentCapabilities(row)),
        });
        break;
      case "machine":
        this.#update({
          ...snapshot,
          machines: mergeResourceRows(
            append ? snapshot.machines : [],
            data.machines,
            (row) => row.id,
          ),
          machineRevision: snapshot.machineRevision + 1,
        });
        break;
      case "harness":
        this.#update({
          ...snapshot,
          harnesses: mergeResourceRows(
            append ? snapshot.harnesses : [],
            data.harnesses.map(({ config, ...harness }) => ({
              ...harness,
              ...harnessEndpoint(config),
            })),
            (row) => row.id,
          ),
        });
        break;
      case "tab":
        this.#tabs.replaceCurrent({
          tabs: mergeResourceRows(
            append ? [...this.#tabs.rows.values()] : [],
            data.tabs.tabs,
            (tab) => tab.tabId,
          ),
          layout: this.#tabs.layout,
          complete: data.tabs.complete && !hasMore,
        });
        break;
      case "tab-layout":
        this.#tabs.replaceCurrent({
          tabs: [...this.#tabs.rows.values()],
          layout: {
            ...data.tabs.layout,
            items: mergeResourceRows(
              append && this.#tabs.layout.revision === data.tabs.layout.revision
                ? this.#tabs.layout.items
                : [],
              data.tabs.layout.items,
              (item) => (item.kind === "tab" ? item.tabId : item.group.groupId),
            ),
          },
          complete: this.#tabs.complete,
        });
        break;
      case "browser-profile":
        this.#update({
          ...snapshot,
          browserProfiles: mergeResourceRows(
            append ? snapshot.browserProfiles : [],
            data.profiles,
            (row) => row.id,
          ),
          browserProfileDeletions: mergeResourceRows(
            append ? (snapshot.browserProfileDeletions ?? []) : [],
            data.deletions ?? [],
            (row) => row.profileId,
          ),
        });
        break;
      case "browser-placement":
        this.#update({
          ...snapshot,
          browserPlacements: mergeResourceRows(
            append ? snapshot.browserPlacements : [],
            data.placements,
            (row) => row.runnerId,
          ),
        });
        break;
      case "browser-home":
        this.#update({
          ...snapshot,
          browserProfileHomes: mergeResourceRows(
            append ? (snapshot.browserProfileHomes ?? []) : [],
            data.homes ?? [],
            (runnerId) => runnerId,
          ),
        });
        break;
      case "browser-availability":
        this.#update({ ...snapshot, browserAvailable: data.available });
        break;
      case "agent-home-settings":
        break;
    }
  }

  #withEnvironmentCapabilities(row: EnvironmentSummary): EnvironmentSummary {
    return {
      ...row,
      harnessCatalogs: this.#environmentCatalogs.get(row.id) ?? [],
      harnessAuthenticationAllowed: this.#environmentAuth.get(row.id) ?? false,
    };
  }

  async getAssignment(assignmentId: string): Promise<AssignmentView> {
    const generation = this.#viewerGeneration;
    const userId = this.#snapshot.user?.id;
    try {
      return unwrapRpcResult(await this.rpc["assignment.get"]({ assignmentId }));
    } catch (error) {
      if (this.#viewerStillCurrent(generation, userId)) this.#denyOnRefusal(error, [assignmentId]);
      throw error;
    }
  }

  async cancelAssignment(assignmentId: string): Promise<AssignmentSummary> {
    const generation = this.#viewerGeneration;
    const userId = this.#snapshot.user?.id;
    try {
      const result = await this.dispatch({
        assignmentId,
        idempotencyKey: `assignment:cancel:${assignmentId}`,
        type: "assignment.cancel",
      });
      if (result.type !== "assignment.cancel") throw new Error("Assignment command mismatch.");
      return result.assignment;
    } catch (error) {
      if (this.#viewerStillCurrent(generation, userId)) this.#denyOnRefusal(error, [assignmentId]);
      throw error;
    }
  }

  /** A 403 or 404 is the Host saying this viewer may not see these tasks at all. */
  #denyOnRefusal(error: unknown, assignmentIds: readonly string[]): void {
    if (
      !(error instanceof HostClientRequestError) ||
      (error.status !== 403 && error.status !== 404)
    )
      return;
    if (assignmentIds.length === 0) return;
    for (const id of assignmentIds) this.#deniedAssignments.add(id);
    this.#update(this.#snapshot);
  }

  /** Every assignment this client holds for a worker Thread, from summaries and transcripts alike. */
  #assignmentsOfWorker(workerThreadId: string): string[] {
    const ids = new Set<string>();
    for (const summary of Object.values(this.#snapshot.assignments)) {
      if (summary.workerThread.id === workerThreadId) ids.add(summary.id);
    }
    for (const reader of this.#scopeReaders.values()) {
      const { entries } = reader.getSnapshot();
      for (const entry of entries) {
        if (entry.kind === "assignment" && entry.assignment.workerThread.id === workerThreadId)
          ids.add(entry.assignment.id);
      }
    }
    return [...ids];
  }

  #ensureAssignments(threadId: string): void {
    if (this.#disposed || this.#snapshot.session !== "authenticated") return;
    if (this.#assignmentReads.has(threadId)) return;
    const read = new AbortController();
    this.#assignmentReads.set(threadId, read);
    void this.#readAssignments(threadId, read.signal)
      .catch(() => undefined)
      .finally(() => {
        if (this.#assignmentReads.get(threadId) === read)
          this.#assignmentReads.set(threadId, "read");
      });
  }

  #ensureAutomations(threadId: string, again = false): void {
    if (
      this.#disposed ||
      this.#snapshot.session !== "authenticated" ||
      !this.#capabilities?.includes("task-family-v1")
    )
      return;
    const pending = this.#automationReads.get(threadId);
    if (pending) {
      pending.again ||= again;
      return;
    }
    if (!again && this.#readAutomations.has(threadId)) return;
    const read = { again: false };
    this.#automationReads.set(threadId, read);
    void this.#loadAutomations(threadId, read)
      .catch(() => undefined)
      .finally(() => {
        if (this.#automationReads.get(threadId) !== read) return;
        this.#automationReads.delete(threadId);
        // A failure counts as read too, so a streaming conversation does not
        // ask again with every event; opening it again does.
        this.#readAutomations.add(threadId);
        if (read.again) this.#ensureAutomations(threadId, true);
      });
  }

  async #loadAutomations(threadId: string, read: { again: boolean }): Promise<void> {
    const generation = this.#viewerGeneration;
    const userId = this.#snapshot.user?.id;
    try {
      const response = unwrapRpcResult(
        await this.rpc["triggers.list"]({ anchorThreadId: threadId }),
      );
      if (!this.#viewerStillCurrent(generation, userId)) return;
      if (this.#automationReads.get(threadId) !== read) return;
      const automations = familyAutomations(response.triggers, threadId);
      const held = this.#snapshot.threadAutomations[threadId] ?? [];
      if (JSON.stringify(held) === JSON.stringify(automations)) return;
      this.#update({
        ...this.#snapshot,
        threadAutomations: { ...this.#snapshot.threadAutomations, [threadId]: automations },
      });
    } catch (error) {
      if (
        this.#viewerStillCurrent(generation, userId) &&
        this.#automationReads.get(threadId) === read &&
        error instanceof HostClientRequestError &&
        (error.status === 403 || error.status === 404)
      ) {
        const { [threadId]: _denied, ...threadAutomations } = this.#snapshot.threadAutomations;
        this.#update({ ...this.#snapshot, threadAutomations });
      }
      throw error;
    }
  }

  /**
   * The newest page, which is all the history a family shows, and every open
   * Assignment however far back it was handed out, so work under way is never
   * missing. A Host without `task-family-v1` gives the newest page alone.
   */
  async #readAssignments(threadId: string, signal: AbortSignal): Promise<void> {
    await Promise.all([
      this.#readAssignmentPages(threadId, false, signal),
      ...(this.#capabilities?.includes("task-family-v1")
        ? [this.#readAssignmentPages(threadId, true, signal)]
        : []),
    ]);
  }

  async #readAssignmentPages(threadId: string, open: boolean, signal: AbortSignal): Promise<void> {
    const generation = this.#viewerGeneration;
    const userId = this.#snapshot.user?.id;
    const current = () => !signal.aborted && this.#viewerStillCurrent(generation, userId);
    let before: string | null = null;
    do {
      let response;
      try {
        response = unwrapRpcResult(
          await this.rpc["thread.assignments.list"](
            {
              threadId,
              limit: 100,
              ...(open ? { open } : {}),
              ...(before === null ? {} : { before }),
            },
            { signal },
          ),
        );
      } catch (error) {
        if (current()) this.#denyOnRefusal(error, this.#assignmentsOfWorker(threadId));
        throw error;
      }
      if (!current()) return;
      if (response.threadId !== threadId) throw new Error("Assignment page Thread mismatch.");
      this.#update({
        ...this.#snapshot,
        assignments: mergeAssignments(this.#snapshot.assignments, response.assignments),
      });
      before = open && response.window.hasMore ? response.window.nextBefore : null;
    } while (before !== null);
  }

  /** Every Run whose browser use this Thread shows: its own, and its tasks' workers'. */
  #browserUsageRunIds(threadId: string): ReadonlySet<string> {
    const runIds = new Set<string>();
    for (const entry of this.#reader(threadId)?.getSnapshot().entries ?? []) {
      if ("runId" in entry && entry.runId) runIds.add(entry.runId);
      if (entry.kind === "assignment") {
        runIds.add(entry.assignment.initialRunId);
        if (entry.assignment.currentRunId) runIds.add(entry.assignment.currentRunId);
      }
    }
    for (const assignment of Object.values(this.#snapshot.assignments)) {
      if (assignment.parentThreadId !== threadId) continue;
      runIds.add(assignment.initialRunId);
      if (assignment.currentRunId) runIds.add(assignment.currentRunId);
    }
    for (const run of this.#scopeReaders.get(threadId)?.getSnapshot().runQueue ?? [])
      runIds.add(run.id);
    return runIds;
  }

  #showsThread(threadId: string): boolean {
    return threadId === this.#activeThreadId || this.#observedThreads.has(threadId);
  }

  #triggersChanged(deploymentId: string): void {
    this.#refreshShownAutomations(deploymentId);
    this.#update({ ...this.#snapshot, triggerRevision: this.#snapshot.triggerRevision + 1 });
  }

  #refreshShownAutomations(deploymentId: string): void {
    for (const threadId of new Set([this.#activeThreadId, ...this.#observedThreads.keys()])) {
      if (threadId !== null && this.#threadDeployment.get(threadId) === deploymentId)
        this.#ensureAutomations(threadId, true);
    }
  }

  #ensureBrowserUsage(threadId: string, mode: "full" | "missing"): void {
    if (
      this.#disposed ||
      this.#snapshot.session !== "authenticated" ||
      !ThreadIdSchema.safeParse(threadId).success ||
      !this.#showsThread(threadId)
    )
      return;
    if (!this.#stream.shell.getSnapshot().synchronized) return;
    const pending = this.#browserUsageReads.get(threadId);
    if (pending) {
      if (mode === "full") pending.again = "full";
      else pending.again ??= "missing";
      return;
    }
    const known = this.#browserUsageRead.get(threadId);
    const runIds = [...this.#browserUsageRunIds(threadId)].sort();
    const scope = mode === "full" || !known ? null : runIds.filter((runId) => !known.has(runId));
    if (scope?.length === 0) return;
    const read: { again: "full" | "missing" | null } = { again: null };
    this.#browserUsageReads.set(threadId, read);
    if (!this.#snapshot.browserUsage?.[threadId]) {
      this.#update({
        ...this.#snapshot,
        browserUsage: {
          ...this.#snapshot.browserUsage,
          [threadId]: { loading: true, error: null },
        },
      });
    }
    void this.#readBrowserUsage(threadId, scope ?? runIds, scope === null, read)
      .catch(() => false)
      .then((settled) => {
        if (this.#browserUsageReads.get(threadId) !== read) return;
        this.#browserUsageReads.delete(threadId);
        // A first read given up on, its conversation no longer shown, leaves
        // nothing loading; the conversation is read whole when next shown.
        const usage = this.#snapshot.browserUsage;
        if (!settled && usage?.[threadId]?.loading) {
          const { [threadId]: _abandoned, ...rest } = usage;
          this.#update({ ...this.#snapshot, browserUsage: rest });
        }
        if (read.again) this.#ensureBrowserUsage(threadId, read.again);
      });
  }

  /** The Host says these conversations gained a browser use. */
  #browserUsageChanged(threadIds: readonly string[]): void {
    for (const threadId of threadIds) {
      if (this.#showsThread(threadId)) this.#ensureBrowserUsage(threadId, "full");
      // Not shown here, so not read now: the next time it is, it is read whole.
      else this.#browserUsageRead.delete(threadId);
    }
  }

  /** False when the read was given up on before it could answer anything. */
  async #readBrowserUsage(
    threadId: string,
    runIds: readonly string[],
    whole: boolean,
    read: { again: "full" | "missing" | null },
  ): Promise<boolean> {
    const generation = this.#viewerGeneration;
    const userId = this.#snapshot.user?.id;
    const deploymentId = this.#snapshot.deploymentId;
    const current = () =>
      this.#viewerStillCurrent(generation, userId) &&
      this.#snapshot.deploymentId === deploymentId &&
      this.#browserUsageReads.get(threadId) === read &&
      this.#showsThread(threadId);
    const uses = new Map<string, BrowserSessionUsageProjection>();
    try {
      for (
        let offset = 0;
        offset < Math.max(1, runIds.length);
        offset += browserUsageRunBatchSize
      ) {
        const response = unwrapRpcResult(
          await this.rpc["thread.browserUsage.get"]({
            threadId,
            runIds: runIds
              .slice(offset, offset + browserUsageRunBatchSize)
              .map((id) => RunIdSchema.parse(id)),
          }),
        );
        if (!current()) return false;
        if (
          response.threadId !== threadId ||
          response.uses.some((use) => use.threadId !== threadId)
        )
          throw new Error("Browser usage Thread mismatch.");
        for (const use of response.uses) uses.set(browserUseKey(use.sessionId, use), use);
      }
    } catch (error) {
      if (!current()) return false;
      const message =
        error instanceof Error ? error.message : "Could not load this conversation’s browsers.";
      if (error instanceof HostClientRequestError && [403, 404].includes(error.status)) {
        this.#replaceBrowserUsage(threadId, [], { runIds: null }, message);
      } else {
        const existing = this.#snapshot.browserUsage?.[threadId];
        this.#update({
          ...this.#snapshot,
          browserUsage: {
            ...this.#snapshot.browserUsage,
            // What was read before stays shown; only a first read can still be loading.
            [threadId]: { loading: false, error: existing?.loading === false ? null : message },
          },
        });
      }
      return true;
    }
    if (!current()) return false;
    const known = whole ? new Set<string>() : new Set(this.#browserUsageRead.get(threadId));
    for (const runId of runIds) known.add(runId);
    this.#browserUsageRead.set(threadId, known);
    this.#replaceBrowserUsage(threadId, [...uses.values()], { runIds: whole ? null : runIds });
    return true;
  }

  /**
   * Replaces what a read answered for: a whole read replaces every use of the
   * Thread; a read of some Runs replaces the Thread's own uses and those Runs'.
   */
  #replaceBrowserUsage(
    threadId: string,
    uses: readonly BrowserSessionUsageProjection[],
    scope: { readonly runIds: readonly string[] | null },
    error: string | null = null,
  ): void {
    const replaced = scope.runIds === null ? null : new Set(scope.runIds);
    this.#browserUses.set(threadId, [
      ...(this.#browserUses.get(threadId) ?? []).filter(
        (use) => replaced !== null && use.runId !== null && !replaced.has(use.runId),
      ),
      ...uses,
    ]);
    this.#update({
      ...this.#snapshot,
      browserUsage: { ...this.#snapshot.browserUsage, [threadId]: { loading: false, error } },
      browserUses: [...this.#browserUses.values()].flat(),
    });
  }

  /**
   * Runs that appeared in a shown Thread since its usage was read. A Run
   * arrives as new entries, a history page, a task or a queued Run; a reply
   * streaming into its last entry adds none, so it is not walked for that.
   */
  #checkBrowserUsageRuns(): void {
    for (const threadId of [this.#activeThreadId, ...this.#observedThreads.keys()]) {
      if (!threadId || !this.#browserUsageRead.has(threadId)) continue;
      const transcript = this.#reader(threadId)?.getSnapshot().entries ?? [];
      const sources = [
        transcript.length,
        transcript[0]?.id,
        transcript.at(-1)?.id,
        this.#snapshot.assignments,
        this.#scopeReaders.get(threadId)?.getSnapshot().runQueue,
      ] as const;
      const checked = this.#browserUsageRunSources.get(threadId);
      if (checked && checked.every((source, index) => source === sources[index])) continue;
      this.#browserUsageRunSources.set(threadId, sources);
      this.#ensureBrowserUsage(threadId, "missing");
    }
  }

  /** Which apps an agent is acting in on the reader's Macs; patched in place. */
  #applyComputerPresence(
    sessions: readonly {
      readonly actingAppKeys: readonly string[];
      readonly actingDisplay?: boolean | undefined;
      readonly sessionId: string;
    }[],
  ): void {
    const byId = new Map(sessions.map((session) => [session.sessionId, session]));
    for (const sessionId of byId.keys())
      this.#presenceMarks.set(sessionId, ++this.#presenceCounter);
    let changed = false;
    const machines = this.#snapshot.machines.map((machine) => {
      const computerUse = machine.computerUse;
      if (!computerUse?.sessions.some((session) => byId.has(session.sessionId))) return machine;
      return {
        ...machine,
        computerUse: {
          ...computerUse,
          sessions: computerUse.sessions.map((session) => {
            const presence = byId.get(session.sessionId);
            const actingAppKeys = presence?.actingAppKeys;
            if (
              !actingAppKeys ||
              (sameKeys(session.actingAppKeys, actingAppKeys) &&
                presence?.actingDisplay === session.actingDisplay)
            )
              return session;
            changed = true;
            return {
              ...session,
              actingAppKeys: [...actingAppKeys],
              ...(presence?.actingDisplay === undefined
                ? {}
                : { actingDisplay: presence.actingDisplay }),
            };
          }),
        },
      };
    });
    if (changed) this.#update({ ...this.#snapshot, machines });
  }

  async load(): Promise<void> {
    if (this.#disposed) throw new Error("The Host client is closed.");
    if (
      this.#snapshot.session === "authentication-required" ||
      this.#stream.shell.getSnapshot().synchronized
    )
      return;
    if (this.#load) return this.#load;
    if (this.#reconnectSuspended()) return;
    this.#started = true;
    const ready = new Promise<void>((resolve) => {
      this.#resolveLoad = resolve;
    });
    this.#load = ready;
    const generation = this.#socketGeneration;
    void this.#open().catch(() => {
      if (generation === this.#socketGeneration) this.#socketFailed();
    });
    return ready;
  }

  async refresh(options?: { readonly retryConnection?: boolean }): Promise<void> {
    if (this.#disposed) return;
    if (options?.retryConnection || !this.#socket) {
      this.#refused = false;
      this.#closeSocket();
      await this.load();
    } else {
      this.#stream.repairShell();
    }
  }

  async reauthenticate(): Promise<void> {
    if (this.#disposed) return;
    this.#refused = false;
    this.#update({ ...this.#snapshot, session: "checking" });
    this.#closeSocket();
    await this.load();
  }

  async searchThreadMessages(input: { threadId: string; query: string; before?: string }) {
    return unwrapRpcResult(await this.rpc["thread.messages.list"]({ ...input, limit: 50 }));
  }

  subscribeNotifications(listener: (notification: NotificationView) => void): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  subscribePluginsChanged(
    listener: (message: { type: "host.plugins-changed" }) => void,
  ): () => void {
    this.#pluginsChangedListeners.add(listener);
    return () => this.#pluginsChangedListeners.delete(listener);
  }
  subscribePersonalRemoteAccess(listener: () => void): () => void {
    this.#personalRemoteAccessListeners.add(listener);
    return () => this.#personalRemoteAccessListeners.delete(listener);
  }

  subscribeConnectionsChanged(listener: () => void): () => void {
    this.#connectionsListeners.add(listener);
    return () => this.#connectionsListeners.delete(listener);
  }

  #invalidatePersonalRemoteAccess(): void {
    for (const listener of this.#personalRemoteAccessListeners) listener();
  }

  subscribePersonShow(listener: (message: PersonShowMessage) => void): () => void {
    this.#personShowListeners.add(listener);
    return () => this.#personShowListeners.delete(listener);
  }

  #mergeVisits(
    rows: readonly { readonly id: string; readonly lastVisitedAt: string | null }[],
  ): boolean {
    const current = this.#snapshot.threadVisits;
    let merged: Record<string, string> | null = null;
    for (const row of rows) {
      if (row.lastVisitedAt && row.lastVisitedAt > ((merged ?? current)[row.id] ?? "")) {
        merged ??= { ...current };
        merged[row.id] = row.lastVisitedAt;
      }
    }
    if (merged) this.#snapshot = { ...this.#snapshot, threadVisits: merged };
    return merged !== null;
  }

  #applyVisits(visits: readonly ThreadVisit[]): void {
    if (
      !this.#mergeVisits(
        visits.map((visit) => ({ id: visit.threadId, lastVisitedAt: visit.lastVisitedAt })),
      )
    )
      return;
    this.#update(this.#snapshot);
  }

  async visitThread(threadId: string, visitedAt: string): Promise<void> {
    const generation = this.#viewerGeneration;
    const userId = this.#snapshot.user?.id;
    if ((this.#snapshot.threadVisits[threadId] ?? "") >= visitedAt) return;
    const result = await this.dispatch({
      type: "thread.visit",
      idempotencyKey: mutationIdempotencyKey(`visit:${threadId}`),
      threadId,
      visitedAt,
    });
    if (result.type !== "thread.visit") throw new Error("Visit command mismatch.");
    if (this.#viewerStillCurrent(generation, userId)) this.#applyVisits([result]);
  }

  #capabilities: readonly HostCapability[] | null;
  readonly #readCapabilities: HostCapabilityReader | null;
  #capabilityReadGeneration = 0;
  readonly automaticModelsAvailable = () =>
    this.#capabilities?.includes("automatic-models-v1") === true;
  readonly browserTargetControlAvailable = (): Promise<boolean | null> =>
    Promise.resolve(this.#capabilities?.includes("browser-target-control-v1") ?? null);

  readonly retainBrowserViewer = (
    sessionId: string,
    surfaceId: string,
    options?: {
      readonly picture?: boolean;
      readonly asleep?: boolean;
      readonly captureRegion?: boolean;
      readonly frameWindow?: boolean;
      readonly rasterDemand?: boolean;
    },
  ): (() => void) => {
    if (options?.picture === false && !this.#capabilities?.includes("browser-target-control-v1"))
      throw new Error("This Host does not advertise browser-target-control-v1.");
    return this.#targetedControl.retain(sessionId, surfaceId, options);
  };

  readonly retainBrowserWatch = (
    sessionId: string,
    surfaceId: string,
    options?: {
      readonly captureRegion?: boolean;
      readonly frameWindow?: boolean;
      readonly rasterDemand?: boolean;
    },
  ): (() => void) => this.#targetedWatch.retain(sessionId, surfaceId, options);

  acceptBrowserWatchFrame(sessionId: string, token: string, surfaceId: string): void {
    this.#targetedWatch.accept(sessionId, surfaceId, token);
    this.#targetedControl.accept(sessionId, surfaceId, token);
  }

  sendBrowserCommand(sessionId: string, command: BrowserCommand): void {
    if (
      command.type === "stream.subscribe" &&
      !this.#capabilities?.includes("browser-frame-window-v1")
    ) {
      const { frameWindow: _frameWindow, ...legacy } = command;
      command = legacy;
    }
    if (
      command.type === "navigation.reload" &&
      command.ignoreCache !== undefined &&
      this.#snapshot.browserSessions.find((session) => session.id === sessionId)
        ?.navigationVersion !== 1
    )
      throw new Error("This browser does not support reloading without cache.");
    if (
      command.type === "stream.subscribe" &&
      !this.#capabilities?.includes("browser-capture-region-v1")
    ) {
      const { captureRegion: _captureRegion, ...legacy } = command;
      command = legacy;
    }
    if (
      "surfaceId" in command &&
      command.surfaceId &&
      this.#targetedControl.has(sessionId, command.surfaceId)
    ) {
      this.#targetedControl.send(sessionId, command.surfaceId, command);
      return;
    }
    if (browserCommandNeedsNoView(command)) return;
    throw new Error("The browser view is not synchronized.");
  }

  async createThread(input: CreateThreadInput): Promise<ThreadSummary> {
    const result = await this.dispatch({
      type: "thread.create",
      accessMode: input.accessMode,
      environmentId: input.environmentId,
      harnessInstanceId: input.harnessInstanceId,
      idempotencyKey: input.idempotencyKey ?? mutationIdempotencyKey("thread"),
      modelSelection: input.modelSelection,
      ...(input.parentThreadId ? { parentThreadId: input.parentThreadId } : {}),
      ...(input.generateTitle ? { generateTitle: true } : {}),
      title: input.title?.trim() || "New task",
    });
    if (result.type !== "thread.create") throw new Error("Thread command mismatch.");
    // Not waited for: the new Thread is what the person is waiting to see.
    void this.#rememberQuietly({
      accessMode: input.accessMode,
      selection: {
        environmentId: input.environmentId,
        harnessInstanceId: input.harnessInstanceId,
        modelSelection: input.modelSelection,
      },
    });
    return (
      this.#snapshot.threads.find(({ id }) => id === result.thread.id) ??
      toThreadSummary(result.thread, this.#snapshot.environments, this.#snapshot.harnesses)
    );
  }

  rememberExecution(choice: ExecutionChoice): Promise<ExecutionPreferences> {
    // One at a time, in the order chosen: a remember nobody waits for, such
    // as a new Thread's, must not land after a later choice and take it back.
    const remembered = this.#remembering.then(async () => {
      const result = await this.dispatch({
        ...(choice.accessMode ? { accessMode: choice.accessMode } : {}),
        idempotencyKey: mutationIdempotencyKey("execution-preferences"),
        ...(choice.selection ? { selection: choice.selection } : {}),
        type: "execution.preferences.remember",
      });
      if (result.type !== "execution.preferences.remember") {
        throw new Error("Execution preferences command mismatch.");
      }
      this.#update({ ...this.#snapshot, executionPreferences: result.preferences });
      return result.preferences;
    });
    this.#remembering = remembered.catch(() => undefined);
    return remembered;
  }

  async renameThread(threadId: string, title: string): Promise<ThreadSummary> {
    if (!this.#snapshot.threadRenameAvailable)
      throw new Error("This Host does not support task renaming.");
    const trimmed = ThreadTitleSchema.parse(title);
    const thread = threadInDirectory(threadId, this.#snapshot);
    if (thread) this.#threadState.reconcile(thread, zeroSequence);
    const generation = this.#viewerGeneration;
    const token = Symbol(threadId);
    this.#threadRenames.set(threadId, { title: trimmed, token });
    this.#update(this.#snapshot);
    let renamed: ThreadSummary;
    try {
      const result = await this.dispatch({
        type: "thread.rename",
        threadId,
        title: trimmed,
        idempotencyKey: mutationIdempotencyKey(`thread-rename:${threadId}`),
      });
      if (result.type !== "thread.rename") throw new Error("Thread command mismatch.");
      renamed = toThreadSummary(
        result.thread,
        this.#snapshot.environments,
        this.#snapshot.harnesses,
      );
      if (generation === this.#viewerGeneration)
        renamed = this.#threadState.reconcile(renamed, result.asOfSequence);
    } finally {
      if (
        generation === this.#viewerGeneration &&
        this.#threadRenames.get(threadId)?.token === token
      ) {
        this.#threadRenames.delete(threadId);
        if (!this.#disposed)
          this.#update(
            thread
              ? withThreadNames(this.#snapshot, (current) =>
                  current.id === threadId ? this.#threadState.name(thread) : current,
                )
              : this.#snapshot,
          );
      }
    }
    return this.#snapshot.threads.find((item) => item.id === threadId) ?? renamed;
  }

  async #setThreadIcon(
    command: Extract<HostApiCommand, { type: "thread.icon.set" }>,
  ): Promise<HostApiCommandOutput> {
    const { threadId } = command;
    const thread = threadInDirectory(threadId, this.#snapshot);
    if (thread) this.#threadState.reconcile(thread, zeroSequence);
    const generation = this.#viewerGeneration;
    const token = Symbol(threadId);
    this.#threadIcons.set(threadId, { icon: command.icon ?? defaultTaskSymbol, token });
    this.#update(this.#snapshot);
    try {
      return await this.#dispatchCommand(command);
    } finally {
      if (
        generation === this.#viewerGeneration &&
        this.#threadIcons.get(threadId)?.token === token
      ) {
        this.#threadIcons.delete(threadId);
        if (!this.#disposed) this.#update(this.#snapshot);
      }
    }
  }

  async updateThreadExecution(
    threadId: string,
    selection: Pick<ExecutionSelection, "harnessInstanceId" | "modelSelection">,
    continuation?: { expectedProviderSessionId: string | null },
  ): Promise<ThreadSummary> {
    const thread = this.#snapshot.threads.find((item) => item.id === threadId);
    if (!thread) throw new Error("Thread not found.");
    const result = await this.dispatch({
      harnessInstanceId: selection.harnessInstanceId,
      ...(continuation ? { continuation } : {}),
      idempotencyKey: mutationIdempotencyKey(`thread-execution:${threadId}`),
      modelSelection: selection.modelSelection,
      threadId,
      type: "thread.execution.update",
    });
    if (result.type !== "thread.execution.update") throw new Error("Thread command mismatch.");
    const updated = toThreadSummary(
      result.thread,
      this.#snapshot.environments,
      this.#snapshot.harnesses,
    );
    {
      await this.#rememberQuietly({
        selection: {
          environmentId: thread.environmentId,
          harnessInstanceId: selection.harnessInstanceId,
          modelSelection: selection.modelSelection,
        },
      });
    }
    return this.#snapshot.threads.find(({ id }) => id === threadId) ?? updated;
  }

  async updateThreadAccess(threadId: string, accessMode: ThreadAccessMode): Promise<ThreadSummary> {
    const thread = this.#snapshot.threads.find((item) => item.id === threadId);
    if (!thread) throw new Error("Thread not found.");
    const result = await this.dispatch({
      accessMode,
      idempotencyKey: mutationIdempotencyKey(`thread-access:${threadId}`),
      threadId,
      type: "thread.access.update",
    });
    if (result.type !== "thread.access.update") throw new Error("Thread command mismatch.");
    const updated = toThreadSummary(
      result.thread,
      this.#snapshot.environments,
      this.#snapshot.harnesses,
    );
    await this.#rememberQuietly({ accessMode });
    return this.#snapshot.threads.find(({ id }) => id === threadId) ?? updated;
  }

  /**
   * The Thread mutation the person asked for already succeeded, so a refused
   * or unreachable remember is not theirs to see: the Host's next bootstrap
   * is the authority on what is remembered either way.
   */
  async #rememberQuietly(choice: ExecutionChoice): Promise<void> {
    await this.rememberExecution(choice).catch(() => undefined);
  }

  async stopNode(threadId: string, nodeId: string): Promise<void> {
    const node = this.#reader(threadId)
      ?.getSnapshot()
      .entries.find((entry) => entry.kind === "node" && entry.nodeId === nodeId);
    if (
      node?.kind !== "node" ||
      !node.runId ||
      !node.stopSupported ||
      node.stopping ||
      node.status !== "running"
    )
      throw new Error("This subagent cannot be stopped.");
    await this.dispatch({
      type: "node.stop",
      nodeId: ExecutionNodeIdSchema.parse(nodeId),
      threadId,
      runId: RunIdSchema.parse(node.runId),
      idempotencyKey: mutationIdempotencyKey("node-stop"),
    });
  }

  async stopRun(threadId: string): Promise<void> {
    const thread = this.#snapshot.threads.find((item) => item.id === threadId);
    if (!thread) throw new Error("Thread not found.");
    const detail = this.#reader(threadId)?.getSnapshot();
    const run = threadStopTarget({ runQueue: detail?.synchronized ? detail.runQueue : [], thread });
    if (!run) throw new Error("This Thread has nothing to stop.");
    const result = await this.dispatch({
      idempotencyKey: mutationIdempotencyKey("interrupt"),
      runId: run.id,
      threadId,
      type: "run.interrupt",
    });
    if (result.type !== "run.interrupt") throw new Error("Interrupt command mismatch.");
  }

  async steerThreadInput(threadId: string, messageId: string): Promise<void> {
    const expectedRunId = this.#reader(threadId)?.getSnapshot().inputQueue?.steerRunId ?? null;
    if (expectedRunId === null) throw new Error("This message cannot be steered right now.");
    await this.#mutateThreadInput(
      threadId,
      "input-steer",
      messageId,
      `${messageId}:${expectedRunId}`,
      (idempotencyKey) => ({
        expectedRunId,
        idempotencyKey,
        messageId,
        threadId,
        type: "thread.input.steer",
      }),
    );
  }

  async cancelThreadInput(threadId: string, messageId: string): Promise<void> {
    await this.#mutateThreadInput(
      threadId,
      "input-cancel",
      messageId,
      messageId,
      (idempotencyKey) => ({
        idempotencyKey,
        messageId,
        threadId,
        type: "thread.input.cancel",
      }),
    );
  }

  editWaitingMessage(
    threadId: string,
    messageId: string,
    options?: { readonly takeOver?: boolean },
  ): Promise<WaitingMessageEditor> {
    return openWaitingMessageEditor(
      this.#waitingMessageEditorPort,
      threadId,
      messageId,
      options?.takeOver ?? false,
    );
  }

  async releaseWaitingMessage(threadId: string, messageId: string): Promise<void> {
    await this.dispatch({ messageId, threadId, type: "thread.input.lease.release" });
  }

  ownsEditLease(leaseId: string): boolean {
    return this.#editLeases.has(leaseId);
  }

  async listMessageRevisions(
    threadId: string,
    messageId: string,
    before?: number,
  ): Promise<{ readonly revisions: readonly MessageRevisionView[]; readonly hasMore: boolean }> {
    return unwrapRpcResult(
      await this.rpc["thread.message.revisions.list"]({
        messageId: MessageIdSchema.parse(messageId),
        threadId: ThreadIdSchema.parse(threadId),
        ...(before === undefined ? {} : { before }),
      }),
    );
  }

  async decideTeamAsk(input: TeamAskDecision): Promise<void> {
    await this.dispatch({
      decision: input.decision,
      requestId: TeamAgentRequestIdSchema.parse(input.requestId),
      teamId: DeploymentIdSchema.parse(input.teamId),
      type: "teams.ask.decide",
      ...(input.decision === "approve" ? { expectedRevision: input.expectedRevision } : {}),
    });
  }

  readonly #waitingMessageEditorPort: WaitingMessageEditorPort = {
    dispatch: (command) => this.dispatch(command),
    leases: this.#editLeases,
    readRevision: async (threadId, messageId, expectedRevision, leaseId) => {
      const scope = this.#detailScope(threadId);
      const detail = scope && this.#stream.detail(scope);
      const signal = detail?.controller?.signal;
      if (!signal) throw new Error("This conversation is unavailable.");
      const page = unwrapRpcResult(
        await this.rpc["thread.message.revisions.list"](
          {
            threadId,
            messageId: MessageIdSchema.parse(messageId),
            expectedRevision,
            leaseId,
          },
          { signal },
        ),
      );
      signal.throwIfAborted();
      const queue = await this.#reader(threadId)?.queue();
      signal.throwIfAborted();
      const held = queue?.items.find(({ message }) => message.id === messageId);
      const current = page.revisions[0];
      if (
        !current ||
        current.revision !== expectedRevision ||
        held?.lease?.leaseId !== leaseId ||
        Date.parse(held.lease.expiresAt) <= Date.now() ||
        (held.message.edit?.revision ?? 0) !== expectedRevision
      )
        throw new HostClientRequestError({
          code: "conflict",
          message: "This waiting message changed.",
          status: 409,
        });
      return current.content;
    },
    now: () => Date.now(),
  };

  async resumeThreadInputQueue(threadId: string): Promise<void> {
    // Resume is idempotent on the Host, so a lost answer is simply asked again.
    await this.dispatch({
      idempotencyKey: mutationIdempotencyKey("input-queue-resume"),
      threadId,
      type: "thread.inputQueue.resume",
    });
  }

  /**
   * Steer and cancel each consume one durable message, so the key of an
   * attempt is held until the Host has answered it: a lost answer is retried
   * as the same mutation, and only an answer, success or a refusal that
   * settles the matter, lets the next attempt be a new one. Any failure also
   * rereads the queue, since what it said could be done may no longer hold.
   */
  async #mutateThreadInput(
    threadId: string,
    prefix: "input-cancel" | "input-steer",
    messageId: string,
    identity: string,
    command: (idempotencyKey: string) => HostApiCommandInput,
  ): Promise<void> {
    const key = `${prefix}:${identity}`;
    const held = this.#threadInputMutationKeys.get(key);
    if (held === undefined) {
      // A new attempt at this message retires any earlier one aimed at a Run
      // that has since ended; that key can never be replayed again.
      for (const stale of this.#threadInputMutationKeys.keys()) {
        if (stale.startsWith(`${prefix}:${messageId}`)) this.#threadInputMutationKeys.delete(stale);
      }
    }
    const idempotencyKey = held ?? mutationIdempotencyKey(prefix);
    this.#threadInputMutationKeys.set(key, idempotencyKey);
    try {
      await this.dispatch(command(idempotencyKey));
    } catch (error) {
      if (isSettledInputMutationError(error)) this.#threadInputMutationKeys.delete(key);
      this.#reloadInputQueue(threadId);
      throw error;
    }
    this.#threadInputMutationKeys.delete(key);
  }

  /**
   * Writes a computer's access policy against the revision this editor read.
   *
   * A successful write ends every session that computer was serving, so the
   * machines are read back rather than patched: `activeSessions` is the Host's
   * answer about live sessions and this client has no standing to guess it.
   */
  async bindDeviceSession(input: {
    readonly machineId: string;
    readonly proof: import("@opensteer/protocol").DeviceSessionBindingProof;
  }): Promise<void> {
    const result = await this.dispatch({
      ...input,
      idempotencyKey: globalThis.crypto.randomUUID(),
      type: "machine.session.bind",
    });
    if (result.type !== "machine.session.bind") throw new Error("Device binding command mismatch.");
  }

  async attachIphoneScreen(input: Parameters<HostClient["attachIphoneScreen"]>[0]) {
    const result = await this.dispatch({
      ...input,
      type: "iphone.screen.attach",
      idempotencyKey: input.idempotencyKey ?? mutationIdempotencyKey("iphone-attach"),
    });
    if (result.type !== "iphone.screen.attach") throw new Error("Screen attach command mismatch.");
    await this.refresh();
    return result;
  }

  async detachIphoneScreen(input: Parameters<HostClient["detachIphoneScreen"]>[0]) {
    const result = await this.dispatch({
      ...input,
      deviceId: DeviceIdSchema.parse(input.deviceId),
      type: "iphone.screen.detach",
      idempotencyKey: input.idempotencyKey ?? mutationIdempotencyKey("iphone-detach"),
    });
    if (result.type !== "iphone.screen.detach") throw new Error("Screen detach command mismatch.");
    await this.refresh();
    return result;
  }

  async updateMachineAccess(input: MachineAccessUpdateInput): Promise<MachineAccessUpdateOutcome> {
    const command = deviceAccessCommand(input, mutationIdempotencyKey("machine-access"));
    const result = await this.dispatch(command);
    if (result.type !== "machine.access.update") {
      throw new Error("Access settings command mismatch.");
    }
    if (result.outcome === "conflict") return { outcome: "conflict" };
    await this.refresh();
    return { outcome: "updated", revision: result.revision };
  }

  async stopMachineAccessSession(sessionId: string): Promise<boolean> {
    const result = await this.dispatch({
      idempotencyKey: mutationIdempotencyKey("machine-access-stop"),
      sessionId,
      type: "machine.access.session.stop",
    });
    if (result.type !== "machine.access.session.stop") {
      throw new Error("Stop session command mismatch.");
    }
    await this.refresh();
    return result.ended;
  }

  async loadMachineAccessHistory(input: {
    readonly before?: string;
    readonly limit: number;
    readonly runnerId: string;
  }): Promise<MachineAccessHistoryPage> {
    return unwrapRpcResult(
      await this.rpc["machine.access.history"]({
        ...(input.before === undefined ? {} : { before: input.before }),
        limit: input.limit,
        runnerId: input.runnerId,
      }),
    );
  }

  #reloadInputQueue(threadId: string) {
    if (this.#showsThread(threadId))
      void this.loadThreadInputQueue(threadId).catch(() => undefined);
  }

  async #dispatch(command: HostApiCommandInput): Promise<HostApiCommandOutput> {
    return unwrapRpcResult(await this.rpc["commands.dispatch"](command));
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#closeSocket();
    this.#stream.clear(false);
    this.#bodies.clear();
    for (const release of this.#threadReaders.values()) release();
    this.#threadReaders.clear();
    for (const reader of this.#scopeReaders.values()) reader.dispose();
    this.#scopeReaders.clear();
    this.#clearViewerReads();
    for (const release of this.#lifecycleDisposers) release();
    clearRunPageViews(this);
    clearRunPlacePictures(this);
    this.#clearAttachmentReads();
    this.#computerViews.clear();
    this.#placeActivity.dispose();
    this.#runPlaces.dispose();
    this.#targetedControl.dispose();
    this.#targetedWatch.dispose();
    this.#browserEditing.dispose();
    this.browserHistory.dispose();
    this.references.dispose();
    this.transcriptFiles.dispose();
    this.assetUrls.dispose();
    this.#listeners.clear();
  }

  loadEarlierNeedsYou(): Promise<void> {
    return this.#readAttention(false);
  }

  #readAttention(refresh: boolean): Promise<void> {
    if (this.#attentionRead) return this.#attentionRead.promise;
    const held = this.#snapshot.needsYou;
    const state = this.#stream.shell.getSnapshot();
    if (
      !state.synchronized ||
      this.#visibility === "background" ||
      (!refresh && held && (!held.window.hasMore || !held.window.nextBefore))
    )
      return Promise.resolve();
    const controller = new AbortController();
    const current = () => {
      const latest = this.#stream.shell.getSnapshot();
      return (
        !controller.signal.aborted &&
        latest.synchronized &&
        latest.generation === state.generation &&
        latest.attention === state.attention &&
        latest.snapshot?.counts.needsYouCount === state.snapshot?.counts.needsYouCount &&
        latest.snapshot?.counts.pendingRequestCount === state.snapshot?.counts.pendingRequestCount
      );
    };
    const read = async (before?: string) =>
      unwrapRpcResult(
        await this.rpc["needsYou.get"](
          { ...(before ? { before } : {}), limit: 50 },
          { signal: controller.signal },
        ),
      );
    const promise = (async () => {
      let page = await read(refresh ? undefined : (held?.window.nextBefore ?? undefined));
      if (!current()) return;
      const entries = new Map(
        (refresh ? [] : (held?.entries ?? [])).map((entry) => [needsYouEntryKey(entry), entry]),
      );
      let byteCount = 0;
      for (let pages = 0; ; pages++) {
        byteCount += page.window.byteCount;
        for (const entry of page.entries) entries.set(needsYouEntryKey(entry), entry);
        const cursor = page.window.nextBefore;
        if (
          !refresh ||
          pages >= 2 ||
          entries.size >= this.#attentionTarget ||
          !page.window.hasMore ||
          !cursor
        )
          break;
        page = await read(cursor);
        if (!current()) return;
        if (page.window.nextBefore === cursor)
          throw new Error("The Host returned the same Needs you cursor.");
      }
      const visible = [...entries.values()].slice(-150);
      this.#attentionTarget = visible.length || 1;
      this.#update({
        ...this.#snapshot,
        needsYou: {
          ...page,
          entries: visible,
          window: { ...page.window, byteCount, itemCount: visible.length },
        },
      });
    })()
      .catch((error: unknown) => {
        if (!controller.signal.aborted) throw error;
      })
      .finally(() => {
        if (this.#attentionRead?.controller === controller) this.#attentionRead = undefined;
      });
    this.#attentionRead = { controller, promise };
    return promise;
  }

  async readRequest(threadId: string, requestId: string): Promise<Request | null> {
    const generation = this.#viewerGeneration;
    const { requests, reviewedRevisions } = unwrapRpcResult(
      await this.rpc["thread.requests.list"]({
        requestId: RequestIdSchema.parse(requestId),
        threadId: ThreadIdSchema.parse(threadId),
      }),
    );
    if (generation !== this.#viewerGeneration || this.#disposed) return null;
    const request = requests.find(
      ({ id, originatingThreadId }) => id === requestId && originatingThreadId === threadId,
    );
    if (!request) return null;
    const reviewed = { ...request, reviewedRevision: reviewedRevisions?.[request.id] };
    return reviewed;
  }

  loadDoneTasks(): Promise<void> {
    return this.#readFirstTaskPage("done:*");
  }

  loadEarlierDoneTasks(): Promise<void> {
    return this.#loadEarlier("done:*");
  }

  async setIdleCompactionPolicy(
    policy: import("@opensteer/core").IdleCompactionPolicy,
  ): Promise<void> {
    const result = await this.#dispatch({
      type: "settings.idleCompaction.set",
      policy,
      idempotencyKey: mutationIdempotencyKey("idle-compaction"),
    });
    if (result.type === "settings.idleCompaction.set" && this.#snapshot.personalSettings)
      this.#update({
        ...this.#snapshot,
        personalSettings: {
          ...this.#snapshot.personalSettings,
          idleCompactionPolicy: result.policy,
        },
      });
  }
  async setOwnerName(
    name: PersonName | null,
    expectedVersion: string | null,
  ): Promise<{ readonly applied: boolean }> {
    const result = await this.#dispatch({
      idempotencyKey: mutationIdempotencyKey("owner-name"),
      name,
      expectedVersion,
      type: "viewer.name.update",
    });
    if (result.type !== "viewer.name.update") return { applied: false };
    this.#update({ ...this.#snapshot, ownerProfile: result.profile });
    return { applied: result.applied };
  }
  async setQuietTaskDays(days: QuietTaskDays): Promise<void> {
    const result = await this.#dispatch({
      idempotencyKey: mutationIdempotencyKey("quiet-tasks"),
      quietTaskDays: days,
      type: "viewer.quietTasks.update",
    });
    if (result.type === "viewer.quietTasks.update")
      this.#update({ ...this.#snapshot, quietTaskDays: result.quietTaskDays });
  }

  /**
   * One list's loaded prefix, one refresh at a time. A change told during a read
   * earns exactly one more, so the last read never started before the change;
   * a screen asking during a read joins it. Every caller is answered when the
   * last read lands.
   */
  #readFirstTaskPage(scope: string | null) {
    return this.#readTaskPage(scope, null);
  }

  loadEarlierTasks(): Promise<void> {
    return this.#loadEarlier(null);
  }

  #loadEarlier(scope: string | null): Promise<void> {
    const generation = this.#viewerGeneration;
    const pending = this.#taskPageLoads.get(scope);
    if (pending?.generation === generation) return pending.promise;
    const promise = this.#loadEarlierTasks(scope).finally(() => {
      if (this.#taskPageLoads.get(scope)?.promise === promise) this.#taskPageLoads.delete(scope);
    });
    this.#taskPageLoads.set(scope, { generation, promise });
    return promise;
  }

  async #loadEarlierTasks(scope: string | null): Promise<void> {
    const generation = this.#viewerGeneration;
    const userId = this.#snapshot.user?.id;
    if (!this.#viewerStillCurrent(generation, userId)) return;
    const window = this.#heldTasks(scope)?.window;
    const cursor = window?.hasMore ? window.nextBefore : null;
    if (cursor) await this.#readTaskPage(scope, cursor);
  }

  #heldTasks(scope: string | null): TaskListState | null {
    return scope === null
      ? this.#snapshot.tasks
      : scope === "active"
        ? null
        : (this.#snapshot.doneTasks[mainDoneTasks] ?? null);
  }

  async #readTaskPage(scope: string | null, before: string | null): Promise<void> {
    const cut = this.#stream.shell.getSnapshot();
    const held = this.#heldTasks(scope);
    const viewer = this.#viewerGeneration;
    const page = unwrapRpcResult(
      await this.rpc["tasks.page"]({
        ...(scope ? { done: true } : {}),
        ...(before ? { before } : {}),
        limit: 50,
      }),
    );
    const current = this.#stream.shell.getSnapshot();
    if (
      viewer !== this.#viewerGeneration ||
      cut.generation !== current.generation ||
      current.through === null ||
      BigInt(page.asOfSequence) < BigInt(current.through) ||
      this.#heldTasks(scope) !== held
    )
      return;
    const merged = mergeTasks(before ? held : null, {
      entries: page.tasks.map((entry) => ({
        ...entry,
        thread: this.#threadState.reconcile(
          toThreadSummary(entry.thread, this.#snapshot.environments, this.#snapshot.harnesses),
          page.asOfSequence,
        ),
      })),
      window: page.window,
    });
    const bounded = { ...merged, entries: merged.entries.slice(-256) };
    this.#update(
      scope
        ? { ...this.#snapshot, doneTasks: { [mainDoneTasks]: bounded } }
        : { ...this.#snapshot, tasks: bounded },
    );
  }

  async setTaskDone(threadId: string, done: boolean): Promise<void> {
    if (!ThreadIdSchema.safeParse(threadId).success) {
      throw new HostClientRequestError({
        code: "not_found",
        message: "Task not found",
        status: 404,
      });
    }
    const result = await this.dispatch({
      done,
      idempotencyKey: mutationIdempotencyKey(`done:${threadId}`),
      threadId,
      type: "thread.done.set",
    });
    if (result.type !== "thread.done.set") throw new Error("Done command mismatch.");
    this.#mergeVisits([result.thread]);
    const thread = this.#threadState.reconcile(
      toThreadSummary(result.thread, this.#snapshot.environments, this.#snapshot.harnesses),
      result.asOfSequence,
    );
    this.#update({
      ...this.#snapshot,
      threads: this.#snapshot.threads.map((current) =>
        current.id === thread.id ? thread : current,
      ),
    });
    if (this.#snapshot.doneTasks[mainDoneTasks]) await this.loadDoneTasks();
  }

  #reverifyCapabilities(): void {
    void this.#refreshCapabilities({ revalidate: true }).catch(() => undefined);
  }

  async #refreshCapabilities(options?: { readonly revalidate: boolean }): Promise<void> {
    if (!this.#readCapabilities || this.#disposed) return;
    const generation = this.#viewerGeneration;
    const read = ++this.#capabilityReadGeneration;
    const capabilities = await this.#readCapabilities(options);
    if (
      generation !== this.#viewerGeneration ||
      read !== this.#capabilityReadGeneration ||
      this.#disposed
    )
      return;
    const changed =
      this.#capabilities === null ||
      capabilities.length !== this.#capabilities.length ||
      capabilities.some((capability) => !this.#capabilities?.includes(capability));
    this.#capabilities = [...capabilities];
    this.#update({
      ...this.#snapshot,
      threadRenameAvailable: capabilities.includes("thread-titles-v1"),
      taskMarksAvailable: capabilities.includes("task-marks-v1"),
      integrationAppFinishAvailable: capabilities.includes("integration-app-finish-v1"),
      integrationAppReturnPortAvailable: capabilities.includes("integration-app-return-port-v1"),

      quietTasksAvailable: capabilities.includes("quiet-tasks-v1"),
      harnessUpdateAvailable: capabilities.includes("harness-update-v1"),
      agentImagesAvailable: capabilities.includes("agent-images-v1"),
      tabReopenAvailable: capabilities.includes("tab-reopen-v1"),
      browserProfileManageAvailable: capabilities.includes("browser-profile-manage-v1"),
      searchSuggestionsAvailable: capabilities.includes("browser-search-suggestions-v1"),
      iphoneAppsAvailable: capabilities.includes("iphone-apps-v1"),
      devicesAvailable: capabilities.includes("devices-v1"),
      voiceAvailable: capabilities.includes("voice-run-v1"),
      ownerViewWindowsAvailable: capabilities.includes("ownerViewWindows"),
    });
    if (changed) {
      this.#targetedControl.capabilitiesChanged();
      this.#targetedWatch.capabilitiesChanged();
    }
  }

  #observeLifecycle(lifecycle: ClientLifecycle): void {
    this.#lifecycleDisposers.push(
      lifecycle.onBackground(() => this.#enterBackground()),
      lifecycle.onForeground(() => this.#enterForeground()),
      lifecycle.onNetworkChange((state, path) => this.#networkChanged(state, path)),
    );
  }

  #enterBackground() {
    if (this.#disposed || this.#visibility === "background") return;
    this.#visibility = "background";
    this.#warmRead?.abort();
    this.#finishLoad();
    this.#stream.setBackground(true);
    this.#invalidateAttention();
    this.#clearProbe();
    for (const { controller } of this.#resourceReads.values()) controller.abort();
    this.#resourceReads.clear();
    this.#targetedControl.suspend(true, this.#network !== "offline");
    this.#targetedWatch.suspend(true);
    if (this.#reconnect) clearTimeout(this.#reconnect);
    this.#reconnect = undefined;
    for (const listener of this.#lifecycleListeners) listener("background");
  }

  #enterForeground() {
    if (this.#disposed || this.#visibility === "foreground") return;
    this.#visibility = "foreground";
    this.#targetedControl.suspend(this.#network === "offline");
    this.#targetedWatch.suspend(this.#network === "offline");
    this.#closeSocket();
    this.#stream.setBackground(false);
    void this.load();
    for (const listener of this.#lifecycleListeners) listener("foreground");
  }

  #networkChanged(state: ClientNetworkState, path: ClientNetworkPath) {
    if (this.#disposed) return;
    if (state === this.#network && path === "same") {
      this.#probeSocket();
      return;
    }
    this.#network = state;
    this.#closeSocket();
    this.#targetedControl.suspend(this.#reconnectSuspended(), state !== "offline");
    this.#targetedWatch.suspend(this.#reconnectSuspended());
    this.#targetedControl.reconnect();
    this.#targetedWatch.reconnect();
    this.#update({ ...this.#snapshot, connection: state === "offline" ? "offline" : "connecting" });
    if (this.#started) void this.load();
    for (const listener of this.#lifecycleListeners) listener("network");
  }

  #reconnectSuspended() {
    return this.#visibility === "background" || this.#network === "offline";
  }

  #probeSocket() {
    const socket = this.#socket;
    if (this.#probe || this.#reconnectSuspended() || socket?.readyState !== 1) return;
    const nonce = crypto.randomUUID();
    this.#probe = {
      nonce,
      timer: setTimeout(() => {
        this.#probe = undefined;
        if (this.#socket === socket) this.#socketFailed();
      }, 3_000),
    };
    try {
      socket.send(JSON.stringify({ type: "client.ping", nonce }));
    } catch {
      this.#socketFailed();
    }
  }

  #clearProbe() {
    if (this.#probe) clearTimeout(this.#probe.timer);
    this.#probe = undefined;
  }

  async #open() {
    if (this.#disposed || this.#socket || this.#refused || this.#reconnectSuspended()) {
      this.#finishLoad();
      return;
    }
    const generation = this.#viewerGeneration;
    const socketGeneration = this.#socketGeneration;
    await this.#prepareSocket?.();
    if (socketGeneration !== this.#socketGeneration) return;
    const cache = this.#stream.cache;
    const cacheCandidate = await cache
      ?.hasCheckpoints?.(this.#cacheDeploymentId)
      .catch(() => false);
    if (socketGeneration !== this.#socketGeneration) return;
    if (cacheCandidate && this.#snapshot.session === "checking") {
      const selected = ThreadIdSchema.safeParse(this.#activeThreadId);
      const controller = new AbortController();
      this.#warmRead = controller;
      const result = await this.rpc["personal.shell.get"](
        selected.success ? { selectedThreadId: selected.data } : {},
        { signal: controller.signal },
      )
        .catch((error: unknown) => {
          if (!controller.signal.aborted) throw error;
          return undefined;
        })
        .finally(() => {
          if (this.#warmRead === controller) this.#warmRead = undefined;
        });
      if (!result) return;
      if (socketGeneration !== this.#socketGeneration) return;
      if (result.ok && validNetworkShell(result.data)) await this.#stream.restore(result.data);
      else if (
        !result.ok &&
        ["unsupported-version", "api-version-mismatch", "unknown-method"].includes(
          result.error.reason ?? "",
        )
      ) {
        this.#refused = true;
        this.#finishLoad();
        return;
      }
    }
    if (socketGeneration !== this.#socketGeneration) return;
    if (generation !== this.#viewerGeneration || this.#disposed || this.#reconnectSuspended()) {
      this.#finishLoad();
      return;
    }
    let socket: WebSocketClient;
    try {
      socket = this.#webSocketFactory(this.#webSocketUrl("/v1/realtime"));
    } catch {
      this.#socketFailed();
      return;
    }
    this.#socket = socket;
    this.#attachDeadline = setTimeout(() => {
      if (this.#socket === socket) this.#socketFailed();
    }, 15_000);
    socket.addEventListener("open", () => {
      if (this.#socket !== socket) return;
      try {
        this.#stream.attach((message) => socket.send(JSON.stringify(message)));
      } catch {
        this.#socketFailed();
      }
    });
    socket.addEventListener("message", ({ data }) => {
      if (this.#socket !== socket || typeof data !== "string") return;
      const wireBytes = utf8ByteLength(data);
      if (wireBytes > 128 * 1024) {
        this.#frameRejected("frame", wireBytes);
        this.#socketFailed();
        return;
      }
      let parsed = false;
      try {
        const message: unknown = JSON.parse(data);
        parsed = true;
        if (
          message &&
          typeof message === "object" &&
          "type" in message &&
          message.type === "host.snapshot" &&
          "subscriptionId" in message &&
          message.subscriptionId === "shell" &&
          "snapshot" in message
        ) {
          const shell = PersonalShellSnapshotSchema.safeParse(message.snapshot);
          if (!shell.success || !validNetworkShell(shell.data))
            throw new Error("The Host omitted its authenticated shell identity.");
        }
        if (this.#stream.receive(message, wireBytes)) return;
        if (
          message &&
          typeof message === "object" &&
          "type" in message &&
          typeof message.type === "string" &&
          scopedRealtimeTypes.has(message.type)
        )
          throw new Error("Invalid personal scope frame.");
        const notice = HostToClientMessageSchema.safeParse(message);
        if (notice.success) this.#applyNotice(notice.data);
      } catch {
        this.#frameRejected(parsed ? "schema" : "json", wireBytes);
        this.#socketFailed();
      }
    });
    socket.addEventListener("close", (event) => {
      if (this.#socket !== socket) return;
      if (
        event.code === 4401 ||
        event.code === 4403 ||
        (event.code === 4003 && event.reason === "Session ended")
      )
        this.#expireSession();
      else {
        const affected = affectedPersonalSubscriptions(event.reason ?? "");
        if (affected !== null) {
          if (affected.length === 0 || affected.includes("shell")) {
            this.#viewerGeneration++;
            this.#stream.clear(true);
            this.#resourceRevisions.clear();
            this.#returnHintRevisions.clear();
            this.#clearViewerReads();
            this.#update({ ...emptySnapshot(this.#tabs), connection: "connecting" });
          } else {
            for (const scope of this.#stream.revokeDetails(affected)) {
              if (scope.kind !== "thread") continue;
              const id = scope.threadId;
              this.#threadDeployment.delete(id);
              this.#threadState.forget(id);
              this.#clearDetailReads(id);
            }
          }
          this.#bodies.clear();
          this.#clearAttachmentReads();
        }
        this.#socketFailed();
      }
    });
    socket.addEventListener("error", () => {
      if (this.#socket === socket) this.#socketFailed();
    });
  }

  #frameRejected(category: RealtimeFrameDiagnostic["category"], bytes: number) {
    this.#reportRealtimeFrame?.({
      apiEpoch: scopedPersonalApiVersion,
      bytes,
      category,
      envelopeType: "personal",
      event: "host.realtime.frame-rejected",
      issuePaths: [],
    });
  }

  #socketFailed() {
    this.#closeSocket();
    this.#update({
      ...this.#snapshot,
      connection: "offline",
      connectionInterrupted: this.#visibility === "foreground",
    });
    if (this.#disposed || this.#refused || this.#reconnectSuspended()) return;
    const ceiling = Math.min(
      this.#reconnectMaxDelayMs,
      this.#reconnectBaseDelayMs * 2 ** Math.min(this.#attempt++, 10),
    );
    this.#reconnect = setTimeout(
      () => {
        this.#reconnect = undefined;
        void this.load();
      },
      ceiling * (0.5 + this.#random() / 2),
    );
  }

  #closeSocket() {
    this.#socketGeneration++;
    this.#warmRead?.abort();
    this.#clearProbe();
    const socket = this.#socket;
    this.#socket = null;
    this.#stream.disconnect();
    this.#invalidateAttention();
    if (this.#reconnect) clearTimeout(this.#reconnect);
    this.#reconnect = undefined;
    for (const { controller } of this.#resourceReads.values()) controller.abort();
    this.#resourceReads.clear();
    this.#finishLoad();
    socket?.close(1000, "Client closed");
  }

  #finishLoad() {
    if (this.#attachDeadline) clearTimeout(this.#attachDeadline);
    this.#attachDeadline = undefined;
    this.#resolveLoad?.();
    this.#resolveLoad = undefined;
    this.#load = undefined;
  }

  #applyNotice(message: HostToClientMessage) {
    const deploymentId = this.#snapshot.deploymentId;
    switch (message.type) {
      case "host.pong":
        if (message.nonce === this.#probe?.nonce) this.#clearProbe();
        break;
      case "host.error":
        if (!message.error.retryable && message.error.code === "forbidden") this.#expireSession();
        else {
          this.#refused = !message.error.retryable;
          this.#socketFailed();
        }
        break;
      case "host.show":
        if (this.#visibility === "foreground" && this.#snapshot.session === "authenticated")
          for (const listener of this.#personShowListeners) listener(message);
        break;
      case "host.notification":
        this.#deliverNotification(message.notification, {
          deploymentId,
          userId: this.#snapshot.user?.id ?? null,
        });
        break;
      case "host.triggers-changed":
        if (deploymentId) this.#triggersChanged(deploymentId);
        break;
      case "host.browser-history-changed":
        this.browserHistory.changed(message.profileId);
        break;
      case "host.apps.changed":
        this.#update({ ...this.#snapshot, appsRevision: this.#snapshot.appsRevision + 1 });
        break;
      case "host.place-activity":
      case "host.place-activity-cleared":
        this.#placeActivity.apply(message);
        break;
      case "host.browser-usage-changed":
        this.#browserUsageChanged(message.threadIds);
        break;
      case "host.computer-presence":
        this.#applyComputerPresence(message.sessions);
        break;
      case "host.computer-view.changed":
        this.#update({
          ...this.#snapshot,
          machines: [...this.#ownerViews.accept(this.#snapshot.machines, message.view)],
        });
        break;
      case "host.computer-view.removed":
        this.#update({
          ...this.#snapshot,
          machines: [...this.#ownerViews.remove(this.#snapshot.machines, message)],
        });
        break;
      case "host.personal-remote-access-changed":
        this.#invalidatePersonalRemoteAccess();
        break;
      case "host.connections-changed":
        for (const listener of this.#connectionsListeners) listener();
        break;
      case "host.plugins-changed":
        for (const listener of this.#pluginsChangedListeners) listener(message);
        break;
    }
  }

  #reconnectDelay(attempt: number, maxDelayMs = this.#reconnectMaxDelayMs): number {
    const ceiling = Math.min(maxDelayMs, this.#reconnectBaseDelayMs * 2 ** Math.min(attempt, 16));
    return Math.min(maxDelayMs, Math.round(ceiling * (0.8 + this.#random() * 0.2)));
  }

  #patchBrowserSession(sessionId: string, patch: Partial<BrowserSessionSummary>): void {
    const browserSessions = this.#snapshot.browserSessions.map((session) =>
      session.id === sessionId ? { ...session, ...patch } : session,
    );
    if (
      browserSessions.some((session, index) => session !== this.#snapshot.browserSessions[index])
    ) {
      this.#update({ ...this.#snapshot, browserSessions });
    }
  }

  #expireSession() {
    if (this.#disposed || this.#snapshot.session === "authentication-required") return;
    this.#viewerGeneration++;
    this.#closeSocket();
    this.#stream.clear(true);
    this.#bodies.clear();
    this.#resourceRevisions.clear();
    this.#returnHintRevisions.clear();
    this.#environmentCatalogs.clear();
    this.#environmentAuth.clear();
    this.#clearViewerReads();
    this.#threadDeployment.clear();
    this.#threadState.clear();
    this.#threadRenames.clear();
    this.#threadIcons.clear();
    this.#update({
      ...emptySnapshot(this.#tabs),
      identityConfig: this.#snapshot.identityConfig,
      connection: "connected",
      session: "authentication-required",
    });
    const generation = this.#viewerGeneration;
    void this.rpc["auth.config"]({})
      .then((result) => {
        if (
          result.ok &&
          !this.#disposed &&
          this.#viewerGeneration === generation &&
          this.#snapshot.session === "authentication-required"
        )
          this.#update({ ...this.#snapshot, identityConfig: result.data });
      })
      .catch(() => undefined);
  }

  #viewerStillCurrent(generation: number, userId: string | undefined): boolean {
    return (
      !this.#disposed &&
      generation === this.#viewerGeneration &&
      this.#snapshot.session === "authenticated" &&
      this.#snapshot.user?.id === userId
    );
  }

  /** A listed page tab, still bound to that session on this device. */
  #browserTargetAuthorized(sessionId: string, surfaceId: string): boolean {
    return (
      this.#tabs.get(surfaceId as TabId)?.kind === "page" &&
      this.#pageSessions.get(surfaceId) === sessionId
    );
  }

  #url(path: string): string {
    return new URL(path, this.#baseUrl).toString();
  }

  #webSocketUrl(path: string): string {
    const url = new URL(path, this.#baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set(apiVersionQueryParameter, String(scopedPersonalApiVersion));
    return url.toString();
  }

  /**
   * Hands one notification to listeners, once. The Host decided whom it is
   * for when it sent it; a socket that outlived that viewer or Deployment is
   * no longer theirs, so its copy is dropped rather than shown to someone else.
   */
  #deliverNotification(notification: NotificationView, viewer: SocketViewer): void {
    if (
      this.#disposed ||
      this.#snapshot.session !== "authenticated" ||
      viewer.userId === null ||
      this.#snapshot.user?.id !== viewer.userId ||
      this.#snapshot.deploymentId !== viewer.deploymentId
    )
      return;
    if (this.#deliveredNotifications.has(notification.id)) return;
    this.#deliveredNotifications.add(notification.id);
    if (this.#deliveredNotifications.size > rememberedNotificationIds) {
      const oldest = this.#deliveredNotifications.values().next().value;
      if (oldest !== undefined) this.#deliveredNotifications.delete(oldest);
    }
    for (const listener of this.#notificationListeners) {
      try {
        listener(notification);
      } catch (error) {
        // Raised outside the frame handler, which would otherwise close a
        // socket over a listener's fault; nothing replays a notification.
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }

  #update(snapshot: HostSnapshot): void {
    if (this.#disposed) return;

    if (snapshot.session !== "authenticated") this.#savedViewReadiness = emptySavedViewReadiness();
    if (
      !this.#capabilities?.includes("task-family-v1") &&
      Object.keys(snapshot.threadAutomations).length > 0
    )
      snapshot = { ...snapshot, threadAutomations: {} };
    const tabRows = this.#tabs.rows;
    const tabsChanged = tabRows !== this.#tabRows;
    const inventoryCompleted = this.#tabs.complete && !this.#tabInventoryComplete;
    this.#tabRows = tabRows;
    this.#tabInventoryComplete = this.#tabs.complete;
    if (this.#tabs.complete && (tabsChanged || inventoryCompleted)) {
      // A page binding lasts while its tab is listed; a closed tab's session is no longer this device's.
      for (const tabId of this.#pageSessions.keys())
        if (!tabRows.has(tabId as TabId)) this.#pageSessions.delete(tabId);
      this.#viewers.retain(tabRows as ReadonlyMap<string, Tab>);
      const bound = new Set(this.#pageSessions.values());
      if (snapshot.browserSessions.some((session) => !bound.has(session.id)))
        snapshot = {
          ...snapshot,
          browserSessions: snapshot.browserSessions.filter((session) => bound.has(session.id)),
        };
    }
    const scope = viewerScopeOf(snapshot);
    if (this.#viewer.change(scope)) {
      clearRunPageViews(this);
      clearRunPlacePictures(this);
      this.#runPlaces.clear();
      this.#targetedWatch.clear();
      this.#targetedControl.clear();
      this.#clearAttachmentReads();
      this.#computerViews.clear();
      this.#ownerViews.clear();
      this.#pageSessions.clear();
      this.#viewers.clear();
      this.#tabs.clear();
      snapshot = { ...snapshot, browserSessions: [] };
    }
    // A dropped connection pauses the views being watched; it does not end them.
    this.#computerViews.setConnected(scope !== null && snapshot.connection === "connected");
    this.browserHistory.setScope(scope);
    for (const profile of this.#snapshot.browserProfiles)
      if (!snapshot.browserProfiles.some((value) => value.id === profile.id))
        this.browserHistory.drop(profile.id);
    this.browserPreferences.setScope(scope);
    let reconcileBrowserTargets: (() => void) | undefined;
    if (snapshot.session !== "authenticated") {
      this.#placeActivity.clear();
      this.#runPlaces.clear();
      this.#targetedWatch.clear();
      this.#targetedControl.clear();
    } else {
      // Activity arrives only over realtime, so none of it stands through a reconnect.
      if (snapshot.connection !== "connected") this.#placeActivity.clear();
      if (
        snapshot.browserSessions !== this.#snapshot.browserSessions ||
        snapshot.machines !== this.#snapshot.machines ||
        snapshot.connection !== this.#snapshot.connection ||
        tabsChanged ||
        snapshot.browserPlacements !== this.#snapshot.browserPlacements ||
        snapshot.browserProfiles !== this.#snapshot.browserProfiles
      ) {
        const authorized = (sessionId: string, surfaceId: string) =>
          this.#browserTargetAuthorized(sessionId, surfaceId);
        const allowed = (sessionId: string, surfaceId: string, asleep: boolean) =>
          this.#browserTargetAllowed(sessionId, surfaceId, asleep);
        reconcileBrowserTargets = () => {
          const document = (sessionId: string, tabId: string) =>
            this.#browserTargetAuthorized(sessionId, tabId)
              ? (this.browserViewerSurface(sessionId, tabId)?.documentId ?? null)
              : undefined;
          const sessionForTab = (tabId: string) => this.#pageSessions.get(tabId);
          reconcileBrowserLastPictures(this.browserWatchFrames, document, sessionForTab);
          reconcileBrowserLastPictures(this.browserFrames, document, sessionForTab);
          if (this.#snapshot.connection === "connected")
            this.#placeActivity.reconcile(
              (key) => placeByKey(this.#snapshot, key)?.availability === "ready",
            );
          this.#targetedWatch.reconcile(allowed, authorized);
          this.#targetedControl.reconcile(allowed, authorized);
        };
      }
    }
    if (
      snapshot.threads !== this.#snapshot.threads ||
      snapshot.tasks !== this.#snapshot.tasks ||
      snapshot.activeTasks !== this.#snapshot.activeTasks ||
      snapshot.doneTasks !== this.#snapshot.doneTasks ||
      snapshot.threadVisits !== this.#snapshot.threadVisits ||
      snapshot.deploymentId !== this.#snapshot.deploymentId ||
      this.#threadRenames.size !== 0 ||
      this.#threadIcons.size !== 0
    ) {
      this.#threadDeployment.clear();
      for (const thread of snapshot.threads)
        this.#threadDeployment.set(thread.id, snapshot.deploymentId!);
      for (const { thread } of snapshot.activeTasks)
        this.#threadDeployment.set(thread.id, snapshot.deploymentId!);
      for (const list of [snapshot.tasks, ...Object.values(snapshot.doneTasks)])
        for (const { thread } of list?.entries ?? [])
          this.#threadDeployment.set(thread.id, snapshot.deploymentId!);
      const hiddenAssignments = new Set(this.#deniedAssignments);
      if (hiddenAssignments.size > 0) snapshot = withoutAssignments(snapshot, hiddenAssignments);
      const incoming = [
        ...snapshot.threads,
        ...(snapshot.tasks?.entries ?? []).map((entry) => entry.thread),
        ...snapshot.activeTasks.map((entry) => entry.thread),
        ...Object.values(snapshot.doneTasks).flatMap((list) =>
          list.entries.map((entry) => entry.thread),
        ),
      ];
      const previousVisits =
        snapshot.sessionId === this.#snapshot.sessionId &&
        snapshot.deploymentId === this.#snapshot.deploymentId
          ? this.#snapshot.threadVisits
          : snapshot.threadVisits;
      let visits = previousVisits;
      for (const [id, at] of [
        ...Object.entries(snapshot.threadVisits),
        ...incoming.flatMap((row) =>
          row.lastVisitedAt ? [[row.id, row.lastVisitedAt] as const] : [],
        ),
      ]) {
        if (at <= (visits[id] ?? "")) continue;
        if (visits === previousVisits) visits = { ...visits };
        visits[id] = at;
      }
      const keptVisits = Object.entries(visits).filter(
        ([id]) => this.#threadDeployment.has(id) || this.#showsThread(id),
      );
      snapshot = {
        ...snapshot,
        threadVisits:
          keptVisits.length === Object.keys(visits).length
            ? visits
            : Object.fromEntries(keptVisits),
      };
      this.#threadState.retainLoaded(snapshot.threads);
      snapshot = withThreadNames(snapshot, (thread) => ({
        ...this.#threadState.name(thread),
        lastVisitedAt: snapshot.threadVisits[thread.id] ?? thread.lastVisitedAt,
        ...(this.#threadRenames.has(thread.id)
          ? { title: this.#threadRenames.get(thread.id)!.title }
          : {}),
        ...(this.#threadIcons.has(thread.id)
          ? { icon: this.#threadIcons.get(thread.id)!.icon }
          : {}),
      }));
      let changed = false;
      const threads = snapshot.threads.map((thread) => {
        const unread = isThreadUnread(thread);
        if (thread.unread === unread) return thread;
        changed = true;
        return { ...thread, unread };
      });
      if (changed) snapshot = { ...snapshot, threads };
    }
    this.#snapshot = {
      ...snapshot,
      savedViewReadiness: this.#savedViewReadiness,
      threadRenameAvailable: this.#capabilities?.includes("thread-titles-v1") === true,
      taskMarksAvailable: this.#capabilities?.includes("task-marks-v1") === true,
      integrationAppFinishAvailable:
        this.#capabilities?.includes("integration-app-finish-v1") === true,
      integrationAppReturnPortAvailable:
        this.#capabilities?.includes("integration-app-return-port-v1") === true,

      quietTasksAvailable: this.#capabilities?.includes("quiet-tasks-v1") === true,
      harnessUpdateAvailable: this.#capabilities?.includes("harness-update-v1") === true,
      agentImagesAvailable: this.#capabilities?.includes("agent-images-v1") === true,
      tabReopenAvailable: this.#capabilities?.includes("tab-reopen-v1") === true,
      browserProfileManageAvailable:
        this.#capabilities?.includes("browser-profile-manage-v1") === true,
      searchSuggestionsAvailable:
        this.#capabilities?.includes("browser-search-suggestions-v1") === true,
      iphoneAppsAvailable: this.#capabilities?.includes("iphone-apps-v1") === true,
      devicesAvailable: this.#capabilities?.includes("devices-v1") === true,
      voiceAvailable: this.#capabilities?.includes("voice-run-v1") === true,
      ownerViewWindowsAvailable: this.#capabilities?.includes("ownerViewWindows") === true,
      network: this.#network,
      revision: this.#snapshot.revision + 1,
    };
    this.#runPlaces.flush();
    reconcileBrowserTargets?.();
    this.browserHistory.setConnected(this.#snapshot.connection === "connected");
    for (const listener of this.#listeners) listener();
    this.#checkBrowserUsageRuns();
  }
}

function mergeAssignments(
  prior: Readonly<Record<string, AssignmentSummary>>,
  incoming: readonly AssignmentSummary[],
): Record<string, AssignmentSummary> {
  const merged = { ...prior };
  for (const assignment of incoming) {
    const existing = merged[assignment.id];
    if (!existing || assignment.revision >= existing.revision) merged[assignment.id] = assignment;
  }
  return merged;
}

/** The snapshot without these assignments' summaries, cards or return rows. */
function withoutAssignments(snapshot: HostSnapshot, hidden: ReadonlySet<string>): HostSnapshot {
  return {
    ...snapshot,
    assignments: Object.fromEntries(
      Object.entries(snapshot.assignments).filter(([id]) => !hidden.has(id)),
    ),
  };
}

function emptySnapshot(tabs: TabStore): HostSnapshot {
  return {
    tabs,
    appsRevision: 0,
    personalSettings: null,
    can: null,
    needsYou: null,
    threadRenameAvailable: false,
    taskMarksAvailable: false,

    quietTasksAvailable: false,
    harnessUpdateAvailable: false,
    agentImagesAvailable: false,
    iphoneAppsAvailable: false,
    assignments: {},
    threadAutomations: {},
    waitingRequests: [],
    runQueue: [],

    browserAvailable: false,
    browserPlacements: [],
    browserProfiles: [],
    browserSessions: [],
    browserUses: [],
    connection: "connecting",
    connectionInterrupted: false,
    network: "unknown",
    deploymentShape: null,
    deploymentId: null,
    environments: [],
    executionPreferences: emptyExecutionPreferences,
    harnesses: [],
    savedViewReadiness: emptySavedViewReadiness(),

    voiceThreadId: null,

    threadVisits: {},
    publishedReplyAt: {},
    tasks: null,
    activeTasks: [],

    doneTasks: {},
    quietTaskDays: null,
    identityConfig: null,
    machines: [],
    ownerProfile: null,
    revision: 0,
    session: "checking",
    sessionSurface: null,
    machineRevision: 0,
    triggerRevision: 0,
    threadLookups: {},
    threads: [],
    user: null,
  };
}

/** The wire record carries the driver configuration; the snapshot holds only
 * the fields the UI renders, so the config never reaches component state. */
/**
 * The endpoint an account's config names, and nothing else from it: the rest
 * of a driver's config is the Host's and the Runner's business.
 */
function harnessEndpoint(config: unknown): Pick<HarnessSummary, "endpoint"> {
  if (config === null || typeof config !== "object" || Array.isArray(config)) return {};
  const { baseUrl, runtime } = config as { readonly baseUrl?: unknown; readonly runtime?: unknown };
  if (typeof baseUrl !== "string") return {};
  return { endpoint: typeof runtime === "string" ? { baseUrl, runtime } : { baseUrl } };
}

/** One use of a browser within a conversation, by session, Run and page. */
function browserUseKey(
  sessionId: string,
  use: { readonly runId: string | null; readonly tabId?: string | null | undefined },
): string {
  return JSON.stringify([sessionId, use.runId, use.tabId ?? null]);
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function validNetworkShell(snapshot: import("zod").infer<typeof PersonalShellSnapshotSchema>) {
  return snapshot.session?.user.id === snapshot.viewerId;
}

const unknownModelSelection = ModelSelectionSchema.parse({
  providerId: "unknown",
  modelId: "unknown",
  options: {},
});

function mergeResourceRows<T>(held: readonly T[], page: readonly T[], id: (row: T) => string): T[] {
  const rows = new Map(held.map((row) => [id(row), row]));
  for (const row of page) rows.set(id(row), row);
  return [...rows.values()];
}

function compactThread(
  row: NonNullable<ReturnType<PersonalShellStore["getSnapshot"]>["snapshot"]>["tasks"][number],
): ThreadSummary {
  return {
    id: row.id,
    title: row.title,
    askedAt: row.askedAt,
    createdAt: row.askedAt,
    updatedAt: row.askedAt,
    doneAt: row.doneAt,
    doneReason: null,
    latestRunCompletedAt: row.latestRunCompletedAt,
    lastVisitedAt: null,
    status: row.status,
    purpose: row.purpose,
    pendingRequests: row.pendingRequestCount,
    listed: true,
    unread: false,
    inputQueuePaused: false,
    accessMode: "approval-required",
    continuationIdentity: null,
    providerSessionId: null,
    environmentId: "",
    harnessInstanceId: "",
    modelSelection: unknownModelSelection,
    harnessLabel: "",
    modelLabel: "",
    runnerLabel: "",
    parentThreadId: null,
    teamOrigin: null,
    icon: null,
    color: null,
  };
}

function toThreadSummary(
  thread: Thread,
  environments: readonly EnvironmentSummary[],
  harnesses: readonly HarnessSummary[],
): ThreadSummary {
  const environment = environments.find((item) => item.id === thread.environmentId);
  const harness = harnesses.find((item) => item.id === thread.harnessInstanceId);
  return {
    returnHint: thread.returnHint,
    doneAt: thread.doneAt,
    doneReason: thread.doneReason,
    accessMode: thread.accessMode,
    continuationIdentity: thread.continuationIdentity,
    providerSessionId: thread.providerSessionId,
    lastVisitedAt: thread.lastVisitedAt,
    latestRunCompletedAt: thread.latestRunCompletedAt,
    askedAt: thread.askedAt ?? thread.createdAt,
    createdAt: thread.createdAt,
    environmentId: thread.environmentId,
    harnessInstanceId: thread.harnessInstanceId,
    harnessLabel: harness?.name ?? "Unavailable harness",
    id: thread.id,
    inputQueuePaused: thread.inputQueuePaused,
    listed: thread.listed,
    modelLabel: modelLabel(thread.modelSelection, environments),
    modelSelection: thread.modelSelection,
    parentThreadId: thread.parentThreadId,
    pendingRequests: thread.pendingRequests,
    purpose: thread.purpose,
    runnerLabel: environment?.name ?? "Unavailable work location",
    status: thread.status,
    title: thread.title,
    icon: thread.icon ?? null,
    color: thread.color ?? null,
    unread: false,
    updatedAt: thread.updatedAt,
    teamOrigin: thread.teamOrigin,
  };
}

/** Pages in a freshly read prefix share their continuation; newer Thread data wins duplicates. */
function mergeTasks(held: TaskListState | null, page: TaskListState): TaskListState {
  return { entries: mergeTaskEntries(held?.entries ?? [], page.entries), window: page.window };
}

function modelLabel(
  selection: Thread["modelSelection"],
  environments: readonly EnvironmentSummary[],
): string {
  return (
    catalogModelDisplayName(selection.modelId, environments, selection.providerId) ??
    selection.modelId
  );
}

/** The IANA zone this device's clock is set to; nothing where `Intl` cannot say. */
function deviceTimeZone(): string | undefined {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function upsertThread(threads: ThreadSummary[], thread: ThreadSummary): ThreadSummary[] {
  const index = threads.findIndex(({ id }) => id === thread.id);
  if (index < 0) return [...threads.slice(-35), thread];
  if (threads[index] === thread) return threads;
  return threads.map((value, at) => (at === index ? thread : value));
}

export function unwrapRpcResult<Success>(
  result: RpcResult<
    Success,
    import("@opensteer/protocol").RpcError<
      (typeof import("@opensteer/protocol").hostApi)[keyof typeof import("@opensteer/protocol").hostApi]
    >
  >,
): Success {
  if (result.ok) return result.data;
  throw new HostClientRequestError({
    code: result.error.code,
    message: result.error.message,
    ...(result.error.reason === undefined ? {} : { reason: result.error.reason }),
    status: rpcErrorStatus(result.error.code),
  });
}
export function rpcErrorStatus(code: string): number {
  return code === "bad_request"
    ? 400
    : code === "unauthorized"
      ? 401
      : code === "canonical_surface_required" || code === "forbidden"
        ? 403
        : code === "not_found"
          ? 404
          : code === "conflict"
            ? 409
            : code === "resource_exhausted" || code === "timeout"
              ? 429
              : code === "runner_offline" || code === "folder_unavailable"
                ? 503
                : 500;
}
export function mutationIdempotencyKey(prefix: string): string {
  return `${prefix}:${globalThis.crypto.randomUUID()}`;
}

export { HostClientRequestError as HostHttpError } from "./client.js";

export type { HostToClientMessage };
