import { hostApi, type HostToClientMessage } from "@opensteer/protocol";
import {
  ScopedClientMessageSchema,
  type ScopedClientMessage,
  type ScopedHostMessage,
} from "@opensteer/protocol/personal-sync";
import type { PersonalResourceKind } from "@opensteer/protocol/resources";
import { scopeKey } from "../host/scoped-personal-stream.js";
import type { WebSocketClient } from "../host/host-session-client.js";
import { MockHostClient } from "./mock-host-client.js";

export class MockPersonalSocket implements WebSocketClient {
  binaryType: "arraybuffer" | "blob" = "arraybuffer";
  readyState = 0;
  readonly sent: string[] = [];
  readonly #events = new Map<string, Set<(event: never) => void>>();
  readonly #send: (data: string) => void;
  constructor(send: (data: string) => void) {
    this.#send = send;
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.emit("open", {});
    });
  }
  addEventListener(type: string, listener: (event: never) => void) {
    const set = this.#events.get(type) ?? new Set();
    set.add(listener);
    this.#events.set(type, set);
  }
  emit(type: string, event: unknown): void {
    for (const listener of this.#events.get(type) ?? []) listener(event as never);
  }
  deliver(frame: HostToClientMessage | ScopedHostMessage): void {
    if (this.readyState === 1) this.emit("message", { data: JSON.stringify(frame) });
  }
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (typeof data !== "string") throw new Error("Expected text.");
    this.sent.push(data);
    this.#send(data);
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", {});
  }
}
type Subscription = Extract<ScopedClientMessage, { type: "client.subscribe" }>;
interface SocketState {
  subscriptions: Map<string, Subscription>;
  interests: readonly PersonalResourceKind[];
  selected?: string;
}

export class MockPersonalHost {
  readonly client: MockHostClient;
  readonly sockets = new Set<MockPersonalSocket>();
  readonly #states = new Map<MockPersonalSocket, SocketState>();
  readonly #release: () => void;
  #through = "0";

  constructor(client = new MockHostClient({ latencyMs: 0 })) {
    this.client = client;
    this.#through = String(client.getSnapshot().revision);
    this.#release = client.subscribe(() => {
      this.#through = String(client.getSnapshot().revision);
      for (const [socket, state] of this.#states)
        for (const { generation, subscriptionId, scope } of state.subscriptions.values())
          socket.deliver({
            type: "host.snapshot-required",
            subscriptionId,
            generation,
            scope,
            throughSequence: this.#through,
            reason: "scope-invalidated",
          });
    });
  }

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const key = url.pathname.slice("/v1/rpc/".length);
    if (!(key in hostApi)) return new Response(null, { status: 404 });
    const name = key as keyof typeof hostApi;
    const raw = url.searchParams.get("input") ?? init?.body;
    const payload = typeof raw === "string" ? JSON.parse(raw) : {};
    const result = await this.client.rpc[name](payload as never);
    return Response.json(result, {
      status: !result.ok && result.error.code === "unauthorized" ? 401 : 200,
    });
  };

  readonly connect = (): MockPersonalSocket => {
    const state: SocketState = { subscriptions: new Map(), interests: [] };
    const socket = new MockPersonalSocket((data) => {
      const frame = ScopedClientMessageSchema.parse(JSON.parse(data));
      queueMicrotask(() => {
        if (this.sockets.has(socket)) this.#receive(socket, state, frame);
      });
    });
    this.sockets.add(socket);
    this.#states.set(socket, state);
    socket.addEventListener("close", () => {
      this.sockets.delete(socket);
      this.#states.delete(socket);
    });
    return socket;
  };

  #receive(socket: MockPersonalSocket, state: SocketState, frame: ScopedClientMessage) {
    switch (frame.type) {
      case "client.attach": {
        if (this.client.getSnapshot().session !== "authenticated") {
          socket.deliver({
            type: "host.error",
            error: { code: "forbidden", message: "Sign in required.", retryable: false },
          });
          return;
        }
        state.interests = frame.interests;
        const selected = frame.selected;
        if (selected) state.selected = selected.scope.threadId;
        this.#receive(socket, state, {
          type: "client.subscribe",
          subscriptionId: "shell",
          generation: frame.generation,
          scope: { kind: "shell" },
          ...(frame.cursor ? { cursor: frame.cursor } : {}),
        });
        if (selected) this.#receive(socket, state, { type: "client.subscribe", ...selected });
        break;
      }
      case "client.subscribe":
        state.subscriptions.set(frame.subscriptionId, frame);
        this.#snapshot(socket, state, frame);
        break;
      case "client.unsubscribe":
        if (state.subscriptions.get(frame.subscriptionId)?.generation === frame.generation)
          state.subscriptions.delete(frame.subscriptionId);
        break;
      case "client.resources.watch": {
        const shell = state.subscriptions.get("shell");
        if (shell?.generation !== frame.generation) return;
        state.interests = frame.interests;
        this.#resources(socket, shell, state, frame.installed);
        break;
      }
      case "client.ping":
        socket.deliver({ type: "host.pong", nonce: frame.nonce });
        break;
    }
  }

  #snapshot(socket: MockPersonalSocket, state: SocketState, subscription: Subscription) {
    const { generation, subscriptionId, scope, cursor, anchorItemId } = subscription;
    const address = { generation, subscriptionId, scope };
    const shell =
      scope.kind === "shell" ? this.client.scopedShell(state.selected, this.#through) : undefined;
    const snapshot =
      scope.kind === "shell"
        ? shell
        : this.client.scopedDetail(
            scope.threadId,
            scope.kind === "node" ? scope.nodeId : undefined,
            anchorItemId,
            this.#through,
          );
    if (!snapshot) {
      if (scope.kind !== "shell" && subscriptionId !== "shell")
        socket.deliver({
          ...address,
          scope,
          subscriptionId,
          type: "host.removed",
          reason: "unavailable",
        });
      return;
    }
    const after = cursor?.afterSequence;
    if (!after || after !== this.#through || cursor?.scopeKey !== scopeKey(scope))
      socket.deliver({
        ...address,
        type: "host.snapshot",
        throughSequence: this.#through,
        snapshot,
      });
    socket.deliver({ ...address, type: "host.synchronized", throughSequence: this.#through });
    if (shell) this.#resources(socket, subscription, state);
  }

  #resources(
    socket: MockPersonalSocket,
    shell: Subscription,
    state: SocketState,
    installed: Partial<Record<PersonalResourceKind, string>> = {},
  ) {
    for (const kind of state.interests) {
      if (installed[kind] === this.#through) continue;
      socket.deliver({
        type: "host.resource",
        subscriptionId: "shell",
        generation: shell.generation,
        kind,
        revision: this.#through,
        view: { complete: true, hasMore: false, entries: [] },
      });
    }
  }

  invalidateShell() {
    for (const [socket, state] of this.#states) {
      const shell = state.subscriptions.get("shell");
      if (shell)
        socket.deliver({
          type: "host.snapshot-required",
          scope: shell.scope,
          generation: shell.generation,
          subscriptionId: "shell",
          throughSequence: this.#through,
          reason: "scope-invalidated",
        });
    }
  }

  publish(through: string) {
    if (BigInt(through) <= BigInt(this.#through)) return;
    const fromSequence = this.#through;
    this.#through = through;
    for (const [socket, state] of this.#states)
      for (const { generation, subscriptionId, scope } of state.subscriptions.values())
        socket.deliver({
          type: "host.changes",
          subscriptionId,
          generation,
          scope,
          fromSequence,
          throughSequence: through,
          changes: [],
        });
  }

  dispose() {
    this.#release();
    for (const socket of this.sockets) socket.close();
    this.client.dispose();
  }
}
