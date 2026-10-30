import type { DeploymentId } from "@opensteer/core";
import { readBoundedResponse } from "@opensteer/shared/boundedJson";
import type { DeploymentCatalogStore } from "./deployment-catalog.js";
import type { ResolvedConnection } from "./connection-resolver.js";
import {
  HostAttachmentFence,
  type HostCredentialProvider,
  type LocalHostRuntimeSource,
} from "./host-attachment-fence.js";
import type { HostSessionRecovery, SelectedAttachment } from "../auth/host-session.js";
import {
  HostResponseDeadline,
  hostResponseHeadersTimeoutMs,
  hostResponseStallTimeoutMs,
} from "./host-response-deadline.js";
import { HostTransportError } from "./host-transport-error.js";

const maximumConcurrentRequests = 32;
const maximumOpenSockets = 128;
// A Host's refusal is a short error envelope; anything longer is not one.
const maximumUnauthorizedBodyBytes = 64 * 1_024;
// WHATWG WebSocket clients may send only normal closure or application codes.
// RFC peer close codes such as 1001/1009/1011 are observable inbound values,
// but passing them to WebSocket.close() throws synchronously.
const deploymentChangedCloseCode = 4_001;

/** One Host request, in the terms every platform's network adapter accepts. */
export interface HostTransportRequest {
  readonly body?: string | Blob | undefined;
  readonly headers: {
    readonly accept?: string | undefined;
    readonly apiVersion?: string | undefined;
    readonly contentType?: string | undefined;
    readonly idempotencyKey?: string | undefined;
  };
  readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  /** Resolved against the attachment's origin, and refused if it leaves it. */
  readonly path: string;
  readonly signal?: AbortSignal | undefined;
  /** Time allowed before response headers (for uploads or deliberately waiting operations). */
  readonly timeoutMs?: number | undefined;
}

export interface HostNetworkRequest {
  readonly authorization: string | null;
  readonly canonicalOrigin: string;
  readonly requestOrigin: string;
  readonly deploymentId: DeploymentId;
  readonly request: HostTransportRequest;
  readonly signal: AbortSignal;
  readonly url: string;
}

export interface HostNetworkSocket {
  close(code?: number, reason?: string): void;
  send(data: string | Uint8Array): void;
}

export interface HostNetworkSocketEvents {
  readonly close: (code: number, reason: string) => void;
  readonly error: (message: string) => void;
  readonly message: (data: string | Uint8Array) => void;
  readonly open: () => void;
}

export interface HostNetwork {
  openWebSocket(
    input: Omit<HostNetworkRequest, "request" | "signal">,
    events: HostNetworkSocketEvents,
  ): HostNetworkSocket;
  request(input: HostNetworkRequest): Promise<Response>;
}

/**
 * One transport for one Deployment — the selected one, unless it is pinned to
 * another: it owns the outstanding requests
 * and sockets and opens each of them against the route and the credential the
 * shared attachment fence resolved, refusing anything whose generation moved
 * while it was being set up.
 *
 * The platform supplies the network. Nothing here opens a socket itself, so
 * the same fence protects an Electron `net` request and a phone's `fetch`, and
 * nothing here knows how a particular application delivers the bytes to its own
 * user interface.
 */
export class HostTransport {
  readonly #fence: HostAttachmentFence;
  readonly #network: HostNetwork;
  readonly #sessions: HostSessionRecovery | null;
  readonly #requestControllers = new Set<AbortController>();
  readonly #sockets = new Set<HostNetworkSocket>();
  #activeRequests = 0;

  constructor(options: HostTransportOptions) {
    this.#fence = new HostAttachmentFence({
      catalog: options.catalog,
      ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
      ...(options.deploymentId === undefined ? {} : { deploymentId: options.deploymentId }),
      localRuntime: options.localRuntime,
    });
    this.#network = options.network;
    this.#sessions = options.sessions ?? null;
    this.#fence.onInvalidated((reason) => {
      for (const controller of this.#requestControllers)
        controller.abort(new HostTransportError("deployment-changed", { cause: reason }));
      this.closeAllSockets();
    });
  }

  /** The current attachment key, without touching the catalog file. */
  currentKey(): string | null {
    return this.#fence.currentKey();
  }

  /**
   * The provider callback is registered against the Host's canonical origin,
   * so the consent browser must start there as well. A remote Personal route
   * deliberately does not change its loopback canonical authority and cannot
   * originate provider OAuth on another computer.
   */
  async integrationAuthorizationOrigin(): Promise<string> {
    const { resolved } = await this.current();
    if (resolved.access === "connect" || resolved.access === "private") {
      throw new Error("Connect integrations on the computer that hosts this Personal Opensteer.");
    }
    return resolved.canonicalOrigin;
  }

  subscribe(listener: () => void): () => void {
    return this.#fence.subscribe(listener);
  }

  /**
   * One authenticated exchange against the resolved origin. It is abandoned
   * rather than sent when the attachment moved while the route was being
   * resolved, and aborted where it moves — or the deadline passes — at any
   * point up to and including reading the response, which is why the caller
   * consumes the body here rather than after this returns.
   */
  async exchange<Result>(
    request: HostTransportRequest,
    read: (
      response: Response,
      progress: { readonly signal: AbortSignal; readonly onProgress: () => void },
    ) => Promise<Result>,
  ): Promise<Result> {
    if (this.#activeRequests >= maximumConcurrentRequests) {
      throw new Error("The Host request limit is full.");
    }
    this.#activeRequests += 1;
    try {
      const selected = await this.current();
      const { resolved } = selected;
      const selectionGeneration = this.#fence.generation;
      const deadline = new HostResponseDeadline(request.signal);
      const controller = deadline.controller;
      this.#requestControllers.add(controller);
      if (selectionGeneration !== this.#fence.generation) {
        controller.abort(new HostTransportError("deployment-changed"));
      }
      deadline.reset(request.timeoutMs ?? hostResponseHeadersTimeoutMs);
      try {
        let response = await deadline.wait(this.#send(resolved, request, controller.signal));
        const onProgress = () => deadline.reset(hostResponseStallTimeoutMs);
        onProgress();
        if (response.status === 401 && this.#sessions) {
          response = await this.#retryAfterSessionRecovery(
            this.#sessions,
            selected,
            request,
            controller.signal,
            response,
            deadline,
          );
        }
        return await deadline.wait(read(response, { signal: controller.signal, onProgress }));
      } catch (error) {
        if (request.signal?.aborted) throw request.signal.reason ?? error;
        if (controller.signal.aborted) {
          throw controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new HostTransportError("cancelled", { cause: error });
        }
        throw error;
      } finally {
        // Electron fetch retains a cancelled response's socket until its request
        // is aborted. Classify the failure before this cleanup changes the signal.
        deadline.dispose();
        this.#requestControllers.delete(controller);
      }
    } finally {
      this.#activeRequests -= 1;
    }
  }

  /**
   * One authenticated socket against the resolved origin, closed immediately
   * when the attachment moved while it was being opened.
   *
   * The events are bound to the socket that will carry them, because a network
   * adapter may report a failure before this returns and the caller still has
   * to be able to close the thing that failed.
   */
  async openSocket(
    input: { readonly path: string },
    events: (socket: HostNetworkSocket) => HostNetworkSocketEvents,
  ): Promise<HostNetworkSocket> {
    if (this.#sockets.size >= maximumOpenSockets) {
      throw new Error("The Host WebSocket limit is full.");
    }
    const { resolved } = await this.current();
    const selectionGeneration = this.#fence.generation;
    let network: HostNetworkSocket | null = null;
    let released = false;
    const pending: { close: { readonly code?: number; readonly reason?: string } | null } = {
      close: null,
    };
    const socket: HostNetworkSocket = {
      close: (code, reason) => {
        if (released) return;
        released = true;
        this.#sockets.delete(socket);
        if (network) network.close(code, reason);
        else {
          pending.close = {
            ...(code === undefined ? {} : { code }),
            ...(reason === undefined ? {} : { reason }),
          };
        }
      },
      send: (data) => {
        if (released || network === null) throw new Error("This Host WebSocket is not open.");
        network.send(data);
      },
    };
    const bound = events(socket);
    const target = hostUrl(resolved.origin, input.path);
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    network = this.#network.openWebSocket(
      {
        authorization: resolved.authorization,
        canonicalOrigin: resolved.canonicalOrigin,
        requestOrigin: resolved.origin,
        deploymentId: resolved.deploymentId,
        url: target.toString(),
      },
      {
        close: (code, reason) => {
          released = true;
          this.#sockets.delete(socket);
          bound.close(code, reason);
        },
        error: (message) => bound.error(message),
        message: (data) => bound.message(data),
        open: () => bound.open(),
      },
    );
    if (selectionGeneration !== this.#fence.generation && !released) {
      released = true;
      network.close(deploymentChangedCloseCode, "Deployment changed");
      throw new Error("The selected deployment changed.");
    }
    const pendingClose = pending.close;
    if (pendingClose) network.close(pendingClose.code, pendingClose.reason);
    if (released) return socket;
    this.#sockets.add(socket);
    return socket;
  }

  closeAllSockets(): void {
    // Each close removes its own entry, which a Set iteration tolerates.
    for (const socket of this.#sockets) {
      socket.close(deploymentChangedCloseCode, "Deployment changed");
    }
    this.#sockets.clear();
  }

  async #send(
    resolved: ResolvedConnection,
    request: HostTransportRequest,
    signal: AbortSignal,
  ): Promise<Response> {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await this.#network.request({
        authorization: resolved.authorization,
        canonicalOrigin: resolved.canonicalOrigin,
        requestOrigin: resolved.origin,
        deploymentId: resolved.deploymentId,
        request,
        signal,
        url: hostUrl(resolved.origin, request.path).toString(),
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof HostTransportError) throw error;
      throw new HostTransportError("unreachable", { cause: error });
    }
    if (response.redirected) throw new Error("Host requests must not redirect.");
    return response;
  }

  /**
   * A remote Personal session cookie expires on its own schedule. Exactly one
   * silent grant redemption is attempted per unauthorized response, and only a
   * recovered session replays the request, so the caller never observes the
   * 401 and a refused Account can never drive a retry loop.
   *
   * The refusal is read whole and its connection released before recovery
   * starts: recovery needs a connection of its own, and Electron keeps an
   * unread response's socket, so concurrent refusals would otherwise hold the
   * pool their own recoveries wait for.
   */
  async #retryAfterSessionRecovery(
    sessions: HostSessionRecovery,
    selected: SelectedAttachment,
    request: HostTransportRequest,
    signal: AbortSignal,
    unauthorized: Response,
    deadline: HostResponseDeadline,
  ): Promise<Response> {
    const body = await readBoundedResponse(unauthorized, {
      maximumBytes: maximumUnauthorizedBodyBytes,
      onProgress: () => deadline.reset(hostResponseStallTimeoutMs),
      signal,
      sizeError: () => new HostTransportError("response-too-large"),
    });
    const refusal = new Response(Uint8Array.from(body), {
      headers: unauthorized.headers,
      status: unauthorized.status,
    });
    // Recovery carries its own deadlines (token refresh, session exchange); the
    // refusal's body-stall clock must not cut it short.
    deadline.pause();
    let abortRecovery: (() => void) | undefined;
    try {
      const abandoned = new Promise<never>((_resolve, reject) => {
        abortRecovery = () => reject(signal.reason);
        if (signal.aborted) abortRecovery();
        else signal.addEventListener("abort", abortRecovery, { once: true });
      });
      const outcome = await Promise.race([sessions.recoverUnauthorized(selected), abandoned]);
      signal.throwIfAborted();
      if (outcome !== "recovered") return refusal;
    } finally {
      if (abortRecovery) signal.removeEventListener("abort", abortRecovery);
    }
    deadline.reset(request.timeoutMs ?? hostResponseHeadersTimeoutMs);
    const response = await deadline.wait(this.#send(selected.resolved, request, signal));
    deadline.reset(hostResponseStallTimeoutMs);
    return response;
  }

  /**
   * One resolution and one monotone fence. Every asynchronous path reads the
   * same key, so a rotated route or a restarted Host invalidates in-flight
   * requests, sockets, and the local Runner target exactly once.
   */
  async current(): Promise<SelectedAttachment> {
    return this.#fence.current();
  }

  /**
   * Recomputes the fence. Exposed to the platform surface that also has to
   * publish its own projection of the same catalog read.
   */
  protected async refreshSelection(): Promise<SelectedAttachment | null> {
    return this.#fence.refresh();
  }
}

export interface HostTransportOptions {
  readonly catalog: Pick<DeploymentCatalogStore, "load" | "subscribe">;
  readonly credentials?: HostCredentialProvider;
  /** Pins the transport to one Deployment; absent, it follows the selection. */
  readonly deploymentId?: DeploymentId;
  readonly localRuntime: LocalHostRuntimeSource;
  readonly network: HostNetwork;
  readonly sessions?: HostSessionRecovery;
}

/**
 * The destination a Host path names, refused where it leaves the origin this
 * attachment resolved to: a credential travels to one place only.
 */
function hostUrl(origin: string, path: string): URL {
  const url = new URL(path, origin);
  if (url.origin !== new URL(origin).origin) {
    throw new Error("This request was addressed outside the attached deployment.");
  }
  return url;
}
