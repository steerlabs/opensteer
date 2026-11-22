import { createClientRead, type ClientRead } from "../reads/client-read.js";
import { createClientActionFamily, type ClientAction } from "../actions/client-action.js";
import { presentClientIssue, type ClientIssue } from "../feedback/client-issue.js";
import {
  RunnerIdSchema,
  type AgentGrant,
  type IdentityConfig,
  type ThreadAccessMode,
} from "@opensteer/core";
import { classifyClientFailure } from "../connections/operation-error.js";
import {
  agentConnectionConsentRefusals,
  agentConnectionMcpPath,
  type AgentConnection,
  type AgentConnectionConsent,
  type PersonalRemoteAccessMode,
  type PersonalRemoteAdministrationStatus,
} from "@opensteer/protocol";
import { accessModeOptions } from "./access-modes.js";
import { connectionStateEnded } from "./connected-agent-view.js";
import type { HostClient } from "./client.js";
import { mutationIdempotencyKey, unwrapRpcResult } from "./host-session-client.js";
import { formatRelativeTime } from "./thread-list-model.js";

export interface ConnectedAgentsSnapshot {
  readonly connections: readonly AgentConnection[] | null;
  readonly error: string | null;
  readonly issue: ClientIssue | null;
  /** The connection an action is running for. */
  readonly pending: string | null;
  readonly pendingAction: ConnectedAgentAction | null;
  /** Disconnects the Home confirmed that the list has not reported on yet. */
  readonly revoked: ReadonlySet<string>;
  /** The connection whose edit lost to a newer change; the list was read again. */
  readonly conflict: string | null;
  readonly grantsAvailable: boolean;
}
export type ConnectedAgentAction = "revoke" | "update" | "remove";

/** What an edit sends: the revision it was made against, and only what changed. */
export interface ConnectedAgentUpdate {
  readonly expectedRevision: number;
  readonly label?: string;
  readonly accessMode?: ThreadAccessMode;
  readonly grant?: AgentGrant;
}
export type ConnectedAgentUpdateResult =
  | { readonly kind: "saved"; readonly connection: AgentConnection }
  | { readonly kind: "conflict" }
  | { readonly kind: "gone" }
  | { readonly kind: "failed" };

const noRevokes: ReadonlySet<string> = new Set();
const resources = new WeakMap<HostClient, ConnectedAgentsClient>();
export function connectedAgentsClient(client: HostClient): ConnectedAgentsClient {
  let resource = resources.get(client);
  if (!resource) {
    resource = new ConnectedAgentsClient(client);
    resources.set(client, resource);
  }
  return resource;
}
type ConnectedAgentsHost = Pick<
  HostClient,
  "connection" | "rpc" | "dispatch" | "subscribe" | "getSnapshot" | "subscribeConnectionsChanged"
>;

async function readConnectedAgents(client: Pick<ConnectedAgentsHost, "rpc">, signal?: AbortSignal) {
  const { connections, endedConnections } = unwrapRpcResult(
    await client.rpc["connections.list"]({}, signal ? { signal } : undefined),
  );
  return {
    connections: endedConnections?.length
      ? [...connections, ...endedConnections].sort(
          (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
        )
      : connections,
    grantsAvailable: endedConnections !== undefined,
  };
}

export class ConnectedAgentsClient {
  readonly read: ClientRead<Awaited<ReturnType<typeof readConnectedAgents>>>;
  readonly #listeners = new Set<() => void>();
  readonly #revokes: ReturnType<typeof createClientActionFamily<string, void>>;
  readonly #updates: ReturnType<
    typeof createClientActionFamily<
      { readonly connectionId: string; readonly update: ConnectedAgentUpdate },
      ConnectedAgentUpdateResult
    >
  >;
  readonly #removes: ReturnType<typeof createClientActionFamily<string, void>>;
  #state: ConnectedAgentsSnapshot;
  #release: (() => void) | null = null;
  #starts = 0;
  #action: ClientAction<never, unknown> | null = null;
  #revoked = new Set<string>();
  constructor(client: ConnectedAgentsHost) {
    this.#state = {
      connections: null,
      error: null,
      issue: null,
      pending: null,
      pendingAction: null,
      revoked: noRevokes,
      conflict: null,
      grantsAvailable: false,
    };
    this.read = createClientRead(client, {
      key: "connected-agents",
      label: "connected agents",
      read: (signal) => readConnectedAgents(client, signal),
      subscribeInvalidation: (listener) => client.subscribeConnectionsChanged(listener),
    });
    this.#revokes = createClientActionFamily(client, {
      label: "disconnect this agent",
      done: "disconnected",
      happened: "this agent was disconnected",
      execute: async (connectionId) => {
        await client.dispatch({
          type: "connection.revoke",
          connectionId,
          idempotencyKey: mutationIdempotencyKey("connection-revoke"),
        });
      },
      reconcile: async (connectionId) => {
        const { connections } = await readConnectedAgents(client);
        const row = connections.find((candidate) => candidate.id === connectionId);
        // Only an ended state proves it: a paused chat, or a state this app does not know, is
        // not a Disconnect.
        return !row || row.revokedAt || connectionStateEnded(row.state)
          ? { kind: "confirmed", value: undefined }
          : null;
      },
    });
    this.#updates = createClientActionFamily(client, {
      label: "save this change",
      done: "saved",
      happened: "this change was saved",
      execute: async ({ connectionId, update }): Promise<ConnectedAgentUpdateResult> => {
        try {
          const result = await client.dispatch({
            type: "connection.update",
            connectionId,
            idempotencyKey: mutationIdempotencyKey("connection-update"),
            ...update,
          });
          if (result.type !== "connection.update") return { kind: "failed" };
          return { kind: "saved", connection: result.connection };
        } catch (error) {
          const code = classifyClientFailure(error).code;
          if (code === "conflict") return { kind: "conflict" };
          if (code === "not_found") return { kind: "gone" };
          throw error;
        }
      },
    });
    this.#removes = createClientActionFamily(client, {
      label: "remove this agent from the list",
      done: "removed",
      happened: "this agent was removed from the list",
      execute: async (connectionId) => {
        await client.dispatch({
          type: "connection.remove",
          connectionId,
          idempotencyKey: mutationIdempotencyKey("connection-remove"),
        });
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
  #publish(patch: Partial<ConnectedAgentsSnapshot>): void {
    this.#state = { ...this.#state, ...patch };
    this.#listeners.forEach((listener) => listener());
  }
  #changed = (): void => {
    const read = this.read.getSnapshot(),
      action = this.#action?.getSnapshot();
    const issue = action?.issue ?? read.issue;
    const data = read.status === "ready" ? read.data : null;
    const connections = data?.connections ?? null;
    // A revoke stays this client's own fact only until the Home lists its outcome.
    if (connections && this.#revoked.size) {
      for (const id of this.#revoked) {
        const row = connections.find((candidate) => candidate.id === id);
        if (!row || connectionStateEnded(row.state) || row.revokedAt) this.#revoked.delete(id);
      }
    }
    this.#publish({
      connections,
      issue,
      error: issue ? presentClientIssue(issue).title : null,
      pending: action?.running ? this.#state.pending : null,
      pendingAction: action?.running ? this.#state.pendingAction : null,
      revoked: this.#revoked.size ? new Set(this.#revoked) : noRevokes,
      grantsAvailable: data?.grantsAvailable === true,
    });
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
  async #run<I, O>(
    action: ClientAction<I, O>,
    kind: ConnectedAgentAction,
    connectionId: string,
    input: I,
  ) {
    this.#action = action as unknown as ClientAction<never, unknown>;
    this.#publish({ pending: connectionId, pendingAction: kind, conflict: null });
    const release = action.subscribe(this.#changed);
    try {
      return await action.run(input);
    } finally {
      release();
      this.#changed();
    }
  }
  /** Disconnect: authority ends when the Home confirms; the list then says how its work stopped. */
  revoke = async (connectionId: string): Promise<void> => {
    const outcome = await this.#run(
      this.#revokes.for(connectionId),
      "revoke",
      connectionId,
      connectionId,
    );
    if (outcome.kind === "confirmed") {
      this.#revoked.add(connectionId);
      this.#changed();
      this.read.invalidate();
    }
  };
  /** Saves an edit made against `expectedRevision`; a stale one reads the list again. */
  update = async (
    connectionId: string,
    update: ConnectedAgentUpdate,
  ): Promise<ConnectedAgentUpdateResult> => {
    const outcome = await this.#run(this.#updates.for(connectionId), "update", connectionId, {
      connectionId,
      update,
    });
    if (outcome.kind !== "confirmed") return { kind: "failed" };
    const result = outcome.value;
    if (result.kind === "saved") {
      const connections = this.#state.connections?.map((row) =>
        row.id === connectionId ? result.connection : row,
      );
      if (connections) this.#publish({ connections });
    } else if (result.kind === "conflict") this.#publish({ conflict: connectionId });
    if (result.kind !== "failed") this.read.invalidate();
    return result;
  };
  /** Takes an ended connection off the list: true only once the Home confirms it is gone. */
  remove = async (connectionId: string): Promise<boolean> => {
    const outcome = await this.#run(
      this.#removes.for(connectionId),
      "remove",
      connectionId,
      connectionId,
    );
    if (outcome.kind !== "confirmed") return false;
    this.read.invalidate();
    return true;
  };
  dismiss = (): void => {
    this.#action?.dismiss();
    this.#publish({ conflict: null });
    this.#changed();
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
 * Each `step` is what to do in that agent; Opensteer supplies the address before
 * it and the approval after it. `reach: "internet"` marks cloud-hosted agents
 * that connect from the vendor's servers and cannot use a private-network or
 * loopback address; `reach: "any"` marks local apps, CLIs, and generic clients
 * that can also connect locally or over a private network.
 */
export const externalAgentGuides = [
  {
    id: "chatgpt",
    name: "ChatGPT",
    providerId: "openai",
    reach: "internet",
    summary: "Use Opensteer from ChatGPT.",
    step: "On Business or Enterprise plans, an admin must allow Create plugins with MCPs in Workspace settings → Permissions & roles. Open chatgpt.com/plugins, select +, then Add custom MCP server. Enter this address under Connection, choose OAuth, check I understand and want to continue, and select Create as a plugin.",
  },
  {
    id: "claude",
    name: "Claude",
    providerId: "anthropic",
    reach: "internet",
    summary: "Use Opensteer from Claude on the web, desktop, or mobile.",
    step: "Free plans allow one custom connector; on Team or Enterprise plans, an Owner must first add it in Organization settings → Connectors. In Claude, open Customize → Connectors, click + Add, then Add custom connector. Enter this address, click Continue, choose Register automatically if asked for OAuth client, and click Add.",
  },
  {
    id: "grok",
    name: "Grok",
    providerId: "xai",
    reach: "internet",
    summary: "Use Opensteer from Grok.",
    step: "On Grok Business or Enterprise plans, a team admin must first add it in console.x.ai under Grok Business → Connectors. Open grok.com/connectors, click New Connector, select Custom, enter this address, and complete sign-in.",
  },
  {
    id: "perplexity",
    name: "Perplexity",
    providerId: null,
    reach: "internet",
    summary: "Use Opensteer from Perplexity.",
    step: "In an Enterprise organization, an admin must turn on Allow members to add custom connectors in Organization settings → Connectors. Open Plugins in the sidebar, select Add custom → Add MCP connector, choose Remote, enter this address, set Authentication to OAuth under Advanced, check the acknowledgement, select Add, then open the card to sign in.",
  },
  {
    id: "mistral",
    name: "Mistral Le Chat",
    providerId: "mistral",
    reach: "internet",
    summary: "Use Opensteer from Mistral Le Chat.",
    step: "Requires an administrator (you are one by default on Free, Pro, and Student plans). Open Connectors, click + Add Connector, switch to Custom MCP Connector, enter a name with no spaces and this address as Server URL, click Connect, and sign in.",
  },
  {
    id: "claude-code",
    name: "Claude Code",
    providerId: "anthropic",
    reach: "any",
    summary: "Use Opensteer from Claude Code in your terminal.",
    step: "In your terminal, run claude mcp add --transport http opensteer <address>, then run claude mcp login opensteer (or open /mcp in Claude Code) to sign in.",
  },
  {
    id: "codex",
    name: "Codex",
    providerId: "openai",
    reach: "any",
    summary: "Use Opensteer from Codex CLI, the ChatGPT desktop app, or the IDE extension.",
    step: "In your terminal, run codex mcp add opensteer --url <address>, then run codex mcp login opensteer. Or in the ChatGPT desktop app, open Settings → MCP servers → Add server, choose Streamable HTTP, save, select Restart, and select Authenticate.",
  },
  {
    id: "cursor",
    name: "Cursor",
    providerId: "cursor",
    reach: "any",
    summary: "Use Opensteer from Cursor.",
    step: "Add an entry under mcpServers with this address as url (and no Authorization header) in ~/.cursor/mcp.json, save, then open Customize → MCPs and sign in when prompted.",
  },
  {
    id: "vscode",
    name: "VS Code",
    providerId: null,
    reach: "any",
    summary: "Use Opensteer from GitHub Copilot in VS Code.",
    step: "Enable AI features and select Copilot in Chat. Run MCP: Add Server from the Command Palette (or Chat: Open Customizations → MCP Servers → Add Server), choose HTTP (HTTP or Server-Sent Events), enter this address, pick Global → Copilot Global, and sign in when prompted.",
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    providerId: "google",
    reach: "any",
    summary: "Use Opensteer from Gemini CLI.",
    step: "In your terminal, run gemini mcp add --transport http --scope user opensteer <address>, then start Gemini CLI and run /mcp auth opensteer to sign in.",
  },
  {
    id: "zed",
    name: "Zed",
    providerId: null,
    reach: "any",
    summary: "Use Opensteer from Zed.",
    step: "In Zed, open Settings → AI → MCP Servers, click Add Server, choose Add Remote Server, enter this address with no Authorization header, and sign in when prompted.",
  },
  {
    id: "devin-local",
    name: "Devin Local (Windsurf)",
    providerId: null,
    reach: "any",
    summary: "Use Opensteer from Devin Desktop (formerly Windsurf) or Devin CLI.",
    step: "In your terminal, run devin mcp add -s user opensteer <address>, then run devin mcp login opensteer. You can also manage it under Customize → MCPs in Devin Desktop.",
  },
  {
    id: "other",
    name: "Another agent",
    providerId: null,
    reach: "any",
    summary: "Any agent that supports MCP with OAuth sign-in.",
    step: "Add a remote MCP server with this address, and choose OAuth when it asks how to sign in.",
  },
] as const satisfies readonly {
  readonly id: string;
  readonly name: string;
  readonly providerId: string | null;
  readonly reach: "internet" | "any";
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
  guide: Pick<ExternalAgentGuide, "name" | "reach">,
  reach: Extract<ExternalAgentsReach, { kind: "ready" }>,
):
  | { readonly kind: "address"; readonly url: string }
  | { readonly kind: "blocked"; readonly detail: string } {
  // Cloud agents connect from the vendor's servers, so a private network address can't work.
  if (reach.reach === "private-network" && guide.reach === "internet")
    return {
      kind: "blocked",
      detail: `${guide.name} can’t reach a private network address. Switch Remote access to your Opensteer account, under Advanced.`,
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
        readonly grant?: AgentGrant;
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
            ...(consent.verificationSnapshot
              ? { verificationSnapshot: consent.verificationSnapshot }
              : {}),
            ...(consent.grantsAvailable && decision.grant ? { grant: decision.grant } : {}),
          },
  });
  if (result.type !== "connection.authorize") throw new Error("Unexpected consent result.");
  return new URL(result.completionPath, consent.resource).href;
}

/**
 * The Home refused an approval because who the agent is changed after the consent was read.
 * Only this refusal means "read it again"; every other one keeps its own meaning.
 */
export function consentVerificationChanged(error: unknown): boolean {
  return classifyClientFailure(error).reason === agentConnectionConsentRefusals.verificationChanged;
}

/** The same words every Thread uses for these modes. */
export function connectionAccessLabel(mode: AgentConnection["accessMode"]): string {
  return accessModeOptions.find((option) => option.mode === mode)?.label ?? mode;
}

/**
 * Creates the dedicated profile a consent chose, through the same command Browser
 * profiles uses, and returns its id. The caller keeps the id so a retried approval
 * reuses it rather than creating a second profile.
 */
export async function createDedicatedProfile(
  client: Pick<HostClient, "dispatch">,
  input: { readonly name: string; readonly homeRunnerId: string | null },
): Promise<string> {
  const result = await client.dispatch({
    type: "browser.profile.create",
    idempotencyKey: mutationIdempotencyKey("agent-profile"),
    input: {
      name: input.name.trim().slice(0, 120),
      ...(input.homeRunnerId ? { homeRunnerId: RunnerIdSchema.parse(input.homeRunnerId) } : {}),
    },
  });
  if (result.type !== "browser.profile.create") throw new Error("Unexpected profile result.");
  return result.profile.id;
}
