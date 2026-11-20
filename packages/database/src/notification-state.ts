import { requirePersonalOwner } from "./personal-settings-store.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import { authorizedSyncState, withPersonalSyncRead } from "./personal-sync-store.js";
import { recordThreadVisit } from "./thread-visits.js";
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
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";
/** Durable per-person viewer state. */
export class NotificationStateStore {
  readonly #database: Kysely<DatabaseSchema>;
  constructor(database: Kysely<DatabaseSchema>) {
    this.#database = database;
  }
  attention(userId: UserId): Promise<{ needsYou: number; unread: boolean }> {
    return withPersonalSyncRead(this.#database, async (transaction) => {
      const { needsYouCount, unreadTaskCount } = await authorizedSyncState(transaction, userId);
      return { needsYou: needsYouCount, unread: unreadTaskCount > 0 };
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
    return recordThreadVisit(this.#database, input);
  }

  async setIdleCompactionPolicy(input: {
    readonly policy: IdleCompactionPolicy;
    readonly userId: UserId;
  }): Promise<IdleCompactionPolicy> {
    return commitPersonalMutation(this.#database, async (transaction, mutation) => {
      await requirePersonalOwner(transaction, input.userId);
      const policy = IdleCompactionPolicySchema.parse(input.policy);
      const updated = await transaction
        .updateTable("personalSettings")
        .set({ idleCompactionPolicy: policy })
        .where("ownerId", "=", input.userId)
        .where("idleCompactionPolicy", "is distinct from", policy)
        .executeTakeFirstOrThrow();
      if (updated.numUpdatedRows) mutation.bumpResource("settings");
      return policy;
    });
  }
  async setQuietTaskDays(input: {
    readonly administration?: AdministrationCommandIdentity | undefined;
    readonly quietTaskDays: QuietTaskDays;
    readonly userId: UserId;
  }): Promise<QuietTaskDays> {
    return commitPersonalMutation(this.#database, (transaction, mutation) =>
      administrationCommand(transaction, input.administration, async () => {
        await requirePersonalOwner(transaction, input.userId);
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
        mutation.bumpResource("settings");
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
