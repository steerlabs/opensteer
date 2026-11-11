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
  "folder_unavailable",
]);
export type OpensteerErrorCode = z.infer<typeof OpensteerErrorCodeSchema>;

/**
 * A `conflict` refusing a Request for a Browser Session that ended, or moved
 * task, after its caller last saw it open. Only this refusal means the
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

/** Text and a recovery written for the reader, as `throw refused(...)`. */
export function refused(code: OpensteerErrorCode, message: string, next?: string): OpensteerError {
  return new OpensteerError({ code, message, ...(next === undefined ? {} : { next }) });
}

export class OpensteerError extends Error {
  readonly code: OpensteerErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;
  /**
   * Stable machine-readable discriminator within one `code`. Clients branch on
   * it instead of matching prose, so a wording change is never a behaviour
   * change. It is optional: only errors a client must tell apart carry one.
   */
  readonly reason: string | undefined;
  /**
   * What an agent should do next, naming its tool and parameter. Agents read
   * it after `message`. People read only `message`, so a refusal they can also
   * meet keeps tool names here.
   */
  readonly next: string | undefined;
  readonly retryable: boolean;

  constructor(options: {
    readonly code: OpensteerErrorCode;
    readonly message: string;
    readonly next?: string;
    readonly reason?: string;
    readonly retryable?: boolean;
    readonly details?: Readonly<Record<string, unknown>>;
    readonly cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "OpensteerError";
    this.code = options.code;
    this.reason = options.reason;
    this.next = options.next;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}
