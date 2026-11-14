import { sql } from "kysely";
import { withTimeout } from "../packages/shared/src/withTimeout.js";
import { once } from "node:events";
import {
  TeamChannelAccessSchema,
  teamPartnerMaxFrameBytes,
} from "../packages/protocol/src/index.js";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { sharedFixture } from "./team-shares.test-support.js";
import { teamCondition } from "./team-system.test-support.js";
import type { TeamShareBatch, TeamShareOperation } from "../packages/protocol/src/index.js";
import { createId, SequenceSchema, OpensteerError } from "../packages/core/src/index.js";
import {
  pairFixture,
  command,
  invite,
  redeem,
  list,
  active,
} from "./team-partners.test-support.js";

it("replicates existing history and relays text, threads, edits, mentions and pins between two real Hosts", async () => {
  const f = await pairFixture();
  try {
    await redeem(f.bSession, await invite(f.aSession));
    const link = (await list(f.aSession))[0]!;
    await command(f.aSession, { type: "team.partner.approve", linkId: link.id });
    await active(f.aSession, f.bSession);
    const aid = createId("teamChannel"),
      bid = createId("teamChannel");
    await command(f.aSession, {
      type: "team.channel.create",
      id: aid,
      kind: "private",
      name: "project",
      peopleOnly: false,
      access: [],
    });
    const first = await command(f.aSession, {
      type: "team.message.send",
      channelId: aid,
      threadRootId: null,
      clientMessageId: randomUUID(),
      bodyMarkdown: "History before sharing @maya",
      mentions: [],
      attachmentIds: [],
    });
    if (first.type !== "team.message.send") throw new Error("No initial message");
    const offered = await command(f.aSession, {
      type: "team.share.offer",
      channelId: aid,
      linkId: link.id,
      historyVisibleConfirmed: true,
    });
    if (offered.type !== "team.share.offer") throw new Error("No share");
    await command(f.bSession, {
      type: "team.share.accept",
      shareId: offered.shareId,
      id: bid,
      kind: "private",
      name: "external-project",
      peopleOnly: false,
      access: [],
    });
    const participants = await f.aSession.rpc["team.share.participants.get"]({
      channelId: aid,
      query: "maya",
    });
    expect(participants).toMatchObject({ ok: true });
    if (!participants.ok) throw new Error("No share roster");
    expect(participants.data.participants.map((p) => p.handle)).toEqual(["maya", "maya-2"]);
    expect(participants.data.people[f.aUser]).toBeUndefined();
    expect(Object.values(participants.data.people)).toEqual([
      expect.objectContaining({ handle: "maya-2", homeTeamName: "Bravo", external: true }),
    ]);
    const page = await f.bSession.rpc["team.messages.page"]({
      channelId: bid,
      page: { direction: "newest" },
    });
    expect(page.ok).toBe(true);
    if (!page.ok) throw new Error("No follower history");
    expect(page.data.messages.map((m) => m.bodyMarkdown)).toEqual(["History before sharing @maya"]);
    expect(page.data.people).toEqual(
      expect.objectContaining({
        [page.data.messages[0]!.authorUserId]: expect.objectContaining({
          homeTeamName: "Alpha",
          external: true,
        }),
      }),
    );
    const sidebar = await f.bSession.rpc["team.sidebar.get"]({});
    expect(sidebar.ok && sidebar.data.channels.find((r) => r.channel.id === bid)).toMatchObject({
      unread: false,
      mentionCount: 0,
      channel: { share: { state: "shared" } },
    });
    const before = await f.b.database
      .selectFrom("teamOutbox")
      .selectAll()
      .where("channelId", "=", bid)
      .execute();
    expect(before).toHaveLength(0);
    const accessRevision = f.b.host.team.access.revision;
    const posted = await command(f.bSession, {
      type: "team.message.send",
      channelId: bid,
      threadRootId: page.data.messages[0]!.id,
      clientMessageId: randomUUID(),
      bodyMarkdown: "Reply from Bravo @maya",
      mentions: [],
      attachmentIds: [],
    });
    if (posted.type !== "team.message.send") throw new Error("No relayed reply");
    expect(posted.message.authorUserId).toBe(f.bUser);
    expect(
      f.b.host.team.access.revision,
      "Content-only import invalidated unrelated team reads",
    ).toBe(accessRevision);
    const owner = await f.aSession.rpc["team.thread.page"]({
      channelId: aid,
      rootId: first.message.id,
      page: { direction: "newest" },
    });
    expect(owner.ok && owner.data.messages.map((m) => m.bodyMarkdown)).toEqual([
      "History before sharing @maya",
      "Reply from Bravo @maya",
    ]);
    await command(f.bSession, {
      type: "team.message.edit",
      channelId: bid,
      messageId: posted.message.id,
      bodyMarkdown: "Edited Bravo fox @maya",
      mentions: [],
    });
    await command(f.bSession, {
      type: "team.message.pin",
      channelId: bid,
      messageId: posted.message.id,
    });
    const pins = await f.aSession.rpc["team.pins.page"]({ channelId: aid });
    expect(pins.ok && pins.data.messages[0]).toMatchObject({
      bodyMarkdown: "Edited Bravo fox @maya",
      pinned: true,
    });
    const search = await f.bSession.rpc["team.search"]({ input: { query: "fox", channelId: bid } });
    expect(search).toMatchObject({ ok: true });
    expect(search.ok && search.data.results).toHaveLength(1);
    const agentLink = createId("teamLink"),
      personalDeployment = createId("deployment"),
      runId = createId("run"),
      agentClientId = randomUUID();
    await sql`insert into team_links(id,owner_user_id,personal_deployment_id,state,code_hash,credential_hash) values(${agentLink},${f.bUser},${personalDeployment},'active',${randomUUID()},${randomUUID()})`.execute(
      f.b.database,
    );
    const wire = vi.spyOn(f.b.host.team.partners!, "request");
    const agentPost = await f.b.host.team.requests.post(agentLink, {
      channelId: bid,
      clientMessageId: agentClientId,
      runId,
      bodyMarkdown: "Agent from Bravo",
      attachmentIds: [],
    });
    const localAgent = await f.b.database
      .selectFrom("teamMessages")
      .select(["agentLinkId", "personalDeploymentId", "callerRunId", "authorKind"])
      .where("id", "=", agentPost.messageId)
      .executeTakeFirstOrThrow();
    expect(localAgent).toEqual({
      agentLinkId: agentLink,
      personalDeploymentId: personalDeployment,
      callerRunId: runId,
      authorKind: "agent",
    });
    expect(
      await f.b.database
        .selectFrom("teamShareRelays")
        .select(["agentLinkId", "personalDeploymentId", "callerRunId"])
        .where("clientMessageId", "=", agentClientId)
        .executeTakeFirst(),
    ).toEqual({
      agentLinkId: agentLink,
      personalDeploymentId: personalDeployment,
      callerRunId: runId,
    });
    expect(
      await f.a.database
        .selectFrom("teamMessages")
        .select(["agentLinkId", "personalDeploymentId", "callerRunId", "authorKind"])
        .where("clientMessageId", "=", agentClientId)
        .executeTakeFirst(),
    ).toEqual({
      agentLinkId: null,
      personalDeploymentId: null,
      callerRunId: null,
      authorKind: "agent",
    });
    expect(JSON.stringify(wire.mock.calls)).not.toContain(agentLink);
    expect(JSON.stringify(wire.mock.calls)).not.toContain(runId);
    const agentActor = { kind: "agent" as const, userId: f.bUser };
    const standing = await f.b.host.team.chat.read(
      agentActor,
      "read",
      bid,
      async (t) => ({
        page: await f.b.host.team.chat.pageIn(t, agentActor, bid, { direction: "newest" }),
        source: await f.b.host.team.chat.source(t, agentActor, bid, null),
      }),
      agentLink,
    );
    expect(standing.source.audience.externalTeams).toEqual([
      { teamId: f.a.host.deployment.id, name: "Alpha" },
    ]);
    expect(
      standing.page.messages.some((m) => m.bodyMarkdown === "History before sharing @maya"),
    ).toBe(true);
    const otherChannel = createId("teamChannel"),
      otherCopy = createId("teamChannel");
    await command(f.aSession, {
      type: "team.channel.create",
      id: otherChannel,
      kind: "private",
      name: "other-project",
      peopleOnly: false,
      access: [],
    });
    const otherShare = await command(f.aSession, {
      type: "team.share.offer",
      channelId: otherChannel,
      linkId: link.id,
      historyVisibleConfirmed: true,
    });
    if (otherShare.type !== "team.share.offer") throw new Error("No other share");
    await command(f.bSession, {
      type: "team.share.accept",
      shareId: otherShare.shareId,
      id: otherCopy,
      kind: "private",
      name: "other-partner-copy",
      peopleOnly: false,
      access: [],
    });
    const ownerStore = f.a.host.team.shares!.store,
      copyStore = f.b.host.team.shares!.store;
    const ownerShare = await ownerStore.get(offered.shareId);
    const stolen = await f.a.database
      .transaction()
      .execute(async (t) =>
        ownerStore.exportRows(
          t,
          ownerShare,
          await t
            .selectFrom("teamMessages")
            .selectAll()
            .where("channelId", "=", aid)
            .where("clientMessageId", "=", agentClientId)
            .execute(),
        ),
      );
    const otherState = await copyStore.get(otherShare.shareId);
    const empty = await ownerStore.pull(link.id, {
      op: "pull",
      shareId: otherShare.shareId,
      generation: 1,
      cursor: {
        created: SequenceSchema.parse("0"),
        sequence: SequenceSchema.parse("0"),
        publicId: "",
      },
    });
    await expect(
      copyStore.apply(otherState.partnerLinkId, otherShare.shareId, 1, { ...empty, rows: stolen }),
    ).rejects.toMatchObject({ code: "not_found" });
    await command(f.bSession, {
      type: "team.message.delete",
      channelId: bid,
      messageId: posted.message.id,
    });
    await vi.waitFor(
      async () => {
        const p = await f.aSession.rpc["team.thread.page"]({
          channelId: aid,
          rootId: first.message.id,
          page: { direction: "newest" },
        });
        expect(
          p.ok && p.data.messages.at(-1)?.deletedAt,
          "Deletion never reached owner",
        ).toBeTruthy();
      },
      { timeout: 3000 },
    );
    await command(f.bSession, { type: "team.share.end", shareId: offered.shareId });
    const archive = await f.bSession.rpc["team.channel.get"]({ channelId: bid });
    expect(archive.ok && archive.data).toMatchObject({
      can: { read: true, post: false },
      share: { state: "disconnected" },
    });
    const blocked = await f.bSession.rpc["commands.dispatch"]({
      type: "team.message.send",
      channelId: bid,
      threadRootId: null,
      clientMessageId: randomUUID(),
      bodyMarkdown: "Blocked",
      mentions: [],
      attachmentIds: [],
    });
    expect(blocked.ok).toBe(false);
    const continues = await command(f.aSession, {
      type: "team.message.send",
      channelId: aid,
      threadRootId: null,
      clientMessageId: randomUUID(),
      bodyMarkdown: "Owner continues",
      mentions: [],
      attachmentIds: [],
    });
    expect(continues.type).toBe("team.message.send");
  } finally {
    await f.close();
  }
});

it("fences every partner operation to the authenticated share and rejects forged local authorship", async () => {
  const f = await sharedFixture();
  try {
    const peer = f.b.host.team.partners!,
      owner = f.a.host.team.shares!,
      copy = f.b.host.team.shares!;
    await command(f.aSession, { type: "team.sharing.policy.set", policy: "members" });
    const memberInvite = await command(f.aSession, {
      type: "team.invite.create",
      id: createId("teamInvite"),
      maxUses: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    if (memberInvite.type !== "team.invite.create") throw new Error("No local member invite");
    const member = await f.a.session(
      await f.a.acceptInvite(memberInvite.url, "Outsider"),
      "Outsider",
    );
    const hidden = await member.rpc["team.shares.list"]({});
    expect(hidden).toMatchObject({ ok: true });
    expect(hidden.ok && hidden.data.shares).toEqual([]);
    const cursor = {
      created: SequenceSchema.parse("0"),
      sequence: SequenceSchema.parse("0"),
      publicId: "",
    };
    const operations = [
      { op: "pull", cursor },
      { op: "accept", people: [] },
      { op: "roster", people: [] },
      { op: "end" },
      {
        op: "write",
        createdThrough: cursor.created,
        write: {
          action: "send",
          author: { teamId: f.b.host.deployment.id, userId: f.bUser },
          authorKind: "human",
          clientMessageId: randomUUID(),
          bodyMarkdown: "Intrusion",
          threadRootPublicId: null,
        },
      },
    ];
    for (const shareId of [randomUUID(), f.aid])
      for (const op of operations) {
        await expect(
          peer.request(f.bLink, { ...op, shareId, generation: 1 } as TeamShareOperation),
        ).rejects.toMatchObject({ reason: "not-found" });
      }
    await expect(
      peer.request(f.bLink, { op: "pull", shareId: f.shareId, generation: 2, cursor }),
    ).rejects.toMatchObject({ reason: "not-found" });
    await expect(
      owner.receive(randomUUID(), { op: "pull", shareId: f.shareId, generation: 1, cursor }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      peer.request(f.bLink, {
        op: "write",
        shareId: f.shareId,
        generation: 1,
        createdThrough: cursor.created,
        write: {
          action: "send",
          author: { teamId: f.a.host.deployment.id, userId: f.aUser },
          authorKind: "human",
          clientMessageId: randomUUID(),
          bodyMarkdown: "Impersonation",
          threadRootPublicId: null,
        },
      }),
    ).rejects.toMatchObject({ reason: "not-found" });
    for (const action of ["edit", "delete", "pin"] as const) {
      for (const publicId of [randomUUID(), "1"]) {
        const write = {
          action,
          publicId,
          author: { teamId: f.b.host.deployment.id, userId: f.bUser },
          ...(action === "edit" ? { bodyMarkdown: "Intrusion" } : {}),
          ...(action === "pin" ? { pinned: true } : {}),
        };
        await expect(
          peer.request(f.bLink, {
            op: "write",
            shareId: f.shareId,
            generation: 1,
            createdThrough: cursor.created,
            write,
          } as TeamShareOperation),
        ).rejects.toMatchObject({ reason: "not-found" });
      }
    }
    const baseline = await owner.store.pull(f.aLink, {
      op: "pull",
      shareId: f.shareId,
      generation: 1,
      cursor,
    });
    const forged = {
      ...baseline,
      rows: [
        {
          kind: "text" as const,
          publicId: randomUUID(),
          ordinal: SequenceSchema.parse("1"),
          sequence: SequenceSchema.parse("1"),
          author: { teamId: f.b.host.deployment.id, userId: f.bUser },
          authorKind: "human" as const,
          clientMessageId: randomUUID(),
          bodyMarkdown: "@maya-2-agent forged wake",
          threadRootPublicId: null,
          createdAt: new Date().toISOString(),
          editedAt: null,
          deletedAt: null,
          pinnedBy: null,
        },
      ],
    };
    const before = await copy.store.get(f.shareId);
    await expect(copy.store.apply(f.bLink, f.shareId, 1, forged)).rejects.toMatchObject({
      code: "not_found",
    });
    expect((await copy.store.get(f.shareId)).cursor).toBe(before.cursor);
    expect(
      await f.b.database
        .selectFrom("teamMessages")
        .select("id")
        .where("channelId", "=", f.bid)
        .execute(),
    ).toHaveLength(0);
    await expect(
      copy.store.apply(f.bLink, f.shareId, 1, {
        ...forged,
        rows: [{ ...forged.rows[0]!, kind: "future" }],
      } as unknown as TeamShareBatch),
    ).rejects.toThrow();
    expect((await copy.store.get(f.shareId)).cursor).toBe(before.cursor);
    const principal = await f.a.database
      .selectFrom("teamPrincipals")
      .select("id")
      .where("homeTeamId", "=", f.b.host.deployment.id)
      .where("homeUserId", "=", f.bUser)
      .executeTakeFirstOrThrow();
    await command(f.aSession, {
      type: "team.share.participant.remove",
      shareId: f.shareId,
      principalId: principal.id,
    });
    await expect(
      peer.request(f.bLink, {
        op: "write",
        shareId: f.shareId,
        generation: 1,
        createdThrough: cursor.created,
        write: {
          action: "send",
          author: { teamId: f.b.host.deployment.id, userId: f.bUser },
          authorKind: "human",
          clientMessageId: randomUUID(),
          bodyMarkdown: "Removed",
          threadRootPublicId: null,
        },
      }),
    ).rejects.toMatchObject({ reason: "not-found" });
    await vi.waitFor(
      async () => {
        const denied = await f.bSession.rpc["team.channel.get"]({ channelId: f.bid });
        expect(denied.ok, "Owner removal did not fence the local copy").toBe(false);
      },
      { timeout: 3000 },
    );
    await command(f.aSession, {
      type: "team.share.participant.restore",
      shareId: f.shareId,
      principalId: principal.id,
    });
    await vi.waitFor(
      async () => {
        const restored = await f.bSession.rpc["team.channel.get"]({ channelId: f.bid });
        expect(
          restored.ok && restored.data.can.post,
          "Owner restoration never reached the follower",
        ).toBe(true);
      },
      { timeout: 3000 },
    );
    const limitedId = randomUUID();
    for (let i = 0; i < 600; i++)
      await expect(
        owner.receive(f.aLink, { op: "pull", shareId: limitedId, generation: 1, cursor }),
      ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      owner.receive(f.aLink, { op: "pull", shareId: limitedId, generation: 1, cursor }),
    ).rejects.toMatchObject({ code: "resource_exhausted" });
    const socket = [...f.sockets][0]!;
    const closed = once(socket, "close");
    socket.send(JSON.stringify({ oversized: "x".repeat(teamPartnerMaxFrameBytes) }));
    await withTimeout(closed, 3000, {
      timeoutError: () => new Error("Partner accepted an oversized frame"),
    });
  } finally {
    await f.close();
  }
});

it("catches up in owner creation order after an outage, preserves realtime and unread, then re-shares into a fresh archive", async () => {
  const f = await sharedFixture();
  try {
    await f.bSession.client.load();
    f.bSession.client.selectChannel(f.bid);
    await teamCondition(
      f.bSession.client,
      () => (f.bSession.client.getSnapshot().channel?.throughSeq !== null ? true : undefined),
      "Follower client never opened",
      5000,
    );
    await command(f.bSession, { type: "team.sharing.policy.set", policy: "off" });
    const first = await command(f.aSession, {
      type: "team.message.send",
      channelId: f.aid,
      threadRootId: null,
      clientMessageId: randomUUID(),
      bodyMarkdown: "First owner fox",
      mentions: [],
      attachmentIds: [],
    });
    if (first.type !== "team.message.send") throw new Error("No first post");
    for (let i = 0; i < 35; i++)
      await command(f.aSession, {
        type: "team.message.send",
        channelId: f.aid,
        threadRootId: null,
        clientMessageId: randomUUID(),
        bodyMarkdown: `Later ${i} @maya-2`,
        mentions: [],
        attachmentIds: [],
      });
    await command(f.aSession, {
      type: "team.message.edit",
      channelId: f.aid,
      messageId: first.message.id,
      bodyMarkdown: "First edited last",
      mentions: [],
    });
    const receive = f.a.host.team.shares!.receive.bind(f.a.host.team.shares);
    let limited = false;
    vi.spyOn(f.a.host.team.shares!, "receive").mockImplementation(async (link, op) => {
      if (op.op === "pull" && op.shareId === f.shareId && !limited) {
        limited = true;
        throw new OpensteerError({
          code: "resource_exhausted",
          retryable: true,
          message: "Share rate limit",
          details: { retryAfterMs: 10 },
        });
      }
      return receive(link, op);
    });
    const discoveries = f.discoveries;
    await command(f.bSession, { type: "team.sharing.policy.set", policy: "admins" });
    await active(f.aSession, f.bSession);
    await teamCondition(
      f.bSession.client,
      () => {
        const rows = f.bSession.client.getSnapshot().channel?.messages;
        return rows?.length === 36 && rows[0]?.bodyMarkdown === "First edited last"
          ? rows
          : undefined;
      },
      "Follower failed to drain owner history in creation order",
      5000,
    );
    await teamCondition(
      f.bSession.client,
      () => {
        const row = f.bSession.client
          .getSnapshot()
          .sidebar?.channels.find((r) => r.channel.id === f.bid);
        return row?.mentionCount === 35 && row.unread ? row : undefined;
      },
      "Follower unread and mention counts did not update",
      5000,
    );
    expect(limited).toBe(true);
    expect(f.discoveries, "A limited share forced the partner connection to restart").toBe(
      discoveries + 1,
    );
    const mentions = await f.bSession.rpc["team.mentions.page"]({ channelId: f.bid });
    expect(mentions.ok && mentions.data.messages).toHaveLength(35);
    const request = vi.spyOn(f.b.host.team.partners!, "request");
    await command(f.bSession, {
      type: "team.message.send",
      channelId: f.bid,
      threadRootId: null,
      clientMessageId: randomUUID(),
      bodyMarkdown: "One round trip",
      mentions: [],
      attachmentIds: [],
    });
    expect(request.mock.calls.filter(([, op]) => op.op === "write")).toHaveLength(1);
    await command(f.aSession, { type: "team.share.end", shareId: f.shareId });
    await vi.waitFor(
      async () => {
        const c = await f.bSession.rpc["team.channel.get"]({ channelId: f.bid });
        expect(c.ok && c.data.share?.state, "Owner disconnect never reached follower").toBe(
          "disconnected",
        );
      },
      { timeout: 3000 },
    );
    const next = await command(f.aSession, {
      type: "team.share.offer",
      channelId: f.aid,
      linkId: f.aLink,
      historyVisibleConfirmed: true,
    });
    if (next.type !== "team.share.offer") throw new Error("No fresh share");
    expect(next.shareId).not.toBe(f.shareId);
    const freshId = createId("teamChannel");
    await command(f.bSession, {
      type: "team.share.accept",
      shareId: next.shareId,
      id: freshId,
      kind: "private",
      name: "fresh-project",
      peopleOnly: false,
      access: [],
    });
    const page = await f.bSession.rpc["team.messages.page"]({
      channelId: freshId,
      page: { direction: "newest" },
    });
    expect(page.ok && page.data.messages).toHaveLength(37);
    const sidebar = await f.bSession.rpc["team.sidebar.get"]({});
    expect(
      sidebar.ok && sidebar.data.channels.find((r) => r.channel.id === freshId)?.mentionCount,
    ).toBe(0);
  } finally {
    await f.close();
  }
});

it("holds no local access lock while a relay waits and rechecks owner authority before committing", async () => {
  const f = await sharedFixture();
  const release = Promise.withResolvers<void>();
  try {
    const entered = Promise.withResolvers<void>(),
      partners = f.b.host.team.partners!,
      request = partners.request.bind(partners);
    vi.spyOn(partners, "request").mockImplementation(async (id, op) => {
      if (op.op === "write") {
        entered.resolve();
        await release.promise;
      }
      return request(id, op);
    });
    const sending = f.bSession.rpc["commands.dispatch"]({
      type: "team.message.send",
      channelId: f.bid,
      threadRootId: null,
      clientMessageId: randomUUID(),
      bodyMarkdown: "Racing removal",
      mentions: [],
      attachmentIds: [],
    });
    await withTimeout(entered.promise, 2000, {
      timeoutError: () => new Error("Follower never started its relay"),
    });
    await withTimeout(
      command(f.bSession, {
        type: "team.channel.update",
        channelId: f.bid,
        name: "renamed-project",
        peopleOnly: false,
      }),
      2000,
      { timeoutError: () => new Error("Relay held the local access lock across the network") },
    );
    const principal = await f.a.database
      .selectFrom("teamPrincipals")
      .select("id")
      .where("homeTeamId", "=", f.b.host.deployment.id)
      .where("homeUserId", "=", f.bUser)
      .executeTakeFirstOrThrow();
    await command(f.aSession, {
      type: "team.share.participant.remove",
      shareId: f.shareId,
      principalId: principal.id,
    });
    release.resolve();
    const result = await withTimeout(sending, 3000, {
      timeoutError: () => new Error("Removed participant's relay never settled"),
    });
    expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(
      await f.a.database
        .selectFrom("teamMessages")
        .select("id")
        .where("channelId", "=", f.aid)
        .execute(),
    ).toHaveLength(0);
  } finally {
    release.resolve();
    await f.close();
  }
});

it("updates owner participants in the ACL transaction and synchronizes a follower's new local participant", async () => {
  const f = await sharedFixture();
  try {
    async function addMember(host: typeof f.a, session: typeof f.aSession, name: string) {
      const invite = await command(session, {
        type: "team.invite.create",
        id: createId("teamInvite"),
        maxUses: 1,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      if (invite.type !== "team.invite.create") throw new Error("Missing invite");
      return host.acceptInvite(invite.url, name);
    }
    const [alice, bob] = await Promise.all([
      addMember(f.a, f.aSession, "Alice"),
      addMember(f.b, f.bSession, "Bob"),
    ]);
    const actor = { kind: "human" as const, userId: f.aUser },
      chat = f.a.host.team.chat;
    const aAccess = TeamChannelAccessSchema.parse(await chat.accessList(actor, f.aid));
    await chat.setAccess(actor, f.aid, SequenceSchema.parse(aAccess.revision), [
      ...aAccess.entries,
      { subject: { kind: "person", userId: alice }, level: "post", manage: false },
    ]);
    expect(
      await f.a.database
        .selectFrom("teamShareParticipants")
        .select(["state", "level"])
        .where("shareId", "=", f.shareId)
        .where("principalId", "=", alice)
        .executeTakeFirst(),
    ).toEqual({ state: "active", level: "post" });
    const bAccess = await f.bSession.rpc["team.channel.access.get"]({ channelId: f.bid });
    if (!bAccess.ok) throw new Error("No follower access");
    await command(f.bSession, {
      type: "team.channel.access.set",
      channelId: f.bid,
      expectedRevision: bAccess.data.revision,
      access: [
        ...bAccess.data.entries,
        { subject: { kind: "person", userId: bob }, level: "post", manage: false },
      ],
    });
    await vi.waitFor(
      async () => {
        const row = await f.a.database
          .selectFrom("teamShareParticipants as a")
          .innerJoin("teamPrincipals as p", "p.id", "a.principalId")
          .select("a.state")
          .where("a.shareId", "=", f.shareId)
          .where("p.homeTeamId", "=", f.b.host.deployment.id)
          .where("p.homeUserId", "=", bob)
          .executeTakeFirst();
        expect(row, "Follower roster never reached the owner").toEqual({ state: "active" });
        const authority = await f.b.host.team.access.database
          .transaction()
          .execute((t) => f.b.host.team.access.channel(t, { kind: "human", userId: bob }, f.bid));
        expect(authority.post, "Owner roster never enabled the new follower participant").toBe(
          true,
        );
      },
      { timeout: 3000 },
    );
    const beforeRemove = await f.bSession.rpc["team.channel.access.get"]({ channelId: f.bid });
    if (!beforeRemove.ok) throw new Error("No follower access");
    await command(f.bSession, {
      type: "team.channel.access.set",
      channelId: f.bid,
      expectedRevision: beforeRemove.data.revision,
      access: bAccess.data.entries,
    });
    await vi.waitFor(
      async () => {
        const p = await f.a.database
          .selectFrom("teamShareParticipants as a")
          .innerJoin("teamPrincipals as p", "p.id", "a.principalId")
          .select("a.state")
          .where("a.shareId", "=", f.shareId)
          .where("p.homeTeamId", "=", f.b.host.deployment.id)
          .where("p.homeUserId", "=", bob)
          .executeTakeFirst();
        expect(p, "Local removal never reached the owner").toEqual({ state: "removed" });
      },
      { timeout: 3000 },
    );
    const beforeRejoin = await f.bSession.rpc["team.channel.access.get"]({ channelId: f.bid });
    if (!beforeRejoin.ok) throw new Error("No follower access");
    await command(f.bSession, {
      type: "team.channel.access.set",
      channelId: f.bid,
      expectedRevision: beforeRejoin.data.revision,
      access: [
        ...bAccess.data.entries,
        { subject: { kind: "person", userId: bob }, level: "post", manage: false },
      ],
    });
    await vi.waitFor(
      async () => {
        const a = await f.b.host.team.access.database
          .transaction()
          .execute((t) => f.b.host.team.access.channel(t, { kind: "human", userId: bob }, f.bid));
        expect(a.post, "A locally re-added participant could not post again").toBe(true);
      },
      { timeout: 3000 },
    );
    const latest = TeamChannelAccessSchema.parse(await chat.accessList(actor, f.aid));
    await chat.setAccess(actor, f.aid, SequenceSchema.parse(latest.revision), aAccess.entries);
    expect(
      await f.a.database
        .selectFrom("teamShareParticipants")
        .select("state")
        .where("shareId", "=", f.shareId)
        .where("principalId", "=", alice)
        .executeTakeFirst(),
    ).toEqual({ state: "removed" });
    await command(f.aSession, {
      type: "team.channel.update",
      channelId: f.aid,
      name: "shared-project",
      peopleOnly: true,
    });
    await vi.waitFor(
      async () => {
        const a = await f.b.host.team.access.database
          .transaction()
          .execute((t) =>
            f.b.host.team.access.channel(t, { kind: "agent", userId: f.bUser }, f.bid),
          );
        expect(a.read, "Owner people-only policy never fenced follower agents").toBe(false);
      },
      { timeout: 3000 },
    );
    await command(f.bSession, {
      type: "team.channel.update",
      channelId: f.bid,
      name: "partner-project",
      peopleOnly: false,
    });
    expect(
      await f.b.host.team.access.database
        .transaction()
        .execute((t) => f.b.host.team.access.channel(t, { kind: "agent", userId: f.bUser }, f.bid)),
    ).toMatchObject({ read: false, peopleOnly: true });
    await command(f.bSession, {
      type: "team.channel.update",
      channelId: f.bid,
      name: "partner-project",
      peopleOnly: true,
    });
    await command(f.aSession, {
      type: "team.channel.update",
      channelId: f.aid,
      name: "shared-project",
      peopleOnly: false,
    });
    await vi.waitFor(
      async () => {
        const s = await f.b.host.team.shares!.store.get(f.shareId);
        expect(s.peopleOnly, "Owner policy change never arrived").toBe(false);
      },
      { timeout: 3000 },
    );
    expect(
      await f.b.host.team.access.database
        .transaction()
        .execute((t) => f.b.host.team.access.channel(t, { kind: "agent", userId: f.bUser }, f.bid)),
    ).toMatchObject({ read: false, peopleOnly: true });
  } finally {
    await f.close();
  }
});

it("delivers an offline disconnect before a fresh offer when the partner reconnects", async () => {
  const f = await sharedFixture();
  try {
    await command(f.bSession, { type: "team.sharing.policy.set", policy: "off" });
    await command(f.aSession, { type: "team.share.end", shareId: f.shareId });
    const offer = await f.aSession.rpc["commands.dispatch"]({
      type: "team.share.offer",
      channelId: f.aid,
      linkId: f.aLink,
      historyVisibleConfirmed: true,
    });
    expect(offer).toMatchObject({ ok: false, error: { reason: "partner-unreachable" } });
    const queued = await f.a.database
      .selectFrom("teamShares")
      .selectAll()
      .where("channelId", "=", f.aid)
      .where("state", "=", "offered")
      .executeTakeFirstOrThrow();
    expect(queued.historyFromShareId).toBe(f.shareId);
    await command(f.bSession, { type: "team.sharing.policy.set", policy: "admins" });
    await vi.waitFor(
      async () => {
        const old = await f.b.host.team.shares!.store.get(f.shareId);
        expect(old.state, "Offline disconnect never reached the follower").toBe("ended");
        const offers = await f.bSession.rpc["team.shares.list"]({});
        expect(
          offers.ok && offers.data.shares.some((s) => s.id === queued.id && s.state === "offered"),
          "Fresh offer never arrived after its predecessor ended",
        ).toBe(true);
      },
      { timeout: 5000 },
    );
    const fresh = createId("teamChannel");
    await command(f.bSession, {
      type: "team.share.accept",
      shareId: queued.id,
      id: fresh,
      kind: "private",
      name: "reconnected-project",
      peopleOnly: false,
      access: [],
    });
    const ready = await f.bSession.rpc["team.channel.get"]({ channelId: fresh });
    expect(ready.ok && ready.data.can.post).toBe(true);
  } finally {
    await f.close();
  }
});
