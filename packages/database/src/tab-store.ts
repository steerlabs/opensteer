import { outsideName } from "@opensteer/shared/outsideName";
import {
  ClosedPositionSchema,
  ComputerAppIdentitySchema,
  OpensteerError,
  PageBindingSchema,
  TabGroupSchema,
  TabIdSchema,
  TabLayoutSchema,
  TabOpenedBySchema,
  createId,
  tabGroupsMaxPerOwner,
  tabsMaxPerMutation,
  tabsMaxPerOwner,
  type AppId,
  type BrowserSessionId,
  type ClosedPosition,
  type PageBinding,
  type TabGroupId,
  type TabId,
  type TabLayout,
  type TabOpenedBy,
  type ComputerAppIdentity,
  type UserId,
} from "@opensteer/core";
import { BrowserFaviconSchema } from "@opensteer/protocol";
import type { TabGroupUpdateInput, TabOrganizeInput } from "@opensteer/protocol";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import { createHash, randomUUID } from "node:crypto";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import { z } from "zod";
import type { DatabaseSchema } from "./schema.js";
import { withPersonalReadTransaction } from "./personal-transaction.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import { databaseOperationOptions } from "./operation-budget.js";

export type TabRecord = Selectable<DatabaseSchema["personalTabs"]>;
export type TabDatabase = Kysely<DatabaseSchema>;
export type TabTransaction = Transaction<DatabaseSchema>;
export type TabWrite = Pick<
  TabRecord,
  "id" | "ownerId" | "kind" | "computerId" | "title" | "openedBy"
> &
  Partial<
    Pick<
      TabRecord,
      | "url"
      | "profileId"
      | "profileName"
      | "appId"
      | "windowId"
      | "windowApp"
      | "pageBinding"
      | "favicon"
      | "openerTabId"
    >
  >;
export type TabAuthorization = (
  tx: TabTransaction,
  rows: readonly TabRecord[],
  layout: TabLayout,
  replayedTabIds?: readonly TabId[],
) => Promise<void>;
export interface TabMutation {
  tabIds: TabId[];
  layout: TabLayout;
  replayed?: boolean;
  currentLayout?: TabLayout;
}
const mutationMeta = new WeakMap<
  TabMutation,
  { readonly replayed: boolean; readonly currentLayout: TabLayout }
>();
/** Replay metadata kept out of enumerable receipt fields so concurrent replays remain deep-equal. */
export function tabMutationMeta(mutation: TabMutation): {
  readonly replayed: boolean;
  readonly currentLayout?: TabLayout;
} {
  return (
    mutationMeta.get(mutation) ?? {
      replayed: mutation.replayed === true,
      ...(mutation.currentLayout ? { currentLayout: mutation.currentLayout } : {}),
    }
  );
}
const resultSchema = z.object({ tabIds: z.array(TabIdSchema), layout: TabLayoutSchema });
const replaySchema = z.object({ request: z.string(), result: resultSchema });
const restoreUrl = z
  .string()
  .min(1)
  .max(16384)
  .refine((value) => {
    if (value === "about:blank") return true;
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
    } catch {
      return false;
    }
  });
function failure(code: "not_found" | "conflict" | "bad_request", message: string): never {
  throw new OpensteerError({ code, message });
}
export function tabLayoutIds(layout: TabLayout): TabId[] {
  return layout.items.flatMap((item) => (item.kind === "tab" ? [item.tabId] : item.group.tabIds));
}
export function tabGroupOf(layout: TabLayout, tabId: TabId): TabGroupId | null {
  for (const item of layout.items)
    if (item.kind === "group" && item.group.tabIds.includes(tabId)) return item.group.groupId;
  return null;
}
function removeIds(layout: TabLayout, ids: ReadonlySet<TabId>): void {
  layout.items = layout.items.flatMap<TabLayout["items"][number]>((item) =>
    item.kind === "tab"
      ? ids.has(item.tabId)
        ? []
        : [item]
      : [
          {
            kind: "group" as const,
            group: { ...item.group, tabIds: item.group.tabIds.filter((id) => !ids.has(id)) },
          },
        ],
  );
}
function position(layout: TabLayout, id: TabId): ClosedPosition {
  const groupId = tabGroupOf(layout, id);
  const ids =
    groupId === null
      ? layout.items.flatMap((item) => (item.kind === "tab" ? [item.tabId] : []))
      : layout.items.flatMap((item) =>
          item.kind === "group" && item.group.groupId === groupId ? item.group.tabIds : [],
        );
  return { groupId, beforeTabId: ids[ids.indexOf(id) + 1] ?? null };
}
function insert(layout: TabLayout, id: TabId, destination?: ClosedPosition | null): void {
  const group = destination?.groupId
    ? layout.items.find(
        (item) => item.kind === "group" && item.group.groupId === destination.groupId,
      )
    : undefined;
  if (
    group?.kind === "group" &&
    (!destination?.beforeTabId || group.group.tabIds.includes(destination.beforeTabId))
  ) {
    const index = destination?.beforeTabId
      ? group.group.tabIds.indexOf(destination.beforeTabId)
      : group.group.tabIds.length;
    group.group.tabIds.splice(index, 0, id);
  } else if (
    destination?.groupId === null &&
    destination.beforeTabId &&
    layout.items.some((item) => item.kind === "tab" && item.tabId === destination.beforeTabId)
  ) {
    layout.items.splice(
      layout.items.findIndex(
        (item) => item.kind === "tab" && item.tabId === destination.beforeTabId,
      ),
      0,
      { kind: "tab", tabId: id },
    );
  } else layout.items.push({ kind: "tab", tabId: id });
}
export function tabIconRef(lineageId: BrowserSessionId, favicon: string): string {
  return createHash("sha256").update(lineageId).update("\0").update(favicon).digest("base64url");
}

/** Membership and layout share the personal event fence, then the owner layout, then sorted tabs. */
export class TabStore {
  readonly database: TabDatabase;
  constructor(database: TabDatabase) {
    this.database = database;
  }

  async snapshot(
    ownerId: UserId,
    database: TabDatabase = this.database,
  ): Promise<{ rows: TabRecord[]; layout: TabLayout }> {
    return withPersonalReadTransaction(database, async (tx) => {
      const [rows, stored] = await Promise.all([
        tx
          .selectFrom("personalTabs")
          .selectAll()
          .where("ownerId", "=", ownerId)
          .where("closedAt", "is", null)
          .execute(databaseOperationOptions()),
        tx
          .selectFrom("tabLayouts")
          .selectAll()
          .where("ownerId", "=", ownerId)
          .executeTakeFirst(databaseOperationOptions()),
      ]);
      const layout = TabLayoutSchema.parse({
        revision: Number(stored?.revision ?? 0),
        items: stored?.items ?? [],
      });
      const byId = new Map(rows.map((row) => [row.id, this.#parse(row)]));
      return {
        rows: tabLayoutIds(layout).flatMap((id) => {
          const row = byId.get(id);
          return row ? [row] : [];
        }),
        layout,
      };
    });
  }

  async resourceTabs(
    database: TabDatabase,
    ownerId: UserId,
    input: { readonly after?: TabId; readonly id?: TabId; readonly limit: number },
  ) {
    const rows = await database
      .selectFrom("personalTabs")
      .selectAll()
      .where("ownerId", "=", ownerId)
      .where("closedAt", "is", null)
      .$if(input.after !== undefined, (q) => q.where("id", ">", input.after!))
      .$if(input.id !== undefined, (q) => q.where("id", "=", input.id!))
      .orderBy("id")
      .limit(input.limit)
      .execute(databaseOperationOptions());
    return rows.map((row) => this.#parse(row));
  }

  async resourceLayout(
    database: TabDatabase,
    ownerId: UserId,
    input: { readonly after: number; readonly id?: string; readonly limit: number },
  ) {
    const end = input.id ? tabsMaxPerOwner + tabGroupsMaxPerOwner : input.after + input.limit;
    const { rows } = await sql<{
      revision: string;
      ordinal: number | null;
      item: TabLayout["items"][number] | null;
    }>`
      select l.revision, p.ordinal, p.item
      from tab_layouts l
      left join lateral (
        select ordinal, l.items->(ordinal - 1) as item
        from generate_series(${input.after}::integer + 1,
          least(jsonb_array_length(l.items), ${end}::integer)) positions(ordinal)
        ${
          input.id
            ? sql`where (l.items->(ordinal - 1)->>'tabId') = ${input.id}
          or (l.items->(ordinal - 1)->'group'->>'groupId') = ${input.id}
          or (l.items->(ordinal - 1)->'group'->'tabIds') ? ${input.id}`
            : sql``
        }
        order by ordinal
        limit ${input.limit}
      ) p on true
      where l.owner_id = ${ownerId}
      order by p.ordinal
    `.execute(database);
    return {
      revision: Number(rows[0]?.revision ?? 0),
      entries: rows.flatMap(({ ordinal, item }) =>
        ordinal === null || item === null ? [] : [{ ordinal, item }],
      ),
    };
  }

  async resourceTabGroups(database: TabDatabase, ownerId: UserId, ids: readonly TabId[]) {
    if (!ids.length) return new Map<TabId, TabGroupId>();
    const result = await sql<{ tabId: TabId; groupId: TabGroupId }>`
      select t.id as tab_id, item->'group'->>'groupId' as group_id
      from tab_layouts l
      cross join lateral jsonb_array_elements(l.items) entries(item)
      join unnest(${ids}::text[]) t(id) on item->'group'->'tabIds' ? t.id
      where l.owner_id = ${ownerId} and item->>'kind' = 'group'
    `.execute(database);
    return new Map(result.rows.map(({ tabId, groupId }) => [tabId, groupId]));
  }
  #parse(row: TabRecord): TabRecord {
    return {
      ...row,
      generation: Number(row.generation),
      openedBy: TabOpenedBySchema.parse(row.openedBy),
      pageBinding: row.pageBinding ? PageBindingSchema.parse(row.pageBinding) : null,
      closedPosition: row.closedPosition ? ClosedPositionSchema.parse(row.closedPosition) : null,
      windowApp: row.windowApp ? ComputerAppIdentitySchema.parse(row.windowApp) : null,
    };
  }
  async rows(ownerId: UserId, tabIds: readonly TabId[]): Promise<TabRecord[]> {
    if (!tabIds.length) return [];
    const rows = await this.database
      .selectFrom("personalTabs")
      .selectAll()
      .where("ownerId", "=", ownerId)
      .where("id", "in", tabIds)
      .where("closedAt", "is", null)
      .execute(databaseOperationOptions());
    return rows.map((row) => this.#parse(row));
  }
  async get(
    ownerId: UserId,
    tabId: TabId,
    includeClosed = false,
    database: TabDatabase = this.database,
  ): Promise<TabRecord | null> {
    let query = database
      .selectFrom("personalTabs")
      .selectAll()
      .where("ownerId", "=", ownerId)
      .where("id", "=", tabId);
    if (!includeClosed) query = query.where("closedAt", "is", null);
    const row = await query.executeTakeFirst(databaseOperationOptions());
    return row ? this.#parse(row) : null;
  }
  async singleton(
    ownerId: UserId,
    target: Pick<TabWrite, "kind" | "computerId" | "appId" | "windowId">,
    database: TabDatabase = this.database,
  ): Promise<TabRecord | null> {
    if (target.kind === "page") return null;
    let query = database
      .selectFrom("personalTabs")
      .selectAll()
      .where("ownerId", "=", ownerId)
      .where("kind", "=", target.kind);
    if (target.kind === "app") query = query.where("appId", "=", target.appId!);
    else query = query.where("computerId", "=", target.computerId);
    if (target.kind === "window") query = query.where("windowId", "=", target.windowId!);
    const row = await query.executeTakeFirst(databaseOperationOptions());
    return row ? this.#parse(row) : null;
  }
  async latestClosed(ownerId: UserId): Promise<TabRecord | null> {
    const row = await this.database
      .selectFrom("personalTabs")
      .selectAll()
      .where("ownerId", "=", ownerId)
      .where("closedAt", "is not", null)
      .orderBy("closedAt", "desc")
      .orderBy("id")
      .executeTakeFirst(databaseOperationOptions());
    return row ? this.#parse(row) : null;
  }
  async #lock(
    tx: TabTransaction,
    ownerId: UserId,
    includeClosed: TabId[] | "latest" = [],
    onlyTabIds?: TabId[],
  ) {
    await tx
      .insertInto("tabLayouts")
      .values({ ownerId, items: sql`'[]'::jsonb` })
      .onConflict((c) => c.column("ownerId").doNothing())
      .execute(databaseOperationOptions());
    const stored = await tx
      .selectFrom("tabLayouts")
      .selectAll()
      .where("ownerId", "=", ownerId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow(databaseOperationOptions());
    const rows = await tx
      .selectFrom("personalTabs")
      .selectAll()
      .where("ownerId", "=", ownerId)
      .where((eb) =>
        onlyTabIds
          ? eb("id", "in", onlyTabIds)
          : eb.or([
              eb("closedAt", "is", null),
              ...(includeClosed === "latest"
                ? [
                    eb(
                      "id",
                      "=",
                      eb
                        .selectFrom("personalTabs")
                        .select("id")
                        .where("ownerId", "=", ownerId)
                        .where("closedAt", "is not", null)
                        .orderBy("closedAt", "desc")
                        .orderBy("id")
                        .limit(1),
                    ),
                  ]
                : includeClosed.length
                  ? [eb("id", "in", includeClosed)]
                  : []),
            ]),
      )
      .orderBy("id")
      .forNoKeyUpdate()
      .execute(databaseOperationOptions());
    return {
      rows: rows.map((row) => this.#parse(row)),
      layout: TabLayoutSchema.parse({ revision: Number(stored.revision), items: stored.items }),
    };
  }
  async #save(tx: TabTransaction, ownerId: UserId, layout: TabLayout) {
    const rows = await tx
      .selectFrom("personalTabs")
      .select("id")
      .where("ownerId", "=", ownerId)
      .where("closedAt", "is", null)
      .execute(databaseOperationOptions());
    const ids = tabLayoutIds(layout),
      open = new Set(rows.map((row) => row.id));
    const groups = layout.items.flatMap((item) =>
      item.kind === "group" ? [item.group.groupId] : [],
    );
    if (open.size > tabsMaxPerOwner || groups.length > tabGroupsMaxPerOwner)
      failure("conflict", "The workspace tab or group limit was reached.");
    if (
      ids.length !== open.size ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !open.has(id)) ||
      new Set(groups).size !== groups.length
    )
      failure("conflict", "The tab layout does not match open membership.");
    TabLayoutSchema.parse(layout);
    await tx
      .updateTable("tabLayouts")
      .set({ revision: layout.revision, items: sql`${JSON.stringify(layout.items)}::jsonb` })
      .where("ownerId", "=", ownerId)
      .execute(databaseOperationOptions());
  }
  async #mutate(
    ownerId: UserId,
    key: string,
    type: string,
    input: unknown,
    authorize: TabAuthorization | undefined,
    action: (
      tx: TabTransaction,
      state: { rows: TabRecord[]; layout: TabLayout },
    ) => Promise<TabId[]>,
    includeClosed: TabId[] | "latest" | TabWrite = [],
  ): Promise<TabMutation> {
    z.string().min(1).max(255).parse(key);
    return commitPersonalMutation(this.database, async (tx, mutation) => {
      let closed: TabId[] | "latest";
      if (Array.isArray(includeClosed) || includeClosed === "latest") closed = includeClosed;
      else {
        const singleton = await this.singleton(ownerId, includeClosed, tx);
        closed = [includeClosed.id, ...(singleton ? [singleton.id] : [])];
      }
      const state = await this.#lock(tx, ownerId, closed);
      const request = canonicalJson(input);
      const replay = await tx
        .selectFrom("commands")
        .select(["type", "payload"])
        .where("requestedBy", "=", ownerId)
        .where("idempotencyKey", "=", key)
        .executeTakeFirst(databaseOperationOptions());
      const parsedReplay = replay ? replaySchema.safeParse(replay.payload) : null;
      const matchingReplay =
        replay &&
        replay.type === type &&
        parsedReplay?.success &&
        parsedReplay.data.request === request
          ? parsedReplay.data.result
          : null;
      await authorize?.(tx, state.rows, state.layout, matchingReplay?.tabIds);
      if (replay) {
        if (!matchingReplay)
          failure("conflict", "This operation key was already used for another command.");
        const receipt: TabMutation = {
          tabIds: matchingReplay.tabIds,
          layout: matchingReplay.layout,
        };
        mutationMeta.set(receipt, { replayed: true, currentLayout: state.layout });
        return receipt;
      }
      const before = JSON.stringify(state.layout.items);
      const tabIds = await action(tx, state);
      if (JSON.stringify(state.layout.items) !== before) {
        state.layout.revision++;
        await this.#save(tx, ownerId, state.layout);
        mutation.bumpResource("tab-layout");
        mutation.bumpResource("tab");
        mutation.changeTabs(tabIds);
      }
      const result = { tabIds, layout: state.layout };
      const principal = await tx
        .selectFrom("principals")
        .select("id")
        .where("kind", "=", "user")
        .where("userId", "=", ownerId)
        .executeTakeFirstOrThrow(databaseOperationOptions());
      await tx
        .insertInto("commands")
        .values({
          id: createId("command"),
          requestedBy: ownerId,
          actorPrincipalId: principal.id,
          authoritySource: sql`'{"kind":"personal"}'::jsonb`,
          idempotencyKey: key,
          type,
          payload: sql`${JSON.stringify({ request, result })}::jsonb`,
          status: "succeeded",
          environmentId: null,
          threadId: null,
          runId: null,
          dispatcherId: null,
          lastError: null,
        })
        .execute(databaseOperationOptions());
      return result;
    });
  }
  open(
    input: TabWrite,
    key: string,
    authorize?: TabAuthorization,
    intent: unknown = input,
    membershipRevision?: number,
  ): Promise<TabMutation> {
    TabIdSchema.parse(input.id);
    TabOpenedBySchema.parse(input.openedBy);
    if (input.kind === "page" && input.id !== input.pageBinding?.surfaceId)
      failure("bad_request", "Page tabs retain their surface identity.");
    if (input.kind === "page") {
      restoreUrl.parse(input.url);
      if (input.pageBinding) PageBindingSchema.parse(input.pageBinding);
    }
    if (input.kind === "window") ComputerAppIdentitySchema.parse(input.windowApp);
    if (input.favicon) BrowserFaviconSchema.parse(input.favicon);
    return this.#mutate(
      input.ownerId,
      key,
      "tab.open",
      intent,
      authorize,
      async (tx, { rows, layout }) => {
        if (input.kind === "page") {
          const session = input.pageBinding
            ? await this.#session(tx, input.pageBinding, input.ownerId)
            : null;
          if (input.openerTabId) {
            const opener = await this.get(input.ownerId, input.openerTabId, true, tx);
            if (opener?.pageBinding?.sessionId !== input.pageBinding?.sessionId)
              failure("conflict", "The popup opener changed browser.");
          }
          if (!session || ["closed", "failed"].includes(session.state))
            failure("conflict", "The browser session no longer admits new tabs.");
        }
        const held =
          rows.find((row) => row.id === input.id) ??
          (await this.singleton(input.ownerId, input, tx));
        if (held) {
          if (held.closedAt) {
            if (membershipRevision !== undefined && membershipRevision !== layout.revision)
              failure("conflict", "This tab was closed while its target was being acquired.");
            await tx
              .updateTable("personalTabs")
              .set({
                closedAt: null,
                closedPosition: null,
                generation: held.generation + 1,
                updatedAt: new Date(),
              })
              .where("id", "=", held.id)
              .execute(databaseOperationOptions());
            insert(layout, held.id, held.closedPosition);
          }
          return [held.id];
        }
        const values = {
          id: input.id,
          ownerId: input.ownerId,
          kind: input.kind,
          computerId: input.computerId,
          title:
            input.kind === "page" ? outsideName(input.title, 1024) : input.title.slice(0, 1024),
          openedBy: sql<TabOpenedBy>`${JSON.stringify(input.openedBy)}::jsonb`,
          url: input.url ?? null,
          profileId: input.profileId ?? null,
          profileName: input.profileName ?? null,
          appId: input.appId ?? null,
          windowId: input.windowId ?? null,
          windowApp: input.windowApp
            ? sql<ComputerAppIdentity>`${JSON.stringify(input.windowApp)}::jsonb`
            : null,
          pageBinding: input.pageBinding
            ? sql<PageBinding>`${JSON.stringify(input.pageBinding)}::jsonb`
            : null,
          favicon: input.favicon ?? null,
          iconRef:
            input.favicon && input.pageBinding
              ? tabIconRef(input.pageBinding.lineageId, input.favicon)
              : null,
          openerTabId: input.openerTabId ?? null,
          closedPosition: null,
        };
        await tx.insertInto("personalTabs").values(values).execute(databaseOperationOptions());
        if (input.openerTabId && tabLayoutIds(layout).includes(input.openerTabId)) {
          const opener = position(layout, input.openerTabId);
          insert(layout, input.id, opener);
        } else insert(layout, input.id);
        return [input.id];
      },
      input,
    );
  }
  close(
    ownerId: UserId,
    tabIds: TabId[],
    key: string,
    authorize?: TabAuthorization,
    canClose?: (row: TabRecord) => boolean,
  ): Promise<TabMutation> {
    z.array(TabIdSchema)
      .min(1)
      .max(tabsMaxPerMutation)
      .refine((ids) => new Set(ids).size === ids.length)
      .parse(tabIds);
    return this.#mutate(
      ownerId,
      key,
      "tab.close",
      { tabIds },
      authorize,
      async (tx, { rows, layout }) => {
        const open = rows.filter(
          (row) => !row.closedAt && tabIds.includes(row.id) && (!canClose || canClose(row)),
        );
        await this.#closeRows(tx, open, layout);
        return open.map((row) => row.id);
      },
      tabIds,
    );
  }
  reopen(
    ownerId: UserId,
    tabId: TabId | undefined,
    key: string,
    authorize?: TabAuthorization,
  ): Promise<TabMutation> {
    return this.#mutate(
      ownerId,
      key,
      "tab.reopen",
      { tabId: tabId ?? null },
      authorize,
      async (tx, { rows, layout }) => {
        const row = tabId
          ? rows.find((row) => row.id === tabId)
          : rows
              .filter((row) => row.closedAt)
              .sort(
                (a, b) => b.closedAt!.getTime() - a.closedAt!.getTime() || a.id.localeCompare(b.id),
              )[0];
        if (!row) failure("not_found", "There is no tab to reopen.");
        if (row.closedAt) {
          await tx
            .updateTable("personalTabs")
            .set({
              closedAt: null,
              closedPosition: null,
              updatedAt: new Date(),
              generation: row.generation + 1,
            })
            .where("id", "=", row.id)
            .execute(databaseOperationOptions());
          insert(layout, row.id, row.closedPosition);
        }
        return [row.id];
      },
      tabId ? [tabId] : "latest",
    );
  }
  organize(
    ownerId: UserId,
    input: TabOrganizeInput,
    key: string,
    authorize?: TabAuthorization,
    wire: TabOrganizeInput = input,
  ): Promise<TabMutation> {
    return this.#mutate(ownerId, key, "tab.organize", wire, authorize, async (_tx, { layout }) => {
      const ids = new Set(input.tabIds);
      if (!ids.size || ids.size !== input.tabIds.length || ids.size > tabsMaxPerMutation)
        failure("bad_request", "Supply unique tab IDs within the mutation limit.");
      if (input.tabIds.some((id) => !tabLayoutIds(layout).includes(id)))
        failure("not_found", "A tab is no longer open.");
      if (
        input.beforeTabId &&
        (ids.has(input.beforeTabId) || !tabLayoutIds(layout).includes(input.beforeTabId))
      )
        failure("conflict", "The destination tab is no longer a valid anchor.");
      const original = structuredClone(layout);
      const targetGroupId = input.group && "groupId" in input.group ? input.group.groupId : null;
      const target = targetGroupId
        ? layout.items.find((item) => item.kind === "group" && item.group.groupId === targetGroupId)
        : undefined;
      if (input.group && "groupId" in input.group && target?.kind !== "group")
        failure("not_found", "Tab group not found.");
      const anchorGroup = input.beforeTabId ? tabGroupOf(layout, input.beforeTabId) : null;
      const wholeGroup =
        target?.kind === "group" &&
        target.group.tabIds.length === ids.size &&
        target.group.tabIds.every((id) => ids.has(id));
      const outside =
        input.beforeTabId &&
        (target?.kind === "group" ? anchorGroup !== target.group.groupId : anchorGroup !== null);
      const creating = input.group !== null && "name" in input.group;
      // A group's place is named by its first member that is not moving.
      const rootBoundary =
        input.group === null &&
        layout.items.some(
          (item) =>
            item.kind === "group" &&
            item.group.tabIds.find((id) => !ids.has(id)) === input.beforeTabId,
        );
      if (outside && !creating && !wholeGroup && !rootBoundary)
        failure("conflict", "The anchor belongs to another destination.");
      removeIds(layout, ids);
      if (target?.kind === "group") {
        const current = layout.items.find(
          (item) => item.kind === "group" && item.group.groupId === target.group.groupId,
        )!;
        if (current.kind !== "group") failure("conflict", "The destination group changed.");
        if (wholeGroup && (outside || !input.beforeTabId)) {
          current.group.tabIds = [...input.tabIds];
          layout.items = layout.items.filter((item) => item !== current);
          const anchor = input.beforeTabId
            ? layout.items.findIndex((item) =>
                item.kind === "tab"
                  ? item.tabId === input.beforeTabId
                  : item.group.tabIds.includes(input.beforeTabId!),
              )
            : layout.items.length;
          layout.items.splice(anchor, 0, current);
        } else {
          const anchor = input.beforeTabId
            ? current.group.tabIds.indexOf(input.beforeTabId)
            : current.group.tabIds.length;
          current.group.tabIds.splice(anchor, 0, ...input.tabIds);
        }
      } else if (creating) {
        const group = TabGroupSchema.parse({
          ...input.group,
          groupId: `tgp_${randomUUID()}`,
          collapsed: false,
          tabIds: input.tabIds,
        });
        let anchor = layout.items.length;
        if (input.beforeTabId)
          anchor = layout.items.findIndex((item) =>
            item.kind === "tab"
              ? item.tabId === input.beforeTabId
              : item.group.tabIds.includes(input.beforeTabId!),
          );
        else {
          const first = original.items.findIndex((item) =>
            item.kind === "tab" ? ids.has(item.tabId) : item.group.tabIds.some((id) => ids.has(id)),
          );
          const preceding = original.items.slice(0, first);
          anchor = layout.items.filter((item) =>
            preceding.some((old) =>
              old.kind === "tab" && item.kind === "tab"
                ? old.tabId === item.tabId
                : old.kind === "group" &&
                  item.kind === "group" &&
                  old.group.groupId === item.group.groupId,
            ),
          ).length;
        }
        layout.items.splice(anchor, 0, { kind: "group", group });
      } else {
        const anchor = input.beforeTabId
          ? layout.items.findIndex((item) =>
              item.kind === "tab"
                ? item.tabId === input.beforeTabId
                : item.group.tabIds[0] === input.beforeTabId,
            )
          : layout.items.length;
        layout.items.splice(
          anchor,
          0,
          ...input.tabIds.map((tabId) => ({ kind: "tab" as const, tabId })),
        );
      }
      return input.tabIds;
    });
  }
  updateGroup(
    ownerId: UserId,
    input: TabGroupUpdateInput,
    key: string,
    authorize?: TabAuthorization,
  ) {
    return this.#mutate(
      ownerId,
      key,
      "tab.group.update",
      input,
      authorize,
      async (_tx, { layout }) => {
        const item = layout.items.find(
          (item) => item.kind === "group" && item.group.groupId === input.groupId,
        );
        if (item?.kind !== "group") failure("not_found", "Tab group not found.");
        item.group = TabGroupSchema.parse({ ...item.group, ...input });
        return item.group.tabIds;
      },
    );
  }
  /**
   * Closing a group, decided once here: the members the group has now close, and the group goes
   * once it has none left. A member that may not close keeps the group, with the members that
   * remain. A group already empty is removed. A single tab's close keeps its group (Undo needs it).
   */
  closeGroup(
    ownerId: UserId,
    groupId: TabGroupId,
    key: string,
    authorize?: TabAuthorization,
    canClose?: (row: TabRecord) => boolean,
  ): Promise<TabMutation> {
    return this.#mutate(
      ownerId,
      key,
      "tab.group.close",
      { groupId },
      authorize,
      async (tx, { rows, layout }) => {
        const item = layout.items.find(
          (item) => item.kind === "group" && item.group.groupId === groupId,
        );
        if (item?.kind !== "group") failure("not_found", "Tab group not found.");
        const members = new Set(item.group.tabIds);
        const open = rows.filter(
          (row) => !row.closedAt && members.has(row.id) && (!canClose || canClose(row)),
        );
        await this.#closeRows(tx, open, layout);
        const remaining = layout.items.find(
          (item) => item.kind === "group" && item.group.groupId === groupId,
        );
        if (remaining?.kind === "group" && remaining.group.tabIds.length === 0)
          layout.items = layout.items.filter((item) => item !== remaining);
        return open.map((row) => row.id);
      },
    );
  }
  deleteGroup(ownerId: UserId, groupId: TabGroupId, key: string, authorize?: TabAuthorization) {
    return this.#mutate(
      ownerId,
      key,
      "tab.group.delete",
      { groupId },
      authorize,
      async (_tx, { layout }) => {
        const index = layout.items.findIndex(
          (item) => item.kind === "group" && item.group.groupId === groupId,
        );
        const item = layout.items[index];
        if (item?.kind !== "group") failure("not_found", "Tab group not found.");
        layout.items.splice(
          index,
          1,
          ...item.group.tabIds.map((tabId) => ({ kind: "tab" as const, tabId })),
        );
        return item.group.tabIds;
      },
    );
  }
  /** Marks the rows closed where the layout holds them, then takes them out of it. */
  async #closeRows(tx: TabTransaction, open: readonly TabRecord[], layout: TabLayout) {
    for (const row of open)
      await tx
        .updateTable("personalTabs")
        .set({
          closedAt: new Date(),
          updatedAt: new Date(),
          generation: row.generation + 1,
          closedPosition: sql`${JSON.stringify(position(layout, row.id))}::jsonb`,
        })
        .where("id", "=", row.id)
        .execute(databaseOperationOptions());
    removeIds(layout, new Set(open.map((row) => row.id)));
  }
  async #latest(tx: TabTransaction, binding: PageBinding) {
    const latest = await tx
      .selectFrom("browserSessions")
      .select(["id", "origin", "opener", "state"])
      .where("tabGroupId", "=", binding.lineageId)
      .orderBy("createdAt", "desc")
      .orderBy("id", "desc")
      .executeTakeFirst(databaseOperationOptions());
    return latest?.id === binding.sessionId &&
      latest.origin !== "trigger" &&
      latest.opener?.kind !== "automation"
      ? latest
      : null;
  }
  async #session(tx: TabTransaction, binding: PageBinding, ownerId: UserId) {
    const session = await tx
      .selectFrom("browserSessions")
      .select(["id", "origin", "opener", "state", "runnerId"])
      .where("id", "=", binding.sessionId)
      .where("tabGroupId", "=", binding.lineageId)
      .executeTakeFirst(databaseOperationOptions());
    if (
      !session ||
      session.origin === "trigger" ||
      session.opener?.kind === "automation" ||
      ["closed", "failed"].includes(session.state)
    )
      return null;
    const viewer = await tx
      .selectFrom("personalSettings")
      .innerJoin("users", "users.id", "personalSettings.ownerId")
      .select("ownerId")
      .where("ownerId", "=", ownerId)
      .where("users.disabledAt", "is", null)
      .executeTakeFirst(databaseOperationOptions());
    return viewer ? session : null;
  }
  async bindPage(
    ownerId: UserId,
    tabId: TabId,
    generation: number,
    previous: PageBinding | null,
    binding: PageBinding,
  ): Promise<TabRecord | null> {
    PageBindingSchema.parse(binding);
    return commitPersonalMutation(this.database, async (tx, mutation) => {
      await this.#lock(tx, ownerId, [], [tabId]);
      if (!(await this.#latest(tx, binding))) return null;
      const row = await this.get(ownerId, tabId, false, tx);
      if (
        !row ||
        row.kind !== "page" ||
        row.generation !== generation ||
        canonicalJson(row.pageBinding) !== canonicalJson(previous) ||
        tabId !== binding.surfaceId
      )
        return null;
      await tx
        .updateTable("personalTabs")
        .set({ pageBinding: sql`${JSON.stringify(binding)}::jsonb`, updatedAt: new Date() })
        .where("id", "=", tabId)
        .execute(databaseOperationOptions());
      mutation.bumpResource("tab");
      mutation.changeTabs([tabId]);
      // The row as this bind left it: the witness anything later acting on this binding checks.
      return await this.get(ownerId, tabId, false, tx);
    });
  }
  async updatePage(
    ownerId: UserId,
    tabId: TabId,
    generation: number,
    binding: PageBinding,
    descriptor: { title: string; url: string; favicon?: string | null; loading?: boolean },
    restoring = false,
  ): Promise<boolean> {
    PageBindingSchema.parse(binding);
    restoreUrl.parse(descriptor.url);
    if (descriptor.favicon) BrowserFaviconSchema.parse(descriptor.favicon);
    const named = outsideName(descriptor.title, 1024);
    return commitPersonalMutation(this.database, async (tx, mutation) => {
      await this.#lock(tx, ownerId, [], [tabId]);
      if (!(await this.#session(tx, binding, ownerId))) return false;
      const row = await this.get(ownerId, tabId, false, tx);
      if (
        !row ||
        row.generation !== generation ||
        canonicalJson(row.pageBinding) !== canonicalJson(binding)
      )
        return false;
      if (restoring && descriptor.url === "about:blank" && row.url !== "about:blank") return false;
      const favicon = descriptor.favicon ?? (descriptor.url === row.url ? row.favicon : null);
      // A tab keeps the title last seen at its address while a new document there loads with
      // none yet (a reload, a restore); once it has loaded, its own title stands, empty or not.
      const title =
        named === "" && descriptor.loading && descriptor.url === row.url ? row.title : named;
      if (row.title === title && row.url === descriptor.url && row.favicon === favicon)
        return false;
      await tx
        .updateTable("personalTabs")
        .set({
          title,
          url: descriptor.url,
          favicon,
          iconRef: favicon ? tabIconRef(binding.lineageId, favicon) : null,
          updatedAt: new Date(),
        })
        .where("id", "=", tabId)
        .execute(databaseOperationOptions());
      mutation.bumpResource("tab");
      mutation.changeTabs([tabId]);
      return true;
    });
  }
  /** AppService calls this inside its existing personal transaction, before removing the app. */
  async removeTabs(tx: TabTransaction, appId: AppId): Promise<TabId[]> {
    return commitPersonalMutation(tx, async (tx, mutation) => {
      const owned = await tx
        .selectFrom("personalTabs")
        .select(["id", "ownerId"])
        .where("appId", "=", appId)
        .execute(databaseOperationOptions());
      for (const ownerId of [...new Set(owned.map((row) => row.ownerId))].sort()) {
        const ids = owned.filter((row) => row.ownerId === ownerId).map((row) => row.id);
        const { layout } = await this.#lock(tx, ownerId, ids);
        removeIds(layout, new Set(ids));
        await tx
          .deleteFrom("personalTabs")
          .where("ownerId", "=", ownerId)
          .where("id", "in", ids)
          .execute(databaseOperationOptions());
        layout.revision++;
        await this.#save(tx, ownerId, layout);
      }
      if (owned.length) {
        mutation.bumpResource("tab");
        mutation.bumpResource("tab-layout");
        mutation.changeTabs(owned.map((row) => row.id));
      }
      return owned.map((row) => row.id);
    });
  }
}
