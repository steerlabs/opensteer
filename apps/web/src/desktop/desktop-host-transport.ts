import { bootstrapDiagnosticHeader } from "@opensteer/shared/bootstrapDiagnostics";
import { HostTransportError } from "@opensteer/client/connections";
import { hostApiVersionHeader } from "@opensteer/protocol";
import type {
  DesktopCloseHostWebSocketInput,
  DesktopHostWebSocketEvent,
  DesktopHostResult,
  OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";
import type { WebSocketClient } from "@opensteer/client/host";

const socketRegistries = new WeakMap<OpensteerDesktopBridge, DesktopHostSocketRegistry>();

export function createDesktopHostFetch(
  bridge: OpensteerDesktopBridge,
  canonicalOrigin: string,
): typeof globalThis.fetch {
  const origin = new URL(canonicalOrigin).origin;
  return async (input, init) => {
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    const url = new URL(request.url);
    if (url.origin !== origin) {
      throw new Error("The bundled UI cannot contact a Host other than the selected Deployment.");
    }
    const headers = hostRequestHeaders(request.headers);
    if (
      url.pathname === "/v1/rpc/attachment.upload" ||
      url.pathname === "/v1/rpc/attachment.content" ||
      url.pathname === "/v1/rpc/workspace.files.preview"
    ) {
      return binaryHostRequest(bridge, request, url, headers);
    }
    const body = request.method === "GET" ? undefined : await request.text();
    const result = await hostBridgeResult(
      bridge.hostRequest({
        ...(body ? { body } : {}),
        headers: {
          ...headers,
          contentType: headers.contentType === "application/json" ? "application/json" : undefined,
        },
        method: hostMethod(request.method),
        path: `${url.pathname}${url.search}`,
      }),
      request.signal,
    );
    return new Response(result.status === 204 ? null : result.body, {
      headers: result.headers.contentType ? { "content-type": result.headers.contentType } : {},
      status: result.status,
    });
  };
}

async function binaryHostRequest(
  bridge: OpensteerDesktopBridge,
  request: Request,
  url: URL,
  headers: ReturnType<typeof hostRequestHeaders>,
): Promise<Response> {
  const upload = url.pathname === "/v1/rpc/attachment.upload";
  const preview = url.pathname === "/v1/rpc/workspace.files.preview";
  if (upload && request.method !== "POST") throw new Error("Attachment upload requires POST.");
  if (preview && request.method !== "POST") throw new Error("File preview requires POST.");
  if (!upload && !preview && request.method !== "GET")
    throw new Error("Attachment content requires GET.");
  const body = preview ? await request.text() : undefined;
  const opened = await bridge.hostBinaryOpen({
    ...(body === undefined ? {} : { body }),
    headers: {
      ...(headers.accept ? { accept: headers.accept } : {}),
      ...(headers.apiVersion ? { apiVersion: headers.apiVersion } : {}),
      ...(upload ? { contentType: "application/octet-stream" as const } : {}),
      ...(preview ? { contentType: "application/json" as const } : {}),
    },
    method: upload || preview ? "POST" : "GET",
    path: `${url.pathname}${url.search}`,
    timeoutMs: 120_000,
  });
  const { transferId } = unwrapHostResult(opened);
  const transfer = { transferId };
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    request.signal.removeEventListener("abort", abort);
    await bridge.hostBinaryClose(transfer).catch(() => undefined);
  };
  const abort = (): void => {
    void close();
  };
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    request.signal.throwIfAborted();
    if (upload) {
      if (!request.body) throw new Error("Attachment upload has no body.");
      for await (const part of request.body) {
        if (request.signal.aborted) throw request.signal.reason;
        for (let offset = 0; offset < part.byteLength; offset += 256 * 1_024) {
          await hostBridgeResult(
            bridge.hostBinaryWrite({
              bytes: part.subarray(offset, offset + 256 * 1_024),
              transferId,
            }),
            request.signal,
          );
        }
      }
      const result = await hostBridgeResult(bridge.hostBinaryFinish(transfer), request.signal);
      closed = true;
      return new Response(result.status === 204 ? null : result.body, {
        headers: result.headers.contentType ? { "content-type": result.headers.contentType } : {},
        status: result.status,
      });
    }
    const first = await hostBridgeResult(bridge.hostBinaryRead(transfer), request.signal);
    let next: typeof first | null = first;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (request.signal.aborted) throw request.signal.reason;
          const current =
            next ?? (await hostBridgeResult(bridge.hostBinaryRead(transfer), request.signal));
          next = null;
          if (current.bytes.byteLength > 0) controller.enqueue(current.bytes);
          if (current.done) {
            controller.close();
            await close();
          }
        } catch (error) {
          controller.error(request.signal.aborted ? request.signal.reason : error);
          await close();
        }
      },
      async cancel() {
        await close();
      },
    });
    return new Response(stream, {
      headers: {
        ...(first.contentType ? { "content-type": first.contentType } : {}),
        ...(first.etag ? { etag: first.etag } : {}),
        ...(first.lastModified ? { "last-modified": first.lastModified } : {}),
        ...(first.fileSizeBytes !== null
          ? { "x-opensteer-file-size": String(first.fileSizeBytes) }
          : {}),
        ...(first.fileTruncated !== null
          ? { "x-opensteer-file-truncated": String(first.fileTruncated) }
          : {}),
      },
      status: first.status,
    });
  } catch (error) {
    await close();
    if (request.signal.aborted) throw request.signal.reason;
    throw error;
  } finally {
    if (upload) request.signal.removeEventListener("abort", abort);
  }
}

function unwrapHostResult<Data>(result: DesktopHostResult<Data>): Data {
  if (!result.ok) throw new HostTransportError(result.error.code);
  return result.data;
}

async function hostBridgeResult<Data>(
  pending: Promise<DesktopHostResult<Data>>,
  signal: AbortSignal,
): Promise<Data> {
  let abort: (() => void) | undefined;
  try {
    const abandoned = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
    const result = await Promise.race([pending, abandoned]);
    signal.throwIfAborted();
    return unwrapHostResult(result);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

export function createDesktopHostWebSocketFactory(
  bridge: OpensteerDesktopBridge,
  canonicalOrigin: string,
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
    return registry.create(`${url.pathname}${url.search}`);
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

  create(path: string): DesktopHostWebSocket {
    const socket = new DesktopHostWebSocket(this.#bridge, (connectionId) => {
      if (this.#sockets.get(connectionId) === socket) this.#sockets.delete(connectionId);
    });
    this.#opening += 1;
    void this.#bridge
      .openHostWebSocket({ path })
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

function hostMethod(value: string): "DELETE" | "GET" | "PATCH" | "POST" | "PUT" {
  if (
    value === "DELETE" ||
    value === "GET" ||
    value === "PATCH" ||
    value === "POST" ||
    value === "PUT"
  )
    return value;
  throw new Error("The bundled UI requested an unsupported Host method.");
}

function hostRequestHeaders(headers: Headers): {
  accept?: string;
  apiVersion?: string;
  bootstrapDiagnostics?: string;
  contentType?: "application/json" | "application/octet-stream";
  idempotencyKey?: string;
} {
  const output: {
    accept?: string;
    apiVersion?: string;
    bootstrapDiagnostics?: string;
    contentType?: "application/json" | "application/octet-stream";
    idempotencyKey?: string;
  } = {};
  for (const [name, value] of headers) {
    if (name === "accept") output.accept = value;
    else if (name === bootstrapDiagnosticHeader) output.bootstrapDiagnostics = value;
    else if (name === hostApiVersionHeader) output.apiVersion = value;
    else if (
      name === "content-type" &&
      (value === "application/json" || value === "application/octet-stream")
    )
      output.contentType = value;
    else if (name === "idempotency-key") output.idempotencyKey = value;
    else throw new Error(`The bundled UI cannot set the Host header ${name}.`);
  }
  return output;
}
