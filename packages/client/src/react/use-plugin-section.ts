import { useState } from "react";
import type { ClientSession } from "../connections/connection-controller.js";
import type { KeysetPage } from "../reads/paged-list.js";
import { usePagedList } from "./use-paged-list.js";

/**
 * A plugin detail section that shows its first few rows from the detail and,
 * once the person asks for all of them, every page the Host has. Nothing is
 * read until then, so opening a plugin stays one read.
 */
export function usePluginSection<Item>(
  first: readonly Item[],
  count: number,
  read: (cursor: string | null) => Promise<KeysetPage<Item>>,
  key: string,
  session: ClientSession,
) {
  const [all, setAll] = useState(false);
  const list = usePagedList(all ? read : null, key, session);
  const loaded = all && list.first !== null;
  return {
    /** The detail's rows until the first page arrives, so expanding never blanks the section. */
    items: loaded ? list.items : first,
    all,
    /** Whether there is anything beyond the first few to show. */
    expandable: count > first.length,
    toggle: () => setAll((shown) => !shown),
    loading: all && list.loading,
    /** The next page, when the Host has one past what is shown. */
    more: loaded && list.nextCursor ? list.more : null,
    loadingMore: list.loadingMore,
    error: all ? list.error : null,
    retry: list.reload,
  };
}
