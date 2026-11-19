import { useEffect, useSyncExternalStore } from "react";

/**
 * Which teammates' asks stand whole on screen: their full text read, and not folded away. The
 * ask's bubble says so; the dock's Answer, elsewhere on screen, approves only what it said.
 */
const shown = new Set<string>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function set(messageId: string, whole: boolean) {
  if (shown.has(messageId) === whole) return;
  if (whole) shown.add(messageId);
  else shown.delete(messageId);
  for (const listener of listeners) listener();
}

/** The bubble of ask `messageId` reports whether it shows the whole ask, until it leaves. */
export function useShowAsk(messageId: string | null, whole: boolean) {
  useEffect(() => {
    if (messageId === null) return;
    set(messageId, whole);
    return () => set(messageId, false);
  }, [messageId, whole]);
}

/** Whether ask `messageId` stands whole on screen. */
export function useAskShownWhole(messageId: string) {
  return useSyncExternalStore(
    subscribe,
    () => shown.has(messageId),
    () => shown.has(messageId),
  );
}
