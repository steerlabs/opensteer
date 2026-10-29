import type { DeploymentLifecycle } from "@opensteer/core";
import type {
  ControlPlaneAccountId,
  ConnectOperationId,
  ConnectState,
  PersonalHostAccountLinkChallengeId,
  HostedOAuthAttemptId,
  HostedOAuthRefreshTransactionId,
  NotificationDevicePlatform,
  ProjectionGeneration,
  PublishedNotificationKind,
} from "@opensteer/control-plane-protocol";
import type {
  DeploymentId,
  HostInstanceId,
  HostKeyFingerprint,
  NotificationId,
  ThreadId,
} from "@opensteer/core";
import type { ColumnType, Generated, Selectable } from "kysely";

export type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
export type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
export type BigInteger<T extends number = number> = ColumnType<string, T | string, T | string>;
/**
 * Better Auth 1.6's Kysely adapter writes array fields as serialized JSON when
 * `supportsArrays` is false. Direct control-plane writes use the same storage
 * representation explicitly; PostgreSQL returns parsed arrays on reads.
 */
export type JsonStringArray = ColumnType<readonly string[], string, string>;
export type JsonValue = ColumnType<unknown, unknown, unknown>;

export interface UserTable {
  id: ControlPlaneAccountId;
  displayName: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface AuthAccountTable {
  id: string;
  accountId: string;
  providerId: string;
  userId: ControlPlaneAccountId;
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
  id: string;
  userId: ControlPlaneAccountId;
  token: string;
  expiresAt: Timestamp;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface AuthVerificationTable {
  id: string;
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
  lastRequest: BigInteger;
}

export interface AuthJwkTable {
  id: string;
  publicKey: string;
  privateKey: string;
  createdAt: Timestamp;
  expiresAt: NullableTimestamp;
}

export interface OAuthClientTable {
  id: string;
  clientId: string;
  clientSecret: string | null;
  disabled: boolean;
  skipConsent: boolean | null;
  enableEndSession: boolean | null;
  subjectType: string | null;
  scopes: JsonStringArray | null;
  userId: ControlPlaneAccountId | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  name: string | null;
  uri: string | null;
  icon: string | null;
  contacts: JsonStringArray | null;
  tos: string | null;
  policy: string | null;
  softwareId: string | null;
  softwareVersion: string | null;
  softwareStatement: string | null;
  redirectUris: JsonStringArray;
  postLogoutRedirectUris: JsonStringArray | null;
  tokenEndpointAuthMethod: string | null;
  grantTypes: JsonStringArray | null;
  responseTypes: JsonStringArray | null;
  public: boolean | null;
  type: string | null;
  requirePkce: boolean | null;
  referenceId: string | null;
  metadata: JsonValue | null;
}

interface OAuthRefreshTokenTable {
  id: string;
  token: string;
  clientId: string;
  sessionId: string | null;
  userId: ControlPlaneAccountId;
  referenceId: string | null;
  expiresAt: Timestamp;
  createdAt: Timestamp;
  revoked: NullableTimestamp;
  authTime: NullableTimestamp;
  scopes: JsonStringArray;
}

interface OAuthAccessTokenTable {
  id: string;
  token: string;
  clientId: string;
  sessionId: string | null;
  userId: ControlPlaneAccountId | null;
  referenceId: string | null;
  refreshId: string | null;
  expiresAt: Timestamp;
  createdAt: Timestamp;
  scopes: JsonStringArray;
}

interface OAuthConsentTable {
  id: string;
  clientId: string;
  userId: ControlPlaneAccountId | null;
  referenceId: string | null;
  scopes: JsonStringArray;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * Browser session for the apex web portal. The portal proves identity once
 * through the Account authorization server and then reads the control-plane
 * database directly, so no OAuth token outlives the callback. The row is bound
 * to the Account session that proved it: revoking that session anywhere —
 * sign-out, `DELETE /v1/account/sessions`, Account deletion — removes this row
 * with it.
 */
export interface PortalSessionTable {
  id: string;
  tokenHash: string;
  accountId: ControlPlaneAccountId;
  accountSessionId: string;
  expiresAt: Timestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface DeploymentTable {
  id: DeploymentId;
  ownerAccountId: ControlPlaneAccountId;
  name: string;
  reachability: "canonical" | "routed";
  activeHostInstanceId: HostInstanceId;
  hostKeyFingerprint: HostKeyFingerprint;
  canonicalOrigin: string;
  lifecycle: DeploymentLifecycle;
  oidcClientId: string | null;
  authorityEnvelope: JsonValue | null;
  directoryGeneration: ColumnType<
    string,
    ProjectionGeneration | string | undefined,
    ProjectionGeneration | string
  >;
  accountLink: JsonValue | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

interface DeploymentCredentialTable {
  deploymentId: DeploymentId;
  tokenHash: string;
  createdAt: Timestamp;
  rotatedAt: Timestamp;
}

interface HostedOAuthBrokerAttemptTable {
  attemptId: HostedOAuthAttemptId;
  accountSubject: ControlPlaneAccountId;
  contextKeyVersion: number | null;
  deploymentId: DeploymentId;
  encryptedContext: Buffer | null;
  provider: string;
  requestedScopeDigest: string;
  launchTicketHash: string | null;
  stateHash: string | null;
  expiresAt: Timestamp;
  status:
    | "pending"
    | "launched"
    | "exchanging"
    | "sealed"
    | "acknowledged"
    | "denied"
    | "failed"
    | "expired";
  retryGeneration: Generated<number>;
  failureCode: string | null;
  providerApplicationRevision: number;
  hostPublicKey: string;
  sealedCiphertext: JsonValue | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

interface HostedOAuthBrokerRefreshTable {
  transactionId: HostedOAuthRefreshTransactionId;
  accountSubject: ControlPlaneAccountId;
  deploymentId: DeploymentId;
  provider: string;
  expiresAt: Timestamp;
  status: "pending" | "sealed" | "acknowledged" | "failed" | "expired";
  failureCode: string | null;
  providerError: string | null;
  providerApplicationRevision: number;
  hostPublicKey: string;
  sealedCiphertext: JsonValue | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface DeploymentDirectoryEntryTable {
  deploymentId: DeploymentId;
  accountId: ControlPlaneAccountId;
  generation: BigInteger<ProjectionGeneration>;
  present: boolean;
  observedAt: Timestamp;
  updatedAt: Timestamp;
}

export interface DeploymentDirectoryVisibilityTable {
  deploymentId: DeploymentId;
  accountId: ControlPlaneAccountId;
  hiddenAt: Timestamp;
}

export interface DeploymentConnectTable {
  deploymentId: DeploymentId;
  state: ConnectState;
  origin: string | null;
  generation: BigInteger<ProjectionGeneration>;
  accessRoute: ColumnType<unknown | null, unknown | null | undefined, unknown | null>;
  observedAt: NullableTimestamp;
  updatedAt: Timestamp;
}

export interface PersonalHostAccountLinkChallengeTable {
  challengeId: PersonalHostAccountLinkChallengeId;
  ownerAccountId: ControlPlaneAccountId;
  operationId: string;
  credentialHash: string;
  name: string;
  authority: JsonValue;
  reservedDeploymentId: DeploymentId;
  reservedHostInstanceId: HostInstanceId;
  reservedHostKeyFingerprint: HostKeyFingerprint;
  proofFingerprint: string | null;
  hostCredentialHash: string | null;
  linkGeneration: string | null;
  state: "pending" | "reserved" | "activated" | "cancelled" | "expired" | "unlinked";
  sealedResult: string | null;
  sealedIssue: string | null;
  challengeExpiresAt: Timestamp;
  resultExpiresAt: NullableTimestamp;
  activatedAt: NullableTimestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export type ConnectResourceState =
  "provisioning" | "ready" | "rotating" | "deleting" | "error" | "revoked";
export type ConnectResourceOperationKind = "provision" | "rotate" | "revoke";

export interface DeploymentConnectResourceTable {
  deploymentId: DeploymentId;
  provider: "cloudflare";
  state: ConnectResourceState;
  hostname: string;
  tunnelName: string;
  tunnelId: string | null;
  dnsRecordId: string | null;
  localOrigin: string;
  credentialGeneration: BigInteger;
  operationId: ConnectOperationId | null;
  operationKind: ConnectResourceOperationKind | null;
  operationExpiresAt: NullableTimestamp;
  lastCompletedOperationId: ConnectOperationId | null;
  lastCompletedOperationKind: ConnectResourceOperationKind | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface DeploymentConnectOperationTable {
  deploymentId: DeploymentId;
  operationId: ConnectOperationId;
  operationKind: ConnectResourceOperationKind;
  requestFingerprint: string;
  state: "running" | "failed" | "completed";
  resultGeneration: BigInteger | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface DeploymentAdoptionOperationTable {
  proofId: string;
  ownerAccountId: ControlPlaneAccountId;
  requestFingerprint: string;
  state: "completed" | "acknowledged" | "expired";
  receipt: JsonValue;
  sealedProvisioningBundle: string | null;
  resultExpiresAt: Timestamp;
  acknowledgedAt: NullableTimestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface CloudDeploymentOperationTable {
  operationId: string;
  ownerAccountId: ControlPlaneAccountId;
  deploymentId: DeploymentId;
  name: string;
  canonicalOrigin: string;
  status: "creating" | "ready" | "failed" | "deleting" | "deleted";
  desiredState: "present" | "deleted";
  error: string | null;
  /** What the operation is waiting on right now; never a failure, which belongs in `error`. */
  progress: string | null;
  /** The release the deployment last converged to; null until one is applied. */
  appliedRelease: string | null;
  sealedMaterial: string | null;
  lastReconciledAt: Timestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * One phone install's push registration. The provider token is held as
 * ciphertext because it is a capability to interrupt somebody: anyone holding
 * it and the platform credentials can put words on their lock screen. The hash
 * beside it is what makes "this token already belongs to another install"
 * answerable without ever decrypting anything.
 */
export interface NotificationDeviceTable {
  apsEnvironment: "development" | "production" | null;
  id: string;
  accountId: ControlPlaneAccountId;
  installationId: string;
  application: "mobile";
  platform: NotificationDevicePlatform;
  tokenCiphertext: string;
  tokenHash: string;
  approvalsEnabled: boolean;
  runOutcomesEnabled: boolean;
  registeredAt: Timestamp;
  updatedAt: Timestamp;
  lastSeenAt: Timestamp;
  disabledAt: NullableTimestamp;
}

/**
 * What the Account did with one Host publication, kept whatever that was.
 *
 * Delivery rows cannot answer "have I seen this publication before": a
 * publication that reached nobody writes none, and the ones it does write
 * vanish with the device they were addressed to. The receipt is the durable
 * answer instead — one row per (Deployment, notification), written even for a
 * zero-delivery outcome and never cascaded by a device — so a Host retrying a
 * publication is told what it already became rather than fanning it out again.
 */
export interface NotificationPublicationTable {
  deploymentId: DeploymentId;
  notificationId: NotificationId;
  threadId: ThreadId;
  kind: PublishedNotificationKind;
  deliveries: Generated<number>;
  receivedAt: Timestamp;
}

/** One attempt-tracked delivery of one publication to one device. */
export interface NotificationDeliveryTable {
  notificationId: NotificationId;
  deviceId: string;
  deploymentId: DeploymentId;
  threadId: ThreadId;
  requestId: string | null;
  messageId: string | null;
  kind: PublishedNotificationKind;
  expiresAt: Timestamp;
  status: "pending" | "delivered" | "failed" | "dropped";
  attempts: Generated<number>;
  nextAttemptAt: Timestamp;
  leaseToken: string | null;
  leaseExpiresAt: NullableTimestamp;
  providerOutcome: string | null;
  createdAt: Timestamp;
  completedAt: NullableTimestamp;
}

export interface ControlPlaneDatabaseSchema {
  cloudDeploymentOperations: CloudDeploymentOperationTable;
  users: UserTable;
  authAccounts: AuthAccountTable;
  authSessions: AuthSessionTable;
  authVerifications: AuthVerificationTable;
  authRateLimits: AuthRateLimitTable;
  authJwks: AuthJwkTable;
  oauthClients: OAuthClientTable;
  // Better Auth OAuth Provider 1.6.26 does not expose modelName for this one
  // plugin table, so its logical and physical table name remains singular.
  oauthRefreshToken: OAuthRefreshTokenTable;
  oauthAccessTokens: OAuthAccessTokenTable;
  oauthConsents: OAuthConsentTable;
  portalSessions: PortalSessionTable;
  deployments: DeploymentTable;
  deploymentCredentials: DeploymentCredentialTable;
  hostedOAuthBrokerAttempts: HostedOAuthBrokerAttemptTable;
  hostedOAuthBrokerRefreshes: HostedOAuthBrokerRefreshTable;
  deploymentDirectoryEntries: DeploymentDirectoryEntryTable;
  deploymentDirectoryVisibility: DeploymentDirectoryVisibilityTable;
  deploymentConnect: DeploymentConnectTable;
  personalHostAccountLinkChallenges: PersonalHostAccountLinkChallengeTable;
  deploymentConnectResources: DeploymentConnectResourceTable;
  deploymentConnectOperations: DeploymentConnectOperationTable;
  deploymentAdoptionOperations: DeploymentAdoptionOperationTable;
  notificationDevices: NotificationDeviceTable;
  notificationDeliveries: NotificationDeliveryTable;
  notificationPublications: NotificationPublicationTable;
}

export type DeploymentRow = Selectable<DeploymentTable>;
export type DeploymentConnectRow = Selectable<DeploymentConnectTable>;
export type PersonalHostAccountLinkChallengeRow = Selectable<PersonalHostAccountLinkChallengeTable>;
export type DeploymentConnectResourceRow = Selectable<DeploymentConnectResourceTable>;
export type DeploymentConnectOperationRow = Selectable<DeploymentConnectOperationTable>;
export type DeploymentAdoptionOperationRow = Selectable<DeploymentAdoptionOperationTable>;
export type NotificationDeviceRow = Selectable<NotificationDeviceTable>;

// Retain this alias for tables whose IDs Better Auth generates internally.
