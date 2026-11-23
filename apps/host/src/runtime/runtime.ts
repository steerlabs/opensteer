import { SessionPersonTools } from "../mcp/handlers/session-person.js";
import {
  attemptStopStateCapability,
  CorrelationIdSchema,
  triggerStopGenerationCapability,
} from "@opensteer/protocol";
import {
  closeLegacyCdpForConnection,
  drainLegacyRunCdp,
  withLegacyRunCdpDrain,
} from "../browser/trigger-cdp-bridge.js";
import { ChromeSharedTabs } from "../browser/chrome-shared-tabs.js";
import { ResourceRevisions } from "./personal-resource-revisions.js";
import { PersonalLiveText } from "./personal-live-text.js";
import {
  commitPersonalMutation,
  installPersonalMutationHooks,
  type PersonalCommitReaction,
} from "@opensteer/database/personal-mutation";
import {
  createRunFinishDrain,
  recoverCommandAttempts,
  republishThreads,
} from "@opensteer/database";
import { shadowRunsTouched } from "../browser/shadow-host.js";
import { createReturnHintRefresh } from "./personal-return-hints.js";
import { withUpgradeHeartbeat } from "./upgrade-heartbeat.js";
import { RequestDeadlines, settleEach } from "../agents/request-deadlines.js";
import { harnessUsageLimitFailureCode, isLoopbackHostname } from "@opensteer/core";
import { pluginCategoryResources, type PersonalResourceKind } from "@opensteer/protocol/resources";
import type { PluginChange } from "@opensteer/protocol";
import { resolvePublicAddress } from "@opensteer/access";
import { PluginPages } from "../plugins/plugin-pages.js";
import { PluginOAuthService } from "../plugins/plugin-oauth-service.js";
import { PluginOAuthStore } from "../plugins/plugin-oauth-store.js";
import { PluginAuthority } from "../plugins/plugin-authority.js";
import { PluginExecutions } from "../plugins/plugin-executions.js";
import { PluginAgentStore, requirePersonalOwner } from "@opensteer/database";
import { PluginToolHandlers } from "../mcp/handlers/plugins.js";
import { LocalProviders } from "../plugins/local-providers.js";
import { LocalServerRegistry } from "../local-servers/local-server-registry.js";
import { pluginSourceFiles, exportPluginSource } from "../plugins/plugin-source.js";
import { PluginService, PluginServiceError } from "../plugins/plugin-service.js";
import { hasUnfinishedPluginWorkflows } from "../plugins/engine-storage.js";
import { PluginStopCoordinator } from "../plugins/plugin-stop-coordinator.js";
import { PluginOwnerApi, pluginEngineStateView } from "../plugins/plugin-owner-api.js";
import { changeDeviceDrivers } from "../administration/device-removal.js";
import { DeviceDriverResolver } from "../computer-use/device-drivers.js";
import { DeviceIdSchema, type DeviceId } from "@opensteer/core";
import { TabStore, AgentToolActivityStore } from "@opensteer/database";
import { TabService } from "../tabs/tab-service.js";
import { NativeTabTargets } from "../computer-use/native-tab-targets.js";
import {
  tabComputer,
  tabComputers,
  authorizeTabTarget,
  authorizeTabActor,
  deniedTabRows,
  readableTabTasks,
  tabReadAuthority,
  canReadTab,
} from "../tabs/tab-authority.js";
import { TabToolHandlers } from "../mcp/handlers/tabs.js";
import { BrowserScriptConfinement, BrowserToolHandlers } from "../mcp/handlers/browser.js";
import { BrowserScriptService } from "../browser-use/browser-script-service.js";
import { AgentSessionService } from "../agent-sessions/agent-session-service.js";
import { createAgentReviewer } from "../agent-sessions/agent-reviewer.js";
import { createTranscriptFileServices } from "../threads/transcript-files.js";
import { TranscriptFileAccess } from "../threads/transcript-file-access.js";
import {
  admitTranscriptFiles,
  resolveThreadOutputImages,
  readThreadOutputImage,
} from "@opensteer/database";
import { AuthSessionIdSchema } from "@opensteer/core";
import { IdleCompactionService } from "../agents/idle-compaction-service.js";
import { admitIdleCompaction, idleCompactionCandidates } from "@opensteer/database/idle-compaction";
import { DeviceAccessService } from "../administration/device-access-service.js";
import { requireDeviceAccess, requireRunnerDeviceAccess } from "../administration/device-access.js";
import { digestSecret } from "@opensteer/shared/secretDigest";
import { DeadlineDrain } from "./deadline-drain.js";
import { assignmentReturnPass } from "./assignment-return-pass.js";
import { executionLeaseDrain } from "./execution-leases.js";
import { initializePersonalState } from "./personal-state.js";
import { OwnerProfileService } from "../administration/owner-profile.js";
import { AgentHomeFiles } from "../threads/agent-home-files.js";
import { HostOutputImageStore } from "../threads/host-output-images.js";
import {
  findPersonalSettings,
  personalSettings,
  reportAgentHomeSettings,
  reportAgentHomeSkills,
  ensureDeployment,
} from "@opensteer/database";
import { hostExposurePolicy, localMachineOwnerEmail } from "@opensteer/core";
import { RequestHold } from "../mcp/request-hold.js";
import { ThreadNaming } from "../agents/thread-naming.js";
import { QuietTasks } from "../threads/quiet-tasks.js";
import { AdministrationService } from "../administration/administration-service.js";
import { AdministrationToolHandlers } from "../mcp/handlers/administration.js";
import { HarnessCatalogReconciliationOwner } from "../agents/harness-catalogs.js";
import { ThreadService } from "../threads/thread-service.js";
import { ConnectionOAuth, connectionCommandEffects } from "../mcp/connections/index.js";
import { AgentDirectoryCache } from "../mcp/connections/agent-directory.js";
import { AgentConnectionStore, recoverAssignmentResultWaits } from "@opensteer/database";
import { createHmac } from "node:crypto";
import { personalHomeKind, personalHomeKindOption } from "./home-kind.js";
import { withFolderPluginPackage } from "../local-servers/folder-plugin-package.js";
import { AppTunnelHub } from "../apps/app-tunnel-hub.js";
import { AesGcmSecretVault, StaticEncryptionKeyProvider } from "@opensteer/access/host";
import {
  assertHostConfigInvariants,
  HostConfigurationIssue,
  hostTrustedProxy,
  type HostConfig,
} from "@opensteer/config";
import { createPluginChangeNotices, type PluginChangeNotices } from "./plugin-change-notices.js";
import { TaskQuestionNotices } from "../threads/task-question-notices.js";

import {
  harnessDriverLabel,
  HarnessIdSchema,
  HarnessInstanceIdSchema,
  OpensteerError,
  sameStringSet,
  type AssignmentId,
  type Deployment,
  type EnvironmentId,
  type RunId,
  type RunnerId,
  type UserId,
} from "@opensteer/core";
import {
  acquireDeploymentAuthorityLease,
  AttachmentStore,
  AutomationFailureStore,
  BrowserSourceStore,
  sharedChromeAttempts,
  ChannelStore,
  createDatabase,
  databaseShutdownDetails,
  IntegrationAuthAttemptStore,
  IntegrationPlatformStore,
  listIntegrationConnections,
  PluginSettingsStore,
  isTransactionConflict,
  migrateToLatest,
  NotificationPreviewKeyStore,
  NotificationStore,
  OpensteerStore,
  personalRemoteAccessRefusedReason,
  personalRemoteAccessRequiredRefusal,
  runnerAdvertisesItsEnvironmentBinding,
  TriggerStore,
  type DeploymentAuthorityLease,
} from "@opensteer/database";
import { hostKeyFingerprint as fingerprintForSpki } from "@opensteer/deployment-authority";
import { IdentityService } from "@opensteer/identity";
import { hostedOAuthDeploymentAuthorityDigest } from "@opensteer/control-plane-protocol/broker-sealing";
import { officialOpensteerAccountProviderId } from "@opensteer/control-plane-protocol";
import { computerAppIntegrations, deviceDefinitions } from "@opensteer/integration-catalog/devices";
import { type ComputerAppPlatform } from "@opensteer/integration-core/computer-app";
import {
  CommandService,
  ExecutionCoordinator,
  KeyedAdmissionQueue,
  RealtimeHub,
  RunnerRegistry,
  type RunnerIdentity,
  type RunnerStreamLossReason,
} from "@opensteer/orchestration";
import {
  agentHomeFilesCapability,
  personalWebBuildId,
  type HarnessInstanceCatalog,
  type RunnerAuxiliaryModule,
  type ShellSessionId,
} from "@opensteer/protocol";
import type { FastifyInstance } from "fastify";
import { sign, verify } from "node:crypto";
import { resolve } from "node:path";

import { HostAuthorityPublisher } from "../access/host-authority-publisher.js";
import { HostedOAuthBrokerClient } from "../access/hosted-oauth-broker-client.js";
import { RemotePersonalAccountGrantVerifier } from "../access/personal-account-grant-verifier.js";
import { ManagedHomeClaimService } from "../identity/managed-home-claim.js";
import { PersonalRemoteAccessService } from "../access/personal-remote-access-service.js";
import type { AgentPhoneUpdateRelease } from "../agent-phone/update-release.js";
import { RunToolTokenService } from "../agents/run-tool-tokens.js";
import { OpensteerMcpService } from "../mcp/opensteer-mcp-service.js";
import { AgentCallerResolver } from "../mcp/agent-caller.js";
import { ProductToolHandlers } from "../mcp/handlers/product.js";
import { TriggerToolHandlers } from "../mcp/handlers/triggers.js";
import { agentToolHandlers } from "../mcp/handlers/index.js";
import { ContinuationService } from "../agents/continuation-service.js";
import { HostCommandDispatcher } from "../agents/dispatcher.js";
import {
  harnessInspectionDefinition,
  recaptureInvalidatedHarnessCatalog,
  createHarnessCatalogConvergence,
  inspectHarnessCatalogsAfterUsageLimit,
  reconcileAndRecordHarnessCatalogs,
} from "../agents/harness-catalogs.js";
import {
  runCapabilityLifetimeSeconds,
  RunCapabilityTokenService,
} from "../agents/run-capability.js";
import { RunnerAuthenticator } from "../agents/runner-authenticator.js";
import {
  AttachmentService,
  RunAttachmentsTokenService,
} from "../attachments/attachment-service.js";
import { RunFileRelay } from "../agents/run-file-relay.js";
import { AppStore } from "@opensteer/database";
import { AppService } from "../apps/app-service.js";
import { BrowserLocalProfiles } from "../browser/browser-local-profiles.js";
import { announceBrowserUsage } from "../browser/browser-presence.js";
import { BrowserService } from "../browser/browser-service.js";
import { BrowserSourceService } from "../browser/browser-source-service.js";
import { BrowserAttachTicketSigner } from "../browser/browser-ticket.js";
import { PasswordSignInService } from "../browser/password-sign-in-service.js";
import { passwordsLoginSavedMessage } from "../browser/passwords-offers.js";
import { SavedLoginService } from "../browser/saved-logins.js";
import { RunnerBrowserHub } from "../browser/runner-browser-hub.js";
import { RunnerBrowserRuntimeRouter } from "../browser/runner-browser-runtime.js";
import { ChannelService } from "../channels/channel-service.js";
import { MessagingRelayHub } from "../channels/messaging-relay-hub.js";
import { ComputerAppHub } from "../computer-apps/computer-app-hub.js";
import { ComputerUseService } from "../computer-use/computer-use-service.js";
import { ComputerViewService } from "../computer-use/computer-view-service.js";
import { DisplayStreamHub } from "../computer-use/display-stream-hub.js";
import { PlaceContextService } from "../computer-use/place-context-service.js";
import { HostAuthenticator } from "../identity/auth.js";
import { CredentialService, loadOrCreateCredentialKey } from "../identity/credential-service.js";
import { HarnessAuthenticationCoordinator } from "../identity/harness-authentication-coordinator.js";
import { loadOrCreateHostInstance } from "../identity/host-instance.js";
import {
  loadOrCreateHostKeys,
  SignedTokenService,
  signHostDiscovery,
} from "../identity/host-keys.js";
import { DefaultIntegrationAuthAttemptLifecycle } from "../access/integration-auth-attempt-service.js";
import { AccessRequests } from "../devices/access-requests.js";
import { DeviceService, endSessionComputerWork } from "../devices/device-service.js";
import { LocalServerService } from "../local-servers/local-server-service.js";
import {
  packageStillGranted,
  PluginPackageService,
} from "../local-servers/plugin-package-service.js";
import { DeviceToolHandlers } from "../mcp/handlers/devices.js";
import { NotificationDispatcher } from "../notifications/notification-dispatcher.js";
import { NotificationPreviewService } from "../notifications/notification-preview-service.js";
import {
  NotificationPublicationClient,
  type NotificationPublicationTarget,
} from "../notifications/notification-publication-client.js";
import { createHostServer } from "../server.js";
import { CommandRequestService } from "../commands/requests.js";
import { agentCommandRegistry } from "../commands/agent-door.js";
import { CommandTools } from "../mcp/handlers/commands.js";
import { CommandRequestStore } from "@opensteer/database";
import { EgressService } from "../server/egress-service.js";
import { HostStaticDistribution } from "../server/static-distribution.js";
import { machineAccessNotifier, notifyComputerPresence } from "../shell/machine-access-events.js";
import { MachineFullDiskAccessService } from "../shell/machine-full-disk-access-service.js";
import { ShellHub } from "../shell/shell-hub.js";
import { AutomationFailureService } from "../triggers/automation-failure-service.js";
import { FiringInterruptLoop } from "../triggers/firing-interrupt-loop.js";
import { TriggerControlTokenService } from "../triggers/trigger-control-service.js";
import { MemoryPassService } from "../agents/memory-pass-service.js";
import { TriggerScheduleLoop, TriggerService } from "../triggers/trigger-service.js";
import {
  WatchCapabilityTokenService,
  WatchControlTokenService,
} from "../triggers/watch-capability.js";
import { AutomationSecrets } from "../triggers/automation-secrets.js";
import { WatchScriptService } from "../triggers/watch-script-service.js";
import { WatchService } from "../triggers/watch-service.js";
import { withDevelopmentDatabaseReset } from "./development-database.js";
import { LocalBootstrapService } from "./local-bootstrap.js";

// Refreshed on every start while the Host is unclaimed, so the window only ever
// matters to a Host that has been left running and untouched for a year.
const localSetupEnrollmentLifetimeMilliseconds = 365 * 24 * 60 * 60 * 1_000;

// A steering answer that arrives late is worthless: the message simply becomes
// the next ordered turn instead.

// A Runner that just connected is the one moment this Host knows it can ask
// what its AI engines offer. Nothing waits on the answer, so the deadline only
// has to outlast a Runner that is still warming up.
const harnessCatalogCaptureTimeoutMs = 30_000;

/**
 * Registration work first, scheduling second.
 *
 * Reconciliation is what makes a Runner's profile set true, and dispatch
 * inspects profiles live before it starts a run. Waking the coordinator first
 * let those two race: a run could be admitted against a profile set the Runner
 * had not been given yet, and the reconciliation that followed could close the
 * adapter underneath it. Waking after costs a moment of scheduling latency on
 * connect and buys a defined order.
 */
/**
 * Whether this connection may become a registered computer.
 *
 * Two things can have moved since the admission transaction committed, because
 * registration is a separate step and both are written by somebody else:
 *
 * The durable identity — revoked, regenerated, regranted — which is why the row
 * is read again rather than trusted from the proof.
 *
 * And, on a Personal Deployment, the route the computer arrived over. Turning
 * remote access off bumps the generation and then drops every connected
 * computer; a connection admitted just before that bump is not yet in the
 * registry, so the sweep cannot see it. Comparing the generation it was
 * admitted under against the generation now closes exactly that window: the
 * same number means the sweep has not happened, a different one means this
 * connection missed it and must not survive it. The hosting Runner carries null
 * and is not fenced, matching the admission rule.
 */
export async function authorizeRunnerRegistration(
  store: Pick<OpensteerStore, "personalRemoteAccessGeneration" | "runnerForAuthentication">,
  identity: Pick<
    RunnerIdentity,
    | "allowedModules"
    | "connectionGeneration"
    | "environmentIds"
    | "personalRemoteAccessGeneration"
    | "runnerId"
    | "runnerKind"
  >,
): Promise<void> {
  const durable = await store.runnerForAuthentication(identity.runnerId);
  if (
    !durable ||
    durable.revokedAt ||
    durable.connectionGeneration !== identity.connectionGeneration ||
    durable.runnerKind !== identity.runnerKind ||
    // The binding is immutable, the advertisement is not: a computer running
    // reach-only names no environment and is still bound to the one it has.
    !runnerAdvertisesItsEnvironmentBinding(durable.environmentIds, identity.environmentIds) ||
    !sameStringSet(durable.allowedModules, identity.allowedModules)
  ) {
    throw new Error("Runner connection is no longer authorized");
  }
  if (identity.personalRemoteAccessGeneration === null) return;
  if ((await store.personalRemoteAccessGeneration()) !== identity.personalRemoteAccessGeneration) {
    throw new OpensteerError({
      code: "forbidden",
      message: personalRemoteAccessRequiredRefusal,
      reason: personalRemoteAccessRefusedReason,
    });
  }
}

/**
 * The second half of the remote-access fence, asked once the connection is in
 * the registry.
 *
 * `authorizeRunnerRegistration` reads the route generation before the registry
 * has inserted anything, which leaves its own window: remote access can change
 * between that read and the insertion, and the sweep that follows the change
 * finds nothing to sweep because this connection is not there yet. Reading the
 * generation a second time from the far side of the insertion closes it, and
 * the two reads together leave no interval at all — a change that commits
 * before this read is seen by this read, and one that commits after it finds
 * this connection already in the registry the sweep walks.
 *
 * Returns whether the connection survived, so a caller can stop rather than go
 * on reconciling a machine it has just sent away.
 */
export async function confirmRunnerRegistration(
  store: Pick<OpensteerStore, "personalRemoteAccessGeneration">,
  runners: Pick<RunnerRegistry, "disconnectConnection">,
  identity: Pick<RunnerIdentity, "connectionId" | "personalRemoteAccessGeneration" | "runnerId">,
): Promise<boolean> {
  if (identity.personalRemoteAccessGeneration === null) return true;
  const current = await store.personalRemoteAccessGeneration();
  if (current === identity.personalRemoteAccessGeneration) return true;
  // The same "going away" code the sweep uses: this computer is not in trouble,
  // its Deployment simply has no route for it right now.
  await runners.disconnectConnection(identity, {
    code: 1001,
    reason: personalRemoteAccessRequiredRefusal,
  });
  return false;
}

export function runnerAttachedReaction(
  wake: () => void,
  reconcile: () => Promise<void>,
): () => Promise<void> {
  return async () => {
    wake();
    await reconcile();
  };
}

export function runnerRegistrationHook<T>(
  wake: (identity: T) => void,
  afterRegistration: (identity: T) => Promise<void>,
): (identity: T) => Promise<void> {
  return async (identity) => {
    try {
      await afterRegistration(identity);
    } finally {
      // A Runner that failed its catalog capture is still reachable, so
      // scheduling must resume either way; the capture itself stays best
      // effort and the convergence pass retries it.
      wake(identity);
    }
  };
}

export interface PersonalHostRuntime {
  readonly kind: "personal";
  /** Device data apps on computers, with their approvals. */
  readonly devices: DeviceService;
  /** The local servers registered on computers, by name. */
  readonly localServers: LocalServerRegistry;
  readonly plugins: PluginService;
  readonly pluginOAuth: PluginOAuthService;
  readonly pluginAgentSettings: PluginAgentStore;
  readonly pluginRequests: PluginExecutions;
  readonly pluginTools: PluginToolHandlers;
  readonly app: FastifyInstance;
  readonly browser: BrowserService;
  readonly computerApps: ComputerAppHub;
  readonly computerUse: ComputerUseService;
  readonly computerViews: ComputerViewService;
  readonly displayStreams: DisplayStreamHub;
  readonly tabs: TabService;
  readonly notifications: Pick<NotificationDispatcher, "drain">;
  readonly deployment: Deployment;
  readonly store: OpensteerStore;
  /** Settles if this Host loses its Deployment database lock; it must then stop. */
  readonly authorityLost: Promise<Error>;
  /** Observes the current execution lease pass without starting or draining work. */
  settleExecutionLeases(): Promise<number>;
  close(): Promise<void>;
  /** The shutdown step `close()` is waiting on, until it finishes. */
  closingStep(): string | undefined;
  listen(): Promise<string>;
}

export type HostRuntime = PersonalHostRuntime;
export interface HostRuntimeOptions {
  readonly onPersonalUpgradeHeartbeat?: () => void;
  readonly onPersonalUpgradeBatch?: NonNullable<
    Parameters<typeof migrateToLatest>[2]
  >["afterBatch"];
  /** Where the plugin engine fetches packages and its catalog; tests point it at a fixture. */
  readonly pluginEngine?: Pick<
    import("../plugins/plugin-service.js").PluginServiceOptions,
    "npmRegistry" | "catalogUrl" | "selfOrigin" | "limits" | "processEntry" | "bridge"
  >;
  /** Override the REPL worker entry; test Hosts run the built JS worker instead of source under tsx. */
  readonly replWorkerEntry?: URL;
  readonly onPersonalScopeCut?: (
    scope: import("@opensteer/protocol/personal-sync").PersonalScope,
  ) => Promise<void>;
  readonly onPersonalReaction?: (reaction: PersonalCommitReaction) => void;
  readonly executionClock?: import("@opensteer/shared/clock").Clock;
  /** Controls notification grace/backoff independently of Account transport. */
  readonly notificationTiming?: Pick<
    import("../notifications/notification-dispatcher.js").NotificationDispatcherOptions,
    "now" | "wait"
  >;
  /** Domain activity expiry and native coalescing; transport and browser deadlines stay on real time. */
  readonly browserActivityClock?: import("@opensteer/shared/clock").Clock;
  /** When periodic Personal reconciliation passes run; each pass's own work stays real. */
  /** Observes a committed catalog capture; observer failures never affect Host work. */
  readonly onRunnerCatalogsCommitted?: (
    identity: RunnerIdentity,
    environmentId: EnvironmentId,
    catalogs: readonly HarnessInstanceCatalog[],
    registrationMayResetCatalogs: boolean,
  ) => void;
  readonly phoneUpdateRelease?: () => AgentPhoneUpdateRelease | null;
  readonly accountControlFetch?: typeof globalThis.fetch;
  readonly accountDirectoryFetch?: typeof globalThis.fetch;
  /**
   * Where integrations reach providers and proposal sources; public HTTPS
   * only by default. A journey points it at an upstream of its own.
   */
  readonly integrationFetch?: typeof globalThis.fetch;
  readonly logger?: boolean | Record<string, unknown>;
  readonly personalAccountGrantFetch?: typeof globalThis.fetch;
  /** Explicit mount-facing endpoint, primarily for split-ingress deployments and tests. */
  /** How long Run capability tokens live; journeys shorten it to exercise refresh. */
  readonly runCapabilityLifetimeSeconds?: number;
  /** Issue and verify Run capabilities in domain time; transport/session tokens stay real. */
  readonly runCapabilityNow?: () => number;
}
export async function createHostRuntime(
  config: HostConfig,
  options: HostRuntimeOptions = {},
): Promise<HostRuntime> {
  const executionNow = options.executionClock?.now ?? (() => Date.now());
  assertHostConfigInvariants(config);
  const dataDirectory = resolve(config.dataDirectory);
  const keys = await loadOrCreateHostKeys({
    dataDirectory,
    ...(config.privateKeyPath ? { privateKeyPath: config.privateKeyPath } : {}),
    ...(config.publicKeyPath ? { publicKeyPath: config.publicKeyPath } : {}),
  });
  const hostKeyFingerprint = fingerprintForSpki(
    keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
  );
  if (
    config.deploymentIdentity?.hostKeyFingerprint !== undefined &&
    config.deploymentIdentity.hostKeyFingerprint !== hostKeyFingerprint
  ) {
    throw new Error("The Account adoption bundle does not match this Host signing key");
  }
  // HostInstanceId belongs to this installation, not to the portable database.
  // Materialize it before any database work so startup never creates a
  // Deployment row without first having a durable local identity.
  const hostInstance = await loadOrCreateHostInstance(
    dataDirectory,
    config.deploymentIdentity?.hostInstanceId,
  );
  const database = createDatabase({
    applicationName: "opensteer-host",
    connectionString: config.databaseUrl,
    // The authority lock occupies one pool slot.
    minConnections: 2,
    idleTimeoutMs: 5 * 60_000,
  });
  let administrationCatalogs: HarnessCatalogReconciliationOwner | undefined;
  let authorityLease: DeploymentAuthorityLease | undefined;
  let notificationDispatcher: NotificationDispatcher | undefined;
  let removeMutationHooks: (() => void) | undefined;
  let deadlines: RequestDeadlines | undefined;
  // The agents' tools are built before the Home's command Requests; they read it when called.
  let commandRequestsForTools: CommandRequestService | undefined;
  // The person's read handlers, handed over when the server builds them; read by the state tool.
  let personReadHandlers: Readonly<Record<string, unknown>> | undefined;
  let executionLeaseLoop: DeadlineDrain | undefined;
  let finishLoop: DeadlineDrain | undefined;
  let connectionMaintenance: DeadlineDrain | undefined;
  let assignmentReturns: DeadlineDrain | undefined;
  let reconcileMemoryPasses: (() => void) | undefined;
  let wakeTriggerSchedules: (() => void) | undefined;
  let catalogConvergence: ReturnType<typeof createHarnessCatalogConvergence> | undefined;
  let taskQuestions: TaskQuestionNotices | undefined;
  let pluginService: PluginService | undefined;
  let pluginOAuth: PluginOAuthService | undefined;
  let pluginExecutions: PluginExecutions | undefined;
  let localProviders: LocalProviders | undefined;
  let pluginChangeNotices: PluginChangeNotices | undefined;
  try {
    // One Host process owns a Home's database.
    authorityLease = await acquireDeploymentAuthorityLease(database);
    // Conversion must finish before startup reads or creates a Deployment.
    await withUpgradeHeartbeat(
      () => migrateToLatest(database, undefined, { afterBatch: options.onPersonalUpgradeBatch }),
      options.onPersonalUpgradeHeartbeat,
    ).catch((error: unknown) => {
      throw config.mode === "development" ? withDevelopmentDatabaseReset(error) : error;
    });
    const deployment = await ensureDeployment(database, {
      ...(config.deploymentIdentity
        ? { deploymentId: config.deploymentIdentity.deploymentId }
        : {}),
      canonicalOrigin: config.canonicalOrigin.origin,
      hostInstanceId: hostInstance.hostInstanceId,
      deploymentShape: config.deploymentShape,
    });
    const personalConfig = config.personal!;
    let initializedPersonal: Awaited<ReturnType<typeof initializePersonalState>> = null;
    let initializingPersonal:
      Promise<Awaited<ReturnType<typeof initializePersonalState>>> | undefined;
    let reportedAgentHome:
      | {
          readonly computerId: RunnerId;
          readonly path: string;
          readonly signal: AbortSignal;
        }
      | undefined;
    const initializePersonal = async () => {
      if (initializedPersonal) return initializedPersonal;
      initializingPersonal ??= initializePersonalState(database, {
        ...personalConfig,
        ...(reportedAgentHome && !reportedAgentHome.signal.aborted
          ? { reportedAgentHome, signal: reportedAgentHome.signal }
          : {}),
      })
        .then(async (execution) => {
          // The owner's first name is in place before anyone reads it.
          if (execution) await ownerProfile.seed(config.ownerNameSeed ?? null);
          return (initializedPersonal = execution);
        })
        .finally(() => {
          initializingPersonal = undefined;
        });
      return initializingPersonal;
    };
    const personalExecution = async () => {
      const execution = await initializePersonal();
      if (!execution)
        throw new OpensteerError({
          code: "folder_unavailable",
          message: "The personal owner and hosting computer are still starting",
        });
      return execution;
    };
    const execution = {
      canExecute: (environmentId: EnvironmentId) => environmentId === personalConfig.environmentId,
      initialized: () => initializedPersonal !== null,
      environmentFor: async (ownerId: UserId) =>
        (await personalExecution()).environmentFor(ownerId),
    };
    // Only the Host knows the origin its own web app answers on, so it is the
    // Host that teaches the store how to name a Thread in a channel message.
    let tabs: TabService | undefined;
    let apps: AppService | undefined;
    const tabStore = new TabStore(database);
    const toolActivity = new AgentToolActivityStore(database);
    const store = new OpensteerStore(database, {
      ...(options.executionClock ? { executionClock: options.executionClock } : {}),
      links: { threadUrl: (threadId) => `${config.canonicalOrigin.origin}/tasks/${threadId}` },
    });
    const realtime = new RealtimeHub();
    const resourceRevisions = new ResourceRevisions((kinds) => {
      realtime.resourcesChanged(kinds);
    });
    const readLiveTail = (threadId: import("@opensteer/core").ThreadId) =>
      void database
        .selectFrom("threads")
        .select("nextTranscriptPosition")
        .where("id", "=", threadId)
        .executeTakeFirst()
        .then((row) => row && liveText.observeTail(threadId, row.nextTranscriptPosition))
        .catch(reportMutationFailure);
    const liveText = new PersonalLiveText(
      realtime,
      (runId) => runnerRegistry?.requestLiveProgress(runId),
      readLiveTail,
    );
    const trackLiveRun = async (runId: RunId, bindingGeneration: number) => {
      if (liveText.knows(runId, bindingGeneration)) return;
      const current = await database
        .selectFrom("runAttempts")
        .innerJoin("runs", "runs.id", "runAttempts.runId")
        .select(["runAttempts.id as attemptId", "runs.threadId"])
        .where("runAttempts.runId", "=", runId)
        .where("runAttempts.bindingGeneration", "=", bindingGeneration)
        .where("runAttempts.status", "=", "current")
        .where("runs.finishIntent", "is", null)
        .limit(1)
        .executeTakeFirst();
      if (!current) return;
      liveText.track(runId, { ...current, bindingGeneration });
      readLiveTail(current.threadId);
      const nodes = await database
        .selectFrom("executionNodes")
        .select(["id as nodeId", "parentNodeId"])
        .where("runId", "=", runId)
        .where("attemptId", "=", current.attemptId)
        .where("status", "=", "running")
        .orderBy("id")
        .limit(256)
        .execute();
      for (const node of nodes)
        liveText.placeNode(
          {
            ...node,
            type: "nodeProgressPlacement",
            runId,
            attemptId: current.attemptId,
            active: true,
          },
          syncHead,
        );
    };
    const links = {
      threadUrl: (threadId: import("@opensteer/core").ThreadId) =>
        `${config.canonicalOrigin.origin}/tasks/${threadId}`,
    };
    let react = (_reaction: PersonalCommitReaction): void => undefined;
    let browserTabsChanged = (_tabIds: ReadonlySet<string>): void => undefined;
    let wakeExecutionCoordinator = (): void => undefined;
    let wakeEnvironmentDispatch = (_environmentId: EnvironmentId): void => undefined;
    let syncHead = "0";
    const reportMutationFailure = (error: unknown) =>
      console.warn("Personal mutation follow-up failed", {
        code: error instanceof OpensteerError ? error.code : "internal",
      });
    const refreshReturnHints = createReturnHintRefresh({
      watched: () => realtime.watchedScopes(),
      republish: (scopes) => republishThreads(database, scopes),
      onError: reportMutationFailure,
    });
    removeMutationHooks = installPersonalMutationHooks(database, {
      wake: (notice) => {
        if (BigInt(notice.head) > BigInt(syncHead)) syncHead = notice.head;
        realtime.wake(notice.head, notice.changedScopes);
        refreshReturnHints(notice.resourceKinds);
        // A durable card can pass an on-screen provisional one: move that card to the new tail.
        for (const threadId of liveText.provisionalThreads())
          if (notice.changedScopes.has(`thread:${threadId}`)) readLiveTail(threadId);
        resourceRevisions.committed(notice.resourceKinds, notice.head);
        browserTabsChanged(notice.changedTabs);
      },
      suspend: (scopes) => realtime.suspendAuthority(scopes),
      react: (reaction) => {
        react(reaction);
        options.onPersonalReaction?.(reaction);
      },
      onFailure: (error, operation) => {
        if (operation === "wake" || operation === "authority")
          realtime.closeAll("Personal state delivery failed");
        reportMutationFailure(error);
      },
    });
    const seeded = await database
      .selectFrom("clientSyncState")
      .select("resourceRevisions")
      .where("deploymentId", "=", deployment.id)
      .executeTakeFirst();
    if (seeded) resourceRevisions.seed(seeded.resourceRevisions);
    const announceResources = (...kinds: PersonalResourceKind[]) =>
      resourceRevisions.bump(...kinds);
    await recoverAssignmentResultWaits(database);
    const harnessCatalogs = {
      recordHarnessCatalogs: (...args: Parameters<typeof store.recordHarnessCatalogs>) =>
        store.recordHarnessCatalogs(...args),
      listHarnessInstances: store.listHarnessInstances.bind(store),
      listHarnessCatalogs: store.listHarnessCatalogs.bind(store),
    };
    const pluginSettings = new PluginSettingsStore(database);
    const pluginsChanged = (_owner?: UserId, change?: PluginChange) =>
      announceResources(
        ...(change?.categories?.map((category) => pluginCategoryResources[category]) ?? ["plugin"]),
      );
    const notices = createPluginChangeNotices(
      (target) => pluginSettings.affectedViewers(target),
      () => pluginsChanged(),
    );
    pluginChangeNotices = notices;
    const connectionStore = new AgentConnectionStore(database);
    const directory = agentDirectoryFor(
      config.personalAccountIssuer ?? config.managedHome?.accountOrigin,
      connectionStore,
    );
    const connections = new ConnectionOAuth({
      deploymentId: deployment.id,
      store: connectionStore,
      signingKey: keys.privateKey,
      verificationKey: keys.publicKey,
      onMaintenanceChanged: () => connectionMaintenance?.wake(),
      ...(directory ? { directory } : {}),
    });
    const triggerStore = new TriggerStore(database);
    const exposurePolicy = hostExposurePolicy(config.exposure);
    // The desktop's own claim on a loopback Host; an operator's setup link on a networked Home.
    const localSetupToken = config.identity.localOwnerClaimToken;
    const operatorSetup = config.identity.initialOwnerEnrollment;
    const initialOwnerEnrollment = localSetupToken
      ? {
          expiresAt: new Date(Date.now() + localSetupEnrollmentLifetimeMilliseconds),
          renewable: true,
          tokenDigest: digestSecret(localSetupToken),
        }
      : operatorSetup
        ? {
            expiresAt: new Date(Date.now() + operatorSetup.lifetimeSeconds * 1_000),
            tokenDigest: operatorSetup.tokenDigest,
          }
        : undefined;
    const hostAuthority = {
      canonicalOrigin: deployment.canonicalOrigin,
      deploymentId: deployment.id,
      hostInstanceId: deployment.activeHostInstanceId,
      hostKey: { algorithm: "Ed25519" as const },
      deploymentShape: {
        kind: deployment.deploymentShape.kind,
      },
    };
    let closeBrowserSession: (sessionId: import("@opensteer/core").AuthSessionId) => void = () =>
      undefined;
    // A Cloud Computer's Home signs its one owner in with the Opensteer Account
    // that booted it, through the OIDC client that Account registered for it.
    const managedAccountProvider = config.managedHome
      ? {
          allowPrivateNetwork: false,
          clientId: config.managedHome.oidc.clientId,
          clientSecret: config.managedHome.oidc.clientSecret,
          issuer: config.managedHome.accountOrigin.origin,
          label: "Opensteer",
          providerId: officialOpensteerAccountProviderId,
          trustedOrigins: [],
        }
      : undefined;
    const identity = new IdentityService(database, {
      deployment: {
        kind: "personal",
        name: config.deploymentName ?? null,
      },
      ...(initialOwnerEnrollment ? { initialOwnerEnrollment } : {}),
      localPasswordEnabled: config.identity.localPasswordEnabled,
      onSessionEnded: (sessionId) => {
        realtime.closeSession(sessionId);
        closeBrowserSession(sessionId);
      },
      ...(localSetupToken
        ? {
            localMachineOwner: {
              displayName: "You",
              email: localMachineOwnerEmail,
            },
          }
        : {}),
      hostKeyFingerprint,
      ...(config.identity.nativeOAuth
        ? { nativeOAuth: { clients: config.identity.nativeOAuth.clients } }
        : {}),
      oidcProviders: managedAccountProvider ? [managedAccountProvider] : [],
      ...(managedAccountProvider
        ? { managedOwner: { providerId: managedAccountProvider.providerId } }
        : {}),
      exposure: config.exposure,
      ...personalHomeKindOption(config),
      ...(config.portalOrigin ? { portalOrigin: config.portalOrigin } : {}),
      publicOrigin: config.canonicalOrigin,
      secret: config.authSecret,
      signupPolicy: config.identity.signupPolicy,
    });
    await identity.initialize();
    if (
      exposurePolicy.operatorOwnerSetup &&
      !initialOwnerEnrollment &&
      (await identity.configuration()).setupState === "required"
    )
      throw new HostConfigurationIssue(
        "home-setup-code-required",
        "An unclaimed Home requires OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN or its digest.",
      );
    // The Runner registry is built further down, once the services its hooks
    // need exist. Everything above that reaches it only while a request is in
    // flight, so those callers address it through this indirection rather than
    // forcing the whole composition order to change.
    let runnerRegistry: RunnerRegistry | undefined;
    const runFileRelay = new RunFileRelay(async (scope, payload, signature) => {
      const runner = await store.runnerForAuthentication(scope.runnerId);
      return (
        !!runner &&
        !runner.revokedAt &&
        runner.connectionGeneration === scope.connectionGeneration &&
        verify(null, Buffer.from(payload), runner.publicKeyPem, Buffer.from(signature, "base64url"))
      );
    });
    let disconnectBrowserSources = () => {};
    // Every Personal Host holds its Opensteer Account link here; only a Mac
    // Home also signs Remote access routes, because a networked Home's
    // canonical origin is already its route to everything else.
    const accountGrantVerifier = config.personalAccountIssuer
      ? new RemotePersonalAccountGrantVerifier({
          audience: config.canonicalOrigin.origin,
          ...(options.personalAccountGrantFetch
            ? { fetch: options.personalAccountGrantFetch }
            : {}),
          issuer: config.personalAccountIssuer,
        })
      : undefined;
    const personalAccount = config.personal
      ? new PersonalRemoteAccessService({
          authority: hostAuthority,
          database,
          // Every computer somebody lent this Deployment reached it over the
          // route that just changed, so none of their connections survives it.
          // Its hosting Runner and the messaging service beside it never
          // travelled that route.
          disconnectRunners: async () => {
            await runnerRegistry?.disconnectRouteAdmittedRunners("Remote access was reconfigured");
            disconnectBrowserSources();
          },
          ...(accountGrantVerifier ? { grantVerifier: accountGrantVerifier } : {}),
          ...(options.accountDirectoryFetch ? { fetch: options.accountDirectoryFetch } : {}),
          identity,
          keys,
          onAccountLinkChanged: () => {
            void ownerProfile.refresh().catch(reportOwnerProfileError);
          },
        })
      : undefined;
    const personalRemoteAccess = exposurePolicy.personalRemoteAccess ? personalAccount : undefined;
    const managedHomeClaim =
      config.managedHome && accountGrantVerifier
        ? new ManagedHomeClaimService({
            authority: {
              canonicalOrigin: config.canonicalOrigin.origin,
              deploymentId: deployment.id,
              hostInstanceId: deployment.activeHostInstanceId,
              hostKeyFingerprint,
            },
            identity,
            keys,
            managed: {
              cloudComputerId: config.managedHome.cloudComputerId,
              generation: config.managedHome.generation,
            },
            verifier: accountGrantVerifier,
          })
        : undefined;
    let reportOwnerProfileError: (error: unknown) => void = () => {};
    const ownerProfile = new OwnerProfileService({
      store: store.ownerProfile,
      account: personalAccount ?? null,
      changed: () => undefined,
      report: (error) => reportOwnerProfileError(error),
    });
    await personalAccount?.purgeExpiredAccountLinkKeys();
    const tokens = new SignedTokenService(keys, {
      deploymentId: deployment.id,
      hostInstanceId: deployment.activeHostInstanceId,
    });
    const browserAttachKeyId = config.browserRuntime?.attachKeyId ?? "host-v1";
    const browserAttachPublicKeys = [
      { keyId: browserAttachKeyId, publicKeyPem: keys.publicKeyPem },
    ];
    const browserRelay = new RunnerBrowserHub();
    // The catalog is the one description of an app, so a computer reporting a
    // definition this Host does not ship is reporting something nobody here
    // could name or call.
    const computerAppDefinitionIds = new Set(computerAppIntegrations.map(({ id }) => id));
    let reportComputerUseSweepError: (error: unknown) => void = (error) => {
      console.warn("Computer use sweep failed", error);
    };
    // The service is built from the hub and the hub tells it when a stream is
    // lost, so one of the two is bound after the other exists.
    let computerUse: ComputerUseService | undefined;
    let computerViews: ComputerViewService | undefined;
    let nativeTabs: NativeTabTargets | undefined;
    let displayStreams: DisplayStreamHub | undefined;
    let pluginPackages: PluginPackageService | undefined;
    const deviceDrivers = new DeviceDriverResolver({
      store,
      invalidated: (binding) => computerApps.invalidateDevice(binding),
    });
    await deviceDrivers.refresh();
    const computerApps = new ComputerAppHub({
      drivers: deviceDrivers,
      recordRunnerOutdated: async (runner) => {
        await store.recordRunnerUpdateRequired({ ...runner, reason: "runner-outdated" });
      },
      requireDeviceAgentAccess: async (deviceId) => {
        const binding = deviceDrivers.binding(deviceId);
        await requireDeviceAccess(
          database,
          deviceId,
          "apps",
          binding.role === "self"
            ? runners.isRunnerConnected(binding.runnerId)
            : computerApps.attached(deviceId),
          {
            asleep: runners.isRunnerAsleep(binding.runnerId),
            stopped: runners.agentsStoppedSince(binding.runnerId) !== null,
          },
        );
      },
      onDeviceInputWithdrawn: (deviceId) => displayStreams?.withdrawOwnerInput(deviceId),
      onDeviceRemoved: (deviceId, removed) => {
        computerUse?.forgetDevice(deviceId, removed);
        computerViews?.forgetDevice(deviceId);
        nativeTabs?.forgetComputer(deviceId);
        displayStreams?.forgetDevice(deviceId);
        tabs?.changed();
        announceResources("tab");
      },
      onDeviceInvalidated: (binding) => {
        computerUse?.forgetDriver(binding);
        computerViews?.forgetDriver(binding);
        nativeTabs?.forgetComputer(binding.deviceId);
        nativeTabs?.forgetComputer(binding.runnerId);
        displayStreams?.forgetDriver(binding);
        tabs?.changed();
        announceResources("tab");
      },
      requireAgentAccess: async (runnerId) =>
        requireRunnerDeviceAccess(database, runnerId, "apps", runners.isRunnerConnected(runnerId), {
          asleep: runners.isRunnerAsleep(runnerId),
          stopped: runners.agentsStoppedSince(runnerId) !== null,
        }),
      packageSource: (serverId, runnerId, launch) =>
        pluginPackages?.computerSource(serverId, runnerId, launch),
      knownDefinitionIds: () => computerAppDefinitionIds,
      onPhoneDisplayCapability: (status) =>
        app.log.info(status, "Phone display capability changed"),
      onChanged: (runnerId) => {
        announceResources("machine");
        notices.notify({ runnerId });
      },
      onComputerUseEvent: (deviceId, event, route) =>
        computerUse?.handleHelperEvent(deviceId, event, route),
      onRunnerDetached: (runnerId, reason) => {
        if (reason === "device-restarting") displayStreams?.forgetRunner(runnerId, reason);
        computerViews?.forgetRunner(runnerId, reason === "device-restarting" ? reason : undefined);
        nativeTabs?.forgetComputer(runnerId);
        if (reason !== "device-restarting") displayStreams?.forgetRunner(runnerId, reason);
        computerUse?.forgetRunner(runnerId);
        tabs?.changed();
        announceResources("tab");
      },
      onDisplayEvent: (runnerId, event) => displayStreams?.handlePhoneEvent(runnerId, event),
      onPluginDataRemoved: (runnerId, pluginId) =>
        integrationPlatformStore.plugins.confirmDataRemoval(runnerId, pluginId),
      onRunnerAttached: (runnerId) => {
        nativeTabs?.forgetComputer(runnerId);
        tabs?.changed();
        announceResources("tab");
        localServers.computerRunnerAttached(runnerId);
      },
    });
    computerUse = new ComputerUseService({
      deploymentId: deployment.id,
      onSessionEnded: (sessionId) => displayStreams?.endSession(sessionId),
      onAuthorityRevoked: ({ runId, bindingGeneration }) =>
        devices.resetComputerGeneration(runId, bindingGeneration),
      hub: computerApps,
      loginReceiver: (target) => {
        try {
          const binding = deviceDrivers.binding(DeviceIdSchema.parse(target));
          return binding.role === "self" ? computerApps.loginReceiver(binding.runnerId) : null;
        } catch {
          return null;
        }
      },
      passwords: {
        validateLease: (input) => passwordSignIns.validateLease(input),
        seal: (input) => passwordSignIns.seal(input),
      },
      // Every computer serving computer apps, Mac or phone; which definitions
      // each serves is the catalog's to say, by the platform it reports.
      listMachines: async (ownerId) => {
        const drivers = await store.listDeviceDrivers({ includeDetached: true });
        const runnerNames = new Map<RunnerId, string>();
        const activeGenerations = new Map<RunnerId, number>();
        const selfRunners = new Map<RunnerId, import("@opensteer/protocol").RunnerModules>();
        let runnerCursor: RunnerId | undefined;
        do {
          const page = await store.listRunners({
            ownerId,
            includeDeployment: true,
            limit: 100,
            ...(runnerCursor ? { after: runnerCursor } : {}),
          });
          for (const runner of page.runners) {
            selfRunners.set(runner.id, runner.moduleDescriptors);
            runnerNames.set(runner.id, runner.name);
            if (!runner.revokedAt) activeGenerations.set(runner.id, runner.connectionGeneration);
          }
          runnerCursor = page.nextCursor ?? undefined;
        } while (runnerCursor);
        const machines: {
          name: string;
          platform: ComputerAppPlatform;
          deviceId: DeviceId;
          definitionId?: "android-phone" | "iphone-screen";
          availability?: import("@opensteer/protocol").DeviceAvailability;
          setup?: import("@opensteer/protocol").PhoneDisplayView["setup"];
        }[] = [];
        let after: DeviceId | undefined;
        do {
          const page = await store.listDevices({
            ownerId,
            includeDeployment: true,
            limit: 100,
            ...(after ? { after } : {}),
          });
          for (const device of page.devices) {
            const bindings = drivers.filter((binding) => binding.deviceId === device.id);
            const screen = bindings.find((binding) => binding.role === "screen");
            const screenGeneration = screen && activeGenerations.get(screen.runnerId);
            const self = bindings.find((binding) => binding.role === "self" && !binding.detachedAt);
            const platform = screen
              ? "ios"
              : self
                ? selfRunners.get(self.runnerId)?.integrations?.platform
                : undefined;
            if (platform)
              machines.push({
                name: device.name,
                platform,
                deviceId: device.id,
                ...(screen
                  ? {
                      availability: screen.detachedAt
                        ? {
                            state: "unavailable" as const,
                            reason: { kind: "not-connected" as const },
                          }
                        : screenGeneration !== undefined &&
                            runnerRegistry?.agentsStoppedSince(screen.runnerId, screenGeneration)
                          ? {
                              state: "unavailable" as const,
                              reason: { kind: "driver-stopped" as const },
                            }
                          : screenGeneration === undefined ||
                              runnerRegistry?.identityForRunner(screen.runnerId)
                                ?.connectionGeneration !== screenGeneration
                            ? {
                                state: "unavailable" as const,
                                reason: {
                                  kind:
                                    screenGeneration !== undefined &&
                                    runnerRegistry?.asleepSince(screen.runnerId, screenGeneration)
                                      ? ("driver-asleep" as const)
                                      : ("driver-offline" as const),
                                },
                              }
                            : !device.accessPolicy.apps
                              ? {
                                  state: "disabled" as const,
                                  reason: { kind: "access-off" as const },
                                }
                              : (computerApps.deviceStatus(device.id)?.availability ?? {
                                  state: "unavailable" as const,
                                  reason: { kind: "unreported" as const },
                                }),
                      setup: {
                        location: "driver-mac" as const,
                        driverRunnerId: screen.runnerId,
                        driverRunnerName: runnerNames.get(screen.runnerId) ?? "its connected Mac",
                      },
                    }
                  : platform === "android"
                    ? {
                        setup: { location: "android-usb" as const },
                        ...(!device.accessPolicy.apps
                          ? {
                              availability: {
                                state: "disabled" as const,
                                reason: { kind: "access-off" as const },
                              },
                            }
                          : {}),
                      }
                    : {}),
                ...(screen
                  ? { definitionId: "iphone-screen" as const }
                  : platform === "android"
                    ? { definitionId: "android-phone" as const }
                    : {}),
              });
          }
          after = page.nextCursor ?? undefined;
        } while (after);
        return machines;
      },
      machineOwners: (ids) =>
        store.effectiveDeviceOwners(ids.map((id) => DeviceIdSchema.parse(id))),
      // A live session is a row on the machines list and a card in its Thread,
      // so opening, closing, gaining an app or acting is a change to publish.
      onError: (error) => reportComputerUseSweepError(error),
      onSessionsChanged: () => {
        announceResources("machine");
        tabs?.changed();
      },
      onPresenceChanged: (ownerUserId, sessions) =>
        notifyComputerPresence(realtime, ownerUserId, sessions),
      authorizer: store,
      stops: {
        clear: (runId) => store.clearComputerUseStops(runId),
        initial: await store.activeComputerUseStops(),
        record: (runId, deviceId) =>
          store.recordComputerUseStop({ runId, deviceId: DeviceIdSchema.parse(deviceId) }),
      },
      onPlaceActivity: (input) => {
        void (async () => {
          const deviceId = DeviceIdSchema.parse(input.place.machineId);
          let query = database
            .selectFrom("personalTabs")
            .select(["id", "title"])
            .where("ownerId", "=", input.ownerId)
            .where("computerId", "=", deviceId)
            .where("closedAt", "is", null);
          if (input.place.kind === "phone") query = query.where("kind", "=", "phone");
          else if (input.windowId) query = query.where("windowId", "=", input.windowId);
          else return;
          const row = await query.executeTakeFirst();
          if (!row) return;
          browser.noteTabActivity({ ...input, tabId: row.id, title: row.title });
          if (!input.ended)
            browser.beginRunTabPlace(
              input.runId,
              input.generation,
            )({ tabId: row.id, title: row.title, site: null });
        })().catch((error) => reportComputerUseSweepError(error));
      },
      resolveActor: (runId, ownerId) =>
        store.resolvePlaceActor({ agentBindingId: `run:${runId}`, ownerId }),
      threadTitle: async (threadId, ownerUserId) =>
        (await store.getThreadForOwner(threadId, ownerUserId))?.title ?? null,
    });
    const messagingRelay = new MessagingRelayHub();
    const localProfiles = new BrowserLocalProfiles({
      deploymentId: deployment.id,
      repository: store,
      baseUrl: config.canonicalOrigin,
      beforeProfileOpen: (runnerId: RunnerId) =>
        runnerBrowsers.requirePersonalProfileInventory(runnerId),
      onReconciled: async (profileId) => {
        await browser.fenceLocalProfile(profileId);
      },
    });
    const runnerBrowsers = new RunnerBrowserRuntimeRouter({
      registry: browserRelay,
      localProfiles,
      onDeletionsChanged: async () => announceResources("browser-profile", "browser-home"),
      onStandardCdpReconnect: (runnerId, relayId, reconcile) =>
        browser
          .reconcileStandardCdpLeases(runnerId, relayId, reconcile)
          .catch(reportBrowserUsageError),
      onPlacementChanged: () => {
        connectionMaintenance?.wake();
        announceResources("browser-placement", "browser-availability", "tab");
      },
    });
    let reportBrowserUsageError: (error: unknown) => void = (error) => {
      console.warn("Browser usage recording failed", error);
    };
    let logMissingBrowserActor: (sessionId: string, bindingId: string) => void = () => undefined;
    await store.recoverConnectionCdpAttempts();
    const browser = new BrowserService({
      requireAgentAccess: async (runnerId) =>
        requireRunnerDeviceAccess(
          database,
          runnerId,
          "browser",
          runners.isRunnerConnected(runnerId),
          {
            asleep: runners.isRunnerAsleep(runnerId),
            stopped: runners.agentsStoppedSince(runnerId) !== null,
          },
        ),
      requireAgentVisibility: async (runnerId) =>
        requireRunnerDeviceAccess(database, runnerId, "browser", true),
      detachRunnerAgents: (runnerId) =>
        commitPersonalMutation(database, async (tx, mutation) => {
          const sessions = await tx
            .selectFrom("browserSessions")
            .select("id")
            .where("runnerId", "=", runnerId)
            .execute();
          if (sessions.length) {
            const removed = await tx
              .deleteFrom("browserSessionAttachments")
              .where(
                "sessionId",
                "in",
                sessions.map(({ id }) => id),
              )
              .executeTakeFirst();
            if (removed.numDeletedRows > 0) mutation.bumpResource("browser-placement");
          }
          return sessions.map(({ id }) => id);
        }),
      deploymentId: deployment.id,
      onMissingActor: (sessionId, bindingId) => logMissingBrowserActor(sessionId, bindingId),
      hostOrigin: config.canonicalOrigin,
      personal: true,
      profileRequestRunner: async (runId) =>
        (
          await database
            .selectFrom("runAttempts")
            .select("runnerId")
            .where("runId", "=", runId)
            .where("status", "=", "current")
            .executeTakeFirst()
        )?.runnerId ?? null,
      localProfiles,
      eraseLocalProfiles: (runnerId) => runnerBrowsers.resumeDeletions(runnerId),
      passkeys: config.passkeys === true,
      passkeyOwnOrigins: () => [config.canonicalOrigin.origin],
      ...(options.browserActivityClock ? { activityClock: options.browserActivityClock } : {}),
      onHistoryChanged: (ownerId, profileId) =>
        realtime.sendToUsers([ownerId], { type: "host.browser-history-changed", profileId }),
      tabs: tabStore,
      onTabsChanged: (owner, ids, stateChanged) => {
        tabs?.changed(owner, ids);
        if (stateChanged) announceResources("tab");
      },
      tabPlaces: {
        write: (input) => store.recordRunTabPlace(input),
        notice: (owner, notice) => realtime.sendToUsers([owner], notice),
      },
      onSessionsChanged: () =>
        announceResources("browser-placement", "browser-availability", "tab"),
      onUsageChanged: (credits) => announceBrowserUsage(realtime, credits),
      onError: (error) => reportBrowserUsageError(error),

      repository: store,
      signer: new BrowserAttachTicketSigner({
        keyId: browserAttachKeyId,
        privateKey: keys.privateKey,
      }),
      targetResolver: runnerBrowsers,
    });
    closeBrowserSession = (sessionId) => browser.closeAuthSession(sessionId);
    let reportBrowserSignInError: (error: unknown) => void = () => undefined;
    let onSessionRequestClosed: AgentSessionService["requestClosed"] | undefined;
    const passwordSignIns = new PasswordSignInService({
      authority: computerApps,
      resolveAuthority: async (ownerId) => {
        let after: RunnerId | undefined;
        do {
          const page = await store.listRunners({
            ownerId,
            includeDeployment: true,
            limit: 100,
            ...(after ? { after } : {}),
          });
          const runner = page.runners.find(
            (runner) =>
              runner.kind === "main" &&
              runner.ownerKind === "deployment" &&
              runner.revokedAt === null &&
              computerApps.passwordSignInSupported(runner.id),
          );
          if (runner) return { name: runner.name, runnerId: runner.id };
          after = page.nextCursor ?? undefined;
        } while (after);
        return null;
      },
      describe: async ({ ownerId, threadId }) => ({
        deploymentId: deployment.id,
        deploymentName: config.deploymentName ?? "Opensteer",
        threadTitle: (await store.getThreadForOwner(threadId, ownerId))?.title ?? "An agent",
      }),
      onError: (error) => reportBrowserSignInError(error),
      onContinuationReady: () => notifyIntegrationContinuations(),
      onDeadlineChanged: () => deadlines?.wake(),
      onPendingBrowserPins: (key, pins) => browser.setRequestPins(key, pins),

      requests: store.requests,
    });
    browser.setLoginLeaseValidator((input) =>
      input.bindingId
        ? passwordSignIns.validateSessionLease({
            ...input,
            bindingId: input.bindingId,
            profileId: input.profileId ?? null,
          })
        : passwordSignIns.validateLease(input),
    );
    const chromeAttempts = sharedChromeAttempts(database);
    await chromeAttempts.recover();
    const chromeTabs = new ChromeSharedTabs(store, {
      attempts: chromeAttempts,
      changed: (ownerId) => {
        tabs?.changed(ownerId);
        announceResources("tab");
      },
      device: async (ownerId, deviceId, list, person) => {
        const computer = await tabComputer(ownerId, deviceId, database);
        if (computer.removed || !computer.selfRunnerId)
          throw new OpensteerError({
            code: "not_found",
            message: "The Chrome computer is unavailable.",
          });
        const runnerId = computer.selfRunnerId;
        if (!person)
          await requireDeviceAccess(
            database,
            deviceId,
            "browser",
            list || runners.isRunnerConnected(runnerId),
            {
              asleep: runners.isRunnerAsleep(runnerId),
              stopped: runners.agentsStoppedSince(runnerId) !== null,
            },
          );
        return computer.name;
      },
    });
    const browserSources = new BrowserSourceService({
      liveTabs: chromeTabs,
      pairingDevice: async (ownerId) => {
        if (!isLoopbackHostname(config.canonicalOrigin.hostname)) return undefined;
        const personal = await initializePersonal();
        return personal?.options.ownerId === ownerId
          ? store.requireSelfDeviceId(personal.options.hostingComputerId)
          : undefined;
      },
      computerName: async (ownerId, deviceId) => {
        const computer = await tabComputer(ownerId, deviceId, database);
        return computer.removed ? null : computer.name;
      },
      deploymentId: deployment.id,
      browser,
      canonicalOrigin: config.canonicalOrigin.origin,
      extensionDirectory: config.personal?.browserExtensionDirectory ?? null,
      currentRoute: async () => (await personalRemoteAccess?.status())?.route ?? null,
      sign: (bytes) => sign(null, bytes, keys.privateKey).toString("base64url"),
      store: new BrowserSourceStore(database),
      requests: store.requests,
      onError: (error) => reportBrowserSignInError(error),
    });
    const savedLogins = new SavedLoginService({
      passwords: passwordSignIns,
      browser,
      lineageScope: async (ownerId, runId) => {
        const { agentConnection } = await store.admitExecution({
          ownerUserId: ownerId,
          subject: { kind: "binding", bindingId: `run:${runId}` },
        });
        return agentConnection
          ? `${agentConnection.agentConnectionId}:${agentConnection.grantRevision}:${runId}`
          : undefined;
      },
      requests: store.requests,
      canonicalOrigin: config.canonicalOrigin.origin,
      currentRoute: async () => (await personalRemoteAccess?.status())?.route ?? null,
      onError: (error) => reportBrowserSignInError(error),
      onLoginSaved: async (offer) => {
        await commands.enqueueThreadInput({
          content: [{ text: passwordsLoginSavedMessage(offer), type: "text" }],
          idempotencyKey: `passwords-login-saved:${offer.id}`,
          policy: "queue",
          requestedBy: offer.ownerId,
          source: { cause: "passwords-login-saved", kind: "platform", sourceRunId: offer.runId },
          threadId: offer.threadId,
        });
      },
      stoppedByPerson: (threadId) => store.latestRunStoppedByPerson(threadId),
    });
    disconnectBrowserSources = () => browserSources.disconnectRouteAdmittedSources();
    const credentialKey = await loadOrCreateCredentialKey({
      dataDirectory,
      ...(config.credentialKeyPath ? { keyPath: config.credentialKeyPath } : {}),
    });
    const integrationVault = new AesGcmSecretVault(
      new StaticEncryptionKeyProvider(new Map([[1, credentialKey]]), 1),
    );
    const credentials = new CredentialService({ key: credentialKey, store });
    const pluginAgentStore = new PluginAgentStore(database);
    const pluginStopCoordinator = new PluginStopCoordinator({
      pluginService: () => pluginService,
      pluginExecutions: () => pluginExecutions,
      hasUnfinishedWorkflows: () => hasUnfinishedPluginWorkflows(database),
      isCurrent: (identity) => runnerRegistry?.isCurrentConnection(identity) === true,
      log: { warn: (details, message) => app.log.warn(details, message) },
    });
    const hostingComputerStopped = () => {
      const current = runnerRegistry?.identityForEnvironment(personalConfig.environmentId);
      const hosting =
        current?.runnerKind === "main" ? current.runnerId : pluginStopCoordinator.hostingRunner;
      return hosting !== undefined && !!runnerRegistry?.agentsStoppedSince(hosting);
    };
    const pluginWorkMode = (identity: RunnerIdentity) => {
      if (
        identity.runnerKind !== "main" ||
        !identity.environmentIds.includes(personalConfig.environmentId)
      )
        return;
      pluginStopCoordinator.onHostingRunnerRegistered(identity);
    };
    const pluginAuthority = new PluginAuthority({
      store,
      settings: pluginAgentStore,
      owner: async () => (await personalSettings(database)).ownerId,
      beforeAuthorize: () => pluginExecutions?.settled() ?? Promise.resolve(),
      computerStopped: hostingComputerStopped,
    });
    let lastEngineStatus: string | undefined;
    pluginService = new PluginService({
      databaseUrl: config.databaseUrl,
      dataDirectory,
      owner: "personal",
      agentWorkStopped: hostingComputerStopped,
      authorize: (input, signal) => pluginAuthority.authorize(input, signal),
      oauthConfiguration: (linked) =>
        pluginOAuth ? pluginOAuth.configuration(linked) : Promise.resolve({ clients: [] }),
      oauthBroker: (operation, input) => {
        if (!pluginOAuth) throw new Error("Plugin sign-in is unavailable");
        return pluginOAuth.broker(operation, input);
      },
      providers: async (caller) => (await localProviders?.providers(caller)) ?? [],
      providerCall: async (input, signal, elicit) => {
        if (!localProviders)
          throw new PluginServiceError("unavailable", "Local tools are starting");
        return localProviders.call(input, signal, elicit);
      },
      onResourcesChanged: (categories) => pluginsChanged(undefined, { categories }),
      onExecution: (execution) => pluginExecutions?.report(execution),
      onState: (state) => {
        const engine = pluginEngineStateView(state);
        const status = JSON.stringify(engine);
        if (status !== lastEngineStatus) {
          lastEngineStatus = status;
          announceResources("plugin-engine");
        }
        if (state.status === "restarting" || state.status === "unavailable")
          void pluginExecutions
            ?.recover()
            .catch((error) => app.log.error({ err: error }, "Plugin recovery failed"));
      },
      credentialKey,
      webhookOrigin: async () => {
        const status = await personalRemoteAccess?.status();
        if (status?.mode === "connect") return status.route?.document.route.origin;
        if (config.exposure === "loopback") return undefined;
        return resolvePublicAddress(config.canonicalOrigin.hostname).then(
          () => config.canonicalOrigin.origin,
          () => undefined,
        );
      },
      origin: config.canonicalOrigin.origin,
      ...options.pluginEngine,
    });
    credentialKey.fill(0);
    await credentials.initialize();
    const integrationAuthAttempts = new DefaultIntegrationAuthAttemptLifecycle({
      store: new IntegrationAuthAttemptStore(database),
      vault: integrationVault,
    });
    const hostedOAuthBrokerIssuer = config.personalAccountIssuer;
    const hostedOAuthBroker = hostedOAuthBrokerIssuer
      ? {
          broker: new HostedOAuthBrokerClient({
            ...(options.accountControlFetch ? { fetch: options.accountControlFetch } : {}),
            hostCredential: async () => {
              return (
                (
                  await database
                    .selectFrom("personalRemoteAccountLink")
                    .select("hostCredential")
                    .where("singletonKey", "=", "opensteer-account")
                    .where("state", "=", "active")
                    .executeTakeFirst()
                )?.hostCredential ?? null
              );
            },
            issuer: hostedOAuthBrokerIssuer,
          }),
          deploymentAuthorityDigest: hostedOAuthDeploymentAuthorityDigest({
            activeHostInstanceId: deployment.activeHostInstanceId,
            canonicalOrigin: deployment.canonicalOrigin,
            hostKeyFingerprint,
            id: deployment.id,
          }),
        }
      : undefined;
    const integrationPlatformStore = new IntegrationPlatformStore(database);
    const listConnections = (ownerUserId: UserId) =>
      listIntegrationConnections(database, ownerUserId);
    let logComputerLifecycle = (event: string, details: Readonly<Record<string, unknown>>) =>
      console.info(event, details);
    computerViews = new ComputerViewService({
      selfDeviceId: (runnerId) => store.requireSelfDeviceId(runnerId),
      onPhoneView: (status) => app.log.info(status, "Phone owner view command"),
      hub: computerApps,
      connections: listConnections,
      owners: (ids) => store.effectiveDeviceOwners(ids.map((id) => DeviceIdSchema.parse(id))),
      changed: (ownerId, notice) => {
        if (notice.type === "host.computer-view.changed") {
          nativeTabs?.observeView(notice.view);
        } else if (notice.type === "host.computer-view.removed")
          app.log.info(
            {
              machineId: notice.machineId,
              viewId: notice.viewId,
              generation: notice.generation,
              reason: notice.reason,
            },
            "Computer owner view ended",
          );
        realtime.sendToUsers([ownerId], notice);
        tabs?.changed(ownerId);
        announceResources("machine", "tab");
      },
      log: (event, details) => logComputerLifecycle(event, details),
      ended: (viewId, generation, reason) =>
        displayStreams?.endOwnerView(viewId, generation, reason),
    });
    nativeTabs = new NativeTabTargets({
      views: computerViews,
      connections: listConnections,
      owns: async (owner, computer) =>
        (await store.effectiveDeviceOwners([DeviceIdSchema.parse(computer)])).get(
          DeviceIdSchema.parse(computer),
        )?.effectiveOwner === owner,
      connected: (computer) => computerApps.attached(computer),
      queryWindow: (computer, target) =>
        computerApps.resolveWindow(computer, target, { timeoutMs: 10_000 }),
      users: (owner, computer, window) => computerUse!.nativeTargetUsers(owner, computer, window),
      phoneUnavailable: (computer) => computerApps.displayUnavailableReason(computer),
      onWindowStateChanged: (ownerId, _computerId, windowId) => {
        tabs?.windowChanged(ownerId, windowId);
        announceResources("tab");
      },
    });
    tabs = new TabService({
      store: tabStore,
      sharedChromeTabs: (actor) => {
        switch (actor.kind) {
          case "person":
            return chromeTabs.tabPlaces(actor.ownerId, { kind: "person" });
          case "connection":
            return chromeTabs.tabPlaces(actor.caller.userId, {
              kind: "connection",
              agentConnectionId: actor.caller.connectionId,
            });
          case "run":
            return chromeTabs.tabPlaces(actor.claims.requestedBy, {
              kind: "binding",
              bindingId: `run:${actor.claims.runId}`,
            });
          case "browser-binding":
            return chromeTabs.tabPlaces(actor.authority.ownerId, {
              kind: "binding",
              bindingId: actor.authority.agentBindingId,
            });
        }
      },
      devices: store,
      pages: browser.pageTabs,
      nativeTargets: nativeTabs,
      deviceNativeTargets: nativeTabs,
      apps: { get: (owner, id) => requiredService(apps, "Apps").get(owner, id) },
      computer: async (owner, id, db) => {
        const computer = await tabComputer(owner, id, db);
        return {
          ...computer,
          connected: computer.selfRunnerId
            ? runners.isRunnerConnected(computer.selfRunnerId)
            : computerApps.attached(id),
        };
      },
      canRead: canReadTab,
      canReadTask: async (actor, id, db) => (await readableTabTasks(actor, [id], db)).has(id),
      readableTasks: (actor, ids, db) => readableTabTasks(actor, ids, db),
      readAuthority: async (actor, db) => {
        const check = await tabReadAuthority(actor, db);
        return async (row) => {
          try {
            return await check(row);
          } catch (error) {
            if (error instanceof OpensteerError && ["forbidden", "not_found"].includes(error.code))
              return false;
            throw error;
          }
        };
      },
      computers: async (owner, ids, db) =>
        new Map(
          [...(await tabComputers(owner, ids, db))].map(([id, computer]) => {
            return [
              id,
              {
                ...computer,
                connected: computer.selfRunnerId
                  ? runners.isRunnerConnected(computer.selfRunnerId)
                  : computerApps.attached(id),
              },
            ] as const;
          }),
        ),
      authorize: authorizeTabTarget,
      authorizeMembership: authorizeTabActor,
      deniedRows: deniedTabRows,
      onError: (error) => reportBrowserUsageError(error),
    });
    // A connection gaining authority settles Requests targeting the hosting
    // computer and resumes their agents. The reaction is bound once the platform
    // and the continuation outbox exist; both services signal into it from
    // every flow that completes a connection.
    let notifyIntegrationContinuations = (): void => undefined;
    const outputImageStore = new HostOutputImageStore(dataDirectory);
    const files = new AgentHomeFiles({
      agentHome: async () => (await personalExecution()).options.agentHome,
      transport: {
        relay: runFileRelay,
        requestHomeFile: (runnerId, request, signal) =>
          requiredService(runnerRegistry, "Runner registry").requestHomeFile(
            runnerId,
            request,
            signal,
            (binding, connectionSignal) => {
              if (
                request.type === "host.home-files.download" ||
                request.type === "host.home-files.write"
              ) {
                runFileRelay.bind(
                  request.transfer,
                  request.type === "host.home-files.download" ? "PUT" : "GET",
                  binding,
                  connectionSignal,
                );
              }
            },
          ),
      },
    });
    let harnessAuthenticationCoordinator: HarnessAuthenticationCoordinator | undefined;
    // A Runner can register before the Fastify instance that owns the log
    // exists, so the boot window gets a real sink rather than a discard. It is
    // replaced by the Host's own logger once there is one.
    let reportHarnessAuthenticationNudgeError: (
      environmentId: EnvironmentId,
      error: unknown,
    ) => void = (environmentId, error) => {
      console.warn(
        "Harness authentication could not be resumed after Runner registration",
        environmentId,
        error,
      );
    };
    let reportUsageLimitInspectionError: (environmentId: EnvironmentId, error: unknown) => void = (
      environmentId,
      error,
    ) => {
      console.warn(
        "Harness catalogs could not be re-read after a usage limit",
        environmentId,
        error,
      );
    };
    let reportDuplicateRunUsage: (runId: RunId) => void = (runId) => {
      console.warn("Run usage was already recorded; the later statement was dropped", runId);
    };
    let reportHarnessCatalogConvergenceError = (error: unknown): void => {
      console.warn("AI model catalogs could not be refreshed", error);
    };
    let reportHarnessCatalogInvalidationError: (
      harnessInstanceId: string,
      error: unknown,
    ) => void = (harnessInstanceId, error) => {
      console.warn(
        "Harness catalog could not be recaptured after preparation",
        harnessInstanceId,
        error,
      );
    };
    let reportWatchReconciliationError: (environmentId: EnvironmentId, error: unknown) => void = (
      environmentId,
      error,
    ) => {
      console.warn("Watch reconciliation failed", environmentId, error);
    };
    let reportAssignmentReturnError: (assignmentId: AssignmentId, error: unknown) => void = (
      assignmentId,
      error,
    ) => {
      console.warn("Task result could not be returned yet", assignmentId, error);
    };
    let reportShellError: (error: unknown) => void = (error) => {
      console.warn("Machine access notification failed", error);
    };
    let reportShellAuditError: (sessionId: ShellSessionId, error: unknown) => void = (
      sessionId,
      error,
    ) => {
      console.warn("Machine access audit could not be recorded", sessionId, error);
    };
    let reportShellControlError: (runnerId: RunnerId, error: unknown) => void = (
      runnerId,
      error,
    ) => {
      console.warn("Machine access control stream failed", runnerId, error);
    };
    let notifyAutomationFailures = (): void => undefined;
    let reportNotification: (level: "error" | "warn", failure: object) => void = (
      level,
      failure,
    ) => {
      console[level]("Notification publication dropped", failure);
    };
    let shellHub: ShellHub | undefined;
    // Every Host decides its notifications and sends them to its people's open
    // clients. Push to phones exists only where there is an Account to publish
    // through: a Home whose owner has linked one.
    const personalAccountIssuer = config.personalAccountIssuer;
    const notificationTarget: (() => Promise<NotificationPublicationTarget | null>) | undefined =
      personalAccount && personalAccountIssuer
        ? async () => {
            const link = await database
              .selectFrom("personalRemoteAccountLink")
              .select(["hostCredential", "issuer"])
              .where("singletonKey", "=", "opensteer-account")
              .where("state", "=", "active")
              .where("issuer", "=", personalAccountIssuer.origin)
              .executeTakeFirst();
            return link
              ? {
                  controlApiOrigin: new URL(link.issuer),
                  hostCredential: link.hostCredential,
                }
              : null;
          }
        : undefined;
    // Removing a computer app can revoke the channels that were a use of it.
    let channelService: ChannelService | undefined;
    const notifications = new NotificationStore(
      database,
      options.notificationTiming?.now ? { now: options.notificationTiming.now } : {},
    );
    const notificationIssuer = personalAccountIssuer;
    const notificationPreviews =
      notificationTarget && notificationIssuer
        ? new NotificationPreviewService({
            issuer: notificationIssuer.origin,
            store: new NotificationPreviewKeyStore(database),
            vault: integrationVault,
            onError: (code) => console.warn(code),
          })
        : undefined;
    // Recovery below can publish before the authority publisher exists.
    let resolveNotificationAuthority!: () => void;
    const notificationAuthorityReady = new Promise<void>((resolve) => {
      resolveNotificationAuthority = resolve;
    });
    notificationDispatcher = new NotificationDispatcher({
      ...options.notificationTiming,
      ...(notificationTarget
        ? {
            client: new NotificationPublicationClient({
              deploymentId: deployment.id,
              ...(options.accountDirectoryFetch ? { fetch: options.accountDirectoryFetch } : {}),
              hostInstanceId: deployment.activeHostInstanceId,
              target: notificationTarget,
              ...(notificationPreviews ? { previews: notificationPreviews } : {}),
            }),
          }
        : {}),
      onLive: ({ userId, view }) =>
        realtime.sendToUsers([userId], { notification: view, type: "host.notification" }),
      onError: (failure) => reportNotification("error", failure),
      onWarning: (failure) => reportNotification("warn", failure),
      ready: notificationAuthorityReady,
      store: notifications,
    });
    let reportComputerUseTeardownError = (runId: RunId, error: unknown): void => {
      console.warn("Run computer-use teardown failed", { runId }, error);
    };
    let idleCompactionService: IdleCompactionService | undefined;
    const endGrants: Parameters<OpensteerStore["onRunGrantsRevoked"]>[0] = (grants) => {
      browser.endRevokedRunActors(grants);
      computerUse?.endGrantSessions(grants);
      for (const grant of grants) {
        devices.endComputerGeneration(grant.runId, grant.bindingGeneration);
        void drainLegacyRunCdp(browser, grant.runId, grant.bindingGeneration).catch(
          reportMutationFailure,
        );
      }
      void shellHub?.endGrantSessions(grants, "run-ended").catch(reportMutationFailure);
    };
    store.onRunGrantsRevoked(endGrants);
    // Delegation returns are a durable outbox: a commit wakes the drain, and a
    // return that failed or waits behind a full parent inbox is retried with
    // backoff rather than waiting for the next commit or a Host restart.
    assignmentReturns = new DeadlineDrain({
      ...(options.executionClock ? { clock: options.executionClock } : {}),
      onError: reportMutationFailure,
      drain: () =>
        assignmentReturnPass(
          (limit) => store.drainPendingAssignmentReturns(limit),
          (assignmentId, error) => reportAssignmentReturnError(assignmentId, error),
        ),
    });
    store.onAssignmentReturnReady(() => assignmentReturns?.wake());
    store.onPersonMessageReady((message) => notificationDispatcher?.dispatch(message));
    finishLoop = new DeadlineDrain({
      onError: reportMutationFailure,
      ...(options.executionClock ? { clock: options.executionClock } : {}),
      drain: createRunFinishDrain(database, links, {
        now: executionNow,
        onError: reportMutationFailure,
      }),
    });
    browserTabsChanged = (tabIds) => browser.shadowTabsChanged(tabIds);
    react = (reaction) => {
      const runs = shadowRunsTouched(reaction);
      if (runs !== undefined) browser.shadowRunsChanged(runs);
      switch (reaction.type) {
        case "deadlinesChanged":
          deadlines?.wake();
          break;
        case "executionCommandsChanged":
          wakeExecutionCoordinator();
          break;
        case "executionDeadlinesChanged":
          executionLeaseLoop?.wake();
          break;
        case "continuationsChanged":
          notifyIntegrationContinuations();
          break;
        case "automationFailuresChanged":
          notifyAutomationFailures();
          break;
        case "triggerSchedulesChanged":
          wakeTriggerSchedules?.();
          break;
        case "triggerPaused":
          void firingInterrupts?.wake();
          break;
        case "runnerRevoked":
          void runnerRegistry?.revoke(reaction.runnerId).catch(reportMutationFailure);
          break;
        case "authorityChanged":
          passwordSignIns.authorityChanged();
          browser.invalidatePlaceAuthority();
          break;
        case "grantsRevoked":
          endGrants(reaction.grants);
          realtime.wake(syncHead, new Set(["authority"]));
          break;
        case "requestChanged":
          taskQuestions?.requestChanged(reaction);
          passwordSignIns.requestChanged(reaction);
          if (reaction.status !== "pending") onSessionRequestClosed?.(reaction.requestId);
          pluginExecutions?.observe(reaction);
          notificationDispatcher?.dispatch(reaction);
          notices.notify({ requestId: reaction.requestId });
          void store.requests
            .get(reaction.requestId)
            .then((request) => {
              if (request) browser.observeRequest(request);
            })
            .catch(reportMutationFailure);
          if (reaction.status !== "pending") notifyIntegrationContinuations();
          break;
        case "runChanged":
          pluginExecutions?.observe(reaction);
          if (reaction.transition === "restarted") wakeExecutionCoordinator();
          if (reaction.transition === "background") notifyIntegrationContinuations();
          if (
            reaction.transition === "background" ||
            reaction.transition === "foreground" ||
            reaction.transition === "restarted"
          )
            executionLeaseLoop?.wake();
          if (reaction.transition === "finishing") {
            finishLoop?.wake();
            executionLeaseLoop?.wake();
          }
          if (reaction.transition === "usage-limit" && runnerRegistry) {
            void inspectHarnessCatalogsAfterUsageLimit({
              catalogs: harnessCatalogs,
              environmentId: reaction.environmentId,
              failureCode: harnessUsageLimitFailureCode,
              runners: runnerRegistry,
              signal: AbortSignal.timeout(30_000),
            }).catch((error: unknown) =>
              reportUsageLimitInspectionError(reaction.environmentId, error),
            );
          }
          break;
        case "runFinished":
          pluginExecutions?.observe(reaction);
          if (reaction.bindingGeneration !== null)
            runnerRegistry?.retireRunBinding(reaction.runId, reaction.bindingGeneration);
          wakeExecutionCoordinator();
          executionLeaseLoop?.wake();
          liveText.finish(reaction, syncHead);
          realtime.wake(syncHead, new Set(["authority"]));
          if (reaction.attemptOnly) break;
          reconcileMemoryPasses?.();
          notificationDispatcher?.dispatch(reaction);
          void toolActivity
            .finalize(reaction.runId)
            .catch((error) => reportComputerUseTeardownError(reaction.runId, error));
          computerUse?.closeForRun(reaction.runId);
          tabs?.changed();
          void devices
            .endComputerRun(reaction.runId)
            .catch((error) => reportComputerUseTeardownError(reaction.runId, error));
          void chromeTabs
            .closeForBinding(`run:${reaction.runId}`, "The browser task ended.")
            .catch(reportMutationFailure);
          void browser
            .detachAgentSessionsForBinding(`run:${reaction.runId}`)
            .catch(reportMutationFailure);
          void shellHub?.endRunSessions(reaction.runId, "run-ended").catch(reportMutationFailure);
          if (reaction.outcome === "completed")
            void idleCompactionService?.arm(reaction.threadId).catch(reportMutationFailure);
          notifyIntegrationContinuations();
          break;
        case "nodeProgressPlacement":
          liveText.placeNode(reaction, syncHead);
          break;
        case "runLiveClosed":
          liveText.finish(reaction, syncHead);
          break;
        case "liveClosed":
          liveText.closeItem(reaction);
          break;
      }
    };
    const longRequestHold = async (runId: RunId): Promise<boolean> => {
      const run = await database
        .selectFrom("runs")
        .innerJoin("harnessInstances", "harnessInstances.id", "runs.harnessInstanceId")
        .select(["runs.environmentId", "harnessInstances.driverKind"])
        .where("runs.id", "=", runId)
        .executeTakeFirst();
      return (
        !!run &&
        requiredService(runnerRegistry, "Runner registry").supportsLongRequestHold(
          run.environmentId,
          run.driverKind,
        )
      );
    };
    const isRunnerConnected = (runnerId: RunnerId) =>
      requiredService(runnerRegistry, "Runner registry").isRunnerConnected(runnerId);
    const onConnectionsChanged = () => {
      void computerViews
        ?.revalidate()
        .catch((error: unknown) => reportComputerUseSweepError(error));
      realtime.broadcast({ type: "host.connections-changed" });
      tabs?.changed();
      announceResources("machine", "tab");
      void channelService?.syncRuntimes();
      // A bridge whose computer app lost its approval ends: the cleanup worker revokes it now.
      connectionMaintenance?.wake();
    };
    const onSettingsChanged = async ({
      installationId,
      ownerUserId,
    }: {
      installationId?: string;
      ownerUserId?: UserId;
    }) => {
      if (ownerUserId) pluginsChanged(ownerUserId);
      else notices.notify(installationId ? { installationId } : {});
    };
    const localServers = new LocalServerService({
      computerApps,
      dataDirectory,
      isRunnerConnected,
      onConnectionsChanged,
      onSettingsChanged,
      secretVault: integrationVault,
      store: integrationPlatformStore,
    });
    const devices = new DeviceService({
      ...(options.replWorkerEntry
        ? { computerReplTime: { workerEntry: options.replWorkerEntry } }
        : {}),
      listConnections,
      computerDriver: (id, definitionId) => deviceDrivers.resolve(id, definitionId),
      runnerSleeping: (id) => runnerRegistry?.isRunnerSleeping(id) ?? false,
      onDeviceTargetAcquired: (target) => tabs!.acquired(target),
      onDeviceInputAccessWithdrawn: (id) => displayStreams?.withdrawOwnerInput(id),
      computerApps,
      computerUse,
      nativeTabs,
      tabs,
      onTabUsed: (claims, tabId, title) =>
        browser.beginRunTabPlace(
          claims.runId,
          claims.bindingGeneration,
        )({ tabId, title, site: null }),
      nativeTabTarget: async (owner, id) => {
        const row = await tabStore.get(owner, id);
        if (!row || (row.kind !== "window" && row.kind !== "phone"))
          throw new OpensteerError({ code: "not_found", message: "Tab not found." });
        return row.kind === "window"
          ? {
              kind: "window",
              computerId: row.computerId,
              windowId: row.windowId!,
              app: row.windowApp!,
              tabGeneration: row.generation,
            }
          : {
              kind: "phone",
              computerId: row.computerId,
              driverGeneration: (await computerApps.captureRoute(row.computerId))?.generation,
              tabGeneration: row.generation,
            };
      },
      definitions: deviceDefinitions,
      isRunnerConnected,
      localServers,
      // The engine a Thread runs on and the model it runs decide together
      // whether a tool result's picture is a block they render or a sentence
      // saying the picture is unavailable here. Both are read from the
      // Runner's own declarations: the driver's capability and the catalog
      // descriptor the Thread's selection names.
      computerToolEnabled: (context) => {
        const identity = runnerRegistry?.identityForRunner(context.runnerId);
        const agents = identity?.modules.agents;
        return (
          identity?.bootId === context.runnerBootId &&
          !!agents &&
          "computerTool" in agents &&
          agents.computerTool === 1
        );
      },
      runFiles: {
        appFiles: (runnerId) => {
          const integrations = runnerRegistry?.identityForRunner(runnerId)?.modules.integrations;
          return !!integrations && "appFiles" in integrations && integrations.appFiles === 1;
        },
        relay: runFileRelay,
        request: (runnerId, request, signal) =>
          requiredService(runnerRegistry, "Runner registry").requestRunFile(
            runnerId,
            request,
            signal,
          ),
        runFiles: (runnerId) => {
          const agents = runnerRegistry?.identityForRunner(runnerId)?.modules.agents;
          return !!agents && "runFiles" in agents && agents.runFiles === 1;
        },
      },
      computerUseVersion: (runnerId) => {
        const integrations = runnerRegistry?.identityForRunner(runnerId)?.modules.integrations;
        return integrations &&
          "computerUseVersion" in integrations &&
          integrations.computerUseVersion === 2
          ? 2
          : undefined;
      },
      mcpImageContent: async ({ ownerUserId, threadId }) => {
        const thread = await store.getThreadForOwner(threadId, ownerUserId);
        if (!thread) return false;
        const harness = await store.getHarnessInstance(thread.harnessInstanceId);
        if (harness?.enabled !== true) return false;
        return requiredService(runnerRegistry, "Runner registry").rendersMcpImagesForModel({
          driverKind: harness.driverKind,
          environmentId: thread.environmentId,
          harnessInstanceId: thread.harnessInstanceId,
          modelSelection: thread.modelSelection,
        });
      },
      onInputAccessWithdrawn: (runnerId) => displayStreams?.withdrawOwnerInput(runnerId),
      onConnectionsChanged,
      onSettingsChanged,
      store: integrationPlatformStore,
    });
    const accessRequests = new AccessRequests({
      definitions: deviceDefinitions,
      devices,
      store: integrationPlatformStore,
    });
    const localServerRegistry = new LocalServerRegistry({
      store: integrationPlatformStore,
      dataDirectory,
      devices,
      localServers,
      files: async () => files,
      onConnectionsChanged,
      onProviderRemoved: (owner, plugin) =>
        pluginExecutions?.cancelPlugin(owner, plugin) ?? Promise.resolve(),
      onSettingsChanged,
    });
    await browser.initialize();
    await passwordSignIns.sweepAfterRestart();
    await toolActivity.finalize();
    // Before accepting installs: their data folder can precede the plugin transaction.
    await localServers.recoverPluginData();
    localProviders = new LocalProviders({
      store: integrationPlatformStore,
      devices,
      localServers,
      authority: pluginAuthority,
    });
    const providerNames = localProviders;
    pluginExecutions = new PluginExecutions({
      localName: (context, plugin) => providerNames.name(context, plugin),
      service: pluginService,
      store,
      records: pluginAgentStore,
      authority: pluginAuthority,
      onError: (error) => app.log.error({ err: error }, "Plugin execution failed"),
    });
    await pluginExecutions.recover();
    await integrationPlatformStore.computerOperations.finalize();
    await devices.ensureBuiltIns({
      actorUserId: null,
      requestId: "startup:ensure-built-in-integrations",
    });
    await localServers.upgradePackages();
    await localServers.requestLocalServerApprovals();
    await store.recoverThreadWorkQueues();
    await store.restartExecutionLeases(new Date(executionNow() + config.executionLeaseMs));
    finishLoop.start();
    await finishLoop.settled();
    // Runs outlive a Host restart on their leases and continue when their
    // Runners attach again; only the controls the last Host left in flight
    // need settling before this one dispatches anything.
    await store.recoverCommandsAfterHostRestart();
    // No shell session survives a Host epoch, and this runs long before the
    // routes exist: a row left open by the previous Host would otherwise hold
    // capacity for a session whose sockets went with that process.
    await store.endAllOpenShellSessions("host-shutdown");
    let dispatchingRunIds = (): readonly RunId[] => [];
    let watchService: WatchService | undefined;
    let firingInterrupts: FiringInterruptLoop | undefined;
    const registeringRunners = new Set<string>();
    const catalogResetCompleted = new Set<string>();
    const runnerAuthenticator = new RunnerAuthenticator({
      issuancePrivateKey: keys.privateKey,
      store,
    });
    displayStreams = new DisplayStreamHub({
      onState: (runnerId, streamId, state) =>
        app.log.info({ runnerId, streamId, ...state }, "Phone display state changed"),
      log: (event, details) => logComputerLifecycle(event, details),
      authenticator: runnerAuthenticator,
      computerApps,
      computerUse,
      computerViews,
    });
    // The browser and messaging computers a Deployment supervises are
    // enrolled the same way any other machine is; the operator
    // minted their one-use tokens ahead of starting them.
    // A networked Home has no desktop to read `/v1/local-bootstrap`, so its
    // operator hands the hosting Runner's token to both processes. Once that
    // Main has enrolled, a token left in place, or replaced, is simply spent.
    if (config.initialMainRunnerEnrollmentToken)
      await runnerAuthenticator
        .ensureConfiguredMainEnrollment(config.initialMainRunnerEnrollmentToken)
        .catch(async (error: unknown) => {
          if (
            error instanceof OpensteerError &&
            error.code === "conflict" &&
            (await store.deploymentMainRunnerState()) !== "absent"
          )
            return;
          throw error;
        });
    if (config.initialMessagingRunnerEnrollmentToken) {
      await runnerAuthenticator.ensureConfiguredDeploymentEnrollment({
        allowedModules: ["integrations", "messaging"],
        idempotencyKey: "deployment-managed-messaging-runner",
        lifetimeSeconds: 7 * 24 * 60 * 60,
        name: "Messaging service",
        token: config.initialMessagingRunnerEnrollmentToken,
      });
    }
    /** Who owns a module stream once the registry has stopped tracking it. */
    const auxiliaryModuleOwners: {
      readonly [Module in RunnerAuxiliaryModule]: (
        runnerId: RunnerId,
        reason: RunnerStreamLossReason,
      ) => void;
    } = {
      browser: (runnerId, reason) => browserRelay.detachRunner(runnerId, reason),
      integrations: (runnerId, reason) => computerApps.detachRunner(runnerId, reason),
      messaging: (runnerId, reason) => messagingRelay.detachRunner(runnerId, reason),
      shell: (runnerId, reason) => shellHub?.detachRunner(runnerId, reason),
    };
    let naming: ThreadNaming | undefined;
    // What a Runner's connection, modules and readiness change, read live from the registry.
    const runnerChanged = (readinessOnly = false) =>
      resourceRevisions.bump(
        ...(readinessOnly
          ? (["machine", "environment", "tab"] as const)
          : ([
              "machine",
              "environment",
              "harness-catalog",
              "browser-availability",
              "browser-placement",
              "tab",
            ] as const)),
      );
    let renewProxyToken:
      | NonNullable<ConstructorParameters<typeof RunnerRegistry>[0]["hooks"]["onRenewProxyToken"]>
      | undefined;
    let inFlightTriggerOccurrenceIds: (
      runnerId: RunnerIdentity["runnerId"],
      runnerBootId: string,
    ) => readonly import("@opensteer/core").TriggerOccurrenceId[] = () => [];
    const runners: RunnerRegistry = new RunnerRegistry({
      ...(options.executionClock ? { now: executionNow } : {}),
      executionLeaseMs: config.executionLeaseMs,
      hooks: {
        // Only the Host holds the signing key, so the registry asks for the
        // credential rather than minting it.
        issueAuxiliaryTicket: async (identity, module) =>
          runnerAuthenticator.issueAuxiliaryTicket(identity, module),
        // A Run outliving its tokens gets fresh ones only from the boot that
        // holds it, and only while its grant stands.
        refreshRunCredentials: async (identity, runId) => {
          const scope = await store.runCapabilityScope(runId);
          if (
            !scope ||
            scope.runnerId !== identity.runnerId ||
            scope.runnerBootId !== identity.bootId
          ) {
            return { status: "refused" };
          }
          try {
            await store.assertActiveGrant(scope);
          } catch (error) {
            // Only a refused authority is final; anything else is asked again.
            if (
              error instanceof OpensteerError &&
              (error.code === "forbidden" || error.code === "not_found")
            ) {
              return { status: "refused" };
            }
            throw error;
          }
          return {
            credentials: {
              agentTools: runToolTokens.issue(scope),
              attachments: attachmentRunTokens.issue(scope),
            },
            status: "issued",
          };
        },
        onAuxiliaryLost: (stream, reason) => {
          // The registry dropped the stream — a lease expired, the machine was
          // revoked, or its primary connection went. The module owner has to
          // hear about it from here, because no socket event will arrive.
          auxiliaryModuleOwners[stream.fence.module](stream.identity.runnerId, reason);
        },
        onModuleReadiness: async () => runnerChanged(true),
        onSleepAnnounced: ({ runnerId }) => devices.runnerSleeping(runnerId),
        // The person stopped or resumed agents on that computer: its Device
        // and tasks say so at once, and on resume what it held starts now.
        onAgentWork: (identity, stoppedSince) => {
          void runnerChanged(true);
          if (stoppedSince === null)
            for (const environmentId of identity.environmentIds)
              wakeEnvironmentDispatch(environmentId);
        },
        onShellFullDiskAccess: async (identity, value) => {
          const changed = await store.setRunnerShellFullDiskAccess(
            identity.runnerId,
            value,
            identity.connectionGeneration,
          );
          if (changed && value) await machineFullDiskAccess.fulfillForMachine(identity.runnerId);
        },
        authorize: async (identity) => authorizeRunnerRegistration(store, identity),
        onEvent: async (identity, event) => {
          const commit = () =>
            store.commitRunnerEvent({
              environmentId: event.environmentId,
              event,
              verifiedContainment: identity.capabilities.includes(attemptStopStateCapability),
              runnerBootId: identity.bootId,
              runnerId: identity.runnerId,
            });
          const committed =
            event.type === "run.completed" ||
            event.type === "run.failed" ||
            event.type === "run.interrupted"
              ? await withLegacyRunCdpDrain(
                  browser,
                  event.runId,
                  event.bindingGeneration,
                  async () => {
                    await browser.drainRunPlaces(event.runId);
                    return commit();
                  },
                )
              : await commit();
          if (committed.duplicateRunUsage) reportDuplicateRunUsage(event.runId);
          if (committed.revokedGrants.length) endGrants(committed.revokedGrants);
          if (event.type === "run.started")
            await trackLiveRun(event.runId, event.bindingGeneration).catch(reportMutationFailure);
          return committed.throughOrdinal;
        },
        onEventRefused: async (identity, event, refusal) => {
          // This may end the Run, and a place left pending would then be refused.
          await browser.drainRunPlaces(event.runId);
          await store.failRunForRefusedRunnerEvent({
            bindingGeneration: event.bindingGeneration,
            message: refusal.message,
            runId: event.runId,
            runnerBootId: identity.bootId,
            runnerId: identity.runnerId,
          });
        },
        onSkillReport: async (identity, report) => {
          if (!identity.environmentIds.includes(report.environmentId)) return;
          const changed = await reportAgentHomeSkills(
            database,
            {
              ...identity.fence,
              environmentId: report.environmentId,
              bindingGeneration: report.bindingGeneration,
            },
            report,
          );
          if (changed) notices.notify({ runnerId: identity.runnerId });
        },
        onSettingsReport: async (identity, report) => {
          if (!identity.environmentIds.includes(report.environmentId)) return;
          const owner = await reportAgentHomeSettings(
            database,
            { ...identity.fence, environmentId: report.environmentId },
            report,
          );
          if (owner) pluginsChanged(owner);
        },
        bindRunFileTransfer: (transfer, method, binding, signal) =>
          runFileRelay.bind(transfer, method, binding, signal, { allowHttpPeer: true }),
        onAgentHomeReport: async (identity, report, signal) => {
          if (report.environmentId !== personalConfig.environmentId) return false;
          const hosting = await database
            .selectFrom("runners")
            .select("id")
            .where("id", "=", identity.runnerId)
            .where("kind", "=", "main")
            .where("ownerKind", "=", "deployment")
            .where("revokedAt", "is", null)
            .executeTakeFirst();
          if (!hosting || signal.aborted) return false;
          const settings = await findPersonalSettings(database);
          if (signal.aborted) return false;
          if (
            settings &&
            (settings.agentHome.computerId !== identity.runnerId ||
              settings.agentHome.path !== report.path)
          ) {
            app.log.warn("The hosting computer reported a different Agent home path");
            return false;
          }
          reportedAgentHome = { computerId: identity.runnerId, path: report.path, signal };
          try {
            await initializingPersonal;
            await initializePersonal();
            return !signal.aborted;
          } catch (error) {
            if (reportedAgentHome?.signal === signal) reportedAgentHome = undefined;
            app.log.warn({ err: error }, "Agent home canonicalization report refused");
            return false;
          }
        },
        onOutputImagePublish: async (_identity, request, connectionSignal) => {
          if (await outputImageStore.has(request.sha256, request.extension)) {
            return { status: "exists" as const };
          }
          const signal = AbortSignal.any([connectionSignal, AbortSignal.timeout(15_000)]);
          signal.throwIfAborted();
          const transfer = runFileRelay.open(request.sizeBytes);
          runFileRelay.bind(transfer.upload, "PUT", request, signal);
          const onAbort = () => transfer.close(new Error("Output image upload ended"));
          signal.addEventListener("abort", onAbort, { once: true });
          void (async () => {
            try {
              const incoming = await runFileRelay.download(
                transfer.download.id,
                transfer.download.token,
                signal,
              );
              try {
                await outputImageStore.store({
                  extension: request.extension,
                  mediaType: request.mediaType,
                  sha256: request.sha256,
                  signal,
                  sizeBytes: request.sizeBytes,
                  stream: incoming.stream,
                });
                incoming.settled();
              } catch (error) {
                incoming.settled(
                  error instanceof Error ? error : new Error("Output image store failed"),
                );
                incoming.stream.destroy();
              }
            } catch {
              // Timed out or cancelled transfer; runner sees the closed upload.
            } finally {
              transfer.close();
              signal.removeEventListener("abort", onAbort);
            }
          })();
          return { status: "upload" as const, transfer: transfer.upload };
        },
        agentHome: async (identity) => {
          const supportsSettings = identity.capabilities.includes("agent-home-settings-v1");
          const supportsFiles = identity.capabilities.includes(agentHomeFilesCapability);
          if (!supportsSettings && !supportsFiles) return null;
          const settings = await findPersonalSettings(database);
          if (settings) {
            return settings.agentHome.computerId === identity.runnerId
              ? { agentHome: settings.agentHome }
              : null;
          }
          if (identity.runnerKind === "main" && supportsFiles) {
            return {
              agentHome: { computerId: identity.runnerId, path: personalConfig.agentHome },
              agentHomeIsProvisional: true as const,
            };
          }
          return null;
        },
        onLive: (_identity, live) => {
          liveText.accept(live, syncHead);
        },
        onCommandAccepted: async (_identity, receipt) => {
          await store.succeedCommand(receipt.commandId);
        },
        onAppState: (identity, state) => {
          void apps
            ?.onAppState(identity.runnerId, identity.connectionId, state)
            .catch((error) => app.log.warn({ err: error }, "App state report failed"));
        },
        onDisconnect: async (identity, scope) => {
          catalogResetCompleted.delete(identity.connectionId);
          if (scope.reason !== "superseded" && scope.reason !== "shutdown") {
            await store.markConnectionAttemptsContactLost({
              runnerId: identity.runnerId,
              runnerBootId: identity.bootId,
            });
            realtime.publishTriggersChanged();
          }
          void apps
            ?.onRunnerDisconnected(identity.runnerId, identity.connectionId)
            .catch((error) => app.log.warn({ err: error }, "App disconnect handling failed"));
          tabs?.changed();
          // "Last seen" is written when a connection ends, not on every heartbeat.
          await store.touchRunnerConnection({
            connectionGeneration: identity.connectionGeneration,
            runnerId: identity.runnerId,
          });
          // Before the recovery work, which is retried until it succeeds: the
          // row is already offline, and a repeated "reread the list" costs a
          // reader nothing.
          runnerChanged();
          notices.notify({ runnerId: identity.runnerId });
          // A lost connection costs a Run or firing nothing: both keep executing
          // and reattach. A revoked Runner can never come back, so its Runs fail
          // and its firings settle to unknown now; a replaced boot's are settled on attach.
          if (scope.reason === "revoked") {
            await store.failActiveRunsForRunnerDisconnect({
              activeRunIds: scope.runIds,
              runnerBootId: identity.bootId,
              runnerId: identity.runnerId,
            });
            const unknownCount = await triggerStore.markActiveUnknownForRevokedRunner({
              runnerBootId: identity.bootId,
              runnerId: identity.runnerId,
            });
            if (unknownCount > 0) realtime.publishTriggersChanged();
          }
        },
        onHeartbeat: async (identity, activeRunIds) => {
          // The registry delivers heartbeats only from the current connection
          // of a Runner it has not revoked, and every revocation reaches it at
          // commit (`runnerRevoked`), so an idle heartbeat touches no row.
          if (!runners.isCurrentConnection(identity)) {
            throw new Error("Runner connection fence is no longer current");
          }
          if (activeRunIds.length === 0) return [];
          // A lease change writes anyway; record that the Runner was seen and
          // recheck the durable fence in the same breath.
          const connectionIsCurrent = await store.touchRunnerConnection({
            connectionGeneration: identity.connectionGeneration,
            runnerId: identity.runnerId,
          });
          if (!connectionIsCurrent) {
            throw new Error("Runner connection fence is no longer current");
          }
          return store.renewActiveExecutionBindings({
            activeRunIds,
            leaseExpiresAt: new Date(executionNow() + config.executionLeaseMs),
            runnerBootId: identity.bootId,
            runnerId: identity.runnerId,
          });
        },
        onAttach: async (identity, executions) => {
          const connectionIsCurrent = await store.touchRunnerConnection({
            connectionGeneration: identity.connectionGeneration,
            runnerId: identity.runnerId,
          });
          if (!connectionIsCurrent) {
            throw new Error("Runner connection fence is no longer current");
          }
          const attached = await store.attachRunnerExecutions({
            dispatchingRunIds: dispatchingRunIds(),
            executions,
            ...(identity.agentsStoppedSince ? { stoppedComputerName: identity.name } : {}),
            leaseExpiresAt: new Date(executionNow() + config.executionLeaseMs),
            runnerBootId: identity.bootId,
            runnerId: identity.runnerId,
          });
          for (const result of attached.results) {
            if (result.status !== "attached") continue;
            const execution = executions.find(({ runId }) => runId === result.runId);
            if (execution) await trackLiveRun(execution.runId, execution.bindingGeneration);
          }
          return attached.results;
        },
        onAttachFirings: async (identity, firings) => {
          const attached = await triggerStore.attachRunnerFirings({
            dispatchingOccurrenceIds: inFlightTriggerOccurrenceIds(
              identity.runnerId,
              identity.bootId,
            ),
            firings,
            runnerBootId: identity.bootId,
            runnerId: identity.runnerId,
          });
          if (attached.settledUnknownCount > 0) realtime.publishTriggersChanged();
          firingInterrupts?.runnerAttached(identity.runnerId, identity.bootId);
          return attached.results;
        },
        onRenewProxyToken: async (identity, request) =>
          renewProxyToken
            ? renewProxyToken(identity, request)
            : { browserCdp: null, mcp: null, reason: "Token renewal is unavailable." },
        onAttached: runnerAttachedReaction(
          () => wakeExecutionCoordinator(),
          () => idleCompactionService?.reconcile() ?? Promise.resolve(),
        ),
        onRunDispatchAvailable: () => wakeExecutionCoordinator(),
        onHarnessInstallation: async () => runnerChanged(),
        onHarnessCatalogInvalidated: (identity, invalidation) =>
          recaptureInvalidatedHarnessCatalog({
            catalogs: harnessCatalogs,
            connectionGeneration: identity.connectionGeneration,
            environmentIds: identity.environmentIds,
            harnessInstanceId: invalidation.harnessInstanceId,
            runners,
            signal: AbortSignal.timeout(harnessCatalogCaptureTimeoutMs),
            store,
            onCaptured: (environmentId, captured) => {
              observeRunnerCatalogs(identity, environmentId, captured);
              // An unsettled answer (preparing, unavailable, error) is looked at again at its deadline.
              catalogConvergence?.wake();
            },
            onFailed: (error) => {
              reportHarnessCatalogInvalidationError(invalidation.harnessInstanceId, error);
              catalogConvergence?.owe(
                HarnessInstanceIdSchema.parse(invalidation.harnessInstanceId),
              );
            },
          }),
        onRegistered: runnerRegistrationHook(
          (identity: RunnerIdentity) => {
            registeringRunners.delete(identity.connectionId);
            wakeExecutionCoordinator();
          },
          async (identity) => {
            registeringRunners.add(identity.connectionId);
            // Before anything else, and outside the try: the far side of the
            // remote-access fence. A computer sent away here was never online,
            // so there is nothing to announce and nothing to reconcile.
            if (!(await confirmRunnerRegistration(store, runners, identity))) return;
            pluginWorkMode(identity);
            await initializePersonal();
            // A computer is online the moment it registers, whatever its
            // inventory reconciliation goes on to do.
            runnerChanged();
            tabs?.changed();
            void apps
              ?.onRunnerConnected(identity.runnerId)
              .catch((error) => app.log.warn({ err: error }, "App reconciliation failed"));
            notices.notify({ runnerId: identity.runnerId });
            // macOS applies a Full Disk Access grant only once the app has quit
            // and reopened, so the grant usually arrives as a fresh registration
            // whose descriptor already says so — never as a change message.
            if (identity.modules.shell?.fullDiskAccess === true) {
              await machineFullDiskAccess.fulfillForMachine(identity.runnerId);
            }
            try {
              // A newer connection may have registered while this one awaited;
              // its follow-up work must not discard what that one recorded.
              const current = () => runners.isCurrentConnection(identity);
              // Reconnection supersedes the previous boot's observations even
              // if inventory work or the replacement capture fails below.
              for (const environmentId of identity.environmentIds) {
                if (!current()) return;
                const harnesses = await store.listHarnessInstances({
                  environmentIds: [environmentId],
                });
                for (const harness of harnesses) {
                  if (!current()) return;
                  // Fenced in its own transaction too: a newer connection may
                  // register between this check and the write.
                  await store.discardHarnessCatalog(
                    environmentId,
                    harness.id,
                    identity.connectionGeneration,
                  );
                }
              }
              if (current()) catalogResetCompleted.add(identity.connectionId);
              // Managed AI-engine sign-in attempts survive reconnects, so a
              // managed Runner replays them when it registers again.
              if (identity.runnerKind === "managed") {
                for (const environmentId of identity.environmentIds) {
                  // This nudge never holds registration or catalog capture up;
                  // the Runner start itself is idempotent.
                  void harnessAuthenticationCoordinator
                    ?.onRunnerConnected(environmentId)
                    .catch((error: unknown) =>
                      reportHarnessAuthenticationNudgeError(environmentId, error),
                    );
                }
              }
              // Capture this boot's answer; convergence retries a failed capture.
              for (const environmentId of identity.environmentIds) {
                if (!current()) return;
                if (identity.modules.agents) {
                  await ensureDefaultHarnesses(store, environmentId, identity.modules.agents);
                }
                const harnesses = (
                  await store.listHarnessInstances({ environmentIds: [environmentId] })
                ).filter((harness) => harness.enabled);
                const captured = await reconcileAndRecordHarnessCatalogs({
                  catalogs: harnessCatalogs,
                  environmentId,
                  harnesses: harnesses.map(harnessInspectionDefinition),
                  runners,
                  connectionGeneration: identity.connectionGeneration,
                  signal: AbortSignal.timeout(harnessCatalogCaptureTimeoutMs),
                });
                observeRunnerCatalogs(identity, environmentId, captured, true);
              }
              void naming?.reconcile().catch(reportThreadNamingError);
            } finally {
              watchService?.runnerRegistered(identity);
              catalogConvergence?.wake();
              reconcileMemoryPasses?.();
            }
          },
        ),
        onSessionBound: async (identity, binding) => {
          await store.bindProviderSession({
            bindingGeneration: binding.bindingGeneration,
            ...(binding.engineStart ? { engineStart: binding.engineStart } : {}),
            harnessInstanceId: binding.harnessInstanceId,
            providerSessionId: binding.providerSessionId,
            providerSessionReference: binding.providerSessionReference,
            runId: binding.runId,
            runnerBootId: identity.bootId,
            runnerId: identity.runnerId,
            threadId: binding.threadId,
          });
        },
        onTriggerResult: async (identity, result) => {
          const occurrence = await triggerStore.completeExecution({
            executionGeneration: result.executionGeneration,
            output: result.output,
            verifiedContainment: identity.capabilities.includes(attemptStopStateCapability),
            runnerBootId: identity.bootId,
            runnerId: identity.runnerId,
          });
          if (occurrence === null) return "retired";
          firingInterrupts?.settled(occurrence.id);
          realtime.publishTriggersChanged();
          return undefined;
        },
        onWatchStatus: async (identity, status) => {
          await watchService?.applyStatus(identity, status);
        },
      },
    });
    function observeRunnerCatalogs(
      identity: RunnerIdentity,
      environmentId: EnvironmentId,
      catalogs: readonly HarnessInstanceCatalog[],
      afterRegistrationReset = false,
    ): void {
      if (
        !options.onRunnerCatalogsCommitted ||
        runners.identityForEnvironment(environmentId)?.connectionId !== identity.connectionId
      )
        return;
      try {
        void Promise.resolve(
          options.onRunnerCatalogsCommitted(
            identity,
            environmentId,
            catalogs,
            !afterRegistrationReset && !catalogResetCompleted.has(identity.connectionId),
          ),
        ).catch(() => undefined);
      } catch {
        // Observation cannot fail registration or convergence after its commit.
      }
    }
    // A capture that failed on connect, an answer still preparing and a ready
    // catalog older than thirty minutes are looked at again at a deadline.
    catalogConvergence = createHarnessCatalogConvergence({
      ...(options.executionClock ? { clock: options.executionClock } : {}),
      catalogs: harnessCatalogs,
      runners,
      captureTimeoutMs: harnessCatalogCaptureTimeoutMs,
      connectedEnvironmentIds: async () =>
        (await store.listEnvironments())
          .map((environment) => environment.id)
          .filter((environmentId) => runners.isAvailable(environmentId)),
      onCommitted: (environmentId, catalogs) => {
        const identity = runners.identityForEnvironment(environmentId);
        if (identity) observeRunnerCatalogs(identity, environmentId, catalogs);
      },
      onError: (error) => reportHarnessCatalogConvergenceError(error),
    });
    runnerRegistry = runners;
    const egress = new EgressService({
      authorizer: store,
      publicUrl: config.runtimeOrigin,
      tokens,
    });
    const runCapabilityTokens = options.runCapabilityNow
      ? new SignedTokenService(
          keys,
          {
            deploymentId: deployment.id,
            hostInstanceId: deployment.activeHostInstanceId,
          },
          options.runCapabilityNow,
        )
      : tokens;
    const runCapabilityLifetime = options.runCapabilityLifetimeSeconds
      ? { lifetimeSeconds: options.runCapabilityLifetimeSeconds }
      : {};
    const runToolTokens = new RunToolTokenService({
      authorizer: store,
      tokens: runCapabilityTokens,
      ...runCapabilityLifetime,
    });
    shellHub = new ShellHub({
      authenticator: runnerAuthenticator,
      callerTokens: runToolTokens,
      notifier: machineAccessNotifier({
        onError: (error) => reportShellError(error),
        realtime,
        store,
      }),
      onAuditError: (sessionId, error) => reportShellAuditError(sessionId, error),
      onControlError: (runnerId, error) => reportShellControlError(runnerId, error),
      runners,
      store,
    });
    const pluginsTokens = new RunCapabilityTokenService({
      audience: "opensteer-plugin-packages",
      authorizer: store,
      tokens: runCapabilityTokens,
      ...runCapabilityLifetime,
    });
    const attachmentRunTokens = new RunAttachmentsTokenService({
      authorizer: store,
      tokens: runCapabilityTokens,
      ...runCapabilityLifetime,
    });
    const attachmentStore = new AttachmentStore(database);
    const attachments = new AttachmentService({
      dataDirectory,
      store: attachmentStore,
      runTokens: attachmentRunTokens,
    });
    await attachments.collectGarbage();
    const triggerControlTokens = new TriggerControlTokenService({
      store: triggerStore,
      tokens,
    });
    const watchControlTokens = new WatchControlTokenService({ store: triggerStore, tokens });
    const watchBrowserTokens = new WatchCapabilityTokenService({
      audience: "opensteer-watch-browser-cdp",
      store: triggerStore,
      tokens,
    });
    const firingMcpUrl = new URL("/internal/v1/mcp", config.runtimeOrigin).toString();
    const firingBrowserCdpUrl = new URL(
      "/internal/v1/trigger-cdp",
      config.runtimeOrigin,
    ).toString();
    const watchBrowserCdpUrl = new URL("/internal/v1/watch-cdp", config.runtimeOrigin).toString();
    renewProxyToken = async (identity, request) => {
      if (request.target.kind === "firing") {
        const scope = await triggerStore.activeFiringCapabilityScope({
          executionGeneration: request.target.executionGeneration,
          occurrenceId: request.target.occurrenceId,
          runnerBootId: identity.bootId,
          runnerId: identity.runnerId,
        });
        if (!scope) {
          return {
            browserCdp: null,
            mcp: null,
            reason: "Automation firing is no longer active.",
          };
        }
        const token = triggerControlTokens.issue(scope);
        const expiresAt = new Date(Date.now() + runCapabilityLifetimeSeconds * 1_000).toISOString();
        const hasBrowser = await browser.hasBrowserProfiles(
          scope.requestedBy,
          `trigger:${scope.occurrenceId}`,
        );
        return {
          browserCdp: hasBrowser ? { expiresAt, token, url: firingBrowserCdpUrl } : null,
          mcp: { expiresAt, token, url: firingMcpUrl },
        };
      }
      const scope = await triggerStore.activeWatchCapabilityScope({
        activationId: request.target.activationId,
        executionGeneration: request.target.executionGeneration,
        runnerBootId: identity.bootId,
        runnerId: identity.runnerId,
      });
      if (!scope) {
        return {
          browserCdp: null,
          mcp: null,
          reason: "Watch activation is no longer active.",
        };
      }
      const mcp = watchControlTokens.issue(scope);
      const hasBrowser = await browser.hasBrowserProfiles(
        scope.createdBy,
        `watch:${scope.activationId}`,
      );
      const browserCdp = hasBrowser ? watchBrowserTokens.issue(scope) : null;
      return {
        browserCdp: browserCdp ? { ...browserCdp, url: watchBrowserCdpUrl } : null,
        mcp: { ...mcp, url: firingMcpUrl },
      };
    };
    watchService = new WatchService({
      runnerStore: store,
      browser,
      browserCdpUrl: new URL("/internal/v1/watch-cdp", config.runtimeOrigin).toString(),
      controlTokens: watchControlTokens,
      mcpUrl: new URL("/internal/v1/mcp", config.runtimeOrigin).toString(),
      onChanged: () => realtime.publishTriggersChanged(),
      onError: (error, environmentId) => reportWatchReconciliationError(environmentId, error),
      runners,
      store: triggerStore,
      watchBrowserTokens,
    });
    const reportThreadNamingError = (error: unknown) =>
      console.error("Thread naming failed", error);
    naming = new ThreadNaming({
      store,
      catalogs: harnessCatalogs,
      runners,

      onError: reportThreadNamingError,
    });
    const automationSecrets = new AutomationSecrets(integrationVault);
    const dispatcher = new HostCommandDispatcher({
      automationSecrets,
      catalogs: harnessCatalogs,
      runnerRegistrationPending: (environmentId) => {
        const identity = runners.identityForEnvironment(environmentId);
        return identity !== undefined && registeringRunners.has(identity.connectionId);
      },
      onRunAdmitted: (threadId) => {
        void naming?.request(threadId);
      },
      ...(options.executionClock ? { executionClock: options.executionClock } : {}),
      requestResponseVault: integrationVault,
      runToolTokens,
      browser,
      egress,
      executionLeaseMs: config.executionLeaseMs,
      skillPolicy: (ownerUserId) => integrationPlatformStore.settings.skillPolicy(ownerUserId),
      pluginVersions: async (ownerUserId) => [
        ...(await integrationPlatformStore.plugins.current(ownerUserId)).map(
          ({ id, name, digest }) => ({ pluginId: id, name, digest }),
        ),
        ...(await pluginService!.skillCache.versions(await pluginAgentStore.settings(ownerUserId))),
      ],
      pluginsTokens,
      attachmentRunTokens,
      attachments: attachmentStore,

      onTriggerChanged: () => realtime.publishTriggersChanged(),
      publicUrl: config.runtimeOrigin,
      runners,
      store,
      triggerControlTokens,
      triggers: triggerStore,
    });
    inFlightTriggerOccurrenceIds = (runnerId, runnerBootId) =>
      dispatcher.inFlightTriggerOccurrenceIds(runnerId, runnerBootId);
    let reportDispatchError: (error: unknown, commandId: string) => void = (error, commandId) =>
      console.error("Runner command dispatch failed", commandId, error);
    const coordinator = new ExecutionCoordinator({
      dispatcher,
      dispatcherId: `host:${process.pid}`,
      maxConcurrentRuns: config.maxConcurrentDispatches,
      maxConcurrentTriggerPrograms: config.maxConcurrentTriggerDispatches,
      maxQueuedBytes: 64 * 1_024 * 1_024,
      maxQueuedCommands: 10_000,
      onDispatchError: (error, command) => reportDispatchError(error, command.id),
      store,
    });
    // Registration is the earliest proof that queued execution can make
    // progress. The hook is profile-neutral and changes only dispatch latency.
    wakeExecutionCoordinator = () => coordinator.wake();
    wakeEnvironmentDispatch = (environmentId) => coordinator.wakeEnvironment(environmentId);
    dispatchingRunIds = () => coordinator.dispatchingRunIds();
    // Commands run concurrently across Threads, and a few at a time so the
    // database pool keeps room for Runner events, dispatch and reads.
    const admission = new KeyedAdmissionQueue({
      isTransactionConflict,
      maxInFlight: 4,
      maxQueuedBytes: 32 * 1_024 * 1_024,
      maxQueuedCommands: 5_000,
    });
    firingInterrupts = new FiringInterruptLoop({
      onWarn: (error, firing) => {
        app.log.warn(
          { err: error, occurrenceId: firing.occurrenceId },
          "Failed to interrupt running automation firing on pause; will retry",
        );
      },
      runners,
      store: triggerStore,
    });
    const commands = new CommandService({
      admission,
      onExecutionQueued: () => {
        coordinator.wake();
      },
      onInterruptFiring: (firing) => {
        firingInterrupts?.interrupt(firing);
      },

      store,
    });
    let reportContinuationError: (error: unknown) => void = () => undefined;
    const continuations = new ContinuationService({
      passwordSignIn: (operationId) => passwordSignIns.continuationState(operationId),
      commands,
      integrations: {
        computerAccess: (input, run) => devices.computerAccess(input, run),
        computerUseMachines: (ownerUserId) =>
          devices.computerAppApprovals.computerUseMachines(ownerUserId),
        computerUsePhones: (ownerUserId) =>
          devices.computerAppApprovals.computerUsePhones(ownerUserId),
        listCallableTools: (input) => devices.listCallableTools(input),
        listDiscoveryInventory: (input) => devices.listDiscoveryInventory(input),
      },
      onError: (error) => reportContinuationError(error),
      requests: store.requests,
    });
    notifyIntegrationContinuations = () => continuations.notify();
    let reportAutomationFailureError: (error: unknown) => void = () => undefined;
    const automationFailures = new AutomationFailureService({
      commands,
      onError: (error) => reportAutomationFailureError(error),
      store: new AutomationFailureStore(database),
    });
    notifyAutomationFailures = () => automationFailures.notify();
    const quietTasks = new QuietTasks({
      store,
      commands,
      onError: (error) => console.error("Moving quiet tasks to Done failed", error),
    });
    const triggers = new TriggerService({
      runnerStore: store,
      onChanged: () => realtime.publishTriggersChanged(),
      onInterruptFiring: (firing) => {
        firingInterrupts?.interrupt(firing);
      },

      onOccurrenceQueued: () => {
        coordinator.wake();
      },
      onWatchChanged: (triggerId) => {
        void watchService?.triggerChanged(triggerId);
      },
      publicUrl: config.canonicalOrigin,
      remoteOrigin: async () =>
        (await personalRemoteAccess?.status())?.route?.document.route.origin ?? null,
      store: triggerStore,
      threads: store,
    });
    let bridgeToolService: OpensteerMcpService | undefined;
    const channels = new ChannelService({
      onError: (error) => app.log.error({ err: error }, "Channel ingress failed"),
      onChanged: () => realtime.broadcast({ type: "host.connections-changed" }),
      channels: new ChannelStore(database),
      credentials,
      relay: messagingRelay,
      // A bridge calls the same task tools a connected agent does; they exist once the MCP
      // service is built below, before messaging starts.
      bridgeTools: () => {
        if (!bridgeToolService) throw new Error("The task tools are not ready yet");
        return bridgeToolService;
      },
      onAccountEnded: () => void driveConnectionCleanups(),
      store,
    });
    channelService = channels;
    const deviceAccessService = new DeviceAccessService({
      store,
      runners,

      deviceOnline: (id, capability) => {
        let binding;
        try {
          binding = deviceDrivers.binding(id);
        } catch {
          return false;
        }
        if (binding.role === "screen")
          return (
            capability === "apps" &&
            computerApps.attached(id) &&
            computerApps.deviceStatus(id)?.availability.state === "ready"
          );
        return runners.isRunnerConnected(binding.runnerId);
      },
    });
    const machineFullDiskAccess = new MachineFullDiskAccessService({
      probe: (runnerId) => runners.probeFullDiskAccess(runnerId),
      store,
    });
    const placeContext = new PlaceContextService({
      browser,
      computerUse,
      connections: { listConnections },
      integrations: devices,
      store,
    });

    const threadService = new ThreadService({
      store,
      commands,
      runners,
      placeContext,
      browser,
    });
    const memoryPasses = new MemoryPassService({
      store,
      runners,
      readAgentInstructions: async (signal) => {
        const key = Buffer.from("AGENTS.md").toString("base64url");
        try {
          const read = await files.preview(key, signal);
          return new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
        } catch (error) {
          if (error instanceof OpensteerError && error.code === "not_found") return null;
          throw error;
        }
      },

      onChanged: () => realtime.publishTriggersChanged(),
      onError: (error) =>
        app.log.warn(
          { code: error instanceof OpensteerError ? error.code : "internal" },
          "Memory pass provisioning failed",
        ),
    });
    const productHandlers = new ProductToolHandlers({
      deploymentId: deployment.id,
      execution,
      requestResponseVault: integrationVault,
      questionNotices: (taskQuestions = new TaskQuestionNotices({
        database,

        wake: () => coordinator.wake(),
        onError: (error) => app.log.warn({ err: error }, "Task question notice failed"),
      })),
      threads: threadService,
      memoryPasses,
      realtime,
      computerUse,
      personShow: async (userId, message) => {
        const connectedDevices = await realtime.showToPerson(userId, message);
        app.log.info(
          {
            userId,
            runId: message.runId,
            threadId: message.threadId,
          },
          "host.show",
        );
        return connectedDevices;
      },
      tabs,
      supportsLoginFill: (scope) => {
        const runner = runners.identityForEnvironment(scope.environmentId);
        return (
          runner?.runnerId === scope.runnerId &&
          runner.bootId === scope.runnerBootId &&
          runner.modules.agents?.loginFill === 1
        );
      },
      placeContext,
      onBrowserUsage: (credits) => browser.announceUsage(credits),
      browserSources,
      savedLogins,
      deviceAccess: deviceAccessService,
      machineFullDiskAccess,
      browser,
      canRunHarness: (environmentId, driverKind) =>
        runners.canRunHarness(environmentId, driverKind),
      commands,
      isEnvironmentConnected: (environmentId) => runners.isAvailable(environmentId),

      store,
    });
    apps = new AppService({
      tunnels: new AppTunnelHub(runners),
      dataDirectory,
      apps: new AppStore(database),
      tabs: { removeTabs: (tx, id) => tabStore.removeTabs(tx, id) },
      changed: (owner, ids) => {
        realtime.sendToUsers([owner], { type: "host.apps.changed", appIds: ids });
        tabs?.appsChanged(ids);
        announceResources("tab");
      },
      files,
      agentHome: async () => (await personalExecution()).options.agentHome,
      tokens: runToolTokens,
    });
    await apps.collectGarbage();
    const plugins = new PluginPackageService({
      stillGranted: packageStillGranted({
        store,
        installed: (owner) => integrationPlatformStore.plugins.current(owner),
      }),
      computer: { tokens, store: integrationPlatformStore, publicUrl: config.runtimeOrigin },
      snapshotDirectory: resolve(dataDirectory, "plugins", "data", "packages"),
      tokens: pluginsTokens,
    });
    pluginPackages = plugins;
    const staticDistribution = config.webDistribution
      ? await HostStaticDistribution.load({
          ...config.webDistribution,
          expectedBuildId: personalWebBuildId,
        })
      : undefined;
    const discoveryEnvelope = signHostDiscovery(keys, {
      canonicalOrigin: deployment.canonicalOrigin,
      deploymentId: deployment.id,
      hostInstanceId: deployment.activeHostInstanceId,
      hostKey: { algorithm: "Ed25519" },
      deploymentShape: {
        kind: deployment.deploymentShape.kind,
      },
    });
    harnessAuthenticationCoordinator = new HarnessAuthenticationCoordinator({
      harnesses: store,
      runners,
    });
    const localBootstrap = localSetupToken
      ? new LocalBootstrapService({
          publicUrl: config.runtimeOrigin,
          requireSetupCredential: exposurePolicy.localOwnerClaim,
          runners: runnerAuthenticator,
          setupToken: localSetupToken,
          store,
        })
      : undefined;
    const authenticator = new HostAuthenticator({
      identity,
      onAuthenticatedSession: async () => {
        await initializePersonal();
      },
      ...(personalRemoteAccess ? { personalRemote: personalRemoteAccess } : {}),
      publicUrl: config.canonicalOrigin,
    });
    administrationCatalogs = new HarnessCatalogReconciliationOwner({
      catalogs: harnessCatalogs,
      runners,
      onError: (environmentId, error) =>
        app.log.warn({ environmentId, err: error }, "Harness catalog reconciliation failed"),
    });
    const administration = new AdministrationToolHandlers(
      new AdministrationService(
        {
          authenticator,
          store,
          commands,
          apps,
          browser,
          browserSources,
          shellControl: requiredService(shellHub, "Shell session hub"),
          computerApps,
          runners,
          channels: { service: channels, relay: messagingRelay },
          realtime,
          reconcileIdleCompaction: () => idleCompactionService?.reconcile() ?? Promise.resolve(),
          integrations: {
            continuations,
            devices,
            localServerRegistry,
          },
        },
        (id) => administrationCatalogs?.schedule(id),
      ),
      execution.canExecute,
    );
    const pluginPages = new PluginPages({
      service: pluginService,
      assertOwner: (userId) => requirePersonalOwner(database, userId),
      access: async (userId, plugin) =>
        (await pluginAgentStore.settings(userId)).find((row) => row.pluginId === plugin)?.access ??
        "all",
    });
    const pluginTools = new PluginToolHandlers({
      service: pluginService,
      localProviders: providerNames,
      authority: pluginAuthority,
      executions: pluginExecutions,
      sessions: () => agentSessions,
      store,
      settings: pluginAgentStore,
      removed: (plugin) => pluginPages.forget(plugin),
      changed: pluginsChanged,
      folder: async (caller, directory) => {
        requirePluginRun(caller);
        return withFolderPluginPackage({ directory, files, install: pluginSourceFiles });
      },
      exportFiles: async (caller, directory, source, authorize, signal) => {
        requirePluginRun(caller);
        await exportPluginSource(files, directory, source.files, authorize, signal);
      },
    });
    const pluginOwnerApi = new PluginOwnerApi({
      service: pluginService,
      folder: (directory) =>
        withFolderPluginPackage({ directory, files, install: pluginSourceFiles }),
      pages: pluginPages,
      webhooks: { service: pluginService, origin: () => pluginService!.webhookOrigin() },
      settings: pluginAgentStore,
      accountLinked: (input) => pluginTools.accountLinked(input),
      assertOwner: (userId) => requirePersonalOwner(database, userId),
      localTools: (owner, id) => providerNames.owned(owner, id),
      cancelPlugin: (owner, plugin) =>
        pluginExecutions?.cancelPlugin(owner, plugin) ?? Promise.resolve(),
      changed: pluginsChanged,
    });
    pluginOAuth = new PluginOAuthService({
      plugins: pluginService,
      store: new PluginOAuthStore(database, integrationVault),
      attempts: integrationAuthAttempts,
      origin: config.canonicalOrigin.origin,
      owner: async () => (await personalSettings(database)).ownerId,
      ...(hostedOAuthBroker
        ? {
            broker: {
              client: hostedOAuthBroker.broker,
              deploymentAuthorityDigest: hostedOAuthBroker.deploymentAuthorityDigest,
            },
          }
        : {}),
      accountLinked: (input) => pluginTools.accountLinked(input),
    });
    void pluginService.start().catch(() => undefined);
    // An external agent's direct work: sessions, operations and the person's answers to them.
    let reportAgentSessionError: (error: unknown) => void = () => {};
    // The browser for connected agents: scripts kept to the reviewed profile, and raw CDP.
    const browserScriptConfinement = new BrowserScriptConfinement();
    const browserScripts = new BrowserScriptService({
      browser,
      store,
      tabs: browserScriptConfinement.tabs(tabs),
      sharedChromeTabs: chromeTabs,
      ...(options.replWorkerEntry ? { workerEntry: options.replWorkerEntry } : {}),
    });
    const agentSessions = new AgentSessionService({
      store,
      ...(config.agentReviewModel
        ? { reviewer: createAgentReviewer({ store, runners, model: config.agentReviewModel }) }
        : {}),
      closeBinding: (bindingId, reason) => {
        browser.closeStandardCdpForBinding(bindingId, reason);
        void chromeTabs.closeForBinding(bindingId, reason).catch(reportAgentSessionError);
        void pluginExecutions?.stopSession(bindingId).catch(reportAgentSessionError);
        void browserScripts
          .closeBrowserScriptsForBinding(bindingId)
          .catch((error: unknown) => reportAgentSessionError(error));
        // A connected agent's computer work ends with its session: the app, then the script.
        endSessionComputerWork(bindingId, {
          computerUse,
          devices,
          onError: (error) => reportComputerUseSweepError(error),
        });
      },
      onError: (error) => reportAgentSessionError(error),
    });
    onSessionRequestClosed = (requestId) => agentSessions.requestClosed(requestId);
    const agentTools = (bridgeToolService = new OpensteerMcpService({
      connectionPasswords: () => {
        const hosting = initializedPersonal?.options.hostingComputerId;
        return (
          !config.managedHome &&
          hosting !== undefined &&
          computerApps.passwordSignInSupported(hosting)
        );
      },
      savedLogins,
      pluginExecutions,
      requestHold: new RequestHold({
        store,
        continuations,
        onStopped: () => {
          wakeExecutionCoordinator();
        },
        onError: (error) => app.log.error({ err: error }, "A Request hold could not read"),
      }),
      longRequestHold: (caller) => longRequestHold(caller.claims.runId),
      publicUrl: config.runtimeOrigin,
      realtime,
      onToolError: (error, tool) => app.log.error({ err: error, tool }, "Agent tool failed"),
      callers: new AgentCallerResolver({
        store,
        runs: runToolTokens,
        triggers: triggerControlTokens,
        watches: watchControlTokens,
        connections: connections.authenticator,
      }),
      store,
      handlers: agentToolHandlers({
        administration,
        commands: new CommandTools({
          database,
          reads: () => personReadHandlers,
          registry: agentCommandRegistry(administration.service),
          requests: () => commandRequestsForTools,
          sessions: agentSessions,
          administration,
        }),
        plugins: pluginTools,
        localServers: localServerRegistry,
        apps,
        tabs: new TabToolHandlers(tabs, agentSessions),
        discoverSources: { tabs, browserSources, store },
        browser: new BrowserToolHandlers({
          sessions: agentSessions,
          tabs,
          scripts: browserScripts,
          confinement: browserScriptConfinement,
          sharedChromeTabs: chromeTabs,
          profiles: (ownerId) => browser.listProfiles(ownerId),
          requireDevice: async (runnerId) => {
            const deviceId = await store.requireSelfDeviceId(runnerId);
            await requireDeviceAccess(
              database,
              deviceId,
              "browser",
              runners.isRunnerConnected(runnerId),
              {
                asleep: runners.isRunnerAsleep(runnerId),
                stopped: runners.agentsStoppedSince(runnerId) !== null,
              },
            );
            return deviceId;
          },
          issueTicket: (input) => browser.issueStandardCdpTicket(input),
          pooledBrowser: (runnerId) => browser.pooledDirectBrowser(runnerId),
          pooledTab: (actor, tabId) => tabs.connectionTab(actor, tabId),
          origin: config.canonicalOrigin,
        }),
        sessionPerson: new SessionPersonTools({
          sessions: agentSessions,
          tabs,
          browser,
          logins: savedLogins,
          store,
        }),
        product: productHandlers,
        devices: new DeviceToolHandlers({
          devices,
          access: accessRequests,
          sessions: agentSessions,
        }),
        triggers: new TriggerToolHandlers(triggers, store, {
          requests: () => commandRequestsForTools,
        }),
      }),
    }));
    const transcriptFileServices = createTranscriptFileServices({
      authSecret: config.authSecret,
      dataDirectory,
      deploymentId: deployment.id,
      access: new TranscriptFileAccess({
        home: files,
        attachments,
        outputImageStore,
        admit: ({ userId, threadId }) =>
          admitTranscriptFiles(database, { ownerId: userId, threadId }),
        outputImages: (input) => resolveThreadOutputImages(database, input),
        outputImage: (input) => readThreadOutputImage(database, input),
      }),
      guardRead: ({ sessionId, threadId, resource }) =>
        realtime.guardRead([
          `session:${sessionId}`,
          ...(threadId ? [`thread:${threadId}`] : []),
          ...("nodeId" in resource && resource.nodeId ? [`node:${resource.nodeId}`] : []),
        ]),
      authorizeMedia: async ({ sessionId, userId }) =>
        Boolean(
          await database
            .selectFrom("authSessions")
            .innerJoin("users", "users.id", "authSessions.userId")
            .select("authSessions.id")
            .where("authSessions.id", "=", AuthSessionIdSchema.parse(sessionId))
            .where("authSessions.userId", "=", userId)
            .where("authSessions.expiresAt", ">", new Date())
            .where("authSessions.absoluteExpiresAt", ">", new Date())
            .where("users.disabledAt", "is", null)
            .executeTakeFirst(),
        ),
    });
    // Disconnect and expiry share one durable cleanup; one pass at a time drives every open one.
    const connectionEffects = connectionCommandEffects({
      store,
      closeLineage: async (connectionId, minimumGrantRevision) => {
        if (minimumGrantRevision === undefined) {
          browser.closeStandardCdpForConnection(connectionId, "Agent connection authority ended.");
          await closeLegacyCdpForConnection(browser, connectionId, (bindingId) =>
            store.bindingAgentConnectionId(bindingId),
          );
        }
        await agentTools.closeLineage(connectionId, minimumGrantRevision);
      },
      stopper: {
        stopDirectOperation: (attempt) => agentSessions.stopDirectOperation(attempt.id),
        async stop(attempt, cleanup) {
          if (attempt.kind === "shared-chrome") {
            await chromeTabs.stopAttempt(attempt.id);
            return;
          }
          if (attempt.kind === "standard-cdp") {
            browser.stopStandardCdpAttempt(attempt.id);
            if (attempt.runnerId && attempt.standardCdpRecovery)
              return browser.reconcileConfinedStandardCdpAttempt(
                attempt.runnerId,
                attempt.standardCdpRecovery,
              );
            return;
          }
          if (attempt.kind === "plugin") {
            return pluginExecutions?.stopConnectionExecution(attempt.id, cleanup.connectionId);
          }
          if (
            attempt.kind !== "occurrence" &&
            attempt.kind !== "run-attempt" &&
            attempt.kind !== "watch"
          )
            return;
          if (!attempt.environmentId || attempt.generation === null) return;
          if (attempt.kind === "run-attempt")
            await drainLegacyRunCdp(browser, attempt.runId, attempt.generation);
          const identity = runners.identityForEnvironment(attempt.environmentId);
          if (!identity || identity.runnerId !== attempt.runnerId || !attempt.runnerBootId) return;
          if (identity.bootId !== attempt.runnerBootId) return "contact-lost";
          const supportsStop = identity.capabilities.includes(attemptStopStateCapability);
          if (attempt.kind === "watch" && !supportsStop) {
            watchService?.changed(attempt.environmentId);
            return;
          }
          if (
            attempt.kind === "occurrence" &&
            !identity.capabilities.includes(triggerStopGenerationCapability)
          )
            return;
          const stopId = store.connectionStopId(attempt);
          const stop = { id: stopId, bootId: attempt.runnerBootId };
          const base = {
            commandId: stopId,
            correlationId: CorrelationIdSchema.parse(stopId),
            environmentId: attempt.environmentId,
          };
          const receipt = await runners.dispatch(
            attempt.kind === "occurrence"
              ? {
                  ...base,
                  type: "trigger.interrupt",
                  occurrenceId: attempt.id,
                  executionGeneration: attempt.generation,
                  ...(supportsStop ? { stop } : {}),
                }
              : attempt.kind === "watch"
                ? {
                    ...base,
                    type: "watch.reconcile",
                    desired: [],
                    reconcileGeneration: 1,
                    stop: {
                      ...stop,
                      activationId: attempt.id,
                      executionGeneration: attempt.generation,
                    },
                  }
                : {
                    ...base,
                    type: "run.interrupt",
                    runId: attempt.runId,
                    threadId: attempt.threadId!,
                    bindingGeneration: attempt.generation,
                    ...(supportsStop ? { stop } : {}),
                  },
            AbortSignal.timeout(3_000),
            { connectionGeneration: identity.connectionGeneration },
          );
          if (supportsStop && (receipt.stopState === "ended" || receipt.stopState === "never-seen"))
            return "ended";
          return undefined;
        },
      },
      onFailure: (error, connectionId) =>
        app.log.warn({ err: error, connectionId }, "A connected agent's work did not stop"),
      afterStop: (connectionId, reason) =>
        agentSessions.closeConnection(connectionId, reason === "disconnect"),
    });
    const driveConnectionCleanups = () =>
      connectionEffects.driveCleanups().finally(() => connectionMaintenance?.wake());
    const commandRequestStore = new CommandRequestStore(store.database, store.requests);
    const commandRequests = (commandRequestsForTools = new CommandRequestService({
      store: commandRequestStore,
      database: store.database,
      requests: store.requests,
      // Where an automation's script would run on this Home's own computer (T4).
      homeKind: personalHomeKind(config),
    }));
    // An approval cut off by a restart may have taken effect: it is unknown, never run again.
    await commandRequestStore.recoverRunning();
    // A command that was acting outside the database when the Home stopped may have happened.
    await recoverCommandAttempts(store.database);
    const app = await createHostServer(
      {
        commandRequests,
        personReads: (handlers) => {
          personReadHandlers = handlers;
        },
        connections,
        connectionEffects: { stopLineage: driveConnectionCleanups },
        agentOperations: agentSessions,
        passkeys: config.passkeys === true,
        ...(notificationPreviews ? { notificationPreviews } : {}),
        attachments,
        assets: transcriptFileServices.assets,
        transcriptFiles: transcriptFileServices.files,
        runFiles: runFileRelay,
        apps,
        appOriginSigningKey: createHmac("sha256", config.authSecret)
          .update("opensteer-app-cookie-v1")
          .digest(),
        appRealOrigins: hostAppRealOrigins(config.exposure),
        trustedProxy: hostTrustedProxy(config),
        liveText,
        resourceRevisions,
        ...(options.onPersonalScopeCut ? { onPersonalScopeCut: options.onPersonalScopeCut } : {}),
        deviceAccess: deviceAccessService,
        machineFullDiskAccess,
        requestResponseVault: integrationVault,
        runToolTokens,
        agentTools,
        toolActivity,
        authenticator,
        browser,
        tabs,
        browserSources,
        passwordSignIns,
        signBrowserSourceInvitation: (bytes) =>
          sign(null, bytes, keys.privateKey).toString("base64url"),
        browserAttachPublicKeys,
        browserRelay,
        channels: { relay: messagingRelay, service: channels },
        commands,
        computerApps,
        deviceDrivers: {
          screenDriver: (id) => computerApps.screenDriverConnection(id),
          change: (input, commit) => changeDeviceDrivers({ store, computerApps }, input, commit),
        },
        computerUse,
        computerViews,
        displayStreams,
        placeContext,
        credentials,
        discovery: discoveryEnvelope,
        signHostProof: (bytes) => sign(null, bytes, keys.privateKey).toString("base64url"),
        egress,
        execution,
        harnessAuthenticationCoordinator,
        pluginRequests: pluginExecutions,
        pluginAgentWorkStoppedSince: (runnerId) =>
          pluginStopCoordinator.proofFor(runnerId, hostingComputerStopped()),
        plugins: pluginOwnerApi,
        pluginOAuth,
        integrations: {
          access: accessRequests,
          authAttempts: integrationAuthAttempts,
          continuations,
          definitions: deviceDefinitions,
          devices,
          listConnections,
          localServers,
          localServerRegistry,
          skills: plugins,
        },
        ...(localBootstrap ? { localBootstrap: { service: localBootstrap } } : {}),
        ...(personalRemoteAccess
          ? { personalRemoteAccess: { service: personalRemoteAccess } }
          : {}),
        ...(personalAccount ? { personalAccountLink: { service: personalAccount } } : {}),
        ...(managedHomeClaim ? { managedHomeClaim } : {}),
        ownerProfile,
        realtime,
        runnerAuthenticator,
        runners,
        shellControl: requiredService(shellHub, "Shell session hub"),
        ...(staticDistribution ? { staticDistribution: { service: staticDistribution } } : {}),
        ...(options.phoneUpdateRelease ? { phoneUpdateRelease: options.phoneUpdateRelease } : {}),
        store,
        triggers: {
          controlTokens: triggerControlTokens,
          service: triggers,
          watchBrowserTokens,
          watchScripts: new WatchScriptService({
            secrets: automationSecrets,
            store: triggerStore,
            tokens: watchControlTokens,
          }),
        },
      },
      options,
    );
    const attachmentGcTimer = setInterval(
      () => {
        void browser.pruneHistory();
        void attachments
          .collectGarbage()
          .catch((error: unknown) => app.log.warn({ err: error }, "Attachment cleanup failed"));
      },
      60 * 60 * 1_000,
    );
    attachmentGcTimer.unref();
    app.addHook("onClose", async () => clearInterval(attachmentGcTimer));
    app.addHook("onClose", async () => pluginStopCoordinator.close());
    if (directory) {
      app.addHook("onClose", async () => directory.close());
      await directory.start();
    }
    if (directory) {
      const directoryRefreshTimer = setInterval(() => void directory.refresh(), 30_000);
      directoryRefreshTimer.unref();
      app.addHook("onClose", async () => clearInterval(directoryRefreshTimer));
    }
    let recoveredAgentSessions = false;
    connectionMaintenance = new DeadlineDrain({
      onError: (error) => app.log.warn({ err: error }, "Connected agent cleanup failed"),
      drain: async () => {
        if (!recoveredAgentSessions) {
          await agentSessions.start();
          recoveredAgentSessions = true;
        }
        await connectionEffects.driveCleanups();
        return connectionStore.nextMaintenance(new Date(Date.now() + 30_000));
      },
    });
    app.addHook("onClose", async () => connectionMaintenance?.close());
    reportAgentSessionError = (error) =>
      app.log.warn({ err: error }, "A connected agent's direct work failed to settle");
    app.addHook("onClose", async () => {
      agentSessions.stop();
      await agentSessions.drain();
      await browserScripts.close();
    });
    // Work handed off before this process can no longer report: its outcome is unknown. Then a
    // cleanup interrupted by the last shutdown finishes, recording it as uncertain.
    connectionMaintenance.start();
    reportDispatchError = (error, commandId) =>
      app.log.warn({ err: error, commandId }, "Runner command dispatch failed");
    reportContinuationError = (error) => app.log.error({ err: error }, "Continuation failed");
    reportAutomationFailureError = (error) =>
      app.log.error({ err: error }, "Automation failure delivery failed");
    reportAssignmentReturnError = (assignmentId, error) =>
      app.log.error({ assignmentId, err: error }, "Task result could not be returned yet");
    reportShellError = (error) =>
      app.log.error({ err: error }, "Machine access notification failed");
    reportShellAuditError = (sessionId, error) =>
      app.log.warn({ err: error, sessionId }, "Machine access audit could not be recorded");
    reportShellControlError = (runnerId, error) =>
      app.log.warn({ err: error, runnerId }, "Machine access control stream failed");
    logMissingBrowserActor = (sessionId, bindingId) => {
      if (bindingId.startsWith("run:"))
        app.log.info({ sessionId, runId: bindingId.slice(4) }, "Browser Run has no actor");
    };
    logComputerLifecycle = (event, details) => app.log.info(details, event);
    reportHarnessAuthenticationNudgeError = (environmentId, error) =>
      app.log.warn(
        { environmentId, err: error },
        "Harness authentication could not be resumed after Runner registration",
      );
    reportUsageLimitInspectionError = (environmentId, error) =>
      app.log.warn(
        { environmentId, err: error },
        "Harness catalogs could not be re-read after a usage limit",
      );
    reportDuplicateRunUsage = (runId) =>
      app.log.warn({ runId }, "Run usage was already recorded; the later statement was dropped");
    reportHarnessCatalogConvergenceError = (error) =>
      app.log.warn({ err: error }, "AI model catalogs could not be refreshed; retrying");
    reportHarnessCatalogInvalidationError = (harnessInstanceId, error) =>
      app.log.warn(
        { err: error, harnessInstanceId },
        "Harness catalog could not be recaptured after preparation",
      );
    reportWatchReconciliationError = (environmentId, error) =>
      app.log.warn({ environmentId, err: error }, "Watch reconciliation failed");
    reportNotification = (level, failure) =>
      app.log[level](failure, "Notification publication dropped");
    reportComputerUseSweepError = (error) =>
      app.log.warn({ err: error }, "Computer use sweep failed");
    reportComputerUseTeardownError = (runId, error) =>
      app.log.error({ runId, err: error }, "Run computer-use teardown failed");
    reportBrowserSignInError = (error) =>
      app.log.warn({ err: error }, "Chrome sign-in delivery failed");
    reportOwnerProfileError = (error) =>
      app.log.warn({ err: error }, "Owner name refresh from the Opensteer Account failed");
    reportBrowserUsageError = (error) =>
      app.log.warn({ err: error }, "Browser usage recording failed");
    // The Account's copy of this Host's signed discovery envelope is what every
    // client verifies before it will route here, and only the Host can refresh
    // it. Re-assert it on every start, whichever way this Host reaches its
    // Account.
    const publishHostAuthority = personalAccount
      ? async () => {
          await personalAccount.publishAccountAuthority();
        }
      : undefined;
    const hostAuthorityPublisher = publishHostAuthority
      ? new HostAuthorityPublisher({
          onError: (error) => app.log.error({ err: error }, "Host authority publication failed"),
          publish: publishHostAuthority,
        })
      : undefined;
    memoryPasses.wake();
    await memoryPasses.idle();
    reconcileMemoryPasses = () => {
      if (!memoryPasses.settled) memoryPasses.wake();
    };
    void naming.reconcile().catch(reportThreadNamingError);
    await taskQuestions.reconcile();
    coordinator.start();
    continuations.start();
    automationFailures.start();
    quietTasks.start();
    let closed = false;
    let closingStep: string | undefined;
    hostAuthorityPublisher?.start();
    if (hostAuthorityPublisher)
      void hostAuthorityPublisher.ready().then(resolveNotificationAuthority);
    else resolveNotificationAuthority();
    idleCompactionService = new IdleCompactionService({
      list: (threadId) => idleCompactionCandidates(store.database, threadId),
      admit: async (candidate) => {
        const identity = runners.identityForEnvironment(candidate.environmentId);
        if (!identity?.capabilities.includes("claude-compaction-v1") || !candidate.contextSnapshot)
          return;
        const result = await admitIdleCompaction(store.database, {
          threadId: candidate.threadId,
          requestedBy: candidate.requestedBy,
          maintenance: {
            kind: "claude-compaction",
            reason: "idle",
            sourceRunId: candidate.contextSnapshot.sourceRunId,
            providerSessionId: candidate.providerSessionId,
          },
        });
        if (result) {
          coordinator.wake();
        }
      },
      onError: (error) => app.log.error({ err: error }, "Idle compaction failed"),
    });
    await idleCompactionService.start();
    const triggerScheduleLoop = new TriggerScheduleLoop({
      onChanged: () => realtime.publishTriggersChanged(),
      onError: (error) => app.log.error({ err: error }, "Trigger scheduling failed"),
      onInterruptFiring: (firing) => firingInterrupts?.interrupt(firing),
      onOccurrenceQueued: () => {
        coordinator.wake();
        realtime.publishTriggersChanged();
      },
      store: triggerStore,
    });
    wakeTriggerSchedules = () => triggerScheduleLoop.wake();
    triggerScheduleLoop.start();
    watchService.start();
    channels.start();
    await initializePersonal();
    assignmentReturns.start();
    await assignmentReturns.settled();
    const executionLeases = executionLeaseDrain(
      store,
      wakeExecutionCoordinator,
      (error) => app.log.error({ err: error }, "Execution lease sweep failed"),
      options.executionClock,
    );
    executionLeaseLoop = executionLeases;
    executionLeases.start();
    deadlines = new RequestDeadlines({
      ...(options.executionClock ? { clock: options.executionClock } : {}),
      next: async () => {
        const [stored, local] = [
          await store.requests.nextDeadline(),
          passwordSignIns.nextDeadline(),
        ];
        return !local || (stored && stored <= local) ? stored : local;
      },
      // Progress is what these sweeps settled, never another writer's commit.
      settle: (now) =>
        settleEach([
          () => passwordSignIns.settleDeadlines(),
          () => store.requests.expirePasswordSignIns(now),
          async () => (await store.expireThreadInputLeases()).settled,
          () => devices.computerAppApprovals.expireComputerAppSetupRequests(),
          () => localServers.requestLocalServerApprovals(),
        ]),
      onError: reportMutationFailure,
    });
    deadlines.start();
    await commitPersonalMutation(database, async () => undefined);

    return {
      kind: "personal",
      devices,
      localServers: localServerRegistry,
      computerApps,
      computerUse,
      computerViews,
      displayStreams,
      app,
      tabs: requiredService(tabs, "Tabs"),
      browser,
      notifications: notificationDispatcher,
      deployment,
      store,
      plugins: pluginService,
      pluginAgentSettings: pluginAgentStore,
      pluginRequests: pluginExecutions,
      pluginTools,
      pluginOAuth,
      authorityLost: authorityLease.lost,
      settleExecutionLeases: () => executionLeases.settled(),
      async close() {
        if (closed) return;
        closed = true;
        // Each awaited step names itself, so a shutdown that hangs says where.
        const failures: unknown[] = [];
        const step = async (label: string, stop: () => unknown) => {
          closingStep = label;
          try {
            await stop();
          } catch (error) {
            failures.push(error);
          }
        };
        const notificationsClosed = notificationDispatcher?.close().catch((error) => {
          failures.push(error);
        });
        await step("execution lease loop", () => executionLeases.close());
        await step("idle compaction", async () => {
          await idleCompactionService?.close();
        });
        await step("trigger schedule loop", () => triggerScheduleLoop.close());
        firingInterrupts?.close();
        await step("watch service", () => watchService?.close());
        await step("continuations", () => continuations.close());
        await step("automation failures", () => automationFailures.close());
        await step("host authority publisher", () => hostAuthorityPublisher?.close());
        await step("notifications", () => notificationsClosed);
        await step("channels", () => channels.close());
        messagingRelay.close();
        // Before the hub, so every live session is told to end rather than
        // finding its stream gone and being dropped in silence.
        computerViews?.shutdown();
        displayStreams?.close();
        await step("computer use", () => computerUse.shutdown());
        computerApps.close();
        deviceDrivers.close();
        tabs?.dispose();
        await step("agent tools", () => agentTools.close());
        await step("administration catalogs", () => administrationCatalogs?.close());
        await step("device services", async () => {
          await devices.close();
          await localServers.close();
        });
        await step("browser", () => browser.close());
        await step("password sign-ins", () => passwordSignIns.close());
        browserSources.close();
        savedLogins.close();
        runnerBrowsers.close();
        browserRelay.close();
        await step("shell hub", () => shellHub?.close());
        await step("AI model catalogs", () => catalogConvergence?.close());
        await step("runners", () => runners.close());
        await step("thread naming", () => naming!.stop());
        await step("quiet tasks", () => quietTasks.stop());
        await step("coordinator", () => coordinator.stop());
        await step("task questions", () => taskQuestions?.close());
        transcriptFileServices.close();
        liveText.close();
        refreshReturnHints.close();
        realtime.closeAll();
        await step("HTTP server", () => app.close());
        await step("admission", () => admission.close());
        await step("Run finishes", () => finishLoop?.close());
        await step("task result returns", () => assignmentReturns?.close());
        await step("memory passes", () => memoryPasses.close());
        await step("Request deadlines", () => deadlines?.close());
        removeMutationHooks?.();
        await step("plugin change notices", () => notices.close());
        await step("plugin engine", () => pluginService?.close());
        await step("plugin executions", () => pluginExecutions?.close());
        await step("authority lease", () => authorityLease?.close());
        await step("database", () => database.destroy());
        closingStep = undefined;
        if (failures.length) throw new AggregateError(failures, "Personal Host shutdown failed");
      },
      closingStep: () => {
        if (closingStep !== "database") return closingStep;
        const holders = databaseShutdownDetails(database);
        return holders ? `database (${holders})` : closingStep;
      },
      listen: () => app.listen({ host: config.bindAddress, port: config.port }),
    };
  } catch (error) {
    await pluginService?.close();
    await pluginExecutions?.close();
    await taskQuestions?.close();
    await administrationCatalogs?.close();
    await notificationDispatcher?.close();
    await executionLeaseLoop?.close();
    await finishLoop?.close();
    await assignmentReturns?.close();
    await connectionMaintenance?.close();
    await catalogConvergence?.close();
    await deadlines?.close();
    removeMutationHooks?.();
    await pluginChangeNotices?.close();
    await authorityLease?.close();
    await database.destroy();
    throw error;
  }
}

function requiredService<Value>(value: Value | undefined, label: string): Value {
  if (value === undefined) throw new Error(`${label} is not configured`);
  return value;
}

/**
 * Gives a work location one profile per driver the first time its Runner
 * advertises one, so a person who just attached a computer finds their existing
 * CLIs already listed instead of an empty settings page.
 *
 * "The first time" is load-bearing. Seeding reads tombstones as well as live
 * rows, because a removed profile is a decision: without that, retiring the
 * seeded profile only made it come back on the next reconnect, and there was no
 * way to say no permanently. A driver the Runner reports as unavailable is also
 * skipped — seeding a row that can only ever report an error helps nobody.
 */
export async function ensureDefaultHarnesses(
  store: Pick<OpensteerStore, "createHarnessInstance" | "listHarnessInstances">,
  environmentId: EnvironmentId,
  runner: {
    readonly harnessDrivers: readonly {
      readonly driverKind: string;
      readonly readiness?: string;
      readonly sources?: readonly {
        readonly sourceId: string;
        readonly stateKinds: readonly ("ambient" | "isolated")[];
      }[];
    }[];
    readonly providerStateModes: readonly ("ambient" | "isolated")[];
  },
): Promise<void> {
  const everExisted = await store.listHarnessInstances({
    environmentIds: [environmentId],
    includeRemoved: true,
  });
  for (const driver of runner.harnessDrivers) {
    if (driver.readiness === "unavailable") continue;
    // An account has to name a source, and only the engine can say which ones
    // it drives. A driver that declares none is one this Host cannot seed an
    // account for, so it waits rather than inventing an answer.
    const source = driver.sources?.[0];
    if (!source) continue;
    const sourceId = source.sourceId;
    // The person's own sign-in where this computer offers it: an engine that
    // runs the person's own install offers it only where that install is, so
    // a computer without one starts with an Opensteer-managed account instead.
    const stateKind = (["ambient", "isolated"] as const).find(
      (kind) => runner.providerStateModes.includes(kind) && source.stateKinds.includes(kind),
    );
    if (!stateKind) continue;
    if (
      everExisted.some(
        (instance) =>
          instance.driverKind === driver.driverKind &&
          (stateKind === "isolated" || instance.stateKind === "ambient"),
      )
    ) {
      continue;
    }
    // The seeded profile is simply the engine, under the name people know it
    // by from the CLI they installed. It carries no suffix because it is not a
    // variant of anything: a work location can hold several accounts of one
    // engine, and which of them is primary is `isDefault`, which the store
    // awards to the first profile of the pair.
    await store.createHarnessInstance({
      config: {},
      driverKind: HarnessIdSchema.parse(driver.driverKind),
      environmentId,
      name: harnessDriverLabel(driver.driverKind),
      sourceId,
      stateKind,
    });
  }
}

/**
 * Apps open on an origin of their own: `*.localhost` beside a loopback Host,
 * or a Remote access route's app hosts. A networked Home has no app address,
 * so its apps report themselves unavailable rather than open on its origin.
 */
export function hostAppRealOrigins(exposure: import("@opensteer/core").HostExposure): boolean {
  return hostExposurePolicy(exposure).personalRemoteAccess;
}

/**
 * The verified agent directory, read only from the Home's own Account origin. A Home with no
 * Account, or one that is not a public HTTPS origin, shows every agent as unverified.
 */
function agentDirectoryFor(issuer: URL | undefined, store: AgentConnectionStore) {
  if (!issuer || issuer.protocol !== "https:") return undefined;
  return new AgentDirectoryCache({
    issuer: new URL(issuer.origin),
    storage: {
      load: (origin) => store.loadDirectory(origin),
      accept: (origin, document) => store.acceptDirectory(origin, document),
    },
  });
}

function requirePluginRun(caller: import("../mcp/agent-caller.js").AgentCaller) {
  if (caller.kind !== "run")
    throw new OpensteerError({ code: "forbidden", message: "Plugin source requires a task Run." });
}
