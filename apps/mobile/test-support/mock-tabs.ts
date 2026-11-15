import type { HostClient, TabsClient, TabsReadModel } from "@opensteer/client/host";
import {
  AppIdSchema,
  RunnerIdSchema,
  TabGroupIdSchema,
  TabIdSchema,
  ThreadIdSchema,
  type App,
  type AppId,
  type Tab,
  type TabGroup,
  type TabId,
  type TabLayout,
  type TabTarget,
} from "@opensteer/core";
import type { TabOrganizeInput, TabViewer } from "@opensteer/protocol";

/*
 * The frozen tabs contracts over a MockHostClient, for mobile tests until the
 * shared mock implements them. Commands apply the Host's documented layout
 * rules closely enough to drive the screens; they are not the Host.
 */

export const computerId = RunnerIdSchema.parse("rnr_00000000-0000-4000-8000-00000000000a");
const at = "2026-11-15T12:00:00.000Z";

export const tabId = (name: string): TabId => TabIdSchema.parse(`tab_${name}`);
export const groupId = (n: number): TabGroup["groupId"] =>
  TabGroupIdSchema.parse(`tgp_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
export const appId = (n: number): AppId =>
  AppIdSchema.parse(`app_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);

const base = (name: string, title: string): Omit<Tab, "kind"> => ({
  computer: { computerId, name: "Studio Mac" },
  createdAt: at,
  groupId: null,
  openedBy: "person",
  state: "open",
  tabId: tabId(name),
  title,
  updatedAt: at,
  usedBy: [],
});

export function pageTab(name: string, title: string, extra: Partial<Tab> = {}): Tab {
  return {
    ...base(name, title),
    kind: "page",
    profile: null,
    url: `https://${name}.test/`,
    ...extra,
  };
}
export function windowTab(name: string, title: string, extra: Partial<Tab> = {}): Tab {
  return {
    ...base(name, title),
    appName: "Notes",
    bundleId: "com.apple.Notes",
    kind: "window",
    ...extra,
  };
}
export function phoneTab(name: string, extra: Partial<Tab> = {}): Tab {
  return { ...base(name, "Pixel"), kind: "phone", ...extra };
}
export function appTab(name: string, app: AppId, extra: Partial<Tab> = {}): Tab {
  return { ...base(name, name), appId: app, kind: "app", ...extra };
}
export function usedBy(...threadIds: string[]): Tab["usedBy"] {
  return threadIds
    .map((id) => ({ taskId: ThreadIdSchema.parse(id) }))
    .sort((a, b) => a.taskId.localeCompare(b.taskId));
}

export function serverApp(n: number, extra: Partial<App> = {}): App {
  return {
    appId: appId(n),
    computerId,
    createdAt: at,
    folder: `apps/app-${n}`,
    kind: "server",
    localUrl: `http://127.0.0.1:${49152 + n}`,
    name: `App ${n}`,
    server: {
      desiredState: "running",
      generation: 1,
      lastError: null,
      port: 49152 + n,
      state: "running",
    },
    start: "node server.js",
    state: "running",
    taskId: null,
    updatedAt: at,
    version: 1,
    ...extra,
  };
}

export class FakeTabs implements TabsReadModel {
  rows = new Map<TabId, Tab>();
  layout: TabLayout = { items: [], revision: 0 };
  complete = true;
  syncing = false;
  readonly #listeners = new Set<() => void>();
  readonly #rowListeners = new Map<TabId, Set<() => void>>();

  get = (id: TabId): Tab | undefined => this.rows.get(id);
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  subscribeTab = (id: TabId, listener: () => void): (() => void) => {
    const set = this.#rowListeners.get(id) ?? new Set();
    set.add(listener);
    this.#rowListeners.set(id, set);
    return () => set.delete(listener);
  };

  /** Replace everything, as a stream reset does. */
  reset(tabs: readonly Tab[], layout: TabLayout["items"]): void {
    this.rows = new Map(tabs.map((tab) => [tab.tabId, this.#grouped(tab, layout)]));
    this.layout = { items: layout, revision: this.layout.revision + 1 };
    this.#emit(tabs.map((tab) => tab.tabId));
  }
  /** One row's change, as a stream patch does: the layout is untouched. */
  patch(tab: Tab): void {
    this.rows = new Map(this.rows).set(tab.tabId, this.#grouped(tab, this.layout.items));
    for (const listener of this.#rowListeners.get(tab.tabId) ?? []) listener();
    for (const listener of this.#listeners) listener();
  }
  setLayout(items: TabLayout["items"]): void {
    const ids = new Set(
      items.flatMap((item) => (item.kind === "tab" ? [item.tabId] : item.group.tabIds)),
    );
    const rows = new Map<TabId, Tab>();
    for (const [id, tab] of this.rows) if (ids.has(id)) rows.set(id, this.#grouped(tab, items));
    const changed = [...this.rows.keys()];
    this.rows = rows;
    this.layout = { items, revision: this.layout.revision + 1 };
    this.#emit(changed);
  }
  #grouped(tab: Tab, items: TabLayout["items"]): Tab {
    const group = items.find(
      (item) => item.kind === "group" && item.group.tabIds.includes(tab.tabId),
    );
    return { ...tab, groupId: group?.kind === "group" ? group.group.groupId : null };
  }
  #emit(ids: readonly TabId[]): void {
    for (const id of ids) for (const listener of this.#rowListeners.get(id) ?? []) listener();
    for (const listener of this.#listeners) listener();
  }
}

export interface MockTabs {
  readonly model: FakeTabs;
  readonly calls: Array<{ readonly method: keyof TabsClient; readonly args: readonly unknown[] }>;
  apps: App[];
  /** The next call of this method fails with this message, once. */
  failNext(method: keyof TabsClient, message: string): void;
  /** Holds the next call of this method until `release` is called. */
  holdNext(method: keyof TabsClient): { release: () => void };
  bumpAppsRevision(): void;
}

/** Puts the tabs contracts on a mock client: its snapshot carries `tabs`, it answers TabsClient. */
export function attachMockTabs(
  hostClient: HostClient,
  initial: {
    readonly tabs: readonly Tab[];
    readonly layout: TabLayout["items"];
    readonly apps?: App[];
  },
): MockTabs {
  const model = new FakeTabs();
  model.reset(initial.tabs, initial.layout);
  let appsRevision = 0;
  const legacy = hostClient.getSnapshot.bind(hostClient);
  // One view per (snapshot, apps revision), so identity-equal reads stay equal;
  // a Proxy, so a test that edits its snapshot in place is still seen.
  const wrapped = new WeakMap<object, { readonly revision: number; readonly view: object }>();
  Object.defineProperty(hostClient, "getSnapshot", {
    configurable: true,
    value: () => {
      const snapshot = legacy();
      const held = wrapped.get(snapshot);
      if (held?.revision === appsRevision) return held.view;
      const revision = appsRevision;
      const view = new Proxy(snapshot, {
        get: (target, key, receiver) =>
          key === "tabs"
            ? model
            : key === "appsRevision"
              ? revision
              : Reflect.get(target, key, receiver),
      });
      wrapped.set(snapshot, { revision, view });
      return view;
    },
  });
  const failures = new Map<keyof TabsClient, string>();
  const holds = new Map<keyof TabsClient, Promise<void>>();
  const calls: MockTabs["calls"] = [];
  const state: MockTabs = {
    apps: [...(initial.apps ?? [])],
    bumpAppsRevision() {
      appsRevision += 1;
      // Any listener of the client re-reads; the mock's own subscribers hear its next change.
      for (const listener of snapshotListeners) listener();
    },
    calls,
    failNext(method, message) {
      failures.set(method, message);
    },
    holdNext(method) {
      let release!: () => void;
      holds.set(method, new Promise<void>((resolve) => (release = resolve)));
      return { release: () => release() };
    },
    model,
  };
  const snapshotListeners = new Set<() => void>();
  const subscribe = hostClient.subscribe.bind(hostClient);
  Object.defineProperty(hostClient, "subscribe", {
    configurable: true,
    value: (listener: () => void) => {
      snapshotListeners.add(listener);
      const stop = subscribe(listener);
      return () => {
        snapshotListeners.delete(listener);
        stop();
      };
    },
  });
  const step = async (method: keyof TabsClient, args: readonly unknown[]) => {
    calls.push({ args, method });
    const hold = holds.get(method);
    if (hold) {
      holds.delete(method);
      await hold;
    }
    const failure = failures.get(method);
    if (failure !== undefined) {
      failures.delete(method);
      throw new Error(failure);
    }
  };
  const items = () => model.layout.items;
  const without = (ids: readonly TabId[]) =>
    items()
      .filter((item) => item.kind === "group" || !ids.includes(item.tabId))
      .map((item) =>
        item.kind === "group"
          ? {
              ...item,
              group: { ...item.group, tabIds: item.group.tabIds.filter((id) => !ids.includes(id)) },
            }
          : item,
      );
  const closed: Tab[] = [];
  const client: TabsClient = {
    async activateTab(id): Promise<TabViewer> {
      await step("activateTab", [id]);
      const tab = model.get(id);
      if (!tab) throw new Error("This tab is closed.");
      if (tab.kind === "app") return { appId: tab.appId!, kind: "app" };
      if (tab.kind === "page")
        return { kind: "page", sessionId: "bsn_mock" as never, surfaceId: tab.tabId };
      throw new Error("This mock does not open native views.");
    },
    async closeTabs(ids) {
      await step("closeTabs", [ids]);
      for (const id of ids) {
        const tab = model.get(id);
        if (tab) closed.push(tab);
      }
      model.setLayout(without(ids));
      return { closed: [...ids], failed: [] };
    },
    async deleteApp(id) {
      await step("deleteApp", [id]);
      state.apps = state.apps.filter((app) => app.appId !== id);
    },
    async deleteTabGroup(id) {
      await step("deleteTabGroup", [id]);
      model.setLayout(
        items().flatMap((item) =>
          item.kind === "group" && item.group.groupId === id
            ? item.group.tabIds.map((tabId) => ({ kind: "tab" as const, tabId }))
            : [item],
        ),
      );
    },
    async listApps(query) {
      await step("listApps", [query]);
      return state.apps;
    },
    async openTab(target: TabTarget) {
      await step("openTab", [target]);
      const existing = [...model.rows.values()].find(
        (tab) =>
          (target.kind === "app" && tab.appId === target.appId) ||
          (target.kind === "phone" &&
            tab.kind === "phone" &&
            tab.computer.computerId === target.computerId),
      );
      if (existing) return existing;
      const tab =
        target.kind === "app"
          ? appTab(`opened_${target.appId.slice(-4)}`, target.appId)
          : target.kind === "phone"
            ? phoneTab(`phone_${target.computerId}`)
            : target.kind === "page"
              ? pageTab(`opened_${model.rows.size}`, target.url)
              : windowTab(`window_${model.rows.size}`, "Window");
      model.rows.set(tab.tabId, tab);
      model.setLayout([...items(), { kind: "tab", tabId: tab.tabId }]);
      return tab;
    },
    async organizeTabs(input: TabOrganizeInput) {
      await step("organizeTabs", [input]);
      let next = without(input.tabIds);
      const block = input.tabIds.map((tabId) => ({ kind: "tab" as const, tabId }));
      if (input.group === null) {
        const at =
          input.beforeTabId === undefined
            ? -1
            : next.findIndex((item) => item.kind === "tab" && item.tabId === input.beforeTabId);
        next = at < 0 ? [...next, ...block] : [...next.slice(0, at), ...block, ...next.slice(at)];
      } else if ("groupId" in input.group) {
        const { groupId: id } = input.group;
        next = next.map((item) => {
          if (item.kind !== "group" || item.group.groupId !== id) return item;
          const ids = item.group.tabIds;
          const at = input.beforeTabId === undefined ? -1 : ids.indexOf(input.beforeTabId);
          const tabIds =
            at < 0
              ? [...ids, ...input.tabIds]
              : [...ids.slice(0, at), ...input.tabIds, ...ids.slice(at)];
          return { ...item, group: { ...item.group, tabIds } };
        });
      } else {
        next = [
          ...next,
          {
            group: {
              collapsed: false,
              color: input.group.color,
              groupId: groupId(next.length + 90),
              name: input.group.name,
              tabIds: input.tabIds,
            },
            kind: "group" as const,
          },
        ];
      }
      model.setLayout(next);
      return { groups: [], tabs: input.tabIds.flatMap((id) => model.get(id) ?? []) };
    },
    async renameApp(id, name) {
      await step("renameApp", [id, name]);
      return updateApp(id, { name });
    },
    async reopenTab(id) {
      await step("reopenTab", [id]);
      const tab = id === undefined ? closed.pop() : closed.find((row) => row.tabId === id);
      if (!tab) throw new Error("There is no closed tab to reopen.");
      model.rows.set(tab.tabId, tab);
      model.setLayout([...items(), { kind: "tab", tabId: tab.tabId }]);
      return tab;
    },
    async startApp(id) {
      await step("startApp", [id]);
      return updateApp(id, { state: "running" });
    },
    async stopApp(id) {
      await step("stopApp", [id]);
      return updateApp(id, { state: "stopped" });
    },
    async updateTabGroup(input) {
      await step("updateTabGroup", [input]);
      const current = model.layout.items.find(
        (item) => item.kind === "group" && item.group.groupId === input.groupId,
      );
      if (current?.kind !== "group") throw new Error("This group no longer exists.");
      const updated: TabGroup = {
        ...current.group,
        name: input.name ?? current.group.name,
        color: input.color ?? current.group.color,
        collapsed: input.collapsed ?? current.group.collapsed,
      };
      model.setLayout(
        items().map((item) => (item === current ? { group: updated, kind: "group" } : item)),
      );
      return updated;
    },
  };
  const updateApp = (id: AppId, change: Partial<App>): App => {
    const app = state.apps.find((row) => row.appId === id);
    if (!app) throw new Error("This app no longer exists.");
    const next = { ...app, ...change };
    state.apps = state.apps.map((row) => (row.appId === id ? next : row));
    return next;
  };
  Object.assign(hostClient, client);
  return state;
}
