import type { ClientSession } from "../connections/connection-controller.js";
import { useMemo, useRef, useSyncExternalStore } from "react";
import { PagedList, type PagedListState, type KeysetPage } from "../team/paged-list.js";

const idle: PagedListState<never, never> = {
  first: null,
  items: [],
  nextCursor: null,
  loading: false,
  loadingMore: false,
  error: null,
  capped: false,
};
const noSubscribe = () => () => {};

/**
 * A paged team list for one screen. A new `key` (a change of person, a
 * committed command, a new search) starts over from the first page.
 */
export function usePagedList<First extends KeysetPage<unknown>>(
  read: ((cursor: string | null) => Promise<First>) | null,
  key: string,
  session: ClientSession | null,
) {
  const readRef = useRef(read);
  readRef.current = read;
  const enabled = read !== null;
  const list = useMemo(
    () =>
      enabled && session
        ? new PagedList<First["items"][number], First>(session, (cursor) =>
            readRef.current!(cursor),
          )
        : null,
    [enabled, key, session],
  );
  const state = useSyncExternalStore(
    list?.subscribe ?? noSubscribe,
    list?.getState ?? (() => idle as PagedListState<First["items"][number], First>),
    list?.getState ?? (() => idle as PagedListState<First["items"][number], First>),
  );
  return {
    ...state,
    loading: enabled && (state.loading || state.first === null) && state.error === null,
    more: () => void list?.more(),
    reload: () => void list?.reload(),
  };
}
