import {
  createId,
  OpensteerError,
  type KnowledgeTopicId,
  type TeamActor,
  type TeamAgentRequestId,
  type TeamChannelId,
  type TeamGroupId,
  type TeamLinkId,
  type TeamMessageId,
  type UserId,
} from "@opensteer/core";
import { sql, type Kysely, type Transaction } from "kysely";
import type { KnowledgeWriterKind } from "./knowledge-schema.js";
import type { DatabaseSchema } from "./schema.js";
import type { ChannelTopicPort } from "./team-topics-port.js";

type Executor = Kysely<DatabaseSchema> | Transaction<DatabaseSchema>;

export interface TeamTopicRecord {
  readonly id: KnowledgeTopicId;
  /** A channel topic is named after its channel. */
  readonly name: string;
  readonly originChannelId: TeamChannelId | null;
  /** The topic's own switch; a channel topic is also people-only while its channel is. */
  readonly peopleOnly: boolean;
  readonly archivedAt: Date | null;
  readonly updatedAt: Date;
  readonly accessRevision: string;
}

export type TeamTopicSubject =
  | { readonly kind: "person"; readonly userId: UserId }
  | { readonly kind: "group"; readonly groupId: TeamGroupId };
export type TeamTopicLevel = "read" | "write" | "manage";
export interface TeamTopicGrant {
  readonly subject: TeamTopicSubject;
  readonly level: TeamTopicLevel;
}

/** What an actor may do with a topic; structurally the access port's topic authority. */
export interface TeamTopicRights {
  readonly read: boolean;
  readonly write: boolean;
  readonly manage: boolean;
  readonly peopleOnly: boolean;
}
export interface TeamChannelRights {
  readonly read: boolean;
  readonly post: boolean;
  readonly manage: boolean;
  readonly peopleOnly: boolean;
}

function topicRows(executor: Executor) {
  return executor
    .selectFrom("knowledge.topics as t")
    .leftJoin("teamChannels as c", "c.id", "t.originChannelId")
    .select([
      "t.id",
      sql<string>`coalesce(c.name, t.name)`.as("name"),
      "t.originChannelId",
      "t.peopleOnly",
      "t.archivedAt",
      "t.updatedAt",
      "t.accessRevision",
    ]);
}

/** Every channel, DMs included, gets its topic inside the channel's own creation transaction. */
export const teamChannelTopics: ChannelTopicPort = {
  async createChannelTopic(transaction, input) {
    const id = createId("knowledgeTopic");
    await transaction
      .insertInto("knowledge.topics")
      .values({
        id,
        name: [...input.name].slice(0, 160).join(""),
        originChannelId: input.channelId,
        peopleOnly: input.peopleOnly,
        createdBy: input.createdBy,
      })
      .execute();
    return id;
  },
};

export async function readTeamTopic(
  executor: Executor,
  topicId: KnowledgeTopicId,
): Promise<TeamTopicRecord | undefined> {
  return topicRows(executor).where("t.id", "=", topicId).executeTakeFirst();
}

/** The topics an ask from this channel may use: its own topic, then attached shared topics. */
export async function teamChannelScopeTopics(
  executor: Executor,
  channelId: TeamChannelId,
): Promise<TeamTopicRecord[]> {
  return topicRows(executor)
    .where((eb) =>
      eb.or([
        eb("t.originChannelId", "=", channelId),
        eb(
          "t.id",
          "in",
          eb.selectFrom("teamChannelTopics").select("topicId").where("channelId", "=", channelId),
        ),
      ]),
    )
    .orderBy(sql`t.origin_channel_id is null`)
    .orderBy("name")
    .orderBy("t.id")
    .execute();
}

/** Topics in name order after `after`; the caller filters by authority. */
export async function teamTopicsAfter(
  executor: Executor,
  after: KnowledgeTopicId | undefined,
  limit: number,
): Promise<TeamTopicRecord[]> {
  let query = topicRows(executor);
  if (after)
    query = query.where(
      sql<boolean>`(coalesce(c.name, t.name), t.id) > (
        select coalesce(ac.name, a.name), a.id from knowledge.topics a
        left join team_channels ac on ac.id = a.origin_channel_id where a.id = ${after})`,
    );
  return query.orderBy("name").orderBy("t.id").limit(limit).execute();
}

/**
 * Resolves a topic for one actor. A channel topic follows its channel (read, post as write,
 * manage); a shared topic follows its own grants, through nested groups. Either people-only
 * switch shuts agents out, and agents never manage.
 */
export async function resolveTeamTopicAuthority(
  transaction: Transaction<DatabaseSchema>,
  actor: TeamActor,
  topicId: KnowledgeTopicId,
  channel: (channelId: TeamChannelId) => Promise<TeamChannelRights>,
): Promise<TeamTopicRights> {
  const topic = await transaction
    .selectFrom("knowledge.topics")
    .select(["originChannelId", "peopleOnly", "archivedAt"])
    .where("id", "=", topicId)
    .executeTakeFirst();
  if (!topic) return { read: false, write: false, manage: false, peopleOnly: false };
  let rights: TeamTopicRights;
  if (topic.originChannelId) {
    const can = await channel(topic.originChannelId);
    rights = {
      read: can.read,
      write: can.read && can.post && topic.archivedAt === null,
      manage: can.manage,
      peopleOnly: can.peopleOnly || topic.peopleOnly,
    };
  } else {
    const level = await grantedLevel(transaction, topicId, actor.userId);
    rights = {
      read: level >= 1,
      write: level >= 2 && topic.archivedAt === null,
      manage: level >= 3,
      peopleOnly: topic.peopleOnly,
    };
  }
  if (actor.kind === "human") return rights;
  return rights.peopleOnly
    ? { read: false, write: false, manage: false, peopleOnly: true }
    : { ...rights, manage: false };
}

/** 0 none, 1 read, 2 write, 3 manage: the best grant reaching an active member, directly or through any group. */
async function grantedLevel(
  executor: Executor,
  topicId: KnowledgeTopicId,
  userId: UserId,
): Promise<number> {
  const { rows } = await sql<{ level: number | null }>`
    with recursive member_groups(id) as (
      select p.group_id from team_group_people p
      join team_groups g on g.id = p.group_id and g.deleted_at is null
      where p.user_id = ${userId}
      union
      select e.parent_group_id from team_group_edges e
      join member_groups m on e.child_group_id = m.id
      join team_groups g on g.id = e.parent_group_id and g.deleted_at is null
    )
    select max(case grants.level when 'manage' then 3 when 'write' then 2 else 1 end)::int as level
    from team_topic_grants grants
    where grants.topic_id = ${topicId}
      and exists (select from team_members where user_id = ${userId} and state = 'active')
      and ((grants.subject_kind = 'person' and grants.subject_id = ${userId})
        or (grants.subject_kind = 'group' and grants.subject_id in (select id from member_groups)))
  `.execute(executor);
  return rows[0]?.level ?? 0;
}

/** Active members a shared topic's managers are told about: managing people and everyone in managing groups. */
export async function teamTopicManagers(
  executor: Executor,
  topicId: KnowledgeTopicId,
): Promise<UserId[]> {
  const { rows } = await sql<{ userId: UserId }>`
    with recursive managing(id) as (
      select grants.subject_id from team_topic_grants grants
      join team_groups g on g.id = grants.subject_id and g.deleted_at is null
      where grants.topic_id = ${topicId} and grants.subject_kind = 'group' and grants.level = 'manage'
      union
      select e.child_group_id from team_group_edges e
      join managing m on e.parent_group_id = m.id
      join team_groups g on g.id = e.child_group_id and g.deleted_at is null
    )
    select distinct m.user_id from team_members m
    where m.state = 'active' and (
      m.user_id in (select subject_id from team_topic_grants where topic_id = ${topicId}
        and subject_kind = 'person' and level = 'manage')
      or m.user_id in (select p.user_id from team_group_people p join managing on managing.id = p.group_id))
    order by m.user_id
  `.execute(executor);
  return rows.map((row) => row.userId);
}

export async function teamTopicGrants(
  executor: Executor,
  topicId: KnowledgeTopicId,
): Promise<TeamTopicGrant[]> {
  const rows = await executor
    .selectFrom("teamTopicGrants")
    .select(["subjectKind", "subjectId", "level"])
    .where("topicId", "=", topicId)
    .orderBy("subjectKind")
    .orderBy("subjectId")
    .execute();
  return rows.map((row) => ({
    subject:
      row.subjectKind === "person"
        ? { kind: "person", userId: row.subjectId as UserId }
        : { kind: "group", groupId: row.subjectId as TeamGroupId },
    level: row.level,
  }));
}

/** One entry per subject (the highest level wins); every subject is an active member or a live group. */
async function checkedGrants(
  transaction: Transaction<DatabaseSchema>,
  grants: readonly TeamTopicGrant[],
): Promise<Map<string, TeamTopicGrant>> {
  const order = { read: 1, write: 2, manage: 3 } as const;
  const bySubject = new Map<string, TeamTopicGrant>();
  for (const grant of grants) {
    const key = `${grant.subject.kind}:${grant.subject.kind === "person" ? grant.subject.userId : grant.subject.groupId}`;
    const held = bySubject.get(key);
    if (!held || order[grant.level] > order[held.level]) bySubject.set(key, grant);
  }
  const people = [...bySubject.values()].flatMap((grant) =>
    grant.subject.kind === "person" ? [grant.subject.userId] : [],
  );
  const groups = [...bySubject.values()].flatMap((grant) =>
    grant.subject.kind === "group" ? [grant.subject.groupId] : [],
  );
  const [members, live] = await Promise.all([
    people.length
      ? transaction
          .selectFrom("teamMembers")
          .select("userId")
          .where("userId", "in", people)
          .where("state", "=", "active")
          .execute()
      : [],
    groups.length
      ? transaction
          .selectFrom("teamGroups")
          .select("id")
          .where("id", "in", groups)
          .where("deletedAt", "is", null)
          .execute()
      : [],
  ]);
  if (members.length !== people.length || live.length !== groups.length)
    throw new OpensteerError({
      code: "bad_request",
      reason: "team-topic-unknown-subject",
      message: "Every person and group on a topic's list must be in the team.",
    });
  return bySubject;
}

async function insertGrants(
  transaction: Transaction<DatabaseSchema>,
  topicId: KnowledgeTopicId,
  grants: Iterable<TeamTopicGrant>,
  addedBy: UserId,
): Promise<void> {
  const values = [...grants].map((grant) => ({
    topicId,
    subjectKind: grant.subject.kind,
    subjectId: grant.subject.kind === "person" ? grant.subject.userId : grant.subject.groupId,
    level: grant.level,
    addedBy,
  }));
  if (values.length) await transaction.insertInto("teamTopicGrants").values(values).execute();
}

/** A shared topic; its creator always manages it. */
export async function createSharedTeamTopic(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly id: KnowledgeTopicId;
    readonly name: string;
    readonly peopleOnly: boolean;
    readonly createdBy: UserId;
    readonly access: readonly TeamTopicGrant[];
  },
): Promise<void> {
  const grants = await checkedGrants(transaction, [
    ...input.access,
    { subject: { kind: "person", userId: input.createdBy }, level: "manage" },
  ]);
  await transaction
    .insertInto("knowledge.topics")
    .values({
      id: input.id,
      name: input.name,
      peopleOnly: input.peopleOnly,
      createdBy: input.createdBy,
    })
    .execute();
  await insertGrants(transaction, input.id, grants.values(), input.createdBy);
}

/** Replaces a shared topic's list when it is still at `expectedRevision`; false when it moved on. */
export async function setTeamTopicGrants(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly topicId: KnowledgeTopicId;
    readonly expectedRevision: string;
    readonly access: readonly TeamTopicGrant[];
    readonly changedBy: UserId;
  },
): Promise<boolean> {
  const grants = await checkedGrants(transaction, input.access);
  const moved = await transaction
    .updateTable("knowledge.topics")
    .set({
      accessRevision: sql<string>`access_revision + 1`,
      updatedAt: sql<Date>`now()`,
    })
    .where("id", "=", input.topicId)
    .where("originChannelId", "is", null)
    .where("accessRevision", "=", input.expectedRevision)
    .executeTakeFirst();
  if (moved.numUpdatedRows !== 1n) return false;
  await transaction
    .selectFrom("teamTopicGrants")
    .select("subjectId")
    .where("topicId", "=", input.topicId)
    .orderBy("topicId")
    .orderBy("subjectKind")
    .orderBy("subjectId")
    // FOR UPDATE: The list is replaced, so these rows are deleted.
    .forUpdate()
    .execute();
  await transaction.deleteFrom("teamTopicGrants").where("topicId", "=", input.topicId).execute();
  await insertGrants(transaction, input.topicId, grants.values(), input.changedBy);
  return true;
}

/** Drops a person or group from every topic list, as removing them from the team does. */
export async function deleteTeamTopicGrantsFor(
  transaction: Transaction<DatabaseSchema>,
  subject: TeamTopicSubject,
): Promise<KnowledgeTopicId[]> {
  const subjectId = subject.kind === "person" ? subject.userId : subject.groupId;
  const held = await transaction
    .selectFrom("teamTopicGrants")
    .select("topicId")
    .where("subjectKind", "=", subject.kind)
    .where("subjectId", "=", subjectId)
    .orderBy("topicId")
    .orderBy("subjectKind")
    .orderBy("subjectId")
    // FOR UPDATE: Removing the subject deletes these rows.
    .forUpdate()
    .execute();
  await transaction
    .deleteFrom("teamTopicGrants")
    .where("subjectKind", "=", subject.kind)
    .where("subjectId", "=", subjectId)
    .execute();
  return held.map((row) => row.topicId);
}

export async function updateTeamTopic(
  transaction: Transaction<DatabaseSchema>,
  topicId: KnowledgeTopicId,
  change:
    { readonly name: string } | { readonly peopleOnly: boolean } | { readonly archived: boolean },
): Promise<boolean> {
  let query = transaction
    .updateTable("knowledge.topics")
    .set({ updatedAt: sql<Date>`now()` })
    .where("id", "=", topicId);
  if ("name" in change)
    query = query.set({ name: change.name }).where("originChannelId", "is", null);
  else if ("peopleOnly" in change) query = query.set({ peopleOnly: change.peopleOnly });
  else
    query = query
      .set({ archivedAt: change.archived ? sql<Date>`now()` : null })
      .where("originChannelId", "is", null);
  return (await query.executeTakeFirst()).numUpdatedRows === 1n;
}

/** Attaching only makes a shared topic easy to find from a channel; it grants nothing. */
export async function attachTeamTopic(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly channelId: TeamChannelId;
    readonly topicId: KnowledgeTopicId;
    readonly attachedBy: UserId;
  },
): Promise<boolean> {
  const shared = await transaction
    .selectFrom("knowledge.topics")
    .select("id")
    .where("id", "=", input.topicId)
    .where("originChannelId", "is", null)
    .executeTakeFirst();
  if (!shared) return false;
  await transaction
    .insertInto("teamChannelTopics")
    .values(input)
    .onConflict((conflict) => conflict.columns(["channelId", "topicId"]).doNothing())
    .execute();
  return true;
}

export async function detachTeamTopic(
  transaction: Transaction<DatabaseSchema>,
  channelId: TeamChannelId,
  topicId: KnowledgeTopicId,
): Promise<void> {
  await transaction
    .deleteFrom("teamChannelTopics")
    .where("channelId", "=", channelId)
    .where("topicId", "=", topicId)
    .execute();
}

/** The request a link names, while it may still use knowledge: accepted, unexpired, its link and owner live. */
export async function liveTeamKnowledgeRequest(
  executor: Executor,
  linkId: TeamLinkId,
  requestId: TeamAgentRequestId,
): Promise<
  | {
      readonly id: TeamAgentRequestId;
      readonly ownerUserId: UserId;
      readonly channelId: TeamChannelId;
    }
  | undefined
> {
  return executor
    .selectFrom("teamAgentRequests as r")
    .innerJoin("teamLinks as l", (join) =>
      join.onRef("l.id", "=", "r.linkId").onRef("l.ownerUserId", "=", "r.ownerUserId"),
    )
    .innerJoin("teamMembers as m", "m.userId", "r.ownerUserId")
    .select(["r.id", "r.ownerUserId", "r.channelId"])
    .where("r.id", "=", requestId)
    .where("r.linkId", "=", linkId)
    .where("r.state", "in", ["working", "needs_you"])
    .where("r.expiresAt", ">", sql<Date>`now()`)
    .where("l.state", "=", "active")
    .where("m.state", "=", "active")
    .executeTakeFirst();
}

export interface TeamFactRecord {
  readonly id: string;
  readonly topicId: KnowledgeTopicId;
  readonly thing: string;
  readonly property: string;
  readonly value: unknown;
  readonly replacesId: string | null;
  readonly writerKind: KnowledgeWriterKind;
  readonly writerUserId: UserId;
  readonly writtenAt: Date;
  /** The asking message an agent's write answered. */
  readonly source: { readonly channelId: TeamChannelId; readonly messageId: TeamMessageId } | null;
}

/** Newest first: every version, or only each key's current version. */
export async function teamFactsPage(
  executor: Executor,
  input: {
    readonly topicId: KnowledgeTopicId;
    readonly before: string | undefined;
    readonly current: boolean;
    readonly limit: number;
  },
): Promise<{ readonly facts: TeamFactRecord[]; readonly hasMore: boolean }> {
  let query = executor
    .selectFrom("knowledge.factLog as f")
    .innerJoin("knowledge.operations as o", "o.id", "f.operationId")
    .leftJoin("teamAgentRequests as r", "r.id", "o.requestId")
    .select([
      "f.id",
      "f.topic",
      "f.thing",
      "f.property",
      "f.value",
      "f.replacesId",
      "f.writerKind",
      "f.writerId",
      "f.writtenAt",
      "r.channelId",
      "r.triggerMessageId",
    ])
    .where("f.topic", "=", input.topicId);
  if (input.before !== undefined) query = query.where("f.id", "<", input.before);
  if (input.current)
    query = query.where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("knowledge.factLog as later")
            .select("later.id")
            .whereRef("later.topic", "=", "f.topic")
            .whereRef("later.thing", "=", "f.thing")
            .whereRef("later.property", "=", "f.property")
            .whereRef("later.id", ">", "f.id"),
        ),
      ),
    );
  const rows = await query
    .orderBy("f.id", "desc")
    .limit(input.limit + 1)
    .execute();
  return {
    facts: rows.slice(0, input.limit).map((row) => ({
      id: row.id,
      topicId: row.topic,
      thing: row.thing,
      property: row.property,
      value: row.value,
      replacesId: row.replacesId,
      writerKind: row.writerKind,
      writerUserId: row.writerId,
      writtenAt: row.writtenAt,
      source:
        row.channelId && row.triggerMessageId
          ? { channelId: row.channelId, messageId: row.triggerMessageId }
          : null,
    })),
    hasMore: rows.length > input.limit,
  };
}

export async function isTeamAdmin(executor: Executor, userId: UserId): Promise<boolean> {
  const member = await executor
    .selectFrom("teamMembers")
    .select("role")
    .where("userId", "=", userId)
    .where("state", "=", "active")
    .executeTakeFirst();
  return member?.role === "owner" || member?.role === "admin";
}

/** One audit row; metadata holds IDs, counts and fingerprints, never SQL text, parameters or values. */
export async function appendTeamKnowledgeAudit(
  executor: Executor,
  entry: {
    readonly actor: TeamActor;
    readonly linkId?: TeamLinkId | null;
    readonly requestId?: TeamAgentRequestId | null;
    readonly action: string;
    readonly resourceKind: "topic" | "channel";
    readonly resourceId: string | null;
    readonly channelId: TeamChannelId | null;
    readonly outcome: "allowed" | "denied";
    readonly metadata: Readonly<Record<string, unknown>>;
  },
): Promise<string> {
  const row = await executor
    .insertInto("teamAudit")
    .values({
      actorUserId: entry.actor.userId,
      actorKind: entry.actor.kind,
      linkId: entry.linkId ?? null,
      agentRequestId: entry.requestId ?? null,
      action: entry.action,
      resourceKind: entry.resourceKind,
      resourceId: entry.resourceId,
      channelId: entry.channelId,
      outcome: entry.outcome,
      metadata: entry.metadata,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

/** A refused agent call, recorded against the link and, when it names one of that link's, the request. */
export async function appendTeamKnowledgeDenial(
  executor: Executor,
  input: {
    readonly linkId: TeamLinkId;
    readonly requestId: TeamAgentRequestId;
    readonly metadata: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  await sql`
    insert into team_audit (actor_user_id, actor_kind, link_id, agent_request_id, action,
      resource_kind, resource_id, channel_id, outcome, metadata)
    select l.owner_user_id, 'agent', l.id, r.id, 'knowledge.sql', 'topic', null, r.channel_id,
      'denied', ${JSON.stringify(input.metadata)}::jsonb
    from team_links l
    left join team_agent_requests r on r.id = ${input.requestId} and r.link_id = l.id
    where l.id = ${input.linkId}
  `.execute(executor);
}

/** Tells a shared topic's managers that an admin added themselves to it. */
export async function noticeTeamTopicManagers(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly topicId: KnowledgeTopicId;
    readonly auditId: string;
    readonly except: UserId;
  },
): Promise<void> {
  const recipients = (await teamTopicManagers(transaction, input.topicId)).filter(
    (userId) => userId !== input.except,
  );
  if (!recipients.length) return;
  const notices = recipients.map((recipientUserId) => ({
    id: createId("teamNotice"),
    recipientUserId,
    kind: "admin-self-added" as const,
    resourceKind: "topic" as const,
    resourceId: input.topicId,
    auditId: input.auditId,
    dedupeKey: `topic:${input.topicId}:${input.auditId}`,
  }));
  await transaction.insertInto("teamNotices").values(notices).execute();
  await transaction
    .insertInto("teamOutbox")
    .values(notices.map((notice) => ({ kind: "notice" as const, noticeId: notice.id })))
    .execute();
}
