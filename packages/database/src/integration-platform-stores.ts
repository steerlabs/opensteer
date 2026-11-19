import { computerConnectionDeviceId } from "./integration-connections.js";
import {
  getDeviceSelfRunnerId,
  requireSelfDeviceId,
  requireDeviceSelfRunnerId,
} from "./device-inventory-store.js";
import { DeviceIdSchema, type DeviceId } from "@opensteer/core";
import { lockDeploymentEvents, withPersonalTransaction } from "./personal-transaction.js";
import { integrationAccountLabel } from "@opensteer/integration-core";
import {
  administrationCommand,
  type AdministrationCommandIdentity,
} from "./administration-command.js";
import { replaceSecrets, type LocalMcpSecretsUpdate } from "./local-mcp-server-store.js";
import { isRecord } from "@opensteer/shared/isRecord";
import { resolveResourceAccess } from "./resource-access.js";
import { requestSettlementActor } from "./request-settlement.js";

import { assertPersonalOwner } from "./private-resource-owner.js";
import { revokeChannelConnectionsInTransaction } from "./channel-deliveries.js";
import { jsonValue } from "./store-primitives.js";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import {
  type ComputerAppIdentity,
  IntegrationConnectionRequirementSchema,
  IntegrationDefinitionIdSchema,
  IntegrationDefinitionSummarySchema,
  IntegrationInstallationSchema,
  IntegrationServerSchema,
  IntegrationServerTransportSchema,
  IntegrationToolSchema,
  IntegrationToolMaterialSchema,
  type IntegrationToolMaterial,
  type IntegrationToolCatalog,
  resolveIntegrationReadiness,
  isIntegrationConnectionEligible,
  type IntegrationConnectionAuthority,
  type IntegrationConnectionId,
  type IntegrationAccess,
  type IntegrationGrant,
  type IntegrationInstallation,
  type IntegrationInstallationId,
  type IntegrationServer,
  type IntegrationServerId,
  type IntegrationTool,
  type IntegrationToolId,
  type IntegrationReadiness,
} from "@opensteer/integration-core";
import { integrationAccessCovers } from "@opensteer/integration-core/access";
import { integrationToolEffect } from "@opensteer/integration-core/effect";
import {
  materializeToolCatalog,
  storedToolSchemaDigest,
} from "@opensteer/integration-core/tool-schemas";
import {
  effectiveIntegrationAccess,
  resolveEffectiveGrants,
  type EffectiveIntegrationGrant,
} from "@opensteer/integration-core/effective-grants";
import {
  OpensteerError,
  createId,
  type AgentEvent,
  type RequestId,
  type ThreadId,
  type UserId,
  type RunnerId,
} from "@opensteer/core";
import { type Kysely, type Selectable, type Transaction, sql } from "kysely";
import type {
  DatabaseSchema,
  IntegrationConnectionTable,
  IntegrationInstallationTable,
  IntegrationServerTable,
  IntegrationToolTable,
} from "./schema.js";
import { cancelPending } from "./request-cancellation.js";
import { IntegrationAuthorityCache } from "./integration-authority-cache.js";
import { deleteComputerAppSetupRequestsInTransaction } from "./computer-app-setup.js";
import { declineComputerAppAccessRequestsInTransaction } from "./computer-app-approvals.js";
import {
  integrationGrantFromRow,
  writeIntegrationGrantInTransaction,
  type CreateIntegrationGrantInput,
} from "./integration-grant-write.js";

const integrationToolListingColumns = [
  "integrationTools.annotations",
  "integrationTools.connectionId",
  "integrationTools.description",
  "integrationTools.id",
  "integrationTools.name",
  "integrationTools.schemaDigest",
  "integrationTools.serverId",
  "integrationTools.status",
  "integrationTools.title",
] as const;

type IntegrationToolListingRow = Pick<
  Selectable<IntegrationToolTable>,
  | "annotations"
  | "connectionId"
  | "description"
  | "id"
  | "name"
  | "schemaDigest"
  | "serverId"
  | "status"
  | "title"
>;

export interface IntegrationToolSchemas {
  readonly definitions: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>> | null;
  readonly schemaDigest: string;
  readonly status: "active" | "disabled";
}

/**
 * Integration authority names an owned task or a live approved connection. Naming neither is the
 * personal owner looking in Settings, under no task's or connection's ceiling.
 */
export type IntegrationRequester = {
  readonly ownerUserId: UserId;
} & (
  | { readonly threadId: ThreadId; readonly connectionId?: never }
  | { readonly connectionId: string; readonly threadId?: undefined }
  | { readonly threadId?: never; readonly connectionId?: never }
);

type IntegrationReadinessTarget = {
  readonly access: IntegrationAccess;
  readonly connectionId: IntegrationConnectionId | null;
};

/** Scope readiness to the account and access a resolved Request actually granted. */
export type IntegrationDiscoveryRequester = IntegrationRequester & {
  readonly target?: IntegrationReadinessTarget;
  readonly includeTargetReadiness?: true;
  readonly provider?:
    { readonly serverId: IntegrationServerId } | { readonly connectionId: IntegrationConnectionId };
};

/** Installations one read of the discovery inventory takes at a time. */
const discoveryInventoryPage = 1_000;

export interface DiscoveredIntegrationServer {
  readonly connectionRequirement: IntegrationServer["connectionRequirement"];
  readonly id: IntegrationServerId;
  readonly name: string;
  readonly status: "active" | "disabled" | "needs-attention";
  readonly statusDetail: string | null;
  /**
   * Its tools, or null when they are not known yet: a server waiting for its launch's approval.
   * An existing server keeps the tools its last approved launch listed, still not callable, so a
   * path an agent holds says why it waits rather than that it is gone.
   */
  readonly catalog: IntegrationToolCatalog | null;
  readonly transport: IntegrationServer["transport"];
}

export interface CallableIntegrationTool {
  readonly grant: EffectiveIntegrationGrant;
  readonly installation: IntegrationInstallation;
  readonly server: IntegrationServer;
  readonly tool: IntegrationTool;
}

interface StoredIntegrationConnectionAuthority extends IntegrationConnectionAuthority {
  readonly accountIdentifier: string | null;
  readonly computerAccess: IntegrationAccess | null;
  readonly displayName: string;
  readonly id: IntegrationConnectionId;
  readonly ownerUserId: UserId;
}

export abstract class IntegrationPlatformStoreBase {
  protected readonly database: Kysely<DatabaseSchema>;

  constructor(database: Kysely<DatabaseSchema>) {
    this.database = database;
  }

  async getDeviceSelfRunnerId(deviceId: DeviceId) {
    return getDeviceSelfRunnerId(this.database, deviceId);
  }
  async requireSelfDeviceId(runnerId: RunnerId) {
    return requireSelfDeviceId(this.database, runnerId);
  }
  async requireDeviceSelfRunnerId(deviceId: DeviceId) {
    return requireDeviceSelfRunnerId(this.database, deviceId);
  }
  async assertOwner(ownerId: UserId): Promise<void> {
    await assertPersonalOwner(this.database, ownerId);
  }

  protected async authoritySnapshot(ownerUserId: UserId): Promise<{
    readonly connections: readonly StoredIntegrationConnectionAuthority[];
  }> {
    const connectionRows = await this.database
      .selectFrom("integrationConnections")
      .select([
        "accountIdentifier",
        "connectionKind",
        "computerAccess",
        "displayName",
        "id",
        "integrationDefinitionId",
        "integrationServerId",
        "ownerUserId",
        "status",
      ])
      .where("ownerUserId", "=", ownerUserId)
      .where("status", "!=", "revoked")
      .orderBy("displayName", "asc")
      .orderBy("id", "asc")
      .execute();
    return {
      connections: connectionRows.map((connection) => ({
        connectionKind: connection.connectionKind,
        computerAccess: connection.computerAccess,
        definitionId: connection.integrationDefinitionId,
        accountIdentifier: connection.accountIdentifier,
        displayName: connection.displayName,
        id: connection.id,
        integrationServerId: connection.integrationServerId,
        ownerUserId: connection.ownerUserId,
        status: connection.status,
      })),
    };
  }

  protected async activeGrants(input: {
    readonly ownerUserId: UserId;
  }): Promise<readonly IntegrationGrant[]> {
    const rows = await this.database
      .selectFrom("integrationGrants")
      .selectAll()
      .where("ownerUserId", "=", input.ownerUserId)
      .where("revokedAt", "is", null)
      .orderBy("installationId", "asc")
      .orderBy("isDefault", "desc")
      .orderBy("alias", "asc")
      .execute();
    return rows.map(integrationGrantFromRow);
  }

  async connectionDiscoveryScope(userId: UserId, connectionId: string) {
    const connection = await this.database
      .selectFrom("agentConnections")
      .select("id")
      .where("id", "=", connectionId)
      .where("userId", "=", userId)
      .where("revokedAt", "is", null)
      .where("tokenHash", "is not", null)
      .where("expiresAt", ">", new Date())
      .executeTakeFirst();
    if (!connection)
      throw new OpensteerError({ code: "forbidden", message: "Connection is unavailable" });
    await assertPersonalOwner(this.database, userId);
    return { connectionId, requestedBy: userId };
  }

  protected async installationInventory(): Promise<readonly IntegrationInstallation[]> {
    const rows = await this.database
      .selectFrom("integrationInstallations")
      .selectAll()
      .orderBy("title", "asc")
      .limit(1_000)
      .execute();
    return rows.map(installationFromRow);
  }
}

export interface InstallIntegrationInput {
  readonly administration?: AdministrationCommandIdentity | undefined;
  /**
   * For each server an install keeps on a computer: the secrets it keeps for
   * the new launch. Approval never carries: it names one launch, by digest.
   */
  readonly retainedServer?: (
    existing: {
      id: IntegrationServerId;
      status: string;
      approvedLaunchDigest: string | null;
      transport: IntegrationServer["transport"];
    },
    discovered: DiscoveredIntegrationServer,
  ) => { secrets: LocalMcpSecretsUpdate } | null;
  readonly beforeInstall?: (transaction: Transaction<DatabaseSchema>) => Promise<void>;
  readonly settlementSessionId?: string | undefined;
  readonly actorUserId: UserId | null;
  readonly installation: Omit<IntegrationInstallation, "createdAt" | "revision" | "updatedAt">;
  readonly requestId: string;
  readonly servers: readonly DiscoveredIntegrationServer[];
  /** Rebuilds every live computer connection atomically with rematerialization. */
  readonly computerConnectionTools?: (
    connectionId: IntegrationConnectionId,
    access: IntegrationAccess,
  ) => readonly IntegrationToolMaterial[];
}

export interface InstallIntegrationMutation {
  readonly installation: IntegrationInstallation;
  readonly requestEvents: readonly AgentEvent[];
}

export interface UninstallIntegrationInput {
  readonly administration?: AdministrationCommandIdentity | undefined;
  readonly actorUserId: UserId;
  readonly installationId: IntegrationInstallationId;
  readonly requestId: string;
}

export interface UninstallIntegrationMutation {
  readonly cancelledRequestIds: readonly RequestId[];
  readonly installation: IntegrationInstallation;
  readonly removedConnectionIds: readonly IntegrationConnectionId[];
  readonly removedApps: readonly RemovedComputerApp[];
  readonly removedServerIds: readonly IntegrationServerId[];
  readonly requestEvents: readonly AgentEvent[];
}

export type RevokeComputerConnectionSelector =
  | { readonly connectionId: IntegrationConnectionId; readonly ownerUserId: UserId }
  | { readonly installationId: IntegrationInstallationId }
  | { readonly deviceId: DeviceId }
  | { readonly runnerId: RunnerId };

/** What a removal took back, so a caller can end the sessions that were using it. */
export interface RemovedComputerApp {
  readonly app: ComputerAppIdentity | null;
  readonly appKey: string | null;
  readonly connectionId: IntegrationConnectionId;
  readonly definitionId: string | null;
  readonly deviceId: DeviceId;
}

export interface RevokeComputerConnectionsMutation {
  readonly cancelledRequestIds: readonly RequestId[];
  readonly connectionIds: readonly IntegrationConnectionId[];
  /** The apps whose approval this removal took back, `(deviceId, appKey)` and all. */
  readonly removedApps: readonly RemovedComputerApp[];
  readonly requestEvents: readonly AgentEvent[];
}

export type { ComputerAppAccessSettlement } from "./computer-app-approvals.js";

/** The one credential-free removal path for computer connections. */
export async function revokeComputerConnectionsInTransaction(
  transaction: Transaction<DatabaseSchema>,
  selector: RevokeComputerConnectionSelector,
): Promise<RevokeComputerConnectionsMutation> {
  let query = transaction
    .selectFrom("integrationConnections")
    .innerJoin(
      "integrationServers",
      "integrationServers.id",
      "integrationConnections.integrationServerId",
    )
    .select([
      "integrationConnections.computerApp",
      "integrationConnections.computerAppKey",
      "integrationConnections.id",
      "integrationConnections.integrationDefinitionId",
      "integrationConnections.ownerUserId",
      "integrationConnections.integrationServerId",
      computerConnectionDeviceId.as("deviceId"),
      "integrationServers.installationId",
    ])
    .where("integrationConnections.connectionKind", "=", "computer")
    .where("integrationConnections.status", "!=", "revoked");
  if ("connectionId" in selector) {
    query = query
      .where("integrationConnections.id", "=", selector.connectionId)
      .where("integrationConnections.ownerUserId", "=", selector.ownerUserId);
  } else if ("deviceId" in selector) {
    query = query.where(computerConnectionDeviceId, "=", selector.deviceId);
  } else if ("runnerId" in selector) {
    query = query.where("integrationConnections.runnerId", "=", selector.runnerId);
  } else {
    query = query.where("integrationServers.installationId", "=", selector.installationId);
  }
  const discoveredConnections = await query.execute();
  const discoveredIds = discoveredConnections.map(({ id }) => id);
  if (discoveredIds.length)
    await transaction
      .selectFrom("integrationConnections")
      .select("id")
      .where((eb) =>
        eb.or([eb("id", "in", discoveredIds), eb("sourceConnectionId", "in", discoveredIds)]),
      )
      .orderBy("id", "asc")
      .$call((fence) =>
        "installationId" in selector
          ? // FOR UPDATE: uninstall deletes the computer and dependent channel rows.
            fence.forUpdate()
          : fence.forNoKeyUpdate(),
      )
      .execute();
  const connections = await query
    .orderBy("integrationConnections.id", "asc")
    .$call((query) =>
      "installationId" in selector
        ? // FOR UPDATE: Uninstall deletes the installation's computer connections.
          query.forUpdate("integrationConnections")
        : query.forNoKeyUpdate("integrationConnections"),
    )
    .execute();
  // Removing an app takes its approval back, and no more than its own: only
  // the whole-computer and whole-installation selectors are wider than one
  // `(deviceId, definitionId, appKey)`.
  const revokedSetupRequestIds = await (async (): Promise<readonly string[]> => {
    if ("deviceId" in selector || "runnerId" in selector) {
      return deleteComputerAppSetupRequestsInTransaction(transaction, {
        deviceId:
          "deviceId" in selector ? selector.deviceId : DeviceIdSchema.parse(selector.runnerId),
      });
    }
    if ("installationId" in selector) {
      const installation = await transaction
        .selectFrom("integrationInstallations")
        .select("manifest")
        .where("id", "=", selector.installationId)
        .executeTakeFirst();
      const definition = IntegrationDefinitionSummarySchema.safeParse(
        installation?.manifest.definition,
      );
      return definition.success
        ? deleteComputerAppSetupRequestsInTransaction(transaction, {
            definitionId: definition.data.id,
          })
        : [];
    }
    const connection = connections.find(({ id }) => id === selector.connectionId);
    if (!connection?.deviceId) return [];
    return deleteComputerAppSetupRequestsInTransaction(transaction, {
      appKey: connection.computerAppKey,
      deviceId: connection.deviceId,
      ...(connection.integrationDefinitionId === null
        ? {}
        : { definitionId: connection.integrationDefinitionId }),
    });
  })();
  const connectionIds = connections.map(({ id }) => id);
  const now = new Date();
  if (connectionIds.length > 0) {
    await transaction
      .selectFrom("integrationGrants")
      .select("id")
      .where("connectionId", "in", connectionIds)
      .where("revokedAt", "is", null)
      .orderBy("id", "asc")
      // Uninstall deletes these grants after it has locked the tools below, so
      // the strongest lock it will need on them is taken here, before the tools'.
      .$call((fence) =>
        "installationId" in selector
          ? // FOR UPDATE: uninstall deletes these grants.
            fence.forUpdate()
          : fence.forNoKeyUpdate(),
      )
      .execute();
    await transaction
      .updateTable("integrationGrants")
      .set({ isDefault: false, revokedAt: now, status: "revoked", updatedAt: now })
      .where("connectionId", "in", connectionIds)
      .where("revokedAt", "is", null)
      .execute();
  }
  const declined = await declineComputerAppAccessRequestsInTransaction(transaction, {
    setupRequestIds: revokedSetupRequestIds,
  });
  const removedApps = connections.flatMap((connection): readonly RemovedComputerApp[] =>
    connection.deviceId === null
      ? []
      : [
          {
            app: connection.computerApp ?? null,
            appKey: connection.computerAppKey,
            connectionId: connection.id,
            definitionId: connection.integrationDefinitionId,
            deviceId: connection.deviceId,
          },
        ],
  );
  if (connections.length === 0) {
    return {
      cancelledRequestIds: [],
      connectionIds: [],
      removedApps: [],
      requestEvents: declined.requestEvents,
    };
  }
  await transaction
    .updateTable("integrationConnections")
    .set({ status: "revoked", statusDetail: null, updatedAt: now })
    .where("id", "in", connectionIds)
    .where("connectionKind", "=", "computer")
    .where("status", "!=", "revoked")
    .execute();
  // A channel that is a use of one of these apps — iMessage of the Mac's
  // Messages — never outlives it.
  const dependentChannels = await transaction
    .selectFrom("integrationConnections")
    .select("id")
    .where("sourceConnectionId", "in", connectionIds)
    .where("connectionKind", "=", "channel")
    .where("status", "!=", "revoked")
    .orderBy("id", "asc")
    .forNoKeyUpdate()
    .execute();
  await revokeChannelConnectionsInTransaction(
    transaction,
    dependentChannels.map(({ id }) => id),
  );
  const requestIds = new Set<RequestId>();
  for (const connection of connections) {
    const pending = await transaction
      .selectFrom("requests")
      .innerJoin("integrationRequestDetails", "integrationRequestDetails.requestId", "requests.id")
      .select("requests.id")
      .where("requests.kind", "=", "integration.access")
      .where("requests.status", "=", "pending")
      .where("requests.requestedBy", "=", connection.ownerUserId)
      .where("integrationRequestDetails.installationId", "=", connection.installationId)
      // Removing one computer invalidates only Requests that chose that exact
      // connection. An unpinned Request remains actionable through another
      // computer, or after the owner enables the app again. Installation
      // removal separately cancels every remaining Request below.
      .where("integrationRequestDetails.requestedConnectionId", "=", connection.id)
      .where((expression) =>
        expression.or([
          expression("integrationRequestDetails.requestedServerId", "is", null),
          expression(
            "integrationRequestDetails.requestedServerId",
            "=",
            connection.integrationServerId,
          ),
        ]),
      )
      .execute();
    for (const request of pending) requestIds.add(request.id);
  }
  const cancelledRequestIds = [...requestIds];
  const requestEvents = await cancelPending(transaction, {
    reason: "resource-deleted",
    requestIds: cancelledRequestIds,
    resolvedAt: now,
  });
  await transaction
    .selectFrom("integrationTools")
    .select("id")
    .where("connectionId", "in", connectionIds)
    .orderBy("id", "asc")
    // FOR UPDATE: computer revocation deletes the selected tools.
    .forUpdate()
    .execute();
  await transaction
    .deleteFrom("integrationTools")
    .where("connectionId", "in", connectionIds)
    .execute();
  await transaction
    .selectFrom("integrationToolDefinitions")
    .select("serverId")
    .where("connectionId", "in", connectionIds)
    .orderBy(sql`ctid`)
    // FOR UPDATE: computer revocation deletes these definition documents.
    .forUpdate()
    .execute();
  await transaction
    .deleteFrom("integrationToolDefinitions")
    .where("connectionId", "in", connectionIds)
    .execute();

  return {
    cancelledRequestIds,
    connectionIds,
    removedApps,
    requestEvents: [...declined.requestEvents, ...requestEvents],
  };
}

/**
 * Disabled rows retain their unique name, so uninstall deletes them to permit reinstalling.
 * Resolved Request details detach to preserve their history; pending Requests are cancelled.
 */
export async function uninstallIntegrationInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: UninstallIntegrationInput,
): Promise<UninstallIntegrationMutation> {
  const existing = await transaction
    .selectFrom("integrationInstallations")
    .selectAll()
    .where("id", "=", input.installationId)
    .executeTakeFirst();
  if (!existing) {
    throw new OpensteerError({ code: "not_found", message: "Integration installation not found" });
  }
  // The shared prefix in ./lock-order.ts serializes competing operations on
  // this installation identity before either materializes its resources.
  await lockIntegrationInstallationIdentityInTransaction(transaction, {
    name: existing.name,
    provenance: existing.provenance,
    sourceKind: existing.sourceKind,
  });
  const row = await transaction
    .selectFrom("integrationInstallations")
    .selectAll()
    .where("id", "=", input.installationId)
    // FOR UPDATE: Uninstall deletes this integration installation.
    .forUpdate()
    .executeTakeFirst();
  if (!row) {
    throw new OpensteerError({ code: "not_found", message: "Integration installation not found" });
  }
  const installation = installationFromRow(row);
  const now = new Date();
  const serverIds = (
    await transaction
      .selectFrom("integrationServers")
      .select("id")
      .where("installationId", "=", installation.id)
      .orderBy("id", "asc")
      // FOR UPDATE: Uninstall deletes these integration servers.
      .forUpdate()
      .execute()
  ).map(({ id }) => id);
  const pluginId = installation.pluginId;
  if (pluginId && serverIds.length > 0) {
    const servers = await transaction
      .selectFrom("integrationServers")
      .select("transport")
      .where("id", "in", serverIds)
      .execute();
    const runnerIds = [
      ...new Set(
        servers.flatMap(({ transport }) =>
          typeof transport.runnerId === "string" ? [transport.runnerId as RunnerId] : [],
        ),
      ),
    ];
    if (runnerIds.length > 0)
      await transaction
        .insertInto("runnerPluginDataRemovals")
        .values(runnerIds.map((runnerId) => ({ runnerId, pluginId })))
        .onConflict((oc) => oc.columns(["runnerId", "pluginId"]).doNothing())
        .execute();
  }
  const uninstallIds = await uninstallConnectionIds(transaction, serverIds);
  const revokedComputerConnections = await revokeComputerConnectionsInTransaction(transaction, {
    installationId: installation.id,
  });
  // A server a computer runs goes with its plugin, and so does the approval
  // it waits on there.
  if (serverIds.length > 0) {
    await transaction
      .deleteFrom("computerAppSetupRequests")
      .where("kind", "=", "server")
      .where("definitionId", "in", serverIds)
      .execute();
  }
  const pendingAccessRequests = await transaction
    .selectFrom("requests")
    .innerJoin("integrationRequestDetails", "integrationRequestDetails.requestId", "requests.id")
    .select("requests.id")
    .where("requests.kind", "=", "integration.access")
    .where("requests.status", "=", "pending")
    .where("integrationRequestDetails.installationId", "=", installation.id)
    .forNoKeyUpdate("requests")
    .execute();
  const remainingCancelledRequestIds = pendingAccessRequests.map(({ id }) => id);
  const remainingRequestEvents = await cancelPending(transaction, {
    reason: "resource-deleted",
    requestIds: remainingCancelledRequestIds,
    resolvedAt: now,
  });
  const cancelledRequestIds = [
    ...new Set([
      ...revokedComputerConnections.cancelledRequestIds,
      ...remainingCancelledRequestIds,
    ]),
  ];
  const requestEvents = [...revokedComputerConnections.requestEvents, ...remainingRequestEvents];
  const removedConnectionIds = [
    ...new Set([...revokedComputerConnections.connectionIds, ...uninstallIds]),
  ];
  await transaction
    .selectFrom("integrationRequestDetails")
    .select("requestId")
    .where("installationId", "=", installation.id)
    .orderBy("requestId", "asc")
    .forNoKeyUpdate()
    .execute();
  await transaction
    .updateTable("integrationRequestDetails")
    .set({ installationId: null })
    .where("installationId", "=", installation.id)
    .execute();
  if (serverIds.length > 0) {
    await transaction
      .updateTable("integrationRequestDetails")
      .set({ requestedServerId: null })
      .where("requestedServerId", "in", serverIds)
      .execute();
  }
  await transaction
    .deleteFrom("integrationGrants")
    .where((expression) =>
      expression.or([
        expression("installationId", "=", installation.id),
        ...(removedConnectionIds.length > 0
          ? [expression("connectionId", "in", [...removedConnectionIds])]
          : []),
      ]),
    )
    .execute();
  if (serverIds.length > 0) {
    await transaction
      .selectFrom("integrationTools")
      .select("id")
      .where("serverId", "in", serverIds)
      .orderBy("id", "asc")
      // FOR UPDATE: uninstall deletes every tool of these servers.
      .forUpdate()
      .execute();
    await transaction.deleteFrom("integrationTools").where("serverId", "in", serverIds).execute();
    await transaction
      .selectFrom("integrationToolDefinitions")
      .select("serverId")
      .where("serverId", "in", serverIds)
      .orderBy(sql`ctid`)
      // FOR UPDATE: uninstall deletes these definition documents before their parents.
      .forUpdate()
      .execute();
    await transaction
      .deleteFrom("integrationToolDefinitions")
      .where("serverId", "in", serverIds)
      .execute();
  }
  // Connections go before their server: an MCP account names the server it was
  // authorized against, and that reference is RESTRICT.
  if (removedConnectionIds.length > 0) {
    const credentialIds = (
      await transaction
        .selectFrom("integrationConnections")
        .select("credentialId")
        .where("id", "in", [...removedConnectionIds])
        .execute()
    ).flatMap(({ credentialId }) => (credentialId === null ? [] : [credentialId]));
    await transaction
      .deleteFrom("integrationConnections")
      .where("id", "in", [...removedConnectionIds])
      .execute();
    if (credentialIds.length > 0) {
      await transaction.deleteFrom("credentials").where("id", "in", credentialIds).execute();
    }
  }
  await transaction
    .deleteFrom("integrationServers")
    .where("installationId", "=", installation.id)
    .execute();
  await transaction
    .deleteFrom("integrationInstallations")
    .where("id", "=", installation.id)
    // RETURNING is what makes the revision predicate a fence: a delete result
    // alone always exists, so a concurrent revision bump would pass silently.
    .where("revision", "=", installation.revision)
    .returning("id")
    .executeTakeFirstOrThrow();
  await transaction
    .insertInto("securityAudit")
    .values({
      action: "integration.installation.removed",
      actorSessionId: null,
      actorUserId: input.actorUserId,
      id: createId("securityAudit"),
      metadata: jsonValue({
        cancelledRequests: cancelledRequestIds.length,
        name: installation.name,
        removedConnections: removedConnectionIds.length,
        sourceKind: installation.sourceKind,
      }),
      requestId: input.requestId,
      targetId: installation.id,
      targetType: "integration-installation",
    })
    .executeTakeFirstOrThrow();
  return {
    cancelledRequestIds,
    installation,
    removedConnectionIds,
    removedApps: revokedComputerConnections.removedApps,
    removedServerIds: serverIds,
    requestEvents,
  };
}

async function uninstallConnectionIds(
  transaction: Transaction<DatabaseSchema>,
  serverIds: readonly IntegrationServerId[],
): Promise<readonly IntegrationConnectionId[]> {
  if (!serverIds.length) return [];
  return (
    (
      await transaction
        .selectFrom("integrationConnections")
        .select("id")
        .where("connectionKind", "=", "computer")
        .where("integrationServerId", "in", [...serverIds])
        .orderBy("id", "asc")
        // FOR UPDATE: Uninstall deletes these servers' computer connections.
        .forUpdate()
        .execute()
    ).map(({ id }) => id)
  );
}

export async function lockIntegrationCatalogDefinitionInTransaction(
  transaction: Transaction<DatabaseSchema>,
  definitionId: string,
): Promise<void> {
  const exactDefinitionId = IntegrationDefinitionIdSchema.parse(definitionId);
  await sql`select pg_advisory_xact_lock(hashtextextended(${`integration-catalog-definition:${exactDefinitionId}`}, 0))`.execute(
    transaction,
  );
}

export async function lockIntegrationInstallationIdentityInTransaction(
  transaction: Transaction<DatabaseSchema>,
  installation: Pick<IntegrationInstallation, "name" | "provenance" | "sourceKind">,
): Promise<void> {
  const definitionId = exactCatalogDefinitionId(installation);
  if (definitionId) {
    await lockIntegrationCatalogDefinitionInTransaction(transaction, definitionId);
  }
  await sql`select pg_advisory_xact_lock(hashtextextended(${`integration-installation:${installation.name}`}, 0))`.execute(
    transaction,
  );
  await transaction
    .selectFrom("integrationInstallations")
    .select("id")
    .where("name", "=", installation.name)
    .forNoKeyUpdate()
    .executeTakeFirst();
}

export async function installIntegrationInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: InstallIntegrationInput,
): Promise<InstallIntegrationMutation> {
  await lockDeploymentEvents(transaction);
  validateInstallation(input);
  await lockIntegrationInstallationIdentityInTransaction(transaction, input.installation);
  const current = await transaction
    .selectFrom("integrationInstallations")
    .selectAll()
    .$if(input.installation.sourceKind === "plugin", (q) =>
      q.where("id", "=", input.installation.id),
    )
    .$if(input.installation.sourceKind !== "plugin", (q) =>
      q.where("name", "=", input.installation.name),
    )
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (current && current.sourceKind !== input.installation.sourceKind) {
    throw new OpensteerError({
      code: "conflict",
      message: `Integration name ${input.installation.name} belongs to a different installation source`,
    });
  }
  const existingServers = await transaction
    .selectFrom("integrationServers")
    .selectAll()
    .where("installationId", "=", current?.id ?? input.installation.id)
    .orderBy("id", "asc")
    .forNoKeyUpdate()
    .execute();
  // Lock resource parents before replaceServerToolsInTransaction acquires tool rows.
  if (existingServers.length > 0)
    await transaction
      .selectFrom("integrationConnections")
      .select("id")
      .where(
        "integrationServerId",
        "in",
        existingServers.map(({ id }) => id),
      )
      .orderBy("id", "asc")
      .forNoKeyUpdate()
      .execute();

  const installationAuthorityChanged =
    current !== undefined && current.trust !== input.installation.trust;
  const now = new Date();
  const installation = current
    ? await transaction
        .updateTable("integrationInstallations")
        .set({
          description: input.installation.description,
          manifest: jsonValue(input.installation.manifest),
          provenance: jsonValue(input.installation.provenance),
          revision: current.revision + 1,
          pluginId: input.installation.pluginId ?? null,
          sourceKind: input.installation.sourceKind,
          status: input.installation.status,
          title: input.installation.title,
          trust: input.installation.trust,
          updatedAt: now,
          updatedBy: input.actorUserId,
          version: input.installation.version,
        })
        .where("id", "=", current.id)
        .where("revision", "=", current.revision)
        .returningAll()
        .executeTakeFirstOrThrow()
    : await transaction
        .insertInto("integrationInstallations")
        .values({
          createdBy: input.actorUserId,
          description: input.installation.description,
          id: input.installation.id,
          manifest: jsonValue(input.installation.manifest),
          name: input.installation.name,
          provenance: jsonValue(input.installation.provenance),
          revision: 1,
          pluginId: input.installation.pluginId ?? null,
          sourceKind: input.installation.sourceKind,
          status: input.installation.status,
          title: input.installation.title,
          trust: input.installation.trust,
          updatedAt: now,
          updatedBy: input.actorUserId,
          version: input.installation.version,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

  for (const existing of existingServers) {
    const discovered = input.servers.find((s) => s.name === existing.name);
    if (!discovered) continue;
    const retained = input.retainedServer?.(
      { ...existing, transport: IntegrationServerTransportSchema.parse(existing.transport) },
      discovered,
    );
    if (retained && discovered.transport.type === "runner" && discovered.transport.runnerId) {
      await replaceSecrets(
        transaction,
        existing.id,
        discovered.transport.runnerId,
        retained.secrets,
        now,
      );
    }
  }
  if (existingServers.length > 0) {
    const serverIds = existingServers.map(({ id }) => id);
    await transaction
      .selectFrom("integrationTools")
      .select("id")
      .where("serverId", "in", serverIds)
      .orderBy("id", "asc")
      .forNoKeyUpdate()
      .execute();
    await lockToolDefinitionsInTransaction(transaction, serverIds);
  }
  const serverByName = new Map(existingServers.map((server) => [server.name, server]));
  const retainedServerIds: IntegrationServerId[] = [];
  for (const discovered of input.servers) {
    const existing = serverByName.get(discovered.name);
    const previousRunner = existing ? runnerOf(existing.transport) : null;
    if (
      installation.pluginId &&
      previousRunner &&
      previousRunner !== runnerOf(discovered.transport)
    )
      await transaction
        .insertInto("runnerPluginDataRemovals")
        .values({ runnerId: previousRunner as RunnerId, pluginId: installation.pluginId })
        .onConflict((oc) => oc.columns(["runnerId", "pluginId"]).doNothing())
        .execute();
    const server = existing
      ? await transaction
          .updateTable("integrationServers")
          .set({
            connectionRequirement: jsonValue(discovered.connectionRequirement),
            status: discovered.status,
            statusDetail: discovered.statusDetail,
            toolGeneration: existing.toolGeneration + 1,
            transport: jsonValue(discovered.transport),
            updatedAt: now,
            // Consent belongs to the computer that gave it; another one is asked.
            // A declined or retired server that returns is asked again too, even
            // as a launch it once approved.
            ...(runnerOf(existing.transport) === runnerOf(discovered.transport) &&
            existing.status !== "disabled"
              ? {}
              : { approvedLaunchDigest: null }),
          })
          .where("id", "=", existing.id)
          .returningAll()
          .executeTakeFirstOrThrow()
      : await transaction
          .insertInto("integrationServers")
          .values({
            connectionRequirement: jsonValue(discovered.connectionRequirement),
            id: discovered.id,
            installationId: installation.id,
            name: discovered.name,
            status: discovered.status,
            statusDetail: discovered.statusDetail,
            toolGeneration: 1,
            transport: jsonValue(discovered.transport),
            updatedAt: now,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
    retainedServerIds.push(server.id);
    if (discovered.catalog)
      await replaceServerToolsInTransaction(transaction, {
        now,
        serverId: server.id,
        catalog: discovered.catalog,
      });
  }
  if (retainedServerIds.length === 0) {
    await transaction
      .updateTable("integrationServers")
      .set({ status: "disabled", statusDetail: null, updatedAt: now })
      .where("installationId", "=", installation.id)
      .execute();
  } else {
    await transaction
      .updateTable("integrationServers")
      .set({ status: "disabled", statusDetail: null, updatedAt: now })
      .where("installationId", "=", installation.id)
      .where("id", "not in", retainedServerIds)
      .execute();
  }
  if (input.computerConnectionTools) {
    const definition = IntegrationDefinitionSummarySchema.parse(
      input.installation.manifest.definition,
    );
    // Rematerializing the server above already advanced its generation. The
    // connection rows join that same authority change without advancing it a
    // second time.
    await reconcileComputerConnectionToolsInTransaction(transaction, {
      definitionId: definition.id,
      tools: input.computerConnectionTools,
    });
  }
  const pendingAccessRequests = await transaction
    .selectFrom("requests")
    .innerJoin("integrationRequestDetails", "integrationRequestDetails.requestId", "requests.id")
    .select("requests.id")
    .where("requests.kind", "=", "integration.access")
    .where("requests.status", "=", "pending")
    .where("integrationRequestDetails.installationId", "=", installation.id)
    .forNoKeyUpdate("requests")
    .execute();
  const invalidatedRequestIds =
    input.installation.status !== "active" || installationAuthorityChanged
      ? pendingAccessRequests.map(({ id }) => id)
      : [];
  const requestEvents = await cancelPending(transaction, {
    reason: "authority-revoked",
    requestIds: invalidatedRequestIds,
    resolvedAt: now,
  });
  await transaction
    .insertInto("securityAudit")
    .values({
      action: current ? "integration.installation.updated" : "integration.installation.created",
      actorSessionId: null,
      actorUserId: input.actorUserId,
      id: createId("securityAudit"),
      metadata: jsonValue({
        name: installation.name,
        revision: installation.revision,
        sourceKind: installation.sourceKind,
      }),
      requestId: input.requestId,
      targetId: installation.id,
      targetType: "integration-installation",
    })
    .executeTakeFirstOrThrow();
  return { installation: installationFromRow(installation), requestEvents };
}

function exactCatalogDefinitionId(
  installation: Pick<IntegrationInstallation, "provenance" | "sourceKind">,
): string | null {
  if (installation.sourceKind !== "built-in") return null;
  const parsed = IntegrationDefinitionIdSchema.safeParse(installation.provenance.definitionId);
  return parsed.success ? parsed.data : null;
}

export class IntegrationInstallStore extends IntegrationPlatformStoreBase {
  async install(input: InstallIntegrationInput): Promise<InstallIntegrationMutation> {
    return withPersonalTransaction(this.database, async (transaction) =>
      administrationCommand(transaction, input.administration, async () => {
        await input.beforeInstall?.(transaction);
        const mutation = await installIntegrationInTransaction(transaction, input);
        if (input.actorUserId !== null)
          await requestSettlementActor(transaction, input.actorUserId, input.settlementSessionId);
        return mutation;
      }),
    );
  }

  async uninstall(input: UninstallIntegrationInput): Promise<UninstallIntegrationMutation> {
    return withPersonalTransaction(this.database, (transaction) =>
      administrationCommand(transaction, input.administration, () =>
        uninstallIntegrationInTransaction(transaction, input),
      ),
    );
  }

  async markNeedsAttention(
    installationId: IntegrationInstallationId,
    reason: string,
  ): Promise<void> {
    await withPersonalTransaction(this.database, (transaction) =>
      markNeedsAttentionInTransaction(transaction, installationId, reason),
    );
  }

  async listInstallations(): Promise<readonly IntegrationInstallation[]> {
    const rows = await this.database
      .selectFrom("integrationInstallations")
      .selectAll()
      .orderBy("title", "asc")
      .limit(1_000)
      .execute();
    return rows.map(installationFromRow);
  }

  async listComputerDeviceIdsForInstallation(
    installationId: IntegrationInstallationId,
  ): Promise<readonly DeviceId[]> {
    const rows = await this.database
      .selectFrom("integrationConnections")
      .innerJoin(
        "integrationServers",
        "integrationServers.id",
        "integrationConnections.integrationServerId",
      )
      .select(computerConnectionDeviceId.as("deviceId"))
      .where("integrationServers.installationId", "=", installationId)
      .where("integrationConnections.connectionKind", "=", "computer")
      .where("integrationConnections.status", "!=", "revoked")
      .where(computerConnectionDeviceId, "is not", null)
      .distinct()
      .orderBy(computerConnectionDeviceId)
      .execute();
    return rows.flatMap(({ deviceId }) => (deviceId ? [deviceId] : []));
  }

  async listComputerRunnerIdsForInstallation(
    installationId: IntegrationInstallationId,
  ): Promise<readonly RunnerId[]> {
    const rows = await this.database
      .selectFrom("integrationConnections")
      .innerJoin(
        "integrationServers",
        "integrationServers.id",
        "integrationConnections.integrationServerId",
      )
      .innerJoin("deviceDrivers", (join) =>
        join.on("deviceDrivers.deviceId", "=", computerConnectionDeviceId),
      )
      .select("deviceDrivers.runnerId")
      .where("deviceDrivers.role", "=", "self")
      .where("deviceDrivers.detachedAt", "is", null)
      .distinct()
      .where("integrationServers.installationId", "=", installationId)
      .where("integrationConnections.connectionKind", "=", "computer")
      .where("integrationConnections.status", "!=", "revoked")
      .where("deviceDrivers.runnerId", "is not", null)
      .orderBy("deviceDrivers.runnerId", "asc")
      .execute();
    const servers = await this.database
      .selectFrom("integrationServers")
      .select("transport")
      .where("installationId", "=", installationId)
      .execute();
    return [
      ...new Set([
        ...rows.flatMap(({ runnerId }) => (runnerId === null ? [] : [runnerId])),
        ...servers.flatMap(({ transport }) => {
          const parsed = IntegrationServerTransportSchema.parse(transport);
          return parsed.type === "runner" && parsed.runnerId ? [parsed.runnerId] : [];
        }),
      ]),
    ].sort();
  }

  async listDiscoveryInventory(input: IntegrationDiscoveryRequester): Promise<
    readonly {
      readonly accounts: readonly {
        readonly access: IntegrationAccess | null;
        readonly account: string;
        readonly connectionId: IntegrationConnectionId;
        readonly isDefault: boolean;
      }[];
      readonly installation: IntegrationInstallation;
      readonly readiness: {
        readonly forTarget?: (
          serverId: IntegrationServerId,
          target: IntegrationReadinessTarget,
        ) => IntegrationReadiness | undefined;
        readonly servers: readonly IntegrationReadiness[];
        readonly tools: readonly {
          readonly readiness: IntegrationReadiness;
          readonly toolId: IntegrationToolId;
        }[];
      };
      readonly servers: readonly IntegrationServer[];
      readonly tools: readonly IntegrationTool[];
    }[]
  > {
    const provider = input.provider;
    const page = (after: IntegrationInstallationId | null) =>
      this.database
        .selectFrom("integrationInstallations")
        .selectAll()
        .$if(after !== null, (query) => query.where("id", ">", after!))
        .$if(provider !== undefined, (query) =>
          query.where(({ exists, selectFrom }) => {
            let server = selectFrom("integrationServers")
              .select("integrationServers.id")
              .whereRef("integrationServers.installationId", "=", "integrationInstallations.id");
            if (provider && "serverId" in provider)
              server = server.where("integrationServers.id", "=", provider.serverId);
            else if (provider)
              server = server.where("integrationServers.id", "=", (eb) =>
                eb
                  .selectFrom("integrationConnections")
                  .select("integrationServerId")
                  .where("id", "=", provider.connectionId)
                  .where("ownerUserId", "=", input.ownerUserId),
              );
            return exists(server);
          }),
        )
        .orderBy("id", "asc")
        .limit(discoveryInventoryPage)
        .execute();
    // Every installation, a page at a time by its id, so none is left out however many there are.
    const allInstallations = async () => {
      const rows: Awaited<ReturnType<typeof page>> = [];
      for (;;) {
        const next = await page(rows.at(-1)?.id ?? null);
        rows.push(...next);
        if (next.length < discoveryInventoryPage) return rows;
      }
    };
    const [installations, authority, grants] = await Promise.all([
      allInstallations(),
      this.authoritySnapshot(input.ownerUserId),
      this.activeGrants({ ownerUserId: input.ownerUserId }),
    ]);
    const activeGrants = grants.filter(({ status }) => status === "active");
    const { connections } = authority;
    const requesterAccess = await resolveResourceAccess(this.database, input);
    return Promise.all(
      installations.map(async (row) => {
        const installation = installationFromRow(row);
        const [servers, tools] = await Promise.all([
          this.listServers(row.id),
          this.listTools(row.id, input.ownerUserId),
        ]);
        const serverById = new Map(servers.map((server) => [server.id, server]));
        const installationConnections = connections.filter((connection) =>
          servers.some((server) => {
            const requirement = server.connectionRequirement;
            return (
              requirement.kind === "computer" &&
              connection.connectionKind === "computer" &&
              connection.definitionId === requirement.definitionId &&
              connection.integrationServerId === server.id
            );
          }),
        );
        const hasInstallationAccess = (
          connectionId: IntegrationConnectionId | null,
          requiredAccess: IntegrationAccess,
        ) => {
          if (!integrationAccessCovers(requesterAccess.runAccess, requiredAccess)) return false;
          const connection =
            connectionId === null
              ? null
              : (installationConnections.find(({ id }) => id === connectionId) ?? null);
          return activeGrants.some((grant) => {
            const access = effectiveIntegrationAccess(grant.access, connection);
            return (
              grant.installationId === installation.id &&
              grant.connectionId === connectionId &&
              access !== null &&
              integrationAccessCovers(access, requiredAccess)
            );
          });
        };
        const readinessFor = (
          server: IntegrationServer,
          requiredAccess: IntegrationAccess,
          requiredConnectionId: IntegrationConnectionId | null,
        ): IntegrationReadiness =>
          resolveIntegrationReadiness({
            connectionRequirement: server.connectionRequirement,
            connections,
            hasAccess: hasInstallationAccess,
            runAccess: requesterAccess.runAccess,
            installationStatus: installation.status,
            requiredAccess,
            requiredConnectionId,
            serverId: server.id,
            serverStatus: server.status,
            statusDetail: server.statusDetail,
          });
        return {
          accounts: installationConnections.map((connection) => {
            const grant = activeGrants.find(
              (candidate) =>
                candidate.installationId === installation.id &&
                candidate.connectionId === connection.id,
            );
            return {
              access: grant ? effectiveIntegrationAccess(grant.access, connection) : null,
              account: integrationAccountLabel(connection),
              connectionId: connection.id,
              isDefault: grant?.isDefault ?? false,
            };
          }),
          installation,
          readiness: {
            ...(input.includeTargetReadiness
              ? {
                  forTarget: (
                    serverId: IntegrationServerId,
                    target: IntegrationReadinessTarget,
                  ) => {
                    const server = serverById.get(serverId);
                    return server && readinessFor(server, target.access, target.connectionId);
                  },
                }
              : {}),
            servers: servers.map((server) =>
              readinessFor(
                server,
                input.target?.access ?? "read",
                input.target?.connectionId ?? null,
              ),
            ),
            tools: tools.flatMap((tool) => {
              const server = serverById.get(tool.serverId);
              return server
                ? [
                    {
                      readiness: readinessFor(
                        server,
                        input.target?.access ??
                          (integrationToolEffect(tool.annotations) === "read"
                            ? "read"
                            : "read-write"),
                        tool.connectionId ?? input.target?.connectionId ?? null,
                      ),
                      toolId: tool.id,
                    },
                  ]
                : [];
            }),
          },
          servers,
          tools,
        };
      }),
    );
  }

  async listServers(
    installationId: IntegrationInstallationId,
  ): Promise<readonly IntegrationServer[]> {
    const rows = await this.database
      .selectFrom("integrationServers")
      .selectAll()
      .where("installationId", "=", installationId)
      .where("status", "!=", "disabled")
      .orderBy("name", "asc")
      .limit(100)
      .execute();
    return rows.map(serverFromRow);
  }

  async listTools(
    installationId: IntegrationInstallationId,
    ownerUserId?: UserId,
  ): Promise<readonly IntegrationTool[]> {
    const rows = await this.database
      .selectFrom("integrationTools")
      .innerJoin("integrationServers", "integrationServers.id", "integrationTools.serverId")
      .select(integrationToolListingColumns)
      .where("integrationServers.installationId", "=", installationId)
      // A server that cannot be called now still lists its tools; readiness says why.
      .where("integrationServers.status", "!=", "disabled")
      .where("integrationTools.status", "=", "active")
      .$if(ownerUserId !== undefined, (builder) =>
        builder.where(
          sql<boolean>`(
            integration_tools.connection_id is null or exists (
              select 1 from integration_connections c
              where c.id = integration_tools.connection_id
                and c.owner_user_id = ${ownerUserId!}
                and c.status = 'connected'
            )
          )`,
        ),
      )
      .orderBy("integrationServers.name", "asc")
      .orderBy("integrationTools.name", "asc")
      .limit(5_000)
      .execute();
    return rows.map(toolFromRow);
  }
}

export class IntegrationConnectionAuthStore extends IntegrationPlatformStoreBase {
  async getConnectionAccount(input: {
    readonly connectionId: IntegrationConnectionId;
    readonly ownerUserId: UserId;
  }) {
    return (
      (await this.database
        .selectFrom("integrationConnections")
        .select(["displayName", "accountIdentifier"])
        .where("id", "=", input.connectionId)
        .where("ownerUserId", "=", input.ownerUserId)
        .executeTakeFirst()) ?? null
    );
  }

  async getConnectionKind(input: {
    readonly connectionId: IntegrationConnectionId;
    readonly ownerUserId: UserId;
  }): Promise<IntegrationConnectionTable["connectionKind"] | null> {
    const row = await this.database
      .selectFrom("integrationConnections")
      .select("connectionKind")
      .where("id", "=", input.connectionId)
      .where("ownerUserId", "=", input.ownerUserId)
      .executeTakeFirst();
    return row?.connectionKind ?? null;
  }
}

export type { CreateIntegrationGrantInput } from "./integration-grant-write.js";

export class IntegrationGrantStore extends IntegrationPlatformStoreBase {
  readonly #callableToolsCache = new IntegrationAuthorityCache<
    readonly CallableIntegrationTool[]
  >();

  async createGrant(input: CreateIntegrationGrantInput): Promise<IntegrationGrant> {
    return withPersonalTransaction(this.database, async (transaction) => {
      // Standalone grants have no Request/approval transaction to fence their
      // parents. Hold those fences before the grant scope, then validate current
      // membership and resource state in createGrantInTransaction.
      await transaction
        .selectFrom("integrationInstallations")
        .select("id")
        .where("id", "=", input.installationId)
        .forShare()
        .execute();
      await transaction
        .selectFrom("integrationServers")
        .select("id")
        .where("installationId", "=", input.installationId)
        .orderBy("id", "asc")
        .forShare()
        .execute();
      if (input.connectionId)
        await transaction
          .selectFrom("integrationConnections")
          .select("id")
          .where("id", "=", input.connectionId)
          .forShare()
          .executeTakeFirst();
      return this.createGrantInTransaction(transaction, input);
    });
  }

  async createGrantInTransaction(
    transaction: Transaction<DatabaseSchema>,
    input: CreateIntegrationGrantInput,
  ): Promise<IntegrationGrant> {
    return writeIntegrationGrantInTransaction(transaction, input);
  }

  async listGrants(input: { readonly ownerUserId: UserId }): Promise<readonly IntegrationGrant[]> {
    const rows = await this.database
      .selectFrom("integrationGrants")
      .selectAll()
      .where("ownerUserId", "=", input.ownerUserId)
      .where("revokedAt", "is", null)
      .orderBy("installationId", "asc")
      .orderBy("isDefault", "desc")
      .orderBy("alias", "asc")
      .execute();
    return rows.map(integrationGrantFromRow);
  }

  async isConnectionUsableForAccessRequest(input: {
    readonly connectionId: IntegrationConnectionId;
    readonly installationId: IntegrationInstallationId;
    readonly ownerUserId: UserId;
    readonly requestedServerId: IntegrationServerId | null;
  }): Promise<boolean> {
    const requestedServerId = input.requestedServerId;
    const [{ connections }, servers] = await Promise.all([
      this.authoritySnapshot(input.ownerUserId),
      this.database
        .selectFrom("integrationServers")
        .innerJoin(
          "integrationInstallations",
          "integrationInstallations.id",
          "integrationServers.installationId",
        )
        .select(["integrationServers.connectionRequirement", "integrationServers.id"])
        .where("integrationServers.installationId", "=", input.installationId)
        .where("integrationServers.status", "=", "active")
        .where("integrationInstallations.status", "=", "active")
        .$if(requestedServerId !== null, (query) =>
          query.where("integrationServers.id", "=", requestedServerId),
        )
        .execute(),
    ]);
    const connection = connections.find(({ id }) => id === input.connectionId);
    if (!connection) return false;
    return servers.some((server) =>
      isIntegrationConnectionEligible({
        connection,
        connectionRequirement: IntegrationConnectionRequirementSchema.parse(
          server.connectionRequirement,
        ),
      }),
    );
  }

  async revokeGrant(input: {
    readonly administration?: AdministrationCommandIdentity | undefined;
    readonly grantId: IntegrationGrant["id"];
    readonly ownerUserId: UserId;
    readonly requestId: string;
  }): Promise<void> {
    await withPersonalTransaction(this.database, async (transaction) =>
      administrationCommand(transaction, input.administration, async () => {
        const row = await transaction
          .updateTable("integrationGrants")
          .set({
            isDefault: false,
            revokedAt: new Date(),
            status: "revoked",
            updatedAt: new Date(),
          })
          .where("id", "=", input.grantId)
          .where("ownerUserId", "=", input.ownerUserId)
          .where("revokedAt", "is", null)
          .returning(["id", "installationId"])
          .executeTakeFirst();
        if (!row)
          throw new OpensteerError({ code: "not_found", message: "Integration grant not found" });
        await transaction
          .insertInto("securityAudit")
          .values({
            action: "integration.grant.revoked",
            actorSessionId: null,
            actorUserId: input.ownerUserId,
            id: createId("securityAudit"),
            metadata: jsonValue({ installationId: row.installationId }),
            requestId: input.requestId,
            targetId: row.id,
            targetType: "integration-grant",
          })
          .executeTakeFirstOrThrow();
      }),
    );
  }

  async listCallableTools(
    input: IntegrationRequester,
  ): Promise<readonly CallableIntegrationTool[]> {
    const authority = await resolveResourceAccess(this.database, input);
    const permitted = (tools: readonly CallableIntegrationTool[]) =>
      tools.filter(
        (tool) =>
          authority.runAccess === "read-write" ||
          integrationToolEffect(tool.tool.annotations) === "read",
      );
    const scope = { ownerUserId: input.ownerUserId };
    for (;;) {
      const generation = await this.authorityGeneration(input.ownerUserId);
      const cached = this.#callableToolsCache.get({ ...scope, generation });
      if (cached) return permitted(cached);
      const resolved = await this.resolveCallableTools(input);
      const verifiedGeneration = await this.authorityGeneration(input.ownerUserId);
      if (verifiedGeneration !== generation) continue;
      this.#callableToolsCache.set({ ...scope, generation }, resolved);
      return permitted(resolved);
    }
  }

  async getToolSchemas(toolId: IntegrationToolId): Promise<IntegrationToolSchemas | null> {
    const row = await this.database
      .selectFrom("integrationTools")
      .leftJoin("integrationToolDefinitions", (join) =>
        join
          .onRef("integrationToolDefinitions.serverId", "=", "integrationTools.serverId")
          .on(
            sql<boolean>`integration_tool_definitions.connection_id is not distinct from integration_tools.connection_id`,
          ),
      )
      .select([
        "integrationTools.inputSchema",
        "integrationTools.outputSchema",
        "integrationTools.schemaDigest",
        "integrationTools.status",
      ])
      .select(
        sql<IntegrationToolSchemas["definitions"]>`coalesce((
        select jsonb_object_agg(name, integration_tool_definitions.definitions -> name)
        from unnest(integration_tools.definition_names) as name
        where integration_tool_definitions.definitions ? name
      ), '{}'::jsonb)`.as("definitions"),
      )
      .where("integrationTools.id", "=", toolId)
      .executeTakeFirst();
    if (!row) return null;
    if (storedToolSchemaDigest(row) !== row.schemaDigest) {
      throw new OpensteerError({
        code: "conflict",
        message: "Integration operation changed; search again",
      });
    }
    return row;
  }

  private async authorityGeneration(ownerUserId: UserId): Promise<number> {
    const row = await this.database
      .selectFrom("integrationAuthorityGenerations")
      .select("generation")
      .where("ownerUserId", "=", ownerUserId)
      .executeTakeFirst();
    return row?.generation ?? 0;
  }

  private async resolveCallableTools(input: {
    readonly ownerUserId: UserId;
  }): Promise<readonly CallableIntegrationTool[]> {
    const grants = await this.listGrants(input);
    const activeGrants = grants.filter(({ status }) => status === "active");
    if (activeGrants.length === 0) return [];
    const rows = await this.database
      .selectFrom("integrationTools")
      .innerJoin("integrationServers", "integrationServers.id", "integrationTools.serverId")
      .innerJoin(
        "integrationInstallations",
        "integrationInstallations.id",
        "integrationServers.installationId",
      )
      .select(integrationToolListingColumns)
      .select([
        "integrationServers.id as joinedServerId",
        "integrationServers.connectionRequirement as joinedServerConnectionRequirement",
        "integrationServers.installationId as joinedInstallationId",
        "integrationServers.name as joinedServerName",
        "integrationServers.transport as joinedTransport",
        "integrationServers.status as joinedServerStatus",
        "integrationServers.statusDetail as joinedServerStatusDetail",
        "integrationServers.toolGeneration as joinedToolGeneration",
        "integrationServers.updatedAt as joinedServerUpdatedAt",
      ])
      .select([
        "integrationInstallations.id as joinedInstallationRecordId",
        "integrationInstallations.name as joinedInstallationName",
        "integrationInstallations.title as joinedInstallationTitle",
        "integrationInstallations.description as joinedInstallationDescription",
        "integrationInstallations.version as joinedInstallationVersion",
        "integrationInstallations.sourceKind as joinedInstallationSourceKind",
        "integrationInstallations.trust as joinedInstallationTrust",
        "integrationInstallations.manifest as joinedInstallationManifest",
        "integrationInstallations.provenance as joinedInstallationProvenance",
        "integrationInstallations.status as joinedInstallationStatus",
        "integrationInstallations.revision as joinedInstallationRevision",
        "integrationInstallations.createdAt as joinedInstallationCreatedAt",
        "integrationInstallations.updatedAt as joinedInstallationUpdatedAt",
      ])
      .where("integrationTools.status", "=", "active")
      .where("integrationServers.status", "=", "active")
      .where("integrationInstallations.status", "=", "active")
      .orderBy("integrationInstallations.name", "asc")
      .orderBy("integrationServers.name", "asc")
      .orderBy("integrationTools.name", "asc")
      .execute();
    const { connections } = await this.authoritySnapshot(input.ownerUserId);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const installationById = new Map(
      rows.map((row) => [row.joinedInstallationId, installationFromCallableToolRow(row)]),
    );
    const resolved = resolveEffectiveGrants({
      connections,
      installations: [...installationById.values()],
      ownerUserId: input.ownerUserId,
      storedGrants: grants,
      tools: rows.map((row) => ({
        ...toolFromRow(row),
        connectionRequirement: IntegrationConnectionRequirementSchema.parse(
          row.joinedServerConnectionRequirement,
        ),
        installationId: row.joinedInstallationId,
        serverStatus: row.joinedServerStatus,
      })),
    });
    return resolved.tools.map(({ grant, tool }) => callableToolFromRow(byId.get(tool.id)!, grant));
  }
}

type CallableToolJoinedRow = IntegrationToolListingRow & {
  readonly joinedInstallationCreatedAt: Date;
  readonly joinedInstallationDescription: string;
  readonly joinedInstallationId: IntegrationInstallationId;
  readonly joinedInstallationManifest: unknown;
  readonly joinedInstallationName: string;
  readonly joinedInstallationProvenance: unknown;
  readonly joinedInstallationRecordId: IntegrationInstallationId;
  readonly joinedInstallationRevision: number;
  readonly joinedInstallationSourceKind: IntegrationInstallation["sourceKind"];
  readonly joinedInstallationStatus: IntegrationInstallation["status"];
  readonly joinedInstallationTitle: string;
  readonly joinedInstallationTrust: IntegrationInstallation["trust"];
  readonly joinedInstallationUpdatedAt: Date;
  readonly joinedInstallationVersion: string | null;
  readonly joinedServerConnectionRequirement: unknown;
  readonly joinedServerId: IntegrationServerId;
  readonly joinedServerName: string;
  readonly joinedServerStatus: IntegrationServer["status"];
  readonly joinedServerStatusDetail: string | null;
  readonly joinedServerUpdatedAt: Date;
  readonly joinedToolGeneration: number;
  readonly joinedTransport: unknown;
};

/** A computer app's installation names exactly one computer server for its own definition. */
function validateInstallation(input: {
  readonly installation: Omit<IntegrationInstallation, "createdAt" | "revision" | "updatedAt">;
  readonly servers: readonly DiscoveredIntegrationServer[];
}): void {
  const computerServers = input.servers.filter(({ transport }) => transport.type === "computer");
  const computerRequirementServers = input.servers.filter(({ connectionRequirement }) => {
    const parsed = IntegrationConnectionRequirementSchema.safeParse(connectionRequirement);
    return parsed.success && parsed.data.kind === "computer";
  });
  const parsedDefinition = IntegrationDefinitionSummarySchema.safeParse(
    input.installation.manifest.definition,
  );
  if (
    computerServers.length > 0 ||
    computerRequirementServers.length > 0 ||
    parsedDefinition.data?.adapter === "computer"
  ) {
    if (!parsedDefinition.success || parsedDefinition.data.adapter !== "computer") {
      throw invalidAdapterInstallation(
        "A computer server requires one verified computer app definition",
      );
    }
    if (input.servers.length !== 1 || computerServers.length !== 1) {
      throw invalidAdapterInstallation("A computer app requires exactly one computer server");
    }
    const server = computerServers[0]!;
    const requirement = IntegrationConnectionRequirementSchema.parse(server.connectionRequirement);
    if (
      server.transport.type !== "computer" ||
      server.transport.definitionId !== parsedDefinition.data.id ||
      requirement.kind !== "computer" ||
      requirement.definitionId !== parsedDefinition.data.id
    ) {
      throw invalidAdapterInstallation("A computer server must match its installation definition");
    }
    if (server.catalog?.tools.length) {
      throw invalidAdapterInstallation("A computer server cannot carry server-level tools");
    }
  }
}

function invalidAdapterInstallation(message: string, cause?: unknown): OpensteerError {
  return new OpensteerError({ cause, code: "bad_request", message });
}

function callableToolFromRow(
  row: CallableToolJoinedRow,
  grant: EffectiveIntegrationGrant,
): CallableIntegrationTool {
  return {
    grant,
    installation: installationFromCallableToolRow(row),
    server: IntegrationServerSchema.parse({
      connectionRequirement: row.joinedServerConnectionRequirement,
      id: row.joinedServerId,
      installationId: row.joinedInstallationId,
      name: row.joinedServerName,
      status: row.joinedServerStatus,
      statusDetail: row.joinedServerStatusDetail,
      toolGeneration: row.joinedToolGeneration,
      transport: row.joinedTransport,
      updatedAt: row.joinedServerUpdatedAt.toISOString(),
    }),
    tool: toolFromRow(row),
  };
}

function installationFromCallableToolRow(row: CallableToolJoinedRow): IntegrationInstallation {
  return IntegrationInstallationSchema.parse({
    createdAt: row.joinedInstallationCreatedAt.toISOString(),
    description: row.joinedInstallationDescription,
    id: row.joinedInstallationRecordId,
    manifest: row.joinedInstallationManifest,
    name: row.joinedInstallationName,
    provenance: row.joinedInstallationProvenance,
    revision: row.joinedInstallationRevision,
    sourceKind: row.joinedInstallationSourceKind,
    status: row.joinedInstallationStatus,
    title: row.joinedInstallationTitle,
    trust: row.joinedInstallationTrust,
    updatedAt: row.joinedInstallationUpdatedAt.toISOString(),
    version: row.joinedInstallationVersion,
  });
}

/**
 * Rebuilds the definition an installation was materialized from. The public manifest carries every
 * catalog fact except adapter configuration — the installations table forbids it there — so the
 * host-private snapshot supplies that half, and the two together are the same definition shape the
 * static catalog exposes.
 */
function installationFromRow(
  row: Selectable<IntegrationInstallationTable>,
): IntegrationInstallation {
  return IntegrationInstallationSchema.parse({
    createdAt: row.createdAt.toISOString(),
    description: row.description,
    id: row.id,
    pluginId: row.pluginId,
    manifest: row.manifest,
    name: row.name,
    provenance: row.provenance,
    revision: row.revision,
    sourceKind: row.sourceKind,
    status: row.status,
    title: row.title,
    trust: row.trust,
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  });
}

function serverFromRow(row: Selectable<IntegrationServerTable>): IntegrationServer {
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

function toolFromRow(row: IntegrationToolListingRow): IntegrationTool {
  return IntegrationToolSchema.parse({
    annotations: row.annotations,
    connectionId: row.connectionId,
    description: row.description,
    id: row.id,
    name: row.name,
    schemaDigest: row.schemaDigest,
    serverId: row.serverId,
    status: row.status,
    title: row.title,
  });
}

async function reconcileComputerConnectionToolsInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly definitionId: string;
    readonly tools: (
      connectionId: IntegrationConnectionId,
      access: IntegrationAccess,
    ) => readonly IntegrationToolMaterial[];
  },
): Promise<void> {
  const server = await transaction
    .selectFrom("integrationServers")
    .innerJoin(
      "integrationInstallations",
      "integrationInstallations.id",
      "integrationServers.installationId",
    )
    .selectAll("integrationServers")
    .where("integrationInstallations.status", "=", "active")
    .where("integrationServers.status", "=", "active")
    .where(
      sql<boolean>`integration_installations.manifest -> 'definition' ->> 'id' = ${input.definitionId}`,
    )
    .orderBy("integrationServers.id", "asc")
    .forNoKeyUpdate("integrationServers")
    .executeTakeFirst();
  if (!server) {
    throw new OpensteerError({ code: "not_found", message: "Computer app is not installed" });
  }
  const transport = IntegrationServerSchema.shape.transport.parse(server.transport);
  const requirement = IntegrationConnectionRequirementSchema.parse(server.connectionRequirement);
  if (
    transport.type !== "computer" ||
    transport.definitionId !== input.definitionId ||
    requirement.kind !== "computer" ||
    requirement.definitionId !== input.definitionId
  ) {
    throw new OpensteerError({
      code: "conflict",
      message: "Installed computer app server does not match its definition",
    });
  }
  const connections = await transaction
    .selectFrom("integrationConnections")
    .select(["computerAccess", "computerBlockedAt", "id"])
    .where("connectionKind", "=", "computer")
    .where("integrationDefinitionId", "=", input.definitionId)
    .where("integrationServerId", "=", server.id)
    .where("status", "!=", "revoked")
    .orderBy("id", "asc")
    .forNoKeyUpdate()
    .execute();
  const now = new Date();
  if (connections.length > 0) {
    await transaction
      .selectFrom("integrationTools")
      .select("id")
      .where("serverId", "=", server.id)
      .where(
        "connectionId",
        "in",
        connections.map(({ id }) => id),
      )
      .orderBy("id", "asc")
      // FOR UPDATE: reconciliation deletes missing computer tools in every connection scope.
      .forUpdate()
      .execute();
    await lockToolDefinitionsInTransaction(transaction, [server.id]);
  }
  for (const connection of connections) {
    if (!connection.computerAccess) throw new Error("Computer connection has no access ceiling");
    await upsertConnectionTools(
      transaction,
      server.id,
      connection.id,
      {
        definitions: {},
        tools:
          connection.computerBlockedAt === null
            ? input.tools(connection.id, connection.computerAccess)
            : [],
      },
      now,
      "delete",
    );
  }
}

export async function upsertConnectionTools(
  transaction: Transaction<DatabaseSchema>,
  serverId: IntegrationServerId,
  connectionId: IntegrationConnectionId,
  catalog: IntegrationToolCatalog,
  now: Date,
  missing: "delete" | "disable" = "disable",
): Promise<void> {
  const material = await prepareToolCatalog(transaction, catalog, serverId, connectionId);
  const existing = await transaction
    .selectFrom("integrationTools")
    .select(["id", "name"])
    .where("serverId", "=", serverId)
    .where("connectionId", "=", connectionId)
    .orderBy("id", "asc")
    .$call((query) =>
      // FOR UPDATE: Tool reconciliation deletes missing tools when requested.
      missing === "delete" ? query.forUpdate() : query.forNoKeyUpdate(),
    )
    .execute();
  const byName = new Map(existing.map((tool) => [tool.name, tool]));
  const retained: IntegrationToolId[] = [];
  for (const tool of material.tools) {
    if (tool.connectionId !== connectionId) {
      throw new OpensteerError({
        code: "bad_request",
        message: `Integration tool ${tool.name} is not scoped to its exact connection`,
      });
    }
    const current = byName.get(tool.name);
    const id = current?.id ?? tool.id;
    retained.push(id);
    const values = {
      annotations: jsonValue(tool.annotations),
      connectionId,
      definitionNames: [...tool.definitionNames],
      description: tool.description,
      inputSchema: jsonValue(tool.inputSchema),
      outputSchema: tool.outputSchema === null ? null : jsonValue(tool.outputSchema),
      schemaDigest: tool.schemaDigest,
      status: tool.status,
      title: tool.title,
      updatedAt: now,
    };
    if (current) {
      await transaction
        .updateTable("integrationTools")
        .set(values)
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
    } else {
      await transaction
        .insertInto("integrationTools")
        .values({ ...values, id, name: tool.name, serverId })
        .executeTakeFirstOrThrow();
    }
  }
  if (missing === "delete") {
    await transaction
      .deleteFrom("integrationTools")
      .where("serverId", "=", serverId)
      .where("connectionId", "=", connectionId)
      .$if(retained.length > 0, (builder) => builder.where("id", "not in", retained))
      .execute();
  } else {
    await transaction
      .updateTable("integrationTools")
      .set({ status: "disabled", updatedAt: now })
      .where("serverId", "=", serverId)
      .where("connectionId", "=", connectionId)
      .$if(retained.length > 0, (builder) => builder.where("id", "not in", retained))
      .execute();
  }
  await lockToolDefinitionsInTransaction(transaction, [serverId], connectionId);
  await writeToolDefinitionsInTransaction(transaction, {
    connectionId,
    definitions: material.definitions,
    now,
    serverId,
  });
}

async function prepareToolCatalog(
  transaction: Transaction<DatabaseSchema>,
  catalog: IntegrationToolCatalog,
  serverId: IntegrationServerId,
  connectionId: IntegrationConnectionId | null,
): Promise<ReturnType<typeof materializeToolCatalog>> {
  const tools = catalog.tools.map((tool) => {
    const parsed = IntegrationToolMaterialSchema.safeParse(tool);
    if (!parsed.success) {
      throw new OpensteerError({
        code: "bad_request",
        message: `Integration tool ${tool.name} on server ${serverId} is invalid: ${parsed.error.message}`,
      });
    }
    if (Buffer.byteLength(parsed.data.name, "utf8") > 512) {
      throw new OpensteerError({
        code: "bad_request",
        message: `Integration tool ${tool.name} on server ${serverId} has a name exceeding 512 bytes`,
      });
    }
    return parsed.data;
  });
  try {
    const definitions = Object.fromEntries(
      Object.entries(
        IntegrationToolMaterialSchema.shape.inputSchema.parse(catalog.definitions),
      ).map(([name, definition]) => [
        name,
        IntegrationToolMaterialSchema.shape.inputSchema.parse(definition),
      ]),
    );
    if (
      Object.keys(definitions).length > 0 &&
      tools.some((tool) => tool.connectionId !== connectionId)
    ) {
      throw new TypeError("A shared catalog must contain only tools in its exact connection scope");
    }
    const material = materializeToolCatalog({ definitions, tools });
    // jsonb text adds spaces and expands numbers; measure its actual representation
    // before any write so a PostgreSQL CHECK is never the first size guard.
    const documents = [
      material.definitions,
      ...material.tools.flatMap((tool) => [tool.inputSchema, tool.outputSchema, tool.annotations]),
    ];
    const sizes = await sql<{ bytes: number; ordinal: number }>`
      select octet_length(value::text) as bytes, ordinality::integer as ordinal
      from jsonb_array_elements(${jsonValue(documents)}) with ordinality
    `.execute(transaction);
    for (const { bytes, ordinal } of sizes.rows) {
      const limit = ordinal === 1 ? 8_388_608 : (ordinal - 2) % 3 === 2 ? 65_536 : 1_048_576;
      if (bytes <= limit) continue;
      const tool = material.tools[Math.floor((ordinal - 2) / 3)];
      throw new OpensteerError({
        code: "bad_request",
        message:
          ordinal === 1
            ? `Integration server ${serverId} definitions exceed ${limit} bytes`
            : `Integration tool ${tool!.name} on server ${serverId} exceeds the ${limit} byte document limit`,
      });
    }
    return material;
  } catch (error) {
    if (error instanceof OpensteerError) throw error;
    throw new OpensteerError({
      code: "bad_request",
      message: `Integration server ${serverId} has invalid tool material: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

async function lockToolDefinitionsInTransaction(
  transaction: Transaction<DatabaseSchema>,
  serverIds: readonly IntegrationServerId[],
  connectionId?: IntegrationConnectionId | null,
): Promise<void> {
  // Nullable scope identities have no primary key; ctid orders the existing rows.
  await transaction
    .selectFrom("integrationToolDefinitions")
    .select("serverId")
    .where("serverId", "in", [...serverIds])
    .$if(connectionId !== undefined, (query) =>
      query.where("connectionId", connectionId === null ? "is" : "=", connectionId!),
    )
    .orderBy(sql`ctid`)
    // FOR UPDATE: scope replacement deletes a document when no shared definitions remain.
    .forUpdate()
    .execute();
}

async function writeToolDefinitionsInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly connectionId: IntegrationConnectionId | null;
    readonly definitions: IntegrationToolCatalog["definitions"];
    readonly now: Date;
    readonly serverId: IntegrationServerId;
  },
): Promise<void> {
  if (Object.keys(input.definitions).length === 0) {
    await transaction
      .deleteFrom("integrationToolDefinitions")
      .where("serverId", "=", input.serverId)
      .where("connectionId", input.connectionId === null ? "is" : "=", input.connectionId)
      .execute();
    return;
  }
  await transaction
    .insertInto("integrationToolDefinitions")
    .values({
      connectionId: input.connectionId,
      definitions: jsonValue(input.definitions),
      serverId: input.serverId,
      updatedAt: input.now,
    })
    .onConflict((conflict) =>
      conflict
        .columns(["serverId", "connectionId"])
        .doUpdateSet({ definitions: jsonValue(input.definitions), updatedAt: input.now }),
    )
    .execute();
}

async function markNeedsAttentionInTransaction(
  transaction: Transaction<DatabaseSchema>,
  installationId: IntegrationInstallationId,
  reason: string,
): Promise<void> {
  const now = new Date();
  await transaction
    .updateTable("integrationInstallations")
    .set({ status: "needs-attention", updatedAt: now })
    .where("id", "=", installationId)
    .where("status", "!=", "needs-attention")
    .execute();
  await transaction
    .updateTable("integrationServers")
    .set({ status: "needs-attention", statusDetail: reason, updatedAt: now })
    .where("installationId", "=", installationId)
    .where((eb) =>
      eb.or([
        eb("status", "!=", "needs-attention"),
        eb("statusDetail", "is distinct from", reason),
      ]),
    )
    .execute();
}

/** A tool that records its target is that operation, whatever it is named. */
function toolIdentity(tool: {
  readonly connectionId: IntegrationConnectionId | null;
  readonly name: string;
  readonly target?: Readonly<Record<string, unknown>> | null | undefined;
}): string {
  return `${tool.connectionId ?? "deployment"}\0${
    tool.target ? `target\0${canonicalJson(tool.target)}` : `name\0${tool.name}`
  }`;
}

/** The computer that runs a server, or null for one the Host reaches itself. */
function runnerOf(transport: unknown): string | null {
  return isRecord(transport) &&
    transport.type === "runner" &&
    typeof transport.runnerId === "string"
    ? transport.runnerId
    : null;
}

export function forbidden(message: string): OpensteerError {
  return new OpensteerError({ code: "forbidden", message });
}

/**
 * Replaces one server's tools with what it just listed. A tool keeps its row
 * across listings by the operation it runs when its adapter says which, and
 * otherwise by its name, so tool refs to it survive; one it no longer lists is
 * disabled rather than deleted.
 */
export async function replaceServerToolsInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly now: Date;
    readonly serverId: IntegrationServerId;
    readonly catalog: IntegrationToolCatalog;
  },
): Promise<void> {
  const material = await prepareToolCatalog(transaction, input.catalog, input.serverId, null);
  const existingTools = await transaction
    .selectFrom("integrationTools")
    .select(["id", "connectionId", "name", "target"])
    .where("serverId", "=", input.serverId)
    .orderBy("id", "asc")
    .forNoKeyUpdate()
    .execute();
  const toolByIdentity = new Map(existingTools.map((tool) => [toolIdentity(tool), tool]));
  // A name belongs to one active tool, and a listing can move it to another
  // operation, so no tool stays active while the others take their names.
  await transaction
    .updateTable("integrationTools")
    .set({ status: "disabled", updatedAt: input.now })
    .where("serverId", "=", input.serverId)
    .where("status", "=", "active")
    .execute();
  for (const tool of material.tools) {
    const currentTool = toolByIdentity.get(toolIdentity(tool));
    const values = {
      annotations: jsonValue(tool.annotations),
      connectionId: tool.connectionId,
      definitionNames: [...tool.definitionNames],
      description: tool.description,
      inputSchema: jsonValue(tool.inputSchema),
      name: tool.name,
      outputSchema: tool.outputSchema === null ? null : jsonValue(tool.outputSchema),
      schemaDigest: tool.schemaDigest,
      status: tool.status,
      target: tool.target === undefined ? null : jsonValue(tool.target),
      title: tool.title,
      updatedAt: input.now,
    };
    if (currentTool) {
      await transaction
        .updateTable("integrationTools")
        .set(values)
        .where("id", "=", currentTool.id)
        .executeTakeFirstOrThrow();
    } else {
      await transaction
        .insertInto("integrationTools")
        .values({ ...values, id: tool.id, serverId: input.serverId })
        .executeTakeFirstOrThrow();
    }
  }
  await lockToolDefinitionsInTransaction(transaction, [input.serverId]);
  await transaction
    .deleteFrom("integrationToolDefinitions")
    .where("serverId", "=", input.serverId)
    .where("connectionId", "is not", null)
    .execute();
  await writeToolDefinitionsInTransaction(transaction, {
    connectionId: null,
    definitions: material.definitions,
    now: input.now,
    serverId: input.serverId,
  });
}
