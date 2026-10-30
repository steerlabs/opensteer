import { z } from "zod";
import {
  ComputerReplService,
  type ComputerReplInvocation,
} from "../computer-use/computer-repl/computer-repl-service.js";
import type { ReplReply, ReplContent } from "../computer-use/computer-repl/messages.js";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import type { RunCapabilityClaims } from "../agents/run-capability.js";
import type {
  ComputerAppIdentity,
  IntegrationConnectionSummary,
} from "@opensteer/integration-core";
import { computerAppIdentityKey } from "@opensteer/integration-core";
import { safeMessage } from "@opensteer/shared/safeMessage";
import { loadAgentPlugin, type LoadedAgentPluginServer } from "@opensteer/agent-plugins";

import { createHash } from "node:crypto";
import { basename } from "node:path";
import { isLoopbackHostname } from "@opensteer/core";
import { sha256Base64Url } from "@opensteer/core/crypto";
import {
  createCredentialResponseRedactor,
  createPublicHttpsFetch,
  type CredentialResponseRedactor,
} from "@opensteer/access/host";
import {
  ApiKeyDisclosureSchema,
  IntegrationAdapterSnapshotSchema,
  IntegrationConnectionIdSchema,
  IntegrationDefinitionSummarySchema,
  IntegrationDefinitionSchema,
  IntegrationInstallationIdSchema,
  IntegrationInstallManifestSchema,
  IntegrationProposalManifestSchema,
  IntegrationProposalCredentialSchema,
  IntegrationProposalCheckSchema,
  IntegrationProposalNameSchema,
  IntegrationProposalDescriptionSchema,
  IntegrationServerIdSchema,
  IntegrationServerTransportSchema,
  accessCoversEffect,
  computerAppNamesApp,
  createIntegrationId,
  integrationCredentialRejectedDetail,
  integrationDefinitionSummary,
  integrationProposalName,
  integrationProposalSummary,
  integrationToolEffect,
  isComputerAppDefinition,
  type AdapterToolCatalog,
  type AuthMethod,
  type AdapterToolResult,
  type IntegrationAdapter,
  type IntegrationAdapterKind,
  type IntegrationAdapterSnapshot,
  type IntegrationAccess,
  type IntegrationConnectionId,
  type IntegrationDefinition,
  type IntegrationDefinitionSummary,
  type IntegrationGrant,
  type IntegrationInstallManifest,
  type IntegrationInstallation,
  type IntegrationInstallationId,
  type IntegrationProposalKind,
  type IntegrationProposalManifest,
  type IntegrationProposalSource,
  type IntegrationServer,
  type IntegrationServerId,
  type IntegrationToolCatalog,
  type IntegrationToolMaterial,
  type LocalMcpLaunch,
} from "@opensteer/integration-core";
import type { ComputerAppDefinition } from "@opensteer/integration-core/computer-app";
import {
  computerAppOperationContract,
  computerAppTools,
} from "@opensteer/integration-core/computer-app-tools";
import {
  type IntegrationAdapterCredentialMaterializer,
  type IntegrationProviderAuthorizationSource,
} from "@opensteer/integration-core/ports";
import {
  integrationDefinitionDigest,
  integrationSchemaDigest,
  localMcpLaunchDigest,
} from "@opensteer/integration-core/digest";
import { boundedToolDescription, boundedToolTitle } from "@opensteer/integration-core/tool-schemas";
import {
  createGraphqlAdapter,
  createMcpAdapter,
  createOpenApiAdapter,
  introspectGraphql,
  McpAdapterConfigSchema,
  legacyOpenApiToolTargets,
  parseOpenApiDocument,
  OpenApiAdapterConfigSchema,
  openApiCredentialDisclosure,
  probeMcpEndpointShape,
  validateJsonSchema,
  validateProposedOpenApiCheck,
} from "@opensteer/integration-adapters";
import { integrationDefinitions } from "@opensteer/integration-catalog";
import {
  type CallableIntegrationTool,
  type CreateIntegrationGrantInput,
  type DiscoveredIntegrationServer,
  type InstallIntegrationInput,
  type IntegrationPlatformStore,
  type IntegrationRequester,
  type IntegrationDiscoveryRequester,
  type PreparedIntegrationInstallFulfillment,
} from "@opensteer/database";
import {
  OpensteerError,
  RequestResponseSchema,
  UserIdSchema,
  WorkspaceIdSchema,
  type AgentEvent,
  type Request,
  type RequestId,
  type RequestResponse,
  type RunId,
  type RunnerId,
  type ThreadId,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError, type Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  HostIntegrationsInvokeSchema,
  androidPhoneDefinitionId,
  computerUseHeadline,
  computerUseActHeadline,
  computerUseToolRequiredSentence,
  computerUseUpdateMacSentence,
} from "@opensteer/protocol";
import {
  McpOAuthReauthorizationError,
  type McpOAuthService,
  type RedactingOAuthClientProvider,
} from "./mcp-oauth-service.js";
import { ComputerMcpSessionError, type ComputerAppHub } from "../computer-apps/computer-app-hub.js";
import { ComputerMcpTransport } from "./computer-mcp-transport.js";
import {
  ComputerUseError,
  computerUseDefinitionId,
  type ComputerUseDispatchResult,
  type ComputerUseLease,
  type ComputerUseScope,
  type ComputerUseService,
} from "../computer-use/computer-use-service.js";
import {
  ComputerAppApprovalService,
  computerUseHoldingOf,
  endComputerUseSessions,
  type ComputerUseApprovalGateway,
} from "./computer-app-approval-service.js";
import { computerObservationContent } from "./computer-use-tool-result.js";
import {
  iphoneAppsUnavailableDetail,
  computerAppSentence,
  computerAppAvailabilityDetail,
  phoneAvailabilityDetail,
  computerAppTransportUnavailableDetail,
} from "./computer-app-availability.js";

const connectionTimeoutMs = 15_000;
const toolCallTimeoutMs = 60_000;
const maximumToolsPerServer = 2_000;
const maximumToolPages = 100;
const maximumToolResultBytes = 2 * 1_024 * 1_024;

/** The Run one tool call belongs to, for the operations that need one. */
export interface RunToolContext {
  readonly runId: RunId;
  readonly threadId: ThreadId;
}

/**
 * Who one tool call is for: the Thread asking, whose lineage decides whether
 * it reaches its owner's Main, and its Run when there is one. A Trigger
 * occurrence produces no Run, and the one thing that requires a Run says so
 * itself rather than every other transport carrying a context it never reads.
 */
export interface ToolCaller {
  readonly run: RunCapabilityClaims<string> | null;
  readonly threadId: ThreadId;
}

/**
 * Which engine one call's Thread runs on, asked as the person running it: the
 * Thread is theirs, and this Host reads no Thread on nobody's behalf.
 */
export interface EngineCapabilityQuery extends RunToolContext {
  readonly ownerUserId: UserId;
}

/** What `callTool`, the rpc surface and `integration_request` need of sessions. */
export type ComputerUseGateway = ComputerUseApprovalGateway &
  Pick<
    ComputerUseService,
    "prepare" | "release" | "releaseSession" | "sendAct" | "sendObserve" | "sendWindowOperation"
  >;

/** An MCP client the Host holds, or is opening, for one of an installation's servers. */
interface OpenClient {
  /** Aborted when the client is let go: an open under way ends where it is. */
  readonly cancel: AbortController;
  readonly client: Promise<UpstreamClient>;
  readonly installationId: IntegrationInstallationId;
}

interface UpstreamClient {
  readonly client: Client;
  /** For a server a computer runs, its session's transport, which says why it ended. */
  readonly computer: ComputerMcpTransport | null;
  readonly fingerprint: string;
  /** Lets this client go, and not whichever client later holds its place. */
  readonly letGo: () => void;
  readonly responseRedactor: (() => CredentialResponseRedactor) | null;
  readonly credentialRevision?: () => number | null;
}

export class IntegrationAuthorizationRequiredError extends Error {
  readonly callable: CallableIntegrationTool;

  constructor(callable: CallableIntegrationTool) {
    // The title can come from a document an agent researched, and this message
    // is read by an agent, so it is quoted rather than spliced into prose.
    super(`"${callable.installation.title}" account authorization is required.`);
    this.name = "IntegrationAuthorizationRequiredError";
    this.callable = callable;
  }
}

interface DiscoveredServerResult extends DiscoveredIntegrationServer {
  readonly authorizationRequired: boolean;
}

/** The auth posture a proposal will actually run with. Proposals never carry provider identity. */
export type IntegrationProposalSelectedAuth = "api-key" | "mcp-oauth" | "none";

export interface IntegrationProposalRefusal {
  readonly catalogAlternatives: readonly string[];
  readonly detectedAuth: "oauth" | "unrecognized";
  readonly reason: string;
  readonly status: "unsupported";
}

export type IntegrationProposalOutcome =
  | IntegrationProposalRefusal
  | {
      readonly authNote?: string;
      readonly manifest: IntegrationProposalManifest;
      readonly selectedAuth: IntegrationProposalSelectedAuth;
      readonly status: "supported";
    };

interface SupportedProposalInspection {
  /** Set when the document also declared OAuth that this proposal deliberately ignores. */
  readonly authNote?: string;
  readonly catalog: AdapterToolCatalog;
  readonly definition: IntegrationDefinition;
  readonly kind: "supported";
  readonly manifest: IntegrationProposalManifest;
  readonly score: number;
  readonly selectedAuth: IntegrationProposalSelectedAuth;
}

type ProposalInspection =
  | SupportedProposalInspection
  | {
      readonly kind: "unsupported";
      readonly refusal: IntegrationProposalRefusal;
      readonly score: number;
    };

type PreparedIntegrationMaterial = Omit<InstallIntegrationInput, "actorUserId" | "requestId">;

export interface IntegrationUninstallOutcome {
  readonly cancelledRequests: number;
  readonly removedConnections: number;
}

export class IntegrationPlatformService {
  readonly #listConnections: (
    ownerUserId: UserId,
  ) => Promise<readonly IntegrationConnectionSummary[]>;
  /**
   * Every MCP client the Host holds or is opening: by server and connection
   * for calls, and by server alone while a computer's server is listed.
   */
  readonly #clients = new Map<string, OpenClient>();
  /**
   * The servers a computer runs whose tools are being listed, one listing per
   * server at a time, each listed once more when asked again meanwhile.
   */
  readonly #discoveries = new Map<IntegrationServerId, { again: boolean }>();
  #closed = false;
  readonly #adapters: ReadonlyMap<IntegrationAdapterKind, IntegrationAdapter>;
  readonly #authorizationSource: IntegrationProviderAuthorizationSource;
  readonly #credentialMaterializer: IntegrationAdapterCredentialMaterializer;
  readonly #computerApps: Pick<
    ComputerAppHub,
    "appStatus" | "attached" | "openMcpSession" | "send" | "withRunnerAdmission"
  >;
  readonly #dataDirectory: string;
  readonly #definitions: readonly IntegrationDefinition[];
  readonly #publicFetch: typeof fetch;
  readonly #store: IntegrationPlatformStore;
  readonly #mcpOauth: Pick<McpOAuthService, "providerFor">;
  readonly #onWorkspaceEvent: (event: AgentEvent) => void;
  readonly #onConnectionsChanged: () => void;
  readonly #onRequestsChanged: () => void;
  readonly #deploymentName: string | null;
  readonly #isRunnerConnected: (runnerId: RunnerId) => boolean;
  readonly #computerUse: ComputerUseGateway | null;
  readonly computerRepl: ComputerReplService;
  readonly #computerToolEnabled: (
    context: RunCapabilityClaims<string>,
  ) => boolean | Promise<boolean>;
  readonly #computerUseVersion: (runnerId: RunnerId) => number | undefined;
  readonly #mcpImageContent: (context: EngineCapabilityQuery) => Promise<boolean>;
  /** Who may use which app on which Mac; this service only dispatches the calls. */
  readonly computerAppApprovals: ComputerAppApprovalService;

  constructor(options: {
    readonly listConnections: (
      ownerUserId: UserId,
    ) => Promise<readonly IntegrationConnectionSummary[]>;
    readonly adapters?: readonly IntegrationAdapter[];
    readonly authorizationSource: IntegrationProviderAuthorizationSource;
    readonly dataDirectory: string;
    readonly credentialMaterializer: IntegrationAdapterCredentialMaterializer;
    readonly computerApps: Pick<
      ComputerAppHub,
      | "appStatus"
      | "reportsApp"
      | "approvalRelayRefusal"
      | "attached"
      | "machinesFor"
      | "openMcpSession"
      | "proveComputerAppApprovalKey"
      | "relaysComputerAppApprovals"
      | "send"
      | "sendComputerAppApprovalOutcome"
      | "sendComputerAppApprovals"
      | "withRunnerAdmission"
    >;
    /**
     * Sessions for the one definition whose connections name an app's whole
     * interface. Absent leaves every `gui` tool row uncallable, which is what
     * a Host built without it should answer rather than pretending.
     */
    readonly computerUse?: ComputerUseGateway | null;
    readonly deploymentName?: string | null;
    /**
     * Whether this Run's engine renders MCP image content blocks. An engine
     * that does not gets the tree and a sentence saying the picture is not
     * available here, rather than a block it would drop or choke on.
     */
    readonly computerToolEnabled?: (
      context: RunCapabilityClaims<string>,
    ) => boolean | Promise<boolean>;
    readonly computerUseVersion?: (runnerId: RunnerId) => number | undefined;
    readonly computerReplTime?: Pick<
      ConstructorParameters<typeof ComputerReplService>[0],
      "clock" | "wait"
    >;
    readonly mcpImageContent?: (context: EngineCapabilityQuery) => Promise<boolean>;
    readonly definitions?: readonly IntegrationDefinition[];
    readonly mcpOauth: Pick<McpOAuthService, "providerFor">;
    readonly onWorkspaceEvent: (event: AgentEvent) => void;
    readonly onConnectionsChanged: () => void;
    readonly onRequestsChanged: () => void;
    readonly isRunnerConnected: (runnerId: RunnerId) => boolean;
    /**
     * How the Host reaches providers, proposal sources and remote MCP servers:
     * public HTTPS only, unless a test points it at an upstream of its own.
     */
    readonly publicFetch?: typeof fetch;
    readonly store: IntegrationPlatformStore;
  }) {
    this.#publicFetch = options.publicFetch ?? createPublicHttpsFetch();
    this.#authorizationSource = options.authorizationSource;
    this.#listConnections = options.listConnections;
    this.#computerApps = options.computerApps;
    this.#dataDirectory = options.dataDirectory;
    const secureFetch: typeof fetch = (target, init) =>
      this.#publicFetch(target, { ...init, redirect: "manual" });
    const adapters = options.adapters ?? [
      createGraphqlAdapter(secureFetch),
      createMcpAdapter(secureFetch),
      createOpenApiAdapter(secureFetch),
    ];
    this.#adapters = new Map(adapters.map((adapter) => [adapter.kind, adapter]));
    this.#credentialMaterializer = options.credentialMaterializer;
    this.#deploymentName = options.deploymentName ?? null;
    this.#definitions = options.definitions ?? integrationDefinitions;
    this.#mcpOauth = options.mcpOauth;
    this.#onWorkspaceEvent = options.onWorkspaceEvent;
    this.#onConnectionsChanged = options.onConnectionsChanged;
    this.#onRequestsChanged = options.onRequestsChanged;
    this.#isRunnerConnected = options.isRunnerConnected;
    this.#computerUse = options.computerUse ?? null;
    // Silence is not a declaration: an engine that has not said it renders MCP
    // image content is treated as one that does not, exactly as an older
    // Runner's unstated `steering` is treated as unsupported.
    this.#mcpImageContent = options.mcpImageContent ?? (async () => false);
    this.#store = options.store;
    this.#computerToolEnabled = options.computerToolEnabled ?? (() => false);
    this.#computerUseVersion = options.computerUseVersion ?? (() => undefined);
    this.computerRepl = new ComputerReplService({
      ...options.computerReplTime,
      invoke: async () => {
        throw new Error("Computer code requires an authenticated execution.");
      },
    });
    this.computerAppApprovals = new ComputerAppApprovalService({
      computerApps: options.computerApps,
      computerUse: this.#computerUse,
      definitions: this.#definitions,
      deploymentName: this.#deploymentName,
      installCatalogDefinition: (input) => this.installCatalogDefinition(input),
      listCallableTools: (scope) => this.listCallableTools(scope),
      listConnections: this.#listConnections,
      onConnectionsChanged: this.#onConnectionsChanged,
      onError: (error) => console.warn("Computer app approvals could not reach a Mac", error),
      onLocalServerApproved: (approved) => {
        void this.#discoverComputerServer(approved.serverId).catch((error: unknown) =>
          console.warn("An approved MCP server could not be started", error),
        );
      },
      publishRequestEvents: (events) => this.#publishRequestEvents(events),
      store: this.#store,
    });
  }

  definitionSummary(definition: IntegrationDefinition) {
    return integrationDefinitionSummary(
      definition,
      definition.adapter !== "computer" &&
        definition.authMethods.some(({ kind }) => kind === "api-key")
        ? this.#adapter(definition.adapter).credentialDisclosure(definition.config)
        : null,
    );
  }

  get store(): IntegrationPlatformStore {
    return this.#store;
  }

  async listDiscoveryInventory(input: IntegrationDiscoveryRequester) {
    const inventory = await this.#store.listDiscoveryInventory({
      ...input,
      providerAuthorizations: await this.#authorizationSource.providerAuthorizations(
        input.ownerUserId,
      ),
    });
    const computerApps = this.#computerApps;
    const connections = new Map<
      IntegrationConnectionId,
      ReturnType<IntegrationPlatformStore["getComputerConnectionForCall"]>
    >();
    const connectionFor = (connectionId: IntegrationConnectionId) => {
      const pending = connections.get(connectionId);
      if (pending) return pending;
      const loaded = this.#store.getComputerConnectionForCall({
        connectionId,
        ownerUserId: input.ownerUserId,
      });
      connections.set(connectionId, loaded);
      return loaded;
    };
    // What each computer that runs an MCP server is called, read once and
    // only when an entry has such a server.
    let computerNames: Promise<ReadonlyMap<RunnerId, string>> | undefined;
    const computerName = async (runnerId: RunnerId) => {
      computerNames ??= this.#store.localMcp
        .list()
        .then(
          (servers) =>
            new Map(
              servers.flatMap(({ runnerId: id, runnerName }) =>
                id && runnerName ? [[id, runnerName] as const] : [],
              ),
            ),
        );
      return (await computerNames).get(runnerId) ?? "its computer";
    };
    return Promise.all(
      inventory.map(async (entry) => {
        const computerServers = new Map(
          entry.servers.flatMap((server) =>
            server.transport.type === "computer"
              ? [[server.id, server.transport.definitionId] as const]
              : [],
          ),
        );
        const runnerServers = new Map(
          entry.servers.flatMap((server) =>
            server.transport.type === "runner" && server.transport.runnerId
              ? [[server.id, server.transport.runnerId] as const]
              : [],
          ),
        );
        if (computerServers.size === 0 && runnerServers.size === 0) return entry;
        const overlay = async (
          readiness: (typeof entry.readiness.servers)[number],
          operation?: string,
        ) => {
          // Availability must not erase an outstanding authorization requirement.
          if (readiness.code !== "READY") return readiness;
          const runnerId = runnerServers.get(readiness.serverId);
          if (runnerId) {
            // A server a computer runs is there exactly while that computer is.
            if (computerApps.attached(runnerId)) return readiness;
            return {
              ...readiness,
              code: "INTEGRATION_UNAVAILABLE" as const,
              detail: computerAppTransportUnavailableDetail(
                entry.installation.title,
                await computerName(runnerId),
                this.#isRunnerConnected(runnerId),
              ),
              provider: null,
              requiredAccess: null,
            };
          }
          const definitionId = computerServers.get(readiness.serverId);
          if (!definitionId || readiness.connectionId === null) return readiness;
          const connection = await connectionFor(readiness.connectionId);
          if (!connection) return readiness;
          const status = computerApps.appStatus(connection.runnerId, definitionId);
          const attached = computerApps.attached(connection.runnerId);
          const operationStatus =
            operation === undefined
              ? null
              : (status?.operations.find((candidate) => candidate.operation === operation) ?? null);
          const runnerConnected = this.#isRunnerConnected(connection.runnerId);
          const operationStatuses =
            operation === undefined ? (status?.operations ?? null) : operationStatus;
          const detail =
            definitionId === androidPhoneDefinitionId
              ? phoneAvailabilityDetail({
                  attached,
                  phone: connection.runnerName,
                  runnerConnected,
                  status: operationStatuses,
                })
              : connection.deviceProfile === "iphone" && (!runnerConnected || !attached)
                ? iphoneAppsUnavailableDetail(connection.runnerName)
                : computerAppAvailabilityDetail({
                    // A Computer use account is one app, which is what comes back.
                    app:
                      connection.connection.computer?.app?.displayName ?? entry.installation.title,
                    attached,
                    computer: connection.runnerName,
                    runnerConnected,
                    status: operationStatuses,
                  });
          return detail === null
            ? readiness
            : {
                ...readiness,
                code: "INTEGRATION_UNAVAILABLE" as const,
                detail,
                provider: null,
                requiredAccess: null,
              };
        };
        const tools = await Promise.all(
          entry.readiness.tools.map(async ({ readiness, toolId }) => ({
            readiness: await overlay(
              readiness,
              entry.tools.find((tool) => tool.id === toolId)?.name,
            ),
            toolId,
          })),
        );
        return {
          ...entry,
          accounts: await Promise.all(
            entry.accounts.map(async (account) => {
              if (![...computerServers.values()].includes(computerUseDefinitionId)) return account;
              const connection = await connectionFor(account.connectionId);
              const app = connection?.connection.computer?.app;
              return app && connection
                ? { ...account, account: `${app.displayName} on ${connection.runnerName}` }
                : account;
            }),
          ),
          readiness: {
            servers: await Promise.all(
              entry.readiness.servers.map(async (readiness) => {
                const serverTools = tools.filter(
                  (tool) =>
                    tool.readiness.serverId === readiness.serverId &&
                    tool.readiness.connectionId === readiness.connectionId,
                );
                if (serverTools.some((tool) => tool.readiness.code === "READY")) return readiness;
                // Every computer-app operation is reported separately. When no
                // exposed tool is ready, carry that tool's concrete blocker to
                // the server instead of folding in an unrelated ready operation.
                return serverTools[0]?.readiness ?? (await overlay(readiness));
              }),
            ),
            tools,
          },
        };
      }),
    );
  }

  async listCallableTools(input: IntegrationRequester) {
    return this.#store.listCallableTools({
      ...input,
      providerAuthorizations: await this.#authorizationSource.providerAuthorizations(
        input.ownerUserId,
      ),
    });
  }

  async listGrantedSkills(input: IntegrationRequester) {
    return this.#store.listGrantedSkills(input);
  }

  async mainAccess(input: IntegrationRequester) {
    return this.#store.mainAccess(input);
  }

  /**
   * The one reaction to a connection gaining authority, whichever surface
   * finished the flow: discover the tools a provider connection now exposes,
   * then settle every pending Main-target Request the connection satisfies.
   * Returns the Requests it fulfilled so the caller can resume their agents.
   */
  async connectionConnected(input: {
    readonly connectionId: import("@opensteer/integration-core").IntegrationConnectionId;
    readonly ownerUserId: UserId;
  }): Promise<readonly RequestId[]> {
    if ((await this.#store.getConnectionKind(input)) === "provider-account") {
      await this.reconcileProviderConnectionTools(input);
    }
    return this.fulfillSatisfiedMainAccessRequests(input);
  }

  async fulfillSatisfiedMainAccessRequests(input: {
    readonly connectionId: import("@opensteer/integration-core").IntegrationConnectionId;
    readonly ownerUserId: UserId;
  }): Promise<readonly RequestId[]> {
    const providerAuthorizations = await this.#authorizationSource.providerAuthorizations(
      input.ownerUserId,
    );
    const pending = await this.#store.requests.listPendingIntegrationAccessRequests(
      input.ownerUserId,
    );
    const fulfilled: RequestId[] = [];
    for (const detail of pending) {
      if (detail.requestedConnectionId && detail.requestedConnectionId !== input.connectionId)
        continue;
      if (!detail.installationId) continue;
      if (
        (await this.#store.mainAccess({
          ownerUserId: input.ownerUserId,
          threadId: detail.request.originatingThreadId,
          workspaceId: detail.request.targetWorkspaceId,
        })) !== "inherited"
      ) {
        continue;
      }
      const satisfied = await this.#store.isConnectionUsableForAccessRequest({
        connectionId: input.connectionId,
        installationId: detail.installationId,
        ownerUserId: input.ownerUserId,
        providerAuthorizations,
        requestedServerId: detail.requestedServerId,
      });
      if (!satisfied) continue;
      if (input.connectionId) {
        try {
          await this.#verifyConnectionForFulfillment(input.connectionId, input.ownerUserId, {
            access: detail.access,
            installationId: detail.installationId,
            requestedServerId: detail.requestedServerId,
          });
        } catch {
          continue;
        }
      }
      try {
        const resolved = await this.#store.requests.resolveIntegrationAccessRequest({
          providerAuthorizations,
          requestId: detail.request.id,
          resolvedBy: input.ownerUserId,
          response: {
            kind: "external",
            value: { connectionId: input.connectionId, decision: "fulfilled" },
          },
        });
        for (const event of resolved.events) this.#onWorkspaceEvent(event);
        fulfilled.push(resolved.request.id);
      } catch (error) {
        if (error instanceof OpensteerError && error.code === "conflict") continue;
        throw error;
      }
    }
    return fulfilled;
  }

  async createGrant(input: Omit<CreateIntegrationGrantInput, "providerAuthorizations">) {
    const providerAuthorizations = await this.#authorizationSource.providerAuthorizations(
      input.ownerUserId,
    );
    const create = () => this.#store.createGrant({ ...input, providerAuthorizations });
    if (!input.connectionId) return create();
    const computer = await this.#store.getComputerConnectionForCall({
      connectionId: input.connectionId,
      ownerUserId: input.ownerUserId,
    });
    return computer ? this.#computerApps.withRunnerAdmission(computer.runnerId, create) : create();
  }

  async revokeGrant(input: {
    readonly grantId: IntegrationGrant["id"];
    readonly ownerUserId: UserId;
    readonly requestId: string;
    readonly workspaceId: WorkspaceId;
  }): Promise<void> {
    const grant = (await this.#store.listGrants(input)).find(({ id }) => id === input.grantId);
    const computer = grant?.connectionId
      ? await this.#store.getComputerConnectionForCall({
          connectionId: grant.connectionId,
          ownerUserId: input.ownerUserId,
        })
      : null;
    const revoke = async () => {
      await this.#store.revokeGrant(input);
      // The Workspace's session on that app, or on that phone, ran on this
      // grant, so it ends with it rather than at its next call.
      const holding = computer
        ? computerUseHoldingOf(this.#definitions, {
            appKey: computer.connection.computer?.app
              ? computerAppIdentityKey(computer.connection.computer.app)
              : null,
            definitionId: computer.connection.definitionId,
          })
        : null;
      if (computer && holding) {
        for (const [key, targets] of this.#replTargets)
          if (grant?.connectionId && targets.has(grant.connectionId)) {
            const caller = this.#replCallers.get(key);
            if (caller?.run)
              this.resetComputerGeneration(caller.run.runId, caller.run.bindingGeneration);
          }
        this.#computerUse?.closeForConnection(computer.runnerId, holding, input.workspaceId);
      }
    };
    await (computer ? this.#computerApps.withRunnerAdmission(computer.runnerId, revoke) : revoke());
  }

  async resolveRequest(input: {
    readonly requestId: RequestId;
    readonly resolvedBy: UserId;
    readonly response: RequestResponse;
  }): Promise<{
    readonly grant: import("@opensteer/integration-core").IntegrationGrant | null;
    readonly installation: IntegrationInstallation | null;
    readonly request: Request;
  }> {
    const pending = await this.#store.requests.get(input.requestId);
    if (!pending || pending.status !== "pending" || !pending.kind.startsWith("integration.")) {
      throw new OpensteerError({
        code: "conflict",
        message: "Integration Request is no longer pending",
      });
    }
    const response = RequestResponseSchema.parse(input.response);
    if (pending.kind === "integration.access") {
      if (response.kind === "choice" && response.optionId.startsWith("server:")) {
        const selected = await this.#store.requests.selectIntegrationAccessServer({
          requestId: input.requestId,
          resolvedBy: input.resolvedBy,
          requestedServerId: IntegrationServerIdSchema.parse(
            response.optionId.slice("server:".length),
          ),
        });
        for (const event of selected.events) this.#onWorkspaceEvent(event);
        return { grant: null, installation: null, request: selected.request };
      }
      if (response.kind === "choice" && response.optionId === "installed") {
        let installed =
          await this.#store.requests.tryBindExistingIntegrationAccessInstallation(input);
        if (!installed) {
          const manifest = await this.#store.requests.loadIntegrationAccessInstallManifest(input);
          const preparedFulfillment = await this.#prepareInstallationFromManifest(manifest);
          installed = await this.#store.requests.installForIntegrationAccessRequest({
            requestId: input.requestId,
            resolvedBy: input.resolvedBy,
            preparedFulfillment,
          });
        }
        this.#invalidateInstallation(installed.installation.id);
        for (const event of installed.requestEvents) this.#onWorkspaceEvent(event);
        return { grant: null, installation: installed.installation, request: installed.request };
      }
      if (pending.payload.kind !== "integration.access") {
        throw new Error("Integration access Request payload does not match its kind");
      }
      const request = pending.payload;
      const connectionId = fulfillmentConnectionId(response);
      const connectionKind = connectionId
        ? await this.#store.getConnectionKind({
            connectionId,
            ownerUserId: input.resolvedBy,
          })
        : null;
      if (connectionId && connectionKind === null) {
        throw new OpensteerError({
          code: "forbidden",
          message: "Integration connection is unavailable",
        });
      }
      const resolve = async () => {
        if (connectionId) {
          await this.#verifyConnectionForFulfillment(connectionId, input.resolvedBy, {
            access: request.access,
            installationId: IntegrationInstallationIdSchema.parse(request.installationId),
            requestedServerId:
              request.requestedServerId === null
                ? null
                : IntegrationServerIdSchema.parse(request.requestedServerId),
          });
        }
        return this.#store.requests.resolveIntegrationAccessRequest({
          providerAuthorizations: await this.#authorizationSource.providerAuthorizations(
            input.resolvedBy,
          ),
          requestId: input.requestId,
          resolvedBy: input.resolvedBy,
          response,
        });
      };
      const computer =
        connectionId && connectionKind === "computer"
          ? await this.#store.getComputerConnectionForCall({
              connectionId,
              ownerUserId: input.resolvedBy,
            })
          : null;
      const resolved = computer
        ? await this.#computerApps.withRunnerAdmission(computer.runnerId, resolve)
        : await resolve();
      for (const event of resolved.events) this.#onWorkspaceEvent(event);
      return { grant: resolved.grant, installation: null, request: resolved.request };
    }
    if (response.kind !== "choice" || !["installed", "declined"].includes(response.optionId)) {
      throw new OpensteerError({
        code: "bad_request",
        message: "Installation decision is invalid",
      });
    }
    const preparedFulfillment =
      response.optionId === "installed"
        ? await this.#prepareInstallationFromManifest(
            await this.#store.requests.loadIntegrationInstallManifest({
              requestId: input.requestId,
              resolvedBy: input.resolvedBy,
            }),
          )
        : undefined;
    const resolved = await this.#store.requests.resolveIntegrationInstallRequest({
      ...(preparedFulfillment ? { preparedFulfillment } : {}),
      requestId: input.requestId,
      resolvedBy: input.resolvedBy,
      response,
    });
    if (resolved.installation) this.#invalidateInstallation(resolved.installation.id);
    this.#publishRequestEvents(resolved.requestEvents);
    for (const event of resolved.events) this.#onWorkspaceEvent(event);
    return { grant: null, installation: resolved.installation, request: resolved.request };
  }

  /**
   * Fulfilling an access Request tells the agent the account is connected, so the account has to
   * prove it: materializing refreshes an expired grant, and a dead one is classified and marked.
   * MCP OAuth connections prove themselves on their own transport when the agent connects.
   */
  async #verifyConnectionForFulfillment(
    connectionId: IntegrationConnectionId,
    ownerUserId: UserId,
    request: {
      readonly access: IntegrationAccess;
      readonly installationId: IntegrationInstallationId;
      readonly requestedServerId: IntegrationServer["id"] | null;
    },
  ): Promise<void> {
    const kind = await this.#store.getConnectionKind({ connectionId, ownerUserId });
    if (kind === null) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Integration connection is unavailable",
      });
    }
    if (kind === "computer") {
      const connection = await this.#store.getComputerConnectionForCall({
        connectionId,
        ownerUserId,
      });
      if (!connection) {
        throw new OpensteerError({ code: "forbidden", message: "Computer app is unavailable" });
      }
      const servers = await this.#store.listServers(request.installationId);
      const matches = servers.some(
        (server) =>
          (request.requestedServerId === null || server.id === request.requestedServerId) &&
          server.connectionRequirement.kind === "computer" &&
          server.connectionRequirement.definitionId === connection.connection.definitionId,
      );
      if (!matches) {
        throw new OpensteerError({
          code: "forbidden",
          message: "Computer app does not belong to this integration",
        });
      }
      if (request.access === "read-write" && connection.access === "read") {
        throw new OpensteerError({
          code: "forbidden",
          message: `${connection.runnerName} allows reading only. Allow sending there first.`,
        });
      }
      return;
    }
    if (kind !== "provider-account") return;
    await this.#credentialMaterializer.materializeForAdapter({
      connectionId,
      operation: "connection.verify",
      ownerUserId,
    });
  }

  async installAgentPlugin(input: {
    readonly actorUserId: UserId;
    readonly directory: string;
    readonly requestId: string;
    /**
     * The computer that runs the plugin's servers that start a program or
     * listen on loopback, which never run inside the Host. The Deployment's
     * Main computer when omitted.
     */
    readonly runnerId?: RunnerId;
  }): Promise<{
    readonly installation: IntegrationInstallation;
    readonly issues: readonly unknown[];
  }> {
    const plugin = await loadAgentPlugin({
      dataDirectory: `${this.#dataDirectory}/plugins/data`,
      directory: input.directory,
    });
    const runnerId = plugin.servers.some(runsOnComputer)
      ? await this.#pluginComputer(input.runnerId)
      : null;
    const installationId = createIntegrationId("installation");
    const skills = plugin.skills.map(({ description, digest, name }) => ({
      description,
      digest,
      id: createIntegrationId("skill"),
      name,
      status: "active" as const,
    }));
    const servers = await Promise.all(
      plugin.servers.map((server) =>
        runnerId !== null && runsOnComputer(server)
          ? computerServer(server, runnerId)
          : this.#discoverServer(server),
      ),
    );
    const mutation = await this.#store.install({
      actorUserId: input.actorUserId,
      adapterSnapshot: null,
      installation: {
        description: plugin.manifest.description ?? "",
        id: installationId,
        manifest: plugin.manifest,
        name: plugin.manifest.name,
        provenance: {
          snapshotDigest: basename(plugin.root),
          standard: "agent-plugins/1.0.0",
        },
        sourceKind: "agent-plugin",
        // A server waiting for its computer's approval is not broken.
        status:
          skills.length > 0 ||
          servers.some(
            ({ authorizationRequired, status, transport }) =>
              authorizationRequired || status === "active" || transport.type === "runner",
          )
            ? "active"
            : "needs-attention",
        title: plugin.manifest.name,
        trust: "administrator-approved",
        version: plugin.manifest.version ?? null,
      },
      requestId: input.requestId,
      servers,
      skills,
    });
    const installation = this.#acceptInstallMutation(mutation);
    if (runnerId !== null) {
      await this.requestLocalServerApprovals();
      // Installed again as it was, a server keeps its computer's approval and
      // is listed again now rather than when that computer next reconnects.
      this.#startApprovedServers((server) => server.installationId === installation.id);
    }
    return { installation, issues: plugin.issues };
  }

  /** The computer a plugin's own servers run on: the one named, or the Main one. */
  async #pluginComputer(runnerId: RunnerId | undefined): Promise<RunnerId> {
    const chosen = runnerId ?? (await this.#store.localMcp.mainComputer());
    if (!chosen) {
      throw new OpensteerError({
        code: "bad_request",
        message:
          "This plugin runs its servers on a computer. Choose the computer that runs them: this Deployment has no Main computer.",
      });
    }
    if ((await this.#store.localMcp.computerName(chosen)) === null) {
      throw new OpensteerError({
        code: "not_found",
        message: "That computer is not part of this Deployment.",
      });
    }
    if ((await this.#store.computerAppRunner(chosen))?.deviceProfile === "iphone")
      throw new OpensteerError({
        code: "forbidden",
        message: "Local servers can't run on an iPhone.",
      });
    this.computerAppApprovals.requireApprovalRelay(chosen);
    return chosen;
  }

  /**
   * Asks each computer about the servers pinned to it that it has not
   * approved as they now launch, and sends each one its approvals again.
   */
  async requestLocalServerApprovals(): Promise<void> {
    for (const runnerId of await this.#store.localMcp.requestApprovals()) {
      this.computerAppApprovals.pushComputerAppApprovals(runnerId);
    }
  }

  /**
   * A computer's stream attached. Servers it approved and has not started
   * yet — approved while it was offline, or whose start failed — start now.
   */
  computerRunnerAttached(runnerId: RunnerId): void {
    this.#startApprovedServers((server) => server.runnerId === runnerId);
  }

  /** Lists every approved server `which` names that is not listed yet. */
  #startApprovedServers(
    which: (
      server: Awaited<ReturnType<IntegrationPlatformStore["localMcp"]["list"]>>[number],
    ) => boolean,
  ): void {
    void (async () => {
      for (const server of await this.#store.localMcp.list()) {
        if (
          which(server) &&
          server.status === "needs-attention" &&
          server.approvedLaunchDigest === server.launchDigest
        ) {
          await this.#discoverComputerServer(server.id);
        }
      }
    })().catch((error: unknown) =>
      console.warn("MCP servers could not start on a computer", error),
    );
  }

  /**
   * Starts a server its computer approved, once, to learn its tools. A
   * computer that is offline starts it when it is back. Asked again while it
   * runs, it lists once more after, from what is on record then.
   */
  async #discoverComputerServer(serverId: IntegrationServerId): Promise<void> {
    if (this.#closed) return;
    const running = this.#discoveries.get(serverId);
    if (running) {
      running.again = true;
      return;
    }
    const discovery = { again: true };
    this.#discoveries.set(serverId, discovery);
    try {
      while (discovery.again && !this.#closed) {
        discovery.again = false;
        await this.#discoverOnce(serverId);
      }
    } finally {
      this.#discoveries.delete(serverId);
    }
    this.#onConnectionsChanged();
  }

  async #discoverOnce(serverId: IntegrationServerId): Promise<void> {
    const server = await this.#store.localMcp.get(serverId);
    if (this.#closed) return;
    if (
      !server?.runnerId ||
      server.status === "disabled" ||
      server.approvedLaunchDigest !== server.launchDigest
    ) {
      return;
    }
    const { launchDigest, runnerId } = server;
    // Held with the calls' clients, so whatever lets the server go ends its
    // listing too.
    const key = `${serverId}:listing`;
    const listing = this.#open(key, server.installationId, async (signal) => ({
      client: await this.#connect(
        { id: serverId, transport: { launch: server.launch, runnerId, type: "runner" } },
        undefined,
        signal,
      ),
      computer: null,
      fingerprint: launchDigest,
      responseRedactor: null,
    }));
    const { signal } = listing.cancel;
    try {
      const tools = await listTools((await listing.client).client);
      if (signal.aborted) return;
      await this.#store.localMcp.recordTools({ launchDigest, serverId, tools });
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof ComputerMcpSessionError && error.code === "unapproved") {
        await this.#store.localMcp.forgetApproval({ launchDigest, serverId });
        await this.requestLocalServerApprovals();
      } else {
        await this.#store.localMcp.recordFailure({
          detail:
            error instanceof ComputerMcpSessionError && error.code === "offline"
              ? `${server.runnerName ?? "Its computer"} is offline; the server starts when it is back.`
              : safeMessage(error, safeMessageOptions),
          launchDigest,
          serverId,
        });
      }
    } finally {
      this.#letGo(key, listing);
    }
  }

  async installRemoteMcp(input: {
    readonly actorUserId: UserId;
    readonly description: string;
    readonly name: string;
    readonly requestId: string;
    readonly title: string;
    readonly url: string;
  }): Promise<IntegrationInstallation> {
    const transport = IntegrationServerTransportSchema.parse({
      headers: {},
      type: "streamable-http",
      url: input.url,
    });
    if (transport.type !== "streamable-http" || new URL(transport.url).protocol !== "https:") {
      throw new OpensteerError({
        code: "bad_request",
        message: "Remote MCP servers require HTTPS",
      });
    }
    if (isLoopbackHostname(new URL(transport.url).hostname)) {
      throw new OpensteerError({
        code: "bad_request",
        message:
          "A server on a computer's own loopback runs on that computer: install it in an Agent Plugin, choosing the computer that runs it.",
      });
    }
    const installationId = createIntegrationId("installation");
    const server = await this.#discoverServer({
      headers: {},
      name: "default",
      type: "streamable-http",
      url: transport.url,
    });
    const mutation = await this.#store.install({
      actorUserId: input.actorUserId,
      adapterSnapshot: null,
      installation: {
        description: input.description,
        id: installationId,
        manifest: {},
        name: input.name,
        provenance: { transport: "streamable-http", url: transport.url },
        sourceKind: "remote-mcp",
        status:
          server.status === "active" || server.authorizationRequired ? "active" : "needs-attention",
        title: input.title,
        trust: "administrator-approved",
        version: null,
      },
      requestId: input.requestId,
      servers: [server],
    });
    return this.#acceptInstallMutation(mutation);
  }

  /** Upgrade persisted disclosure once, before serving reads, without resolving remote documents. */
  async backfillApiKeyDisclosures(): Promise<void> {
    await this.#store.installations.backfillApiKeyDisclosures((snapshot) => {
      if (snapshot.adapter !== "openapi")
        return ApiKeyDisclosureSchema.parse(
          this.#adapter(snapshot.adapter).credentialDisclosure(snapshot.config),
        );
      const config = OpenApiAdapterConfigSchema.parse(snapshot.config);
      if (config.inline === undefined)
        throw new Error("Installed OpenAPI snapshot has no resolved document");
      const document =
        typeof config.inline === "string" ? parseOpenApiDocument(config.inline) : config.inline;
      return openApiCredentialDisclosure(document, config);
    });
  }

  /**
   * Bind each OpenAPI tool stored before tools recorded their operation, once,
   * before serving calls, from its own snapshot and without resolving remote documents.
   */
  async bindOpenApiTools(): Promise<void> {
    const failures = await this.#store.installations.bindOpenApiTools(async (snapshot) => {
      const config = OpenApiAdapterConfigSchema.parse(snapshot.config);
      if (config.inline === undefined)
        throw new Error("Installed OpenAPI snapshot has no resolved document");
      const document =
        typeof config.inline === "string" ? parseOpenApiDocument(config.inline) : config.inline;
      return {
        catalog: adapterCatalog(
          await this.#adapter("openapi").resolveTools({ config: snapshot.config }),
        ),
        legacyTargets: legacyOpenApiToolTargets(document, config),
      };
    });
    for (const { error, serverId } of failures) {
      console.warn("OpenAPI tools could not be bound to their operations", serverId, error);
    }
  }

  async ensureBuiltIns(input: {
    readonly actorUserId: UserId | null;
    readonly requestId: string;
  }): Promise<readonly IntegrationInstallation[]> {
    const installations: IntegrationInstallation[] = [];
    const definitionsById = new Map(
      this.#definitions.map((definition) => [definition.id, definition]),
    );
    const installed = (await this.#store.listInstallations()).filter(
      (installation) => installation.sourceKind === "built-in",
    );
    for (const current of installed) {
      const definitionId =
        typeof current.provenance.definitionId === "string"
          ? current.provenance.definitionId
          : current.name;
      const definition = definitionsById.get(definitionId);
      if (!definition) {
        installations.push(current);
        continue;
      }
      // A snapshot with unknown key destinations must be repaired by reinstalling,
      // never replaced from a live catalog document during startup.
      const summary = IntegrationDefinitionSummarySchema.safeParse(current.manifest.definition);
      if (
        current.status === "needs-attention" &&
        summary.success &&
        summary.data.authMethods.some(({ kind }) => kind === "api-key") &&
        summary.data.apiKey === null
      ) {
        installations.push(current);
        continue;
      }
      const digest = integrationDefinitionDigest(definition);
      if (
        current.status !== "needs-attention" &&
        current.provenance.definitionDigest === digest &&
        current.provenance.definitionId === definition.id
      ) {
        installations.push(current);
        continue;
      }
      try {
        installations.push(
          await this.#materializeCatalogDefinition({
            actorUserId: input.actorUserId,
            current,
            definition,
            requestId: `${input.requestId}:${definition.id}`,
          }),
        );
      } catch (error) {
        // One preset the Host cannot store again leaves it unavailable, not the Host.
        console.warn("A built-in integration could not be stored again", definition.id, error);
        await this.#store.installations.markNeedsAttention(
          current.id,
          "Opensteer couldn’t update this integration. Reinstall it from its page.",
        );
        installations.push(current);
      }
    }
    return installations;
  }

  async installCatalogDefinition(input: {
    readonly actorUserId: UserId;
    readonly definitionId: string;
    readonly digest: string;
    readonly requestId: string;
  }): Promise<IntegrationInstallation> {
    const definition = this.#definitions.find((candidate) => candidate.id === input.definitionId);
    if (!definition) {
      throw new OpensteerError({ code: "not_found", message: "Catalog integration was not found" });
    }
    const digest = integrationDefinitionDigest(definition);
    if (digest !== input.digest) {
      throw new OpensteerError({
        code: "conflict",
        message: "The catalog integration changed; review the current definition before installing",
      });
    }
    const current = (await this.#store.listInstallations()).find(
      (installation) =>
        installation.sourceKind === "built-in" &&
        installation.provenance.definitionId === definition.id,
    );
    if (
      current &&
      current.status !== "needs-attention" &&
      current.provenance.definitionDigest === digest
    ) {
      return current;
    }
    return this.#materializeCatalogDefinition({
      actorUserId: input.actorUserId,
      ...(current ? { current } : {}),
      definition,
      requestId: input.requestId,
    });
  }

  /**
   * Uninstalling is durable for built-ins too: ensureBuiltIns only reconciles
   * built-in rows that already exist, so boot never re-materializes an
   * installation an administrator removed. Reinstalling is the catalog install
   * command, which an administrator runs deliberately.
   */
  async uninstallIntegration(input: {
    readonly actorUserId: UserId;
    readonly installationId: IntegrationInstallationId;
    readonly requestId: string;
  }): Promise<IntegrationUninstallOutcome> {
    const runnerIds = await this.#store.listComputerRunnerIdsForInstallation(input.installationId);
    const mutation = await this.#withRunnerAdmissions(runnerIds, async () => {
      const removed = await this.#store.uninstall(input);
      endComputerUseSessions(this.#computerUse, this.#definitions, removed.removedApps);
      return removed;
    });
    this.#publishRequestEvents(mutation.requestEvents);
    for (const serverId of mutation.removedServerIds) this.#dropClient(serverId);
    if (mutation.removedConnectionIds.length > 0) this.#onConnectionsChanged();
    // An uninstall takes back every approval of its definition, on Macs that
    // have no connection of it as well.
    this.computerAppApprovals.approvalsChangedEverywhere();
    return {
      cancelledRequests: mutation.cancelledRequestIds.length,
      removedConnections: mutation.removedConnectionIds.length,
    };
  }

  async installFromManifest(input: {
    readonly actorUserId: UserId;
    readonly manifest: unknown;
    readonly requestId: string;
  }): Promise<IntegrationInstallation> {
    const manifest = IntegrationInstallManifestSchema.parse(input.manifest);
    return manifest.kind === "catalog"
      ? this.installCatalogDefinition({
          actorUserId: input.actorUserId,
          definitionId: manifest.definition.id,
          digest: manifest.digest,
          requestId: input.requestId,
        })
      : this.installProposal({
          actorUserId: input.actorUserId,
          manifest: manifest.proposal,
          requestId: input.requestId,
        });
  }

  async reconcileProviderConnectionTools(input: {
    readonly connectionId: import("@opensteer/integration-core").IntegrationConnectionId;
    readonly ownerUserId: UserId;
  }): Promise<void> {
    const materialized = await this.#credentialMaterializer.materializeForAdapter({
      connectionId: input.connectionId,
      operation: "schema.discovery",
      ownerUserId: input.ownerUserId,
    });
    const definition = this.#definitions.find(
      (candidate) => candidate.id === materialized.definitionId,
    );
    if (!definition || definition.adapter === "computer" || definition.adapter === "openapi") {
      return;
    }
    const installation = (await this.#store.listInstallations()).find(
      (candidate) =>
        candidate.status === "active" && candidate.provenance.definitionId === definition.id,
    );
    if (!installation) return;
    const server = (await this.#store.listServers(installation.id)).find(
      ({ transport }) => transport.type === "adapter" && transport.definitionId === definition.id,
    );
    if (!server) return;
    const method = definition.authMethods.find(
      (candidate) => candidate.id === materialized.authMethodId,
    );
    if (!method || (method.kind !== "api-key" && method.kind !== "oauth")) {
      throw new Error("Integration connection auth method does not match its definition");
    }
    const resolved = await this.#adapter(definition.adapter).resolveTools({
      config: definition.config,
      connectionId: input.connectionId,
      credentialValues: materialized.credentialValues,
      placements: method.placements,
    });
    if (resolved.tools.length > maximumToolsPerServer) {
      throw new Error(`Adapter exposes more than ${maximumToolsPerServer} tools`);
    }
    await this.#store.reconcileProviderConnectionTools({
      catalog: adapterCatalog(resolved, input.connectionId),
      connectionId: input.connectionId,
      definitionId: definition.id,
      ownerUserId: input.ownerUserId,
      serverId: server.id,
    });
  }

  async #materializeCatalogDefinition(input: {
    readonly actorUserId: UserId | null;
    readonly current?: IntegrationInstallation;
    readonly definition: IntegrationDefinition;
    readonly requestId: string;
  }): Promise<IntegrationInstallation> {
    const prepared = await this.#prepareCatalogDefinition(input);
    const mutation = await this.#store.install({
      ...prepared,
      actorUserId: input.actorUserId,
      requestId: input.requestId,
    });
    return this.#acceptInstallMutation(mutation);
  }

  async #prepareCatalogDefinition(input: {
    readonly current?: IntegrationInstallation;
    readonly definition: IntegrationDefinition;
  }): Promise<PreparedIntegrationMaterial> {
    const { definition } = input;
    const requirement = connectionRequirement(definition);
    let adapterSnapshot: IntegrationAdapterSnapshot | null = null;
    let catalog: IntegrationToolCatalog = emptyToolCatalog;
    let status: "active" | "needs-attention" = "active";
    let statusDetail: string | null = null;
    let summary = this.definitionSummary(definition);
    let transport: IntegrationServer["transport"] =
      definition.adapter === "computer"
        ? { definitionId: definition.id, type: "computer" }
        : {
            adapter: definition.adapter,
            definitionId: definition.id,
            type: "adapter",
          };
    try {
      if (isComputerAppDefinition(definition)) {
        // Computer tools belong to one connection and are materialized by the
        // store callback, never as server-level authority.
      } else if (definition.adapter === "mcp" && requirement.kind !== "provider") {
        const config = McpAdapterConfigSchema.parse(definition.config);
        if (config.transport !== "remote") {
          throw new Error("Catalog MCP integrations must use a remote transport");
        }
        transport = {
          headers: { ...config.headers },
          type: "streamable-http",
          url: config.endpoint,
        };
        if (requirement.kind === "none") {
          const discovered = await this.#discoverServer({
            headers: transport.headers,
            name: "default",
            type: "streamable-http",
            url: transport.url,
          });
          status = discovered.status === "disabled" ? "needs-attention" : discovered.status;
          statusDetail = discovered.statusDetail;
          catalog = discovered.catalog;
        }
      } else if (
        requirement.kind === "provider" &&
        (definition.adapter === "graphql" || definition.adapter === "mcp")
      ) {
        const adapter = this.#adapter(definition.adapter);
        const config = adapter.parseConfig(definition.config);
        adapterSnapshot = IntegrationAdapterSnapshotSchema.parse({
          adapter: definition.adapter,
          config,
          definitionId: definition.id,
        });
      } else {
        const prepared = await this.#prepareAdapterDefinition(definition);
        adapterSnapshot = prepared.snapshot;
        catalog = adapterCatalog(prepared.catalog);
      }
      summary = this.definitionSummary({
        ...definition,
        config: adapterSnapshot?.config ?? definition.config,
      });
    } catch (error) {
      status = "needs-attention";
      statusDetail = safeMessage(error, safeMessageOptions);
    }
    const digest = integrationDefinitionDigest(definition);
    return {
      adapterSnapshot,
      ...(isComputerAppDefinition(definition)
        ? {
            computerConnectionTools: (
              connectionId: IntegrationConnectionId,
              access: IntegrationAccess,
            ) => computerAppTools(definition, access, connectionId),
          }
        : {}),
      installation: {
        description: definition.description,
        id: input.current?.id ?? createIntegrationId("installation"),
        manifest: { definition: summary },
        name: definition.id,
        provenance: {
          definitionDigest: digest,
          definitionId: definition.id,
          maintainedBy: "opensteer",
        },
        sourceKind: "built-in",
        status,
        title: definition.name,
        trust: "built-in",
        version: digest,
      },
      servers: [
        {
          catalog,
          connectionRequirement: requirement,
          id: createIntegrationId("server"),
          name: "default",
          status,
          statusDetail,
          transport,
        },
      ],
    };
  }

  async propose(input: {
    readonly kind?: IntegrationProposalKind;
    readonly source: string;
    readonly credential?: IntegrationProposalManifest["credential"];
    readonly check?: IntegrationProposalManifest["check"];
    readonly name?: IntegrationProposalManifest["name"];
    readonly description?: IntegrationProposalManifest["description"];
  }): Promise<IntegrationProposalOutcome> {
    const inspected = await this.#inspectProposal(input);
    if (inspected.kind === "unsupported") return inspected.refusal;
    return {
      ...(inspected.authNote === undefined ? {} : { authNote: inspected.authNote }),
      manifest: inspected.manifest,
      selectedAuth: inspected.selectedAuth,
      status: "supported",
    };
  }

  async installProposal(input: {
    readonly actorUserId: UserId;
    readonly manifest: IntegrationProposalManifest;
    readonly requestId: string;
  }): Promise<IntegrationInstallation> {
    const prepared = await this.#prepareProposal(input.manifest);
    const mutation = await this.#store.install({
      ...prepared,
      actorUserId: input.actorUserId,
      requestId: input.requestId,
    });
    return this.#acceptInstallMutation(mutation);
  }

  #acceptInstallMutation(
    mutation: Awaited<ReturnType<IntegrationPlatformStore["install"]>>,
  ): IntegrationInstallation {
    this.#publishRequestEvents(mutation.requestEvents);
    this.#invalidateInstallation(mutation.installation.id);
    return mutation.installation;
  }

  async #prepareProposal(
    manifest: IntegrationProposalManifest,
  ): Promise<PreparedIntegrationMaterial> {
    const expected = IntegrationProposalManifestSchema.parse(manifest);
    const source = proposalSourceText(expected.source);
    const inspected = await this.#inspectProposal({
      kind: expected.kind,
      source,
      ...(expected.credential ? { credential: expected.credential } : {}),
      ...(expected.check ? { check: expected.check } : {}),
      ...(expected.name === undefined ? {} : { name: expected.name }),
      ...(expected.description === undefined ? {} : { description: expected.description }),
    });
    if (inspected.kind === "unsupported") {
      throw new OpensteerError({ code: "bad_request", message: inspected.refusal.reason });
    }
    if (inspected.manifest.digest !== expected.digest) {
      throw new OpensteerError({
        code: "conflict",
        message: "The proposed integration changed after inspection; submit a fresh proposal",
      });
    }
    if (
      JSON.stringify(inspected.manifest.authMethods) !== JSON.stringify(expected.authMethods) ||
      inspected.manifest.kind !== expected.kind
    ) {
      throw new OpensteerError({
        code: "conflict",
        message: "The proposed integration auth posture changed; submit a fresh proposal",
      });
    }
    const id = proposalSlug(expected.digest);
    const existing = (await this.#store.listInstallations()).find(({ name }) => name === id);
    const definition = inspected.definition;
    if (definition.adapter === "computer") {
      throw new OpensteerError({
        code: "bad_request",
        message: "Computer apps can only be installed from the Opensteer catalog",
      });
    }
    const isMcp = expected.kind === "mcp";
    let adapterSnapshot: IntegrationAdapterSnapshot | null = null;
    let inspectedCatalog = inspected.catalog;
    if (!isMcp) {
      try {
        const prepared = await this.#prepareAdapterDefinition(definition);
        adapterSnapshot = prepared.snapshot;
        inspectedCatalog = prepared.catalog;
      } catch (cause) {
        throw new OpensteerError({
          cause,
          code: "bad_request",
          message: "The proposed integration cannot be compiled into a bounded runtime snapshot",
        });
      }
    }
    const catalog = adapterCatalog(inspectedCatalog);
    const mcpUrl = expected.source.type === "url" ? expected.source.url : undefined;
    const publicProposal = integrationProposalSummary(inspected.manifest);
    return {
      adapterSnapshot,
      installation: {
        description: definition.description,
        id: existing?.id ?? createIntegrationId("installation"),
        manifest: {
          definition: this.definitionSummary({
            ...definition,
            config: adapterSnapshot?.config ?? definition.config,
          }),
          proposal: publicProposal,
        },
        name: id,
        provenance: {
          artifactDigest: expected.digest,
          proposalKind: expected.kind,
          source: publicProposal.source,
        },
        sourceKind: "proposed",
        status: "active",
        title: definition.name,
        trust: "administrator-approved",
        version: expected.digest,
      },
      servers: [
        {
          catalog,
          connectionRequirement: connectionRequirement(definition),
          id: createIntegrationId("server"),
          name: "default",
          status: "active",
          statusDetail: null,
          transport:
            isMcp && mcpUrl
              ? { headers: {}, type: "streamable-http", url: mcpUrl }
              : { adapter: definition.adapter, definitionId: definition.id, type: "adapter" },
        },
      ],
    };
  }

  async #prepareInstallationFromManifest(
    input: unknown,
  ): Promise<PreparedIntegrationInstallFulfillment> {
    const approvalManifest = IntegrationInstallManifestSchema.parse(input);
    const material =
      approvalManifest.kind === "proposal"
        ? await this.#prepareProposal(approvalManifest.proposal)
        : await this.#prepareCatalogInstallation(approvalManifest);
    return { approvalManifest, material };
  }

  async #prepareCatalogInstallation(
    manifest: Extract<IntegrationInstallManifest, { readonly kind: "catalog" }>,
  ): Promise<PreparedIntegrationMaterial> {
    const definition = this.#definitions.find(
      (candidate) => candidate.id === manifest.definition.id,
    );
    if (!definition) {
      throw new OpensteerError({ code: "not_found", message: "Catalog integration was not found" });
    }
    const digest = integrationDefinitionDigest(definition);
    if (digest !== manifest.digest) {
      throw new OpensteerError({
        code: "conflict",
        message: "The catalog integration changed; review the current definition before installing",
      });
    }
    const current = (await this.#store.listInstallations()).find(
      (installation) =>
        installation.sourceKind === "built-in" &&
        installation.provenance.definitionId === definition.id,
    );
    return this.#prepareCatalogDefinition({
      ...(current ? { current } : {}),
      definition,
    });
  }

  async #prepareAdapterDefinition(definition: IntegrationDefinition): Promise<{
    readonly catalog: AdapterToolCatalog;
    readonly snapshot: IntegrationAdapterSnapshot;
  }> {
    if (definition.adapter === "computer") {
      throw new Error("Computer apps do not create adapter snapshots");
    }
    const adapter = this.#adapter(definition.adapter);
    const config = await adapter.snapshotConfig(definition.config);
    const snapshot = IntegrationAdapterSnapshotSchema.parse({
      adapter: definition.adapter,
      config,
      definitionId: definition.id,
    });
    const catalog = await adapter.resolveTools({ config: snapshot.config });
    if (catalog.tools.length > maximumToolsPerServer) {
      throw new Error(`Adapter exposes more than ${maximumToolsPerServer} tools`);
    }
    return { catalog, snapshot };
  }

  async #inspectProposal(input: {
    readonly kind?: IntegrationProposalKind;
    readonly source: string;
    readonly credential?: IntegrationProposalManifest["credential"];
    readonly check?: IntegrationProposalManifest["check"];
    readonly name?: IntegrationProposalManifest["name"];
    readonly description?: IntegrationProposalManifest["description"];
  }): Promise<ProposalInspection> {
    const source = proposalSource(input.source);
    const options = {
      ...(input.credential
        ? { credential: IntegrationProposalCredentialSchema.parse(input.credential) }
        : {}),
      ...(input.check ? { check: IntegrationProposalCheckSchema.parse(input.check) } : {}),
      ...(input.name === undefined
        ? {}
        : { name: IntegrationProposalNameSchema.parse(input.name) }),
      ...(input.description === undefined
        ? {}
        : { description: IntegrationProposalDescriptionSchema.parse(input.description) }),
    };
    if (input.kind) return this.#inspectProposalKind(source, input.kind, options);
    const kinds = ["mcp", "openapi", "graphql"] as const;
    const attempts = await Promise.allSettled(
      kinds.map((kind) => this.#inspectProposalKind(source, kind, options)),
    );
    const matches = attempts.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    matches.sort((left, right) => right.score - left.score);
    const best = matches[0];
    if (!best) {
      const failures = attempts.flatMap((result, index) =>
        result.status === "rejected"
          ? [`${kinds[index]}: ${safeMessage(result.reason, proposalFailureOptions)}`]
          : [],
      );
      throw new OpensteerError({
        code: "bad_request",
        message: `${proposalSourceName(source)} is not a usable MCP, OpenAPI, or GraphQL integration (${failures.join("; ")})`,
      });
    }
    return best;
  }

  async #inspectProposalKind(
    source: IntegrationProposalSource,
    kind: IntegrationProposalKind,
    options: ProposalBindings,
  ): Promise<ProposalInspection> {
    if (kind !== "openapi" && (options.credential || options.check)) {
      throw new Error("credential and check require an API-key OpenAPI proposal");
    }
    if (kind === "openapi") {
      const text = await this.#proposalArtifactText(source);
      const document = parseOpenApiDocument(text);
      const preview = openApiPreview(document);
      const schemes = classifiedOpenApiSecuritySchemes(document);
      const authMethods = detectedOpenApiAuthMethods(schemes);
      const credential = schemes.find(({ classification }) => classification === "api-key");
      if ((options.credential || options.check) && !credential) {
        throw new Error("credential and check require an API-key OpenAPI proposal");
      }
      if (options.check && credential) {
        validateProposedOpenApiCheck(
          document,
          { inline: document, timeoutMs: 30_000 },
          options.check,
          credential.name,
        );
      }
      const config = OpenApiAdapterConfigSchema.parse({
        inline: document,
        ...(options.check ? { healthCheck: options.check } : {}),
      });
      const apiKey = credential ? openApiCredentialDisclosure(document, config) : undefined;
      const digest = proposalDigest(text, options);
      const unclassified = schemes.filter(
        ({ classification }) => classification === "unclassified",
      );
      if (unclassified.length > 0) {
        return {
          kind: "unsupported",
          refusal: {
            catalogAlternatives: this.#catalogAlternativesFor(document),
            detectedAuth: "unrecognized",
            reason: `This document declares the security scheme${unclassified.length === 1 ? "" : "s"} ${unclassified
              .map(({ name }) => `"${name}"`)
              .join(
                ", ",
              )}, which Opensteer cannot resolve or classify, and installing it as unauthenticated would produce an integration that can never authenticate a call, so it cannot be proposed.`,
            status: "unsupported",
          },
          score: 1,
        };
      }
      if (authMethods.includes("oauth") && !authMethods.includes("api-key")) {
        return {
          kind: "unsupported",
          refusal: {
            catalogAlternatives: this.#catalogAlternativesFor(document),
            detectedAuth: "oauth",
            reason:
              "This document's only security scheme is OAuth, and OAuth-only APIs need a catalog definition with provider identity configuration that a Deployment administrator authors, so it cannot be proposed.",
            status: "unsupported",
          },
          score: 1,
        };
      }
      const definition = IntegrationDefinitionSchema.parse({
        adapter: "openapi",
        authMethods: proposedAuthMethods(schemes, options.credential),
        config: {
          ...config,
          ...(apiKey?.destinations ? { credentialDestinations: apiKey.destinations } : {}),
        },
        description:
          options.description ?? `OpenAPI integration from ${proposalSourceLabel(source)}.`,
        id: proposalSlug(digest),
        name: integrationProposalName({ kind, name: options.name, preview, source }),
        ...(options.credential ? { setupUrl: options.credential.setupUrl } : {}),
        provider: proposalSlug(digest),
      });
      const catalog = await this.#adapter("openapi").resolveTools({ config: definition.config });
      return {
        ...(authMethods.includes("oauth")
          ? {
              authNote:
                "This document also declares OAuth, which proposals do not support; the proposal uses its API credential scheme instead.",
            }
          : {}),
        catalog,
        definition,
        kind: "supported",
        manifest: {
          authMethods,
          digest,
          kind,
          preview,
          source,
          ...options,
          ...(apiKey ? { apiKey } : {}),
        },
        score: 1,
        selectedAuth: authMethods.includes("api-key") ? "api-key" : "none",
      };
    }
    if (kind === "graphql") {
      if (source.type !== "url") {
        throw new Error(
          "GraphQL proposals require an HTTPS endpoint URL; an inline document cannot be introspected",
        );
      }
      const introspection = await introspectGraphql(source.url, {
        fetch: (target, init) => this.#publicFetch(target, { ...init, redirect: "manual" }),
      }).catch((cause: unknown) => {
        throw new Error(
          `GraphQL introspection of ${source.url} failed: ${safeMessage(cause, proposalFailureOptions)}`,
        );
      });
      const digest = proposalDigest(JSON.stringify(introspection), options);
      const preview = graphqlPreview(introspection);
      const definition = IntegrationDefinitionSchema.parse({
        adapter: "graphql",
        authMethods: [{ id: "none", kind: "none", label: "No authentication" }],
        config: { endpoint: source.url, introspection },
        description:
          options.description ?? `GraphQL integration from ${proposalSourceLabel(source)}.`,
        id: proposalSlug(digest),
        name: integrationProposalName({ kind, name: options.name, preview, source }),
        provider: proposalSlug(digest),
      });
      const catalog = await this.#adapter("graphql").resolveTools({ config: definition.config });
      return {
        catalog,
        definition,
        kind: "supported",
        manifest: { authMethods: ["none"], digest, kind, preview, source, ...options },
        score: 0.8,
        selectedAuth: "none",
      };
    }
    if (source.type !== "url") {
      throw new Error(
        "MCP proposals require an HTTPS endpoint URL; an inline document cannot be probed",
      );
    }
    const probed = await probeMcpEndpointShape(source.url, {
      fetch: (target, init) => this.#publicFetch(target, { ...init, redirect: "manual" }),
    }).catch((cause: unknown) => {
      throw new Error(
        `MCP probe of ${source.url} failed: ${safeMessage(cause, proposalFailureOptions)}`,
      );
    });
    if (probed.kind !== "mcp") {
      throw new Error(`MCP probe of ${source.url} failed: ${probed.reason}`);
    }
    const config = McpAdapterConfigSchema.parse({
      endpoint: source.url,
      transport: "remote",
    });
    const catalog: AdapterToolCatalog = probed.requiresAuth
      ? { definitions: {}, tools: [] }
      : await this.#adapter("mcp").resolveTools({ config });
    // The tools alone, as before catalogs: a listed MCP tool shares no
    // definitions, and a proposal pending approval must keep its digest.
    const snapshot = {
      requiresAuth: probed.requiresAuth,
      tools: catalog.tools,
      transport: probed.transport,
    };
    const digest = proposalDigest(JSON.stringify(snapshot), options);
    const preview = {
      authPosture: probed.requiresAuth ? "oauth-required" : "unauthenticated",
      toolNames: catalog.tools.map(({ name }) => name),
      transport: probed.transport,
    };
    const definition = IntegrationDefinitionSchema.parse({
      adapter: "mcp",
      authMethods: [
        probed.requiresAuth
          ? { id: "mcp-oauth", kind: "mcp-oauth", label: "MCP OAuth" }
          : { id: "none", kind: "none", label: "No authentication" },
      ],
      config,
      description: options.description ?? `MCP integration from ${proposalSourceLabel(source)}.`,
      id: proposalSlug(digest),
      name: integrationProposalName({ kind, name: options.name, preview, source }),
      provider: proposalSlug(digest),
    });
    return {
      catalog,
      definition,
      kind: "supported",
      manifest: {
        authMethods: [probed.requiresAuth ? "mcp-oauth" : "none"],
        digest,
        kind,
        preview,
        source,
        ...options,
      },
      score: 0.9,
      selectedAuth: probed.requiresAuth ? "mcp-oauth" : "none",
    };
  }

  /**
   * Domain matches are non-exhaustive hints after a refusal. The agent must search the complete
   * catalog to choose a supported definition even when these hints are empty.
   */
  #catalogAlternativesFor(document: Readonly<Record<string, unknown>>): readonly string[] {
    const labels = new Set(openApiServerUrls(document).flatMap(domainLabels));
    if (labels.size === 0) return [];
    return this.#definitions
      .filter(
        (definition) =>
          labels.has(definition.provider) ||
          (definition.setupUrl !== undefined &&
            domainLabels(definition.setupUrl).some((label) => labels.has(label))),
      )
      .map(({ id }) => id);
  }

  async #proposalArtifactText(source: IntegrationProposalSource): Promise<string> {
    if (source.type === "inline") return source.content;
    const response = await this.#publicFetch(source.url, {
      headers: { accept: "application/json, application/yaml, text/yaml, */*" },
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Proposal source returned HTTP ${response.status}`);
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > 8 * 1_024 * 1_024) {
      throw new Error("Proposal source exceeded 8 MiB");
    }
    return text;
  }

  async callTool(
    callable: CallableIntegrationTool,
    args: Readonly<Record<string, unknown>>,
    caller: ToolCaller,
    signal?: AbortSignal,
  ): Promise<Awaited<ReturnType<Client["callTool"]>>> {
    // A computer app's row is checked against the catalog this Host ships
    // before its arguments are, so a row that lags the catalog says it is
    // being updated rather than calling a valid call invalid.
    if (callable.server.transport.type === "computer") {
      return this.#callComputerTool(callable, args, caller, signal);
    }
    // Every other upstream validates its own arguments and its refusal reaches
    // the agent as it was written, so the Host holds no copy of a schema here.
    if (callable.server.transport.type === "adapter") {
      return (await this.#callAdapterTool(callable, args, signal)) as unknown as Awaited<
        ReturnType<Client["callTool"]>
      >;
    }
    if (callable.server.transport.type === "runner") {
      return this.#callComputerServerTool(callable, args, signal);
    }
    let upstream: UpstreamClient | undefined;
    try {
      upstream = await this.#client(callable);
      const result = await upstream.client.callTool(
        { arguments: { ...args }, name: callable.tool.name },
        undefined,
        {
          maxTotalTimeout: toolCallTimeoutMs,
          ...(signal ? { signal } : {}),
          timeout: toolCallTimeoutMs,
        },
      );
      return sanitizeToolResult(result, upstream.responseRedactor?.() ?? null);
    } catch (error) {
      if (upstream && answeredMcpError(error)) {
        // The server answered, refusing: its own words are what tells the
        // agent how to correct the call, since the Host holds no schema here.
        return sanitizeToolResult(
          {
            content: [
              {
                text: `${callable.installation.title} could not complete ${callable.tool.title}: ${error.message}`.slice(
                  0,
                  2_000,
                ),
                type: "text" as const,
              },
            ],
            isError: true,
          },
          upstream.responseRedactor?.() ?? null,
        );
      }
      // A client that failed to open is gone already; one a caller merely
      // gave up on still serves every other call sharing it.
      if (!signal?.aborted) upstream?.letGo();
      if (error instanceof UnauthorizedError && callable.grant.connectionId) {
        const revision =
          error instanceof McpOAuthReauthorizationError
            ? error.credentialRevision
            : upstream?.credentialRevision?.();
        if (revision === undefined || revision === null) throw error;
        const marked = await this.#store.markMcpOAuthConnectionNeedsAttention({
          connectionId: callable.grant.connectionId,
          expectedRevision: revision,
          ownerUserId: callable.grant.ownerUserId as UserId,
          statusDetail: "The MCP server requires renewed authorization",
        });
        if (!marked)
          throw new OpensteerError({
            code: "conflict",
            message: "MCP credentials changed; retry the request",
            retryable: true,
          });
        throw new IntegrationAuthorizationRequiredError(callable);
      }
      const unconfirmedWrite =
        upstream !== undefined && integrationToolEffect(callable.tool.annotations) === "write";
      throw new OpensteerError({
        cause: error,
        code: "harness_error",
        message: unconfirmedWrite
          ? unconfirmedIntegrationWriteMessage(callable)
          : `Integration ${callable.installation.title} could not complete ${callable.tool.title}`,
        retryable: !upstream || integrationToolEffect(callable.tool.annotations) !== "write",
      });
    }
  }

  /**
   * A tool of an MCP server one computer runs. What went wrong is said the
   * way a computer app says it — which computer, and whether a change may
   * already have happened — because a lost answer to a write is not a
   * failure a caller may simply retry.
   */
  async #callComputerServerTool(
    callable: CallableIntegrationTool,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<Awaited<ReturnType<Client["callTool"]>>> {
    const server = await this.#store.localMcp.get(callable.server.id);
    const refusal = (text: string) =>
      sanitizeToolResult({ content: [{ text, type: "text" as const }], isError: true }, null);
    let upstream: UpstreamClient;
    try {
      upstream = await this.#client(callable);
    } catch (error) {
      return refusal(await this.#computerServerRefusal(callable, server, error));
    }
    try {
      const result = await upstream.client.callTool(
        { arguments: { ...args }, name: callable.tool.name },
        undefined,
        {
          maxTotalTimeout: toolCallTimeoutMs,
          ...(signal ? { signal } : {}),
          timeout: toolCallTimeoutMs,
        },
      );
      return sanitizeToolResult(result, null);
    } catch (error) {
      if (answeredMcpError(error)) {
        // The server answered, with an error: nothing about it is uncertain.
        return refusal(
          `${callable.installation.title} could not complete ${callable.tool.title}: ${error.message}`.slice(
            0,
            2_000,
          ),
        );
      }
      if (!signal?.aborted) upstream.letGo();
      const computer = server?.runnerName ?? "Its computer";
      const closed = upstream.computer?.closeError ?? null;
      if (integrationToolEffect(callable.tool.annotations) === "write") {
        return refusal(
          `${computer} did not confirm this${
            closed?.code === "too-large" ? ": its answer was too large to carry" : ""
          }. Check whether it happened before trying again.`,
        );
      }
      return refusal(
        closed?.code === "too-large"
          ? `${callable.installation.title}'s answer was too large to carry from ${computer}; ask for less.`
          : `${computer} did not answer. Try again.`,
      );
    }
  }

  /** Why a computer did not start a server's session, as a caller reads it. */
  async #computerServerRefusal(
    callable: CallableIntegrationTool,
    server: Awaited<ReturnType<IntegrationPlatformStore["localMcp"]["get"]>>,
    error: unknown,
  ): Promise<string> {
    const title = callable.installation.title;
    if (!server || server.status === "disabled") {
      return `${title} was removed or changed; find its tools again.`;
    }
    if (!server.runnerId || !server.runnerName) {
      return `${title} has no computer to run on. Install its plugin again, choosing one.`;
    }
    if (!(error instanceof ComputerMcpSessionError)) {
      return `${title} did not start on ${server.runnerName}: ${safeMessage(error, safeMessageOptions)}`;
    }
    switch (error.code) {
      case "offline":
        return computerAppTransportUnavailableDetail(
          title,
          server.runnerName,
          this.#isRunnerConnected(server.runnerId),
        );
      case "unapproved":
        await this.#store.localMcp.forgetApproval({
          launchDigest: server.launchDigest,
          serverId: server.id,
        });
        await this.requestLocalServerApprovals();
        return `${title} needs approval on ${server.runnerName} again. Its owner has been asked there.`;
      case "failed":
      case "too-large":
        return `${title} did not start on ${server.runnerName}: ${error.message}`;
    }
  }

  computerToolEnabled(context: RunCapabilityClaims<string>): boolean | Promise<boolean> {
    return this.#computerToolEnabled(context);
  }

  computerUseVersion(runnerId: RunnerId): number | undefined {
    return this.#computerUseVersion(runnerId);
  }

  /** The same catalog pin and fresh admission fence for every computer row. */
  async #computerAuthority(callable: CallableIntegrationTool, caller: ToolCaller) {
    const transport = callable.server.transport;
    if (transport.type !== "computer")
      throw new Error("Computer-backed integration server is invalid");
    const connectionId = callable.grant.connectionId;
    if (!connectionId) throw new IntegrationAuthorizationRequiredError(callable);
    const found = this.#definitions.find(({ id }) => id === transport.definitionId);
    const definition =
      found &&
      isComputerAppDefinition(found) &&
      callable.installation.provenance.definitionId === found.id &&
      callable.installation.provenance.definitionDigest === integrationDefinitionDigest(found)
        ? found
        : undefined;
    const operation = definition?.config.operations.find(({ name }) => name === callable.tool.name);
    if (
      !definition ||
      !operation ||
      callable.tool.schemaDigest !==
        integrationSchemaDigest({
          inputSchema: operation.inputSchema,
          outputSchema: operation.outputSchema,
        })
    )
      throw new OpensteerError({
        code: "conflict",
        message: `${callable.installation.title} is being updated; search again`,
        retryable: true,
      });
    const ownerUserId = UserIdSchema.parse(callable.grant.ownerUserId);
    const workspaceId = WorkspaceIdSchema.parse(callable.grant.workspaceId);
    const [placement, providerAuthorizations] = await Promise.all([
      this.#store.getComputerConnectionForCall({ connectionId, ownerUserId }),
      this.#authorizationSource.providerAuthorizations(ownerUserId),
    ]);
    if (!placement) throw new IntegrationAuthorizationRequiredError(callable);
    const admit = <Result>(
      send: (
        connection: NonNullable<typeof placement>,
        access: IntegrationAccess,
      ) => Promise<Result>,
    ) =>
      this.#computerApps.withRunnerAdmission(placement.runnerId, async () => {
        const [connection, authority] = await Promise.all([
          this.#store.getComputerConnectionForCall({ connectionId, ownerUserId }),
          this.#store.listCallableTools({
            ownerUserId,
            providerAuthorizations,
            threadId: caller.threadId,
            workspaceId,
          }),
        ]);
        const current = authority.find(
          (candidate) =>
            candidate.grant.id === callable.grant.id &&
            candidate.tool.id === callable.tool.id &&
            candidate.tool.schemaDigest === callable.tool.schemaDigest &&
            candidate.installation.provenance.definitionDigest ===
              callable.installation.provenance.definitionDigest,
        );
        if (
          !connection ||
          !current ||
          connection.connection.status !== "connected" ||
          connection.runnerRevoked ||
          connection.runnerId !== placement.runnerId ||
          connection.connection.definitionId !== definition.id ||
          connection.connection.computer?.runnerId !== connection.runnerId ||
          !accessCoversEffect(connection.access, operation.effect) ||
          !accessCoversEffect(current.grant.access, operation.effect)
        )
          throw new IntegrationAuthorizationRequiredError(callable);
        if (
          definition.id === computerUseDefinitionId &&
          this.#computerUseVersion(connection.runnerId) !== 2
        )
          throw new ComputerUseError(
            "incompatible-version",
            computerUseUpdateMacSentence(connection.runnerName),
          );
        return send(
          connection,
          connection.access === "read" || current.grant.access === "read" ? "read" : "read-write",
        );
      });
    return { definition, operation, ownerUserId, workspaceId, placement, admit };
  }

  async #callComputerTool(
    callable: CallableIntegrationTool,
    args: Readonly<Record<string, unknown>>,
    caller: ToolCaller,
    signal?: AbortSignal,
  ): Promise<Awaited<ReturnType<Client["callTool"]>>> {
    const transport = callable.server.transport;
    if (
      transport.type === "computer" &&
      (transport.definitionId === computerUseDefinitionId ||
        transport.definitionId === androidPhoneDefinitionId)
    )
      return {
        content: [{ type: "text", text: computerUseToolRequiredSentence }],
        isError: true,
      };
    const { definition, operation, placement, admit } = await this.#computerAuthority(
      callable,
      caller,
    );
    const [issue] = validateJsonSchema(operation.inputSchema, args);
    if (issue)
      throw new OpensteerError({
        code: "bad_request",
        message: `Invalid ${operation.title} arguments at ${issue.path}: ${issue.message}`,
      });
    const sent = await admit(async (connection, access) =>
      this.#computerApps.send({
        access,
        arguments: HostIntegrationsInvokeSchema.shape.arguments.parse(args),
        contract: computerAppOperationContract(operation),
        definitionId: definition.id,
        effect: operation.effect,
        operation: operation.name,
        runnerId: connection.runnerId,
        ...(signal ? { signal } : {}),
      }),
    );
    const outcome = await sent.outcome;
    if (outcome.kind === "ok")
      return sanitizeToolResult(
        {
          content: [{ type: "text", text: JSON.stringify(outcome.value) }],
          ...(typeof outcome.value === "object" &&
          outcome.value !== null &&
          !Array.isArray(outcome.value)
            ? {
                structuredContent: HostIntegrationsInvokeSchema.shape.arguments.parse(
                  outcome.value,
                ),
              }
            : {}),
        },
        null,
      );
    let message: string;
    switch (outcome.code) {
      case "offline":
        message =
          placement.deviceProfile === "iphone"
            ? iphoneAppsUnavailableDetail(placement.runnerName)
            : computerAppTransportUnavailableDetail(
                callable.installation.title,
                placement.runnerName,
                this.#isRunnerConnected(placement.runnerId),
              );
        break;
      case "permission-required":
        message = computerAppSentence(outcome.message, placement.runnerName);
        break;
      case "invalid-arguments":
      case "failed":
        message = outcome.message;
        break;
      case "unsupported":
        message = `Update Opensteer on ${placement.runnerName} to use ${operation.title}.`;
        break;
      case "outcome-unknown":
        message = `${placement.runnerName} did not confirm this. Check whether it happened before trying again.`;
        break;
      case "lost":
        message = `${placement.runnerName} did not answer. Try again.`;
        break;
      case "busy":
        message = `${placement.runnerName} is busy with other requests. Try again in a moment.`;
        break;
    }
    return sanitizeToolResult({ content: [{ type: "text", text: message }], isError: true }, null);
  }

  /** Internal authority path. Window discovery/observation use read; input uses write. */
  async callComputerOperation(
    caller: ToolCaller,
    target: IntegrationConnectionId,
    operation: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    deadline?: number,
  ): Promise<ReplReply> {
    const run = caller.run;
    if (!run || !this.#computerUse) throw new Error("Computer use requires a running task.");
    const row =
      operation === "release"
        ? "release"
        : ["windows", "bind", "observe"].includes(operation)
          ? "observe"
          : "act";
    const callable = (
      await this.listCallableTools({
        ownerUserId: run.requestedBy,
        threadId: caller.threadId,
        workspaceId: run.workspaceId,
      })
    ).find(
      (candidate) =>
        candidate.grant.connectionId === target &&
        candidate.tool.name === row &&
        candidate.server.transport.type === "computer" &&
        (candidate.server.transport.definitionId === computerUseDefinitionId ||
          candidate.server.transport.definitionId === androidPhoneDefinitionId),
    );
    if (!callable) {
      const connection =
        row === "act"
          ? await this.#store.getComputerConnectionForCall({
              connectionId: target,
              ownerUserId: run.requestedBy,
            })
          : null;
      if (
        connection?.access === "read" &&
        connection.connection.definitionId === androidPhoneDefinitionId
      )
        throw new ComputerUseError(
          "failed",
          `${connection.runnerName} allows seeing only. Ask for read-write access to act: call integration_request {kind: "computer-app", runnerId, access, reason} with access "read-write"; do not retry this call until it is fulfilled.`,
        );
      throw new Error(
        row === "act"
          ? "This task does not have read-write access to this app or phone. Request read-write access before acting."
          : "This app or phone is no longer approved for this task. Search integrations for current access.",
      );
    }
    const {
      definition,
      operation: catalogOperation,
      ownerUserId,
      placement,
      admit,
    } = await this.#computerAuthority(callable, caller);
    const computerUse = this.#computerUse;
    const mac = definition.id === computerUseDefinitionId;
    if (!this.#computerApps.attached(placement.runnerId))
      throw new ComputerUseError(
        "offline",
        mac
          ? computerAppTransportUnavailableDetail(
              placement.connection.computer?.app?.displayName ?? callable.installation.title,
              placement.runnerName,
              this.#isRunnerConnected(placement.runnerId),
            )
          : phoneAvailabilityDetail({
              attached: false,
              phone: placement.runnerName,
              runnerConnected: this.#isRunnerConnected(placement.runnerId),
              status: null,
            })!,
      );
    const rawArgs = { ...args };
    delete rawArgs.emit;
    const internalArgs = row === "observe" && mac ? { operation, ...rawArgs } : rawArgs;
    if (row !== "act") {
      const [issue] = validateJsonSchema(catalogOperation.inputSchema, internalArgs);
      if (issue)
        throw new Error(`Invalid ${operation} arguments at ${issue.path}: ${issue.message}`);
    }
    let lease: ComputerUseLease | undefined;
    let started: Extract<AgentEvent, { type: "tool.started" }> | undefined;
    let result: ComputerUseDispatchResult | undefined;
    let released = false;
    let audit: Promise<readonly string[]> | undefined;
    let auditCompletion: Promise<void> | undefined;
    let finishOperation: ((error?: unknown) => void) | undefined;
    const start = async (connection: NonNullable<typeof placement>, scope: ComputerUseScope) => {
      if (started) return;
      const subject = {
        account: callable.grant.alias,
        computerApp:
          scope.kind === "app"
            ? {
                app: scope.app.displayName,
                bundleId: scope.app.bundleId,
                computer: connection.runnerName,
                runnerId: connection.runnerId,
              }
            : null,
        ...(scope.kind === "display"
          ? { phone: { computer: connection.runnerName, runnerId: connection.runnerId } }
          : {}),
        effect: catalogOperation.effect,
        integration: callable.installation.title,
        operation: { name: callable.tool.name, title: callable.tool.title },
      };
      started = await this.#store.computerOperations.start({
        context: run,
        operation,
        subject,
        ...(typeof args.window === "number" ? { window: args.window } : {}),
      });
      const callId = started.data.callId;
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const done = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      this.#computerOperationSettlements.set(callId, { runId: run.runId, done });
      void done.catch((error: unknown) =>
        console.warn("Computer operation audit could not be saved", { callId, error }),
      );
      finishOperation = (error?: unknown) => {
        this.#computerOperationSettlements.delete(callId);
        if (error === undefined) resolve();
        else reject(error);
      };
      this.#onWorkspaceEvent(started);
    };
    try {
      if (operation !== "release")
        lease = await computerUse.prepare(
          { ownerUserId, runnerId: placement.runnerId, runnerName: placement.runnerName },
          run,
        );
      const initial = await admit(async (connection, access) => {
        const scope = computerUseScope(definition, connection.connection.computer?.app ?? null);
        if (!scope) throw new IntegrationAuthorizationRequiredError(callable);
        return { scope, access };
      });
      const scope = initial.scope;
      const authorizedTarget = { ...scope, access: initial.access };
      const guarded = <Result>(send: () => Promise<Result>) =>
        admit(async (connection, access) => {
          authorizedTarget.access = access;
          if (
            canonicalJson(
              computerUseScope(definition, connection.connection.computer?.app ?? null),
            ) !== canonicalJson(scope)
          )
            throw new IntegrationAuthorizationRequiredError(callable);
          await start(connection, scope);
          return send();
        });
      if (operation === "release")
        released = await guarded(() => computerUse.releaseSession(run, placement.runnerId));
      else if (lease) {
        const dispatch =
          row === "act"
            ? await computerUse.sendAct(
                lease,
                authorizedTarget,
                rawArgs,
                !mac,
                signal,
                guarded,
                deadline,
              )
            : await guarded(() =>
                mac
                  ? computerUse.sendWindowOperation(
                      lease!,
                      authorizedTarget,
                      operation,
                      rawArgs,
                      signal,
                      deadline,
                    )
                  : computerUse.sendObserve(lease!, authorizedTarget, true, signal, deadline),
              );
        audit = dispatch.audit;
        result = await dispatch.settle();
      }
      const performed = result?.performed ?? [];
      const appName = scope.kind === "app" ? scope.app.displayName : placement.runnerName;
      const stoppedBecause = result?.error?.message ?? null;
      const headline =
        row === "observe"
          ? computerUseHeadline({ appName, performed: stoppedBecause ? [] : null, stoppedBecause })
          : computerUseActHeadline({
              performed: operation === "release" ? [`Released ${placement.runnerName}`] : performed,
              stoppedBecause,
            });
      if (started) {
        const event = await this.#store.computerOperations.complete(started, {
          status: signal?.aborted ? "cancelled" : result?.error ? "failed" : "succeeded",
          headline,
          performed,
        });
        if (event) this.#onWorkspaceEvent(event);
      }
      const content: ReplContent[] = performed.map((text) => ({ type: "text", text }));
      if (result?.observation && args.emit !== false) {
        const renderImages = await this.#mcpImageContent({
          ownerUserId,
          runId: run.runId,
          threadId: run.threadId,
        });
        content.push(
          ...computerObservationContent(result.observation, renderImages, placement.runnerName),
        );
      }
      if (result?.error)
        throw Object.assign(result.error, {
          performed,
          content,
          value: JSON.parse(JSON.stringify(result)),
        });
      const value =
        operation === "release"
          ? { released }
          : operation === "windows"
            ? result?.windows
            : operation === "bind"
              ? { window: result?.window }
              : mac && row === "act"
                ? { performed }
                : result;
      return { value: z.json().parse(JSON.parse(JSON.stringify(value))), content };
    } catch (caught) {
      const error =
        caught instanceof ComputerUseError && caught.code === "permission-required" && mac
          ? Object.assign(
              new ComputerUseError(
                caught.code,
                computerAppSentence(caught.message, placement.runnerName),
                caught.retryable,
              ),
              { performed: result?.performed ?? [] },
            )
          : caught instanceof ComputerUseError && caught.code === "incompatible-version" && mac
            ? Object.assign(
                new ComputerUseError(
                  caught.code,
                  computerUseUpdateMacSentence(placement.runnerName),
                  caught.retryable,
                ),
                { performed: result?.performed ?? [] },
              )
            : caught instanceof ComputerUseError && caught.code === "outcome-unknown"
              ? Object.assign(
                  new ComputerUseError(
                    caught.code,
                    `${caught.message} The actions may already have taken effect. Do not repeat them. Observe the ${mac ? "app" : "phone"} before deciding the next action.`,
                    caught.retryable,
                  ),
                  { performed: result?.performed ?? [] },
                )
              : caught;
      if (started) {
        const record = started;
        const known =
          error instanceof Error && "performed" in error && Array.isArray(error.performed)
            ? error.performed.filter((value): value is string => typeof value === "string")
            : [];
        // The MCP response ends now. Native receipts settle independently and
        // Run-end finalization waits for this bounded, fenced audit lifetime.
        auditCompletion = (async () => {
          const performed = (await audit) ?? known;
          const event = await this.#store.computerOperations.complete(record, {
            status: signal?.aborted ? "cancelled" : "failed",
            headline: computerUseActHeadline({
              performed,
              stoppedBecause: error instanceof Error ? error.message : "Computer operation failed",
            }),
            performed,
          });
          if (event) this.#onWorkspaceEvent(event);
        })();
      }
      throw error;
    } finally {
      if (lease) computerUse.release(lease);
      if (auditCompletion)
        void auditCompletion.then(
          () => finishOperation?.(),
          (error: unknown) => finishOperation?.(error),
        );
      else finishOperation?.();
    }
  }

  async #invokeComputerRepl(
    caller: ToolCaller,
    request: ComputerReplInvocation,
  ): Promise<ReplReply> {
    if (!caller?.run) throw new Error("This computer context has ended.");
    if (request.operation === "apps" || request.operation === "phones") {
      const rows = await this.listCallableTools({
        ownerUserId: caller.run.requestedBy,
        threadId: caller.threadId,
        workspaceId: caller.run.workspaceId,
      });
      const entries = await Promise.all(
        rows
          .filter(
            (row) =>
              row.tool.name === "observe" &&
              row.server.transport.type === "computer" &&
              row.server.transport.definitionId ===
                (request.operation === "apps" ? computerUseDefinitionId : androidPhoneDefinitionId),
          )
          .map(async (row) => {
            if (!row.grant.connectionId) return null;
            const connection = await this.#store.getComputerConnectionForCall({
              connectionId: row.grant.connectionId,
              ownerUserId: caller.run!.requestedBy,
            });
            if (
              !connection ||
              connection.runnerRevoked ||
              connection.connection.status !== "connected"
            )
              return null;
            const app = connection.connection.computer?.app;
            return {
              id: row.grant.connectionId,
              name: app?.displayName ?? connection.runnerName,
              ...(app ? { bundleId: app.bundleId } : {}),
              computer: connection.runnerName,
              access:
                row.grant.access === "read" || connection.access === "read" ? "read" : "read-write",
            };
          }),
      );
      const usable = entries.filter((entry) => entry !== null);
      const key = `${request.context.runId}:${request.context.generation}`;
      const targets = this.#replTargets.get(key) ?? new Set<string>();
      for (const entry of usable) targets.add(entry.id);
      this.#replTargets.set(key, targets);
      return { value: usable };
    }
    return this.callComputerOperation(
      caller,
      IntegrationConnectionIdSchema.parse(request.target),
      request.operation,
      request.args,
      request.signal,
      request.deadline,
    );
  }

  readonly #computerOperationSettlements = new Map<string, { runId: RunId; done: Promise<void> }>();
  readonly #replCallers = new Map<string, ToolCaller>();
  readonly #replTargets = new Map<string, Set<string>>();
  async runComputerCode(caller: ToolCaller, code: string, signal: AbortSignal) {
    const run = caller.run;
    if (!run || !(await this.computerToolEnabled(run)))
      throw new Error("Update this task's Runner to use the computer tool.");
    const key = `${run.runId}:${run.bindingGeneration}`;
    for (const [old, entry] of this.#replCallers)
      if (entry.run?.runId === run.runId && old !== key) this.#replCallers.delete(old);
    this.#replCallers.set(key, caller);
    return this.computerRepl.execute(
      { runId: run.runId, generation: run.bindingGeneration },
      code,
      signal,
      (request) => this.#invokeComputerRepl(caller, request),
    );
  }

  async endComputerRun(runId: RunId): Promise<void> {
    for (const [key, caller] of this.#replCallers)
      if (caller.run?.runId === runId) {
        this.#replCallers.delete(key);
        this.#replTargets.delete(key);
      }
    await this.computerRepl.endRun(runId);
    await Promise.all(
      [...this.#computerOperationSettlements.values()]
        .filter((record) => record.runId === runId)
        .map((record) => record.done),
    );
    for (const event of await this.#store.computerOperations.finalize(runId))
      this.#onWorkspaceEvent(event);
  }

  resetComputerGeneration(runId: RunId, generation: number): void {
    this.#replCallers.delete(`${runId}:${generation}`);
    this.#replTargets.delete(`${runId}:${generation}`);
    this.computerRepl.resetGeneration(runId, generation);
  }

  endComputerGeneration(runId: RunId, generation: number): void {
    this.#replCallers.delete(`${runId}:${generation}`);
    this.#replTargets.delete(`${runId}:${generation}`);
    this.computerRepl.endGeneration(runId, generation);
  }

  async #callAdapterTool(
    callable: CallableIntegrationTool,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<{
    readonly content: readonly { readonly text: string; readonly type: "text" }[];
    readonly isError?: boolean;
    readonly structuredContent?: Record<string, unknown>;
  }> {
    if (callable.server.transport.type !== "adapter") {
      throw new Error("Adapter-backed integration server is invalid");
    }
    // The snapshot is read apart from the authorization that admitted this
    // call, so it must be of the same generation: one rematerialized since
    // could run a different operation under the same name and schemas.
    const invocation = await this.#store.getToolInvocation(callable.tool.id);
    if (
      !invocation ||
      invocation.status !== "active" ||
      invocation.schemaDigest !== callable.tool.schemaDigest ||
      invocation.installationRevision !== callable.installation.revision ||
      invocation.toolGeneration !== callable.server.toolGeneration
    ) {
      throw new OpensteerError({
        code: "conflict",
        message: "Integration operation changed; search and describe it again",
      });
    }
    const snapshot = invocation.adapterSnapshot;
    if (!snapshot) throw new Error("Adapter snapshot is unavailable");
    const definition = IntegrationDefinitionSummarySchema.parse(
      callable.installation.manifest.definition,
    );
    if (
      snapshot.definitionId !== callable.server.transport.definitionId ||
      snapshot.adapter !== callable.server.transport.adapter ||
      definition.id !== snapshot.definitionId ||
      definition.adapter !== snapshot.adapter
    ) {
      throw new Error("Persisted integration definition does not match its adapter transport");
    }
    const adapter = this.#adapter(snapshot.adapter);
    const config = snapshot.config;
    let connectionMethod: string | undefined;
    let credentialGeneration = 0;
    let credentialValues: Readonly<Record<string, string>> = {};
    let grantedScopes: readonly string[] = [];
    let placements: readonly import("@opensteer/integration-core").AuthPlacement[] = [];
    if (callable.server.connectionRequirement.kind === "provider") {
      const connectionId = callable.grant.connectionId;
      if (!connectionId) {
        throw new OpensteerError({
          code: "conflict",
          message: `${callable.installation.title} requires a connected account`,
        });
      }
      let materialized;
      try {
        materialized = await this.#credentialMaterializer.materializeForAdapter({
          connectionId,
          operation: callable.tool.name,
          ownerUserId: callable.grant.ownerUserId as UserId,
        });
      } catch (error) {
        if (
          error instanceof OpensteerError &&
          (error.code === "conflict" || error.code === "not_found")
        ) {
          throw new IntegrationAuthorizationRequiredError(callable);
        }
        // A classified authorization failure already says something true and bounded; restating it
        // as "could not be prepared" would cost the agent the one detail it can act on.
        if (error instanceof OpensteerError) throw error;
        throw new OpensteerError({
          cause: error,
          code: "harness_error",
          message: `${callable.installation.title} account authorization could not be prepared`,
          retryable: true,
        });
      }
      if (materialized.provider !== callable.server.connectionRequirement.provider) {
        throw new OpensteerError({
          code: "forbidden",
          message: `${callable.installation.title} received an incompatible account`,
        });
      }
      if (materialized.definitionId !== definition.id) {
        throw new OpensteerError({
          code: "forbidden",
          message: `${definition.name} received an account for a different integration`,
        });
      }
      const method = definition.authMethods.find(
        (candidate) => candidate.id === materialized.authMethodId,
      );
      if (!method || (method.kind !== "api-key" && method.kind !== "oauth")) {
        throw new Error("Connected account auth method does not match the definition");
      }
      connectionMethod = materialized.connectionMethod;
      credentialGeneration = materialized.credentialGeneration;
      credentialValues = materialized.credentialValues;
      grantedScopes = materialized.grantedScopes;
      placements = method.placements;
    }
    const credentialSecrets = Object.values(credentialValues);
    let responseRedactor = createCredentialResponseRedactor(credentialSecrets);
    const invoke = async (values: Readonly<Record<string, string>>) => {
      try {
        return await withDeadline(
          adapter.invokeTool({
            args,
            config,
            ...(callable.grant.connectionId ? { connectionId: callable.grant.connectionId } : {}),
            credentialValues: values,
            placements,
            target: invocation.target,
            toolName: callable.tool.name,
          }),
          toolCallTimeoutMs,
          signal,
        );
      } catch (error) {
        if (integrationToolEffect(callable.tool.annotations) === "write") {
          throw new OpensteerError({
            code: "harness_error",
            message: unconfirmedIntegrationWriteMessage(callable),
            retryable: false,
          });
        }
        throw sanitizeAdapterError(error, responseRedactor);
      }
    };
    let result = await invoke(credentialValues);
    let refreshFailed = false;
    if (
      result.kind === "error" &&
      result.details?.status === 401 &&
      connectionMethod === "managed-oauth" &&
      callable.grant.connectionId
    ) {
      const original = result;
      try {
        const refreshed = await this.#credentialMaterializer.materializeForAdapter({
          connectionId: callable.grant.connectionId,
          forceRefresh: true,
          operation: callable.tool.name,
          ownerUserId: callable.grant.ownerUserId as UserId,
        });
        credentialGeneration = refreshed.credentialGeneration;
        credentialValues = refreshed.credentialValues;
        credentialSecrets.push(...Object.values(credentialValues));
        responseRedactor = createCredentialResponseRedactor(credentialSecrets);
        grantedScopes = refreshed.grantedScopes;
        result = await invoke(credentialValues);
      } catch (error) {
        if (
          error instanceof OpensteerError &&
          (error.code === "conflict" || error.code === "not_found")
        ) {
          throw new IntegrationAuthorizationRequiredError(callable);
        }
        // A classified refresh failure is the truest account of this 401; only an unclassified
        // throw falls back to reporting the upstream rejection the adapter already returned.
        if (error instanceof OpensteerError) throw error;
        refreshFailed = true;
        result = original;
      }
    }
    if (
      result.kind === "error" &&
      result.details?.status === 401 &&
      !refreshFailed &&
      callable.grant.connectionId
    ) {
      await this.#credentialMaterializer.markAdapterAuthorizationRequired({
        connectionId: callable.grant.connectionId,
        expectedGeneration: credentialGeneration,
        ownerUserId: callable.grant.ownerUserId as UserId,
        statusDetail: integrationCredentialRejectedDetail(
          callable.installation.title,
          connectionMethod === "api-key" ? "key" : "sign-in",
        ),
      });
      throw new IntegrationAuthorizationRequiredError(callable);
    }
    if (result.kind === "error") {
      const message =
        result.details?.outcomeUnknown === true &&
        integrationToolEffect(callable.tool.annotations) === "write"
          ? unconfirmedIntegrationWriteMessage(callable)
          : adapterErrorMessage(result, definition, grantedScopes);
      return sanitizeToolResult(
        { content: [{ text: message, type: "text" as const }], isError: true },
        responseRedactor,
      );
    }
    const structuredContent = objectResult(result.value);
    return sanitizeToolResult(
      {
        content: [{ text: JSON.stringify(result.value), type: "text" as const }],
        structuredContent,
      },
      responseRedactor,
    );
  }

  async close(): Promise<void> {
    await this.computerRepl.close();
    await Promise.allSettled(
      [...this.#computerOperationSettlements.values()].map((record) => record.done),
    );
    this.#closed = true;
    const opens = [...this.#clients.values()];
    this.#clients.clear();
    for (const open of opens) open.cancel.abort();
    const settled = await Promise.allSettled(opens.map(({ client }) => client));
    await Promise.allSettled(
      settled.flatMap((result) =>
        result.status === "fulfilled" ? [result.value.client.close()] : [],
      ),
    );
  }

  /** A server the Host reaches over the internet, listed once as it is installed. */
  async #discoverServer(server: LoadedAgentPluginServer): Promise<DiscoveredServerResult> {
    const id = createIntegrationId("server");
    const transport = IntegrationServerTransportSchema.parse(remoteTransport(server));
    try {
      const client = await this.#connect({ id, transport });
      try {
        return {
          authorizationRequired: false,
          catalog: { definitions: {}, tools: await listTools(client) },
          connectionRequirement: { kind: "none" },
          id,
          name: server.name,
          status: "active",
          statusDetail: null,
          transport,
        };
      } finally {
        await client.close();
      }
    } catch (error) {
      return {
        authorizationRequired: error instanceof UnauthorizedError,
        catalog: emptyToolCatalog,
        connectionRequirement:
          error instanceof UnauthorizedError ? { kind: "mcp-oauth" } : { kind: "none" },
        id,
        name: server.name,
        status: "needs-attention",
        statusDetail: safeMessage(error, safeMessageOptions),
        transport,
      };
    }
  }

  #adapter(kind: Exclude<IntegrationAdapterKind, "computer">): IntegrationAdapter {
    const adapter = this.#adapters.get(kind);
    if (!adapter) throw new Error(`Integration adapter ${kind} is not registered`);
    return adapter;
  }

  async #client(callable: CallableIntegrationTool): Promise<UpstreamClient> {
    const { server } = callable;
    const connectionId = callable.grant.connectionId;
    const key = `${server.id}:${connectionId ?? "deployment"}`;
    const fingerprint = integrationSchemaDigest({ connectionId, transport: server.transport });
    const authProvider = connectionId
      ? await this.#mcpOauth.providerFor({
          connectionId,
          ownerUserId: callable.grant.ownerUserId as UserId,
          serverId: server.id,
        })
      : undefined;
    const current = this.#clients.get(key);
    if (current) {
      return current.client.then(async (value) => {
        if (value.fingerprint === fingerprint) {
          const clientRevision = value.credentialRevision?.();
          const storedRevision = authProvider?.credentialRevision();
          if (clientRevision === storedRevision) return value;
          if (clientRevision == null || storedRevision == null || !connectionId)
            throw new Error("MCP credential revision is unavailable");
          if (storedRevision <= clientRevision) return value;
          const latest = await this.#mcpOauth.providerFor({
            connectionId,
            ownerUserId: callable.grant.ownerUserId as UserId,
            serverId: server.id,
          });
          if (this.#clients.get(key) !== current) return this.#client(callable);
          const latestRevision = latest.credentialRevision();
          const currentRevision = value.credentialRevision?.();
          if (latestRevision == null || currentRevision == null)
            throw new Error("MCP credential revision is unavailable");
          if (latestRevision <= currentRevision) return value;
        }
        this.#letGo(key, current);
        return this.#client(callable);
      });
    }
    // Another call may have started this client meanwhile; it is shared.
    if (this.#clients.has(key)) return this.#client(callable);
    return this.#open(key, callable.installation.id, async (signal) => {
      let client: Client;
      try {
        client = await this.#connect(server, authProvider, signal);
      } catch (error) {
        const revision = authProvider?.credentialRevision();
        if (error instanceof UnauthorizedError && revision !== null && revision !== undefined)
          throw new McpOAuthReauthorizationError(revision);
        throw error;
      }
      return {
        client,
        // Kept here because the SDK lets go of a transport once it closes.
        computer: client.transport instanceof ComputerMcpTransport ? client.transport : null,
        fingerprint,
        ...(authProvider ? { credentialRevision: () => authProvider.credentialRevision() } : {}),
        responseRedactor: authProvider ? () => authProvider.responseRedactor() : null,
      };
    }).client;
  }

  /**
   * Refuses to open a server on a computer unless it is still installed there,
   * launched exactly so, and approved so.
   */
  async #assertComputerServerCurrent(
    serverId: IntegrationServerId,
    transport: { readonly launch: LocalMcpLaunch; readonly runnerId: RunnerId },
  ): Promise<void> {
    const current = await this.#store.localMcp.get(serverId);
    if (
      !current ||
      current.status === "disabled" ||
      current.runnerId !== transport.runnerId ||
      current.launchDigest !== localMcpLaunchDigest(transport.launch) ||
      current.approvedLaunchDigest !== current.launchDigest
    ) {
      throw new Error("It was removed or changed as this started; find its tools again.");
    }
  }

  /** Holds a client under `key` from the moment it starts opening. */
  #open(
    key: string,
    installationId: IntegrationInstallationId,
    connect: (signal: AbortSignal) => Promise<Omit<UpstreamClient, "letGo">>,
  ): OpenClient {
    if (this.#closed) throw new Error("The integration platform has closed.");
    const cancel = new AbortController();
    const open: OpenClient = {
      cancel,
      client: connect(cancel.signal).then(
        (value) => {
          // A session that ended — a computer gone offline, a server that
          // stopped — leaves a client that can only fail, so it is not kept.
          value.client.onclose = () => {
            if (this.#clients.get(key) === open) this.#clients.delete(key);
          };
          return { ...value, letGo: () => this.#letGo(key, open) };
        },
        (error: unknown) => {
          if (this.#clients.get(key) === open) this.#clients.delete(key);
          throw error;
        },
      ),
      installationId,
    };
    this.#clients.set(key, open);
    return open;
  }

  /** Lets a client go: one still opening stops there, and an open one closes. */
  #letGo(key: string, open: OpenClient): void {
    if (this.#clients.get(key) === open) this.#clients.delete(key);
    open.cancel.abort();
    void open.client.then(({ client }) => client.close()).catch(() => undefined);
  }

  /**
   * An MCP client for one server. The Host itself reaches only servers on
   * the internet; a server that starts a program or listens on a loopback
   * runs on its computer, which the session is carried to.
   */
  async #connect(
    server: Pick<IntegrationServer, "id" | "transport">,
    authProvider?: RedactingOAuthClientProvider,
    signal?: AbortSignal,
  ): Promise<Client> {
    const { transport } = server;
    const client = new Client({ name: "opensteer-integration-host", version: "1.0.0" });
    let sdkTransport: Transport;
    let computer: ComputerMcpTransport | null = null;
    if (transport.type === "adapter") {
      throw new Error("Adapter-backed servers do not create upstream MCP clients");
    } else if (transport.type === "computer") {
      throw new Error("Computer-backed servers do not create upstream MCP clients");
    } else if (transport.type === "runner") {
      if (!transport.runnerId) {
        throw new Error(
          "No computer runs this MCP server; install its plugin again, choosing one.",
        );
      }
      // Every open is held in `#clients` before it gets here, so a removal or
      // change either finds it and ends it or is read here first: nothing
      // starts on the computer for a server as it no longer is.
      await this.#assertComputerServerCurrent(server.id, {
        launch: transport.launch,
        runnerId: transport.runnerId,
      });
      signal?.throwIfAborted();
      computer = new ComputerMcpTransport(this.#computerApps, {
        launch: transport.launch,
        runnerId: transport.runnerId,
        serverId: server.id,
      });
      sdkTransport = computer;
    } else {
      const url = new URL(transport.url);
      if (url.protocol !== "https:" || isLoopbackHostname(url.hostname)) {
        throw new Error("The Host reaches MCP servers on the internet, over HTTPS");
      }
      sdkTransport = new StreamableHTTPClientTransport(url, {
        ...(authProvider ? { authProvider } : {}),
        fetch: (target, init) => this.#publicFetch(target, { ...init, redirect: "manual" }),
        requestInit: { headers: transport.headers, redirect: "manual" },
      }) as unknown as Transport;
    }
    // Given up while opening: closing the client ends its transport, which
    // for a computer ends the session it is starting there.
    const abandon = () => void client.close().catch(() => undefined);
    signal?.addEventListener("abort", abandon, { once: true });
    try {
      signal?.throwIfAborted();
      await client.connect(sdkTransport, {
        maxTotalTimeout: connectionTimeoutMs,
        timeout: connectionTimeoutMs,
      });
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      // The computer's own reason says more than the SDK's "Connection closed".
      throw computer?.closeError ?? error;
    } finally {
      signal?.removeEventListener("abort", abandon);
    }
  }

  /**
   * An installation changed: every session its servers have open or are
   * opening ends — listings, and servers it retired or that wait on their
   * computer, included — and what is next opened reads it as it is now.
   */
  #invalidateInstallation(installationId: IntegrationInstallationId): void {
    for (const [key, open] of this.#clients) {
      if (open.installationId === installationId) this.#letGo(key, open);
    }
  }

  /** A server was removed: every client of it goes, its listing included. */
  #dropClient(serverId: IntegrationServer["id"]): void {
    const prefix = `${serverId}:`;
    for (const [key, open] of this.#clients) {
      if (key.startsWith(prefix)) this.#letGo(key, open);
    }
  }

  async #withRunnerAdmissions<Result>(
    runnerIds: readonly RunnerId[],
    task: () => Promise<Result>,
  ): Promise<Result> {
    const ordered = [...new Set(runnerIds)].sort((left, right) => left.localeCompare(right));
    const computerApps = ordered.length > 0 ? this.#computerApps : null;
    const enter = (index: number): Promise<Result> => {
      const runnerId = ordered[index];
      return runnerId && computerApps
        ? computerApps.withRunnerAdmission(runnerId, () => enter(index + 1))
        : task();
    };
    return enter(0);
  }

  #publishRequestEvents(events: readonly AgentEvent[]): void {
    for (const event of events) this.#onWorkspaceEvent(event);
    if (events.length > 0) this.#onRequestsChanged();
  }
}

/** Mirrors the connection an access decision fulfills, for both Main and specialized payloads. */
/**
 * What a session on this connection operates, from its definition and the
 * connection alone: the app it names, or a phone's whole display. Null for a
 * connection that does not fit its definition — an app-naming one with no
 * app, a display one that names an app, or a display this Host does not know
 * how to operate — which nobody may operate.
 */
function computerUseScope(
  definition: ComputerAppDefinition,
  app: ComputerAppIdentity | null,
): ComputerUseScope | null {
  if (computerAppNamesApp(definition.config)) return app ? { app, kind: "app" } : null;
  if (definition.id !== androidPhoneDefinitionId || app !== null) return null;
  return { definitionId: androidPhoneDefinitionId, kind: "display" };
}

function fulfillmentConnectionId(response: RequestResponse): IntegrationConnectionId | null {
  const value = response.kind === "external" ? response.value : undefined;
  return value?.decision === "fulfilled" && typeof value.connectionId === "string"
    ? IntegrationConnectionIdSchema.parse(value.connectionId)
    : null;
}

/**
 * Whether an Agent Plugin's server runs on a computer rather than being
 * reached by the Host: a program to start, or a server on a loopback, which
 * only the computer it is on can reach.
 */
function runsOnComputer(server: LoadedAgentPluginServer): boolean {
  return server.type === "stdio" || isLoopbackHostname(new URL(server.url).hostname);
}

function remoteTransport(server: LoadedAgentPluginServer): IntegrationServer["transport"] {
  if (server.type === "stdio") throw new Error("A program server runs on a computer");
  return { headers: { ...server.headers }, type: server.type, url: server.url };
}

function computerLaunch(server: LoadedAgentPluginServer): LocalMcpLaunch {
  return server.type === "stdio"
    ? {
        args: [...server.args],
        command: server.command,
        cwd: server.cwd,
        env: { ...server.env },
        type: "stdio",
      }
    : { headers: { ...server.headers }, type: "streamable-http", url: server.url };
}

/** A plugin server pinned to its computer, waiting for that computer's approval. */
function computerServer(
  server: LoadedAgentPluginServer,
  runnerId: RunnerId,
): DiscoveredServerResult {
  return {
    authorizationRequired: false,
    catalog: emptyToolCatalog,
    connectionRequirement: { kind: "none" },
    id: createIntegrationId("server"),
    name: server.name,
    status: "needs-attention",
    statusDetail: "Waiting for approval on the computer that runs it.",
    transport: IntegrationServerTransportSchema.parse({
      launch: computerLaunch(server),
      runnerId,
      type: "runner",
    }),
  };
}

/**
 * Every tool a server lists, page by page, as the Host records them. The
 * whole listing is bounded — by pages, by time, and by a cursor that comes
 * back — so a server that pages forever is refused rather than waited on.
 * An MCP tool's schema is self-contained, so a server's catalog shares nothing.
 */
async function listTools(client: Client): Promise<readonly IntegrationToolMaterial[]> {
  const listed: Tool[] = [];
  const cursors = new Set<string>();
  const deadline = Date.now() + 4 * connectionTimeoutMs;
  let cursor: string | undefined;
  do {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || cursors.size >= maximumToolPages) {
      throw new Error("The MCP server did not finish listing its tools");
    }
    const page = await client.listTools(cursor === undefined ? undefined : { cursor }, {
      maxTotalTimeout: remaining,
      timeout: Math.min(connectionTimeoutMs, remaining),
    });
    listed.push(...page.tools);
    if (listed.length > maximumToolsPerServer) {
      throw new Error(`MCP server exposes more than ${maximumToolsPerServer} tools`);
    }
    cursor = page.nextCursor;
    if (cursor !== undefined) {
      if (cursors.has(cursor)) throw new Error("The MCP server listed the same page twice");
      cursors.add(cursor);
    }
  } while (cursor !== undefined);
  return listed.map((tool): IntegrationToolMaterial => ({
    annotations: objectValue(tool.annotations ?? {}),
    connectionId: null,
    description: boundedToolDescription(tool.description),
    id: createIntegrationId("tool"),
    inputSchema: objectValue(tool.inputSchema),
    name: tool.name,
    outputSchema: tool.outputSchema ? objectValue(tool.outputSchema) : null,
    status: "active",
    title: boundedToolTitle(tool.title ?? tool.annotations?.title, tool.name),
  }));
}

const emptyToolCatalog: IntegrationToolCatalog = { definitions: {}, tools: [] };

function objectValue(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("MCP tool schema must be an object");
  }
  return value as Readonly<Record<string, unknown>>;
}

function sanitizeToolResult<T>(result: T, responseRedactor: CredentialResponseRedactor | null): T {
  const serialized = JSON.stringify(result);
  if (serialized === undefined) throw new Error("Integration result is not serializable");
  if (Buffer.byteLength(serialized, "utf8") > maximumToolResultBytes) {
    throw new Error(`Integration result exceeds ${maximumToolResultBytes} bytes`);
  }
  return responseRedactor ? (JSON.parse(responseRedactor.redactText(serialized)) as T) : result;
}

function sanitizeAdapterError(
  error: unknown,
  responseRedactor: CredentialResponseRedactor | null,
): OpensteerError {
  const rawMessage = error instanceof Error ? error.message : "Integration adapter failed";
  const message = responseRedactor?.redactText(rawMessage) ?? rawMessage;
  return new OpensteerError({
    cause: error,
    code: error instanceof OpensteerError ? error.code : "harness_error",
    message: message || "Integration adapter failed",
    retryable: error instanceof OpensteerError ? error.retryable : true,
  });
}

function connectionRequirement(
  definition: IntegrationDefinition,
): IntegrationServer["connectionRequirement"] {
  const kinds = new Set(definition.authMethods.map(({ kind }) => kind));
  if (kinds.size !== 1) {
    throw new Error(`Definition ${definition.id} must declare one connection posture`);
  }
  const kind = definition.authMethods[0]?.kind;
  if (kind === "none") return { kind: "none" };
  if (kind === "mcp-oauth") return { kind: "mcp-oauth" };
  if (kind === "computer") return { definitionId: definition.id, kind: "computer" };
  if (kind === "oauth") {
    return {
      definitionId: definition.id,
      kind: "provider",
      provider: definition.provider,
      providerApplicationRequired: true,
    };
  }
  if (kind === "api-key") {
    return {
      definitionId: definition.id,
      kind: "provider",
      provider: definition.provider,
      providerApplicationRequired: false,
    };
  }
  throw new Error(`Definition ${definition.id} has no supported auth method`);
}

function unconfirmedIntegrationWriteMessage(callable: CallableIntegrationTool): string {
  return `${callable.installation.title} did not confirm ${callable.tool.title}; the outcome is unknown. Check whether it happened before trying again.`;
}

function adapterErrorMessage(
  result: Extract<AdapterToolResult, { kind: "error" }>,
  definition: IntegrationDefinitionSummary,
  grantedScopes: readonly string[],
): string {
  if (result.code === "oauth_scope_insufficient") {
    return [
      `oauth_scope_insufficient: ${result.message}`,
      `Granted scopes: ${grantedScopes.length ? grantedScopes.join(", ") : "none reported"}.`,
      `Reconnect ${definition.name} and approve all requested permissions.`,
    ].join(" ");
  }
  const details = result.details ? ` Details: ${JSON.stringify(result.details)}` : "";
  return `${result.code}: ${result.message}${details}`;
}

function objectResult(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value };
}

function proposalSource(value: string): IntegrationProposalSource {
  if (URL.canParse(value)) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) {
      throw new OpensteerError({
        code: "bad_request",
        message: "Proposal URLs require uncredentialed HTTPS without a fragment",
      });
    }
    return { origin: url.origin, type: "url", url: url.toString() };
  }
  if (!value.trim()) {
    throw new OpensteerError({ code: "bad_request", message: "Proposal source is empty" });
  }
  if (Buffer.byteLength(value, "utf8") > 8 * 1_024 * 1_024) {
    throw new OpensteerError({ code: "bad_request", message: "Proposal source exceeds 8 MiB" });
  }
  return { content: value, type: "inline" };
}

function proposalSourceText(source: IntegrationProposalSource): string {
  if (source.type === "inline") return source.content;
  const url = new URL(source.url);
  if (url.origin !== source.origin) {
    throw new OpensteerError({ code: "forbidden", message: "Proposal source origin is invalid" });
  }
  return source.url;
}

/**
 * Where a proposal's description says it came from. Every surface already
 * marks a proposal as an agent's, so the description names only the host.
 */
function proposalSourceLabel(source: IntegrationProposalSource): string {
  return source.type === "url" ? new URL(source.origin).host : "a document the agent supplied";
}

function proposalSourceName(source: IntegrationProposalSource): string {
  return source.type === "url" ? source.url : "The inline proposal document";
}

/** Subdomains that identify infrastructure rather than the service behind it. */
const genericDomainLabels = new Set([
  "admin",
  "api",
  "app",
  "cloud",
  "console",
  "dashboard",
  "developer",
  "developers",
  "docs",
  "my",
  "portal",
  "www",
]);

function domainLabels(url: string): readonly string[] {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return [];
  }
  const labels = hostname.toLowerCase().split(".");
  // The last label is the public suffix, never the service identity.
  return labels.slice(0, -1).filter((label) => label.length > 0 && !genericDomainLabels.has(label));
}

function openApiServerUrls(document: Readonly<Record<string, unknown>>): readonly string[] {
  return Array.isArray(document.servers)
    ? document.servers.flatMap((server) => {
        const url = recordValue(server).url;
        return typeof url === "string" ? [url] : [];
      })
    : [];
}

function artifactDigest(value: string): string {
  return sha256Base64Url(value);
}

/** What an agent may add to a proposal beyond its source, each bound into the digest. */
type ProposalBindings = Pick<
  IntegrationProposalManifest,
  "check" | "credential" | "description" | "name"
>;

/**
 * A proposal's digest covers the inspected artifact and everything the agent
 * added to it, so an approval cannot be replayed with other guidance, another
 * name or another description. A bare document keeps the digest it always had,
 * which keeps proposals already waiting for review installable.
 */
function proposalDigest(artifact: string, bindings: ProposalBindings): string {
  return Object.keys(bindings).length > 0
    ? integrationSchemaDigest({ document: artifact, ...bindings })
    : artifactDigest(artifact);
}

function proposalSlug(digest: string): string {
  return `proposed-${createHash("sha256").update(digest).digest("hex").slice(0, 16)}`;
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * A `$ref` inside components.securitySchemes points into this same document, so
 * it is followed here. Left unresolved it would read as a scheme with no type
 * at all — which classifies as "no authentication", the exact misread that
 * installs an integration that can never authenticate a single call.
 */
function resolveLocalDocumentRef(
  document: Readonly<Record<string, unknown>>,
  value: unknown,
): Record<string, unknown> | null {
  const visited = new Set<string>();
  let current = value;
  while (typeof current === "object" && current !== null && !Array.isArray(current)) {
    const record = current as Record<string, unknown>;
    const reference = record.$ref;
    if (typeof reference !== "string") return record;
    if (!reference.startsWith("#/") || visited.has(reference)) return null;
    visited.add(reference);
    current = reference
      .slice(2)
      .split("/")
      .reduce<unknown>(
        (node, segment) => recordValue(node)[segment.replaceAll("~1", "/").replaceAll("~0", "~")],
        document,
      );
  }
  return null;
}

interface ClassifiedOpenApiScheme {
  readonly classification: "api-key" | "oauth" | "unclassified";
  readonly name: string;
  readonly scheme: Record<string, unknown> | null;
}

/**
 * Every declared security scheme, resolved and classified. A scheme that lands
 * on "unclassified" is not evidence of an unauthenticated API — it is evidence
 * that this document asks for a credential Opensteer does not know how to
 * carry, which is why the proposal path refuses instead of guessing.
 */
function classifiedOpenApiSecuritySchemes(
  document: Readonly<Record<string, unknown>>,
): readonly ClassifiedOpenApiScheme[] {
  return Object.entries(recordValue(recordValue(document.components).securitySchemes)).map(
    ([name, value]) => {
      const scheme = resolveLocalDocumentRef(document, value);
      if (!scheme) return { classification: "unclassified", name, scheme: null };
      // HTTP authentication scheme names are case-insensitive by RFC 7235, so a
      // document writing "Bearer" declares the same scheme as one writing "bearer".
      const httpScheme = typeof scheme.scheme === "string" ? scheme.scheme.toLowerCase() : null;
      if (scheme.type === "apiKey" || (scheme.type === "http" && httpScheme === "bearer")) {
        return { classification: "api-key", name, scheme };
      }
      if (scheme.type === "oauth2" || scheme.type === "openIdConnect") {
        return { classification: "oauth", name, scheme };
      }
      return { classification: "unclassified", name, scheme };
    },
  );
}

function detectedOpenApiAuthMethods(
  schemes: readonly ClassifiedOpenApiScheme[],
): IntegrationProposalManifest["authMethods"] {
  const detected = new Set<IntegrationProposalManifest["authMethods"][number]>();
  for (const { classification } of schemes) {
    if (classification === "api-key") detected.add("api-key");
    if (classification === "oauth") detected.add("oauth");
  }
  return detected.size ? [...detected] : ["none"];
}

function proposedAuthMethods(
  schemes: readonly ClassifiedOpenApiScheme[],
  credential?: IntegrationProposalManifest["credential"],
): readonly AuthMethod[] {
  const scheme = schemes.find(({ classification }) => classification === "api-key")?.scheme;
  if (!scheme) return [{ id: "none", kind: "none", label: "No authentication" }];
  const apiKey = scheme.type === "apiKey";
  const carrier = apiKey && scheme.in === "query" ? "query" : "header";
  const name = apiKey && typeof scheme.name === "string" ? scheme.name : "Authorization";
  return [
    {
      id: "api-key",
      inputs: [
        {
          label: credential?.label ?? "API credential",
          ...(credential ? { description: credential.description } : {}),
          secret: true,
          variable: "apiKey",
        },
      ],
      kind: "api-key",
      label: credential?.label ?? "API credential",
      placements: [
        {
          carrier,
          name,
          ...(apiKey ? {} : { prefix: "Bearer " }),
          variable: "apiKey",
        },
      ],
    },
  ];
}

function openApiPreview(document: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const info = recordValue(document.info);
  const paths = recordValue(document.paths);
  const methods = new Set(["delete", "get", "head", "options", "patch", "post", "put", "trace"]);
  const operations = Object.values(paths).flatMap((path) =>
    Object.entries(recordValue(path)).flatMap(([method, operation]) =>
      methods.has(method.toLowerCase()) ? [recordValue(operation)] : [],
    ),
  );
  const servers = openApiServerUrls(document);
  const tags = [
    ...new Set(
      operations.flatMap((operation) =>
        Array.isArray(operation.tags)
          ? operation.tags.filter((tag): tag is string => typeof tag === "string")
          : [],
      ),
    ),
  ];
  return {
    authSchemes: detectedOpenApiAuthMethods(classifiedOpenApiSecuritySchemes(document)),
    operationCount: operations.length,
    servers,
    tags,
    title: typeof info.title === "string" ? info.title.slice(0, 80) : "Proposed OpenAPI",
  };
}

function graphqlPreview(
  introspection: Awaited<ReturnType<typeof introspectGraphql>>,
): Record<string, unknown> {
  const queryName = introspection.__schema.queryType?.name;
  const mutationName = introspection.__schema.mutationType?.name;
  const queryType = introspection.__schema.types.find(({ name }) => name === queryName);
  const mutationType = introspection.__schema.types.find(({ name }) => name === mutationName);
  return {
    mutationCount: mutationType?.fields?.length ?? 0,
    operationCounts: {
      mutations: mutationType?.fields?.length ?? 0,
      queries: queryType?.fields?.length ?? 0,
    },
    queryCount: queryType?.fields?.length ?? 0,
    typeCount: introspection.__schema.types.length,
  };
}

function adapterCatalog(
  catalog: AdapterToolCatalog,
  connectionId: IntegrationConnectionId | null = null,
): IntegrationToolCatalog {
  return {
    definitions: catalog.definitions,
    tools: catalog.tools.map((tool): IntegrationToolMaterial => ({
      annotations: objectValue(tool.annotations ?? {}),
      connectionId,
      description: boundedToolDescription(tool.description),
      id: createIntegrationId("tool"),
      inputSchema: objectValue(tool.inputSchema),
      name: tool.name,
      outputSchema: tool.outputSchema ? objectValue(tool.outputSchema) : null,
      status: "active",
      title: boundedToolTitle(
        typeof tool.annotations?.title === "string" ? tool.annotations.title : undefined,
        tool.name,
      ),
      ...(tool.target ? { target: tool.target } : {}),
    })),
  };
}

/** An MCP server's own error answer, as opposed to a connection that lost it. */
function answeredMcpError(error: unknown): error is McpError {
  return (
    error instanceof McpError &&
    error.code !== ErrorCode.ConnectionClosed &&
    error.code !== ErrorCode.RequestTimeout
  );
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Integration tool call timed out")),
      timeoutMs,
    );
    const abort = () => reject(signal?.reason ?? new Error("Integration tool call aborted"));
    signal?.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

const safeMessageOptions = {
  fallback: "Integration operation failed",
  maximumLength: 1_000,
  singleLine: true,
} as const;

const proposalFailureOptions = {
  fallback: "the source did not answer with a usable schema",
  maximumLength: 300,
  singleLine: true,
} as const;
