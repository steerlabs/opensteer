/**
 * Why one client operation failed, expressed as data.
 *
 * Only the boundary that observed the failure knows whether retrying can help:
 * a deadline the client imposed, a transport that never reached the service,
 * or a service that answered with a refusal. That boundary classifies the
 * failure once, and the Deployment access state machine consumes the
 * classification instead of re-deriving intent from message text.
 */
export type ClientOperationClassification = "blocked" | "transient";

interface ClassifiedClientFailure {
  readonly classification: ClientOperationClassification;
  readonly reason: string;
}

export class ClientOperationError extends Error {
  readonly classification: ClientOperationClassification;

  constructor(
    message: string,
    classification: ClientOperationClassification,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ClientOperationError";
    this.classification = classification;
  }
}

/**
 * Lets a host process exit while a deadline is still outstanding.
 *
 * Node keeps its event loop alive for a pending timer and offers `unref` to
 * opt out; a browser and Hermes hand back an opaque handle with no such
 * notion. Every deadline in this package is cleared in a `finally`, so this
 * only decides whether an in-flight request delays a shutdown.
 */
export function unrefTimer(timer: unknown): void {
  if (typeof timer !== "object" || timer === null) return;
  const unref = (timer as { readonly unref?: () => void }).unref;
  if (typeof unref === "function") unref.call(timer);
}

/** The client deadline for one request, which a later attempt can still meet. */
export function clientTimeoutError(message: string): ClientOperationError {
  return new ClientOperationError(message, "transient");
}

/** Statuses the service itself reports as temporary rather than as a refusal. */
export function transientHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function classifyClientFailure(error: unknown): ClassifiedClientFailure {
  const classification = failureClassification(error);
  return {
    classification,
    // A Host refusal carries both a code and, where it must be told apart from
    // the other refusals under that code, a `reason`. The narrower of the two
    // is what a surface can act on — `unsupported-version` names a repair,
    // `bad_request` names nothing.
    reason:
      stringField(error, "reason") ??
      stringField(error, "code") ??
      (classification === "transient" ? "unavailable" : "blocked"),
  };
}

/** Strips credentials an upstream message may have echoed back verbatim. */
export function clientPublicDetail(error: unknown, fallback: string): string {
  const detail = error instanceof Error && error.message.trim() ? error.message.trim() : fallback;
  return detail
    .replace(/Bearer\s+[^\s]+/giu, "Bearer [redacted]")
    .replace(/os_secret_[A-Za-z0-9_-]+/gu, "os_secret_[redacted]")
    .slice(0, 2_000);
}

function failureClassification(error: unknown): ClientOperationClassification {
  if (error instanceof ClientOperationError) return error.classification;
  // An aborted request and a transport-level throw never reached a decision,
  // so nothing about the local state makes them permanent.
  if (stringField(error, "name") === "AbortError" || error instanceof TypeError) return "transient";
  const status = numberField(error, "status");
  return status !== null && transientHttpStatus(status) ? "transient" : "blocked";
}

function stringField(value: unknown, field: string): string | null {
  const candidate = readField(value, field);
  return typeof candidate === "string" ? candidate : null;
}

function numberField(value: unknown, field: string): number | null {
  const candidate = readField(value, field);
  return typeof candidate === "number" ? candidate : null;
}

function readField(value: unknown, field: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[field];
}
