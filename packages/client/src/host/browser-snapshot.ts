import type { BrowserGroupRow } from "@opensteer/protocol/browser-tabs";
import type { BrowserSessionSummary, HostSnapshot, PersonalTabLineage } from "./client.js";
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

export class BrowserSnapshotDerivation {
  #previous: BrowserSessionSummary[] = [];
  #source: readonly BrowserSessionSummary[] | undefined;
  #store: BrowserTabStore | undefined;
  #revision = -1;
  readonly #sessions = new WeakMap<BrowserGroupRow, ReturnType<typeof groupSession>>();

  derive(
    snapshot: Pick<HostSnapshot, "browserSessions">,
    store: BrowserTabStore,
  ): Pick<HostSnapshot, "browserSessions" | "tabRestoreVersion" | "browserTabs"> {
    if (
      this.#store === store &&
      this.#revision === store.groupRevision &&
      (snapshot.browserSessions === this.#source || snapshot.browserSessions === this.#previous)
    )
      return { browserTabs: store, tabRestoreVersion: 1, browserSessions: this.#previous };
    this.#store = store;
    this.#revision = store.groupRevision;
    this.#source = snapshot.browserSessions;
    const previous = new Map(this.#previous.map((session) => [session.id, session]));
    const statuses = new Map(snapshot.browserSessions.map((session) => [session.id, session]));
    const sessions = store.groups().ids.map((id) => {
      const group = store.group(id)!;
      let metadata = this.#sessions.get(group);
      if (!metadata) {
        metadata = groupSession(group);
        this.#sessions.set(group, metadata);
      }
      const terminal = group.state === "closed" || group.state === "failed";
      const status = statuses.get(group.sessionId);
      return same(previous.get(group.sessionId), {
        ...metadata,
        browserTabs: store,
        dialog: terminal ? null : (status?.dialog ?? null),
        error: status?.error ?? null,
        viewerError: terminal ? null : (status?.viewerError ?? null),
        viewerState: terminal ? "disconnected" : (status?.viewerState ?? "disconnected"),
        watchViewerError: terminal ? null : (status?.watchViewerError ?? null),
        watchViewerState: terminal ? "disconnected" : (status?.watchViewerState ?? "disconnected"),
      });
    });
    this.#previous = shared(this.#previous, sessions);
    return { browserTabs: store, tabRestoreVersion: 1, browserSessions: this.#previous };
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

    placement: group.placement,
    profileId: group.profileId,
    runtimeId: group.runtimeId,
    opener: group.opener,
    acting: group.acting,
    page: group.page,
    attachedRunIds: group.attachedRunIds,
    threadIds: group.threadIds,
    ...(group.navigation ? { navigationVersion: 1 as const } : {}),
    tabRestoreVersion: 1 as const,
  };
}

const lineages = new WeakMap<
  BrowserTabStore,
  WeakMap<BrowserGroupRow, { revision: number; value: PersonalTabLineage }>
>();

/** Materialize only for callers explicitly requesting a complete lineage. */
export function personalTabLineage(store: BrowserTabStore, id: string): PersonalTabLineage | null {
  const group = store.group(id);
  if (!group) return null;
  let held = lineages.get(store);
  if (!held) lineages.set(store, (held = new WeakMap()));
  const revision = store.tabRevision(id);
  const previous = held.get(group);
  if (previous?.revision === revision) return previous.value;
  const value: PersonalTabLineage = {
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
