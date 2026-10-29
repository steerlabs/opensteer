import {
  Agent,
  request as httpRequest,
  type IncomingHttpHeaders,
  type RequestOptions,
} from "node:http";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as connectTcp, isIP, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { resolvePublicAddress, type ResolvedPublicAddress } from "@opensteer/access";
import { closeHttpServerNow, refuseConnection } from "@opensteer/shared/httpServer";

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

interface PublicBrowserEgressProxyOptions {
  readonly host?: string;
  readonly maxConnections?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly maxTunnelBytes?: number;
  readonly maxTunnelLifetimeMs?: number;
  readonly port?: number;
  readonly resolveAddress?: (hostname: string) => Promise<ResolvedPublicAddress>;
  readonly timeoutMs?: number;
}

/**
 * Forward proxy for hosted Chromium. Every new HTTP request and CONNECT tunnel
 * resolves its destination once, rejects any non-public answer, then connects
 * to that exact address. Redirects and subresources arrive as new requests and
 * cross the same check. Closing ends every connection, tunnel and upstream at
 * once, and nothing resolved after that point is connected.
 */
export class PublicBrowserEgressProxy {
  /**
   * Keeps forwarded requests' connections for reuse as Node's shared pool
   * does, apart from it, so that closing can end the idle ones too.
   */
  readonly #agent = new Agent({ keepAlive: true, scheduling: "lifo", timeout: 5_000 });
  #closing: Promise<void> | null = null;
  readonly #host: string;
  #listening: Promise<void> | null = null;
  readonly #maxRequestBytes: number;
  readonly #maxResponseBytes: number;
  readonly #maxTunnelBytes: number;
  readonly #maxTunnelLifetimeMs: number;
  readonly #port: number;
  readonly #resolveAddress: (hostname: string) => Promise<ResolvedPublicAddress>;
  readonly #server: Server;
  readonly #timeoutMs: number;
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
    await this.#listening?.catch(() => undefined);
    const closed = this.#server.listening ? closeHttpServerNow(this.#server) : Promise.resolve();
    for (const socket of [...this.#tunnels, ...this.#upstreams]) socket.destroy();
    this.#agent.destroy();
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
    try {
      if (!request.method || !allowedMethods.has(request.method)) throw denied();
      const target = absoluteHttpUrl(request.url);
      const address = await this.#resolveAddress(target.hostname);
      if (this.#closing) throw denied();
      const headers = sanitizeHeaders(request.headers);
      headers.host = target.host;
      const options: RequestOptions = {
        agent: this.#agent,
        family: address.family,
        headers,
        hostname: address.address,
        method: request.method,
        path: `${target.pathname}${target.search}`,
        port: target.port || 80,
      };
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
    } catch {
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
    let upstream: Socket | null = null;
    client.once("error", () => upstream?.destroy());
    try {
      if (request.method !== "CONNECT") throw denied();
      const target = connectTarget(request.url);
      const address = await this.#resolveAddress(target.hostname);
      if (this.#closing || client.destroyed) throw denied();
      upstream = connectTcp({ family: address.family, host: address.address, port: target.port });
      this.#track(upstream);
      upstream.setTimeout(this.#timeoutMs, () => upstream?.destroy());
      await new Promise<void>((resolve, reject) => {
        upstream?.once("connect", resolve);
        upstream?.once("error", reject);
        // Destroyed before it connected: by its timeout, the client or closing.
        upstream?.once("close", () => reject(denied()));
      });
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
      upstream.once("error", () => client.destroy());
      client.pipe(upstream).pipe(client);
    } catch {
      upstream?.destroy();
      refuseConnection(client, 403, "Forbidden");
    }
  }
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
