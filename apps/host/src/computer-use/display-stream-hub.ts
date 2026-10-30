import { randomUUID } from "node:crypto";
import { OpensteerError, type RunnerId, type UserId } from "@opensteer/core";
import {
  displayFirstFrameTimeoutMs,
  macDisplayMaxWindows,
  macDisplayMaxWarmWindows,
  macDisplayWarmMs,
  macDisplayProfileHysteresisMs,
  type MacWindowTarget,
  sameRunnerAuxiliaryFence,
  displaySourceKey,
  type DisplaySource,
  type ComputerViewId,
  displayViewerCloseCodes,
  decodeDisplayMediaFrame,
  encodeDisplayViewerFrame,
  DisplayStreamIdSchema,
  displayDefaultMaxFps,
  displayDefaultMaxLongSide,
  displayDemandGraceMs,
  displayRefreshCoalescingMs,
  displaySlowViewerCloseMs,
  displayViewerCreditBytes,
  displayViewerCreditFrames,
  type ComputerUseSessionId,
  type DisplayDataTicketClaims,
  type DisplayViewerClientMessage,
  type DisplayViewerState,
  trackHeldDisplayInput,
  type DisplayInputResult,
  type DisplayClipboard,
  type DisplayEditing,
  type DisplayStreamId,
  type DisplayStreamReason,
  type HostIntegrationsOperation,
  type IntegrationsModuleEvent,
  type RunnerAuxiliaryFrameFence,
} from "@opensteer/protocol";
import type { RunnerStreamLossReason } from "@opensteer/orchestration";
import { rawDataBuffer } from "@opensteer/shared/webSocketFrame";
import type { WebSocket } from "ws";
import type { RunnerAuthenticator } from "../agents/runner-authenticator.js";
import type { ComputerAppHub } from "../computer-apps/computer-app-hub.js";
import { installWebSocketLiveness } from "../server/websocket-liveness.js";
import type { ComputerViewService } from "./computer-view-service.js";
import type { ComputerUseService } from "./computer-use-service.js";

// Host-only retention bound: viewers and phones need no cache-size negotiation.
const displayGopCacheBytes = 4 * 1_024 * 1_024;
// Two ten-second GOPs at 30 fps bound metadata and replay work for tiny frames.
const displayGopCacheFrames = 600;
// Eight tabs cover ordinary watching while bounding per-session fan-out work.
const displayMaxViewers = 8;
// Credit is decoder feedback, not proof that the network drained its writes.
const displaySocketBufferedBytes = 8 * 1_024 * 1_024;

interface CachedFrame {
  readonly sequence: number;
  readonly bytes: Uint8Array;
}

type PhoneEvent = Extract<
  IntegrationsModuleEvent,
  {
    type:
      | "runner.integrations.display.input-result"
      | "runner.integrations.display.editing"
      | "runner.integrations.display.clipboard"
      | "runner.integrations.mac-owner.event"
      | "runner.integrations.display.state"
      | "runner.integrations.display.source-ended"
      | "runner.integrations.display.source-changed";
  }
>;
interface Viewer {
  readonly sharedInput: boolean;
  authorized: boolean;
  inputSequence: number;
  checkedAt: number;
  checking: boolean;
  readonly editing: boolean;
  readonly displayCut: boolean;
  readonly inputCounters: {
    operations: Record<string, number>;
    refusals: Record<string, number>;
    clipboard: Record<string, number>;
    contextUpdates: number;
  };
  readonly source: DisplaySource;
  readonly actor: UserId;
  readonly socket: WebSocket;
  readonly outstanding: Map<number, number>;
  // Sent before a decoder reset; their acks must not credit repeated sequences.
  readonly discarded: number[];
  maxLongSide: number;
  bytes: number;
  keyframeAt: number;
  keyframePending: boolean;
  waiting: boolean;
  replayIndex: number | null;
  replayThrough: number | null;
  slowSince: number | null;
  removalTrigger?: string;
}
interface PendingInput {
  readonly viewer: Viewer;
  readonly sequence: number;
  readonly geometry: number;
  result: boolean;
  copy: boolean;
  readonly cut: boolean;
}
interface Stream {
  readonly sharedInput?: 1;
  holder: Viewer | null;
  /** The person-lane sequence of the holder's latest batch. */
  holderSequence: number;
  readonly held: Set<string>;
  inputSequence: number;
  readonly pending: Map<number, PendingInput>;
  readonly editingVersion?: 1;
  readonly displayCut?: 1;
  readonly authorities: Map<string, { source: DisplaySource; actor: UserId }>;
  maxLongSide: number;
  profileAt: number | null;
  readonly key: string;
  readonly target: MacWindowTarget | undefined;
  readonly firstFrameDeadline: number;
  firstKey: boolean;
  revision: number;
  demandKey: string;
  readonly runnerId: RunnerId;
  readonly streamId: DisplayStreamId;
  readonly fence: RunnerAuxiliaryFrameFence & { readonly module: "integrations" };
  readonly nonce: string;
  readonly expiresAt: number;
  readonly viewers: Set<Viewer>;
  state: DisplayViewerState;
  data: WebSocket | null;
  claimed: boolean;
  sequence: number;
  generation: number;
  mediaGeneration: number;
  /**
   * The newest generation the phone declared protected or ended. The phone ends
   * a generation whenever it closes publication and resumes only in a new one,
   * so media of this generation or older is never published, while a newer
   * generation is capture after the lift and needs no announcement first.
   */
  withheldThrough: number;
  cache: CachedFrame[];
  cacheBytes: number;
  refreshAt: number;
  refreshPending: boolean;
  stopAt: number | null;
}
export interface DisplayStreamHubOptions {
  readonly authenticator: Pick<
    RunnerAuthenticator,
    "issueDisplayDataTicket" | "verifyDisplayDataTicket"
  >;
  readonly computerApps: Pick<ComputerAppHub, "displayStream" | "sendDisplay" | "resolveDisplay">;
  readonly computerUse: Pick<
    ComputerUseService,
    "authorizeDisplay" | "noteOwnerActivity" | "isDisplaySessionLive"
  >;
  readonly computerViews: Pick<
    ComputerViewService,
    "authorizeDisplay" | "isDisplayLive" | "endDisplaySource"
  > &
    Partial<Pick<ComputerViewService, "authorizeInput">>;
  readonly onState?: (
    runnerId: RunnerId,
    streamId: DisplayStreamId,
    state: DisplayViewerState,
  ) => void;
  readonly log?: (event: string, details: Readonly<Record<string, unknown>>) => void;
  readonly now?: () => number;
}

/** One projection per authenticated phone/display; authorities spend decoder credit independently. */
export class DisplayStreamHub {
  readonly #options: DisplayStreamHubOptions;
  readonly #streams = new Map<DisplayStreamId, Stream>();
  readonly #byTarget = new Map<string, Stream>();
  readonly #resolving = new Map<string, Promise<MacWindowTarget>>();
  readonly #now: () => number;
  readonly #timer: NodeJS.Timeout;
  #closed = false;
  constructor(options: DisplayStreamHubOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#timer = setInterval(() => this.sweep(), 100);
    this.#timer.unref();
  }

  async authorize(source: DisplaySource, actor: UserId): Promise<RunnerId> {
    if (this.#closed) throw new OpensteerError({ code: "forbidden", message: "Host stopping" });
    const runnerId =
      source.kind === "task-session"
        ? await this.#options.computerUse.authorizeDisplay(source.sessionId, actor, source.appKey)
        : await this.#options.computerViews.authorizeDisplay(source, actor);
    // Authorization can outlive shutdown; it must not recreate demand afterward.
    if (this.#closed) throw new OpensteerError({ code: "forbidden", message: "Host stopping" });
    return runnerId;
  }

  async attachViewer(
    source: DisplaySource,
    actor: UserId,
    socket: WebSocket,
    options: {
      readonly editing?: boolean;
      readonly displayCut?: boolean;
      readonly sharedInput?: boolean;
    } = {},
  ): Promise<{
    handle: (message: DisplayViewerClientMessage) => void;
    close: (trigger?: string, code?: number) => void;
  }> {
    const deadline = this.#now() + displayFirstFrameTimeoutMs;
    const runnerId = await this.authorize(source, actor);
    if (socket.readyState !== socket.OPEN)
      return { handle: () => undefined, close: () => undefined };
    const live = this.#options.computerApps.displayStream(runnerId);
    if (!live) {
      socket.close(displayViewerCloseCodes.tryAgain, "Display stream unavailable");
      return { handle: () => undefined, close: () => undefined };
    }
    if (live === "unsupported") {
      this.#json(socket, {
        type: "display.state",
        state: "unsupported",
        generation: 0,
        width: 0,
        height: 0,
      });
      socket.close(displayViewerCloseCodes.ended, "Display unsupported");
      return { handle: () => undefined, close: () => undefined };
    }
    let target: MacWindowTarget | undefined;
    if (live.mac) {
      const resolvingKey = `${JSON.stringify(live.fence)}:${displaySourceKey(source)}`;
      let resolution = this.#resolving.get(resolvingKey);
      if (!resolution) {
        resolution = this.#options.computerApps.resolveDisplay(
          runnerId,
          source,
          Math.max(1, deadline - this.#now()),
        );
        this.#resolving.set(resolvingKey, resolution);
        void resolution
          .finally(() => {
            if (this.#resolving.get(resolvingKey) === resolution)
              this.#resolving.delete(resolvingKey);
          })
          .catch(() => undefined);
      }
      try {
        target = await resolution;
      } catch {
        const reason = this.#now() >= deadline ? "capture-timeout" : "target-unavailable";
        this.#json(socket, {
          type: "display.state",
          state: "failed",
          reason,
          generation: 0,
          width: 0,
          height: 0,
        });
        if (source.kind === "owner-view")
          this.#options.computerViews.endDisplaySource(source, runnerId, reason);
        socket.close(displayViewerCloseCodes.ended, "Window capture failed");
        return { handle: () => undefined, close: () => undefined };
      }
    }
    if (socket.readyState !== socket.OPEN || !this.#sourceLive(source, actor, runnerId))
      return { handle: () => undefined, close: () => undefined };
    const current = this.#options.computerApps.displayStream(runnerId);
    if (
      !current ||
      current === "unsupported" ||
      !sameRunnerAuxiliaryFence(current.fence, live.fence)
    ) {
      socket.close(displayViewerCloseCodes.ended, "Window fence ended");
      return { handle: () => undefined, close: () => undefined };
    }
    const key = `${JSON.stringify(live.fence)}:${target?.bindingId ?? "main"}`;
    let stream = this.#byTarget.get(key);
    if (stream && !this.#current(stream)) {
      this.#endUnavailable(stream, "Display stream ended");
      stream = undefined;
    }
    if (!this.#sourceLive(source, actor, runnerId)) {
      socket.close(displayViewerCloseCodes.ended, "Display authority ended");
      return { handle: () => undefined, close: () => undefined };
    }
    let machineStreams = [...this.#streams.values()].filter((entry) => entry.runnerId === runnerId);
    if (
      !stream &&
      target &&
      machineStreams.filter((entry) => entry.target).length >= macDisplayMaxWindows
    ) {
      const warm = machineStreams
        .filter((entry) => entry.target && entry.stopAt !== null)
        .sort((a, b) => a.stopAt! - b.stopAt!)[0];
      if (warm) {
        this.#end(warm, displayViewerCloseCodes.ended, "Warm capacity eviction");
        machineStreams = machineStreams.filter((entry) => entry !== warm);
      }
    }
    if (
      machineStreams.reduce((count, entry) => count + entry.viewers.size, 0) >= displayMaxViewers ||
      (!stream &&
        target &&
        machineStreams.filter((entry) => entry.target).length >= macDisplayMaxWindows)
    ) {
      if (target) {
        this.#json(socket, {
          type: "display.state",
          state: "failed",
          reason: "capacity",
          generation: 0,
          width: 0,
          height: 0,
        });
        this.#options.log?.("computer.display.lifecycle", {
          transition: "failed",
          reason: "capacity",
          machineId: runnerId,
          ...source,
        });
        if (source.kind === "owner-view")
          this.#options.computerViews.endDisplaySource(source, runnerId, "capacity");
      }
      socket.close(
        target ? displayViewerCloseCodes.ended : displayViewerCloseCodes.tryAgain,
        "Too many display viewers",
      );
      return { handle: () => undefined, close: () => undefined };
    }
    const joining = stream !== undefined;
    let start: HostIntegrationsOperation | null = null;
    if (!stream) {
      const streamId = DisplayStreamIdSchema.parse(`dsp_${randomUUID()}`);
      const issued = this.#options.authenticator.issueDisplayDataTicket({
        fence: live.fence,
        display: "main",
        ...(target ? { target } : {}),
        streamId,
      });
      stream = {
        ...(live.sharedInput === 1 && !target ? { sharedInput: 1 as const } : {}),
        ...(live.editingVersion === 1 ? { editingVersion: 1 as const } : {}),
        ...(live.displayCut === 1 && !target ? { displayCut: 1 as const } : {}),
        authorities: new Map(),
        maxLongSide: displayDefaultMaxLongSide,
        profileAt: null,
        key,
        target,
        firstFrameDeadline: deadline,
        firstKey: false,
        revision: 0,
        demandKey: "",
        runnerId,
        streamId,
        fence: live.fence,
        nonce: issued.claims.nonce,
        expiresAt: Date.parse(issued.claims.expiresAt),
        viewers: new Set(),
        state: { type: "display.state", state: "starting", generation: 0, width: 0, height: 0 },
        data: null,
        claimed: false,
        sequence: -1,
        generation: 0,
        mediaGeneration: 0,
        withheldThrough: 0,
        cache: [],
        cacheBytes: 0,
        refreshAt: -Infinity,
        refreshPending: false,
        stopAt: null,
        holder: null,
        holderSequence: -1,
        held: new Set(),
        inputSequence: 0,
        pending: new Map(),
      };
      this.#streams.set(streamId, stream);
      this.#byTarget.set(key, stream);
      this.#options.onState?.(runnerId, streamId, stream.state);
      start = {
        ...stream.fence,
        type: "host.integrations.display.start",
        ...(live.sharedInput === 1 && !target ? { sharedInput: 1 as const } : {}),
        ...(live.editingVersion === 1 ? { editingVersion: 1 as const } : {}),
        ...(live.displayCut === 1 && !target ? { displayCut: 1 as const } : {}),
        ...(target
          ? {
              target,
              timeoutMs: Math.max(
                1,
                Math.min(displayFirstFrameTimeoutMs, Math.floor(deadline - this.#now())),
              ),
            }
          : {}),
        display: "main",
        revision: 0,
        sources: [source],
        streamId,
        dataTicket: issued.ticket,
        maxLongSide: displayDefaultMaxLongSide,
        maxFps: displayDefaultMaxFps,
      };
    }
    const attached = stream;
    attached.stopAt = null;
    let authorized = !target && source.kind === "task-session";
    if (target && source.kind === "owner-view" && target.editingVersion === 1) {
      try {
        authorized =
          (await this.#options.computerViews.authorizeInput?.(source, actor)) === runnerId;
      } catch {
        authorized = false;
      }
    }
    if (
      this.#streams.get(attached.streamId) !== attached ||
      socket.readyState !== socket.OPEN ||
      !this.#sourceLive(source, actor, runnerId)
    ) {
      socket.close(displayViewerCloseCodes.ended, "Display authority ended");
      return { handle: () => undefined, close: () => undefined };
    }
    const viewer: Viewer = {
      sharedInput: options.sharedInput === true,
      authorized,
      inputSequence: -1,
      checkedAt: this.#now(),
      checking: false,
      editing: options.editing === true,
      displayCut: options.editing === true && options.displayCut === true && !target,
      inputCounters: { operations: {}, refusals: {}, clipboard: {}, contextUpdates: 0 },
      source,
      actor,
      socket,
      outstanding: new Map(),
      discarded: [],
      maxLongSide: displayDefaultMaxLongSide,
      bytes: 0,
      keyframeAt: -Infinity,
      keyframePending: false,
      waiting: true,
      replayIndex: null,
      replayThrough: null,
      slowSince: null,
    };
    attached.viewers.add(viewer);
    attached.authorities.set(displaySourceKey(source), { source, actor });
    this.#log(attached, "open");
    if (start) {
      attached.demandKey = JSON.stringify({ sources: [source] });
      this.#send(attached, start);
    } else this.#demand(attached);
    if (!joining || !this.#replay(attached, viewer)) {
      this.#viewerState(attached, viewer, attached.state);
      if (joining && attached.state.state === "live") this.#refresh(attached);
    }
    const close = (trigger = "detach", code?: number) => {
      if (!attached.viewers.delete(viewer)) return;
      this.#viewerRemoved(attached, viewer, viewer.removalTrigger ?? trigger, code);
      this.#demand(attached);
      if (!attached.target && attached.viewers.size === 0)
        attached.stopAt = this.#now() + displayDemandGraceMs;
    };
    socket.once("close", (code) => close("socket-close", code));
    socket.once("error", () => close("socket-error"));
    return { handle: (message) => this.#viewerMessage(attached, viewer, message), close };
  }

  claimDataSocket(ticket: string): DisplayDataTicketClaims {
    const claims = this.#options.authenticator.verifyDisplayDataTicket(ticket);
    const stream = this.#streams.get(claims.streamId);
    if (
      !stream ||
      stream.claimed ||
      stream.nonce !== claims.nonce ||
      stream.target?.bindingId !== claims.target?.bindingId ||
      stream.streamId !== claims.streamId ||
      !sameRunnerAuxiliaryFence(stream.fence, claims) ||
      !this.#current(stream)
    ) {
      if (stream && !this.#current(stream)) this.#endUnavailable(stream, "Display fence ended");
      throw new OpensteerError({
        code: "forbidden",
        message: "That display ticket names no waiting live stream",
      });
    }
    stream.claimed = true;
    return claims;
  }

  failDataSocket(claims: DisplayDataTicketClaims): void {
    const stream = this.#streams.get(claims.streamId);
    if (
      !stream ||
      stream.streamId !== claims.streamId ||
      stream.nonce !== claims.nonce ||
      !sameRunnerAuxiliaryFence(stream.fence, claims) ||
      stream.data
    )
      return;
    if (stream.target) this.#failCapture(stream, "capture-failed");
    else this.#end(stream, displayViewerCloseCodes.tryAgain, "Display data socket failed");
  }

  attachDataSocket(claims: DisplayDataTicketClaims, socket: WebSocket): void {
    const stream = this.#streams.get(claims.streamId);
    if (
      !stream ||
      !stream.claimed ||
      stream.target?.bindingId !== claims.target?.bindingId ||
      stream.data ||
      stream.streamId !== claims.streamId ||
      !sameRunnerAuxiliaryFence(stream.fence, claims) ||
      stream.nonce !== claims.nonce ||
      !this.#current(stream)
    ) {
      socket.close(4003, "Display stream ended");
      return;
    }
    stream.data = socket;
    installWebSocketLiveness(socket);
    socket.on("message", (raw, binary) => {
      if (this.#streams.get(stream.streamId) !== stream) return;
      if (!this.#current(stream)) {
        this.#endUnavailable(stream, "Display fence ended");
        return;
      }
      try {
        if (!binary) throw new Error("Binary media required");
        const { header, payload } = decodeDisplayMediaFrame(rawDataBuffer(raw));
        if (
          header.streamId !== stream.streamId ||
          header.sequence <= stream.sequence ||
          header.generation < stream.mediaGeneration
        ) {
          throw new Error("Invalid display sequence or stream");
        }
        if (stream.target && !stream.viewers.size) {
          this.#json(socket, { type: "display.ack", sequence: header.sequence });
          return;
        }
        stream.sequence = header.sequence;
        stream.mediaGeneration = header.generation;
        if (stream.target && !stream.firstKey && !header.key) {
          this.#json(socket, { type: "display.ack", sequence: header.sequence });
          return;
        }
        if (header.generation > stream.generation) {
          this.#clearCache(stream);
          stream.generation = header.generation;
          for (const viewer of stream.viewers) viewer.waiting = true;
        }
        // Media and the phone's state travel on different sockets, so either may
        // arrive first. A protected generation's media is never published; a newer
        // generation's is, and its first frame makes the stream live.
        if (header.generation === stream.generation && header.generation > stream.withheldThrough) {
          if (header.key && !stream.firstKey) {
            this.#log(stream, "first-frame");
            stream.firstKey = true;
          }
          if (stream.state.state !== "live" || stream.state.generation !== header.generation)
            this.#publishState(stream, {
              type: "display.state",
              state: "live",
              generation: header.generation,
              width: header.width,
              height: header.height,
            });
          const { streamId: _streamId, ...viewerHeader } = header;
          const envelope = encodeDisplayViewerFrame(viewerHeader, payload);
          if (header.key) this.#clearCache(stream);
          if (header.key || stream.cache.length > 0) {
            if (
              stream.cacheBytes + envelope.byteLength > displayGopCacheBytes ||
              stream.cache.length >= displayGopCacheFrames
            ) {
              const replaying = [...stream.viewers].filter((viewer) => viewer.replayIndex !== null);
              this.#clearCache(stream);
              for (const viewer of replaying) this.#skip(stream, viewer);
            } else {
              stream.cache.push({ sequence: header.sequence, bytes: envelope });
              stream.cacheBytes += envelope.byteLength;
            }
          }
          for (const viewer of stream.viewers) {
            if (!this.#viewerLive(stream, viewer)) continue;
            if (viewer.replayIndex !== null) {
              this.#drainCache(stream, viewer);
              continue;
            }
            if (viewer.waiting && !header.key) continue;
            if (!this.#hasCredit(viewer, envelope.byteLength)) {
              this.#skip(stream, viewer);
              continue;
            }
            if (viewer.waiting) viewer.keyframePending = false;
            viewer.waiting = false;
            viewer.slowSince = null;
            this.#sendFrame(viewer, { sequence: header.sequence, bytes: envelope });
          }
        } else {
          // Older queued media cannot affect the announced generation's decoder cache.
          // Other withheld media breaks continuity even if its generation is unchanged.
          if (header.generation >= stream.generation) {
            this.#clearCache(stream);
            for (const viewer of stream.viewers) viewer.waiting = true;
          }
        }
        this.#json(socket, { type: "display.ack", sequence: header.sequence });
      } catch {
        if (stream.target) this.#failCapture(stream, "capture-failed");
        else this.#end(stream, displayViewerCloseCodes.tryAgain, "Invalid display media", 4002);
      }
    });
    const lost = () => {
      if (this.#streams.get(stream.streamId) !== stream) return;
      if (stream.target) this.#failCapture(stream, "capture-failed");
      else this.#end(stream, displayViewerCloseCodes.tryAgain, "Display data socket ended");
    };
    socket.once("error", lost);
    socket.once("close", lost);
  }

  handlePhoneEvent(runnerId: RunnerId, event: PhoneEvent): void {
    const stream = this.#streams.get(event.streamId);
    if (!stream || stream.runnerId !== runnerId) return;
    if (!sameRunnerAuxiliaryFence(stream.fence, event) || !this.#current(stream)) {
      this.#endUnavailable(stream, "Display fence ended");
      return;
    }
    if (event.type === "runner.integrations.mac-owner.event") {
      if (!stream.target) return;
      this.#inputEvent(stream, event.message, undefined, event.source);
      return;
    }
    if (event.type === "runner.integrations.display.editing") {
      if (!stream.target && stream.editingVersion === 1)
        this.#inputEvent(
          stream,
          { type: "display.editing", generation: event.geometry, context: event.context },
          event.geometry,
          { kind: "task-session", sessionId: event.sessionId },
        );
      return;
    }
    if (
      event.type === "runner.integrations.display.input-result" ||
      event.type === "runner.integrations.display.clipboard"
    ) {
      if (stream.target) return;
      const message =
        event.type === "runner.integrations.display.input-result"
          ? {
              type: "display.input.result" as const,
              sequence: event.sequence,
              outcome: event.outcome,
              ...(event.reason ? { reason: event.reason } : {}),
            }
          : {
              type: "display.clipboard" as const,
              sequence: event.sequence,
              outcome: event.outcome,
              ...(event.text !== undefined ? { text: event.text } : {}),
            };
      this.#inputEvent(stream, message, event.geometry, {
        kind: "task-session",
        sessionId: event.sessionId,
      });
      return;
    }
    if (event.type === "runner.integrations.display.source-changed") {
      stream.authorities.delete(displaySourceKey(event.source));
      for (const viewer of stream.viewers) {
        if (displaySourceKey(viewer.source) !== displaySourceKey(event.source)) continue;
        this.#viewerState(stream, viewer, {
          ...stream.state,
          state: "protected",
          width: 0,
          height: 0,
        });
        stream.viewers.delete(viewer);
        this.#viewerRemoved(stream, viewer, "source-changed", displayViewerCloseCodes.tryAgain);
        viewer.socket.close(displayViewerCloseCodes.tryAgain, "Window target changed");
      }
      this.#demand(stream);
      if (!stream.target && !stream.viewers.size)
        stream.stopAt = this.#now() + displayDemandGraceMs;
      return;
    }
    if (event.type === "runner.integrations.display.source-ended") {
      if (event.source.kind === "owner-view")
        this.#options.computerViews.endDisplaySource(event.source, runnerId, event.reason);
      this.#endSource(stream, event.source, event.reason);
      return;
    }
    if (event.streamId !== stream.streamId) return;
    if (event.generation < stream.generation) return;
    // Media already proves this generation started, regardless of state-socket delay.
    if (event.state === "starting" && event.generation <= stream.mediaGeneration) return;
    if (!stream.target && event.state === "failed" && event.reason === "data-socket-failed") {
      this.#end(stream, displayViewerCloseCodes.tryAgain, "Display data socket ended");
      return;
    }
    if (event.generation !== stream.generation || event.state !== "live") {
      this.#clearCache(stream);
      for (const viewer of stream.viewers) viewer.waiting = true;
    }
    if (
      event.state === "protected" ||
      event.state === "screen-off" ||
      event.state === "stopped" ||
      event.state === "failed"
    )
      stream.withheldThrough = Math.max(stream.withheldThrough, event.generation);
    const waking = event.state === "live" && stream.state.state === "screen-off";
    const becameLive = event.state === "live" && stream.state.state !== "live";
    stream.generation = event.generation;
    this.#publishState(stream, {
      type: "display.state",
      state: event.state,
      generation: event.generation,
      width: event.width,
      height: event.height,
      ...(event.reason === undefined ? {} : { reason: event.reason }),
    });
    if (
      event.state === "live" &&
      (waking || (becameLive && [...stream.viewers].some((viewer) => viewer.keyframePending))) &&
      [...stream.viewers].some((viewer) => viewer.waiting)
    )
      this.#refresh(stream);
    if (event.state === "failed" || event.state === "stopped") {
      const retiredWarm =
        event.state === "stopped" &&
        event.reason === "capacity" &&
        stream.stopAt !== null &&
        !stream.viewers.size;
      if (stream.target && !retiredWarm)
        this.#failOwnerSources(
          stream,
          event.reason === "data-socket-failed"
            ? "capture-failed"
            : (event.reason ?? "capture-failed"),
        );
      this.#end(stream, displayViewerCloseCodes.ended, "Display stopped");
    }
  }

  /**
   * Records and relays the stream's state, unless it already is that state: a
   * phone's late announcement of a generation the Host made live from its media
   * must not reach viewers as a second, replay-less state.
   */
  #publishState(stream: Stream, next: DisplayViewerState): void {
    const current = stream.state;
    if (
      current.state === next.state &&
      current.generation === next.generation &&
      current.width === next.width &&
      current.height === next.height &&
      current.reason === next.reason
    )
      return;
    if (current.generation !== next.generation || next.state !== "live") {
      this.#resetInput(stream);
      for (const pending of stream.pending.values()) {
        if (!stream.viewers.has(pending.viewer)) continue;
        if (pending.result)
          this.#json(pending.viewer.socket, {
            type: "display.input.result",
            sequence: pending.sequence,
            outcome: "stale",
            reason: "stale",
          });
        if (pending.copy)
          this.#json(pending.viewer.socket, {
            type: "display.clipboard",
            sequence: pending.sequence,
            outcome: "refused",
          });
      }
      stream.pending.clear();
    }
    stream.state = next;
    this.#options.onState?.(stream.runnerId, stream.streamId, next);
    this.#log(
      stream,
      next.state === "live" && !stream.firstKey
        ? "first-frame"
        : next.state === "protected"
          ? "suppressed"
          : next.state,
      next.reason,
    );
    for (const viewer of stream.viewers) this.#viewerState(stream, viewer, next);
  }

  #viewerState(stream: Stream, viewer: Viewer, state: DisplayViewerState): void {
    const {
      editingVersion: _editingVersion,
      displayCut: _displayCut,
      sharedInput: _sharedInput,
      ...baseline
    } = state;
    this.#json(viewer.socket, {
      ...baseline,
      ...(this.#inputAvailable(stream, viewer) ? { sharedInput: 1 } : {}),
      ...(viewer.displayCut && stream.displayCut === 1 && !stream.target ? { displayCut: 1 } : {}),
      ...(viewer.editing &&
      (stream.editingVersion === 1 ||
        (viewer.source.kind === "owner-view" && stream.target?.editingVersion === 1))
        ? { editingVersion: 1 }
        : {}),
    });
  }

  #viewerMessage(stream: Stream, viewer: Viewer, message: DisplayViewerClientMessage): void {
    if (
      viewer.socket.readyState !== viewer.socket.OPEN ||
      !stream.viewers.has(viewer) ||
      !this.#viewerLive(stream, viewer) ||
      !this.#current(stream)
    )
      return;
    if (message.type === "display.viewport") {
      if (stream.target && viewer.maxLongSide !== message.maxLongSide) {
        viewer.maxLongSide = message.maxLongSide;
        stream.profileAt = this.#now() + macDisplayProfileHysteresisMs;
      }
      return;
    }
    if (message.type === "display.keyframe") {
      if (viewer.keyframePending || this.#now() - viewer.keyframeAt < displayRefreshCoalescingMs)
        return;
      viewer.keyframeAt = this.#now();
      viewer.keyframePending = true;
      // Discard unsent replay work and reset decoder credit. Writes already sent
      // precede the reset state on the socket and still receive exactly one ack.
      if (
        viewer.discarded.length + viewer.outstanding.size >
        displayGopCacheFrames + displayViewerCreditFrames
      ) {
        viewer.socket.close(
          displayViewerCloseCodes.tryAgain,
          "Display decoder resets did not drain",
        );
        return;
      }
      viewer.discarded.push(...viewer.outstanding.keys());
      viewer.outstanding.clear();
      viewer.bytes = 0;
      viewer.replayIndex = null;
      viewer.replayThrough = null;
      viewer.waiting = true;
      if (!this.#replay(stream, viewer) && stream.state.state === "live") this.#refresh(stream);
      return;
    }
    if (message.type === "display.ack") {
      if (viewer.discarded.length > 0) {
        if (viewer.discarded[0] === message.sequence) {
          viewer.discarded.shift();
          viewer.slowSince = null;
          if (viewer.replayIndex !== null) this.#drainCache(stream, viewer);
        }
        return;
      }
      // Only actually sent, unacknowledged sequences can return credit. Replaying
      // a GOP can legitimately output sequences older than a prior acknowledgement.
      if (!viewer.outstanding.has(message.sequence)) return;
      // Decoder outputs in stream order: acknowledgement returns all earlier credits.
      for (const [sequence, bytes] of viewer.outstanding)
        if (sequence <= message.sequence) {
          viewer.outstanding.delete(sequence);
          viewer.bytes -= bytes;
        }
      // Any valid acknowledgement is progress, even while a byte-only replay
      // still has more than four frames outstanding.
      viewer.slowSince = null;
      if (viewer.waiting && viewer.outstanding.size === 0) this.#replay(stream, viewer);
      if (viewer.replayIndex !== null) this.#drainCache(stream, viewer);
      return;
    }
    if (message.type === "display.control") {
      if (message.action === "acquire")
        this.#json(viewer.socket, {
          type: "display.control",
          state: "refused",
          reason: "released-by-owner",
        });
      return;
    }
    if (message.type === "display.input-reset") {
      if (stream.holder === viewer) this.#resetInput(stream);
      return;
    }
    if (message.type !== "display.input" || "controlId" in message) return;
    if (!viewer.sharedInput || message.sequence <= viewer.inputSequence) return;
    viewer.inputSequence = message.sequence;
    const extended = message.events.some(
      (event) => !["pointer", "scroll", "nav", "text"].includes(event.kind),
    );
    const editing =
      viewer.editing && (stream.editingVersion === 1 || stream.target?.editingVersion === 1);
    const reason =
      !this.#inputAvailable(stream, viewer) || stream.state.state !== "live"
        ? "unavailable"
        : message.geometry !== stream.generation
          ? "stale"
          : stream.holder && stream.holder !== viewer
            ? "contended"
            : (extended && !editing) ||
                (!stream.target &&
                  message.events.some(
                    (event) =>
                      event.kind === "mouse" || (event.kind === "paste" && "items" in event),
                  )) ||
                (message.events.some((event) => event.kind === "cut") &&
                  (!viewer.displayCut || stream.displayCut !== 1))
              ? "unsupported"
              : stream.pending.size >= 128
                ? "too-large"
                : null;
    if (reason) {
      viewer.inputCounters.refusals[reason] = (viewer.inputCounters.refusals[reason] ?? 0) + 1;
      this.#json(viewer.socket, {
        type: "display.input.result",
        sequence: message.sequence,
        outcome: reason === "stale" ? "stale" : "refused",
        reason,
      });
      return;
    }
    const sequence = stream.inputSequence++;
    if (editing)
      stream.pending.set(sequence, {
        viewer,
        sequence: message.sequence,
        geometry: message.geometry,
        result: true,
        copy: message.events.some((event) => event.kind === "copy" || event.kind === "cut"),
        cut: message.events.some((event) => event.kind === "cut"),
      });
    for (const event of message.events) {
      viewer.inputCounters.operations[event.kind] =
        (viewer.inputCounters.operations[event.kind] ?? 0) + 1;
      trackHeldDisplayInput(stream.held, event);
    }
    stream.holder = stream.held.size ? viewer : null;
    stream.holderSequence = sequence;
    if (stream.target && viewer.source.kind === "owner-view") {
      this.#send(stream, {
        ...stream.fence,
        type: "host.integrations.mac-owner.input",
        streamId: stream.streamId,
        source: viewer.source,
        geometry: message.geometry,
        sequence,
        events: message.events,
      });
    } else if (viewer.source.kind === "task-session") {
      this.#options.computerUse.noteOwnerActivity(viewer.source.sessionId);
      this.#send(stream, {
        ...stream.fence,
        type: "host.integrations.display.input",
        sessionId: viewer.source.sessionId,
        streamId: stream.streamId,
        geometry: message.geometry,
        sequence,
        events: message.events,
      });
    }
  }

  #inputAuthorization(stream: Stream, viewer: Viewer, authorized: boolean): void {
    if (
      !stream.viewers.has(viewer) ||
      this.#streams.get(stream.streamId) !== stream ||
      viewer.authorized === authorized
    )
      return;
    viewer.authorized = authorized;
    if (!authorized && stream.holder === viewer) this.#resetInput(stream);
    this.#viewerState(stream, viewer, stream.state);
  }

  #inputAvailable(stream: Stream, viewer: Viewer): boolean {
    return (
      viewer.sharedInput &&
      viewer.authorized &&
      (stream.target
        ? stream.target.editingVersion === 1 && viewer.source.kind === "owner-view"
        : stream.sharedInput === 1 && viewer.source.kind === "task-session")
    );
  }

  #resetInput(stream: Stream): void {
    const holder = stream.holder;
    if (!holder) return;
    stream.holder = null;
    stream.held.clear();
    if (stream.target && holder.source.kind === "owner-view")
      this.#send(stream, {
        ...stream.fence,
        type: "host.integrations.mac-owner.input-reset",
        streamId: stream.streamId,
        source: holder.source,
      });
    else if (holder.source.kind === "task-session")
      this.#send(stream, {
        ...stream.fence,
        type: "host.integrations.display.input-reset",
        sessionId: holder.source.sessionId,
        streamId: stream.streamId,
      });
  }

  #inputEvent(
    stream: Stream,
    message: DisplayInputResult | DisplayClipboard | DisplayEditing,
    geometry?: number,
    source?: DisplaySource,
  ): void {
    if (stream.state.state !== "live" || (geometry !== undefined && geometry !== stream.generation))
      return;
    if (message.type === "display.editing") {
      if (message.generation !== stream.generation) return;
      for (const viewer of stream.viewers)
        if (
          this.#inputAvailable(stream, viewer) &&
          viewer.editing &&
          this.#viewerLive(stream, viewer)
        ) {
          this.#json(viewer.socket, message);
          viewer.inputCounters.contextUpdates++;
        }
      return;
    }
    const pending = stream.pending.get(message.sequence);
    if (
      !pending ||
      pending.geometry !== stream.generation ||
      !stream.viewers.has(pending.viewer) ||
      !this.#inputAvailable(stream, pending.viewer) ||
      !this.#viewerLive(stream, pending.viewer)
    )
      return;
    if (
      source &&
      (source.kind === "task-session"
        ? pending.viewer.source.kind !== "task-session" ||
          source.sessionId !== pending.viewer.source.sessionId
        : displaySourceKey(source) !== displaySourceKey(pending.viewer.source))
    )
      return;
    if (message.type === "display.input.result") {
      if (!pending.result) return;
      pending.result = false;
      if (message.outcome !== "dispatched") pending.copy = false;
    } else {
      if (!pending.copy || (message.outcome === "cut" && !pending.cut)) return;
      pending.copy = false;
    }
    this.#json(pending.viewer.socket, { ...message, sequence: pending.sequence });
    if (!pending.result && !pending.copy) stream.pending.delete(message.sequence);
    // The producer refused the press the lane is held by. With no later batch
    // from the holder to cut short, the lane ends so other viewers can type.
    if (
      message.type === "display.input.result" &&
      message.outcome !== "dispatched" &&
      stream.holder === pending.viewer &&
      stream.holderSequence === message.sequence
    )
      this.#resetInput(stream);
  }

  #clearCache(stream: Stream): void {
    stream.cache = [];
    stream.cacheBytes = 0;
    for (const viewer of stream.viewers) {
      if (viewer.replayIndex === null) continue;
      viewer.replayIndex = null;
      viewer.replayThrough = null;
      viewer.waiting = true;
    }
  }
  #hasCredit(viewer: Viewer, bytes: number, replay = false): boolean {
    return (
      (replay || viewer.outstanding.size < displayViewerCreditFrames) &&
      (viewer.outstanding.size === 0 || viewer.bytes + bytes <= displayViewerCreditBytes)
    );
  }
  #sendFrame(viewer: Viewer, frame: CachedFrame): void {
    viewer.outstanding.set(frame.sequence, frame.bytes.byteLength);
    viewer.bytes += frame.bytes.byteLength;
    this.#binary(viewer.socket, frame.bytes);
  }
  #skip(stream: Stream, viewer: Viewer): void {
    viewer.replayIndex = null;
    viewer.replayThrough = null;
    viewer.waiting = true;
    viewer.slowSince ??= this.#now();
    if (stream.cache.length === 0 && stream.state.state === "live") this.#refresh(stream);
  }
  #replay(stream: Stream, viewer: Viewer): boolean {
    if (!this.#viewerLive(stream, viewer)) return false;
    const last = stream.cache.at(-1);
    if (!last) return false;
    viewer.replayIndex = 0;
    viewer.replayThrough = last.sequence;
    viewer.keyframePending = false;
    viewer.waiting = false;
    this.#viewerState(stream, viewer, { ...stream.state, replayThrough: last.sequence });
    this.#drainCache(stream, viewer);
    return true;
  }
  #drainCache(stream: Stream, viewer: Viewer): void {
    if (viewer.replayIndex === null || !this.#viewerLive(stream, viewer)) return;
    // Indexing visits each cached frame once per replay, independent of ack count.
    while (viewer.replayIndex < stream.cache.length) {
      const frame = stream.cache[viewer.replayIndex]!;
      if (
        !this.#hasCredit(viewer, frame.bytes.byteLength, frame.sequence <= viewer.replayThrough!)
      ) {
        viewer.slowSince ??= this.#now();
        return;
      }
      this.#sendFrame(viewer, frame);
      viewer.replayIndex += 1;
      viewer.slowSince = null;
    }
    // Keep the catch-up lane until its deliveries drain. Newly arriving live
    // frames still pay both credits, but wait here rather than causing a skip
    // merely because the preceding replay used more than four frame slots.
    if (viewer.outstanding.size === 0) {
      viewer.replayIndex = null;
      viewer.replayThrough = null;
    }
  }

  #refresh(stream: Stream): void {
    if (this.#now() - stream.refreshAt < displayRefreshCoalescingMs) {
      stream.refreshPending = true;
      return;
    }
    stream.refreshAt = this.#now();
    stream.refreshPending = false;
    this.#send(stream, {
      ...stream.fence,
      type: "host.integrations.display.refresh",
      display: "main",
      streamId: stream.streamId,
    });
  }
  #current(stream: Stream): boolean {
    const live = this.#options.computerApps.displayStream(stream.runnerId);
    return (
      !this.#closed &&
      this.#streams.get(stream.streamId) === stream &&
      live !== null &&
      live !== "unsupported" &&
      sameRunnerAuxiliaryFence(live.fence, stream.fence)
    );
  }
  #send(stream: Stream, message: HostIntegrationsOperation): void {
    void this.#options.computerApps
      .sendDisplay(stream.fence, message)
      .then((sent) => {
        if (!sent) {
          if (stream.target) this.#failCapture(stream, "capture-failed");
          else
            this.#end(
              stream,
              displayViewerCloseCodes.tryAgain,
              "Display command could not be sent",
            );
        }
      })
      .catch(() => {
        if (stream.target) this.#failCapture(stream, "capture-failed");
        else
          this.#end(stream, displayViewerCloseCodes.tryAgain, "Display command could not be sent");
      });
  }
  #canSend(socket: WebSocket, bytes: number): boolean {
    if (socket.readyState !== socket.OPEN) return false;
    if (socket.bufferedAmount + bytes > displaySocketBufferedBytes) {
      socket.close(displayViewerCloseCodes.tryAgain, "Display socket buffer exceeded");
      return false;
    }
    return true;
  }
  #json(socket: WebSocket, message: unknown): void {
    const frame = JSON.stringify(message);
    if (this.#canSend(socket, Buffer.byteLength(frame)))
      socket.send(frame, (error) => {
        if (error) socket.close(displayViewerCloseCodes.tryAgain, "Display send failed");
      });
  }
  #binary(socket: WebSocket, bytes: Uint8Array): void {
    if (this.#canSend(socket, bytes.byteLength))
      socket.send(bytes, { binary: true }, (error) => {
        if (error) socket.close(displayViewerCloseCodes.tryAgain, "Display send failed");
      });
  }
  sweep(): void {
    for (const stream of this.#streams.values()) {
      if (!this.#current(stream)) {
        this.#endUnavailable(stream, "Display session ended");
        continue;
      }
      for (const viewer of stream.viewers) this.#viewerLive(stream, viewer);
      for (const viewer of stream.viewers) {
        // Every owner viewer that can type is rechecked, idle or not, so a
        // granted or removed approval reaches it without a reconnect.
        if (
          stream.target?.editingVersion !== 1 ||
          viewer.source.kind !== "owner-view" ||
          !viewer.sharedInput ||
          viewer.checking ||
          this.#now() - viewer.checkedAt < 5_000
        )
          continue;
        viewer.checking = true;
        void this.#options.computerViews
          .authorizeInput?.(viewer.source, viewer.actor)
          .then((runner) => this.#inputAuthorization(stream, viewer, runner === stream.runnerId))
          .catch(() => this.#inputAuthorization(stream, viewer, false))
          .finally(() => {
            viewer.checkedAt = this.#now();
            viewer.checking = false;
          });
      }
      for (const { source, actor } of stream.authorities.values())
        if (!this.#sourceLive(source, actor, stream.runnerId))
          this.#endSource(
            stream,
            source,
            source.kind === "task-session" ? "session-ended" : "owner-ended",
          );
      if (stream.profileAt !== null && this.#now() >= stream.profileAt && stream.viewers.size) {
        stream.profileAt = null;
        const requested = Math.max(...[...stream.viewers].map((viewer) => viewer.maxLongSide));
        if (Math.abs(requested - stream.maxLongSide) >= 160) {
          stream.maxLongSide = requested;
          stream.demandKey = "";
          this.#demand(stream);
        }
      }
      if (stream.target && !stream.firstKey && this.#now() >= stream.firstFrameDeadline) {
        this.#failCapture(stream, "capture-timeout");
        continue;
      }
      if (!stream.data && this.#now() >= stream.expiresAt) {
        this.#end(stream, displayViewerCloseCodes.tryAgain, "Display start timed out");
        continue;
      }
      if (stream.stopAt !== null && this.#now() >= stream.stopAt) {
        this.#end(stream, displayViewerCloseCodes.ended, "Display demand ended");
        continue;
      }
      for (const viewer of stream.viewers)
        if (
          viewer.slowSince !== null &&
          this.#now() - viewer.slowSince >= displaySlowViewerCloseMs
        ) {
          viewer.removalTrigger = "slow-viewer";
          viewer.socket.close(displayViewerCloseCodes.tryAgain, "Display viewer stalled");
        }
      if (
        stream.state.state === "live" &&
        stream.refreshPending &&
        [...stream.viewers].some((viewer) => viewer.waiting) &&
        this.#now() - stream.refreshAt >= displayRefreshCoalescingMs
      )
        this.#refresh(stream);
      else if (![...stream.viewers].some((viewer) => viewer.waiting)) stream.refreshPending = false;
    }
  }
  #sourceLive(source: DisplaySource, actor: UserId, runnerId: RunnerId): boolean {
    return source.kind === "task-session"
      ? this.#options.computerUse.isDisplaySessionLive(source.sessionId, runnerId, source.appKey)
      : this.#options.computerViews.isDisplayLive(source, actor, runnerId);
  }
  #viewerLive(stream: Stream, viewer: Viewer): boolean {
    if (!stream.viewers.has(viewer)) return false;
    if (this.#sourceLive(viewer.source, viewer.actor, stream.runnerId)) return true;
    this.#endSource(
      stream,
      viewer.source,
      viewer.source.kind === "task-session" ? "session-ended" : "owner-ended",
    );
    return false;
  }
  #demand(stream: Stream): void {
    const sources = [
      ...new Map(
        [...stream.viewers].map((viewer) => [displaySourceKey(viewer.source), viewer.source]),
      ).values(),
    ];
    const warmSources =
      stream.target && !sources.length
        ? [...stream.authorities.values()]
            .filter(({ source, actor }) => this.#sourceLive(source, actor, stream.runnerId))
            .map(({ source }) => source)
        : [];
    if (sources.length) {
      stream.stopAt = null;
      stream.authorities.clear();
      for (const viewer of stream.viewers)
        stream.authorities.set(displaySourceKey(viewer.source), {
          source: viewer.source,
          actor: viewer.actor,
        });
    }
    const warm = warmSources.length
      ? { sources: warmSources, durationMs: macDisplayWarmMs }
      : undefined;
    const key = JSON.stringify({ sources, warm });
    if (stream.demandKey === key) return;
    stream.demandKey = key;
    if (!sources.length) {
      this.#clearCache(stream);
      if (stream.target) {
        if (!warm) {
          this.#end(stream, displayViewerCloseCodes.ended, "Display authority ended");
          return;
        }
        stream.stopAt ??= this.#now() + macDisplayWarmMs;
        this.#publishState(stream, { ...stream.state, state: "warming" });
        const warming = [...this.#streams.values()]
          .filter(
            (entry) => entry.runnerId === stream.runnerId && entry.target && entry.stopAt !== null,
          )
          .sort((a, b) => a.stopAt! - b.stopAt!);
        for (const old of warming.slice(0, Math.max(0, warming.length - macDisplayMaxWarmWindows)))
          this.#end(old, displayViewerCloseCodes.ended, "Warm capacity eviction");
      } else {
        stream.withheldThrough = Math.max(stream.withheldThrough, stream.generation);
        this.#publishState(stream, { ...stream.state, state: "protected" });
      }
    }
    this.#send(stream, {
      ...stream.fence,
      type: "host.integrations.display.demand",
      display: "main",
      streamId: stream.streamId,
      revision: ++stream.revision,
      sources,
      ...(warm ? { warm } : {}),
      ...(stream.target ? { maxLongSide: stream.maxLongSide } : {}),
    });
  }
  #log(stream: Stream, transition: string, reason?: string): void {
    const details = {
      transition,
      reason: reason ?? transition,
      machineId: stream.runnerId,
      streamId: stream.streamId,
      mediaGeneration: stream.generation,
    };
    if (!stream.authorities.size) this.#options.log?.("computer.display.lifecycle", details);
    for (const { source } of stream.authorities.values())
      this.#options.log?.("computer.display.lifecycle", {
        ...details,
        ...source,
      });
  }
  #viewerRemoved(
    stream: Stream,
    viewer: Viewer,
    trigger: string,
    code?: number,
    reason?: string,
  ): void {
    const source = viewer.source;
    if (stream.holder === viewer) this.#resetInput(stream);
    for (const [sequence, pending] of stream.pending)
      if (pending.viewer === viewer) stream.pending.delete(sequence);
    this.#options.log?.("computer.display.viewer-removed", {
      streamId: stream.streamId,
      mediaGeneration: stream.generation,
      kind: source.kind,
      ...(source.kind === "task-session"
        ? { sessionId: source.sessionId }
        : { viewId: source.viewId, generation: source.generation }),
      trigger,
      code,
      reason,
      remainingViewers: stream.viewers.size,
      ...(viewer.editing ? { editing: viewer.inputCounters } : {}),
    });
  }
  #endSource(stream: Stream, source: DisplaySource, reason: DisplayStreamReason): void {
    if (this.#streams.get(stream.streamId) !== stream) return;
    let removed = stream.authorities.delete(displaySourceKey(source));
    for (const viewer of stream.viewers) {
      if (displaySourceKey(viewer.source) !== displaySourceKey(source)) continue;
      this.#viewerState(stream, viewer, { ...stream.state, state: "stopped", reason });
      removed = true;
      stream.viewers.delete(viewer);
      this.#viewerRemoved(stream, viewer, "end-source", displayViewerCloseCodes.ended, reason);
      viewer.outstanding.clear();
      viewer.replayIndex = null;
      viewer.socket.close(displayViewerCloseCodes.ended, reason);
    }
    if (!removed) return;
    if (!stream.viewers.size && !stream.authorities.size) {
      this.#end(stream, displayViewerCloseCodes.ended, reason);
      return;
    }
    this.#demand(stream);
  }
  endSession(sessionId: ComputerUseSessionId): void {
    for (const stream of this.#streams.values())
      for (const { source } of stream.authorities.values())
        if (source.kind === "task-session" && source.sessionId === sessionId)
          this.#endSource(stream, source, "session-ended");
  }

  endOwnerView(
    viewId: ComputerViewId,
    generation: number,
    reason: "closed" | "expired" | "revoked" | "disconnected" | "host-restarted",
  ): void {
    for (const stream of this.#streams.values())
      this.#endSource(
        stream,
        { kind: "owner-view", viewId, generation },
        reason === "expired"
          ? "owner-expired"
          : reason === "revoked"
            ? "owner-revoked"
            : "owner-ended",
      );
  }
  forgetRunner(
    runnerId: RunnerId,
    reason: RunnerStreamLossReason = "transport-disconnected",
  ): void {
    const code =
      reason === "revoked"
        ? displayViewerCloseCodes.accessEnded
        : reason === "host-shutdown"
          ? displayViewerCloseCodes.hostShutdown
          : displayViewerCloseCodes.ended;
    for (const stream of this.#streams.values())
      if (stream.runnerId === runnerId) this.#end(stream, code, "Phone disconnected", 4003);
  }
  #failOwnerSources(stream: Stream, reason: DisplayStreamReason): void {
    for (const viewer of stream.viewers)
      if (viewer.source.kind === "owner-view")
        this.#options.computerViews.endDisplaySource(viewer.source, stream.runnerId, reason);
  }
  #failCapture(stream: Stream, reason: DisplayStreamReason): void {
    if (this.#streams.get(stream.streamId) !== stream) return;
    this.#clearCache(stream);
    stream.withheldThrough = Number.MAX_SAFE_INTEGER;
    this.#publishState(stream, {
      type: "display.state",
      state: "failed",
      reason,
      generation: stream.generation,
      width: 0,
      height: 0,
    });
    this.#failOwnerSources(stream, reason);
    this.#end(stream, displayViewerCloseCodes.ended, "Window capture failed");
  }

  #endUnavailable(stream: Stream, reason: string): void {
    const code =
      stream.target || this.#options.computerApps.displayStream(stream.runnerId) === "unsupported"
        ? displayViewerCloseCodes.ended
        : displayViewerCloseCodes.tryAgain;
    this.#end(stream, code, reason, 4003);
  }

  /**
   * Ends a stream. A viewer the Host closes for good first learns how it ended:
   * the phone's own final state can lose the race to its session's end, which
   * reaches the Host by another path.
   */
  #end(
    stream: Stream,
    code: number,
    reason: string,
    dataCode = code,
    ended?: DisplayStreamReason,
  ): void {
    if (this.#streams.get(stream.streamId) !== stream) return;
    const endReason =
      ended ??
      (["stopped", "failed", "unsupported"].includes(stream.state.state)
        ? stream.state.reason
        : undefined) ??
      reason;
    this.#log(stream, "closed", endReason);
    const terminal =
      code === displayViewerCloseCodes.ended ||
      code === displayViewerCloseCodes.accessEnded ||
      code === displayViewerCloseCodes.hostShutdown;
    const settled = ["stopped", "failed", "unsupported"].includes(stream.state.state);
    if (terminal && !settled)
      this.#publishState(stream, {
        type: "display.state",
        state: "stopped",
        generation: stream.generation,
        width: stream.state.width,
        height: stream.state.height,
        ...(ended === undefined ? {} : { reason: ended }),
      });
    this.#streams.delete(stream.streamId);
    if (this.#byTarget.get(stream.key) === stream) this.#byTarget.delete(stream.key);
    this.#resetInput(stream);
    this.#send(stream, {
      ...stream.fence,
      type: "host.integrations.display.stop",
      display: "main",
      streamId: stream.streamId,
    });
    stream.data?.close(dataCode, reason);
    for (const viewer of stream.viewers) {
      stream.viewers.delete(viewer);
      this.#viewerRemoved(stream, viewer, "end", code, endReason);
      viewer.socket.close(code, reason);
    }
    stream.viewers.clear();
  }
  close(): void {
    if (this.#closed) return;
    for (const stream of this.#streams.values())
      this.#end(stream, displayViewerCloseCodes.hostShutdown, "Host stopping");
    this.#closed = true;
    clearInterval(this.#timer);
  }
}
