import type { HostRelayAuthenticator } from "../passkeys/host-relay.js";
import { layoutMetricsSchema, screenshotDensity, visualViewportSchema } from "./layout-metrics.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { AsyncMutex } from "../async.js";
import { SessionCdpRouter, SessionCdpRouterError, type CdpCommand } from "@opensteer/browser-core";
import {
  browserHostMethods,
  LoginRefSchema,
  LoginFieldSchema,
  BrowserSurfaceIdSchema,
  BrowserCdpResultSchema,
  BrowserClientMessageSchema,
  browserCaptureMaxTargets,
  BrowserContextCandidateSchema,
  previousReleaseEligibility,
  BrowserSessionTabOpenCommandSchema,
  browserWorkspaceTabUrlMaxLength,
  browserTabOpenClosedReason,
  browserStateImportRuntimeTimeoutMs,
  type BrowserAttachTicketClaims,
  type BrowserClientMessage,
  type BrowserDialog,
  type BrowserServerMessage,
  type BrowserSurfaceId,
} from "@opensteer/protocol";
import type { BrowserCookie, BrowserProfileSnapshot } from "@opensteer/browser-profile/snapshot";
import { delay } from "@opensteer/shared/delay";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { BrowserRuntimeError, toBrowserRuntimeError } from "../errors.js";
import { BrowserInputLane } from "./input-lane.js";
import { PageEditingObserver } from "./editing-observer.js";
import {
  ClipboardParts,
  engineClipboardCoordinator,
  pageClipboardWrite,
  publishClipboardItems,
} from "./editing-clipboard.js";
import {
  cocoaKeyCommands,
  editingCommandParameters,
  editingModifiers,
} from "./editing-commands.js";
import { keyEventParameters } from "./key-codes.js";
import type { EditingCaret } from "@opensteer/protocol/editing";
import { LatestFrameStream, type BrowserFrameSink } from "../stream/latest-frame-stream.js";
import type { CdpSession, EngineClipboard } from "./backend.js";
import { ScreencastController } from "./screencast-controller.js";
import { stageFileMethod, type SessionFiles } from "./session-files.js";
import type { HostSignIns } from "./host-sign-ins.js";
import type { ScriptTarget } from "./script-targets.js";
import type {
  BrowserTargetActivity,
  BrowserTargetResize,
  PageSize,
  SurfaceLedger,
  SurfaceLedgerEvent,
} from "./surface-ledger.js";

export interface BrowserControllerSink extends BrowserFrameSink {
  sendServer(message: BrowserServerMessage): Promise<void>;
}

interface BrowserControllerOptions {
  passkeys?: HostRelayAuthenticator | undefined;
  cdpRouter: SessionCdpRouter;
  claims: BrowserAttachTicketClaims;
  clipboard?: EngineClipboard | undefined;
  /** Reads the live state of the host browser this session runs inside. */
  exportSnapshot: () => Promise<BrowserProfileSnapshot>;
  /** This session's folder for files its pages may receive. */
  files: SessionFiles;
  ledger: SurfaceLedger;
  maxPendingCommands?: number;
  maxPendingMessageBytes?: number;
  maxPendingMessages?: number;
  /** OS the browser engine runs on; defaults to this process's platform. */
  platform?: NodeJS.Platform;
  /**
   * Replaces one site's cookies in the host browser this session runs inside.
   * Every session on that host sees the result; the runtime serializes calls
   * per host. Once `deadline` aborts, the implementation must not write.
   */
  replaceSiteCookies: (
    site: string,
    cookies: readonly BrowserCookie[],
    deadline: AbortSignal,
  ) => Promise<void>;
  /** The saved-password sign-ins of the host this session runs inside. */
  signIns: HostSignIns;
  sink: BrowserControllerSink;
}

interface CommandQueue {
  pending: number;
  overflowReported: boolean;
  tail: Promise<void>;
}

interface QueuedOperation {
  readonly done: Promise<void>;
  /** The page the operation sends its command to, if any. */
  readonly surfaceId: BrowserSurfaceId | null;
}

type PointerButton = "left" | "middle" | "right";

/** What the person did in a page since the agent last acted there, measured at attach. */
interface AttachedActivity {
  readonly pageResize: BrowserTargetResize | undefined;
  readonly userActivity: BrowserTargetActivity | undefined;
}

/** One actor's cursor on one page. */
interface AgentPointer {
  readonly surfaceId: BrowserSurfaceId;
  /** Where it rests, as a fraction of the page's view; null until it is placed. */
  point: { x: number; y: number } | null;
  /** When the actor last sent pointer input to the page, by `agentPointerClock`. */
  inputAt: number;
}

/** An agent script running in a page, and the first element a script aimed at meanwhile. */
interface ScriptRun {
  readonly startedAt: number;
  /** Another agent script ran in the page meanwhile, so no target is this one's. */
  contended: boolean;
  target: ScriptTarget | null;
  stop(): void;
}

/** Agent commands whose point is where a person's pointer would be. */
const pointerInputMethods = new Set([
  "Input.dispatchMouseEvent",
  "Input.dispatchTouchEvent",
  "Input.dispatchDragEvent",
]);
/** Agent commands that run the agent's script in a page. */
const scriptMethods = new Set([
  "Runtime.evaluate",
  "Runtime.callFunctionOn",
  "Runtime.awaitPromise",
]);
const maxAgentPointers = 256;
const PointSchema = z.object({ x: z.number(), y: z.number() });

/** How long closing waits for one step that Chrome may never answer. */
const closeGraceMs = 2_000;

const screenshotClip = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().positive(),
  height: z.number().positive(),
  scale: z.number().positive().default(1),
});

/**
 * A press the person holds on one page. It is complete before the press is
 * dispatched, so an agent command that ends it concurrently always knows
 * which page and point to release.
 */
interface PointerGesture {
  readonly buttons: Set<PointerButton>;
  /** Released by anything other than the person's own pointer-up. */
  ended: boolean;
  readonly surfaceId: BrowserSurfaceId;
  readonly owner: string;
  readonly generation: number;
  x: number;
  y: number;
}

export class BrowserController {
  private readonly editing: boolean;
  private readonly clipboard: ReturnType<typeof engineClipboardCoordinator> | undefined;
  private readonly observers = new Map<
    BrowserSurfaceId,
    { observer: PageEditingObserver; ready: Promise<void>; unsubscribeCapture: () => void }
  >();
  private readonly clipboardTerminals = new WeakSet<object>();
  private readonly clipboardParts = new ClipboardParts((message, outcome) =>
    this.clipboardResult(message, {
      type: "clipboard.result",
      surfaceId: message.surfaceId,
      operationId: message.operationId,
      outcome,
      ...(message.consumerToken ? { consumerToken: message.consumerToken } : {}),
    }),
  );
  private readonly menuConsumers = new Map<BrowserSurfaceId, { consumerToken: string }>();
  private readonly editingCounters: Record<string, number> = {};

  private readonly targetedCasts = new Map<
    BrowserSurfaceId,
    {
      readonly cast: ScreencastController;
      subscription: "frames" | "control";
    }
  >();
  private readonly inventoryLock = new AsyncMutex();
  private readonly openedTabs = new Map<string, { fingerprint: string; tabId: BrowserSurfaceId }>();
  private activitySequence = 0;
  private frameSequence = 0;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  /** Pages the person is closing, until the ledger has let them go. */
  private readonly closingSurfaces = new Set<BrowserSurfaceId>();
  private readonly cdpRouter: SessionCdpRouter;
  private readonly agentCommands: CommandQueue = {
    pending: 0,
    overflowReported: false,
    tail: Promise.resolve(),
  };
  private readonly viewerCommands: CommandQueue = {
    pending: 0,
    overflowReported: false,
    tail: Promise.resolve(),
  };
  private readonly disconnectPromise: Promise<void>;
  private disconnected = false;
  private releaseDisconnect: () => void = () => undefined;
  private readonly claims: BrowserAttachTicketClaims;
  private readonly exportSnapshot: () => Promise<BrowserProfileSnapshot>;
  private readonly files: SessionFiles;
  private readonly ledger: SurfaceLedger;
  private readonly maxPendingCommands: number;
  private readonly maxPendingMessageBytes: number;
  private readonly maxPendingMessages: number;
  private messageTail: Promise<void> = Promise.resolve();
  private initialSnapshotQueued = false;
  private pendingMessageBytes = 0;
  private pendingMessages = 0;
  private readonly screencast: ScreencastController;
  private readonly sink: BrowserControllerSink;
  private surfaceRevision = 0;
  /** The pages named in the latest surface list viewers were sent, and the one shown. */
  private deliveredSurfaces = new Set<BrowserSurfaceId>();
  private deliveredActive: BrowserSurfaceId | null = null;
  /** A dialog on a page no list has named yet; it follows the list that does. */
  private heldDialog: BrowserDialog | null = null;
  private surfaceSnapshotQueued = false;
  private surfaceSnapshotTail: Promise<void> = Promise.resolve();
  /** `closed` has been published; nothing else follows it. */
  private terminated = false;
  private unsubscribeCdp: (() => void) | null = null;
  private unsubscribeLedger: (() => void) | null = null;
  private readonly platform: NodeJS.Platform;
  private readonly replaceSiteCookies: BrowserControllerOptions["replaceSiteCookies"];
  private readonly signIns: HostSignIns;
  private readonly gestures = new Map<BrowserSurfaceId, PointerGesture>();
  private readonly keys = new Map<
    BrowserSurfaceId,
    Map<string, Extract<BrowserClientMessage, { type: "input.key" }>>
  >();
  private readonly keyOwners = new Map<BrowserSurfaceId, string>();
  private readonly lanes = new Map<BrowserSurfaceId, BrowserInputLane>();
  private readonly canceledGenerations = new Map<string, number>();
  private readonly cleanupReservations = new Set<string>();
  private readonly laneGeometries = new Map<BrowserSurfaceId, number>();
  /** Each actor's cursor on each page, least recently used first. */
  private readonly agentPointers = new Map<string, AgentPointer>();
  /** Orders agent pointer input against the scripts agents run. */
  private agentPointerClock = 0;
  /** How many agent scripts run in each page, and the first of them. */
  private readonly scriptRuns = new Map<BrowserSurfaceId, { running: number; first: ScriptRun }>();
  readonly releases: {
    surfaceId: BrowserSurfaceId;
    buttons: number;
    keys: number;
    outcome: "started" | "completed";
  }[] = [];

  readonly #passkeys: HostRelayAuthenticator | undefined;
  sendPasskey(message: BrowserServerMessage): Promise<void> {
    return this.send(message);
  }
  constructor(options: BrowserControllerOptions) {
    this.#passkeys = options.passkeys;
    this.disconnectPromise = new Promise<void>((resolve) => {
      this.releaseDisconnect = resolve;
    });
    this.cdpRouter = options.cdpRouter;
    this.claims = options.claims;
    this.editing =
      options.claims.editingVersion === 2 ||
      (options.claims.editingVersion === 1 && options.clipboard !== undefined);
    this.clipboard =
      options.clipboard &&
      (options.claims.editingVersion === 1 || options.claims.clipboard === true)
        ? engineClipboardCoordinator(options.clipboard)
        : undefined;
    this.exportSnapshot = options.exportSnapshot;
    this.files = options.files;
    this.ledger = options.ledger;
    this.platform = options.platform ?? process.platform;
    this.replaceSiteCookies = options.replaceSiteCookies;
    this.signIns = options.signIns;
    this.maxPendingCommands = options.maxPendingCommands ?? 128;
    this.maxPendingMessageBytes = options.maxPendingMessageBytes ?? 2 * 1_024 * 1_024;
    this.maxPendingMessages = options.maxPendingMessages ?? 128;
    if (
      !Number.isSafeInteger(this.maxPendingCommands) ||
      this.maxPendingCommands < 1 ||
      !Number.isSafeInteger(this.maxPendingMessageBytes) ||
      this.maxPendingMessageBytes < 1 ||
      !Number.isSafeInteger(this.maxPendingMessages) ||
      this.maxPendingMessages < 1
    ) {
      throw new Error("Browser queue limits must be positive safe integers.");
    }
    this.sink = options.sink;
    const frames = new LatestFrameStream(
      { sendFrame: (frame) => this.sendFrame(frame) },
      (error) => {
        void this.sendError(
          new BrowserRuntimeError("internal", "The browser frame stream stopped.", {
            cause: error,
            retryable: true,
          }),
        );
      },
    );
    this.screencast = new ScreencastController({
      frames,
      ledger: options.ledger,
      onDialogChanged: (dialog) => this.onDialogChanged(dialog),
      onError: (error) => {
        void this.sendError(error).catch(() => undefined);
      },
    });
  }

  diagnostics() {
    return [...this.lanes].map(([surfaceId, lane]) => ({
      surfaceId,
      heldButtons: this.liveGesture(surfaceId)?.buttons.size ?? 0,
      heldKeys: this.keys.get(surfaceId)?.size ?? 0,
      input: lane.diagnostics.slice(),
      editing: { ...this.editingCounters },
    }));
  }

  async start(): Promise<void> {
    if (this.closed) throw new BrowserRuntimeError("conflict", "The browser controller is closed.");
    this.unsubscribeCdp = this.cdpRouter.onEvent(this.claims.sessionId, (event) => {
      if (this.closed || !this.initialSnapshotQueued) return;
      void this.send({ event, type: "cdp.event" }).catch(() => undefined);
    });
    const publishDialog = this.cdpRouter.useDialogEvents(this.claims.sessionId);
    this.unsubscribeLedger = this.ledger.subscribe((event) => {
      if (event.type === "dialog-event") {
        publishDialog(event.targetId, event.method, event.parameters);
        return;
      }
      this.onLedgerEvent(event);
    });
    await this.screencast.start();
    this.initialSnapshotQueued = true;
    const surfaces = this.ledger.snapshot();
    this.deliveredSurfaces = new Set(surfaces.map((surface) => surface.id));
    this.deliveredActive = surfaces.find((surface) => surface.active)?.id ?? null;
    await this.send({
      access: this.claims.access,
      dialog: this.screencast.currentDialog(),
      sessionId: this.claims.sessionId,
      state: "ready",
      surfaces,
      targetedStreamingVersion: 1,
      inputLanesVersion: 1,
      ...(this.claims.navigationAttributionVersion === 1
        ? { navigationAttributionVersion: 1 }
        : {}),
      ...(this.editing
        ? {
            editingVersion: this.claims.editingVersion,
            ...(this.claims.editingVersion === 2
              ? { clipboard: this.clipboard !== undefined }
              : {}),
          }
        : {}),
      inventoryRevision: this.ledger.inventoryRevision,
      type: "browser.snapshot",
    });
    if (this.editing)
      for (const surface of surfaces) void this.editingObserver(surface.id).catch(() => undefined);
    await this.publishWorkspaceTabs();
    this.screencast.viewersShown(this.deliveredActive);
  }

  async followPresentedSurface(
    surfaceId: BrowserSurfaceId,
    size: PageSize | (() => PageSize | null),
  ): Promise<void> {
    if (this.closed) throw new BrowserRuntimeError("conflict", "The browser controller is closed.");
    await this.ledger.followViewport(surfaceId, size, () => this.prepareResize(surfaceId));
  }

  handleRaw(frame: string | Buffer): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (Buffer.byteLength(frame) > 1_100_000) {
      return this.enqueueFailure(
        new BrowserRuntimeError("bad_message", "The browser command is too large."),
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(typeof frame === "string" ? frame : frame.toString("utf8"));
    } catch {
      return this.enqueueFailure(
        new BrowserRuntimeError("bad_message", "The browser command is not valid JSON."),
      );
    }
    const parsed = BrowserClientMessageSchema.safeParse(value);
    if (!parsed.success) {
      if (this.clipboard) {
        const paste = z
          .object({
            type: z.literal("clipboard.paste-data"),
            surfaceId: BrowserSurfaceIdSchema,
            operationId: z.uuid(),
            consumerToken: z.uuid().optional(),
          })
          .safeParse(value);
        if (paste.success)
          return this.send({
            type: "clipboard.result",
            surfaceId: paste.data.surfaceId,
            operationId: paste.data.operationId,
            outcome: "too-large",
            ...(paste.data.consumerToken ? { consumerToken: paste.data.consumerToken } : {}),
          });
        const part = z
          .object({
            type: z.literal("clipboard.part"),
            producerId: z.uuid().optional(),
            part: z.object({ operationId: z.uuid() }),
          })
          .safeParse(value);
        if (part.success) {
          this.clipboardParts.reject(part.data.producerId, part.data.part.operationId);
          return Promise.resolve();
        }
      }
      return this.enqueueFailure(
        new BrowserRuntimeError("bad_message", "The browser command is invalid."),
      );
    }
    if (parsed.data.type === "passkey.result") {
      this.#passkeys?.result(this.claims.sessionId, parsed.data);
      return Promise.resolve();
    }
    return this.enqueue(parsed.data);
  }

  handle(message: BrowserClientMessage): Promise<void> {
    if (this.closed) return Promise.resolve();
    const parsed = BrowserClientMessageSchema.safeParse(message);
    if (!parsed.success) {
      return this.enqueueFailure(
        new BrowserRuntimeError("bad_message", "The browser command is invalid."),
      );
    }
    if (parsed.data.type === "passkey.result") {
      this.#passkeys?.result(this.claims.sessionId, parsed.data);
      return Promise.resolve();
    }
    return this.enqueue(parsed.data);
  }

  browserDisconnected(): void {
    this.#passkeys?.disconnect(this.claims.sessionId);
    if (this.disconnected) return;
    this.disconnected = true;
    this.screencast.abort();
    for (const { cast } of this.targetedCasts.values()) cast.abort();
    this.targetedCasts.clear();
    this.releaseDisconnect();
  }

  close(): Promise<void> {
    this.#passkeys?.disconnect(this.claims.sessionId);
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  /**
   * Never waits for an agent command: one can wait in its page without end,
   * such as a script awaiting the person's click. The Runtime ends the
   * session's CDP routing and closes its pages, which fails it; nothing is
   * sent after `closed`. The person's commands already admitted finish first,
   * unless Chrome stops answering them.
   */
  private async closeOnce(): Promise<void> {
    for (const { cast } of this.targetedCasts.values()) void cast.close().catch(() => undefined);
    this.targetedCasts.clear();
    if (this.closed) return;
    this.clipboardParts.cancel();
    this.clipboard?.invalidate();
    await this.clipboard?.finish().catch(() => undefined);
    await Promise.all(
      [...this.observers.values()].map((entry) => {
        entry.unsubscribeCapture();
        return entry.observer.close();
      }),
    );
    this.observers.clear();
    this.closed = true;
    this.unsubscribeCdp?.();
    this.unsubscribeCdp = null;
    this.unsubscribeLedger?.();
    this.unsubscribeLedger = null;
    await Promise.race([
      Promise.all([...this.lanes.values()].map((lane) => lane.idle())).then(async () => {
        for (const surfaceId of this.lanes.keys()) await this.releaseSurface(surfaceId);
      }),
      this.disconnectPromise,
      delay(closeGraceMs),
    ]);
    await this.send({ state: "closing", type: "browser.status" }).catch(() => undefined);
    if (!this.disconnected) {
      await Promise.race([
        this.screencast.close().catch(() => undefined),
        this.disconnectPromise,
        delay(closeGraceMs),
      ]);
    }
    this.terminated = true;
    await this.send({ state: "closed", type: "browser.status" }).catch(() => undefined);
  }

  private enqueue(message: BrowserClientMessage): Promise<void> {
    if (
      (message.type === "navigation.go" || message.type === "cdp.command") &&
      message.navigationId !== undefined &&
      this.claims.navigationAttributionVersion !== 1
    )
      return this.enqueueFailure(
        new BrowserRuntimeError("forbidden", "Browser navigation attribution was not negotiated."),
      );
    const extension =
      editingMessageKinds.has(message.type) ||
      (message.type === "input.key" &&
        (message.modifiers.includes("primary") ||
          message.location !== undefined ||
          message.repeat !== undefined));
    if (!this.editing && extension)
      return this.enqueueFailure(
        new BrowserRuntimeError("forbidden", "Browser editing was not negotiated."),
      );
    if (
      !this.clipboard &&
      (message.type === "clipboard.copy" ||
        message.type === "clipboard.cut" ||
        message.type === "clipboard.paste-data" ||
        message.type === "clipboard.part")
    )
      return this.enqueueFailure(
        new BrowserRuntimeError("forbidden", "The engine clipboard was not negotiated."),
      );
    if (this.editing && message.type === "clipboard.part") {
      this.clipboardParts.part(message);
      return Promise.resolve();
    }
    if (
      this.editing &&
      message.type === "clipboard.paste-data" &&
      !this.clipboardParts.stage(message)
    )
      return Promise.resolve();
    if (message.type === "stream.demand")
      return (
        this.targetedCasts.get(message.surfaceId)?.cast.setRasterDemand(message.density) ??
        Promise.resolve()
      );
    if (message.type === "cdp.command") this.clipboard?.invalidate();

    if (
      message.type === "surface.activate" ||
      message.type === "stream.subscribe" ||
      message.type === "stream.unsubscribe"
    ) {
      // Selecting or retaining a page cannot wait behind the input that opened
      // its dialog. Selection cancels the departing producer's pending work;
      // input admitted earlier already names its original surface.
      return this.run(message, this.pageOf(message));
    }
    if (
      message.type === "cdp.command" &&
      Object.values(browserHostMethods).some((method) => method === message.command.method)
    )
      return this.run(message);
    if (message.type === "cdp.command" && message.command.method === "Target.detachFromTarget") {
      // Detach ends the router channel and releases commands still waiting in it.
      const producer = inputProducer(message);
      for (const [surfaceId, lane] of this.lanes) {
        lane.cancel((entry) => inputProducer(entry) === producer);
        void lane.enqueue({ type: "input.cancel", producerId: producer }, true);
        if (
          this.liveGesture(surfaceId)?.owner === producer ||
          this.keyOwners.get(surfaceId) === producer
        )
          void lane.idle().catch(() => undefined);
      }
      return this.run(message);
    }
    if (message.type === "dialog.respond" || isDialogAnswer(message)) {
      // An open dialog stops its page from answering anything else, a size
      // write or a click included; an answer never waits behind what it frees.
      return this.run(message);
    }
    if (
      message.type === "cdp.command" &&
      message.command.method === "Target.closeTarget" &&
      this.pageOf(message) &&
      this.ledger.dialogOpen(this.pageOf(message)!)
    )
      return this.run(message, this.pageOf(message));
    if (message.type === "surface.close" && this.ledger.dialogOpen(message.surfaceId))
      return this.run(message, message.surfaceId);
    if (
      message.type === "navigation.stop" ||
      (message.type === "cdp.command" && message.command.method === "Page.stopLoading")
    )
      return this.run(message, this.pageOf(message));
    if (message.type === "input.cancel") return this.cancelProducer(message);
    const surfaceId = this.pageOf(message);
    // Resolve implicit targets now: a later activation cannot retarget admitted work.
    if (surfaceId && (!isCdpRequest(message) || isOrderedAgentMutation(message))) {
      const lane = this.inputLane(surfaceId);
      const reservation = this.reservation(message, surfaceId);
      const release = isInputRelease(message);
      const cleanup = release && reservation !== null && this.cleanupReservations.has(reservation);
      if (release && !cleanup)
        return isCdpRequest(message)
          ? this.send({ type: "cdp.result", requestId: message.requestId, result: {} })
          : Promise.resolve();
      if (
        this.ledger.dialogOpen(surfaceId) &&
        !cleanup &&
        (message.type.startsWith("input.") ||
          message.type === "clipboard.paste" ||
          message.type.startsWith("navigation."))
      )
        return this.refuseInput(message, "browser-input-dialog");
      const producer = inputProducer(message);
      if (
        message.inputGeneration !== undefined &&
        message.inputGeneration <= (this.canceledGenerations.get(producer) ?? -1) &&
        !cleanup
      )
        return this.refuseInput(message, "browser-input-canceled");
      // A distinct physical press reserves exactly one release outside ordinary capacity.
      if (reservation && !release && !this.cleanupReservations.has(reservation)) {
        if (this.cleanupReservations.size >= 128)
          return this.refuseInput(message, "browser-input-overload");
        this.cleanupReservations.add(reservation);
      }
      return lane.enqueue(message, cleanup).finally(() => {
        if (release && reservation) this.cleanupReservations.delete(reservation);
      });
    }
    const queue = isCdpRequest(message) ? this.agentCommands : this.viewerCommands;
    return this.enqueueOperation(queue, () => ({ done: this.run(message, surfaceId), surfaceId }));
  }

  private inputLane(surfaceId: BrowserSurfaceId): BrowserInputLane {
    let lane = this.lanes.get(surfaceId);
    if (!lane) {
      if (this.lanes.size >= 128)
        throw new BrowserRuntimeError("conflict", "Too many browser input surfaces.");
      lane = new BrowserInputLane(
        this.maxPendingCommands,
        (message) => this.run(message, surfaceId),
        (message, reason) => this.refuseInput(message, reason),
        surfaceId,
      );
      this.lanes.set(surfaceId, lane);
      this.laneGeometries.set(
        surfaceId,
        this.ledger.binding(surfaceId)?.surface.geometryRevision ?? 0,
      );
    }
    return lane;
  }

  private reservation(message: BrowserClientMessage, surfaceId: BrowserSurfaceId): string | null {
    if (message.type === "cdp.command") {
      const p = message.command.parameters;
      if (
        message.command.method === "Input.dispatchMouseEvent" &&
        (p?.type === "mousePressed" || p?.type === "mouseReleased") &&
        typeof p.button === "string"
      )
        return JSON.stringify([
          surfaceId,
          inputProducer(message),
          message.inputGeneration ?? 0,
          p.button,
        ]);
      if (
        message.command.method === "Input.dispatchKeyEvent" &&
        (p?.type === "keyDown" || p?.type === "rawKeyDown" || p?.type === "keyUp") &&
        typeof p.code === "string"
      )
        return JSON.stringify([
          surfaceId,
          inputProducer(message),
          message.inputGeneration ?? 0,
          p.code,
        ]);
      return null;
    }
    if (message.type !== "input.pointer" && message.type !== "input.key") return null;
    if (message.type === "input.pointer" && message.action === "move") return null;
    return JSON.stringify([
      surfaceId,
      inputProducer(message),
      message.inputGeneration ?? 0,
      message.type === "input.pointer" ? message.button : message.code,
    ]);
  }

  private clipboardResult(
    message: object,
    result: Extract<BrowserServerMessage, { type: "clipboard.result" }>,
  ): Promise<void> {
    if (this.clipboardTerminals.has(message)) return Promise.resolve();
    this.clipboardTerminals.add(message);
    return this.send(result);
  }

  private refuseClipboard(
    message: BrowserClientMessage,
    outcome: "refused" | "stale" = "refused",
  ): Promise<void> {
    if (
      message.type !== "clipboard.copy" &&
      message.type !== "clipboard.cut" &&
      message.type !== "clipboard.paste-data"
    )
      return Promise.resolve();
    if (message.type === "clipboard.paste-data") this.clipboardParts.discard(message);
    return this.clipboardResult(message, {
      type: "clipboard.result",
      surfaceId: message.surfaceId,
      operationId: message.operationId,
      outcome,
      ...(message.consumerToken ? { consumerToken: message.consumerToken } : {}),
    });
  }

  private async refuseInput(message: BrowserClientMessage, reason: string): Promise<void> {
    if (!isInputRelease(message)) {
      const surfaceId = this.pageOf(message);
      const reservation = surfaceId ? this.reservation(message, surfaceId) : null;
      const held =
        surfaceId &&
        (this.liveGesture(surfaceId)?.owner === inputProducer(message) ||
          this.keyOwners.get(surfaceId) === inputProducer(message));
      const pending =
        surfaceId &&
        this.lanes
          .get(surfaceId)
          ?.contains((entry) => this.reservation(entry, surfaceId) === reservation);
      if (reservation && !held && !pending) this.cleanupReservations.delete(reservation);
    }
    await this.refuseClipboard(message);
    const error = new BrowserRuntimeError(
      "conflict",
      "Browser input was not applied. Try the action again.",
      { reason },
    );
    if (isCdpRequest(message)) {
      await this.send({
        type: "cdp.error",
        requestId: message.requestId,
        error: error.toProtocolError(),
      });
    } else
      await this.send({
        type: "browser.error",
        error: error.toProtocolError(),
        ...(message.producerId ? { producerId: message.producerId } : {}),
        ...(message.inputSequence === undefined ? {} : { inputSequence: message.inputSequence }),
        ...(message.inputSequenceStart === undefined
          ? {}
          : { inputSequenceStart: message.inputSequenceStart }),
        ...(message.inputGeneration === undefined
          ? {}
          : { inputGeneration: message.inputGeneration }),
      });
  }

  private async cancelProducer(
    message: Extract<BrowserClientMessage, { type: "input.cancel" }>,
  ): Promise<void> {
    const producer = inputProducer(message);
    this.clipboardParts.cancel(message.producerId);
    this.canceledGenerations.set(producer, message.inputGeneration ?? 0);
    if (this.canceledGenerations.size > 256)
      this.canceledGenerations.delete(this.canceledGenerations.keys().next().value!);
    await Promise.all(
      [...this.lanes].map(async ([surfaceId, lane]) => {
        if (message.surfaceId && message.surfaceId !== surfaceId) return;
        const concerned =
          lane.contains((entry) => inputProducer(entry) === producer) ||
          this.liveGesture(surfaceId)?.owner === producer ||
          this.keyOwners.get(surfaceId) === producer;
        lane.cancel((entry) => inputProducer(entry) === producer);
        if (concerned) await lane.enqueue(message, true);
      }),
    );
  }

  private enqueueFailure(error: BrowserRuntimeError): Promise<void> {
    return this.sendError(error);
  }

  /**
   * Runs operations one at a time. A page under a JavaScript dialog answers
   * nothing until the dialog closes, so an operation waiting on that page lets
   * the next one start once the dialog opens: what it sent already reached the
   * page in order, and it still counts against the queue until it finishes.
   */
  private enqueueOperation(queue: CommandQueue, start: () => QueuedOperation): Promise<void> {
    if (queue.pending >= this.maxPendingCommands) return this.reportQueueOverflow(queue);
    queue.pending += 1;
    const started = queue.tail.then(start);
    queue.tail = started
      .then(({ done, surfaceId }) => this.untilDialog(surfaceId, done))
      .catch(() => undefined);
    const operation = started.then(({ done }) => done);
    void operation
      .catch(() => undefined)
      .finally(() => {
        queue.pending -= 1;
        if (queue.pending < this.maxPendingCommands) queue.overflowReported = false;
      });
    return operation;
  }

  /**
   * Dispatches one message and reports its failure to whoever sent it. A
   * person's command to a page that is closing or closed has nothing to tell
   * them: a view reports its size for a tab it just closed, and a click held
   * under a dialog fails as they close its tab.
   */
  private async run(
    message: BrowserClientMessage,
    surfaceId: BrowserSurfaceId | null = null,
  ): Promise<void> {
    try {
      await this.dispatch(message, surfaceId);
    } catch (error) {
      await this.refuseClipboard(message);
      const normalized = normalizeControllerError(error);
      const reservation = surfaceId ? this.reservation(message, surfaceId) : null;
      if (
        reservation &&
        !isInputRelease(message) &&
        surfaceId &&
        !this.ownsHeldPress(surfaceId, message) &&
        !this.lanes
          .get(surfaceId)
          ?.contains(
            (entry) => entry !== message && this.reservation(entry, surfaceId) === reservation,
          )
      )
        this.cleanupReservations.delete(reservation);
      if (process.env.OPENSTEER_BROWSER_DIAGNOSTICS === "1")
        console.info(
          JSON.stringify({
            browserInputFailure: true,
            type: message.type,
            method: message.type === "cdp.command" ? message.command.method : undefined,
            producer: inputProducer(message),
            reason: normalized.toProtocolError().reason,
            code: normalized.toProtocolError().code,
          }),
        );
      if (isCdpRequest(message)) {
        await this.send({
          error: normalized.toProtocolError(),
          requestId: message.requestId,
          type: "cdp.error",
        });
        return;
      }
      if (surfaceId && (this.closingSurfaces.has(surfaceId) || !this.ledger.binding(surfaceId))) {
        return;
      }
      await this.send({
        type: "browser.error",
        error: normalized.toProtocolError(),
        ...(message.producerId ? { producerId: message.producerId } : {}),
        ...(message.inputSequence === undefined ? {} : { inputSequence: message.inputSequence }),
        ...(message.inputSequenceStart === undefined
          ? {}
          : { inputSequenceStart: message.inputSequenceStart }),
      });
    }
  }

  /** The page a message sends its command to, when it sends one. */
  private pageOf(message: BrowserClientMessage): BrowserSurfaceId | null {
    switch (message.type) {
      case "cdp.command": {
        const closing =
          message.command.method === "Target.closeTarget"
            ? message.command.parameters?.targetId
            : null;
        if (typeof closing === "string") return this.ledger.surfaceIdForTarget(closing) ?? null;
        const sessionId = message.command.sessionId;
        const targetId =
          sessionId === undefined
            ? null
            : this.cdpRouter.attachedTargetId(this.claims.sessionId, sessionId);
        return targetId ? (this.ledger.surfaceIdForTarget(targetId) ?? null) : null;
      }
      case "surface.activate":
      case "surface.close":
      case "stream.subscribe":
      case "stream.unsubscribe":
      case "dialog.respond":
        return message.surfaceId ?? this.ledger.active()?.surface.id ?? null;
      case "input.command":
      case "input.compose":
      case "input.text":
      case "clipboard.copy":
      case "clipboard.cut":
      case "clipboard.paste-data":
      case "clipboard.paste":
      case "input.key":
        return message.targeted ? message.surfaceId : (this.ledger.active()?.surface.id ?? null);
      case "input.pointer":
      case "input.wheel":
      case "viewport.follow":
      case "viewport.set":
        return message.surfaceId;
      case "navigation.back":
      case "navigation.forward":
      case "navigation.go":
      case "navigation.reload":
      case "navigation.stop":
        return message.surfaceId ?? this.ledger.active()?.surface.id ?? null;
      default:
        return null;
    }
  }

  /**
   * Waits for `operation` until it settles or the page shows a JavaScript
   * dialog, whichever comes first.
   */
  private async untilDialog(
    surfaceId: BrowserSurfaceId | null,
    operation: Promise<unknown>,
  ): Promise<void> {
    if (!surfaceId) {
      await operation;
      return;
    }
    let stop: () => void = () => undefined;
    const opened = new Promise<void>((resolve) => {
      if (this.ledger.dialogOpen(surfaceId)) {
        resolve();
        return;
      }
      const unsubscribe = this.ledger.subscribe((event) => {
        if (
          event.type === "dialog" &&
          event.surfaceId === surfaceId &&
          this.ledger.dialogOpen(surfaceId)
        ) {
          resolve();
        }
      });
      stop = () => {
        unsubscribe();
      };
    });
    try {
      await Promise.race([operation, opened]);
    } finally {
      stop();
    }
  }

  private inputGeometryError(
    message: Extract<BrowserClientMessage, { type: "input.pointer" | "input.wheel" }>,
  ): BrowserRuntimeError {
    const binding = this.ledger.binding(message.surfaceId);
    const capture = binding?.page.capture?.read();
    const layout = this.ledger.viewportOf(message.surfaceId);
    return new BrowserRuntimeError("conflict", "The browser picture changed.", {
      reason:
        message.captureRevision === undefined &&
        capture &&
        layout &&
        (message.geometryRevision === undefined ||
          message.geometryRevision === binding?.surface.geometryRevision) &&
        (capture.width < layout.width || capture.height < layout.height)
          ? "browser-capture-region-unsupported"
          : "browser-input-stale-geometry",
    });
  }

  private reportQueueOverflow(queue: CommandQueue): Promise<void> {
    if (queue.overflowReported) return Promise.resolve();
    queue.overflowReported = true;
    return this.sendError(
      new BrowserRuntimeError("conflict", "The browser command queue is full.", {
        retryable: true,
      }),
    );
  }

  private dispatch(
    message: BrowserClientMessage,
    admittedSurface: BrowserSurfaceId | null,
  ): Promise<void> {
    const mutatesInventory =
      message.type === "surface.open" ||
      message.type === "surface.close" ||
      (message.type === "cdp.command" &&
        [
          "Target.createTarget",
          "Target.closeTarget",
          browserHostMethods.closeTab,
          browserHostMethods.openTab,
        ].includes(message.command.method));
    return mutatesInventory
      ? this.inventoryLock.run(() => this.dispatchUnlocked(message, admittedSurface))
      : this.dispatchUnlocked(message, admittedSurface);
  }

  private async dispatchUnlocked(
    message: BrowserClientMessage,
    admittedSurface: BrowserSurfaceId | null,
  ): Promise<void> {
    await this.clipboard?.finish();
    if (admittedSurface && !(message.type === "input.pointer" && message.button === "right"))
      this.menuConsumers.delete(admittedSurface);
    if (this.editing)
      this.editingCounters[message.type] = (this.editingCounters[message.type] ?? 0) + 1;
    if (message.type === "input.cancel") {
      this.clipboardParts.cancel(message.producerId);
      if (admittedSurface) await this.releaseSurface(admittedSurface, inputProducer(message));
      return;
    }
    if (
      admittedSurface &&
      (message.type.startsWith("input.") ||
        message.type.startsWith("clipboard.") ||
        (message.type === "cdp.command" && message.command.method.startsWith("Input.")))
    ) {
      await this.admitOwner(admittedSurface, message);
    }
    if (
      message.type === "input.pointer" ||
      message.type === "input.wheel" ||
      message.type === "input.key"
    )
      this.ledger.recordLegacyPersonActivity(message.targeted === true);
    if (
      this.ledger.sealed &&
      (message.type === "surface.open" ||
        message.type === "surface.close" ||
        (message.type === "cdp.command" &&
          [
            "Target.createTarget",
            "Target.closeTarget",
            browserHostMethods.closeTab,
            browserHostMethods.openTab,
          ].includes(message.command.method)))
    )
      throw new BrowserRuntimeError("conflict", "The browser session is closing.", {
        reason: browserTabOpenClosedReason,
      });
    if (
      message.type === "cdp.command" &&
      Object.values(browserHostMethods).some((method) => method === message.command.method)
    ) {
      await this.dispatchHostRead(message);
      return;
    }
    if (message.type === "stream.ack") {
      throw new BrowserRuntimeError(
        "bad_message",
        "Watch frame acknowledgements terminate at the Host.",
      );
    }
    if (message.type === "cdp.command" && message.command.method === stageFileMethod) {
      if (message.command.sessionId !== undefined) {
        throw new BrowserRuntimeError(
          "bad_message",
          `${stageFileMethod} belongs to the Browser Session, not to one page.`,
        );
      }
      await this.send({
        requestId: message.requestId,
        result: await this.files.stage(message.command.parameters),
        type: "cdp.result",
      });
      return;
    }
    if (message.type === "cdp.command" && message.command.method === "Opensteer.fillLogin") {
      const params = z
        .strictObject({ loginRef: LoginRefSchema, field: LoginFieldSchema })
        .safeParse(message.command.parameters);
      const targetId =
        message.command.sessionId === undefined
          ? null
          : this.cdpRouter.attachedTargetId(this.claims.sessionId, message.command.sessionId);
      if (!params.success || !targetId) {
        throw new BrowserRuntimeError(
          "bad_message",
          "fillLogin requires valid parameters and an attached page session.",
        );
      }
      if (this.claims.access !== "full-control") {
        throw new BrowserRuntimeError("forbidden", "Filling a login requires full-control access.");
      }
      this.ledger.recordAgentCommand(targetId);
      const status = await this.signIns.fill({
        ...params.data,
        targetId,
        sessionId: this.claims.sessionId,
      });
      await this.send({ type: "cdp.result", requestId: message.requestId, result: { status } });
      return;
    }
    if (message.type === "cdp.command") {
      await this.dispatchAgentCommand(message);
      return;
    }
    if (message.type === "viewport.follow" || message.type === "viewport.set") {
      // Sizes the one page it names; every other page keeps its size. A write
      // that changes nothing there ends no press and restarts no stream.
      const size = { height: message.height, width: message.width };
      const release = () => this.prepareResize(message.surfaceId);
      await (message.type === "viewport.follow"
        ? this.ledger.followViewport(message.surfaceId, size, release)
        : this.ledger.fitViewport(message.surfaceId, size, release));
      return;
    }
    if (message.type === "stream.subscribe" || message.type === "stream.unsubscribe") {
      if (message.surfaceId) {
        const surfaceId = message.surfaceId;
        let target = this.targetedCasts.get(surfaceId);
        if (message.type === "stream.unsubscribe") {
          this.targetedCasts.delete(surfaceId);
          await target?.cast.close();
          return;
        }
        if (!this.ledger.binding(surfaceId))
          throw new BrowserRuntimeError("not_found", "The browser surface does not exist.");
        const subscription = message.frames === false ? "control" : "frames";
        if (
          subscription === "frames" &&
          target?.subscription !== "frames" &&
          [...this.targetedCasts.values()].filter((target) => target.subscription === "frames")
            .length >= browserCaptureMaxTargets
        )
          throw new BrowserRuntimeError("conflict", "Too many browser capture targets.", {
            reason: "browser-capture-limit",
          });
        const previous = target?.subscription;
        if (!target) {
          target = {
            subscription,
            cast: new ScreencastController({
              frames: new LatestFrameStream({
                sendFrame: (frame) =>
                  this.targetedCasts.get(surfaceId)?.subscription === "frames"
                    ? this.sendFrame(frame)
                    : Promise.resolve(),
              }),
              ledger: this.ledger,
              onError: (error) => {
                void this.sendError(error).catch(() => undefined);
              },
              surfaceId,
              onDialogChanged: (dialog) => {
                void this.send({ type: "browser.dialog.changed", surfaceId, dialog }).catch(
                  () => undefined,
                );
              },
            }),
          };
        }
        // Reserve capacity before binding; a failed transition restores its old subscription.
        this.targetedCasts.set(surfaceId, target);
        target.subscription = subscription;
        try {
          if (!previous) await target.cast.start();
          await target.cast.setStreaming(subscription === "frames", message.captureRegion === true);
          if (previous)
            await this.send({
              type: "browser.dialog.changed",
              surfaceId,
              dialog: target.cast.currentDialog(),
            });
        } catch (error) {
          if (previous) {
            target.subscription = previous;
            try {
              await target.cast.setStreaming(previous === "frames");
            } catch (rollback) {
              throw new AggregateError([error, rollback], "Browser subscription rollback failed.");
            }
          } else {
            this.targetedCasts.delete(surfaceId);
            target.cast.abort();
          }
          throw error;
        }
      } else
        await this.screencast.setStreaming(
          message.type === "stream.subscribe",
          message.type === "stream.subscribe" && message.captureRegion === true,
        );
      return;
    }
    if (message.type === "surface.activate") {
      this.releaseDepartingInput(message, message.surfaceId);
      await this.ledger.activate(message.surfaceId);
      return;
    }
    if (message.type === "surface.close") {
      if (this.ledger.snapshot().length <= 1) {
        throw new BrowserRuntimeError("conflict", "The final browser surface cannot be closed.");
      }
      if (!this.ledger.dialogOpen(message.surfaceId)) await this.prepareResize(message.surfaceId);
      this.closingSurfaces.add(message.surfaceId);
      try {
        await this.ledger.closeSurface(message.surfaceId);
      } finally {
        this.closingSurfaces.delete(message.surfaceId);
      }
      return;
    }
    if (message.type === "state.export") {
      // Reading the live context state is a privileged read of everything the
      // session is signed into, so a view-only attachment cannot ask for it.
      if (this.claims.access !== "full-control") {
        throw new BrowserRuntimeError(
          "forbidden",
          "Exporting browser state requires full-control access.",
        );
      }
      await this.send({
        snapshot: await this.exportSnapshot(),
        type: "state.exported",
      });
      return;
    }
    if (message.type === "state.import") {
      await this.importSiteState(message);
      return;
    }
    if (
      message.type === "signin.probe" ||
      message.type === "login.authorize" ||
      message.type === "login.cancel"
    ) {
      this.handleSignIn(message);
      return;
    }
    if (message.type === "surface.open") {
      const url = message.url === undefined ? undefined : safeNavigationUrl(message.url);
      this.releaseDepartingInput(message);
      const opened = await this.ledger.openSurface(
        message.viewport
          ? {
              viewport: {
                devicePixelRatio: 1,
                height: message.viewport.height,
                width: message.viewport.width,
              },
            }
          : {},
      );
      if (url !== undefined) {
        const binding = this.ledger.binding(opened.id);
        this.ledger.recordHumanActivity(opened.id, { kind: "navigation" });
        void binding?.cdp.send("Page.navigate", { url }).catch(() => undefined);
      }
      return;
    }

    const active = admittedSurface ? this.ledger.binding(admittedSurface) : this.ledger.active();
    if (!active) {
      if (message.type === "input.pointer" || message.type === "input.wheel") return;
      throw new BrowserRuntimeError("conflict", "There is no active browser surface.");
    }
    const cdp = active.cdp;
    if (
      this.editing &&
      (message.type === "input.command" ||
        message.type === "input.compose" ||
        message.type === "input.text" ||
        message.type === "clipboard.copy" ||
        message.type === "clipboard.cut" ||
        message.type === "clipboard.paste-data")
    ) {
      if (message.surfaceId !== active.surface.id) {
        if (message.type === "clipboard.paste-data") this.clipboardParts.discard(message);
        if (
          message.type === "clipboard.copy" ||
          message.type === "clipboard.cut" ||
          message.type === "clipboard.paste-data"
        )
          await this.clipboardResult(message, {
            type: "clipboard.result",
            surfaceId: message.surfaceId,
            operationId: message.operationId,
            outcome: "stale",
            ...(message.consumerToken ? { consumerToken: message.consumerToken } : {}),
          });
        return;
      }
      const observer = await this.editingObserver(active.surface.id);
      this.ledger.recordHumanActivity(active.surface.id, { kind: "typing" });
      if (message.type === "input.compose" || message.type === "input.text") {
        if (
          !(await observer.edit(
            message.type === "input.compose" ? message.composition : message.edit,
            message.type === "input.compose",
            () => this.recordPasskeyInput(message, active.surface.id),
          ))
        )
          this.editingCounters.stale = (this.editingCounters.stale ?? 0) + 1;
        return;
      }
      if (message.type === "input.command") {
        if (message.consumerToken && !this.scriptRuns.has(active.surface.id))
          await this.clipboard?.begin(active.page, (items) =>
            publishClipboardItems(
              pageClipboardWrite(active.surface.id, message.consumerToken!),
              items,
              (m) => this.send(m),
            ),
          );
        await observer.input(() => {
          this.recordPasskeyInput(message, active.surface.id);
          return cdp.send(
            "Input.dispatchKeyEvent",
            editingCommandParameters(message.command, this.platform),
          );
        });
        return;
      }
      const outcome = (result: "refused" | "pasted" | "empty" | "too-large") =>
        this.clipboardResult(message, {
          type: "clipboard.result",
          surfaceId: active.surface.id,
          operationId: message.operationId,
          outcome: result,
          ...(message.consumerToken ? { consumerToken: message.consumerToken } : {}),
        });
      if (message.type !== "clipboard.paste-data" && (await observer.sensitive())) {
        await outcome("refused");
        return;
      }
      const input =
        message.type === "clipboard.paste-data" ? await this.clipboardParts.take(message) : null;
      if (message.type === "clipboard.paste-data" && input === null) return;
      const command =
        message.type === "clipboard.paste-data"
          ? "paste"
          : message.type === "clipboard.copy"
            ? "copy"
            : "cut";
      try {
        const result = await this.clipboard!.run(active.page, input, () =>
          observer.input(() => {
            this.recordPasskeyInput(message, active.surface.id);
            return cdp.send(
              "Input.dispatchKeyEvent",
              editingCommandParameters(command, this.platform),
            );
          }),
        );
        if (command === "paste") await outcome("pasted");
        else
          await publishClipboardItems(
            {
              type: "clipboard.result",
              surfaceId: active.surface.id,
              operationId: message.operationId,
              outcome: command === "copy" ? "copied" : "cut",
              ...(message.consumerToken ? { consumerToken: message.consumerToken } : {}),
            },
            result.written,
            (m) =>
              m.type === "clipboard.result" ? this.clipboardResult(message, m) : this.send(m),
          );
      } catch (error) {
        await outcome(
          error instanceof BrowserRuntimeError &&
            error.toProtocolError().reason === "clipboard-too-large"
            ? "too-large"
            : "refused",
        );
      }
      return;
    }
    if (
      this.editing &&
      ((message.type === "input.key" && message.action === "down") ||
        (message.type === "input.pointer" && message.action === "up"))
    ) {
      if (message.consumerToken && !this.scriptRuns.has(active.surface.id))
        await this.clipboard?.begin(active.page, (items) =>
          publishClipboardItems(
            pageClipboardWrite(active.surface.id, message.consumerToken!),
            items,
            (m) => this.send(m),
          ),
        );
    }
    if (
      this.editing &&
      message.type === "input.pointer" &&
      message.action === "down" &&
      message.button === "right" &&
      message.consumerToken
    )
      this.menuConsumers.set(active.surface.id, { consumerToken: message.consumerToken });

    if (message.type === "navigation.go") {
      this.ledger.recordHumanActivity(active.surface.id, { kind: "navigation" });
      await this.ledger.navigate(
        active.surface.id,
        safeNavigationUrl(message.url),
        message.navigationId,
      );
      return;
    }
    if (message.type === "navigation.reload") {
      if (message.ignoreCache !== undefined && this.claims.navigationVersion !== 1)
        throw new BrowserRuntimeError(
          "conflict",
          "This session does not support cache-bypassing reload.",
        );
      this.ledger.recordHumanActivity(active.surface.id, { kind: "navigation" });
      await cdp.send("Page.reload", { ignoreCache: message.ignoreCache === true });
      return;
    }
    if (message.type === "navigation.stop") {
      this.ledger.recordHumanActivity(active.surface.id, { kind: "navigation" });
      await cdp.send("Page.stopLoading");
      return;
    }
    if (message.type === "navigation.back" || message.type === "navigation.forward") {
      const history = await cdp.send<{
        currentIndex?: unknown;
        entries?: Array<{ id?: unknown }>;
      }>("Page.getNavigationHistory");
      const currentIndex = Number.isInteger(history.currentIndex)
        ? (history.currentIndex as number)
        : -1;
      const nextIndex = currentIndex + (message.type === "navigation.back" ? -1 : 1);
      const entryId = history.entries?.[nextIndex]?.id;
      if (!Number.isInteger(entryId)) {
        throw new BrowserRuntimeError(
          "conflict",
          "There is no browser history entry in that direction.",
        );
      }
      this.ledger.recordHumanActivity(active.surface.id, { kind: "navigation" });
      await cdp.send("Page.navigateToHistoryEntry", { entryId });
      return;
    }
    if (message.type === "input.pointer") {
      await this.dispatchPointer(message);
      return;
    }
    if (message.type === "input.wheel") {
      if (Math.abs(message.deltaX) > 100_000 || Math.abs(message.deltaY) > 100_000) {
        throw new BrowserRuntimeError("bad_message", "The browser wheel delta is too large.");
      }
      // Pointer input lands on the page whose frame the person aimed at;
      // resolvePoint refuses any other page or a stale size.
      const binding = this.ledger.binding(message.surfaceId);
      if (!binding) return;
      const point = (
        this.targetedCasts.get(message.surfaceId)?.cast ?? this.screencast
      ).resolvePoint(
        message.surfaceId,
        message.x,
        message.y,
        message.viewportWidth,
        message.viewportHeight,
        message.captureRevision,
        message.geometryRevision,
      );
      if (!point && message.geometryRevision === undefined && !binding.page.capture) return;
      if (
        !point ||
        (message.geometryRevision !== undefined &&
          binding.surface.geometryRevision !== message.geometryRevision)
      )
        throw this.inputGeometryError(message);
      this.ledger.recordHumanActivity(message.surfaceId, {
        kind: "scroll",
        x: point.x,
        y: point.y,
      });
      const gesture = this.liveGesture(message.surfaceId);
      if (gesture) {
        gesture.x = point.x;
        gesture.y = point.y;
      }
      this.recordPasskeyInput(message, message.surfaceId);
      await binding.cdp.send("Input.dispatchMouseEvent", {
        button: "none",
        buttons: pressedButtonMask(gesture?.buttons ?? noButtons),
        modifiers: editingModifiers(message.modifiers ?? [], this.platform, !this.editing),
        deltaX: message.deltaX,
        deltaY: message.deltaY,
        type: "mouseWheel",
        x: point.x,
        y: point.y,
      });
      return;
    }
    if (message.type === "input.key") {
      // Remote input that names a surface the session has moved on from is
      // discarded in silence, exactly as a stale pointer or wheel event is.
      if (message.surfaceId !== active.surface.id) return;
      if (message.action === "down")
        this.ledger.recordHumanActivity(message.surfaceId, { kind: "typing" });
      // Cut mutates the page as the key lands, so the selection is captured
      // before dispatch and published after — the page always sees the chord.
      const selection =
        !this.clipboard && isCopyChord(message) ? await this.readSelection(cdp) : null;
      const resolved = keyEventParameters(message);
      const modifiers = editingModifiers(message.modifiers, this.platform, !this.editing);
      const commands =
        this.platform === "darwin" && message.action === "down"
          ? cocoaKeyCommands(message.key, modifiers)
          : undefined;
      // windowsVirtualKeyCode is Chromium's cross-platform key identity.
      // nativeVirtualKeyCode is deliberately absent: it is interpreted in the
      // host OS's own keycode namespace, where a Windows VK number can name a
      // completely different key and fire arbitrary browser-level shortcuts.
      let keys = this.keys.get(message.surfaceId);
      if (!keys) {
        keys = new Map();
        this.keys.set(message.surfaceId, keys);
      }
      if (message.action === "down") {
        keys.set(message.code, message);
        this.keyOwners.set(message.surfaceId, inputProducer(message));
      }
      const dispatch = () => {
        this.recordPasskeyInput(message, message.surfaceId);
        return cdp.send("Input.dispatchKeyEvent", {
          code: message.code,
          key: message.key,
          modifiers,
          ...(commands ? { commands } : {}),
          ...(this.editing
            ? {
                autoRepeat: message.repeat ?? false,
                location: message.location ?? 0,
                isKeypad: message.location === 3,
              }
            : {}),
          ...resolved,
        });
      };
      if (this.editing) await (await this.editingObserver(active.surface.id)).input(dispatch);
      else await dispatch();
      if (message.action === "up") {
        keys.delete(message.code);
        if (!keys.size) {
          this.keys.delete(message.surfaceId);
          this.keyOwners.delete(message.surfaceId);
        }
      }
      if (selection) {
        await this.send({
          text: selection,
          type: "clipboard.data",
          surfaceId: message.surfaceId,
          ...(message.consumerToken ? { consumerToken: message.consumerToken } : {}),
        });
      }
      return;
    }
    if (message.type === "clipboard.paste") {
      if (message.surfaceId !== active.surface.id) return;
      this.ledger.recordHumanActivity(message.surfaceId, { kind: "typing" });
      this.recordPasskeyInput(message, active.surface.id);
      await cdp.send("Input.insertText", { text: message.text });
      return;
    }
    if (message.type === "dialog.respond") {
      if (message.surfaceId && this.ledger.dialogOf(message.surfaceId)?.id !== message.dialogId)
        throw new BrowserRuntimeError("conflict", "The browser dialog changed.");
      const answered = await this.ledger.answerDialog(
        message.dialogId,
        message.accept,
        message.promptText,
      );
      this.ledger.recordHumanActivity(answered, { kind: "dialog" });
    }
  }

  /**
   * Sign-ins wait for a person, so none of them may hold the command queue:
   * each is admitted here and answers later, and a cancel or a detach is never
   * stuck behind the sign-in it ends.
   */
  private handleSignIn(
    message: Extract<
      BrowserClientMessage,
      { type: "signin.probe" | "login.authorize" | "login.cancel" }
    >,
  ): void {
    if (this.claims.access !== "full-control") {
      throw new BrowserRuntimeError("forbidden", "Sign-ins require full-control access.");
    }
    if (message.type === "login.cancel") {
      this.signIns.cancel(message.operationId, message.reason);
      return;
    }
    if (message.type === "signin.probe") {
      void this.signIns
        .probe({ site: message.site })
        .then((passwords) =>
          this.send({ probeId: message.probeId, passwords, type: "signin.probe.result" }),
        )
        .catch(() => undefined);
      return;
    }
    this.signIns.authorize(
      {
        expiresAt: new Date(message.expiresAt),
        operationId: message.operationId,
        requester: message.requester,
        sessionId: this.claims.sessionId,
        site: message.site,
        workspaceId: message.workspaceId,
      },
      (outcome) =>
        this.closed
          ? Promise.resolve()
          : this.send({ operationId: message.operationId, outcome, type: "login.result" }),
      (need) =>
        this.closed
          ? Promise.resolve()
          : this.send({ type: "login.needs", operationId: message.operationId, need }),
      () =>
        this.closed
          ? Promise.resolve()
          : this.send({ type: "login.ended", operationId: message.operationId }),
    );
  }

  /**
   * Answers every outcome with `state.import.result` so the Host can settle the
   * operation it named; a bare `browser.error` would carry no `operationId`.
   */
  private async importSiteState(
    message: Extract<BrowserClientMessage, { type: "state.import" }>,
  ): Promise<void> {
    let error: BrowserRuntimeError | null = null;
    try {
      // Writing sign-in state changes who the browser is signed in as, for
      // every session on this host, so a view-only attachment cannot ask.
      if (this.claims.access !== "full-control") {
        throw new BrowserRuntimeError(
          "forbidden",
          "Importing browser state requires full-control access.",
        );
      }
      // Answer before the Host's own deadline, and stop the write if it has not
      // started, so a sign-in the Host reports as failed never lands later.
      const deadline = new AbortController();
      await withTimeout(
        this.replaceSiteCookies(message.site, message.cookies, deadline.signal),
        browserStateImportRuntimeTimeoutMs,
        {
          timeoutError: () => {
            deadline.abort();
            return new BrowserRuntimeError(
              "conflict",
              "The browser did not apply the sign-in in time.",
              {
                retryable: true,
              },
            );
          },
        },
      );
    } catch (caught) {
      error = normalizeControllerError(caught);
    }
    await this.send({
      error: error?.toProtocolError() ?? null,
      operationId: message.operationId,
      type: "state.import.result",
    });
  }

  private recordPasskeyInput(message: BrowserClientMessage, surfaceId: BrowserSurfaceId): void {
    const targetId = this.ledger.binding(surfaceId)?.targetId;
    if (targetId)
      this.#passkeys?.record(
        targetId,
        message.producerId ? { person: message.producerId } : "unknown",
      );
  }

  private async dispatchPointer(
    message: Extract<BrowserClientMessage, { type: "input.pointer" }>,
  ): Promise<void> {
    if (
      (message.action === "move" && message.button !== "none") ||
      (message.action !== "move" && message.button === "none")
    ) {
      throw new BrowserRuntimeError("bad_message", "The browser pointer button is invalid.");
    }
    const button = message.button === "none" ? null : message.button;
    // Releasing a button this page never saw pressed — a client's physical
    // pointerup arriving after a resize already ended the gesture — would tell
    // Chromium about a press that no longer exists.
    if (
      message.action === "up" &&
      !(button && this.liveGesture(message.surfaceId)?.buttons.has(button))
    ) {
      return;
    }
    // Pointer input lands on the page whose frame the person aimed at;
    // resolvePoint refuses any other page or a stale size.
    const binding = this.ledger.binding(message.surfaceId);
    if (!binding) return;
    const aimed = (this.targetedCasts.get(message.surfaceId)?.cast ?? this.screencast).resolvePoint(
      message.surfaceId,
      message.x,
      message.y,
      message.viewportWidth,
      message.viewportHeight,
      message.captureRevision,
      message.geometryRevision,
    );
    const heldGesture = this.liveGesture(message.surfaceId);
    const current =
      message.geometryRevision === undefined ||
      binding.surface.geometryRevision === message.geometryRevision;
    const point =
      message.action === "up" && heldGesture
        ? { x: heldGesture.x, y: heldGesture.y }
        : current
          ? aimed
          : null;
    if (!point && message.geometryRevision === undefined && !binding.page.capture) return;
    if (!point) throw this.inputGeometryError(message);
    // Read again: an agent's metrics write may have ended the gesture while
    // the point resolved.
    let gesture = this.liveGesture(message.surfaceId);
    if (message.action === "up" && !(button && gesture?.buttons.has(button))) return;
    if (message.action === "down" && button) {
      gesture ??= {
        buttons: new Set(),
        ended: false,
        surfaceId: message.surfaceId,
        owner: inputProducer(message),
        generation: message.inputGeneration ?? 0,
        x: point.x,
        y: point.y,
      };
      gesture.buttons.add(button);
      this.gestures.set(message.surfaceId, gesture);
    }
    if (gesture) {
      gesture.x = point.x;
      gesture.y = point.y;
    }
    const held = new Set(gesture?.buttons ?? noButtons);
    if (message.action === "up" && button) held.delete(button);
    // Blink starts a selection or drag only when a move event names the held
    // button; the buttons bitmask alone never begins one. The controller owns
    // the authoritative pressed set, so it names the button on every move.
    const effectiveButton = message.action === "move" ? heldButton(held) : message.button;
    // Recorded as the press is sent: a press that opens a dialog is answered
    // only once the person has answered that dialog.
    if (message.action === "down")
      this.ledger.recordHumanActivity(message.surfaceId, {
        kind: "click",
        x: point.x,
        y: point.y,
      });
    try {
      this.recordPasskeyInput(message, message.surfaceId);
      await binding.cdp.send("Input.dispatchMouseEvent", {
        button: effectiveButton,
        buttons: pressedButtonMask(held),
        modifiers: editingModifiers(message.modifiers ?? [], this.platform, !this.editing),
        clickCount: button ? (message.clickCount ?? 1) : 0,
        type:
          message.action === "down"
            ? "mousePressed"
            : message.action === "up"
              ? "mouseReleased"
              : "mouseMoved",
        x: point.x,
        y: point.y,
      });
      if (gesture && message.action === "up" && button) {
        gesture.buttons.delete(button);
        if (!gesture.buttons.size) this.gestures.delete(message.surfaceId);
      }
    } catch (error) {
      if (!this.ledger.binding(message.surfaceId)) this.gestures.delete(message.surfaceId);
      throw error;
    }
  }

  private liveGesture(surfaceId: BrowserSurfaceId): PointerGesture | null {
    const gesture = this.gestures.get(surfaceId);
    return gesture && !gesture.ended ? gesture : null;
  }

  private releaseDepartingInput(message: BrowserClientMessage, except?: BrowserSurfaceId): void {
    const producer = inputProducer(message);
    for (const [surfaceId, lane] of this.lanes) {
      if (surfaceId === except) continue;
      const concerned =
        lane.contains((entry) => inputProducer(entry) === producer) ||
        this.liveGesture(surfaceId)?.owner === producer ||
        this.keyOwners.get(surfaceId) === producer;
      lane.cancel((entry) => inputProducer(entry) === producer);
      if (!concerned) continue;
      void lane
        .enqueue(
          { type: "input.cancel", producerId: producer, inputGeneration: message.inputGeneration },
          true,
        )
        .catch(() => undefined);
    }
  }

  private async admitOwner(
    surfaceId: BrowserSurfaceId,
    message: BrowserClientMessage,
  ): Promise<void> {
    const owner = this.liveGesture(surfaceId)?.owner ?? this.keyOwners.get(surfaceId);
    if (!owner || owner === inputProducer(message)) return;
    if (message.type === "input.pointer" && message.action === "down") {
      // A person's new press explicitly takes control, after the old owner's cleanup settles.
      this.lanes.get(surfaceId)?.cancel((entry) => inputProducer(entry) === owner);
      await this.releaseSurface(surfaceId, owner);
      return;
    }
    throw new BrowserRuntimeError("conflict", "Another producer holds input on this page.", {
      reason: "browser-input-owner-conflict",
    });
  }

  private ownsHeldPress(surfaceId: BrowserSurfaceId, message: BrowserClientMessage): boolean {
    const button =
      message.type === "input.pointer"
        ? message.button
        : message.type === "cdp.command" && message.command.method === "Input.dispatchMouseEvent"
          ? message.command.parameters?.button
          : null;
    const code =
      message.type === "input.key"
        ? message.code
        : message.type === "cdp.command" && message.command.method === "Input.dispatchKeyEvent"
          ? message.command.parameters?.code
          : null;
    const gesture = this.liveGesture(surfaceId);
    return Boolean(
      (typeof button === "string" &&
        gesture?.owner === inputProducer(message) &&
        [...gesture.buttons].some((held) => held === button)) ||
      (typeof code === "string" &&
        this.keyOwners.get(surfaceId) === inputProducer(message) &&
        this.keys.get(surfaceId)?.has(code)),
    );
  }

  private async releaseSurface(surfaceId: BrowserSurfaceId, owner?: string): Promise<void> {
    const buttons = this.liveGesture(surfaceId)?.buttons.size ?? 0;
    const keysCount = this.keys.get(surfaceId)?.size ?? 0;
    if (this.releases.length >= 254) this.releases.splice(0, 2);
    this.releases.push({ surfaceId, buttons, keys: keysCount, outcome: "started" });
    const gesture = this.gestures.get(surfaceId);
    if (gesture && (!owner || gesture.owner === owner)) await this.endGesture(gesture);
    if (!owner || this.keyOwners.get(surfaceId) === owner) {
      const keys = this.keys.get(surfaceId);
      const binding = this.ledger.binding(surfaceId);
      if (keys && binding)
        for (const [code, key] of keys) {
          await binding.cdp.send("Input.dispatchKeyEvent", {
            ...keyEventParameters({ ...key, action: "up" }),
            code,
            key: key.key,
            modifiers: 0,
            ...(this.editing ? { location: key.location ?? 0, isKeypad: key.location === 3 } : {}),
          });
          keys.delete(code);
        }
      this.keys.delete(surfaceId);
      this.keyOwners.delete(surfaceId);
    }
    this.releases.push({ surfaceId, buttons, keys: keysCount, outcome: "completed" });
    this.clearReservations(surfaceId, owner);
  }

  private clearReservations(surfaceId: BrowserSurfaceId, owner?: string): void {
    for (const key of this.cleanupReservations) {
      const values: unknown = JSON.parse(key);
      if (Array.isArray(values) && values[0] === surfaceId && (!owner || values[1] === owner))
        this.cleanupReservations.delete(key);
    }
  }

  async prepareResize(surfaceId: BrowserSurfaceId): Promise<void> {
    await this.releaseSurface(surfaceId);
  }

  private async endGesture(gesture: PointerGesture): Promise<void> {
    if (gesture.ended) return;
    const binding = this.ledger.binding(gesture.surfaceId);
    if (binding)
      for (const button of gesture.buttons) {
        const remaining = new Set(gesture.buttons);
        remaining.delete(button);
        // Keep ownership fenced until a live target actually acknowledges cleanup.
        await binding.cdp.send("Input.dispatchMouseEvent", {
          button,
          buttons: pressedButtonMask(remaining),
          clickCount: 1,
          type: "mouseReleased",
          x: gesture.x,
          y: gesture.y,
        });
        gesture.buttons.delete(button);
      }
    gesture.ended = true;
    this.gestures.delete(gesture.surfaceId);
  }

  private trackAgentInput(
    surfaceId: BrowserSurfaceId,
    message: Extract<BrowserClientMessage, { type: "cdp.command" }>,
  ): () => void {
    const { method, parameters: p } = message.command;
    if (method === "Input.dispatchMouseEvent") {
      const parsed = z
        .object({
          type: z.string(),
          x: z.number().finite(),
          y: z.number().finite(),
          button: z.enum(["none", "left", "middle", "right"]).optional(),
        })
        .safeParse(p);
      if (!parsed.success) return () => undefined;
      const { type, x, y, button } = parsed.data;
      let gesture = this.liveGesture(surfaceId);
      if (type === "mousePressed" && button && button !== "none") {
        gesture ??= {
          surfaceId,
          owner: inputProducer(message),
          generation: message.inputGeneration ?? 0,
          buttons: new Set(),
          ended: false,
          x,
          y,
        };
        gesture.buttons.add(button);
        this.gestures.set(surfaceId, gesture);
      }
      if (gesture) {
        gesture.x = x;
        gesture.y = y;
      }
      return () => {
        if (type === "mouseReleased" && button && button !== "none" && gesture) {
          gesture.buttons.delete(button);
          if (!gesture.buttons.size) this.gestures.delete(surfaceId);
        }
      };
    }
    if (method === "Input.dispatchKeyEvent") {
      const parsed = z.object({ type: z.string(), key: z.string(), code: z.string() }).safeParse(p);
      if (!parsed.success) return () => undefined;
      const { type, key, code } = parsed.data;
      if (type === "keyDown" || type === "rawKeyDown") {
        const keys = this.keys.get(surfaceId) ?? new Map();
        keys.set(code, {
          type: "input.key",
          surfaceId,
          action: "down",
          key,
          code,
          modifiers: [],
          ...(message.producerId ? { producerId: message.producerId } : {}),
        });
        this.keys.set(surfaceId, keys);
        this.keyOwners.set(surfaceId, inputProducer(message));
      }
      return () => {
        if (type === "keyUp") {
          this.keys.get(surfaceId)?.delete(code);
          if (!this.keys.get(surfaceId)?.size) {
            this.keys.delete(surfaceId);
            this.keyOwners.delete(surfaceId);
          }
        }
      };
    }
    return () => undefined;
  }

  private async editingObserver(surfaceId: BrowserSurfaceId): Promise<PageEditingObserver> {
    let entry = this.observers.get(surfaceId);
    if (!entry) {
      const binding = this.ledger.binding(surfaceId);
      if (!binding) throw new BrowserRuntimeError("not_found", "The editing surface closed.");
      const observer = new PageEditingObserver(
        binding.cdp,
        (context) => {
          if (!this.closed && this.initialSnapshotQueued)
            void this.send({
              type: "browser.editing",
              surfaceId,
              geometryRevision: this.ledger.binding(surfaceId)?.surface.geometryRevision ?? 0,
              context: { ...context, caret: this.editingCoordinates(surfaceId, context.caret) },
            }).catch(() => undefined);
        },
        (menu, coordinates) => {
          const owner = this.menuConsumers.get(surfaceId);
          void coordinates
            .then((point) => {
              const mapped = this.editingCoordinates(surfaceId, point);
              if (owner && this.menuConsumers.get(surfaceId) === owner && mapped && !this.closed)
                return this.send({
                  type: "browser.contextmenu",
                  surfaceId,
                  consumerToken: owner.consumerToken,
                  geometryRevision: this.ledger.binding(surfaceId)?.surface.geometryRevision ?? 0,
                  ...menu,
                  x: mapped.x,
                  y: mapped.y,
                });
              return undefined;
            })
            .catch(() => undefined);
        },
      );
      const unsubscribeCapture =
        binding.page.capture?.subscribe(() => observer.refresh()) ?? (() => {});
      const ready = observer.start().catch((error) => {
        unsubscribeCapture();
        if (this.observers.get(surfaceId)?.observer === observer) this.observers.delete(surfaceId);
        void observer.close();
        throw error;
      });
      entry = { observer, ready, unsubscribeCapture };
      this.observers.set(surfaceId, entry);
    }
    await entry.ready;
    return entry.observer;
  }

  private editingCoordinates(
    surfaceId: BrowserSurfaceId,
    point: EditingCaret | null,
  ): EditingCaret | null {
    if (!point) return null;
    const port = this.ledger.binding(surfaceId)?.page.capture;
    const capture = port?.read();
    const viewport = this.ledger.viewportOf(surfaceId);
    if ((port && !capture) || !viewport) return null;
    if (!capture) return point;
    const clamp = (value: number) => Math.max(0, Math.min(1, value));
    return {
      x: clamp((point.x * viewport.width) / capture.width),
      y: clamp((point.y * viewport.height) / capture.height),
      height: clamp((point.height * viewport.height) / capture.height),
    };
  }

  /** The baseline clipboard publishes a selection without disturbing input. */
  private async readSelection(cdp: CdpSession): Promise<string | null> {
    try {
      const evaluated = await cdp.send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
        expression: selectedTextExpression,
        returnByValue: true,
      });
      const text = evaluated.result?.value;
      if (typeof text !== "string" || text.length === 0) return null;
      return text.slice(0, 1_000_000);
    } catch {
      return null;
    }
  }

  private lastWorkspaceTabs: string | null = null;
  private publishWorkspaceTabs(closed: BrowserSurfaceId[] = []): Promise<void> {
    if (this.claims.workspaceTabRestoreVersion !== 1) return Promise.resolve();
    const tabs = this.ledger.durableSnapshot();
    const fingerprint = JSON.stringify(tabs);
    if (!closed.length && this.lastWorkspaceTabs === fingerprint) return Promise.resolve();
    this.lastWorkspaceTabs = fingerprint;
    return this.send({ type: "browser.workspace-tabs", tabs, closed });
  }

  private onLedgerEvent(event: SurfaceLedgerEvent): void {
    if (event.type === "navigation.committed") {
      if (!this.closed && this.claims.navigationAttributionVersion === 1)
        void this.send(event).catch(() => undefined);
      return;
    }
    if (
      !this.closed &&
      this.initialSnapshotQueued &&
      (event.type === "changed" || event.type === "snapshot")
    )
      void this.publishWorkspaceTabs(
        event.type === "changed" && event.change === "closed" && event.closure !== "teardown"
          ? [event.surface.id]
          : [],
      ).catch(() => undefined);
    if (this.editing && event.type === "changed" && event.change !== "closed")
      void this.editingObserver(event.surface.id).catch(() => undefined);
    if (event.type === "geometry") this.observers.get(event.surfaceId)?.observer.refresh();
    if (event.type === "closed" || event.type === "geometry") return;
    if (
      event.type === "changed" &&
      event.change === "updated" &&
      this.lanes.has(event.surface.id) &&
      this.laneGeometries.get(event.surface.id) !== event.surface.geometryRevision
    ) {
      this.laneGeometries.set(event.surface.id, event.surface.geometryRevision ?? 0);
      const lane = this.lanes.get(event.surface.id)!;
      lane.cancel(
        (message) => message.type.startsWith("input.") || message.type === "clipboard.paste",
      );
      const owners = new Set([
        this.liveGesture(event.surface.id)?.owner,
        this.keyOwners.get(event.surface.id),
      ]);
      for (const owner of owners)
        if (owner) void lane.enqueue({ type: "input.cancel", producerId: owner }, true);
    }
    if (event.type === "changed" && event.change === "closed") {
      const surfaceId = event.surface.id;
      this.observers.get(surfaceId)?.unsubscribeCapture();
      void this.observers.get(surfaceId)?.observer.close();
      this.observers.delete(surfaceId);
      this.menuConsumers.delete(surfaceId);
      const lane = this.lanes.get(surfaceId);
      lane?.cancel(() => true);
      this.laneGeometries.delete(surfaceId);
      this.clearReservations(surfaceId);
      this.gestures.delete(surfaceId);
      this.keys.delete(surfaceId);
      this.keyOwners.delete(surfaceId);
      for (const [key, pointer] of this.agentPointers)
        if (pointer.surfaceId === surfaceId) this.agentPointers.delete(key);
      if (lane) void lane.idle().then(() => this.lanes.delete(surfaceId));
    }
    if (!this.initialSnapshotQueued || event.type === "dialog") return;
    this.surfaceRevision += 1;
    this.queueLatestSurfaceSnapshot();
  }

  private onDialogChanged(dialog: BrowserDialog | null): void {
    if (this.closed || !this.initialSnapshotQueued) return;
    // A viewer knows a page before its dialog: a popup can open one as its
    // first script runs, before the list that names it goes out.
    if (dialog && !this.deliveredSurfaces.has(dialog.surfaceId)) {
      this.heldDialog = dialog;
      this.queueLatestSurfaceSnapshot();
      return;
    }
    this.heldDialog = null;
    void this.send({ dialog, type: "browser.dialog.changed" }).catch(() => undefined);
  }

  private publishSurfaceSnapshot(): Promise<void> {
    const surfaces = this.ledger.snapshot();
    this.deliveredSurfaces = new Set(surfaces.map((surface) => surface.id));
    const shown = surfaces.find((surface) => surface.active)?.id ?? null;
    const turned = shown !== this.deliveredActive;
    this.deliveredActive = shown;
    const sent = this.send({
      surfaces,
      type: "browser.surfaces.changed",
      inventoryRevision: this.ledger.inventoryRevision,
    });
    if (turned) void sent.then(() => this.screencast.viewersShown(shown)).catch(() => undefined);
    const held = this.heldDialog;
    if (held && this.deliveredSurfaces.has(held.surfaceId)) {
      this.heldDialog = null;
      void this.send({ dialog: held, type: "browser.dialog.changed" }).catch(() => undefined);
    }
    return sent;
  }

  private queueLatestSurfaceSnapshot(): void {
    if (this.closed || this.surfaceSnapshotQueued) return;
    this.surfaceSnapshotQueued = true;
    queueMicrotask(() => {
      const revision = this.surfaceRevision;
      const sent = this.publishSurfaceSnapshot();
      this.surfaceSnapshotTail = sent;
      void sent
        .catch(() => undefined)
        .finally(() => {
          this.surfaceSnapshotQueued = false;
          if (this.surfaceRevision !== revision) this.queueLatestSurfaceSnapshot();
        });
    });
  }

  private async sendFrame(frame: Parameters<BrowserControllerSink["sendFrame"]>[0]): Promise<void> {
    await Promise.resolve();
    // Geometry must be announced before its pixels, even when another list is in flight.
    let announced: Promise<void>;
    do {
      announced = this.surfaceSnapshotTail;
      await announced;
      await Promise.resolve();
    } while (this.surfaceSnapshotQueued || announced !== this.surfaceSnapshotTail);
    const surface = this.ledger.binding(frame.header.surfaceId)?.surface;
    if (surface?.geometryRevision !== frame.header.geometryRevision) return;
    if (!this.closed)
      await this.sink.sendFrame({
        ...frame,
        header: { ...frame.header, frameId: ++this.frameSequence },
      });
  }

  private sendError(error: BrowserRuntimeError): Promise<void> {
    return this.send({
      error: error.toProtocolError(),
      type: "browser.error",
    });
  }

  /**
   * Sends one agent CDP command. A page command marks that page as last
   * commanded by the agent, which is what person activity is measured from.
   */
  private async dispatchAgentCommand(
    message: Extract<BrowserClientMessage, { type: "cdp.command" }>,
  ): Promise<void> {
    const finish = this.clipboard?.agentStarted();
    try {
      await this.dispatchAgentCommandInScope(message);
    } finally {
      finish?.();
    }
  }

  private async dispatchAgentCommandInScope(
    message: Extract<BrowserClientMessage, { type: "cdp.command" }>,
  ): Promise<void> {
    const requested = message.command;
    const command: CdpCommand = {
      method: requested.method,
      ...(requested.parameters === undefined ? {} : { parameters: requested.parameters }),
      ...(requested.sessionId === undefined ? {} : { sessionId: requested.sessionId }),
    };
    const pageTargetId =
      command.sessionId === undefined
        ? null
        : this.cdpRouter.attachedTargetId(this.claims.sessionId, command.sessionId);
    if (message.navigationId && command.method === "Page.navigate" && pageTargetId) {
      this.cdpRouter.admitPageCommand(this.claims.sessionId, command);
      const surfaceId = this.ledger.surfaceIdForTarget(pageTargetId);
      if (!surfaceId) throw new BrowserRuntimeError("not_found", "The browser page closed.");
      const result = await this.ledger.navigate(
        surfaceId,
        safeNavigationUrl(z.string().parse(command.parameters?.url)),
        message.navigationId,
      );
      await this.send({ type: "cdp.result", requestId: message.requestId, result });
      return;
    }
    if (pageTargetId) this.ledger.recordAgentCommand(pageTargetId);
    const attachTargetId =
      command.method === "Target.attachToTarget" && typeof command.parameters?.targetId === "string"
        ? command.parameters.targetId
        : null;
    // A target the session does not own is refused below without waiting.
    if (
      attachTargetId &&
      this.cdpRouter.listOwnedTargets(this.claims.sessionId).includes(attachTargetId)
    ) {
      await this.ledger.settleTarget(attachTargetId);
    }
    // A new tab opens blank and loads its URL only once it has its size, so
    // the site's first layout already sees the person's size.
    const tabUrl = command.method === "Target.createTarget" ? this.admittedTabUrl(command) : null;
    const pageSurfaceId = pageTargetId ? this.ledger.surfaceIdForTarget(pageTargetId) : undefined;
    const settleInput = pageSurfaceId
      ? this.trackAgentInput(pageSurfaceId, message)
      : () => undefined;
    const actorToken = message.actorToken;
    if (actorToken && pageSurfaceId && pointerInputMethods.has(command.method))
      this.agentPointer(actorToken, pageSurfaceId).inputAt = ++this.agentPointerClock;
    const script =
      pageSurfaceId && scriptMethods.has(command.method)
        ? this.watchScriptTargets(pageSurfaceId)
        : null;
    // Anything but observation can let page script start a passkey ceremony.
    const agentActivity = (targetId: string) => this.#passkeys?.record(targetId, "agent");
    let result: unknown;
    try {
      result =
        pageTargetId &&
        (command.method === "Emulation.setDeviceMetricsOverride" ||
          command.method === "Emulation.clearDeviceMetricsOverride")
          ? await this.sendAgentMetrics(command, pageTargetId, agentActivity)
          : pageTargetId && pageSurfaceId && command.method === "Page.handleJavaScriptDialog"
            ? await this.answerAgentDialog(command, pageSurfaceId, () =>
                agentActivity(pageTargetId),
              )
            : pageSurfaceId &&
                command.method === "Page.captureScreenshot" &&
                command.parameters?.captureBeyondViewport !== true
              ? await this.captureAgentViewport(command, pageSurfaceId)
              : await this.cdpRouter.send(
                  this.claims.sessionId,
                  tabUrl
                    ? { ...command, parameters: { ...command.parameters, url: "about:blank" } }
                    : command,
                  agentActivity,
                );
    } finally {
      script?.stop();
    }
    settleInput();
    if (
      command.method === "Target.closeTarget" &&
      typeof command.parameters?.targetId === "string"
    ) {
      const closing = this.ledger.surfaceIdForTarget(command.parameters.targetId);
      if (closing) await this.ledger.closeSurface(closing);
    }
    let attachedActivity: AttachedActivity | undefined;
    if (attachTargetId) {
      // Measured before this attach counts as the agent's latest command, so
      // the agent hears once about what the person did since it last acted.
      attachedActivity = {
        pageResize: this.ledger.targetResize(attachTargetId),
        userActivity: this.ledger.targetActivity(attachTargetId),
      };
      this.ledger.recordAgentCommand(attachTargetId);
    }
    if (command.method === "Target.createTarget") {
      const targetId = targetIdFromResult(result);
      if (targetId && (await this.ledger.adoptTarget(targetId))) {
        this.ledger.recordAgentCommand(targetId);
        const surfaceId = this.ledger.surfaceIdForTarget(targetId);
        const binding = surfaceId ? this.ledger.binding(surfaceId) : null;
        // As CDP's own createTarget does, the tab loads in the background; a
        // failed load stays visible in the tab.
        if (tabUrl && binding) {
          void binding.cdp.send("Page.navigate", { url: tabUrl }).catch(() => undefined);
        }
      }
    }
    const createdTargetId =
      command.method === "Target.createTarget" ? targetIdFromResult(result) : null;
    const activitySurfaceId =
      pageSurfaceId ??
      (attachTargetId ? this.ledger.surfaceIdForTarget(attachTargetId) : undefined) ??
      (createdTargetId ? this.ledger.surfaceIdForTarget(createdTargetId) : undefined);
    const surface =
      actorToken && activitySurfaceId && !this.closed
        ? this.ledger.binding(activitySurfaceId)?.surface
        : undefined;
    // A page that closed meanwhile has dropped its cursors; nothing here may recreate them.
    if (actorToken && activitySurfaceId && surface) {
      const input = pointerInputMethods.has(command.method) ? inputPoint(command) : null;
      const inputAt =
        this.agentPointers.get(agentPointerKey(actorToken, activitySurfaceId))?.inputAt ?? 0;
      const aimed = input
        ? { ...input, scale: this.ledger.pageScaleOf(activitySurfaceId) }
        : script?.target && inputAt < script.startedAt
          ? script.target
          : null;
      await this.send({
        type: "browser.activity",
        actorToken,
        surfaceId: activitySurfaceId,
        seq: ++this.activitySequence,
        geometryRevision: surface.geometryRevision ?? 0,
        pointer: this.moveAgentPointer(actorToken, activitySurfaceId, aimed),
      });
    }
    await this.send({
      requestId: message.requestId,
      result: BrowserCdpResultSchema.parse(
        this.withTargetMetadata(command, result, attachedActivity),
      ),
      type: "cdp.result",
    });
  }

  /** This actor's cursor on one page, kept as the page's most recently used. */
  private agentPointer(actorToken: string, surfaceId: BrowserSurfaceId): AgentPointer {
    const key = agentPointerKey(actorToken, surfaceId);
    const pointer = this.agentPointers.get(key) ?? { surfaceId, point: null, inputAt: 0 };
    this.agentPointers.delete(key);
    this.agentPointers.set(key, pointer);
    // Every Run brings a new actor token.
    if (this.agentPointers.size > maxAgentPointers)
      this.agentPointers.delete(this.agentPointers.keys().next().value!);
    return pointer;
  }

  /**
   * Moves an actor's cursor to the point its command aimed at, unless that
   * lies outside the page's view, and returns where the cursor is. The point
   * is kept as a fraction of the view, so it keeps its place across
   * navigation, scale changes and resizes, as a resting mouse does.
   */
  private moveAgentPointer(
    actorToken: string,
    surfaceId: BrowserSurfaceId,
    aimed: ScriptTarget | null,
  ): { x: number; y: number } | null {
    const pointer = this.agentPointer(actorToken, surfaceId);
    const viewport = this.ledger.viewportOf(surfaceId);
    if (aimed && viewport) {
      const x = (aimed.x * aimed.scale) / viewport.width;
      const y = (aimed.y * aimed.scale) / viewport.height;
      if (Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1)
        pointer.point = { x, y };
    }
    return pointer.point;
  }

  /**
   * Hears where scripts aim events in one page while an agent's script runs
   * there. Agent scripts run one at a time unless a dialog holds one; only a
   * script that ran alone throughout can have aimed what it hears, and the
   * first event it hears is the one a person's pointer would have made.
   */
  private watchScriptTargets(surfaceId: BrowserSurfaceId): ScriptRun {
    const page = this.scriptRuns.get(surfaceId);
    const run: ScriptRun = {
      startedAt: ++this.agentPointerClock,
      contended: page !== undefined,
      target: null,
      stop: () => undefined,
    };
    // Every other script still running started contended, except the first.
    if (page) {
      page.running += 1;
      page.first.contended = true;
    } else this.scriptRuns.set(surfaceId, { running: 1, first: run });
    const unwatch = this.ledger.watchScriptTargets(surfaceId, (target) => {
      if (!run.contended) run.target ??= target;
    });
    run.stop = () => {
      unwatch();
      const running = this.scriptRuns.get(surfaceId);
      if (running && --running.running === 0) this.scriptRuns.delete(surfaceId);
    };
    return run;
  }

  private captureAgentViewport(command: CdpCommand, surfaceId: BrowserSurfaceId): Promise<unknown> {
    this.cdpRouter.admitPageCommand(this.claims.sessionId, command);
    return this.ledger.withGeometry(surfaceId, async (cdp, geometry) => {
      const metrics = layoutMetricsSchema.parse(await cdp.send("Page.getLayoutMetrics"));
      const dpr = screenshotDensity(metrics, geometry?.agent);
      const viewport = visualViewportSchema.parse(metrics.cssVisualViewport);
      const clip = screenshotClip.parse(
        command.parameters?.clip ?? {
          x: Math.round(viewport.pageX),
          y: Math.round(viewport.pageY),
          width: Math.max(1, Math.round(viewport.clientWidth)),
          height: Math.max(1, Math.round(viewport.clientHeight)),
          scale: 1,
        },
      );
      return this.cdpRouter.send(this.claims.sessionId, {
        ...command,
        parameters: {
          ...command.parameters,
          captureBeyondViewport: false,
          clip: { ...clip, scale: clip.scale / dpr },
        },
      });
    });
  }

  private async dispatchHostRead(
    message: Extract<BrowserClientMessage, { type: "cdp.command" }>,
  ): Promise<void> {
    const parameters = message.command.parameters;
    if (message.command.method === browserHostMethods.openTab) {
      const fields = BrowserSessionTabOpenCommandSchema.omit({ type: true, sessionId: true });
      const parsed = (
        this.claims.workspaceTabRestoreVersion === 1
          ? z.union([
              fields,
              fields.extend({
                surfaceId: BrowserSurfaceIdSchema,
                url: z.url().max(browserWorkspaceTabUrlMaxLength).optional(),
              }),
            ])
          : fields
      ).safeParse(parameters);
      if (!parsed.success)
        throw new BrowserRuntimeError("bad_message", "Invalid tab-open parameters.");
      const { idempotencyKey, url: requestedUrl, viewport } = parsed.data;
      const url = requestedUrl === undefined ? undefined : safeNavigationUrl(requestedUrl);
      const fingerprint = createHash("sha256")
        .update(JSON.stringify({ url: requestedUrl }))
        .digest("hex");
      const previous = this.openedTabs.get(idempotencyKey);
      if (previous && previous.fingerprint !== fingerprint)
        throw new BrowserRuntimeError("conflict", "Idempotency key already used.");
      let tabId = previous?.tabId;
      if (!tabId) {
        const surfaceId =
          this.claims.workspaceTabRestoreVersion === 1
            ? BrowserSurfaceIdSchema.safeParse(parameters?.surfaceId).data
            : undefined;
        const opened = await this.ledger.openSurface({
          activate: false,
          ...(surfaceId ? { surfaceId } : {}),
          ...(viewport ? { viewport: { devicePixelRatio: 1, ...viewport } } : {}),
        });
        tabId = opened.id;
        // Retain the identity before navigation: a lost response must never create another page.
        this.openedTabs.set(idempotencyKey, { fingerprint, tabId });
        if (this.openedTabs.size > 1_000)
          this.openedTabs.delete(this.openedTabs.keys().next().value!);
        if (url !== undefined) {
          const binding = this.ledger.binding(tabId);
          if (!binding) throw new BrowserRuntimeError("not_found", "The new tab closed.");
          this.ledger.recordHumanActivity(tabId, { kind: "navigation" });
          void this.ledger.navigate(tabId, url, message.navigationId).catch(() => undefined);
        }
      }
      // A coalesced inventory notice may still be in flight. Publish this replacement
      // before answering so the Host's command result always contains the new tab.
      await this.send({
        type: "browser.surfaces.changed",
        surfaces: this.ledger.snapshot(),
        inventoryRevision: this.ledger.inventoryRevision,
      });
      await this.publishWorkspaceTabs();
      await this.send({ type: "cdp.result", requestId: message.requestId, result: { tabId } });
      return;
    }
    const surfaceId = parameters?.surfaceId;
    if (typeof surfaceId !== "string")
      throw new BrowserRuntimeError("bad_message", "A surface is required.");
    const durableClose =
      this.claims.workspaceTabRestoreVersion === 1 && parameters?.durable === true;
    if (
      durableClose &&
      message.command.method === browserHostMethods.closeTab &&
      !this.ledger.binding(BrowserSurfaceIdSchema.parse(surfaceId))
    ) {
      const tabId = BrowserSurfaceIdSchema.parse(surfaceId);
      if (!this.ledger.binding(tabId)) this.ledger.forgetDormantSurface(tabId);
      await this.send({
        type: "cdp.result",
        requestId: message.requestId,
        result: { outcome: "tab-closed" },
      });
      return;
    }
    const surface = this.ledger.snapshot().find((entry) => entry.id === surfaceId);
    const binding = surface ? this.ledger.binding(surface.id) : null;
    if (!surface || !binding)
      throw new BrowserRuntimeError("not_found", "The browser surface does not exist.");
    if (message.command.method === browserHostMethods.closeTab) {
      const parsed = z
        .object({
          surfaceId: BrowserSurfaceIdSchema,
          inventoryRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        })
        .safeParse(parameters);
      if (!parsed.success)
        throw new BrowserRuntimeError("bad_message", "Invalid tab-close parameters.");
      if (!durableClose && parsed.data.inventoryRevision !== this.ledger.inventoryRevision)
        throw new BrowserRuntimeError("conflict", "The browser inventory changed.");
      let last = this.ledger.snapshot().length === 1;
      if (last) {
        await this.publishWorkspaceTabs([surface.id]);
        last = this.ledger.sealLastSurface(surface.id);
        if (!last && !durableClose)
          throw new BrowserRuntimeError("conflict", "The browser inventory changed.");
      }
      if (!last && this.ledger.binding(surface.id)) await this.ledger.closeSurface(surface.id);
      await this.send({
        type: "browser.surfaces.changed",
        surfaces: this.ledger.snapshot(),
        inventoryRevision: this.ledger.inventoryRevision,
      });
      await this.send({
        type: "cdp.result",
        requestId: message.requestId,
        result: { outcome: last ? "session-closed" : "tab-closed" },
      });
      if (last) await this.close();
      return;
    }
    // The engine's live address can run ahead of the commit the ledger has
    // taken in; the identity and title belong to that commit, not the address.
    const url = binding.page.url();
    if (url !== this.ledger.committedUrl(surface.id))
      throw new BrowserRuntimeError("conflict", "The browser page changed while reading context.");
    const result = BrowserContextCandidateSchema.parse({
      sessionId: this.claims.sessionId,
      tabId: surface.id,
      documentId: surface.documentId,
      title: surface.title.slice(0, 256),
      url: url.length <= 2048 ? url : "",
      ...previousReleaseEligibility(new Date()),
    });
    await this.send({ type: "cdp.result", requestId: message.requestId, result });
  }

  /** The address an agent's new tab loads once it has its size, after the router admits it. */
  private admittedTabUrl(command: CdpCommand): string | null {
    this.cdpRouter.admitCreateTarget(this.claims.sessionId, command);
    const url = command.parameters?.url;
    return typeof url === "string" && url !== "about:blank" ? url : null;
  }

  /**
   * Answers the dialog open on one of this session's pages through the ledger,
   * which owns it, so viewers see it close. On Playwright only the CDP session
   * that heard a dialog open can answer it, and an agent's is new each attach.
   */
  private async answerAgentDialog(
    command: CdpCommand,
    surfaceId: BrowserSurfaceId,
    admitted: () => void,
  ): Promise<unknown> {
    const { dialogId, ...parameters } = command.parameters ?? {};
    // dialogId is a Runtime extension; Chromium's standard command has no ID.
    this.cdpRouter.admitPageCommand(this.claims.sessionId, { ...command, parameters });
    admitted();
    const open = this.ledger.dialogOf(surfaceId);
    if (!open) throw new BrowserRuntimeError("conflict", "No dialog is showing.");
    const { accept, promptText } = parameters;
    if (dialogId !== undefined && dialogId !== open.id) {
      throw new BrowserRuntimeError("conflict", "There is no active browser dialog.");
    }
    await this.ledger.answerDialog(
      open.id,
      accept === true,
      typeof promptText === "string" ? promptText : undefined,
    );
    return {};
  }

  /** The same dialog identity in target metadata, opening events and viewer answers. */
  private pageDialog(
    surfaceId: BrowserSurfaceId,
  ): Pick<BrowserDialog, "id" | "message" | "type"> | undefined {
    const dialog = this.ledger.dialogOf(surfaceId);
    return dialog ? { id: dialog.id, message: dialog.message, type: dialog.type } : undefined;
  }

  /**
   * An agent's device metrics size only the page it targets, and its override
   * is what that page shows until it clears it or the person fits the page.
   * The ledger applies them, so they outlive the agent's own CDP session; a
   * clear returns the page to the person's size.
   */
  private async sendAgentMetrics(
    command: CdpCommand,
    targetId: string,
    admitted: (targetId: string) => void,
  ): Promise<unknown> {
    this.cdpRouter.admitPageCommand(this.claims.sessionId, command);
    admitted(targetId);
    const surfaceId = this.ledger.surfaceIdForTarget(targetId);
    const write = await this.ledger.agentMetrics(
      targetId,
      command.method === "Emulation.clearDeviceMetricsOverride" ? null : (command.parameters ?? {}),
      surfaceId ? () => this.prepareResize(surfaceId) : undefined,
    );
    if (!write) return this.cdpRouter.send(this.claims.sessionId, command);
    // Neither method returns values in CDP, whichever engine applied the size.
    return {};
  }

  private withTargetMetadata(
    command: CdpCommand,
    result: unknown,
    attachedActivity: AttachedActivity | undefined,
  ): unknown {
    const method = command.method;
    if (method === "Target.attachToTarget" && typeof command.parameters?.targetId === "string") {
      const surfaceId = this.ledger.surfaceIdForTarget(command.parameters.targetId);
      if (surfaceId && result !== null && typeof result === "object" && !Array.isArray(result)) {
        const dialog = this.pageDialog(surfaceId);
        return {
          ...result,
          surfaceId,
          ...(attachedActivity?.userActivity
            ? { userActivity: attachedActivity.userActivity }
            : {}),
          ...(attachedActivity?.pageResize ? { pageResize: attachedActivity.pageResize } : {}),
          ...(dialog ? { dialog } : {}),
        };
      }
    }
    if (method !== "Target.getTargets" && method !== "Target.getTargetInfo") return result;
    if (result === null || typeof result !== "object" || Array.isArray(result)) return result;
    const record = result as Record<string, unknown>;
    const decorate = (value: unknown): unknown => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
      const info = value as Record<string, unknown>;
      const targetId = typeof info.targetId === "string" ? info.targetId : null;
      const activity = targetId ? this.ledger.targetActivity(targetId) : undefined;
      const pageResize = targetId ? this.ledger.targetResize(targetId) : undefined;
      const surfaceId = targetId ? this.ledger.surfaceIdForTarget(targetId) : undefined;
      const dialog = surfaceId ? this.pageDialog(surfaceId) : undefined;
      return {
        ...info,
        ...(activity ? { userActivity: activity } : {}),
        ...(pageResize ? { pageResize } : {}),
        ...(surfaceId ? { surfaceId } : {}),
        ...(dialog ? { dialog } : {}),
      };
    };
    return method === "Target.getTargets" && Array.isArray(record.targetInfos)
      ? { ...record, targetInfos: record.targetInfos.map(decorate) }
      : method === "Target.getTargetInfo"
        ? { ...record, targetInfo: decorate(record.targetInfo) }
        : result;
  }

  private send(message: BrowserServerMessage): Promise<void> {
    if (
      this.editing &&
      (message.type === "browser.editing" ||
        message.type === "clipboard.result" ||
        message.type === "clipboard.written")
    ) {
      const kind =
        message.type === "clipboard.result" ? `clipboard.${message.outcome}` : message.type;
      this.editingCounters[kind] = (this.editingCounters[kind] ?? 0) + 1;
    }
    if ((this.disconnected || this.terminated) && message.type !== "browser.status") {
      return Promise.resolve();
    }
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (
      this.pendingMessages >= this.maxPendingMessages ||
      this.pendingMessageBytes + bytes > this.maxPendingMessageBytes
    ) {
      return Promise.reject(
        new BrowserRuntimeError("conflict", "The browser output queue is full.", {
          retryable: true,
        }),
      );
    }
    this.pendingMessages += 1;
    this.pendingMessageBytes += bytes;
    const operation = this.messageTail.then(() => this.sink.sendServer(message));
    this.messageTail = operation
      .catch(() => undefined)
      .finally(() => {
        this.pendingMessages -= 1;
        this.pendingMessageBytes -= bytes;
      });
    return operation;
  }
}

/** The point of a pointer input command, in its own coordinates. */
function inputPoint(command: CdpCommand): { x: number; y: number } | null {
  const parameters = command.parameters;
  if (command.method !== "Input.dispatchTouchEvent")
    return PointSchema.safeParse(parameters).data ?? null;
  const touch = Array.isArray(parameters?.touchPoints) ? parameters.touchPoints[0] : undefined;
  return PointSchema.safeParse(touch).data ?? null;
}

function agentPointerKey(actorToken: string, surfaceId: BrowserSurfaceId): string {
  return JSON.stringify([actorToken, surfaceId]);
}

function targetIdFromResult(result: unknown): string | null {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return null;
  const targetId = (result as Record<string, unknown>).targetId;
  return typeof targetId === "string" ? targetId : null;
}

function isCdpRequest(
  message: BrowserClientMessage,
): message is Extract<BrowserClientMessage, { type: "cdp.command" }> {
  return message.type === "cdp.command";
}

function isDialogAnswer(message: BrowserClientMessage): boolean {
  return message.type === "cdp.command" && message.command.method === "Page.handleJavaScriptDialog";
}

function normalizeControllerError(error: unknown): BrowserRuntimeError {
  if (!(error instanceof SessionCdpRouterError)) return toBrowserRuntimeError(error);
  const code =
    error.code === "bad_command" || error.code === "too_large"
      ? "bad_message"
      : error.code === "not_found"
        ? "not_found"
        : error.code === "forbidden"
          ? "forbidden"
          : "conflict";
  return new BrowserRuntimeError(code, error.message, { cause: error });
}

const selectedTextExpression = `(() => {
  const active = document.activeElement;
  if (active?.type === "password" || /(?:current-password|new-password|one-time-code|cc-number|cc-csc)/.test(active?.autocomplete ?? "")) return "";
  if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
    const start = active.selectionStart;
    const end = active.selectionEnd;
    if (typeof start === "number" && typeof end === "number" && end > start) {
      return active.value.slice(start, end);
    }
  }
  const selection = document.getSelection();
  return selection ? String(selection) : "";
})()`;

function isCopyChord(message: Extract<BrowserClientMessage, { type: "input.key" }>): boolean {
  if (message.action !== "down") return false;
  const key = message.key.toLowerCase();
  if (key !== "c" && key !== "x") return false;
  const primary =
    message.modifiers.includes("primary") ||
    message.modifiers.includes("meta") ||
    message.modifiers.includes("control");
  return primary && !message.modifiers.includes("alt") && !message.modifiers.includes("shift");
}

const noButtons: ReadonlySet<PointerButton> = new Set();

function heldButton(buttons: ReadonlySet<PointerButton>): PointerButton | "none" {
  if (buttons.has("left")) return "left";
  if (buttons.has("middle")) return "middle";
  if (buttons.has("right")) return "right";
  return "none";
}

function pressedButtonMask(buttons: ReadonlySet<PointerButton>): number {
  let mask = 0;
  if (buttons.has("left")) mask |= 1;
  if (buttons.has("right")) mask |= 2;
  if (buttons.has("middle")) mask |= 4;
  return mask;
}

function safeNavigationUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BrowserRuntimeError(
      "forbidden",
      "Only HTTP and HTTPS browser navigation is allowed.",
    );
  }
  if (url.username || url.password) {
    throw new BrowserRuntimeError(
      "forbidden",
      "Browser navigation URLs cannot contain credentials.",
    );
  }
  return url.href;
}

function inputProducer(message: BrowserClientMessage): string {
  if (message.producerId) return message.producerId;
  if (message.type !== "cdp.command") return "legacy-viewer";
  if (message.actorToken) return message.actorToken;
  const detached =
    message.command.method === "Target.detachFromTarget"
      ? message.command.parameters?.sessionId
      : null;
  const hash = createHash("sha256")
    .update(typeof detached === "string" ? detached : (message.command.sessionId ?? "agent"))
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
function isOrderedAgentMutation(
  message: Extract<BrowserClientMessage, { type: "cdp.command" }>,
): boolean {
  return (
    message.command.method.startsWith("Input.") ||
    message.command.method.startsWith("Emulation.") ||
    [
      "Page.navigate",
      "Page.reload",
      "Page.navigateToHistoryEntry",
      "Page.setDocumentContent",
      "Target.closeTarget",
    ].includes(message.command.method)
  );
}

function isInputRelease(message: BrowserClientMessage): boolean {
  if (message.type === "input.pointer" || message.type === "input.key")
    return message.action === "up";
  return (
    message.type === "cdp.command" &&
    ((message.command.method === "Input.dispatchMouseEvent" &&
      message.command.parameters?.type === "mouseReleased") ||
      (message.command.method === "Input.dispatchKeyEvent" &&
        message.command.parameters?.type === "keyUp"))
  );
}

const editingMessageKinds = new Set([
  "input.command",
  "input.compose",
  "input.text",
  "clipboard.copy",
  "clipboard.cut",
  "clipboard.paste-data",
  "clipboard.part",
]);
