import type { HostClient } from "@opensteer/client/host";
import { useMemo, useSyncExternalStore } from "react";
import type { OpenTabSuggestion } from "./address-bar.js";
import { pageSite } from "./surface-route.js";

export function tabSuggestions(client: HostClient, groupId: string) {
  const store = client.browserTabs;
  let ids: readonly string[] | undefined;
  let revision = -1;
  let observing = false;
  let rows: readonly OpenTabSuggestion[] = [];
  let indices = new Map<string, number>();
  const dirty = new Set<string>();
  const row = (id: string): OpenTabSuggestion => {
    const tab = store.tab(groupId, id)!;
    return {
      favicon: client.browserViewerSurface(tab.sessionId, id)?.favicon ?? null,
      id,
      site: pageSite(tab.site),
      title: tab.title || pageSite(tab.site) || "New tab",
    };
  };
  const read = () => {
    const list = store.tabs(groupId).ids;
    const nextRevision = store.tabRevision(groupId);
    if (list !== ids || (!observing && revision !== nextRevision)) {
      ids = list;
      rows = ids.map(row);
      indices = new Map(ids.map((id, index) => [id, index]));
    } else if (dirty.size) {
      let next: OpenTabSuggestion[] | undefined;
      for (const id of dirty) {
        const index = indices.get(id);
        if (index === undefined) continue;
        const value = row(id);
        const before = rows[index]!;
        if (
          value.title === before.title &&
          value.site === before.site &&
          value.favicon === before.favicon
        )
          continue;
        next ??= [...rows];
        next[index] = value;
      }
      if (next) rows = next;
    }
    dirty.clear();
    revision = nextRevision;
    return rows;
  };
  const subscribe = (listener: () => void) => {
    read();
    observing = true;
    const changes = store.subscribeTabChanges((id, changed) => {
      if (id !== groupId) return;
      for (const key of changed) dirty.add(key);
      listener();
    });
    const structure = store.subscribeTabs(groupId, listener);
    return () => {
      observing = false;
      changes();
      structure();
    };
  };
  return { read, subscribe };
}

const noSuggestions: readonly OpenTabSuggestion[] = [];
const inactive = { read: () => noSuggestions, subscribe: () => () => {} };
export function useTabSuggestions(client: HostClient, groupId: string, enabled = true) {
  const selection = useMemo(
    () => (enabled ? tabSuggestions(client, groupId) : inactive),
    [client, groupId, enabled],
  );
  return useSyncExternalStore(selection.subscribe, selection.read, selection.read);
}
