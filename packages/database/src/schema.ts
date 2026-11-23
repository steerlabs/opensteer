import type {
  AgentGrant,
  AgentOperationDecision,
  AgentOperationId,
  AgentOperationOutcome,
  AgentOperationState,
  AgentOperationTarget,
  AgentSessionEndReason,
  AgentSessionId,
  DeviceId,
  DeviceKind,
  DevicePlatform,
  DeviceForm,
  DeviceDriverRole,
} from "@opensteer/core";
import type { TaskPurpose } from "@opensteer/core";
import type { z } from "zod";
import type { ThreadCallerAuthority } from "./thread-caller.js";

import type {
  ChannelAccountId,
  ChannelBindingId,
  ChannelConnectionIssueKind,
  ChannelConversationId,
  ChannelDeliveryId,
  ChannelIdentityId,
  ChannelIngressId,
  ChannelProvider,
  ChannelTransportKind,
  IntegrationConnectionId,
  PrincipalId,
} from "@opensteer/channel-core";
import type {
  AssignmentId,
  AssignmentOrigin,
  AssignmentReturnStatus,
  AssignmentStatus,
  AuthAccountId,
  AuthAdmissionId,
  AuthSessionId,
  AuthVerificationId,
  BrowserProfileId,
  BrowserSurfaceId,
  BrowserSourceId,
  CausalChainId,
  CommandId,
  CredentialId,
  DelegationId,
  DeploymentId,
  DeploymentShape,
  EnvironmentId,
  ExecutionNodeId,
  ExecutionPreferences,
  GrantId,
  HarnessId,
  HarnessInstanceId,
  HarnessInstanceStateKind,
  HostInstanceId,
  MarkColor,
  MessageAuthor,
  MessageId,
  MessageKind,
  ModelSelection,
  PersonalRemoteSessionDelivery,
  ProviderContinuationIdentity,
  ProviderSessionId,
  ReplyTarget,
  Request,
  RequestId,
  RunAttemptId,
  RunFailure,
  RunId,
  RunnerId,
  SecurityAuditId,
  ThreadAccessMode,
  ThreadDoneReason,
  QuietTaskDays,
  ThreadIconSource,
  ThreadId,
  ThreadInputPolicy,
  ThreadInputState,
  ThreadTitleSource,
  TriggerId,
  TriggerOccurrenceId,
  TriggerRevisionId,
  TriggerWatchActivationId,
  UserId,
  IconName,
} from "@opensteer/core";
import type {
  ComputerAppIdentity,
  IntegrationAccess,
  IntegrationConnectionMethod,
  IntegrationGrantId,
  IntegrationInstallationId,
  IntegrationInstallManifest,
  IntegrationServerId,
  IntegrationToolId,
  LocalMcpServerSetup,
} from "@opensteer/integration-core";
import type {
  IntegrationAuthAttemptFailureReason,
  IntegrationAuthAttemptFlow,
  IntegrationAuthAttemptId,
} from "@opensteer/integration-core/ports";
import type {
  BrowserEngine,
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
import type { StoredTriggerProgram, TriggerProgramEvent, TriggerSource } from "@opensteer/triggers";
import type { ColumnType, Generated, Selectable } from "kysely";
import type {
  ClientChangesTable,
  ClientSyncStateTable,
  FinishIntent,
  PersonalAttentionTable,
  PlaceView,
  RunnerEventReceiptTable,
  ToolCallTable,
  ToolOutputImageTable,
  TranscriptItemTable,
} from "./personal-state-schema.js";

export type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
export type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
export type JsonColumn<T> = ColumnType<T, T, T>;

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

  disabledAt: NullableTimestamp;
  /** On a team, the Account revision of `displayName`; 0 until one is verified. */
  nameRevision: Generated<string>;
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

export interface NotificationPreviewKeyTable {
  userId: UserId;
  installationId: string;
  authSessionId: AuthSessionId;
  accountId: string;
  keyId: string;
  encryptedKey: Buffer;
  encryptionKeyVersion: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface AuthSessionTable {
  deviceId: Generated<DeviceId | null>;
  memberGeneration: ColumnType<string | null, string | null | undefined, string | null>;
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

interface PersonalRemoteAccessTable {
  singletonKey: "personal";
  generation: ColumnType<string, number | string, number | string>;
  mode: "off" | "connect" | "private";
  routeOrigin: string | null;
  updatedAt: Timestamp;
}

type PersonalRemoteAccountOperation = { readonly id: string } & (
  | { readonly kind: "activate" }
  | { readonly kind: "unlink" }
  | {
      readonly kind: "projection";
      readonly projection: {
        readonly accessRoute: import("@opensteer/protocol").PersonalHostAccessRouteEnvelope | null;
        readonly generation: number;
        readonly state: "disabled" | "offline" | "ready";
      };
    }
  | {
      readonly kind: "revoke";
      readonly request: { readonly hostInstanceId: HostInstanceId; readonly operationId: string };
    }
);

interface PersonalRemoteAccountLinkTable {
  accountOperation: Generated<PersonalRemoteAccountOperation | null>;
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
  confirmation: Generated<unknown | null>;
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
  confirmation: Generated<unknown | null>;
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
  initialAccess: Generated<import("@opensteer/protocol").DeviceInitialAccess | null>;
  preparedIdentity: Generated<{
    readonly runnerId: RunnerId;
    readonly publicKeyPem: string;
  } | null>;
  issuanceModules: Generated<readonly RunnerModuleName[] | null>;
  deviceProfile: Generated<"iphone" | null>;
  workEnrollmentPreviewedAt: NullableTimestamp;
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

interface SecurityAuditTable {
  id: SecurityAuditId;
  actorUserId: UserId | null;
  actorSessionId: AuthSessionId | null;

  action: string;
  targetType: string;
  targetId: string | null;
  requestId: string | null;
  metadata: JsonColumn<Readonly<Record<string, unknown>>>;
  createdAt: Timestamp;
}

export interface ThreadTable {
  askedAt: Timestamp;
  doneAt: Generated<Date | null>;
  /** Set only while Done, when the Host moved the task there because nothing touched it. */
  doneReason: Generated<ThreadDoneReason | null>;
  pendingRequestCount: Generated<number>;
  revision: Generated<string>;
  nextTranscriptPosition: Generated<string>;
  inputQueueRevision: Generated<string>;
  lastReplyMessageId: Generated<MessageId | null>;
  lastReplyPreview: Generated<string | null>;
  failurePreview: Generated<string | null>;
  latestRunCompletedAt: Generated<Date | null>;
  latestPlace: Generated<PlaceView | null>;
  removedAt: Generated<Date | null>;
  inputQueuePaused: Generated<boolean>;
  inputQueuePausedBy: Generated<UserId | null>;
  accessMode: Generated<ThreadAccessMode>;

  purpose: TaskPurpose;
  id: ThreadId;
  lineageRootThreadId: ThreadId;

  parentThreadId: ThreadId | null;
  listed: boolean;
  title: string;
  titleSource: Generated<ThreadTitleSource>;
  icon: IconName | null;
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
  /** The connected agent whose lineage this task is in; immutable, inherited by child tasks. */
  originConnectionId: Generated<string | null>;
  /** `external`: an agent session's task; it never starts a native Run. */
  worker: Generated<"native" | "external">;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface MessageTable {
  published: Generated<boolean>;
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
  /** Where a person sent it from; null for every other author and older apps. */
  origin: Generated<import("@opensteer/core").MessageOrigin | null>;
  /** Edits a person made while it waited; `content` is always the latest. */
  revision: Generated<number>;
  editedAt: Generated<Date | null>;
  createdAt: Timestamp;
}

/** Every version of an edited message, revision 0 being the original. Append-only. */
export interface MessageRevisionTable {
  messageId: MessageId;
  revision: number;
  content: JsonColumn<readonly unknown[]>;
  author: JsonColumn<MessageAuthor>;
  deviceLabel: string | null;
  createdAt: Timestamp;
}

export interface AttachmentTable {
  id: string;

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
  approvalSort: Generated<number>;
  freshContext: Generated<boolean>;
  assignmentId: Generated<AssignmentId | null>;
  actorPrincipalId: PrincipalId;
  authoritySource: JsonColumn<Readonly<Record<string, unknown>>>;
  cancelReason: string | null;
  causalChainId: CausalChainId;
  deliveredAt: NullableTimestamp;
  idempotencyKey: string;

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
  /** A device's edit lease; all three are set together. Expired leases count as absent. */
  editLeaseId: Generated<string | null>;
  editLeaseSessionId: Generated<AuthSessionId | null>;
  editLeaseDeviceLabel: Generated<string | null>;
  editLeaseExpiresAt: Generated<Date | null>;
  /** The connected agent this input came from, directly or through its lineage. */
  connectionId: Generated<string | null>;
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
  revision: Generated<string>;
  latestPlace: Generated<PlaceView | null>;
  terminalReplyMessageId: Generated<MessageId | null>;
  runnerSafetyTerminal: Generated<boolean>;
  executeClaimState: Generated<"not-created" | "unclaimed" | "claimed">;
  finishIntent: Generated<FinishIntent | null>;
  /** The digest of the last Runner statement this Run admitted; it outlives the Run's receipts. */
  lastRunnerDigest: Generated<Buffer | null>;
  maintenance: Generated<import("@opensteer/core").RunMaintenance | null>;
  personWaited: Generated<boolean>;
  doneWhenFinished: Generated<boolean>;
  assignmentId: Generated<AssignmentId | null>;
  initialContext: ColumnType<
    RunInitialContext | null,
    RunInitialContext | null | undefined,
    RunInitialContext | null
  >;

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

  actorPrincipalId: PrincipalId;
  authoritySource: JsonColumn<Readonly<Record<string, unknown>>>;
  runOrdinal: number;
  seedInputId: MessageId;
  /** The live voice call this Run carries; null for every other Run. */
  voiceSessionId: Generated<string | null>;
  /** The task's origin connection, otherwise its activating input's; null for owner work. */
  connectionId: Generated<string | null>;
  admittedGrantRevision: Generated<number | null>;
  admittedAccessMode: Generated<ThreadAccessMode | null>;
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
  connectionId: Generated<string | null>;
  admittedGrantRevision: Generated<number | null>;
  admittedAccessMode: Generated<ThreadAccessMode | null>;
  terminalEvidenceAt: Generated<Date | null>;
  contactLostAt: Generated<Date | null>;
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
  stopSupported: Generated<boolean>;
  stopping: Generated<boolean>;
  id: ExecutionNodeId;
  runId: RunId;
  attemptId: RunAttemptId;
  parentNodeId: ExecutionNodeId | null;
  kind: "subagent" | "task" | "workflow";
  effort: string | null;
  phaseIndex: number | null;
  phases: JsonColumn<string[]>;
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
  cancellationRootId: Generated<AssignmentId | null>;
  initialInputMessageId: MessageId;
  objective: string;
  origin: AssignmentOrigin;
  parentAssignmentId: Generated<AssignmentId | null>;
  status: AssignmentStatus;
  resultText: Generated<string | null>;
  resultWaits: Generated<
    readonly {
      readonly id: string;
      readonly authority: ThreadCallerAuthority;
      readonly expiresAt: number;
    }[]
  >;
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
  revision: Generated<string>;
  id: RequestId;
  kind: Request["kind"];
  mode: Request["mode"];
  status: Request["status"];

  originatingThreadId: ThreadId;
  /** Exactly one origin is present; a Trigger Occurrence creates no Run row. */
  originatingRunId: RunId | null;
  originatingOccurrenceId: TriggerOccurrenceId | null;
  originatingWatchActivationId: Generated<
    import("@opensteer/core").TriggerWatchActivationId | null
  >;
  /** The agent session that asked, for a Request about an external agent's direct work. */
  originatingAgentSessionId: Generated<AgentSessionId | null>;
  /** The direct operation this Request decides, in its parts (`Request.agentOperation`). */
  agentOperation: Generated<Readonly<Record<string, unknown>> | null>;
  /** The subagent of the originating Run that asked, if not its own agent. */
  originatingNodeId: Generated<ExecutionNodeId | null>;
  callId: string;

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
  settlementProvenance: Generated<NonNullable<Request["settlementProvenance"]> | null>;
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
  createdAt: Timestamp;
}

interface RequestContinuationTable {
  requestId: RequestId;
  status: "waiting" | "queued" | "undeliverable" | "delivered";
  attemptedAt: NullableTimestamp;
  reason: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

interface TriggerTable {
  systemRole: Generated<"memory-light" | "memory-nightly" | null>;
  id: TriggerId;

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
  waitingReason: Generated<string | null>;
  webhookRouteKey: string | null;
  webhookSecretHash: string | null;
  /** The connected agent whose lineage created it; occurrences and Watches derive from it. */
  originConnectionId: Generated<string | null>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

interface TriggerRevisionTable {
  id: TriggerRevisionId;
  triggerId: TriggerId;
  ordinal: number;
  source: JsonColumn<TriggerSource>;
  program: JsonColumn<StoredTriggerProgram>;
  createdBy: UserId;
  createdByThreadId: ThreadId | null;
  createdAt: Timestamp;
}

export interface TriggerWatchActivationTable {
  connectionId: Generated<string | null>;
  admittedGrantRevision: Generated<number | null>;
  admittedAccessMode: Generated<ThreadAccessMode | null>;
  terminalEvidenceAt: Generated<Date | null>;
  contactLostAt: Generated<Date | null>;
  id: TriggerWatchActivationId;
  triggerId: TriggerId;
  revisionId: TriggerRevisionId;
  environmentId: EnvironmentId;

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
  connectionId: Generated<string | null>;
  admittedGrantRevision: Generated<number | null>;
  admittedAccessMode: Generated<ThreadAccessMode | null>;
  terminalEvidenceAt: Generated<Date | null>;
  contactLostAt: Generated<Date | null>;
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

export interface TriggerOccurrenceAttemptTable {
  occurrenceId: TriggerOccurrenceId;
  executionGeneration: number;
  connectionId: string;
  runnerId: RunnerId;
  runnerBootId: string;
  admittedGrantRevision: number | null;
  admittedAccessMode: ThreadAccessMode | null;
  terminalEvidenceAt: Date | null;
  contactLostAt: Date | null;
}

export interface ProviderSessionTable {
  contextSnapshot: Generated<import("@opensteer/core").ProviderContextSnapshot | null>;
  personalContext: Generated<boolean>;
  personLineage: Generated<boolean>;
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
  workOwnerStop: Generated<boolean | null>;
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
    | "device.access.request"
    | "machine.full-disk-access.request"
    | "browser.access.request"
    | "browser.profile.create"
    | "browser.profile.list"
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
    | "person.message"
    | "person.show"
    | "thread.read"
    | "thread.write"
    | "trigger.read"
    | "trigger.write"
    | "environment.list";

  actionClass:
    | "person.show"
    | "assignment.cancel"
    | "device.access.request"
    | "machine.full-disk-access.request"
    | "browser.access.request"
    | "browser.profile.create"
    | "browser.profile.list"
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
    | "environment.list";

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

export interface ThreadVisitTable {
  threadId: ThreadId;
  userId: UserId;
  lastVisitedAt: Timestamp;
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

export interface BrowserProfileTable {
  homeRunnerId: Generated<RunnerId | null>;
  id: BrowserProfileId;
  ownerId: UserId;
  name: string;
  storageState: Generated<"unbound" | "local">;
  storageBindingVersion: Generated<1 | null>;
  storageDeploymentId: Generated<DeploymentId | null>;
  storageRunnerId: Generated<RunnerId | null>;
  storageInstanceId: Generated<string | null>;
  storageBindingId: Generated<string | null>;
  storageEngine: Generated<BrowserEngine | null>;
  initialized: Generated<boolean>;
  /** `engine-sign-in`: the profile an AI engine signs in through; no grant may name it. */
  purpose: Generated<"person" | "engine-sign-in">;
  archivedAt: NullableTimestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface BrowserProfileDeletionTable {
  deletionId: string;
  profileId: BrowserProfileId;
  bindingVersion: 1;
  deploymentId: DeploymentId;
  runnerId: RunnerId;
  storageInstanceId: string;
  bindingId: string;
  engine: BrowserEngine;
  state: "pending-computer" | "pending-restart" | "deleted" | "unconfirmed";
  createdAt: Timestamp;
  updatedAt: Timestamp;
  deletedAt: NullableTimestamp;
}

interface BrowserHistoryEntryTable {
  profileId: BrowserProfileId;
  url: string;
  origin: string;
  title: string;
  typedCount: number;
  visitCount: number;
  lastVisitAt: Timestamp;
}

interface BrowserHistoryIconTable {
  profileId: BrowserProfileId;
  origin: string;
  iconRef: string;
  favicon: string;
}

interface BrowserSessionTable {
  standardCdpAttempts: Generated<Readonly<Record<string, unknown>>>;
  tabGroupId: BrowserSessionId;
  tabRevision: Generated<number>;
  opener: JsonColumn<BrowserSessionOpenerRecord | null>;
  id: BrowserSessionId;
  origin: "agent" | "trigger" | "person";
  /** Null for a fresh session: no identity, and therefore no state lease. */
  profileId: BrowserProfileId | null;

  placementKey: string;
  runnerId: RunnerId;
  runtimeId: string;
  state: "starting" | "ready" | "closing" | "closed" | "failed";
  createdAt: Timestamp;
  updatedAt: Timestamp;
  closedAt: NullableTimestamp;
}

interface BrowserSessionAttachmentTable {
  agentBindingId: string;
  ownerId: UserId;
  sessionId: BrowserSessionId;

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

interface BrowserSourceTable {
  deviceId: Generated<DeviceId | null>;
  liveTabsOnly: Generated<boolean>;
  id: BrowserSourceId;
  ownerId: UserId;
  name: string;
  tokenHash: string;
  generation: Generated<number>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  revokedAt: NullableTimestamp;
  lastSeenAt: NullableTimestamp;
  pairedOrigin: string | null;
  pairedRouteGeneration: number | null;
}

interface BrowserSourcePairingTable {
  deviceId: Generated<DeviceId | null>;
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
  deploymentId: DeploymentId;
  id: string;
  ownerId: UserId;

  site: string;
  preferredSourceId: BrowserSourceId | null;
  createdAt: Timestamp;
  lastSignedInAt: NullableTimestamp;
  revokedAt: NullableTimestamp;
}

interface BrowserSignInTable {
  ownerId: UserId;
  id: string;

  site: string;
  sourceId: BrowserSourceId;
  sourceName: string;
  sessionId: string;
  profileName: string | null;
  requestId: RequestId | null;
  actor: "agent" | "owner" | "request";
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
  id: IntegrationConnectionId;
  ownerUserId: UserId;
  credentialId: CredentialId | null;
  credentialGeneration: Generated<number>;
  connectionKind: "channel" | "computer";
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
  connectionMethod: IntegrationConnectionMethod;
  status: "pending" | "connected" | "needs-attention" | "paused" | "revoked";
  displayName: string;
  externalIdentityId: string | null;
  externalTenantId: string | null;
  capabilities: JsonColumn<readonly string[]>;
  integrationDefinitionId: string | null;
  /** Channel assignment, also retained for previous Hosts reading self-backed computer targets. */
  runnerId: RunnerId | null;
  deviceId: Generated<DeviceId | null>;
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

export interface IntegrationInstallationTable {
  id: IntegrationInstallationId;
  name: string;
  title: string;
  description: string;
  version: string | null;
  pluginId: Generated<string | null>;
  sourceKind: "plugin" | "built-in";
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

/** One server's secrets, as its computer's owner entered them; see `LocalMcpServerStore`. */
export interface IntegrationServerSecretTable {
  serverId: IntegrationServerId;
  /** The computer they were entered for. */
  runnerId: RunnerId;
  encryptedPayload: Buffer;
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

export interface IntegrationGrantTable {
  access: IntegrationAccess;
  id: IntegrationGrantId;

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
  personalContext: Generated<boolean>;
  id: ChannelConversationId;
  accountId: ChannelAccountId;
  provider: ChannelProvider;
  externalAccountId: string;
  bindingId: ChannelBindingId;
  bindingRevision: number;

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
  /** Legacy storage name retained while the previous Host runs. */
  runnerId: DeviceId;
  ownerUserId: UserId;
  appApproval: "ask" | "automatic";
  revision: number;
  updatedAt: Timestamp;
}

/** A person's Stop for one Run on one Device; it lasts as long as the Run. */
interface ComputerUseStopTable {
  runId: RunId;
  /** Legacy storage name retained while the previous Host runs. */
  runnerId: DeviceId;
  stoppedAt: Timestamp;
}

interface ComputerAppSetupRequestTable {
  kind: "app" | "policy" | "server";
  policyAppApproval: "automatic" | null;
  threadId: ThreadId | null;

  reason: string | null;
  threadTitle: string | null;
  id: string;
  deploymentId: DeploymentId;
  ownerUserId: UserId;
  /** Legacy storage name retained while the previous Host runs. */
  runnerId: DeviceId;
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

export interface AppVersionTable {
  appId: string;
  version: number;
  sha256: string | null;
  sizeBytes: number | null;
  server: JsonColumn<import("@opensteer/core").AppServerSpec | null>;
  createdByRun: RunId | null;
  publishKey: string;
  createdAt: Timestamp;
}

export interface AgentConnectionTable {
  sharedChromeAttempts: Generated<Readonly<Record<string, unknown>>>;
  id: string;
  userId: UserId;
  label: string;
  clientName: string;
  accessMode: ThreadAccessMode;

  resource: string;
  tokenHash: string | null;
  createdAt: Timestamp;
  lastUsedAt: NullableTimestamp;
  expiresAt: Timestamp;
  revokedAt: NullableTimestamp;
  grant: ColumnType<AgentGrant, AgentGrant | undefined, AgentGrant>;
  grantRevision: Generated<number>;
  consentVersion: Generated<number>;
  /** SHA-256 of the signed client registration the person approved; null before 0044. */
  clientFingerprint: Generated<string | null>;
  /** The redirect destination the person consented to; null before 0044. */
  redirectUri: Generated<string | null>;
  /** Contact was lost with a handed-off execution in this lineage while it was being stopped. */
  lastActionUncertainAt: Generated<Date | null>;
  acknowledgedUncertaintyAt: Generated<Date | null>;
  /** What the person should check: the Device, tool, target and when. */
  lastActionUncertain: Generated<Readonly<Record<string, unknown>> | null>;
  /** Disconnect or expiry: one durable cleanup, driven to completion by the Home. */
  cleanupReason: Generated<"revoked" | "expired" | "narrowed" | null>;
  cleanupMinimumGrantRevision: Generated<number | null>;
  cleanupMaximumMode: Generated<ThreadAccessMode | null>;
  cleanupClaimToken: Generated<string | null>;
  cleanupClaimExpiresAt: Generated<Date | null>;
  cleanupRequestedAt: Generated<Date | null>;
  cleanupCompletedAt: Generated<Date | null>;
  /** The person removed this revoked connection from their list. */
  removedAt: Generated<Date | null>;
  /** Who the person was shown at consent (`AgentConnectionIdentityAtConsent`); null before 0045. */
  identityAtConsent: Generated<Readonly<Record<string, unknown>> | null>;
  verificationWithdrawnAt: Generated<Date | null>;
}

interface AgentDirectoryCacheTable {
  issuer: string;
  document: Readonly<Record<string, unknown>>;
  acceptedAt: Date;
}

interface AgentEmbedderAssertionClaimTable {
  issuer: string;
  statementId: string;
  expiresAt: Date;
}

export interface AgentSessionTable {
  id: AgentSessionId;
  connectionId: string;
  userId: UserId;
  threadId: ThreadId;
  status: "active" | "ended";
  startedAt: Generated<Date>;
  lastActiveAt: Generated<Date>;
  endedAt: Date | null;
  endReason: AgentSessionEndReason | null;
  stopNoticeDeliveredAt: Date | null;
}

export interface AgentOperationTable {
  id: AgentOperationId;
  sessionId: AgentSessionId;
  connectionId: string;
  userId: UserId;
  operationKey: string;
  tool: string;
  argumentDigest: string;
  target: JsonColumn<AgentOperationTarget>;
  targetGeneration: string | null;
  grantRevision: number;
  workPolicyRevision: Generated<number | null>;
  mode: ThreadAccessMode;
  effect: "read" | "write";
  state: AgentOperationState;
  decision: JsonColumn<AgentOperationDecision> | null;
  requestId: RequestId | null;
  calls: string;
  agentReason: string | null;
  handedOffAt: Date | null;
  /** The executor returned, the operation never left the Home, or its process is gone. */
  terminalEvidenceAt: Generated<Date | null>;
  /** Handed off and lost without a confirmed outcome: what "last action uncertain" names. */
  contactLostAt: Generated<Date | null>;
  completedAt: Date | null;
  outcome: AgentOperationOutcome | null;
  resultSummary: JsonColumn<Readonly<Record<string, unknown>>> | null;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
}

export interface DatabaseSchema {
  agentSessions: AgentSessionTable;
  agentOperations: AgentOperationTable;
  workHomePolicy: {
    singleton: Generated<boolean>;
    assignmentId: import("@opensteer/control-plane-protocol").WorkAssignmentId;
    deploymentId: DeploymentId;
    organizationName: string;
    state: Generated<import("@opensteer/control-plane-protocol").WorkPolicyDocument["state"]>;
    revision: Generated<number>;
    policy: JsonColumn<import("@opensteer/control-plane-protocol").WorkPolicy>;
  };
  workAuditHead: {
    singleton: Generated<boolean>;
    sequence: Generated<number>;
    hash: Generated<string>;
    acknowledgedSequence: Generated<number>;
    sendingThrough: Generated<number | null>;
  };
  workAuditOutbox: {
    sequence: number;
    record: JsonColumn<import("@opensteer/control-plane-protocol").WorkAuditRecord>;
    hash: string;
  };
  pluginOauthRecords: {
    id: string;
    ownerUserId: UserId;
    expiresAt: NullableTimestamp;
    begunAt: NullableTimestamp;
    encryptedPayload: Buffer;
  };
  pluginAgentSettings: {
    ownerUserId: UserId;
    pluginId: string;
    access: "all" | "read-only" | "off";
    author: "catalog" | "agent";
    versionAuthors: JsonColumn<Record<string, "catalog" | "agent">>;
  };
  pluginExecutions: {
    engineProcess: Generated<Readonly<{
      launchId: string;
      namespace: string;
      pid: number;
      machineId?: string;
    }> | null>;
    engineUnsent: Generated<boolean | null>;
    connectionId: Generated<string | null>;
    admittedGrantRevision: Generated<number | null>;
    admittedAccessMode: Generated<ThreadAccessMode | null>;
    terminalEvidenceAt: Generated<Date | null>;
    contactLostAt: Generated<Date | null>;
    id: string;
    ownerUserId: UserId;
    threadId: ThreadId;
    runId: RunId | null;
    occurrenceId: TriggerOccurrenceId | null;
    watchActivationId: import("@opensteer/core").TriggerWatchActivationId | null;
    agentSessionId: Generated<AgentSessionId | null>;
    caller: string;
    mode: "ask" | "automatic";
    state:
      | "running"
      | "waiting"
      | "answered"
      | "completed"
      | "cancelled"
      | "expired"
      | "interrupted"
      | "failed";
    requestId: RequestId | null;
    interactionId: string | null;
    handoff: boolean;
    result: JsonColumn<Record<string, z.infer<ReturnType<typeof z.json>>> | null>;
    reason: string | null;
    createdAt: Generated<Date>;
    updatedAt: Generated<Date>;
  };
  devices: DeviceTable;
  deviceDrivers: DeviceDriverTable;
  deviceSetupRetirements: { runnerId: RunnerId; publicKeyPem: string };
  agentHomeSkillInventory: {
    computerId: RunnerId;
    environmentId: EnvironmentId;
    bootId: string;
    connectionGeneration: number;
    connectionId: string;
    connectionLeaseId: string;
    bindingGeneration: number;
    scanSequence: number;
    scannedAt: Timestamp;
    scanStatus: "complete" | "failed";
    metadata: JsonColumn<readonly { fullName: string; description: string; digest: string }[]>;
  };
  agentHomeSettings: {
    computerId: RunnerId;
    environmentId: EnvironmentId;
    bootId: string;
    connectionGeneration: number;
    connectionId: string;
    connectionLeaseId: string;
    readSequence: number;
    readAt: Timestamp;
    fileStatus: "valid" | "missing" | "invalid";
    fileError: JsonColumn<import("@opensteer/protocol").AgentHomeSettingsError> | null;
    settings: JsonColumn<import("@opensteer/core").AgentHomeSettings>;
  };

  personalSettings: PersonalSettingsTable;
  clientSyncState: ClientSyncStateTable;
  clientChanges: ClientChangesTable;
  toolCalls: ToolCallTable;
  transcriptItems: TranscriptItemTable;
  toolOutputImages: ToolOutputImageTable;
  runnerEventReceipts: RunnerEventReceiptTable;
  personalAttention: PersonalAttentionTable;

  agentConnections: AgentConnectionTable;
  agentDirectoryCache: AgentDirectoryCacheTable;
  agentEmbedderAssertionClaims: AgentEmbedderAssertionClaimTable;
  apps: AppTable;
  appServers: AppServerTable;
  appVersions: AppVersionTable;
  attachments: AttachmentTable;
  computerUsePolicies: ComputerUsePolicyTable;
  computerUseStops: ComputerUseStopTable;
  computerAppSetupRequests: ComputerAppSetupRequestTable;
  deployments: DeploymentTable;
  users: UserTable;
  authAccounts: AuthAccountTable;
  authSessions: AuthSessionTable;
  notificationPreviewKeys: NotificationPreviewKeyTable;
  personalRemoteAccess: PersonalRemoteAccessTable;
  personalRemoteAccountLink: PersonalRemoteAccountLinkTable;
  personalAccountLinkKeys: {
    challengeId: string;
    publicKey: string;
    privateKey: string;
    expiresAt: Timestamp;
  };
  personalRemotePairingCodes: PersonalRemotePairingCodeTable;
  personalDesktopUpdate: {
    position: Generated<string>;
    id: string;
    requestedBy: UserId;
    idempotencyKey: string;
    intent: JsonColumn<import("@opensteer/protocol/maintenance").DesktopUpdateIntent>;
    state: import("@opensteer/protocol/maintenance").DesktopUpdatePhase;
    fromVersion: string | null;
    targetVersion: string | null;
    incarnationId: string | null;
    detail: import("@opensteer/protocol/maintenance").DesktopUpdateOperation["detail"];
    createdAt: Timestamp;
    updatedAt: Timestamp;
  };
  personalRemoteAdministration: {
    position: Generated<string>;
    executionId: string;
    requestedIntent: JsonColumn<import("@opensteer/protocol").PersonalRemoteAdministrationIntent>;
    id: string;
    requestedBy: UserId;
    idempotencyKey: string;
    intent: JsonColumn<import("@opensteer/protocol").PersonalRemoteAdministrationIntent>;
    state: "pending" | "running" | "succeeded" | "failed";
    detail: string | null;
    createdAt: Timestamp;
    updatedAt: Timestamp;
  };
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

  securityAudit: SecurityAuditTable;

  threads: ThreadTable;
  messages: MessageTable;
  messageRevisions: MessageRevisionTable;
  threadInputs: ThreadInputTable;
  threadWorkInputs: ThreadInputTable;
  causalChains: CausalChainTable;
  runs: RunTable;
  runAttempts: RunAttemptTable;
  executionNodes: ExecutionNodeTable;
  grants: GrantTable;
  delegations: DelegationTable;
  requests: RequestTable;
  taskQuestionNotices: {
    requestId: RequestId;
    messageId: MessageId | null;
  };
  integrationRequestDetails: IntegrationRequestDetailTable;
  requestCallJoins: RequestCallJoinTable;
  requestContinuations: RequestContinuationTable;
  triggers: TriggerTable;
  triggerRevisions: TriggerRevisionTable;
  triggerWatchActivations: TriggerWatchActivationTable;
  watchControlRequests: WatchControlRequestTable;
  triggerOccurrences: TriggerOccurrenceTable;
  triggerOccurrenceAttempts: TriggerOccurrenceAttemptTable;
  providerSessions: ProviderSessionTable;
  commands: CommandTable;
  agentControlRequests: AgentControlRequestTable;
  triggerControlRequests: TriggerControlRequestTable;
  automationFailureNotices: AutomationFailureNoticeTable;
  threadVisits: ThreadVisitTable;

  credentials: CredentialTable;
  credentialVaultCanaries: CredentialVaultCanaryTable;
  browserProfiles: BrowserProfileTable;
  browserProfileDeletions: BrowserProfileDeletionTable;
  browserPoolSlots: {
    runnerId: RunnerId;
    runtimeId: string;
    slotId: string;
    term: number;
    instanceId: string;
    epoch: number;
    intentSequence: number;
    intentId: string | null;
    attachmentGeneration: number;
    /** `releasing`: the device was removed; the row goes once the guest is known stopped. */
    phase: "running" | "preparing" | "parked" | "waking" | "releasing";
    retained: JsonColumn<Readonly<Record<string, unknown>> | null>;
    savedState: JsonColumn<Readonly<Record<string, unknown>> | null>;
    outcome: JsonColumn<Readonly<Record<string, unknown>> | null>;
    phaseSince: ColumnType<Date, Date | undefined, Date>;
    /** The last fresh start: why, when, and its id. */
    lastStart: JsonColumn<Readonly<Record<string, unknown>> | null>;
    failedStarts: ColumnType<number, number | undefined, number>;
    /** The owner's restart keys already handled, newest first, bounded: a retry does nothing. */
    restartKeys: ColumnType<readonly string[], readonly string[] | undefined, readonly string[]>;
    /** Restart keys accepted and not yet answered, written before the restart's first effect. */
    restartWanted: ColumnType<readonly string[], readonly string[] | undefined, readonly string[]>;
  };
  browserPoolControllerCalls: {
    id: string;
    runnerId: RunnerId;
    slotId: string;
    term: number;
    intentId: string | null;
    kind: string;
    request: JsonColumn<Readonly<Record<string, unknown>>>;
    result: JsonColumn<Readonly<Record<string, unknown>> | null>;
    createdAt: Generated<Timestamp>;
    settledAt: Timestamp | null;
  };
  browserPoolDocumentLosses: {
    intentId: string;
    runnerId: RunnerId;
    ownerId: UserId;
    sessionId: BrowserSessionId;
    surfaceId: BrowserSurfaceId;
    documentId: string | null;
    reason: string;
    /**
     * The page held typed text that was not sent, as known when the loss was written; null: not
     * known (a running page, a partial thaw).
     */
    typed: ColumnType<boolean | null, boolean | null | undefined, boolean | null>;
    lostAt: Generated<Timestamp>;
    noticedAt: Timestamp | null;
  };
  browserPoolRelays: {
    id: string;
    runnerId: RunnerId;
    runtimeId: string;
    slotId: string;
    term: number;
    instanceId: string;
    epoch: number;
    createdAt: Generated<Timestamp>;
  };
  browserHistoryEntries: BrowserHistoryEntryTable;
  browserHistoryIcons: BrowserHistoryIconTable;
  browserSessions: BrowserSessionTable;
  personalTabs: PersonalTabTable;
  tabLayouts: TabLayoutTable;
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

  browserSources: BrowserSourceTable;
  browserSourcePairings: BrowserSourcePairingTable;
  browserSiteGrants: BrowserSiteGrantTable;
  browserSignIns: BrowserSignInTable;
  credentialAccessAudit: CredentialAccessAuditTable;
  principals: PrincipalTable;
  integrationAuthAttempts: IntegrationAuthAttemptTable;
  integrationAuthorityGenerations: IntegrationAuthorityGenerationTable;
  integrationAuthorityPending: IntegrationAuthorityPendingTable;
  integrationConnections: IntegrationConnectionTable;
  integrationInstallations: IntegrationInstallationTable;
  integrationServers: IntegrationServerTable;
  integrationServerSecrets: IntegrationServerSecretTable;
  integrationTools: IntegrationToolTable;
  integrationToolDefinitions: IntegrationToolDefinitionsTable;
  pluginOwnerSettings: {
    ownerUserId: UserId;
    targetKey: string;
    target: JsonColumn<Exclude<import("@opensteer/protocol").PluginTarget, { kind: "device-app" }>>;
    enabled: boolean;

    revision: number;
  };
  plugins: {
    id: string;
    name: string;
    scope: "deployment";

    source: JsonColumn<Readonly<Record<string, unknown>>>;
    installedBy: UserId | null;
    currentVersionId: string | null;
    /** The task whose agent last installed it; null for a person's install. */
    setupThreadId: Generated<ThreadId | null>;
    createdAt: Timestamp;
    updatedAt: Timestamp;
  };
  runnerPluginDataRemovals: {
    runnerId: RunnerId;
    pluginId: string;
    createdAt: Timestamp;
  };
  pluginVersions: {
    id: string;
    pluginId: string;
    digest: string;
    manifest: JsonColumn<Readonly<Record<string, unknown>>>;
    /** The definition `digest` follows; null for a version stored before it was recorded. */
    packageFormat: string | null;
    createdAt: Timestamp;
  };

  integrationGrants: IntegrationGrantTable;
  channelAccounts: ChannelAccountTable;
  channelAccessGrants: ChannelAccessGrantTable;
  channelBindings: ChannelBindingTable;
  channelIdentities: ChannelIdentityTable;
  channelConversations: ChannelConversationTable;
  channelIngressEvents: ChannelIngressEventTable;
  channelDeliveries: ChannelDeliveryTable;
  channelLinkCodes: ChannelLinkCodeTable;
}

export type DeploymentRow = Selectable<DeploymentTable>;

export type ThreadRow = Selectable<ThreadTable>;
export type RunRow = Selectable<RunTable>;
export type RequestRow = Selectable<RequestTable>;
export type CommandRow = Omit<Selectable<CommandTable>, "workOwnerStop">;
/** A command awaiting dispatch, with the AI account of the Run it names. */
export type PendingCommandRow = CommandRow & {
  readonly runHarnessInstanceId: HarnessInstanceId | null;
};

export interface PersonalSettingsTable {
  idleCompactionPolicy: Generated<import("@opensteer/core").IdleCompactionPolicy>;
  singletonKey: "personal";
  ownerId: UserId;
  agentHomeComputerId: RunnerId;
  agentHomePath: string;
  voiceThreadId: ThreadId | null;
  quietTaskDays: QuietTaskDays;
  executionPreferences: JsonColumn<ExecutionPreferences>;
  /** The owner's own name, or null for "You"; see `owner-profile-store.ts`. */
  ownerName: Generated<string | null>;
  /** When anyone first chose or adopted a name; the computer's name seeds only before. */
  ownerNameSetAt: Generated<Date | null>;
  /** The Account revision and binding while the name is the linked Account's. */
  ownerNameRevision: Generated<string | null>;
  ownerNameAccount: ColumnType<
    { readonly issuer: string; readonly subject: string } | null,
    { readonly issuer: string; readonly subject: string } | null | undefined,
    { readonly issuer: string; readonly subject: string } | null
  >;
}
export interface PersonalTabTable {
  id: import("@opensteer/core").TabId;
  ownerId: UserId;
  kind: import("@opensteer/core").TabKind;
  computerId: DeviceId;
  title: string;
  url: string | null;
  profileId: BrowserProfileId | null;
  profileName: string | null;
  appId: import("@opensteer/core").AppId | null;
  windowId: import("@opensteer/core").WindowId | null;
  windowApp: JsonColumn<ComputerAppIdentity | null>;
  pageBinding: JsonColumn<import("@opensteer/core").PageBinding | null>;
  favicon: string | null;
  iconRef: string | null;
  openerTabId: import("@opensteer/core").TabId | null;
  openedBy: JsonColumn<import("@opensteer/core").TabOpenedBy>;
  generation: Generated<number>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  closedAt: NullableTimestamp;
  closedPosition: JsonColumn<import("@opensteer/core").ClosedPosition | null>;
}
export interface TabLayoutTable {
  ownerId: UserId;
  revision: Generated<number>;
  items: JsonColumn<import("@opensteer/core").TabLayout["items"]>;
}
export interface AppTable {
  id: import("@opensteer/core").AppId;
  ownerId: UserId;
  computerId: RunnerId;
  threadId: ThreadId | null;
  runId: RunId | null;
  name: string;
  creationKey: string | null;
  latestVersion: Generated<number>;
  deleting: Generated<boolean>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
export interface AppServerTable {
  appId: import("@opensteer/core").AppId;
  computerId: RunnerId;
  port: number;
  desiredState: "running" | "stopped";
  generation: Generated<number>;
  lastError: string | null;
}

export interface DeviceTable {
  id: DeviceId;
  deploymentId: DeploymentId;
  ownerKind: "deployment" | "user";
  ownerUserId: UserId | null;
  name: string;
  kind: DeviceKind;
  platform: DevicePlatform | null;
  form: DeviceForm | null;
  accessPolicy: JsonColumn<MachineAccessPolicy>;
  accessPolicyRevision: Generated<number>;
  removedAt: NullableTimestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
export interface DeviceDriverTable {
  deviceId: DeviceId;
  role: DeviceDriverRole;
  runnerId: RunnerId;
  generation: ColumnType<string, number | string, number | string>;
  detachedAt: NullableTimestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
