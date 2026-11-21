import {
  standardCdpDetachFrame,
  standardCdpPath,
  standardCdpSettledReason,
  standardCdpLeasePath,
  StandardCdpLeaseReconciliationSchema,
  StandardCdpAttemptReconciliationSchema,
} from "@opensteer/protocol/standard-cdp";
export { standardCdpPath } from "@opensteer/protocol/standard-cdp";
import {
  standardCdpBufferedMaxBytes,
  standardCdpMaxPending,
  standardCdpMessageMaxBytes,
  type StandardCdpAttachment,
} from "@opensteer/browser-core";
import {
  BrowserAttachPublicKeysSchema,
  BrowserRuntimeServerMessageSchema,
  LocalProfileBindingSchema,
  type BrowserAttachPublicKey,
  type BrowserRuntimeServerMessage,
} from "@opensteer/protocol";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { closeHttpServerNow, refuseConnection } from "@opensteer/shared/httpServer";
import { createHash, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { z } from "zod";
import type { BrowserControllerSink } from "./browser/controller.js";
import { BrowserRuntimeError, toBrowserRuntimeError } from "./errors.js";
import type { BrowserAttachment, BrowserRuntime } from "./runtime.js";
import type { BrowserPoolControl } from "./browser-pool.js";
import { encodeBrowserFrame, type BrowserFrame } from "./stream/frame.js";

const standardCdpRequest = z.strictObject({
  id: z.number().int().nonnegative(),
  method: z.string().max(256),
  params: z.record(z.string(), z.unknown()).optional(),
  sessionId: z.string().max(512).optional(),
});

export interface BrowserRuntimeServerOptions {
  relayBridge?: {
    readonly token: string;
    readonly updateAttachKeys: (keys: readonly BrowserAttachPublicKey[]) => void;
  };
  host?: string;
  maxBufferedBytes?: number;
  maxCommandBytes?: number;
  port?: number;
  runtime: BrowserRuntime;
}

interface ListeningAddress {
  host: string;
  port: number;
}

export class BrowserRuntimeServer {
  private readonly host: string;
  private readonly relayBridge: BrowserRuntimeServerOptions["relayBridge"];
  private readonly httpServer: HttpServer;
  private readonly maxBufferedBytes: number;
  private readonly maxCommandBytes: number;
  private readonly port: number;
  private readonly runtime: BrowserRuntime;
  private readonly websocketServer: WebSocketServer;
  private readonly cdpServer: WebSocketServer;
  private closePromise: Promise<void> | null = null;
  private readonly relayAttachments = new Map<WebSocket, Promise<void>>();
  private relayTeardownFailed = false;
  private relayRestartPlanned = false;
  private listening: Promise<unknown> | null = null;
  private startPromise: Promise<ListeningAddress> | undefined;

  constructor(options: BrowserRuntimeServerOptions) {
    this.host = options.host ?? "127.0.0.1";
    this.relayBridge = options.relayBridge;
    this.maxBufferedBytes = options.maxBufferedBytes ?? 8 * 1_024 * 1_024;
    this.maxCommandBytes = options.maxCommandBytes ?? 1_100_000;
    this.port = options.port ?? 4_312;
    this.runtime = options.runtime;
    this.httpServer = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify(this.runtime.health()));
        return;
      }
      // A pooled runtime's signed controls arrive over the bridge (pool-runtime-in-guest.md):
      // the bridge token gates them, the controller's signature authorizes them.
      if (safePathname(request)?.startsWith("/v1/pool/")) {
        void this.poolControl(request, response).catch(() => {
          if (!response.headersSent) response.writeHead(400);
          response.end();
        });
        return;
      }
      if (safePathname(request)?.startsWith("/v1/local-profiles")) {
        void this.profileMaintenance(request, response).catch(() => {
          if (!response.headersSent)
            response.writeHead(409, { "content-type": "application/json" });
          response.end('{"error":"local-profile-maintenance-failed"}');
        });
        return;
      }
      response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      response.end('{"error":"not_found"}');
    });
    this.websocketServer = new WebSocketServer({
      maxPayload: this.maxCommandBytes,
      noServer: true,
      perMessageDeflate: false,
    });
    this.cdpServer = new WebSocketServer({
      maxPayload: standardCdpMessageMaxBytes,
      noServer: true,
      perMessageDeflate: false,
    });
    this.httpServer.on("upgrade", (request, socket, head) => {
      const pathname = safePathname(request);
      if (pathname !== "/v1/browser" && pathname !== standardCdpPath) {
        refuseConnection(socket, 404, "Not Found");
        return;
      }
      try {
        this.acceptDeviceBridgeKeys(request);
      } catch {
        refuseConnection(socket, 403, "Forbidden");
        return;
      }
      const ticket = bearerTicket(request);
      if (!ticket) {
        refuseConnection(socket, 401, "Unauthorized");
        return;
      }
      const server = pathname === standardCdpPath ? this.cdpServer : this.websocketServer;
      server.handleUpgrade(request, socket, head, (websocket) => {
        if (server === this.cdpServer) {
          const trustedBridge =
            this.relayBridge !== undefined &&
            request.headers["x-opensteer-browser-cdp-bridge"] === "1" &&
            request.headers["x-opensteer-browser-bridge-token"] === this.relayBridge.token;
          this.acceptStandardCdp(websocket, ticket, trustedBridge);
        } else server.emit("connection", websocket, request);
      });
    });
    this.websocketServer.on("connection", (websocket: WebSocket, request: IncomingMessage) => {
      const ticket = bearerTicket(request);
      if (!ticket) {
        websocket.close(1008, "attach rejected");
        return;
      }
      const bridge =
        this.relayBridge !== undefined &&
        request.headers["x-opensteer-browser-bridge-token"] === this.relayBridge.token;
      this.accept(websocket, ticket, bridge, {
        passkeys:
          Boolean(this.relayBridge) && request.headers["x-opensteer-browser-passkeys"] === "1",
      });
    });
  }

  private acceptDeviceBridgeKeys(request: IncomingMessage): void {
    const token = request.headers["x-opensteer-browser-bridge-token"];
    const encodedKeys = request.headers["x-opensteer-browser-attach-keys"];
    if (
      token === undefined &&
      encodedKeys === undefined &&
      request.headers["x-opensteer-browser-passkeys"] === undefined
    )
      return;
    const bridge = this.relayBridge;
    if (
      !bridge ||
      typeof token !== "string" ||
      typeof encodedKeys !== "string" ||
      token.length > 4_096 ||
      encodedKeys.length > 12_000 ||
      !safeTokenEqual(token, bridge.token) ||
      !/^[A-Za-z0-9_-]+$/.test(encodedKeys)
    ) {
      throw new Error("The browser device bridge is not authorized.");
    }
    const decoded = Buffer.from(encodedKeys, "base64url");
    if (decoded.byteLength > 9_000) throw new Error("The browser attach key set is too large.");
    const keys = BrowserAttachPublicKeysSchema.parse(JSON.parse(decoded.toString("utf8")));
    if (new Set(keys.map((key) => key.keyId)).size !== keys.length) {
      throw new Error("The browser attach key IDs are not unique.");
    }
    if (!this.runtime.pooled) bridge.updateAttachKeys(keys);
  }

  private async poolControl(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const token = request.headers["x-opensteer-browser-bridge-token"];
    if (
      !this.relayBridge ||
      !this.runtime.pooled ||
      typeof token !== "string" ||
      token.length > 4096 ||
      !safeTokenEqual(token, this.relayBridge.token)
    ) {
      response.writeHead(403);
      response.end();
      return;
    }
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method === "GET" && request.url === "/v1/pool/state")
      return reply(200, { state: this.runtime.poolState() });
    if (request.method !== "POST" || request.url !== "/v1/pool/control") return reply(404, {});
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      size += bytes.byteLength;
      if (size > 16 * 1024) throw new Error("The pool control exceeds its limit.");
      chunks.push(bytes);
    }
    const { control, signature } = PoolControlRequestSchema.parse(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
    );
    try {
      const state = await this.runtime.controlPool(
        control as BrowserPoolControl,
        Buffer.from(signature, "base64"),
      );
      reply(200, { state });
    } catch (error) {
      const failure = toBrowserRuntimeError(error);
      reply(409, { code: failure.code, message: failure.message, state: this.runtime.poolState() });
    }
  }

  private async profileMaintenance(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const token = request.headers["x-opensteer-browser-bridge-token"];
    if (
      !this.relayBridge ||
      typeof token !== "string" ||
      token.length > 4096 ||
      !safeTokenEqual(token, this.relayBridge.token)
    ) {
      response.writeHead(403);
      response.end();
      return;
    }
    if (request.method === "GET" && request.url === "/v1/local-profiles") {
      const profiles = await this.runtime.localProfileInventory();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ storage: this.runtime.localProfileStorage, profiles }));
      return;
    }
    if (request.method === "GET" && request.url === standardCdpLeasePath) {
      const evidence = await this.runtime.reconcileStandardCdpLease();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(evidence));
      return;
    }
    if (
      request.method === "POST" &&
      (request.url === "/v1/local-profiles/delete" || request.url === standardCdpLeasePath)
    ) {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        size += bytes.byteLength;
        if (size > 16 * 1024) throw new Error("Profile maintenance body exceeds its limit.");
        chunks.push(bytes);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (request.url === standardCdpLeasePath) {
        const reconciliation = z
          .union([StandardCdpLeaseReconciliationSchema, StandardCdpAttemptReconciliationSchema])
          .parse(body);
        const evidence = await ("attachmentId" in reconciliation
          ? this.runtime.reconcileStandardCdpAttempt(reconciliation)
          : this.runtime.reconcileStandardCdpLease(reconciliation));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(evidence));
        return;
      }
      const { binding, deletionId } = z
        .strictObject({ binding: LocalProfileBindingSchema, deletionId: z.uuid() })
        .parse(body);
      const state = await this.runtime.deleteLocalProfile(binding, deletionId);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ state }));
      return;
    }
    response.writeHead(404);
    response.end();
  }

  start(): Promise<ListeningAddress> {
    this.startPromise ??= this.startOnce();
    return this.startPromise;
  }

  private async startOnce(): Promise<ListeningAddress> {
    await this.runtime.prepare();
    if (this.closePromise) throw new Error("The browser runtime server is closing.");
    this.httpServer.listen(this.port, this.host);
    this.listening = once(this.httpServer, "listening");
    await this.listening;
    const address = this.httpServer.address();
    if (!address || typeof address === "string")
      throw new Error("Browser runtime address is unavailable.");
    return { host: this.host, port: address.port };
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const closing = this.closeOnce();
    this.closePromise = closing;
    void closing.catch(() => {
      if (this.closePromise === closing) this.closePromise = null;
    });
    return closing;
  }

  prepareRunnerRestart(): void {
    this.relayRestartPlanned = true;
  }

  /** Called by the desktop after the old relay has exited and before booting its replacement. */
  async drainRunnerAttachments(): Promise<boolean> {
    const attachments = [...this.relayAttachments];
    for (const [socket] of attachments) socket.terminate();
    const settled = await withTimeout(
      Promise.allSettled(attachments.map(([, ended]) => ended)),
      5_000,
      { timeoutError: () => new Error("Browser attachments are still closing.") },
    ).catch(() => null);
    this.relayRestartPlanned = false;
    return (
      settled !== null &&
      !this.relayTeardownFailed &&
      settled.every((result) => result.status === "fulfilled")
    );
  }

  private trackRelayAttachment(socket: WebSocket, ended: Promise<void>): void {
    this.relayAttachments.set(socket, ended);
    void ended
      .catch(() => {
        this.relayTeardownFailed = true;
      })
      .finally(() => {
        this.relayAttachments.delete(socket);
      });
  }

  private accept(
    websocket: WebSocket,
    ticket: string,
    bridge: boolean,
    options: { passkeys: boolean },
  ): void {
    const sink = new WebSocketBrowserSink(websocket, this.maxBufferedBytes);
    let attachment: BrowserAttachment | null = null;
    let disconnected = false;
    let restarting = false;
    let channelLost = false;
    const cancellation = new AbortController();
    let queuedBytes = 0;
    const queued: Buffer[] = [];

    websocket.on("message", (rawData: RawData, isBinary: boolean) => {
      if (isBinary) {
        void sendProtocolError(
          sink,
          new BrowserRuntimeError("bad_message", "Binary commands are not accepted."),
        );
        return;
      }
      const frame = normalizeRawData(rawData);
      if (frame.byteLength > this.maxCommandBytes) {
        void sendProtocolError(
          sink,
          new BrowserRuntimeError("bad_message", "The browser command is too large."),
        );
        websocket.close(1009, "command too large");
        return;
      }
      if (attachment) {
        // The controller reports a command's failure itself; this rejects only
        // when that report cannot leave, as once the socket closes.
        void attachment.handle(frame).catch(() => undefined);
        return;
      }
      queuedBytes += frame.byteLength;
      if (queued.length >= 32 || queuedBytes > this.maxCommandBytes) {
        queued.length = 0;
        websocket.close(1008, "commands sent before attach");
        return;
      }
      queued.push(frame);
    });

    const closed = Promise.withResolvers<void>();
    websocket.once("close", (code: number) => {
      disconnected = true;
      restarting = bridge && this.relayRestartPlanned;
      // A pooled guest outlives its Runner: a channel the Home did not close keeps its pages.
      channelLost = this.runtime.pooled && code !== 1000;
      cancellation.abort();
      closed.resolve();
    });

    const ready = this.runtime
      .attach(ticket, sink, {
        ...options,
        signal: cancellation.signal,
        waitForCleanup: bridge,
      })
      .then(
        (attached) => {
          attachment = attached;
          if (disconnected) return;
          if (this.relayBridge) {
            websocket.send(
              JSON.stringify({
                type: "browser.attached",
                ...(attached.initialPage ? { initialPage: attached.initialPage } : {}),
              }),
            );
          }
          // The controller owns command ordering; a paste may await a later part.
          for (const frame of queued) void attached.handle(frame).catch(() => undefined);
          queued.length = 0;
        },
        async (error: unknown) => {
          await sendProtocolError(sink, toBrowserRuntimeError(error)).catch(() => undefined);
          if (websocket.readyState === WebSocket.OPEN) websocket.close(1008, "attach rejected");
        },
      );
    const ended = closed.promise.then(async () => {
      try {
        await ready;
      } finally {
        await attachment?.close(bridge, restarting, channelLost);
      }
    });
    if (bridge) this.trackRelayAttachment(websocket, ended);
    else void ended.catch(() => undefined);
  }

  private acceptStandardCdp(websocket: WebSocket, ticket: string, bridge: boolean): void {
    const cancellation = new AbortController();
    let attachment: StandardCdpAttachment | undefined;
    let detaching = false;
    let inFlightBytes = 0;
    const pending = new Set<string>();
    let outboundBytes = 0;
    let outboundCount = 0;
    const close = (code: number, reason: string) => {
      if (cancellation.signal.aborted) return;
      cancellation.abort();
      attachment?.close();
      if (websocket.readyState === WebSocket.OPEN) websocket.close(code, reason);
      if (websocket.readyState !== WebSocket.CLOSED) {
        const hardClose = setTimeout(() => websocket.terminate(), 1_000);
        hardClose.unref();
        websocket.once("close", () => clearTimeout(hardClose));
      }
    };
    const overloaded = () => close(1013, "CDP connection exceeded its buffer limit");
    const send = async (value: unknown): Promise<void> => {
      if (cancellation.signal.aborted || websocket.readyState !== WebSocket.OPEN) return;
      const data = JSON.stringify(value);
      const size = Buffer.byteLength(data);
      if (
        size > standardCdpMessageMaxBytes ||
        inFlightBytes + outboundBytes + size > standardCdpBufferedMaxBytes ||
        outboundCount >= standardCdpMaxPending
      ) {
        overloaded();
        return;
      }
      outboundBytes += size;
      outboundCount++;
      try {
        await new Promise<void>((resolve, reject) => {
          websocket.send(data, (error) => (error ? reject(error) : resolve()));
        });
      } finally {
        outboundBytes -= size;
        outboundCount--;
      }
    };
    const closed = Promise.withResolvers<void>();
    websocket.once("close", () => {
      close(1000, "CDP disconnected");
      closed.resolve();
    });
    websocket.on("error", () => close(1011, "CDP transport failed"));
    const ready = this.runtime.attachStandardCdp(ticket, overloaded, cancellation.signal).then(
      (client) => {
        attachment = client;
        if (cancellation.signal.aborted) {
          client.close();
          return client;
        }
        client.signal.addEventListener(
          "abort",
          () => {
            if (!detaching) close(1000, "Browser Session ended");
          },
          { once: true },
        );
        if (client.signal.aborted) {
          close(1000, "Browser Session ended");
          return undefined;
        }
        client.onEvent(({ method, parameters, sessionId }) => {
          void send({ method, params: parameters, sessionId }).catch(() =>
            close(1011, "CDP transport failed"),
          );
        });
        if (bridge)
          void send({ type: "browser.attached", standardCdpMode: client.mode }).catch(() =>
            close(1011, "CDP transport failed"),
          );
        return client;
      },
      () => {
        close(1008, "CDP attachment rejected");
        return undefined;
      },
    );

    if (bridge)
      this.trackRelayAttachment(
        websocket,
        closed.promise.then(async () => {
          await ready;
          await attachment?.settled;
        }),
      );

    websocket.on("message", (raw: RawData, binary: boolean) => {
      if (cancellation.signal.aborted || detaching) return;
      if (binary) {
        close(1003, "CDP requires JSON text");
        return;
      }
      const frame = normalizeRawData(raw);
      if (
        bridge &&
        frame.length === standardCdpDetachFrame.length &&
        frame.toString("utf8") === standardCdpDetachFrame
      ) {
        detaching = true;
        attachment?.close();
        void ready.then(async (client) => {
          if (!client) return;
          client.close();
          await client.settled;
          close(1000, standardCdpSettledReason);
        });
        return;
      }
      if (
        inFlightBytes + outboundBytes + frame.byteLength > standardCdpBufferedMaxBytes ||
        pending.size >= standardCdpMaxPending
      ) {
        overloaded();
        return;
      }
      let request: z.infer<typeof standardCdpRequest>;
      try {
        request = standardCdpRequest.parse(JSON.parse(frame.toString("utf8")));
      } catch {
        close(1007, "Invalid CDP command");
        return;
      }
      const { id, method, params, sessionId } = request;
      const key = JSON.stringify([id, sessionId]);
      if (pending.has(key)) {
        close(1007, "Duplicate pending CDP command");
        return;
      }
      pending.add(key);
      inFlightBytes += frame.byteLength;
      const dispatch = async (client: StandardCdpAttachment | undefined) => {
        if (!client || cancellation.signal.aborted || detaching) return;
        try {
          const result = await client.send({
            method,
            ...(params === undefined ? {} : { parameters: params }),
            ...(sessionId === undefined ? {} : { sessionId }),
          });
          await send({ id, sessionId, result: result ?? {} });
        } catch (error) {
          const message = error instanceof Error ? error.message : "CDP command failed.";
          await send({ id, sessionId, error: { code: -32000, message } });
        }
      };
      void (attachment ? dispatch(attachment) : ready.then(dispatch))
        .catch(() => close(1007, "Invalid CDP command"))
        .finally(() => {
          inFlightBytes -= frame.byteLength;
          pending.delete(key);
        });
    });
  }

  private async closeOnce(): Promise<void> {
    // Admission/attempt abort is synchronous; sockets never wait for persistence.
    const persistence = this.runtime.shutdown();
    void persistence.catch(() => undefined);
    await this.listening?.catch(() => undefined);
    const closed = [this.websocketServer, this.cdpServer].map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    if (this.httpServer.listening) closed.push(closeHttpServerNow(this.httpServer));
    for (const websocket of [...this.websocketServer.clients, ...this.cdpServer.clients]) {
      // The reason goes first as best effort; nobody's answer is waited for.
      if (websocket.readyState === WebSocket.OPEN) {
        websocket.close(1001, "runtime shutting down");
      }
      websocket.terminate();
    }
    await Promise.all(closed);
    await persistence;
  }
}

class WebSocketBrowserSink implements BrowserControllerSink {
  private readonly maxBufferedBytes: number;
  private readonly websocket: WebSocket;

  constructor(websocket: WebSocket, maxBufferedBytes: number) {
    this.websocket = websocket;
    this.maxBufferedBytes = maxBufferedBytes;
  }

  sendServer(message: BrowserRuntimeServerMessage): Promise<void> {
    const validated = BrowserRuntimeServerMessageSchema.parse(message);
    return this.send(JSON.stringify(validated), false);
  }

  sendFrame(frame: BrowserFrame): Promise<void> {
    return this.send(encodeBrowserFrame(frame), true);
  }

  closeForPool(): void {
    this.websocket.close(1012, "browser-pool-retire");
  }

  private send(data: Buffer | string, binary: boolean): Promise<void> {
    if (this.websocket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Browser controller socket is not open."));
    }
    const bytes = typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength;
    if (this.websocket.bufferedAmount + bytes > this.maxBufferedBytes) {
      this.websocket.close(1013, "slow browser consumer");
      return Promise.reject(new Error("Browser controller exceeded its outbound buffer."));
    }
    return new Promise<void>((resolve, reject) => {
      this.websocket.send(data, { binary }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

function bearerTicket(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length);
  return token.length > 0 && token.length <= 16_384 ? token : null;
}

function safeTokenEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function safePathname(request: IncomingMessage): string | null {
  try {
    return new URL(request.url ?? "", "http://runtime.invalid").pathname;
  } catch {
    return null;
  }
}

function normalizeRawData(rawData: RawData): Buffer {
  if (Buffer.isBuffer(rawData)) return rawData;
  if (rawData instanceof ArrayBuffer) return Buffer.from(rawData);
  if (Array.isArray(rawData)) return Buffer.concat(rawData);
  throw new Error("Unsupported WebSocket frame representation.");
}

function sendProtocolError(sink: BrowserControllerSink, error: BrowserRuntimeError): Promise<void> {
  return sink.sendServer({
    error: error.toProtocolError(),
    type: "browser.error",
  });
}

const PoolFenceSchema = z.strictObject({
  slot: z.string().min(1).max(256),
  term: z.number().int().positive(),
  instance: z.string().min(1).max(256),
  epoch: z.number().int().positive(),
});

/** A signed pool control as the Home relays it; the signature decides, the shape only bounds. */
const PoolControlRequestSchema = z.strictObject({
  control: z.strictObject({
    kind: z.enum(["install", "retire", "release", "seal", "adopt", "complete"]),
    fence: PoolFenceSchema,
    intent: z
      .strictObject({ id: z.string().min(1).max(256), sequence: z.number().int().positive() })
      .optional(),
    attempt: z.number().int().positive().optional(),
    sequence: z.number().int().positive(),
    expect: PoolFenceSchema.nullable(),
  }),
  signature: z.string().max(512),
});
