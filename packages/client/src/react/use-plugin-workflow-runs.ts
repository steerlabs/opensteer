import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { HostClient } from "../host/client.js";
import { canRespondToRequests } from "../host/host-connection.js";
import { pluginChangeAffects, readPluginWorkflowRuns } from "../plugins/index.js";
import { PluginWorkflowRuns } from "../plugins/runs.js";

/**
 * One plugin's workflow runs, read with the plugin's page and kept current:
 * again on `host.plugins-changed` and on reconnecting. It reads even when the
 * current version declares no workflows, since runs outlive declarations.
 */
export function usePluginWorkflowRuns(
  client: Pick<
    HostClient,
    "rpc" | "dispatch" | "subscribe" | "getSnapshot" | "subscribePluginsChanged"
  >,
  pluginId: string,
) {
  const runs = useMemo(
    () =>
      new PluginWorkflowRuns((cursor, ids) =>
        readPluginWorkflowRuns(client, pluginId, cursor ?? undefined, ids),
      ),
    [client, pluginId],
  );
  useEffect(() => {
    void runs.refresh();
    const unsubscribePlugins = client.subscribePluginsChanged((change) => {
      if (pluginChangeAffects(change, ["workflowRuns"], pluginId)) void runs.refresh();
    });
    let connected = canRespondToRequests(client.getSnapshot());
    const unsubscribe = client.subscribe(() => {
      const next = canRespondToRequests(client.getSnapshot());
      if (next && !connected) void runs.refresh();
      connected = next;
    });
    return () => {
      unsubscribePlugins();
      unsubscribe();
      runs.dispose();
    };
  }, [client, pluginId, runs]);
  const state = useSyncExternalStore(runs.subscribe, runs.getState, runs.getState);
  return { ...state, showMore: () => void runs.showMore(), retry: () => void runs.refresh() };
}
