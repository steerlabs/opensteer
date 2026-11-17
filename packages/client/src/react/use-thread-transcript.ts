import { useCallback, useSyncExternalStore } from "react";
import type { HostClient } from "../host/client.js";
import type { ItemTextStore } from "../host/item-text-store.js";
import { emptyThreadView } from "../host/scoped-thread-reader.js";

export function useThreadTranscript(
  client: HostClient | null,
  threadId: string | null | undefined,
  observed = true,
) {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!client || !threadId) return () => {};
      const release = observed ? client.observeThread(threadId) : undefined;
      const unsubscribe = client.getThreadTranscript(threadId)?.subscribe(listener);
      return () => {
        unsubscribe?.();
        release?.();
      };
    },
    [client, observed, threadId],
  );
  const read = useCallback(
    () =>
      (threadId ? client?.getThreadTranscript(threadId)?.getSnapshot() : undefined) ??
      emptyThreadView,
    [client, threadId],
  );
  return useSyncExternalStore(subscribe, read, read);
}

export function useItemText(store: ItemTextStore | undefined, itemId: string | undefined) {
  const subscribe = useCallback(
    (listener: () => void) => (store && itemId ? store.subscribe(itemId, listener) : () => {}),
    [store, itemId],
  );
  const read = useCallback(() => (itemId ? store?.get(itemId) : undefined), [store, itemId]);
  return useSyncExternalStore(subscribe, read, read);
}
