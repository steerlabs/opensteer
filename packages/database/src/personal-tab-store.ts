import { retryDatabaseTransaction } from "./connection.js";
import { withPersonalTransaction } from "./personal-transaction.js";
import { OpensteerError, browserTabOrderMaxTabs, type UserId } from "@opensteer/core";
import {
  BrowserFaviconSchema,
  BrowserSurfaceIdSchema,
  BrowserTabGroupIdSchema,
  browserPageSite,
  browserTabGroupMaxTabs,
  browserTabOpenReplayWindowMs,
  projectBrowserSessionOpener,
  type BrowserSessionId,
  type BrowserTabRecord,
  type BrowserGroupRow,
  type HostedBrowserSession,
} from "@opensteer/protocol";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import { createHash, randomUUID } from "node:crypto";
import {
  authorizedPlaceThreadIds,
  getBrowserSessionForOwner,
  listBrowserSessionThreads,
  listAttachedRunIdsForBrowserSessions,
} from "./browser-session-store.js";
import { lockBrowserTabGroupMembersForTabs } from "./browser-tab-group-locks.js";
import { BrowserTabGroupStore } from "./browser-tab-group-store.js";
import { TransactionScopeChanged } from "./connection.js";
import { databaseOperationOptions } from "./operation-budget.js";
import type { DatabaseSchema } from "./schema.js";
import { visiblePersonalTabLineages } from "./personal-tab-visibility.js";

type Database = Kysely<DatabaseSchema>;
type TabRow = Selectable<DatabaseSchema["personalTabs"]>;

export type BrowserGroupFacts = Omit<
  BrowserGroupRow,
  "inventoryRevision" | "navigation" | "acting" | "page"
>;
export interface PersonalTabLineage {
  id: BrowserSessionId;
  revision: number;
  createdAt: string;
  unavailableReason?: string;
  session: HostedBrowserSession;
  tabs?: Array<{
    kind: "browser";
    id: BrowserTabRecord["id"];
    sessionId: BrowserSessionId;
    title: string;
    site: string;
    iconRef?: string | null;
    order: number;
    openerId: BrowserTabRecord["openerId"];
    state: "suspended" | "restoring" | "live";
    createdAt?: string;
  }>;
}

export type PersonalTabStreamRow = NonNullable<PersonalTabLineage["tabs"]>[number] & {
  groupId: BrowserSessionId;
};
export interface PersonalTabChanges {
  groupId: BrowserSessionId;
  changed: boolean;
  rows: PersonalTabStreamRow[];
  closedIds: string[];
}
function streamTab(
  row: Pick<
    TabRow,
    | "id"
    | "groupId"
    | "sessionId"
    | "title"
    | "url"
    | "iconRef"
    | "order"
    | "openerId"
    | "state"
    | "createdAt"
  >,
): PersonalTabStreamRow {
  return {
    kind: "browser",
    id: BrowserSurfaceIdSchema.parse(row.id),
    groupId: row.groupId,
    sessionId: row.sessionId,
    title: row.title,
    site: browserPageSite(row.url).slice(0, 2048),
    iconRef: row.iconRef,
    order: row.order,
    openerId: row.openerId ? BrowserSurfaceIdSchema.parse(row.openerId) : null,
    state: row.state,
    createdAt: row.createdAt.toISOString(),
  };
}

export function personalTabIconRef(groupId: BrowserSessionId, favicon: string): string {
  return createHash("sha256").update(groupId).update("\0").update(favicon).digest("base64url");
}

export type PersonalTabDescriptor = Pick<
  BrowserTabRecord,
  "id" | "title" | "url" | "order" | "openerId"
> & {
  readonly favicon?: string | null;
};

/** Session history is the authority; tabs hold only descriptors and a fenced binding. */
export class PersonalTabStore {
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
      .executeTakeFirst(databaseOperationOptions());
  }
  async session(ownerId: UserId, groupId: BrowserSessionId, database = this.database) {
    const latest = await this.#latest(groupId, database);
    if (!latest) return null;
    return getBrowserSessionForOwner(database, latest.id, ownerId);
  }
  async lineageForSession(sessionId: BrowserSessionId) {
    return (
      (
        await this.database
          .selectFrom("browserSessions")
          .select("tabGroupId")
          .where("id", "=", sessionId)
          .executeTakeFirst(databaseOperationOptions())
      )?.tabGroupId ?? null
    );
  }
  async #read(
    ownerId: UserId,
    groupId?: BrowserSessionId,
    database?: Database,
  ): Promise<PersonalTabLineage[]> {
    if (!database)
      return this.database
        .transaction()
        .setIsolationLevel("repeatable read")
        .execute((tx) => this.#read(ownerId, groupId, tx));
    let query = visiblePersonalTabLineages(database, ownerId);
    if (groupId) query = query.where("lineages.id", "=", groupId);
    else {
      query = query.where((eb) =>
        eb.exists(
          eb
            .selectFrom("personalTabs")
            .select("id")
            .whereRef("personalTabs.groupId", "=", "browserSessions.tabGroupId")
            .where("closedAt", "is", null),
        ),
      );
      query = query.orderBy(
        (eb) =>
          eb.exists(
            eb
              .selectFrom("browserTabGroupMembers")
              .innerJoin("personalTabs", "personalTabs.id", "browserTabGroupMembers.tabId")
              .select("browserTabGroupMembers.tabId")
              .where("browserTabGroupMembers.ownerId", "=", ownerId)
              .whereRef("personalTabs.groupId", "=", "browserSessions.tabGroupId")
              .where("personalTabs.closedAt", "is", null),
          ),
        "desc",
      );
    }
    const groups = await query
      .orderBy("lineages.createdAt", "desc")
      .orderBy("lineages.id", "desc")
      .execute(databaseOperationOptions());
    if (!groups.length) return [];
    const rows = await database
      .selectFrom("personalTabs")
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
      .execute(databaseOperationOptions());
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
        access: "read-write",
        createdAt: group.createdAt.toISOString(),
        updatedAt: group.updatedAt.toISOString(),
        origin: group.origin,
        profileId: group.profileId,
        runtimeId: group.runtimeId,
        state: group.state,
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
  list(ownerId: UserId): Promise<PersonalTabLineage[]> {
    return this.#read(ownerId);
  }
  read(
    ownerId: UserId,
    groupIds: readonly BrowserSessionId[],
    database?: Database,
  ): Promise<BrowserGroupFacts[]>;
  read(
    ownerId: UserId,
    groupId: BrowserSessionId,
    database?: Database,
  ): Promise<PersonalTabLineage | null>;
  async read(
    ownerId: UserId,
    groupIds: BrowserSessionId | readonly BrowserSessionId[],
    database?: Database,
  ): Promise<PersonalTabLineage | null | BrowserGroupFacts[]> {
    if (typeof groupIds === "string")
      return (await this.#read(ownerId, groupIds, database))[0] ?? null;
    if (!groupIds.length) return [];
    const read = async (tx: Database) => {
      const groups = await visiblePersonalTabLineages(tx, ownerId)
        .where("lineages.id", "in", groupIds)
        .select((eb) =>
          eb
            .selectFrom("personalTabs")
            .select((eb) => eb.fn.countAll<string>().as("count"))
            .whereRef("personalTabs.groupId", "=", "lineages.id")
            .where("closedAt", "is", null)
            .as("tabCount"),
        )
        .execute(databaseOperationOptions());
      const sessionIds = groups.map((group) => group.id);
      const [threads, runs, visible] = await Promise.all([
        listBrowserSessionThreads(tx, { ownerId, sessionIds }),
        listAttachedRunIdsForBrowserSessions(tx, sessionIds),
        authorizedPlaceThreadIds(
          tx,
          ownerId,
          groups.flatMap((group) =>
            group.opener && "threadId" in group.opener ? [group.opener.threadId] : [],
          ),
        ),
      ]);
      const visibleThreadIds = new Set(visible);
      return groups.map((group) => ({
        id: group.tabGroupId,
        createdAt: group.lineageCreatedAt.toISOString(),
        unavailableReason: group.retiredAt ? "This browser computer was retired." : null,
        tabCount: Number(group.tabCount),
        sessionId: group.id,
        state: group.state,
        origin: group.origin,
        access: "read-write" as const,
        placement: { kind: "runner" as const, runnerId: group.runnerId },
        profileId: group.profileId,
        runtimeId: group.runtimeId,
        opener: projectBrowserSessionOpener(group.opener, { userId: ownerId, visibleThreadIds }),
        sessionCreatedAt: group.createdAt.toISOString(),
        updatedAt: group.updatedAt.toISOString(),
        attachedRunIds: [...(runs.get(group.id) ?? [])],
        threadIds: [...(threads.get(group.id) ?? [])],
      }));
    };
    return database
      ? read(database)
      : this.database.transaction().setIsolationLevel("repeatable read").execute(read);
  }
  async groupIds(ownerId: UserId): Promise<BrowserSessionId[]> {
    const rows = await visiblePersonalTabLineages(this.database, ownerId)
      .clearSelect()
      .select("lineages.id")
      .where((eb) =>
        eb.or([
          eb("browserSessions.state", "in", ["starting", "ready", "closing"]),
          eb.exists(
            eb
              .selectFrom("personalTabs")
              .select("id")
              .whereRef("personalTabs.groupId", "=", "lineages.id")
              .where("closedAt", "is", null),
          ),
        ]),
      )
      .orderBy("browserSessions.updatedAt", "desc")
      .orderBy("lineages.id", "desc")
      .execute(databaseOperationOptions());
    return rows.map((row) => row.id);
  }
  async openTabs(groupIds: readonly BrowserSessionId[]): Promise<PersonalTabStreamRow[]> {
    if (!groupIds.length) return [];
    const rows = await this.database
      .selectFrom("personalTabs")
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
      .where("groupId", "in", groupIds)
      .where("closedAt", "is", null)
      .orderBy("order")
      .execute(databaseOperationOptions());
    return rows.map(streamTab);
  }
  async get(ownerId: UserId, id: string) {
    const row = await this.database
      .selectFrom("personalTabs")
      .selectAll()
      .where("id", "=", id)
      .where("closedAt", "is", null)
      .executeTakeFirst(databaseOperationOptions());
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
      .selectFrom("personalTabs")
      .select("favicon")
      .where("groupId", "=", groupId)
      .where("sessionId", "=", sessionId)
      .where("iconRef", "=", iconRef)
      .where("closedAt", "is", null)
      .executeTakeFirst(databaseOperationOptions());
    return row?.favicon ? BrowserFaviconSchema.parse(row.favicon) : null;
  }
  async #turn<T>(
    groupId: BrowserSessionId,
    operation: (tx: Transaction<DatabaseSchema>) => Promise<T>,
  ): Promise<T> {
    return withPersonalTransaction(this.database, async (tx) => {
      await this.#lockLineage(tx, groupId);
      return operation(tx);
    });
  }
  async #lockLineage(
    tx: Transaction<DatabaseSchema>,
    groupId: BrowserSessionId,
    tabIds?: readonly string[],
  ) {
    await tx
      .selectFrom("browserSessions")
      .select("id")
      .where("id", "=", groupId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow(databaseOperationOptions());
    if (tabIds?.length === 0) return;
    let rows = tx.selectFrom("personalTabs").select("id").where("groupId", "=", groupId);
    if (tabIds) rows = rows.where("id", "in", tabIds);
    await rows.orderBy("id").forNoKeyUpdate().execute(databaseOperationOptions());
  }
  async #lockLayout(tx: Transaction<DatabaseSchema>, ownerId: UserId) {
    await tx
      .insertInto("browserTabLayouts")
      .values({ ownerId })
      .onConflict((c) => c.column("ownerId").doNothing())
      .execute(databaseOperationOptions());
    await tx
      .selectFrom("browserTabLayouts")
      .select("ownerId")
      .where("ownerId", "=", ownerId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow(databaseOperationOptions());
  }
  async #bump(tx: Transaction<DatabaseSchema>, groupId: BrowserSessionId) {
    await tx
      .updateTable("browserSessions")
      .set((eb) => ({ tabRevision: eb("tabRevision", "+", 1) }))
      .where("id", "=", groupId)
      .execute(databaseOperationOptions());
  }
  async recordChanges(
    sessionId: BrowserSessionId,
    descriptors: readonly PersonalTabDescriptor[],
    closed: readonly string[],
  ): Promise<PersonalTabChanges> {
    for (const descriptor of descriptors)
      if (descriptor.favicon !== undefined && descriptor.favicon !== null)
        BrowserFaviconSchema.parse(descriptor.favicon);
    const session = await this.database
      .selectFrom("browserSessions")
      .selectAll()
      .where("id", "=", sessionId)
      .executeTakeFirst(databaseOperationOptions());
    const changes: PersonalTabChanges = {
      groupId: session?.tabGroupId ?? sessionId,
      changed: false,
      rows: [],
      closedIds: [],
    };
    if (!session || session.origin === "trigger" || session.opener?.kind === "automation")
      return changes;
    return withPersonalTransaction(this.database, async (tx) => {
      await this.#lockLineage(tx, session.tabGroupId, [
        ...new Set([...descriptors.map((row) => row.id), ...closed]),
      ]);
      const changes: PersonalTabChanges = {
        groupId: session.tabGroupId,
        changed: false,
        rows: [],
        closedIds: [],
      };
      const latest = await tx
        .selectFrom("browserSessions")
        .select("id")
        .where("tabGroupId", "=", session.tabGroupId)
        .orderBy("createdAt", "desc")
        .orderBy("id", "desc")
        .executeTakeFirstOrThrow(databaseOperationOptions());
      if (latest.id !== sessionId) return changes;
      const previous = descriptors.length
        ? await tx
            .selectFrom("personalTabs")
            .selectAll()
            .where(
              "id",
              "in",
              descriptors.map((row) => row.id),
            )
            .execute(databaseOperationOptions())
        : [];
      let nextOrder: number | undefined;
      if (descriptors.some((row) => !previous.some((held) => held.id === row.id))) {
        const bounds = await tx
          .selectFrom("personalTabs")
          .select((eb) => eb.fn.max("order").as("maxOrder"))
          .where("groupId", "=", session.tabGroupId)
          .executeTakeFirstOrThrow(databaseOperationOptions());
        nextOrder = (bounds.maxOrder ?? -1) + 1;
      }
      const written: TabRow[] = [];
      if (closed.length) {
        const closedAt = new Date();
        const result = await tx
          .updateTable("personalTabs")
          .set({ closedAt })
          .where("sessionId", "=", sessionId)
          .where("id", "in", closed)
          .where("closedAt", "is", null)
          .returning("id")
          .execute(databaseOperationOptions());
        changes.closedIds = result.map((row) => row.id);
        for (const row of previous)
          if (row.sessionId === sessionId && closed.includes(row.id) && !row.closedAt)
            row.closedAt = closedAt;
      }
      for (const descriptor of descriptors) {
        const held = previous.find((row) => row.id === descriptor.id);
        if (
          held?.closedAt ||
          (held && (held.sessionId !== sessionId || held.groupId !== session.tabGroupId))
        )
          continue;
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
          iconRef: favicon ? personalTabIconRef(session.tabGroupId, favicon) : null,
          order: held?.order ?? nextOrder!,
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
          const updated = await tx
            .updateTable("personalTabs")
            .set(values)
            .where("id", "=", held.id)
            .where("sessionId", "=", sessionId)
            .where("closedAt", "is", null)
            .returningAll()
            .executeTakeFirst(databaseOperationOptions());
          if (updated) written.push(updated);
        } else {
          const inserted = {
            ...values,
            id: descriptor.id,
            groupId: session.tabGroupId,
            sessionId,
            closedAt: null,
            createdAt: new Date(),
          };
          const row = await tx
            .insertInto("personalTabs")
            .values(inserted)
            .onConflict((c) => c.column("id").doNothing())
            .returningAll()
            .executeTakeFirst(databaseOperationOptions());
          if (!row) continue;
          written.push(row);
          nextOrder!++;
          previous.push({
            ...inserted,
            closedBy: null,
            closedAfterTabId: null,
            closedTabGroupId: null,
            reopenedAt: null,
          });
        }
      }
      changes.rows = written.map(streamTab);
      changes.changed = written.length > 0 || changes.closedIds.length > 0;
      if (changes.changed) await this.#bump(tx, session.tabGroupId);
      return changes;
    });
  }

  async bind(groupId: BrowserSessionId, sessionId: BrowserSessionId, id: string) {
    return this.#turn(groupId, async (tx) => {
      await tx
        .updateTable("personalTabs")
        .set({ sessionId, state: "suspended" })
        .where("groupId", "=", groupId)
        .where("closedAt", "is", null)
        .where("sessionId", "!=", sessionId)
        .execute(databaseOperationOptions());
      await tx
        .updateTable("personalTabs")
        .set({ state: "restoring" })
        .where("id", "=", id)
        .where("sessionId", "=", sessionId)
        .where("closedAt", "is", null)
        .execute(databaseOperationOptions());
      await this.#bump(tx, groupId);
    });
  }
  async suspend(sessionId?: BrowserSessionId) {
    // Host shutdown suspends every group, inside its close budget: one transaction, not one per group.
    await withPersonalTransaction(this.database, async (tx) => {
      const groups = (
        await tx
          .selectFrom("personalTabs")
          .select("groupId")
          .distinct()
          .where("closedAt", "is", null)
          .where("state", "!=", "suspended")
          .$if(sessionId !== undefined, (q) => q.where("sessionId", "=", sessionId!))
          .execute(databaseOperationOptions())
      ).map(({ groupId }) => groupId);
      if (!groups.length) return;
      await tx
        .selectFrom("browserSessions")
        .select("id")
        .where("id", "in", groups)
        .orderBy("id")
        .forNoKeyUpdate()
        .execute(databaseOperationOptions());
      await tx
        .selectFrom("personalTabs")
        .select("id")
        .where("groupId", "in", groups)
        .orderBy("id")
        .forNoKeyUpdate()
        .execute(databaseOperationOptions());
      const changed = await tx
        .updateTable("personalTabs")
        .set({ state: "suspended" })
        .where("groupId", "in", groups)
        .where("closedAt", "is", null)
        .where("state", "!=", "suspended")
        .$if(sessionId !== undefined, (q) => q.where("sessionId", "=", sessionId!))
        .returning("groupId")
        .execute(databaseOperationOptions());
      if (!changed.length) return;
      await tx
        .updateTable("browserSessions")
        .set((eb) => ({ tabRevision: eb("tabRevision", "+", 1) }))
        .where("id", "in", [...new Set(changed.map(({ groupId }) => groupId))])
        .execute(databaseOperationOptions());
    });
  }
  async close(
    ownerId: UserId,
    id: string,
    person = true,
    authorize?: (database: Database) => Promise<void>,
  ) {
    const row = await this.database
      .selectFrom("personalTabs")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst(databaseOperationOptions());
    if (!row || !(await this.session(ownerId, row.groupId))) return null;
    await this.#turn(row.groupId, async (tx) => {
      await this.#lockLayout(tx, ownerId);
      const { arrangement } = await new BrowserTabGroupStore(tx).orderedTabs(ownerId, tx);
      const at = arrangement.order.indexOf(id);
      await authorize?.(tx);
      const result = await tx
        .updateTable("personalTabs")
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
        .executeTakeFirst(databaseOperationOptions());
      if (result.numUpdatedRows > 0n) await this.#bump(tx, row.groupId);
    });
    return row;
  }
  #recentClose(database: Database, ownerId: UserId) {
    return database
      .selectFrom("personalTabs")
      .selectAll()
      .where("closedBy", "=", ownerId)
      .where("closedAt", ">=", new Date(Date.now() - browserTabOpenReplayWindowMs))
      .where("reopenedAt", "is", null)
      .orderBy("closedAt", "desc")
      .orderBy("id", "desc")
      .executeTakeFirst(databaseOperationOptions());
  }
  async reopen(
    ownerId: UserId,
    authorize: (row: TabRow, database: Database) => Promise<void>,
    idempotencyKey: string = randomUUID(),
  ): Promise<TabRow> {
    return retryDatabaseTransaction(
      () =>
        withPersonalTransaction(this.database, async (tx) => {
          await sql`select pg_advisory_xact_lock(hashtextextended(${`personal-tab-reopen:${ownerId}`}, 0))`.execute(
            tx,
            databaseOperationOptions(),
          );
          const id = BrowserSurfaceIdSchema.parse(
            `surface_${createHash("sha256")
              .update(JSON.stringify(["personal-tab-reopen-v1", ownerId, idempotencyKey]))
              .digest("hex")}`,
          );
          const replay = await tx
            .selectFrom("personalTabs")
            .selectAll()
            .where("id", "=", id)
            .executeTakeFirst(databaseOperationOptions());
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
                  .selectFrom("personalTabs")
                  .select("closedAfterTabId")
                  .where("id", "=", preceding)
                  .where("closedBy", "=", ownerId)
                  .executeTakeFirst(databaseOperationOptions())
              )?.closedAfterTabId ?? null;
          }
          const group = source.closedTabGroupId
            ? await tx
                .selectFrom("browserTabGroups")
                .select("id")
                .where("ownerId", "=", ownerId)
                .where("id", "=", source.closedTabGroupId)
                .executeTakeFirst(databaseOperationOptions())
            : undefined;
          if (group) {
            const members = await tx
              .selectFrom("browserTabGroupMembers")
              .innerJoin("personalTabs", "personalTabs.id", "browserTabGroupMembers.tabId")
              .select("browserTabGroupMembers.tabId")
              .where("browserTabGroupMembers.groupId", "=", group.id)
              .where("personalTabs.closedAt", "is", null)
              .execute(databaseOperationOptions());
            if (members.length >= browserTabGroupMaxTabs)
              throw new OpensteerError({
                code: "conflict",
                message: "A tab group can keep at most 500 tabs.",
              });
          }
          const row = await tx
            .insertInto("personalTabs")
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
            .executeTakeFirstOrThrow(databaseOperationOptions());
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
              .execute(databaseOperationOptions());
          } else if (preceding) {
            const precedingGroup = arrangement.groupOf.get(preceding);
            while (
              precedingGroup &&
              at < order.length &&
              arrangement.groupOf.get(order[at]!) === precedingGroup
            )
              at++;
          }
          if (at < 0 || (preceding && !order.includes(preceding) && !group))
            at = normal.indexOf(id);
          order.splice(at, 0, id);
          await tx
            .updateTable("browserTabLayouts")
            .set((eb) => ({
              tabOrder: sql`${JSON.stringify(order)}::jsonb`,
              revision: eb("revision", "+", 1),
            }))
            .where("ownerId", "=", ownerId)
            .execute(databaseOperationOptions());
          await tx
            .updateTable("personalTabs")
            .set({ reopenedAt: new Date() })
            .where("id", "=", source.id)
            .execute(databaseOperationOptions());
          await this.#bump(tx, source.groupId);
          return row;
        }),
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
        .executeTakeFirstOrThrow(databaseOperationOptions());
      if (latest.id !== sessionId) return;
      await tx
        .updateTable("personalTabs")
        .set({ closedAt: new Date() })
        .where("groupId", "=", groupId)
        .where("closedAt", "is", null)
        .execute(databaseOperationOptions());
      await this.#bump(tx, groupId);
    });
  }
  async prune() {
    await withPersonalTransaction(this.database, async (tx) => {
      const rows = await tx
        .selectFrom("personalTabs")
        .select("id")
        .where("closedAt", "<", new Date(Date.now() - browserTabOpenReplayWindowMs))
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom("browserSessions")
              .select("id")
              .whereRef("browserSessions.id", "=", "personalTabs.sessionId")
              .where("state", "in", ["closed", "failed"]),
          ),
        )
        .orderBy("id")
        // FOR UPDATE: Expired closed tabs and their personal group memberships are deleted.
        .forUpdate()
        .execute(databaseOperationOptions());
      if (rows.length) {
        const tabIds = rows.map((row) => row.id);
        await lockBrowserTabGroupMembersForTabs(tx, tabIds);
        await tx
          .deleteFrom("personalTabs")
          .where("id", "in", tabIds)
          .execute(databaseOperationOptions());
      }
    });
  }
}
