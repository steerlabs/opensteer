import { placeList } from "../host/places.js";
import type {
  BrowserSessionSummary,
  BrowserInventory,
  BrowserTabSummary,
  HostSnapshot,
  PersonalTabLineage,
} from "../host/client.js";

/** Authored mock world data, independent of the client snapshot projections. */
export interface MockBrowserCatalog extends BrowserInventory {
  readonly tabs: (Omit<
    import("@opensteer/protocol/browser-tabs").BrowserTabRow,
    | "state"
    | "createdAt"
    | "sessionId"
    | "loading"
    | "navigationFailed"
    | "canGoBack"
    | "canGoForward"
  > & {
    loading?: boolean | undefined;
    navigationFailed?: boolean | undefined;
    canGoBack?: boolean | undefined;
    canGoForward?: boolean | undefined;
  })[];
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
