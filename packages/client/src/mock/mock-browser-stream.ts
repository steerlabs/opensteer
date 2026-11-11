import type { HostedBrowserSession } from "@opensteer/protocol";
import {
  BrowserGroupRowSchema,
  BrowserTabRowSchema,
  type BrowserGroupRow,
  type BrowserTabRow,
  type BrowserViewerSurface,
} from "@opensteer/protocol/browser-tabs";
import { KeyedStreamPublisher, type KeyedStreamMessage } from "@opensteer/protocol/keyed-stream";
import { BrowserTabStore } from "../host/browser-tab-store.js";
import { BrowserSnapshotDerivation } from "../host/browser-snapshot.js";
import type { BrowserSessionSummary, HostSnapshot } from "../host/client.js";

class MockRows<Row extends { id: string }> {
  #rows = new Map<string, Row>();
  readonly #publisher = new KeyedStreamPublisher<Row, Record<string, never>>({
    ids: () => this.#rows.keys(),
    read: (id) => this.#rows.get(id),
    meta: () => ({}),
    targetBytes: 16 * 1024,
    envelopeBytes: 200,
  });
  publish(rows: Row[], receive: (frame: KeyedStreamMessage<Row, Record<string, never>>) => void) {
    for (const id of this.#rows.keys()) this.#publisher.mark(id);
    this.#rows = new Map(rows.map((row) => [row.id, row]));
    for (const id of this.#rows.keys()) this.#publisher.mark(id);
    for (let frame = this.#publisher.next(); frame; frame = this.#publisher.next()) {
      receive(frame);
      this.#publisher.settled(frame, true);
    }
  }
}

export function mockBrowserRows(snapshot: HostSnapshot) {
  const liveSessions = new Map(snapshot.browserSessions.map((session) => [session.id, session]));
  const sessions = new Map<string, HostedBrowserSession | BrowserSessionSummary>(
    snapshot.workspaceTabs?.map((group) => [group.session.id, group.session]),
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
    const lineage = snapshot.workspaceTabs?.find((group) => group.session.id === session.id);
    const id = lineage?.id ?? session.id;
    const live = liveSessions.get(session.id);
    const catalog = live?.state === "ready" ? live.tabCatalog : undefined;
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
        workspaceId: session.workspaceId,
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

export class MockBrowserStream {
  readonly #groups = new MockRows<BrowserGroupRow>();
  readonly #tabs = new Map<string, MockRows<BrowserTabRow>>();
  readonly #store = new BrowserTabStore(() => {});
  readonly #derive = new BrowserSnapshotDerivation();
  publish(
    snapshot: HostSnapshot,
    previous: HostSnapshot | null,
    surface: (sessionId: string, surfaceId: string) => BrowserViewerSurface | undefined,
  ): HostSnapshot {
    const rows =
      snapshot.session === "authenticated"
        ? mockBrowserRows(snapshot)
        : { groups: [], tabs: new Map<string, BrowserTabRow[]>() };
    this.#groups.publish(rows.groups, (frame) => this.#store.applyGroups(frame));
    for (const [id, tabs] of rows.tabs) {
      let stream = this.#tabs.get(id);
      if (!stream) this.#tabs.set(id, (stream = new MockRows<BrowserTabRow>()));
      stream.publish(tabs, (frame) => this.#store.applyTabs(id, frame));
    }
    for (const id of this.#tabs.keys()) if (!rows.tabs.has(id)) this.#tabs.delete(id);
    return {
      ...snapshot,
      ...this.#derive.derive(
        {
          ...snapshot,
          browserSessions: previous?.browserSessions ?? [],
          workspaceTabs: previous?.workspaceTabs,
        },
        this.#store,
        surface,
      ),
    };
  }
}
