import { WebSocket } from "ws";
import {
  BrowserVideoBudgetSchema,
  BrowserVideoSourceAckSchema,
  decodeBrowserVideoFrame,
  displayMaxEnvelopeBytes,
  type BrowserVideoState,
  type DisplayStreamId,
} from "@opensteer/protocol";
import type { BrowserVideoOperation } from "@opensteer/protocol/browser-relay";
import { MediaForwarder } from "@opensteer/shared/mediaForwarder";
import { rawDataBuffer } from "@opensteer/shared/webSocketFrame";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { runnerWebSocketTransport, type RunnerTransportPolicy } from "./transport.js";
import type { LocalBrowserRuntimeBridge } from "./browser-bridge.js";

type RateUpdate = Extract<BrowserVideoOperation, { type: "browser.video.budget" }>;
type Start = Extract<BrowserVideoOperation, { type: "browser.video.start" }>;
interface Entry {
  start: Start;
  closed: boolean;
  active: boolean;
  data: WebSocket | null;
  media: WebSocket | null;
  forwarding: MediaForwarder<ReturnType<typeof BrowserVideoSourceAckSchema.parse>> | null;
  budget: RateUpdate | null;
  revision: number;
  keyframe: boolean;
  effective: string;
  state: BrowserVideoState | null;
  updating: Promise<void> | null;
  reportedCap: number;
  ping: { at: number; payload: string } | null;
}
/** Dedicated media sockets; no encoded bytes use the auxiliary/control queue. */
export class BrowserVideoRelay {
  readonly #entries = new Map<DisplayStreamId, Entry>();
  readonly bridge: LocalBrowserRuntimeBridge;
  readonly transport: RunnerTransportPolicy;
  readonly emit: (operation: Start, state: BrowserVideoState) => void;
  constructor(
    bridge: LocalBrowserRuntimeBridge,
    transport: RunnerTransportPolicy,
    emit: (operation: Start, state: BrowserVideoState) => void,
  ) {
    this.bridge = bridge;
    this.transport = transport;
    this.emit = emit;
  }
  handle(operation: BrowserVideoOperation): void {
    if (operation.type === "browser.video.start") {
      if (this.#entries.has(operation.streamId)) return;
      const entry: Entry = {
        start: operation,
        closed: false,
        active: false,
        data: null,
        media: null,
        forwarding: null,
        budget: null,
        revision: 0,
        keyframe: false,
        effective: JSON.stringify(operation.budget),
        state: null,
        updating: null,
        reportedCap: 1000000,
        ping: null,
      };
      this.#entries.set(operation.streamId, entry);
      void this.#start(entry).catch(() => this.#fail(entry));
      return;
    }
    const entry = this.#entries.get(operation.streamId);
    if (
      !entry ||
      entry.closed ||
      entry.start.channelId !== operation.channelId ||
      entry.start.target.sessionId !== operation.target.sessionId ||
      entry.start.target.surfaceId !== operation.target.surfaceId
    )
      return;
    if (operation.type === "browser.video.stop") {
      this.#close(entry);
      return;
    }
    if (operation.type === "browser.video.budget") {
      if (entry.budget && operation.revision <= entry.budget.revision) return;
      entry.budget = operation;
      this.#budget(entry);
      return;
    }
    if (!entry.active) {
      entry.keyframe = true;
      return;
    }
    void this.bridge.sendVideo(operation).catch(() => this.#fail(entry));
  }
  state(channelId: string, state: BrowserVideoState): Start | undefined {
    const e = this.#entries.get(state.streamId);
    if (
      !e ||
      e.closed ||
      e.start.channelId !== channelId ||
      e.start.target.surfaceId !== state.surfaceId
    )
      return;
    e.state = state;
    if (state.state === "stopped" || state.state === "failed") this.#close(e);
    return e.start;
  }
  closeChannel(channelId: string): void {
    for (const e of this.#entries.values()) if (e.start.channelId === channelId) this.#close(e);
  }
  close(): void {
    for (const e of this.#entries.values()) this.#close(e);
  }
  async #start(e: Entry): Promise<void> {
    const deadline = Date.now() + e.start.timeoutMs;
    const transport = await runnerWebSocketTransport(this.transport, "/internal/v1/browser/video");
    if (e.closed) return;
    const data = new WebSocket(transport.url, {
      headers: { authorization: `Bearer ${e.start.dataTicket}` },
      ...(transport.ca ? { ca: transport.ca } : {}),
      rejectUnauthorized: true,
      followRedirects: false,
      perMessageDeflate: false,
      maxPayload: 16384,
    });
    e.data = data;
    data.on("error", () => this.#fail(e));
    data.once("close", () => this.#fail(e));
    const opened = Promise.withResolvers<void>();
    data.once("open", () => opened.resolve());
    data.once("error", () => opened.reject(new Error("Browser media admission failed")));
    data.once("close", () => opened.reject(new Error("Browser media admission ended")));
    await withTimeout(opened.promise, Math.max(1, deadline - Date.now()), {
      timeoutError: () => new Error("Browser media admission timed out"),
    });
    if (e.closed) return;
    const media = await this.bridge.openVideo(e.start.channelId, e.start.streamId);
    if (e.closed) {
      media.terminate();
      return;
    }
    e.media = media;
    media.on("error", () => this.#fail(e));
    media.once("close", () => this.#fail(e));
    e.forwarding = new MediaForwarder({
      maxFrames: e.start.creditWindow,
      maxBytes: e.start.creditWindow * displayMaxEnvelopeBytes,
      rate: { initialBitrate: 1_000_000, minimumBitrate: 50_000, maximumBitrate: 20_000_000 },
      writable: (bytes) =>
        data.readyState === WebSocket.OPEN &&
        data.bufferedAmount + bytes <= displayMaxEnvelopeBytes,
      send: (bytes) =>
        data.send(bytes, { binary: true }, (error) => {
          if (error) this.#fail(e);
        }),
      admit: (ack) => {
        if (media.readyState !== WebSocket.OPEN) throw new Error("Browser source ended");
        media.send(JSON.stringify(ack));
      },
      failed: () => this.#fail(e),
    });
    data.on("message", (raw, binary) => {
      try {
        if (binary) throw new Error("JSON media admission required");
        const ack = BrowserVideoSourceAckSchema.parse(
          JSON.parse(rawDataBuffer(raw).toString("utf8")),
        );
        if (ack.streamId !== e.start.streamId) throw new Error("Wrong browser stream");
        e.forwarding!.ack(ack);
        this.#budget(e);
        if (!e.ping) {
          e.ping = { at: Date.now(), payload: `media-rtt:${ack.sequence}` };
          data.ping(e.ping.payload);
        }
      } catch {
        this.#fail(e);
      }
    });
    data.on("pong", (payload) => {
      if (e.ping && payload.toString() === e.ping.payload) {
        e.forwarding?.link?.roundTrip(Date.now() - e.ping.at, Date.now());
        e.ping = null;
      }
    });
    media.on("message", (raw, binary) => {
      if (e.closed) return;
      try {
        if (!binary) throw new Error("Binary browser video required");
        const bytes = rawDataBuffer(raw);
        const frame = decodeBrowserVideoFrame(bytes);
        if (frame.header.streamId !== e.start.streamId)
          throw new Error("Wrong browser video stream");
        e.forwarding!.forward(frame.header.sequence, bytes);
      } catch {
        this.#fail(e);
      }
    });
    await this.bridge.sendVideo({ ...e.start, timeoutMs: Math.max(1, deadline - Date.now()) });
    if (e.closed) return;
    e.active = true;
    this.#budget(e);
    if (e.keyframe)
      await this.bridge.sendVideo({ ...videoBinding(e.start), type: "browser.video.keyframe" });
  }
  #budget(e: Entry): void {
    if (!e.active || e.closed) return;
    const requested = e.budget?.budget ?? e.start.budget;
    const cap = e.forwarding?.link?.cap ?? 20000000;
    const budget = { ...requested, maxBitrate: Math.min(requested.maxBitrate, cap) };
    if (e.state && e.reportedCap !== cap) {
      e.reportedCap = cap;
      this.emit(e.start, { ...e.state, uplinkBitrate: cap, budget });
    }
    const encoded = JSON.stringify(budget);
    if (encoded === e.effective) return;
    e.effective = encoded;
    if (e.state) this.emit(e.start, { ...e.state, uplinkBitrate: cap, budget });
    if (e.updating) return;
    e.updating = (async () => {
      let sent = "";
      while (!e.closed && sent !== e.effective) {
        sent = e.effective;
        const budget = BrowserVideoBudgetSchema.parse(JSON.parse(sent));
        await this.bridge.sendVideo({
          ...videoBinding(e.start),
          type: "browser.video.budget",
          revision: ++e.revision,
          budget,
        });
      }
    })()
      .catch(() => this.#fail(e))
      .finally(() => {
        e.updating = null;
      });
  }
  #fail(e: Entry): void {
    if (e.closed) return;
    this.emit(e.start, {
      type: "browser.video.state",
      surfaceId: e.start.target.surfaceId,
      streamId: e.start.streamId,
      state: "failed",
      reason: "transport",
    });
    this.#close(e);
  }
  #close(e: Entry): void {
    if (e.closed) return;
    e.closed = true;
    this.#entries.delete(e.start.streamId);
    e.forwarding?.close();
    e.data?.terminate();
    e.media?.terminate();
    void this.bridge
      .sendVideo({ ...videoBinding(e.start), type: "browser.video.stop" })
      .catch(() => undefined);
  }
}

function videoBinding(start: Start) {
  const {
    auxiliaryStreamId,
    bootId,
    connectionGeneration,
    connectionId,
    connectionLeaseId,
    module,
    runnerId,
    capability,
    channelId,
    target,
    streamId,
  } = start;
  return {
    auxiliaryStreamId,
    bootId,
    connectionGeneration,
    connectionId,
    connectionLeaseId,
    module,
    runnerId,
    capability,
    channelId,
    target,
    streamId,
  };
}
