import { randomUUID } from "node:crypto";
import {
  TeamStatusStepSchema,
  type TeamAgentRequestId,
  type TeamLinkId,
  type TeamMessageId,
} from "@opensteer/core";
import { TeamRequestContextSchema } from "@opensteer/protocol";
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
      await this.access.link(t, { kind: "agent", userId: link.ownerUserId }, linkId);
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
        const row = await this.#record(t, linkId, id, true);
        const triggerRow = await t
          .selectFrom("teamMessages")
          .selectAll()
          .where("id", "=", row.triggerMessageId)
          .where("channelId", "=", row.channelId)
          .executeTakeFirstOrThrow();
        const trigger = (await teamMessageViews(t, [triggerRow]))[0]!;
        requests.push({
          bodyMarkdown: trigger.bodyMarkdown,
          attachments: trigger.attachments,
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
          for (const { request } of result) await this.#record(t, linkId, request.id, true);
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
        const row = await this.#record(t, linkId, id, true);
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
    return this.chat.read(
      actor,
      "context",
      request.channelId,
      async (t) => {
        await this.#record(t, linkId, id);
        const channel = await this.chat.channelView(t, actor, request.channelId);
        const source = await this.chat.source(
          t,
          actor,
          request.channelId,
          request.threadRootId,
          request.triggerMessageId,
        );
        return TeamRequestContextSchema.parse({
          request,
          instructionsMarkdown: channel.instructionsMarkdown,
          instructionsRevision: channel.instructionsRevision,
          source,
          audience: source.audience,
        });
      },
      linkId,
    );
  }
  async status(
    linkId: TeamLinkId,
    id: TeamAgentRequestId,
    input: Parameters<TeamRequestStorePort["status"]>[2],
  ) {
    const steps = TeamStatusStepSchema.array().max(8).parse(input.steps);
    const terminal = ["done", "failed", "stopped", "cancelled"].includes(input.state);
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
          (terminal && current.finishedAt !== null)
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
        const row = await this.#record(t, linkId, id, input.state === "cancelled");
        await lockTeamMessages(t, [row.threadRootId]);
        const { changeSeq } = await bumpTeamChannel(t, row.channelId);
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
  async post(linkId: TeamLinkId, input: Parameters<TeamRequestStorePort["post"]>[1]) {
    requireTeam(!input.publication || input.requestId, "Publication requires a request");
    const link = await this.access.database
      .selectFrom("teamLinks")
      .selectAll()
      .where("id", "=", linkId)
      .executeTakeFirstOrThrow();
    const actor = { kind: "agent" as const, userId: link.ownerUserId };
    const result = await this.access.contentWrite(actor, input.channelId, async (t, authority) => {
      await this.access.link(t, actor, linkId);
      requireTeam(authority.post);
      const request = input.requestId
        ? await t
            .selectFrom("teamAgentRequests")
            .selectAll()
            .where("id", "=", input.requestId)
            .where("linkId", "=", linkId)
            .where("ownerUserId", "=", actor.userId)
            .executeTakeFirst()
        : undefined;
      if (input.requestId) {
        requireTeam(
          request &&
            request.channelId === input.channelId &&
            request.threadRootId === input.threadRootId,
          "Reply destination does not match request",
        );
        if (input.publication && request.replyMessageId) return request.replyMessageId;
        if (!request.replyMessageId) await this.#record(t, linkId, request.id);
      }
      const existing = await t
        .selectFrom("teamMessages")
        .selectAll()
        .where("channelId", "=", input.channelId)
        .where("authorUserId", "=", actor.userId)
        .where("authorKind", "=", "agent")
        .where("clientMessageId", "=", input.clientMessageId)
        .executeTakeFirst();
      if (existing) {
        requireTeam(
          existing.threadRootId === (input.threadRootId ?? null) &&
            (existing.agentRequestId === null ||
              existing.agentRequestId === (input.requestId ?? null)),
          "Post identity names another destination",
        );
        return existing.id;
      }
      const sent = await this.chat.insert(t, actor, {
        channelId: input.channelId,
        threadRootId: input.threadRootId ?? null,
        clientMessageId: input.clientMessageId,
        bodyMarkdown: input.bodyMarkdown,
        attachmentIds: input.attachmentIds,
        mentions: [],
        linkId,
        ...(input.runId
          ? { agent: { runId: input.runId, operationId: input.clientMessageId } }
          : {}),
        ...(request && request.replyMessageId === null ? { agentRequestId: request.id } : {}),
      });
      if (request && request.replyMessageId === null) {
        await t
          .updateTable("teamAgentRequests")
          .set({
            replyMessageId: sent.message.id,
            changeSeq: sent.message.changeSeq,
          })
          .where("id", "=", request.id)
          .where("replyMessageId", "is", null)
          .execute();
      }
      return sent.message.id;
    });
    this.chat.changed(input.channelId);
    return result;
  }
  async reply(
    linkId: TeamLinkId,
    id: TeamAgentRequestId,
    input: Parameters<TeamRequestStorePort["reply"]>[2],
  ) {
    const request = await this.access.database
      .selectFrom("teamAgentRequests")
      .selectAll()
      .where("id", "=", id)
      .where("linkId", "=", linkId)
      .executeTakeFirstOrThrow();
    return this.post(linkId, {
      ...input,
      requestId: id,
      channelId: request.channelId,
      threadRootId: request.threadRootId,
      clientMessageId: randomUUID(),
      publication: true,
    });
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
      return row.replyMessageId;
    });
    return this.access.handoff(
      revision,
      () =>
        this.access.database.transaction().execute(async (t) => {
          const link = await t
            .selectFrom("teamLinks")
            .select("ownerUserId")
            .where("id", "=", linkId)
            .where("state", "=", "active")
            .executeTakeFirst();
          requireTeam(link);
          await this.access.member(t, link.ownerUserId);
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
