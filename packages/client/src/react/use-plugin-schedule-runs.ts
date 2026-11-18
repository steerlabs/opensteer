import type { PluginScheduledRunView } from "@opensteer/protocol";
import { CoalescedWake } from "@opensteer/shared/coalescedWake";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { HostClient } from "../host/client.js";
import { canRespondToRequests } from "../host/host-connection.js";
import { pluginChangeAffects, readPluginScheduleRuns } from "../plugins/index.js";
import { PagedList } from "../team/paged-list.js";

export function usePluginScheduleRuns(client: HostClient, pluginId: string) {
  const viewer = client.getSnapshot().user?.id;
  const list = useMemo(() => {
    const read = async (cursor: string | null) => {
      const page = await readPluginScheduleRuns(client, pluginId, cursor ?? undefined);
      return {
        items: page.pending ?? page.runs.filter(({ status }) => status === "awaiting-approval"),
        nextCursor: page.cursor ?? null,
        runs: page.runs,
      };
    };
    return new PagedList<PluginScheduledRunView, Awaited<ReturnType<typeof read>>>(read, Infinity);
  }, [client, pluginId, viewer]);
  useEffect(() => {
    const refresh = new CoalescedWake({ run: list.reload });
    refresh.wake();
    const unsubscribePlugins = client.subscribePluginsChanged((change) => {
      if (pluginChangeAffects(change, ["scheduledRuns"], pluginId)) refresh.wake();
    });
    let connected = canRespondToRequests(client.getSnapshot());
    const unsubscribe = client.subscribe(() => {
      const next = canRespondToRequests(client.getSnapshot());
      if (next && !connected) refresh.wake();
      connected = next;
    });
    return () => {
      unsubscribePlugins();
      unsubscribe();
      void refresh.stop();
    };
  }, [client, pluginId, list]);
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
