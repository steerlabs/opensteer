import { useLayoutEffect, useRef } from "react";
import {
  placeDestinationEnded,
  tabSuccessor,
  type HostClient,
  type HostSnapshot,
  type TabDestination,
  type TabStrip,
} from "@opensteer/client/host";
import {
  useBrowserPopupFollow,
  useHostSelector,
  useTabStrip,
  useTabsSyncing,
} from "@opensteer/client/react";
import { placeAddress } from "./navigation.js";
import { useWorkspace } from "./workspace-context.js";

/**
 * One rule for the tab in the middle going away, whoever closed it — ×, a
 * menu, ⌘W, an agent, another device: its neighbour takes its history entry.
 * An unavailable tab stays, saying why. Only a tab that was listed while shown
 * can end; an address that never was (a typed or old link) keeps its ended
 * state, and a catalog still syncing proves nothing.
 */
export function usePlaceSuccession(hostClient: HostClient): void {
  const { nav, selection } = useWorkspace();
  const strip = useTabStrip(hostClient);
  const syncing = useTabsSyncing(hostClient);
  const known = useHostSelector(hostClient, selectPlacesKnown) && !syncing;
  const viewer = useHostSelector(hostClient, selectViewer);
  const shown = useRef<{
    readonly address: string;
    readonly viewer: string;
    readonly strip: TabStrip;
  } | null>(null);
  const destination = selection.kind === "place" ? selection.destination : null;
  const tabId = destination?.tabId ?? null;
  const pageSession = useHostSelector(hostClient, () => {
    const viewer = tabId === null ? null : hostClient.tabViewer(tabId);
    return viewer?.kind === "page" ? viewer.sessionId : null;
  });
  useBrowserPopupFollow(
    hostClient,
    tabId && pageSession ? { sessionId: pageSession, tabId } : null,
    (popupId) => nav.showPlace({ kind: "tab", tabId: popupId }),
  );
  // Before paint, so the gone tab's ended state never flashes in the middle.
  useLayoutEffect(() => {
    if (!known || !destination) {
      if (!destination) shown.current = null;
      return;
    }
    const address = placeAddress(destination);
    const snapshot = hostClient.getSnapshot();
    if (!placeDestinationEnded(snapshot, destination)) {
      shown.current = { address, viewer, strip };
      return;
    }
    const last = shown.current;
    shown.current = null;
    if (last?.address !== address || last.viewer !== viewer) return;
    const next = tabSuccessor(last.strip, strip, destination.tabId);
    nav.succeedPlace(next ? { kind: "tab", tabId: next } : null, destination);
  }, [destination, hostClient, known, nav, strip, viewer]);
}

/** Whether a tab has ended, by a catalog known enough to prove it. */
export function placeEnded(snapshot: HostSnapshot, destination: TabDestination): boolean {
  return selectPlacesKnown(snapshot) && placeDestinationEnded(snapshot, destination);
}

/** Snapshots that answer `placeEnded` alike. */
export function samePlaceEndSource(a: HostSnapshot, b: HostSnapshot): boolean {
  return a.tabs === b.tabs && selectPlacesKnown(a) === selectPlacesKnown(b);
}

const selectPlacesKnown = (snapshot: HostSnapshot) =>
  snapshot.connection === "connected" &&
  snapshot.session === "authenticated" &&
  snapshot.deploymentShape !== null;
const selectViewer = (snapshot: HostSnapshot) =>
  `${snapshot.deploymentId ?? ""}:${snapshot.user?.id ?? ""}`;
