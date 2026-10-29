import { randomBytes } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import { once } from "node:events";
import type { RunnerConfig } from "@opensteer/config";
import { allowsPlaintextRunnerTransport } from "@opensteer/core";
import { BrowserSessionIdSchema, type RunBrowserCdpPlan } from "@opensteer/protocol";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { closeHttpServerNow, refuseConnection } from "@opensteer/shared/httpServer";
import { rawDataBuffer } from "@opensteer/shared/webSocketFrame";

const maximumFrameBytes = 1_024 * 1_024;
const maximumBufferedBytes = 8 * 1_024 * 1_024;
const maximumConnections = 16;

/**
 * A Run-local byte relay. Browser Harness sees an ordinary loopback CDP
 * WebSocket at `<base>/<Browser Session ID>`; the bearer capability never
 * enters the model-visible process environment.
 *
 * Each client connection gets its own Host connection bound to the session its
 * path names, and the two live and close together. Nothing outlives the client
 * that opened it, so a later connection can never inherit an earlier one's
 * session. A pair stays here until both of its sockets have closed, so the
 * end of a Run can still cut one that is closing.
 */
export class BrowserCdpRelay {
  readonly #connections = new Set<RelayedConnection>();
  readonly #http: HttpServer;
  readonly #path: string;
  readonly #upstreamToken: () => string;
  readonly #upstreamUrl: URL;
  readonly #websockets = new WebSocketServer({
    maxPayload: maximumFrameBytes,
    noServer: true,
    perMessageDeflate: false,
  });
  #closed = false;
  #closing: Promise<void> | null = null;
  #listening: Promise<unknown> | null = null;
  /** Between the Runs of a warm engine: no connection may open. */
  #suspended = false;

  constructor(options: {
    readonly plan: RunBrowserCdpPlan;
    /** The Host token current when each connection opens; defaults to the plan's. */
    readonly token?: () => string;
    readonly transport: Pick<RunnerConfig, "mode">;
  }) {
    this.#path = `/devtools/browser/${randomBytes(24).toString("base64url")}`;
    const planToken = options.plan.token;
    this.#upstreamToken = options.token ?? (() => planToken);
    this.#upstreamUrl = validateUpstream(new URL(options.plan.url), options.transport);
    this.#http = createServer((_request, response) => {
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"error":"not_found"}');
    });
    this.#http.on("upgrade", (request, socket, head) => {
      const sessionId = this.#sessionIdFromPath(safePathname(request.url));
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
        this.#attach(downstream, sessionId);
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
    this.#closing ??= this.#dispose();
    return this.#closing;
  }

  async #dispose(): Promise<void> {
    await this.#listening?.catch(() => undefined);
    const closed = [
      new Promise<void>((resolve) => this.#websockets.close(() => resolve())),
      ...Array.from(this.#connections, (connection) => connection.closed),
    ];
    if (this.#http.listening) closed.push(closeHttpServerNow(this.#http));
    for (const connection of this.#connections) connection.dispose();
    await Promise.all(closed);
  }

  #sessionIdFromPath(pathname: string | null): string | null {
    if (!pathname?.startsWith(`${this.#path}/`)) return null;
    const segment = pathname.slice(this.#path.length + 1);
    return BrowserSessionIdSchema.safeParse(segment).success ? segment : null;
  }

  #attach(downstream: WebSocket, sessionId: string): void {
    if (this.#closed) {
      downstream.close(1001, "Run ended");
      downstream.terminate();
      return;
    }
    const upstreamUrl = new URL(this.#upstreamUrl);
    upstreamUrl.pathname = `${upstreamUrl.pathname.replace(/\/$/u, "")}/${sessionId}`;
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
