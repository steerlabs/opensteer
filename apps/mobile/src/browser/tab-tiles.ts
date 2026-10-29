import {
  browserPlaceUnavailableReason,
  browserSiteLabel,
  nativeViewerSource,
  surfaceDestination,
  type BrowserSessionSummary,
  type HostSnapshot,
  type NativeViewerSource,
  type PlaceBrowserIdentity,
  type PlaceItem,
  type SurfaceItem,
  type WorkspaceSurfaceDestination,
} from "@opensteer/client/host";

/**
 * What one tile of a Tabs grid draws and opens, whichever list it came from:
 * a conversation's own tabs (`conversationSurfaces`) or every tab the person
 * may see (`placeList`). The destination is exactly what a press opens; the
 * picture is exactly the authority the thumbnail reads with.
 */
export interface TabTile {
  readonly key: string;
  readonly kind: "browser" | "app" | "phone";
  readonly title: string;
  /** The page's site, or the Mac an app is on; null for a phone or a page with no address. */
  readonly site: string | null;
  readonly identity: PlaceBrowserIdentity | null;
  /** An agent is acting in this very tab, app or phone now. */
  readonly acting: boolean;
  readonly picture:
    | { readonly kind: "browser"; readonly session: BrowserSessionSummary; readonly tabId: string }
    | {
        readonly kind: "native";
        readonly machineId: string;
        readonly phone: boolean;
        readonly source: NativeViewerSource;
      }
    | null;
  /**
   * `saved`: kept by its browser and not running, so there is no picture until
   * it is opened; `opening`: restoring now; `unavailable`: it cannot open, for
   * `reason`.
   */
  readonly state: "live" | "saved" | "opening" | "unavailable";
  readonly reason: string | null;
  readonly destination: WorkspaceSurfaceDestination;
}

/**
 * A tab's site as every client names it beside a title: its registrable
 * domain, from an address or a bare host; null for a page with none.
 */
export function tabSiteLabel(site: string | null): string | null {
  if (site === null || site === "") return null;
  return browserSiteLabel(/^[a-z][a-z\d+.-]*:/iu.test(site) ? site : `https://${site}`) || null;
}

/** A conversation's own tab or app, read with that conversation's task authority. */
export function surfaceTile(item: SurfaceItem): TabTile {
  const destination = surfaceDestination(item);
  if (item.kind === "browser")
    return {
      acting: item.acting,
      destination,
      identity: item.identity,
      key: item.key,
      kind: "browser",
      picture: { kind: "browser", session: item.session, tabId: item.tabId },
      reason: null,
      site: tabSiteLabel(item.site),
      state: "live",
      title: item.title,
    };
  return {
    acting: item.acting,
    destination,
    identity: null,
    key: item.key,
    kind: item.kind,
    picture: {
      kind: "native",
      machineId: item.machine.id,
      phone: item.kind === "phone",
      source: {
        kind: "task-session",
        sessionId: item.computerSessionId,
        ...(item.kind === "app" ? { appKey: item.appKey } : {}),
      },
    },
    reason: null,
    site: item.kind === "app" ? item.machine.name : null,
    state: "live",
    title: item.kind === "app" ? item.app.displayName : item.machine.name,
  };
}

/**
 * One of the person's places. A browser tab has a picture only while its
 * browser runs it; a saved tab keeps its title and site and asks for nothing.
 * An app or phone is read through the place's own destination — the person's
 * view when it is theirs, a task's session when only a task holds it.
 */
export function placeTile(
  place: PlaceItem,
  source: Pick<HostSnapshot, "browserPlacements" | "browserSessions">,
): TabTile {
  const acting = place.occupants.some((occupant) => occupant.acting);
  const unavailable = place.availability === "unavailable";
  const placement = source.browserPlacements.find(
    ({ runnerId }) => runnerId === place.device?.machineId,
  );
  const reason = unavailable
    ? (browserPlaceUnavailableReason(
        place.identity,
        place.workspaceTab?.unavailableReason,
        placement?.unavailableReason,
      ) ?? "Unavailable")
    : null;
  const common = {
    acting,
    destination: place.destination,
    identity: place.identity,
    key: place.key,
    kind: place.kind,
    reason,
    title: place.title,
  };
  if (place.destination.kind === "browser") {
    const { sessionId, tabId } = place.destination;
    const session = source.browserSessions.find(
      (candidate) =>
        candidate.id === sessionId &&
        candidate.state === "ready" &&
        (candidate.tabCatalog?.tabs.some((tab) => tab.id === tabId) ??
          candidate.tabs.some((tab) => tab.id === tabId)),
    );
    const live = session !== undefined && place.workspaceTab?.state !== "suspended";
    return {
      ...common,
      picture: live && !unavailable ? { kind: "browser", session, tabId } : null,
      site: tabSiteLabel(place.site),
      state: unavailable ? "unavailable" : live ? "live" : place.loading ? "opening" : "saved",
    };
  }
  return {
    ...common,
    picture:
      place.availability === "ready"
        ? {
            kind: "native",
            machineId: place.destination.machineId,
            phone: place.kind === "phone",
            source: nativeViewerSource(place.destination),
          }
        : null,
    site: place.kind === "app" ? (place.device?.name ?? null) : null,
    state: unavailable ? "unavailable" : place.availability === "starting" ? "opening" : "live",
  };
}
