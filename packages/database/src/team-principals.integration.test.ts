import { createId, TeamHandleSchema } from "@opensteer/core";
import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createTeamFixture } from "./team-fixture.test-support.js";
import { teamPrincipalProfiles, upsertRemoteTeamPrincipal } from "./team-principals-store.js";
import { TeamAccessStore } from "./team-access-store.js";
import { TeamChatStore } from "./team-chat-store.js";
import { seedRemoteTeamContent } from "./team-principals.test-support.js";
import { readTeamNote, teamNoteHistory, teamChannelReaders } from "./team-knowledge-store.js";

let fixture: Awaited<ReturnType<typeof createTeamFixture>>;
beforeEach(async () => {
  fixture = await createTeamFixture();
});

it("mints remote keys locally, keeps one identity per home person, and resolves live local profiles", async () => {
  const input = {
    homeTeamId: createId("deployment"),
    homeUserId: fixture.userId,
    displayName: "Alex",
    handle: TeamHandleSchema.parse("alex"),
  };
  const first = await fixture.database
    .transaction()
    .execute((t) => upsertRemoteTeamPrincipal(t, input));
  expect(first.id).not.toBe(input.homeUserId);
  const second = await fixture.database
    .transaction()
    .execute((t) => upsertRemoteTeamPrincipal(t, { ...input, displayName: "Alex Renamed" }));
  expect(second.id).toBe(first.id);
  expect(
    await fixture.database.selectFrom("users").select("id").where("id", "=", first.id).execute(),
  ).toEqual([]);
  await fixture.database
    .updateTable("users")
    .set({ displayName: "Maya Renamed", image: "https://local.invalid/photo.png" })
    .where("id", "=", fixture.userId)
    .execute();
  await fixture.database
    .updateTable("teamMembers")
    .set({ state: "removed" })
    .where("userId", "=", fixture.userId)
    .execute();
  const profiles = await teamPrincipalProfiles(fixture.database).execute();
  expect(profiles).toContainEqual(
    expect.objectContaining({
      id: first.id,
      displayName: "Alex Renamed",
      handle: "alex",
      image: null,
    }),
  );
  expect(profiles).toContainEqual(
    expect.objectContaining({
      id: fixture.userId,
      displayName: "Maya Renamed",
      handle: "maya",
      image: "https://local.invalid/photo.png",
    }),
  );
  await expect(
    fixture.database
      .transaction()
      .execute((t) => upsertRemoteTeamPrincipal(t, { ...input, homeTeamId: fixture.deploymentId })),
  ).rejects.toMatchObject({ code: "23514" });
  const withImage = { ...input, image: "https://peer.invalid/tracker.png" };
  await expect(
    fixture.database.transaction().execute((t) => upsertRemoteTeamPrincipal(t, withImage)),
  ).rejects.toThrow();
  await expect(
    sql`update team_principals set member_user_id=${fixture.userId} where id=${first.id}`.execute(
      fixture.database,
    ),
  ).rejects.toMatchObject({ code: "23514" });
});

it("keeps remote principals outside authority tables and channel audiences", async () => {
  const access = new TeamAccessStore(fixture.database);
  await access.initialize();
  const chat = new TeamChatStore(access, { teamId: fixture.deploymentId, teamName: "Team" });
  const actor = { kind: "human" as const, userId: fixture.userId };
  const channel = await chat.create(actor, {
    id: createId("teamChannel"),
    kind: "private",
    name: "Principals",
    peopleOnly: false,
    access: [],
  });
  const { remote, root } = await seedRemoteTeamContent(fixture, channel.id);
  expect(await teamChannelReaders(fixture.database, channel.id)).toEqual(new Set([fixture.userId]));
  await expect(
    sql`insert into team_channel_members(channel_id,subject_kind,subject_id,level,manage,added_by) values(${channel.id},'person',${remote.id},'post',false,${fixture.userId})`.execute(
      fixture.database,
    ),
  ).rejects.toMatchObject({ code: "23503" });
  await expect(
    sql`insert into team_channel_member_state(channel_id,user_id,notification_level) values(${channel.id},${remote.id},'mentions')`.execute(
      fixture.database,
    ),
  ).rejects.toMatchObject({ code: "23503" });
  await expect(
    sql`insert into team_agent_recipients(user_id,channel_id,root_id,enabled) values(${remote.id},${channel.id},${root.id},true)`.execute(
      fixture.database,
    ),
  ).rejects.toMatchObject({ code: "23503" });
  await expect(
    sql`insert into team_links(id,owner_user_id,state,code_hash) values(${createId("teamLink")},${remote.id},'pending','remote-link')`.execute(
      fixture.database,
    ),
  ).rejects.toMatchObject({ code: "23503" });
  const linkId = createId("teamLink");
  await sql`insert into team_links(id,owner_user_id,state,code_hash) values(${linkId},${fixture.userId},'pending','local-link')`.execute(
    fixture.database,
  );
  await expect(
    sql`insert into team_agent_requests(id,owner_user_id,channel_id,thread_root_id,trigger_message_id,link_id,state,steps,change_seq) values(${createId("teamAgentRequest")},${remote.id},${channel.id},${root.id},${root.id},${linkId},'queued','[]',1)`.execute(
      fixture.database,
    ),
  ).rejects.toMatchObject({ code: "23503" });
  const topicId = createId("knowledgeTopic");
  await sql`insert into team_topics(id,name) values(${topicId},'Principal notes')`.execute(
    fixture.database,
  );
  await expect(
    sql`insert into team_topic_grants(topic_id,subject_kind,subject_id,level) values(${topicId},'person',${remote.id},'read')`.execute(
      fixture.database,
    ),
  ).rejects.toMatchObject({ code: "23503" });
  const noteId = createId("knowledgeNote");
  await sql`insert into team_notes(id,topic_id,version,title,body) values(${noteId},${topicId},1,'Remote note','Words')`.execute(
    fixture.database,
  );
  await sql`insert into team_note_versions(note_id,version,title,body,deleted,writer_kind,writer_user_id) values(${noteId},1,'Remote note','Words',false,'human',${remote.id})`.execute(
    fixture.database,
  );
  expect(await readTeamNote(fixture.database, noteId)).toMatchObject({
    writer: { userId: remote.id, name: "Remote Alex" },
  });
  expect((await teamNoteHistory(fixture.database, { noteId, limit: 10 })).versions).toMatchObject([
    { writer: { userId: remote.id, name: "Remote Alex" } },
  ]);
  const references = await sql<{
    column: string;
  }>`select c.conrelid::regclass::text || '.' || a.attname as column
    from pg_constraint c join pg_attribute a on a.attrelid=c.conrelid and a.attnum=c.conkey[1]
    where c.contype='f' and c.confrelid='team_principals'::regclass order by 1`.execute(
    fixture.database,
  );
  expect(references.rows.map((row) => row.column)).toEqual([
    "team_blobs.uploader_user_id",
    "team_mentions.target_user_id",
    "team_message_pins.pinned_by",
    "team_messages.author_user_id",
    "team_note_versions.writer_user_id",
    "team_share_asks.target_principal_id",
    "team_share_participants.principal_id",
  ]);
});
afterEach(async () => {
  await fixture?.close();
});

it("creates a local principal in the member's transaction without copying its profile", async () => {
  const rows = await sql<{
    id: string;
    homeTeamId: string;
    homeUserId: string;
    memberUserId: string;
    displayName: string | null;
    handle: string | null;
  }>`
    select * from team_principals where id=${fixture.userId}`.execute(fixture.database);
  expect(rows.rows[0]).toMatchObject({
    id: fixture.userId,
    homeTeamId: fixture.deploymentId,
    homeUserId: fixture.userId,
    memberUserId: fixture.userId,
    displayName: null,
    handle: null,
  });
  const userId = createId("user");
  await expect(
    fixture.database.transaction().execute(async (t) => {
      await sql`insert into users(id,display_name,email,email_verified) values(${userId},'Rolled back','rollback@example.invalid',true)`.execute(
        t,
      );
      await sql`insert into team_members(user_id,handle,role,state) values(${userId},'rollback','member','active')`.execute(
        t,
      );
      const principal = await sql`select id from team_principals where id=${userId}`.execute(t);
      expect(principal.rows).toHaveLength(1);
      throw new Error("ROLLBACK_MEMBER");
    }),
  ).rejects.toThrow("ROLLBACK_MEMBER");
  expect(
    (await sql`select id from team_principals where id=${userId}`.execute(fixture.database)).rows,
  ).toEqual([]);
});
