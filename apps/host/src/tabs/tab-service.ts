import type { OpensteerStore } from "@opensteer/database";
import { requireSelfDeviceId } from "@opensteer/database";
import { normalizeToolError } from "@opensteer/agent-tools";
import {
  OpensteerError,
  TabIdSchema,
  TabSchema,
  DeviceTabTargetSchema,
  type App,
  type AppId,
  type DeviceId,
  type RunnerId,
  type Tab,
  type TabGroup,
  type TabGroupId,
  type TabId,
  type TabLayout,
  type TabOpenedBy,
  type TabTarget,
  type UserId,
  type WindowId,
} from "@opensteer/core";
import {
  TabCloseInputSchema,
  TabGroupUpdateInputSchema,
  TabListInputSchema,
  TabOrganizeInputSchema,
  type TabBootstrap,
  type TabCloseResult,
  type TabCommand,
  type TabCommandResult,
  type TabGroupUpdateInput,
  type TabListInput,
  type TabListResult,
  type TabOrganizeInput,
  type TabOrganizeResult,
  type TabViewer,
} from "@opensteer/protocol";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  TabStore,
  tabGroupOf,
  tabLayoutIds,
  tabMutationMeta,
  type TabAuthorization,
  type TabDatabase,
  type TabRecord,
  type TabWrite,
} from "@opensteer/database";
import type { RunToolScope } from "../agents/run-tool-tokens.js";
import type {
  AppTabPort,
  BrowserBindingTabActor,
  NativeTabTargetsPort,
  DeviceNativeTabTargetsPort,
  DeviceNativeTargetAcquired,
  NativeTabTargetState,
  PageAgentBinding,
  TabActor,
  TabServicePort,
} from "./ports.js";

/** A last admission, run in the transaction that makes the change (an approved proposal's). */
type TabReadmit = (transaction: TabDatabase) => Promise<void>;

export interface PageTabsPort {
  open(
    actor: TabActor,
    target: Extract<TabTarget, { kind: "page" }>,
    key: string,
    typed?: boolean,
  ): Promise<TabWrite>;
  admitted?(row: TabWrite): Promise<void>;
  states?(ownerId: UserId, rows: TabRecord[]): Promise<Map<TabId, NativeTabTargetState>>;
  state(ownerId: UserId, row: TabRecord): Promise<NativeTabTargetState>;
  activate(
    ownerId: UserId,
    row: TabRecord,
    key: string,
  ): Promise<Extract<TabViewer, { kind: "page" }>>;
  bind(claims: RunToolScope, row: TabRecord): Promise<PageAgentBinding>;
  bindBrowserScript?(actor: BrowserBindingTabActor, row: TabRecord): Promise<PageAgentBinding>;
  closeViewers(ownerId: UserId, row: TabRecord, closePage?: boolean): Promise<void>;
}
export interface TabComputerFact {
  readonly name: string;
  readonly connected: boolean;
  readonly removed: boolean;
  readonly selfRunnerId?: RunnerId | null | undefined;
}
export interface TabServiceOptions {
  store: TabStore;
  sharedChromeTabs?: (actor: TabActor) => Promise<Tab[]>;
  devices: Pick<OpensteerStore, "requireSelfDeviceId" | "requireDeviceSelfRunnerId">;
  nativeTargets: NativeTabTargetsPort;
  deviceNativeTargets?: DeviceNativeTabTargetsPort;
  pages: PageTabsPort;
  apps: Pick<AppTabPort, "get">;
  computer(ownerId: UserId, computerId: DeviceId, database: TabDatabase): Promise<TabComputerFact>;
  /** Metadata reach includes offline computers; this must not depend on runtime connectivity. */
  canRead(actor: TabActor, row: TabRecord, database: TabDatabase): Promise<boolean>;
  readAuthority?(
    actor: TabActor,
    database: TabDatabase,
  ): Promise<(row: TabRecord) => Promise<boolean>>;
  computers?(
    ownerId: UserId,
    ids: DeviceId[],
    database: TabDatabase,
  ): Promise<Map<DeviceId, TabComputerFact>>;
  readableTasks?(
    actor: TabActor,
    ids: RunToolScope["threadId"][],
    database: TabDatabase,
  ): Promise<Set<RunToolScope["threadId"]>>;
  canReadTask(
    actor: TabActor,
    taskId: RunToolScope["threadId"],
    database: TabDatabase,
  ): Promise<boolean>;
  /** Rechecks the Run/connection and current grants. Called again inside membership commits. */
  authorize(actor: TabActor, target: TabTarget | TabWrite, database: TabDatabase): Promise<void>;
  authorizeMembership(actor: TabActor, database: TabDatabase): Promise<void>;
  /** The affected tabs work for a selected connection may not change; empty for everyone else. */
  deniedRows?(
    actor: TabActor,
    rows: readonly TabRecord[],
    database: TabDatabase,
  ): Promise<ReadonlySet<TabId>>;
  onError(error: unknown): void;
}
function owner(actor: TabActor): UserId {
  if (actor.kind === "browser-binding") return actor.authority.ownerId;
  return actor.kind === "person"
    ? actor.ownerId
    : actor.kind === "run"
      ? actor.claims.requestedBy
      : actor.caller.userId;
}
function notFound(): never {
  throw new OpensteerError({ code: "not_found", message: "Tab not found." });
}
function conflict(): never {
  throw new OpensteerError({
    code: "conflict",
    message: "The tab changed while opening its viewer.",
  });
}
function operationKey(actor: TabActor, key: string): string {
  return createHash("sha256")
    .update(
      canonicalJson([
        actor.kind,
        actor.kind === "run"
          ? [actor.claims.runId, actor.claims.bindingGeneration]
          : actor.kind === "connection"
            ? actor.caller.connectionId
            : actor.kind === "browser-binding"
              ? actor.authority.agentBindingId
              : actor.ownerId,
        key,
      ]),
    )
    .digest("hex");
}
const cursorSchema = z.strictObject({
  version: z.literal(1),
  filters: z.string(),
  after: z.string(),
});

function layoutGroupMap(layout: TabLayout): Map<TabId, TabGroupId | null> {
  const groups = new Map<TabId, TabGroupId | null>();
  for (const item of layout.items) {
    if (item.kind === "tab") groups.set(item.tabId, null);
    else for (const tabId of item.group.tabIds) groups.set(tabId, item.group.groupId);
  }
  return groups;
}

function maskVisibleLayout(layout: TabLayout, visible: ReadonlySet<TabId>): TabLayout {
  const hiddenGroups = new Set(
    layout.items.flatMap((item) =>
      item.kind === "group" && item.group.tabIds.some((id) => !visible.has(id))
        ? [item.group.groupId]
        : [],
    ),
  );
  return {
    revision: layout.revision,
    items: layout.items.flatMap<TabLayout["items"][number]>((item) =>
      item.kind === "tab"
        ? visible.has(item.tabId)
          ? [item]
          : []
        : hiddenGroups.has(item.group.groupId)
          ? item.group.tabIds
              .filter((id) => visible.has(id))
              .map((tabId) => ({ kind: "tab" as const, tabId }))
          : [item],
    ),
  };
}

interface OwnerTabCatalog {
  rows: Map<TabId, Tab>;
  /** Tracks the catalog.version at which each row was last projected/installed. */
  rowVersions: Map<TabId, number>;
  layout: TabLayout;
  windowIds: Map<TabId, WindowId>;
  complete: boolean;
  /** null = full reload needed; otherwise maps dirty TabId -> catalog.version when invalidated. */
  dirty: Map<TabId, number> | null;
  version: number;
  projectedVersion: number;
  /** Bumped on every structural layout update so concurrent activations cannot write stale groupIds. */
  structureEpoch: number;
  pending?: Promise<void>;
}

export class TabService implements TabServicePort {
  readonly #stopAcquired: () => void;
  readonly options: TabServiceOptions;
  readonly #catalogs = new Map<UserId, OwnerTabCatalog>();
  async acquired(target: DeviceNativeTargetAcquired): Promise<TabId> {
    if (target.ownerId !== target.runClaims.requestedBy) notFound();
    const intent =
      target.kind === "phone"
        ? { kind: "phone" as const, computerId: target.computerId }
        : { kind: "window" as const, computerId: target.computerId, windowId: target.windowId };
    try {
      const opened = await this.open(
        { kind: "run", claims: target.runClaims },
        intent,
        target.key,
        target.membershipRevision,
      );
      return opened.tab.tabId;
    } catch (error) {
      if (error instanceof OpensteerError && error.code === "conflict") {
        const existing = await this.options.store.singleton(target.ownerId, intent);
        if (existing?.closedAt) return existing.id;
      }
      throw error;
    }
  }
  constructor(options: TabServiceOptions) {
    this.options = options;
    this.#stopAcquired = options.nativeTargets.onTargetAcquired(
      async (target) =>
        this.acquired({
          ...target,
          computerId: await options.devices.requireSelfDeviceId(target.computerId),
        }),
      async (ownerId) => this.#layoutRevision(ownerId),
    );
  }
  changed(ownerId?: UserId, tabIds?: readonly TabId[]): void {
    for (const [id, catalog] of this.#catalogs) {
      if (ownerId && id !== ownerId) continue;
      if (!tabIds) {
        catalog.dirty = null;
        catalog.version += 1;
      } else if (tabIds.length) {
        catalog.version += 1;
        if (catalog.dirty) for (const tabId of tabIds) catalog.dirty.set(tabId, catalog.version);
      }
    }
  }
  appsChanged(appIds: AppId[]): void {
    for (const [ownerId, catalog] of this.#catalogs) {
      const ids = [...catalog.rows.values()].flatMap((tab) =>
        tab.kind === "app" && (!appIds.length || appIds.includes(tab.appId!)) ? [tab.tabId] : [],
      );
      if (ids.length) this.changed(ownerId, ids);
    }
  }
  windowChanged(ownerId: UserId, windowId: WindowId): void {
    const catalog = this.#catalogs.get(ownerId);
    if (!catalog) return;
    const ids = [...catalog.windowIds.entries()].flatMap(([tabId, id]) =>
      id === windowId ? [tabId] : [],
    );
    if (ids.length) this.changed(ownerId, ids);
    else if (catalog.pending) this.changed(ownerId);
  }
  dispose(): void {
    this.#stopAcquired();
    this.#catalogs.clear();
  }
  async #layoutRevision(ownerId: UserId): Promise<number> {
    if (typeof this.options.store.resourceLayout === "function") {
      return (
        await this.options.store.resourceLayout(this.options.store.database, ownerId, {
          after: 0,
          limit: 1,
        })
      ).revision;
    }
    return (await this.options.store.snapshot(ownerId)).layout.revision;
  }
  #registerWindowBeforeProjection(ownerId: UserId, row: TabRecord): void {
    if (row.kind !== "window" || !row.windowId) return;
    const catalog = this.#catalogs.get(ownerId);
    if (catalog && !catalog.pending && catalog.projectedVersion > 0 && catalog.dirty !== null) {
      catalog.windowIds.set(row.id, row.windowId);
    }
  }
  #applyCatalogMutation(
    ownerId: UserId,
    nextLayout: TabLayout,
    updatedTabs?: readonly Tab[],
    updatedWindowIds?: ReadonlyMap<TabId, WindowId>,
    baseVersion?: number,
  ): void {
    const catalog = this.#catalogs.get(ownerId);
    if (!catalog) return;
    if (
      catalog.pending ||
      catalog.projectedVersion === 0 ||
      catalog.dirty === null ||
      !catalog.complete
    ) {
      this.changed(ownerId);
      return;
    }
    if (nextLayout.revision < catalog.layout.revision) return;
    const updatedById = new Map(updatedTabs?.map((tab) => [tab.tabId, tab]) ?? []);
    const nextOrder = tabLayoutIds(nextLayout);
    const nextGroupByTab = layoutGroupMap(nextLayout);
    const nextRows = new Map<TabId, Tab>();
    const nextRowVersions = new Map<TabId, number>();
    for (const tabId of nextOrder) {
      const existing = catalog.rows.get(tabId);
      const projected = updatedById.get(tabId);
      const rowVersion = catalog.rowVersions.get(tabId) ?? 0;
      const dirtyVersion = catalog.dirty.get(tabId) ?? 0;
      const useProjected =
        projected !== undefined &&
        (!existing ||
          (baseVersion !== undefined &&
            catalog.projectedVersion <= baseVersion &&
            rowVersion <= baseVersion &&
            dirtyVersion <= baseVersion));
      const chosen = useProjected ? projected : existing;
      if (!chosen) {
        this.changed(ownerId);
        return;
      }
      const groupId = nextGroupByTab.get(tabId) ?? null;
      nextRows.set(tabId, chosen.groupId === groupId ? chosen : { ...chosen, groupId });
      nextRowVersions.set(tabId, useProjected ? (baseVersion ?? catalog.version) : rowVersion);
    }
    catalog.rows = nextRows;
    catalog.rowVersions = nextRowVersions;
    catalog.layout = structuredClone(nextLayout);
    catalog.structureEpoch += 1;
    for (const tabId of catalog.windowIds.keys()) {
      if (!nextRows.has(tabId)) catalog.windowIds.delete(tabId);
    }
    if (updatedWindowIds) {
      for (const [tabId, windowId] of updatedWindowIds) {
        if (nextRows.has(tabId)) catalog.windowIds.set(tabId, windowId);
      }
    }
    for (const [tabId, dirtyAt] of catalog.dirty) {
      if (!nextRows.has(tabId)) {
        catalog.dirty.delete(tabId);
      } else if (
        updatedById.has(tabId) &&
        baseVersion !== undefined &&
        catalog.projectedVersion <= baseVersion &&
        (catalog.rowVersions.get(tabId) ?? 0) <= baseVersion &&
        dirtyAt <= baseVersion
      ) {
        catalog.dirty.delete(tabId);
      }
    }
  }
  async #catalog(ownerId: UserId) {
    let catalog = this.#catalogs.get(ownerId);
    if (!catalog) {
      catalog = {
        rows: new Map(),
        rowVersions: new Map(),
        layout: { revision: 0, items: [] },
        windowIds: new Map(),
        complete: true,
        dirty: null,
        version: 1,
        projectedVersion: 0,
        structureEpoch: 0,
      };
      this.#catalogs.set(ownerId, catalog);
    }
    const current = catalog;
    const targetVersion = current.version;
    while (current.projectedVersion < targetVersion) {
      current.pending ??= this.#refreshCatalog(ownerId, current).finally(() => {
        delete current.pending;
      });
      await current.pending;
    }
    return { rows: current.rows, layout: current.layout };
  }
  async #refreshCatalog(ownerId: UserId, current: OwnerTabCatalog): Promise<void> {
    const passVersion = current.version;
    const ids = current.dirty;
    current.dirty = new Map();
    try {
      if (ids === null) {
        const projected = await this.#snapshotProject(
          { kind: "person", ownerId },
          this.options.store.database,
        );
        current.rows = new Map(projected.tabs.map((tab) => [tab.tabId, tab]));
        current.rowVersions = new Map(projected.tabs.map((tab) => [tab.tabId, passVersion]));
        current.layout = projected.layout;
        current.windowIds = projected.windowIds;
        current.complete = projected.complete;
        current.structureEpoch += 1;
      } else if (ids.size) {
        const tabIds = [...ids.keys()];
        const rows = await this.options.store.rows(ownerId, tabIds);
        if (rows.length !== tabIds.length || rows.some((row) => !current.rows.has(row.id))) {
          const projected = await this.#snapshotProject(
            { kind: "person", ownerId },
            this.options.store.database,
          );
          current.rows = new Map(projected.tabs.map((tab) => [tab.tabId, tab]));
          current.rowVersions = new Map(projected.tabs.map((tab) => [tab.tabId, passVersion]));
          current.layout = projected.layout;
          current.windowIds = projected.windowIds;
          current.complete = projected.complete;
          current.structureEpoch += 1;
        } else {
          const projected = await this.#projectRows(
            { kind: "person", ownerId },
            rows,
            current.layout,
            this.options.store.database,
            current.rows,
          );
          for (const id of tabIds) {
            if (!projected.tabs.some((tab) => tab.tabId === id)) {
              current.rows.delete(id);
              current.rowVersions.delete(id);
              current.windowIds.delete(id);
              current.complete = false;
            }
          }
          for (const tab of projected.tabs) {
            current.rows.set(tab.tabId, tab);
            current.rowVersions.set(tab.tabId, passVersion);
          }
          for (const [id, windowId] of projected.windowIds) current.windowIds.set(id, windowId);
        }
      }
      current.projectedVersion = passVersion;
    } catch (error) {
      current.dirty = null;
      throw error;
    }
  }

  /** The same ordered projection feeds resource reads and RPCs. */
  async project(
    actor: TabActor,
    database = this.options.store.database,
  ): Promise<{ tabs: Tab[]; layout: TabLayout }> {
    if (actor.kind === "person" && database === this.options.store.database) {
      await this.options.authorizeMembership(actor, database);
      const { rows, layout } = await this.#catalog(actor.ownerId);
      return {
        tabs: [...rows.values(), ...((await this.options.sharedChromeTabs?.(actor)) ?? [])],
        layout,
      };
    }
    const { tabs, layout } = await this.#snapshotProject(actor, database);
    tabs.push(...((await this.options.sharedChromeTabs?.(actor)) ?? []));
    return { tabs, layout };
  }
  async #snapshotProject(
    actor: TabActor,
    database: TabDatabase,
  ): Promise<{
    tabs: Tab[];
    layout: TabLayout;
    windowIds: Map<TabId, WindowId>;
    complete: boolean;
  }> {
    const ownerId = owner(actor),
      { rows, layout } = await this.options.store.snapshot(ownerId, database);
    return this.#projectRows(actor, rows, layout, database);
  }
  async #projectVisibleLayout(
    actor: TabActor,
    layout: TabLayout,
    database: TabDatabase,
  ): Promise<TabLayout> {
    if (actor.kind === "person") return layout;
    const ownerId = owner(actor);
    const ids = tabLayoutIds(layout);
    const rows = ids.length ? await this.options.store.rows(ownerId, ids) : [];
    const canRead = this.options.readAuthority
      ? await this.options.readAuthority(actor, database)
      : (row: TabRecord) => this.options.canRead(actor, row, database);
    const visible = new Set(
      (await Promise.all(rows.map(async (row) => ((await canRead(row)) ? row.id : null)))).filter(
        (id): id is TabId => id !== null,
      ),
    );
    return maskVisibleLayout(layout, visible);
  }
  async #groupIdForTab(
    actor: TabActor,
    tabId: TabId,
    layout: TabLayout,
    database: TabDatabase,
  ): Promise<TabGroupId | null> {
    const groupId = tabGroupOf(layout, tabId);
    if (!groupId) return null;
    if (actor.kind === "person") return groupId;
    const groupItem = layout.items.find(
      (item) => item.kind === "group" && item.group.groupId === groupId,
    );
    if (groupItem?.kind !== "group") return null;
    const siblings = await this.options.store.rows(owner(actor), groupItem.group.tabIds);
    if (siblings.length !== groupItem.group.tabIds.length) return null;
    const canRead = this.options.readAuthority
      ? await this.options.readAuthority(actor, database)
      : (row: TabRecord) => this.options.canRead(actor, row, database);
    const allowed = await Promise.all(siblings.map((sibling) => canRead(sibling)));
    return allowed.every(Boolean) ? groupId : null;
  }
  async #singleTabGroupId(
    ownerId: UserId,
    tabId: TabId,
    database: TabDatabase,
  ): Promise<TabGroupId | null> {
    const catalog = this.#catalogs.get(ownerId);
    if (
      catalog &&
      !catalog.pending &&
      catalog.projectedVersion > 0 &&
      catalog.dirty !== null &&
      catalog.rows.has(tabId)
    ) {
      return catalog.rows.get(tabId)!.groupId;
    }
    if (typeof this.options.store.resourceTabGroups === "function") {
      const groups = await this.options.store.resourceTabGroups(database, ownerId, [tabId]);
      return groups.get(tabId) ?? null;
    }
    const { layout } = await this.options.store.snapshot(ownerId, database);
    return tabGroupOf(layout, tabId);
  }
  async #projectRows(
    actor: TabActor,
    rows: TabRecord[],
    layout: TabLayout,
    database: TabDatabase,
    catalog?: ReadonlyMap<TabId, Pick<Tab, "groupId">>,
  ): Promise<{
    tabs: Tab[];
    layout: TabLayout;
    windowIds: Map<TabId, WindowId>;
    complete: boolean;
  }> {
    const ownerId = owner(actor);
    const canRead = this.options.readAuthority
      ? await this.options.readAuthority(actor, database)
      : (row: TabRecord) => this.options.canRead(actor, row, database);
    const visible = new Set(
      (await Promise.all(rows.map(async (row) => ((await canRead(row)) ? row.id : null)))).filter(
        (id): id is TabId => id !== null,
      ),
    );
    const projected: TabLayout = catalog ? layout : maskVisibleLayout(layout, visible);
    const shown = rows.filter((row) => visible.has(row.id));
    const computerIds = [...new Set(shown.map((row) => row.computerId))];
    const computers = this.options.computers
      ? await this.options.computers(ownerId, computerIds, database)
      : new Map(
          await Promise.all(
            computerIds.map(
              async (id) => [id, await this.options.computer(ownerId, id, database)] as const,
            ),
          ),
        );
    const profileIds = [...new Set(shown.flatMap((row) => (row.profileId ? [row.profileId] : [])))];
    const profiles = new Map(
      profileIds.length
        ? (
            await database
              .selectFrom("browserProfiles")
              .select(["id", "name"])
              .where("ownerId", "=", ownerId)
              .where("id", "in", profileIds)
              .execute()
          ).map((profile) => [profile.id, profile.name])
        : [],
    );
    const appIds = [
      ...new Set(
        shown.flatMap((row) => {
          if (row.kind !== "app" || !row.appId) return [];
          const computer = computers.get(row.computerId);
          return computer && !computer.removed ? [row.appId] : [];
        }),
      ),
    ];
    const apps = new Map<AppId, App | null>(
      await Promise.all(
        appIds.map(
          async (appId) =>
            [
              appId,
              await this.options.apps.get(ownerId, appId).catch((error: unknown) => {
                if (error instanceof OpensteerError && error.code === "not_found") return null;
                throw error;
              }),
            ] as const,
        ),
      ),
    );
    const selfRunnerIds = new Map<DeviceId, RunnerId>();
    const needRunnerIds = [
      ...new Set(
        shown.flatMap((row) => {
          const computer = computers.get(row.computerId);
          if (!computer || computer.removed || !computer.connected) return [];
          const needsRunner =
            row.kind === "window" || (row.kind === "phone" && !this.options.deviceNativeTargets);
          if (!needsRunner) return [];
          if (computer.selfRunnerId) {
            selfRunnerIds.set(row.computerId, computer.selfRunnerId);
            return [];
          }
          return [row.computerId];
        }),
      ),
    ];
    await Promise.all(
      needRunnerIds.map(async (deviceId) => {
        selfRunnerIds.set(deviceId, await this.options.devices.requireDeviceSelfRunnerId(deviceId));
      }),
    );
    const activeWindows = shown.flatMap((row) => {
      if (row.kind !== "window" || !row.windowId) return [];
      const computer = computers.get(row.computerId);
      if (!computer || computer.removed || !computer.connected) return [];
      const runnerId = selfRunnerIds.get(row.computerId);
      if (!runnerId) return [];
      return [{ tabId: row.id, computerId: runnerId, windowId: row.windowId, app: row.windowApp }];
    });
    const [pageStates, windowStates] = await Promise.all([
      this.options.pages.states
        ? this.options.pages.states(
            ownerId,
            shown.filter((row) => row.kind === "page"),
          )
        : undefined,
      activeWindows.length && this.options.nativeTargets.windowStates
        ? this.options.nativeTargets.windowStates(ownerId, activeWindows)
        : undefined,
    ]);
    const groupByTab = catalog ? undefined : layoutGroupMap(projected);
    let tabs = await Promise.all(
      shown.map(async (row) => {
        const tab = await this.#tab(actor, row, projected, {
          computer: computers.get(row.computerId)!,
          profile: row.profileId ? profiles.get(row.profileId) : undefined,
          live:
            row.kind === "page"
              ? pageStates?.get(row.id)
              : row.kind === "window"
                ? windowStates?.get(row.id)
                : undefined,
          app: row.kind === "app" && row.appId ? apps.get(row.appId) : undefined,
          selfRunnerId: selfRunnerIds.get(row.computerId),
          groupId: catalog ? catalog.get(row.id)?.groupId : (groupByTab?.get(row.id) ?? null),
        });
        return tab;
      }),
    );
    const taskIds = [...new Set(tabs.flatMap((tab) => tab.usedBy.map((holder) => holder.taskId)))];
    const readable = this.options.readableTasks
      ? await this.options.readableTasks(actor, taskIds, database)
      : new Set(
          (
            await Promise.all(
              taskIds.map(async (id) =>
                (await this.options.canReadTask(actor, id, database)) ? id : null,
              ),
            )
          ).filter((id): id is RunToolScope["threadId"] => id !== null),
        );
    tabs = tabs.map((tab) => ({
      ...tab,
      usedBy: tab.usedBy.filter(({ taskId }) => readable.has(taskId)).slice(0, 128),
    }));
    const windowIds = new Map(
      shown.flatMap((row) =>
        row.kind === "window" && row.windowId ? [[row.id, row.windowId] as const] : [],
      ),
    );
    return { tabs, layout: projected, windowIds, complete: visible.size === rows.length };
  }
  async #tab(
    actor: TabActor,
    row: TabRecord,
    layout: TabLayout,
    facts: {
      computer: TabComputerFact;
      profile?: string | undefined;
      live?: NativeTabTargetState | undefined;
      app?: App | null | undefined;
      selfRunnerId?: RunnerId | undefined;
      groupId?: TabGroupId | null | undefined;
    },
  ): Promise<Tab> {
    const ownerId = owner(actor),
      computer = facts.computer;
    let live: NativeTabTargetState;
    let title = row.title;
    if (computer.removed)
      live = {
        state: "unavailable",
        unavailableCode: "computer-removed",
        unavailableReason: "This computer was removed.",
        usedBy: [],
      };
    else if (!computer.connected && row.kind !== "app")
      live = {
        state: "unavailable",
        unavailableCode: "computer-offline",
        unavailableReason: "This computer is offline.",
        usedBy: [],
      };
    else if (row.kind === "window")
      live =
        facts.live ??
        (await this.options.nativeTargets.windowState(
          ownerId,
          facts.selfRunnerId ??
            (await this.options.devices.requireDeviceSelfRunnerId(row.computerId)),
          row.windowId!,
          row.windowApp,
        ));
    else if (row.kind === "phone")
      live = this.options.deviceNativeTargets
        ? await this.options.deviceNativeTargets.phoneState(ownerId, row.computerId)
        : await this.options.nativeTargets.phoneState(
            ownerId,
            facts.selfRunnerId ??
              (await this.options.devices.requireDeviceSelfRunnerId(row.computerId)),
          );
    else if (row.kind === "page")
      live = facts.live ?? (await this.options.pages.state(ownerId, row));
    else {
      const app =
        facts.app !== undefined
          ? facts.app
          : await this.options.apps.get(ownerId, row.appId!).catch((error: unknown) => {
              if (error instanceof OpensteerError && error.code === "not_found") return null;
              throw error;
            });
      title = app?.name ?? row.title;
      live =
        app && (app.kind === "html" || app?.state === "running")
          ? { state: "open", usedBy: [] }
          : {
              state: "unavailable",
              usedBy: [],
              unavailableCode:
                app?.state === "offline"
                  ? "computer-offline"
                  : app?.state === "stopped"
                    ? "app-stopped"
                    : "app-failed",
              unavailableReason:
                app?.state === "offline"
                  ? "This computer is offline."
                  : app?.state === "stopped"
                    ? "This app is stopped."
                    : "This app failed to start.",
            };
    }
    const usedBy = [...new Set(live.usedBy.map(({ taskId }) => taskId))]
      .sort()
      .slice(0, 128)
      .map((taskId) => ({ taskId }));
    return TabSchema.parse({
      tabId: row.id,
      kind: row.kind,
      title,
      computer: { computerId: row.computerId, name: computer.name },
      groupId: facts.groupId === undefined ? tabGroupOf(layout, row.id) : facts.groupId,
      ...live,
      usedBy,
      openedBy: row.openedBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      iconRef: row.iconRef,
      ...(row.kind === "page"
        ? {
            url: row.url!,
            profile: row.profileId
              ? { profileId: row.profileId, name: facts.profile ?? row.profileName! }
              : null,
          }
        : {}),
      ...(row.kind === "window"
        ? { appName: row.windowApp!.displayName, bundleId: row.windowApp!.bundleId }
        : {}),
      ...(row.kind === "app" ? { appId: row.appId! } : {}),
    });
  }
  async list(
    actor: TabActor,
    input: TabListInput,
    mayNameComputer?: (deviceId: DeviceId) => boolean,
    select?: (tab: Tab) => boolean,
  ): Promise<TabListResult> {
    input = TabListInputSchema.parse(input);
    const { tabs: visible, layout } = await this.project(actor);
    const tabs = select ? visible.filter(select) : visible;
    const groups = layout.items.flatMap((item) => (item.kind === "group" ? [item.group] : []));
    const query = input.query?.toLowerCase();
    const filtered = tabs.filter(
      (tab) =>
        (!input.kind || tab.kind === input.kind) &&
        (!query ||
          [
            tab.title,
            tab.url,
            tab.profile?.name,
            tab.appName,
            tab.bundleId,
            tab.sharedByPerson?.computerName ??
              (mayNameComputer?.(tab.computer.computerId) === false
                ? undefined
                : tab.computer.name),
            groups.find((group) => group.groupId === tab.groupId)?.name,
          ].some((value) => value?.toLowerCase().includes(query))),
    );
    const filters = createHash("sha256")
      .update(canonicalJson([owner(actor), input.query ?? null, input.kind ?? null]))
      .digest("hex");
    let start = 0;
    if (input.cursor) {
      let value: unknown;
      try {
        value = JSON.parse(Buffer.from(input.cursor, "base64url").toString());
      } catch {
        throw new OpensteerError({ code: "bad_request", message: "Invalid tab cursor." });
      }
      const decoded = cursorSchema.safeParse(value);
      if (!decoded.success || decoded.data.filters !== filters)
        throw new OpensteerError({
          code: "bad_request",
          message: "Keep the same tab filters when paging.",
        });
      const index = filtered.findIndex((tab) => tab.tabId === decoded.data.after);
      if (index < 0)
        throw new OpensteerError({
          code: "conflict",
          message: "The tab list changed. List from the first page.",
        });
      start = index + 1;
    }
    const page = filtered.slice(start, start + 50);
    return {
      tabs: page,
      groups,
      nextCursor:
        start + page.length < filtered.length
          ? Buffer.from(
              JSON.stringify({ version: 1, filters, after: page.at(-1)!.tabId }),
            ).toString("base64url")
          : null,
    };
  }
  /** An authorization that also runs an approved proposal's last admission, in the same transaction. */
  #readmitting(authorize: TabAuthorization, readmit: TabReadmit | undefined): TabAuthorization {
    if (!readmit) return authorize;
    return async (tx, rows, layout, replayed) => {
      await authorize(tx, rows, layout, replayed);
      await readmit(tx);
    };
  }
  #authorize(
    actor: TabActor,
    ids: readonly TabId[],
    groupIds: readonly TabGroupId[] = [],
  ): TabAuthorization {
    return async (tx, rows, layout) => {
      await this.options.authorizeMembership(actor, tx);
      const affected = new Set(ids);
      for (const item of layout.items)
        if (
          item.kind === "group" &&
          (groupIds.includes(item.group.groupId) ||
            item.group.tabIds.some((id) => affected.has(id)))
        )
          for (const id of item.group.tabIds) affected.add(id);
      const affectedRows: TabRecord[] = [];
      for (const id of affected) {
        const row = rows.find((row) => row.id === id);
        if (!row || row.ownerId !== owner(actor)) notFound();
        affectedRows.push(row);
      }
      if ((await this.options.deniedRows?.(actor, affectedRows, tx))?.size) notFound();
    };
  }
  async open(
    actor: TabActor,
    targetInput: TabTarget,
    key: string,
    membershipRevision?: number,
    /** The person typed a page's address. */
    typed = false,
  ): Promise<{ tab: Tab }> {
    const { tab } = await this.#open(actor, targetInput, key, membershipRevision, typed);
    return { tab };
  }
  async #open(
    actor: TabActor,
    targetInput: TabTarget,
    key: string,
    membershipRevision?: number,
    typed = false,
  ): Promise<{ tab: Tab; layout: TabLayout }> {
    if (actor.kind === "browser-binding") actor.signal?.throwIfAborted();
    const target = DeviceTabTargetSchema.parse(targetInput);
    const ownerId = owner(actor),
      database = this.options.store.database;
    await this.options.authorize(actor, target, database);
    const initialRevision = membershipRevision ?? (await this.#layoutRevision(ownerId));
    const openedBy: TabOpenedBy =
      actor.kind === "run"
        ? { taskId: actor.claims.threadId }
        : actor.kind === "browser-binding"
          ? { taskId: actor.threadId }
          : "person";
    const hash = operationKey(actor, key);
    const id = TabIdSchema.parse(
      `tab_${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`,
    );
    let write: TabWrite;
    let appFence: { version: number; generation: number | null } | undefined;
    if (target.kind === "page")
      write = await this.options.pages.open(actor, target, operationKey(actor, key), typed);
    else if (target.kind === "app") {
      const app = await this.options.apps.get(ownerId, target.appId);
      appFence = { version: app.version, generation: app.server?.generation ?? null };
      write = {
        id,
        ownerId,
        kind: "app",
        computerId: await this.options.devices.requireSelfDeviceId(app.computerId),
        appId: app.appId,
        title: app.name,
        openedBy,
      };
    } else if (target.kind === "phone") {
      const computer = await this.options.computer(ownerId, target.computerId, database);
      write = {
        id,
        ownerId,
        kind: "phone",
        computerId: target.computerId,
        title: computer.name,
        openedBy,
      };
    } else {
      const existing =
        "windowId" in target ? await this.options.store.singleton(ownerId, target) : null;
      if (existing) write = { ...existing, openedBy: existing.openedBy };
      else {
        const window = await this.options.nativeTargets.resolveWindow(
          ownerId,
          await this.options.devices.requireDeviceSelfRunnerId(target.computerId),
          "windowId" in target ? { windowId: target.windowId } : { bundleId: target.bundleId },
        );
        write = {
          id,
          ownerId,
          kind: "window",
          computerId: target.computerId,
          windowId: window.windowId,
          windowApp: window.app,
          title: window.title,
          openedBy,
        };
      }
    }
    const result = await this.options.store.open(
      write,
      operationKey(actor, key),
      async (tx) => {
        await this.options.authorize(actor, target, tx);
        await this.options.authorize(actor, write, tx);
        if (target.kind === "app") {
          const current = await tx
            .selectFrom("apps")
            .select(["deleting", "computerId", "latestVersion"])
            .where("id", "=", target.appId)
            .where("ownerId", "=", ownerId)
            .executeTakeFirst();
          if (
            !current ||
            current.deleting ||
            (await requireSelfDeviceId(tx, current.computerId)) !== write.computerId
          )
            notFound();
          if (current.latestVersion !== appFence!.version) conflict();
          if (appFence!.generation !== null) {
            const server = await tx
              .selectFrom("appServers")
              .select("generation")
              .where("appId", "=", target.appId)
              .executeTakeFirst();
            if (Number(server?.generation) !== appFence!.generation) conflict();
          }
        }
      },
      target,
      initialRevision,
    );
    const meta = tabMutationMeta(result);
    const responseLayout = meta.replayed && meta.currentLayout ? meta.currentLayout : result.layout;
    try {
      if (write.kind === "page") await this.options.pages.admitted?.(write);
      const openedId = result.tabIds[0];
      if (!openedId) notFound();
      const baseVersion = this.#catalogs.get(ownerId)?.version ?? 0;
      const row = await this.options.store.get(ownerId, openedId);
      if (!row) notFound();
      if (!meta.replayed && actor.kind === "person") {
        this.#registerWindowBeforeProjection(ownerId, row);
      }
      const groupId = await this.#groupIdForTab(actor, openedId, responseLayout, database);
      const projected = await this.#projectRows(
        actor,
        [row],
        responseLayout,
        database,
        new Map([[row.id, { groupId }]]),
      );
      const tab = projected.tabs[0];
      if (!tab) notFound();
      if (!meta.replayed) {
        if (actor.kind === "person") {
          this.#applyCatalogMutation(
            ownerId,
            result.layout,
            projected.tabs,
            projected.windowIds,
            baseVersion,
          );
        } else {
          this.changed(ownerId);
        }
      }
      return { tab, layout: responseLayout };
    } catch (error) {
      if (!meta.replayed) this.changed(ownerId);
      throw error;
    }
  }
  async get(ownerId: UserId, tabId: TabId): Promise<Tab> {
    const actor = { kind: "person", ownerId } as const;
    const database = this.options.store.database;
    await this.options.authorizeMembership(actor, database);
    const catalog = this.#catalogs.get(ownerId);
    if (
      catalog &&
      !catalog.pending &&
      catalog.projectedVersion > 0 &&
      catalog.dirty !== null &&
      !catalog.dirty.has(tabId)
    ) {
      const cached = catalog.rows.get(tabId);
      if (cached) return cached;
    }
    const row = await this.options.store.get(ownerId, tabId);
    if (!row) {
      const shared = (await this.options.sharedChromeTabs?.(actor))?.find(
        (tab) => tab.tabId === tabId,
      );
      if (shared) return shared;
      notFound();
    }
    const groupId = await this.#singleTabGroupId(ownerId, tabId, database);
    const { tabs } = await this.#projectRows(
      actor,
      [row],
      { revision: 0, items: [] },
      database,
      new Map([[row.id, { groupId }]]),
    );
    return tabs[0] ?? notFound();
  }
  async #row(actor: TabActor, tabId: TabId): Promise<TabRecord> {
    const row = await this.options.store.get(owner(actor), tabId);
    if (!row || !(await this.options.canRead(actor, row, this.options.store.database))) notFound();
    return row;
  }
  async connectionTab(
    actor: Extract<TabActor, { kind: "connection" | "browser-binding" }>,
    tabId: TabId,
  ) {
    return this.#row(actor, tabId);
  }
  /** The app's current window, bound to this window tab in place of the one that ended. */
  async #rebindWindow(
    actor: TabActor & { kind: "person" },
    row: TabRecord,
    runnerId: RunnerId,
  ): Promise<TabRecord | null> {
    const current = await this.options.nativeTargets
      .resolveWindow(actor.ownerId, runnerId, { bundleId: row.windowApp!.bundleId })
      .catch((error: unknown) => {
        // No window, the app gone or the computer away: the tab says its own window closed.
        if (error instanceof OpensteerError) return null;
        throw error;
      });
    if (!current || current.windowId === row.windowId) return null;
    const next = { ...row, windowId: current.windowId, windowApp: current.app };
    await this.options.authorize(actor, next, this.options.store.database);
    return this.options.store.rebindWindow(actor.ownerId, row.id, row.generation, row.windowId!, {
      windowId: current.windowId,
      windowApp: current.app,
      title: current.title || row.title,
    });
  }
  async #fence(actor: TabActor, row: TabRecord, viewer: TabViewer): Promise<void> {
    const current = await this.#row(actor, row.id);
    if (
      current.generation !== row.generation ||
      (viewer.kind === "page"
        ? current.pageBinding?.sessionId !== viewer.sessionId ||
          current.pageBinding.surfaceId !== viewer.surfaceId
        : canonicalJson(current.pageBinding) !== canonicalJson(row.pageBinding))
    )
      conflict();
  }
  async close(
    actor: TabActor,
    tabIds: TabId[],
    key: string,
    expectedGeneration?: number,
  ): Promise<TabCloseResult> {
    const { closed, failed } = await this.#close(actor, tabIds, key, expectedGeneration);
    return { closed, failed };
  }
  async #close(
    actor: TabActor,
    tabIds: TabId[],
    key: string,
    expectedGeneration?: number,
  ): Promise<TabCloseResult & { layout: TabLayout }> {
    TabCloseInputSchema.parse({ tabIds });
    const ownerId = owner(actor);
    const failed: TabCloseResult["failed"] = [],
      permitted = new Set<TabId>(),
      cleanup: { row: TabRecord; closePage: boolean }[] = [];
    const result = await this.options.store.close(
      ownerId,
      tabIds,
      operationKey(actor, key),
      async (tx, rows) => {
        const denied = (await this.options.deniedRows?.(actor, rows, tx)) ?? new Set<TabId>();
        for (const tabId of tabIds) {
          try {
            const row = rows.find((row) => row.id === tabId);
            if (!row || row.ownerId !== ownerId || denied.has(row.id)) notFound();
            if (expectedGeneration !== undefined && row.generation !== expectedGeneration)
              conflict();
            await this.options.authorizeMembership(actor, tx);
            const task =
              row.pageBinding && row.openedBy && row.openedBy !== "person"
                ? await tx
                    .selectFrom("threads")
                    .select(["originConnectionId", "worker"])
                    .where("id", "=", row.openedBy.taskId)
                    .where("createdBy", "=", ownerId)
                    .executeTakeFirst()
                : undefined;
            permitted.add(tabId);
            if (!row.closedAt)
              cleanup.push({
                row,
                closePage: Boolean(task?.originConnectionId && task.worker === "external"),
              });
          } catch (error) {
            if (expectedGeneration !== undefined) throw error;
            failed.push({
              tabId,
              error: normalizeToolError({
                code: error instanceof OpensteerError ? error.code : "internal_error",
                message: error instanceof OpensteerError ? error.message : "Unable to close tab.",
                next: null,
              }),
            });
          }
        }
      },
      (row) => permitted.has(row.id),
    );
    const meta = tabMutationMeta(result);
    if (!meta.replayed) {
      const ending = cleanup
        .filter(({ row }) => result.tabIds.includes(row.id))
        .map(async ({ row, closePage }) => {
          if (row.kind === "page") await this.options.pages.closeViewers(ownerId, row, closePage);
          else if (row.kind === "phone" || row.kind === "window")
            await this.options.nativeTargets.closeOwnerViews(ownerId, row.id, row.generation);
        });
      this.#applyCatalogMutation(ownerId, result.layout);
      for (const outcome of await Promise.allSettled(ending))
        if (outcome.status === "rejected") this.options.onError(outcome.reason);
    }
    const responseLayout = meta.replayed && meta.currentLayout ? meta.currentLayout : result.layout;
    return {
      closed: result.tabIds.filter((id) => permitted.has(id)),
      failed,
      layout: responseLayout,
    };
  }

  /**
   * Closes a group in one decision on the Home: the members it has now close as a close of each
   * would, and the group goes once none is left. A member that may not close stays, and so does
   * the group; the result names it.
   */
  async closeGroup(
    actor: TabActor,
    groupId: TabGroupId,
    key: string,
    readmit?: TabReadmit,
    /** The members the person was shown: only these close (`tab.group.close` `tabIds`). */
    only?: readonly TabId[],
  ): Promise<TabCloseResult & { groupClosed: boolean; layout: TabLayout }> {
    const permitted = new Set<TabId>(),
      cleanup: { row: TabRecord; closePage: boolean }[] = [];
    const result = await this.options.store.closeGroup(
      owner(actor),
      groupId,
      operationKey(actor, key),
      this.#readmitting(async (tx, rows, layout) => {
        const item = layout.items.find(
          (item) => item.kind === "group" && item.group.groupId === groupId,
        );
        if (item?.kind !== "group") return;
        await this.options.authorizeMembership(actor, tx);
        const denied = (await this.options.deniedRows?.(actor, rows, tx)) ?? new Set<TabId>();
        for (const tabId of item.group.tabIds) {
          const row = rows.find((row) => row.id === tabId);
          if (!row || row.ownerId !== owner(actor) || denied.has(row.id)) continue;
          const task =
            row.pageBinding && row.openedBy && row.openedBy !== "person"
              ? await tx
                  .selectFrom("threads")
                  .select(["originConnectionId", "worker"])
                  .where("id", "=", row.openedBy.taskId)
                  .where("createdBy", "=", owner(actor))
                  .executeTakeFirst()
              : undefined;
          permitted.add(tabId);
          cleanup.push({
            row,
            closePage: Boolean(task?.originConnectionId && task.worker === "external"),
          });
        }
      }, readmit),
      (row) => permitted.has(row.id),
      only,
    );
    // The members this close left in its group are the ones that could not close: read from the
    // mutation's own layout, a replay answers exactly what the first call answered.
    const left = result.layout.items.find(
      (item) => item.kind === "group" && item.group.groupId === groupId,
    );
    const failed: TabCloseResult["failed"] = (left?.kind === "group" ? left.group.tabIds : []).map(
      (tabId) => ({
        tabId,
        error: normalizeToolError({
          code: "not_found",
          message: "This tab is no longer in the list.",
          next: null,
        }),
      }),
    );
    // As a close of each member finishes: viewers end and the catalog moves, once.
    const meta = tabMutationMeta(result);
    if (!meta.replayed) {
      const ending = cleanup
        .filter(({ row }) => result.tabIds.includes(row.id))
        .map(async ({ row, closePage }) => {
          if (row.kind === "page")
            await this.options.pages.closeViewers(owner(actor), row, closePage);
          else if (row.kind === "phone" || row.kind === "window")
            await this.options.nativeTargets.closeOwnerViews(owner(actor), row.id, row.generation);
        });
      this.#applyCatalogMutation(owner(actor), result.layout);
      for (const outcome of await Promise.allSettled(ending))
        if (outcome.status === "rejected") this.options.onError(outcome.reason);
    }
    return {
      // The store's answer, a replay's included: exactly the members this close took.
      closed: result.tabIds,
      failed,
      groupClosed: left === undefined,
      layout: meta.replayed && meta.currentLayout ? meta.currentLayout : result.layout,
    };
  }

  async reopen(
    actor: TabActor,
    tabId: TabId | undefined,
    key: string,
  ): Promise<{ tab: Tab; layout: TabLayout }> {
    const ownerId = owner(actor);
    const database = this.options.store.database;
    const result = await this.options.store.reopen(
      ownerId,
      tabId,
      operationKey(actor, key),
      async (tx, rows, _layout, replayedTabIds) => {
        const targetId = tabId ?? replayedTabIds?.[0];
        const row = targetId
          ? (rows.find((row) => row.id === targetId) ??
            (await this.options.store.get(ownerId, targetId, true, tx)))
          : rows
              .filter((row) => row.closedAt)
              .sort(
                (a, b) => b.closedAt!.getTime() - a.closedAt!.getTime() || a.id.localeCompare(b.id),
              )[0];
        if (!row || !(await this.options.canRead(actor, row, tx))) notFound();
        await this.options.authorize(actor, row, tx);
      },
    );
    const meta = tabMutationMeta(result);
    const responseLayout = meta.replayed && meta.currentLayout ? meta.currentLayout : result.layout;
    try {
      const reopenedId = result.tabIds[0];
      if (!reopenedId) notFound();
      const baseVersion = this.#catalogs.get(ownerId)?.version ?? 0;
      const visibleLayout = await this.#projectVisibleLayout(actor, responseLayout, database);
      const row = await this.options.store.get(ownerId, reopenedId);
      if (!row) notFound();
      if (!meta.replayed && actor.kind === "person") {
        this.#registerWindowBeforeProjection(ownerId, row);
      }
      const groupId = tabGroupOf(visibleLayout, reopenedId);
      const projected = await this.#projectRows(
        actor,
        [row],
        visibleLayout,
        database,
        new Map([[row.id, { groupId }]]),
      );
      const tab = projected.tabs[0];
      if (!tab) notFound();
      if (!meta.replayed) {
        if (actor.kind === "person") {
          this.#applyCatalogMutation(
            ownerId,
            result.layout,
            projected.tabs,
            projected.windowIds,
            baseVersion,
          );
        } else {
          this.changed(ownerId);
        }
      }
      return { tab, layout: visibleLayout };
    } catch (error) {
      if (!meta.replayed) this.changed(ownerId);
      throw error;
    }
  }
  async activate(
    ownerId: UserId,
    tabId: TabId,
    key: string,
  ): Promise<{ tab: Tab; viewer: TabViewer }> {
    const actor = { kind: "person", ownerId } as const;
    let row = await this.#row(actor, tabId);
    await this.options.authorize(actor, row, this.options.store.database);
    let viewer: TabViewer;
    if (row.kind === "page") viewer = await this.options.pages.activate(ownerId, row, key);
    else if (row.kind === "app") {
      await this.options.apps.get(ownerId, row.appId!);
      viewer = { kind: "app", appId: row.appId! };
    } else if (row.kind === "window") {
      const runnerId = await this.options.devices.requireDeviceSelfRunnerId(row.computerId);
      const open = (window: TabRecord, attempt: string) =>
        this.options.nativeTargets.openOwnerView(
          ownerId,
          {
            tabId,
            tabGeneration: window.generation,
            computerId: runnerId,
            target: { kind: "app", app: window.windowApp!, windowId: window.windowId! },
          },
          attempt,
        );
      let view = await open(row, key);
      // The app quit, or this Mac's Opensteer restarted, since the tab chose its window: the
      // same tab shows the app's current window, if it has one, rather than the one that ended.
      if (
        view.state === "unavailable" &&
        (view.unavailableReason === "window-closed" ||
          view.unavailableReason === "window-identity-lost")
      ) {
        const rebound = await this.#rebindWindow(actor, row, runnerId);
        if (rebound) {
          row = rebound;
          view = await open(rebound, `${key}:window:${rebound.windowId}`);
        }
      }
      viewer = { kind: "window", view };
    } else {
      const view =
        row.kind === "phone" && this.options.deviceNativeTargets
          ? await this.options.deviceNativeTargets.openOwnerView(
              ownerId,
              {
                tabId,
                tabGeneration: row.generation,
                computerId: row.computerId,
                target: { kind: "phone", display: "main" },
              },
              key,
            )
          : await this.options.nativeTargets.openOwnerView(
              ownerId,
              {
                tabId,
                tabGeneration: row.generation,
                computerId: await this.options.devices.requireDeviceSelfRunnerId(row.computerId),
                target: { kind: "phone", display: "main" },
              },
              key,
            );
      viewer = { kind: "phone", view };
    }
    this.changed(ownerId, [tabId]);
    const catalogBeforeGet = this.#catalogs.get(ownerId);
    const versionBeforeGet = catalogBeforeGet?.version;
    const epochBeforeGet = catalogBeforeGet?.structureEpoch;
    let tab: Tab;
    try {
      tab = await this.get(ownerId, tabId);
      await this.#fence(actor, row, viewer);
    } catch (error) {
      if (row.kind === "window" || row.kind === "phone")
        await this.options.nativeTargets.closeOwnerViews(ownerId, tabId, row.generation);
      throw error;
    }
    const catalog = this.#catalogs.get(ownerId);
    if (
      catalog &&
      catalog === catalogBeforeGet &&
      catalog.version === versionBeforeGet &&
      catalog.structureEpoch === epochBeforeGet &&
      !catalog.pending &&
      catalog.projectedVersion > 0 &&
      catalog.dirty !== null &&
      catalog.rows.has(tabId)
    ) {
      catalog.rows.set(tabId, tab);
      catalog.rowVersions.set(tabId, versionBeforeGet);
      catalog.dirty.delete(tabId);
    }
    return { tab, viewer };
  }
  async organize(
    actor: TabActor,
    input: TabOrganizeInput,
    key: string,
    fingerprintInput: TabOrganizeInput = input,
  ): Promise<TabOrganizeResult> {
    const { tabs, groups } = await this.#organize(actor, input, key, fingerprintInput);
    return { tabs, groups };
  }
  async #organize(
    actor: TabActor,
    input: TabOrganizeInput,
    key: string,
    fingerprintInput: TabOrganizeInput = input,
  ): Promise<TabOrganizeResult & { layout: TabLayout }> {
    TabOrganizeInputSchema.parse(input);
    const ownerId = owner(actor);
    const database = this.options.store.database;
    const result = await this.options.store.organize(
      ownerId,
      input,
      operationKey(actor, key),
      this.#authorize(
        actor,
        [...input.tabIds, ...(input.beforeTabId ? [input.beforeTabId] : [])],
        input.group && "groupId" in input.group ? [input.group.groupId] : [],
      ),
      fingerprintInput,
    );
    const meta = tabMutationMeta(result);
    const responseLayout = meta.replayed && meta.currentLayout ? meta.currentLayout : result.layout;
    try {
      const baseVersion = this.#catalogs.get(ownerId)?.version ?? 0;
      const visibleLayout = await this.#projectVisibleLayout(actor, responseLayout, database);
      const groupByTab = layoutGroupMap(visibleLayout);
      const fetched = await this.options.store.rows(ownerId, input.tabIds);
      const byId = new Map(fetched.map((row) => [row.id, row]));
      const orderedRows = input.tabIds.flatMap((id) => {
        const row = byId.get(id);
        return row ? [row] : [];
      });
      const groupCatalog = new Map(
        orderedRows.map((row) => [row.id, { groupId: groupByTab.get(row.id) ?? null }]),
      );
      const projected = await this.#projectRows(
        actor,
        orderedRows,
        visibleLayout,
        database,
        groupCatalog,
      );
      if (!meta.replayed) {
        if (actor.kind === "person") {
          this.#applyCatalogMutation(
            ownerId,
            result.layout,
            projected.tabs,
            projected.windowIds,
            baseVersion,
          );
        } else {
          this.#applyCatalogMutation(ownerId, result.layout);
        }
      }
      return {
        tabs: projected.tabs,
        groups: visibleLayout.items.flatMap((item) => (item.kind === "group" ? [item.group] : [])),
        layout: visibleLayout,
      };
    } catch (error) {
      if (!meta.replayed) this.changed(ownerId);
      throw error;
    }
  }
  async updateGroup(actor: TabActor, input: TabGroupUpdateInput, key: string) {
    const { group } = await this.#updateGroup(actor, input, key);
    return { group };
  }
  async #updateGroup(
    actor: TabActor,
    input: TabGroupUpdateInput,
    key: string,
    readmit?: TabReadmit,
  ): Promise<{ group: TabGroup; layout: TabLayout }> {
    TabGroupUpdateInputSchema.parse(input);
    const ownerId = owner(actor);
    const database = this.options.store.database;
    const result = await this.options.store.updateGroup(
      ownerId,
      input,
      operationKey(actor, key),
      this.#readmitting(this.#authorize(actor, [], [input.groupId]), readmit),
    );
    const meta = tabMutationMeta(result);
    if (!meta.replayed) {
      this.#applyCatalogMutation(ownerId, result.layout);
    }
    const responseLayout = meta.replayed && meta.currentLayout ? meta.currentLayout : result.layout;
    const visibleLayout = await this.#projectVisibleLayout(actor, responseLayout, database);
    const item = visibleLayout.items.find(
      (item) => item.kind === "group" && item.group.groupId === input.groupId,
    );
    if (item?.kind !== "group") notFound();
    return { group: item.group, layout: visibleLayout };
  }
  async deleteGroup(ownerId: UserId, groupId: TabGroupId, key: string, readmit?: TabReadmit) {
    const result = await this.options.store.deleteGroup(
      ownerId,
      groupId,
      operationKey({ kind: "person", ownerId }, key),
      this.#readmitting(this.#authorize({ kind: "person", ownerId }, [], [groupId]), readmit),
    );
    const meta = tabMutationMeta(result);
    if (!meta.replayed) {
      this.#applyCatalogMutation(ownerId, result.layout);
    }
    return {
      layout: meta.replayed && meta.currentLayout ? meta.currentLayout : result.layout,
    };
  }
  /** `readmit`: an approved proposal's last admission, run where a group's change is made. */
  async executeCommand(
    ownerId: UserId,
    command: TabCommand,
    readmit?: TabReadmit,
  ): Promise<TabCommandResult> {
    const actor = { kind: "person", ownerId } as const;
    switch (command.type) {
      case "tab.open":
        return {
          type: command.type,
          ...(await this.#open(
            actor,
            command.target,
            command.idempotencyKey,
            undefined,
            command.typed === true,
          )),
        };
      case "tab.reopen":
        return {
          type: command.type,
          ...(await this.reopen(actor, command.tabId, command.idempotencyKey)),
        };
      case "tab.close":
        return {
          type: command.type,
          ...(await this.#close(actor, command.tabIds, command.idempotencyKey)),
        };
      case "tab.activate":
        return {
          type: command.type,
          ...(await this.activate(ownerId, command.tabId, command.idempotencyKey)),
        };
      case "tab.organize": {
        const { type, idempotencyKey, ...input } = command;
        const { tabs, layout } = await this.#organize(actor, input, idempotencyKey);
        return { type, tabs, layout };
      }
      case "tab.group.update": {
        const { type, idempotencyKey, ...input } = command;
        return {
          type,
          ...(await this.#updateGroup(actor, input, idempotencyKey, readmit)),
        };
      }
      case "tab.group.delete":
        return {
          type: command.type,
          ...(await this.deleteGroup(ownerId, command.groupId, command.idempotencyKey, readmit)),
        };
      case "tab.group.close":
        return {
          type: command.type,
          ...(await this.closeGroup(
            actor,
            command.groupId,
            command.idempotencyKey,
            readmit,
            command.tabIds,
          )),
        };
    }
  }
  async bootstrap(ownerId: UserId, maxBytes: number): Promise<TabBootstrap> {
    const { tabs, layout } = await this.project({ kind: "person", ownerId });
    const result: TabBootstrap = { tabs: [], layout, complete: tabs.length === 0 };
    let bytes = Buffer.byteLength(JSON.stringify(result));
    if (bytes > maxBytes)
      throw new OpensteerError({
        code: "conflict",
        message: "Tab layout exceeds the snapshot byte budget.",
      });
    for (const tab of tabs) {
      const size = Buffer.byteLength(JSON.stringify(tab)) + (result.tabs.length ? 1 : 0);
      if (bytes + size > maxBytes) break;
      result.tabs.push(tab);
      bytes += size;
    }
    result.complete = result.tabs.length === tabs.length;
    return result;
  }
  async resourceTabs(
    ownerId: UserId,
    database: TabDatabase,
    input: Parameters<TabStore["resourceTabs"]>[2],
  ) {
    const store = this.options.store;
    const rows = await store.resourceTabs(database, ownerId, input);
    const groups = await store.resourceTabGroups(
      database,
      ownerId,
      rows.map(({ id }) => id),
    );
    const catalog = new Map(rows.map(({ id }) => [id, { groupId: groups.get(id) ?? null }]));
    const { tabs } = await this.#projectRows(
      { kind: "person", ownerId },
      rows,
      { revision: 0, items: [] },
      database,
      catalog,
    );
    const byId = new Map(tabs.map((tab) => [tab.tabId, tab]));
    const shared = (await this.options.sharedChromeTabs?.({ kind: "person", ownerId })) ?? [];
    return [
      ...rows.map(({ id }) => ({ id, tab: byId.get(id) })),
      ...shared
        .filter(
          ({ tabId }) => (!input.after || tabId > input.after) && (!input.id || input.id === tabId),
        )
        .map((tab) => ({ id: tab.tabId, tab })),
    ]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, input.limit);
  }

  async resourceLayout(
    ownerId: UserId,
    database: TabDatabase,
    input: Parameters<TabStore["resourceLayout"]>[2],
  ) {
    await this.options.authorizeMembership({ kind: "person", ownerId }, database);
    return this.options.store.resourceLayout(database, ownerId, input);
  }
  async *browserScriptPages(actor: BrowserBindingTabActor): AsyncGenerator<TabRecord> {
    const db = this.options.store.database;
    const canRead = this.options.readAuthority
      ? await this.options.readAuthority(actor, db)
      : (row: TabRecord) => this.options.canRead(actor, row, db);
    let after: TabId | undefined;
    for (;;) {
      actor.signal?.throwIfAborted();
      const rows = await this.options.store.resourceTabs(db, owner(actor), {
        limit: 32,
        ...(after ? { after } : {}),
      });
      for (const row of rows) {
        actor.signal?.throwIfAborted();
        if (row.kind === "page" && (await canRead(row))) yield row;
      }
      if (rows.length < 32) return;
      after = rows.at(-1)!.id;
    }
  }

  async requireOpenPage(claims: RunToolScope, tabId: TabId): Promise<PageAgentBinding> {
    return this.#bindPage({ kind: "run", claims }, tabId);
  }
  async bindBrowserScript(
    actor: BrowserBindingTabActor,
    tabId: TabId,
    options?: { savedProfileOnly: boolean; expectedGeneration?: number },
  ): Promise<PageAgentBinding> {
    return this.#bindPage(actor, tabId, options);
  }
  async #bindPage(
    actor: Extract<TabActor, { kind: "run" | "browser-binding" }>,
    tabId: TabId,
    options?: { savedProfileOnly: boolean; expectedGeneration?: number },
  ) {
    const row = await this.#row(actor, tabId);
    if (options?.expectedGeneration !== undefined && row.generation !== options.expectedGeneration)
      conflict();
    if (row.kind !== "page")
      throw new OpensteerError({
        code: "bad_request",
        message: "Use Browser Harness only with a page tab.",
      });
    if (options?.savedProfileOnly && !row.profileId)
      throw new OpensteerError({
        code: "forbidden",
        message:
          "This browser connection requires a granted saved profile. Guest tabs are unavailable.",
      });
    await this.options.authorize(actor, row, this.options.store.database);
    if (actor.kind === "browser-binding") actor.signal?.throwIfAborted();
    const binding =
      actor.kind === "run"
        ? await this.options.pages.bind(actor.claims, row)
        : await this.options.pages.bindBrowserScript!(actor, row);
    const current = await this.#row(actor, tabId);
    if (current.generation !== row.generation) conflict();
    return binding;
  }
  async authorizeBind(claims: RunToolScope, tabId: TabId): Promise<void> {
    await this.#row({ kind: "run", claims }, tabId);
  }

  async authorizeShow(claims: RunToolScope, tabId: TabId): Promise<void> {
    const actor = { kind: "run", claims } as const;
    const database = this.options.store.database;
    const row = await this.#row(actor, tabId);
    const { tabs } = await this.#projectRows(
      actor,
      [row],
      { revision: 0, items: [] },
      database,
      new Map([[row.id, { groupId: null }]]),
    );
    const tab = tabs[0];
    if (!tab) notFound();
    if (tab.state === "unavailable")
      throw new OpensteerError({ code: "conflict", message: tab.unavailableReason! });
  }
}
