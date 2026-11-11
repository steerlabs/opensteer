import { randomUUID, createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createId, type TeamActor, type UserId } from "@opensteer/core";
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
    const [{ request }] = await requests.pending(l);
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
});
