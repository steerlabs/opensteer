import { withTimeout } from "../packages/shared/src/withTimeout.js";
import { startTeamKnowledge } from "../apps/host/src/knowledge/team-knowledge.js";
import { appendTeamAudit } from "../packages/database/src/team-audit-store.js";
import { needsYouPage } from "../packages/database/src/index.js";
import { TeamRunRequestSchema } from "../packages/protocol/src/index.js";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createId, SequenceSchema } from "../packages/core/src/index.js";
import { sharedFixture, sharedPersonalHost } from "./team-shares.test-support.js";
import { command } from "./team-partners.test-support.js";

it("admits a follower person's self and sticky wakes only at its authenticated relay", async () => {
  const f = await sharedFixture();
  try {
    const linkId = createId("teamLink");
    await f.b.database
      .insertInto("teamLinks")
      .values({
        id: linkId,
        ownerUserId: f.bUser,
        personalDeploymentId: createId("deployment"),
        installationLabel: "Bravo computer",
        state: "active",
        codeHash: randomUUID(),
        codeExpiresAt: new Date(),
        credentialHash: randomUUID(),
        lastSeenAt: null,
        createdAt: new Date(),
        revokedAt: null,
      })
      .execute();
    const send = (
      bodyMarkdown: string,
      threadRootId: import("../packages/core/src/index.js").TeamMessageId | null = null,
    ) =>
      command(f.bSession, {
        type: "team.message.send",
        channelId: f.bid,
        threadRootId,
        clientMessageId: randomUUID(),
        bodyMarkdown,
        mentions: [],
        attachmentIds: [],
      });
    const first = await send("@maya-2-agent help");
    expect(first.type === "team.message.send" && first.wake).toBe("queued");
    if (first.type !== "team.message.send") throw new Error("No relayed message");
    expect((await f.b.host.team.requests.pending(linkId)).map((r) => r.request.kind)).toEqual([
      "self",
    ]);
    const reply = await send("continue", first.message.id);
    expect(reply.type === "team.message.send" && reply.wake).toBe("queued");
    expect(await f.a.database.selectFrom("teamAgentRequests").select("id").execute()).toHaveLength(
      0,
    );
    const snapshot = await f.a.host.team.shares!.store.pull(f.aLink, {
      op: "pull",
      shareId: f.shareId,
      generation: 1,
      cursor: {
        created: SequenceSchema.parse("0"),
        sequence: SequenceSchema.parse("0"),
        publicId: "",
      },
    });
    const row = snapshot.rows[0]!;
    await expect(
      f.b.host.team.shares!.store.apply(
        f.bLink,
        f.shareId,
        1,
        {
          ...snapshot,
          rows: [
            {
              ...row,
              publicId: randomUUID(),
              clientMessageId: randomUUID(),
              bodyMarkdown: "@maya-2-agent forged",
            },
          ],
        },
        false,
      ),
    ).rejects.toThrow();
    expect(await f.b.host.team.requests.pending(linkId)).toHaveLength(2);

    const clientMessageId = randomUUID();
    const original = f.b.host.team.partners!.request.bind(f.b.host.team.partners!);
    const wire = vi
      .spyOn(f.b.host.team.partners!, "request")
      .mockImplementation(async (id, operation) => {
        const receipt = await original(id, operation);
        if (
          operation.op === "write" &&
          operation.write.action === "send" &&
          operation.write.clientMessageId === clientMessageId
        )
          throw new Error("Receipt lost after owner commit");
        return receipt;
      });
    await expect(
      command(f.bSession, {
        type: "team.message.send",
        channelId: f.bid,
        threadRootId: null,
        clientMessageId,
        bodyMarkdown: "@maya-2-agent receipt recovery",
        mentions: [],
        attachmentIds: [],
      }),
    ).rejects.toThrow();
    wire.mockRestore();
    await f.b.host.team.shares!.connected(f.bLink);
    expect(await f.b.host.team.requests.pending(linkId)).toHaveLength(3);
    await f.b.host.team.shares!.connected(f.bLink);
    expect(await f.b.host.team.requests.pending(linkId)).toHaveLength(3);
  } finally {
    await f.close();
  }
});

for (const direction of ["owner-to-follower", "follower-to-owner"] as const) {
  it(`relays a foreign human ask, bounded status and its approved answer (${direction})`, async () => {
    const f = await sharedFixture();
    try {
      const forward = direction === "owner-to-follower";
      const source = forward ? f.a : f.b,
        target = forward ? f.b : f.a;
      const session = forward ? f.aSession : f.bSession;
      const sourceChannel = forward ? f.aid : f.bid,
        targetChannel = forward ? f.bid : f.aid;
      const targetUser = forward ? f.bUser : f.aUser;
      const targetHandle = forward ? "maya-2" : "maya";
      const linkId = createId("teamLink");
      await target.database
        .insertInto("teamLinks")
        .values({
          id: linkId,
          ownerUserId: targetUser,
          personalDeploymentId: createId("deployment"),
          state: "active",
          codeHash: randomUUID(),
          codeExpiresAt: new Date(),
          credentialHash: randomUUID(),
        })
        .execute();
      const posted = await command(session, {
        type: "team.message.send",
        channelId: sourceChannel,
        threadRootId: null,
        clientMessageId: randomUUID(),
        bodyMarkdown: `@${targetHandle}-agent Check the project`,
        mentions: [],
        attachmentIds: [],
      });
      if (posted.type !== "team.message.send") throw new Error("No trigger");
      await vi.waitFor(
        async () =>
          expect(
            await target.host.team.requests.pending(linkId),
            "Target team never admitted the foreign ask",
          ).toHaveLength(1),
        { timeout: 5000 },
      );
      const ask = (await target.host.team.requests.pending(linkId))[0]!;
      await target.host.team.chat.update({ kind: "human", userId: targetUser }, targetChannel, {
        instructionsMarkdown: "Only our team's instructions",
      });
      await source.host.team.chat.update(
        { kind: "human", userId: forward ? f.aUser : f.bUser },
        sourceChannel,
        { instructionsMarkdown: "Other team's instructions" },
      );
      expect(ask.request).toMatchObject({
        kind: "ask",
        state: "awaiting_approval",
        channelId: targetChannel,
      });
      expect(ask.presentation?.asker).toMatchObject({
        displayName: "Maya",
        homeTeamName: forward ? "Alpha" : "Bravo",
      });
      expect(ask.source.audience.externalTeams).toEqual([
        { teamId: source.host.deployment.id, name: forward ? "Alpha" : "Bravo" },
      ]);
      await expect(target.host.team.requests.accept(linkId, ask.request.id)).rejects.toThrow();
      await target.host.team.requests.accept(linkId, ask.request.id, "approve");
      expect(
        (await target.host.team.requests.context(linkId, ask.request.id)).instructionsMarkdown,
      ).toBe("Only our team's instructions");
      const knowledge = await startTeamKnowledge({
        database: target.database,
        access: target.host.team.access,
        audit: appendTeamAudit,
      });
      const topics = await knowledge.topics({
        ownerUserId: targetUser,
        linkId,
        requestId: ask.request.id,
      });
      expect(topics.result.topics.length).toBeGreaterThan(0);
      expect(topics.result.topics.every((topic) => topic.roomCanRead === false)).toBe(true);

      await vi.waitFor(
        async () => {
          const view = await source.host.team.chat.message(
            { kind: "human", userId: forward ? f.aUser : f.bUser },
            sourceChannel,
            posted.message.id,
          );
          expect(view.requests, "Asker never saw the working state").toMatchObject([
            { state: "working", steps: [] },
          ]);
        },
        { timeout: 5000 },
      );
      await target.host.team.requests.reply(linkId, ask.request.id, {
        bodyMarkdown: "The project is ready",
        attachmentIds: [],
      });
      await target.host.team.requests.status(linkId, ask.request.id, {
        state: "done",
        steps: [{ kind: "read_files", count: 7 }],
      });
      await vi.waitFor(
        async () => {
          const view = await source.host.team.chat.message(
            { kind: "human", userId: forward ? f.aUser : f.bUser },
            sourceChannel,
            posted.message.id,
          );
          expect(view.requests, "Asker never saw the answer receipt").toMatchObject([
            { replyMessageId: expect.any(String), steps: [] },
          ]);
          const page = await source.host.team.chat.page(
            { kind: "human", userId: forward ? f.aUser : f.bUser },
            sourceChannel,
            { direction: "newest" },
            posted.message.id,
          );
          expect(page.messages.map((m) => m.bodyMarkdown)).toContain("The project is ready");
        },
        { timeout: 5000 },
      );
    } finally {
      await f.close();
    }
  });
}

it.each([true, false])(
  "binds a cross-team return to its own personal task after owner approval (forward=%s)",
  async (forward) => {
    const f = await sharedFixture();
    const source = forward ? f.a : f.b,
      target = forward ? f.b : f.a;
    const sourceUser = forward ? f.aUser : f.bUser,
      targetUser = forward ? f.bUser : f.aUser;
    const sourceChannel = forward ? f.aid : f.bid;
    const handle = forward ? "maya-2" : "maya";
    const peers: Awaited<ReturnType<typeof sharedPersonalHost>>[] = [];
    try {
      const alice = await sharedPersonalHost(source, sourceUser);
      peers.push(alice);
      const bob = await sharedPersonalHost(target, targetUser);
      peers.push(bob);
      const run = await alice.runs.startTask(alice.task.threadId, "Ask Bravo");
      const posted = await alice.tools.post(
        { runId: run.runId, operationId: "cross-team-ask" },
        source.host.deployment.id,
        {
          channelId: sourceChannel,
          bodyMarkdown: `@${handle}-agent Check the launch`,
          attachmentIds: [],
        },
      );
      await vi.waitFor(
        async () =>
          expect(
            await target.host.team.requests.pending(bob.linkId),
            "Foreign agent ask never reached Bravo",
          ).toHaveLength(1),
        { timeout: 5000 },
      );
      const ask = (await target.host.team.requests.pending(bob.linkId))[0]!;
      await bob.deliver();
      expect(await needsYouPage(bob.database, { userId: bob.owner.userId })).toMatchObject({
        count: 1,
        entries: [
          {
            kind: "team-ask",
            presentation: {
              asker: { homeTeamName: forward ? "Alpha" : "Bravo", actor: "agent" },
              audience: { externalTeams: [{ name: forward ? "Alpha" : "Bravo" }] },
            },
          },
        ],
      });
      expect(await bob.database.selectFrom("runs").select("id").execute()).toHaveLength(0);
      await bob.publisher.decide(
        bob.owner.userId,
        target.host.deployment.id,
        ask.request.id,
        "approve",
      );
      await bob.answer(ask.request.id, "The launch is ready");
      await vi.waitFor(
        async () =>
          expect(
            (await source.host.team.requests.pending(alice.linkId)).filter(
              (r) => r.request.kind === "return",
            ),
            "Return never reached the asking team",
          ).toHaveLength(1),
        { timeout: 5000 },
      );
      const returned = (await source.host.team.requests.pending(alice.linkId))[0]!;
      expect(returned.returnPayload).toMatchObject({
        resumeRunId: run.runId,
        originAskId: posted.askOutcomes?.[0]?.requestId,
        author: { teamUserId: posted.askOutcomes?.[0]?.ownerUserId, handle },
        outcome: "answered",
      });
      const forged = TeamRunRequestSchema.parse({
        ...returned,
        request: { ...returned.request, id: createId("teamAgentRequest") },
        returnPayload: { ...returned.returnPayload, resumeRunId: createId("run") },
      });
      await expect(alice.publisher.deliver(source.host.deployment.id, forged)).rejects.toThrow();
      expect(
        await alice.database
          .selectFrom("personalTeamRequests")
          .select("returnAdmission")
          .where("requestId", "=", forged.request.id)
          .executeTakeFirst(),
      ).toMatchObject({ returnAdmission: "undeliverable" });
      await alice.deliver();
      const inputs = await alice.database
        .selectFrom("threadInputs as i")
        .innerJoin("messages as m", "m.id", "i.messageId")
        .select(["i.threadId", "i.replyTarget", "m.content"])
        .where(
          "i.idempotencyKey",
          "=",
          `team-return:${source.host.deployment.id}:${posted.askOutcomes?.[0]?.requestId}`,
        )
        .execute();
      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toMatchObject({ threadId: alice.task.threadId, replyTarget: null });
      expect(JSON.stringify(inputs[0]!.content)).toContain("The launch is ready");
      await alice.publisher.deliver(source.host.deployment.id, returned);
      expect(
        await alice.database
          .selectFrom("threadInputs")
          .select("messageId")
          .where(
            "idempotencyKey",
            "=",
            `team-return:${source.host.deployment.id}:${posted.askOutcomes?.[0]?.requestId}`,
          )
          .execute(),
      ).toHaveLength(1);
    } finally {
      for (const peer of peers.reverse()) await peer.close();
      await f.close();
    }
  },
);

it.each(["edit", "delete", "disconnect", "remove", "remove-asker", "agents-off"] as const)(
  "terminalizes a pending cross-team ask on %s",
  async (operation) => {
    const f = await sharedFixture();
    try {
      const bob = await sharedPersonalHost(f.b, f.bUser);
      try {
        const sent = await command(f.aSession, {
          type: "team.message.send",
          channelId: f.aid,
          threadRootId: null,
          clientMessageId: randomUUID(),
          bodyMarkdown: "@maya-2-agent Check the project",
          mentions: [],
          attachmentIds: [],
        });
        if (sent.type !== "team.message.send") throw new Error("No trigger");
        await vi.waitFor(
          async () =>
            expect(
              await f.b.host.team.requests.pending(bob.linkId),
              "Bravo never received the ask",
            ).toHaveLength(1),
          { timeout: 5000 },
        );
        const ask = (await f.b.host.team.requests.pending(bob.linkId))[0]!;
        if (operation === "edit")
          await command(f.aSession, {
            type: "team.message.edit",
            channelId: f.aid,
            messageId: sent.message.id,
            bodyMarkdown: "Withdrawn",
            mentions: [],
          });
        if (operation === "delete")
          await command(f.aSession, {
            type: "team.message.delete",
            channelId: f.aid,
            messageId: sent.message.id,
          });
        if (operation === "disconnect")
          await command(f.bSession, { type: "team.share.end", shareId: f.shareId });
        if (operation === "agents-off")
          await command(f.bSession, {
            type: "team.share.agents.set",
            shareId: f.shareId,
            enabled: false,
          });
        if (operation === "remove-asker")
          await f.a.host.team.chat.setAccess(
            { kind: "human", userId: f.aUser },
            f.aid,
            f.a.host.team.access.revision,
            [],
          );
        if (operation === "remove") {
          const participants = await f.aSession.rpc["team.share.participants.get"]({
            channelId: f.aid,
          });
          if (!participants.ok) throw new Error("No participants");
          const target = participants.data.participants.find((p) => p.handle === "maya-2")!;
          await command(f.aSession, {
            type: "team.share.participant.remove",
            shareId: f.shareId,
            principalId: target.userId,
          });
        }
        await vi.waitFor(
          async () =>
            expect(
              await f.b.database
                .selectFrom("teamAgentRequests")
                .select(["state", "failureCode"])
                .where("id", "=", ask.request.id)
                .executeTakeFirst(),
              "Target ask never terminalized",
            ).toMatchObject({ state: "cancelled" }),
          { timeout: 5000 },
        );
        await vi.waitFor(
          async () =>
            expect(
              await f.a.database
                .selectFrom("teamRequestStatuses")
                .select("state")
                .where("triggerMessageId", "=", sent.message.id)
                .execute(),
              "Source ask status never terminalized",
            ).toMatchObject([{ state: "cancelled" }]),
          { timeout: 5000 },
        );
        if (operation === "agents-off") {
          const actor = { kind: "agent" as const, userId: f.bUser };
          await expect(f.b.host.team.chat.page(actor, f.bid)).rejects.toThrow();
          await expect(
            f.b.host.team.requests.post(bob.linkId, {
              channelId: f.bid,
              clientMessageId: randomUUID(),
              bodyMarkdown: "blocked",
              attachmentIds: [],
            }),
          ).rejects.toThrow();
          await command(f.bSession, {
            type: "team.share.agents.set",
            shareId: f.shareId,
            enabled: true,
          });
          expect((await f.b.host.team.chat.page(actor, f.bid)).channel.can.read).toBe(true);
          expect(await f.b.host.team.requests.pending(bob.linkId)).toHaveLength(0);
        }
      } finally {
        await bob.close();
      }
    } finally {
      await f.close();
    }
  },
);

it("enforces the target team's requester budget by foreign principal", async () => {
  const f = await sharedFixture();
  try {
    const bob = await sharedPersonalHost(f.b, f.bUser);
    try {
      for (let index = 0; index < 11; index++)
        await command(f.aSession, {
          type: "team.message.send",
          channelId: f.aid,
          threadRootId: null,
          clientMessageId: randomUUID(),
          bodyMarkdown: `@maya-2-agent Question ${index}`,
          mentions: [],
          attachmentIds: [],
        });
      await vi.waitFor(
        async () =>
          expect(
            await f.b.database
              .selectFrom("teamShareAsks")
              .select("id")
              .where("shareId", "=", f.shareId)
              .execute(),
            "Bravo never processed every ask reference",
          ).toHaveLength(11),
        { timeout: 5000 },
      );
      expect(await f.b.host.team.requests.pending(bob.linkId)).toHaveLength(10);
      expect(
        await f.b.database
          .selectFrom("teamShareAsks")
          .select("id")
          .where("outcome", "is not", null)
          .execute(),
      ).toHaveLength(1);
    } finally {
      await bob.close();
    }
  } finally {
    await f.close();
  }
});

it.each(["request", "link"] as const)(
  "cancels a follower agent's queued publication when its %s authority ends",
  async (removal) => {
    const f = await sharedFixture();
    const release = Promise.withResolvers<void>();
    try {
      const linkId = createId("teamLink");
      await f.b.database
        .insertInto("teamLinks")
        .values({
          id: linkId,
          ownerUserId: f.bUser,
          personalDeploymentId: createId("deployment"),
          state: "active",
          codeHash: randomUUID(),
          codeExpiresAt: new Date(),
          credentialHash: randomUUID(),
        })
        .execute();
      await command(f.bSession, {
        type: "team.message.send",
        channelId: f.bid,
        threadRootId: null,
        clientMessageId: randomUUID(),
        bodyMarkdown: "@maya-2-agent Help",
        mentions: [],
        attachmentIds: [],
      });
      const request = (await f.b.host.team.requests.pending(linkId))[0]!.request;
      await f.b.host.team.requests.accept(linkId, request.id);
      const entered = Promise.withResolvers<AbortSignal | undefined>();
      const original = f.b.host.team.partners!.request.bind(f.b.host.team.partners!);
      vi.spyOn(f.b.host.team.partners!, "request").mockImplementation(
        async (id, op, signal, handoff) => {
          if (op.op === "write") {
            entered.resolve(signal);
            await withTimeout(release.promise, 3000, {
              timeoutError: () => new Error("Publication barrier never released"),
            });
          }
          return original(id, op, signal, handoff);
        },
      );
      const posting = f.b.host.team.requests
        .post(linkId, {
          channelId: f.bid,
          threadRootId: request.threadRootId,
          requestId: request.id,
          clientMessageId: randomUUID(),
          bodyMarkdown: "Do not export cancelled publication",
          attachmentIds: [],
          publication: true,
        })
        .then(
          () => true,
          () => false,
        );
      const signal = await withTimeout(entered.promise, 2000, {
        timeoutError: () => new Error("Publication never reached the relay"),
      });
      if (removal === "request")
        await f.b.host.team.requests.status(linkId, request.id, { state: "cancelled", steps: [] });
      else await f.b.host.team.links.revoke({ kind: "human", userId: f.bUser }, linkId);
      expect(signal?.aborted).toBe(true);
      release.resolve();
      expect(
        await withTimeout(posting, 2000, {
          timeoutError: () => new Error("Revoked publication never settled"),
        }),
      ).toBe(false);
      expect(
        await f.a.database
          .selectFrom("teamMessages")
          .select("id")
          .where("channelId", "=", f.aid)
          .where("bodyMarkdown", "=", "Do not export cancelled publication")
          .execute(),
      ).toEqual([]);
    } finally {
      release.resolve();
      await f.close();
    }
  },
);
