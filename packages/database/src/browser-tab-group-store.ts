import { createHash } from "node:crypto";
import {
  BrowserTabGroupIdSchema,
  OpensteerError,
  resolveBrowserTabOrder,
  moveBrowserTabs,
  groupBrowserTabs,
  ungroupBrowserTabs,
  browserTabOrderMaxTabs,
  type BrowserTabArrangement,
  type BrowserTabMove,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import {
  BrowserTabGroupColorSchema,
  BrowserTabLayoutSchema,
  BrowserSurfaceIdSchema,
  browserTabGroupsMaxPerOwner,
  browserTabGroupMaxTabs,
  type BrowserTabLayout,
  type BrowserTabGroupColor,
  type BrowserSessionId,
} from "@opensteer/protocol";
import { sql, type Kysely, type Transaction } from "kysely";
import { z } from "zod";
import { withDatabaseTransaction, TransactionScopeChanged } from "./connection.js";
import type { DatabaseSchema } from "./schema.js";
import { visibleWorkspaceTabLineages } from "./workspace-tab-visibility.js";
import { safeCount } from "./store-primitives.js";

type Database = Kysely<DatabaseSchema>;
type GroupId = z.infer<typeof BrowserTabGroupIdSchema>;
interface Mutation {
  readonly idempotencyKey: string;
  readonly tabIds?: readonly string[] | undefined;
  readonly groupId?: GroupId | undefined;
  readonly title?: string | undefined;
  readonly color?: BrowserTabGroupColor | undefined;
  readonly collapsed?: boolean | undefined;
  readonly createdByThreadId?: ThreadId;
  readonly move?: BrowserTabMove;
}

function visibleWorkspaceTabs(database: Database, ownerId: UserId, includeClosed = false) {
  return visibleWorkspaceTabLineages(database, ownerId)
    .innerJoin("workspaceTabs", "workspaceTabs.groupId", "browserSessions.tabGroupId")
    .$if(!includeClosed, (query) => query.where("workspaceTabs.closedAt", "is", null))
    .clearSelect()
    .select([
      "workspaceTabs.id",
      "workspaceTabs.groupId",
      "workspaceTabs.sessionId",
      "workspaceTabs.title",
      "workspaceTabs.url",
      "workspaceTabs.order",
      "workspaceTabs.openerId",
      "workspaceTabs.state",
      "workspaceTabs.closedAt",
      "workspaceTabs.createdAt",
    ])
    .select([
      "browserSessions.id as latestSessionId",
      "browserSessions.workspaceId",
      "lineages.createdAt as lineageCreatedAt",
    ])
    .select(
      sql<string>`to_char(lineages.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
        "lineageTimestamp",
      ),
    );
}
type VisibleTabs = Awaited<ReturnType<ReturnType<typeof visibleWorkspaceTabs>["execute"]>>;

function groupIdForKey(ownerId: UserId, key: string): GroupId {
  const bytes = createHash("sha256")
    .update(["opensteer-tab-group-v1", ownerId, key].join("\0"))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return BrowserTabGroupIdSchema.parse(
    `btg_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}

export class BrowserTabGroupStore {
  readonly database: Database;
  constructor(database: Database) {
    this.database = database;
  }

  async groups(ownerId: UserId, database = this.database) {
    const rows = await visibleWorkspaceTabs(database, ownerId)
      .innerJoin("browserTabGroupMembers", (join) =>
        join
          .onRef("browserTabGroupMembers.tabId", "=", "workspaceTabs.id")
          .on("browserTabGroupMembers.ownerId", "=", ownerId),
      )
      .innerJoin("browserTabGroups", "browserTabGroups.id", "browserTabGroupMembers.groupId")
      .clearSelect()
      .selectAll("browserTabGroups")
      .select(["workspaceTabs.id as tabId", "browserSessions.id as latestSessionId"])
      .orderBy("browserTabGroups.id")
      .orderBy("workspaceTabs.id")
      .execute();
    const groups = new Map<
      GroupId,
      {
        id: GroupId;
        title: string;
        color: BrowserTabGroupColor;
        collapsed: boolean;
        createdByThreadId: ThreadId | null;
        tabIds: z.infer<typeof BrowserSurfaceIdSchema>[];
        sessionIds: BrowserSessionId[];
      }
    >();
    for (const row of rows) {
      let group = groups.get(row.id);
      if (!group) {
        group = {
          id: row.id,
          title: row.title,
          color: row.color,
          collapsed: row.collapsed,
          createdByThreadId: row.createdByThreadId,
          tabIds: [],
          sessionIds: [],
        };
        groups.set(row.id, group);
      }
      group.tabIds.push(BrowserSurfaceIdSchema.parse(row.tabId));
      group.sessionIds.push(row.latestSessionId);
    }
    return [...groups.values()];
  }

  async layout(ownerId: UserId, database?: Database): Promise<BrowserTabLayout> {
    if (!database)
      return this.database
        .transaction()
        .setIsolationLevel("repeatable read")
        .execute((tx) => this.layout(ownerId, tx));
    const [layout, groups] = await Promise.all([
      database
        .selectFrom("browserTabLayouts")
        .select(["revision", "tabOrder"])
        .where("ownerId", "=", ownerId)
        .executeTakeFirst(),
      this.groups(ownerId, database),
    ]);
    const saved = layout?.tabOrder ?? [];
    const visible = new Set(
      saved.length
        ? (
            await visibleWorkspaceTabs(database, ownerId)
              .where("workspaceTabs.id", "in", saved)
              .clearSelect()
              .select("workspaceTabs.id")
              .execute()
          ).map((tab) => tab.id)
        : [],
    );
    return BrowserTabLayoutSchema.parse({
      revision: safeCount(layout?.revision ?? 0),
      groups,
      order: saved.filter((id) => visible.has(id)),
    });
  }

  /** One owner-visible snapshot, also used to give agents compact positions across pages. */
  async orderedTabs(
    ownerId: UserId,
    database?: Database,
  ): Promise<{
    tabs: VisibleTabs;
    groups: Awaited<ReturnType<BrowserTabGroupStore["groups"]>>;
    arrangement: BrowserTabArrangement;
  }> {
    if (!database)
      return this.database
        .transaction()
        .setIsolationLevel("repeatable read")
        .execute((tx) => this.orderedTabs(ownerId, tx));
    const [tabs, groups, layout] = await Promise.all([
      visibleWorkspaceTabs(database, ownerId).execute(),
      this.groups(ownerId, database),
      database
        .selectFrom("browserTabLayouts")
        .select("tabOrder")
        .where("ownerId", "=", ownerId)
        .executeTakeFirst(),
    ]);
    const groupOf = new Map(groups.flatMap((group) => group.tabIds.map((id) => [id, group.id])));
    const order = resolveBrowserTabOrder(
      layout?.tabOrder ?? undefined,
      tabs.map((tab) => ({
        id: tab.id,
        openerId: tab.openerId,
        createdAt: tab.createdAt.toISOString(),
        lineageCreatedAt: tab.lineageCreatedAt.toISOString(),
        order: tab.order,
      })),
      groupOf,
    );
    return { tabs, groups, arrangement: { order, groupOf } satisfies BrowserTabArrangement };
  }

  tabs(
    ownerId: UserId,
    tabIds: readonly string[],
    database = this.database,
    includeClosed = false,
  ) {
    return visibleWorkspaceTabs(database, ownerId, includeClosed)
      .where("workspaceTabs.id", "in", [...tabIds])
      .execute();
  }

  group(
    ownerId: UserId,
    input: Mutation,
    authorizeGroup?: (tabIds: readonly string[], database: Database) => Promise<void>,
  ) {
    return this.#mutate(ownerId, "group", input, authorizeGroup);
  }
  async ungroup(
    ownerId: UserId,
    input: Mutation,
    authorizeGroup?: (tabIds: readonly string[], database: Database) => Promise<void>,
  ) {
    return (await this.#mutate(ownerId, "ungroup", input, authorizeGroup)).layout;
  }
  async move(
    ownerId: UserId,
    input: BrowserTabMove & { readonly idempotencyKey: string },
    authorizeGroup?: (tabIds: readonly string[], database: Database) => Promise<void>,
  ) {
    return (
      await this.#mutate(
        ownerId,
        "move",
        { idempotencyKey: input.idempotencyKey, move: input },
        authorizeGroup,
      )
    ).layout;
  }
  async update(
    ownerId: UserId,
    input: Mutation,
    authorizeGroup?: (tabIds: readonly string[], database: Database) => Promise<void>,
  ) {
    return (await this.#mutate(ownerId, "update_group", input, authorizeGroup)).layout;
  }

  async #mutate(
    ownerId: UserId,
    action: "group" | "ungroup" | "update_group" | "move",
    input: Mutation,
    authorizeGroup?: (tabIds: readonly string[], database: Database) => Promise<void>,
  ) {
    const move = input.move;
    const tabIds = [
      ...new Set(move && "tabIds" in move.item ? move.item.tabIds : (input.tabIds ?? [])),
    ].sort();
    const anchorTabId =
      move?.to.before && "tabId" in move.to.before ? move.to.before.tabId : undefined;
    const involvedGroups = [
      ...new Set([
        ...(input.groupId ? [input.groupId] : []),
        ...(move && "groupId" in move.item ? [move.item.groupId] : []),
        ...(move?.to.groupId ? [move.to.groupId] : []),
        ...(move?.to.before && "groupId" in move.to.before ? [move.to.before.groupId] : []),
      ]),
    ];
    const discover = async (database: Database) => {
      const members = involvedGroups.length
        ? await visibleWorkspaceTabs(database, ownerId)
            .innerJoin("browserTabGroupMembers", (join) =>
              join
                .onRef("browserTabGroupMembers.tabId", "=", "workspaceTabs.id")
                .on("browserTabGroupMembers.ownerId", "=", ownerId),
            )
            .where("browserTabGroupMembers.groupId", "in", involvedGroups)
            .clearSelect()
            .select("workspaceTabs.id")
            .execute()
        : [];
      return [
        ...new Set([
          ...tabIds,
          ...(anchorTabId ? [anchorTabId] : []),
          ...members.map((member) => member.id),
        ]),
      ].sort();
    };
    const groupId = input.groupId ?? groupIdForKey(ownerId, input.idempotencyKey);
    return withDatabaseTransaction(
      this.database,
      async (tx) => {
        const scope = await discover(tx);
        if (scope.length) {
          await tx
            .selectFrom("workspaceTabs")
            .select("id")
            .where("id", "in", scope)
            .orderBy("id")
            .forShare()
            .execute();
        }
        await tx
          .insertInto("browserTabLayouts")
          .values({ ownerId })
          .onConflict((c) => c.column("ownerId").doNothing())
          .execute();
        await tx
          .selectFrom("browserTabLayouts")
          .select("ownerId")
          .where("ownerId", "=", ownerId)
          .forNoKeyUpdate()
          .executeTakeFirstOrThrow();
        const currentScope = await discover(tx);
        if (
          scope.length !== currentScope.length ||
          scope.some((id, index) => id !== currentScope[index])
        )
          throw new TransactionScopeChanged();
        const reachable = new Set(
          scope.length ? (await this.tabs(ownerId, scope, tx)).map((tab) => tab.id) : [],
        );
        if (anchorTabId && !reachable.has(anchorTabId))
          throw new OpensteerError({
            code: "conflict",
            message: "The tab to land before is no longer there.",
          });
        if (tabIds.some((id) => !reachable.has(id)))
          throw new OpensteerError({
            code: "not_found",
            message: "A tab is not a saved tab you can reach.",
          });
        await authorizeGroup?.([...reachable], tx);
        let changed = await this.#pruneOwner(tx, ownerId, scope);
        const before =
          action === "update_group" ? undefined : (await this.orderedTabs(ownerId, tx)).arrangement;
        let arrangement = before;
        const groups = await tx
          .selectFrom("browserTabGroups")
          .selectAll()
          .where("ownerId", "=", ownerId)
          .execute();
        const target =
          action === "ungroup" || action === "move"
            ? undefined
            : groups.find((group) => group.id === groupId);
        const previous = tabIds.length
          ? await tx
              .selectFrom("browserTabGroupMembers")
              .select("groupId")
              .where("ownerId", "=", ownerId)
              .where("tabId", "in", tabIds)
              .execute()
          : [];
        const affectedGroupIds = [
          ...new Set([...previous.map((member) => member.groupId), ...(target ? [target.id] : [])]),
        ];
        if (input.groupId && !target)
          throw new OpensteerError({ code: "not_found", message: "Tab group not found." });
        if (target) {
          const visible = (await this.groups(ownerId, tx)).find((group) => group.id === groupId);
          if (!visible)
            throw new OpensteerError({ code: "not_found", message: "Tab group not found." });
        }
        if (action === "group") {
          if (!tabIds.length)
            throw new OpensteerError({
              code: "bad_request",
              message: "Creating a tab group requires at least one tab.",
            });
          if (!target) {
            changed = true;
            if (groups.length >= browserTabGroupsMaxPerOwner)
              throw new OpensteerError({
                code: "conflict",
                message: "You can keep at most 200 tab groups.",
              });
            const colors = BrowserTabGroupColorSchema.options;
            const color =
              input.color ??
              colors.reduce(
                (least, candidate) =>
                  groups.filter((g) => g.color === candidate).length <
                  groups.filter((g) => g.color === least).length
                    ? candidate
                    : least,
                colors[0]!,
              );
            await tx
              .insertInto("browserTabGroups")
              .values({
                id: groupId,
                ownerId,
                title: input.title ?? "",
                color,
                createdByThreadId: input.createdByThreadId ?? null,
              })
              .execute();
          }
          const members = await tx
            .selectFrom("browserTabGroupMembers")
            .select("tabId")
            .where("groupId", "=", groupId)
            .execute();
          const memberIds = new Set(members.map((member) => member.tabId));
          if (new Set([...memberIds, ...tabIds]).size > browserTabGroupMaxTabs)
            throw new OpensteerError({
              code: "conflict",
              message: "A tab group can keep at most 500 tabs.",
            });
          const addedTabIds = tabIds.filter((tabId) => !memberIds.has(tabId));
          changed ||= addedTabIds.length > 0;
          for (const tabId of addedTabIds)
            await tx
              .insertInto("browserTabGroupMembers")
              .values({ ownerId, tabId, groupId })
              .onConflict((c) => c.columns(["ownerId", "tabId"]).doUpdateSet({ groupId }))
              .execute();
          arrangement = groupBrowserTabs(before!, tabIds, groupId);
        } else if (action === "ungroup") {
          const removed = previous.length > 0;
          changed ||= removed;
          if (removed)
            await tx
              .deleteFrom("browserTabGroupMembers")
              .where("ownerId", "=", ownerId)
              .where("tabId", "in", tabIds)
              .execute();
          arrangement = ungroupBrowserTabs(before!, tabIds);
        } else if (action === "move" && move) {
          const result = moveBrowserTabs(before!, move);
          if (!result.ok) throw new OpensteerError({ code: result.code, message: result.message });
          arrangement = result.arrangement;
          if (move.to.groupId !== null) {
            const members = await tx
              .selectFrom("browserTabGroupMembers")
              .select("tabId")
              .where("groupId", "=", move.to.groupId)
              .execute();
            if (
              new Set([...members.map((member) => member.tabId), ...tabIds]).size >
              browserTabGroupMaxTabs
            )
              throw new OpensteerError({
                code: "conflict",
                message: "A tab group can keep at most 500 tabs.",
              });
          }
          for (const tabId of tabIds) {
            if (before!.groupOf.get(tabId) === arrangement.groupOf.get(tabId)) continue;
            changed = true;
            const destination = arrangement.groupOf.get(tabId);
            if (destination === undefined)
              await tx
                .deleteFrom("browserTabGroupMembers")
                .where("ownerId", "=", ownerId)
                .where("tabId", "=", tabId)
                .execute();
            else
              await tx
                .insertInto("browserTabGroupMembers")
                .values({ ownerId, tabId, groupId: BrowserTabGroupIdSchema.parse(destination) })
                .onConflict((c) =>
                  c
                    .columns(["ownerId", "tabId"])
                    .doUpdateSet({ groupId: BrowserTabGroupIdSchema.parse(destination) }),
                )
                .execute();
          }
        } else if (
          target &&
          ((input.title !== undefined && input.title !== target.title) ||
            (input.color !== undefined && input.color !== target.color) ||
            (input.collapsed !== undefined && input.collapsed !== target.collapsed))
        ) {
          changed = true;
          await tx
            .updateTable("browserTabGroups")
            .set({
              ...(input.title === undefined ? {} : { title: input.title }),
              ...(input.color === undefined ? {} : { color: input.color }),
              ...(input.collapsed === undefined ? {} : { collapsed: input.collapsed }),
              updatedAt: new Date(),
            })
            .where("id", "=", groupId)
            .where("ownerId", "=", ownerId)
            .execute();
        }
        if (arrangement) {
          if (arrangement.order.length > browserTabOrderMaxTabs)
            throw new OpensteerError({
              code: "conflict",
              message:
                "Close some tabs to keep organizing; Opensteer keeps the order of up to 10,000 tabs.",
            });
          const saved = await tx
            .selectFrom("browserTabLayouts")
            .select("tabOrder")
            .where("ownerId", "=", ownerId)
            .executeTakeFirstOrThrow();
          if (
            saved.tabOrder === null ||
            saved.tabOrder.length !== arrangement.order.length ||
            saved.tabOrder.some((id, index) => id !== arrangement.order[index])
          ) {
            changed = true;
            await tx
              .updateTable("browserTabLayouts")
              .set({ tabOrder: sql`${JSON.stringify(arrangement.order)}::jsonb` })
              .where("ownerId", "=", ownerId)
              .execute();
          }
        }
        if (!changed) return { groupId, layout: await this.layout(ownerId, tx) };
        await this.#deleteEmpty(tx, ownerId, affectedGroupIds);
        await tx
          .updateTable("browserTabLayouts")
          .set((eb) => ({ revision: eb("revision", "+", 1) }))
          .where("ownerId", "=", ownerId)
          .execute();
        return { groupId, layout: await this.layout(ownerId, tx) };
      },
      undefined,
      (error) => error instanceof TransactionScopeChanged,
    );
  }

  async #deleteEmpty(
    tx: Transaction<DatabaseSchema>,
    ownerId: UserId,
    groupIds: readonly GroupId[],
  ) {
    if (!groupIds.length) return [];
    return tx
      .deleteFrom("browserTabGroups")
      .where("ownerId", "=", ownerId)
      .where("id", "in", [...groupIds])
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("browserTabGroupMembers")
              .select("tabId")
              .whereRef("browserTabGroupMembers.groupId", "=", "browserTabGroups.id"),
          ),
        ),
      )
      .execute();
  }
  async #pruneOwner(
    tx: Transaction<DatabaseSchema>,
    ownerId: UserId,
    tabIds: readonly string[] = [],
  ) {
    const groups = await tx
      .selectFrom("browserTabGroups")
      .select("id")
      .where("ownerId", "=", ownerId)
      .orderBy("id")
      // FOR UPDATE: Cleanup and mutations can delete any group losing its last member.
      .forUpdate()
      .execute();
    const closed = await tx
      .selectFrom("browserTabGroupMembers")
      .innerJoin("workspaceTabs", "workspaceTabs.id", "browserTabGroupMembers.tabId")
      .select("browserTabGroupMembers.tabId")
      .where("browserTabGroupMembers.ownerId", "=", ownerId)
      .where("workspaceTabs.closedAt", "is not", null)
      .execute();
    // Closed markers are irreversible; fix this set before locking so later closes cannot add unordered locks.
    const closedIds = closed.map((member) => member.tabId);
    const memberIds = [...new Set([...closedIds, ...tabIds])];
    if (memberIds.length)
      await tx
        .selectFrom("browserTabGroupMembers")
        .select(["ownerId", "tabId"])
        .where("ownerId", "=", ownerId)
        .where("tabId", "=", sql<string>`any(${memberIds}::text[])`)
        .orderBy("ownerId")
        .orderBy("tabId")
        // FOR UPDATE: Memberships are deleted by cleanup/ungroup or moved between groups.
        .forUpdate()
        .execute();
    const deletedMembers = closedIds.length
      ? await tx
          .deleteFrom("browserTabGroupMembers")
          .where("ownerId", "=", ownerId)
          .where("tabId", "=", sql<string>`any(${closedIds}::text[])`)
          .executeTakeFirst()
      : undefined;
    const deletedGroups = await this.#deleteEmpty(
      tx,
      ownerId,
      groups.map((group) => group.id),
    );
    return (
      (deletedMembers?.numDeletedRows ?? 0n) > 0n ||
      deletedGroups.some((result) => result.numDeletedRows > 0n)
    );
  }
  async prune() {
    const owners = await this.database
      .selectFrom("browserTabLayouts")
      .select("ownerId")
      .orderBy("ownerId")
      .execute();
    for (const { ownerId } of owners)
      await withDatabaseTransaction(this.database, async (tx) => {
        const layout = await tx
          .selectFrom("browserTabLayouts")
          .select("tabOrder")
          .where("ownerId", "=", ownerId)
          .forNoKeyUpdate()
          .executeTakeFirst();
        const saved = layout?.tabOrder ?? [];
        const remaining = new Set(
          saved.length
            ? (
                await tx
                  .selectFrom("workspaceTabs")
                  .select("id")
                  .where("id", "in", saved)
                  .where("closedAt", "is", null)
                  .execute()
              ).map((tab) => tab.id)
            : [],
        );
        const order = saved.filter((id) => remaining.has(id));
        const orderChanged = order.length !== saved.length;
        const membershipChanged = await this.#pruneOwner(tx, ownerId);
        if (orderChanged || membershipChanged)
          await tx
            .updateTable("browserTabLayouts")
            .set((eb) => ({
              revision: eb("revision", "+", 1),
              ...(orderChanged ? { tabOrder: sql`${JSON.stringify(order)}::jsonb` } : {}),
            }))
            .where("ownerId", "=", ownerId)
            .execute();
      });
  }
}
