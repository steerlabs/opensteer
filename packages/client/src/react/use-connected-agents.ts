import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { HostClient } from "../host/client.js";
import { connectedAgentsClient, type ConnectedAgentsSnapshot } from "../host/connected-agents.js";
import {
  readAgentAppOptions,
  readAgentPluginOptions,
  type AppOption,
  type PluginOptions,
} from "../host/connected-agent-options.js";
import { agentWords } from "../host/connected-agents-copy.js";
const empty: ConnectedAgentsSnapshot = {
  connections: null,
  error: null,
  issue: null,
  pending: null,
  pendingAction: null,
  revoked: new Set(),
  conflict: null,
  grantsAvailable: false,
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
  return {
    ...state,
    refresh: resource?.refresh,
    revoke: resource?.revoke,
    update: resource?.update,
    remove: resource?.remove,
    dismiss: resource?.dismiss,
  };
}

/** A list read only once the person opens it; `null` data until then. */
export type AgentOptionsRead<T> =
  | { readonly status: "idle" | "loading" }
  | { readonly status: "ready"; readonly data: T }
  | { readonly status: "failed"; readonly error: string; readonly retry: () => void };

function useLazyRead<T>(
  client: HostClient | null,
  wanted: boolean,
  read: (client: HostClient, signal: AbortSignal) => Promise<T>,
): AgentOptionsRead<T> {
  const [state, setState] = useState<AgentOptionsRead<T>>({ status: "idle" });
  const [attempt, setAttempt] = useState(0);
  const loaded = state.status === "ready";
  useEffect(() => {
    if (!client || !wanted || loaded) return;
    const controller = new AbortController();
    setState({ status: "loading" });
    read(client, controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ status: "ready", data });
      },
      () => {
        if (!controller.signal.aborted)
          setState({
            status: "failed",
            error: agentWords("consent.edge.listFailed"),
            retry: () => setAttempt((n) => n + 1),
          });
      },
    );
    return () => controller.abort();
  }, [client, wanted, loaded, attempt, read]);
  return state;
}

/** Apps and phone screens approved on the person's Devices, read when `wanted` first holds. */
export function useAgentAppOptions(
  client: HostClient | null,
  wanted: boolean,
): AgentOptionsRead<readonly AppOption[]> {
  return useLazyRead(client, wanted, readAgentAppOptions);
}

/** Installed plugins, local servers and device data accounts, read when `wanted` first holds. */
export function useAgentPluginOptions(
  client: HostClient | null,
  wanted: boolean,
): AgentOptionsRead<PluginOptions> {
  return useLazyRead(client, wanted, readAgentPluginOptions);
}
