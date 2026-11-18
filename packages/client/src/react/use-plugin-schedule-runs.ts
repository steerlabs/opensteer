import type { PluginScheduledRunView } from "@opensteer/protocol";
import { useMemo, useSyncExternalStore } from "react";
import type { HostClient } from "../host/client.js";
import { pluginChangeAffects, readPluginScheduleRuns } from "../plugins/index.js";
import { PagedList } from "../team/paged-list.js";

export function usePluginScheduleRuns(client: HostClient, pluginId: string) {
  const list = useMemo(() => {
    const read = async (cursor: string | null) => {
      const page = await readPluginScheduleRuns(client, pluginId, cursor ?? undefined);
      return {
        items: page.pending ?? page.runs.filter(({ status }) => status === "awaiting-approval"),
        nextCursor: page.cursor ?? null,
        runs: page.runs,
      };
    };
    return new PagedList<PluginScheduledRunView, Awaited<ReturnType<typeof read>>>(
      client,
      read,
      Infinity,
      (invalidate) =>
        client.subscribePluginsChanged((change) => {
          if (pluginChangeAffects(change, ["scheduledRuns"], pluginId)) invalidate();
        }),
    );
  }, [client, pluginId]);
  const state = useSyncExternalStore(list.subscribe, list.getState, list.getState);
  return {
    pending: state.items,
    recent:
      state.first?.runs.filter(({ status }) => status !== "awaiting-approval").slice(0, 5) ?? [],
    loaded: state.first !== null,
    error: state.error,
    more: state.nextCursor !== null,
    loadingMore: state.loadingMore,
    showMore: list.more,
    reload: list.reload,
  };
}
