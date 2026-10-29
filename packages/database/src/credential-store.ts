import { withDatabaseTransaction } from "./connection.js";
import {
  type CredentialId,
  type UserId,
  type RunnerId,
  OpensteerError,
  createId,
} from "@opensteer/core";
import { type Kysely } from "kysely";
import { type DatabaseSchema } from "./schema.js";
import {
  type IntegrationConnectionId,
  type ChannelTransportKind,
  ChannelTransportKindSchema,
} from "@opensteer/channel-core";

export interface CredentialRecord {
  readonly encryptedPayload: Buffer;
  readonly encryptionKeyVersion: number;
  readonly id: CredentialId;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly name: string;
  readonly ownerId: UserId;
  readonly provider: string;
}

export async function credentialVaultCanary(
  database: Kysely<DatabaseSchema>,
  keyVersion: number,
): Promise<{ readonly encryptedPayload: Buffer; readonly keyVersion: number } | null> {
  return (
    (await database
      .selectFrom("credentialVaultCanaries")
      .select(["encryptedPayload", "keyVersion"])
      .where("keyVersion", "=", keyVersion)
      .executeTakeFirst()) ?? null
  );
}

export async function createCredentialVaultCanary(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly encryptedPayload: Buffer;
    readonly keyVersion: number;
  },
): Promise<void> {
  await database
    .insertInto("credentialVaultCanaries")
    .values(input)
    .onConflict((conflict) => conflict.column("keyVersion").doNothing())
    .executeTakeFirst();
}

export async function getCredential(
  database: Kysely<DatabaseSchema>,
  credentialId: CredentialId,
): Promise<CredentialRecord | null> {
  const row = await database
    .selectFrom("credentials")
    .select([
      "encryptedPayload",
      "encryptionKeyVersion",
      "id",
      "metadata",
      "name",
      "ownerId",
      "provider",
    ])
    .where("id", "=", credentialId)
    .executeTakeFirst();
  return row ?? null;
}

export async function channelCredentialForReplacement(
  database: Kysely<DatabaseSchema>,
  connectionId: IntegrationConnectionId,
  ownerId: UserId,
): Promise<{
  readonly credentialId: CredentialId;
  readonly name: string;
  readonly provider: string;
  readonly externalTenantId: string | null;
  readonly runnerId: RunnerId;
  readonly transportKind: ChannelTransportKind;
} | null> {
  const row = await database
    .selectFrom("integrationConnections")
    .innerJoin("credentials", "credentials.id", "integrationConnections.credentialId")
    .select([
      "credentials.id as credentialId",
      "credentials.name",
      "credentials.provider as credentialProvider",
      "integrationConnections.externalTenantId",
      "integrationConnections.runnerId",
      "integrationConnections.transportKind",
    ])
    .where("integrationConnections.id", "=", connectionId)
    .where("integrationConnections.ownerUserId", "=", ownerId)
    .where("integrationConnections.connectionKind", "=", "channel")
    .where("integrationConnections.status", "!=", "revoked")
    .executeTakeFirst();
  if (!row?.runnerId || !row.transportKind) return null;
  return {
    credentialId: row.credentialId,
    name: row.name,
    provider: row.credentialProvider,
    externalTenantId: row.externalTenantId,
    runnerId: row.runnerId,
    transportKind: ChannelTransportKindSchema.parse(row.transportKind),
  };
}

export async function replaceChannelCredential(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly connectionId: IntegrationConnectionId;
    readonly credentialId: CredentialId;
    readonly encryptedPayload: Buffer;
    readonly encryptionKeyVersion: number;
    readonly ownerId: UserId;
  },
): Promise<RunnerId> {
  return withDatabaseTransaction(database, async (transaction) => {
    const connection = await transaction
      .selectFrom("integrationConnections")
      .select(["runnerId", "credentialGeneration", "credentialId"])
      .where("id", "=", input.connectionId)
      .where("ownerUserId", "=", input.ownerId)
      .where("connectionKind", "=", "channel")
      .where("status", "!=", "revoked")
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!connection?.runnerId || connection.credentialId !== input.credentialId) {
      throw new OpensteerError({ code: "not_found", message: "Channel connection not found" });
    }
    const updated = await transaction
      .updateTable("credentials")
      .set({
        encryptedPayload: input.encryptedPayload,
        encryptionKeyVersion: input.encryptionKeyVersion,
        updatedAt: new Date(),
      })
      .where("id", "=", input.credentialId)
      .where("ownerId", "=", input.ownerId)
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) {
      throw new OpensteerError({ code: "not_found", message: "Channel credential not found" });
    }
    await transaction
      .updateTable("integrationConnections")
      .set({
        credentialGeneration: connection.credentialGeneration + 1,
        status: "pending",
        statusDetail: "Checking updated messaging credentials",
        statusReason: null,
        updatedAt: new Date(),
      })
      .where("id", "=", input.connectionId)
      .where("connectionKind", "=", "channel")
      .executeTakeFirstOrThrow();
    return connection.runnerId;
  });
}

export async function recordChannelCredentialAccess(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly runnerId: RunnerId;
    readonly connectionId: import("@opensteer/channel-core").IntegrationConnectionId;
    readonly credentialId: CredentialId;
    readonly purpose: "channel-delivery" | "channel-transport" | "channel-webhook";
  },
): Promise<void> {
  await database
    .insertInto("credentialAccessAudit")
    .values({
      actorId: input.runnerId,
      runnerId: input.runnerId,
      connectionId: input.connectionId,
      credentialId: input.credentialId,
      id: createId("event"),
      purpose: input.purpose,
    })
    .executeTakeFirstOrThrow();
}
