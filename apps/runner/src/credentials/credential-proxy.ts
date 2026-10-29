import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { RunnerConfig } from "@opensteer/config";
import { allowsPlaintextRunnerTransport } from "@opensteer/core";
import { agentToolPayloadMaxSerializedBytes } from "@opensteer/protocol";
import { closeHttpServerNow, refuseConnection } from "@opensteer/shared/httpServer";

export type CredentialRouteName = "agent-tools" | "integration-tools";

export interface CredentialRoute {
  /** The Host endpoint this route stands in for. */
  readonly upstream: string;
  /** The Host token current at the moment of each call; refresh replaces it. */
  readonly token: () => string;
}

const allowedMethods = new Set(["DELETE", "GET", "POST"]);
/** The Host's own limit on these routes; a larger body could only be refused there. */
const defaultMaxBodyBytes = agentToolPayloadMaxSerializedBytes + 32 * 1_024;
/** A body that has not arrived by then never will. */
const bodyReadTimeoutMs = 30_000;
// MCP's streamable HTTP transport needs these; nothing else crosses, so the
// engine's secret, cookies and hop-by-hop headers never reach the Host.
const forwardedRequestHeaders = [
  "accept",
  "content-type",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
] as const;
const forwardedResponseHeaders = [
  "cache-control",
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id",
] as const;

/**
 * Stands in for the Host's tool endpoints on loopback, for one Run. The engine
 * gets this listener's URLs and a secret that works nowhere else; the Host
 * token stays in the Runner and is read at each call, so a refreshed token
 * takes effect at once and a revoked one ends every call. Loopback is not
 * tenant isolation: the process sandbox still decides who can reach it.
 */
export class CredentialProxy {
  readonly #inFlight = new Set<AbortController>();
  /** Open server-to-client streams, which may last as long as the engine wants. */
  #openStreams = 0;
  readonly #maxBodyBytes: number;
  readonly #maxCalls: number;
  readonly #maxStreams: number;
  readonly #prefix = `/${randomBytes(18).toString("base64url")}`;
  readonly #routes: ReadonlyMap<string, { readonly upstream: URL; readonly token: () => string }>;
  readonly #secret = Buffer.from(randomBytes(32).toString("base64url"));
  readonly #server: Server;
  #closed = false;
  #listening: Promise<unknown> | null = null;
  #revoked = false;
  /** Between the Runs of a warm engine: no Run's authority stands behind it. */
  #suspended = false;

  constructor(options: {
    readonly maxBodyBytes?: number;
    /** Concurrent calls (POST and DELETE). */
    readonly maxCalls?: number;
    /** Concurrent server-to-client streams (GET), budgeted apart so they cannot starve calls. */
    readonly maxStreams?: number;
    readonly routes: Readonly<Record<CredentialRouteName, CredentialRoute>>;
    readonly transport: Pick<RunnerConfig, "mode">;
  }) {
    this.#maxBodyBytes = options.maxBodyBytes ?? defaultMaxBodyBytes;
    this.#maxCalls = options.maxCalls ?? 32;
    this.#maxStreams = options.maxStreams ?? 8;
    this.#routes = new Map(
      Object.entries(options.routes).map(([name, route]) => [
        `${this.#prefix}/${name}`,
        { token: route.token, upstream: validateUpstream(route.upstream, options.transport) },
      ]),
    );
    this.#server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    // A tunnel would let the engine reach anything with this listener's help.
    this.#server.on("connect", (_request, socket) => {
      refuseConnection(socket, 405, "Method Not Allowed");
    });
  }

  async start(): Promise<{
    readonly secret: string;
    readonly urls: Readonly<Record<CredentialRouteName, string>>;
  }> {
    if (this.#listening || this.#closed) throw new Error("Credential proxy cannot be started");
    this.#server.listen(0, "127.0.0.1");
    this.#listening = once(this.#server, "listening");
    await this.#listening;
    const address = this.#server.address();
    if (!address || typeof address === "string") {
      throw new Error("Credential proxy address is unavailable");
    }
    const base = `http://127.0.0.1:${address.port}${this.#prefix}`;
    return {
      secret: this.#secret.toString("utf8"),
      urls: {
        "agent-tools": `${base}/agent-tools`,
        "integration-tools": `${base}/integration-tools`,
      },
    };
  }

  /** Authority ended: refuse new calls and end the open ones. */
  revoke(): void {
    this.#revoked = true;
    for (const call of this.#inFlight) call.abort();
  }

  /** Whether it can carry another Run: neither revoked nor closed. */
  get usable(): boolean {
    return !this.#revoked && !this.#closed;
  }

  /** A warm engine went idle: nothing it sends reaches the Host until the next Run resumes it. */
  suspend(): void {
    this.#suspended = true;
    for (const call of this.#inFlight) call.abort();
  }

  /** The next Run of a warm engine holds this proxy; its route tokens are that Run's. */
  resume(): void {
    if (this.#revoked || this.#closed) throw new Error("A revoked credential proxy cannot resume");
    this.#suspended = false;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.revoke();
    if (!this.#listening) return;
    await this.#listening.catch(() => undefined);
    // Revoked calls end their streams cleanly; give them a moment to do so
    // before dropping whatever connection is left.
    const deadline = Date.now() + 1_000;
    while (this.#inFlight.size > 0 && Date.now() < deadline) await delay(10);
    if (this.#server.listening) await closeHttpServerNow(this.#server);
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Only origin-form targets name a route here; anything else names a host.
    if (!request.url?.startsWith("/")) return reply(response, 400);
    const target = new URL(request.url, "http://127.0.0.1");
    const route = target.search ? undefined : this.#routes.get(target.pathname);
    if (!route) return reply(response, 404);
    if (!allowedMethods.has(request.method ?? "")) return reply(response, 405);
    if (!this.#authorized(request.headers.authorization)) return reply(response, 401);
    if (this.#revoked || this.#closed || this.#suspended) return reply(response, 403);
    const stream = request.method === "GET";
    if (stream ? this.#openStreams >= this.#maxStreams : this.#calls() >= this.#maxCalls) {
      return reply(response, 503);
    }
    const call = new AbortController();
    this.#inFlight.add(call);
    if (stream) this.#openStreams += 1;
    response.on("close", () => call.abort());
    try {
      const body = await this.#readBody(request, call.signal);
      if (body === "too-large") return reply(response, 413);
      if (body === "timed-out") return reply(response, 408);
      const headers = new Headers({ authorization: `Bearer ${route.token()}` });
      for (const name of forwardedRequestHeaders) {
        const value = request.headers[name];
        if (typeof value === "string") headers.set(name, value);
      }
      const upstream = await fetch(route.upstream, {
        ...(body.length > 0 ? { body: new Uint8Array(body) } : {}),
        headers,
        method: request.method ?? "GET",
        redirect: "manual",
        signal: call.signal,
      });
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel();
        return reply(response, 502);
      }
      const outgoing: Record<string, string> = {};
      for (const name of forwardedResponseHeaders) {
        const value = upstream.headers.get(name);
        if (value !== null) outgoing[name] = value;
      }
      response.writeHead(upstream.status, outgoing);
      if (!upstream.body) {
        response.end();
        return;
      }
      await relay(
        Readable.fromWeb(upstream.body as WebReadableStream<Uint8Array>),
        response,
        () => this.#revoked,
      );
    } catch {
      // A call cut off by revocation was refused, not failed upstream. Any
      // other failure after the reply began is a broken reply, so the
      // connection breaks too rather than end as if it were complete.
      if (!response.headersSent) reply(response, this.#revoked ? 403 : 502);
      else if (this.#revoked) response.end();
      else response.destroy();
    } finally {
      this.#inFlight.delete(call);
      if (stream) this.#openStreams -= 1;
    }
  }

  #calls(): number {
    return this.#inFlight.size - this.#openStreams;
  }

  #authorized(header: string | undefined): boolean {
    if (!header?.startsWith("Bearer ")) return false;
    const presented = Buffer.from(header.slice("Bearer ".length));
    return presented.length === this.#secret.length && timingSafeEqual(presented, this.#secret);
  }

  async #readBody(
    request: IncomingMessage,
    signal: AbortSignal,
  ): Promise<Buffer | "timed-out" | "too-large"> {
    const declared = Number(request.headers["content-length"] ?? 0);
    if (declared > this.#maxBodyBytes) {
      request.resume();
      return "too-large";
    }
    const maxBodyBytes = this.#maxBodyBytes;
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let tooLarge = false;
      const cleanup = () => {
        clearTimeout(timer);
        request.off("data", onData).off("end", onEnd).off("error", onError);
        signal.removeEventListener("abort", onAbort);
      };
      const onData = (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBodyBytes) tooLarge = true;
        else chunks.push(chunk);
      };
      const onEnd = () => {
        cleanup();
        resolve(tooLarge ? "too-large" : Buffer.concat(chunks));
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        cleanup();
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        cleanup();
        request.resume();
        resolve("timed-out");
      }, bodyReadTimeoutMs);
      request.on("data", onData).on("end", onEnd).on("error", onError);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/**
 * Relays the Host's body to the engine. A revoked call ends cleanly, as a
 * refusal; any other upstream failure breaks the connection, so a truncated
 * body is never read as a complete one.
 */
function relay(source: Readable, response: ServerResponse, revoked: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    source.on("error", (error) => {
      if (revoked()) {
        if (!response.writableEnded) response.end();
      } else {
        response.destroy(error);
      }
      resolve();
    });
    source.on("end", () => {
      if (!response.writableEnded) response.end();
      resolve();
    });
    response.on("close", () => {
      source.destroy();
      resolve();
    });
    source.pipe(response, { end: false });
  });
}

function reply(response: ServerResponse, status: number): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      error: { code: -32_000, message: refusalMessages[status] ?? "Request refused" },
      id: null,
      jsonrpc: "2.0",
    }),
  );
}

const refusalMessages: Readonly<Record<number, string>> = {
  400: "Bad request",
  401: "Unauthorized",
  403: "This Run's tool access has ended",
  404: "Not found",
  405: "Method not allowed",
  408: "The request body did not arrive in time",
  413: "The request is larger than the Host accepts",
  502: "The Host could not be reached",
  503: "Too many concurrent tool calls",
};

function validateUpstream(value: string, transport: Pick<RunnerConfig, "mode">): URL {
  const url = new URL(value);
  if (url.username || url.password || url.hash || url.search) {
    throw new Error("A credential proxy upstream cannot carry credentials, a query, or a fragment");
  }
  if (url.protocol !== "https:" && !allowsPlaintextRunnerTransport(transport.mode, url)) {
    throw new Error(
      "A credential proxy upstream must use HTTPS outside an allowed loopback placement",
    );
  }
  return url;
}
