import { HostClientRequestError, isHostRefusal } from "./client.js";

/**
 * The codes under which a Home writes its refusal as a sentence for the person: what was
 * refused and why, in the Home's words ("Another chat already answers in this conversation.",
 * "That messaging account is no longer connected."). Everything else (`internal`, a timeout, an
 * engine's own error, a Runner that is offline) is the app's to word.
 */
const refusalCodes: ReadonlySet<string> = new Set([
  "bad_request",
  "conflict",
  "forbidden",
  "not_found",
  "resource_exhausted",
  "folder_unavailable",
]);

/**
 * The one place that decides what a person reads for a failed call to a Home: the Home's own
 * sentence when the Home refused and wrote one for the person, otherwise `fallback`.
 *
 * Passed through: a refusal the Home answered (`isHostRefusal`: it came from the Home, under
 * 500, not a timeout or a rate limit) under a refusal code, that is not `invalid-request`.
 * Never passed: anything that did not come back as a Home refusal (a socket error, a parse
 * failure, a local exception, whose text may hold paths or a validator's report), `internal`
 * and other non-refusal codes, and a request the Home could not read (`reason:
 * "invalid-request"`, whose text is a validator's report for the caller). The Host marks every
 * request it cannot read so in its one HTTP mapping (`normalizeHostError`); a Host path that
 * writes a validator's issues into a refusal of its own is caught by
 * `apps/host/src/server/validation-text.test.ts`.
 */
export function homeFailureText(error: unknown, fallback: string): string {
  if (!(error instanceof HostClientRequestError) || !isHostRefusal(error)) return fallback;
  if (error.reason === "invalid-request" || !refusalCodes.has(error.code)) return fallback;
  const text = error.message.trim();
  return text === "" ? fallback : text;
}
