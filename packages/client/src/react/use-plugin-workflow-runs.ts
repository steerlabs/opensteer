import { useCallback, useMemo, useSyncExternalStore } from "react";
import { clientScopeKey } from "../connections/connection-controller.js";
import type { HostClient } from "../host/client.js";
import { pluginChangeAffects, readPluginWorkflowRuns } from "../plugins/index.js";
import { PluginWorkflowRuns } from "../plugins/runs.js";
import { createClientRead } from "../reads/client-read.js";
import { useClientRead } from "./use-client-read.js";

/** Live runs and the requested pages stay visible while their Host reconnects. */
export function usePluginWorkflowRuns(
  client: Pick<HostClient, "rpc" | "dispatch" | "connection" | "subscribePluginsChanged">,
  pluginId: string,
) {
  const readScope = useCallback(
    () => clientScopeKey(client.connection.getSnapshot().scope),
    [client],
  );
  const scope = useSyncExternalStore(client.connection.subscribe, readScope, readScope);
  const owner = useMemo(() => {
    const runs = new PluginWorkflowRuns((cursor, ids) =>
      readPluginWorkflowRuns(client, pluginId, cursor ?? undefined, ids),
    );
    let more = false;
    const resource = createClientRead(client, {
      key: `workflow-runs:${pluginId}`,
      label: "this plugin's workflow runs",
      scopeKey: scope,
      read: async (signal) => {
        const append = more;
        more = false;
        if (append) await runs.showMore(signal);
        else await runs.refresh(signal);
        signal.throwIfAborted();
        const state = runs.getState();
        if (state.error !== null) throw state.error;
        return state;
      },
      subscribeInvalidation: (invalidate) =>
        client.subscribePluginsChanged((change) => {
          if (pluginChangeAffects(change, ["workflowRuns"], pluginId)) invalidate();
        }),
    });
    return {
      runs,
      resource,
      showMore: () => {
        if (runs.getState().loadingMore) return;
        more = true;
        void resource.refresh();
      },
    };
  }, [client, pluginId, scope]);
  const view = useClientRead(owner.resource);
  const state = useSyncExternalStore(
    owner.runs.subscribe,
    owner.runs.getState,
    owner.runs.getState,
  );
  return {
    ...state,
    error: view.issue,
    showMore: owner.showMore,
    retry: view.refresh,
  };
}
