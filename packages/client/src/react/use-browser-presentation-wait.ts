import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { HostClient } from "../host/client.js";
import {
  BrowserPresentationWait,
  browserOpeningTimeoutMs,
  browserPresentationTimeoutMessage,
} from "../host/browser-presentation-wait.js";

export function useBrowserPresentationWait(
  client: Pick<HostClient, "browserPresentationDeadline" | "markBrowserPagePresented">,
  sessionId: string,
  tabId: string,
  active: boolean,
) {
  const wait = useMemo(
    () =>
      new BrowserPresentationWait(
        client.browserPresentationDeadline?.(sessionId, tabId) ??
          Date.now() + browserOpeningTimeoutMs,
      ),
    [client, sessionId, tabId],
  );
  const state = useSyncExternalStore(wait.subscribe, wait.getSnapshot, wait.getSnapshot);
  useEffect(() => {
    if (active) wait.start();
    return () => wait.dispose();
  }, [active, wait]);
  const presented = useCallback(() => {
    if (!active || !wait.presented()) return false;
    client.markBrowserPagePresented?.(sessionId, tabId);
    return true;
  }, [active, client, sessionId, tabId, wait]);
  return {
    error: active && state === "expired" ? browserPresentationTimeoutMessage : null,
    presented,
    retry: wait.retry,
  };
}
