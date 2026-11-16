import {
  AppIdSchema,
  TabSchema,
  TabGroupColorSchema,
  createId,
  type App,
  type AppId,
  type Tab,
  type TabGroup,
  type TabGroupId,
  type TabId,
  type TabLayout,
  type TabTarget,
  type ToolError,
} from "@opensteer/core";
import type {
  TabCloseResult,
  TabGroupUpdateInput,
  TabOrganizeInput,
  TabStream,
} from "@opensteer/protocol";
import { KeyedStreamPublisher } from "@opensteer/protocol/keyed-stream";
import { HostClientRequestError, type HostSnapshot } from "../host/client.js";
import { layoutTabIds, TabStore } from "../host/tab-store.js";
import type { MockBrowserSource } from "./mock-browser-source.js";
import { mockBrowserRows } from "./mock-browser-stream.js";

type LayoutItem = TabLayout["items"][number];
type NativeKind = "window" | "phone" | "app";
/** A window, phone or app tab the mock Host keeps; pages come from its browser world. */
export interface MockNativeTab {
  readonly tabId: TabId;
  readonly kind: NativeKind;
  readonly computerId: string;
  readonly title: string;
  readonly appName?: string;
  readonly bundleId?: string;
  readonly appId?: AppId;
  readonly openedBy: Tab["openedBy"];
  readonly createdAt: string;
  /** A scripted window the person can no longer reach, as the Host reports one. */
  readonly closedWindow?: boolean;
}

function fail(code: string, message: string, status: number): never {
  throw new HostClientRequestError({ code, message, status });
}

/**
 * The mock Host's tab catalog: page tabs from its browser world, native and
 * app tabs it keeps itself, one layout over all of them, and the same keyed
 * stream the real Host sends, applied to the client's store.
 */
export class MockTabCatalog {
  readonly store = new TabStore();
  readonly #native = new Map<TabId, MockNativeTab>();
  /** Page tabs closed from the list; the browser world keeps their pages. */
  readonly #hiddenPages = new Set<TabId>();
  readonly #closed: {
    readonly tabId: TabId;
    readonly groupId: TabGroupId | null;
    readonly beforeTabId: TabId | null;
    readonly native?: MockNativeTab;
  }[] = [];
  #items: LayoutItem[] = [];
  #revision = 1;
  #rows = new Map<TabId, Tab>();
  readonly #publisher = new KeyedStreamPublisher<Tab, { layout: TabLayout }, "tabId">({
    key: "tabId",
    ids: () => this.#rows.keys(),
    read: (id) => this.#rows.get(id as TabId),
    meta: () => ({ layout: this.layout() }),
    targetBytes: 64 * 1024,
    envelopeBytes: 200,
  });
  #started = false;
  #snapshot: (() => HostSnapshot) | null = null;
  #apps: (() => readonly App[]) | null = null;

  bind(snapshot: () => HostSnapshot, apps: () => readonly App[]): void {
    this.#snapshot = snapshot;
    this.#apps = apps;
  }
  layout(): TabLayout {
    return { revision: this.#revision, items: this.#items };
  }
  addNative(tab: MockNativeTab, groupId?: TabGroupId): void {
    this.#native.set(tab.tabId, tab);
    this.#place(tab.tabId, groupId ?? null, null);
  }
  /** Seeds a group over tabs already listed, as a person would have arranged it. */
  group(name: string, color: TabGroup["color"], tabIds: readonly TabId[]): TabGroupId {
    const groupId = createId("tabGroup");
    const ids = new Set(tabIds);
    const first = this.#items.findIndex((item) =>
      item.kind === "tab" ? ids.has(item.tabId) : item.group.tabIds.some((id) => ids.has(id)),
    );
    this.#remove(ids);
    this.#items.splice(Math.max(0, Math.min(first, this.#items.length)), 0, {
      kind: "group",
      group: { groupId, name, color, collapsed: false, tabIds: [...tabIds] },
    });
    this.#revision++;
    return groupId;
  }

  /** Rebuilds the rows from the world and streams what changed. */
  publish(source: MockBrowserSource): void {
    if (!this.#snapshot) return;
    const rows = new Map<TabId, Tab>();
    if (source.session === "authenticated") {
      for (const tab of this.#pageTabs(source))
        if (!this.#hiddenPages.has(tab.tabId)) rows.set(tab.tabId, tab);
      for (const native of this.#native.values())
        rows.set(native.tabId, this.#nativeTab(source, native));
    }
    // New tabs append ungrouped; tabs gone from the world leave the layout.
    const listed = new Set(layoutTabIds(this.layout()));
    const missing = [...listed].filter((id) => !rows.has(id));
    if (missing.length) {
      this.#remove(new Set(missing));
      this.#revision++;
    }
    const added = [...rows.keys()].filter((id) => !listed.has(id));
    if (added.length) {
      for (const id of added) this.#items.push({ kind: "tab", tabId: id });
      this.#revision++;
    }
    const groups = new Map<TabId, TabGroupId>();
    for (const item of this.#items)
      if (item.kind === "group")
        for (const id of item.group.tabIds) groups.set(id, item.group.groupId);
    for (const [id, tab] of rows) {
      const groupId = groups.get(id) ?? null;
      if (tab.groupId !== groupId) rows.set(id, { ...tab, groupId });
    }
    const previous = this.#rows;
    this.#rows = rows;
    for (const id of new Set([...previous.keys(), ...rows.keys()]))
      if (JSON.stringify(previous.get(id)) !== JSON.stringify(rows.get(id)))
        this.#publisher.mark(id);
    this.#publisher.markMeta();
    if (!this.#started) {
      this.#started = true;
      this.#publisher.reset();
    }
    for (let frame = this.#publisher.next(); frame; frame = this.#publisher.next()) {
      this.store.apply(frame as TabStream);
      this.#publisher.settled(frame, true);
    }
  }

  tab(tabId: TabId): Tab {
    return this.#rows.get(tabId) ?? fail("not_found", "This tab is no longer in the list.", 404);
  }
  native(tabId: TabId): MockNativeTab | undefined {
    return this.#native.get(tabId);
  }
  /** The existing singleton for a phone or app, or null. */
  singleton(target: TabTarget): MockNativeTab | null {
    for (const tab of this.#native.values())
      if (
        (target.kind === "phone" && tab.kind === "phone" && tab.computerId === target.computerId) ||
        (target.kind === "app" && tab.kind === "app" && tab.appId === target.appId)
      )
        return tab;
    return null;
  }
  /** The listed phone tab, or first window tab of an app, a scripted Run entered on a computer. */
  nativeAt(computerId: string, match: (tab: MockNativeTab) => boolean): TabId | null {
    for (const tab of this.#native.values())
      if (tab.computerId === computerId && this.#rows.has(tab.tabId) && match(tab))
        return tab.tabId;
    return null;
  }
  revealPage(tabId: TabId): void {
    this.#hiddenPages.delete(tabId);
  }

  close(tabIds: readonly TabId[]): Omit<TabCloseResult, "layout"> {
    const closed: TabId[] = [];
    const failed: { tabId: TabId; error: ToolError }[] = [];
    for (const tabId of tabIds) {
      if (!this.#rows.has(tabId)) {
        failed.push({
          tabId,
          error: { code: "not_found", message: "This tab is no longer in the list.", next: null },
        });
        continue;
      }
      const position = this.#position(tabId);
      const native = this.#native.get(tabId);
      this.#closed.unshift({ tabId, ...position, ...(native ? { native } : {}) });
      if (native) this.#native.delete(tabId);
      else this.#hiddenPages.add(tabId);
      this.#remove(new Set([tabId]));
      closed.push(tabId);
    }
    if (closed.length) this.#revision++;
    return { closed, failed };
  }
  reopen(tabId?: TabId): TabId {
    const index = tabId
      ? this.#closed.findIndex((entry) => entry.tabId === tabId)
      : this.#closed.length
        ? 0
        : -1;
    if (index < 0) {
      if (tabId && this.#rows.has(tabId)) return tabId;
      fail("not_found", "There is no closed tab to reopen.", 404);
    }
    const [entry] = this.#closed.splice(index, 1);
    if (entry!.native) this.#native.set(entry!.tabId, entry!.native);
    else this.#hiddenPages.delete(entry!.tabId);
    this.#place(entry!.tabId, entry!.groupId, entry!.beforeTabId);
    return entry!.tabId;
  }
  /** Forgets every open and closed tab of a deleted app. */
  removeApp(appId: AppId): void {
    for (const tab of this.#native.values())
      if (tab.appId === appId) {
        this.#native.delete(tab.tabId);
        this.#remove(new Set([tab.tabId]));
        this.#revision++;
      }
    for (let i = this.#closed.length - 1; i >= 0; i--)
      if (this.#closed[i]!.native?.appId === appId) this.#closed.splice(i, 1);
  }

  /**
   * The Host's organize semantics: a top-level anchor that heads a group (its
   * first member left once the moved tabs go) stands for that group's place;
   * a whole group moves as a block, before its anchor's block or to the end;
   * any other anchor outside the destination is a conflict.
   */
  organize(input: TabOrganizeInput): void {
    const ids = new Set(input.tabIds);
    if (!ids.size || ids.size !== input.tabIds.length)
      fail("bad_request", "Supply unique tab IDs within the mutation limit.", 400);
    for (const id of ids) this.tab(id);
    const listed = layoutTabIds(this.layout());
    const before = input.beforeTabId;
    if (before && (ids.has(before) || !listed.includes(before)))
      fail("conflict", "The destination tab is no longer a valid anchor.", 409);
    const groupOf = (id: TabId) =>
      this.#items.find((item) => item.kind === "group" && item.group.tabIds.includes(id));
    const targetId = input.group && "groupId" in input.group ? input.group.groupId : null;
    const target = targetId
      ? this.#items.find((item) => item.kind === "group" && item.group.groupId === targetId)
      : undefined;
    if (targetId && target?.kind !== "group") fail("not_found", "Tab group not found.", 404);
    const anchorGroup = before ? groupOf(before) : undefined;
    const wholeGroup =
      target?.kind === "group" &&
      target.group.tabIds.length === ids.size &&
      target.group.tabIds.every((id) => ids.has(id));
    const outside = !!before && (target ? anchorGroup !== target : anchorGroup !== undefined);
    const creating = input.group !== null && "name" in input.group;
    const heads = (item: LayoutItem | undefined) =>
      item?.kind === "group" && item.group.tabIds.find((id) => !ids.has(id)) === before;
    const boundary = input.group === null && heads(anchorGroup);
    if (outside && !creating && !wholeGroup && !boundary)
      fail("conflict", "The anchor belongs to another destination.", 409);
    const firstIndex = this.#items.findIndex((item) =>
      item.kind === "tab" ? ids.has(item.tabId) : item.group.tabIds.some((id) => ids.has(id)),
    );
    this.#remove(ids);
    // The top-level index of the anchor's block, or the end.
    const at = () =>
      before
        ? this.#items.findIndex((item) =>
            item.kind === "tab" ? item.tabId === before : item.group.tabIds.includes(before),
          )
        : this.#items.length;
    if (target?.kind === "group") {
      const current = this.#items.find(
        (item) => item.kind === "group" && item.group.groupId === targetId,
      )!;
      if (current.kind !== "group") fail("conflict", "The destination group changed.", 409);
      if (wholeGroup && (outside || !before)) {
        this.#items = this.#items.filter((item) => item !== current);
        this.#items.splice(at(), 0, {
          kind: "group",
          group: { ...current.group, tabIds: [...input.tabIds] },
        });
      } else {
        const tabIds = [...current.group.tabIds];
        tabIds.splice(before ? tabIds.indexOf(before) : tabIds.length, 0, ...input.tabIds);
        this.#items = this.#items.map((item) =>
          item === current ? { kind: "group", group: { ...current.group, tabIds } } : item,
        );
      }
    } else if (input.group && "name" in input.group) {
      const created: LayoutItem = {
        kind: "group",
        group: {
          groupId: createId("tabGroup"),
          name: input.group.name,
          color: input.group.color,
          collapsed: false,
          tabIds: [...input.tabIds],
        },
      };
      this.#items.splice(before ? at() : Math.min(firstIndex, this.#items.length), 0, created);
    } else
      this.#items.splice(
        at(),
        0,
        ...input.tabIds.map((tabId) => ({ kind: "tab" as const, tabId })),
      );
    this.#revision++;
  }
  updateGroup(input: TabGroupUpdateInput): TabGroup {
    let updated: TabGroup | null = null;
    this.#items = this.#items.map((item) => {
      if (item.kind !== "group" || item.group.groupId !== input.groupId) return item;
      updated = {
        ...item.group,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.color === undefined ? {} : { color: input.color }),
        ...(input.collapsed === undefined ? {} : { collapsed: input.collapsed }),
      };
      return { kind: "group", group: updated };
    });
    if (!updated) fail("not_found", "This group no longer exists.", 404);
    this.#revision++;
    return updated;
  }
  deleteGroup(groupId: TabGroupId): void {
    const index = this.#items.findIndex(
      (item) => item.kind === "group" && item.group.groupId === groupId,
    );
    const held = this.#items[index];
    if (held?.kind !== "group") fail("not_found", "This group no longer exists.", 404);
    this.#items.splice(
      index,
      1,
      ...held.group.tabIds.map((tabId): LayoutItem => ({ kind: "tab", tabId })),
    );
    this.#revision++;
  }
  groups(): TabGroup[] {
    return this.#items.flatMap((item) => (item.kind === "group" ? [item.group] : []));
  }

  #position(tabId: TabId): { groupId: TabGroupId | null; beforeTabId: TabId | null } {
    for (const [index, item] of this.#items.entries()) {
      if (item.kind === "tab" && item.tabId === tabId) {
        const next = this.#items[index + 1];
        return {
          groupId: null,
          beforeTabId: next
            ? next.kind === "tab"
              ? next.tabId
              : (next.group.tabIds[0] ?? null)
            : null,
        };
      }
      if (item.kind === "group") {
        const at = item.group.tabIds.indexOf(tabId);
        if (at >= 0)
          return { groupId: item.group.groupId, beforeTabId: item.group.tabIds[at + 1] ?? null };
      }
    }
    return { groupId: null, beforeTabId: null };
  }
  #place(tabId: TabId, groupId: TabGroupId | null, beforeTabId: TabId | null): void {
    const group = groupId
      ? this.#items.find((item) => item.kind === "group" && item.group.groupId === groupId)
      : undefined;
    if (group?.kind === "group") {
      const tabIds = [...group.group.tabIds];
      const at = beforeTabId ? tabIds.indexOf(beforeTabId) : -1;
      tabIds.splice(at < 0 ? tabIds.length : at, 0, tabId);
      this.#items = this.#items.map((item) =>
        item === group ? { kind: "group", group: { ...group.group, tabIds } } : item,
      );
    } else {
      // A gone group is never recreated: the tab returns ungrouped.
      const at = beforeTabId
        ? this.#items.findIndex((item) => item.kind === "tab" && item.tabId === beforeTabId)
        : -1;
      this.#items.splice(at < 0 ? this.#items.length : at, 0, { kind: "tab", tabId });
    }
    this.#revision++;
  }
  #remove(ids: ReadonlySet<TabId>): void {
    this.#items = this.#items.flatMap((item): LayoutItem[] =>
      item.kind === "tab"
        ? ids.has(item.tabId)
          ? []
          : [item]
        : [
            {
              kind: "group",
              group: { ...item.group, tabIds: item.group.tabIds.filter((id) => !ids.has(id)) },
            },
          ],
    );
  }
  #computer(source: HostSnapshot, computerId: string): Tab["computer"] {
    const machine = source.machines.find((value) => value.id === computerId);
    return {
      computerId: computerId as Tab["computer"]["computerId"],
      name: machine?.name ?? "Computer",
    };
  }
  #pageTabs(source: MockBrowserSource): Tab[] {
    const rows = mockBrowserRows(source);
    // A live page's own address; a sleeping one is named by its site alone.
    const urls = new Map(
      source.browserSessions.flatMap((session) =>
        session.surfaces.map((surface) => [surface.id, surface.url] as const),
      ),
    );
    const tabs: Tab[] = [];
    for (const group of rows.groups) {
      const profile = group.profileId
        ? source.browserProfiles.find((value) => value.id === group.profileId)
        : undefined;
      for (const row of rows.tabs.get(group.id) ?? []) {
        const unavailable = row.availability === "unavailable" && row.state === "live";
        const reason = group.unavailableReason;
        tabs.push(
          TabSchema.parse({
            tabId: row.id,
            kind: "page",
            title: row.title,
            url: urls.get(row.id) || row.site || "about:blank",
            profile:
              group.profileId === null
                ? null
                : { profileId: group.profileId, name: profile?.name ?? "Profile" },
            computer: this.#computer(source, group.placement.runnerId),
            groupId: null,
            state: reason || unavailable ? "unavailable" : row.state === "live" ? "open" : "asleep",
            ...(reason || unavailable
              ? {
                  unavailableCode: "computer-offline",
                  unavailableReason: reason ?? "Computer offline",
                }
              : {}),
            openedBy: group.opener.kind === "task" ? { taskId: group.opener.threadId } : "person",
            usedBy: [...new Set(row.occupants.map((occupant) => occupant.threadId))]
              .sort()
              .map((taskId) => ({ taskId })),
            createdAt: row.createdAt,
            updatedAt: group.updatedAt,
            iconRef: row.iconRef,
          }),
        );
      }
    }
    return tabs;
  }
  #nativeTab(source: HostSnapshot, native: MockNativeTab): Tab {
    const computer = this.#computer(source, native.computerId);
    const machine = source.machines.find((value) => value.id === native.computerId);
    const unavailable = (code: Tab["unavailableCode"], reason: string) => ({
      state: "unavailable" as const,
      unavailableCode: code,
      unavailableReason: reason,
    });
    let state: { state: "open" | "asleep" } | ReturnType<typeof unavailable> = { state: "asleep" };
    if (native.kind === "app") {
      const app = this.#apps?.().find((value) => value.appId === native.appId);
      state =
        app?.state === "stopped"
          ? unavailable("app-stopped", "App stopped")
          : app?.state === "failed"
            ? unavailable("app-failed", "App failed to start")
            : app?.state === "offline"
              ? unavailable("computer-offline", "Computer offline")
              : { state: "open" };
    } else if (!machine || machine.status !== "online")
      state = unavailable("computer-offline", "Computer offline");
    else if (native.closedWindow) state = unavailable("window-closed", "Window closed");
    // A computer whose views wait on its owner, as the Host reports it, shows no window or phone.
    else if (machine.computerUse && machine.computerUse.state !== "ready")
      state = unavailable("access-denied", "Needs permission on this computer");
    else {
      const viewing = machine.computerUse?.ownerViews?.some(
        (view) =>
          view.state === "ready" &&
          (native.kind === "phone"
            ? view.target.kind === "phone"
            : view.target.kind === "app" && view.target.app.bundleId === native.bundleId),
      );
      const held = machine.computerUse?.sessions.some((session) =>
        native.kind === "phone"
          ? session.display
          : session.apps.some((app) => app.bundleId === native.bundleId),
      );
      state = { state: viewing || held ? "open" : "asleep" };
    }
    const usedBy = [
      ...new Set(
        (machine?.computerUse?.sessions ?? [])
          .filter((session) =>
            native.kind === "phone"
              ? session.display
              : native.kind === "window" &&
                session.apps.some((app) => app.bundleId === native.bundleId),
          )
          .map((session) => session.threadId),
      ),
    ]
      .sort()
      .map((taskId) => ({ taskId }));
    return TabSchema.parse({
      tabId: native.tabId,
      kind: native.kind,
      // A phone's tab is named for the phone, as the Host names it now.
      title: native.kind === "phone" ? computer.name : native.title,
      computer,
      groupId: null,
      ...state,
      openedBy: native.openedBy,
      usedBy,
      createdAt: native.createdAt,
      updatedAt: native.createdAt,
      ...(native.kind === "window" ? { appName: native.appName, bundleId: native.bundleId } : {}),
      ...(native.kind === "app" ? { appId: native.appId } : {}),
    });
  }
}

/** The mock's published apps: an HTML page, servers running and stopped, one whose chat is gone. */
export function seedMockApps(input: {
  readonly computerId: string;
  readonly taskId: string | null;
  readonly now: Date;
}): App[] {
  const at = input.now.toISOString();
  const app = (
    id: string,
    value: Omit<App, "appId" | "createdAt" | "updatedAt" | "computerId">,
  ): App => ({
    appId: AppIdSchema.parse(`app_${id}`),
    computerId: input.computerId as App["computerId"],
    createdAt: at,
    updatedAt: at,
    ...value,
  });
  const server = (port: number, state: App["state"]): App["server"] => ({
    desiredState: state === "stopped" ? "stopped" : "running",
    state,
    port,
    generation: 1,
    lastError: state === "failed" ? "The server exited before it answered." : null,
  });
  return [
    app("10000000-0000-4000-8000-000000000001", {
      name: "Trip budget",
      kind: "html",
      state: "running",
      taskId: input.taskId as App["taskId"],
      version: 3,
      server: null,
    }),
    app("10000000-0000-4000-8000-000000000002", {
      name: "Ferry tracker",
      kind: "server",
      state: "running",
      localUrl: "http://127.0.0.1:51034",
      folder: "apps/ferry-tracker",
      start: "node server.js",
      taskId: input.taskId as App["taskId"],
      version: 2,
      server: server(51034, "running"),
    }),
    app("10000000-0000-4000-8000-000000000003", {
      name: "Inventory sync",
      kind: "server",
      state: "stopped",
      localUrl: "http://127.0.0.1:58211",
      folder: "apps/inventory-sync",
      start: "npm start",
      taskId: input.taskId as App["taskId"],
      version: 1,
      server: server(58211, "stopped"),
    }),
    app("10000000-0000-4000-8000-000000000004", {
      name: "Reading list",
      kind: "html",
      state: "running",
      taskId: null,
      version: 1,
      server: null,
    }),
  ];
}

export const mockTabGroupColors = TabGroupColorSchema.options;
