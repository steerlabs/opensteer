import type {
  MockBrowserSource as HostSnapshot,
  MockBrowserSession as BrowserSessionSummary,
} from "./mock-browser-source.js";
import {
  BrowserGroupRowSchema,
  BrowserTabRowSchema,
  type BrowserGroupRow,
  type BrowserTabRow,
} from "@opensteer/protocol/browser-tabs";
import type { PersonalTabLineage } from "../host/client.js";

/** The browser world's sessions and tabs as rows, from which the mock Host lists page tabs. */
export function mockBrowserRows(snapshot: HostSnapshot) {
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
  const groups: BrowserGroupRow[] = [];
  const tabs = new Map<string, BrowserTabRow[]>();
  for (const session of sessions.values()) {
    const lineage = snapshot.browserGroups?.find((group) => group.session.id === session.id);
    const id = lineage?.id ?? session.id;
    const live = liveSessions.get(session.id);
    const catalog = live?.state === "ready" ? live.catalog : undefined;
    const records = new Map(catalog?.tabs.map((tab) => [tab.id, tab]));
    const rows = (lineage?.tabs ?? catalog?.tabs ?? []).map((tab) => {
      const record = records.get(tab.id);
      return BrowserTabRowSchema.parse({
        id: tab.id,
        sessionId: session.id,
        title: tab.title,
        site: tab.site,
        order: tab.order,
        openerId: tab.openerId,
        createdAt:
          ("createdAt" in tab ? tab.createdAt : undefined) ??
          lineage?.createdAt ??
          session.createdAt,
        state: record
          ? "state" in tab
            ? tab.state
            : "live"
          : "state" in tab && tab.state === "restoring"
            ? "restoring"
            : "suspended",
        iconRef: record?.iconRef ?? tab.iconRef ?? null,
        availability: record?.availability ?? "unavailable",
        loading: record?.loading ?? false,
        navigationFailed: record?.navigationFailed ?? false,
        documentId: record?.documentId ?? null,
        canGoBack: record?.canGoBack ?? false,
        canGoForward: record?.canGoForward ?? false,
        occupants: record?.occupants ?? [],
      });
    });
    groups.push(
      BrowserGroupRowSchema.parse({
        id,
        createdAt: lineage?.createdAt ?? session.createdAt,
        unavailableReason: lineage?.unavailableReason ?? null,
        tabCount: rows.length,
        inventoryRevision:
          catalog?.inventoryRevision ?? catalog?.revision ?? lineage?.revision ?? 0,
        sessionId: session.id,

        state: session.state,
        origin: session.origin,
        access: session.access,
        placement: session.placement,
        profileId: session.profileId,
        runtimeId: session.runtimeId,
        opener: session.opener ?? { kind: "unknown" },
        navigation: session.navigationVersion === 1,
        sessionCreatedAt: session.createdAt,
        updatedAt: session.updatedAt,
        acting: session.acting ?? false,
        page: session.page ?? null,
        attachedRunIds: session.attachedRunIds ?? [],
        threadIds: session.threadIds ?? [],
      }),
    );
    tabs.set(id, rows);
  }
  return { groups, tabs };
}
