import { normalizeToolError } from "@opensteer/agent-tools";
import {
  OpensteerError,
  TabIdSchema,
  TabSchema,
  TabTargetSchema,
  type AppId,
  type RunnerId,
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
  NativeTabTargetState,
  PageAgentBinding,
  TabActor,
  TabServicePort,
} from "./ports.js";
import { TabStreams } from "./tab-streams.js";

export interface PageTabsPort {
  open(
    actor: TabActor,
    target: Extract<TabTarget, { kind: "page" }>,
    key: string,
  ): Promise<TabWrite>;
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
  nativeTargets: NativeTabTargetsPort;
  pages: PageTabsPort;
  apps: Pick<AppTabPort, "get">;
  computer(
    ownerId: UserId,
    computerId: RunnerId,
    database: TabDatabase,
  ): Promise<{ name: string; connected: boolean; removed: boolean }>;
  /** Metadata reach includes offline computers; this must not depend on runtime connectivity. */
  canRead(actor: TabActor, row: TabRecord, database: TabDatabase): Promise<boolean>;
  canReadTask(
    actor: TabActor,
    taskId: RunToolScope["threadId"],
    database: TabDatabase,
  ): Promise<boolean>;
  /** Rechecks the Run/connection and current grants. Called again inside membership commits. */
  authorize(actor: TabActor, target: TabTarget | TabRecord, database: TabDatabase): Promise<void>;
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
  readonly streams: TabStreams;
  readonly #stopAcquired: () => void;
  readonly options: TabServiceOptions;
  constructor(options: TabServiceOptions) {
    this.options = options;
    this.streams = new TabStreams(
      (ownerId) => this.project({ kind: "person", ownerId }),
      options.onError,
    );
    this.#stopAcquired = options.nativeTargets.onTargetAcquired(async (target) => {
      if (target.ownerId !== target.runClaims.requestedBy) notFound();
      const opened = await this.open(
        { kind: "run", claims: target.runClaims },
        target.kind === "window"
          ? { kind: "window", computerId: target.computerId, windowId: target.windowId }
          : { kind: "phone", computerId: target.computerId },
        target.key,
      );
      return opened.tab.tabId;
    });
  }
  changed(ownerId?: UserId): void {
    this.streams.changed(ownerId);
  }
  appsChanged(_appIds: AppId[]): void {
    this.changed();
  }
  dispose(): void {
    this.#stopAcquired();
    this.streams.close();
  }

  /** The same ordered projection feeds bootstrap, snapshots, RPCs and the keyed stream. */
  async project(
    actor: TabActor,
    database = this.options.store.database,
  ): Promise<{ tabs: Tab[]; layout: TabLayout }> {
    const ownerId = owner(actor),
      { rows, layout } = await this.options.store.snapshot(ownerId, database);
    const visible = new Set(
      (
        await Promise.all(
          rows.map(async (row) =>
            (await this.options.canRead(actor, row, database)) ? row.id : null,
          ),
        )
      ).filter((id): id is TabId => id !== null),
    );
    const hiddenGroups = new Set(
      layout.items.flatMap((item) =>
        item.kind === "group" && item.group.tabIds.some((id) => !visible.has(id))
          ? [item.group.groupId]
          : [],
      ),
    );
    const projected: TabLayout = {
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
    const tabs = await Promise.all(
      rows
        .filter((row) => visible.has(row.id))
        .map((row) => this.#tab(actor, row, projected, database)),
    );
    return { tabs, layout: projected };
  }
  async #tab(
    actor: TabActor,
    row: TabRecord,
    layout: TabLayout,
    database: TabDatabase,
  ): Promise<Tab> {
    const ownerId = owner(actor),
      computer = await this.options.computer(ownerId, row.computerId, database);
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
      live = await this.options.nativeTargets.windowState(ownerId, row.computerId, row.windowId!);
    else if (row.kind === "phone")
      live = await this.options.nativeTargets.phoneState(ownerId, row.computerId);
    else if (row.kind === "page") live = await this.options.pages.state(ownerId, row);
    else {
      const app = await this.options.apps.get(ownerId, row.appId!);
      title = app.name;
      live =
        app.kind === "html" || app.state === "running"
          ? { state: "open", usedBy: [] }
          : {
              state: "unavailable",
              usedBy: [],
              unavailableCode:
                app.state === "offline"
                  ? "computer-offline"
                  : app.state === "stopped"
                    ? "app-stopped"
                    : "app-failed",
              unavailableReason:
                app.state === "offline"
                  ? "This computer is offline."
                  : app.state === "stopped"
                    ? "This app is stopped."
                    : "This app failed to start.",
            };
    }
    const profile =
      row.kind === "page" && row.profileId
        ? await database
            .selectFrom("browserProfiles")
            .select("name")
            .where("id", "=", row.profileId)
            .where("ownerId", "=", ownerId)
            .executeTakeFirst()
        : null;
    const holders = await Promise.all(
      [...new Set(live.usedBy.map((holder) => holder.taskId))]
        .sort()
        .map(async (taskId) =>
          (await this.options.canReadTask(actor, taskId, database)) ? { taskId } : null,
        ),
    );
    const usedBy = holders
      .filter((holder): holder is { taskId: RunToolScope["threadId"] } => holder !== null)
      .slice(0, 128);
    return TabSchema.parse({
      tabId: row.id,
      kind: row.kind,
      title,
      computer: { computerId: row.computerId, name: computer.name },
      groupId: tabGroupOf(layout, row.id),
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
              ? { profileId: row.profileId, name: profile?.name ?? row.profileName! }
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
        if (!row || !(await this.options.canRead(actor, row, tx))) notFound();
        await this.options.authorize(actor, row, tx);
      }
    };
  }
  async open(actor: TabActor, target: TabTarget, key: string): Promise<{ tab: Tab }> {
    TabTargetSchema.parse(target);
    const ownerId = owner(actor),
      database = this.options.store.database;
    await this.options.authorize(actor, target, database);
    const initialRevision = (await this.options.store.snapshot(ownerId)).layout.revision;
    const openedBy: TabOpenedBy =
      actor.kind === "run" ? { taskId: actor.claims.threadId } : "person";
    const hash = operationKey(actor, key);
    const id = TabIdSchema.parse(
      `tab_${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`,
    );
    let write: TabWrite;
    let appFence: { version: number; generation: number | null } | undefined;
    if (target.kind === "page")
      write = await this.options.pages.open(actor, target, operationKey(actor, key));
    else if (target.kind === "app") {
      const app = await this.options.apps.get(ownerId, target.appId);
      appFence = { version: app.version, generation: app.server?.generation ?? null };
      write = {
        id,
        ownerId,
        kind: "app",
        computerId: app.computerId,
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
          target.computerId,
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
        if (write.kind === "window")
          await this.options.authorize(
            actor,
            { kind: "window", computerId: write.computerId, windowId: write.windowId! },
            tx,
          );
        if (target.kind === "app") {
          const current = await tx
            .selectFrom("apps")
            .select(["deleting", "computerId", "latestVersion"])
            .where("id", "=", target.appId)
            .where("ownerId", "=", ownerId)
            .executeTakeFirst();
          if (!current || current.deleting || current.computerId !== write.computerId) notFound();
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
    await this.options.authorize(actor, row, this.options.store.database);
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
            if (!row || !(await this.options.canRead(actor, row, tx))) notFound();
            await this.options.authorize(actor, row, tx);
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
    let viewer: TabViewer;
    if (row.kind === "page") viewer = await this.options.pages.activate(ownerId, row, key);
    else if (row.kind === "app") {
      await this.options.apps.get(ownerId, row.appId!);
      viewer = { kind: "app", appId: row.appId! };
    } else {
      const view = await this.options.nativeTargets.openOwnerView(
        ownerId,
        {
          tabId,
          tabGeneration: row.generation,
          computerId: row.computerId,
          target:
            row.kind === "phone"
              ? { kind: "phone", display: "main" }
              : { kind: "app", app: row.windowApp!, windowId: row.windowId! },
        },
        key,
      );
      viewer = { kind: row.kind, view };
    }
    let tab: Tab;
    try {
      tab = await this.get(ownerId, tabId);
      await this.#fence(actor, row, viewer);
    } catch (error) {
      if (row.kind === "window" || row.kind === "phone")
        await this.options.nativeTargets.closeOwnerViews(ownerId, tabId, row.generation);
      throw error;
    }
    this.changed(ownerId);
    return { tab, viewer };
  }
  async organize(
    actor: TabActor,
    input: TabOrganizeInput,
    key: string,
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
  async requireOpenPage(claims: RunToolScope, tabId: TabId): Promise<PageAgentBinding> {
    const actor = { kind: "run", claims } as const,
      row = await this.#row(actor, tabId);
    if (row.kind !== "page")
      throw new OpensteerError({
        code: "bad_request",
        message: "Use Browser Harness only with a page tab.",
      });
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
