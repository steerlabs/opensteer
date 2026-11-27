import { TestRunner } from "vitest";

/**
 * A test's wait on the product's own events, never a clock. The fixture calls `changed` where
 * something the test waits for may have changed (a call the product made settled, a row it
 * wrote, a change it published); `until` returns `check`'s value once it passes, checking again
 * after each such event. The test's own end (its timeout) ends the wait with the check's last
 * failure, so nothing is lengthened and no second of wall time is spent waiting for it.
 */
export function eventWait() {
  let change = Promise.withResolvers<void>();
  const changed = () => {
    const previous = change;
    change = Promise.withResolvers<void>();
    previous.resolve();
  };
  const until = async <T>(check: () => T | Promise<T>): Promise<T> => {
    const signal = TestRunner.getCurrentTest()?.context.signal;
    for (;;) {
      const next = change.promise;
      try {
        return await check();
      } catch (error) {
        if (!signal || signal.aborted) throw error;
        const ended = Promise.withResolvers<never>();
        const abort = () => ended.reject(error);
        signal.addEventListener("abort", abort, { once: true });
        try {
          await Promise.race([next, ended.promise]);
        } finally {
          signal.removeEventListener("abort", abort);
        }
      }
    }
  };
  return { changed, until };
}
