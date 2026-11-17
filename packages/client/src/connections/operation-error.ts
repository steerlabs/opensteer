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

export type ClientFailureKind =
  | "cancelled"
  | "transport"
  | "session"
  | "rejection"
  | "service"
  | "protocol"
  | "local"
  | "unexpected";
export type ClientFailureProvenance = "transport" | "host" | "proxy" | "protocol" | "local";
export interface ClientFailure {
  readonly classification: ClientOperationClassification;
  readonly kind: ClientFailureKind;
  readonly provenance: ClientFailureProvenance;
  readonly code: string;
  readonly reason: string;
  readonly retryable: boolean;
}
export interface ClientFailureOptions extends ErrorOptions {
  readonly code?: string;
  readonly reason?: string;
  readonly retryable?: boolean;
  readonly kind?: ClientFailureKind;
  readonly provenance?: ClientFailureProvenance;
}
export class ClientOperationError extends Error {
  readonly classification: ClientOperationClassification;
  readonly failure: ClientFailureOptions;
  constructor(
    message: string,
    classification: ClientOperationClassification,
    options: ClientFailureOptions = {},
  ) {
    super(message, options);
    this.name = "ClientOperationError";
    this.classification = classification;
    this.failure = options;
  }
}
export class CapabilityVerificationError extends ClientOperationError {
  readonly reason: string;
  constructor(
    verdict: "unreachable" | "superseded" | "client-too-old" | "host-too-old" | "identity-mismatch",
  ) {
    const retryable = verdict === "unreachable";
    super("Connection verification did not complete.", retryable ? "transient" : "blocked", {
      reason: verdict,
      code: "verification-failed",
      retryable,
      kind: verdict === "superseded" ? "cancelled" : retryable ? "transport" : "session",
      provenance: retryable ? "transport" : "protocol",
    });
    this.name = "CapabilityVerificationError";
    this.reason = verdict;
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
  return new ClientOperationError(message, "transient", {
    kind: "transport",
    provenance: "transport",
    reason: "timed-out",
    retryable: true,
  });
}

/** Statuses the service itself reports as temporary rather than as a refusal. */
export function transientHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function classifyClientFailure(error: unknown): ClientFailure {
  const observed = error instanceof ClientOperationError ? error.failure : {};
  const reason =
    observed.reason ?? stringField(error, "reason") ?? stringField(error, "code") ?? "unexpected";
  const code = observed.code ?? stringField(error, "code") ?? "unexpected";
  const cancelled =
    stringField(error, "name") === "AbortError" ||
    reason === "cancelled" ||
    reason === "deployment-changed" ||
    reason === "superseded";
  const provenance =
    observed.provenance ??
    failureProvenance(
      reason,
      stringField(error, "provenance"),
      stringField(error, "code") !== null,
    );
  const kind: ClientFailureKind = cancelled
    ? "cancelled"
    : (observed.kind ??
      (provenance === "transport"
        ? "transport"
        : provenance === "proxy"
          ? "service"
          : provenance === "protocol"
            ? "protocol"
            : code === "unauthorized" ||
                [
                  "unsupported-version",
                  "api-version-mismatch",
                  "client-too-old",
                  "host-too-old",
                  "identity-mismatch",
                ].includes(reason)
              ? "session"
              : provenance === "host"
                ? "rejection"
                : "unexpected"));
  const retryable =
    !cancelled &&
    (observed.retryable ??
      booleanField(error, "retryable") ??
      (error instanceof ClientOperationError ? error.classification === "transient" : false));
  return {
    classification: retryable ? "transient" : "blocked",
    kind,
    provenance,
    code,
    reason,
    retryable,
  };
}
export function failureProvenance(
  reason: string,
  explicit?: string | null,
  host = true,
): ClientFailureProvenance {
  if (
    explicit === "transport" ||
    explicit === "host" ||
    explicit === "proxy" ||
    explicit === "protocol" ||
    explicit === "local"
  )
    return explicit;
  if (reason.startsWith("transport-")) return "transport";
  if (reason === "proxy-unavailable") return "proxy";
  if (reason === "invalid-response" || reason === "unknown-method") return "protocol";
  if (reason === "invalid-payload") return "local";
  return host ? "host" : "local";
}

/** Strips credentials an upstream message may have echoed back verbatim. */
export function clientPublicDetail(error: unknown, fallback: string): string {
  const detail = error instanceof Error && error.message.trim() ? error.message.trim() : fallback;
  return detail
    .replace(/Bearer\s+[^\s]+/giu, "Bearer [redacted]")
    .replace(/os_secret_[A-Za-z0-9_-]+/gu, "os_secret_[redacted]")
    .slice(0, 2_000);
}

function booleanField(value: unknown, field: string): boolean | null {
  const candidate = readField(value, field);
  return typeof candidate === "boolean" ? candidate : null;
}

function stringField(value: unknown, field: string): string | null {
  const candidate = readField(value, field);
  return typeof candidate === "string" ? candidate : null;
}

function readField(value: unknown, field: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[field];
}
