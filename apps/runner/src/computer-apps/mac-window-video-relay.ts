import {
  DisplayAckSchema,
  displayMaxEnvelopeBytes,
  displaySourceKey,
  macDisplayMaxWindows,
  decodeDisplayMediaFrame,
  displayFirstFrameTimeoutMs,
  type HostIntegrationsOperation,
  type IntegrationsModuleEvent,
  type DisplayStreamId,
  type DisplaySource,
  type DisplayInputRefusal,
} from "@opensteer/protocol";
import { runnerWebSocketTransport, type RunnerTransportPolicy } from "@opensteer/runner-client";
import { rawDataBuffer } from "@opensteer/shared/webSocketFrame";
import { WebSocket } from "ws";
import type { ComputerUseHandler } from "./computer-use-handler.js";
import { ComputerUseBridgeError } from "./computer-use-bridge-client.js";

type VideoOperation = Extract<
  HostIntegrationsOperation,
  {
    type:
      | "host.integrations.mac-owner.input-reset"
      | "host.integrations.mac-owner.input"
      | "host.integrations.display.resolve"
      | "host.integrations.display.start"
      | "host.integrations.display.demand"
      | "host.integrations.display.refresh"
      | "host.integrations.display.stop"
      | "host.integrations.display.input-reset"
      | "host.integrations.display.input";
  }
>;
type VideoEvent = Extract<
  IntegrationsModuleEvent,
  {
    type:
      | "runner.integrations.mac-owner.event"
      | "runner.integrations.display.resolved"
      | "runner.integrations.display.state"
      | "runner.integrations.display.source-ended"
      | "runner.integrations.display.source-changed";
  }
>;
export type MacVideoEvent = VideoEvent extends infer Event
  ? Event extends VideoEvent
    ? Omit<Event, keyof import("@opensteer/protocol").RunnerAuxiliaryFrameFence>
    : never
  : never;
interface Entry {
  readonly id: DisplayStreamId;
  readonly deadline: number;
  sources: readonly DisplaySource[];
  data: WebSocket | null;
  media: WebSocket | null;
  closed: boolean;
  terminal: boolean;
  endLogged?: boolean;
}

/** Binary media never enters the integrations or Desktop JSON request queues. */
export class MacWindowVideoRelay {
  readonly #computerUse: ComputerUseHandler;
  readonly #transport: RunnerTransportPolicy;
  readonly #emit: (event: MacVideoEvent) => Promise<void>;
  readonly #streams = new Map<DisplayStreamId, Entry>();
  readonly #detach: () => void;
  readonly #detachReadiness: () => void;
  readonly #detachGrants: () => void;
  #demandAccepted: Promise<void> = Promise.resolve();
  #closed = false;
  readonly #log: (event: string, fields: Readonly<Record<string, string>>) => void;
  constructor(
    computerUse: ComputerUseHandler,
    transport: RunnerTransportPolicy,
    emit: (event: MacVideoEvent) => Promise<void>,
    log: (event: string, fields: Readonly<Record<string, string>>) => void = () => undefined,
  ) {
    this.#computerUse = computerUse;
    this.#log = log;
    this.#transport = transport;
    this.#emit = emit;
    this.#detachReadiness = computerUse.onReadinessChanged((reason) =>
      this.#invalidateOwners(reason),
    );
    this.#detachGrants = computerUse.onGrantsChanged(() => {
      if (
        [...this.#streams.values()].some((entry) =>
          entry.sources.some((source) => source.kind === "owner-view"),
        )
      )
        void computerUse.revalidateReadiness();
    });
    this.#detach = computerUse.onVideoEvent((event) => {
      const entry = this.#streams.get(event.params.streamId);
      if (!entry || entry.closed) return;
      if (event.event === "display.owner-input") {
        if (
          !entry.sources.some(
            (source) => displaySourceKey(source) === displaySourceKey(event.params.source),
          )
        )
          return;
        void this.#emit({ type: "runner.integrations.mac-owner.event", ...event.params }).catch(
          () => this.#close(entry, "event-send-failed"),
        );
      } else if (event.event === "display.state") {
        if (event.params.state === "failed" || event.params.state === "stopped") {
          this.#ended(entry, event.params.reason ?? event.params.state);
          entry.terminal = true;
        }
        void this.#emit({
          type: "runner.integrations.display.state",
          display: "main",
          rotation: 0,
          ...event.params,
        }).catch(() => this.#close(entry, "event-send-failed"));
      } else if (event.event === "display.source-ended") {
        void this.#emit({
          type: "runner.integrations.display.source-ended",
          display: "main",
          ...event.params,
        }).catch(() => this.#close(entry, "event-send-failed"));
      } else {
        void this.#emit({
          type: "runner.integrations.display.source-changed",
          streamId: event.params.streamId,
          source: event.params.source,
        }).catch(() => this.#close(entry, "event-send-failed"));
      }
    });
  }

  handle(message: VideoOperation): void {
    if (this.#closed) return;
    if (message.type === "host.integrations.display.resolve") {
      void this.#computerUse
        .videoRequest(
          "display.resolve",
          {
            source: message.source,
            ...(message.ownerInputVersion === 2 ? { ownerInputVersion: 2 } : {}),
          },
          Date.now() + message.timeoutMs,
        )
        .then(
          (result) =>
            this.#emit({
              type: "runner.integrations.display.resolved",
              requestId: message.requestId,
              target: result.target,
            }),
          () =>
            this.#emit({
              type: "runner.integrations.display.resolved",
              requestId: message.requestId,
              target: null,
              reason: "target-unavailable",
            }),
        )
        .catch(() => undefined);
      return;
    }
    if (message.type === "host.integrations.display.start") {
      if (
        !message.target ||
        message.timeoutMs === undefined ||
        this.#streams.has(message.streamId) ||
        this.#streams.size >= macDisplayMaxWindows
      )
        return;
      const entry: Entry = {
        id: message.streamId,
        deadline: Date.now() + message.timeoutMs,
        sources: message.sources,
        data: null,
        media: null,
        closed: false,
        terminal: false,
      };
      this.#streams.set(entry.id, entry);
      const released = this.#demandAccepted;
      void released
        .then(() => this.#start(entry, message))
        .catch((error: unknown) =>
          this.#fail(
            entry,
            Date.now() >= entry.deadline
              ? "capture-timeout"
              : error instanceof ComputerUseBridgeError && error.code === "busy"
                ? "capacity"
                : "capture-failed",
          ),
        );
      return;
    }
    if (
      message.type === "host.integrations.mac-owner.input-reset" ||
      message.type === "host.integrations.mac-owner.input"
    ) {
      const entry = this.#streams.get(message.streamId);
      if (!entry || entry.closed || entry.terminal) return;
      if (
        !entry.sources.some(
          (source) => displaySourceKey(source) === displaySourceKey(message.source),
        )
      )
        return;
      if (message.type === "host.integrations.mac-owner.input-reset") {
        void this.#computerUse
          .videoRequest(
            "display.input-reset",
            {
              streamId: message.streamId,
              source: message.source,
            },
            Date.now() + 5_000,
          )
          .catch(() => this.#close(entry, "owner-input-reset-failed"));
      } else {
        void this.#computerUse
          .videoRequest(
            "display.input",
            {
              streamId: message.streamId,
              source: message.source,
              geometry: message.geometry,
              sequence: message.sequence,
              events: message.events,
            },
            Date.now() + 5_000,
          )
          .then((result) =>
            this.#emit({
              type: "runner.integrations.mac-owner.event",
              streamId: message.streamId,
              source: message.source,
              message: { type: "display.input.result", ...result },
            }),
          )
          .catch((error: unknown) =>
            this.#emit({
              type: "runner.integrations.mac-owner.event",
              streamId: message.streamId,
              source: message.source,
              message: {
                type: "display.input.result",
                sequence: message.sequence,
                outcome: "refused",
                reason: inputFailure(error),
              },
            }),
          )
          .catch(() => this.#close(entry, "owner-input-failed"));
      }
      return;
    }
    if (
      message.type === "host.integrations.display.input-reset" ||
      message.type === "host.integrations.display.input"
    )
      return;
    const entry = this.#streams.get(message.streamId);
    if (!entry || entry.closed) return;
    if (message.type === "host.integrations.display.stop") {
      this.#close(entry, "host-stop");
      return;
    }
    if (message.type === "host.integrations.display.demand")
      entry.sources = [...message.sources, ...(message.warm?.sources ?? [])];
    const work =
      message.type === "host.integrations.display.demand"
        ? this.#computerUse.videoRequest(
            "display.demand",
            {
              streamId: entry.id,
              revision: message.revision,
              sources: message.sources,
              ...(message.warm ? { warm: message.warm } : {}),
              ...(message.maxLongSide ? { maxLongSide: message.maxLongSide } : {}),
            },
            Date.now() + 5_000,
          )
        : this.#computerUse.videoRequest(
            "display.refresh",
            { streamId: entry.id },
            Date.now() + displayFirstFrameTimeoutMs,
          );
    if (message.type === "host.integrations.display.demand")
      this.#demandAccepted = Promise.allSettled([this.#demandAccepted, work]).then(() => undefined);
    void work.catch(() => this.#fail(entry, "capture-failed"));
  }

  async #start(
    entry: Entry,
    message: Extract<VideoOperation, { type: "host.integrations.display.start" }>,
  ): Promise<void> {
    if (!message.target || entry.closed || entry.terminal) return;
    if (Date.now() >= entry.deadline) {
      this.#fail(entry, "capture-timeout");
      return;
    }
    const started = await this.#computerUse.videoRequest(
      "display.start",
      {
        streamId: entry.id,
        target: message.target,
        sources: message.sources,
        maxLongSide: Math.min(1920, message.maxLongSide),
        maxFps: Math.min(30, message.maxFps),
      },
      entry.deadline,
    );
    if (entry.closed || entry.terminal || Date.now() >= entry.deadline) {
      void this.#computerUse
        .videoRequest("display.stop", { streamId: entry.id }, Date.now() + 5_000)
        .catch(() => undefined);
      if (!entry.closed && !entry.terminal) this.#fail(entry, "capture-timeout");
      return;
    }
    const transport = await runnerWebSocketTransport(
      this.#transport,
      "/internal/v1/computer-use/display",
    );
    if (entry.closed || entry.terminal) return;
    if (Date.now() >= entry.deadline) {
      this.#fail(entry, "capture-timeout");
      return;
    }
    const data = new WebSocket(transport.url, {
      headers: { authorization: `Bearer ${message.dataTicket}` },
      ...(transport.ca ? { ca: transport.ca } : {}),
      rejectUnauthorized: true,
      perMessageDeflate: false,
      followRedirects: false,
      maxPayload: 16 * 1_024,
    });
    entry.data = data;
    data.on("error", () => this.#close(entry, "data-socket-error"));
    data.on("close", () => this.#close(entry, "data-socket-close"));
    data.on("message", (raw, binary) => {
      try {
        if (binary) throw Error("JSON display credit required");
        const ack = DisplayAckSchema.parse(JSON.parse(rawDataBuffer(raw).toString("utf8")));
        if (entry.media?.readyState === WebSocket.OPEN) entry.media.send(JSON.stringify(ack));
      } catch {
        this.#fail(entry, "capture-failed");
      }
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("Data attachment timed out")),
        Math.max(1, entry.deadline - Date.now()),
      );
      data.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      data.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      data.once("close", () => {
        clearTimeout(timer);
        reject(Error("Data attachment ended"));
      });
    });
    if (entry.closed || entry.terminal) return;
    if (Date.now() >= entry.deadline) {
      this.#fail(entry, "capture-timeout");
      return;
    }
    const media = this.#computerUse.openVideoAttachment(started.attachmentToken);
    entry.media = media;
    const mediaEnded = (reason: string) => {
      this.#ended(entry, reason);
      if (entry.terminal || entry.closed) return;
      // The native final state and media close use separate sockets. A control
      // round trip observes any earlier native state before classifying this close.
      void this.#computerUse
        .videoRequest("display.refresh", { streamId: entry.id }, Date.now() + 5_000)
        .catch(() => undefined)
        .then(() => {
          this.#fail(entry, Date.now() >= entry.deadline ? "capture-timeout" : "capture-failed");
        });
    };
    media.on("error", () => mediaEnded("media-socket-error"));
    media.on("close", () => mediaEnded("media-socket-close"));
    media.on("message", (raw, binary) => {
      try {
        if (!binary) throw Error("Binary window media required");
        const bytes = rawDataBuffer(raw);
        const frame = decodeDisplayMediaFrame(bytes);
        if (frame.header.streamId !== entry.id || entry.closed || entry.terminal) return;
        if (
          data.readyState !== WebSocket.OPEN ||
          data.bufferedAmount + bytes.byteLength > displayMaxEnvelopeBytes
        ) {
          this.#ended(
            entry,
            data.readyState !== WebSocket.OPEN ? "data-socket-not-open" : "buffer-limit",
          );
          this.#fail(entry, "capture-failed");
          return;
        }
        data.send(bytes, { binary: true }, (error) => {
          if (error) this.#close(entry, "data-send-error");
        });
      } catch {
        this.#fail(entry, "capture-failed");
      }
    });
  }

  #invalidateOwners(reason: string): void {
    for (const entry of this.#streams.values()) {
      const owners = entry.sources.filter((source) => source.kind === "owner-view");
      if (!owners.length) continue;
      for (const source of owners)
        void this.#emit({
          type: "runner.integrations.display.source-changed",
          streamId: entry.id,
          source,
        }).catch(() => undefined);
      this.#close(entry, reason);
    }
  }

  #fail(entry: Entry, reason: "capacity" | "capture-failed" | "capture-timeout"): void {
    if (entry.closed || entry.terminal) return;
    this.#ended(entry, reason);
    entry.terminal = true;
    // Keep the Host socket until its terminal-state handler sends stop. Closing
    // it here would race the state into the transport-loss reconnect path.
    void this.#emit({
      type: "runner.integrations.display.state",
      display: "main",
      streamId: entry.id,
      state: "failed",
      reason,
      generation: Number.MAX_SAFE_INTEGER,
      width: 0,
      height: 0,
      rotation: 0,
    }).catch(() => this.#close(entry));
    entry.media?.terminate();
    void this.#computerUse
      .videoRequest("display.stop", { streamId: entry.id }, Date.now() + 5_000)
      .catch(() => undefined);
  }
  #ended(entry: Entry, reason: string): void {
    if (entry.endLogged) return;
    entry.endLogged = true;
    try {
      this.#log("computer.display.relay-ended", { streamId: entry.id, reason });
    } catch {
      /* Diagnostics cannot interrupt relay teardown. */
    }
  }
  #close(entry: Entry, reason = "owner-gone"): void {
    if (entry.closed) return;
    this.#ended(entry, reason);
    entry.closed = true;
    this.#streams.delete(entry.id);
    entry.media?.terminate();
    entry.data?.terminate();
    const released = this.#computerUse
      .videoRequest("display.stop", { streamId: entry.id }, Date.now() + 5_000)
      .catch(() => undefined);
    this.#demandAccepted = Promise.allSettled([this.#demandAccepted, released]).then(
      () => undefined,
    );
  }
  close(): void {
    this.#closed = true;
    this.#detach();
    this.#detachReadiness();
    this.#detachGrants();
    for (const entry of this.#streams.values()) this.#close(entry);
  }
}

function inputFailure(error: unknown): DisplayInputRefusal {
  if (error instanceof ComputerUseBridgeError) {
    if (error.code === "unsupported" || error.code === "incompatible-version") return "unsupported";
    if (error.code === "stale-observation") return "stale";
  }
  return "unavailable";
}
