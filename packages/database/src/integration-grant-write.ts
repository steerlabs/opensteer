import { OpensteerError, type UserId, type WorkspaceId } from "@opensteer/core";
import {
  IntegrationApplicationSourceSchema,
  IntegrationConnectionRequirementSchema,
  IntegrationGrantSchema,
  createIntegrationId,
  providerAuthorizationIncludesSource,
  type IntegrationAccess,
  type IntegrationConnectionId,
  type IntegrationGrant,
  type IntegrationInstallationId,
  type IntegrationProviderAuthorization,
} from "@opensteer/integration-core";
import { sql, type Selectable, type Transaction } from "kysely";
import type { DatabaseSchema, IntegrationGrantTable } from "./schema.js";

export interface CreateIntegrationGrantInput {
  readonly access: IntegrationAccess;
  readonly alias: string;
  readonly connectionId: IntegrationConnectionId | null;
  readonly createdBy: UserId;
  readonly installationId: IntegrationInstallationId;
  readonly isDefault: boolean;
  readonly ownerUserId: UserId;
  readonly providerAuthorizations: Readonly<Record<string, IntegrationProviderAuthorization>>;
  readonly workspaceId: WorkspaceId;
}

export function integrationGrantFromRow(row: Selectable<IntegrationGrantTable>): IntegrationGrant {
  return IntegrationGrantSchema.parse({
    access: row.access,
    alias: row.alias,
    connectionId: row.connectionId,
    createdAt: row.createdAt.toISOString(),
    id: row.id,
    installationId: row.installationId,
    isDefault: row.isDefault,
    ownerUserId: row.ownerUserId,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    status: row.status,
    workspaceId: row.workspaceId,
  });
}

/**
 * Serialises every grant write for one person, Workspace and installation.
 *
 * Postgres advisory locks are re-entrant within a session, so a caller that
 * reads a grant before deciding what to write may take this first and still
 * call `writeIntegrationGrantInTransaction`, which takes it again.
 */
export async function lockIntegrationGrantScopeInTransaction(
  transaction: Transaction<DatabaseSchema>,
  scope: {
    readonly installationId: IntegrationInstallationId;
    readonly ownerUserId: UserId;
    readonly workspaceId: WorkspaceId;
  },
): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${[
    "integration-grant",
    scope.ownerUserId,
    scope.workspaceId,
    scope.installationId,
  ].join(":")}, 0))`.execute(transaction);
}

/**
 * Creates the grant, or replaces the access and alias of the active one for
 * the same connection. This is the explicit edit, so it may lower access;
 * a path that must never lower one reads the active grant first.
 */
export async function writeIntegrationGrantInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: CreateIntegrationGrantInput,
): Promise<IntegrationGrant> {
  await lockIntegrationGrantScopeInTransaction(transaction, input);
  const membership = await transaction
    .selectFrom("workspaceMemberships")
    .select(["state"])
    .where("workspaceId", "=", input.workspaceId)
    .where("userId", "=", input.ownerUserId)
    .executeTakeFirst();
  if (!membership || membership.state !== "active") throw forbidden("Workspace access is required");
  if (input.createdBy !== input.ownerUserId)
    throw forbidden("A user may grant only their own connection");
  const installation = await transaction
    .selectFrom("integrationInstallations")
    .select(["status"])
    .where("id", "=", input.installationId)
    .executeTakeFirst();
  if (!installation || installation.status !== "active") {
    throw new OpensteerError({ code: "conflict", message: "Integration is not active" });
  }
  const servers = await transaction
    .selectFrom("integrationServers")
    .select(["connectionRequirement", "id"])
    .where("installationId", "=", input.installationId)
    .where("status", "=", "active")
    .execute();
  if (input.connectionId) {
    const connection = await transaction
      .selectFrom("integrationConnections")
      .select([
        "applicationSource",
        "connectionKind",
        "integrationDefinitionId",
        "integrationServerId",
        "ownerUserId",
        "provider",
        "providerApplicationId",
        "status",
      ])
      .where("id", "=", input.connectionId)
      .executeTakeFirst();
    if (
      !connection ||
      connection.ownerUserId !== input.ownerUserId ||
      connection.status !== "connected"
    ) {
      throw forbidden("The selected integration connection is unavailable");
    }
    const providerApplicationSourceActive =
      connection.connectionKind === "provider-account"
        ? await providerConnectionApplicationSourceActive(
            transaction,
            connection,
            input.providerAuthorizations[connection.provider] ?? null,
          )
        : false;
    const compatible = servers.some((server) => {
      const requirement = IntegrationConnectionRequirementSchema.parse(
        server.connectionRequirement,
      );
      if (requirement.kind === "mcp-oauth") {
        return (
          connection.connectionKind === "mcp-oauth" && connection.integrationServerId === server.id
        );
      }
      if (requirement.kind === "computer") {
        return (
          connection.connectionKind === "computer" &&
          connection.integrationDefinitionId === requirement.definitionId &&
          connection.integrationServerId === server.id
        );
      }
      return (
        requirement.kind === "provider" &&
        connection.connectionKind === "provider-account" &&
        connection.integrationDefinitionId === requirement.definitionId &&
        connection.provider === requirement.provider &&
        (!requirement.providerApplicationRequired || providerApplicationSourceActive)
      );
    });
    if (!compatible) {
      throw new OpensteerError({
        code: "bad_request",
        message: "The selected account is not compatible with this integration",
      });
    }
  }
  if (input.isDefault) {
    await transaction
      .updateTable("integrationGrants")
      .set({ isDefault: false, updatedAt: new Date() })
      .where("workspaceId", "=", input.workspaceId)
      .where("ownerUserId", "=", input.ownerUserId)
      .where("installationId", "=", input.installationId)
      .where("revokedAt", "is", null)
      .execute();
  }
  const now = new Date();
  const existing = await activeIntegrationGrantInTransaction(transaction, input);
  const row = existing
    ? await transaction
        .updateTable("integrationGrants")
        .set({
          access: input.access,
          alias: input.alias,
          isDefault: input.isDefault,
          status: "active",
          updatedAt: now,
        })
        .where("id", "=", existing.id)
        .returningAll()
        .executeTakeFirstOrThrow()
    : await transaction
        .insertInto("integrationGrants")
        .values({
          access: input.access,
          alias: input.alias,
          connectionId: input.connectionId,
          createdBy: input.createdBy,
          id: createIntegrationId("grant"),
          installationId: input.installationId,
          isDefault: input.isDefault,
          ownerUserId: input.ownerUserId,
          revokedAt: null,
          status: "active",
          updatedAt: now,
          workspaceId: input.workspaceId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
  return integrationGrantFromRow(row);
}

/** The one active grant a Workspace holds on one connection of one installation. */
export async function activeIntegrationGrantInTransaction(
  transaction: Transaction<DatabaseSchema>,
  scope: {
    readonly connectionId: IntegrationConnectionId | null;
    readonly installationId: IntegrationInstallationId;
    readonly ownerUserId: UserId;
    readonly workspaceId: WorkspaceId;
  },
): Promise<Selectable<IntegrationGrantTable> | undefined> {
  return transaction
    .selectFrom("integrationGrants")
    .selectAll()
    .where("workspaceId", "=", scope.workspaceId)
    .where("ownerUserId", "=", scope.ownerUserId)
    .where("installationId", "=", scope.installationId)
    .where(sql<boolean>`connection_id is not distinct from ${scope.connectionId}`)
    .where("revokedAt", "is", null)
    .forNoKeyUpdate()
    .executeTakeFirst();
}

async function providerConnectionApplicationSourceActive(
  transaction: Transaction<DatabaseSchema>,
  connection: {
    readonly applicationSource: unknown;
    readonly provider: string;
    readonly providerApplicationId: string | null;
  },
  providerAuthorization: IntegrationProviderAuthorization | null,
): Promise<boolean> {
  const parsed = IntegrationApplicationSourceSchema.safeParse(connection.applicationSource);
  if (!parsed.success) return false;
  const source = parsed.data;
  if (source.kind === "hosted-oauth") {
    return (
      connection.providerApplicationId === null &&
      providerAuthorizationIncludesSource(providerAuthorization, source)
    );
  }
  if (source.kind !== "deployment-oauth") return false;
  if (!providerAuthorizationIncludesSource(providerAuthorization, source)) return false;
  if (connection.providerApplicationId !== source.providerApplicationId) return false;
  const application = await transaction
    .selectFrom("integrationProviderApplications")
    .select("id")
    .where("id", "=", source.providerApplicationId)
    .where("provider", "=", connection.provider)
    .where("revision", "=", source.providerApplicationRevision)
    .where("status", "=", "active")
    .executeTakeFirst();
  return application !== undefined;
}

function forbidden(message: string): OpensteerError {
  return new OpensteerError({ code: "forbidden", message });
}
