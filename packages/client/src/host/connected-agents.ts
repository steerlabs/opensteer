import type { IdentityConfig } from "@opensteer/core";
import {
  agentConnectionMcpPath,
  type AgentConnection,
  type PersonalRemoteAccessMode,
} from "@opensteer/protocol";
import { accessModeOptions } from "./access-modes.js";
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
/**
 * Where an agent outside Opensteer adds this Host as an MCP server. `remote`
 * is the address agents elsewhere use: a networked Host's own origin, or a
 * Personal Host's Remote access route. `thisComputer` is a loopback Host's own
 * origin, reachable only by apps on the computer it runs on. The Host accepts
 * exactly these origins (`connectionRequestOrigin`).
 */
export interface ExternalAgentAddresses {
  readonly remote: {
    readonly url: string;
    /** Only Connect and networked Hosts are reachable by agents in the cloud. */
    readonly reach: "internet" | "private-network";
  } | null;
  readonly thisComputer: string | null;
}

export function externalAgentAddresses(input: {
  readonly identity: Pick<IdentityConfig, "exposure" | "publicOrigin">;
  readonly remoteAccess: {
    readonly mode: PersonalRemoteAccessMode;
    readonly origin: string | null;
  } | null;
}): ExternalAgentAddresses {
  const address = (origin: string) => new URL(agentConnectionMcpPath, origin).href;
  if (input.identity.exposure === "networked")
    return {
      remote: { url: address(input.identity.publicOrigin), reach: "internet" },
      thisComputer: null,
    };
  const route = input.remoteAccess;
  return {
    remote:
      route && route.mode !== "off" && route.origin
        ? {
            url: address(route.origin),
            reach: route.mode === "connect" ? "internet" : "private-network",
          }
        : null,
    thisComputer: address(input.identity.publicOrigin),
  };
}

/**
 * The agents Settings explains how to connect, in the order it lists them.
 * Each `step` is the one thing to do in that agent; Opensteer supplies the
 * address before it and the approval after it. An agent joins this list only
 * once it has been seen to connect end to end.
 */
export const externalAgentGuides = [
  {
    id: "chatgpt",
    name: "ChatGPT",
    providerId: "openai",
    summary: "Use Opensteer from ChatGPT.",
    step: "In ChatGPT's settings, open Apps and create an app with this address. Choose OAuth.",
  },
  {
    id: "claude",
    name: "Claude",
    providerId: "anthropic",
    summary: "Use Opensteer from Claude.",
    step: "In Claude, open Settings, then Connectors, and add a custom connector with this address.",
  },
  {
    id: "other",
    name: "Another agent",
    providerId: null,
    summary: "Any agent that supports MCP with OAuth sign-in.",
    step: "Add a remote MCP server with this address, and choose OAuth when it asks how to sign in.",
  },
] as const satisfies readonly {
  readonly id: string;
  readonly name: string;
  readonly providerId: string | null;
  readonly summary: string;
  readonly step: string;
}[];
export type ExternalAgentGuide = (typeof externalAgentGuides)[number];

/** The same words every Thread uses for these modes. */
export function connectionAccessLabel(mode: AgentConnection["accessMode"]): string {
  return accessModeOptions.find((option) => option.mode === mode)?.label ?? mode;
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
