import { useCallback, useSyncExternalStore } from "react";
import type { HostClient } from "../host/client.js";
import {
  changeRunPageView,
  runPageView,
  subscribeRunPageView,
  type RunPageView,
} from "../host/run-page-memory.js";

/**
 * One conversation's Run page, shared by everything that shows it: the page
 * above the conversation and the small picture that stands for it folded.
 */
export function useRunPageView(
  hostClient: HostClient,
  threadId: string,
): readonly [RunPageView, (change: (view: RunPageView) => RunPageView) => void] {
  const subscribe = useCallback(
    (listener: () => void) => subscribeRunPageView(hostClient, threadId, listener),
    [hostClient, threadId],
  );
  const get = useCallback(() => runPageView(hostClient, threadId), [hostClient, threadId]);
  const view = useSyncExternalStore(subscribe, get, get);
  const update = useCallback(
    (change: (view: RunPageView) => RunPageView) => changeRunPageView(hostClient, threadId, change),
    [hostClient, threadId],
  );
  return [view, update] as const;
}
