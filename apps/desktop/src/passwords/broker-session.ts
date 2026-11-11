import type {
  PasswordsBrokerProtocolVersion,
  PasswordsBrokerSaveBeginParamsSchema,
  PasswordsBrokerSaveBeginResultSchema,
  PasswordsBrokerSaveCommitResultSchema,
  PasswordsBrokerFillAccountsParamsSchema,
  PasswordsBrokerFillAccountsResultSchema,
  PasswordsBrokerFillBeginParamsSchema,
  PasswordsBrokerFillBeginResultSchema,
  PasswordsBrokerCardRequestParamsSchema,
  PasswordsBrokerCardRequestResultSchema,
  PasswordsBrokerCardApproveParamsSchema,
  PasswordsBrokerCardApproveResultSchema,
  PasswordsBrokerCardReleaseParamsSchema,
  PasswordsBrokerCardReleaseResultSchema,
  PasswordsBrokerSignInApproveParamsSchema,
  PasswordsBrokerSignInApproveResultSchema,
  PasswordsBrokerSignInProbeParams,
  PasswordsBrokerSignInProbeResult,
  PasswordsBrokerSignInReleaseResult,
  PasswordsBrokerSignInDecision,
  PasswordsBrokerSignInRequestParams,
  PasswordsBrokerSignInReleaseParams,
} from "@opensteer/protocol/passwords-broker";
import type { z } from "zod";

export type PasswordsBrokerSignInApproveParams = z.infer<
  typeof PasswordsBrokerSignInApproveParamsSchema
>;
export type PasswordsBrokerSignInApproveResult = z.infer<
  typeof PasswordsBrokerSignInApproveResultSchema
>;
export type { PasswordsBrokerSignInReleaseParams, PasswordsBrokerSignInReleaseResult };

export type PasswordsBrokerFailureCode =
  | "invalid"
  | "unavailable"
  | "internal"
  | "aborted"
  | "connection-lost"
  | "timeout"
  | "malformed"
  | "incompatible"
  | "wrong-build"
  | "not-running"
  | "stopped";

/** Messages never carry a parameter or a result. */
export class PasswordsBrokerFailure extends Error {
  readonly code: PasswordsBrokerFailureCode;
  constructor(code: PasswordsBrokerFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "PasswordsBrokerFailure";
  }
}

export interface PasswordsBrokerSignInGrant {
  readonly decision: PasswordsBrokerSignInDecision;
  /** Authority lasts only as long as the connection that owns the transaction. */
  readonly lifetime: AbortSignal;
}

/** Every transaction call stays on the connection that carried request; it never reconnects. */
export interface PasswordsBrokerSession {
  readonly protocolVersion?: PasswordsBrokerProtocolVersion;
  probe(params: PasswordsBrokerSignInProbeParams): Promise<PasswordsBrokerSignInProbeResult>;
  request(
    params: PasswordsBrokerSignInRequestParams,
    signal: AbortSignal,
  ): Promise<PasswordsBrokerSignInGrant>;
  approve(
    params: PasswordsBrokerSignInApproveParams,
    signal: AbortSignal,
  ): Promise<PasswordsBrokerSignInApproveResult>;
  release(
    params: PasswordsBrokerSignInReleaseParams,
    signal?: AbortSignal,
  ): Promise<PasswordsBrokerSignInReleaseResult>;
  commit(transactionId: string, signal: AbortSignal): Promise<{ committed: boolean }>;
  cancel(transactionId: string): Promise<void>;
}

export interface PasswordsBrokerCardSession {
  cardProbe(): Promise<{ cards: import("@opensteer/protocol").CardAvailability }>;
  cardRequest(
    params: z.infer<typeof PasswordsBrokerCardRequestParamsSchema>,
    signal: AbortSignal,
  ): Promise<{
    decision: z.infer<typeof PasswordsBrokerCardRequestResultSchema>;
    lifetime: AbortSignal;
  }>;
  cardApprove(
    params: z.infer<typeof PasswordsBrokerCardApproveParamsSchema>,
    signal: AbortSignal,
  ): Promise<z.infer<typeof PasswordsBrokerCardApproveResultSchema>>;
  cardRelease(
    params: z.infer<typeof PasswordsBrokerCardReleaseParamsSchema>,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof PasswordsBrokerCardReleaseResultSchema>>;
}

/**
 * Person fill on a protocol 8 connection. A person transaction is released and
 * ended with `release` (kind browser) and `cancel`, and is never an agent's.
 */
export interface PasswordsBrokerPersonFillSession {
  fillAccounts(
    params: z.infer<typeof PasswordsBrokerFillAccountsParamsSchema>,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof PasswordsBrokerFillAccountsResultSchema>>;
  /** Lasts as long as the connection that owns the transaction, like a sign-in grant. */
  fillBegin(
    params: z.infer<typeof PasswordsBrokerFillBeginParamsSchema>,
    signal: AbortSignal,
  ): Promise<{
    decision: z.infer<typeof PasswordsBrokerFillBeginResultSchema>;
    lifetime: AbortSignal;
  }>;
}

/**
 * Saving a login a person typed, on a protocol 9 connection. The broker holds
 * the login until `saveCommit`, `cancel` or its deadline, and only for the
 * connection that began it.
 */
export interface PasswordsBrokerPersonSaveSession {
  saveBegin(
    params: z.infer<typeof PasswordsBrokerSaveBeginParamsSchema>,
    signal: AbortSignal,
  ): Promise<{
    decision: z.infer<typeof PasswordsBrokerSaveBeginResultSchema>;
    lifetime: AbortSignal;
  }>;
  saveCommit(transactionId: string): Promise<z.infer<typeof PasswordsBrokerSaveCommitResultSchema>>;
}
