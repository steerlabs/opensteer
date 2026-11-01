import { z } from "zod";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server as HttpServer,
} from "node:http";
import { once } from "node:events";
import {
  BrowserServerMessageSchema,
  BrowserAttachPublicKeysSchema,
  LocalProfileBindingSchema,
  type BrowserServerMessage,
  type BrowserAttachPublicKey,
} from "@opensteer/protocol";
import { closeHttpServerNow, refuseConnection } from "@opensteer/shared/httpServer";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { BrowserRuntimeError, toBrowserRuntimeError } from "./errors.js";
import type { BrowserControllerSink } from "./browser/controller.js";
import { encodeBrowserFrame, type BrowserFrame } from "./stream/frame.js";
import type { BrowserAttachment, BrowserRuntime } from "./runtime.js";

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
  private closePromise: Promise<void> | null = null;
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
    this.httpServer.on("upgrade", (request, socket, head) => {
      const pathname = safePathname(request);
      if (pathname !== "/v1/browser") {
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
      this.websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        this.websocketServer.emit("connection", websocket, request);
      });
    });
    this.websocketServer.on("connection", (websocket: WebSocket, request: IncomingMessage) => {
      const ticket = bearerTicket(request);
      if (!ticket) {
        websocket.close(1008, "attach rejected");
        return;
      }
      this.accept(websocket, ticket, {
        passkeys:
          Boolean(this.relayBridge) && request.headers["x-opensteer-browser-passkeys"] === "1",
        localProfiles:
          Boolean(this.relayBridge) &&
          request.headers["x-opensteer-browser-local-profiles"] === "1",
        initialNavigation:
          Boolean(this.relayBridge) &&
          request.headers["x-opensteer-browser-initial-navigation"] === "1",
      });
    });
  }

  private acceptDeviceBridgeKeys(request: IncomingMessage): void {
    const token = request.headers["x-opensteer-browser-bridge-token"];
    const encodedKeys = request.headers["x-opensteer-browser-attach-keys"];
    if (
      token === undefined &&
      encodedKeys === undefined &&
      request.headers["x-opensteer-browser-passkeys"] === undefined &&
      request.headers["x-opensteer-browser-local-profiles"] === undefined &&
      request.headers["x-opensteer-browser-initial-navigation"] === undefined
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
    bridge.updateAttachKeys(keys);
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
    if (request.headers["x-opensteer-browser-local-profiles"] !== "1") {
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
    if (request.method === "POST" && request.url === "/v1/local-profiles/delete") {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        size += bytes.byteLength;
        if (size > 16 * 1024) throw new Error("Profile maintenance body exceeds its limit.");
        chunks.push(bytes);
      }
      const input = z
        .strictObject({ binding: LocalProfileBindingSchema, deletionId: z.uuid() })
        .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const state = await this.runtime.deleteLocalProfile(input.binding, input.deletionId);
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

  private accept(
    websocket: WebSocket,
    ticket: string,
    options: { passkeys: boolean; localProfiles: boolean; initialNavigation: boolean },
  ): void {
    const sink = new WebSocketBrowserSink(websocket, this.maxBufferedBytes);
    let attachment: BrowserAttachment | null = null;
    let disconnected = false;
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

    websocket.once("close", () => {
      disconnected = true;
      cancellation.abort();
      void attachment?.close().catch(() => undefined);
    });

    void this.runtime.attach(ticket, sink, { ...options, signal: cancellation.signal }).then(
      async (attached) => {
        attachment = attached;
        if (disconnected) {
          await attached.close().catch(() => undefined);
          return;
        }
        if (options.localProfiles || options.initialNavigation) {
          websocket.send(
            JSON.stringify({
              type: "browser.attached",
              ...(attached.initialPage ? { initialPage: attached.initialPage } : {}),
            }),
          );
        }
        for (const frame of queued) await attached.handle(frame);
        queued.length = 0;
      },
      async (error: unknown) => {
        await sendProtocolError(sink, toBrowserRuntimeError(error)).catch(() => undefined);
        if (websocket.readyState === WebSocket.OPEN) websocket.close(1008, "attach rejected");
      },
    );
  }

  private async closeOnce(): Promise<void> {
    // Admission/attempt abort is synchronous; sockets never wait for persistence.
    const persistence = this.runtime.shutdown();
    void persistence.catch(() => undefined);
    await this.listening?.catch(() => undefined);
    const closed = [new Promise<void>((resolve) => this.websocketServer.close(() => resolve()))];
    if (this.httpServer.listening) closed.push(closeHttpServerNow(this.httpServer));
    for (const websocket of this.websocketServer.clients) {
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

  sendServer(message: BrowserServerMessage): Promise<void> {
    const validated = BrowserServerMessageSchema.parse(message);
    return this.send(JSON.stringify(validated), false);
  }

  sendFrame(frame: BrowserFrame): Promise<void> {
    return this.send(encodeBrowserFrame(frame), true);
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
