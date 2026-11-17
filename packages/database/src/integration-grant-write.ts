import { assertPersonalOwner } from "./private-resource-owner.js";
import { OpensteerError, type UserId } from "@opensteer/core";
import {
  IntegrationConnectionRequirementSchema,
  IntegrationGrantSchema,
  type IntegrationGrant,
} from "@opensteer/integration-core/models";
import {
  createIntegrationId,
  type IntegrationConnectionId,
  type IntegrationInstallationId,
} from "@opensteer/integration-core/ids";
import { type IntegrationAccess } from "@opensteer/integration-core/access";
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
  });
}

/**
 * Serialises every grant write for one person and installation.
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
  },
): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${[
    "integration-grant",
    scope.ownerUserId,
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
  await validateIntegrationGrantInTransaction(transaction, input);
  if (input.isDefault) {
    await transaction
      .selectFrom("integrationGrants")
      .select("id")
      .where("ownerUserId", "=", input.ownerUserId)
      .where("installationId", "=", input.installationId)
      .where("revokedAt", "is", null)
      .orderBy("id", "asc")
      .forNoKeyUpdate()
      .execute();
    await transaction
      .updateTable("integrationGrants")
      .set({ isDefault: false, updatedAt: new Date() })
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
        })
        .returningAll()
        .executeTakeFirstOrThrow();
  return integrationGrantFromRow(row);
}

/** Checks consent without creating or replacing a grant. */
export async function validateIntegrationGrantInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: CreateIntegrationGrantInput,
): Promise<void> {
  await assertPersonalOwner(transaction, input.ownerUserId);
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
        "connectionKind",
        "integrationDefinitionId",
        "integrationServerId",
        "ownerUserId",
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
    const compatible = servers.some((server) => {
      const requirement = IntegrationConnectionRequirementSchema.parse(
        server.connectionRequirement,
      );
      return (
        requirement.kind === "computer" &&
        connection.connectionKind === "computer" &&
        connection.integrationDefinitionId === requirement.definitionId &&
        connection.integrationServerId === server.id
      );
    });
    if (!compatible) {
      throw new OpensteerError({
        code: "bad_request",
        message: "The selected account is not compatible with this integration",
      });
    }
  }
}

/** The one active grant a person holds on one connection of one installation. */
export async function activeIntegrationGrantInTransaction(
  transaction: Transaction<DatabaseSchema>,
  scope: {
    readonly connectionId: IntegrationConnectionId | null;
    readonly installationId: IntegrationInstallationId;
    readonly ownerUserId: UserId;
  },
): Promise<Selectable<IntegrationGrantTable> | undefined> {
  return transaction
    .selectFrom("integrationGrants")
    .selectAll()
    .where("ownerUserId", "=", scope.ownerUserId)
    .where("installationId", "=", scope.installationId)
    .where(sql<boolean>`connection_id is not distinct from ${scope.connectionId}`)
    .where("revokedAt", "is", null)
    .forNoKeyUpdate()
    .executeTakeFirst();
}

function forbidden(message: string): OpensteerError {
  return new OpensteerError({ code: "forbidden", message });
}
