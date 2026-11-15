import { groupSession } from "../host/browser-snapshot.js";
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

/**
 * The mock's own read of the place list. It shares the keyed store's
 * projection with the published snapshot, so it lists the sessions that
 * snapshot derives, from the keyed groups in the authored order: a read with
 * other sessions would rebuild every row a client holds.
 */
export function mockPlaceList(snapshot: MockBrowserSource) {
  const store = snapshot.browserTabs;
  const order = new Map(snapshot.browserSessions.map((session, index) => [session.id, index]));
  const sessions: BrowserSessionSummary[] = (store?.groups().ids ?? [])
    .map((id) => store!.group(id)!)
    .sort((a, b) => (order.get(a.sessionId) ?? Infinity) - (order.get(b.sessionId) ?? Infinity))
    .map((group) => ({
      ...groupSession(group),
      dialog: null,
      error: null,
      viewerState: "disconnected",
      viewerError: null,
    }));
  return placeList({ ...snapshot, browserSessions: sessions });
}
