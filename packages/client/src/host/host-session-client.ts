import { unsupportedVersionCloseCode } from "@opensteer/protocol";
import type { PluginChange, PluginResourceCategory } from "@opensteer/protocol";
import {
  clientScopeKey,
  createConnectionController,
  type ClientScope,
  type ClientConnectionState,
  type ConnectionAttempt,
  type ConnectionController,
  type ConnectionLease,
  type ConnectionPresentation,
  probeAnsweredByFrames,
} from "../connections/connection-controller.js";
import { classifyClientFailure, ClientOperationError } from "../connections/operation-error.js";
import { HostTransportError } from "../connections/host-transport-error.js";
import { assertMessageLogin, disposeMessageOutbox } from "./message-outbox.js";
import { nameConnectionFromHost } from "./host-connection.js";
import type { TranscriptItem } from "@opensteer/protocol/transcript";
import { MessageIdSchema, utf8ByteLength, type AuthSessionId } from "@opensteer/core";
import type { PersonalStreamCache } from "./personal-stream-cache.js";
import { needsYouEntryKey } from "./needs-you.js";
import { withThreadState } from "./optimistic-command-patches.js";
import { ScopedThreadReader, TranscriptBodies, transcriptBodyKey } from "./scoped-thread-reader.js";
import { nodeTranscriptCard, transcriptCard } from "./transcript-item-view.js";
import { displayedItemIds } from "./thread-transcript-store.js";
import {
  scopedPersonalApiVersion,
  personalDetailFrameMaxBytes,
  affectedPersonalSubscriptions,
  personalShellSettledTasks,
} from "@opensteer/protocol/personal-sync";
import { pluginCategoryResources, type PersonalResourceKind } from "@opensteer/protocol/resources";
import type { PersonalShellStore } from "./personal-shell-store.js";
import { PersonalResourceReads, type ResourceInterest } from "./personal-resource-reads.js";
import { savedStartWaitMs, ScopedPersonalStream } from "./scoped-personal-stream.js";
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
import type { PersonShowMessage, PluginEngineStateView } from "@opensteer/protocol";
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
  ModelSelectionSchema,
  ExecutionNodeIdSchema,
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
  includeDeviceAccessRequests,
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
  ComputerViewRemovedListener,
  MachineAccessHistoryPage,
  MachineAccessUpdateOutcome,
  HostClient as OwnerViewHostClient,
  TaskEntry,
  TaskListState,
  ThreadSummary,
  WaitingMessageEditor,
} from "./client.js";
import {
  HostClientRequestError,
  mainDoneTasks,
  requestReviewRequired,
  resourceBackedFields,
  type RequestView,
} from "./client.js";
import { rawSnapshot, trackSnapshot, type SnapshotReader } from "./host-snapshot-store.js";
import { browserProfileHomeCommand } from "./browser-access.js";
import type { ExecutionChoice, ExecutionSelection } from "./execution-preferences.js";
import { createHttpHostApiClient } from "./host-api-client.js";
import { threadInDirectory } from "./host-snapshot-selectors.js";
import { RunPlaceStore } from "./run-place.js";
import { heldThread } from "./task-list.js";
import {
  type ClientLifecycle,
  type ClientNetworkState,
  type ClientVisibility,
} from "./lifecycle.js";
import { PlaceActivityStore } from "./place-activity.js";
import { placeByKey } from "./places.js";
import { reconcileBrowserLastPictures } from "./browser-last-picture.js";
import { compareTaskOrder, mergeTaskEntries } from "./task-entries.js";
import { FencedReads, type FencedRead } from "./fenced-reads.js";
import { threadStopTarget } from "./thread-activity.js";
import { isThreadUnread } from "./thread-unread.js";
import { BrowserRestartUnavailable } from "./browser-sleep.js";
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
  "host.removed",
  "host.resource",
  "host.live",
  "host.text",
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
  readonly presentation?: ConnectionPresentation;
  readonly connectionController?: ConnectionController;
  readonly clientScope?: () => ClientScope | null;
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
  /** See `HttpHostApiClientOptions.pacedUploads`. */
  readonly pacedUploads?: boolean;
  /** Absent means the platform reports nothing, and the client never suspends. */
  readonly lifecycle?: ClientLifecycle;
  readonly random?: () => number;

  readonly reconnectBaseDelayMs?: number;
  readonly reconnectMaxDelayMs?: number;
  /** Watches delivery when a socket is proxied across the Desktop bridge. */
  readonly realtimeLiveness?: { readonly idleMs: number; readonly deadlineMs: number };
  /** Where a platform keeps a record of realtime frames this client could not read. */
  readonly reportRealtimeFrame?: (record: RealtimeFrameDiagnostic) => void;

  readonly prepareSocket?: () => Promise<unknown>;
  readonly webSocketFactory?: (url: string) => WebSocketClient;
}

// Keep thumbnails across remounts without retaining unbounded file bytes on phones.
const attachmentCacheByteBudget = 32 * 1024 * 1024;

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
  readonly #computerViewRemovedListeners = new Set<ComputerViewRemovedListener>();
  subscribeComputerViewRemoved = (listener: ComputerViewRemovedListener): (() => void) => {
    this.#computerViewRemovedListeners.add(listener);
    return () => this.#computerViewRemovedListeners.delete(listener);
  };
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
  #probe: { nonce: string; finish(): void; abort(): void } | undefined;
  #checkingHandshake = false;
  readonly #realtimeLiveness: HttpHostClientOptions["realtimeLiveness"];
  #lastRealtimeFrameAt = 0;
  #attachDeadline: Timer | undefined;
  readonly #reportRealtimeFrame: HttpHostClientOptions["reportRealtimeFrame"];
  #socket: WebSocketClient | null = null;
  readonly connection: ConnectionController;
  readonly #ownsConnection: boolean;
  readonly #clientScope: (() => ClientScope | null) | undefined;
  #connectionFailed: ((error: unknown) => void) | null = null;
  #connectionAdmit: (() => void) | null = null;
  #admittedSession: { readonly scopeKey: string; readonly sessionId: AuthSessionId } | null = null;
  #socketCloseReason: string | undefined;
  #backgroundShellGeneration: number | undefined;
  #load: Promise<void> | undefined;
  #resolveLoad: (() => void) | undefined;
  readonly #resources: PersonalResourceReads;
  readonly #environmentCatalogs = new Map<string, EnvironmentSummary["harnessCatalogs"]>();
  readonly #scopeReaders = new Map<string, ScopedThreadReader>();
  readonly #bodies = new TranscriptBodies();
  readonly #threadReaders = new Map<string, () => void>();
  readonly #shellEntries = new WeakMap<Parameters<typeof compactThread>[0], TaskEntry>();
  /** Task page reads, fenced by the viewer and the shell cut they extend. */
  readonly #taskReads = new FencedReads({
    epoch: () => `${this.#viewerGeneration}:${this.#shellCut}`,
  });
  /** Counts shell cuts: a repair or a new attach replaces the rows pages were read against. */
  #shellCut = 0;
  /** Open tasks read past the shell's settled window, the cut they extend, and where they go on. */
  #openPages:
    | {
        readonly cut: number;
        readonly entries: readonly TaskEntry[];
        readonly window: { readonly nextBefore: string | null; readonly hasMore: boolean };
      }
    | undefined;
  /** Running and waiting tasks past the shell's active window, and where they go on. */
  #activePages: readonly TaskEntry[] = [];
  #activeCursor: string | null = null;
  /** Done as the Host counted it, read to `#doneDepth`, stamped with what it was read against. */
  #donePages:
    | {
        readonly stamp: string;
        readonly entries: readonly TaskEntry[];
        readonly window: TaskListState["window"];
      }
    | undefined;
  /** Settled open rows the person has asked to see; and Done rows (0 until Done opens). */
  #openDepth: number = personalShellSettledTasks;
  #doneDepth = 0;
  /** Counts pushes that may move Done membership: a Done read from before one is read again. */
  #doneCountTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Done's count, with the Host sequence it was read at. One rule sets it: a count from the Host
   * (a first page or the count-only read) replaces the held one when it was read at the same or
   * a later sequence. Nothing else can set it, so no arrival order can put an older count back.
   */
  #doneCount: { readonly count: number; readonly asOf: bigint } | undefined;
  /** The latest sequence at which a pushed change may have moved Done's membership. */
  #doneChangedAt = -1n;
  /** The held open and active lists, as last built, and what they were built from. */
  #openCache:
    | {
        readonly tasks: ReadonlyMap<string, unknown>;
        readonly openPages: unknown;
        readonly activePages: readonly TaskEntry[];
        readonly byId: Map<string, TaskEntry>;
        readonly open: readonly TaskEntry[];
        readonly active: readonly TaskEntry[];
      }
    | undefined;
  /** Counts the times a person opened Done; each reads it again from its first page. */
  #doneOpens = 0;
  /** Tasks the shell removed in this cut: a page read before cannot bring one back. */
  readonly #removedTasks = new Set<string>();
  #publishedShell: ReturnType<ScopedPersonalStream["shell"]["getSnapshot"]> | undefined;
  #syncedAttachment: number | undefined;
  readonly #fetch: Fetch;
  /** Each subscription is a reader: what its listener reads stays watched while it is subscribed. */
  readonly #listeners = new Map<() => void, ResourceInterest>();
  /** A task's assignment reads, fenced by the viewer; and the tasks whose list is read. */
  readonly #assignmentReads = new FencedReads({ epoch: () => String(this.#viewerGeneration) });
  readonly #assignmentsRead = new Set<string>();
  /** Each task view's one-shot measurement of the row in view, for its reader. */
  readonly #positionMeasures = new Map<string, () => string | undefined | null>();
  /** When each assignment was last pushed, by a counter a read notes as it begins. */
  readonly #assignmentPushes = new Map<string, number>();
  /** Every task whose assignments were asked for under this viewer. */
  readonly #assignmentKeys = new Set<string>();
  #assignmentPushCount = 0;
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
    dispatch: async (command, signal) => {
      const viewer = this.#viewer.generation;
      const result = unwrapRpcResult(
        await this.rpc["commands.dispatch"](command, signal ? { signal } : undefined),
      );
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
  #sessionGeneration = 0;
  #savedViewReadiness = emptySavedViewReadiness();
  readonly #notificationListeners = new Set<(notification: NotificationView) => void>();
  readonly #pluginEngineListeners = new Set<(engine: PluginEngineStateView) => void>();
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

  #disposed = false;
  #snapshot: HostSnapshot = emptySnapshot(this.#tabs);
  #remembering: Promise<unknown> = Promise.resolve();

  readonly #viewerPlatform: "mac" | "pc" | null;
  readonly #origin: Omit<MessageOrigin, "timeZone"> | undefined;
  constructor(options: HttpHostClientOptions) {
    this.#origin = options.origin;
    this.#prepareSocket = options.prepareSocket;
    this.#realtimeLiveness = options.realtimeLiveness;
    this.#reportRealtimeFrame = options.reportRealtimeFrame;
    this.#resources = new PersonalResourceReads({
      read: (kind, cursor, signal) =>
        this.rpc["resources.detail.get"]({ kind, ...(cursor ? { cursor } : {}) }, { signal }),
      apply: (pages) => this.#applyResource(pages),
      // Signed out, nothing can be read; signing in attaches, which reads what is watched.
      canRead: () =>
        this.#visibility !== "background" && this.#snapshot.session !== "authentication-required",
      watchChanged: () => this.#stream.watchResources(),
      // Rows stay on screen; the inventory is only no longer known to be complete.
      behind: (kind) => kind === "tab" && this.#tabs.markInventoryStale(),
      unreadable: (kind, unreadable) => {
        const held = this.#snapshot.unreadableResources ?? [];
        if (held.includes(kind) === unreadable) return;
        this.#update({
          ...this.#snapshot,
          unreadableResources: unreadable ? [...held, kind] : held.filter((each) => each !== kind),
        });
      },
      loaded: (kind) => {
        if (this.#snapshot.loadedResources.includes(kind)) return;
        this.#update({
          ...this.#snapshot,
          loadedResources: [...this.#snapshot.loadedResources, kind],
        });
      },
    });
    this.#stream = new ScopedPersonalStream(
      options.streamCache,
      this.#resources,
      options.cacheDeploymentId,
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
    const rpcOrigins = new WeakMap<
      object,
      { readonly sessionGeneration: number; readonly sessionId: AuthSessionId | undefined }
    >();
    const isCurrentRpc = (source?: object): boolean => {
      const origin = source ? rpcOrigins.get(source) : undefined;
      return (
        origin === undefined ||
        (origin.sessionGeneration === this.#sessionGeneration &&
          origin.sessionId === this.#snapshot.sessionId)
      );
    };
    this.rpc = createHttpHostApiClient({
      baseUrl: this.#baseUrl,
      fetch: async (input, init) => {
        const origin = {
          sessionGeneration: this.#sessionGeneration,
          sessionId: this.#snapshot.sessionId,
        };
        try {
          const response = await this.#fetch(input, init);
          rpcOrigins.set(response, origin);
          return response;
        } catch (error) {
          if (error && typeof error === "object") rpcOrigins.set(error, origin);
          throw error;
        }
      },
      personalVersion: scopedPersonalApiVersion,
      ...(options.pacedUploads ? { pacedUploads: true } : {}),
      isResponseCurrent: (source) => isCurrentRpc(source),
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
    this.#ownsConnection = !options.connectionController;
    this.#clientScope = options.clientScope;
    this.connection =
      options.connectionController ??
      createConnectionController({
        driver: { connect: (attempt) => this.openConnection(attempt) },
        ...(options.lifecycle ? { lifecycle: options.lifecycle } : {}),
        ...(options.presentation ? { presentation: options.presentation } : {}),
        ...(options.realtimeLiveness ? { liveness: options.realtimeLiveness } : {}),
        idleProbes: options.realtimeLiveness !== undefined,
        random: this.#random,
        backoff: { baseMs: this.#reconnectBaseDelayMs, maximumMs: this.#reconnectMaxDelayMs },
      });
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
    let observed = this.connection.getSnapshot();
    this.#lifecycleDisposers.push(
      this.connection.subscribe(() => {
        const state = this.connection.getSnapshot();
        const old = observed;
        observed = state;
        this.#connectionChanged(state, old);
      }),
    );
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

  readonly #views = new WeakMap<HostSnapshot, HostSnapshot>();
  /** The subscription whose listener is running: what it reads, it holds while subscribed. */
  #reading: ResourceInterest | undefined;
  /**
   * Reading a resource-backed field watches its kinds (`resourceBackedFields`): for the
   * subscription whose listener reads it, or else for a short lease renewed by every such read.
   * Mounted screens read through a selection's own reader (`snapshotReader`).
   */
  readonly getSnapshot = (): HostSnapshot =>
    trackSnapshot(this.#snapshot, this.#views, (field) => {
      const kinds = resourceKindsOf(field);
      if (!kinds) return;
      const reading = this.#reading;
      for (const kind of kinds) {
        if (reading) reading.hold(kind);
        else this.#resources.lease(kind);
      }
    });

  /** A reader of its own: kinds read through its view stay watched while it is open. */
  readonly snapshotReader = (): SnapshotReader => {
    const interest = this.#resources.interest();
    const views = new WeakMap<HostSnapshot, HostSnapshot>();
    return {
      view: (snapshot) =>
        trackSnapshot(rawSnapshot(snapshot), views, (field) => {
          for (const kind of resourceKindsOf(field) ?? []) interest.hold(kind);
        }),
      open: interest.open,
      close: interest.close,
    };
  };

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
    const interest = this.#listeners.get(listener) ?? this.#resources.interest();
    if (!this.#listeners.has(listener)) {
      interest.open();
      this.#listeners.set(listener, interest);
    }
    return () => {
      if (this.#listeners.get(listener) !== interest) return;
      this.#listeners.delete(listener);
      interest.close();
    };
  };

  /** Writes saved personal state now, for a page about to be hidden or unloaded. */
  flushSavedState() {
    this.#stream.flushCheckpoints();
  }

  /**
   * Sent only to a Home that reports this pooled browser; any other is refused here, and a
   * Home's own refusal reads as the same fixed refusal. Nothing changed in either case.
   */
  async restartPooledBrowser(computerId: string): Promise<void> {
    if (!this.#snapshot.browserPools?.some((pool) => pool.runnerId === computerId))
      throw new BrowserRestartUnavailable();
    try {
      await this.dispatch({
        type: "browser.pool.restart",
        runnerId: computerId,
        idempotencyKey: globalThis.crypto.randomUUID(),
      });
    } catch (error) {
      const { code } = classifyClientFailure(error);
      if (code === "not_found" || code === "forbidden") throw new BrowserRestartUnavailable();
      throw error;
    }
  }

  /**
   * The person was shown a pooled browser's note: the Home is told, so it leaves the report for
   * every client. Sent only for a note this Home's report carries; nothing otherwise.
   */
  async browserNoticeSeen(computerId: string, tabId: string, noticeId: string): Promise<void> {
    const carried = this.#snapshot.browserPools?.some(
      (pool) =>
        pool.runnerId === computerId &&
        pool.pages?.some((page) => page.surfaceId === tabId && page.noticeId === noticeId),
    );
    if (!carried) return;
    await this.dispatch({
      type: "browser.pool.notice.seen",
      surfaceId: tabId,
      noticeId,
      idempotencyKey: globalThis.crypto.randomUUID(),
    });
  }

  /**
   * W15: removes an unconfirmed-closing replaced-browser session from the person's list without
   * changing its closing state on the Home.
   */
  async dismissBrowserSession(sessionId: string): Promise<void> {
    await this.dispatch({
      type: "browser.session.dismiss",
      sessionId,
      idempotencyKey: globalThis.crypto.randomUUID(),
    });
    const browserSessions = this.#snapshot.browserSessions.filter(
      (session) => session.id !== sessionId,
    );
    const browserPools = this.#snapshot.browserPools?.map((pool) => {
      if (!pool.unconfirmedClosings?.some((entry) => entry.sessionId === sessionId)) return pool;
      const remaining = pool.unconfirmedClosings.filter((entry) => entry.sessionId !== sessionId);
      const { unconfirmedClosings: _dropped, ...rest } = pool;
      return remaining.length ? { ...rest, unconfirmedClosings: remaining } : rest;
    });
    this.#update({
      ...this.#snapshot,
      browserSessions,
      ...(browserPools ? { browserPools } : {}),
    });
  }

  async dispatch(
    command: ClientCommandInput,
    options?: { readonly preserveOrigin?: boolean; readonly expectedLogin?: ClientScope },
  ): Promise<HostApiCommandOutput> {
    // Only a command that creates a browser profile needs the Host's homes, to keep its chosen
    // home; it waits a bounded time for them. Every other command goes straight out.
    if (createsBrowserProfile(command))
      await this.#resources.current("browser-home", commandResourceBoundMs);
    const parsedCommand = clientCommandSchema.parse(
      options?.preserveOrigin
        ? browserProfileHomeCommand(command, this.#snapshot.browserProfileHomes)
        : this.#withOrigin(browserProfileHomeCommand(command, this.#snapshot.browserProfileHomes)),
    );
    if (
      (parsedCommand.type === "request.respond" ||
        parsedCommand.type === "browser.sign-in.respond" ||
        parsedCommand.type === "browser.password-sign-in.respond") &&
      parsedCommand.expectedRevision === undefined
    )
      throw requestReviewRequired();
    const needsDevices =
      parsedCommand.type === "machine.session.bind" ||
      (parsedCommand.type === "machine.access.update" &&
        (parsedCommand.policy.browser !== undefined || parsedCommand.policy.apps !== undefined)) ||
      ((parsedCommand.type === "runner.enrollment.createLocal" ||
        parsedCommand.type === "runner.enrollment.createPhone") &&
        parsedCommand.access !== undefined);
    if (needsDevices && !this.#capabilities?.includes("devices-v1"))
      throw new Error("Update this Opensteer to use device setup and access switches.");
    const login = options?.expectedLogin;
    const currentScope = this.connection.getSnapshot().scope;
    const admitted = this.#admittedSession;
    const expectedSessionId = login
      ? admitted &&
        admitted.sessionId === this.#snapshot.sessionId &&
        admitted.scopeKey === clientScopeKey(currentScope)
        ? admitted.sessionId
        : undefined
      : parsedCommand.type === "thread.create" || parsedCommand.type === "thread.sendMessage"
        ? this.#snapshot.sessionId
        : undefined;
    if (login) assertMessageLogin(login, expectedSessionId ? currentScope : null);
    try {
      if (parsedCommand.type === "thread.icon.set") {
        if (!this.#snapshot.taskMarksAvailable)
          throw new Error("This Host does not support task marks.");
        return await this.#setThreadIcon(parsedCommand, expectedSessionId);
      }
      return await this.#dispatchCommand(parsedCommand, expectedSessionId);
    } catch (error) {
      if (
        expectedSessionId !== undefined &&
        classifyClientFailure(error).reason === "session-changed" &&
        this.#snapshot.sessionId === expectedSessionId
      ) {
        this.#expireSession();
        if (this.#ownsConnection) void this.reauthenticate().catch(() => undefined);
      }
      throw error;
    }
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

  #dispatchCommand(command: HostApiCommand, expectedSessionId?: AuthSessionId) {
    if (command.type === "request.respond")
      return this.#answerRequest(command.requestId, () =>
        this.#dispatchCommandNow(command, expectedSessionId),
      );
    return this.#dispatchCommandNow(command, expectedSessionId);
  }

  async #dispatchCommandNow(
    command: HostApiCommand,
    expectedSessionId?: AuthSessionId,
  ): Promise<HostApiCommandOutput> {
    const viewer = this.#viewerGeneration;
    const result = await this.#dispatch(command, expectedSessionId);
    if (viewer !== this.#viewerGeneration || this.#disposed) return result;
    if ("thread" in result && "asOfSequence" in result) {
      const thread = this.#threadState.reconcile(
        toThreadSummary(result.thread, this.#snapshot.environments, this.#snapshot.harnesses),
        result.asOfSequence,
      );
      this.#update({ ...this.#snapshot, threads: upsertThread(this.#snapshot.threads, thread) });
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
  async viewPluginPage(pluginId: string, theme: "light" | "dark", signal?: AbortSignal) {
    const view = unwrapRpcResult(
      await this.rpc["plugins.page.view"]({ pluginId, theme }, signal ? { signal } : undefined),
    );
    return { title: pluginId, url: view.entryUrl ?? this.#url(view.path) };
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

  revealedTranscriptMove(threadId: string) {
    this.#reader(threadId)?.revealed();
  }

  setTranscriptPosition(threadId: string, measure: (() => string | undefined | null) | null) {
    // Kept for the task's reader, which may be made after the view mounts.
    if (measure) this.#positionMeasures.set(threadId, measure);
    else this.#positionMeasures.delete(threadId);
    this.#reader(threadId)?.setMeasure(measure ?? undefined);
  }

  async loadMoreOverlays(threadId: string, kind: "requests" | "tools" | "nodes") {
    await this.#reader(threadId)?.loadMoreOverlays(kind);
  }

  async loadEarlierTranscript(threadId: string): Promise<void> {
    await this.#reader(threadId)?.history("earlier");
  }

  async loadNewerTranscript(threadId: string): Promise<void> {
    await this.#reader(threadId)?.history("newer");
  }

  loadTranscriptAround(threadId: string, messageId: string): Promise<boolean> {
    return this.#reader(threadId)?.history("around", messageId) ?? Promise.resolve(true);
  }

  loadLatestTranscript(threadId: string): Promise<boolean> {
    return this.#reader(threadId)?.history("latest") ?? Promise.resolve(true);
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
    const reader = new ScopedThreadReader(detail, this.rpc, this.#bodies);
    reader.setMeasure(this.#positionMeasures.get(threadId));
    this.#scopeReaders.set(threadId, reader);
    let placeItems: ReturnType<typeof detail.transcript.getSnapshot>["items"] | undefined;
    let placeQueue: NonNullable<
      ReturnType<typeof detail.transcript.getSnapshot>["snapshot"]
    >["queue"];
    let placedRuns = new Set<RunId>();
    let previousThread:
      | NonNullable<ReturnType<typeof detail.transcript.getSnapshot>["snapshot"]>["thread"]
      | undefined;
    let detailGeneration = 0;
    let subscribedGeneration = 0;
    let readsDue = false;
    let subscribedRepairs = 0;
    let reread = false;
    let previousAssignments:
      ReturnType<typeof detail.transcript.getSnapshot>["assignments"] | undefined;
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
      if (state.assignments !== previousAssignments) {
        const changed = [...state.assignments].filter(
          ([id, value]) => previousAssignments?.get(id) !== value,
        );
        previousAssignments = state.assignments;
        if (changed.length) {
          // Each pushed assignment is stamped, so a read begun before it never prunes it.
          for (const [id] of changed) this.#assignmentPushes.set(id, ++this.#assignmentPushCount);
          const assignments = mergeAssignments(
            this.#snapshot.assignments,
            changed.flatMap(([, value]) => value ?? []),
          );
          for (const [id, value] of changed) if (value === null) delete assignments[id];
          this.#update({ ...this.#snapshot, assignments });
        }
      }
      const row = state.snapshot?.thread;
      if (row && row !== previousThread) {
        previousThread = row;
        const detailSummary = row.thread
          ? toThreadSummary(row.thread, this.#snapshot.environments, this.#snapshot.harnesses)
          : compactThread(row);
        const thread = this.#threadState.reconcile(
          row.retry === undefined ? detailSummary : { ...detailSummary, retry: row.retry },
          SequenceSchema.parse(row.revision),
          undefined,
          row.thread ? undefined : row,
        );
        const threads = upsertThread(this.#snapshot.threads, thread);
        if (threads !== this.#snapshot.threads) this.#update({ ...this.#snapshot, threads });
      }
      // Assignments and automations are read as the subscription opens, beside its snapshot.
      if (detail.slot && subscribedGeneration !== state.generation) {
        reread = subscribedGeneration !== 0;
        subscribedGeneration = state.generation;
        subscribedRepairs = state.repairs;
        readsDue = true;
        // A new subscription (a reconnect, a resubscribe) may have skipped the change that ended
        // an assignment: the task's assignments are read again, as after a repair.
        if (reread) {
          this.#assignmentsRead.delete(threadId);
          this.#assignmentReads.changed(`assignments:${threadId}`);
        }
      } else if (state.repairs !== subscribedRepairs) {
        // A repair replaced the scope: its assignments are read again, as on a new subscription.
        subscribedRepairs = state.repairs;
        this.#assignmentsRead.delete(threadId);
        this.#assignmentReads.changed(`assignments:${threadId}`);
        reread = true;
        readsDue = true;
      }
      if (readsDue && this.#snapshot.session === "authenticated" && this.#showsThread(threadId)) {
        readsDue = false;
        this.#ensureAssignments(threadId);
        this.#ensureAutomations(threadId, reread);
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
        const reattached = detailGeneration !== 0;
        detailGeneration = state.generation;
        // Browser usage notices only reach synchronized details.
        this.#ensureBrowserUsage(threadId, reattached ? "full" : "missing");
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
    this.#assignmentReads.stop(`assignments:${threadId}`);
    this.#assignmentsRead.delete(threadId);
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
    // Every task's read stops, those still in flight as well as those that installed.
    for (const threadId of this.#assignmentKeys)
      this.#assignmentReads.stop(`assignments:${threadId}`);
    this.#assignmentKeys.clear();
    this.#assignmentsRead.clear();
    this.#assignmentPushes.clear();
    this.#automationReads.clear();
    this.#readAutomations.clear();
    this.#browserUsageRead.clear();
    this.#browserUsageReads.clear();
    this.#browserUsageRunSources.clear();
    this.#browserUses.clear();
    this.#deniedAssignments.clear();
    for (const key of ["open", "active", "done", "done-count"]) this.#taskReads.stop(key);
    if (this.#doneCountTimer) clearTimeout(this.#doneCountTimer);
    this.#doneCountTimer = undefined;
    this.#openPages = undefined;
    this.#activePages = [];
    this.#activeCursor = null;
    this.#donePages = undefined;
    this.#doneCount = undefined;
    this.#doneChangedAt = -1n;
    this.#openDepth = personalShellSettledTasks;
    this.#doneDepth = 0;
    this.#removedTasks.clear();
  }

  /**
   * Another viewer, session or history. Everything held for the one before goes in this one step,
   * together with what says it was read (the resource reader's installed revisions and loaded
   * flags, the tab store's confirmed layout and command overlay, the waiting Requests' stamp,
   * attention), so nothing cleared can look already read. A new history of the same viewer (a
   * restored or re-created Host) is cleared exactly like another viewer: its state is not the
   * old one's. Only the viewer's durable drafts and outbox, which live outside this client's
   * view state, survive it. This is the only place held data is cleared for a viewer.
   */
  #forgetViewer(keep: Partial<HostSnapshot>, sameSession = false) {
    this.#viewerGeneration++;
    if (!sameSession) {
      this.#sessionGeneration++;
      this.#admittedSession = null;
    }
    clearRunPageViews(this);
    clearRunPlacePictures(this);
    this.#runPlaces.clear();
    this.#targetedWatch.clear();
    this.#targetedControl.clear();
    this.#computerViews.clear();
    this.#ownerViews.clear();
    this.#pageSessions.clear();
    this.#viewers.clear();
    this.#tabs.clear();
    this.#threadState.clear();
    this.#threadRenames.clear();
    this.#threadIcons.clear();
    this.#environmentCatalogs.clear();
    this.#bodies.clear();
    this.#clearAttachmentReads();
    this.#threadDeployment.clear();
    this.#clearViewerReads();
    this.#invalidateAttention();
    this.#waitingRequestReads.stop("waiting-requests");
    this.#waitingRequestWanted = "";
    this.#waitingRequestInstalled = "";
    this.#answeredRequests.clear();
    this.#resources.reset();
    this.#update({ ...emptySnapshot(this.#tabs), ...keep });
  }

  watchNode(threadId: string, nodeId: string): NodeDetailSubscription {
    const scope = this.#detailScope(threadId, nodeId);
    if (scope?.kind !== "node") throw new Error("Invalid subagent scope.");
    const detail = this.#stream.detail(scope);
    const reader = new ScopedThreadReader(detail, this.rpc, this.#bodies);
    const release = this.#stream.observe(scope);
    let previous: ReturnType<typeof detail.transcript.getSnapshot> | undefined;
    const cards = new WeakMap<TranscriptItem, ReturnType<typeof nodeTranscriptCard>>();
    const liveCards = new WeakMap<TranscriptItem, ReturnType<typeof nodeTranscriptCard>>();
    const listeners = new Set<() => void>();
    const notify = () => {
      for (const listener of listeners) listener();
    };
    // Progress is not merged here: its leaf reads the item text store (`useLiveAgentCard`).
    const unsubscribe = detail.transcript.subscribe(notify);
    let released = false;
    let read:
      | {
          generation: number;
          mode: "earlier" | "latest";
          status: "loading" | "missing" | "error";
          error: string | null;
        }
      | undefined;
    let shownRead: typeof read;
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
    const closed = { ...view, status: "closed" as const };
    const readHistory = async (mode: "earlier" | "latest") => {
      const { generation, synchronized } = detail.transcript.getSnapshot();
      if (
        released ||
        !synchronized ||
        (read?.generation === generation && read.status === "loading")
      )
        return;
      const pending = { generation, mode, status: "loading" as const, error: null };
      read = pending;
      notify();
      try {
        await reader.history(mode);
        if (read === pending) read = undefined;
      } catch (error) {
        if (read === pending && generation === detail.transcript.getSnapshot().generation) {
          const unavailable =
            error instanceof HostClientRequestError &&
            (error.status === 403 || error.status === 404);
          read = {
            generation,
            mode,
            status: unavailable ? "missing" : "error",
            error: unavailable ? null : "Could not load this subagent’s work.",
          };
        }
      } finally {
        if (!released) notify();
      }
    };
    return {
      getSnapshot: () => {
        if (released) return closed;
        const state = detail.transcript.getSnapshot();
        const page = read?.generation === state.generation ? read : undefined;
        if (previous === state && shownRead === page) return view;
        shownRead = page;
        const status =
          state.removed || page?.status === "missing"
            ? "missing"
            : page?.status === "error"
              ? "error"
              : state.synchronized
                ? "ready"
                : "loading";
        const structureChanged =
          previous?.items !== state.items ||
          previous.liveItems !== state.liveItems ||
          previous.newest !== state.newest ||
          (view.status === "missing") !== (status === "missing");
        const subject = state.snapshot?.nodeSubject;
        const node =
          status === "missing"
            ? null
            : subject === previous?.snapshot?.nodeSubject && view.status !== "missing"
              ? view.node
              : subject
                ? transcriptCard(subject)!
                : null;
        const hasMore = status !== "missing" && state.snapshot?.nextBefore != null;
        const loadingOlder = page?.status === "loading" && page.mode === "earlier";
        const error = page?.error ?? null;
        previous = state;
        if (
          !structureChanged &&
          node === view.node &&
          status === view.status &&
          hasMore === view.hasMore &&
          loadingOlder === view.loadingOlder &&
          error === view.error &&
          state.generation === view.generation
        )
          return view;
        const entries =
          status === "missing"
            ? closed.entries
            : !structureChanged
              ? view.entries
              : displayedItemIds(state).flatMap((id) => {
                  const durable = state.items.get(id);
                  const item = durable ?? state.liveItems.get(id);
                  if (!item) return [];
                  const projected = durable ? cards : liveCards;
                  if (!projected.has(item)) projected.set(item, nodeTranscriptCard(item, !durable));
                  const card = projected.get(item);
                  return card ?? [];
                });
        view = {
          ...view,
          entries,
          status,
          hasMore,
          loadingOlder,
          error,
          generation: state.generation,
          node: node?.kind === "node" ? node : null,
        };
        return view;
      },
      subscribe: (listener) => {
        if (released) return () => {};
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      loadOlder: () => readHistory("earlier"),
      retry: () => {
        void readHistory(read?.mode ?? "latest");
      },
      release: () => {
        if (released) return;
        released = true;
        unsubscribe();
        reader.dispose();
        release();
        notify();
        listeners.clear();
      },
    };
  }

  readonly watchPersonalResource = (kind: PersonalResourceKind, listener: () => void) =>
    this.#resources.watch(kind, listener);

  #shellEntry(row: Parameters<typeof compactThread>[0]): TaskEntry {
    const cached = this.#shellEntries.get(row);
    if (cached) return cached;
    const thread = this.#reconcilePageThread(
      compactThread(row),
      SequenceSchema.parse(row.revision),
      row,
    );
    const entry = { thread, lastReply: row.lastReplyPreview, failure: row.failurePreview };
    this.#shellEntries.set(row, entry);
    return entry;
  }

  #publishShell() {
    const state = this.#stream.shell.getSnapshot();
    const old = this.#publishedShell;
    this.#publishedShell = state;
    const shellAuthority = state.snapshot;
    let forgot = false;
    const sameSession =
      shellAuthority?.session !== undefined &&
      this.#snapshot.user !== null &&
      this.#snapshot.user.id === shellAuthority.viewerId &&
      this.#snapshot.deploymentId === shellAuthority.deploymentId &&
      this.#snapshot.sessionId === shellAuthority.session.sessionId;
    if (
      (old !== undefined && old.history !== state.history) ||
      (shellAuthority &&
        this.#snapshot.user &&
        (!sameSession || old?.snapshot?.epoch !== shellAuthority.epoch))
    ) {
      const { connection, connectionInterrupted, network } = this.#snapshot;
      this.#forgetViewer({ connection, connectionInterrupted, network }, sameSession);
      forgot = true;
    }
    const shell = state.snapshot;
    if (!shell || this.#disposed) return;
    // Only the socket moves the connection; a scope repair on an open socket leaves it alone.
    const attachment = this.#stream.ready ? this.#stream.attachment : undefined;
    const attached = attachment !== undefined && this.#syncedAttachment !== attachment;
    const reattached = attached && this.#syncedAttachment !== undefined;
    if (attached) this.#syncedAttachment = attachment;
    const connection = attached ? "connected" : this.#snapshot.connection;
    const session = shell.session;
    // A new shell cut replaces the lists; between cuts every row is applied where it is held.
    const replaced = old?.snapshot?.recentTaskIds !== shell.recentTaskIds;
    if (replaced) {
      // Pages were read against the old rows: they are read again, to the depth the person had
      // loaded, from the new cut's cursors. Until then the old pages stay on screen.
      this.#shellCut++;
      this.#removedTasks.clear();
      this.#activePages = [];
      this.#activeCursor = shell.activeNextBefore;
    }
    if ((replaced || attached) && this.#doneCount) {
      // A new cut (an attach, a repair, a history reset) may stand on a different history: the
      // held count keeps showing, but its horizon goes, so the Host's next count is always taken,
      // and that count is asked for now.
      this.#doneCount = { count: this.#doneCount.count, asOf: -1n };
      this.#doneChangedAt = state.through === null ? 0n : BigInt(state.through);
      this.#countDoneSoon();
    }
    const tasksChanged = replaced || old?.tasks !== state.tasks;
    const visitsChanged = old?.visits !== state.visits;
    const taskChanges = state.taskChanges.length > 0 && old?.taskChanges !== state.taskChanges;
    const doneMoves: DoneMove[] = [];
    if (taskChanges) {
      for (const row of state.taskChanges) {
        const held = heldThread(this.#snapshot, row.id);
        if (this.#donePages || this.#taskReads.busy("done")) {
          // What this client knew of the task's Done membership before the push, if anything.
          const prior = old?.tasks.get(row.id);
          const listed = this.#donePages?.entries.some(({ thread }) => thread.id === row.id);
          const was = listed
            ? true
            : held
              ? isDoneTask(held)
              : prior
                ? isDoneTask(prior)
                : undefined;
          doneMoves.push({ row, was, now: !("removed" in row) && isDoneTask(row) });
        }
        if ("removed" in row) {
          this.#removedTasks.add(row.id);
          continue;
        }
        if (held)
          this.#threadState.reconcile(
            {
              ...held,
              title: row.title,
              status: row.status,
              doneAt: row.doneAt,
              doneReason: row.doneReason,
              latestRunCompletedAt: row.latestRunCompletedAt,
              inputQueuePaused: row.inputQueuePaused ?? held.inputQueuePaused,
              runQueued: row.runQueued,
              agentSessionId: row.agentSessionId ?? null,
              externalWork: row.externalWork ?? null,
              ...(row.retry === undefined ? {} : { retry: row.retry }),
            },
            SequenceSchema.parse(row.revision),
            undefined,
            row,
          );
      }
    }
    if (doneMoves.length) this.#moveDone(doneMoves, state.through);
    if (
      session &&
      (this.#snapshot.user?.id !== session.user.id ||
        this.#snapshot.sessionId !== session.sessionId ||
        this.#snapshot.role !== session.role)
    ) {
      const { role: _previousRole, ...withoutRole } = this.#snapshot;
      this.#update({
        ...withoutRole,
        ...(session.role ? { role: session.role } : {}),
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
    const effectiveWorkPolicy = shell.effectiveWorkPolicy ?? null;
    if (
      tasksChanged ||
      taskChanges ||
      visitsChanged ||
      attentionChanged ||
      effectiveWorkPolicy !== this.#snapshot.effectiveWorkPolicy ||
      connection !== this.#snapshot.connection
    ) {
      const taskLists =
        tasksChanged || taskChanges
          ? this.#taskLists(
              state,
              replaced ? undefined : { tasks: old?.tasks, changes: state.taskChanges },
            )
          : undefined;
      if (state.synchronized) this.#savedViewReadiness = { tasksReady: true };
      this.#update(
        {
          ...this.#snapshot,
          connection,
          connectionInterrupted: attached ? false : this.#snapshot.connectionInterrupted,
          effectiveWorkPolicy,
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
        },
        taskChanges,
      );
    }
    if (state.synchronized && (tasksChanged || !old?.synchronized)) this.#requestTaskReads();
    if (attached) {
      this.#connectionAdmit?.();
      this.#finishLoad();
      this.references.reconnect();
      this.#invalidatePersonalRemoteAccess();
      this.#reverifyCapabilities();
      this.#resources.resume();
      if (reattached) this.#noticesMissed();
    } else if (forgot) this.#resources.resume();
    if (
      state.synchronized &&
      (shell.counts.needsYouCount || this.#snapshot.needsYou) &&
      (attached || attentionChanged)
    )
      this.#invalidateAttention(true);
    if (state.synchronized) this.#syncWaitingRequests(attached ? "resume" : false);
  }

  /** The Host's pending Requests as the shell states them: their count and each row's revision. */
  /**
   * The pending count and the Host's `pendingRequestsRevision`, which moves exactly when the set
   * of pending Requests or what their list shows changes; `requests.list` returns the same
   * revision for the cut it read.
   */
  #requestStamp(): string | undefined {
    const state = this.#stream.shell.getSnapshot();
    if (!state.synchronized || !state.snapshot) return undefined;
    const { pendingRequestCount, pendingRequestsRevision } = state.snapshot.counts;
    return `${pendingRequestCount}|${pendingRequestsRevision}`;
  }

  /**
   * Brings `waitingRequests` to what the Host states now. There is one wanted stamp: a read is
   * asked for only when the stamp differs from the one last asked for, or on attach, a return to
   * the front or a local answer. A change while a read flies marks it to run once more when it
   * lands; it never adds another waiter. Unrelated shell frames leave the stamp, and the read,
   * alone. A count of zero needs no read.
   */
  #syncWaitingRequests(force: boolean | "resume" = false) {
    const stamp = this.#requestStamp();
    if (stamp === undefined || this.#disposed) return;
    const key = "waiting-requests";
    // An answer not yet confirmed is never carried across a gap: what it hides shows again,
    // unless the Host's list, read now, omits it.
    if (force === "resume") {
      let unconfirmed = false;
      for (const [id, { confirmedAfterRun }] of this.#answeredRequests)
        if (confirmedAfterRun === null) {
          this.#answeredRequests.delete(id);
          unconfirmed = true;
        }
      if (unconfirmed) force = true;
    }
    // An attach or a return to the front asks again only when the Host's pending count or
    // Requests revision moved since the list held was read; the Host's revision is the whole news.
    if (
      force === "resume" &&
      stamp === this.#waitingRequestInstalled &&
      !this.#waitingRequestReads.busy(key)
    ) {
      this.#waitingRequestWanted = stamp;
      return;
    }
    if (stamp.startsWith("0|")) {
      this.#waitingRequestReads.stop(key);
      this.#waitingRequestWanted = stamp;
      this.#waitingRequestInstalled = stamp;
      if (this.#snapshot.waitingRequests.length)
        this.#update({ ...this.#snapshot, waitingRequests: [] });
      return;
    }
    if (!force && stamp === this.#waitingRequestWanted) return;
    // Behind, nothing is read; the return to the front asks again.
    if (this.#visibility === "background") return;
    this.#waitingRequestWanted = stamp;
    if (this.#waitingRequestReads.busy(key)) this.#waitingRequestReads.changed(key);
    else this.#readWaitingRequests();
  }

  /** The stamp the list was last asked to match; each run reads it as it starts. */
  #waitingRequestWanted = "";
  /** The stamp the installed list was read at; empty while none is held for this viewer. */
  #waitingRequestInstalled = "";
  /** Each run of the list read, counted, so an answer confirmed after a run began outlives it. */
  #waitingRequestRuns = 0;
  /** Requests answered here: hidden from any list read that began before the answer was confirmed. */
  readonly #answeredRequests = new Map<string, { confirmedAfterRun: number | null }>();
  readonly #waitingRequestReads = new FencedReads({ epoch: () => String(this.#viewerGeneration) });

  /** The person answered a Request here: it leaves the list now, and stays gone unless re-asked. */
  async #answerRequest(requestId: string, answer: () => Promise<HostApiCommandOutput>) {
    this.#answeredRequests.set(requestId, { confirmedAfterRun: null });
    const generation = this.#viewerGeneration;
    const index = this.#snapshot.waitingRequests.findIndex(
      ({ request }) => request.id === requestId,
    );
    const removed = index === -1 ? undefined : this.#snapshot.waitingRequests[index];
    const waitingRequests = this.#snapshot.waitingRequests.filter(
      ({ request }) => request.id !== requestId,
    );
    if (waitingRequests.length !== this.#snapshot.waitingRequests.length)
      this.#update({ ...this.#snapshot, waitingRequests });
    try {
      const result = await answer();
      const held = this.#answeredRequests.get(requestId);
      if (held) held.confirmedAfterRun = this.#waitingRequestRuns;
      return result;
    } catch (error) {
      // Rejected, failed or cancelled: the Request is back now, where it was, and the list held
      // no longer counts as current, so the next attach or return to the front reads it.
      this.#answeredRequests.delete(requestId);
      this.#waitingRequestInstalled = "";
      if (
        removed &&
        generation === this.#viewerGeneration &&
        !this.#snapshot.waitingRequests.some(({ request }) => request.id === requestId)
      ) {
        const restored = [...this.#snapshot.waitingRequests];
        restored.splice(Math.min(index, restored.length), 0, removed);
        this.#update({ ...this.#snapshot, waitingRequests: restored });
      }
      throw error;
    } finally {
      this.#syncWaitingRequests(true);
    }
  }

  /**
   * The pending Requests this person answers, with the work each holds up: every page, installed
   * together. A read in flight when something changes installs nothing and runs again; a failure
   * retries with backoff while the app is in front.
   */
  #readWaitingRequests() {
    void this.#waitingRequestReads
      .request(
        "waiting-requests",
        async (read) => {
          const run = ++this.#waitingRequestRuns;
          const asked = this.#waitingRequestWanted;
          const read_: HostSnapshot["waitingRequests"][number][] = [];
          const revisions = new Set<string>();
          let before: string | null = null;
          // Read to the end, as the list is the person's whole set of open asks; the Host keeps no
          // cap on it, so no page count is a bound it guarantees. Only a broken cursor stops the
          // read, as a failure that retries, never as a shorter list.
          const cursors = new Set<string>();
          for (;;) {
            const page: {
              requests: HostSnapshot["waitingRequests"];
              reviewedRevisions?: Readonly<Record<string, string>> | undefined;
              window: import("@opensteer/protocol").DurableWindow;
              pendingRequestsRevision: string;
            } = unwrapRpcResult(
              await this.rpc["requests.list"](
                { ...(before ? { before } : {}), limit: 100, ...includeDeviceAccessRequests },
                { signal: read.signal },
              ),
            );
            if (!read.current()) return;
            for (const entry of page.requests) {
              read_.push({
                ...entry,
                request: {
                  ...entry.request,
                  reviewedRevision: page.reviewedRevisions?.[entry.request.id],
                },
              });
            }
            revisions.add(page.pendingRequestsRevision);
            if (!page.window.hasMore) break;
            before = page.window.nextBefore ?? null;
            if (!before || cursors.has(before))
              throw Object.assign(new Error("The Host's waiting Requests list repeats a page."), {
                code: "conflict",
              });
            cursors.add(before);
          }
          if (!read.current()) return;
          // Pages read at different revisions are not one list: read it whole again.
          if (revisions.size !== 1) {
            queueMicrotask(() => this.#syncWaitingRequests(true));
            return;
          }
          // An answer confirmed before this run began is the Host's truth now: a Request it still
          // lists was asked again. One confirmed later, or not yet, stays hidden from this answer.
          for (const [id, { confirmedAfterRun }] of this.#answeredRequests)
            if (confirmedAfterRun !== null && confirmedAfterRun < run)
              this.#answeredRequests.delete(id);
          const waitingRequests = read_.filter(
            ({ request }) => !this.#answeredRequests.has(request.id),
          );
          // Read at the stamp it was asked for only when the Host's pages carry that revision.
          const [revision] = revisions;
          this.#waitingRequestInstalled = asked.endsWith(`|${revision}`) ? asked : "";
          this.#update({ ...this.#snapshot, waitingRequests });
        },
        { observed: () => !this.#disposed && this.#visibility !== "background" },
      )
      .catch(() => undefined);
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

  /** A kind's complete inventory, every page of one read, installed as one change. */
  #applyResource(
    pages: readonly import("zod").infer<
      typeof import("@opensteer/protocol/resources").PersonalResourceDataSchema
    >[],
  ) {
    const first = pages[0];
    if (!first) return;
    if (first.kind === "tab" || first.kind === "tab-layout") return this.#applyTabResource(pages);
    let snapshot = this.#snapshot;
    pages.forEach((data, index) => {
      snapshot = this.#resourcePage(snapshot, data, index > 0);
    });
    if (first.kind === "harness-catalog")
      snapshot = {
        ...snapshot,
        environments: snapshot.environments.map((row) => this.#withEnvironmentCatalogs(row)),
      };
    if (first.kind === "machine")
      snapshot = { ...snapshot, machineRevision: this.#snapshot.machineRevision + 1 };
    if (snapshot !== this.#snapshot) this.#update(snapshot);
  }

  /** The tab rows or layout of one read, replacing what the tab store holds in one step. */
  #applyTabResource(
    pages: readonly import("zod").infer<
      typeof import("@opensteer/protocol/resources").PersonalResourceDataSchema
    >[],
  ) {
    const tabPages = pages.flatMap((data) => (data.kind === "tab" ? [data.tabs] : []));
    if (tabPages.length) {
      this.#tabs.replaceRows(
        mergeResourceRows(
          [],
          tabPages.flatMap((page) => page.tabs),
          (tab) => tab.tabId,
        ),
        // Each page says whether the rows end with it; the last one speaks for the whole read.
        tabPages.at(-1)!.complete,
      );
      return;
    }
    const layouts = pages.flatMap((data) => (data.kind === "tab-layout" ? [data.tabs.layout] : []));
    const last = layouts.at(-1);
    if (!last) return;
    this.#tabs.replaceLayout({
      ...last,
      items: mergeResourceRows(
        [],
        layouts
          .filter((layout) => layout.revision === last.revision)
          .flatMap((layout) => layout.items),
        (item) => (item.kind === "tab" ? item.tabId : item.group.groupId),
      ),
    });
  }

  /** One page of a read laid onto the snapshot being built; nothing is published here. */
  #resourcePage(
    snapshot: HostSnapshot,
    data: import("zod").infer<
      typeof import("@opensteer/protocol/resources").PersonalResourceDataSchema
    >,
    append: boolean,
  ): HostSnapshot {
    switch (data.kind) {
      case "plugin-engine":
        for (const listener of this.#pluginEngineListeners) listener(data.engine);
        return snapshot;
      case "settings":
        return {
          ...snapshot,
          personalSettings: data.settings,
          quietTaskDays: data.quietTaskDays,
          executionPreferences: data.executionPreferences,
          voiceThreadId: data.settings?.voiceThreadId ?? null,
        };
      case "identity":
        return { ...snapshot, identityConfig: data.identity };
      case "owner-profile":
        return { ...snapshot, ownerProfile: data.ownerProfile };
      case "environment":
        return {
          ...snapshot,
          environments: mergeResourceRows(
            append ? snapshot.environments : [],
            data.environments.map((row) => this.#withEnvironmentCatalogs(row)),
            (row) => row.id,
          ),
        };
      case "harness-catalog":
        // Staged in the catalog map; the snapshot takes it once every page is in.
        if (!append) this.#environmentCatalogs.clear();
        for (const row of data.environments) {
          const held = this.#environmentCatalogs.get(row.id) ?? [];
          const page = row.harnessCatalogs.map((catalog) => {
            const previous = held.find(
              ({ harnessInstanceId }) => harnessInstanceId === catalog.harnessInstanceId,
            );
            return previous?.status === "ready" && catalog.status === "ready"
              ? { ...catalog, models: [...previous.models, ...catalog.models] }
              : catalog;
          });
          this.#environmentCatalogs.set(
            row.id,
            mergeResourceRows(held, page, (catalog) => catalog.harnessInstanceId),
          );
        }
        return snapshot;
      case "machine":
        return {
          ...snapshot,
          machines: mergeResourceRows(
            append ? snapshot.machines : [],
            data.machines,
            (row) => row.id,
          ),
        };
      case "harness":
        return {
          ...snapshot,
          harnesses: mergeResourceRows(
            append ? snapshot.harnesses : [],
            data.harnesses.map(({ config, ...harness }) => ({
              ...harness,
              ...harnessEndpoint(config),
            })),
            (row) => row.id,
          ),
        };
      case "tab":
      case "tab-layout":
        return snapshot;
      case "browser-profile":
        return {
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
        };
      case "browser-placement":
        return {
          ...snapshot,
          browserPlacements: mergeResourceRows(
            append ? snapshot.browserPlacements : [],
            data.placements,
            (row) => row.runnerId,
          ),
          // A pooled browser's report, copied unchanged; absent from every other Home.
          ...(data.pools
            ? {
                browserPools: mergeResourceRows(
                  append ? (snapshot.browserPools ?? []) : [],
                  data.pools,
                  (row) => row.runnerId,
                ),
              }
            : append
              ? {}
              : { browserPools: undefined }),
        };
      case "browser-home":
        return {
          ...snapshot,
          browserProfileHomes: mergeResourceRows(
            append ? (snapshot.browserProfileHomes ?? []) : [],
            data.homes ?? [],
            (runnerId) => runnerId,
          ),
        };
      case "browser-availability":
        return { ...snapshot, browserAvailable: data.available };
    }
    return snapshot;
  }

  #withEnvironmentCatalogs(row: EnvironmentSummary): EnvironmentSummary {
    return { ...row, harnessCatalogs: this.#environmentCatalogs.get(row.id) ?? [] };
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
    const key = `assignments:${threadId}`;
    if (this.#assignmentsRead.has(threadId) || this.#assignmentReads.busy(key)) return;
    this.#assignmentKeys.add(threadId);
    void this.#assignmentReads
      .request(key, (read) => this.#readAssignments(threadId, read), {
        observed: () => !this.#disposed && this.#showsThread(threadId),
      })
      .catch(() => undefined);
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
   * The newest page, which is all the history a family shows, and, when that page is not the
   * whole family, every open Assignment however far back it was handed out, so work under way is
   * never missing. A Host without `task-family-v1` gives the newest page alone.
   */
  /**
   * Reads a task's assignments: its newest page and, when that left some out, every open one. The
   * result replaces what this client held for the task: an open assignment neither read returns
   * has finished, even when the feed's update for it was skipped by a repair.
   */
  async #readAssignments(threadId: string, read: FencedRead): Promise<void> {
    const startedAt = this.#assignmentPushCount;
    const list = async (open: boolean, before: string | null) => {
      try {
        const response = unwrapRpcResult(
          await this.rpc["thread.assignments.list"](
            {
              ...includeDeviceAccessRequests,
              threadId,
              limit: 100,
              ...(open ? { open } : {}),
              ...(before === null ? {} : { before }),
            },
            { signal: read.signal },
          ),
        );
        if (response.threadId !== threadId) throw new Error("Assignment page Thread mismatch.");
        return response;
      } catch (error) {
        if (read.current()) this.#denyOnRefusal(error, this.#assignmentsOfWorker(threadId));
        throw error;
      }
    };
    const newest = await list(false, null);
    const found = [...newest.assignments];
    let complete = !newest.window.hasMore;
    if (newest.window.hasMore && this.#capabilities?.includes("task-family-v1")) {
      let before: string | null = null;
      do {
        const page = await list(true, before);
        found.push(...page.assignments);
        before = page.window.hasMore ? page.window.nextBefore : null;
      } while (before !== null);
      complete = true;
    }
    if (!read.current()) return;
    const assignments = mergeAssignments(this.#snapshot.assignments, found);
    if (complete) {
      const returned = new Set<string>(found.map(({ id }) => id));
      for (const [id, held] of Object.entries(assignments))
        if (
          held.parentThreadId === threadId &&
          held.status === "open" &&
          !returned.has(id) &&
          // Pushed after this read began: newer than what the read could have returned.
          (this.#assignmentPushes.get(id) ?? 0) <= startedAt
        ) {
          delete assignments[id];
          this.#assignmentPushes.delete(id);
        }
    }
    this.#assignmentsRead.add(threadId);
    this.#update({ ...this.#snapshot, assignments });
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
    if (!this.#stream.ready) return;
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
    if (this.#ownsConnection) this.connection.start();
    await this.#load;
  }

  async refresh(options?: { readonly retryConnection?: boolean }): Promise<void> {
    if (this.#disposed) return;
    if (options?.retryConnection || !this.#socket) {
      this.connection.retry();
      await this.#load;
    } else {
      this.#stream.repairShell();
    }
  }

  async reauthenticate(): Promise<void> {
    if (this.#disposed) return;
    // The credential may have changed. A known viewer is judged against the next shell cut; what
    // was read before any viewer was known is read again under the new credential.
    if (this.#snapshot.user === null)
      this.#forgetViewer({
        identityConfig: this.#snapshot.identityConfig,
        connection: this.#snapshot.connection,
      });
    else this.#update({ ...this.#snapshot, session: "checking" });
    this.connection.retry();
    await this.#load;
  }

  async searchThreadMessages(input: { threadId: string; query: string; before?: string }) {
    return unwrapRpcResult(await this.rpc["thread.messages.list"]({ ...input, limit: 50 }));
  }

  subscribeNotifications(listener: (notification: NotificationView) => void): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  subscribePluginsChanged(
    listener: (message: { type: "host.plugins-changed" } & PluginChange) => void,
  ): () => void {
    const watch = (kind: PersonalResourceKind, category?: PluginResourceCategory) => {
      let seen = this.#resources.revision(kind);
      return this.#resources.watch(kind, () => {
        const revision = this.#resources.revision(kind);
        if (revision === undefined || revision === seen) return;
        seen = revision;
        listener({ type: "host.plugins-changed", ...(category ? { categories: [category] } : {}) });
      });
    };
    const releases = [
      watch("plugin"),
      ...Object.entries(pluginCategoryResources).map(([category, kind]) =>
        watch(kind, category as PluginResourceCategory),
      ),
    ];
    return () => releases.forEach((release) => release());
  }
  subscribePluginEngine(listener: (engine: PluginEngineStateView) => void): () => void {
    this.#pluginEngineListeners.add(listener);
    const release = this.watchPersonalResource("plugin-engine", () => {});
    return () => {
      this.#pluginEngineListeners.delete(listener);
      release();
      if (!this.#pluginEngineListeners.size) this.#resources.forget("plugin-engine");
    };
  }
  subscribePersonalRemoteAccess(listener: () => void): () => void {
    this.#personalRemoteAccessListeners.add(listener);
    return () => this.#personalRemoteAccessListeners.delete(listener);
  }

  /** Reads these kinds again, for a screen that said it could not load them. */
  retryResources(kinds: readonly PersonalResourceKind[]) {
    for (const kind of kinds) this.#resources.retry(kind);
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

  async createThread(
    input: CreateThreadInput,
    expectedLogin?: ClientScope,
  ): Promise<ThreadSummary> {
    const origin = {
      sessionGeneration: this.#sessionGeneration,
      sessionId: this.#snapshot.sessionId,
    };
    const result = await this.dispatch(
      {
        type: "thread.create",
        accessMode: input.accessMode,
        environmentId: input.environmentId,
        harnessInstanceId: input.harnessInstanceId,
        idempotencyKey: input.idempotencyKey ?? mutationIdempotencyKey("thread"),
        modelSelection: input.modelSelection,
        ...(input.parentThreadId ? { parentThreadId: input.parentThreadId } : {}),
        ...(input.generateTitle ? { generateTitle: true } : {}),
        title: input.title?.trim() || "New task",
      },
      expectedLogin ? { expectedLogin } : undefined,
    );
    if (result.type !== "thread.create") throw new Error("Thread command mismatch.");
    // Not waited for: the new Thread is what the person is waiting to see.
    void this.#rememberQuietly(
      {
        accessMode: input.accessMode,
        selection: {
          environmentId: input.environmentId,
          harnessInstanceId: input.harnessInstanceId,
          modelSelection: input.modelSelection,
        },
      },
      origin,
    );
    return (
      this.#snapshot.threads.find(({ id }) => id === result.thread.id) ??
      toThreadSummary(result.thread, this.#snapshot.environments, this.#snapshot.harnesses)
    );
  }

  rememberExecution(choice: ExecutionChoice): Promise<ExecutionPreferences> {
    return this.#rememberExecution(choice, {
      sessionGeneration: this.#sessionGeneration,
      sessionId: this.#snapshot.sessionId,
    });
  }

  #rememberExecution(
    choice: ExecutionChoice,
    origin: { readonly sessionGeneration: number; readonly sessionId: AuthSessionId | undefined },
  ): Promise<ExecutionPreferences> {
    // One at a time, in the order chosen: a remember nobody waits for, such
    // as a new Thread's, must not land after a later choice and take it back.
    const remembered = this.#remembering.then(async () => {
      if (
        this.#disposed ||
        origin.sessionGeneration !== this.#sessionGeneration ||
        origin.sessionId !== this.#snapshot.sessionId
      ) {
        throw new ClientOperationError("This request belongs to another sign-in.", "blocked", {
          kind: "session",
          reason: "session-changed",
          retryable: false,
        });
      }
      const command = clientCommandSchema.parse({
        ...(choice.accessMode ? { accessMode: choice.accessMode } : {}),
        idempotencyKey: mutationIdempotencyKey("execution-preferences"),
        ...(choice.selection ? { selection: choice.selection } : {}),
        type: "execution.preferences.remember",
      });
      const result = await this.#dispatchCommand(command, origin.sessionId);
      if (result.type !== "execution.preferences.remember") {
        throw new Error("Execution preferences command mismatch.");
      }
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
              ? withThreadState(this.#snapshot, (current) =>
                  current.id === threadId ? this.#threadState.view(thread) : current,
                )
              : this.#snapshot,
          );
      }
    }
    return this.#snapshot.threads.find((item) => item.id === threadId) ?? renamed;
  }

  async #setThreadIcon(
    command: Extract<HostApiCommand, { type: "thread.icon.set" }>,
    expectedSessionId?: AuthSessionId,
  ): Promise<HostApiCommandOutput> {
    const { threadId } = command;
    const thread = threadInDirectory(threadId, this.#snapshot);
    if (thread) this.#threadState.reconcile(thread, zeroSequence);
    const generation = this.#viewerGeneration;
    const token = Symbol(threadId);
    this.#threadIcons.set(threadId, { icon: command.icon ?? defaultTaskSymbol, token });
    this.#update(this.#snapshot);
    try {
      return await this.#dispatchCommand(command, expectedSessionId);
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
    const origin = {
      sessionGeneration: this.#sessionGeneration,
      sessionId: this.#snapshot.sessionId,
    };
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
      await this.#rememberQuietly(
        {
          selection: {
            environmentId: thread.environmentId,
            harnessInstanceId: selection.harnessInstanceId,
            modelSelection: selection.modelSelection,
          },
        },
        origin,
      );
    }
    return this.#snapshot.threads.find(({ id }) => id === threadId) ?? updated;
  }

  async updateThreadAccess(threadId: string, accessMode: ThreadAccessMode): Promise<ThreadSummary> {
    const thread = this.#snapshot.threads.find((item) => item.id === threadId);
    if (!thread) throw new Error("Thread not found.");
    const origin = {
      sessionGeneration: this.#sessionGeneration,
      sessionId: this.#snapshot.sessionId,
    };
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
    await this.#rememberQuietly({ accessMode }, origin);
    return this.#snapshot.threads.find(({ id }) => id === threadId) ?? updated;
  }

  /**
   * The Thread mutation the person asked for already succeeded, so a refused
   * or unreachable remember is not theirs to see: the Host's next bootstrap
   * is the authority on what is remembered either way.
   */
  async #rememberQuietly(
    choice: ExecutionChoice,
    origin: { readonly sessionGeneration: number; readonly sessionId: AuthSessionId | undefined },
  ): Promise<void> {
    await this.#rememberExecution(choice, origin).catch(() => undefined);
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

  async stopRun(threadId: string, expectedRunId?: string): Promise<void> {
    const thread = this.#snapshot.threads.find((item) => item.id === threadId);
    if (!thread) throw new Error("Thread not found.");
    const detail = this.#reader(threadId)?.getSnapshot();
    const run = threadStopTarget({ runQueue: detail?.synchronized ? detail.runQueue : [], thread });
    if (!run) {
      if (expectedRunId !== undefined) return;
      throw new Error("This Thread has nothing to stop.");
    }
    if (expectedRunId !== undefined && run.id !== expectedRunId) return;
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
      // The lease just taken is checked against the Host itself, not the feed racing behind it.
      const queue = unwrapRpcResult(
        await this.rpc["thread.inputQueue.get"](
          { threadId: ThreadIdSchema.parse(threadId) },
          { signal },
        ),
      );
      signal.throwIfAborted();
      const held = queue?.items.find(({ message }) => message.id === messageId);
      const current = page.revisions[0];
      if (
        !current ||
        current.revision !== expectedRevision ||
        !held?.lease?.ownedBySession ||
        Date.parse(held.lease.expiresAt) <= Date.now() ||
        held.message.revision !== expectedRevision
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
    command: (idempotencyKey: string) => ClientCommandInput,
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

  async #dispatch(
    command: HostApiCommandInput,
    expectedSessionId?: AuthSessionId,
  ): Promise<HostApiCommandOutput> {
    return unwrapRpcResult(
      await this.rpc["commands.dispatch"](
        command,
        expectedSessionId ? { expectedSessionId } : undefined,
      ),
    );
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#doneCountTimer) clearTimeout(this.#doneCountTimer);
    // Their retries are gated on observation already; this also lets their timers go now.
    this.#taskReads.dispose();
    this.#assignmentReads.dispose();
    this.#waitingRequestReads.dispose();
    disposeMessageOutbox(this);
    if (this.#ownsConnection) this.connection.dispose();
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
    this.#computerViewRemovedListeners.clear();
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
    this.#resources.dispose();
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
          { ...(before ? { before } : {}), limit: 50, ...includeDeviceAccessRequests },
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

  async readRequest(threadId: string, requestId: string): Promise<RequestView | null> {
    const generation = this.#viewerGeneration;
    const { requests, reviewedRevisions } = unwrapRpcResult(
      await this.rpc["thread.requests.list"]({
        ...includeDeviceAccessRequests,
        requestId: RequestIdSchema.parse(requestId),
        threadId: ThreadIdSchema.parse(threadId),
      }),
    );
    if (generation !== this.#viewerGeneration || this.#disposed) return null;
    const request = requests.find(
      ({ id, originatingThreadId }) => id === requestId && originatingThreadId === threadId,
    );
    if (!request) return null;
    return { ...request, reviewedRevision: reviewedRevisions?.[request.id] };
  }

  /** Opens Done: a person opening it sees it read again from its first page. */
  loadDoneTasks(): Promise<void> {
    this.#doneDepth = Math.max(this.#doneDepth, taskPageSize);
    this.#doneOpens++;
    return this.#requestDone();
  }

  loadEarlierDoneTasks(): Promise<void> {
    this.#doneDepth = Math.max(
      this.#doneDepth,
      (this.#donePages?.entries.length ?? 0) + taskPageSize,
    );
    return this.#requestDone();
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

  loadEarlierTasks(): Promise<void> {
    this.#openDepth = Math.max(
      this.#openDepth,
      settledEntries(this.#snapshot.tasks).length + taskPageSize,
    );
    return this.#requestOpen();
  }

  /** Task reads run while the socket is attached and the app is in front. */
  readonly #tasksObserved = () =>
    !this.#disposed && this.#stream.ready && this.#visibility !== "background";

  /** Starts the task reads the lists still need; each is one fenced job that reads to its depth. */
  #requestTaskReads() {
    if (!this.#stream.shell.getSnapshot().synchronized || !this.#tasksObserved()) return;
    const tasks = this.#snapshot.tasks;
    if (
      tasks?.window.hasMore &&
      this.#settledInCut() < this.#openDepth &&
      !this.#taskReads.busy("open")
    )
      void this.#requestOpen().catch(() => undefined);
    if (this.#activeCursor !== null && !this.#taskReads.busy("active"))
      void this.#taskReads
        .request("active", (read) => this.#readActive(read), { observed: this.#tasksObserved })
        .catch(() => undefined);
    if (
      this.#doneDepth > 0 &&
      this.#donePages?.stamp !== this.#doneStamp() &&
      !this.#taskReads.busy("done")
    )
      void this.#requestDone().catch(() => undefined);
    // A count left stale (its read came while out of sight) is asked for again.
    else if (this.#doneCountStale() && this.#donePages && !this.#taskReads.busy("done-count"))
      this.#countDoneSoon();
  }

  #requestOpen() {
    return this.#taskReads.request("open", (read) => this.#readOpen(read), {
      observed: this.#tasksObserved,
    });
  }

  /**
   * Follows pushed moves in and out of Done. The loaded Done rows move at once where the client
   * can place the task (it knew it, the held list is the whole of Done, or its `doneAt` is newer
   * than every held one). The count does not: any push that can change Done's membership marks it
   * stale, and the count shown stays the Host's last answer until the count is read again, once
   * the pushes rest.
   */
  #moveDone(moves: readonly DoneMove[], through: string | null) {
    // Pushes that can touch Done: into it, out of it, or a task this client cannot place.
    const touching = moves.filter(({ was, now }) => now || was !== false);
    if (!touching.length) return;
    // The count is never worked out here: it is the Host's last answer. A change at this sequence
    // leaves it stale until a count read at or after it, asked for once the pushes rest.
    if (through !== null && BigInt(through) > this.#doneChangedAt)
      this.#doneChangedAt = BigInt(through);
    // A Done read in flight from before them is read again.
    if (this.#taskReads.busy("done")) this.#taskReads.changed("done");
    const pages = this.#donePages;
    if (!pages) return;
    // Rows the loaded Done page holds, or a task now Done newer than every held row, move at once.
    let entries = pages.entries;
    const oldest = entries.at(-1)?.thread.doneAt ?? null;
    for (const { row, was, now } of touching) {
      const before =
        was ??
        (!pages.window.hasMore ||
        (now && "doneAt" in row && oldest !== null && row.doneAt! > oldest)
          ? false
          : undefined);
      if (before === undefined || before === now) continue;
      entries = entries.filter(({ thread }) => thread.id !== row.id);
      if (now && !("removed" in row)) entries = [...entries, this.#shellEntry(row)];
    }
    if (entries !== pages.entries)
      this.#donePages = {
        ...pages,
        entries: [...entries].sort((left, right) => compareDoneOrder(left.thread, right.thread)),
      };
    this.#countDoneSoon();
  }

  /** Reads Done's count again once pushes have rested, so a burst of them costs one read. */
  #countDoneSoon() {
    if (this.#doneCountTimer) clearTimeout(this.#doneCountTimer);
    this.#doneCountTimer = setTimeout(() => {
      this.#doneCountTimer = undefined;
      if (!this.#donePages) return;
      void this.#taskReads
        .request("done-count", (read) => this.#readDoneCount(read), {
          observed: this.#tasksObserved,
        })
        .catch(() => undefined);
    }, doneCountRestMs);
  }

  async #readDoneCount(read: FencedRead) {
    const page = unwrapRpcResult(
      await this.rpc["tasks.page"]({ done: true, limit: 1 }, { signal: read.signal }),
    );
    if (!read.current() || page.window.totalItems === undefined) return;
    if (this.#offerDoneCount(page.window.totalItems, page.asOfSequence)) this.#publishTasks();
  }

  /** Takes a count from the Host if it was read at the held count's sequence or later. */
  #offerDoneCount(count: number, asOfSequence: string) {
    const asOf = BigInt(asOfSequence);
    if (this.#doneCount && asOf < this.#doneCount.asOf) return false;
    this.#doneCount = { count, asOf };
    return true;
  }

  /** Stale while a pushed change is newer than the count the Host last gave. */
  #doneCountStale() {
    return this.#doneChangedAt > (this.#doneCount?.asOf ?? -1n);
  }

  #requestDone() {
    return this.#taskReads.request("done", (read) => this.#readDone(read), {
      observed: this.#tasksObserved,
    });
  }

  #doneStamp() {
    return `${this.#viewerGeneration}:${this.#shellCut}:${this.#doneOpens}`;
  }

  /** Reads open tasks past the shell's settled window until `#openDepth` settled rows, or the end. */
  async #readOpen(read: FencedRead) {
    for (;;) {
      const shell = this.#stream.shell.getSnapshot().snapshot;
      if (!shell) return;
      const pages = this.#openPages?.cut === this.#shellCut ? this.#openPages : undefined;
      const window = pages?.window ?? {
        nextBefore: shell.nextBefore,
        hasMore: shell.nextBefore !== null,
      };
      if (!window.hasMore || window.nextBefore === null || this.#settledInCut() >= this.#openDepth)
        return;
      const page = await this.#taskPage({ before: window.nextBefore }, read);
      if (!read.current()) return;
      this.#openPages = {
        cut: this.#shellCut,
        entries: mergeTaskEntries(pages?.entries ?? [], page.entries),
        window: { nextBefore: page.window.nextBefore, hasMore: page.window.hasMore },
      };
      this.#publishTasks();
    }
  }

  /** Settled open rows this cut holds: the shell's own and the pages read against it. */
  #settledInCut() {
    const state = this.#stream.shell.getSnapshot();
    const ids = new Set<string>();
    const settled = (thread: { doneAt: string | null; status: string }) =>
      thread.doneAt === null &&
      thread.status !== "archived" &&
      thread.status !== "running" &&
      thread.status !== "waiting";
    for (const row of state.tasks.values()) if (settled(row)) ids.add(row.id);
    if (this.#openPages?.cut === this.#shellCut)
      for (const { thread } of this.#openPages.entries)
        if (!state.tasks.has(thread.id) && !this.#removedTasks.has(thread.id) && settled(thread))
          ids.add(thread.id);
    return ids.size;
  }

  /** Reads every running and waiting task past the shell's active window. */
  async #readActive(read: FencedRead) {
    while (this.#activeCursor !== null) {
      const page = await this.#taskPage({ active: true, before: this.#activeCursor }, read);
      if (!read.current()) return;
      this.#activePages = mergeTaskEntries(this.#activePages, page.entries);
      this.#activeCursor = page.window.hasMore ? page.window.nextBefore : null;
      this.#publishTasks();
    }
  }

  /**
   * Reads Done to `#doneDepth`. Pages read against the current stamp are continued; a push that
   * may move Done membership, or a new shell cut, starts it again from the first page.
   */
  async #readDone(read: FencedRead) {
    const stamp = this.#doneStamp();
    let held = this.#donePages?.stamp === stamp ? this.#donePages : undefined;
    for (;;) {
      if (
        held &&
        (!held.window.hasMore ||
          held.window.nextBefore === null ||
          held.entries.length >= this.#doneDepth)
      )
        return;
      const before = held?.window.nextBefore;
      const page = await this.#taskPage({ done: true, ...(before ? { before } : {}) }, read);
      if (!read.current()) return;
      held = {
        stamp,
        entries: mergeTaskEntries(held?.entries ?? [], page.entries).sort((left, right) =>
          compareDoneOrder(left.thread, right.thread),
        ),
        // The count shown is `#doneCount`, never a page's.
        window: { ...page.window, totalItems: 0 },
      };
      // A page that counts (only a first page does) offers its count, by its own sequence.
      if (page.window.totalItems !== undefined)
        this.#offerDoneCount(page.window.totalItems, page.asOfSequence);
      this.#donePages = held;
      this.#publishTasks();
    }
  }

  /** One page of tasks, as entries; a shell row newer than the page's cut stands for its own. */
  async #taskPage(
    input: { readonly done?: true; readonly active?: true; readonly before?: string },
    read: FencedRead,
  ) {
    const page = unwrapRpcResult(
      await this.rpc["tasks.page"]({ ...input, limit: taskPageSize }, { signal: read.signal }),
    );
    // A page from a cut since replaced touches nothing, the shared thread state included.
    if (!read.current())
      return { entries: [], window: page.window, asOfSequence: page.asOfSequence };
    const rows = this.#stream.shell.getSnapshot().tasks;
    const asOf = BigInt(page.asOfSequence);
    const entries = page.tasks.flatMap((entry): TaskEntry[] => {
      if (this.#removedTasks.has(entry.thread.id)) return [];
      const row = rows.get(entry.thread.id);
      if (row && BigInt(row.revision) > asOf) return [this.#shellEntry(row)];
      const thread = toThreadSummary(
        entry.thread,
        this.#snapshot.environments,
        this.#snapshot.harnesses,
      );
      return [
        {
          ...entry,
          thread: this.#reconcilePageThread(
            // The queued-account reason and active retry ride beside the Thread on the page, as on the shell row.
            entry.runQueued === undefined && entry.retry === undefined
              ? thread
              : {
                  ...thread,
                  ...(entry.runQueued === undefined ? {} : { runQueued: entry.runQueued }),
                  ...(entry.retry === undefined ? {} : { retry: entry.retry }),
                },
            page.asOfSequence,
          ),
        },
      ];
    });
    return { entries, window: page.window, asOfSequence: page.asOfSequence };
  }

  #publishTasks() {
    const state = this.#stream.shell.getSnapshot();
    if (!state.snapshot) return;
    this.#update({ ...this.#snapshot, ...this.#taskLists(state) });
  }

  /**
   * The task lists: the shell's keyed rows, then the rows pages read past it. A row the shell
   * holds speaks for itself; a task the shell removed is gone. Done is what the Host counted at
   * its last read, less tasks a push has since reopened or removed; a push that may add one
   * reads Done again.
   */
  #taskLists(
    state: ReturnType<PersonalShellStore["getSnapshot"]>,
    delta?: {
      readonly tasks: ReadonlyMap<string, unknown> | undefined;
      readonly changes: readonly { readonly id: string }[];
    },
  ): Pick<HostSnapshot, "tasks" | "activeTasks" | "doneTasks"> {
    const shell = state.snapshot!;
    const { open, active } = this.#openLists(state, delta);
    const window =
      this.#openPages?.cut === this.#shellCut
        ? this.#openPages.window
        : { nextBefore: shell.nextBefore, hasMore: shell.nextBefore !== null };
    const done = this.#donePages;
    return {
      tasks: {
        entries: open,
        window: { ...window, totalItems: open.length, byteCount: 0, itemCount: open.length },
      },
      activeTasks: active,
      doneTasks: done
        ? {
            [mainDoneTasks]: {
              window: { ...done.window, totalItems: this.#doneCount?.count ?? 0 },
              entries: done.entries.flatMap((entry) => {
                if (this.#removedTasks.has(entry.thread.id)) return [];
                // A held row takes a pushed change through the thread state.
                return state.tasks.get(entry.thread.id)?.doneAt === null ? [] : [entry];
              }),
            },
          }
        : {},
    };
  }

  /**
   * The open and active lists, sorted. A publish that only changed some task rows (no page, no
   * shell replacement, no row the shell let go of on its own) moves just those rows, by binary
   * search, instead of rebuilding and re-sorting every held task.
   */
  #openLists(
    state: ReturnType<PersonalShellStore["getSnapshot"]>,
    delta?: {
      readonly tasks: ReadonlyMap<string, unknown> | undefined;
      readonly changes: readonly { readonly id: string }[];
    },
  ) {
    const cache = this.#openCache;
    const ids = delta ? new Set(delta.changes.map(({ id }) => id)) : undefined;
    let size = delta?.tasks?.size ?? -1;
    for (const id of ids ?? []) size += Number(state.tasks.has(id)) - Number(delta!.tasks!.has(id));
    if (
      cache &&
      ids &&
      delta!.tasks === cache.tasks &&
      cache.openPages === this.#openPages &&
      cache.activePages === this.#activePages &&
      size === state.tasks.size
    ) {
      const open = [...cache.open];
      const active = [...cache.active];
      for (const id of ids) {
        const before = cache.byId.get(id);
        if (before) {
          remove(open, before);
          remove(active, before);
          cache.byId.delete(id);
        }
        const row = state.tasks.get(id);
        const entry = row
          ? this.#shellEntry(row)
          : this.#removedTasks.has(id)
            ? undefined
            : [...(this.#openPages?.entries ?? []), ...this.#activePages].find(
                ({ thread }) => thread.id === id,
              );
        if (!entry) continue;
        cache.byId.set(id, entry);
        if (isOpenTask(entry)) insert(open, entry);
        if (isActiveTask(entry)) insert(active, entry);
      }
      this.#openCache = { ...cache, tasks: state.tasks, open, active };
      return { open, active };
    }
    const paged = (entries: readonly TaskEntry[]) =>
      entries.filter(
        ({ thread }) => !state.tasks.has(thread.id) && !this.#removedTasks.has(thread.id),
      );
    const byId = new Map<string, TaskEntry>();
    for (const entry of [
      ...[...state.tasks.values()].map((row) => this.#shellEntry(row)),
      ...paged(this.#openPages?.entries ?? []),
      ...paged(this.#activePages),
    ])
      if (!byId.has(entry.thread.id)) byId.set(entry.thread.id, entry);
    const open = [...byId.values()]
      .filter(isOpenTask)
      .sort((left, right) => compareTaskOrder(left.thread, right.thread));
    const active = open.filter(isActiveTask);
    this.#openCache = {
      tasks: state.tasks,
      openPages: this.#openPages,
      activePages: this.#activePages,
      byId,
      open,
      active,
    };
    return { open, active };
  }

  #reconcilePageThread(
    thread: ThreadSummary,
    sequence: Sequence,
    compact?: { readonly inputQueuePaused?: boolean | undefined },
  ) {
    const reconciled = this.#threadState.reconcile(thread, sequence, undefined, compact);
    return reconciled.pendingRequests === thread.pendingRequests
      ? reconciled
      : { ...reconciled, pendingRequests: thread.pendingRequests };
  }

  async setTaskDone(threadId: string, done: boolean): Promise<void> {
    if (!ThreadIdSchema.safeParse(threadId).success) {
      throw new HostClientRequestError({
        code: "not_found",
        message: "Task not found",
        status: 404,
      });
    }
    const generation = this.#viewerGeneration;
    const result = await this.dispatch({
      done,
      idempotencyKey: mutationIdempotencyKey(`done:${threadId}`),
      threadId,
      type: "thread.done.set",
    });
    if (result.type !== "thread.done.set") throw new Error("Done command mismatch.");
    if (generation !== this.#viewerGeneration) return;
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

  #connectionChanged(state: ClientConnectionState, old: ClientConnectionState) {
    this.#network = state.network;
    this.#visibility = state.visibility;
    if (state.visibility === "background" && old.visibility !== "background") {
      this.#backgroundShellGeneration = this.#stream.shell.getSnapshot().generation;
      this.#stream.setBackground(true);
      this.#invalidateAttention();
      this.#resources.abort();
    }
    this.#targetedControl.suspend(this.#reconnectSuspended(), state.network !== "offline");
    this.#targetedWatch.suspend(this.#reconnectSuspended());
    if (state.pathRevision !== old.pathRevision) {
      this.#targetedControl.reconnect();
      this.#targetedWatch.reconnect();
    }
    const connection =
      state.phase === "ready"
        ? "connected"
        : state.phase === "blocked" && state.issue?.code === "sign-in"
          ? "connected"
          : state.network === "offline" || state.phase === "recovering"
            ? "offline"
            : "connecting";
    if (
      connection !== this.#snapshot.connection ||
      state.showInterruption !== this.#snapshot.connectionInterrupted ||
      state.network !== this.#snapshot.network
    ) {
      this.#update({
        ...this.#snapshot,
        connection,
        connectionInterrupted: state.showInterruption,
      });
    }
    if (state.visibility !== old.visibility)
      for (const listener of this.#lifecycleListeners) listener(state.visibility);
    if (state.network !== old.network || state.pathRevision !== old.pathRevision)
      for (const listener of this.#lifecycleListeners) listener("network");
  }

  #reconnectSuspended() {
    return this.#visibility === "background" || this.#network === "offline";
  }

  openConnection(attempt: ConnectionAttempt): Promise<ConnectionLease> {
    const ready = Promise.withResolvers<ConnectionLease>();
    const closed = Promise.withResolvers<ReturnType<typeof classifyClientFailure>>();
    const loaded = Promise.withResolvers<void>();
    this.#load = loaded.promise;
    this.#resolveLoad = loaded.resolve;
    const close = () => {
      if (this.#connectionFailed !== fail) return;
      this.#connectionFailed = null;
      this.#connectionAdmit = null;
      attempt.signal.removeEventListener("abort", abort);
      this.#closeSocket(this.#socketCloseReason);
    };
    const fail = (error: unknown) => {
      if (this.#connectionFailed !== fail) return;
      close();
      const failure = classifyClientFailure(error);
      attempt.fail?.(failure);
      closed.resolve(failure);
      ready.reject(error);
    };
    const abort = () => fail(attempt.signal.reason);
    const lease: ConnectionLease = {
      closed: closed.promise,
      close,
      lastProgressAt: () => this.#lastRealtimeFrameAt,
      reconnectOnForeground: () =>
        this.#backgroundShellGeneration !== this.#stream.shell.getSnapshot().generation,
      probe: async (signal) => {
        // Frames that arrive while the pong is slow prove the socket alive just as the pong does.
        await this.#probeSocket(signal).catch((error: unknown) => {
          if (!probeAnsweredByFrames(signal)) throw error;
        });
        if (signal.aborted && !probeAnsweredByFrames(signal)) signal.throwIfAborted();
        if (this.#visibility === "foreground" && this.#backgroundShellGeneration !== undefined) {
          this.#resumeForeground();
          this.#requestTaskReads();
          if (this.#snapshot.needsYouCount || this.#snapshot.needsYou)
            this.#invalidateAttention(true);
          this.#resources.resume();
          // A list read given up in the background, or a change heard there, is read now.
          this.#syncWaitingRequests("resume");
        }
      },
    };
    this.#connectionFailed = fail;
    this.#connectionAdmit = () => {
      const scope = this.#clientScope ? this.#clientScope() : this.#localScope();
      const scopeKey = clientScopeKey(scope);
      const sessionId = this.#snapshot.sessionId;
      if (scope && scopeKey && sessionId) {
        this.#admittedSession = { scopeKey, sessionId };
        attempt.acceptScope(scope);
      }
      if (attempt.signal.aborted) return;
      attempt.admit?.(lease);
      ready.resolve(lease);
    };
    attempt.signal.addEventListener("abort", abort, { once: true });
    void this.#open(attempt).catch(fail);
    return ready.promise;
  }

  #localScope(): ClientScope | null {
    const { deploymentId, user, sessionId } = this.#snapshot;
    return deploymentId && user && sessionId
      ? { authorityKey: this.#baseUrl.origin, deploymentId, viewerId: user.id, loginId: sessionId }
      : null;
  }

  #probeSocket(signal: AbortSignal): Promise<void> {
    const socket = this.#socket;
    if (!socket || socket.readyState !== 1)
      return Promise.reject(new HostTransportError("unreachable"));
    const nonce = crypto.randomUUID();
    return new Promise<void>((resolve, reject) => {
      const abort = () => {
        if (this.#probe?.nonce === nonce) this.#probe = undefined;
        if (signal.reason instanceof HostTransportError && signal.reason.code === "timed-out")
          this.#socketCloseReason = "Liveness probe unanswered";
        reject(signal.reason);
      };
      const finish = () => {
        signal.removeEventListener("abort", abort);
        this.#probe = undefined;
        resolve();
      };
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
      this.#probe = { nonce, finish, abort };
      try {
        socket.send(JSON.stringify({ type: "client.ping", nonce }));
      } catch (error) {
        signal.removeEventListener("abort", abort);
        this.#probe = undefined;
        reject(error);
      }
    });
  }

  async #diagnoseHandshake(signal: AbortSignal) {
    if (this.#checkingHandshake || signal.aborted) return;
    this.#checkingHandshake = true;
    try {
      const result = await this.rpc["personal.shell.get"]({}, { signal });
      signal.throwIfAborted();
      if (!result.ok && result.error.code === "unauthorized") this.#expireSession();
      else if (
        !result.ok &&
        ["unsupported-version", "api-version-mismatch", "unknown-method"].includes(
          result.error.reason ?? "",
        )
      )
        this.#socketFailed(updateRequired());
      else this.#socketFailed(new HostTransportError("unreachable"));
    } catch (error) {
      if (!signal.aborted) this.#socketFailed(error);
    } finally {
      this.#checkingHandshake = false;
    }
  }

  #resumeForeground() {
    this.#backgroundShellGeneration = undefined;
    this.#stream.setBackground(false);
  }

  async #open(attempt: ConnectionAttempt) {
    attempt.signal.throwIfAborted();
    if (this.#visibility === "foreground") this.#resumeForeground();
    await this.#prepareSocket?.();
    attempt.signal.throwIfAborted();
    // The saved state is read while the socket opens; the attach reply decides whether it is ours.
    // Storage never holds the attach: past a short wait the socket attaches without a cursor, and
    // a read that lands later is dropped.
    const restored = this.#stream.restore().catch(() => undefined);
    let socket: WebSocketClient;
    try {
      socket = this.#webSocketFactory(this.#webSocketUrl("/v1/realtime"));
    } catch {
      throw new HostTransportError("unreachable");
    }
    if (attempt.signal.aborted) {
      socket.close();
      attempt.signal.throwIfAborted();
    }
    this.#socket = socket;
    this.#lastRealtimeFrameAt = Date.now();
    const liveness = this.#realtimeLiveness;
    this.#attachDeadline = setTimeout(
      () => {
        if (this.#socket === socket)
          this.#socketFailed(new HostTransportError("timed-out"), "Realtime channel silent");
      },
      liveness ? Math.min(15_000, liveness.idleMs + liveness.deadlineMs) : 15_000,
    );
    socket.addEventListener("open", () => {
      let waited: ReturnType<typeof setTimeout> | undefined;
      const ready = new Promise<void>((resolve) => {
        waited = setTimeout(resolve, savedStartWaitMs);
        void restored.then(resolve);
      });
      void ready.then(() => {
        clearTimeout(waited);
        if (this.#socket !== socket) return;
        try {
          this.#stream.attach((message) => socket.send(JSON.stringify(message)));
        } catch {
          this.#socketFailed();
        }
      });
    });
    socket.addEventListener("message", ({ data }) => {
      if (this.#socket !== socket || typeof data !== "string") return;
      if (this.#realtimeLiveness) this.#lastRealtimeFrameAt = Date.now();
      const wireBytes = utf8ByteLength(data);
      if (wireBytes > personalDetailFrameMaxBytes) {
        this.#frameRejected("frame", wireBytes);
        this.#socketFailed(
          new HostTransportError("unreachable", {
            reason: "unreadable-frame",
            kind: "protocol",
            provenance: "protocol",
          }),
          "Invalid Host protocol frame",
        );
        return;
      }
      let parsed = false;
      try {
        const message: unknown = JSON.parse(data);
        parsed = true;
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
        this.#socketFailed(
          new HostTransportError("unreachable", {
            reason: "unreadable-frame",
            kind: "protocol",
            provenance: "protocol",
          }),
          "Invalid Host protocol frame",
        );
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
            this.#stream.clear(true);
            this.#forgetViewer({ connection: "connecting" });
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
        if (event.code === unsupportedVersionCloseCode) this.#socketFailed(updateRequired());
        else if (!this.#stream.ready) void this.#diagnoseHandshake(attempt.signal);
        else this.#socketFailed();
      }
    });
    socket.addEventListener("error", () => {
      if (this.#socket !== socket) return;
      if (this.#stream.ready) this.#socketFailed();
      else void this.#diagnoseHandshake(attempt.signal);
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

  #socketFailed(error: unknown = new HostTransportError("unreachable"), reason?: string) {
    this.#socketCloseReason = reason;
    this.#connectionFailed?.(error);
  }

  #closeSocket(reason = "Client closed") {
    this.#socketCloseReason = undefined;
    this.#probe?.abort();
    const socket = this.#socket;
    this.#socket = null;
    this.#stream.disconnect();
    this.#invalidateAttention();
    this.#resources.abort();
    this.#finishLoad();
    socket?.close(1000, reason);
  }

  #finishLoad() {
    if (this.#attachDeadline) clearTimeout(this.#attachDeadline);
    this.#attachDeadline = undefined;
    this.#resolveLoad?.();
    this.#resolveLoad = undefined;
    this.#load = undefined;
  }

  /**
   * The Host's notices are not replayed. After a gap, the one list kept current only by a notice
   * and nothing else, the apps directory (`appsRevision`: `AppsList`, `useApp`), counts as changed,
   * so each mounted reader reads once. Every other notice-fed reader already rereads on reattach on
   * its own, and is not touched here so one reattach costs one read: schedules, automations and
   * connected agents are `ClientRead`s, which reread on the connection's new ready revision; an open
   * app view re-keys on its connection; browser usage and thread automations reread with the
   * thread's new detail subscription; browser history, references and remote access on reconnect;
   * resource kinds compare revisions.
   */
  #noticesMissed() {
    this.#update({ ...this.#snapshot, appsRevision: this.#snapshot.appsRevision + 1 });
  }

  #applyNotice(message: HostToClientMessage) {
    const deploymentId = this.#snapshot.deploymentId;
    switch (message.type) {
      case "host.pong":
        if (message.nonce === this.#probe?.nonce) this.#probe.finish();
        break;
      case "host.error":
        if (!message.error.retryable && message.error.code === "forbidden") this.#expireSession();
        else {
          const { reason, ...error } = message.error;
          this.#socketFailed(
            new HostClientRequestError({
              ...error,
              ...(reason === undefined ? {} : { reason }),
              status: rpcErrorStatus(error.code),
            }),
          );
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
      case "host.apps.changed": {
        // An open app view rereads when its own app changed, as when the agent publishes it.
        const appVersions = { ...this.#snapshot.appVersions };
        for (const appId of message.appIds) appVersions[appId] = (appVersions[appId] ?? 0) + 1;
        this.#update({
          ...this.#snapshot,
          appsRevision: this.#snapshot.appsRevision + 1,
          appVersions,
        });
        break;
      }
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
        for (const listener of this.#computerViewRemovedListeners) listener(message);
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
    this.connection.invalidateScope();
    this.#closeSocket();
    this.#stream.clear(true);
    this.#forgetViewer({
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

  #update(snapshot: HostSnapshot, projectThreadState = false): void {
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
    // Fences answers asked under another scope. What is held is cleared only by `#forgetViewer`:
    // a viewer becoming known adopts what was read for it, and every other viewer has gone through
    // `#forgetViewer` before its first cut is applied.
    this.#viewer.change(scope);
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
      projectThreadState ||
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
      this.#threadState.retainLoaded(incoming);
      snapshot = withThreadState(snapshot, (thread) => ({
        ...this.#threadState.view(thread),
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
    if (this.connection) nameConnectionFromHost(this.connection, this.#snapshot);
    for (const [listener, interest] of this.#listeners) {
      const outer = this.#reading;
      this.#reading = interest;
      try {
        listener();
      } finally {
        this.#reading = outer;
      }
    }
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
    loadedResources: [],
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
    doneReason: row.doneReason,
    latestRunCompletedAt: row.latestRunCompletedAt,
    lastVisitedAt: null,
    status: row.status,
    purpose: row.purpose,
    pendingRequests: row.pendingRequestCount,
    listed: true,
    unread: false,
    inputQueuePaused: row.inputQueuePaused ?? false,
    accessMode: "approval-required",
    continuationIdentity: null,
    providerSessionId: null,
    environmentId: row.environmentId,
    harnessInstanceId: row.harnessInstanceId,
    runQueued: row.runQueued,
    agentSessionId: row.agentSessionId ?? null,
    externalWork: row.externalWork ?? null,
    ...(row.retry === undefined ? {} : { retry: row.retry }),
    modelSelection: unknownModelSelection,
    harnessLabel: "",
    modelLabel: "",
    runnerLabel: "",
    parentThreadId: null,
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
    ...(thread.startedByOther ? { startedByOther: true } : {}),
    status: thread.status,
    title: thread.title,
    icon: thread.icon ?? null,
    color: thread.color ?? null,
    unread: false,
    updatedAt: thread.updatedAt,
  };
}

/** Pages in a freshly read prefix share their continuation; newer Thread data wins duplicates. */
/** Open tasks no Run is working on: the window the shell's 25 and the refill keep full. */
function settledEntries(list: TaskListState | null) {
  return (list?.entries ?? []).filter(
    ({ thread }) => thread.status !== "running" && thread.status !== "waiting",
  );
}

/** Rows a task page asks for: the Host's page size, within its response budget. */
const taskPageSize = 50;
function isOpenTask({ thread }: TaskEntry) {
  return thread.doneAt === null && thread.status !== "archived";
}

function isActiveTask(entry: TaskEntry) {
  return (
    isOpenTask(entry) && (entry.thread.status === "running" || entry.thread.status === "waiting")
  );
}

/** Where `entry` belongs in a list sorted by task order. */
function taskIndex(list: readonly TaskEntry[], entry: TaskEntry) {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (compareTaskOrder(list[middle]!.thread, entry.thread) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

function insert(list: TaskEntry[], entry: TaskEntry) {
  list.splice(taskIndex(list, entry), 0, entry);
}

function remove(list: TaskEntry[], entry: TaskEntry) {
  const at = taskIndex(list, entry);
  if (list[at]?.thread.id === entry.thread.id) list.splice(at, 1);
}

/** How long pushes must rest before Done's count is read again for moves the client cannot see. */
const doneCountRestMs = 1_000;

interface DoneMove {
  readonly row: ReturnType<PersonalShellStore["getSnapshot"]>["taskChanges"][number];
  /** In Done before the push: unknown when this client held nothing of the task. */
  readonly was: boolean | undefined;
  readonly now: boolean;
}

/** In Done, as the Host's Done list counts it: settled with a `doneAt`, and not archived. */
function isDoneTask(task: { readonly doneAt: string | null; readonly status: string }) {
  return task.doneAt !== null && task.status !== "archived";
}

/** Done's own order, as the Host pages it: most recently done first. */
function compareDoneOrder(
  left: { readonly doneAt: string | null; readonly id: string },
  right: { readonly doneAt: string | null; readonly id: string },
) {
  return (right.doneAt ?? "").localeCompare(left.doneAt ?? "") || right.id.localeCompare(left.id);
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
    retryable: result.error.retryable,
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

function updateRequired(): HostClientRequestError {
  return new HostClientRequestError({
    code: "bad_request",
    message: "Update Opensteer to connect to this Host.",
    reason: "unsupported-version",
    retryable: false,
    status: 426,
  });
}

/** How long a command waits for a resource it needs before failing with a clear error. */
const commandResourceBoundMs = 10_000;

/** Whether a command creates a browser profile, directly or by approving a Request that asks to. */
function createsBrowserProfile(command: ClientCommandInput): boolean {
  if (command.type === "browser.profile.create") return true;
  if (command.type !== "request.respond" || command.response.kind !== "external") return false;
  const value = command.response.value as Record<string, unknown> | null | undefined;
  return value?.["decision"] === "fulfilled" && value["createProfile"] !== undefined;
}

function resourceKindsOf(field: PropertyKey): readonly PersonalResourceKind[] | undefined {
  return typeof field === "string" && Object.hasOwn(resourceBackedFields, field)
    ? resourceBackedFields[field as keyof typeof resourceBackedFields]
    : undefined;
}
