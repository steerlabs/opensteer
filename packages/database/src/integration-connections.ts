import { sql } from "kysely";
import { DeviceIdSchema, type DeviceId, type UserId } from "@opensteer/core";
import {
  DeviceIntegrationConnectionSummarySchema,
  type DeviceIntegrationConnectionSummary,
} from "@opensteer/integration-core/models";
import type { Kysely, Selectable } from "kysely";
import type { DatabaseSchema, IntegrationConnectionTable } from "./schema.js";

/** An owner's computer apps and phones, newest first, as every surface lists them. */
export async function listIntegrationConnections(
  database: Kysely<DatabaseSchema>,
  ownerUserId: UserId,
  deviceIds?: readonly DeviceId[],
): Promise<readonly DeviceIntegrationConnectionSummary[]> {
  if (deviceIds?.length === 0) return [];
  let query = database
    .selectFrom("integrationConnections")
    .selectAll()
    .where("ownerUserId", "=", ownerUserId)
    .where("connectionKind", "=", "computer")
    .where("status", "!=", "revoked")
    .orderBy("updatedAt", "desc");
  if (deviceIds) query = query.where(computerConnectionDeviceId, "in", [...deviceIds]);
  const rows = await query.limit(500).execute();
  return rows.map(integrationConnectionFromRow);
}

export function integrationConnectionFromRow(
  row: Selectable<IntegrationConnectionTable>,
): DeviceIntegrationConnectionSummary {
  const deviceId =
    row.deviceId ??
    (row.connectionKind === "computer" && row.runnerId ? DeviceIdSchema.parse(row.runnerId) : null);
  return DeviceIntegrationConnectionSummarySchema.parse({
    accountIdentifier: row.accountIdentifier,
    computer:
      row.connectionKind === "computer" && row.computerAccess && deviceId
        ? {
            access: row.computerAccess,
            app: row.computerApp,
            deviceId,
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

export const computerConnectionDeviceId = sql<DeviceId | null>`case when integration_connections.connection_kind='computer' then coalesce(integration_connections.device_id,integration_connections.runner_id) end`;
