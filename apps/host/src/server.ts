import { CompleteProfileInitializationSchema } from "@opensteer/protocol";
import { bootstrapDiagnosticHeader } from "@opensteer/shared/bootstrapDiagnostics";
import { createVoiceHandlers } from "./voice/voice-handlers.js";
import { browserProfileCheckpointHeader } from "@opensteer/protocol";
import { runnerAuxiliaryWelcome } from "./server/runner-auxiliary-welcome.js";
import { searchSuggestions } from "./browser/search-suggestions.js";
import type { BrowserTabGroupService } from "./browser/browser-tab-group-service.js";
import { AgentPhoneUpdateHub } from "./agent-phone/update-hub.js";
import {
  agentPhoneVersionCode,
  type AgentPhoneUpdateRelease,
} from "./agent-phone/update-release.js";
/**
 * The Host's composition root, and only that.
 *
 * Three things live here and nothing else belongs:
 *
 *  1. Dependency wiring — `HostServerDependencies` names every collaborator the
 *     Host needs, and `createHostServer` is the single place they are assembled
 *     into a Fastify instance. Subsystems are constructed by their own modules.
 *  2. Machine-protocol REST — enrollment, session exchange, personal remote
 *     access, local bootstrap, static distribution, and the `/internal/v1/*`
 *     surfaces the Runner and its module streams speak. These are wire
 *     protocols for other programs, not a second way to add web endpoints:
 *     everything the browser needs goes through the rpc group registered by
 *     `server/host-api-registration.ts`, whose one declaration in
 *     `packages/protocol/src/host-api.ts` derives the handlers, the typed
 *     client, and the mock together.
 *  3. Core command dispatch — the `commands.dispatch` union members that belong
 *     to no narrower subsystem; the rest are delegated to the per-subsystem
 *     `handle*Command` functions this file composes.
 *
 * A new browser-facing capability is a new rpc member, not a route added below.
 */
import type { ComputerViewService } from "./computer-use/computer-view-service.js";

import type { PlaceContextService } from "./computer-use/place-context-service.js";
import { randomUUID } from "node:crypto";
import { AttachmentIdSchema, type AgentEvent, isPlaceContentPart } from "@opensteer/core";
import { Readable } from "node:stream";
import websocket from "@fastify/websocket";
import {
  BrowserProfileIdSchema,
  EnvironmentIdSchema,
  HarnessInstanceIdSchema,
  OpensteerError,
  CHAT_THREAD_TITLE,
  DEFAULT_THREAD_ACCESS_MODE,
  RunnerIdSchema,
  TriggerRevisionIdSchema,
  WorkspaceIdSchema,
  deploymentSupportsSharing,
  harnessDriverLabel,
  unsupportedVersionReason,
  workspaceWakesOnDemand,
  type EnvironmentId,
  type DeploymentDisplayKind,
  type ExecutionEnvironmentKind,
  type HarnessInstanceId,
  type HarnessInstanceStateKind,
  type HarnessId,
  type RunnerId,
  type AuthenticatedSession,
  type ThreadAccessMode,
  type UserId,
  type Workspace,
  type WorkspaceId,
  type ModelSelection,
} from "@opensteer/core";
import {
  BrowserProfileSnapshotSchema,
  maxBrowserProfileSnapshotBytes,
} from "@opensteer/browser-profile/snapshot";
import {
  machineIsManagedBy,
  personalRemoteAccessRefusedReason,
  personalRemoteAccessRequiredRefusal,
  runnerIdentityRevokedReason,
  type HarnessInstanceRecord,
  type MachineOwnershipRecord,
  type OpensteerStore,
  type WorkspaceInvitationRecord,
} from "@opensteer/database";
import {
  RevokeConnectRequestSchema,
  RevokeConnectResponseSchema,
} from "@opensteer/control-plane-protocol";
import {
  HostDescriptorSchema,
  hostApiVersion,
  hostDiscoveryDefaultWorkspaceBacking,
  type HostBootstrapMethod,
  type HostCapability,
  type HostDiscoveryEnvelope,
} from "@opensteer/deployment-authority";
import {
  clientMacOwnerViewVersion,
  ConfigurePersonalRemoteAccessRequestSchema,
  ApprovePersonalHostAccountLinkRequestSchema,
  ConsumePersonalHostAccountLinkRequestSchema,
  PublishPersonalConnectProjectionRequestSchema,
  PersonalHostAccountUnlinkStepRequestSchema,
} from "@opensteer/protocol";
import {
  MessagingRelayToHostMessageSchema,
  HostToMessagingRelayMessageSchema,
  type HostToMessagingRelayMessage,
  type MessagingRelayToHostMessage,
  type RuntimeChannelRequest,
} from "@opensteer/channel-protocol";
import { isRetryableHarnessCatalogStatus } from "@opensteer/harness";
import { BoundedAsyncInbox } from "@opensteer/shared/boundedAsyncInbox";
import { parseHttpEndpointBaseUrl } from "@opensteer/shared/httpEndpoint";
import {
  AgentPhoneHostTargetSchema,
  HostToIntegrationsModuleMessageSchema,
  IntegrationsModuleEventSchema,
  RunnerAuxiliaryAuthenticateSchema,
  RunnerAuxiliaryHeartbeatSchema,
  RunnerAuxiliaryModuleSchema,
  RunnerModuleNameSchema,
  computerAppMaxFrameBytes,
  type AgentPhoneHostTarget,
  type HostToIntegrationsModuleMessage,
  type IntegrationsModuleEvent,
  type ComputerUseSessionSummary,
  type MachineAppStatus,
  type MachineModuleSummary,
  type RunnerAuxiliaryChallenge,
  type RunnerAuxiliaryFrameFence,
  type RunnerAuxiliaryModule,
  type RunnerModuleName,
} from "@opensteer/protocol";
import {
  BrowserRelayFrameError,
  browserRelayFrameFence,
  decodeBrowserRelayFrame,
  maxBrowserRelayEnvelopeBytes,
  type HostToBrowserRelayMessage,
} from "@opensteer/protocol/browser-relay";
import {
  interactiveRunnerRequestTimeoutMs,
  runnerIdentityRevokedCloseCode,
  runnerIdentityRevokedMessage,
  type CommandService,
  type LiveRunRegistry,
  type RealtimeHub,
  type RealtimeSink,
  type RunnerIdentity,
  type RunnerPeer,
  type RunnerRegistry,
} from "@opensteer/orchestration";
import {
  BrowserSessionIdSchema,
  ClientToHostMessageSchema,
  RunnerToHostMessageSchema,
  RunnerWireProofSchema,
  agentPhoneOutdatedReason,
  WorkspaceFileKeySchema,
  HostBootstrapSchema,
  HarnessModelSettingsMapSchema,
  hostApi,
  rpcSuccess,
  type HostApiHandlers,
  type HostApiServerContext,
  type HostBootstrapHarness,
  workspaceDirectoryPageDefaultEntries,
  eventPageMaxItems,
  threadPageMaxItems,
  workspacePageMaxItems,
  workspaceViewFromWorkspace,
  agentToolPayloadMaxSerializedBytes,
  type HarnessAuthenticationState,
  type HostToClientMessage,
  HostToClientMessageSchema,
  type HostToRunnerMessage,
  ShellModuleToHostMessageSchema,
  HostToShellModuleMessageSchema,
  unsupportedVersionCloseCode,
  browserViewerCloseCodes,
  type HarnessInstanceCatalog,
  type HarnessModelDescriptor,
  type HarnessSourceDescriptor,
  type HostToShellModuleMessage,
  type ShellModuleEvent,
  type WorkspaceView,
} from "@opensteer/protocol";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type WebSocket from "ws";
import type { RawData } from "ws";
import { rawDataBuffer } from "@opensteer/shared/webSocketFrame";
import { z } from "zod";
import type { MachineFullDiskAccessService } from "./shell/machine-full-disk-access-service.js";
import type { AgentControlService } from "./agents/agent-control-service.js";
import type { AgentToolsMcpService } from "./agents/agent-tools-mcp-service.js";
import { HostAuthenticator } from "./identity/auth.js";
import {
  type BrowserConsumerPeer,
  type BrowserService,
  type BrowserConsumerAttachment,
} from "./browser/browser-service.js";
import { createChannelRpcHandlers } from "./channels/channel-handlers.js";
import type { ChannelService } from "./channels/channel-service.js";

import type { CredentialService } from "./identity/credential-service.js";
import type { MessagingRelayHub, MessagingRelayPeer } from "./channels/messaging-relay-hub.js";
import type {
  RunnerAuxiliaryPeer,
  RunnerAuxiliaryStream,
  RunnerStreamLossReason,
} from "@opensteer/orchestration";
import type {
  BrowserRelayEvent,
  RunnerBrowserHub,
  RunnerBrowserPeer,
} from "./browser/runner-browser-hub.js";
import {
  BrowserRuntimeRelayToHostMessageSchema,
  HostToBrowserRuntimeRelayMessageSchema,
} from "./browser/runner-browser-runtime.js";
import type { ComputerAppControlPeer, ComputerAppHub } from "./computer-apps/computer-app-hub.js";
import { registerComputerUseDisplayRoutes } from "./computer-use/computer-use-display-routes.js";
import type { DisplayStreamHub } from "./computer-use/display-stream-hub.js";
import type { ComputerUseService } from "./computer-use/computer-use-service.js";
import { sendComputerAppFrame } from "./computer-apps/computer-app-frame-send.js";
import { notifyMachinesChanged } from "./shell/machine-access-events.js";
import type { ShellControlPeer, ShellControlStreamHandler } from "./shell/shell-control-stream.js";
import { registerShellRoutes } from "./shell/shell-routes.js";
import type { EgressService } from "./server/egress-service.js";
import {
  harnessInspectionDefinition,
  HarnessCatalogReconciliationOwner,
  inspectAndRecordHarnessCatalogs,
} from "./agents/harness-catalogs.js";
import type { HarnessAuthenticationCoordinator } from "./identity/harness-authentication-coordinator.js";
import type { LocalBootstrapService } from "./runtime/local-bootstrap.js";
import {
  projectMachines,
  type MachineAccessView,
  type MachineProjectionInput,
} from "./runtime/machines.js";
import type { MountExchangeService } from "./identity/mount-exchange.js";
import type { RunnerAuthenticator } from "./agents/runner-authenticator.js";
import type { SecurityEffectService } from "./agents/security-effect-service.js";
import {
  matchModelSelection,
  modelOptionUnavailableMessage,
  storedModelSelection,
} from "./agents/model-selection.js";
import type { WorkspaceDeletionService } from "./workspace/workspace-deletion-service.js";
import type { WorkspaceService } from "./workspace/workspace-service.js";
import type { WorkspaceActivityService } from "./workspace/workspace-activity.js";
import {
  sealRequestResponse,
  type RequestResponseVault,
} from "./identity/request-response-vault.js";
import {
  installWebSocketLiveness,
  scheduleWebSocketExpiration,
} from "./server/websocket-liveness.js";
import type { WorkspaceFilesService } from "./workspace/files/workspace-files-service.js";
import type { WorkspaceWakeService } from "./workspace/workspace-wake-service.js";
import {
  createIdentityRpcHandlers,
  registerIdentityRoutes,
  requireInstanceAdministrator,
} from "./identity/identity-routes.js";
import {
  createIntegrationRpcHandlers,
  registerIntegrationRoutes,
  type IntegrationRpcOptions,
} from "./integrations/integration-routes.js";
import {
  createIntegrationAuthorizationRpcHandlers,
  registerIntegrationAuthorizationRoutes,
  type IntegrationAuthorizationRpcOptions,
} from "./integrations/integration-authorization-routes.js";
import type { IntegrationAuthAttemptLifecycle } from "./integrations/integration-auth-attempt-service.js";
import type { IntegrationDashboardService } from "./integrations/integration-dashboard-service.js";
import type { IntegrationService } from "./integrations/integration-service.js";
import type { IntegrationPlatformService } from "./integrations/integration-platform-service.js";
import type { McpOAuthService } from "./integrations/mcp-oauth-service.js";
import type { ContinuationService } from "./agents/continuation-service.js";
import {
  createIntegrationPlatformRpcHandlers,
  registerIntegrationPlatformRoutes,
  type IntegrationPlatformRpcOptions,
} from "./integrations/integration-platform-routes.js";
import type { IntegrationToolsMcpService } from "./integrations/integration-tools-mcp-service.js";
import { createTriggerRpcHandlers, registerTriggerRoutes } from "./triggers/trigger-routes.js";
import type { TriggerService } from "./triggers/trigger-service.js";
import {
  registerAgentCdpBridge,
  registerTriggerCdpBridge,
  registerWatchCdpBridge,
} from "./browser/trigger-cdp-bridge.js";
import type { WatchCapabilityTokenService } from "./triggers/watch-capability.js";
import type { TriggerControlTokenService } from "./triggers/trigger-control-service.js";
import type { WatchProgramService } from "./triggers/watch-program-service.js";
import type { PersonalRemoteAccessService } from "./access/personal-remote-access-service.js";
import {
  availableSessionExchangeArms,
  registerSessionExchangeRoute,
} from "./access/session-exchange-routes.js";
import type { HostStaticDistribution } from "./server/static-distribution.js";
import { drainConnectionsWithin } from "./server/connection-drain.js";
import { createHostApiHandlers, type CoreCommand } from "./server/host-api-handlers.js";
import {
  createBrowserSourceRpcHandlers,
  registerBrowserSourceWire,
  setBrowserSourceExtensionCors,
  type BrowserSourceRpcOptions,
} from "./server/browser-source-registration.js";
import type { BrowserSourceService } from "./browser/browser-source-service.js";
import { browserSnapshotCompatibilityReason } from "./browser/browser-snapshot-compatibility.js";
import { registerResponseCompression } from "./server/response-compression.js";
import { registerHostApi } from "./server/host-api-registration.js";
import type { AttachmentService } from "./attachments/attachment-service.js";
import { normalizeHostError } from "./server/http-errors.js";
import { requestAbortSignal } from "./server/request-abort-signal.js";
import { hostInternalRoutePaths } from "./server/internal-routes.js";

export { hostInternalRoutePatterns } from "./server/internal-routes.js";

const maxWebSocketFrameBytes = 1 * 1_024 * 1_024;
const maxChallengedRunnerConnections = 8;
const maxChallengedChannelRuntimeConnections = 8;
const maxWebSocketBufferedBytes = 8 * 1_024 * 1_024;
const maxBrowserRelayFrameBytes = maxBrowserRelayEnvelopeBytes;
/** How long a stopping Host lets each WebSocket finish closing before ending it. */
const webSocketShutdownGraceMs = 2_000;
/** How long a stopping Host lets an HTTP request in flight finish before cutting it off. */
const httpShutdownGraceMs = 5_000;
const maxBrowserRelayQueuedBytes = 2 * maxBrowserRelayFrameBytes;
// One person sees their own Runners plus the deployment's shared ones, so the
// page budget is a guard against an unbounded loop rather than a real limit.
const runnerOwnershipPageSize = 100;
const maxRunnerOwnershipPages = 50;

const HarnessAuthenticationParamsSchema = z.strictObject({
  environmentId: EnvironmentIdSchema,
  harnessInstanceId: HarnessInstanceIdSchema,
});
const WorkspaceFileContentQuerySchema = z.strictObject({ file: WorkspaceFileKeySchema });
/**
 * Machines is a whole-inventory view, not a feed: a Deployment with more
 * computers than one page holds is not a shape this surface serves, so it asks
 * each registry for its maximum in one go rather than inventing a cursor.
 */
const machinePageLimit = 100;

export interface HostServerDependencies {
  readonly passkeys?: boolean;
  readonly fetch?: typeof globalThis.fetch;
  readonly attachments: AttachmentService;
  readonly requestResponseVault: RequestResponseVault;
  /** Present when account attachment uses adoption. */
  readonly accountAdoption?:
    { readonly acknowledge: (proofId: string) => Promise<void> } | undefined;
  readonly agentControl: AgentControlService;
  readonly agentControlTokens: import("./agents/agent-control-service.js").AgentControlTokenService;
  readonly agentTools: AgentToolsMcpService;
  readonly authenticator: HostAuthenticator;
  readonly machineFullDiskAccess: MachineFullDiskAccessService;
  readonly browser: BrowserService;
  readonly browserTabs: BrowserTabGroupService;
  readonly browserSources: BrowserSourceService;
  readonly signBrowserSourceInvitation: (bytes: Uint8Array) => string;
  /** Handed to a browser relay so it can verify the attach tickets it is sent. */
  readonly browserAttachPublicKeys: readonly {
    readonly keyId: string;
    readonly publicKeyPem: string;
  }[];
  readonly browserRelay: RunnerBrowserHub;
  readonly channels: {
    readonly relay: MessagingRelayHub;
    readonly service: ChannelService;
  };
  readonly commands: CommandService;
  /** The Host's end of every `integrations` module stream. */
  readonly computerApps: ComputerAppHub;
  readonly computerViews?: ComputerViewService;
  readonly displayStreams?: DisplayStreamHub;
  /** The Host's computer-use sessions, for the rows that show one. */
  readonly computerUse?: Pick<ComputerUseService, "sessionsForRunner">;
  readonly placeContext: Pick<PlaceContextService, "assertIncludable">;
  readonly credentials: CredentialService;
  readonly discovery: HostDiscoveryEnvelope;
  readonly egress: EgressService;
  readonly files: WorkspaceFilesService;
  readonly integrations: {
    readonly authAttempts: IntegrationAuthAttemptLifecycle;
    readonly continuations: ContinuationService;
    readonly dashboard: IntegrationDashboardService;
    readonly mcpOauth: McpOAuthService;
    readonly platform: IntegrationPlatformService;
    readonly service: IntegrationService;
    readonly skills: import("./integrations/integration-skill-bundle-service.js").IntegrationSkillBundleService;
    readonly tools: IntegrationToolsMcpService;
  };
  /** Shared with Runner registration so live sign-in attempts resume on reconnect. */
  readonly harnessAuthenticationCoordinator: HarnessAuthenticationCoordinator;
  /** Present when reachability is loopback and no account is attached. */
  readonly localBootstrap?: { readonly service: LocalBootstrapService } | undefined;
  /** Present when reachability is routed personal. */
  readonly personalRemoteAccess?: { readonly service: PersonalRemoteAccessService } | undefined;
  /** Present when Workspace backing is PortableFS. */
  readonly portablefs?:
    | {
        readonly mountExchange: MountExchangeService;
        readonly workspaceActivity: Pick<WorkspaceActivityService, "note">;
        readonly workspaceWake: Pick<WorkspaceWakeService, "wake">;
      }
    | undefined;
  /** What active Runs are streaming, for readers that open a Thread mid-turn. */
  readonly liveRuns: Pick<LiveRunRegistry, "threadFrames">;
  readonly realtime: RealtimeHub;
  readonly publishWorkspaceEvent?: (event: AgentEvent) => void;
  readonly runnerAuthenticator: RunnerAuthenticator;
  readonly runners: RunnerRegistry;
  readonly securityEffects: SecurityEffectService;
  /** The Host's end of every `shell` module control stream. */
  readonly shellControl: ShellControlStreamHandler;
  /** Present when web distribution is packaged. */
  readonly phoneUpdateRelease?: (() => AgentPhoneUpdateRelease | null) | undefined;
  readonly staticDistribution?: { readonly service: HostStaticDistribution } | undefined;
  readonly store: OpensteerStore;
  readonly triggers: {
    readonly controlTokens: TriggerControlTokenService;
    readonly service: TriggerService;
    readonly watchPrograms: WatchProgramService;
    readonly watchBrowserTokens: WatchCapabilityTokenService<"opensteer-watch-browser-cdp">;
  };
  readonly workspaceDeletion: Pick<WorkspaceDeletionService, "recover" | "requestDeletion">;
  readonly workspaces: WorkspaceService;
}

export async function createHostServer(
  dependencies: HostServerDependencies,
  options: { readonly logger?: boolean | Record<string, unknown> } = {},
): Promise<FastifyInstance> {
  // The signed discovery shape and the PortableFS record are two statements of
  // one fact. Assembling a server with only one of them either registers the
  // mount-grant exchange for a Deployment that has no PortableFS storage, or
  // silently drops Workspace wake and activity for one that does.
  if (
    (hostDiscoveryDefaultWorkspaceBacking(dependencies.discovery.document.deploymentShape) ===
      "portablefs") !==
    (dependencies.portablefs !== undefined)
  ) {
    throw new Error(
      "A PortableFS Deployment shape and its PortableFS Host services must be declared together",
    );
  }
  const publishWorkspaceEvent =
    dependencies.publishWorkspaceEvent ??
    ((event: AgentEvent) => dependencies.realtime.publish(event));
  const app = Fastify({
    bodyLimit: maxWebSocketFrameBytes,
    logger: options.logger ?? false,
    requestIdHeader: false,
  });
  await registerResponseCompression(app);
  const harnessCatalogReconciliations = new HarnessCatalogReconciliationOwner({
    catalogs: dependencies.store,
    onError: (environmentId, error) =>
      app.log.warn({ environmentId, err: error }, "Harness catalog reconciliation failed"),
    runners: dependencies.runners,
  });
  app.addHook("onClose", async () => harnessCatalogReconciliations.close());
  const harnessAuthenticationCoordinator = dependencies.harnessAuthenticationCoordinator;
  await app.register(websocket, {
    options: {
      maxPayload: maxBrowserRelayFrameBytes,
      perMessageDeflate: false,
    },
    preClose: closeWebSocketsWithin(webSocketShutdownGraceMs),
  });
  app.addContentTypeParser(
    ["application/octet-stream", "application/x-www-form-urlencoded", "text/plain"],
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );
  const runnerChallenges = new RunnerChallengeAdmission(maxChallengedRunnerConnections);
  const phoneUpdates = new AgentPhoneUpdateHub({
    authenticator: dependencies.runnerAuthenticator,
    store: dependencies.store,
    release:
      dependencies.phoneUpdateRelease ??
      (() => dependencies.staticDistribution?.service.agentPhoneRelease ?? null),
    changed: () => notifyMachinesChanged(dependencies.realtime, "machine.access"),
  });
  app.addHook("onClose", async () => phoneUpdates.close());
  const auxiliaryChallenges = new RunnerChallengeAdmission(maxChallengedChannelRuntimeConnections);
  const browserSocketSessions = new WeakMap<
    object,
    {
      readonly session: AuthenticatedSession;
      readonly mode: "control" | "watch";
      readonly editing: 1 | 2 | undefined;
      readonly passkeys: "native" | "notice" | undefined;
    }
  >();
  const realtimeSocketSessions = new WeakMap<object, AuthenticatedSession>();
  const workspaceSharingAvailable = deploymentSupportsSharing(
    dependencies.discovery.document.deploymentShape,
  );
  registerIdentityRoutes(app, dependencies.authenticator, {
    ...(dependencies.accountAdoption
      ? { acknowledgeAccountAdoption: dependencies.accountAdoption.acknowledge }
      : {}),
    workspaceSharingAvailable,
  });
  registerSessionExchangeRoute(app, {
    personalRemoteAccess: dependencies.personalRemoteAccess?.service,
  });
  registerAgentCdpBridge(app, dependencies.browser, dependencies.agentControlTokens);
  registerBrowserSourceWire(
    app,
    dependencies.browserSources,
    dependencies.discovery.document.canonicalOrigin,
  );
  const browserSourceRpcOptions: BrowserSourceRpcOptions = {
    service: dependencies.browserSources,
    canonicalOrigin: dependencies.discovery.document.canonicalOrigin,
    authority: dependencies.discovery,
    personal: dependencies.personalRemoteAccess !== undefined,
    deploymentName: async () =>
      (await dependencies.authenticator.identity.configuration()).deployment.name ?? "Opensteer",
    signInvitation: dependencies.signBrowserSourceInvitation,
    currentRoute: async () =>
      (await dependencies.personalRemoteAccess?.service.status("remote"))?.route ?? null,
  };
  const integrationAuthorizationRpcOptions: IntegrationAuthorizationRpcOptions = {
    attempts: dependencies.integrations.authAttempts,
    authenticator: dependencies.authenticator,
    deploymentId: dependencies.discovery.document.deploymentId,
    integrations: dependencies.integrations.service,
  };
  registerIntegrationAuthorizationRoutes(app, integrationAuthorizationRpcOptions);
  const integrationRpcOptions: IntegrationRpcOptions = {
    authenticator: dependencies.authenticator,
    dashboard: dependencies.integrations.dashboard,
    deploymentId: dependencies.discovery.document.deploymentId,
    integrations: dependencies.integrations.service,
    platform: dependencies.integrations.platform,
  };
  registerIntegrationRoutes(app, integrationRpcOptions);
  const integrationPlatformRpcOptions: IntegrationPlatformRpcOptions = {
    authenticator: dependencies.authenticator,
    dashboard: dependencies.integrations.dashboard,
    deploymentId: dependencies.discovery.document.deploymentId,
    platform: dependencies.integrations.platform,
    mcpOauth: dependencies.integrations.mcpOauth,
  };
  registerIntegrationPlatformRoutes(app, integrationPlatformRpcOptions);
  registerTriggerRoutes(app, dependencies.authenticator, dependencies.triggers.service);
  registerTriggerCdpBridge(app, dependencies.browser, dependencies.triggers.controlTokens);
  registerWatchCdpBridge(app, dependencies.browser, dependencies.triggers.watchBrowserTokens);

  app.setErrorHandler((error, request, reply) => {
    const normalized = normalizeHostError(error);
    if (normalized.status >= 500) request.log.error({ err: error }, "request failed");
    void reply.status(normalized.status).send({ error: normalized.error });
  });

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/.well-known/opensteer", async (request, reply) => {
    setBrowserSourceExtensionCors(reply, request.headers.origin);
    void reply.header("cache-control", "no-store");
    return HostDescriptorSchema.parse({
      apiVersion: hostApiVersion,
      authority: dependencies.discovery,
      bootstrapMethods: await advertisedBootstrapMethods(dependencies),
      capabilities: advertisedCapabilities(dependencies),
    });
  });
  // One optional subsystem, one registration decision. A Deployment without
  // Personal reachability does not answer on these paths at all, so no handler
  // repeats an availability check the router already made.
  if (dependencies.personalRemoteAccess) {
    const personalRemoteAccess = dependencies.personalRemoteAccess.service;
    app.get("/.well-known/opensteer/personal-access-route", async (_request, reply) => {
      const route = await personalRemoteAccess.accessRoute();
      if (!route) {
        throw new OpensteerError({ code: "not_found", message: "Personal access is disabled" });
      }
      return reply.header("cache-control", "no-store").send(route);
    });
    app.get("/v1/personal-remote-access", async (request, reply) => {
      const authenticated = await dependencies.authenticator.authenticateSessionContext(
        request.headers,
      );
      // Which Account owns this computer is the owner's business. A session
      // that arrived over a signed access route — a pairing-code guest
      // included — learns only whether the link is usable.
      const caller = (await personalRemoteAccess.isMachineLocalSession(authenticated))
        ? "machine-local"
        : "remote";
      return reply
        .header("cache-control", "no-store")
        .send(await personalRemoteAccess.status(caller));
    });
    app.put("/v1/personal-remote-access", async (request, reply) => {
      const caller = await dependencies.authenticator.authenticateSessionContext(request.headers, {
        mutation: true,
      });
      return reply
        .header("cache-control", "no-store")
        .send(
          await personalRemoteAccess.configure(
            caller,
            ConfigurePersonalRemoteAccessRequestSchema.parse(request.body),
          ),
        );
    });
    app.post("/v1/personal-remote-access/pairing-codes", async (request, reply) => {
      const caller = await dependencies.authenticator.authenticateSessionContext(request.headers, {
        mutation: true,
      });
      return reply
        .header("cache-control", "no-store")
        .send(await personalRemoteAccess.issuePairingCode(caller));
    });
    app.post("/v1/personal-remote-access/account-link/proof", async (request, reply) => {
      const caller = await dependencies.authenticator.authenticateSessionContext(request.headers, {
        mutation: true,
      });
      return reply
        .header("cache-control", "no-store")
        .send(
          await personalRemoteAccess.approveAccountLink(
            caller,
            ApprovePersonalHostAccountLinkRequestSchema.parse(request.body),
          ),
        );
    });
    app.post("/v1/personal-remote-access/account-link/consume", async (request, reply) => {
      const caller = await dependencies.authenticator.authenticateSessionContext(request.headers, {
        mutation: true,
      });
      return reply
        .header("cache-control", "no-store")
        .send(
          await personalRemoteAccess.consumeAccountLink(
            caller,
            ConsumePersonalHostAccountLinkRequestSchema.parse(request.body),
          ),
        );
    });
    app.post("/v1/personal-remote-access/account-link/resume", async (request, reply) => {
      const caller = await dependencies.authenticator.authenticateSessionContext(request.headers, {
        mutation: true,
      });
      return reply
        .header("cache-control", "no-store")
        .send(await personalRemoteAccess.resumeAccountLink(caller, request.body));
    });
    app.post(
      "/v1/personal-remote-access/account-unlink/revoke-sessions",
      async (request, reply) => {
        PersonalHostAccountUnlinkStepRequestSchema.parse(request.body);
        const caller = await dependencies.authenticator.authenticateSessionContext(
          request.headers,
          { mutation: true },
        );
        await personalRemoteAccess.revokeAccountSessions(caller);
        return reply.code(204).send();
      },
    );
    app.post("/v1/personal-remote-access/account-unlink/remove-link", async (request, reply) => {
      PersonalHostAccountUnlinkStepRequestSchema.parse(request.body);
      const caller = await dependencies.authenticator.authenticateSessionContext(request.headers, {
        mutation: true,
      });
      await personalRemoteAccess.removeAccountLink(caller);
      return reply.code(204).send();
    });
    app.post(
      "/v1/personal-remote-access/account-unlink/repair-hosted-oauth",
      async (request, reply) => {
        PersonalHostAccountUnlinkStepRequestSchema.parse(request.body);
        const caller = await dependencies.authenticator.authenticateSessionContext(
          request.headers,
          { mutation: true },
        );
        await personalRemoteAccess.markHostedOAuthConnectionsForRepair(caller);
        return reply.code(204).send();
      },
    );
    app.put("/v1/personal-remote-access/connect-projection", async (request, reply) => {
      const caller = await dependencies.authenticator.authenticateSessionContext(request.headers, {
        mutation: true,
      });
      await personalRemoteAccess.publishConnectProjection(
        caller,
        PublishPersonalConnectProjectionRequestSchema.parse(request.body),
      );
      return reply.status(204).send();
    });
    app.delete("/v1/personal-remote-access/connect-resource", async (request, reply) => {
      const caller = await dependencies.authenticator.authenticateSessionContext(request.headers, {
        mutation: true,
      });
      const response = await personalRemoteAccess.revokeConnectResource(
        caller,
        RevokeConnectRequestSchema.parse(request.body),
      );
      return reply
        .header("cache-control", "no-store")
        .send(RevokeConnectResponseSchema.parse(response));
    });
  }

  // Signing in changes what an AI engine offers, and the Runner is attached at
  // exactly that moment, so the captured catalog is refreshed here rather than
  // left to expire on the next reconnect. The sign-in itself has already
  // succeeded, so a refusal to re-inspect is reported and left for the next
  // capture rather than failing the caller's request.
  const captureAuthenticatedHarness = async (
    target: Awaited<ReturnType<typeof managedHarnessAuthenticationTarget>>,
    authentication: HarnessAuthenticationState,
  ): Promise<void> => {
    if (authentication.status !== "ready") return;
    await dependencies.store.discardHarnessCatalog(target.environment.id, target.harness.id);
    harnessCatalogReconciliations.schedule(target.environment.id);
  };

  /**
   * Refuses to pull an AI engine out from under work that is still running.
   *
   * Signing a profile out closes the shared adapter on the Runner, which ends
   * every session on that profile. Unlike disabling, sign-out writes nothing
   * durable to serialize on, so this read cannot be the authority: it is the
   * courtesy that gives the person a good error without a Runner round-trip,
   * and the Runner refuses the same request outright if a run is executing on
   * the profile when it arrives.
   */
  const assertHarnessIsIdle = async (
    environmentId: EnvironmentId,
    harnessInstanceId: HarnessInstanceId,
    action: string,
  ): Promise<void> => {
    if (!(await dependencies.store.hasActiveRunForHarness(environmentId, harnessInstanceId))) {
      return;
    }
    throw new OpensteerError({
      code: "conflict",
      message: `This AI engine is still running work; wait for it to finish before ${action}`,
      retryable: true,
    });
  };

  /**
   * The extra authority destructive actions need on an existing-CLI profile.
   *
   * An ambient profile is the machine's own provider installation. Signing it
   * out or retiring Opensteer's record of it reaches into a person's real CLI
   * on their own computer, which is not something the Deployment's
   * administrators get to do on their behalf. Creating, renaming, and disabling
   * touch only Opensteer's record and stay administrator-managed, and a
   * Deployment-owned Runner has no such person to defer to.
   */
  const admitAmbientDestructiveAction = async (
    session: Awaited<ReturnType<HostAuthenticator["authenticateSession"]>>,
    environmentId: EnvironmentId,
    stateKind: HarnessInstanceStateKind,
  ): Promise<void> => {
    if (stateKind !== "ambient") return;
    const runnerOwner = await dependencies.store.environmentRunnerOwner(environmentId);
    if (runnerOwner === null || runnerOwner === session.user.id) return;
    throw new OpensteerError({
      code: "forbidden",
      message:
        "This existing CLI belongs to its owner's own computer; only they can sign it out or remove it",
    });
  };

  /** Resolves one work location and applies its profile-management authority. */
  const admitHarnessManagement = async (
    session: Awaited<ReturnType<HostAuthenticator["authenticateSession"]>>,
    environmentIdInput: string,
  ) => {
    const environmentId = EnvironmentIdSchema.parse(environmentIdInput);
    const environment = (await dependencies.store.listEnvironmentsForUser(session.user.id)).find(
      (candidate) => candidate.id === environmentId,
    );
    if (!environment) {
      throw new OpensteerError({ code: "not_found", message: "Work location not found" });
    }
    const isInstanceAdministrator = session.user.instanceRole === "administrator";
    const allowed = harnessAuthenticationIsAllowed({
      boundEnvironmentIds: isInstanceAdministrator
        ? new Set()
        : await boundRunnerEnvironmentIds(dependencies.store, session.user.id),
      environment,
      isInstanceAdministrator,
    });
    if (!allowed) {
      throw new OpensteerError({
        code: "forbidden",
        message: "This work location's AI engines are administered by the Deployment",
      });
    }
    return environment;
  };

  /** Resolves the work location and settles, in one place for all three
   * methods, whether this person is entitled to sign an AI engine in on it. */
  const admitHarnessAuthentication = async (
    session: Awaited<ReturnType<HostAuthenticator["authenticateSession"]>>,
    params: { readonly environmentId: string; readonly harnessInstanceId: string },
  ): Promise<Awaited<ReturnType<typeof managedHarnessAuthenticationTarget>>> => {
    const environment = await admitHarnessManagement(session, params.environmentId);
    return await managedHarnessAuthenticationTarget(dependencies.store, params, environment);
  };

  /** Registered only for an exact-loopback Host. Source development may read
   * its own bootstrap document without a second credential; packaged Personal
   * mode additionally requires the app-held owner-claim capability. The
   * route does not exist on a Host reachable from another machine. */
  if (dependencies.localBootstrap) {
    const localBootstrap = dependencies.localBootstrap.service;
    app.get("/v1/local-bootstrap", async (request, reply) => {
      // A browser can be made to issue a cross-origin GET, so refuse any request
      // that announces an origin other than this Host's own. Same-machine
      // supervisors send this Host's exact Origin.
      const origin = request.headers.origin;
      if (origin !== undefined && origin !== dependencies.authenticator.publicOrigin) {
        throw new OpensteerError({ code: "forbidden", message: "Request origin is not allowed" });
      }
      return reply
        .header("cache-control", "no-store")
        .send(await localBootstrap.describe(request.headers.authorization));
    });
  }

  app.get<{ Params: { workspaceId: string } }>(
    "/v1/workspaces/:workspaceId/files/download",
    async (request, reply) => {
      const userId = await dependencies.authenticator.authenticateUser(request.headers);
      const workspaceId = WorkspaceIdSchema.parse(request.params.workspaceId);
      const admission = await dependencies.store.admitWorkspaceFiles(workspaceId, userId);
      if (!admission) {
        throw new OpensteerError({ code: "not_found", message: "Workspace not found" });
      }
      const query = WorkspaceFileContentQuerySchema.parse(request.query);
      const signal = requestAbortSignal(request.raw, reply.raw);
      const response = await dependencies.files.download(admission, query.file, signal);
      for (const header of ["content-length", "content-type", "etag", "last-modified"] as const) {
        const value = response.headers.get(header);
        if (value) void reply.header(header, value);
      }
      void reply
        .header("cache-control", "private, no-store")
        .header("content-disposition", "attachment")
        .header("content-security-policy", "default-src 'none'; sandbox")
        .header("x-content-type-options", "nosniff");
      if (!response.body) return reply.send(Buffer.alloc(0));
      return reply.send(Readable.from(response.body as AsyncIterable<Uint8Array>));
    },
  );

  app.get<{ Params: { profileId: string } }>(
    "/v1/browser-profile-initialization/:profileId",
    async (request, reply) => {
      void reply.header("cache-control", "private, no-store");
      return dependencies.browser.loadProfileInitialization(
        BrowserProfileIdSchema.parse(request.params.profileId),
        requireBearerToken(request),
      );
    },
  );
  app.post<{ Params: { profileId: string } }>(
    "/v1/browser-profile-initialization/:profileId",
    async (request) =>
      dependencies.browser.completeProfileInitialization(
        BrowserProfileIdSchema.parse(request.params.profileId),
        requireBearerToken(request),
        CompleteProfileInitializationSchema.parse(request.body),
      ),
  );

  app.get<{ Params: { profileId: string; sessionId: string } }>(
    "/v1/browser-profile-state/:profileId/:sessionId",
    async (request) =>
      dependencies.browser.loadProfileState({
        leaseToken: requireBearerToken(request),
        profileId: BrowserProfileIdSchema.parse(request.params.profileId),
        sessionId: BrowserSessionIdSchema.parse(request.params.sessionId),
      }),
  );

  app.put<{ Params: { profileId: string; sessionId: string } }>(
    "/v1/browser-profile-state/:profileId/:sessionId",
    { bodyLimit: maxBrowserProfileSnapshotBytes + 64 * 1_024 },
    async (request) => {
      const body = z
        .strictObject({
          expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          snapshot: BrowserProfileSnapshotSchema,
        })
        .parse(request.body);
      const committed = await dependencies.browser.commitProfileState({
        expectedRevision: body.expectedRevision,
        periodic: request.headers[browserProfileCheckpointHeader] === "periodic",
        leaseToken: requireBearerToken(request),
        profileId: BrowserProfileIdSchema.parse(request.params.profileId),
        sessionId: BrowserSessionIdSchema.parse(request.params.sessionId),
        snapshot: body.snapshot,
      });
      return { revision: committed.revision };
    },
  );

  const requireRpcSession = (context: HostApiServerContext) => {
    if (!context.session) {
      throw new OpensteerError({ code: "unauthorized", message: "Authentication required" });
    }
    return context.session;
  };

  const machineRegistryRows = async (
    session: NonNullable<HostApiServerContext["session"]>,
  ): Promise<Omit<MachineProjectionInput, "deploymentKind">> => {
    const ownerId = session.user.id;
    const includeDeployment = session.user.instanceRole === "administrator";
    const [runnerPage, pendingRunners] = await Promise.all([
      dependencies.store.listRunners({
        includeDeployment,
        includeOtherOwners: includeDeployment,
        limit: machinePageLimit,
        ownerId,
      }),
      dependencies.store.listPendingRunnerEnrollments({
        includeDeployment,
        limit: machinePageLimit,
        ownerId,
      }),
    ]);
    // A revoked computer has no row to report against, so its directories are
    // not this page's to compare either.
    const active = runnerPage.runners.filter((runner) => runner.revokedAt === null);
    const environmentIds = [
      ...new Set(active.flatMap((runner) => runner.moduleDescriptors.agents?.environmentIds ?? [])),
    ];
    const [localWorkspaces, threadsByEnvironment] = await Promise.all([
      dependencies.store.listLocalWorkspacesForEnvironments(environmentIds),
      dependencies.store.countLiveThreadsByEnvironment(environmentIds),
    ]);
    // Access is read only for the machines this viewer manages and only for the
    // ones that can have any: reach is not disclosed to anyone else, and a
    // machine that does not advertise `shell` — an older Runner, a Windows one,
    // one whose helper is missing — has no access to report, so it gets none
    // rather than controls the write side would refuse.
    //
    // Management is the one rule `requireMachineAccessManagement` and the
    // authoritative write both use, read from the same effective ownership
    // rather than re-derived from `instanceRole` here.
    //
    // Apps belong to one person's account, so administrator management of a
    // Deployment-owned machine does not make that administrator its effective
    // owner. They are not a `shell` fact: a computer can lend one app without
    // accepting connections at all, so ownership is resolved for every machine
    // that advertises either module.
    const manageable = active.filter(
      (runner) =>
        runner.moduleDescriptors.shell !== undefined ||
        runner.moduleDescriptors.integrations !== undefined,
    );
    const ownership =
      manageable.length === 0
        ? new Map<RunnerId, MachineOwnershipRecord>()
        : await dependencies.store.effectiveMachineOwners(manageable.map((runner) => runner.id));
    const managed = manageable.filter((runner) => {
      const owners = ownership.get(runner.id);
      return (
        owners !== undefined &&
        machineIsManagedBy(owners, ownerId, { allowDeployment: includeDeployment })
      );
    });
    const apps = new Map<string, readonly MachineAppStatus[]>();
    const computerViews = new Map<
      string,
      { ownerViews: Awaited<ReturnType<ComputerViewService["list"]>>; ownerViewVersion?: number }
    >();
    const computerUseSessions = new Map<string, readonly ComputerUseSessionSummary[]>();
    const computerUseDisplayStreamSupported = new Map<string, boolean>();
    const computerUsePolicies = new Map<
      string,
      { readonly appApproval: "ask" | "automatic"; readonly approvalKeyId: string | null }
    >();
    for (const runner of manageable) {
      if (ownership.get(runner.id)?.effectiveOwner !== ownerId) continue;
      const reported = dependencies.computerApps.status(runner.id);
      if (reported !== null) apps.set(runner.id, reported);
      const display = dependencies.computerApps.displayStream(runner.id);
      computerUseDisplayStreamSupported.set(
        runner.id,
        display !== null && display !== "unsupported",
      );
      if (dependencies.computerViews)
        computerViews.set(runner.id, {
          ownerViews: await dependencies.computerViews.list(ownerId, runner.id),
          ...(dependencies.computerApps.ownerViewSupported(runner.id) &&
          runner.device?.form !== "phone"
            ? { ownerViewVersion: clientMacOwnerViewVersion }
            : {}),
        });
      const sessions = dependencies.computerUse?.sessionsForRunner(runner.id);
      if (sessions) computerUseSessions.set(runner.id, sessions);
      // Only Macs use app approval policies and signing keys.
      const integrationsPlatform = runner.moduleDescriptors.integrations?.platform;
      if (
        integrationsPlatform !== "darwin" &&
        runner.moduleDescriptors.shell?.platform !== "darwin"
      )
        continue;
      computerUsePolicies.set(
        runner.id,
        await dependencies.integrations.platform.computerAppApprovals.computerUsePolicy({
          runnerId: runner.id,
          ownerUserId: ownerId,
        }),
      );
    }
    const access = new Map<string, MachineAccessView>(
      await Promise.all(
        managed
          .filter((runner) => runner.moduleDescriptors.shell !== undefined)
          .map(async (runner): Promise<[string, MachineAccessView]> => {
            const stored = await dependencies.store.listActiveShellSessions(runner.id);
            // The row's counters are zero until a session ends, so the live ones
            // are overlaid from the hub; a session the hub no longer holds is
            // one whose final counters are already written.
            const live = dependencies.shellControl.liveSessionBytes(runner.id);
            return [
              runner.id,
              {
                activeSessions: stored.map((summary) => ({ ...summary, ...live.get(summary.id) })),
                ownerReachAvailable: ownership.get(runner.id)?.effectiveOwner !== null,
                policy: runner.accessPolicy,
                revision: runner.accessPolicyRevision,
              },
            ];
          }),
      ),
    );
    return {
      access,
      apps,
      computerUseSessions,
      computerViews,
      computerUseDisplayStreamSupported,
      computerUsePolicies,
      localWorkspaces,
      pendingRunners,
      runners: runnerPage.runners.map((runner) => ({
        updateRequired: runner.updateRequired,
        phoneUpdate: phoneUpdates.projection(
          runner.id,
          runner.connectionGeneration,
          dependencies.runners.isRunnerConnected(runner.id),
        ),
        allowedModules: runner.allowedModules,
        connected: dependencies.runners.isRunnerConnected(runner.id),
        device: runner.device,
        enrollmentId: runner.enrollmentId,
        id: runner.id,
        kind: runner.kind,
        lastSeenAt: runner.lastSeenAt,
        modules: runner.moduleDescriptors,
        name: runner.name,
        ownerKind: runner.ownerKind,
        ownerName: runner.ownerName,
        deviceProfile: runner.deviceProfile,
        ownedByViewer: runner.ownerUserId === ownerId,
        readiness: moduleReadiness(
          runner.id,
          runner.moduleDescriptors.browser?.profileSnapshotVersion,
        ),
        revokedAt: runner.revokedAt,
        // Only a live connection says which build it runs.
        runtimeVersion: dependencies.runners.identityForRunner(runner.id)?.runtimeVersion ?? null,
      })),
      threadsByEnvironment,
    };
  };

  /**
   * What each of a Runner's modules last said about itself. Only a live
   * connection has an answer, so a disconnected computer reports nothing and
   * the projection shows its modules as unavailable rather than as ready.
   */
  const moduleReadiness = (runnerId: RunnerId, browserSnapshotVersion: number | undefined) => {
    const readiness = new Map<RunnerModuleName, MachineModuleSummary>();
    for (const module of RunnerModuleNameSchema.options) {
      const reported = dependencies.runners.moduleReadiness(runnerId, module);
      if (reported === undefined) continue;
      const browserIncompatibility =
        module === "browser" ? browserSnapshotCompatibilityReason(browserSnapshotVersion) : null;
      if (browserIncompatibility !== null) {
        readiness.set(module, {
          checkedAt: null,
          detail: browserIncompatibility,
          readiness: "unavailable",
        });
        continue;
      }
      readiness.set(module, { checkedAt: null, detail: null, readiness: reported });
    }
    return readiness;
  };

  const machineSummaries = async (
    session: NonNullable<HostApiServerContext["session"]>,
    deploymentKind: DeploymentDisplayKind,
  ) => projectMachines({ ...(await machineRegistryRows(session)), deploymentKind });

  const coreRpcHandlers = {
    ...createVoiceHandlers(dependencies),
    "agentPhone.target.get": async (_input, context) => {
      requireRpcSession(context);
      return rpcSuccess(
        hostApi["agentPhone.target.get"].success.parse(await agentPhoneHostTarget(dependencies)),
      );
    },
    "attachment.get": async (input, context) =>
      rpcSuccess(
        await dependencies.attachments.get(input.attachmentId, requireRpcSession(context).user.id),
      ),
    "attachment.upload": async (input, context) => {
      if (!context.binaryBody)
        throw new OpensteerError({ code: "bad_request", message: "Binary upload body required" });
      return rpcSuccess(
        await dependencies.attachments.upload({
          attachmentId: input.attachmentId,
          userId: requireRpcSession(context).user.id,
          body: context.binaryBody,
          signal: context.signal,
        }),
      );
    },
    "attachment.content": async (input, context) =>
      rpcSuccess(
        hostApi["attachment.content"].success.parse(
          await dependencies.attachments.contentForUser(
            input.attachmentId,
            requireRpcSession(context).user.id,
          ),
        ),
      ),
    "bootstrap.get": async (_input, context) => {
      const session = requireRpcSession(context);
      const ownerId = session.user.id;
      const diagnosticHeader = context.headers[bootstrapDiagnosticHeader];
      if (diagnosticHeader !== undefined) {
        const diagnostic = dependencies.realtime.bootstrapDiagnostics.report(diagnosticHeader);
        if (diagnostic) app.log.warn(diagnostic, "host.bootstrap.loop");
      }
      const homeWorkspace = await dependencies.workspaces
        .ensureMainWorkspace(ownerId)
        .catch((error: unknown) => {
          app.log.error({ err: error, ownerId }, "Main Workspace could not be ensured");
          return null;
        });
      const environments = await dependencies.store.listEnvironmentsForUser(ownerId);
      const [workspacePage, visibleHarnesses, browser, identityConfig, executionPreferences] =
        await Promise.all([
          dependencies.store.workspacePageForOwner({ ownerId }),
          dependencies.store.listHarnessInstances({
            environmentIds: environments.map(({ id }) => id),
          }),
          dependencies.browser.bootstrap(ownerId),
          dependencies.authenticator.identity.configuration(),
          dependencies.store.getExecutionPreferences(ownerId),
        ]);
      const storedCatalogs = await dependencies.store.listHarnessCatalogs(
        environments.map((environment) => environment.id),
      );
      const isInstanceAdministrator = session.user.instanceRole === "administrator";
      const boundEnvironmentIds = isInstanceAdministrator
        ? new Set<EnvironmentId>()
        : await boundRunnerEnvironmentIds(dependencies.store, ownerId);
      const environmentSummaries = environments.map((environment) => {
        const runner = dependencies.runners.identityForEnvironment(environment.id);
        const connected = runner !== undefined;
        return {
          ...environment,
          connected,
          harnessAuthenticationAllowed: harnessAuthenticationIsAllowed({
            boundEnvironmentIds,
            environment,
            isInstanceAdministrator,
          }),
          harnessCatalogs: storedCatalogs
            .filter((record) => record.environmentId === environment.id)
            .map((record) => ({ ...record.catalog, capturedAt: record.capturedAt.toISOString() })),
          harnessDrivers: runner?.modules.agents?.harnessDrivers ?? [],
          providerStateModes: runner?.modules.agents?.providerStateModes ?? [],
          status: connected ? "connected" : "disconnected",
          workspaceBackings: runner?.modules.agents?.workspaceBackings ?? [],
        };
      });
      const machines = await machineSummaries(session, identityConfig.deployment.kind);
      const notificationPreferences =
        homeWorkspace && !workspacePage.workspaces.some(({ id }) => id === homeWorkspace.id)
          ? [
              ...workspacePage.notificationPreferences,
              ...(await dependencies.store.notificationState.listWorkspacePreferences({
                userId: ownerId,
                workspaceIds: [homeWorkspace.id],
              })),
            ]
          : workspacePage.notificationPreferences;
      return rpcSuccess(
        HostBootstrapSchema.parse({
          browser,
          latestPlaces: await dependencies.browser.latestPlaces(ownerId),
          notificationPreferences,
          deploymentId: dependencies.discovery.document.deploymentId,
          deploymentShape: dependencies.discovery.document.deploymentShape,
          environments: environmentSummaries,
          executionPreferences,
          harnesses: visibleHarnesses.map(harnessView),
          homeWorkspace: homeWorkspace
            ? await workspaceView(dependencies.workspaces, homeWorkspace)
            : null,
          identityConfig,
          machines,
          ...(context.surface ? { sessionSurface: context.surface } : {}),
          user: session.user,
          workspaceSharingAvailable: deploymentSupportsSharing(
            dependencies.discovery.document.deploymentShape,
          ),
          workspaces: await Promise.all(
            workspacePage.workspaces.map((workspace) =>
              decorateWorkspaceView(dependencies.workspaces, workspace),
            ),
          ),
          workspaceWindow: workspacePage.window,
        }),
      );
    },
    "harness.authentication.get": async (input, context) => {
      const target = await admitHarnessAuthentication(requireRpcSession(context), input);
      const envelope = await harnessAuthenticationCoordinator.read(
        target,
        AbortSignal.timeout(30_000),
      );
      await captureAuthenticatedHarness(target, envelope.authentication);
      return rpcSuccess(envelope);
    },
    "harness.catalog.refresh": async (input, context) => {
      const target = await admitHarnessAuthentication(requireRpcSession(context), input);
      if (!dependencies.runners.identityForEnvironment(target.environment.id)) {
        throw new OpensteerError({
          code: "conflict",
          message: "Reconnect this computer before refreshing its models",
          retryable: true,
        });
      }
      // The wait ends before the client's own, so the person reads a sentence
      // rather than a transport failure.
      const deadline = AbortSignal.timeout(interactiveRunnerRequestTimeoutMs);
      try {
        await dependencies.store.discardHarnessCatalog(target.environment.id, target.harness.id);
        await inspectAndRecordHarnessCatalogs({
          catalogs: dependencies.store,
          environmentId: target.environment.id,
          fresh: true,
          harnesses: [target.harness],
          runners: dependencies.runners,
          signal: AbortSignal.any([context.signal, deadline]),
        });
      } catch (error) {
        if (!deadline.aborted) throw error;
        throw new OpensteerError({
          code: "timeout",
          message: "This computer didn't answer in time. Try again.",
          retryable: true,
        });
      }
      return rpcSuccess({});
    },
    "harness.modelServers.discover": async (input, context) => {
      const environment = await admitHarnessManagement(
        requireRpcSession(context),
        input.environmentId,
      );
      if (input.address !== undefined && !parseHttpEndpointBaseUrl(input.address)) {
        throw new OpensteerError({
          code: "bad_request",
          message:
            "Enter an http:// or https:// address without a username, password, query or fragment",
        });
      }
      const servers = await dependencies.runners.discoverModelServers(
        environment.id,
        input.address,
        context.signal,
      );
      return rpcSuccess({ servers: [...servers] });
    },
    "machine.access.history": async (input, context) => {
      const session = requireRpcSession(context);
      await requireMachineAccessManagement(dependencies.store, session, input.runnerId);
      // The store bounds this page to both the item limit and 16 MiB serialized,
      // trimming trailing sessions and re-pointing the cursor when a flooded
      // audit would overrun it.
      const page = await dependencies.store.listShellHistory({
        ...(input.before ? { before: input.before } : {}),
        limit: input.limit,
        runnerId: input.runnerId,
      });
      return rpcSuccess(
        hostApi["machine.access.history"].success.parse({
          nextCursor: page.nextCursor,
          sessions: page.sessions.map((entry) => ({
            ...entry,
            endedAt: entry.endedAt?.toISOString() ?? null,
          })),
        }),
      );
    },
    "machines.list": async (_input, context) => {
      const session = requireRpcSession(context);
      const identityConfig = await dependencies.authenticator.identity.configuration();
      return rpcSuccess(
        hostApi["machines.list"].success.parse({
          machines: await machineSummaries(session, identityConfig.deployment.kind),
        }),
      );
    },
    "thread.events.list": async (input, context) => {
      const page = await dependencies.store.threadEventPageForOwner({
        ...(input.aroundMessageId ? { aroundMessageId: input.aroundMessageId } : {}),
        ...(input.before ? { before: input.before } : {}),
        maxItems: Math.min(input.limit ?? eventPageMaxItems, eventPageMaxItems),
        ownerId: requireRpcSession(context).user.id,
        threadId: input.threadId,
      });
      if (!page) throw new OpensteerError({ code: "not_found", message: "Thread not found" });
      return rpcSuccess(page);
    },
    "thread.messages.list": async (input, context) => {
      const page = await dependencies.store.threadMessagePageForOwner({
        threadId: input.threadId,
        ownerId: requireRpcSession(context).user.id,
        ...(input.before ? { before: input.before } : {}),
        ...(input.query ? { query: input.query } : {}),
        ...(input.aroundMessageId ? { aroundMessageId: input.aroundMessageId } : {}),
        maxItems: input.limit ?? 100,
      });
      if (!page) throw new OpensteerError({ code: "not_found", message: "Thread not found" });
      return rpcSuccess(page);
    },
    "thread.readState.get": async (input, context) =>
      rpcSuccess(
        await dependencies.store.notificationState.getReadState({
          threadId: input.threadId,
          userId: requireRpcSession(context).user.id,
        }),
      ),
    "browser.searchSuggestions.get": async (input) =>
      rpcSuccess(await searchSuggestions(input.query, dependencies.fetch ?? globalThis.fetch)),
    "browser.contextCandidate.get": async (input, context) =>
      rpcSuccess(
        await dependencies.browser.readContextCandidate(requireRpcSession(context).user.id, input),
      ),
    "workspace.tabs.get": async (input, context) =>
      rpcSuccess(
        await dependencies.browser.readWorkspaceTabs(
          requireRpcSession(context).user.id,
          input.groupId,
        ),
      ),
    "browser.tabs.get": async (input, context) =>
      rpcSuccess(
        await dependencies.browser.readTabCatalog(
          requireRpcSession(context).user.id,
          input.sessionId,
        ),
      ),
    "browser.history.get": async (input, context) =>
      rpcSuccess(
        await dependencies.browser.readHistory(requireRpcSession(context).user.id, input.profileId),
      ),
    "browser.history.icons.get": async (input, context) =>
      rpcSuccess(
        await dependencies.browser.readHistoryIcons(requireRpcSession(context).user.id, input),
      ),
    "browser.tabIcon.get": async (input, context) =>
      rpcSuccess(await dependencies.browser.readTabIcon(requireRpcSession(context).user.id, input)),
    "thread.browserUsage.get": async (input, context) => {
      const ownerId = requireRpcSession(context).user.id;
      const thread = await dependencies.store.getThreadForOwner(input.threadId, ownerId);
      if (!thread) throw new OpensteerError({ code: "not_found", message: "Thread not found" });
      return rpcSuccess(
        hostApi["thread.browserUsage.get"].success.parse({
          threadId: thread.id,
          uses: await dependencies.store.getThreadBrowserUsage({ ...input, ownerId }),
        }),
      );
    },
    "thread.live.get": async (input, context) => {
      const thread = await dependencies.store.getThreadForOwner(
        input.threadId,
        requireRpcSession(context).user.id,
      );
      if (!thread) throw new OpensteerError({ code: "not_found", message: "Thread not found" });
      return rpcSuccess({
        runs: dependencies.liveRuns.threadFrames(thread.id).slice(0, 64),
        threadId: thread.id,
      });
    },
    "run.attempts.list": async (input, context) => {
      const listed = await dependencies.store.listRunAttemptsForOwner({
        ownerId: requireRpcSession(context).user.id,
        runId: input.runId,
      });
      if (!listed) throw new OpensteerError({ code: "not_found", message: "Run not found" });
      return rpcSuccess({
        attempts: [...listed.attempts],
        nodes: [...listed.nodes],
        runId: input.runId,
      });
    },
    "thread.inputQueue.get": async (input, context) => {
      const requestedBy = requireRpcSession(context).user.id;
      const thread = await dependencies.store.getThreadForOwner(input.threadId, requestedBy);
      if (!thread) throw new OpensteerError({ code: "not_found", message: "Thread not found" });
      return rpcSuccess(
        await dependencies.store.getThreadInputQueue({ threadId: thread.id, requestedBy }),
      );
    },
    "assignment.get": async (input, context) => {
      const assignment = await dependencies.store.getAssignmentForOwner({
        assignmentId: input.assignmentId,
        ownerId: requireRpcSession(context).user.id,
      });
      if (!assignment) throw new OpensteerError({ code: "not_found", message: "Task not found" });
      return rpcSuccess(assignment);
    },
    "thread.assignments.list": async (input, context) => {
      const page = await dependencies.store.listThreadAssignmentsForOwner({
        threadId: input.threadId,
        ownerId: requireRpcSession(context).user.id,
        maxItems: Math.min(input.limit ?? 25, 100),
        maxBytes: 512 * 1_024,
        ...(input.before ? { before: input.before } : {}),
        ...(input.open ? { open: true } : {}),
      });
      if (!page) throw new OpensteerError({ code: "not_found", message: "Thread not found" });
      return rpcSuccess(
        hostApi["thread.assignments.list"].success.parse({ ...page, threadId: input.threadId }),
      );
    },
    "requests.list": async (input, context) =>
      rpcSuccess(
        hostApi["requests.list"].success.parse(
          await dependencies.store.requests.waitingOnUserPage({
            ...(input.before ? { before: input.before } : {}),
            limit: Math.min(input.limit ?? 100, 100),
            userId: requireRpcSession(context).user.id,
          }),
        ),
      ),
    "thread.requests.list": async (input, context) => {
      const ownerId = requireRpcSession(context).user.id;
      const thread = await dependencies.store.getThreadForOwner(input.threadId, ownerId);
      if (!thread) throw new OpensteerError({ code: "not_found", message: "Thread not found" });
      const page = await dependencies.store.requests.originatingPendingPage({
        ...(input.before ? { before: input.before } : {}),
        limit: Math.min(input.limit ?? threadPageMaxItems, threadPageMaxItems),
        threadId: input.threadId,
      });
      return rpcSuccess(
        hostApi["thread.requests.list"].success.parse({ ...page, threadId: input.threadId }),
      );
    },
    "workspace.catalog.list": async (input, context) => {
      const page = await dependencies.store.workspacePageForOwner({
        ...(input.before ? { before: input.before } : {}),
        maxItems: Math.min(input.limit ?? workspacePageMaxItems, workspacePageMaxItems),
        ownerId: requireRpcSession(context).user.id,
      });
      return rpcSuccess({
        ...page,
        workspaces: await Promise.all(
          page.workspaces.map((workspace) =>
            decorateWorkspaceView(dependencies.workspaces, workspace),
          ),
        ),
      });
    },
    "workspace.files.list": async (input, context) => {
      const admission = await dependencies.store.admitWorkspaceFiles(
        input.workspaceId,
        requireRpcSession(context).user.id,
      );
      if (!admission) {
        throw new OpensteerError({ code: "not_found", message: "Workspace not found" });
      }
      const page = await dependencies.files.list(
        admission,
        {
          ...(input.cursor ? { cursor: input.cursor } : {}),
          ...(input.retainedCursor ? { retainedCursor: input.retainedCursor } : {}),
          ...(input.knownRevision ? { knownRevision: input.knownRevision } : {}),
          limit: workspaceDirectoryPageDefaultEntries,
          parentKey: input.parentKey,
        },
        context.signal,
      );
      context.setHeader("etag", `"${page.revision}"`);
      return rpcSuccess(page);
    },
    "workspace.files.preview": async (input, context) => {
      const admission = await dependencies.store.admitWorkspaceFiles(
        input.workspaceId,
        requireRpcSession(context).user.id,
      );
      if (!admission) {
        throw new OpensteerError({ code: "not_found", message: "Workspace not found" });
      }
      return rpcSuccess(
        hostApi["workspace.files.preview"].success.parse(
          await dependencies.files.preview(admission, input.fileKey, context.signal),
        ),
      );
    },
    "workspace.invitations.list": async (input, context) =>
      rpcSuccess({
        invitations: (
          await dependencies.store.listActiveWorkspaceInvitations(
            input.workspaceId,
            requireRpcSession(context).user.id,
          )
        ).map(serializeInvitation),
      }),
    "workspace.members.list": async (input, context) =>
      rpcSuccess({
        members: (
          await dependencies.store.listWorkspaceMembers(
            input.workspaceId,
            requireRpcSession(context).user.id,
          )
        ).map((member) => ({ ...member, joinedAt: member.joinedAt.toISOString() })),
      }),
    "workspace.prefetch": async (input, context) => {
      const workspace = await dependencies.store.getWorkspaceForOwner(
        input.workspaceId,
        requireRpcSession(context).user.id,
      );
      if (!workspace || workspace.status === "deleted") {
        throw new OpensteerError({ code: "not_found", message: "Workspace not found" });
      }
      dependencies.portablefs?.workspaceActivity.note(input.workspaceId);
      if (workspaceWakesOnDemand(workspace.status)) {
        void dependencies.portablefs?.workspaceWake.wake(input.workspaceId, "thread-prefetch");
      }
      return rpcSuccess({});
    },
    "tasks.list": async (input, context) =>
      rpcSuccess(
        hostApi["tasks.list"].success.parse(
          await dependencies.store.taskPageForUser({
            ...(input.active === undefined ? {} : { active: input.active }),
            ...(input.before ? { before: input.before } : {}),
            maxItems: Math.min(input.limit ?? threadPageMaxItems, threadPageMaxItems),
            userId: requireRpcSession(context).user.id,
            ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
          }),
        ),
      ),
  } satisfies Pick<
    HostApiHandlers,
    | "agentPhone.target.get"
    | "assignment.get"
    | "thread.assignments.list"
    | "browser.searchSuggestions.get"
    | "browser.contextCandidate.get"
    | "browser.tabs.get"
    | "workspace.tabs.get"
    | "browser.tabIcon.get"
    | "browser.history.get"
    | "browser.history.icons.get"
    | "thread.browserUsage.get"
    | "attachment.get"
    | "attachment.upload"
    | "attachment.content"
    | "bootstrap.get"
    | "harness.authentication.get"
    | "harness.catalog.refresh"
    | "harness.modelServers.discover"
    | "voice.start"
    | "voice.renew"
    | "voice.next"
    | "voice.answer"
    | "voice.context"
    | "voice.say"
    | "voice.stop"
    | "machine.access.history"
    | "machines.list"
    | "requests.list"
    | "run.attempts.list"
    | "tasks.list"
    | "thread.events.list"
    | "thread.messages.list"
    | "thread.readState.get"
    | "thread.inputQueue.get"
    | "thread.live.get"
    | "thread.requests.list"
    | "workspace.catalog.list"
    | "workspace.files.list"
    | "workspace.files.preview"
    | "workspace.invitations.list"
    | "workspace.members.list"
    | "workspace.prefetch"
  >;

  const executeCoreCommand = async (command: CoreCommand, context: HostApiServerContext) => {
    const session = requireRpcSession(context);
    const userId = session.user.id;
    switch (command.type) {
      case "thread.read.mark": {
        const state = await dependencies.store.notificationState.markRead({
          threadId: command.threadId,
          throughSequence: command.throughSequence,
          userId,
        });
        const thread = await dependencies.store.getThreadForOwner(command.threadId, userId);
        if (thread) dependencies.realtime.publishReadState(userId, thread.workspaceId, state);
        // A task read here is no longer bold on the reader's other clients,
        // which may follow other Workspaces than this Thread's.
        dependencies.realtime.publishViewerTasksChanged(userId);
        return { type: command.type, state };
      }
      case "thread.done.set":
        throw new OpensteerError({
          code: "bad_request",
          reason: "shared-task-done-required",
          message:
            "Update Opensteer on this device to mark tasks Done. Done now stops the task for everyone.",
        });
      case "thread.shared-done.set": {
        const result = await dependencies.commands.setThreadDone({
          done: command.done,
          threadId: command.threadId,
          requestedBy: userId,
          idempotencyKey: command.idempotencyKey,
        });
        return {
          type: command.type,
          thread: result.thread,
          asOfSequence: result.asOfSequence,
          wasDuplicate: result.wasDuplicate,
        };
      }
      case "workspace.notifications.update": {
        const preference = await dependencies.store.notificationState.setAgentNotificationMute({
          workspaceId: command.workspaceId,
          muted: command.muted,
          userId,
        });
        dependencies.realtime.publishNotificationPreference(userId, preference);
        return { type: command.type, ...preference };
      }
      case "viewer.timeZone.update":
        return {
          timeZone: await dependencies.store.notificationState.setTimeZone({
            timeZone: command.timeZone,
            userId,
          }),
          type: command.type,
        };
      case "attachment.upload.create":
        return {
          attachment: await dependencies.attachments.reserve({
            workspaceId: command.workspaceId,
            uploaderId: userId,
            name: command.name,
            mediaType: command.mediaType,
            sizeBytes: command.sizeBytes,
            idempotencyKey: command.idempotencyKey,
          }),
          type: command.type,
        };
      case "attachment.upload.discard":
        await dependencies.attachments.discard(command.attachmentId, userId);
        return { type: command.type };
      case "workspace.create": {
        const workspace = await dependencies.workspaces.create({
          ...(command.quotaBytes !== undefined && command.quotaInodes !== undefined
            ? {
                capacityPolicy: {
                  blockHardLimitBytes: command.quotaBytes,
                  inodeHardLimit: command.quotaInodes,
                  kind: "hard-quota" as const,
                },
              }
            : {}),
          createdBy: userId,
          ...(command.icon ? { icon: command.icon } : {}),
          idempotencyKey: command.idempotencyKey,
          kind: "specialized",
          name: command.name,
          ...(command.storage ? { storage: command.storage } : {}),
        });
        if (workspace.storageIssue) {
          app.log.warn(
            { storageIssue: workspace.storageIssue.code, workspaceId: workspace.id },
            "Workspace storage provisioning did not reach ready",
          );
        }
        return {
          type: command.type,
          workspace: await workspaceView(dependencies.workspaces, workspace),
        };
      }
      case "workspace.storage.retry": {
        const workspace = await dependencies.workspaces.retry(command.workspaceId, userId);
        if (workspace.storageIssue) {
          app.log.warn(
            { storageIssue: workspace.storageIssue.code, workspaceId: workspace.id },
            "Workspace storage retry did not reach ready",
          );
        }
        return {
          type: command.type,
          workspace: await workspaceView(dependencies.workspaces, workspace),
        };
      }
      case "workspace.icon.set": {
        const workspace = await dependencies.workspaces.setIcon({
          icon: command.icon,
          idempotencyKey: command.idempotencyKey,
          requestedBy: userId,
          workspaceId: command.workspaceId,
        });
        return {
          type: command.type,
          workspace: await workspaceView(dependencies.workspaces, workspace),
        };
      }
      case "workspace.color.set": {
        const workspace = await dependencies.commands.setWorkspaceColor({
          color: command.color,
          idempotencyKey: command.idempotencyKey,
          requestedBy: userId,
          workspaceId: command.workspaceId,
        });
        return {
          type: command.type,
          workspace: await workspaceView(dependencies.workspaces, workspace),
        };
      }
      case "workspace.delete": {
        const workspace = await dependencies.workspaceDeletion.requestDeletion(
          command.workspaceId,
          userId,
        );
        return {
          type: command.type,
          workspace: await workspaceView(dependencies.workspaces, workspace),
        };
      }
      case "workspace.deletion.recover": {
        const workspace = await dependencies.workspaceDeletion.recover(command.workspaceId, userId);
        return {
          type: command.type,
          workspace: await workspaceView(dependencies.workspaces, workspace),
        };
      }
      case "workspace.invitation.create": {
        if (!deploymentSupportsSharing(dependencies.discovery.document.deploymentShape)) {
          throw new OpensteerError({
            code: "forbidden",
            message: "Workspace sharing is unavailable for this Deployment",
          });
        }
        const workspace = await dependencies.store.getWorkspaceForOwner(
          command.workspaceId,
          userId,
        );
        if (workspace?.kind === "main") {
          throw new OpensteerError({
            code: "forbidden",
            message: "Main cannot be shared. Invite people to a specialist instead.",
          });
        }
        const result = await dependencies.authenticator.identity.createWorkspaceInvitation({
          createdBy: userId,
          idempotencyKey: command.idempotencyKey,
          ...(command.intendedEmail === undefined ? {} : { intendedEmail: command.intendedEmail }),
          lifetimeSeconds: command.lifetimeSeconds,
          role: command.role,
          type: command.invitationType,
          workspaceId: command.workspaceId,
        });
        const invitationUrl = new URL(
          `/invite/${result.invitation.selector}`,
          dependencies.authenticator.publicOrigin,
        );
        invitationUrl.hash = result.verifier;
        return {
          invitation: serializeInvitation(result.invitation),
          invitationUrl: invitationUrl.toString(),
          type: command.type,
        };
      }
      case "workspace.invitation.revoke":
        await dependencies.store.revokeWorkspaceInvitation({
          actorId: userId,
          invitationId: command.invitationId,
          workspaceId: command.workspaceId,
        });
        return { type: command.type };
      case "workspace.member.update": {
        const changed = await dependencies.store.changeWorkspaceMembership({
          actorId: userId,
          ...(command.role ? { role: command.role } : {}),
          ...(command.state ? { state: command.state } : {}),
          targetUserId: command.userId,
          workspaceId: command.workspaceId,
        });
        dependencies.realtime.publishViewerTasksChanged(changed.membership.userId);
        for (const event of changed.requestEvents) publishWorkspaceEvent(event);
        void dependencies.securityEffects
          .reconcile()
          .catch((error) => app.log.error({ err: error }, "Workspace revocation effects failed"));
        const member = await dependencies.store.userById(changed.membership.userId);
        if (!member) {
          throw new OpensteerError({ code: "internal", message: "Workspace member is missing" });
        }
        return {
          membership: {
            displayName: member.displayName,
            email: member.email,
            emailVerified: member.emailVerified,
            generation: changed.membership.generation,
            id: changed.membership.id,
            invitedBy: changed.membership.invitedBy,
            joinedAt: changed.membership.joinedAt.toISOString(),
            role: changed.membership.role,
            state: changed.membership.state,
            userId: changed.membership.userId,
            workspaceId: changed.membership.workspaceId,
          },
          type: command.type,
        };
      }
      case "thread.create": {
        const parent = command.parentThreadId
          ? await dependencies.store.getThreadForOwner(command.parentThreadId, userId)
          : null;
        if (command.parentThreadId && !parent) {
          throw new OpensteerError({ code: "not_found", message: "Parent thread not found" });
        }
        const input = {
          accessMode: command.accessMode ?? parent?.accessMode ?? DEFAULT_THREAD_ACCESS_MODE,
          createdBy: userId,
          environmentId: command.environmentId,
          harnessInstanceId: command.harnessInstanceId,
          idempotencyKey: command.idempotencyKey,
          modelSelection: command.modelSelection,
          ...(command.parentThreadId ? { parentThreadId: command.parentThreadId } : {}),
          ...(command.home ? { home: true } : {}),
          ...(command.generateTitle ? { generateTitle: true as const } : {}),
          title: command.home ? CHAT_THREAD_TITLE : command.title,
          workspaceId: command.workspaceId,
        } as const;
        const workspace = await dependencies.store.getWorkspaceForOwner(
          command.workspaceId,
          userId,
        );
        if (!workspace) {
          throw new OpensteerError({ code: "not_found", message: "Workspace not found" });
        }
        if (command.home) {
          if (workspace.kind !== "main" || workspace.createdBy !== userId || command.parentThreadId)
            throw new OpensteerError({
              code: "bad_request",
              message: "Chat belongs to your Main Workspace",
            });
          if (workspace.homeThreadId) {
            const existingHome = await dependencies.commands.createThread(input);
            return { ...existingHome, type: command.type };
          }
        }
        const existing = await dependencies.store.findThreadCreationByIdempotency(input);
        if (existing) return { ...existing, type: command.type };
        const harness = await dependencies.store.getHarnessInstance(command.harnessInstanceId);
        if (!harness?.enabled || harness.environmentId !== command.environmentId) {
          throw new OpensteerError({
            code: "conflict",
            message: "The selected AI engine is not available",
          });
        }
        const environment = await dependencies.store.getEnvironment(command.environmentId);
        if (!environment) {
          throw new OpensteerError({
            code: "not_found",
            message: "The selected place to run this work no longer exists",
          });
        }
        if (!dependencies.runners.isAvailable(command.environmentId)) {
          throw new OpensteerError({
            code: "conflict",
            message: "The selected place to run this work is not connected",
            retryable: true,
          });
        }
        if (!dependencies.runners.canRunHarness(command.environmentId, harness.driverKind)) {
          throw new OpensteerError({
            code: "conflict",
            message: "The selected AI engine is not available where this work will run",
          });
        }
        assertAccessModeEnforceable(
          dependencies.runners,
          command.environmentId,
          harness.driverKind,
          input.accessMode,
        );
        const available = assertModelSelectionAvailable(
          (await dependencies.store.getHarnessCatalog(environment.id, harness.id)) ?? undefined,
          command.modelSelection,
        );
        const created = await dependencies.commands.createThread({
          ...input,
          modelSelection: storedModelSelection(command.modelSelection, available.model),
        });
        return {
          asOfSequence: created.asOfSequence,
          thread: created.thread,
          type: command.type,
          wasDuplicate: created.wasDuplicate,
        };
      }
      case "assignment.cancel": {
        const result = await dependencies.commands.cancelAssignment({
          assignmentId: command.assignmentId,
          requestedBy: userId,
          idempotencyKey: command.idempotencyKey,
        });
        return {
          assignment: result.assignment,
          type: command.type,
          wasDuplicate: result.wasDuplicate,
        };
      }
      case "thread.sendMessage": {
        return dependencies.commands.withInputAdmission(
          userId,
          command.idempotencyKey,
          async () => {
            if (
              command.content.some(isPlaceContentPart) &&
              !(await dependencies.store.hasAcceptedThreadInput(userId, command.idempotencyKey))
            ) {
              const thread = await dependencies.store.getThreadForOwner(command.threadId, userId);
              if (!thread)
                throw new OpensteerError({ code: "not_found", message: "Thread not found" });
              await dependencies.placeContext.assertIncludable({
                ownerId: userId,
                parts: command.content,
                threadId: thread.id,
                workspaceId: thread.workspaceId,
              });
            }
            const result = await dependencies.commands.enqueueThreadInput({
              ...(command.quotedMessageId ? { quotedMessageId: command.quotedMessageId } : {}),
              content: command.content,
              idempotencyKey: command.idempotencyKey,
              policy: command.delivery ?? "queue",
              requestedBy: userId,
              source: { kind: "human" },
              threadId: command.threadId,
              validateNewAttachmentInput: (selection) => {
                const failure = dependencies.runners.attachmentInputFailure({
                  content: command.content,
                  ...selection,
                });
                if (failure) throw new OpensteerError({ code: "conflict", message: failure });
              },
            });
            // The message's transaction credited its pages to the conversation.
            if (result.browserUsage) dependencies.browser.announceUsage(result.browserUsage);
            return {
              input: result.input,
              message: result.message,
              run: result.run,
              type: command.type,
              wasDuplicate: result.wasDuplicate,
            };
          },
        );
      }
      case "thread.inputQueue.resume": {
        const result = await dependencies.commands.resumeThreadInputQueue({
          idempotencyKey: command.idempotencyKey,
          requestedBy: userId,
          threadId: command.threadId,
        });
        return { type: command.type, thread: result.thread, asOfSequence: result.asOfSequence };
      }
      case "thread.input.steer": {
        const thread = await dependencies.store.getThreadForOwner(command.threadId, userId);
        if (!thread) throw new OpensteerError({ code: "not_found", message: "Thread not found" });
        const result = await dependencies.commands.steerThreadInput({
          threadId: command.threadId,
          messageId: command.messageId,
          expectedRunId: command.expectedRunId,
          idempotencyKey: command.idempotencyKey,
          requestedBy: userId,
        });
        return { type: command.type, input: result.input };
      }
      case "thread.input.cancel": {
        const result = await dependencies.commands.cancelThreadInput({
          idempotencyKey: command.idempotencyKey,
          messageId: command.messageId,
          requestedBy: userId,
          threadId: command.threadId,
        });
        return { type: command.type, input: result.input };
      }
      case "thread.input.move":
        await dependencies.commands.moveThreadInput({
          beforeMessageId: command.beforeMessageId,
          idempotencyKey: command.idempotencyKey,
          messageId: command.messageId,
          requestedBy: userId,
          threadId: command.threadId,
        });
        return { type: command.type };
      case "thread.execution.update": {
        const thread = await dependencies.store.getThreadForOwner(command.threadId, userId);
        if (!thread) throw new OpensteerError({ code: "not_found", message: "Thread not found" });
        if (
          command.continuation &&
          !dependencies.runners
            .identityForEnvironment(thread.environmentId)
            ?.capabilities.includes("native-session-continuation-v1")
        ) {
          throw new OpensteerError({
            code: "conflict",
            message: "Connect an updated Runner before changing this conversation's AI engine",
          });
        }
        const harness = await dependencies.store.getHarnessInstance(command.harnessInstanceId);
        if (!harness?.enabled || harness.environmentId !== thread.environmentId) {
          throw new OpensteerError({ code: "conflict", message: "AI engine is unavailable" });
        }
        // The Thread keeps its access mode across an engine change, so the
        // engine it lands on must be one that can keep that promise.
        assertAccessModeEnforceable(
          dependencies.runners,
          thread.environmentId,
          harness.driverKind,
          thread.accessMode,
        );
        const available = assertModelSelectionAvailable(
          (await dependencies.store.getHarnessCatalog(thread.environmentId, harness.id)) ??
            undefined,
          command.modelSelection,
        );
        return {
          ...(await dependencies.commands.updateThreadExecutionSelection({
            ...(command.continuation ? { continuation: command.continuation } : {}),
            idempotencyKey: command.idempotencyKey,
            continuationIdentity: available.catalog.continuationIdentity,
            harnessInstanceId: command.harnessInstanceId,
            modelSelection: storedModelSelection(command.modelSelection, available.model),
            requestedBy: userId,
            threadId: command.threadId,
          })),
          type: command.type,
        };
      }
      case "thread.rename": {
        const thread = await dependencies.store.getThreadForOwner(command.threadId, userId);
        if (!thread) throw new OpensteerError({ code: "not_found", message: "Thread not found" });
        return {
          ...(await dependencies.commands.renameThread({
            idempotencyKey: command.idempotencyKey,
            requestedBy: userId,
            threadId: command.threadId,
            title: command.title,
          })),
          type: command.type,
        };
      }
      case "thread.icon.set": {
        const thread = await dependencies.store.getThreadForOwner(command.threadId, userId);
        if (!thread) throw new OpensteerError({ code: "not_found", message: "Thread not found" });
        return {
          ...(await dependencies.commands.setThreadIcon({
            idempotencyKey: command.idempotencyKey,
            requestedBy: userId,
            threadId: command.threadId,
            icon: command.icon,
          })),
          type: command.type,
        };
      }
      case "thread.access.update": {
        const thread = await dependencies.store.getThreadForOwner(command.threadId, userId);
        if (!thread) throw new OpensteerError({ code: "not_found", message: "Thread not found" });
        const harness = await dependencies.store.getHarnessInstance(thread.harnessInstanceId);
        if (harness) {
          assertAccessModeEnforceable(
            dependencies.runners,
            thread.environmentId,
            harness.driverKind,
            command.accessMode,
          );
        }
        return {
          ...(await dependencies.commands.updateThreadAccessMode({
            accessMode: command.accessMode,
            requestedBy: userId,
            threadId: command.threadId,
          })),
          type: command.type,
        };
      }
      case "execution.preferences.remember": {
        // A preference is a hint the Host re-validates when a Thread actually
        // starts, so the model is deliberately not checked against a catalog
        // here — a person may remember a model whose Runner is asleep. What is
        // checked is hygiene: the account exists, it lives on the work location
        // named with it, and that work location is one this person can see.
        const selection = command.selection;
        if (selection) {
          const harness = await dependencies.store.getHarnessInstance(selection.harnessInstanceId);
          if (!harness || harness.environmentId !== selection.environmentId) {
            throw new OpensteerError({
              code: "conflict",
              message: "The selected AI engine is not available",
            });
          }
          const environments = await dependencies.store.listEnvironmentsForUser(userId);
          if (!environments.some(({ id }) => id === selection.environmentId)) {
            throw new OpensteerError({
              code: "not_found",
              message: "The selected place to run this work no longer exists",
            });
          }
        }
        const preferences = await dependencies.store.rememberExecutionChoice(userId, {
          ...(command.accessMode === undefined ? {} : { accessMode: command.accessMode }),
          ...(selection === undefined ? {} : { selection }),
        });
        return { preferences, type: command.type };
      }
      case "run.interrupt": {
        const result = await dependencies.commands.sendControl({
          idempotencyKey: command.idempotencyKey,
          requestedBy: userId,
          runId: command.runId,
          threadId: command.threadId,
          type: "run.interrupt",
        });
        return { type: command.type, wasDuplicate: result.wasDuplicate };
      }
      case "request.respond": {
        const pending = await dependencies.store.requests.get(command.requestId);
        if (!pending || pending.status !== "pending") {
          throw new OpensteerError({ code: "conflict", message: "Request is no longer pending" });
        }
        if (pending.mode === "durable") {
          const input = {
            requestId: command.requestId,
            resolvedBy: userId,
            response: command.response,
          };
          await (async (): Promise<void> => {
            switch (pending.kind) {
              // A sign-in is answered by `browser.sign-in.respond`, which can
              // deliver it; a saved-password sign-in is approved only on its
              // Mac and declined with its own command; a copy Request can no
              // longer be answered at all.
              case "browser.sign-in":
              case "browser.password-sign-in":
              case "browser.profile.import":
                throw new OpensteerError({
                  code: "conflict",
                  message:
                    pending.kind === "browser.sign-in"
                      ? "Answer a sign-in Request with browser.sign-in.respond"
                      : pending.kind === "browser.password-sign-in"
                        ? "Approve a saved-password sign-in on its Mac, or decline it with browser.password-sign-in.decline"
                        : "This Request can no longer be answered",
                });
              case "browser.access":
              case "browser.profile.save": {
                const result = await dependencies.browser.resolveRequest(input);
                if (result.request.status === "fulfilled")
                  dependencies.integrations.continuations.notify();
                return;
              }
              case "integration.access":
              case "integration.install": {
                const result = await dependencies.integrations.platform.resolveRequest(input);
                if (result.request.status === "fulfilled")
                  dependencies.integrations.continuations.notify();
                return;
              }
              case "machine.full-disk-access":
                await dependencies.machineFullDiskAccess.decline(input);
                return;
              // Approving happens on the Mac itself, by consuming the setup
              // request; from anywhere else the only answer is a decline, and
              // it takes the pending approval back with it.
              case "computer.app.access":
                await dependencies.integrations.platform.computerAppApprovals.declineComputerAppAccess(
                  input,
                );
                dependencies.integrations.continuations.notify();
                return;
              case "harness.approval":
              case "harness.input":
                throw new OpensteerError({
                  code: "internal",
                  message: "Harness Requests must be live",
                });
            }

            const unreachable: never = pending.kind;
            throw new Error(`Unexpected Request kind: ${unreachable}`);
          })();
        } else {
          const runId = pending.originatingRunId;
          if (runId === null) {
            throw new OpensteerError({
              code: "conflict",
              message: "A live Request is answered into the Run that opened it",
            });
          }
          const sealedResponse = await sealRequestResponse(
            dependencies.requestResponseVault,
            command.response,
            {
              requestId: command.requestId,
              runId,
              threadId: pending.originatingThreadId,
            },
          );
          await dependencies.commands.sendControl({
            idempotencyKey: command.idempotencyKey,
            requestedBy: userId,
            requestId: command.requestId,
            response: command.response,
            runId,
            sealedResponse,
            threadId: pending.originatingThreadId,
            type: "request.respond",
          });
        }
        return { type: command.type };
      }
      case "harness.create": {
        const environment = await admitHarnessManagement(session, command.environmentId);
        const runner = dependencies.runners.identityForEnvironment(environment.id);
        if (!runner) {
          throw new OpensteerError({
            code: "conflict",
            message: "Reconnect this work location before adding an AI engine",
            retryable: true,
          });
        }
        const agents = runner.modules.agents;
        if (!agents?.providerStateModes.includes(command.stateKind)) {
          throw new OpensteerError({
            code: "conflict",
            message: `This work location does not support ${command.stateKind} AI engine state`,
          });
        }
        const driver = agents.harnessDrivers.find(
          ({ driverKind }) => driverKind === command.driverKind,
        );
        if (!driver) {
          throw new OpensteerError({
            code: "conflict",
            message: "This AI engine is not installed on the selected work location",
          });
        }
        if (driver.readiness === "unavailable") {
          throw new OpensteerError({
            code: "conflict",
            message: `This AI engine cannot run on the selected work location: ${driver.reason}`,
          });
        }
        // The engine's declaration is the only authority on what an account of
        // it may be. The Host never carries a list of its own: it finds the
        // source the person chose in what the Runner advertised, and refuses
        // anything the declaration does not cover.
        const source = driver.sources.find(({ sourceId }) => sourceId === command.sourceId);
        if (!source) {
          throw new OpensteerError({
            code: "conflict",
            message: "This AI engine does not offer that source here",
          });
        }
        if (!source.stateKinds.includes(command.stateKind)) {
          throw new OpensteerError({
            code: "conflict",
            message: `${source.label} accounts only support ${source.stateKinds.join(" or ")} AI engine state`,
          });
        }
        const harness = await dependencies.store.createHarnessInstance({
          config: validatedHarnessSourceConfig(source, command.config),
          driverKind: command.driverKind,
          environmentId: environment.id,
          idempotency: { key: command.idempotencyKey, requestedBy: userId },
          name: command.name,
          sourceId: source.sourceId,
          stateKind: command.stateKind,
        });
        harnessCatalogReconciliations.schedule(environment.id);
        return { harness: harnessView(harness), type: command.type };
      }
      case "harness.model.configure": {
        const environment = await admitHarnessManagement(session, command.environmentId);
        const current = await dependencies.store.getHarnessInstance(command.harnessInstanceId);
        if (!current || current.environmentId !== environment.id || current.removedAt) {
          throw new OpensteerError({ code: "not_found", message: "AI engine not found" });
        }
        const driver = dependencies.runners
          .identityForEnvironment(environment.id)
          ?.modules.agents?.harnessDrivers.find(
            (candidate) => candidate.driverKind === current.driverKind,
          );
        const source =
          driver && driver.readiness !== "unavailable"
            ? driver.sources.find((candidate) => candidate.sourceId === current.sourceId)
            : undefined;
        if (!source?.modelSettings) {
          throw new OpensteerError({
            code: "conflict",
            message:
              "This account does not currently offer model settings. Reconnect its computer and refresh.",
          });
        }
        const config = z.record(z.string(), z.unknown()).parse(current.config);
        const currentModels = HarnessModelSettingsMapSchema.parse(config.models ?? {});
        const catalog = await dependencies.store.getHarnessCatalog(environment.id, current.id);
        if (
          !Object.hasOwn(currentModels, command.nativeModelId) &&
          !(
            catalog?.status === "ready" &&
            catalog.models.some(
              (model) => (model.nativeModelId ?? model.modelId) === command.nativeModelId,
            )
          )
        ) {
          throw new OpensteerError({
            code: "conflict",
            message: "This server has not reported that model. Refresh its model list first.",
          });
        }
        const models =
          command.settings === null
            ? Object.fromEntries(
                Object.entries(currentModels).filter(([id]) => id !== command.nativeModelId),
              )
            : { ...currentModels, [command.nativeModelId]: command.settings };
        const harness = await dependencies.store.updateHarnessInstance({
          id: current.id,
          expectedRuntimeRevision: current.runtimeRevision,
          config: { ...config, models },
        });
        harnessCatalogReconciliations.schedule(environment.id);
        return { harness: harnessView(harness), type: command.type };
      }
      case "harness.rename":
      case "harness.enabled.set": {
        const environment = await admitHarnessManagement(session, command.environmentId);
        const current = await dependencies.store.getHarnessInstance(command.harnessInstanceId);
        if (!current || current.environmentId !== environment.id) {
          throw new OpensteerError({ code: "not_found", message: "AI engine not found" });
        }
        const harness = await dependencies.store.updateHarnessInstance({
          ...(command.type === "harness.enabled.set" ? { enabled: command.enabled } : {}),
          id: command.harnessInstanceId,
          ...(command.type === "harness.rename" ? { name: command.name } : {}),
        });
        if (command.type === "harness.enabled.set") {
          harnessCatalogReconciliations.schedule(environment.id);
        }
        return { harness: harnessView(harness), type: command.type };
      }
      case "harness.default.set": {
        // Which account of an engine a placement lands on is a stored choice,
        // not a configuration change, so no catalog has gone stale here.
        const environment = await admitHarnessManagement(session, command.environmentId);
        const current = await dependencies.store.getHarnessInstance(command.harnessInstanceId);
        if (!current || current.environmentId !== environment.id) {
          throw new OpensteerError({ code: "not_found", message: "AI engine not found" });
        }
        const harness = await dependencies.store.setDefaultHarnessInstance({
          environmentId: environment.id,
          harnessInstanceId: command.harnessInstanceId,
        });
        return { harness: harnessView(harness), type: command.type };
      }
      case "harness.delete": {
        const environment = await admitHarnessManagement(session, command.environmentId);
        const current = await dependencies.store.getHarnessInstance(command.harnessInstanceId);
        if (!current || current.environmentId !== environment.id) {
          throw new OpensteerError({ code: "not_found", message: "AI engine not found" });
        }
        await admitAmbientDestructiveAction(session, environment.id, current.stateKind);
        if (!dependencies.runners.identityForEnvironment(environment.id)) {
          throw new OpensteerError({
            code: "conflict",
            message: "Reconnect this work location before removing an AI engine",
            retryable: true,
          });
        }
        await dependencies.store.removeHarnessInstance(environment.id, command.harnessInstanceId);
        await harnessAuthenticationCoordinator.remove(
          {
            environment: { id: environment.id, kind: environment.kind },
            harness: harnessInspectionDefinition(current),
          },
          AbortSignal.timeout(30_000),
        );
        harnessCatalogReconciliations.schedule(environment.id);
        return { type: command.type };
      }
      case "harness.authentication.begin": {
        const target = await admitHarnessAuthentication(session, {
          environmentId: command.environmentId,
          harnessInstanceId: command.harnessInstanceId,
        });
        const selection = {
          ...(command.connectionSlot ? { connectionSlot: command.connectionSlot } : {}),
          methodId: command.methodId,
        };
        await assertSetupMethodAvailable(dependencies.store, target, selection);
        const envelope = await harnessAuthenticationCoordinator.ensure(
          target,
          AbortSignal.timeout(30_000),
          selection,
        );
        await captureAuthenticatedHarness(target, envelope.authentication);
        return { ...envelope, type: command.type };
      }
      case "harness.authentication.submit": {
        const target = await admitHarnessAuthentication(session, {
          environmentId: command.environmentId,
          harnessInstanceId: command.harnessInstanceId,
        });
        await assertSetupMethodAvailable(dependencies.store, target, {});
        const envelope = await harnessAuthenticationCoordinator.submit(
          target,
          command.value,
          AbortSignal.timeout(30_000),
        );
        await captureAuthenticatedHarness(target, envelope.authentication);
        return { ...envelope, type: command.type };
      }
      case "harness.authentication.cancel": {
        const target = await admitHarnessAuthentication(session, {
          environmentId: command.environmentId,
          harnessInstanceId: command.harnessInstanceId,
        });
        return {
          ...(await harnessAuthenticationCoordinator.cancel(target, AbortSignal.timeout(30_000))),
          type: command.type,
        };
      }
      case "harness.authentication.logout": {
        const target = await admitHarnessAuthentication(session, {
          environmentId: command.environmentId,
          harnessInstanceId: command.harnessInstanceId,
        });
        await admitAmbientDestructiveAction(
          session,
          target.environment.id,
          target.harness.stateKind,
        );
        await assertLogoutAvailable(dependencies.store, target, command.connectionSlot);
        await assertHarnessIsIdle(target.environment.id, target.harness.id, "signing it out");
        const envelope = await harnessAuthenticationCoordinator.logout(
          target,
          AbortSignal.timeout(30_000),
          command.connectionSlot,
        );
        await dependencies.store.discardHarnessCatalog(target.environment.id, target.harness.id);
        harnessCatalogReconciliations.schedule(target.environment.id);
        return { ...envelope, type: command.type };
      }
      case "machine.revoke": {
        const allowDeployment = session.user.instanceRole === "administrator";
        const runnerId = RunnerIdSchema.parse(command.machineId);
        // Order matters and is the whole point of the operation. The durable
        // write lands first — tombstone plus generation bump, plus every module
        // effect that outlives a socket — so a Host that dies mid-revocation
        // still refuses this machine on its next connection. Only then are the
        // live streams torn down, which is what stops work already in flight.
        const revoked = await dependencies.shellControl.withMachineAdmission(runnerId, () =>
          dependencies.computerApps.withRunnerAdmission(runnerId, () =>
            dependencies.store.revokeRunner(runnerId, userId, {
              allowDeployment,
              allowOtherOwners: allowDeployment,
            }),
          ),
        );
        // Between the durable write and the stream teardown: a session ended
        // before the tombstone landed could be reopened by a caller that raced
        // the revoke, and one ended after the stream went would have already
        // been recorded as a disconnection rather than as this revocation.
        await dependencies.shellControl.endMachineSessions(runnerId, "machine-revoked");
        await dependencies.runners.revoke(runnerId);
        dependencies.channels.relay.forget(runnerId);
        // The apps this computer was lending are gone with its connections, and
        // a call still waiting on its stream is answered by the loss rules.
        dependencies.computerApps.detachRunner(runnerId, "revoked");
        for (const sessionId of revoked.closedBrowserSessions) {
          dependencies.browser.abandonSession(sessionId);
        }
        // The queued work this machine will now never claim has been failed
        // durably; these are the terminal events its Threads are waiting on.
        for (const event of revoked.events) publishWorkspaceEvent(event);
        for (const event of revoked.requestEvents) publishWorkspaceEvent(event);
        if (revoked.cancelledRequestIds.length > 0) {
          dependencies.integrations.continuations.notify();
        }
        notifyMachinesChanged(dependencies.realtime, "machine.command");
        return { type: command.type };
      }
      case "machine.rename": {
        const allowDeployment = session.user.instanceRole === "administrator";
        await dependencies.store.renameRunner(
          RunnerIdSchema.parse(command.machineId),
          userId,
          command.name,
          { allowDeployment },
        );
        notifyMachinesChanged(dependencies.realtime, "machine.command");
        return { type: command.type };
      }
      case "machine.access.update": {
        await requireMachineAccessManagement(dependencies.store, session, command.runnerId);
        // Inside this machine's admission turn: an activation that is part-way
        // through re-reading the policy it was admitted under must either see
        // the old revision and finish, or see the new one and end — never
        // commit against a revision this write already replaced.
        const result = await dependencies.shellControl.withMachineAdmission(command.runnerId, () =>
          dependencies.store.updateMachineAccessPolicy({
            allowDeployment: session.user.instanceRole === "administrator",
            expectedRevision: command.expectedRevision,
            idempotency: { key: command.idempotencyKey, requestedBy: userId },
            ownerId: userId,
            policy: command.policy,
            runnerId: command.runnerId,
          }),
        );
        if (result.outcome === "conflict") {
          // Nothing was written, so nothing about the live sessions changed.
          return { outcome: "conflict" as const, type: command.type };
        }
        // Every write bumps the revision, an equal-value one included: the
        // policy a live session is running under is a snapshot taken when it
        // opened, and the only honest way to apply a new one is to end them
        // and let the next `ssh` start under it. A replay is not a write: it
        // committed nothing, and the sessions open now may well have started
        // after the save it is replaying, under the policy it describes.
        if (!result.replayed) {
          await dependencies.shellControl.endMachineSessions(command.runnerId, "policy-changed");
        }
        // A replay wrote nothing, but the row it is replaying is what this
        // caller is about to read back, and the revision it reports is already
        // live for everybody else.
        notifyMachinesChanged(dependencies.realtime, "machine.command");
        return { outcome: "updated" as const, revision: result.revision, type: command.type };
      }
      case "machine.access.session.stop": {
        // The full row resolves and authorizes the Stop even for an ended
        // session; an unknown id discloses nothing beyond "nothing to end".
        const shellSession = await dependencies.store.getShellSession(command.sessionId);
        if (!shellSession) return { ended: false, type: command.type };
        await requireMachineAccessManagement(dependencies.store, session, shellSession.runnerId);
        // Through the hub, so a Stop takes the sockets away as well as writing
        // the row; it is the same idempotent ending every other path uses. The
        // key travels with it so a retried click reads back what the first one
        // did rather than "nothing was open", and closes nothing a second time.
        const { ended } = await dependencies.shellControl.end(
          command.sessionId,
          "stopped-by-owner",
          { idempotency: { key: command.idempotencyKey, requestedBy: userId } },
        );
        return { ended, type: command.type };
      }
      case "session.revoke":
        await dependencies.authenticator.identity.revokeSession(session, command.sessionId);
        return { type: command.type };
      case "runner.enrollment.createManaged": {
        requireInstanceAdministrator(session);
        const enrollment = await dependencies.runnerAuthenticator.createEnrollment({
          allowedModules: command.allowedModules,
          createdBy: userId,
          idempotencyKey: command.idempotencyKey,
          lifetimeSeconds: 600,
          name: command.name,
          runnerKind: "managed",
        });
        // A pending computer is a row on the list, so minting one changes it.
        notifyMachinesChanged(dependencies.realtime, "machine.command");
        return {
          enrollmentId: enrollment.enrollmentId,
          expiresAt: enrollment.expiresAt,
          token: enrollment.token,
          type: command.type,
        };
      }
      case "runner.enrollment.createLocal": {
        const enrollment = await dependencies.runnerAuthenticator.createEnrollment({
          allowedModules: command.allowedModules,
          createdBy: userId,
          idempotencyKey: command.idempotencyKey,
          lifetimeSeconds: 600,
          name: command.name,
          runnerKind: "local",
        });
        notifyMachinesChanged(dependencies.realtime, "machine.command");
        return {
          enrollmentId: enrollment.enrollmentId,
          expiresAt: enrollment.expiresAt,
          token: enrollment.token,
          type: command.type,
        };
      }
      case "runner.enrollment.createPhone": {
        // Where the phone will reach this Host is settled before anything is
        // minted: a token for an address no phone can use is one nobody can
        // redeem, and a Personal Deployment with remote access off has none.
        const pairing = await agentPhoneHostTarget(dependencies);
        const enrollment = await dependencies.runnerAuthenticator.createPhoneEnrollment({
          createdBy: userId,
          idempotencyKey: command.idempotencyKey,
          lifetimeSeconds: 600,
          name: command.name,
          ...(command.profile ? { profile: command.profile } : {}),
        });
        notifyMachinesChanged(dependencies.realtime, "machine.command");
        return {
          enrollmentId: enrollment.enrollmentId,
          expiresAt: enrollment.expiresAt,
          pairing,
          token: enrollment.token,
          type: command.type,
        };
      }
      case "runner.enrollment.retire": {
        // Only the enrollment's own owner reaches it; anyone else is told it
        // does not exist.
        const state = await dependencies.store.retireRunnerEnrollment({
          enrollmentId: command.enrollmentId,
          ownerId: userId,
        });
        // A retired enrollment leaves the pending computers.
        if (state === "retired") notifyMachinesChanged(dependencies.realtime, "machine.command");
        return { state, type: command.type };
      }
      case "browser.session.start": {
        if (command.input.threadId) {
          const thread = await dependencies.store.getThreadForOwner(command.input.threadId, userId);
          if (!thread || thread.workspaceId !== command.workspaceId) {
            throw new OpensteerError({
              code: "not_found",
              message: "Browser conversation not found.",
            });
          }
        }
        const start = {
          ...(command.input.threadId ? { threadId: command.input.threadId } : {}),
          ...(command.input.initialUrl === undefined
            ? {}
            : { initialUrl: command.input.initialUrl }),
          ownerId: userId,
          ...(command.input.placement === undefined ? {} : { placement: command.input.placement }),
          reuseExisting: command.input.reuseExisting,
          ...(command.input.viewport === undefined ? {} : { viewport: command.input.viewport }),
          workspaceId: command.workspaceId,
        };
        const result = await dependencies.browser.start(
          "profileId" in command.input
            ? { ...start, profileId: command.input.profileId }
            : { ...start, fresh: true },
          { typed: false },
        );
        return { ...result, type: command.type };
      }
      case "browser.profile.create":
        return {
          profile: await dependencies.browser.createProfile({
            name: command.input.name,
            idempotencyKey: command.idempotencyKey,
            workspaceId: null,
            ownerId: userId,
          }),
          type: command.type,
        };
      case "browser.session.profile.save":
        return {
          profile: await dependencies.browser.saveSessionAsProfile({
            name: command.input.name,
            ownerId: userId,
            sessionId: BrowserSessionIdSchema.parse(command.sessionId),
          }),
          type: command.type,
        };
      case "browser.profile.grant":
        return {
          grant: await dependencies.browser.grantProfileToWorkspace({
            access: "full-control",
            createdBy: userId,
            profileId: command.profileId,
            workspaceId: command.workspaceId,
          }),
          type: command.type,
        };
      case "browser.profile.rename":
        return {
          profile: await dependencies.browser.renameProfile({
            name: command.name,
            ownerId: userId,
            profileId: command.profileId,
          }),
          type: command.type,
        };
      case "browser.profile.delete": {
        const deletion = await dependencies.browser.deleteProfile({
          ownerId: userId,
          profileId: command.profileId,
        });
        return { type: command.type, ...(deletion ? { deletion } : {}) };
      }
      case "browser.profileGrant.revoke": {
        const revoked = await dependencies.store.revokeBrowserProfileGrant(command.grantId, userId);
        await dependencies.browser.detachAgentSessionsForRevokedProfileGrant({
          ownerId: userId,
          profileId: revoked.profileId,
          workspaceId: revoked.workspaceId,
        });
        return { type: command.type };
      }
      case "workspace.tabs.group": {
        const { type, ...input } = command;
        return {
          type,
          ...(await dependencies.browserTabs.group({ kind: "person", ownerId: userId }, input)),
        };
      }
      case "workspace.tabs.ungroup":
        return {
          type: command.type,
          layout: await dependencies.browserTabs.ungroup(
            { kind: "person", ownerId: userId },
            command.tabIds,
            command.idempotencyKey,
          ),
        };
      case "workspace.tabs.move": {
        const { type, ...input } = command;
        return {
          type,
          layout: await dependencies.browserTabs.move({ kind: "person", ownerId: userId }, input),
        };
      }
      case "workspace.tabGroup.update": {
        const { type, ...input } = command;
        return {
          type,
          layout: await dependencies.browserTabs.update({ kind: "person", ownerId: userId }, input),
        };
      }
      case "workspace.tabs.close":
        return {
          type: command.type,
          ...(await dependencies.browserTabs.close(
            { kind: "person", ownerId: userId },
            command.tabIds,
          )),
        };
      case "workspace.tab.activate":
        return dependencies.browser.activateWorkspaceTab(userId, command.tabId);
      case "workspace.tab.reopen":
        return dependencies.browser.reopenWorkspaceTab(userId, command.idempotencyKey);
      case "workspace.tab.close":
        return dependencies.browser.closeWorkspaceTab(userId, command.tabId);
      case "browser.profile.prepare":
        await dependencies.browser.prepareProfile(userId, command.identity);
        return { type: command.type };
      case "browser.history.remove":
      case "browser.history.clear":
        await dependencies.browser.forgetHistory(userId, command);
        return { type: command.type };
      case "browser.tab.open":
        return dependencies.browser.openTab(userId, command);
      case "browser.tab.close":
        return dependencies.browser.closeTab(userId, command);
      case "browser.session.close":
        await dependencies.browser.stop(userId, BrowserSessionIdSchema.parse(command.sessionId));
        return { type: command.type };
    }
  };

  const handleCoreCommand = async (command: CoreCommand, context: HostApiServerContext) =>
    hostApi["commands.dispatch"].success.parse(await executeCoreCommand(command, context));

  const identityRpcHandlers = createIdentityRpcHandlers(dependencies.authenticator, {
    workspaceSharingAvailable,
  });

  registerHostApi(
    app,
    dependencies.authenticator,
    createHostApiHandlers(
      {
        ...identityRpcHandlers,
        "auth.invitation.accept": async (input, context) => {
          const result = await identityRpcHandlers["auth.invitation.accept"](input, context);
          if (result.ok)
            dependencies.realtime.publishViewerTasksChanged(result.data.membership.userId);
          return result;
        },
      },
      createTriggerRpcHandlers(dependencies.triggers.service),
      dependencies.triggers.service,
      createIntegrationRpcHandlers(integrationRpcOptions),
      integrationRpcOptions,
      createIntegrationAuthorizationRpcHandlers(integrationAuthorizationRpcOptions),
      integrationAuthorizationRpcOptions,
      createIntegrationPlatformRpcHandlers(integrationPlatformRpcOptions),
      integrationPlatformRpcOptions,
      createChannelRpcHandlers(dependencies.channels.service),
      dependencies.channels.service,
      createBrowserSourceRpcHandlers(browserSourceRpcOptions),
      browserSourceRpcOptions,
      coreRpcHandlers,
      handleCoreCommand,
      dependencies.computerViews,
    ),
  );

  app.get("/v1/runner/attachments", async (request, reply) => {
    const token = requireBearerToken(request);
    const query = z.strictObject({ after: AttachmentIdSchema.optional() }).parse(request.query);
    const page = await dependencies.attachments.listForRun(token, query.after ?? null);
    return reply.header("cache-control", "no-store").send(page);
  });

  app.get("/v1/runner/attachments/:attachmentId/content", async (request, reply) => {
    const token = requireBearerToken(request);
    const { attachmentId } = z
      .strictObject({ attachmentId: AttachmentIdSchema })
      .parse(request.params);
    const content = await dependencies.attachments.contentForRun(token, attachmentId);
    return reply
      .header("cache-control", "no-store")
      .header("content-disposition", "attachment")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("x-content-type-options", "nosniff")
      .header("etag", content.metadata.etag)
      .type(content.metadata.contentType)
      .send(Buffer.from(content.bytes));
  });

  if (dependencies.portablefs) {
    app.post(hostInternalRoutePaths.mountGrantExchange, async (request) => {
      const token = requireBearerToken(request);
      return dependencies.portablefs!.mountExchange.exchange(token, request.body);
    });
  }

  app.post(hostInternalRoutePaths.agentControl, async (request) => {
    const token = requireBearerToken(request);
    return dependencies.agentControl.handle(token, request.body);
  });

  app.get(hostInternalRoutePaths.triggerRevisionProgram, async (request, reply) => {
    const token = requireBearerToken(request);
    const params = z.strictObject({ revisionId: TriggerRevisionIdSchema }).parse(request.params);
    return reply
      .header("cache-control", "private, immutable")
      .send(await dependencies.triggers.watchPrograms.get(token, params.revisionId));
  });

  app.route({
    bodyLimit: agentToolPayloadMaxSerializedBytes + 32 * 1_024,
    handler: async (request, reply) => {
      const token = requireBearerToken(request);
      reply.hijack();
      await dependencies.agentTools.handle(request.raw, reply.raw, request.body, token);
    },
    method: ["GET", "POST", "DELETE"],
    url: hostInternalRoutePaths.mcp,
  });

  app.route({
    bodyLimit: agentToolPayloadMaxSerializedBytes + 32 * 1_024,
    handler: async (request, reply) => {
      const token = requireBearerToken(request);
      reply.hijack();
      await dependencies.integrations.tools.handle(request.raw, reply.raw, request.body, token);
    },
    method: ["GET", "POST", "DELETE"],
    url: hostInternalRoutePaths.integrationMcp,
  });

  app.get(hostInternalRoutePaths.integrationSkills, async (request, reply) => {
    const token = requireBearerToken(request);
    return reply
      .header("cache-control", "no-store")
      .send(await dependencies.integrations.skills.bundle(token));
  });

  app.post(hostInternalRoutePaths.egress, { bodyLimit: 12 * 1_024 * 1_024 }, async (request) => {
    const token = requireBearerToken(request);
    return dependencies.egress.forward(token, request.body);
  });

  app.get(hostInternalRoutePaths.phoneUpdate, { websocket: true }, (socket) => {
    const releaseChallenge = runnerChallenges.acquire();
    if (!releaseChallenge) return socket.close(1013, "Phone update capacity reached");
    phoneUpdates.attach(socket, releaseChallenge);
  });

  app.get(hostInternalRoutePaths.runners, { websocket: true }, (socket) => {
    const releaseChallenge = runnerChallenges.acquire();
    if (!releaseChallenge) {
      socket.close(1013, "Runner authentication capacity reached");
      return;
    }
    attachRunnerSocket(
      socket,
      dependencies.runnerAuthenticator,
      dependencies.runners,
      releaseChallenge,
      app.log,
      async (identity) => {
        if (dependencies.runners.isRunnerConnected(identity.runnerId)) return;
        if (await dependencies.store.recordRunnerUpdateRequired(identity)) {
          notifyMachinesChanged(dependencies.realtime, "machine.command");
        }
      },
      dependencies.phoneUpdateRelease ??
        (() => dependencies.staticDistribution?.service.agentPhoneRelease ?? null),
    );
  });

  /**
   * One route for every module that needs a stream beside the primary Runner
   * connection. The module is part of the path only so the Host knows which
   * challenge to issue; authority comes entirely from the ticket the primary
   * connection asked for and the Runner key proof presented with it.
   */
  app.get<{ readonly Params: { readonly module: string } }>(
    hostInternalRoutePaths.runnerAuxiliary,
    { websocket: true },
    (socket, request) => {
      const module = RunnerAuxiliaryModuleSchema.safeParse(request.params.module);
      if (!module.success) {
        app.log.warn(
          { outcome: "refused", reason: "unknown-module" },
          "Runner auxiliary upgrade outcome",
        );
        socket.close(1008, "Unknown Runner module");
        return;
      }
      const releaseChallenge = auxiliaryChallenges.acquire();
      if (!releaseChallenge) {
        app.log.warn(
          { module: module.data, outcome: "refused", reason: "authentication-capacity" },
          "Runner auxiliary upgrade outcome",
        );
        socket.close(1013, "Runner authentication capacity reached");
        return;
      }
      attachRunnerAuxiliarySocket({
        passkeys: dependencies.passkeys,
        log: app.log,
        browserAttachPublicKeys: dependencies.browserAttachPublicKeys,
        browserRelay: dependencies.browserRelay,
        channels: dependencies.channels.service,
        computerApps: dependencies.computerApps,
        module: module.data,
        authenticator: dependencies.runnerAuthenticator,
        messagingRelay: dependencies.channels.relay,
        releaseChallenge,
        runners: dependencies.runners,
        shellControl: dependencies.shellControl,
        socket,
      });
    },
  );

  registerShellRoutes(app, { shell: dependencies.shellControl });
  if (dependencies.displayStreams)
    registerComputerUseDisplayRoutes(app, {
      hub: dependencies.displayStreams,
      authenticator: dependencies.authenticator,
    });

  app.get(
    "/v1/realtime",
    {
      preValidation: async (request) => {
        // Cookie-authenticated WebSocket handshakes are sensitive reads. Bind
        // them to the configured UI origin just like browser-control sockets;
        // bearer-authenticated non-browser clients remain origin-independent.
        const session = await dependencies.authenticator.authenticateSession(request.headers, {
          mutation: true,
        });
        realtimeSocketSessions.set(request.raw, session);
      },
      websocket: true,
    },
    (socket, request) => {
      const session = realtimeSocketSessions.get(request.raw);
      if (!session) return socket.close(1008, "Authentication required");
      attachRealtimeSocket(
        socket,
        dependencies.realtime,
        dependencies.workspaces,
        session,
        request.log,
      );
    },
  );

  app.get<{
    Params: { sessionId: string };
    Querystring: { mode?: string; editing?: string; passkeys?: string };
  }>(
    "/v1/browser-sessions/:sessionId/connect",
    {
      preValidation: async (request) => {
        const session = await dependencies.authenticator.authenticateSession(request.headers, {
          mutation: true,
        });
        const mode = request.query.mode ?? "control";
        if (mode !== "control" && mode !== "watch") {
          throw new OpensteerError({
            code: "bad_request",
            message: "Invalid browser attachment mode.",
          });
        }
        browserSocketSessions.set(request.raw, {
          mode,
          session,
          passkeys:
            dependencies.passkeys === true &&
            (request.query.passkeys === "native" || request.query.passkeys === "notice")
              ? request.query.passkeys
              : undefined,
          editing:
            request.query.editing === "2" ? 2 : request.query.editing === "1" ? 1 : undefined,
        });
      },
      websocket: true,
    },
    (socket, request) => {
      const admitted = browserSocketSessions.get(request.raw);
      if (!admitted) return socket.close(1008, "Authentication required");
      attachBrowserSocket(
        socket,
        dependencies.browser,
        admitted.session,
        BrowserSessionIdSchema.parse(request.params.sessionId),
        admitted.mode,
        admitted.editing,
        admitted.passkeys,
        async () => {
          try {
            const current = await dependencies.authenticator.authenticateSession(request.headers, {
              mutation: true,
            });
            return current.id === admitted.session.id;
          } catch (error) {
            if (error instanceof OpensteerError && error.code === "unauthorized") return false;
            throw error;
          }
        },
      );
    },
  );

  dependencies.staticDistribution?.service.register(app);
  return app;
}

export async function advertisedBootstrapMethods(
  dependencies: Pick<
    HostServerDependencies,
    "authenticator" | "localBootstrap" | "personalRemoteAccess"
  >,
): Promise<readonly HostBootstrapMethod[]> {
  const identity = await dependencies.authenticator.identity.configuration();
  const sessionMethods = [
    ...availableSessionExchangeArms({
      personalRemoteAccess: dependencies.personalRemoteAccess?.service,
    }).keys(),
  ].map((kind): HostBootstrapMethod =>
    kind === "account-connect-grant" ? "connect-grant" : "pairing-code",
  );
  return [
    ...sessionMethods,
    ...(identity.localPasswordEnabled ? (["password"] as const) : []),
    ...(identity.oidcProviders.length > 0 ? (["oidc"] as const) : []),
  ];
}

/**
 * The optional features this Deployment actually serves.
 *
 * Each one is read from the same fact that decided whether its routes were
 * registered at all, so the descriptor can never advertise a surface that
 * answers 404.
 */
export function advertisedCapabilities(
  dependencies: Pick<
    HostServerDependencies,
    "attachments" | "authenticator" | "personalRemoteAccess" | "passkeys"
  >,
): readonly HostCapability[] {
  return [
    "chat-attachments",
    "voice-v1",
    "voice-agent-v1",
    "thread-titles-v1",
    "task-marks-v1",
    "task-family-v1",
    "snapshot-messages-omit-v1",
    "shared-task-done-v1",
    "iphone-apps-v1",
    "ownerViewWindows",
    "browser-target-control-v1",
    "browser-local-profiles-v1",
    "browser-profile-prepare-v1",
    "browser-initial-navigation-v1",
    ...(dependencies.passkeys === true ? ["browser-passkeys-v1" as const] : []),
    "browser-frame-window-v1",
    "browser-raster-demand-v1",
    "browser-capture-region-v1",
    "browser-search-suggestions-v1",
    "workspace-tab-reopen-v1",
    "browser-profile-manage-v1",
    ...(dependencies.authenticator.identity.nativeOpenIdConfiguration()
      ? (["native-oauth"] as const)
      : []),
    ...(availableSessionExchangeArms({
      personalRemoteAccess: dependencies.personalRemoteAccess?.service,
    }).size > 0
      ? (["personal-session-header"] as const)
      : []),
  ];
}

function attachBrowserSocket(
  socket: WebSocket,
  browser: BrowserService,
  session: AuthenticatedSession,
  sessionId: import("@opensteer/protocol").BrowserSessionId,
  mode: "control" | "watch",
  editing: 1 | 2 | undefined,
  passkeys: "native" | "notice" | undefined,
  signedIn: () => Promise<boolean>,
): void {
  installWebSocketLiveness(socket);
  // As on the realtime socket: an expired credential ends this connection and
  // the client reconnects with the one it holds now.
  const cancelExpiration = scheduleWebSocketExpiration(
    Math.min(Date.parse(session.expiresAt), Date.parse(session.absoluteExpiresAt)),
    () => {
      if (socket.readyState === socket.OPEN) {
        socket.close(browserViewerCloseCodes.loginEnded, "Browser login expired");
      }
    },
  );
  socket.once("close", cancelExpiration);
  const peer = browserConsumerPeer(socket, `browser-consumer:${randomUUID()}`);
  const inbox = new BoundedAsyncInbox<{ readonly frame: Buffer; readonly isBinary: boolean }>({
    flow: {
      highWaterBytes: maxWebSocketFrameBytes,
      highWaterItems: 16,
      pause: () => socket.pause(),
      resume: () => socket.resume(),
    },
    maxBytes: 4 * maxWebSocketFrameBytes,
    maxItems: 64,
  });
  let attachment: BrowserConsumerAttachment | undefined;
  socket.on("message", (raw, isBinary) => {
    try {
      const frame = rawDataBuffer(raw);
      if (frame.byteLength > maxWebSocketFrameBytes) {
        throw badMessage("Browser command is too large");
      }
      inbox.push({ bytes: frame.byteLength, value: { frame, isBinary } });
    } catch (error) {
      inbox.close(error);
      if (socket.readyState === socket.OPEN) socket.close(1009, "browser input queue exceeded");
    }
  });
  const disconnected = () => {
    inbox.close();
    attachment?.close();
  };
  socket.once("close", disconnected);
  socket.once("error", (error) => {
    inbox.close(error);
    attachment?.close();
  });
  void (async () => {
    attachment = await browser.attach(session.user.id, sessionId, peer, {
      authSessionId: session.id,
      mode,
      editing,
      passkeys,
      signedIn,
    });
    if (socket.readyState !== socket.OPEN) {
      attachment.close();
      return;
    }
    try {
      for await (const item of inbox) await attachment.handle(item.frame, item.isBinary);
    } finally {
      attachment.close();
    }
  })().catch((error) => closeProtocolSocket(socket, error));
}

function attachRunnerSocket(
  socket: WebSocket,
  authenticator: RunnerAuthenticator,
  runners: RunnerRegistry,
  releaseChallenge: () => void,
  log: FastifyInstance["log"],
  recordUpdateRequired: (identity: {
    readonly runnerId: RunnerId;
    readonly connectionGeneration: number;
    readonly reason: "agent-phone-outdated" | "runner-outdated";
  }) => Promise<void>,
  phoneRelease: () => AgentPhoneUpdateRelease | null,
): void {
  const peer = jsonPeer<HostToRunnerMessage>(socket, `runner-peer:${randomUUID()}`);
  // A Run can stream many small events at once, for example a command's output
  // delta by delta. The Runner awaits each frame's write, so pausing the socket
  // slows it at the source; the ceiling leaves room for the rest of one read.
  const inbox = new BoundedAsyncInbox<{ readonly frame: Buffer; readonly isBinary: boolean }>({
    flow: {
      highWaterBytes: maxWebSocketFrameBytes,
      highWaterItems: 256,
      pause: () => socket.pause(),
      resume: () => socket.resume(),
    },
    maxBytes: 4 * maxWebSocketFrameBytes,
    maxItems: 4_096,
  });
  /** The proven identity behind this socket, once it has proven one. */
  let runner: RunnerIdentity | undefined;
  const challenge = authenticator.issueChallenge();
  const challengeTimeout = setTimeout(
    () => {
      if (!runner && socket.readyState === socket.OPEN) {
        socket.close(1008, "Runner authentication timeout");
      }
    },
    Math.max(1, Date.parse(challenge.expiresAt) - Date.now()),
  );
  challengeTimeout.unref();
  socket.on("message", (frame, isBinary) => {
    try {
      const buffer = rawDataBuffer(frame);
      if (buffer.byteLength > maxWebSocketFrameBytes) {
        throw badMessage("Runner message is too large");
      }
      inbox.push({ bytes: buffer.byteLength, value: { frame: buffer, isBinary } });
    } catch (error) {
      inbox.close(error);
      if (socket.readyState === socket.OPEN) socket.close(1009, "runner input queue exceeded");
    }
  });
  const disconnected = () => {
    releaseChallenge();
    clearTimeout(challengeTimeout);
    inbox.close();
    runners.disconnect(peer);
  };
  socket.once("close", disconnected);
  socket.once("error", disconnected);
  let failed = false;
  const fail = (error: unknown) => {
    if (failed) return;
    failed = true;
    // The registry replaces this cause with a plain "Runner disconnected", so
    // without this line an operator never learns that, say, a durable write
    // refused the event the Runner had just sent.
    log.error(
      { bootId: runner?.bootId, err: error, runnerId: runner?.runnerId },
      "Runner connection failed while handling a Runner message",
    );
    releaseChallenge();
    inbox.close(error);
    runners.disconnect(peer);
    closeProtocolSocket(socket, error);
  };
  // Runner messages keep their order per Run, and per kind beyond that. A
  // Request answer is delivered inside a transaction that holds its Workspace
  // until the Runner's receipt arrives, while other work — another Run's
  // event, another command's receipt — may be waiting on that Workspace to
  // commit. A receipt queued behind any of it would never arrive, so each
  // receipt is handled on its own: receipts are independent facts, and nothing
  // orders one after another. Each Run and everything else keep a lane each.
  const lanes = new Map<string, Promise<void>>();
  let queued = 0;
  let drained: (() => void) | undefined;
  const enqueue = (key: string, work: () => Promise<void>) => {
    queued += 1;
    const next: Promise<void> = (lanes.get(key) ?? Promise.resolve())
      .then(work)
      .catch(fail)
      .finally(() => {
        queued -= 1;
        if (lanes.get(key) === next) lanes.delete(key);
        if (queued < maxQueuedRunnerMessages && drained) {
          drained();
          drained = undefined;
        }
      });
    lanes.set(key, next);
  };
  void (async () => {
    await peer.send(challenge);
    for await (const item of inbox) {
      if (item.isBinary) throw badMessage("Runner messages must be JSON text");
      const frame = parseFrame(item.frame);
      if (!runner) {
        const message = RunnerWireProofSchema.parse(frame);
        const refuse = async (error: unknown) => {
          if (
            message.type === "runner.authenticate" &&
            error instanceof OpensteerError &&
            (error.reason === "agent-phone-outdated" || error.reason === "runner-outdated")
          ) {
            const identity = await authenticator
              .authenticateUpdateRefusal(challenge, message)
              .catch(() => null);
            if (identity) await recordUpdateRequired({ ...identity, reason: error.reason });
            log.warn(
              {
                reason: error.reason,
                runnerId: identity?.runnerId,
                authenticated: identity !== null,
              },
              "Runner admission refused: update required",
            );
          }
          if (error instanceof OpensteerError)
            log.warn({ reason: error.reason ?? error.code }, "Runner admission refused");
          return refuseRunnerAdmission(socket, peer, error);
        };
        const identity = await authenticator
          .authenticate(challenge, message, (verified) => {
            const release = phoneRelease();
            const version = agentPhoneVersionCode(verified.descriptor.runtimeVersion);
            if (
              verified.descriptor.device?.form === "phone" &&
              release &&
              version !== null &&
              version < release.manifest.versionCode
            )
              throw new OpensteerError({
                code: "forbidden",
                reason: "agent-phone-outdated",
                message: agentPhoneOutdatedReason,
              });
          })
          .catch(async (error: unknown) => {
            if (error instanceof z.ZodError && androidPhoneProofSchema.safeParse(frame).success)
              return refuse(
                new OpensteerError({
                  code: "forbidden",
                  reason: "agent-phone-outdated",
                  message: agentPhoneOutdatedReason,
                }),
              );
            return refuse(error);
          });
        if (!identity) return;
        // Registration rechecks the Personal route generation, so a computer
        // can still be refused here for remote access going off meanwhile.
        if ((await runners.register(identity, peer).catch(refuse)) === null) return;
        runner = identity;
        releaseChallenge();
        clearTimeout(challengeTimeout);
        continue;
      }
      const message = RunnerToHostMessageSchema.parse(frame);
      if (message.type === "runner.authenticate" || message.type === "runner.enroll") {
        throw badMessage("Runner repeated its identity proof");
      }
      enqueue(runnerMessageLane(message), () => runners.handle(peer, message));
      // Past this many unprocessed messages the inbox stops being read, which
      // pauses the socket and so the Runner.
      if (queued >= maxQueuedRunnerMessages) {
        await new Promise<void>((resolve) => {
          drained = resolve;
        });
      }
    }
  })().catch(fail);
}

// This only identifies a refused phone proof; it never admits a partial descriptor.
const androidPhoneProofSchema = z.object({
  type: z.enum(["runner.authenticate", "runner.enroll"]),
  descriptor: z.object({
    modules: z.object({ integrations: z.object({ platform: z.literal("android") }) }),
  }),
});

const maxQueuedRunnerMessages = 4_096;

/**
 * Where an Android phone reaches this Deployment, as the Host itself knows it,
 * and what the phone calls it.
 *
 * A server answers at its public canonical origin. A Personal Deployment's
 * canonical origin is the loopback address of the Mac it runs on, which no
 * phone can reach, so a phone pairs with the remote-access route that is live
 * right now — and with remote access off there is none, which refuses the
 * pairing with the same sentence and reason a computer arriving gets.
 *
 * The name is the Deployment's own, the one every client shows: a Personal
 * Deployment is named after the Mac it runs on. A server nobody named is
 * called by its address, as its Settings page calls it.
 */
async function agentPhoneHostTarget(
  dependencies: Pick<
    HostServerDependencies,
    "authenticator" | "discovery" | "personalRemoteAccess"
  >,
): Promise<AgentPhoneHostTarget> {
  const { canonicalOrigin, deploymentId, hostInstanceId } = dependencies.discovery.document;
  const deploymentName =
    (await dependencies.authenticator.identity.configuration()).deployment.name ??
    new URL(canonicalOrigin).hostname;
  let hostUrl = canonicalOrigin;
  if (dependencies.personalRemoteAccess) {
    const route = await dependencies.personalRemoteAccess.service.accessRoute();
    if (!route) {
      throw new OpensteerError({
        code: "forbidden",
        message: personalRemoteAccessRequiredRefusal,
        reason: personalRemoteAccessRefusedReason,
      });
    }
    hostUrl = route.document.route.origin;
  }
  const target = AgentPhoneHostTargetSchema.safeParse({
    deploymentId,
    deploymentName,
    hostInstanceId,
    hostUrl,
  });
  if (!target.success) {
    throw new OpensteerError({
      code: "conflict",
      message: `A phone reaches Opensteer only over HTTPS, and this Deployment is at ${hostUrl}.`,
    });
  }
  return target.data;
}

/**
 * Answers a Runner whose identity proof was refused, and closes it.
 *
 * Every refusal but one is a `host.error` frame and then the close, and the
 * frame carries the store's `reason` when it has one, so a computer that
 * cannot read English — a phone telling its person to mint a new enrollment,
 * or to turn remote access back on — decides on the discriminator rather than
 * the sentence. The exception is a retired identity: its close frame is the
 * whole message, and nothing may precede it, because a Runner that reads a
 * `host.error` throws on the frame and never reaches the close code it must
 * act on. Anything that is not a refusal is the connection failing.
 */
async function refuseRunnerAdmission(
  socket: WebSocket,
  peer: RunnerPeer,
  error: unknown,
): Promise<null> {
  if (error instanceof OpensteerError && error.reason === runnerIdentityRevokedReason) {
    if (socket.readyState === socket.OPEN) {
      socket.close(runnerIdentityRevokedCloseCode, runnerIdentityRevokedMessage);
    }
    return null;
  }
  if (!(error instanceof OpensteerError)) throw error;
  if (error.code !== "unauthorized" && error.code !== "forbidden") throw error;
  const remoteAccessOff = error.reason === personalRemoteAccessRefusedReason;
  // An unauthenticated peer is owed only "failed": the generic refusal never
  // says whether an identity exists or which proof was wrong.
  const message =
    error.code === "unauthorized" && error.reason === undefined
      ? "Runner authentication failed"
      : error.message;
  await peer.send({
    error: {
      code: "forbidden",
      message,
      ...(error.reason === undefined ? {} : { reason: error.reason }),
      // A computer whose Deployment has no route right now did nothing wrong
      // and comes back once there is one; every other refusal needs something
      // to change on its side first.
      retryable: remoteAccessOff,
    },
    type: "host.error",
  });
  if (socket.readyState === socket.OPEN) {
    // Remote access going away sends a computer off with the "going away"
    // code the disconnect sweep uses, never as if it had misbehaved.
    socket.close(remoteAccessOff ? 1001 : 4003, message.slice(0, 123));
  }
  return null;
}

function runnerMessageLane(message: Parameters<RunnerRegistry["handle"]>[1]): string {
  switch (message.type) {
    case "runner.event":
      return `run:${message.event.runId}`;
    case "runner.live":
      return `run:${message.progress.runId}`;
    case "runner.thread-title":
    case "runner.session-bound":
      return `run:${message.runId}`;
    case "runner.command-accepted":
    case "runner.command-rejected":
    case "runner.command-uncertain":
      return `receipt:${message.commandId}`;
    default:
      return "connection";
  }
}

/**
 * The Host's end of one auxiliary Runner stream.
 *
 * The socket proves itself twice before it carries anything: the ticket says
 * which primary connection asked for this stream, and the signature over the
 * Host's fresh challenge plus that ticket's digest says the Runner's own key is
 * behind it. Only then does the registry check the ticket against the primary
 * connection that is live right now, so a stream can never outlive — or run
 * beside — a boot the Host has already replaced.
 */
function attachRunnerAuxiliarySocket(options: {
  readonly passkeys?: boolean | undefined;
  readonly log: FastifyInstance["log"];
  readonly authenticator: RunnerAuthenticator;
  readonly browserAttachPublicKeys: readonly {
    readonly keyId: string;
    readonly publicKeyPem: string;
  }[];
  readonly browserRelay: RunnerBrowserHub;
  readonly channels: ChannelService;
  readonly computerApps: ComputerAppHub;
  readonly messagingRelay: MessagingRelayHub;
  readonly module: RunnerAuxiliaryModule;
  readonly releaseChallenge: () => void;
  readonly runners: RunnerRegistry;
  readonly shellControl: ShellControlStreamHandler;
  readonly socket: WebSocket;
}): void {
  const { module, socket } = options;
  const dispatch = runnerAuxiliaryModuleDispatch(options)[module];
  const { peer } = dispatch;
  const inbox = new BoundedAsyncInbox<{ readonly frame: Buffer; readonly isBinary: boolean }>({
    maxBytes: dispatch.maxQueuedBytes,
    maxItems: 64,
  });
  let stream: RunnerAuxiliaryStream | undefined;
  let outcomeLogged = false;
  const outcome = (accepted: boolean, reason: string) => {
    if (outcomeLogged) return;
    outcomeLogged = true;
    const fields = {
      module,
      outcome: accepted ? "accepted" : "refused",
      reason,
      runnerId: stream?.fence.runnerId,
    };
    if (accepted) options.log.info(fields, "Runner auxiliary upgrade outcome");
    else options.log.warn(fields, "Runner auxiliary upgrade outcome");
  };
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    options.releaseChallenge();
  };
  const challenge: RunnerAuxiliaryChallenge = options.authenticator.issueAuxiliaryChallenge(module);
  const challengeTimeout = setTimeout(
    () => {
      if (!stream && socket.readyState === socket.OPEN) {
        outcome(false, "authentication-timeout");
        socket.close(1008, "Runner module authentication timeout");
      }
    },
    Math.max(1, Date.parse(challenge.expiresAt) - Date.now()),
  );
  challengeTimeout.unref();
  socket.on("message", (raw, isBinary) => {
    try {
      if (!stream && isBinary) {
        throw badMessage("Binary frames are forbidden before authentication");
      }
      const frame = rawDataBuffer(raw);
      if (frame.byteLength > (isBinary ? dispatch.maxFrameBytes : maxWebSocketFrameBytes)) {
        throw badMessage("Runner module frame is too large");
      }
      inbox.push({ bytes: frame.byteLength, value: { frame, isBinary } });
    } catch (error) {
      inbox.close(error);
      outcome(false, "input-queue-exceeded");
      if (socket.readyState === socket.OPEN) socket.close(1009, "module input queue exceeded");
    }
  });
  const disconnected = () => {
    outcome(false, "disconnected-before-authentication");
    release();
    clearTimeout(challengeTimeout);
    inbox.close();
    if (!stream) return;
    options.runners.detachAuxiliary(peer);
    dispatch.onDetach("transport-disconnected");
  };
  socket.once("close", disconnected);
  socket.once("error", disconnected);
  void (async () => {
    await dispatch.send(challenge);
    for await (const item of inbox) {
      if (item.isBinary) {
        if (!stream || !dispatch.allowsBinary) {
          throw badMessage("This Runner module stream carries no binary frames");
        }
        options.runners.assertAuxiliaryFence(peer, dispatch.binaryFence(item.frame));
        await dispatch.onBinary(item.frame);
        continue;
      }
      const parsed = parseFrame(item.frame);
      if (!stream) {
        const proof = RunnerAuxiliaryAuthenticateSchema.parse(parsed);
        const claims = await options.authenticator
          .verifyAuxiliary(challenge, proof)
          .catch(async (error: unknown) => {
            if (!(error instanceof OpensteerError)) throw error;
            outcome(false, error.reason ?? "authentication-failed");
            await dispatch.send({
              error: {
                code: "forbidden",
                message: "Runner module authentication failed",
                retryable: false,
              },
              type: "host.auxiliary.rejected",
            });
            if (socket.readyState === socket.OPEN) {
              socket.close(4003, "Runner module authentication failed");
            }
            return null;
          });
        if (!claims) return;
        stream = options.runners.admitAuxiliary({ claims, module, peer });
        dispatch.onAttach(stream);
        release();
        clearTimeout(challengeTimeout);
        await dispatch.send(
          runnerAuxiliaryWelcome(stream, dispatch.leaseFields?.(), options.passkeys),
        );
        outcome(true, "authenticated");
        dispatch.onWelcomed?.(stream);
        continue;
      }
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "type" in parsed &&
        parsed.type === "runner.auxiliary.heartbeat"
      ) {
        // Transport control frames belong to this shared boundary; a module's
        // domain parser must neither admit nor reject its stream keepalive.
        const heartbeat = RunnerAuxiliaryHeartbeatSchema.parse(parsed);
        options.runners.assertAuxiliaryFence(peer, heartbeat);
        const lease = options.runners.heartbeatAuxiliary(peer, heartbeat.sentAt);
        dispatch.onRenew(lease);
        await dispatch.send({
          ...lease.fence,
          ...dispatch.leaseFields?.(),
          streamLeaseExpiresAt: lease.streamLeaseExpiresAt,
          type: "host.auxiliary.lease-renewed",
        });
        continue;
      }
      const message = dispatch.parseMessage(parsed);
      const renewed = options.runners.assertAuxiliaryFence(peer, message);
      stream = renewed;
      await dispatch.onMessage(stream, message);
    }
  })().catch((error) => {
    outcome(
      false,
      error instanceof OpensteerError
        ? (error.reason ?? error.message).slice(0, 160)
        : "invalid-proof-or-frame",
    );
    release();
    inbox.close(error);
    if (stream) {
      options.runners.detachAuxiliary(peer);
      dispatch.onDetach("transport-disconnected");
    }
    closeProtocolSocket(socket, error);
  });
}

/** A fenced frame from a Runner module, before the module's own union narrows it. */
interface RunnerAuxiliaryModuleFrame extends RunnerAuxiliaryFrameFence {
  readonly type: string;
}

/** The handshake frames every module stream exchanges, whatever it carries after. */
type RunnerAuxiliaryHandshakeMessage = Extract<
  HostToBrowserRelayMessage,
  { readonly type: `host.auxiliary.${string}` }
>;

/**
 * One module's half of an auxiliary stream.
 *
 * Authentication, fencing, heartbeats and lease renewal are identical for every
 * module and stay in the handler above; this says only what differs — how large
 * a frame may be, whether binary frames mean anything, and who owns the stream
 * once it is admitted.
 */
interface RunnerAuxiliaryModuleDispatchBase<Message extends RunnerAuxiliaryModuleFrame> {
  readonly maxFrameBytes: number;
  readonly maxQueuedBytes: number;
  readonly peer: RunnerAuxiliaryPeer;
  /** What this module adds to its welcome and to every lease renewal. */
  leaseFields?(): Readonly<Record<string, unknown>>;
  onAttach(stream: RunnerAuxiliaryStream): void;
  onDetach(reason: RunnerStreamLossReason): void;
  onMessage(stream: RunnerAuxiliaryStream, message: Message): Promise<void>;
  onRenew(lease: RunnerAuxiliaryStream): void;
  /** Runs after the welcome, for work the Runner must not see before it. */
  onWelcomed?(stream: RunnerAuxiliaryStream): void;
  parseMessage(frame: unknown): Message;
  send(message: RunnerAuxiliaryHandshakeMessage): Promise<void>;
}

type RunnerAuxiliaryModuleDispatch<Message extends RunnerAuxiliaryModuleFrame> =
  | (RunnerAuxiliaryModuleDispatchBase<Message> & { readonly allowsBinary: false })
  | (RunnerAuxiliaryModuleDispatchBase<Message> & {
      readonly allowsBinary: true;
      /** Reads only the fence of a binary frame, so a stale one never reaches the owner. */
      binaryFence(frame: Buffer): RunnerAuxiliaryFrameFence;
      onBinary(frame: Buffer): Promise<void>;
    });

function runnerAuxiliaryModuleDispatch(options: {
  readonly browserAttachPublicKeys: readonly {
    readonly keyId: string;
    readonly publicKeyPem: string;
  }[];
  readonly browserRelay: RunnerBrowserHub;
  readonly channels: ChannelService;
  readonly computerApps: ComputerAppHub;
  readonly messagingRelay: MessagingRelayHub;
  readonly shellControl: ShellControlStreamHandler;
  readonly socket: WebSocket;
}): {
  readonly [
    Module in RunnerAuxiliaryModule
  ]: RunnerAuxiliaryModuleDispatch<RunnerAuxiliaryModuleFrame>;
} {
  const { socket } = options;
  const browserPeer = browserRelayPeer(socket, `runner-browser-peer:${randomUUID()}`);
  const integrationsPeer = computerAppControlPeer(
    socket,
    `runner-integrations-peer:${randomUUID()}`,
  );
  const messagingPeer = messagingRelayPeer(socket, `runner-messaging-peer:${randomUUID()}`);
  const shellPeer = shellControlPeer(socket, `runner-shell-peer:${randomUUID()}`);
  return {
    browser: {
      allowsBinary: true,
      binaryFence: (frame) => decodeBrowserRelayFrameForFence(frame),
      leaseFields: () => ({ browserAttachPublicKeys: [...options.browserAttachPublicKeys] }),
      maxFrameBytes: maxBrowserRelayFrameBytes,
      maxQueuedBytes: maxBrowserRelayQueuedBytes,
      onAttach: (stream) => options.browserRelay.attach(browserPeer, stream),
      onBinary: (frame) => options.browserRelay.handleBinary(browserPeer, frame),
      onDetach: (reason) => options.browserRelay.detach(browserPeer, reason),
      onMessage: (_stream, message: BrowserRelayEvent) =>
        options.browserRelay.handleMessage(browserPeer, message),
      onRenew: (lease) => options.browserRelay.renew(browserPeer, lease),
      parseMessage: (frame) => BrowserRuntimeRelayToHostMessageSchema.parse(frame),
      peer: browserPeer,
      send: (message) => browserPeer.send(message),
    },
    integrations: {
      allowsBinary: false,
      maxFrameBytes: computerAppMaxFrameBytes,
      maxQueuedBytes: 4 * computerAppMaxFrameBytes,
      onAttach: (stream) => options.computerApps.attach(integrationsPeer, stream),
      onDetach: (reason) => options.computerApps.detach(integrationsPeer, reason),
      onMessage: (stream, message: IntegrationsModuleEvent) =>
        options.computerApps.handleMessage(integrationsPeer, stream, message),
      onRenew: (lease) => options.computerApps.renew(integrationsPeer, lease),
      parseMessage: (frame) => IntegrationsModuleEventSchema.parse(frame),
      peer: integrationsPeer,
      send: (message) => integrationsPeer.send(message),
    },
    messaging: {
      allowsBinary: false,
      maxFrameBytes: maxWebSocketFrameBytes,
      maxQueuedBytes: 4 * maxWebSocketFrameBytes,
      onAttach: (stream) => options.messagingRelay.attach(messagingPeer, stream),
      onDetach: (reason) => options.messagingRelay.detach(messagingPeer, reason),
      onMessage: async (stream, message: MessagingRelayToHostMessage) => {
        if (message.type === "runtime.response") {
          options.messagingRelay.handleResponse(stream.identity.runnerId, message);
          return;
        }
        await respondToRuntimeRequest(
          messagingPeer,
          stream,
          options.channels,
          message as RuntimeChannelRequest,
        );
      },
      onRenew: (lease) => options.messagingRelay.renew(messagingPeer, lease),
      onWelcomed: (stream) => {
        void options.channels.runtimeConnected(stream.identity.runnerId).catch(() => undefined);
      },
      parseMessage: (frame) => MessagingRelayToHostMessageSchema.parse(frame),
      peer: messagingPeer,
      send: (message) => messagingPeer.send(message),
    },
    shell: {
      allowsBinary: false,
      maxFrameBytes: maxWebSocketFrameBytes,
      maxQueuedBytes: 4 * maxWebSocketFrameBytes,
      onAttach: (stream) => options.shellControl.attach(shellPeer, stream),
      onDetach: (reason) => options.shellControl.detach(shellPeer, reason),
      onMessage: (stream, message: ShellModuleEvent) =>
        options.shellControl.handleMessage(shellPeer, stream, message),
      onRenew: (lease) => options.shellControl.renew(shellPeer, lease),
      parseMessage: (frame) => ShellModuleToHostMessageSchema.parse(frame),
      peer: shellPeer,
      send: (message) => shellPeer.send(message),
    },
  };
}

/**
 * Who may read and change one computer's access settings.
 *
 * Reach never grants management: a person whose Threads may connect to a
 * machine still learns nothing about who else can, and cannot change it. The
 * effective owner decides, and administrators stand in only where the
 * Deployment itself owns the machine and nobody in particular does.
 */
async function requireMachineAccessManagement(
  store: OpensteerStore,
  session: Awaited<ReturnType<HostAuthenticator["authenticateSession"]>>,
  runnerId: RunnerId,
): Promise<void> {
  const ownership = await store.effectiveMachineOwner(runnerId);
  if (!ownership)
    throw new OpensteerError({ code: "not_found", message: "Active Runner not found" });
  if (
    machineIsManagedBy(ownership, session.user.id, {
      allowDeployment: session.user.instanceRole === "administrator",
    })
  ) {
    return;
  }
  throw new OpensteerError({
    code: "forbidden",
    message: "Only this computer's owner can change how other computers reach it",
  });
}

/** Reads only the fence out of a binary relay frame, so a stale one is refused
 * before its payload reaches the relay. */
function decodeBrowserRelayFrameForFence(frame: Buffer): RunnerAuxiliaryFrameFence {
  try {
    return browserRelayFrameFence(decodeBrowserRelayFrame(frame).header);
  } catch (error) {
    if (error instanceof BrowserRelayFrameError) throw badMessage(error.message);
    throw error;
  }
}

async function respondToRuntimeRequest(
  peer: MessagingRelayPeer,
  stream: RunnerAuxiliaryStream,
  channels: ChannelService,
  request: RuntimeChannelRequest,
): Promise<void> {
  try {
    const result = await channels.handleRuntimeRequest(stream.identity.runnerId, request);
    await peer.send({
      ...stream.fence,
      ok: true,
      requestId: request.requestId,
      result,
      type: "host.response",
    });
  } catch (error) {
    const normalized = normalizeHostError(error).error;
    await peer.send({
      ...stream.fence,
      error: {
        code: normalized.code,
        message: normalized.message,
        retryable: normalized.retryable,
      },
      ok: false,
      requestId: request.requestId,
      type: "host.response",
    });
  }
}

export class RunnerChallengeAdmission {
  readonly #maximum: number;
  #active = 0;

  constructor(maximum = maxChallengedRunnerConnections) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > maxChallengedRunnerConnections) {
      throw new Error(
        `Maximum challenged Runner connections must be between 1 and ${maxChallengedRunnerConnections}.`,
      );
    }
    this.#maximum = maximum;
  }

  acquire(): (() => void) | null {
    if (this.#active >= this.#maximum) return null;
    this.#active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
    };
  }
}

function attachRealtimeSocket(
  socket: WebSocket,
  realtime: RealtimeHub,
  workspaces: WorkspaceService,
  session: AuthenticatedSession,
  log: FastifyInstance["log"],
): void {
  const openedAt = Date.now();
  installWebSocketLiveness(socket);
  const peer = jsonPeer<HostToClientMessage>(socket, `client-peer:${randomUUID()}`);
  const sink: RealtimeSink = {
    ...peer,
    send: async (message: HostToClientMessage) => {
      const projected = HostToClientMessageSchema.safeParse(
        message.type === "host.snapshot"
          ? {
              ...message,
              snapshot: {
                ...message.snapshot,
                workspace: await decorateWorkspaceView(workspaces, message.snapshot.workspace),
              },
            }
          : message,
      );
      if (!projected.success) {
        // Publisher faults cannot be repaired by replaying the same cursor.
        // Keep validation errors (which can contain private values) off the wire.
        const diagnosticFields = new Set([
          "type",
          "events",
          "data",
          "sequence",
          "workspaceId",
          "threadId",
          "snapshot",
          "progress",
          "items",
          "status",
        ]);
        log.error(
          {
            event: "host.realtime.invalid-publication",
            envelopeType: HostToClientMessageSchema.options.some(
              (schema) => schema.shape.type.value === message.type,
            )
              ? message.type
              : "unknown",
            apiEpoch: hostApiVersion,
            bytes: Buffer.byteLength(JSON.stringify(message)),
            issuePaths: projected.error.issues.slice(0, 8).map(({ path }) =>
              path.length === 0
                ? "$"
                : path
                    .slice(0, 12)
                    .map((part) =>
                      typeof part === "number"
                        ? "[]"
                        : typeof part === "string" && diagnosticFields.has(part)
                          ? part
                          : "*",
                    )
                    .join("."),
            ),
          },
          "Invalid realtime publication",
        );
        await peer.send({
          type: "host.error",
          error: {
            code: "internal",
            reason: "invalid-realtime-publication",
            retryable: false,
            message:
              "This Host published an invalid realtime update. Update the Host, then reconnect.",
          },
        });
        peer.close(4002, "Invalid realtime publication");
        throw new Error("Invalid realtime publication");
      }
      await peer.send(projected.data);
    },
  };
  const inbox = new BoundedAsyncInbox<{ readonly frame: Buffer; readonly isBinary: boolean }>({
    maxBytes: 4 * maxWebSocketFrameBytes,
    maxItems: 64,
  });
  let unsubscribe: (() => void) | undefined;
  let workspaceId: WorkspaceId | null = null;
  // Machine notifications are addressed to the connection, not to a Workspace:
  // the people entitled to them are usually nowhere near the Workspace whose
  // Run caused them, and this is registered before any subscription so it does
  // not depend on one.
  const unregister = realtime.registerConnection(session.user.id, session.id, sink);
  const expiresAt = Math.min(
    new Date(session.expiresAt).getTime(),
    new Date(session.absoluteExpiresAt).getTime(),
  );
  const cancelExpiration = scheduleWebSocketExpiration(expiresAt, () =>
    realtime.closeSession(session.id),
  );
  socket.on("message", (frame, isBinary) => {
    try {
      const buffer = rawDataBuffer(frame);
      if (buffer.byteLength > maxWebSocketFrameBytes) {
        throw badMessage("Client message is too large");
      }
      inbox.push({ bytes: buffer.byteLength, value: { frame: buffer, isBinary } });
    } catch (error) {
      inbox.close(error);
      if (socket.readyState === socket.OPEN) socket.close(1009, "client input queue exceeded");
    }
  });
  const close = () => {
    cancelExpiration();
    inbox.close();
    unregister();
    unsubscribe?.();
  };
  socket.once("close", (code, reason) => {
    close();
    try {
      let boundedReason = "";
      for (const character of reason.toString("utf8")) {
        if (Buffer.byteLength(boundedReason + character, "utf8") > 123) break;
        boundedReason += character;
      }
      log.info(
        {
          connection: peer.id,
          sessionId: session.id,
          workspaceId,
          code,
          reason: boundedReason,
          lifetimeMs: Date.now() - openedAt,
        },
        "Realtime socket closed",
      );
    } catch {
      // Diagnostics must not interrupt socket cleanup.
    }
  });
  socket.once("error", close);
  void (async () => {
    for await (const item of inbox) {
      if (item.isBinary) throw badMessage("Client messages must be JSON text");
      const message = ClientToHostMessageSchema.parse(parseFrame(item.frame));
      if (message.type === "client.ping") {
        await sink.send({ nonce: message.nonce, type: "host.pong" });
        continue;
      }
      if (message.type === "client.ack") continue;
      if (unsubscribe) throw badMessage("Client is already subscribed");
      // Nothing is streamed to a client on another epoch: the events it would
      // receive are exactly what the epoch governs, so the refusal comes
      // before the subscription rather than after the first frame it cannot
      // read. The `host.error` says why and the close code says it is final.
      if (message.apiVersion !== hostApiVersion) {
        await sink.send({
          error: {
            code: "bad_message",
            message: `This deployment speaks Opensteer protocol ${hostApiVersion}.`,
            reason: unsupportedVersionReason,
            retryable: false,
          },
          type: "host.error",
        });
        sink.close(unsupportedVersionCloseCode, "Unsupported Opensteer protocol version");
        return;
      }
      try {
        unsubscribe = await realtime.subscribe({
          afterSequence: message.afterSequence,
          ...(message.snapshotMessages ? { snapshotMessages: message.snapshotMessages } : {}),
          sink,
          userId: session.user.id,
          workspaceId: message.workspaceId,
        });
        workspaceId = message.workspaceId;
      } catch (error) {
        if (error instanceof OpensteerError && error.code === "forbidden") {
          await sink.send({
            error: {
              code: "forbidden",
              message: "Workspace realtime subscription is not authorized.",
              reason: "workspace-forbidden",
              retryable: false,
            },
            type: "host.error",
          });
          sink.close(4_003, "Workspace subscription forbidden");
          return;
        }
        throw error;
      }
    }
  })().catch((error) => {
    inbox.close(error);
    closeProtocolSocket(socket, error);
  });
}

/**
 * Ends every WebSocket when the Host stops. Each is asked to close first, so a
 * live peer hears why; one that has not finished closing by the deadline is
 * terminated. A peer whose transport is already gone never answers a close
 * frame, and waiting out the socket's own thirty-second close timeout would
 * hold a Host restart hostage to the slowest dead connection.
 */
function closeWebSocketsWithin(graceMs: number): (this: FastifyInstance, done: () => void) => void {
  return function preClose(done) {
    // Fastify closes the HTTP server once this finishes; the drain then keeps
    // a request answered mid-shutdown from holding it in keep-alive.
    drainConnectionsWithin(this.server, httpShutdownGraceMs);
    const server = this.websocketServer;
    for (const client of server.clients) client.close(1001, "Host is shutting down");
    const deadline = setTimeout(() => {
      for (const client of server.clients) client.terminate();
    }, graceMs);
    deadline.unref();
    server.close(() => {
      clearTimeout(deadline);
      done();
    });
    if (server.clients.size === 0) {
      clearTimeout(deadline);
    }
  };
}

function jsonPeer<Message>(
  socket: WebSocket,
  id: string,
): RunnerPeer & {
  send(message: Message): Promise<void>;
} {
  return {
    close: (code, reason) => socket.close(code, reason.slice(0, 123)),
    id,
    send: (message) => {
      const frame = JSON.stringify(message);
      const bytes = Buffer.byteLength(frame, "utf8");
      return new Promise<void>((resolve, reject) => {
        if (socket.readyState !== socket.OPEN) return reject(new Error("WebSocket is closed"));
        if (socket.bufferedAmount + bytes > maxWebSocketBufferedBytes) {
          socket.close(4009, "slow consumer");
          return reject(new Error("WebSocket slow consumer"));
        }
        socket.send(frame, (error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function browserRelayPeer(
  socket: WebSocket,
  id: string,
): RunnerBrowserPeer & {
  send(message: z.infer<typeof HostToBrowserRuntimeRelayMessageSchema>): Promise<void>;
} {
  return {
    close: (code, reason) => socket.close(code, reason.slice(0, 123)),
    id,
    send: (message: z.infer<typeof HostToBrowserRuntimeRelayMessageSchema>) =>
      sendJsonFrame(socket, HostToBrowserRuntimeRelayMessageSchema.parse(message)),
  };
}

function computerAppControlPeer(
  socket: WebSocket,
  id: string,
): ComputerAppControlPeer & {
  send(message: HostToIntegrationsModuleMessage): Promise<void>;
} {
  return {
    close: (code, reason) => socket.close(code, reason.slice(0, 123)),
    id,
    send: (message: HostToIntegrationsModuleMessage) =>
      sendComputerAppFrame(
        socket,
        HostToIntegrationsModuleMessageSchema.parse(message),
        maxWebSocketBufferedBytes,
      ),
  };
}

function messagingRelayPeer(
  socket: WebSocket,
  id: string,
): MessagingRelayPeer & {
  send(message: HostToMessagingRelayMessage): Promise<void>;
} {
  return {
    close: (code, reason) => socket.close(code, reason.slice(0, 123)),
    id,
    send: (message: HostToMessagingRelayMessage) =>
      sendJsonFrame(socket, HostToMessagingRelayMessageSchema.parse(message)),
  };
}

function shellControlPeer(
  socket: WebSocket,
  id: string,
): ShellControlPeer & {
  send(message: HostToShellModuleMessage): Promise<void>;
} {
  return {
    close: (code, reason) => socket.close(code, reason.slice(0, 123)),
    id,
    send: (message: HostToShellModuleMessage) =>
      sendJsonFrame(socket, HostToShellModuleMessageSchema.parse(message)),
  };
}

function sendJsonFrame(socket: WebSocket, message: unknown): Promise<void> {
  const frame = JSON.stringify(message);
  const bytes = Buffer.byteLength(frame, "utf8");
  return new Promise<void>((resolve, reject) => {
    if (socket.readyState !== socket.OPEN) return reject(new Error("WebSocket is closed"));
    if (socket.bufferedAmount + bytes > maxWebSocketBufferedBytes) {
      socket.close(4009, "slow module consumer");
      return reject(new Error("WebSocket slow consumer"));
    }
    socket.send(frame, (error) => (error ? reject(error) : resolve()));
  });
}

function browserConsumerPeer(socket: WebSocket, id: string): BrowserConsumerPeer {
  return {
    close: (code, reason) => socket.close(code, reason.slice(0, 123)),
    id,
    isOpen: () => socket.readyState === socket.OPEN,
    send: (data, binary) =>
      new Promise<void>((resolve, reject) => {
        if (socket.readyState !== socket.OPEN) return reject(new Error("WebSocket is closed"));
        const bytes = typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength;
        if (socket.bufferedAmount + bytes > maxWebSocketBufferedBytes) {
          socket.close(1013, "slow browser consumer");
          return reject(new Error("WebSocket slow consumer"));
        }
        socket.send(data, { binary }, (error) => (error ? reject(error) : resolve()));
      }),
  };
}

function parseFrame(frame: RawData): unknown {
  const buffer = rawDataBuffer(frame);
  if (buffer.byteLength > maxWebSocketFrameBytes) throw badMessage("WebSocket frame is too large");
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    throw badMessage("WebSocket frame is not valid JSON");
  }
}

function closeProtocolSocket(socket: WebSocket, error: unknown): void {
  if (socket.readyState !== socket.OPEN) return;
  const message = error instanceof Error ? error.message : "Protocol error";
  // A computer refused because its Deployment's remote access went away did
  // nothing wrong and should come back, so it is sent away with the same
  // "going away" code the disconnect sweep uses rather than told its messages
  // were malformed.
  const code =
    error instanceof OpensteerError && error.reason === personalRemoteAccessRefusedReason
      ? 1001
      : 4002;
  socket.close(code, message.slice(0, 123));
}

/**
 * The environments whose Runner is bound to this person.
 *
 * Ownership lives on the Runner row, and the inventory listing is the read that
 * exposes it — it already hides Runners bound to somebody else, so a
 * Runner it returns carrying this user's id is one they own. Paged rather than
 * asked one environment at a time because the caller needs the whole set for
 * bootstrap and a single environment for the sign-in routes, and one read
 * answers both without a second way to compute the same thing.
 */
async function boundRunnerEnvironmentIds(
  store: OpensteerStore,
  userId: UserId,
): Promise<ReadonlySet<EnvironmentId>> {
  const bound = new Set<EnvironmentId>();
  let after: RunnerId | undefined;
  for (let page = 0; page < maxRunnerOwnershipPages; page += 1) {
    const listed = await store.listRunners({
      ...(after ? { after } : {}),
      includeDeployment: false,
      limit: runnerOwnershipPageSize,
      ownerId: userId,
    });
    for (const runner of listed.runners) {
      if (runner.ownerUserId !== userId) continue;
      for (const environmentId of runner.environmentIds) bound.add(environmentId);
    }
    if (!listed.nextCursor) break;
    after = listed.nextCursor;
  }
  return bound;
}

/**
 * Who may manage one work location's AI engine profiles: an instance
 * administrator, or the person who owns its Runner.
 *
 * Deployment-owned self-hosted Runners name no user owner, so their profiles
 * remain administrator-managed. User-owned local and managed Runners use the
 * same rule instead of branching on where the Host itself is deployed.
 */
/**
 * The wire shape of one AI engine profile. `removedAt` is the Host's own record
 * of a retirement, and every listing a client receives already excludes removed
 * profiles, so it stops here rather than becoming part of the contract.
 */
function harnessView(harness: HarnessInstanceRecord): HostBootstrapHarness {
  const modelConfig = z
    .object({ models: HarnessModelSettingsMapSchema.optional() })
    .safeParse(harness.config);
  return {
    ...(modelConfig.success && modelConfig.data.models
      ? { modelSettings: modelConfig.data.models }
      : {}),
    config: harness.config,
    driverKind: harness.driverKind,
    enabled: harness.enabled,
    environmentId: harness.environmentId,
    id: harness.id,
    isDefault: harness.isDefault,
    name: harness.name,
    runtimeRevision: harness.runtimeRevision,
    sourceId: harness.sourceId,
    stateKind: harness.stateKind,
  };
}

/**
 * The source field values a person filled in, checked against what the engine
 * declared and nothing else. The Host does not know what a `baseUrl` means — it
 * only proves the record is exactly the declared set of fields, that each one
 * carries something, and that a url field is an address a driver could reach.
 * What survives is the row's driver config, because these values are the
 * driver's own settings for this source.
 */
function validatedHarnessSourceConfig(
  source: HarnessSourceDescriptor,
  config: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  const declared = new Set(source.fields.map(({ id }) => id));
  for (const key of Object.keys(config ?? {})) {
    if (!declared.has(key)) {
      throw new OpensteerError({
        code: "bad_request",
        message: `${source.label} has no ${key} setting`,
      });
    }
  }
  const validated: Record<string, string> = {};
  for (const field of source.fields) {
    const value = (config?.[field.id] ?? field.defaultValue)?.trim();
    if (!value) {
      if (field.required === false) continue;
      throw new OpensteerError({ code: "bad_request", message: `${field.label} is required` });
    }
    if (field.kind === "select" && !field.options?.some((option) => option.value === value)) {
      throw new OpensteerError({
        code: "bad_request",
        message: `${field.label} is not one of the offered choices`,
      });
    }
    if (field.kind === "url") {
      const address = httpAddress(value);
      if (!address) {
        throw new OpensteerError({
          code: "bad_request",
          message: `${field.label} must be an http:// or https:// address`,
        });
      }
      if (!parseHttpEndpointBaseUrl(value)) {
        throw new OpensteerError({
          code: "bad_request",
          message: `${field.label} must not carry credentials, a query, or a fragment`,
        });
      }
    }
    validated[field.id] = value;
  }
  return validated;
}

function httpAddress(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url : null;
}

function harnessAuthenticationIsAllowed(input: {
  readonly boundEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly environment: { readonly id: EnvironmentId; readonly kind: ExecutionEnvironmentKind };
  readonly isInstanceAdministrator: boolean;
}): boolean {
  return input.isInstanceAdministrator || input.boundEnvironmentIds.has(input.environment.id);
}

/**
 * Resolves one profile inside a work location the caller has already been
 * admitted to. Admission is what proves the environment is visible and
 * manageable, so this only has to find the profile on it.
 */
async function managedHarnessAuthenticationTarget(
  store: OpensteerStore,
  input: { readonly environmentId: string; readonly harnessInstanceId: string },
  environment: NonNullable<Awaited<ReturnType<OpensteerStore["getEnvironment"]>>>,
) {
  const parsed = HarnessAuthenticationParamsSchema.parse(input);
  const harness = await store.getHarnessInstance(parsed.harnessInstanceId);
  if (!harness?.enabled || harness.environmentId !== environment.id) {
    throw new OpensteerError({ code: "not_found", message: "AI engine not found" });
  }
  return {
    environment,
    harness: {
      config: harness.config,
      driverKind: harness.driverKind,
      id: harness.id,
      name: harness.name,
      runtimeRevision: harness.runtimeRevision,
      sourceId: harness.sourceId,
      stateKind: harness.stateKind,
    },
  };
}

/**
 * Whether this profile really offers the sign-in the caller is about to
 * perform. The catalog is the Runner's own last answer, so a method absent from
 * it is one the Runner would refuse — a conflict here beats a provider flow
 * that opens and then dies.
 *
 * `methodId` names one advertised method when the caller chose one. A
 * submission carries a code rather than a choice, and still has to land on a
 * profile that advertises setup at all.
 */
async function assertSetupMethodAvailable(
  store: OpensteerStore,
  target: Awaited<ReturnType<typeof managedHarnessAuthenticationTarget>>,
  selection: { readonly connectionSlot?: string; readonly methodId?: string } = {},
): Promise<void> {
  const catalog = await store.getHarnessCatalog(target.environment.id, target.harness.id);
  const slotMethods =
    catalog?.setupMethods.filter(
      (method) =>
        selection.connectionSlot === undefined ||
        method.connectionSlot === selection.connectionSlot,
    ) ?? [];
  const available =
    (catalog?.status === "authentication-required" || catalog?.status === "ready") &&
    catalog.driverKind === target.harness.driverKind &&
    (selection.methodId === undefined
      ? slotMethods.length > 0
      : slotMethods.some((method) => method.methodId === selection.methodId));
  if (!available) {
    throw new OpensteerError({
      code: "conflict",
      message: "This AI engine did not report an available remote authentication action",
    });
  }
}

/**
 * Whether this profile has a connection the driver is willing to sign out. Only
 * a ready catalog can: an engine that is not signed in has nothing to sign out
 * of, and a driver that reports no `logoutSupported` connection would refuse.
 */
async function assertLogoutAvailable(
  store: OpensteerStore,
  target: Awaited<ReturnType<typeof managedHarnessAuthenticationTarget>>,
  connectionSlot?: string,
): Promise<void> {
  const catalog = await store.getHarnessCatalog(target.environment.id, target.harness.id);
  const available =
    catalog?.status === "ready" &&
    catalog.driverKind === target.harness.driverKind &&
    catalog.connections.some(
      (connection) =>
        connection.status === "connected" &&
        connection.logoutSupported &&
        (connectionSlot === undefined || connection.connectionSlot === connectionSlot),
    );
  if (!available) {
    throw new OpensteerError({
      code: "conflict",
      message: "This AI engine did not report an available remote authentication action",
    });
  }
}

interface AvailableModelSelection {
  readonly catalog: Extract<HarnessInstanceCatalog, { readonly status: "ready" }>;
  readonly model: HarnessModelDescriptor;
}

/**
 * A Thread's access mode is a promise about what its Runs may do without
 * asking, and only the engine can keep it. The driver's own declaration — the
 * same advertisement `harness.create` validates a source against — is the
 * authority; the Host carries no list of its own and never quietly substitutes
 * a mode the engine does support. Silence (an away work location, a driver that
 * cannot run) is not a declaration, so nothing is refused on it: that Thread is
 * already blocked from running by the checks that care about reachability.
 */
function assertAccessModeEnforceable(
  runners: RunnerRegistry,
  environmentId: EnvironmentId,
  driverKind: HarnessId,
  accessMode: ThreadAccessMode,
): void {
  const advertised = runners.harnessAccessModes(environmentId, driverKind);
  if (!advertised || advertised.includes(accessMode)) return;
  throw new OpensteerError({
    code: "bad_request",
    message: `${harnessDriverLabel(driverKind)} cannot enforce the ${accessMode} access mode`,
  });
}

/**
 * Proves a selection is one this account can actually run, and hands back the
 * catalog descriptor it matched — the only place that knows the native id the
 * account's endpoint answers to.
 */
function assertModelSelectionAvailable(
  catalog: HarnessInstanceCatalog | undefined,
  selection: ModelSelection,
): AvailableModelSelection {
  if (!catalog) {
    throw new OpensteerError({
      code: "conflict",
      message: "The selected AI engine has not reported its available models",
      retryable: true,
    });
  }
  if (catalog.status !== "ready") {
    throw new OpensteerError({
      code: "conflict",
      message: catalog.detail,
      retryable: isRetryableHarnessCatalogStatus(catalog.status),
    });
  }
  const match = matchModelSelection(catalog.models, selection, "refuse");
  if (match.kind === "model-unavailable") {
    throw new OpensteerError({
      code: "conflict",
      message:
        match.reason ?? "The selected model is not available in this AI engine on this Runner",
    });
  }
  if (match.kind === "option-unavailable") {
    throw new OpensteerError({ code: "conflict", message: modelOptionUnavailableMessage(match) });
  }
  return { catalog, model: match.model };
}

function serializeInvitation(invitation: WorkspaceInvitationRecord) {
  return {
    acceptedAt: invitation.acceptedAt?.toISOString() ?? null,
    acceptedBy: invitation.acceptedBy,
    createdAt: invitation.createdAt.toISOString(),
    createdBy: invitation.createdBy,
    expiresAt: invitation.expiresAt.toISOString(),
    id: invitation.id,
    intendedEmail: invitation.intendedEmail,
    revokedAt: invitation.revokedAt?.toISOString() ?? null,
    role: invitation.role,
    selector: invitation.selector,
    type: invitation.type,
    workspaceId: invitation.workspaceId,
  };
}

function workspaceView(service: WorkspaceService, workspace: Workspace): Promise<WorkspaceView> {
  return typeof service.workspaceView === "function"
    ? service.workspaceView(workspace)
    : Promise.resolve(workspaceViewFromWorkspace(workspace));
}

function decorateWorkspaceView(
  service: WorkspaceService,
  view: WorkspaceView,
): Promise<WorkspaceView> {
  return typeof service.decorateWorkspaceView === "function"
    ? service.decorateWorkspaceView(view)
    : Promise.resolve(view);
}

function requireBearerToken(request: FastifyRequest): string {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ") || value.length > 4_103) {
    throw new OpensteerError({ code: "unauthorized", message: "Bearer token is required" });
  }
  const token = value.slice("Bearer ".length);
  if (!token || /\s/u.test(token)) {
    throw new OpensteerError({ code: "unauthorized", message: "Bearer token is invalid" });
  }
  return token;
}

function badMessage(message: string): OpensteerError {
  return new OpensteerError({ code: "bad_request", message });
}
