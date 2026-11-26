import { sql, type Kysely } from "kysely";
import { randomUUID } from "node:crypto";
import type { DatabaseSchema } from "@opensteer/database";
import { machineAccessPolicyDefault } from "@opensteer/protocol";

/** One of the person's devices, as the Home stores it. */
export async function seedDevice(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly id: string;
    readonly ownerUserId: string;
    readonly name: string;
    readonly kind?: "computer" | "phone";
    readonly removedAt?: Date | null;
  },
) {
  const deployment = await database.selectFrom("deployments").select("id").executeTakeFirstOrThrow();
  const phone = input.kind === "phone";
  await database
    .insertInto("devices")
    .values({
      id: input.id as never,
      deploymentId: deployment.id,
      ownerKind: "user",
      ownerUserId: input.ownerUserId as never,
      name: input.name,
      kind: phone ? "phone" : "computer",
      platform: phone ? "ios" : "macos",
      form: phone ? "phone" : "laptop",
      accessPolicy: sql`${JSON.stringify({ ...machineAccessPolicyDefault, apps: true })}::jsonb`,
      accessPolicyRevision: 1,
      removedAt: input.removedAt ?? null,
    } as never)
    .onConflict((conflict) => conflict.doNothing())
    .execute();
}

/**
 * One approval the person made on a device (a Mac app or a phone screen), stored as the Home
 * stores it, with the installation and server it belongs to: what the one rule
 * (`grantedDeviceApprovals`) reads.
 */
export async function seedDeviceApproval(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly id: string;
    readonly ownerUserId: string;
    readonly deviceId: string;
    readonly name: string;
    /** A Mac app's identity; a phone screen names none. */
    readonly app?: { readonly bundleId: string; readonly displayName: string };
    readonly definitionId?: string;
    readonly status?: "connected" | "revoked";
    readonly blockedAt?: Date | null;
  },
) {
  const installationId = `iin_${randomUUID()}`;
  const serverId = `isv_${randomUUID()}`;
  const definitionId = input.definitionId ?? "macos-app";
  await database
    .insertInto("integrationInstallations")
    .values({
      id: installationId,
      name: `approval-${randomUUID()}`,
      title: input.name,
      description: "",
      sourceKind: "built-in",
      trust: "built-in",
      manifest: sql`'{}'::jsonb`,
      provenance: sql`'{}'::jsonb`,
      status: "active",
      revision: 1,
    } as never)
    .execute();
  await database
    .insertInto("integrationServers")
    .values({
      id: serverId,
      installationId,
      name: "device",
      transport: sql`'{"type":"in-process"}'::jsonb`,
      connectionRequirement: sql`${JSON.stringify({ kind: "computer", definitionId })}::jsonb`,
      status: "active",
      toolGeneration: 1,
    } as never)
    .execute();
  await database
    .insertInto("integrationConnections")
    .values({
      id: input.id,
      ownerUserId: input.ownerUserId,
      deviceId: input.deviceId,
      runnerId: null,
      connectionKind: "computer",
      computerAccess: "read-write",
      computerBlockedAt: input.blockedAt ?? null,
      computerApp: input.app
        ? sql`${JSON.stringify({ ...input.app, teamId: null })}::jsonb`
        : null,
      computerAppKey: input.app ? input.app.bundleId.toLowerCase() : null,
      provider: definitionId,
      integrationDefinitionId: definitionId,
      displayName: input.name,
      status: input.status ?? "connected",
      connectionMethod: "computer",
      capabilities: sql`'[]'::jsonb`,
      accountIdentifier: null,
      credentialId: null,
      integrationServerId: serverId,
      externalIdentityId: null,
      externalTenantId: null,
      statusDetail: null,
      transportKind: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never)
    .execute();
}
