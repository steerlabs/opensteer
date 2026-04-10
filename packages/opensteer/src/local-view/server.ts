import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  OpensteerLocalViewSessionCloseResponse,
  OpensteerLocalViewSessionsResponse,
  OpensteerSessionAccessGrantResponse,
} from "@opensteer/protocol";

import { listResolvedLocalViewSessions, resolveLocalViewSession } from "./discovery.js";
import { LocalViewCdpProxy } from "./cdp-proxy.js";
import { CURRENT_PROCESS_OWNER } from "../local-browser/process-owner.js";
import { LocalViewRuntimeState } from "./runtime-state.js";
import { clearLocalViewServiceState } from "./service-state.js";
import {
  OPENSTEER_LOCAL_VIEW_SERVICE_LAYOUT,
  OPENSTEER_LOCAL_VIEW_SERVICE_VERSION,
  writeLocalViewServiceState,
} from "./service-state.js";
import { LocalViewStreamHub } from "./view-stream.js";
import { LocalViewWebSocketServer } from "./ws-types.js";

const DEFAULT_MAX_FPS = 12;
const DEFAULT_QUALITY = 75;
const DEFAULT_MAX_CLIENT_BUFFER_BYTES = 512 * 1024;
const LOCAL_VIEW_ACCESS_EXPIRES_AT = Number.MAX_SAFE_INTEGER;

export interface LocalViewServer {
  readonly url: string;
  readonly token: string;
  close(): Promise<void>;
}

export async function startLocalViewServer(
  input: {
    readonly port?: number;
    readonly token?: string;
    readonly onClosed?: () => void | Promise<void>;
  } = {},
): Promise<LocalViewServer> {
  const token = input.token ?? randomBytes(24).toString("hex");
  const runtimeState = new LocalViewRuntimeState();
  const viewStreamHub = new LocalViewStreamHub({
    runtimeState,
    maxFps: DEFAULT_MAX_FPS,
    quality: DEFAULT_QUALITY,
    maxClientBufferBytes: DEFAULT_MAX_CLIENT_BUFFER_BYTES,
  });
  const cdpProxy = new LocalViewCdpProxy({
    runtimeState,
  });

  const httpServer = createServer((request, response) => {
    void handleHttpRequest({ request, response, token, shutdown: closeServer }).catch(() => {
      if (!response.headersSent && !response.writableEnded) {
        writeJson(response, 500, { error: "Internal server error." });
        return;
      }
      response.destroy();
    });
  });

  const viewWss = new LocalViewWebSocketServer({ noServer: true });
  viewWss.on("connection", (ws, request: IncomingMessage) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    const sessionId = parts[2];
    if (!sessionId) {
      ws.close(1008, "Session id is required.");
      return;
    }
    viewStreamHub.attachClient(sessionId, ws);
  });

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const tokenParam = url.searchParams.get("token");
    if (tokenParam !== token || !isAllowedOrigin(request.headers.origin)) {
      socket.destroy();
      return;
    }

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "ws" || parts.length !== 3) {
      socket.destroy();
      return;
    }

    if (parts[1] === "view") {
      viewWss.handleUpgrade(request, socket, head, (ws) => {
        viewWss.emit("connection", ws, request);
      });
      return;
    }

    if (parts[1] === "cdp") {
      cdpProxy.handleUpgrade(request, socket, head);
      return;
    }

    socket.destroy();
  });

  let closePromise: Promise<void> | undefined;
  async function closeServer(): Promise<void> {
    closePromise ??= (async () => {
      viewWss.clients.forEach((client) => {
        try {
          client.close();
        } catch {}
      });
      viewWss.close();
      cdpProxy.close();
      httpServer.close();
      await once(httpServer, "close");
      await clearLocalViewServiceState({ pid: process.pid, token });
      await input.onClosed?.();
    })();
    await closePromise;
  }

  httpServer.listen(input.port ?? 0, "127.0.0.1");
  await once(httpServer, "listening");
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve the local view server address.");
  }

  const url = `http://127.0.0.1:${String(address.port)}`;
  await writeLocalViewServiceState({
    layout: OPENSTEER_LOCAL_VIEW_SERVICE_LAYOUT,
    version: OPENSTEER_LOCAL_VIEW_SERVICE_VERSION,
    pid: process.pid,
    processStartedAtMs: CURRENT_PROCESS_OWNER.processStartedAtMs,
    startedAt: Date.now(),
    port: address.port,
    token,
    url,
  });

  return {
    url,
    token,
    close: closeServer,
  };
}

async function handleHttpRequest(args: {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly token: string;
  readonly shutdown: () => Promise<void>;
}): Promise<void> {
  const url = new URL(args.request.url ?? "/", "http://localhost");

  if (url.pathname === "/api/health") {
    if (!isAuthorizedApiRequest(args.request, args.token)) {
      writeJson(args.response, 401, { error: "Unauthorized." });
      return;
    }
    writeJson(args.response, 200, { ok: true });
    return;
  }

  if (url.pathname === "/api/sessions") {
    if (!isAuthorizedApiRequest(args.request, args.token)) {
      writeJson(args.response, 401, { error: "Unauthorized." });
      return;
    }
    const sessions = await listResolvedLocalViewSessions();
    const payload: OpensteerLocalViewSessionsResponse = { sessions };
    writeJson(args.response, 200, payload);
    return;
  }

  if (url.pathname === "/api/service/stop") {
    if (!isAuthorizedApiRequest(args.request, args.token)) {
      writeJson(args.response, 401, { error: "Unauthorized." });
      return;
    }
    if (args.request.method !== "POST") {
      writeJson(args.response, 405, { error: "Method not allowed." });
      return;
    }

    args.response.once("finish", () => {
      void args.shutdown();
    });
    writeJson(args.response, 200, { stopped: true });
    return;
  }

  const accessMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/access$/u);
  if (accessMatch) {
    if (!isAuthorizedApiRequest(args.request, args.token)) {
      writeJson(args.response, 401, { error: "Unauthorized." });
      return;
    }
    const sessionId = decodeURIComponent(accessMatch[1]!);
    if (!(await resolveLocalViewSession(sessionId))) {
      writeJson(args.response, 404, { error: "Session not found." });
      return;
    }
    const payload: OpensteerSessionAccessGrantResponse = {
      sessionId,
      expiresAt: LOCAL_VIEW_ACCESS_EXPIRES_AT,
      grants: {
        view: {
          kind: "view",
          transport: "ws",
          url: `${resolveWsBaseUrl(args.request)}/ws/view/${encodeURIComponent(sessionId)}`,
          token: args.token,
          expiresAt: LOCAL_VIEW_ACCESS_EXPIRES_AT,
        },
        cdp: {
          kind: "cdp",
          transport: "ws",
          url: `${resolveWsBaseUrl(args.request)}/ws/cdp/${encodeURIComponent(sessionId)}`,
          token: args.token,
          expiresAt: LOCAL_VIEW_ACCESS_EXPIRES_AT,
        },
      },
    };
    writeJson(args.response, 200, payload);
    return;
  }

  const closeMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/close$/u);
  if (closeMatch) {
    if (!isAuthorizedApiRequest(args.request, args.token)) {
      writeJson(args.response, 401, { error: "Unauthorized." });
      return;
    }
    if (args.request.method !== "POST") {
      writeJson(args.response, 405, { error: "Method not allowed." });
      return;
    }

    const sessionId = decodeURIComponent(closeMatch[1]!);
    const { closeLocalViewSessionBrowser, LocalViewSessionCloseError } =
      await import("./session-control.js");
    try {
      await closeLocalViewSessionBrowser(sessionId);
    } catch (error) {
      if (error instanceof LocalViewSessionCloseError) {
        writeJson(args.response, error.statusCode, { error: error.message });
        return;
      }
      throw error;
    }

    const payload: OpensteerLocalViewSessionCloseResponse = {
      sessionId,
      closed: true,
    };
    writeJson(args.response, 200, payload);
    return;
  }

  if (url.pathname === "/favicon.ico") {
    args.response.statusCode = 204;
    args.response.end();
    return;
  }

  if (
    url.pathname === "/" ||
    url.pathname.startsWith("/assets/") ||
    url.pathname.startsWith("/images/")
  ) {
    await serveStaticAsset(args.response, url.pathname, args.token);
    return;
  }

  args.response.statusCode = 404;
  args.response.end("not found");
}

async function serveStaticAsset(
  response: ServerResponse,
  pathname: string,
  token: string,
): Promise<void> {
  const publicDir = resolveLocalViewPublicDir();
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const assetPath = path.resolve(publicDir, relativePath);
  const relativeAssetPath = path.relative(publicDir, assetPath);
  if (
    relativeAssetPath.startsWith("..") ||
    path.isAbsolute(relativeAssetPath) ||
    !existsSync(assetPath)
  ) {
    response.statusCode = 404;
    response.end("not found");
    return;
  }

  if (relativePath === "index.html") {
    const html = await readFile(assetPath, "utf8");
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.end(
      html.replace(
        "__OPENSTEER_LOCAL_BOOTSTRAP_JSON__",
        JSON.stringify({
          apiBasePath: "/api",
          token,
        }),
      ),
    );
    return;
  }

  response.setHeader("content-type", guessContentType(assetPath));
  response.setHeader("cache-control", "no-store");
  response.end(await readFile(assetPath));
}

function resolveLocalViewPublicDir(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, "local-view", "public"),
    path.resolve(moduleDir, "public"),
    path.resolve(moduleDir, "..", "local-view", "public"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Could not resolve local view public assets from ${moduleDir}.`);
}

function isAuthorizedApiRequest(request: IncomingMessage, token: string): boolean {
  return (
    request.headers["x-opensteer-local-token"] === token && isAllowedOrigin(request.headers.origin)
  );
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) {
    return true;
  }
  try {
    const url = new URL(origin);
    const host = url.hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

function resolveWsBaseUrl(request: IncomingMessage): string {
  const host = request.headers.host ?? "127.0.0.1";
  return `ws://${host}`;
}

function writeJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function guessContentType(assetPath: string): string {
  if (assetPath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (assetPath.endsWith(".js")) {
    return "application/javascript; charset=utf-8";
  }
  if (assetPath.endsWith(".svg")) {
    return "image/svg+xml";
  }
  if (assetPath.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  if (assetPath.endsWith(".png")) {
    return "image/png";
  }
  if (assetPath.endsWith(".ico")) {
    return "image/x-icon";
  }
  return "application/octet-stream";
}
