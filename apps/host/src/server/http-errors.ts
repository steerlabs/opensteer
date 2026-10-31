import { HostApiErrorSchema } from "@opensteer/protocol";
import { OpensteerError } from "@opensteer/core";
import { formatIssues } from "@opensteer/shared/validationIssues";
import { z } from "zod";

/**
 * One status ladder for the whole Host.
 *
 * The rpc group and the machine-protocol REST routes answer in different
 * envelopes, but a `conflict` must not be a 409 on one path and a 500 on the
 * other — a client that retries on 503 and gives up on 403 is reading a
 * contract, and two copies of that contract drift. Both paths normalize here.
 */
export interface NormalizedHostError {
  readonly error: z.output<typeof HostApiErrorSchema>;
  readonly status: number;
}

export function normalizeHostError(error: unknown): NormalizedHostError {
  if (error instanceof Error && "code" in error && error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
    return {
      error: { code: "bad_request", message: "Request body is too large", retryable: false },
      status: 413,
    };
  }
  // A malformed body reaches the handler as a parse failure, not as a fault of
  // this Deployment; both spellings of that failure are the caller's mistake.
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return {
      error: {
        code: "bad_request",
        message:
          error instanceof z.ZodError
            ? `Request is invalid: ${formatIssues(error.issues.map((issue) => (issue.path.includes("screenPresentation") ? { path: ["screenPresentation"], message: "Invalid presentation context" } : issue)))}`
            : "Request contains invalid JSON",
        retryable: false,
      },
      status: 400,
    };
  }
  if (error instanceof OpensteerError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.reason === undefined ? {} : { reason: error.reason }),
        retryable: error.retryable,
      },
      status: errorStatus(error),
    };
  }
  // An unexpected throw is not a contract: its message can name a query, a
  // path, or a credential, so the caller gets the same sentence every time and
  // the detail goes to the log.
  return {
    error: { code: "internal", message: "Internal server error", retryable: false },
    status: 500,
  };
}

export function errorStatus(error: { readonly code?: string }): number {
  return error.code === "bad_request"
    ? 400
    : error.code === "unauthorized"
      ? 401
      : error.code === "canonical_surface_required" || error.code === "forbidden"
        ? 403
        : error.code === "not_found"
          ? 404
          : error.code === "conflict"
            ? 409
            : error.code === "resource_exhausted" || error.code === "timeout"
              ? 429
              : error.code === "runner_offline" || error.code === "workspace_unavailable"
                ? 503
                : 500;
}
