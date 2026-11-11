import type { HostSnapshot, BrowserSessionSummary, WorkspaceTabLineage } from "../host/client.js";
import type { HostedBrowserBootstrap } from "@opensteer/protocol";
import { BrowserTabStore } from "../host/browser-tab-store.js";
import { BrowserSnapshotDerivation } from "../host/browser-snapshot.js";
import type {
  BrowserGroupRow,
  BrowserTabRow,
  BrowserViewerSurface,
} from "@opensteer/protocol/browser-tabs";

export function browserStoreFixture(
  groups: readonly BrowserGroupRow[],
  tabs: readonly { groupId: string; rows: readonly BrowserTabRow[]; complete?: boolean }[],
  surface: (sessionId: string, tabId: string) => BrowserViewerSurface | undefined = () => undefined,
) {
  const store = new BrowserTabStore(() => {}, surface);
  store.seed({
    groups: { rows: groups, complete: true },
    tabs: tabs.map((group) => ({ ...group, complete: group.complete ?? true })),
  });
  return store;
}

export function replaceBrowserTabs(
  store: BrowserTabStore,
  groupId: string,
  rows: readonly BrowserTabRow[],
) {
  store.applyTabs(groupId, { op: "begin", generation: "fixture" });
  store.applyTabs(groupId, { op: "rows", rows: [...rows] });
  store.applyTabs(groupId, { op: "end", revision: 0, count: rows.length, meta: {} });
}

export function browserSnapshotFromRows(prefix: Pick<HostedBrowserBootstrap, "groups" | "tabs">) {
  const store = new BrowserTabStore(() => {});
  store.seed(prefix);
  return new BrowserSnapshotDerivation().derive({ browserSessions: [], workspaceTabs: [] }, store);
}

const fixtureBindings = new WeakMap<
  HostSnapshot["browserSessions"],
  Map<HostSnapshot["workspaceTabs"], Pick<HostSnapshot, "browserTabs" | "browserSessions">>
>();
const fixtureSnapshots = new WeakMap<HostSnapshot, HostSnapshot>();

/** Admit authored legacy fixture records at the same keyed boundary as real bootstrap data. */
export function withBrowserTabStore(source: HostSnapshot): HostSnapshot {
  const previous = fixtureSnapshots.get(source);
  if (previous) return previous;
  const binding = fixtureBindings.get(source.browserSessions)?.get(source.workspaceTabs);
  if (binding) {
    const snapshot = { ...source, ...binding };
    fixtureSnapshots.set(source, snapshot);
    return snapshot;
  }
  const sessions = [...source.browserSessions];
  const groups: BrowserGroupRow[] = [];
  const tabs: { groupId: string; rows: BrowserTabRow[]; complete: boolean }[] = [];
  const claimed = new Set<string>();
  const add = (session: BrowserSessionSummary, lineage?: WorkspaceTabLineage) => {
    const id = lineage?.id ?? session.id;
    const catalog = session.tabCatalog;
    const live = new Map(catalog?.tabs.map((tab) => [tab.id, tab]));
    const rows = (lineage?.tabs ?? catalog?.tabs ?? session.tabs ?? []).map((tab, order) => {
      const record = live.get(tab.id);
      const surface = session.tabs?.find((surface) => surface.id === tab.id);
      const state = "state" in tab ? tab.state : "live";
      return {
        ...record,
        ...tab,
        sessionId: session.id,
        title: tab.title ?? surface?.title ?? "Page",
        site: "site" in tab ? tab.site : (surface?.url ?? ""),
        iconRef: record?.iconRef ?? ("iconRef" in tab ? tab.iconRef : null) ?? null,
        order: "order" in tab ? tab.order : order,
        openerId: "openerId" in tab ? tab.openerId : null,
        createdAt:
          "createdAt" in tab ? tab.createdAt : (lineage?.createdAt ?? session.createdAt ?? ""),
        state,
        availability: record?.availability ?? "ready",
        loading: surface?.loading ?? record?.loading ?? false,
        navigationFailed: record?.navigationFailed ?? false,
        documentId: state === "live" ? (record?.documentId ?? `document-${tab.id}`) : null,
        canGoBack: record?.canGoBack ?? false,
        canGoForward: record?.canGoForward ?? false,
        occupants: record?.occupants ?? [],
      } as BrowserTabRow;
    });
    groups.push({
      ...session,
      id,
      sessionId: session.id,
      createdAt: lineage?.createdAt ?? session.createdAt ?? "",
      sessionCreatedAt: session.createdAt ?? "",
      updatedAt: session.updatedAt ?? "",
      unavailableReason: lineage?.unavailableReason ?? null,
      tabCount: rows.length,
      inventoryRevision: catalog?.inventoryRevision ?? catalog?.revision ?? lineage?.revision ?? 0,
      navigation: session.navigationVersion === 1,
      opener: session.opener ?? { kind: "unknown" },
      profileId: session.profileId ?? null,
      acting: session.acting ?? false,
      page: session.page ?? null,
      attachedRunIds: session.attachedRunIds ?? [],
      threadIds: session.threadIds ?? [],
    } as unknown as BrowserGroupRow);
    tabs.push({
      groupId: id,
      rows,
      complete: lineage ? lineage.whole !== false && !!lineage.tabs : !!catalog || !!session.tabs,
    });
    claimed.add(session.id);
  };
  for (const lineage of source.workspaceTabs ?? []) {
    if (!lineage.session) continue;
    let session = sessions.find((session) => session.id === lineage.session.id);
    if (!session || session.state === "closed" || session.state === "failed") {
      session = sessions.find(
        (session) =>
          session.state === "ready" &&
          lineage.tabs?.some((tab) => session.tabCatalog?.tabs.some((live) => live.id === tab.id)),
      );
    }
    if (!session) {
      const { tabCatalog, ...metadata } = lineage.session;
      const saved: BrowserSessionSummary = {
        ...metadata,
        acting: metadata.acting ?? false,
        page: metadata.page ?? null,
        threadIds: metadata.threadIds ?? [],
        attachedRunIds: metadata.attachedRunIds ?? [],
        ...(tabCatalog ? { tabCatalog } : {}),
        opener: lineage.session.opener ?? { kind: "unknown" },
        tabs: [],
        dialog: null,
        error: null,
        viewerState: "disconnected",
        viewerError: null,
      };
      sessions.push(saved);
      session = saved;
    }
    session = { ...session, workspaceTabRestoreVersion: 1 };
    const at = sessions.findIndex((value) => value.id === session!.id);
    sessions[at] = session;
    add(session, lineage);
  }
  for (const session of source.browserSessions) {
    if (
      !claimed.has(session.id) &&
      !(source.workspaceTabRestoreVersion === 1 && session.workspaceTabRestoreVersion === 1)
    )
      add(session);
  }
  const store = browserStoreFixture(groups, tabs, (sessionId, tabId) => {
    const surface = source.browserSessions
      .find((session) => session.id === sessionId)
      ?.tabs?.find((tab) => tab.id === tabId);
    return surface
      ? {
          ...surface,
          state: "live",
          documentId: surface.documentId ?? `document-${tabId}`,
          geometryRevision: 1,
          loading: surface.loading ?? false,
          navigationFailed: false,
          sizedByAgent: surface.sizedByAgent ?? false,
          favicon: surface.favicon ?? null,
        }
      : undefined;
  });
  const inventory = store.inventory;
  store.inventory = (sessionId) => {
    const held = inventory(sessionId);
    const authored = source.browserSessions.find((session) => session.id === sessionId)?.tabCatalog;
    return held && authored
      ? { ...held, generation: authored.generation, revision: authored.revision }
      : held;
  };
  const snapshot = {
    ...source,
    browserTabs: store,
    browserSessions: sessions.map((session) => ({ ...session, browserTabs: store })),
  };
  const output = { browserTabs: store, browserSessions: snapshot.browserSessions };
  for (const list of [source.browserSessions, snapshot.browserSessions]) {
    let versions = fixtureBindings.get(list);
    if (!versions) fixtureBindings.set(list, (versions = new Map()));
    versions.set(source.workspaceTabs, output);
  }
  fixtureSnapshots.set(source, snapshot);
  return snapshot;
}
