import {
  createId,
  type KnowledgeTopicId,
  type TeamAgentRequestId,
  type TeamChannelId,
  type TeamGroupId,
  type TeamLinkId,
  type TeamMessageId,
  type UserId,
} from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { createTeamFixture } from "./team-fixture.test-support.js";
import { createTeamTopic, type TeamTopicGrant } from "./team-knowledge-store.js";

/** A team database with helpers for the people, groups, channels, topics and agent asks knowledge tests need. */
export async function createTeamKnowledgeFixture() {
  const team = await createTeamFixture();
  const { database } = team;
  return Object.freeze({
    ...team,
    owner: team.userId,
    member: (name: string, role: "admin" | "member" = "member") => addMember(database, name, role),
    group: (name: string, people: readonly UserId[], children: readonly TeamGroupId[] = []) =>
      addGroup(database, team.userId, name, people, children),
    channel: (input: Parameters<typeof addChannel>[2]) => addChannel(database, team.userId, input),
    /** A topic with exactly `access`: the fixture's owner, who creates it, keeps no grant unless listed. */
    topic: (name: string, access: readonly TeamTopicGrant[]) =>
      addTopic(database, team.userId, name, access),
    link: (ownerUserId: UserId) => addLink(database, ownerUserId),
    request: (ownerUserId: UserId, channelId: TeamChannelId) =>
      addRequest(database, ownerUserId, channelId),
  });
}

async function addMember(
  database: Kysely<DatabaseSchema>,
  name: string,
  role: "admin" | "member",
): Promise<UserId> {
  const userId = createId("user");
  const handle = name.toLowerCase();
  await database.transaction().execute(async (transaction) => {
    await sql`insert into users(id,display_name,email,email_verified) values(${userId},${name},${`${handle}@example.invalid`},true)`.execute(
      transaction,
    );
    await sql`insert into team_members(user_id,handle,role,state,joined_at,changed_at) values(${userId},${handle},${role},'active',now(),now())`.execute(
      transaction,
    );
  });
  return userId;
}

async function addGroup(
  database: Kysely<DatabaseSchema>,
  createdBy: UserId,
  name: string,
  people: readonly UserId[],
  children: readonly TeamGroupId[],
): Promise<TeamGroupId> {
  const id = createId("teamGroup");
  await database.transaction().execute(async (transaction) => {
    await transaction
      .insertInto("teamGroups")
      .values({ id, name, normalizedName: name.toLowerCase(), createdBy })
      .execute();
    for (const userId of people)
      await transaction
        .insertInto("teamGroupPeople")
        .values({ groupId: id, userId, addedBy: createdBy })
        .execute();
    for (const childGroupId of children)
      await transaction
        .insertInto("teamGroupEdges")
        .values({ parentGroupId: id, childGroupId, addedBy: createdBy })
        .execute();
  });
  return id;
}

async function addChannel(
  database: Kysely<DatabaseSchema>,
  createdBy: UserId,
  input: {
    readonly name: string;
    readonly kind?: "public" | "private";
    readonly peopleOnly?: boolean;
    readonly access: readonly {
      readonly userId?: UserId;
      readonly groupId?: TeamGroupId;
      readonly level: "read" | "post";
      readonly manage?: boolean;
    }[];
  },
): Promise<{ readonly channelId: TeamChannelId }> {
  const channelId = createId("teamChannel");
  await database.transaction().execute(async (transaction) => {
    await transaction
      .insertInto("teamChannels")
      .values({
        id: channelId,
        kind: input.kind ?? "public",
        name: input.name,
        normalizedName: input.name,
        createdBy,
        peopleOnly: input.peopleOnly ?? false,
        instructionsMarkdown: "",
        latestMessageId: null,
        dmKey: null,
      })
      .execute();
    for (const entry of input.access)
      await transaction
        .insertInto("teamChannelMembers")
        .values({
          channelId,
          subjectKind: entry.userId ? "person" : "group",
          subjectId: (entry.userId ?? entry.groupId)!,
          level: entry.level,
          manage: entry.manage ?? false,
          addedBy: createdBy,
        })
        .execute();
  });
  return { channelId };
}

async function addTopic(
  database: Kysely<DatabaseSchema>,
  createdBy: UserId,
  name: string,
  access: readonly TeamTopicGrant[],
): Promise<KnowledgeTopicId> {
  const id = createId("knowledgeTopic");
  await database.transaction().execute(async (transaction) => {
    await createTeamTopic(transaction, { id, name, description: "", createdBy, access });
    if (
      !access.some((grant) => grant.subject.kind === "person" && grant.subject.userId === createdBy)
    )
      await transaction
        .deleteFrom("teamTopicGrants")
        .where("topicId", "=", id)
        .where("subjectKind", "=", "person")
        .where("subjectId", "=", createdBy)
        .execute();
  });
  return id;
}

/** The person's one active link, created on first use. */
async function addLink(database: Kysely<DatabaseSchema>, ownerUserId: UserId): Promise<TeamLinkId> {
  const existing = await database
    .selectFrom("teamLinks")
    .select("id")
    .where("ownerUserId", "=", ownerUserId)
    .where("state", "=", "active")
    .executeTakeFirst();
  if (existing) return existing.id;
  const linkId = createId("teamLink");
  await database
    .insertInto("teamLinks")
    .values({
      id: linkId,
      ownerUserId,
      personalDeploymentId: createId("deployment"),
      installationLabel: "Test Mac",
      state: "active",
      codeHash: createId("teamLink"),
      codeExpiresAt: new Date(),
      credentialHash: createId("teamLink"),
    })
    .execute();
  return linkId;
}

/** An accepted, unexpired request from the owner's active link, asked in a new thread. */
async function addRequest(
  database: Kysely<DatabaseSchema>,
  ownerUserId: UserId,
  channelId: TeamChannelId,
): Promise<{
  readonly linkId: TeamLinkId;
  readonly requestId: TeamAgentRequestId;
  readonly messageId: TeamMessageId;
}> {
  const linkId = await addLink(database, ownerUserId);
  return database.transaction().execute(async (transaction) => {
    const message = await transaction
      .insertInto("teamMessages")
      .values({
        channelId,
        threadRootId: null,
        authorUserId: ownerUserId,
        authorKind: "human",
        agentRequestId: null,
        clientMessageId: createId("teamLink"),
        bodyMarkdown: "@my-agent please",
        plainText: "please",
        changeSeq: "1",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const requestId = createId("teamAgentRequest");
    await sql`
      insert into team_agent_requests (id, owner_user_id, channel_id, thread_root_id,
        trigger_message_id, link_id, state, steps, accepted_at, expires_at, change_seq)
      values (${requestId}, ${ownerUserId}, ${channelId}, ${message.id}, ${message.id}, ${linkId},
        'working', '[]', now(), now() + interval '7 days', 1)
    `.execute(transaction);
    return { linkId, requestId, messageId: message.id as TeamMessageId };
  });
}
