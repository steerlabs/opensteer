import type { UserId } from "@opensteer/core";
import type {
  IntegrationConnectionId,
  IntegrationInstallationId,
  IntegrationOAuthAttemptId,
  McpOAuthAttemptId,
} from "./ids.js";
import type {
  IntegrationAuthorizationSurface,
  IntegrationConnectionSummary,
  IntegrationDashboard,
  IntegrationInstallation,
  IntegrationOAuthApplicationSource,
  IntegrationPlatformDashboard,
  IntegrationProvider,
  IntegrationProviderAuthorization,
  IntegrationProviderApplication,
  IntegrationServer,
  IntegrationSkill,
  IntegrationTool,
} from "./models.js";

export interface SealedIntegrationSecret {
  readonly envelope: Buffer;
  readonly keyVersion: number;
}

export interface IntegrationSecretContext {
  readonly binding: IntegrationProvider;
  readonly provider: IntegrationProvider;
  readonly purpose: "oauth-attempt" | "provider-application" | "provider-connection";
  readonly recordId: string;
  readonly scope: `instance` | `user:${string}`;
}

export interface IntegrationSecretVault {
  open(
    envelope: Buffer,
    context: IntegrationSecretContext,
  ): Promise<Readonly<Record<string, string>>>;
  seal(
    value: Readonly<Record<string, string>>,
    context: IntegrationSecretContext,
  ): Promise<SealedIntegrationSecret>;
}

export interface IntegrationProviderApplicationRecord extends Omit<
  IntegrationProviderApplication,
  "availability" | "callbackUrl" | "canManage" | "configuredSecretFields"
> {
  readonly encryptedSecrets: Buffer;
  readonly encryptionKeyVersion: number;
}

export type IntegrationAuthAttemptFlow = "mcp-oauth" | "provider-oauth";
export type IntegrationAuthAttemptId = IntegrationOAuthAttemptId | McpOAuthAttemptId;
export type IntegrationAuthAttemptSurface = "desktop" | "native" | "web";
export type IntegrationAuthAttemptFailureReason =
  | "account-link-mismatch"
  | "authorization-denied"
  | "cancelled"
  | "catalog-version-skew"
  | "client-rejected"
  | "denied"
  | "exchange-failed"
  | "expired"
  | "grant-rejected"
  | "invalid-provider-response"
  | "provider-exchange-failed"
  | "provider-identity-already-connected"
  | "scope-escalation"
  | "stale-provider-application";

export interface ClaimedIntegrationAuthAttempt {
  readonly encryptedPayload: Buffer;
  readonly encryptionKeyVersion: number;
  readonly id: IntegrationAuthAttemptId;
  readonly ownerUserId: UserId;
  readonly surface: IntegrationAuthAttemptSurface;
}

export interface LaunchableIntegrationAuthAttempt extends ClaimedIntegrationAuthAttempt {
  readonly flow: IntegrationAuthAttemptFlow;
  readonly surface: IntegrationAuthAttemptSurface;
}

export interface IntegrationAuthAttemptRecord {
  readonly expiresAt: Date;
  readonly failureReason: IntegrationAuthAttemptFailureReason | null;
  readonly id: IntegrationAuthAttemptId;
  readonly ownerUserId: UserId;
  readonly resultConnectionId: IntegrationConnectionId | null;
  readonly status: "pending" | "launched" | "claimed" | "completed" | "failed";
  readonly surface: IntegrationAuthAttemptSurface;
}

export interface IntegrationAuthAttemptStore {
  claimHostedAuthAttempt?(input: {
    readonly id: IntegrationOAuthAttemptId;
    readonly now: Date;
    readonly ownerUserId: UserId;
  }): Promise<ClaimedIntegrationAuthAttempt | null>;
  claimAuthAttempt(input: {
    readonly browserBindingHash: string;
    readonly flow: IntegrationAuthAttemptFlow;
    readonly id: IntegrationAuthAttemptId;
    readonly now: Date;
    readonly stateHash: string;
  }): Promise<ClaimedIntegrationAuthAttempt | null>;
  cancelAuthAttempt(input: {
    readonly id: IntegrationAuthAttemptId;
    readonly ownerUserId: UserId;
  }): Promise<boolean>;
  createAuthAttempt(input: {
    readonly encryptedPayload: Buffer;
    readonly encryptionKeyVersion: number;
    readonly expiresAt: Date;
    readonly flow: IntegrationAuthAttemptFlow;
    readonly id: IntegrationAuthAttemptId;
    readonly launchTicketHash: string;
    readonly ownerUserId: UserId;
    readonly stateHash: string;
    readonly surface: IntegrationAuthAttemptSurface;
  }): Promise<void>;
  deleteExpiredAuthAttempts(now: Date): Promise<void>;
  failAuthAttempt(input: {
    readonly id: IntegrationAuthAttemptId;
    readonly reason: Exclude<IntegrationAuthAttemptFailureReason, "cancelled">;
  }): Promise<void>;
  findAuthAttemptForCallback(input: {
    readonly flow: IntegrationAuthAttemptFlow;
    readonly now: Date;
    readonly stateHash: string;
  }): Promise<{ readonly id: IntegrationAuthAttemptId } | null>;
  getAuthAttempt(input: {
    readonly id: IntegrationAuthAttemptId;
    readonly ownerUserId: UserId;
  }): Promise<IntegrationAuthAttemptRecord | null>;
  readAuthAttemptPayload?(input: {
    readonly id: IntegrationAuthAttemptId;
    readonly ownerUserId: UserId;
  }): Promise<ClaimedIntegrationAuthAttempt | null>;
  launchAuthAttempt(input: {
    readonly browserBindingHash: string;
    readonly id: IntegrationAuthAttemptId;
    readonly launchTicketHash: string;
    readonly now: Date;
  }): Promise<LaunchableIntegrationAuthAttempt | null>;
}

export interface IntegrationConnectionSecretRecord {
  readonly connection: IntegrationConnectionSummary;
  readonly credentialGeneration: number;
  readonly encryptedCredential: Buffer;
  readonly encryptionKeyVersion: number;
  readonly providerApplication: IntegrationProviderApplicationRecord | null;
}

export interface IntegrationRepository {
  completeOAuthAttempt(input: {
    readonly attemptId: IntegrationOAuthAttemptId;
    readonly connection: Omit<IntegrationConnectionSummary, "createdAt" | "updatedAt">;
    readonly credential: SealedIntegrationSecret;
    readonly credentialProvider: string;
    readonly ownerUserId: UserId;
  }): Promise<IntegrationConnectionSummary>;
  connectApiKey(input: {
    readonly connection: Omit<IntegrationConnectionSummary, "createdAt" | "updatedAt">;
    readonly credential: SealedIntegrationSecret;
    readonly credentialProvider: string;
    readonly ownerUserId: UserId;
    /** The owner named `connection.id` to repair: it must exist, and is never created. */
    readonly reconnect: boolean;
    readonly requestId: string;
  }): Promise<IntegrationConnectionSummary>;
  findReusableConnectionId(input: {
    readonly definitionId: string;
    readonly externalIdentityId: string;
    readonly externalTenantId: string | null;
    readonly ownerUserId: UserId;
    readonly provider: IntegrationProvider;
  }): Promise<IntegrationConnectionId | null>;
  getConnectionForAccess(input: {
    readonly connectionId: IntegrationConnectionId;
    readonly ownerUserId: UserId;
  }): Promise<IntegrationConnectionSecretRecord | null>;
  getConnectionForRevocation(input: {
    readonly connectionId: IntegrationConnectionId;
    readonly ownerUserId: UserId;
  }): Promise<IntegrationConnectionSecretRecord | null>;
  getProviderApplication(
    applicationId: import("./ids.js").IntegrationProviderApplicationId,
  ): Promise<IntegrationProviderApplicationRecord | null>;
  getSharedProviderApplication(
    provider: IntegrationProvider,
  ): Promise<IntegrationProviderApplicationRecord | null>;
  listConnections(ownerUserId: UserId): Promise<readonly IntegrationConnectionSummary[]>;
  listProviderApplications(
    ownerUserId: UserId,
  ): Promise<readonly IntegrationProviderApplicationRecord[]>;
  listApplicationSourceDefaults(): Promise<
    Readonly<Record<string, "deployment-oauth" | "hosted-oauth">>
  >;
  markConnectionNeedsAttention(input: {
    readonly connectionId: IntegrationConnectionId;
    readonly expectedGeneration?: number;
    readonly ownerUserId: UserId;
    readonly statusDetail: string;
  }): Promise<void>;
  recordConnectionAccess(input: {
    readonly connectionId: IntegrationConnectionId;
    readonly operation: string;
    readonly ownerUserId: UserId;
  }): Promise<void>;
  replaceConnectionCredential(input: {
    readonly allowNeedsAttention?: boolean;
    readonly connectionId: IntegrationConnectionId;
    readonly credential: SealedIntegrationSecret;
    readonly expectedGeneration: number;
    readonly ownerUserId: UserId;
  }): Promise<boolean>;
  setConnectionRepositoryAccess(input: {
    readonly connectionId: IntegrationConnectionId;
    readonly expectedApplicationSource: IntegrationOAuthApplicationSource;
    readonly expectedGeneration: number;
    readonly expectedStatus: "connected" | "needs-attention";
    readonly expectedStatusDetail: string | null;
    readonly ownerUserId: UserId;
    readonly status: "connected" | "needs-attention";
    readonly statusDetail: string | null;
    /** "permissions" while GitHub can reach no repository; null once it can. */
    readonly statusReason: "permissions" | null;
  }): Promise<boolean>;
  revokeConnection(input: {
    readonly connectionId: IntegrationConnectionId;
    readonly credential: SealedIntegrationSecret;
    readonly ownerUserId: UserId;
    readonly requestId: string;
  }): Promise<void>;
  saveProviderApplication(input: {
    readonly application: Omit<
      IntegrationProviderApplication,
      | "availability"
      | "callbackUrl"
      | "canManage"
      | "configuredSecretFields"
      | "createdAt"
      | "revision"
      | "updatedAt"
    >;
    readonly actorUserId: UserId;
    readonly expectedRevision: number | null;
    readonly requestId: string;
    readonly secrets: SealedIntegrationSecret;
  }): Promise<IntegrationProviderApplicationRecord>;
  setProviderApplicationStatus(input: {
    readonly actorUserId: UserId;
    readonly expectedRevision: number;
    readonly applicationId: import("./ids.js").IntegrationProviderApplicationId;
    readonly requestId: string;
    readonly status: "active" | "disabled";
  }): Promise<IntegrationProviderApplicationRecord>;
  setApplicationSourceDefault(input: {
    readonly actorUserId: UserId;
    readonly applicationSource: "deployment-oauth" | "hosted-oauth";
    readonly provider: IntegrationProvider;
    readonly requestId: string;
  }): Promise<void>;
}

export interface IntegrationAdapterCredentialMaterializer {
  markAdapterAuthorizationRequired(input: {
    readonly connectionId: IntegrationConnectionId;
    /** The credential the rejected call used; a newer one is left alone. */
    readonly expectedGeneration: number;
    readonly ownerUserId: UserId;
    readonly statusDetail: string;
  }): Promise<void>;
  materializeForAdapter(input: {
    readonly connectionId: IntegrationConnectionId;
    readonly forceRefresh?: boolean;
    readonly operation: string;
    readonly ownerUserId: UserId;
  }): Promise<{
    readonly authMethodId: string;
    readonly connectionMethod: IntegrationConnectionSummary["connectionMethod"];
    readonly credentialGeneration: number;
    readonly credentialValues: Readonly<Record<string, string>>;
    readonly definitionId: string;
    readonly grantedScopes: readonly string[];
    readonly provider: IntegrationProvider;
  }>;
}

export interface IntegrationDashboardProviderSource {
  dashboard(
    ownerUserId: UserId,
    isAdministrator: boolean,
    authorizationSurface: IntegrationAuthorizationSurface,
  ): Promise<IntegrationDashboard>;
}

export interface IntegrationProviderAuthorizationSource {
  providerAuthorizations(
    ownerUserId: UserId,
  ): Promise<Readonly<Record<string, IntegrationProviderAuthorization>>>;
}

export interface IntegrationDashboardRepository {
  listInstallations(): Promise<readonly IntegrationInstallation[]>;
  listMcpOAuthConnections(
    ownerUserId: UserId,
  ): Promise<readonly IntegrationPlatformDashboard["connections"][number][]>;
  listServers(installationId: IntegrationInstallationId): Promise<readonly IntegrationServer[]>;
  listSkills(installationId: IntegrationInstallationId): Promise<readonly IntegrationSkill[]>;
  listTools(
    installationId: IntegrationInstallationId,
    ownerUserId?: UserId,
  ): Promise<readonly IntegrationTool[]>;
}
