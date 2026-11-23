import { endAgentSessions, refuseUnsentAgentOperation } from "./agent-session-store.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import { recordThreadVisit } from "./thread-visits.js";
import { installAssignmentReturnWake } from "./assignment-store.js";
import { removeDevice } from "./device-removal-store.js";
import * as deviceInventoryStore from "./device-inventory-store.js";
import * as deviceDriverStore from "./device-driver-store.js";
import * as waitingInputs from "./waiting-inputs.js";
import { setExecutionClock } from "./personal-transaction.js";
import { pauseLineageTrigger, TriggerStore } from "./trigger-store.js";
import {
  claimConnectionCleanup,
  completeCleanupIfSettled,
  connectionAttempts,
  connectionStopId,
  recordConnectionStop,
  connectionCdpAttempts,
  recoverConnectionCdpAttempts,
  markConnectionAttemptsContactLost,
  outstandingAttempts,
  recordConnectionRunHandoff,
  recordRunNotAdmitted,
  type ConnectionAttemptStopper,
  type ConnectionCleanup,
  openCleanups,
  requestExpiredCleanups,
  stopChatAttempt,
  releaseConnectionCleanupClaim,
  renewConnectionCleanupClaim,
  settleLineageRequests,
} from "./connection-disconnect.js";
import { bindDeviceSession, revokeDeviceSession, leaveDevice } from "./device-store.js";
import { enqueueNodeStop } from "./node-control.js";
import { listEligibleBrowserRunners } from "./browser-home-store.js";
import { readAgentHomeSettings } from "./agent-home-settings-store.js";
import * as voiceStore from "./voice-store.js";

import {
  replayAdministrationCommand,
  type AdministrationCommandIdentity,
} from "./administration-command.js";
import {
  admitExecution,
  bindingAgentConnectionId,
  resolveResourceAccess,
  type ResourceAccessInput,
} from "./resource-access.js";
import { type ChannelTransportKind, type IntegrationConnectionId } from "@opensteer/channel-core";
import {
  createId,
  type AssignmentId,
  type AssignmentSummary,
  type AssignmentView,
  type BrowserProfileId,
  type CredentialId,
  type Deployment,
  type DeploymentId,
  type DeploymentShape,
  type EnvironmentId,
  type ExecutionChoice,
  type ExecutionNode,
  type ExecutionPreferences,
  type GrantId,
  type HarnessInstanceId,
  type HostInstanceId,
  type Message,
  type MessageId,
  type ModelSelection,
  type PlaceContentPart,
  type ProviderContinuationIdentity,
  type ProviderSessionId,
  type Run,
  type RunAttempt,
  type RunId,
  type RunnerId,
  type Sequence,
  type Thread,
  type ThreadAccessMode,
  type ThreadExecutionBinding,
  type ThreadId,
  type TriggerId,
  type UserId,
} from "@opensteer/core";
import {
  type BrowserSessionId,
  type BrowserSessionOpenerRecord,
  type BrowserSessionUsageProjection,
  type BrowserTabOpenBinding,
  type DurableWindow,
  type HarnessInstanceCatalog,
  type HostedBrowserSessionState,
  type MachineAccessPolicy,
  type RunnerDescriptor,
  type RunnerModuleName,
  type ShellAuditEvent,
  type ShellCloseReason,
  type ShellSessionId,
  type ShellSessionSummary,
  type ThreadMessagePage,
} from "@opensteer/protocol";
import type { Clock } from "@opensteer/shared/clock";
import { sql, type Kysely } from "kysely";
import {
  type RunToolAdmissionInput,
  type RunToolAdmissionResult,
  type TriggerControlAdmissionInput,
  type TriggerControlAdmissionResult,
} from "./run-tool-admission.js";
import {
  assignmentTreeThreadIds,
  type CancelAssignmentInput,
  type CancelAssignmentResult,
} from "./assignment-store.js";
import { BrowserHistoryStore } from "./browser-history-store.js";
import * as browserProfileStorageStore from "./browser-profile-storage-store.js";
import * as browserSessionStore from "./browser-session-store.js";
import {
  type BrowserProfileRecord,
  type BrowserSessionRecord,
  type BrowserSessionWithAttachmentCountRecord,
} from "./browser-session-store.js";
import * as commandStore from "./command-store.js";
import { type ClaimedCommand, type RunnerControlInput } from "./command-store.js";
import * as computerUseStore from "./computer-use-store.js";
import * as credentialStore from "./credential-store.js";
import { type CredentialRecord } from "./credential-store.js";
import * as deploymentStore from "./deployment-store.js";
import * as environmentStore from "./environment-store.js";
import { type ExecutionEnvironmentRecord } from "./environment-store.js";
import { listRunNodes } from "./execution-nodes.js";
import * as executionRecovery from "./execution-recovery.js";
import {
  type AnnouncedExecution,
  type BackgroundDeadlineStop,
  type ExecutionAttachment,
  type ResumedExecution,
  type RunRecoveryOutcome,
} from "./execution-recovery.js";
import * as executionStore from "./execution-store.js";
import { type RunDispatchContext } from "./execution-store.js";
import * as harnessStore from "./harness-store.js";
import {
  type CreateHarnessInstanceInput,
  type HarnessCatalogRecord,
  type HarnessInstanceRecord,
} from "./harness-store.js";
import { type MachineOwnershipRecord } from "./machine-ownership.js";
import * as machineStore from "./machine-store.js";
import {
  type MachineAccessTargetRecord,
  type ReachableMachineRecord,
  type ShellSessionHistoryRecord,
  type ShellSessionRecord,
} from "./machine-store.js";
import { NotificationStateStore } from "./notification-state.js";
import { OwnerProfileStore } from "./owner-profile-store.js";
import {
  installPersonMessageWake,
  publishPersonMessage,
  type PersonMessageReady,
  type PersonMessageInput,
  type PersonMessageResult,
} from "./person-message-store.js";
import { RequestStore } from "./request-store.js";
import { IntegrationRequestStore } from "./integration-request-store.js";
import { listRunAttempts } from "./run-attempts.js";
import { type RevokedRunGrant } from "./run-grants.js";
import * as runnerEventStore from "./runner-event-store.js";
import * as runnerStore from "./runner-store.js";
import {
  type PendingRunnerEnrollmentRecord,
  type RunnerAuthenticationRecord,
  type RunnerConnectionRecord,
  type RunnerEnrollmentIssuanceRecord,
  type RunnerInventoryRecord,
} from "./runner-store.js";
import { type CommandRow, type DatabaseSchema, type PendingCommandRow } from "./schema.js";
import { readPersonalTaskPage } from "./personal-task-store.js";
import { drainRunFinish } from "./run-finalization.js";
import { lockCommandIdempotency, threadPathLinks, type ChannelLinks } from "./store-primitives.js";
import * as taskDone from "./task-done.js";
import * as quietTasks from "./quiet-tasks.js";
import { readThreadHistory, type ThreadHistoryQuery } from "./thread-history.js";
import { latestRunStoppedByPerson, type AssignmentReturnDrain } from "./thread-inbox.js";
import { executionNodeFromRow, runAttemptFromRow } from "./thread-row-mappers.js";
import * as threadStore from "./thread-store.js";
import type { TaskReader } from "./task-reader.js";
import {
  type AdmittedThreadDelegationRequest,
  type AdmittedThreadInputRequest,
  type AgentThreadListPage,
  type AgentThreadListScope,
  type CancelThreadInputRequest,
  type CancelledThreadInput,
  type CreateThreadInput,
  type DelegateThreadRequest,
  type DelegatedThreadResult,
  type EnqueueThreadInputRequest,
  type EnqueuedThreadInput,
  type MoveThreadInputRequest,
  type MovedThreadInput,
  type OwnedThreadRead,
  type OwnerThreadPage,
  type SteerThreadInputRequest,
  type ThreadCreationResult,
  type ThreadUpdateResult,
} from "./thread-store.js";

/** Told, after commit, which grants a write revoked. */
export type RunGrantRevocationListener = (grants: readonly RevokedRunGrant[]) => void;
/** A computer's placed-task count stops here; a longer history reads as the cap. */
export const pinnedThreadsCountCap = 1_000;

export class OpensteerStore {
  readonly #database: Kysely<DatabaseSchema>;

  // The Deployment authority lease permits one mutating Host process. These
  // post-commit listeners therefore form the immediate local revocation path;
  // generation and grant rechecks remain the durable race fence.

  readonly #runGrantRevocationListeners = new Set<RunGrantRevocationListener>();

  // A status delivery has to name a page a person can open, and only the Host
  // knows the origin its own web app answers on.
  readonly #links: ChannelLinks;
  readonly #executionNow: () => number;
  readonly requests: RequestStore;
  /** Device data app and local-server access Requests, settled with their grants. */
  readonly integrationRequests: IntegrationRequestStore;
  readonly notificationState: NotificationStateStore;
  readonly ownerProfile: OwnerProfileStore;
  readonly browserHistory: BrowserHistoryStore;
  constructor(
    database: Kysely<DatabaseSchema>,
    options: {
      readonly links?: ChannelLinks;
      readonly executionClock?: Pick<Clock, "now">;
    } = {},
  ) {
    this.#database = database;
    this.#links = options.links ?? threadPathLinks;
    this.#executionNow = options.executionClock?.now ?? (() => Date.now());
    setExecutionClock(database, this.#executionNow);
    this.requests = new RequestStore(database, this.#links, this.#executionNow);
    this.integrationRequests = new IntegrationRequestStore(database, this.requests);
    this.notificationState = new NotificationStateStore(database);
    this.ownerProfile = new OwnerProfileStore(database);
    this.browserHistory = new BrowserHistoryStore(database);
  }

  async startVoiceCall(input: Parameters<typeof voiceStore.startVoiceCall>[2]) {
    return this.#announceRevokedGrants(
      await commitPersonalMutation(this.#database, (tx) =>
        voiceStore.startVoiceCall(tx, this.#links, input),
      ),
    );
  }
  resolveVoiceCall(ownerId: UserId, sessionId: string) {
    return voiceStore.resolveVoiceCall(this.#database, ownerId, sessionId);
  }
  openVoiceThread(input: Parameters<typeof voiceStore.openVoiceThread>[1]) {
    return commitPersonalMutation(this.#database, async (tx) => {
      const { threadId, environmentId, harnessInstanceId } = await voiceStore.openVoiceThread(
        tx,
        input,
      );
      return { threadId, environmentId, harnessInstanceId };
    });
  }
  latestRunStoppedByPerson(threadId: ThreadId) {
    return latestRunStoppedByPerson(this.#database, threadId);
  }
  async stopVoiceCall(ownerId: UserId, sessionId: string) {
    const result = await commitPersonalMutation(this.#database, (tx) =>
      voiceStore.stopVoiceCall(tx, this.#links, ownerId, sessionId),
    );
    if (result) this.#announceRevokedGrants(result);
    return result;
  }
  get database(): Kysely<DatabaseSchema> {
    return this.#database;
  }

  /**
   * Hears every grant a committed write revoked while its Run lives on: Stop,
   * a restart, a cancelled Assignment, a background deadline, a new binding.
   */
  onRunGrantsRevoked(listener: RunGrantRevocationListener): () => void {
    this.#runGrantRevocationListeners.add(listener);
    return () => this.#runGrantRevocationListeners.delete(listener);
  }

  /** Grants a write committed through another store revoked, announced like this store's own. */
  announceRevokedGrants(grants: readonly RevokedRunGrant[]): void {
    this.#announce(grants);
  }
  #announceRevokedGrants<
    Result extends {
      readonly revokedGrants: readonly RevokedRunGrant[];
    },
  >(result: Result): Result {
    this.#announce(result.revokedGrants);
    return result;
  }
  #announce(grants: readonly RevokedRunGrant[]): void {
    if (grants.length === 0) return;
    for (const listener of this.#runGrantRevocationListeners) listener(grants);
  }
  async getDeployment(): Promise<Deployment | null> {
    return deploymentStore.getDeployment(this.#database);
  }
  async ensureDeployment(input: {
    readonly canonicalOrigin: string;
    readonly deploymentId?: DeploymentId;
    readonly hostInstanceId: HostInstanceId;
    readonly deploymentShape: DeploymentShape;
  }): Promise<Deployment> {
    return deploymentStore.ensureDeployment(this.#database, input);
  }
  async createUser(displayName: string, id = createId("user")): Promise<UserId> {
    return deploymentStore.createUser(this.#database, displayName, id);
  }
  async firstUser(): Promise<{
    readonly id: UserId;
    readonly displayName: string;
  } | null> {
    return deploymentStore.firstUser(this.#database);
  }
  async userById(userId: UserId): Promise<{
    readonly disabledAt: Date | null;
    readonly displayName: string;
    readonly email: string;
    readonly emailVerified: boolean;
    readonly id: UserId;
    readonly image: string | null;
  } | null> {
    return deploymentStore.userById(this.#database, userId);
  }

  async createEnvironment(input: {
    readonly capabilities?: readonly string[];
    readonly id?: EnvironmentId;
    readonly kind: "main" | "local" | "managed";
    readonly name: string;
    readonly runnerId?: RunnerId | null;
  }): Promise<EnvironmentId> {
    return environmentStore.createEnvironment(this.#database, input);
  }
  async runnerForAuthentication(runnerId: RunnerId): Promise<RunnerAuthenticationRecord | null> {
    return runnerStore.runnerForAuthentication(this.#database, runnerId);
  }
  async recordRunnerUpdateRequired(
    input: Parameters<typeof runnerStore.recordRunnerUpdateRequired>[1],
  ): Promise<boolean> {
    return runnerStore.recordRunnerUpdateRequired(this.#database, input);
  }
  async environmentRunnerOwner(environmentId: EnvironmentId): Promise<UserId | null> {
    return runnerStore.environmentRunnerOwner(this.#database, environmentId);
  }
  async runnerCapabilities(runnerId: RunnerId): Promise<readonly string[] | null> {
    return runnerStore.runnerCapabilities(this.#database, runnerId);
  }
  async bootstrapRunnerIsEnrolled(createdBy: UserId): Promise<boolean> {
    return runnerStore.bootstrapRunnerIsEnrolled(this.#database, createdBy);
  }

  async deploymentMainRunnerState(): Promise<"absent" | "active" | "revoked"> {
    return runnerStore.deploymentMainRunnerState(this.#database);
  }

  async listRunners(input: {
    readonly ids?: readonly RunnerId[];
    readonly after?: RunnerId;
    readonly includeDeployment: boolean;
    readonly includeOtherOwners?: boolean;
    readonly limit: number;
    readonly ownerId: UserId;
  }): Promise<{
    readonly nextCursor: RunnerId | null;
    readonly runners: readonly RunnerInventoryRecord[];
  }> {
    return runnerStore.listRunners(this.#database, input);
  }
  async revokeRunner(
    runnerId: RunnerId,
    ownerId: UserId,
    options: {
      readonly administration?: AdministrationCommandIdentity | undefined;
      readonly allowDeployment?: boolean;
      readonly allowOtherOwners?: boolean;
    } = {},
  ) {
    return runnerStore.revokeRunner(this.#database, this.#links, runnerId, ownerId, options);
  }
  async removeDevice(
    deviceId: import("@opensteer/core").DeviceId,
    ownerId: UserId,
    options: Parameters<typeof removeDevice>[4] = {},
  ) {
    return removeDevice(this.#database, this.#links, deviceId, ownerId, options);
  }
  async requireDeviceSelfRunnerId(
    input: Parameters<typeof deviceInventoryStore.requireDeviceSelfRunnerId>[1],
  ) {
    return deviceInventoryStore.requireDeviceSelfRunnerId(this.#database, input);
  }
  async renameDevice(
    deviceId: import("@opensteer/core").DeviceId,
    ownerId: UserId,
    name: string,
    options: Parameters<typeof deviceInventoryStore.renameDevice>[4] = {},
  ) {
    return deviceInventoryStore.renameDevice(this.#database, deviceId, ownerId, name, options);
  }
  async getDevice(input: Parameters<typeof deviceInventoryStore.getDevice>[1]) {
    return deviceInventoryStore.getDevice(this.#database, input);
  }
  async listDevices(input: Parameters<typeof deviceInventoryStore.listDevices>[1]) {
    return deviceInventoryStore.listDevices(this.#database, input);
  }
  async getSelfDeviceId(input: Parameters<typeof deviceInventoryStore.getSelfDeviceId>[1]) {
    return deviceInventoryStore.getSelfDeviceId(this.#database, input);
  }
  async requireSelfDeviceId(input: Parameters<typeof deviceInventoryStore.requireSelfDeviceId>[1]) {
    return deviceInventoryStore.requireSelfDeviceId(this.#database, input);
  }
  async getDeviceSelfRunnerId(
    input: Parameters<typeof deviceInventoryStore.getDeviceSelfRunnerId>[1],
  ) {
    return deviceInventoryStore.getDeviceSelfRunnerId(this.#database, input);
  }
  async listDeviceDrivers(
    input: Parameters<typeof deviceInventoryStore.listDeviceDrivers>[1] = {},
  ) {
    return deviceInventoryStore.listDeviceDrivers(this.#database, input);
  }
  async attachIphoneScreen(input: Parameters<typeof deviceDriverStore.attachIphoneScreen>[1]) {
    return deviceDriverStore.attachIphoneScreen(this.#database, input);
  }
  async detachIphoneScreen(input: Parameters<typeof deviceDriverStore.detachIphoneScreen>[1]) {
    return deviceDriverStore.detachIphoneScreen(this.#database, input);
  }
  async bindDeviceSession(input: Parameters<typeof bindDeviceSession>[1]) {
    return bindDeviceSession(this.#database, input);
  }
  async revokeDeviceSession(input: Parameters<typeof revokeDeviceSession>[2]) {
    return revokeDeviceSession(this.#database, this.#links, input);
  }
  async leaveDevice(input: Parameters<typeof leaveDevice>[2]) {
    return leaveDevice(this.#database, this.#links, input);
  }
  async renameRunner(
    runnerId: RunnerId,
    ownerId: UserId,
    name: string,
    options: {
      readonly administration?: AdministrationCommandIdentity | undefined;
      readonly allowDeployment?: boolean;
    } = {},
  ): Promise<void> {
    return runnerStore.renameRunner(this.#database, runnerId, ownerId, name, options);
  }
  async updateDeviceAccessPolicy(
    input: Parameters<typeof machineStore.updateDeviceAccessPolicy>[1],
  ) {
    return machineStore.updateDeviceAccessPolicy(this.#database, input);
  }
  async updateMachineAccessPolicy(input: {
    readonly allowDeployment: boolean;
    readonly expectedRevision: number;
    readonly idempotency?: {
      readonly key: string;
      readonly requestedBy: UserId;
    };
    readonly ownerId: UserId;
    readonly policy: MachineAccessPolicy;
    readonly runnerId: RunnerId;
  }): Promise<
    | {
        readonly outcome: "conflict";
        readonly replayed: boolean;
      }
    | {
        readonly outcome: "updated";
        readonly replayed: boolean;
        readonly revision: number;
        readonly fulfilledRequestIds: readonly import("@opensteer/core").RequestId[];
        readonly changed: {
          readonly shell: boolean;
          readonly browser: boolean;
          readonly apps: boolean;
        };
      }
  > {
    return machineStore.updateMachineAccessPolicy(this.#database, input);
  }
  async effectiveDeviceOwners(ids: Parameters<typeof machineStore.effectiveDeviceOwners>[1]) {
    return machineStore.effectiveDeviceOwners(this.#database, ids);
  }
  async effectiveMachineOwner(runnerId: RunnerId): Promise<MachineOwnershipRecord | null> {
    return machineStore.effectiveMachineOwner(this.#database, runnerId);
  }
  async effectiveMachineOwners(
    runnerIds: readonly RunnerId[],
  ): Promise<ReadonlyMap<RunnerId, MachineOwnershipRecord>> {
    return machineStore.effectiveMachineOwners(this.#database, runnerIds);
  }
  async getShellSession(sessionId: ShellSessionId): Promise<ShellSessionRecord | null> {
    return machineStore.getShellSession(this.#database, sessionId);
  }
  async getMachineAccessTarget(runnerId: RunnerId): Promise<MachineAccessTargetRecord | null> {
    return machineStore.getMachineAccessTarget(this.#database, runnerId);
  }
  async listReachableMachines(
    userId: UserId,
    callerRunnerId: RunnerId,
  ): Promise<readonly ReachableMachineRecord[]> {
    return machineStore.listReachableMachines(this.#database, userId, callerRunnerId);
  }
  async reserveShellSession(input: {
    readonly callerMachineName: string;
    readonly callerRunnerId: RunnerId;
    readonly policyRevision: number;
    readonly requestedBy: UserId;
    readonly runId: RunId;
    readonly runnerId: RunnerId;
    readonly sessionId: ShellSessionId;
    readonly startedAt: Date;
    readonly threadId: ThreadId;
    readonly threadTitle: string;
  }): Promise<void> {
    return machineStore.reserveShellSession(this.#database, input);
  }
  async activateShellSession(sessionId: ShellSessionId): Promise<boolean> {
    return machineStore.activateShellSession(this.#database, sessionId);
  }
  async endShellSession(input: {
    readonly bytesIn?: number;
    readonly bytesOut?: number;
    readonly endedAt?: Date;
    /** A Stop the person may click twice; the second click reports the first. */
    readonly idempotency?: {
      readonly key: string;
      readonly requestedBy: UserId;
    };
    readonly reason: ShellCloseReason;
    readonly sessionId: ShellSessionId;
  }): Promise<{
    readonly ended: boolean;
  }> {
    return machineStore.endShellSession(this.#database, input);
  }
  async endAllOpenShellSessions(reason: ShellCloseReason): Promise<number> {
    return machineStore.endAllOpenShellSessions(this.#database, reason);
  }
  async appendShellEvents(
    sessionId: ShellSessionId,
    events: readonly {
      readonly at: Date;
      readonly event: ShellAuditEvent;
    }[],
  ): Promise<number> {
    return machineStore.appendShellEvents(this.#database, sessionId, events);
  }
  async listActiveShellSessions(runnerId: RunnerId): Promise<readonly ShellSessionSummary[]> {
    return machineStore.listActiveShellSessions(this.#database, runnerId);
  }
  async listShellHistory(input: {
    readonly before?: string;
    readonly limit: number;
    readonly runnerId: RunnerId;
  }): Promise<{
    readonly nextCursor: string | null;
    readonly sessions: readonly ShellSessionHistoryRecord[];
  }> {
    return machineStore.listShellHistory(this.#database, input);
  }
  async listPendingRunnerEnrollments(
    input: Parameters<typeof runnerStore.listPendingRunnerEnrollments>[1],
  ): Promise<readonly PendingRunnerEnrollmentRecord[]> {
    return runnerStore.listPendingRunnerEnrollments(this.#database, input);
  }
  async retireRunnerEnrollment(input: {
    readonly enrollmentId: string;
    readonly ownerId: UserId;
  }): Promise<"consumed" | "expired" | "retired"> {
    return runnerStore.retireRunnerEnrollment(this.#database, input);
  }
  async ensureBootstrapRunnerEnrollment(input: {
    readonly allowedModules: readonly RunnerModuleName[];
    readonly createdBy: UserId;
    readonly id: string;
    readonly tokenHash: string;
  }): Promise<void> {
    return runnerStore.ensureBootstrapRunnerEnrollment(this.#database, input);
  }
  async createRunnerEnrollment(input: {
    readonly issuanceModules?: readonly RunnerModuleName[];
    readonly initialAccess?: import("@opensteer/protocol").DeviceInitialAccess;
    readonly preparedIdentity?: import("@opensteer/protocol").DevicePreparedIdentity;
    readonly deviceProfile?: import("@opensteer/protocol").RunnerDeviceProfile;
    /**
     * The exact modules the computer redeeming this token may advertise.
     * Issuance chooses the grant; installing newer software cannot widen it.
     */
    readonly allowedModules: readonly RunnerModuleName[];
    /** Null when the deployment authored this enrollment for its own Main Runner. */
    readonly createdBy: UserId | null;
    readonly expiresAt: Date;
    readonly id: string;
    readonly idempotencyKey: string;
    readonly mainEnrollmentPurpose?: "initial" | "replacement";
    readonly configuredInitial?: true;
    readonly name: string;
    /**
     * The person whose work runs on a managed Runner. Administration stays
     * with the deployment (`ownerKind` is still 'deployment'), so this is only
     * an execution binding. Omitted for an admin-enrolled managed Runner, which
     * has no owning user and stays shared.
     */
    readonly ownerUserId?: UserId;
    readonly requestFingerprint: string;
    readonly runnerKind: "main" | "local" | "managed";
    readonly tokenHash: string;
  }): Promise<RunnerEnrollmentIssuanceRecord> {
    return runnerStore.createRunnerEnrollment(this.#database, input);
  }
  async enrollRunnerConnection(input: {
    readonly descriptor: RunnerDescriptor;
    readonly enrollmentTokenHash: string;
    readonly publicKeyFingerprint: string;
    readonly publicKeyPem: string;
  }): Promise<RunnerConnectionRecord> {
    return runnerStore.enrollRunnerConnection(this.#database, input);
  }
  async setRunnerShellFullDiskAccess(
    runnerId: RunnerId,
    fullDiskAccess: boolean,
    connectionGeneration?: number,
  ): Promise<boolean> {
    return runnerStore.setRunnerShellFullDiskAccess(
      this.#database,
      runnerId,
      fullDiskAccess,
      connectionGeneration,
    );
  }
  async authenticateRunnerConnection(
    descriptor: RunnerDescriptor,
  ): Promise<RunnerConnectionRecord> {
    return runnerStore.authenticateRunnerConnection(this.#database, descriptor);
  }
  async personalRemoteAccessGeneration(): Promise<number | null> {
    return runnerStore.personalRemoteAccessGeneration(this.#database);
  }
  async touchRunnerConnection(input: {
    readonly connectionGeneration: number;
    readonly runnerId: RunnerId;
  }): Promise<boolean> {
    return runnerStore.touchRunnerConnection(this.#database, input);
  }
  async createBrowserProfile(input: {
    readonly homeRunnerId?: RunnerId | null;
    readonly idempotencyKey: string;
    readonly name: string;
    readonly ownerId: UserId;
    readonly purpose?: "person" | "engine-sign-in";
  }): Promise<BrowserProfileRecord> {
    return browserSessionStore.createBrowserProfile(this.#database, input);
  }
  async getBrowserProfile(
    profileId: BrowserProfileId,
    ownerId: UserId,
  ): Promise<BrowserProfileRecord | null> {
    return browserSessionStore.getBrowserProfile(this.#database, profileId, ownerId);
  }
  findActiveBrowserSessionForPerson(ownerId: UserId) {
    return browserSessionStore.findActiveBrowserSessionForPerson(this.#database, ownerId);
  }
  listEligibleBrowserRunners(ownerId: UserId) {
    return listEligibleBrowserRunners(this.#database, ownerId);
  }
  async listBrowserProfiles(ownerId: UserId): Promise<readonly BrowserProfileRecord[]> {
    return browserSessionStore.listBrowserProfiles(this.#database, ownerId);
  }
  async renameBrowserProfile(input: {
    readonly administration?: AdministrationCommandIdentity | undefined;
    readonly name: string;
    readonly ownerId: UserId;
    readonly profileId: BrowserProfileId;
  }): Promise<BrowserProfileRecord> {
    return browserSessionStore.renameBrowserProfile(this.#database, input);
  }
  async deleteBrowserProfile(input: {
    readonly administration?: AdministrationCommandIdentity | undefined;
    readonly ownerId: UserId;
    readonly profileId: BrowserProfileId;
  }) {
    return browserSessionStore.deleteBrowserProfile(this.#database, input);
  }
  bindBrowserProfile(binding: import("@opensteer/protocol").LocalProfileBinding) {
    return browserProfileStorageStore.bindBrowserProfile(this.#database, binding);
  }
  acknowledgeBrowserProfileReady(binding: import("@opensteer/protocol").LocalProfileBinding) {
    return browserProfileStorageStore.acknowledgeBrowserProfileReady(this.#database, binding);
  }
  getBrowserProfileStorage(
    input: Parameters<typeof browserProfileStorageStore.getBrowserProfileStorage>[1],
  ) {
    return browserProfileStorageStore.getBrowserProfileStorage(this.#database, input);
  }
  listBrowserProfileErasureJobs(
    input: Parameters<typeof browserProfileStorageStore.listBrowserProfileErasureJobs>[1],
  ) {
    return browserProfileStorageStore.listBrowserProfileErasureJobs(this.#database, input);
  }
  listPendingBrowserProfileDeletions(
    input: Parameters<typeof browserProfileStorageStore.listPendingBrowserProfileDeletions>[1],
  ) {
    return browserProfileStorageStore.listPendingBrowserProfileDeletions(this.#database, input);
  }
  acknowledgeBrowserProfileDeletion(
    input: Parameters<typeof browserProfileStorageStore.acknowledgeBrowserProfileDeletion>[1],
  ) {
    return browserProfileStorageStore.acknowledgeBrowserProfileDeletion(this.#database, input);
  }
  reconcileBrowserProfileInventory(
    input: Parameters<typeof browserProfileStorageStore.reconcileBrowserProfileInventory>[1],
  ) {
    return browserProfileStorageStore.reconcileBrowserProfileInventory(this.#database, input);
  }
  async createBrowserSession(input: {
    readonly ownerId: UserId;
    readonly tabGroupId?: BrowserSessionId;
    readonly opener?: BrowserSessionOpenerRecord | null;
    readonly id: BrowserSessionId;
    readonly placementKey: string;
    readonly runnerId: RunnerId;
    readonly origin: "agent" | "trigger";
    readonly profileId: BrowserProfileId | null;
    readonly runtimeId: string;
    readonly pooled?: true;
  }): Promise<BrowserSessionRecord> {
    return browserSessionStore.createBrowserSession(this.#database, input);
  }
  async getBrowserTabOpen(ownerId: UserId, key: string) {
    return browserSessionStore.getBrowserTabOpen(this.#database, ownerId, key);
  }
  async bindBrowserTabOpen(input: Parameters<typeof browserSessionStore.bindBrowserTabOpen>[1]) {
    return browserSessionStore.bindBrowserTabOpen(this.#database, input);
  }
  async settleBrowserTabOpen(binding: BrowserTabOpenBinding) {
    return browserSessionStore.settleBrowserTabOpen(this.#database, binding);
  }
  async rememberedBrowserPlacement(ownerId: UserId, identityKey: string) {
    return browserSessionStore.rememberedBrowserPlacement(this.#database, ownerId, identityKey);
  }
  async browserSessionOpenerForBinding(agentBindingId: string, ownerId: UserId) {
    return browserSessionStore.browserSessionOpenerForBinding(
      this.#database,
      agentBindingId,
      ownerId,
    );
  }
  /** A session's open catalog tabs and its Run bindings' eligibility, from one snapshot. */
  async readBrowserSessionCut(
    ownerId: UserId,
    sessionId: BrowserSessionId,
    surfaces: readonly string[] = [],
  ) {
    return browserSessionStore.readBrowserSessionCut(this.#database, ownerId, sessionId, surfaces);
  }
  async countBrowserSessionAttachments(sessionId: BrowserSessionId): Promise<number> {
    return browserSessionStore.countBrowserSessionAttachments(this.#database, sessionId);
  }
  async getThreadBrowserUsage(input: {
    readonly ownerId: UserId;
    readonly threadId: ThreadId;
    readonly runIds: readonly RunId[];
  }): Promise<readonly BrowserSessionUsageProjection[]> {
    return browserSessionStore.getThreadBrowserUsage(this.#database, input);
  }
  async recordBrowserSessionUse(input: {
    readonly sessionId: BrowserSessionId;
    readonly threadId: ThreadId;
    readonly ownerId: UserId;
    readonly tabId?: string | null;
    readonly page?: browserSessionStore.BrowserUsePage | null;
  }): Promise<readonly browserSessionStore.BrowserUsageCredit[]> {
    return browserSessionStore.recordBrowserSessionUse(this.#database, input);
  }
  async authorizedPlaceThreadIds(ownerId: UserId, threadIds: readonly ThreadId[]) {
    return browserSessionStore.authorizedPlaceThreadIds(this.#database, ownerId, threadIds);
  }
  async resolvePlaceActors(input: Parameters<typeof browserSessionStore.resolvePlaceActors>[1]) {
    return browserSessionStore.resolvePlaceActors(this.#database, input);
  }
  async listBrowserPlaceHoldings(sessionId: BrowserSessionId) {
    return browserSessionStore.listBrowserPlaceHoldings(this.#database, sessionId);
  }
  async resolvePlaceActor(input: { readonly agentBindingId: string; readonly ownerId: UserId }) {
    return browserSessionStore.resolvePlaceActor(this.#database, input);
  }
  recordRunTabPlace(input: Parameters<typeof browserSessionStore.recordRunTabPlace>[1]) {
    return browserSessionStore.recordRunTabPlace(this.#database, input);
  }
  latestRunPlace(runId: RunId) {
    return browserSessionStore.latestRunPlace(this.#database, runId);
  }
  async recordAgentBrowserUse(input: {
    readonly agentBindingId: string;
    readonly ownerId: UserId;
    readonly sessionId: BrowserSessionId;
    readonly tabId: string | null;
    readonly page: browserSessionStore.BrowserUsePage | null;
  }): Promise<readonly browserSessionStore.BrowserUsageCredit[]> {
    return browserSessionStore.recordAgentBrowserUse(this.#database, input);
  }
  async listBrowserSessionViewers(sessionId: BrowserSessionId): Promise<{
    readonly userIds: readonly UserId[];
  } | null> {
    return browserSessionStore.listBrowserSessionViewers(this.#database, sessionId);
  }

  async listActiveBrowserSessionsForAgentBinding(
    agentBindingId: string,
  ): Promise<readonly BrowserSessionRecord[]> {
    return browserSessionStore.listActiveBrowserSessionsForAgentBinding(
      this.#database,
      agentBindingId,
    );
  }
  listBrowserSessionAttachmentBindings(sessionId: BrowserSessionId): Promise<readonly string[]> {
    return browserSessionStore.listBrowserSessionAttachmentBindings(this.#database, sessionId);
  }
  async listAttachedRunIdsForBrowserSessions(
    sessionIds: readonly BrowserSessionId[],
  ): Promise<ReadonlyMap<BrowserSessionId, readonly RunId[]>> {
    return browserSessionStore.listAttachedRunIdsForBrowserSessions(this.#database, sessionIds);
  }
  async attachBrowserSession(input: {
    readonly agentBindingId: string;
    readonly ownerId: UserId;
    readonly sessionId: BrowserSessionId;
    readonly pool?: import("./browser-pool-store.js").BrowserPoolTargetIdentity;
  }): Promise<boolean> {
    return browserSessionStore.attachBrowserSession(this.#database, input);
  }
  async detachBrowserSessionAttachments(
    agentBindingId: string,
  ): Promise<readonly BrowserSessionId[]> {
    return browserSessionStore.detachBrowserSessionAttachments(this.#database, agentBindingId);
  }

  async findBrowserSessionHoldingProfilePlacement(
    profileId: BrowserProfileId,
  ): Promise<BrowserSessionRecord | null> {
    return browserSessionStore.findBrowserSessionHoldingProfilePlacement(this.#database, profileId);
  }
  async getBrowserSessionForOwner(
    sessionId: BrowserSessionId,
    ownerId: UserId,
  ): Promise<BrowserSessionRecord | null> {
    return browserSessionStore.getBrowserSessionForOwner(this.#database, sessionId, ownerId);
  }
  async listBrowserSessions(ownerId: UserId): Promise<readonly BrowserSessionRecord[]> {
    return browserSessionStore.listBrowserSessions(this.#database, ownerId);
  }
  async listBrowserSessionThreads(input: {
    readonly ownerId: UserId;
    readonly sessionIds: readonly BrowserSessionId[];
  }): Promise<ReadonlyMap<BrowserSessionId, readonly ThreadId[]>> {
    return browserSessionStore.listBrowserSessionThreads(this.#database, input);
  }
  async listActiveBrowserSessionsForAgent(input: {
    readonly ownerId: UserId;
  }): Promise<readonly BrowserSessionWithAttachmentCountRecord[]> {
    return browserSessionStore.listActiveBrowserSessionsForAgent(this.#database, input);
  }
  async failActiveBrowserSessions(placementKey?: string, pooledRunner?: RunnerId) {
    return browserSessionStore.failActiveBrowserSessions(
      this.#database,
      placementKey,
      pooledRunner,
    );
  }
  async transitionBrowserSession(input: {
    readonly from?: readonly HostedBrowserSessionState[];
    readonly sessionId: BrowserSessionId;
    readonly state: HostedBrowserSessionState;
  }) {
    return browserSessionStore.transitionBrowserSession(this.#database, input);
  }
  async renewActiveExecutionBindings(input: {
    readonly activeRunIds: readonly RunId[];
    readonly leaseExpiresAt: Date;
    readonly runnerBootId: string;
    readonly runnerId: RunnerId;
  }): Promise<readonly RunId[]> {
    return executionStore.renewActiveExecutionBindings(this.#database, input, this.#executionNow);
  }
  async createHarnessInstance(input: CreateHarnessInstanceInput): Promise<HarnessInstanceRecord> {
    return harnessStore.createHarnessInstance(this.#database, input);
  }
  async credentialVaultCanary(keyVersion: number): Promise<{
    readonly encryptedPayload: Buffer;
    readonly keyVersion: number;
  } | null> {
    return credentialStore.credentialVaultCanary(this.#database, keyVersion);
  }
  async createCredentialVaultCanary(input: {
    readonly encryptedPayload: Buffer;
    readonly keyVersion: number;
  }): Promise<void> {
    return credentialStore.createCredentialVaultCanary(this.#database, input);
  }
  async getCredential(credentialId: CredentialId): Promise<CredentialRecord | null> {
    return credentialStore.getCredential(this.#database, credentialId);
  }
  async channelCredentialForReplacement(
    connectionId: IntegrationConnectionId,
    ownerId: UserId,
  ): Promise<{
    readonly credentialId: CredentialId;
    readonly name: string;
    readonly provider: string;
    readonly externalTenantId: string | null;
    readonly runnerId: RunnerId;
    readonly transportKind: ChannelTransportKind;
  } | null> {
    return credentialStore.channelCredentialForReplacement(this.#database, connectionId, ownerId);
  }
  async replaceChannelCredential(input: {
    readonly connectionId: IntegrationConnectionId;
    readonly credentialId: CredentialId;
    readonly encryptedPayload: Buffer;
    readonly encryptionKeyVersion: number;
    readonly ownerId: UserId;
  }): Promise<RunnerId> {
    return credentialStore.replaceChannelCredential(this.#database, input);
  }

  resolveResourceAccess(input: ResourceAccessInput) {
    return resolveResourceAccess(this.#database, input);
  }

  /** A binding's immutable connection; null for the person's own work. */
  bindingAgentConnectionId(bindingId: string) {
    return bindingAgentConnectionId(this.#database, bindingId);
  }

  /** Is this execution still allowed at all? See `admitExecution`. */
  admitExecution(input: Parameters<typeof admitExecution>[1]) {
    return admitExecution(this.#database, input);
  }

  connectionCdpAttempts() {
    return connectionCdpAttempts(this.#database);
  }

  recoverConnectionCdpAttempts() {
    return recoverConnectionCdpAttempts(this.#database);
  }

  recordConnectionRunHandoff(input: Parameters<typeof recordConnectionRunHandoff>[1]) {
    return recordConnectionRunHandoff(this.#database, input);
  }

  recordRunNotAdmitted(runId: RunId, bindingGeneration: number) {
    return recordRunNotAdmitted(this.#database, runId, bindingGeneration);
  }

  markConnectionAttemptsContactLost(
    input: Parameters<typeof markConnectionAttemptsContactLost>[1],
  ) {
    return markConnectionAttemptsContactLost(this.#database, input);
  }

  connectionStopId = connectionStopId;

  async driveConnectionCleanups(
    options: {
      readonly stopper?: ConnectionAttemptStopper;
      readonly onCleanup?: (cleanup: ConnectionCleanup) => Promise<void>;
    } = {},
  ): Promise<{
    readonly failures: readonly unknown[];
    readonly settled: readonly string[];
  }> {
    await requestExpiredCleanups(this.#database);
    const failures: unknown[] = [];
    const settled: string[] = [];
    const step = async (work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        failures.push(error);
      }
    };
    for (const connectionId of await openCleanups(this.#database)) {
      const cleanup = await claimConnectionCleanup(this.#database, connectionId);
      if (!cleanup) continue;
      const { userId, token, reason } = cleanup;
      try {
        const attempts = outstandingAttempts(
          await connectionAttempts(this.#database, connectionId),
        );
        for (const attempt of attempts) {
          if (attempt.kind !== "session") continue;
          await step(() =>
            commitPersonalMutation(this.#database, async (tx) => {
              if (await renewConnectionCleanupClaim(tx, cleanup))
                await endAgentSessions(tx, { userId, sessionIds: [attempt.id], reason });
            }),
          );
        }
        if (attempts.length || cleanup.pending) {
          if (options.onCleanup) await step(() => options.onCleanup!(cleanup));
        }
        for (const attempt of attempts) {
          if (attempt.kind === "session") continue;
          if (!(await renewConnectionCleanupClaim(this.#database, cleanup))) break;
          const key = `connection-stop:${connectionId}:${attempt.kind}:${attempt.id}:${attempt.generation ?? "local"}`;
          const mutate = (
            work: (tx: import("kysely").Transaction<DatabaseSchema>) => Promise<unknown>,
            idempotent = false,
          ) =>
            step(() =>
              commitPersonalMutation(this.#database, async (tx) => {
                if (idempotent) await lockCommandIdempotency(tx, userId, key);
                if (await renewConnectionCleanupClaim(tx, cleanup)) await work(tx);
              }),
            );
          const stop = () =>
            step(async () => {
              const result = await options.stopper?.stop(attempt, cleanup);
              if (result) await recordConnectionStop(this.#database, cleanup, attempt, result);
            });
          switch (attempt.kind) {
            case "request":
              await step(() => settleLineageRequests(this.#database, [attempt.id], cleanup));
              break;
            case "input":
              await mutate(
                (tx) =>
                  threadStore.cancelThreadInput(tx, {
                    threadId: attempt.threadId!,
                    messageId: attempt.id,
                    idempotencyKey: key,
                    requestedBy: userId,
                  }),
                true,
              );
              break;
            case "trigger":
              await mutate((tx) => pauseLineageTrigger(tx, attempt.id));
              break;
            case "steer":
              if (!attempt.handedOff)
                await mutate((tx) =>
                  commandStore.refuseSteer(
                    tx,
                    attempt.id,
                    "The connected agent's access ended before this message could be delivered.",
                    undefined,
                    true,
                  ),
                );
              break;
            case "run":
            case "run-attempt": {
              const runId = attempt.kind === "run" ? attempt.id : attempt.runId;
              const row = await this.#database
                .selectFrom("runs")
                .innerJoin("threads", "threads.id", "runs.threadId")
                .select(["runs.bindingGeneration", "runs.status", "threads.originConnectionId"])
                .where("runs.id", "=", runId)
                .executeTakeFirst();
              const canEnqueue =
                row &&
                row.bindingGeneration === attempt.generation &&
                ["queued", "starting", "running", "waiting"].includes(row.status);
              if (canEnqueue)
                await mutate(
                  (tx) =>
                    commandStore.enqueueRunnerControlInTransaction(tx, this.#links, {
                      type: "run.interrupt",
                      idempotencyKey: key,
                      requestedBy: userId,
                      runId,
                      threadId: attempt.threadId!,
                      expectedBindingGeneration: attempt.generation,
                      ...(attempt.runnerBootId
                        ? {
                            stop: { id: connectionStopId(attempt), bootId: attempt.runnerBootId },
                          }
                        : {}),
                      ...(reason === "narrowed" || row.originConnectionId !== connectionId
                        ? { keepQueueRunning: true }
                        : {}),
                    }),
                  true,
                );
              if (attempt.kind === "run-attempt") await stop();
              break;
            }
            case "occurrence":
              if (attempt.handedOff) {
                await stop();
              } else {
                const row = await this.#database
                  .selectFrom("triggerOccurrences")
                  .select("triggerId")
                  .where("id", "=", attempt.id)
                  .executeTakeFirst();
                if (row)
                  await mutate((tx) =>
                    new TriggerStore(tx).cancelPendingOccurrences(userId, {
                      actorThreadId: null,
                      triggerId: row.triggerId,
                      occurrenceId: attempt.id,
                    }),
                  );
              }
              break;
            case "watch":
              await mutate((tx) =>
                new TriggerStore(tx).stopConnectionWatch(attempt.id, attempt.generation!),
              );
              if (attempt.handedOff) await stop();
              break;
            case "chat":
              await mutate((tx) => stopChatAttempt(tx, attempt.id));
              break;
            case "operation":
              if (!attempt.handedOff)
                await mutate((tx) =>
                  refuseUnsentAgentOperation(tx, attempt.id, attempt.generation!),
                );
              else if (options.stopper?.stopDirectOperation)
                await step(() => options.stopper!.stopDirectOperation!(attempt, cleanup));
              break;
            default:
              await stop();
              break;
          }
        }
        if (await completeCleanupIfSettled(this.#database, cleanup)) settled.push(connectionId);
      } finally {
        await releaseConnectionCleanupClaim(this.#database, connectionId, token);
      }
    }
    return { failures, settled };
  }

  /** Each automation's origin connection, for lineage visibility. */
  async triggerOrigins(
    ownerId: UserId,
    ids: readonly TriggerId[],
  ): Promise<ReadonlyMap<TriggerId, string | null>> {
    if (!ids.length) return new Map();
    const rows = await this.#database
      .selectFrom("triggers")
      .select(["id", "originConnectionId"])
      .where("createdBy", "=", ownerId)
      .where("id", "in", [...ids])
      .execute();
    return new Map(rows.map((row) => [row.id, row.originConnectionId]));
  }

  /** Each task's origin connection, for lineage visibility. */
  async threadOrigins(ids: readonly ThreadId[]): Promise<ReadonlyMap<ThreadId, string | null>> {
    if (!ids.length) return new Map();
    const rows = await this.#database
      .selectFrom("threads")
      .select(["id", "originConnectionId"])
      .where("id", "in", [...ids])
      .execute();
    return new Map(rows.map((row) => [row.id, row.originConnectionId]));
  }

  async recordChannelCredentialAccess(input: {
    readonly runnerId: RunnerId;
    readonly connectionId: IntegrationConnectionId;
    readonly credentialId: CredentialId;
    readonly purpose: "channel-delivery" | "channel-transport" | "channel-webhook";
  }): Promise<void> {
    return credentialStore.recordChannelCredentialAccess(this.#database, input);
  }
  async listHarnessInstances(
    options: {
      readonly environmentIds?: readonly EnvironmentId[];
      /**
       * Tombstones too. Only one caller wants them: the seeding pass that
       * creates a default profile for a driver the first time a Runner
       * advertises it. A tombstone is the Host's durable record that somebody
       * already removed that profile, and reading past it is what made a
       * removed profile reappear on the next reconnect.
       */
      readonly includeRemoved?: boolean;
      readonly limit?: number;
    } = {},
  ): Promise<readonly HarnessInstanceRecord[]> {
    return harnessStore.listHarnessInstances(this.#database, options);
  }
  async listAgentHarnessInstancesForUser(
    userId: UserId,
    options: {
      readonly includeDisabled?: boolean;
      readonly environmentId?: EnvironmentId;
      readonly afterId?: HarnessInstanceId;
      readonly id?: HarnessInstanceId;
      readonly limit?: number;
    } = {},
  ): Promise<readonly HarnessInstanceRecord[]> {
    return harnessStore.listAgentHarnessInstancesForUser(this.#database, userId, options);
  }
  async getHarnessInstance(id: HarnessInstanceId): Promise<HarnessInstanceRecord | null> {
    return harnessStore.getHarnessInstance(this.#database, id);
  }
  replayAdministrationCommand(identity: AdministrationCommandIdentity) {
    return replayAdministrationCommand(this.#database, identity);
  }
  async updateHarnessInstance(input: {
    readonly administration?: AdministrationCommandIdentity | undefined;
    readonly config?: unknown;
    readonly expectedRuntimeRevision?: number;
    readonly enabled?: boolean;
    readonly id: HarnessInstanceId;
    readonly name?: string;
  }): Promise<HarnessInstanceRecord> {
    return harnessStore.updateHarnessInstance(this.#database, input);
  }
  async setDefaultHarnessInstance(input: {
    readonly administration?: AdministrationCommandIdentity | undefined;
    readonly environmentId: EnvironmentId;
    readonly harnessInstanceId: HarnessInstanceId;
  }): Promise<HarnessInstanceRecord> {
    return harnessStore.setDefaultHarnessInstance(this.#database, input);
  }
  async removeHarnessInstance(
    environmentId: EnvironmentId,
    harnessInstanceId: HarnessInstanceId,
  ): Promise<HarnessInstanceRecord> {
    return harnessStore.removeHarnessInstance(this.#database, environmentId, harnessInstanceId);
  }
  async recordHarnessCatalogs(input: {
    readonly catalogs: readonly HarnessInstanceCatalog[];
    readonly environmentId: EnvironmentId;
    readonly expectedRevisions: ReadonlyMap<HarnessInstanceId, number>;
    readonly connectionGeneration?: number;
  }): Promise<readonly HarnessInstanceCatalog[]> {
    return harnessStore.recordHarnessCatalogs(this.#database, input);
  }
  async discardHarnessCatalog(
    environmentId: EnvironmentId,
    harnessInstanceId: HarnessInstanceId,
    connectionGeneration?: number,
  ): Promise<void> {
    return harnessStore.discardHarnessCatalog(
      this.#database,
      environmentId,
      harnessInstanceId,
      connectionGeneration,
    );
  }
  async listHarnessCatalogs(
    environmentIds: readonly EnvironmentId[],
    harnessInstanceIds?: readonly HarnessInstanceId[],
  ): Promise<readonly HarnessCatalogRecord[]> {
    return harnessStore.listHarnessCatalogs(this.#database, environmentIds, harnessInstanceIds);
  }
  async getHarnessCatalog(
    environmentId: EnvironmentId,
    harnessInstanceId: HarnessInstanceId,
  ): Promise<HarnessInstanceCatalog | null> {
    return harnessStore.getHarnessCatalog(this.#database, environmentId, harnessInstanceId);
  }
  /** The last valid settings.json in Agent home, and the file's current status. */
  async getAgentHomeSettings(userId: UserId) {
    return readAgentHomeSettings(this.#database, userId);
  }
  async getExecutionPreferences(userId: UserId): Promise<ExecutionPreferences> {
    return harnessStore.getExecutionPreferences(this.#database, userId);
  }
  async rememberExecutionChoice(
    userId: UserId,
    choice: ExecutionChoice,
    administration?: AdministrationCommandIdentity | undefined,
  ): Promise<ExecutionPreferences> {
    return harnessStore.rememberExecutionChoice(this.#database, userId, choice, administration);
  }
  async hasActiveRunForHarness(
    environmentId: EnvironmentId,
    harnessInstanceId: HarnessInstanceId,
  ): Promise<boolean> {
    return harnessStore.hasActiveRunForHarness(this.#database, environmentId, harnessInstanceId);
  }
  async isRunActive(runId: RunId): Promise<boolean> {
    return executionStore.isRunActive(this.#database, runId);
  }
  async listEnvironments(limit = 1_000): Promise<readonly ExecutionEnvironmentRecord[]> {
    return environmentStore.listEnvironments(this.#database, limit);
  }
  async listEnvironmentsForUser(
    userId: UserId,
    limit = 1_000,
    page?: Parameters<typeof environmentStore.listEnvironmentsForUser>[3],
  ): Promise<readonly ExecutionEnvironmentRecord[]> {
    return environmentStore.listEnvironmentsForUser(this.#database, userId, limit, page);
  }
  async environmentIsAvailableToUser(
    environmentId: EnvironmentId,
    userId: UserId,
  ): Promise<boolean> {
    return environmentStore.environmentIsAvailableToUser(this.#database, environmentId, userId);
  }
  async getEnvironment(id: EnvironmentId): Promise<ExecutionEnvironmentRecord | null> {
    return environmentStore.getEnvironment(this.#database, id);
  }
  async assignEnvironmentRunner(environmentId: EnvironmentId, runnerId: RunnerId): Promise<void> {
    return environmentStore.assignEnvironmentRunner(this.#database, environmentId, runnerId);
  }

  /** The name of the computer a personal Deployment runs on; null before it has one. */
  async homeComputerName(): Promise<string | null> {
    const row = await this.#database
      .selectFrom("runners")
      .select("name")
      .where("kind", "=", "main")
      .where("ownerKind", "=", "deployment")
      .where("revokedAt", "is", null)
      .executeTakeFirst();
    return row?.name ?? null;
  }

  async countLiveThreadsByEnvironment(
    environmentIds: readonly EnvironmentId[],
  ): Promise<ReadonlyMap<EnvironmentId, number>> {
    if (environmentIds.length === 0) return new Map();
    return countPlacedThreads(this.#database, environmentIds);
  }

  async listThreadsForOwner(ownerId: UserId, limit = 10_000): Promise<readonly Thread[]> {
    return threadStore.listThreadsForOwner(this.#database, ownerId, limit);
  }
  async ownerThreadPageForOwner(input: {
    readonly before?: string;
    readonly maxBytes?: number;
    readonly maxItems?: number;
    readonly ownerId: UserId;
  }): Promise<OwnerThreadPage> {
    return threadStore.ownerThreadPageForOwner(this.#database, input);
  }

  /** The task a Run works on, if any: who assigned it and whether it is still open. */
  async runAssignment(runId: RunId): Promise<{
    readonly assignerThreadId: ThreadId;
    readonly open: boolean;
  } | null> {
    const row = await this.#database
      .selectFrom("runs")
      .innerJoin("delegations", "delegations.id", "runs.assignmentId")
      .select(["delegations.parentThreadId", "delegations.status"])
      .where("runs.id", "=", runId)
      .whereRef("delegations.childThreadId", "=", "runs.threadId")
      .executeTakeFirst();
    return row
      ? {
          assignerThreadId: row.parentThreadId,
          open: row.status === "open",
        }
      : null;
  }
  async getAssignment(id: AssignmentId): Promise<AssignmentView | null> {
    return threadStore.getAssignment(this.#database, id);
  }
  async getAssignmentForOwner(input: {
    readonly assignmentId: AssignmentId;
    readonly ownerId: UserId;
    readonly reader: TaskReader;
  }): Promise<AssignmentView | null> {
    return threadStore.getAssignmentForOwner(this.#database, input);
  }
  async listThreadAssignmentsForOwner(input: {
    readonly before?: string;
    readonly maxBytes?: number;
    readonly maxItems?: number;
    readonly open?: boolean;
    readonly ownerId: UserId;
    readonly threadId: ThreadId;
  }): Promise<{
    readonly assignments: readonly AssignmentSummary[];
    readonly window: DurableWindow;
  } | null> {
    return threadStore.listThreadAssignmentsForOwner(this.#database, input);
  }
  async agentThreadPageForOwner(input: {
    readonly before?: string;
    readonly maxBytes?: number;
    readonly maxItems?: number;
    readonly ownerId: UserId;
    readonly query?: string;
    readonly scope: AgentThreadListScope;
    readonly scopeId: string;
    readonly parentThreadId?: ThreadId;
    readonly changedSince?: Date;
    readonly nativeOnly?: boolean;
    readonly reader: TaskReader;
  }): Promise<AgentThreadListPage> {
    return threadStore.agentThreadPageForOwner(this.#database, input);
  }
  /** A task as the person reads it; work reading a task reads it through `readTask`. */
  async getThreadForOwner(
    threadId: ThreadId,
    ownerId: UserId,
    lineageConnectionId?: string,
    nativeOnly?: boolean,
  ): Promise<Thread | null> {
    return threadStore.getThreadForOwner(
      this.#database,
      threadId,
      ownerId,
      lineageConnectionId,
      nativeOnly,
    );
  }
  /** A task as its reader may see it; one it may not read is null, as a missing one. */
  async readTask(
    reader: TaskReader,
    threadId: ThreadId,
    ownerId: UserId,
    options?: Parameters<typeof threadStore.readTask>[4],
  ): Promise<Thread | null> {
    return threadStore.readTask(this.#database, reader, threadId, ownerId, options);
  }

  /** A Run's attempts and subagents, for a person who can read its Thread; null otherwise. */
  async listRunAttemptsForOwner(input: {
    readonly ownerId: UserId;
    readonly runId: RunId;
  }): Promise<{
    readonly attempts: readonly RunAttempt[];
    readonly nodes: readonly ExecutionNode[];
  } | null> {
    const run = await this.#database
      .selectFrom("runs")
      .select("threadId")
      .where("id", "=", input.runId)
      .executeTakeFirst();
    if (!run || !(await this.getThreadForOwner(run.threadId, input.ownerId))) return null;
    return {
      attempts: (await listRunAttempts(this.#database, input.runId)).map(runAttemptFromRow),
      nodes: (await listRunNodes(this.#database, input.runId)).map(executionNodeFromRow),
    };
  }
  admitRunToolCall(input: RunToolAdmissionInput): Promise<RunToolAdmissionResult> {
    return threadStore.admitRunToolCall(this.#database, input, this.#executionNow);
  }
  admitTriggerControlRequest(
    input: TriggerControlAdmissionInput,
  ): Promise<TriggerControlAdmissionResult> {
    return threadStore.admitTriggerControlRequest(this.#database, input);
  }
  async readThreadForOwner(
    threadId: ThreadId,
    ownerId: UserId,
    maxMessages = 100,
  ): Promise<OwnedThreadRead | null> {
    return threadStore.readThreadForOwner(this.#database, threadId, ownerId, maxMessages);
  }
  async createThread(input: CreateThreadInput): Promise<ThreadCreationResult> {
    return threadStore.createThread(this.#database, input);
  }
  async findDelegatedThreadByIdempotency(
    input: DelegateThreadRequest,
  ): Promise<DelegatedThreadResult | null> {
    return threadStore.findDelegatedThreadByIdempotency(this.#database, input);
  }
  hasHumanIncludedPlace(threadId: ThreadId, part: PlaceContentPart): Promise<boolean> {
    return threadStore.hasHumanIncludedPlace(this.#database, threadId, part);
  }
  async delegateThread(input: DelegateThreadRequest): Promise<DelegatedThreadResult> {
    return threadStore.delegateThread(this.#database, input);
  }
  async delegateAdmittedThread(
    request: AdmittedThreadDelegationRequest,
  ): Promise<DelegatedThreadResult> {
    return threadStore.delegateAdmittedThread(this.#database, request, this.#executionNow);
  }
  assignmentTreeThreadIds(assignmentId: AssignmentId): Promise<readonly ThreadId[]> {
    return assignmentTreeThreadIds(this.#database, assignmentId);
  }
  async cancelAssignment(
    input: CancelAssignmentInput & {
      readonly admission?: RunToolAdmissionInput;
    },
  ): Promise<CancelAssignmentResult> {
    return this.#announceRevokedGrants(
      await threadStore.cancelAssignment(this.#database, this.#links, input, this.#executionNow),
    );
  }
  drainPendingAssignmentReturns(limit?: number): Promise<AssignmentReturnDrain> {
    return threadStore.drainPendingAssignmentReturns(this.#database, limit);
  }
  onAssignmentReturnReady(wake: (assignmentId: AssignmentId) => void | Promise<void>) {
    return installAssignmentReturnWake(this.#database, wake);
  }
  drainAssignmentReturn(assignmentId: AssignmentId): Promise<"settled" | "waiting" | "held"> {
    return threadStore.drainAssignmentReturn(this.#database, assignmentId);
  }
  async updateThreadExecutionSelection(input: {
    readonly continuationIdentity: ProviderContinuationIdentity;
    readonly continuation?: {
      readonly expectedProviderSessionId: ProviderSessionId | null;
    };
    readonly harnessInstanceId: HarnessInstanceId;
    readonly idempotencyKey: string;
    readonly modelSelection: ModelSelection;
    readonly requestedBy: UserId;
    readonly threadId: ThreadId;
  }): Promise<{
    readonly asOfSequence: Sequence;
    readonly thread: Thread;
    readonly wasDuplicate: boolean;
  }> {
    return threadStore.updateThreadExecutionSelection(this.#database, input);
  }
  async resumeThreadInputQueue(input: {
    readonly authority?: import("./thread-caller.js").ThreadCallerAuthority;
    readonly idempotencyKey: string;
    readonly requestedBy: UserId;
    readonly threadId: ThreadId;
  }): Promise<{
    readonly asOfSequence: Sequence;
    readonly thread: Thread;
  }> {
    return threadStore.resumeThreadInputQueue(this.#database, input);
  }
  doneScopeThreadIds(threadId: ThreadId): Promise<readonly ThreadId[]> {
    return taskDone.doneScopeThreadIds(this.#database, threadId);
  }
  listQuietTasks(input: Parameters<typeof quietTasks.listQuietTasks>[1]) {
    return quietTasks.listQuietTasks(this.#database, input);
  }
  async setThreadDone(input: Parameters<typeof taskDone.setThreadDone>[2]) {
    return this.#announceRevokedGrants(
      await taskDone.setThreadDone(this.#database, this.#links, input),
    );
  }
  renameThread(input: Parameters<typeof threadStore.renameThread>[1]): Promise<ThreadUpdateResult> {
    return threadStore.renameThread(this.#database, input);
  }
  setThreadIcon(
    input: Parameters<typeof threadStore.setThreadIcon>[1],
  ): Promise<ThreadUpdateResult> {
    return threadStore.setThreadIcon(this.#database, input);
  }
  getThreadNamingInput(threadId: ThreadId) {
    return executionStore.getThreadNamingInput(this.#database, threadId);
  }
  listThreadNamingCandidates(limit = 100, after?: ThreadId) {
    return executionStore.listThreadNamingCandidates(this.#database, limit, after);
  }
  applyGeneratedThreadName(
    input: Parameters<typeof threadStore.applyGeneratedThreadName>[1],
  ): ReturnType<typeof threadStore.applyGeneratedThreadName> {
    return threadStore.applyGeneratedThreadName(this.#database, input);
  }
  async updateThreadAccessMode(input: {
    readonly accessMode: ThreadAccessMode;
    readonly requestedBy: UserId;
    readonly threadId: ThreadId;
  }): Promise<ThreadUpdateResult> {
    return threadStore.updateThreadAccessMode(this.#database, input);
  }
  async findThreadCreationByIdempotency(
    input: CreateThreadInput,
  ): Promise<ThreadCreationResult | null> {
    return threadStore.findThreadCreationByIdempotency(this.#database, input);
  }
  async runPlaceCapabilities(runId: RunId): Promise<readonly string[]> {
    const holder = await this.#database
      .selectFrom("runs")
      .innerJoin("providerSessions", "providerSessions.id", "runs.providerSessionId")
      .innerJoin("runners", "runners.id", "providerSessions.runnerId")
      .select("runners.capabilities")
      .where("runs.id", "=", runId)
      .whereRef("runs.bindingGeneration", "=", "providerSessions.bindingGeneration")
      .executeTakeFirst();
    return holder?.capabilities ?? [];
  }
  async hasAcceptedThreadInput(requestedBy: UserId, idempotencyKey: string): Promise<boolean> {
    return Boolean(
      await this.#database
        .selectFrom("threadInputs")
        .select("messageId")
        .where("requestedBy", "=", requestedBy)
        .where("idempotencyKey", "=", idempotencyKey)
        .executeTakeFirst(),
    );
  }
  async enqueueThreadInput(input: EnqueueThreadInputRequest): Promise<EnqueuedThreadInput> {
    return this.#announceRevokedGrants(await threadStore.enqueueThreadInput(this.#database, input));
  }
  takeThreadInputLease(input: Parameters<typeof waitingInputs.takeThreadInputLease>[1]) {
    return waitingInputs.takeThreadInputLease(this.#database, input);
  }
  renewThreadInputLease(input: Parameters<typeof waitingInputs.renewThreadInputLease>[1]) {
    return waitingInputs.renewThreadInputLease(this.#database, input);
  }
  async releaseThreadInputLease(
    input: Parameters<typeof waitingInputs.releaseThreadInputLease>[1],
  ) {
    return this.#announceRevokedGrants(
      await waitingInputs.releaseThreadInputLease(this.#database, input),
    );
  }
  async editThreadInput(input: Parameters<typeof waitingInputs.editThreadInput>[1]) {
    return this.#announceRevokedGrants(await waitingInputs.editThreadInput(this.#database, input));
  }
  listMessageRevisions(input: Parameters<typeof waitingInputs.listMessageRevisions>[1]) {
    return waitingInputs.listMessageRevisions(this.#database, input);
  }
  async expireThreadInputLeases() {
    const result = this.#announceRevokedGrants(
      await waitingInputs.expireThreadInputLeases(this.#database),
    );
    if (result.failures.length > 0)
      throw new AggregateError(result.failures, "Expiring input edit leases failed");
    return result;
  }
  async steerThreadInput(input: SteerThreadInputRequest): Promise<EnqueuedThreadInput> {
    return this.#announceRevokedGrants(await threadStore.steerThreadInput(this.#database, input));
  }
  async cancelThreadInput(input: CancelThreadInputRequest): Promise<CancelledThreadInput> {
    const result = await threadStore.cancelThreadInput(this.#database, input);
    return this.#announceRevokedGrants({ ...result, revokedGrants: result.revokedGrants ?? [] });
  }
  async moveThreadInput(input: MoveThreadInputRequest): Promise<MovedThreadInput> {
    const result = await threadStore.moveThreadInput(this.#database, input);
    return this.#announceRevokedGrants({ ...result, revokedGrants: result.revokedGrants ?? [] });
  }
  async getThreadInputQueue(input: {
    readonly authority?: import("./thread-caller.js").ThreadCallerAuthority;
    readonly threadId: ThreadId;
    readonly requestedBy: UserId;
    readonly expectedRevision?: string;
    readonly sessionId?: import("@opensteer/core").AuthSessionId;
  }) {
    return threadStore.getThreadInputQueue(this.#database, input);
  }
  async enqueueAdmittedThreadInput(
    request: AdmittedThreadInputRequest,
  ): Promise<EnqueuedThreadInput> {
    return this.#announceRevokedGrants(
      await threadStore.enqueueAdmittedThreadInput(this.#database, request, this.#executionNow),
    );
  }
  stopNode(input: import("./node-control.js").NodeStopInput) {
    return enqueueNodeStop(this.#database, input);
  }
  async enqueueRunnerControl(input: RunnerControlInput): Promise<{
    readonly command: CommandRow;
    readonly revokedGrants: readonly RevokedRunGrant[];
    readonly wasDuplicate: boolean;
  }> {
    return this.#announceRevokedGrants(
      await commandStore.enqueueRunnerControl(this.#database, this.#links, input),
    );
  }
  async claimNextCommand(
    environmentId: EnvironmentId,
    dispatcherId: string,
  ): Promise<ClaimedCommand | null> {
    return commandStore.claimNextCommand(this.#database, environmentId, dispatcherId);
  }
  async dispatchRequestResponse(
    commandId: CommandRow["id"],
    send: Parameters<typeof commandStore.dispatchRequestResponse>[2],
  ): Promise<void> {
    this.#announceRevokedGrants(
      await commandStore.dispatchRequestResponse(this.#database, commandId, send),
    );
  }
  async listPendingCommands(limit = 500): Promise<readonly PendingCommandRow[]> {
    return commandStore.listPendingCommands(this.#database, limit);
  }
  async claimCommand(
    commandId: CommandRow["id"],
    dispatcherId: string,
  ): Promise<ClaimedCommand | null> {
    return commandStore.claimCommand(this.#database, commandId, dispatcherId);
  }
  async finalizeRunInitialContext(input: {
    readonly commandId: CommandRow["id"];
    readonly messageIds: readonly MessageId[];
  }): Promise<
    | (NonNullable<RunDispatchContext["initialContext"]> & {
        readonly finalized: true;
      })
    | null
  > {
    return executionStore.finalizeRunInitialContext(this.#database, input);
  }
  loadRunThreadState(input: { readonly runId: RunId; readonly viewerId: UserId }) {
    return executionStore.loadRunThreadState(this.#database, input);
  }
  async loadRunDispatchContext(
    commandId: CommandRow["id"],
    options: Parameters<typeof executionStore.loadRunDispatchContext>[2] = {},
  ): Promise<RunDispatchContext> {
    return executionStore.loadRunDispatchContext(this.#database, commandId, options);
  }
  async loadSteerDispatchInput(commandId: CommandRow["id"]): Promise<{
    readonly message: Message;
    readonly origin: import("@opensteer/core").MessageOrigin | undefined;
    readonly run: Run;
    readonly reauthorize?: () => Promise<void>;
    readonly runId: RunId;
    readonly threadId: ThreadId;
  }> {
    return commandStore.loadSteerDispatchInput(this.#database, commandId);
  }
  async retryCommand(commandId: CommandRow["id"], error: unknown): Promise<void> {
    return commandStore.retryCommand(this.#database, this.#links, commandId, error);
  }
  async failCommand(
    commandId: CommandRow["id"],
    publicMessage: string,
    queuedInputCancellation:
      "activation-input" | "authority-cohort" | "seed-input" = "activation-input",
    failureCode: "dispatch_failed" | "runner_restarted" = "dispatch_failed",
  ): Promise<void> {
    return commandStore.failCommand(
      this.#database,
      this.#links,
      commandId,
      publicMessage,
      queuedInputCancellation,
      failureCode,
    );
  }
  async refuseSteer(
    commandId: CommandRow["id"],
    reason: string,
    reasonCode?: string,
  ): Promise<void> {
    return commandStore.refuseSteer(this.#database, commandId, reason, reasonCode);
  }
  async markSteerUnknown(commandId: CommandRow["id"], reason: string): Promise<void> {
    return commandStore.markSteerUnknown(this.#database, commandId, reason);
  }
  async succeedCommand(commandId: CommandRow["id"]): Promise<void> {
    this.#announceRevokedGrants(await commandStore.succeedCommand(this.#database, commandId));
  }
  async acquireExecutionBinding(input: {
    readonly personalContext?: boolean;
    readonly bindingLeaseExpiresAt: Date;
    readonly continuationIdentity: ProviderContinuationIdentity;
    readonly harnessInstanceId: HarnessInstanceId;
    readonly leaseTokenHash: string;
    readonly runnerBootId: string;
    readonly runnerId: RunnerId;
    readonly runId: RunId;
    readonly threadId: ThreadId;
  }): Promise<
    ThreadExecutionBinding & {
      readonly grantId: GrantId;
      readonly revokedGrants: readonly RevokedRunGrant[];
    }
  > {
    return this.#announceRevokedGrants(
      await executionStore.acquireExecutionBinding(this.#database, input),
    );
  }
  async renewExecutionBinding(input: {
    readonly bindingGeneration: number;
    readonly leaseExpiresAt: Date;
    readonly leaseTokenHash: string;
    readonly runnerBootId: string;
    readonly runnerId: RunnerId;
    readonly runId: RunId;
    readonly threadId: ThreadId;
  }): Promise<boolean> {
    return executionStore.renewExecutionBinding(this.#database, input, this.#executionNow);
  }
  async runRequester(input: {
    readonly runId: RunId;
    readonly threadId: ThreadId;
  }): Promise<UserId | null> {
    return executionStore.runRequester(this.#database, input);
  }
  async commitRunnerEvent(input: Parameters<typeof runnerEventStore.commitRunnerEvent>[2]) {
    return this.#announceRevokedGrants(
      await runnerEventStore.commitRunnerEvent(
        this.#database,
        this.#links,
        input,
        this.#executionNow,
      ),
    );
  }
  async assertActiveExecutionBinding(input: {
    readonly bindingGeneration: number;
    readonly environmentId: EnvironmentId;
    readonly requestedBy: UserId;
    readonly runId: RunId;
    readonly runnerBootId: string;
    readonly runnerId: RunnerId;
    readonly threadId: ThreadId;
  }): Promise<void> {
    return executionStore.assertActiveExecutionBinding(this.#database, input, this.#executionNow);
  }

  /** What a Run's capability tokens are scoped to, while its grant stands. */
  async runCapabilityScope(runId: RunId) {
    return executionStore.runCapabilityScope(this.#database, runId);
  }

  /** Tool authority: the live binding and its grant. */
  async assertActiveGrant(
    input: Parameters<OpensteerStore["assertActiveExecutionBinding"]>[0] & {
      readonly grantId?: GrantId | undefined;
    },
  ): Promise<import("./execution-authority.js").RunLineage> {
    return executionStore.assertActiveGrant(this.#database, input, this.#executionNow);
  }
  async failActiveRunsForRunnerDisconnect(input: {
    readonly activeRunIds: readonly RunId[];
    readonly runnerBootId: string;
    readonly runnerId: RunnerId;
  }): Promise<RunRecoveryOutcome> {
    return executionRecovery.failActiveRunsForRunnerDisconnect(this.#database, this.#links, input);
  }
  async failRunForRefusedRunnerEvent(input: {
    readonly bindingGeneration: number;
    readonly message: string;
    readonly runId: RunId;
    readonly runnerBootId: string;
    readonly runnerId: RunnerId;
  }): Promise<void> {
    return executionRecovery.failRunForRefusedRunnerEvent(this.#database, this.#links, input);
  }
  recordThreadVisit(input: Parameters<typeof recordThreadVisit>[1]) {
    return recordThreadVisit(this.#database, input);
  }
  async recoverThreadWorkQueues(): Promise<void> {
    return executionRecovery.recoverThreadWorkQueues(this.#database);
  }
  async recordComputerUseStop(input: {
    readonly runId: RunId;
    readonly deviceId: import("@opensteer/core").DeviceId;
  }): Promise<void> {
    return computerUseStore.recordComputerUseStop(this.#database, input);
  }
  async activeComputerUseStops(): Promise<
    readonly {
      readonly runId: RunId;
      readonly deviceId: import("@opensteer/core").DeviceId;
    }[]
  > {
    return computerUseStore.activeComputerUseStops(this.#database);
  }
  async clearComputerUseStops(runId: RunId): Promise<void> {
    return computerUseStore.clearComputerUseStops(this.#database, runId);
  }
  async recoverCommandsAfterHostRestart(): Promise<void> {
    return executionRecovery.recoverCommandsAfterHostRestart(this.#database, this.#links);
  }
  async attachRunnerExecutions(input: {
    /** Runs this Host is dispatching now; their dispatch settles them. */
    readonly dispatchingRunIds: readonly RunId[];
    readonly executions: readonly AnnouncedExecution[];
    readonly stoppedComputerName?: string;
    readonly leaseExpiresAt: Date;
    readonly runnerBootId: string;
    readonly runnerId: RunnerId;
  }): Promise<{
    readonly resumed: readonly ResumedExecution[];
    readonly results: readonly ExecutionAttachment[];
  }> {
    return executionRecovery.attachRunnerExecutions(
      this.#database,
      this.#links,
      input,
      (grants) => this.#announce(grants),
      this.#executionNow,
    );
  }
  async restartExecutionLeases(leaseExpiresAt: Date): Promise<void> {
    return executionRecovery.restartExecutionLeases(this.#database, leaseExpiresAt);
  }
  async stopHeldRun(
    claims: Parameters<OpensteerStore["assertActiveGrant"]>[0],
    reason: "limit" | "queued-input" | "device-access",
  ): Promise<BackgroundDeadlineStop | null> {
    const stopped = await executionRecovery.stopHeldRun(
      this.#database,
      claims,
      reason,
      this.#links,
      this.#executionNow,
    );
    if (stopped) this.#announce(stopped.revokedGrants);
    return stopped;
  }
  nextExecutionDeadline(): Promise<Date | null> {
    return executionRecovery.nextExecutionDeadline(this.#database);
  }
  async stopRunsPastBackgroundDeadline(
    onStopped: (stop: BackgroundDeadlineStop) => void,
    now = new Date(),
  ): Promise<number> {
    return executionRecovery.stopRunsPastBackgroundDeadline(
      this.#database,
      (stop) => {
        this.#announce(stop.revokedGrants);
        onStopped(stop);
      },
      this.#links,
      now,
    );
  }
  async recoverRunsWithExpiredExecutionBindings(
    now = new Date(this.#executionNow()),
  ): Promise<RunRecoveryOutcome & { readonly settled: number }> {
    return executionRecovery.recoverRunsWithExpiredExecutionBindings(
      this.#database,
      this.#links,
      (grants) => this.#announce(grants),
      now,
    );
  }

  async bindProviderSession(input: {
    readonly bindingGeneration: number;
    readonly engineStart?: "cold" | "warm";
    readonly harnessInstanceId: HarnessInstanceId;
    readonly providerSessionId: ProviderSessionId;
    readonly providerSessionReference: string;
    readonly runId: RunId;
    readonly runnerBootId: string;
    readonly runnerId: RunnerId;
    readonly threadId: ThreadId;
  }): Promise<void> {
    return executionStore.bindProviderSession(this.#database, input);
  }
  taskPageForUser(input: Parameters<typeof readPersonalTaskPage>[1]) {
    return readPersonalTaskPage(this.#database, input);
  }
  drainRunFinish(runId: RunId) {
    return drainRunFinish(this.#database, this.#links, runId);
  }
  onPersonMessageReady(wake: (message: PersonMessageReady) => void | Promise<void>) {
    return installPersonMessageWake(this.#database, wake);
  }
  publishPersonMessage(input: PersonMessageInput): Promise<PersonMessageResult> {
    return publishPersonMessage(this.#database, input);
  }
  async personalMessageSendKeys(
    ownerId: UserId,
    sessionId: string,
    messageIds: readonly MessageId[],
  ): Promise<ReadonlyMap<string, string>> {
    if (messageIds.length === 0) return new Map();
    const rows = await this.#database
      .selectFrom("threadInputs")
      .innerJoin("messages", "messages.id", "threadInputs.messageId")
      .innerJoin("threads", "threads.id", "threadInputs.threadId")
      .select([
        "threadInputs.messageId",
        "threadInputs.idempotencyKey",
        "threadInputs.authoritySource",
        "messages.author",
      ])
      .where("threadInputs.messageId", "in", [...messageIds])
      .where("threadInputs.requestedBy", "=", ownerId)
      .where("threads.createdBy", "=", ownerId)
      .execute();
    return new Map(
      rows
        .filter(
          (row) =>
            row.author.kind === "human" &&
            row.author.userId === ownerId &&
            row.authoritySource.kind === "user-session" &&
            row.authoritySource.userId === ownerId &&
            row.authoritySource.clientSessionId === sessionId,
        )
        .map((row) => [row.messageId, row.idempotencyKey]),
    );
  }

  async threadMessagePageForOwner(input: ThreadHistoryQuery): Promise<ThreadMessagePage | null> {
    return readThreadHistory(this.#database, input);
  }
}
export { machineIsManagedBy, type MachineOwnershipRecord } from "./machine-ownership.js";
export { enqueueThreadInputInTransaction } from "./thread-inbox.js";

export { threadPathLinks, type ChannelLinks } from "./store-primitives.js";
export { configuredBootstrapEnrollmentLifetimeMs } from "./runner-store.js";

export type { RevokedRunGrant } from "./run-grants.js";

export type { CreateThreadInput } from "./thread-store.js";
export type { ThreadCreationResult } from "./thread-store.js";
export type { BridgeChatSource, ThreadInputSource } from "./thread-store.js";
export type { EnqueueThreadInputRequest } from "./thread-store.js";
export type { EnqueuedThreadInput } from "./thread-store.js";
export type { SteerThreadInputRequest } from "./thread-store.js";
export type { CancelThreadInputRequest } from "./thread-store.js";
export type { CancelledThreadInput } from "./thread-store.js";
export type { MoveThreadInputRequest } from "./thread-store.js";
export type { MovedThreadInput } from "./thread-store.js";
export type { DelegateThreadRequest } from "./thread-store.js";
export type { DelegatedThreadResult } from "./thread-store.js";
export type { ThreadMutationAdmission } from "./thread-store.js";
export type { AdmittedThreadInputRequest } from "./thread-store.js";
export type { AdmittedThreadDelegationRequest } from "./thread-store.js";
export type { RunnerControlInput } from "./command-store.js";
export type { ClaimedCommand } from "./command-store.js";
export type { RecoveredRunTarget } from "./execution-recovery.js";
export type { BackgroundDeadlineStop } from "./execution-recovery.js";
export type { AnnouncedExecution } from "./execution-recovery.js";
export type { ResumedExecution } from "./execution-recovery.js";
export type { ExecutionAttachment } from "./execution-recovery.js";
export type { RunRecoveryOutcome } from "./execution-recovery.js";
export type { HarnessInstanceRecord } from "./harness-store.js";
export type { CreateHarnessInstanceInput } from "./harness-store.js";
export type { ExecutionEnvironmentRecord } from "./environment-store.js";
export type { AgentThreadListPage } from "./thread-store.js";
export type { AgentThreadListScope } from "./thread-store.js";
export type { RunnerAuthenticationRecord } from "./runner-store.js";
export type { RunnerConnectionRecord } from "./runner-store.js";
export type { PendingRunnerEnrollmentRecord } from "./runner-store.js";
export type { BrowserProfileRecord } from "./browser-session-store.js";
export type {
  BrowserSessionRecord,
  BrowserUsageCredit,
  BrowserUsePage,
} from "./browser-session-store.js";
export type { BrowserSessionWithAttachmentCountRecord } from "./browser-session-store.js";
export { runnerAdvertisesItsEnvironmentBinding } from "./runner-store.js";
export { personalReachableGrantRefusal } from "./runner-store.js";
export { personalRemoteAccessRequiredRefusal } from "./runner-store.js";
export { personalRemoteAccessRefusedReason } from "./runner-store.js";
export { runnerIdentityRevokedReason } from "./runner-store.js";
export { runnerEnrollmentExpiredReason } from "./runner-store.js";
export { personalReachableGrant, phoneRunnerGrant } from "./runner-store.js";
export type { MachineAccessTargetRecord } from "./machine-store.js";
export type { ReachableMachineRecord } from "./machine-store.js";
export type { ShellSessionHistoryRecord } from "./machine-store.js";
export type { ShellSessionRecord } from "./machine-store.js";
export { assertRequestResponse } from "./command-store.js";

/**
 * How many live tasks each environment holds, each count stopping at `pinnedThreadsCountCap`.
 * One statement, one capped read per environment, each naming its environment as a value: the
 * planner then plans each from that environment's own statistics (the partial index for a computer
 * with few tasks, an early-stopping scan for the one that hosts nearly all of them). Correlated
 * on a column instead, every environment was planned as the dominant one and scanned the table.
 */
export function placedThreadsQuery(ids: readonly EnvironmentId[]) {
  return sql<{ environmentId: EnvironmentId; count: string }>`${sql.join(
    ids.map(
      (id) => sql`select ${id}::text as "environmentId", (
        select count(*) from (
          select 1 from threads where environment_id = ${id} and status <> 'archived'
          limit ${pinnedThreadsCountCap}
        ) pinned
      ) as count`,
    ),
    sql` union all `,
  )}`;
}

export async function countPlacedThreads(
  database: Kysely<DatabaseSchema>,
  environmentIds: readonly EnvironmentId[],
): Promise<ReadonlyMap<EnvironmentId, number>> {
  const ids = [...new Set(environmentIds)];
  if (!ids.length) return new Map();
  const rows = await placedThreadsQuery(ids).execute(database);
  return new Map(
    rows.rows.flatMap((row) =>
      Number(row.count) ? [[row.environmentId, Number(row.count)] as const] : [],
    ),
  );
}
