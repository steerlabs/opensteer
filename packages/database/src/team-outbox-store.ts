import { createHash } from "node:crypto";
import { NotificationIdSchema, type TeamChannelId, type UserId } from "@opensteer/core";
import { type Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { TeamAccessStore } from "./team-access-store.js";

export interface TeamPushDelivery {
  readonly notificationId: ReturnType<typeof NotificationIdSchema.parse>;
  readonly userId: UserId;
  readonly accountId: string;
  readonly kind: "team-message" | "team-agent-needs-you" | "team-agent-completed" | "team-notice";
  readonly channelId: TeamChannelId | null;
  readonly messageId: import("@opensteer/core").TeamMessageId | null;
  readonly noticeId: import("@opensteer/core").TeamNoticeId | null;
  readonly occurredAt: Date;
  readonly title: string;
  readonly body: string;
}
export class TeamOutboxStore {
  readonly access: TeamAccessStore;
  readonly visible: (userId: UserId, channelId: TeamChannelId) => boolean;
  constructor(
    access: TeamAccessStore,
    visible: (userId: UserId, channelId: TeamChannelId) => boolean = () => false,
  ) {
    this.access = access;
    this.visible = visible;
  }
  async drain(publish: (delivery: TeamPushDelivery) => Promise<void>) {
    return this.access.database.transaction().execute(async (t) => {
      await t
        .selectFrom("teamAccessState")
        .select("revision")
        .where("singletonKey", "=", "team")
        .forShare()
        .executeTakeFirstOrThrow();
      const rows = await t
        .selectFrom("teamOutbox")
        .selectAll()
        .orderBy("id")
        .limit(16)
        // FOR UPDATE: This worker deletes each claimed outbox row.
        .forUpdate()
        .skipLocked()
        .execute();
      for (const row of rows) {
        if (Date.now() - row.createdAt.getTime() < 15 * 60000) {
          const recipients = await this.#recipients(t, row);
          for (let offset = 0; offset < recipients.length; offset += 8) {
            const results = await Promise.allSettled(
              recipients.slice(offset, offset + 8).map(publish),
            );
            const failed = results.filter((result) => result.status === "rejected");
            if (failed.length)
              throw new AggregateError(
                failed.map((result) => result.reason),
                "Team push batch failed",
              );
          }
        }
        await t.deleteFrom("teamOutbox").where("id", "=", row.id).execute();
      }
      return rows.length;
    });
  }
  async #recipients(
    t: Transaction<DatabaseSchema>,
    row: import("kysely").Selectable<import("./schema.js").TeamOutboxTable>,
  ): Promise<TeamPushDelivery[]> {
    const accounts = await t
      .selectFrom("teamMembers as m")
      .innerJoin("authAccounts as a", "a.userId", "m.userId")
      .innerJoin("accountDirectoryProvider as p", "p.providerId", "a.providerId")
      .select(["m.userId", "a.accountId"])
      .where("m.state", "=", "active")
      .execute();
    const deliveries: TeamPushDelivery[] = [];
    const notice = row.noticeId
      ? await t
          .selectFrom("teamNotices")
          .selectAll()
          .where("id", "=", row.noticeId)
          .where("readAt", "is", null)
          .executeTakeFirst()
      : null;
    const message = row.messageId
      ? await t
          .selectFrom("teamMessages")
          .selectAll()
          .where("id", "=", row.messageId)
          .where("deletedAt", "is", null)
          .executeTakeFirst()
      : null;
    const channel = row.channelId
      ? await t
          .selectFrom("teamChannels")
          .selectAll()
          .where("id", "=", row.channelId)
          .executeTakeFirst()
      : null;
    for (const account of accounts) {
      let kind: TeamPushDelivery["kind"] = "team-message";
      let title = channel?.name ?? "Opensteer";
      let body = message?.plainText ?? "An administrator added themselves to a restricted resource";
      if (notice) {
        if (notice.recipientUserId !== account.userId) continue;
        kind = "team-notice";
      } else if (message && channel) {
        if (
          this.visible(account.userId, channel.id) ||
          !(await this.access.channel(t, { kind: "human", userId: account.userId }, channel.id))
            .read
        )
          continue;
        const state = await t
          .selectFrom("teamChannelMemberState")
          .selectAll()
          .where("channelId", "=", channel.id)
          .where("userId", "=", account.userId)
          .executeTakeFirst();
        if (
          state?.notificationLevel === "muted" ||
          (row.kind !== "agent-status" &&
            state?.lastReadMessageId &&
            BigInt(state.lastReadMessageId) >= BigInt(message.id))
        )
          continue;
        const mentions = await t
          .selectFrom("teamMentions")
          .select("targetUserId")
          .where("messageId", "=", message.id)
          .where("targetKind", "=", "person")
          .where("targetUserId", "=", account.userId)
          .executeTakeFirst();
        if (row.kind === "agent-status") {
          const request = await t
            .selectFrom("teamAgentRequests")
            .selectAll()
            .where("triggerMessageId", "=", message.id)
            .where("ownerUserId", "=", account.userId)
            .executeTakeFirst();
          if (!request || request.state === "working" || request.state === "queued") continue;
          kind = request.state === "needs_you" ? "team-agent-needs-you" : "team-agent-completed";
          body = request.state === "needs_you" ? "Your agent needs you" : "Your agent finished";
        } else {
          if (message.authorKind === "human" && message.authorUserId === account.userId) continue;
          if (message.authorKind === "agent" && message.authorUserId === account.userId)
            kind = "team-agent-completed";
          let followed = false;
          if (message.threadRootId)
            followed = !!(await t
              .selectFrom("teamMessages")
              .select("id")
              .where((e) =>
                e.or([
                  e("id", "=", message.threadRootId!),
                  e("threadRootId", "=", message.threadRootId!),
                ]),
              )
              .where((e) =>
                e.or([
                  e("authorUserId", "=", account.userId),
                  e.exists(
                    e
                      .selectFrom("teamMentions as n")
                      .select("n.messageId")
                      .whereRef("n.messageId", "=", "teamMessages.id")
                      .where("n.targetKind", "=", "person")
                      .where("n.targetUserId", "=", account.userId),
                  ),
                ]),
              )
              .where("deletedAt", "is", null)
              .executeTakeFirst());
          if (
            !mentions &&
            !followed &&
            state?.notificationLevel !== "all" &&
            !(state === undefined && (channel.kind === "dm" || channel.kind === "group_dm")) &&
            !(message.authorKind === "agent" && message.authorUserId === account.userId)
          )
            continue;
        }
      } else continue;
      const hash = createHash("sha256").update(`${row.id}:${account.userId}:${kind}`).digest("hex");
      const uuid = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
      deliveries.push({
        notificationId: NotificationIdSchema.parse(`ntf_${uuid}`),
        userId: account.userId,
        accountId: account.accountId,
        kind,
        channelId: row.channelId,
        messageId: row.messageId,
        noticeId: row.noticeId,
        occurredAt: row.createdAt,
        title: title.slice(0, 120),
        body: (body || "New team activity").slice(0, 180),
      });
    }
    return deliveries;
  }
}
