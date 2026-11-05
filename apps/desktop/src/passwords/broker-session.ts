import type {
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
  PasswordsBrokerSignInReleaseParams,
  PasswordsBrokerSignInReleaseResult,
  PasswordsBrokerSignInDecision,
  PasswordsBrokerSignInRequestParams,
  PasswordsBrokerSignInRequestV6Params,
  PasswordsBrokerSignInReleaseV6Params,
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
  readonly protocolVersion?: 4 | 5 | 6 | 7;
  probe(params: PasswordsBrokerSignInProbeParams): Promise<PasswordsBrokerSignInProbeResult>;
  request(
    params: PasswordsBrokerSignInRequestParams | PasswordsBrokerSignInRequestV6Params,
    signal: AbortSignal,
  ): Promise<PasswordsBrokerSignInGrant>;
  approve(
    params: PasswordsBrokerSignInApproveParams,
    signal: AbortSignal,
  ): Promise<PasswordsBrokerSignInApproveResult>;
  release(
    params: PasswordsBrokerSignInReleaseParams | PasswordsBrokerSignInReleaseV6Params,
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
