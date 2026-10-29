import { STATUS_CODES, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { OpensteerError, RunnerIdSchema } from "@opensteer/core";
import { shellDataMessageMaxBytes } from "@opensteer/protocol";
import type { FastifyInstance } from "fastify";
import { WebSocketServer, type WebSocket } from "ws";
import { normalizeHostError } from "../server/http-errors.js";
import { hostInternalRoutePaths } from "../server/internal-routes.js";
import { ShellConnectRejection } from "./shell-connect-error.js";
import type { ShellControlStreamHandler } from "./shell-control-stream.js";

type UpgradeListener = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

/**
 * The two sockets one shell session is made of.
 *
 * Both carry raw SSH bytes as binary WebSocket messages and nothing else, and
 * both are held to the 256 KiB message the transport contract states. That
 * bound has to be the receiver's own: applied after reassembly it is not a
 * bound at all, because the whole message has been buffered before any handler
 * could measure it. `ws` reads the limit from the server that accepted the
 * upgrade, and the Host runs one sized for browser relay frames — roughly
 * 8 MiB — so these two paths accept their own upgrades, on a server of their
 * own with the smaller limit and no compression (SSH bytes are already
 * encrypted; compressing them buys nothing and costs a context per socket).
 *
 * Owning the upgrade means owning the refusal too. The caller's socket is
 * upgraded only after its session is active: everything that can refuse it
 * happens first and answers with an ordinary HTTP 4xx whose body is one
 * sentence the ssh proxy prints verbatim, because a WebSocket that opened and
 * then closed could say nothing a person would ever read.
 */
export function registerShellRoutes(
  app: FastifyInstance,
  options: { readonly shell: ShellControlStreamHandler },
): void {
  const sockets = new WebSocketServer({
    maxPayload: shellDataMessageMaxBytes,
    noServer: true,
    perMessageDeflate: false,
  });
  const server = app.server;
  // Every other WebSocket route on this Host is served by the plugin's own
  // upgrade listener, which must keep seeing everything that is not ours. If
  // it is not there, the assumption this is built on is gone: fail loudly
  // rather than quietly leave shell sockets on the Host-wide limit.
  const inherited = server.listeners("upgrade") as UpgradeListener[];
  if (inherited.length === 0) {
    throw new Error(
      "Shell sockets need the Host's WebSocket upgrade handling, which is not set up",
    );
  }
  server.removeAllListeners("upgrade");
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const route = shellRoute(request);
    if (!route) {
      for (const listener of inherited) listener.call(server, request, socket, head);
      return;
    }
    // A socket that goes away mid-admission must not throw an unhandled error
    // out of the event loop; the abort below is what the admission reads.
    socket.on("error", () => undefined);
    void admitShellSocket({ head, request, route, socket, sockets, ...options });
  });
  app.addHook("preClose", async () => {
    for (const client of sockets.clients) client.close(1001, "Host shutting down");
  });
}

async function admitShellSocket(input: {
  readonly head: Buffer;
  readonly request: IncomingMessage;
  readonly route: "connect" | "data";
  readonly shell: ShellControlStreamHandler;
  readonly socket: Duplex;
  readonly sockets: WebSocketServer;
}): Promise<void> {
  try {
    if (input.route === "connect") {
      const controller = new AbortController();
      input.socket.once("close", () => controller.abort());
      const sessionId = await input.shell.connect({
        signal: controller.signal,
        target: connectTarget(input.request),
        token: connectToken(input.request),
      });
      upgradeShellSocket(input, (socket) => input.shell.attachCaller(sessionId, socket));
      return;
    }
    const sessionId = await input.shell.claimDataSocket(shellBearerToken(input.request));
    upgradeShellSocket(input, (socket) => input.shell.attachDataSocket(sessionId, socket));
  } catch (error) {
    refuseShellUpgrade(input.socket, error);
  }
}

function upgradeShellSocket(
  input: {
    readonly head: Buffer;
    readonly request: IncomingMessage;
    readonly socket: Duplex;
    readonly sockets: WebSocketServer;
  },
  attach: (socket: WebSocket) => void,
): void {
  input.sockets.handleUpgrade(input.request, input.socket, input.head, (socket) => {
    // The hub adds its own handling the moment it takes the socket; this is
    // only so the gap before that cannot throw.
    socket.on("error", () => undefined);
    attach(socket);
  });
}

/**
 * A refusal written as an ordinary HTTP response.
 *
 * The ssh proxy reads the body and prints the sentence in it, so the shape has
 * to be exactly what every other Host route answers with — the same status
 * ladder and the same envelope — rather than a bare status line.
 */
function refuseShellUpgrade(socket: Duplex, error: unknown): void {
  const refusal =
    error instanceof ShellConnectRejection
      ? { body: error.body(), status: error.status }
      : refusalFromError(error);
  if (socket.destroyed || !socket.writable) return;
  const payload = Buffer.from(JSON.stringify(refusal.body), "utf8");
  socket.write(
    `HTTP/1.1 ${refusal.status} ${STATUS_CODES[refusal.status] ?? "Error"}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: application/json; charset=utf-8\r\n" +
      `Content-Length: ${payload.byteLength}\r\n` +
      "\r\n",
  );
  socket.end(payload);
}

function refusalFromError(error: unknown): { readonly body: unknown; readonly status: number } {
  const normalized = normalizeHostError(error);
  return { body: { error: normalized.error }, status: normalized.status };
}

function shellRoute(request: IncomingMessage): "connect" | "data" | null {
  if (request.method !== "GET") return null;
  const path = requestPath(request);
  if (path === hostInternalRoutePaths.shellConnect) return "connect";
  if (path === hostInternalRoutePaths.shellData) return "data";
  return null;
}

function requestPath(request: IncomingMessage): string {
  const url = request.url ?? "";
  const query = url.indexOf("?");
  return query === -1 ? url : url.slice(0, query);
}

function connectToken(request: IncomingMessage): string {
  try {
    return shellBearerToken(request);
  } catch {
    throw new ShellConnectRejection("run_invalid", "This Run has ended.");
  }
}

/**
 * The machine the caller asked for. A malformed id names no machine, which is
 * the same answer as an id that names none, so it is reported the same way
 * rather than as a schema complaint nobody can act on.
 */
function connectTarget(request: IncomingMessage) {
  const url = request.url ?? "";
  const query = url.indexOf("?");
  const raw = query === -1 ? null : new URLSearchParams(url.slice(query + 1)).get("target");
  const parsed = RunnerIdSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const named = typeof raw === "string" ? raw.replaceAll(/[^\x20-\x7e]/gu, "").slice(0, 64) : "";
  throw new ShellConnectRejection(
    "target_unknown",
    `No computer ${named || "of that name"} is enrolled in this Deployment.`,
  );
}

function shellBearerToken(request: IncomingMessage): string {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ") || value.length > 8_303) {
    throw new OpensteerError({ code: "unauthorized", message: "Bearer token is required" });
  }
  const token = value.slice("Bearer ".length);
  if (!token || /\s/u.test(token)) {
    throw new OpensteerError({ code: "unauthorized", message: "Bearer token is invalid" });
  }
  return token;
}
