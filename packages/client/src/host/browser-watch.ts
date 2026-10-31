import {
  type BrowserRasterDensity,
  type BrowserServerMessage,
  BrowserServerMessageSchema,
  TargetedBrowserClientMessageSchema,
  decodeBrowserFrameEnvelope,
} from "@opensteer/protocol";
import type { BrowserFrameView, BrowserCommand, BrowserRasterDemand } from "./client.js";
import type { WebSocketClient } from "./host-session-client.js";
export interface BrowserWatchState {
  /** The current socket has received its first authorized snapshot. */
  readonly admitted?: boolean;
  /** Identity of this authorized socket, including reconnects React may batch together. */
  readonly admissionId?: string;
  readonly frame: BrowserFrameView | null;
  readonly status: "connecting" | "live" | "unavailable";
  readonly error: string | null;
  readonly inputError?: string | null;
}
const empty: BrowserWatchState = { frame: null, status: "unavailable", error: null };
interface Watch {
  readonly sessionId: string;
  readonly surfaceId: string;
  holds: number;
  pictureHolds: number;
  captureRegionHolds: number;
  frameWindowHolds: number;
  rasterDemandHolds: number;
  /** The density this socket last asked for since its latest subscription. */
  demanded: BrowserRasterDensity | null;
  synchronized: boolean;
  socket: WebSocketClient | null;
  state: BrowserWatchState;
  readonly awaiting: Map<string, { readonly receivedAt: number; claimed: boolean }>;
  timer: ReturnType<typeof setTimeout> | null;
  attempt: number;
  terminal: boolean;
  sequence: number;
  generation: number;
}
/** One producer per exact target, with newest-frame storage and Watch credit. */
export class BrowserWatchStore {
  readonly diagnostics: {
    stage: string;
    frameId?: number;
    bytes?: number;
    durationMs?: number;
    holds?: number;
    code?: number;
    reason?: string;
  }[] = [];
  #diagnose(record: (typeof this.diagnostics)[number]): void {
    if (this.diagnostics.length === 256) this.diagnostics.shift();
    this.diagnostics.push(record);
  }
  #suspended = false;
  #keepControlOnly = false;
  #allowed: (sessionId: string, surfaceId: string) => boolean = () => true;
  readonly #targets = new Map<string, Watch>();
  /** Presenter leases by exact target; a lease may exist before or after its target. */
  readonly #demands = new Map<string, Map<object, BrowserRasterDensity>>();
  readonly #demandPending = new Set<string>();
  readonly #listeners = new Map<string, Set<() => void>>();
  readonly #statusListeners = new Map<string, Set<() => void>>();
  readonly #statuses = new Map<string, BrowserWatchState>();
  status = (sessionId: string, surfaceId: string): BrowserWatchState =>
    this.#statuses.get(this.#key(sessionId, surfaceId)) ?? empty;
  subscribeStatus = (sessionId: string, surfaceId: string, listener: () => void): (() => void) => {
    const key = this.#key(sessionId, surfaceId);
    const listeners = this.#statusListeners.get(key) ?? new Set();
    listeners.add(listener);
    this.#statusListeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.#statusListeners.delete(key);
    };
  };
  readonly connect: (sessionId: string, surfaceId: string) => WebSocketClient;
  readonly mode: "watch" | "control";
  readonly retryDelay: (attempt: number) => number;
  readonly captureRegions: () => boolean;
  readonly frameWindows: () => boolean;
  readonly rasterDemands: () => boolean;
  readonly onMessage:
    ((sessionId: string, message: BrowserServerMessage, surfaceId: string) => void) | undefined;
  readonly onDisconnect: ((sessionId: string, surfaceId: string) => void) | undefined;
  constructor(
    connect: (sessionId: string, surfaceId: string) => WebSocketClient,
    mode: "watch" | "control",
    onMessage:
      ((sessionId: string, message: BrowserServerMessage, surfaceId: string) => void) | undefined,
    retryDelay: (attempt: number) => number,
    captureRegions: () => boolean = () => false,
    onDisconnect?: (sessionId: string, surfaceId: string) => void,
    frameWindows: () => boolean = () => false,
    rasterDemands: () => boolean = () => false,
  ) {
    this.rasterDemands = rasterDemands;
    this.onDisconnect = onDisconnect;
    this.captureRegions = captureRegions;
    this.frameWindows = frameWindows;
    this.connect = connect;
    this.mode = mode;
    this.onMessage = onMessage;
    this.retryDelay = retryDelay;
  }
  has(sessionId: string, surfaceId: string): boolean {
    return this.#targets.has(this.#key(sessionId, surfaceId));
  }
  send(sessionId: string, surfaceId: string, command: BrowserCommand): void {
    const target = this.#targets.get(this.#key(sessionId, surfaceId));
    if (this.mode !== "control" || !target?.synchronized || target.socket?.readyState !== 1) {
      // A connecting socket has admitted no input; a departed socket's Host
      // producer cleanup releases its held state. Cleanup never needs to wait
      // for a replacement stream, while a discrete action must still refuse.
      if (command.type === "input.cancel") {
        if (target) target.generation++;
        return;
      }
      if (command.type === "viewport.follow" || command.type === "stream.unsubscribe") return;
      throw new Error("The targeted browser control is not synchronized.");
    }
    if (
      target.state.inputError &&
      command.type !== "input.wheel" &&
      !(command.type === "input.pointer" && command.action === "move") &&
      command.type !== "viewport.follow"
    )
      this.#set(target, { ...target.state, inputError: null });
    target.socket.send(
      JSON.stringify(
        TargetedBrowserClientMessageSchema.parse({
          ...command,
          inputSequence: ++target.sequence,
          inputGeneration: target.generation,
        }),
      ),
    );
    if (command.type === "input.cancel") target.generation++;
  }
  #key(sessionId: string, surfaceId: string): string {
    return JSON.stringify([sessionId, surfaceId]);
  }
  get = (sessionId: string, surfaceId: string): BrowserWatchState =>
    this.#targets.get(this.#key(sessionId, surfaceId))?.state ?? empty;
  subscribe = (sessionId: string, surfaceId: string, listener: () => void): (() => void) => {
    const key = this.#key(sessionId, surfaceId);
    const listeners = this.#listeners.get(key) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.#listeners.delete(key);
    };
  };
  retain(
    sessionId: string,
    surfaceId: string,
    options: {
      readonly picture?: boolean;
      readonly captureRegion?: boolean;
      readonly frameWindow?: boolean;
      /** This holder's presenter states its raster density through `rasterDemand`. */
      readonly rasterDemand?: boolean;
    } = {},
  ): () => void {
    const picture = options.picture !== false;
    const key = this.#key(sessionId, surfaceId);
    let target = this.#targets.get(key);
    if (!target) {
      if (this.#targets.size >= 16)
        throw new Error("Too many browser capture targets are retained.");
      target = {
        sessionId,
        surfaceId,
        holds: 0,
        pictureHolds: 0,
        captureRegionHolds: 0,
        frameWindowHolds: 0,
        rasterDemandHolds: 0,
        demanded: null,
        synchronized: false,
        socket: null,
        state: empty,
        awaiting: new Map(),
        timer: null,
        attempt: 0,
        terminal: false,
        sequence: 0,
        generation: 0,
      };
      this.#targets.set(key, target);
    }
    const hadPictures = target.pictureHolds > 0;
    const previouslyOptedIn = target.captureRegionHolds === target.pictureHolds;
    const previouslyWindowed = target.frameWindowHolds === target.pictureHolds;
    const captureRegion = picture && options.captureRegion === true;
    const frameWindow = picture && options.frameWindow === true;
    const rasterDemand = picture && options.rasterDemand === true;
    target.holds++;
    if (picture) target.pictureHolds++;
    if (captureRegion) target.captureRegionHolds++;
    if (frameWindow) target.frameWindowHolds++;
    if (rasterDemand) target.rasterDemandHolds++;
    if (
      target.synchronized &&
      (hadPictures !== target.pictureHolds > 0 ||
        previouslyOptedIn !== (target.captureRegionHolds === target.pictureHolds) ||
        previouslyWindowed !== (target.frameWindowHolds === target.pictureHolds))
    )
      this.#subscribeTarget(target);
    this.#diagnose({ stage: "retain", holds: target.holds });
    if (picture) this.#scheduleDemand(key);
    if (
      !this.#paused(target) &&
      this.#allowed(sessionId, surfaceId) &&
      !target.socket &&
      !target.timer
    )
      this.#open(target);
    const current = target;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#diagnose({ stage: "release", holds: current.holds - 1 });
      const previouslyOptedIn = current.captureRegionHolds === current.pictureHolds;
      const previouslyWindowed = current.frameWindowHolds === current.pictureHolds;
      if (picture) current.pictureHolds--;
      if (captureRegion) current.captureRegionHolds--;
      if (frameWindow) current.frameWindowHolds--;
      if (rasterDemand) current.rasterDemandHolds--;
      if (--current.holds > 0) {
        if (picture) this.#scheduleDemand(key);
        if (
          (picture && current.pictureHolds === 0) ||
          previouslyOptedIn !== (current.captureRegionHolds === current.pictureHolds) ||
          previouslyWindowed !== (current.frameWindowHolds === current.pictureHolds)
        )
          this.#subscribeTarget(current);
        return;
      }
      this.#close(current);
      this.#targets.delete(key);
      this.#statuses.delete(key);
      for (const listener of this.#statusListeners.get(key) ?? []) listener();
      this.#notify(current);
    };
  }
  /**
   * One presenter's raster need for an exact target. It asks for the densest
   * raster until it has measured; the target asks for its leases' maximum.
   */
  rasterDemand(sessionId: string, surfaceId: string): BrowserRasterDemand {
    const key = this.#key(sessionId, surfaceId);
    const lease = {};
    let leases = this.#demands.get(key);
    if (!leases) {
      leases = new Map();
      this.#demands.set(key, leases);
    }
    leases.set(lease, 2);
    this.#scheduleDemand(key);
    let released = false;
    return {
      update: (density) => {
        if (released || leases.get(lease) === density) return;
        leases.set(lease, density);
        this.#scheduleDemand(key);
      },
      release: () => {
        if (released) return;
        released = true;
        leases.delete(lease);
        if (!leases.size && this.#demands.get(key) === leases) this.#demands.delete(key);
        this.#scheduleDemand(key);
      },
    };
  }
  /** React remounts and resize bursts settle within one turn; only the result is sent. */
  #scheduleDemand(key: string): void {
    if (this.#demandPending.has(key)) return;
    this.#demandPending.add(key);
    queueMicrotask(() => {
      this.#demandPending.delete(key);
      const target = this.#targets.get(key);
      if (target) this.#sendDemand(target);
    });
  }
  #sendDemand(target: Watch): void {
    if (
      !this.rasterDemands() ||
      !target.synchronized ||
      target.socket?.readyState !== 1 ||
      target.pictureHolds === 0
    )
      return;
    const leases = this.#demands.get(this.#key(target.sessionId, target.surfaceId));
    // A holder that never states its need, such as an older presenter, keeps the densest raster.
    const density: BrowserRasterDensity =
      target.rasterDemandHolds === target.pictureHolds && leases?.size
        ? [...leases.values()].reduce((max, value) => (value > max ? value : max))
        : 2;
    if (density === target.demanded) return;
    target.demanded = density;
    target.socket.send(
      JSON.stringify(
        TargetedBrowserClientMessageSchema.parse({
          type: "stream.demand",
          surfaceId: target.surfaceId,
          density,
        }),
      ),
    );
  }
  claim(sessionId: string, surfaceId: string, token: string): void {
    const receipt = this.#targets.get(this.#key(sessionId, surfaceId))?.awaiting.get(token);
    if (receipt) receipt.claimed = true;
  }
  accept(sessionId: string, surfaceId: string, token: string): void {
    const target = this.#targets.get(this.#key(sessionId, surfaceId));
    const receipt = target?.awaiting.get(token);
    if (!target || !receipt) return;
    this.#diagnose({ stage: "credit", durationMs: performance.now() - receipt.receivedAt });
    target.awaiting.delete(token);
    if (target.socket?.readyState === 1)
      target.socket.send(
        JSON.stringify(
          TargetedBrowserClientMessageSchema.parse({ type: "stream.ack", surfaceId, token }),
        ),
      );
  }
  suspend(suspended: boolean, keepControlOnly = false): void {
    this.#suspended = suspended;
    this.#keepControlOnly = keepControlOnly;
    this.reconcile(this.#allowed);
  }
  #paused(target: Watch): boolean {
    return (
      this.#suspended &&
      !(this.#keepControlOnly && this.mode === "control" && target.pictureHolds === 0)
    );
  }
  reconcile(allowed: (sessionId: string, surfaceId: string) => boolean): void {
    this.#allowed = allowed;
    for (const target of this.#targets.values()) {
      if (!allowed(target.sessionId, target.surfaceId)) {
        this.#close(target);
        this.#set(target, empty);
      } else if (this.#paused(target)) {
        if (!target.socket && !target.timer) continue;
        this.#close(target);
        this.#set(target, this.#kept(target));
      } else if (!target.socket && !target.timer && !target.terminal) this.#open(target);
    }
  }
  /**
   * Every socket is suspect after a network change: each is replaced at once,
   * and its picture stays until the new socket draws one.
   */
  reconnect(): void {
    for (const target of this.#targets.values()) {
      if (target.terminal) continue;
      this.#close(target);
      this.#set(target, this.#kept(target));
    }
    this.reconcile(this.#allowed);
  }
  capabilitiesChanged(): void {
    for (const target of this.#targets.values()) {
      if (
        target.synchronized &&
        target.socket?.readyState === 1 &&
        !this.#paused(target) &&
        this.#allowed(target.sessionId, target.surfaceId)
      )
        this.#subscribeTarget(target);
    }
  }
  clear(): void {
    for (const target of this.#targets.values()) {
      this.#close(target);
      this.#set(target, empty);
    }
  }
  dispose(): void {
    this.clear();
    this.#targets.clear();
    this.#listeners.clear();
    this.#statuses.clear();
    this.#statusListeners.clear();
    this.#demands.clear();
  }
  #open(target: Watch): void {
    if (this.#paused(target) || !this.#allowed(target.sessionId, target.surfaceId)) return;
    let socket: WebSocketClient;
    try {
      socket = this.connect(target.sessionId, target.surfaceId);
    } catch (error) {
      this.#set(target, {
        ...empty,
        error: error instanceof Error ? error.message : "Browser unavailable.",
      });
      return;
    }
    target.socket = socket;
    const admissionId = crypto.randomUUID();
    socket.binaryType = "arraybuffer";
    this.#set(target, { ...this.#kept(target), status: "connecting" });
    let synchronized = false;
    // Until the Host answers the subscription for this surface, it treats the
    // socket as a viewer of the active surface; such events are not ours.
    let subscribed = false;
    const fail = (error: unknown) => {
      if (target.socket !== socket) return;
      this.onDisconnect?.(target.sessionId, target.surfaceId);
      target.socket = null;
      target.synchronized = false;
      target.awaiting.clear();
      target.terminal = true;
      socket.close(4002, "Targeted browser protocol required");
      this.#set(target, {
        ...empty,
        error: error instanceof Error ? error.message : "Invalid browser frame.",
      });
    };
    socket.addEventListener("message", ({ data }) => {
      if (target.socket !== socket) return;
      try {
        if (typeof data === "string") {
          if (data.length > 1024 * 1024) throw new Error("Browser message exceeds its byte limit.");
          const message = BrowserServerMessageSchema.parse(JSON.parse(data));
          if (message.type === "browser.snapshot") {
            if (
              synchronized ||
              message.sessionId !== target.sessionId ||
              message.targetedStreamingVersion !== 1
            )
              throw new Error("Update the Host and Browser Runtime for targeted viewing.");
            synchronized = true;
            target.synchronized = true;
            target.attempt = 0;
            this.#subscribeTarget(target);
            this.#set(target, {
              ...this.#kept(target),
              admitted: true,
              admissionId,
              status: target.pictureHolds ? "connecting" : "live",
            });
          } else if (!synchronized) throw new Error("Browser event arrived before its snapshot.");
          else if (message.type === "browser.status") {
            this.#close(target);
            this.#set(target, empty);
          } else if (message.type === "browser.stream.state") {
            if (message.surfaceId !== target.surfaceId)
              throw new Error("The capture outcome does not match the subscribed target.");
            if (message.state === "capacity")
              this.#set(target, { ...empty, error: "Too many browser capture targets." });
            else if (target.pictureHolds && target.state.status !== "live")
              this.#set(target, {
                ...this.#kept(target),
                admitted: true,
                admissionId,
                status: "connecting",
              });
          } else if (message.type === "browser.error") {
            if (message.error.reason === "browser-target-control-unsupported")
              throw new Error(message.error.message);
            if (
              message.error.reason === "browser-input-canceled" &&
              message.inputGeneration !== undefined
            )
              target.generation = Math.max(target.generation, message.inputGeneration + 1);
            if (this.mode === "control")
              this.#set(target, { ...target.state, inputError: message.error.message });
            this.onMessage?.(target.sessionId, message, target.surfaceId);
            return;
          }
          if (message.type === "browser.dialog.changed" && message.surfaceId === target.surfaceId)
            subscribed = true;
          const surface =
            message.type === "browser.dialog.changed"
              ? (message.dialog?.surfaceId ?? message.surfaceId)
              : [
                    "browser.editing",
                    "browser.contextmenu",
                    "clipboard.result",
                    "clipboard.written",
                    "clipboard.data",
                  ].includes(message.type) && "surfaceId" in message
                ? message.surfaceId
                : target.surfaceId;
          if (surface !== target.surfaceId) {
            if (!subscribed) return;
            throw new Error(
              message.type === "browser.dialog.changed"
                ? "The dialog event does not match the controlled surface."
                : message.type === "clipboard.data"
                  ? "The clipboard event does not match the controlled surface."
                  : "The editing event does not match the controlled surface.",
            );
          }
          this.onMessage?.(target.sessionId, message, target.surfaceId);
          return;
        }
        if (!synchronized || !(data instanceof ArrayBuffer))
          throw new Error("Unexpected browser frame.");
        const frame = decodeBrowserFrameEnvelope(new Uint8Array(data), 8 * 1024 * 1024);
        if (
          frame.header.surfaceId !== target.surfaceId ||
          frame.header.geometryRevision === undefined ||
          !frame.header.watchToken
        )
          throw new Error("The browser frame does not match the subscribed target and geometry.");
        if (target.awaiting.has(frame.header.watchToken) || target.awaiting.size >= 8)
          throw new Error("Browser frame receipts exceeded the negotiated window.");
        target.awaiting.set(frame.header.watchToken, {
          receivedAt: performance.now(),
          claimed: false,
        });
        this.#diagnose({
          stage: "receipt",
          frameId: frame.header.frameId,
          bytes: frame.data.byteLength,
        });
        this.#set(target, {
          admitted: true,
          admissionId,
          error: target.state.error,
          inputError: target.state.inputError ?? null,
          status: "live",
          frame: {
            header: frame.header,
            data: new Uint8Array(data, 4 + new DataView(data).getUint32(0)),
          },
        });
      } catch (error) {
        fail(error);
      }
    });
    socket.addEventListener("close", (event) => {
      if (target.socket !== socket) return;
      this.#diagnose({
        stage: "peer-close",
        code: event.code,
        reason:
          event.code === 4003 ? "access-ended" : event.code === 4002 ? "protocol" : "transport",
      });
      this.onDisconnect?.(target.sessionId, target.surfaceId);
      target.socket = null;
      target.synchronized = false;
      target.awaiting.clear();
      target.terminal = event.code === 4002 || event.code === 4003;
      // A login that ended takes its picture with it, though the next may see it again.
      this.#set(
        target,
        target.terminal
          ? { ...empty, error: "The browser target is no longer available." }
          : event.code === 1008
            ? empty
            : this.#kept(target),
      );
      if (!this.#paused(target) && target.holds && target.state.error === null)
        target.timer = setTimeout(() => {
          target.timer = null;
          this.#open(target);
        }, this.retryDelay(target.attempt++));
    });
  }
  #subscribeTarget(target: Watch): void {
    for (const token of target.awaiting.keys())
      this.accept(target.sessionId, target.surfaceId, token);
    target.socket?.send(
      JSON.stringify(
        TargetedBrowserClientMessageSchema.parse({
          type: "stream.subscribe",
          ...(target.pictureHolds > 0 &&
          target.captureRegionHolds === target.pictureHolds &&
          this.captureRegions()
            ? { captureRegion: true }
            : {}),
          ...(target.pictureHolds > 0 &&
          target.frameWindowHolds === target.pictureHolds &&
          this.frameWindows()
            ? { frameWindow: 1 }
            : {}),
          surfaceId: target.surfaceId,
          ...(target.pictureHolds ? {} : { frames: false }),
        }),
      ),
    );
    // Each subscription states its demand afresh rather than trusting what the Host kept.
    target.demanded = null;
    this.#scheduleDemand(this.#key(target.sessionId, target.surfaceId));
  }
  #close(target: Watch): void {
    this.onDisconnect?.(target.sessionId, target.surfaceId);
    if (target.timer) clearTimeout(target.timer);
    target.timer = null;
    const socket = target.socket;
    for (const token of target.awaiting.keys())
      this.accept(target.sessionId, target.surfaceId, token);
    target.socket = null;
    target.awaiting.clear();
    target.synchronized = false;
    this.#diagnose({ stage: "local-close", code: 1000, reason: "target-released" });
    socket?.close(1000, "Target released");
  }
  /**
   * A paused or reconnecting target keeps its last picture until a newer one
   * replaces it; nothing about it is current, so it takes no input.
   */
  #kept(target: Watch): BrowserWatchState {
    return { ...empty, frame: target.state.frame };
  }
  #set(target: Watch, state: BrowserWatchState): void {
    const before = target.state;
    target.state = state;
    if (before.frame !== state.frame) {
      // An imperative presenter may still be decoding the previous delivery.
      // A batched subscriber may never see it: only unclaimed replacements
      // are the store's to discard. Clearing retires all deliveries.
      if (state.frame === null)
        for (const token of target.awaiting.keys())
          this.accept(target.sessionId, target.surfaceId, token);
      else if (before.frame?.header.watchToken) {
        const token = before.frame.header.watchToken;
        if (!target.awaiting.get(token)?.claimed)
          this.accept(target.sessionId, target.surfaceId, token);
      }
    }
    if (
      before.admitted !== state.admitted ||
      before.admissionId !== state.admissionId ||
      before.status !== state.status ||
      before.error !== state.error ||
      before.inputError !== state.inputError ||
      before.frame?.header.surfaceId !== state.frame?.header.surfaceId ||
      before.frame?.header.geometryRevision !== state.frame?.header.geometryRevision
    ) {
      const key = this.#key(target.sessionId, target.surfaceId);
      this.#statuses.set(key, { ...state, frame: null });
      for (const listener of this.#statusListeners.get(key) ?? []) listener();
    }
    this.#notify(target);
  }
  #notify(target: Watch): void {
    for (const listener of this.#listeners.get(this.#key(target.sessionId, target.surfaceId)) ?? [])
      listener();
  }
}
