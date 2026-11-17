import type { UserId } from "@opensteer/core";
import type { IntegrationOAuthAttemptId } from "./ids.js";

/** Plugin sign-in is the one flow; the name binds each sealed attempt payload. */
export type IntegrationAuthAttemptFlow = "provider-oauth";
export type IntegrationAuthAttemptId = IntegrationOAuthAttemptId;
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
  | "plugin-declaration-changed"
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
  readonly status: "pending" | "launched" | "claimed" | "completed" | "failed";
  readonly surface: IntegrationAuthAttemptSurface;
}

export interface IntegrationAuthAttemptStore {
  claimHostedAuthAttempt?(input: {
    readonly id: IntegrationAuthAttemptId;
    readonly flow?: IntegrationAuthAttemptFlow;
    readonly stateHash?: string;
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

export interface IntegrationOAuthAccountBindingValue {
  readonly issuer: string;
  readonly subject: string;
  readonly linkGeneration: string;
}
export interface IntegrationOAuthAccountBinding extends IntegrationOAuthAccountBindingValue {
  readonly kind: "personal";
}
