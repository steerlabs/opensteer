import { createId, type UserId } from "@opensteer/core";
import { TeamNoticeSchema } from "@opensteer/protocol";
import type { Kysely, Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";

export async function addTeamSelfAddNotices(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly actorUserId: UserId;
    readonly managerIds: readonly UserId[];
    readonly resourceKind: "channel" | "topic";
    readonly resourceId: string;
    readonly auditId: string;
  },
) {
  for (const recipientUserId of [...new Set(input.managerIds)].sort()) {
    if (recipientUserId === input.actorUserId) continue;
    const id = createId("teamNotice");
    const inserted = await transaction
      .insertInto("teamNotices")
      .values({
        id,
        recipientUserId,
        kind: "admin-self-added",
        resourceKind: input.resourceKind,
        resourceId: input.resourceId,
        auditId: input.auditId,
        dedupeKey: `${input.auditId}:${input.resourceKind}:${input.resourceId}`,
        createdAt: new Date(),
        readAt: null,
      })
      .onConflict((conflict) => conflict.columns(["recipientUserId", "dedupeKey"]).doNothing())
      .returning("id")
      .executeTakeFirst();
    if (inserted)
      await transaction
        .insertInto("teamOutbox")
        .values({
          kind: "notice",
          channelId: null,
          messageId: null,
          noticeId: id,
          createdAt: new Date(),
        })
        .execute();
  }
}

export class TeamNoticesStore {
  readonly database: Kysely<DatabaseSchema>;
  constructor(database: Kysely<DatabaseSchema>) {
    this.database = database;
  }
  async page(userId: UserId, before?: string) {
    let query = this.database
      .selectFrom("teamNotices")
      .selectAll()
      .where("recipientUserId", "=", userId);
    if (before) query = query.where("id", "<", before as ReturnType<typeof createId<"teamNotice">>);
    const rows = await query.orderBy("id", "desc").limit(51).execute();
    return {
      notices: rows
        .slice(0, 50)
        .map((row) =>
          TeamNoticeSchema.strip().parse({
            ...row,
            createdAt: row.createdAt.toISOString(),
            readAt: row.readAt?.toISOString() ?? null,
          }),
        ),
      hasMore: rows.length > 50,
    };
  }
  async markRead(userId: UserId, id: ReturnType<typeof createId<"teamNotice">>) {
    await this.database
      .updateTable("teamNotices")
      .set({ readAt: new Date() })
      .where("id", "=", id)
      .where("recipientUserId", "=", userId)
      .where("readAt", "is", null)
      .execute();
  }
}
