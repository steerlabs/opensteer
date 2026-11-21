import {
  Agent,
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type RequestOptions,
} from "node:http";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as connectTcp, isIP, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { connect as connectTls } from "node:tls";
import {
  connectInOrder,
  resolvePublicAddresses,
  tlsServerName,
  type ResolvedPublicAddress,
} from "@opensteer/access";
import { refused } from "@opensteer/core";
import { closeHttpServerNow, refuseConnection } from "@opensteer/shared/httpServer";
import type { BrowserEgressUpstream } from "./egress-config.js";

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const allowedMethods = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);
const bodylessMethods = new Set(["GET", "HEAD"]);
const upstreamUnavailable = refused("internal", "Browser egress upstream is unavailable.");
const maxConnectHeaderBytes = 16 * 1024;

type ResolveAddress = (hostname: string) => Promise<ResolvedPublicAddress>;
type ResolveAddresses = (hostname: string) => Promise<readonly ResolvedPublicAddress[]>;
type TrackSocket = (socket: Socket) => void;

interface EgressTransport {
  readonly agent?: Agent;
  connect(address: ResolvedPublicAddress, port: number, signal: AbortSignal): Promise<Socket>;
}

/** A refused request or tunnel: its kind and a fixed reason, and nothing about its destination. */
export interface BrowserEgressRefusal {
  readonly kind: "request" | "tunnel";
  readonly reason: string;
}

/** Counts refusals by kind and reason; a diagnostics host prints the counts, never a destination. */
export class BrowserEgressRefusalCounts {
  readonly #counts = new Map<string, number>();

  add(event: BrowserEgressRefusal): void {
    const key = `${event.kind} ${event.reason}`;
    this.#counts.set(key, (this.#counts.get(key) ?? 0) + 1);
  }

  /** The counts since the last call, one line each, and starts again. */
  take(): readonly { readonly kind: string; readonly reason: string; readonly count: number }[] {
    const lines = [...this.#counts].map(([key, count]) => {
      const [kind, reason] = key.split(" ") as [string, string];
      return { kind, reason, count };
    });
    this.#counts.clear();
    return lines;
  }
}

interface PublicBrowserEgressProxyOptions {
  readonly host?: string;
  /** A listening socket handed over by the service manager (socket activation), instead of host and port. */
  readonly listenFd?: number;
  readonly maxConnections?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly maxTunnelBytes?: number;
  readonly maxTunnelLifetimeMs?: number;
  readonly port?: number;
  /** One address per name (tests); `resolveAddresses` gives every public address, in order. */
  readonly resolveAddress?: ResolveAddress;
  readonly resolveAddresses?: ResolveAddresses;
  readonly timeoutMs?: number;
  readonly upstream?: BrowserEgressUpstream;
  readonly upstreamRequired?: boolean;
  /** Every request or tunnel refused, and why (diagnostics; off unless asked for). */
  readonly onRefusal?: (event: BrowserEgressRefusal) => void;
}

/**
 * Forward proxy for hosted Chromium. Every new HTTP request and CONNECT tunnel
 * resolves its destination once, rejects any non-public answer, then connects
 * to that exact address. Redirects and subresources arrive as new requests and
 * cross the same check. Closing ends every connection, tunnel and upstream at
 * once, and nothing resolved after that point is connected.
 */
export class PublicBrowserEgressProxy {
  #closing: Promise<void> | null = null;
  readonly #host: string;
  #listening: Promise<void> | null = null;
  readonly #maxConnections: number;
  readonly #pendingClients = new WeakSet<Duplex>();
  #pendingConnections = 0;
  readonly #maxRequestBytes: number;
  readonly #maxResponseBytes: number;
  readonly #maxTunnelBytes: number;
  readonly #maxTunnelLifetimeMs: number;
  readonly #port: number;
  readonly #listenFd: number | undefined;
  readonly #resolveAddresses: ResolveAddresses;
  readonly #server: Server;
  readonly #shutdown = new AbortController();
  readonly #timeoutMs: number;
  readonly #onRefusal: PublicBrowserEgressProxyOptions["onRefusal"];
  readonly #transport: EgressTransport;
  readonly #upstreamPending: boolean;
  /** CONNECT clients, which leave the server's HTTP connections yet hold its close. */
  readonly #tunnels = new Set<Duplex>();
  /** Connections and requests made on a client's behalf, until each closes. */
  readonly #upstreams = new Set<{ destroy(): unknown }>();

  constructor(options: PublicBrowserEgressProxyOptions = {}) {
    this.#host = options.host ?? "127.0.0.1";
    this.#port = options.port ?? 4_313;
    this.#listenFd = options.listenFd;
    this.#maxConnections = positiveInteger(options.maxConnections ?? 512);
    this.#maxRequestBytes = positiveInteger(options.maxRequestBytes ?? 32 * 1_024 * 1_024);
    this.#maxResponseBytes = positiveInteger(options.maxResponseBytes ?? 64 * 1_024 * 1_024);
    this.#maxTunnelBytes = positiveInteger(options.maxTunnelBytes ?? 512 * 1_024 * 1_024);
    this.#maxTunnelLifetimeMs = positiveInteger(options.maxTunnelLifetimeMs ?? 10 * 60_000);
    const single = options.resolveAddress;
    this.#resolveAddresses =
      options.resolveAddresses ??
      (single ? async (hostname) => [await single(hostname)] : resolvePublicAddresses);
    this.#timeoutMs = positiveInteger(options.timeoutMs ?? 60_000);
    this.#onRefusal = options.onRefusal;
    const track: TrackSocket = (socket) => this.#track(socket);
    this.#upstreamPending = options.upstreamRequired === true && options.upstream === undefined;
    this.#transport = options.upstream
      ? upstreamTransport(options.upstream, this.#resolveAddresses, this.#timeoutMs, track)
      : directTransport(this.#timeoutMs, track);
    this.#server = createServer((request, response) => void this.#forward(request, response));
    this.#server.maxConnections = this.#maxConnections;
    this.#server.headersTimeout = 10_000;
    this.#server.requestTimeout = this.#timeoutMs;
    this.#server.keepAliveTimeout = 5_000;
    this.#server.on(
      "connect",
      (request, client, head) => void this.#connect(request, client, head),
    );
    this.#server.on("upgrade", (_request, socket) => {
      refuseConnection(socket, 403, "Forbidden");
    });
    this.#server.on("clientError", (_error, socket) => {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    });
  }

  async start(): Promise<{ readonly host: string; readonly port: number }> {
    this.#listening = new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      const ready = () => {
        this.#server.off("error", reject);
        resolve();
      };
      if (this.#listenFd === undefined) this.#server.listen(this.#port, this.#host, ready);
      else this.#server.listen({ fd: this.#listenFd }, ready);
    });
    await this.#listening;
    const address = this.#server.address();
    if (!address || typeof address === "string") throw new Error("Browser egress address missing.");
    return { host: address.address, port: address.port };
  }

  close(): Promise<void> {
    this.#closing ??= this.#dispose();
    return this.#closing;
  }

  async #dispose(): Promise<void> {
    this.#shutdown.abort();
    await this.#listening?.catch(() => undefined);
    const closed = this.#server.listening ? closeHttpServerNow(this.#server) : Promise.resolve();
    for (const socket of [...this.#tunnels, ...this.#upstreams]) socket.destroy();
    this.#transport.agent?.destroy();
    await closed;
  }

  /**
   * Round D, D5: a refusal is reported by its kind and a fixed reason only, never by where it
   * was going: no host name, address, path or message (a message can carry a name).
   */
  #refused(kind: "request" | "tunnel", error: unknown): void {
    if (!this.#onRefusal) return;
    const code = (error as { code?: unknown } | undefined)?.code;
    const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause?.code;
    const system = [code, cause].find(
      (value): value is string => typeof value === "string" && /^E[A-Z0-9_]{1,30}$/u.test(value),
    );
    this.#onRefusal({
      kind,
      reason:
        error === upstreamUnavailable
          ? "upstream-unavailable"
          : system
            ? `error-${system}`
            : "denied",
    });
  }

  #track(upstream: { destroy(): unknown; once(event: "close", listener: () => void): unknown }) {
    this.#upstreams.add(upstream);
    upstream.once("close", () => this.#upstreams.delete(upstream));
  }

  async #setup<T>(client: Duplex, open: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#closing || client.destroyed) throw upstreamUnavailable;
    if (this.#pendingClients.has(client) || this.#pendingConnections >= this.#maxConnections) {
      throw upstreamUnavailable;
    }
    this.#pendingClients.add(client);
    this.#pendingConnections++;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.#shutdown.signal]);
    const abort = () => controller.abort(upstreamUnavailable);
    client.once("close", abort);
    const timeout = setTimeout(abort, this.#timeoutMs);
    timeout.unref();
    const aborted = Promise.withResolvers<never>();
    const onAbort = () => aborted.reject(upstreamUnavailable);
    signal.addEventListener("abort", onAbort, { once: true });
    // A DNS lookup cannot be cancelled. It still occupies its slot until it settles.
    const pending = open(signal).finally(() => {
      this.#pendingClients.delete(client);
      this.#pendingConnections--;
    });
    try {
      return await Promise.race([pending, aborted.promise]);
    } finally {
      clearTimeout(timeout);
      client.off("close", abort);
      signal.removeEventListener("abort", onAbort);
    }
  }

  async #forward(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }
    let tunnel: Socket | undefined;
    let outgoing: ClientRequest | undefined;
    try {
      if (!request.method || !allowedMethods.has(request.method)) throw denied();
      const method = request.method;
      const target = absoluteHttpUrl(request.url);
      const headers = requestHeaders(request, method, this.#maxRequestBytes);
      headers.host = target.host;
      const port = Number(target.port || 80);
      if (smtpPorts.has(port)) throw denied();
      if (this.#upstreamPending) throw upstreamUnavailable;
      const agent = this.#transport.agent;
      request.on("error", () => outgoing?.destroy());
      response.once("close", () => {
        if (!response.writableFinished) outgoing?.destroy();
        tunnel?.destroy();
      });
      const upstream = await this.#setup(request.socket, async (signal) => {
        const addresses = await this.#resolveAddresses(target.hostname);
        signal.throwIfAborted();
        // Each public address in order; the next only after the previous did not connect.
        return connectInOrder(
          addresses,
          (address) =>
            this.#forwardTo(address, port, method, target, headers, agent, signal, {
              response,
              setOutgoing: (value) => (outgoing = value),
              setTunnel: (value) => (tunnel = value),
            }),
          signal,
        );
      });
      if (response.destroyed) {
        upstream.destroy();
        return;
      }
      response.once("error", () => upstream.destroy());
      upstream.setTimeout(this.#timeoutMs, () =>
        upstream.destroy(new Error("Browser egress timed out.")),
      );
      let requestBytes = 0;
      request.on("data", (chunk: Buffer) => {
        requestBytes += chunk.byteLength;
        if (requestBytes > this.#maxRequestBytes) {
          request.destroy();
          upstream.destroy(new Error("Browser request exceeded its byte limit."));
        }
      });
      request.pipe(upstream);
    } catch (error) {
      tunnel?.destroy();
      outgoing?.destroy();
      this.#refused("request", error);
      if (response.destroyed || response.headersSent) return;
      if (error === upstreamUnavailable) {
        response.writeHead(502, { connection: "close" }).end();
        return;
      }
      response.writeHead(403, { connection: "close", "content-type": "text/plain" });
      response.end("Destination denied.\n");
    }
  }

  /** One plain request to one address; resolves once connected, rejects if it cannot. */
  async #forwardTo(
    address: ResolvedPublicAddress,
    port: number,
    method: string,
    target: URL,
    headers: RequestOptions["headers"],
    agent: Agent | undefined,
    signal: AbortSignal,
    context: {
      readonly response: ServerResponse;
      readonly setOutgoing: (request: ClientRequest) => void;
      readonly setTunnel: (socket: Socket) => void;
    },
  ): Promise<ClientRequest> {
    const options: RequestOptions = {
      family: address.family,
      headers,
      hostname: address.address,
      method,
      path: `${target.pathname}${target.search}`,
      port,
      signal,
    };
    if (agent) {
      options.agent = agent;
    } else {
      const connected = await this.#transport.connect(address, port, signal);
      context.setTunnel(connected);
      signal.throwIfAborted();
      options.createConnection = () => connected;
    }
    const upstream = httpRequest(options, (upstreamResponse) => {
      let responseBytes = 0;
      context.response.writeHead(
        upstreamResponse.statusCode ?? 502,
        sanitizeHeaders(upstreamResponse.headers),
      );
      upstreamResponse.on("data", (chunk: Buffer) => {
        responseBytes += chunk.byteLength;
        if (responseBytes > this.#maxResponseBytes) {
          upstreamResponse.destroy(new Error("Browser response exceeded its byte limit."));
          context.response.destroy();
        }
      });
      upstreamResponse.once("error", () => context.response.destroy());
      upstreamResponse.pipe(context.response);
    });
    context.setOutgoing(upstream);
    let connected = false;
    upstream.on("error", () => {
      // Before it connects, a failure only moves on to the next address.
      if (!connected) return;
      if (signal.aborted || context.response.destroyed || context.response.writableEnded) return;
      if (!context.response.headersSent) context.response.writeHead(502, { connection: "close" });
      context.response.end();
    });
    this.#track(upstream);
    await requestConnected(upstream);
    connected = true;
    return upstream;
  }

  async #connect(request: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    if (this.#closing) {
      client.destroy();
      return;
    }
    this.#tunnels.add(client);
    client.once("close", () => this.#tunnels.delete(client));
    let upstream: Socket | undefined;
    client.once("close", () => upstream?.destroy());
    client.once("error", () => client.destroy());
    try {
      if (request.method !== "CONNECT" || head.byteLength > this.#maxTunnelBytes) throw denied();
      const target = connectTarget(request.url);
      if (smtpPorts.has(target.port)) throw denied();
      if (this.#upstreamPending) throw upstreamUnavailable;
      // Watch a detached CONNECT socket for peer shutdown without draining tunnel bytes.
      const onReadable = () => {};
      const onEnd = () => client.destroy();
      client.on("readable", onReadable);
      client.once("end", onEnd);
      try {
        upstream = await this.#setup(client, async (signal) => {
          const addresses = await this.#resolveAddresses(target.hostname);
          signal.throwIfAborted();
          // Each public address in order; the next only after the previous did not connect.
          const socket = await connectInOrder(
            addresses,
            (address) => this.#transport.connect(address, target.port, signal),
            signal,
          );
          if (signal.aborted) socket.destroy();
          return socket;
        });
      } finally {
        client.off("readable", onReadable);
        client.off("end", onEnd);
      }
      if (this.#closing || client.destroyed || upstream.destroyed) throw upstreamUnavailable;
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.byteLength) upstream.write(head);
      let clientBytes = head.byteLength;
      let upstreamBytes = 0;
      const lifetime = setTimeout(() => {
        upstream?.destroy();
        client.destroy();
      }, this.#maxTunnelLifetimeMs);
      lifetime.unref();
      const clearLifetime = () => clearTimeout(lifetime);
      client.on("data", (chunk: Buffer) => {
        clientBytes += chunk.byteLength;
        if (clientBytes > this.#maxTunnelBytes) {
          upstream?.destroy();
          client.destroy();
        }
      });
      upstream.on("data", (chunk: Buffer) => {
        upstreamBytes += chunk.byteLength;
        if (upstreamBytes > this.#maxTunnelBytes) {
          upstream?.destroy();
          client.destroy();
        }
      });
      client.once("close", clearLifetime);
      upstream.once("close", clearLifetime);
      upstream.once("close", () => {
        if (!client.writableEnded) client.destroy();
      });
      upstream.once("error", () => client.destroy());
      client.pipe(upstream).pipe(client);
    } catch (error) {
      upstream?.destroy();
      this.#refused("tunnel", error);
      if (client.destroyed) return;
      if (error === upstreamUnavailable) {
        refuseConnection(client, 502, "Bad Gateway");
      } else {
        refuseConnection(client, 403, "Forbidden");
      }
    }
  }
}

const smtpPorts = new Set([25, 465, 587]);

function directTransport(timeoutMs: number, track: TrackSocket): EgressTransport {
  return {
    agent: new Agent({ keepAlive: true, scheduling: "lifo", timeout: 5_000 }),
    connect(address, port, signal) {
      const socket = connectTcp({ family: address.family, host: address.address, port });
      track(socket);
      const abort = () => socket.destroy();
      signal.addEventListener("abort", abort, { once: true });
      return new Promise((resolve, reject) => {
        socket.once("connect", () => {
          signal.removeEventListener("abort", abort);
          socket.setTimeout(timeoutMs, abort);
          resolve(socket);
        });
        socket.once("error", abort);
        socket.once("close", () => {
          signal.removeEventListener("abort", abort);
          reject(denied());
        });
      });
    },
  };
}

function upstreamTransport(
  upstream: BrowserEgressUpstream,
  resolveAddresses: ResolveAddresses,
  timeoutMs: number,
  track: TrackSocket,
): EgressTransport {
  const servername = tlsServerName(upstream.hostname);
  return {
    async connect(address, port, signal) {
      const candidates = await resolveAddresses(upstream.hostname).catch(() => {
        throw upstreamUnavailable;
      });
      signal.throwIfAborted();
      const host = address.family === 6 ? `[${address.address}]` : address.address;
      const authority = `${host}:${port}`;
      return connectInOrder(
        candidates,
        (resolved) =>
          new Promise<Socket>((resolve, reject) => {
            const tls = connectTls({
              host: resolved.address,
              port: upstream.port,
              ...(servername ? { servername } : {}),
              secureContext: upstream.secureContext,
              rejectUnauthorized: true,
            });
            track(tls);
            const abort = () => tls.destroy();
            signal.addEventListener("abort", abort, { once: true });
            tls.once("error", abort);
            const onClose = () => {
              signal.removeEventListener("abort", abort);
              reject(upstreamUnavailable);
            };
            tls.once("close", onClose);
            tls.once("secureConnect", () => {
              tls.write(
                `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: ${upstream.authorization}\r\n\r\n`,
              );
              const headers = Buffer.allocUnsafe(maxConnectHeaderBytes);
              let headerBytes = 0;
              const readHeaders = (chunk: Buffer) => {
                const previousBytes = headerBytes;
                headerBytes += chunk.copy(headers, previousBytes);
                const end = headers
                  .subarray(0, headerBytes)
                  .indexOf("\r\n\r\n", Math.max(0, previousBytes - 3));
                if (end === -1) {
                  if (headerBytes === maxConnectHeaderBytes) abort();
                  return;
                }
                if (!validConnectResponse(headers.subarray(0, end))) {
                  abort();
                  return;
                }
                tls.pause();
                tls.off("data", readHeaders);
                tls.unshift(chunk.subarray(end + 4 - previousBytes));
                signal.removeEventListener("abort", abort);
                tls.off("close", onClose);
                tls.setTimeout(timeoutMs, abort);
                resolve(tls);
              };
              tls.on("data", readHeaders);
            });
          }),
        signal,
      );
    },
  };
}

function requestConnected(request: ClientRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    const closed = () => reject(upstreamUnavailable);
    request.once("close", closed);
    request.once("socket", (socket: Socket) => {
      const connected = () => {
        request.off("close", closed);
        resolve();
        socket.resume();
      };
      if (socket.destroyed) return;
      if (socket.connecting) socket.once("connect", connected);
      else connected();
    });
  });
}

function validConnectResponse(headers: Buffer): boolean {
  const [status = "", ...fields] = headers.toString("latin1").split("\r\n");
  return (
    /^HTTP\/1\.[01] 2[0-9]{2} [\t\x20-\x7e\x80-\xff]*$/u.test(status) &&
    fields.every((field) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+:[\t\x20-\x7e\x80-\xff]*$/u.test(field))
  );
}

function absoluteHttpUrl(value: string | undefined): URL {
  if (!value) throw denied();
  const url = new URL(value);
  if (url.protocol !== "http:" || url.username || url.password || url.hash) throw denied();
  return url;
}

function connectTarget(value: string | undefined): {
  readonly hostname: string;
  readonly port: number;
} {
  if (!value || /[\s/@\\?#]/u.test(value)) throw denied();
  const explicitPort = /:([0-9]+)$/u.exec(value)?.[1];
  if (!explicitPort) throw denied();
  const url = new URL(`http://${value}`);
  if (url.pathname !== "/" || url.search || url.hash) throw denied();
  const port = Number(explicitPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw denied();
  const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  if (!hostname || (isIP(hostname) === 0 && hostname.length > 253)) throw denied();
  return { hostname, port };
}

function requestHeaders(
  request: IncomingMessage,
  method: string,
  maxRequestBytes: number,
): Record<string, string | string[]> {
  const length = request.headers["content-length"];
  const coding = request.headers["transfer-encoding"];
  if (
    coding !== undefined &&
    (length !== undefined ||
      coding.toLowerCase() !== "chunked" ||
      request.httpVersion !== "1.1" ||
      bodylessMethods.has(method))
  ) {
    throw denied();
  }
  const headers = sanitizeHeaders(request.headers);
  if (length !== undefined) {
    const bytes = Number(length);
    if (
      !/^[0-9]+$/u.test(length) ||
      !Number.isSafeInteger(bytes) ||
      bytes > maxRequestBytes ||
      (bytes > 0 && bodylessMethods.has(method))
    ) {
      throw denied();
    }
    headers["content-length"] = String(bytes);
  }
  if (coding !== undefined) headers["transfer-encoding"] = "chunked";
  return headers;
}

function sanitizeHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  const connectionTokens = new Set(
    String(headers.connection ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  let bytes = 0;
  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (
      value === undefined ||
      hopByHopHeaders.has(lowerName) ||
      connectionTokens.has(lowerName) ||
      lowerName === "host"
    ) {
      continue;
    }
    const normalized = typeof value === "string" ? value : value.map(String);
    bytes +=
      Buffer.byteLength(name) +
      (typeof normalized === "string"
        ? Buffer.byteLength(normalized)
        : normalized.reduce((total, item) => total + Buffer.byteLength(item), 0));
    if (bytes > 256 * 1_024) throw denied();
    result[name] = normalized;
  }
  return result;
}

function denied(): Error {
  return new Error("Browser egress destination denied.");
}

function positiveInteger(value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new TypeError("Expected a positive integer.");
  return value;
}
