import { useEffect, useState } from "react";

/** How long a syncing list with no rows waits before it shows its skeleton. */
export const syncingPlaceholderDelayMs = 400;

/**
 * Whether a list shows its loading skeleton: only while it is syncing with no
 * rows, and only once that has lasted `syncingPlaceholderDelayMs`. Rows that
 * are there are never covered, and a quick sync never flashes a skeleton.
 */
export function useSyncingPlaceholder(syncing: boolean, rows: number): boolean {
  const waiting = syncing && rows === 0;
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!waiting) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), syncingPlaceholderDelayMs);
    return () => clearTimeout(timer);
  }, [waiting]);
  return waiting && shown;
}
