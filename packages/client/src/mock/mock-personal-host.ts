import { SequenceSchema, type AgentEventView } from "@opensteer/core";
import { ClientToHostMessageSchema, hostApi, type HostToClientMessage } from "@opensteer/protocol";
import { hostApiVersion } from "@opensteer/deployment-authority";
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
  deliver(frame: HostToClientMessage): void {
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
/** Runs the production client against the same mock RPC and Deployment stream. */
export class MockPersonalHost {
  readonly client: MockHostClient;
  readonly sockets = new Set<MockPersonalSocket>();
  readonly #subscribed = new Set<MockPersonalSocket>();
  readonly #release: () => void;
  #through = SequenceSchema.parse("0");
  #rows: AgentEventView[] = [];
  constructor(client = new MockHostClient({ latencyMs: 0 })) {
    this.client = client;
    this.#through = this.#highWater();
    this.#release = client.subscribe(() => {
      this.#through = this.#highWater(SequenceSchema.parse(String(BigInt(this.#through) + 1n)));
      this.#rows = [];
      for (const socket of this.#subscribed) this.#snapshot(socket);
    });
  }
  #highWater(minimum = SequenceSchema.parse("0")) {
    const snapshot = this.client.getSnapshot();
    let through = BigInt(minimum);
    for (const state of Object.values(snapshot.threadReadStates))
      for (const seq of [state.asOfSequence, state.readSequence, state.unreadSequence])
        if (seq && BigInt(seq) > through) through = BigInt(seq);
    return SequenceSchema.parse(String(through));
  }
  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const key = url.pathname.slice("/v1/rpc/".length);
    if (!(key in hostApi)) return new Response(null, { status: 404 });
    const name = key as keyof typeof hostApi;
    const raw = url.searchParams.get("input") ?? init?.body;
    const payload = typeof raw === "string" ? JSON.parse(raw) : {};
    return Response.json(await this.client.rpc[name](payload as never));
  };
  readonly connect = (): MockPersonalSocket => {
    const socket = new MockPersonalSocket((data) => {
      const frame = ClientToHostMessageSchema.parse(JSON.parse(data));
      if (frame.type !== "client.subscribe") return;
      if (
        frame.cursor.deploymentId !== this.client.getSnapshot().deploymentId ||
        frame.cursor.apiVersion !== hostApiVersion
      ) {
        socket.close();
        return;
      }
      this.#subscribed.add(socket);
      const rows = this.#rows.filter(
        (row) => BigInt(row.sequence) > BigInt(frame.cursor.afterSequence),
      );
      if (
        frame.cursor.afterSequence !== "0" &&
        rows.length <= 200 &&
        this.#rows.length > 0 &&
        BigInt(frame.cursor.afterSequence) >= BigInt(this.#rows[0]!.sequence) - 1n
      )
        socket.deliver({ type: "host.events", events: rows, throughSequence: this.#through });
      else this.#snapshot(socket);
      socket.deliver({ type: "host.synchronized", sequence: this.#through });
    });
    this.sockets.add(socket);
    socket.addEventListener("close", () => {
      this.sockets.delete(socket);
      this.#subscribed.delete(socket);
    });
    return socket;
  };
  #snapshot(socket: MockPersonalSocket): void {
    socket.deliver({
      type: "host.snapshot",
      snapshot: this.client.deploymentSnapshot(this.#through),
    });
  }
  publish(events: readonly AgentEventView[], throughSequence: string): void {
    const through = SequenceSchema.parse(throughSequence);
    if (
      BigInt(through) < BigInt(this.#through) ||
      events.some((row) => BigInt(row.sequence) > BigInt(through))
    )
      throw new Error("Invalid stream cut.");
    this.#through = through;
    this.#rows = [...this.#rows, ...events].slice(-1000);
    for (const socket of this.#subscribed)
      socket.deliver({ type: "host.events", events: [...events], throughSequence: through });
  }
  dispose(): void {
    this.#release();
    for (const socket of [...this.sockets]) socket.close();
    this.client.dispose();
  }
}
