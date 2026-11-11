import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  placeDestinationEnded,
  browserTabSections,
  samePlaceListSource,
  type HostClient,
  type HostSnapshot,
  type PlaceItem,
  type PlaceListSource,
} from "@opensteer/client/host";
import {
  useBrowserPopupFollow,
  useBrowserTabStrip,
  useHostSelector,
  usePlaceList,
} from "@opensteer/client/react";
import { destinationPlaceKey, placeAddress } from "./navigation.js";
import { tabSections } from "./tab-order.js";
import { useWorkspace } from "./workspace-context.js";
import { useHereId } from "../computers/here.js";

/**
 * The row that takes the middle when the place it showed is no longer listed,
 * as a browser picks a tab after one closes: the tab that opened it, so a
 * finished sign-in returns to the page that asked for it, else the nearest
 * independent row after it in the device sections' order, else before it.
 * A Mac app's owner and task destinations keep their own authority and never
 * replace each other. Web tabs succeed web tabs, and apps succeed apps. A row that
 * cannot be shown is passed over; null when none is left.
 */
export function placeSuccessor(
  before: readonly PlaceItem[],
  after: readonly PlaceItem[],
  key: string,
): PlaceItem | null {
  const { native, web } = tabSections(before);
  const order = web.some((place) => place.key === key) ? web : native;
  const at = order.findIndex((place) => place.key === key);
  if (at < 0) return null;
  const previous = order[at]!;
  const listed = new Map(after.map((place) => [place.key, place]));
  const openerId = previous.workspaceTab?.openerId;
  const opener = order.filter((place) => openerId && place.workspaceTab?.id === openerId);
  for (const candidate of [...opener, ...order.slice(at + 1), ...order.slice(0, at).reverse()]) {
    const place = listed.get(candidate.key);
    if (
      place &&
      place.availability !== "unavailable" &&
      (independent(previous) ||
        independent(place) ||
        Boolean(previous.ownerView) === Boolean(place.ownerView))
    )
      return place;
  }
  return null;
}

const independent = (place: PlaceItem) => place.kind !== "app";

/**
 * One rule for the place in the middle going away, whoever made it go — ×,
 * the wheel button, a menu, ⌘W, an agent, another window, its browser ending:
 * its successor takes its history entry. Going away is the exact tab, task
 * session or view ending (`placeDestinationEnded`), never its computer or
 * browser becoming unavailable: then it stays, saying why, and is there
 * again when it recovers. Only a place that existed while shown can end; an
 * address that never did (a typed or old link, Back to a closed tab) keeps its
 * ended state, and a snapshot not yet known proves nothing.
 */
export function usePlaceSuccession(hostClient: HostClient): void {
  const { nav, selection } = useWorkspace();
  const places = usePlaceList(hostClient);
  const strip = useBrowserTabStrip(hostClient);
  const hereId = useHereId();
  const machines = useHostSelector(hostClient, (snapshot) => snapshot.machines);
  const ordered = useMemo(
    () => browserTabSections({ strip, machines, hereId }).ordered,
    [strip, machines, hereId],
  );
  const source = useHostSelector(hostClient, selectPlaceSource, samePlaceListSource);
  const known = useHostSelector(hostClient, selectPlacesKnown);
  const viewer = useHostSelector(hostClient, selectViewer);
  const shown = useRef<{
    readonly address: string;
    readonly viewer: string;
    readonly places: readonly PlaceItem[];
  } | null>(null);
  const browser =
    selection.kind === "place" && selection.destination.kind === "browser"
      ? selection.destination
      : null;
  useBrowserPopupFollow(hostClient, browser, (tabId) => {
    if (browser) nav.showPlace({ kind: "browser", sessionId: browser.sessionId, tabId });
  });
  const group = browser
    ? source.workspaceTabs?.find(
        (group) =>
          group.id === browser.sessionId ||
          group.session.id === browser.sessionId ||
          group.tabs?.some((tab) => tab.id === browser.tabId),
      )
    : undefined;
  const selectedSessionId = browser?.sessionId;
  const legacy = source.browserSessions.some(
    (session) =>
      session.id === selectedSessionId &&
      session.workspaceTabRestoreVersion !== 1 &&
      session.state !== "closed" &&
      session.state !== "failed",
  );
  useEffect(() => {
    if (
      !known ||
      !selectedSessionId ||
      source.workspaceTabRestoreVersion !== 1 ||
      (group?.tabs && group.whole !== false) ||
      (!group && legacy) ||
      !hostClient.readWorkspaceTabs
    )
      return;
    let cancelled = false;
    void hostClient
      .readWorkspaceTabs(selectedSessionId)
      .then((recovered) => {
        if (
          cancelled ||
          (recovered &&
            (!recovered.tabs || recovered.tabs.some((tab) => tab.id === browser?.tabId)))
        )
          return;
        const last = shown.current;
        if (last?.viewer === viewer && browser && last.address === placeAddress(browser))
          nav.succeedPlace(
            placeSuccessor(last.places, strip.visible, destinationPlaceKey(browser) ?? "")
              ?.destination ?? null,
          );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [
    known,
    selectedSessionId,
    source.workspaceTabRestoreVersion,
    group,
    legacy,
    hostClient,
    viewer,
    nav,
    strip,
  ]);
  // Before paint, so the gone place's ended state never flashes in the middle.
  useLayoutEffect(() => {
    if (!known) return;
    const destination = selection.kind === "place" ? selection.destination : null;
    const key = destination ? destinationPlaceKey(destination) : null;
    if (!destination || !key) {
      shown.current = null;
      return;
    }
    const address = placeAddress(destination);
    if (!placeDestinationEnded(source, destination)) {
      if (
        places.some(
          (place) =>
            place.key === key ||
            (browser &&
              place.destination.kind === "browser" &&
              place.destination.tabId === browser.tabId),
        )
      )
        shown.current = { address, viewer, places: ordered };
      return;
    }
    const last = shown.current;
    shown.current = null;
    if (last?.address !== address || last.viewer !== viewer) return;
    nav.succeedPlace(placeSuccessor(last.places, strip.visible, key)?.destination ?? null);
  }, [known, nav, places, selection, source, viewer, strip, ordered]);
}

/** Whether a place has ended, by a snapshot known enough to prove it. */
export function placeEnded(snapshot: HostSnapshot, destination: PlaceItem["destination"]): boolean {
  return selectPlacesKnown(snapshot) && placeDestinationEnded(snapshot, destination);
}

/** Snapshots that answer `placeEnded` alike. */
export function samePlaceEndSource(a: HostSnapshot, b: HostSnapshot): boolean {
  return samePlaceListSource(a, b) && selectPlacesKnown(a) === selectPlacesKnown(b);
}

const selectPlaceSource = (snapshot: HostSnapshot): PlaceListSource => snapshot;
const selectPlacesKnown = (snapshot: HostSnapshot) =>
  snapshot.connection === "connected" &&
  snapshot.session === "authenticated" &&
  snapshot.deploymentShape !== null;
const selectViewer = (snapshot: HostSnapshot) =>
  `${snapshot.deploymentId ?? ""}:${snapshot.user?.id ?? ""}`;
