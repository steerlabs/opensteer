import type { AgentConnection } from "@opensteer/protocol";
import type { HostClient } from "./client.js";
import { mutationIdempotencyKey, unwrapRpcResult } from "./host-session-client.js";

export interface ConnectedAgentsSnapshot {
  readonly connections: readonly AgentConnection[] | null;
  readonly error: string | null;
  readonly pending: string | null;
}
export class ConnectedAgentsClient {
  readonly #client: Pick<
    HostClient,
    "rpc" | "dispatch" | "subscribe" | "getSnapshot" | "subscribeConnectionsChanged"
  >;
  readonly #listeners = new Set<() => void>();
  #state: ConnectedAgentsSnapshot = { connections: null, error: null, pending: null };
  #controller: AbortController | null = null;
  #read = 0;
  #owner: string | null = null;
  constructor(
    client: Pick<
      HostClient,
      "rpc" | "dispatch" | "subscribe" | "getSnapshot" | "subscribeConnectionsChanged"
    >,
  ) {
    this.#client = client;
  }
  getSnapshot = () => this.#state;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  #set(patch: Partial<ConnectedAgentsSnapshot>) {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }
  start(): () => void {
    const controller = new AbortController();
    this.#controller?.abort();
    this.#controller = controller;
    let connection = this.#client.getSnapshot().connection;
    const observe = () => {
      const snapshot = this.#client.getSnapshot();
      const owner = snapshot.session === "authenticated" ? (snapshot.user?.id ?? null) : null;
      const changed = owner !== this.#owner;
      if (changed) {
        this.#owner = owner;
        ++this.#read;
        this.#set({ connections: null, error: null, pending: null });
      }
      if (owner && (changed || (snapshot.connection === "connected" && connection !== "connected")))
        void this.refresh();
      connection = snapshot.connection;
    };
    const unsubscribe = this.#client.subscribe(observe);
    const detachChanges = this.#client.subscribeConnectionsChanged(() => void this.refresh());
    const previousOwner = this.#owner;
    observe();
    if (this.#owner && this.#owner === previousOwner) void this.refresh();
    return () => {
      controller.abort();
      unsubscribe();
      detachChanges();
    };
  }
  refresh = async (): Promise<void> => {
    const signal = this.#controller?.signal;
    if (!signal || signal.aborted || !this.#owner) return;
    const read = ++this.#read;
    try {
      const result = unwrapRpcResult(await this.#client.rpc["connections.list"]({}, { signal }));
      if (!signal.aborted && read === this.#read)
        this.#set({ connections: result.connections, error: null });
    } catch {
      if (!signal.aborted && read === this.#read)
        this.#set({ error: "Connected agents could not be loaded." });
    }
  };
  revoke = async (connectionId: string): Promise<void> => {
    const signal = this.#controller?.signal;
    if (!signal || signal.aborted || !this.#owner || this.#state.pending) return;
    const owner = this.#owner;
    this.#set({ pending: connectionId, error: null });
    // A response started before revocation cannot put the removed row back.
    ++this.#read;
    try {
      await this.#client.dispatch({
        type: "connection.revoke",
        connectionId,
        idempotencyKey: mutationIdempotencyKey("connection-revoke"),
      });
      if (!signal.aborted && this.#owner === owner) {
        ++this.#read;
        this.#set({
          connections: this.#state.connections?.filter((row) => row.id !== connectionId) ?? null,
        });
      }
    } catch {
      if (!signal.aborted && this.#owner === owner)
        this.#set({ error: "The agent could not be revoked. Refresh and try again." });
    } finally {
      if (!signal.aborted && this.#owner === owner) this.#set({ pending: null });
    }
  };
}
export function connectionAccessLabel(mode: AgentConnection["accessMode"]): string {
  switch (mode) {
    case "approval-required":
      return "Ask before changes";
    case "auto-accept-edits":
      return "Accept edits";
    case "auto":
      return "Automatic";
    case "full-access":
      return "Full access";
  }
}

export function connectionReachLabel(
  connection: AgentConnection,
  workspaces: readonly { id: string; name: string }[],
): string {
  const reach = connection.reach;
  return reach.kind === "user"
    ? "Everything you can access"
    : (workspaces.find((workspace) => workspace.id === reach.workspaceId)?.name ??
        `Workspace ${reach.workspaceId}`);
}
