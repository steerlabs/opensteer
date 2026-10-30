/** Promise deadlines with optional cancellation. */

interface TimeoutOptions {
  readonly abortFallback?: string;
  readonly signal?: AbortSignal;
  readonly timeoutError: () => Error;
}

export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  options: TimeoutOptions,
): Promise<T> {
  const { signal } = options;
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error(options.abortFallback ?? "Operation aborted");
  }
  let timer: (ReturnType<typeof setTimeout> & { unref?: () => void }) | undefined;
  let relayAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolvePromise, rejectPromise) => {
        timer = setTimeout(() => rejectPromise(options.timeoutError()), timeoutMs);
        timer.unref?.();
        if (signal) {
          relayAbort = () =>
            rejectPromise(
              signal.reason instanceof Error
                ? signal.reason
                : new Error(options.abortFallback ?? "Operation aborted"),
            );
          signal.addEventListener("abort", relayAbort, { once: true });
        }
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && relayAbort) signal.removeEventListener("abort", relayAbort);
  }
}
