import { markThreadStatePending } from "./thread-state-pending.js";
import { requirePersonalOwner } from "./personal-settings-store.js";
import { withPersonalReadTransaction, withPersonalTransaction } from "./personal-transaction.js";
import {
  administrationCommand,
  type AdministrationCommandIdentity,
} from "./administration-command.js";
import "./connection.js";
import {
  defaultQuietTaskDays,
  IdleCompactionPolicySchema,
  type IdleCompactionPolicy,
  OpensteerError,
  QuietTaskDaysSchema,
  type QuietTaskDays,
  type ThreadId,
  type ThreadVisit,
  type UserId,
} from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import { latestRunCompletion, threadUnreadPredicate } from "./thread-visits.js";
import type { DatabaseSchema } from "./schema.js";
import { safeCount } from "./store-primitives.js";
/** Durable per-person viewer state. */
export class NotificationStateStore {
  readonly #database: Kysely<DatabaseSchema>;
  constructor(database: Kysely<DatabaseSchema>) {
    this.#database = database;
  }
  attention(
    userId: UserId,
    input: { readonly deviceAccessRequests?: "include" } = {},
  ): Promise<{ needsYou: number; unread: boolean }> {
    return withPersonalReadTransaction(this.#database, async (transaction) => {
      await requirePersonalOwner(transaction, userId);
      const {
        rows: [row],
      } = await sql<{ needsYou: string; unread: boolean }>`
        select (select count(*) from requests where status = 'pending' and (${input.deviceAccessRequests === "include"} or kind <> 'device.access'))::text as needs_you,
        exists (select 1 from threads thread
          left join thread_visits visit on visit.thread_id = thread.id and visit.user_id = ${userId}
          where thread.listed and thread.purpose = 'task' and thread.status <> 'archived'
          and ${threadUnreadPredicate(latestRunCompletion(sql`thread.id`), sql`visit.last_visited_at`)}) as unread
      `.execute(transaction);
      if (!row) throw new Error("Personal attention summary was not returned");
      return { needsYou: safeCount(row.needsYou), unread: row.unread };
    });
  }
  async visitPage(input: {
    readonly userId: UserId;
    readonly afterThreadId?: ThreadId | null;
    readonly limit?: number;
  }) {
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new TypeError("Visit page limit must be between 1 and 100");
    await requirePersonalOwner(this.#database, input.userId);
    let query = this.#database
      .selectFrom("threadVisits")
      .select(["threadId", "lastVisitedAt"])
      .where("userId", "=", input.userId);
    if (input.afterThreadId) query = query.where("threadId", ">", input.afterThreadId);
    const rows = await query
      .orderBy("threadId")
      .limit(limit + 1)
      .execute();
    const visits = rows
      .slice(0, limit)
      .map((row) => ({ threadId: row.threadId, lastVisitedAt: row.lastVisitedAt.toISOString() }));
    return { visits, nextAfterThreadId: rows.length > limit ? visits.at(-1)!.threadId : null };
  }
  async visit(input: {
    readonly threadId: ThreadId;
    readonly visitedAt: string;
    readonly userId: UserId;
  }): Promise<ThreadVisit> {
    return withPersonalTransaction(this.#database, async (transaction) => {
      await requirePersonalOwner(transaction, input.userId);
      const thread = await transaction
        .selectFrom("threads")
        .select("id")
        .where("id", "=", input.threadId)
        .executeTakeFirst();
      if (!thread) throw new OpensteerError({ code: "not_found", message: "Thread not found" });
      const visitedAt = new Date(Math.min(Date.parse(input.visitedAt), Date.now()));
      const row = await transaction
        .insertInto("threadVisits")
        .values({
          threadId: input.threadId,
          userId: input.userId,
          lastVisitedAt: visitedAt,
          updatedAt: new Date(),
        })
        .onConflict((conflict) =>
          conflict.columns(["threadId", "userId"]).doUpdateSet({
            lastVisitedAt: sql`greatest(thread_visits.last_visited_at, excluded.last_visited_at)`,
            updatedAt: sql`case when excluded.last_visited_at > thread_visits.last_visited_at then excluded.updated_at else thread_visits.updated_at end`,
          }),
        )
        .returning(["threadId", "lastVisitedAt"])
        .executeTakeFirstOrThrow();
      return { threadId: row.threadId, lastVisitedAt: row.lastVisitedAt.toISOString() };
    });
  }

  async setIdleCompactionPolicy(input: {
    readonly policy: IdleCompactionPolicy;
    readonly userId: UserId;
  }): Promise<IdleCompactionPolicy> {
    return withPersonalTransaction(this.#database, async (transaction) => {
      await requirePersonalOwner(transaction, input.userId);
      const policy = IdleCompactionPolicySchema.parse(input.policy);
      await transaction
        .updateTable("personalSettings")
        .set({ idleCompactionPolicy: policy })
        .where("ownerId", "=", input.userId)
        .executeTakeFirstOrThrow();
      const threads = await transaction
        .selectFrom("threads")
        .select("id")
        .where("createdBy", "=", input.userId)
        .execute();
      for (const thread of threads) await markThreadStatePending(transaction, thread.id);
      return policy;
    });
  }
  async setQuietTaskDays(input: {
    readonly administration?: AdministrationCommandIdentity | undefined;
    readonly quietTaskDays: QuietTaskDays;
    readonly userId: UserId;
  }): Promise<QuietTaskDays> {
    return withPersonalTransaction(this.#database, (transaction) =>
      administrationCommand(transaction, input.administration, async () => {
        const quietTaskDays = QuietTaskDaysSchema.parse(input.quietTaskDays);
        const updated = await transaction
          .updateTable("personalSettings")
          .set({ quietTaskDays })
          .where("ownerId", "=", input.userId)
          .executeTakeFirst();
        if (updated.numUpdatedRows !== 1n) {
          throw new OpensteerError({
            code: "not_found",
            message: "User not found",
          });
        }
        return quietTaskDays;
      }),
    );
  }
  async quietTaskDaysFor(userId: UserId): Promise<QuietTaskDays> {
    const row = await this.#database
      .selectFrom("personalSettings")
      .select("quietTaskDays")
      .where("ownerId", "=", userId)
      .executeTakeFirst();
    return QuietTaskDaysSchema.catch(defaultQuietTaskDays).parse(row?.quietTaskDays);
  }
}
