import { isRecord } from "@opensteer/shared/isRecord";
import type { IncomingMessage, ServerResponse } from "node:http";

/** The development Web origin is part of the local security boundary. */
export const localWebBindAddress = "127.0.0.1";

export const localHostProxyTarget =
  process.env.OPENSTEER_HOST_URL?.trim() || "http://127.0.0.1:4310";

/**
 * Authenticated Host endpoints used by local browser clients and runtime
 * processes. Keep this inventory explicit: a broad /internal proxy would make
 * newly added supervisor-only routes browser-reachable by accident.
 */
export const localHostProxyRoutes = {
  // The Host declares the development Web origin as its canonical origin, and
  // discovery is the one document a client reads from a canonical origin before
  // it trusts anything else. A desktop or phone adding this Deployment by its
  // address asks here; without the proxy it is answered with the SPA shell.
  "/.well-known/opensteer": { target: localHostProxyTarget },
  "/internal/v1/agent-control": { target: localHostProxyTarget },
  "/internal/v1/browser-cdp": { target: localHostProxyTarget, ws: true },
  "/internal/v1/browser-sources": { target: localHostProxyTarget, ws: true },
  "/internal/v1/computer-use/display": { target: localHostProxyTarget, ws: true },
  "/internal/v1/egress": { target: localHostProxyTarget },
  "/internal/v1/integration-mcp": { target: localHostProxyTarget },
  "/internal/v1/integration-skills": { target: localHostProxyTarget },
  "/internal/v1/mount-grants/exchange": { target: localHostProxyTarget },
  "/internal/v1/mcp": { target: localHostProxyTarget },
  "/internal/v1/runners": { target: localHostProxyTarget, ws: true },
  "/internal/v1/trigger-cdp": { target: localHostProxyTarget, ws: true },
  "/v1": { target: localHostProxyTarget, ws: true },
} as const;

const setupRedirectTimeoutMs = 1_500;

/**
 * A person can reopen the development URL after the supervisor printed or
 * opened its setup link. Keep that ordinary entry point useful without making
 * the supervisor bootstrap document browser-readable: the loopback Web server
 * reads it server-to-server and returns only the same-origin setup redirect.
 *
 * Production and self-hosted Web builds never install this middleware. Their
 * first administrator must prove possession of the operator-issued setup code
 * in the product UI.
 */
export async function redirectUnclaimedLocalHost(
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
  options: {
    readonly fetchImplementation?: typeof fetch;
    readonly publicOrigin?: URL;
  } = {},
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const acceptsHtml = String(request.headers.accept ?? "").includes("text/html");
  if (
    request.method !== "GET" ||
    url.pathname !== "/" ||
    !acceptsHtml ||
    url.searchParams.has("desktop-preview")
  ) {
    next();
    return;
  }

  const publicOrigin = options.publicOrigin ?? new URL("http://localhost:43100");
  try {
    const bootstrapResponse = await (options.fetchImplementation ?? fetch)(
      new URL("/v1/local-bootstrap", localHostProxyTarget),
      {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(setupRedirectTimeoutMs),
      },
    );
    if (!bootstrapResponse.ok) {
      next();
      return;
    }
    const bootstrap: unknown = await bootstrapResponse.json();
    if (!isRecord(bootstrap) || bootstrap.setupUrl === null) {
      next();
      return;
    }
    if (typeof bootstrap.setupUrl !== "string") {
      next();
      return;
    }
    const setupUrl = new URL(bootstrap.setupUrl);
    if (
      setupUrl.origin !== publicOrigin.origin ||
      setupUrl.pathname !== "/setup" ||
      setupUrl.search !== "" ||
      !/^#token=[A-Za-z0-9_-]{16,4096}$/u.test(setupUrl.hash)
    ) {
      next();
      return;
    }
    response.statusCode = 302;
    response.setHeader("cache-control", "no-store");
    response.setHeader("location", setupUrl.href);
    response.end();
  } catch {
    // The app owns Host-unavailable and malformed-response errors. Falling
    // through preserves its normal retry UI instead of turning Vite into a
    // second health/error surface.
    next();
  }
}

/**
 * The local bootstrap document contains credentials intended only for the
 * same-machine supervisor. The browser never reads it, so the Web proxy must
 * not publish it even on a loopback listener.
 */
export function rejectSupervisorOnlyRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
): void {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (pathname !== "/v1/local-bootstrap") {
    next();
    return;
  }
  response.statusCode = 404;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(
    JSON.stringify({
      error: { code: "not_found", message: "Route not found", retryable: false },
    }),
  );
}
