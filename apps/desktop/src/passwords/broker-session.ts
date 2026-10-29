import type {
  PasswordsBrokerSignInApproveParamsSchema,
  PasswordsBrokerSignInApproveResultSchema,
  PasswordsBrokerSignInProbeParams,
  PasswordsBrokerSignInProbeResult,
  PasswordsBrokerSignInReleaseParams,
  PasswordsBrokerSignInReleaseResult,
  PasswordsBrokerSignInDecision,
  PasswordsBrokerSignInRequestParams,
  PasswordsBrokerSignInRequestV5Params,
  PasswordsBrokerSignInReleaseV5Params,
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
  readonly protocolVersion?: 4 | 5;
  probe(params: PasswordsBrokerSignInProbeParams): Promise<PasswordsBrokerSignInProbeResult>;
  request(
    params: PasswordsBrokerSignInRequestParams | PasswordsBrokerSignInRequestV5Params,
    signal: AbortSignal,
  ): Promise<PasswordsBrokerSignInGrant>;
  approve(
    params: PasswordsBrokerSignInApproveParams,
    signal: AbortSignal,
  ): Promise<PasswordsBrokerSignInApproveResult>;
  release(
    params: PasswordsBrokerSignInReleaseParams | PasswordsBrokerSignInReleaseV5Params,
    signal?: AbortSignal,
  ): Promise<PasswordsBrokerSignInReleaseResult>;
  cancel(transactionId: string): Promise<void>;
}
