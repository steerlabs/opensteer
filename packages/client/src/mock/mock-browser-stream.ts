import type {
  MockBrowserSource as HostSnapshot,
  MockBrowserSession as BrowserSessionSummary,
} from "./mock-browser-source.js";
import type { BrowserSessionOpener, BrowserSurfaceId, PlaceOccupant } from "@opensteer/protocol";
import type { PersonalTabLineage } from "../host/client.js";

/** One browser of the mock world, as the mock Host lists its page tabs. */
export interface MockBrowserGroup {
  readonly id: string;
  readonly profileId: string | null;
  readonly placement: BrowserSessionSummary["placement"];
  readonly unavailableReason: string | null;
  readonly opener: BrowserSessionOpener;
  readonly updatedAt: string;
}
/** One page of a mock browser: its row in the person's tab list. */
export interface MockPageRow {
  readonly id: BrowserSurfaceId;
  readonly title: string;
  readonly site: string;
  readonly iconRef: string | null;
  readonly createdAt: string;
  readonly state: "live" | "suspended" | "restoring";
  readonly availability: "ready" | "starting" | "unavailable";
  readonly occupants: readonly PlaceOccupant[];
}

/** The browser world's sessions and pages, from which the mock Host lists page tabs. */
export function mockBrowserRows(snapshot: HostSnapshot): {
  readonly groups: MockBrowserGroup[];
  readonly tabs: Map<string, MockPageRow[]>;
} {
  const liveSessions = new Map(snapshot.browserSessions.map((session) => [session.id, session]));
  const sessions = new Map<string, PersonalTabLineage["session"] | BrowserSessionSummary>(
    snapshot.browserGroups?.map((group) => [group.session.id, group.session]),
  );
  for (const session of snapshot.browserSessions)
    sessions.set(session.id, {
      ...session,
      createdAt: session.createdAt!,
      updatedAt: session.updatedAt ?? session.createdAt!,
    });
  const groups: MockBrowserGroup[] = [];
  const tabs = new Map<string, MockPageRow[]>();
  for (const session of sessions.values()) {
    const lineage = snapshot.browserGroups?.find((group) => group.session.id === session.id);
    const id = lineage?.id ?? session.id;
    const live = liveSessions.get(session.id);
    const catalog = live?.state === "ready" ? live.catalog : undefined;
    const records = new Map(catalog?.tabs.map((tab) => [tab.id, tab]));
    const rows = (lineage?.tabs ?? catalog?.tabs ?? []).map((tab): MockPageRow => {
      const record = records.get(tab.id);
      return {
        id: tab.id,
        title: tab.title,
        site: tab.site,
        iconRef: record?.iconRef ?? tab.iconRef ?? null,
        createdAt:
          ("createdAt" in tab ? tab.createdAt : undefined) ??
          lineage?.createdAt ??
          session.createdAt!,
        state: record
          ? "state" in tab
            ? tab.state
            : "live"
          : "state" in tab && tab.state === "restoring"
            ? "restoring"
            : "suspended",
        availability: record?.availability ?? "unavailable",
        occupants: record?.occupants ?? [],
      };
    });
    groups.push({
      id,
      profileId: session.profileId,
      placement: session.placement,
      unavailableReason: lineage?.unavailableReason ?? null,
      opener: session.opener ?? { kind: "unknown" },
      updatedAt: session.updatedAt!,
    });
    tabs.set(id, rows);
  }
  return { groups, tabs };
}
