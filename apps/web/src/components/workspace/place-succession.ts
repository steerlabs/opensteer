import { useEffect, useLayoutEffect, useRef } from "react";
import {
  placeDestinationEnded,
  samePlaceListSource,
  type HostClient,
  type HostSnapshot,
  type PlaceItem,
  type PlaceListSource,
} from "@opensteer/client/host";
import { useHostSelector, usePlaceList, useBrowserTabStrip } from "@opensteer/client/react";
import { destinationPlaceKey, placeAddress } from "./navigation.js";
import { tabSections } from "./tab-order.js";
import { useWorkspace } from "./workspace-context.js";

/**
 * The row that takes the middle when the place it showed is no longer listed,
 * as a browser picks the tab beside a closed one: the nearest independent
 * row after it on its side of the Tabs' hairline, else before it. Owner and
 * task destinations keep their own authority and never replace each other. Web
 * tabs stay on their side of the hairline. A row that cannot
 * be shown is passed over; null when none is left.
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
  for (const candidate of [...order.slice(at + 1), ...order.slice(0, at).reverse()]) {
    const place = listed.get(candidate.key);
    if (
      place &&
      place.availability !== "unavailable" &&
      (previous.kind === "browser" || Boolean(previous.ownerView) === Boolean(place.ownerView))
    )
      return place;
  }
  return null;
}

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
      group?.tabs ||
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
        shown.current = { address, viewer, places: strip.ordered };
      return;
    }
    const last = shown.current;
    shown.current = null;
    if (last?.address !== address || last.viewer !== viewer) return;
    nav.succeedPlace(placeSuccessor(last.places, strip.visible, key)?.destination ?? null);
  }, [known, nav, places, selection, source, viewer, strip]);
}

const selectPlaceSource = (snapshot: HostSnapshot): PlaceListSource => snapshot;
const selectPlacesKnown = (snapshot: HostSnapshot) =>
  snapshot.connection === "connected" &&
  snapshot.session === "authenticated" &&
  snapshot.deploymentShape !== null;
const selectViewer = (snapshot: HostSnapshot) =>
  `${snapshot.deploymentId ?? ""}:${snapshot.user?.id ?? ""}`;
