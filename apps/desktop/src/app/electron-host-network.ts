import { bootstrapDiagnosticHeader } from "@opensteer/shared/bootstrapDiagnostics";
import { net, session, type Session } from "electron";
import { hostApiVersionHeader } from "@opensteer/protocol";
import type {
  HostNetwork,
  HostNetworkRequest,
  HostNetworkSocket,
  HostNetworkSocketEvents,
} from "@opensteer/client/connections";

/** Main-process network adapter. Every Deployment receives a separate Chromium
 * session, so HttpOnly cookies and connection state can never cross Hosts. */
export class ElectronHostNetwork implements HostNetwork {
  readonly #sessions = new Map<string, Session>();

  request(input: HostNetworkRequest): Promise<Response> {
    const headers = requestHeaders(input);
    return this.#session(input.deploymentId).fetch(input.url, {
      ...(input.request.body === undefined ? {} : { body: input.request.body }),
      cache: "no-store",
      credentials: "include",
      headers,
      method: input.request.method,
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: input.signal,
    });
  }

  /** Same partition used by normal Host traffic, so an HttpOnly session cookie
   * established here is the credential every later Host request carries. */
  partitionFetch(
    deploymentId: string,
    input: URL | RequestInfo,
    init: RequestInit,
  ): Promise<Response> {
    return this.#session(deploymentId).fetch(input instanceof URL ? input.toString() : input, {
      ...init,
      cache: "no-store",
      credentials: init.credentials ?? "include",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
  }

  openWebSocket(
    input: Omit<HostNetworkRequest, "request" | "signal">,
    events: HostNetworkSocketEvents,
  ): HostNetworkSocket {
    const socket = new net.WebSocket(input.url, {
      headers: input.authorization ? { authorization: input.authorization } : {},
      origin: input.requestOrigin,
      session: this.#session(input.deploymentId),
      useSessionCookies: true,
    });
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => events.open());
    socket.addEventListener("message", (event) => {
      const data = (event as MessageEvent<unknown>).data;
      if (typeof data === "string") events.message(data);
      else if (data instanceof ArrayBuffer) events.message(new Uint8Array(data));
      else events.error("The Host sent an unsupported WebSocket frame.");
    });
    socket.addEventListener("error", () => events.error("The Host WebSocket failed."));
    socket.addEventListener("close", (event) => {
      const close = event as CloseEvent;
      events.close(close.code, close.reason);
    });
    return {
      close: (code, reason) => socket.close(code, reason),
      send: (data) => socket.send(data),
    };
  }

  /** Remove every cookie/cache/auth artifact scoped to one Deployment after logout. */
  async clearDeploymentSession(deploymentId: string): Promise<void> {
    const deploymentSession = this.#session(deploymentId);
    await deploymentSession.closeAllConnections();
    await Promise.all([
      deploymentSession.clearAuthCache(),
      deploymentSession.clearCache(),
      deploymentSession.clearStorageData(),
    ]);
    this.#sessions.delete(deploymentId);
  }

  #session(deploymentId: string): Session {
    const existing = this.#sessions.get(deploymentId);
    if (existing) return existing;
    const created = session.fromPartition(`persist:opensteer-host-${deploymentId}`, {
      cache: true,
    });
    created.setPermissionCheckHandler(() => false);
    created.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    for (const preload of created.getPreloadScripts()) created.unregisterPreloadScript(preload.id);
    created.on("will-download", (event) => event.preventDefault());
    this.#sessions.set(deploymentId, created);
    return created;
  }
}

function requestHeaders(input: HostNetworkRequest): Record<string, string> {
  const headers: Record<string, string> = {
    accept: input.request.headers.accept ?? "application/json",
    origin: input.requestOrigin,
  };
  if (input.authorization) headers.authorization = input.authorization;
  if (input.request.headers.contentType) {
    headers["content-type"] = input.request.headers.contentType;
  }
  if (input.request.headers.idempotencyKey) {
    headers["idempotency-key"] = input.request.headers.idempotencyKey;
  }
  // The calling client negotiates with the Host: relay its stated epoch.
  // Renderer clients and Desktop main each state the version they understand.
  if (input.request.headers.apiVersion) {
    headers[hostApiVersionHeader] = input.request.headers.apiVersion;
  }
  if (input.request.headers.bootstrapDiagnostics) {
    headers[bootstrapDiagnosticHeader] = input.request.headers.bootstrapDiagnostics;
  }
  return headers;
}
