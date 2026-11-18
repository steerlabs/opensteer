import type { DeploymentId } from "@opensteer/core";
import { HostTransportError } from "@opensteer/client/connections";
import {
  DesktopHostTransportErrorCodeSchema,
  desktopHostRequestIdHeader,
  desktopHostRouteUrl,
  desktopHostTransportErrorHeader,
  desktopHostUploadConcurrency,
  isDesktopHostUploadPath,
  type DesktopCloseHostWebSocketInput,
  type DesktopHostWebSocketEvent,
  type OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";
import type { WebSocketClient } from "@opensteer/client/host";

const socketRegistries = new WeakMap<OpensteerDesktopBridge, DesktopHostSocketRegistry>();

/**
 * Host HTTP for the bundled UI: the same request, sent to desktop main's Host
 * route for this Deployment, which answers with the Host's own response.
 */
export function createDesktopHostFetch(
  bridge: Pick<OpensteerDesktopBridge, "cancelHostRequest">,
  canonicalOrigin: string,
  deploymentId: DeploymentId,
  fetch: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init),
): typeof globalThis.fetch {
  const origin = new URL(canonicalOrigin).origin;
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== origin) {
      throw new Error("The bundled UI cannot contact a Host other than the selected Deployment.");
    }
    const { signal } = request;
    const release = isDesktopHostUploadPath(url.pathname) ? await uploadSlot(signal) : null;
    const requestId = crypto.randomUUID();
    // Main never sees this signal; until headers arrive, it learns of an abort only here.
    let cancelled: Promise<void> | null = null;
    const cancel = () => {
      cancelled = bridge.cancelHostRequest({ requestId }).catch(() => undefined);
    };
    try {
      // A Blob is handed on by reference rather than read into this renderer again.
      const body = request.body ? await request.blob() : null;
      signal.throwIfAborted();
      const headers = new Headers(request.headers);
      headers.set(desktopHostRequestIdHeader, requestId);
      signal.addEventListener("abort", cancel, { once: true });
      const response = await fetch(desktopHostRouteUrl(deploymentId, url), {
        ...(body ? { body } : {}),
        headers,
        method: request.method,
        signal,
      });
      const failure = DesktopHostTransportErrorCodeSchema.safeParse(
        response.headers.get(desktopHostTransportErrorHeader),
      );
      if (failure.success) throw new HostTransportError(failure.data);
      return response;
    } finally {
      signal.removeEventListener("abort", cancel);
      // A cancelled upload's slot is free in main once main has heard the cancel.
      if (release) void (cancelled ?? Promise.resolve()).then(release);
    }
  };
}

const uploads = { active: 0, waiting: [] as (() => void)[] };

/**
 * One of the few uploads main admits at once, waited for here, where a queued
 * Blob is only a reference. A released slot passes straight to the next waiter.
 */
async function uploadSlot(signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted();
  if (uploads.active < desktopHostUploadConcurrency) uploads.active += 1;
  else
    await new Promise<void>((resolve, reject) => {
      const ready = () => {
        signal.removeEventListener("abort", abandon);
        resolve();
      };
      const abandon = () => {
        const index = uploads.waiting.indexOf(ready);
        if (index !== -1) uploads.waiting.splice(index, 1);
        reject(signal.reason);
      };
      uploads.waiting.push(ready);
      signal.addEventListener("abort", abandon, { once: true });
    });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = uploads.waiting.shift();
    if (next) next();
    else uploads.active -= 1;
  };
}

export function createDesktopHostWebSocketFactory(
  bridge: OpensteerDesktopBridge,
  canonicalOrigin: string,
  expectedDeploymentId: DeploymentId,
): (url: string) => WebSocketClient {
  const registry = desktopHostSocketRegistry(bridge);
  const origin = new URL(canonicalOrigin).origin;
  return (value) => {
    const url = new URL(value);
    const httpEquivalent = new URL(url);
    httpEquivalent.protocol = url.protocol === "wss:" ? "https:" : "http:";
    if ((url.protocol !== "ws:" && url.protocol !== "wss:") || httpEquivalent.origin !== origin) {
      throw new Error("The bundled UI cannot open a socket to another Deployment.");
    }
    return registry.create(`${url.pathname}${url.search}`, expectedDeploymentId);
  };
}

function desktopHostSocketRegistry(bridge: OpensteerDesktopBridge): DesktopHostSocketRegistry {
  const existing = socketRegistries.get(bridge);
  if (existing) return existing;
  const created = new DesktopHostSocketRegistry(bridge);
  socketRegistries.set(bridge, created);
  return created;
}

class DesktopHostSocketRegistry {
  readonly #bridge: OpensteerDesktopBridge;
  readonly #pending = new Map<string, DesktopHostWebSocketEvent[]>();
  readonly #sockets = new Map<string, DesktopHostWebSocket>();
  #opening = 0;

  constructor(bridge: OpensteerDesktopBridge) {
    this.#bridge = bridge;
    bridge.onHostWebSocketEvent((event) => {
      const socket = this.#sockets.get(event.connectionId);
      if (socket) {
        if (event.type === "close") this.#sockets.delete(event.connectionId);
        socket.receive(event);
        return;
      }
      if (this.#opening === 0) return;
      const pending = this.#pending.get(event.connectionId) ?? [];
      if (pending.at(-1)?.type === "close") return;
      if (event.type === "close" && pending.length === 64) pending.shift();
      if (pending.length < 64) pending.push(event);
      this.#pending.set(event.connectionId, pending);
    });
  }

  create(path: string, expectedDeploymentId: DeploymentId): DesktopHostWebSocket {
    const socket = new DesktopHostWebSocket(this.#bridge, (connectionId) => {
      if (this.#sockets.get(connectionId) === socket) this.#sockets.delete(connectionId);
    });
    this.#opening += 1;
    void this.#bridge
      .openHostWebSocket({ path, expectedDeploymentId })
      .then(({ connectionId }) => {
        this.#sockets.set(connectionId, socket);
        const pending = this.#pending.get(connectionId) ?? [];
        this.#pending.delete(connectionId);
        socket.bind(connectionId);
        for (const event of pending) {
          if (event.type === "close") this.#sockets.delete(connectionId);
          socket.receive(event);
        }
      })
      .catch((error: unknown) => socket.fail(error))
      .finally(() => {
        this.#opening -= 1;
        if (this.#opening === 0) this.#pending.clear();
      });
    return socket;
  }
}

class DesktopHostWebSocket implements WebSocketClient {
  binaryType: BinaryType = "blob";
  readonly #bridge: OpensteerDesktopBridge;
  readonly #closeRejected: (connectionId: string) => void;
  readonly #listeners = new Map<string, Set<(event: Event) => void>>();
  #connectionId: string | null = null;
  #closeBeforeBinding: { readonly code?: number; readonly reason?: string } | null = null;
  #readyState = 0;

  constructor(bridge: OpensteerDesktopBridge, closeRejected: (connectionId: string) => void) {
    this.#bridge = bridge;
    this.#closeRejected = closeRejected;
  }

  get readyState(): number {
    return this.#readyState;
  }

  addEventListener<Type extends "close" | "error" | "message" | "open">(
    type: Type,
    listener: (event: SocketEventMap[Type]) => void,
  ): void {
    const listeners = this.#listeners.get(type) ?? new Set<(event: Event) => void>();
    listeners.add(listener as (event: Event) => void);
    this.#listeners.set(type, listeners);
  }

  close(code?: number, reason?: string): void {
    if (this.#readyState >= 2) return;
    this.#readyState = 2;
    if (!this.#connectionId) {
      this.#closeBeforeBinding = {
        ...(code === undefined ? {} : { code }),
        ...(reason === undefined ? {} : { reason }),
      };
      return;
    }
    this.#requestClose({
      ...(code === undefined ? {} : { code }),
      connectionId: this.#connectionId,
      ...(reason === undefined ? {} : { reason }),
    });
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.#readyState !== 1 || !this.#connectionId) {
      throw new Error("The Desktop Host WebSocket is not open.");
    }
    if (typeof data === "string") {
      void this.#bridge
        .sendHostWebSocket({
          connectionId: this.#connectionId,
          data,
          type: "text",
        })
        .catch((error: unknown) => this.fail(error));
      return;
    }
    if (data instanceof Blob) {
      void data
        .arrayBuffer()
        .then((buffer) => this.#sendBinary(new Uint8Array(buffer)))
        .catch((error: unknown) => this.fail(error));
      return;
    }
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    this.#sendBinary(bytes);
  }

  bind(connectionId: string): void {
    this.#connectionId = connectionId;
    if (this.#closeBeforeBinding) {
      const pending = this.#closeBeforeBinding;
      this.#closeBeforeBinding = null;
      this.#requestClose({ connectionId, ...pending });
    }
  }

  receive(event: DesktopHostWebSocketEvent): void {
    if (this.#readyState === 3) return;
    if (event.type === "open") {
      if (this.#readyState !== 0) return;
      this.#readyState = 1;
      this.#dispatch("open", new Event("open"));
      return;
    }
    if (event.type === "text") {
      this.#dispatch("message", new MessageEvent("message", { data: event.data }));
      return;
    }
    if (event.type === "binary") {
      // IPC already gave this renderer its own copy: its buffer is handed on
      // as it is, unless the frame is a view into a larger buffer.
      const bytes = event.data;
      const own =
        bytes.buffer instanceof ArrayBuffer &&
        bytes.byteOffset === 0 &&
        bytes.byteLength === bytes.buffer.byteLength
          ? bytes.buffer
          : bytes.slice().buffer;
      const data = this.binaryType === "arraybuffer" ? own : new Blob([own]);
      this.#dispatch("message", new MessageEvent("message", { data }));
      return;
    }
    if (event.type === "error") {
      this.#dispatch("error", new Event("error"));
      return;
    }
    this.#readyState = 3;
    this.#dispatch(
      "close",
      new CloseEvent("close", {
        code: event.code,
        reason: event.reason,
        wasClean: event.code === 1_000,
      }),
    );
  }

  fail(_error: unknown): void {
    if (this.#readyState === 3) return;
    const closing = this.#readyState === 2;
    this.#readyState = 3;
    if (this.#connectionId && !closing) {
      this.#requestClose({
        code: 4_002,
        connectionId: this.#connectionId,
        reason: "Desktop bridge failed",
      });
    }
    this.#dispatch("error", new Event("error"));
    this.#dispatch("close", new CloseEvent("close", { code: 1_006, wasClean: false }));
  }

  #requestClose(input: DesktopCloseHostWebSocketInput): void {
    void this.#bridge.closeHostWebSocket(input).catch((error: unknown) => {
      this.#closeRejected(input.connectionId);
      this.fail(error);
    });
  }

  #dispatch(type: string, event: Event): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }

  #sendBinary(data: Uint8Array): void {
    if (!this.#connectionId || this.#readyState !== 1) return;
    const copied = new Uint8Array(data.byteLength);
    copied.set(data);
    void this.#bridge
      .sendHostWebSocket({
        connectionId: this.#connectionId,
        data: copied,
        type: "binary",
      })
      .catch((error: unknown) => this.fail(error));
  }
}

interface SocketEventMap {
  readonly close: CloseEvent;
  readonly error: Event;
  readonly message: MessageEvent<unknown>;
  readonly open: Event;
}
