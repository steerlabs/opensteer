import { withPersonalTransaction } from "./personal-transaction.js";
import {} from "@opensteer/integration-core";
import {
  administrationCommand,
  type AdministrationCommandIdentity,
} from "./administration-command.js";
import {} from "@opensteer/shared/isRecord";
import {} from "./resource-access.js";
import {
  checkIntegrationAccountBinding,
  requireIntegrationAccountBinding,
} from "./integration-account-binding.js";
import type { IntegrationOAuthAccountBinding } from "@opensteer/integration-core/ports";
import {} from "@opensteer/protocol";

import {} from "./private-resource-owner.js";
import {} from "./channel-deliveries.js";
import { jsonValue } from "./store-primitives.js";
import {} from "@opensteer/shared/canonicalJson";
import {} from "@opensteer/integration-core/authorization-digest";
import {
  IntegrationConnectionRequirementSchema,
  IntegrationInstallationSchema,
  IntegrationServerSchema,
  type IntegrationToolMaterial,
  type IntegrationConnectionId,
  type IntegrationInstallation,
  type IntegrationInstallationId,
  type IntegrationServer,
  type IntegrationServerId,
  type McpOAuthAttemptId,
} from "@opensteer/integration-core";
import {} from "@opensteer/integration-core/access";
import {} from "@opensteer/integration-core/effect";
import { OpensteerError, createId, type RequestId, type UserId } from "@opensteer/core";
import { erasedIntegrationAuthAttemptPayload } from "./integration-auth-attempt-store.js";
import {} from "./request-cancellation.js";
import {} from "./integration-authority-cache.js";
import {} from "./machine-ownership.js";
import {} from "./integration-store.js";
import {
  IntegrationPlatformStoreBase,
  forbidden,
  upsertConnectionTools,
} from "./integration-platform-stores.js";

/** Remote MCP servers' OAuth connections: attempts, sealed credentials and their renewal. */
export class McpOAuthConnectionStore extends IntegrationPlatformStoreBase {
  async getMcpOAuthServer(input: {
    readonly requestId: RequestId;
    readonly ownerUserId: UserId;
    readonly serverId: IntegrationServerId;
  }): Promise<McpOAuthServerContext> {
    const row = await this.database
      .selectFrom("integrationServers")
      .innerJoin(
        "integrationInstallations",
        "integrationInstallations.id",
        "integrationServers.installationId",
      )
      .innerJoin(
        "integrationRequestDetails",
        "integrationRequestDetails.installationId",
        "integrationInstallations.id",
      )
      .innerJoin("requests", "requests.id", "integrationRequestDetails.requestId")
      .selectAll("integrationServers")
      .select([
        "integrationRequestDetails.requestedConnectionId as requestedConnectionId",
        "integrationInstallations.createdAt as joinedCreatedAt",
        "integrationInstallations.description as joinedDescription",
        "integrationInstallations.id as joinedInstallationId",
        "integrationInstallations.manifest as joinedManifest",
        "integrationInstallations.name as joinedName",
        "integrationInstallations.provenance as joinedProvenance",
        "integrationInstallations.revision as joinedRevision",
        "integrationInstallations.sourceKind as joinedSourceKind",
        "integrationInstallations.status as joinedInstallationStatus",
        "integrationInstallations.title as joinedTitle",
        "integrationInstallations.trust as joinedTrust",
        "integrationInstallations.updatedAt as joinedUpdatedAt",
        "integrationInstallations.version as joinedVersion",
      ])
      .where("integrationServers.id", "=", input.serverId)
      .where("requests.id", "=", input.requestId)
      .where("requests.kind", "=", "integration.access")
      .where("integrationRequestDetails.requestedServerId", "=", input.serverId)
      .where("requests.requestedBy", "=", input.ownerUserId)
      .where("requests.status", "=", "pending")
      .where("integrationInstallations.status", "=", "active")
      .executeTakeFirst();
    if (
      !row ||
      IntegrationConnectionRequirementSchema.parse(row.connectionRequirement).kind !== "mcp-oauth"
    ) {
      throw new OpensteerError({ code: "not_found", message: "MCP OAuth server is unavailable" });
    }
    const server = serverFromJoinedRow(row);
    if (server.transport.type !== "streamable-http") {
      throw new OpensteerError({ code: "conflict", message: "MCP OAuth requires Streamable HTTP" });
    }
    if (!row.requestedConnectionId) return { installation: installationFromJoinedRow(row), server };
    const reconnect = await this.database
      .selectFrom("integrationConnections")
      .innerJoin(
        "mcpOAuthCredentials",
        "mcpOAuthCredentials.connectionId",
        "integrationConnections.id",
      )
      .select(["integrationConnections.id as connectionId", "mcpOAuthCredentials.revision"])
      .where("integrationConnections.id", "=", row.requestedConnectionId)
      .where("integrationConnections.ownerUserId", "=", input.ownerUserId)
      .where("integrationConnections.integrationServerId", "=", input.serverId)
      .where("integrationConnections.connectionKind", "=", "mcp-oauth")
      .where("integrationConnections.status", "=", "needs-attention")
      .executeTakeFirst();
    if (!reconnect)
      throw new OpensteerError({
        code: "conflict",
        message: "MCP account is no longer available to reconnect",
      });
    return { installation: installationFromJoinedRow(row), server, reconnect };
  }

  async completeMcpOAuthAttempt(input: {
    readonly accountBinding?: IntegrationOAuthAccountBinding;
    readonly attemptId: McpOAuthAttemptId;
    readonly connectionId: IntegrationConnectionId;
    readonly displayName: string;
    readonly encryptedState: Buffer;
    readonly encryptionKeyVersion: number;
    readonly ownerUserId: UserId;
    readonly reconnect?: { readonly expectedRevision: number; readonly requestId: RequestId };
    readonly serverId: IntegrationServerId;
    readonly tools: readonly IntegrationToolMaterial[];
  }): Promise<void> {
    await withPersonalTransaction(this.database, async (transaction) => {
      if (input.accountBinding)
        await checkIntegrationAccountBinding(transaction, input.ownerUserId, input.accountBinding);
      await transaction
        .selectFrom("integrationServers")
        .select("id")
        .where("id", "=", input.serverId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      const attempt = await transaction
        .selectFrom("integrationAuthAttempts")
        .select("id")
        .where("id", "=", input.attemptId)
        .where("ownerUserId", "=", input.ownerUserId)
        .where("flow", "=", "mcp-oauth")
        .where("status", "=", "claimed")
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!attempt) throw forbidden("MCP OAuth attempt is no longer active");
      const now = new Date();
      if (input.reconnect) {
        const connection = await transaction
          .selectFrom("integrationConnections")
          .select("id")
          .where("id", "=", input.connectionId)
          .where("ownerUserId", "=", input.ownerUserId)
          .where("integrationServerId", "=", input.serverId)
          .where("connectionKind", "=", "mcp-oauth")
          .where("status", "=", "needs-attention")
          .forNoKeyUpdate()
          .executeTakeFirst();
        const request = await transaction
          .selectFrom("requests")
          .innerJoin(
            "integrationRequestDetails",
            "integrationRequestDetails.requestId",
            "requests.id",
          )
          .select("requests.id")
          .where("requests.id", "=", input.reconnect.requestId)
          .where("requests.requestedBy", "=", input.ownerUserId)
          .where("requests.status", "=", "pending")
          .where("integrationRequestDetails.requestedConnectionId", "=", input.connectionId)
          .where("integrationRequestDetails.requestedServerId", "=", input.serverId)
          .forNoKeyUpdate("requests")
          .executeTakeFirst();
        const credential = await transaction
          .selectFrom("mcpOAuthCredentials")
          .select("revision")
          .where("connectionId", "=", input.connectionId)
          .forNoKeyUpdate()
          .executeTakeFirst();
        if (!connection || !request || credential?.revision !== input.reconnect.expectedRevision) {
          throw new OpensteerError({
            code: "conflict",
            message: "MCP account changed while reconnecting",
          });
        }
        await transaction
          .updateTable("mcpOAuthCredentials")
          .set({
            encryptedState: input.encryptedState,
            encryptionKeyVersion: input.encryptionKeyVersion,
            revision: credential.revision + 1,
            updatedAt: now,
          })
          .where("connectionId", "=", input.connectionId)
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable("integrationConnections")
          .set({ status: "connected", statusDetail: null, updatedAt: now })
          .where("id", "=", input.connectionId)
          .executeTakeFirstOrThrow();
      } else {
        await transaction
          .insertInto("integrationConnections")
          .values({
            accountIdentifier: null,
            applicationSource: null,
            authMethodId: null,
            capabilities: jsonValue([]),
            computerAccess: null,
            runnerId: null,
            connectionKind: "mcp-oauth",
            connectionMethod: "managed-oauth",
            credentialId: null,
            displayName: input.displayName,
            externalIdentityId: null,
            externalTenantId: null,
            grantedScopes: jsonValue([]),
            id: input.connectionId,
            integrationDefinitionId: null,
            integrationServerId: input.serverId,
            ownerUserId: input.ownerUserId,
            provider: `mcp:${input.serverId}`,
            providerApplicationId: null,
            status: "connected",
            statusDetail: null,
            transportKind: null,
            updatedAt: now,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("mcpOAuthCredentials")
          .values({
            connectionId: input.connectionId,
            encryptedState: input.encryptedState,
            encryptionKeyVersion: input.encryptionKeyVersion,
            revision: 1,
            updatedAt: now,
          })
          .executeTakeFirstOrThrow();
      }
      await upsertConnectionTools(
        transaction,
        input.serverId,
        input.connectionId,
        { definitions: {}, tools: input.tools },
        now,
      );
      await transaction
        .updateTable("integrationServers")
        .set({ status: "active", statusDetail: null, updatedAt: now })
        .where("id", "=", input.serverId)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("integrationAuthAttempts")
        .set({
          completedAt: now,
          encryptedPayload: erasedIntegrationAuthAttemptPayload,
          resultConnectionId: input.connectionId,
          status: "completed",
        })
        .where("id", "=", input.attemptId)
        .executeTakeFirstOrThrow();
      if (input.accountBinding)
        await requireIntegrationAccountBinding(
          transaction,
          input.ownerUserId,
          input.accountBinding,
        );
    });
  }

  async getMcpOAuthConnection(input: {
    readonly connectionId: IntegrationConnectionId;
    readonly ownerUserId: UserId;
    readonly serverId: IntegrationServerId;
  }): Promise<McpOAuthConnectionRecord | null> {
    const row = await this.database
      .selectFrom("integrationConnections")
      .innerJoin(
        "mcpOAuthCredentials",
        "mcpOAuthCredentials.connectionId",
        "integrationConnections.id",
      )
      .innerJoin(
        "integrationServers",
        "integrationServers.id",
        "integrationConnections.integrationServerId",
      )
      .innerJoin(
        "integrationInstallations",
        "integrationInstallations.id",
        "integrationServers.installationId",
      )
      .select([
        "integrationConnections.displayName",
        "integrationConnections.id as connectionId",
        "integrationConnections.ownerUserId",
        "mcpOAuthCredentials.encryptedState",
        "mcpOAuthCredentials.encryptionKeyVersion",
        "mcpOAuthCredentials.revision",
      ])
      .selectAll("integrationServers")
      .select([
        "integrationInstallations.createdAt as joinedCreatedAt",
        "integrationInstallations.description as joinedDescription",
        "integrationInstallations.id as joinedInstallationId",
        "integrationInstallations.manifest as joinedManifest",
        "integrationInstallations.name as joinedName",
        "integrationInstallations.provenance as joinedProvenance",
        "integrationInstallations.revision as joinedRevision",
        "integrationInstallations.sourceKind as joinedSourceKind",
        "integrationInstallations.status as joinedInstallationStatus",
        "integrationInstallations.title as joinedTitle",
        "integrationInstallations.trust as joinedTrust",
        "integrationInstallations.updatedAt as joinedUpdatedAt",
        "integrationInstallations.version as joinedVersion",
      ])
      .where("integrationConnections.id", "=", input.connectionId)
      .where("integrationConnections.ownerUserId", "=", input.ownerUserId)
      .where("integrationConnections.integrationServerId", "=", input.serverId)
      .where("integrationConnections.connectionKind", "=", "mcp-oauth")
      .where("integrationConnections.status", "=", "connected")
      .executeTakeFirst();
    return row
      ? {
          connectionId: row.connectionId,
          displayName: row.displayName,
          encryptedState: row.encryptedState,
          encryptionKeyVersion: row.encryptionKeyVersion,
          installation: installationFromJoinedRow(row),
          ownerUserId: row.ownerUserId,
          revision: row.revision,
          server: serverFromJoinedRow(row),
        }
      : null;
  }

  async replaceMcpOAuthCredential(input: {
    readonly connectionId: IntegrationConnectionId;
    readonly encryptedState: Buffer;
    readonly encryptionKeyVersion: number;
    readonly expectedRevision: number;
  }): Promise<boolean> {
    const result = await this.database
      .updateTable("mcpOAuthCredentials")
      .set({
        encryptedState: input.encryptedState,
        encryptionKeyVersion: input.encryptionKeyVersion,
        revision: input.expectedRevision + 1,
        updatedAt: new Date(),
      })
      .where("connectionId", "=", input.connectionId)
      .where("revision", "=", input.expectedRevision)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async listMcpOAuthConnections(ownerUserId: UserId): Promise<
    readonly {
      readonly accountIdentifier: string | null;
      readonly connectionId: IntegrationConnectionId;
      readonly createdAt: string;
      readonly displayName: string;
      readonly installationId: IntegrationInstallationId;
      readonly serverId: IntegrationServerId;
      readonly status: "connected" | "needs-attention" | "revoked";
      readonly updatedAt: string;
    }[]
  > {
    const rows = await this.database
      .selectFrom("integrationConnections")
      .innerJoin(
        "integrationServers",
        "integrationServers.id",
        "integrationConnections.integrationServerId",
      )
      .select([
        "integrationConnections.accountIdentifier",
        "integrationConnections.createdAt",
        "integrationConnections.displayName",
        "integrationConnections.id as connectionId",
        "integrationConnections.status",
        "integrationConnections.updatedAt",
        "integrationServers.id as serverId",
        "integrationServers.installationId",
      ])
      .where("integrationConnections.ownerUserId", "=", ownerUserId)
      .where("integrationConnections.connectionKind", "=", "mcp-oauth")
      .orderBy("integrationConnections.updatedAt", "desc")
      .execute();
    return rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      status: row.status === "paused" || row.status === "pending" ? "needs-attention" : row.status,
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  async revokeMcpOAuthConnection(input: {
    readonly administration?: AdministrationCommandIdentity | undefined;
    readonly connectionId: IntegrationConnectionId;
    readonly ownerUserId: UserId;
    readonly requestId: string;
  }): Promise<void> {
    await withPersonalTransaction(this.database, async (transaction) =>
      administrationCommand(transaction, input.administration, async () => {
        const now = new Date();
        const connection = await transaction
          .updateTable("integrationConnections")
          .set({ status: "revoked", statusDetail: null, updatedAt: now })
          .where("id", "=", input.connectionId)
          .where("ownerUserId", "=", input.ownerUserId)
          .where("connectionKind", "=", "mcp-oauth")
          .where("status", "!=", "revoked")
          .returning(["id", "integrationServerId"])
          .executeTakeFirst();
        if (!connection) {
          throw new OpensteerError({ code: "not_found", message: "MCP account not found" });
        }
        await transaction
          .updateTable("integrationTools")
          .set({ status: "disabled", updatedAt: now })
          .where("connectionId", "=", connection.id)
          .execute();
        await transaction
          .updateTable("integrationGrants")
          .set({ isDefault: false, revokedAt: now, status: "revoked", updatedAt: now })
          .where("connectionId", "=", connection.id)
          .where("revokedAt", "is", null)
          .execute();
        await transaction
          .insertInto("securityAudit")
          .values({
            action: "integration.mcp-connection.revoked",
            actorSessionId: null,
            actorUserId: input.ownerUserId,
            id: createId("securityAudit"),
            metadata: jsonValue({ serverId: connection.integrationServerId }),
            requestId: input.requestId,
            targetId: connection.id,
            targetType: "integration-connection",
          })
          .executeTakeFirstOrThrow();
      }),
    );
  }

  async markMcpOAuthConnectionNeedsAttention(input: {
    readonly connectionId: IntegrationConnectionId;
    readonly expectedRevision: number;
    readonly ownerUserId: UserId;
    readonly statusDetail: string;
  }): Promise<boolean> {
    return withPersonalTransaction(this.database, async (transaction) => {
      const current = await transaction
        .selectFrom("integrationConnections")
        .select("id")
        .where("id", "=", input.connectionId)
        .where("ownerUserId", "=", input.ownerUserId)
        .where("connectionKind", "=", "mcp-oauth")
        .where("status", "=", "connected")
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!current) return false;
      const credential = await transaction
        .selectFrom("mcpOAuthCredentials")
        .select("revision")
        .where("connectionId", "=", input.connectionId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (credential?.revision !== input.expectedRevision) return false;
      const now = new Date();
      const connection = await transaction
        .updateTable("integrationConnections")
        .set({ status: "needs-attention", statusDetail: input.statusDetail, updatedAt: now })
        .where("id", "=", input.connectionId)
        .where("ownerUserId", "=", input.ownerUserId)
        .where("connectionKind", "=", "mcp-oauth")
        .where("status", "!=", "revoked")
        .returning("id")
        .executeTakeFirst();
      return !!connection;
    });
  }
}

export interface McpOAuthServerContext {
  readonly installation: IntegrationInstallation;
  readonly server: IntegrationServer;
  readonly reconnect?: {
    readonly connectionId: IntegrationConnectionId;
    readonly revision: number;
  };
}

interface McpOAuthConnectionRecord extends McpOAuthServerContext {
  readonly connectionId: IntegrationConnectionId;
  readonly displayName: string;
  readonly encryptedState: Buffer;
  readonly encryptionKeyVersion: number;
  readonly ownerUserId: UserId;
  readonly revision: number;
}

interface JoinedServerRow {
  readonly connectionRequirement: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
  readonly id: IntegrationServerId;
  readonly installationId: IntegrationInstallationId;
  readonly joinedCreatedAt: Date;
  readonly joinedDescription: string;
  readonly joinedInstallationId: IntegrationInstallationId;
  readonly joinedInstallationStatus: IntegrationInstallation["status"];
  readonly joinedManifest: Readonly<Record<string, unknown>>;
  readonly joinedName: string;
  readonly joinedProvenance: Readonly<Record<string, unknown>>;
  readonly joinedRevision: number;
  readonly joinedSourceKind: IntegrationInstallation["sourceKind"];
  readonly joinedTitle: string;
  readonly joinedTrust: IntegrationInstallation["trust"];
  readonly joinedUpdatedAt: Date;
  readonly joinedVersion: string | null;
  readonly name: string;
  readonly status: IntegrationServer["status"];
  readonly statusDetail: string | null;
  readonly toolGeneration: number;
  readonly transport: Readonly<Record<string, unknown>>;
  readonly updatedAt: Date;
}

function installationFromJoinedRow(row: JoinedServerRow): IntegrationInstallation {
  return IntegrationInstallationSchema.parse({
    createdAt: row.joinedCreatedAt.toISOString(),
    description: row.joinedDescription,
    id: row.joinedInstallationId,
    manifest: row.joinedManifest,
    name: row.joinedName,
    provenance: row.joinedProvenance,
    revision: row.joinedRevision,
    sourceKind: row.joinedSourceKind,
    status: row.joinedInstallationStatus,
    title: row.joinedTitle,
    trust: row.joinedTrust,
    updatedAt: row.joinedUpdatedAt.toISOString(),
    version: row.joinedVersion,
  });
}

function serverFromJoinedRow(row: JoinedServerRow): IntegrationServer {
  return IntegrationServerSchema.parse({
    connectionRequirement: row.connectionRequirement,
    id: row.id,
    installationId: row.installationId,
    name: row.name,
    status: row.status,
    statusDetail: row.statusDetail,
    toolGeneration: row.toolGeneration,
    transport: row.transport,
    updatedAt: row.updatedAt.toISOString(),
  });
}
