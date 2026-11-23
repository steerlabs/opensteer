import { runnerRestartingCloseCode } from "@opensteer/protocol";
import { registerStandardCdpRoute } from "./browser/standard-cdp-route.js";
import { standardCdpConnectPrefix } from "./browser/standard-cdp-tickets.js";
import { standardCdpMessageMaxBytes } from "@opensteer/protocol/standard-cdp";
import { registerPluginWebhookRoutes } from "./plugins/plugin-webhook-routes.js";
import { registerPluginOAuthRoutes } from "./plugins/plugin-oauth-routes.js";
import { withClientSendKeys } from "./threads/client-send-keys.js";
import type { MessageId } from "@opensteer/core";
import { createPersonalReads } from "./server/personal-reads.js";
import { PersonalResources } from "./server/personal-resources.js";
import {
  IntegrationPlatformStore,
  OpensteerStore,
  listIntegrationConnections,
} from "@opensteer/database";
import { DeviceIdSchema } from "@opensteer/core";
import { type PersonalMutationTransaction } from "@opensteer/database/personal-mutation";
import { personalClientFrameMaxBytes } from "@opensteer/protocol/personal-sync";
import { attachPersonalSocket } from "./server/personal-socket.js";
import { readThreadHistory } from "@opensteer/database";
import type { AuthenticatedHostSession } from "./identity/auth.js";
import { isLoopbackHostname, isPhoneDisplayDefinitionId } from "@opensteer/core";
import type { TabService } from "./tabs/tab-service.js";
import type { AgentToolActivityStore } from "@opensteer/database";
import { registerAgentToolRoute } from "./mcp/agent-tool-route.js";
import {
  registerAgentPageBindingRoute,
  runBrowserCapability,
} from "./browser/trigger-cdp-bridge.js";
import { handleAppCommand } from "./apps/app-routes.js";
import { createAssetUrlHandlers } from "./assets/asset-service.js";
import { createReferenceHandlers, createThreadRequestHandler } from "./references/resolve.js";
import { resolvePersonalReferences } from "@opensteer/database";
import { createTranscriptFileHandlers, type TranscriptFiles } from "./threads/transcript-files.js";
import { describeSessionDevice } from "@opensteer/shared/sessionDevice";
import type { AssetService } from "./assets/asset-service.js";
import type { DeviceAccessService } from "./administration/device-access-service.js";
import type { DeviceDriverManagementPort } from "./administration/device-driver-service.js";
import { consumeAnonymousRateLimit } from "./identity/anonymous-rate-limit.js";
import { installClientAddress, installTrustedProxy } from "./identity/anonymous-client-address.js";
import { registerManagedHomeClaimRoute } from "./identity/managed-home-claim.js";
import { registerDeviceEnrollmentPreview } from "./organizations/device-enrollment-preview.js";
import { registerWorkHomeRoutes, type WorkHomeService } from "./organizations/work-home.js";
import { deviceAccess } from "@opensteer/protocol";
import {
  deviceMembershipTurn,
  removeSignedDevice,
  signOutDeviceSession,
} from "./administration/device-removal.js";
import { RunnerLeaveRequestSchema, RunnerLeaveResponseSchema } from "@opensteer/protocol";
import { requirePersonalOwner, needsYouPage, personTaskReader } from "@opensteer/database";
import type { PersonalExecution } from "./runtime/personal-execution.js";

import { readAutomaticModelPreview } from "./agents/automatic-models.js";
import { registerDesktopUpdateMaintenance } from "./access/personal-desktop-update-routes.js";
import { ThreadService, assertAccessModeEnforceable } from "./threads/thread-service.js";
import {
  AdministrationService,
  isAdministrationCommand,
} from "./administration/administration-service.js";
import { harnessView, requireMachineAccessManagement } from "./administration/authority.js";
import {
  connectionCredentialPrefix,
  connectionRequestOrigin,
  registerConnectionRoutes,
  createConnectionRpcHandlers,
  handleConnectionCommand,
  isConnectionCommand,
  type ConnectionCommandEffects,
  type ConnectionOAuth,
} from "./mcp/connections/index.js";
import { afterResponse } from "./server/after-response.js";
import type { AppService } from "./apps/app-service.js";
import { AppGateway, hasAppAuthority } from "./apps/app-gateway.js";
import { createAppHandlers, registerAppRoutes } from "./apps/app-routes.js";

import { AgentPhoneUpdateHub } from "./agent-phone/update-hub.js";
import type { AgentPhoneUpdateRelease } from "./agent-phone/update-release.js";
import { searchSuggestions } from "./browser/search-suggestions.js";
import { runnerAuxiliaryWelcome } from "./server/runner-auxiliary-welcome.js";
import { createVoiceHandlers } from "./voice/voice-handlers.js";
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

import websocket from "@fastify/websocket";
import {
  HostToMessagingRelayMessageSchema,
  MessagingRelayToHostMessageSchema,
  type HostToMessagingRelayMessage,
  type MessagingRelayToHostMessage,
  type RuntimeChannelRequest,
} from "@opensteer/channel-protocol";
import {
  ProvisionConnectRequestSchema,
  RotateConnectCredentialRequestSchema,
  RevokeConnectRequestSchema,
  RevokeConnectResponseSchema,
} from "@opensteer/control-plane-protocol";
import {
  AttachmentIdSchema,
  CommandIdSchema,
  EnvironmentIdSchema,
  HarnessInstanceIdSchema,
  OpensteerError,
  threadAccessModeAtMost,
  TriggerRevisionIdSchema,
  type AuthenticatedSession,
  type EnvironmentId,
  type HarnessInstanceId,
  type HarnessInstanceStateKind,
  type RunnerId,
} from "@opensteer/core";
import {
  machineIsManagedBy,
  personalRemoteAccessRefusedReason,
  personalRemoteAccessRequiredRefusal,
  runnerIdentityRevokedReason,
  type MachineOwnershipRecord,
} from "@opensteer/database";
import {
  HostDescriptorSchema,
  HostIdentityProofSchema,
  hostIdentityProofBytes,
  hostApiVersion,
  minimumHostApiVersion,
  type HostBootstrapMethod,
  type HostCapability,
  type HostDiscoveryEnvelope,
} from "@opensteer/deployment-authority";
import {
  interactiveRunnerRequestTimeoutMs,
  runnerIdentityRevokedCloseCode,
  runnerIdentityRevokedMessage,
  type CommandService,
  type RealtimeHub,
  type RunnerIdentity,
  type RunnerPeer,
  type RunnerRegistry,
} from "@opensteer/orchestration";
import {
  AgentPhoneHostTargetSchema,
  ApprovePersonalHostAccountLinkRequestSchema,
  BrowserSessionIdSchema,
  BrowserSurfaceIdSchema,
  ConfigurePersonalRemoteAccessRequestSchema,
  ConsumePersonalHostAccountLinkRequestSchema,
  CorrelationIdSchema,
  HostToIntegrationsModuleMessageSchema,
  HostToShellModuleMessageSchema,
  IntegrationsModuleEventSchema,
  PersonalHostAccountUnlinkStepRequestSchema,
  PublishPersonalConnectProjectionRequestSchema,
  RunnerAuxiliaryAuthenticateSchema,
  RunnerAuxiliaryHeartbeatSchema,
  RunnerAuxiliaryModuleSchema,
  RunnerModuleNameSchema,
  RunnerToHostMessageSchema,
  RunnerWireProofSchema,
  ShellModuleToHostMessageSchema,
  agentPhoneOutdatedReason,
  agentToolPayloadMaxSerializedBytes,
  browserViewerCloseCodes,
  clientMacOwnerViewVersion,
  computerAppMaxFrameBytes,
  hostApi,
  rpcSuccess,
  type AgentPhoneHostTarget,
  type ComputerUseSessionSummary,
  type HarnessAuthenticationState,
  type HarnessSourceDescriptor,
  type HostApiHandlers,
  type HostApiServerContext,
  type HostToIntegrationsModuleMessage,
  type HostToRunnerMessage,
  type HostToShellModuleMessage,
  type IntegrationsModuleEvent,
  type MachineAppStatus,
  type MachineModuleSummary,
  type PersonFillVersion,
  type RunnerAuxiliaryChallenge,
  type RunnerAuxiliaryFrameFence,
  type RunnerAuxiliaryModule,
  type RunnerModuleName,
  type ShellModuleEvent,
  runFileMaxBytes,
  runFileNameHeader,
  runFileProofHeader,
  runFileTransferContentType,
} from "@opensteer/protocol";
import {
  BrowserRelayFrameError,
  browserRelayFrameFence,
  decodeBrowserRelayFrame,
  maxBrowserRelayEnvelopeBytes,
  type HostToBrowserRelayMessage,
} from "@opensteer/protocol/browser-relay";
import { BoundedAsyncInbox } from "@opensteer/shared/boundedAsyncInbox";
import { parseHttpEndpointBaseUrl } from "@opensteer/shared/httpEndpoint";
import { processStopTimeoutMs } from "@opensteer/shared/processControl";
import { rawDataBuffer } from "@opensteer/shared/webSocketFrame";
import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type WebSocket from "ws";
import type { RawData } from "ws";
import { z } from "zod";
import type { OpensteerMcpService } from "./mcp/opensteer-mcp-service.js";
import {
  type BrowserConsumerAttachment,
  type BrowserConsumerPeer,
  type BrowserService,
} from "./browser/browser-service.js";
import { createChannelRpcHandlers } from "./channels/channel-handlers.js";
import type { ChannelService } from "./channels/channel-service.js";
import type { PlaceContextService } from "./computer-use/place-context-service.js";
import { HostAuthenticator } from "./identity/auth.js";
import { registerPersonalRemoteExecutor } from "./access/personal-remote-administration-routes.js";
import type { MachineFullDiskAccessService } from "./shell/machine-full-disk-access-service.js";

import type {
  RunnerAuxiliaryPeer,
  RunnerAuxiliaryStream,
  RunnerStreamLossReason,
} from "@opensteer/orchestration";
import type { OwnerProfileService } from "./administration/owner-profile.js";
import type { PersonalRemoteAccessService } from "./access/personal-remote-access-service.js";
import {
  availableSessionExchangeArms,
  registerSessionExchangeRoute,
} from "./access/session-exchange-routes.js";
import type { ContinuationService } from "./agents/continuation-service.js";
import {
  HarnessCatalogReconciliationOwner,
  harnessInspectionDefinition,
  inspectAndRecordHarnessCatalogs,
} from "./agents/harness-catalogs.js";
import type { RunnerAuthenticator } from "./agents/runner-authenticator.js";
import type { AttachmentService } from "./attachments/attachment-service.js";
import type { RunFileRelay } from "./agents/run-file-relay.js";
import { browserRuntimeCompatibilityReason } from "./browser/browser-runtime-compatibility.js";
import type { BrowserSourceService } from "./browser/browser-source-service.js";
import type { PasswordSignInService } from "./browser/password-sign-in-service.js";
import type {
  BrowserRelayEvent,
  RunnerBrowserHub,
  RunnerBrowserPeer,
} from "./browser/runner-browser-hub.js";
import {
  BrowserRuntimeRelayToHostMessageSchema,
  HostToBrowserRuntimeRelayMessageSchema,
} from "./browser/runner-browser-runtime.js";
import {
  registerAgentCdpBridge,
  registerTriggerCdpBridge,
  registerWatchCdpBridge,
} from "./browser/trigger-cdp-bridge.js";
import type { MessagingRelayHub, MessagingRelayPeer } from "./channels/messaging-relay-hub.js";
import { sendComputerAppFrame } from "./computer-apps/computer-app-frame-send.js";
import type { ComputerAppControlPeer, ComputerAppHub } from "./computer-apps/computer-app-hub.js";
import { registerComputerUseDisplayRoutes } from "./computer-use/computer-use-display-routes.js";
import type { ComputerUseService } from "./computer-use/computer-use-service.js";
import type { DisplayStreamHub } from "./computer-use/display-stream-hub.js";
import type { CredentialService } from "./identity/credential-service.js";
import type { HarnessAuthenticationCoordinator } from "./identity/harness-authentication-coordinator.js";
import { HarnessSignInBrowser } from "./identity/harness-sign-in-browser.js";
import { createIdentityRpcHandlers, registerIdentityRoutes } from "./identity/identity-routes.js";
import {
  sealRequestResponse,
  type RequestResponseVault,
} from "./identity/request-response-vault.js";
import type { IntegrationAuthAttemptLifecycle } from "./access/integration-auth-attempt-service.js";
import { registerIntegrationAuthorizationRoutes } from "./access/integration-authorization-routes.js";
import type { DeviceService } from "./devices/device-service.js";
import type { AccessRequests } from "./devices/access-requests.js";
import { createDeviceRpcHandlers, type DeviceRpcOptions } from "./devices/device-routes.js";
import type { LocalServerService } from "./local-servers/local-server-service.js";
import type { LocalServerRegistry } from "./local-servers/local-server-registry.js";
import type { LocalBootstrapService } from "./runtime/local-bootstrap.js";
import {
  projectMachines,
  type MachineAccessView,
  type MachineProjectionInput,
} from "./runtime/machines.js";
import {
  createBrowserSourceRpcHandlers,
  registerBrowserSourceWire,
  setBrowserSourceExtensionCors,
  type BrowserSourceRpcOptions,
} from "./server/browser-source-registration.js";
import { closeWebSocketsWithin } from "./server/connection-drain.js";
import type { EgressService } from "./server/egress-service.js";
import { createHostApiHandlers, type CoreCommand } from "./server/host-api-handlers.js";
import { installPersonalVersionGate, registerHostApi } from "./server/host-api-registration.js";
import { unversionedRoute } from "./server/unversioned-route.js";
import { normalizeHostError } from "./server/http-errors.js";
import { installHostHttpBoundary } from "./server/host-http-boundary.js";
import { hostInternalRoutePaths } from "./server/internal-routes.js";
import { registerResponseCompression } from "./server/response-compression.js";
import type { HostStaticDistribution } from "./server/static-distribution.js";
import {
  installWebSocketLiveness,
  scheduleWebSocketExpiration,
} from "./server/websocket-liveness.js";
import type { ShellControlPeer, ShellControlStreamHandler } from "./shell/shell-control-stream.js";
import { registerShellRoutes } from "./shell/shell-routes.js";
import type { TriggerControlTokenService } from "./triggers/trigger-control-service.js";
import { createTriggerRpcHandlers, registerTriggerRoutes } from "./triggers/trigger-routes.js";
import type { TriggerService } from "./triggers/trigger-service.js";
import type { WatchCapabilityTokenService } from "./triggers/watch-capability.js";
import type { WatchScriptService } from "./triggers/watch-script-service.js";

export { hostInternalRoutePatterns } from "./server/internal-routes.js";

const maxWebSocketFrameBytes = 1 * 1_024 * 1_024;
const runnerControlMaxFrameBytes = 4 * 1_024 * 1_024;
const maxChallengedRunnerConnections = 8;
const maxChallengedChannelRuntimeConnections = 8;
const maxWebSocketBufferedBytes = 8 * 1_024 * 1_024;
const maxBrowserRelayFrameBytes = maxBrowserRelayEnvelopeBytes;
/** How long a stopping Host lets each WebSocket finish closing before ending it. */
const webSocketShutdownGraceMs = 2_000;
/**
 * How long a stopping Host lets an HTTP request in flight finish before cutting
 * it off, leaving time for what closes after HTTP, the database last of all.
 */
const httpShutdownGraceMs = processStopTimeoutMs - 3_000;
const maxBrowserRelayQueuedBytes = 2 * maxBrowserRelayFrameBytes;
function harnessUpdateCommandId(...parts: string[]) {
  const digest = createHash("sha256").update(parts.join("\0")).digest("hex");
  const variant = ["8", "9", "a", "b"][Number.parseInt(digest[16] ?? "0", 16) % 4] ?? "8";
  return CommandIdSchema.parse(
    `cmd_${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`,
  );
}

const HarnessAuthenticationParamsSchema = z.strictObject({
  environmentId: EnvironmentIdSchema,
  harnessInstanceId: HarnessInstanceIdSchema,
});

/**
 * Machines is a whole-inventory view, not a feed: a Deployment with more
 * computers than one page holds is not a shape this surface serves, so it asks
 * each registry for its maximum in one go rather than inventing a cursor.
 */
const machinePageLimit = 100;

export interface HostServerDependencies {
  /** The person's Requests for Home commands agents propose. */
  readonly commandRequests?: import("./commands/requests.js").CommandRequestService;
  /** The owner's plugin API; personal Hosts only. */
  readonly plugins?: import("./plugins/plugin-owner-api.js").PluginOwnerApi;
  readonly pluginAgentWorkStoppedSince?: (runnerId: RunnerId) => string | undefined;
  readonly pluginOAuth?: import("./plugins/plugin-oauth-service.js").PluginOAuthService;
  readonly pluginRequests?: Pick<
    import("./plugins/plugin-executions.js").PluginExecutions,
    "respond"
  >;
  readonly deviceDrivers?: DeviceDriverManagementPort;
  readonly assets?: AssetService;
  readonly transcriptFiles?: TranscriptFiles;
  readonly execution: Pick<PersonalExecution, "canExecute"> & {
    /**
     * The Home has its owner, hosting computer and Personal settings in place, so it can
     * answer the owner's reads. False while it waits for the hosting Runner's agent home.
     */
    readonly initialized: () => boolean;
  };
  readonly connections?: ConnectionOAuth;
  readonly connectionEffects?: ConnectionCommandEffects;
  /** Settles a person's answer to a Request about an external agent's direct operation. */
  readonly agentOperations?: {
    lowerTaskMode?(
      threadId: import("@opensteer/core").ThreadId,
      mode: import("@opensteer/core").ThreadAccessMode,
    ): Promise<void>;
    respond(input: {
      readonly requestId: import("@opensteer/core").RequestId;
      readonly expectedRevision: string;
      readonly resolvedBy: import("@opensteer/core").UserId;
      readonly settlementSessionId: string;
      readonly response: import("@opensteer/core").RequestResponse;
    }): Promise<void>;
    /** The person's Stop on a connected agent's own task. */
    stopSession(input: {
      readonly ownerUserId: import("@opensteer/core").UserId;
      readonly threadId: import("@opensteer/core").ThreadId;
      readonly sessionId: import("@opensteer/core").AgentSessionId;
    }): Promise<{ readonly ended: boolean }>;
  };
  readonly notificationPreviews?: import("./notifications/notification-preview-service.js").NotificationPreviewService;
  readonly passkeys?: boolean;
  readonly fetch?: typeof globalThis.fetch;
  readonly attachments: AttachmentService;
  readonly runFiles: RunFileRelay;
  readonly apps: AppService;
  readonly appOriginSigningKey: Uint8Array;
  readonly appRealOrigins: boolean;
  /** Which forwarding headers to believe; absent keeps the loopback tunnel connector's. */
  readonly trustedProxy?: import("@opensteer/config").TrustedProxy;
  readonly requestResponseVault: RequestResponseVault;
  readonly runToolTokens: import("./agents/run-tool-tokens.js").RunToolTokenService;
  readonly agentTools: OpensteerMcpService;
  readonly authenticator: HostAuthenticator;
  readonly deviceAccess: DeviceAccessService;
  readonly machineFullDiskAccess: MachineFullDiskAccessService;
  readonly browser: BrowserService;
  readonly tabs: TabService;
  readonly toolActivity: AgentToolActivityStore;
  readonly browserSources: BrowserSourceService;
  readonly passwordSignIns: Pick<PasswordSignInService, "get" | "respond">;
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
  readonly computerUse?: Pick<ComputerUseService, "sessionsForRunner"> &
    Partial<Pick<ComputerUseService, "deviceForSession">>;
  readonly placeContext: Pick<PlaceContextService, "assertIncludable">;
  readonly credentials: CredentialService;
  readonly discovery: HostDiscoveryEnvelope;
  /** Signs with this Host's key, so a client can prove an address still answers as this Home. */
  readonly signHostProof?: (bytes: Uint8Array) => string;
  readonly egress: EgressService;
  readonly integrations: {
    readonly access: AccessRequests;
    readonly authAttempts: IntegrationAuthAttemptLifecycle;
    readonly continuations: ContinuationService;
    readonly definitions: DeviceRpcOptions["definitions"];
    readonly devices: DeviceService;
    readonly listConnections: DeviceRpcOptions["listConnections"];
    readonly localServers: LocalServerService;
    readonly localServerRegistry: LocalServerRegistry;
    readonly skills: import("./local-servers/plugin-package-service.js").PluginPackageService;
  };
  /** Shared with Runner registration so live sign-in attempts resume on reconnect. */
  readonly harnessAuthenticationCoordinator: HarnessAuthenticationCoordinator;
  /** Present when reachability is loopback and no account is attached. */
  readonly localBootstrap?: { readonly service: LocalBootstrapService } | undefined;
  /** Present when reachability is routed personal. */
  readonly personalRemoteAccess?: { readonly service: PersonalRemoteAccessService } | undefined;
  /** A Cloud Computer's Home: where its Account claims it, once. */
  readonly managedHomeClaim?: Pick<
    import("./identity/managed-home-claim.js").ManagedHomeClaimService,
    "claim"
  >;
  readonly workHome?: {
    readonly service: WorkHomeService;
  };
  /** The Opensteer Account link, on every Personal Host whether or not it has Remote access. */
  readonly personalAccountLink?: { readonly service: PersonalRemoteAccessService } | undefined;
  /** The personal owner's name; absent before the Home has an owner. */
  readonly ownerProfile?: OwnerProfileService;
  /** What active Runs are streaming, for readers that open a Thread mid-turn. */
  readonly onPersonalScopeCut?: (
    scope: import("@opensteer/protocol/personal-sync").PersonalScope,
  ) => Promise<void>;
  readonly liveText?: import("./runtime/personal-live-text.js").PersonalLiveText;
  readonly realtime: RealtimeHub;
  readonly runnerAuthenticator: RunnerAuthenticator;
  readonly runners: RunnerRegistry;
  readonly resourceRevisions: import("./runtime/personal-resource-revisions.js").ResourceRevisions;
  /** The Host's end of every `shell` module control stream. */
  readonly shellControl: ShellControlStreamHandler;
  /** Present when web distribution is packaged. */
  readonly phoneUpdateRelease?: (() => AgentPhoneUpdateRelease | null) | undefined;
  readonly staticDistribution?: { readonly service: HostStaticDistribution } | undefined;
  readonly store: OpensteerStore;
  readonly triggers: {
    readonly controlTokens: TriggerControlTokenService;
    readonly service: TriggerService;
    readonly watchScripts: WatchScriptService;
    readonly watchBrowserTokens: WatchCapabilityTokenService<"opensteer-watch-browser-cdp">;
  };
}

export async function createHostServer(
  dependencies: HostServerDependencies,
  options: { readonly logger?: boolean | Record<string, unknown> } = {},
): Promise<FastifyInstance> {
  const threadService = new ThreadService(dependencies);
  const app = Fastify({
    routerOptions: { maxParamLength: 8192 },
    bodyLimit: maxWebSocketFrameBytes,
    logger: options.logger ?? false,
    requestIdHeader: false,
    logController: new LogController({
      disableRequestLogging: (request) => {
        const path = (request.url ?? "").split("?", 1)[0] ?? "";
        return (
          hasAppAuthority(request.headers) ||
          path.startsWith("/media/") ||
          path.startsWith(standardCdpConnectPrefix) ||
          path.startsWith("/hooks/v1/") ||
          path.startsWith("/v1/integration-authorizations/") ||
          path === "/v1/plugin-oauth/callback"
        );
      },
    }),
  });
  installTrustedProxy(app, dependencies.trustedProxy ?? "loopback-cloudflared");
  installClientAddress(app);
  const noSendKeys: ReadonlyMap<string, string> = new Map();
  const readSendKeys =
    (session: AuthenticatedHostSession["session"]) => async (ids: readonly MessageId[]) => {
      if (ids.length === 0) return noSendKeys;
      try {
        return await dependencies.store.personalMessageSendKeys(session.user.id, session.id, ids);
      } catch {
        // Optional metadata must not turn an accepted send into a failed acknowledgement.
        app.log.warn("Personal message send keys could not be read");
        return noSendKeys;
      }
    };
  const appGateway = new AppGateway({
    apps: dependencies.apps,
    ...(dependencies.plugins?.pages ? { plugins: dependencies.plugins.pages } : {}),
    identity: dependencies.authenticator.identity,
    signingKey: dependencies.appOriginSigningKey,
    canonicalOrigin: dependencies.discovery.document.canonicalOrigin,
    realOrigins: dependencies.appRealOrigins,
  });
  appGateway.installHttp(app);
  dependencies.plugins?.gateway(appGateway);
  dependencies.assets?.register(app);
  installPersonalVersionGate(app);
  installHostHttpBoundary(app);
  await registerResponseCompression(app);
  const harnessCatalogs = {
    recordHarnessCatalogs: (...args: Parameters<OpensteerStore["recordHarnessCatalogs"]>) =>
      dependencies.store.recordHarnessCatalogs(...args),
    listHarnessInstances: (options?: Parameters<OpensteerStore["listHarnessInstances"]>[0]) =>
      dependencies.store.listHarnessInstances(options),
  };
  const harnessCatalogReconciliations = new HarnessCatalogReconciliationOwner({
    catalogs: harnessCatalogs,
    onError: (environmentId, error) =>
      app.log.warn({ environmentId, err: error }, "Harness catalog reconciliation failed"),
    runners: dependencies.runners,
  });
  app.addHook("onClose", async () => harnessCatalogReconciliations.close());
  const administration = new AdministrationService(
    dependencies,
    (id) => harnessCatalogReconciliations.schedule(id),
    (fields, message) => app.log.warn(fields, message),
  );
  const harnessAuthenticationCoordinator = dependencies.harnessAuthenticationCoordinator;
  const harnessSignInBrowser = new HarnessSignInBrowser({
    browserAvailable: (runnerId) =>
      dependencies.browser.resourcePlacements([runnerId]).some((placement) => placement.available),
    closeTab: async (ownerId, tabId, idempotencyKey) => {
      await dependencies.tabs.close({ kind: "person", ownerId }, [tabId], idempotencyKey);
      await dependencies.browser.closeEngineSignInPage(ownerId, tabId, idempotencyKey);
    },
    createProfile: (input) => dependencies.browser.createProfile(input),
    hasTab: (ownerId, tabId) =>
      dependencies.tabs.get(ownerId, tabId).then(
        () => true,
        () => false,
      ),
    listProfiles: (ownerId) => dependencies.browser.listProfiles(ownerId),
    onError: (error) => app.log.warn({ err: error }, "An AI engine sign-in tab did not close"),
    openTab: async (ownerId, target, idempotencyKey) =>
      (await dependencies.tabs.open({ kind: "person", ownerId }, target, idempotencyKey)).tab.tabId,
  });
  const stopFollowingSignIns = harnessSignInBrowser.follow(harnessAuthenticationCoordinator);
  app.addHook("onClose", async () => stopFollowingSignIns());
  await app.register(websocket, {
    options: {
      maxPayload: maxBrowserRelayFrameBytes,
      perMessageDeflate: false,
    },
    preClose: closeWebSocketsWithin(webSocketShutdownGraceMs, httpShutdownGraceMs, app.server),
  });
  app.addContentTypeParser(
    ["application/octet-stream", "application/x-www-form-urlencoded", "text/plain"],
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );
  // Left as a stream: a run file may be far larger than any body this app buffers.
  app.addContentTypeParser(runFileTransferContentType, (_request, payload, done) =>
    done(null, payload),
  );
  const runnerChallenges = new RunnerChallengeAdmission(maxChallengedRunnerConnections);
  const phoneUpdates = new AgentPhoneUpdateHub({
    authenticator: dependencies.runnerAuthenticator,
    store: dependencies.store,
    release:
      dependencies.phoneUpdateRelease ??
      (() => dependencies.staticDistribution?.service.agentPhoneRelease ?? null),
    changed: () => dependencies.resourceRevisions.bump("machine"),
  });
  app.addHook("onClose", async () => phoneUpdates.close());
  const auxiliaryChallenges = new RunnerChallengeAdmission(maxChallengedChannelRuntimeConnections);
  const browserSocketSessions = new WeakMap<
    object,
    {
      readonly session: AuthenticatedSession;
      readonly mode: "control" | "watch";
      readonly editing: 1 | 2 | undefined;
      readonly basicInput: 1 | undefined;
      readonly surfaceState: 1 | undefined;
      readonly passkeys: "native" | "notice" | undefined;
      readonly popups: boolean;
      readonly autofill: PersonFillVersion | undefined;
    }
  >();
  const realtimeSocketSessions = new WeakMap<object, AuthenticatedHostSession>();
  const socketServer = app.websocketServer;
  const upgradeSocket = socketServer.handleUpgrade.bind(socketServer);
  socketServer.handleUpgrade = (request, socket, head, callback) => {
    const standardCdp = request.url?.startsWith(standardCdpConnectPrefix);
    if (!standardCdp && !realtimeSocketSessions.has(request))
      return upgradeSocket(request, socket, head, callback);
    // This server has no asynchronous verifyClient hook. ws copies the limit
    // into the connection's receiver synchronously during handleUpgrade.
    const limit = socketServer.options.maxPayload;
    socketServer.options.maxPayload = standardCdp
      ? standardCdpMessageMaxBytes
      : personalClientFrameMaxBytes;
    try {
      upgradeSocket(request, socket, head, callback);
    } finally {
      if (limit === undefined) delete socketServer.options.maxPayload;
      else socketServer.options.maxPayload = limit;
    }
  };
  registerAppRoutes(app, dependencies.apps, dependencies.plugins?.pages);
  if (dependencies.plugins?.webhooks)
    registerPluginWebhookRoutes(app, {
      ...dependencies.plugins.webhooks,
      admit: (address) =>
        consumeAnonymousRateLimit(
          dependencies.store.database,
          `plugin-webhook:${address}`,
          120,
          new Date(),
        ),
    });
  registerIdentityRoutes(app, dependencies.authenticator, {
    assertOwner: (userId) => requirePersonalOwner(dependencies.store.database, userId),
  });
  const connectionRoutes = dependencies.connections
    ? {
        oauth: dependencies.connections,
        canonicalOrigin: dependencies.discovery.document.canonicalOrigin,
        // A networked Home answers agents at its public origin alone.
        loopbackOriginAliases: isLoopbackHostname(
          new URL(dependencies.discovery.document.canonicalOrigin).hostname,
        ),
        remoteOrigin: async () =>
          (await dependencies.personalRemoteAccess?.service.status())?.route?.document.route
            .origin ?? null,
      }
    : undefined;
  if (connectionRoutes) registerConnectionRoutes(app, connectionRoutes);
  if (dependencies.workHome) registerWorkHomeRoutes(app, dependencies.workHome.service);
  if (dependencies.managedHomeClaim)
    registerManagedHomeClaimRoute(app, dependencies.managedHomeClaim, (address) =>
      consumeAnonymousRateLimit(
        dependencies.store.database,
        `managed-home-claim:${address}`,
        30,
        new Date(),
      ),
    );
  registerSessionExchangeRoute(app, {
    personalRemoteAccess: dependencies.personalRemoteAccess?.service,
  });
  registerAgentCdpBridge(app, dependencies.browser, dependencies.runToolTokens);
  registerStandardCdpRoute(app, dependencies.browser, dependencies.browserSources.liveTabs);
  registerAgentToolRoute(app, {
    callers: dependencies.agentTools.options.callers,
    service: dependencies.agentTools,
    activity: dependencies.toolActivity,
    realtime: dependencies.realtime,
  });
  registerAgentPageBindingRoute(
    app,
    dependencies.runToolTokens,
    dependencies.tabs,
    dependencies.agentTools.options.callers,
    (claims) => runBrowserCapability(dependencies.store, claims),
  );
  registerBrowserSourceWire(
    app,
    dependencies.browserSources,
    dependencies.discovery.document.canonicalOrigin,
  );
  const browserSourceRpcOptions: BrowserSourceRpcOptions = {
    revalidateSession: async (context: HostApiServerContext) => {
      const current = await dependencies.authenticator.authenticateSession(context.headers, {
        mutation: true,
      });
      if (current.id !== context.session?.id)
        throw new OpensteerError({
          code: "unauthorized",
          message: "The approving session changed.",
        });
    },
    service: dependencies.browserSources,
    passwords: dependencies.passwordSignIns,
    canonicalOrigin: dependencies.discovery.document.canonicalOrigin,
    authority: dependencies.discovery,
    personal: dependencies.personalRemoteAccess !== undefined,
    deploymentName: async () =>
      (await dependencies.authenticator.identity.configuration()).deployment.name ?? "Opensteer",
    signInvitation: dependencies.signBrowserSourceInvitation,
    currentRoute: async () =>
      (await dependencies.personalRemoteAccess?.service.status())?.route ?? null,
  };
  registerIntegrationAuthorizationRoutes(app, {
    ...(dependencies.pluginOAuth ? { plugins: dependencies.pluginOAuth } : {}),
    attempts: dependencies.integrations.authAttempts,
    authenticator: dependencies.authenticator,
    deploymentId: dependencies.discovery.document.deploymentId,
  });
  if (dependencies.pluginOAuth)
    registerPluginOAuthRoutes(app, dependencies.pluginOAuth, dependencies.authenticator);
  const deviceRpcOptions: DeviceRpcOptions = {
    pluginsChanged: (viewers) => {
      if (!viewers.length) return;
      dependencies.resourceRevisions.bump("plugin");
    },
    authenticator: dependencies.authenticator,
    definitions: dependencies.integrations.definitions,
    devices: dependencies.integrations.devices,
    listConnections: dependencies.integrations.listConnections,
    localServers: dependencies.integrations.localServers,
    localServerRegistry: dependencies.integrations.localServerRegistry,
  };
  registerTriggerRoutes(app, dependencies.authenticator, dependencies.triggers.service);
  registerTriggerCdpBridge(app, dependencies.browser, dependencies.triggers.controlTokens);
  registerWatchCdpBridge(app, dependencies.browser, dependencies.triggers.watchBrowserTokens);

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/.well-known/opensteer", async (request, reply) => {
    setBrowserSourceExtensionCors(reply, request.headers.origin);
    void reply.header("cache-control", "no-store");
    const proof = HostIdentityProofSchema.shape.nonce.safeParse(
      (request.query as { readonly proof?: unknown }).proof,
    );
    return HostDescriptorSchema.parse({
      kind: "personal",
      apiVersion: minimumHostApiVersion,
      currentApiVersion: hostApiVersion,
      authority: dependencies.discovery,
      bootstrapMethods: await advertisedBootstrapMethods(dependencies),
      capabilities: advertisedCapabilities(dependencies),
      ...(proof.success && dependencies.signHostProof
        ? {
            identityProof: {
              nonce: proof.data,
              signature: dependencies.signHostProof(
                hostIdentityProofBytes({
                  nonce: proof.data,
                  document: dependencies.discovery.document,
                }),
              ),
            },
          }
        : {}),
    });
  });
  registerDesktopUpdateMaintenance(
    app,
    dependencies.authenticator,
    dependencies.personalRemoteAccess?.service.desktopUpdates ?? null,
    dependencies.store.database,
  );
  // The Account link is its own subsystem: a Home on its own server links to an
  // Opensteer Account with no Remote access at all.
  if (dependencies.personalAccountLink) {
    const accountLink = dependencies.personalAccountLink.service;
    app.post("/v1/personal-remote-access/account-link/proof", async (request, reply) => {
      const caller = await dependencies.authenticator.authenticateSessionContext(request.headers, {
        mutation: true,
      });
      return reply
        .header("cache-control", "no-store")
        .send(
          await accountLink.approveAccountLink(
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
          await accountLink.consumeAccountLink(
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
        .send(await accountLink.resumeAccountLink(caller, request.body));
    });
    app.post(
      "/v1/personal-remote-access/account-unlink/revoke-sessions",
      async (request, reply) => {
        PersonalHostAccountUnlinkStepRequestSchema.parse(request.body);
        const caller = await dependencies.authenticator.authenticateSessionContext(
          request.headers,
          { mutation: true },
        );
        await accountLink.revokeAccountSessions(caller, (effect) => afterResponse(reply, effect));
        return reply.code(204).send();
      },
    );
    app.post("/v1/personal-remote-access/account-unlink/remove-link", async (request, reply) => {
      PersonalHostAccountUnlinkStepRequestSchema.parse(request.body);
      const caller = await dependencies.authenticator.authenticateSessionContext(request.headers, {
        mutation: true,
      });
      await accountLink.removeAccountLink(caller, (effect) => afterResponse(reply, effect));
      return reply.code(204).send();
    });
  }
  // One optional subsystem, one registration decision. A Deployment without
  // Personal reachability does not answer on these paths at all, so no handler
  // repeats an availability check the router already made.
  if (dependencies.personalRemoteAccess) {
    const personalRemoteAccess = dependencies.personalRemoteAccess.service;
    const supervisor = dependencies.localBootstrap?.service;
    if (supervisor)
      registerPersonalRemoteExecutor(
        app,
        supervisor,
        personalRemoteAccess.administration,
        personalRemoteAccess.desktopUpdates,
      );
    const detachAdministration = personalRemoteAccess.administration.subscribe(() =>
      dependencies.realtime.broadcast({ type: "host.personal-remote-access-changed" }),
    );
    app.addHook("onClose", async () => detachAdministration());
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
      await requirePersonalOwner(dependencies.store.database, authenticated.session.user.id);
      return reply.header("cache-control", "no-store").send(await personalRemoteAccess.status());
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
            (effect) => afterResponse(reply, effect),
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
    if (supervisor)
      for (const rotate of [false, true]) {
        app.post(
          `/v1/personal-remote-access/executor/connect-${rotate ? "rotate" : "provision"}`,
          async (request, reply) => {
            supervisor.requireSupervisor(request.headers.authorization);
            const input = rotate
              ? RotateConnectCredentialRequestSchema.parse(request.body)
              : ProvisionConnectRequestSchema.parse(request.body);
            return reply
              .header("cache-control", "no-store")
              .send(await personalRemoteAccess.connectCredentialForExecutor(input, rotate));
          },
        );
      }
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
    harnessCatalogReconciliations.schedule(target.environment.id, [target.harness.id]);
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
      message: `This AI engine is still running work (including any voice call); stop it or wait for it to finish before ${action}`,
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
    return administration.admitHarnessManagement({ userId: session.user.id }, environmentIdInput);
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
    // Same-machine supervisors, the development web server among them, read it before attaching.
    app.get("/v1/local-bootstrap", { config: unversionedRoute }, async (request, reply) => {
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

  const requireRpcSession = (context: HostApiServerContext) => {
    if (!context.session) {
      throw new OpensteerError({ code: "unauthorized", message: "Authentication required" });
    }
    return context.session;
  };

  const machineRegistryRows = async (
    session: NonNullable<HostApiServerContext["session"]>,
    store: OpensteerStore,
    page?: {
      readonly runnerIds: readonly RunnerId[];
      readonly pendingIds: readonly string[];
      readonly asOf: Date;
    },
  ): Promise<Omit<MachineProjectionInput, "deploymentOwnsMainComputer">> => {
    const ownerId = session.user.id;
    await requirePersonalOwner(store.database, ownerId);
    const includeDeployment = true;
    const [runnerPage, pendingRunners] = await Promise.all([
      store.listRunners({
        includeDeployment,
        includeOtherOwners: includeDeployment,
        limit: machinePageLimit,
        ownerId,
        ...(page ? { ids: page.runnerIds } : {}),
      }),
      store.listPendingRunnerEnrollments({
        includeDeployment,
        limit: machinePageLimit,
        ownerId,
        ...(page ? { ids: page.pendingIds, asOf: page.asOf } : {}),
      }),
    ]);
    // A revoked computer has no row to report against, so its directories are
    // not this page's to compare either.
    const active = runnerPage.runners.filter((runner) => runner.revokedAt === null);
    const environmentIds = [
      ...new Set(active.flatMap((runner) => runner.moduleDescriptors.agents?.environmentIds ?? [])),
    ];
    // Counted only for `machines.list`, in the read that returns it; the resource leaves it out.
    const threadsByEnvironment = page
      ? new Map<EnvironmentId, number>()
      : await store.countLiveThreadsByEnvironment(environmentIds);
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
    const manageable = active;
    const ownership =
      manageable.length === 0
        ? new Map<RunnerId, MachineOwnershipRecord>()
        : await store.effectiveMachineOwners(manageable.map((runner) => runner.id));
    const managed = manageable.filter((runner) => {
      const owners = ownership.get(runner.id);
      return owners !== undefined && machineIsManagedBy(owners, ownerId);
    });
    const apps = new Map<string, readonly MachineAppStatus[]>();
    const computerViews = new Map<
      string,
      { ownerViews: Awaited<ReturnType<ComputerViewService["list"]>>; ownerViewVersion?: number }
    >();
    const computerUseSessions = new Map<string, readonly ComputerUseSessionSummary[]>();
    const computerUseDisplayStreamSupported = new Map<string, boolean>();
    const computerUsePolicies = new Map<string, { readonly appApproval: "ask" | "automatic" }>();
    const policyStore = page && new IntegrationPlatformStore(store.database);
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
      // Only Macs use automatic app approval policies.
      const integrationsPlatform = runner.moduleDescriptors.integrations?.platform;
      if (
        integrationsPlatform !== "darwin" &&
        runner.moduleDescriptors.shell?.platform !== "darwin"
      )
        continue;
      // One policy read per Mac, in the page's own store when it has one.
      const target = { deviceId: await store.requireSelfDeviceId(runner.id), ownerUserId: ownerId };
      const policy = policyStore
        ? await policyStore.getDeviceComputerUsePolicy(target)
        : await dependencies.integrations.devices.computerAppApprovals.computerUsePolicy(target);
      computerUsePolicies.set(runner.id, { appApproval: policy.appApproval });
    }
    const access = new Map<string, MachineAccessView>(
      await Promise.all(
        managed.map(async (runner): Promise<[string, MachineAccessView]> => {
          const stored = await store.listActiveShellSessions(runner.id);
          // The row's counters are zero until a session ends, so the live ones
          // are overlaid from the hub; a session the hub no longer holds is
          // one whose final counters are already written.
          const live = dependencies.shellControl.liveSessionBytes(runner.id);
          return [
            runner.id,
            {
              activeSessions: stored.map((summary) => ({ ...summary, ...live.get(summary.id) })),
              ownerReachAvailable: ownership.get(runner.id)?.effectiveOwner !== null,
              policy: {
                ...runner.accessPolicy,
                browser: deviceAccess(runner.accessPolicy).browser,
                apps: deviceAccess(runner.accessPolicy).apps,
              },
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
      pendingRunners,
      runners: runnerPage.runners.map((runner) => {
        const live = dependencies.runners.identityForRunner(runner.id);
        return {
          updateRequired: runner.updateRequired,
          phoneUpdate: phoneUpdates.projection(runner.id, runner.connectionGeneration, !!live),
          allowedModules: runner.allowedModules,
          asleepSince: runner.revokedAt
            ? null
            : dependencies.runners.asleepSince(runner.id, runner.connectionGeneration),
          agentsStoppedSince: runner.revokedAt
            ? null
            : dependencies.runners.agentsStoppedSince(runner.id, runner.connectionGeneration),
          connected: !!live,
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
          readiness: live
            ? moduleReadiness(runner.id, runner.moduleDescriptors.browser?.wireVersion)
            : new Map(),
          revokedAt: runner.revokedAt,
          // Only a live connection says which build it runs.
          runtimeVersion: live?.runtimeVersion ?? null,
        };
      }),
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
        module === "browser" ? browserRuntimeCompatibilityReason(browserSnapshotVersion) : null;
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
    page?: {
      readonly tx: PersonalMutationTransaction;
      readonly deviceIds: readonly string[];
      readonly pendingIds: readonly string[];
      readonly asOf: Date;
    },
  ) => {
    const store = page ? new OpensteerStore(page.tx) : dependencies.store;
    const ids = page?.deviceIds.map((id) => DeviceIdSchema.parse(id));
    const [devices, drivers] = await Promise.all([
      store.listDevices({
        ownerId: session.user.id,
        includeDeployment: true,
        limit: machinePageLimit,
        ...(ids ? { ids } : {}),
      }),
      store.listDeviceDrivers({ includeDetached: true, ...(ids ? { deviceIds: ids } : {}) }),
    ]);
    const registry = await machineRegistryRows(
      session,
      store,
      page && {
        runnerIds: [
          ...new Set(drivers.filter(({ role }) => role === "self").map(({ runnerId }) => runnerId)),
        ],
        pendingIds: page.pendingIds,
        asOf: page.asOf,
      },
    );
    const connections = ids
      ? await listIntegrationConnections(store.database, session.user.id, ids)
      : await dependencies.integrations.devices.deviceConnections(session.user.id);
    const access = new Map(registry.access);
    const computerViews = new Map(registry.computerViews);
    const computerUseSessions = new Map(registry.computerUseSessions);
    const computerUseDisplayStreamSupported = new Map(registry.computerUseDisplayStreamSupported);
    const visibleDeviceIds = new Set(devices.devices.map(({ id }) => id));
    const driverIds = [
      ...new Set(
        drivers
          .filter(({ deviceId }) => visibleDeviceIds.has(deviceId))
          .map(({ runnerId }) => runnerId),
      ),
    ];
    const named =
      driverIds.length > 0
        ? await store.database
            .selectFrom("runners")
            .select(["id", "name", "revokedAt", "connectionGeneration"])
            .where("id", "in", driverIds)
            .execute()
        : [];
    const runnerNames = new Map(named.map((runner) => [runner.id, runner.name]));
    const activeDrivers = new Map(
      named
        .filter((runner) => !runner.revokedAt)
        .map((runner) => [runner.id, Number(runner.connectionGeneration)]),
    );
    const inputs = await Promise.all(
      devices.devices.map(async (device) => {
        const bindings = drivers.filter((binding) => binding.deviceId === device.id);
        const selfRunnerId =
          bindings.find((binding) => binding.role === "self" && !binding.detachedAt)?.runnerId ??
          null;
        if (!access.has(device.id))
          access.set(device.id, {
            activeSessions: [],
            ownerReachAvailable: true,
            policy: {
              ...device.accessPolicy,
              browser: deviceAccess(device.accessPolicy).browser,
              apps: deviceAccess(device.accessPolicy).apps,
            },
            revision: device.accessPolicyRevision,
          });
        if (dependencies.computerViews)
          computerViews.set(device.id, {
            ...computerViews.get(selfRunnerId ?? device.id),
            ownerViews: await dependencies.computerViews.list(session.user.id, device.id),
          });
        computerUseSessions.set(
          device.id,
          dependencies.computerUse?.sessionsForRunner(device.id) ?? [],
        );
        const stream = dependencies.computerApps.displayStream(device.id);
        computerUseDisplayStreamSupported.set(
          device.id,
          stream !== null && stream !== "unsupported",
        );
        const connection = connections.find(
          (entry) =>
            entry.computer?.deviceId === device.id &&
            entry.status !== "revoked" &&
            !entry.computer.blockedAt &&
            isPhoneDisplayDefinitionId(entry.definitionId),
        );
        const screenDriver = bindings.find(
          (binding) => binding.role === "screen" && !binding.detachedAt,
        );
        const screenGeneration = screenDriver && activeDrivers.get(screenDriver.runnerId);
        return {
          device,
          selfRunnerId,
          drivers: bindings.map((binding) => ({
            role: binding.role,
            runnerId: binding.runnerId,
            generation: binding.generation,
            attached: binding.detachedAt === null,
            runnerName: runnerNames.get(binding.runnerId) ?? "Computer",
          })),
          screenAsleep:
            !!screenDriver &&
            screenGeneration !== undefined &&
            dependencies.runners.asleepSince(screenDriver.runnerId, screenGeneration) !== null,
          screenStopped:
            !!screenDriver &&
            dependencies.runners.agentsStoppedSince(screenDriver.runnerId) !== null,
          screenStatus: dependencies.computerApps.deviceStatus(device.id),
          screenConnected:
            !!screenDriver &&
            screenGeneration !== undefined &&
            dependencies.runners.identityForRunner(screenDriver.runnerId)?.connectionGeneration ===
              screenGeneration &&
            dependencies.computerApps.attached(device.id),
          phoneAccess: connection?.computer?.access ?? null,
        };
      }),
    );
    return projectMachines({
      ...registry,
      access,
      computerViews,
      computerUseSessions,
      computerUseDisplayStreamSupported,
      devices: inputs,
      deploymentOwnsMainComputer: true,
    });
  };

  const personalResources = new PersonalResources(dependencies, machineSummaries);
  const personalReads = createPersonalReads(dependencies, personalResources, readSendKeys);
  const coreRpcHandlers = {
    ...createReferenceHandlers(dependencies.store, resolvePersonalReferences),
    ...createAssetUrlHandlers(dependencies.assets),
    ...createTranscriptFileHandlers(dependencies.transcriptFiles),
    ...createVoiceHandlers({ ...dependencies, threads: threadService }),
    "agentPhone.target.get": async (_input, context) => {
      requireRpcSession(context);
      return rpcSuccess(
        hostApi["agentPhone.target.get"].success.parse(await agentPhoneHostTarget(dependencies)),
      );
    },
    ...createAppHandlers(dependencies.apps, appGateway),
    "tabs.get": async (input, context) =>
      rpcSuccess(await dependencies.tabs.get(requireRpcSession(context).user.id, input.tabId)),
    "tabs.state": async (_input, context) =>
      rpcSuccess(await dependencies.tabs.bootstrap(requireRpcSession(context).user.id, 240 * 1024)),
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
    "automaticModels.get": async (_input, context) =>
      rpcSuccess(await readAutomaticModelPreview(dependencies, requireRpcSession(context).user.id)),
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
          catalogs: harnessCatalogs,
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
      await requireMachineAccessManagement(
        dependencies.store,
        { userId: session.user.id },
        input.runnerId,
      );
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
      return rpcSuccess(
        hostApi["machines.list"].success.parse({
          machines: await machineSummaries(session),
        }),
      );
    },
    "thread.messages.list": async (input, context) => {
      const page = await readThreadHistory(dependencies.store.database, {
        threadId: input.threadId,
        ownerId: requireRpcSession(context).user.id,
        ...(input.before ? { before: input.before } : {}),
        ...(input.query ? { query: input.query } : {}),
        ...(input.aroundMessageId ? { aroundMessageId: input.aroundMessageId } : {}),
        maxItems: input.limit ?? 100,
      });
      if (!page) throw new OpensteerError({ code: "not_found", message: "Thread not found" });
      return rpcSuccess({
        ...page,
        messages: await withClientSendKeys(page.messages, readSendKeys(requireRpcSession(context))),
      });
    },
    "browser.searchSuggestions.get": async (input) =>
      rpcSuccess(await searchSuggestions(input.query, dependencies.fetch ?? globalThis.fetch)),
    "browser.contextCandidate.get": async (input, context) =>
      rpcSuccess(
        await dependencies.browser.readContextCandidate(requireRpcSession(context).user.id, input),
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
    "thread.message.revisions.list": async (input, context) =>
      rpcSuccess(
        await dependencies.store.listMessageRevisions({
          ...input,
          sessionId: requireRpcSession(context).id,
          requestedBy: requireRpcSession(context).user.id,
        }),
      ),
    "thread.inputQueue.get": async (input, context) => {
      const session = requireRpcSession(context);
      const requestedBy = session.user.id;
      const thread = await dependencies.store.getThreadForOwner(input.threadId, requestedBy);
      if (!thread) throw new OpensteerError({ code: "not_found", message: "Thread not found" });
      const queue = await dependencies.store.getThreadInputQueue({
        threadId: thread.id,
        requestedBy,
        sessionId: session.id,
        ...(input.expectedRevision === undefined
          ? {}
          : { expectedRevision: input.expectedRevision }),
      });
      const keys = await readSendKeys(session)(queue.items.map(({ message }) => message.id));
      const schema = hostApi["thread.inputQueue.get"].success;
      const keyed = schema.safeParse({
        ...queue,
        items: queue.items.map((item) => {
          const key = keys.get(item.message.id);
          return key ? { ...item, message: { ...item.message, clientSendKey: key } } : item;
        }),
      });
      return rpcSuccess(keyed.success ? keyed.data : schema.parse(queue));
    },
    "assignment.get": async (input, context) => {
      const assignment = await dependencies.store.getAssignmentForOwner({
        assignmentId: input.assignmentId,
        ownerId: requireRpcSession(context).user.id,
        reader: personTaskReader,
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
    "thread.requests.list": createThreadRequestHandler(dependencies.store),
    "attention.get": async (_input, context) => {
      const [attention, homeName] = await Promise.all([
        dependencies.store.notificationState.attention(requireRpcSession(context).user.id),
        dependencies.store.homeComputerName(),
      ]);
      return rpcSuccess({ ...attention, homeName });
    },
    "needsYou.get": async (input, context) =>
      rpcSuccess(
        await needsYouPage(dependencies.store.database, {
          ...(input.before ? { before: input.before } : {}),
          limit: Math.min(input.limit ?? 50, 50),
          maxBytes: 64 * 1024,
          userId: requireRpcSession(context).user.id,
        }),
      ),
    "tasks.list": async ({ active: _active, deviceAccessRequests: _requests, ...input }, context) =>
      personalReads.handlers["tasks.page"](input, context),
    ...personalReads.handlers,
  } satisfies Pick<
    HostApiHandlers,
    | keyof typeof personalReads.handlers
    | "agentPhone.target.get"
    | "assignment.get"
    | "thread.assignments.list"
    | "browser.searchSuggestions.get"
    | "browser.contextCandidate.get"
    | "browser.tabIcon.get"
    | "browser.history.get"
    | "browser.history.icons.get"
    | "thread.browserUsage.get"
    | "apps.list"
    | "tabs.get"
    | "tabs.state"
    | "apps.get"
    | "apps.view"
    | "attachment.get"
    | "attachment.upload"
    | "attachment.content"
    | "attention.get"
    | "needsYou.get"
    | "harness.authentication.get"
    | "automaticModels.get"
    | "harness.catalog.refresh"
    | "harness.modelServers.discover"
    | "voice.open"
    | "voice.start"
    | "voice.renew"
    | "voice.context"
    | "voice.say"
    | "voice.stop"
    | "machine.access.history"
    | "machines.list"
    | "requests.list"
    | "run.attempts.list"
    | "tasks.list"
    | "asset.urls"
    | "thread.messages.list"
    | "thread.inputQueue.get"
    | "thread.message.revisions.list"
    | "thread.requests.list"
    | "references.resolve"
  >;

  const executeCoreCommand = async (command: CoreCommand, context: HostApiServerContext) => {
    if (isConnectionCommand(command)) {
      if (!dependencies.connections)
        throw new OpensteerError({
          code: "not_found",
          message: "Agent connections are unavailable.",
        });
      const result = await handleConnectionCommand(
        dependencies.connections,
        command,
        context,
        dependencies.connectionEffects,
      );
      // The person's other devices may be showing the list.
      if (context.session) dependencies.realtime.publishConnectionsChanged(context.session.user.id);
      return result;
    }
    const session = requireRpcSession(context);
    const userId = session.user.id;
    if (isAdministrationCommand(command))
      return administration.execute(
        { kind: "person", userId, sessionId: session.id },
        command,
        context.afterResponse,
      );
    switch (command.type) {
      case "settings.plugin.enabled.set": {
        const result = await dependencies.integrations.devices.store.settings.setEnabled(
          userId,
          command,
        );
        return result;
      }
      case "thread.visit": {
        const visit = await dependencies.store.notificationState.visit({
          threadId: command.threadId,
          visitedAt: command.visitedAt,
          userId,
        });
        return { type: command.type, ...visit };
      }
      case "thread.done.set": {
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
      case "notification.preview.register": {
        const previews = dependencies.notificationPreviews;
        if (!previews)
          throw new OpensteerError({
            code: "bad_request",
            message: "Notification previews are unavailable",
          });
        const identity = { userId, authSessionId: session.id };
        await previews.register({ ...command, ...identity });
        return {
          type: command.type,
          installationId: command.installationId,
          keyId: command.keyId,
          registered: true,
        };
      }
      case "attachment.upload.create":
        return {
          attachment: await dependencies.attachments.reserve({
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
      case "thread.create":
        return threadService.create({ kind: "person", userId }, command);

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
        const sent = await threadService.sendMessage(
          { kind: "person", userId },
          command,
          session.id,
        );
        const [message] = await withClientSendKeys([sent.message], readSendKeys(session));
        return { ...sent, message: message! };
      }

      case "thread.inputQueue.resume":
        return {
          ...(await threadService.resume({ kind: "person", userId }, command)),
          type: command.type,
        };

      case "thread.input.lease.take":
      case "thread.input.lease.renew":
      case "thread.input.lease.release":
        return threadService.lease({ kind: "person", userId }, command, {
          id: session.id,
          deviceLabel: describeSessionDevice(
            typeof context.headers["user-agent"] === "string"
              ? context.headers["user-agent"]
              : null,
          ).label,
        });
      case "thread.input.edit":
        return {
          type: command.type,
          ...(await threadService.edit({ kind: "person", userId }, command, {
            id: session.id,
            deviceLabel: describeSessionDevice(
              typeof context.headers["user-agent"] === "string"
                ? context.headers["user-agent"]
                : null,
            ).label,
          })),
        };
      case "thread.input.steer":
        return {
          ...(await threadService.steer({ kind: "person", userId }, command, session.id)),
          type: command.type,
        };

      case "thread.input.cancel":
        return {
          ...(await threadService.cancel({ kind: "person", userId }, command, session.id)),
          type: command.type,
        };

      case "thread.input.move":
        return {
          ...(await threadService.move({ kind: "person", userId }, command, session.id)),
          type: command.type,
        };

      case "thread.execution.update":
        return threadService.configure({ kind: "person", userId }, command);

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
        const result = await dependencies.commands.updateThreadAccessMode({
          accessMode: command.accessMode,
          requestedBy: userId,
          threadId: command.threadId,
        });
        if (!threadAccessModeAtMost(thread.accessMode, result.thread.accessMode)) {
          dependencies.browser.lowerStandardCdpTaskMode(command.threadId, result.thread.accessMode);
          await dependencies.agentOperations?.lowerTaskMode?.(
            command.threadId,
            result.thread.accessMode,
          );
        }
        return { ...result, type: command.type };
      }
      case "node.stop": {
        const result = await dependencies.commands.stopNode({ ...command, requestedBy: userId });
        return { type: command.type, wasDuplicate: result.wasDuplicate };
      }
      case "run.interrupt":
        return {
          ...(await threadService.interrupt({ kind: "person", userId }, command)),
          type: command.type,
        };
      case "agent.session.stop": {
        if (!dependencies.agentOperations)
          throw new OpensteerError({
            code: "conflict",
            message: "Connected agents' direct work is unavailable on this Home.",
          });
        const result = await dependencies.agentOperations.stopSession({
          ownerUserId: userId,
          threadId: command.threadId,
          sessionId: command.agentSessionId,
        });
        return { ended: result.ended, type: command.type };
      }

      case "request.respond": {
        const expectedRevision = command.expectedRevision;
        if (expectedRevision === undefined)
          throw new OpensteerError({
            code: "bad_request",
            reason: "request-review-required",
            message: "Review the current Request before answering.",
          });
        const pending = await dependencies.store.requests.get(command.requestId);
        if (!pending || pending.status !== "pending") {
          throw new OpensteerError({ code: "conflict", message: "Request is no longer pending" });
        }
        if (pending.mode === "durable") {
          const input = {
            requestId: command.requestId,
            expectedRevision,
            resolvedBy: userId,
            settlementSessionId: session.id,
            response: command.response,
          };
          await (async (): Promise<void> => {
            // A command an agent proposed: approving is `request.command.approve`, never a form
            // answer, so anything an app sends here declines it, its words handed to the agent.
            if (pending.command) {
              if (!dependencies.commandRequests)
                throw new OpensteerError({ code: "not_found", message: "Request not found" });
              await dependencies.commandRequests.decline(input);
              return;
            }
            // A connected agent's direct operation: the answer settles it, with no Runner.
            if (pending.originatingAgentSessionId && pending.kind === "person.question") {
              if (!dependencies.agentOperations)
                throw new OpensteerError({
                  code: "conflict",
                  message: "Connected agents' direct work is unavailable on this Home.",
                });
              await dependencies.agentOperations.respond(input);
              return;
            }
            switch (pending.kind) {
              case "plugin.account":
              case "plugin.approval":
              case "plugin.input":
                if (!dependencies.pluginRequests)
                  throw new OpensteerError({
                    code: "conflict",
                    message: "Plugin Requests are unavailable.",
                  });
                await dependencies.pluginRequests.respond(input);
                return;
              // A sign-in is answered by `browser.sign-in.respond`, which can
              // deliver it; a saved-password sign-in is approved only on its
              // Mac and declined with its own command; a copy Request can no
              // longer be answered at all.
              case "browser.sign-in":
              case "browser.password-sign-in":
                throw new OpensteerError({
                  code: "conflict",
                  message:
                    pending.kind === "browser.sign-in"
                      ? "Answer a sign-in Request with browser.sign-in.respond"
                      : pending.kind === "browser.password-sign-in"
                        ? "Answer a saved-password sign-in with browser.password-sign-in.respond"
                        : "This Request can no longer be answered",
                });
              case "browser.access": {
                const result = await dependencies.browser.resolveRequest(input);
                if (result.request.status === "fulfilled")
                  dependencies.integrations.continuations.notify();
                return;
              }
              case "integration.access": {
                const result = await dependencies.integrations.access.resolve(input);
                if (result.request.status === "fulfilled")
                  dependencies.integrations.continuations.notify();
                return;
              }
              case "device.access":
                await dependencies.deviceAccess.decline(input);
                return;
              case "person.question": {
                await dependencies.store.requests.answerPersonQuestion(input);
                return;
              }
              case "machine.full-disk-access":
                await dependencies.machineFullDiskAccess.decline(input);
                return;
              // Allow uses integration.computer.setup.respond to consume exact
              // owner-reviewed setup. This generic path only declines.
              case "computer.app.access":
                await dependencies.integrations.devices.computerAppApprovals.declineComputerAppAccess(
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
            expectedRevision,
            settlementSessionId: session.id,
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
        harnessCatalogReconciliations.schedule(environment.id, [harness.id]);
        return { harness: harnessView(harness), type: command.type };
      }
      case "harness.update": {
        const environment = await admitHarnessManagement(session, command.environmentId);
        const runner = dependencies.runners.identityForEnvironment(environment.id);
        if (!runner) {
          throw new OpensteerError({
            code: "conflict",
            message: "Reconnect this work location before updating its AI engine",
            retryable: true,
          });
        }
        const advertised = runner.modules.agents?.harnessDrivers.find(
          (driver) => driver.driverKind === command.driverKind,
        );
        const installation = advertised?.installation;
        if (!installation) {
          throw new OpensteerError({
            code: "conflict",
            message: "This Runner does not support installed AI engine updates",
          });
        }
        if (installation.update === "manual") {
          throw new OpensteerError({
            code: "conflict",
            message:
              installation.detail ?? "Update this AI engine with the tool that installed it.",
          });
        }
        const harnesses = await dependencies.store.listHarnessInstances({
          environmentIds: [environment.id],
        });
        for (const harness of harnesses) {
          if (
            harness.driverKind !== command.driverKind ||
            (installation.scope === "ambient" && harness.stateKind !== "ambient")
          )
            continue;
          await assertHarnessIsIdle(environment.id, harness.id, "updating it");
        }
        if (
          harnessAuthenticationCoordinator.hasPendingAttemptForDriver(
            environment.id,
            command.driverKind,
          )
        ) {
          throw new OpensteerError({
            code: "conflict",
            message: "This AI engine is signing in. Finish or cancel sign-in before updating.",
            retryable: true,
          });
        }
        const commandId = harnessUpdateCommandId(
          userId,
          environment.id,
          command.driverKind,
          command.idempotencyKey,
        );
        await dependencies.runners.dispatch(
          {
            commandId: CommandIdSchema.parse(commandId),
            correlationId: CorrelationIdSchema.parse(commandId),
            driverKind: command.driverKind,
            environmentId: environment.id,
            type: "harness.update",
          },
          AbortSignal.timeout(30_000),
        );
        const current = dependencies.runners
          .identityForEnvironment(environment.id)
          ?.modules.agents?.harnessDrivers.find(
            (driver) => driver.driverKind === command.driverKind,
          )?.installation;
        return {
          installation:
            current?.update === "updating"
              ? current
              : { ...installation, update: "updating" as const },
          type: command.type,
        };
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
        harnessCatalogReconciliations.schedule(environment.id, []);
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
      case "harness.authentication.browse": {
        const target = await admitHarnessAuthentication(session, {
          environmentId: command.environmentId,
          harnessInstanceId: command.harnessInstanceId,
        });
        return {
          tabId: await harnessSignInBrowser.browse({
            coordinator: harnessAuthenticationCoordinator,
            ownerId: userId,
            runnerId: dependencies.runners.identityForEnvironment(target.environment.id)?.runnerId,
            signal: AbortSignal.timeout(30_000),
            target,
          }),
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
        harnessCatalogReconciliations.schedule(target.environment.id, [target.harness.id]);
        return { ...envelope, type: command.type };
      }
      case "machine.session.bind":
        await deviceMembershipTurn(dependencies.store, () =>
          dependencies.store.bindDeviceSession({
            machineId: command.machineId,
            sessionId: session.id,
            userId,
            proof: command.proof,
          }),
        );
        return { type: command.type };
      case "machine.access.update": {
        const deviceId =
          "deviceId" in command
            ? command.deviceId
            : await dependencies.store.requireSelfDeviceId(command.runnerId);
        const ownership = (await dependencies.store.effectiveDeviceOwners([deviceId])).get(
          deviceId,
        );
        if (!ownership || !machineIsManagedBy(ownership, userId))
          throw new OpensteerError({
            code: "forbidden",
            message: "Only this Device's owner can change access.",
          });
        const runnerId = await dependencies.store.getDeviceSelfRunnerId(deviceId);
        const change = async () => {
          const result = await dependencies.store.updateDeviceAccessPolicy({
            deviceId,
            ownerId: userId,
            allowDeployment: true,
            expectedRevision: command.expectedRevision,
            policy: command.policy,
            idempotency: { key: command.idempotencyKey, requestedBy: userId },
            ...("runnerId" in command ? { legacyRunnerId: command.runnerId } : {}),
            ...("requestReview" in command && command.requestReview
              ? { requestReview: command.requestReview }
              : {}),
          });
          if (result.outcome === "updated" && !result.replayed) {
            if (runnerId && result.changed.shell)
              await dependencies.shellControl.endMachineSessions(runnerId, "policy-changed");
            if (runnerId && result.changed.browser && !deviceAccess(command.policy).browser)
              await dependencies.browser.disableAgentAccess(runnerId);
            if (result.changed.apps && !deviceAccess(command.policy).apps) {
              await dependencies.computerApps.disableAgentAccess(deviceId);
            }
          }
          return result;
        };
        const enterRunner = () =>
          runnerId
            ? dependencies.shellControl.withMachineAdmission(runnerId, () =>
                dependencies.computerApps.withRunnerAdmission(runnerId, () =>
                  dependencies.browser.withRunnerAdmission(runnerId, change),
                ),
              )
            : change();
        const result = await dependencies.computerApps.withDeviceAdmissions(
          [deviceId],
          enterRunner,
        );
        if (result.outcome === "conflict")
          return { outcome: "conflict" as const, type: command.type };
        return { outcome: "updated" as const, revision: result.revision, type: command.type };
      }
      case "personal.remoteAccess.request": {
        const administration = dependencies.personalRemoteAccess?.service.administration;
        if (!administration)
          throw new OpensteerError({
            code: "not_found",
            message: "Personal remote access is unavailable",
          });
        const operation = await administration.request(
          session,
          command.intent,
          command.idempotencyKey,
        );
        context.afterResponse?.(() => administration.release(operation.id));
        return { type: command.type, operation };
      }
      case "personal.remoteAccess.pairing.create": {
        const service = dependencies.personalRemoteAccess?.service;
        if (!service)
          throw new OpensteerError({
            code: "not_found",
            message: "Personal remote access is unavailable",
          });
        return { type: command.type, pairing: await service.issuePairingCode({ session }) };
      }
      case "personal.accountLink.unlink": {
        const service = dependencies.personalAccountLink?.service;
        if (!service)
          throw new OpensteerError({
            code: "not_found",
            message: "Opensteer Account linking is unavailable",
          });
        await service.unlinkAccount({ session }, context.afterResponse);
        service.administration.changed();
        return { type: command.type };
      }
      case "personal.accountLink.approve":
      case "personal.accountLink.complete":
      case "personal.accountLink.resume": {
        const service = dependencies.personalAccountLink?.service;
        if (!service)
          throw new OpensteerError({
            code: "not_found",
            message: "Opensteer Account linking is unavailable",
          });
        const caller = { session };
        if (command.type === "personal.accountLink.approve")
          return {
            type: command.type,
            proof: await service.approveAccountLink(caller, command.challenge),
          };
        if (command.type === "personal.accountLink.resume") {
          const access = await service.resumeAccountLink(caller, { schemaVersion: 1 });
          service.administration.changed();
          return { type: command.type, access };
        }
        const access = await service.consumeAccountLink(caller, command.completion);
        service.administration.changed();
        return { type: command.type, access };
      }
      case "session.revoke":
        await signOutDeviceSession(dependencies, session, command.sessionId, context.afterResponse);
        return { type: command.type };
      case "runner.enrollment.createLocal": {
        const enrollment = await dependencies.runnerAuthenticator.createEnrollment({
          ...(command.access ? { access: command.access } : {}),
          ...(command.preparedIdentity ? { preparedIdentity: command.preparedIdentity } : {}),
          allowedModules: command.allowedModules,
          createdBy: userId,
          idempotencyKey: command.idempotencyKey,
          lifetimeSeconds: 600,
          name: command.name,
          runnerKind: "local",
        });
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
          ...(command.access ? { access: command.access } : {}),
          ...(command.preparedIdentity ? { preparedIdentity: command.preparedIdentity } : {}),
          createdBy: userId,
          idempotencyKey: command.idempotencyKey,
          lifetimeSeconds: 600,
          name: command.name,
          ...(command.profile ? { profile: command.profile } : {}),
        });
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
        return { state, type: command.type };
      }
      case "browser.session.start": {
        if (command.input.threadId) {
          const thread = await dependencies.store.getThreadForOwner(command.input.threadId, userId);
          if (!thread) {
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
            ...(command.input.homeRunnerId !== undefined
              ? { homeRunnerId: command.input.homeRunnerId }
              : {}),
            name: command.input.name,
            idempotencyKey: command.idempotencyKey,
            ownerId: userId,
          }),
          type: command.type,
        };
      case "tab.open": {
        const { tab } = await dependencies.tabs.open(
          { kind: "person", ownerId: userId },
          command.target,
          command.idempotencyKey,
          undefined,
          command.typed === true,
        );
        return {
          type: command.type,
          tab,
          layout: (await dependencies.tabs.project({ kind: "person", ownerId: userId })).layout,
        };
      }
      case "tab.reopen":
        return {
          type: command.type,
          ...(await dependencies.tabs.reopen(
            { kind: "person", ownerId: userId },
            command.tabId,
            command.idempotencyKey,
          )),
        };
      case "tab.close":
        return {
          type: command.type,
          ...(await dependencies.tabs.close(
            { kind: "person", ownerId: userId },
            command.tabIds,
            command.idempotencyKey,
          )),
          layout: (await dependencies.tabs.project({ kind: "person", ownerId: userId })).layout,
        };
      case "tab.activate":
        return {
          type: command.type,
          ...(await dependencies.tabs.activate(userId, command.tabId, command.idempotencyKey)),
        };
      case "tab.organize": {
        const { type, idempotencyKey, ...input } = command;
        return {
          type,
          ...(await dependencies.tabs.organize(
            { kind: "person", ownerId: userId },
            input,
            idempotencyKey,
          )),
          layout: (await dependencies.tabs.project({ kind: "person", ownerId: userId })).layout,
        };
      }
      case "tab.group.update": {
        const { type, idempotencyKey, ...input } = command;
        return {
          type,
          ...(await dependencies.tabs.updateGroup(
            { kind: "person", ownerId: userId },
            input,
            idempotencyKey,
          )),
          layout: (await dependencies.tabs.project({ kind: "person", ownerId: userId })).layout,
        };
      }
      case "tab.group.delete":
        return {
          type: command.type,
          ...(await dependencies.tabs.deleteGroup(userId, command.groupId, command.idempotencyKey)),
        };
      case "app.rename":
      case "app.start":
      case "app.stop":
      case "app.delete":
        return handleAppCommand(dependencies.apps, command, userId);
      case "browser.session.close":
        await dependencies.browser.stop(userId, BrowserSessionIdSchema.parse(command.sessionId));
        return { type: command.type };
      case "browser.pool.notice.seen":
        await dependencies.browser.poolNoticeSeen(
          userId,
          BrowserSurfaceIdSchema.parse(command.surfaceId),
          command.noticeId,
        );
        return { type: command.type };
      case "browser.pool.restart":
        await dependencies.browser.restartPooledBrowser(
          userId,
          command.runnerId as RunnerId,
          command.idempotencyKey,
        );
        return { type: command.type };
    }
    throw new OpensteerError({
      code: "not_found",
      message: "Command unavailable on a Personal Host",
    });
  };

  const handleCoreCommand = async (command: CoreCommand, context: HostApiServerContext) =>
    hostApi["commands.dispatch"].success.parse(await executeCoreCommand(command, context));

  const identityRpcHandlers = createIdentityRpcHandlers(
    dependencies.authenticator,
    (session, sessionId, afterResponse) =>
      signOutDeviceSession(dependencies, session, sessionId, afterResponse),
  );

  registerHostApi(
    app,
    dependencies.authenticator,
    {
      ...createHostApiHandlers(
        identityRpcHandlers,
        createTriggerRpcHandlers(dependencies.triggers.service),
        dependencies.triggers.service,
        createDeviceRpcHandlers(deviceRpcOptions),
        deviceRpcOptions,
        createChannelRpcHandlers(dependencies.channels.service),
        dependencies.channels.service,
        createBrowserSourceRpcHandlers(browserSourceRpcOptions),
        browserSourceRpcOptions,
        coreRpcHandlers,
        handleCoreCommand,
        dependencies.computerViews,
        dependencies.plugins,
        dependencies.pluginOAuth,
        dependencies.commandRequests,
      ),
      ...(dependencies.connections
        ? createConnectionRpcHandlers(dependencies.connections, (ownerId) =>
            dependencies.browserSources.chromeTabGrantCatalog(ownerId),
          )
        : {
            "connections.list": async () => {
              throw new OpensteerError({
                code: "not_found",
                message: "Agent connections are unavailable.",
              });
            },
            "connections.authorization.get": async () => {
              throw new OpensteerError({
                code: "not_found",
                message: "Agent connections are unavailable.",
              });
            },
            "connections.activity": async () => {
              throw new OpensteerError({
                code: "not_found",
                message: "Agent connections are unavailable.",
              });
            },
            "threads.activity": async () => {
              throw new OpensteerError({
                code: "not_found",
                message: "Agent connections are unavailable.",
              });
            },
          }),
      "personal.accountLink.get": async (_input, context) => {
        const service = dependencies.personalAccountLink?.service;
        if (!service)
          throw new OpensteerError({
            code: "not_found",
            message: "Opensteer Account linking is unavailable",
          });
        return rpcSuccess(await service.accountLinkStatus(context.session!));
      },
      "personal.remoteAccess.get": async (_input, context) => {
        const service = dependencies.personalRemoteAccess?.service;
        if (!service)
          throw new OpensteerError({
            code: "not_found",
            message: "Personal remote access is unavailable",
          });
        return rpcSuccess(await service.administration.status(context.session!));
      },
    },
    {
      guardResponse: (input, context) => {
        return dependencies.realtime.guardRead(personalResponseScopes(input, context.session?.id));
      },
      revalidateResponse: async (context) => {
        if (!context.session) return;
        const current = await dependencies.authenticator.authenticateSession(context.headers);
        if (current.id !== context.session.id || current.user.id !== context.session.user.id)
          throw new OpensteerError({ code: "unauthorized", message: "This session ended." });
      },
    },
  );

  registerDeviceEnrollmentPreview(app, dependencies.store.database);
  app.post(
    "/v1/runner/leave",
    { config: unversionedRoute, bodyLimit: 8 * 1024 },
    async (request, reply) => {
      if (
        !(await consumeAnonymousRateLimit(
          dependencies.store.database,
          `device-leave:${request.ip}`,
          30,
          new Date(),
        ))
      )
        throw new OpensteerError({
          code: "resource_exhausted",
          message: "Too many device leave requests",
        });
      const proof = RunnerLeaveRequestSchema.parse(request.body);
      await removeSignedDevice(dependencies, proof);
      return reply
        .header("cache-control", "no-store")
        .send(RunnerLeaveResponseSchema.parse({ outcome: "removed" }));
    },
  );
  // A Runner's own file routes: its run token authenticates them and its admission by
  // capabilities decides compatibility, so a Runner of another API epoch is served too.
  app.get("/v1/runner/attachments", { config: unversionedRoute }, async (request, reply) => {
    const token = requireBearerToken(request);
    const query = z.strictObject({ after: AttachmentIdSchema.optional() }).parse(request.query);
    const page = await dependencies.attachments.listForRun(token, query.after ?? null);
    return reply.header("cache-control", "no-store").send(page);
  });

  app.get(
    "/v1/runner/attachments/:attachmentId/content",
    { config: unversionedRoute },
    async (request, reply) => {
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
    },
  );

  app.put(
    "/v1/runner/file-transfers/:id",
    { config: unversionedRoute, bodyLimit: runFileMaxBytes },
    async (request, reply) => {
      const token = requireBearerToken(request);
      const { id } = z.strictObject({ id: z.uuid() }).parse(request.params);
      const sizeBytes = Number(request.headers["content-length"]);
      const name = request.headers[runFileNameHeader];
      if (!Number.isSafeInteger(sizeBytes) || typeof name !== "string")
        throw new OpensteerError({
          code: "bad_request",
          message: "This file has no size or name.",
        });
      const peer = new AbortController();
      reply.raw.once("close", () => peer.abort());
      if (reply.raw.destroyed) peer.abort();
      await dependencies.runFiles.uploadHttp(
        id,
        token,
        {
          name: decodeURIComponent(name),
          sizeBytes,
          stream: request.body as Readable,
        },
        peer.signal,
        request.headers[runFileProofHeader],
      );
      return reply.code(204).send();
    },
  );

  app.get("/v1/runner/file-transfers/:id", { config: unversionedRoute }, async (request, reply) => {
    const token = requireBearerToken(request);
    const { id } = z.strictObject({ id: z.uuid() }).parse(request.params);
    const peer = new AbortController();
    const stopped = new Error("The download stopped.");
    const onClose = () => {
      if (!reply.raw.writableFinished) peer.abort(stopped);
    };
    reply.raw.once("close", onClose);
    if (reply.raw.destroyed) onClose();
    const file = await dependencies.runFiles.downloadHttp(
      id,
      token,
      peer.signal,
      request.headers[runFileProofHeader],
    );
    if (peer.signal.aborted) {
      file.settled(stopped);
      peer.signal.throwIfAborted();
    }
    reply.raw.once("close", () => file.settled(peer.signal.aborted ? stopped : undefined));
    return reply
      .header("cache-control", "no-store")
      .header("content-length", file.sizeBytes)
      .header(runFileNameHeader, encodeURIComponent(file.name))
      .type(runFileTransferContentType)
      .send(file.stream);
  });

  app.get(hostInternalRoutePaths.triggerRevisionScript, async (request, reply) => {
    const token = requireBearerToken(request);
    const params = z.strictObject({ revisionId: TriggerRevisionIdSchema }).parse(request.params);
    return reply
      .header("cache-control", "no-store")
      .send(await dependencies.triggers.watchScripts.get(token, params.revisionId));
  });

  app.route({
    bodyLimit: agentToolPayloadMaxSerializedBytes + 32 * 1_024,
    handler: async (request, reply) => {
      const token = requireBearerToken(request);
      // The connection routes already authenticated this credential for this route.
      const connectionOrigin =
        connectionRoutes && token.startsWith(connectionCredentialPrefix)
          ? await connectionRequestOrigin(request, connectionRoutes)
          : undefined;
      reply.hijack();
      await dependencies.agentTools.handle(
        request.raw,
        reply.raw,
        request.body,
        token,
        connectionOrigin,
      );
    },
    method: ["GET", "POST", "DELETE"],
    url: hostInternalRoutePaths.mcp,
  });

  app.get(hostInternalRoutePaths.computerPluginPackages, async (request, reply) =>
    reply
      .header("cache-control", "no-store")
      .type("application/json")
      .send(
        await dependencies.integrations.skills.stream(
          requireBearerToken(request),
          (request.params as { digest: string }).digest,
          true,
        ),
      ),
  );

  app.get(hostInternalRoutePaths.plugins, async (request, reply) => {
    const token = requireBearerToken(request, 16_000);
    return reply
      .header("cache-control", "no-store")
      .type("application/json")
      .send(
        await dependencies.integrations.skills.stream(
          token,
          (request.params as { digest: string }).digest,
        ),
      );
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
        await dependencies.store.recordRunnerUpdateRequired(identity);
      },
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
        const authenticated = await dependencies.authenticator.authenticateSessionContext(
          request.headers,
          { mutation: true },
        );
        realtimeSocketSessions.set(request.raw, authenticated);
      },
      websocket: true,
    },
    (socket, request) => {
      const authenticated = realtimeSocketSessions.get(request.raw);
      if (!authenticated) return socket.close(1008, "Authentication required");
      attachPersonalSocket({
        socket,
        logFailure: (error) =>
          request.log.warn(
            {
              code: error instanceof OpensteerError ? error.code : "internal",
              issuePaths:
                error instanceof z.ZodError
                  ? error.issues.slice(0, 12).map(({ path }) => path)
                  : undefined,
            },
            "Personal scope read failed",
          ),
        authenticated,
        realtime: dependencies.realtime,
        reads: personalReads,
        resources: personalResources,
        ...(dependencies.liveText ? { liveText: dependencies.liveText } : {}),
        refreshOwner: () => dependencies.ownerProfile?.refreshSoon(),
        probeMachines: () => dependencies.runners.probeFullDiskAccess(),
      });
    },
  );

  app.get<{
    Params: { sessionId: string };
    Querystring: {
      mode?: string;
      editing?: string;
      passkeys?: string;
      popups?: string;
      basicInput?: string;
      surfaceState?: string;
      autofill?: string;
    };
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
          popups: request.query.popups === "1",
          basicInput: request.query.basicInput === "1" ? 1 : undefined,
          surfaceState: request.query.surfaceState === "1" ? 1 : undefined,
          autofill:
            mode !== "control"
              ? undefined
              : request.query.autofill === "2"
                ? 2
                : request.query.autofill === "1"
                  ? 1
                  : undefined,
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
        admitted.popups,
        {
          basicInput: admitted.basicInput,
          surfaceState: admitted.surfaceState,
          autofill: admitted.autofill,
        },
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
  appGateway.installUpgrades(app);
  return app;
}

/** An engine on a Runner that cannot run agents is offered with the reason, never as ready. */
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
    | "assets"
    | "authenticator"
    | "personalRemoteAccess"
    | "passkeys"
    | "notificationPreviews"
    | "deviceDrivers"
  >,
): readonly HostCapability[] {
  return [
    "devices-v1",
    ...(dependencies.deviceDrivers ? ["device-drivers-v1" as const] : []),
    "automatic-models-v1",
    ...(dependencies.notificationPreviews ? ["notification-preview-v1" as const] : []),
    "voice-run-v1",
    "thread-titles-v1",
    "message-origin-v1",
    "task-marks-v1",
    "task-family-v1",
    "snapshot-messages-omit-v1",
    "history-turns-v1",
    "node-detail-v1",
    "tool-output-detail-v1",
    "place-events-v1",
    "person-show-v1",
    "quiet-tasks-v1",
    "harness-update-v1",
    "iphone-apps-v1",
    "ownerViewWindows",
    "browser-target-control-v1",
    "browser-backend-v1",
    "integration-app-finish-v1",
    "integration-app-return-port-v1",
    ...(dependencies.passkeys === true ? ["browser-passkeys-v1" as const] : []),
    "browser-frame-window-v1",
    "browser-raster-demand-v1",
    "browser-capture-region-v1",
    "browser-search-suggestions-v1",
    "tab-reopen-v1",
    "browser-profile-manage-v1",
    ...(dependencies.assets ? (["agent-images-v1"] as const) : []),
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
  popups: boolean,
  negotiation: {
    readonly basicInput: 1 | undefined;
    readonly surfaceState: 1 | undefined;
    readonly autofill: PersonFillVersion | undefined;
  },
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
      ...negotiation,
      passkeys,
      popups,
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
  })().catch((error) => closeBrowserViewerSocket(socket, error));
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
): void {
  const peer = jsonPeer(socket, `runner-peer:${randomUUID()}`);
  // A Run can stream many small events at once, for example a command's output
  // delta by delta. The Runner awaits each frame's write, so pausing the socket
  // slows it at the source; the ceiling leaves room for the rest of one read.
  const inbox = new BoundedAsyncInbox<{ readonly frame: Buffer; readonly isBinary: boolean }>({
    flow: {
      highWaterBytes: runnerControlMaxFrameBytes,
      highWaterItems: 256,
      pause: () => socket.pause(),
      resume: () => socket.resume(),
    },
    maxBytes: 4 * runnerControlMaxFrameBytes,
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
      if (buffer.byteLength > runnerControlMaxFrameBytes) {
        throw badMessage("Runner message is too large");
      }
      inbox.push({ bytes: buffer.byteLength, value: { frame: buffer, isBinary } });
    } catch (error) {
      inbox.close(error);
      if (socket.readyState === socket.OPEN) socket.close(1009, "runner input queue exceeded");
    }
  });
  const disconnected = (restarting = false) => {
    releaseChallenge();
    clearTimeout(challengeTimeout);
    inbox.close();
    runners.disconnect(peer, restarting);
  };
  socket.once("close", (code) => disconnected(code === runnerRestartingCloseCode));
  socket.once("error", () => disconnected());
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
  // Receipts have their own lane because a Run transaction can await one.
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
          const reason = error instanceof OpensteerError ? error.reason : undefined;
          if (
            message.type === "runner.authenticate" &&
            (reason === "agent-phone-outdated" ||
              reason === "runner-outdated" ||
              reason === "iphone-app-outdated" ||
              reason === "run-events-version-mismatch")
          ) {
            const identity = await authenticator
              .authenticateUpdateRefusal(challenge, message)
              .catch(() => null);
            if (identity)
              await recordUpdateRequired({
                ...identity,
                reason: reason === "agent-phone-outdated" ? reason : "runner-outdated",
              });
            log.warn(
              {
                reason,
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
          .authenticate(challenge, message)
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
    case "runner.session-bound":
      return `run:${message.runId}`;
    case "runner.output-image.publish":
      return "output-images";
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
  const disconnected = (restarting = false) => {
    outcome(false, "disconnected-before-authentication");
    release();
    clearTimeout(challengeTimeout);
    inbox.close();
    if (!stream) return;
    const reason = restarting ? "device-restarting" : "transport-disconnected";
    options.runners.detachAuxiliary(peer, reason);
    dispatch.onDetach(reason);
  };
  socket.once("close", (code) => disconnected(code === runnerRestartingCloseCode));
  socket.once("error", () => disconnected());
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

/** The personal version gate has already admitted every `/v1/` caller this serves. */
function jsonPeer(socket: WebSocket, id: string): RunnerPeer {
  const prepareSend = (message: HostToRunnerMessage) => {
    const frame = JSON.stringify(message);
    const bytes = Buffer.byteLength(frame, "utf8");
    return () =>
      new Promise<void>((resolve, reject) => {
        if (socket.readyState !== socket.OPEN) return reject(new Error("WebSocket is closed"));
        if (socket.bufferedAmount + bytes > maxWebSocketBufferedBytes) {
          socket.close(4009, "slow consumer");
          return reject(new Error("WebSocket slow consumer"));
        }
        socket.send(frame, (error) => (error ? reject(error) : resolve()));
      });
  };
  return {
    close: (code, reason) => socket.close(code, reason.slice(0, 123)),
    id,
    prepareSend,
    send: (message) => prepareSend(message)(),
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

function closeBrowserViewerSocket(socket: WebSocket, error: unknown): void {
  if (socket.readyState !== socket.OPEN) return;
  const message = error instanceof Error ? error.message : "Protocol error";
  // A viewer that arrived while the browser computer was restarting or the
  // Host was temporarily unavailable did nothing wrong: ask it to try again
  // rather than ending the watch permanently with a protocol violation.
  const code =
    error instanceof OpensteerError &&
    (error.retryable === true || error.code === "runner_offline" || error.code === "timeout")
      ? browserViewerCloseCodes.tryAgain
      : browserViewerCloseCodes.protocolViolation;
  socket.close(code, message.slice(0, 123));
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

function requireBearerToken(request: FastifyRequest, maximumTokenLength = 4_096): string {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ") || value.length > maximumTokenLength + 7) {
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

function personalResponseScopes(input: unknown, sessionId: string | undefined): string[] {
  const scopes = sessionId ? ["shell", `session:${sessionId}`] : ["shell"];
  if (!input || typeof input !== "object") return scopes;
  if ("threadId" in input && typeof input.threadId === "string")
    scopes.push(`thread:${input.threadId}`);
  if ("selectedThreadId" in input && typeof input.selectedThreadId === "string")
    scopes.push(`thread:${input.selectedThreadId}`);
  if ("nodeId" in input && typeof input.nodeId === "string") scopes.push(`node:${input.nodeId}`);
  return scopes;
}
