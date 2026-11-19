import { hostApi, type HostToClientMessage } from "@opensteer/protocol";
import {
  ScopedClientMessageSchema,
  ScopedHostMessageSchema,
  type PersonalChangeSchema,
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
type Snapshot = Extract<ScopedHostMessage, { type: "host.snapshot" }>["snapshot"];
type Change = import("zod").infer<typeof PersonalChangeSchema>;
type Revisioned = { readonly revision: string };
interface SocketState {
  subscriptions: Map<string, Subscription>;
  cuts: Map<string, Snapshot>;
  live: Map<string, Omit<Extract<ScopedHostMessage, { type: "host.live" }>, "handle">[]>;
  /** The last live handle this socket named; the mock names every frame afresh. */
  handles: number;
  interests: readonly PersonalResourceKind[];
  /** An attach or watch is owed its one `reply: true` frame, sent even when nothing moved. */
  replyOwed?: boolean;
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
      const revision = String(client.getSnapshot().revision);
      if (BigInt(revision) <= BigInt(this.#through)) return;
      const fromSequence = this.#through;
      this.#through = revision;
      for (const [socket, state] of this.#states) {
        for (const held of state.subscriptions.values()) {
          const { subscriptionId, scope, generation } = held;
          const previous = state.cuts.get(subscriptionId);
          const snapshot = this.#readSnapshot(state, held);
          const changes = previous && snapshot ? diffCuts(previous, snapshot, revision) : undefined;
          const frame =
            changes &&
            ScopedHostMessageSchema.safeParse({
              type: "host.changes",
              scope,
              subscriptionId,
              generation,
              fromSequence,
              throughSequence: revision,
              changes,
              ...(snapshot && "tasks" in snapshot
                ? { shellProgress: { counts: snapshot.counts } }
                : {}),
            });
          if (frame && frame.success && snapshot) {
            state.cuts.set(subscriptionId, snapshot);
            socket.deliver(frame.data);
            if (scope.kind === "shell") this.#resources(socket, held, state);
            else this.#live(socket, state, held);
          } else if (snapshot) {
            // The Host repairs a scope it cannot describe as changes with an inline snapshot.
            state.cuts.set(subscriptionId, snapshot);
            socket.deliver({
              type: "host.snapshot",
              subscriptionId,
              generation,
              scope,
              throughSequence: revision,
              snapshot,
            });
            if (scope.kind !== "shell") this.#live(socket, state, held, true);
          } else if (scope.kind !== "shell" && subscriptionId !== "shell") {
            socket.deliver({
              type: "host.removed",
              subscriptionId,
              generation,
              scope,
              reason: "unavailable",
            });
          }
        }
      }
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
    const state: SocketState = {
      subscriptions: new Map(),
      cuts: new Map(),
      live: new Map(),
      handles: 0,
      interests: [],
    };
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
        const viewer = this.client.getSnapshot();
        if (viewer.session !== "authenticated") {
          socket.deliver({
            type: "host.error",
            error: { code: "forbidden", message: "Sign in required.", retryable: false },
          });
          return;
        }
        state.interests = frame.interests;
        state.replyOwed = true;
        const sameLogin =
          frame.expectedSessionId === undefined || frame.expectedSessionId === viewer.sessionId;
        const selected = frame.selected;
        if (selected) state.selected = selected.scope.threadId;
        this.#receive(socket, state, {
          type: "client.subscribe",
          subscriptionId: "shell",
          generation: frame.generation,
          scope: { kind: "shell" },
          ...(sameLogin && frame.cursor ? { cursor: frame.cursor } : {}),
        });
        if (selected)
          this.#receive(socket, state, {
            type: "client.subscribe",
            ...selected,
            ...(!sameLogin ? { cursor: undefined } : {}),
          });
        break;
      }
      case "client.subscribe":
        state.subscriptions.set(frame.subscriptionId, frame);
        this.#snapshot(socket, state, frame);
        break;
      case "client.unsubscribe":
        if (state.subscriptions.get(frame.subscriptionId)?.generation === frame.generation) {
          state.subscriptions.delete(frame.subscriptionId);
          state.cuts.delete(frame.subscriptionId);
          state.live.delete(frame.subscriptionId);
        }
        break;
      case "client.resources.watch": {
        const shell = state.subscriptions.get("shell");
        if (shell?.generation !== frame.generation) return;
        state.interests = frame.interests;
        state.replyOwed = true;
        this.#resources(socket, shell, state, frame.installed);
        break;
      }
      case "client.ping":
        socket.deliver({ type: "host.pong", nonce: frame.nonce });
        break;
    }
  }

  #snapshot(socket: MockPersonalSocket, state: SocketState, subscription: Subscription) {
    const { generation, subscriptionId, scope, cursor } = subscription;
    const address = { generation, subscriptionId, scope };
    const snapshot = this.#readSnapshot(state, subscription);
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
    state.cuts.set(subscriptionId, snapshot);
    const after = cursor?.afterSequence;
    if (!after || after !== this.#through || cursor?.scopeKey !== scopeKey(scope))
      socket.deliver({
        ...address,
        type: "host.snapshot",
        throughSequence: this.#through,
        snapshot,
      });
    socket.deliver({ ...address, type: "host.synchronized", throughSequence: this.#through });
    if (scope.kind === "shell") this.#resources(socket, subscription, state);
    else this.#live(socket, state, subscription);
  }

  #live(
    socket: MockPersonalSocket,
    state: SocketState,
    subscription: Subscription,
    repair = false,
  ) {
    const { scope, subscriptionId, generation } = subscription;
    if (scope.kind === "shell" || subscriptionId === "shell") return;
    const latest = this.client.scopedLive(scope, subscriptionId, generation, this.#through);
    // After an inline repair, as the Host does: name the streams still open, which drops every
    // other, then name each again. Otherwise a stream that ended is closed on its own.
    if (repair)
      socket.deliver({
        type: "host.live-reset",
        subscriptionId,
        generation,
        scope,
        open: latest.slice(0, 16).map(({ runId, streamId }) => ({ runId, streamId })),
      });
    else {
      const current = new Set(latest.map(({ streamId }) => streamId));
      for (const frame of state.live.get(subscriptionId) ?? []) {
        if (frame.generation === generation && !current.has(frame.streamId)) {
          const { item: _item, ...address } = frame;
          socket.deliver({
            ...address,
            handle: ++state.handles,
            afterSequence: this.#through,
            update: { operation: "close" },
          });
        }
      }
    }
    state.live.set(subscriptionId, latest);
    for (const frame of latest) socket.deliver({ ...frame, handle: ++state.handles });
  }

  #readSnapshot(state: SocketState, { scope, anchorItemId }: Subscription) {
    return scope.kind === "shell"
      ? this.client.scopedShell(state.selected, this.#through)
      : this.client.scopedDetail(
          scope.threadId,
          scope.kind === "node" ? scope.nodeId : undefined,
          anchorItemId,
          this.#through,
        );
  }

  #resources(
    socket: MockPersonalSocket,
    shell: Subscription,
    state: SocketState,
    installed: Partial<Record<PersonalResourceKind, string>> = {},
  ) {
    const revisions = Object.fromEntries(
      state.interests.flatMap((kind) =>
        installed[kind] === this.#through ? [] : [[kind, this.#through]],
      ),
    );
    const reply = state.replyOwed === true;
    if (!Object.keys(revisions).length && !reply) return;
    state.replyOwed = false;
    socket.deliver({
      type: "host.resource",
      subscriptionId: "shell",
      generation: shell.generation,
      revisions,
      ...(reply ? { reply: true as const } : {}),
    });
  }

  /** Sends every shell subscription the Host's inline repair: a fresh snapshot in place. */
  repairShell() {
    for (const [socket, state] of this.#states) {
      const shell = state.subscriptions.get("shell");
      const snapshot = shell && this.#readSnapshot(state, shell);
      if (!shell || !snapshot) continue;
      state.cuts.set("shell", snapshot);
      socket.deliver({
        type: "host.snapshot",
        scope: shell.scope,
        generation: shell.generation,
        subscriptionId: "shell",
        throughSequence: this.#through,
        snapshot,
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

function diffCuts(previous: Snapshot, next: Snapshot, sequence: string): Change[] | undefined {
  const changes: Change[] = [];
  const address = (entityId: string) => ({ entityId, sequence, ordinal: changes.length });
  const rows = <T extends Revisioned>(
    before: readonly T[],
    after: readonly T[],
    id: (row: T) => string,
    upsert: (row: T) => Change,
    entityKind: Change["entityKind"],
  ) => {
    const known = new Map(before.map((row) => [id(row), row]));
    for (const row of after) {
      const old = known.get(id(row));
      if (!old || !sameRevisioned(old, row)) changes.push(upsert(row));
      known.delete(id(row));
    }
    for (const entityId of known.keys())
      changes.push({ ...address(entityId), entityKind, operation: "remove" });
  };
  if ("tasks" in previous && "tasks" in next) {
    if (previous.nextBefore !== next.nextBefore) return undefined;
    rows(
      previous.tasks,
      next.tasks,
      ({ id }) => id,
      (row) => ({ ...address(row.id), entityKind: "task", operation: "upsert", value: row }),
      "task",
    );
    rows(
      previous.visits,
      next.visits,
      ({ threadId }) => threadId,
      (row) => ({ ...address(row.threadId), entityKind: "visit", operation: "upsert", value: row }),
      "visit",
    );
    rows(
      previous.attention,
      next.attention,
      ({ id }) => id,
      (row) => ({ ...address(row.id), entityKind: "attention", operation: "upsert", value: row }),
      "attention",
    );
    return changes;
  }
  if ("tasks" in previous || "tasks" in next) return undefined;
  if (
    (previous.nextBefore?.beforeId ?? null) !== (next.nextBefore?.beforeId ?? null) ||
    (previous.nextAfter?.beforeId ?? null) !== (next.nextAfter?.beforeId ?? null)
  )
    return undefined;
  const subject = next.nodeSubject;
  if (
    subject?.kind === "node" &&
    !sameRevisioned(previous.nodeSubject ?? { ...subject, revision: "" }, subject)
  )
    changes.push({
      ...address(subject.executionNodeId),
      entityKind: "node",
      operation: "upsert",
      value: subject,
    });
  if (!sameRevisioned(previous.thread, next.thread))
    changes.push({
      ...address(next.thread.id),
      entityKind: "thread",
      operation: "upsert",
      value: next.thread,
    });
  if (next.queue && (!previous.queue || !sameRevisioned(previous.queue, next.queue)))
    changes.push({
      ...address(next.thread.id),
      entityKind: "run-queue",
      operation: "upsert",
      value: next.queue,
    });
  const waiting = (cut: Snapshot) =>
    "items" in cut ? (cut.inputQueue ?? []).map((entry) => ({ ...entry, revision: "" })) : [];
  rows(
    waiting(previous),
    waiting(next),
    ({ message }) => message.id,
    ({ revision: _revision, ...entry }) => ({
      ...address(entry.message.id),
      entityKind: "queue-entry",
      operation: "upsert",
      value: entry,
    }),
    "queue-entry",
  );
  const before = [
    ...new Map([...previous.items, ...previous.activeItems].map((row) => [row.id, row])).values(),
  ];
  const after = [
    ...new Map([...next.items, ...next.activeItems].map((row) => [row.id, row])).values(),
  ];
  rows(
    before,
    after,
    ({ id }) => id,
    (row) => ({ ...address(row.id), entityKind: "item", operation: "upsert", value: row }),
    "item",
  );
  rows(
    previous.pendingRequests,
    next.pendingRequests,
    ({ id }) => id,
    (row) => ({ ...address(row.id), entityKind: "request", operation: "upsert", value: row }),
    "request",
  );
  return changes;
}

function sameRevisioned<T extends Revisioned>(before: T, after: T) {
  const content = ({ revision: _revision, ...row }: T) => JSON.stringify(row);
  return content(before) === content(after);
}
