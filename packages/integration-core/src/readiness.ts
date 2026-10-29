import type {
  IntegrationConnectionRequirement,
  IntegrationAccess,
  IntegrationProviderAuthorization,
  IntegrationProvider,
  IntegrationReadiness,
} from "./models.js";
import {
  IntegrationConnectionIdSchema,
  type IntegrationConnectionId,
  type IntegrationServerId,
} from "./ids.js";

export interface IntegrationConnectionAuthority {
  readonly applicationSourceAvailable: boolean;
  readonly connectionKind: "channel" | "computer" | "mcp-oauth" | "provider-account";
  readonly definitionId: string | null;
  readonly id: string;
  readonly integrationServerId: string | null;
  readonly provider: string;
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
  readonly providerAuthorization: IntegrationProviderAuthorization | null;
  readonly requiredAccess: IntegrationAccess;
  readonly requiredConnectionId: string | null;
  readonly serverId: IntegrationServerId;
  readonly serverStatus: "active" | "disabled" | "needs-attention";
  readonly statusDetail?: string | null;
}

/**
 * The single authority rule used by discovery and runtime exposure. It resolves static eligibility
 * from persisted state — installation metadata never implies that an account is connected — and
 * nothing more: whether a connection can actually reach the provider right now is proven only by
 * materializing its token at the moment of use.
 */
export function resolveIntegrationReadiness(
  input: ResolveIntegrationReadinessInput,
): IntegrationReadiness {
  const base = {
    detail: input.statusDetail ?? null,
    requiredAccess: null,
    serverId: input.serverId,
  } as const;
  if (
    input.installationStatus !== "active" ||
    input.serverStatus === "disabled" ||
    (input.serverStatus === "needs-attention" && input.connectionRequirement.kind !== "mcp-oauth")
  ) {
    return {
      ...base,
      code: "INTEGRATION_UNAVAILABLE",
      connectionId: null,
      provider: providerFor(input.connectionRequirement),
    };
  }
  if (input.connectionRequirement.kind === "none") {
    return input.hasAccess(null, input.requiredAccess)
      ? { ...base, code: "READY", connectionId: null, provider: null }
      : {
          ...base,
          code: "ACCESS_GRANT_REQUIRED",
          connectionId: null,
          provider: null,
          requiredAccess: input.requiredAccess,
        };
  }
  const relevant = input.connections.filter((connection) =>
    connectionBelongsToRequirement(connection, input),
  );
  const eligible = relevant.filter((connection) =>
    isIntegrationConnectionEligible({
      connection,
      connectionRequirement: input.connectionRequirement,
      serverId: input.serverId,
    }),
  );
  const ready = eligible.find((connection) =>
    input.hasAccess(IntegrationConnectionIdSchema.parse(connection.id), input.requiredAccess),
  );
  if (ready) {
    return {
      ...base,
      code: "READY",
      connectionId: IntegrationConnectionIdSchema.parse(ready.id),
      provider: providerFor(input.connectionRequirement),
    };
  }
  if (eligible[0]) {
    return {
      ...base,
      code: "ACCESS_GRANT_REQUIRED",
      connectionId: IntegrationConnectionIdSchema.parse(eligible[0].id),
      provider: providerFor(input.connectionRequirement),
      requiredAccess: input.requiredAccess,
    };
  }
  const attention = relevant.find(
    ({ applicationSourceAvailable, status }) =>
      status === "needs-attention" || status === "paused" || !applicationSourceAvailable,
  );
  if (attention) {
    if (
      input.connectionRequirement.kind === "provider" &&
      input.connectionRequirement.providerApplicationRequired &&
      input.providerAuthorization?.code !== "READY"
    ) {
      return {
        ...base,
        code: "ADMIN_CONFIGURATION_REQUIRED",
        connectionId: IntegrationConnectionIdSchema.parse(attention.id),
        detail: input.providerAuthorization?.detail ?? "Provider authorization is unavailable",
        provider: providerFor(input.connectionRequirement),
      };
    }
    return {
      ...base,
      code: "REAUTHORIZATION_REQUIRED",
      connectionId: IntegrationConnectionIdSchema.parse(attention.id),
      provider: providerFor(input.connectionRequirement),
    };
  }
  if (
    input.connectionRequirement.kind === "provider" &&
    input.connectionRequirement.providerApplicationRequired &&
    input.providerAuthorization?.code !== "READY"
  ) {
    return {
      ...base,
      code: "ADMIN_CONFIGURATION_REQUIRED",
      connectionId: null,
      detail: input.providerAuthorization?.detail ?? "Provider authorization is unavailable",
      provider: input.connectionRequirement.provider,
    };
  }
  return {
    ...base,
    code: "USER_AUTHORIZATION_REQUIRED",
    connectionId: null,
    provider: providerFor(input.connectionRequirement),
  };
}

export function isIntegrationConnectionEligible(input: {
  readonly connection: IntegrationConnectionAuthority;
  readonly connectionRequirement: IntegrationConnectionRequirement;
  readonly serverId: IntegrationServerId;
}): boolean {
  const { connection, connectionRequirement } = input;
  if (connection.status !== "connected") return false;
  if (connectionRequirement.kind === "provider") {
    return (
      connection.connectionKind === "provider-account" &&
      connection.definitionId === connectionRequirement.definitionId &&
      connection.provider === connectionRequirement.provider &&
      (!connectionRequirement.providerApplicationRequired || connection.applicationSourceAvailable)
    );
  }
  if (connectionRequirement.kind === "computer") {
    return (
      connection.connectionKind === "computer" &&
      connection.definitionId === connectionRequirement.definitionId
    );
  }
  return (
    connectionRequirement.kind === "mcp-oauth" &&
    connection.connectionKind === "mcp-oauth" &&
    connection.integrationServerId === input.serverId
  );
}

function connectionBelongsToRequirement(
  connection: IntegrationConnectionAuthority,
  input: ResolveIntegrationReadinessInput,
): boolean {
  if (input.requiredConnectionId && connection.id !== input.requiredConnectionId) return false;
  if (input.connectionRequirement.kind === "provider") {
    return (
      connection.connectionKind === "provider-account" &&
      connection.definitionId === input.connectionRequirement.definitionId &&
      connection.provider === input.connectionRequirement.provider
    );
  }
  if (input.connectionRequirement.kind === "computer") {
    return (
      connection.connectionKind === "computer" &&
      connection.definitionId === input.connectionRequirement.definitionId
    );
  }
  return (
    connection.connectionKind === "mcp-oauth" && connection.integrationServerId === input.serverId
  );
}

function providerFor(requirement: IntegrationConnectionRequirement): IntegrationProvider | null {
  return requirement.kind === "provider" ? requirement.provider : null;
}
