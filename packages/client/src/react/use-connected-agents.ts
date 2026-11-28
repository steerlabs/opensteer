import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { readTaskActivity } from "../host/agent-work.js";
import type { AgentOperationView } from "@opensteer/core";
import type { HostClient, HostSnapshot } from "../host/client.js";
import {
  connectedAgentActivity,
  connectedAgentLive,
  connectedAgentWorkingTasks,
  type ConnectedAgentActivity,
} from "../host/connected-agent-view.js";
import { unwrapRpcResult } from "../host/host-session-client.js";
import { useHostSelector } from "./use-host-snapshot.js";
import { shownOperations } from "../host/approved-app-names.js";
import { useApprovedAppNames } from "./use-approved-app-names.js";
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
  readFailed: false,
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

const selectActiveTasks = (snapshot: HostSnapshot) => snapshot.activeTasks;
const selectThreads = (snapshot: HostSnapshot) => snapshot.threads;
const selectTaskList = (snapshot: HostSnapshot) => snapshot.tasks;

/**
 * The tasks as the Home's live task updates hold them (`threadInDirectory` reads it): a chat's
 * page reads from it whether its tasks run, so a Stop ends when the Run does, with no poll.
 */
export function useLiveTasks(
  client: HostClient,
): Pick<HostSnapshot, "threads" | "tasks" | "activeTasks"> {
  const threads = useHostSelector(client, selectThreads);
  const tasks = useHostSelector(client, selectTaskList);
  const activeTasks = useHostSelector(client, selectActiveTasks);
  return useMemo(() => ({ threads, tasks, activeTasks }), [threads, tasks, activeTasks]);
}

export function useConnectedAgentLive(client: HostClient, connectionId: string) {
  const tasks = useHostSelector(client, selectActiveTasks);
  const working = connectedAgentWorkingTasks(connectionId, tasks);
  const sessions = working.length
    ? working
        .map(({ thread }) => thread.externalWork?.sessionId)
        .sort()
        .join(",")
    : null;
  const [result, setResult] = useState<{
    client: HostClient;
    connectionId: string;
    sessions: string;
    operations: readonly AgentOperationView[];
  }>();
  useEffect(() => {
    if (sessions === null) return;
    const controller = new AbortController();
    void client.rpc["connections.activity"]({ connectionId }, { signal: controller.signal })
      .then(unwrapRpcResult)
      .then(({ operations }) => {
        if (!controller.signal.aborted) setResult({ client, connectionId, sessions, operations });
      })
      .catch(() => {});
    return () => controller.abort();
  }, [client, connectionId, sessions]);
  return connectedAgentLive(
    working,
    sessions !== null &&
      result?.client === client &&
      result.connectionId === connectionId &&
      result.sessions === sessions
      ? result.operations
      : undefined,
  );
}

/**
 * A connection's Recent activity: its operations and the commands it sent, in one list. Absent
 * while it loads; unavailable when this Home cannot list it.
 */
export function useConnectedAgentActivity(
  client: HostClient,
  connectionId: string,
  /** Read again when this changes: the task the agent is working on, for one. */
  revision: string | null,
): ConnectedAgentActivity | undefined {
  const [result, setResult] = useState<{
    client: HostClient;
    key: string;
    page: Parameters<typeof connectedAgentActivity>[0] | null;
  }>();
  const key = `${connectionId}:${revision ?? ""}`;
  useEffect(() => {
    const controller = new AbortController();
    const receive = (page: Parameters<typeof connectedAgentActivity>[0] | null) => {
      if (!controller.signal.aborted) setResult({ client, key, page });
    };
    void client.rpc["connections.activity"]({ connectionId }, { signal: controller.signal })
      .then(unwrapRpcResult)
      .then(receive, () => receive(null));
    return () => controller.abort();
  }, [client, connectionId, key]);
  const current = result?.client === client && result.key === key ? result : undefined;
  // The person reads Recent activity: a Mac app there goes by the name they approved.
  const names = useApprovedAppNames(
    client,
    current?.page?.operations.map(({ target }) => target) ?? [],
  );
  return useMemo(
    () =>
      current === undefined
        ? undefined
        : current.page === null
          ? { kind: "unavailable" as const }
          : connectedAgentActivity({
              ...current.page,
              operations: shownOperations(current.page.operations, names),
            }),
    [current, names],
  );
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
  const operations =
    revision !== null && result?.client === client && result.threadId === threadId
      ? result.operations
      : undefined;
  // The person watches this task: a Mac app in its activity goes by the name they approved.
  const names = useApprovedAppNames(client, operations?.map(({ target }) => target) ?? []);
  return useMemo(
    () => (operations ? shownOperations(operations, names) : undefined),
    [operations, names],
  );
}
