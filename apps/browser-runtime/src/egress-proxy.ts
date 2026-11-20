import {
  Agent,
  request as httpRequest,
  type IncomingHttpHeaders,
  type RequestOptions,
} from "node:http";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as connectTcp, isIP, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { connect as connectTls } from "node:tls";
import { resolvePublicAddress, tlsServerName, type ResolvedPublicAddress } from "@opensteer/access";
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
const upstreamUnavailable = refused("internal", "Browser egress upstream is unavailable.");
const maxConnectHeaderBytes = 16 * 1024;

type ResolveAddress = (hostname: string) => Promise<ResolvedPublicAddress>;
type TrackSocket = (socket: Socket) => void;

interface EgressTransport {
  readonly agent?: Agent;
  connect(address: ResolvedPublicAddress, port: number, signal: AbortSignal): Promise<Socket>;
}

interface PublicBrowserEgressProxyOptions {
  readonly host?: string;
  readonly maxConnections?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly maxTunnelBytes?: number;
  readonly maxTunnelLifetimeMs?: number;
  readonly port?: number;
  readonly resolveAddress?: ResolveAddress;
  readonly timeoutMs?: number;
  readonly upstream?: BrowserEgressUpstream;
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
  readonly #maxRequestBytes: number;
  readonly #maxResponseBytes: number;
  readonly #maxTunnelBytes: number;
  readonly #maxTunnelLifetimeMs: number;
  readonly #port: number;
  readonly #resolveAddress: ResolveAddress;
  readonly #server: Server;
  readonly #shutdown = new AbortController();
  readonly #timeoutMs: number;
  readonly #transport: EgressTransport;
  /** CONNECT clients, which leave the server's HTTP connections yet hold its close. */
  readonly #tunnels = new Set<Duplex>();
  /** Connections and requests made on a client's behalf, until each closes. */
  readonly #upstreams = new Set<{ destroy(): unknown }>();

  constructor(options: PublicBrowserEgressProxyOptions = {}) {
    this.#host = options.host ?? "127.0.0.1";
    this.#port = options.port ?? 4_313;
    this.#maxRequestBytes = positiveInteger(options.maxRequestBytes ?? 32 * 1_024 * 1_024);
    this.#maxResponseBytes = positiveInteger(options.maxResponseBytes ?? 64 * 1_024 * 1_024);
    this.#maxTunnelBytes = positiveInteger(options.maxTunnelBytes ?? 512 * 1_024 * 1_024);
    this.#maxTunnelLifetimeMs = positiveInteger(options.maxTunnelLifetimeMs ?? 10 * 60_000);
    this.#resolveAddress = options.resolveAddress ?? resolvePublicAddress;
    this.#timeoutMs = positiveInteger(options.timeoutMs ?? 60_000);
    const track: TrackSocket = (socket) => this.#track(socket);
    this.#transport = options.upstream
      ? upstreamTransport(
          options.upstream,
          this.#resolveAddress,
          this.#timeoutMs,
          this.#shutdown.signal,
          track,
        )
      : directTransport(this.#timeoutMs, track);
    this.#server = createServer((request, response) => void this.#forward(request, response));
    this.#server.maxConnections = positiveInteger(options.maxConnections ?? 512);
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
      this.#server.listen(this.#port, this.#host, () => {
        this.#server.off("error", reject);
        resolve();
      });
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

  #track(upstream: { destroy(): unknown; once(event: "close", listener: () => void): unknown }) {
    this.#upstreams.add(upstream);
    upstream.once("close", () => this.#upstreams.delete(upstream));
  }

  async #forward(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }
    let tunnel: Socket | undefined;
    try {
      if (!request.method || !allowedMethods.has(request.method)) throw denied();
      const target = absoluteHttpUrl(request.url);
      const address = await this.#resolveAddress(target.hostname);
      if (this.#closing) throw denied();
      const headers = sanitizeHeaders(request.headers);
      const agent = this.#transport.agent;
      const port = target.port || 80;
      headers.host = agent ? target.host : (request.headers.host ?? target.host);
      const options: RequestOptions = {
        family: address.family,
        headers,
        hostname: address.address,
        method: request.method,
        path: `${target.pathname}${target.search}`,
        port,
      };
      if (agent) {
        options.agent = agent;
      } else {
        const controller = new AbortController();
        response.once("close", () => {
          controller.abort();
          tunnel?.destroy();
        });
        request.once("error", () => controller.abort());
        if (response.destroyed) return;
        const connected = await this.#transport.connect(address, Number(port), controller.signal);
        tunnel = connected;
        if (this.#closing || response.destroyed) {
          tunnel.destroy();
          return;
        }
        options.createConnection = () => connected;
      }
      const upstream = httpRequest(options, (upstreamResponse) => {
        let responseBytes = 0;
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          sanitizeHeaders(upstreamResponse.headers),
        );
        upstreamResponse.on("data", (chunk: Buffer) => {
          responseBytes += chunk.byteLength;
          if (responseBytes > this.#maxResponseBytes) {
            upstreamResponse.destroy(new Error("Browser response exceeded its byte limit."));
            response.destroy();
          }
        });
        upstreamResponse.once("error", () => response.destroy());
        upstreamResponse.pipe(response);
      });
      if (tunnel) upstream.once("socket", (socket) => socket.resume());
      this.#track(upstream);
      request.once("error", () => upstream.destroy());
      response.once("error", () => upstream.destroy());
      upstream.setTimeout(this.#timeoutMs, () =>
        upstream.destroy(new Error("Browser egress timed out.")),
      );
      upstream.once("error", () => {
        if (!response.headersSent) response.writeHead(502, { connection: "close" });
        response.end();
      });
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
      if (error === upstreamUnavailable) {
        if (!response.destroyed) response.writeHead(502, { connection: "close" }).end();
        return;
      }
      response.writeHead(403, { connection: "close", "content-type": "text/plain" });
      response.end("Destination denied.\n");
    }
  }

  async #connect(request: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    if (this.#closing) {
      client.destroy();
      return;
    }
    this.#tunnels.add(client);
    client.once("close", () => this.#tunnels.delete(client));
    const managed = !this.#transport.agent;
    const controller = new AbortController();
    let upstream: Socket | null = null;
    if (managed) {
      client.once("close", () => {
        controller.abort();
        upstream?.destroy();
      });
    }
    client.once("error", () => {
      controller.abort();
      upstream?.destroy();
    });
    try {
      if (request.method !== "CONNECT") throw denied();
      const target = connectTarget(request.url);
      const address = await this.#resolveAddress(target.hostname);
      if (this.#closing || client.destroyed) throw denied();
      if (managed && head.byteLength > this.#maxTunnelBytes) throw denied();
      upstream = await this.#transport.connect(address, target.port, controller.signal);
      if (this.#closing || client.destroyed) throw denied();
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
      if (managed) {
        upstream.once("close", () => {
          if (!client.writableEnded) client.destroy();
        });
      }
      upstream.once("error", () => client.destroy());
      client.pipe(upstream).pipe(client);
    } catch (error) {
      upstream?.destroy();
      if (error === upstreamUnavailable) {
        refuseConnection(client, 502, "Bad Gateway");
      } else {
        refuseConnection(client, 403, "Forbidden");
      }
    }
  }
}

function directTransport(timeoutMs: number, track: TrackSocket): EgressTransport {
  return {
    agent: new Agent({ keepAlive: true, scheduling: "lifo", timeout: 5_000 }),
    connect(address, port, signal) {
      const socket = connectTcp({ family: address.family, host: address.address, port });
      track(socket);
      socket.setTimeout(timeoutMs, () => socket.destroy());
      const abort = () => socket.destroy();
      signal.addEventListener("abort", abort, { once: true });
      socket.once("close", () => signal.removeEventListener("abort", abort));
      return new Promise((resolve, reject) => {
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
        socket.once("close", () => reject(denied()));
      });
    },
  };
}

function upstreamTransport(
  upstream: BrowserEgressUpstream,
  resolveAddress: ResolveAddress,
  timeoutMs: number,
  shutdown: AbortSignal,
  track: TrackSocket,
): EgressTransport {
  const servername = tlsServerName(upstream.hostname);
  return {
    connect(address, port, clientSignal) {
      const signal = AbortSignal.any([clientSignal, shutdown]);
      const host = address.family === 6 ? `[${address.address}]` : address.address;
      const authority = `${host}:${port}`;
      return new Promise((resolve, reject) => {
        let socket: Socket | undefined;
        let finished = false;
        const timeout = setTimeout(fail, timeoutMs);
        timeout.unref();
        const finish = () => {
          finished = true;
          clearTimeout(timeout);
          signal.removeEventListener("abort", fail);
        };
        function fail() {
          if (finished) return;
          finish();
          socket?.destroy();
          reject(upstreamUnavailable);
        }
        signal.addEventListener("abort", fail, { once: true });
        if (signal.aborted) {
          fail();
          return;
        }
        void resolveAddress(upstream.hostname)
          .then((resolved) => {
            if (finished) return;
            const tls = connectTls({
              host: resolved.address,
              port: upstream.port,
              ...(servername ? { servername } : {}),
              secureContext: upstream.secureContext,
              rejectUnauthorized: true,
            });
            socket = tls;
            track(tls);
            tls.once("error", fail);
            tls.once("close", fail);
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
                  if (headerBytes === maxConnectHeaderBytes) fail();
                  return;
                }
                if (!validConnectResponse(headers.subarray(0, end))) {
                  fail();
                  return;
                }
                tls.pause();
                tls.off("data", readHeaders);
                tls.unshift(chunk.subarray(end + 4 - previousBytes));
                finish();
                tls.setTimeout(timeoutMs, () => tls.destroy());
                resolve(tls);
              };
              tls.on("data", readHeaders);
            });
          })
          .catch(fail);
      });
    },
  };
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
  if (!value || /[\s/@]/u.test(value)) throw denied();
  const url = new URL(`http://${value}`);
  if (url.pathname !== "/" || url.search || url.hash || !url.port) throw denied();
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw denied();
  const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  if (!hostname || (isIP(hostname) === 0 && hostname.length > 253)) throw denied();
  return { hostname, port };
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
