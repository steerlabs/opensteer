import { OpensteerError, type Sequence, type TeamActor, type TeamChannelId } from "@opensteer/core";
import { resolveTeamTopicAuthority, type DatabaseSchema } from "@opensteer/database";
import { sql, type Kysely, type Transaction } from "kysely";
import type {
  TeamAccessLockPort,
  TeamAccessResolver,
  TeamChannelAuthority,
} from "../team/access-port.js";

/** Points where a test holds a call still, to order it against an access change. */
export interface TeamAccessPauses {
  /** Authorized, about to take the access lock for a knowledge write. */
  beforeWriteLock?: () => Promise<void>;
  /** Holding the access lock, about to run the write. */
  insideWriteLock?: () => Promise<void>;
  /** A buffered answer is ready, about to compare revisions. */
  beforeHandoff?: () => Promise<void>;
}

/**
 * The frozen access ports as the team service must implement them: access changes take
 * the access row exclusively and bump the revision before returning; knowledge writes
 * hold it shared through their callback. Channel authority follows the channel's list
 * through nested groups; topics resolve through the knowledge store.
 */
export function testTeamAccess(database: Kysely<DatabaseSchema>) {
  const pauses: TeamAccessPauses = {};
  let revision = 0n;
  const resolver: TeamAccessResolver = {
    channel: (transaction, actor, channelId) => channelAuthority(transaction, actor, channelId),
    topic: (transaction, actor, topicId) =>
      resolveTeamTopicAuthority(transaction, actor, topicId, (channelId) =>
        channelAuthority(transaction, actor, channelId),
      ),
  };
  const lock: TeamAccessLockPort = {
    async mutate(write) {
      const { value } = await database.transaction().execute(async (transaction) => {
        await sql`select from team_access_state where singleton_key = 'team' for no key update`.execute(
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
    async contentWrite() {
      throw new Error("Content writes are not part of team knowledge");
    },
    async knowledgeWrite(actor, topicId, write) {
      await pauses.beforeWriteLock?.();
      return database.transaction().execute(async (transaction) => {
        await sql`select from team_access_state where singleton_key = 'team' for share`.execute(
          transaction,
        );
        await pauses.insideWriteLock?.();
        return write(transaction, await resolver.topic(transaction, actor, topicId));
      });
    },
    get revision() {
      return String(revision) as Sequence;
    },
    async handoff(authorizedAt, authorize, deliver) {
      await pauses.beforeHandoff?.();
      if (authorizedAt !== lock.revision && !(await authorize()))
        throw new OpensteerError({ code: "forbidden", message: "Access changed" });
      return deliver();
    },
  };
  return { resolver, lock, pauses };
}

async function channelAuthority(
  transaction: Transaction<DatabaseSchema>,
  actor: TeamActor,
  channelId: TeamChannelId,
): Promise<TeamChannelAuthority> {
  const { rows } = await sql<{ peopleOnly: boolean; level: number | null; manage: boolean | null }>`
    with recursive member_groups(id) as (
      select p.group_id from team_group_people p
      join team_groups g on g.id = p.group_id and g.deleted_at is null
      where p.user_id = ${actor.userId}
      union
      select e.parent_group_id from team_group_edges e
      join member_groups m on e.child_group_id = m.id
      join team_groups g on g.id = e.parent_group_id and g.deleted_at is null
    )
    select c.people_only,
      max(case m.level when 'post' then 2 when 'read' then 1 end)::int as level, bool_or(m.manage) as manage
    from team_channels c
    left join team_channel_members m on m.channel_id = c.id
      and exists (select from team_members where user_id = ${actor.userId} and state = 'active')
      and ((m.subject_kind = 'person' and m.subject_id = ${actor.userId})
        or (m.subject_kind = 'group' and m.subject_id in (select id from member_groups)))
    where c.id = ${channelId}
    group by c.id
  `.execute(transaction);
  const row = rows[0];
  const level = row?.level ?? 0;
  const human = {
    read: level >= 1,
    post: level >= 2,
    manage: row?.manage === true,
    peopleOnly: row?.peopleOnly === true,
  };
  if (actor.kind === "human") return human;
  return human.peopleOnly
    ? { read: false, post: false, manage: false, peopleOnly: true }
    : { ...human, manage: false };
}
