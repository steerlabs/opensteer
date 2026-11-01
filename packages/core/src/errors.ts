import { z } from "zod";

export const OpensteerErrorCodeSchema = z.enum([
  "bad_request",
  "canonical_surface_required",
  "conflict",
  "forbidden",
  "harness_error",
  "harness_usage_limit",
  "internal",
  "not_found",
  "resource_exhausted",
  "runner_offline",
  "timeout",
  "unauthorized",
  "workspace_unavailable",
]);
export type OpensteerErrorCode = z.infer<typeof OpensteerErrorCodeSchema>;

/**
 * A `conflict` refusing a Request for a Browser Session that ended, or moved
 * Workspace, after its caller last saw it open. Only this refusal means the
 * session is closed; any other conflict is the caller's to report.
 */
export const browserSessionClosedReason = "browser-session-closed";
/**
 * The Host and the client do not speak the same protocol epoch, so nothing
 * further about this call is worth attempting. It rides on `bad_request`
 * because the request itself is the problem and no retry of it can succeed;
 * the reason is what a UI branches on to say which side needs updating.
 */
export const unsupportedVersionReason = "unsupported-version";

export class OpensteerError extends Error {
  readonly code: OpensteerErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;
  /**
   * Stable machine-readable discriminator within one `code`. Clients branch on
   * it instead of matching prose, so a wording change is never a behaviour
   * change. It is optional: only errors a client must tell apart carry one.
   */
  readonly reason: string | undefined;
  readonly retryable: boolean;

  constructor(options: {
    readonly code: OpensteerErrorCode;
    readonly message: string;
    readonly reason?: string;
    readonly retryable?: boolean;
    readonly details?: Readonly<Record<string, unknown>>;
    readonly cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "OpensteerError";
    this.code = options.code;
    this.reason = options.reason;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}
