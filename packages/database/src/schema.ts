import type {
  AssignmentId,
  AssignmentOrigin,
  AssignmentStatus,
  AssignmentReturnStatus,
  AuthAccountId,
  AuthAdmissionId,
  AuthSessionId,
  AuthVerificationId,
  BrowserProfileId,
  BrowserTabGroupColor,
  BrowserTabGroupId,
  BrowserSourceId,
  BrowserProfileGrantId,
  CausalChainId,
  CommandId,
  CredentialId,
  DelegationId,
  DeploymentId,
  DeploymentShape,
  EnvironmentId,
  EventId,
  ExecutionPreferences,
  HarnessId,
  HarnessInstanceId,
  HarnessInstanceStateKind,
  HostInstanceId,
  MessageId,
  MessageAuthor,
  MessageKind,
  ModelSelection,
  PersonalRemoteSessionDelivery,
  ProviderContinuationIdentity,
  ProviderSessionId,
  Request,
  RequestId,
  RunId,
  RunAttemptId,
  ExecutionNodeId,
  GrantId,
  ReplyTarget,
  RunFailure,
  RunnerId,
  SecurityAuditId,
  SecurityEffectId,
  ThreadId,
  ThreadInputPolicy,
  ThreadInputState,
  ThreadTitleSource,
  ThreadIconSource,
  MarkColor,
  WorkspaceIconName,
  ThreadAccessMode,
  ThreadRole,
  TriggerId,
  TriggerOccurrenceId,
  TriggerRevisionId,
  TriggerWatchActivationId,
  UserId,
  WorkspaceBacking,
  WorkspaceCapacityPolicy,
  WorkspaceId,
  WorkspaceInvitationId,
  WorkspaceMembershipId,
  AgentEvent,
} from "@opensteer/core";
import type {
  ChannelAccountId,
  ChannelBindingId,
  ChannelConversationId,
  ChannelConnectionIssueKind,
  ChannelDeliveryId,
  ChannelIdentityId,
  ChannelIngressId,
  ChannelProvider,
  ChannelTransportKind,
  IntegrationConnectionId,
  PrincipalId,
} from "@opensteer/channel-core";
import type { BrowserProfileAccess } from "@opensteer/browser-profile/grant";
import type {
  ComputerAppIdentity,
  LocalMcpServerSetup,
  IntegrationApplicationSource,
  IntegrationConnectionMethod,
  IntegrationGrantId,
  IntegrationAccess,
  IntegrationInstallationId,
  IntegrationInstallManifest,
  IntegrationProvider,
  IntegrationProviderApplicationId,
  IntegrationServerId,
  IntegrationSkillId,
  IntegrationToolId,
} from "@opensteer/integration-core";
import type {
  IntegrationAuthAttemptFailureReason,
  IntegrationAuthAttemptFlow,
  IntegrationAuthAttemptId,
} from "@opensteer/integration-core/ports";
import type { IntegrationAdapterSnapshot } from "@opensteer/integration-core/adapter";
import type {
  BrowserSessionId,
  BrowserSessionOpenerRecord,
  BrowserTabOpenBinding,
  HarnessInstanceCatalog,
  MachineAccessPolicy,
  RunnerDevice,
  RunnerModuleName,
  RunnerModules,
  ShellAuditEvent,
  ShellCloseReason,
  ShellSessionId,
} from "@opensteer/protocol";
import type { TriggerProgram, TriggerProgramEvent, TriggerSource } from "@opensteer/triggers";
import type { ColumnType, Generated, Selectable } from "kysely";

export type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
export type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
export type JsonColumn<T> = ColumnType<T, T, T>;

/** Threads never hold the Trigger profile, which belongs to Trigger occurrences. */
export type ThreadCapabilityProfileId = "main" | "workspace" | "delegated";

export interface DeploymentTable {
  id: DeploymentId;
  singletonKey: "primary";
  activeHostInstanceId: HostInstanceId;
  canonicalOrigin: string;
  lifecycle: "active" | "transferring" | "sealed";
  createdAt: Timestamp;
  updatedAt: Timestamp;
  deploymentShape: JsonColumn<DeploymentShape>;
}

export interface UserTable {
  id: UserId;
  displayName: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  instanceRole: "administrator" | "user";
  disabledAt: NullableTimestamp;
  /** The IANA zone this person's clients last reported; null until one does. */
  timeZone: Generated<string | null>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface AuthAccountTable {
  id: AuthAccountId;
  accountId: string;
  providerId: string;
  userId: UserId;
  accessToken: string | null;
  refreshToken: string | null;
  idToken: string | null;
  accessTokenExpiresAt: NullableTimestamp;
  refreshTokenExpiresAt: NullableTimestamp;
  scope: string | null;
  password: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface AuthSessionTable {
  id: AuthSessionId;
  userId: UserId;
  token: string;
  expiresAt: Timestamp;
  ipAddress: string | null;
  userAgent: string | null;
  absoluteExpiresAt: Timestamp;
  deviceLabel: string;
  lastSeenAt: Timestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  createdVia: ColumnType<string | null, string | null | undefined, string | null>;
  accountIssuer: ColumnType<string | null, string | null | undefined, string | null>;
  accountSubject: ColumnType<string | null, string | null | undefined, string | null>;
  grantId: ColumnType<string | null, string | null | undefined, string | null>;
}

/**
 * Generation fence for a Host-local session minted through a Personal remote
 * route. The Better Auth session remains the sole user session record; this
 * row makes remote reachability independently and immediately revocable.
 */
interface PersonalRemoteSessionTable {
  authSessionId: AuthSessionId;
  /**
   * The presentation family this session was minted for. Durable so a
   * credential cannot switch families: a header token offered as a cookie, or
   * a cookie offered in an Authorization header, is not this session.
   */
  delivery: PersonalRemoteSessionDelivery;
  routeGeneration: ColumnType<string, number | string, number | string>;
  routeKind: "connect" | "private";
  routeOrigin: string;
  createdAt: Timestamp;
}

/**
 * Positive proof that a session was established at this computer's keyboard.
 * Written only by the local-owner claim, which spends the process-launch
 * capability the application that started this Host holds, and cascaded away
 * with the session itself. "Machine-local" is this row plus a browser cookie,
 * never the absence of some other row: a native access token names the browser
 * session that authorized it, so the marker alone would travel with it.
 */
interface MachineLocalSessionTable {
  authSessionId: AuthSessionId;
  establishedAt: Timestamp;
}

interface PersonalRemoteAccessTable {
  singletonKey: "personal";
  generation: ColumnType<string, number | string, number | string>;
  mode: "off" | "connect" | "private";
  routeOrigin: string | null;
  updatedAt: Timestamp;
}

interface PersonalRemoteAccountLinkTable {
  singletonKey: "opensteer-account";
  challengeId: string;
  grantId: string;
  issuer: string;
  hostCredential: string;
  linkGeneration: string;
  state: "activating" | "active";
  subject: string;
  linkedAt: Timestamp;
  updatedAt: Timestamp;
}

interface PersonalRemotePairingCodeTable {
  credentialHash: string;
  expiresAt: Timestamp;
  generation: ColumnType<string, number | string, number | string>;
  id: string;
  issuedBySessionId: AuthSessionId;
  consumedAt: NullableTimestamp;
  createdAt: Timestamp;
}

interface PersonalRemoteSessionGrantUseTable {
  grantId: string;
  generation: ColumnType<string, number | string, number | string>;
  consumedAt: Timestamp;
}

export interface AuthVerificationTable {
  id: AuthVerificationId;
  identifier: string;
  value: string;
  expiresAt: Timestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface AuthRateLimitTable {
  id: string;
  key: string;
  count: number;
  lastRequest: ColumnType<string, number | string, number | string>;
}

interface AuthSsoProviderTable {
  id: string;
  issuer: string;
  oidcConfig: string | null;
  samlConfig: string | null;
  userId: UserId;
  providerId: string;
  organizationId: string | null;
  domain: string;
}

interface AuthAdmissionTable {
  id: AuthAdmissionId;
  purpose: "setup" | "recovery" | "invitation";
  subjectSelector: string;
  browserNonceHash: string;
  reservedEmail: string | null;
  reservedAt: NullableTimestamp;
  expiresAt: Timestamp;
  consumedAt: NullableTimestamp;
  consumedBy: UserId | null;
  createdAt: Timestamp;
}

export interface AuthJwkTable {
  id: string;
  publicKey: string;
  privateKey: string;
  createdAt: Timestamp;
  expiresAt: NullableTimestamp;
  alg: Generated<string | null>;
  crv: Generated<string | null>;
}

interface HostOAuthClientTable {
  id: string;
  clientId: string;
  clientSecret: string | null;
  disabled: boolean;
  skipConsent: boolean | null;
  enableEndSession: boolean | null;
  subjectType: string | null;
  scopes: ColumnType<readonly string[] | null, readonly string[] | null, readonly string[] | null>;
  userId: UserId | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  name: string | null;
  uri: string | null;
  icon: string | null;
  contacts: ColumnType<
    readonly string[] | null,
    readonly string[] | null,
    readonly string[] | null
  >;
  tos: string | null;
  policy: string | null;
  softwareId: string | null;
  softwareVersion: string | null;
  softwareStatement: string | null;
  redirectUris: ColumnType<readonly string[], readonly string[], readonly string[]>;
  postLogoutRedirectUris: ColumnType<
    readonly string[] | null,
    readonly string[] | null,
    readonly string[] | null
  >;
  tokenEndpointAuthMethod: string | null;
  grantTypes: ColumnType<
    readonly string[] | null,
    readonly string[] | null,
    readonly string[] | null
  >;
  responseTypes: ColumnType<
    readonly string[] | null,
    readonly string[] | null,
    readonly string[] | null
  >;
  requirePkce: boolean | null;
  referenceId: string | null;
  metadata: JsonColumn<unknown> | null;
  clientDiscoveryId: Generated<string | null>;
  clientCredentialsScopes: Generated<readonly string[] | null>;
  backchannelLogoutUri: Generated<string | null>;
  backchannelLogoutSessionRequired: Generated<boolean | null>;
  applicationType: Generated<string | null>;
  jwks: Generated<string | null>;
  jwksUri: Generated<string | null>;
  dpopBoundAccessTokens: Generated<boolean | null>;
}

interface HostOAuthRefreshTokenTable {
  id: string;
  token: string;
  clientId: string;
  sessionId: AuthSessionId;
  userId: UserId;
  referenceId: string | null;
  expiresAt: Timestamp;
  createdAt: Timestamp;
  revoked: NullableTimestamp;
  authTime: NullableTimestamp;
  scopes: ColumnType<readonly string[], readonly string[], readonly string[]>;
  authorizationCodeId: Generated<string | null>;
  resources: Generated<readonly string[] | null>;
  requestedUserInfoClaims: Generated<readonly string[] | null>;
  rotatedAt: NullableTimestamp;
  rotationReplayResponse: Generated<string | null>;
  rotationReplayExpiresAt: NullableTimestamp;
  confirmation: Generated<unknown>;
}

interface HostOAuthAccessTokenTable {
  id: string;
  token: string;
  clientId: string;
  sessionId: AuthSessionId;
  userId: UserId | null;
  referenceId: string | null;
  refreshId: string | null;
  expiresAt: Timestamp;
  createdAt: Timestamp;
  scopes: ColumnType<readonly string[], readonly string[], readonly string[]>;
  authorizationCodeId: Generated<string | null>;
  resources: Generated<readonly string[] | null>;
  requestedUserInfoClaims: Generated<readonly string[] | null>;
  revoked: NullableTimestamp;
  confirmation: Generated<unknown>;
}

interface HostOAuthConsentTable {
  id: string;
  clientId: string;
  userId: UserId | null;
  referenceId: string | null;
  scopes: ColumnType<readonly string[], readonly string[], readonly string[]>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  resources: Generated<readonly string[] | null>;
  requestedUserInfoClaims: Generated<readonly string[] | null>;
}

interface HostOAuthResourceTable {
  id: string;
  identifier: string;
  name: string;
  accessTokenTtl: number | null;
  refreshTokenTtl: number | null;
  signingAlgorithm: string | null;
  signingKeyId: string | null;
  allowedScopes: ColumnType<
    readonly string[] | null,
    readonly string[] | null,
    readonly string[] | null
  >;
  customClaims: JsonColumn<unknown> | null;
  dpopBoundAccessTokensRequired: boolean | null;
  disabled: boolean | null;
  createdAt: NullableTimestamp;
  updatedAt: NullableTimestamp;
  policyVersion: number | null;
  metadata: JsonColumn<unknown> | null;
}

interface HostOAuthClientResourceTable {
  id: string;
  clientId: string;
  resourceId: string;
  metadata: JsonColumn<unknown> | null;
  createdAt: NullableTimestamp;
}

interface HostOAuthClientAssertionTable {
  id: string;
  expiresAt: Timestamp;
}

interface AccountDirectoryProjectionTable {
  providerId: string;
  accountId: string;
  userId: UserId;
  present: boolean;
  generation: ColumnType<string, number | string, number | string>;
  publishedGeneration: ColumnType<string, number | string, number | string>;
  attempts: Generated<number>;
  nextAttemptAt: Timestamp;
  lastError: string | null;
  leaseToken: string | null;
  leaseExpiresAt: NullableTimestamp;
  updatedAt: Timestamp;
}

/**
 * The one upstream identity provider whose subjects may be published to the
 * Opensteer Account directory. Operator-owned OIDC providers are deliberately
 * absent from this table and therefore never leave the Host.
 */
interface AccountDirectoryProviderTable {
  singletonKey: "opensteer-account";
  providerId: string;
  issuer: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * Short-lived authorization from one fresh local administrator session to
 * attach this existing Deployment to one authenticated Opensteer Account.
 * The raw credential is returned once and only its digest is stored.
 */
interface HostAccountAdoptionProofTable {
  id: string;
  credentialHash: string;
  deploymentId: DeploymentId;
  hostInstanceId: HostInstanceId;
  hostKeyFingerprint: string;
  canonicalOrigin: string;
  authorizedByUserId: UserId;
  authorizedBySessionId: AuthSessionId;
  expectedIssuer: string | null;
  expectedSubject: string | null;
  expiresAt: Timestamp;
  consumedAt: NullableTimestamp;
  completedAt: NullableTimestamp;
  createdAt: Timestamp;
}

interface OwnerEnrollmentTable {
  id: string;
  tokenHash: string;
  kind: "initial" | "recovery";
  idempotencyKey: string;
  requestFingerprint: string;
  expiresAt: Timestamp;
  consumedAt: NullableTimestamp;
  consumedBy: UserId | null;
  createdAt: Timestamp;
}

interface RunnerTable {
  deviceProfile: Generated<"iphone" | null>;
  id: RunnerId;
  ownerKind: "deployment" | "user";
  ownerUserId: UserId | null;
  name: string;
  updateRequired: Generated<"agent-phone-outdated" | "runner-outdated" | null>;
  kind: "main" | "local" | "managed";
  publicKeyPem: string;
  publicKeyFingerprint: string;
  enrollmentTokenHash: string;
  capabilities: JsonColumn<readonly string[]>;
  /** Immutable grant from the enrollment; an advertisement must be a subset. */
  allowedModules: JsonColumn<readonly RunnerModuleName[]>;
  /** The last advertisement, module by module, exactly as it was signed. */
  moduleDescriptors: JsonColumn<RunnerModules>;
  /** What this computer permits callers reaching it from other computers. */
  accessPolicy: JsonColumn<MachineAccessPolicy>;
  /** Bumped by every successful policy write, including one of equal value. */
  accessPolicyRevision: number;
  /** What the computer says it is, from its last signed hello; null until it says. */
  device: JsonColumn<RunnerDevice | null>;
  connectionGeneration: ColumnType<string, number | string, number | string>;
  /** Null for a Runner with no agents module, which executes nothing. */
  maxConcurrentRuns: number | null;
  enrolledAt: Timestamp;
  lastSeenAt: NullableTimestamp;
  revokedAt: NullableTimestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * One SSH connection from one Run to one computer.
 *
 * The row is written before the target is asked to serve it, so a Host that
 * dies mid-open still leaves a session it can end at startup. `caller_runner_id`
 * and `requested_by` are recorded rather than joined: history has to stay
 * readable after the calling machine is gone.
 */
interface MachineAccessSessionTable {
  id: ShellSessionId;
  runnerId: RunnerId;
  runId: RunId;
  threadId: ThreadId;
  requestedBy: UserId;
  callerRunnerId: RunnerId;
  /** The caller's machine name snapshotted at admission, never re-joined. */
  callerMachineName: string;
  threadTitle: string;
  policyRevision: number;
  state: "pending" | "active" | "ended";
  startedAt: Timestamp;
  endedAt: NullableTimestamp;
  endReason: ShellCloseReason | null;
  bytesIn: ColumnType<string, number | string | undefined, number | string>;
  bytesOut: ColumnType<string, number | string | undefined, number | string>;
}

/** One audited SSH request, exactly as the target's helper reported it. */
interface MachineAccessEventTable {
  id: Generated<string>;
  sessionId: ShellSessionId;
  at: Timestamp;
  event: JsonColumn<ShellAuditEvent>;
}

interface ExecutionEnvironmentTable {
  id: EnvironmentId;
  name: string;
  kind: "main" | "local" | "managed";
  runnerId: RunnerId | null;
  capabilities: JsonColumn<readonly string[]>;
  createdAt: Timestamp;
}

interface RunnerEnrollmentTable {
  deviceProfile: Generated<"iphone" | null>;
  id: string;
  name: string;
  tokenHash: string;
  allowedModules: JsonColumn<readonly RunnerModuleName[]>;
  /** Null when the deployment authored the enrollment rather than a person. */
  createdBy: UserId | null;
  ownerKind: "deployment" | "user";
  ownerUserId: UserId | null;
  idempotencyKey: string;
  requestFingerprint: string;
  runnerKind: "main" | "local" | "managed";
  expiresAt: Timestamp;
  consumedAt: NullableTimestamp;
  runnerId: RunnerId | null;
  createdAt: Timestamp;
}

/**
 * One configured AI engine profile on one execution environment. A profile is
 * never hard-deleted: archived Threads and their Runs point at it forever, so
 * removal is a `removedAt` tombstone that stops the profile feeding desired
 * state while its history stays readable.
 */
interface HarnessInstanceTable {
  id: HarnessInstanceId;
  environmentId: EnvironmentId;
  driverKind: HarnessId;
  name: string;
  config: JsonColumn<unknown>;
  runtimeRevision: number;
  stateKind: HarnessInstanceStateKind;
  enabled: boolean;
  /** Which account of this driver a person means when they name none. */
  isDefault: boolean;
  /** Who this account talks to; one of the sources its engine declares. */
  sourceId: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  removedAt: NullableTimestamp;
}

/**
 * What a Runner last reported an AI engine can do in one environment. Request
 * paths read this durable answer instead of requiring a live socket. Dispatch
 * re-asks the live Runner before a run starts, which keeps a stale row costing
 * at most a queued run that fails honestly — never a wrong placement.
 */
interface HarnessCatalogTable {
  environmentId: EnvironmentId;
  harnessInstanceId: HarnessInstanceId;
  catalog: JsonColumn<HarnessInstanceCatalog>;
  capturedAt: Timestamp;
}

/**
 * What one person chose last about how their work runs, kept by the Host so
 * every app they open starts a Thread from the same place. One row per person,
 * rewritten in full on each choice: the record is small, and the merge rule
 * that produces it lives in `@opensteer/core` where every caller shares it.
 *
 * Everything here is a hint about intent. A Thread re-validates the account,
 * model and access mode against live catalogs when it starts, so a stale row
 * costs a person one re-pick, never a wrong placement.
 */
interface UserExecutionPreferenceTable {
  userId: UserId;
  preferences: JsonColumn<ExecutionPreferences>;
  updatedAt: Timestamp;
}

export interface WorkspaceTable {
  color: MarkColor;
  homeThreadId: Generated<ThreadId | null>;
  backing: JsonColumn<WorkspaceBacking>;
  capacityPolicy: JsonColumn<WorkspaceCapacityPolicy>;
  deletedAt: NullableTimestamp;
  deletionRequestedAt: NullableTimestamp;
  deletionRequestedBy: UserId | null;
  icon: ColumnType<string | null, string | null | undefined, string | null>;
  id: WorkspaceId;
  kind: "main" | "specialized";
  lastActivityAt: Timestamp;
  name: string;
  /** Generated from the backing so the owning machine is a real reference the
   * database can enforce. It is never written directly. */
  ownerEnvironmentId: ColumnType<EnvironmentId | null, never, never>;
  purgeAfter: NullableTimestamp;
  status:
    | "provisioning"
    | "ready"
    | "archiving"
    | "archived"
    | "unavailable"
    | "failed"
    | "deleting"
    | "deleted";
  storageErrorAt: NullableTimestamp;
  storageErrorCode: ColumnType<string | null, string | null | undefined, string | null>;
  storageErrorMessage: ColumnType<string | null, string | null | undefined, string | null>;
  storageErrorRetryable: Generated<boolean>;
  eventSequence: Generated<string>;
  createdBy: UserId;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface WorkspaceMembershipTable {
  id: WorkspaceMembershipId;
  workspaceId: WorkspaceId;
  userId: UserId;
  role: "owner" | "collaborator";
  state: "active" | "revoked";
  generation: ColumnType<string, number | string, number | string>;
  invitedBy: UserId | null;
  joinedAt: Timestamp;
  revokedAt: NullableTimestamp;
  revokedBy: UserId | null;
  updatedAt: Timestamp;
}

export interface WorkspaceInvitationTable {
  id: WorkspaceInvitationId;
  workspaceId: WorkspaceId;
  selector: string;
  tokenHash: string;
  type: "email" | "link";
  intendedEmail: string | null;
  role: "owner" | "collaborator";
  createdBy: UserId;
  idempotencyKey: string;
  requestFingerprint: string;
  expiresAt: Timestamp;
  acceptedAt: NullableTimestamp;
  acceptedBy: UserId | null;
  revokedAt: NullableTimestamp;
  revokedBy: UserId | null;
  createdAt: Timestamp;
}

interface SecurityAuditTable {
  id: SecurityAuditId;
  actorUserId: UserId | null;
  actorSessionId: AuthSessionId | null;
  workspaceId: WorkspaceId | null;
  action: string;
  targetType: string;
  targetId: string | null;
  requestId: string | null;
  metadata: JsonColumn<Readonly<Record<string, unknown>>>;
  createdAt: Timestamp;
}

interface SecurityEffectTable {
  id: SecurityEffectId;
  workspaceId: WorkspaceId;
  userId: UserId;
  membershipGeneration: ColumnType<string, number | string, number | string>;
  kind:
    | "close-realtime"
    | "stop-runs"
    | "revoke-mounts"
    | "revoke-browser"
    | "revoke-credentials"
    | "revoke-triggers";
  status: "pending" | "processing" | "completed" | "failed";
  attempts: Generated<number>;
  nextAttemptAt: Timestamp;
  lastError: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ThreadTable {
  doneAt: Generated<Date | null>;
  pendingRequestCount: Generated<number>;
  projectedInputQueuePaused: Generated<boolean>;
  inputQueuePaused: Generated<boolean>;
  inputQueuePausedBy: Generated<UserId | null>;
  accessMode: Generated<ThreadAccessMode>;
  capabilityProfileId: ThreadCapabilityProfileId;
  role: Generated<ThreadRole>;
  id: ThreadId;
  lineageRootThreadId: ThreadId;
  workspaceId: WorkspaceId;
  parentThreadId: ThreadId | null;
  listed: boolean;
  title: string;
  titleSource: Generated<ThreadTitleSource>;
  icon: WorkspaceIconName | null;
  iconSource: ThreadIconSource;
  color: MarkColor;
  environmentId: EnvironmentId;
  harnessInstanceId: HarnessInstanceId;
  modelSelection: JsonColumn<ModelSelection>;
  status: "idle" | "running" | "waiting" | "failed" | "archived";
  createdBy: UserId;
  createdByPrincipalId: PrincipalId;
  nextMessageSequence: Generated<string>;
  nextRunOrdinal: Generated<number>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface MessageTable {
  addressedToUserId: Generated<UserId | null>;
  quote: Generated<import("@opensteer/core").MessageQuote | null>;
  author: JsonColumn<MessageAuthor>;
  id: MessageId;
  threadId: ThreadId;
  runId: RunId | null;
  sequence: ColumnType<string, number | string, number | string>;
  kind: MessageKind;
  actorPrincipalId: PrincipalId;
  content: JsonColumn<readonly unknown[]>;
  createdAt: Timestamp;
}

export interface AttachmentTable {
  id: string;
  workspaceId: WorkspaceId;
  uploaderId: UserId;
  name: string;
  mediaType: string;
  sizeBytes: number;
  kind: "image" | "file" | null;
  width: number | null;
  height: number | null;
  sha256: string | null;
  state: "uploading" | "ready" | "deleting";
  idempotencyKey: string;
  requestFingerprint: string;
  messageId: MessageId | null;
  threadId: ThreadId | null;
  createdAt: Timestamp;
  expiresAt: Timestamp;
}

export interface ThreadInputTable {
  assignmentId: Generated<AssignmentId | null>;
  actorPrincipalId: PrincipalId;
  authoritySource: JsonColumn<Readonly<Record<string, unknown>>>;
  cancelReason: string | null;
  causalChainId: CausalChainId;
  deliveredAt: NullableTimestamp;
  idempotencyKey: string;
  membershipGeneration: ColumnType<string, number | string, number | string>;
  messageId: MessageId;
  policy: ThreadInputPolicy;
  /** Where waiting work stands in line; admission takes the lowest first. */
  queueRank: ColumnType<string, number | string, number | string>;
  replyTarget: JsonColumn<ReplyTarget | null>;
  requestFingerprint: string;
  requestedBy: UserId;
  runId: RunId | null;
  state: ThreadInputState;
  steerCommandId: CommandId | null;
  threadId: ThreadId;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

interface CausalChainTable {
  createdAt: Timestamp;
  id: CausalChainId;
  maxDelegations: number;
  maxAutonomousRuns: number;
  rootMessageId: MessageId | null;
  rootOccurrenceId: TriggerOccurrenceId | null;
  rootWatchActivationId: Generated<TriggerWatchActivationId | null>;
  rootWatchObservationId: Generated<string | null>;
  usedDelegations: number;
  usedAutonomousRuns: number;
}

export interface RunReportContext {
  readonly messageIds: readonly MessageId[];
  readonly omittedCount: number;
  readonly throughSequence: string | null;
}

export interface RunInitialContext {
  readonly finalized?: true;
  readonly messageIds: readonly MessageId[];
  readonly omittedCount: number;
  readonly throughSequence: string | null;
}

export interface RunTable {
  doneWhenFinished: Generated<boolean>;
  assignmentId: Generated<AssignmentId | null>;
  initialContext: ColumnType<
    RunInitialContext | null,
    RunInitialContext | null | undefined,
    RunInitialContext | null
  >;
  /** Nullable only for historical Runs whose session cannot be established safely. */
  providerSessionId: ProviderSessionId | null;
  reportContext: ColumnType<
    RunReportContext | null,
    RunReportContext | null | undefined,
    RunReportContext | null
  >;
  accessMode: ThreadAccessMode;
  activationInputId: MessageId;
  causalChainId: CausalChainId;
  id: RunId;
  threadId: ThreadId;
  environmentId: EnvironmentId;
  failure: ColumnType<RunFailure | null, RunFailure | null | undefined, RunFailure | null>;
  harnessInstanceId: HarnessInstanceId;
  modelSelection: JsonColumn<ModelSelection>;
  replyTarget: JsonColumn<ReplyTarget | null>;
  requestedBy: UserId;
  membershipGeneration: ColumnType<string, number | string, number | string>;
  actorPrincipalId: PrincipalId;
  authoritySource: JsonColumn<Readonly<Record<string, unknown>>>;
  runOrdinal: number;
  seedInputId: MessageId;
  nextRunnerOrdinal: Generated<number>;
  /** The binding generation this Run acquired; null until it has one. */
  bindingGeneration: Generated<number | null>;
  /** `background` once its engine finished a turn with background work still running. */
  phase: Generated<"turn" | "background">;
  /** When that background work is stopped; set the first time the Run goes to the background. */
  backgroundDeadlineAt: Generated<Date | null>;
  /** The reply its channel was sent when a turn ended in the background. */
  turnReplyMessageId: Generated<MessageId | null>;
  status: "queued" | "starting" | "running" | "waiting" | "completed" | "failed" | "interrupted";
  createdAt: Timestamp;
  startedAt: NullableTimestamp;
  completedAt: NullableTimestamp;
  /**
   * What the engine reported this Run consumed. Null until a `run.usage` event
   * arrives, and null forever for an engine that reports nothing. `bigint` and
   * `numeric` both come back from `pg` as strings, which is why the select type
   * is a string.
   */
  inputTokens: ColumnType<string | null, number | null | undefined, number | null>;
  outputTokens: ColumnType<string | null, number | null | undefined, number | null>;
  cachedInputTokens: ColumnType<string | null, number | null | undefined, number | null>;
  cacheWriteTokens: ColumnType<string | null, number | null | undefined, number | null>;
  reasoningTokens: ColumnType<string | null, number | null | undefined, number | null>;
  costUsd: ColumnType<string | null, number | null | undefined, number | null>;
}

/**
 * One execution of a Run by its engine. A Run normally has one; a restart in
 * the same Run supersedes the previous attempt rather than starting a new Run.
 * The current attempt's outcome is the Run's own status.
 */
export interface RunAttemptTable {
  id: RunAttemptId;
  runId: RunId;
  ordinal: number;
  reason: "initial" | "steer_restart" | "recovery";
  status: "current" | "superseded";
  startedAt: Timestamp;
  supersededAt: NullableTimestamp;
  supersededBy: RunAttemptId | null;
  /** The binding this attempt last executed under, once dispatched. */
  bindingGeneration: number | null;
  runnerId: RunnerId | null;
  runnerBootId: string | null;
  /** The selection the attempt was dispatched with. */
  modelSelection: JsonColumn<ModelSelection | null>;
  dispatchedAt: NullableTimestamp;
  /** Whether the engine was already running for the Thread, as its Runner reported. */
  engineStart: "cold" | "warm" | null;
  /** When the engine accepted the work (`run.started`). */
  firstEventAt: NullableTimestamp;
  endedAt: NullableTimestamp;
  outcome: "completed" | "failed" | "interrupted" | "cancelled" | null;
  /** As on the Run: `bigint` and `numeric` come back from `pg` as strings. */
  inputTokens: ColumnType<string | null, number | null | undefined, number | null>;
  outputTokens: ColumnType<string | null, number | null | undefined, number | null>;
  cachedInputTokens: ColumnType<string | null, number | null | undefined, number | null>;
  cacheWriteTokens: ColumnType<string | null, number | null | undefined, number | null>;
  reasoningTokens: ColumnType<string | null, number | null | undefined, number | null>;
  costUsd: ColumnType<string | null, number | null | undefined, number | null>;
}

/**
 * One subagent a Run's engine started, under one attempt. A resumed child
 * session is a new node that shares `sessionRef`. Its usage is its own share,
 * which the Run's usage already includes.
 */
export interface ExecutionNodeTable {
  id: ExecutionNodeId;
  runId: RunId;
  attemptId: RunAttemptId;
  parentNodeId: ExecutionNodeId | null;
  kind: "subagent" | "task";
  title: string;
  prompt: string | null;
  model: string | null;
  nativeRef: string;
  sessionRef: string | null;
  originCallId: string | null;
  status: "running" | "completed" | "failed" | "interrupted";
  result: string | null;
  startedAt: Timestamp;
  endedAt: NullableTimestamp;
  inputTokens: ColumnType<string | null, number | null | undefined, number | null>;
  outputTokens: ColumnType<string | null, number | null | undefined, number | null>;
  cachedInputTokens: ColumnType<string | null, number | null | undefined, number | null>;
  cacheWriteTokens: ColumnType<string | null, number | null | undefined, number | null>;
  reasoningTokens: ColumnType<string | null, number | null | undefined, number | null>;
  costUsd: ColumnType<string | null, number | null | undefined, number | null>;
}

/**
 * The authority behind a Run's capability tokens: one per execution binding of
 * an attempt. Tool use needs an active grant; the Runner's own reporting needs
 * only its binding, so stopping a Run cuts its tools while it winds down.
 */
export interface GrantTable {
  id: GrantId;
  runId: RunId;
  attemptId: RunAttemptId;
  bindingGeneration: number;
  runnerId: RunnerId;
  runnerBootId: string;
  status: "active" | "revoked";
  /** Set only when authority ended while the Run lived on. */
  revokedReason: "stopped" | "assignment-cancelled" | "binding-replaced" | "superseded" | null;
  createdAt: Timestamp;
  revokedAt: NullableTimestamp;
}

export interface DelegationTable {
  /** Historical table name retained for existing installations. */
  initialInputMessageId: Generated<MessageId>;
  objective: Generated<string>;
  origin: Generated<AssignmentOrigin>;
  parentAssignmentId: Generated<AssignmentId | null>;
  status: Generated<AssignmentStatus>;
  resultText: Generated<string | null>;
  resultRunId: Generated<RunId | null>;
  finishedAt: NullableTimestamp;
  revision: Generated<number>;
  childRunId: RunId;
  childThreadId: ThreadId;
  completedAt: NullableTimestamp;
  createdAt: Timestamp;
  id: DelegationId;
  parentOccurrenceId: TriggerOccurrenceId | null;
  parentWatchActivationId: Generated<TriggerWatchActivationId | null>;
  parentRunId: RunId | null;
  parentThreadId: ThreadId;
  replyTarget: JsonColumn<ReplyTarget | null>;
  resultAttemptedAt: NullableTimestamp;
  resultMessageId: MessageId | null;
  resultReason: string | null;
  resultStatus: AssignmentReturnStatus;
  updatedAt: Timestamp;
}

export interface WatchControlRequestTable {
  activationId: TriggerWatchActivationId;
  action: "thread.delegate" | "thread.message";
  observationId: string;
  requestFingerprint: string;
  requestId: string;
  createdAt: Timestamp;
}

export interface RequestTable {
  id: RequestId;
  kind: Request["kind"];
  mode: Request["mode"];
  status: Request["status"];
  originatingWorkspaceId: WorkspaceId;
  originatingThreadId: ThreadId;
  /** Exactly one origin is present; a Trigger Occurrence creates no Run row. */
  originatingRunId: RunId | null;
  originatingOccurrenceId: TriggerOccurrenceId | null;
  /** The subagent of the originating Run that asked, if not its own agent. */
  originatingNodeId: Generated<ExecutionNodeId | null>;
  callId: string;
  targetWorkspaceId: WorkspaceId;
  requestedBy: UserId;
  requiredActor: Request["requiredActor"];
  presentation: JsonColumn<Request["presentation"]>;
  payload: JsonColumn<Request["payload"]>;
  response: JsonColumn<Request["response"]> | null;
  /** A response is reserved for exactly one durable delivery command until ACK. */
  responseCommandId: Generated<CommandId | null>;
  cancellationReason: Request["cancellationReason"];
  resolvedAt: NullableTimestamp;
  resolvedBy: UserId | null;
  createdAt: Timestamp;
}

/** The single Request detail table: integration identifiers need relational FK integrity. */
interface IntegrationRequestDetailTable {
  access: IntegrationAccess | null;
  requestId: RequestId;
  installationId: IntegrationInstallationId | null;
  requestedConnectionId: IntegrationConnectionId | null;
  requestedServerId: IntegrationServerId | null;
  manifest: JsonColumn<IntegrationInstallManifest | null>;
}

/** A call that joined a Request its Run already had open; see `openPasswordSignIn`. */
interface RequestCallJoinTable {
  originatingRunId: RunId;
  callId: string;
  requestId: RequestId;
  createdAt: Generated<Timestamp>;
}

interface RequestContinuationTable {
  requestId: RequestId;
  status: "waiting" | "queued" | "undeliverable";
  attemptedAt: NullableTimestamp;
  reason: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface WorkspaceMountTable {
  id: string;
  environmentId: EnvironmentId;
  runnerId: RunnerId;
  workspaceId: WorkspaceId;
  volumeId: string;
  workspaceBackingGeneration: ColumnType<string, number | string, number | string>;
  enrollmentId: string;
  authorizedBy: UserId;
  membershipGeneration: ColumnType<string, number | string, number | string>;
  status: "active" | "revocation_pending" | "closed" | "revoked" | "expired";
  terminationReason: string | null;
  revocationAttempts: Generated<number>;
  nextAttemptAt: NullableTimestamp;
  lastErrorCode: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

interface TriggerTable {
  id: TriggerId;
  workspaceId: WorkspaceId;
  anchorThreadId: ThreadId;
  createdBy: UserId;
  createdByThreadId: ThreadId | null;
  idempotencyKey: string;
  requestFingerprint: string;
  name: string;
  kind: "schedule" | "webhook" | "watch";
  status: "active" | "paused" | "archived";
  currentRevisionId: TriggerRevisionId;
  nextFireAt: NullableTimestamp;
  consecutiveFailures: number;
  pauseReason: string | null;
  webhookRouteKey: string | null;
  webhookSecretHash: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

interface TriggerRevisionTable {
  id: TriggerRevisionId;
  triggerId: TriggerId;
  ordinal: number;
  source: JsonColumn<TriggerSource>;
  program: JsonColumn<TriggerProgram>;
  createdBy: UserId;
  createdByThreadId: ThreadId | null;
  createdAt: Timestamp;
}

export interface TriggerWatchActivationTable {
  id: TriggerWatchActivationId;
  triggerId: TriggerId;
  revisionId: TriggerRevisionId;
  environmentId: EnvironmentId;
  workspaceId: WorkspaceId;
  anchorThreadId: ThreadId;
  createdBy: UserId;
  desired: "active" | "stopped";
  observed: "starting" | "running" | "backoff" | "expired" | "stopped";
  executionGeneration: ColumnType<string, number | string, number | string>;
  runnerId: RunnerId | null;
  runnerBootId: string | null;
  runnerConnectionGeneration: ColumnType<
    string | null,
    number | string | null,
    number | string | null
  >;
  restartCount: number;
  consecutiveFailures: number;
  healthySince: NullableTimestamp;
  lastExitCode: number | null;
  lastError: string | null;
  stdoutTail: string;
  stderrTail: string;
  leaseExpiresAt: NullableTimestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface TriggerOccurrenceTable {
  causalChainId: Generated<CausalChainId | null>;
  id: TriggerOccurrenceId;
  triggerId: TriggerId;
  revisionId: TriggerRevisionId;
  commandId: CommandId;
  environmentId: EnvironmentId;
  sourceKey: string;
  event: JsonColumn<TriggerProgramEvent>;
  status: "pending" | "running" | "succeeded" | "failed" | "canceled";
  executionGeneration: Generated<number>;
  runnerId: RunnerId | null;
  runnerBootId: string | null;
  result: JsonColumn<unknown> | null;
  error: JsonColumn<unknown> | null;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  startedAt: NullableTimestamp;
  completedAt: NullableTimestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ProviderSessionTable {
  active: boolean;
  stateLayout: "thread" | "session";
  id: ProviderSessionId;
  threadId: ThreadId;
  harnessInstanceId: HarnessInstanceId;
  continuationIdentity: JsonColumn<ProviderContinuationIdentity | null>;
  providerSessionReference: string | null;
  runnerId: RunnerId | null;
  runnerBootId: string | null;
  bindingGeneration: number;
  leaseTokenHash: string | null;
  leaseExpiresAt: NullableTimestamp;
  status: "starting" | "ready" | "running" | "stopped" | "broken";
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

type CommandStatus = "pending" | "dispatched" | "succeeded" | "failed" | "unknown";

export interface CommandTable {
  id: CommandId;
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  runId: RunId | null;
  requestedBy: UserId;
  actorPrincipalId: PrincipalId;
  authoritySource: JsonColumn<Readonly<Record<string, unknown>>>;
  idempotencyKey: string;
  type: string;
  payload: JsonColumn<unknown>;
  encryptedRequestResponse: Generated<Buffer | null>;
  requestResponseKeyVersion: Generated<number | null>;
  status: CommandStatus;
  attempts: Generated<number>;
  dispatcherId: string | null;
  lastError: JsonColumn<unknown> | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface AgentControlRequestTable {
  resultMessageId: Generated<MessageId | null>;
  runId: RunId;
  requestId: string;
  sourceThreadId: ThreadId;
  action:
    | "assignment.cancel"
    | "machine.full-disk-access.request"
    | "browser.access.request"
    | "browser.profile.create"
    | "browser.profile.list"
    | "browser.profile.save"
    | "browser.sign-in"
    | "browser.session.close"
    | "browser.session.list"
    | "browser.session.open"
    | "browser.tab.read"
    | "browser.tab.write"
    | "request.list"
    | "request.withdraw"
    | "thread.delegate"
    | "thread.list"
    | "thread.message"
    | "person.notify"
    | "thread.read"
    | "thread.write"
    | "trigger.read"
    | "trigger.write"
    | "workspace.create"
    | "environment.list"
    | "workspace.list"
    | "workspace.inspect"
    | "workspace.mount";
  actionClass:
    | "assignment.cancel"
    | "machine.full-disk-access.request"
    | "browser.access.request"
    | "browser.profile.create"
    | "browser.profile.list"
    | "browser.profile.save"
    | "browser.sign-in"
    | "browser.session.close"
    | "browser.session.list"
    | "browser.session.open"
    | "browser.tab.read"
    | "browser.tab.write"
    | "request.list"
    | "request.withdraw"
    | "thread.delegate"
    | "thread.list"
    | "thread.message"
    | "thread.read"
    | "thread.write"
    | "trigger.read"
    | "trigger.write"
    | "workspace.create"
    | "environment.list"
    | "workspace.inspect"
    | "workspace.mount";
  requestFingerprint: string;
  createdAt: Timestamp;
}

/**
 * Admission ledger for the Trigger control path. An Occurrence is the unit of
 * authority there — it owns the token the program speaks with — so the per-run
 * ledger above has no row to hang these requests on.
 */
interface TriggerControlRequestTable {
  occurrenceId: TriggerOccurrenceId;
  requestId: string;
  action: AgentControlRequestTable["action"];
  actionClass: AgentControlRequestTable["actionClass"];
  requestFingerprint: string;
  createdAt: Timestamp;
}

/**
 * Streaming deltas that earlier Hosts stored as durable events. They are kept
 * rather than deleted, because removing rows would leave holes a replay could
 * not tell from lost events, and nothing reads them: every read of the log
 * skips them and reports how far it scanned.
 */
export const legacyLiveEventTypes = ["assistant.delta", "reasoning.delta", "tool.delta"] as const;
export type LegacyLiveEventType = (typeof legacyLiveEventTypes)[number];

export interface WorkspaceEventTable {
  sequence: string;
  eventId: EventId;
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  runId: RunId | null;
  environmentId: EnvironmentId;
  runnerOrdinal: number | null;
  runnerId: RunnerId | null;
  runnerBootId: string | null;
  runnerBindingGeneration: number | null;
  type: AgentEvent["type"] | LegacyLiveEventType;
  data: JsonColumn<unknown>;
  createdAt: Timestamp;
}

/**
 * An automation that stopped working, owed to the Thread it is anchored to.
 * Settled once its message is queued there, or once it cannot be.
 */
export interface AutomationFailureNoticeTable {
  id: string;
  triggerId: TriggerId;
  occurrenceId: TriggerOccurrenceId | null;
  activationId: TriggerWatchActivationId | null;
  reason: "final-occurrence-failed" | "final-occurrence-interrupted" | "paused";
  detail: string;
  attempts: Generated<number>;
  nextAttemptAt: Generated<Date>;
  lastError: string | null;
  settledAt: NullableTimestamp;
  createdAt: Generated<Date>;
}

export interface ThreadReadMarkerTable {
  threadId: ThreadId;
  userId: UserId;
  sequence: ColumnType<string, number | string, number | string>;
  updatedAt: Timestamp;
}

export interface AgentNotificationMuteTable {
  workspaceId: WorkspaceId;
  userId: UserId;
  muted: boolean;
  revision: Generated<string>;
  updatedAt: Timestamp;
}

interface CredentialTable {
  id: CredentialId;
  ownerId: UserId;
  name: string;
  provider: string;
  encryptedPayload: Buffer;
  encryptionKeyVersion: number;
  metadata: JsonColumn<Readonly<Record<string, unknown>>>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

interface CredentialVaultCanaryTable {
  keyVersion: number;
  encryptedPayload: Buffer;
  createdAt: Timestamp;
}

interface BrowserProfileTable {
  id: BrowserProfileId;
  ownerId: UserId;
  name: string;
  revision: Generated<number>;
  archivedAt: NullableTimestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

interface BrowserProfileRevisionTable {
  profileId: BrowserProfileId;
  revision: number;
  ciphertext: Uint8Array;
  ciphertextSha256: string;
  createdAt: Timestamp;
}

interface WorkspaceTabTable {
  id: string;
  createdAt: Timestamp;
  groupId: BrowserSessionId;
  sessionId: BrowserSessionId;
  title: string;
  url: string;
  favicon: Generated<string | null>;
  iconRef: Generated<string | null>;
  order: number;
  openerId: string | null;
  state: "suspended" | "restoring" | "live";
  closedBy: Generated<UserId | null>;
  closedAfterTabId: Generated<string | null>;
  closedTabGroupId: Generated<BrowserTabGroupId | null>;
  reopenedAt: Generated<Date | null>;
  closedAt: NullableTimestamp;
}

interface BrowserSessionTable {
  tabGroupId: Generated<BrowserSessionId>;
  tabRevision: Generated<number>;
  opener: JsonColumn<BrowserSessionOpenerRecord | null>;
  id: BrowserSessionId;
  origin: "agent" | "trigger" | "workspace";
  /** Null for a fresh session: no identity, and therefore no state lease. */
  profileId: BrowserProfileId | null;
  workspaceId: WorkspaceId;
  placementKey: string;
  runnerId: RunnerId;
  runtimeId: string;
  state: "starting" | "ready" | "closing" | "closed" | "failed";
  leaseTokenHash: string | null;
  leaseGeneration: number;
  profileLeaseExpiresAt: NullableTimestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  closedAt: NullableTimestamp;
}

interface BrowserSessionAttachmentTable {
  agentBindingId: string;
  ownerId: UserId;
  sessionId: BrowserSessionId;
  workspaceId: WorkspaceId;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

interface BrowserSessionUseTable {
  id: string;
  sessionId: BrowserSessionId;
  threadId: ThreadId;
  runId: RunId | null;
  tabId: string | null;
  pageTitle: ColumnType<string | null, string | null | undefined, string | null>;
  pageSite: ColumnType<string | null, string | null | undefined, string | null>;
  firstUsedAt: Timestamp;
  lastUsedAt: Timestamp;
}

interface BrowserProfileGrantTable {
  access: BrowserProfileAccess;
  id: BrowserProfileGrantId;
  workspaceId: WorkspaceId;
  createdBy: UserId;
  profileId: BrowserProfileId;
  createdAt: Timestamp;
  revokedAt: NullableTimestamp;
}

interface BrowserSourceTable {
  id: BrowserSourceId;
  ownerId: UserId;
  name: string;
  tokenHash: string;
  generation: Generated<number>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  revokedAt: NullableTimestamp;
  lastSeenAt: NullableTimestamp;
}

interface BrowserSourcePairingTable {
  codeHash: string;
  ownerId: UserId;
  createdAt: Timestamp;
  expiresAt: Timestamp;
  consumedAt: NullableTimestamp;
  canonicalOrigin: string;
  remoteOrigin: string | null;
  remoteGeneration: number | null;
}

interface BrowserSiteGrantTable {
  id: string;
  ownerId: UserId;
  workspaceId: WorkspaceId;
  site: string;
  preferredSourceId: BrowserSourceId | null;
  createdAt: Timestamp;
  lastSignedInAt: NullableTimestamp;
  revokedAt: NullableTimestamp;
}

interface BrowserSignInTable {
  ownerId: UserId;
  id: string;
  workspaceId: WorkspaceId;
  site: string;
  sourceId: BrowserSourceId;
  sourceName: string;
  sessionId: string;
  profileName: string | null;
  requestId: RequestId | null;
  actor: "agent" | "owner" | "request";
  createdAt: Timestamp;
}

/** Legacy: copies of a Chrome login into new profiles, before live sign-ins. */
interface BrowserSourceImportTable {
  id: string;
  sourceId: BrowserSourceId;
  workspaceId: WorkspaceId;
  ownerId: UserId;
  site: string;
  profileName: string;
  remember: boolean;
  profileId: BrowserProfileId;
  requestId: RequestId | null;
  createdAt: Timestamp;
}

interface CredentialAccessAuditTable {
  actorId: string;
  id: string;
  credentialId: CredentialId;
  connectionId: IntegrationConnectionId;
  runnerId: RunnerId | null;
  purpose: "channel-delivery" | "channel-transport" | "channel-webhook";
  createdAt: Timestamp;
}

interface PrincipalTable {
  id: PrincipalId;
  kind: "user" | "channel-identity" | "system";
  userId: UserId | null;
  displayName: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface IntegrationConnectionTable {
  accountIdentifier: string | null;
  applicationSource: JsonColumn<IntegrationApplicationSource | null>;
  authMethodId: string | null;
  authorizationDigest: string | null;
  id: IntegrationConnectionId;
  ownerUserId: UserId;
  credentialId: CredentialId | null;
  credentialGeneration: Generated<number>;
  connectionKind: "provider-account" | "channel" | "computer" | "mcp-oauth";
  computerAccess: IntegrationAccess | null;
  /**
   * Which app this computer connection names, for a definition whose
   * connections do — today `macos-app` alone. Null for every other computer
   * app, whose connection is the definition on the Runner and nothing finer.
   */
  computerApp: Generated<ComputerAppIdentity | null>;
  /**
   * `computerAppIdentityKey(computerApp)` — the lowercased bundle identifier,
   * written by the store rather than generated by Postgres so the key stored
   * in the unique index is byte-for-byte the key the code queries with.
   */
  computerAppKey: Generated<string | null>;
  computerBlockedAt: NullableTimestamp;
  computerPolicyRevision: Generated<number | null>;
  provider: string;
  integrationServerId: IntegrationServerId | null;
  providerApplicationId: IntegrationProviderApplicationId | null;
  connectionMethod: IntegrationConnectionMethod;
  status: "pending" | "connected" | "needs-attention" | "paused" | "revoked";
  displayName: string;
  externalIdentityId: string | null;
  externalTenantId: string | null;
  capabilities: JsonColumn<readonly string[]>;
  grantedScopes: JsonColumn<readonly string[]>;
  integrationDefinitionId: string | null;
  /**
   * For a channel connection, the messaging service currently assigned to it
   * and therefore allowed to move. For a computer connection, its permanent
   * placement, which never changes.
   */
  runnerId: RunnerId | null;
  /**
   * For a channel whose transport runs on a computer, the app connection it is
   * a use of — iMessage of that Mac's `apple-messages` — which it never
   * outlives (`channelSourceAllows`). Null for every other connection.
   */
  sourceConnectionId: Generated<IntegrationConnectionId | null>;
  statusDetail: string | null;
  statusReason: Generated<ChannelConnectionIssueKind | null>;
  transportKind: ChannelTransportKind | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

interface IntegrationApplicationSourceDefaultTable {
  provider: string;
  sourceKind: "deployment-oauth" | "hosted-oauth";
  updatedAt: Timestamp;
  updatedBy: UserId;
}

interface IntegrationAuthAttemptTable {
  id: IntegrationAuthAttemptId;
  flow: IntegrationAuthAttemptFlow;
  ownerUserId: UserId;
  stateHash: string;
  launchTicketHash: string;
  browserBindingHash: string | null;
  encryptedPayload: Buffer;
  encryptionKeyVersion: number;
  status: "pending" | "launched" | "claimed" | "completed" | "failed";
  surface: "desktop" | "native" | "web";
  failureReason: IntegrationAuthAttemptFailureReason | null;
  resultConnectionId: IntegrationConnectionId | null;
  expiresAt: Timestamp;
  launchedAt: NullableTimestamp;
  claimedAt: NullableTimestamp;
  completedAt: NullableTimestamp;
  createdAt: Timestamp;
}

interface IntegrationAuthorityPendingTable {
  transactionId: string;
  ownerUserId: UserId;
}

interface IntegrationAuthorityGenerationTable {
  ownerUserId: UserId;
  generation: number;
  updatedAt: Timestamp;
}

interface McpOAuthCredentialTable {
  connectionId: IntegrationConnectionId;
  encryptedState: Buffer;
  encryptionKeyVersion: number;
  revision: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface IntegrationProviderApplicationTable {
  id: IntegrationProviderApplicationId;
  provider: IntegrationProvider;
  displayName: string;
  clientId: string;
  encryptedSecrets: Buffer;
  encryptionKeyVersion: number;
  installationUrl: Generated<string | null>;
  ownerUserId: UserId | null;
  revision: number;
  status: "active" | "disabled";
  createdBy: UserId;
  updatedBy: UserId;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface IntegrationInstallationTable {
  adapterSnapshot: JsonColumn<IntegrationAdapterSnapshot> | null;
  id: IntegrationInstallationId;
  name: string;
  title: string;
  description: string;
  version: string | null;
  sourceKind: "agent-plugin" | "built-in" | "proposed" | "remote-mcp";
  trust: "built-in" | "verified-publisher" | "administrator-approved";
  manifest: JsonColumn<Readonly<Record<string, unknown>>>;
  provenance: JsonColumn<Readonly<Record<string, unknown>>>;
  status: "active" | "disabled" | "needs-attention";
  revision: number;
  createdBy: UserId | null;
  updatedBy: UserId | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface IntegrationServerTable {
  connectionRequirement: JsonColumn<Readonly<Record<string, unknown>>>;
  id: IntegrationServerId;
  installationId: IntegrationInstallationId;
  name: string;
  transport: JsonColumn<Readonly<Record<string, unknown>>>;
  status: "active" | "disabled" | "needs-attention";
  statusDetail: string | null;
  toolGeneration: number;
  /** For a server a computer runs, the launch its owner approved on it; null until then. */
  approvedLaunchDigest: Generated<string | null>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface IntegrationToolTable {
  id: IntegrationToolId;
  serverId: IntegrationServerId;
  connectionId: IntegrationConnectionId | null;
  name: string;
  title: string;
  description: string;
  inputSchema: JsonColumn<Readonly<Record<string, unknown>>>;
  outputSchema: JsonColumn<Readonly<Record<string, unknown>> | null>;
  annotations: JsonColumn<Readonly<Record<string, unknown>>>;
  schemaDigest: string;
  definitionNames: Generated<string[]>;
  /** What a call runs, for an adapter that plans its tools' names; null for every other tool. */
  target: Generated<Readonly<Record<string, unknown>> | null>;
  status: "active" | "disabled";
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface IntegrationToolDefinitionsTable {
  serverId: IntegrationServerId;
  connectionId: IntegrationConnectionId | null;
  definitions: JsonColumn<Readonly<Record<string, Readonly<Record<string, unknown>>>>>;
  updatedAt: Timestamp;
}

export interface IntegrationSkillTable {
  id: IntegrationSkillId;
  installationId: IntegrationInstallationId;
  name: string;
  description: string;
  digest: string;
  status: "active" | "disabled";
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface IntegrationGrantTable {
  access: IntegrationAccess;
  id: IntegrationGrantId;
  workspaceId: WorkspaceId;
  ownerUserId: UserId;
  installationId: IntegrationInstallationId;
  connectionId: IntegrationConnectionId | null;
  alias: string;
  isDefault: boolean;
  createdBy: UserId;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  revokedAt: NullableTimestamp;
  status: "active" | "revoked";
}

export interface ChannelAccountTable {
  id: ChannelAccountId;
  connectionId: IntegrationConnectionId;
  provider: ChannelProvider;
  externalAccountId: string;
  displayName: string;
  handle: string | null;
  routingMode: "dedicated" | "shared";
  status: "connected" | "needs-attention" | "paused" | "revoked";
  metadata: JsonColumn<Readonly<Record<string, unknown>>>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ChannelBindingTable {
  id: ChannelBindingId;
  accountId: ChannelAccountId;
  workspaceId: WorkspaceId;
  createdBy: UserId;
  selector: JsonColumn<Readonly<Record<string, unknown>>>;
  executionPolicy: JsonColumn<Readonly<Record<string, unknown>>>;
  accessPolicy: JsonColumn<Readonly<Record<string, unknown>>>;
  revision: number;
  status: "active" | "paused" | "revoked";
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ChannelAccessGrantTable {
  accountId: ChannelAccountId;
  bindingId: ChannelBindingId;
  externalUserId: string;
  displayName: string;
  status: "pending" | "approved" | "declined" | "revoked";
  revision: number;
  requestedAt: Timestamp;
  requestIngressId: ChannelIngressId | null;
  decidedAt: NullableTimestamp;
  decidedBy: UserId | null;
  updatedAt: Timestamp;
}

interface ChannelIdentityTable {
  id: ChannelIdentityId;
  accountId: ChannelAccountId;
  principalId: PrincipalId;
  externalUserId: string;
  displayName: string;
  linkedUserId: UserId | null;
  status: "unlinked" | "linked";
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

interface ChannelConversationTable {
  id: ChannelConversationId;
  accountId: ChannelAccountId;
  provider: ChannelProvider;
  externalAccountId: string;
  bindingId: ChannelBindingId;
  bindingRevision: number;
  workspaceId: WorkspaceId;
  externalScopeId: string | null;
  externalConversationId: string;
  externalThreadId: string | null;
  conversationType: "dm" | "group" | "channel";
  displayName: string | null;
  activeThreadId: ThreadId | null;
  providerState: JsonColumn<Readonly<Record<string, unknown>>>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

interface ChannelConversationContextTable {
  conversationId: ChannelConversationId;
  authorityUserId: UserId;
  bindingRevision: number;
  activeThreadId: ThreadId | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

interface ChannelIngressEventTable {
  id: ChannelIngressId;
  accountId: ChannelAccountId;
  providerEventId: string;
  laneKey: string;
  event: JsonColumn<Readonly<Record<string, unknown>>>;
  status: "pending" | "leased" | "adopted" | "ignored" | "dead";
  attempts: Generated<number>;
  claimTokenHash: string | null;
  claimOwner: string | null;
  claimExpiresAt: NullableTimestamp;
  nextAttemptAt: Timestamp;
  lastError: string | null;
  conversationId: ChannelConversationId | null;
  messageId: MessageId | null;
  runId: RunId | null;
  receivedAt: Timestamp;
  processedAt: NullableTimestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ChannelDeliveryTable {
  id: ChannelDeliveryId;
  accountId: ChannelAccountId;
  /** Exactly one of these is set: a routed conversation, or the ignored ingress a status answers. */
  conversationId: ChannelConversationId | null;
  ingressId: ChannelIngressId | null;
  messageId: MessageId | null;
  audience: "conversation" | "actor";
  kind: "reply" | "status";
  /** One provider message. A reply longer than the provider allows becomes `partCount` of these. */
  part: Generated<number>;
  partCount: Generated<number>;
  content: JsonColumn<readonly unknown[]>;
  status:
    "pending" | "leased" | "attempt-started" | "sent" | "retryable-failed" | "unknown" | "dead";
  attempts: Generated<number>;
  claimTokenHash: string | null;
  claimOwner: string | null;
  claimExpiresAt: NullableTimestamp;
  nextAttemptAt: Timestamp;
  lastError: string | null;
  receipt: JsonColumn<Readonly<Record<string, unknown>>> | null;
  sentAt: NullableTimestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * A code is minted FOR a channel identity and consumed BY the Opensteer user
 * who redeems it in the web app, so the identity is known from the start and
 * the user only at consumption.
 */
interface ChannelLinkCodeTable {
  id: string;
  accountId: ChannelAccountId;
  userId: UserId | null;
  codeHash: string;
  expiresAt: Timestamp;
  consumedAt: NullableTimestamp;
  identityId: ChannelIdentityId;
  requestIngressId: ChannelIngressId | null;
  createdAt: Timestamp;
}

interface ComputerUsePolicyTable {
  deploymentId: DeploymentId;
  runnerId: RunnerId;
  ownerUserId: UserId;
  appApproval: "ask" | "automatic";
  revision: number;
  approval: JsonColumn<{
    request: import("@opensteer/integration-core").ComputerAppSetupRequest;
    approval: import("@opensteer/integration-core").ComputerAppApproval;
  } | null>;
  updatedAt: Timestamp;
}

/** The one key a Mac's desktop signs that Mac's approvals with. */
interface ComputerUseApprovalKeyTable {
  runnerId: RunnerId;
  /** Who registered it, at the Mac; approvals by anybody else are refused. */
  ownerUserId: UserId;
  publicKeyPem: string;
  keyId: string;
  registeredAt: Timestamp;
}

/** A person's Stop for one Run on one Mac; it lasts as long as the Run. */
interface ComputerUseStopTable {
  runId: RunId;
  runnerId: RunnerId;
  stoppedAt: Generated<Timestamp>;
}

interface ComputerAppSetupRequestTable {
  kind: "app" | "policy" | "server";
  policyAppApproval: "automatic" | null;
  threadId: ThreadId | null;
  workspaceId: WorkspaceId | null;
  workspaceName: string | null;
  reason: string | null;
  threadTitle: string | null;
  id: string;
  deploymentId: DeploymentId;
  ownerUserId: UserId;
  runnerId: RunnerId;
  definitionId: string;
  definitionDigest: string;
  access: "read" | "read-write";
  /** The app this approval is for, paired with `appKey` exactly as a connection's pair is. */
  app: Generated<ComputerAppIdentity | null>;
  appKey: Generated<string | null>;
  /** For `kind: "server"`, the MCP server and the exact launch the Mac is asked to run. */
  server: Generated<LocalMcpServerSetup | null>;
  createdAt: Timestamp;
  expiresAt: Timestamp;
}

export interface DatabaseSchema {
  attachments: AttachmentTable;
  computerUseApprovalKeys: ComputerUseApprovalKeyTable;
  computerUsePolicies: ComputerUsePolicyTable;
  computerUseStops: ComputerUseStopTable;
  computerAppSetupRequests: ComputerAppSetupRequestTable;
  deployments: DeploymentTable;
  users: UserTable;
  authAccounts: AuthAccountTable;
  authSessions: AuthSessionTable;
  personalRemoteAccess: PersonalRemoteAccessTable;
  personalRemoteAccountLink: PersonalRemoteAccountLinkTable;
  personalRemotePairingCodes: PersonalRemotePairingCodeTable;
  machineLocalSessions: MachineLocalSessionTable;
  personalRemoteSessions: PersonalRemoteSessionTable;
  personalRemoteSessionGrantUses: PersonalRemoteSessionGrantUseTable;
  authVerifications: AuthVerificationTable;
  authRateLimits: AuthRateLimitTable;
  authSsoProviders: AuthSsoProviderTable;
  authAdmissions: AuthAdmissionTable;
  authJwks: AuthJwkTable;
  hostOAuthResources: HostOAuthResourceTable;
  hostOAuthClientResources: HostOAuthClientResourceTable;
  hostOAuthClientAssertions: HostOAuthClientAssertionTable;
  hostOAuthClients: HostOAuthClientTable;
  hostOAuthRefreshTokens: HostOAuthRefreshTokenTable;
  hostOAuthAccessTokens: HostOAuthAccessTokenTable;
  hostOAuthConsents: HostOAuthConsentTable;
  accountDirectoryProvider: AccountDirectoryProviderTable;
  accountDirectoryProjections: AccountDirectoryProjectionTable;
  hostAccountAdoptionProofs: HostAccountAdoptionProofTable;
  ownerEnrollments: OwnerEnrollmentTable;
  runners: RunnerTable;
  runnerEnrollments: RunnerEnrollmentTable;
  machineAccessSessions: MachineAccessSessionTable;
  machineAccessEvents: MachineAccessEventTable;
  executionEnvironments: ExecutionEnvironmentTable;
  harnessInstances: HarnessInstanceTable;
  harnessCatalogs: HarnessCatalogTable;
  userExecutionPreferences: UserExecutionPreferenceTable;
  workspaces: WorkspaceTable;
  workspaceMemberships: WorkspaceMembershipTable;
  workspaceInvitations: WorkspaceInvitationTable;
  securityAudit: SecurityAuditTable;
  securityEffects: SecurityEffectTable;
  threadStatePending: { threadId: ThreadId; requestedAt: Timestamp };
  threads: ThreadTable;
  messages: MessageTable;
  threadInputs: ThreadInputTable;
  threadWorkInputs: ThreadInputTable;
  causalChains: CausalChainTable;
  runs: RunTable;
  runAttempts: RunAttemptTable;
  executionNodes: ExecutionNodeTable;
  grants: GrantTable;
  delegations: DelegationTable;
  requests: RequestTable;
  integrationRequestDetails: IntegrationRequestDetailTable;
  requestCallJoins: RequestCallJoinTable;
  requestContinuations: RequestContinuationTable;
  workspaceMounts: WorkspaceMountTable;
  triggers: TriggerTable;
  triggerRevisions: TriggerRevisionTable;
  triggerWatchActivations: TriggerWatchActivationTable;
  watchControlRequests: WatchControlRequestTable;
  triggerOccurrences: TriggerOccurrenceTable;
  providerSessions: ProviderSessionTable;
  commands: CommandTable;
  agentControlRequests: AgentControlRequestTable;
  triggerControlRequests: TriggerControlRequestTable;
  workspaceEvents: WorkspaceEventTable;
  automationFailureNotices: AutomationFailureNoticeTable;
  threadReadMarkers: ThreadReadMarkerTable;
  agentNotificationMutes: AgentNotificationMuteTable;
  credentials: CredentialTable;
  credentialVaultCanaries: CredentialVaultCanaryTable;
  browserProfiles: BrowserProfileTable;
  browserProfileRevisions: BrowserProfileRevisionTable;
  browserSessions: BrowserSessionTable;
  workspaceTabs: WorkspaceTabTable;
  browserTabLayouts: {
    ownerId: UserId;
    revision: Generated<string | number | bigint>;
    tabOrder: ColumnType<string[] | null, string[] | null | undefined, string[] | null>;
  };
  browserTabGroups: {
    id: BrowserTabGroupId;
    ownerId: UserId;
    title: string;
    color: BrowserTabGroupColor;
    collapsed: Generated<boolean>;
    // Provenance outlives the creating Thread, as a browser session's opener does.
    createdByThreadId: ThreadId | null;
    createdAt: Timestamp;
    updatedAt: Timestamp;
  };
  browserTabGroupMembers: { ownerId: UserId; tabId: string; groupId: BrowserTabGroupId };
  browserTabOpens: {
    ownerId: UserId;
    idempotencyKey: string;
    binding: JsonColumn<BrowserTabOpenBinding>;
    identityKey: string | null;
    runnerId: RunnerId;
    createdAt: Timestamp;
  };
  browserSessionAttachments: BrowserSessionAttachmentTable;
  browserSessionUses: BrowserSessionUseTable;
  browserProfileGrants: BrowserProfileGrantTable;
  browserSources: BrowserSourceTable;
  browserSourcePairings: BrowserSourcePairingTable;
  browserSiteGrants: BrowserSiteGrantTable;
  browserSignIns: BrowserSignInTable;
  browserSourceImports: BrowserSourceImportTable;
  credentialAccessAudit: CredentialAccessAuditTable;
  principals: PrincipalTable;
  integrationProviderApplications: IntegrationProviderApplicationTable;
  integrationAuthAttempts: IntegrationAuthAttemptTable;
  integrationAuthorityGenerations: IntegrationAuthorityGenerationTable;
  integrationAuthorityPending: IntegrationAuthorityPendingTable;
  integrationConnections: IntegrationConnectionTable;
  integrationApplicationSourceDefaults: IntegrationApplicationSourceDefaultTable;
  integrationInstallations: IntegrationInstallationTable;
  integrationServers: IntegrationServerTable;
  integrationTools: IntegrationToolTable;
  integrationToolDefinitions: IntegrationToolDefinitionsTable;
  integrationSkills: IntegrationSkillTable;
  integrationGrants: IntegrationGrantTable;
  mcpOAuthCredentials: McpOAuthCredentialTable;
  channelAccounts: ChannelAccountTable;
  channelAccessGrants: ChannelAccessGrantTable;
  channelBindings: ChannelBindingTable;
  channelIdentities: ChannelIdentityTable;
  channelConversations: ChannelConversationTable;
  channelConversationContexts: ChannelConversationContextTable;
  channelIngressEvents: ChannelIngressEventTable;
  channelDeliveries: ChannelDeliveryTable;
  channelLinkCodes: ChannelLinkCodeTable;
}

export type DeploymentRow = Selectable<DeploymentTable>;
export type WorkspaceRow = Selectable<WorkspaceTable>;
export type ThreadRow = Selectable<ThreadTable>;
export type RunRow = Selectable<RunTable>;
export type RequestRow = Selectable<RequestTable>;
export type CommandRow = Selectable<CommandTable>;
/** A command awaiting dispatch, with the AI account of the Run it names. */
export type PendingCommandRow = CommandRow & {
  readonly runHarnessInstanceId: HarnessInstanceId | null;
};
export type WorkspaceEventRow = Selectable<WorkspaceEventTable>;
