import { runnerIntegrationsCompatibilityReason } from "@opensteer/protocol";
import { withDatabaseTransaction } from "./connection.js";
import {
  discoverInstallationRequestWorkspaces,
  lockRequestWorkspaces,
  withRequestWorkspaceLocks,
} from "./request-workspace-locks.js";
import { revokeChannelConnectionsInTransaction } from "./channel-deliveries.js";
import {
  canonicalComputerAppApprovalPublicKey,
  computerAppApprovalKeyId,
} from "@opensteer/runner-auth";
import { jsonValue } from "./store-primitives.js";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import {
  IntegrationAdapterSnapshotSchema,
  type IntegrationAdapterSnapshot,
} from "@opensteer/integration-core/adapter";
import {
  ApiKeyDisclosureSchema,
  type ApiKeyDisclosure,
  type ComputerAppIdentity,
  ComputerAppIdentitySchema,
  type ComputerAppSetupRequest,
  type ComputerAppApproval,
  IntegrationApplicationSourceSchema,
  IntegrationConnectionRequirementSchema,
  IntegrationDefinitionIdSchema,
  IntegrationDefinitionSchema,
  IntegrationDefinitionSummarySchema,
  IntegrationInstallationSchema,
  IntegrationServerSchema,
  IntegrationSkillSchema,
  IntegrationToolSchema,
  IntegrationToolMaterialSchema,
  type IntegrationToolMaterial,
  type IntegrationToolCatalog,
  createIntegrationId,
  integrationApplicationSourcePinnedAndAvailable,
  resolveIntegrationReadiness,
  isIntegrationConnectionEligible,
  type IntegrationConnectionAuthority,
  type IntegrationConnectionId,
  type IntegrationConnectionSummary,
  type IntegrationAccess,
  type IntegrationGrant,
  type IntegrationDefinition,
  type IntegrationDefinitionSummary,
  type IntegrationInstallation,
  type IntegrationInstallationId,
  type IntegrationProviderAuthorization,
  type IntegrationServer,
  type IntegrationSkill,
  type IntegrationSkillId,
  type IntegrationServerId,
  type IntegrationTool,
  type IntegrationToolId,
  type IntegrationReadiness,
  computerAppIdentitiesEqual,
  type McpOAuthAttemptId,
} from "@opensteer/integration-core";
import { integrationAccessCovers, integrationToolEffect } from "@opensteer/integration-core/effect";
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
  type WorkspaceId,
  type RunnerId,
} from "@opensteer/core";
import { type Kysely, type Selectable, type Transaction, sql } from "kysely";
import { erasedIntegrationAuthAttemptPayload } from "./integration-auth-attempt-store.js";
import type {
  DatabaseSchema,
  IntegrationConnectionTable,
  IntegrationInstallationTable,
  IntegrationServerTable,
  IntegrationToolTable,
  IntegrationSkillTable,
} from "./schema.js";
import { cancelPending } from "./request-cancellation.js";
import {
  fulfillPendingMainIntegrationAccessRequestsInTransaction,
  pendingMainIntegrationAccessRequests,
} from "./integration-request-fulfillment.js";
import { IntegrationAuthorityCache } from "./integration-authority-cache.js";
import { machineOwnershipIn } from "./machine-ownership.js";
import { integrationConnectionFromRow } from "./integration-store.js";
import {
  computerAppScopeOf,
  computerAppSetupRequestFromRow,
  computerAppSetupRequestMatches,
  deleteComputerAppSetupRequestsInTransaction,
  insertComputerAppSetupRequestInTransaction,
  lockComputerAppSetupRequestInTransaction,
  type ComputerAppScope,
} from "./computer-app-setup.js";
import {
  askForComputerAppApprovalInTransaction,
  assertComputerAppApprovalInTransaction,
  computerUseApprovalKeyInTransaction,
  computerUsePolicyInTransaction,
  discoverComputerRequestWorkspaces,
  declineComputerAppAccessRequestsInTransaction,
  emptyComputerAppAccessSettlement,
  lockComputerApprovalScopeInTransaction,
  settleComputerAppApprovalInTransaction,
  type ComputerAppAccessSettlement,
} from "./computer-app-approvals.js";
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

/**
 * What one adapter call runs, with the generations that say whether it is
 * still what the caller was authorized for: a snapshot changes only with its
 * installation's revision, and a connection's tools only with their server's
 * tool generation.
 */
export interface IntegrationToolInvocation {
  readonly adapterSnapshot: IntegrationAdapterSnapshot | null;
  readonly installationRevision: number;
  readonly schemaDigest: string;
  readonly status: "active" | "disabled";
  readonly target: Readonly<Record<string, unknown>> | null;
  readonly toolGeneration: number;
}

export interface IntegrationToolSchemas {
  readonly definitions: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>> | null;
  readonly schemaDigest: string;
  readonly status: "active" | "disabled";
}

/**
 * Who is asking for integration authority: an agent Thread acting for its
 * owner in one Workspace. The Thread matters because Main inheritance belongs
 * to a lineage, not to the Workspace it runs in (see `mainAccess`).
 */
export interface IntegrationRequester {
  readonly ownerUserId: UserId;
  readonly threadId: ThreadId;
  readonly workspaceId: WorkspaceId;
}

/** Scope readiness to the account and access a resolved Request actually granted. */
export interface IntegrationDiscoveryRequester extends IntegrationRequester {
  readonly target?: {
    readonly access: IntegrationAccess;
    readonly connectionId: IntegrationConnectionId | null;
  };
}

/**
 * How an asking Thread stands to its owner's Main: `inherited` reaches every
 * connection the owner has; `withheld` runs in that Main but below it, with
 * no inherited authority and none it may ask to add.
 */
export type MainAccess = "inherited" | "withheld";

export interface SetComputerConnectionInput {
  readonly approval?: ComputerAppApproval;
  readonly definitionDigest: string;
  readonly access: IntegrationAccess;
  readonly actorUserId: UserId;
  readonly app: ComputerAppIdentity | null;
  readonly createIfMissing: boolean;
  readonly definitionId: string;
  readonly requestId: string;
  readonly runnerId: RunnerId;
  readonly tools: (connectionId: IntegrationConnectionId) => readonly IntegrationToolMaterial[];
}

export interface SetComputerConnectionResult {
  readonly connection: IntegrationConnectionSummary;
  readonly created: boolean;
  readonly grants: readonly IntegrationGrant[];
  readonly fulfilledRequestIds: readonly RequestId[];
  /**
   * A wider approval this change left waiting under a new id, which the Mac
   * has to be asked about again.
   */
  readonly reissuedSetupRequestId: string | null;
  readonly requestEvents: readonly AgentEvent[];
  /**
   * The live session this change ended, if any: the one holding this app on a
   * Mac, or the one holding a phone's display. Null for a change that left
   * every session's authority as it was.
   */
  readonly sessionReset:
    | { readonly appKey: string; readonly kind: "app"; readonly runnerId: RunnerId }
    | { readonly definitionId: string; readonly kind: "display"; readonly runnerId: RunnerId }
    | null;
}

export interface DiscoveredIntegrationServer {
  readonly connectionRequirement: IntegrationServer["connectionRequirement"];
  readonly id: IntegrationServerId;
  readonly name: string;
  readonly status: "active" | "disabled" | "needs-attention";
  readonly statusDetail: string | null;
  readonly catalog: IntegrationToolCatalog;
  readonly transport: IntegrationServer["transport"];
}

interface DiscoveredIntegrationSkill {
  readonly description: string;
  readonly digest: string;
  readonly id: IntegrationSkillId;
  readonly name: string;
  readonly status: "active" | "disabled";
}

export interface CallableIntegrationTool {
  readonly grant: EffectiveIntegrationGrant;
  readonly installation: IntegrationInstallation;
  readonly server: IntegrationServer;
  readonly tool: IntegrationTool;
}

/** A valid owner tried to create an app connection the computer is not offering live. */
export class ComputerAppNotOfferedError extends Error {
  readonly runnerName: string;

  constructor(runnerName: string) {
    super("Computer app is not offered by this Runner");
    this.name = "ComputerAppNotOfferedError";
    this.runnerName = runnerName;
  }
}

export interface GrantedIntegrationSkill {
  readonly grant: EffectiveIntegrationGrant;
  readonly installation: IntegrationInstallation;
  readonly skill: IntegrationSkill;
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

interface StoredIntegrationConnectionAuthority extends IntegrationConnectionAuthority {
  readonly computerAccess: IntegrationAccess | null;
  readonly displayName: string;
  readonly id: IntegrationConnectionId;
  readonly ownerUserId: UserId;
}

function integrationApplicationSourceAvailable(input: {
  readonly application:
    | {
        readonly id: string;
        readonly provider: string;
        readonly revision: number;
        readonly status: string;
      }
    | undefined;
  readonly applicationSource: unknown;
  readonly connectionKind: "channel" | "computer" | "mcp-oauth" | "provider-account";
  readonly provider: string;
  readonly providerAuthorization: IntegrationProviderAuthorization | null;
}): boolean {
  if (input.connectionKind !== "provider-account") return true;
  const parsed = IntegrationApplicationSourceSchema.safeParse(input.applicationSource);
  if (!parsed.success) return false;
  const source = parsed.data;
  if (
    !integrationApplicationSourcePinnedAndAvailable({
      applicationSource: source,
      authorization: input.providerAuthorization,
    })
  ) {
    return false;
  }
  if (source.kind === "deployment-oauth") {
    return (
      input.application?.id === source.providerApplicationId &&
      input.application.provider === input.provider &&
      input.application.revision === source.providerApplicationRevision &&
      input.application.status === "active"
    );
  }
  return true;
}

abstract class IntegrationPlatformStoreBase {
  protected readonly database: Kysely<DatabaseSchema>;

  constructor(database: Kysely<DatabaseSchema>) {
    this.database = database;
  }

  protected async authoritySnapshot(
    ownerUserId: UserId,
    providerAuthorizations: Readonly<Record<string, IntegrationProviderAuthorization>>,
  ): Promise<{
    readonly connections: readonly StoredIntegrationConnectionAuthority[];
  }> {
    const [connectionRows, applicationRows] = await Promise.all([
      this.database
        .selectFrom("integrationConnections")
        .select([
          "applicationSource",
          "connectionKind",
          "computerAccess",
          "displayName",
          "id",
          "integrationDefinitionId",
          "integrationServerId",
          "ownerUserId",
          "provider",
          "providerApplicationId",
          "status",
        ])
        .where("ownerUserId", "=", ownerUserId)
        .where("status", "!=", "revoked")
        .orderBy("displayName", "asc")
        .orderBy("id", "asc")
        .execute(),
      this.database
        .selectFrom("integrationProviderApplications")
        .select(["id", "provider", "revision", "status"])
        .execute(),
    ]);
    const applicationById = new Map(
      applicationRows.map((application) => [application.id, application]),
    );
    return {
      connections: connectionRows.map((connection) => {
        const application = connection.providerApplicationId
          ? applicationById.get(connection.providerApplicationId)
          : undefined;
        return {
          applicationSourceAvailable: integrationApplicationSourceAvailable({
            application,
            applicationSource: connection.applicationSource,
            connectionKind: connection.connectionKind,
            provider: connection.provider,
            providerAuthorization: providerAuthorizations[connection.provider] ?? null,
          }),
          connectionKind: connection.connectionKind,
          computerAccess: connection.computerAccess,
          definitionId: connection.integrationDefinitionId,
          displayName: connection.displayName,
          id: connection.id,
          integrationServerId: connection.integrationServerId,
          ownerUserId: connection.ownerUserId,
          provider: connection.provider,
          status: connection.status,
        };
      }),
    };
  }

  protected async activeGrants(input: {
    readonly ownerUserId: UserId;
    readonly workspaceId: WorkspaceId;
  }): Promise<readonly IntegrationGrant[]> {
    const rows = await this.database
      .selectFrom("integrationGrants")
      .selectAll()
      .where("ownerUserId", "=", input.ownerUserId)
      .where("workspaceId", "=", input.workspaceId)
      .where("revokedAt", "is", null)
      .orderBy("installationId", "asc")
      .orderBy("isDefault", "desc")
      .orderBy("alias", "asc")
      .execute();
    return rows.map(integrationGrantFromRow);
  }

  /**
   * How the asking Thread stands to its owner's Main authority, or null when
   * the Workspace is not their Main at all.
   *
   * A Main Workspace is its owner's own, and a Thread there reaches the
   * owner's connections only when its lineage starts from a Main-profile
   * Thread. A channel route runs as its creator without being them, so its
   * root takes `workspace` even in their Main, and whatever that root
   * delegates stays in its lineage. A Thread's profile and lineage never
   * change, so neither does this answer.
   */
  async mainAccess(input: IntegrationRequester): Promise<MainAccess | null> {
    const [workspace, root] = await Promise.all([
      this.database
        .selectFrom("workspaces")
        .select("id")
        .where("id", "=", input.workspaceId)
        .where("createdBy", "=", input.ownerUserId)
        .where("kind", "=", "main")
        .executeTakeFirst(),
      this.database
        .selectFrom("threads as asking")
        .innerJoin("threads as root", "root.id", "asking.lineageRootThreadId")
        .select("root.capabilityProfileId")
        .where("asking.id", "=", input.threadId)
        .executeTakeFirst(),
    ]);
    if (!workspace) return null;
    return root?.capabilityProfileId === "main" ? "inherited" : "withheld";
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

  protected async installationSkills(
    installationId: IntegrationInstallationId,
  ): Promise<readonly IntegrationSkill[]> {
    const rows = await this.database
      .selectFrom("integrationSkills")
      .selectAll()
      .where("installationId", "=", installationId)
      .where("status", "=", "active")
      .orderBy("name", "asc")
      .limit(1_000)
      .execute();
    return rows.map(skillFromRow);
  }
}

export interface InstallIntegrationInput {
  readonly adapterSnapshot: IntegrationAdapterSnapshot | null;
  readonly actorUserId: UserId | null;
  readonly installation: Omit<IntegrationInstallation, "createdAt" | "revision" | "updatedAt">;
  readonly requestId: string;
  readonly servers: readonly DiscoveredIntegrationServer[];
  readonly skills?: readonly DiscoveredIntegrationSkill[];
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
  | { readonly runnerId: RunnerId };

/** What a removal took back, so a caller can end the sessions that were using it. */
export interface RemovedComputerApp {
  readonly app: ComputerAppIdentity | null;
  readonly appKey: string | null;
  readonly connectionId: IntegrationConnectionId;
  readonly definitionId: string | null;
  readonly runnerId: RunnerId;
}

export interface RevokeComputerConnectionsMutation {
  readonly cancelledRequestIds: readonly RequestId[];
  readonly connectionIds: readonly IntegrationConnectionId[];
  /** The apps whose approval this removal took back, `(runnerId, appKey)` and all. */
  readonly removedApps: readonly RemovedComputerApp[];
  readonly requestEvents: readonly AgentEvent[];
}

export type { ComputerAppAccessSettlement } from "./computer-app-approvals.js";

async function discoverComputerRemovalWorkspaces(
  database: Kysely<DatabaseSchema>,
  selector: RevokeComputerConnectionSelector,
): Promise<readonly WorkspaceId[]> {
  if ("installationId" in selector)
    return discoverInstallationRequestWorkspaces(database, { id: selector.installationId });
  if ("runnerId" in selector) return discoverComputerRequestWorkspaces(database, selector.runnerId);
  const connection = await database
    .selectFrom("integrationConnections")
    .select("runnerId")
    .where("id", "=", selector.connectionId)
    .where("ownerUserId", "=", selector.ownerUserId)
    .executeTakeFirst();
  return connection?.runnerId
    ? discoverComputerRequestWorkspaces(database, connection.runnerId)
    : [];
}

/** The one credential-free removal path for computer connections. */
export async function revokeComputerConnectionsInTransaction(
  transaction: Transaction<DatabaseSchema>,
  selector: RevokeComputerConnectionSelector,
): Promise<RevokeComputerConnectionsMutation> {
  await lockRequestWorkspaces(
    transaction,
    await discoverComputerRemovalWorkspaces(transaction, selector),
  );
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
      "integrationConnections.runnerId",
      "integrationServers.installationId",
    ])
    .where("integrationConnections.connectionKind", "=", "computer")
    .where("integrationConnections.status", "!=", "revoked");
  if ("connectionId" in selector) {
    query = query
      .where("integrationConnections.id", "=", selector.connectionId)
      .where("integrationConnections.ownerUserId", "=", selector.ownerUserId);
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
  // `(runnerId, definitionId, appKey)`.
  const revokedSetupRequestIds = await (async (): Promise<readonly string[]> => {
    if ("runnerId" in selector) {
      return deleteComputerAppSetupRequestsInTransaction(transaction, {
        runnerId: selector.runnerId,
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
    if (!connection?.runnerId) return [];
    return deleteComputerAppSetupRequestsInTransaction(transaction, {
      appKey: connection.computerAppKey,
      runnerId: connection.runnerId,
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
    connection.runnerId === null
      ? []
      : [
          {
            app: connection.computerApp ?? null,
            appKey: connection.computerAppKey,
            connectionId: connection.id,
            definitionId: connection.integrationDefinitionId,
            runnerId: connection.runnerId,
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
 * Uninstalling removes the installation outright rather than disabling it: a
 * disabled row keeps the deployment-unique name, so the same integration could
 * never be installed again.
 *
 * Accounts follow the definition, not the installation. A proposed integration's
 * definition exists nowhere but this row, so its connections (and the credentials
 * they point at) are removed with it; a catalog definition outlives the
 * installation, so its connections stay connected and a reinstall finds them.
 * MCP OAuth connections name a server of this installation directly, so they
 * cannot outlive it either.
 *
 * Resolved Requests keep their history: their detail rows are detached from the
 * installation rather than deleted, and only pending access Requests are
 * cancelled.
 */
export async function uninstallIntegrationInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: UninstallIntegrationInput,
): Promise<UninstallIntegrationMutation> {
  await lockRequestWorkspaces(
    transaction,
    await discoverInstallationRequestWorkspaces(transaction, { id: input.installationId }),
  );
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
  const uninstallIds = await uninstallConnectionIds(transaction, installation, serverIds);
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
      .deleteFrom("mcpOAuthCredentials")
      .where("connectionId", "in", [...removedConnectionIds])
      .execute();
    await transaction
      .deleteFrom("integrationConnections")
      .where("id", "in", [...removedConnectionIds])
      .execute();
    if (credentialIds.length > 0) {
      await transaction.deleteFrom("credentials").where("id", "in", credentialIds).execute();
    }
  }
  await transaction
    .deleteFrom("integrationSkills")
    .where("installationId", "=", installation.id)
    .execute();
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
      workspaceId: null,
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
  installation: IntegrationInstallation,
  serverIds: readonly IntegrationServerId[],
): Promise<readonly IntegrationConnectionId[]> {
  const definitionId =
    installation.sourceKind === "proposed"
      ? IntegrationDefinitionSummarySchema.parse(installation.manifest.definition).id
      : null;
  if (!serverIds.length && !definitionId) return [];
  return (
    (
      await transaction
        .selectFrom("integrationConnections")
        .select("id")
        .where((eb) =>
          eb.or([
            ...(serverIds.length
              ? [
                  eb.and([
                    eb("connectionKind", "in", ["computer", "mcp-oauth"]),
                    eb("integrationServerId", "in", [...serverIds]),
                  ]),
                ]
              : []),
            ...(definitionId
              ? [
                  eb.and([
                    eb("connectionKind", "=", "provider-account"),
                    eb("integrationDefinitionId", "=", definitionId),
                  ]),
                ]
              : []),
          ]),
        )
        .orderBy("id", "asc")
        // FOR UPDATE: Uninstall deletes these server and proposed-definition connections.
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
  await lockRequestWorkspaces(
    transaction,
    await discoverInstallationRequestWorkspaces(transaction, input.installation),
  );
  const adapterSnapshot = validateAdapterInstallation(input);
  await lockIntegrationInstallationIdentityInTransaction(transaction, input.installation);
  const current = await transaction
    .selectFrom("integrationInstallations")
    .selectAll()
    .where("name", "=", input.installation.name)
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
          adapterSnapshot: adapterSnapshot === null ? null : jsonValue(adapterSnapshot),
          description: input.installation.description,
          manifest: jsonValue(input.installation.manifest),
          provenance: jsonValue(input.installation.provenance),
          revision: current.revision + 1,
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
          adapterSnapshot: adapterSnapshot === null ? null : jsonValue(adapterSnapshot),
          createdBy: input.actorUserId,
          description: input.installation.description,
          id: input.installation.id,
          manifest: jsonValue(input.installation.manifest),
          name: input.installation.name,
          provenance: jsonValue(input.installation.provenance),
          revision: 1,
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
    await replaceServerToolsInTransaction(transaction, {
      now,
      serverId: server.id,
      catalog: discovered.catalog,
    });
  }
  if (retainedServerIds.length === 0) {
    await transaction
      .updateTable("integrationServers")
      .set({ status: "disabled", updatedAt: now })
      .where("installationId", "=", installation.id)
      .execute();
  } else {
    await transaction
      .updateTable("integrationServers")
      .set({ status: "disabled", updatedAt: now })
      .where("installationId", "=", installation.id)
      .where("id", "not in", retainedServerIds)
      .execute();
  }
  const existingSkills = await transaction
    .selectFrom("integrationSkills")
    .selectAll()
    .where("installationId", "=", installation.id)
    .orderBy("id", "asc")
    .forNoKeyUpdate()
    .execute();
  const skillByName = new Map(existingSkills.map((skill) => [skill.name, skill]));
  const retainedSkillIds: IntegrationSkillId[] = [];
  for (const discovered of input.skills ?? []) {
    const current = skillByName.get(discovered.name);
    const id = current?.id ?? discovered.id;
    retainedSkillIds.push(id);
    const values = {
      description: discovered.description,
      digest: discovered.digest,
      status: discovered.status,
      updatedAt: now,
    };
    if (current) {
      await transaction
        .updateTable("integrationSkills")
        .set(values)
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
    } else {
      await transaction
        .insertInto("integrationSkills")
        .values({ ...values, id, installationId: installation.id, name: discovered.name })
        .executeTakeFirstOrThrow();
    }
  }
  await transaction
    .updateTable("integrationSkills")
    .set({ status: "disabled", updatedAt: now })
    .where("installationId", "=", installation.id)
    .$if(retainedSkillIds.length > 0, (builder) => builder.where("id", "not in", retainedSkillIds))
    .execute();
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
      workspaceId: null,
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
    return withRequestWorkspaceLocks(
      this.database,
      (transaction) => discoverInstallationRequestWorkspaces(transaction, input.installation),
      (transaction) => installIntegrationInTransaction(transaction, input),
    );
  }

  async uninstall(input: UninstallIntegrationInput): Promise<UninstallIntegrationMutation> {
    return withRequestWorkspaceLocks(
      this.database,
      (transaction) =>
        discoverInstallationRequestWorkspaces(transaction, { id: input.installationId }),
      (transaction) => uninstallIntegrationInTransaction(transaction, input),
    );
  }

  /** Fill additive public facts from the original snapshot without rematerializing its authority. */
  async backfillApiKeyDisclosures(
    disclose: (snapshot: IntegrationAdapterSnapshot) => ApiKeyDisclosure,
  ): Promise<void> {
    const missingDisclosure = sql<boolean>`
      manifest -> 'definition' ->> 'apiKey' is null
      and manifest -> 'definition' -> 'authMethods' @> '[{"kind":"api-key"}]'::jsonb
    `;
    const candidates = await this.database
      .selectFrom("integrationInstallations")
      .select("id")
      .where(missingDisclosure)
      .orderBy("id", "asc")
      .execute();
    for (const { id } of candidates) {
      await withDatabaseTransaction(this.database, async (transaction) => {
        const row = await transaction
          .selectFrom("integrationInstallations")
          .select(["manifest", "adapterSnapshot"])
          .where("id", "=", id)
          .where(missingDisclosure)
          .forNoKeyUpdate()
          .executeTakeFirst();
        if (!row) return;
        let manifest;
        try {
          const summary = IntegrationDefinitionSummarySchema.parse(row.manifest.definition);
          const snapshot = IntegrationAdapterSnapshotSchema.parse(row.adapterSnapshot);
          const apiKey = ApiKeyDisclosureSchema.parse(disclose(snapshot));
          manifest = jsonValue({ ...row.manifest, definition: { ...summary, apiKey } });
        } catch {
          await markNeedsAttentionInTransaction(
            transaction,
            id,
            "Opensteer can’t tell where this integration sends its key. Remove it and install it again.",
          );
          return;
        }
        await transaction
          .updateTable("integrationInstallations")
          .set({ manifest })
          .where("id", "=", id)
          .execute();
      });
    }
  }

  /**
   * Before a tool recorded the operation it runs, an OpenAPI call found it by
   * planning names again from the stored document. Each server still holding
   * such a tool binds it once by the names those calls planned, then takes the
   * tools its snapshot plans now: a bound tool keeps its row under its new name,
   * and one that no such name ran is disabled. A server that cannot be bound is
   * left as it was and its integration unavailable, so its calls stay refused
   * and nothing else waits on it; each start tries it again, and binding it
   * clears only the reason binding gave. Returns what could not be bound.
   */
  async bindOpenApiTools(
    plan: (snapshot: IntegrationAdapterSnapshot) => Promise<{
      readonly catalog: IntegrationToolCatalog;
      readonly legacyTargets: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
    }>,
  ): Promise<readonly { readonly error: unknown; readonly serverId: IntegrationServerId }[]> {
    const candidates = await this.database
      .selectFrom("integrationServers")
      .innerJoin(
        "integrationInstallations",
        "integrationInstallations.id",
        "integrationServers.installationId",
      )
      .select(["integrationServers.id", "integrationServers.installationId"])
      .where(sql<boolean>`integration_installations.adapter_snapshot ->> 'adapter' = 'openapi'`)
      .where(
        sql<boolean>`exists (
          select 1 from public.integration_tools tool
          where tool.server_id = integration_servers.id
            and tool.status = 'active' and tool.target is null
        )`,
      )
      .orderBy("integrationServers.id", "asc")
      .execute();
    const failures: { error: unknown; serverId: IntegrationServerId }[] = [];
    for (const { id, installationId } of candidates) {
      try {
        await withDatabaseTransaction(this.database, async (transaction) => {
          await transaction
            .selectFrom("integrationInstallations")
            .select("id")
            .where("id", "=", installationId)
            .forNoKeyUpdate()
            .executeTakeFirstOrThrow();
          const server = await transaction
            .selectFrom("integrationServers")
            .innerJoin(
              "integrationInstallations",
              "integrationInstallations.id",
              "integrationServers.installationId",
            )
            .select([
              "integrationInstallations.adapterSnapshot",
              "integrationServers.toolGeneration",
            ])
            .where("integrationServers.id", "=", id)
            .forNoKeyUpdate("integrationServers")
            .executeTakeFirstOrThrow();
          const tools = await transaction
            .selectFrom("integrationTools")
            .select(["id", "name", "status", "target"])
            .where("serverId", "=", id)
            .orderBy("id", "asc")
            .forNoKeyUpdate()
            .execute();
          const { catalog, legacyTargets } = await plan(
            IntegrationAdapterSnapshotSchema.parse(server.adapterSnapshot),
          );
          const now = new Date();
          for (const tool of tools) {
            const target = legacyTargets.get(tool.name);
            if (tool.status !== "active" || tool.target !== null || !target) continue;
            await transaction
              .updateTable("integrationTools")
              .set({ target: jsonValue(target) })
              .where("id", "=", tool.id)
              .execute();
          }
          await replaceServerToolsInTransaction(transaction, { catalog, now, serverId: id });
          await transaction
            .updateTable("integrationServers")
            .set({ toolGeneration: server.toolGeneration + 1, updatedAt: now })
            .where("id", "=", id)
            .execute();
          const cleared = await transaction
            .updateTable("integrationServers")
            .set({ status: "active", statusDetail: null, updatedAt: now })
            .where("id", "=", id)
            .where("statusDetail", "=", unboundOpenApiReason)
            .executeTakeFirst();
          if (cleared.numUpdatedRows === 0n) return;
          await transaction
            .updateTable("integrationInstallations")
            .set({ status: "active", updatedAt: now })
            .where("id", "=", installationId)
            .where("status", "=", "needs-attention")
            .where(
              sql<boolean>`not exists (
                select 1 from public.integration_servers other
                where other.installation_id = ${installationId} and other.status = 'needs-attention'
              )`,
            )
            .execute();
        });
      } catch (error) {
        failures.push({ error, serverId: id });
        // Only what nothing else holds unavailable, so clearing this reason restores exactly it.
        await withDatabaseTransaction(this.database, async (transaction) => {
          const now = new Date();
          await transaction
            .updateTable("integrationInstallations")
            .set({ status: "needs-attention", updatedAt: now })
            .where("id", "=", installationId)
            .where("status", "=", "active")
            .execute();
          await transaction
            .updateTable("integrationServers")
            .set({ status: "needs-attention", statusDetail: unboundOpenApiReason, updatedAt: now })
            .where("id", "=", id)
            .where("status", "=", "active")
            .execute();
        });
      }
    }
    return failures;
  }

  /** Leaves an installation unavailable with a reason both its owner and an agent read. */
  async markNeedsAttention(
    installationId: IntegrationInstallationId,
    reason: string,
  ): Promise<void> {
    await withDatabaseTransaction(this.database, (transaction) =>
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
      .select("integrationConnections.runnerId")
      .distinct()
      .where("integrationServers.installationId", "=", installationId)
      .where("integrationConnections.connectionKind", "=", "computer")
      .where("integrationConnections.status", "!=", "revoked")
      .where("integrationConnections.runnerId", "is not", null)
      .orderBy("integrationConnections.runnerId", "asc")
      .execute();
    return rows.flatMap(({ runnerId }) => (runnerId === null ? [] : [runnerId]));
  }

  async reconcileProviderConnectionTools(input: {
    readonly connectionId: IntegrationConnectionId;
    readonly definitionId: string;
    readonly ownerUserId: UserId;
    readonly serverId: IntegrationServerId;
    readonly catalog: IntegrationToolCatalog;
  }): Promise<void> {
    await withDatabaseTransaction(this.database, async (transaction) => {
      const server = await transaction
        .selectFrom("integrationServers")
        .selectAll()
        .where("id", "=", input.serverId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      const connection = await transaction
        .selectFrom("integrationConnections")
        .select(["integrationDefinitionId", "ownerUserId", "status"])
        .where("id", "=", input.connectionId)
        .where("connectionKind", "=", "provider-account")
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (
        !connection ||
        connection.ownerUserId !== input.ownerUserId ||
        connection.integrationDefinitionId !== input.definitionId ||
        connection.status !== "connected"
      ) {
        throw forbidden("Integration connection is no longer authorized for tool discovery");
      }
      if (!server)
        throw new OpensteerError({ code: "not_found", message: "Integration server not found" });
      const transport = IntegrationServerSchema.shape.transport.parse(server.transport);
      if (transport.type !== "adapter" || transport.definitionId !== input.definitionId) {
        throw forbidden("Integration server does not belong to this connection definition");
      }
      await upsertConnectionTools(
        transaction,
        input.serverId,
        input.connectionId,
        input.catalog,
        new Date(),
      );
      await transaction
        .updateTable("integrationServers")
        .set({ toolGeneration: server.toolGeneration + 1, updatedAt: new Date() })
        .where("id", "=", server.id)
        .where("toolGeneration", "=", server.toolGeneration)
        .executeTakeFirstOrThrow();
    });
  }

  async listDiscoveryInventory(
    input: IntegrationDiscoveryRequester & {
      readonly providerAuthorizations: Readonly<Record<string, IntegrationProviderAuthorization>>;
    },
  ): Promise<
    readonly {
      readonly accounts: readonly {
        readonly access: IntegrationAccess | null;
        readonly account: string;
        readonly connectionId: IntegrationConnectionId;
        readonly isDefault: boolean;
      }[];
      readonly installation: IntegrationInstallation;
      readonly readiness: {
        readonly servers: readonly IntegrationReadiness[];
        readonly tools: readonly {
          readonly readiness: IntegrationReadiness;
          readonly toolId: IntegrationToolId;
        }[];
      };
      readonly servers: readonly IntegrationServer[];
      readonly skills: readonly IntegrationSkill[];
      readonly tools: readonly IntegrationTool[];
    }[]
  > {
    const [installations, authority, grants, mainAccess] = await Promise.all([
      this.database
        .selectFrom("integrationInstallations")
        .selectAll()
        .orderBy("title", "asc")
        .limit(1_000)
        .execute(),
      this.authoritySnapshot(input.ownerUserId, input.providerAuthorizations),
      this.activeGrants({ ownerUserId: input.ownerUserId, workspaceId: input.workspaceId }),
      this.mainAccess(input),
    ]);
    const inheritedMainAccess = mainAccess === "inherited";
    const activeGrants = grants.filter(({ status }) => status === "active");
    // A lineage below its owner's Main sees only what this Workspace was
    // granted explicitly: the owner's personal accounts are neither usable
    // nor requestable there, so they are not listed either.
    const connections =
      mainAccess === "withheld"
        ? authority.connections.filter(({ id }) =>
            activeGrants.some(({ connectionId }) => connectionId === id),
          )
        : authority.connections;
    return Promise.all(
      installations.map(async (row) => {
        const installation = installationFromRow(row);
        const [servers, skills, tools] = await Promise.all([
          this.listServers(row.id),
          this.listSkills(row.id),
          this.listTools(row.id, input.ownerUserId),
        ]);
        const serverById = new Map(servers.map((server) => [server.id, server]));
        const installationConnections = connections.filter((connection) =>
          servers.some((server) => {
            const requirement = server.connectionRequirement;
            if (requirement.kind === "provider") {
              return (
                connection.connectionKind === "provider-account" &&
                connection.definitionId === requirement.definitionId &&
                connection.provider === requirement.provider
              );
            }
            if (requirement.kind === "computer") {
              return (
                connection.connectionKind === "computer" &&
                connection.definitionId === requirement.definitionId &&
                connection.integrationServerId === server.id
              );
            }
            return (
              requirement.kind === "mcp-oauth" &&
              connection.connectionKind === "mcp-oauth" &&
              connection.integrationServerId === server.id
            );
          }),
        );
        const hasInstallationAccess = (
          connectionId: IntegrationConnectionId | null,
          requiredAccess: IntegrationAccess,
        ) => {
          const connection =
            connectionId === null
              ? null
              : (installationConnections.find(({ id }) => id === connectionId) ?? null);
          return (
            (inheritedMainAccess &&
              (requiredAccess === "read" ||
                effectiveIntegrationAccess("read-write", connection) === "read-write")) ||
            activeGrants.some(
              (grant) =>
                grant.installationId === installation.id &&
                grant.connectionId === connectionId &&
                (requiredAccess === "read" ||
                  effectiveIntegrationAccess(grant.access, connection) === "read-write"),
            )
          );
        };
        const readinessFor = (
          server: IntegrationServer,
          tool: IntegrationTool | null,
        ): IntegrationReadiness =>
          resolveIntegrationReadiness({
            connectionRequirement: server.connectionRequirement,
            connections,
            hasAccess: hasInstallationAccess,
            installationStatus: installation.status,
            providerAuthorization:
              server.connectionRequirement.kind === "provider"
                ? (input.providerAuthorizations[server.connectionRequirement.provider] ?? null)
                : null,
            requiredAccess:
              input.target?.access ??
              (tool === null || integrationToolEffect(tool.annotations) === "read"
                ? "read"
                : "read-write"),
            requiredConnectionId: tool?.connectionId ?? input.target?.connectionId ?? null,
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
              access: inheritedMainAccess
                ? effectiveIntegrationAccess("read-write", connection)
                : grant
                  ? effectiveIntegrationAccess(grant.access, connection)
                  : null,
              account: connection.displayName,
              connectionId: connection.id,
              isDefault: grant?.isDefault ?? false,
            };
          }),
          installation,
          readiness: {
            servers: servers.map((server) =>
              resolveIntegrationReadiness({
                connectionRequirement: server.connectionRequirement,
                connections,
                hasAccess: hasInstallationAccess,
                installationStatus: installation.status,
                providerAuthorization:
                  server.connectionRequirement.kind === "provider"
                    ? (input.providerAuthorizations[server.connectionRequirement.provider] ?? null)
                    : null,
                requiredAccess: input.target?.access ?? "read",
                requiredConnectionId: input.target?.connectionId ?? null,
                serverId: server.id,
                serverStatus: server.status,
                statusDetail: server.statusDetail,
              }),
            ),
            tools: tools.flatMap((tool) => {
              const server = serverById.get(tool.serverId);
              return server ? [{ readiness: readinessFor(server, tool), toolId: tool.id }] : [];
            }),
          },
          servers,
          skills,
          tools,
        };
      }),
    );
  }

  /**
   * The connect paths resolve a definition the static catalog may never have carried — an
   * administrator-approved proposal exists only as this row — so the installed definition is
   * readable by definition id, not just by installation id.
   */
  async findInstalledDefinition(
    definitionId: string,
    options?: { readonly allowUnavailable: boolean },
  ): Promise<IntegrationDefinition | null> {
    const row = await this.database
      .selectFrom("integrationInstallations")
      .select(["adapterSnapshot", "manifest", "status"])
      .where(sql<string>`manifest -> 'definition' ->> 'id'`, "=", definitionId)
      .orderBy("name", "asc")
      .limit(1)
      .executeTakeFirst();
    // An unavailable installation still owns its definition; it must never resolve to live catalog config.
    if (row && row.status !== "active" && !options?.allowUnavailable)
      throw new OpensteerError({
        code: "conflict",
        message: "Installed integration is unavailable",
      });
    return row ? installedIntegrationDefinition(row) : null;
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

  async listSkills(
    installationId: IntegrationInstallationId,
  ): Promise<readonly IntegrationSkill[]> {
    const rows = await this.database
      .selectFrom("integrationSkills")
      .selectAll()
      .where("installationId", "=", installationId)
      .where("status", "=", "active")
      .orderBy("name", "asc")
      .limit(1_000)
      .execute();
    return rows.map(skillFromRow);
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
      .where("integrationServers.status", "=", "active")
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

  /**
   * The Mac's policy and the approval key its answers are accepted with, which
   * is null until the owner registers this desktop's key on that Mac.
   */
  /** Immutable enrollment facts; callers apply their resource's owner check first. */
  async computerAppRunner(runnerId: RunnerId): Promise<{
    readonly deviceProfile: "iphone" | null;
    readonly publicKeyFingerprint: string;
  } | null> {
    return (
      (await this.database
        .selectFrom("runners")
        .select(["deviceProfile", "publicKeyFingerprint"])
        .where("id", "=", runnerId)
        .where("revokedAt", "is", null)
        .executeTakeFirst()) ?? null
    );
  }

  async getComputerUsePolicy(input: {
    readonly runnerId: RunnerId;
    readonly ownerUserId: UserId;
  }): Promise<{
    readonly appApproval: "ask" | "automatic";
    readonly approvalKeyId: string | null;
    readonly revision: number;
  }> {
    return withDatabaseTransaction(this.database, async (transaction) => {
      await this.#lockComputerUsePolicyOwner(transaction, input.runnerId, input.ownerUserId);
      const policy = await computerUsePolicyInTransaction(
        transaction,
        input.runnerId,
        input.ownerUserId,
      );
      const key = await computerUseApprovalKeyInTransaction(transaction, input.runnerId);
      return {
        ...policy,
        approvalKeyId: key?.ownerUserId === input.ownerUserId ? key.keyId : null,
      };
    });
  }

  /**
   * Pins the key this Mac's desktop signs approvals with, replacing any
   * earlier one. Only the Mac's owner may, and the computer's page calls it
   * only on that Mac, from the desktop that holds the private half; setting up
   * computer use again there is how a key is rotated.
   */
  async registerComputerUseApprovalKey(input: {
    readonly ownerUserId: UserId;
    readonly publicKey: string;
    readonly requestId: string;
    readonly runnerId: RunnerId;
  }): Promise<{ readonly approvalKeyId: string; readonly replaced: boolean }> {
    let publicKeyPem: string;
    try {
      publicKeyPem = canonicalComputerAppApprovalPublicKey(input.publicKey);
    } catch {
      throw new OpensteerError({
        code: "bad_request",
        message: "That approval key is unreadable.",
      });
    }
    const keyId = computerAppApprovalKeyId(publicKeyPem);
    return withRequestWorkspaceLocks(
      this.database,
      async (transaction) => [
        ...(await discoverComputerRequestWorkspaces(transaction, input.runnerId)),
      ],
      async (transaction) => {
        const runner = await this.#lockComputerUsePolicyOwner(
          transaction,
          input.runnerId,
          input.ownerUserId,
        );
        const device = await transaction
          .selectFrom("runners")
          .select(["device", "deviceProfile", "publicKeyFingerprint"])
          .where("id", "=", runner.id)
          .executeTakeFirstOrThrow();
        if (device.device?.form === "phone" && device.device.platform === "android") {
          throw new OpensteerError({
            code: "forbidden",
            message:
              "Phone access is allowed from any Opensteer app; phones do not use approval keys.",
          });
        }
        assertSeparateIphoneApprovalKey(device.deviceProfile, device.publicKeyFingerprint, keyId);
        const previous = await computerUseApprovalKeyInTransaction(transaction, input.runnerId);
        const now = new Date();
        await transaction
          .insertInto("computerUseApprovalKeys")
          .values({
            keyId,
            ownerUserId: input.ownerUserId,
            publicKeyPem,
            registeredAt: now,
            runnerId: input.runnerId,
          })
          .onConflict((conflict) =>
            conflict.column("runnerId").doUpdateSet({
              keyId,
              ownerUserId: input.ownerUserId,
              publicKeyPem,
              registeredAt: now,
            }),
          )
          .execute();
        const replaced = previous !== null && previous.keyId !== keyId;
        if (previous?.keyId !== keyId || previous.ownerUserId !== input.ownerUserId) {
          await transaction
            .insertInto("securityAudit")
            .values({
              action: "integration.computer-approval-key.registered",
              actorSessionId: null,
              actorUserId: input.ownerUserId,
              id: createId("securityAudit"),
              metadata: jsonValue({ keyId, replaced }),
              requestId: input.requestId,
              targetId: input.runnerId,
              targetType: "runner",
              workspaceId: null,
            })
            .execute();
        }
        return { approvalKeyId: keyId, replaced };
      },
    );
  }

  async #lockComputerUsePolicyOwner(
    transaction: Transaction<DatabaseSchema>,
    runnerId: RunnerId,
    ownerUserId: UserId,
  ) {
    const runner = await lockComputerApprovalScopeInTransaction(transaction, { runnerId });
    if (runner.revokedAt !== null)
      throw new OpensteerError({ code: "not_found", message: "Computer not found" });
    const ownership = await machineOwnershipIn(transaction, runnerId);
    if (ownership?.effectiveOwner !== ownerUserId)
      throw new OpensteerError({
        code: "forbidden",
        message: "Only this computer’s owner can change app approvals.",
      });
    return runner;
  }

  async setComputerUsePolicy(
    input: {
      readonly runnerId: RunnerId;
      readonly ownerUserId: UserId;
      readonly requestId: string;
    } & (
      | { readonly appApproval: "ask" }
      | {
          readonly appApproval: "automatic";
          readonly approval: ComputerAppApproval;
          readonly definitionDigest: string;
        }
    ),
  ): Promise<{ readonly appApproval: "ask" | "automatic"; readonly revision: number }> {
    return withRequestWorkspaceLocks(
      this.database,
      async (transaction) => [
        ...(await discoverComputerRequestWorkspaces(transaction, input.runnerId)),
      ],
      async (transaction) => {
        const runner = await this.#lockComputerUsePolicyOwner(
          transaction,
          input.runnerId,
          input.ownerUserId,
        );
        const now = new Date();
        const deployment = await transaction
          .selectFrom("deployments")
          .select("id")
          .where("singletonKey", "=", "primary")
          .executeTakeFirstOrThrow();
        let envelope: { request: ComputerAppSetupRequest; approval: ComputerAppApproval } | null =
          null;
        if (input.appApproval === "automatic") {
          const pending = await transaction
            .selectFrom("computerAppSetupRequests")
            .selectAll()
            .where("id", "=", input.approval.requestId)
            .where("deploymentId", "=", deployment.id)
            .where("runnerId", "=", input.runnerId)
            .where("ownerUserId", "=", input.ownerUserId)
            .where("kind", "=", "policy")
            .where("policyAppApproval", "=", "automatic")
            .where("definitionDigest", "=", input.definitionDigest)
            .where("expiresAt", ">", now)
            // FOR UPDATE: Consuming the policy approval deletes this setup request.
            .forUpdate()
            .executeTakeFirst();
          const request = await assertComputerAppApprovalInTransaction(transaction, {
            approval: input.approval,
            now,
            ownerUserId: input.ownerUserId,
            refusal: "Approve automatic app access in Opensteer on this Mac.",
            request: pending ? computerAppSetupRequestFromRow(pending) : null,
            runnerId: runner.id,
          });
          envelope = { request, approval: input.approval };
        }
        const previous = await computerUsePolicyInTransaction(
          transaction,
          input.runnerId,
          input.ownerUserId,
        );
        const revision = previous.revision + 1;
        await transaction
          .insertInto("computerUsePolicies")
          .values({
            deploymentId: deployment.id,
            runnerId: input.runnerId,
            ownerUserId: input.ownerUserId,
            appApproval: input.appApproval,
            revision,
            approval: envelope === null ? null : jsonValue(envelope),
            updatedAt: now,
          })
          .onConflict((conflict) =>
            conflict.columns(["deploymentId", "runnerId", "ownerUserId"]).doUpdateSet({
              appApproval: input.appApproval,
              revision,
              approval: envelope === null ? null : jsonValue(envelope),
              updatedAt: now,
            }),
          )
          .execute();
        await transaction
          .deleteFrom("computerAppSetupRequests")
          .where("runnerId", "=", input.runnerId)
          .where("ownerUserId", "=", input.ownerUserId)
          .where("kind", "=", "policy")
          .execute();
        await transaction
          .insertInto("securityAudit")
          .values({
            action: "integration.computer-policy.updated",
            actorSessionId: null,
            actorUserId: input.ownerUserId,
            id: createId("securityAudit"),
            metadata: jsonValue({ appApproval: input.appApproval, revision }),
            requestId: input.requestId,
            targetId: input.runnerId,
            targetType: "runner",
            workspaceId: null,
          })
          .execute();
        return { appApproval: input.appApproval, revision };
      },
    );
  }

  async listComputerAppSetupRequests(
    ownerUserId: UserId,
  ): Promise<readonly ComputerAppSetupRequest[]> {
    const rows = await this.database
      .selectFrom("computerAppSetupRequests")
      .innerJoin("runners", "runners.id", "computerAppSetupRequests.runnerId")
      .selectAll("computerAppSetupRequests")
      .where("computerAppSetupRequests.ownerUserId", "=", ownerUserId)
      .where("computerAppSetupRequests.expiresAt", ">", new Date())
      .where("runners.revokedAt", "is", null)
      .orderBy("computerAppSetupRequests.createdAt", "asc")
      .limit(1_000)
      .execute();
    return rows.map(computerAppSetupRequestFromRow);
  }

  /**
   * Every approval waiting on one Mac, with the name of the Workspace each
   * task asked from, and the approval key that Mac's answers are accepted
   * with. It is what the Host pushes to that Mac's Runner, so it is complete
   * rather than a page: an approval missing from it has ended.
   */
  async listComputerAppApprovalsForRunner(
    runnerId: RunnerId,
    limit: number,
  ): Promise<{
    readonly approvalKeyId: string | null;
    readonly approvals: readonly {
      readonly request: ComputerAppSetupRequest;
    }[];
  }> {
    const rows = await this.database
      .selectFrom("computerAppSetupRequests")
      .innerJoin("runners", "runners.id", "computerAppSetupRequests.runnerId")
      .selectAll("computerAppSetupRequests")
      .where("computerAppSetupRequests.runnerId", "=", runnerId)
      .where("computerAppSetupRequests.expiresAt", ">", new Date())
      .where("runners.revokedAt", "is", null)
      .orderBy("computerAppSetupRequests.createdAt", "asc")
      .orderBy("computerAppSetupRequests.id", "asc")
      .limit(limit)
      .execute();
    const key = await computerUseApprovalKeyInTransaction(this.database, runnerId);
    return {
      approvalKeyId: key?.keyId ?? null,
      approvals: rows.map((row) => ({ request: computerAppSetupRequestFromRow(row) })),
    };
  }

  /**
   * Whether this person administers the Deployment, for an answer that arrives
   * on a Mac's Runner stream rather than with a session that already says so.
   */
  async isAdministrator(userId: UserId): Promise<boolean> {
    const user = await this.database
      .selectFrom("users")
      .select("instanceRole")
      .where("id", "=", userId)
      .executeTakeFirst();
    return user?.instanceRole === "administrator";
  }

  /** One waiting approval on one Mac, which that Mac is answering. */
  async getComputerAppSetupRequest(input: {
    readonly runnerId: RunnerId;
    readonly setupRequestId: string;
  }): Promise<ComputerAppSetupRequest | null> {
    const row = await this.database
      .selectFrom("computerAppSetupRequests")
      .selectAll()
      .where("id", "=", input.setupRequestId)
      .where("runnerId", "=", input.runnerId)
      .where("expiresAt", ">", new Date())
      .executeTakeFirst();
    return row ? computerAppSetupRequestFromRow(row) : null;
  }

  /**
   * `app` is non-null exactly when the definition's connections name one app,
   * which `requiresApp` states. It comes from the caller for the same reason
   * `definitionDigest` does: the catalog is the Host's, not the store's, and
   * one of the two facts would otherwise be read from a different source than
   * the other.
   *
   * An app ask from the picker or an unblock is the same ask a task makes,
   * without a task, so it joins or widens the one waiting approval for that
   * app exactly as `askForComputerAppApprovalInTransaction` decides.
   */
  async requestComputerAppSetup(
    requestInput: {
      readonly actorUserId: UserId;
      readonly runnerId: RunnerId;
      readonly definitionDigest: string;
    } & (
      | {
          readonly kind: "policy";
          readonly appApproval: "automatic";
        }
      | {
          readonly kind?: "app";
          readonly definitionId: string;
          readonly access: IntegrationAccess;
          readonly app: ComputerAppIdentity | null;
          readonly requiresApp: boolean;
        }
    ),
  ): Promise<{
    readonly request: ComputerAppSetupRequest;
    readonly settlement: ComputerAppAccessSettlement;
  }> {
    const input =
      requestInput.kind === "policy"
        ? {
            ...requestInput,
            definitionId: "macos-app",
            access: "read-write" as const,
            app: null,
            requiresApp: false,
          }
        : requestInput;
    assertComputerAppPresence(input);
    return withRequestWorkspaceLocks(
      this.database,
      async (transaction) => [
        ...(await discoverComputerRequestWorkspaces(transaction, input.runnerId)),
      ],
      async (transaction) => {
        const runner = await lockComputerApprovalScopeInTransaction(transaction, {
          runnerId: input.runnerId,
        });
        const ownership =
          runner.revokedAt === null ? await machineOwnershipIn(transaction, runner.id) : null;
        if (ownership?.effectiveOwner !== input.actorUserId) {
          throw new OpensteerError({
            code: "forbidden",
            message: "Only this computer’s owner can request app setup.",
          });
        }
        const now = new Date();
        if (input.kind !== "policy") {
          const { row, settlement } = await askForComputerAppApprovalInTransaction(transaction, {
            access: input.access,
            app: input.app,
            definitionDigest: input.definitionDigest,
            definitionId: input.definitionId,
            now,
            ownerUserId: input.actorUserId,
            runnerId: input.runnerId,
            task: null,
          });
          return { request: computerAppSetupRequestFromRow(row), settlement };
        }
        // The policy approval has no Requests waiting on it, so replacing it
        // only has to mint the new id that invalidates older signatures.
        const scope = computerAppScopeOf(input);
        const existing = await lockComputerAppSetupRequestInTransaction(transaction, scope);
        if (
          existing &&
          computerAppSetupRequestMatches(existing, {
            access: input.access,
            app: input.app,
            definitionDigest: input.definitionDigest,
            now,
            ownerUserId: input.actorUserId,
          })
        ) {
          return {
            request: computerAppSetupRequestFromRow(existing),
            settlement: emptyComputerAppAccessSettlement,
          };
        }
        await deleteComputerAppSetupRequestsInTransaction(transaction, scope);
        const row = await insertComputerAppSetupRequestInTransaction(transaction, {
          kind: "policy",
          policyAppApproval: "automatic",
          access: input.access,
          app: input.app,
          definitionDigest: input.definitionDigest,
          definitionId: input.definitionId,
          now,
          ownerUserId: input.actorUserId,
          runnerId: input.runnerId,
        });
        return {
          request: computerAppSetupRequestFromRow(row),
          settlement: emptyComputerAppAccessSettlement,
        };
      },
    );
  }

  /** The owner taking the ask back, which declines whatever Threads were waiting on it. */
  async cancelComputerAppSetup(input: {
    readonly requestId: string;
    readonly ownerUserId: UserId;
  }): Promise<ComputerAppAccessSettlement & { readonly runnerId: RunnerId | null }> {
    return withRequestWorkspaceLocks(
      this.database,
      async (transaction) => {
        const request = await transaction
          .selectFrom("computerAppSetupRequests")
          .select("runnerId")
          .where("id", "=", input.requestId)
          .where("ownerUserId", "=", input.ownerUserId)
          .executeTakeFirst();
        return request ? discoverComputerRequestWorkspaces(transaction, request.runnerId) : [];
      },
      async (transaction) => {
        const request = await transaction
          .selectFrom("computerAppSetupRequests")
          .select("runnerId")
          .where("id", "=", input.requestId)
          .where("ownerUserId", "=", input.ownerUserId)
          .executeTakeFirst();
        if (!request) return { ...emptyComputerAppAccessSettlement, runnerId: null };
        // Same scope as enable/reduce/revoke, so cancellation cannot race an approval.
        await lockComputerApprovalScopeInTransaction(transaction, { runnerId: request.runnerId });
        const removed = await transaction
          .deleteFrom("computerAppSetupRequests")
          .where("id", "=", input.requestId)
          .where("ownerUserId", "=", input.ownerUserId)
          .returning("id")
          .execute();
        return {
          ...(await declineComputerAppAccessRequestsInTransaction(transaction, {
            setupRequestIds: removed.map(({ id }) => id),
          })),
          runnerId: request.runnerId,
        };
      },
    );
  }

  /** A denial from the Mac must have the same desktop-key authority as consent. */
  async declineComputerAppSetupFromMac(input: {
    readonly approval: ComputerAppApproval;
    readonly requestId: string;
    readonly runnerId: RunnerId;
  }): Promise<ComputerAppAccessSettlement> {
    return withRequestWorkspaceLocks(
      this.database,
      async (transaction) => [
        ...(await discoverComputerRequestWorkspaces(transaction, input.runnerId)),
      ],
      async (transaction) => {
        await lockComputerApprovalScopeInTransaction(transaction, { runnerId: input.runnerId });
        const row = await transaction
          .selectFrom("computerAppSetupRequests")
          .selectAll()
          .where("id", "=", input.requestId)
          .where("runnerId", "=", input.runnerId)
          .executeTakeFirst();
        if (!row) {
          throw new OpensteerError({
            code: "not_found",
            message: "This approval is no longer waiting.",
          });
        }
        const request = computerAppSetupRequestFromRow(row);
        await assertComputerAppApprovalInTransaction(transaction, {
          approval: input.approval,
          decision: "deny",
          now: new Date(),
          ownerUserId: request.ownerUserId,
          refusal: "This approval was not declined by this Mac.",
          request,
          runnerId: input.runnerId,
        });
        const removed = await transaction
          .deleteFrom("computerAppSetupRequests")
          .where("id", "=", input.requestId)
          .where("runnerId", "=", input.runnerId)
          .returning("id")
          .execute();
        return declineComputerAppAccessRequestsInTransaction(transaction, {
          setupRequestIds: removed.map(({ id }) => id),
        });
      },
    );
  }

  /**
   * Sweeps approvals nobody answered inside their week.
   *
   * Reads already hide an expired row and `setComputerConnection` already
   * refuses it, so the row itself is harmless. A `computer.app.access` Request
   * linked to one is not — it would sit pending forever — so the Host's
   * minute tick calls this, and every other path that removes a row settles
   * its Requests too.
   */
  async expireComputerAppSetupRequests(
    now = new Date(),
  ): Promise<ComputerAppAccessSettlement & { readonly runnerIds: readonly RunnerId[] }> {
    // One Mac per transaction, each under that Mac's approval scope, so the
    // sweep takes its locks in the order every approval does.
    const expiring = await this.database
      .selectFrom("computerAppSetupRequests")
      .select("runnerId")
      .distinct()
      .where("expiresAt", "<=", now)
      .orderBy("runnerId", "asc")
      .execute();
    const grants: IntegrationGrant[] = [];
    const requestEvents: AgentEvent[] = [];
    const requestIds: RequestId[] = [];
    const runnerIds: RunnerId[] = [];
    for (const { runnerId } of expiring) {
      const settled = await withRequestWorkspaceLocks(
        this.database,
        async (transaction) => [
          ...(await discoverComputerRequestWorkspaces(transaction, runnerId)),
        ],
        async (transaction) => {
          await lockComputerApprovalScopeInTransaction(transaction, { runnerId });
          const expired = await transaction
            .deleteFrom("computerAppSetupRequests")
            .where("runnerId", "=", runnerId)
            .where("expiresAt", "<=", now)
            .returning("id")
            .execute();
          return declineComputerAppAccessRequestsInTransaction(transaction, {
            setupRequestIds: expired.map(({ id }) => id),
          });
        },
      );
      grants.push(...settled.grants);
      requestEvents.push(...settled.requestEvents);
      requestIds.push(...settled.requestIds);
      runnerIds.push(runnerId);
    }
    return { grants, requestEvents, requestIds, runnerIds };
  }

  /**
   * The owner's change to a computer app's connection.
   *
   * With a signed approval it consumes that approval, which is how a
   * Mac connection is created, widened or unblocked. Without one a Mac app can
   * only keep or lower access. An owner can set phone access from any client.
   *
   * `app` names which app on the Mac, for a definition whose connections do.
   * It is checked against the installed definition rather than trusted, so a
   * caller that forgot it cannot write an app-less `macos-app` row and take
   * the `(definitionId, runnerId, '')` slot every other app needs.
   */
  async setComputerConnection(
    input: SetComputerConnectionInput,
  ): Promise<SetComputerConnectionResult> {
    return withRequestWorkspaceLocks(
      this.database,
      async (transaction) => [
        ...(await discoverComputerRequestWorkspaces(transaction, input.runnerId)),
      ],
      async (transaction) => {
        const runner = await lockComputerOwnerInTransaction(transaction, {
          ...input,
          workspaceIds: [],
        });
        const descriptor = await transaction
          .selectFrom("runners")
          .select(["device", "moduleDescriptors", "allowedModules", "kind"])
          .where("id", "=", runner.id)
          .executeTakeFirstOrThrow();
        const phone = input.definitionId === "android-phone";
        if (
          phone &&
          (input.app !== null ||
            descriptor.kind !== "local" ||
            descriptor.device?.form !== "phone" ||
            descriptor.device.platform !== "android" ||
            !descriptor.allowedModules.includes("integrations") ||
            descriptor.moduleDescriptors.integrations?.platform !== "android" ||
            runnerIntegrationsCompatibilityReason(descriptor.moduleDescriptors.integrations) !==
              null)
        ) {
          throw new OpensteerError({
            code: "forbidden",
            message: "This Runner is not an eligible Android phone.",
          });
        }
        if (input.approval && (phone || descriptor.device?.platform === "android")) {
          throw new OpensteerError({
            code: "forbidden",
            message: "Allow phone access from any Opensteer app.",
          });
        }
        const target = await computerConnectionTargetInTransaction(transaction, input);
        return input.approval
          ? consumeComputerAppApprovalInTransaction(transaction, {
              ...input,
              approval: input.approval,
              runner,
              target,
            })
          : reviseComputerConnectionInTransaction(transaction, { ...input, runner, target });
      },
    );
  }

  /** A task's ask for a new app on a Mac whose owner allows any app automatically. */
  async approveComputerAppAutomatically(
    input: AutomaticComputerAppApprovalInput,
  ): Promise<SetComputerConnectionResult> {
    return withRequestWorkspaceLocks(
      this.database,
      async (transaction) => [
        input.workspaceId,
        ...(await discoverComputerRequestWorkspaces(transaction, input.runnerId)),
      ],
      async (transaction) => {
        const runner = await lockComputerOwnerInTransaction(transaction, {
          ...input,
          workspaceIds: [input.workspaceId],
        });
        const policy = await computerUsePolicyInTransaction(
          transaction,
          input.runnerId,
          input.actorUserId,
        );
        if (policy.appApproval !== "automatic") {
          throw new OpensteerError({
            code: "forbidden",
            message: "Automatic app approval is not enabled on this Mac.",
          });
        }
        return approveComputerAppAutomaticallyInTransaction(transaction, { ...input, runner });
      },
    );
  }

  async blockComputerApp(input: {
    readonly connectionId: IntegrationConnectionId;
    readonly ownerUserId: UserId;
    readonly requestId: string;
  }): Promise<RevokeComputerConnectionsMutation> {
    return withRequestWorkspaceLocks(
      this.database,
      async (transaction) => [...(await discoverComputerRemovalWorkspaces(transaction, input))],
      async (transaction) => {
        const connection = await transaction
          .selectFrom("integrationConnections")
          .select(["runnerId", "computerApp"])
          .where("id", "=", input.connectionId)
          .where("ownerUserId", "=", input.ownerUserId)
          .where("connectionKind", "=", "computer")
          .where("status", "!=", "revoked")
          .executeTakeFirst();
        if (!connection?.runnerId || !connection.computerApp) {
          throw new OpensteerError({ code: "not_found", message: "Computer app not found" });
        }
        await lockComputerApprovalScopeInTransaction(transaction, {
          runnerId: connection.runnerId,
        });
        const ownership = await machineOwnershipIn(transaction, connection.runnerId);
        if (ownership?.effectiveOwner !== input.ownerUserId) {
          throw new OpensteerError({
            code: "forbidden",
            message: "Only this computer’s owner can block its apps.",
          });
        }
        const mutation = await revokeComputerConnectionsInTransaction(transaction, input);
        const now = new Date();
        await transaction
          .updateTable("integrationConnections")
          .set({ computerBlockedAt: now, status: "paused", updatedAt: now })
          .where("id", "=", input.connectionId)
          .execute();
        await transaction
          .insertInto("securityAudit")
          .values({
            action: "integration.computer-app.blocked",
            actorSessionId: null,
            actorUserId: input.ownerUserId,
            id: createId("securityAudit"),
            metadata: jsonValue({}),
            requestId: input.requestId,
            targetId: input.connectionId,
            targetType: "integration-connection",
            workspaceId: null,
          })
          .execute();
        return mutation;
      },
    );
  }

  async revokeComputerConnection(input: {
    readonly connectionId: IntegrationConnectionId;
    readonly ownerUserId: UserId;
    readonly requestId: string;
  }): Promise<RevokeComputerConnectionsMutation> {
    return withRequestWorkspaceLocks(
      this.database,
      async (transaction) => [...(await discoverComputerRemovalWorkspaces(transaction, input))],
      async (transaction) => {
        const named = await transaction
          .selectFrom("integrationConnections")
          .select("runnerId")
          .where("id", "=", input.connectionId)
          .where("ownerUserId", "=", input.ownerUserId)
          .where("connectionKind", "=", "computer")
          .executeTakeFirst();
        if (named?.runnerId) {
          await lockComputerApprovalScopeInTransaction(transaction, { runnerId: named.runnerId });
        }
        const mutation = await revokeComputerConnectionsInTransaction(transaction, {
          connectionId: input.connectionId,
          ownerUserId: input.ownerUserId,
        });
        if (mutation.connectionIds.length === 0) {
          throw new OpensteerError({ code: "not_found", message: "Computer app not found" });
        }
        await transaction
          .insertInto("securityAudit")
          .values({
            action: "integration.computer-connection.revoked",
            actorSessionId: null,
            actorUserId: input.ownerUserId,
            id: createId("securityAudit"),
            metadata: jsonValue({ cancelledRequests: mutation.cancelledRequestIds.length }),
            requestId: input.requestId,
            targetId: input.connectionId,
            targetType: "integration-connection",
            workspaceId: null,
          })
          .executeTakeFirstOrThrow();
        return mutation;
      },
    );
  }

  async getComputerConnectionForCall(input: {
    readonly connectionId: IntegrationConnectionId;
    readonly ownerUserId: UserId;
  }): Promise<{
    readonly access: IntegrationAccess;
    readonly connection: IntegrationConnectionSummary;
    readonly runnerId: RunnerId;
    readonly runnerName: string;
    readonly deviceProfile: "iphone" | null;
    readonly runnerRevoked: boolean;
  } | null> {
    const row = await this.database
      .selectFrom("integrationConnections")
      .innerJoin("runners", "runners.id", "integrationConnections.runnerId")
      .selectAll("integrationConnections")
      .select([
        "runners.name as runnerName",
        "runners.deviceProfile",
        "runners.revokedAt as runnerRevokedAt",
      ])
      .where("integrationConnections.id", "=", input.connectionId)
      .where("integrationConnections.ownerUserId", "=", input.ownerUserId)
      .where("integrationConnections.connectionKind", "=", "computer")
      .where("integrationConnections.status", "!=", "revoked")
      .executeTakeFirst();
    if (!row?.runnerId || !row.computerAccess || row.computerBlockedAt !== null) return null;
    return {
      access: row.computerAccess,
      connection: integrationConnectionFromRow(row),
      runnerId: row.runnerId,
      runnerName: row.runnerName,
      deviceProfile: row.deviceProfile,
      runnerRevoked: row.runnerRevokedAt !== null,
    };
  }

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
    await withDatabaseTransaction(this.database, async (transaction) => {
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
    readonly connectionId: IntegrationConnectionId;
    readonly ownerUserId: UserId;
    readonly requestId: string;
  }): Promise<void> {
    await withDatabaseTransaction(this.database, async (transaction) => {
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
          workspaceId: null,
        })
        .executeTakeFirstOrThrow();
    });
  }

  async markMcpOAuthConnectionNeedsAttention(input: {
    readonly connectionId: IntegrationConnectionId;
    readonly expectedRevision: number;
    readonly ownerUserId: UserId;
    readonly statusDetail: string;
  }): Promise<boolean> {
    return withDatabaseTransaction(this.database, async (transaction) => {
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

export type { CreateIntegrationGrantInput } from "./integration-grant-write.js";

export class IntegrationGrantStore extends IntegrationPlatformStoreBase {
  readonly #callableToolsCache = new IntegrationAuthorityCache<
    readonly CallableIntegrationTool[]
  >();

  async createGrant(input: CreateIntegrationGrantInput): Promise<IntegrationGrant> {
    return withDatabaseTransaction(this.database, async (transaction) => {
      // Standalone grants have no Request/approval transaction to fence their
      // parents. Hold those fences before the grant scope, then validate current
      // membership and resource state in createGrantInTransaction.
      await lockRequestWorkspaces(transaction, [input.workspaceId]);
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
      if (input.connectionId) {
        const connection = await transaction
          .selectFrom("integrationConnections")
          .select("providerApplicationId")
          .where("id", "=", input.connectionId)
          .forShare()
          .executeTakeFirst();
        if (connection?.providerApplicationId) {
          await transaction
            .selectFrom("integrationProviderApplications")
            .select("id")
            .where("id", "=", connection.providerApplicationId)
            .forShare()
            .execute();
        }
      }
      return this.createGrantInTransaction(transaction, input);
    });
  }

  async createGrantInTransaction(
    transaction: Transaction<DatabaseSchema>,
    input: CreateIntegrationGrantInput,
  ): Promise<IntegrationGrant> {
    return writeIntegrationGrantInTransaction(transaction, input);
  }

  async listGrants(input: {
    readonly ownerUserId: UserId;
    readonly workspaceId: WorkspaceId;
  }): Promise<readonly IntegrationGrant[]> {
    const rows = await this.database
      .selectFrom("integrationGrants")
      .selectAll()
      .where("ownerUserId", "=", input.ownerUserId)
      .where("workspaceId", "=", input.workspaceId)
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
    readonly providerAuthorizations: Readonly<Record<string, IntegrationProviderAuthorization>>;
    readonly requestedServerId: IntegrationServerId | null;
  }): Promise<boolean> {
    const requestedServerId = input.requestedServerId;
    const [{ connections }, servers] = await Promise.all([
      this.authoritySnapshot(input.ownerUserId, input.providerAuthorizations),
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
    return servers.some((server) => {
      const connectionRequirement = IntegrationConnectionRequirementSchema.parse(
        server.connectionRequirement,
      );
      return (
        connectionRequirement.kind !== "none" &&
        isIntegrationConnectionEligible({
          connection,
          connectionRequirement,
          serverId: server.id,
        })
      );
    });
  }

  async revokeGrant(input: {
    readonly grantId: IntegrationGrant["id"];
    readonly ownerUserId: UserId;
    readonly requestId: string;
    readonly workspaceId: WorkspaceId;
  }): Promise<void> {
    await withDatabaseTransaction(this.database, async (transaction) => {
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
        .where("workspaceId", "=", input.workspaceId)
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
          workspaceId: input.workspaceId,
        })
        .executeTakeFirstOrThrow();
    });
  }

  async listCallableTools(
    input: IntegrationRequester & {
      readonly providerAuthorizations: Readonly<Record<string, IntegrationProviderAuthorization>>;
    },
  ): Promise<readonly CallableIntegrationTool[]> {
    const authorityFingerprint = JSON.stringify(
      Object.entries(input.providerAuthorizations).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
    const inheritsMain = (await this.mainAccess(input)) === "inherited";
    const scope = {
      authorityFingerprint,
      inheritsMain,
      ownerUserId: input.ownerUserId,
      workspaceId: input.workspaceId,
    };
    for (;;) {
      const generation = await this.authorityGeneration(input.ownerUserId);
      const cached = this.#callableToolsCache.get({ ...scope, generation });
      if (cached) return cached;
      const resolved = await this.resolveCallableTools({ ...input, inheritsMain });
      const verifiedGeneration = await this.authorityGeneration(input.ownerUserId);
      if (verifiedGeneration !== generation) continue;
      this.#callableToolsCache.set({ ...scope, generation }, resolved);
      return resolved;
    }
  }

  async getToolInvocation(toolId: IntegrationToolId): Promise<IntegrationToolInvocation | null> {
    const row = await this.database
      .selectFrom("integrationTools")
      .innerJoin("integrationServers", "integrationServers.id", "integrationTools.serverId")
      .innerJoin(
        "integrationInstallations",
        "integrationInstallations.id",
        "integrationServers.installationId",
      )
      .select([
        "integrationInstallations.adapterSnapshot",
        "integrationInstallations.revision as installationRevision",
        "integrationServers.toolGeneration",
        "integrationTools.schemaDigest",
        "integrationTools.status",
        "integrationTools.target",
      ])
      .where("integrationTools.id", "=", toolId)
      .executeTakeFirst();
    return row ?? null;
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
        message: "Integration operation schema changed; search and describe it again",
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
    readonly inheritsMain: boolean;
    readonly ownerUserId: UserId;
    readonly providerAuthorizations: Readonly<Record<string, IntegrationProviderAuthorization>>;
    readonly workspaceId: WorkspaceId;
  }): Promise<readonly CallableIntegrationTool[]> {
    const grants = await this.listGrants(input);
    const inheritedMainAccess = input.inheritsMain;
    const activeGrants = grants.filter(({ status }) => status === "active");
    if (!inheritedMainAccess && activeGrants.length === 0) return [];
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
    const { connections } = await this.authoritySnapshot(
      input.ownerUserId,
      input.providerAuthorizations,
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    const installationById = new Map(
      rows.map((row) => [row.joinedInstallationId, installationFromCallableToolRow(row)]),
    );
    const resolved = resolveEffectiveGrants({
      connections,
      inheritedMainAccess,
      installations: [...installationById.values()],
      ownerUserId: input.ownerUserId,
      skills: [],
      storedGrants: grants,
      tools: rows.map((row) => ({
        ...toolFromRow(row),
        connectionRequirement: IntegrationConnectionRequirementSchema.parse(
          row.joinedServerConnectionRequirement,
        ),
        installationId: row.joinedInstallationId,
        serverStatus: row.joinedServerStatus,
      })),
      workspaceId: input.workspaceId,
    });
    return resolved.tools.map(({ grant, tool }) => callableToolFromRow(byId.get(tool.id)!, grant));
  }

  async listGrantedSkills(
    input: IntegrationRequester,
  ): Promise<readonly GrantedIntegrationSkill[]> {
    const [storedGrants, mainAccess] = await Promise.all([
      this.listGrants(input),
      this.mainAccess(input),
    ]);
    const inheritedMainAccess = mainAccess === "inherited";
    const grants = storedGrants.filter(({ status }) => status === "active");
    const installations = await this.installationInventory();
    const installationIds = [
      ...new Set(
        (inheritedMainAccess
          ? installations.filter(({ status }) => status === "active")
          : grants
        ).map((record) => ("installationId" in record ? record.installationId : record.id)),
      ),
    ];
    if (installationIds.length === 0) return [];
    const skillGroups = await Promise.all(
      installationIds.map((installationId) => this.installationSkills(installationId)),
    );
    const installationById = new Map(
      installations.map((installation) => [installation.id, installation]),
    );
    const resolved = resolveEffectiveGrants({
      connections: [],
      inheritedMainAccess,
      installations,
      ownerUserId: input.ownerUserId,
      skills: skillGroups.flat(),
      storedGrants,
      tools: [],
      workspaceId: input.workspaceId,
    });
    return resolved.skills.map(({ grant, skill }) => ({
      grant,
      installation: installationById.get(skill.installationId)!,
      skill,
    }));
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

function validateAdapterInstallation(input: {
  readonly adapterSnapshot: IntegrationAdapterSnapshot | null;
  readonly installation: Omit<IntegrationInstallation, "createdAt" | "revision" | "updatedAt">;
  readonly servers: readonly DiscoveredIntegrationServer[];
}): IntegrationAdapterSnapshot | null {
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
    if (input.adapterSnapshot !== null) {
      throw invalidAdapterInstallation("A computer app cannot store an adapter snapshot");
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
    if (server.catalog.tools.length !== 0) {
      throw invalidAdapterInstallation("A computer server cannot carry server-level tools");
    }
    return null;
  }
  const adapterServers = input.servers.filter(({ transport }) => transport.type === "adapter");
  if (adapterServers.length === 0) {
    if (input.adapterSnapshot !== null) {
      throw invalidAdapterInstallation(
        "A non-adapter installation cannot store an adapter snapshot",
      );
    }
    return null;
  }

  let definition: IntegrationDefinitionSummary;
  try {
    definition = IntegrationDefinitionSummarySchema.parse(input.installation.manifest.definition);
  } catch (cause) {
    throw invalidAdapterInstallation(
      "An adapter installation requires one verified public definition",
      cause,
    );
  }
  for (const server of adapterServers) {
    if (
      server.transport.type !== "adapter" ||
      server.transport.adapter !== definition.adapter ||
      server.transport.definitionId !== definition.id
    ) {
      throw invalidAdapterInstallation(
        "Every adapter server must match its installation definition",
      );
    }
  }

  if (input.adapterSnapshot === null) {
    if (adapterServers.some(({ status }) => status === "active")) {
      throw invalidAdapterInstallation("An active adapter server requires a runtime snapshot");
    }
    return null;
  }
  let snapshot;
  try {
    snapshot = IntegrationAdapterSnapshotSchema.parse(input.adapterSnapshot);
  } catch (cause) {
    throw invalidAdapterInstallation("The adapter runtime snapshot is invalid", cause);
  }
  if (snapshot.adapter !== definition.adapter || snapshot.definitionId !== definition.id) {
    throw invalidAdapterInstallation("The adapter runtime snapshot does not match its definition");
  }
  return snapshot;
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
export function installedIntegrationDefinition(row: {
  readonly adapterSnapshot: unknown;
  readonly manifest: Readonly<Record<string, unknown>>;
}): IntegrationDefinition {
  let summary: IntegrationDefinitionSummary;
  try {
    summary = IntegrationDefinitionSummarySchema.parse(row.manifest.definition);
  } catch (cause) {
    throw invalidAdapterInstallation(
      "The installation stores no verified public definition",
      cause,
    );
  }
  if (row.adapterSnapshot === null || row.adapterSnapshot === undefined) {
    throw invalidAdapterInstallation(
      `Installed integration ${summary.id} stores no adapter configuration, so its definition cannot be resolved`,
    );
  }
  let snapshot: IntegrationAdapterSnapshot;
  try {
    snapshot = IntegrationAdapterSnapshotSchema.parse(row.adapterSnapshot);
  } catch (cause) {
    throw invalidAdapterInstallation("The adapter runtime snapshot is invalid", cause);
  }
  if (snapshot.definitionId !== summary.id || snapshot.adapter !== summary.adapter) {
    throw invalidAdapterInstallation("The adapter runtime snapshot does not match its definition");
  }
  const { apiKey, ...definition } = summary;
  void apiKey;
  return IntegrationDefinitionSchema.parse({ ...definition, config: snapshot.config });
}

function installationFromRow(
  row: Selectable<IntegrationInstallationTable>,
): IntegrationInstallation {
  return IntegrationInstallationSchema.parse({
    createdAt: row.createdAt.toISOString(),
    description: row.description,
    id: row.id,
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

function skillFromRow(row: Selectable<IntegrationSkillTable>): IntegrationSkill {
  return IntegrationSkillSchema.parse({
    description: row.description,
    digest: row.digest,
    id: row.id,
    installationId: row.installationId,
    name: row.name,
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
  });
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

export type AutomaticComputerAppApprovalInput = Omit<
  SetComputerConnectionInput,
  "approval" | "createIfMissing"
> & {
  readonly workspaceId: WorkspaceId;
};

interface LockedComputer {
  readonly id: RunnerId;
  readonly name: string;
}

/** The computer's fence, taken after Workspaces, and the owner check under it. */
async function lockComputerOwnerInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly actorUserId: UserId;
    readonly runnerId: RunnerId;
    readonly workspaceIds: readonly WorkspaceId[];
  },
): Promise<LockedComputer> {
  const runner = await lockComputerApprovalScopeInTransaction(transaction, {
    runnerId: input.runnerId,
    workspaceIds: input.workspaceIds,
  });
  if (runner.revokedAt !== null) {
    throw new OpensteerError({ code: "not_found", message: "Computer not found" });
  }
  const ownership = await machineOwnershipIn(transaction, runner.id);
  if (ownership?.effectiveOwner !== input.actorUserId) {
    throw new OpensteerError({
      code: "forbidden",
      message: "Only the person who added this computer can turn its apps on.",
    });
  }
  return runner;
}

/** Where a computer app's connection lives, and the row it has now, locked. */
interface ComputerConnectionTarget {
  readonly current: Selectable<IntegrationConnectionTable> | undefined;
  readonly definition: IntegrationDefinitionSummary;
  readonly installed: {
    readonly installationId: IntegrationInstallationId;
    readonly serverId: IntegrationServerId;
    readonly toolGeneration: number;
  };
  readonly scope: ComputerAppScope;
}

async function computerConnectionTargetInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly app: ComputerAppIdentity | null;
    readonly definitionId: string;
    readonly runnerId: RunnerId;
  },
): Promise<ComputerConnectionTarget> {
  const installedRows = await transaction
    .selectFrom("integrationInstallations")
    .innerJoin(
      "integrationServers",
      "integrationServers.installationId",
      "integrationInstallations.id",
    )
    .select([
      "integrationInstallations.id as installationId",
      "integrationInstallations.manifest",
      "integrationInstallations.title",
      "integrationServers.connectionRequirement",
      "integrationServers.id as serverId",
      "integrationServers.toolGeneration",
      "integrationServers.transport",
    ])
    .where("integrationInstallations.status", "=", "active")
    .where("integrationServers.status", "=", "active")
    .where(
      sql<boolean>`integration_installations.manifest -> 'definition' ->> 'id' = ${input.definitionId}`,
    )
    .orderBy("integrationServers.id", "asc")
    .forNoKeyUpdate("integrationServers")
    .execute();
  const installed = installedRows.find((row) => {
    const transport = IntegrationServerSchema.shape.transport.safeParse(row.transport);
    const requirement = IntegrationConnectionRequirementSchema.safeParse(row.connectionRequirement);
    return (
      transport.success &&
      transport.data.type === "computer" &&
      transport.data.definitionId === input.definitionId &&
      requirement.success &&
      requirement.data.kind === "computer" &&
      requirement.data.definitionId === input.definitionId
    );
  });
  if (!installed) {
    const known = await transaction
      .selectFrom("integrationInstallations")
      .select("title")
      .where(
        sql<boolean>`integration_installations.manifest -> 'definition' ->> 'id' = ${input.definitionId}`,
      )
      .orderBy("createdAt", "asc")
      .executeTakeFirst();
    throw new OpensteerError({
      code: "not_found",
      message: `${known?.title ?? input.definitionId} is not installed`,
    });
  }
  const definition = IntegrationDefinitionSummarySchema.parse(installed.manifest.definition);
  if (definition.adapter !== "computer") {
    throw new OpensteerError({ code: "not_found", message: `${definition.name} is not installed` });
  }
  assertComputerAppPresence({
    app: input.app,
    requiresApp: definition.computerApp?.kind === "gui",
  });
  const runner = await transaction
    .selectFrom("runners")
    .select("moduleDescriptors")
    .where("id", "=", input.runnerId)
    .executeTakeFirstOrThrow();
  const platform = runner.moduleDescriptors.integrations?.platform;
  if (platform && !definition.computerApp?.platforms.includes(platform))
    throw new OpensteerError({
      code: "forbidden",
      message: "This app is not supported on this computer.",
    });
  const scope = computerAppScopeOf(input);
  const current = await transaction
    .selectFrom("integrationConnections")
    .selectAll()
    .where("connectionKind", "=", "computer")
    .where("integrationDefinitionId", "=", input.definitionId)
    .where("runnerId", "=", input.runnerId)
    .where("computerAppKey", scope.appKey === null ? "is" : "=", scope.appKey)
    .where("status", "!=", "revoked")
    .forNoKeyUpdate()
    .executeTakeFirst();
  return {
    current,
    definition,
    installed: {
      installationId: installed.installationId,
      serverId: installed.serverId,
      toolGeneration: installed.toolGeneration,
    },
    scope,
  };
}

function storedComputerApp(
  row: Selectable<IntegrationConnectionTable> | undefined,
): ComputerAppIdentity | null {
  return row?.computerApp === null || row?.computerApp === undefined
    ? null
    : ComputerAppIdentitySchema.parse(row.computerApp);
}

/**
 * Consumes one signed approval: the only way a Mac connection is created, widened
 * or unblocked. The approval is one row, so consuming it invalidates every
 * other signature for this app — and only for this app: consuming Notes leaves
 * Calendar's approval, and the Thread waiting on it, where it was.
 */
async function consumeComputerAppApprovalInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: SetComputerConnectionInput & {
    readonly approval: ComputerAppApproval;
    readonly runner: LockedComputer;
    readonly target: ComputerConnectionTarget;
  },
): Promise<SetComputerConnectionResult> {
  const { current, scope } = input.target;
  if (!current && !input.createIfMissing) throw new ComputerAppNotOfferedError(input.runner.name);
  const widened = current?.computerAccess === "read" && input.access === "read-write";
  if (widened && !input.createIfMissing) throw new ComputerAppNotOfferedError(input.runner.name);
  const now = new Date();
  const pending = await transaction
    .selectFrom("computerAppSetupRequests")
    .selectAll()
    .where("id", "=", input.approval.requestId)
    .where("runnerId", "=", input.runnerId)
    .where("ownerUserId", "=", input.actorUserId)
    .where("definitionId", "=", input.definitionId)
    .where("kind", "=", "app")
    .where("access", "=", input.access)
    .where("definitionDigest", "=", input.definitionDigest)
    // The signature covers the app, so a proof taken over Notes can never
    // enable Calendar even though both name this Mac.
    .where("appKey", scope.appKey === null ? "is" : "=", scope.appKey)
    .where("expiresAt", ">", now)
    // FOR UPDATE: Consuming the app approval deletes this setup request.
    .forUpdate()
    .executeTakeFirst();
  const candidate = pending ? computerAppSetupRequestFromRow(pending) : null;
  const pendingRequest = await assertComputerAppApprovalInTransaction(transaction, {
    approval: input.approval,
    now,
    ownerUserId: input.actorUserId,
    refusal: "Approve this access in Opensteer on the computer that provides the app.",
    request: candidate && computerAppIdentitiesEqual(candidate.app, input.app) ? candidate : null,
    runnerId: input.runner.id,
  });
  const row = await writeComputerConnectionInTransaction(transaction, {
    access: input.access,
    app: pendingRequest.app,
    now,
    ownerUserId: input.actorUserId,
    runner: input.runner,
    target: input.target,
  });
  const changed = await finishComputerConnectionChangeInTransaction(transaction, {
    ...input,
    connectionAccess: input.access,
    consumedSetupRequestId: pendingRequest.id,
    created: current === undefined,
    now,
    reissueWaiting: false,
    row,
    tools: input.tools(row.id),
    widened,
  });
  return {
    ...changed,
    sessionReset: sessionResetFor(current, pendingRequest.app, input.access, input.target),
  };
}

/**
 * The owner setting a phone's access, or keeping or lowering a Mac app's access.
 * A lower access leaves a wider waiting approval under a new id, so a signature
 * taken before the reduction cannot widen the app back behind the owner's back.
 */
async function reviseComputerConnectionInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: SetComputerConnectionInput & {
    readonly runner: LockedComputer;
    readonly target: ComputerConnectionTarget;
  },
): Promise<SetComputerConnectionResult> {
  const { current } = input.target;
  if (!current && !input.createIfMissing) throw new ComputerAppNotOfferedError(input.runner.name);
  const widened = current?.computerAccess === "read" && input.access === "read-write";
  if (widened && !input.createIfMissing) throw new ComputerAppNotOfferedError(input.runner.name);
  if (
    input.definitionId !== "android-phone" &&
    (!current || widened || current.computerBlockedAt)
  ) {
    throw new OpensteerError({
      code: "forbidden",
      message: "Approve this access in Opensteer on the computer that provides the app.",
    });
  }
  const now = new Date();
  const app = storedComputerApp(current);
  const row = await writeComputerConnectionInTransaction(transaction, {
    access: input.access,
    app,
    now,
    ownerUserId: input.actorUserId,
    runner: input.runner,
    target: input.target,
  });
  const changed = await finishComputerConnectionChangeInTransaction(transaction, {
    ...input,
    connectionAccess: input.access,
    consumedSetupRequestId: null,
    created: current === undefined,
    now,
    reissueWaiting: current?.computerAccess === "read-write" && input.access === "read",
    row,
    tools: input.tools(row.id),
    widened,
  });
  return { ...changed, sessionReset: sessionResetFor(current, app, input.access, input.target) };
}

/**
 * Approves an app under the owner's automatic policy: a new connection with
 * the asked access, or a grant on an existing one that already covers the
 * ask. It never widens or re-identifies an existing connection; that is
 * always a prompt on the Mac.
 *
 * The caller holds the Mac's row and has read the policy under that lock, so
 * the decision and this write are one.
 */
export async function approveComputerAppAutomaticallyInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: AutomaticComputerAppApprovalInput & { readonly runner: LockedComputer },
): Promise<SetComputerConnectionResult> {
  const target = await computerConnectionTargetInTransaction(transaction, input);
  const { current } = target;
  const app = input.app;
  if (app === null || target.definition.computerApp?.kind !== "gui") {
    throw new OpensteerError({
      code: "forbidden",
      message: "Automatic app approval is not enabled on this Mac.",
    });
  }
  if (current?.computerBlockedAt) {
    throw new OpensteerError({
      code: "forbidden",
      message: `${app.displayName} is blocked on ${input.runner.name}. The person can unblock it on that Mac.`,
    });
  }
  const connectionAccess = current?.computerAccess ?? input.access;
  if (
    current &&
    (!computerAppIdentitiesEqual(current.computerApp, app) ||
      !integrationAccessCovers(connectionAccess, input.access))
  ) {
    throw new OpensteerError({
      code: "forbidden",
      message: "Approve this access in Opensteer on the computer that provides the app.",
    });
  }
  const workspace = await transaction
    .selectFrom("workspaces")
    .select(["kind", "status"])
    .where("id", "=", input.workspaceId)
    .where("createdBy", "=", input.actorUserId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (!workspace || workspace.status !== "ready") {
    throw new OpensteerError({ code: "not_found", message: "Workspace not found" });
  }
  const now = new Date();
  const row = await writeComputerConnectionInTransaction(transaction, {
    access: connectionAccess,
    app,
    now,
    ownerUserId: input.actorUserId,
    runner: input.runner,
    target,
  });
  const changed = await finishComputerConnectionChangeInTransaction(transaction, {
    ...input,
    // Main inherits the owner's authority and needs no row.
    ...(workspace.kind === "main"
      ? {}
      : { alsoGrant: { access: input.access, workspaceId: input.workspaceId } }),
    connectionAccess,
    consumedSetupRequestId: null,
    created: current === undefined,
    now,
    reissueWaiting: false,
    row,
    target,
    // An existing connection keeps the tools its own approval gave it.
    tools: current ? null : input.tools(row.id),
    widened: false,
  });
  return { ...changed, sessionReset: null };
}

async function writeComputerConnectionInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly access: IntegrationAccess;
    readonly app: ComputerAppIdentity | null;
    readonly now: Date;
    readonly ownerUserId: UserId;
    readonly runner: LockedComputer;
    readonly target: ComputerConnectionTarget;
  },
): Promise<Selectable<IntegrationConnectionTable>> {
  const { current, definition, installed, scope } = input.target;
  const values = {
    computerAccess: input.access,
    computerApp: input.app === null ? null : jsonValue(input.app),
    computerAppKey: scope.appKey,
    computerBlockedAt: null,
    displayName:
      input.app === null ? input.runner.name : `${input.app.displayName} on ${input.runner.name}`,
    integrationServerId: installed.serverId,
    provider: definition.provider,
    status: "connected" as const,
    statusDetail: null,
    updatedAt: input.now,
  };
  if (current) {
    return transaction
      .updateTable("integrationConnections")
      .set(values)
      .where("id", "=", current.id)
      .where("connectionKind", "=", "computer")
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  return transaction
    .insertInto("integrationConnections")
    .values({
      ...values,
      accountIdentifier: null,
      applicationSource: null,
      authMethodId: "computer",
      authorizationDigest: null,
      capabilities: jsonValue([]),
      connectionKind: "computer",
      connectionMethod: "computer",
      credentialId: null,
      externalIdentityId: null,
      externalTenantId: null,
      grantedScopes: jsonValue([]),
      id: createIntegrationId("connection"),
      integrationDefinitionId: scope.definitionId,
      ownerUserId: input.ownerUserId,
      providerApplicationId: null,
      runnerId: scope.runnerId,
      transportKind: null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * Everything a connection change owes after its row is written: the tools
 * its access exposes, the generation bump that makes callers re-read them,
 * the Main Requests it satisfies, the `computer.app.access` Requests it
 * answers, and the audit record — one transaction, exactly as an
 * `integration.access` answer is.
 */
async function finishComputerConnectionChangeInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly access: IntegrationAccess;
    readonly actorUserId: UserId;
    readonly alsoGrant?: { readonly access: IntegrationAccess; readonly workspaceId: WorkspaceId };
    readonly connectionAccess: IntegrationAccess;
    readonly consumedSetupRequestId: string | null;
    readonly created: boolean;
    readonly definitionDigest: string;
    readonly definitionId: string;
    readonly now: Date;
    readonly reissueWaiting: boolean;
    readonly requestId: string;
    readonly row: Selectable<IntegrationConnectionTable>;
    readonly target: ComputerConnectionTarget;
    /** Null keeps the tools the connection already has. */
    readonly tools: readonly IntegrationToolMaterial[] | null;
    readonly widened: boolean;
  },
): Promise<Omit<SetComputerConnectionResult, "sessionReset">> {
  const { installed, scope } = input.target;
  const connectionId = input.row.id;
  await transaction
    .updateTable("integrationServers")
    .set({ toolGeneration: installed.toolGeneration + 1, updatedAt: input.now })
    .where("id", "=", installed.serverId)
    .where("toolGeneration", "=", installed.toolGeneration)
    .executeTakeFirstOrThrow();
  const app = storedComputerApp(input.row);
  const mainRequests =
    input.created || input.widened
      ? await pendingMainIntegrationAccessRequests(transaction, {
          access: input.connectionAccess,
          connectionId,
          installationId: installed.installationId,
          ownerUserId: input.actorUserId,
          serverId: installed.serverId,
        }).execute()
      : [];
  const settlement = await settleComputerAppApprovalInTransaction(transaction, {
    additionalRequestIds: mainRequests.map(({ id }) => id),
    ...(input.alsoGrant ? { alsoGrant: input.alsoGrant } : {}),
    connection: {
      access: input.connectionAccess,
      alias: app?.displayName ?? input.row.displayName,
      app,
      definitionDigest: input.definitionDigest,
      connectionId,
      installationId: installed.installationId,
      ownerUserId: input.actorUserId,
    },
    consumedSetupRequestId: input.consumedSetupRequestId,
    reissueWaiting: input.reissueWaiting,
    scope,
  });
  const mainRequestEvents =
    input.created || input.widened
      ? await fulfillPendingMainIntegrationAccessRequestsInTransaction(transaction, {
          access: input.connectionAccess,
          connectionId,
          displayName: input.row.displayName,
          installationId: installed.installationId,
          ownerUserId: input.actorUserId,
          serverId: installed.serverId,
        })
      : [];
  if (input.tools !== null) {
    await upsertConnectionTools(
      transaction,
      installed.serverId,
      connectionId,
      { definitions: {}, tools: input.tools },
      input.now,
      "delete",
    );
  }
  await transaction
    .insertInto("securityAudit")
    .values({
      action: input.created
        ? "integration.computer-connection.created"
        : "integration.computer-connection.updated",
      actorSessionId: null,
      actorUserId: input.actorUserId,
      id: createId("securityAudit"),
      metadata: jsonValue({
        access: input.access,
        ...(scope.appKey === null ? {} : { appKey: scope.appKey }),
        definitionId: input.definitionId,
      }),
      requestId: input.requestId,
      targetId: connectionId,
      targetType: "integration-connection",
      workspaceId: null,
    })
    .executeTakeFirstOrThrow();
  return {
    connection: integrationConnectionFromRow(input.row),
    created: input.created,
    fulfilledRequestIds: settlement.requestIds,
    grants: settlement.grants,
    reissuedSetupRequestId: settlement.reissuedSetupRequestId,
    requestEvents: [...mainRequestEvents, ...settlement.requestEvents],
  };
}

/**
 * A session keeps the access and identity it opened with, so a lower access —
 * or, for an app, a different app on the same key — ends it. A phone's
 * session holds its whole display, which a lower access ends the same way.
 * Every other computer app has no session at all.
 */
function sessionResetFor(
  current: Selectable<IntegrationConnectionTable> | undefined,
  app: ComputerAppIdentity | null,
  access: IntegrationAccess,
  target: ComputerConnectionTarget,
): SetComputerConnectionResult["sessionReset"] {
  const { scope } = target;
  if (!current) return null;
  const lowered = current.computerAccess === "read-write" && access === "read";
  if (scope.appKey === null) {
    return lowered && target.definition.computerApp?.kind === "display"
      ? { definitionId: scope.definitionId, kind: "display", runnerId: scope.runnerId }
      : null;
  }
  return lowered || !computerAppIdentitiesEqual(storedComputerApp(current), app)
    ? { appKey: scope.appKey, kind: "app", runnerId: scope.runnerId }
    : null;
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

async function upsertConnectionTools(
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

const unboundOpenApiReason =
  "Opensteer couldn’t read this integration’s API document after an update and tries again each time it starts. To use it now, uninstall it and add it again.";

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

function forbidden(message: string): OpensteerError {
  return new OpensteerError({ code: "forbidden", message });
}

/**
 * A `gui` definition's connection is one app; every other computer app's
 * connection is the definition on the Runner. Getting this wrong either way
 * would put a row in the wrong slot of the live unique index, so it is an
 * error rather than a default.
 */
function assertComputerAppPresence(input: {
  readonly app: ComputerAppIdentity | null;
  readonly requiresApp: boolean;
}): void {
  if (input.requiresApp === (input.app !== null)) return;
  throw new OpensteerError({
    code: "bad_request",
    message: input.requiresApp
      ? "This computer app names one app on the computer, and none was given."
      : "This computer app is the whole app, not one app on the computer.",
  });
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

/** A Runner authenticates transport; its key must never also authorize iPhone consent. */
export function assertSeparateIphoneApprovalKey(
  profile: "iphone" | null,
  runnerKeyId: string,
  approvalKeyId: string,
): void {
  if (profile === "iphone" && runnerKeyId === approvalKeyId)
    throw new OpensteerError({
      code: "forbidden",
      message: "Use the approval key this iPhone created.",
    });
}
