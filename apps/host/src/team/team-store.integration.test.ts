import { randomUUID, createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { TeamRealtimeHub } from "./realtime.js";
import type { TeamConsistentCut } from "@opensteer/protocol";
import { TeamLinkService } from "./link-service.js";
import { parseTeamLinkOffer } from "@opensteer/protocol";
import { TeamFileService } from "./file-service.js";
import { startTeamServices } from "./services.js";
import {
  TeamLinkIdSchema,
  createId,
  type TeamActor,
  type TeamChannelId,
  type TeamMessageId,
} from "@opensteer/core";
import { createTeamKnowledgeFixture } from "@opensteer/database/test-support/team-knowledge";
import { hostApi } from "@opensteer/protocol";
import { teamApiVersion } from "@opensteer/deployment-authority";
import { sql } from "kysely";
import { TeamAccessStore } from "@opensteer/database/team-access";
import { TeamChatStore } from "@opensteer/database/team-chat";
import { TeamGroupsStore } from "@opensteer/database/team-groups";
import { TeamMembersStore } from "@opensteer/database/team-members";
import { TeamInvitesStore } from "@opensteer/database/team-invites";
import { TeamRequestsStore } from "@opensteer/database/team-requests";
import { TeamOutboxStore, type TeamPushDelivery } from "@opensteer/database/team-outbox";
import { bindTeamFiles, TeamFilesStore } from "@opensteer/database/team-files";

describe("team transaction authority", () => {
  let fixture: Awaited<ReturnType<typeof createTeamKnowledgeFixture>>;
  let access: TeamAccessStore,
    chat: TeamChatStore,
    groups: TeamGroupsStore,
    requests: TeamRequestsStore;
  let owner: TeamActor;
  beforeEach(async () => {
    fixture = await createTeamKnowledgeFixture();
    access = new TeamAccessStore(fixture.database);
    await access.initialize();
    owner = { kind: "human", userId: fixture.userId };
    chat = new TeamChatStore(access, {
      teamId: fixture.deploymentId,
      teamName: "Acme",
    });
    groups = new TeamGroupsStore(access);
    requests = new TeamRequestsStore(access, chat);
  });
  afterEach(async () => {
    await fixture?.close();
  });
  async function person(name: string, role: "member" | "admin" | "owner" = "member") {
    const userId = createId("user");
    await sql`insert into users(id,display_name,email,email_verified) values(${userId},${name},${`${name}@example.invalid`},true)`.execute(
      fixture.database,
    );
    await sql`insert into team_members(user_id,handle,role,state) values(${userId},${name.toLowerCase()},${role},'active')`.execute(
      fixture.database,
    );
    return { kind: "human" as const, userId };
  }
  async function channel(kind: "public" | "private" = "private", peopleOnly = false) {
    return chat.create(owner, {
      id: createId("teamChannel"),
      kind,
      name: randomUUID(),
      peopleOnly,
      access: [],
    });
  }
  async function link(userId = owner.userId, id = createId("teamLink")) {
    await sql`insert into team_links(id,owner_user_id,personal_deployment_id,state,code_hash,credential_hash,code_expires_at) values(${id},${userId},${createId("deployment")},'active',${randomUUID()},${randomUUID()},now())`.execute(
      fixture.database,
    );
    return id;
  }
  async function send(
    channelId: Parameters<TeamChatStore["send"]>[1]["channelId"],
    body = "hello",
    actor = owner,
    mentions: Parameters<TeamChatStore["send"]>[1]["mentions"] = [],
    root: Parameters<TeamChatStore["send"]>[1]["threadRootId"] = null,
  ) {
    const targets = mentions.length
      ? await fixture.database
          .selectFrom("teamMembers")
          .select(["userId", "handle"])
          .where(
            "userId",
            "in",
            mentions.map((m) => m.userId),
          )
          .execute()
      : [];
    const prefix = mentions
      .map(
        (m) =>
          `@${targets.find((r) => r.userId === m.userId)!.handle}${m.kind === "agent" ? "-agent" : ""}`,
      )
      .join(" ");
    return chat.send(actor, {
      channelId,
      bodyMarkdown: prefix ? `${prefix} ${body}` : body,
      clientMessageId: randomUUID(),
      threadRootId: root,
      mentions,
      attachmentIds: [],
    });
  }
  async function rights(actor: TeamActor, id: Parameters<TeamAccessStore["channel"]>[2]) {
    return fixture.database.transaction().execute((t) => access.channel(t, actor, id));
  }
  function services(options: Partial<Parameters<typeof startTeamServices>[0]> = {}) {
    return startTeamServices({
      kind: "team",
      database: fixture.database,
      teamId: fixture.deploymentId,
      teamName: "Acme",
      hostKeyFingerprint: `sha256:${"A".repeat(43)}`,
      origin: "https://team.example.invalid",
      dataDirectory: tmpdir(),
      knowledge: {
        async read() {
          throw new Error("Unexpected knowledge call");
        },
        async command() {
          throw new Error("Unexpected knowledge command");
        },
      },
      async publishPush() {},
      backgroundError() {},
      ...options,
    });
  }
  async function textUpload(files: TeamFileService, actor: TeamActor, channelId: TeamChannelId) {
    const data = Buffer.from(randomUUID());
    return files.upload(
      actor,
      channelId,
      {
        clientUploadId: randomUUID(),
        filename: "notes.txt",
        mediaType: "text/plain",
        sizeBytes: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
        previewSizeBytes: 0,
      },
      {
        original: (async function* () {
          yield data;
        })(),
      },
    );
  }
  it("counts all authorized unread mentions independently of sidebar pages and changed channel filters", async () => {
    const reader = await person("MentionReader");
    const channels = await Promise.all(
      Array.from({ length: 52 }, (_, i) =>
        fixture.channel({
          name: `mention-${i}`,
          kind: "private",
          access: [
            { userId: reader.userId, level: "post" },
            { userId: owner.userId, level: "post", manage: true },
          ],
        }),
      ),
    );
    channels.sort((a, b) => a.channelId.localeCompare(b.channelId));
    const first = await send(channels[0]!.channelId, "First mention", owner, [
      { kind: "person", userId: reader.userId },
    ]);
    const last = await send(channels[51]!.channelId, "Last mention", owner, [
      { kind: "person", userId: reader.userId },
    ]);
    const page = await chat.directory(reader, undefined, true);
    expect(page.channels).toHaveLength(50);
    expect(page.totalMentionCount).toBe(2);
    expect(page.channels.reduce((sum, row) => sum + row.mentionCount, 0)).toBe(1);
    expect((await chat.directory(reader, page.nextCursor!, true)).totalMentionCount).toBe(2);
    expect(
      (await chat.directory(reader, undefined, true, [channels[1]!.channelId])).totalMentionCount,
    ).toBe(2);
    await chat.readMarker(reader, channels[0]!.channelId, first.message.id);
    expect((await chat.directory(reader, undefined, true)).totalMentionCount).toBe(1);
    await chat.setAccess(owner, channels[51]!.channelId, access.revision, [
      { subject: { kind: "person", userId: owner.userId }, level: "post", manage: true },
    ]);
    expect((await chat.directory(reader, undefined, true)).totalMentionCount).toBe(0);
    expect(last.message.mentions).toHaveLength(1);
  });

  it("filters thread replies in SQL before search pagination and excludes inaccessible channels", async () => {
    const reader = await person("ThreadSearchReader");
    const c = await channel();
    await chat.setAccess(owner, c.id, access.revision, [
      { subject: { kind: "person", userId: owner.userId }, level: "post", manage: true },
      { subject: { kind: "person", userId: reader.userId }, level: "read", manage: false },
    ]);
    const root = await send(c.id, "Needle root");
    const reply = await send(c.id, "Needle reply", owner, [], root.message.id);
    await access.contentWrite(owner, c.id, (t) =>
      t
        .insertInto("teamMessages")
        .values(
          Array.from({ length: 51 }, (_, i) => ({
            channelId: c.id,
            threadRootId: null,
            authorUserId: owner.userId,
            authorKind: "human" as const,
            agentRequestId: null,
            clientMessageId: randomUUID(),
            bodyMarkdown: `Needle later root ${i}`,
            plainText: `Needle later root ${i}`,
            createdAt: new Date(),
            editedAt: null,
            deletedAt: null,
            changeSeq: root.message.changeSeq,
          })),
        )
        .execute(),
    );
    const hidden = await channel();
    const hiddenRoot = await send(hidden.id, "Needle hidden root");
    await send(hidden.id, "Needle hidden reply", owner, [], hiddenRoot.message.id);
    const results = await chat.search(reader, { query: "Needle", threadsOnly: true });
    expect(results.results.map((row) => row.message.id)).toEqual([reply.message.id]);
    expect(results.hasMore).toBe(false);
    expect(
      (await chat.search(reader, { query: "Needle", threadsOnly: false })).results,
    ).toHaveLength(50);
  });
  it("resolves nested paths, read vs post, last path, public join and people-only", async () => {
    const member = await person("Sam");
    const c = await channel("public");
    expect((await rights(member, c.id)).read).toBe(false);
    await chat.joinOrLeave(member, c.id, true);
    expect((await rights(member, c.id)).post).toBe(true);
    await chat.joinOrLeave(member, c.id, false);
    const a = createId("teamGroup"),
      b = createId("teamGroup");
    await groups.create(owner, a, "A");
    await groups.create(owner, b, "B");
    await groups.child(owner, a, b, true);
    await groups.person(owner, b, member.userId, true);
    await chat.setAccess(owner, c.id, access.revision, [
      { subject: { kind: "person", userId: owner.userId }, level: "post", manage: true },
      { subject: { kind: "group", groupId: a }, level: "read", manage: false },
      { subject: { kind: "person", userId: member.userId }, level: "read", manage: false },
    ]);
    expect(await rights(member, c.id)).toMatchObject({ read: true, post: false });
    await groups.person(owner, b, member.userId, false);
    expect((await rights(member, c.id)).read).toBe(true);
    await chat.setAccess(owner, c.id, access.revision, [
      { subject: { kind: "person", userId: owner.userId }, level: "post", manage: true },
    ]);
    expect((await rights(member, c.id)).read).toBe(false);
    await chat.update(owner, c.id, { peopleOnly: true });
    expect(await rights({ ...owner, kind: "agent" }, c.id)).toMatchObject({
      read: false,
      post: false,
      manage: false,
    });
    expect((await rights(owner, c.id)).read).toBe(true);
  });
  it("gives an agent its owner's nested topic access without manage, and keeps people-only channels from it", async () => {
    const member = await person("TopicReader"),
      agent = { ...member, kind: "agent" as const };
    const group = createId("teamGroup"),
      topicId = createId("knowledgeTopic");
    await groups.create(owner, group, "Topic readers");
    await groups.person(owner, group, member.userId, true);
    await sql`insert into team_topics(id,name,created_by) values(${topicId},'Shared',${owner.userId})`.execute(
      fixture.database,
    );
    await access.mutate(async (t) => {
      await t
        .insertInto("teamTopicGrants")
        .values({
          topicId,
          subjectKind: "group",
          subjectId: group,
          level: "read",
          addedBy: owner.userId,
          addedAt: new Date(),
        })
        .execute();
      return {
        value: undefined,
        effects: { users: [], channels: [], topics: [topicId], links: [], requests: [] },
      };
    });
    const topicRights = (actor: TeamActor) =>
      fixture.database.transaction().execute((t) => access.topic(t, actor, topicId));
    expect(await topicRights(agent)).toEqual({ read: true, write: false, manage: false });
    expect(await topicRights(member)).toEqual({ read: true, write: false, manage: false });
    expect(await topicRights(owner)).toEqual({ read: false, write: false, manage: true });
    const c = await channel("private", true);
    await chat.setAccess(owner, c.id, access.revision, [
      { subject: { kind: "person", userId: owner.userId }, level: "post", manage: true },
      { subject: { kind: "group", groupId: group }, level: "post", manage: false },
    ]);
    const message = await send(c.id, "confidential phrase");
    await expect(chat.page(agent, c.id)).rejects.toThrow();
    await expect(chat.message(agent, c.id, message.message.id)).rejects.toThrow();
    expect((await chat.search(agent, { query: "confidential" })).results).toEqual([]);
    expect((await chat.directory(agent)).channels).toEqual([]);
    await chat.update(owner, c.id, { peopleOnly: false });
    expect((await chat.message(member, c.id, message.message.id)).bodyMarkdown).toBe(
      "confidential phrase",
    );
    const admin = await person("TopicAdmin", "admin");
    await access.mutateAs(admin, "topic.access.set", async (t) => {
      await t
        .insertInto("teamTopicGrants")
        .values([
          {
            topicId,
            subjectKind: "person",
            subjectId: admin.userId,
            level: "read",
            addedBy: admin.userId,
            addedAt: new Date(),
          },
          {
            topicId,
            subjectKind: "person",
            subjectId: owner.userId,
            level: "manage",
            addedBy: admin.userId,
            addedAt: new Date(),
          },
        ])
        .execute();
      return {
        value: undefined,
        effects: { users: [], channels: [], topics: [topicId], links: [], requests: [] },
      };
    });
    expect(
      await fixture.database
        .selectFrom("teamAudit")
        .select("id")
        .where("action", "=", "admin.self-added")
        .where("resourceId", "=", topicId)
        .execute(),
    ).toHaveLength(1);
    expect(
      await fixture.database
        .selectFrom("teamNotices")
        .select("id")
        .where("recipientUserId", "=", owner.userId)
        .execute(),
    ).toHaveLength(1);
    await new TeamMembersStore(access).change(member, member.userId, "remove");
    expect((await topicRights(member)).read).toBe(false);
  });

  it("serializes concurrent cycles and keeps the last owner", async () => {
    const a = createId("teamGroup"),
      b = createId("teamGroup");
    await groups.create(owner, a, "A");
    await groups.create(owner, b, "B");
    const results = await Promise.allSettled([
      groups.child(owner, a, b, true),
      groups.child(owner, b, a, true),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await expect(
      new TeamMembersStore(access).change(owner, owner.userId, "remove"),
    ).rejects.toThrow("last owner");
  });
  it("shows admins metadata only, audits indirect self-add and notifies managers, and refuses DM self-add", async () => {
    const admin = await person("Admin", "admin");
    const c = await channel();
    expect(await rights(admin, c.id)).toMatchObject({ read: false, manage: true });
    await expect(chat.page(admin, c.id)).rejects.toThrow();
    const g = createId("teamGroup");
    await groups.create(owner, g, "Admins");
    await chat.setAccess(owner, c.id, access.revision, [
      { subject: { kind: "person", userId: owner.userId }, level: "post", manage: true },
      { subject: { kind: "group", groupId: g }, level: "post", manage: false },
    ]);
    await groups.person(admin, g, admin.userId, true);
    expect((await rights(admin, c.id)).read).toBe(true);
    expect(
      await fixture.database
        .selectFrom("teamAudit")
        .select("id")
        .where("action", "=", "admin.self-added")
        .execute(),
    ).toHaveLength(1);
    expect(
      await fixture.database
        .selectFrom("teamNotices")
        .select("id")
        .where("recipientUserId", "=", owner.userId)
        .execute(),
    ).toHaveLength(1);
    const member = await person("Pat");
    const dm = await chat.openDm(owner, [member.userId]);
    await expect(chat.setAccess(admin, dm.id, access.revision, [])).rejects.toThrow();
    await expect(chat.addDmPeople(admin, dm.id, [admin.userId], true)).rejects.toThrow();
  });
  it("admits only human own-agent mentions, only once, with an active link; edits never wake", async () => {
    const c = await channel();
    const events: { kind: string; state: string | undefined }[] = [];
    const stop = chat.onRequestChange(async (event) => {
      const row = await fixture.database
        .selectFrom("teamAgentRequests")
        .select("state")
        .where("id", "=", event.requestId)
        .executeTakeFirst();
      events.push({ kind: event.kind, state: row?.state });
    });
    expect((await send(c.id, "ask", owner, [{ kind: "agent", userId: owner.userId }])).wake).toBe(
      "no-link",
    );
    const l = await link();
    const sent = await send(c.id, "ask", owner, [{ kind: "agent", userId: owner.userId }]);
    expect(sent.wake).toBe("queued");
    const queued = await requests.pending(l);
    expect(queued).toHaveLength(1);
    await chat.send(owner, {
      channelId: c.id,
      bodyMarkdown: "changed",
      clientMessageId: sent.message.clientMessageId,
      threadRootId: null,
      mentions: [],
      attachmentIds: [],
    });
    expect(await requests.pending(l)).toHaveLength(1);
    await chat.editOrDelete(owner, c.id, sent.message.id, {
      bodyMarkdown: "edit",
      mentions: [{ kind: "agent", userId: owner.userId }],
    });
    expect(await requests.pending(l)).toHaveLength(1);
    expect(events).toEqual([{ kind: "queued", state: "queued" }]);
    const accepted = await requests.accept(l, queued[0]!.request.id);
    const again = await requests.accept(l, accepted.id);
    expect(again.expiresAt).toBe(accepted.expiresAt);
    expect(Date.parse(accepted.expiresAt!) - Date.parse(accepted.acceptedAt!)).toBe(7 * 86400000);
    const replyId = await requests.reply(l, accepted.id, {
      bodyMarkdown: "answer",
      attachmentIds: [],
    });
    expect(await requests.reply(l, accepted.id, { bodyMarkdown: "retry", attachmentIds: [] })).toBe(
      replyId,
    );
    expect((await requests.authorize(l, accepted.id, "read")).state).toBe("working");
    await requests.status(l, accepted.id, { state: "done", steps: [] });
    await expect(requests.authorize(l, accepted.id, "read")).rejects.toThrow();
    expect(await requests.receipt(l, accepted.id)).toBe(replyId);
    const cancelled = await send(c.id, "delete me", owner, [
      { kind: "agent", userId: owner.userId },
    ]);
    await chat.editOrDelete(owner, c.id, cancelled.message.id, null);
    expect(events).toEqual([
      { kind: "queued", state: "queued" },
      { kind: "queued", state: "queued" },
      { kind: "cancelled", state: "cancelled" },
    ]);
    stop();
  });
  it("notifies former managers when an admin replaces a restricted channel ACL with themselves", async () => {
    const admin = await person("ReplacingAdmin", "admin");
    const c = await channel();
    await chat.setAccess(admin, c.id, access.revision, [
      { subject: { kind: "person", userId: admin.userId }, level: "post", manage: true },
    ]);
    expect(
      await fixture.database.selectFrom("teamNotices").select("recipientUserId").execute(),
    ).toEqual([{ recipientUserId: owner.userId }]);
  });

  it("restores both participants' access to their immutable DM after re-admission", async () => {
    const member = await person("ReturningMember");
    const dm = await chat.openDm(owner, [member.userId]);
    await send(dm.id, "Before departure");
    await new TeamMembersStore(access).change(owner, member.userId, "remove");
    await expect(chat.page(member, dm.id)).rejects.toThrow();
    const invites = new TeamInvitesStore(access, "https://team.example.invalid");
    const invitation = new URL((await invites.create(owner, createId("teamInvite"))).url);
    await invites.accept(
      member.userId,
      invitation.pathname.split("/").pop()!,
      invitation.hash.slice(1),
    );
    expect((await chat.openDm(member, [owner.userId])).id).toBe(dm.id);
    expect((await chat.openDm(owner, [member.userId])).id).toBe(dm.id);
    expect((await chat.page(member, dm.id)).messages[0]?.bodyMarkdown).toBe("Before departure");
  });
  it("sets a thread recipient idempotently and returns only the viewer's state on resume", async () => {
    const c = await channel("public");
    const root = await send(c.id, "A thread");
    const member = await person("recipient-viewer");
    await chat.joinOrLeave(member, c.id, true);
    await chat.setAgentRecipient(owner, c.id, root.message.id, true);
    await chat.setAgentRecipient(owner, c.id, root.message.id, true);
    expect(await chat.agentRecipient(owner, c.id, root.message.id)).toEqual({
      channelId: c.id,
      rootId: root.message.id,
      enabled: true,
      version: "1",
    });
    expect(await chat.agentRecipient(member, c.id, root.message.id)).toEqual({
      channelId: c.id,
      rootId: root.message.id,
      enabled: false,
      version: "0",
    });
    const input = {
      subscriptionId: "recipients",
      generation: 1,
      scope: { kind: "thread" as const, channelId: c.id, rootId: root.message.id },
      sinceSeq: null,
    };
    const snapshot = await chat.resume(owner, input);
    expect(snapshot.agentRecipients).toEqual([
      { channelId: c.id, rootId: root.message.id, enabled: true, version: "1" },
    ]);
    expect((await chat.resume(member, input)).agentRecipients).toEqual([]);
    await chat.setAgentRecipient(owner, c.id, root.message.id, false);
    expect(
      (await chat.resume(owner, { ...input, sinceSeq: snapshot.throughSeq })).agentRecipients,
    ).toEqual([{ channelId: c.id, rootId: root.message.id, enabled: false, version: "2" }]);
    await chat.setAgentRecipient(owner, c.id, root.message.id, true);
    const hub = new TeamRealtimeHub(access, chat);
    const cuts: [TeamConsistentCut[], TeamConsistentCut[]] = [[], []];
    const peers = [owner, member].map((actor, index) =>
      hub.connect(actor, {
        send(frame) {
          if (frame.type === "team.cut") cuts[index]!.push(frame.cut);
          return true;
        },
        close() {},
      }),
    );
    try {
      for (const peer of peers)
        await peer.receive({ type: "team.subscribe", ...input, teamApiVersion, sidebar: false });
      await send(c.id, "new reply", owner, [], root.message.id);
      await vi.waitFor(() => expect(cuts[1].length).toBeGreaterThan(1), { timeout: 3000 });
      expect(cuts[0].at(-1)!.agentRecipients).toEqual([
        { channelId: c.id, rootId: root.message.id, enabled: true, version: "3" },
      ]);
      expect(cuts[1].at(-1)!.agentRecipients).toEqual([]);
    } finally {
      hub.close();
    }
  });
  it.each(["tool", "publication", "none"] as const)(
    "separates reply publication from terminal status with %s claim",
    async (claim) => {
      const c = await channel();
      const l = await link();
      const root = await send(c.id, "ask", owner, [{ kind: "agent", userId: owner.userId }]);
      const request = (await requests.pending(l))[0]!.request;
      await requests.accept(l, request.id);
      const post = {
        channelId: c.id,
        threadRootId: root.message.id,
        requestId: request.id,
        clientMessageId: randomUUID(),
        bodyMarkdown: "answer",
        attachmentIds: [],
      };
      const replyId =
        claim === "none"
          ? null
          : (await requests.post(l, { ...post, publication: claim === "publication" })).messageId;
      if (claim !== "none") {
        expect(
          (
            await requests.post(l, {
              ...post,
              clientMessageId: randomUUID(),
              publication: true,
              bodyMarkdown: "automatic final",
            })
          ).messageId,
        ).toBe(replyId);
      }
      expect(await requests.receipt(l, request.id)).toBe(replyId);
      expect((await requests.authorize(l, request.id, "read")).state).toBe("working");
      const row = () =>
        fixture.database
          .selectFrom("teamAgentRequests")
          .selectAll()
          .where("id", "=", request.id)
          .executeTakeFirstOrThrow();
      expect((await row()).finishedAt).toBeNull();
      await requests.status(l, request.id, { state: "done", steps: [] });
      const finished = await row();
      expect(finished).toMatchObject({ state: "done", replyMessageId: replyId });
      expect(finished.finishedAt).not.toBeNull();
      await requests.status(l, request.id, {
        state: "done",
        steps: [{ kind: "read_files", count: 1 }],
      });
      expect(await row()).toEqual(finished);
      expect(
        await fixture.database
          .selectFrom("teamMessages")
          .select("id")
          .where("channelId", "=", c.id)
          .where("authorKind", "=", "agent")
          .execute(),
      ).toEqual(replyId ? [{ id: replyId }] : []);
    },
  );

  it("keeps history out of context and carries the original ask on request frames", async () => {
    const c = await channel();
    const l = await link();
    const root = await send(c.id, "original ask " + "x".repeat(12000), owner, [
      { kind: "agent", userId: owner.userId },
    ]);
    for (let i = 0; i < 55; i++) await send(c.id, `later reply ${i}`, owner, [], root.message.id);
    const request = (await requests.pending(l))[0]!.request;
    await requests.accept(l, request.id);
    const context = await requests.context(l, request.id);
    expect(context).not.toHaveProperty("messages");
    expect(context.instructionsRevision).toBe(c.instructionsRevision);
    expect((await requests.pending(l)).find((r) => r.request.id === request.id)?.bodyMarkdown).toBe(
      root.message.bodyMarkdown,
    );
    expect(context.request.triggerMessageId).toBe(root.message.id);
  });

  it("fences pending requests across people-only then clear and prevents later buffered delivery", async () => {
    const c = await channel();
    const l = await link();
    await send(c.id, "ask", owner, [{ kind: "agent", userId: owner.userId }]);
    const request = (await requests.pending(l))[0]!.request;
    const revision = access.revision;
    let delivered = false;
    await chat.update(owner, c.id, { peopleOnly: true });
    await expect(
      access.handoff(
        revision,
        async () => (await rights({ ...owner, kind: "agent" }, c.id)).read,
        () => {
          delivered = true;
        },
      ),
    ).rejects.toThrow();
    expect(delivered).toBe(false);
    await chat.update(owner, c.id, { peopleOnly: false });
    expect(await requests.pending(l)).toHaveLength(0);
    await expect(requests.accept(l, request!.id)).rejects.toThrow();
  });
  it("refreshes root summaries on reply deletion and advances filtered watermarks across compacted rows", async () => {
    const c = await channel();
    const root = await send(c.id);
    const reply = await send(c.id, "reply", owner, [], root.message.id);
    const before = reply.message.changeSeq;
    await chat.editOrDelete(owner, c.id, reply.message.id, null);
    const cut = await chat.resume(owner, {
      subscriptionId: "c",
      generation: 1,
      scope: { kind: "channel", channelId: c.id },
      sinceSeq: before,
    });
    expect(cut.type).toBe("resumed");
    if (cut.type === "resumed") expect(cut.changedRows[0]?.replySummary.count).toBe(0);
    await chat.update(owner, c.id, { instructionsMarkdown: "new instructions" });
    await chat.update(owner, c.id, { instructionsMarkdown: "latest" });
    const thread = await chat.resume(owner, {
      subscriptionId: "t",
      generation: 1,
      scope: { kind: "thread", channelId: c.id, rootId: root.message.id },
      sinceSeq: before,
    });
    expect(thread.channel.instructionsMarkdown).toBe("latest");
    expect(BigInt(thread.throughSeq)).toBeGreaterThan(BigInt(before));
  });
  it("search and file admission use current actor ACL", async () => {
    const c = await channel();
    await send(c.id, "sensitive zebra");
    await chat.update(owner, c.id, { peopleOnly: true });
    expect(
      (await chat.search({ ...owner, kind: "agent" }, { query: "zebra" })).results,
    ).toHaveLength(0);
    expect((await chat.search(owner, { query: "zebra" })).results).toHaveLength(1);
    const member = await person("Guest");
    const files = new TeamFilesStore(access);
    await expect(
      files.begin(member, c.id, {
        clientUploadId: randomUUID(),
        filename: "a",
        mediaType: "text/plain",
        sizeBytes: 1,
        sha256: createHash("sha256").update("a").digest("hex"),
        previewSizeBytes: 0,
      }),
    ).rejects.toThrow();
  });
  it("reserves team storage atomically and refuses an upload past the limit", async () => {
    const c = await channel();
    const preview = 64 * 1024;
    const files = new TeamFilesStore(access, { storageLimitBytes: preview + 100 });
    const metadata = (sizeBytes: number, mediaType = "text/plain") => ({
      clientUploadId: randomUUID(),
      filename: "a",
      mediaType,
      sizeBytes,
      sha256: "0".repeat(64),
      previewSizeBytes: mediaType.startsWith("image/") ? 10 : 0,
    });
    const first = metadata(30, "image/png");
    await files.begin(owner, c.id, first);
    // An unfinished image holds the largest preview it may still send, so a small declared
    // preview cannot squeeze one in; and only images carry previews at all.
    await expect(files.begin(owner, c.id, metadata(10, "image/png"))).rejects.toMatchObject({
      reason: "team-storage-full",
    });
    await expect(
      files.begin(owner, c.id, { ...metadata(10), previewSizeBytes: 10 }),
    ).rejects.toThrow();
    const racing = await Promise.allSettled([
      files.begin(owner, c.id, metadata(50)),
      files.begin(owner, c.id, metadata(50)),
    ]);
    expect(racing.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(racing.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "resource_exhausted", reason: "team-storage-full" },
    });
    await expect(files.begin(owner, c.id, metadata(21))).rejects.toMatchObject({
      reason: "team-storage-full",
    });
    await files.begin(owner, c.id, metadata(20));
    await expect(files.begin(owner, c.id, first)).resolves.toMatchObject({ sizeBytes: "30" });
  });
  it("frees a deleted message's files, on disk and against the limit, before the command returns", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-team-files-"));
    const team = await services({ dataDirectory, storageLimitBytes: 60 });
    try {
      const c = await channel();
      const file = await textUpload(team.files, owner, c.id);
      const sent = await team.dispatch(owner, {
        type: "team.message.send",
        channelId: c.id,
        threadRootId: null,
        clientMessageId: randomUUID(),
        bodyMarkdown: "notes",
        mentions: [],
        attachmentIds: [file.id],
      });
      await expect(textUpload(team.files, owner, c.id)).rejects.toMatchObject({
        reason: "team-storage-full",
      });
      expect(await readdir(join(dataDirectory, "team-files"))).toContain(file.id);
      await team.dispatch(owner, {
        type: "team.message.delete",
        channelId: c.id,
        messageId: (sent as { message: { id: TeamMessageId } }).message.id,
      });
      expect(await readdir(join(dataDirectory, "team-files"))).not.toContain(file.id);
      await expect(textUpload(team.files, owner, c.id)).resolves.toMatchObject({
        sizeBytes: 36,
      });
    } finally {
      await team.close();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });
  it("never reclaims an expired upload that a message is attaching", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opensteer-team-files-"));
    const files = new TeamFileService(new TeamFilesStore(access), access, directory);
    const release = Promise.withResolvers<void>();
    try {
      const c = await channel();
      const file = await textUpload(files, owner, c.id);
      await fixture.database
        .updateTable("teamBlobs")
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where("id", "=", file.id)
        .execute();
      const sent = await send(c.id);
      const message = await fixture.database
        .selectFrom("teamMessages")
        .selectAll()
        .where("id", "=", sent.message.id)
        .executeTakeFirstOrThrow();
      const bound = Promise.withResolvers<void>();
      const binding = fixture.database.transaction().execute(async (t) => {
        await bindTeamFiles(t, owner, message, [file.id]);
        bound.resolve();
        await withTimeout(release.promise, 5000, {
          timeoutError: () => new Error("Attach fixture was never released"),
        });
      });
      await withTimeout(bound.promise, 5000, {
        timeoutError: () => new Error("Attach never locked its file"),
      });
      let settled = false;
      const collecting = files.collectGarbage().finally(() => {
        settled = true;
      });
      collecting.catch(() => undefined);
      await vi.waitFor(
        async () => {
          const { waiting } = await sql<{
            waiting: number;
          }>`select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`
            .execute(fixture.database)
            .then((result) => result.rows[0]!);
          expect(settled || waiting > 0, "Collection neither finished nor waited").toBe(true);
        },
        { timeout: 5000 },
      );
      release.resolve();
      await binding;
      await collecting;
      await files.collectGarbage();
      await expect(
        fixture.database
          .selectFrom("teamBlobs")
          .select("state")
          .where("id", "=", file.id)
          .executeTakeFirst(),
      ).resolves.toEqual({ state: "ready" });
      expect(await readdir(join(directory, "team-files"))).toContain(file.id);
    } finally {
      release.resolve();
      files.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("releases a removed member's unsent uploads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opensteer-team-files-"));
    const files = new TeamFileService(new TeamFilesStore(access), access, directory);
    try {
      const c = await channel();
      const member = await person("Leaver");
      await chat.setAccess(owner, c.id, access.revision, [
        { subject: { kind: "person", userId: owner.userId }, level: "post", manage: true },
        { subject: { kind: "person", userId: member.userId }, level: "post", manage: false },
      ]);
      const unsent = await textUpload(files, member, c.id);
      const kept = await textUpload(files, owner, c.id);
      await new TeamMembersStore(access).change(owner, member.userId, "remove");
      await expect(
        fixture.database.transaction().execute((t) => access.member(t, member.userId)),
      ).rejects.toMatchObject({ code: "forbidden", reason: "removed" });
      await files.collectGarbage();
      const remaining = await fixture.database.selectFrom("teamBlobs").select("id").execute();
      expect(remaining.map((row) => row.id)).toEqual([kept.id]);
      const stored = await readdir(join(directory, "team-files"));
      expect(stored).not.toContain(unsent.id);
      expect(stored).toContain(kept.id);
    } finally {
      files.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("consumes a one-use invite atomically and never revives an old membership generation", async () => {
    const member = await person("Invitee");
    await fixture.database.deleteFrom("teamMembers").where("userId", "=", member.userId).execute();
    const invites = new TeamInvitesStore(access, "https://team.example.invalid");
    const created = await invites.create(owner, createId("teamInvite"));
    const url = new URL(created.url);
    const selector = url.pathname.split("/").pop()!;
    const a = await invites.accept(member.userId, selector, url.hash.slice(1));
    const b = await invites.accept(member.userId, selector, url.hash.slice(1));
    expect(a.generation).toBe(b.generation);
    await new TeamMembersStore(access).change(owner, member.userId, "remove");
    await expect(invites.accept(member.userId, selector, url.hash.slice(1))).rejects.toThrow();
  });

  it("mints hashed ten-minute link codes, replaces only pending codes, and revokes requests before returning", async () => {
    const links = new TeamLinkService(access, {
      teamName: "Acme",
      teamId: fixture.deploymentId,
      origin: "https://team.example.invalid",
      hostKeyFingerprint: `sha256:${"A".repeat(43)}`,
    });
    const c = await channel(),
      active = await link();
    const first = await links.createCode(owner);
    expect(first.replacing?.id).toBe(active);
    const offer = parseTeamLinkOffer(first.offer)!;
    expect(offer.teamId).toBe(fixture.deploymentId);
    const pending = await fixture.database
      .selectFrom("teamLinks")
      .selectAll()
      .where("state", "=", "pending")
      .executeTakeFirstOrThrow();
    expect(pending.codeHash).toBe(createHash("sha256").update(offer.code).digest("hex"));
    expect(pending.codeHash).not.toContain(offer.code);
    expect(pending.codeExpiresAt.getTime() - Date.now()).toBeLessThanOrEqual(600000);
    expect(pending.codeExpiresAt.getTime() - Date.now()).toBeGreaterThan(590000);
    await links.createCode(owner);
    expect(
      (
        await fixture.database
          .selectFrom("teamLinks")
          .select("state")
          .where("id", "=", pending.id)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe("revoked");
    expect((await links.list(owner)).links).toHaveLength(2);
    const stranger = await person("LinkStranger");
    await expect(links.revoke(stranger, active)).rejects.toThrow();
    await send(c.id, "queued ask", owner, [{ kind: "agent", userId: owner.userId }]);
    const request = (await requests.pending(active))[0]!.request;
    let closed = false;
    const stop = access.onRevoke(async (effects) => {
      if (!effects.links.includes(active)) return;
      expect(
        (
          await fixture.database
            .selectFrom("teamAgentRequests")
            .select("state")
            .where("id", "=", request.id)
            .executeTakeFirstOrThrow()
        ).state,
      ).toBe("cancelled");
      closed = true;
    });
    try {
      await links.revoke(owner, active);
      expect(closed).toBe(true);
    } finally {
      stop();
    }
    await expect(requests.accept(active, request.id)).rejects.toThrow();
    expect((await links.list(owner)).links.map((row) => row.state)).toEqual(["pending"]);
  });

  it("lists an admin's own links first, however many others the team has", async () => {
    const links = new TeamLinkService(access, {
      teamName: "Acme",
      teamId: fixture.deploymentId,
      origin: "https://team.example.invalid",
      hostKeyFingerprint: `sha256:${"A".repeat(43)}`,
    });
    // Each person holds one active link, so this is sixty other people's.
    for (let index = 0; index < 60; index += 1) await link((await person(`Other${index}`)).userId);
    // Sorts after every other link by id.
    const mine = await link(
      owner.userId,
      TeamLinkIdSchema.parse(
        `${createId("teamLink").split("_")[0]}_ffffffff-ffff-4fff-bfff-ffffffffffff`,
      ),
    );
    const listed = (await links.list(owner)).links;
    expect(listed).toHaveLength(50);
    expect(listed[0]?.id).toBe(mine);
  });

  it("holds the content share lock through commit and rechecks posts after the last access path is removed", async () => {
    const member = await person("Writer");
    const c = await channel();
    await chat.setAccess(owner, c.id, access.revision, [
      { subject: { kind: "person", userId: owner.userId }, level: "post", manage: true },
      { subject: { kind: "person", userId: member.userId }, level: "post", manage: false },
    ]);
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const writer = access.contentWrite(member, c.id, async (t, a) => {
      expect(a.post).toBe(true);
      entered.resolve();
      await withTimeout(release.promise, 5000, {
        timeoutError: () => new Error("Content writer was never released"),
      });
      return chat.insert(t, member, {
        channelId: c.id,
        threadRootId: null,
        clientMessageId: randomUUID(),
        bodyMarkdown: "committed before removal",
        mentions: [],
        attachmentIds: [],
      });
    });
    await withTimeout(entered.promise, 5000, {
      timeoutError: () => new Error("Content writer never acquired SHARE"),
    });
    const removal = chat.setAccess(owner, c.id, access.revision, [
      { subject: { kind: "person", userId: owner.userId }, level: "post", manage: true },
    ]);
    try {
      await vi.waitFor(
        async () => {
          const blocked = await sql<{
            count: string;
          }>`select count(*)::text as count from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%team_access_state%'`.execute(
            fixture.database,
          );
          expect(Number(blocked.rows[0]?.count)).toBeGreaterThan(0);
        },
        { timeout: 3000 },
      );
    } finally {
      release.resolve();
    }
    await writer;
    await removal;
    await expect(send(c.id, "too late", member)).rejects.toThrow();
  });

  it("refuses an old human session's pending post after removal and re-admission", async () => {
    const member = await person("GenerationReader"),
      c = await channel();
    const entries = [
      {
        subject: { kind: "person" as const, userId: owner.userId },
        level: "post" as const,
        manage: true,
      },
      {
        subject: { kind: "person" as const, userId: member.userId },
        level: "post" as const,
        manage: false,
      },
    ];
    await chat.setAccess(owner, c.id, access.revision, entries);
    const session = {
      id: createId("authSession"),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      absoluteExpiresAt: new Date(Date.now() + 60000).toISOString(),
      user: {
        id: member.userId,
        displayName: "GenerationReader",
        email: "GenerationReader@example.invalid",
        emailVerified: true,
        image: null,
        disabledAt: null,
      },
    };
    await fixture.database
      .insertInto("authSessions")
      .values({
        id: session.id,
        userId: member.userId,
        token: randomUUID(),
        memberGeneration: "1",
        deviceLabel: "Old login",
        expiresAt: new Date(session.expiresAt),
        absoluteExpiresAt: new Date(session.absoluteExpiresAt),
      })
      .execute();
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const post = access.withHumanSession(session, async () => {
      entered.resolve();
      await withTimeout(release.promise, 10000, {
        timeoutError: () => new Error("Old session post was not released"),
      });
      return send(c.id, "old login", member);
    });
    const outcome = post.then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await withTimeout(entered.promise, 5000, {
        timeoutError: () => new Error("Old login was not authenticated"),
      });
      await new TeamMembersStore(access).change(owner, member.userId, "remove");
      const invites = new TeamInvitesStore(access, "https://team.example.invalid");
      const invite = new URL((await invites.create(owner, createId("teamInvite"))).url);
      await invites.accept(member.userId, invite.pathname.split("/").pop()!, invite.hash.slice(1));
      await chat.setAccess(owner, c.id, access.revision, entries);
      expect((await rights(member, c.id)).post).toBe(true);
    } finally {
      release.resolve();
    }
    expect(
      await withTimeout(outcome, 5000, {
        timeoutError: () => new Error("Old session post did not settle"),
      }),
    ).toMatchObject({ message: "Team session generation changed" });
    expect(
      await fixture.database
        .selectFrom("teamMessages")
        .select("id")
        .where("authorUserId", "=", member.userId)
        .execute(),
    ).toEqual([]);
  });

  it("discards an already buffered page when removal returns before handoff", async () => {
    const member = await person("Reader");
    const c = await channel();
    await chat.setAccess(owner, c.id, access.revision, [
      { subject: { kind: "person", userId: owner.userId }, level: "post", manage: true },
      { subject: { kind: "person", userId: member.userId }, level: "read", manage: false },
    ]);
    await send(c.id, "private data");
    const buffered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const page = chat.read(member, "read", c.id, async (t) => {
      const value = await chat.pageIn(t, member, c.id, { direction: "newest" });
      buffered.resolve();
      await withTimeout(release.promise, 5000, {
        timeoutError: () => new Error("Buffered response was never released"),
      });
      return value;
    });
    const outcome = page.then(
      () => "delivered",
      () => "denied",
    );
    await withTimeout(buffered.promise, 5000, {
      timeoutError: () => new Error("Page never reached its handoff barrier"),
    });
    try {
      await chat.setAccess(owner, c.id, access.revision, [
        { subject: { kind: "person", userId: owner.userId }, level: "post", manage: true },
      ]);
    } finally {
      release.resolve();
    }
    expect(await outcome).toBe("denied");
  });

  it("serializes two owner departures and keeps exactly one active owner", async () => {
    const second = await person("Second", "owner");
    const store = new TeamMembersStore(access);
    const result = await Promise.allSettled([
      store.change(owner, owner.userId, "remove"),
      store.change(second, second.userId, "remove"),
    ]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      await fixture.database
        .selectFrom("teamMembers")
        .select("userId")
        .where("state", "=", "active")
        .where("role", "=", "owner")
        .execute(),
    ).toHaveLength(1);
  });

  it("wakes only the sender's sticky agent and keeps retries and new roots independent", async () => {
    const other = await person("StickyOther");
    const c = await channel();
    await chat.setAccess(owner, c.id, access.revision, [
      { subject: { kind: "person", userId: owner.userId }, level: "post", manage: true },
      { subject: { kind: "person", userId: other.userId }, level: "post", manage: false },
    ]);
    const l = await link();
    const first = await send(c.id, "ask", owner, [{ kind: "agent", userId: owner.userId }]);
    expect(first.wake).toBe("queued");
    expect(await chat.agentRecipient(owner, c.id, first.message.id)).toMatchObject({
      enabled: true,
    });
    expect((await send(c.id, "follow up", owner, [], first.message.id)).wake).toBe("queued");
    expect((await send(c.id, "someone else", other, [], first.message.id)).wake).toBe(
      "not-requested",
    );
    expect((await send(c.id, "new root")).wake).toBe("not-requested");
    const retry = {
      channelId: c.id,
      threadRootId: first.message.id,
      clientMessageId: randomUUID(),
      bodyMarkdown: "retry",
      mentions: [],
      attachmentIds: [],
    };
    const sent = await chat.send(owner, retry);
    expect(sent.wake).toBe("queued");
    expect((await chat.send(owner, retry)).message.id).toBe(sent.message.id);
    expect(await requests.pending(l)).toHaveLength(3);
    await chat.setAgentRecipient(owner, c.id, first.message.id, false);
    await chat.setAgentRecipient(owner, c.id, first.message.id, false);
    expect((await send(c.id, "off", owner, [], first.message.id)).wake).toBe("not-requested");
    const cut = await chat.resume(other, {
      subscriptionId: "other",
      generation: 1,
      scope: { kind: "thread", channelId: c.id, rootId: first.message.id },
      sinceSeq: null,
    });
    expect(cut.agentRecipients).toEqual([]);
    await chat.setAgentRecipient(owner, c.id, first.message.id, true);
    await chat.update(owner, c.id, { peopleOnly: true });
    expect((await send(c.id, "people only", owner, [], first.message.id)).wake).toBe("people-only");
  });

  it("refuses agents without posting access and leaves rate-limit messages stored", async () => {
    const member = await person("Mentioned");
    const c = await channel();
    await chat.setAccess(owner, c.id, access.revision, [
      { subject: { kind: "person", userId: owner.userId }, level: "post", manage: true },
      { subject: { kind: "person", userId: member.userId }, level: "read", manage: false },
    ]);
    const l = await link();
    expect(
      (await send(c.id, "other agent", owner, [{ kind: "agent", userId: member.userId }])).wake,
    ).toBe("not-requested");
    const root = await send(c.id, "own ask", owner, [{ kind: "agent", userId: owner.userId }]);
    expect(root.wake).toBe("queued");
    for (let i = 0; i < 9; i++)
      expect((await send(c.id, "own reply", owner, [], root.message.id)).wake).toBe("queued");
    const refused = await send(c.id, "limited", owner, [], root.message.id);
    expect(refused.wake).toBe("rate-limited");
    expect((await chat.message(owner, c.id, refused.message.id)).bodyMarkdown).toBe("limited");
    const request = (await requests.pending(l))[0]!.request;
    await requests.accept(l, request!.id);
    await requests.reply(l, request!.id, {
      bodyMarkdown: "@maya-agent is an inert agent-authored reference",
      attachmentIds: [],
    });
    expect(
      await fixture.database.selectFrom("teamAgentRequests").select("id").execute(),
    ).toHaveLength(10);
    for (let i = 0; i < 23; i++) {
      await fixture.database
        .updateTable("teamAgentRequests")
        .set({ createdAt: new Date(Date.now() - 120000) })
        .execute();
      expect((await send(c.id, "queued", owner, [], root.message.id)).wake).toBe("queued");
    }
    expect((await send(c.id, "queue full", owner, [], root.message.id)).wake).toBe("rate-limited");
  });

  it("snapshots over 200 changed rows, resumes compacted rows, and carries request and metadata updates", async () => {
    const c = await channel();
    const first = await send(c.id);
    const since = first.message.changeSeq;
    for (let i = 0; i < 3; i++)
      await chat.editOrDelete(owner, c.id, first.message.id, {
        bodyMarkdown: `edit ${i}`,
        mentions: [],
      });
    const compacted = await chat.resume(owner, {
      subscriptionId: "c",
      generation: 1,
      scope: { kind: "channel", channelId: c.id },
      sinceSeq: since,
    });
    expect(compacted.type).toBe("resumed");
    if (compacted.type === "resumed") expect(compacted.changedRows).toHaveLength(1);
    const l = await link();
    await send(c.id, "ask", owner, [{ kind: "agent", userId: owner.userId }], first.message.id);
    const request = (await requests.pending(l))[0]!.request;
    await requests.accept(l, request!.id);
    await chat.update(owner, c.id, { instructionsMarkdown: "current" });
    const cut = await chat.resume(owner, {
      subscriptionId: "t",
      generation: 1,
      scope: { kind: "thread", channelId: c.id, rootId: first.message.id },
      sinceSeq: compacted.throughSeq,
    });
    expect(cut.channel.instructionsMarkdown).toBe("current");
    if (cut.type === "resumed") expect(cut.requests[0]?.state).toBe("working");
    await access.contentWrite(owner, c.id, async (t) => {
      const rows = Array.from({ length: 201 }, (_, i) => ({
        channelId: c.id,
        threadRootId: null,
        authorUserId: owner.userId,
        authorKind: "human" as const,
        agentRequestId: null,
        clientMessageId: randomUUID(),
        bodyMarkdown: `seed ${i}`,
        plainText: `seed ${i}`,
        createdAt: new Date(),
        editedAt: null,
        deletedAt: null,
        changeSeq: String(BigInt(cut.throughSeq) + BigInt(i) + 1n),
      }));
      await t.insertInto("teamMessages").values(rows).execute();
      await t
        .updateTable("teamChannels")
        .set({ changeSeq: String(BigInt(cut.throughSeq) + 201n) })
        .where("id", "=", c.id)
        .execute();
    });
    const snapshot = await chat.resume(owner, {
      subscriptionId: "c",
      generation: 1,
      scope: { kind: "channel", channelId: c.id },
      sinceSeq: cut.throughSeq,
    });
    expect(snapshot.type).toBe("snapshot");
    if (snapshot.type === "snapshot") expect(snapshot.messages).toHaveLength(50);
    const filtered = await chat.resume(owner, {
      subscriptionId: "t",
      generation: 1,
      scope: { kind: "thread", channelId: c.id, rootId: first.message.id },
      sinceSeq: cut.throughSeq,
    });
    expect(filtered.throughSeq).toBe(snapshot.throughSeq);
    if (filtered.type === "resumed") {
      expect(filtered.changedRows).toEqual([]);
      expect(filtered.requests).toEqual([]);
    }
  });

  it("bounds link presence to returned request owners, including changed owners on resume", async () => {
    const c = await channel();
    const root = (await send(c.id)).message;
    const owners = Array.from({ length: 201 }, () => createId("user")).sort();
    await fixture.database
      .insertInto("users")
      .values(
        owners.map((id, index) => ({
          id,
          displayName: `Owner ${index}`,
          email: `owner-${index}@example.invalid`,
          emailVerified: true,
        })),
      )
      .execute();
    await fixture.database
      .insertInto("teamMembers")
      .values(
        owners.map((userId, index) => ({
          userId,
          handle: `owner-${index}`,
          role: "member" as const,
          state: "active" as const,
        })),
      )
      .execute();
    const links = owners.map(() => createId("teamLink"));
    await fixture.database
      .insertInto("teamLinks")
      .values(
        owners.map((ownerUserId, index) => ({
          id: links[index]!,
          ownerUserId,
          state: "active" as const,
          codeHash: randomUUID(),
          codeExpiresAt: new Date(),
          credentialHash: randomUUID(),
          personalDeploymentId: createId("deployment"),
        })),
      )
      .execute();
    const statuses = owners.map((ownerUserId, index) => ({
      id: createId("teamAgentRequest"),
      ownerUserId,
      channelId: c.id,
      threadRootId: root.id,
      triggerMessageId: root.id,
      linkId: links[index]!,
      state: "queued" as const,
      steps: sql<[]>`'[]'::jsonb`,
      createdAt: new Date(1000 * index),
      changeSeq: root.changeSeq,
    }));
    await fixture.database.insertInto("teamAgentRequests").values(statuses).execute();
    const scope = { kind: "thread" as const, channelId: c.id, rootId: root.id };
    const snapshot = await chat.resume(owner, {
      subscriptionId: "t",
      generation: 1,
      scope,
      sinceSeq: null,
    });
    expect(snapshot.type).toBe("snapshot");
    expect(snapshot.requests).toHaveLength(200);
    expect(snapshot.linkPresence).toHaveLength(200);
    expect(snapshot.linkPresence.map((entry) => entry.ownerUserId).sort()).toEqual(
      snapshot.requests.map((request) => request.ownerUserId).sort(),
    );
    expect(snapshot.linkPresence).toContainEqual({ ownerUserId: owners[200], online: false });
    await access.contentWrite(owner, c.id, async (tx) => {
      const changeSeq = String(BigInt(snapshot.throughSeq) + 1n);
      await tx.updateTable("teamChannels").set({ changeSeq }).where("id", "=", c.id).execute();
      await tx
        .updateTable("teamAgentRequests")
        .set({ state: "working", changeSeq })
        .where("id", "=", statuses[0]!.id)
        .execute();
    });
    const resumed = await chat.resume(owner, {
      subscriptionId: "t",
      generation: 1,
      scope,
      sinceSeq: snapshot.throughSeq,
    });
    expect(resumed.type).toBe("resumed");
    expect(resumed.requests.map((request) => request.id)).toEqual([statuses[0]!.id]);
    expect(resumed.linkPresence).toContainEqual({ ownerUserId: owners[0], online: false });
    expect(resumed.linkPresence.length).toBeLessThanOrEqual(200);
  });

  it("rechecks authenticated files, cancels an agent stream on people-only, and interrupts an upload on removal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opensteer-team-files-"));
    const store = new TeamFilesStore(access),
      files = new TeamFileService(store, access, directory);
    const blocked = Promise.withResolvers<void>();
    try {
      const c = await channel();
      const data = Buffer.from("private attachment");
      const metadata = {
        clientUploadId: randomUUID(),
        filename: "safe.txt",
        mediaType: "text/plain",
        sizeBytes: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
        previewSizeBytes: 0,
      };
      const file = await files.upload(owner, c.id, metadata, {
        original: (async function* () {
          yield data;
        })(),
      });
      const l = await link();
      await chat.send(owner, {
        channelId: c.id,
        threadRootId: null,
        clientMessageId: randomUUID(),
        bodyMarkdown: "@maya-agent ask",
        mentions: [{ kind: "agent", userId: owner.userId }],
        attachmentIds: [file.id],
      });
      const request = (await requests.pending(l))[0]!.request;
      await requests.accept(l, request!.id);
      const additional = await textUpload(files, owner, c.id);
      await chat.send(owner, {
        channelId: c.id,
        threadRootId: request.threadRootId,
        clientMessageId: randomUUID(),
        bodyMarkdown: "another ask with an attachment",
        mentions: [{ kind: "agent", userId: owner.userId }],
        attachmentIds: [additional.id],
      });
      const stranger = await person("Stranger");
      await expect(files.download(stranger, file.id, "original")).rejects.toThrow();
      const download = await files.download(
        { ...owner, kind: "agent" },
        file.id,
        "original",
        undefined,
        undefined,
        { linkId: l, runId: createId("run"), operationId: randomUUID() },
      );
      download.body.on("error", () => {});
      const closed = once(download.body, "close").catch(() => undefined);
      await chat.update(owner, c.id, { peopleOnly: true });
      expect(download.body.destroyed).toBe(true);
      await withTimeout(closed, 5000, {
        timeoutError: () => new Error("Revoked file stream never closed"),
      });
      await expect(
        files.download({ ...owner, kind: "agent" }, file.id, "original", request!.id),
      ).rejects.toThrow();
      const human = await files.download(owner, file.id, "original");
      const received: Buffer[] = [];
      for await (const chunk of human.body) received.push(Buffer.from(chunk));
      expect(Buffer.concat(received)).toEqual(data);
      const uploader = await person("Uploader");
      await chat.setAccess(owner, c.id, access.revision, [
        { subject: { kind: "person", userId: owner.userId }, level: "post", manage: true },
        { subject: { kind: "person", userId: uploader.userId }, level: "post", manage: false },
      ]);
      const started = Promise.withResolvers<void>();
      const upload = files.upload(
        uploader,
        c.id,
        { ...metadata, clientUploadId: randomUUID() },
        {
          original: (async function* () {
            yield data.subarray(0, 1);
            started.resolve();
            await withTimeout(blocked.promise, 5000, {
              timeoutError: () => new Error("Upload fixture was never released"),
            });
            yield data.subarray(1);
          })(),
        },
      );
      const outcome = upload.then(
        () => null,
        (error: unknown) => error,
      );
      await withTimeout(started.promise, 5000, {
        timeoutError: () => new Error("Upload never began streaming"),
      });
      await new TeamMembersStore(access).change(owner, uploader.userId, "remove");
      expect(
        await withTimeout(outcome, 5000, {
          timeoutError: () => new Error("Removed uploader kept its stream"),
        }),
      ).toMatchObject({ message: "Team file access revoked" });
      expect(
        (await readdir(join(directory, "team-files"))).some((name) => name.startsWith("pending-")),
      ).toBe(false);
    } finally {
      blocked.resolve();
      files.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("claims push once, checks live recipients, follows mentions, and publishes owner agent status after reading", async () => {
    const member = await person("PushReader"),
      c = await channel();
    await chat.setAccess(owner, c.id, access.revision, [
      { subject: { kind: "person", userId: owner.userId }, level: "post", manage: true },
      { subject: { kind: "person", userId: member.userId }, level: "read", manage: false },
    ]);
    await fixture.database
      .insertInto("accountDirectoryProvider")
      .values({
        singletonKey: "opensteer-account",
        providerId: "fixture-account",
        issuer: "https://account.example.invalid",
      })
      .execute();
    for (const actor of [owner, member])
      await fixture.database
        .insertInto("authAccounts")
        .values({
          id: createId("authAccount"),
          userId: actor.userId,
          accountId: `acct_${randomUUID()}`,
          providerId: "fixture-account",
        })
        .execute();
    const root = await send(c.id, "mentioned", owner, [{ kind: "person", userId: member.userId }]);
    const outbox = new TeamOutboxStore(access),
      started = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const delivered: TeamPushDelivery[] = [];
    const first = outbox.drain(async (delivery) => {
      delivered.push(delivery);
      started.resolve();
      await withTimeout(release.promise, 5000, {
        timeoutError: () => new Error("Push fixture was not released"),
      });
    });
    try {
      await withTimeout(started.promise, 5000, {
        timeoutError: () => new Error("Push was not claimed"),
      });
      expect(
        await outbox.drain(async () => {
          throw new Error("Duplicate push claim");
        }),
      ).toBe(0);
    } finally {
      release.resolve();
      await first;
    }
    expect(delivered.map((d) => d.userId)).toEqual([member.userId]);
    await send(c.id, "followed reply", owner, [], root.message.id);
    delivered.length = 0;
    await outbox.drain(async (delivery) => {
      delivered.push(delivery);
    });
    expect(delivered.map((d) => d.userId)).toEqual([member.userId]);
    const l = await link();
    const ask = await send(c.id, "own ask", owner, [{ kind: "agent", userId: owner.userId }]);
    const request = (await requests.pending(l))[0]!.request;
    await requests.accept(l, request.id);
    await chat.readMarker(owner, c.id, ask.message.id);
    await requests.status(l, request.id, { state: "needs_you", steps: [] });
    delivered.length = 0;
    await outbox.drain(async (delivery) => {
      delivered.push(delivery);
    });
    expect(delivered).toContainEqual(
      expect.objectContaining({ userId: owner.userId, kind: "team-agent-needs-you" }),
    );
    await requests.reply(l, request.id, { bodyMarkdown: "agent reply", attachmentIds: [] });
    await requests.status(l, request.id, { state: "done", steps: [] });
    delivered.length = 0;
    await outbox.drain(async (delivery) => {
      delivered.push(delivery);
    });
    expect(delivered).toContainEqual(
      expect.objectContaining({ userId: owner.userId, kind: "team-agent-completed" }),
    );
    await send(c.id, "late mention", owner, [{ kind: "person", userId: member.userId }]);
    await chat.setAccess(owner, c.id, access.revision, [
      { subject: { kind: "person", userId: owner.userId }, level: "post", manage: true },
    ]);
    delivered.length = 0;
    await outbox.drain(async (delivery) => {
      delivered.push(delivery);
    });
    expect(delivered).toEqual([]);
  });

  it("uses teamApiVersion before authentication and parsing and ignores the personal epoch", async () => {
    const team = await services({
      async registerPreviewKey(session, command) {
        await fixture.database
          .insertInto("notificationPreviewKeys")
          .values({
            userId: session.user.id,
            authSessionId: session.id,
            installationId: command.installationId,
            accountId: command.accountId,
            keyId: command.keyId,
            encryptedKey: Buffer.alloc(32),
            encryptionKeyVersion: 1,
          })
          .execute();
      },
    });
    try {
      const sessionId = createId("authSession");
      await fixture.database
        .insertInto("authSessions")
        .values({
          id: sessionId,
          userId: owner.userId,
          token: randomUUID(),
          memberGeneration: "1",
          deviceLabel: "Test",
          expiresAt: new Date(Date.now() + 60000),
          absoluteExpiresAt: new Date(Date.now() + 60000),
        })
        .execute();
      const authenticate = vi.fn(async () => ({
        id: sessionId,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        absoluteExpiresAt: new Date(Date.now() + 60000).toISOString(),
        user: {
          id: owner.userId,
          displayName: "Maya",
          email: "maya@example.invalid",
          emailVerified: true,
          image: null,
          disabledAt: null,
        },
      }));
      const raw = {
        get type() {
          throw new Error("Payload parsed before version gate");
        },
      };
      await expect(
        team.rpc(
          new Headers({ "x-opensteer-api-version": "52" }),
          "commands.dispatch",
          raw,
          authenticate,
        ),
      ).rejects.toMatchObject({ reason: "api-version-mismatch" });
      expect(authenticate).not.toHaveBeenCalled();
      await expect(
        team.rpc(
          new Headers({ "x-opensteer-team-api-version": String(teamApiVersion) }),
          "tasks.list",
          {},
          authenticate,
        ),
      ).rejects.toThrow("Personal routes");
      expect(authenticate).not.toHaveBeenCalled();
      const result = await team.rpc(
        new Headers({
          "x-opensteer-team-api-version": String(teamApiVersion),
          "x-opensteer-api-version": "99999",
        }),
        "team.bootstrap.get",
        {},
        authenticate,
      );
      expect(result).toMatchObject({ teamId: fixture.deploymentId });
      expect(authenticate).toHaveBeenCalledOnce();
      const session = await authenticate();
      await fixture.database
        .updateTable("authSessions")
        .set({ memberGeneration: "0" })
        .where("id", "=", session.id)
        .execute();
      const preview = {
        type: "notification.preview.register",
        installationId: "preview-installation",
        accountId: "acct_00000000-0000-4000-8000-000000000001",
        keyId: Buffer.alloc(16).toString("base64url"),
        key: Buffer.alloc(32).toString("base64url"),
      };
      const headers = new Headers({ "x-opensteer-team-api-version": String(teamApiVersion) });
      await expect(
        team.rpc(headers, "commands.dispatch", preview, async () => session),
      ).rejects.toThrow("Team access denied");
      expect(
        await fixture.database.selectFrom("notificationPreviewKeys").select("userId").execute(),
      ).toEqual([]);
      await fixture.database
        .updateTable("authSessions")
        .set({ memberGeneration: "1" })
        .where("id", "=", session.id)
        .execute();
      const registered = await team.rpc(headers, "commands.dispatch", preview, async () => session);
      expect(hostApi["commands.dispatch"].success.parse(registered)).toMatchObject({
        type: preview.type,
        registered: true,
      });
      expect(
        await fixture.database
          .selectFrom("notificationPreviewKeys")
          .select("authSessionId")
          .execute(),
      ).toEqual([{ authSessionId: session.id }]);
    } finally {
      await team.close();
    }
  });
});
