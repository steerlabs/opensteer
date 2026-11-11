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
import { createDatabase } from "./connection.js";
import {
  createKnowledgeExecutorPool,
  prepareKnowledgeExecutor,
  type KnowledgeExecutorCredentials,
} from "./knowledge-executor.js";
import { knowledgeExecutorRole } from "./knowledge-schema.js";
import type { DatabaseSchema } from "./schema.js";
import { createTeamFixture } from "./team-fixture.test-support.js";
import {
  createSharedTeamTopic,
  teamChannelTopics,
  type TeamTopicGrant,
} from "./team-topics-store.js";
import { ownTestDatabaseProducer } from "./test-database.test-support.js";

/**
 * A team database with the knowledge schema and its restricted login, which is
 * cluster-wide and so is dropped before the clone is.
 */
export async function createTeamKnowledgeFixture() {
  const team = await createTeamFixture();
  const knowledge = await ownTestDatabaseProducer(team.databaseUrl, async () => {
    // Its own connection: the team fixture's may already be closed when this stops.
    const administrator = createDatabase({ connectionString: team.databaseUrl, maxConnections: 1 });
    const credentials = await prepareKnowledgeExecutor(administrator);
    const pool = createKnowledgeExecutorPool(team.databaseUrl, credentials);
    return {
      credentials,
      pool,
      async close() {
        await pool.end();
        const role = sql.id(await knowledgeExecutorRole(administrator));
        await sql`drop owned by ${role}; drop role ${role}`.execute(administrator);
        await administrator.destroy();
      },
    };
  });
  const { database } = team;
  return Object.freeze({
    ...team,
    credentials: knowledge.credentials as KnowledgeExecutorCredentials,
    pool: knowledge.pool,
    owner: team.userId,
    member: (name: string, role: "admin" | "member" = "member") => addMember(database, name, role),
    group: (name: string, people: readonly UserId[], children: readonly TeamGroupId[] = []) =>
      addGroup(database, team.userId, name, people, children),
    channel: (input: Parameters<typeof addChannel>[2]) => addChannel(database, team.userId, input),
    sharedTopic: (name: string, access: readonly TeamTopicGrant[], peopleOnly = false) =>
      addSharedTopic(database, team.userId, name, access, peopleOnly),
    attach: (channelId: TeamChannelId, topicId: KnowledgeTopicId) =>
      database
        .insertInto("teamChannelTopics")
        .values({ channelId, topicId, attachedBy: team.userId })
        .execute(),
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

/** A channel and, in the same transaction, its topic: as team channel creation does. */
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
): Promise<{ readonly channelId: TeamChannelId; readonly topicId: KnowledgeTopicId }> {
  const channelId = createId("teamChannel");
  return database.transaction().execute(async (transaction) => {
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
    const topicId = await teamChannelTopics.createChannelTopic(transaction, {
      channelId,
      name: input.name,
      createdBy,
      peopleOnly: false,
    });
    return { channelId, topicId };
  });
}

async function addSharedTopic(
  database: Kysely<DatabaseSchema>,
  createdBy: UserId,
  name: string,
  access: readonly TeamTopicGrant[],
  peopleOnly: boolean,
): Promise<KnowledgeTopicId> {
  const id = createId("knowledgeTopic");
  await database.transaction().execute(async (transaction) => {
    await createSharedTeamTopic(transaction, { id, name, peopleOnly, createdBy, access });
    // The fixture's owner creates every topic; drop its automatic manage grant unless asked for.
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
  return database.transaction().execute(async (transaction) => {
    const existing = await transaction
      .selectFrom("teamLinks")
      .select("id")
      .where("ownerUserId", "=", ownerUserId)
      .where("state", "=", "active")
      .executeTakeFirst();
    const linkId = existing?.id ?? createId("teamLink");
    if (!existing)
      await transaction
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
