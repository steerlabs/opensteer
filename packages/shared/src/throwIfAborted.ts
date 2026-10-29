/** Abort-reason propagation. */

export function throwIfAborted(signal: AbortSignal, fallbackMessage: string): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error(fallbackMessage);
}
