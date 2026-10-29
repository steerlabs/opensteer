import { createHash } from "node:crypto";
import type { UserId, WorkspaceId } from "@opensteer/core";
import {
  IntegrationGrantIdSchema,
  type IntegrationConnectionId,
  type IntegrationGrantId,
  type IntegrationInstallationId,
  type IntegrationServerId,
} from "./ids.js";
import type {
  IntegrationAccess,
  IntegrationConnectionRequirement,
  IntegrationGrant,
  IntegrationInstallation,
  IntegrationSkill,
  IntegrationTool,
} from "./models.js";
import { accessCoversEffect, integrationToolEffect } from "./effect.js";
import {
  isIntegrationConnectionEligible,
  type IntegrationConnectionAuthority,
} from "./readiness.js";

export interface InheritedMainIntegrationGrant {
  readonly access: IntegrationAccess;
  readonly alias: string;
  readonly connectionId: IntegrationConnectionId | null;
  readonly id: IntegrationGrantId;
  readonly installationId: IntegrationInstallationId;
  readonly isDefault: boolean;
  readonly ownerUserId: UserId;
  readonly source: "main-inherited";
  readonly workspaceId: WorkspaceId;
}

export type EffectiveIntegrationGrant = IntegrationGrant | InheritedMainIntegrationGrant;

export interface EffectiveGrantConnection extends IntegrationConnectionAuthority {
  /** The maximum authority a computer connection can lend, independent of a Workspace grant. */
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
  readonly inheritedMainAccess: boolean;
  readonly installations: readonly IntegrationInstallation[];
  readonly ownerUserId: UserId;
  readonly skills: readonly IntegrationSkill[];
  readonly storedGrants: readonly IntegrationGrant[];
  readonly tools: readonly EffectiveGrantTool[];
  readonly workspaceId: WorkspaceId;
}

export interface ResolvedEffectiveGrantSkill {
  readonly grant: EffectiveIntegrationGrant;
  readonly skill: IntegrationSkill;
}

export interface ResolvedEffectiveGrantTool {
  readonly grant: EffectiveIntegrationGrant;
  readonly tool: EffectiveGrantTool;
}

export interface ResolvedEffectiveGrants {
  readonly skills: readonly ResolvedEffectiveGrantSkill[];
  readonly tools: readonly ResolvedEffectiveGrantTool[];
}

/**
 * Resolves both explicit and inherited Main Workspace authority from immutable inventory rows.
 * Callers remain responsible for reading all rows from one consistent database view.
 */
export function resolveEffectiveGrants(
  input: ResolveEffectiveGrantsInput,
): ResolvedEffectiveGrants {
  const activeGrants = input.storedGrants.filter(({ status }) => status === "active");
  return input.inheritedMainAccess
    ? resolveInheritedMainGrants(input, activeGrants)
    : resolveStoredGrants(input, activeGrants);
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
  const skills: ResolvedEffectiveGrantSkill[] = [];
  const tools: ResolvedEffectiveGrantTool[] = [];

  for (const grant of activeGrants) {
    const installation = installationById.get(grant.installationId);
    if (!installation) continue;
    const connection = grant.connectionId ? (connectionById.get(grant.connectionId) ?? null) : null;
    const effectiveGrant = grantWithConnectionCeiling(grant, connection);
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
    for (const skill of input.skills) {
      if (skill.installationId === grant.installationId && skill.status === "active") {
        skills.push({ grant: effectiveGrant, skill });
      }
    }
  }
  return { skills, tools };
}

function resolveInheritedMainGrants(
  input: ResolveEffectiveGrantsInput,
  activeGrants: readonly IntegrationGrant[],
): ResolvedEffectiveGrants {
  const activeInstallations = input.installations.filter(({ status }) => status === "active");
  const activeInstallationById = new Map(
    activeInstallations.map((installation) => [installation.id, installation]),
  );
  const overlayByScope = new Map(
    activeGrants.map((grant) => [
      integrationAuthorityKey(grant.installationId, grant.connectionId),
      grant,
    ]),
  );
  const skills: ResolvedEffectiveGrantSkill[] = [];
  const tools: ResolvedEffectiveGrantTool[] = [];

  for (const tool of input.tools) {
    const installation = activeInstallationById.get(tool.installationId);
    if (!installation || tool.serverStatus !== "active" || tool.status !== "active") continue;
    if (tool.connectionRequirement.kind === "none" && tool.connectionId === null) {
      tools.push({
        grant: inheritedMainGrant({
          access: "read-write",
          alias:
            overlayByScope.get(integrationAuthorityKey(installation.id, null))?.alias ??
            installation.title,
          connectionId: null,
          installationId: installation.id,
          isDefault:
            overlayByScope.get(integrationAuthorityKey(installation.id, null))?.isDefault ?? false,
          ownerUserId: input.ownerUserId,
          workspaceId: input.workspaceId,
        }),
        tool,
      });
    }
    for (const connection of matchingUsableConnections(
      tool,
      input.connections,
      input.ownerUserId,
    )) {
      const overlay = overlayByScope.get(integrationAuthorityKey(installation.id, connection.id));
      const grant = inheritedMainGrant({
        access: effectiveIntegrationAccess("read-write", connection),
        alias: overlay?.alias ?? connection.displayName,
        connectionId: connection.id,
        installationId: installation.id,
        isDefault: overlay?.isDefault ?? false,
        ownerUserId: input.ownerUserId,
        workspaceId: input.workspaceId,
      });
      if (!accessCoversEffect(grant.access, integrationToolEffect(tool.annotations))) continue;
      tools.push({
        grant,
        tool,
      });
    }
  }

  for (const installation of activeInstallations) {
    const overlay = overlayByScope.get(integrationAuthorityKey(installation.id, null));
    const grant = inheritedMainGrant({
      access: "read-write",
      alias: overlay?.alias ?? installation.title,
      connectionId: null,
      installationId: installation.id,
      isDefault: overlay?.isDefault ?? false,
      ownerUserId: input.ownerUserId,
      workspaceId: input.workspaceId,
    });
    for (const skill of input.skills) {
      if (skill.installationId === installation.id && skill.status === "active") {
        skills.push({ grant, skill });
      }
    }
  }
  return { skills, tools };
}

function matchingUsableConnections(
  tool: EffectiveGrantTool,
  connections: readonly EffectiveGrantConnection[],
  ownerUserId: UserId,
): readonly EffectiveGrantConnection[] {
  return connections.filter((connection) => {
    if (connection.ownerUserId !== ownerUserId) return false;
    if (tool.connectionId && tool.connectionId !== connection.id) return false;
    if (
      (tool.connectionRequirement.kind === "computer" ||
        tool.connectionRequirement.kind === "mcp-oauth") &&
      tool.connectionId === null
    )
      return false;
    return toolAuthorityIsCurrent(tool, connection);
  });
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

function inheritedMainGrant(input: {
  readonly access: IntegrationAccess;
  readonly alias: string;
  readonly connectionId: IntegrationConnectionId | null;
  readonly installationId: IntegrationInstallationId;
  readonly isDefault: boolean;
  readonly ownerUserId: UserId;
  readonly workspaceId: WorkspaceId;
}): InheritedMainIntegrationGrant {
  return {
    access: input.access,
    alias: normalizedAuthorityAlias(input.alias),
    connectionId: input.connectionId,
    id: inheritedMainGrantId(input),
    installationId: input.installationId,
    isDefault: input.isDefault,
    ownerUserId: input.ownerUserId,
    source: "main-inherited",
    workspaceId: input.workspaceId,
  };
}

/** Applies a connection ceiling after Workspace authority so every consumer sees the same access. */
export function effectiveIntegrationAccess(
  access: IntegrationAccess,
  connection: Pick<EffectiveGrantConnection, "computerAccess" | "connectionKind"> | null,
): IntegrationAccess {
  return connection?.connectionKind === "computer" && connection.computerAccess === "read"
    ? "read"
    : access;
}

function grantWithConnectionCeiling(
  grant: IntegrationGrant,
  connection: EffectiveGrantConnection | null,
): IntegrationGrant {
  const access = effectiveIntegrationAccess(grant.access, connection);
  return access === grant.access ? grant : { ...grant, access };
}

function inheritedMainGrantId(input: {
  readonly connectionId: IntegrationConnectionId | null;
  readonly installationId: IntegrationInstallationId;
  readonly ownerUserId: UserId;
  readonly workspaceId: WorkspaceId;
}): IntegrationGrantId {
  const bytes = createHash("sha256")
    .update(
      [
        "opensteer-main-inherited-integration-v1",
        input.ownerUserId,
        input.workspaceId,
        input.installationId,
        input.connectionId ?? "connectionless",
      ].join("\0"),
      "utf8",
    )
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return IntegrationGrantIdSchema.parse(
    `igr_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}

function integrationAuthorityKey(
  installationId: IntegrationInstallationId,
  connectionId: IntegrationConnectionId | null,
): string {
  return `${installationId}\0${connectionId ?? "connectionless"}`;
}

function normalizedAuthorityAlias(value: string): string {
  const normalized = value.trim().slice(0, 80).trim();
  return normalized || "Default";
}
