import { randomUUID, createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { TeamFileService } from "./file-service.js";
import { startTeamServices } from "./services.js";
import { createId, type TeamActor, type KnowledgeTopicId } from "@opensteer/core";
import { createTeamFixture } from "@opensteer/database/test-support/team";
import { sql } from "kysely";
import { TeamAccessStore } from "@opensteer/database/team-access";
import { TeamChatStore } from "@opensteer/database/team-chat";
import { TeamGroupsStore } from "@opensteer/database/team-groups";
import { TeamMembersStore } from "@opensteer/database/team-members";
import { TeamInvitesStore } from "@opensteer/database/team-invites";
import { TeamRequestsStore } from "@opensteer/database/team-requests";
import { TeamFilesStore } from "@opensteer/database/team-files";

describe("team transaction authority", () => {
  let fixture: Awaited<ReturnType<typeof createTeamFixture>>;
  let access: TeamAccessStore,
    chat: TeamChatStore,
    groups: TeamGroupsStore,
    requests: TeamRequestsStore;
  let owner: TeamActor;
  beforeEach(async () => {
    fixture = await createTeamFixture();
    access = new TeamAccessStore(fixture.database);
    await access.initialize();
    owner = { kind: "human", userId: fixture.userId };
    await sql`create schema knowledge`.execute(fixture.database);
    await sql`create table knowledge.topics(id text primary key,name text,origin_channel_id text,people_only boolean not null default false,archived_at timestamptz)`.execute(
      fixture.database,
    );
    chat = new TeamChatStore(
      access,
      {
        async createChannelTopic(t, input) {
          const id = createId("knowledgeTopic");
          await sql`insert into knowledge.topics(id,name,origin_channel_id,people_only) values(${id},${input.name},${input.channelId},${input.peopleOnly})`.execute(
            t,
          );
          return id;
        },
      },
      { teamId: fixture.deploymentId, teamName: "Acme" },
    );
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
  async function link(userId = owner.userId) {
    const id = createId("teamLink");
    await sql`insert into team_links(id,owner_user_id,personal_deployment_id,state,code_hash,credential_hash,code_expires_at) values(${id},${userId},${createId("deployment")},'active',${randomUUID()},${randomUUID()},now())`.execute(
      fixture.database,
    );
    return id;
  }
  function send(
    channelId: Parameters<TeamChatStore["send"]>[1]["channelId"],
    body = "hello",
    actor = owner,
    mentions: Parameters<TeamChatStore["send"]>[1]["mentions"] = [],
    root: Parameters<TeamChatStore["send"]>[1]["threadRootId"] = null,
  ) {
    return chat.send(actor, {
      channelId,
      bodyMarkdown: body,
      clientMessageId: randomUUID(),
      threadRootId: root,
      mentions,
      attachmentIds: [],
    });
  }
  async function rights(actor: TeamActor, id: Parameters<TeamAccessStore["channel"]>[2]) {
    return fixture.database.transaction().execute((t) => access.channel(t, actor, id));
  }
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
  it("applies nested topic ACLs and people-only to every agent path while retaining human access", async () => {
    const member = await person("TopicReader"),
      agent = { ...member, kind: "agent" as const };
    const group = createId("teamGroup"),
      topicId = createId("knowledgeTopic");
    await groups.create(owner, group, "Topic readers");
    await groups.person(owner, group, member.userId, true);
    await sql`insert into knowledge.topics(id,name,people_only) values(${topicId},'Shared',false)`.execute(
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
    expect(await topicRights(agent)).toMatchObject({ read: true, write: false, manage: false });
    expect(await topicRights(owner)).toMatchObject({ read: false, write: false, manage: true });
    await access.mutate(async (t) => {
      await sql`update knowledge.topics set people_only=true where id=${topicId}`.execute(t);
      return {
        value: undefined,
        effects: { users: [], channels: [], topics: [topicId], links: [], requests: [] },
      };
    });
    expect(await topicRights(agent)).toMatchObject({ read: false, write: false });
    expect((await topicRights(member)).read).toBe(true);
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
    const channelTopic = (
      await sql<{
        id: KnowledgeTopicId;
      }>`select id from knowledge.topics where origin_channel_id=${c.id}`.execute(fixture.database)
    ).rows[0]!.id;
    const inherited = await fixture.database
      .transaction()
      .execute((t) => access.topic(t, agent, channelTopic));
    expect(inherited).toMatchObject({ read: false, write: false, peopleOnly: true });
    await expect(
      access.knowledgeWrite(agent, channelTopic, async () => "unexpected"),
    ).rejects.toThrow();
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
    await expect(requests.authorize(l, accepted.id, "read")).rejects.toThrow();
    expect(await requests.receipt(l, accepted.id)).toBe(replyId);
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

  it("keeps other-agent references inert and leaves refused rate-limit asks as stored messages", async () => {
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
    for (let i = 0; i < 10; i++)
      expect(
        (await send(c.id, "own ask", owner, [{ kind: "agent", userId: owner.userId }])).wake,
      ).toBe("queued");
    const refused = await send(c.id, "limited", owner, [{ kind: "agent", userId: owner.userId }]);
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
      expect(
        (await send(c.id, "queued", owner, [{ kind: "agent", userId: owner.userId }])).wake,
      ).toBe("queued");
    }
    expect(
      (await send(c.id, "queue full", owner, [{ kind: "agent", userId: owner.userId }])).wake,
    ).toBe("rate-limited");
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
        bodyMarkdown: "ask",
        mentions: [{ kind: "agent", userId: owner.userId }],
        attachmentIds: [file.id],
      });
      const request = (await requests.pending(l))[0]!.request;
      await requests.accept(l, request!.id);
      const stranger = await person("Stranger");
      await expect(files.download(stranger, file.id, "original")).rejects.toThrow();
      const download = await files.download(
        { ...owner, kind: "agent" },
        file.id,
        "original",
        request!.id,
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
        () => "accepted",
        () => "cancelled",
      );
      await withTimeout(started.promise, 5000, {
        timeoutError: () => new Error("Upload never began streaming"),
      });
      await new TeamMembersStore(access).change(owner, uploader.userId, "remove");
      expect(
        await withTimeout(outcome, 5000, {
          timeoutError: () => new Error("Removed uploader kept its stream"),
        }),
      ).toBe("cancelled");
      expect(
        (await readdir(join(directory, "team-files"))).some((name) => name.startsWith("pending-")),
      ).toBe(false);
    } finally {
      blocked.resolve();
      files.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses teamApiVersion before authentication and parsing and ignores the personal epoch", async () => {
    const services = await startTeamServices({
      kind: "team",
      database: fixture.database,
      teamId: fixture.deploymentId,
      teamName: "Acme",
      origin: "https://team.example.invalid",
      dataDirectory: tmpdir(),
      topics: chat.topics,
      async ensureKnowledge() {},
      knowledge: {
        async read() {
          throw new Error("Unexpected knowledge call");
        },
        async command() {
          throw new Error("Unexpected knowledge command");
        },
      },
      links: {
        async createCode() {
          throw new Error("Unexpected link code");
        },
        async list() {
          return { links: [] };
        },
        async revoke() {},
      },
      async publishPush() {},
      backgroundError() {},
    });
    try {
      const authenticate = vi.fn(async () => ({
        id: createId("authSession"),
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
        services.rpc(
          new Headers({ "x-opensteer-api-version": "52" }),
          "commands.dispatch",
          raw,
          authenticate,
        ),
      ).rejects.toMatchObject({ reason: "api-version-mismatch" });
      expect(authenticate).not.toHaveBeenCalled();
      await expect(
        services.rpc(
          new Headers({ "x-opensteer-team-api-version": "1" }),
          "tasks.list",
          {},
          authenticate,
        ),
      ).rejects.toThrow("Personal routes");
      expect(authenticate).not.toHaveBeenCalled();
      const result = await services.rpc(
        new Headers({ "x-opensteer-team-api-version": "1", "x-opensteer-api-version": "99999" }),
        "team.bootstrap.get",
        {},
        authenticate,
      );
      expect(result).toMatchObject({ teamId: fixture.deploymentId });
      expect(authenticate).toHaveBeenCalledOnce();
    } finally {
      await services.close();
    }
  });
});
