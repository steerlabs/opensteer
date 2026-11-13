import { DeviceAccessService } from "../administration/device-access-service.js";
import { requireDeviceAccess } from "../administration/device-access.js";
import { digestSecret } from "@opensteer/shared/secretDigest";
import { PersonalTabStore } from "@opensteer/database";
import { resolveTeamTaskExecution } from "./team-task-execution.js";
import { ReconcileLoop, reconcileServices } from "./reconcile-loop.js";
import { TeamRunEvents } from "./team-run-events.js";
import { initializePersonalState } from "./personal-state.js";
import { createTeamHostRuntime } from "./team-runtime.js";
import { AgentHomeFiles } from "../threads/agent-home-files.js";
import { createPersonalTeamLinkServices } from "../team-links/index.js";
import {
  personalTeamRunPort,
  PersonalTeamAttachments,
} from "../attachments/personal-team-ports.js";
import { TaskAdmissionService } from "../threads/task-admission-service.js";
import {
  personalSettings,
  reportAgentHomeSkills,
  ensureDeployment,
  personalDeploymentOwner,
} from "@opensteer/database";
import { readPersonalResources } from "../browser/personal-snapshot.js";
import { deploymentPolicy } from "@opensteer/core";
import { RequestHold } from "../mcp/request-hold.js";
import { ThreadNaming } from "../agents/thread-naming.js";
import { QuietTasks } from "../threads/quiet-tasks.js";
import { AdministrationService } from "../administration/administration-service.js";
import { AdministrationToolHandlers } from "../mcp/handlers/administration.js";
import {
  HarnessCatalogReconciliationOwner,
  notifyingHarnessCatalogRecorder,
} from "../agents/harness-catalogs.js";
import { ThreadService } from "../threads/thread-service.js";
import { ConnectionOAuth } from "../mcp/connections/index.js";
import { AgentConnectionStore, recoverAssignmentResultWaits } from "@opensteer/database";
import { createHmac, randomUUID } from "node:crypto";
import { withFolderPluginPackage } from "../integrations/folder-plugin-package.js";
import { AppTunnelHub } from "../apps/app-tunnel-hub.js";
import {
  AesGcmSecretVault,
  AesGcmCredentialVault,
  createPublicHttpsFetch,
  StaticEncryptionKeyProvider,
} from "@opensteer/access/host";
import { assertHostConfigInvariants, type HostConfig } from "@opensteer/config";
import { createPluginChangeNotices, type PluginChangeNotices } from "./plugin-change-notices.js";
import { TaskQuestionNotices } from "../threads/task-question-notices.js";

import {
  harnessDriverLabel,
  HarnessIdSchema,
  OpensteerError,
  sameStringSet,
  type AgentEvent,
  type AssignmentId,
  type Deployment,
  type EnvironmentId,
  type RunId,
  type RunnerId,
  type UserId,
} from "@opensteer/core";
import {
  AccountDirectoryStore,
  acquireDeploymentAuthorityLease,
  AttachmentStore,
  AutomationFailureStore,
  BrowserSourceStore,
  BrowserTabGroupStore,
  ChannelStore,
  createDatabase,
  databaseShutdownDetails,
  IntegrationAuthAttemptStore,
  IntegrationPlatformStore,
  PluginSettingsStore,
  IntegrationStore,
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
import {
  createGraphqlAdapter,
  createMcpAdapter,
  createOpenApiAdapter,
} from "@opensteer/integration-adapters";
import { hostedOAuthDeploymentAuthorityDigest } from "@opensteer/integration-auth";
import { computerAppIntegrations, integrationDefinitions } from "@opensteer/integration-catalog";
import { listedDefinitionName } from "../integrations/catalog-presentation.js";
import {
  resolveIntegrationDeploymentPosture,
  type ComputerAppPlatform,
  type IntegrationConnectionId,
} from "@opensteer/integration-core";
import {
  CommandService,
  ExecutionCoordinator,
  KeyedAdmissionQueue,
  LiveRunRegistry,
  RealtimeHub,
  RunnerRegistry,
  type RunnerIdentity,
  type RunnerStreamLossReason,
} from "@opensteer/orchestration";
import {
  personalWebBuildId,
  type HarnessInstanceCatalog,
  type PendingAgentEvent,
  type RunnerAuxiliaryModule,
  type ShellSessionId,
} from "@opensteer/protocol";
import type { FastifyInstance } from "fastify";
import { sign } from "node:crypto";
import { resolve } from "node:path";
import { AccountAdoptionControlClient } from "../access/account-adoption-control-client.js";

import { AccountDirectoryClient } from "../access/account-directory-client.js";
import { AccountDirectoryPublisher } from "../access/account-directory-publisher.js";
import { HostAuthorityPublisher } from "../access/host-authority-publisher.js";
import { HostedOAuthBrokerClient } from "../access/hosted-oauth-broker-client.js";
import { RemotePersonalAccountGrantVerifier } from "../access/personal-account-grant-verifier.js";
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
  inspectAndRecordInvalidatedHarnessCatalog,
  inspectHarnessCatalogsAfterUsageLimit,
  reconcileAndRecordHarnessCatalogs,
  reconcileHarnessCatalogs,
} from "../agents/harness-catalogs.js";
import { RunCapabilityTokenService } from "../agents/run-capability.js";
import { RunnerAuthenticator } from "../agents/runner-authenticator.js";
import {
  AttachmentService,
  RunAttachmentsTokenService,
} from "../attachments/attachment-service.js";
import { RunFileRelay } from "../integrations/run-file-relay.js";
import { AppStore } from "@opensteer/database";
import { AppService } from "../apps/app-service.js";
import { BrowserLocalProfiles } from "../browser/browser-local-profiles.js";
import { announceBrowserUsage } from "../browser/browser-presence.js";
import { BrowserService } from "../browser/browser-service.js";
import { BrowserSourceService } from "../browser/browser-source-service.js";
import { BrowserTabGroupService } from "../browser/browser-tab-group-service.js";
import { BrowserAttachTicketSigner } from "../browser/browser-ticket.js";
import { PasswordSignInService } from "../browser/password-sign-in-service.js";
import { passwordsLoginSavedMessage } from "../browser/passwords-offers.js";
import { RunnerBrowserHub } from "../browser/runner-browser-hub.js";
import { RunnerBrowserRuntimeRouter } from "../browser/runner-browser-runtime.js";
import { ChannelService } from "../channels/channel-service.js";
import { MessagingRelayHub } from "../channels/messaging-relay-hub.js";
import { ComputerAppHub } from "../computer-apps/computer-app-hub.js";
import { ComputerUseService } from "../computer-use/computer-use-service.js";
import { ComputerViewService } from "../computer-use/computer-view-service.js";
import { PhoneTabs } from "../computer-use/phone-tabs.js";
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
import { resolveIntegrationAccountBinding } from "../integrations/integration-account-binding.js";
import { DefaultIntegrationAuthAttemptLifecycle } from "../integrations/integration-auth-attempt-service.js";
import { integrationCallSubject } from "../integrations/integration-call-subject.js";
import { IntegrationDashboardService } from "../integrations/integration-dashboard-service.js";
import { IntegrationPlatformService } from "../integrations/integration-platform-service.js";
import {
  IntegrationService,
  type IntegrationConnectionConnected,
} from "../integrations/integration-service.js";
import { PluginPackageService } from "../integrations/plugin-package-service.js";
import { IntegrationToolHandlers } from "../mcp/handlers/integrations.js";
import { McpOAuthService } from "../integrations/mcp-oauth-service.js";
import { NotificationDispatcher } from "../notifications/notification-dispatcher.js";
import { NotificationPreviewService } from "../notifications/notification-preview-service.js";
import {
  NotificationPublicationClient,
  type NotificationPublicationTarget,
} from "../notifications/notification-publication-client.js";
import { createHostServer } from "../server.js";
import { EgressService } from "../server/egress-service.js";
import { HostStaticDistribution } from "../server/static-distribution.js";
import {
  machineAccessNotifier,
  notifyComputerPresence,
  notifyMachinesChanged,
} from "../shell/machine-access-events.js";
import { MachineFullDiskAccessService } from "../shell/machine-full-disk-access-service.js";
import { ShellHub } from "../shell/shell-hub.js";
import { AutomationFailureService } from "../triggers/automation-failure-service.js";
import { TriggerControlTokenService } from "../triggers/trigger-control-service.js";
import { MemoryPassService } from "../agents/memory-pass-service.js";
import { TriggerScheduleLoop, TriggerService } from "../triggers/trigger-service.js";
import {
  WatchCapabilityTokenService,
  WatchControlTokenService,
} from "../triggers/watch-capability.js";
import { WatchProgramService } from "../triggers/watch-program-service.js";
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
 * A connection that gained authority settles Requests targeting the hosting
 * computer, and a settled Request wakes the continuation outbox so its agent
 * resumes now rather than on the next timer tick. The connection is durable
 * before this runs, so a failed settlement is reported, never surfaced as a
 * failed connection to the surface that finished the flow.
 */
export function integrationConnectionReaction(hooks: {
  readonly notify: () => void;
  readonly report: (error: unknown, connectionId: string) => void;
  readonly settle: (input: {
    readonly connectionId: IntegrationConnectionId;
    readonly ownerUserId: UserId;
  }) => Promise<readonly unknown[]>;
}): IntegrationConnectionConnected {
  return async (input) => {
    try {
      const fulfilled = await hooks.settle(input);
      if (fulfilled.length > 0) hooks.notify();
    } catch (error) {
      hooks.report(error, input.connectionId);
    }
  };
}

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
  readonly app: FastifyInstance;
  readonly browser: BrowserService;
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

export type HostRuntime = PersonalHostRuntime | TeamHostRuntime;
export interface TeamHostRuntime {
  readonly kind: "team";
  readonly app: FastifyInstance;
  readonly deployment: Deployment;
  readonly team: Awaited<ReturnType<typeof import("../team/services.js").startTeamServices>>;
  readonly authorityLost: Promise<Error>;
  close(): Promise<void>;
  closingStep(): string | undefined;
  listen(): Promise<string>;
}
export interface HostRuntimeOptions {
  readonly onDeploymentEvent?: (event: AgentEvent) => void;
  readonly executionClock?: import("@opensteer/shared/clock").Clock;
  /** Controls notification grace/backoff independently of Account transport. */
  readonly notificationTiming?: Pick<
    import("../notifications/notification-dispatcher.js").NotificationDispatcherOptions,
    "now" | "wait"
  >;
  /** Domain activity expiry and native coalescing; transport and browser deadlines stay on real time. */
  readonly browserActivityClock?: import("@opensteer/shared/clock").Clock;
  /** When periodic Personal reconciliation passes run; each pass's own work stays real. */
  readonly personalReconcileClock?: import("@opensteer/shared/clock").Clock;
  /** Observes a committed catalog capture; observer failures never affect Host work. */
  readonly onRunnerCatalogsCommitted?: (
    identity: RunnerIdentity,
    environmentId: EnvironmentId,
    catalogs: readonly HarnessInstanceCatalog[],
  ) => void;
  readonly phoneUpdateRelease?: () => AgentPhoneUpdateRelease | null;
  readonly accountControlFetch?: typeof globalThis.fetch;
  readonly accountDirectoryFetch?: typeof globalThis.fetch;
  readonly accountDirectoryIntervalMs?: number;
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
  });
  let administrationCatalogs: HarnessCatalogReconciliationOwner | undefined;
  let authorityLease: DeploymentAuthorityLease | undefined;
  let notificationDispatcher: NotificationDispatcher | undefined;
  let threadStateLoop: ReconcileLoop | undefined;
  let threadStateDrain: Promise<void> | undefined;
  let threadStateStopped = false;
  let taskQuestions: TaskQuestionNotices | undefined;
  let pluginChangeNotices: PluginChangeNotices | undefined;
  try {
    authorityLease = await acquireDeploymentAuthorityLease(database);
    await migrateToLatest(database).catch((error: unknown) => {
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
    if (deploymentPolicy(config.deploymentShape).services.team) {
      return await createTeamHostRuntime({
        config,
        options,
        database,
        deployment,
        keys,
        hostKeyFingerprint,
        authorityLease,
      });
    }
    const personalConfig = config.personal!;
    let teamRunEvents: TeamRunEvents | undefined;
    let linkServices: ReturnType<typeof createPersonalTeamLinkServices> | undefined;
    let linkStarting: Promise<ReturnType<typeof createPersonalTeamLinkServices>> | undefined;
    let initializedPersonal: Awaited<ReturnType<typeof initializePersonalState>> = null;
    let initializingPersonal:
      Promise<Awaited<ReturnType<typeof initializePersonalState>>> | undefined;
    const initializePersonal = async () => {
      if (initializedPersonal) return initializedPersonal;
      initializingPersonal ??= initializePersonalState(database, personalConfig, realtime)
        .then((execution) => (initializedPersonal = execution))
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
      environmentFor: async (ownerId: UserId) =>
        (await personalExecution()).environmentFor(ownerId),
    };
    await recoverAssignmentResultWaits(database);
    // Only the Host knows the origin its own web app answers on, so it is the
    // Host that teaches the store how to name a Thread in a channel message.
    const store = new OpensteerStore(database, {
      ...(options.executionClock ? { executionClock: options.executionClock } : {}),
      links: { threadUrl: (threadId) => `${config.canonicalOrigin.origin}/tasks/${threadId}` },
      readPersonalResources: (input) =>
        readPersonalResources(input, () => runnerBrowsers.placements()),
    });
    // What active Runs are streaming, held only in memory; it learns each Run
    // from that Run's committed durable events and forgets it at the terminal.
    const liveRuns = new LiveRunRegistry();
    const realtime = new RealtimeHub({ liveRuns, store });
    const harnessCatalogs = {
      ...notifyingHarnessCatalogRecorder(store, realtime),
      listHarnessInstances: store.listHarnessInstances.bind(store),
      listHarnessCatalogs: store.listHarnessCatalogs.bind(store),
    };
    const pluginSettings = new PluginSettingsStore(database);
    const notices = createPluginChangeNotices(
      (target) => pluginSettings.affectedViewers(target),
      (viewers) => realtime.sendToUsers(viewers, { type: "host.plugins-changed" }),
    );
    pluginChangeNotices = notices;
    const connections = new ConnectionOAuth({
      deploymentId: deployment.id,
      store: new AgentConnectionStore(database),
      signingKey: keys.privateKey,
      verificationKey: keys.publicKey,
    });
    const triggerStore = new TriggerStore(database);
    const accountDirectoryStore = new AccountDirectoryStore(database);
    const localSetupToken = config.identity.localOwnerClaimToken!;
    const initialOwnerEnrollment = {
      expiresAt: new Date(Date.now() + localSetupEnrollmentLifetimeMilliseconds),
      renewable: true,
      tokenDigest: digestSecret(localSetupToken),
    };
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
              email: "owner@personal.opensteer.invalid",
            },
          }
        : {}),
      hostKeyFingerprint,
      ...(config.identity.nativeOAuth
        ? { nativeOAuth: { clients: config.identity.nativeOAuth.clients } }
        : {}),
      oidcProviders: [],
      exposure: config.exposure,
      ...(config.portalOrigin ? { portalOrigin: config.portalOrigin } : {}),
      publicOrigin: config.canonicalOrigin,
      secret: config.authSecret,
      signupPolicy: config.identity.signupPolicy,
    });
    await identity.initialize();
    // The Runner registry is built further down, once the services its hooks
    // need exist. Everything above that reaches it only while a request is in
    // flight, so those callers address it through this indirection rather than
    // forcing the whole composition order to change.
    let runnerRegistry: RunnerRegistry | undefined;
    const runFileRelay = new RunFileRelay();
    let disconnectBrowserSources = () => {};
    const personalAccessAuthority =
      deploymentPolicy(config.deploymentShape).personalRemoteAccess &&
      config.exposure === "loopback"
        ? hostAuthority
        : undefined;
    const personalRemoteAccess = personalAccessAuthority
      ? new PersonalRemoteAccessService({
          authority: personalAccessAuthority,
          database,
          // Every computer somebody lent this Deployment reached it over the
          // route that just changed, so none of their connections survives it.
          // Its hosting Runner and the messaging service beside it never
          // travelled that route.
          disconnectRunners: async () => {
            await runnerRegistry?.disconnectRouteAdmittedRunners("Remote access was reconfigured");
            disconnectBrowserSources();
          },
          ...(config.personalAccountIssuer
            ? {
                grantVerifier: new RemotePersonalAccountGrantVerifier({
                  audience: config.canonicalOrigin.origin,
                  ...(options.personalAccountGrantFetch
                    ? { fetch: options.personalAccountGrantFetch }
                    : {}),
                  issuer: config.personalAccountIssuer,
                }),
              }
            : {}),
          ...(options.accountDirectoryFetch ? { fetch: options.accountDirectoryFetch } : {}),
          identity,
          keys,
        })
      : undefined;
    await personalRemoteAccess?.purgeExpiredAccountLinkKeys();
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
    let phoneTabs: PhoneTabs | undefined;
    let displayStreams: DisplayStreamHub | undefined;
    let pluginPackages: PluginPackageService | undefined;
    const computerApps = new ComputerAppHub({
      requireAgentAccess: (runnerId) =>
        requireDeviceAccess(database, runnerId, "apps", runners.isRunnerConnected(runnerId)),
      packageSource: (serverId, runnerId, launch) =>
        pluginPackages?.computerSource(serverId, runnerId, launch),
      knownDefinitionIds: () => computerAppDefinitionIds,
      onPhoneDisplayCapability: (status) =>
        app.log.info(status, "Phone display capability changed"),
      onChanged: (runnerId) => {
        notifyMachinesChanged(realtime, "computer-apps.status");
        notices.notify({ runnerId });
      },
      onComputerUseEvent: (runnerId, event) => computerUse?.handleHelperEvent(runnerId, event),
      onRunnerDetached: (runnerId, reason) => {
        computerViews?.disconnect(runnerId);
        displayStreams?.forgetRunner(runnerId, reason);
        computerUse?.forgetRunner(runnerId);
      },
      onDisplayEvent: (runnerId, event) => displayStreams?.handlePhoneEvent(runnerId, event),
      onPluginDataRemoved: (runnerId, pluginId) =>
        integrationPlatform.store.plugins.confirmDataRemoval(runnerId, pluginId),
      onRunnerAttached: (runnerId) => integrationPlatform.computerRunnerAttached(runnerId),
    });
    computerUse = new ComputerUseService({
      deploymentId: deployment.id,
      onSessionEnded: (sessionId) => displayStreams?.endSession(sessionId),
      onPhoneHeld: (runnerId) => phoneTabs?.opened(runnerId),
      onAuthorityRevoked: ({ runId, bindingGeneration }) =>
        integrationPlatform.resetComputerGeneration(runId, bindingGeneration),
      // The same minute tick that ends idle sessions settles the approvals
      // nobody answered; `integrationPlatform` exists long before it fires.
      // A server a computer runs keeps waiting for its approval: an expired
      // ask is asked again rather than left with nothing to answer.
      expireSetupRequests: async () => {
        await integrationPlatform.computerAppApprovals.expireComputerAppSetupRequests();
        await integrationPlatform.requestLocalServerApprovals();
      },
      hub: computerApps,
      loginReceiver: (runnerId) => computerApps.loginReceiver(runnerId),
      passwords: {
        validateLease: (input) => passwordSignIns.validateLease(input),
        seal: (input) => passwordSignIns.seal(input),
      },
      // Every computer serving computer apps, Mac or phone; which definitions
      // each serves is the catalog's to say, by the platform it reports.
      listMachines: async (ownerId) => {
        const machines: { name: string; platform: ComputerAppPlatform; runnerId: RunnerId }[] = [];
        let after: RunnerId | undefined;
        do {
          const page = await store.listRunners({
            ownerId,
            includeDeployment: true,
            limit: 100,
            ...(after ? { after } : {}),
          });
          for (const runner of page.runners) {
            const platform = runner.moduleDescriptors.integrations?.platform;
            if (runner.revokedAt === null && platform !== undefined)
              machines.push({ name: runner.name, platform, runnerId: runner.id });
          }
          after = page.nextCursor ?? undefined;
        } while (after);
        return machines;
      },
      machineOwners: (runnerIds) => store.effectiveMachineOwners(runnerIds),
      // A live session is a row on the machines list and a card in its Thread,
      // so opening, closing, gaining an app or acting is a change to publish.
      onError: (error) => reportComputerUseSweepError(error),
      onSessionsChanged: () => notifyMachinesChanged(realtime, "computer-use.sessions"),
      onPresenceChanged: (ownerUserId, sessions) =>
        notifyComputerPresence(realtime, ownerUserId, sessions),
      authorizer: store,
      stops: {
        clear: (runId) => store.clearComputerUseStops(runId),
        initial: await store.activeComputerUseStops(),
        record: (runId, runnerId) => store.recordComputerUseStop({ runId, runnerId }),
      },
      beginPlaceEntry: (runId, generation) => browser.beginRunPlace(runId, generation),
      onPlaceActivity: (input) => browser.noteNativeActivity(input),
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
        const profile = await database
          .selectFrom("browserProfiles")
          .select("ownerId")
          .where("id", "=", profileId)
          .executeTakeFirstOrThrow();
        realtime.publishBrowserSessionsChanged([profile.ownerId], "browser.profile-reconciled");
      },
    });
    const runnerBrowsers = new RunnerBrowserRuntimeRouter({
      registry: browserRelay,
      localProfiles,
      onDeletionsChanged: async (runnerId) => {
        const owners = await database
          .selectFrom("browserProfileDeletions as deletion")
          .innerJoin("browserProfiles as profile", "profile.id", "deletion.profileId")
          .select("profile.ownerId")
          .distinct()
          .where("deletion.runnerId", "=", runnerId)
          .execute();
        realtime.publishBrowserSessionsChanged(
          owners.map(({ ownerId }) => ownerId),
          "browser.profile-deletions",
        );
      },
    });
    let reportBrowserPresenceError: (error: unknown) => void = (error) => {
      console.warn("Browser presence delivery failed", error);
    };
    let reportBrowserUsageError: (error: unknown) => void = (error) => {
      console.warn("Browser usage recording failed", error);
    };
    const browserTabGroups = new BrowserTabGroupStore(database);
    let logMissingBrowserActor: (sessionId: string, bindingId: string) => void = () => undefined;
    const browser = new BrowserService({
      requireAgentAccess: (runnerId) =>
        requireDeviceAccess(database, runnerId, "browser", runners.isRunnerConnected(runnerId)),
      detachRunnerAgents: async (runnerId) => {
        const sessions = await database
          .selectFrom("browserSessions")
          .select("id")
          .where("runnerId", "=", runnerId)
          .execute();
        if (!sessions.length) return [];
        await database
          .deleteFrom("browserSessionAttachments")
          .where(
            "sessionId",
            "in",
            sessions.map((row) => row.id),
          )
          .execute();
        return sessions.map((row) => row.id);
      },
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
      passkeyOwnOrigins: () => [
        config.canonicalOrigin.origin,
        ...(config.account ? [config.account.issuer.origin] : []),
      ],
      ...(options.browserActivityClock ? { activityClock: options.browserActivityClock } : {}),
      onHistoryChanged: (ownerId, profileId) =>
        realtime.sendToUsers([ownerId], { type: "host.browser-history-changed", profileId }),
      onProfilesChanged: (ownerId) =>
        realtime.publishBrowserSessionsChanged([ownerId], "browser.profiles"),
      tabGroups: browserTabGroups,
      personalTabs: new PersonalTabStore(database),
      onPlaceNotice: (ownerId, notice) => realtime.sendToUsers([ownerId], notice),
      onSessionsChanged: (sessionIds, source) => {
        // Catalog visibility is viewer-wide, independent of socket subscriptions.
        void Promise.all(sessionIds.map((sessionId) => store.listBrowserSessionViewers(sessionId)))
          .then((sessions) =>
            realtime.publishBrowserSessionsChanged(
              [...new Set(sessions.flatMap((session) => session?.userIds ?? []))],
              source,
            ),
          )
          .catch((error: unknown) => reportBrowserPresenceError(error));
      },
      onUsageChanged: (credits) => announceBrowserUsage(realtime, credits),
      onError: (error) => reportBrowserUsageError(error),
      onDeploymentEvent: (event) => publishDeploymentEvent(event),
      repository: store,
      signer: new BrowserAttachTicketSigner({
        keyId: browserAttachKeyId,
        privateKey: keys.privateKey,
      }),
      targetResolver: runnerBrowsers,
    });
    closeBrowserSession = (sessionId) => browser.closeAuthSession(sessionId);
    let reportBrowserSignInError: (error: unknown) => void = () => undefined;
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
      onPendingBrowserPins: (key, pins) => browser.setRequestPins(key, pins),
      onRequestResolved: () => notifyIntegrationContinuations(),
      onDeploymentEvent: (event) => publishDeploymentEvent(event),
      requests: store.requests,
    });
    browser.setLoginLeaseValidator((input) =>
      passwordSignIns.validateLease({ ...input, deploymentId: deployment.id }),
    );
    const browserSources = new BrowserSourceService({
      deploymentId: deployment.id,
      browser,
      canonicalOrigin: config.canonicalOrigin.origin,
      currentRoute: async () => (await personalRemoteAccess?.status())?.route ?? null,
      sign: (bytes) => sign(null, bytes, keys.privateKey).toString("base64url"),
      store: new BrowserSourceStore(database),
      requests: store.requests,
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
      onRequestResolved: () => notifyIntegrationContinuations(),
      onDeploymentEvent: (event) => publishDeploymentEvent(event),
      passwords: passwordSignIns,
      stoppedByPerson: (threadId) => store.latestRunStoppedByPerson(threadId),
    });
    disconnectBrowserSources = () => browserSources.disconnectRouteAdmittedSources();
    const credentialKey = await loadOrCreateCredentialKey({
      dataDirectory,
      ...(config.credentialKeyPath ? { keyPath: config.credentialKeyPath } : {}),
    });
    const integrationKeys = new StaticEncryptionKeyProvider(new Map([[1, credentialKey]]), 1);
    const teamLinkVault = new AesGcmCredentialVault(integrationKeys);
    const integrationVault = new AesGcmSecretVault(
      new StaticEncryptionKeyProvider(new Map([[1, credentialKey]]), 1),
    );
    const credentials = new CredentialService({ key: credentialKey, store });
    credentialKey.fill(0);
    await credentials.initialize();
    const integrationAuthAttempts = new DefaultIntegrationAuthAttemptLifecycle({
      store: new IntegrationAuthAttemptStore(database),
      vault: integrationVault,
    });
    const integrationFetchBase = options.integrationFetch ?? createPublicHttpsFetch();
    const integrationFetch: typeof fetch = (target, init) =>
      integrationFetchBase(target, { ...init, redirect: "manual" });
    const integrationAdapters = [
      createGraphqlAdapter(integrationFetch),
      createMcpAdapter(integrationFetch),
      createOpenApiAdapter(integrationFetch),
    ];
    const integrationAccountSubject = (ownerUserId: UserId) =>
      resolveIntegrationAccountBinding({
        database,
        ownerUserId,
      });
    const integrationDeploymentPosture = async () =>
      resolveIntegrationDeploymentPosture({
        personalAccountLinked:
          (await database
            .selectFrom("personalRemoteAccountLink")
            .select("singletonKey")
            .where("state", "=", "active")
            .executeTakeFirst()) !== undefined,
      });
    const hostedOAuthBrokerIssuer = config.personalAccountIssuer ?? config.account?.issuer;
    const hostedOAuthBroker = hostedOAuthBrokerIssuer
      ? {
          kind: "personal" as const,
          accountSubject: integrationAccountSubject,
          broker: new HostedOAuthBrokerClient({
            ...(options.accountControlFetch ? { fetch: options.accountControlFetch } : {}),
            hostCredential: async () => {
              if (config.account) return config.account.hostCredential;
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
            ...(config.account ? { serviceOrigin: config.account.controlApiOrigin } : {}),
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
    const integrationStore = new IntegrationStore(database);
    let logComputerLifecycle = (event: string, details: Readonly<Record<string, unknown>>) =>
      console.info(event, details);
    computerViews = new ComputerViewService({
      onPhoneView: (status) => {
        app.log.info(status, "Phone owner view command");
        if (status.operation === "computer.view.open" && status.viewId !== null)
          phoneTabs?.opened(
            status.machineId,
            () => computerViews?.holdsPhoneView(status.machineId) ?? false,
          );
      },
      hub: computerApps,
      connections: (ownerId) => integrationStore.listConnections(ownerId),
      owners: (ids) => store.effectiveMachineOwners(ids),
      changed: (ownerId, notice) => {
        if (notice.type === "host.computer-view.removed")
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
      },
      log: (event, details) => logComputerLifecycle(event, details),
      ended: (viewId, generation, reason) =>
        displayStreams?.endOwnerView(viewId, generation, reason),
    });
    phoneTabs = new PhoneTabs({
      store,
      heldByTask: (machine) =>
        computerUse?.sessionsForRunner(machine).some(({ display }) => display) ?? false,
      closeViews: (owner, machine) => computerViews?.closePhoneViews(owner, machine),
      changed: () => notifyMachinesChanged(realtime, "phone-tab"),
      onError: (error) => reportComputerUseSweepError(error),
    });
    // A connection gaining authority settles Requests targeting the hosting
    // computer and resumes their agents. The reaction is bound once the platform
    // and the continuation outbox exist; both services signal into it from
    // every flow that completes a connection.
    let integrationConnectionConnected: IntegrationConnectionConnected = async () => {
      throw new Error("Integration connection reaction is not wired");
    };
    let notifyIntegrationContinuations = (): void => undefined;
    const integrations = new IntegrationService({
      adapters: integrationAdapters,
      attempts: integrationAuthAttempts,
      definitions: integrationDefinitions,
      deploymentPosture: integrationDeploymentPosture,
      fetch: integrationFetch,
      ...(hostedOAuthBroker ? { hostedOAuth: hostedOAuthBroker } : {}),
      installedDefinition: (definitionId, options) =>
        integrationPlatformStore.installations.findInstalledDefinition(definitionId, options),
      onConnectionConnected: (input) => integrationConnectionConnected(input),
      publicUrl: config.canonicalOrigin,
      onConnectionChanged: (owner) =>
        realtime.sendToUsers([owner], { type: "host.plugins-changed" }),
      repository: integrationStore,
      vault: integrationVault,
    });
    const mcpOauth = new McpOAuthService({
      ...(hostedOAuthBroker ? { hostedOAuth: hostedOAuthBroker } : {}),
      deploymentPosture: integrationDeploymentPosture,
      attempts: integrationAuthAttempts,
      exposure: config.exposure,
      onConnectionConnected: (input) => integrationConnectionConnected(input),
      publicUrl: config.canonicalOrigin,
      store: integrationPlatformStore,
      vault: integrationVault,
    });
    const files = new AgentHomeFiles({
      agentHome: async () => (await personalExecution()).options.agentHome,
      helperPath: personalConfig.nativeFsHelperPath,
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
    let reportIntegrationCallSubjectError: (event: PendingAgentEvent, error: unknown) => void = (
      event,
      error,
    ) => {
      console.warn(
        "An integration call's subject could not be resolved; it was recorded without one",
        event.runId,
        error,
      );
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
    // through: an attached server Host, or a Personal Host whose owner has
    // linked one.
    const accountAttachment = config.account;
    const personalAccountIssuer = config.personalAccountIssuer;
    const notificationTarget: (() => Promise<NotificationPublicationTarget | null>) | undefined =
      accountAttachment
        ? () =>
            Promise.resolve({
              controlApiOrigin: accountAttachment.controlApiOrigin,
              hostCredential: accountAttachment.hostCredential,
            })
        : personalRemoteAccess && personalAccountIssuer
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
    const notificationIssuer = accountAttachment?.issuer ?? personalAccountIssuer;
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
    const onTerminalRun = terminalRunReaction({
      // A session belongs to the Run that opened it and is never resumed, so
      // the Mac is told to end it and take its pill down the moment the Run
      // is over.
      closeComputerUseSessions: (runId) => {
        computerUse?.closeForRun(runId);
        integrationPlatform
          .endComputerRun(runId)
          .catch((error: unknown) => reportComputerUseTeardownError(runId, error));
      },
      detachBrowserSessions: (bindingId) => browser.detachAgentSessionsForBinding(bindingId),
      // A Run that has ended has no authority left to lend, so the sessions it
      // opened on other computers end with it.
      endShellSessions: (runId) =>
        shellHub?.endRunSessions(runId, "run-ended") ?? Promise.resolve(),
    });
    // Stop, a restart and a cancelled Assignment take a Run's authority before
    // its Runner reports an end, so what the grant admitted ends here instead.
    // Shell audit keeps its existing `run-ended` reason; computer-use cleanup
    // closes the exact session without adding a wire reason.
    store.onRunGrantsRevoked((grants) => {
      browser.endRevokedRunActors(grants);
      computerUse?.endGrantSessions(grants);
      for (const grant of grants)
        integrationPlatform.endComputerGeneration(grant.runId, grant.bindingGeneration);
      void shellHub?.endGrantSessions(grants, "run-ended").catch(() => undefined);
    });
    const onAssignmentReturn = assignmentReturnReaction({
      deliver: (assignmentId) => store.drainAssignmentReturn(assignmentId),
      onError: (assignmentId, error) => reportAssignmentReturnError(assignmentId, error),
      publish: (event) => publishDeploymentEvent(event),
    });
    let threadStateRequested = false;
    const drainThreadStates = (): Promise<void> => {
      if (threadStateStopped) return Promise.resolve();
      threadStateRequested = true;
      if (!threadStateDrain) {
        threadStateDrain = (async () => {
          try {
            while (threadStateRequested) {
              threadStateRequested = false;
              await store.drainPendingThreadStates((events) => {
                for (const event of events) publishDeploymentEvent(event);
              });
            }
          } finally {
            threadStateDrain = undefined;
          }
        })();
      }
      return threadStateDrain;
    };
    let observeIntegrationInput: ((event: AgentEvent) => void) | undefined;
    const publishDeploymentEvent = (event: AgentEvent): void => {
      try {
        options.onDeploymentEvent?.(event);
      } catch {
        /* Observers cannot interrupt committed event publication. */
      }
      taskQuestions?.observe(event);
      teamRunEvents?.observe(event);
      observeIntegrationInput?.(event);
      if (
        (event.type === "request.opened" || event.type === "request.resolved") &&
        "request" in event.data
      )
        browser.observeRequest(event.data.request);
      if (event.type === "thread.listed" || event.type === "assignment.updated")
        browser.invalidatePlaceAuthority(
          event.type === "thread.listed"
            ? [event.data.thread.id]
            : event.type === "assignment.updated"
              ? [event.data.assignment.parentThreadId, event.data.assignment.workerThread.id]
              : undefined,
        );
      if (event.type === "place.entered")
        app.log.info({ runId: event.runId, threadId: event.threadId }, "place.entered");
      liveRuns.observeCommitted([event]);
      realtime.publish(event);
      onTerminalRun(event);
      onAssignmentReturn(event);
      notificationDispatcher?.dispatch(event);
      // Request publishers run after commit. Coalescing still schedules another
      // pass if a Request arrives while the current candidate set is draining.
      if (event.type.startsWith("request.")) {
        const requestId =
          "request" in event.data
            ? event.data.request.id
            : "requestId" in event.data
              ? event.data.requestId
              : undefined;
        if (requestId) notices.notify({ requestId });
        void drainThreadStates().catch((error: unknown) =>
          console.warn("Thread state drain failed", error),
        );
      }
    };
    await browser.initialize();
    await passwordSignIns.sweepAfterRestart();
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
    const integrationPlatform = new IntegrationPlatformService({
      longRequestHold: (run) => longRequestHold(run.runId),
      personal: true,
      adapters: integrationAdapters,
      secretVault: integrationVault,
      listConnections: (ownerUserId) => integrationStore.listConnections(ownerUserId),
      authorizationSource: integrations,
      computerApps,
      computerUse,
      credentialMaterializer: integrations,
      dataDirectory,
      definitions: integrationDefinitions,
      isRunnerConnected: (runnerId) =>
        requiredService(runnerRegistry, "Runner registry").isRunnerConnected(runnerId),
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
      mcpOauth,
      onInputAccessWithdrawn: (runnerId) => displayStreams?.withdrawOwnerInput(runnerId),
      onConnectionsChanged: () => {
        void computerViews
          ?.revalidate()
          .catch((error: unknown) => reportComputerUseSweepError(error));
        notifyMachinesChanged(realtime, "integration.connections");
        void channelService?.syncRuntimes();
      },
      onSettingsChanged: async ({ installationId, ownerUserId }) => {
        if (ownerUserId) realtime.sendToUsers([ownerUserId], { type: "host.plugins-changed" });
        else notices.notify(installationId ? { installationId } : {});
      },
      onRequestsChanged: () => notifyIntegrationContinuations(),
      onDeploymentEvent: publishDeploymentEvent,
      ...(options.integrationFetch ? { publicFetch: options.integrationFetch } : {}),
      store: integrationPlatformStore,
    });
    observeIntegrationInput = (event) => integrationPlatform.inputRequests.observe(event);
    // Before accepting installs: their data folder can precede the plugin transaction.
    await integrationPlatform.recoverPluginData();
    await integrationPlatform.inputRequests.recover();
    for (const event of await integrationPlatformStore.computerOperations.finalize())
      publishDeploymentEvent(event);
    const integrationDashboard = new IntegrationDashboardService({
      definitions: integrationDefinitions,
      // A person reads the listing's name; the stored definition keeps its own.
      summarizeDefinition: (definition) => ({
        ...integrationPlatform.definitionSummary(definition),
        name: listedDefinitionName(definition),
      }),
      providers: integrations,
      repository: integrationPlatformStore,
    });
    await integrationPlatform.backfillApiKeyDisclosures();
    await integrationPlatform.bindOpenApiTools();
    await integrationPlatform.ensureBuiltIns({
      actorUserId: null,
      requestId: "startup:ensure-built-in-integrations",
    });
    await integrationPlatform.requestLocalServerApprovals();
    for (const event of await store.recoverThreadWorkQueues()) publishDeploymentEvent(event);
    await store.restartExecutionLeases(new Date(executionNow() + config.executionLeaseMs));
    // Runs outlive a Host restart on their leases and continue when their
    // Runners attach again; only the controls the last Host left in flight
    // need settling before this one dispatches anything.
    for (const event of await store.recoverCommandsAfterHostRestart()) {
      publishDeploymentEvent(event);
    }
    // No shell session survives a Host epoch, and this runs long before the
    // routes exist: a row left open by the previous Host would otherwise hold
    // capacity for a session whose sockets went with that process.
    await drainThreadStates();
    await store.endAllOpenShellSessions("host-shutdown");
    await triggerStore.failActiveAfterHostRestart();
    let wakeExecutionCoordinator = (): void => undefined;
    let dispatchingRunIds = (): readonly RunId[] => [];
    let watchService: WatchService | undefined;
    const registeringRunners = new Set<string>();
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
        onShellFullDiskAccess: async (identity, value) => {
          await store.setRunnerShellFullDiskAccess(identity.runnerId, value);
          notifyMachinesChanged(realtime, "runner.shell-access");
          if (value) await machineFullDiskAccess.fulfillForMachine(identity.runnerId);
        },
        authorize: async (identity) => authorizeRunnerRegistration(store, identity),
        onEvent: async (identity, event) => {
          const integration = await integrationCallSubject(
            {
              listCallableTools: (input) => integrationPlatform.listCallableTools(input),
              getComputerConnectionForCall: (input) =>
                integrationPlatformStore.getComputerConnectionForCall(input),
              onError: (error, failed) => reportIntegrationCallSubjectError(failed, error),
              runRequester: (input) => store.runRequester(input),
            },
            event,
          );
          if (["run.completed", "run.failed", "run.interrupted"].includes(event.type)) {
            await browser.drainRunPlaces(event.runId);
          }
          const committed = await store.commitRunnerEvent({
            environmentId: event.environmentId,
            event,
            ...(integration ? { integration } : {}),
            runnerBootId: identity.bootId,
            runnerId: identity.runnerId,
          });
          if (committed.duplicateRunUsage) reportDuplicateRunUsage(event.runId);
          // Progress that follows this event follows the whole transaction,
          // including what the commit added beside it, such as input receipts.
          if (!committed.wasDuplicate) {
            liveRuns.observeCommitted([committed.event, ...committed.compensatingEvents]);
          }
          if (!committed.wasDuplicate) {
            publishDeploymentEvent(committed.event);
            if (
              ["run.completed", "run.failed", "run.interrupted"].includes(committed.event.type) ||
              (committed.event.type === "run.phase" && committed.event.data.phase === "background")
            )
              notifyIntegrationContinuations();
          }
          // A restart queued the Run's next attempt.
          if (committed.event.type === "run.restarted") wakeExecutionCoordinator();
          for (const compensating of committed.compensatingEvents) {
            publishDeploymentEvent(compensating);
          }
          // Evidence about an account's capacity, not part of delivering the
          // event: the Runner is answered as soon as the event is committed and
          // the re-read runs on its own, bounded, clock.
          if (!committed.wasDuplicate) {
            void inspectHarnessCatalogsAfterUsageLimit({
              catalogs: harnessCatalogs,
              event: committed.event,
              runners,
              signal: AbortSignal.timeout(30_000),
            }).catch((error: unknown) => {
              reportUsageLimitInspectionError(committed.event.environmentId, error);
            });
          }
        },
        onEventRefused: async (identity, event, refusal) => {
          // This may end the Run, and a place left pending would then be refused.
          await browser.drainRunPlaces(event.runId);
          const events = await store.failRunForRefusedRunnerEvent({
            bindingGeneration: event.bindingGeneration,
            message: refusal.message,
            runId: event.runId,
            runnerBootId: identity.bootId,
            runnerId: identity.runnerId,
          });
          // A Run this binding no longer holds is left exactly as it is: its
          // owner's live streams included. A finalized Run's terminal event
          // clears its streams when it is published.
          for (const terminal of events) publishDeploymentEvent(terminal);
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
        onLive: (_identity, live) => {
          const frame = liveRuns.apply(live.progress);
          if (frame) realtime.publishLive(frame);
        },
        onCommandAccepted: async (_identity, receipt) => {
          for (const event of await store.succeedCommand(receipt.commandId)) {
            publishDeploymentEvent(event);
          }
        },
        onDisconnect: async (identity, scope) => {
          // Before the recovery work, which is retried until it succeeds: the
          // row is already offline, and a repeated "reread the list" costs a
          // reader nothing.
          notifyMachinesChanged(realtime, "runner.disconnect");
          notices.notify({ runnerId: identity.runnerId });
          // A lost connection costs a Run nothing: it keeps executing on its
          // lease and reattaches. A revoked Runner can never come back, so its
          // Runs end now; a replaced boot's are settled by the new boot's attach.
          if (scope.reason === "revoked") {
            const recovery = await store.failActiveRunsForRunnerDisconnect({
              activeRunIds: scope.runIds,
              runnerBootId: identity.bootId,
              runnerId: identity.runnerId,
            });
            for (const event of recovery.events) publishDeploymentEvent(event);
          }
          const failedTriggerCount = await triggerStore.failActiveForRunnerDisconnect({
            activeOccurrenceIds: scope.triggerOccurrenceIds,
            runnerBootId: identity.bootId,
            runnerId: identity.runnerId,
          });
          if (failedTriggerCount > 0) {
            realtime.publishTriggersChanged();
            notifyAutomationFailures();
          }
        },
        onHeartbeat: async (identity, activeRunIds) => {
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
            leaseExpiresAt: new Date(executionNow() + config.executionLeaseMs),
            runnerBootId: identity.bootId,
            runnerId: identity.runnerId,
          });
          for (const event of attached.events) publishDeploymentEvent(event);
          for (const execution of attached.resumed) liveRuns.track(execution);
          return attached.results;
        },
        onAttached: async () => wakeExecutionCoordinator(),
        onHarnessInstallation: async () => {
          notifyMachinesChanged(realtime, "harness.update");
        },
        onHarnessCatalogInvalidated: async (identity, invalidation) => {
          try {
            const harness = await store.getHarnessInstance(invalidation.harnessInstanceId);
            if (
              !harness ||
              !harness.enabled ||
              harness.removedAt !== null ||
              !identity.environmentIds.includes(harness.environmentId)
            ) {
              return;
            }
            await store.discardHarnessCatalog(harness.environmentId, harness.id);
            const captured = await inspectAndRecordInvalidatedHarnessCatalog({
              catalogs: harnessCatalogs,
              environmentId: harness.environmentId,
              harnesses: [harnessInspectionDefinition(harness)],
              runners,
              signal: AbortSignal.timeout(harnessCatalogCaptureTimeoutMs),
            });
            observeRunnerCatalogs(identity, harness.environmentId, captured);
          } catch (error) {
            reportHarnessCatalogInvalidationError(invalidation.harnessInstanceId, error);
          }
        },
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
            if (await initializePersonal()) await ensureLinks();
            // A computer is online the moment it registers, whatever its
            // inventory reconciliation goes on to do.
            notifyMachinesChanged(realtime, "runner.registered");
            notices.notify({ runnerId: identity.runnerId });
            // macOS applies a Full Disk Access grant only once the app has quit
            // and reopened, so the grant usually arrives as a fresh registration
            // whose descriptor already says so — never as a change message.
            if (identity.modules.shell?.fullDiskAccess === true) {
              await machineFullDiskAccess.fulfillForMachine(identity.runnerId);
            }
            try {
              // Reconnection supersedes the previous boot's observations even
              // if inventory work or the replacement capture fails below.
              for (const environmentId of identity.environmentIds) {
                const harnesses = await store.listHarnessInstances({
                  environmentIds: [environmentId],
                });
                for (const harness of harnesses) {
                  await store.discardHarnessCatalog(environmentId, harness.id);
                }
              }
              await integrationPlatformStore.specialists.resumeRemovals();
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
                  signal: AbortSignal.timeout(harnessCatalogCaptureTimeoutMs),
                });
                observeRunnerCatalogs(identity, environmentId, captured);
              }
              void naming?.reconcile().catch(reportThreadNamingError);
            } finally {
              watchService?.runnerRegistered(identity);
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
            runnerBootId: identity.bootId,
            runnerId: identity.runnerId,
          });
          realtime.publishTriggersChanged();
          if (occurrence.status === "failed") notifyAutomationFailures();
        },
        onWatchStatus: async (identity, status) => {
          await watchService?.applyStatus(identity, status);
          notifyAutomationFailures();
        },
      },
    });
    function observeRunnerCatalogs(
      identity: RunnerIdentity,
      environmentId: EnvironmentId,
      catalogs: readonly HarnessInstanceCatalog[],
    ): void {
      if (
        !options.onRunnerCatalogsCommitted ||
        runners.identityForEnvironment(environmentId)?.connectionId !== identity.connectionId
      )
        return;
      try {
        void Promise.resolve(
          options.onRunnerCatalogsCommitted?.(identity, environmentId, catalogs),
        ).catch(() => undefined);
      } catch {
        // Observation cannot fail registration or convergence after its commit.
      }
    }
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
      publish: publishDeploymentEvent,
      onError: reportThreadNamingError,
    });
    const dispatcher = new HostCommandDispatcher({
      catalogs: harnessCatalogs,
      runnerRegistrationPending: (environmentId) => {
        const identity = runners.identityForEnvironment(environmentId);
        return identity !== undefined && registeringRunners.has(identity.connectionId);
      },
      teamRequestContext: async ({ runId, requestId }, signal) => {
        signal.throwIfAborted();
        const context = await (await ensureLinks()).teamContext(runId);
        signal.throwIfAborted();
        if (context.request.id !== requestId)
          throw new OpensteerError({ code: "forbidden", message: "Team request changed" });
        return {
          ownerDisplayName: context.ownerDisplayName,
          instructionsMarkdown: context.instructionsMarkdown,
          source: context.source,
          content: [{ type: "text" as const, text: JSON.stringify(context.messages) }],
        };
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
      pluginVersions: async (ownerUserId) =>
        (await integrationPlatformStore.plugins.current(ownerUserId)).map(
          ({ id, name, digest }) => ({ pluginId: id, name, digest }),
        ),
      pluginsTokens,
      attachmentRunTokens,
      attachments: attachmentStore,
      onDeploymentEvent: publishDeploymentEvent,
      onTriggerChanged: () => realtime.publishTriggersChanged(),
      publicUrl: config.runtimeOrigin,
      runners,
      store,
      triggerControlTokens,
      triggers: triggerStore,
    });
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
      onDeploymentEvent: publishDeploymentEvent,
      store,
    });
    // Registration is the earliest proof that queued execution can make
    // progress. The hook is profile-neutral and changes only dispatch latency.
    wakeExecutionCoordinator = () => coordinator.wake();
    dispatchingRunIds = () => coordinator.dispatchingRunIds();
    // Commands run concurrently across Threads, and a few at a time so the
    // database pool keeps room for Runner events, dispatch and reads.
    const admission = new KeyedAdmissionQueue({
      isTransactionConflict,
      maxInFlight: 4,
      maxQueuedBytes: 32 * 1_024 * 1_024,
      maxQueuedCommands: 5_000,
    });
    const commands = new CommandService({
      admission,
      onExecutionQueued: () => {
        coordinator.wake();
      },
      onDeploymentEvent: publishDeploymentEvent,
      store,
    });
    integrationPlatformStore.specialists.setRemovalHandler(async (input) => {
      const active = await database
        .selectFrom("runs")
        .innerJoin("threads", "threads.id", "runs.threadId")
        .select(["runs.assignmentId", "runs.requestedBy"])
        .where("threads.specialistId", "=", input.specialistId)
        .where("runs.status", "in", ["queued", "starting", "running", "waiting"])
        .execute();
      for (const run of active)
        if (run.assignmentId)
          await commands.cancelAssignment({
            assignmentId: run.assignmentId,
            requestedBy: run.requestedBy,
            idempotencyKey: `specialist-remove:${input.specialistId}:${run.assignmentId}`,
          });
    });
    let reportContinuationError: (error: unknown) => void = () => undefined;
    const continuations = new ContinuationService({
      passwordSignIn: (operationId) => passwordSignIns.continuationState(operationId),
      commands,
      integrations: {
        computerUseMachines: (ownerUserId) =>
          integrationPlatform.computerAppApprovals.computerUseMachines(ownerUserId),
        computerUsePhones: (ownerUserId) =>
          integrationPlatform.computerAppApprovals.computerUsePhones(ownerUserId),
        listCallableTools: (input) => integrationPlatform.listCallableTools(input),
        listDiscoveryInventory: (input) => integrationPlatform.listDiscoveryInventory(input),
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
    let reportIntegrationConnectionError: (error: unknown, connectionId: string) => void = () =>
      undefined;
    integrationConnectionConnected = integrationConnectionReaction({
      notify: () => continuations.notify(),
      report: (error, connectionId) => reportIntegrationConnectionError(error, connectionId),
      settle: (input) => {
        realtime.sendToUsers([input.ownerUserId], { type: "host.plugins-changed" });
        return integrationPlatform.connectionConnected(input);
      },
    });
    const triggers = new TriggerService({
      runnerStore: store,
      onChanged: () => realtime.publishTriggersChanged(),
      onOccurrenceQueued: () => {
        coordinator.wake();
      },
      onWatchChanged: (triggerId) => {
        void watchService?.triggerChanged(triggerId);
      },
      publicUrl: config.canonicalOrigin,
      store: triggerStore,
      threads: store,
      tokens,
    });
    const channels = new ChannelService({
      onError: (error) => app.log.error({ err: error }, "Channel ingress failed"),
      onChanged: () => notifyMachinesChanged(realtime, "integration.connections"),
      canonicalOrigin: config.canonicalOrigin.origin,
      channels: new ChannelStore(database),
      credentials,
      relay: messagingRelay,
      onExecutionQueued: () => {
        coordinator.wake();
      },
      onDeploymentEvent: publishDeploymentEvent,
      runners,
      store,
    });
    channelService = channels;
    const deviceAccessService = new DeviceAccessService({
      store,
      runners,
      onDeploymentEvent: publishDeploymentEvent,
      continuations,
    });
    const machineFullDiskAccess = new MachineFullDiskAccessService({
      store,
      onDeploymentEvent: publishDeploymentEvent,
      continuations,
    });
    const placeContext = new PlaceContextService({
      browser,
      computerUse,
      connections: integrationStore,
      integrations: integrationPlatform,
      store,
    });
    const browserTabs = new BrowserTabGroupService({
      groups: browserTabGroups,
      browser,
      publish: (ownerIds) => realtime.publishBrowserSessionsChanged(ownerIds, "browser.groups"),
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
      onEvent: publishDeploymentEvent,
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
        publish: publishDeploymentEvent,
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
      browserTabs,
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
      deviceAccess: deviceAccessService,
      machineFullDiskAccess,
      browser,
      canRunHarness: (environmentId, driverKind) =>
        runners.canRunHarness(environmentId, driverKind),
      harnessAccessModes: (environmentId, driverKind) =>
        runners.harnessAccessModes(environmentId, driverKind),
      commands,
      isEnvironmentConnected: (environmentId) => runners.isAvailable(environmentId),
      onEvent: publishDeploymentEvent,
      store,
    });
    const apps = new AppService({
      tunnels: new AppTunnelHub(runners),
      dataDirectory,
      apps: new AppStore(database),
      tabsChanged: async () => {
        const ownerId = await personalDeploymentOwner(database);
        if (ownerId) realtime.sendToUsers([ownerId], { type: "host.app-tabs-changed" });
      },
      files,
      agentHome: async () => (await personalExecution()).options.agentHome,
      tokens: runToolTokens,
      publishEvent: publishDeploymentEvent,
    });
    await apps.collectGarbage();
    const integrationTools = new IntegrationToolHandlers({
      definitions: integrationDefinitions,
      onEvent: publishDeploymentEvent,
      platform: integrationPlatform,
    });
    const plugins = new PluginPackageService({
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
    const accountDirectoryClient = config.account
      ? new AccountDirectoryClient({
          authorityEnvelope: discoveryEnvelope,
          controlApiOrigin: config.account.controlApiOrigin,
          deployment,
          ...(options.accountDirectoryFetch ? { fetch: options.accountDirectoryFetch } : {}),
          hostCredential: config.account.hostCredential,
        })
      : undefined;
    harnessAuthenticationCoordinator = new HarnessAuthenticationCoordinator({
      harnesses: store,
      runners,
    });
    const localBootstrap = localSetupToken
      ? new LocalBootstrapService({
          publicUrl: config.runtimeOrigin,
          requireSetupCredential: deploymentPolicy(config.deploymentShape).localOwnerClaim,
          runners: runnerAuthenticator,
          setupToken: localSetupToken,
          store,
        })
      : undefined;
    const authenticator = new HostAuthenticator({
      identity,
      onAuthenticatedSession: async () => {
        if (await initializePersonal()) await ensureLinks();
      },
      ...(personalRemoteAccess ? { personalRemote: personalRemoteAccess } : {}),
      publicUrl: config.canonicalOrigin,
    });
    const accountAdoptionControlClient =
      config.account?.provisioningMode === "adoption"
        ? new AccountAdoptionControlClient({
            controlApiOrigin: config.account.controlApiOrigin,
            ...(options.accountControlFetch ? { fetch: options.accountControlFetch } : {}),
            hostCredential: config.account.hostCredential,
          })
        : undefined;
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
          publishDeploymentEvent,
          integrations: { platform: integrationPlatform, service: integrations, continuations },
        },
        (id) => administrationCatalogs?.schedule(id),
      ),
      (ownerId) => integrationStore.listConnections(ownerId),
    );
    const agentTools = new OpensteerMcpService({
      requestHold: new RequestHold({
        store,
        continuations,
        onStopped: (stopped) => {
          for (const event of stopped.events) publishDeploymentEvent(event);
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
        apps,
        product: productHandlers,
        integrations: integrationTools,
        triggers: new TriggerToolHandlers(triggers),
        teamRequestForRun: async (runId, threadId) =>
          (
            await database
              .selectFrom("runs")
              .select("teamRequestId")
              .where("id", "=", runId)
              .where("threadId", "=", threadId)
              .executeTakeFirst()
          )?.teamRequestId ?? null,
        team: {
          read: async (...args) => (await ensureLinks()).teamTools.read(...args),
          search: async (...args) => (await ensureLinks()).teamTools.search(...args),
          reply: async (...args) => (await ensureLinks()).teamTools.reply(...args),
          sql: async (...args) => (await ensureLinks()).teamTools.sql(...args),
        },
        pluginInstall: async (scope, directory) => {
          const thread = await store.getThreadForOwner(scope.threadId, scope.requestedBy);
          if (!thread) throw new OpensteerError({ code: "not_found", message: "Task not found" });
          return withFolderPluginPackage({
            directory,
            files,
            install: async (stagedDirectory) => {
              const result = await integrationPlatform.installAgentPlugin({
                directory: stagedDirectory,
                threadId: scope.threadId,
                actorUserId: scope.requestedBy,
                runnerId: scope.runnerId,
                requestId: randomUUID(),
              });
              const pluginId = result.installation.pluginId;
              const registration =
                result.specialist && pluginId
                  ? await integrationPlatform.store.specialists.add({
                      pluginId,
                      actorUserId: scope.requestedBy,
                    })
                  : null;
              return {
                pluginId,
                issues: result.issues,
                specialist: result.specialist,
                registration,
              };
            },
          });
        },
      }),
    });
    const taskAdmission = new TaskAdmissionService({
      database,
      execution: async () => {
        const settings = await personalSettings(database);
        const preferences = await store.getExecutionPreferences(settings.ownerId);
        return resolveTeamTaskExecution(
          { store, runners },
          {
            ownerId: settings.ownerId,
            environmentId: personalConfig.environmentId,
            preferences,
          },
        );
      },
      publish: (events) => events.forEach(publishDeploymentEvent),
      revokeGrants: (grants) => store.announceRevokedGrants(grants),
    });
    async function ensureLinks() {
      if (linkServices) return linkServices;
      if (linkStarting) return linkStarting;
      linkStarting = (async () => {
        const service = await personalExecution();
        const links = createPersonalTeamLinkServices({
          database,
          ownerId: service.options.ownerId,
          deploymentId: deployment.id,
          installationLabel: config.deploymentName ?? "My computer",
          credentialVault: teamLinkVault,
          admission: taskAdmission,
          runs: personalTeamRunPort(database),
          onPublished: async (threadId) => {
            const ownerId = service.options.ownerId;
            const state = await store.notificationState.getReadState({ threadId, userId: ownerId });
            realtime.publishReadState(ownerId, state);
          },
          attachments: new PersonalTeamAttachments({
            store,
            attachments,
            attachmentStore,
            tokens: attachmentRunTokens,
            runners,
            relay: runFileRelay,
          }),
        });
        await links.links.start();
        linkServices = links;
        teamRunEvents = new TeamRunEvents({
          publish: async (runId, steps) => {
            const request = await links.requests.options.requests.forRun(runId);
            if (!request) return;
            const outcome = await links.requests.options.runs.outcome(request);
            await links.requests.runChanged(
              runId,
              outcome.state === "working" || outcome.state === "needs_you"
                ? { state: outcome.state, steps }
                : undefined,
            );
          },
          onError: () =>
            app.log.warn("Team Run publication failed; the durable reply remains pending"),
        });
        return links;
      })().finally(() => {
        linkStarting = undefined;
      });
      return linkStarting;
    }
    const app = await createHostServer(
      {
        connections,
        passkeys: config.passkeys === true,
        ...(notificationPreviews ? { notificationPreviews } : {}),
        ...(accountAdoptionControlClient
          ? {
              accountAdoption: {
                acknowledge: (proofId: string) => accountAdoptionControlClient.acknowledge(proofId),
              },
            }
          : {}),
        attachments,
        runFiles: runFileRelay,
        apps,
        appOriginSigningKey: createHmac("sha256", config.authSecret)
          .update("opensteer-app-cookie-v1")
          .digest(),
        appRealOrigins: hostAppRealOrigins(config.deploymentShape),
        liveRuns,
        deviceAccess: deviceAccessService,
        machineFullDiskAccess,
        requestResponseVault: integrationVault,
        runToolTokens,
        agentTools,
        authenticator,
        browser,
        browserTabs,
        browserSources,
        signBrowserSourceInvitation: (bytes) =>
          sign(null, bytes, keys.privateKey).toString("base64url"),
        browserAttachPublicKeys,
        browserRelay,
        channels: { relay: messagingRelay, service: channels },
        commands,
        computerApps,
        computerUse,
        computerViews,
        phoneTabs,
        displayStreams,
        placeContext,
        credentials,
        discovery: discoveryEnvelope,
        egress,
        execution,
        teamLinks: async () => (await ensureLinks()).links,
        harnessAuthenticationCoordinator,
        integrations: {
          authAttempts: integrationAuthAttempts,
          continuations,
          dashboard: integrationDashboard,
          mcpOauth,
          platform: integrationPlatform,
          service: integrations,
          skills: plugins,
        },
        ...(localBootstrap ? { localBootstrap: { service: localBootstrap } } : {}),
        ...(personalRemoteAccess
          ? { personalRemoteAccess: { service: personalRemoteAccess } }
          : {}),
        realtime,
        publishDeploymentEvent,
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
          watchPrograms: new WatchProgramService({
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
    reportIntegrationConnectionError = (error, connectionId) =>
      app.log.error(
        { connectionId, err: error },
        "Integration connection could not settle its pending Requests",
      );
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
    reportIntegrationCallSubjectError = (event, error) =>
      app.log.warn(
        { err: error, ordinal: event.ordinal, runId: event.runId },
        "An integration call's subject could not be resolved; it was recorded without one",
      );
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
    reportBrowserPresenceError = (error) =>
      app.log.warn({ err: error }, "Browser presence delivery failed");
    reportBrowserUsageError = (error) =>
      app.log.warn({ err: error }, "Browser usage recording failed");
    // The Account's copy of this Host's signed discovery envelope is what every
    // client verifies before it will route here, and only the Host can refresh
    // it. Re-assert it on every start, whichever way this Host reaches its
    // Account.
    const publishHostAuthority = accountDirectoryClient
      ? () => accountDirectoryClient.publishAuthority()
      : personalRemoteAccess
        ? async () => {
            await personalRemoteAccess.publishAccountAuthority();
          }
        : undefined;
    const hostAuthorityPublisher = publishHostAuthority
      ? new HostAuthorityPublisher({
          onError: (error) => app.log.error({ err: error }, "Host authority publication failed"),
          publish: publishHostAuthority,
        })
      : undefined;
    let accountDirectoryPublisher: AccountDirectoryPublisher | undefined;
    if (accountDirectoryClient && accountDirectoryStore) {
      accountDirectoryPublisher = new AccountDirectoryPublisher({
        ...(options.accountDirectoryIntervalMs
          ? { intervalMs: options.accountDirectoryIntervalMs }
          : {}),
        onError: (error) =>
          app.log.error({ err: error }, "Opensteer Account directory publication failed"),
        publish: async (projection) => {
          await accountDirectoryClient.publish(projection);
        },
        store: accountDirectoryStore,
      });
    }
    await memoryPasses.reconcileMissing();
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
    // Membership is only listable against a published identity, so the
    // directory publisher waits for the Account to accept this Host's identity
    // instead of racing it and spending its first attempt on a certain refusal.
    if (accountDirectoryPublisher && hostAuthorityPublisher) {
      const directoryPublisher = accountDirectoryPublisher;
      void hostAuthorityPublisher.ready().then(() => {
        if (!closed) directoryPublisher.start();
      });
    }
    const triggerScheduleLoop = new TriggerScheduleLoop({
      onChanged: () => realtime.publishTriggersChanged(),
      onError: (error) => app.log.error({ err: error }, "Trigger scheduling failed"),
      onOccurrenceQueued: () => {
        coordinator.wake();
        realtime.publishTriggersChanged();
      },
      store: triggerStore,
    });
    triggerScheduleLoop.start();
    watchService.start();
    channels.start();
    const personalReconcileLoop = new ReconcileLoop({
      ...(options.personalReconcileClock ? { clock: options.personalReconcileClock } : {}),
      intervalMs: 30_000,
      onError: (error) => app.log.error({ err: error }, "Personal reconciliation failed"),
      reconcile: async () => {
        await reconcileServices(
          [
            (async () => {
              // Delegation deliveries are a durable recovery ledger. Reconcile
              // them even while a Runner remains connected: a transient
              // post-commit delivery failure must not require a Host restart.
              const returns = await store.drainPendingAssignmentReturns();
              for (const event of returns.events) publishDeploymentEvent(event);
              for (const { assignmentId, error } of returns.failures) {
                reportAssignmentReturnError(assignmentId, error);
              }
            })(),
            initializePersonalState(database, personalConfig, realtime).then(async (service) => {
              if (service) await ensureLinks();
            }),
            ...(personalRemoteAccess ? [personalRemoteAccess.purgeExpiredAccountLinkKeys()] : []),
            // What a work location can run is durable state like any other, so it
            // is reconciled rather than captured once and hoped for.
            store.listEnvironments().then(async (environments) => {
              const identities = options.onRunnerCatalogsCommitted
                ? new Map(
                    environments.flatMap((environment) => {
                      const identity = runners.identityForEnvironment(environment.id);
                      return identity ? [[environment.id, identity] as const] : [];
                    }),
                  )
                : undefined;
              await reconcileHarnessCatalogs({
                catalogs: harnessCatalogs,
                connectedEnvironmentIds: environments
                  .filter((environment) => runners.isAvailable(environment.id))
                  .map((environment) => environment.id),
                runners,
                signal: AbortSignal.timeout(harnessCatalogCaptureTimeoutMs),
                ...(identities
                  ? {
                      onCommitted: (
                        environmentId: EnvironmentId,
                        catalogs: readonly HarnessInstanceCatalog[],
                      ) => {
                        const identity = identities.get(environmentId);
                        if (identity) observeRunnerCatalogs(identity, environmentId, catalogs);
                      },
                    }
                  : {}),
              });
            }),
          ],
          () => memoryPasses.reconcileMissing(),
        );
      },
      sweep: () => 0,
    });
    if (await initializePersonal()) await ensureLinks();
    personalReconcileLoop.start();
    // An execution lease is the whole grace a Runner out of reach has, so an
    // expired one is noticed within a fraction of it, whether or not the
    // Runner is connected: silence is not a terminal event.
    const executionLeaseLoop = new ReconcileLoop({
      ...(options.executionClock ? { clock: options.executionClock } : {}),
      intervalMs: Math.min(10_000, Math.floor(config.executionLeaseMs / 4)),
      onError: (error) => app.log.error({ err: error }, "Execution lease sweep failed"),
      reconcile: async () => {
        const expired = await store.recoverRunsWithExpiredExecutionBindings();
        for (const event of expired.events) publishDeploymentEvent(event);
        if (expired.events.some((event) => event.type === "run.restarted"))
          wakeExecutionCoordinator();
        // Background work past its deadline is stopped like any other Run,
        // and each stop is published as it commits.
        await store.stopRunsPastBackgroundDeadline((stopped) => {
          for (const event of stopped.events) publishDeploymentEvent(event);
          wakeExecutionCoordinator();
        });
      },
      sweep: () => undefined,
    });
    executionLeaseLoop.start();
    threadStateLoop = new ReconcileLoop({
      intervalMs: 1000,
      onError: (error) => app.log.error({ err: error }, "Thread state sweep failed"),
      reconcile: drainThreadStates,
      sweep: () => undefined,
    });
    threadStateLoop.start();

    return {
      kind: "personal",
      app,
      browser,
      notifications: notificationDispatcher,
      deployment,
      store,
      authorityLost: authorityLease.lost,
      settleExecutionLeases: () => executionLeaseLoop.settled(),
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
        await step("personal reconcile loop", () => personalReconcileLoop.close());
        await step("execution lease loop", () => executionLeaseLoop.close());
        await step("trigger schedule loop", () => triggerScheduleLoop.close());
        await step("watch service", () => watchService?.close());
        await step("continuations", () => continuations.close());
        await step("automation failures", () => automationFailures.close());
        await step("host authority publisher", () => hostAuthorityPublisher?.close());
        await step("account directory publisher", () => accountDirectoryPublisher?.close());
        await step("notifications", () => notificationsClosed);
        await step("channels", () => channels.close());
        messagingRelay.close();
        // Before the hub, so every live session is told to end rather than
        // finding its stream gone and being dropped in silence.
        computerViews?.shutdown();
        displayStreams?.close();
        await step("computer use", () => computerUse.shutdown());
        computerApps.close();
        await step("agent tools", () => agentTools.close());
        await step("team Run publication", () => teamRunEvents?.close());
        await step("team links", async () => {
          await linkStarting;
          await linkServices?.links.stop();
        });
        await step("administration catalogs", () => administrationCatalogs?.close());
        await step("integration platform", () => integrationPlatform.close());
        await step("browser", () => browser.close());
        passwordSignIns.close();
        browserSources.close();
        runnerBrowsers.close();
        browserRelay.close();
        await step("shell hub", () => shellHub?.close());
        await step("runners", () => runners.close());
        await step("thread naming", () => naming!.stop());
        await step("quiet tasks", () => quietTasks.stop());
        await step("coordinator", () => coordinator.stop());
        await step("task questions", () => taskQuestions?.close());
        files.close();
        await step("HTTP server", () => app.close());
        await step("admission", () => admission.close());
        await step("thread state loop", () => threadStateLoop?.close());
        await step("thread state drain", () => drainThreadStates());
        threadStateStopped = true;
        await step("plugin change notices", () => notices.close());
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
    await taskQuestions?.close();
    await administrationCatalogs?.close();
    await notificationDispatcher?.close();
    threadStateStopped = true;
    await threadStateLoop?.close();
    await threadStateDrain?.catch(() => undefined);
    await pluginChangeNotices?.close();
    await authorityLease?.close();
    await database.destroy();
    throw error;
  }
}

/**
 * Returns a finished task's result the moment its terminal state is published.
 * The periodic reconcile drains the same outbox, so a failure here only waits
 * for the next pass; delivery itself is idempotent.
 */
export function assignmentReturnReaction(options: {
  readonly deliver: (assignmentId: AssignmentId) => Promise<readonly AgentEvent[]>;
  readonly onError: (assignmentId: AssignmentId, error: unknown) => void;
  readonly publish: (event: AgentEvent) => void;
}): (event: AgentEvent) => void {
  return (event) => {
    if (event.type !== "assignment.updated") return;
    const { assignment } = event.data;
    if (assignment.status === "open" || assignment.returnStatus !== "pending") return;
    void options.deliver(assignment.id).then(
      (events) => {
        for (const delivered of events) options.publish(delivered);
      },
      (error: unknown) => options.onError(assignment.id, error),
    );
  };
}

/** Releases Run-owned resources; the Assignment reacts through its own events. */
export function terminalRunReaction(options: {
  readonly closeComputerUseSessions?: (runId: RunId) => void;
  readonly detachBrowserSessions: (bindingId: string) => Promise<unknown>;
  readonly endShellSessions: (runId: RunId) => Promise<unknown>;
}): (event: AgentEvent) => void {
  return (event) => {
    if (!isTerminalRunEvent(event) || !event.runId) return;
    const runId = event.runId;
    options.closeComputerUseSessions?.(runId);
    void options.detachBrowserSessions(`run:${runId}`).catch(() => undefined);
    void options.endShellSessions(runId).catch(() => undefined);
  };
}

function isTerminalRunEvent(event: AgentEvent): boolean {
  return (
    event.type === "run.completed" ||
    event.type === "run.failed" ||
    event.type === "run.interrupted"
  );
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

export function hostAppRealOrigins(shape: import("@opensteer/core").DeploymentShape): boolean {
  return deploymentPolicy(shape).services.personal;
}
