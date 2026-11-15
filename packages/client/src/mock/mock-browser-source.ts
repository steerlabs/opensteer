import { placeList } from "../host/places.js";
import type {
  BrowserSessionSummary,
  BrowserInventory,
  BrowserTabSummary,
  HostSnapshot,
  PersonalTabLineage,
} from "../host/client.js";

/** One page the mock world authors in a browser, as the mock Host lists it. */
export interface MockCatalogTab {
  id: import("@opensteer/protocol").BrowserSurfaceId;
  title: string;
  site: string;
  iconRef: string | null;
  order: number;
  openerId: import("@opensteer/protocol").BrowserSurfaceId | null;
  availability: "ready" | "starting" | "unavailable";
  documentId: string | null;
  occupants: import("@opensteer/protocol").PlaceOccupant[];
  loading?: boolean | undefined;
  navigationFailed?: boolean | undefined;
  canGoBack?: boolean | undefined;
  canGoForward?: boolean | undefined;
}
/** Authored mock world data, independent of the client snapshot projections. */
export interface MockBrowserCatalog extends BrowserInventory {
  readonly tabs: MockCatalogTab[];
}
export interface MockBrowserSession extends BrowserSessionSummary {
  catalog?: MockBrowserCatalog;
  surfaces: BrowserTabSummary[];
}
export interface MockBrowserSource extends HostSnapshot {
  browserSessions: MockBrowserSession[];
  browserGroups?: PersonalTabLineage[] | undefined;
}

/** The mock's own read of the tab list: the same projection the published snapshot draws. */
export function mockPlaceList(snapshot: MockBrowserSource) {
  return placeList(snapshot);
}
