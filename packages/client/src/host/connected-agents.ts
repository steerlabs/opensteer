import { createClientRead, type ClientRead } from "../reads/client-read.js";
import { createClientActionFamily, type ClientAction } from "../actions/client-action.js";
import { presentClientIssue, type ClientIssue } from "../feedback/client-issue.js";
import type { IdentityConfig, ThreadAccessMode } from "@opensteer/core";
import {
  agentConnectionMcpPath,
  type AgentConnection,
  type AgentConnectionConsent,
  type PersonalRemoteAccessMode,
  type PersonalRemoteAdministrationStatus,
} from "@opensteer/protocol";
import { accessModeOptions } from "./access-modes.js";
import type { HostClient } from "./client.js";
import { mutationIdempotencyKey, unwrapRpcResult } from "./host-session-client.js";
import { formatRelativeTime } from "./thread-list-model.js";

export interface ConnectedAgentsSnapshot {
  readonly connections: readonly AgentConnection[] | null;
  readonly error: string | null;
  readonly issue: ClientIssue | null;
  readonly pending: string | null;
}
const resources = new WeakMap<HostClient, ConnectedAgentsClient>();
export function connectedAgentsClient(client: HostClient): ConnectedAgentsClient {
  let resource = resources.get(client);
  if (!resource) {
    resource = new ConnectedAgentsClient(client);
    resources.set(client, resource);
  }
  return resource;
}
export class ConnectedAgentsClient {
  readonly read: ClientRead<readonly AgentConnection[]>;
  readonly #listeners = new Set<() => void>();
  readonly #revokes: ReturnType<typeof createClientActionFamily<string, void>>;
  #state: ConnectedAgentsSnapshot = { connections: null, error: null, issue: null, pending: null };
  #release: (() => void) | null = null;
  #starts = 0;
  #action: ClientAction<string, void> | null = null;
  constructor(
    client: Pick<
      HostClient,
      | "connection"
      | "rpc"
      | "dispatch"
      | "subscribe"
      | "getSnapshot"
      | "subscribeConnectionsChanged"
    >,
  ) {
    this.read = createClientRead(client, {
      key: "connected-agents",
      label: "connected agents",
      read: async (signal) =>
        unwrapRpcResult(await client.rpc["connections.list"]({}, { signal })).connections,
      subscribeInvalidation: (listener) => client.subscribeConnectionsChanged(listener),
    });
    this.#revokes = createClientActionFamily(client, {
      label: "revoke",
      done: "revoked",
      thing: "this agent",
      execute: async (connectionId) => {
        await client.dispatch({
          type: "connection.revoke",
          connectionId,
          idempotencyKey: mutationIdempotencyKey("connection-revoke"),
        });
      },
      reconcile: async (connectionId) => {
        const { connections } = unwrapRpcResult(await client.rpc["connections.list"]({}));
        return connections.some((row) => row.id === connectionId)
          ? null
          : { kind: "confirmed", value: undefined };
      },
    });
  }
  getSnapshot = (): ConnectedAgentsSnapshot => this.#state;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  #changed = (): void => {
    const read = this.read.getSnapshot(),
      action = this.#action?.getSnapshot();
    const issue = action?.issue ?? read.issue;
    this.#state = {
      connections: read.status === "ready" ? read.data : null,
      issue,
      error: issue ? presentClientIssue(issue).title : null,
      pending: action?.running ? this.#state.pending : null,
    };
    this.#listeners.forEach((listener) => listener());
  };
  start(): () => void {
    if (this.#starts++ === 0) {
      this.#release = this.read.subscribe(this.#changed);
      this.#changed();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.#starts === 0) {
        this.#release?.();
        this.#release = null;
      }
    };
  }
  refresh = (): Promise<void> => (this.#release ? this.read.refresh() : Promise.resolve());
  revoke = async (connectionId: string): Promise<void> => {
    const action = this.#revokes.for(connectionId);
    this.#action = action;
    this.#state = { ...this.#state, pending: connectionId };
    const release = action.subscribe(this.#changed);
    try {
      const outcome = await action.run(connectionId);
      if (outcome.kind === "confirmed") this.read.invalidate();
    } finally {
      release();
      this.#changed();
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

/**
 * Where agents in the cloud reach this Deployment, as Settings shows it.
 * `loading` holds until a Personal Host's Remote access is known, so the
 * page never asks a person to turn on something that is already on.
 */
export type ExternalAgentsReach =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable"; readonly detail: string }
  | { readonly kind: "needs-remote" }
  | {
      readonly kind: "ready";
      readonly personal: boolean;
      readonly reach: "internet" | "private-network";
      readonly url: string;
    };

export function externalAgentsReach(input: {
  readonly identity: Pick<IdentityConfig, "exposure" | "publicOrigin"> | null;
  readonly remote: {
    readonly status: PersonalRemoteAdministrationStatus | null;
    readonly error: string | null;
  };
}): ExternalAgentsReach {
  if (input.identity === null) return { kind: "loading" };
  const personal = input.identity.exposure !== "networked";
  const status = input.remote.status;
  if (personal && status === null)
    return input.remote.error === null
      ? { kind: "loading" }
      : { kind: "unavailable", detail: input.remote.error };
  const { remote } = externalAgentAddresses({
    identity: input.identity,
    remoteAccess:
      status === null
        ? null
        : { mode: status.access.mode, origin: status.access.route?.document.route.origin ?? null },
  });
  return remote === null ? { kind: "needs-remote" } : { kind: "ready", personal, ...remote };
}

/** What one guide offers as its first step: the address, or why that agent can't use it. */
export function guideAddress(
  guide: Pick<ExternalAgentGuide, "name" | "providerId">,
  reach: Extract<ExternalAgentsReach, { kind: "ready" }>,
):
  | { readonly kind: "address"; readonly url: string }
  | { readonly kind: "blocked"; readonly detail: string } {
  // Only "Another agent" may be one running somewhere that can see a private network.
  if (reach.reach === "private-network" && guide.providerId !== null)
    return {
      kind: "blocked",
      detail: `${guide.name} can’t reach a private network address. Switch Use from anywhere to your Opensteer Account, under Advanced.`,
    };
  return { kind: "address", url: reach.url };
}

export const externalAgentsLead =
  "Connect Opensteer to ChatGPT, Claude and other agents, so they can get things done for you. You approve each one.";

/** How a connection reads in a list: its ceiling, its reach, and when it last acted. */
export function connectionDetail(connection: AgentConnection, now = new Date()): string {
  const when = connection.lastUsedAt ? formatRelativeTime(connection.lastUsedAt, now) : null;
  const used =
    when === null
      ? "Not used yet."
      : when === "now"
        ? "Used just now."
        : `Used ${/^\d+[mhd]$/u.test(when) ? `${when} ago` : when}.`;
  return `${connectionAccessLabel(connection.accessMode)}. ${used}`;
}

/**
 * The connection a setup sheet is waiting for: the first one not listed when
 * the sheet opened. Null until the list has loaded once, so a list that
 * arrives after the sheet opened is the baseline, not a new agent.
 */
export function arrivedConnection(
  connections: readonly AgentConnection[] | null,
  baseline: ReadonlySet<string> | null,
): AgentConnection | null {
  if (connections === null || baseline === null) return null;
  return connections.find((connection) => !baseline.has(connection.id)) ?? null;
}

/**
 * Where approving sends the credential: the one fact about an agent the Host
 * can vouch for, since its name is self-reported.
 */
export function connectionDestination(redirectUri: string): string {
  const host = new URL(redirectUri).hostname;
  return ["localhost", "127.0.0.1", "[::1]"].includes(host)
    ? "Access goes to an app on the device that started this sign-in."
    : `Access goes to ${host}. Anyone who runs that service gets it.`;
}

/**
 * Answers a consent and returns the page that finishes the agent's sign-in.
 * Completion is bound to the origin the agent signed in through, so it is
 * opened there rather than at whatever route this client reaches the Host by.
 */
export async function answerAgentConnection(
  client: Pick<HostClient, "dispatch">,
  consent: AgentConnectionConsent,
  decision:
    | { readonly kind: "deny" }
    | {
        readonly kind: "approve";
        readonly label: string;
        readonly accessMode: ThreadAccessMode;
      },
): Promise<string> {
  const result = await client.dispatch({
    type: "connection.authorize",
    requestId: consent.requestId,
    idempotencyKey: mutationIdempotencyKey("connection-consent"),
    decision:
      decision.kind === "deny"
        ? { kind: "deny" }
        : {
            kind: "approve",
            label: decision.label.trim(),
            accessMode: decision.accessMode,
          },
  });
  if (result.type !== "connection.authorize") throw new Error("Unexpected consent result.");
  return new URL(result.completionPath, consent.resource).href;
}

/** The same words every Thread uses for these modes. */
export function connectionAccessLabel(mode: AgentConnection["accessMode"]): string {
  return accessModeOptions.find((option) => option.mode === mode)?.label ?? mode;
}
