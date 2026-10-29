/** Abort-aware delays. */

export function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      rejectPromise(signal.reason);
      return;
    }
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolvePromise();
    };
    const abort = () => {
      clearTimeout(timer);
      rejectPromise(signal?.reason);
    };
    // A pending delay must never be the reason a Node process stays alive, and
    // the browser's numeric handle has nothing to unreference.
    const timer: ReturnType<typeof setTimeout> & { unref?: () => void } = setTimeout(
      finish,
      milliseconds,
    );
    timer.unref?.();
    signal?.addEventListener("abort", abort, { once: true });
  });
}
