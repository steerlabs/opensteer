import { describe, expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import { teamApiVersion } from "@opensteer/deployment-authority";
import type { TeamServerFrameSchema } from "@opensteer/protocol";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { TeamOutboxStore } from "@opensteer/database/team-outbox";
import { createLiveTeamFixture as fixture } from "./live-team.test-support.js";

describe("team review regressions", () => {
  it("returns self-removal success after cutting the session, pending push, machine link and request", async () => {
    const f = await fixture();
    let closed = false;
    const peer = f.team.realtime.connect(f.member, {
      send: () => true,
      close: () => {
        closed = true;
      },
    });
    try {
      const session = await f.session(f.member.userId);
      const request = await f.ask();
      await f.connect();
      await f.connection.call({ type: "accept", requestId: request.id });
      await f.database
        .insertInto("accountDirectoryProvider")
        .values({
          singletonKey: "opensteer-account",
          providerId: "review-provider",
          issuer: "https://account.example.invalid",
        })
        .execute();
      await f.database
        .insertInto("authAccounts")
        .values({
          id: createId("authAccount"),
          providerId: "review-provider",
          accountId: `acct_${randomUUID()}`,
          userId: f.member.userId,
        })
        .execute();
      const mention = await f.team.chat.send(f.owner, {
        channelId: f.channel.id,
        threadRootId: null,
        clientMessageId: randomUUID(),
        bodyMarkdown: "Pending push",
        mentions: [{ kind: "person", userId: f.member.userId }],
        attachmentIds: [],
      });
      const headers = new Headers({ "x-opensteer-team-api-version": String(teamApiVersion) });
      const result = await f.team.rpc(
        headers,
        "commands.dispatch",
        { type: "team.member.remove", userId: f.member.userId },
        async () => session,
      );
      expect(result).toEqual({ type: "team.member.remove" });
      expect(closed).toBe(true);
      expect(
        (
          await f.database
            .selectFrom("teamLinks")
            .select("state")
            .where("id", "=", f.linkId)
            .executeTakeFirstOrThrow()
        ).state,
      ).toBe("revoked");
      expect(
        (
          await f.database
            .selectFrom("teamAgentRequests")
            .select("state")
            .where("id", "=", request.id)
            .executeTakeFirstOrThrow()
        ).state,
      ).toBe("cancelled");
      await expect(
        f.team.rpc(headers, "team.bootstrap.get", {}, async () => session),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        f.team.access.withHumanSession(session, () =>
          f.database.transaction().execute((tx) => f.team.access.checkSession(tx)),
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
      const delivered: string[] = [];
      await f.database
        .insertInto("teamOutbox")
        .values({
          kind: "message",
          channelId: f.channel.id,
          messageId: mention.message.id,
          noticeId: null,
          createdAt: new Date(),
        })
        .execute();
      await new TeamOutboxStore(f.team.access).drain(async (delivery) => {
        delivered.push(delivery.userId);
      });
      expect(delivered).not.toContain(f.member.userId);
      await vi.waitFor(() => expect(f.frames).toContainEqual({ type: "revoked" }));
    } finally {
      peer.close();
      await f.close();
    }
  });
  it("snapshots and publishes first-connect, last-disconnect and reconnect link presence", async () => {
    const f = await fixture();
    const frames: z.infer<typeof TeamServerFrameSchema>[] = [];
    const peer = f.team.realtime.connect(f.member, {
      send: (frame) => {
        frames.push(frame);
        return true;
      },
      close() {},
    });
    const subscribe = (generation: number) =>
      peer.receive({
        type: "team.subscribe",
        teamApiVersion,
        subscriptionId: "channel",
        generation,
        sidebar: true,
        scope: { kind: "channel", channelId: f.channel.id },
        sinceSeq: null,
      });
    try {
      const request = await f.ask();
      await subscribe(1);
      const cuts = () => frames.flatMap((frame) => (frame.type === "team.cut" ? [frame.cut] : []));
      expect(cuts().at(-1)?.linkPresence).toEqual([
        { ownerUserId: f.member.userId, online: false },
      ]);
      const first = await f.connect();
      await vi.waitFor(() =>
        expect(frames).toContainEqual({
          type: "team.link.presence",
          userId: f.member.userId,
          online: true,
        }),
      );
      expect(
        (await f.team.chat.directory(f.member, undefined, true)).channels[0]?.agentOnline,
      ).toBe(true);
      await subscribe(2);
      expect(cuts().at(-1)?.linkPresence).toEqual([{ ownerUserId: f.member.userId, online: true }]);
      await f.connect();
      frames.length = 0;
      first.stop();
      await f.waitForSockets(1);
      expect(
        (await f.team.chat.directory(f.member, undefined, true)).channels[0]?.agentOnline,
      ).toBe(true);
      expect(frames).not.toContainEqual({
        type: "team.link.presence",
        userId: f.member.userId,
        online: false,
      });
      await f.disconnect();
      await vi.waitFor(() =>
        expect(frames).toContainEqual({
          type: "team.link.presence",
          userId: f.member.userId,
          online: false,
        }),
      );
      expect(
        (await f.team.chat.directory(f.member, undefined, true)).channels[0]?.agentOnline,
      ).toBe(false);
      await subscribe(3);
      expect(cuts().at(-1)?.linkPresence).toEqual([
        { ownerUserId: f.member.userId, online: false },
      ]);
      frames.length = 0;
      await f.connect();
      await vi.waitFor(() =>
        expect(frames).toContainEqual({
          type: "team.link.presence",
          userId: f.member.userId,
          online: true,
        }),
      );
      await subscribe(4);
      expect(cuts().at(-1)?.linkPresence).toEqual([{ ownerUserId: f.member.userId, online: true }]);
      expect((await f.team.requests.pending(f.linkId))[0]?.request.id).toBe(request.id);
    } finally {
      peer.close();
      await f.close();
    }
  });

  it("withholds inaccessible private channel activity from sidebar-only peers before and after removal", async () => {
    const f = await fixture();
    const frames: z.infer<typeof TeamServerFrameSchema>[] = [];
    const reader = f.actor(await f.addMember("SidebarReader"));
    const peer = f.team.realtime.connect(reader, {
      send: (frame) => {
        frames.push(frame);
        return true;
      },
      close() {},
    });
    try {
      const visible = await f.team.chat.create(f.owner, {
        id: createId("teamChannel"),
        name: "visible",
        kind: "public",
        peopleOnly: false,
        access: [
          { subject: { kind: "person", userId: reader.userId }, level: "post", manage: false },
        ],
      });
      await peer.receive({
        type: "team.subscribe",
        teamApiVersion,
        subscriptionId: "sidebar",
        generation: 1,
        sidebar: true,
        scope: null,
        sinceSeq: null,
      });
      const dirty = () =>
        frames.flatMap((frame) => (frame.type === "team.sidebar.dirty" ? frame.channelIds : []));
      const send = (channelId: typeof visible.id) =>
        f.team.chat.send(f.member, {
          channelId,
          threadRootId: null,
          clientMessageId: randomUUID(),
          bodyMarkdown: "Private activity",
          mentions: [],
          attachmentIds: [],
        });
      const marker = () =>
        f.team.chat.send(reader, {
          channelId: visible.id,
          threadRootId: null,
          clientMessageId: randomUUID(),
          bodyMarkdown: "Visible marker",
          mentions: [],
          attachmentIds: [],
        });
      for (const previouslyAllowed of [false, true]) {
        if (previouslyAllowed) {
          await f.team.chat.setAccess(f.owner, f.channel.id, f.team.access.revision, [
            { subject: { kind: "person", userId: f.member.userId }, level: "post", manage: true },
            { subject: { kind: "person", userId: reader.userId }, level: "read", manage: false },
          ]);
          await send(f.channel.id);
          await vi.waitFor(() => expect(dirty()).toContain(f.channel.id));
          await f.team.chat.setAccess(f.owner, f.channel.id, f.team.access.revision, [
            { subject: { kind: "person", userId: f.member.userId }, level: "post", manage: true },
          ]);
        }
        frames.length = 0;
        await send(f.channel.id);
        await marker();
        await vi.waitFor(() => expect(dirty()).toContain(visible.id));
        expect(dirty()).not.toContain(f.channel.id);
      }
    } finally {
      peer.close();
      await f.close();
    }
  });
  it("keeps a live personal link and request across role changes, no-ops and owner transfer", async () => {
    const f = await fixture();
    try {
      const request = await f.ask();
      await f.connect();
      await f.connection.call({ type: "accept", requestId: request.id });
      for (const role of ["admin", "admin", "member", "owner"] as const) {
        await f.team.members.change(f.owner, f.member.userId, role);
        await vi.waitFor(
          async () => {
            expect(
              await f.connection.call({ type: "context", requestId: request.id }),
            ).toMatchObject({ kind: "context" });
          },
          { timeout: 5000 },
        );
        expect(f.frames.some((frame) => frame.type === "revoked")).toBe(false);
        expect((await f.team.requests.pending(f.linkId))[0]?.request.state).toBe("working");
      }
    } finally {
      await f.close();
    }
  });

  it("cancels an offline queued ask idempotently before any later machine delivery", async () => {
    const f = await fixture();
    try {
      const request = await f.ask();
      const session = await f.session(f.member.userId);
      const cancel = () =>
        f.team.rpc(
          new Headers({ "x-opensteer-team-api-version": String(teamApiVersion) }),
          "commands.dispatch",
          { type: "team.agent.request.cancel", requestId: request.id },
          async () => session,
        );
      expect(await cancel()).toEqual({ type: "team.agent.request.cancel" });
      expect(await cancel()).toEqual({ type: "team.agent.request.cancel" });
      const row = await f.database
        .selectFrom("teamAgentRequests")
        .selectAll()
        .where("id", "=", request.id)
        .executeTakeFirstOrThrow();
      expect(row.state).toBe("cancelled");
      expect(row.finishedAt).not.toBeNull();
      expect(BigInt(row.changeSeq)).toBeGreaterThan(BigInt(request.changeSeq));
      await f.connect();
      expect(await f.team.requests.pending(f.linkId)).toEqual([]);
      expect(
        f.frames.flatMap((frame) => (frame.type === "requests" ? frame.requests : [])),
      ).toEqual([]);
      await expect(f.connection.call({ type: "accept", requestId: request.id })).rejects.toThrow();
    } finally {
      await f.close();
    }
  });

  it("acknowledges committed leave, self-removal and metadata management over RPC", async () => {
    const f = await fixture();
    try {
      const memberSession = await f.session(f.member.userId),
        ownerSession = await f.session(f.owner.userId);
      const rpc = (command: unknown, session = memberSession) =>
        f.team.rpc(
          new Headers({ "x-opensteer-team-api-version": String(teamApiVersion) }),
          "commands.dispatch",
          command,
          async () => session,
        );
      await rpc({
        type: "team.channel.access.set",
        channelId: f.channel.id,
        expectedRevision: f.team.access.revision,
        access: [
          { subject: { kind: "person", userId: f.owner.userId }, level: "post", manage: true },
        ],
      });
      await f.team.chat.setAccess(f.owner, f.channel.id, f.team.access.revision, [
        { subject: { kind: "person", userId: f.member.userId }, level: "post", manage: true },
      ]);
      expect(
        await rpc(
          {
            type: "team.channel.update",
            channelId: f.channel.id,
            name: "renamed",
            peopleOnly: false,
          },
          ownerSession,
        ),
      ).toEqual({ type: "team.channel.update" });
      expect(await rpc({ type: "team.channel.leave", channelId: f.channel.id })).toEqual({
        type: "team.channel.leave",
      });
      expect(await rpc({ type: "team.member.remove", userId: f.member.userId })).toEqual({
        type: "team.member.remove",
      });
    } finally {
      await f.close();
    }
  });

  it("lets admins discover safe link metadata and revoke another member's active transport and request", async () => {
    const f = await fixture();
    try {
      const outsider = f.actor(await f.addMember("Ordinary"));
      const request = await f.ask();
      await f.connect();
      await f.connection.call({ type: "accept", requestId: request.id });
      expect((await f.team.links.list(outsider)).links).toEqual([]);
      await expect(f.team.links.revoke(outsider, f.linkId)).rejects.toMatchObject({
        code: "forbidden",
      });
      const links = await f.team.links.list(f.owner);
      expect(links.links).toContainEqual(
        expect.objectContaining({ id: f.linkId, ownerUserId: f.member.userId }),
      );
      expect(JSON.stringify(links)).not.toMatch(/credentialHash|codeHash|ost_link_/);
      await f.team.links.revoke(f.owner, f.linkId);
      expect(
        (
          await f.database
            .selectFrom("teamAgentRequests")
            .select("state")
            .where("id", "=", request.id)
            .executeTakeFirstOrThrow()
        ).state,
      ).toBe("cancelled");
      await vi.waitFor(() => expect(f.frames).toContainEqual({ type: "revoked" }));
      await expect(f.machine.links.authenticate(f.secret)).rejects.toThrow();
    } finally {
      await f.close();
    }
  });
});
