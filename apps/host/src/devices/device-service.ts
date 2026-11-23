import {
  computerActionsUseClipboard,
  computerClipboardRefusal,
} from "../computer-use/computer-clipboard.js";
import { computerMachineProblem } from "./computer-use-discovery.js";
import { gatherComputerAccess } from "./computer-access.js";
import {
  deviceComputerApps,
  deviceComputerUse,
  type DeviceComputerAppsPort,
  type DeviceComputerUseGateway,
  type ComputerUseGateway as RoutedComputerUseGateway,
  type DeviceComputerScope,
  type DeviceComputerResult,
} from "./device-computer-gateway.js";
import {
  DeviceIntegrationConnectionReaderSchema,
  type IntegrationConnectionSummary as LegacyIntegrationConnectionSummary,
} from "@opensteer/integration-core";
import { isPhoneDisplayDefinitionId, type DeviceId } from "@opensteer/core";
import {
  AndroidPhoneNavigationSchema,
  PhoneDisplayActionTypeSchema,
  PhoneDisplayInstalledAppsParamsSchema,
  iphoneScreenDefinitionId,
  type PhoneDisplayDefinitionId,
} from "@opensteer/protocol";
import { randomUUID } from "node:crypto";

import { TabIdSchema, WindowIdSchema, type TabId } from "@opensteer/core";
import {
  AgentOperationTargetSchema,
  agentGrantAccess,
  AgentSessionIdSchema,
  OpensteerError,
  ToolBlockedError,
  refused,
  UserIdSchema,
  type AgentSessionId,
  type RunId,
  type RunnerId,
  type ThreadId,
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
import { integrationConnectionGrantTarget } from "@opensteer/database";
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
  DeviceIntegrationConnectionSummary as IntegrationConnectionSummary,
  IntegrationGrant,
  IntegrationInstallation,
  IntegrationReadiness,
  IntegrationServer,
} from "@opensteer/integration-core/models";
import {
  ComputerUseBindParamsSchema,
  HostIntegrationsInvokeSchema,
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
import {
  bindNativeTab,
  type ExistingNativeTab,
} from "../computer-use/computer-repl/native-tab-binding.js";
import type { NativeReplTabTarget, NativeTabTargets } from "../computer-use/native-tab-targets.js";
import {
  ComputerUseError,
  computerUseDefinitionId,
  type ComputerUseContext,
  type ComputerUseLease,
  type ComputerInventoryAuthority,
  type ComputerUseSessionAuthority,
} from "../computer-use/computer-use-service.js";
import { DeviceAccessRefusal } from "../administration/device-access.js";
import type { DeviceDriverIdentity } from "@opensteer/core";
import type { LocalServerService } from "../local-servers/local-server-service.js";
import { deviceAccessBlocked } from "./target-blocked.js";
import {
  localToolBlocked,
  sanitizeToolResult,
  type LocalToolResponse,
} from "../local-servers/mcp-clients.js";
import type { TabServicePort } from "../tabs/ports.js";
import {
  ComputerAppApprovalService,
  computerUseHoldingOf,
  endComputerUseSessions,
} from "./computer-app-approval-service.js";
import {
  computerObservationContent,
  iphoneScreenStatusContent,
} from "./computer-use-tool-result.js";
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
export type ComputerUseGateway = RoutedComputerUseGateway;

type ComputerPlacement = NonNullable<
  Awaited<ReturnType<IntegrationPlatformStore["getDeviceComputerConnectionForCall"]>>
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
/**
 * A connected agent's session driving the one app or phone screen its operation was admitted
 * for. Every callback stays on that target, and the session binding is its only authority.
 */
export interface ComputerSessionCaller {
  readonly ownerUserId: UserId;
  readonly sessionId: AgentSessionId;
  readonly taskId: ThreadId;
  readonly bindingId: `session:${string}`;
  /** The approval row (a Mac app, or a phone screen) the operation named. */
  readonly target: IntegrationConnectionId;
  readonly generation: string;
  readonly deviceId: DeviceId;
  readonly driver?: DeviceDriverIdentity;
  readonly readOnly: boolean;
  /** Re-admits the operation's session and target; called before every command. */
  readonly recheck: () => Promise<void>;
}

/**
 * An automation script driving approved apps or phone screens through `computer_use`.
 * Every callback re-checks the automation's live binding before sending a command.
 */
export interface ComputerProgramCaller {
  readonly ownerUserId: UserId;
  readonly threadId: ThreadId;
  readonly bindingId: string;
  readonly replKey: RunId;
  readonly recheck?: () => Promise<void>;
  readonly connectionWork?: true;
}

/** A computer call's caller: a Run, a connected agent's session, or an automation script. */
type ComputerCaller = ToolCaller & {
  readonly session?: ComputerSessionCaller;
  readonly program?: ComputerProgramCaller;
};

/**
 * The key a session's computer work is kept under in the REPL and the computer-use service: its
 * own id in the shape those keys take. It names no Run, and nothing reads authority from it.
 */
export function agentSessionComputerKey(sessionId: AgentSessionId): RunId {
  return `run_${sessionId.slice(sessionId.indexOf("_") + 1)}` as RunId;
}

/**
 * What ends with a connected agent's session (Stop, Disconnect, idle): its computer-use sessions,
 * which tell the Mac or phone to close, and its script context. Anything but a session binding is
 * left alone.
 */
export function endSessionComputerWork(
  bindingId: string,
  ports: {
    readonly computerUse: { closeForRun(runId: RunId): void } | undefined;
    readonly devices: Pick<DeviceService, "endComputerSession">;
    readonly onError: (error: unknown) => void;
  },
): void {
  const session = AgentSessionIdSchema.safeParse(bindingId.replace(/^session:/u, ""));
  if (!bindingId.startsWith("session:") || !session.success) return;
  ports.computerUse?.closeForRun(agentSessionComputerKey(session.data));
  void ports.devices.endComputerSession(session.data).catch(ports.onError);
}

function computerOwner(caller: ComputerCaller): UserId {
  if (caller.run) return caller.run.requestedBy;
  if (caller.session) return caller.session.ownerUserId;
  if (caller.program) return caller.program.ownerUserId;
  throw refused("conflict", "This computer context has ended.");
}

/** What a target that is not this session's reads as: nothing about whether it exists. */
function notThisSessionsTarget(): never {
  throw refused(
    "not_found",
    "No app or phone screen shared with this agent matches. Call discover for what you can use.",
  );
}

const computerObservations = new Set([
  "apps",
  "phones",
  "installedApps",
  "windows",
  "bind",
  "observe",
]);

function computerApprovalGeneration(
  driver: DeviceDriverIdentity | undefined,
  computer:
    | { readonly policyRevision: number | null; readonly access: IntegrationAccess }
    | null
    | undefined,
) {
  return (
    "approval:" +
    JSON.stringify([
      computer?.policyRevision ?? 0,
      computer?.access ?? null,
      driver?.runnerId ?? null,
      driver?.role ?? null,
      driver?.generation ?? null,
    ])
  );
}

export class DeviceService {
  readonly #listConnections: (
    ownerUserId: UserId,
  ) => Promise<readonly IntegrationConnectionSummary[]>;
  readonly #computerApps: Pick<
    ComputerAppHub,
    | "appStatus"
    | "attached"
    | "send"
    | "requireAgentAccess"
    | "withRunnerAdmission"
    | "withDeviceAdmission"
    | "withDeviceAdmissions"
    | "requireDeviceAgentAccess"
    | "deviceStatus"
  >;
  readonly #definitions: readonly IntegrationDefinition[];
  readonly #store: IntegrationPlatformStore;
  readonly #localServers: Pick<LocalServerService, "availability" | "clients" | "endRun">;
  readonly #onSettingsChanged: (input: {
    installationId?: string;
    ownerUserId?: UserId;
  }) => Promise<void>;
  readonly #isRunnerConnected: (runnerId: RunnerId) => boolean;
  readonly #computerUse: DeviceComputerUseGateway | null;
  readonly #deviceApps: DeviceComputerAppsPort;
  readonly #onDeviceTargetAcquired:
    ((target: import("../tabs/ports.js").DeviceNativeTargetAcquired) => Promise<TabId>) | undefined;
  readonly #onTabUsed: ((claims: RunToolScope, tabId: TabId, title: string) => void) | undefined;
  readonly #nativeTabs: Pick<NativeTabTargets, "acquired" | "captureMembership"> | undefined;
  readonly #tabs: Pick<TabServicePort, "get" | "authorizeBind"> | undefined;
  readonly #nativeTabTarget:
    ((ownerId: UserId, tabId: TabId) => Promise<NativeReplTabTarget>) | undefined;
  readonly computerRepl: ComputerReplService;
  readonly #computerDriver:
    ((deviceId: DeviceId, definitionId: string) => Promise<DeviceDriverIdentity>) | undefined;
  readonly #runnerSleeping: (runnerId: RunnerId) => boolean;
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
    ) => Promise<readonly (IntegrationConnectionSummary | LegacyIntegrationConnectionSummary)[]>;
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
      | "withDeviceAdmission"
      | "withDeviceAdmissions"
      | "requireDeviceAgentAccess"
      | "deviceStatus"
      | "agentSessionGuardsSupported"
      | "refuseOutdatedForAgentSession"
    >;
    /**
     * Sessions for the one definition whose connections name an app's whole
     * interface. Absent leaves every `gui` tool row uncallable, which is what
     * a Host built without it should answer rather than pretending.
     */
    readonly computerUse?: ComputerUseGateway | null;
    readonly deviceComputerUse?: DeviceComputerUseGateway;
    readonly deviceComputerApps?: DeviceComputerAppsPort;
    readonly onDeviceInputAccessWithdrawn?: (id: DeviceId) => void;
    readonly onDeviceTargetAcquired?: (
      target: import("../tabs/ports.js").DeviceNativeTargetAcquired,
    ) => Promise<TabId>;
    readonly onTabUsed?: (claims: RunToolScope, tabId: TabId, title: string) => void;
    readonly nativeTabs?: Pick<NativeTabTargets, "acquired" | "captureMembership">;
    readonly tabs?: Pick<TabServicePort, "get" | "authorizeBind">;
    readonly nativeTabTarget?: (ownerId: UserId, tabId: TabId) => Promise<NativeReplTabTarget>;
    readonly computerToolEnabled?: (
      context: RunCapabilityClaims<string>,
    ) => boolean | Promise<boolean>;
    readonly computerDriver?: (
      deviceId: DeviceId,
      definitionId: string,
    ) => Promise<DeviceDriverIdentity>;
    readonly runnerSleeping?: (runnerId: RunnerId) => boolean;
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
      "availability" | "clients" | "discoverServer" | "endRun" | "launchReview" | "secrets"
    >;
    readonly onConnectionsChanged: () => void;
    readonly onSettingsChanged?: (input: {
      installationId?: string;
      ownerUserId?: UserId;
    }) => Promise<void>;
    readonly onInputAccessWithdrawn?: (runnerId: RunnerId) => void;
    readonly isRunnerConnected: (runnerId: RunnerId) => boolean;
    readonly store: IntegrationPlatformStore;
  }) {
    this.#listConnections = async (owner) =>
      (await options.listConnections(owner)).map((row) =>
        DeviceIntegrationConnectionReaderSchema.parse(row),
      );
    this.#deviceApps = options.deviceComputerApps ?? deviceComputerApps(options.computerApps);
    this.#computerApps = options.computerApps;
    this.#definitions = options.definitions;
    this.#localServers = options.localServers;
    this.#onSettingsChanged = options.onSettingsChanged ?? (async () => undefined);
    this.#isRunnerConnected = options.isRunnerConnected;
    this.#computerUse =
      options.deviceComputerUse ??
      (options.computerUse ? deviceComputerUse(options.computerUse) : null);
    this.#onDeviceTargetAcquired = options.onDeviceTargetAcquired;
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
    this.#computerDriver = options.computerDriver;
    this.#runnerSleeping = options.runnerSleeping ?? (() => false);
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
      computerApps: this.#deviceApps,
      computerUse: this.#computerUse,
      definitions: this.#definitions,
      installCatalogDefinition: (input) => this.installDefinition(input),
      listCallableTools: (scope) => this.listCallableTools(scope),
      listConnections: this.#listConnections,
      localMcpSecrets: localServers.secrets,
      localServerReview: (serverId, launch) => localServers.launchReview(serverId, launch),
      onConnectionsChanged: options.onConnectionsChanged,
      onInputAccessWithdrawn:
        options.onDeviceInputAccessWithdrawn ??
        (async (id) => {
          const runner = await options.store.getDeviceSelfRunnerId(id);
          if (runner) options.onInputAccessWithdrawn?.(runner);
        }),
      onLocalServerApproved: (approved) => {
        void localServers
          .discoverServer(approved.serverId)
          .catch((error: unknown) =>
            console.warn("An approved MCP server could not be started", error),
          );
      },
      store: this.#store,
    });
  }

  deviceConnections(owner: UserId) {
    return this.#listConnections(owner);
  }

  get store(): IntegrationPlatformStore {
    return this.#store;
  }

  async localDeviceAccessBlocked(deviceId: DeviceId) {
    try {
      await this.#deviceApps.requireAgentAccess(deviceId);
    } catch (error) {
      const blocked = deviceAccessBlocked(error);
      if (!blocked) throw error;
      return blocked;
    }
    return undefined;
  }

  async listCallableTools(input: IntegrationRequester) {
    return this.#store.listCallableTools(input);
  }

  localDiscoveryFacts(ownerUserId: UserId) {
    const connections = new Map<
      IntegrationConnectionId,
      ReturnType<IntegrationPlatformStore["getDeviceComputerConnectionForCall"]>
    >();
    const connectionFor = (connectionId: IntegrationConnectionId) => {
      const pending = connections.get(connectionId);
      if (pending) return pending;
      const loaded = this.#store.getDeviceComputerConnectionForCall({
        connectionId,
        ownerUserId,
      });
      connections.set(connectionId, loaded);
      return loaded;
    };
    let servers: ReturnType<IntegrationPlatformStore["localMcp"]["list"]> | undefined;
    return { connectionFor, localServers: () => (servers ??= this.#store.localMcp.list()) };
  }

  /** Every installation as this requester's agents see it, with what makes each unusable now. */
  async listDiscoveryInventory(input: IntegrationDiscoveryRequester) {
    return this.withAvailability(await this.#store.listDiscoveryInventory(input), input);
  }

  /**
   * An inventory as an agent should read it: each tool of an app, a phone or
   * a server a computer runs that is there but cannot be used now says why.
   * With `offlineAtCall`, a device or computer that is only unreachable is
   * left to the call, which says it is offline; its tools stay listed.
   */
  async withAvailability<Entry extends DiscoveryInventoryEntry>(
    inventory: readonly Entry[],
    input: {
      readonly ownerUserId: UserId;
      readonly ownerView?: boolean;
      readonly offlineAtCall?: boolean;
      readonly connectionId?: string | undefined;
      readonly agentBindingId?: string | undefined;
    },
    facts = this.localDiscoveryFacts(input.ownerUserId),
  ): Promise<Entry[]> {
    const connectedAgent =
      input.connectionId !== undefined || input.agentBindingId?.startsWith("session:") === true;
    const { connectionFor, localServers } = facts;
    const computerName = async (runnerId: RunnerId) =>
      (await localServers()).find((server) => server.runnerId === runnerId)?.runnerName ??
      "its computer";
    const readRuntime = (deviceId: DeviceId, definitionId: string) =>
      Promise.all([
        this.#deviceApps.attached(deviceId),
        this.#targetConnected(deviceId),
        this.#deviceApps.appStatus(deviceId, definitionId),
      ]).then(([attached, runnerConnected, status]) => ({ attached, runnerConnected, status }));
    const runtime = new Map<string, ReturnType<typeof readRuntime>>();
    const appRuntime = (deviceId: DeviceId, definitionId: string) => {
      const key = `${deviceId}:${definitionId}`;
      const previous = runtime.get(key);
      if (previous) return previous;
      const loaded = readRuntime(deviceId, definitionId);
      runtime.set(key, loaded);
      return loaded;
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
          // The owner can fix a disconnected device before agents request access.
          // A task still sees its outstanding authorization requirement first.
          if (
            readiness.code !== "READY" &&
            !(
              input.ownerView &&
              readiness.code === "ACCESS_GRANT_REQUIRED" &&
              computerServers.has(readiness.serverId)
            )
          )
            return readiness;
          const runnerId = runnerServers.get(readiness.serverId);
          if (runnerId) {
            // A server a computer runs is unavailable here only while that computer is away.
            if (input.offlineAtCall) return readiness;
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
          const { status, attached, runnerConnected } = await appRuntime(
            connection.deviceId,
            definitionId,
          );
          const reachable = runnerConnected && attached;
          if (
            input.offlineAtCall &&
            !reachable &&
            !isPhoneDisplayDefinitionId(definitionId) &&
            !(connection.deviceProfile === "iphone" && connection.runnerUpdateRequired)
          )
            return readiness;
          const operationStatus =
            operation === undefined
              ? null
              : (status?.operations.find((candidate) => candidate.operation === operation) ?? null);
          const operationStatuses =
            operation === undefined ? (status?.operations ?? null) : operationStatus;
          const detail = isPhoneDisplayDefinitionId(definitionId)
            ? phoneAvailabilityDetail({
                attached,
                connection: connectedAgent,
                definitionId,
                availability:
                  (await this.#deviceApps.availability?.(connection.deviceId)) ?? undefined,
                phone: connection.runnerName,
                runnerConnected,
                status: operationStatuses,
              })
            : connection.deviceProfile === "iphone" && (!runnerConnected || !attached)
              ? connection.runnerUpdateRequired
                ? `Update Opensteer on ${connection.runnerName} to use its apps.`
                : runnerConnected
                  ? `Apps aren’t connected. Reopen Opensteer on ${connection.runnerName}.`
                  : `${connection.runnerName} is offline. Open Opensteer there, and update if prompted.`
              : computerAppAvailabilityDetail({
                  // A Computer use account is one app, which is what comes back.
                  app: connection.connection.computer?.app?.displayName ?? entry.installation.title,
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
            ...entry.readiness,
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
    if (!input.connectionId)
      return this.withDeviceAdmissions(
        await this.#store.listComputerDeviceIdsForInstallation(input.installationId),
        create,
      );
    const computer = await this.#store.getDeviceComputerConnectionForCall({
      connectionId: input.connectionId,
      ownerUserId: input.ownerUserId,
    });
    return computer ? this.#deviceApps.withAdmission(computer.deviceId, create) : create();
  }

  async revokeGrant(input: {
    readonly administration?: AdministrationCommandIdentity | undefined;
    readonly grantId: IntegrationGrant["id"];
    readonly ownerUserId: UserId;
    readonly requestId: string;
  }): Promise<void> {
    const grant = (await this.#store.listGrants(input)).find(({ id }) => id === input.grantId);
    const computer = grant?.connectionId
      ? await this.#store.getDeviceComputerConnectionForCall({
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
        await this.#computerUse?.closeForConnection(computer.deviceId, holding);
      }
    };
    const runners = computer
      ? [computer.deviceId]
      : grant
        ? await this.#store.listComputerDeviceIdsForInstallation(grant.installationId)
        : [];
    await this.withDeviceAdmissions(runners, revoke);
  }

  computerToolEnabled(context: RunCapabilityClaims<string>): boolean | Promise<boolean> {
    return this.#computerToolEnabled(context);
  }

  async computerUseVersion(deviceId: DeviceId): Promise<number | undefined> {
    const self = await this.#store.getDeviceSelfRunnerId(deviceId);
    return self ? this.#computerUseVersion(self) : undefined;
  }

  async #targetConnected(deviceId: DeviceId): Promise<boolean> {
    const self = await this.#store.getDeviceSelfRunnerId(deviceId);
    return self ? this.#isRunnerConnected(self) : this.#deviceApps.attached(deviceId);
  }

  /** The same catalog pin and fresh admission fence for every computer row. */
  async #computerAuthority(callable: CallableIntegrationTool, caller: ComputerCaller) {
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
    const placement = await this.#store.getDeviceComputerConnectionForCall({
      connectionId,
      ownerUserId,
    });
    if (!placement) throw new IntegrationAuthorizationRequiredError(callable);
    const admit = <Result>(
      send: (
        connection: NonNullable<typeof placement>,
        access: IntegrationAccess,
      ) => Promise<Result>,
    ) =>
      this.#deviceApps.withAdmission(placement.deviceId, async () => {
        const [connection, authority] = await Promise.all([
          this.#store.getDeviceComputerConnectionForCall({ connectionId, ownerUserId }),
          this.#store.listCallableTools(callerRequester(ownerUserId, caller)),
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
          connection.deviceId !== placement.deviceId ||
          connection.connection.definitionId !== definition.id ||
          connection.connection.computer?.deviceId !== connection.deviceId ||
          !accessCoversEffect(connection.access, operation.effect) ||
          !accessCoversEffect(current.grant.access, operation.effect)
        )
          throw new IntegrationAuthorizationRequiredError(callable);
        if (caller.session) await this.#assertSessionComputer(caller.session, connection);
        const blocked = await this.localDeviceAccessBlocked(connection.deviceId);
        if (blocked) throw new ToolBlockedError(blocked);
        if (
          definition.id === computerUseDefinitionId &&
          this.#computerUseVersion(
            await this.#store.requireDeviceSelfRunnerId(connection.deviceId),
          ) !== 2
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
  ): Promise<LocalToolResponse> {
    const transport = callable.server.transport;
    if (
      transport.type === "computer" &&
      (transport.definitionId === computerUseDefinitionId ||
        isPhoneDisplayDefinitionId(transport.definitionId))
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
    const route = this.#runFileRoute(
      operation,
      args,
      caller,
      {
        runnerId: await this.#store.requireDeviceSelfRunnerId(placement.deviceId),
        runnerName: placement.runnerName,
      },
      signal,
    );
    if (typeof route === "string")
      return { content: [{ type: "text", text: route }], isError: true };
    try {
      return await this.#finishComputerTool(
        await admit(async (connection, access) => {
          signal?.throwIfAborted();
          return this.#computerApps.send({
            ...(caller.authorize ? { authorize: caller.authorize } : {}),
            access,
            arguments: HostIntegrationsInvokeSchema.shape.arguments.parse(args),
            contract: computerAppOperationContract(operation),
            definitionId: definition.id,
            effect: operation.effect,
            ...(route ? { files: route.files } : {}),
            operation: operation.name,
            runnerId: await this.#store.requireDeviceSelfRunnerId(connection.deviceId),
            ...(signal ? { signal } : {}),
          });
        }),
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
  ): Promise<LocalToolResponse> {
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
                await this.#targetConnected(placement.deviceId),
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
        return {
          ...sanitizeToolResult(
            { content: [{ type: "text", text: message }], isError: true },
            null,
          ),
          [localToolBlocked]: {
            code: "outcome_unknown",
            message,
            next: "Check current state before repeating the write.",
          },
        };
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
    caller: ComputerCaller,
    target: IntegrationConnectionId,
    operation: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    deadline?: number,
    existingTab?: ExistingNativeTab,
    facts?: Awaited<ReturnType<DeviceService["computerAccess"]>>,
  ): Promise<ReplReply> {
    if ((!caller.run && !caller.session) || !this.#computerUse)
      throw refused("forbidden", "Computer use requires a running task.");
    try {
      return await this.#callComputerOperation(
        caller,
        target,
        operation,
        args,
        signal,
        deadline,
        existingTab,
        facts,
      );
    } catch (error) {
      if (
        !(error instanceof ComputerUseError) ||
        operation === "release" ||
        !["offline", "busy", "incompatible-version", "permission-required"].includes(error.code)
      )
        throw error;
      const access = await this.#computerAccessFor(caller);
      const phone = access.phones.find(
        (entry) => (entry.connectionId ?? entry.connection?.connectionId) === target,
      );
      // Preserve the live iPhone refusal instead of rewriting it from discovery.
      if (phone?.definitionId === iphoneScreenDefinitionId) throw error;
      const machine = access.machines.find((entry) =>
        entry.apps.some((app) => app.connectionId === target),
      );
      const app = machine?.apps.find((entry) => entry.connectionId === target);
      const state = phone
        ? access.phone(phone)
        : machine && app
          ? access.app(machine, { displayName: app.name, bundleId: app.bundleId })
          : undefined;
      const name = phone?.name ?? machine?.name;
      const fallback =
        name && error.code !== "busy"
          ? computerMachineProblem({
              name,
              state:
                error.code === "offline"
                  ? "offline"
                  : error.code === "permission-required"
                    ? "permission-required"
                    : "ready",
              ...(error.code === "incompatible-version" ? { computerUseVersion: null } : {}),
            })?.blocked
          : undefined;
      const problem =
        state?.blocked ??
        fallback ??
        (error.code === "busy"
          ? {
              code: "busy",
              message: error.message,
              next: "Other work can continue; try again when the computer is free.",
            }
          : undefined);
      if (!problem) throw error;
      throw Object.assign(
        new OpensteerError({
          code: "forbidden",
          reason: problem.code,
          message: problem.message,
          next: problem.next,
        }),
        {
          ...("performed" in error ? { performed: error.performed } : {}),
          ...("content" in error ? { content: error.content } : {}),
          ...("value" in error ? { value: error.value } : {}),
        },
      );
    }
  }
  async #callComputerOperation(
    caller: ComputerCaller,
    target: IntegrationConnectionId,
    operation: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    deadline?: number,
    existingTab?: ExistingNativeTab,
    facts?: Awaited<ReturnType<DeviceService["computerAccess"]>>,
  ): Promise<ReplReply> {
    const run = caller.run;
    if ((!run && !caller.session) || !this.#computerUse)
      throw refused("forbidden", "Computer use requires a running task.");
    const owner = computerOwner(caller);
    const authority = this.#computerUseAuthority(caller);
    const row =
      operation === "release"
        ? "release"
        : ["windows", "bind", "observe"].includes(operation)
          ? "observe"
          : "act";
    const tools = facts?.tools ?? (await this.listCallableTools(callerRequester(owner, caller)));
    const callable = tools.find(
      (candidate) =>
        candidate.grant.connectionId === target &&
        candidate.tool.name === row &&
        candidate.server.transport.type === "computer" &&
        (candidate.server.transport.definitionId === computerUseDefinitionId ||
          isPhoneDisplayDefinitionId(candidate.server.transport.definitionId)),
    );
    if (!callable) {
      const access = facts ?? (await this.#computerAccessFor(caller, tools));
      const phone = access.phones.find(
        (entry) => (entry.connectionId ?? entry.connection?.connectionId) === target,
      );
      const machine = access.machines.find((entry) =>
        entry.apps.some((app) => app.connectionId === target),
      );
      const app = machine?.apps.find((entry) => entry.connectionId === target);
      const state = phone
        ? access.phone(phone)
        : machine && app
          ? access.app(machine, { displayName: app.name, bundleId: app.bundleId })
          : undefined;
      if (operation !== "release" && state?.blocked)
        throw new OpensteerError({
          code: "forbidden",
          reason: state.blocked.code,
          message: state.blocked.message,
          next: state.blocked.next,
        });

      const connection =
        row === "act"
          ? await this.#store.getDeviceComputerConnectionForCall({
              connectionId: target,
              ownerUserId: owner,
            })
          : null;
      if (
        connection?.access === "read" &&
        isPhoneDisplayDefinitionId(connection.connection.definitionId)
      )
        throw new ComputerUseError(
          "failed",
          caller.session
            ? `${connection.runnerName} allows seeing only. The person can share it with read-write access under Connected agents; do not retry this call until they do.`
            : `${connection.runnerName} allows seeing only. Ask for read-write access to act: call app_access_request {computerId, access, reason} with access "read-write"; do not retry this call until it is fulfilled.`,
        );
      throw refused(
        "forbidden",
        row === "act"
          ? "This task does not have read-write access to this app or phone. Request read-write access before acting."
          : caller.session
            ? "This app or phone is no longer approved for this task. Call discover for current access."
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
    if (!(await this.#deviceApps.attached(placement.deviceId))) {
      await admit(async () => undefined);
      throw new ComputerUseError(
        "offline",
        mac
          ? computerAppTransportUnavailableDetail(
              placement.connection.computer?.app?.displayName ?? callable.installation.title,
              placement.runnerName,
              await this.#targetConnected(placement.deviceId),
            )
          : phoneAvailabilityDetail({
              attached: false,
              connection: !!caller.session,
              definitionId: isPhoneDisplayDefinitionId(definition.id) ? definition.id : undefined,
              availability:
                (await this.#deviceApps.availability?.(placement.deviceId)) ?? undefined,
              phone: placement.runnerName,
              runnerConnected: await this.#targetConnected(placement.deviceId),
              status: null,
            })!,
      );
    }
    // A read-only session lists and binds windows without launching an app; a Runner that
    // cannot read `noLaunch` would launch one, so it is refused before any frame.
    if (
      mac &&
      caller.session?.readOnly &&
      (operation === "windows" || operation === "bind") &&
      !(await this.#deviceApps.agentSessionGuardsSupported(placement.deviceId))
    ) {
      await admit(async () => undefined);
      throw new ComputerUseError(
        "incompatible-version",
        await this.#deviceApps.refuseOutdatedForAgentSession(
          placement.deviceId,
          "let a connected agent look at its apps without opening them",
        ),
      );
    }
    const rawArgs = { ...args };
    delete rawArgs.emit;
    // Refused before the action is sent: the Mac's clipboard is in no grant.
    if (
      row === "act" &&
      (caller.session || caller.connectionWork) &&
      computerActionsUseClipboard(rawArgs)
    )
      throw refused("forbidden", computerClipboardRefusal);
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
    let started:
      Awaited<ReturnType<IntegrationPlatformStore["computerOperations"]["start"]>> | undefined;
    let result: DeviceComputerResult | undefined;
    let released = false;
    let audit: Promise<readonly string[]> | undefined;
    let auditCompletion: Promise<void> | undefined;
    let finishOperation: ((error?: unknown) => void) | undefined;
    const start = async (connection: NonNullable<typeof placement>, scope: DeviceComputerScope) => {
      // A session's record is its own operation, which names the app and the Device.
      if (started || !run) return;
      const subject = {
        account: callable.grant.alias,
        computerApp:
          scope.kind === "app"
            ? {
                app: scope.app.displayName,
                bundleId: scope.app.bundleId,
                computer: connection.runnerName,
                runnerId: connection.deviceId,
              }
            : null,
        ...(scope.kind === "display"
          ? {
              phone: {
                computer: connection.runnerName,
                runnerId: connection.deviceId,
              },
            }
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
      const callId = started.toolCallId;
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
    };
    const membershipRevision =
      operation === "bind" && !existingTab
        ? await this.#nativeTabs?.captureMembership(ownerUserId)
        : undefined;
    try {
      if (operation !== "release")
        lease = await computerUse.prepare(
          { ownerUserId, deviceId: placement.deviceId, deviceName: placement.runnerName },
          authority,
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
      const iphone = scope.kind === "display" && scope.definitionId === iphoneScreenDefinitionId;
      if (operation === "release")
        released = await guarded(() => computerUse.releaseSession(authority, placement.deviceId));
      else if (iphone && operation === "bind") await guarded(async () => undefined);
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
                      caller.session?.readOnly && (operation === "windows" || operation === "bind")
                        ? { ...rawArgs, noLaunch: true }
                        : rawArgs,
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
          ? computerUseHeadline({
              appName,
              performed: stoppedBecause ? [] : null,
              stoppedBecause,
            })
          : computerUseActHeadline({
              performed: operation === "release" ? [`Released ${placement.runnerName}`] : performed,
              stoppedBecause,
            });
      if (started) {
        await this.#store.computerOperations.complete(started, {
          status: signal?.aborted ? "cancelled" : result?.error ? "failed" : "succeeded",
          headline,
          performed,
        });
      }
      const content: ReplContent[] = performed.map((text) => ({ type: "text", text }));
      if (result?.observation && operation !== "bind" && args.emit !== false) {
        // A connected agent reads results over MCP, which carries images.
        const renderImages = run
          ? await this.#mcpImageContent({ ownerUserId, runId: run.runId, threadId: run.threadId })
          : true;
        content.push(
          ...computerObservationContent(result.observation, renderImages, placement.runnerName),
        );
      } else if (result?.kind === "display" && result.status && args.emit !== false) {
        content.push(iphoneScreenStatusContent(result.status, placement.runnerName));
      }
      const toolResult =
        iphone && result?.kind === "display"
          ? {
              ...result,
              controls: await this.#replPhoneControls(placement.deviceId, iphoneScreenDefinitionId),
            }
          : result;
      if (result?.error)
        throw Object.assign(result.error, {
          performed,
          content,
          value: JSON.parse(JSON.stringify(toolResult)),
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
                : toolResult;
      // A connected agent's handle holds its own target; it opens no tab in the person's list.
      if (operation === "bind" && !run)
        return {
          value: z.json().parse(
            mac
              ? { window: result?.window }
              : {
                  connectionId: target,
                  name: placement.runnerName,
                  computerId: placement.deviceId,
                },
          ),
          content,
        };
      if (operation === "bind") {
        if (!run || run.aud !== "opensteer-run-tools")
          throw refused("conflict", "The tab service is unavailable.");
        signal?.throwIfAborted();
        const runClaims: RunToolScope = { ...run, aud: "opensteer-run-tools" };
        let tabId: TabId;
        if (existingTab) {
          await existingTab.authorize();
          tabId = existingTab.tabId;
        } else {
          if (!this.#nativeTabs || membershipRevision === undefined)
            throw refused("conflict", "The tab service is unavailable.");
          const common = {
            ownerId: ownerUserId,
            runClaims,
            computerId: placement.deviceId,
            key: randomUUID(),
            membershipRevision,
          };
          const targetAcquired = mac
            ? {
                ...common,
                kind: "window" as const,
                windowId: WindowIdSchema.parse(result?.window?.windowId),
              }
            : { ...common, kind: "phone" as const };
          tabId = this.#onDeviceTargetAcquired
            ? await this.#onDeviceTargetAcquired(targetAcquired)
            : await this.#nativeTabs.acquired({
                ...targetAcquired,
                computerId: await this.#store.requireDeviceSelfRunnerId(placement.deviceId),
              });
        }
        this.#onTabUsed?.(runClaims, tabId, result?.window?.title ?? placement.runnerName);
        return {
          value: z.json().parse(
            mac
              ? { window: result?.window, tabId }
              : {
                  tabId,
                  connectionId: target,
                  name: placement.runnerName,
                  computerId: placement.deviceId,
                },
          ),
          content,
        };
      }
      return { value: z.json().parse(JSON.parse(JSON.stringify(value))), content };
    } catch (caught) {
      const error =
        caught instanceof ComputerUseError && caught.code === "outcome-unknown"
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
          await this.#store.computerOperations.complete(record, {
            status: signal?.aborted ? "cancelled" : "failed",
            headline: computerUseActHeadline({
              performed,
              stoppedBecause: error instanceof Error ? error.message : "Computer operation failed",
            }),
            performed,
          });
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

  async computerAccess(
    input: IntegrationRequester & { readonly runId?: RunId; readonly direct?: true },
    run?: RunCapabilityClaims<string>,
    tools?: readonly CallableIntegrationTool[],
  ) {
    return gatherComputerAccess(this, input, run, tools);
  }

  /**
   * The one app or phone screen a connected agent names for `computer_use`, as its grant shows
   * it: an approval row the grant reaches, or nothing. What it cannot see reads exactly like what
   * does not exist. The generation is the approval's revision, so a changed approval is reviewed
   * again before the script runs.
   */
  async sessionComputerTarget(
    requester: { readonly ownerUserId: UserId; readonly connectionId: string },
    computerId: DeviceId,
    app: string | undefined,
  ) {
    const access = await this.computerAccess({ ...requester, direct: true });
    const needle = app?.toLowerCase();
    const connectionId =
      needle === undefined
        ? access.phones.find((entry) => entry.deviceId === computerId)?.connection?.connectionId
        : access.machines
            .find((entry) => entry.deviceId === computerId)
            ?.apps.find(
              (entry) =>
                entry.bundleId.toLowerCase() === needle || entry.name.toLowerCase() === needle,
            )?.connectionId;
    if (!connectionId) notThisSessionsTarget();
    const id = IntegrationConnectionIdSchema.parse(connectionId);
    const placement = await this.#store.getDeviceComputerConnectionForCall({
      connectionId: id,
      ownerUserId: requester.ownerUserId,
      includeRecordedAppName: app !== undefined,
    });
    if (!placement || placement.deviceId !== computerId) notThisSessionsTarget();
    const computer = placement.connection.computer;
    const grant = integrationConnectionGrantTarget({
      id,
      deviceId: placement.deviceId,
      computerApp: computer?.app ?? null,
      integrationDefinitionId: placement.connection.definitionId,
    });
    const currentGrant = await this.#store.requesterGrant(requester);
    if (grant.kind !== "computer-app" || !currentGrant || !agentGrantAccess(currentGrant, grant))
      notThisSessionsTarget();
    const driver = await this.#sessionDeviceDriver(placement, true);
    const bundleId = computer?.app?.bundleId;
    const recordedName = placement.recordedAppName
      ?.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
      .trim();
    const appName = recordedName
      ? Array.from(recordedName).slice(0, 60).join("").trimEnd()
      : undefined;
    const appTarget = bundleId && appName ? `${appName} (${bundleId})` : undefined;
    return {
      connectionId: id,
      deviceId: placement.deviceId,
      ...(driver ? { driver } : {}),
      access: placement.access,
      target: AgentOperationTargetSchema.parse({
        grant,
        name: appTarget && appTarget.length <= 255 ? appTarget : (bundleId ?? placement.runnerName),
        ...(computer?.app ? { untrustedTitle: computer.app.displayName } : {}),
        device: { id: placement.deviceId, name: placement.runnerName },
      }),
      generation: computerApprovalGeneration(driver, computer),
    };
  }

  async #sessionDeviceDriver(placement: ComputerPlacement, entry = false) {
    const blocked = await this.localDeviceAccessBlocked(placement.deviceId);
    if (blocked?.code === "computer_stopped") {
      if (entry) throw new ToolBlockedError(blocked);
      throw new DeviceAccessRefusal(
        "device-stopped",
        placement.deviceId,
        "apps",
        placement.runnerName,
      );
    }
    const definitionId = placement.connection.definitionId;
    const driver = definitionId
      ? await this.#computerDriver?.(placement.deviceId, definitionId)
      : undefined;
    if (driver && this.#runnerSleeping(driver.runnerId))
      throw new DeviceAccessRefusal(
        "device-asleep",
        placement.deviceId,
        "apps",
        placement.runnerName,
      );
    return driver;
  }

  async #assertSessionComputer(session: ComputerSessionCaller, placement?: ComputerPlacement) {
    const current =
      placement ??
      (await this.#store.getDeviceComputerConnectionForCall({
        connectionId: session.target,
        ownerUserId: session.ownerUserId,
      }));
    if (!current || current.runnerRevoked || current.deviceId !== session.deviceId)
      notThisSessionsTarget();
    const driver = await this.#sessionDeviceDriver(current);
    await session.recheck();
    if (session.generation !== computerApprovalGeneration(driver, current.connection.computer))
      throw refused(
        "conflict",
        "The person's approval or the device driver changed. Start a new operation.",
      );
    if (driver && this.#runnerSleeping(driver.runnerId))
      throw new DeviceAccessRefusal("device-asleep", current.deviceId, "apps", current.runnerName);
  }

  /** The access facts a computer call reads: the Run's, the session binding's, or the automation's. */
  #computerAccessFor(caller: ComputerCaller, tools?: readonly CallableIntegrationTool[]) {
    if (caller.run)
      return this.computerAccess(
        { ownerUserId: caller.run.requestedBy, threadId: caller.threadId },
        caller.run,
        tools,
      );
    if (caller.program)
      return this.computerAccess(
        {
          ownerUserId: caller.program.ownerUserId,
          agentBindingId: caller.program.bindingId,
          runId: caller.program.replKey,
        },
        undefined,
        tools,
      );
    const session = caller.session;
    if (!session) throw refused("conflict", "This computer context has ended.");
    return this.computerAccess(
      {
        ownerUserId: session.ownerUserId,
        agentBindingId: session.bindingId,
        runId: agentSessionComputerKey(session.sessionId),
      },
      undefined,
      tools,
    );
  }

  /** What the computer-use service checks a session against: the Run, session, or automation binding. */
  #computerUseAuthority(caller: ComputerCaller): ComputerUseContext {
    if (caller.run) return caller.run;
    if (caller.program) {
      const program = caller.program;
      const authority: ComputerUseSessionAuthority = {
        kind: "agent-session",
        runId: program.replKey,
        bindingGeneration: 0,
        threadId: program.threadId,
        assertDispatch: async () => {
          await program.recheck?.();
        },
        assertActive: async () => {
          await program.recheck?.();
          const tools = await this.listCallableTools({
            ownerUserId: program.ownerUserId,
            agentBindingId: program.bindingId,
          });
          if (!tools.some((tool) => tool.server.transport.type === "computer"))
            throw refused("forbidden", "This automation no longer has an app or phone.");
        },
      };
      return authority;
    }
    const session = caller.session;
    if (!session) throw refused("conflict", "This computer context has ended.");
    const authority: ComputerUseSessionAuthority = {
      kind: "agent-session",
      runId: agentSessionComputerKey(session.sessionId),
      bindingGeneration: 0,
      threadId: session.taskId,
      ...(session.driver ? { driver: session.driver } : {}),
      assertDispatch: () => this.#assertSessionComputer(session),
      // The resolver refuses an ended session; each callback checks its exact target itself.
      assertActive: async () => {
        const tools = await this.listCallableTools({
          ownerUserId: session.ownerUserId,
          agentBindingId: session.bindingId,
        });
        if (!tools.some((tool) => tool.server.transport.type === "computer"))
          throw refused("forbidden", "This connected agent no longer has an app or phone.");
      },
    };
    return authority;
  }

  async #invokeComputerRepl(
    caller: ComputerCaller,
    request: ComputerReplInvocation,
  ): Promise<ReplReply> {
    if (!caller?.run && !caller?.session && !caller?.program)
      throw refused("conflict", "This computer context has ended.");
    if (caller.program) {
      request.signal.throwIfAborted();
      await caller.program.recheck?.();
      request.signal.throwIfAborted();
    }
    const session = caller.session;
    // A session stays on its one target, and re-admits before each command it sends.
    if (session) {
      request.signal.throwIfAborted();
      await this.#assertSessionComputer(session);
      request.signal.throwIfAborted();
      if (session.readOnly && !computerObservations.has(request.operation))
        throw refused(
          "forbidden",
          "This script can only observe. Use a new operation to make changes.",
        );
      if (request.operation === "tab")
        throw refused(
          "not_found",
          "Use target for the shared app or phone (app() or phone()). See help().",
        );
      if (
        request.operation !== "apps" &&
        request.operation !== "phones" &&
        request.target !== session.target
      )
        notThisSessionsTarget();
    }
    if (request.operation === "tab") {
      if (
        !this.#tabs ||
        !this.#nativeTabTarget ||
        !caller.run ||
        caller.run.aud !== "opensteer-run-tools"
      )
        throw refused("not_found", "This tab is unavailable.");
      const claims: RunToolScope = { ...caller.run, aud: "opensteer-run-tools" };
      let facts: ReturnType<DeviceService["computerAccess"]> | undefined;
      const computerAccess = () =>
        (facts ??= this.computerAccess(
          { ownerUserId: claims.requestedBy, threadId: caller.threadId },
          claims,
        ));
      return bindNativeTab(
        {
          tabs: this.#tabs,
          selfDeviceId: (runnerId) => this.#store.requireSelfDeviceId(runnerId),
          lookup: this.#nativeTabTarget,
          connections: () => this.#listConnections(claims.requestedBy),
          blocked: async (target) => {
            const access = await computerAccess();
            if (target.kind === "phone") {
              const phone = access.phones.find((entry) => entry.deviceId === target.computerId);
              return phone ? access.phone(phone).blocked : undefined;
            }
            const machine = access.machines.find((entry) => entry.deviceId === target.computerId);
            return machine && target.kind === "window"
              ? access.app(machine, target.app).blocked
              : undefined;
          },
          bind: async (connection, target, existingTab) =>
            this.callComputerOperation(
              caller,
              connection.id,
              "bind",
              target.kind === "window" ? { windowId: target.windowId } : {},
              request.signal,
              request.deadline,
              existingTab,
              await computerAccess(),
            ),
        },
        claims,
        TabIdSchema.parse(request.target),
      );
    }
    if (request.operation === "apps" || request.operation === "phones") {
      const access = await this.#computerAccessFor(caller);
      const usable =
        request.operation === "phones"
          ? await Promise.all(
              access.phones.map(async (phone) => ({
                id: phone.connection?.connectionId ?? null,
                name: phone.name,
                computer: phone.name,
                computerId: phone.deviceId,
                ...(await this.#replPhoneControls(
                  phone.deviceId,
                  phone.definitionId === "iphone-screen" ? "iphone-screen" : "android-phone",
                )),
                ...access.phone(phone),
              })),
            )
          : access.machines.flatMap((machine) =>
              access.appEntries(machine).map((entry) => ({
                ...entry,
                computer: machine.name,
                computerId: machine.deviceId,
              })),
            );
      const key = `${request.context.runId}:${request.context.generation}`;
      const targets = this.#replTargets.get(key) ?? new Set<string>();
      for (const entry of usable) if (entry.id && entry.access) targets.add(entry.id);
      this.#replTargets.set(key, targets);
      // A session sees only its own target: nothing about the rest, not even how many.
      return { value: session ? usable.filter((entry) => entry.id === session.target) : usable };
    }
    if (request.operation === "installedApps") {
      const owner = computerOwner(caller);
      const connectionId = IntegrationConnectionIdSchema.parse(request.target);
      const row = (await this.listCallableTools(callerRequester(owner, caller))).find(
        (candidate) =>
          candidate.grant.connectionId === connectionId &&
          candidate.tool.name === "observe" &&
          candidate.server.transport.type === "computer" &&
          isPhoneDisplayDefinitionId(candidate.server.transport.definitionId),
      );
      const connection = row
        ? await this.#store.getDeviceComputerConnectionForCall({ connectionId, ownerUserId: owner })
        : null;
      if (
        !row ||
        row.server.transport.type !== "computer" ||
        !isPhoneDisplayDefinitionId(row.server.transport.definitionId) ||
        !connection ||
        connection.runnerRevoked
      )
        throw refused(
          "forbidden",
          caller.session
            ? "This phone is no longer approved for this task. Call discover for current access."
            : "This phone is no longer approved for this task. Call computer_apps for current access.",
        );
      const { phones } = await this.computerAppApprovals.computerUseInventory(owner);
      const installed = await this.computerAppApprovals.installedComputerApps(
        {
          ...PhoneDisplayInstalledAppsParamsSchema.parse(request.args),
          actorUserId: owner,
          deviceId: connection.deviceId,
          definitionId: row.server.transport.definitionId,
        },
        phones,
        session
          ? this.#sessionInventoryAuthority(
              connection.deviceId,
              session,
              request.signal,
              session.driver,
              session,
            )
          : undefined,
      );
      return { value: z.json().parse(installed) };
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

  async runSessionInventory<Result>(
    deviceId: DeviceId,
    caller: Pick<ComputerSessionCaller, "recheck" | "ownerUserId" | "bindingId">,
    signal: AbortSignal,
    session: ComputerSessionCaller | undefined,
    read: (authority: ComputerInventoryAuthority) => Promise<Result>,
  ): Promise<Result> {
    const blocked = await this.localDeviceAccessBlocked(deviceId);
    if (blocked) throw new ToolBlockedError(blocked);
    const driver =
      session?.driver ??
      (!session ? await this.#computerDriver?.(deviceId, computerUseDefinitionId) : undefined);
    const work = this.#beginConnectedComputerWork(deviceId, driver, signal);
    try {
      work.signal.throwIfAborted();
      const result = await read(
        this.#sessionInventoryAuthority(deviceId, caller, work.signal, driver, session),
      );
      work.signal.throwIfAborted();
      return result;
    } catch (error) {
      work.sleep.throwIfAborted();
      throw error;
    } finally {
      work.close();
    }
  }

  #sessionInventoryAuthority(
    deviceId: DeviceId,
    caller: Pick<ComputerSessionCaller, "recheck" | "ownerUserId" | "bindingId">,
    signal: AbortSignal,
    driver: DeviceDriverIdentity | undefined,
    session: ComputerSessionCaller | undefined,
  ): ComputerInventoryAuthority {
    return {
      signal,
      ...(driver ? { driver } : {}),
      admit: (send) => this.#deviceApps.withAdmission(deviceId, send),
      assertCurrent: async () => {
        signal.throwIfAborted();
        if (session) {
          await this.#assertSessionComputer(session);
        } else {
          const grant = await this.#store.requesterGrant({
            ownerUserId: caller.ownerUserId,
            agentBindingId: caller.bindingId,
          });
          if (grant?.scope !== "everything") notThisSessionsTarget();
          const blocked = await this.localDeviceAccessBlocked(deviceId);
          if (blocked) throw new ToolBlockedError(blocked);
          await caller.recheck();
        }
        await this.#deviceApps.requireAgentAccess(deviceId);
        signal.throwIfAborted();
      },
    };
  }

  /** What a phone handle may send, as the Host enforces it at dispatch. */
  async #replPhoneControls(deviceId: DeviceId, definitionId: PhoneDisplayDefinitionId) {
    if (definitionId === iphoneScreenDefinitionId) {
      const status = this.#computerApps.deviceStatus(deviceId);
      const input = status?.operations.some(
        ({ operation, state }) => operation === "act" && state === "ready",
      );
      return {
        definitionId,
        platform: "ios",
        navigation: status?.navigationButtons.map(({ id }) => id) ?? [],
        actions: (status?.actions ?? []).filter(
          (action) =>
            (action !== "wake" || status?.wake === true) &&
            (input || action === "wait" || action === "wake"),
        ),
      };
    }
    return {
      definitionId,
      platform: "android",
      navigation: AndroidPhoneNavigationSchema.options,
      actions: PhoneDisplayActionTypeSchema.options,
    };
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

  /**
   * A connected agent's `computer_use` script, kept to the one app or phone screen its operation
   * was admitted for. Its handles last for the session, and its signal is the operation's: Stop
   * or Disconnect ends the script in flight.
   */
  readonly #connectedComputerWork = new Map<AbortController, DeviceDriverIdentity>();

  runnerSleeping(runnerId: RunnerId): void {
    for (const [controller, driver] of this.#connectedComputerWork)
      if (driver.runnerId === runnerId)
        controller.abort(new DeviceAccessRefusal("device-asleep", driver.deviceId, "apps"));
  }

  #beginConnectedComputerWork(
    deviceId: DeviceId,
    driver: DeviceDriverIdentity | undefined,
    signal: AbortSignal,
  ) {
    const sleep = new AbortController();
    if (driver) {
      this.#connectedComputerWork.set(sleep, driver);
      if (this.#runnerSleeping(driver.runnerId))
        sleep.abort(new DeviceAccessRefusal("device-asleep", deviceId, "apps"));
    }
    return {
      signal: AbortSignal.any([signal, sleep.signal]),
      sleep: sleep.signal,
      close: () => this.#connectedComputerWork.delete(sleep),
    };
  }

  async runProgramComputerCode(program: ComputerProgramCaller, code: string, signal: AbortSignal) {
    await program.recheck?.();
    const caller: ComputerCaller = {
      run: null,
      threadId: program.threadId,
      agentBindingId: program.bindingId,
      ...(program.connectionWork ? { connectionWork: true as const } : {}),
      program,
    };
    this.#replCallers.set(`${program.replKey}:0`, caller);
    return this.computerRepl.execute(
      { runId: program.replKey, generation: 0, reportUnknownEffects: true },
      code,
      signal,
      (request) => this.#invokeComputerRepl(caller, request),
    );
  }

  async runSessionComputerCode(session: ComputerSessionCaller, code: string, signal: AbortSignal) {
    await this.#assertSessionComputer(session);
    const key = agentSessionComputerKey(session.sessionId);
    const caller: ComputerCaller = {
      run: null,
      threadId: session.taskId,
      agentBindingId: session.bindingId,
      session,
    };
    this.#replCallers.set(`${key}:0`, caller);
    const work = this.#beginConnectedComputerWork(session.deviceId, session.driver, signal);
    try {
      const result = await this.computerRepl.execute(
        { runId: key, generation: 0, reportUnknownEffects: true },
        code,
        work.signal,
        (request) => this.#invokeComputerRepl(caller, request),
      );
      if (result.structuredContent?.error?.code !== "outcome-unknown") work.sleep.throwIfAborted();
      return result;
    } finally {
      work.close();
    }
  }

  /** A session ended (Stop, Disconnect, idle): its script context goes with it. */
  async endComputerSession(sessionId: AgentSessionId): Promise<void> {
    const key = agentSessionComputerKey(sessionId);
    this.#replCallers.delete(`${key}:0`);
    this.#replTargets.delete(`${key}:0`);
    await this.computerRepl.endRun(key);
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
    await this.#store.computerOperations.finalize(runId);
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
  withDeviceAdmissions<Result>(
    deviceIds: readonly DeviceId[],
    task: () => Promise<Result>,
  ): Promise<Result> {
    return this.#deviceApps.withAdmissions(deviceIds, task);
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
    const connection = await this.#store.getDeviceComputerConnectionForCall({
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
    const computer = await this.#store.getDeviceComputerConnectionForCall({
      connectionId,
      ownerUserId,
    });
    return computer ? this.#deviceApps.withAdmission(computer.deviceId, task) : task();
  }

  /** Ends the sessions holding apps or phones an uninstall took back. */
  endSessionsForRemovedApps(removed: Parameters<typeof endComputerUseSessions>[2]): Promise<void> {
    return endComputerUseSessions(this.#computerUse, this.#definitions, removed);
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
): DeviceComputerScope | null {
  if (computerAppNamesApp(definition.config)) return app ? { app, kind: "app" } : null;
  if (!isPhoneDisplayDefinitionId(definition.id) || app !== null) return null;
  return { definitionId: definition.id, kind: "display" };
}

/** A tool caller's exact execution, by the binding it was admitted under; never its task. */
function callerRequester(
  ownerUserId: UserId,
  caller: { readonly agentBindingId: string },
): IntegrationRequester {
  return { ownerUserId, agentBindingId: caller.agentBindingId };
}
