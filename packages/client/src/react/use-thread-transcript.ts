import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { HostClient } from "../host/client.js";
import type { ItemTextStore } from "../host/item-text-store.js";
import { emptyThreadView } from "../host/scoped-thread-reader.js";
import { cardWithProgress, type AgentCard } from "../host/subagent-model.js";

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

/**
 * A subagent row with its engine's live progress, read from that row's own text key. Inside a
 * subagent's own steps, `nodeId` names that scope, whose store carries its children's progress.
 */
export function useLiveAgentCard(
  client: HostClient | null | undefined,
  card: AgentCard,
  nodeId?: string,
): AgentCard {
  const threadId =
    card.origin === "subagent" && card.kind === "subagent" && card.opens?.kind === "subagent"
      ? card.opens.threadId
      : undefined;
  const key = threadId ? card.key : undefined;
  const own = useItemText(threadId ? client?.getThreadItemText(threadId) : undefined, key);
  const scoped = useItemText(
    threadId && nodeId ? client?.getThreadItemText(threadId, nodeId) : undefined,
    key,
  );
  const text = (scoped ?? own)?.text;
  return useMemo(() => cardWithProgress(card, text), [card, text]);
}
