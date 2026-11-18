import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { HostClient } from "../host/client.js";
import { connectedAgentsClient, type ConnectedAgentsSnapshot } from "../host/connected-agents.js";
const empty: ConnectedAgentsSnapshot = {
  connections: null,
  error: null,
  issue: null,
  pending: null,
};
const detachedSubscribe = () => () => {};
const detachedSnapshot = () => empty;

/** Mounted only by Settings; construction and normal Host attachment perform no reads. */
export function useConnectedAgents(client: HostClient | null) {
  const resource = useMemo(() => (client ? connectedAgentsClient(client) : null), [client]);
  useEffect(() => resource?.start(), [resource]);
  const state = useSyncExternalStore(
    resource?.subscribe ?? detachedSubscribe,
    resource?.getSnapshot ?? detachedSnapshot,
    resource?.getSnapshot ?? detachedSnapshot,
  );
  return { ...state, refresh: resource?.refresh, revoke: resource?.revoke };
}
