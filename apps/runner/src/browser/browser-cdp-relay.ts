import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server as HttpServer,
} from "node:http";
import { once } from "node:events";
import type { RunnerConfig } from "@opensteer/config";
import { allowsPlaintextRunnerTransport } from "@opensteer/core";
import { BrowserSessionIdSchema, HostApiErrorSchema } from "@opensteer/protocol";
import { readBoundedJson } from "@opensteer/shared/boundedJson";
import { z } from "zod";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { closeHttpServerNow, refuseConnection } from "@opensteer/shared/httpServer";
import { rawDataBuffer } from "@opensteer/shared/webSocketFrame";
import {
  browserAgentHostRoutePrefix,
  browserAgentRequestMaxBytes,
  browserAgentResponseMaxBytes,
  browserAgentRoutePaths,
} from "@opensteer/protocol/browser-agent";
import { BrowserAgentBackendSchema } from "@opensteer/protocol/browser-actions";

const maximumFrameBytes = 1_024 * 1_024;
const maximumBufferedBytes = 8 * 1_024 * 1_024;
const maximumConnections = 16;

/**
 * A Run-local relay. CDP stays at `<base>/<sessionId>`, actions use
 * `<base>/actions/<sessionId>`, and GET `<base>/backend/<sessionId>` negotiates.
 * The bearer capability never enters the model-visible process environment.
 *
 * Each client connection gets its own Host connection bound to the session its
 * path names, and the two live and close together. Nothing outlives the client
 * that opened it, so a later connection can never inherit an earlier one's
 * session. A pair stays here until both of its sockets have closed, so the
 * end of a Run can still cut one that is closing.
 */
export class BrowserCdpRelay {
  readonly #connections = new Set<RelayedConnection>();
  readonly #agentRequests = new Set<Promise<void>>();
  readonly #negotiations = new Set<AbortController>();
  readonly #http: HttpServer;
  readonly #path: string;
  readonly #upstreamToken: () => string;
  readonly #upstreamUrl: URL;
  readonly #websockets = new WebSocketServer({
    maxPayload: maximumFrameBytes,
    noServer: true,
    perMessageDeflate: false,
  });
  #generation = 0;
  #closed = false;
  #closing: Promise<void> | null = null;
  #listening: Promise<unknown> | null = null;
  /** Between the Runs of a warm engine: no connection may open. */
  #suspended = false;

  constructor(options: {
    readonly url: string;
    /** The Host token current when each connection opens. */
    readonly token: () => string;
    readonly transport: Pick<RunnerConfig, "mode">;
  }) {
    this.#path = `/devtools/browser/${randomBytes(24).toString("base64url")}`;
    this.#upstreamToken = options.token;
    this.#upstreamUrl = validateUpstream(new URL(options.url), options.transport);
    this.#http = createServer((request, response) => {
      const pathname = safePathname(request.url);
      const agentPath = pathname?.startsWith(`${this.#path}/agent/`)
        ? pathname.slice(`${this.#path}/agent/`.length)
        : undefined;
      if (agentPath && Object.values(browserAgentRoutePaths).some((path) => path === agentPath)) {
        if (request.method !== "GET" && request.method !== "POST") {
          response.writeHead(405).end();
          return;
        }
        const pending = this.#agentResponse(request, response, agentPath);
        this.#agentRequests.add(pending);
        void pending.finally(() => this.#agentRequests.delete(pending));
        return;
      }
      const sessionId = this.#sessionIdFromPath(pathname, "backend");
      if (request.method !== "GET" || !sessionId) {
        response.writeHead(404).end();
        return;
      }
      if (this.#suspended || this.#closed) {
        response.writeHead(403).end();
        return;
      }
      if (this.#negotiations.size >= maximumConnections) {
        response.writeHead(503).end();
        return;
      }
      const controller = new AbortController();
      this.#negotiations.add(controller);
      response.once("close", () => controller.abort());
      void this.#backendResponse(
        sessionId,
        AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      )
        .then(async (upstream) => {
          if (this.#suspended || this.#closed) {
            response.writeHead(403).end();
            return;
          }
          if (!upstream.ok) {
            const refusal = await readBoundedJson(upstream, { maximumBytes: 16_384 })
              .then((body) => z.object({ error: HostApiErrorSchema }).safeParse(body))
              .catch(() => undefined);
            if (controller.signal.aborted || this.#suspended || this.#closed) {
              response.writeHead(403).end();
              return;
            }
            response.writeHead(upstream.status, {
              "content-type": "application/json",
              "cache-control": "no-store",
            });
            response.end(
              refusal?.success
                ? JSON.stringify({ error: { message: refusal.data.error.message } })
                : undefined,
            );
            return;
          }
          const backend = BrowserAgentBackendSchema.parse(await upstream.json());
          if (controller.signal.aborted || this.#suspended || this.#closed) {
            response.writeHead(403).end();
            return;
          }
          if (backend.sessionId !== sessionId) throw new Error("Backend session mismatch");
          response.writeHead(200, {
            "content-type": "application/json",
            "cache-control": "no-store",
          });
          response.end(JSON.stringify(backend));
        })
        .catch(() => {
          if (!response.destroyed) response.writeHead(502).end();
        })
        .finally(() => this.#negotiations.delete(controller));
    });
    this.#http.on("upgrade", (request, socket, head) => {
      const pathname = safePathname(request.url);
      const actionsSessionId = this.#sessionIdFromPath(pathname, "actions");
      const sessionId = actionsSessionId ?? this.#sessionIdFromPath(pathname);
      if (!sessionId) {
        refuseConnection(socket, 404, "Not Found");
        return;
      }
      if (this.#suspended) {
        refuseConnection(socket, 403, "Forbidden");
        return;
      }
      if (this.#closed || this.#connections.size >= maximumConnections) {
        refuseConnection(socket, 503, "Service Unavailable");
        return;
      }
      this.#websockets.handleUpgrade(request, socket, head, (downstream) => {
        this.#attach(downstream, sessionId, actionsSessionId ? "actions" : "cdp");
      });
    });
  }

  /** The base URL; clients connect to `<base>/<Browser Session ID>`. */
  async start(): Promise<string> {
    if (this.#closed || this.#listening) throw new Error("Browser CDP relay cannot be started");
    this.#http.listen(0, "127.0.0.1");
    this.#listening = once(this.#http, "listening");
    await this.#listening;
    const address = this.#http.address();
    if (!address || typeof address === "string")
      throw new Error("CDP relay address is unavailable");
    return `ws://127.0.0.1:${address.port}${this.#path}`;
  }

  /** A warm engine went idle: its connections end and none opens until the next Run. */
  suspend(): void {
    this.#suspended = true;
    this.#generation++;
    for (const negotiation of this.#negotiations) negotiation.abort();
    for (const connection of this.#connections) connection.dispose();
  }

  /** The next Run of a warm engine holds this relay; connections use that Run's token. */
  resume(): void {
    if (this.#closed) throw new Error("A closed CDP relay cannot resume");
    this.#suspended = false;
  }

  /** Ends every connection and the listener; every call settles when all of it has closed. */
  close(): Promise<void> {
    this.#closed = true;
    this.#generation++;
    for (const negotiation of this.#negotiations) negotiation.abort();
    this.#closing ??= this.#dispose();
    return this.#closing;
  }

  async #agentResponse(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
  ): Promise<void> {
    if (this.#closed || this.#suspended) {
      response.writeHead(403).end();
      return;
    }
    if (this.#negotiations.size >= maximumConnections) {
      response.writeHead(503).end();
      return;
    }
    const generation = this.#generation;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
    const fenced = () => this.#closed || this.#suspended || generation !== this.#generation;
    this.#negotiations.add(controller);
    response.once("close", () => controller.abort());
    try {
      const token = this.#upstreamToken();
      const body = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const cleanup = () => {
          request.off("data", data);
          request.off("end", end);
          request.off("error", fail);
          signal.removeEventListener("abort", abort);
        };
        const fail = (error: unknown) => {
          cleanup();
          reject(error);
        };
        const abort = () => fail(signal.reason);
        const end = () => {
          cleanup();
          resolve(Buffer.concat(chunks));
        };
        const data = (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > browserAgentRequestMaxBytes) {
            response.writeHead(413).end();
            fail(new Error("Browser request exceeds its size limit"));
          } else chunks.push(chunk);
        };
        request.on("data", data);
        request.once("end", end);
        request.once("error", fail);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      signal.throwIfAborted();
      const url = new URL(this.#upstreamUrl);
      url.protocol = url.protocol === "wss:" ? "https:" : "http:";
      url.pathname = `${browserAgentHostRoutePrefix}/${path}`;
      url.search = new URL(request.url ?? "", "http://relay.invalid").search;
      const upstream = await fetch(url, {
        method: request.method ?? "GET",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(request.method === "POST" ? { body } : {}),
        redirect: "error",
        signal,
      });
      const result = await readBoundedJson(upstream, {
        maximumBytes: browserAgentResponseMaxBytes,
        signal,
      }).catch((error: unknown) => {
        if (upstream.ok) throw error;
        return undefined;
      });
      if (fenced()) {
        response.writeHead(403).end();
        return;
      }
      const refusal = z.object({ error: z.object({ message: z.string() }) }).safeParse(result);
      response.writeHead(upstream.status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(
        JSON.stringify(
          upstream.ok
            ? result
            : {
                error: {
                  message: refusal.success
                    ? refusal.data.error.message
                    : "The Host refused browser control.",
                },
              },
        ),
      );
    } catch {
      if (!response.destroyed && !response.writableEnded)
        response.writeHead(fenced() ? 403 : 502).end();
    } finally {
      this.#negotiations.delete(controller);
    }
  }

  async #dispose(): Promise<void> {
    await this.#listening?.catch(() => undefined);
    await Promise.allSettled(this.#agentRequests);
    const closed = [
      new Promise<void>((resolve) => this.#websockets.close(() => resolve())),
      ...Array.from(this.#connections, (connection) => connection.closed),
    ];
    if (this.#http.listening) closed.push(closeHttpServerNow(this.#http));
    for (const connection of this.#connections) connection.dispose();
    await Promise.all(closed);
  }

  #sessionIdFromPath(pathname: string | null, kind?: "backend" | "actions"): string | null {
    const prefix = `${this.#path}/${kind ? `${kind}/` : ""}`;
    if (!pathname?.startsWith(prefix)) return null;
    const segment = pathname.slice(prefix.length);
    return BrowserSessionIdSchema.safeParse(segment).success ? segment : null;
  }

  #endpoint(kind: "backend" | "actions" | "cdp", sessionId: string): URL {
    const url = new URL(this.#upstreamUrl);
    url.pathname = `${url.pathname.replace(/\/$/u, "").replace(/browser-cdp$/u, `browser-${kind}`)}/${sessionId}`;
    return url;
  }

  async #backendResponse(sessionId: string, signal: AbortSignal): Promise<Response> {
    const url = this.#endpoint("backend", sessionId);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    const discovery = await fetch(new URL("/.well-known/opensteer", url), {
      redirect: "error",
      signal,
    });
    if (!discovery.ok) throw new Error("Host discovery failed");
    const { capabilities } = z
      .object({ capabilities: z.array(z.string()) })
      .parse(await readBoundedJson(discovery, { maximumBytes: 65_536 }));
    if (!capabilities.includes("browser-backend-v1"))
      return Response.json({ sessionId, backend: "cdp", version: 1 });
    return fetch(url, {
      headers: { authorization: `Bearer ${this.#upstreamToken()}` },
      redirect: "error",
      signal,
    });
  }

  #attach(downstream: WebSocket, sessionId: string, kind: "actions" | "cdp"): void {
    if (this.#closed) {
      downstream.close(1001, "Run ended");
      downstream.terminate();
      return;
    }
    const upstreamUrl = this.#endpoint(kind, sessionId);
    const connection = new RelayedConnection(
      downstream,
      new WebSocket(upstreamUrl, {
        followRedirects: false,
        headers: { authorization: `Bearer ${this.#upstreamToken()}` },
        maxPayload: maximumFrameBytes,
        perMessageDeflate: false,
      }),
      () => this.#connections.delete(connection),
    );
    this.#connections.add(connection);
  }
}

/** One client and the Host connection opened for it. */
class RelayedConnection {
  /** Settles once both sockets have closed. */
  readonly closed: Promise<void>;
  readonly #downstream: WebSocket;
  readonly #pending: Array<{ readonly data: Buffer; readonly isBinary: boolean }> = [];
  readonly #upstream: WebSocket;
  #closed = false;
  #pendingBytes = 0;

  constructor(downstream: WebSocket, upstream: WebSocket, onClosed: () => void) {
    this.#downstream = downstream;
    this.#upstream = upstream;
    this.closed = Promise.all([socketClosed(downstream), socketClosed(upstream)]).then(() =>
      onClosed(),
    );
    downstream.on("message", (raw, isBinary) => this.#receiveDownstream(raw, isBinary));
    downstream.once("close", () => this.close(1000, "CDP client disconnected"));
    downstream.once("error", () => this.close(1011, "CDP client failed"));
    upstream.once("open", () => {
      for (const frame of this.#pending.splice(0)) {
        sendBounded(this.#upstream, frame.data, frame.isBinary, (code, reason) =>
          this.close(code, reason),
        );
      }
      this.#pendingBytes = 0;
    });
    upstream.on("message", (raw, isBinary) => this.#receiveUpstream(raw, isBinary));
    // The Host's reason says why the session cannot be used; the client gets it verbatim.
    upstream.once("close", (code, reason) =>
      this.close(
        sendableCloseCode(code) ? code : 1011,
        reason.toString() || "Browser connection closed",
      ),
    );
    upstream.once("unexpected-response", (request, response) => {
      request.destroy();
      this.close(
        1011,
        `The Opensteer Host refused the browser connection (HTTP ${response.statusCode ?? 0})`,
      );
    });
    upstream.once("error", () => this.close(1011, "The Opensteer Host could not be reached"));
  }

  close(code: number, reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#pending.length = 0;
    closeSocket(this.#downstream, code, reason);
    closeSocket(this.#upstream, 1000, "CDP client disconnected");
  }

  /**
   * Cuts both sockets now, whatever state each is in: the Run that held them
   * has ended. An open socket is told why first, as best effort; neither
   * side's answer is waited for.
   */
  dispose(): void {
    this.#closed = true;
    this.#pending.length = 0;
    closeSocket(this.#downstream, 1001, "Run ended");
    closeSocket(this.#upstream, 1000, "CDP client disconnected");
    this.#downstream.terminate();
    this.#upstream.terminate();
  }

  #receiveDownstream(raw: RawData, isBinary: boolean): void {
    const data = rawDataBuffer(raw);
    if (data.byteLength > maximumFrameBytes) {
      this.close(1009, "CDP frame too large");
      return;
    }
    if (this.#upstream.readyState === WebSocket.OPEN) {
      sendBounded(this.#upstream, data, isBinary, (code, reason) => this.close(code, reason));
      return;
    }
    this.#pendingBytes += data.byteLength;
    if (this.#pending.length >= 64 || this.#pendingBytes > maximumBufferedBytes) {
      this.close(1013, "CDP relay input is full");
      return;
    }
    this.#pending.push({ data, isBinary });
  }

  #receiveUpstream(raw: RawData, isBinary: boolean): void {
    const data = rawDataBuffer(raw);
    if (data.byteLength > maximumFrameBytes) {
      this.close(1009, "CDP frame too large");
      return;
    }
    sendBounded(this.#downstream, data, isBinary, (code, reason) => this.close(code, reason));
  }
}

function validateUpstream(url: URL, transport: Pick<RunnerConfig, "mode">): URL {
  if (url.username || url.password || url.hash || url.search) {
    throw new Error("Browser CDP URL cannot contain credentials, a query, or a fragment");
  }
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol !== "wss:" && !allowsPlaintextRunnerTransport(transport.mode, url)) {
    throw new Error("Browser CDP transport must use WSS outside an allowed loopback placement");
  }
  return url;
}

function sendBounded(
  socket: WebSocket,
  data: Buffer,
  isBinary: boolean,
  close: (code: number, reason: string) => void,
): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount + data.byteLength > maximumBufferedBytes) {
    close(1013, "CDP relay output is full");
    return;
  }
  socket.send(data, { binary: isBinary });
}

function sendableCloseCode(code: number): boolean {
  return (
    (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) ||
    (code >= 3000 && code <= 4999)
  );
}

function socketClosed(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => socket.once("close", () => resolve()));
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  let bounded = reason;
  while (Buffer.byteLength(bounded, "utf8") > 123) bounded = bounded.slice(0, -1);
  if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
  else if (socket.readyState === WebSocket.OPEN) socket.close(code, bounded);
}

function safePathname(value: string | undefined): string | null {
  try {
    return new URL(value ?? "", "http://relay.invalid").pathname;
  } catch {
    return null;
  }
}
