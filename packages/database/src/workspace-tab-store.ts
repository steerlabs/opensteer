import { createHash, randomUUID } from "node:crypto";
import { OpensteerError, browserTabOrderMaxTabs, type UserId } from "@opensteer/core";
import {
  BrowserSurfaceIdSchema,
  BrowserTabGroupIdSchema,
  BrowserFaviconSchema,
  browserPageSite,
  projectBrowserSessionOpener,
  browserTabOpenReplayWindowMs,
  browserTabGroupMaxTabs,
  type BrowserSessionId,
  type BrowserWorkspaceTabDescriptor,
  type WorkspaceTabLineage,
} from "@opensteer/protocol";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import { TransactionScopeChanged, withDatabaseTransaction } from "./connection.js";
import { lockBrowserTabGroupMembersForTabs } from "./browser-tab-group-locks.js";
import { authorizedPlaceThreadIds, getBrowserSessionForOwner } from "./browser-session-store.js";
import { visibleWorkspaceTabLineages } from "./workspace-tab-visibility.js";
import { BrowserTabGroupStore } from "./browser-tab-group-store.js";
import type { DatabaseSchema } from "./schema.js";

type Database = Kysely<DatabaseSchema>;
type TabRow = Selectable<DatabaseSchema["workspaceTabs"]>;

export function workspaceTabIconRef(groupId: BrowserSessionId, favicon: string): string {
  return createHash("sha256").update(groupId).update("\0").update(favicon).digest("base64url");
}

export type WorkspaceTabDescriptor = BrowserWorkspaceTabDescriptor & {
  readonly favicon?: string | null;
};

/** Session history is the authority; tabs hold only descriptors and a fenced binding. */
export class WorkspaceTabStore {
  readonly database: Database;
  constructor(database: Database) {
    this.database = database;
  }

  async #latest(groupId: BrowserSessionId, database = this.database) {
    return database
      .selectFrom("browserSessions")
      .selectAll()
      .where("tabGroupId", "=", groupId)
      .orderBy("createdAt", "desc")
      .orderBy("id", "desc")
      .executeTakeFirst();
  }
  async session(ownerId: UserId, groupId: BrowserSessionId, database = this.database) {
    const latest = await this.#latest(groupId, database);
    if (!latest) return null;
    const workspace = await database
      .selectFrom("workspaces")
      .select("id")
      .where("id", "=", latest.workspaceId)
      .where("status", "not in", ["deleting", "deleted"])
      .executeTakeFirst();
    return workspace ? getBrowserSessionForOwner(database, latest.id, ownerId) : null;
  }
  async lineageForSession(sessionId: BrowserSessionId) {
    return (
      (
        await this.database
          .selectFrom("browserSessions")
          .select("tabGroupId")
          .where("id", "=", sessionId)
          .executeTakeFirst()
      )?.tabGroupId ?? null
    );
  }
  async #read(
    ownerId: UserId,
    groupId?: BrowserSessionId,
    database?: Database,
  ): Promise<WorkspaceTabLineage[]> {
    if (!database)
      return this.database
        .transaction()
        .setIsolationLevel("repeatable read")
        .execute((tx) => this.#read(ownerId, groupId, tx));
    let query = visibleWorkspaceTabLineages(database, ownerId);
    if (groupId) query = query.where("lineages.id", "=", groupId);
    else {
      query = query.where((eb) =>
        eb.exists(
          eb
            .selectFrom("workspaceTabs")
            .select("id")
            .whereRef("workspaceTabs.groupId", "=", "browserSessions.tabGroupId")
            .where("closedAt", "is", null),
        ),
      );
      query = query.orderBy(
        (eb) =>
          eb.exists(
            eb
              .selectFrom("browserTabGroupMembers")
              .innerJoin("workspaceTabs", "workspaceTabs.id", "browserTabGroupMembers.tabId")
              .select("browserTabGroupMembers.tabId")
              .where("browserTabGroupMembers.ownerId", "=", ownerId)
              .whereRef("workspaceTabs.groupId", "=", "browserSessions.tabGroupId")
              .where("workspaceTabs.closedAt", "is", null),
          ),
        "desc",
      );
    }
    const groups = await query
      .orderBy("lineages.createdAt", "desc")
      .orderBy("lineages.id", "desc")
      .limit(100)
      .execute();
    if (!groups.length) return [];
    const rows = await database
      .selectFrom("workspaceTabs")
      .select([
        "id",
        "groupId",
        "sessionId",
        "title",
        "url",
        "iconRef",
        "order",
        "openerId",
        "state",
        "createdAt",
      ])
      .where(
        "groupId",
        "in",
        groups.map((group) => group.tabGroupId),
      )
      .where("closedAt", "is", null)
      .orderBy("order")
      .execute();
    const visibleThreadIds = new Set(
      await authorizedPlaceThreadIds(
        database,
        ownerId,
        groups.flatMap((group) =>
          group.opener && "threadId" in group.opener ? [group.opener.threadId] : [],
        ),
      ),
    );
    return groups.map((group) => ({
      ...(group.retiredAt ? { unavailableReason: "This browser computer was retired." } : {}),
      id: group.tabGroupId,
      revision: group.revision,
      createdAt: group.lineageCreatedAt.toISOString(),
      session: {
        id: group.id,
        access: "full-control",
        createdAt: group.createdAt.toISOString(),
        updatedAt: group.updatedAt.toISOString(),
        origin: group.origin,
        profileId: group.profileId,
        runtimeId: group.runtimeId,
        state: group.state,
        workspaceId: group.workspaceId,
        placement: { kind: "runner", runnerId: group.runnerId },
        opener: projectBrowserSessionOpener(group.opener, {
          userId: ownerId,
          visibleThreadIds,
        }),
      },
      tabs: rows
        .filter((row) => row.groupId === group.tabGroupId)
        .map((row) => ({
          kind: "browser",
          id: BrowserSurfaceIdSchema.parse(row.id),
          sessionId: row.sessionId,
          title: row.title,
          site: browserPageSite(row.url).slice(0, 2048),
          iconRef: row.iconRef,
          order: row.order,
          openerId: row.openerId ? BrowserSurfaceIdSchema.parse(row.openerId) : null,
          state: row.state,
          createdAt: row.createdAt.toISOString(),
        })),
    }));
  }
  list(ownerId: UserId): Promise<WorkspaceTabLineage[]> {
    return this.#read(ownerId);
  }
  async read(
    ownerId: UserId,
    groupId: BrowserSessionId,
    database?: Database,
  ): Promise<WorkspaceTabLineage | null> {
    return (await this.#read(ownerId, groupId, database))[0] ?? null;
  }
  async get(ownerId: UserId, id: string) {
    const row = await this.database
      .selectFrom("workspaceTabs")
      .selectAll()
      .where("id", "=", id)
      .where("closedAt", "is", null)
      .executeTakeFirst();
    return row && (await this.session(ownerId, row.groupId)) ? row : null;
  }
  async icon(
    ownerId: UserId,
    sessionId: BrowserSessionId,
    iconRef: string,
  ): Promise<string | null> {
    const groupId = await this.lineageForSession(sessionId);
    if (!groupId || (await this.session(ownerId, groupId))?.id !== sessionId) return null;
    const row = await this.database
      .selectFrom("workspaceTabs")
      .select("favicon")
      .where("groupId", "=", groupId)
      .where("sessionId", "=", sessionId)
      .where("iconRef", "=", iconRef)
      .where("closedAt", "is", null)
      .executeTakeFirst();
    return row?.favicon ? BrowserFaviconSchema.parse(row.favicon) : null;
  }
  async #turn<T>(
    groupId: BrowserSessionId,
    operation: (tx: Transaction<DatabaseSchema>) => Promise<T>,
  ): Promise<T> {
    return withDatabaseTransaction(this.database, async (tx) => {
      await this.#lockLineage(tx, groupId);
      return operation(tx);
    });
  }
  async #lockLineage(tx: Transaction<DatabaseSchema>, groupId: BrowserSessionId) {
    await tx
      .selectFrom("browserSessions")
      .select("id")
      .where("id", "=", groupId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    await tx
      .selectFrom("workspaceTabs")
      .select("id")
      .where("groupId", "=", groupId)
      .orderBy("id")
      .forNoKeyUpdate()
      .execute();
  }
  async #lockLayout(tx: Transaction<DatabaseSchema>, ownerId: UserId) {
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
  }
  async #bump(tx: Transaction<DatabaseSchema>, groupId: BrowserSessionId) {
    await tx
      .updateTable("browserSessions")
      .set((eb) => ({ tabRevision: eb("tabRevision", "+", 1) }))
      .where("id", "=", groupId)
      .execute();
  }
  async record(
    sessionId: BrowserSessionId,
    descriptors: readonly WorkspaceTabDescriptor[],
    closed: readonly string[],
  ): Promise<boolean> {
    for (const descriptor of descriptors)
      if (descriptor.favicon !== undefined && descriptor.favicon !== null)
        BrowserFaviconSchema.parse(descriptor.favicon);
    const session = await this.database
      .selectFrom("browserSessions")
      .selectAll()
      .where("id", "=", sessionId)
      .executeTakeFirst();
    if (!session || session.origin === "trigger" || session.opener?.kind === "automation")
      return false;
    return this.#turn(session.tabGroupId, async (tx) => {
      const latest = await tx
        .selectFrom("browserSessions")
        .select("id")
        .where("tabGroupId", "=", session.tabGroupId)
        .orderBy("createdAt", "desc")
        .orderBy("id", "desc")
        .executeTakeFirstOrThrow();
      if (latest.id !== sessionId) return false;
      const previous = await tx
        .selectFrom("workspaceTabs")
        .selectAll()
        .where("groupId", "=", session.tabGroupId)
        .execute();
      let changed = false;
      if (closed.length) {
        const closedAt = new Date();
        const result = await tx
          .updateTable("workspaceTabs")
          .set({ closedAt })
          .where("sessionId", "=", sessionId)
          .where("id", "in", closed)
          .where("closedAt", "is", null)
          .executeTakeFirst();
        changed = result.numUpdatedRows > 0n;
        for (const row of previous)
          if (row.sessionId === sessionId && closed.includes(row.id) && !row.closedAt)
            row.closedAt = closedAt;
      }
      for (const descriptor of descriptors) {
        const held = previous.find((row) => row.id === descriptor.id);
        if (held?.closedAt || (held && held.sessionId !== sessionId)) continue;
        // The old producer may have outlived its closed marker's retention.
        if (!held && (session.state === "closed" || session.state === "failed")) continue;
        const initializing =
          held?.state === "restoring" &&
          descriptor.url === "about:blank" &&
          held.url !== "about:blank";
        const favicon = initializing
          ? held.favicon
          : (descriptor.favicon ?? (held?.url === descriptor.url ? held.favicon : null));
        const values = {
          title: initializing ? held.title : descriptor.title,
          url: initializing ? held.url : descriptor.url,
          favicon,
          iconRef: favicon ? workspaceTabIconRef(session.tabGroupId, favicon) : null,
          order: held?.order ?? Math.max(-1, ...previous.map((row) => row.order)) + 1,
          openerId: held?.openerId ?? descriptor.openerId,
          state: initializing ? ("restoring" as const) : ("live" as const),
        };
        if (held) {
          if (
            held.title === values.title &&
            held.url === values.url &&
            held.state === values.state &&
            held.iconRef === values.iconRef
          )
            continue;
          await tx
            .updateTable("workspaceTabs")
            .set(values)
            .where("id", "=", held.id)
            .where("sessionId", "=", sessionId)
            .where("closedAt", "is", null)
            .execute();
        } else {
          if (previous.filter((row) => !row.closedAt).length >= 64)
            throw new OpensteerError({
              code: "conflict",
              message: "Browser tab limit reached.",
            });
          const inserted = {
            ...values,
            id: descriptor.id,
            groupId: session.tabGroupId,
            sessionId,
            closedAt: null,
            createdAt: new Date(),
          };
          await tx
            .insertInto("workspaceTabs")
            .values(inserted)
            .onConflict((c) => c.column("id").doNothing())
            .execute();
          previous.push({
            ...inserted,
            closedBy: null,
            closedAfterTabId: null,
            closedTabGroupId: null,
            reopenedAt: null,
          });
        }
        changed = true;
      }
      if (changed) await this.#bump(tx, session.tabGroupId);
      return changed;
    });
  }
  async bind(groupId: BrowserSessionId, sessionId: BrowserSessionId, id: string) {
    return this.#turn(groupId, async (tx) => {
      await tx
        .updateTable("workspaceTabs")
        .set({ sessionId, state: "suspended" })
        .where("groupId", "=", groupId)
        .where("closedAt", "is", null)
        .where("sessionId", "!=", sessionId)
        .execute();
      await tx
        .updateTable("workspaceTabs")
        .set({ state: "restoring" })
        .where("id", "=", id)
        .where("sessionId", "=", sessionId)
        .where("closedAt", "is", null)
        .execute();
      await this.#bump(tx, groupId);
    });
  }
  async suspend(sessionId?: BrowserSessionId) {
    const groups = await this.database
      .selectFrom("workspaceTabs")
      .select("groupId")
      .distinct()
      .where("closedAt", "is", null)
      .where("state", "!=", "suspended")
      .$if(sessionId !== undefined, (q) => q.where("sessionId", "=", sessionId!))
      .orderBy("groupId")
      .execute();
    for (const { groupId } of groups)
      await this.#turn(groupId, async (tx) => {
        const result = await tx
          .updateTable("workspaceTabs")
          .set({ state: "suspended" })
          .where("groupId", "=", groupId)
          .where("closedAt", "is", null)
          .where("state", "!=", "suspended")
          .$if(sessionId !== undefined, (q) => q.where("sessionId", "=", sessionId!))
          .executeTakeFirst();
        if (result.numUpdatedRows > 0n) await this.#bump(tx, groupId);
      });
  }
  async close(ownerId: UserId, id: string, person = true) {
    const row = await this.database
      .selectFrom("workspaceTabs")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row || !(await this.session(ownerId, row.groupId))) return null;
    await this.#turn(row.groupId, async (tx) => {
      await this.#lockLayout(tx, ownerId);
      const { arrangement } = await new BrowserTabGroupStore(tx).orderedTabs(ownerId, tx);
      const at = arrangement.order.indexOf(id);
      const result = await tx
        .updateTable("workspaceTabs")
        .set({
          closedAt: new Date(),
          ...(person
            ? {
                closedBy: ownerId,
                closedAfterTabId: at > 0 ? arrangement.order[at - 1]! : null,
                closedTabGroupId: arrangement.groupOf.has(id)
                  ? BrowserTabGroupIdSchema.parse(arrangement.groupOf.get(id))
                  : null,
              }
            : {}),
        })
        .where("id", "=", id)
        .where("closedAt", "is", null)
        .executeTakeFirst();
      if (result.numUpdatedRows > 0n) await this.#bump(tx, row.groupId);
    });
    return row;
  }
  #recentClose(database: Database, ownerId: UserId) {
    return database
      .selectFrom("workspaceTabs")
      .selectAll()
      .where("closedBy", "=", ownerId)
      .where("closedAt", ">=", new Date(Date.now() - browserTabOpenReplayWindowMs))
      .where("reopenedAt", "is", null)
      .orderBy("closedAt", "desc")
      .orderBy("id", "desc")
      .executeTakeFirst();
  }
  async reopen(
    ownerId: UserId,
    authorize: (row: TabRow, database: Database) => Promise<void>,
    idempotencyKey: string = randomUUID(),
  ): Promise<TabRow> {
    return withDatabaseTransaction(
      this.database,
      async (tx) => {
        await sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-tab-reopen:${ownerId}`}, 0))`.execute(
          tx,
        );
        const id = BrowserSurfaceIdSchema.parse(
          `surface_${createHash("sha256")
            .update(JSON.stringify(["workspace-tab-reopen-v1", ownerId, idempotencyKey]))
            .digest("hex")}`,
        );
        const replay = await tx
          .selectFrom("workspaceTabs")
          .selectAll()
          .where("id", "=", id)
          .executeTakeFirst();
        if (replay) {
          await authorize(replay, tx);
          return replay;
        }
        const source = await this.#recentClose(tx, ownerId);
        if (!source)
          throw new OpensteerError({
            code: "not_found",
            message: "No recently closed tab to reopen.",
          });
        await this.#lockLineage(tx, source.groupId);
        await this.#lockLayout(tx, ownerId);
        if ((await this.#recentClose(tx, ownerId))?.id !== source.id)
          throw new TransactionScopeChanged();
        await authorize(source, tx);
        const session = await this.session(ownerId, source.groupId, tx);
        if (!session)
          throw new OpensteerError({ code: "not_found", message: "Browser tabs not found." });
        const open = await tx
          .selectFrom("workspaceTabs")
          .select("id")
          .where("groupId", "=", source.groupId)
          .where("closedAt", "is", null)
          .execute();
        if (open.length >= 64)
          throw new OpensteerError({ code: "conflict", message: "Browser tab limit reached." });
        const groups = new BrowserTabGroupStore(tx);
        const { arrangement } = await groups.orderedTabs(ownerId, tx);
        if (arrangement.order.length >= browserTabOrderMaxTabs)
          throw new OpensteerError({
            code: "conflict",
            message:
              "Close some tabs to keep organizing; Opensteer keeps the order of up to 10,000 tabs.",
          });
        let preceding = source.closedAfterTabId;
        const visited = new Set<string>();
        while (preceding && !arrangement.order.includes(preceding) && !visited.has(preceding)) {
          visited.add(preceding);
          preceding =
            (
              await tx
                .selectFrom("workspaceTabs")
                .select("closedAfterTabId")
                .where("id", "=", preceding)
                .where("closedBy", "=", ownerId)
                .executeTakeFirst()
            )?.closedAfterTabId ?? null;
        }
        const group = source.closedTabGroupId
          ? await tx
              .selectFrom("browserTabGroups")
              .select("id")
              .where("ownerId", "=", ownerId)
              .where("id", "=", source.closedTabGroupId)
              .executeTakeFirst()
          : undefined;
        if (group) {
          const members = await tx
            .selectFrom("browserTabGroupMembers")
            .innerJoin("workspaceTabs", "workspaceTabs.id", "browserTabGroupMembers.tabId")
            .select("browserTabGroupMembers.tabId")
            .where("browserTabGroupMembers.groupId", "=", group.id)
            .where("workspaceTabs.closedAt", "is", null)
            .execute();
          if (members.length >= browserTabGroupMaxTabs)
            throw new OpensteerError({
              code: "conflict",
              message: "A tab group can keep at most 500 tabs.",
            });
        }
        const row = await tx
          .insertInto("workspaceTabs")
          .values({
            id,
            groupId: source.groupId,
            sessionId: session.id,
            title: source.title,
            url: source.url,
            favicon: source.favicon,
            iconRef: source.iconRef,
            order: source.order,
            openerId: source.openerId,
            state: "suspended",
            closedAt: null,
            createdAt: new Date(),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        const normal = (await groups.orderedTabs(ownerId, tx)).arrangement.order;
        const order = normal.filter((tabId) => tabId !== id);
        let at = preceding ? order.indexOf(preceding) + 1 : -1;
        if (group) {
          const members = order.filter((tabId) => arrangement.groupOf.get(tabId) === group.id);
          if (!preceding || arrangement.groupOf.get(preceding) !== group.id)
            at = members.length ? order.indexOf(members.at(-1)!) + 1 : at;
          await tx
            .insertInto("browserTabGroupMembers")
            .values({ ownerId, tabId: id, groupId: group.id })
            .execute();
        } else if (preceding) {
          const precedingGroup = arrangement.groupOf.get(preceding);
          while (
            precedingGroup &&
            at < order.length &&
            arrangement.groupOf.get(order[at]!) === precedingGroup
          )
            at++;
        }
        if (at < 0 || (preceding && !order.includes(preceding) && !group)) at = normal.indexOf(id);
        order.splice(at, 0, id);
        await tx
          .updateTable("browserTabLayouts")
          .set((eb) => ({
            tabOrder: sql`${JSON.stringify(order)}::jsonb`,
            revision: eb("revision", "+", 1),
          }))
          .where("ownerId", "=", ownerId)
          .execute();
        await tx
          .updateTable("workspaceTabs")
          .set({ reopenedAt: new Date() })
          .where("id", "=", source.id)
          .execute();
        await this.#bump(tx, source.groupId);
        return row;
      },
      undefined,
      (error) => error instanceof TransactionScopeChanged,
    );
  }
  async closeLineage(sessionId: BrowserSessionId) {
    const groupId = await this.lineageForSession(sessionId);
    if (!groupId) return;
    await this.#turn(groupId, async (tx) => {
      const latest = await tx
        .selectFrom("browserSessions")
        .select("id")
        .where("tabGroupId", "=", groupId)
        .orderBy("createdAt", "desc")
        .orderBy("id", "desc")
        .executeTakeFirstOrThrow();
      if (latest.id !== sessionId) return;
      await tx
        .updateTable("workspaceTabs")
        .set({ closedAt: new Date() })
        .where("groupId", "=", groupId)
        .where("closedAt", "is", null)
        .execute();
      await this.#bump(tx, groupId);
    });
  }
  async prune() {
    await withDatabaseTransaction(this.database, async (tx) => {
      const rows = await tx
        .selectFrom("workspaceTabs")
        .select("id")
        .where("closedAt", "<", new Date(Date.now() - browserTabOpenReplayWindowMs))
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom("browserSessions")
              .select("id")
              .whereRef("browserSessions.id", "=", "workspaceTabs.sessionId")
              .where("state", "in", ["closed", "failed"]),
          ),
        )
        .orderBy("id")
        // FOR UPDATE: Expired closed tabs and their personal group memberships are deleted.
        .forUpdate()
        .execute();
      if (rows.length) {
        const tabIds = rows.map((row) => row.id);
        await lockBrowserTabGroupMembersForTabs(tx, tabIds);
        await tx.deleteFrom("workspaceTabs").where("id", "in", tabIds).execute();
      }
    });
  }
}
