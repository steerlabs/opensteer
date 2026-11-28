import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { TabId } from "@opensteer/core";
import type { TabViewer } from "@opensteer/protocol";
import type { HostClient, HostSnapshot } from "../host/client.js";
import { OwnerViewReconnect } from "../integrations/owner-view-reconnect.js";
import { useHostSelector } from "./use-host-snapshot.js";

const account = ({ deploymentId, session, user }: HostSnapshot) =>
  session === "authenticated" && user ? JSON.stringify([deploymentId, user.id]) : null;

export function useOwnerViewReconnect(
  hostClient: HostClient,
  tabId: TabId | null,
  opened?: (viewer: TabViewer) => void,
) {
  const identity = useHostSelector(hostClient, account);
  const accepted = useRef(opened);
  accepted.current = opened;
  const reconnect = useMemo(
    () =>
      new OwnerViewReconnect(
        (signal) => {
          if (tabId === null || identity === null || identity !== account(hostClient.getSnapshot()))
            throw new Error("The owner view is no longer selected under this account.");
          return hostClient.activateTab(tabId, { signal });
        },
        (viewer) => accepted.current?.(viewer),
      ),
    [hostClient, identity, tabId],
  );
  useLayoutEffect(() => () => reconnect.reset(), [reconnect]);
  const state = useSyncExternalStore(reconnect.subscribe, reconnect.getSnapshot);
  return {
    state,
    reset: reconnect.reset,
    getSnapshot: reconnect.getSnapshot,
    observe: tabId !== null && identity !== null ? reconnect.observe : undefined,
    picture: reconnect.picture,
    removed: tabId !== null && identity !== null ? reconnect.removed : undefined,
  };
}

/** Keep the removal reason even if the owner projection arrives before the last frame. */
export function useOwnerViewRemoval(
  hostClient: HostClient,
  viewId: string,
  generation: number,
  removed: OwnerViewReconnect["removed"] | undefined,
): void {
  const last = useRef({ removed, viewId, generation });
  if (viewId || last.current.removed !== removed) last.current = { removed, viewId, generation };
  const { viewId: heldId, generation: heldGeneration } = last.current;
  useLayoutEffect(() => {
    if (!heldId || !removed) return;
    return hostClient.subscribeComputerViewRemoved?.((view) => {
      if (view.viewId === heldId && view.generation === heldGeneration)
        removed(
          { kind: "owner-view", viewId: heldId, generation: heldGeneration },
          view.displayReason,
        );
    });
  }, [heldGeneration, heldId, hostClient, removed]);
}
