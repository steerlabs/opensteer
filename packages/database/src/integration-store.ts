import { withDatabaseTransaction } from "./connection.js";
import { jsonValue } from "./store-primitives.js";
import {
  IntegrationConnectionSummarySchema,
  IntegrationProviderSchema,
  integrationProviderIdentityAlreadyConnectedDetail,
  type IntegrationConnectionId,
  type IntegrationConnectionSummary,
  type IntegrationOAuthApplicationSource,
  type IntegrationOAuthAttemptId,
  type IntegrationProvider,
  type IntegrationProviderApplication,
} from "@opensteer/integration-core";
import { OpensteerError, createId, type UserId } from "@opensteer/core";
import { erasedIntegrationAuthAttemptPayload } from "./integration-auth-attempt-store.js";
import { type Kysely, type Selectable, sql } from "kysely";
import type {
  DatabaseSchema,
  IntegrationConnectionTable,
  IntegrationProviderApplicationTable,
} from "./schema.js";

export interface StoredIntegrationSecret {
  readonly envelope: Buffer;
  readonly keyVersion: number;
}

export interface StoredIntegrationProviderApplication extends Omit<
  IntegrationProviderApplication,
  "availability" | "callbackUrl" | "canManage" | "configuredSecretFields"
> {
  readonly encryptedSecrets: Buffer;
  readonly encryptionKeyVersion: number;
}

export interface StoredIntegrationConnectionSecretRecord {
  readonly connection: IntegrationConnectionSummary;
  readonly credentialGeneration: number;
  readonly encryptedCredential: Buffer;
  readonly encryptionKeyVersion: number;
  readonly providerApplication: StoredIntegrationProviderApplication | null;
}

export class IntegrationStore {
  readonly #database: Kysely<DatabaseSchema>;

  constructor(database: Kysely<DatabaseSchema>) {
    this.#database = database;
  }

  async getProviderApplication(
    applicationId: import("@opensteer/integration-core").IntegrationProviderApplicationId,
  ): Promise<StoredIntegrationProviderApplication | null> {
    const row = await this.#database
      .selectFrom("integrationProviderApplications")
      .selectAll()
      .where("id", "=", applicationId)
      .executeTakeFirst();
    return row ? providerApplicationFromRow(row) : null;
  }

  async getSharedProviderApplication(
    provider: IntegrationProvider,
  ): Promise<StoredIntegrationProviderApplication | null> {
    const row = await this.#database
      .selectFrom("integrationProviderApplications")
      .selectAll()
      .where("provider", "=", provider)
      .where("ownerUserId", "is", null)
      .executeTakeFirst();
    return row ? providerApplicationFromRow(row) : null;
  }

  async listProviderApplications(
    ownerUserId: UserId,
  ): Promise<readonly StoredIntegrationProviderApplication[]> {
    const rows = await this.#database
      .selectFrom("integrationProviderApplications")
      .selectAll()
      .where((expression) =>
        expression.or([
          expression("ownerUserId", "is", null),
          expression("ownerUserId", "=", ownerUserId),
        ]),
      )
      .orderBy("provider", "asc")
      .orderBy("createdAt", "asc")
      .execute();
    return rows.map(providerApplicationFromRow);
  }

  async listApplicationSourceDefaults(): Promise<
    Readonly<Record<string, "deployment-oauth" | "hosted-oauth">>
  > {
    const rows = await this.#database
      .selectFrom("integrationApplicationSourceDefaults")
      .select(["provider", "sourceKind"])
      .execute();
    return Object.fromEntries(rows.map((row) => [row.provider, row.sourceKind]));
  }

  async setApplicationSourceDefault(input: {
    readonly actorUserId: UserId;
    readonly applicationSource: "deployment-oauth" | "hosted-oauth";
    readonly provider: IntegrationProvider;
    readonly requestId: string;
  }): Promise<void> {
    await withDatabaseTransaction(this.#database, async (transaction) => {
      await transaction
        .insertInto("integrationApplicationSourceDefaults")
        .values({
          provider: input.provider,
          sourceKind: input.applicationSource,
          updatedAt: new Date(),
          updatedBy: input.actorUserId,
        })
        .onConflict((conflict) =>
          conflict.column("provider").doUpdateSet({
            sourceKind: input.applicationSource,
            updatedAt: new Date(),
            updatedBy: input.actorUserId,
          }),
        )
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("securityAudit")
        .values({
          action: "integration.application-source-default.updated",
          actorSessionId: null,
          actorUserId: input.actorUserId,
          id: createId("securityAudit"),
          metadata: jsonValue({
            applicationSource: input.applicationSource,
            provider: input.provider,
          }),
          requestId: input.requestId,
          targetId: input.provider,
          targetType: "integration-application-source-default",
          workspaceId: null,
        })
        .executeTakeFirstOrThrow();
    });
  }

  async saveProviderApplication(input: {
    readonly application: Omit<
      IntegrationProviderApplication,
      | "availability"
      | "callbackUrl"
      | "canManage"
      | "configuredSecretFields"
      | "createdAt"
      | "revision"
      | "updatedAt"
    >;
    readonly actorUserId: UserId;
    readonly expectedRevision: number | null;
    readonly requestId: string;
    readonly secrets: StoredIntegrationSecret;
  }): Promise<StoredIntegrationProviderApplication> {
    return withDatabaseTransaction(this.#database, async (transaction) => {
      const lockKey = input.application.ownerUserId
        ? `integration-provider:personal:${input.application.ownerUserId}:${input.application.provider}`
        : `integration-provider:shared:${input.application.provider}`;
      await sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`.execute(transaction);
      const current = await transaction
        .selectFrom("integrationProviderApplications")
        .selectAll()
        .where("id", "=", input.application.id)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!current && input.application.ownerUserId === null) {
        const shared = await transaction
          .selectFrom("integrationProviderApplications")
          .select("id")
          .where("provider", "=", input.application.provider)
          .where("ownerUserId", "is", null)
          .executeTakeFirst();
        if (shared) {
          throw new OpensteerError({
            code: "conflict",
            message: "This provider already has a deployment OAuth application",
          });
        }
      }
      if (!current && input.application.ownerUserId !== null) {
        const existing = await transaction
          .selectFrom("integrationProviderApplications")
          .select(({ fn }) => fn.countAll<number>().as("count"))
          .where("ownerUserId", "=", input.application.ownerUserId)
          .where("provider", "=", input.application.provider)
          .executeTakeFirstOrThrow();
        if (Number(existing.count) >= 16) {
          throw new OpensteerError({
            code: "conflict",
            message: "A user may keep at most 16 OAuth applications for one provider",
          });
        }
      }
      if ((current?.revision ?? null) !== input.expectedRevision) {
        throw new OpensteerError({
          code: "conflict",
          message: "Provider application changed; reload before saving",
        });
      }
      if (
        current &&
        (current.provider !== input.application.provider ||
          current.ownerUserId !== input.application.ownerUserId)
      ) {
        throw new OpensteerError({
          code: "conflict",
          message: "Provider application ownership cannot be changed by saving",
        });
      }
      const now = new Date();
      const row = current
        ? await transaction
            .updateTable("integrationProviderApplications")
            .set({
              clientId: input.application.clientId,
              displayName: input.application.displayName,
              encryptedSecrets: input.secrets.envelope,
              encryptionKeyVersion: input.secrets.keyVersion,
              installationUrl: input.application.installationUrl ?? null,
              revision: current.revision + 1,
              status: input.application.status,
              updatedAt: now,
              updatedBy: input.actorUserId,
            })
            .where("id", "=", current.id)
            .where("revision", "=", current.revision)
            .returningAll()
            .executeTakeFirstOrThrow()
        : await transaction
            .insertInto("integrationProviderApplications")
            .values({
              clientId: input.application.clientId,
              createdBy: input.actorUserId,
              displayName: input.application.displayName,
              encryptedSecrets: input.secrets.envelope,
              encryptionKeyVersion: input.secrets.keyVersion,
              id: input.application.id,
              installationUrl: input.application.installationUrl ?? null,
              ownerUserId: input.application.ownerUserId,
              provider: input.application.provider,
              revision: 1,
              status: input.application.status,
              updatedAt: now,
              updatedBy: input.actorUserId,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
      await transaction
        .insertInto("securityAudit")
        .values({
          action: current
            ? "integration.provider-application.updated"
            : "integration.provider-application.created",
          actorSessionId: null,
          actorUserId: input.actorUserId,
          id: createId("securityAudit"),
          metadata: jsonValue({
            provider: input.application.provider,
            revision: row.revision,
          }),
          requestId: input.requestId,
          targetId: row.id,
          targetType: "integration-provider-application",
          workspaceId: null,
        })
        .executeTakeFirstOrThrow();
      return providerApplicationFromRow(row);
    });
  }

  async setProviderApplicationStatus(input: {
    readonly actorUserId: UserId;
    readonly applicationId: import("@opensteer/integration-core").IntegrationProviderApplicationId;
    readonly expectedRevision: number;
    readonly requestId: string;
    readonly status: "active" | "disabled";
  }): Promise<StoredIntegrationProviderApplication> {
    return withDatabaseTransaction(this.#database, async (transaction) => {
      const current = await transaction
        .selectFrom("integrationProviderApplications")
        .selectAll()
        .where("id", "=", input.applicationId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!current || current.revision !== input.expectedRevision) {
        throw new OpensteerError({
          code: "conflict",
          message: "Provider application changed; reload before saving",
        });
      }
      const row = await transaction
        .updateTable("integrationProviderApplications")
        .set({
          revision: current.revision + 1,
          status: input.status,
          updatedAt: new Date(),
          updatedBy: input.actorUserId,
        })
        .where("id", "=", current.id)
        .where("revision", "=", current.revision)
        .returningAll()
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("securityAudit")
        .values({
          action: `integration.provider-application.${input.status}`,
          actorSessionId: null,
          actorUserId: input.actorUserId,
          id: createId("securityAudit"),
          metadata: jsonValue({ provider: row.provider, revision: row.revision }),
          requestId: input.requestId,
          targetId: row.id,
          targetType: "integration-provider-application",
          workspaceId: null,
        })
        .executeTakeFirstOrThrow();
      return providerApplicationFromRow(row);
    });
  }

  async findReusableConnectionId(input: {
    readonly definitionId: string;
    readonly externalIdentityId: string;
    readonly externalTenantId: string | null;
    readonly ownerUserId: UserId;
    readonly provider: IntegrationProvider;
  }): Promise<IntegrationConnectionId | null> {
    const row = await this.#database
      .selectFrom("integrationConnections")
      .select(["id", "ownerUserId"])
      .where("connectionKind", "=", "provider-account")
      .where("integrationDefinitionId", "=", input.definitionId)
      .where("provider", "=", input.provider)
      .where(sql<boolean>`external_tenant_id is not distinct from ${input.externalTenantId}`)
      .where("externalIdentityId", "=", input.externalIdentityId)
      .where("status", "!=", "revoked")
      .executeTakeFirst();
    if (!row) return null;
    if (row.ownerUserId !== input.ownerUserId) {
      throw new OpensteerError({
        code: "conflict",
        message: integrationProviderIdentityAlreadyConnectedDetail,
      });
    }
    return row.id;
  }

  async getConnectionForRevocation(input: {
    readonly connectionId: IntegrationConnectionId;
    readonly ownerUserId: UserId;
  }): Promise<StoredIntegrationConnectionSecretRecord | null> {
    const row = await this.#database
      .selectFrom("integrationConnections")
      .innerJoin("credentials", "credentials.id", "integrationConnections.credentialId")
      .selectAll("integrationConnections")
      .select([
        "credentials.encryptedPayload as encryptedCredential",
        "credentials.encryptionKeyVersion",
      ])
      .where("integrationConnections.id", "=", input.connectionId)
      .where("integrationConnections.ownerUserId", "=", input.ownerUserId)
      .where("integrationConnections.connectionKind", "=", "provider-account")
      .where("integrationConnections.status", "!=", "revoked")
      .executeTakeFirst();
    if (!row) return null;
    const application = row.providerApplicationId
      ? await this.#database
          .selectFrom("integrationProviderApplications")
          .selectAll()
          .where("id", "=", row.providerApplicationId)
          .executeTakeFirst()
      : undefined;
    if (
      row.connectionMethod === "managed-oauth" &&
      row.applicationSource?.kind === "deployment-oauth" &&
      !application
    ) {
      return null;
    }
    return {
      connection: integrationConnectionFromRow(row),
      credentialGeneration: row.credentialGeneration,
      encryptedCredential: row.encryptedCredential,
      encryptionKeyVersion: row.encryptionKeyVersion,
      providerApplication: application ? providerApplicationFromRow(application) : null,
    };
  }

  async getConnectionForAccess(input: {
    readonly connectionId: IntegrationConnectionId;
    readonly ownerUserId: UserId;
  }): Promise<StoredIntegrationConnectionSecretRecord | null> {
    const record = await this.getConnectionForRevocation(input);
    if (!record || record.connection.status !== "connected") return null;
    if (record.connection.connectionMethod === "api-key") return record;
    if (
      record.connection.applicationSource?.kind === "hosted-oauth" &&
      record.connection.providerApplicationId === null
    ) {
      return record;
    }
    return record.connection.applicationSource?.kind === "deployment-oauth" &&
      record.providerApplication?.status === "active" &&
      record.providerApplication.provider === record.connection.provider &&
      record.providerApplication.id === record.connection.applicationSource.providerApplicationId &&
      record.providerApplication.revision ===
        record.connection.applicationSource.providerApplicationRevision
      ? record
      : null;
  }

  async replaceConnectionCredential(input: {
    readonly allowNeedsAttention?: boolean;
    readonly connectionId: IntegrationConnectionId;
    readonly credential: StoredIntegrationSecret;
    readonly expectedGeneration: number;
    readonly ownerUserId: UserId;
  }): Promise<boolean> {
    return withDatabaseTransaction(this.#database, async (transaction) => {
      const connection = await transaction
        .updateTable("integrationConnections")
        .set({
          credentialGeneration: input.expectedGeneration + 1,
          ...(input.allowNeedsAttention ? {} : { statusDetail: null }),
          updatedAt: new Date(),
        })
        .where("id", "=", input.connectionId)
        .where("ownerUserId", "=", input.ownerUserId)
        .where("connectionKind", "=", "provider-account")
        .where((expression) =>
          input.allowNeedsAttention
            ? expression.or([
                expression("status", "=", "connected"),
                expression.and([
                  expression("provider", "=", "github"),
                  expression("status", "=", "needs-attention"),
                ]),
              ])
            : expression("status", "=", "connected"),
        )
        .where("credentialGeneration", "=", input.expectedGeneration)
        .returning("credentialId")
        .executeTakeFirst();
      if (!connection?.credentialId) return false;
      await transaction
        .updateTable("credentials")
        .set({
          encryptedPayload: input.credential.envelope,
          encryptionKeyVersion: input.credential.keyVersion,
          updatedAt: new Date(),
        })
        .where("id", "=", connection.credentialId)
        .where("ownerId", "=", input.ownerUserId)
        .executeTakeFirstOrThrow();
      return true;
    });
  }

  async setConnectionRepositoryAccess(input: {
    readonly connectionId: IntegrationConnectionId;
    readonly expectedApplicationSource: IntegrationOAuthApplicationSource;
    readonly expectedGeneration: number;
    readonly expectedStatus: "connected" | "needs-attention";
    readonly expectedStatusDetail: string | null;
    readonly ownerUserId: UserId;
    readonly status: "connected" | "needs-attention";
    readonly statusDetail: string | null;
    readonly statusReason: "permissions" | null;
  }): Promise<boolean> {
    let update = this.#database
      .updateTable("integrationConnections")
      .set({
        status: input.status,
        statusDetail: input.statusDetail,
        statusReason: input.statusReason,
        updatedAt: new Date(),
      })
      .where("id", "=", input.connectionId)
      .where("ownerUserId", "=", input.ownerUserId)
      .where("connectionKind", "=", "provider-account")
      .where("provider", "=", "github")
      .where("applicationSource", "=", jsonValue(input.expectedApplicationSource))
      .where("credentialGeneration", "=", input.expectedGeneration)
      .where("status", "=", input.expectedStatus)
      .where(sql<boolean>`status_detail is not distinct from ${input.expectedStatusDetail}`);
    if (input.expectedApplicationSource.kind === "deployment-oauth") {
      const source = input.expectedApplicationSource;
      update = update.where(({ exists, selectFrom }) =>
        exists(
          selectFrom("integrationProviderApplications")
            .select("id")
            .where("id", "=", source.providerApplicationId)
            .where("provider", "=", "github")
            .where("revision", "=", source.providerApplicationRevision)
            .where("status", "=", "active"),
        ),
      );
    }
    const updated = await update.returning("id").executeTakeFirst();
    return updated !== undefined;
  }

  async markConnectionNeedsAttention(input: {
    readonly connectionId: IntegrationConnectionId;
    readonly expectedGeneration?: number;
    readonly ownerUserId: UserId;
    readonly statusDetail: string;
  }): Promise<void> {
    await withDatabaseTransaction(this.#database, async (transaction) => {
      const now = new Date();
      let update = transaction
        .updateTable("integrationConnections")
        .set({
          status: "needs-attention",
          statusDetail: input.statusDetail,
          statusReason: null,
          updatedAt: now,
        })
        .where("id", "=", input.connectionId)
        .where("ownerUserId", "=", input.ownerUserId)
        .where("connectionKind", "=", "provider-account")
        .where("status", "!=", "revoked");
      if (input.expectedGeneration !== undefined) {
        update = update.where("credentialGeneration", "=", input.expectedGeneration);
      }
      const connection = await update.returning("id").executeTakeFirst();
      if (!connection) return;
    });
  }

  async recordConnectionAccess(input: {
    readonly connectionId: IntegrationConnectionId;
    readonly operation: string;
    readonly ownerUserId: UserId;
  }): Promise<void> {
    await this.#database
      .insertInto("securityAudit")
      .values({
        action: "integration.connection.accessed",
        actorSessionId: null,
        actorUserId: input.ownerUserId,
        id: createId("securityAudit"),
        metadata: jsonValue({ operation: input.operation }),
        requestId: null,
        targetId: input.connectionId,
        targetType: "integration-connection",
        workspaceId: null,
      })
      .executeTakeFirstOrThrow();
  }

  async revokeConnection(input: {
    readonly connectionId: IntegrationConnectionId;
    readonly credential: StoredIntegrationSecret;
    readonly ownerUserId: UserId;
    readonly requestId: string;
  }): Promise<void> {
    await withDatabaseTransaction(this.#database, async (transaction) => {
      const now = new Date();
      const connection = await transaction
        .selectFrom("integrationConnections")
        .select(["credentialId", "id", "provider", "status"])
        .where("id", "=", input.connectionId)
        .where("ownerUserId", "=", input.ownerUserId)
        .where("connectionKind", "=", "provider-account")
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!connection || connection.status === "revoked") {
        throw new OpensteerError({
          code: "not_found",
          message: "Integration connection not found",
        });
      }
      if (!connection.credentialId) {
        throw new OpensteerError({
          code: "internal",
          message: "Integration credential is missing",
        });
      }
      await transaction
        .updateTable("credentials")
        .set({
          encryptedPayload: input.credential.envelope,
          encryptionKeyVersion: input.credential.keyVersion,
          metadata: jsonValue({ managedBy: "integration-service", status: "revoked" }),
          updatedAt: now,
        })
        .where("id", "=", connection.credentialId)
        .where("ownerId", "=", input.ownerUserId)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("integrationConnections")
        .set({ status: "revoked", statusDetail: null, statusReason: null, updatedAt: now })
        .where("id", "=", connection.id)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("integrationGrants")
        .set({ isDefault: false, revokedAt: now, status: "revoked", updatedAt: now })
        .where("connectionId", "=", connection.id)
        .where("revokedAt", "is", null)
        .execute();
      await transaction
        .insertInto("securityAudit")
        .values({
          action: "integration.connection.revoked",
          actorSessionId: null,
          actorUserId: input.ownerUserId,
          id: createId("securityAudit"),
          metadata: jsonValue({ provider: connection.provider }),
          requestId: input.requestId,
          targetId: connection.id,
          targetType: "integration-connection",
          workspaceId: null,
        })
        .executeTakeFirstOrThrow();
    });
  }

  async completeOAuthAttempt(input: {
    readonly attemptId: IntegrationOAuthAttemptId;
    readonly connection: Omit<IntegrationConnectionSummary, "createdAt" | "updatedAt">;
    readonly credential: StoredIntegrationSecret;
    readonly credentialProvider: string;
    readonly ownerUserId: UserId;
  }): Promise<IntegrationConnectionSummary> {
    return withDatabaseTransaction(this.#database, async (transaction) => {
      const attempt = await transaction
        .selectFrom("integrationAuthAttempts")
        .select(["id", "ownerUserId", "status"])
        .where("id", "=", input.attemptId)
        .where("flow", "=", "provider-oauth")
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!attempt || attempt.ownerUserId !== input.ownerUserId || attempt.status !== "claimed") {
        throw new OpensteerError({
          code: "conflict",
          message: "OAuth authorization is no longer claimable",
        });
      }
      const identityKey = JSON.stringify([
        "provider-account",
        input.connection.definitionId,
        input.connection.externalTenantId,
        input.connection.externalIdentityId,
      ]);
      await sql`select pg_advisory_xact_lock(hashtextextended(${identityKey}, 0))`.execute(
        transaction,
      );
      const existingIdentity = await transaction
        .selectFrom("integrationConnections")
        .select(["credentialId", "id", "ownerUserId"])
        .where("connectionKind", "=", "provider-account")
        .where("integrationDefinitionId", "=", input.connection.definitionId)
        .where("provider", "=", input.connection.provider)
        .where(
          sql<boolean>`external_tenant_id is not distinct from ${input.connection.externalTenantId}`,
        )
        .where("externalIdentityId", "=", input.connection.externalIdentityId)
        .where("status", "!=", "revoked")
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (
        existingIdentity &&
        (existingIdentity.id !== input.connection.id ||
          existingIdentity.ownerUserId !== input.ownerUserId)
      ) {
        throw new OpensteerError({
          code: "conflict",
          message: integrationProviderIdentityAlreadyConnectedDetail,
        });
      }

      const now = new Date();
      const credentialId = existingIdentity?.credentialId ?? createId("credential");
      if (existingIdentity?.credentialId) {
        await transaction
          .updateTable("credentials")
          .set({
            encryptedPayload: input.credential.envelope,
            encryptionKeyVersion: input.credential.keyVersion,
            metadata: jsonValue({
              definitionId: input.connection.definitionId,
              managedBy: "integration-service",
              providerApplicationId: input.connection.providerApplicationId,
            }),
            name: input.connection.displayName,
            provider: input.credentialProvider,
            updatedAt: now,
          })
          .where("id", "=", existingIdentity.credentialId)
          .where("ownerId", "=", input.ownerUserId)
          .executeTakeFirstOrThrow();
      } else {
        await transaction
          .insertInto("credentials")
          .values({
            encryptedPayload: input.credential.envelope,
            encryptionKeyVersion: input.credential.keyVersion,
            id: credentialId,
            metadata: jsonValue({
              definitionId: input.connection.definitionId,
              managedBy: "integration-service",
              providerApplicationId: input.connection.providerApplicationId,
            }),
            name: input.connection.displayName,
            ownerId: input.ownerUserId,
            provider: input.credentialProvider,
            updatedAt: now,
          })
          .executeTakeFirstOrThrow();
      }

      const connectionRow = existingIdentity
        ? await transaction
            .updateTable("integrationConnections")
            .set({
              accountIdentifier: input.connection.accountIdentifier,
              applicationSource: jsonValue(input.connection.applicationSource),
              authorizationDigest: input.connection.authorizationDigest,
              authMethodId: input.connection.authMethodId,
              connectionMethod: input.connection.connectionMethod,
              credentialGeneration: sql`credential_generation + 1`,
              credentialId,
              displayName: input.connection.displayName,
              externalIdentityId: input.connection.externalIdentityId,
              externalTenantId: input.connection.externalTenantId,
              grantedScopes: jsonValue(input.connection.grantedScopes),
              integrationDefinitionId: input.connection.definitionId,
              providerApplicationId: input.connection.providerApplicationId,
              status: input.connection.status,
              statusDetail: input.connection.statusDetail,
              statusReason: input.connection.statusReason,
              updatedAt: now,
            })
            .where("id", "=", input.connection.id as IntegrationConnectionId)
            .where("ownerUserId", "=", input.ownerUserId)
            .where("connectionKind", "=", "provider-account")
            .returningAll()
            .executeTakeFirstOrThrow()
        : await transaction
            .insertInto("integrationConnections")
            .values({
              accountIdentifier: input.connection.accountIdentifier,
              applicationSource: jsonValue(input.connection.applicationSource),
              authorizationDigest: input.connection.authorizationDigest,
              authMethodId: input.connection.authMethodId,
              capabilities: jsonValue([]),
              computerAccess: null,
              runnerId: null,
              connectionKind: "provider-account",
              connectionMethod: input.connection.connectionMethod,
              credentialId,
              displayName: input.connection.displayName,
              externalIdentityId: input.connection.externalIdentityId,
              externalTenantId: input.connection.externalTenantId,
              grantedScopes: jsonValue(input.connection.grantedScopes),
              id: input.connection.id as IntegrationConnectionId,
              integrationDefinitionId: input.connection.definitionId,
              ownerUserId: input.ownerUserId,
              provider: input.connection.provider,
              providerApplicationId: input.connection.providerApplicationId,
              status: input.connection.status,
              statusDetail: input.connection.statusDetail,
              statusReason: input.connection.statusReason,
              transportKind: null,
              updatedAt: now,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
      await transaction
        .updateTable("integrationAuthAttempts")
        .set({
          completedAt: now,
          encryptedPayload: erasedIntegrationAuthAttemptPayload,
          resultConnectionId: connectionRow.id,
          status: "completed",
        })
        .where("id", "=", input.attemptId)
        .where("status", "=", "claimed")
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("securityAudit")
        .values({
          action: existingIdentity
            ? "integration.connection.reconnected"
            : "integration.connection.created",
          actorSessionId: null,
          actorUserId: input.ownerUserId,
          id: createId("securityAudit"),
          metadata: jsonValue({ provider: input.connection.provider }),
          requestId: input.attemptId,
          targetId: connectionRow.id,
          targetType: "integration-connection",
          workspaceId: null,
        })
        .executeTakeFirstOrThrow();
      return integrationConnectionFromRow(connectionRow);
    });
  }

  async listConnections(ownerUserId: UserId): Promise<readonly IntegrationConnectionSummary[]> {
    const rows = await this.#database
      .selectFrom("integrationConnections")
      .selectAll()
      .where("ownerUserId", "=", ownerUserId)
      .where("connectionKind", "in", ["provider-account", "computer"])
      .where("status", "!=", "revoked")
      .orderBy("updatedAt", "desc")
      .limit(500)
      .execute();
    return rows.map(integrationConnectionFromRow);
  }

  async connectApiKey(input: {
    readonly connection: Omit<IntegrationConnectionSummary, "createdAt" | "updatedAt">;
    readonly credential: StoredIntegrationSecret;
    readonly credentialProvider: string;
    readonly ownerUserId: UserId;
    readonly reconnect: boolean;
    readonly requestId: string;
  }): Promise<IntegrationConnectionSummary> {
    return withDatabaseTransaction(this.#database, async (transaction) => {
      const identityKey = JSON.stringify([
        "provider-account",
        input.connection.definitionId,
        input.connection.externalTenantId,
        input.connection.externalIdentityId ?? input.connection.id,
      ]);
      await sql`select pg_advisory_xact_lock(hashtextextended(${identityKey}, 0))`.execute(
        transaction,
      );
      // The row this key lands on is the one the caller chose: matched by the
      // provider's account identity, or named by the owner to reconnect.
      const existing = await transaction
        .selectFrom("integrationConnections")
        .select([
          "connectionMethod",
          "credentialId",
          "externalIdentityId",
          "externalTenantId",
          "integrationDefinitionId",
          "ownerUserId",
          "provider",
          "status",
        ])
        .where("id", "=", input.connection.id)
        .where("connectionKind", "=", "provider-account")
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (
        (input.reconnect && !existing) ||
        (existing &&
          (existing.ownerUserId !== input.ownerUserId ||
            existing.integrationDefinitionId !== input.connection.definitionId ||
            existing.provider !== input.connection.provider ||
            existing.status === "revoked"))
      ) {
        throw new OpensteerError({
          code: "not_found",
          message: "This connection is no longer available to reconnect",
        });
      }
      if (input.reconnect && existing?.connectionMethod !== "api-key") {
        throw new OpensteerError({
          code: "conflict",
          message: "Only a connection made with a key can be reconnected with one",
        });
      }
      // A key never moves a connection to another account: grants and requests
      // that name the connection were given for the account it already holds,
      // so a connection that knows its account accepts only a key proving it.
      if (
        existing?.externalIdentityId &&
        (existing.externalIdentityId !== input.connection.externalIdentityId ||
          existing.externalTenantId !== input.connection.externalTenantId)
      ) {
        throw new OpensteerError({
          code: "conflict",
          message: "This key belongs to a different account than the connection it reconnects",
        });
      }
      const identityHolder = input.connection.externalIdentityId
        ? await transaction
            .selectFrom("integrationConnections")
            .select("id")
            .where("connectionKind", "=", "provider-account")
            .where("integrationDefinitionId", "=", input.connection.definitionId)
            .where("provider", "=", input.connection.provider)
            .where(
              sql<boolean>`external_tenant_id is not distinct from ${input.connection.externalTenantId}`,
            )
            .where("externalIdentityId", "=", input.connection.externalIdentityId)
            .where("status", "!=", "revoked")
            .where("id", "!=", input.connection.id)
            .executeTakeFirst()
        : undefined;
      if (identityHolder) {
        throw new OpensteerError({
          code: "conflict",
          message: integrationProviderIdentityAlreadyConnectedDetail,
        });
      }
      const now = new Date();
      const credentialId = existing?.credentialId ?? createId("credential");
      const credentialValues = {
        encryptedPayload: input.credential.envelope,
        encryptionKeyVersion: input.credential.keyVersion,
        metadata: jsonValue({
          authMethodId: input.connection.authMethodId,
          definitionId: input.connection.definitionId,
          managedBy: "integration-service",
        }),
        name: input.connection.displayName,
        provider: input.credentialProvider,
        updatedAt: now,
      };
      if (existing?.credentialId) {
        await transaction
          .updateTable("credentials")
          .set(credentialValues)
          .where("id", "=", existing.credentialId)
          .where("ownerId", "=", input.ownerUserId)
          .executeTakeFirstOrThrow();
      } else {
        await transaction
          .insertInto("credentials")
          .values({
            ...credentialValues,
            id: credentialId,
            ownerId: input.ownerUserId,
          })
          .executeTakeFirstOrThrow();
      }
      const values = {
        accountIdentifier: input.connection.accountIdentifier,
        applicationSource: jsonValue(input.connection.applicationSource),
        authMethodId: input.connection.authMethodId,
        authorizationDigest: input.connection.authorizationDigest,
        capabilities: jsonValue([]),
        connectionMethod: input.connection.connectionMethod,
        credentialId,
        displayName: input.connection.displayName,
        externalIdentityId: input.connection.externalIdentityId,
        externalTenantId: input.connection.externalTenantId,
        grantedScopes: jsonValue(input.connection.grantedScopes),
        integrationDefinitionId: input.connection.definitionId,
        providerApplicationId: null,
        status: input.connection.status,
        statusDetail: input.connection.statusDetail,
        statusReason: input.connection.statusReason,
        updatedAt: now,
      } as const;
      const row = existing
        ? await transaction
            .updateTable("integrationConnections")
            // The previous key's in-flight failures name the old generation.
            .set({ ...values, credentialGeneration: sql`credential_generation + 1` })
            .where("id", "=", input.connection.id)
            .where("ownerUserId", "=", input.ownerUserId)
            .where("connectionKind", "=", "provider-account")
            .returningAll()
            .executeTakeFirstOrThrow()
        : await transaction
            .insertInto("integrationConnections")
            .values({
              ...values,
              computerAccess: null,
              runnerId: null,
              connectionKind: "provider-account",
              id: input.connection.id,
              integrationServerId: null,
              ownerUserId: input.ownerUserId,
              provider: input.connection.provider,
              transportKind: null,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
      await transaction
        .insertInto("securityAudit")
        .values({
          action: existing
            ? "integration.connection.reconnected"
            : "integration.connection.created",
          actorSessionId: null,
          actorUserId: input.ownerUserId,
          id: createId("securityAudit"),
          metadata: jsonValue({
            connectionMethod: "api-key",
            provider: input.connection.provider,
          }),
          requestId: input.requestId,
          targetId: row.id,
          targetType: "integration-connection",
          workspaceId: null,
        })
        .executeTakeFirstOrThrow();
      return integrationConnectionFromRow(row);
    });
  }
}

function providerApplicationFromRow(
  row: Selectable<IntegrationProviderApplicationTable>,
): StoredIntegrationProviderApplication {
  return {
    clientId: row.clientId,
    createdAt: row.createdAt.toISOString(),
    displayName: row.displayName,
    encryptedSecrets: row.encryptedSecrets,
    encryptionKeyVersion: row.encryptionKeyVersion,
    id: row.id,
    installationUrl: row.installationUrl,
    ownerUserId: row.ownerUserId,
    provider: IntegrationProviderSchema.parse(row.provider),
    revision: row.revision,
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function integrationConnectionFromRow(
  row: Selectable<IntegrationConnectionTable>,
): IntegrationConnectionSummary {
  return IntegrationConnectionSummarySchema.parse({
    accountIdentifier: row.accountIdentifier,
    applicationSource: row.applicationSource,
    authMethodId: row.authMethodId,
    authorizationDigest: row.authorizationDigest,
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
    grantedScopes: row.grantedScopes,
    id: row.id,
    provider: row.provider,
    providerApplicationId: row.providerApplicationId,
    status: row.status,
    statusDetail: row.statusDetail,
    statusReason: row.statusReason,
    updatedAt: row.updatedAt.toISOString(),
  });
}
