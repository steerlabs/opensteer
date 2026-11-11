import { useEffect, useRef, useState } from "react";
import type { HostClient } from "../host/client.js";
import { useBrowserSessionGroupId, useBrowserTab } from "./use-browser-tabs.js";

/**
 * Brings forward a popup this client's own input opened, as a browser does,
 * while `tab`, the tab that opened it, is still what the person is looking at;
 * null when it is not. The news can beat the catalog, and a tab the catalog
 * does not list cannot be shown yet, so it waits there. Leaving the tab drops it.
 */
export function useBrowserPopupFollow(
  hostClient: HostClient,
  tab: { readonly sessionId: string; readonly tabId: string } | null,
  follow: (tabId: string) => void,
): void {
  const sessionId = tab?.sessionId ?? null;
  const tabId = tab?.tabId ?? null;
  const [opened, setOpened] = useState<{
    readonly openerId: string;
    readonly popupId: string;
  } | null>(null);
  useEffect(() => {
    if (sessionId === null || tabId === null) return;
    const stop = hostClient.subscribeBrowserPopups?.(sessionId, tabId, (popupId) =>
      setOpened({ openerId: tabId, popupId }),
    );
    return () => {
      stop?.();
      setOpened(null);
    };
  }, [hostClient, sessionId, tabId]);
  const popupId = opened?.openerId === tabId ? (opened?.popupId ?? null) : null;
  const groupId = useBrowserSessionGroupId(hostClient, sessionId ?? undefined);
  const listed = useBrowserTab(hostClient, groupId, popupId ?? undefined);
  const latest = useRef(follow);
  latest.current = follow;
  useEffect(() => {
    if (!listed || popupId === null) return;
    setOpened(null);
    latest.current(popupId);
  }, [listed, popupId]);
}
