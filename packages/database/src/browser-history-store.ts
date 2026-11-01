import { createId, OpensteerError, type BrowserProfileId, type UserId } from "@opensteer/core";
import {
  BrowserFaviconSchema,
  browserHistoryMaxEntries,
  browserHistoryRetentionMs,
  BrowserHistoryUrlSchema,
  type BrowserHistory,
  type BrowserHistoryIcons,
} from "@opensteer/protocol";
import type { Kysely, Transaction } from "kysely";
import { createHash } from "node:crypto";
import { z } from "zod";
import { withDatabaseTransaction } from "./connection.js";
import { databaseOperationOptions } from "./operation-budget.js";
import type { DatabaseSchema } from "./schema.js";
import {
  findCommandByIdempotency,
  idempotencyConflict,
  jsonValue,
  lockCommandIdempotency,
  principalIdForUser,
} from "./store-primitives.js";

export async function lockBrowserHistory(
  tx: Transaction<DatabaseSchema>,
  profileId: BrowserProfileId,
): Promise<void> {
  await tx
    .selectFrom("browserHistoryEntries")
    .select("url")
    .where("profileId", "=", profileId)
    .orderBy("profileId")
    .orderBy("url")
    // FOR UPDATE: Retention and explicit erasure delete entries.
    .forUpdate()
    .execute(databaseOperationOptions());
  await tx
    .selectFrom("browserHistoryIcons")
    .select("origin")
    .where("profileId", "=", profileId)
    .orderBy("profileId")
    .orderBy("origin")
    // FOR UPDATE: Removing the last entry of an origin deletes its icon.
    .forUpdate()
    .execute(databaseOperationOptions());
}

export class BrowserHistoryStore {
  readonly #database: Kysely<DatabaseSchema>;

  constructor(database: Kysely<DatabaseSchema>) {
    this.#database = database;
  }

  async #profile(tx: Transaction<DatabaseSchema>, profileId: BrowserProfileId, ownerId?: UserId) {
    let query = tx
      .selectFrom("browserProfiles")
      .select("id")
      .where("id", "=", profileId)
      .where("archivedAt", "is", null);
    if (ownerId) query = query.where("ownerId", "=", ownerId);
    return query.forNoKeyUpdate().executeTakeFirst(databaseOperationOptions());
  }

  async #prune(tx: Transaction<DatabaseSchema>, profileId: BrowserProfileId, now: Date) {
    await tx
      .deleteFrom("browserHistoryEntries")
      .where("profileId", "=", profileId)
      .where("lastVisitAt", "<=", new Date(now.getTime() - browserHistoryRetentionMs))
      .execute(databaseOperationOptions());
    const excess = await tx
      .selectFrom("browserHistoryEntries")
      .select("url")
      .where("profileId", "=", profileId)
      .orderBy("lastVisitAt", "desc")
      .orderBy("url")
      .offset(browserHistoryMaxEntries)
      .execute(databaseOperationOptions());
    if (excess.length)
      await tx
        .deleteFrom("browserHistoryEntries")
        .where("profileId", "=", profileId)
        .where(
          "url",
          "in",
          excess.map(({ url }) => url),
        )
        .execute(databaseOperationOptions());
    return tx
      .deleteFrom("browserHistoryIcons")
      .where("profileId", "=", profileId)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("browserHistoryEntries")
              .select("url")
              .whereRef("browserHistoryEntries.profileId", "=", "browserHistoryIcons.profileId")
              .whereRef("browserHistoryEntries.origin", "=", "browserHistoryIcons.origin"),
          ),
        ),
      )
      .execute(databaseOperationOptions());
  }

  async #icon(
    tx: Transaction<DatabaseSchema>,
    profileId: BrowserProfileId,
    origin: string,
    favicon: string,
  ) {
    BrowserFaviconSchema.parse(favicon);
    const visited = await tx
      .selectFrom("browserHistoryEntries")
      .select("url")
      .where("profileId", "=", profileId)
      .where("origin", "=", origin)
      .limit(1)
      .executeTakeFirst(databaseOperationOptions());
    if (!visited) return false;
    const iconRef = createHash("sha256").update(favicon).digest("base64url");
    const result = await tx
      .insertInto("browserHistoryIcons")
      .values({ profileId, origin, favicon, iconRef })
      .onConflict((conflict) =>
        conflict
          .columns(["profileId", "origin"])
          .doUpdateSet({ favicon, iconRef })
          .where("browserHistoryIcons.iconRef", "!=", iconRef),
      )
      .executeTakeFirst(databaseOperationOptions());
    return (result.numInsertedOrUpdatedRows ?? 0n) > 0n;
  }

  async recordVisit(input: {
    profileId: BrowserProfileId;
    ownerId: UserId;
    url: string;
    title: string;
    typed: boolean;
    favicon?: string;
    now?: Date;
  }): Promise<boolean> {
    const url = BrowserHistoryUrlSchema.parse(input.url);
    const now = input.now ?? new Date();
    return withDatabaseTransaction(this.#database, async (tx) => {
      if (!(await this.#profile(tx, input.profileId, input.ownerId))) return false;
      await lockBrowserHistory(tx, input.profileId);
      await tx
        .insertInto("browserHistoryEntries")
        .values({
          profileId: input.profileId,
          url,
          origin: new URL(url).origin,
          title: input.title.slice(0, 200),
          typedCount: input.typed ? 1 : 0,
          visitCount: 1,
          lastVisitAt: now,
        })
        .onConflict((conflict) =>
          conflict.columns(["profileId", "url"]).doUpdateSet((eb) => ({
            title: input.title.slice(0, 200),
            lastVisitAt: now,
            typedCount: eb("browserHistoryEntries.typedCount", "+", input.typed ? 1 : 0),
            visitCount: eb("browserHistoryEntries.visitCount", "+", 1),
          })),
        )
        .execute(databaseOperationOptions());
      await this.#prune(tx, input.profileId, now);
      if (input.favicon) await this.#icon(tx, input.profileId, new URL(url).origin, input.favicon);
      return true;
    });
  }

  async retitle(input: {
    profileId: BrowserProfileId;
    url: string;
    title: string;
  }): Promise<boolean> {
    return withDatabaseTransaction(this.#database, async (tx) => {
      if (!(await this.#profile(tx, input.profileId))) return false;
      await lockBrowserHistory(tx, input.profileId);
      const title = input.title.slice(0, 200);
      const result = await tx
        .updateTable("browserHistoryEntries")
        .set({ title })
        .where("profileId", "=", input.profileId)
        .where("url", "=", input.url)
        .where("title", "!=", title)
        .executeTakeFirst(databaseOperationOptions());
      return result.numUpdatedRows > 0n;
    });
  }

  async retainIcon(input: {
    profileId: BrowserProfileId;
    origin: string;
    favicon: string;
  }): Promise<boolean> {
    const origin = new URL(BrowserHistoryUrlSchema.parse(input.origin)).origin;
    return withDatabaseTransaction(this.#database, async (tx) => {
      if (!(await this.#profile(tx, input.profileId))) return false;
      await lockBrowserHistory(tx, input.profileId);
      return this.#icon(tx, input.profileId, origin, input.favicon);
    });
  }

  async prune(now = new Date()): Promise<{ ownerId: UserId; profileId: BrowserProfileId }[]> {
    return withDatabaseTransaction(this.#database, async (tx) => {
      const cutoff = new Date(now.getTime() - browserHistoryRetentionMs);
      await tx
        .selectFrom("browserHistoryEntries")
        .select("url")
        .where("lastVisitAt", "<=", cutoff)
        .orderBy("profileId")
        .orderBy("url")
        // FOR UPDATE: Global expiry takes the same row order as profile erasure.
        .forUpdate()
        .execute(databaseOperationOptions());
      const entries = await tx
        .deleteFrom("browserHistoryEntries")
        .where("lastVisitAt", "<=", cutoff)
        .returning("profileId")
        .execute(databaseOperationOptions());
      await tx
        .selectFrom("browserHistoryIcons")
        .select("origin")
        .orderBy("profileId")
        .orderBy("origin")
        // FOR UPDATE: Orphan cleanup can remove icons from several profiles.
        .forUpdate()
        .execute(databaseOperationOptions());
      const icons = await tx
        .deleteFrom("browserHistoryIcons")
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom("browserHistoryEntries")
                .select("url")
                .whereRef("browserHistoryEntries.profileId", "=", "browserHistoryIcons.profileId")
                .whereRef("browserHistoryEntries.origin", "=", "browserHistoryIcons.origin"),
            ),
          ),
        )
        .returning("profileId")
        .execute(databaseOperationOptions());
      const ids = [...new Set([...entries, ...icons].map(({ profileId }) => profileId))];
      if (!ids.length) return [];
      return tx
        .selectFrom("browserProfiles")
        .select(["id as profileId", "ownerId"])
        .where("id", "in", ids)
        .orderBy("id")
        .execute(databaseOperationOptions());
    });
  }

  async list(profileId: BrowserProfileId, ownerId: UserId): Promise<BrowserHistory> {
    return withDatabaseTransaction(this.#database, async (tx) => {
      if (!(await this.#profile(tx, profileId, ownerId)))
        throw new OpensteerError({ code: "not_found", message: "Browser profile not found" });
      const rows = await tx
        .selectFrom("browserHistoryEntries")
        .selectAll()
        .where("profileId", "=", profileId)
        .where("lastVisitAt", ">", new Date(Date.now() - browserHistoryRetentionMs))
        .orderBy("lastVisitAt", "desc")
        .orderBy("url")
        .limit(browserHistoryMaxEntries)
        .execute(databaseOperationOptions());
      const origins = [...new Set(rows.map(({ origin }) => origin))];
      const icons = origins.length
        ? await tx
            .selectFrom("browserHistoryIcons")
            .select(["origin", "iconRef"])
            .where("profileId", "=", profileId)
            .where("origin", "in", origins)
            .execute(databaseOperationOptions())
        : [];
      return {
        entries: rows.map(({ url, title, typedCount, visitCount, lastVisitAt }) => ({
          url,
          title,
          typedCount,
          visitCount,
          lastVisitAt: lastVisitAt.toISOString(),
        })),
        icons,
      };
    });
  }

  async icons(
    profileId: BrowserProfileId,
    ownerId: UserId,
    refs: readonly string[],
  ): Promise<BrowserHistoryIcons> {
    return withDatabaseTransaction(this.#database, async (tx) => {
      if (!(await this.#profile(tx, profileId, ownerId)))
        throw new OpensteerError({ code: "not_found", message: "Browser profile not found" });
      if (!refs.length) return { icons: [] };
      const icons = await tx
        .selectFrom("browserHistoryIcons")
        .select(["iconRef", "favicon"])
        .distinct()
        .where("profileId", "=", profileId)
        .where("iconRef", "in", refs)
        .where(({ exists, selectFrom }) =>
          exists(
            selectFrom("browserHistoryEntries")
              .select("url")
              .whereRef("browserHistoryEntries.profileId", "=", "browserHistoryIcons.profileId")
              .whereRef("browserHistoryEntries.origin", "=", "browserHistoryIcons.origin")
              .where("lastVisitAt", ">", new Date(Date.now() - browserHistoryRetentionMs)),
          ),
        )
        .execute(databaseOperationOptions());
      return { icons };
    });
  }

  async remove(input: {
    profileId: BrowserProfileId;
    ownerId: UserId;
    idempotencyKey: string;
    url: string;
  }): Promise<boolean> {
    return this.#forget(input);
  }

  async clear(input: {
    profileId: BrowserProfileId;
    ownerId: UserId;
    idempotencyKey: string;
  }): Promise<boolean> {
    return this.#forget(input);
  }

  async #forget(input: {
    profileId: BrowserProfileId;
    ownerId: UserId;
    idempotencyKey: string;
    url?: string;
  }) {
    const type = input.url === undefined ? "browser.history.clear" : "browser.history.remove";
    const payload = {
      profileId: input.profileId,
      urlFingerprint:
        input.url === undefined
          ? null
          : createHash("sha256").update(`${input.profileId}\0${input.url}`).digest("base64url"),
    };
    return withDatabaseTransaction(this.#database, async (tx) => {
      await lockCommandIdempotency(tx, input.ownerId, input.idempotencyKey);
      if (!(await this.#profile(tx, input.profileId, input.ownerId)))
        throw new OpensteerError({ code: "not_found", message: "Browser profile not found" });
      const previous = await findCommandByIdempotency(tx, input.ownerId, input.idempotencyKey);
      if (previous) {
        const recorded = z
          .object({ profileId: z.string(), urlFingerprint: z.string().nullable() })
          .safeParse(previous.payload);
        if (
          previous.type !== type ||
          !recorded.success ||
          recorded.data.profileId !== payload.profileId ||
          recorded.data.urlFingerprint !== payload.urlFingerprint
        )
          throw idempotencyConflict(input.idempotencyKey);
        return false;
      }
      await lockBrowserHistory(tx, input.profileId);
      let query = tx.deleteFrom("browserHistoryEntries").where("profileId", "=", input.profileId);
      if (input.url !== undefined) query = query.where("url", "=", input.url);
      const removed = await query.executeTakeFirst(databaseOperationOptions());
      const pruned = await this.#prune(tx, input.profileId, new Date());
      await tx
        .insertInto("commands")
        .values({
          actorPrincipalId: await principalIdForUser(tx, input.ownerId),
          authoritySource: jsonValue({ kind: "user-session", userId: input.ownerId }),
          dispatcherId: null,
          environmentId: null,
          id: createId("command"),
          idempotencyKey: input.idempotencyKey,
          lastError: null,
          payload: jsonValue(payload),
          requestedBy: input.ownerId,
          runId: null,
          status: "succeeded",
          threadId: null,
          type,
        })
        .execute(databaseOperationOptions());
      return removed.numDeletedRows > 0n || pruned.some((result) => result.numDeletedRows > 0n);
    });
  }
}
