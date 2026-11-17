import { useCallback, useSyncExternalStore } from "react";
import type { ItemTextStore } from "../host/item-text-store.js";
import type { ThreadTranscriptStore } from "../host/thread-transcript-store.js";

export function useThreadTranscript(store: ThreadTranscriptStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function useItemText(store: ItemTextStore, itemId: string) {
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(itemId, listener),
    [store, itemId],
  );
  const read = useCallback(() => store.get(itemId), [store, itemId]);
  return useSyncExternalStore(subscribe, read, read);
}
