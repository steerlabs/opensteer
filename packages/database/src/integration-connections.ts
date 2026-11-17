import type { UserId } from "@opensteer/core";
import {
  IntegrationConnectionSummarySchema,
  type IntegrationConnectionSummary,
} from "@opensteer/integration-core/models";
import type { Kysely, Selectable } from "kysely";
import type { DatabaseSchema, IntegrationConnectionTable } from "./schema.js";

/** An owner's computer apps and phones, newest first, as every surface lists them. */
export async function listIntegrationConnections(
  database: Kysely<DatabaseSchema>,
  ownerUserId: UserId,
): Promise<readonly IntegrationConnectionSummary[]> {
  const rows = await database
    .selectFrom("integrationConnections")
    .selectAll()
    .where("ownerUserId", "=", ownerUserId)
    .where("connectionKind", "=", "computer")
    .where("status", "!=", "revoked")
    .orderBy("updatedAt", "desc")
    .limit(500)
    .execute();
  return rows.map(integrationConnectionFromRow);
}

export function integrationConnectionFromRow(
  row: Selectable<IntegrationConnectionTable>,
): IntegrationConnectionSummary {
  return IntegrationConnectionSummarySchema.parse({
    accountIdentifier: row.accountIdentifier,
    computer:
      row.connectionKind === "computer" && row.computerAccess && row.runnerId
        ? {
            access: row.computerAccess,
            app: row.computerApp,
            runnerId: row.runnerId,
            blockedAt: row.computerBlockedAt?.toISOString() ?? null,
            policyRevision: row.computerPolicyRevision,
          }
        : null,
    connectionMethod: row.connectionMethod,
    createdAt: row.createdAt.toISOString(),
    definitionId: row.integrationDefinitionId,
    displayName: row.displayName,
    externalIdentityId: row.externalIdentityId,
    externalTenantId: row.externalTenantId,
    id: row.id,
    provider: row.provider,
    status: row.status,
    statusDetail: row.statusDetail,
    statusReason: row.statusReason,
    updatedAt: row.updatedAt.toISOString(),
  });
}
