import {
  ComputerAppIdentitySchema,
  agentGrantAccess,
  isPhoneDisplayDefinitionId,
  type AgentGrant,
  type AgentGrantTarget,
  type ResourceAccessLevel,
} from "@opensteer/core";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";

/**
 * The grant identity of one owner approval row: a Mac app or phone screen is a `computer-app`
 * pinned to the row, its Device and the app's signer; any other row is one device data account.
 */
export function integrationConnectionGrantTarget(row: {
  readonly id: string;
  readonly deviceId: string | null;
  readonly computerApp: unknown;
  readonly integrationDefinitionId: string | null;
}): AgentGrantTarget {
  if (row.deviceId && isPhoneDisplayDefinitionId(row.integrationDefinitionId))
    return {
      kind: "computer-app",
      approvalId: row.id,
      deviceId: row.deviceId,
      app: { kind: "phone-screen", definitionId: row.integrationDefinitionId },
    };
  const app = ComputerAppIdentitySchema.safeParse(row.computerApp);
  if (row.deviceId && app.success)
    return {
      kind: "computer-app",
      approvalId: row.id,
      deviceId: row.deviceId,
      app: { kind: "mac-app", bundleId: app.data.bundleId, teamId: app.data.teamId },
    };
  return { kind: "plugin", target: { kind: "device-account", integrationConnectionId: row.id } };
}

/** Resolves grant ceilings for integration connection rows, at most one read. */
export async function integrationConnectionGrantAccess(
  database: Kysely<DatabaseSchema>,
  grant: AgentGrant,
  connectionIds: readonly string[],
): Promise<ReadonlyMap<string, ResourceAccessLevel | null>> {
  const ids = [...new Set(connectionIds)];
  if (grant.scope === "everything" || !ids.length)
    return new Map(ids.map((id) => [id, grant.scope === "everything" ? "read-write" : null]));
  const rows = await database
    .selectFrom("integrationConnections")
    .select(["id", "deviceId", "computerApp", "integrationDefinitionId"])
    .where("id", "in", ids as never)
    .execute();
  return new Map(
    ids.map((id) => {
      const row = rows.find((candidate) => candidate.id === id);
      return [id, row ? agentGrantAccess(grant, integrationConnectionGrantTarget(row)) : null];
    }),
  );
}

/** A local MCP server's grant ceiling. */
export function localServerGrantAccess(
  grant: AgentGrant,
  serverId: string,
): ResourceAccessLevel | null {
  return agentGrantAccess(grant, {
    kind: "plugin",
    target: { kind: "local-server", serverId },
  });
}
