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
  const targets = await integrationConnectionGrantTargets(database, ids);
  return new Map(ids.map((id) => {
    const target = targets.get(id);
    return [id, target ? agentGrantAccess(grant, target) : null];
  }));
}

export async function integrationConnectionGrantTargets(
  database: Kysely<DatabaseSchema>,
  ids: readonly string[],
): Promise<ReadonlyMap<string, AgentGrantTarget>> {
  if (!ids.length) return new Map();
  const rows = await database
    .selectFrom("integrationConnections")
    .select(["id", "deviceId", "computerApp", "integrationDefinitionId"])
    .where("id", "in", ids as never)
    .execute();
  return new Map(rows.map((row) => [row.id, integrationConnectionGrantTarget(row)]));
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

/** What stands in for a place the grant does not reach, so the agent knows one was left out. */
export const ungrantedPlaceText =
  "[A place outside what this connected agent may use was left out.]";

/**
 * A selected grant's view of message content: every place it does not reach (a browser page in
 * another profile, an app or phone screen it was not given) is replaced by a short note.
 */
export async function grantedContent<Part extends { readonly type: string }>(
  database: Kysely<DatabaseSchema>,
  grant: AgentGrant,
  parts: readonly Part[],
): Promise<(Part | { readonly type: "text"; readonly text: string })[]> {
  if (grant.scope === "everything") return [...parts];
  return Promise.all(
    parts.map(async (part) =>
      (await placeGranted(database, grant, part))
        ? part
        : { type: "text", text: ungrantedPlaceText },
    ),
  );
}
async function placeGranted(
  database: Kysely<DatabaseSchema>,
  grant: AgentGrant,
  part: { readonly type: string },
): Promise<boolean> {
  if (part.type === "browser-page") {
    const { sessionId } = part as unknown as { readonly sessionId: string };
    const row = await database
      .selectFrom("browserSessions")
      .select("profileId")
      .where("id", "=", sessionId as never)
      .executeTakeFirst();
    return Boolean(
      row?.profileId &&
      agentGrantAccess(grant, { kind: "browser-profile", profileId: row.profileId }),
    );
  }
  if (part.type !== "computer-app" && part.type !== "phone") return true;
  const place = part as unknown as {
    readonly machineId: string;
    readonly app?: { readonly bundleId: string };
  };
  const rows = await database
    .selectFrom("integrationConnections")
    .select(["id", "deviceId", "computerApp", "integrationDefinitionId"])
    .where("connectionKind", "=", "computer")
    .where("deviceId", "=", place.machineId as never)
    .where("status", "!=", "revoked")
    .execute();
  return rows.some((row) => {
    const target = integrationConnectionGrantTarget(row);
    if (target.kind !== "computer-app") return false;
    const matches =
      part.type === "phone"
        ? target.app.kind === "phone-screen"
        : target.app.kind === "mac-app" &&
          target.app.bundleId.toLowerCase() === place.app?.bundleId.toLowerCase();
    return matches && agentGrantAccess(grant, target) !== null;
  });
}
