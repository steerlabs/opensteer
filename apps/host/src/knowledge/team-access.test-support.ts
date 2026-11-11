import {
  OpensteerError,
  type KnowledgeTopicId,
  type Sequence,
  type TeamActor,
  type TeamChannelId,
} from "@opensteer/core";
import type { DatabaseSchema } from "@opensteer/database";
import { sql, type Kysely, type Transaction } from "kysely";
import type { TeamChannelAuthority, TeamTopicAuthority } from "../team/access-port.js";
import type { TeamKnowledgeAccess, TeamKnowledgeAudit } from "./team-knowledge.js";

/** Points where a test holds a call still, to order it against an access change. */
export interface TeamAccessPauses {
  /** Authorized, about to take the access lock for a knowledge write. */
  beforeWriteLock?: () => Promise<void>;
  /** Holding the access lock, before the write is re-checked and run. */
  insideWriteLock?: () => Promise<void>;
  /** A buffered answer is ready, about to compare revisions. */
  beforeHandoff?: () => Promise<void>;
}

/**
 * Team access as lane T's access store provides it, for knowledge tests: access changes
 * take the access row exclusively and bump the revision before returning; knowledge writes
 * share it (and lock a channel topic's channel) through their callback. Channels follow
 * their lists through nested groups; admins manage public and private channels and every
 * shared topic; agents get nothing that is people-only.
 */
export function testTeamAccess(database: Kysely<DatabaseSchema>) {
  const pauses: TeamAccessPauses = {};
  const changes: { readonly actor: TeamActor; readonly action: string }[] = [];
  let revision = 0n;
  const denied = () => new OpensteerError({ code: "forbidden", message: "Team access denied" });
  const access: TeamKnowledgeAccess = {
    channel: channelAuthority,
    topic: topicAuthority,
    async mutate(write) {
      const { value } = await database.transaction().execute(async (transaction) => {
        await sql`select from team_access_state where singleton_key = 'team' for update`.execute(
          transaction,
        );
        const result = await write(transaction);
        await sql`update team_access_state set revision = revision + 1, updated_at = now()
          where singleton_key = 'team'`.execute(transaction);
        return result;
      });
      revision += 1n;
      return value;
    },
    async mutateAs(actor, action, write) {
      changes.push({ actor, action });
      return access.mutate(async (transaction) => {
        const { rows } = await sql`select from team_members
          where user_id = ${actor.userId} and state = 'active'`.execute(transaction);
        if (!rows.length) throw denied();
        return write(transaction);
      });
    },
    async contentWrite() {
      throw new Error("Content writes are not part of team knowledge");
    },
    async knowledgeWrite(actor, topicId, write) {
      await pauses.beforeWriteLock?.();
      return database.transaction().execute(async (transaction) => {
        await sql`select from team_access_state where singleton_key = 'team' for share`.execute(
          transaction,
        );
        const { rows } = await sql<{ originChannelId: TeamChannelId | null }>`
          select origin_channel_id from knowledge.topics where id = ${topicId}`.execute(
          transaction,
        );
        if (rows[0]?.originChannelId)
          await sql`select from team_channels where id = ${rows[0].originChannelId} for update`.execute(
            transaction,
          );
        await pauses.insideWriteLock?.();
        const authority = await topicAuthority(transaction, actor, topicId);
        if (!authority.write) throw denied();
        return write(transaction, authority);
      });
    },
    get revision() {
      return String(revision) as Sequence;
    },
    async handoff(authorizedAt, authorize, deliver) {
      await pauses.beforeHandoff?.();
      while (authorizedAt !== access.revision) {
        authorizedAt = access.revision;
        if (!(await authorize())) throw denied();
      }
      return deliver();
    },
  };
  return { access, pauses, changes };
}

/** Writes audit rows as the team audit log does. */
export const testTeamAudit: TeamKnowledgeAudit = async (executor, entry) => {
  await executor
    .insertInto("teamAudit")
    .values({
      actorUserId: entry.actor.userId,
      actorKind: entry.actor.kind,
      linkId: entry.linkId ?? null,
      agentRequestId: entry.requestId ?? null,
      action: entry.action,
      resourceKind: entry.resourceKind,
      resourceId: entry.resourceId ?? null,
      channelId: entry.channelId ?? null,
      outcome: entry.outcome ?? "allowed",
      metadata: entry.metadata ?? {},
    })
    .execute();
};

const memberGroups = (actor: TeamActor) => sql`with recursive member_groups(id) as (
  select p.group_id from team_group_people p
  join team_groups g on g.id = p.group_id and g.deleted_at is null
  where p.user_id = ${actor.userId}
  union
  select e.parent_group_id from team_group_edges e
  join member_groups m on e.child_group_id = m.id
  join team_groups g on g.id = e.parent_group_id and g.deleted_at is null
)`;

async function channelAuthority(
  transaction: Transaction<DatabaseSchema>,
  actor: TeamActor,
  channelId: TeamChannelId,
): Promise<TeamChannelAuthority> {
  const { rows } = await sql<TeamChannelAuthority>`${memberGroups(actor)}
    select c.people_only,
      coalesce(bool_or(a.subject_id is not null), false)
        and (not c.people_only or ${actor.kind} = 'human') as read,
      coalesce(bool_or(a.level = 'post'), false) and c.archived_at is null
        and (not c.people_only or ${actor.kind} = 'human') as post,
      ${actor.kind} = 'human' and (coalesce(bool_or(a.manage), false)
        or (c.kind in ('public', 'private') and m.role in ('owner', 'admin'))) as manage
    from team_channels c
    join team_members m on m.user_id = ${actor.userId} and m.state = 'active'
    left join team_channel_members a on a.channel_id = c.id
      and ((a.subject_kind = 'person' and a.subject_id = m.user_id)
        or (a.subject_kind = 'group' and a.subject_id in (select id from member_groups)))
    where c.id = ${channelId}
    group by c.id, m.role
  `.execute(transaction);
  return rows[0] ?? { read: false, post: false, manage: false, peopleOnly: false };
}

async function topicAuthority(
  transaction: Transaction<DatabaseSchema>,
  actor: TeamActor,
  topicId: KnowledgeTopicId,
): Promise<TeamTopicAuthority> {
  const topic = (
    await sql<{
      originChannelId: TeamChannelId | null;
      peopleOnly: boolean;
      archivedAt: Date | null;
    }>`
      select origin_channel_id, people_only, archived_at from knowledge.topics where id = ${topicId}
    `.execute(transaction)
  ).rows[0];
  if (!topic) return { read: false, write: false, manage: false, peopleOnly: false };
  const blocked = actor.kind === "agent" && topic.peopleOnly;
  if (topic.originChannelId) {
    const channel = await channelAuthority(transaction, actor, topic.originChannelId);
    return {
      read: channel.read && !blocked,
      write: channel.post && !topic.archivedAt && !blocked,
      manage: channel.manage,
      peopleOnly: channel.peopleOnly || topic.peopleOnly,
    };
  }
  const grants = (
    await sql<{ read: boolean; write: boolean; manage: boolean }>`${memberGroups(actor)}
      select count(g.topic_id) > 0 as read,
        coalesce(bool_or(g.level in ('write', 'manage')), false) as write,
        ${actor.kind} = 'human' and (coalesce(bool_or(g.level = 'manage'), false)
          or m.role in ('owner', 'admin')) as manage
      from team_members m
      left join team_topic_grants g on g.topic_id = ${topicId}
        and ((g.subject_kind = 'person' and g.subject_id = m.user_id)
          or (g.subject_kind = 'group' and g.subject_id in (select id from member_groups)))
      where m.user_id = ${actor.userId} and m.state = 'active'
      group by m.role
    `.execute(transaction)
  ).rows[0];
  return {
    read: !!grants?.read && !blocked,
    write: !!grants?.write && !topic.archivedAt && !blocked,
    manage: !!grants?.manage,
    peopleOnly: topic.peopleOnly,
  };
}
