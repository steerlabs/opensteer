import type { IntegrationAccess } from "./access.js";
import type { IntegrationConnectionRequirement, IntegrationReadiness } from "./models.js";
import {
  IntegrationConnectionIdSchema,
  type IntegrationConnectionId,
  type IntegrationServerId,
} from "./ids.js";

export interface IntegrationConnectionAuthority {
  readonly connectionKind: "channel" | "computer";
  readonly definitionId: string | null;
  readonly id: string;
  readonly integrationServerId: string | null;
  readonly status: "connected" | "needs-attention" | "paused" | "pending" | "revoked";
}

export interface ResolveIntegrationReadinessInput {
  readonly connectionRequirement: IntegrationConnectionRequirement;
  readonly connections: readonly IntegrationConnectionAuthority[];
  readonly hasAccess: (
    connectionId: IntegrationConnectionId | null,
    requiredAccess: IntegrationAccess,
  ) => boolean;
  readonly installationStatus: "active" | "disabled" | "needs-attention";
  readonly requiredAccess: IntegrationAccess;
  readonly runAccess?: IntegrationAccess;
  readonly requiredConnectionId: string | null;
  readonly serverId: IntegrationServerId;
  readonly serverStatus: "active" | "disabled" | "needs-attention";
  readonly statusDetail?: string | null;
}

/**
 * The single authority rule used by discovery and runtime exposure. It resolves eligibility from
 * persisted state: installation metadata never implies that a computer runs the app.
 */
export function resolveIntegrationReadiness(
  input: ResolveIntegrationReadinessInput,
): IntegrationReadiness {
  const base = {
    detail: input.statusDetail ?? null,
    provider: null,
    requiredAccess: null,
    serverId: input.serverId,
  } as const;
  if (input.installationStatus !== "active" || input.serverStatus !== "active")
    return { ...base, code: "INTEGRATION_UNAVAILABLE", connectionId: null };
  if (input.runAccess === "read" && input.requiredAccess === "read-write")
    return {
      ...base,
      code: "READ_ONLY_TASK",
      connectionId: input.requiredConnectionId
        ? IntegrationConnectionIdSchema.parse(input.requiredConnectionId)
        : null,
    };
  if (input.connectionRequirement.kind === "none") {
    return input.hasAccess(null, input.requiredAccess)
      ? { ...base, code: "READY", connectionId: null }
      : {
          ...base,
          code: "ACCESS_GRANT_REQUIRED",
          connectionId: null,
          requiredAccess: input.requiredAccess,
        };
  }
  const requirement = input.connectionRequirement;
  const relevant = input.connections.filter(
    (connection) =>
      (!input.requiredConnectionId || connection.id === input.requiredConnectionId) &&
      connection.connectionKind === "computer" &&
      connection.definitionId === requirement.definitionId,
  );
  const eligible = relevant.filter((connection) =>
    isIntegrationConnectionEligible({ connection, connectionRequirement: requirement }),
  );
  const ready = eligible.find((connection) =>
    input.hasAccess(IntegrationConnectionIdSchema.parse(connection.id), input.requiredAccess),
  );
  if (ready)
    return { ...base, code: "READY", connectionId: IntegrationConnectionIdSchema.parse(ready.id) };
  if (eligible[0]) {
    return {
      ...base,
      code: "ACCESS_GRANT_REQUIRED",
      connectionId: IntegrationConnectionIdSchema.parse(eligible[0].id),
      requiredAccess: input.requiredAccess,
    };
  }
  const attention = relevant.find(
    ({ status }) => status === "needs-attention" || status === "paused",
  );
  if (attention)
    return {
      ...base,
      code: "REAUTHORIZATION_REQUIRED",
      connectionId: IntegrationConnectionIdSchema.parse(attention.id),
    };
  return { ...base, code: "USER_AUTHORIZATION_REQUIRED", connectionId: null };
}

export function isIntegrationConnectionEligible(input: {
  readonly connection: IntegrationConnectionAuthority;
  readonly connectionRequirement: IntegrationConnectionRequirement;
}): boolean {
  const { connection, connectionRequirement } = input;
  return (
    connection.status === "connected" &&
    connectionRequirement.kind === "computer" &&
    connection.connectionKind === "computer" &&
    connection.definitionId === connectionRequirement.definitionId
  );
}
