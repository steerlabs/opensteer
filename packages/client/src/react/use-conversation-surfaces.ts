import { useMemo, useSyncExternalStore } from "react";
import type { HostClient, HostSnapshot } from "../host/client.js";
import { conversationSurfaces, sameConversationSurfaceSource } from "../host/surfaces.js";
import { useHostSelector } from "./use-host-snapshot.js";

const selectSource = (snapshot: HostSnapshot) => snapshot;

export function useConversationSurfaces(hostClient: HostClient, threadId: string | null) {
  const revision = useSyncExternalStore(
    hostClient.browserTabs.subscribe,
    () => hostClient.browserTabs.revision,
  );
  const source = useHostSelector(hostClient, selectSource, sameConversationSurfaceSource);
  return useMemo(
    () => (threadId === null ? [] : conversationSurfaces(source, threadId)),
    [source, threadId, revision],
  );
}
