import type { MachineSummary } from "@opensteer/protocol";
import type { PersonalStreamCache, PersonalCacheScope } from "./personal-stream-cache.js";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { browserOpeningTimeoutMs } from "./browser-presentation-wait.js";
import { BrowserTabStore } from "./browser-tab-store.js";
import { familyAutomations } from "./task-family.js";
import { BrowserSnapshotDerivation, personalTabLineage } from "./browser-snapshot.js";
import { catalogModelDisplayName } from "./model-catalog.js";
import { NodeDetailStore, type NodeDetailSubscription } from "./node-detail.js";
import { executionNodeEntry } from "./subagent-model.js";
import { AppTabSchema } from "@opensteer/protocol";
import { KeyedMutationQueue } from "@opensteer/shared/mutationQueue";
import { invalidateScheduleAnchor } from "./schedule-anchor-invalidation.js";
import { BrowserCursorStore } from "./browser-cursor.js";
import type { PersonShowMessage } from "@opensteer/protocol";
import { sharedDisplayStreams } from "../integrations/phone-display-stream.js";
import { drawnTranscriptRowKeys } from "./transcript-projection.js";
import { PendingBrowserTabs } from "./pending-browser-tabs.js";
import type { BootstrapReason } from "@opensteer/shared/bootstrapDiagnostics";
import { bootstrapReadDiagnostics } from "./bootstrap-diagnostics.js";
import { BrowserPasskeys, type BrowserPasskeyPort } from "./browser-passkeys.js";
import { emptySavedViewReadiness } from "./saved-host-view.js";
import { BrowserEditingStore } from "./browser-editing.js";
import { BrowserPreferences } from "./browser-preferences.js";
import { PersonalTabActivations } from "./personal-tab-activations.js";
import { browserTabOrderTabs } from "./browser-tab-order.js";
import { BrowserTabGroupClient } from "./browser-tab-groups.js";
import type { HostCapability as AuthorityHostCapability } from "@opensteer/deployment-authority";
import type { NativeViewerSource } from "./surfaces.js";
import { BrowserHistoryClient } from "./browser-history.js";
import type { BrowserPreferencesStorage } from "./browser-preferences.js";
import { computerViewMethods } from "./computer-views.js";
import { OwnerViewRecords } from "./owner-view-records.js";
import { ViewerScope, viewerScopeOf } from "./viewer-scope.js";
import {
  DeploymentIdSchema,
  RunnerIdSchema,
  ExecutionNodeIdSchema,
  nodeDetailEventNodeId,
  type QuietTaskDays,
  AgentEventViewSchema,
  BrowserSurfaceIdSchema,
  LiveItemViewSchema,
  LiveRunProgressViewSchema,
  RunIdSchema,
  SequenceSchema,
  ThreadIdSchema,
  ThreadStatusSchema,
  ThreadTitleSchema,
  ThreadViewSchema,
  TimeZoneSchema,
  compareSequence,
  defaultTaskSymbol,
  emptyExecutionPreferences,
  eventDataSchemas,
  liveProgressMaxItems,
  liveStreamKeyId,
  liveStreamKeyOf,
  requestTitleText,
  zeroSequence,
  type AgentEventView as AgentEvent,
  type AssignmentSummary,
  type AssignmentView,
  type Attachment,
  type ExecutionPreferences,
  type NotificationView,
  type Request,
  type Sequence,
  type Thread,
  type ThreadAccessMode,
  type ThreadId,
  type ThreadInputQueue,
  type ThreadVisit,
  type WaitingRequest,
  type IconName,
} from "@opensteer/core";
import { hostApiVersion, apiVersionQueryParameter } from "@opensteer/deployment-authority";
import {
  BrowserSessionIdSchema,
  DisplaySourceSchema,
  HarnessModelSettingsMapSchema,
  HostToClientMessageSchema,
  DeploymentSnapshotSchema,
  browserUsageRunBatchSize,
  hostApi,
  realtimeEnvelopeTypes,
  threadPageMaxItems,
  deploymentSnapshotMaxThreads,
  type BrowserSessionUsageProjection,
  type DurableWindow,
  type HostApiClient,
  type HostApiCommand,
  type HostApiCommandInput,
  type HostApiCommandOutput,
  type HostToClientMessage,
  type MachineAccessPolicy,
  type RealtimeFrameDiagnostic,
  type RpcResult,
  type DeploymentSnapshot,
} from "@opensteer/protocol";
import { z } from "zod";
import { BrowserWatchStore, browserCommandNeedsNoView } from "./browser-watch.js";
import type {
  BrowserCommand,
  BrowserFrameStore,
  BrowserPlacementSummary,
  BrowserSessionSummary,
  BrowserStartIdentity,
  BrowserInventory,
  BrowserTabOpenInput,
  BrowserTabOpenOptions,
  CreateThreadInput,
  EnvironmentSummary,
  HarnessSummary,
  HostConnectionState,
  HostSnapshot,
  MachineAccessHistoryPage,
  MachineAccessUpdateOutcome,
  HostClient as OwnerViewHostClient,
  TaskListState,
  ThreadSummary,
  TranscriptEntry,
  PersonalTabActivationOptions,
  PersonalTabLineage,
} from "./client.js";
import { HostClientRequestError, isHostRefusal, mainDoneTasks } from "./client.js";
import { browserProfileHomeCommand } from "./browser-access.js";
import type { ExecutionChoice, ExecutionSelection } from "./execution-preferences.js";
import { createHttpHostApiClient } from "./host-api-client.js";
import { threadInDirectory } from "./host-snapshot-selectors.js";
import { RunPlaceStore } from "./run-place.js";
import {
  realtimeIdleProbeDeadlineMs,
  realtimeIdleProbeMs,
  connectionInterruptionHoldMs,
  socketProbeDeadlineMs,
  socketTrustWindowMs,
  type ClientLifecycle,
  type ClientNetworkPath,
  type ClientNetworkState,
  type ClientVisibility,
} from "./lifecycle.js";
import { LiveStreamLedger, type LiveProgressInput } from "./live-progress.js";
import { applyOptimisticCommandPatch, withThreadNames } from "./optimistic-command-patches.js";
import { PlaceActivityStore } from "./place-activity.js";
import { placeByKey } from "./places.js";
import { reconcileBrowserLastPictures } from "./browser-last-picture.js";
import { isActiveRunStatus, RunQueueProjection, toRunQueueEntry } from "./run-queue-state.js";
import { mergeTaskEntries } from "./task-entries.js";
import { threadStopTarget } from "./thread-activity.js";
import { isThreadUnread } from "./thread-unread.js";
import { ThreadStateProjection } from "./thread-state.js";
import {
  drawnLiveStream,
  foldLiveRun,
  foldTranscriptEvent,
  mergeTranscriptSegments,
  toMessageEntry,
  toTranscriptEntry,
  upsertEntry,
  withoutClosedLiveStreams,
} from "./transcript.js";
import {
  describeRealtimeFrameFailure,
  maxInboundFrameCharacters,
  realtimeEnvelopeType,
  realtimeFrameLoss,
} from "./realtime-frames.js";

type HostCapability = AuthorityHostCapability | "node-detail-v1";

const defaultRefreshIntervalMs = 15_000;
const historyPageTurns = 10;
const historyScanMaxPages = 20;
const historyScanMaxBytes = 2 * 1024 * 1024;
const defaultReconnectBaseDelayMs = 300;
/** How long a missed live frame waits before its Thread's streams are reread. */
const liveRefreshDelayMs = 250;

const maxHeldLiveFrames = 256;

const realtimeEventsSchema = z.object({
  events: z.array(z.unknown()).max(2_000),
});
const realtimeEventPositionSchema = z.object({
  sequence: SequenceSchema,
});
const realtimeLiveEnvelopeSchema = z.object({
  afterSequence: SequenceSchema,
  progress: LiveRunProgressViewSchema.extend({
    items: z.array(z.unknown()).min(1).max(liveProgressMaxItems),
  }),
});
const realtimeLiveKindSchema = z.object({
  stream: z.enum(["assistant", "reasoning", "tool", "node"]),
  op: z.enum(["append", "replace"]),
});
type RealtimeEvent = AgentEvent | (z.infer<typeof realtimeEventPositionSchema> & { type: null });

const realtimeHeaderSchema = z.object({ type: z.string().min(1) });
const realtimeEventTypes = new Set<string>(
  AgentEventViewSchema.options.map((schema) => schema.shape.type.value),
);
const realtimeSnapshotFrameSchema = z.object({
  snapshot: z.looseObject({ threads: z.array(z.unknown()).max(deploymentSnapshotMaxThreads) }),
});
const realtimeThreadStateEventSchema = AgentEventViewSchema.options[0]
  .omit({ type: true, data: true })
  .extend({
    type: z.literal("thread.state-changed"),
    data: z.object({
      ...eventDataSchemas["thread.state-changed"].shape,
      status: z.string().min(1),
    }),
  });
const realtimeThreadEventSchema = AgentEventViewSchema.options[0]
  .omit({ type: true, data: true })
  .extend({
    type: z.enum(["thread.created", "thread.execution-updated", "thread.listed"]),
    data: z.object({
      thread: ThreadViewSchema.extend({ status: z.string().min(1) }),
    }),
  });
const realtimeResyncSchema = z.object({
  type: z.literal("host.resync-required"),
  // The reason explains the reset; every present or future reason requires it.
  reason: z.string().min(1),
});
type RealtimeMessage =
  | Exclude<HostToClientMessage, { type: "host.events" | "host.resync-required" }>
  | { type: "host.events"; events: RealtimeEvent[]; throughSequence: Sequence }
  | z.infer<typeof realtimeResyncSchema>;

const defaultReconnectMaxDelayMs = 12_000;
/** Times a channel fails at one position before it starts over from a snapshot. */
const realtimeReplayAttempts = 3;
/** Each try can cost a whole snapshot over cellular, so a frame that keeps failing waits longest. */
const unreadableFrameMaxDelayMs = 5 * 60_000;
/** Notification ids remembered after delivery, enough to cover every socket's copy. */
const rememberedNotificationIds = 256;

/**
 * The events after which a loaded queue is read again: a message may have
 * joined it, an input may have left it, and a Run starting or ending changes
 * which Run, if any, a queued message could be steered into.
 */
const inputQueueEventTypes: ReadonlySet<AgentEvent["type"]> = new Set<AgentEvent["type"]>([
  "message.created",
  "run.completed",
  "run.failed",
  "run.interrupted",
  "run.queued",
  "run.started",
  "run.status",
  "thread-input.updated",
  "thread.input-queue-updated",
]);

/**
 * The refusals that settle a steer or cancel: the Host looked and would not,
 * so nothing was recorded and the next attempt is a new one. Anything else, a
 * timeout, an unreachable Runner, a transport failure, leaves open whether
 * the mutation landed.
 */
const settledInputMutationCodes: ReadonlySet<string> = new Set([
  "bad_request",
  "canonical_surface_required",
  "conflict",
  "forbidden",
  "not_found",
  "unauthorized",
]);

function isSettledInputMutationError(error: unknown): boolean {
  return error instanceof HostClientRequestError && settledInputMutationCodes.has(error.code);
}

function showsSubscriptionProgress(message: RealtimeMessage, channel: DeploymentChannel): boolean {
  switch (message.type) {
    case "host.snapshot":
    case "host.events":
    case "host.live":
    case "host.synchronized":
    case "host.thread-visits":
      return true;
    case "host.pong":
      return message.nonce === channel.probeNonce;
    default:
      return false;
  }
}

/**
 * A send the Host held rather than ran is a queue item from the moment it is
 * acknowledged. The reader sent it, so they may take it back or move it; whether they
 * may steer it is the queue's word on the Run it would be promoted into.
 */
function queuedInputItem(
  result: Extract<HostApiCommandOutput, { readonly type: "thread.sendMessage" }>,
  queue: ThreadInputQueue | undefined,
): ThreadInputQueue["items"][number] | null {
  if (!queue || result.run !== null) return null;
  if (result.input.policy !== "queue" || result.input.state !== "pending") return null;
  return {
    canCancel: true,
    canMove: true,
    canSteer: queue.steerRunId !== null && !result.input.freshContext,
    input: result.input,
    message: result.message,
  };
}

function commandIs<Type extends HostApiCommand["type"]>(
  command: HostApiCommand,
  type: Type,
): command is Extract<HostApiCommand, { readonly type: Type }> {
  return command.type === type;
}

const HarnessRecordSchema = z.strictObject({
  modelSettings: HarnessModelSettingsMapSchema.optional(),
  config: z.unknown(),
  driverKind: z.string().min(1),
  enabled: z.boolean(),
  environmentId: z.string().min(1),
  id: z.string().min(1),
  isDefault: z.boolean(),
  name: z.string().trim().min(1).max(120),
  runtimeRevision: z.number().int().positive(),
  sourceId: z.string().min(1).max(100),
  stateKind: z.enum(["ambient", "isolated"]),
});
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

interface DeploymentChannel {
  refused: boolean;
  cursor: Sequence;
  /** The nonce of the liveness probe this channel is waiting on, if any. */
  probeFollowsNetwork: boolean;
  probeNonce: string | null;
  probeTimer: Timer | null;
  /** When the current socket last showed its subscription delivering. */
  progressAt: number;
  reconnectAttempt: number;
  reconnectTimer: Timer | null;
  socket: WebSocketClient | null;
  synchronized: boolean;
  /** Replay and sync frames this client could not read since it last synchronized. */
  unreadableFrames: number;
  /** While frames are unreadable, when the next attempt may start. */
  unreadableRetryAt: number;
  deploymentId: string;
}

/** Whom a realtime socket was opened for. */
interface SocketViewer {
  readonly deploymentId: string | null;
  readonly userId: string | null;
}

interface LiveReread {
  /**
   * Something the read may predate happened after it was asked: a frame went
   * missing, or the connection started over. Its answer is owed one more read.
   */
  again: boolean;
  /** Waiting out the debounce; null once the read is asked. */
  timer: Timer | null;
}

/** The connection owner keeps discovery evidence within its attachment fence. */
export type HostCapabilityReader = (options?: {
  readonly revalidate: boolean;
}) => Promise<readonly HostCapability[]>;

export interface HttpHostClientOptions {
  readonly streamCache?: PersonalStreamCache;
  readonly passkeys?: BrowserPasskeyPort;
  /** The viewer's command platform for exact baseline shortcut projection. */
  readonly viewerPlatform?: "mac" | "pc";
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

  readonly realtimeLiveness?: { readonly idleMs: number; readonly deadlineMs: number };
  readonly reconnectBaseDelayMs?: number;
  readonly reconnectMaxDelayMs?: number;
  readonly refreshIntervalMs?: number;
  /** Where a platform keeps a record of realtime frames this client could not read. */
  readonly reportRealtimeFrame?: (record: RealtimeFrameDiagnostic) => void;

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
  readonly openComputerView: OwnerViewHostClient["openComputerView"];
  readonly closeComputerView: OwnerViewHostClient["closeComputerView"];
  readonly renewComputerView: OwnerViewHostClient["renewComputerView"];
  readonly listComputerAppWindows: OwnerViewHostClient["listComputerAppWindows"];
  readonly listApprovedComputerApps: OwnerViewHostClient["listApprovedComputerApps"];
  readonly rpc: HostApiClient;
  readonly #baseUrl: URL;
  readonly #streamCache: PersonalStreamCache | undefined;
  #checkpointWrite: Promise<void> = Promise.resolve();
  #cacheLoaded = false;
  #applyingSnapshot = false;
  #restoredCursor: Sequence | null = null;
  readonly #channels = new Map<string, DeploymentChannel>();
  readonly #fetch: Fetch;
  readonly #listeners = new Set<() => void>();
  readonly #messagePageLoads = new Map<string, { promise: Promise<void>; retired: boolean }>();
  /**
   * Threads whose assignments were asked for, answered or not. A failed read
   * is not retried per event batch; an explicit refresh or a resync asks again.
   */
  readonly #assignmentReads = new Map<string, "read" | "reading">();
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
  #browserCarrier: DeploymentChannel | null = null;
  #browserContinuation: string | undefined;
  readonly #browserWaiters = new Set<() => void>();
  readonly #browserTabs = new BrowserTabStore(
    (groupId) => this.#resyncBrowser(groupId),
    (sessionId, tabId) =>
      this.#targetedControl.surface(sessionId, tabId) ??
      this.#targetedWatch.surface(sessionId, tabId),
  );
  readonly browserTabs = this.#browserTabs;
  #browserStructure: ReturnType<BrowserTabStore["structure"]> = [];
  #browserTargetRevision = -1;
  #browserTabIds = new Map<string, readonly string[]>();
  browserViewerSurface(sessionId: string, surfaceId: string) {
    return (
      this.#targetedControl.surface(sessionId, surfaceId) ??
      this.#targetedWatch.surface(sessionId, surfaceId)
    );
  }
  readonly #browserSnapshot = new BrowserSnapshotDerivation();
  readonly #placeActivity = new PlaceActivityStore();
  readonly #runPlaces = new RunPlaceStore();
  readonly #targetedControl = new BrowserWatchStore(
    (sessionId, surfaceId) => this.#targetedBrowserSocket(sessionId, surfaceId, "control"),
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
    (attempt, unreadableFrames) => this.#retryDelay(attempt, unreadableFrames),
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
    (attempt, unreadableFrames) => this.#retryDelay(attempt, unreadableFrames),
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
  ): WebSocketClient {
    const groupId = this.#browserTabs.groupForSession(sessionId);
    const group = groupId ? this.#browserTabs.group(groupId) : undefined;
    const tab = groupId ? this.#browserTabs.tab(groupId, surfaceId) : undefined;
    if (
      this.#disposed ||
      this.#snapshot.session !== "authenticated" ||
      group?.state !== "ready" ||
      tab?.availability !== "ready" ||
      tab.state !== "live" ||
      tab.documentId === null
    )
      throw new Error("The browser target is unavailable.");
    const url = new URL(
      this.#webSocketUrl(`/v1/browser-sessions/${encodeURIComponent(sessionId)}/connect`),
    );
    if (mode === "watch") url.searchParams.set("mode", mode);
    const passkeys = this.browserPasskeys.optIn(
      this.#capabilities?.filter((capability) => capability !== "node-detail-v1"),
    );
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
  readonly #pendingBrowserTabs = new PendingBrowserTabs({
    admitted: () => viewerScopeOf(this.#snapshot) !== null,
    open: (target, options) => this.#openBrowserTab(target, options),
    close: (result) =>
      this.closeBrowserTab(
        result.sessionId,
        result.tabId,
        this.browserTabs.inventory(result.sessionId) ?? { generation: 0, revision: 0 },
      ),
    changed: (pendingBrowserTabs) => this.#update({ ...this.#snapshot, pendingBrowserTabs }),
  });
  readonly beginBrowserTabOpen: OwnerViewHostClient["beginBrowserTabOpen"] = (target, options) => {
    if (typeof target !== "string" && "identity" in target)
      this.browserPreferences.lastBrowsingChoice = target.identity;
    return this.#pendingBrowserTabs.begin(target, options);
  };
  readonly browserPresentationDeadline = this.#pendingBrowserTabs.presentationDeadline;
  readonly markBrowserPagePresented = this.#pendingBrowserTabs.markPresented;
  readonly dismissPendingBrowserTab = this.#pendingBrowserTabs.dismiss;
  async openBrowserTab(target: string | BrowserTabOpenInput, options: BrowserTabOpenOptions = {}) {
    if (!viewerScopeOf(this.#snapshot))
      return this.#openBrowserTab(
        typeof target === "string" ? { sessionId: target } : target,
        options,
      );
    return this.beginBrowserTabOpen(target, options).result;
  }
  async #openBrowserTab(target: BrowserTabOpenInput, options: BrowserTabOpenOptions) {
    const started = this.#viewer.generation;
    const result = unwrapRpcResult(
      await this.rpc["commands.dispatch"](
        {
          type: "browser.tab.open",
          ...(typeof target === "string" ? { sessionId: target } : target),
          ...(options.url === undefined ? {} : { url: options.url }),
          ...(options.typed === undefined ? {} : { typed: options.typed }),
          ...(options.viewport ? { viewport: options.viewport } : {}),
          idempotencyKey: options.idempotencyKey ?? mutationIdempotencyKey("open-tab"),
        },
        options.signal ? { signal: options.signal } : undefined,
      ),
    );
    if (started !== this.#viewer.generation)
      throw new HostClientRequestError({
        code: "unauthorized",
        status: 401,
        message: "The signed-in account changed while the browser was opening.",
      });
    if (result.type !== "browser.tab.open") throw new Error("Unexpected browser command result.");
    if (this.#snapshot.session === "authenticated")
      await this.#waitBrowser(() => {
        const groupId = result.groupId ?? this.#browserTabs.groupForSession(result.sessionId);
        return groupId && this.#browserTabs.tab(groupId, result.tabId);
      }, options.signal);
    return result;
  }
  async readPersonalTabs(sessionId: string): Promise<PersonalTabLineage | null> {
    await this.#waitBrowser(() => {
      const groupId =
        this.#browserTabs.group(sessionId)?.id ?? this.#browserTabs.groupForSession(sessionId);
      return groupId ? this.#browserTabs.tabs(groupId).whole : this.#browserTabs.groups().whole;
    });
    const groupId =
      this.#browserTabs.group(sessionId)?.id ?? this.#browserTabs.groupForSession(sessionId);
    return groupId ? personalTabLineage(this.#browserTabs, groupId) : null;
  }

  readonly #personalTabActivations: PersonalTabActivations;
  activatePersonalTab(tabId: string, options?: PersonalTabActivationOptions) {
    return this.#personalTabActivations.activate(tabId, options);
  }

  async reopenPersonalTab() {
    if (!this.#snapshot.tabReopenAvailable) throw new Error("This Host cannot reopen closed tabs.");
    const viewer = this.#viewer.generation;
    const result = unwrapRpcResult(
      await this.rpc["commands.dispatch"]({
        type: "tab.reopen",
        idempotencyKey: mutationIdempotencyKey("reopen-tab"),
      }),
    );
    if (viewer !== this.#viewer.generation)
      throw new Error("The signed-in account changed while reopening the tab.");
    if (result.type !== "tab.reopen") throw new Error("Unexpected tab reopen result.");
    this.#update({ ...this.#snapshot, browserTabGroups: this.#tabGroups.receive(result.layout) });
    await this.#waitBrowser(() => this.#browserTabs.tab(result.groupId!, result.tabId));
    return result;
  }
  readonly #tabGroups: BrowserTabGroupClient;
  readonly groupBrowserTabs: OwnerViewHostClient["groupBrowserTabs"] = (ids, target) =>
    this.#tabGroups.groupBrowserTabs(ids, target);
  readonly moveBrowserTabs: OwnerViewHostClient["moveBrowserTabs"] = (move) =>
    this.#tabGroups.moveBrowserTabs(move);
  readonly ungroupBrowserTabs: OwnerViewHostClient["ungroupBrowserTabs"] = (ids) =>
    this.#tabGroups.ungroupBrowserTabs(ids);
  readonly updateBrowserTabGroup: OwnerViewHostClient["updateBrowserTabGroup"] = (id, update) =>
    this.#tabGroups.updateBrowserTabGroup(id, update);
  readonly closePersonalTabs: OwnerViewHostClient["closePersonalTabs"] = async (tabIds) => {
    const viewer = this.#viewer.generation;
    const result = unwrapRpcResult(
      await this.rpc["commands.dispatch"]({
        type: "tabs.close",
        tabIds: tabIds.map((id) => BrowserSurfaceIdSchema.parse(id)),
        idempotencyKey: mutationIdempotencyKey("close-tabs"),
      }),
    );
    if (viewer !== this.#viewer.generation)
      throw new Error("The signed-in account changed while closing tabs.");
    if (result.type !== "tabs.close") throw new Error("Unexpected tabs close result.");
    this.#tabGroups.removeClosed(result.closed);
    return result;
  };
  async closeBrowserTab(sessionId: string, surfaceId: string, expected: BrowserInventory) {
    const viewer = this.#viewer.generation;
    const groupId = this.#browserTabs.groupForSession(sessionId);
    const tab = groupId ? this.#browserTabs.tab(groupId, surfaceId) : undefined;
    if (tab?.documentId === null) {
      const result = unwrapRpcResult(
        await this.rpc["commands.dispatch"]({
          type: "tab.close",
          tabId: surfaceId,
          idempotencyKey: `close:${surfaceId}`,
        }),
      );
      if (viewer !== this.#viewer.generation)
        throw new Error("The signed-in account changed while closing the tab.");
      if (result.type !== "tab.close") throw new Error("Unexpected tab close result.");
      return {
        type: "browser.tab.close" as const,
        sessionId: BrowserSessionIdSchema.parse(sessionId),
        outcome: "tab-closed" as const,
      };
    }
    const inventoryRevision = expected.inventoryRevision ?? expected.revision;
    const result = unwrapRpcResult(
      await this.rpc["commands.dispatch"]({
        type: "browser.tab.close",
        sessionId,
        surfaceId,
        inventoryRevision,
        idempotencyKey: `close-tab:${sessionId}:${surfaceId}:${inventoryRevision}`,
      }),
    );
    if (viewer !== this.#viewer.generation)
      throw new HostClientRequestError({
        code: "unauthorized",
        status: 401,
        message: "The signed-in account changed while closing the tab.",
      });
    if (result.type !== "browser.tab.close") throw new Error("Unexpected browser command result.");
    return result;
  }
  async readBrowserTabIcon(sessionId: string, iconRef: string): Promise<string | null> {
    return unwrapRpcResult(await this.rpc["browser.tabIcon.get"]({ sessionId, iconRef })).favicon;
  }
  /** Holds on Threads observed beside the active one, counted per Thread. */
  readonly #observedThreads = new Map<string, number>();
  readonly #requestLoads = new Map<string, Promise<void>>();
  /** The Host's pending count each Thread's last Request read was asked under. */
  readonly #requestReads = new Map<string, number>();
  readonly #threadHydrations = new Map<string, Promise<void>>();
  /** The newest snapshot a history read must cover before it can be installed. */
  readonly #invalidatedHydrations = new Map<string, Sequence>();
  readonly #threadInputQueueLoads = new Map<string, Promise<ThreadInputQueue>>();
  /** Threads whose queue an event touched while a read of it was in flight. */
  readonly #threadInputQueueRereads = new Set<string>();
  /**
   * One key per steer or cancel attempt, held until the Host answers it, so a
   * retry after a lost answer repeats the mutation instead of adding one.
   */
  readonly #threadInputMutationKeys = new Map<string, string>();

  readonly #hydratedThreads = new Map<string, Sequence>();
  readonly #historicalThreads = new Set<string>();

  /**
   * Assignments the Host refused this viewer (403 or 404). Nothing held for
   * them is shown, and no later event, page or read brings them back.
   */
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
  #reportedTimeZone: string | null = null;
  readonly #hydrationBuffers = new Map<string, AgentEvent[]>();
  readonly #threadState = new ThreadStateProjection();
  readonly #threadRenames = new Map<string, { readonly title: string; readonly token: symbol }>();
  readonly #threadIcons = new Map<string, { readonly icon: IconName; readonly token: symbol }>();

  /** The authority for `snapshot.runQueue`, reconciled across events, reads and answers. */
  readonly #runQueue = new RunQueueProjection();
  readonly #nodeDetails = new NodeDetailStore({
    available: () => this.#capabilities?.includes("node-detail-v1") === true,
    nodes: (threadId) =>
      (this.#snapshot.transcripts[threadId] ?? []).filter((entry) => entry.kind === "node"),
    readNodes: (runId) => this.#readRunNodes(runId),
    read: async (input) => {
      const page = unwrapRpcResult(
        await this.rpc["node.events.list"]({
          ...(this.#capabilities?.includes("tool-output-detail-v1")
            ? { toolOutputs: "preview" as const }
            : {}),
          ...input,
          nodeId: ExecutionNodeIdSchema.parse(input.nodeId),
        }),
      );
      if (page.threadId !== input.threadId || page.nodeId !== input.nodeId)
        throw new Error("Node event page mismatch.");
      return page;
    },
    sendWatch: (deploymentId, nodeId) => {
      const channel = this.#channels.get(deploymentId);
      if (!channel?.synchronized || channel.socket?.readyState !== 1) return false;
      try {
        channel.socket.send(JSON.stringify({ type: "client.watch-node", nodeId }));
        return true;
      } catch {
        return false;
      }
    },
  });
  /** What each active Run is streaming, the authority for every live entry drawn. */
  readonly #live = new LiveStreamLedger();
  /** Threads whose streams are reread whole, one read at a time per Thread. */
  readonly #liveRereads = new Map<string, LiveReread>();

  readonly #heldLive = new Map<string, LiveProgressInput[]>();

  readonly #liveGenerations = new Map<string, number>();
  readonly #latestTranscriptLoads = new Map<string, Promise<void>>();
  #activeThreadId: string | null = null;
  #hostUnreachable = false;
  #interruptionTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #random: () => number;
  readonly #livenessIdleMs: number;
  readonly #livenessDeadlineMs: number;
  #livenessTimer: Timer | null = null;
  readonly #reconnectBaseDelayMs: number;
  readonly #reconnectMaxDelayMs: number;
  readonly #reportRealtimeFrame: ((record: RealtimeFrameDiagnostic) => void) | undefined;
  #lostFrameRereadAt = Number.NEGATIVE_INFINITY;
  #lostFrameRereadTimer: Timer | null = null;
  readonly #refreshIntervalMs: number;

  readonly #webSocketFactory: (url: string) => WebSocketClient;
  readonly #lifecycleDisposers: (() => void)[] = [];
  readonly #socketTrustWindowMs: number;
  #network: ClientNetworkState;
  #visibility: ClientVisibility;
  #backgroundedAt: number | null = null;

  #bootstrapPromise: Promise<void> | null = null;
  #rereadPending: BootstrapReason | null = null;
  #waitingRead: "again" | "idle" | "reading" = "idle";

  readonly #taskReads = new Map<string | null, { again: boolean; done: Promise<void> }>();
  /** Per task list, the one read of a later page in flight, for the viewer that asked. */
  readonly #taskPageLoads = new Map<
    string | null,
    { readonly generation: number; readonly promise: Promise<void> }
  >();

  #disposed = false;
  #refreshTimer: Timer | null = null;

  #snapshot: HostSnapshot = emptySnapshot();

  readonly #viewerPlatform: "mac" | "pc" | null;
  constructor(options: HttpHostClientOptions) {
    this.#streamCache = options.streamCache;
    this.browserPasskeys = new BrowserPasskeys(options.passkeys);
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
    this.#browserTabs.subscribe(() => {
      if (!this.#applyingSnapshot) this.#update(this.#snapshot);
    });
    this.#baseUrl = new URL(options.baseUrl);
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.rpc = createHttpHostApiClient({
      baseUrl: this.#baseUrl,
      fetch: this.#fetch,
      ...(options.bufferedResponses === undefined
        ? {}
        : { bufferedResponses: options.bufferedResponses }),
      onAuthenticationRequired: () => {
        this.#expireSession();
        this.#reverifyCapabilities();
      },
      onVersionMismatch: () => this.#reverifyCapabilities(),
    });
    this.#personalTabActivations = new PersonalTabActivations({
      snapshot: () => this.#snapshot,
      subscribe: (listener) => this.subscribe(listener),
      changed: () => this.#update(this.#snapshot),
      dispatch: async (tabId) => {
        const result = unwrapRpcResult(
          await this.rpc["commands.dispatch"]({
            type: "tab.activate",
            tabId,
            idempotencyKey: `restore:${tabId}`,
          }),
        );
        if (result.type !== "tab.activate") throw new Error("Unexpected tab activation result.");
        return result;
      },
      resolved: (result) => {
        const groupId =
          result.groupId ??
          this.#browserTabs.groupForSession(result.sessionId ?? result.session.id);
        const row = groupId ? this.#browserTabs.tab(groupId, result.tabId) : undefined;
        return row?.documentId !== null && row?.state === "live";
      },
    });
    this.#tabGroups = new BrowserTabGroupClient(
      this.rpc,
      (browserTabGroups) => this.#update({ ...this.#snapshot, browserTabGroups }),
      () => this.#viewer.generation,
      () => browserTabOrderTabs(this.browserTabs),
    );
    this.#random = options.random ?? Math.random;
    this.#livenessIdleMs = Math.max(1, options.realtimeLiveness?.idleMs ?? realtimeIdleProbeMs);
    this.#livenessDeadlineMs = Math.max(
      1,
      options.realtimeLiveness?.deadlineMs ?? realtimeIdleProbeDeadlineMs,
    );
    this.#reconnectBaseDelayMs = Math.max(
      0,
      options.reconnectBaseDelayMs ?? defaultReconnectBaseDelayMs,
    );
    this.#reconnectMaxDelayMs = Math.max(
      this.#reconnectBaseDelayMs,
      options.reconnectMaxDelayMs ?? defaultReconnectMaxDelayMs,
    );
    this.#refreshIntervalMs = Math.max(0, options.refreshIntervalMs ?? defaultRefreshIntervalMs);
    this.#reportRealtimeFrame = options.reportRealtimeFrame;
    this.#webSocketFactory = options.webSocketFactory ?? ((url) => new globalThis.WebSocket(url));
    this.#socketTrustWindowMs = options.lifecycle?.socketTrustWindowMs ?? socketTrustWindowMs;
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
      tabReopenAvailable: this.#capabilities?.includes("tab-reopen-v1") === true,
      browserProfileManageAvailable:
        this.#capabilities?.includes("browser-profile-manage-v1") === true,
      searchSuggestionsAvailable:
        this.#capabilities?.includes("browser-search-suggestions-v1") === true,
      iphoneAppsAvailable: this.#capabilities?.includes("iphone-apps-v1") === true,
      voiceAvailable: this.#capabilities?.includes("voice-run-v1") === true,

      ownerViewWindowsAvailable: this.#capabilities?.includes("ownerViewWindows") === true,
    };
    this.#visibility = lifecycle?.visibility ?? "foreground";
    if (this.#visibility === "background") this.#backgroundedAt = Date.now();
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
    this.openComputerView = async (...args) => {
      const view = await views.openComputerView(...args);
      if (view.target.kind === "phone" && view.state === "ready" && args[2]?.wake !== false)
        sharedDisplayStreams(this).armAutoWake({
          kind: "owner-view",
          viewId: view.viewId,
          generation: view.generation,
        });
      return view;
    };
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

  async closePhoneTab(machineId: string): Promise<void> {
    await this.dispatch({
      type: "phone.tab.close",
      machineId: RunnerIdSchema.parse(machineId),
      idempotencyKey: crypto.randomUUID(),
    });
    this.#update({
      ...this.#snapshot,
      machines: this.#snapshot.machines.map((machine) =>
        machine.id === machineId ? { ...machine, tabOpenedAt: null } : machine,
      ),
    });
  }

  async dispatch(command: HostApiCommandInput): Promise<HostApiCommandOutput> {
    const parsedCommand = hostApi["commands.dispatch"].payload.parse(
      browserProfileHomeCommand(command, this.#snapshot.browserProfileHomes),
    );
    if (parsedCommand.type === "thread.icon.set") {
      if (!this.#snapshot.taskMarksAvailable)
        throw new Error("This Host does not support task marks.");
      return this.#setThreadIcon(parsedCommand);
    }
    return this.#dispatchCommand(parsedCommand);
  }

  async #dispatchCommand(parsedCommand: HostApiCommand): Promise<HostApiCommandOutput> {
    // Installation and server selection advance an integration access Request
    // without resolving it. Capture that fact before dispatch so an earlier
    // request.updated event cannot make the HTTP acknowledgement erase the
    // still-pending card when it arrives later.
    const preservesIntegrationAccessRequest =
      parsedCommand.type === "request.respond" &&
      parsedCommand.response.kind === "choice" &&
      (parsedCommand.response.optionId === "installed" ||
        parsedCommand.response.optionId.startsWith("server:")) &&
      Object.values(this.#snapshot.requests)
        .flat()
        .some(
          (request) =>
            request.id === parsedCommand.requestId &&
            request.kind === "integration.access" &&
            request.status === "pending",
        );
    const result = await this.#dispatch(parsedCommand);
    switch (result.type) {
      case "assignment.cancel":
        this.#update({
          ...this.#snapshot,
          assignments: mergeAssignments(this.#snapshot.assignments, [result.assignment]),
        });
        break;
      case "browser.session.start":
        await this.#waitBrowser(() => this.#browserTabs.groupForSession(result.session.id));
        break;
      case "browser.profile.create":
        this.#update(
          applyOptimisticCommandPatch(this.#snapshot, {
            profile: result.profile,
            type: result.type,
          }),
        );
        break;
      case "browser.profile.rename":
        this.#update(
          applyOptimisticCommandPatch(this.#snapshot, {
            profile: result.profile,
            type: result.type,
          }),
        );
        break;
      case "browser.profile.delete":
        if (commandIs(parsedCommand, result.type)) {
          this.browserHistory.drop(parsedCommand.profileId);
          this.#update(
            applyOptimisticCommandPatch(this.#snapshot, {
              profileId: parsedCommand.profileId,
              deletion:
                result.deletion && result.deletion.state !== "deleted"
                  ? { ...result.deletion, state: result.deletion.state }
                  : undefined,
              type: result.type,
            }),
          );
        }
        break;
      case "automaticModels.set":
      case "harness.model.configure":
      case "harness.create":
        // The Host reports a new harness only through bootstrap, so without
        // this the AI engine stays invisible until the next refresh tick.
        await this.refresh();
        break;
      case "harness.rename":
      case "harness.default.set":
        this.#update(
          applyOptimisticCommandPatch(this.#snapshot, {
            harness: harnessSummary(HarnessRecordSchema.parse(result.harness)),
            type: result.type,
          }),
        );
        break;
      case "harness.enabled.set":
        this.#update(
          applyOptimisticCommandPatch(this.#snapshot, {
            harness: harnessSummary(HarnessRecordSchema.parse(result.harness)),
            type: result.type,
          }),
        );
        // Enabling or disabling can move the default to a sibling, which is
        // not included in this command result.
        await this.refresh();
        break;
      case "harness.delete":
        if (commandIs(parsedCommand, result.type)) {
          this.#update(
            applyOptimisticCommandPatch(this.#snapshot, {
              harnessInstanceId: parsedCommand.harnessInstanceId,
              type: result.type,
            }),
          );
          // Deleting the default can promote the oldest enabled sibling.
          await this.refresh();
        }
        break;
      case "thread.create":
      case "thread.rename":
      case "thread.icon.set":
      case "thread.execution.update":
      case "thread.access.update":
      case "thread.inputQueue.resume": {
        const generation = this.#viewerGeneration;
        const userId = this.#snapshot.user?.id;
        let source = { thread: result.thread, asOfSequence: result.asOfSequence };
        for (
          let attempt = 0;
          attempt < 3 && this.#threadState.needsRead(source.thread, source.asOfSequence);
          attempt += 1
        ) {
          const page = await this.#readThreadHistory(source.thread.id);
          if (!this.#viewerStillCurrent(generation, userId)) return result;
          if (compareSequence(page.asOfSequence, source.asOfSequence) >= 0)
            source = { thread: page.thread, asOfSequence: page.asOfSequence };
        }
        this.#update(
          applyOptimisticCommandPatch(this.#snapshot, {
            thread: this.#threadState.reconcile(
              toThreadSummary(source.thread, this.#snapshot.environments, this.#snapshot.harnesses),
              source.asOfSequence,
              this.#snapshot.threads.find(({ id }) => id === result.thread.id),
            ),
            type: result.type,
          }),
        );
        break;
      }
      case "thread.sendMessage":
        if (commandIs(parsedCommand, result.type)) {
          const queueItem = queuedInputItem(
            result,
            this.#snapshot.inputQueues[parsedCommand.threadId],
          );
          const run = result.run ? toRunQueueEntry(result.run) : null;
          const deploymentId = this.#threadDeployment.get(parsedCommand.threadId);
          // The answer may arrive after the Run's own events; it never takes
          // back what they said, including that the Run already ended.
          const admitted =
            run !== null && deploymentId !== undefined && this.#runQueue.acknowledge(run);
          this.#update({
            ...applyOptimisticCommandPatch(this.#snapshot, {
              acceptedRunCreatedAt: result.run?.createdAt ?? null,
              message: toMessageEntry(result.message, result.input.policy, result.input),
              queueItem,
              run: admitted ? run : null,
              threadId: parsedCommand.threadId,
              type: result.type,
            }),
            runQueue: this.#runQueue.entries(),
          });
          // The Host held the message when it answered; a Run may have taken
          // it since, in an event this answer overtook. The read settles it.
          if (queueItem) this.#reloadInputQueue(parsedCommand.threadId);
        }
        break;
      case "thread.input.cancel":
        if (commandIs(parsedCommand, result.type)) {
          this.#update(
            applyOptimisticCommandPatch(this.#snapshot, {
              messageId: parsedCommand.messageId,
              threadId: parsedCommand.threadId,
              type: result.type,
              withdrawnAt: result.input.updatedAt,
            }),
          );
        }
        break;
      case "thread.input.steer":
        if (commandIs(parsedCommand, result.type)) {
          this.#update(
            applyOptimisticCommandPatch(this.#snapshot, {
              messageId: parsedCommand.messageId,
              threadId: parsedCommand.threadId,
              type: result.type,
            }),
          );
        }
        break;
      case "run.interrupt":
        if (commandIs(parsedCommand, result.type)) {
          this.#update(
            applyOptimisticCommandPatch(this.#snapshot, {
              runId: parsedCommand.runId,
              threadId: parsedCommand.threadId,
              type: result.type,
            }),
          );
        }
        break;
      case "request.respond":
        if (commandIs(parsedCommand, result.type) && !preservesIntegrationAccessRequest) {
          this.#update(
            applyOptimisticCommandPatch(this.#snapshot, {
              requestId: parsedCommand.requestId,
              type: result.type,
            }),
          );
        }
        break;
      case "execution.preferences.remember":
        // The Host answers with the whole merged record, so there is nothing
        // to patch — a caller dispatching the raw command gets the same
        // snapshot write `rememberExecution` performs.
        this.#update({ ...this.#snapshot, executionPreferences: result.preferences });
        break;
      default:
        break;
    }
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

  #appTabGeneration = 0;
  readonly #appTabWrites = new KeyedMutationQueue();
  readonly #appTabPending = new Map<
    string,
    { token: symbol; tab: import("@opensteer/protocol").AppTab | null; opening: boolean }
  >();
  #overlayAppTabs(tabs: readonly import("@opensteer/protocol").AppTab[]) {
    const result = new Map(tabs.map((tab) => [tab.appId, tab]));
    for (const [id, { tab }] of this.#appTabPending) {
      if (tab) result.set(id, tab);
      else result.delete(id);
    }
    return [...result.values()].sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  }
  #applyAppTabs(tabs: readonly import("@opensteer/protocol").AppTab[]) {
    const appVersions = { ...this.#snapshot.appVersions };
    for (const tab of tabs)
      appVersions[tab.appId] = Math.max(appVersions[tab.appId] ?? 0, tab.latestVersion);
    return {
      appTabs: tabs,
      appVersions,
      openingAppTabs: [...this.#appTabPending]
        .filter(([, pending]) => pending.opening && !pending.tab)
        .map(([id]) => id),
    };
  }
  openAppTab(appId: string): Promise<void> {
    return this.#setAppTab(appId, true);
  }
  closeAppTab(appId: string): Promise<void> {
    return this.#setAppTab(appId, false);
  }
  async #setAppTab(appId: string, open: boolean): Promise<void> {
    const viewer = this.#viewerGeneration;
    const token = Symbol();
    const previous = this.#snapshot.appTabs?.find((tab) => tab.appId === appId);
    const mutation = ++this.#appTabGeneration;
    this.#appTabPending.set(appId, { token, tab: previous ?? null, opening: open });
    this.#update({
      ...this.#snapshot,
      ...this.#applyAppTabs(this.#overlayAppTabs(this.#snapshot.appTabs ?? [])),
    });
    try {
      let tab = previous;
      if (open && !tab) {
        const entry = Object.entries(this.#snapshot.transcripts).flatMap(([threadId, entries]) =>
          entries
            .filter((entry) => entry.kind === "app" && entry.appId === appId)
            .map((entry) => ({ threadId, entry })),
        )[0];
        const thread = this.#snapshot.threads.find((thread) => thread.id === entry?.threadId);
        if (entry?.entry.kind === "app" && thread)
          tab = AppTabSchema.parse({
            appId,
            title: entry.entry.title,
            threadId: thread.id,

            latestVersion: entry.entry.version,
            openedAt: new Date().toISOString(),
          });
        else {
          const app = unwrapRpcResult(await this.rpc["apps.get"]({ appId }));
          if (viewer !== this.#viewerGeneration || this.#appTabPending.get(appId)?.token !== token)
            return;
          tab = {
            appId,
            title: app.title,
            threadId: app.threadId,
            latestVersion: app.latestVersion,
            openedAt: new Date().toISOString(),
          };
        }
      }
      this.#appTabPending.set(appId, { token, tab: open ? tab! : null, opening: open });
      this.#update({
        ...this.#snapshot,
        ...this.#applyAppTabs(this.#overlayAppTabs(this.#snapshot.appTabs ?? [])),
      });
      const result = await this.#appTabWrites.run(appId, async () =>
        viewer === this.#viewerGeneration && !this.#disposed
          ? this.dispatch({
              type: open ? "app.tab.open" : "app.tab.close",
              appId,
              idempotencyKey: crypto.randomUUID(),
            })
          : null,
      );
      if (result === null || viewer !== this.#viewerGeneration) return;
      if (result.type !== "app.tab.open" && result.type !== "app.tab.close")
        throw new Error("Unexpected app tab result");
      if (this.#appTabPending.get(appId)?.token !== token) return;
      this.#appTabPending.delete(appId);
      const tabs =
        mutation === this.#appTabGeneration
          ? result.appTabs
          : [
              ...(this.#snapshot.appTabs ?? []).filter((tab) => tab.appId !== appId),
              ...result.appTabs.filter((tab) => tab.appId === appId),
            ];
      this.#update({ ...this.#snapshot, ...this.#applyAppTabs(this.#overlayAppTabs(tabs)) });
    } catch (error) {
      if (viewer === this.#viewerGeneration && this.#appTabPending.get(appId)?.token === token) {
        this.#appTabPending.delete(appId);
        const restored = (this.#snapshot.appTabs ?? []).filter((tab) => tab.appId !== appId);
        if (previous) restored.push(previous);
        this.#update({ ...this.#snapshot, ...this.#applyAppTabs(this.#overlayAppTabs(restored)) });
      }
      throw error;
    } finally {
      if (viewer === this.#viewerGeneration) {
        this.#appTabGeneration++;
        this.#reread("host.app-tabs-changed");
      }
    }
  }

  async viewApp(appId: string, theme: "light" | "dark", signal?: AbortSignal) {
    const view = unwrapRpcResult(
      await this.rpc["apps.view"]({ appId, theme }, signal ? { signal } : undefined),
    );
    return { app: view.app, url: view.entryUrl ?? this.#url(view.path) };
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
    const thread = this.#snapshot.threads.find(({ id }) => id === threadId);
    const opened = !this.#showsThread(threadId);
    this.#activeThreadId = threadId;
    for (const [id, scan] of this.#messagePageLoads) {
      if (!this.#showsThread(id)) scan.retired = true;
    }
    this.#ensureInputQueue(threadId);
    this.#ensureAssignments(threadId);
    this.#ensureAutomations(threadId, opened);
    this.#ensureBrowserUsage(threadId, "missing");
    if (!thread) {
      // A deep link can reference a Thread the snapshot has not loaded yet.

      // page includes thread.created.
      if (this.#snapshot.threadLookups[threadId] !== "loading") {
        this.#update({
          ...this.#snapshot,
          threadLookups: { ...this.#snapshot.threadLookups, [threadId]: "loading" },
        });
      }
      this.#ensureThreadHydration(threadId);
      return;
    }
    if (this.#snapshot.deploymentId) this.#ensureDeploymentChannel(this.#snapshot.deploymentId);
    this.#ensureThreadHydration(threadId);
    this.#ensureRequests(threadId);
  }

  deploymentPosition(): Sequence | null {
    const channel = this.#snapshot.deploymentId
      ? this.#channels.get(this.#snapshot.deploymentId)
      : undefined;
    return channel?.synchronized ? channel.cursor : null;
  }

  watchNode(threadId: string, nodeId: string): NodeDetailSubscription {
    const deploymentId = this.#threadDeployment.get(threadId);
    if (!deploymentId) throw new Error("Open the conversation before its subagent.");
    ExecutionNodeIdSchema.parse(nodeId);
    const releaseThread = this.observeThread(threadId);
    const detail = this.#nodeDetails.open(threadId, nodeId, deploymentId);
    let held = true;
    const releaseThreadOnce = () => {
      if (!held) return;
      held = false;
      releaseThread();
    };
    const unsubscribe = detail.subscribe(() => {
      if (detail.getSnapshot().status === "closed") {
        queueMicrotask(releaseThreadOnce);
        unsubscribe();
      }
    });
    return {
      ...detail,
      release: () => {
        detail.release();
        releaseThreadOnce();
        unsubscribe();
      },
    };
  }

  observeThread(threadId: string): () => void {
    const opened = !this.#showsThread(threadId);
    this.#observedThreads.set(threadId, (this.#observedThreads.get(threadId) ?? 0) + 1);
    if (!this.#snapshot.transcriptWindows[threadId]) {
      this.#update({
        ...this.#snapshot,
        threadLookups: { ...this.#snapshot.threadLookups, [threadId]: "loading" },
      });
    }
    const deploymentId = this.#threadDeployment.get(threadId);
    if (deploymentId) this.#ensureDeploymentChannel(deploymentId);
    this.#ensureThreadHydration(threadId);
    this.#ensureRequests(threadId);
    this.#ensureAssignments(threadId);
    this.#ensureAutomations(threadId, opened);
    this.#ensureBrowserUsage(threadId, "missing");
    this.#recomputeConnection();
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      const count = this.#observedThreads.get(threadId) ?? 0;
      if (count <= 1) this.#observedThreads.delete(threadId);
      else this.#observedThreads.set(threadId, count - 1);
      this.#recomputeConnection();
      const scan = this.#messagePageLoads.get(threadId);
      if (scan && !this.#showsThread(threadId)) scan.retired = true;
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
    for (const entries of Object.values(this.#snapshot.transcripts)) {
      for (const entry of entries) {
        if (entry.kind === "assignment" && entry.assignment.workerThread.id === workerThreadId)
          ids.add(entry.assignment.id);
      }
    }
    return [...ids];
  }

  /** `again` asks once more after a finished read; a read in flight always answers. */
  #ensureAssignments(threadId: string, again = false): void {
    if (this.#disposed || this.#snapshot.session !== "authenticated") return;
    const read = this.#assignmentReads.get(threadId);
    if (read === "reading" || (read === "read" && !again)) return;
    this.#assignmentReads.set(threadId, "reading");
    void this.#readAssignments(threadId)
      .catch(() => undefined)
      .finally(() => {
        if (this.#assignmentReads.get(threadId) === "reading")
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
  async #readAssignments(threadId: string): Promise<void> {
    await Promise.all([
      this.#readAssignmentPages(threadId, false),
      ...(this.#capabilities?.includes("task-family-v1")
        ? [this.#readAssignmentPages(threadId, true)]
        : []),
    ]);
  }

  async #readAssignmentPages(threadId: string, open: boolean): Promise<void> {
    const generation = this.#viewerGeneration;
    const userId = this.#snapshot.user?.id;
    let before: string | null = null;
    do {
      let response;
      try {
        response = unwrapRpcResult(
          await this.rpc["thread.assignments.list"]({
            threadId,
            limit: 100,
            ...(open ? { open } : {}),
            ...(before === null ? {} : { before }),
          }),
        );
      } catch (error) {
        if (this.#viewerStillCurrent(generation, userId))
          this.#denyOnRefusal(error, this.#assignmentsOfWorker(threadId));
        throw error;
      }
      if (!this.#viewerStillCurrent(generation, userId)) return;
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
    for (const entry of this.#snapshot.transcripts[threadId] ?? []) {
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
    for (const run of this.#snapshot.runQueue) {
      if (run.threadId === threadId) runIds.add(run.id);
    }
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
    const deploymentId = this.#threadDeployment.get(threadId);
    const channel = deploymentId === undefined ? undefined : this.#channels.get(deploymentId);
    if (channel && !channel.synchronized && !channel.refused) return;
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
    void this.#readBrowserUsage(threadId, scope ?? runIds, scope === null)
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
  ): Promise<boolean> {
    const generation = this.#viewerGeneration;
    const userId = this.#snapshot.user?.id;
    const deploymentId = this.#snapshot.deploymentId;
    const current = () =>
      this.#viewerStillCurrent(generation, userId) &&
      this.#snapshot.deploymentId === deploymentId &&
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
      const transcript = this.#snapshot.transcripts[threadId] ?? [];
      const sources = [
        transcript.length,
        transcript[0]?.id,
        transcript.at(-1)?.id,
        this.#snapshot.assignments,
        this.#snapshot.runQueue,
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

  /**
   * Reads a Thread's Requests when the Host counts more pending than it holds.
   * The count is projected after the Requests it counts, so it can lag the
   * list in either direction; a read is asked once per count, never per event
   * batch, and a new count, a refresh or a resync is what asks again. A failed
   * read waits for the same, since there is no one to hand the failure to.
   */
  #ensureRequests(threadId: string): void {
    const thread = this.#snapshot.threads.find(({ id }) => id === threadId);
    if (!thread) return;
    if (knownPendingRequestCount(this.#snapshot, threadId) >= thread.pendingRequests) {
      // Caught up, so a later shortfall is a new question even at the same count.
      this.#requestReads.delete(threadId);
      return;
    }
    if (this.#requestLoads.has(threadId)) return;
    if (this.#requestReads.get(threadId) === thread.pendingRequests) return;
    this.#requestReads.set(threadId, thread.pendingRequests);
    const operation = this.#loadRequests(threadId).finally(() => {
      if (this.#requestLoads.get(threadId) === operation) {
        this.#requestLoads.delete(threadId);
        this.#ensureRequests(threadId);
      }
    });
    this.#requestLoads.set(threadId, operation);
    void operation.catch(() => undefined);
  }

  async load(): Promise<void> {
    if (this.#disposed) throw new Error("The Host client is closed.");
    await this.#bootstrap("load");
  }

  async refresh(options?: { readonly retryConnection?: boolean }): Promise<void> {
    if (this.#disposed) return;
    if (options?.retryConnection)
      for (const channel of this.#channels.values()) {
        channel.refused = false;
        channel.unreadableRetryAt = 0;
        if (channel.reconnectTimer) this.#replaceChannel(channel);
      }
    await this.#refresh("refresh");
  }

  async #refresh(reason: BootstrapReason): Promise<void> {
    this.#assignmentReads.clear();
    this.#automationReads.clear();
    this.#readAutomations.clear();
    this.#requestReads.clear();
    await this.#bootstrap(reason, false, true);
  }

  /**
   * Re-reads the session after something outside this client restored it.
   *
   * Once bootstrap answers 401 the client latches `authentication-required` and
   * stops polling, so an ordinary `refresh` can join a stale in-flight bootstrap
   * instead of asking the Host again. Desktop restores Host sessions in its main
   * process, and this is how that recovery reaches the renderer.
   */
  async reauthenticate(): Promise<void> {
    if (this.#disposed) return;
    await this.#bootstrap("reauthenticate", true, true);
  }

  async loadEarlierTranscript(threadId: string): Promise<void> {
    const existing = this.#messagePageLoads.get(threadId);
    if (existing && !existing.retired) return existing.promise;
    const scan = { promise: Promise.resolve(), retired: false };
    this.#messagePageLoads.set(threadId, scan);
    // A retired scan still settles its in-flight page; a new request starts after it.
    scan.promise = (existing?.promise.catch(() => undefined) ?? Promise.resolve())
      .then(() => this.#loadEarlierTranscript(threadId, scan))
      .finally(() => {
        if (this.#messagePageLoads.get(threadId) === scan) {
          this.#messagePageLoads.delete(threadId);
        }
      });
    return scan.promise;
  }

  async searchThreadMessages(input: { threadId: string; query: string; before?: string }) {
    return unwrapRpcResult(await this.rpc["thread.messages.list"]({ ...input, limit: 50 }));
  }

  async loadTranscriptAround(threadId: string, messageId: string): Promise<void> {
    const generation = this.#viewerGeneration,
      userId = this.#snapshot.user?.id;
    const scan = this.#messagePageLoads.get(threadId);
    if (scan) scan.retired = true;
    await this.#threadHydrations.get(threadId);
    await this.#latestTranscriptLoads.get(threadId);
    await scan?.promise;
    const page = unwrapRpcResult(
      await this.rpc["thread.events.list"]({
        ...(this.#capabilities?.includes("tool-output-detail-v1")
          ? { toolOutputs: "preview" as const }
          : {}),
        ...(this.#capabilities?.includes("place-events-v1")
          ? { placeEvents: "include" as const }
          : {}),
        threadId,
        aroundMessageId: messageId,
      }),
    );
    if (!this.#viewerStillCurrent(generation, userId)) return;
    if (page.threadId !== threadId) throw new Error("Thread event page mismatch.");
    this.#historicalThreads.add(threadId);

    this.#update({
      ...this.#snapshot,
      assignments: withAssignmentsFrom(this.#snapshot.assignments, page.events),
      transcripts: {
        ...this.#snapshot.transcripts,
        [threadId]: page.events.reduce(foldTranscriptEvent, [] as TranscriptEntry[]),
      },
      transcriptWindows: { ...this.#snapshot.transcriptWindows, [threadId]: page.window },
    });
  }

  async loadLatestTranscript(threadId: string): Promise<void> {
    const existing = this.#latestTranscriptLoads.get(threadId);
    if (existing) return existing;
    const operation = this.#loadLatestTranscript(threadId).finally(() => {
      if (this.#latestTranscriptLoads.get(threadId) === operation) {
        this.#latestTranscriptLoads.delete(threadId);
      }
    });
    this.#latestTranscriptLoads.set(threadId, operation);
    return operation;
  }

  async #loadLatestTranscript(threadId: string): Promise<void> {
    const generation = this.#viewerGeneration;
    const scan = this.#messagePageLoads.get(threadId);
    if (scan) scan.retired = true;
    const hydration = this.#threadHydrations.get(threadId);
    if (hydration) await hydration;
    if (scan) await scan.promise;
    if (generation !== this.#viewerGeneration) return;
    await this.#hydrateThread(threadId, true);
  }

  subscribeNotifications(listener: (notification: NotificationView) => void): () => void {
    const resumesHidden = this.#visibility === "background" && !this.#notifiesWhileHidden();
    this.#notificationListeners.add(listener);
    // Hidden sockets were left closed, or unwatched, while nobody listened; they are needed now.
    if (resumesHidden) {
      for (const channel of this.#channels.values()) this.#connect(channel);
      this.#watchLiveness();
    }
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
  ): void {
    for (const row of rows) {
      if (row.lastVisitedAt && row.lastVisitedAt > (this.#snapshot.threadVisits[row.id] ?? ""))
        this.#snapshot = {
          ...this.#snapshot,
          threadVisits: { ...this.#snapshot.threadVisits, [row.id]: row.lastVisitedAt },
        };
    }
  }

  #applyVisits(visits: readonly ThreadVisit[]): void {
    this.#mergeVisits(
      visits.map((visit) => ({ id: visit.threadId, lastVisitedAt: visit.lastVisitedAt })),
    );
    this.#update(this.#snapshot);
    const channel = this.#snapshot.deploymentId
      ? this.#channels.get(this.#snapshot.deploymentId)
      : undefined;
    if (channel) this.#persistCheckpoint(channel);
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

  #ensureThreadHydration(threadId: string): void {
    if (
      this.#historicalThreads.has(threadId) ||
      this.#hydratedThreads.has(threadId) ||
      this.#threadHydrations.has(threadId) ||
      this.#latestTranscriptLoads.has(threadId)
    )
      return;
    const generation = this.#viewerGeneration;
    this.#update({
      ...this.#snapshot,
      threadLookups: { ...this.#snapshot.threadLookups, [threadId]: "loading" },
    });
    const operation = this.#hydrateThread(threadId)
      .catch((error: unknown) => {
        // A failed refresh leaves the last readable transcript in place. Its
        // failure is visible for known Threads too; activation retries it.
        if (
          generation === this.#viewerGeneration &&
          this.#snapshot.threadLookups[threadId] === "loading"
        ) {
          this.#update({
            ...this.#snapshot,
            threadLookups: {
              ...this.#snapshot.threadLookups,
              [threadId]:
                error instanceof HostClientRequestError && error.status === 404
                  ? "missing"
                  : "failed",
            },
          });
        }
      })
      .finally(() => {
        if (this.#threadHydrations.get(threadId) === operation) {
          this.#threadHydrations.delete(threadId);
        }
      });
    this.#threadHydrations.set(threadId, operation);
  }

  /**
   * Restores the durable trace (tool calls, reasoning, run outcomes) for a
   * Thread from the Host's event history so a reloaded page shows the same
   * transcript a live session saw. Live events arriving mid-flight are
   * buffered and re-folded on top of the restored page.
   */
  async #hydrateThread(threadId: string, restoreLatest = false): Promise<void> {
    const generation = this.#viewerGeneration;
    const userId = this.#snapshot.user?.id;
    const buffer: AgentEvent[] = [];
    this.#hydrationBuffers.set(threadId, buffer);
    try {
      const first = await this.#readLatestHistory(threadId, generation, userId);
      if (!first) return;
      let latest = first;
      const overtaken = () => {
        const sequence = this.#invalidatedHydrations.get(threadId);
        return sequence !== undefined && compareSequence(latest.page.asOfSequence, sequence) < 0;
      };
      for (
        let attempt = 0;
        attempt < 3 &&
        (overtaken() || this.#threadState.needsRead(latest.page.thread, latest.page.asOfSequence));
        attempt += 1
      ) {
        const fresh = await this.#readLatestHistory(threadId, generation, userId);
        if (!fresh) return;
        if (compareSequence(fresh.page.asOfSequence, latest.page.asOfSequence) >= 0) latest = fresh;
      }
      if (overtaken())
        throw new Error("The connection changed while loading this conversation. Try again.");
      const { history, page, window } = latest;

      const activeNodes = await this.#readActiveNodes(threadId);
      if (!this.#viewerStillCurrent(generation, userId)) return;
      let entries = history.reduce(foldTranscriptEvent, [] as TranscriptEntry[]);
      const loadedNodeIds = new Set(
        entries.filter((entry) => entry.kind === "node").map((node) => node.nodeId),
      );
      for (const node of activeNodes) {
        if (loadedNodeIds.has(node.nodeId)) continue;
        const index = entries.findIndex((entry) => entry.createdAt > node.createdAt);
        entries.splice(index < 0 ? entries.length : index, 0, node);
      }
      const replayed = buffer.filter(
        (event) => compareSequence(event.sequence, page.asOfSequence) > 0,
      );
      for (const event of replayed) entries = foldTranscriptEvent(entries, event);
      // The page is durable history only; whatever the Thread's Runs are
      // streaming right now is drawn again on top of it, less any stream the
      // page shows completed before the event stream has said so.
      for (const event of [...history, ...replayed]) this.#live.complete(event);
      const receivedAt = new Date().toISOString();
      for (const run of this.#live.threadRuns(threadId as ThreadId)) {
        entries = foldLiveRun(entries, run, receivedAt);
      }
      for (const event of [...history, ...replayed]) this.#threadState.record(event);
      // History paging must not reconstruct today's selection from an old creation event.
      const summary = this.#threadState.reconcile(
        toThreadSummary(page.thread, this.#snapshot.environments, this.#snapshot.harnesses),
        page.asOfSequence,
        this.#snapshot.threads.find(({ id }) => id === threadId),
      );
      const threads = this.#snapshot.threads.some(({ id }) => id === threadId)
        ? this.#snapshot.threads.map((thread) => (thread.id === threadId ? summary : thread))
        : [summary, ...this.#snapshot.threads];
      const deploymentId = this.#snapshot.deploymentId!;
      const threadLookups = { ...this.#snapshot.threadLookups };
      delete threadLookups[threadId];
      if (restoreLatest) this.#historicalThreads.delete(threadId);
      this.#hydratedThreads.set(threadId, page.asOfSequence);
      this.#update({
        ...this.#snapshot,
        assignments: withAssignmentsFrom(this.#snapshot.assignments, [...history, ...replayed]),
        threadLookups,
        threads,
        transcripts: { ...this.#snapshot.transcripts, [threadId]: entries },
        transcriptWindows: { ...this.#snapshot.transcriptWindows, [threadId]: window },
      });
      if (deploymentId) this.#ensureDeploymentChannel(deploymentId);
      if (this.#observedThreads.has(threadId)) this.#ensureRequests(threadId);
      this.#mergeVisits([page.thread]);
    } catch (error) {
      // A worker the Host will not show this viewer takes its tasks with it.
      if (this.#viewerStillCurrent(generation, userId))
        this.#denyOnRefusal(error, this.#assignmentsOfWorker(threadId));
      throw error;
    } finally {
      if (this.#hydrationBuffers.get(threadId) === buffer) {
        this.#hydrationBuffers.delete(threadId);
        this.#invalidatedHydrations.delete(threadId);
      }
    }
  }

  /** Read one opening page; even a silent settled turn has a row. */
  async #readLatestHistory(threadId: string, generation: number, userId: string | undefined) {
    const page = await this.#readThreadHistory(threadId);
    if (!this.#viewerStillCurrent(generation, userId)) return null;
    const thread = toThreadSummary(
      page.thread,
      this.#snapshot.environments,
      this.#snapshot.harnesses,
    );
    let history = page.events;
    let window = page.window;
    let entries = history.reduce(foldTranscriptEvent, [] as TranscriptEntry[]);
    let assignments = withAssignmentsFrom(this.#snapshot.assignments, history);
    // A page can hold only the tail of one long turn, such as background work
    // after its reply, so read back until the Thread draws something.
    let pages = 1;
    let bytes = window.byteCount;
    const cursors = new Set<string>();
    while (
      window.hasMore &&
      pages < historyScanMaxPages &&
      bytes < historyScanMaxBytes &&
      this.#drawnRowCount(thread, entries, assignments) === 0
    ) {
      const before = window.nextBefore;
      if (!before || cursors.has(before))
        throw new Error("Thread event page is missing its continuation cursor.");
      cursors.add(before);
      const older = await this.#readThreadHistory(threadId, before);
      if (!this.#viewerStillCurrent(generation, userId)) return null;
      pages += 1;
      bytes += older.window.byteCount;
      history = [...older.events, ...history];
      window = older.window;
      entries = mergeTranscriptSegments(
        older.events.reduce(foldTranscriptEvent, [] as TranscriptEntry[]),
        entries,
      );
      assignments = withAssignmentsFrom(assignments, older.events);
    }
    if (window.hasMore && (!window.nextBefore || cursors.has(window.nextBefore)))
      throw new Error("Thread event page is missing its continuation cursor.");
    return {
      history,
      page,
      window,

      complete: !window.hasMore || this.#drawnRowCount(thread, entries, assignments) > 0,
    };
  }

  async #readActiveNodes(threadId: string) {
    const runs = this.#snapshot.runQueue.filter(
      (run) => run.threadId === threadId && run.status !== "queued",
    );
    const pages = await Promise.all(runs.map((run) => this.#readRunNodes(run.id)));
    return pages.flat();
  }

  async #readRunNodes(runId: string) {
    const result = unwrapRpcResult(
      await this.rpc["run.attempts.list"]({ runId: RunIdSchema.parse(runId) }),
    );
    return result.nodes.map(executionNodeEntry);
  }

  /** How many rows a Thread's transcript draws once its history is settled. */
  #drawnRowCount(
    thread: Pick<ThreadSummary, "id" | "purpose" | "inputQueuePaused">,
    entries: readonly TranscriptEntry[],
    assignments: HostSnapshot["assignments"],
  ): number {
    return drawnTranscriptRowKeys(entries, {
      thread,
      inputQueue: this.#snapshot.inputQueues[thread.id] ?? null,
      assignments,
      waitingRequests: this.#snapshot.waitingRequests,
    }).length;
  }

  async #readThreadHistory(threadId: string, before?: string) {
    const page = unwrapRpcResult(
      await this.rpc["thread.events.list"]({
        ...(this.#capabilities?.includes("tool-output-detail-v1")
          ? { toolOutputs: "preview" as const }
          : {}),
        ...(this.#capabilities?.includes("place-events-v1")
          ? { placeEvents: "include" as const }
          : {}),
        ...(before ? { before } : {}),
        threadId,
        ...(this.#capabilities?.includes("history-turns-v1") ? { turns: historyPageTurns } : {}),
      }),
    );
    if (page.threadId !== threadId || page.thread.id !== threadId)
      throw new Error("Thread event page mismatch.");
    return page;
  }

  async startBrowser(
    deploymentId: string,
    identity: BrowserStartIdentity,
    placement?: BrowserPlacementSummary,
    threadId?: string,
    viewport?: Extract<BrowserCommand, { type: "surface.open" }>["viewport"],
  ): Promise<BrowserSessionSummary> {
    // catalog page. Command admission, not this cache, checks access.
    if (!this.#snapshot.browserAvailable) {
      throw new Error("This Host does not have a connected Browser Runtime.");
    }
    this.#ensureDeploymentChannel(deploymentId);
    const result = await this.dispatch({
      idempotencyKey: mutationIdempotencyKey("browser"),
      input: {
        reuseExisting: false,
        ...(viewport ? { viewport } : {}),
        ...(threadId ? { threadId: ThreadIdSchema.parse(threadId) } : {}),
        ...(placement
          ? { placement: { kind: "runner" as const, runnerId: placement.runnerId } }
          : {}),
        ...(identity.kind === "fresh"
          ? { fresh: true as const }
          : { profileId: identity.profileId }),
      },
      type: "browser.session.start",
    });
    if (result.type !== "browser.session.start") {
      throw new Error("Browser session command mismatch.");
    }
    const summary = this.#snapshot.browserSessions.find(
      (session) => session.id === result.session.id,
    );
    if (!summary) throw new Error("The Browser Session was not projected.");
    return summary;
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
    await this.#rememberQuietly({
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

  async rememberExecution(choice: ExecutionChoice): Promise<ExecutionPreferences> {
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
    const node = this.#snapshot.transcripts[threadId]?.find(
      (entry) => entry.kind === "node" && entry.nodeId === nodeId,
    );
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
    const run = threadStopTarget({ runQueue: this.#snapshot.runQueue, thread });
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
    const expectedRunId = this.#snapshot.inputQueues[threadId]?.steerRunId ?? null;
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
  async updateMachineAccess(input: {
    readonly expectedRevision: number;
    readonly policy: MachineAccessPolicy;
    readonly runnerId: string;
  }): Promise<MachineAccessUpdateOutcome> {
    const result = await this.dispatch({
      expectedRevision: input.expectedRevision,
      idempotencyKey: mutationIdempotencyKey("machine-access"),
      policy: input.policy,
      runnerId: input.runnerId,
      type: "machine.access.update",
    });
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

  loadThreadInputQueue(threadId: string): Promise<ThreadInputQueue> {
    const existing = this.#threadInputQueueLoads.get(threadId);
    if (existing) return existing;
    const operation = this.rpc["thread.inputQueue.get"]({ threadId })
      .then(unwrapRpcResult)
      .then((queue) => {
        if (queue.threadId !== threadId) throw new Error("Thread input queue mismatch.");
        this.#update({
          ...this.#snapshot,
          inputQueues: { ...this.#snapshot.inputQueues, [threadId]: queue },
        });
        return queue;
      });
    this.#threadInputQueueLoads.set(threadId, operation);
    const settle = () => {
      if (this.#threadInputQueueLoads.get(threadId) !== operation) return;
      this.#threadInputQueueLoads.delete(threadId);
      // An event that landed while this read was in flight may postdate what
      // the read saw, so the answer it is owed is one more read.
      if (this.#threadInputQueueRereads.delete(threadId)) this.#reloadInputQueue(threadId);
    };
    void operation.then(settle, settle);
    return operation;
  }

  /** The first read of a Thread's queue; one already read is kept fresh by events. */
  #ensureInputQueue(threadId: string): void {
    if (this.#disposed || this.#snapshot.session !== "authenticated") return;
    if (this.#snapshot.inputQueues[threadId] || this.#threadInputQueueLoads.has(threadId)) return;
    void this.loadThreadInputQueue(threadId).catch(() => undefined);
  }

  /**
   * Reads a queue again because something may have changed it. A read already
   * in flight may predate the change, so the request waits for it and is
   * answered by one more read rather than joining a possibly stale one.
   */
  #reloadInputQueue(threadId: string): void {
    if (this.#disposed || this.#snapshot.session !== "authenticated") return;
    if (this.#threadInputQueueLoads.has(threadId)) {
      this.#threadInputQueueRereads.add(threadId);
      return;
    }
    void this.loadThreadInputQueue(threadId).catch(() => undefined);
  }

  async #dispatch(command: HostApiCommandInput): Promise<HostApiCommandOutput> {
    return unwrapRpcResult(await this.rpc["commands.dispatch"](command));
  }

  dispose(): void {
    this.#nodeDetails.clear();
    this.#pendingBrowserTabs.dispose();
    if (this.#disposed) return;
    this.#clearInterruptionHold();
    this.#clearAttachmentReads();
    this.#cancelLostFrameReread();
    this.browserHistory.dispose();
    this.#personalTabActivations.dispose();
    this.#snapshot = { ...this.#snapshot, activatingPersonalTabs: [] };
    this.#disposed = true;
    for (const check of this.#browserWaiters) check();
    this.#computerViews.clear();
    this.#browserUsageRead.clear();
    this.#browserUsageReads.clear();
    this.#browserUsageRunSources.clear();
    this.#browserUses.clear();
    this.#browserTabs.clear();
    this.#browserContinuation = undefined;
    this.#placeActivity.clear();
    this.#runPlaces.clear();
    this.#targetedWatch.clear();
    this.#targetedControl.clear();
    this.#threadState.clear();
    this.#threadRenames.clear();
    this.#threadIcons.clear();
    this.#runQueue.clear();
    this.#live.clear();
    this.#heldLive.clear();
    for (const release of this.#lifecycleDisposers) release();
    this.#lifecycleDisposers.length = 0;
    if (this.#refreshTimer) globalThis.clearInterval(this.#refreshTimer);
    this.#refreshTimer = null;
    this.#stopLiveness();
    for (const channel of this.#channels.values()) this.#closeChannel(channel, false);
    this.#channels.clear();
    this.#assignmentReads.clear();
    this.#automationReads.clear();
    this.#readAutomations.clear();
    this.#deniedAssignments.clear();
    this.#observedThreads.clear();
    this.#forgetLiveRereads();
    this.#listeners.clear();
    this.#personShowListeners.clear();
    this.#lifecycleListeners.clear();
    this.#placeActivity.dispose();
    this.#runPlaces.dispose();
    this.#targetedWatch.dispose();
    this.#targetedControl.dispose();
    this.#browserEditing.dispose();
  }

  async #bootstrap(
    reason: BootstrapReason,
    force = false,
    revalidateCapabilities = false,
    trigger = true,
  ): Promise<void> {
    if (trigger) bootstrapReadDiagnostics.trigger(reason);
    if (this.#bootstrapPromise && !force) {
      // A bootstrap already under way may be reusing evidence this caller
      // asked to replace, so the reverification runs beside it.
      if (!revalidateCapabilities) return this.#bootstrapPromise;
      await Promise.all([this.#bootstrapPromise, this.#refreshCapabilities({ revalidate: true })]);
      // An explicit refresh may follow a mutation committed after that read
      // began. Read again after it settles so its stale answer cannot win.
      if (!this.#disposed) await this.#bootstrap(reason, false, false, false);
      return;
    }
    const operation = this.#performBootstrap(reason, revalidateCapabilities);
    this.#bootstrapPromise = operation;
    try {
      await operation;
    } finally {
      if (this.#bootstrapPromise === operation) {
        this.#bootstrapPromise = null;
        if (this.#rereadPending) {
          const reason = this.#rereadPending;
          this.#rereadPending = null;
          this.#reread(reason, false);
        }
      }
    }
  }

  /**
   * Answers a Host notice that something outside the event stream changed.
   *
   * A notice is a fact, not a fetch: one bootstrap answers every notice that
   * arrived before it started, and a notice that lands mid-flight earns
   * exactly one more read once it finishes — so a burst, a session starting
   * and then ready, never leaves the client on the stale read it would have
   * joined. Hidden, it waits: coming to the foreground rereads anyway.
   */
  #reread(reason: BootstrapReason, trigger = true): void {
    if (this.#disposed || this.#visibility === "background") return;
    if (this.#bootstrapPromise) {
      if (trigger) bootstrapReadDiagnostics.trigger(reason);
      this.#rereadPending ??= reason;
      return;
    }
    void this.#bootstrap(reason, false, false, trigger).catch(() => undefined);
  }

  #rereadWaitingRequests(): void {
    if (this.#disposed || this.#snapshot.session !== "authenticated") return;
    if (this.#waitingRead !== "idle") {
      this.#waitingRead = "again";
      return;
    }
    this.#waitingRead = "reading";
    void this.#readWaitingRequests()
      .catch(() => undefined)
      .finally(() => {
        const again = this.#waitingRead === "again";
        this.#waitingRead = "idle";
        if (again) this.#rereadWaitingRequests();
      });
  }

  async loadEarlierNeedsYou(): Promise<void> {
    const held = this.#snapshot.needsYou,
      generation = this.#viewerGeneration;
    if (!held?.window.hasMore || !held.window.nextBefore) return;
    const page = unwrapRpcResult(
      await this.rpc["needsYou.get"]({ before: held.window.nextBefore, limit: 50 }),
    );
    if (generation !== this.#viewerGeneration || this.#disposed || this.#snapshot.needsYou !== held)
      return;
    const ids = new Set(held.entries.map(({ request }) => request.id));
    this.#update({
      ...this.#snapshot,
      needsYou: {
        ...page,
        entries: [...held.entries, ...page.entries.filter(({ request }) => !ids.has(request.id))],
      },
    });
  }

  async #readWaitingRequests(): Promise<void> {
    const needsGeneration = this.#viewerGeneration;
    const needsYou = unwrapRpcResult(await this.rpc["needsYou.get"]({}));
    if (needsGeneration !== this.#viewerGeneration || this.#disposed) return;
    this.#update({ ...this.#snapshot, needsYou });
    const generation = this.#viewerGeneration;
    const userId = this.#snapshot.user?.id;
    const waitingRequests: WaitingRequest[] = [];
    let before: string | null = null;
    do {
      const page: {
        readonly requests: readonly WaitingRequest[];
        readonly window: DurableWindow;
      } = unwrapRpcResult(
        await this.rpc["requests.list"]({ ...(before ? { before } : {}), limit: 100 }),
      );
      if (!this.#viewerStillCurrent(generation, userId)) return;
      waitingRequests.push(...page.requests);
      before = page.window.hasMore ? page.window.nextBefore : null;
      if (page.window.hasMore && !before) {
        throw new Error("Waiting Request page is missing its continuation cursor.");
      }
    } while (before);
    this.#update({ ...this.#snapshot, waitingRequests });
  }

  #rereadTasks(): void {
    if (
      this.#disposed ||
      this.#visibility === "background" ||
      this.#snapshot.session !== "authenticated"
    )
      return;
    for (const scope of [null, "active", "done:*"])
      void this.#readFirstTaskPage(scope, "changed").catch(() => undefined);
  }

  loadDoneTasks(): Promise<void> {
    return this.#readFirstTaskPage("done:*", "asked");
  }

  loadEarlierDoneTasks(): Promise<void> {
    return this.#loadEarlier("done:*");
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
  #readFirstTaskPage(scope: string | null, reason: "asked" | "changed"): Promise<void> {
    const pending = this.#taskReads.get(scope);
    if (pending) {
      if (reason === "changed") pending.again = true;
      return pending.done;
    }
    const earlier = this.#taskPageLoads.get(scope)?.promise;
    const read = { again: false, done: Promise.resolve() };
    read.done = (async () => {
      try {
        if (earlier) await earlier.catch(() => undefined);
        let failure: unknown = null;
        do {
          read.again = false;
          failure = await this.#readTaskPage(
            scope,
            null,
            this.#heldTasks(scope)?.entries.length ?? 0,
          ).then(
            () => null,
            (error: unknown) => error,
          );
        } while (read.again && !this.#disposed);
        if (failure !== null) throw failure;
      } finally {
        this.#taskReads.delete(scope);
      }
    })();
    this.#taskReads.set(scope, read);
    return read.done;
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
    await this.#taskReads.get(scope)?.done;
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

  /** Replaces a loaded prefix atomically, or appends one page after its cursor. */
  async #readTaskPage(
    scope: string | null,
    cursor: string | null,
    minimumItems = 0,
  ): Promise<void> {
    const generation = this.#viewerGeneration,
      userId = this.#snapshot.user?.id;
    try {
      let before = cursor,
        merged = cursor ? this.#heldTasks(scope) : null;
      for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
        const page = unwrapRpcResult(
          await this.rpc["tasks.list"]({
            ...(scope === "active" ? { active: true } : scope ? { done: true } : {}),
            ...(before ? { before } : {}),
            limit: threadPageMaxItems,
          }),
        );
        if (!this.#viewerStillCurrent(generation, userId)) return;
        this.#mergeVisits(page.tasks.map((entry) => entry.thread));
        merged = mergeTasks(merged, {
          entries: page.tasks.map((entry) => ({
            ...entry,
            thread: this.#threadState.reconcile(
              toThreadSummary(entry.thread, this.#snapshot.environments, this.#snapshot.harnesses),
              page.asOfSequence,
            ),
          })),
          window: page.window,
        });
        if (!page.window.hasMore || (scope !== "active" && merged.entries.length >= minimumItems))
          break;
        if (!page.window.nextBefore || page.window.nextBefore === before)
          throw new Error("Task page is missing its continuation cursor.");
        before = page.window.nextBefore;
      }
      if (!merged || !this.#viewerStillCurrent(generation, userId)) return;
      if (!scope) this.#savedViewReadiness = { ...this.#savedViewReadiness, tasksReady: true };
      this.#update(
        scope === "active"
          ? { ...this.#snapshot, activeTasks: merged.entries }
          : scope
            ? { ...this.#snapshot, doneTasks: { [mainDoneTasks]: merged } }
            : { ...this.#snapshot, tasks: merged },
      );
    } finally {
    }
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
    this.#rereadTasks();
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
    this.#nodeDetails.capabilitiesChanged();
    this.#update({
      ...this.#snapshot,
      threadRenameAvailable: capabilities.includes("thread-titles-v1"),
      taskMarksAvailable: capabilities.includes("task-marks-v1"),
      integrationAppFinishAvailable: capabilities.includes("integration-app-finish-v1"),
      integrationAppReturnPortAvailable: capabilities.includes("integration-app-return-port-v1"),

      quietTasksAvailable: capabilities.includes("quiet-tasks-v1"),
      harnessUpdateAvailable: capabilities.includes("harness-update-v1"),
      tabReopenAvailable: capabilities.includes("tab-reopen-v1"),
      browserProfileManageAvailable: capabilities.includes("browser-profile-manage-v1"),
      searchSuggestionsAvailable: capabilities.includes("browser-search-suggestions-v1"),
      iphoneAppsAvailable: capabilities.includes("iphone-apps-v1"),
      voiceAvailable: capabilities.includes("voice-run-v1"),
      ownerViewWindowsAvailable: capabilities.includes("ownerViewWindows"),
    });
    if (changed) {
      this.#targetedControl.capabilitiesChanged();
      this.#targetedWatch.capabilitiesChanged();
    }
  }

  async #performBootstrap(reason: BootstrapReason, revalidateCapabilities: boolean): Promise<void> {
    let generation = this.#viewerGeneration;
    const appTabMark = this.#appTabGeneration,
      presenceMark = this.#presenceCounter,
      ownerViewRevision = this.#ownerViews.revision;
    if (
      this.#snapshot.session === "checking" ||
      (this.#snapshot.connection === "offline" && reason !== "interval")
    ) {
      this.#hostUnreachable = false;
      this.#update({ ...this.#snapshot, connection: "connecting" });
    }
    if (this.#readCapabilities)
      await this.#refreshCapabilities(revalidateCapabilities ? { revalidate: true } : undefined);
    if (generation !== this.#viewerGeneration || this.#disposed) return;
    bootstrapReadDiagnostics.start(reason);
    const response = await this.rpc["bootstrap.get"]({});
    if (!response.ok && response.error.code === "unauthorized") {
      if (generation === this.#viewerGeneration) this.#expireSession();
      const authGeneration = this.#viewerGeneration,
        identityConfig = unwrapRpcResult(await this.rpc["auth.config"]({}));
      if (authGeneration === this.#viewerGeneration && !this.#disposed)
        this.#update({ ...this.#snapshot, identityConfig, connection: "connected" });
      return;
    }
    if (generation !== this.#viewerGeneration || this.#disposed) return;
    this.#hostUnreachable =
      !response.ok && ![...this.#channels.values()].some((channel) => channel.synchronized);
    if (this.#hostUnreachable) this.#update({ ...this.#snapshot, connection: "offline" });
    const payload = unwrapRpcResult(response);
    if (generation !== this.#viewerGeneration || this.#disposed) return;
    if (
      (this.#snapshot.user && this.#snapshot.user.id !== payload.user.id) ||
      (this.#snapshot.deploymentId && this.#snapshot.deploymentId !== payload.deploymentId)
    ) {
      this.#expireSession();
      generation = this.#viewerGeneration;
    }
    const environments = payload.environments.map((environment) => ({ ...environment }));
    const harnesses = payload.harnesses.map(({ config, ...harness }) => ({
      ...harness,
      ...harnessEndpoint(config),
    }));
    const patchedSince = (sessionId: string) =>
      (this.#presenceMarks.get(sessionId) ?? 0) > presenceMark;
    const threads = this.#snapshot.threads.map((thread) => ({
      ...thread,
      harnessLabel:
        harnesses.find((harness) => harness.id === thread.harnessInstanceId)?.name ??
        "Unavailable harness",
      runnerLabel:
        environments.find((environment) => environment.id === thread.environmentId)?.name ??
        "Unavailable work location",
      modelLabel: modelLabel(thread.modelSelection, environments),
    }));
    this.#update({
      ...this.#snapshot,
      ...shareBootstrapData(this.#snapshot, {
        deploymentId: payload.deploymentId,
        personalSettings: payload.personalSettings,
        can: payload.can,
        voiceThreadId: payload.personalSettings?.voiceThreadId ?? null,
        environments,
        harnesses,
        deploymentShape: { kind: "personal" },
        browserAvailable: payload.browser.available,
        browserPlacements: payload.browser.placements,
        browserProfiles: payload.browser.profiles,
        browserProfileHomes: payload.browser.profileHomes,
        browserProfileDeletions: payload.browser.profileDeletions,
        tabRestoreVersion: payload.browser.tabRestoreVersion,
        browserTabGroups: this.#tabGroups.receive(payload.browser.tabGroups),
        ...this.#applyAppTabs(
          appTabMark === this.#appTabGeneration
            ? this.#overlayAppTabs(payload.appTabs)
            : (this.#snapshot.appTabs ?? []),
        ),
        executionPreferences: payload.executionPreferences,
        quietTaskDays: payload.quietTaskDays,
        identityConfig: payload.identityConfig,
        threads,
        machines: payload.machines.map((machine) =>
          this.#ownerViews.reread(
            withNewerComputerPresence(machine, this.#snapshot.machines, patchedSince),
            this.#snapshot.machines.find((current) => current.id === machine.id),
            ownerViewRevision,
          ),
        ),
        ownerName: payload.user.displayName,
        session: "authenticated",
        sessionId: payload.sessionId,
        sessionSurface: payload.sessionSurface,
        user: payload.user,
      }),
    });
    if (this.#browserTabs.seed({ groups: payload.browser.groups, tabs: payload.browser.tabs }))
      this.#browserContinuation = payload.browser.continuation;
    if (!this.#cacheLoaded && this.#streamCache) {
      this.#cacheLoaded = true;
      await this.#checkpointWrite.catch(() => undefined);
      const cached = await this.#streamCache
        .load({
          deploymentId: payload.deploymentId,
          userId: payload.user.id,
          apiVersion: hostApiVersion,
        })
        .catch(() => null);
      if (generation !== this.#viewerGeneration || this.#disposed) return;
      if (
        cached &&
        cached.cursor.deploymentId === payload.deploymentId &&
        cached.cursor.apiVersion === hostApiVersion &&
        cached.scope.userId === payload.user.id &&
        cached.scope.deploymentId === payload.deploymentId &&
        cached.scope.apiVersion === hostApiVersion
      ) {
        this.#threadState.restore(cached.threadStates);
        this.#savedViewReadiness = { tasksReady: true };
        this.#update({
          ...this.#snapshot,
          threadVisits: cached.snapshot.threadVisits,
          tasks: cached.snapshot.tasks,
          activeTasks: cached.snapshot.activeTasks,
          threads: cached.snapshot.threads,
          transcripts: cached.snapshot.transcripts,
          transcriptWindows: cached.snapshot.transcriptWindows,
          requests: cached.snapshot.requests,
          waitingRequests: cached.snapshot.waitingRequests,
          needsYou: cached.snapshot.needsYou,
        });
        this.#restoredCursor = cached.cursor.afterSequence;
      }
    }
    this.#ensureDeploymentChannel(payload.deploymentId);
    this.#recomputeConnection();
    this.#startRefresh();
    this.#reportTimeZone();
  }

  #startRefresh(): void {
    if (this.#refreshTimer || this.#refreshIntervalMs === 0) return;
    if (this.#visibility === "background") return;
    this.#refreshTimer = globalThis.setInterval(() => {
      void this.#bootstrap("interval").catch(() => undefined);
    }, this.#refreshIntervalMs);
  }

  #stopRefresh(): void {
    if (this.#refreshTimer) globalThis.clearInterval(this.#refreshTimer);
    this.#refreshTimer = null;
  }

  #observeLifecycle(lifecycle: ClientLifecycle): void {
    this.#lifecycleDisposers.push(
      lifecycle.onBackground(() => this.#enterBackground()),
      lifecycle.onForeground(() => this.#enterForeground()),
      lifecycle.onNetworkChange((state, path) => this.#networkChanged(state, path)),
    );
  }

  /**
   * Hidden work is work nobody is reading. The timers stop so a backgrounded
   * app neither polls nor burns reconnect backoff, and the sockets stay: the
   * operating system may tear them down, and discovering that on the way back
   * is cheaper than closing sockets that are still good.
   */
  #enterBackground(): void {
    if (this.#disposed || this.#visibility === "background") return;
    this.#visibility = "background";
    this.#targetedControl.suspend(true, this.#network !== "offline");
    this.#targetedWatch.suspend(true);
    for (const listener of this.#lifecycleListeners) listener("background");
    this.#backgroundedAt = Date.now();
    this.#stopRefresh();
    this.#clearInterruptionHold();
    this.#update({ ...this.#snapshot, connectionInterrupted: false });
    if (!this.#notifiesWhileHidden()) {
      for (const channel of this.#channels.values()) {
        this.#clearProbe(channel);
        if (channel.reconnectTimer) globalThis.clearTimeout(channel.reconnectTimer);
        channel.reconnectTimer = null;
      }
    }
  }

  #enterForeground(): void {
    if (this.#disposed || this.#visibility === "foreground") return;
    const backgroundedForMs = Date.now() - (this.#backgroundedAt ?? Date.now());
    this.#pendingBrowserTabs.checkDeadlines();
    this.#visibility = "foreground";
    this.#targetedControl.suspend(this.#network === "offline");
    this.#targetedWatch.suspend(this.#network === "offline");
    for (const listener of this.#lifecycleListeners) listener("foreground");
    this.#backgroundedAt = null;
    this.#beginConnectionAttempt();
    this.#update(this.#snapshot);
    const trusted = backgroundedForMs < this.#socketTrustWindowMs && this.#network !== "offline";
    for (const channel of this.#channels.values()) {
      if (trusted && channel.socket?.readyState === 1) {
        this.#probeChannel(channel);
        continue;
      }
      this.#replaceChannel(channel);
    }
    this.#recomputeConnection();
    this.#startRefresh();
    if (this.#snapshot.session === "authenticated")
      void this.#refresh("foreground").catch(() => undefined);
  }

  /**
   * A handover to another network invalidates every open socket at once, and
   * the interface it left will never report their death. Wi-Fi to cellular is
   * reported as `online` both before and after, so it is the notification that
   * invalidates, never a change in its value — the one exception being a
   * device that is still off the network, where there is nothing to replace.
   * Going offline stops the backoff instead of spending it against an
   * interface that cannot carry the packets. A phone also reports paths that
   * did not move, so a `same` notification costs one ping, and only a socket
   * that does not answer shows the path was lost.
   */
  #networkChanged(state: ClientNetworkState, path: ClientNetworkPath): void {
    if (this.#disposed) return;
    if (state === "offline" && this.#network === "offline") return;
    if (path === "same" && state === this.#network) {
      if (this.#deploymentReconnectSuspended()) return;
      for (const channel of this.#channels.values())
        this.#probeChannel(channel, socketProbeDeadlineMs, true);
      return;
    }
    this.#network = state;
    this.#followNetwork();
  }

  #followNetwork(): void {
    this.#beginConnectionAttempt();
    this.#targetedControl.suspend(this.#reconnectSuspended(), this.#network !== "offline");
    this.#targetedWatch.suspend(this.#reconnectSuspended());
    this.#targetedControl.reconnect();
    this.#targetedWatch.reconnect();
    for (const channel of this.#channels.values()) this.#replaceChannel(channel);
    this.#recomputeConnection();
    for (const listener of this.#lifecycleListeners) listener("network");
  }

  /** Reconnecting is pointless while the app is hidden or the device is off
   * the network; the next foreground or online signal resumes every channel. */
  #reconnectSuspended(): boolean {
    return this.#visibility === "background" || this.#network === "offline";
  }

  #deploymentReconnectSuspended(): boolean {
    return (
      this.#network === "offline" || (this.#reconnectSuspended() && !this.#notifiesWhileHidden())
    );
  }

  #notifiesWhileHidden(): boolean {
    return this.#notificationListeners.size > 0;
  }

  #probeChannel(
    channel: DeploymentChannel,
    deadlineMs = socketProbeDeadlineMs,
    followNetwork = false,
  ): void {
    const socket = channel.socket;
    if (!socket || socket.readyState !== 1) return;
    // A probe already in the air answers this question too, so it inherits it.
    channel.probeFollowsNetwork ||= followNetwork;
    if (channel.probeTimer) return;
    const nonce = globalThis.crypto.randomUUID();
    const progressAt = channel.progressAt;
    channel.probeNonce = nonce;
    channel.probeTimer = globalThis.setTimeout(() => {
      const follow = channel.probeFollowsNetwork;
      channel.probeTimer = null;
      channel.probeNonce = null;
      channel.probeFollowsNetwork = false;
      // A client that stopped reading meanwhile judges the socket on its way back,
      // and one whose subscription delivered since asking has its answer already:
      // on a slow route the reply can queue behind the very frames that prove it.
      if (
        channel.socket !== socket ||
        channel.progressAt !== progressAt ||
        this.#deploymentReconnectSuspended()
      )
        return;
      if (follow) {
        this.#followNetwork();
        return;
      }
      this.#replaceChannel(channel, "Liveness probe unanswered");
      this.#recomputeConnection();
    }, deadlineMs);
    try {
      socket.send(JSON.stringify({ nonce, type: "client.ping" }));
    } catch {
      this.#replaceChannel(channel, "Liveness probe unsendable");
      this.#recomputeConnection();
      return;
    }
    this.#watchLiveness();
  }

  #clearProbe(channel: DeploymentChannel): void {
    if (channel.probeTimer) globalThis.clearTimeout(channel.probeTimer);
    channel.probeTimer = null;
    channel.probeNonce = null;
    channel.probeFollowsNetwork = false;
  }

  /**
   * No transport reports every way a socket can die: a route can stall with
   * the socket still open, and a close can be lost on its way to the reader.
   * So a channel whose subscription has gone quiet is asked whether it is
   * there, and one that cannot be asked — still connecting, never
   * synchronized, or no longer open — is given the same time before it is
   * replaced. The answer proves the socket carries frames both ways; that an
   * open socket's subscription is still delivering is the Host's to keep, by
   * closing any socket it stops delivering to.
   */
  #watchLiveness(): void {
    if (this.#livenessTimer || this.#disposed) return;
    this.#livenessTimer = globalThis.setInterval(
      () => this.#checkLiveness(),
      Math.max(1, Math.floor(this.#livenessDeadlineMs / 2)),
    );
  }

  #stopLiveness(): void {
    if (this.#livenessTimer) globalThis.clearInterval(this.#livenessTimer);
    this.#livenessTimer = null;
  }

  #checkLiveness(): void {
    // Nothing is judged while the client is not reading: a suspended channel
    // is replaced on the way back, by the foreground and network signals.
    if (
      this.#disposed ||
      this.#snapshot.session !== "authenticated" ||
      this.#deploymentReconnectSuspended()
    ) {
      this.#stopLiveness();
      return;
    }
    const now = Date.now();
    let watched = false;
    for (const channel of this.#channels.values()) {
      const socket = channel.socket;
      if (!socket) continue;
      watched = true;
      const silentMs = now - channel.progressAt;
      if (silentMs < this.#livenessIdleMs) continue;
      if (channel.synchronized && socket.readyState === 1) {
        this.#probeChannel(channel, this.#livenessDeadlineMs);
      } else if (silentMs >= this.#livenessIdleMs + this.#livenessDeadlineMs) {
        this.#closeChannel(channel, true, 1000, "Realtime channel silent");
        this.#recomputeConnection();
      }
    }
    if (!watched) this.#stopLiveness();
  }

  /** Drops the current socket and opens its replacement at once, keeping the
   * cursor so the Host resumes the stream rather than restarting it. */
  #replaceChannel(channel: DeploymentChannel, reason = "Client closed"): void {
    this.#closeChannel(channel, false, 1000, reason);
    if (this.#deploymentReconnectSuspended()) return;
    if (this.#snapshot.session !== "authenticated") return;
    channel.reconnectAttempt = 0;
    this.#connect(channel);
  }

  async #waitBrowser(read: () => unknown, signal?: AbortSignal): Promise<void> {
    if (read()) return;
    const viewer = this.#viewer.generation;
    let release = () => {};
    let check = () => {};
    const ready = new Promise<void>((resolve, reject) => {
      check = () => {
        if (this.#disposed || viewer !== this.#viewer.generation)
          reject(new Error("The browser viewer changed."));
        else if (read()) resolve();
      };
      release = this.#browserTabs.subscribe(check);
      this.#browserWaiters.add(check);
      check();
    });
    try {
      await withTimeout(ready, browserOpeningTimeoutMs, {
        ...(signal ? { signal } : {}),
        timeoutError: () => new Error("The browser tab did not arrive."),
      });
    } finally {
      release();
      this.#browserWaiters.delete(check);
    }
  }

  #resyncBrowser(groupId?: string, continuation?: string): void {
    const carrier = this.#browserCarrier;
    if (!carrier?.socket || carrier.socket.readyState !== 1) return;
    try {
      carrier.socket.send(
        JSON.stringify({
          type: "client.browser.resync",
          ...(groupId ? { groupId } : {}),
          ...(continuation ? { continuation } : {}),
        }),
      );
    } catch {
      this.#closeChannel(carrier, true, 1000, "Browser resync unsendable");
    }
  }
  #electBrowserCarrier(): void {
    if (this.#browserCarrier || this.#disposed || this.#snapshot.session !== "authenticated")
      return;
    this.#browserCarrier =
      [...this.#channels.values()].find((channel) => channel.socket?.readyState === 1) ?? null;
    this.#resyncBrowser(undefined, this.#browserContinuation);
    this.#browserContinuation = undefined;
  }
  #releaseBrowserCarrier(channel: DeploymentChannel): void {
    if (channel !== this.#browserCarrier) return;
    this.#browserCarrier = null;
    this.#browserTabs.disconnected();
    this.#electBrowserCarrier();
  }

  #ensureDeploymentChannel(deploymentId: string): void {
    if (this.#disposed || this.#snapshot.session !== "authenticated") return;
    const existing = this.#channels.get(deploymentId);
    if (existing?.socket || existing?.reconnectTimer) return;
    const channel =
      existing ??
      ({
        cursor: this.#restoredCursor ?? zeroSequence,
        refused: false,
        probeFollowsNetwork: false,
        probeNonce: null,
        probeTimer: null,
        progressAt: 0,
        reconnectAttempt: 0,
        reconnectTimer: null,
        socket: null,
        synchronized: false,
        unreadableFrames: 0,
        unreadableRetryAt: 0,
        deploymentId,
      } satisfies DeploymentChannel);
    this.#channels.set(deploymentId, channel);
    this.#connect(channel);
  }

  #connect(channel: DeploymentChannel): void {
    if (this.#disposed || channel.socket || channel.refused) return;
    // A bootstrap or refresh started before the app was hidden still resolves

    // nobody can read. The channel and its cursor stay, so the next foreground
    // or network signal opens the socket and resumes the stream.
    if (this.#deploymentReconnectSuspended()) return;
    // Each try can cost a whole snapshot, and a phone reports its network often,
    // so only the person's Retry starts one before its time.
    const wait = channel.unreadableFrames > 0 ? channel.unreadableRetryAt - Date.now() : 0;
    if (wait > 0) {
      channel.reconnectTimer ??= globalThis.setTimeout(() => {
        channel.reconnectTimer = null;
        this.#connect(channel);
      }, wait);
      return;
    }
    // A reused channel may now reach a restarted or upgraded Host at the same
    // identity and route. Discovery is refreshed even when no bootstrap is due.
    if (channel.progressAt > 0 || channel.reconnectAttempt > 0) this.#reverifyCapabilities();
    let socket: WebSocketClient;
    try {
      socket = this.#webSocketFactory(this.#webSocketUrl("/v1/realtime"));
    } catch {
      // A channel holds a socket or a retry; one the platform refused to open
      // is a failed attempt like any other.
      this.#scheduleReconnect(channel);
      this.#recomputeConnection();
      return;
    }
    channel.socket = socket;
    channel.progressAt = Date.now();
    if (channel.unreadableFrames > 0)
      channel.unreadableRetryAt =
        Date.now() + this.#retryDelay(channel.reconnectAttempt, channel.unreadableFrames);
    // A new socket is a new subscription: a stream reread asked for under the
    // old one answers about streams this one starts over.
    this.#heldLive.delete(channel.deploymentId);
    this.#liveGenerations.set(
      channel.deploymentId,
      (this.#liveGenerations.get(channel.deploymentId) ?? 0) + 1,
    );
    channel.reconnectTimer = null;
    channel.synchronized = false;
    this.#clearProbe(channel);
    this.#recomputeConnection();
    this.#watchLiveness();
    const viewer: SocketViewer = {
      deploymentId: this.#snapshot.deploymentId,
      userId: this.#snapshot.user?.id ?? null,
    };

    socket.addEventListener("open", () => {
      if (channel.socket !== socket) return;
      channel.progressAt = Date.now();
      try {
        socket.send(
          JSON.stringify({
            cursor: {
              deploymentId: channel.deploymentId,
              apiVersion: hostApiVersion,
              afterSequence: channel.cursor,
            },
            // The realtime half of the same negotiation the rpc header carries:
            // an upgraded Host refuses the stream before sending an event this
            // app would read with the wrong meaning.
            apiVersion: hostApiVersion,
            ...(this.#capabilities?.includes("person-show-v1") ? { personShow: "accept" } : {}),
            ...(this.#capabilities?.includes("tool-output-detail-v1")
              ? { toolOutputs: "preview" }
              : {}),
            ...(this.#capabilities?.includes("place-events-v1")
              ? { placeEvents: "include" as const }
              : {}),
            ...(this.#capabilities?.includes("snapshot-messages-omit-v1")
              ? { snapshotMessages: "omit" }
              : {}),
            threadId: null,
            type: "client.subscribe",
          }),
        );
        this.#electBrowserCarrier();
      } catch {
        this.#closeChannel(channel, true, 1000, "Subscription unsendable");
        this.#recomputeConnection();
      }
    });
    socket.addEventListener("message", (event) => {
      if (channel.socket !== socket) return;
      let message: RealtimeMessage | null;
      try {
        message = this.#readRealtimeFrame(channel, event.data);
      } catch (error) {
        if (channel.socket === socket) this.#loseRealtimeFrame(channel, event.data, error);
        return;
      }
      if (!message) return;
      try {
        this.#applyRealtimeMessage(channel, viewer, message);
      } catch {
        // A transport effect (including acknowledgement) cannot invalidate a
        // frame already parsed and admitted, or the progress already applied.
        if (channel.socket !== socket) return;
        this.#closeChannel(channel, true, 1000, "Realtime transport interrupted");
        this.#recomputeConnection();
      }
    });
    socket.addEventListener("error", () => {
      if (channel.socket === socket) this.#recomputeConnection();
    });
    socket.addEventListener("close", () => {
      if (channel.socket !== socket) return;
      channel.socket = null;
      channel.synchronized = false;
      this.#releaseBrowserCarrier(channel);
      this.#nodeDetails.disconnected(channel.deploymentId);
      this.#scheduleReconnect(channel);
      this.#recomputeConnection();
    });
  }

  #readRealtimeFrame(channel: DeploymentChannel, frame: unknown): RealtimeMessage | null {
    if (typeof frame !== "string" || frame.length > maxInboundFrameCharacters) {
      throw new Error("Host protocol frame must be bounded JSON text.");
    }
    const value: unknown = JSON.parse(frame);
    const { type } = realtimeHeaderSchema.parse(value);
    if (!realtimeEnvelopeTypes.has(type)) {
      const parsed = HostToClientMessageSchema.safeParse(value);
      if (!parsed.success) this.#recordRealtimeFrame(frame, parsed.error, "ignored");
      return null;
    }
    if (type === "host.events") {
      const batch = realtimeEventsSchema.parse(value);
      const positions = batch.events.map((raw) => realtimeEventPositionSchema.parse(raw));
      const ignoredIssues: z.ZodError["issues"] = [];
      const events = batch.events.map((raw, index): RealtimeEvent => {
        try {
          const eventType = realtimeHeaderSchema.parse(raw).type;
          let skip = !realtimeEventTypes.has(eventType);
          if (eventType === "thread.state-changed") {
            const candidate = realtimeThreadStateEventSchema.parse(raw);
            skip = !ThreadStatusSchema.safeParse(candidate.data.status).success;
          } else if (
            eventType === "thread.created" ||
            eventType === "thread.execution-updated" ||
            eventType === "thread.listed"
          ) {
            const { thread } = realtimeThreadEventSchema.parse(raw).data;
            skip = !ThreadStatusSchema.safeParse(thread.status).success;
          }
          if (!skip) return AgentEventViewSchema.parse(raw);
          const parsed = AgentEventViewSchema.safeParse(raw);
          if (!parsed.success)
            ignoredIssues.push(
              ...parsed.error.issues.map((issue) => ({
                ...issue,
                path: ["events", index, ...issue.path],
              })),
            );
          return { ...positions[index]!, type: null };
        } catch (error) {
          if (error instanceof z.ZodError)
            throw new z.ZodError(
              error.issues.map((issue) => ({ ...issue, path: ["events", index, ...issue.path] })),
            );
          throw error;
        }
      });
      if (ignoredIssues.length > 0)
        this.#recordRealtimeFrame(frame, new z.ZodError(ignoredIssues), "ignored");
      const throughSequence = z
        .object({ throughSequence: SequenceSchema })
        .parse(value).throughSequence;
      if (events.some((event) => compareSequence(event.sequence, throughSequence) > 0))
        throw new Error("Event exceeds the applied-through watermark.");
      return { type: "host.events", events, throughSequence };
    }
    if (type === "host.snapshot") {
      const raw = realtimeSnapshotFrameSchema.parse(value).snapshot;
      const { snapshot } = z
        .object({ snapshot: DeploymentSnapshotSchema })
        .parse({ snapshot: { ...raw, threads: [] } });
      if (snapshot.deploymentId !== channel.deploymentId)
        throw new Error("Deployment snapshot mismatch.");

      const ignoredIssues: z.ZodError["issues"] = [];
      const threads = raw.threads.flatMap((thread, index) => {
        const parsed = ThreadViewSchema.safeParse(thread);
        if (parsed.success) return [parsed.data];
        ignoredIssues.push(
          ...parsed.error.issues.map((issue) => ({
            ...issue,
            path: ["snapshot", "threads", index, ...issue.path],
          })),
        );
        return [];
      });
      if (ignoredIssues.length > 0)
        this.#recordRealtimeFrame(frame, new z.ZodError(ignoredIssues), "ignored");
      return { type: "host.snapshot", snapshot: { ...snapshot, threads } };
    }
    if (type === "host.resync-required") {
      const message = realtimeResyncSchema.parse(value);

      return message;
    }
    if (type === "host.live") {
      const live = realtimeLiveEnvelopeSchema.parse(value);
      const items = live.progress.items.flatMap((raw, index) => {
        const kind = z.object({ stream: z.string().min(1), op: z.string().min(1) }).parse(raw);
        if (
          !["assistant", "reasoning", "tool", "node"].includes(kind.stream) ||
          !["append", "replace"].includes(kind.op)
        ) {
          const parsed = realtimeLiveKindSchema.safeParse(raw);
          if (!parsed.success)
            this.#recordRealtimeFrame(
              frame,
              new z.ZodError(
                parsed.error.issues.map((issue) => ({
                  ...issue,
                  path: ["progress", "items", index, ...issue.path],
                })),
              ),
              "ignored",
            );
          return [];
        }
        return [LiveItemViewSchema.parse(raw)];
      });
      if (items.length === 0) return null;
      return { ...live, type: "host.live", progress: { ...live.progress, items } };
    }
    const message = HostToClientMessageSchema.parse(value);
    if (
      (message.type === "host.show" ||
        message.type === "host.thread-visits" ||
        message.type === "host.triggers-changed" ||
        message.type === "host.browser-usage-changed" ||
        message.type === "host.synchronized") &&
      channel.deploymentId !== channel.deploymentId
    )
      throw new Error("Deployment mismatch.");
    return message;
  }

  #recordRealtimeFrame(frame: unknown, error: unknown, action: "ignored" | "rejected"): void {
    try {
      const record = {
        event: `host.realtime.frame-${action}` as const,
        ...describeRealtimeFrameFailure(frame, error),
      };
      console.warn(JSON.stringify(record));
      this.#reportRealtimeFrame?.(record);
    } catch {
      /* Diagnostics cannot decide what becomes of the channel. */
    }
  }

  /**
   * What losing an unreadable frame costs decides what happens. A notice is
   * dropped and its data reread. A replay or sync frame is never applied or
   * acknowledged: the channel reconnects from the same cursor, or from a
   * snapshot when replay cannot resend it or get past what it cannot read.
   */
  #loseRealtimeFrame(channel: DeploymentChannel, frame: unknown, error: unknown): void {
    const loss = realtimeFrameLoss(realtimeEnvelopeType(frame));
    const reconnects = loss === "replay" || loss === "snapshot";
    this.#recordRealtimeFrame(frame, error, reconnects ? "rejected" : "ignored");
    if (reconnects) {
      channel.unreadableFrames += 1;
      if (loss === "snapshot" || channel.unreadableFrames >= realtimeReplayAttempts)
        channel.cursor = zeroSequence;
      this.#closeChannel(channel, true, 4002, "Invalid Host protocol frame");
      this.#recomputeConnection();
      return;
    }
    switch (loss) {
      case "browser-stream":
        if (channel === this.#browserCarrier) {
          this.#browserTabs.disconnected();
          this.#resyncBrowser();
        }
        return;
      case "none":
        return;
      case "place-activity":
        this.#placeActivity.clear();
        return;
      case "browser-history":
        this.browserHistory.changedAll();
        return;
      case "browser-usage":
        this.#browserUsageChanged([
          ...new Set([...this.#browserUsageRead.keys(), ...this.#browserUsageReads.keys()]),
        ]);
        return;
      case "triggers":
        this.#triggersChanged(channel.deploymentId);
        return;
      case "machines":
        this.#update({ ...this.#snapshot, machineRevision: this.#snapshot.machineRevision + 1 });
        break;
      case "bootstrap":
        break;
    }
    this.#rereadLostFrame();
  }

  /** Tab frames arrive with every navigation, so reads are spaced and the last is owed, not lost. */
  #rereadLostFrame(): void {
    if (this.#lostFrameRereadTimer) return;
    const wait = this.#lostFrameRereadAt + defaultRefreshIntervalMs - Date.now();
    if (wait > 0) {
      this.#lostFrameRereadTimer = globalThis.setTimeout(() => {
        this.#lostFrameRereadTimer = null;
        this.#rereadLostFrame();
      }, wait);
      return;
    }
    this.#lostFrameRereadAt = Date.now();
    this.#reread("host.frame-lost");
  }

  #cancelLostFrameReread(): void {
    if (this.#lostFrameRereadTimer) globalThis.clearTimeout(this.#lostFrameRereadTimer);
    this.#lostFrameRereadTimer = null;
  }

  #applyRealtimeMessage(
    channel: DeploymentChannel,
    viewer: SocketViewer,
    message: RealtimeMessage,
  ): void {
    // Notices addressed to the person arrive on every socket they hold, so
    // only what this channel's own subscription sends shows it is delivering.
    if (showsSubscriptionProgress(message, channel)) channel.progressAt = Date.now();
    if (message.type === "host.show") {
      if (
        this.#visibility !== "foreground" ||
        this.#disposed ||
        this.#snapshot.session !== "authenticated" ||
        viewer.userId === null ||
        this.#snapshot.user?.id !== viewer.userId ||
        this.#snapshot.deploymentId !== viewer.deploymentId
      )
        return;
      for (const listener of this.#personShowListeners) {
        try {
          listener(message);
        } catch (error) {
          queueMicrotask(() => {
            throw error;
          });
        }
      }
      return;
    }
    if (message.type === "host.pong") {
      // Only a probe is correlated; an uncorrelated pong answers nobody.
      if (message.nonce === channel.probeNonce) this.#clearProbe(channel);
      return;
    }
    if (message.type === "host.notification") {
      // every socket they hold and moves no cursor.
      this.#deliverNotification(message.notification, viewer);
      return;
    }
    if (
      message.type === "host.computer-view.changed" ||
      message.type === "host.computer-view.removed"
    ) {
      this.#update({
        ...this.#snapshot,
        machines: [
          ...(message.type === "host.computer-view.changed"
            ? this.#ownerViews.accept(this.#snapshot.machines, message.view)
            : this.#ownerViews.remove(this.#snapshot.machines, message)),
        ],
      });
      return;
    }
    if (message.type === "host.thread-visits") {
      this.#applyVisits(message.visits);
      return;
    }
    if (message.type === "host.error") {
      if (!message.error.retryable && message.error.code === "forbidden") {
        this.#expireSession();
        return;
      }
      if (message.error.reason === "unsupported-version") this.#reverifyCapabilities();
      // The Host refused this channel. A retryable refusal is a transport
      // fault and takes the backoff; a final one leaves the channel down, and
      // the connection state is where a reader learns that.
      channel.refused = !message.error.retryable;
      this.#closeChannel(channel, message.error.retryable);
      this.#recomputeConnection();
      return;
    }
    if (message.type === "host.resync-required") {
      channel.cursor = zeroSequence;
      channel.reconnectAttempt = 0;
      this.#closeChannel(channel, true, 4009, "Fresh snapshot required");
      this.#recomputeConnection();
      return;
    }
    if (message.type === "host.snapshot") {
      this.#applyDeploymentSnapshot(message.snapshot);
      channel.cursor = message.snapshot.sequence;
      this.#persistCheckpoint(channel);
      return;
    }
    if (message.type === "host.node-watched") {
      this.#nodeDetails.watched(channel.deploymentId, message.nodeId, message.sequence);
      return;
    }
    if (message.type === "host.events") {
      this.#applyEvents(channel, message.events);
      channel.cursor = maxSequence(channel.cursor, message.throughSequence);
      this.#persistCheckpoint(channel);
      this.#sendAck(channel);
      this.#recomputeConnection();
      return;
    }
    if (message.type === "host.live") {
      // Progress never moves the cursor and never acknowledges: it is not
      // durable, and nothing replays it.
      this.#applyLive(message);
      return;
    }
    if (message.type === "host.triggers-changed") {
      this.#triggersChanged(channel.deploymentId);
      return;
    }
    if (message.type === "host.browser-history-changed") {
      this.browserHistory.changed(message.profileId);
      return;
    }
    if (
      message.type === "host.app-tabs-changed" ||
      message.type === "host.browser-sessions-changed"
    ) {
      this.#reread(message.type);
      return;
    }
    if (message.type === "host.thread-place-changed") {
      return;
    }
    if (message.type === "host.place-activity" || message.type === "host.place-activity-cleared") {
      this.#placeActivity.apply(message);
      return;
    }
    if (message.type === "host.browser-usage-changed") {
      this.#browserUsageChanged(message.threadIds);
      return;
    }
    if (message.type === "host.computer-presence") {
      this.#applyComputerPresence(message.sessions);
      return;
    }
    if (message.type === "host.personal-remote-access-changed") {
      this.#invalidatePersonalRemoteAccess();
      return;
    }
    if (message.type === "host.connections-changed") {
      for (const listener of this.#connectionsListeners) listener();
      return;
    }
    if (message.type === "host.plugins-changed") {
      for (const listener of this.#pluginsChangedListeners) listener(message);
      return;
    }
    if (message.type === "host.requests-changed") {
      this.#rereadWaitingRequests();
      return;
    }
    if (message.type === "host.tasks-changed") {
      this.#rereadTasks();
      return;
    }
    if (
      message.type === "host.machines.changed" ||
      message.type === "host.machine.access.session.started" ||
      message.type === "host.machine.access.session.ended"
    ) {
      // Machine state also says, in a Thread, when its turn is at work on a Mac.
      // Refresh it here so correctness never depends on mounting Computers.
      this.#update({ ...this.#snapshot, machineRevision: this.#snapshot.machineRevision + 1 });
      this.#reread(message.type);
      return;
    }
    if (message.type === "host.browser-groups" || message.type === "host.browser-tabs") {
      if (channel !== this.#browserCarrier) return;
      if (message.type === "host.browser-groups") this.#browserTabs.applyGroups(message.stream);
      else this.#browserTabs.applyTabs(message.groupId, message.stream);
      return;
    }
    channel.cursor = maxSequence(channel.cursor, message.sequence);
    this.#persistCheckpoint(channel);
    // A resubscription sends every open stream whole right after this, so what
    // the old connection streamed is forgotten rather than continued, and any
    // reread still in flight belongs to the old subscription.
    this.#live.reset();
    this.#heldLive.delete(channel.deploymentId);
    this.#liveGenerations.set(
      channel.deploymentId,
      (this.#liveGenerations.get(channel.deploymentId) ?? 0) + 1,
    );
    // A stream the old connection drew that the new one does not carry would
    // otherwise stay on screen half-written; a reread says which are still open.
    for (const thread of this.#snapshot.threads) {
      if (this.#snapshot.deploymentId! !== channel.deploymentId) continue;
      if (this.#snapshot.transcripts[thread.id]?.some((entry) => drawnLiveStream(entry) !== null))
        this.#scheduleLiveRefresh(thread.id, channel.deploymentId);
    }
    const reconnected = channel.reconnectAttempt > 0 || channel.unreadableFrames > 0;
    channel.synchronized = true;
    this.#nodeDetails.connected(channel.deploymentId);
    channel.reconnectAttempt = 0;
    channel.unreadableFrames = 0;
    this.#invalidatePersonalRemoteAccess();
    if (reconnected) this.#reread("reconnect");
    this.#sendAck(channel);
    this.#recomputeConnection();
    // A task notice sent while this socket was away is lost with it, and so is
    // a triggers notice.
    if (reconnected) {
      this.#rereadTasks();
      this.#rereadWaitingRequests();
    }
    if (reconnected) this.#refreshShownAutomations(channel.deploymentId);
    // A usage notice sent while this socket was away is lost: a shown

    // and one not shown is read whole when it next is. One shown while the
    // stream was not live has waited for it, and is read for the first time;
    // a read already under way began before the stream and is read again.
    for (const threadId of this.#browserUsageRead.keys()) {
      if (this.#threadDeployment.get(threadId) !== channel.deploymentId) continue;
      if (this.#showsThread(threadId)) this.#ensureBrowserUsage(threadId, "full");
      else this.#browserUsageRead.delete(threadId);
    }
    for (const threadId of [this.#activeThreadId, ...this.#observedThreads.keys()]) {
      if (!threadId || this.#threadDeployment.get(threadId) !== channel.deploymentId) continue;
      if (this.#browserUsageRead.has(threadId)) continue;
      this.#ensureBrowserUsage(
        threadId,
        this.#browserUsageReads.has(threadId) ? "full" : "missing",
      );
    }
  }

  #applyDeploymentSnapshot(snapshot: DeploymentSnapshot): void {
    if (snapshot.deploymentId !== this.#snapshot.deploymentId)
      throw new Error("Snapshot Deployment mismatch.");
    const inFlight = [...this.#hydrationBuffers.keys()];
    const coversSnapshot = (threadId: string) => {
      const sequence = this.#hydratedThreads.get(threadId);
      return sequence !== undefined && compareSequence(sequence, snapshot.sequence) >= 0;
    };
    const retainsHistory = (threadId: string) =>
      this.#historicalThreads.has(threadId) ||
      this.#showsThread(threadId) ||
      coversSnapshot(threadId);
    this.#mergeVisits([
      ...snapshot.threads,
      ...snapshot.tasks.recent.tasks.map((entry) => entry.thread),
      ...snapshot.tasks.active.tasks.map((entry) => entry.thread),
      ...snapshot.tasks.done.tasks.map((entry) => entry.thread),
    ]);
    this.#threadState.cover(snapshot.sequence);
    this.#runQueue.reconcile({
      runQueue: snapshot.runQueue,
      threads: new Map(snapshot.threads.map(({ id }) => [id, snapshot.sequence])),
      wholeDeployment: true,
    });
    if (snapshot.runPlaces) this.#runPlaces.reconcile(snapshot.sequence, snapshot.runPlaces);
    const transcripts = { ...this.#snapshot.transcripts };
    const transcriptWindows = { ...this.#snapshot.transcriptWindows };
    const requests = { ...this.#snapshot.requests };
    const inputQueues = { ...this.#snapshot.inputQueues };
    const incoming = new Set<string>(snapshot.threads.map(({ id }) => id));
    for (const existing of this.#snapshot.threads) {
      if (incoming.has(existing.id) || this.#showsThread(existing.id)) continue;
      this.#historicalThreads.delete(existing.id);
      this.#hydratedThreads.delete(existing.id);
      delete transcripts[existing.id];
      delete transcriptWindows[existing.id];
      delete requests[existing.id];
      delete inputQueues[existing.id];
    }
    for (const thread of snapshot.threads) {
      requests[thread.id] = snapshot.pendingRequests.filter(
        (request) => request.originatingThreadId === thread.id,
      );
      this.#requestReads.delete(thread.id);
      if (retainsHistory(thread.id)) continue;
      if (snapshot.messagesOmitted) {
        delete transcripts[thread.id];
        delete transcriptWindows[thread.id];
      } else transcripts[thread.id] = [];
      this.#hydratedThreads.delete(thread.id);
    }
    for (const window of snapshot.messageWindows)
      if (!retainsHistory(window.threadId)) transcriptWindows[window.threadId] = window;
    for (const message of snapshot.messages) {
      if (retainsHistory(message.threadId)) continue;
      const entry = toTranscriptEntry(message);
      if (entry)
        transcripts[message.threadId] = upsertEntry(transcripts[message.threadId] ?? [], entry);
    }
    const threads = [
      ...snapshot.threads.map((thread) =>
        this.#threadState.reconcile(
          toThreadSummary(thread, this.#snapshot.environments, this.#snapshot.harnesses),
          snapshot.sequence,
          this.#snapshot.threads.find(({ id }) => id === thread.id),
        ),
      ),
      ...this.#snapshot.threads.filter(
        (thread) => !incoming.has(thread.id) && this.#showsThread(thread.id),
      ),
    ];
    const taskPage = (page: import("@opensteer/protocol").TaskPage): TaskListState => ({
      entries: page.tasks.map((entry) => ({
        ...entry,
        thread: toThreadSummary(
          entry.thread,
          this.#snapshot.environments,
          this.#snapshot.harnesses,
        ),
      })),
      window: page.window,
    });
    this.#applyingSnapshot = true;
    try {
      this.#browserTabs.seed({
        groups: snapshot.resources.browser.groups,
        tabs: snapshot.resources.browser.tabs,
      });
    } finally {
      this.#applyingSnapshot = false;
    }
    this.#savedViewReadiness = { tasksReady: true };
    this.#update({
      ...this.#snapshot,
      threads,
      transcripts,
      transcriptWindows,
      requests,
      inputQueues,
      runQueue: this.#runQueue.entries(),
      tasks: taskPage(snapshot.tasks.recent),
      activeTasks: taskPage(snapshot.tasks.active).entries,
      doneTasks: { [mainDoneTasks]: taskPage(snapshot.tasks.done) },
      needsYou: snapshot.needsYou,
      browserAvailable: snapshot.resources.browser.available,
      browserProfiles: snapshot.resources.browser.profiles,
      browserProfileHomes: snapshot.resources.browser.profileHomes,
      browserProfileDeletions: snapshot.resources.browser.profileDeletions,
      browserPlacements: snapshot.resources.browser.placements,
      ...this.#applyAppTabs(snapshot.resources.appTabs),
    });
    this.#refreshInputQueues(threads.map(({ id }) => id));
    for (const threadId of inFlight) {
      if (!this.#historicalThreads.has(threadId))
        this.#invalidatedHydrations.set(
          threadId,
          maxSequence(this.#invalidatedHydrations.get(threadId) ?? zeroSequence, snapshot.sequence),
        );
    }
    for (const threadId of new Set([this.#activeThreadId, ...this.#observedThreads.keys()])) {
      if (threadId === null) continue;
      if (!this.#historicalThreads.has(threadId) && !coversSnapshot(threadId)) {
        this.#hydratedThreads.delete(threadId);
        this.#ensureThreadHydration(threadId);
      }
      this.#ensureAssignments(threadId, true);
      this.#ensureAutomations(threadId, true);
    }
    if (snapshot.tasks.active.window.hasMore)
      void this.#readFirstTaskPage("active", "asked").catch(() => undefined);
  }

  #applyLive(input: LiveProgressInput): void {
    const channel = this.#channels.get(this.#snapshot.deploymentId!);
    if (!channel) return;
    if (compareSequence(input.afterSequence, channel.cursor) > 0) {
      const held = this.#heldLive.get(channel.deploymentId) ?? [];
      // Held progress is bounded; what is dropped is reread when it is missed.
      if (held.length >= maxHeldLiveFrames) held.shift();
      held.push(input);
      this.#heldLive.set(channel.deploymentId, held);
      return;
    }
    this.#drawLive(input);
  }

  /** Draws held progress whose durable predecessors have now been applied. */
  #releaseHeldLive(channel: DeploymentChannel): void {
    const held = this.#heldLive.get(channel.deploymentId);
    if (!held?.length) return;
    const ready = held.filter((input) => compareSequence(input.afterSequence, channel.cursor) <= 0);
    if (ready.length === 0) return;
    this.#heldLive.set(
      channel.deploymentId,
      held.filter((input) => compareSequence(input.afterSequence, channel.cursor) > 0),
    );
    for (const input of ready) this.#drawLive(input);
  }

  #drawLive(input: LiveProgressInput): void {
    this.#nodeDetails.acceptLive(input);
    const { changed, gap } = this.#live.apply(input);
    const threadId = input.progress.threadId;
    const retained = this.#showsThread(threadId) || this.#hydratedThreads.has(threadId);
    if (changed && retained && !this.#historicalThreads.has(threadId)) {
      this.#update({
        ...this.#snapshot,
        transcripts: {
          ...this.#snapshot.transcripts,
          [threadId]: foldLiveRun(
            this.#snapshot.transcripts[threadId] ?? [],
            changed,
            new Date().toISOString(),
          ),
        },
      });
    }
    if (gap) this.#scheduleLiveRefresh(threadId, this.#snapshot.deploymentId!);
  }

  /**
   * Rereads a Thread's streams whole: after a frame was missed, or after a
   * resubscription, to learn which drawn streams it still carries. Reads are
   * debounced and never overlap. One asked for while another is in flight is
   * owed, not dropped, since the read in flight may predate what prompted it;
   * a reply older than what the ledger holds is ignored there.
   */
  #scheduleLiveRefresh(threadId: string, deploymentId: string): void {
    if (this.#disposed) return;
    const pending = this.#liveRereads.get(threadId);
    if (pending) {
      if (pending.timer === null) pending.again = true;
      return;
    }
    const reread: LiveReread = { again: false, timer: null };
    reread.timer = globalThis.setTimeout(() => {
      reread.timer = null;
      const generation = this.#liveGenerations.get(deploymentId) ?? 0;
      const viewer = this.#viewerGeneration;
      void this.rpc["thread.live.get"]({ threadId })
        .then((result) => {
          if (this.#liveRereads.get(threadId) !== reread || !result.ok) return;
          if (viewer !== this.#viewerGeneration) return;
          if ((this.#liveGenerations.get(deploymentId) ?? 0) !== generation) return;
          for (const run of result.data.runs) this.#applyLive(run);
          this.#sweepLive(threadId, deploymentId);
        })
        .catch(() => undefined)
        .finally(() => {
          // A read the session outlived is nobody's to settle or to repeat.
          if (this.#liveRereads.get(threadId) !== reread) return;
          this.#liveRereads.delete(threadId);
          if (reread.again) this.#scheduleLiveRefresh(threadId, deploymentId);
        });
    }, liveRefreshDelayMs);
    this.#liveRereads.set(threadId, reread);
  }

  #forgetLiveRereads(): void {
    for (const reread of this.#liveRereads.values()) {
      if (reread.timer !== null) globalThis.clearTimeout(reread.timer);
    }
    this.#liveRereads.clear();
  }

  /**
   * Drops what the transcript draws of streams the ledger no longer holds and
   * no held frame is about to draw: what a dropped connection was carrying
   * that nothing since has continued. The ledger is the authority for every
   * live entry, so anything else drawn is a stale partial stream.
   */
  #sweepLive(threadId: string, deploymentId: string): void {
    const entries = this.#snapshot.transcripts[threadId];
    if (!entries || this.#historicalThreads.has(threadId)) return;
    const held = new Set<string>();
    for (const input of this.#heldLive.get(deploymentId) ?? []) {
      if (input.progress.threadId !== threadId) continue;
      for (const item of input.progress.items) {
        held.add(`${input.progress.runId}:${liveStreamKeyId(liveStreamKeyOf(item))}`);
      }
    }
    const swept = withoutClosedLiveStreams(
      entries,
      (runId, key) => this.#live.holds(runId, key) || held.has(`${runId}:${liveStreamKeyId(key)}`),
    );
    if (swept === entries) return;
    this.#update({
      ...this.#snapshot,
      transcripts: { ...this.#snapshot.transcripts, [threadId]: [...swept] },
    });
  }

  #applyEvents(channel: DeploymentChannel, events: readonly RealtimeEvent[]): void {
    let next = this.#snapshot;
    let applied = channel.cursor;
    const touchedInputQueues = new Set<string>();
    for (const event of events) {
      if (compareSequence(event.sequence, applied) <= 0) continue;
      if (event.type === null) {
        applied = event.sequence;
        continue;
      }
      this.#nodeDetails.accept(event);
      if (nodeDetailEventNodeId(event)) {
        this.#live.complete(event);
        applied = event.sequence;
        continue;
      }
      if (event.type === "place.entered") this.#runPlaces.accept(event, false);
      if (
        event.runId !== null &&
        (event.type === "run.completed" ||
          event.type === "run.failed" ||
          event.type === "run.interrupted" ||
          (event.type === "run.status" && !isActiveRunStatus(event.data.status)))
      )
        this.#runPlaces.end(event.runId, false);
      invalidateScheduleAnchor(this, event);
      const current = next.threads.find(({ id }) => id === event.threadId);
      const ownsState = this.#threadState.record(event);
      const retained =
        this.#showsThread(event.threadId) || this.#hydratedThreads.has(event.threadId);
      next = projectAgentEvent(
        next,
        event,
        retained && !this.#historicalThreads.has(event.threadId),
      );
      if (this.#runQueue.record(event)) next = { ...next, runQueue: this.#runQueue.entries() };
      if (ownsState)
        next = {
          ...next,
          threads: next.threads.map((thread) =>
            thread.id === event.threadId
              ? this.#threadState.reconcile(thread, event.sequence, current)
              : thread,
          ),
        };
      this.#live.complete(event);
      applied = event.sequence;
      this.#hydrationBuffers.get(event.threadId)?.push(event);
      if (inputQueueEventTypes.has(event.type)) touchedInputQueues.add(event.threadId);
    }
    if (next !== this.#snapshot) {
      this.#update(next);
      if (this.#activeThreadId) this.activateThread(this.#activeThreadId);
    }
    channel.cursor = applied;
    this.#runPlaces.flush();
    this.#releaseHeldLive(channel);
    this.#refreshInputQueues(touchedInputQueues);
  }

  #refreshInputQueues(threadIds: Iterable<string>): void {
    const stale: string[] = [];
    for (const threadId of threadIds) {
      if (!this.#snapshot.inputQueues[threadId]) continue;
      if (threadId === this.#activeThreadId) this.#reloadInputQueue(threadId);
      else stale.push(threadId);
    }
    if (stale.length === 0) return;
    const inputQueues = { ...this.#snapshot.inputQueues };
    for (const threadId of stale) delete inputQueues[threadId];
    this.#update({ ...this.#snapshot, inputQueues });
  }

  #sendAck(channel: DeploymentChannel): void {
    if (!channel.socket || channel.socket.readyState !== 1) return;
    channel.socket.send(
      JSON.stringify({
        sequence: channel.cursor,
        type: "client.ack",
      }),
    );
  }

  #reconnectDelay(attempt: number, maxDelayMs = this.#reconnectMaxDelayMs): number {
    const ceiling = Math.min(maxDelayMs, this.#reconnectBaseDelayMs * 2 ** Math.min(attempt, 16));
    return Math.min(maxDelayMs, Math.round(ceiling * (0.8 + this.#random() * 0.2)));
  }

  #retryDelay(attempt: number, unreadableFrames: number): number {
    return this.#reconnectDelay(
      Math.max(attempt, unreadableFrames - 1),
      unreadableFrames > 0 ? unreadableFrameMaxDelayMs : this.#reconnectMaxDelayMs,
    );
  }

  #scheduleReconnect(channel: DeploymentChannel): void {
    if (this.#disposed || channel.reconnectTimer || this.#deploymentReconnectSuspended()) return;
    const delay = this.#retryDelay(channel.reconnectAttempt++, channel.unreadableFrames);
    if (channel.unreadableFrames > 0) channel.unreadableRetryAt = Date.now() + delay;
    channel.reconnectTimer = globalThis.setTimeout(() => {
      channel.reconnectTimer = null;
      this.#connect(channel);
    }, delay);
  }

  #closeChannel(
    channel: DeploymentChannel,
    reconnect: boolean,
    code = 1000,
    reason = "Client closed",
  ): void {
    if (channel.reconnectTimer) globalThis.clearTimeout(channel.reconnectTimer);
    channel.reconnectTimer = null;
    this.#clearProbe(channel);
    const socket = channel.socket;
    channel.socket = null;
    channel.synchronized = false;
    this.#releaseBrowserCarrier(channel);
    this.#nodeDetails.disconnected(channel.deploymentId);
    if (reconnect) this.#scheduleReconnect(channel);
    try {
      socket?.close(code, reason);
    } catch {
      // The socket is already abandoned; failing to close it changes nothing here.
    }
  }

  #recomputeConnection(): void {
    if (this.#snapshot.session !== "authenticated") {
      if (this.#network !== this.#snapshot.network) this.#update(this.#snapshot);
      return;
    }

    // connection for the one being read. A refused one's own screen remains
    // unavailable, and it never decides for a client reading nothing yet.
    const channels = [...this.#channels.values()];
    const read = channels.filter(({ deploymentId }) => this.#readsDeployment(deploymentId));
    const pending = (
      read.length > 0 ? read : channels.filter((channel) => !channel.refused)
    ).filter((channel) => !channel.synchronized);
    if (pending.length === 0) this.#hostUnreachable = false;
    // Retrying a snapshot this client cannot read is no reconnection in
    // progress: it says so, and offers Retry, between and during the attempts.
    const connection: HostConnectionState =
      pending.length === 0
        ? "connected"
        : pending.some(
              (channel) =>
                (!channel.socket && !channel.reconnectTimer) ||
                channel.unreadableFrames > realtimeReplayAttempts,
            ) || this.#hostUnreachable
          ? "offline"
          : "connecting";
    if (connection !== this.#snapshot.connection || this.#network !== this.#snapshot.network) {
      this.#update({ ...this.#snapshot, connection });
    }
  }

  #readsDeployment(_deploymentId: string): boolean {
    return true;
  }

  /**
   * Coming back, or a new network, is a new reason to expect the Host: what
   * earlier attempts found says nothing about this one.
   */
  #beginConnectionAttempt(): void {
    this.#hostUnreachable = false;
    if (this.#snapshot.session === "authenticated" && this.#snapshot.connection === "offline")
      this.#update({ ...this.#snapshot, connection: "connecting" });
  }

  #clearInterruptionHold(): void {
    if (this.#interruptionTimer) globalThis.clearTimeout(this.#interruptionTimer);
    this.#interruptionTimer = null;
  }

  /**
   * Only an interruption that outlasts the hold is said. Stopping is said at
   * once: nothing is on its way to fix it, unless the device itself is offline,
   * which a phone reports for a moment in the middle of a handover. Nothing
   * counts while hidden, where sockets die unwatched and a frozen timer would
   * fire on the way back, mid-reconnect.
   */
  #withInterruption(snapshot: HostSnapshot): HostSnapshot {
    let interrupted = snapshot.connectionInterrupted;
    if (snapshot.connection === "connected" && this.#network !== "offline") {
      this.#clearInterruptionHold();
      interrupted = false;
    } else if (this.#visibility !== "foreground") {
      return snapshot;
    } else if (snapshot.connection === "offline" && this.#network !== "offline") {
      this.#clearInterruptionHold();
      interrupted = true;
    } else if (!interrupted && !this.#interruptionTimer) {
      this.#interruptionTimer = globalThis.setTimeout(() => {
        this.#interruptionTimer = null;
        this.#update({ ...this.#snapshot, connectionInterrupted: true });
      }, connectionInterruptionHoldMs);
    }
    return interrupted === snapshot.connectionInterrupted
      ? snapshot
      : { ...snapshot, connectionInterrupted: interrupted };
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

  async #loadEarlierTranscript(
    threadId: string,
    scan: { readonly retired: boolean },
  ): Promise<void> {
    const generation = this.#viewerGeneration;
    const userId = this.#snapshot.user?.id;
    const drawnRows = (snapshot: HostSnapshot) => {
      const thread = snapshot.threads.find((item) => item.id === threadId);
      return thread
        ? this.#drawnRowCount(thread, snapshot.transcripts[threadId] ?? [], snapshot.assignments)
        : 0;
    };
    let pages = 0;
    let bytes = 0;
    const cursors = new Set<string>();
    while (
      !scan.retired &&
      this.#viewerStillCurrent(generation, userId) &&
      pages < historyScanMaxPages &&
      bytes < historyScanMaxBytes
    ) {
      const thread = this.#snapshot.threads.find((item) => item.id === threadId);
      const currentWindow = this.#snapshot.transcriptWindows[threadId];
      if (!thread || currentWindow?.hasMore === false) return;
      const before = currentWindow?.nextBefore ?? undefined;
      if (before && cursors.has(before))
        throw new Error("Thread event page is missing its continuation cursor.");
      if (before) cursors.add(before);
      const page = await this.#readThreadHistory(threadId, before);
      pages += 1;
      bytes += page.window.byteCount;
      if (scan.retired || !this.#viewerStillCurrent(generation, userId)) return;
      if (!this.#snapshot.threads.some((item) => item.id === threadId)) return;
      // A reconnect hydration may have replaced the window during this read.
      if (this.#snapshot.transcriptWindows[threadId] !== currentWindow) return;
      for (const event of page.events) this.#threadState.record(event);
      const current = this.#snapshot.threads.find(({ id }) => id === threadId);
      const summary = this.#threadState.reconcile(
        toThreadSummary(page.thread, this.#snapshot.environments, this.#snapshot.harnesses),
        page.asOfSequence,
        current,
      );
      const olderEntries = page.events.reduce(foldTranscriptEvent, [] as TranscriptEntry[]);
      const currentEntries = this.#snapshot.transcripts[threadId] ?? [];
      const drawnBefore = drawnRows(this.#snapshot);
      const merged = {
        ...this.#snapshot,
        threads: this.#snapshot.threads.map((thread) =>
          thread.id === threadId
            ? {
                ...thread,
                title: summary.title,
                status: summary.status,
                inputQueuePaused: summary.inputQueuePaused,
                pendingRequests: summary.pendingRequests,
                updatedAt: summary.updatedAt,
              }
            : thread,
        ),
        assignments: withAssignmentsFrom(this.#snapshot.assignments, page.events),
        transcripts: {
          ...this.#snapshot.transcripts,
          [threadId]: mergeTranscriptSegments(olderEntries, currentEntries),
        },
        transcriptWindows: {
          ...this.#snapshot.transcriptWindows,
          [threadId]: page.window,
        },
      };
      const drawnAfter = drawnRows(merged);
      this.#update(merged);
      if (page.window.hasMore && (!page.window.nextBefore || cursors.has(page.window.nextBefore)))
        throw new Error("Thread event page is missing its continuation cursor.");
      // A byte/item budget can split one turn across pages. Its older steps
      // can merge into the existing row without adding a row to read.
      if (!page.window.hasMore || drawnAfter > drawnBefore) return;
    }
  }

  async #loadRequests(threadId: string): Promise<void> {
    const generation = this.#viewerGeneration;
    const requests: Request[] = [];
    let before: string | null = null;
    do {
      const response: {
        readonly requests: Request[];
        readonly threadId: string;
        readonly window: DurableWindow;
      } = unwrapRpcResult(
        await this.rpc["thread.requests.list"]({
          ...(before ? { before } : {}),
          limit: 100,
          threadId,
        }),
      );
      if (generation !== this.#viewerGeneration || this.#disposed) return;
      if (response.threadId !== threadId) throw new Error("Thread Request response mismatch.");
      requests.push(...response.requests);
      before = response.window.hasMore ? response.window.nextBefore : null;
      if (response.window.hasMore && !before) {
        throw new Error("Thread Request page is missing its continuation cursor.");
      }
    } while (before);
    this.#update({
      ...this.#snapshot,
      requests: { ...this.#snapshot.requests, [threadId]: requests },
    });
  }

  #expireSession(): void {
    const cacheScope = this.#cacheScope();
    if (cacheScope)
      this.#checkpointWrite = this.#checkpointWrite
        .catch(() => undefined)
        .then(() => this.#streamCache?.remove(cacheScope));
    this.#cacheLoaded = false;
    this.#restoredCursor = null;
    this.#browserCarrier = null;
    this.#nodeDetails.clear();
    this.#clearAttachmentReads();
    this.#cancelLostFrameReread();
    this.#savedViewReadiness = emptySavedViewReadiness();
    this.#viewerGeneration += 1;
    this.#appTabPending.clear();
    this.#browserUsageRead.clear();
    this.#browserUsageReads.clear();
    this.#browserUsageRunSources.clear();
    this.#browserUses.clear();
    this.#browserTabs.clear();
    this.#browserContinuation = undefined;
    this.#placeActivity.clear();
    this.#runPlaces.clear();
    this.#targetedWatch.clear();
    this.#targetedControl.clear();
    this.#reportedTimeZone = null;
    this.#threadState.clear();
    this.#threadRenames.clear();
    this.#threadIcons.clear();
    // Another viewer may sign in next and open the same Threads; nothing this
    // one was streaming, nor any reread asked for it, may draw for them.
    this.#runQueue.clear();
    this.#live.clear();
    this.#heldLive.clear();
    this.#forgetLiveRereads();
    this.#threadDeployment.clear();
    this.#assignmentReads.clear();
    this.#automationReads.clear();
    this.#readAutomations.clear();
    this.#requestReads.clear();
    this.#deniedAssignments.clear();
    this.#observedThreads.clear();
    this.#historicalThreads.clear();
    this.#threadHydrations.clear();
    this.#hydrationBuffers.clear();
    this.#hydratedThreads.clear();
    this.#invalidatedHydrations.clear();
    this.#stopRefresh();
    for (const channel of this.#channels.values()) this.#closeChannel(channel, false);
    this.#channels.clear();
    this.#update({
      ...emptySnapshot(),
      connection: "connected",
      identityConfig: this.#snapshot.identityConfig,
      revision: this.#snapshot.revision,
      session: "authentication-required",
    });
  }

  #viewerStillCurrent(generation: number, userId: string | undefined): boolean {
    return (
      !this.#disposed &&
      generation === this.#viewerGeneration &&
      this.#snapshot.session === "authenticated" &&
      this.#snapshot.user?.id === userId
    );
  }

  #browserTargetAuthorized(sessionId: string, surfaceId: string): boolean {
    const groupId = this.#browserTabs.groupForSession(sessionId);
    const group = groupId ? this.#browserTabs.group(groupId) : undefined;
    return (
      !!group &&
      group.state !== "closed" &&
      group.state !== "failed" &&
      (!this.#browserTabs.tabs(group.id).whole || !!this.#browserTabs.tab(group.id, surfaceId))
    );
  }

  #url(path: string): string {
    return new URL(path, this.#baseUrl).toString();
  }

  #webSocketUrl(path: string): string {
    const url = new URL(path, this.#baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set(apiVersionQueryParameter, String(hostApiVersion));
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

  /**
   * Tells the Host this viewer's time zone, as this device's clock has it, so
   * an agent asked for "5pm" means their 5pm. Each bootstrap checks; only a
   * new viewer, a new Deployment or a moved clock sends. A refusal stands for
   * that zone, and a request that never landed is asked again by the next
   * bootstrap, never sooner.
   */
  #reportTimeZone(): void {
    const userId = this.#snapshot.user?.id;
    if (this.#disposed || this.#snapshot.session !== "authenticated" || !userId) return;
    const timeZone = TimeZoneSchema.safeParse(deviceTimeZone());
    if (!timeZone.success) return;
    const report = `${this.#snapshot.deploymentId ?? ""}:${userId}:${timeZone.data}`;
    if (this.#reportedTimeZone === report) return;
    this.#reportedTimeZone = report;
    void this.#dispatch({
      idempotencyKey: mutationIdempotencyKey("time-zone"),
      timeZone: timeZone.data,
      type: "viewer.timeZone.update",
    }).catch((error: unknown) => {
      if (this.#reportedTimeZone === report && !isHostRefusal(error)) this.#reportedTimeZone = null;
    });
  }

  #cacheScope(): PersonalCacheScope | null {
    return this.#snapshot.deploymentId && this.#snapshot.user
      ? {
          deploymentId: this.#snapshot.deploymentId,
          userId: this.#snapshot.user.id,
          apiVersion: hostApiVersion,
        }
      : null;
  }
  #persistCheckpoint(channel: DeploymentChannel): void {
    const scope = this.#cacheScope();
    if (!scope || !this.#streamCache) return;
    const generation = this.#viewerGeneration;
    const {
      threads,
      tasks,
      activeTasks,
      transcripts,
      transcriptWindows,
      requests,
      waitingRequests,
      needsYou,
      threadVisits,
    } = this.#snapshot;
    const snapshot = {
      threads,
      tasks,
      activeTasks,
      transcripts,
      transcriptWindows,
      requests,
      waitingRequests,
      needsYou,
      threadVisits,
    };
    const checkpoint = {
      scope,
      snapshot,
      threadStates: this.#threadState.checkpoint(),
      cursor: {
        deploymentId: DeploymentIdSchema.parse(scope.deploymentId),
        apiVersion: hostApiVersion,
        afterSequence: channel.cursor,
      },
    };
    this.#checkpointWrite = this.#checkpointWrite
      .catch(() => undefined)
      .then(() =>
        new TextEncoder().encode(JSON.stringify(checkpoint)).byteLength <= 1_048_576
          ? this.#streamCache!.commit(
              checkpoint,
              () => generation === this.#viewerGeneration && !this.#disposed,
            )
          : this.#streamCache!.remove(scope),
      );
  }

  #update(snapshot: HostSnapshot): void {
    if (this.#disposed) return;
    snapshot = this.#withInterruption(snapshot);
    if (snapshot.session !== "authenticated") this.#savedViewReadiness = emptySavedViewReadiness();
    if (
      !this.#capabilities?.includes("task-family-v1") &&
      Object.keys(snapshot.threadAutomations).length > 0
    )
      snapshot = { ...snapshot, threadAutomations: {} };
    if (snapshot.session === "authenticated")
      snapshot = {
        ...snapshot,
        ...this.#browserSnapshot.derive(snapshot, this.#browserTabs),
      };
    const structure = this.#browserTabs.structure();
    const browserStructureChanged = structure !== this.#browserStructure;
    const browserTargetsChanged = this.#browserTargetRevision !== this.#browserTabs.targetRevision;
    const closedBrowserTabs: string[] = [];
    if (browserStructureChanged) {
      const tabIds = new Map<string, readonly string[]>();
      for (const groupId of this.#browserTabs.groups().ids) {
        const list = this.#browserTabs.tabs(groupId);
        const previous = this.#browserTabIds.get(groupId);
        tabIds.set(groupId, list.ids);
        if (list.whole && previous && previous !== list.ids) {
          const open = new Set(list.ids);
          for (const id of previous) if (!open.has(id)) closedBrowserTabs.push(id);
        }
      }
      this.#browserTabIds = tabIds;
    }
    this.#browserStructure = structure;
    this.#browserTargetRevision = this.#browserTabs.targetRevision;
    const scope = viewerScopeOf(snapshot);
    if (this.#viewer.change(scope)) {
      for (const check of this.#browserWaiters) check();
      this.#nodeDetails.clear();
      this.#runPlaces.clear();
      this.#targetedWatch.clear();
      this.#targetedControl.clear();
      this.#pendingBrowserTabs.clear();
      this.#clearAttachmentReads();
      this.#personalTabActivations.clear(false);
      this.#computerViews.clear();
      this.#ownerViews.clear();
      snapshot = {
        ...snapshot,
        browserTabGroups: this.#tabGroups.receive(snapshot.browserTabGroups),
      };
    }
    snapshot = {
      ...snapshot,
      activatingPersonalTabs: this.#personalTabActivations.ids,
      pendingBrowserTabs: this.#pendingBrowserTabs.rows,
    };
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
        browserTargetsChanged ||
        snapshot.appTabs !== this.#snapshot.appTabs ||
        snapshot.browserPlacements !== this.#snapshot.browserPlacements ||
        snapshot.browserProfiles !== this.#snapshot.browserProfiles
      ) {
        const authorized = (sessionId: string, surfaceId: string) =>
          this.#browserTargetAuthorized(sessionId, surfaceId);
        const allowed = (sessionId: string, surfaceId: string) => {
          const groupId = this.#browserTabs.groupForSession(sessionId);
          const group = groupId ? this.#browserTabs.group(groupId) : undefined;
          const tab = groupId ? this.#browserTabs.tab(groupId, surfaceId) : undefined;
          return (
            group?.state === "ready" &&
            tab?.availability === "ready" &&
            tab.state === "live" &&
            tab.documentId !== null
          );
        };
        reconcileBrowserTargets = () => {
          const document = (sessionId: string, tabId: string) =>
            placeByKey(this.#snapshot, `browser:${sessionId}:${tabId}`)?.browser?.documentId;
          reconcileBrowserLastPictures(this.browserWatchFrames, document);
          reconcileBrowserLastPictures(this.browserFrames, document);
          if (this.#snapshot.connection === "connected")
            this.#placeActivity.reconcile(
              (key) => placeByKey(this.#snapshot, key)?.availability === "ready",
            );
          this.#targetedWatch.reconcile(allowed, authorized);
          this.#targetedControl.reconcile(allowed, authorized);
        };
      }
    }
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
      viewerScopeOf(snapshot) === viewerScopeOf(this.#snapshot)
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
    snapshot = { ...snapshot, threadVisits: visits };
    this.#threadState.retainLoaded(snapshot.threads);
    snapshot = withThreadNames(snapshot, (thread) => ({
      ...this.#threadState.name(thread),
      lastVisitedAt: snapshot.threadVisits[thread.id] ?? thread.lastVisitedAt,
      ...(this.#threadRenames.has(thread.id)
        ? { title: this.#threadRenames.get(thread.id)!.title }
        : {}),
      ...(this.#threadIcons.has(thread.id) ? { icon: this.#threadIcons.get(thread.id)!.icon } : {}),
    }));
    const threads = snapshot.threads.map((thread) => {
      const unread = isThreadUnread(thread);
      return thread.unread === unread ? thread : { ...thread, unread };
    });
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
      tabReopenAvailable: this.#capabilities?.includes("tab-reopen-v1") === true,
      browserProfileManageAvailable:
        this.#capabilities?.includes("browser-profile-manage-v1") === true,
      searchSuggestionsAvailable:
        this.#capabilities?.includes("browser-search-suggestions-v1") === true,
      iphoneAppsAvailable: this.#capabilities?.includes("iphone-apps-v1") === true,
      voiceAvailable: this.#capabilities?.includes("voice-run-v1") === true,
      ownerViewWindowsAvailable: this.#capabilities?.includes("ownerViewWindows") === true,
      threads:
        threads.length === this.#snapshot.threads.length &&
        threads.every((thread, index) => thread === this.#snapshot.threads[index])
          ? this.#snapshot.threads
          : threads,
      network: this.#network,
      revision: this.#snapshot.revision + 1,
    };
    if (closedBrowserTabs.length) this.#tabGroups.removeClosed(closedBrowserTabs);
    if (browserStructureChanged)
      this.#snapshot = { ...this.#snapshot, browserTabGroups: this.#tabGroups.project() };
    this.#runPlaces.flush();
    reconcileBrowserTargets?.();
    this.#nodeDetails.refreshNodes();
    this.browserHistory.setConnected(this.#snapshot.connection === "connected");
    for (const listener of this.#listeners) listener();
    this.#checkBrowserUsageRuns();
  }
}

// Only bootstrap's plain data is shared; live stores keep their own identities.

// Only bootstrap's plain data is shared; live stores keep their own identities.
function shareBootstrapData<T>(previous: unknown, next: T): T;
function shareBootstrapData(previous: unknown, next: unknown): unknown {
  if (previous === next) return previous;
  if (Array.isArray(previous) && Array.isArray(next)) {
    const shared = next.map((value: unknown, index: number) =>
      shareBootstrapData(previous[index], value),
    );
    return previous.length === shared.length &&
      shared.every((value, index) => value === previous[index])
      ? previous
      : shared;
  }
  if (
    previous &&
    next &&
    typeof previous === "object" &&
    typeof next === "object" &&
    Object.getPrototypeOf(previous) === Object.prototype &&
    Object.getPrototypeOf(next) === Object.prototype
  ) {
    const held = previous as Record<string, unknown>;
    const incoming = next as Record<string, unknown>;
    const keys = Object.keys(incoming);
    const shared: Record<string, unknown> = { ...incoming };
    let equal = Object.keys(held).length === keys.length;
    for (const key of keys) {
      shared[key] = shareBootstrapData(held[key], incoming[key]);
      if (!Object.hasOwn(held, key) || shared[key] !== held[key]) equal = false;
    }
    return equal ? previous : shared;
  }
  return next;
}

function withNewerComputerPresence(
  machine: MachineSummary,
  previous: readonly MachineSummary[],
  patchedSince: (sessionId: string) => boolean,
): MachineSummary {
  const computerUse = machine.computerUse;
  if (!computerUse?.sessions.some((session) => patchedSince(session.sessionId))) {
    return { ...machine };
  }
  const known = new Map(
    previous.flatMap((candidate) =>
      (candidate.computerUse?.sessions ?? []).map((session) => [session.sessionId, session]),
    ),
  );
  return {
    ...machine,
    computerUse: {
      ...computerUse,
      sessions: computerUse.sessions.map((session) => {
        const patched = patchedSince(session.sessionId) ? known.get(session.sessionId) : undefined;
        return patched ? { ...session, actingAppKeys: [...patched.actingAppKeys] } : session;
      }),
    },
  };
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

/**
 * A Run that has ended can take no more steering. The queue read will say the
 * same, but the tray must not offer Steer into a finished Run for the length
 * of a round trip.
 */
function withoutSteerTarget(
  inputQueues: HostSnapshot["inputQueues"],
  threadId: string,
  runId: string | null,
): HostSnapshot["inputQueues"] {
  const queue = inputQueues[threadId];
  if (!runId || queue?.steerRunId !== runId) return inputQueues;
  return { ...inputQueues, [threadId]: { ...queue, steerRunId: null } };
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

function projectAgentEvent(
  snapshot: HostSnapshot,
  event: AgentEvent,
  drawTranscript: boolean,
): HostSnapshot {
  const assignments =
    event.type === "assignment.created" || event.type === "assignment.updated"
      ? mergeAssignments(snapshot.assignments, [event.data.assignment])
      : snapshot.assignments;
  let requests = snapshot.requests;
  let inputQueues = snapshot.inputQueues;
  // An ended Request waits on nobody. The Host's notice rereads the list, but
  // a card that already knows need not keep asking until it lands.
  const endedRequestId =
    event.type === "request.cancelled"
      ? event.data.requestId
      : event.type === "request.resolved"
        ? event.data.request.id
        : null;
  const waitingRequests =
    endedRequestId === null
      ? snapshot.waitingRequests
      : snapshot.waitingRequests.filter(({ request }) => request.id !== endedRequestId);
  const cancellationContext =
    event.type === "request.cancelled"
      ? requests[event.threadId]?.find((request) => request.id === event.data.requestId)
      : undefined;

  switch (event.type) {
    case "run.completed":
    case "run.failed":
    case "run.interrupted":
      inputQueues = withoutSteerTarget(inputQueues, event.threadId, event.runId);
      break;
    case "request.updated":
      requests = {
        ...requests,
        [event.threadId]: upsertRequest(requests[event.threadId] ?? [], event.data.request),
      };
      break;
    case "request.opened":
      requests = {
        ...requests,
        [event.threadId]: upsertRequest(requests[event.threadId] ?? [], event.data.request),
      };
      break;
    case "request.cancelled":
      requests = {
        ...requests,
        [event.threadId]: (requests[event.threadId] ?? []).filter(
          (request) => request.id !== event.data.requestId,
        ),
      };
      break;
    case "request.resolved":
      requests = {
        ...requests,
        [event.threadId]: (requests[event.threadId] ?? []).filter(
          (request) => request.id !== event.data.request.id,
        ),
      };
      break;
    case "thread.created": {
      const thread = toThreadSummary(event.data.thread, snapshot.environments, snapshot.harnesses);
      return {
        ...snapshot,
        ...(event.data.voice ? { voiceThreadId: thread.id } : {}),
        requests: snapshot.requests[thread.id]
          ? snapshot.requests
          : { ...snapshot.requests, [thread.id]: [] },
        threads: snapshot.threads.some((item) => item.id === thread.id)
          ? patchThread(snapshot.threads, thread.id, thread)
          : [thread, ...snapshot.threads],
        transcriptWindows: snapshot.transcriptWindows[thread.id]
          ? snapshot.transcriptWindows
          : {
              ...snapshot.transcriptWindows,
              [thread.id]: {
                byteCount: 2,
                hasMore: false,
                itemCount: 0,
                nextBefore: null,
                threadId: thread.id,
                totalItems: 0,
              },
            },
        transcripts: snapshot.transcripts[thread.id]
          ? snapshot.transcripts
          : { ...snapshot.transcripts, [thread.id]: [] },
      };
    }
    case "thread.execution-updated":
      // The switch's marker is the entry a reloaded history folds from this
      // same event, so the live conversation draws it exactly as a reload will.
      return {
        ...snapshot,
        threads: patchThread(
          snapshot.threads,
          event.threadId,
          toThreadSummary(event.data.thread, snapshot.environments, snapshot.harnesses),
        ),
        transcripts: drawTranscript
          ? {
              ...snapshot.transcripts,
              [event.threadId]: foldTranscriptEvent(
                snapshot.transcripts[event.threadId] ?? [],
                event,
              ),
            }
          : snapshot.transcripts,
      };
    case "thread.listed": {
      // Lists never held an unlisted Thread, so it may arrive here unknown.
      const thread = toThreadSummary(event.data.thread, snapshot.environments, snapshot.harnesses);
      return {
        ...snapshot,
        threads: snapshot.threads.some(({ id }) => id === thread.id)
          ? patchThread(snapshot.threads, thread.id, { listed: thread.listed })
          : [thread, ...snapshot.threads],
      };
    }
    case "thread.continuation-established":
      return {
        ...snapshot,
        threads: patchThread(snapshot.threads, event.threadId, {
          continuationIdentity: event.data.continuationIdentity,
          updatedAt: event.createdAt,
        }),
      };
    case "thread.access-mode-updated":
      return {
        ...snapshot,
        threads: patchThread(snapshot.threads, event.threadId, {
          accessMode: event.data.accessMode,
          updatedAt: event.createdAt,
        }),
      };
    case "thread.state-changed":
      // Absolute state is reconciled where events are applied. It is not
      // transcript; folding it would give every Thread that changes state an
      // empty transcript and copy the whole transcript map once per change.
      return {
        ...snapshot,
        threads: patchThread(snapshot.threads, event.threadId, { updatedAt: event.createdAt }),
      };
    case "thread.input-queue-updated": {
      const queue = snapshot.inputQueues[event.threadId];
      return {
        ...snapshot,
        inputQueues:
          queue && queue.paused !== event.data.paused
            ? { ...inputQueues, [event.threadId]: { ...queue, paused: event.data.paused } }
            : inputQueues,
      };
    }
    case "thread-input.updated": {
      // The queue read decides what is waiting, but an input that has left
      // `pending` has certainly left the queue, and the tray need not wait a
      // round trip to stop offering it.
      const input = event.data.input;
      const queue = inputQueues[event.threadId];
      if (
        input.state !== "pending" &&
        queue?.items.some((item) => item.message.id === input.messageId)
      ) {
        inputQueues = {
          ...inputQueues,
          [event.threadId]: {
            ...queue,
            items: queue.items.filter((item) => item.message.id !== input.messageId),
          },
        };
      }
      break;
    }
    case "message.created":
      break;
    default:
      break;
  }

  let entries = drawTranscript
    ? foldTranscriptEvent(snapshot.transcripts[event.threadId] ?? [], event)
    : null;
  if (entries && event.type === "request.cancelled" && cancellationContext) {
    entries = entries.map((entry) =>
      entry.kind === "request" && entry.requestId === event.data.requestId
        ? {
            ...entry,
            requestKind: cancellationContext.kind,
            title: requestTitleText(cancellationContext.presentation),
          }
        : entry,
    );
  }
  return {
    ...snapshot,
    assignments,
    inputQueues,
    requests,
    waitingRequests,
    ...(event.type === "app.published"
      ? {
          appVersions: {
            ...snapshot.appVersions,
            [event.data.appId]: Math.max(
              snapshot.appVersions?.[event.data.appId] ?? 0,
              event.data.version,
            ),
          },
        }
      : {}),
    threads: patchThread(snapshot.threads, event.threadId, {
      updatedAt: event.createdAt,
    }),
    transcripts: entries
      ? { ...snapshot.transcripts, [event.threadId]: entries }
      : snapshot.transcripts,
  };
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

/** What a history page says about assignments, merged into what the client holds. */
function withAssignmentsFrom(
  prior: Readonly<Record<string, AssignmentSummary>>,
  events: readonly AgentEvent[],
): Record<string, AssignmentSummary> {
  return mergeAssignments(
    prior,
    events.flatMap((event) =>
      event.type === "assignment.created" || event.type === "assignment.updated"
        ? [event.data.assignment]
        : [],
    ),
  );
}

/** The snapshot without these assignments' summaries, cards or return rows. */
function withoutAssignments(snapshot: HostSnapshot, hidden: ReadonlySet<string>): HostSnapshot {
  const shown = (entry: TranscriptEntry): boolean =>
    entry.kind === "assignment"
      ? !hidden.has(entry.assignment.id)
      : entry.kind !== "assignment-return" || !hidden.has(entry.assignmentId);
  return {
    ...snapshot,
    assignments: Object.fromEntries(
      Object.entries(snapshot.assignments).filter(([id]) => !hidden.has(id)),
    ),
    transcripts: Object.fromEntries(
      Object.entries(snapshot.transcripts).map(([threadId, entries]) => [
        threadId,
        entries.every(shown) ? entries : entries.filter(shown),
      ]),
    ),
  };
}

function upsertRequest(requests: readonly Request[], request: Request): Request[] {
  return [...requests.filter((candidate) => candidate.id !== request.id), request].sort(
    (left, right) => left.createdAt.localeCompare(right.createdAt),
  );
}

function knownPendingRequestCount(snapshot: HostSnapshot, threadId: string): number {
  return (snapshot.requests[threadId] ?? []).filter((request) => request.status === "pending")
    .length;
}

function emptySnapshot(): HostSnapshot {
  return {
    personalSettings: null,
    can: null,
    needsYou: null,
    threadRenameAvailable: false,
    taskMarksAvailable: false,

    quietTasksAvailable: false,
    harnessUpdateAvailable: false,
    iphoneAppsAvailable: false,
    assignments: {},
    threadAutomations: {},
    requests: {},
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
    tasks: null,
    activeTasks: [],

    doneTasks: {},
    quietTaskDays: null,
    identityConfig: null,
    inputQueues: {},
    machines: [],
    ownerName: null,
    revision: 0,
    session: "checking",
    sessionSurface: null,
    machineRevision: 0,
    triggerRevision: 0,
    threadLookups: {},
    threads: [],
    transcriptWindows: {},
    transcripts: {},
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

function harnessSummary(record: z.infer<typeof HarnessRecordSchema>): HarnessSummary {
  const {
    config,
    driverKind,
    enabled,
    environmentId,
    id,
    isDefault,
    name,
    modelSettings,
    runtimeRevision,
    sourceId,
    stateKind,
  } = record;
  return {
    driverKind,
    enabled,
    environmentId,
    id,
    isDefault,
    name,
    modelSettings,
    runtimeRevision,
    ...harnessEndpoint(config),
    sourceId,
    stateKind,
  };
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

function toThreadSummary(
  thread: Thread,
  environments: readonly EnvironmentSummary[],
  harnesses: readonly HarnessSummary[],
): ThreadSummary {
  const environment = environments.find((item) => item.id === thread.environmentId);
  const harness = harnesses.find((item) => item.id === thread.harnessInstanceId);
  return {
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

function patchThread(
  threads: readonly ThreadSummary[],
  threadId: string,
  patch: Partial<ThreadSummary>,
): ThreadSummary[] {
  return threads.map((thread) =>
    thread.id === threadId
      ? {
          ...thread,
          ...patch,
          updatedAt:
            patch.updatedAt && patch.updatedAt > thread.updatedAt
              ? patch.updatedAt
              : thread.updatedAt,
        }
      : thread,
  );
}

function maxSequence(left: Sequence, right: Sequence): Sequence {
  return compareSequence(left, right) >= 0 ? left : right;
}

/** The IANA zone this device's clock is set to; nothing where `Intl` cannot say. */
function deviceTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

export function mutationIdempotencyKey(prefix: string): string {
  return `${prefix}:${globalThis.crypto.randomUUID()}`;
}

export { HostClientRequestError as HostHttpError } from "./client.js";

export type { HostToClientMessage };
