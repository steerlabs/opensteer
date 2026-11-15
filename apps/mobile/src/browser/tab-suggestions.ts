import type { HostClient, TabsReadModel } from "@opensteer/client/host";
import { useMemo, useSyncExternalStore } from "react";
import { layoutTabIds } from "../tabs/tab-entries.js";
import { useTabsModel } from "../tabs/use-tabs.js";
import type { OpenTabSuggestion } from "./address-bar.js";
import { pageSite } from "./surface-route.js";

/**
 * The open pages the address bar offers to switch to, in the one list's
 * order. Rows keep their identity until their own title or site changes, so
 * typing over a page redraws only what changed.
 */
export function tabSuggestions(model: TabsReadModel) {
  let rows: readonly OpenTabSuggestion[] = [];
  let byId = new Map<string, OpenTabSuggestion>();
  // While subscribed, only a notified change rebuilds; unsubscribed reads always do.
  let observing = false;
  let stale = true;
  const read = () => {
    if (observing && !stale) return rows;
    stale = false;
    const next: OpenTabSuggestion[] = [];
    const nextById = new Map<string, OpenTabSuggestion>();
    let changed = false;
    for (const tabId of layoutTabIds(model.layout)) {
      const tab = model.get(tabId);
      if (tab?.kind !== "page") continue;
      const site = pageSite(tab.url ?? "");
      const title = tab.title || site || "New tab";
      const before = byId.get(tabId);
      const row =
        before !== undefined && before.title === title && before.site === site
          ? before
          : { favicon: null, id: tabId, site, title };
      changed ||= row !== rows[next.length];
      next.push(row);
      nextById.set(tabId, row);
    }
    byId = nextById;
    if (changed || next.length !== rows.length) rows = next;
    return rows;
  };
  const subscribe = (listener: () => void) => {
    observing = true;
    stale = true;
    const stop = model.subscribe(() => {
      stale = true;
      listener();
    });
    return () => {
      observing = false;
      stop();
    };
  };
  return { read, subscribe };
}

const noSuggestions: readonly OpenTabSuggestion[] = [];
const inactive = { read: () => noSuggestions, subscribe: () => () => {} };
export function useTabSuggestions(client: HostClient, enabled = true) {
  const model = useTabsModel(client);
  const selection = useMemo(
    () => (enabled && model !== null ? tabSuggestions(model) : inactive),
    [enabled, model],
  );
  return useSyncExternalStore(selection.subscribe, selection.read, selection.read);
}
