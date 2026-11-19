import { useCallback, useSyncExternalStore } from "react";
import type { HostClient } from "../host/client.js";
import { useHostRead } from "./use-host-read.js";

export function useTranscriptBody(input: {
  readonly client: HostClient | null | undefined;
  readonly threadId: string | null | undefined;
  readonly itemId: string | undefined;
  readonly nodeId?: string | undefined;
  readonly revision?: string | undefined;
  readonly generation?: number | undefined;
  readonly enabled: boolean;
}) {
  const { client, itemId, threadId, nodeId, enabled, generation, revision } = input;
  const read = useCallback(async () => {
    const body = await client!.readTranscriptItem(threadId!, itemId!, nodeId);
    if (client!.getCachedTranscriptItem) return null;
    return body ?? null;
  }, [client, itemId, threadId, nodeId]);
  const subscribe = useCallback(
    (listener: () => void) =>
      enabled && threadId && itemId
        ? (client?.subscribeTranscriptBody?.(threadId, itemId, nodeId, listener) ?? (() => {}))
        : () => {},
    [client, itemId, threadId, nodeId, enabled, generation],
  );
  const cached = useCallback(() => {
    const value =
      enabled && threadId && itemId
        ? client?.getCachedTranscriptItem?.(threadId, itemId, nodeId)
        : undefined;
    return !revision || value?.item.revision === revision ? (value ?? null) : null;
  }, [client, itemId, threadId, nodeId, enabled, revision]);
  const data = useSyncExternalStore(subscribe, cached, cached);
  const load = useHostRead(
    enabled && !!client && !!threadId && !!itemId ? read : null,
    JSON.stringify([threadId, nodeId, itemId, revision, generation]),
    client ?? null,
  );
  return { ...load, data: data ?? load.data };
}
