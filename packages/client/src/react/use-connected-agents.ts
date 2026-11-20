import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { readTaskActivity } from "../host/agent-work.js";
import type { AgentOperationView } from "@opensteer/core";
import type { HostClient } from "../host/client.js";
import { connectedAgentsClient, type ConnectedAgentsSnapshot } from "../host/connected-agents.js";
import {
  readChromeTabGrantCatalog,
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
  const [result, setResult] = useState<{ client: HostClient; state: AgentOptionsRead<T> }>();
  const state = result?.client === client ? result.state : { status: "idle" as const };
  const [attempt, setAttempt] = useState(0);
  const loaded = state.status === "ready";
  useEffect(() => {
    if (!client || !wanted || loaded) return;
    const controller = new AbortController();
    const receive = (state: AgentOptionsRead<T>) => {
      if (!controller.signal.aborted) setResult({ client, state });
    };
    receive({ status: "loading" });
    read(client, controller.signal).then(
      (data) => receive({ status: "ready", data }),
      () =>
        receive({
          status: "failed",
          error: agentWords("consent.edge.listFailed"),
          retry: () => setAttempt((n) => n + 1),
        }),
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

export function useChromeTabGrantCatalog(client: HostClient | null, wanted: boolean) {
  const result = useLazyRead(client, wanted, readChromeTabGrantCatalog);
  return result.status === "ready" ? result.data : undefined;
}

export function useTaskActivity(
  client: HostClient | null,
  threadId: string,
  revision: string | null,
) {
  const [result, setResult] = useState<{
    client: HostClient;
    threadId: string;
    operations: readonly AgentOperationView[] | undefined;
  }>();
  useEffect(() => {
    if (!client || revision === null) return;
    const controller = new AbortController();
    const receive = (operations?: readonly AgentOperationView[]) => {
      if (!controller.signal.aborted) setResult({ client, threadId, operations });
    };
    void readTaskActivity(client, threadId, controller.signal).then(receive, () => receive());
    return () => controller.abort();
  }, [client, threadId, revision]);
  return revision !== null && result?.client === client && result.threadId === threadId
    ? result.operations
    : undefined;
}
