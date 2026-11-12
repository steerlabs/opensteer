import { randomUUID } from "node:crypto";
import { plainTextExcerpt } from "@opensteer/shared/plainTextExcerpt";
import {
  TeamStatusStepSchema,
  type TeamAgentRequestId,
  type TeamLinkId,
  type TeamMessageId,
} from "@opensteer/core";
import { TeamMarkdownSchema, TeamRequestContextSchema } from "@opensteer/protocol";
import { sql, type Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import type { TeamRequestStorePort } from "./team-requests-port.js";
import {
  TeamAccessStore,
  bumpTeamChannel,
  requireTeam,
  lockTeamMessages,
} from "./team-access-store.js";
import { TeamChatStore, teamRequestView, teamMessageViews } from "./team-chat-store.js";

export class TeamRequestsStore implements TeamRequestStorePort {
  readonly access: TeamAccessStore;
  readonly chat: TeamChatStore;
  constructor(access: TeamAccessStore, chat: TeamChatStore) {
    this.access = access;
    this.chat = chat;
  }
  async #record(
    transaction: Transaction<DatabaseSchema>,
    linkId: TeamLinkId,
    id: TeamAgentRequestId,
    receipt = false,
    queued = false,
  ) {
    const row = await transaction
      .selectFrom("teamAgentRequests as r")
      .innerJoin("teamLinks as l", "l.id", "r.linkId")
      .innerJoin("teamMembers as m", "m.userId", "r.ownerUserId")
      .selectAll("r")
      .where("r.id", "=", id)
      .where("r.linkId", "=", linkId)
      .where("l.state", "=", "active")
      .where("m.state", "=", "active")
      .executeTakeFirst();
    requireTeam(row, "Request unavailable");
    if (receipt) {
      requireTeam(row.state === "done" && row.replyMessageId !== null, "No completed reply");
      return row;
    }
    requireTeam(
      (queued && row.state === "queued") || row.state === "working" || row.state === "needs_you",
      "Request is terminal or has not been accepted",
    );
    requireTeam(row.expiresAt === null || row.expiresAt > new Date(), "Request expired");
    const authority = await this.access.channel(
      transaction,
      { kind: "agent", userId: row.ownerUserId },
      row.channelId,
    );
    requireTeam(authority.read && authority.post, "Request access revoked");
    return row;
  }
  async authorize(
    linkId: TeamLinkId,
    id: TeamAgentRequestId,
    _action: "read" | "post" | "knowledge" | "status",
  ) {
    await this.expire(id);
    const revision = this.access.revision;
    const request = await this.access.database
      .transaction()
      .execute(async (t) => teamRequestView(await this.#record(t, linkId, id)));
    return this.access.handoff(
      revision,
      () =>
        this.access.database.transaction().execute(async (t) => {
          await this.#record(t, linkId, id);
          return true;
        }),
      () => request,
    );
  }
  async pending(linkId: TeamLinkId) {
    await this.expire();
    const revision = this.access.revision;
    const result = await this.access.database.transaction().execute(async (t) => {
      const link = await t
        .selectFrom("teamLinks")
        .selectAll()
        .where("id", "=", linkId)
        .where("state", "=", "active")
        .executeTakeFirst();
      requireTeam(link);
      await this.access.member(t, link.ownerUserId);
      const rows = await t
        .selectFrom("teamAgentRequests")
        .select("id")
        .where("linkId", "=", linkId)
        .where("state", "in", ["queued", "working", "needs_you"])
        .orderBy("createdAt")
        .orderBy("id")
        .limit(32)
        .execute();
      const requests = [];
      for (const { id } of rows) {
        const row = await this.#record(t, linkId, id, false, true);
        requests.push({
          request: teamRequestView(row),
          source: await this.chat.source(
            t,
            { kind: "agent", userId: row.ownerUserId },
            row.channelId,
            row.threadRootId,
            row.triggerMessageId,
          ),
        });
      }
      return requests;
    });
    return this.access.handoff(
      revision,
      () =>
        this.access.database.transaction().execute(async (t) => {
          for (const { request } of result) await this.#record(t, linkId, request.id, false, true);
          return true;
        }),
      () => result,
    );
  }
  async accept(linkId: TeamLinkId, id: TeamAgentRequestId) {
    const observed = await this.access.database
      .selectFrom("teamAgentRequests")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    const result = await this.access.contentWrite(
      { kind: "agent", userId: observed.ownerUserId },
      observed.channelId,
      async (t) => {
        const row = await this.#record(t, linkId, id, false, true);
        if (row.acceptedAt) return teamRequestView(row);
        await lockTeamMessages(t, [row.threadRootId]);
        const { changeSeq } = await bumpTeamChannel(t, row.channelId);
        const updated = await t
          .updateTable("teamAgentRequests")
          .set({
            state: "working",
            acceptedAt: sql`now()`,
            expiresAt: sql`now()+interval '7 days'`,
            changeSeq,
          })
          .where("id", "=", id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await t
          .updateTable("teamMessages")
          .set({ changeSeq })
          .where("id", "=", row.threadRootId)
          .execute();
        return teamRequestView(updated);
      },
    );
    this.chat.changed(observed.channelId);
    return result;
  }
  async context(linkId: TeamLinkId, id: TeamAgentRequestId) {
    const request = await this.authorize(linkId, id, "read");
    const actor = { kind: "agent" as const, userId: request.ownerUserId };
    return this.chat.read(actor, "context", request.channelId, async (t) => {
      await this.#record(t, linkId, id);
      const page = await this.chat.pageIn(
        t,
        actor,
        request.channelId,
        { direction: "newest" },
        request.threadRootId,
      );
      const source = await this.chat.source(
        t,
        actor,
        request.channelId,
        request.threadRootId,
        request.triggerMessageId,
      );
      const requiredRows = await t
        .selectFrom("teamMessages")
        .selectAll()
        .where("channelId", "=", request.channelId)
        .where("id", "in", [request.threadRootId, request.triggerMessageId])
        .execute();
      const required = await teamMessageViews(t, requiredRows);
      const merged = new Map(
        [...page.messages, ...required].map((m) => [m.id, { ...m, requests: [] }]),
      );
      const messages = [...merged.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      const protectedIds = new Set([request.threadRootId, request.triggerMessageId]);
      while (messages.length > 50 || Buffer.byteLength(JSON.stringify(messages)) > 32768) {
        const removable = messages.findIndex((m) => !protectedIds.has(m.id));
        if (removable >= 0) {
          messages.splice(removable, 1);
          continue;
        }
        const longest = [...messages].sort(
          (a, b) => b.bodyMarkdown.length - a.bodyMarkdown.length,
        )[0];
        requireTeam(
          longest && longest.bodyMarkdown.length > 128,
          "Request context metadata exceeds its byte bound",
        );
        longest.bodyMarkdown =
          Array.from(longest.bodyMarkdown)
            .slice(0, Math.floor(longest.bodyMarkdown.length / 2))
            .join("") + "\n\n[Excerpt; read the full message with team_read.]";
        longest.plainText = plainTextExcerpt(longest.bodyMarkdown, 32768) ?? "";
      }
      return TeamRequestContextSchema.parse({
        request,
        instructionsMarkdown: page.channel.instructionsMarkdown,
        messages,
        source,
        audience: source.audience,
      });
    });
  }
  async status(
    linkId: TeamLinkId,
    id: TeamAgentRequestId,
    input: Parameters<TeamRequestStorePort["status"]>[2],
  ) {
    const steps = TeamStatusStepSchema.array().max(8).parse(input.steps);
    const observed = await this.access.database
      .selectFrom("teamAgentRequests")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    await this.access.contentWrite(
      { kind: "agent", userId: observed.ownerUserId },
      observed.channelId,
      async (t) => {
        const current = await t
          .selectFrom("teamAgentRequests")
          .selectAll()
          .where("id", "=", id)
          .where("linkId", "=", linkId)
          .executeTakeFirstOrThrow();
        if (
          (current.state === input.state &&
            JSON.stringify(current.steps) === JSON.stringify(steps)) ||
          (input.state === "cancelled" && current.finishedAt !== null)
        ) {
          requireTeam(
            await t
              .selectFrom("teamLinks")
              .select("id")
              .where("id", "=", linkId)
              .where("state", "=", "active")
              .executeTakeFirst(),
          );
          return;
        }
        const row = await this.#record(t, linkId, id, false, input.state === "cancelled");
        await lockTeamMessages(t, [row.threadRootId]);
        const { changeSeq } = await bumpTeamChannel(t, row.channelId);
        const terminal = ["failed", "stopped", "cancelled"].includes(input.state);
        await t
          .updateTable("teamAgentRequests")
          .set({
            state: input.state,
            steps: sql`${JSON.stringify(steps)}::jsonb`,
            finishedAt: terminal ? new Date() : null,
            failureCode: input.state === "failed" ? "execution_failed" : null,
            changeSeq,
          })
          .where("id", "=", id)
          .execute();
        await t
          .updateTable("teamMessages")
          .set({ changeSeq })
          .where("id", "=", row.threadRootId)
          .execute();
        if (input.state === "needs_you" || terminal)
          await t
            .insertInto("teamOutbox")
            .values({
              kind: "agent-status",
              channelId: row.channelId,
              messageId: row.triggerMessageId,
              noticeId: null,
              createdAt: new Date(),
            })
            .execute();
      },
    );
    this.chat.changed(observed.channelId);
    if (["failed", "stopped", "cancelled"].includes(input.state))
      await this.chat.requestChanged({ kind: "cancelled", linkId, requestId: id });
  }
  async reply(
    linkId: TeamLinkId,
    id: TeamAgentRequestId,
    input: Parameters<TeamRequestStorePort["reply"]>[2],
  ) {
    const receipt = await this.receipt(linkId, id);
    if (receipt) return receipt;
    TeamMarkdownSchema.parse(input.bodyMarkdown);
    requireTeam(input.attachmentIds.length <= 10);
    const observed = await this.access.database
      .selectFrom("teamAgentRequests")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    const result = await this.access.contentWrite(
      { kind: "agent", userId: observed.ownerUserId },
      observed.channelId,
      async (t) => {
        const current = await t
          .selectFrom("teamAgentRequests")
          .selectAll()
          .where("id", "=", id)
          .executeTakeFirstOrThrow();
        if (current.state === "done")
          return (await this.#record(t, linkId, id, true)).replyMessageId!;
        const row = await this.#record(t, linkId, id);
        const sent = await this.chat.insert(
          t,
          { kind: "agent", userId: row.ownerUserId },
          {
            channelId: row.channelId,
            threadRootId: row.threadRootId,
            clientMessageId: randomUUID(),
            bodyMarkdown: input.bodyMarkdown,
            mentions: [],
            attachmentIds: input.attachmentIds,
            agentRequestId: id,
          },
        );
        await t
          .updateTable("teamAgentRequests")
          .set({
            state: "done",
            replyMessageId: sent.message.id,
            finishedAt: new Date(),
            changeSeq: sent.message.changeSeq,
          })
          .where("id", "=", id)
          .execute();
        return sent.message.id;
      },
    );
    this.chat.changed(observed.channelId);
    return result;
  }
  async receipt(linkId: TeamLinkId, id: TeamAgentRequestId): Promise<TeamMessageId | null> {
    const revision = this.access.revision;
    const receipt = await this.access.database.transaction().execute(async (t) => {
      const row = await t
        .selectFrom("teamAgentRequests")
        .selectAll()
        .where("id", "=", id)
        .where("linkId", "=", linkId)
        .executeTakeFirst();
      requireTeam(row);
      const link = await t
        .selectFrom("teamLinks")
        .select("id")
        .where("id", "=", linkId)
        .where("state", "=", "active")
        .executeTakeFirst();
      requireTeam(link);
      await this.access.member(t, row.ownerUserId);
      return row.state === "done" ? (await this.#record(t, linkId, id, true)).replyMessageId : null;
    });
    return this.access.handoff(
      revision,
      () =>
        this.access.database.transaction().execute(async (t) => {
          await this.#record(t, linkId, id, receipt !== null);
          return true;
        }),
      () => receipt,
    );
  }
  async cancel(linkId: TeamLinkId, id: TeamAgentRequestId) {
    await this.status(linkId, id, { state: "cancelled", steps: [] });
  }
  async expire(id?: TeamAgentRequestId) {
    let query = this.access.database
      .selectFrom("teamAgentRequests")
      .selectAll()
      .where("state", "in", ["working", "needs_you"])
      .where("expiresAt", "<=", new Date());
    if (id) query = query.where("id", "=", id);
    for (const observed of await query.orderBy("channelId").orderBy("id").execute()) {
      await this.access.contentWrite(
        { kind: "agent", userId: observed.ownerUserId },
        observed.channelId,
        async (t) => {
          const row = await t
            .selectFrom("teamAgentRequests")
            .selectAll()
            .where("id", "=", observed.id)
            .where("state", "in", ["working", "needs_you"])
            .where("expiresAt", "<=", new Date())
            .executeTakeFirst();
          if (!row) return;
          await lockTeamMessages(t, [row.threadRootId]);
          const { changeSeq } = await bumpTeamChannel(t, row.channelId);
          await t
            .updateTable("teamAgentRequests")
            .set({ state: "failed", failureCode: "expired", finishedAt: new Date(), changeSeq })
            .where("id", "=", row.id)
            .execute();
          await t
            .updateTable("teamMessages")
            .set({ changeSeq })
            .where("id", "=", row.threadRootId)
            .execute();
        },
      );
      this.chat.changed(observed.channelId);
      await this.chat.requestChanged({
        kind: "cancelled",
        linkId: observed.linkId,
        requestId: observed.id,
      });
    }
  }
}
