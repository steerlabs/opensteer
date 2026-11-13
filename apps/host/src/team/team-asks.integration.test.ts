import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createId, type TeamActor } from "@opensteer/core";
import { sql } from "kysely";
import { createTeamKnowledgeFixture } from "@opensteer/database/test-support/team-knowledge";
import { TeamAccessStore } from "@opensteer/database/team-access";
import { TeamChatStore } from "@opensteer/database/team-chat";
import { TeamFilesStore } from "@opensteer/database/team-files";
import { TeamRequestsStore } from "@opensteer/database/team-requests";

describe("consent-gated team asks", () => {
  let fixture: Awaited<ReturnType<typeof createTeamKnowledgeFixture>>;
  let access: TeamAccessStore;
  let chat: TeamChatStore;
  let requests: TeamRequestsStore;
  let asker: TeamActor;
  beforeEach(async () => {
    fixture = await createTeamKnowledgeFixture();
    access = new TeamAccessStore(fixture.database);
    await access.initialize();
    chat = new TeamChatStore(access, { teamId: fixture.deploymentId, teamName: "Acme" });
    requests = new TeamRequestsStore(access, chat);
    asker = { kind: "human", userId: fixture.userId };
  });
  afterEach(async () => {
    await fixture?.close();
  });
  async function setup() {
    const targetId = await fixture.member("Alex");
    const target = { kind: "human" as const, userId: targetId };
    const channel = await fixture.channel({
      name: "asks",
      kind: "private",
      access: [
        { userId: asker.userId, level: "post", manage: true },
        { userId: targetId, level: "post" },
      ],
    });
    const targetLink = await fixture.link(targetId);
    const askerLink = await fixture.link(asker.userId);
    return { target, channelId: channel.channelId, targetLink, askerLink };
  }
  function humanSend(
    channelId: Parameters<TeamChatStore["send"]>[1]["channelId"],
    bodyMarkdown = "@alex-agent help",
  ) {
    return chat.send(asker, {
      channelId,
      threadRootId: null,
      clientMessageId: randomUUID(),
      bodyMarkdown,
      mentions: [],
      attachmentIds: [],
    });
  }
  function agentPost(
    channelId: Parameters<TeamRequestsStore["post"]>[1]["channelId"],
    linkId: Parameters<TeamRequestsStore["post"]>[0],
  ) {
    return requests.post(linkId, {
      channelId,
      runId: createId("run"),
      clientMessageId: randomUUID(),
      bodyMarkdown: "@alex-agent help from my agent",
      attachmentIds: [],
    });
  }
  it("resolves human text on the Host and never executes before explicit approval", async () => {
    const { channelId, targetLink } = await setup();
    const sent = await chat.send(asker, {
      channelId,
      threadRootId: null,
      clientMessageId: randomUUID(),
      bodyMarkdown: "@alex-agent help",
      mentions: [],
      attachmentIds: [],
    });
    const pending = await requests.pending(targetLink);
    expect(pending).toHaveLength(1);
    const ask = pending[0]!;
    expect(ask.request).toMatchObject({
      kind: "ask",
      state: "awaiting_approval",
      triggerMessageId: sent.message.id,
    });
    expect(ask.presentation).toMatchObject({
      asker: { teamUserId: asker.userId, actor: "human", displayName: "Maya" },
      bodyMarkdown: "@alex-agent help",
    });
    await expect(requests.accept(targetLink, ask.request.id)).rejects.toThrow();
    await expect(requests.context(targetLink, ask.request.id)).rejects.toThrow();
    await expect(
      requests.reply(targetLink, ask.request.id, { bodyMarkdown: "early", attachmentIds: [] }),
    ).rejects.toThrow();
    const approved = await requests.accept(targetLink, ask.request.id, "approve");
    expect(approved.state).toBe("working");
    expect(await requests.accept(targetLink, ask.request.id, "approve")).toEqual(approved);
    await expect(requests.accept(targetLink, ask.request.id, "decline")).rejects.toThrow();
  });
  it("ignores forged mention ids and keeps self mentions and sticky recipients owner-only", async () => {
    const { channelId, target, targetLink, askerLink } = await setup();
    await chat.send(asker, {
      channelId,
      threadRootId: null,
      clientMessageId: randomUUID(),
      bodyMarkdown: "hello",
      mentions: [{ kind: "agent", userId: target.userId }],
      attachmentIds: [],
    });
    expect(await requests.pending(targetLink)).toHaveLength(0);
    const own = await humanSend(channelId, "@maya-agent help");
    expect(own.wake).toBe("queued");
    expect((await requests.pending(askerLink))[0]?.request.kind).toBe("self");
    await humanSend(channelId);
    expect((await chat.agentRecipient(asker, channelId, own.message.id)).enabled).toBe(true);
    expect(
      await fixture.database
        .selectFrom("teamAgentRecipients")
        .selectAll()
        .where("userId", "=", target.userId)
        .execute(),
    ).toHaveLength(0);
  });
  it("creates agent asks, returns the first claimed answer once, and consumes returns without recursion", async () => {
    const { channelId, targetLink, askerLink } = await setup();
    const triggerId = await agentPost(channelId, askerLink);
    const ask = (await requests.pending(targetLink))[0]!;
    expect(ask.presentation?.asker.actor).toBe("agent");
    const trigger = await fixture.database
      .selectFrom("teamMessages")
      .selectAll()
      .where("id", "=", triggerId)
      .executeTakeFirstOrThrow();
    await requests.accept(targetLink, ask.request.id, "approve");
    const reply = await requests.reply(targetLink, ask.request.id, {
      bodyMarkdown: "@maya-agent @alex-agent answer",
      attachmentIds: [],
    });
    expect(
      await requests.reply(targetLink, ask.request.id, {
        bodyMarkdown: "retry",
        attachmentIds: [],
      }),
    ).toBe(reply);
    await requests.status(targetLink, ask.request.id, { state: "done", steps: [] });
    const returned = (await requests.pending(askerLink))[0]!;
    expect(returned.returnPayload).toMatchObject({
      originAskId: ask.request.id,
      resumeRunId: trigger.callerRunId,
      outcome: "answered",
      bodyMarkdown: "@maya-agent @alex-agent answer",
    });
    expect(returned.request.kind).toBe("return");
    expect(
      (await chat.page(asker, channelId, { direction: "newest" }, triggerId)).messages
        .flatMap((m) => m.requests)
        .every((r) => r.kind !== "return"),
    ).toBe(true);
    const cut = await chat.resume(asker, {
      subscriptionId: "asks",
      generation: 1,
      scope: { kind: "thread", channelId, rootId: triggerId },
      sinceSeq: null,
    });
    expect(cut.requests.every((r) => r.kind !== "return")).toBe(true);
    const accepted = await requests.accept(askerLink, returned.request.id);
    expect(accepted.state).toBe("done");
    expect(await requests.accept(askerLink, returned.request.id)).toEqual(accepted);
    expect(await requests.pending(askerLink)).toHaveLength(0);
    expect(
      await fixture.database.selectFrom("teamAgentRequests").selectAll().execute(),
    ).toHaveLength(2);
    await expect(requests.context(askerLink, returned.request.id)).rejects.toThrow();
    const audits = await fixture.database.selectFrom("teamAudit").select("action").execute();
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        "request.create",
        "request.decision.approve",
        "request.admit",
        "request.publish",
        "request.return.create",
        "request.return.deliver",
      ]),
    );
  });
  it("declines idempotently and reconciles terminal consent without approving it", async () => {
    const { channelId, targetLink, askerLink } = await setup();
    await agentPost(channelId, askerLink);
    const ask = (await requests.pending(targetLink))[0]!.request;
    const declined = await requests.accept(targetLink, ask.id, "decline");
    expect(declined.state).toBe("declined");
    expect(await requests.accept(targetLink, ask.id, "decline")).toEqual(declined);
    await expect(requests.accept(targetLink, ask.id, "approve")).rejects.toThrow();
    expect((await requests.pending(askerLink))[0]?.returnPayload?.outcome).toBe("declined");
    expect(await requests.reconcile(targetLink, [ask.id, createId("teamAgentRequest")])).toEqual([
      { requestId: ask.id, request: declined },
      expect.objectContaining({ request: null }),
    ]);
    expect(await requests.pending(targetLink)).toHaveLength(0);
  });
  it.each(["edit", "delete"])(
    "cancels unanswered awaiting and approved asks on message %s",
    async (operation) => {
      const { channelId, targetLink } = await setup();
      for (const approved of [false, true]) {
        const sent = await humanSend(channelId);
        const ask = (await requests.pending(targetLink)).find(
          (r) => r.request.triggerMessageId === sent.message.id,
        )!;
        if (approved) await requests.accept(targetLink, ask.request.id, "approve");
        await chat.editOrDelete(
          asker,
          channelId,
          sent.message.id,
          operation === "edit" ? { bodyMarkdown: "changed", mentions: [] } : null,
        );
        const row = await fixture.database
          .selectFrom("teamAgentRequests")
          .selectAll()
          .where("id", "=", ask.request.id)
          .executeTakeFirstOrThrow();
        expect(row).toMatchObject({
          state: "cancelled",
          failureCode: operation === "edit" ? "trigger_edited" : "trigger_deleted",
          presentation: ask.presentation,
        });
      }
      expect(await requests.pending(targetLink)).toHaveLength(0);
    },
  );
  it.each(["target", "requester"])(
    "cancels pending and working asks when %s loses authority",
    async (loser) => {
      const { channelId, target, targetLink } = await setup();
      await humanSend(channelId);
      await humanSend(channelId);
      const pending = await requests.pending(targetLink);
      await requests.accept(targetLink, pending[0]!.request.id, "approve");
      await chat.setAccess(asker, channelId, access.revision, [
        {
          subject: { kind: "person", userId: loser === "target" ? asker.userId : target.userId },
          level: "post",
          manage: true,
        },
      ]);
      const rows = await fixture.database
        .selectFrom("teamAgentRequests")
        .selectAll()
        .where("kind", "=", "ask")
        .execute();
      expect(rows.map((r) => r.state)).toEqual(["cancelled", "cancelled"]);
      expect(rows.every((r) => r.failureCode === "access_revoked")).toBe(true);
    },
  );
  it.each(["expired", "cancelled", "failed"] as const)(
    "creates exactly one private %s return",
    async (outcome) => {
      const { channelId, targetLink, askerLink } = await setup();
      await agentPost(channelId, askerLink);
      const ask = (await requests.pending(targetLink))[0]!.request;
      if (outcome === "expired") {
        await fixture.database
          .updateTable("teamAgentRequests")
          .set({ consentExpiresAt: new Date(Date.now() - 1) })
          .where("id", "=", ask.id)
          .execute();
        await requests.expire();
        await requests.expire();
        await expect(requests.accept(targetLink, ask.id, "approve")).rejects.toThrow();
      } else {
        await requests.accept(targetLink, ask.id, "approve");
        await requests.status(targetLink, ask.id, { state: outcome, steps: [] });
        await requests.status(targetLink, ask.id, { state: outcome, steps: [] });
      }
      const returns = await fixture.database
        .selectFrom("teamAgentRequests")
        .selectAll()
        .where("kind", "=", "return")
        .execute();
      expect(returns).toHaveLength(1);
      expect(returns[0]?.returnPayload).toMatchObject({
        originAskId: ask.id,
        outcome,
        bodyMarkdown: null,
        attachments: [],
      });
      expect((await requests.pending(askerLink))[0]?.request.id).toBe(returns[0]?.id);
    },
  );
  it("refuses people-only, missing-link and over-budget targets without dropping the message", async () => {
    const { channelId, target, targetLink, askerLink } = await setup();
    await chat.update(asker, channelId, { peopleOnly: true });
    const refused = await humanSend(channelId);
    expect(refused.askOutcomes).toEqual([{ ownerUserId: target.userId, outcome: "people-only" }]);
    expect(await requests.pending(targetLink)).toHaveLength(0);
    await chat.update(asker, channelId, { peopleOnly: false });
    for (let i = 0; i < 10; i++) {
      if (i % 2) await agentPost(channelId, askerLink);
      else await humanSend(channelId);
    }
    const limited = await humanSend(channelId);
    expect(limited.askOutcomes).toEqual([{ ownerUserId: target.userId, outcome: "rate-limited" }]);
    expect((await chat.message(asker, channelId, limited.message.id)).bodyMarkdown).toBe(
      "@alex-agent help",
    );
    for (let i = 10; i < 32; i++) {
      await fixture.database
        .updateTable("teamAgentRequests")
        .set({ createdAt: new Date(Date.now() - 120000) })
        .execute();
      await humanSend(channelId);
    }
    await fixture.database
      .updateTable("teamAgentRequests")
      .set({ createdAt: new Date(Date.now() - 120000) })
      .execute();
    expect((await humanSend(channelId)).askOutcomes).toEqual([
      { ownerUserId: target.userId, outcome: "rate-limited" },
    ]);
    await sql`update team_links set state='revoked',revoked_at=now() where id=${targetLink}`.execute(
      fixture.database,
    );
    expect((await humanSend(channelId)).askOutcomes).toEqual([
      { ownerUserId: target.userId, outcome: "no-link" },
    ]);
  });
  it("keeps per-target receipts on reply triggers and leaves answered asks intact on edit", async () => {
    const { channelId, target, targetLink } = await setup();
    const casey = await fixture.member("Casey");
    await chat.setAccess(asker, channelId, access.revision, [
      { subject: { kind: "person", userId: asker.userId }, level: "post", manage: true },
      { subject: { kind: "person", userId: target.userId }, level: "post", manage: false },
      { subject: { kind: "person", userId: casey }, level: "post", manage: false },
    ]);
    const root = await humanSend(channelId, "Root");
    const sent = await chat.send(asker, {
      channelId,
      threadRootId: root.message.id,
      clientMessageId: randomUUID(),
      bodyMarkdown: "@alex-agent @casey-agent help",
      mentions: [],
      attachmentIds: [],
    });
    expect(sent.askOutcomes).toEqual(
      expect.arrayContaining([
        { ownerUserId: target.userId, outcome: "queued" },
        { ownerUserId: casey, outcome: "no-link" },
      ]),
    );
    const ask = (await requests.pending(targetLink))[0]!.request;
    expect(
      (await chat.message(asker, channelId, sent.message.id)).requests.map((r) => r.id),
    ).toEqual([ask.id]);
    await requests.accept(targetLink, ask.id, "approve");
    const answerId = await requests.reply(targetLink, ask.id, {
      bodyMarkdown: "answer",
      attachmentIds: [],
    });
    await chat.editOrDelete(asker, channelId, sent.message.id, {
      bodyMarkdown: "edited after answer",
      mentions: [],
    });
    const refreshed = (await chat.message(asker, channelId, sent.message.id)).requests[0]!;
    expect(refreshed).toMatchObject({ state: "working", replyMessageId: answerId });
  });
  it("serializes conflicting owner decisions into one outcome", async () => {
    const { channelId, targetLink, askerLink } = await setup();
    await agentPost(channelId, askerLink);
    const ask = (await requests.pending(targetLink))[0]!.request;
    const outcomes = await Promise.allSettled([
      requests.accept(targetLink, ask.id, "approve"),
      requests.accept(targetLink, ask.id, "decline"),
    ]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const row = await fixture.database
      .selectFrom("teamAgentRequests")
      .selectAll()
      .where("id", "=", ask.id)
      .executeTakeFirstOrThrow();
    expect(["working", "declined"]).toContain(row.state);
    expect(
      await fixture.database
        .selectFrom("teamAudit")
        .select("id")
        .where("action", "like", "request.decision.%")
        .execute(),
    ).toHaveLength(1);
  });
  it("terminalizes requester-side agent authority and keeps the undeliverable return terminal after access returns", async () => {
    const { channelId, target, targetLink, askerLink } = await setup();
    await agentPost(channelId, askerLink);
    const ask = (await requests.pending(targetLink))[0]!.request;
    await chat.setAccess(asker, channelId, access.revision, [
      { subject: { kind: "person", userId: target.userId }, level: "post", manage: true },
    ]);
    expect(await requests.pending(targetLink)).toHaveLength(0);
    expect(await requests.pending(askerLink)).toHaveLength(0);
    const returned = await fixture.database
      .selectFrom("teamAgentRequests")
      .selectAll()
      .where("kind", "=", "return")
      .executeTakeFirstOrThrow();
    expect(returned).toMatchObject({
      state: "cancelled",
      returnPayload: { originAskId: ask.id, outcome: "cancelled" },
    });
    await chat.setAccess(asker, channelId, access.revision, [
      { subject: { kind: "person", userId: asker.userId }, level: "post", manage: true },
      { subject: { kind: "person", userId: target.userId }, level: "post", manage: false },
    ]);
    await expect(requests.accept(askerLink, returned.id)).rejects.toThrow();
  });
  it("expires execution seven days after approval independently of the consent deadline", async () => {
    const { channelId, targetLink, askerLink } = await setup();
    await agentPost(channelId, askerLink);
    const ask = (await requests.pending(targetLink))[0]!.request;
    const approved = await requests.accept(targetLink, ask.id, "approve");
    expect(Date.parse(approved.expiresAt!) - Date.parse(approved.acceptedAt!)).toBe(7 * 86400000);
    await fixture.database
      .updateTable("teamAgentRequests")
      .set({
        acceptedAt: sql`now()-interval '8 days'`,
        expiresAt: sql`now()-interval '1 day'`,
      })
      .where("id", "=", ask.id)
      .execute();
    await requests.expire();
    expect((await requests.pending(askerLink))[0]?.returnPayload?.outcome).toBe("expired");
  });
  it("excludes private returns from the shared creation budget", async () => {
    const { channelId, targetLink, askerLink } = await setup();
    for (let i = 0; i < 10; i++) await agentPost(channelId, askerLink);
    await fixture.database
      .updateTable("teamAgentRequests")
      .set({ createdAt: new Date(Date.now() - 120000) })
      .execute();
    for (const ask of await requests.pending(targetLink))
      await requests.accept(targetLink, ask.request.id, "decline");
    expect(await requests.pending(askerLink)).toHaveLength(10);
    expect((await humanSend(channelId)).askOutcomes).toEqual(
      expect.arrayContaining([expect.objectContaining({ outcome: "queued" })]),
    );
  });
  it("freezes attachment refs in consent and in the returned answer", async () => {
    const { channelId, target, targetLink, askerLink } = await setup();
    const files = new TeamFilesStore(access);
    async function attachment(actor: TeamActor, linkId: typeof askerLink) {
      const sha256 = "a".repeat(64);
      const upload = await files.begin(
        actor,
        channelId,
        {
          clientUploadId: randomUUID(),
          filename: "notes.txt",
          mediaType: "text/plain",
          sizeBytes: 1,
          sha256,
          previewSizeBytes: 0,
        },
        undefined,
        { linkId, runId: createId("run"), operationId: randomUUID() },
      );
      return files.complete(actor, upload.id, {
        receivedBytes: 1,
        sha256,
        verifiedType: "text/plain",
        previewMediaType: null,
        previewSizeBytes: 0,
        previewStorageKey: null,
      });
    }
    const incoming = await attachment({ ...asker, kind: "agent" }, askerLink);
    await requests.post(askerLink, {
      channelId,
      runId: createId("run"),
      clientMessageId: randomUUID(),
      bodyMarkdown: "@alex-agent review",
      attachmentIds: [incoming.id],
    });
    const ask = (await requests.pending(targetLink))[0]!;
    expect(ask.presentation?.attachments).toEqual([
      { id: incoming.id, filename: "notes.txt", mediaType: "text/plain", sizeBytes: 1 },
    ]);
    await requests.accept(targetLink, ask.request.id, "approve");
    const outgoing = await attachment({ ...target, kind: "agent" }, targetLink);
    await requests.reply(targetLink, ask.request.id, {
      bodyMarkdown: "reviewed",
      attachmentIds: [outgoing.id],
    });
    const returned = (await requests.pending(askerLink))[0]!;
    expect(returned.returnPayload?.attachments).toEqual([
      { id: outgoing.id, filename: "notes.txt", mediaType: "text/plain", sizeBytes: 1 },
    ]);
    expect(returned.attachments.map((a) => a.id)).toEqual([outgoing.id]);
  });
});
