import { z } from "zod";

export const OpensteerErrorCodeSchema = z.enum([
  "bad_request",
  "canonical_surface_required",
  "conflict",
  "forbidden",
  "harness_error",
  "harness_session_broken",
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

const beforeEffect = new WeakSet<object>();
/**
 * Marks an error as raised before its command's effect began: nothing left the Home. It is set
 * where the error is raised (a refusal while choosing where to act, before anything is sent),
 * never inferred from a code. An unmarked error from a command that can act outside the Home's
 * database leaves its outcome unknown.
 */
export function raisedBeforeEffect<E extends Error>(error: E): E {
  beforeEffect.add(error);
  return error;
}
export function isRaisedBeforeEffect(error: unknown): boolean {
  return typeof error === "object" && error !== null && beforeEffect.has(error);
}

export { OpensteerError, refused } from "./opensteer-error.js";
