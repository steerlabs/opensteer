import { BrowserHistoryStore } from "./browser-history-store.js";
import * as taskDone from "./task-done.js";
import { drainPendingThreadStates } from "./thread-status.js";
import * as runnerStore from "./runner-store.js";
import * as browserSessionStore from "./browser-session-store.js";
import * as commandStore from "./command-store.js";
import * as workspaceStore from "./workspace-store.js";
import * as workspaceMembershipStore from "./workspace-membership-store.js";
import * as threadStore from "./thread-store.js";
import * as executionRecovery from "./execution-recovery.js";
import * as harnessStore from "./harness-store.js";
import * as environmentStore from "./environment-store.js";
import * as credentialStore from "./credential-store.js";
import * as executionStore from "./execution-store.js";
import * as snapshotStore from "./snapshot-store.js";
import * as workspaceMountStore from "./workspace-mount-store.js";
import * as machineStore from "./machine-store.js";
import * as runnerEventStore from "./runner-event-store.js";
import * as deploymentStore from "./deployment-store.js";
import * as computerUseStore from "./computer-use-store.js";
import { type Kysely } from "kysely";
import { type DatabaseSchema, type CommandRow, type PendingCommandRow } from "./schema.js";
import type { Clock } from "@opensteer/shared/clock";
import {
  type WorkspaceMembershipChangeListener,
  type WorkspaceMembershipRecord,
  type WorkspaceMemberRecord,
  type WorkspaceInvitationRecord,
  type SecurityEffectRecord,
} from "./workspace-membership-store.js";
import { type ChannelLinks, threadPathLinks } from "./store-primitives.js";
import { RequestStore } from "./request-store.js";
import { NotificationStateStore } from "./notification-state.js";
import {
  type PlaceContentPart,
  type Deployment,
  type DeploymentId,
  type HostInstanceId,
  type DeploymentShape,
  createId,
  type UserId,
  type WorkspaceId,
  type WorkspaceInvitationId,
  type AgentEvent,
  type SecurityEffectId,
  type EnvironmentId,
  type RunnerId,
  type RequestId,
  type RunId,
  type ThreadId,
  type BrowserProfileId,
  type CredentialId,
  type BrowserProfileGrantId,
  type HarnessInstanceId,
  type ExecutionPreferences,
  type ExecutionChoice,
  type Workspace,
  type WorkspaceIconName,
  type WorkspaceBacking,
  type Thread,
  type AssignmentId,
  type AssignmentView,
  type AssignmentSummary,
  type ProviderContinuationIdentity,
  type ProviderSessionId,
  type ModelSelection,
  type ThreadAccessMode,
  type ThreadInputQueue,
  type MessageId,
  type Message,
  type ExecutionNode,
  type Run,
  type RunAttempt,
  type ThreadExecutionBinding,
  type IntegrationCallSubject,
  type Sequence,
  type GrantId,
} from "@opensteer/core";
import { listRunNodes } from "./execution-nodes.js";
import { listRunAttempts } from "./run-attempts.js";
import { executionNodeFromRow, runAttemptFromRow } from "./thread-row-mappers.js";
import {
  type RunnerAuthenticationRecord,
  type RunnerInventoryRecord,
  type PendingRunnerEnrollmentRecord,
  type RunnerEnrollmentIssuanceRecord,
  type RunnerConnectionRecord,
} from "./runner-store.js";
import {
  type BrowserSessionOpenerRecord,
  type BrowserSessionUsageProjection,
  type BrowserTabOpenBinding,
  type BrowserSessionId,
  type MachineAccessPolicy,
  type ShellSessionId,
  type ShellCloseReason,
  type ShellAuditEvent,
  type ShellSessionSummary,
  type RunnerModuleName,
  type RunnerDescriptor,
  type HostedBrowserSessionState,
  type HarnessInstanceCatalog,
  type WorkspaceCatalogPage,
  type DurableWindow,
  type PendingAgentEvent,
  type WorkspaceSnapshot,
  type TaskPage,
  type ThreadMessagePage,
  type ThreadEventPage,
} from "@opensteer/protocol";
import { type IntegrationConnectionId, type ChannelTransportKind } from "@opensteer/channel-core";
import { type MachineOwnershipRecord } from "./machine-ownership.js";
import {
  type ShellSessionRecord,
  type MachineAccessTargetRecord,
  type ReachableMachineRecord,
  type ShellSessionHistoryRecord,
} from "./machine-store.js";
import {
  type BrowserProfileRecord,
  type BrowserProfileRevisionRecord,
  type BrowserSessionRecord,
  type BrowserSessionWithAttachmentCountRecord,
  type ActiveBrowserProfileGrantRecord,
  type RevokedBrowserProfileGrantRecord,
} from "./browser-session-store.js";
import {
  type CreateHarnessInstanceInput,
  type HarnessInstanceRecord,
  type HarnessCatalogRecord,
} from "./harness-store.js";
import { type CredentialRecord } from "./credential-store.js";
import { type BrowserProfileAccess } from "@opensteer/browser-profile/grant";
import { type ExecutionEnvironmentRecord } from "./environment-store.js";
import { type CreateWorkspaceInput, type WorkspaceFilesAdmission } from "./workspace-store.js";
import {
  type OwnerThreadPage,
  type AgentThreadListScope,
  type AgentThreadListPage,
  type OwnedThreadRead,
  type CreateThreadInput,
  type ThreadCreationResult,
  type DelegateThreadRequest,
  type DelegatedThreadResult,
  type AdmittedThreadDelegationRequest,
  type ThreadUpdateResult,
  type EnqueueThreadInputRequest,
  type EnqueuedThreadInput,
  type SteerThreadInputRequest,
  type CancelThreadInputRequest,
  type CancelledThreadInput,
  type MoveThreadInputRequest,
  type MovedThreadInput,
  type AdmittedThreadInputRequest,
} from "./thread-store.js";
import {
  type AgentControlAdmissionInput,
  type AgentControlAdmissionResult,
  type TriggerControlAdmissionInput,
  type TriggerControlAdmissionResult,
} from "./agent-control-admission.js";
import {
  assignmentTreeThreadIds,
  type CancelAssignmentInput,
  type CancelAssignmentResult,
} from "./assignment-store.js";
import { type AssignmentReturnDrain } from "./thread-inbox.js";
import { type RunnerControlInput, type ClaimedCommand } from "./command-store.js";
import { type RunDispatchContext } from "./execution-store.js";
import {
  type DurableWindowReadOptions,
  type WorkspaceSnapshotReadOptions,
  type EventReplayWindow,
} from "./snapshot-store.js";
import {
  type BackgroundDeadlineStop,
  type RunRecoveryOutcome,
  type AnnouncedExecution,
  type ResumedExecution,
  type ExecutionAttachment,
} from "./execution-recovery.js";
import {
  type WorkspaceMountRecord,
  type WorkspaceMountInventoryEntry,
  type PendingWorkspaceMountRevocation,
} from "./workspace-mount-store.js";
import { type ThreadHistoryQuery } from "./thread-history.js";
import { type RevokedRunGrant } from "./run-grants.js";

/** Told, after commit, which grants a write revoked. */
export type RunGrantRevocationListener = (grants: readonly RevokedRunGrant[]) => void;

export class OpensteerStore {
  readonly #database: Kysely<DatabaseSchema>;

  // The Deployment authority lease permits one mutating Host process. These
  // post-commit listeners therefore form the immediate local revocation path;
  // generation and grant rechecks remain the durable race fence.
  readonly #workspaceMembershipChangeListeners = new Set<WorkspaceMembershipChangeListener>();
  readonly #runGrantRevocationListeners = new Set<RunGrantRevocationListener>();

  // A status delivery has to name a page a person can open, and only the Host
  // knows the origin its own web app answers on.
  readonly #links: ChannelLinks;
  readonly #executionNow: () => number;

  readonly requests: RequestStore;

  readonly notificationState: NotificationStateStore;
  readonly browserHistory: BrowserHistoryStore;

  constructor(
    database: Kysely<DatabaseSchema>,
    options: { readonly links?: ChannelLinks; readonly executionClock?: Pick<Clock, "now"> } = {},
  ) {
    this.#database = database;
    this.#links = options.links ?? threadPathLinks;
    this.#executionNow = options.executionClock?.now ?? (() => Date.now());
    this.requests = new RequestStore(database);
    this.notificationState = new NotificationStateStore(database);
    this.browserHistory = new BrowserHistoryStore(database);
  }

  get database(): Kysely<DatabaseSchema> {
    return this.#database;
  }

  onWorkspaceMembershipChanged(listener: WorkspaceMembershipChangeListener): () => void {
    this.#workspaceMembershipChangeListeners.add(listener);
    return () => this.#workspaceMembershipChangeListeners.delete(listener);
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

  #announceRevokedGrants<Result extends { readonly revokedGrants: readonly RevokedRunGrant[] }>(
    result: Result,
  ): Result {
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

  async firstUser(): Promise<{ readonly id: UserId; readonly displayName: string } | null> {
    return deploymentStore.firstUser(this.#database);
  }

  async userById(userId: UserId): Promise<{
    readonly disabledAt: Date | null;
    readonly displayName: string;
    readonly email: string;
    readonly emailVerified: boolean;
    readonly id: UserId;
    readonly image: string | null;
    readonly instanceRole: "administrator" | "user";
  } | null> {
    return deploymentStore.userById(this.#database, userId);
  }

  async workspaceMembershipForUser(
    workspaceId: WorkspaceId,
    userId: UserId,
  ): Promise<WorkspaceMembershipRecord | null> {
    return workspaceMembershipStore.workspaceMembershipForUser(this.#database, workspaceId, userId);
  }

  async listWorkspaceMembers(
    workspaceId: WorkspaceId,
    actorId: UserId,
  ): Promise<readonly WorkspaceMemberRecord[]> {
    return workspaceMembershipStore.listWorkspaceMembers(this.#database, workspaceId, actorId);
  }

  async createWorkspaceInvitation(input: {
    readonly createdBy: UserId;
    readonly expiresAt: Date;
    readonly id?: WorkspaceInvitationId;
    readonly idempotencyKey: string;
    readonly intendedEmail: string | null;
    readonly requestFingerprint: string;
    readonly role: "owner" | "collaborator";
    readonly selector: string;
    readonly tokenHash: string;
    readonly type: "email" | "link";
    readonly workspaceId: WorkspaceId;
  }): Promise<WorkspaceInvitationRecord> {
    return workspaceMembershipStore.createWorkspaceInvitation(this.#database, input);
  }

  async listActiveWorkspaceInvitations(
    workspaceId: WorkspaceId,
    actorId: UserId,
  ): Promise<readonly WorkspaceInvitationRecord[]> {
    return workspaceMembershipStore.listActiveWorkspaceInvitations(
      this.#database,
      workspaceId,
      actorId,
    );
  }

  async revokeWorkspaceInvitation(input: {
    readonly actorId: UserId;
    readonly invitationId: WorkspaceInvitationId;
    readonly workspaceId: WorkspaceId;
  }): Promise<WorkspaceInvitationRecord> {
    return workspaceMembershipStore.revokeWorkspaceInvitation(this.#database, input);
  }

  async invitationForExchange(selector: string): Promise<{
    readonly invitation: WorkspaceInvitationRecord;
    readonly inviterName: string;
    readonly tokenHash: string;
    readonly workspaceName: string;
  } | null> {
    return workspaceMembershipStore.invitationForExchange(this.#database, selector);
  }

  async acceptWorkspaceInvitation(input: {
    readonly selector: string;
    readonly tokenHash: string;
    readonly userEmail: string;
    readonly userEmailVerified: boolean;
    readonly userId: UserId;
  }): Promise<WorkspaceMembershipRecord> {
    return workspaceMembershipStore.acceptWorkspaceInvitation(
      this.#database,
      this.#workspaceMembershipChangeListeners,
      input,
    );
  }

  async changeWorkspaceMembership(input: {
    readonly actorId: UserId;
    readonly role?: "owner" | "collaborator";
    readonly state?: "active" | "revoked";
    readonly targetUserId: UserId;
    readonly workspaceId: WorkspaceId;
  }): Promise<{
    readonly membership: WorkspaceMembershipRecord;
    readonly requestEvents: readonly AgentEvent[];
  }> {
    return workspaceMembershipStore.changeWorkspaceMembership(
      this.#database,
      this.#workspaceMembershipChangeListeners,
      input,
    );
  }

  async claimSecurityEffects(input: {
    readonly leaseUntil: Date;
    readonly limit: number;
    readonly now: Date;
  }): Promise<readonly SecurityEffectRecord[]> {
    return workspaceMembershipStore.claimSecurityEffects(this.#database, input);
  }

  async completeSecurityEffect(effectId: SecurityEffectId): Promise<void> {
    return workspaceMembershipStore.completeSecurityEffect(this.#database, effectId);
  }

  async failSecurityEffect(input: {
    readonly effectId: SecurityEffectId;
    readonly error: string;
    readonly nextAttemptAt: Date;
  }): Promise<void> {
    return workspaceMembershipStore.failSecurityEffect(this.#database, input);
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

  async hasInstanceAdministrator(): Promise<boolean> {
    return runnerStore.hasInstanceAdministrator(this.#database);
  }

  async deploymentMainRunnerState(): Promise<"absent" | "active" | "revoked"> {
    return runnerStore.deploymentMainRunnerState(this.#database);
  }

  async upgradeLegacyPersonalMainRunnerBrowserGrant(): Promise<boolean> {
    return runnerStore.upgradeLegacyPersonalMainRunnerBrowserGrant(this.#database);
  }

  async listRunners(input: {
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
    options: { readonly allowDeployment?: boolean; readonly allowOtherOwners?: boolean } = {},
  ): Promise<{
    readonly cancelledRequestIds: readonly RequestId[];
    readonly closedBrowserSessions: readonly BrowserSessionId[];
    readonly events: readonly AgentEvent[];
    readonly requestEvents: readonly AgentEvent[];
    readonly revokedComputerConnectionIds: readonly IntegrationConnectionId[];
  }> {
    return runnerStore.revokeRunner(this.#database, this.#links, runnerId, ownerId, options);
  }

  async renameRunner(
    runnerId: RunnerId,
    ownerId: UserId,
    name: string,
    options: { readonly allowDeployment?: boolean } = {},
  ): Promise<void> {
    return runnerStore.renameRunner(this.#database, runnerId, ownerId, name, options);
  }

  async updateMachineAccessPolicy(input: {
    readonly allowDeployment: boolean;
    readonly expectedRevision: number;
    readonly idempotency?: { readonly key: string; readonly requestedBy: UserId };
    readonly ownerId: UserId;
    readonly policy: MachineAccessPolicy;
    readonly runnerId: RunnerId;
  }): Promise<
    | { readonly outcome: "conflict"; readonly replayed: boolean }
    | { readonly outcome: "updated"; readonly replayed: boolean; readonly revision: number }
  > {
    return machineStore.updateMachineAccessPolicy(this.#database, input);
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
    readonly idempotency?: { readonly key: string; readonly requestedBy: UserId };
    readonly reason: ShellCloseReason;
    readonly sessionId: ShellSessionId;
  }): Promise<{ readonly ended: boolean }> {
    return machineStore.endShellSession(this.#database, input);
  }

  async endAllOpenShellSessions(reason: ShellCloseReason): Promise<number> {
    return machineStore.endAllOpenShellSessions(this.#database, reason);
  }

  async appendShellEvents(
    sessionId: ShellSessionId,
    events: readonly { readonly at: Date; readonly event: ShellAuditEvent }[],
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

  async listPendingRunnerEnrollments(input: {
    readonly includeDeployment: boolean;
    readonly limit: number;
    readonly ownerId: UserId;
  }): Promise<readonly PendingRunnerEnrollmentRecord[]> {
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
  ): Promise<boolean> {
    return runnerStore.setRunnerShellFullDiskAccess(this.#database, runnerId, fullDiskAccess);
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
    readonly idempotencyKey: string;
    readonly name: string;
    readonly ownerId: UserId;
  }): Promise<BrowserProfileRecord> {
    return browserSessionStore.createBrowserProfile(this.#database, input);
  }

  async createBrowserProfileWithRevision(input: {
    readonly ciphertext: Uint8Array;
    readonly ciphertextSha256: string;
    readonly id: BrowserProfileId;
    readonly name: string;
    readonly ownerId: UserId;
    readonly revision: 1;
  }): Promise<BrowserProfileRecord> {
    return browserSessionStore.createBrowserProfileWithRevision(this.#database, input);
  }

  async getBrowserProfile(
    profileId: BrowserProfileId,
    ownerId: UserId,
  ): Promise<BrowserProfileRecord | null> {
    return browserSessionStore.getBrowserProfile(this.#database, profileId, ownerId);
  }

  async listBrowserProfiles(ownerId: UserId): Promise<readonly BrowserProfileRecord[]> {
    return browserSessionStore.listBrowserProfiles(this.#database, ownerId);
  }

  async renameBrowserProfile(input: {
    readonly name: string;
    readonly ownerId: UserId;
    readonly profileId: BrowserProfileId;
  }): Promise<BrowserProfileRecord> {
    return browserSessionStore.renameBrowserProfile(this.#database, input);
  }

  async deleteBrowserProfile(input: {
    readonly ownerId: UserId;
    readonly profileId: BrowserProfileId;
  }): Promise<{ readonly sessionIds: readonly BrowserSessionId[]; readonly changed: boolean }> {
    return browserSessionStore.deleteBrowserProfile(this.#database, input);
  }

  async readBrowserProfileRevision(
    profileId: BrowserProfileId,
  ): Promise<BrowserProfileRevisionRecord | null> {
    return browserSessionStore.readBrowserProfileRevision(this.#database, profileId);
  }

  async commitBrowserProfileRevision(input: {
    readonly ciphertext: Uint8Array;
    readonly ciphertextSha256: string;
    readonly expectedRevision: number;
    readonly periodic?: boolean;
    readonly profileId: BrowserProfileId;
  }): Promise<BrowserProfileRevisionRecord> {
    return browserSessionStore.commitBrowserProfileRevision(this.#database, input);
  }

  async authorizeBrowserProfileLease(input: {
    readonly leaseTokenHash: string;
    readonly profileId: BrowserProfileId;
    readonly sessionId: BrowserSessionId;
  }): Promise<boolean> {
    return browserSessionStore.authorizeBrowserProfileLease(this.#database, input);
  }

  async createBrowserSession(input: {
    readonly tabGroupId?: BrowserSessionId;
    readonly opener?: BrowserSessionOpenerRecord | null;
    readonly id: BrowserSessionId;
    readonly leaseGeneration: number;
    readonly leaseTokenHash: string | null;
    readonly placementKey: string;
    readonly runnerId: RunnerId;
    readonly origin: "agent" | "trigger" | "workspace";
    readonly profileId: BrowserProfileId | null;
    readonly runtimeId: string;
    readonly workspaceId: WorkspaceId;
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

  async latestNativePlaces(ownerId: UserId) {
    return browserSessionStore.latestNativePlaces(this.#database, ownerId);
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
    readonly workspaceId: WorkspaceId;
  } | null> {
    return browserSessionStore.listBrowserSessionViewers(this.#database, sessionId);
  }

  async findActiveBrowserSessionForWorkspace(
    workspaceId: WorkspaceId,
  ): Promise<BrowserSessionRecord | null> {
    return browserSessionStore.findActiveBrowserSessionForWorkspace(this.#database, workspaceId);
  }

  async listActiveBrowserSessionsForAgentBinding(
    agentBindingId: string,
  ): Promise<readonly BrowserSessionRecord[]> {
    return browserSessionStore.listActiveBrowserSessionsForAgentBinding(
      this.#database,
      agentBindingId,
    );
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
    readonly workspaceId: WorkspaceId;
  }): Promise<boolean> {
    return browserSessionStore.attachBrowserSession(this.#database, input);
  }

  async detachBrowserSessionAttachments(
    agentBindingId: string,
  ): Promise<readonly BrowserSessionId[]> {
    return browserSessionStore.detachBrowserSessionAttachments(this.#database, agentBindingId);
  }

  async detachBrowserSessionAttachmentsForProfileGrant(input: {
    readonly ownerId: UserId;
    readonly profileId: BrowserProfileId;
    readonly workspaceId: WorkspaceId;
  }): Promise<number> {
    return browserSessionStore.detachBrowserSessionAttachmentsForProfileGrant(
      this.#database,
      input,
    );
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
    readonly allOwnerWorkspaces: boolean;
    readonly ownerId: UserId;
    readonly workspaceId: WorkspaceId;
  }): Promise<readonly BrowserSessionWithAttachmentCountRecord[]> {
    return browserSessionStore.listActiveBrowserSessionsForAgent(this.#database, input);
  }

  async failActiveBrowserSessions(placementKey?: string): Promise<{
    readonly events: readonly AgentEvent[];
    readonly failed: number;
  }> {
    return browserSessionStore.failActiveBrowserSessions(this.#database, placementKey);
  }

  async transitionBrowserSession(input: {
    readonly from?: readonly HostedBrowserSessionState[];
    readonly sessionId: BrowserSessionId;
    readonly state: HostedBrowserSessionState;
  }): Promise<{
    readonly events: readonly AgentEvent[];
    readonly session: BrowserSessionRecord;
  }> {
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

  async credentialVaultCanary(
    keyVersion: number,
  ): Promise<{ readonly encryptedPayload: Buffer; readonly keyVersion: number } | null> {
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

  async createBrowserProfileGrant(input: {
    readonly access: BrowserProfileAccess;
    readonly createdBy: UserId;
    readonly id?: BrowserProfileGrantId;
    readonly profileId: BrowserProfileId;
    readonly workspaceId: WorkspaceId;
  }): Promise<ActiveBrowserProfileGrantRecord> {
    return browserSessionStore.createBrowserProfileGrant(this.#database, input);
  }

  async listActiveBrowserProfileGrantsForWorkspace(
    workspaceId: WorkspaceId,
    ownerId: UserId,
  ): Promise<readonly ActiveBrowserProfileGrantRecord[]> {
    return browserSessionStore.listActiveBrowserProfileGrantsForWorkspace(
      this.#database,
      workspaceId,
      ownerId,
    );
  }

  async listActiveBrowserProfileGrants(
    ownerId: UserId,
  ): Promise<readonly ActiveBrowserProfileGrantRecord[]> {
    return browserSessionStore.listActiveBrowserProfileGrants(this.#database, ownerId);
  }

  async revokeBrowserProfileGrant(
    grantId: BrowserProfileGrantId,
    revokedBy: UserId,
  ): Promise<RevokedBrowserProfileGrantRecord> {
    return browserSessionStore.revokeBrowserProfileGrant(this.#database, grantId, revokedBy);
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

  async updateHarnessInstance(input: {
    readonly config?: unknown;
    readonly expectedRuntimeRevision?: number;
    readonly enabled?: boolean;
    readonly id: HarnessInstanceId;
    readonly name?: string;
  }): Promise<HarnessInstanceRecord> {
    return harnessStore.updateHarnessInstance(this.#database, input);
  }

  async setDefaultHarnessInstance(input: {
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
  }): Promise<readonly HarnessInstanceCatalog[]> {
    return harnessStore.recordHarnessCatalogs(this.#database, input);
  }

  async discardHarnessCatalog(
    environmentId: EnvironmentId,
    harnessInstanceId: HarnessInstanceId,
  ): Promise<void> {
    return harnessStore.discardHarnessCatalog(this.#database, environmentId, harnessInstanceId);
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

  async getExecutionPreferences(userId: UserId): Promise<ExecutionPreferences> {
    return harnessStore.getExecutionPreferences(this.#database, userId);
  }

  async rememberExecutionChoice(
    userId: UserId,
    choice: ExecutionChoice,
  ): Promise<ExecutionPreferences> {
    return harnessStore.rememberExecutionChoice(this.#database, userId, choice);
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
    page?: { readonly afterId?: EnvironmentId; readonly id?: EnvironmentId },
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

  async createWorkspace(input: CreateWorkspaceInput): Promise<Workspace> {
    return workspaceStore.createWorkspace(this.#database, input);
  }

  async setWorkspaceIcon(input: {
    readonly icon: WorkspaceIconName | null;
    readonly idempotencyKey: string;
    readonly requestedBy: UserId;
    readonly workspaceId: WorkspaceId;
  }): Promise<Workspace> {
    return workspaceStore.setWorkspaceIcon(this.#database, input);
  }

  setWorkspaceColor(
    input: Parameters<typeof workspaceStore.setWorkspaceColor>[1],
  ): Promise<Workspace> {
    return workspaceStore.setWorkspaceColor(this.#database, input);
  }

  async requestWorkspaceDeletion(input: {
    readonly purgeAfter: Date;
    readonly requestedBy: UserId;
    readonly workspaceId: WorkspaceId;
  }): Promise<{
    readonly requestEvents: readonly AgentEvent[];
    readonly workspace: Workspace;
  }> {
    return workspaceStore.requestWorkspaceDeletion(this.#database, input);
  }

  async recoverWorkspaceDeletion(input: {
    readonly requestedBy: UserId;
    readonly workspaceId: WorkspaceId;
  }): Promise<Workspace> {
    return workspaceStore.recoverWorkspaceDeletion(this.#database, input);
  }

  async listWorkspacesDuePurge(input: {
    readonly after?: WorkspaceId;
    readonly limit: number;
    readonly now: Date;
  }): Promise<readonly Workspace[]> {
    return workspaceStore.listWorkspacesDuePurge(this.#database, input);
  }

  async markWorkspaceDeleted(input: { readonly workspaceId: WorkspaceId }): Promise<Workspace> {
    return workspaceStore.markWorkspaceDeleted(this.#database, input);
  }

  async listWorkspaces(): Promise<readonly Workspace[]> {
    return workspaceStore.listWorkspaces(this.#database);
  }

  async findMainWorkspaceForOwner(ownerId: UserId): Promise<Workspace | undefined> {
    return workspaceStore.findMainWorkspaceForOwner(this.#database, ownerId);
  }

  async workspacePageForOwner(input: {
    readonly before?: string;
    readonly maxBytes?: number;
    readonly maxItems?: number;
    readonly ownerId: UserId;
  }): Promise<WorkspaceCatalogPage> {
    return workspaceStore.workspacePageForOwner(this.#database, this.notificationState, input);
  }

  async listWorkspacesForOwner(ownerId: UserId, limit = 1_000): Promise<readonly Workspace[]> {
    return workspaceStore.listWorkspacesForOwner(this.#database, ownerId, limit);
  }

  async getWorkspace(workspaceId: WorkspaceId): Promise<Workspace | null> {
    return workspaceStore.getWorkspace(this.#database, workspaceId);
  }

  async noteWorkspaceActivity(workspaceId: WorkspaceId, at: Date): Promise<void> {
    return workspaceStore.noteWorkspaceActivity(this.#database, workspaceId, at);
  }

  async listArchiveEligibleWorkspaces(input: {
    readonly after?: WorkspaceId;
    readonly idleBefore: Date;
    readonly limit: number;
  }): Promise<readonly Workspace[]> {
    return workspaceStore.listArchiveEligibleWorkspaces(this.#database, input);
  }

  async getWorkspaceForOwner(workspaceId: WorkspaceId, ownerId: UserId): Promise<Workspace | null> {
    return workspaceStore.getWorkspaceForOwner(this.#database, workspaceId, ownerId);
  }

  async admitWorkspaceFiles(
    workspaceId: WorkspaceId,
    userId: UserId,
  ): Promise<WorkspaceFilesAdmission | null> {
    return workspaceStore.admitWorkspaceFiles(this.#database, workspaceId, userId);
  }

  async setWorkspaceStorageState(input: {
    readonly issue: Workspace["storageIssue"];
    readonly status: Workspace["status"];
    readonly workspaceId: WorkspaceId;
  }): Promise<Workspace> {
    return workspaceStore.setWorkspaceStorageState(this.#database, input);
  }

  async setWorkspaceProvisioningResult(input: {
    readonly backing: WorkspaceBacking;
    readonly expectedBacking: WorkspaceBacking;
    readonly status: Workspace["status"];
    readonly workspaceId: WorkspaceId;
  }): Promise<Workspace> {
    return workspaceStore.setWorkspaceProvisioningResult(this.#database, input);
  }

  async claimPortableFsWorkspaceForArchive(input: {
    readonly backingGeneration: number;
    readonly idleBefore: Date;
    readonly workspaceId: WorkspaceId;
  }): Promise<Workspace> {
    return workspaceStore.claimPortableFsWorkspaceForArchive(this.#database, input);
  }

  async assertCurrentPortableFsWorkspaceBacking(input: {
    readonly generation: number;
    readonly volumeId: string;
    readonly workspaceId: WorkspaceId;
  }): Promise<void> {
    return workspaceStore.assertCurrentPortableFsWorkspaceBacking(this.#database, input);
  }

  async hasWorkspaceMountHistory(workspaceId: WorkspaceId): Promise<boolean> {
    return workspaceStore.hasWorkspaceMountHistory(this.#database, workspaceId);
  }

  async countLiveThreadsByEnvironment(
    environmentIds: readonly EnvironmentId[],
  ): Promise<ReadonlyMap<EnvironmentId, number>> {
    return workspaceStore.countLiveThreadsByEnvironment(this.#database, environmentIds);
  }

  async listLocalWorkspacesForEnvironments(
    environmentIds: readonly EnvironmentId[],
    limit = 1_000,
  ): Promise<readonly Workspace[]> {
    return workspaceStore.listLocalWorkspacesForEnvironments(this.#database, environmentIds, limit);
  }

  async listWorkspacesByStatus(
    status: Workspace["status"],
    options: {
      readonly after?: { readonly createdAt: string; readonly id: WorkspaceId };
      readonly limit?: number;
    } = {},
  ): Promise<readonly Workspace[]> {
    return workspaceStore.listWorkspacesByStatus(this.#database, status, options);
  }

  async listPortableFsWorkspacesByServiceMismatch(
    serviceId: string,
    options: {
      readonly after?: { readonly createdAt: string; readonly id: WorkspaceId };
      readonly limit?: number;
    } = {},
  ): Promise<readonly Workspace[]> {
    return workspaceStore.listPortableFsWorkspacesByServiceMismatch(
      this.#database,
      serviceId,
      options,
    );
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

  async getAssignment(id: AssignmentId): Promise<AssignmentView | null> {
    return threadStore.getAssignment(this.#database, id);
  }

  async getAssignmentForOwner(input: {
    readonly assignmentId: AssignmentId;
    readonly ownerId: UserId;
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
    readonly workspaceId?: WorkspaceId;
  }): Promise<AgentThreadListPage> {
    return threadStore.agentThreadPageForOwner(this.#database, input);
  }

  async getThreadForOwner(threadId: ThreadId, ownerId: UserId): Promise<Thread | null> {
    return threadStore.getThreadForOwner(this.#database, threadId, ownerId);
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

  admitAgentControlRequest(
    input: AgentControlAdmissionInput,
  ): Promise<AgentControlAdmissionResult> {
    return threadStore.admitAgentControlRequest(this.#database, input, this.#executionNow);
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
    input: CancelAssignmentInput & { readonly admission?: AgentControlAdmissionInput },
  ): Promise<CancelAssignmentResult> {
    return this.#announceRevokedGrants(
      await threadStore.cancelAssignment(this.#database, this.#links, input, this.#executionNow),
    );
  }

  drainPendingAssignmentReturns(limit?: number): Promise<AssignmentReturnDrain> {
    return threadStore.drainPendingAssignmentReturns(this.#database, limit);
  }

  drainAssignmentReturn(assignmentId: AssignmentId): Promise<readonly AgentEvent[]> {
    return threadStore.drainAssignmentReturn(this.#database, assignmentId);
  }

  async updateThreadExecutionSelection(input: {
    readonly continuationIdentity: ProviderContinuationIdentity;
    readonly continuation?: { readonly expectedProviderSessionId: ProviderSessionId | null };
    readonly harnessInstanceId: HarnessInstanceId;
    readonly idempotencyKey: string;
    readonly modelSelection: ModelSelection;
    readonly requestedBy: UserId;
    readonly threadId: ThreadId;
  }): Promise<{
    readonly asOfSequence: Sequence;
    readonly thread: Thread;
    readonly event: AgentEvent | null;
    readonly wasDuplicate: boolean;
  }> {
    return threadStore.updateThreadExecutionSelection(this.#database, input);
  }

  async resumeThreadInputQueue(input: {
    readonly idempotencyKey: string;
    readonly requestedBy: UserId;
    readonly threadId: ThreadId;
  }): Promise<{
    readonly asOfSequence: Sequence;
    readonly thread: Thread;
    readonly events: readonly AgentEvent[];
  }> {
    return threadStore.resumeThreadInputQueue(this.#database, input);
  }

  doneScopeThreadIds(threadId: ThreadId): Promise<readonly ThreadId[]> {
    return taskDone.doneScopeThreadIds(this.#database, threadId);
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

  async steerThreadInput(input: SteerThreadInputRequest): Promise<EnqueuedThreadInput> {
    return this.#announceRevokedGrants(await threadStore.steerThreadInput(this.#database, input));
  }

  async cancelThreadInput(input: CancelThreadInputRequest): Promise<CancelledThreadInput> {
    return threadStore.cancelThreadInput(this.#database, input);
  }

  async moveThreadInput(input: MoveThreadInputRequest): Promise<MovedThreadInput> {
    return threadStore.moveThreadInput(this.#database, input);
  }

  async getThreadInputQueue(input: {
    readonly threadId: ThreadId;
    readonly requestedBy: UserId;
  }): Promise<ThreadInputQueue> {
    return threadStore.getThreadInputQueue(this.#database, input);
  }

  async enqueueAdmittedThreadInput(
    request: AdmittedThreadInputRequest,
  ): Promise<EnqueuedThreadInput> {
    return this.#announceRevokedGrants(
      await threadStore.enqueueAdmittedThreadInput(this.#database, request, this.#executionNow),
    );
  }

  async enqueueRunnerControl(input: RunnerControlInput): Promise<{
    readonly command: CommandRow;
    readonly events: readonly AgentEvent[];
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
    send: (beforeAck: () => Promise<void>) => Promise<void>,
  ): Promise<readonly AgentEvent[]> {
    return this.#announceRevokedGrants(
      await commandStore.dispatchRequestResponse(this.#database, commandId, send),
    ).events;
  }

  async dispatchChannelCommand(
    commandId: CommandRow["id"],
    send: (beforeAck: () => Promise<void>) => Promise<void>,
  ): Promise<readonly AgentEvent[]> {
    return this.#announceRevokedGrants(
      await commandStore.dispatchChannelCommand(this.#database, commandId, send),
    ).events;
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
    (NonNullable<RunDispatchContext["initialContext"]> & { readonly finalized: true }) | null
  > {
    return executionStore.finalizeRunInitialContext(this.#database, input);
  }

  loadRunThreadState(input: { readonly runId: RunId; readonly viewerId: UserId }) {
    return executionStore.loadRunThreadState(this.#database, input);
  }

  async loadRunDispatchContext(
    commandId: CommandRow["id"],
    options: DurableWindowReadOptions = {},
  ): Promise<RunDispatchContext> {
    return executionStore.loadRunDispatchContext(this.#database, commandId, options);
  }

  async loadSteerDispatchInput(commandId: CommandRow["id"]): Promise<{
    readonly message: Message;
    readonly run: Run;
    readonly runId: RunId;
    readonly threadId: ThreadId;
  }> {
    return commandStore.loadSteerDispatchInput(this.#database, commandId);
  }

  async retryCommand(commandId: CommandRow["id"], error: unknown): Promise<readonly AgentEvent[]> {
    return commandStore.retryCommand(this.#database, this.#links, commandId, error);
  }

  async failCommand(
    commandId: CommandRow["id"],
    publicMessage: string,
    queuedInputCancellation:
      "activation-input" | "authority-cohort" | "seed-input" = "activation-input",
    failureCode: "dispatch_failed" | "runner_restarted" = "dispatch_failed",
  ): Promise<readonly AgentEvent[]> {
    return commandStore.failCommand(
      this.#database,
      this.#links,
      commandId,
      publicMessage,
      queuedInputCancellation,
      failureCode,
    );
  }

  async refuseSteer(commandId: CommandRow["id"], reason: string): Promise<readonly AgentEvent[]> {
    return commandStore.refuseSteer(this.#database, commandId, reason);
  }

  async markSteerUnknown(
    commandId: CommandRow["id"],
    reason: string,
  ): Promise<readonly AgentEvent[]> {
    return commandStore.markSteerUnknown(this.#database, commandId, reason);
  }

  async succeedCommand(commandId: CommandRow["id"]): Promise<readonly AgentEvent[]> {
    return this.#announceRevokedGrants(await commandStore.succeedCommand(this.#database, commandId))
      .events;
  }

  async acquireExecutionBinding(input: {
    readonly bindingLeaseExpiresAt: Date;
    readonly continuationIdentity: ProviderContinuationIdentity;
    readonly harnessInstanceId: HarnessInstanceId;
    readonly leaseTokenHash: string;
    readonly membershipGeneration: number;
    readonly runnerBootId: string;
    readonly runnerId: RunnerId;
    readonly runId: RunId;
    readonly threadId: ThreadId;
  }): Promise<
    ThreadExecutionBinding & {
      readonly continuationEvent?: AgentEvent;
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
    readonly workspaceId: WorkspaceId;
  }): Promise<UserId | null> {
    return executionStore.runRequester(this.#database, input);
  }

  async commitRunnerEvent(input: {
    readonly environmentId: EnvironmentId;
    readonly event: PendingAgentEvent;
    /**
     * What a `tool.started` integration call addressed, as the Host resolved
     * it. It is stored with the event but is not the Runner's to send, so a
     * replay is still compared against the Runner's data alone.
     */
    readonly integration?: IntegrationCallSubject;
    readonly runnerBootId: string;
    readonly runnerId: RunnerId;
  }): Promise<{
    /** Turns the Host requeued because this event ended their injection window. */
    readonly compensatingEvents: readonly AgentEvent[];
    /** A `run.usage` this Run had already stated; the first one still stands. */
    readonly duplicateRunUsage: boolean;
    readonly event: AgentEvent;
    readonly revokedGrants: readonly RevokedRunGrant[];
    readonly wasDuplicate: boolean;
  }> {
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
    readonly membershipGeneration: number;
    readonly requestedBy: UserId;
    readonly runId: RunId;
    readonly runnerBootId: string;
    readonly runnerId: RunnerId;
    readonly threadId: ThreadId;
    readonly workspaceId: WorkspaceId;
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
  ): Promise<void> {
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
  }): Promise<readonly AgentEvent[]> {
    return executionRecovery.failRunForRefusedRunnerEvent(this.#database, this.#links, input);
  }

  async drainPendingThreadStates(
    onCommitted?: (events: readonly AgentEvent[]) => void,
  ): Promise<readonly AgentEvent[]> {
    return drainPendingThreadStates(this.#database, onCommitted);
  }

  async recoverThreadWorkQueues(): Promise<readonly AgentEvent[]> {
    return executionRecovery.recoverThreadWorkQueues(this.#database);
  }

  async recordComputerUseStop(input: {
    readonly runId: RunId;
    readonly runnerId: RunnerId;
  }): Promise<void> {
    return computerUseStore.recordComputerUseStop(this.#database, input);
  }

  async activeComputerUseStops(): Promise<
    readonly { readonly runId: RunId; readonly runnerId: RunnerId }[]
  > {
    return computerUseStore.activeComputerUseStops(this.#database);
  }

  async clearComputerUseStops(runId: RunId): Promise<void> {
    return computerUseStore.clearComputerUseStops(this.#database, runId);
  }

  async recoverCommandsAfterHostRestart(): Promise<readonly AgentEvent[]> {
    return executionRecovery.recoverCommandsAfterHostRestart(this.#database, this.#links);
  }

  async attachRunnerExecutions(input: {
    /** Runs this Host is dispatching now; their dispatch settles them. */
    readonly dispatchingRunIds: readonly RunId[];
    readonly executions: readonly AnnouncedExecution[];
    readonly leaseExpiresAt: Date;
    readonly runnerBootId: string;
    readonly runnerId: RunnerId;
  }): Promise<{
    readonly events: readonly AgentEvent[];
    /** Each attached Run, with the sequence its Workspace had reached. */
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

  async stopRunsPastBackgroundDeadline(
    onStopped: (stop: BackgroundDeadlineStop) => void,
    now = new Date(),
  ): Promise<void> {
    await executionRecovery.stopRunsPastBackgroundDeadline(
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
  ): Promise<RunRecoveryOutcome> {
    return executionRecovery.recoverRunsWithExpiredExecutionBindings(
      this.#database,
      this.#links,
      (grants) => this.#announce(grants),
      now,
    );
  }

  async failActiveRunsForMembershipRevocation(input: {
    readonly userId: UserId;
    readonly workspaceId: WorkspaceId;
  }): Promise<RunRecoveryOutcome> {
    return executionRecovery.failActiveRunsForMembershipRevocation(
      this.#database,
      this.#links,
      input,
    );
  }

  async failActiveRunsForWorkspaceDeletion(workspaceId: WorkspaceId): Promise<RunRecoveryOutcome> {
    return executionRecovery.failActiveRunsForWorkspaceDeletion(
      this.#database,
      this.#links,
      workspaceId,
    );
  }

  async recordWorkspaceMount(input: {
    readonly authorizedBy: UserId;
    readonly enrollmentId: string;
    readonly environmentId: EnvironmentId;
    readonly membershipGeneration: number;
    readonly runnerId: RunnerId;
    readonly volumeId: string;
    readonly workspaceBackingGeneration: number;
    readonly workspaceId: WorkspaceId;
  }): Promise<WorkspaceMountRecord> {
    return workspaceMountStore.recordWorkspaceMount(this.#database, input);
  }

  async assertWorkspaceMountAuthority(input: {
    readonly environmentId: EnvironmentId;
    readonly membershipGeneration: number;
    readonly requestedBy: UserId;
    readonly runnerId: RunnerId;
    readonly volumeId: string;
    readonly workspaceBackingGeneration: number;
    readonly workspaceId: WorkspaceId;
  }): Promise<void> {
    return workspaceMountStore.assertWorkspaceMountAuthority(this.#database, input);
  }

  async listWorkspaceMounts(workspaceId: WorkspaceId): Promise<readonly WorkspaceMountRecord[]> {
    return workspaceMountStore.listWorkspaceMounts(this.#database, workspaceId);
  }

  async listWorkspaceMountsAuthorizedBy(input: {
    readonly authorizedBy: UserId;
    readonly workspaceId: WorkspaceId;
  }): Promise<readonly WorkspaceMountRecord[]> {
    return workspaceMountStore.listWorkspaceMountsAuthorizedBy(this.#database, input);
  }

  async listEnvironmentWorkspaceMounts(
    environmentId: EnvironmentId,
  ): Promise<readonly WorkspaceMountRecord[]> {
    return workspaceMountStore.listEnvironmentWorkspaceMounts(this.#database, environmentId);
  }

  async listReplacedWorkspaceMounts(input: {
    readonly currentGeneration: number;
    readonly workspaceId: WorkspaceId;
  }): Promise<readonly WorkspaceMountRecord[]> {
    return workspaceMountStore.listReplacedWorkspaceMounts(this.#database, input);
  }

  async requestWorkspaceMountRevocations(input: {
    readonly workspaceMountIds: readonly string[];
    readonly now?: Date;
    readonly reason: string;
  }): Promise<number> {
    return workspaceMountStore.requestWorkspaceMountRevocations(this.#database, input);
  }

  async requestWorkspaceMountRevocationByEnrollmentId(
    enrollmentId: string,
    reason: string,
    now = new Date(),
  ): Promise<boolean> {
    return workspaceMountStore.requestWorkspaceMountRevocationByEnrollmentId(
      this.#database,
      enrollmentId,
      reason,
      now,
    );
  }

  async closeEnvironment(
    environmentId: EnvironmentId,
    reason: string,
    now = new Date(),
  ): Promise<number> {
    return workspaceMountStore.closeEnvironment(this.#database, environmentId, reason, now);
  }

  async reconcileRunnerInventory(input: {
    readonly environmentId: EnvironmentId;
    readonly mounts: readonly WorkspaceMountInventoryEntry[];
    readonly now?: Date;
  }): Promise<readonly WorkspaceMountInventoryEntry[]> {
    return workspaceMountStore.reconcileRunnerInventory(this.#database, input);
  }

  async claimPendingMountEnrollmentRevocations(input: {
    readonly leaseUntil: Date;
    readonly limit: number;
    readonly now: Date;
  }): Promise<readonly PendingWorkspaceMountRevocation[]> {
    return workspaceMountStore.claimPendingMountEnrollmentRevocations(this.#database, input);
  }

  async completeMountEnrollmentRevocation(
    enrollmentId: string,
    state: "ABSENT" | "CLOSED" | "EXPIRED" | "REVOKED",
  ): Promise<void> {
    return workspaceMountStore.completeMountEnrollmentRevocation(
      this.#database,
      enrollmentId,
      state,
    );
  }

  async failMountEnrollmentRevocation(input: {
    readonly enrollmentId: string;
    readonly errorCode: string;
    readonly nextAttemptAt: Date;
  }): Promise<void> {
    return workspaceMountStore.failMountEnrollmentRevocation(this.#database, input);
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

  async workspaceSnapshot(
    workspaceId: WorkspaceId,
    options: WorkspaceSnapshotReadOptions = {},
  ): Promise<WorkspaceSnapshot> {
    return snapshotStore.workspaceSnapshot(
      this.#database,
      this.notificationState,
      workspaceId,
      options,
    );
  }

  async taskPageForUser(input: {
    readonly active?: boolean;
    readonly before?: string;
    readonly maxBytes?: number;
    readonly maxItems?: number;
    readonly userId: UserId;
    readonly workspaceId?: WorkspaceId;
  }): Promise<TaskPage> {
    return snapshotStore.taskPageForUser(this.#database, this.notificationState, input);
  }

  async threadMessagePageForOwner(input: ThreadHistoryQuery): Promise<ThreadMessagePage | null> {
    return snapshotStore.threadMessagePageForOwner(this.#database, input);
  }

  async threadEventPageForOwner(input: {
    readonly aroundMessageId?: MessageId;
    readonly before?: string;
    readonly maxBytes?: number;
    readonly maxItems?: number;
    readonly ownerId: UserId;
    readonly threadId: ThreadId;
  }): Promise<ThreadEventPage | null> {
    return snapshotStore.threadEventPageForOwner(this.#database, this.notificationState, input);
  }

  async eventsAfter(
    workspaceId: WorkspaceId,
    afterSequence: Sequence,
    limit = 500,
  ): Promise<readonly AgentEvent[]> {
    return snapshotStore.eventsAfter(this.#database, workspaceId, afterSequence, limit);
  }

  async eventsAfterWindow(
    workspaceId: WorkspaceId,
    afterSequence: Sequence,
    options: {
      readonly maxBytes: number;
      readonly maxItems: number;
      readonly throughSequence?: Sequence;
    },
  ): Promise<EventReplayWindow> {
    return snapshotStore.eventsAfterWindow(this.#database, workspaceId, afterSequence, options);
  }

  async workspaceHead(workspaceId: WorkspaceId): Promise<Sequence> {
    return snapshotStore.workspaceHead(this.#database, workspaceId);
  }
}

export { machineIsManagedBy, type MachineOwnershipRecord } from "./machine-ownership.js";

export { enqueueThreadInputInTransaction } from "./thread-inbox.js";

export { appendHostWorkspaceEvent } from "./workspace-events.js";

export { threadPathLinks, type ChannelLinks } from "./store-primitives.js";

export { configuredBootstrapEnrollmentLifetimeMs } from "./runner-store.js";

export type { CreateWorkspaceInput } from "./workspace-store.js";

export type { WorkspaceMembershipRecord } from "./workspace-membership-store.js";

export type { WorkspaceFilesAdmission } from "./workspace-store.js";

export type { WorkspaceMembershipChangeListener } from "./workspace-membership-store.js";

export type { RevokedRunGrant } from "./run-grants.js";

export type { SecurityEffectRecord } from "./workspace-membership-store.js";

export type { WorkspaceInvitationRecord } from "./workspace-membership-store.js";

export type { CreateThreadInput } from "./thread-store.js";

export type { ThreadCreationResult } from "./thread-store.js";

export type { ThreadInputSource } from "./thread-store.js";

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

export type { ActiveBrowserProfileGrantRecord } from "./browser-session-store.js";

export type { RunnerAuthenticationRecord } from "./runner-store.js";

export type { RunnerConnectionRecord } from "./runner-store.js";

export type { PendingRunnerEnrollmentRecord } from "./runner-store.js";

export type { BrowserProfileRecord } from "./browser-session-store.js";

export type { BrowserSessionRecord } from "./browser-session-store.js";
export type { BrowserUsageCredit, BrowserUsePage } from "./browser-session-store.js";

export type { BrowserSessionWithAttachmentCountRecord } from "./browser-session-store.js";

export type { BrowserProfileRevisionRecord } from "./browser-session-store.js";

export type { WorkspaceMountRecord } from "./workspace-mount-store.js";

export type { PendingWorkspaceMountRevocation } from "./workspace-mount-store.js";

export type { WorkspaceMountInventoryEntry } from "./workspace-mount-store.js";

export { runnerAdvertisesItsEnvironmentBinding } from "./runner-store.js";

export { personalReachableGrantRefusal } from "./runner-store.js";

export { personalRemoteAccessRequiredRefusal } from "./runner-store.js";

export { personalRemoteAccessRefusedReason } from "./runner-store.js";

export { runnerIdentityRevokedReason } from "./runner-store.js";

export { runnerEnrollmentExpiredReason } from "./runner-store.js";

export { phoneRunnerGrant } from "./runner-store.js";

export type { MachineAccessTargetRecord } from "./machine-store.js";

export type { ReachableMachineRecord } from "./machine-store.js";

export type { ShellSessionHistoryRecord } from "./machine-store.js";

export type { ShellSessionRecord } from "./machine-store.js";

export { assertRequestResponse } from "./command-store.js";
