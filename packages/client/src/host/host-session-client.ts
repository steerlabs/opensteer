import { BrowserEditingStore } from "./browser-editing.js";
import { BrowserPreferences } from "./browser-preferences.js";
import { WorkspaceTabActivations } from "./workspace-tab-activations.js";
import { browserTabOrderTabs } from "./browser-tab-order.js";
import { BrowserTabGroupClient } from "./browser-tab-groups.js";
import type { HostCapability } from "@opensteer/deployment-authority";
import type { NativeViewerSource } from "./surfaces.js";
import { DisplaySourceSchema } from "@opensteer/protocol";
import { RecentSitesStore, type RecentSitesStorage } from "./recent-sites.js";
import { computerViewMethods } from "./computer-views.js";
import { OwnerViewRecords } from "./owner-view-records.js";
import { ViewerScope, viewerScopeOf } from "./viewer-scope.js";
import type {
  BrowserTabOpenInput,
  BrowserTabOpenOptions,
  HostClient as OwnerViewHostClient,
} from "./client.js";
import {
  BrowserSurfaceIdSchema,
  AgentEventViewSchema,
  ThreadViewSchema,
  ThreadStatusSchema,
  eventDataSchemas,
  SequenceSchema,
  WorkspaceIdSchema,
  LiveItemViewSchema,
  LiveRunProgressViewSchema,
  liveProgressMaxItems,
  ThreadIdSchema,
  ThreadTitleSchema,
  defaultTaskSymbol,
  type WorkspaceIconName,
  CHAT_THREAD_TITLE,
  compareSequence,
  emptyExecutionPreferences,
  harnessDisplayRank,
  liveStreamKeyId,
  liveStreamKeyOf,
  requestTitleText,
  RunIdSchema,
  TimeZoneSchema,
  zeroSequence,
  type AgentEventView as AgentEvent,
  type AssignmentSummary,
  type AssignmentView,
  type Attachment,
  type ExecutionPreferences,
  type NotificationView,
  type Request,
  type WaitingRequest,
  type Sequence,
  type Thread,
  type ThreadAccessMode,
  type ThreadId,
  type ThreadInputQueue,
  type ThreadReadState,
  type WorkspaceNotificationPreference,
} from "@opensteer/core";
import {
  HarnessModelSettingsMapSchema,
  BrowserSessionIdSchema,
  BrowserServerMessageSchema,
  HostToClientMessageSchema,
  WorkspaceSnapshotSchema,
  workspaceSnapshotMaxThreads,
  hostApi,
  threadPageMaxItems,
  workspaceFilePreviewMaxBytes,
  browserViewerCloseCodes,
  browserUsageRunBatchSize,
  decodeBrowserFrameEnvelope,
  type BrowserServerMessage,
  type DurableWindow,
  type HostApiClient,
  type HostApiCommand,
  type HostApiCommandInput,
  type HostApiCommandOutput,
  type MachineAccessPolicy,
  type RpcResult,
  type HostedBrowserSession,
  type WorkspaceTabLineage,
  type BrowserPresence,
  type BrowserSessionUsageProjection,
  type MachineSummary,
  type HostToClientMessage,
  type WorkspaceSnapshot,
  type WorkspaceView,
} from "@opensteer/protocol";
import { hostApiVersion } from "@opensteer/deployment-authority";
import { z } from "zod";
import { HostClientRequestError, isHostRefusal } from "./client.js";
import type { ExecutionChoice, ExecutionSelection } from "./execution-preferences.js";
import { LiveStreamLedger, type LiveProgressInput } from "./live-progress.js";
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
import type {
  BrowserCommand,
  BrowserFrameStore,
  BrowserFrameView,
  BrowserPlacementSummary,
  BrowserSessionSummary,
  BrowserSessionUseSummary,
  BrowserStartIdentity,
  CreateThreadInput,
  EnvironmentSummary,
  HarnessSummary,
  HostConnectionState,
  HostSnapshot,
  MachineAccessHistoryPage,
  MachineAccessUpdateOutcome,
  TaskListState,
  ThreadSummary,
  TranscriptEntry,
  WorkspaceSummary,
  WorkspaceFilePreview,
} from "./client.js";
import { mergeTaskEntries } from "./task-entries.js";
import { RunQueueProjection, toRunQueueEntry } from "./run-queue-state.js";
import { threadStopTarget } from "./thread-activity.js";
import { isThreadUnread, mergeThreadReadState } from "./thread-read-state.js";
import { ThreadStateProjection } from "./thread-state.js";
import { LatestPlaceStore } from "./latest-place.js";
import { PlaceActivityStore } from "./place-activity.js";
import { BrowserWatchStore } from "./browser-watch.js";
import { newerBrowserTabCatalog, placeList } from "./places.js";
import { browserTabCatalogMaxBytes, type BrowserTabCatalog } from "@opensteer/protocol";
import { createHttpHostApiClient } from "./host-api-client.js";
import {
  realtimeIdleProbeDeadlineMs,
  realtimeIdleProbeMs,
  socketProbeDeadlineMs,
  socketTrustWindowMs,
  type ClientLifecycle,
  type ClientNetworkState,
  type ClientVisibility,
} from "./lifecycle.js";
import { threadInDirectory } from "./host-snapshot-selectors.js";
import { withThreadNames, applyOptimisticCommandPatch } from "./optimistic-command-patches.js";

const maxInboundFrameCharacters = browserTabCatalogMaxBytes + 4 * 1024;
const defaultRefreshIntervalMs = 15_000;
const defaultReconnectBaseDelayMs = 300;
/** How long a missed live frame waits before its Thread's streams are reread. */
const liveRefreshDelayMs = 250;
/** Progress one Workspace may hold for durable events still on their way. */
const maxHeldLiveFrames = 256;

const realtimeEnvelopeTypes = new Set<string>(
  HostToClientMessageSchema.options.map((schema) => schema.shape.type.value),
);
const realtimeEventsSchema = z.object({
  events: z.array(z.unknown()).min(1).max(2_000),
});
const realtimeEventPositionSchema = z.object({
  sequence: SequenceSchema,
  workspaceId: WorkspaceIdSchema,
});
const realtimeLiveEnvelopeSchema = z.object({
  afterSequence: SequenceSchema,
  workspaceId: WorkspaceIdSchema,
  progress: LiveRunProgressViewSchema.extend({
    items: z.array(z.unknown()).min(1).max(liveProgressMaxItems),
  }),
});
const realtimeLiveKindSchema = z.object({
  stream: z.enum(["assistant", "reasoning", "tool"]),
  op: z.enum(["append", "replace"]),
});
type RealtimeEvent = AgentEvent | (z.infer<typeof realtimeEventPositionSchema> & { type: null });

// Issue paths can contain record keys supplied by the peer. Only these schema
// field names are diagnostics; values and validator messages never are.
const realtimeDiagnosticFields = new Set([
  "type",
  "events",
  "data",
  "snapshot",
  "sequence",
  "workspaceId",
  "threadId",
  "runId",
  "eventId",
  "environmentId",
  "createdAt",
  "progress",
  "items",
  "stream",
  "op",
  "text",
  "at",
  "length",
  "status",
  "inputQueuePaused",
  "pendingRequests",
  "notification",
  "states",
  "markers",
  "preferences",
  "sessions",
  "view",
  "reference",
  "catalog",
  "activity",
  "place",
  "reason",
  "error",
  "retryable",
  "nonce",
  "threads",
  "messages",
  "messagesOmitted",
  "runQueue",
]);

const realtimeHeaderSchema = z.object({ type: z.string().min(1) });
const realtimeEventTypes = new Set<string>(
  AgentEventViewSchema.options.map((schema) => schema.shape.type.value),
);
const realtimeReadableThreadSchema = ThreadViewSchema.extend({
  status: z.string().min(1),
}).transform((thread) => {
  const status = ThreadStatusSchema.safeParse(thread.status);
  return status.success ? { ...thread, status: status.data } : null;
});
const realtimeSnapshotSchema = z
  .object({
    ...WorkspaceSnapshotSchema.shape,
    threads: z
      .array(realtimeReadableThreadSchema)
      .max(workspaceSnapshotMaxThreads)
      .transform((threads) => threads.filter((thread) => thread !== null)),
  })
  .transform((snapshot) => WorkspaceSnapshotSchema.parse(snapshot));
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
    data: z.object({ thread: realtimeReadableThreadSchema, home: z.literal(true).optional() }),
  });
const realtimeResyncSchema = z.object({
  type: z.literal("host.resync-required"),
  workspaceId: WorkspaceIdSchema,
  // The reason explains the reset; every present or future reason requires it.
  reason: z.string().min(1),
});
type RealtimeMessage =
  | Exclude<HostToClientMessage, { type: "host.events" | "host.resync-required" }>
  | { type: "host.events"; events: RealtimeEvent[] }
  | z.infer<typeof realtimeResyncSchema>;

export function describeRealtimeFrameFailure(frame: unknown, error: unknown) {
  let envelopeType = "unknown";
  if (typeof frame === "string" && frame.length <= maxInboundFrameCharacters) {
    try {
      const value: unknown = JSON.parse(frame);
      if (
        typeof value === "object" &&
        value !== null &&
        "type" in value &&
        typeof value.type === "string" &&
        realtimeEnvelopeTypes.has(value.type)
      )
        envelopeType = value.type;
    } catch {
      /* Invalid JSON has no trustworthy envelope. */
    }
  }
  const issuePaths =
    error instanceof z.ZodError
      ? [
          ...new Set(
            error.issues.slice(0, 8).map(({ path }) =>
              path.length === 0
                ? "$"
                : path
                    .slice(0, 12)
                    .map((part) =>
                      typeof part === "number"
                        ? "[]"
                        : typeof part === "string" && realtimeDiagnosticFields.has(part)
                          ? part
                          : "*",
                    )
                    .join("."),
            ),
          ),
        ]
      : ["$"];
  const bytes =
    typeof frame === "string"
      ? new TextEncoder().encode(frame).byteLength
      : frame instanceof ArrayBuffer
        ? frame.byteLength
        : ArrayBuffer.isView(frame)
          ? frame.byteLength
          : 0;
  return {
    envelopeType,
    apiEpoch: hostApiVersion,
    bytes,
    issuePaths,
    category:
      error instanceof z.ZodError ? "schema" : error instanceof SyntaxError ? "json" : "frame",
  };
}

function realtimeFrameDiagnostic(
  frame: unknown,
  error: unknown,
  action: "ignored" | "rejected",
): void {
  try {
    console.warn(
      JSON.stringify({
        event: `host.realtime.frame-${action}`,
        ...describeRealtimeFrameFailure(frame, error),
      }),
    );
  } catch {
    /* Diagnostics cannot decide whether the channel is stopped. */
  }
}
const defaultReconnectMaxDelayMs = 12_000;
const maxBrowserFrameBytes = 8 * 1_024 * 1_024;
const workspacePrefetchDebounceMs = 150;
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

/** Frames a Workspace channel's own subscription sends, and the answer to its own probe. */
function showsSubscriptionProgress(message: RealtimeMessage, channel: WorkspaceChannel): boolean {
  switch (message.type) {
    case "host.snapshot":
    case "host.events":
    case "host.live":
    case "host.synchronized":
    case "host.read-markers":
    case "host.read-states":
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
    canSteer: queue.steerRunId !== null,
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

interface WorkspaceChannel {
  refused: boolean;
  protocolFailed?: boolean;
  cursor: Sequence;
  /** The nonce of the liveness probe this channel is waiting on, if any. */
  probeNonce: string | null;
  probeTimer: Timer | null;
  /** When the current socket last showed its subscription delivering. */
  progressAt: number;
  reconnectAttempt: number;
  reconnectTimer: Timer | null;
  socket: WebSocketClient | null;
  synchronized: boolean;
  workspaceId: string;
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

interface BrowserChannelState {
  /**
   * The Watch frame this socket delivered and has not yet acknowledged. The
   * Host sends the next only after it, so it is returned exactly once: when
   * the view has shown the picture, or when the picture is dropped unshown.
   */
  awaitingAck: string | null;
  reconnectAttempt: number;
  reconnectTimer: Timer | null;
  retainers: number;
  sessionId: string;
  socket: WebSocketClient | null;
  synchronized: boolean;
}

type BrowserChannel = BrowserChannelState &
  ({ mode: "control" } | { mode: "watch"; captureRegionRetainers: number });

/** The connection owner keeps discovery evidence within its attachment fence. */
export type HostCapabilityReader = (options?: {
  readonly revalidate: boolean;
}) => Promise<readonly HostCapability[]>;

export interface HttpHostClientOptions {
  /** The viewer's command platform for exact baseline shortcut projection. */
  readonly viewerPlatform?: "mac" | "pc";
  /** Verified by the connection owner for this client’s attachment. Null is unknown. */
  readonly capabilities?: readonly HostCapability[] | null | HostCapabilityReader;
  readonly recentSitesStorage?: RecentSitesStorage;
  /** The Host's origin. There is no ambient default: a React Native bundle has
   * no document to read one from, and a renderer may address another Host. */
  readonly baseUrl: string | URL;
  readonly fetch?: Fetch;
  readonly bufferedResponses?: boolean;
  /** Absent means the platform reports nothing, and the client never suspends. */
  readonly lifecycle?: ClientLifecycle;
  readonly random?: () => number;
  /** When a silent Workspace channel is questioned, and how long it has to answer. */
  readonly realtimeLiveness?: { readonly idleMs: number; readonly deadlineMs: number };
  readonly reconnectBaseDelayMs?: number;
  readonly reconnectMaxDelayMs?: number;
  readonly refreshIntervalMs?: number;
  /**
   * Starts Home's history as soon as bootstrap names it. For a client that
   * opens on Chat (the phone), activation follows at once and joins the read;
   * elsewhere an unopened Home would be held outside the Workspace's Thread page.
   */
  readonly prefetchHome?: boolean;
  readonly webSocketFactory?: (url: string) => WebSocketClient;
}

export class HttpHostClient {
  readonly recentSites: RecentSitesStore;
  readonly browserPreferences: BrowserPreferences;
  readonly retainComputerView: OwnerViewHostClient["retainComputerView"];
  readonly #viewer = new ViewerScope();
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
  readonly #browserChannels = new Map<string, BrowserChannel>();
  readonly #browserWatchChannels = new Map<string, BrowserChannel>();
  readonly #browserFrameListeners = new Map<string, Set<() => void>>();
  readonly #browserFrameValues = new Map<string, BrowserFrameView>();
  readonly #browserWatchFrameListeners = new Map<string, Set<() => void>>();
  readonly #browserWatchFrameValues = new Map<string, BrowserFrameView>();
  readonly #channels = new Map<string, WorkspaceChannel>();
  readonly #fetch: Fetch;
  readonly #listeners = new Set<() => void>();
  readonly #messagePageLoads = new Map<string, Promise<void>>();
  /**
   * Threads whose assignments were asked for, answered or not. A failed read
   * is not retried per event batch; an explicit refresh or a resync asks again.
   */
  readonly #assignmentReads = new Map<string, "read" | "reading">();
  /**
   * Per shown conversation whose browser usage has been read, the Runs that
   * read covered. A conversation not here is read whole when it is shown.
   */
  readonly #browserUsageRead = new Map<string, Set<string>>();
  readonly #browserUsageReads = new Map<string, { again: "full" | "missing" | null }>();
  /**
   * What each conversation's usage reads answered, by conversation. A use of
   * a browser the catalog does not list yet waits here until it does.
   */
  readonly #browserUses = new Map<
    string,
    readonly { readonly sessionId: string; readonly use: BrowserSessionUseSummary }[]
  >();
  /**
   * The shape a conversation's Runs were last collected from: a streamed reply
   * changes none of it, so it is not walked again for each word.
   */
  readonly #browserUsageRunSources = new Map<string, readonly unknown[]>();
  /**
   * When each browser or Mac session last had its presence patched, against a
   * counter a bootstrap notes before it reads: a bootstrap answer older than a
   * patch keeps the patch rather than putting the older page back.
   */
  readonly #presenceMarks = new Map<string, number>();
  /** The latest presence patch of each browser, kept for one the catalog does not list yet. */
  readonly #browserPresence = new Map<string, BrowserPresence>();
  #presenceCounter = 0;
  readonly #tabCatalogs = new Map<string, BrowserTabCatalog>();
  readonly #placeActivity = new PlaceActivityStore();
  readonly #latestPlace = new LatestPlaceStore();
  readonly #targetedControl = new BrowserWatchStore(
    (sessionId, surfaceId) => this.#targetedBrowserSocket(sessionId, surfaceId, "control"),
    "control",
    (sessionId, message, surfaceId) => {
      if (message.type === "browser.snapshot")
        this.#browserEditing.negotiate(
          sessionId,
          message.editingVersion,
          surfaceId,
          message.clipboard,
        );
      else this.#browserEditing.receive(sessionId, message);
      if (message.type === "browser.snapshot" || message.type === "browser.surfaces.changed")
        this.#patchBrowserSession(sessionId, { tabs: browserTabs(message.surfaces) });
      if (message.type === "browser.snapshot" || message.type === "browser.dialog.changed")
        this.#patchBrowserSession(sessionId, { dialog: message.dialog });
    },
    (attempt) => this.#reconnectDelay(attempt),
    () => this.#capabilities?.includes("browser-capture-region-v1") === true,
    (sessionId, surfaceId) => this.#browserEditing.disconnect(sessionId, surfaceId),
  );
  readonly #targetedWatch = new BrowserWatchStore(
    (sessionId, surfaceId) => this.#targetedBrowserSocket(sessionId, surfaceId, "watch"),
    "watch",
    undefined,
    (attempt) => this.#reconnectDelay(attempt),
    () => this.#capabilities?.includes("browser-capture-region-v1") === true,
  );
  #targetedBrowserSocket(
    sessionId: string,
    surfaceId: string,
    mode: "control" | "watch",
  ): WebSocketClient {
    const session = this.#snapshot.browserSessions.find((session) => session.id === sessionId);
    if (
      this.#disposed ||
      this.#snapshot.session !== "authenticated" ||
      session?.state !== "ready" ||
      this.#forbiddenWorkspaces.has(session.workspaceId) ||
      !session.tabCatalog?.tabs.some((tab) => tab.id === surfaceId)
    )
      throw new Error("The browser target is unavailable.");
    const url = new URL(
      `/v1/browser-sessions/${encodeURIComponent(sessionId)}/connect`,
      this.#baseUrl,
    );
    if (mode === "watch") url.searchParams.set("mode", mode);
    url.searchParams.set("editing", "2");
    return this.#webSocketFactory(url.toString().replace(/^http/, "ws"));
  }
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
    if (options?.editing === 1) {
      url.searchParams.set("editing", "1");
      if (ref.kind === "task-session") url.searchParams.set("displayCut", "1");
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
  readonly latestPlaceOfThread = this.#latestPlace.get;
  readonly subscribeLatestPlace = this.#latestPlace.subscribe;
  readonly browserWatchState = this.#targetedWatch.get;
  readonly browserViewerState = this.#targetedControl.status;
  readonly subscribeBrowserViewer = this.#targetedControl.subscribeStatus;
  readonly browserWatchFrame = (sessionId: string, surfaceId: string) =>
    this.#targetedWatch.get(sessionId, surfaceId).frame;
  readonly subscribeBrowserWatch = this.#targetedWatch.subscribe;
  async readBrowserContextCandidate(sessionId: string, tabId: string) {
    return unwrapRpcResult(await this.rpc["browser.contextCandidate.get"]({ sessionId, tabId }));
  }
  #acceptCatalog(
    sessionId: string,
    incoming: BrowserTabCatalog | undefined,
  ): BrowserTabCatalog | undefined {
    const session = this.#snapshot.browserSessions.find((session) => session.id === sessionId);
    if (session?.state === "closed" || session?.state === "failed") {
      if (incoming) {
        this.#tabCatalogs.set(sessionId, incoming);
        return incoming;
      }
    }
    const catalog = newerBrowserTabCatalog(
      newerBrowserTabCatalog(session?.tabCatalog, this.#tabCatalogs.get(sessionId)),
      incoming,
    );
    if (catalog) {
      if (!this.#tabCatalogs.has(sessionId) && this.#tabCatalogs.size >= 100)
        this.#tabCatalogs.delete(this.#tabCatalogs.keys().next().value!);
      this.#tabCatalogs.set(sessionId, catalog);
    }
    return catalog;
  }
  async openBrowserTab(target: string | BrowserTabOpenInput, options: BrowserTabOpenOptions = {}) {
    const started = this.#viewer.generation;
    const result = unwrapRpcResult(
      await this.rpc["commands.dispatch"]({
        type: "browser.tab.open",
        ...(typeof target === "string" ? { sessionId: target } : target),
        ...(options.url === undefined ? {} : { url: options.url }),
        ...(options.viewport ? { viewport: options.viewport } : {}),
        idempotencyKey: options.idempotencyKey ?? mutationIdempotencyKey("open-tab"),
      }),
    );
    if (started !== this.#viewer.generation)
      throw new HostClientRequestError({
        code: "unauthorized",
        status: 401,
        message: "The signed-in account changed while the browser was opening.",
      });
    if (result.type !== "browser.tab.open") throw new Error("Unexpected browser command result.");
    const existing = this.#snapshot.browserSessions.find(
      (session) => session.id === result.sessionId,
    );
    if (existing?.state === "closed" || existing?.state === "failed") return result;
    this.#update({
      ...this.#snapshot,
      browserSessions: existing
        ? this.#snapshot.browserSessions.map((session) =>
            session.id === result.sessionId
              ? toBrowserSessionSummary(result.session, existing, null, existing.uses ?? [])
              : session,
          )
        : [
            ...this.#snapshot.browserSessions,
            toBrowserSessionSummary(result.session, undefined, null, []),
          ],
    });
    const catalog = this.#acceptCatalog(result.sessionId, result.catalog);
    if (catalog) this.#patchBrowserSession(result.sessionId, { tabCatalog: catalog });
    return result;
  }
  readonly #retainedWorkspaceTabLineages = new Map<string, WorkspaceTabLineage>();
  readonly #workspaceTabReads = new Map<string, Promise<WorkspaceTabLineage | null>>();
  readWorkspaceTabs(sessionId: string): Promise<WorkspaceTabLineage | null> {
    const held = this.#workspaceTabReads.get(sessionId);
    if (held) return held;
    const viewer = this.#viewer.generation;
    const read = (async () => {
      let group: WorkspaceTabLineage;
      try {
        group = unwrapRpcResult(await this.rpc["workspace.tabs.get"]({ groupId: sessionId }));
      } catch (error) {
        if (viewer !== this.#viewer.generation) return null;
        if (
          !(error instanceof HostClientRequestError) ||
          !["not_found", "forbidden"].includes(error.code)
        )
          throw error;
        for (const [id, cached] of this.#retainedWorkspaceTabLineages)
          if (id === sessionId || cached.session.id === sessionId)
            this.#retainedWorkspaceTabLineages.delete(id);
        this.#update({
          ...this.#snapshot,
          workspaceTabs: this.#snapshot.workspaceTabs?.filter(
            (group) => group.id !== sessionId && group.session.id !== sessionId,
          ),
        });
        return null;
      }
      if (this.#disposed || viewer !== this.#viewer.generation) return null;
      const previous = this.#snapshot.workspaceTabs?.find((held) => held.id === group.id);
      if (previous && previous.revision > group.revision) group = previous;
      this.#retainedWorkspaceTabLineages.set(group.id, group);
      this.#update({
        ...this.#snapshot,
        workspaceTabs: [
          ...(this.#snapshot.workspaceTabs ?? []).filter((held) => held.id !== group.id),
          group,
        ],
      });
      return group;
    })();
    this.#workspaceTabReads.set(sessionId, read);
    void read
      .finally(() => {
        if (this.#workspaceTabReads.get(sessionId) === read)
          this.#workspaceTabReads.delete(sessionId);
      })
      .catch(() => undefined);
    return read;
  }

  readonly #workspaceTabActivations: WorkspaceTabActivations;
  activateWorkspaceTab(tabId: string) {
    return this.#workspaceTabActivations.activate(tabId);
  }

  #applyWorkspaceTabActivation(
    result: NonNullable<
      Awaited<ReturnType<NonNullable<OwnerViewHostClient["activateWorkspaceTab"]>>>
    >,
  ) {
    const existing = this.#snapshot.browserSessions.find(
      (session) => session.id === result.session.id,
    );
    this.#update({
      ...this.#snapshot,
      workspaceTabs: this.#snapshot.workspaceTabs?.some((group) => group.id === result.group.id)
        ? this.#snapshot.workspaceTabs.map((group) =>
            group.id === result.group.id && result.group.revision >= group.revision
              ? result.group
              : group,
          )
        : [...(this.#snapshot.workspaceTabs ?? []), result.group],
      browserSessions: [
        ...this.#snapshot.browserSessions.filter((session) => session.id !== result.session.id),
        toBrowserSessionSummary(result.session, existing, null, existing?.uses ?? []),
      ],
    });
    const catalog = this.#acceptCatalog(result.session.id, result.catalog);
    if (catalog) this.#patchBrowserSession(result.session.id, { tabCatalog: catalog });
  }
  async reopenWorkspaceTab() {
    if (!this.#snapshot.workspaceTabReopenAvailable)
      throw new Error("This Host cannot reopen closed tabs.");
    const viewer = this.#viewer.generation;
    const result = unwrapRpcResult(
      await this.rpc["commands.dispatch"]({
        type: "workspace.tab.reopen",
        idempotencyKey: mutationIdempotencyKey("reopen-tab"),
      }),
    );
    if (viewer !== this.#viewer.generation)
      throw new Error("The signed-in account changed while reopening the tab.");
    if (result.type !== "workspace.tab.reopen") throw new Error("Unexpected tab reopen result.");
    const held = this.#snapshot.workspaceTabs?.find((group) => group.id === result.group.id);
    this.#update({
      ...this.#snapshot,
      workspaceTabs: [
        ...(this.#snapshot.workspaceTabs ?? []).filter((group) => group.id !== result.group.id),
        held && held.revision > result.group.revision ? held : result.group,
      ],
      browserTabGroups: this.#tabGroups.receive(result.layout),
    });
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
  readonly closeWorkspaceTabs: OwnerViewHostClient["closeWorkspaceTabs"] = async (tabIds) => {
    const viewer = this.#viewer.generation;
    const result = unwrapRpcResult(
      await this.rpc["commands.dispatch"]({
        type: "workspace.tabs.close",
        tabIds: tabIds.map((id) => BrowserSurfaceIdSchema.parse(id)),
        idempotencyKey: mutationIdempotencyKey("close-tabs"),
      }),
    );
    if (viewer !== this.#viewer.generation)
      throw new Error("The signed-in account changed while closing tabs.");
    if (result.type !== "workspace.tabs.close") throw new Error("Unexpected tabs close result.");
    const closed = new Set<string>(result.closed);
    // Batch results name closed tabs; the Host notice supplies their lineage revisions.
    this.#update({
      ...this.#snapshot,
      workspaceTabs: this.#snapshot.workspaceTabs?.map((lineage) =>
        lineage.tabs?.some((tab) => closed.has(tab.id))
          ? { ...lineage, tabs: lineage.tabs.filter((tab) => !closed.has(tab.id)) }
          : lineage,
      ),
    });
    this.#tabGroups.removeClosed(result.closed);
    return result;
  };
  async closeBrowserTab(
    sessionId: string,
    surfaceId: string,
    expected: Pick<BrowserTabCatalog, "generation" | "revision" | "inventoryRevision">,
  ) {
    if (
      this.#snapshot.workspaceTabRestoreVersion === 1 &&
      this.#snapshot.workspaceTabs?.some((group) => group.tabs?.some((tab) => tab.id === surfaceId))
    ) {
      const viewer = this.#viewer.generation;
      const result = unwrapRpcResult(
        await this.rpc["commands.dispatch"]({
          type: "workspace.tab.close",
          tabId: surfaceId,
          idempotencyKey: `close:${surfaceId}`,
        }),
      );
      if (viewer !== this.#viewer.generation)
        throw new Error("The signed-in account changed while closing the tab.");
      if (result.type !== "workspace.tab.close") throw new Error("Unexpected tab close result.");
      this.#update({
        ...this.#snapshot,
        workspaceTabs: this.#snapshot.workspaceTabs?.map((group) =>
          group.id === result.group.id && result.group.revision >= group.revision
            ? result.group
            : group,
        ),
      });
      return {
        type: "browser.tab.close" as const,
        sessionId: BrowserSessionIdSchema.parse(sessionId),
        outcome: "tab-closed" as const,
        catalog: { generation: 0, revision: 0, tabs: [] },
      };
    }
    const current = this.#snapshot.browserSessions.find(
      (session) => session.id === sessionId,
    )?.tabCatalog;
    const inventoryRevision =
      expected.inventoryRevision ??
      (current?.generation === expected.generation && current.revision === expected.revision
        ? (current.inventoryRevision ?? expected.revision)
        : expected.revision);
    const result = unwrapRpcResult(
      await this.rpc["commands.dispatch"]({
        type: "browser.tab.close",
        sessionId,
        surfaceId,
        expectedGeneration: expected.generation,
        expectedRevision: inventoryRevision,
        idempotencyKey: `close-tab:${sessionId}:${surfaceId}:${expected.generation}:${inventoryRevision}`,
      }),
    );
    if (result.type !== "browser.tab.close") throw new Error("Unexpected browser command result.");
    const catalog = this.#acceptCatalog(sessionId, result.catalog);
    this.#patchBrowserSession(sessionId, {
      ...(catalog ? { tabCatalog: catalog } : {}),
      ...(result.outcome === "session-closed" ? { state: "closed" as const } : {}),
    });
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
  /** A reconnect snapshot overtook a history read, so its transcript must be read again. */
  readonly #invalidatedHydrations = new Set<string>();
  readonly #threadInputQueueLoads = new Map<string, Promise<ThreadInputQueue>>();
  /** Threads whose queue an event touched while a read of it was in flight. */
  readonly #threadInputQueueRereads = new Set<string>();
  /**
   * One key per steer or cancel attempt, held until the Host answers it, so a
   * retry after a lost answer repeats the mutation instead of adding one.
   */
  readonly #threadInputMutationKeys = new Map<string, string>();
  readonly #hydratedThreads = new Set<string>();
  readonly #historicalThreads = new Set<string>();
  readonly #readStateLoads = new Set<Map<string, Sequence>>();
  readonly #notificationPreferences = new Map<string, WorkspaceNotificationPreference>();
  readonly #forbiddenWorkspaces = new Set<string>();
  /**
   * Assignments the Host refused this viewer (403 or 404). Nothing held for
   * them is shown, and no later event, page or read brings them back.
   */
  readonly #deniedAssignments = new Set<string>();
  readonly #threadWorkspace = new Map<string, string>();
  #viewerGeneration = 0;
  readonly #notificationListeners = new Set<(notification: NotificationView) => void>();
  readonly #lifecycleListeners = new Set<
    (event: "background" | "foreground" | "network") => void
  >();
  /**
   * Notifications already handed to listeners, oldest first. The Host sends
   * each to every socket of its recipient, one per subscribed Workspace.
   */
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
  readonly #threadIcons = new Map<
    string,
    { readonly icon: WorkspaceIconName; readonly token: symbol }
  >();
  readonly #workspaceColors = new Map<string, Pick<WorkspaceSummary, "color" | "updatedAt">>();
  readonly #workspaceColorEdits = new Map<
    string,
    { readonly color: WorkspaceSummary["color"]; readonly token: symbol }
  >();
  /** The authority for `snapshot.runQueue`, reconciled across events, reads and answers. */
  readonly #runQueue = new RunQueueProjection();
  /** What each active Run is streaming, the authority for every live entry drawn. */
  readonly #live = new LiveStreamLedger();
  /** Threads whose streams are reread whole, one read at a time per Thread. */
  readonly #liveRereads = new Map<string, LiveReread>();
  /**
   * Progress that follows durable events this client has not received yet,
   * per Workspace. A reread answers over HTTP, ahead of the event stream, and
   * is drawn only once the events it follows have been applied.
   */
  readonly #heldLive = new Map<string, LiveProgressInput[]>();
  /**
   * Each Workspace subscription's generation. A resubscription starts the
   * streams over, so a reread asked for under an older one is discarded.
   */
  readonly #liveGenerations = new Map<string, number>();
  readonly #latestTranscriptLoads = new Map<string, Promise<void>>();
  #activeThreadId: string | null = null;
  #activeWorkspaceId: string | null = null;
  readonly #random: () => number;
  readonly #livenessIdleMs: number;
  readonly #livenessDeadlineMs: number;
  #livenessTimer: Timer | null = null;
  readonly #reconnectBaseDelayMs: number;
  readonly #reconnectMaxDelayMs: number;
  readonly #refreshIntervalMs: number;
  readonly #prefetchHome: boolean;
  readonly #webSocketFactory: (url: string) => WebSocketClient;
  readonly #lifecycleDisposers: (() => void)[] = [];
  readonly #socketTrustWindowMs: number;
  #network: ClientNetworkState;
  #visibility: ClientVisibility;
  #backgroundedAt: number | null = null;
  #workspacePageLoad: Promise<void> | null = null;
  #bootstrapPromise: Promise<void> | null = null;
  #rereadPending = false;
  #waitingRead: "again" | "idle" | "reading" = "idle";
  /**
   * Per task list — `null` for the reader's whole list, else a Workspace's —
   * the first-page read in flight, and whether a notice during it owes one more.
   */
  readonly #taskReads = new Map<string | null, { again: boolean; done: Promise<void> }>();
  /** Per task list, the one read of a later page in flight, for the viewer that asked. */
  readonly #taskPageLoads = new Map<
    string | null,
    { readonly generation: number; readonly promise: Promise<void> }
  >();
  /** The Workspaces whose own task list a screen asked for, kept current from then on. */
  readonly #workspaceTaskScopes = new Set<string>();
  #disposed = false;
  #refreshTimer: Timer | null = null;
  #workspacePrefetchTimer: Timer | null = null;
  #snapshot: HostSnapshot = emptySnapshot();

  readonly #viewerPlatform: "mac" | "pc" | null;
  constructor(options: HttpHostClientOptions) {
    this.#viewerPlatform = options.viewerPlatform ?? null;
    this.#readCapabilities =
      typeof options.capabilities === "function" ? options.capabilities : null;
    this.#capabilities = Array.isArray(options.capabilities) ? [...options.capabilities] : null;
    this.browserPreferences = new BrowserPreferences(options.recentSitesStorage);
    this.recentSites = new RecentSitesStore(
      options.recentSitesStorage ? { storage: options.recentSitesStorage } : {},
    );
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
    this.#workspaceTabActivations = new WorkspaceTabActivations({
      snapshot: () => this.#snapshot,
      subscribe: (listener) => this.subscribe(listener),
      changed: () => this.#update(this.#snapshot),
      dispatch: async (tabId) => {
        const result = unwrapRpcResult(
          await this.rpc["commands.dispatch"]({
            type: "workspace.tab.activate",
            tabId,
            idempotencyKey: `restore:${tabId}`,
          }),
        );
        if (result.type !== "workspace.tab.activate")
          throw new Error("Unexpected tab activation result.");
        return result;
      },
      apply: (result) => this.#applyWorkspaceTabActivation(result),
    });
    this.#tabGroups = new BrowserTabGroupClient(
      this.rpc,
      (browserTabGroups) => this.#update({ ...this.#snapshot, browserTabGroups }),
      () => this.#viewer.generation,
      () => browserTabOrderTabs(this.#snapshot.workspaceTabs),
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
    this.#prefetchHome = options.prefetchHome === true;
    this.#webSocketFactory = options.webSocketFactory ?? ((url) => new globalThis.WebSocket(url));
    this.#socketTrustWindowMs = options.lifecycle?.socketTrustWindowMs ?? socketTrustWindowMs;
    const lifecycle = options.lifecycle?.getSnapshot();
    this.#network = lifecycle?.network ?? "unknown";
    this.#snapshot = {
      ...this.#snapshot,
      network: this.#network,
      threadRenameAvailable: this.#capabilities?.includes("thread-titles-v1") === true,
      taskMarksAvailable: this.#capabilities?.includes("task-marks-v1") === true,
      sharedTaskDoneAvailable: this.#capabilities?.includes("shared-task-done-v1") === true,
      workspaceTabReopenAvailable: this.#capabilities?.includes("workspace-tab-reopen-v1") === true,
      searchSuggestionsAvailable:
        this.#capabilities?.includes("browser-search-suggestions-v1") === true,
      iphoneAppsAvailable: this.#capabilities?.includes("iphone-apps-v1") === true,
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
    );
    this.#computerViews = views;
    this.retainComputerView = views.retainComputerView;
    this.openComputerView = views.openComputerView;
    this.closeComputerView = views.closeComputerView;
    this.renewComputerView = views.renewComputerView;
    this.listApprovedComputerApps = views.listApprovedComputerApps;
    this.listComputerAppWindows = views.listComputerAppWindows;
  }

  readonly getSnapshot = (): HostSnapshot => this.#snapshot;

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
    editing: this.#browserEditing,
    scope: this.#browserPresentationScope,
    accept: (sessionId, surfaceId, token) => {
      if (surfaceId) this.#targetedControl.accept(sessionId, surfaceId, token);
      else {
        const channel = this.#browserChannels.get(sessionId);
        if (channel?.awaitingAck === token) this.#returnWatchCredit(channel);
      }
    },
    get: (sessionId, surfaceId) =>
      surfaceId
        ? this.#targetedControl.get(sessionId, surfaceId).frame
        : (this.#browserFrameValues.get(sessionId) ?? null),
    subscribe: (sessionId, listener, surfaceId) => {
      if (surfaceId) return this.#targetedControl.subscribe(sessionId, surfaceId, listener);
      if (this.#disposed) return () => undefined;
      const listeners = this.#browserFrameListeners.get(sessionId) ?? new Set<() => void>();
      listeners.add(listener);
      this.#browserFrameListeners.set(sessionId, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) this.#browserFrameListeners.delete(sessionId);
      };
    },
  };
  readonly browserWatchFrames: BrowserFrameStore = {
    scope: this.#browserPresentationScope,
    accept: (sessionId, surfaceId, token) =>
      this.acceptBrowserWatchFrame(sessionId, token, surfaceId),
    get: (sessionId, surfaceId) =>
      surfaceId
        ? this.#targetedWatch.get(sessionId, surfaceId).frame
        : (this.#browserWatchFrameValues.get(sessionId) ?? null),
    subscribe: (sessionId, listener, surfaceId) => {
      if (surfaceId) return this.#targetedWatch.subscribe(sessionId, surfaceId, listener);
      const listeners = this.#browserWatchFrameListeners.get(sessionId) ?? new Set<() => void>();
      listeners.add(listener);
      this.#browserWatchFrameListeners.set(sessionId, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) this.#browserWatchFrameListeners.delete(sessionId);
      };
    },
  };

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  async dispatch(command: HostApiCommandInput): Promise<HostApiCommandOutput> {
    const parsedCommand = hostApi["commands.dispatch"].payload.parse(command);
    if (parsedCommand.type === "thread.shared-done.set" && !this.#snapshot.sharedTaskDoneAvailable)
      throw new Error("This Host does not support shared task Done.");
    if (parsedCommand.type === "thread.icon.set" || parsedCommand.type === "workspace.color.set") {
      if (!this.#snapshot.taskMarksAvailable)
        throw new Error("This Host does not support task marks.");
      return parsedCommand.type === "thread.icon.set"
        ? this.#setThreadIcon(parsedCommand)
        : this.#setWorkspaceColor(parsedCommand);
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
      case "browser.session.start": {
        // Viewer state (tabs, dialog, socket health) lives only on the client,
        // so a restarted session has to inherit it rather than reset it.
        // The Host answers with the conversation it was opened from already
        // using it.
        const session = toBrowserSessionSummary(
          result.session,
          this.#snapshot.browserSessions.find((item) => item.id === result.session.id),
          null,
          this.#browserUsesBySession().get(result.session.id) ?? [],
        );
        const workspaceId = commandIs(parsedCommand, result.type)
          ? parsedCommand.workspaceId
          : session.workspaceId;
        this.#update(
          applyOptimisticCommandPatch(this.#snapshot, {
            session,
            type: result.type,
            workspaceId,
          }),
        );
        this.#ensureBrowserChannel(session.id);
        break;
      }
      case "browser.profile.create":
      case "browser.session.profile.save":
        this.#update(
          applyOptimisticCommandPatch(this.#snapshot, {
            profile: result.profile,
            type: result.type,
          }),
        );
        break;
      case "browser.profile.grant":
        this.#update(
          applyOptimisticCommandPatch(this.#snapshot, { grant: result.grant, type: result.type }),
        );
        break;
      case "browser.profileGrant.revoke":
        if (commandIs(parsedCommand, result.type)) {
          this.#update(
            applyOptimisticCommandPatch(this.#snapshot, {
              grantId: parsedCommand.grantId,
              type: result.type,
            }),
          );
        }
        break;
      case "browser.session.close":
        if (commandIs(parsedCommand, result.type)) {
          // Nothing will arrive on the viewer socket again; drop it and its
          // retained frame before the session is marked closed.
          this.#closeBrowserChannel(parsedCommand.sessionId);
          this.#closeBrowserChannel(parsedCommand.sessionId, "watch");
          this.#update(
            applyOptimisticCommandPatch(this.#snapshot, {
              sessionId: parsedCommand.sessionId,
              type: result.type,
            }),
          );
        }
        break;
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
      case "workspace.create":
      case "workspace.delete":
      case "workspace.deletion.recover":
      case "workspace.icon.set":
      case "workspace.color.set":
      case "workspace.storage.retry": {
        const workspace = this.#toWorkspaceSummary(result.workspace);
        this.#update(applyOptimisticCommandPatch(this.#snapshot, { type: result.type, workspace }));
        if (result.type === "workspace.create") this.#ensureWorkspaceChannel(workspace.id);
        break;
      }
      case "thread.create":
      case "thread.shared-done.set":
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
          if (compareSequence(page.readState.asOfSequence, source.asOfSequence) >= 0)
            source = { thread: page.thread, asOfSequence: page.readState.asOfSequence };
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
          const workspaceId = this.#threadWorkspace.get(parsedCommand.threadId);
          // The answer may arrive after the Run's own events; it never takes
          // back what they said, including that the Run already ended.
          const admitted =
            run !== null &&
            workspaceId !== undefined &&
            this.#runQueue.acknowledge(run, workspaceId);
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
    readonly workspaceId: string;
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

  async getAttachment(attachmentId: string): Promise<Attachment> {
    return unwrapRpcResult(await this.rpc["attachment.get"]({ attachmentId }));
  }

  async readAttachment(attachmentId: string, signal?: AbortSignal): Promise<Blob> {
    const content = unwrapRpcResult(
      await this.rpc["attachment.content"]({ attachmentId }, signal ? { signal } : undefined),
    );
    return new Blob([content.bytes], { type: content.metadata.contentType });
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

  activateWorkspace(workspaceId: string): void {
    if (!this.#snapshot.workspaces.some(({ id }) => id === workspaceId)) return;
    this.#ensureWorkspaceChannel(workspaceId);
    if (this.#activeWorkspaceId === workspaceId) return;
    this.#activeWorkspaceId = workspaceId;
    this.#recomputeConnection();
    if (this.#workspacePrefetchTimer) globalThis.clearTimeout(this.#workspacePrefetchTimer);
    this.#workspacePrefetchTimer = globalThis.setTimeout(() => {
      this.#workspacePrefetchTimer = null;
      void this.rpc["workspace.prefetch"]({ workspaceId }).catch(() => undefined);
    }, workspacePrefetchDebounceMs);
  }

  activateThread(threadId: string): void {
    const thread = this.#snapshot.threads.find(({ id }) => id === threadId);
    this.#activeThreadId = threadId;
    this.#ensureInputQueue(threadId);
    this.#ensureAssignments(threadId);
    this.#ensureBrowserUsage(threadId, "missing");
    if (!thread) {
      // A deep link can reference a Thread the snapshot has not loaded yet.
      // Durable history resolves it: every event names the workspace, and the
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
    this.activateWorkspace(thread.workspaceId);
    this.#ensureThreadHydration(threadId);
    this.#ensureRequests(threadId);
  }

  /**
   * An observed Thread is held exactly like the active one — hydrated, its
   * Workspace channel open, its Requests and assignments read — except that
   * it never becomes the active conversation or moves a read marker. A
   * Workspace channel it opened stays open like any other the reader visited,
   * so observing it again, or reconnecting, resumes its stream.
   */
  observeThread(threadId: string): () => void {
    this.#observedThreads.set(threadId, (this.#observedThreads.get(threadId) ?? 0) + 1);
    if (!this.#snapshot.transcriptWindows[threadId]) {
      this.#update({
        ...this.#snapshot,
        threadLookups: { ...this.#snapshot.threadLookups, [threadId]: "loading" },
      });
    }
    const workspaceId = this.#threadWorkspace.get(threadId);
    if (workspaceId) this.#ensureWorkspaceChannel(workspaceId);
    this.#ensureThreadHydration(threadId);
    this.#ensureRequests(threadId);
    this.#ensureAssignments(threadId);
    this.#ensureBrowserUsage(threadId, "missing");
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      const count = this.#observedThreads.get(threadId) ?? 0;
      if (count <= 1) this.#observedThreads.delete(threadId);
      else this.#observedThreads.set(threadId, count - 1);
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

  async #readAssignments(threadId: string): Promise<void> {
    const generation = this.#viewerGeneration;
    const userId = this.#snapshot.user?.id;
    let response;
    try {
      response = unwrapRpcResult(
        await this.rpc["thread.assignments.list"]({ threadId, limit: 100 }),
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

  /**
   * Reads a shown conversation's browser usage. `full` rereads everything:
   * the Host said it changed, or a reconnect may have missed that it did.
   * `missing` reads only what this client has never read: the conversation
   * the first time it is shown, or Runs that have appeared in it since — a
   * history page, or a task's worker — whose pages a link may need. A bootstrap
   * poll asks nothing; usage the Host announces is reread when it says so.
   *
   * A conversation is read once its Workspace stream is live, and not before:
   * a notice sent between an earlier answer and the subscription would be
   * lost, so that answer would have to be read again.
   */
  #ensureBrowserUsage(threadId: string, mode: "full" | "missing"): void {
    if (
      this.#disposed ||
      this.#snapshot.session !== "authenticated" ||
      // With no browser in the catalog there is nothing a conversation can show.
      this.#snapshot.browserSessions.length === 0 ||
      !ThreadIdSchema.safeParse(threadId).success ||
      !this.#showsThread(threadId)
    )
      return;
    const workspaceId = this.#threadWorkspace.get(threadId);
    const channel = workspaceId === undefined ? undefined : this.#channels.get(workspaceId);
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
   * A use of a browser the catalog does not list yet is kept, and appears on
   * that browser once a catalog read brings it.
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
        ({ use }) => replaced !== null && use.runId !== null && !replaced.has(use.runId),
      ),
      ...uses.map(({ sessionId, ...use }) => ({ sessionId, use })),
    ]);
    const bySession = this.#browserUsesBySession();
    this.#update({
      ...this.#snapshot,
      browserUsage: { ...this.#snapshot.browserUsage, [threadId]: { loading: false, error } },
      browserSessions: this.#snapshot.browserSessions.map((session) => {
        const sessionUses = bySession.get(session.id) ?? [];
        return sameElements(session.uses ?? [], sessionUses)
          ? session
          : { ...session, uses: sessionUses };
      }),
    });
  }

  /** Every use this client has read, by browser, each the object its read answered. */
  #browserUsesBySession(): ReadonlyMap<string, readonly BrowserSessionUseSummary[]> {
    const bySession = new Map<string, BrowserSessionUseSummary[]>();
    for (const uses of this.#browserUses.values()) {
      for (const { sessionId, use } of uses) {
        const sessionUses = bySession.get(sessionId) ?? [];
        sessionUses.push(use);
        bySession.set(sessionId, sessionUses);
      }
    }
    return bySession;
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

  /**
   * What a person sees about some browsers changed; patched in place, nothing
   * reread. The Host sends a browser's presence only when it changes, so a
   * patch for a browser the catalog does not list yet is kept for when it
   * does, and a catalog read that began before the patch does not undo it.
   */
  #applyBrowserPresence(presences: readonly BrowserPresence[]): void {
    const byId = new Map(presences.map((presence) => [presence.sessionId as string, presence]));
    for (const [sessionId, presence] of byId) {
      this.#presenceMarks.set(sessionId, ++this.#presenceCounter);
      this.#browserPresence.set(sessionId, presence);
    }
    let changed = false;
    const browserSessions = this.#snapshot.browserSessions.map((session) => {
      const presence = byId.get(session.id);
      if (!presence) return session;
      if (
        (session.acting ?? false) === presence.acting &&
        (session.page?.title ?? null) === (presence.page?.title ?? null) &&
        (session.page?.url ?? null) === (presence.page?.url ?? null)
      )
        return session;
      changed = true;
      return { ...session, acting: presence.acting, page: presence.page };
    });
    if (changed) this.#update({ ...this.#snapshot, browserSessions });
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
      }
    });
    this.#requestLoads.set(threadId, operation);
    void operation.catch(() => undefined);
  }

  async load(): Promise<void> {
    if (this.#disposed) throw new Error("The Host client is closed.");
    await this.#bootstrap();
  }

  async refresh(options?: { readonly retryConnection?: boolean }): Promise<void> {
    if (this.#disposed) return;
    if (options?.retryConnection)
      for (const channel of this.#channels.values()) {
        channel.refused = false;
        channel.protocolFailed = false;
      }
    this.#assignmentReads.clear();
    this.#requestReads.clear();
    await this.#bootstrap(false, true);
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
    await this.#bootstrap(true, true);
  }

  async loadEarlierTranscript(threadId: string): Promise<void> {
    const existing = this.#messagePageLoads.get(threadId);
    if (existing) return existing;
    const operation = this.#loadEarlierTranscript(threadId).finally(() => {
      if (this.#messagePageLoads.get(threadId) === operation) {
        this.#messagePageLoads.delete(threadId);
      }
    });
    this.#messagePageLoads.set(threadId, operation);
    return operation;
  }

  async searchThreadMessages(input: { threadId: string; query: string; before?: string }) {
    return unwrapRpcResult(await this.rpc["thread.messages.list"]({ ...input, limit: 50 }));
  }

  async loadTranscriptAround(threadId: string, messageId: string): Promise<void> {
    await this.#threadHydrations.get(threadId);
    await this.#latestTranscriptLoads.get(threadId);
    await this.#messagePageLoads.get(threadId);
    const page = unwrapRpcResult(
      await this.rpc["thread.events.list"]({ threadId, aroundMessageId: messageId }),
    );
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
    const hydration = this.#threadHydrations.get(threadId);
    if (hydration) await hydration;
    const pageLoad = this.#messagePageLoads.get(threadId);
    if (pageLoad) await pageLoad;
    await this.#hydrateThread(threadId, true);
    if (generation === this.#viewerGeneration) this.#hydratedThreads.add(threadId);
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

  #applyReadStates(
    incoming: readonly ThreadReadState[],
    markers?: ReadonlyMap<string, Sequence>,
  ): void {
    const states = { ...this.#snapshot.threadReadStates };
    for (const state of incoming) {
      if (this.#forbiddenWorkspaces.has(this.#threadWorkspace.get(state.threadId) ?? "")) continue;
      const marker = markers?.get(state.threadId);
      const merged = mergeThreadReadState(states[state.threadId], state);
      states[state.threadId] =
        marker && compareSequence(marker, merged.readSequence ?? zeroSequence) > 0
          ? { ...merged, readSequence: marker }
          : merged;
    }
    this.#update({ ...this.#snapshot, threadReadStates: states });
  }

  #applyReadMarkers(markers: readonly { threadId: string; readSequence: Sequence }[]): void {
    const states = { ...this.#snapshot.threadReadStates };
    for (const { threadId, readSequence } of markers) {
      if (this.#forbiddenWorkspaces.has(this.#threadWorkspace.get(threadId) ?? "")) continue;
      for (const pending of this.#readStateLoads) {
        pending.set(threadId, maxSequence(pending.get(threadId) ?? zeroSequence, readSequence));
      }
      const state = states[threadId];
      if (state && compareSequence(readSequence, state.readSequence ?? zeroSequence) > 0)
        states[threadId] = { ...state, readSequence };
    }
    this.#update({ ...this.#snapshot, threadReadStates: states });
  }

  #applyNotificationPreferences(preferences: readonly WorkspaceNotificationPreference[]): void {
    for (const preference of preferences) {
      if (this.#forbiddenWorkspaces.has(preference.workspaceId)) continue;
      const previous = this.#notificationPreferences.get(preference.workspaceId);
      if (!previous || compareSequence(preference.revision, previous.revision) >= 0)
        this.#notificationPreferences.set(preference.workspaceId, preference);
    }
    this.#update({
      ...this.#snapshot,
      notificationMutes: [...this.#notificationPreferences.values()]
        .filter(({ muted }) => muted)
        .map(({ workspaceId }) => workspaceId),
    });
  }

  async markThreadRead(threadId: string, throughSequence: string): Promise<void> {
    const generation = this.#viewerGeneration;
    const userId = this.#snapshot.user?.id;
    const known = this.#snapshot.threadReadStates[threadId]?.readSequence;
    if (known !== null && known !== undefined && BigInt(known) >= BigInt(throughSequence)) return;
    const result = await this.dispatch({
      type: "thread.read.mark",
      idempotencyKey: mutationIdempotencyKey(`read:${threadId}`),
      threadId,
      throughSequence,
    });
    if (result.type !== "thread.read.mark") throw new Error("Read marker command mismatch.");
    if (!this.#viewerStillCurrent(generation, userId)) return;
    this.#applyReadStates([result.state]);
  }

  async setWorkspaceNotificationMute(workspaceId: string, muted: boolean): Promise<void> {
    const generation = this.#viewerGeneration;
    const userId = this.#snapshot.user?.id;
    const result = await this.dispatch({
      type: "workspace.notifications.update",
      idempotencyKey: mutationIdempotencyKey(`mute:${workspaceId}`),
      workspaceId,
      muted,
    });
    if (result.type !== "workspace.notifications.update")
      throw new Error("Notification preference command mismatch.");
    if (!this.#viewerStillCurrent(generation, userId)) return;
    this.#applyNotificationPreferences([result]);
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
      .then(() => {
        if (generation === this.#viewerGeneration) this.#hydratedThreads.add(threadId);
      })
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
    const markers = new Map<string, Sequence>();
    this.#readStateLoads.add(markers);
    try {
      this.#invalidatedHydrations.delete(threadId);
      let page = await this.#readThreadHistory(threadId);
      if (!this.#viewerStillCurrent(generation, userId)) return;
      for (
        let attempt = 0;
        attempt < 3 &&
        (this.#invalidatedHydrations.has(threadId) ||
          this.#threadState.needsRead(page.thread, page.readState.asOfSequence));
        attempt += 1
      ) {
        this.#invalidatedHydrations.delete(threadId);
        const fresh = await this.#readThreadHistory(threadId);
        if (compareSequence(fresh.readState.asOfSequence, page.readState.asOfSequence) >= 0)
          page = fresh;
        if (!this.#viewerStillCurrent(generation, userId)) return;
      }
      if (this.#invalidatedHydrations.has(threadId))
        throw new Error("The connection changed while loading this conversation. Try again.");
      this.#allowWorkspace(page.thread.workspaceId, generation);
      let entries = page.events.reduce(foldTranscriptEvent, [] as TranscriptEntry[]);
      const pageMax = page.events.at(-1)?.sequence;
      const replayed = buffer.filter(
        (event) => pageMax === undefined || compareSequence(event.sequence, pageMax) > 0,
      );
      for (const event of replayed) entries = foldTranscriptEvent(entries, event);
      // The page is durable history only; whatever the Thread's Runs are
      // streaming right now is drawn again on top of it, less any stream the
      // page shows completed before the event stream has said so.
      for (const event of [...page.events, ...replayed]) this.#live.complete(event);
      const receivedAt = new Date().toISOString();
      for (const run of this.#live.threadRuns(threadId as ThreadId)) {
        entries = foldLiveRun(entries, run, receivedAt);
      }
      for (const event of [...page.events, ...replayed]) this.#threadState.record(event);
      // History paging must not reconstruct today's selection from an old creation event.
      const summary = this.#threadState.reconcile(
        toThreadSummary(page.thread, this.#snapshot.environments, this.#snapshot.harnesses),
        page.readState.asOfSequence,
        this.#snapshot.threads.find(({ id }) => id === threadId),
      );
      const threads = this.#snapshot.threads.some(({ id }) => id === threadId)
        ? this.#snapshot.threads.map((thread) => (thread.id === threadId ? summary : thread))
        : [summary, ...this.#snapshot.threads];
      const workspaceId = page.thread.workspaceId;
      const threadLookups = { ...this.#snapshot.threadLookups };
      delete threadLookups[threadId];
      if (restoreLatest) this.#historicalThreads.delete(threadId);
      this.#update({
        ...this.#snapshot,
        assignments: withAssignmentsFrom(this.#snapshot.assignments, [...page.events, ...replayed]),
        threadLookups,
        threads,
        transcripts: { ...this.#snapshot.transcripts, [threadId]: entries },
        transcriptWindows: { ...this.#snapshot.transcriptWindows, [threadId]: page.window },
      });
      if (workspaceId) this.#ensureWorkspaceChannel(workspaceId);
      if (this.#observedThreads.has(threadId)) this.#ensureRequests(threadId);
      this.#applyReadStates([page.readState], markers);
    } catch (error) {
      // A worker the Host will not show this viewer takes its tasks with it.
      if (this.#viewerStillCurrent(generation, userId))
        this.#denyOnRefusal(error, this.#assignmentsOfWorker(threadId));
      throw error;
    } finally {
      this.#readStateLoads.delete(markers);
      if (this.#hydrationBuffers.get(threadId) === buffer) {
        this.#hydrationBuffers.delete(threadId);
        this.#invalidatedHydrations.delete(threadId);
      }
    }
  }

  async #readThreadHistory(threadId: string) {
    const page = unwrapRpcResult(await this.rpc["thread.events.list"]({ threadId }));
    if (page.threadId !== threadId || page.thread.id !== threadId)
      throw new Error("Thread event page mismatch.");
    return page;
  }

  async loadEarlierWorkspaces(): Promise<void> {
    if (this.#workspacePageLoad) return this.#workspacePageLoad;
    const operation = this.#loadEarlierWorkspaces().finally(() => {
      if (this.#workspacePageLoad === operation) this.#workspacePageLoad = null;
    });
    this.#workspacePageLoad = operation;
    return operation;
  }

  async listWorkspaceFiles(
    workspaceId: string,
    input: {
      readonly cursor?: string;
      readonly knownRevision?: string;
      readonly parentKey: string;
      readonly retainedCursor?: string;
    },
    signal?: AbortSignal,
  ) {
    return unwrapRpcResult(
      await this.rpc["workspace.files.list"]({ ...input, workspaceId }, signal ? { signal } : {}),
    );
  }

  async previewWorkspaceFile(
    workspaceId: string,
    fileKey: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceFilePreview> {
    const { bytes, metadata } = unwrapRpcResult(
      await this.rpc["workspace.files.preview"]({ fileKey, workspaceId }, signal ? { signal } : {}),
    );
    if (bytes.byteLength > workspaceFilePreviewMaxBytes) {
      throw new Error("File preview exceeded its byte limit.");
    }
    let content: string | null = null;
    if (isTextContentType(metadata.contentType)) {
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        // A declared text file may still contain arbitrary bytes. Navigation
        // remains available; only the unsafe inline preview is withheld.
      }
    }
    return { content, metadata };
  }

  workspaceFileDownloadUrl(workspaceId: string, fileKey: string): string {
    const query = new URLSearchParams({ file: fileKey });
    return this.#url(`/v1/workspaces/${encodeURIComponent(workspaceId)}/files/download?${query}`);
  }

  async startBrowser(
    workspaceId: string,
    identity: BrowserStartIdentity,
    placement?: BrowserPlacementSummary,
    threadId?: string,
    viewport?: Extract<BrowserCommand, { type: "surface.open" }>["viewport"],
  ): Promise<BrowserSessionSummary> {
    // The Workspace may be an authorized delegation destination outside the
    // catalog page. Command admission, not this cache, checks access.
    if (!this.#snapshot.browserAvailable) {
      throw new Error("This Host does not have a connected Browser Runtime.");
    }
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
      workspaceId,
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
  readonly browserTargetControlAvailable = (): Promise<boolean | null> =>
    Promise.resolve(this.#capabilities?.includes("browser-target-control-v1") ?? null);

  readonly retainBrowserViewer = (
    sessionId: string,
    surfaceId?: string,
    options?: { readonly picture?: boolean; readonly captureRegion?: boolean },
  ): (() => void) => {
    if (options?.picture === false && !this.#capabilities?.includes("browser-target-control-v1"))
      throw new Error("This Host does not advertise browser-target-control-v1.");
    if (options?.picture === false && !surfaceId)
      throw new Error("A control-only browser viewer must name a target.");
    return surfaceId
      ? this.#targetedControl.retain(sessionId, surfaceId, options)
      : this.#retainBrowser(sessionId, "control", options);
  };

  readonly retainBrowserWatch = (
    sessionId: string,
    surfaceId?: string,
    options?: { readonly captureRegion?: boolean },
  ): (() => void) =>
    surfaceId
      ? this.#targetedWatch.retain(sessionId, surfaceId, options)
      : this.#retainBrowser(sessionId, "watch", options);

  #retainBrowser(
    sessionId: string,
    mode: "control" | "watch",
    options?: { readonly captureRegion?: boolean },
  ): () => void {
    if (this.#disposed) return () => undefined;
    const session = this.#snapshot.browserSessions.find((item) => item.id === sessionId);
    if (!session || session.state === "closed" || session.state === "failed") {
      return () => undefined;
    }
    const channels = mode === "watch" ? this.#browserWatchChannels : this.#browserChannels;
    const channel: BrowserChannel =
      channels.get(sessionId) ??
      ({
        awaitingAck: null,
        ...(mode === "watch" ? { mode, captureRegionRetainers: 0 } : { mode }),
        reconnectAttempt: 0,
        reconnectTimer: null,
        retainers: 0,
        sessionId,
        socket: null,
        synchronized: false,
      } satisfies BrowserChannel);
    const captureRegion = options?.captureRegion === true;
    const previouslyOptedIn =
      channel.mode === "watch" && channel.captureRegionRetainers === channel.retainers;
    channel.retainers += 1;
    if (channel.mode === "watch") {
      if (captureRegion) channel.captureRegionRetainers += 1;
      if (previouslyOptedIn !== (channel.captureRegionRetainers === channel.retainers))
        this.#subscribeBrowserWatch(channel);
    }
    channels.set(sessionId, channel);
    this.#ensureBrowserChannel(sessionId, mode);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const previouslyOptedIn =
        channel.mode === "watch" && channel.captureRegionRetainers === channel.retainers;
      channel.retainers = Math.max(0, channel.retainers - 1);
      if (channel.mode === "watch") {
        if (captureRegion) channel.captureRegionRetainers -= 1;
        if (previouslyOptedIn !== (channel.captureRegionRetainers === channel.retainers))
          this.#subscribeBrowserWatch(channel);
      }
      // A channel that was dropped and replaced belongs to newer retainers.
      if (channel.retainers > 0 || channels.get(sessionId) !== channel) return;
      this.#closeBrowserChannel(sessionId, mode);
      this.#patchBrowserViewerState(sessionId, mode, {
        viewerError: null,
        viewerState: "disconnected",
      });
    };
  }

  /**
   * The view has finished with this Control or Watch picture. A token that is not the
   * one outstanding — already returned, or from a socket since replaced — is
   * late and changes nothing.
   */
  acceptBrowserWatchFrame(sessionId: string, token: string, surfaceId?: string): void {
    if (surfaceId) {
      this.#targetedWatch.accept(sessionId, surfaceId, token);
      this.#targetedControl.accept(sessionId, surfaceId, token);
      return;
    }
    for (const channel of [
      this.#browserWatchChannels.get(sessionId),
      this.#browserChannels.get(sessionId),
    ])
      if (channel?.awaitingAck === token) this.#returnWatchCredit(channel);
  }

  #returnWatchCredit(channel: BrowserChannel): void {
    const token = channel.awaitingAck;
    channel.awaitingAck = null;
    if (token && channel.socket?.readyState === 1) {
      channel.socket.send(JSON.stringify({ type: "stream.ack", token }));
    }
  }

  sendBrowserCommand(sessionId: string, command: BrowserCommand): void {
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
    const channel = this.#browserChannels.get(sessionId);
    const session = this.#snapshot.browserSessions.find((item) => item.id === sessionId);
    if (
      !channel?.socket ||
      channel.socket.readyState !== 1 ||
      !channel.synchronized ||
      session?.state !== "ready"
    ) {
      // Layout and cleanup can race with the socket disconnecting; neither
      // needs an error when the view will resynchronize on its return.
      if (
        command.type === "stream.unsubscribe" ||
        command.type === "viewport.follow" ||
        command.type === "input.cancel"
      )
        return;
      throw new Error("The browser view is not synchronized.");
    }
    channel.socket.send(JSON.stringify(command));
  }

  #subscribeBrowserWatch(channel: BrowserChannel): void {
    if (channel.mode !== "watch" || !channel.synchronized || !channel.retainers) return;
    channel.socket?.send(
      JSON.stringify({
        type: "stream.subscribe",
        ...(channel.captureRegionRetainers === channel.retainers &&
        this.#capabilities?.includes("browser-capture-region-v1")
          ? { captureRegion: true }
          : {}),
      }),
    );
  }

  async createThread(input: CreateThreadInput): Promise<ThreadSummary> {
    const workspace = this.#snapshot.workspaces.find((item) => item.id === input.workspaceId);
    if (!workspace) throw new Error("Workspace not found.");
    if (workspace.status !== "ready") throw new Error("This Workspace is not ready yet.");
    const result = await this.dispatch({
      accessMode: input.accessMode,
      environmentId: input.environmentId,
      harnessInstanceId: input.harnessInstanceId,
      idempotencyKey: input.idempotencyKey ?? mutationIdempotencyKey("thread"),
      modelSelection: input.modelSelection,
      ...(input.parentThreadId ? { parentThreadId: input.parentThreadId } : {}),
      ...(input.home ? { home: true } : {}),
      ...(input.generateTitle && this.#snapshot.threadRenameAvailable
        ? { generateTitle: true }
        : {}),
      title: input.title?.trim() || "Untitled thread",
      type: "thread.create",
      workspaceId: input.workspaceId,
    });
    if (result.type !== "thread.create") throw new Error("Thread command mismatch.");
    const thread =
      this.#snapshot.threads.find(({ id }) => id === result.thread.id) ??
      toThreadSummary(result.thread, this.#snapshot.environments, this.#snapshot.harnesses);
    if (input.home)
      this.#update({
        ...this.#snapshot,
        homeThreadId: thread.id,
        workspaces: this.#snapshot.workspaces.map((item) =>
          item.id === thread.workspaceId ? { ...item, homeThreadId: thread.id } : item,
        ),
      });
    await this.#rememberQuietly({
      accessMode: input.accessMode,
      selection: {
        environmentId: input.environmentId,
        harnessInstanceId: input.harnessInstanceId,
        modelSelection: input.modelSelection,
      },
    });
    return thread;
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

  createHome(
    input: Omit<CreateThreadInput, "parentThreadId" | "title" | "home">,
  ): Promise<ThreadSummary> {
    return this.createThread({ ...input, home: true, title: CHAT_THREAD_TITLE });
  }

  async renameThread(threadId: string, title: string): Promise<ThreadSummary> {
    if (!this.#snapshot.threadRenameAvailable)
      throw new Error("This Host does not support task renaming.");
    const trimmed = ThreadTitleSchema.parse(title);
    const thread = threadInDirectory(threadId, this.#snapshot);
    if (
      threadId === this.#snapshot.homeThreadId ||
      this.#snapshot.workspaces.some((workspace) => workspace.homeThreadId === threadId)
    )
      throw new Error("Chat cannot be renamed.");
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
    if (
      threadId === this.#snapshot.homeThreadId ||
      this.#snapshot.workspaces.some(({ homeThreadId }) => homeThreadId === threadId)
    )
      throw new Error("Chat's icon cannot be changed.");
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

  async #setWorkspaceColor(
    command: Extract<HostApiCommand, { type: "workspace.color.set" }>,
  ): Promise<HostApiCommandOutput> {
    const generation = this.#viewerGeneration;
    const token = Symbol(command.workspaceId);
    this.#workspaceColorEdits.set(command.workspaceId, { color: command.color, token });
    this.#update(this.#snapshot);
    try {
      return await this.#dispatchCommand(command);
    } finally {
      if (
        generation === this.#viewerGeneration &&
        this.#workspaceColorEdits.get(command.workspaceId)?.token === token
      ) {
        this.#workspaceColorEdits.delete(command.workspaceId);
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
    await this.#rememberQuietly({
      selection: {
        environmentId: thread.environmentId,
        harnessInstanceId: selection.harnessInstanceId,
        modelSelection: selection.modelSelection,
      },
    });
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

  async moveThreadInput(
    threadId: string,
    messageId: string,
    beforeMessageId: string | null,
  ): Promise<void> {
    const patch = { beforeMessageId, messageId, threadId, type: "thread.input.move" } as const;
    this.#update(applyOptimisticCommandPatch(this.#snapshot, patch));
    try {
      // Each drop is its own arrangement, so a lost answer is settled by the
      // reread below rather than replayed over whatever came after it.
      await this.dispatch({ ...patch, idempotencyKey: mutationIdempotencyKey("input-move") });
    } catch (error) {
      this.#reloadInputQueue(threadId);
      throw error;
    }
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
    if (this.#disposed) return;
    this.#workspaceTabActivations.dispose();
    this.#snapshot = { ...this.#snapshot, activatingWorkspaceTabs: [] };
    this.#disposed = true;
    this.#computerViews.clear();
    this.#browserUsageRead.clear();
    this.#browserUsageReads.clear();
    this.#browserUsageRunSources.clear();
    this.#browserUses.clear();
    this.#browserPresence.clear();
    this.#tabCatalogs.clear();
    this.#placeActivity.clear();
    this.#latestPlace.clear();
    this.#targetedWatch.clear();
    this.#targetedControl.clear();
    this.#threadState.clear();
    this.#threadRenames.clear();
    this.#threadIcons.clear();
    this.#workspaceColors.clear();
    this.#workspaceColorEdits.clear();
    this.#runQueue.clear();
    this.#live.clear();
    this.#heldLive.clear();
    for (const release of this.#lifecycleDisposers) release();
    this.#lifecycleDisposers.length = 0;
    if (this.#refreshTimer) globalThis.clearInterval(this.#refreshTimer);
    this.#refreshTimer = null;
    this.#stopLiveness();
    if (this.#workspacePrefetchTimer) globalThis.clearTimeout(this.#workspacePrefetchTimer);
    this.#workspacePrefetchTimer = null;
    for (const channel of this.#channels.values()) this.#closeChannel(channel, false);
    this.#channels.clear();
    this.#assignmentReads.clear();
    this.#deniedAssignments.clear();
    this.#observedThreads.clear();
    for (const sessionId of this.#browserChannels.keys()) this.#closeBrowserChannel(sessionId);
    for (const sessionId of this.#browserWatchChannels.keys())
      this.#closeBrowserChannel(sessionId, "watch");
    this.#clearBrowserFrames();
    this.#forgetLiveRereads();
    this.#listeners.clear();
    this.#lifecycleListeners.clear();
    this.#placeActivity.dispose();
    this.#latestPlace.dispose();
    this.#targetedWatch.dispose();
    this.#targetedControl.dispose();
    this.#browserEditing.dispose();
    this.#browserFrameListeners.clear();
    this.#browserWatchFrameListeners.clear();
  }

  async #bootstrap(force = false, revalidateCapabilities = false): Promise<void> {
    if (this.#bootstrapPromise && !force) {
      // A bootstrap already under way may be reusing evidence this caller
      // asked to replace, so the reverification runs beside it.
      if (!revalidateCapabilities) return this.#bootstrapPromise;
      await Promise.all([this.#bootstrapPromise, this.#refreshCapabilities({ revalidate: true })]);
      return;
    }
    const operation = this.#performBootstrap(revalidateCapabilities);
    this.#bootstrapPromise = operation;
    try {
      await operation;
    } finally {
      if (this.#bootstrapPromise === operation) {
        this.#bootstrapPromise = null;
        if (this.#rereadPending) {
          this.#rereadPending = false;
          this.#reread();
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
  #reread(): void {
    if (this.#disposed || this.#visibility === "background") return;
    if (this.#bootstrapPromise) {
      this.#rereadPending = true;
      return;
    }
    void this.#bootstrap().catch(() => undefined);
  }

  /**
   * Rereads what waits on this person. `host.requests-changed` names nothing,
   * so the answer is always the whole list, and it is asked of the Host rather
   * than pieced together from the Workspaces this client happens to follow.
   * A notice during a read earns exactly one more, so the last read is never
   * one that started before the change it was told about.
   */
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

  async #readWaitingRequests(): Promise<void> {
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

  /**
   * Rebuilds the complete active set and the loaded history prefix of every
   * task list this client holds: the reader's and each Workspace's a screen asked for.
   * `host.tasks-changed` names nothing, and a bootstrap or a stream starting
   * over may follow a notice this client missed. Hidden, it waits: coming to
   * the foreground rereads anyway.
   */
  #rereadTasks(): void {
    if (
      this.#disposed ||
      this.#visibility === "background" ||
      this.#snapshot.session !== "authenticated"
    )
      return;
    for (const scope of [null, ...this.#workspaceTaskScopes])
      void this.#readFirstTaskPage(scope, "changed").catch(() => undefined);
  }

  loadWorkspaceTasks(workspaceId: string): Promise<void> {
    if (this.#disposed || this.#snapshot.session !== "authenticated") return Promise.resolve();
    this.#workspaceTaskScopes.add(workspaceId);
    return this.#readFirstTaskPage(workspaceId, "asked");
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

  loadEarlierTasks(workspaceId?: string): Promise<void> {
    const scope = workspaceId ?? null;
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
    return scope === null ? this.#snapshot.tasks : (this.#snapshot.workspaceTasks[scope] ?? null);
  }

  /** Replaces a loaded prefix atomically, or appends one page after its cursor. */
  async #readTaskPage(
    scope: string | null,
    cursor: string | null,
    minimumItems = 0,
  ): Promise<void> {
    const generation = this.#viewerGeneration;
    const userId = this.#snapshot.user?.id;
    const markers = new Map<string, Sequence>();
    this.#readStateLoads.add(markers);
    try {
      const readStates: ThreadReadState[] = [];
      const readPages = async (active: boolean): Promise<TaskListState | null> => {
        let merged = active || cursor === null ? null : this.#heldTasks(scope);
        let before = active ? null : cursor;
        do {
          const page = unwrapRpcResult(
            await this.rpc["tasks.list"]({
              ...(active ? { active: true } : {}),
              ...(before ? { before } : {}),
              limit: threadPageMaxItems,
              ...(scope === null ? {} : { workspaceId: scope }),
            }),
          );
          if (!this.#viewerStillCurrent(generation, userId)) return null;
          if (scope !== null && !this.#workspaceTaskScopes.has(scope)) return null;
          for (const { thread } of page.tasks) this.#allowWorkspace(thread.workspaceId, generation);
          merged = mergeTasks(merged, {
            entries: page.tasks.map((entry) => {
              const thread = toThreadSummary(
                entry.thread,
                this.#snapshot.environments,
                this.#snapshot.harnesses,
              );
              const readState = page.readStates.find(({ threadId }) => threadId === thread.id);
              const name = readState
                ? this.#threadState.name(
                    this.#threadState.reconcile(thread, readState.asOfSequence),
                  )
                : thread;
              return {
                failure: entry.failure,
                lastReply: entry.lastReply,
                thread: { ...thread, ...name },
              };
            }),
            window: page.window,
          });
          readStates.push(...page.readStates);
          if (!page.window.hasMore || (!active && merged.entries.length >= minimumItems)) break;
          const next = page.window.nextBefore;
          if (!next || next === before)
            throw new Error("Task page is missing its continuation cursor.");
          before = next;
        } while (before !== null);
        return merged;
      };
      const [merged, active] = await Promise.all([
        readPages(false),
        scope === null && cursor === null ? readPages(true) : Promise.resolve(null),
      ]);
      if (!merged || !this.#viewerStillCurrent(generation, userId)) return;
      if (scope !== null && !this.#workspaceTaskScopes.has(scope)) return;
      this.#update(
        scope === null
          ? { ...this.#snapshot, tasks: merged, ...(active ? { activeTasks: active.entries } : {}) }
          : {
              ...this.#snapshot,
              workspaceTasks: { ...this.#snapshot.workspaceTasks, [scope]: merged },
            },
      );
      this.#applyReadStates(readStates, markers);
    } catch (error) {
      if (
        scope !== null &&
        this.#viewerStillCurrent(generation, userId) &&
        error instanceof HostClientRequestError &&
        (error.code === "forbidden" || error.code === "not_found")
      ) {
        this.#refuseWorkspace(scope);
      }
      throw error;
    } finally {
      this.#readStateLoads.delete(markers);
    }
  }

  async setTaskDone(threadId: string, done: boolean): Promise<Thread> {
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
      type: "thread.shared-done.set",
    });
    if (result.type !== "thread.shared-done.set") throw new Error("Done command mismatch.");
    return result.thread;
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
      sharedTaskDoneAvailable: capabilities.includes("shared-task-done-v1"),
      workspaceTabReopenAvailable: capabilities.includes("workspace-tab-reopen-v1"),
      searchSuggestionsAvailable: capabilities.includes("browser-search-suggestions-v1"),
      iphoneAppsAvailable: capabilities.includes("iphone-apps-v1"),
      ownerViewWindowsAvailable: capabilities.includes("ownerViewWindows"),
    });
    if (changed) {
      this.#targetedControl.capabilitiesChanged();
      this.#targetedWatch.capabilitiesChanged();
      for (const channel of this.#browserWatchChannels.values())
        this.#subscribeBrowserWatch(channel);
    }
  }

  async #performBootstrap(revalidateCapabilities: boolean): Promise<void> {
    const generation = this.#viewerGeneration;
    const presenceMark = this.#presenceCounter;
    const ownerViewRevision = this.#ownerViews.revision;
    if (this.#snapshot.session === "checking" || this.#snapshot.connection === "offline") {
      this.#update({ ...this.#snapshot, connection: "connecting" });
    }
    if (this.#readCapabilities)
      await this.#refreshCapabilities(revalidateCapabilities ? { revalidate: true } : undefined);
    if (generation !== this.#viewerGeneration || this.#disposed) return;
    const response = await this.rpc["bootstrap.get"]({});
    if (!response.ok && response.error.code === "unauthorized") {
      if (this.#disposed || this.#snapshot.session !== "authentication-required") return;
      const authGeneration = this.#viewerGeneration;
      this.#stopRefresh();
      for (const channel of this.#channels.values()) this.#closeChannel(channel, false);
      this.#channels.clear();
      for (const sessionId of this.#browserChannels.keys()) this.#closeBrowserChannel(sessionId);
      for (const sessionId of this.#browserWatchChannels.keys())
        this.#closeBrowserChannel(sessionId, "watch");
      this.#clearBrowserFrames();
      const identityConfig = unwrapRpcResult(await this.rpc["auth.config"]({}));
      if (
        this.#disposed ||
        authGeneration !== this.#viewerGeneration ||
        this.#snapshot.session !== "authentication-required"
      )
        return;
      this.#update({
        ...emptySnapshot(),
        connection: "connected",
        identityConfig,
        revision: this.#snapshot.revision,
        session: "authentication-required",
      });
      return;
    }
    if (generation !== this.#viewerGeneration || this.#disposed) return;
    if (!response.ok && ![...this.#channels.values()].some((channel) => channel.synchronized))
      this.#update({ ...this.#snapshot, connection: "offline" });
    const payload = unwrapRpcResult(response);
    if (generation !== this.#viewerGeneration || this.#disposed) return;
    // Reauthentication can replace the viewer without an intervening 401.
    // Read markers and mute revisions belong to that viewer, not the Host.
    if (
      (this.#snapshot.user && this.#snapshot.user.id !== payload.user.id) ||
      (this.#snapshot.deploymentId && this.#snapshot.deploymentId !== payload.deploymentId)
    )
      this.#expireSession();
    for (const workspace of payload.workspaces) this.#allowWorkspace(workspace.id, generation);
    if (payload.homeWorkspace) this.#allowWorkspace(payload.homeWorkspace.id, generation);
    const environments = payload.environments.map((environment) => ({
      ...environment,
      harnessAuthenticationAllowed: environment.harnessAuthenticationAllowed,
      harnessCatalogs: environment.harnessCatalogs.map((catalog) => ({ ...catalog })),
      harnessDrivers: environment.harnessDrivers.map((driver) => ({ ...driver })),
      status: environment.status,
    }));
    const harnesses = payload.harnesses.map(
      ({
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
      }) => ({
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
      }),
    );
    const catalogWorkspaces = payload.workspaces.map((workspace) =>
      this.#reconcileWorkspaceColor(toWorkspaceSummary(workspace, environments, harnesses)),
    );
    const homeWorkspace = payload.homeWorkspace
      ? this.#reconcileWorkspaceColor(
          toWorkspaceSummary(payload.homeWorkspace, environments, harnesses),
        )
      : (catalogWorkspaces.find((workspace) => workspace.kind === "main") ?? null);
    const bootstrappedWorkspaces = homeWorkspace
      ? [homeWorkspace, ...catalogWorkspaces.filter(({ id }) => id !== homeWorkspace.id)]
      : catalogWorkspaces;
    const recentWorkspaceIds = new Set(bootstrappedWorkspaces.map(({ id }) => id));
    const retainedWorkspaces = this.#snapshot.workspaces.filter(
      ({ id }) => !recentWorkspaceIds.has(id),
    );
    const workspaces = [...bootstrappedWorkspaces, ...retainedWorkspaces];
    const workspaceIds = new Set(workspaces.map(({ id }) => id));
    for (const [workspaceId, channel] of this.#channels) {
      if (workspaceIds.has(workspaceId)) continue;
      this.#closeChannel(channel, false);
      this.#channels.delete(workspaceId);
    }
    const threads = this.#snapshot.threads
      .filter((thread) => workspaceIds.has(thread.workspaceId))
      .map((thread) => ({
        ...thread,
        harnessLabel:
          harnesses.find((harness) => harness.id === thread.harnessInstanceId)?.name ??
          "Unavailable harness",
        modelLabel: modelLabel(thread.modelSelection, environments),
        modelSelection: thread.modelSelection,
        runnerLabel:
          environments.find((environment) => environment.id === thread.environmentId)?.name ??
          "Unavailable work location",
      }));
    const retainedThreadIds = new Set(threads.map((thread) => thread.id));
    const transcripts = Object.fromEntries(
      Object.entries(this.#snapshot.transcripts).filter(([threadId]) =>
        retainedThreadIds.has(threadId),
      ),
    );
    const transcriptWindows = Object.fromEntries(
      Object.entries(this.#snapshot.transcriptWindows).filter(([threadId]) =>
        retainedThreadIds.has(threadId),
      ),
    );
    const inputQueues = Object.fromEntries(
      Object.entries(this.#snapshot.inputQueues).filter(([threadId]) =>
        retainedThreadIds.has(threadId),
      ),
    );
    // Browser authorization is the Host's answer. A session's Workspace may
    // be outside the current catalog page but explicitly opened from a delegation.
    const patchedSince = (sessionId: string) =>
      (this.#presenceMarks.get(sessionId) ?? 0) > presenceMark;
    const usesBySession = this.#browserUsesBySession();
    const browserSessions = payload.browser.sessions.map((session) => {
      const terminal = session.state === "closed" || session.state === "failed";
      if (terminal) this.#tabCatalogs.delete(session.id);
      const catalog = terminal
        ? {
            generation: session.tabCatalog?.generation ?? 0,
            revision: session.tabCatalog?.revision ?? 0,
            tabs: [],
          }
        : this.#acceptCatalog(session.id, session.tabCatalog);
      return toBrowserSessionSummary(
        { ...session, ...(catalog ? { tabCatalog: catalog } : {}) },
        this.#snapshot.browserSessions.find((existing) => existing.id === session.id),
        patchedSince(session.id) ? (this.#browserPresence.get(session.id) ?? null) : null,
        usesBySession.get(session.id) ?? [],
      );
    });
    const retainedBrowserSessionIds = new Set(browserSessions.map((session) => session.id));
    for (const sessionId of this.#browserChannels.keys()) {
      const retained = browserSessions.find((session) => session.id === sessionId);
      if (!retained || retained.state === "closed" || retained.state === "failed") {
        this.#closeBrowserChannel(sessionId);
      }
    }
    for (const sessionId of this.#browserWatchChannels.keys()) {
      const retained = browserSessions.find((session) => session.id === sessionId);
      if (!retained || retained.state === "closed" || retained.state === "failed") {
        this.#closeBrowserChannel(sessionId, "watch");
      }
    }
    for (const sessionId of this.#browserFrameValues.keys()) {
      if (!retainedBrowserSessionIds.has(sessionId)) this.#setBrowserFrame(sessionId, null);
    }
    for (const sessionId of this.#browserWatchFrameValues.keys()) {
      if (!retainedBrowserSessionIds.has(sessionId))
        this.#setBrowserFrame(sessionId, null, "watch");
    }
    const retainedCatalogIds = [...this.#retainedWorkspaceTabLineages.keys()].filter(
      (id) => !payload.browser.workspaceTabs?.some((group) => group.id === id),
    );
    this.#update({
      ...this.#snapshot,
      browserProfileGrants: payload.browser.profileGrants.map((grant) => ({ ...grant })),
      browserTabGroups: this.#tabGroups.receive(
        payload.browser.tabGroupsVersion === 1 ? payload.browser.tabGroups : undefined,
      ),
      workspaceTabRestoreVersion: payload.browser.workspaceTabRestoreVersion,
      workspaceTabs:
        payload.browser.workspaceTabRestoreVersion === 1
          ? [
              ...(payload.browser.workspaceTabs?.map((group) => {
                const held = this.#snapshot.workspaceTabs?.find(
                  (previous) => previous.id === group.id,
                );
                return held && held.revision > group.revision ? held : group;
              }) ?? []),
              ...[...this.#retainedWorkspaceTabLineages.values()].filter(
                (group) => !payload.browser.workspaceTabs?.some((listed) => listed.id === group.id),
              ),
            ]
          : undefined,
      browserAvailable: payload.browser.available,
      browserPlacements: payload.browser.placements.map((placement) => ({ ...placement })),
      browserProfiles: payload.browser.profiles.map((profile) => ({ ...profile })),
      browserSessions,
      latestPlaces: payload.latestPlaces ?? [],
      connection: workspaces.length ? this.#snapshot.connection : "connected",
      deploymentShape: payload.deploymentShape,
      deploymentId: payload.deploymentId,
      environments,
      // Absence is the older Host saying nothing is remembered, not a gap to
      // fill in: the protocol made the field optional, never defaulted.
      executionPreferences: payload.executionPreferences ?? emptyExecutionPreferences,
      harnesses,
      homeWorkspaceId: homeWorkspace?.id ?? null,
      homeThreadId: homeWorkspace?.homeThreadId ?? null,
      identityConfig: payload.identityConfig,
      inputQueues,
      machines: payload.machines.map((machine) =>
        this.#ownerViews.reread(
          withNewerComputerPresence(machine, this.#snapshot.machines, patchedSince),
          this.#snapshot.machines.find((current) => current.id === machine.id),
          ownerViewRevision,
        ),
      ),
      ownerName: payload.user.displayName,
      session: "authenticated",
      sessionSurface: payload.sessionSurface ?? null,
      threads,
      transcriptWindows,
      transcripts,
      user: payload.user,
      workspaceSharingAvailable: payload.workspaceSharingAvailable,
      // Home and retained pages supplement this list; only the catalog cursor
      // can establish whether that catalog has been fully read.
      workspaceWindow: payload.workspaceWindow,
      workspaces,
    });
    // Warm Home through the hydration owner without claiming a conversation
    // or marking it read. A later activation joins this same read.
    if (this.#prefetchHome && this.#snapshot.homeThreadId)
      this.#ensureThreadHydration(this.#snapshot.homeThreadId);
    // A patch older than this read is already in what it answered.
    for (const [sessionId, mark] of this.#presenceMarks) {
      if (mark > presenceMark) continue;
      this.#presenceMarks.delete(sessionId);
      this.#browserPresence.delete(sessionId);
    }
    const initialWorkspace = homeWorkspace ?? workspaces[0];
    if (initialWorkspace) this.#ensureWorkspaceChannel(initialWorkspace.id);
    // Retry retained workspaces too: the open thread need not be in Main.
    for (const workspaceId of this.#channels.keys()) this.#ensureWorkspaceChannel(workspaceId);
    this.#recomputeConnection();
    this.#startRefresh();
    this.#applyNotificationPreferences(payload.notificationPreferences);
    // A notice missed while disconnected or hidden is answered here too.
    this.#rereadWaitingRequests();
    this.#rereadTasks();
    this.#reportTimeZone();
    // Only a conversation never read is read here; a poll changes nothing.
    if (this.#activeThreadId) this.#ensureBrowserUsage(this.#activeThreadId, "missing");
    for (const threadId of this.#observedThreads.keys())
      this.#ensureBrowserUsage(threadId, "missing");

    // Catalog omission is explicit: recover every gap, after primary startup,
    // even if one sibling read fails. Realtime may deliver newer revisions first.
    const recoveryGeneration = this.#viewerGeneration;
    const current = () =>
      this.#viewerStillCurrent(recoveryGeneration, payload.user.id) &&
      this.#snapshot.deploymentId === payload.deploymentId;
    const catalogReads: (() => Promise<void>)[] = retainedCatalogIds.map((id) => async () => {
      await this.readWorkspaceTabs(id);
    });
    for (const group of payload.browser.workspaceTabs ?? []) {
      if (group.tabs) continue;
      catalogReads.push(async () => {
        const recovered = unwrapRpcResult(
          await this.rpc["workspace.tabs.get"]({ groupId: group.id }),
        );
        if (!current()) return;
        this.#update({
          ...this.#snapshot,
          workspaceTabs: this.#snapshot.workspaceTabs?.map((held) =>
            held.id === recovered.id && recovered.revision >= held.revision ? recovered : held,
          ),
        });
      });
    }
    for (const session of payload.browser.sessions) {
      if (session.tabCatalog) continue;
      catalogReads.push(async () => {
        const result = unwrapRpcResult(
          await this.rpc["browser.tabs.get"]({ sessionId: session.id }),
        );
        if (!current()) return;
        const catalog = this.#acceptCatalog(session.id, result);
        if (catalog) this.#patchBrowserSession(session.id, { tabCatalog: catalog });
      });
    }
    const failures: unknown[] = [];
    for (let offset = 0; offset < catalogReads.length; offset += 3) {
      if (!current()) return;
      const results = await Promise.allSettled(
        catalogReads.slice(offset, offset + 3).map((read) => read()),
      );
      for (const result of results) if (result.status === "rejected") failures.push(result.reason);
    }
    if (failures.length) throw failures[0];
  }

  #startRefresh(): void {
    if (this.#refreshTimer || this.#refreshIntervalMs === 0) return;
    if (this.#visibility === "background") return;
    this.#refreshTimer = globalThis.setInterval(() => {
      void this.#bootstrap().catch(() => undefined);
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
      lifecycle.onNetworkChange((state) => this.#networkChanged(state)),
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
    if (!this.#notifiesWhileHidden()) {
      for (const channel of this.#channels.values()) {
        this.#clearProbe(channel);
        if (channel.reconnectTimer) globalThis.clearTimeout(channel.reconnectTimer);
        channel.reconnectTimer = null;
      }
    }
    for (const channel of this.#browserChannels.values()) {
      if (channel.reconnectTimer) globalThis.clearTimeout(channel.reconnectTimer);
      channel.reconnectTimer = null;
    }
    for (const channel of this.#browserWatchChannels.values()) {
      if (channel.reconnectTimer) globalThis.clearTimeout(channel.reconnectTimer);
      channel.reconnectTimer = null;
    }
  }

  /**
   * Coming back, a socket the client still believes in may already be dead —
   * mobile platforms close backgrounded sockets without delivering a close
   * event. Under the trust window a correlated ping settles it; past it, or
   * with no probe to run, the socket is replaced outright. Either way a
   * Workspace channel resumes from its retained cursor, so the Host sends the
   * delta rather than a fresh snapshot.
   */
  #enterForeground(): void {
    if (this.#disposed || this.#visibility === "foreground") return;
    const backgroundedForMs = Date.now() - (this.#backgroundedAt ?? Date.now());
    this.#visibility = "foreground";
    this.#targetedControl.suspend(this.#network === "offline");
    this.#targetedWatch.suspend(this.#network === "offline");
    for (const listener of this.#lifecycleListeners) listener("foreground");
    this.#backgroundedAt = null;
    const trusted = backgroundedForMs < this.#socketTrustWindowMs && this.#network !== "offline";
    for (const channel of this.#channels.values()) {
      if (trusted && channel.socket?.readyState === 1) {
        this.#probeChannel(channel);
        continue;
      }
      this.#replaceChannel(channel);
    }
    for (const channel of [
      ...this.#browserChannels.values(),
      ...this.#browserWatchChannels.values(),
    ]) {
      // A resumed Watch must get a new snapshot and frame credit. A socket the
      // platform kept open while hidden can otherwise leave an old picture
      // looking current without any new screencast frame to replace it.
      if (channel.mode === "watch") {
        this.#replaceBrowserChannel(channel);
        continue;
      }
      // The browser viewer protocol carries no client-initiated liveness probe,
      // so a retained socket is trusted for the same window and replaced after
      // it. Its snapshot is the whole of its state, so replacing costs one.
      if (trusted && channel.socket?.readyState === 1) continue;
      this.#replaceBrowserChannel(channel);
    }
    this.#recomputeConnection();
    this.#startRefresh();
    if (this.#snapshot.session === "authenticated") void this.refresh().catch(() => undefined);
  }

  /**
   * A handover to another network invalidates every open socket at once, and
   * the interface it left will never report their death. Wi-Fi to cellular is
   * reported as `online` both before and after, so it is the notification that
   * invalidates, never a change in its value — the one exception being a
   * device that is still off the network, where there is nothing to replace.
   * Going offline stops the backoff instead of spending it against an
   * interface that cannot carry the packets.
   */
  #networkChanged(state: ClientNetworkState): void {
    if (this.#disposed) return;
    if (state === "offline" && this.#network === "offline") return;
    this.#network = state;
    this.#targetedControl.suspend(this.#reconnectSuspended(), this.#network !== "offline");
    this.#targetedWatch.suspend(this.#reconnectSuspended());
    this.#targetedControl.reconnect();
    this.#targetedWatch.reconnect();
    for (const channel of this.#channels.values()) this.#replaceChannel(channel);
    for (const channel of this.#browserChannels.values()) this.#replaceBrowserChannel(channel);
    for (const channel of this.#browserWatchChannels.values()) this.#replaceBrowserChannel(channel);
    this.#recomputeConnection();
    for (const listener of this.#lifecycleListeners) listener("network");
  }

  /** Reconnecting is pointless while the app is hidden or the device is off
   * the network; the next foreground or online signal resumes every channel. */
  #reconnectSuspended(): boolean {
    return this.#visibility === "background" || this.#network === "offline";
  }

  /**
   * A client that shows the person's notifications keeps its Workspace sockets
   * while hidden, because hidden is when a notification is worth showing. A
   * client that leaves notifications to push, as a phone does, does not.
   */
  #workspaceReconnectSuspended(): boolean {
    return (
      this.#network === "offline" || (this.#reconnectSuspended() && !this.#notifiesWhileHidden())
    );
  }

  #notifiesWhileHidden(): boolean {
    return this.#notificationListeners.size > 0;
  }

  #probeChannel(channel: WorkspaceChannel, deadlineMs = socketProbeDeadlineMs): void {
    const socket = channel.socket;
    if (!socket || socket.readyState !== 1 || channel.probeTimer) return;
    const nonce = globalThis.crypto.randomUUID();
    const progressAt = channel.progressAt;
    channel.probeNonce = nonce;
    channel.probeTimer = globalThis.setTimeout(() => {
      channel.probeTimer = null;
      channel.probeNonce = null;
      // A client that stopped reading meanwhile judges the socket on its way back,
      // and one whose subscription delivered since asking has its answer already:
      // on a slow route the reply can queue behind the very frames that prove it.
      if (
        channel.socket !== socket ||
        channel.progressAt !== progressAt ||
        this.#workspaceReconnectSuspended()
      )
        return;
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

  #clearProbe(channel: WorkspaceChannel): void {
    if (channel.probeTimer) globalThis.clearTimeout(channel.probeTimer);
    channel.probeTimer = null;
    channel.probeNonce = null;
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
      this.#workspaceReconnectSuspended()
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
  #replaceChannel(channel: WorkspaceChannel, reason = "Client closed"): void {
    this.#closeChannel(channel, false, 1000, reason);
    if (this.#workspaceReconnectSuspended()) return;
    if (this.#snapshot.session !== "authenticated") return;
    channel.reconnectAttempt = 0;
    this.#connect(channel);
  }

  #replaceBrowserChannel(channel: BrowserChannel): void {
    if (channel.reconnectTimer) globalThis.clearTimeout(channel.reconnectTimer);
    channel.reconnectTimer = null;
    const socket = channel.socket;
    channel.socket = null;
    channel.synchronized = false;
    socket?.close(1000, "Client closed");
    this.#setBrowserFrame(channel.sessionId, null, channel.mode);
    if (channel.retainers === 0 || this.#reconnectSuspended()) return;
    if (this.#snapshot.session !== "authenticated") return;
    channel.reconnectAttempt = 0;
    this.#connectBrowser(channel);
  }

  #ensureWorkspaceChannel(workspaceId: string): void {
    if (this.#disposed || this.#snapshot.session !== "authenticated") return;
    const existing = this.#channels.get(workspaceId);
    if (existing?.socket || existing?.reconnectTimer) return;
    const channel =
      existing ??
      ({
        cursor: zeroSequence,
        refused: false,
        probeNonce: null,
        probeTimer: null,
        progressAt: 0,
        reconnectAttempt: 0,
        reconnectTimer: null,
        socket: null,
        synchronized: false,
        workspaceId,
      } satisfies WorkspaceChannel);
    this.#channels.set(workspaceId, channel);
    this.#connect(channel);
  }

  #connect(channel: WorkspaceChannel): void {
    if (this.#disposed || channel.socket || channel.refused) return;
    // A bootstrap or refresh started before the app was hidden still resolves
    // after it, and asking for a Workspace is not a reason to open a socket
    // nobody can read. The channel and its cursor stay, so the next foreground
    // or network signal opens the socket and resumes the stream.
    if (this.#workspaceReconnectSuspended()) return;
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
    // A new socket is a new subscription: a stream reread asked for under the
    // old one answers about streams this one starts over.
    this.#heldLive.delete(channel.workspaceId);
    this.#liveGenerations.set(
      channel.workspaceId,
      (this.#liveGenerations.get(channel.workspaceId) ?? 0) + 1,
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
            afterSequence: channel.cursor,
            // The realtime half of the same negotiation the rpc header carries:
            // an upgraded Host refuses the stream before sending an event this
            // app would read with the wrong meaning.
            apiVersion: hostApiVersion,
            ...(this.#capabilities?.includes("snapshot-messages-omit-v1")
              ? { snapshotMessages: "omit" }
              : {}),
            threadId: null,
            type: "client.subscribe",
            workspaceId: channel.workspaceId,
          }),
        );
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
        if (channel.socket !== socket) return;
        realtimeFrameDiagnostic(event.data, error, "rejected");
        channel.refused = true;
        channel.protocolFailed = true;
        this.#closeChannel(channel, false, 4002, "Invalid Host protocol frame");
        this.#recomputeConnection();
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
      this.#scheduleReconnect(channel);
      this.#recomputeConnection();
    });
  }

  #readRealtimeFrame(channel: WorkspaceChannel, frame: unknown): RealtimeMessage | null {
    if (typeof frame !== "string" || frame.length > maxInboundFrameCharacters) {
      throw new Error("Host protocol frame must be bounded JSON text.");
    }
    const value: unknown = JSON.parse(frame);
    const { type } = realtimeHeaderSchema.parse(value);
    if (!realtimeEnvelopeTypes.has(type)) {
      const parsed = HostToClientMessageSchema.safeParse(value);
      if (!parsed.success) realtimeFrameDiagnostic(frame, parsed.error, "ignored");
      return null;
    }
    if (type === "host.events") {
      const batch = realtimeEventsSchema.parse(value);
      const positions = batch.events.map((raw) => realtimeEventPositionSchema.parse(raw));
      if (positions.some((position) => position.workspaceId !== channel.workspaceId))
        throw new Error("Workspace event mismatch.");
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
            skip = realtimeThreadEventSchema.parse(raw).data.thread === null;
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
        realtimeFrameDiagnostic(frame, new z.ZodError(ignoredIssues), "ignored");
      return { type: "host.events", events };
    }
    if (type === "host.snapshot") {
      const { snapshot } = z.object({ snapshot: realtimeSnapshotSchema }).parse(value);
      if (snapshot.workspace.id !== channel.workspaceId)
        throw new Error("Workspace snapshot mismatch.");
      return { type: "host.snapshot", snapshot };
    }
    if (type === "host.resync-required") {
      const message = realtimeResyncSchema.parse(value);
      if (message.workspaceId !== channel.workspaceId) throw new Error("Workspace mismatch.");
      return message;
    }
    if (type === "host.live") {
      const live = realtimeLiveEnvelopeSchema.parse(value);
      if (
        live.workspaceId !== channel.workspaceId ||
        live.progress.workspaceId !== channel.workspaceId
      )
        throw new Error("Workspace live progress mismatch.");
      const items = live.progress.items.flatMap((raw, index) => {
        const kind = z.object({ stream: z.string().min(1), op: z.string().min(1) }).parse(raw);
        if (
          !["assistant", "reasoning", "tool"].includes(kind.stream) ||
          !["append", "replace"].includes(kind.op)
        ) {
          const parsed = realtimeLiveKindSchema.safeParse(raw);
          if (!parsed.success)
            realtimeFrameDiagnostic(
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
      (message.type === "host.read-states" ||
        message.type === "host.read-markers" ||
        message.type === "host.triggers-changed" ||
        message.type === "host.browser-usage-changed" ||
        message.type === "host.synchronized") &&
      message.workspaceId !== channel.workspaceId
    )
      throw new Error("Workspace mismatch.");
    return message;
  }

  #applyRealtimeMessage(
    channel: WorkspaceChannel,
    viewer: SocketViewer,
    message: RealtimeMessage,
  ): void {
    // Notices addressed to the person arrive on every socket they hold, so
    // only what this channel's own subscription sends shows it is delivering.
    if (showsSubscriptionProgress(message, channel)) channel.progressAt = Date.now();
    if (message.type === "host.pong") {
      // Only a probe is correlated; an uncorrelated pong answers nobody.
      if (message.nonce === channel.probeNonce) this.#clearProbe(channel);
      return;
    }
    if (message.type === "host.notification") {
      // Addressed to a person, not to this socket's Workspace: it arrives on
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
    if (message.type === "host.read-states") {
      if (this.#forbiddenWorkspaces.has(message.workspaceId)) return;
      this.#applyReadStates(message.states);
      return;
    }
    if (message.type === "host.read-markers") {
      this.#applyReadMarkers(message.markers);
      return;
    }
    if (message.type === "host.notification-preferences") {
      this.#applyNotificationPreferences(message.preferences);
      return;
    }
    if (message.type === "host.error") {
      if (message.error.reason === "unsupported-version") this.#reverifyCapabilities();
      // The Host refused this channel. A retryable refusal is a transport
      // fault and takes the backoff; a final one leaves the channel down, and
      // the connection state is where a reader learns that.
      channel.refused = !message.error.retryable;
      channel.protocolFailed =
        !message.error.retryable && message.error.reason !== "workspace-forbidden";
      this.#closeChannel(channel, message.error.retryable);
      if (message.error.reason === "workspace-forbidden")
        this.#refuseWorkspace(channel.workspaceId);
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
      channel.cursor = message.snapshot.sequence;
      this.#applyWorkspaceSnapshot(message.snapshot);
      return;
    }
    if (message.type === "host.events") {
      this.#applyEvents(channel, message.events);
      this.#sendAck(channel);
      this.#recomputeConnection();
      return;
    }
    if (message.type === "host.live") {
      if (this.#forbiddenWorkspaces.has(message.workspaceId)) return;
      // Progress never moves the cursor and never acknowledges: it is not
      // durable, and nothing replays it.
      this.#applyLive(message);
      return;
    }
    if (message.type === "host.triggers-changed") {
      this.#update({
        ...this.#snapshot,
        triggerRevision: this.#snapshot.triggerRevision + 1,
      });
      return;
    }
    if (message.type === "host.browser-sessions-changed") {
      // The catalog is viewer-wide, whichever Workspace this socket follows.
      // A session opened, ended or changed hands. Browser Sessions arrive on
      // the bootstrap, not the event stream, so the reread is the whole answer
      // — the same one the refresh poll gives, taken now instead of at the end
      // of the interval.
      this.#reread();
      return;
    }
    if (message.type === "host.thread-place-changed") {
      this.#latestPlace.accept(message.reference);
      return;
    }
    if (message.type === "host.browser-tabs-changed") {
      const next = this.#acceptCatalog(message.sessionId, message.catalog);
      if (next) this.#patchBrowserSession(message.sessionId, { tabCatalog: next });
      return;
    }
    if (message.type === "host.place-activity" || message.type === "host.place-activity-cleared") {
      this.#placeActivity.apply(message);
      return;
    }
    if (message.type === "host.browser-presence") {
      // Addressed to this person on every socket they hold, whichever
      // Workspace it follows: the browser catalog is theirs, not a Workspace's.
      this.#applyBrowserPresence(message.sessions);
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
      this.#reread();
      return;
    }
    channel.cursor = maxSequence(channel.cursor, message.sequence);
    // A resubscription sends every open stream whole right after this, so what
    // the old connection streamed is forgotten rather than continued, and any
    // reread still in flight belongs to the old subscription.
    this.#live.resetWorkspace(message.workspaceId);
    this.#heldLive.delete(message.workspaceId);
    this.#liveGenerations.set(
      message.workspaceId,
      (this.#liveGenerations.get(message.workspaceId) ?? 0) + 1,
    );
    // A stream the old connection drew that the new one does not carry would
    // otherwise stay on screen half-written; a reread says which are still open.
    for (const thread of this.#snapshot.threads) {
      if (thread.workspaceId !== message.workspaceId) continue;
      if (this.#snapshot.transcripts[thread.id]?.some((entry) => drawnLiveStream(entry) !== null))
        this.#scheduleLiveRefresh(thread.id, message.workspaceId);
    }
    const reconnected = channel.reconnectAttempt > 0;
    channel.synchronized = true;
    channel.reconnectAttempt = 0;
    if (reconnected) this.#reread();
    this.#sendAck(channel);
    this.#recomputeConnection();
    // A task notice sent while this socket was away is lost with it.
    this.#rereadTasks();
    // A usage notice sent while this socket was away is lost: a shown
    // conversation of this Workspace that was read before is read again now,
    // and one not shown is read whole when it next is. One shown while the
    // stream was not live has waited for it, and is read for the first time;
    // a read already under way began before the stream and is read again.
    for (const threadId of this.#browserUsageRead.keys()) {
      if (this.#threadWorkspace.get(threadId) !== message.workspaceId) continue;
      if (this.#showsThread(threadId)) this.#ensureBrowserUsage(threadId, "full");
      else this.#browserUsageRead.delete(threadId);
    }
    for (const threadId of [this.#activeThreadId, ...this.#observedThreads.keys()]) {
      if (!threadId || this.#threadWorkspace.get(threadId) !== message.workspaceId) continue;
      if (this.#browserUsageRead.has(threadId)) continue;
      this.#ensureBrowserUsage(
        threadId,
        this.#browserUsageReads.has(threadId) ? "full" : "missing",
      );
    }
  }

  #applyWorkspaceSnapshot(snapshot: WorkspaceSnapshot): void {
    const workspace = this.#toWorkspaceSummary(snapshot.workspace);
    this.#threadState.cover(workspace.id, snapshot.sequence);
    this.#runQueue.reconcile({
      runQueue: snapshot.runQueue,
      threads: new Map(snapshot.threads.map(({ id }) => [id, snapshot.sequence])),
      wholeWorkspace: true,
      workspaceId: workspace.id,
    });
    const transcripts: Record<string, TranscriptEntry[]> = { ...this.#snapshot.transcripts };
    const transcriptWindows = { ...this.#snapshot.transcriptWindows };
    const requests = { ...this.#snapshot.requests };
    const inputQueues = { ...this.#snapshot.inputQueues };
    const incomingThreadIds = new Set(snapshot.threads.map(({ id }) => id as string));
    for (const existing of this.#snapshot.threads) {
      if (existing.workspaceId !== workspace.id || incomingThreadIds.has(existing.id)) continue;
      // An active conversation or open task detail stays outside the default
      // visible Thread page; both were hydrated from durable history.
      if (existing.id === this.#activeThreadId || this.#observedThreads.has(existing.id)) continue;
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
      if (!this.#historicalThreads.has(thread.id) && !this.#showsThread(thread.id)) {
        if (snapshot.messagesOmitted) {
          delete transcripts[thread.id];
          delete transcriptWindows[thread.id];
        } else {
          transcripts[thread.id] = [];
        }
        this.#hydratedThreads.delete(thread.id);
      }
    }
    for (const window of snapshot.messageWindows) {
      if (!this.#historicalThreads.has(window.threadId) && !this.#showsThread(window.threadId))
        transcriptWindows[window.threadId] = window;
    }
    for (const message of snapshot.messages) {
      if (this.#historicalThreads.has(message.threadId) || this.#showsThread(message.threadId))
        continue;
      const entry = toTranscriptEntry(message);
      if (!entry) continue;
      transcripts[message.threadId] = upsertEntry(transcripts[message.threadId] ?? [], entry);
    }
    const workspaceThreadIds = new Set(snapshot.threads.map((thread) => thread.id as string));
    const threads = [
      ...snapshot.threads.map((thread) =>
        this.#threadState.reconcile(
          toThreadSummary(thread, this.#snapshot.environments, this.#snapshot.harnesses),
          snapshot.sequence,
          this.#snapshot.threads.find(({ id }) => id === thread.id),
        ),
      ),
      ...this.#snapshot.threads.filter(
        (thread) =>
          (thread.workspaceId !== workspace.id ||
            ((thread.id === this.#activeThreadId || this.#observedThreads.has(thread.id)) &&
              !incomingThreadIds.has(thread.id))) &&
          !workspaceThreadIds.has(thread.id),
      ),
    ];
    const next: HostSnapshot = {
      ...this.#snapshot,
      inputQueues,
      requests,
      runQueue: this.#runQueue.entries(),
      threads,
      transcriptWindows,
      transcripts,
      workspaces: [
        workspace,
        ...this.#snapshot.workspaces.filter((item) => item.id !== workspace.id),
      ],
    };
    this.#update({
      ...next,
      ...(workspace.id === next.homeWorkspaceId ? { homeThreadId: workspace.homeThreadId } : {}),
    });
    this.#applyReadStates(snapshot.readStates);
    this.#applyNotificationPreferences(snapshot.notificationPreferences);
    // A snapshot stands in for whatever the stream said in between, and the
    // queue reads follow that stream.
    this.#refreshInputQueues(
      threads.filter((thread) => thread.workspaceId === workspace.id).map(({ id }) => id),
    );
    // Events this Workspace sent while the stream was down are gone. An
    // observed Thread keeps what it shows until its history is read again, and
    // every held Thread reads its assignments again.
    for (const threadId of new Set([this.#activeThreadId, ...this.#observedThreads.keys()])) {
      if (threadId === null || this.#threadWorkspace.get(threadId) !== workspace.id) continue;
      if (!this.#historicalThreads.has(threadId)) {
        this.#hydratedThreads.delete(threadId);
        if (this.#hydrationBuffers.has(threadId)) this.#invalidatedHydrations.add(threadId);
        this.#ensureThreadHydration(threadId);
      }
      this.#ensureAssignments(threadId, true);
    }
    // A read still in flight for a Thread nobody shows yet, such as Home's
    // warm read, began before this snapshot: it reads again rather than
    // install an older page over what the snapshot carried.
    for (const threadId of this.#hydrationBuffers.keys()) {
      if (this.#historicalThreads.has(threadId)) continue;
      if (
        this.#threadWorkspace.get(threadId) === workspace.id ||
        workspace.homeThreadId === threadId
      )
        this.#invalidatedHydrations.add(threadId);
    }
  }

  #applyLive(input: LiveProgressInput): void {
    const channel = this.#channels.get(input.progress.workspaceId);
    if (!channel) return;
    if (compareSequence(input.afterSequence, channel.cursor) > 0) {
      const held = this.#heldLive.get(channel.workspaceId) ?? [];
      // Held progress is bounded; what is dropped is reread when it is missed.
      if (held.length >= maxHeldLiveFrames) held.shift();
      held.push(input);
      this.#heldLive.set(channel.workspaceId, held);
      return;
    }
    this.#drawLive(input);
  }

  /** Draws held progress whose durable predecessors have now been applied. */
  #releaseHeldLive(channel: WorkspaceChannel): void {
    const held = this.#heldLive.get(channel.workspaceId);
    if (!held?.length) return;
    const ready = held.filter((input) => compareSequence(input.afterSequence, channel.cursor) <= 0);
    if (ready.length === 0) return;
    this.#heldLive.set(
      channel.workspaceId,
      held.filter((input) => compareSequence(input.afterSequence, channel.cursor) > 0),
    );
    for (const input of ready) this.#drawLive(input);
  }

  #drawLive(input: LiveProgressInput): void {
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
    if (gap) this.#scheduleLiveRefresh(threadId, input.progress.workspaceId);
  }

  /**
   * Rereads a Thread's streams whole: after a frame was missed, or after a
   * resubscription, to learn which drawn streams it still carries. Reads are
   * debounced and never overlap. One asked for while another is in flight is
   * owed, not dropped, since the read in flight may predate what prompted it;
   * a reply older than what the ledger holds is ignored there.
   */
  #scheduleLiveRefresh(threadId: string, workspaceId: string): void {
    if (this.#disposed) return;
    const pending = this.#liveRereads.get(threadId);
    if (pending) {
      if (pending.timer === null) pending.again = true;
      return;
    }
    const reread: LiveReread = { again: false, timer: null };
    reread.timer = globalThis.setTimeout(() => {
      reread.timer = null;
      const generation = this.#liveGenerations.get(workspaceId) ?? 0;
      const viewer = this.#viewerGeneration;
      void this.rpc["thread.live.get"]({ threadId })
        .then((result) => {
          if (this.#liveRereads.get(threadId) !== reread || !result.ok) return;
          if (viewer !== this.#viewerGeneration) return;
          if ((this.#liveGenerations.get(workspaceId) ?? 0) !== generation) return;
          for (const run of result.data.runs) this.#applyLive(run);
          this.#sweepLive(threadId, workspaceId);
        })
        .catch(() => undefined)
        .finally(() => {
          // A read the session outlived is nobody's to settle or to repeat.
          if (this.#liveRereads.get(threadId) !== reread) return;
          this.#liveRereads.delete(threadId);
          if (reread.again) this.#scheduleLiveRefresh(threadId, workspaceId);
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
  #sweepLive(threadId: string, workspaceId: string): void {
    const entries = this.#snapshot.transcripts[threadId];
    if (!entries || this.#historicalThreads.has(threadId)) return;
    const held = new Set<string>();
    for (const input of this.#heldLive.get(workspaceId) ?? []) {
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

  #applyEvents(channel: WorkspaceChannel, events: readonly RealtimeEvent[]): void {
    let next = this.#snapshot;
    const touchedInputQueues = new Set<string>();
    for (const event of events) {
      if (compareSequence(event.sequence, channel.cursor) <= 0) continue;
      if (event.type === null) {
        channel.cursor = event.sequence;
        continue;
      }
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
      channel.cursor = event.sequence;
      this.#hydrationBuffers.get(event.threadId)?.push(event);
      if (inputQueueEventTypes.has(event.type)) touchedInputQueues.add(event.threadId);
    }
    if (next !== this.#snapshot) {
      this.#update(next);
      if (this.#activeThreadId) this.activateThread(this.#activeThreadId);
    }
    this.#releaseHeldLive(channel);
    this.#refreshInputQueues(touchedInputQueues);
  }

  /**
   * The projection can only drop what an event names. What a Run admitted,
   * what a refusal restored, and what may now be steered are the queue read's
   * to say, so the Thread on screen is read again. Any other Thread's copy is
   * let go instead, to be read afresh on its next activation: a Workspace
   * streaming a busy turn must not charge a read per event for every Thread
   * this person has visited.
   */
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

  #sendAck(channel: WorkspaceChannel): void {
    if (!channel.socket || channel.socket.readyState !== 1) return;
    channel.socket.send(
      JSON.stringify({
        sequence: channel.cursor,
        type: "client.ack",
        workspaceId: channel.workspaceId,
      }),
    );
  }

  #reconnectDelay(attempt: number): number {
    const ceiling = Math.min(
      this.#reconnectMaxDelayMs,
      this.#reconnectBaseDelayMs * 2 ** Math.min(attempt, 8),
    );
    return Math.min(this.#reconnectMaxDelayMs, Math.round(ceiling * (0.8 + this.#random() * 0.2)));
  }

  #scheduleReconnect(channel: WorkspaceChannel): void {
    if (this.#disposed || channel.reconnectTimer || this.#workspaceReconnectSuspended()) return;
    const delay = this.#reconnectDelay(channel.reconnectAttempt++);
    channel.reconnectTimer = globalThis.setTimeout(() => {
      channel.reconnectTimer = null;
      this.#connect(channel);
    }, delay);
  }

  #closeChannel(
    channel: WorkspaceChannel,
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
    // A refused background Workspace does not determine transport availability
    // for the Workspace being read. Its own screen remains unavailable.
    const pending = [...this.#channels.values()].filter(
      (channel) =>
        !channel.synchronized &&
        (!channel.refused ||
          channel.protocolFailed ||
          channel.workspaceId === this.#activeWorkspaceId),
    );
    const connection: HostConnectionState =
      pending.length === 0
        ? "connected"
        : pending.some((channel) => !channel.socket && !channel.reconnectTimer)
          ? "offline"
          : "connecting";
    if (connection !== this.#snapshot.connection || this.#network !== this.#snapshot.network) {
      this.#update({ ...this.#snapshot, connection });
    }
  }

  #ensureBrowserChannel(sessionId: string, mode: "control" | "watch" = "control"): void {
    if (this.#disposed || this.#snapshot.session !== "authenticated") return;
    const session = this.#snapshot.browserSessions.find((item) => item.id === sessionId);
    if (!session || session.state === "closed" || session.state === "failed") return;
    const existing = (mode === "watch" ? this.#browserWatchChannels : this.#browserChannels).get(
      sessionId,
    );
    if (!existing || existing.retainers === 0 || existing.socket || existing.reconnectTimer) return;
    this.#connectBrowser(existing);
  }

  #connectBrowser(channel: BrowserChannel): void {
    if (this.#disposed || channel.socket) return;
    // Same fence as the Workspace channel: the retainer is kept, so returning
    // to the foreground or to a network opens the viewer socket.
    if (this.#reconnectSuspended()) return;
    const socket = this.#webSocketFactory(
      this.#webSocketUrl(
        `/v1/browser-sessions/${encodeURIComponent(channel.sessionId)}/connect?editing=2${channel.mode === "watch" ? "&mode=watch" : ""}`,
      ),
    );
    socket.binaryType = "arraybuffer";
    channel.socket = socket;
    channel.awaitingAck = null;
    channel.reconnectTimer = null;
    channel.synchronized = false;
    this.#patchBrowserViewerState(channel.sessionId, channel.mode, {
      viewerError: null,
      viewerState: "connecting",
    });
    socket.addEventListener("message", (event) => {
      if (channel.socket !== socket) return;
      try {
        this.#handleBrowserFrame(channel, event.data);
      } catch (error) {
        this.#setBrowserFrame(channel.sessionId, null, channel.mode);
        this.#patchBrowserViewerState(channel.sessionId, channel.mode, {
          viewerError: error instanceof Error ? error.message : "Invalid browser protocol frame.",
          viewerState: "disconnected",
        });
        socket.close(4002, "Invalid browser protocol frame");
      }
    });
    socket.addEventListener("close", (event) => {
      if (channel.socket !== socket) return;
      channel.socket = null;
      channel.synchronized = false;
      if (channel.mode === "control") this.#browserEditing.disconnect(channel.sessionId);
      this.#setBrowserFrame(channel.sessionId, null, channel.mode);
      const session = this.#snapshot.browserSessions.find((item) => item.id === channel.sessionId);
      if (!session || session.state === "closed" || session.state === "failed") {
        (channel.mode === "watch" ? this.#browserWatchChannels : this.#browserChannels).delete(
          channel.sessionId,
        );
        return;
      }
      if (
        event.code === browserViewerCloseCodes.protocolViolation ||
        event.code === browserViewerCloseCodes.accessEnded
      ) {
        this.#patchBrowserViewerState(channel.sessionId, channel.mode, {
          viewerError:
            (channel.mode === "watch" ? session.watchViewerError : session.viewerError) ||
            event.reason ||
            "The browser viewer protocol failed.",
          viewerState: "disconnected",
        });
        return;
      }
      this.#patchBrowserViewerState(channel.sessionId, channel.mode, {
        viewerError: null,
        viewerState: "connecting",
      });
      this.#scheduleBrowserReconnect(channel);
    });
  }

  #handleBrowserFrame(channel: BrowserChannel, frame: unknown): void {
    if (typeof frame === "string") {
      if (frame.length > maxInboundFrameCharacters) {
        throw new Error("Browser protocol frame is too large.");
      }
      this.#projectBrowserMessage(channel, BrowserServerMessageSchema.parse(JSON.parse(frame)));
      return;
    }
    if (!(frame instanceof ArrayBuffer)) {
      throw new Error("Browser binary frame was not delivered as an ArrayBuffer.");
    }
    if (!channel.synchronized) {
      throw new Error("Browser viewer frame arrived before its snapshot.");
    }
    const decoded = decodeBrowserFrameEnvelope(new Uint8Array(frame), maxBrowserFrameBytes);
    const data = new Uint8Array(decoded.data.byteLength);
    data.set(decoded.data);
    if (decoded.header.watchToken || channel.mode === "watch") {
      if (!decoded.header.watchToken) {
        throw new Error("Browser Watch frame omitted its acknowledgement token.");
      }
      channel.awaitingAck = decoded.header.watchToken;
    }
    this.#setBrowserFrame(
      channel.sessionId,
      { data: data.buffer, header: decoded.header },
      channel.mode,
    );
  }

  #projectBrowserMessage(channel: BrowserChannel, message: BrowserServerMessage): void {
    const sessionId = channel.sessionId;
    const session = this.#snapshot.browserSessions.find((item) => item.id === sessionId);
    if (!session) return;
    if (message.type === "browser.snapshot") {
      if (channel.synchronized) throw new Error("Browser viewer received a duplicate snapshot.");
      if (message.sessionId !== sessionId) throw new Error("Browser session ID mismatch.");
      assertBrowserDialogSurface(message.dialog, message.surfaces);
      channel.synchronized = true;
      if (channel.mode === "control")
        this.#browserEditing.negotiate(
          sessionId,
          message.editingVersion,
          undefined,
          message.clipboard,
        );
      channel.reconnectAttempt = 0;
      this.#patchBrowserSession(sessionId, {
        access: message.access,
        dialog: message.dialog,
        error: null,
        state: message.state,
        tabs: browserTabs(message.surfaces),
      });
      this.#patchBrowserViewerState(sessionId, channel.mode, {
        viewerError: null,
        viewerState: "synchronized",
      });
      this.#subscribeBrowserWatch(channel);
      return;
    }
    if (!channel.synchronized) throw new Error("Browser viewer event arrived before its snapshot.");
    if (message.type === "browser.status") {
      this.#patchBrowserSession(sessionId, { state: message.state });
      this.#setBrowserFrame(sessionId, null, channel.mode);
      return;
    }
    if (message.type === "browser.error") {
      this.#patchBrowserSession(sessionId, { error: message.error.message });
      return;
    }
    if (message.type === "browser.dialog.changed") {
      assertBrowserDialogSurface(message.dialog, session.tabs);
      this.#patchBrowserSession(sessionId, { dialog: message.dialog });
      return;
    }
    if (channel.mode === "control") this.#browserEditing.receive(sessionId, message);
    if (message.type === "browser.surfaces.changed") {
      assertBrowserDialogSurface(session.dialog, message.surfaces);
      // A new title or address is the same picture; another tab coming
      // forward is not, and its picture follows.
      const active = message.surfaces.find((surface) => surface.active)?.id ?? null;
      const shown = (
        channel.mode === "watch" ? this.#browserWatchFrameValues : this.#browserFrameValues
      ).get(sessionId);
      if (shown && shown.header.surfaceId !== active) {
        this.#setBrowserFrame(sessionId, null, channel.mode);
      }
      this.#patchBrowserSession(sessionId, { tabs: browserTabs(message.surfaces) });
    }
  }

  #scheduleBrowserReconnect(channel: BrowserChannel): void {
    if (this.#disposed || channel.retainers === 0 || channel.reconnectTimer) return;
    if (this.#reconnectSuspended()) return;
    const delay = this.#reconnectDelay(channel.reconnectAttempt++);
    channel.reconnectTimer = globalThis.setTimeout(() => {
      channel.reconnectTimer = null;
      this.#connectBrowser(channel);
    }, delay);
  }

  #closeBrowserChannel(sessionId: string, mode: "control" | "watch" = "control"): void {
    if (mode === "control") this.#browserEditing.disconnect(sessionId);
    const channels = mode === "watch" ? this.#browserWatchChannels : this.#browserChannels;
    const channel = channels.get(sessionId);
    if (channel) {
      if (channel.reconnectTimer) globalThis.clearTimeout(channel.reconnectTimer);
      channel.reconnectTimer = null;
      const socket = channel.socket;
      this.#returnWatchCredit(channel);
      channel.socket = null;
      channel.synchronized = false;
      socket?.close(1000, "Client closed");
      channels.delete(sessionId);
    }
    this.#setBrowserFrame(sessionId, null, mode);
  }

  #setBrowserFrame(
    sessionId: string,
    frame: BrowserFrameView | null,
    mode: "control" | "watch" = "control",
  ): void {
    if (this.#disposed && frame) return;
    const values = mode === "watch" ? this.#browserWatchFrameValues : this.#browserFrameValues;
    const listeners =
      mode === "watch" ? this.#browserWatchFrameListeners : this.#browserFrameListeners;
    // A picture dropped before the view showed it still returns its credit.
    const dropped = values.get(sessionId)?.header.watchToken;
    const channel = (mode === "watch" ? this.#browserWatchChannels : this.#browserChannels).get(
      sessionId,
    );
    if (channel && dropped && channel.awaitingAck === dropped) this.#returnWatchCredit(channel);
    if (frame) {
      values.set(sessionId, frame);
    } else if (!values.delete(sessionId)) {
      return;
    }
    for (const listener of listeners.get(sessionId) ?? []) listener();
  }

  #clearBrowserFrames(): void {
    for (const sessionId of this.#browserFrameValues.keys()) {
      this.#setBrowserFrame(sessionId, null);
    }
    for (const sessionId of this.#browserWatchFrameValues.keys()) {
      this.#setBrowserFrame(sessionId, null, "watch");
    }
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

  #patchBrowserViewerState(
    sessionId: string,
    mode: "control" | "watch",
    patch: Pick<BrowserSessionSummary, "viewerError" | "viewerState">,
  ): void {
    this.#patchBrowserSession(
      sessionId,
      mode === "watch"
        ? { watchViewerError: patch.viewerError, watchViewerState: patch.viewerState }
        : patch,
    );
  }

  async #loadEarlierTranscript(threadId: string): Promise<void> {
    const thread = this.#snapshot.threads.find((item) => item.id === threadId);
    const currentWindow = this.#snapshot.transcriptWindows[threadId];
    if (!thread || currentWindow?.hasMore === false) return;
    const page = unwrapRpcResult(
      await this.rpc["thread.events.list"]({
        ...(currentWindow?.nextBefore ? { before: currentWindow.nextBefore } : {}),
        threadId,
      }),
    );
    if (page.threadId !== threadId) throw new Error("Thread event page mismatch.");
    for (const event of page.events) this.#threadState.record(event);
    const current = this.#snapshot.threads.find(({ id }) => id === threadId);
    const summary = this.#threadState.reconcile(
      toThreadSummary(page.thread, this.#snapshot.environments, this.#snapshot.harnesses),
      page.readState.asOfSequence,
      current,
    );
    const olderEntries = page.events.reduce(foldTranscriptEvent, [] as TranscriptEntry[]);
    const currentEntries = this.#snapshot.transcripts[threadId] ?? [];
    this.#update({
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
    });
  }

  async #loadRequests(threadId: string): Promise<void> {
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

  async #loadEarlierWorkspaces(): Promise<void> {
    const generation = this.#viewerGeneration;
    const userId = this.#snapshot.user?.id;
    const currentWindow = this.#snapshot.workspaceWindow;
    if (!currentWindow.hasMore) return;
    const page = unwrapRpcResult(
      await this.rpc["workspace.catalog.list"](
        currentWindow.nextBefore ? { before: currentWindow.nextBefore } : {},
      ),
    );
    if (!this.#viewerStillCurrent(generation, userId)) return;
    for (const workspace of page.workspaces) this.#allowWorkspace(workspace.id, generation);
    const existingIds = new Set(this.#snapshot.workspaces.map(({ id }) => id));
    const additional = page.workspaces
      .filter((workspace) => !existingIds.has(workspace.id))
      .map((workspace) => this.#toWorkspaceSummary(workspace));
    this.#update({
      ...this.#snapshot,
      workspaces: [...this.#snapshot.workspaces, ...additional],
      workspaceWindow: page.window,
    });
    this.#applyNotificationPreferences(page.notificationPreferences);
  }

  #toWorkspaceSummary(workspace: WorkspaceView): WorkspaceSummary {
    return this.#reconcileWorkspaceColor(
      toWorkspaceSummary(workspace, this.#snapshot.environments, this.#snapshot.harnesses),
    );
  }

  #reconcileWorkspaceColor(workspace: WorkspaceSummary): WorkspaceSummary {
    const previous = this.#workspaceColors.get(workspace.id);
    // Only Host records carry colour authority. Thread activity also advances
    // the displayed Workspace timestamp without changing its colour.
    if (!previous || workspace.updatedAt >= previous.updatedAt) {
      this.#workspaceColors.set(workspace.id, {
        color: workspace.color,
        updatedAt: workspace.updatedAt,
      });
      return workspace;
    }
    return { ...workspace, color: previous.color };
  }

  #expireSession(): void {
    this.#viewerGeneration += 1;
    this.#retainedWorkspaceTabLineages.clear();
    this.#workspaceTabReads.clear();
    this.#browserUsageRead.clear();
    this.#browserUsageReads.clear();
    this.#browserUsageRunSources.clear();
    this.#browserUses.clear();
    this.#browserPresence.clear();
    this.#tabCatalogs.clear();
    this.#placeActivity.clear();
    this.#latestPlace.clear();
    this.#targetedWatch.clear();
    this.#targetedControl.clear();
    this.#reportedTimeZone = null;
    this.#threadState.clear();
    this.#threadRenames.clear();
    this.#threadIcons.clear();
    this.#workspaceColors.clear();
    this.#workspaceColorEdits.clear();
    // Another viewer may sign in next and open the same Threads; nothing this
    // one was streaming, nor any reread asked for it, may draw for them.
    this.#runQueue.clear();
    this.#live.clear();
    this.#heldLive.clear();
    this.#forgetLiveRereads();
    this.#forbiddenWorkspaces.clear();
    this.#threadWorkspace.clear();
    this.#assignmentReads.clear();
    this.#requestReads.clear();
    this.#deniedAssignments.clear();
    this.#observedThreads.clear();
    this.#historicalThreads.clear();
    this.#threadHydrations.clear();
    this.#hydrationBuffers.clear();
    this.#hydratedThreads.clear();
    this.#invalidatedHydrations.clear();
    this.#readStateLoads.clear();
    this.#notificationPreferences.clear();
    this.#workspaceTaskScopes.clear();
    this.#stopRefresh();
    for (const channel of this.#channels.values()) this.#closeChannel(channel, false);
    this.#channels.clear();
    for (const sessionId of this.#browserChannels.keys()) this.#closeBrowserChannel(sessionId);
    for (const sessionId of this.#browserWatchChannels.keys())
      this.#closeBrowserChannel(sessionId, "watch");
    this.#clearBrowserFrames();
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

  #allowWorkspace(workspaceId: string, generation: number): void {
    if (generation !== this.#viewerGeneration || !this.#forbiddenWorkspaces.delete(workspaceId))
      return;
    const channel = this.#channels.get(workspaceId);
    if (channel) {
      channel.refused = false;
      channel.cursor = zeroSequence;
    }
  }

  #refuseWorkspace(workspaceId: string): void {
    this.#viewerGeneration += 1;
    this.#browserUsageRead.clear();
    this.#browserUsageReads.clear();
    this.#browserUsageRunSources.clear();
    this.#forbiddenWorkspaces.add(workspaceId);
    this.#targetedControl.reconcile(
      (sessionId) =>
        this.#snapshot.browserSessions.find((session) => session.id === sessionId)?.workspaceId !==
        workspaceId,
    );
    this.#targetedWatch.reconcile(
      (sessionId) =>
        this.#snapshot.browserSessions.find((session) => session.id === sessionId)?.workspaceId !==
        workspaceId,
    );
    this.#notificationPreferences.delete(workspaceId);
    this.#workspaceTaskScopes.delete(workspaceId);
    for (const [threadId, ownerWorkspaceId] of this.#threadWorkspace) {
      if (ownerWorkspaceId !== workspaceId) continue;
      this.#historicalThreads.delete(threadId);
      this.#hydratedThreads.delete(threadId);
      this.#browserUses.delete(threadId);
    }
    for (const session of this.#snapshot.browserSessions) {
      if (session.workspaceId === workspaceId) {
        this.#closeBrowserChannel(session.id);
        this.#closeBrowserChannel(session.id, "watch");
      }
    }
    if (this.#activeWorkspaceId === workspaceId) this.#activeWorkspaceId = null;
    this.#update(this.#snapshot);
  }

  #url(path: string): string {
    return new URL(path, this.#baseUrl).toString();
  }

  #webSocketUrl(path: string): string {
    const url = new URL(path, this.#baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
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
      this.#snapshot.deploymentId !== viewer.deploymentId ||
      this.#forbiddenWorkspaces.has(notification.workspaceId)
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

  #update(snapshot: HostSnapshot): void {
    if (this.#disposed) return;
    const workspaceTabsChanged = snapshot.workspaceTabs !== this.#snapshot.workspaceTabs;
    const scope = viewerScopeOf(snapshot);
    if (this.#viewer.change(scope)) {
      this.#workspaceTabActivations.clear(false);
      this.#computerViews.clear();
      this.#ownerViews.clear();
      snapshot = {
        ...snapshot,
        browserTabGroups: this.#tabGroups.receive(snapshot.browserTabGroups),
      };
    }
    snapshot = { ...snapshot, activatingWorkspaceTabs: this.#workspaceTabActivations.ids };
    // A dropped connection pauses the views being watched; it does not end them.
    this.#computerViews.setConnected(scope !== null && snapshot.connection === "connected");
    this.recentSites.setScope(scope);
    this.browserPreferences.setScope(scope);
    let reconcileBrowserTargets: (() => void) | undefined;
    if (snapshot.session !== "authenticated") {
      this.#placeActivity.clear();
      this.#latestPlace.clear();
      this.#targetedWatch.clear();
      this.#targetedControl.clear();
    } else {
      // Activity arrives only over realtime, so none of it stands through a reconnect.
      if (snapshot.connection !== "connected") this.#placeActivity.clear();
      if (
        snapshot.browserSessions !== this.#snapshot.browserSessions ||
        snapshot.machines !== this.#snapshot.machines ||
        snapshot.connection !== this.#snapshot.connection ||
        snapshot.latestPlaces !== this.#snapshot.latestPlaces
      ) {
        this.#latestPlace.reconcile(snapshot, snapshot.latestPlaces);
        const places = placeList(snapshot);
        if (snapshot.connection === "connected")
          this.#placeActivity.reconcile(
            new Set(places.filter((place) => place.availability === "ready").map(({ key }) => key)),
          );
        // Browser viewers follow the catalog, never the realtime channel: the
        // Host admits and revokes each one on its own socket.
        const allowed = (sessionId: string, surfaceId: string) =>
          places.some(
            (place) =>
              place.key === `browser:${sessionId}:${surfaceId}` && place.availability === "ready",
          );
        reconcileBrowserTargets = () => {
          this.#targetedWatch.reconcile(allowed);
          this.#targetedControl.reconcile(allowed);
        };
      }
    }
    for (const thread of snapshot.threads) this.#threadWorkspace.set(thread.id, thread.workspaceId);
    for (const { thread } of snapshot.activeTasks)
      this.#threadWorkspace.set(thread.id, thread.workspaceId);
    for (const list of [snapshot.tasks, ...Object.values(snapshot.workspaceTasks)])
      for (const { thread } of list?.entries ?? [])
        this.#threadWorkspace.set(thread.id, thread.workspaceId);
    const hiddenAssignments = new Set(this.#deniedAssignments);
    if (this.#forbiddenWorkspaces.size > 0) {
      const deniedThreads = new Set(
        [...this.#threadWorkspace]
          .filter(([, workspaceId]) => this.#forbiddenWorkspaces.has(workspaceId))
          .map(([threadId]) => threadId),
      );
      const retainThread = ([threadId]: [string, unknown]) => !deniedThreads.has(threadId);
      const deniedHome =
        snapshot.homeWorkspaceId !== null &&
        this.#forbiddenWorkspaces.has(snapshot.homeWorkspaceId);
      // A task goes with either end of it: the Workspace it works in, or the
      // conversation it reports to.
      for (const assignment of heldAssignments(snapshot)) {
        if (
          this.#forbiddenWorkspaces.has(assignment.workerThread.workspaceId) ||
          deniedThreads.has(assignment.parentThreadId)
        )
          hiddenAssignments.add(assignment.id);
      }
      snapshot = {
        ...snapshot,
        browserSessions: snapshot.browserSessions.filter(
          ({ workspaceId }) => !this.#forbiddenWorkspaces.has(workspaceId),
        ),
        homeThreadId: deniedHome ? null : snapshot.homeThreadId,
        homeWorkspaceId: deniedHome ? null : snapshot.homeWorkspaceId,
        inputQueues: Object.fromEntries(Object.entries(snapshot.inputQueues).filter(retainThread)),
        notificationMutes: snapshot.notificationMutes.filter(
          (workspaceId) => !this.#forbiddenWorkspaces.has(workspaceId),
        ),
        requests: Object.fromEntries(Object.entries(snapshot.requests).filter(retainThread)),
        runQueue: snapshot.runQueue.filter(({ threadId }) => !deniedThreads.has(threadId)),
        activeTasks: snapshot.activeTasks.filter(({ thread }) => !deniedThreads.has(thread.id)),
        tasks: snapshot.tasks && {
          ...snapshot.tasks,
          entries: snapshot.tasks.entries.filter(({ thread }) => !deniedThreads.has(thread.id)),
        },
        workspaceTasks: Object.fromEntries(
          Object.entries(snapshot.workspaceTasks).filter(
            ([workspaceId]) => !this.#forbiddenWorkspaces.has(workspaceId),
          ),
        ),
        threadLookups: Object.fromEntries([
          ...Object.entries(snapshot.threadLookups).map(([threadId, state]) => [
            threadId,
            deniedThreads.has(threadId) ? "missing" : state,
          ]),
          ...(this.#activeThreadId && deniedThreads.has(this.#activeThreadId)
            ? [[this.#activeThreadId, "missing"]]
            : []),
        ]),
        threadReadStates: Object.fromEntries(
          Object.entries(snapshot.threadReadStates).filter(retainThread),
        ),
        threads: snapshot.threads.filter(
          ({ workspaceId }) => !this.#forbiddenWorkspaces.has(workspaceId),
        ),
        transcriptWindows: Object.fromEntries(
          Object.entries(snapshot.transcriptWindows).filter(retainThread),
        ),
        transcripts: Object.fromEntries(Object.entries(snapshot.transcripts).filter(retainThread)),
        workspaces: snapshot.workspaces.filter(({ id }) => !this.#forbiddenWorkspaces.has(id)),
      };
    }
    if (hiddenAssignments.size > 0) snapshot = withoutAssignments(snapshot, hiddenAssignments);
    this.#threadState.retainLoaded(snapshot.threads);
    snapshot = withThreadNames(snapshot, (thread) => ({
      ...this.#threadState.name(thread),
      ...(this.#threadRenames.has(thread.id)
        ? { title: this.#threadRenames.get(thread.id)!.title }
        : {}),
      ...(this.#threadIcons.has(thread.id) ? { icon: this.#threadIcons.get(thread.id)!.icon } : {}),
    }));
    snapshot = {
      ...snapshot,
      workspaces: snapshot.workspaces.map((workspace) => {
        const mark =
          this.#workspaceColorEdits.get(workspace.id) ?? this.#workspaceColors.get(workspace.id);
        return mark && mark.color !== workspace.color
          ? { ...workspace, color: mark.color }
          : workspace;
      }),
    };
    this.#snapshot = {
      ...snapshot,
      threadRenameAvailable: this.#capabilities?.includes("thread-titles-v1") === true,
      taskMarksAvailable: this.#capabilities?.includes("task-marks-v1") === true,
      sharedTaskDoneAvailable: this.#capabilities?.includes("shared-task-done-v1") === true,
      workspaceTabReopenAvailable: this.#capabilities?.includes("workspace-tab-reopen-v1") === true,
      searchSuggestionsAvailable:
        this.#capabilities?.includes("browser-search-suggestions-v1") === true,
      iphoneAppsAvailable: this.#capabilities?.includes("iphone-apps-v1") === true,
      ownerViewWindowsAvailable: this.#capabilities?.includes("ownerViewWindows") === true,
      // An unchanged Thread keeps its identity: screens compare records by
      // reference, and every publish passes through here.
      threads: snapshot.threads.map((thread) => {
        const state = snapshot.threadReadStates[thread.id];
        if (!state) return thread;
        const unread = isThreadUnread(state);
        return thread.unread === unread ? thread : { ...thread, unread };
      }),
      network: this.#network,
      revision: this.#snapshot.revision + 1,
    };
    if (workspaceTabsChanged)
      this.#snapshot = { ...this.#snapshot, browserTabGroups: this.#tabGroups.project() };
    reconcileBrowserTargets?.();
    for (const listener of this.#listeners) listener();
    this.#checkBrowserUsageRuns();
  }
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
              : code === "runner_offline" || code === "workspace_unavailable"
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
        ...(event.data.home ? { homeThreadId: thread.id } : {}),
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
        workspaces: snapshot.workspaces.map((workspace) =>
          workspace.id === event.workspaceId
            ? { ...workspace, updatedAt: event.createdAt }
            : workspace,
        ),
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
        workspaces: snapshot.workspaces.map((workspace) =>
          workspace.id === event.workspaceId
            ? { ...workspace, updatedAt: event.createdAt }
            : workspace,
        ),
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
    threads: patchThread(snapshot.threads, event.threadId, {
      updatedAt: event.createdAt,
    }),
    transcripts: entries
      ? { ...snapshot.transcripts, [event.threadId]: entries }
      : snapshot.transcripts,
    workspaces: snapshot.workspaces.map((workspace) =>
      workspace.id === event.workspaceId ? { ...workspace, updatedAt: event.createdAt } : workspace,
    ),
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

/** Every assignment the snapshot mentions, whether as a summary or a transcript entry. */
function* heldAssignments(snapshot: HostSnapshot): Iterable<AssignmentSummary> {
  yield* Object.values(snapshot.assignments);
  for (const entries of Object.values(snapshot.transcripts)) {
    for (const entry of entries) if (entry.kind === "assignment") yield entry.assignment;
  }
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
    threadRenameAvailable: false,
    taskMarksAvailable: false,
    sharedTaskDoneAvailable: false,
    iphoneAppsAvailable: false,
    assignments: {},
    requests: {},
    waitingRequests: [],
    runQueue: [],
    browserProfileGrants: [],
    browserAvailable: false,
    browserPlacements: [],
    browserProfiles: [],
    browserSessions: [],
    connection: "connecting",
    network: "unknown",
    deploymentShape: null,
    deploymentId: null,
    environments: [],
    executionPreferences: emptyExecutionPreferences,
    harnesses: [],
    homeWorkspaceId: null,
    homeThreadId: null,
    notificationMutes: [],
    threadReadStates: {},
    tasks: null,
    activeTasks: [],
    workspaceTasks: {},
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
    workspaceSharingAvailable: false,
    workspaceWindow: {
      byteCount: 2,
      hasMore: false,
      itemCount: 0,
      nextBefore: null,
      totalItems: 0,
    },
    workspaces: [],
  };
}

function preferredEnvironment(
  environments: readonly EnvironmentSummary[],
): EnvironmentSummary | null {
  return (
    [...environments]
      .filter((environment) => environment.connected)
      .sort((left, right) => environmentRank(left) - environmentRank(right))[0] ?? null
  );
}

function environmentRank(environment: EnvironmentSummary): number {
  if (environment.kind === "main") return 0;
  if (environment.kind === "managed") return 1;
  return 2;
}

function preferredHarness(harnesses: readonly HarnessSummary[]): HarnessSummary | null {
  return (
    [...harnesses]
      .filter((harness) => harness.enabled)
      .sort(
        (left, right) => harnessDisplayRank(left.driverKind) - harnessDisplayRank(right.driverKind),
      )[0] ?? null
  );
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

/**
 * `keepPresence` keeps the acting state and page a presence patch gave
 * `existing` after the read that produced `session` began.
 */
function toBrowserSessionSummary(
  session: HostedBrowserSession,
  existing: BrowserSessionSummary | undefined,
  /** A presence patch newer than the answer this session came from. */
  heldPresence: BrowserPresence | null,
  /** Which pages each Run used is read per conversation, never carried by the catalog. */
  uses: readonly BrowserSessionUseSummary[],
): BrowserSessionSummary {
  const terminal = session.state === "closed" || session.state === "failed";
  const presence =
    heldPresence && !terminal
      ? { acting: heldPresence.acting, page: heldPresence.page }
      : { acting: session.acting ?? false, page: session.page ?? null };
  return {
    access: session.access,
    navigationVersion: session.navigationVersion,
    workspaceTabRestoreVersion: session.workspaceTabRestoreVersion,
    ...presence,
    ...((
      terminal
        ? session.tabCatalog
        : newerBrowserTabCatalog(existing?.tabCatalog, session.tabCatalog)
    )
      ? {
          tabCatalog: terminal
            ? { ...session.tabCatalog!, tabs: [] }
            : newerBrowserTabCatalog(existing?.tabCatalog, session.tabCatalog)!,
        }
      : {}),
    attachedRunIds: [...(session.attachedRunIds ?? [])],
    createdAt: session.createdAt,
    threadIds: [...(session.threadIds ?? existing?.threadIds ?? [])],
    uses: sameElements(existing?.uses ?? [], uses) ? (existing?.uses ?? []) : uses,
    dialog: terminal ? null : (existing?.dialog ?? null),
    error: existing?.error ?? null,
    id: session.id,
    origin: session.origin,
    ...(session.opener ? { opener: session.opener } : {}),
    placement: session.placement,
    profileId: session.profileId,
    runtimeId: session.runtimeId,
    state: session.state,
    tabs: existing?.tabs ?? [],
    viewerError: terminal ? null : (existing?.viewerError ?? null),
    viewerState: terminal ? "disconnected" : (existing?.viewerState ?? "disconnected"),
    watchViewerError: terminal ? null : (existing?.watchViewerError ?? null),
    watchViewerState: terminal ? "disconnected" : (existing?.watchViewerState ?? "disconnected"),
    workspaceId: session.workspaceId,
  };
}

function sameElements<Item>(left: readonly Item[], right: readonly Item[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
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

/** A machine as a bootstrap read it, keeping acting apps patched after the read began. */
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

function browserTabs(
  surfaces: Extract<BrowserServerMessage, { type: "browser.snapshot" }>["surfaces"],
): BrowserSessionSummary["tabs"] {
  return surfaces.map(({ active, favicon, id, loading, sizedByAgent, title, url }) => ({
    active,
    favicon,
    id,
    loading,
    sizedByAgent,
    title,
    url,
  }));
}

function assertBrowserDialogSurface(
  dialog: BrowserSessionSummary["dialog"],
  surfaces: readonly { readonly id: string }[],
): void {
  if (dialog && !surfaces.some((surface) => surface.id === dialog.surfaceId)) {
    throw new Error("Browser dialog references an unknown surface.");
  }
}

function toWorkspaceSummary(
  workspace: WorkspaceView,
  environments: readonly EnvironmentSummary[],
  harnesses: readonly HarnessSummary[],
): WorkspaceSummary {
  const environment = preferredEnvironment(environments) ?? environments[0];
  const harness = preferredHarness(harnesses) ?? harnesses[0];
  return {
    description: workspaceDescription(workspace),
    homeThreadId: workspace.homeThreadId,
    fileCount: 0,
    harnessLabel: harness?.name ?? "No harness",
    id: workspace.id,
    kind: workspace.kind,
    machineName: workspace.location.kind === "machine" ? workspace.location.name : null,
    name: workspace.name,
    icon: workspace.icon,
    runnerLabel: environment?.name ?? "No work location",
    status: workspace.status,
    storageIssue: workspace.storageIssue,
    color: workspace.color ?? null,
    updatedAt: workspace.updatedAt,
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
    doneAt: thread.doneAt,
    accessMode: thread.accessMode,
    continuationIdentity: thread.continuationIdentity,
    providerSessionId: thread.providerSessionId,
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
    role: thread.role,
    runnerLabel: environment?.name ?? "Unavailable work location",
    status: thread.status,
    title: thread.title,
    icon: thread.icon ?? null,
    color: thread.color ?? null,
    unread: false,
    updatedAt: thread.updatedAt,
    workspaceId: thread.workspaceId,
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
  for (const environment of environments) {
    for (const catalog of environment.harnessCatalogs) {
      if (catalog.status !== "ready") continue;
      const model = catalog.models.find(
        (candidate) =>
          candidate.providerId === selection.providerId && candidate.modelId === selection.modelId,
      );
      if (model) return model.displayName;
    }
  }
  return selection.modelId;
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

function workspaceDescription(workspace: WorkspaceView): string {
  const { status } = workspace;
  if (status === "provisioning" && workspace.restoreProgressPermille !== undefined) {
    return `Waking… (${Math.floor(workspace.restoreProgressPermille / 10)}%)`;
  }
  if (status === "provisioning") return "Opensteer is preparing this Workspace.";
  if (status === "archiving") return "Being archived — it wakes when you use it again.";
  if (status === "archived") return "Archived — it wakes when you use it again.";
  if (status === "deleting") return "Scheduled for deletion during the retention window.";
  if (status === "unavailable") return "This Workspace is temporarily unavailable.";
  if (status === "failed") return "Workspace provisioning needs attention.";
  return "A durable Workspace shared by every Thread.";
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

function isTextContentType(value: string): boolean {
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    mediaType.startsWith("text/") ||
    mediaType === "application/json" ||
    mediaType === "application/javascript" ||
    mediaType === "application/sql" ||
    mediaType === "application/toml" ||
    mediaType === "application/xml" ||
    mediaType === "application/x-httpd-php" ||
    mediaType === "application/x-sh" ||
    mediaType === "application/x-yaml" ||
    mediaType.endsWith("+json") ||
    mediaType.endsWith("+xml")
  );
}

export { HostClientRequestError as HostHttpError } from "./client.js";

export type { HostToClientMessage };
