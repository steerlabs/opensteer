import { withTeamPeerVersion } from "../packages/database/src/team-access-store.js";
import { sql } from "kysely";
import { withTimeout } from "../packages/shared/src/withTimeout.js";
import { once } from "node:events";
import {
  TeamChannelAccessSchema,
  TeamLinkServerFrameSchema,
  teamPartnerMaxFrameBytes,
} from "../packages/protocol/src/index.js";
import { createHash, randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { expect, it, vi } from "vitest";
import { teamMessage } from "../packages/shared/src/teamMentions.js";
import { teamPeopleDirectory } from "../packages/client/src/team/shared-channels.js";
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
          attachments: [],
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
          attachments: [],
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
          attachments: [],
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
    vi.spyOn(partners, "request").mockImplementation(async (id, op, signal, handoff) => {
      if (op.op === "write") {
        entered.resolve();
        await withTimeout(release.promise, 3000, {
          timeoutError: () => new Error("Relay barrier never released"),
        });
      }
      return request(id, op, signal, handoff);
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
        expect(
          await f.b.database
            .selectFrom("teamShareParticipants")
            .select("state")
            .where("shareId", "=", f.shareId)
            .where("principalId", "=", bob)
            .executeTakeFirst(),
          "Owner removal acknowledgement never reached the follower",
        ).toEqual({ state: "removed" });
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
          offers.ok && offers.data.shares.find((s) => s.id === queued.id),
          "Fresh offer never arrived after its predecessor ended",
        ).toMatchObject({ state: "offered", canAccept: true, canApprove: false, canEnd: true });
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

it("a write receipt must preserve the owner's current people-only policy", async () => {
  const f = await sharedFixture();
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
    const clientMessageId = randomUUID();
    await command(f.bSession, {
      type: "team.message.send",
      channelId: f.bid,
      threadRootId: null,
      clientMessageId,
      bodyMarkdown: "Before restriction",
      mentions: [],
      attachmentIds: [],
    });
    const delayed = await f.a.host.team.shares!.store.write(f.aLink, {
      op: "write",
      shareId: f.shareId,
      generation: 1,
      createdThrough: SequenceSchema.parse("0"),
      write: {
        action: "send",
        author: { teamId: f.b.host.deployment.id, userId: f.bUser },
        authorKind: "human",
        clientMessageId,
        bodyMarkdown: "Before restriction",
        threadRootPublicId: null,
        attachments: [],
      },
    });
    expect(delayed.batch.peopleOnly).toBe(false);
    await command(f.aSession, {
      type: "team.channel.update",
      channelId: f.aid,
      name: "shared-project",
      peopleOnly: true,
    });
    await vi.waitFor(
      async () => expect((await f.b.host.team.shares!.store.get(f.shareId)).peopleOnly).toBe(true),
      { timeout: 3000 },
    );
    vi.spyOn(f.b.host.team.shares!, "sync").mockResolvedValue(undefined);
    const result = await command(f.bSession, {
      type: "team.message.send",
      channelId: f.bid,
      threadRootId: null,
      clientMessageId: randomUUID(),
      bodyMarkdown: "@maya-2-agent Should stay blocked",
      mentions: [],
      attachmentIds: [],
    });
    expect(result.type === "team.message.send" && result.wake).toBe("people-only");
    expect((await f.b.host.team.shares!.store.get(f.shareId)).peopleOnly).toBe(true);
    await f.b.host.team.shares!.store.apply(f.bLink, f.shareId, 1, delayed.batch, false);
    expect((await f.b.host.team.shares!.store.get(f.shareId)).peopleOnly).toBe(true);
    await expect(
      f.b.host.team.chat.page({ kind: "agent", userId: f.bUser }, f.bid),
    ).rejects.toThrow();
    expect(await f.b.host.team.requests.pending(linkId)).toHaveLength(0);
  } finally {
    await f.close();
  }
});

it.each(["before-send", "refused"] as const)(
  "an edit that is %s keeps committed authorship available to sync",
  async (failureKind) => {
    const f = await sharedFixture();
    try {
      const sent = await command(f.bSession, {
        type: "team.message.send",
        channelId: f.bid,
        threadRootId: null,
        clientMessageId: randomUUID(),
        bodyMarkdown: "original",
        mentions: [],
        attachmentIds: [],
      });
      if (sent.type !== "team.message.send") throw Error("No message");
      await f.b.host.team.shares!.sync(await f.b.host.team.shares!.store.get(f.shareId));
      const partners = f.b.host.team.partners!;
      const request = partners.request.bind(partners);
      const failure = vi
        .spyOn(partners, "request")
        .mockImplementation((id, op, signal, handoff) => {
          if (op.op === "write" && op.write.action === "edit")
            return Promise.reject(
              failureKind === "refused"
                ? new OpensteerError({
                    code: "not_found",
                    reason: "not-found",
                    message: "Shared channel not found",
                  })
                : Error("Before send"),
            );
          return request(id, op, signal, handoff);
        });
      await expect(
        command(f.bSession, {
          type: "team.message.edit",
          channelId: f.bid,
          messageId: sent.message.id,
          bodyMarkdown: "edited",
          mentions: [],
        }),
      ).rejects.toThrow();
      failure.mockRestore();
      const ownerRow = await f.a.database
        .selectFrom("teamMessages")
        .select("id")
        .where("channelId", "=", f.aid)
        .executeTakeFirstOrThrow();
      vi.spyOn(f.b.host.team.shares!, "sync").mockResolvedValue(undefined);
      await command(f.aSession, {
        type: "team.message.pin",
        channelId: f.aid,
        messageId: ownerRow.id,
      });
      const current = await f.b.host.team.shares!.store.get(f.shareId);
      const batch = await f.a.host.team.shares!.store.pull(f.aLink, {
        op: "pull",
        shareId: f.shareId,
        generation: 1,
        cursor: {
          created: SequenceSchema.parse(current.creationCursor),
          sequence: SequenceSchema.parse(current.cursor),
          publicId: current.cursorPublicId,
        },
      });
      expect(batch.rows).toHaveLength(1);
      await expect(f.b.host.team.shares!.store.apply(f.bLink, f.shareId, 1, batch)).resolves.toBe(
        false,
      );
      expect(
        await f.b.database
          .selectFrom("teamMessagePins")
          .select("messageId")
          .where("channelId", "=", f.bid)
          .execute(),
      ).toEqual([{ messageId: sent.message.id }]);
      expect(
        await f.b.database
          .selectFrom("teamShareRelays")
          .select("bodyMarkdown")
          .where("shareId", "=", f.shareId)
          .execute(),
      ).toEqual([{ bodyMarkdown: "original" }]);
    } finally {
      await f.close();
    }
  },
);

it("a peer must not distinguish a hidden local person from a nonexistent person", async () => {
  const f = await sharedFixture();
  try {
    const invite = await command(f.bSession, {
      type: "team.invite.create",
      id: createId("teamInvite"),
      maxUses: 1,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    if (invite.type !== "team.invite.create") throw Error("No invite");
    const hidden = await f.b.acceptInvite(invite.url, "Hidden Person");
    const batch = await f.a.host.team.shares!.store.pull(f.aLink, {
      op: "pull",
      shareId: f.shareId,
      generation: 1,
      cursor: {
        created: SequenceSchema.parse("0"),
        sequence: SequenceSchema.parse("0"),
        publicId: "",
      },
    });
    const inject = (userId: typeof hidden) =>
      f.b.host.team.shares!.store.apply(
        f.bLink,
        f.shareId,
        1,
        {
          ...batch,
          people: [
            ...batch.people,
            {
              teamId: f.b.host.deployment.id,
              userId,
              name: "Guessed",
              handle: "guessed",
              level: "read",
              state: "removed",
            },
          ],
        },
        false,
      );
    const outcomes = await Promise.allSettled([inject(hidden), inject(createId("user"))]);
    expect(outcomes.map((x) => x.status)).toEqual(["rejected", "rejected"]);
    for (const outcome of outcomes) {
      if (outcome.status !== "rejected") throw new Error("Unshared identity was admitted");
      expect(outcome.reason).toMatchObject({
        code: "not_found",
        message: "Shared channel not found",
      });
    }
    expect(
      await f.b.database
        .selectFrom("teamShareParticipants")
        .select("principalId")
        .where("shareId", "=", f.shareId)
        .where("principalId", "=", hidden)
        .execute(),
    ).toEqual([]);
    expect(f.b.host.team.partners!.connected(f.bLink)).toBe(true);
  } finally {
    await f.close();
  }
});

it("a repeated empty more batch must stop the sync loop", async () => {
  const f = await sharedFixture();
  try {
    const current = await f.b.host.team.shares!.store.get(f.shareId);
    const baseline = await f.a.host.team.shares!.store.pull(f.aLink, {
      op: "pull",
      shareId: f.shareId,
      generation: 1,
      cursor: {
        created: SequenceSchema.parse(current.creationCursor),
        sequence: SequenceSchema.parse(current.cursor),
        publicId: current.cursorPublicId,
      },
    });
    const request = f.b.host.team.partners!.request.bind(f.b.host.team.partners!);
    let pulls = 0;
    vi.spyOn(f.b.host.team.partners!, "request").mockImplementation((id, op, signal, handoff) => {
      if (op.op === "pull") {
        pulls++;
        if (pulls > 3) return Promise.reject(Error("Review safety stop"));
        return Promise.resolve({ ...baseline, rows: [], cursor: op.cursor, more: true });
      }
      return request(id, op, signal, handoff);
    });
    await expect(f.b.host.team.shares!.sync(current)).rejects.toThrow();
    expect(pulls).toBe(1);
  } finally {
    await f.close();
  }
});

it.each(["channel", "session"] as const)(
  "a follower relay rechecks %s authority before exporting",
  async (removal) => {
    const f = await sharedFixture();
    const release = Promise.withResolvers<void>();
    const rosterRelease = Promise.withResolvers<void>();
    try {
      const entered = Promise.withResolvers<void>();
      const request = f.b.host.team.partners!.request.bind(f.b.host.team.partners!);
      vi.spyOn(f.b.host.team.partners!, "request").mockImplementation(
        async (id, op, signal, handoff) => {
          if (op.op === "write") {
            entered.resolve();
            await withTimeout(release.promise, 3000, {
              timeoutError: () => new Error("Relay barrier never released"),
            });
          }
          if (op.op === "roster")
            await withTimeout(rosterRelease.promise, 3000, {
              timeoutError: () => new Error("Roster barrier never released"),
            });
          return request(id, op, signal, handoff);
        },
      );
      const sending = f.bSession.rpc["commands.dispatch"]({
        type: "team.message.send",
        channelId: f.bid,
        threadRootId: null,
        clientMessageId: randomUUID(),
        bodyMarkdown: "Do not export after removal",
        mentions: [],
        attachmentIds: [],
      });
      await withTimeout(entered.promise, 2000, {
        timeoutError: () => Error("Relay never started"),
      });
      const actor = { kind: "human" as const, userId: f.bUser };
      const acl = await f.b.host.team.chat.accessList(actor, f.bid);
      if (removal === "channel")
        await f.b.host.team.chat.setAccess(actor, f.bid, SequenceSchema.parse(acl.revision), []);
      else
        await f.b.database
          .updateTable("authSessions")
          .set({ expiresAt: new Date(0) })
          .where("userId", "=", f.bUser)
          .execute();

      release.resolve();
      await sending;
      const exported = await f.a.database
        .selectFrom("teamMessages")
        .select("bodyMarkdown")
        .where("channelId", "=", f.aid)
        .execute();
      expect(exported).toEqual([]);
    } finally {
      release.resolve();
      rosterRelease.resolve();
      await f.close();
    }
  },
);

it("applies an empty catch-up without the exclusive access mutation or a channel change", async () => {
  const f = await sharedFixture();
  try {
    const copy = f.b.host.team.shares!;
    await copy.sync(await copy.store.get(f.shareId));
    const current = await copy.store.get(f.shareId);
    const batch = await f.a.host.team.shares!.store.pull(f.aLink, {
      op: "pull",
      shareId: f.shareId,
      generation: 1,
      cursor: {
        created: SequenceSchema.parse(current.creationCursor),
        sequence: SequenceSchema.parse(current.cursor),
        publicId: current.cursorPublicId,
      },
    });
    const before = await f.b.database
      .selectFrom("teamChannels")
      .select("changeSeq")
      .where("id", "=", f.bid)
      .executeTakeFirstOrThrow();
    const mutate = vi.spyOn(f.b.host.team.access, "mutate");
    const changed = vi.spyOn(f.b.host.team.chat, "changed");
    await copy.store.apply(f.bLink, f.shareId, 1, batch);
    expect(mutate).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(
      await f.b.database
        .selectFrom("teamChannels")
        .select("changeSeq")
        .where("id", "=", f.bid)
        .executeTakeFirstOrThrow(),
    ).toEqual(before);
  } finally {
    await f.close();
  }
});

it("bounds even progressing sync turns and releases the access fence between batches", async () => {
  const f = await sharedFixture();
  try {
    const copy = f.b.host.team.shares!;
    vi.spyOn(copy, "sync").mockResolvedValue(undefined);
    await command(f.aSession, {
      type: "team.message.send",
      channelId: f.aid,
      threadRootId: null,
      clientMessageId: randomUUID(),
      bodyMarkdown: "Owner message",
      mentions: [],
      attachmentIds: [],
    });
    const current = await copy.store.get(f.shareId);
    const sample = await f.a.host.team.shares!.store.pull(f.aLink, {
      op: "pull",
      shareId: f.shareId,
      generation: 1,
      cursor: {
        created: SequenceSchema.parse("0"),
        sequence: SequenceSchema.parse("0"),
        publicId: "",
      },
    });
    vi.mocked(copy.sync).mockRestore();
    const request = f.b.host.team.partners!.request.bind(f.b.host.team.partners!);
    let pulls = 0;
    vi.spyOn(f.b.host.team.partners!, "request").mockImplementation((id, op, signal, handoff) => {
      if (op.op !== "pull") return request(id, op, signal, handoff);
      if (++pulls > 9) return Promise.reject(Error("Sync turn exceeded safety bound"));
      const ordinal = SequenceSchema.parse(String(BigInt(op.cursor.created) + 1n));
      return Promise.resolve({
        ...sample,
        rows: [
          { ...sample.rows[0]!, ordinal, publicId: randomUUID(), clientMessageId: randomUUID() },
        ],
        cursor: { ...op.cursor, created: ordinal },
        more: true,
      });
    });
    await expect(copy.sync(current)).rejects.toMatchObject({
      reason: "shared-channel-sync-pending",
      retryable: true,
    });
    expect(pulls).toBe(8);
    const actor = { kind: "human" as const, userId: f.bUser };
    const access = await f.b.host.team.chat.accessList(actor, f.bid);
    await f.b.host.team.chat.setAccess(actor, f.bid, SequenceSchema.parse(access.revision), []);
  } finally {
    await f.close();
  }
});

it("refuses old apps only for shared channel work", async () => {
  const f = await sharedFixture();
  try {
    const headers = { ...f.bSession.headers, "x-opensteer-team-api-version": "5" };
    const get = await f.b.host.app.inject({
      method: "POST",
      url: "/v1/rpc/team.channel.get",
      payload: { channelId: f.bid },
      headers,
    });
    expect(get.statusCode).toBe(409);
    expect(get.json()).toMatchObject({
      ok: false,
      error: { reason: "api-version-mismatch", retryable: false },
    });
    expect(get.body).toContain("Update Opensteer");
    const send = await f.b.host.app.inject({
      method: "POST",
      url: "/v1/rpc/commands.dispatch",
      payload: {
        type: "team.message.send",
        channelId: f.bid,
        threadRootId: null,
        clientMessageId: randomUUID(),
        bodyMarkdown: "Hidden audience",
        mentions: [],
        attachmentIds: [],
      },
      headers,
    });
    expect(send.statusCode).toBe(409);
    expect(send.json()).toMatchObject({ ok: false, error: { reason: "api-version-mismatch" } });
    const frames: unknown[] = [];
    const peer = f.b.host.team.realtime.connect(
      { kind: "human", userId: f.bUser },
      {
        send: (frame) => {
          frames.push(frame);
          return true;
        },
        close: () => {},
      },
    );
    await expect(
      peer.receive({
        type: "team.subscribe",
        teamApiVersion: 5,
        subscriptionId: "old",
        generation: 1,
        scope: { kind: "channel", channelId: f.bid },
        sidebar: false,
        sinceSeq: null,
      }),
    ).rejects.toMatchObject({ reason: "api-version-mismatch" });
    expect(frames).toEqual([]);
    peer.close();
    const internal = createId("teamChannel");
    await command(f.bSession, {
      type: "team.channel.create",
      id: internal,
      kind: "private",
      name: "internal",
      peopleOnly: false,
      access: [],
    });
    const read = await f.b.host.app.inject({
      method: "POST",
      url: "/v1/rpc/team.channel.get",
      payload: { channelId: internal },
      headers,
    });
    expect(read.statusCode).toBe(200);
    const bootstrap = await f.b.host.app.inject({
      method: "POST",
      url: "/v1/rpc/team.bootstrap.get",
      payload: {},
      headers,
    });
    expect(bootstrap.statusCode).toBe(200);
    const entries = bootstrap.json().data.sidebar.channels;
    expect(entries.some((entry: { channel: { id: string } }) => entry.channel.id === f.bid)).toBe(
      false,
    );
    expect(
      entries.some((entry: { channel: { id: string } }) => entry.channel.id === internal),
    ).toBe(true);
    const cuts: Array<{ channel: { share?: unknown } }> = [];
    const closed = Promise.withResolvers<string>();
    const watching = f.b.host.team.realtime.connect(
      { kind: "human", userId: f.bUser },
      {
        send: (frame) => {
          if (frame.type === "team.cut") cuts.push(frame.cut);
          return true;
        },
        close: (reason) => closed.resolve(reason),
      },
    );
    await watching.receive({
      type: "team.subscribe",
      teamApiVersion: 5,
      subscriptionId: "internal",
      generation: 1,
      scope: { kind: "channel", channelId: internal },
      sidebar: false,
      sinceSeq: null,
    });
    expect(cuts).toHaveLength(1);
    const offer = await command(f.bSession, {
      type: "team.share.offer",
      channelId: internal,
      linkId: f.bLink,
      historyVisibleConfirmed: true,
    });
    if (offer.type !== "team.share.offer") throw Error("No share offer");
    await command(f.aSession, {
      type: "team.share.accept",
      shareId: offer.shareId,
      id: createId("teamChannel"),
      kind: "private",
      name: "newly-shared",
      peopleOnly: false,
      access: [],
    });
    expect(
      await withTimeout(closed.promise, 3000, {
        timeoutError: () => Error("Old subscription survived sharing"),
      }),
    ).toContain("Update Opensteer");
    expect(cuts.every((cut) => !cut.channel.share)).toBe(true);
    watching.close();
  } finally {
    await f.close();
  }
});

it("routes Ask my agent using the viewer's share handle in the initial channel cut", async () => {
  const f = await sharedFixture();
  let oldLink: WebSocket | undefined;
  try {
    const credential = `ost_link_${"b".repeat(43)}`;
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
        credentialHash: createHash("sha256").update(credential).digest("hex"),
      })
      .execute();
    const bootstrap = await f.bSession.rpc["team.bootstrap.get"]({});
    if (!bootstrap.ok) throw Error("No bootstrap");
    const page = await f.bSession.rpc["team.messages.page"]({
      channelId: f.bid,
      page: { direction: "newest" },
    });
    if (!page.ok) throw Error("No channel page");
    const share = page.data.channel.share;
    expect(share).toMatchObject({ viewerHandle: "maya-2" });
    const directory = teamPeopleDirectory(
      [bootstrap.data.member],
      page.data.people,
      share?.viewerHandle ? { [f.bUser]: share.viewerHandle } : {},
    );
    const input = teamMessage(
      { body: "Help me", toMyAgent: true },
      directory.get(f.bUser)!,
      directory,
    );
    const sent = await command(f.bSession, {
      type: "team.message.send",
      channelId: f.bid,
      threadRootId: null,
      clientMessageId: randomUUID(),
      ...input,
      mentions: [...input.mentions],
      attachmentIds: [],
    });
    expect(sent.type === "team.message.send" && sent.wake).toBe("queued");
    expect(await f.b.host.team.requests.pending(linkId)).toHaveLength(1);
    expect(await withTeamPeerVersion(5, () => f.b.host.team.requests.pending(linkId))).toEqual([]);
    const internalId = createId("teamChannel");
    await command(f.bSession, {
      type: "team.channel.create",
      id: internalId,
      kind: "private",
      name: "internal-agent",
      peopleOnly: false,
      access: [],
    });
    const internal = await command(f.bSession, {
      type: "team.message.send",
      channelId: internalId,
      threadRootId: null,
      clientMessageId: randomUUID(),
      bodyMarkdown: "@maya-agent Internal request",
      mentions: [],
      attachmentIds: [],
    });
    expect(internal.type === "team.message.send" && internal.wake).toBe("queued");
    const requests = Promise.withResolvers<string[]>();
    const denied = Promise.withResolvers<string>();
    oldLink = new WebSocket(
      new URL("/internal/v1/team/link", f.b.origin).toString().replace(/^http/u, "ws"),
      { headers: { authorization: `Bearer ${credential}`, "x-opensteer-team-api-version": "5" } },
    );
    oldLink.on("message", (bytes) => {
      const frame = TeamLinkServerFrameSchema.parse(JSON.parse(bytes.toString()));
      if (frame.type === "requests")
        requests.resolve(frame.requests.map((row) => row.source.channelId));
      if (frame.type === "error" && frame.id === "old-shared-read")
        denied.resolve(frame.error.message);
    });
    await withTimeout(once(oldLink, "open"), 3000, {
      timeoutError: () => Error("Old personal link never connected"),
    });
    oldLink.send(JSON.stringify({ type: "hello", teamApiVersion: 5, terminalRequests: [] }));
    expect(
      await withTimeout(requests.promise, 3000, {
        timeoutError: () => Error("Old personal link did not receive its internal request"),
      }),
    ).toEqual([internalId]);
    oldLink.send(
      JSON.stringify({
        type: "read",
        id: "old-shared-read",
        channelId: f.bid,
        runId: createId("run"),
      }),
    );
    expect(
      await withTimeout(denied.promise, 3000, {
        timeoutError: () => Error("Old personal link's shared read was not refused"),
      }),
    ).toContain("Update Opensteer");
    const request = (await f.b.host.team.requests.pending(linkId)).find(
      (row) => row.request.channelId === f.bid,
    )!;
    await expect(
      withTeamPeerVersion(5, () => f.b.host.team.requests.accept(linkId, request.request.id)),
    ).rejects.toMatchObject({ reason: "api-version-mismatch" });
  } finally {
    oldLink?.terminate();
    await f.close();
  }
});

it("keeps every offer reachable across bounded pages while newer offers arrive", async () => {
  const f = await sharedFixture();
  try {
    const rows = Array.from({ length: 51 }, (_, i) => ({
      id: randomUUID(),
      channelId: null,
      historyFromShareId: null,
      partnerLinkId: f.bLink,
      role: "follower" as const,
      state: "offered" as const,
      generation: 1,
      name: "Offer " + i,
      peopleOnly: false,
      offeredBy: null,
      acceptedBy: null,
      localApproved: false,
      endedAt: null,
    }));
    await f.b.database.insertInto("teamShares").values(rows).execute();
    const seen = new Set<string>();
    let after: string | undefined;
    do {
      const page = await f.bSession.rpc["team.shares.list"](after ? { after } : {});
      if (!page.ok) throw Error(page.error.message);
      expect(page.data.shares.length).toBeLessThanOrEqual(50);
      for (const share of page.data.shares) {
        expect(seen.has(share.id)).toBe(false);
        seen.add(share.id);
      }
      if (!after) {
        expect(page.data.nextCursor).toBeTruthy();
        await f.b.database
          .insertInto("teamShares")
          .values({ ...rows[0]!, id: randomUUID(), name: "New offer" })
          .execute();
      }
      after = page.data.nextCursor ?? undefined;
    } while (after);
    for (const row of rows) expect(seen.has(row.id), row.name + " became unreachable").toBe(true);
  } finally {
    await f.close();
  }
});
