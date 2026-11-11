import type {
  BrowserGroupRow,
  BrowserTabRow,
  BrowserViewerSurface,
} from "@opensteer/protocol/browser-tabs";
import type { BrowserSessionSummary, HostSnapshot, WorkspaceTabLineage } from "./client.js";
import type { BrowserTabStore } from "./browser-tab-store.js";

function shared<T>(previous: T[] | undefined, next: T[]): T[] {
  return previous?.length === next.length && next.every((value, index) => value === previous[index])
    ? previous
    : next;
}
function same<T extends object>(previous: T | undefined, next: T): T {
  return previous &&
    Object.keys(previous).length === Object.keys(next).length &&
    Object.entries(next).every(([key, value]) => Reflect.get(previous, key) === value)
    ? previous
    : next;
}

/** Snapshot arrays remain reader-compatible until the lists use row subscriptions. */
export class BrowserSnapshotDerivation {
  readonly #rows = new WeakMap<
    BrowserTabRow,
    {
      catalog: NonNullable<BrowserSessionSummary["tabCatalog"]>["tabs"][number];
      durable: NonNullable<WorkspaceTabLineage["tabs"]>[number];
    }
  >();
  readonly #groups = new Map<
    string,
    {
      revision: number;
      catalog: NonNullable<BrowserSessionSummary["tabCatalog"]>["tabs"];
      durable: NonNullable<WorkspaceTabLineage["tabs"]>;
    }
  >();
  #previous: Pick<HostSnapshot, "browserSessions" | "workspaceTabs"> = {
    browserSessions: [],
    workspaceTabs: [],
  };
  readonly #sessions = new WeakMap<BrowserGroupRow, ReturnType<typeof groupSession>>();

  #session(group: BrowserGroupRow) {
    let session = this.#sessions.get(group);
    if (!session) {
      session = groupSession(group);
      this.#sessions.set(group, session);
    }
    return session;
  }
  #row(row: BrowserTabRow) {
    let projected = this.#rows.get(row);
    if (!projected) {
      const {
        id,
        title,
        site,
        iconRef,
        order,
        openerId,
        availability,
        loading,
        navigationFailed,
        documentId,
        canGoBack,
        canGoForward,
        occupants,
      } = row;
      projected = {
        catalog: {
          id,
          title,
          site,
          iconRef,
          order,
          openerId,
          availability,
          loading,
          navigationFailed,
          documentId,
          canGoBack,
          canGoForward,
          occupants,
        },
        durable: {
          kind: "browser",
          id,
          title,
          site,
          iconRef,
          order,
          openerId,
          sessionId: row.sessionId,
          state: row.state,
          createdAt: row.createdAt,
        },
      };
      this.#rows.set(row, projected);
    }
    return projected;
  }
  derive(
    _snapshot: Pick<HostSnapshot, "browserSessions" | "workspaceTabs">,
    store: BrowserTabStore,
    surface: (sessionId: string, surfaceId: string) => BrowserViewerSurface | undefined = () =>
      undefined,
  ): Pick<
    HostSnapshot,
    "browserSessions" | "workspaceTabs" | "workspaceTabRestoreVersion" | "browserTabs"
  > {
    const snapshot = this.#previous;
    const heldSessions = new Map(snapshot.browserSessions.map((session) => [session.id, session]));
    const statuses = new Map(_snapshot.browserSessions.map((session) => [session.id, session]));
    const heldGroups = new Map<string, WorkspaceTabLineage>(
      snapshot.workspaceTabs?.map((group) => [group.id, group]),
    );
    const browserSessions: BrowserSessionSummary[] = [];
    const workspaceTabs: WorkspaceTabLineage[] = [];
    for (const id of store.groups().ids) {
      const group = store.group(id)!;
      const previous = heldSessions.get(group.sessionId);
      const status = statuses.get(group.sessionId);
      const heldGroup = heldGroups.get(id);
      const session = this.#session(group);
      const list = store.tabs(id);
      const terminal = group.state === "closed" || group.state === "failed";
      let projected = this.#groups.get(id);
      const revision = store.tabRevision(id);
      if (!projected || projected.revision !== revision) {
        const rows = list.ids.map((tabId) => store.tab(id, tabId)!);
        projected = {
          revision,
          catalog: shared(
            projected?.catalog,
            rows.filter((row) => row.documentId !== null).map((row) => this.#row(row).catalog),
          ),
          durable: shared(
            projected?.durable,
            rows.map((row) => this.#row(row).durable),
          ),
        };
        this.#groups.set(id, projected);
      }
      const catalogTabs = projected.catalog;
      const tabCatalog = list.whole
        ? same(previous?.tabCatalog, {
            generation: 0,
            revision: group.inventoryRevision,
            inventoryRevision: group.inventoryRevision,
            tabs: catalogTabs,
          })
        : undefined;
      const heldTabs = new Map(previous?.tabs.map((tab) => [tab.id, tab]));
      const tabs = shared(
        previous?.tabs,
        catalogTabs.map((row) => {
          const viewed = terminal ? undefined : surface(group.sessionId, row.id);
          return same(heldTabs.get(row.id), {
            id: row.id,
            title: viewed?.title ?? row.title,
            documentId: row.documentId ?? undefined,
            active: false,
            loading: viewed?.loading ?? row.loading,
            sizedByAgent: viewed?.sizedByAgent,
            url: viewed?.url ?? "",
            favicon: viewed?.favicon ?? undefined,
          });
        }),
      );
      browserSessions.push(
        same(previous, {
          ...session,
          browserTabs: store,
          opener: group.opener,
          ...(tabCatalog ? { tabCatalog } : {}),
          dialog: terminal ? null : (status?.dialog ?? null),
          error: status?.error ?? null,
          tabs,
          viewerError: terminal ? null : (status?.viewerError ?? null),
          viewerState: terminal ? "disconnected" : (status?.viewerState ?? "disconnected"),
          watchViewerError: terminal ? null : (status?.watchViewerError ?? null),
          watchViewerState: terminal
            ? "disconnected"
            : (status?.watchViewerState ?? "disconnected"),
        }),
      );
      workspaceTabs.push(
        same(heldGroup, {
          id: group.id,
          revision: group.inventoryRevision,
          createdAt: group.createdAt,
          ...(group.unavailableReason ? { unavailableReason: group.unavailableReason } : {}),
          session,
          whole: list.whole,
          tabs: projected.durable,
        }),
      );
    }
    const ids = new Set(store.groups().ids);
    for (const id of this.#groups.keys()) if (!ids.has(id)) this.#groups.delete(id);
    const result = {
      browserTabs: store,
      workspaceTabRestoreVersion: 1 as const,
      browserSessions: shared(snapshot.browserSessions, browserSessions),
      workspaceTabs: shared(snapshot.workspaceTabs, workspaceTabs),
    };
    this.#previous = result;
    return result;
  }
}

export function groupSession(group: BrowserGroupRow) {
  return {
    id: group.sessionId,
    access: group.access,
    origin: group.origin,
    state: group.state,
    createdAt: group.sessionCreatedAt,
    updatedAt: group.updatedAt,
    workspaceId: group.workspaceId,
    placement: group.placement,
    profileId: group.profileId,
    runtimeId: group.runtimeId,
    opener: group.opener,
    acting: group.acting,
    page: group.page,
    attachedRunIds: group.attachedRunIds,
    threadIds: group.threadIds,
    ...(group.navigation ? { navigationVersion: 1 as const } : {}),
    workspaceTabRestoreVersion: 1 as const,
  };
}

const lineages = new WeakMap<
  BrowserTabStore,
  WeakMap<BrowserGroupRow, { revision: number; value: WorkspaceTabLineage }>
>();

/** Materialize only for callers explicitly requesting a complete lineage. */
export function workspaceTabLineage(
  store: BrowserTabStore,
  id: string,
): WorkspaceTabLineage | null {
  const group = store.group(id);
  if (!group) return null;
  let held = lineages.get(store);
  if (!held) lineages.set(store, (held = new WeakMap()));
  const revision = store.tabRevision(id);
  const previous = held.get(group);
  if (previous?.revision === revision) return previous.value;
  const value: WorkspaceTabLineage = {
    id: group.id,
    revision: group.inventoryRevision,
    createdAt: group.createdAt,
    unavailableReason: group.unavailableReason ?? undefined,
    session: groupSession(group),
    whole: store.tabs(id).whole,
    tabs: store.sessionTabs(group.sessionId).map((tab) => ({
      kind: "browser",
      id: tab.id,
      sessionId: tab.sessionId,
      title: tab.title,
      site: tab.site,
      iconRef: tab.iconRef,
      order: tab.order,
      openerId: tab.openerId,
      state: tab.state,
      createdAt: tab.createdAt,
    })),
  };
  held.set(group, { revision, value });
  return value;
}
