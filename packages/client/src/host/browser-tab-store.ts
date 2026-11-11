import type {
  BrowserGroupRow,
  BrowserTabRow,
  BrowserViewerSurface,
} from "@opensteer/protocol/browser-tabs";
import {
  KeyedStreamReceiver,
  equal,
  type KeyedStreamMessage,
  type KeyedStreamChanges,
} from "@opensteer/protocol/keyed-stream";

type Listener = () => void;
export interface BrowserTabKey {
  readonly groupId: string;
  readonly tabId: string;
  readonly sessionId: string;
  readonly openerId: string | null;
  readonly order: number;
  readonly createdAt: string;
  readonly lineageCreatedAt: string;
}
export type BrowserTabList = {
  readonly ids: readonly string[];
  readonly syncing: boolean;
  readonly whole: boolean;
};
type Meta = Record<string, never>;
const noKeys: readonly BrowserTabKey[] = [];
const noRows: readonly BrowserTabRow[] = [];
const empty: BrowserTabList = { ids: [], syncing: true, whole: false };
class Rows<Row extends { id: string }> {
  readonly receiver = new KeyedStreamReceiver<Row, Meta>();
  list: BrowserTabList = empty;
  readonly listeners = new Set<Listener>();
  readonly rows = new Map<string, Set<Listener>>();
  readonly #order: (a: Row, b: Row) => number;
  readonly #changed: (
    structural: boolean,
    change: KeyedStreamChanges | null,
    fields: ReadonlySet<keyof Row>,
  ) => void;
  readonly #previous = new Map<string, Row>();
  #fields = new Set<keyof Row>();
  readonly #structureKeys: readonly (keyof Row)[];
  readonly #removed: ((id: string) => void) | undefined;
  #changes: KeyedStreamChanges | null = null;
  #whole = false;
  revision = 0;
  constructor(
    order: (a: Row, b: Row) => number,
    changed: (
      structural: boolean,
      change: KeyedStreamChanges | null,
      fields: ReadonlySet<keyof Row>,
    ) => void,
    structureKeys: readonly (keyof Row)[],
    removed?: (id: string) => void,
    received?: (change: KeyedStreamChanges, fields: ReadonlySet<keyof Row>) => void,
  ) {
    this.#order = order;
    this.#changed = changed;
    this.#structureKeys = structureKeys;
    this.#removed = removed;
    this.receiver.onChange((change) => {
      this.#fields = new Set();
      for (const id of change.removed) this.#previous.delete(id);
      for (const id of [...change.added, ...change.updated]) {
        const row = this.receiver.rows.get(id)!;
        const before = this.#previous.get(id);
        for (const key of new Set([...Object.keys(before ?? {}), ...Object.keys(row)]) as Set<
          keyof Row
        >)
          if (!before || !equal(before[key], row[key])) this.#fields.add(key);
        if (this.#structureKeys.some((key) => this.#fields.has(key))) change.structural = true;
        this.#previous.set(id, row);
      }
      this.#changes = change;
      received?.(change, this.#fields);
    });
  }
  #flush() {
    const change = this.#changes;
    this.#changes = null;
    const syncing = this.receiver.state !== "committed";
    const listChanged =
      change?.structural || syncing !== this.list.syncing || this.#whole !== this.list.whole;
    if (listChanged)
      this.list = {
        ids: change?.structural
          ? [...this.receiver.rows.values()].sort(this.#order).map((row) => row.id)
          : this.list.ids,
        syncing,
        whole: this.#whole,
      };
    if (change) for (const id of change.removed) this.#removed?.(id);
    const changed =
      listChanged ||
      !!(change && (change.added.length || change.updated.length || change.removed.length));
    if (changed) {
      this.revision++;
      this.#changed(change?.structural ?? false, change, this.#fields);
    }
    if (change) {
      for (const id of [...change.added, ...change.updated, ...change.removed])
        for (const listener of this.rows.get(id) ?? []) listener();
    }
    if (listChanged) for (const listener of this.listeners) listener();
  }

  apply(message: KeyedStreamMessage<Row, Meta>) {
    const result = this.receiver.apply(message);
    if (result === "applied") this.#whole = true;
    this.#flush();
    return result;
  }
  seed(rows: readonly Row[], complete = false) {
    this.#whole = complete;
    this.receiver.seed(rows, {});
    this.#flush();
  }
  disconnected() {
    this.receiver.stale();
    this.#flush();
  }
}

function subscribe(listeners: Set<Listener>, listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function keySubscribe(rows: Map<string, Set<Listener>>, id: string, listener: Listener) {
  let listeners = rows.get(id);
  if (!listeners) {
    listeners = new Set();
    rows.set(id, listeners);
  }
  const release = subscribe(listeners, listener);
  return () => {
    release();
    if (!listeners.size) rows.delete(id);
  };
}

export class BrowserTabStore {
  readonly #listeners = new Set<Listener>();
  readonly #structureListeners = new Set<Listener>();
  readonly #tabChangeListeners = new Set<(groupId: string, ids: readonly string[]) => void>();
  readonly #occupancyRevisions = new Map<string, number>();
  groupRevision = 0;
  targetRevision = 0;
  filterRevision = 0;
  #structure: readonly BrowserTabKey[] | undefined;
  #groupKeys = new Map<string, readonly BrowserTabKey[]>();
  #keys = new Map<string, BrowserTabKey>();
  readonly #sessionRows = new Map<string, { revision: number; rows: readonly BrowserTabRow[] }>();
  readonly #tabGroups = new Map<string, Set<string>>();
  readonly #tabs = new Map<string, Rows<BrowserTabRow>>();
  readonly #changedSessions = new Set<string>();
  readonly #sessionListeners = new Map<string, Set<Listener>>();
  readonly #sessionGroups = new Map<string, string>();
  readonly #groupSessions = new Map<string, string>();
  readonly #groups = new Rows<BrowserGroupRow>(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
    (structural, change, fields) => {
      if (change) {
        this.groupRevision++;
        if (change.structural || fields.has("profileId") || fields.has("placement"))
          this.filterRevision++;
        if (
          change.added.length ||
          change.removed.length ||
          [
            "sessionId",
            "state",
            "workspaceId",
            "profileId",
            "placement",
            "unavailableReason",
            "opener",
          ].some((key) => fields.has(key as keyof BrowserGroupRow))
        )
          this.targetRevision++;
      }
      this.#changed(structural);
    },
    ["sessionId", "createdAt", "placement", "profileId"],
    (id) => this.#drop(id),
    (change) => {
      const previous = new Map<string, string | undefined>();
      for (const id of [...change.removed, ...change.updated]) {
        const sessionId = this.#groupSessions.get(id);
        if (sessionId) previous.set(sessionId, this.#sessionGroups.get(sessionId));
      }
      for (const id of [...change.added, ...change.updated]) {
        const sessionId = this.group(id)!.sessionId;
        if (!previous.has(sessionId)) previous.set(sessionId, this.#sessionGroups.get(sessionId));
      }
      for (const id of [...change.removed, ...change.updated]) {
        const sessionId = this.#groupSessions.get(id);
        if (sessionId) this.#sessionGroups.delete(sessionId);
        this.#groupSessions.delete(id);
      }
      for (const id of [...change.added, ...change.updated]) {
        const sessionId = this.group(id)!.sessionId;
        this.#sessionGroups.set(sessionId, id);
        this.#groupSessions.set(id, sessionId);
      }
      for (const [sessionId, before] of previous)
        if (before !== this.#sessionGroups.get(sessionId)) this.#changedSessions.add(sessionId);
    },
  );
  readonly resync: (groupId?: string) => void;
  readonly surface: (sessionId: string, tabId: string) => BrowserViewerSurface | undefined;
  constructor(
    resync: (groupId?: string) => void = () => {},
    surface: (sessionId: string, tabId: string) => BrowserViewerSurface | undefined = () =>
      undefined,
  ) {
    this.resync = resync;
    this.surface = surface;
  }
  revision = 0;
  #changed(structural = false, tabs?: { groupId: string; ids: readonly string[] }) {
    this.revision++;
    if (structural) this.#structure = undefined;
    if (tabs) for (const listener of this.#tabChangeListeners) listener(tabs.groupId, tabs.ids);
    if (structural) for (const listener of this.#structureListeners) listener();
    const sessions = [...this.#changedSessions];
    this.#changedSessions.clear();
    for (const sessionId of sessions)
      for (const listener of this.#sessionListeners.get(sessionId) ?? []) listener();
    for (const listener of this.#listeners) listener();
  }
  #prune(id: string) {
    const rows = this.#tabs.get(id);
    if (!this.group(id) && rows && !rows.listeners.size && !rows.rows.size) {
      this.#tabs.delete(id);
      this.#occupancyRevisions.delete(id);
    }
  }
  #drop(id: string) {
    this.#sessionRows.delete(id);
    this.#tabs.get(id)?.seed([]);
    this.#prune(id);
  }
  #ensure(id: string) {
    let rows = this.#tabs.get(id);
    if (!rows) {
      const occupied = new Set<string>();
      rows = new Rows<BrowserTabRow>(
        (a, b) => a.order - b.order || a.id.localeCompare(b.id),
        (structural, change, fields) => {
          if (change) {
            if (change.added.length || change.removed.length || fields.has("occupants")) {
              this.#occupancyRevisions.set(id, this.occupancyRevision(id) + 1);
            }
            if (
              change.added.length ||
              change.removed.length ||
              ["sessionId", "documentId", "state", "availability"].some((key) =>
                fields.has(key as keyof BrowserTabRow),
              )
            )
              this.targetRevision++;
          }
          this.#changed(
            structural,
            change
              ? { groupId: id, ids: [...change.added, ...change.updated, ...change.removed] }
              : undefined,
          );
        },
        ["order", "openerId", "sessionId", "createdAt"],
        (tabId) => {
          const groups = this.#tabGroups.get(tabId);
          groups?.delete(id);
          if (!groups?.size) this.#tabGroups.delete(tabId);
        },
        (change, fields) => {
          if (change.added.length || change.removed.length || fields.has("occupants"))
            for (const tabId of [...change.added, ...change.updated, ...change.removed]) {
              const present =
                this.tab(id, tabId)?.occupants.some(
                  (occupant) => occupant.holding || occupant.acting,
                ) ?? false;
              if (present !== occupied.has(tabId)) this.filterRevision++;
              if (present) occupied.add(tabId);
              else occupied.delete(tabId);
            }
          for (const tabId of change.added) {
            const groups = this.#tabGroups.get(tabId) ?? new Set<string>();
            groups.add(id);
            this.#tabGroups.set(tabId, groups);
          }
        },
      );
      this.#tabs.set(id, rows);
    }
    return rows;
  }
  groups = (): BrowserTabList => this.#groups.list;
  group = (id: string) => this.#groups.receiver.rows.get(id);
  tabs = (groupId: string): BrowserTabList => this.#tabs.get(groupId)?.list ?? empty;
  tabRevision = (groupId: string) => this.#tabs.get(groupId)?.revision ?? 0;
  tab = (groupId: string, tabId: string) => this.#tabs.get(groupId)?.receiver.rows.get(tabId);
  occupancyRevision = (groupId: string) => this.#occupancyRevisions.get(groupId) ?? 0;
  subscribeTabChanges = (listener: (groupId: string, ids: readonly string[]) => void) => {
    this.#tabChangeListeners.add(listener);
    return () => {
      this.#tabChangeListeners.delete(listener);
    };
  };
  subscribe = (listener: Listener) => subscribe(this.#listeners, listener);
  subscribeGroups = (listener: Listener) => subscribe(this.#groups.listeners, listener);
  subscribeGroup = (id: string, listener: Listener) =>
    keySubscribe(this.#groups.rows, id, listener);
  subscribeTabs = (id: string, listener: Listener) => {
    const release = subscribe(this.#ensure(id).listeners, listener);
    return () => {
      release();
      this.#prune(id);
    };
  };
  subscribeTab = (groupId: string, tabId: string, listener: Listener) => {
    const release = keySubscribe(this.#ensure(groupId).rows, tabId, listener);
    return () => {
      release();
      this.#prune(groupId);
    };
  };
  subscribeSessionGroup = (sessionId: string, listener: Listener) =>
    keySubscribe(this.#sessionListeners, sessionId, listener);
  subscribeStructure = (listener: Listener) => subscribe(this.#structureListeners, listener);
  structure = (): readonly BrowserTabKey[] => {
    if (this.#structure) return this.#structure;
    const keys = new Map<string, BrowserTabKey>();
    const result: BrowserTabKey[] = [];
    const groupKeys = new Map<string, readonly BrowserTabKey[]>();
    for (const groupId of this.groups().ids) {
      const start = result.length;
      const group = this.group(groupId)!;
      const ids = this.tabs(groupId).ids;
      const children = new Map<string, string[]>();
      for (const id of ids) {
        const parent = this.tab(groupId, id)!.openerId;
        if (parent && this.tab(groupId, parent)) {
          const list = children.get(parent) ?? [];
          list.push(id);
          children.set(parent, list);
        }
      }
      const seen = new Set<string>();
      const append = (roots: readonly string[]) => {
        const pending = [...roots].reverse();
        while (pending.length) {
          const tabId = pending.pop()!;
          if (seen.has(tabId)) continue;
          seen.add(tabId);
          const tab = this.tab(groupId, tabId)!;
          const next = {
            groupId,
            tabId,
            sessionId: tab.sessionId,
            openerId: tab.openerId,
            order: tab.order,
            createdAt: tab.createdAt,
            lineageCreatedAt: group.createdAt,
          };
          const key = `${groupId}:${tabId}`;
          const before = this.#keys.get(key);
          const kept = before && equal(before, next) ? before : next;
          keys.set(key, kept);
          result.push(kept);
          const descendants = children.get(tabId);
          if (descendants)
            for (let i = descendants.length - 1; i >= 0; i--) pending.push(descendants[i]!);
        }
      };
      append(
        ids.filter((id) => {
          const parent = this.tab(groupId, id)!.openerId;
          return !parent || !this.tab(groupId, parent);
        }),
      );
      append(ids);
      const next = result.slice(start);
      const previous = this.#groupKeys.get(groupId);
      groupKeys.set(
        groupId,
        previous?.length === next.length && next.every((key, i) => key === previous[i])
          ? previous
          : next,
      );
    }
    this.#groupKeys = groupKeys;
    this.#keys = keys;
    this.#structure = result;
    return result;
  };
  sessionStructure = (sessionId: string): readonly BrowserTabKey[] => {
    this.structure();
    const groupId = this.groupForSession(sessionId);
    return (groupId ? this.#groupKeys.get(groupId) : undefined) ?? noKeys;
  };
  groupForTab = (tabId: string) => {
    const groups = this.#tabGroups.get(tabId);
    return groups?.size === 1 ? groups.values().next().value : undefined;
  };
  sessionTab = (sessionId: string, tabId: string) => {
    const groupId = this.groupForSession(sessionId);
    return groupId ? this.tab(groupId, tabId) : undefined;
  };
  sessionList = (sessionId: string) => {
    const groupId = this.groupForSession(sessionId);
    return groupId ? this.tabs(groupId) : empty;
  };
  inventory = (sessionId: string) => {
    const groupId = this.groupForSession(sessionId);
    const group = groupId ? this.group(groupId) : undefined;
    return group
      ? {
          generation: 0,
          revision: group.inventoryRevision,
          inventoryRevision: group.inventoryRevision,
        }
      : undefined;
  };
  sessionTabs(sessionId: string): readonly BrowserTabRow[] {
    const id = this.groupForSession(sessionId);
    if (!id) return noRows;
    const revision = this.tabRevision(id);
    const previous = this.#sessionRows.get(id);
    if (previous?.revision === revision) return previous.rows;
    const next = this.tabs(id).ids.map((tabId) => this.tab(id, tabId)!);
    const rows =
      previous?.rows.length === next.length && next.every((row, i) => row === previous.rows[i])
        ? previous.rows
        : next;
    this.#sessionRows.set(id, { revision, rows });
    return rows;
  }
  groupForSession(sessionId: string) {
    return this.#sessionGroups.get(sessionId);
  }
  seed(prefix: {
    groups: { rows: readonly BrowserGroupRow[]; complete: boolean };
    tabs: readonly { groupId: string; rows: readonly BrowserTabRow[]; complete: boolean }[];
  }) {
    if (this.#groups.receiver.state !== "empty" || this.#groups.receiver.rows.size) return false;
    this.#groups.seed(prefix.groups.rows, prefix.groups.complete);
    for (const group of prefix.tabs)
      if (this.group(group.groupId)) this.#ensure(group.groupId).seed(group.rows, group.complete);
    return true;
  }
  applyGroups(message: KeyedStreamMessage<BrowserGroupRow, Meta>) {
    if (this.#groups.apply(message) === "resync") this.resync();
  }
  applyTabs(groupId: string, message: KeyedStreamMessage<BrowserTabRow, Meta>) {
    if (this.group(groupId) && this.#ensure(groupId).apply(message) === "resync")
      this.resync(groupId);
  }
  disconnected() {
    this.#groups.disconnected();
    for (const rows of this.#tabs.values()) rows.disconnected();
    this.#changed();
  }
  clear() {
    this.#keys.clear();
    this.#groups.seed([]);
    for (const id of this.#tabs.keys()) this.#drop(id);
    this.#changed();
  }
}
