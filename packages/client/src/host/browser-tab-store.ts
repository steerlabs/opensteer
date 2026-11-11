import type { BrowserGroupRow, BrowserTabRow } from "@opensteer/protocol/browser-tabs";
import {
  KeyedStreamReceiver,
  type KeyedStreamMessage,
  type KeyedStreamChanges,
} from "@opensteer/protocol/keyed-stream";

type Listener = () => void;
type List = { readonly ids: readonly string[]; readonly syncing: boolean; readonly whole: boolean };
type Meta = Record<string, never>;
const empty: List = { ids: [], syncing: true, whole: false };
class Rows<Row extends { id: string }> {
  readonly receiver = new KeyedStreamReceiver<Row, Meta>();
  list: List = empty;
  readonly listeners = new Set<Listener>();
  readonly rows = new Map<string, Set<Listener>>();
  readonly #order: (a: Row, b: Row) => number;
  readonly #changed: Listener;
  readonly #removed: ((id: string) => void) | undefined;
  #changes: KeyedStreamChanges | null = null;
  #whole = false;
  constructor(
    order: (a: Row, b: Row) => number,
    changed: Listener,
    removed?: (id: string) => void,
    received?: (change: KeyedStreamChanges) => void,
  ) {
    this.#order = order;
    this.#changed = changed;
    this.#removed = removed;
    this.receiver.onChange((change) => {
      this.#changes = change;
      received?.(change);
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
    if (change) {
      for (const id of change.removed) this.#removed?.(id);
      for (const id of [...change.added, ...change.updated, ...change.removed])
        for (const listener of this.rows.get(id) ?? []) listener();
    }
    if (listChanged) for (const listener of this.listeners) listener();
    if (
      listChanged ||
      (change && (change.added.length || change.updated.length || change.removed.length))
    )
      this.#changed();
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
function rowSubscribe<Row extends { id: string }>(rows: Rows<Row>, id: string, listener: Listener) {
  let listeners = rows.rows.get(id);
  if (!listeners) {
    listeners = new Set();
    rows.rows.set(id, listeners);
  }
  const release = subscribe(listeners, listener);
  return () => {
    release();
    if (!listeners.size) rows.rows.delete(id);
  };
}
export class BrowserTabStore {
  readonly #listeners = new Set<Listener>();
  readonly #tabs = new Map<string, Rows<BrowserTabRow>>();
  readonly #sessionGroups = new Map<string, string>();
  readonly #groupSessions = new Map<string, string>();
  readonly #groups = new Rows<BrowserGroupRow>(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
    () => this.#changed(),
    (id) => this.#drop(id),
    (change) => {
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
    },
  );
  readonly resync: (groupId?: string) => void;
  constructor(resync: (groupId?: string) => void = () => {}) {
    this.resync = resync;
  }
  revision = 0;
  #changed() {
    this.revision++;
    for (const listener of this.#listeners) listener();
  }
  #prune(id: string) {
    const rows = this.#tabs.get(id);
    if (!this.group(id) && rows && !rows.listeners.size && !rows.rows.size) this.#tabs.delete(id);
  }
  #drop(id: string) {
    this.#tabs.get(id)?.seed([]);
    this.#prune(id);
  }
  #ensure(id: string) {
    let rows = this.#tabs.get(id);
    if (!rows) {
      rows = new Rows<BrowserTabRow>(
        (a, b) => a.order - b.order || a.id.localeCompare(b.id),
        () => this.#changed(),
      );
      this.#tabs.set(id, rows);
    }
    return rows;
  }
  groups = (): List => this.#groups.list;
  group = (id: string) => this.#groups.receiver.rows.get(id);
  tabs = (groupId: string): List => this.#tabs.get(groupId)?.list ?? empty;
  tab = (groupId: string, tabId: string) => this.#tabs.get(groupId)?.receiver.rows.get(tabId);
  subscribe = (listener: Listener) => subscribe(this.#listeners, listener);
  subscribeGroups = (listener: Listener) => subscribe(this.#groups.listeners, listener);
  subscribeGroup = (id: string, listener: Listener) => rowSubscribe(this.#groups, id, listener);
  subscribeTabs = (id: string, listener: Listener) => {
    const release = subscribe(this.#ensure(id).listeners, listener);
    return () => {
      release();
      this.#prune(id);
    };
  };
  subscribeTab = (groupId: string, tabId: string, listener: Listener) => {
    const release = rowSubscribe(this.#ensure(groupId), tabId, listener);
    return () => {
      release();
      this.#prune(groupId);
    };
  };
  sessionTabs(sessionId: string) {
    const id = this.groupForSession(sessionId);
    return id ? this.tabs(id).ids.map((tabId) => this.tab(id, tabId)!) : [];
  }
  groupForSession(sessionId: string) {
    return this.#sessionGroups.get(sessionId);
  }
  seed(prefix: {
    groups: { rows: readonly BrowserGroupRow[]; complete: boolean };
    tabs: readonly { groupId: string; rows: readonly BrowserTabRow[]; complete: boolean }[];
  }) {
    if (this.#groups.receiver.state !== "empty" || this.#groups.receiver.rows.size) return;
    this.#groups.seed(prefix.groups.rows, prefix.groups.complete);
    for (const group of prefix.tabs)
      if (this.group(group.groupId)) this.#ensure(group.groupId).seed(group.rows, group.complete);
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
    this.#groups.seed([]);
    for (const id of this.#tabs.keys()) this.#drop(id);
    this.#changed();
  }
}
