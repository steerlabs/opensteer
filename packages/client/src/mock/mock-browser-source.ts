import { groupSession } from "../host/browser-snapshot.js";
import { placeList } from "../host/places.js";
import type {
  BrowserSessionSummary,
  BrowserInventory,
  BrowserTabSummary,
  HostSnapshot,
  WorkspaceTabLineage,
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
  browserGroups?: WorkspaceTabLineage[] | undefined;
}

export function mockPlaceList(snapshot: MockBrowserSource) {
  const sessions = new Map<string, BrowserSessionSummary>(
    snapshot.browserSessions.map((session) => [session.id, session]),
  );
  // Runtime sessions omit sleeping browsers; their authorized metadata remains in the keyed groups.
  for (const id of snapshot.browserTabs?.groups().ids ?? []) {
    const group = snapshot.browserTabs!.group(id)!;
    if (!sessions.has(group.sessionId))
      sessions.set(group.sessionId, {
        ...groupSession(group),
        dialog: null,
        error: null,
        viewerState: "disconnected",
        viewerError: null,
      });
  }
  return placeList({ ...snapshot, browserSessions: [...sessions.values()] });
}
