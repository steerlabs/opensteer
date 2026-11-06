import {
  connectionAccessLabel,
  connectionReachLabel,
  externalAgentAddresses,
  formatRelativeTime,
  HostClientRequestError,
  mutationIdempotencyKey,
  type ExternalAgentGuide,
  type HostClient,
} from "@opensteer/client/host";
import type { IdentityConfig, ThreadAccessMode } from "@opensteer/core";
import type {
  AgentConnection,
  AgentConnectionConsent,
  PersonalRemoteAdministrationStatus,
} from "@opensteer/protocol";

export const externalAgentsLead =
  "Connect Opensteer to ChatGPT, Claude and other agents, so they can get things done on your computer. You approve each one.";
export const externalAgentsFootnote =
  "Agents reach your computer through Remote access while it’s on and awake.";
export const externalAgentsNeedsRemote =
  "Turn on Remote access first — these agents run in the cloud and reach your computer through it.";

/**
 * Where agents in the cloud reach this Deployment, as Settings on a phone
 * shows it. A Personal Host's own loopback address is never offered here: it
 * means something only on the computer the Host runs on.
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

/** What one guide's sheet offers for the first step: the address, or why this agent can't use it. */
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
      detail: `${guide.name} can’t reach a private network address. Switch Remote access to Opensteer Connect.`,
    };
  return { kind: "address", url: reach.url };
}

export function connectionDetail(
  connection: AgentConnection,
  workspaces: readonly { id: string; name: string }[],
  now = new Date(),
): string {
  const used =
    connection.lastUsedAt === null
      ? "Not used yet."
      : `Used ${usedWhen(connection.lastUsedAt, now)}.`;
  return `${connectionAccessLabel(connection.accessMode)}, in ${connectionReachLabel(connection, workspaces)}. ${used}`;
}

function usedWhen(at: string, now: Date): string {
  const when = formatRelativeTime(at, now);
  if (when === "now") return "just now";
  return /^\d+[mhd]$/u.test(when) ? `${when} ago` : when;
}

/**
 * The connection a setup sheet is waiting for: the first one that was not
 * listed when the sheet opened. Null until the list has loaded once, so a
 * list that arrives after the sheet opened is the baseline, not a new agent.
 */
export function arrivedConnection(
  connections: readonly AgentConnection[] | null,
  baseline: ReadonlySet<string> | null,
): AgentConnection | null {
  if (connections === null || baseline === null) return null;
  return connections.find((connection) => !baseline.has(connection.id)) ?? null;
}

/** Where approving sends access, in words a person can check against the agent they started from. */
export function consentDestination(redirectUri: string): string {
  const url = new URL(redirectUri);
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
    ? "Access goes to an app on that computer."
    : `Access goes to ${url.host}. Anyone who runs that service gets it.`;
}

export const agentConnectionExpired =
  "This connection request expired. Start again from the agent.";

/** The words for a consent read or decision that failed. */
export function agentConnectionFailure(error: unknown, fallback: string): string {
  return error instanceof HostClientRequestError && error.code === "not_found"
    ? agentConnectionExpired
    : fallback;
}

/**
 * Answers a consent and returns the page that finishes the agent's sign-in.
 * Completion is bound to the origin the agent signed in through, so the
 * browser opens it there rather than at this phone's route to the Host.
 */
export async function decideAgentConnection(
  client: Pick<HostClient, "dispatch">,
  consent: AgentConnectionConsent,
  decision:
    | { readonly kind: "deny" }
    | {
        readonly kind: "approve";
        readonly label: string;
        readonly accessMode: ThreadAccessMode;
        /** A Workspace id, or "user" for everything the person can access. */
        readonly reach: string;
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
            reach:
              decision.reach === "user"
                ? { kind: "user" }
                : { kind: "workspace", workspaceId: workspaceIdOf(consent, decision.reach) },
          },
  });
  if (result.type !== "connection.authorize") throw new Error("Unexpected consent result.");
  return new URL(result.completionPath, consent.resource).href;
}

function workspaceIdOf(consent: AgentConnectionConsent, id: string) {
  const workspace = consent.workspaces.find((candidate) => candidate.id === id);
  if (!workspace) throw new Error("That workspace is no longer offered.");
  return workspace.id;
}
