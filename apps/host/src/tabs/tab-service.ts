import type { OpensteerStore } from "@opensteer/database";
import { requireSelfDeviceId } from "@opensteer/database";
import { normalizeToolError } from "@opensteer/agent-tools";
import {
  OpensteerError,
  TabIdSchema,
  TabSchema,
  DeviceTabTargetSchema,
  type AppId,
  type DeviceId,
  type Tab,
  type TabGroupId,
  type TabId,
  type TabLayout,
  type TabOpenedBy,
  type TabTarget,
  type UserId,
} from "@opensteer/core";
import {
  TabCloseInputSchema,
  TabGroupUpdateInputSchema,
  TabListInputSchema,
  TabOrganizeInputSchema,
  type TabBootstrap,
  type TabCloseResult,
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
  type TabAuthorization,
  type TabDatabase,
  type TabRecord,
  type TabWrite,
} from "@opensteer/database";
import type { RunToolScope } from "../agents/run-tool-tokens.js";
import type {
  AppTabPort,
  NativeTabTargetsPort,
  DeviceNativeTabTargetsPort,
  DeviceNativeTargetAcquired,
  NativeTabTargetState,
  PageAgentBinding,
  TabActor,
  TabServicePort,
} from "./ports.js";

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
  closeViewers(ownerId: UserId, row: TabRecord): Promise<void>;
}
export interface TabServiceOptions {
  store: TabStore;
  devices: Pick<OpensteerStore, "requireSelfDeviceId" | "requireDeviceSelfRunnerId">;
  nativeTargets: NativeTabTargetsPort;
  deviceNativeTargets?: DeviceNativeTabTargetsPort;
  pages: PageTabsPort;
  apps: Pick<AppTabPort, "get">;
  computer(
    ownerId: UserId,
    computerId: DeviceId,
    database: TabDatabase,
  ): Promise<{ name: string; connected: boolean; removed: boolean }>;
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
  ): Promise<Map<DeviceId, { name: string; connected: boolean; removed: boolean }>>;
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
  onError(error: unknown): void;
}
function owner(actor: TabActor): UserId {
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

export class TabService implements TabServicePort {
  readonly #stopAcquired: () => void;
  readonly options: TabServiceOptions;
  readonly #catalogs = new Map<
    UserId,
    {
      rows: Map<TabId, Tab>;
      layout: TabLayout;
      dirty: Set<TabId> | null;
      pending?: Promise<{ rows: ReadonlyMap<TabId, Tab>; layout: TabLayout }>;
    }
  >();
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
      async (ownerId) => (await options.store.snapshot(ownerId)).layout.revision,
    );
  }
  changed(ownerId?: UserId, tabIds?: readonly TabId[]): void {
    for (const [id, catalog] of this.#catalogs) {
      if (ownerId && id !== ownerId) continue;
      if (!tabIds) catalog.dirty = null;
      else if (catalog.dirty) for (const tabId of tabIds) catalog.dirty.add(tabId);
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
  dispose(): void {
    this.#stopAcquired();
    this.#catalogs.clear();
  }
  async #catalog(ownerId: UserId) {
    let catalog = this.#catalogs.get(ownerId);
    if (!catalog) {
      catalog = { rows: new Map(), layout: { revision: 0, items: [] }, dirty: null };
      this.#catalogs.set(ownerId, catalog);
    }
    const current = catalog;
    current.pending ??= (async () => {
      do {
        const ids = current.dirty;
        current.dirty = new Set();
        try {
          if (ids === null) {
            const projected = await this.#snapshotProject(
              { kind: "person", ownerId },
              this.options.store.database,
            );
            current.rows = new Map(projected.tabs.map((tab) => [tab.tabId, tab]));
            current.layout = projected.layout;
          } else if (ids.size) {
            const rows = await this.options.store.rows(ownerId, [...ids]);
            if (rows.length !== ids.size || rows.some((row) => !current.rows.has(row.id))) {
              current.dirty = null;
              continue;
            }
            const projected = await this.#projectRows(
              { kind: "person", ownerId },
              rows,
              current.layout,
              this.options.store.database,
              current.rows,
            );
            for (const id of ids)
              if (!projected.tabs.some((tab) => tab.tabId === id)) current.rows.delete(id);
            for (const tab of projected.tabs) current.rows.set(tab.tabId, tab);
          }
        } catch (error) {
          current.dirty = null;
          throw error;
        }
      } while (current.dirty === null || current.dirty.size);
      return { rows: current.rows, layout: current.layout };
    })().finally(() => {
      delete current.pending;
    });
    return current.pending;
  }

  /** The same ordered projection feeds resource reads and RPCs. */
  async project(
    actor: TabActor,
    database = this.options.store.database,
  ): Promise<{ tabs: Tab[]; layout: TabLayout }> {
    if (actor.kind === "person" && database === this.options.store.database) {
      await this.options.authorizeMembership(actor, database);
      const { rows, layout } = await this.#catalog(actor.ownerId);
      return { tabs: [...rows.values()], layout };
    }
    return this.#snapshotProject(actor, database);
  }
  async #snapshotProject(
    actor: TabActor,
    database: TabDatabase,
  ): Promise<{ tabs: Tab[]; layout: TabLayout }> {
    const ownerId = owner(actor),
      { rows, layout } = await this.options.store.snapshot(ownerId, database);
    return this.#projectRows(actor, rows, layout, database);
  }
  async #projectRows(
    actor: TabActor,
    rows: TabRecord[],
    layout: TabLayout,
    database: TabDatabase,
    catalog?: ReadonlyMap<TabId, Pick<Tab, "groupId">>,
  ): Promise<{ tabs: Tab[]; layout: TabLayout }> {
    const ownerId = owner(actor);
    const canRead = this.options.readAuthority
      ? await this.options.readAuthority(actor, database)
      : (row: TabRecord) => this.options.canRead(actor, row, database);
    const visible = new Set(
      (await Promise.all(rows.map(async (row) => ((await canRead(row)) ? row.id : null)))).filter(
        (id): id is TabId => id !== null,
      ),
    );
    const hiddenGroups = new Set(
      catalog
        ? []
        : layout.items.flatMap((item) =>
            item.kind === "group" && item.group.tabIds.some((id) => !visible.has(id))
              ? [item.group.groupId]
              : [],
          ),
    );
    const projected: TabLayout = catalog
      ? layout
      : {
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
    const pageStates = this.options.pages.states
      ? await this.options.pages.states(
          ownerId,
          shown.filter((row) => row.kind === "page"),
        )
      : undefined;
    let tabs = await Promise.all(
      shown.map(async (row) => {
        const tab = await this.#tab(actor, row, projected, {
          computer: computers.get(row.computerId)!,
          profile: row.profileId ? profiles.get(row.profileId) : undefined,
          live: pageStates?.get(row.id),
          groupId: catalog?.get(row.id)?.groupId,
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
    return { tabs, layout: projected };
  }
  async #tab(
    actor: TabActor,
    row: TabRecord,
    layout: TabLayout,
    facts: {
      computer: { name: string; connected: boolean; removed: boolean };
      profile?: string | undefined;
      live?: NativeTabTargetState | undefined;
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
      live = await this.options.nativeTargets.windowState(
        ownerId,
        await this.options.devices.requireDeviceSelfRunnerId(row.computerId),
        row.windowId!,
      );
    else if (row.kind === "phone")
      live = this.options.deviceNativeTargets
        ? await this.options.deviceNativeTargets.phoneState(ownerId, row.computerId)
        : await this.options.nativeTargets.phoneState(
            ownerId,
            await this.options.devices.requireDeviceSelfRunnerId(row.computerId),
          );
    else if (row.kind === "page")
      live = facts.live ?? (await this.options.pages.state(ownerId, row));
    else {
      const app = await this.options.apps.get(ownerId, row.appId!).catch((error: unknown) => {
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
  async list(actor: TabActor, input: TabListInput): Promise<TabListResult> {
    input = TabListInputSchema.parse(input);
    const { tabs, layout } = await this.project(actor);
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
            tab.computer.name,
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
      for (const id of affected) {
        const row = rows.find((row) => row.id === id);
        if (!row || row.ownerId !== owner(actor)) notFound();
      }
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
    const target = DeviceTabTargetSchema.parse(targetInput);
    const ownerId = owner(actor),
      database = this.options.store.database;
    await this.options.authorize(actor, target, database);
    const initialRevision =
      membershipRevision ?? (await this.options.store.snapshot(ownerId)).layout.revision;
    const openedBy: TabOpenedBy =
      actor.kind === "run" ? { taskId: actor.claims.threadId } : "person";
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
    if (write.kind === "page") await this.options.pages.admitted?.(write);
    this.changed(ownerId);
    return { tab: await this.#get(actor, result.tabIds[0]!) };
  }
  get(ownerId: UserId, tabId: TabId): Promise<Tab> {
    return this.#get({ kind: "person", ownerId }, tabId);
  }
  async #get(actor: TabActor, tabId: TabId): Promise<Tab> {
    const { tabs } = await this.project(actor);
    return tabs.find((tab) => tab.tabId === tabId) ?? notFound();
  }
  async #row(actor: TabActor, tabId: TabId): Promise<TabRecord> {
    const row = await this.options.store.get(owner(actor), tabId);
    if (!row || !(await this.options.canRead(actor, row, this.options.store.database))) notFound();
    return row;
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
  async close(actor: TabActor, tabIds: TabId[], key: string): Promise<TabCloseResult> {
    TabCloseInputSchema.parse({ tabIds });
    const failed: TabCloseResult["failed"] = [],
      permitted = new Set<TabId>(),
      cleanup: TabRecord[] = [];
    const result = await this.options.store.close(
      owner(actor),
      tabIds,
      operationKey(actor, key),
      async (tx, rows) => {
        for (const tabId of tabIds) {
          try {
            const row = rows.find((row) => row.id === tabId);
            if (!row || row.ownerId !== owner(actor)) notFound();
            await this.options.authorizeMembership(actor, tx);
            permitted.add(tabId);
            cleanup.push(row);
          } catch (error) {
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
    this.changed(owner(actor));
    for (const row of cleanup)
      if (result.tabIds.includes(row.id)) {
        try {
          if (row.kind === "page") await this.options.pages.closeViewers(owner(actor), row);
          else if (row.kind === "phone" || row.kind === "window")
            await this.options.nativeTargets.closeOwnerViews(owner(actor), row.id, row.generation);
        } catch (error) {
          this.options.onError(error);
        }
      }
    return { closed: result.tabIds.filter((id) => permitted.has(id)), failed };
  }

  async reopen(
    actor: TabActor,
    tabId: TabId | undefined,
    key: string,
  ): Promise<{ tab: Tab; layout: TabLayout }> {
    const result = await this.options.store.reopen(
      owner(actor),
      tabId,
      operationKey(actor, key),
      async (tx, rows) => {
        const row = tabId
          ? rows.find((row) => row.id === tabId)
          : rows
              .filter((row) => row.closedAt)
              .sort(
                (a, b) => b.closedAt!.getTime() - a.closedAt!.getTime() || a.id.localeCompare(b.id),
              )[0];
        if (!row || !(await this.options.canRead(actor, row, tx))) notFound();
        await this.options.authorize(actor, row, tx);
      },
    );
    this.changed(owner(actor));
    const projected = await this.project(actor);
    const tab = projected.tabs.find((tab) => tab.tabId === result.tabIds[0]);
    if (!tab) notFound();
    return { tab, layout: projected.layout };
  }
  async activate(
    ownerId: UserId,
    tabId: TabId,
    key: string,
  ): Promise<{ tab: Tab; viewer: TabViewer }> {
    const actor = { kind: "person", ownerId } as const,
      row = await this.#row(actor, tabId);
    await this.options.authorize(actor, row, this.options.store.database);
    let viewer: TabViewer;
    if (row.kind === "page") viewer = await this.options.pages.activate(ownerId, row, key);
    else if (row.kind === "app") {
      await this.options.apps.get(ownerId, row.appId!);
      viewer = { kind: "app", appId: row.appId! };
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
                target:
                  row.kind === "phone"
                    ? { kind: "phone", display: "main" }
                    : { kind: "app", app: row.windowApp!, windowId: row.windowId! },
              },
              key,
            );
      viewer = { kind: row.kind, view };
    }
    this.changed(ownerId, [tabId]);
    let tab: Tab;
    try {
      tab = await this.get(ownerId, tabId);
      await this.#fence(actor, row, viewer);
    } catch (error) {
      if (row.kind === "window" || row.kind === "phone")
        await this.options.nativeTargets.closeOwnerViews(ownerId, tabId, row.generation);
      throw error;
    }
    return { tab, viewer };
  }
  async organize(
    actor: TabActor,
    input: TabOrganizeInput,
    key: string,
    fingerprintInput: TabOrganizeInput = input,
  ): Promise<TabOrganizeResult> {
    TabOrganizeInputSchema.parse(input);
    await this.options.store.organize(
      owner(actor),
      input,
      operationKey(actor, key),
      this.#authorize(
        actor,
        [...input.tabIds, ...(input.beforeTabId ? [input.beforeTabId] : [])],
        input.group && "groupId" in input.group ? [input.group.groupId] : [],
      ),
      fingerprintInput,
    );
    this.changed(owner(actor));
    const { tabs, layout } = await this.project(actor);
    return {
      tabs: input.tabIds.flatMap((id) => tabs.filter((tab) => tab.tabId === id)),
      groups: layout.items.flatMap((item) => (item.kind === "group" ? [item.group] : [])),
    };
  }
  async updateGroup(actor: TabActor, input: TabGroupUpdateInput, key: string) {
    TabGroupUpdateInputSchema.parse(input);
    await this.options.store.updateGroup(
      owner(actor),
      input,
      operationKey(actor, key),
      this.#authorize(actor, [], [input.groupId]),
    );
    this.changed(owner(actor));
    const { layout } = await this.project(actor);
    const item = layout.items.find(
      (item) => item.kind === "group" && item.group.groupId === input.groupId,
    );
    if (item?.kind !== "group") notFound();
    return { group: item.group };
  }
  async deleteGroup(ownerId: UserId, groupId: TabGroupId, key: string) {
    const { layout } = await this.options.store.deleteGroup(
      ownerId,
      groupId,
      operationKey({ kind: "person", ownerId }, key),
      this.#authorize({ kind: "person", ownerId }, [], [groupId]),
    );
    this.changed(ownerId);
    return { layout };
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
    return rows.map(({ id }) => ({ id, tab: byId.get(id) }));
  }

  async resourceLayout(
    ownerId: UserId,
    database: TabDatabase,
    input: Parameters<TabStore["resourceLayout"]>[2],
  ) {
    await this.options.authorizeMembership({ kind: "person", ownerId }, database);
    return this.options.store.resourceLayout(database, ownerId, input);
  }
  async requireOpenPage(claims: RunToolScope, tabId: TabId): Promise<PageAgentBinding> {
    const actor = { kind: "run", claims } as const,
      row = await this.#row(actor, tabId);
    if (row.kind !== "page")
      throw new OpensteerError({
        code: "bad_request",
        message: "Use Browser Harness only with a page tab.",
      });
    await this.options.authorize(actor, row, this.options.store.database);
    const binding = await this.options.pages.bind(claims, row);
    const current = await this.#row(actor, tabId);
    if (current.generation !== row.generation) conflict();
    return binding;
  }
  async authorizeShow(claims: RunToolScope, tabId: TabId): Promise<void> {
    const actor = { kind: "run", claims } as const;
    await this.#row(actor, tabId);
    const { tabs } = await this.project(actor);
    const tab = tabs.find((tab) => tab.tabId === tabId);
    if (!tab) notFound();
    if (tab.state === "unavailable")
      throw new OpensteerError({ code: "conflict", message: tab.unavailableReason! });
  }
}
