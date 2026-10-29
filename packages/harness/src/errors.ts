import { OpensteerError } from "@opensteer/core";

/**
 * A steering transport failed after the adapter handed the message to the
 * provider connection, so the provider may already have accepted it. Callers
 * must not retry the message or restore it to a future turn.
 *
 * This is deliberately separate from OpensteerError: its meaning is delivery
 * disposition, not a provider-facing error code or retry recommendation.
 */
export class HarnessSteerDeliveryUnknownError extends Error {
  override readonly name = "HarnessSteerDeliveryUnknownError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/**
 * Normalizes an unknown throw into the Runner's error vocabulary. A failure
 * the driver already described keeps its own code, message and retryability;
 * anything else becomes a harness failure named by the operation that was
 * under way, because a bare provider message ("ECONNRESET") says nothing about
 * what Opensteer was doing.
 */
export function toHarnessError(error: unknown, fallback: string): OpensteerError {
  if (error instanceof OpensteerError) return error;
  return new OpensteerError({
    cause: error,
    code: "harness_error",
    message: error instanceof Error ? `${fallback}: ${error.message}` : fallback,
  });
}

/**
 * The same normalization for a provider SDK that reports transport conditions
 * as prose rather than as a code. The message is the only evidence there is,
 * so a deadline and an overloaded upstream are read out of it and the
 * provider's own wording is kept intact instead of being prefixed — the caller
 * is expected to be showing that wording to a person.
 */
export function toHarnessTransportError(error: unknown, fallback: string): OpensteerError {
  if (error instanceof OpensteerError) return error;
  const message = error instanceof Error ? error.message : fallback;
  const lower = message.toLowerCase();
  const timeout = lower.includes("timeout") || lower.includes("timed out");
  return new OpensteerError({
    cause: error,
    code: timeout ? "timeout" : "harness_error",
    message,
    retryable: timeout || lower.includes("rate limit") || lower.includes("overload"),
  });
}
