import type {
  HostSnapshot,
  BrowserSessionSummary,
  BrowserInventory,
  BrowserTabSummary,
  PersonalTabLineage,
} from "../host/client.js";
import type { HostedBrowserBootstrap } from "@opensteer/protocol";
import { BrowserTabStore } from "../host/browser-tab-store.js";
import {
  BrowserSnapshotDerivation,
  groupSession,
  personalTabLineage,
} from "../host/browser-snapshot.js";
import {
  type BrowserGroupRow,
  type BrowserTabRow,
  type BrowserViewerSurface,
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
  const store = new BrowserTabStore();
  store.seed(prefix);
  return new BrowserSnapshotDerivation().derive({ browserSessions: [] }, store);
}

type SessionSeed = { [K in keyof BrowserSessionSummary]?: BrowserSessionSummary[K] | undefined } & {
  id: string;
};
type RowSeed = {
  [K in Exclude<keyof BrowserTabRow, "id" | "sessionId" | "openerId" | "occupants">]?:
    BrowserTabRow[K] | undefined;
} & {
  id: string;
  sessionId?: string | undefined;
  openerId?: string | null | undefined;
  occupants?:
    | readonly {
        threadId: string;
        holding: boolean;
        acting: boolean;
        lastActiveAt: string;
      }[]
    | undefined;
};
export function seedBrowserSession<T extends SessionSeed>(
  source: T,
  seed?: Partial<BrowserInventory> & { rows?: readonly RowSeed[]; complete?: boolean },
  surfaces?: readonly (Omit<BrowserTabSummary, "id" | "active" | "favicon" | "documentId"> & {
    id: string;
    active?: boolean;
    documentId?: string | null | undefined;
    favicon?: string | null | undefined;
  })[],
): T & { browserTabs: BrowserTabStore } {
  const inherited = source.browserTabs;
  const oldGroup = inherited?.groupForSession(source.id);
  const heldGroup = oldGroup ? inherited?.group(oldGroup) : undefined;
  const id = heldGroup?.id ?? source.id;
  const rows: readonly RowSeed[] =
    seed?.rows ??
    (surfaces
      ? surfaces.map((tab, order) => ({
          ...tab,
          site: tab.url,
          order,
          canGoBack: true,
          canGoForward: true,
        }))
      : inherited?.sessionTabs(source.id)) ??
    [];
  const tabs = rows.map((tab, order) => ({
    id: tab.id,
    sessionId: source.id,
    title: tab.title ?? "Page",
    site: tab.site ?? "",
    iconRef: tab.iconRef ?? null,
    order: tab.order ?? order,
    openerId: tab.openerId ?? null,
    createdAt: tab.createdAt ?? source.createdAt ?? "",
    state: tab.state ?? "live",
    availability: tab.availability ?? "ready",
    loading: tab.loading ?? false,
    navigationFailed: tab.navigationFailed ?? false,
    documentId: tab.state === "suspended" ? null : (tab.documentId ?? `document-${tab.id}`),
    canGoBack: tab.canGoBack ?? false,
    canGoForward: tab.canGoForward ?? false,
    occupants: tab.occupants ?? [],
  })) as BrowserTabRow[];
  const group = {
    id,
    sessionId: source.id,
    createdAt: heldGroup?.createdAt ?? source.createdAt ?? "",
    sessionCreatedAt: source.createdAt ?? "",
    updatedAt: source.updatedAt ?? source.createdAt ?? "",
    unavailableReason: heldGroup?.unavailableReason ?? null,
    tabCount: tabs.length,
    inventoryRevision:
      seed?.inventoryRevision ?? seed?.revision ?? heldGroup?.inventoryRevision ?? 0,
    access: source.access,
    origin: source.origin,
    state: source.state,
    placement: source.placement,
    profileId: source.profileId ?? null,
    runtimeId: source.runtimeId,
    navigation: source.navigationVersion === 1,
    opener: source.opener ?? { kind: "unknown" },
    acting: source.acting ?? false,
    page: source.page ?? null,
    attachedRunIds: source.attachedRunIds ?? [],
    threadIds: source.threadIds ?? [],
  } as unknown as BrowserGroupRow;
  const store = browserStoreFixture(
    [group],
    [{ groupId: id, rows: tabs, complete: seed?.complete ?? true }],
    (sessionId, tabId) => {
      const viewed = surfaces?.find((tab) => tab.id === tabId);
      return viewed
        ? {
            ...viewed,
            id: viewed.id as BrowserViewerSurface["id"],
            state: "live",
            documentId: viewed.documentId ?? `document-${tabId}`,
            geometryRevision: 1,
            loading: viewed.loading ?? false,
            navigationFailed: viewed.navigationFailed ?? false,
            sizedByAgent: viewed.sizedByAgent ?? false,
            favicon: viewed.favicon ?? null,
          }
        : inherited?.surface(sessionId, tabId);
    },
  );
  return { ...source, browserTabs: store };
}

const snapshots = new WeakMap<HostSnapshot, HostSnapshot>();
const sessionBindings = new WeakMap<
  HostSnapshot["browserSessions"],
  HostSnapshot["browserSessions"]
>();
const bindings = new WeakMap<HostSnapshot["browserSessions"], HostSnapshot["browserTabs"]>();
export function seedBrowserSnapshot(
  source: HostSnapshot,
  lineages?: readonly PersonalTabLineage[],
): HostSnapshot {
  if (!lineages) {
    const held = snapshots.get(source);
    if (held) return held;
  }
  let store = !lineages ? bindings.get(source.browserSessions) : undefined;
  if (!store) {
    const groups = new Map<string, BrowserGroupRow>();
    const tabs = new Map<
      string,
      { groupId: string; rows: readonly BrowserTabRow[]; complete: boolean }
    >();
    for (const session of source.browserSessions) {
      if (
        lineages &&
        session.tabRestoreVersion === 1 &&
        !lineages.some((group) => group.session.id === session.id)
      )
        continue;
      const groupId = session.browserTabs?.groupForSession(session.id);
      const group = groupId ? session.browserTabs?.group(groupId) : undefined;
      if (group) {
        const seeded = seedBrowserSession(session).browserTabs;
        groups.set(group.id, seeded.group(group.id)!);
        tabs.set(group.id, {
          groupId: group.id,
          rows: session.browserTabs!.sessionTabs(session.id),
          complete: session.browserTabs!.tabs(group.id).whole,
        });
      }
    }
    for (const lineage of lineages ?? []) {
      const session = source.browserSessions.find((session) => session.id === lineage.session.id);
      const seeded = seedBrowserSession(
        {
          ...groupSession({
            ...lineage.session,
            sessionId: lineage.session.id,
            sessionCreatedAt: lineage.session.createdAt,
          } as BrowserGroupRow),
          ...session,
          tabRestoreVersion: 1,
        },
        {
          rows: lineage.tabs ?? [],
          revision: lineage.revision,
          complete: lineage.whole !== false && !!lineage.tabs,
        },
      );
      const group = seeded.browserTabs!.group(seeded.id)!;
      groups.set(lineage.id, {
        ...group,
        id: lineage.id,
        createdAt: lineage.createdAt,
        unavailableReason: lineage.unavailableReason ?? null,
      });
      tabs.set(lineage.id, {
        groupId: lineage.id,
        rows: seeded.browserTabs!.sessionTabs(seeded.id),
        complete: lineage.whole !== false && !!lineage.tabs,
      });
    }
    store = browserStoreFixture([...groups.values()], [...tabs.values()], (sessionId, tabId) =>
      source.browserSessions
        .find((session) => session.id === sessionId)
        ?.browserTabs?.surface(sessionId, tabId),
    );
    bindings.set(source.browserSessions, store);
  }
  const browserSessions =
    (!lineages ? sessionBindings.get(source.browserSessions) : undefined) ??
    source.browserSessions.map((session) => ({
      ...session,
      browserTabs: store,
    }));
  for (const id of store.groups().ids) {
    const group = store.group(id)!;
    if (!browserSessions.some((session) => session.id === group.sessionId))
      browserSessions.push({
        ...groupSession(group),
        browserTabs: store,
        dialog: null,
        error: null,
        viewerState: "disconnected",
        viewerError: null,
      });
  }
  sessionBindings.set(source.browserSessions, browserSessions);
  sessionBindings.set(browserSessions, browserSessions);
  bindings.set(browserSessions, store);
  const snapshot = { ...source, browserTabs: store, browserSessions };
  if (!lineages) snapshots.set(source, snapshot);
  return snapshot;
}

export function browserLineages(source: Pick<HostSnapshot, "browserTabs">) {
  const store = source.browserTabs;
  return store?.groups().ids.map((id) => personalTabLineage(store, id)!) ?? [];
}
