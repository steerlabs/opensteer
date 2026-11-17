import { randomUUID } from "node:crypto";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { TabIdSchema, WindowIdSchema, type TabId } from "@opensteer/core";
import {
  OpensteerError,
  refused,
  UserIdSchema,
  type AgentEvent,
  type RunId,
  type RunnerId,
  type UserId,
} from "@opensteer/core";
import type {
  AdministrationCommandIdentity,
  CallableIntegrationTool,
  CreateIntegrationGrantInput,
  InstallIntegrationInput,
  IntegrationDiscoveryRequester,
  IntegrationPlatformStore,
  IntegrationRequester,
} from "@opensteer/database";
import { accessCoversEffect, type IntegrationAccess } from "@opensteer/integration-core/access";
import type { IntegrationDefinition } from "@opensteer/integration-core/adapter";
import { integrationDefinitionSummary } from "@opensteer/integration-core/adapter";
import {
  computerAppIdentityKey,
  computerAppNamesApp,
  isComputerAppDefinition,
  type ComputerAppDefinition,
  type ComputerAppIdentity,
  type ComputerAppOperation,
} from "@opensteer/integration-core/computer-app";
import {
  computerAppOperationContract,
  computerAppTools,
} from "@opensteer/integration-core/computer-app-tools";
import {
  integrationDefinitionDigest,
  integrationSchemaDigest,
} from "@opensteer/integration-core/digest";
import {
  createIntegrationId,
  IntegrationConnectionIdSchema,
  type IntegrationConnectionId,
  type IntegrationInstallationId,
} from "@opensteer/integration-core/ids";
import type {
  IntegrationConnectionSummary,
  IntegrationGrant,
  IntegrationInstallation,
  IntegrationReadiness,
  IntegrationServer,
} from "@opensteer/integration-core/models";
import {
  ComputerUseBindParamsSchema,
  HostIntegrationsInvokeSchema,
  androidPhoneDefinitionId,
  computerUseActHeadline,
  computerUseHeadline,
  computerUseToolRequiredSentence,
  computerUseUpdateMacSentence,
  type RunnerRunFileResult,
} from "@opensteer/protocol";
import type { RunnerRegistry } from "@opensteer/orchestration";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import { validateJsonSchema } from "@opensteer/shared/jsonSchemaValidation";
import { z } from "zod";
import type { RunCapabilityClaims } from "../agents/run-capability.js";
import type { RunFileRelay } from "../agents/run-file-relay.js";
import type { RunToolScope } from "../agents/run-tool-tokens.js";
import type { RunToolContext, ToolCaller } from "../agents/tool-caller.js";
import {
  computerAppAvailabilityDetail,
  computerAppSentence,
  computerAppTransportUnavailableDetail,
  iphoneAppsUnavailableDetail,
  phoneAvailabilityDetail,
} from "../computer-apps/computer-app-availability.js";
import type {
  ComputerAppHub,
  ComputerAppInvokeInput,
  ComputerAppInvokeSend,
} from "../computer-apps/computer-app-hub.js";
import {
  ComputerReplService,
  type ComputerReplInvocation,
} from "../computer-use/computer-repl/computer-repl-service.js";
import type { ReplContent, ReplReply } from "../computer-use/computer-repl/messages.js";
import { bindNativeTab } from "../computer-use/computer-repl/native-tab-binding.js";
import type { NativeReplTabTarget, NativeTabTargets } from "../computer-use/native-tab-targets.js";
import {
  ComputerUseError,
  computerUseDefinitionId,
  type ComputerUseDispatchResult,
  type ComputerUseLease,
  type ComputerUseScope,
  type ComputerUseService,
} from "../computer-use/computer-use-service.js";
import type { LocalServerService } from "../local-servers/local-server-service.js";
import { sanitizeToolResult } from "../local-servers/mcp-clients.js";
import type { TabServicePort } from "../tabs/ports.js";
import {
  ComputerAppApprovalService,
  computerUseHoldingOf,
  endComputerUseSessions,
  type ComputerUseApprovalGateway,
} from "./computer-app-approval-service.js";
import { computerObservationContent } from "./computer-use-tool-result.js";
import { IntegrationAuthorizationRequiredError } from "./integration-authorization-required.js";

/** What moving a file between a Run and a computer app needs from the Host. */
export interface RunFilePort {
  /** Whether this Runner's apps can move files for an operation. */
  appFiles(runnerId: RunnerId): boolean;
  readonly relay: RunFileRelay;
  request: RunnerRegistry["requestRunFile"];
  /** Whether this Runner can give a Run files and take them from it. */
  runFiles(runnerId: RunnerId): boolean;
}

/**
 * Which engine one call's Thread runs on, asked as the person running it: the
 * Thread is theirs, and this Host reads no Thread on nobody's behalf.
 */
export interface EngineCapabilityQuery extends RunToolContext {
  readonly ownerUserId: UserId;
}

/** What `callTool`, the rpc surface and `app_access_request` need of sessions. */
export type ComputerUseGateway = ComputerUseApprovalGateway &
  Pick<
    ComputerUseService,
    "prepare" | "release" | "releaseSession" | "sendAct" | "sendObserve" | "sendWindowOperation"
  >;

type ComputerPlacement = NonNullable<
  Awaited<ReturnType<IntegrationPlatformStore["getComputerConnectionForCall"]>>
>;
type JsonObject = Readonly<Record<string, unknown>>;
type PreparedIntegrationMaterial = Omit<InstallIntegrationInput, "actorUserId" | "requestId">;

/** One installation as a discovery inventory lists it, with each server's and tool's readiness. */
interface DiscoveryInventoryEntry {
  readonly accounts: readonly {
    readonly account: string;
    readonly connectionId: IntegrationConnectionId;
  }[];
  readonly installation: IntegrationInstallation;
  readonly readiness: {
    readonly servers: readonly IntegrationReadiness[];
    readonly tools: readonly {
      readonly readiness: IntegrationReadiness;
      readonly toolId: string;
    }[];
  };
  readonly servers: readonly Pick<IntegrationServer, "id" | "transport">[];
  readonly tools: readonly { readonly id: string; readonly name: string }[];
}

interface RunFileRoute {
  close(failure?: Error): void;
  readonly files: NonNullable<ComputerAppInvokeInput["files"]>;
  /** The Run's side, when it is on another Runner. */
  readonly peer?: Promise<RunnerRunFileResult>;
}

/**
 * The device stack's authority: which computer apps and phones a task may
 * use, on which computer, with what access. It dispatches their data tools,
 * moves their files to and from Runs, runs `computer_use`, records each
 * operation, and keeps their approvals and built-in installations.
 */
export class DeviceService {
  readonly #listConnections: (
    ownerUserId: UserId,
  ) => Promise<readonly IntegrationConnectionSummary[]>;
  readonly #computerApps: Pick<
    ComputerAppHub,
    "appStatus" | "attached" | "send" | "requireAgentAccess" | "withRunnerAdmission"
  >;
  readonly #definitions: readonly IntegrationDefinition[];
  readonly #store: IntegrationPlatformStore;
  readonly #localServers: Pick<LocalServerService, "availability" | "clients" | "endRun">;
  readonly #onDeploymentEvent: (event: AgentEvent) => void;
  readonly #onRequestsChanged: () => void;
  readonly #onSettingsChanged: (input: {
    installationId?: string;
    ownerUserId?: UserId;
  }) => Promise<void>;
  readonly #isRunnerConnected: (runnerId: RunnerId) => boolean;
  readonly #computerUse: ComputerUseGateway | null;
  readonly #onTabUsed: ((claims: RunToolScope, tabId: TabId, title: string) => void) | undefined;
  readonly #nativeTabs: Pick<NativeTabTargets, "acquired" | "captureMembership"> | undefined;
  readonly #tabs: Pick<TabServicePort, "get" | "authorizeShow"> | undefined;
  readonly #nativeTabTarget:
    ((ownerId: UserId, tabId: TabId) => Promise<NativeReplTabTarget>) | undefined;
  readonly computerRepl: ComputerReplService;
  readonly #computerToolEnabled: (
    context: RunCapabilityClaims<string>,
  ) => boolean | Promise<boolean>;
  readonly #computerUseVersion: (runnerId: RunnerId) => number | undefined;
  readonly #runFiles: RunFilePort | undefined;
  readonly #mcpImageContent: (context: EngineCapabilityQuery) => Promise<boolean>;
  /** Who may use which app on which Mac; this service only dispatches the calls. */
  readonly computerAppApprovals: ComputerAppApprovalService;

  constructor(options: {
    readonly listConnections: (
      ownerUserId: UserId,
    ) => Promise<readonly IntegrationConnectionSummary[]>;
    readonly computerApps: Pick<
      ComputerAppHub,
      | "appStatus"
      | "reportsApp"
      | "compatibilityReason"
      | "attached"
      | "machinesFor"
      | "send"
      | "requireAgentAccess"
      | "withRunnerAdmission"
    >;
    /**
     * Sessions for the one definition whose connections name an app's whole
     * interface. Absent leaves every `gui` tool row uncallable, which is what
     * a Host built without it should answer rather than pretending.
     */
    readonly computerUse?: ComputerUseGateway | null;
    readonly onTabUsed?: (claims: RunToolScope, tabId: TabId, title: string) => void;
    readonly nativeTabs?: Pick<NativeTabTargets, "acquired" | "captureMembership">;
    readonly tabs?: Pick<TabServicePort, "get" | "authorizeShow">;
    readonly nativeTabTarget?: (ownerId: UserId, tabId: TabId) => Promise<NativeReplTabTarget>;
    readonly computerToolEnabled?: (
      context: RunCapabilityClaims<string>,
    ) => boolean | Promise<boolean>;
    readonly computerUseVersion?: (runnerId: RunnerId) => number | undefined;
    readonly runFiles?: RunFilePort;
    readonly computerReplTime?: Pick<
      ConstructorParameters<typeof ComputerReplService>[0],
      "clock" | "wait"
    >;
    /**
     * Whether this Run's engine renders MCP image content blocks. An engine
     * that does not gets the tree and a sentence saying the picture is not
     * available here, rather than a block it would drop or choke on.
     */
    readonly mcpImageContent?: (context: EngineCapabilityQuery) => Promise<boolean>;
    readonly definitions: readonly IntegrationDefinition[];
    readonly localServers: Pick<
      LocalServerService,
      "availability" | "clients" | "discoverServer" | "endRun" | "secrets"
    >;
    readonly onDeploymentEvent: (event: AgentEvent) => void;
    readonly onConnectionsChanged: () => void;
    readonly onSettingsChanged?: (input: {
      installationId?: string;
      ownerUserId?: UserId;
    }) => Promise<void>;
    readonly onInputAccessWithdrawn?: (runnerId: RunnerId) => void;
    readonly onRequestsChanged: () => void;
    readonly isRunnerConnected: (runnerId: RunnerId) => boolean;
    readonly store: IntegrationPlatformStore;
  }) {
    this.#listConnections = options.listConnections;
    this.#computerApps = options.computerApps;
    this.#definitions = options.definitions;
    this.#localServers = options.localServers;
    this.#onDeploymentEvent = options.onDeploymentEvent;
    this.#onRequestsChanged = options.onRequestsChanged;
    this.#onSettingsChanged = options.onSettingsChanged ?? (async () => undefined);
    this.#isRunnerConnected = options.isRunnerConnected;
    this.#computerUse = options.computerUse ?? null;
    this.#nativeTabs = options.nativeTabs;
    this.#onTabUsed = options.onTabUsed;
    this.#tabs = options.tabs;
    this.#nativeTabTarget = options.nativeTabTarget;
    // Silence is not a declaration: an engine that has not said it renders MCP
    // image content is treated as one that does not, exactly as an older
    // Runner's unstated `steering` is treated as unsupported.
    this.#mcpImageContent = options.mcpImageContent ?? (async () => false);
    this.#store = options.store;
    this.#computerToolEnabled = options.computerToolEnabled ?? (() => false);
    this.#computerUseVersion = options.computerUseVersion ?? (() => undefined);
    this.#runFiles = options.runFiles;
    this.computerRepl = new ComputerReplService({
      ...options.computerReplTime,
      invoke: async () => {
        throw refused("conflict", "Computer code requires an authenticated execution.");
      },
    });
    const localServers = options.localServers;
    this.computerAppApprovals = new ComputerAppApprovalService({
      computerApps: options.computerApps,
      computerUse: this.#computerUse,
      definitions: this.#definitions,
      installCatalogDefinition: (input) => this.installDefinition(input),
      listCallableTools: (scope) => this.listCallableTools(scope),
      listConnections: this.#listConnections,
      localMcpSecrets: localServers.secrets,
      onConnectionsChanged: options.onConnectionsChanged,
      ...(options.onInputAccessWithdrawn
        ? { onInputAccessWithdrawn: options.onInputAccessWithdrawn }
        : {}),
      onLocalServerApproved: (approved) => {
        void localServers
          .discoverServer(approved.serverId)
          .catch((error: unknown) =>
            console.warn("An approved MCP server could not be started", error),
          );
      },
      publishRequestEvents: (events) => this.#publishRequestEvents(events),
      store: this.#store,
    });
  }

  get store(): IntegrationPlatformStore {
    return this.#store;
  }

  async listCallableTools(input: IntegrationRequester) {
    return this.#store.listCallableTools(input);
  }

  /** Every installation as this requester's agents see it, with what makes each unusable now. */
  async listDiscoveryInventory(input: IntegrationDiscoveryRequester) {
    return this.withAvailability(await this.#store.listDiscoveryInventory(input), input);
  }

  /**
   * An inventory as an agent should read it: each tool of an app, a phone or
   * a server a computer runs that is there but cannot be used now says why.
   */
  async withAvailability<Entry extends DiscoveryInventoryEntry>(
    inventory: readonly Entry[],
    input: { readonly ownerUserId: UserId },
  ): Promise<Entry[]> {
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
            const unavailable = await this.#localServers.availability(
              runnerId,
              entry.installation.title,
              () => computerName(runnerId),
            );
            if (unavailable === null) return readiness;
            return {
              ...readiness,
              code: "INTEGRATION_UNAVAILABLE" as const,
              detail: unavailable,
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

  async createGrant(input: CreateIntegrationGrantInput) {
    const create = () => this.#store.createGrant(input);
    if (!input.connectionId) return create();
    const computer = await this.#store.getComputerConnectionForCall({
      connectionId: input.connectionId,
      ownerUserId: input.ownerUserId,
    });
    return computer ? this.#computerApps.withRunnerAdmission(computer.runnerId, create) : create();
  }

  async revokeGrant(input: {
    readonly administration?: AdministrationCommandIdentity | undefined;
    readonly grantId: IntegrationGrant["id"];
    readonly ownerUserId: UserId;
    readonly requestId: string;
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
      // The task's session on that app, or on that phone, ran on this
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
        this.#computerUse?.closeForConnection(computer.runnerId, holding);
      }
    };
    await (computer ? this.#computerApps.withRunnerAdmission(computer.runnerId, revoke) : revoke());
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
    const placement = await this.#store.getComputerConnectionForCall({ connectionId, ownerUserId });
    if (!placement) throw new IntegrationAuthorizationRequiredError(callable);
    const admit = <Result>(
      send: (
        connection: NonNullable<typeof placement>,
        access: IntegrationAccess,
      ) => Promise<Result>,
    ) =>
      this.#computerApps.withRunnerAdmission(placement.runnerId, async () => {
        await this.#computerApps.requireAgentAccess(placement.runnerId);
        const [connection, authority] = await Promise.all([
          this.#store.getComputerConnectionForCall({ connectionId, ownerUserId }),
          this.#store.listCallableTools({ ownerUserId, threadId: caller.threadId }),
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
    return { definition, operation, ownerUserId, placement, admit };
  }

  /**
   * A bounded data tool of a computer app — Messages, Contacts, Calendar,
   * Reminders, or an iPhone's Location and Photos — called on its computer.
   */
  async callTool(
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
    const route = this.#runFileRoute(operation, args, caller, placement, signal);
    if (typeof route === "string")
      return { content: [{ type: "text", text: route }], isError: true };
    try {
      return await this.#finishComputerTool(
        await admit(async (connection, access) =>
          this.#computerApps.send({
            access,
            arguments: HostIntegrationsInvokeSchema.shape.arguments.parse(args),
            contract: computerAppOperationContract(operation),
            definitionId: definition.id,
            effect: operation.effect,
            ...(route ? { files: route.files } : {}),
            operation: operation.name,
            runnerId: connection.runnerId,
            ...(signal ? { signal } : {}),
          }),
        ),
        route,
        callable,
        operation,
        placement,
      );
    } finally {
      route?.close();
    }
  }

  /**
   * How this call's files reach its Run, a sentence saying why they cannot, or
   * undefined when none move. The Run's own Runner keeps them on that computer;
   * only a Run elsewhere sends bytes through the Host.
   */
  #runFileRoute(
    operation: ComputerAppOperation,
    args: Readonly<Record<string, unknown>>,
    caller: ToolCaller,
    placement: { readonly runnerId: RunnerId; readonly runnerName: string },
    signal: AbortSignal | undefined,
  ): RunFileRoute | string | undefined {
    const paths =
      operation.files === "send" && Array.isArray(args.files) ? args.files.map(String) : [];
    if (!operation.files || (operation.files === "send" && paths.length === 0)) return undefined;
    const run = caller.run;
    if (!run) return "Files move only inside a task. Delegate a task to do this.";
    const port = this.#runFiles;
    if (!port?.appFiles(placement.runnerId))
      return `Update Opensteer on ${placement.runnerName} to use ${operation.title}.`;
    if (!port.runFiles(run.runnerId))
      return "Update Opensteer on the computer running this task to move files.";
    const execution = { bindingGeneration: run.bindingGeneration, runId: run.runId };
    if (run.runnerId === placement.runnerId)
      return { close: () => undefined, files: { run: execution } };
    const relays = (operation.files === "send" ? paths : [""]).map(() => port.relay.open());
    const close = (failure?: Error) => relays.forEach((relay) => relay.close(failure));
    const stop = new AbortController();
    const onAbort = () => stop.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const peer = port.request(
      run.runnerId,
      operation.files === "send"
        ? {
            execution,
            files: paths.map((path, index) => ({ path, transfer: relays[index]!.upload })),
            type: "host.run-file.send",
          }
        : {
            execution,
            transfers: relays.map(({ download }) => download),
            type: "host.run-file.receive",
          },
      stop.signal,
    );
    // A refused path ends the Source Runner's wait at once, before anything is sent.
    const settled = peer.then(
      (result) => {
        if (!result.ok) close(new Error(result.message));
        return result;
      },
      (error: unknown) => {
        close(error instanceof Error ? error : undefined);
        throw error;
      },
    );
    settled.catch(() => undefined);
    return {
      close: (failure) => {
        close(failure);
        signal?.removeEventListener("abort", onAbort);
        stop.abort();
      },
      files: {
        transfers: relays.map((relay) =>
          operation.files === "send" ? relay.download : relay.upload,
        ),
      },
      peer: settled,
    };
  }

  async #finishComputerTool(
    sent: ComputerAppInvokeSend,
    route: RunFileRoute | undefined,
    callable: CallableIntegrationTool,
    operation: ComputerAppOperation,
    placement: ComputerPlacement,
  ): Promise<Awaited<ReturnType<Client["callTool"]>>> {
    const answer = await sent.outcome;
    if (answer.kind !== "ok") route?.close();
    const peer = route?.peer ? await route.peer.catch(() => null) : undefined;
    // A send keeps the app's answer unless the app definitely never sent: a transfer error
    // must never hide a send that may have happened.
    const peerDecides =
      operation.files === "export" || (answer.kind !== "ok" && answer.code !== "outcome-unknown");
    if (peerDecides && peer?.ok === false && peer.message)
      return { content: [{ type: "text", text: peer.message }], isError: true };
    const delivered = peer?.paths?.[0];
    if (answer.kind === "ok" && operation.files === "export" && peer !== undefined && !delivered)
      return {
        content: [{ type: "text", text: "The file did not reach this task. Try again." }],
        isError: true,
      };
    const outcome =
      answer.kind === "ok" && delivered
        ? { ...answer, value: { ...(answer.value as JsonObject), path: delivered } }
        : answer;
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
    beforeAcquired?: () => Promise<void>,
  ): Promise<ReplReply> {
    const run = caller.run;
    if (!run || !this.#computerUse)
      throw refused("forbidden", "Computer use requires a running task.");
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
          `${connection.runnerName} allows seeing only. Ask for read-write access to act: call app_access_request {computerId, access, reason} with access "read-write"; do not retry this call until it is fulfilled.`,
        );
      throw refused(
        "forbidden",
        row === "act"
          ? "This task does not have read-write access to this app or phone. Request read-write access before acting."
          : "This app or phone is no longer approved for this task. Call computer_apps for current access.",
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
    if (operation === "bind" && mac) {
      ComputerUseBindParamsSchema.parse(rawArgs);
    } else if (row !== "act" && operation !== "bind") {
      const [issue] = validateJsonSchema(catalogOperation.inputSchema, internalArgs);
      if (issue)
        throw refused(
          "bad_request",
          `Invalid ${operation} arguments at ${issue.path}: ${issue.message}`,
        );
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
      this.#onDeploymentEvent(started);
    };
    const membershipRevision =
      operation === "bind" ? await this.#nativeTabs?.captureMembership(ownerUserId) : undefined;
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
                  : computerUse.sendObserve(
                      lease!,
                      authorizedTarget,
                      operation !== "bind",
                      signal,
                      deadline,
                    ),
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
        if (event) this.#onDeploymentEvent(event);
      }
      const content: ReplContent[] = performed.map((text) => ({ type: "text", text }));
      if (result?.observation && operation !== "bind" && args.emit !== false) {
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
            ? result?.windows?.map(({ windowId, title }) => ({ windowId, title }))
            : operation === "bind"
              ? { window: result?.window }
              : mac && row === "act"
                ? { performed }
                : result;
      if (operation === "bind") {
        if (!this.#nativeTabs || run.aud !== "opensteer-run-tools")
          throw refused("conflict", "The tab service is unavailable.");
        signal?.throwIfAborted();
        await beforeAcquired?.();
        const runClaims: RunToolScope = { ...run, aud: "opensteer-run-tools" };
        const common = {
          ownerId: ownerUserId,
          runClaims,
          computerId: placement.runnerId,
          key: randomUUID(),
          membershipRevision: membershipRevision!,
        };
        const tabId = await this.#nativeTabs.acquired(
          mac
            ? {
                ...common,
                kind: "window",
                windowId: WindowIdSchema.parse(result?.window?.windowId),
              }
            : { ...common, kind: "phone" },
        );
        this.#onTabUsed?.(runClaims, tabId, result?.window?.title ?? placement.runnerName);
        return {
          value: z.json().parse(
            mac
              ? { window: result?.window, tabId }
              : {
                  tabId,
                  connectionId: target,
                  name: placement.runnerName,
                  computerId: placement.runnerId,
                },
          ),
          content,
        };
      }
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
          if (event) this.#onDeploymentEvent(event);
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
    if (!caller?.run) throw refused("conflict", "This computer context has ended.");
    if (request.operation === "tab") {
      if (!this.#tabs || !this.#nativeTabTarget || caller.run.aud !== "opensteer-run-tools")
        throw refused("not_found", "This tab is unavailable.");
      const claims: RunToolScope = { ...caller.run, aud: "opensteer-run-tools" };
      return bindNativeTab(
        {
          tabs: this.#tabs,
          lookup: this.#nativeTabTarget,
          connections: async () => {
            const rows = await this.listCallableTools({
              ownerUserId: claims.requestedBy,
              threadId: caller.threadId,
            });
            return (await this.#listConnections(claims.requestedBy)).filter((entry) =>
              rows.some(
                (row) => row.grant.connectionId === entry.id && row.tool.name === "observe",
              ),
            );
          },
          bind: (connection, target, beforeAcquired) =>
            this.callComputerOperation(
              caller,
              connection.id,
              "bind",
              target.kind === "window" ? { windowId: target.windowId } : {},
              request.signal,
              request.deadline,
              beforeAcquired,
            ),
        },
        claims,
        TabIdSchema.parse(request.target),
      );
    }
    if (request.operation === "apps" || request.operation === "phones") {
      const rows = await this.listCallableTools({
        ownerUserId: caller.run.requestedBy,
        threadId: caller.threadId,
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
              computerId: connection.runnerId,
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
      throw refused(
        "conflict",
        "Update Opensteer on the computer this task runs on to use computer_use.",
      );
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
    this.#localServers.endRun(runId);
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
      this.#onDeploymentEvent(event);
  }

  resetComputerGeneration(runId: RunId, generation: number): void {
    this.#replCallers.delete(`${runId}:${generation}`);
    this.#replTargets.delete(`${runId}:${generation}`);
    this.computerRepl.resetGeneration(runId, generation);
  }

  endComputerGeneration(runId: RunId, generation: number): void {
    this.#localServers.endRun(runId, generation);
    this.#replCallers.delete(`${runId}:${generation}`);
    this.#replTargets.delete(`${runId}:${generation}`);
    this.computerRepl.endGeneration(runId, generation);
  }

  /** Runs `task` admitted on every one of these computers, entered in one order. */
  async withRunnerAdmissions<Result>(
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
    for (const event of events) this.#onDeploymentEvent(event);
    if (events.length > 0) this.#onRequestsChanged();
  }

  /**
   * Fulfilling an access Request with a computer app's connection tells the
   * agent it may use it, so the connection has to be the app the Request
   * names, on a computer that allows what it asks.
   */
  async verifyConnectionForFulfillment(
    connectionId: IntegrationConnectionId,
    ownerUserId: UserId,
    request: {
      readonly access: IntegrationAccess;
      readonly installationId: IntegrationInstallationId;
      readonly requestedServerId: IntegrationServer["id"] | null;
    },
  ): Promise<void> {
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
  }

  /**
   * Runs `task` admitted on the computer a computer app's connection is on,
   * so it cannot cross a change to that computer's grant; a connection that
   * is no computer's runs it as it is.
   */
  async withConnectionAdmission<Result>(
    connectionId: IntegrationConnectionId,
    ownerUserId: UserId,
    task: () => Promise<Result>,
  ): Promise<Result> {
    const computer = await this.#store.getComputerConnectionForCall({ connectionId, ownerUserId });
    return computer ? this.#computerApps.withRunnerAdmission(computer.runnerId, task) : task();
  }

  /** Ends the sessions holding apps or phones an uninstall took back. */
  endSessionsForRemovedApps(removed: Parameters<typeof endComputerUseSessions>[2]): void {
    endComputerUseSessions(this.#computerUse, this.#definitions, removed);
  }

  /**
   * Reconciles each built-in installation of a computer app with the
   * definition this Host ships: one whose definition changed is stored again.
   */
  async ensureBuiltIns(input: {
    readonly actorUserId: UserId | null;
    readonly requestId: string;
  }): Promise<readonly IntegrationInstallation[]> {
    const installations: IntegrationInstallation[] = [];
    const definitionsById = new Map(
      this.#definitions.flatMap((definition) =>
        isComputerAppDefinition(definition) ? [[definition.id, definition] as const] : [],
      ),
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
      if (!definition) continue;
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
          await this.#materializeDefinition({
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

  /** Installs a computer app's definition from the catalog this Host ships, once. */
  async installDefinition(input: {
    readonly settlementSessionId?: string | undefined;
    readonly actorUserId: UserId;
    readonly definitionId: string;
    readonly digest: string;
    readonly requestId: string;
  }): Promise<IntegrationInstallation> {
    const found = this.#definitions.find((candidate) => candidate.id === input.definitionId);
    const definition = found && isComputerAppDefinition(found) ? found : undefined;
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
    return this.#materializeDefinition({
      settlementSessionId: input.settlementSessionId,
      actorUserId: input.actorUserId,
      ...(current ? { current } : {}),
      definition,
      requestId: input.requestId,
    });
  }

  async #materializeDefinition(input: {
    readonly settlementSessionId?: string | undefined;
    readonly actorUserId: UserId | null;
    readonly current?: IntegrationInstallation;
    readonly definition: ComputerAppDefinition;
    readonly requestId: string;
  }): Promise<IntegrationInstallation> {
    const prepared = this.prepareDefinition(input);
    const mutation = await this.#store.install({
      ...prepared,
      settlementSessionId: input.settlementSessionId,
      actorUserId: input.actorUserId,
      requestId: input.requestId,
    });
    await this.#onSettingsChanged({ installationId: mutation.installation.id });
    this.#publishRequestEvents(mutation.requestEvents);
    this.#localServers.clients.invalidateInstallation(mutation.installation.id);
    return mutation.installation;
  }

  /**
   * What installing a computer app's definition stores. Its tools belong to
   * each connection and are materialized by the store callback, never as
   * server-level authority.
   */
  prepareDefinition(input: {
    readonly current?: IntegrationInstallation;
    readonly definition: ComputerAppDefinition;
  }): PreparedIntegrationMaterial {
    const { definition } = input;
    const summary = integrationDefinitionSummary(definition);
    const digest = integrationDefinitionDigest(definition);
    return {
      computerConnectionTools: (connectionId: IntegrationConnectionId, access: IntegrationAccess) =>
        computerAppTools(definition, access, connectionId),
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
        status: "active",
        title: definition.name,
        trust: "built-in",
        version: digest,
      },
      servers: [
        {
          catalog: { definitions: {}, tools: [] },
          connectionRequirement: { definitionId: definition.id, kind: "computer" },
          id: createIntegrationId("server"),
          name: "default",
          status: "active",
          statusDetail: null,
          transport: { definitionId: definition.id, type: "computer" },
        },
      ],
    };
  }

  async close(): Promise<void> {
    await this.computerRepl.close();
    await Promise.allSettled(
      [...this.#computerOperationSettlements.values()].map((record) => record.done),
    );
  }
}

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
