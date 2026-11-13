import { randomUUID } from "node:crypto";
import {
  TeamStatusStepSchema,
  type TeamAgentRequestId,
  type TeamAskDecision,
  type TeamLinkId,
  type TeamMessageId,
} from "@opensteer/core";
import { TeamRequestContextSchema } from "@opensteer/protocol";
import { sql, type Transaction } from "kysely";
import { appendTeamAudit } from "./team-audit-store.js";
import { createTeamAskReturn } from "./team-request-returns.js";
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
  async #owned(
    transaction: Transaction<DatabaseSchema>,
    linkId: TeamLinkId,
    id: TeamAgentRequestId,
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
    const authority = await this.access.channel(
      transaction,
      { kind: "agent", userId: row.ownerUserId },
      row.channelId,
    );
    requireTeam(authority.read && authority.post, "Request access revoked");
    if (row.presentation) {
      const asker = row.presentation.asker;
      const rights = await this.access.channel(
        transaction,
        { kind: asker.actor, userId: asker.teamUserId },
        row.channelId,
      );
      requireTeam(rights.read && rights.post, "Asker access revoked");
    }
    return row;
  }
  async #record(
    transaction: Transaction<DatabaseSchema>,
    linkId: TeamLinkId,
    id: TeamAgentRequestId,
    queued = false,
  ) {
    const row = await this.#owned(transaction, linkId, id);
    requireTeam(row.kind !== "return", "Returns cannot authorize team work");
    requireTeam(
      (queued && row.state === "queued") || row.state === "working" || row.state === "needs_you",
      "Request is terminal or has not been accepted",
    );
    requireTeam(row.expiresAt === null || row.expiresAt > new Date(), "Request expired");
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
        .where("state", "in", ["awaiting_approval", "queued", "working", "needs_you"])
        .orderBy(sql`case when state in ('awaiting_approval','queued') then 0 else 1 end`)
        .orderBy("createdAt")
        .orderBy("id")
        .limit(200)
        .execute();
      const requests = [];
      for (const { id } of rows) {
        const row = await this.#owned(t, linkId, id);
        const triggerRow = await t
          .selectFrom("teamMessages")
          .selectAll()
          .where("id", "=", row.triggerMessageId)
          .where("channelId", "=", row.channelId)
          .executeTakeFirstOrThrow();
        const trigger = (await teamMessageViews(t, [triggerRow]))[0]!;
        let attachments = trigger.attachments;
        if (row.returnPayload) {
          const origin = await t
            .selectFrom("teamAgentRequests")
            .select("replyMessageId")
            .where("id", "=", row.returnPayload.originAskId)
            .executeTakeFirstOrThrow();
          const answer = origin.replyMessageId
            ? await t
                .selectFrom("teamMessages")
                .selectAll()
                .where("id", "=", origin.replyMessageId)
                .executeTakeFirst()
            : null;
          attachments = answer ? (await teamMessageViews(t, [answer]))[0]!.attachments : [];
        }
        requests.push({
          bodyMarkdown:
            row.kind === "return"
              ? (row.returnPayload!.bodyMarkdown ?? "")
              : (row.presentation?.bodyMarkdown ?? trigger.bodyMarkdown),
          attachments,
          request: teamRequestView(row),
          returnPayload: row.returnPayload,
          presentation: row.presentation,
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
          for (const { request } of result) await this.#owned(t, linkId, request.id);
          return true;
        }),
      () => result,
    );
  }
  async accept(linkId: TeamLinkId, id: TeamAgentRequestId, decision?: TeamAskDecision) {
    await this.expire(id);
    const observed = await this.access.database
      .selectFrom("teamAgentRequests")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    let changed = false;
    const result = await this.access.contentWrite(
      { kind: "agent", userId: observed.ownerUserId },
      observed.channelId,
      async (t) => {
        const row = await this.#owned(t, linkId, id);
        if (row.kind === "ask") {
          if (row.state === "declined" && decision === "decline") return teamRequestView(row);
          if (row.acceptedAt && decision !== "decline") return teamRequestView(row);
          requireTeam(
            row.state === "awaiting_approval" && decision !== undefined,
            "Explicit ask decision required",
          );
          requireTeam(row.consentExpiresAt && row.consentExpiresAt > new Date(), "Consent expired");
        } else {
          requireTeam(decision === undefined, "Only asks have decisions");
          if (row.kind === "return") {
            if (row.acceptedAt) return teamRequestView(row);
            requireTeam(row.state === "queued", "Return is terminal");
            const delivered = await t
              .updateTable("teamAgentRequests")
              .set({ state: "done", acceptedAt: sql`now()`, finishedAt: sql`now()` })
              .where("id", "=", id)
              .returningAll()
              .executeTakeFirstOrThrow();
            await appendTeamAudit(t, {
              actor: { kind: "agent", userId: row.ownerUserId },
              action: "request.return.deliver",
              resourceKind: "request",
              resourceId: id,
              requestId: id,
              linkId,
              channelId: row.channelId,
            });
            return teamRequestView(delivered);
          }
          await this.#record(t, linkId, id, true);
          if (row.acceptedAt) return teamRequestView(row);
        }
        await lockTeamMessages(t, [row.threadRootId, row.triggerMessageId]);
        const { changeSeq } = await bumpTeamChannel(t, row.channelId);
        changed = true;
        const declined = decision === "decline";
        const updated = await t
          .updateTable("teamAgentRequests")
          .set({
            state: declined ? "declined" : "working",
            acceptedAt: declined ? null : sql`now()`,
            expiresAt: declined ? null : sql`now()+interval '7 days'`,
            finishedAt: declined ? new Date() : null,
            changeSeq,
          })
          .where("id", "=", id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await t
          .updateTable("teamMessages")
          .set({ changeSeq })
          .where("id", "in", [row.threadRootId, row.triggerMessageId])
          .execute();
        if (declined) await createTeamAskReturn(t, row, "declined", changeSeq);
        await appendTeamAudit(t, {
          actor: { kind: "agent", userId: row.ownerUserId },
          action: row.kind === "ask" ? `request.decision.${decision}` : "request.admit",
          resourceKind: "request",
          resourceId: id,
          requestId: id,
          linkId,
          channelId: row.channelId,
        });
        if (row.kind === "ask" && !declined)
          await appendTeamAudit(t, {
            actor: { kind: "agent", userId: row.ownerUserId },
            action: "request.admit",
            resourceKind: "request",
            resourceId: id,
            requestId: id,
            linkId,
            channelId: row.channelId,
          });
        return teamRequestView(updated);
      },
    );
    if (changed) this.chat.changed(observed.channelId);
    if (changed && observed.kind === "ask")
      await this.chat.notifyRequests(observed.triggerMessageId);
    return result;
  }
  async reconcile(linkId: TeamLinkId, ids: readonly TeamAgentRequestId[]) {
    await this.expire();
    return this.access.database.transaction().execute(async (t) => {
      const link = await t
        .selectFrom("teamLinks")
        .select("ownerUserId")
        .where("id", "=", linkId)
        .executeTakeFirstOrThrow();
      await this.access.link(t, { kind: "agent", userId: link.ownerUserId }, linkId);
      const rows = ids.length
        ? await t
            .selectFrom("teamAgentRequests")
            .selectAll()
            .where("linkId", "=", linkId)
            .where("id", "in", [...ids])
            .execute()
        : [];
      const byId = new Map(rows.map((row) => [row.id, teamRequestView(row)]));
      return ids.map((requestId) => ({ requestId, request: byId.get(requestId) ?? null }));
    });
  }
  async context(linkId: TeamLinkId, id: TeamAgentRequestId) {
    const request = await this.authorize(linkId, id, "read");
    const actor = { kind: "agent" as const, userId: request.ownerUserId };
    return this.chat.read(
      actor,
      "context",
      request.channelId,
      async (t) => {
        const row = await this.#record(t, linkId, id);
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
          presentation: row.presentation,
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
        const row =
          current.kind === "ask" &&
          current.state === "awaiting_approval" &&
          input.state === "cancelled"
            ? await this.#owned(t, linkId, id)
            : await this.#record(t, linkId, id, input.state === "cancelled");
        await lockTeamMessages(t, [row.threadRootId, row.triggerMessageId]);
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
          .where("id", "in", [row.threadRootId, row.triggerMessageId])
          .execute();
        if (terminal)
          await createTeamAskReturn(
            t,
            row,
            input.state === "failed" || input.state === "done" ? "failed" : "cancelled",
            changeSeq,
          );
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
    await this.chat.notifyRequests(observed.triggerMessageId, true);
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
        publication: input.publication ?? false,
        deferAudit: true,
        statusMessageIds: request ? [request.triggerMessageId] : [],
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
      if (request && request.replyMessageId === null) {
        await t
          .updateTable("teamMessages")
          .set({ changeSeq: sent.message.changeSeq })
          .where("id", "=", request.triggerMessageId)
          .execute();
        await createTeamAskReturn(t, request, "answered", sent.message.changeSeq, sent.message.id);
        await appendTeamAudit(t, {
          actor,
          action: "request.publish",
          resourceKind: "request",
          resourceId: request.id,
          requestId: request.id,
          linkId,
          channelId: input.channelId,
        });
      }
      for (const outcome of sent.askOutcomes)
        await appendTeamAudit(t, {
          actor,
          action: "request.create",
          resourceKind: "message",
          resourceId: sent.message.id,
          channelId: input.channelId,
          outcome: outcome.outcome === "queued" ? "allowed" : "denied",
          metadata: outcome,
        });
      await appendTeamAudit(t, {
        actor,
        runId: input.runId,
        operationId: input.clientMessageId,
        action: "agent.post",
        metadata: { personalDeploymentId: link.personalDeploymentId },
        resourceKind: "message",
        resourceId: sent.message.id,
        linkId,
        channelId: input.channelId,
        requestId: input.requestId,
      });
      return sent.message.id;
    });
    this.chat.changed(input.channelId);
    await this.chat.notifyRequests(result);
    if (input.requestId) {
      const request = await this.access.database
        .selectFrom("teamAgentRequests")
        .select("triggerMessageId")
        .where("id", "=", input.requestId)
        .executeTakeFirstOrThrow();
      await this.chat.notifyRequests(request.triggerMessageId, true);
    }
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
      .where((e) =>
        e.or([
          e.and([e("state", "=", "awaiting_approval"), e("consentExpiresAt", "<=", new Date())]),
          e.and([e("state", "in", ["working", "needs_you"]), e("expiresAt", "<=", new Date())]),
        ]),
      );
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
            .where((e) =>
              e.or([
                e.and([
                  e("state", "=", "awaiting_approval"),
                  e("consentExpiresAt", "<=", new Date()),
                ]),
                e.and([
                  e("state", "in", ["working", "needs_you"]),
                  e("expiresAt", "<=", new Date()),
                ]),
              ]),
            )
            .executeTakeFirst();
          if (!row) return;
          await lockTeamMessages(t, [row.threadRootId, row.triggerMessageId]);
          const { changeSeq } = await bumpTeamChannel(t, row.channelId);
          await t
            .updateTable("teamAgentRequests")
            .set({ state: "failed", failureCode: "expired", finishedAt: new Date(), changeSeq })
            .where("id", "=", row.id)
            .execute();
          await t
            .updateTable("teamMessages")
            .set({ changeSeq })
            .where("id", "in", [row.threadRootId, row.triggerMessageId])
            .execute();
          await createTeamAskReturn(t, row, "expired", changeSeq);
        },
      );
      this.chat.changed(observed.channelId);
      await this.chat.notifyRequests(observed.triggerMessageId);
    }
  }
}
