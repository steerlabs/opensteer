import { intersectResourceAccess, type ThreadAccessMode, type UserId } from "@opensteer/core";
import {
  type IntegrationConnectionId,
  type IntegrationInstallationId,
  type IntegrationServerId,
} from "./ids.js";
import type {
  IntegrationAccess,
  IntegrationConnectionRequirement,
  IntegrationGrant,
  IntegrationInstallation,
  IntegrationTool,
} from "./models.js";
import { accessCoversEffect, integrationToolEffect } from "./effect.js";
import {
  isIntegrationConnectionEligible,
  type IntegrationConnectionAuthority,
} from "./readiness.js";

export type EffectiveIntegrationGrant = IntegrationGrant;

export interface EffectiveGrantConnection extends IntegrationConnectionAuthority {
  /** The maximum authority a computer connection can lend, independent of personal consent. */
  readonly computerAccess: IntegrationAccess | null;
  readonly displayName: string;
  readonly id: IntegrationConnectionId;
  readonly ownerUserId: UserId;
}

export interface EffectiveGrantTool extends IntegrationTool {
  readonly connectionRequirement: IntegrationConnectionRequirement;
  readonly installationId: IntegrationInstallationId;
  readonly serverStatus: "active" | "disabled" | "needs-attention";
}

export interface ResolveEffectiveGrantsInput {
  readonly connections: readonly EffectiveGrantConnection[];
  readonly installations: readonly IntegrationInstallation[];
  readonly ownerUserId: UserId;
  readonly storedGrants: readonly IntegrationGrant[];
  readonly tools: readonly EffectiveGrantTool[];
}

export interface ResolvedEffectiveGrantTool {
  readonly grant: EffectiveIntegrationGrant;
  readonly tool: EffectiveGrantTool;
}

export interface ResolvedEffectiveGrants {
  readonly tools: readonly ResolvedEffectiveGrantTool[];
}

/** Resolve only explicit personal consent from one consistent inventory view. */
export function resolveEffectiveGrants(
  input: ResolveEffectiveGrantsInput,
): ResolvedEffectiveGrants {
  return resolveStoredGrants(
    input,
    input.storedGrants.filter(
      ({ status, ownerUserId }) => status === "active" && ownerUserId === input.ownerUserId,
    ),
  );
}

function resolveStoredGrants(
  input: ResolveEffectiveGrantsInput,
  activeGrants: readonly IntegrationGrant[],
): ResolvedEffectiveGrants {
  const connectionById = new Map(
    input.connections
      .filter((connection) => connection.ownerUserId === input.ownerUserId)
      .map((connection) => [connection.id, connection]),
  );
  const installationById = new Map(
    input.installations.map((installation) => [installation.id, installation]),
  );
  const tools: ResolvedEffectiveGrantTool[] = [];

  for (const grant of activeGrants) {
    const installation = installationById.get(grant.installationId);
    if (!installation) continue;
    const connection = grant.connectionId ? (connectionById.get(grant.connectionId) ?? null) : null;
    const access = effectiveIntegrationAccess(grant.access, connection);
    if (access === null) continue;
    const effectiveGrant = access === grant.access ? grant : { ...grant, access };
    for (const tool of input.tools) {
      if (
        installation.status !== "active" ||
        tool.installationId !== grant.installationId ||
        tool.serverStatus !== "active" ||
        tool.status !== "active" ||
        !accessCoversEffect(effectiveGrant.access, integrationToolEffect(tool.annotations)) ||
        !toolAuthorityIsCurrent(tool, connection)
      )
        continue;
      tools.push({ grant: effectiveGrant, tool });
    }
  }
  return { tools };
}

function toolAuthorityIsCurrent(
  tool: EffectiveGrantTool,
  connection: IntegrationConnectionAuthority | null,
): boolean {
  if (tool.connectionRequirement.kind === "none") {
    return connection === null && tool.connectionId === null;
  }
  if (!connection) return false;
  if (
    (tool.connectionRequirement.kind === "computer" ||
      tool.connectionRequirement.kind === "mcp-oauth") &&
    tool.connectionId === null
  )
    return false;
  if (tool.connectionId !== null && tool.connectionId !== connection.id) return false;
  return isIntegrationConnectionEligible({
    connection,
    connectionRequirement: tool.connectionRequirement,
    serverId: tool.serverId as IntegrationServerId,
  });
}

/** Applies a connection ceiling after personal consent so every consumer sees the same access. */
export function effectiveIntegrationAccess(
  access: IntegrationAccess,
  connection: Pick<EffectiveGrantConnection, "computerAccess" | "connectionKind"> | null,
): IntegrationAccess | null {
  return intersectResourceAccess(
    access,
    connection?.connectionKind === "computer" ? connection.computerAccess : undefined,
  );
}

export function integrationAccessCeilingForRun(mode: ThreadAccessMode): IntegrationAccess {
  return mode === "full-access" || mode === "auto" ? "read-write" : "read";
}
