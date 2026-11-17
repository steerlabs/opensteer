import { agentToolFailureResult } from "@opensteer/agent-tools";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { AdministrationCommandIdentity } from "@opensteer/database";
import { pluginDeviceFromManifest } from "@opensteer/integration-core";
import { safeMessage } from "@opensteer/shared/safeMessage";
import {
  readAgentPluginName,
  loadAgentPlugin,
  type LoadedAgentPluginServer,
} from "@opensteer/agent-plugins";
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
  type IntegrationConnectionSummary,
  type IntegrationDefinition,
  type IntegrationDefinitionSummary,
  type IntegrationInstallManifest,
  type IntegrationInstallation,
  type IntegrationInstallationId,
  type IntegrationProposalKind,
  type IntegrationProposalManifest,
  type IntegrationProposalSource,
  type IntegrationServer,
  type IntegrationToolCatalog,
  type IntegrationToolMaterial,
} from "@opensteer/integration-core";
import {
  type IntegrationAdapterCredentialMaterializer,
  type IntegrationProviderAuthorizationSource,
} from "@opensteer/integration-core/ports";
import {
  integrationDefinitionDigest,
  integrationSchemaDigest,
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
  validateProposedOpenApiCheck,
} from "@opensteer/integration-adapters";
import { integrationDefinitions } from "@opensteer/integration-catalog";
import { settingsCatalogEntries } from "./catalog-presentation.js";
import {
  type CallableIntegrationTool,
  type DiscoveredIntegrationServer,
  type InstallIntegrationInput,
  type IntegrationPlatformStore,
  type IntegrationRequester,
  type IntegrationDiscoveryRequester,
  type PreparedIntegrationInstallFulfillment,
} from "@opensteer/database";
import {
  OpensteerError,
  refused,
  RequestResponseSchema,
  type AgentEvent,
  type Request,
  type RequestId,
  type RequestResponse,
  type RunnerId,
  type UserId,
} from "@opensteer/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  McpOAuthReauthorizationError,
  type McpOAuthService,
  type RedactingOAuthClientProvider,
} from "./mcp-oauth-service.js";
import type { ToolCaller } from "../agents/tool-caller.js";
import type { DeviceService } from "../devices/device-service.js";
import { IntegrationAuthorizationRequiredError } from "../devices/integration-authorization-required.js";
import {
  pendingLocalServer,
  runsOnComputer,
  type LocalServerService,
} from "../local-servers/local-server-service.js";
import {
  answeredMcpError,
  connectMcpClient,
  emptyToolCatalog,
  listTools,
  maximumToolsPerServer,
  objectValue,
  safeMessageOptions,
  sanitizeToolResult,
  toolCallTimeoutMs,
  type UpstreamClient,
} from "../local-servers/mcp-clients.js";

export { IntegrationAuthorizationRequiredError };

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

/** What service integrations reach of the device service, where the two meet. */
type ServiceDevicePort = Pick<
  DeviceService,
  | "callTool"
  | "endSessionsForRemovedApps"
  | "installDefinition"
  | "prepareDefinition"
  | "verifyConnectionForFulfillment"
  | "withAvailability"
  | "withConnectionAdmission"
  | "withRunnerAdmissions"
>;

/** What service integrations reach of the local-server service. */
type ServiceLocalServerPort = Pick<
  LocalServerService,
  | "callTool"
  | "clients"
  | "pluginComputer"
  | "requestLocalServerApprovals"
  | "retainedServer"
  | "startApprovedServers"
  | "updateComputer"
>;

/**
 * Service integrations: catalog presets and their built-in installs,
 * proposals, remote MCP servers, Agent Plugin installs, access Requests and
 * calls through the OpenAPI, GraphQL and remote MCP adapters. A computer
 * app's tool is the device service's to call, and a server a computer runs
 * is the local-server service's.
 */
export class IntegrationPlatformService {
  readonly #listConnections: (
    ownerUserId: UserId,
  ) => Promise<readonly IntegrationConnectionSummary[]>;
  readonly #adapters: ReadonlyMap<IntegrationAdapterKind, IntegrationAdapter>;
  readonly #authorizationSource: IntegrationProviderAuthorizationSource;
  readonly #credentialMaterializer: IntegrationAdapterCredentialMaterializer;
  readonly #dataDirectory: string;
  readonly #definitions: readonly IntegrationDefinition[];
  readonly #devices: ServiceDevicePort;
  readonly #localServers: ServiceLocalServerPort;
  readonly #publicFetch: typeof fetch;
  readonly #store: IntegrationPlatformStore;
  readonly #mcpOauth: Pick<McpOAuthService, "providerFor">;
  readonly #onDeploymentEvent: (event: AgentEvent) => void;
  readonly #onConnectionsChanged: () => void;
  readonly #onSettingsChanged: (input: {
    installationId?: string;
    ownerUserId?: UserId;
  }) => Promise<void>;
  readonly #onRequestsChanged: () => void;

  constructor(options: {
    readonly listConnections: (
      ownerUserId: UserId,
    ) => Promise<readonly IntegrationConnectionSummary[]>;
    readonly adapters?: readonly IntegrationAdapter[];
    readonly authorizationSource: IntegrationProviderAuthorizationSource;
    readonly dataDirectory: string;
    readonly credentialMaterializer: IntegrationAdapterCredentialMaterializer;
    readonly definitions?: readonly IntegrationDefinition[];
    /** Calls, availability and installs of computer apps, at each seam they cross. */
    readonly devices: ServiceDevicePort;
    /** The servers computers run, and the MCP clients the Host holds. */
    readonly localServers: ServiceLocalServerPort;
    readonly mcpOauth: Pick<McpOAuthService, "providerFor">;
    readonly onDeploymentEvent: (event: AgentEvent) => void;
    readonly onConnectionsChanged: () => void;
    readonly onSettingsChanged?: (input: {
      installationId?: string;
      ownerUserId?: UserId;
    }) => Promise<void>;
    readonly onRequestsChanged: () => void;
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
    this.#definitions = options.definitions ?? integrationDefinitions;
    this.#devices = options.devices;
    this.#localServers = options.localServers;
    this.#mcpOauth = options.mcpOauth;
    this.#onDeploymentEvent = options.onDeploymentEvent;
    this.#onConnectionsChanged = options.onConnectionsChanged;
    this.#onSettingsChanged = options.onSettingsChanged ?? (async () => undefined);
    this.#onRequestsChanged = options.onRequestsChanged;
    this.#store = options.store;
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

  async settingsCatalog() {
    return settingsCatalogEntries(
      this.#definitions,
      new Set(await this.#store.installations.installedCatalogDefinitionIds()),
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
    return this.#devices.withAvailability(inventory, input);
  }

  async listCallableTools(input: IntegrationRequester) {
    return this.#store.listCallableTools({
      ...input,
      providerAuthorizations: await this.#authorizationSource.providerAuthorizations(
        input.ownerUserId,
      ),
    });
  }

  /**
   * The one reaction to a connection gaining authority, whichever surface
   * finished the flow: discover the tools a provider connection now exposes,
   * then settle every pending personal Request the connection satisfies.
   * Returns the Requests it fulfilled so the caller can resume their agents.
   */
  async connectionConnected(input: {
    readonly connectionId: import("@opensteer/integration-core").IntegrationConnectionId;
    readonly ownerUserId: UserId;
  }): Promise<readonly RequestId[]> {
    if ((await this.#store.getConnectionKind(input)) === "provider-account") {
      await this.reconcileProviderConnectionTools(input);
    }
    return this.fulfillSatisfiedAccessRequests(input);
  }

  async fulfillSatisfiedAccessRequests(input: {
    readonly connectionId: import("@opensteer/integration-core").IntegrationConnectionId;
    readonly ownerUserId: UserId;
  }): Promise<readonly RequestId[]> {
    const providerAuthorizations = await this.#authorizationSource.providerAuthorizations(
      input.ownerUserId,
    );
    const pending = await this.#store.integrationRequests.listPendingIntegrationAccessRequests(
      input.ownerUserId,
    );
    const fulfilled: RequestId[] = [];
    for (const detail of pending) {
      if (detail.requestedConnectionId && detail.requestedConnectionId !== input.connectionId)
        continue;
      if (!detail.installationId) continue;
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
      const grants = await this.#store.listGrants({ ownerUserId: input.ownerUserId });
      const existing = grants.find(
        (grant) =>
          grant.installationId === detail.installationId &&
          grant.connectionId === input.connectionId &&
          grant.status === "active",
      );
      const connection = (await this.#listConnections(input.ownerUserId)).find(
        ({ id }) => id === input.connectionId,
      );
      try {
        const resolved = await this.#store.integrationRequests.resolveIntegrationAccessRequest({
          providerAuthorizations,
          requestId: detail.request.id,
          resolvedBy: input.ownerUserId,
          response: {
            kind: "external",
            value: {
              connectionId: input.connectionId,
              decision: "fulfilled",
              access: existing?.access === "read-write" ? "read-write" : detail.access,
              alias:
                existing?.alias ??
                (connection?.displayName.trim().slice(0, 80) || input.connectionId),
              isDefault: existing?.isDefault ?? false,
            },
          },
        });
        for (const event of resolved.events) this.#onDeploymentEvent(event);
        fulfilled.push(resolved.request.id);
      } catch (error) {
        if (error instanceof OpensteerError && error.code === "conflict") continue;
        throw error;
      }
    }
    return fulfilled;
  }

  async resolveRequest(input: {
    readonly requestId: RequestId;
    readonly resolvedBy: UserId;
    readonly settlementSessionId?: string;
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
        const selected = await this.#store.integrationRequests.selectIntegrationAccessServer({
          requestId: input.requestId,
          resolvedBy: input.resolvedBy,
          ...(input.settlementSessionId ? { settlementSessionId: input.settlementSessionId } : {}),
          requestedServerId: IntegrationServerIdSchema.parse(
            response.optionId.slice("server:".length),
          ),
        });
        for (const event of selected.events) this.#onDeploymentEvent(event);
        return { grant: null, installation: null, request: selected.request };
      }
      if (response.kind === "choice" && response.optionId === "installed") {
        let installed =
          await this.#store.integrationRequests.tryBindExistingIntegrationAccessInstallation(input);
        if (!installed) {
          const manifest =
            await this.#store.integrationRequests.loadIntegrationAccessInstallManifest(input);
          const preparedFulfillment = await this.#prepareInstallationFromManifest(manifest);
          installed = await this.#store.integrationRequests.installForIntegrationAccessRequest({
            requestId: input.requestId,
            resolvedBy: input.resolvedBy,
            ...(input.settlementSessionId
              ? { settlementSessionId: input.settlementSessionId }
              : {}),
            preparedFulfillment,
          });
        }
        this.#localServers.clients.invalidateInstallation(installed.installation.id);
        for (const event of installed.requestEvents) this.#onDeploymentEvent(event);
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
        return this.#store.integrationRequests.resolveIntegrationAccessRequest({
          providerAuthorizations: await this.#authorizationSource.providerAuthorizations(
            input.resolvedBy,
          ),
          requestId: input.requestId,
          resolvedBy: input.resolvedBy,
          ...(input.settlementSessionId ? { settlementSessionId: input.settlementSessionId } : {}),
          response,
        });
      };
      const resolved =
        connectionId && connectionKind === "computer"
          ? await this.#devices.withConnectionAdmission(connectionId, input.resolvedBy, resolve)
          : await resolve();
      for (const event of resolved.events) this.#onDeploymentEvent(event);
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
            await this.#store.integrationRequests.loadIntegrationInstallManifest({
              requestId: input.requestId,
              resolvedBy: input.resolvedBy,
              ...(input.settlementSessionId
                ? { settlementSessionId: input.settlementSessionId }
                : {}),
            }),
          )
        : undefined;
    const resolved = await this.#store.integrationRequests.resolveIntegrationInstallRequest({
      ...(preparedFulfillment ? { preparedFulfillment } : {}),
      requestId: input.requestId,
      resolvedBy: input.resolvedBy,
      ...(input.settlementSessionId ? { settlementSessionId: input.settlementSessionId } : {}),
      response,
    });
    if (resolved.installation)
      this.#localServers.clients.invalidateInstallation(resolved.installation.id);
    this.#publishRequestEvents(resolved.requestEvents);
    for (const event of resolved.events) this.#onDeploymentEvent(event);
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
      await this.#devices.verifyConnectionForFulfillment(connectionId, ownerUserId, request);
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
    readonly administration?: AdministrationCommandIdentity | undefined;
    readonly actorUserId: UserId;
    readonly directory: string;
    readonly threadId?: import("@opensteer/core").ThreadId;
    readonly pluginId?: string;
    readonly requestId: string;
    /**
     * The computer that runs the plugin's servers that start a program or
     * listen on loopback, which never run inside the Host. The existing computer on update, otherwise the Deployment's Main computer.
     */
    readonly runnerId?: RunnerId | undefined;
  }): Promise<{
    readonly installation: IntegrationInstallation;
    readonly issues: readonly unknown[];
  }> {
    let pluginId = input.pluginId;
    let currentPlugin:
      Awaited<ReturnType<IntegrationPlatformStore["plugins"]["list"]>>[number] | undefined;
    if (pluginId) currentPlugin = (await this.#store.plugins.list()).find((p) => p.id === pluginId);
    else if (input.threadId) {
      const name = await readAgentPluginName(input.directory);
      currentPlugin = (await this.#store.plugins.list()).find(
        (p) => p.name === name && p.installedBy === input.actorUserId,
      );
      pluginId = currentPlugin?.id;
    }
    const setupThreadId = input.threadId
      ? await this.#store.plugins.setupThread(input.threadId)
      : undefined;
    const updating = pluginId !== undefined;
    pluginId ??= createIntegrationId("installation");
    const previous = updating
      ? (await this.#store.listInstallations()).find((i) => i.pluginId === pluginId)
      : undefined;
    const plugin = await loadAgentPlugin({
      pluginId,
      migrateLegacyData: previous?.id === pluginId,
      dataDirectory: `${this.#dataDirectory}/plugins/data`,
      directory: input.directory,
    });
    const previousServers = previous
      ? (await this.#store.localMcp.list()).filter((s) => s.installationId === previous.id)
      : [];
    const runnerId = plugin.servers.some(runsOnComputer)
      ? await this.#localServers.pluginComputer(
          await this.#localServers.updateComputer(input, previousServers),
        )
      : null;
    if (plugin.manifest.name === "opensteer")
      throw new OpensteerError({
        code: "bad_request",
        message: "The plugin name opensteer is reserved",
      });
    // Not for administration commands, whose result their ledger records in the install.
    if (
      !input.administration &&
      previous &&
      currentPlugin?.versions.find((v) => v.id === currentPlugin.currentVersionId)?.digest ===
        basename(plugin.root) &&
      previousServers
        .filter((s) => plugin.servers.some((next) => next.name === s.name))
        .every((s) => s.runnerId === runnerId && s.status !== "disabled")
    ) {
      if (setupThreadId !== undefined) {
        await this.#store.plugins.recordSetupThread(pluginId, setupThreadId);
        await this.#localServers.requestLocalServerApprovals();
        await this.#onSettingsChanged({ installationId: previous.id });
      }
      return { installation: previous, issues: plugin.issues };
    }
    const installationId = createIntegrationId("installation");
    const servers = await Promise.all(
      plugin.servers.map((server) =>
        runnerId !== null && runsOnComputer(server)
          ? pendingLocalServer(server, runnerId, basename(plugin.root), pluginId)
          : this.#discoverServer(server),
      ),
    );
    const version = {
      ...(setupThreadId !== undefined ? { setupThreadId } : {}),
      digest: basename(plugin.root),
      manifest: {
        ...plugin.manifest,
        skills: plugin.skills.map(({ name, description, digest }) => ({
          name,
          description,
          digest,
        })),
      },
    };
    const mutation = await this.#store.install({
      administration: input.administration,
      beforeInstall: async (transaction) => {
        if (updating)
          await this.#store.plugins.update(
            {
              pluginId,
              source: { directory: input.directory },
              ...version,
            },
            transaction,
          );
        else
          await this.#store.plugins.install(
            {
              id: pluginId,
              name: plugin.manifest.name,
              actorUserId: input.actorUserId,
              source: { directory: input.directory },
              ...version,
            },
            transaction,
          );
      },
      retainedServer: (existing, discovered) =>
        this.#localServers.retainedServer(existing, discovered),
      actorUserId: input.actorUserId,
      adapterSnapshot: null,
      installation: {
        pluginId,
        description: plugin.manifest.description ?? "",
        id: previous?.id ?? installationId,
        manifest: plugin.manifest,
        name: `plugin-${pluginId.replaceAll("_", "-")}`,
        provenance: {
          snapshotDigest: basename(plugin.root),
          standard: "agent-plugins/1.0.0",
        },
        sourceKind: "plugin",
        // A server waiting for its computer's approval is not broken.
        status:
          plugin.skills.length > 0 ||
          servers.some(
            ({ authorizationRequired, status, transport }) =>
              authorizationRequired || status === "active" || transport.type === "runner",
          )
            ? "active"
            : "needs-attention",
        title: pluginDeviceFromManifest(plugin.manifest)?.name ?? plugin.manifest.name,
        trust: "administrator-approved",
        version: plugin.manifest.version ?? null,
      },
      requestId: input.requestId,
      servers,
    });
    await this.#onSettingsChanged({ installationId: mutation.installation.id });
    const installation = this.#acceptInstallMutation(mutation);
    if (runnerId !== null) {
      await this.#localServers.requestLocalServerApprovals();
      // Installed again as it was, a server keeps its computer's approval and
      // is listed again now rather than when that computer next reconnects.
      this.#localServers.startApprovedServers(
        (server) => server.installationId === installation.id,
      );
    }
    return { installation, issues: plugin.issues };
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
          "A server on a computer's own loopback runs on that computer: register it with local_server_add, choosing the computer that runs it.",
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
    await this.#onSettingsChanged({ installationId: mutation.installation.id });
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
    if (this.#definitions.some((definition) => definition.hostedOAuth))
      await this.#store.installations.backfillHostedOAuthMetadata(this.#definitions);
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
      // A computer app's built-in is the device service's to reconcile.
      if (isComputerAppDefinition(definition)) continue;
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
        await this.#onSettingsChanged({ installationId: current.id });
        installations.push(current);
      }
    }
    return installations;
  }

  async installCatalogDefinition(input: {
    readonly settlementSessionId?: string | undefined;
    readonly actorUserId: UserId;
    readonly definitionId: string;
    readonly digest: string;
    readonly requestId: string;
  }): Promise<IntegrationInstallation> {
    const definition = this.#definitions.find((candidate) => candidate.id === input.definitionId);
    if (!definition) {
      throw new OpensteerError({ code: "not_found", message: "Catalog integration was not found" });
    }
    if (isComputerAppDefinition(definition)) return this.#devices.installDefinition(input);
    const digest = integrationDefinitionDigest(definition);
    if (digest !== input.digest) {
      throw new OpensteerError({
        code: "conflict",
        message: "The catalog integration changed; review the current definition before installing",
      });
    }
    if (definition.hostedOAuth)
      await this.#store.installations.backfillHostedOAuthMetadata([definition]);
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
      settlementSessionId: input.settlementSessionId,
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
    readonly administration?: AdministrationCommandIdentity | undefined;
    readonly actorUserId: UserId;
    readonly installationId: IntegrationInstallationId;
    readonly requestId: string;
  }): Promise<IntegrationUninstallOutcome> {
    const runnerIds = await this.#store.listComputerRunnerIdsForInstallation(input.installationId);
    const mutation = await this.#devices.withRunnerAdmissions(runnerIds, async () => {
      const removed = await this.#store.uninstall(input);
      this.#devices.endSessionsForRemovedApps(removed.removedApps);
      return removed;
    });
    this.#publishRequestEvents(mutation.requestEvents);
    for (const serverId of mutation.removedServerIds)
      this.#localServers.clients.dropServer(serverId);
    this.#onConnectionsChanged();
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
      throw refused("conflict", `Adapter exposes more than ${maximumToolsPerServer} tools`);
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
    readonly settlementSessionId?: string | undefined;
    readonly actorUserId: UserId | null;
    readonly current?: IntegrationInstallation;
    readonly definition: IntegrationDefinition;
    readonly requestId: string;
  }): Promise<IntegrationInstallation> {
    const prepared = await this.#prepareCatalogDefinition(input);
    const mutation = await this.#store.install({
      ...prepared,
      settlementSessionId: input.settlementSessionId,
      actorUserId: input.actorUserId,
      requestId: input.requestId,
    });
    await this.#onSettingsChanged({ installationId: mutation.installation.id });
    return this.#acceptInstallMutation(mutation);
  }

  async #prepareCatalogDefinition(input: {
    readonly current?: IntegrationInstallation;
    readonly definition: IntegrationDefinition;
  }): Promise<PreparedIntegrationMaterial> {
    const { definition } = input;
    if (isComputerAppDefinition(definition))
      return this.#devices.prepareDefinition({
        ...(input.current ? { current: input.current } : {}),
        definition,
      });
    const requirement = connectionRequirement(definition);
    let adapterSnapshot: IntegrationAdapterSnapshot | null = null;
    let catalog: IntegrationToolCatalog = emptyToolCatalog;
    let status: "active" | "needs-attention" = "active";
    let statusDetail: string | null = null;
    let summary = this.definitionSummary(definition);
    if (definition.adapter === "computer") {
      throw new Error("Computer apps are installed from their own definitions");
    }
    let transport: IntegrationServer["transport"] = {
      adapter: definition.adapter,
      definitionId: definition.id,
      type: "adapter",
    };
    try {
      if (definition.adapter === "mcp" && requirement.kind !== "provider") {
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
    await this.#onSettingsChanged({ installationId: mutation.installation.id });
    return this.#acceptInstallMutation(mutation);
  }

  #acceptInstallMutation(
    mutation: Awaited<ReturnType<IntegrationPlatformStore["install"]>>,
  ): IntegrationInstallation {
    this.#publishRequestEvents(mutation.requestEvents);
    this.#localServers.clients.invalidateInstallation(mutation.installation.id);
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
      throw refused("conflict", `Adapter exposes more than ${maximumToolsPerServer} tools`);
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
    if (input.kind) {
      return this.#inspectProposalKind(source, input.kind, options).catch((cause: unknown) => {
        throw cause instanceof OpensteerError
          ? cause
          : refused("bad_request", safeMessage(cause, proposalFailureOptions));
      });
    }
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
      throw refused("bad_request", "credential and check require an API-key OpenAPI proposal");
    }
    if (kind === "openapi") {
      const text = await this.#proposalArtifactText(source);
      const document = parseOpenApiDocument(text);
      const preview = openApiPreview(document);
      const schemes = classifiedOpenApiSecuritySchemes(document);
      const authMethods = detectedOpenApiAuthMethods(schemes);
      const credential = schemes.find(({ classification }) => classification === "api-key");
      if ((options.credential || options.check) && !credential) {
        throw refused("bad_request", "credential and check require an API-key OpenAPI proposal");
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
        throw refused(
          "bad_request",
          "GraphQL proposals require an HTTPS endpoint URL; an inline document cannot be introspected",
        );
      }
      const introspection = await introspectGraphql(source.url, {
        fetch: (target, init) => this.#publicFetch(target, { ...init, redirect: "manual" }),
      }).catch((cause: unknown) => {
        throw refused(
          "conflict",
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
      throw refused(
        "bad_request",
        "MCP proposals require an HTTPS endpoint URL; an inline document cannot be probed",
      );
    }
    const probed = await probeMcpEndpointShape(source.url, {
      fetch: (target, init) => this.#publicFetch(target, { ...init, redirect: "manual" }),
    }).catch((cause: unknown) => {
      throw refused(
        "conflict",
        `MCP probe of ${source.url} failed: ${safeMessage(cause, proposalFailureOptions)}`,
      );
    });
    if (probed.kind !== "mcp") {
      throw refused("conflict", `MCP probe of ${source.url} failed: ${probed.reason}`);
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
    if (!response.ok) throw refused("conflict", `Proposal source returned HTTP ${response.status}`);
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > 8 * 1_024 * 1_024) {
      throw refused("conflict", "Proposal source exceeded 8 MiB");
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
      return this.#devices.callTool(callable, args, caller, signal);
    }
    // Every other upstream validates its own arguments and its refusal reaches
    // the agent as it was written, so the Host holds no copy of a schema here.
    if (callable.server.transport.type === "adapter") {
      return (await this.#callAdapterTool(callable, args, signal)) as unknown as Awaited<
        ReturnType<Client["callTool"]>
      >;
    }
    if (callable.server.transport.type === "runner") {
      return this.#localServers.callTool(callable, args, caller, signal);
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
        await this.#onSettingsChanged({ ownerUserId: callable.grant.ownerUserId as UserId });
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
        message: "Integration operation changed; search again",
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
          await this.#onSettingsChanged({ ownerUserId: callable.grant.ownerUserId as UserId });
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
          await this.#onSettingsChanged({ ownerUserId: callable.grant.ownerUserId as UserId });
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
        agentToolFailureResult({
          code: result.details?.outcomeUnknown === true ? "outcome_unknown" : result.code,
          message,
          next: null,
        }),
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
    const authorization = () =>
      this.#mcpOauth.providerFor({
        connectionId: connectionId!,
        ownerUserId: callable.grant.ownerUserId as UserId,
        serverId: server.id,
      });
    return this.#localServers.clients.client(callable, {
      authorization,
      connect: async (authProvider, signal) => {
        try {
          return await this.#connect(server, authProvider, signal);
        } catch (error) {
          const revision = authProvider?.credentialRevision();
          if (error instanceof UnauthorizedError && revision !== null && revision !== undefined)
            throw new McpOAuthReauthorizationError(revision);
          throw error;
        }
      },
    });
  }

  /** An MCP client for a server the Host itself reaches: on the internet, over HTTPS. */
  async #connect(
    server: Pick<IntegrationServer, "id" | "transport">,
    authProvider?: RedactingOAuthClientProvider,
    signal?: AbortSignal,
  ): Promise<Client> {
    const { transport } = server;
    const client = new Client({ name: "opensteer-integration-host", version: "1.0.0" }, {});
    if (transport.type === "adapter") {
      throw new Error("Adapter-backed servers do not create upstream MCP clients");
    } else if (transport.type === "computer") {
      throw new Error("Computer-backed servers do not create upstream MCP clients");
    } else if (transport.type === "runner") {
      throw new Error("A server a computer runs opens through that computer");
    }
    const url = new URL(transport.url);
    if (url.protocol !== "https:" || isLoopbackHostname(url.hostname)) {
      throw refused("bad_request", "The Host reaches MCP servers on the internet, over HTTPS");
    }
    const sdkTransport = new StreamableHTTPClientTransport(url, {
      ...(authProvider ? { authProvider } : {}),
      fetch: (target, init) => this.#publicFetch(target, { ...init, redirect: "manual" }),
      requestInit: { headers: transport.headers, redirect: "manual" },
    }) as unknown as Transport;
    return connectMcpClient(client, sdkTransport, signal, (error) => error);
  }

  #publishRequestEvents(events: readonly AgentEvent[]): void {
    for (const event of events) this.#onDeploymentEvent(event);
    if (events.length > 0) this.#onRequestsChanged();
  }
}

function fulfillmentConnectionId(response: RequestResponse): IntegrationConnectionId | null {
  const value = response.kind === "external" ? response.value : undefined;
  return value?.decision === "fulfilled" && typeof value.connectionId === "string"
    ? IntegrationConnectionIdSchema.parse(value.connectionId)
    : null;
}

function remoteTransport(server: LoadedAgentPluginServer): IntegrationServer["transport"] {
  if (server.type === "stdio") throw new Error("A program server runs on a computer");
  return { headers: { ...server.headers }, type: server.type, url: server.url };
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

const proposalFailureOptions = {
  fallback: "the source did not answer with a usable schema",
  maximumLength: 300,
  singleLine: true,
} as const;
