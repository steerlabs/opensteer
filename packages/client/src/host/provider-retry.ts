import type { RunRetry } from "@opensteer/core";

function formatRetryDelay(ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/** Short status label for a Run currently waiting on a provider retry. */
export function providerRetryLabel(retry: RunRetry): string {
  if (typeof retry.maxAttempts === "number" && retry.maxAttempts > 0) {
    return `Retrying (${retry.attempt}/${retry.maxAttempts})`;
  }
  return `Retrying (attempt ${retry.attempt})`;
}

/** Human-readable detail for a provider retry notice, including scheduled retry delay when known. */
export function providerRetryDetail(retry: RunRetry): string {
  const message = retry.message.trim() || "Provider is retrying";
  if (typeof retry.retryDelayMs === "number" && retry.retryDelayMs > 0) {
    return `${message} · ${formatRetryDelay(retry.retryDelayMs)} retry delay`;
  }
  return message;
}
