import {
  OpensteerError,
  SequenceSchema,
  type KnowledgeTopicId,
  type Sequence,
  type TeamActor,
  type TeamAgentRequestId,
  type TeamChannelId,
  type TeamLinkId,
  type TeamMessageId,
  type UserId,
} from "@opensteer/core";
import { sql, type Kysely, type Transaction, type RawBuilder } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { appendTeamAudit } from "./team-audit-store.js";
import { resolveTeamTopicAuthority } from "./team-topics-store.js";
import { addTeamSelfAddNotices } from "./team-notices-store.js";

export interface TeamStoreAccessEffects {
  readonly users: readonly UserId[];
  readonly channels: readonly TeamChannelId[];
  readonly topics: readonly KnowledgeTopicId[];
  readonly links: readonly TeamLinkId[];
  readonly requests: readonly TeamAgentRequestId[];
}
export const emptyTeamAccessEffects: TeamStoreAccessEffects = {
  users: [],
  channels: [],
  topics: [],
  links: [],
  requests: [],
};
export function requireTeam(condition: unknown, message = "Team access denied"): asserts condition {
  if (!condition) throw new OpensteerError({ code: "forbidden", message });
}
export function teamConflict(message: string): never {
  throw new OpensteerError({ code: "conflict", message });
}

export function teamGroupPaths(userId: UserId | RawBuilder<unknown>) {
  return sql`with recursive member_groups(id, path) as (
    select p.group_id, array[p.group_id] from team_group_people p
    join team_groups g on g.id=p.group_id and g.deleted_at is null where p.user_id=${userId}
    union all
    select e.parent_group_id, p.path || e.parent_group_id from member_groups p
    join team_group_edges e on e.child_group_id=p.id
    join team_groups g on g.id=e.parent_group_id and g.deleted_at is null
    where cardinality(p.path)<16 and not e.parent_group_id=any(p.path)
  )`;
}
export function teamReadableChannelIds(
  userId: UserId | RawBuilder<unknown>,
  kind: TeamActor["kind"],
) {
  return sql<TeamChannelId>`(${teamGroupPaths(userId)}
    select c.id from team_channels c where (${kind}='human' or not c.people_only)
    and exists(select 1 from team_members m where m.user_id=${userId} and m.state='active')
    and exists(select 1 from team_channel_members a where a.channel_id=c.id and
      ((a.subject_kind='person' and a.subject_id=${userId}) or
       (a.subject_kind='group' and a.subject_id in (select id from member_groups))))
  )`;
}

export function teamReadableChannels(actor: TeamActor) {
  return teamReadableChannelIds(actor.userId, actor.kind);
}

export class TeamAccessStore {
  #revision: Sequence = SequenceSchema.parse("0");
  readonly #closers = new Set<(effects: TeamStoreAccessEffects) => Promise<void> | void>();
  readonly database: Kysely<DatabaseSchema>;
  constructor(database: Kysely<DatabaseSchema>) {
    this.database = database;
  }
  get revision() {
    return this.#revision;
  }
  async initialize() {
    await this.database
      .insertInto("teamAccessState")
      .values({ singletonKey: "team", updatedAt: new Date() })
      .onConflict((c) => c.column("singletonKey").doNothing())
      .execute();
    const row = await this.database
      .selectFrom("teamAccessState")
      .select("revision")
      .where("singletonKey", "=", "team")
      .executeTakeFirstOrThrow();
    this.#revision = SequenceSchema.parse(row.revision);
  }
  onRevoke(close: (effects: TeamStoreAccessEffects) => Promise<void> | void) {
    this.#closers.add(close);
    return () => {
      this.#closers.delete(close);
    };
  }
  async member(transaction: Transaction<DatabaseSchema>, userId: UserId) {
    const member = await transaction
      .selectFrom("teamMembers")
      .selectAll()
      .where("userId", "=", userId)
      .where("state", "=", "active")
      .executeTakeFirst();
    requireTeam(member, "Active team membership required");
    return member;
  }
  async admin(transaction: Transaction<DatabaseSchema>, actor: TeamActor) {
    requireTeam(actor.kind === "human");
    const member = await this.member(transaction, actor.userId);
    requireTeam(member.role === "owner" || member.role === "admin", "Team administrator required");
    return member;
  }
  async channel(
    transaction: Transaction<DatabaseSchema>,
    actor: TeamActor,
    channelId: TeamChannelId,
  ) {
    const result = await sql<{
      read: boolean;
      post: boolean;
      manage: boolean;
      peopleOnly: boolean;
    }>`${teamGroupPaths(actor.userId)}
      select c.people_only,
      coalesce(bool_or(a.subject_id is not null),false) and (not c.people_only or ${actor.kind}='human') as read,
      coalesce(bool_or(a.level='post'),false) and c.archived_at is null and (not c.people_only or ${actor.kind}='human') as post,
      (${actor.kind}='human' and (coalesce(bool_or(a.manage),false) or (c.kind in ('public','private') and m.role in ('owner','admin')))) as manage
      from team_channels c join team_members m on m.user_id=${actor.userId} and m.state='active'
      left join team_channel_members a on a.channel_id=c.id and ((a.subject_kind='person' and a.subject_id=m.user_id) or (a.subject_kind='group' and a.subject_id in(select id from member_groups)))
      where c.id=${channelId} group by c.id,m.role`.execute(transaction);
    return result.rows[0] ?? { read: false, post: false, manage: false, peopleOnly: false };
  }
  async topic(
    transaction: Transaction<DatabaseSchema>,
    actor: TeamActor,
    topicId: KnowledgeTopicId,
  ) {
    return resolveTeamTopicAuthority(transaction, actor, topicId, (channelId) =>
      this.channel(transaction, actor, channelId),
    );
  }

  async mutate<Value>(
    write: (
      transaction: Transaction<DatabaseSchema>,
    ) => Promise<{ readonly value: Value; readonly effects: TeamStoreAccessEffects }>,
    afterAuthority?: (transaction: Transaction<DatabaseSchema>, value: Value) => Promise<void>,
  ): Promise<Value> {
    const committed = await this.database.transaction().execute(async (transaction) => {
      // The singleton is the first row lock, including across indirect group changes.
      await transaction
        .selectFrom("teamAccessState")
        .select("revision")
        .where("singletonKey", "=", "team")
        // FOR UPDATE: Required by M1/M2 to fence ACL deletion against content SHARE through COMMIT.
        .forUpdate()
        .executeTakeFirstOrThrow();
      // Authority UPDATE already excludes content; reserve channels before later request cancellation discovers them.
      await transaction
        .selectFrom("teamChannels")
        .select("id")
        .orderBy("id")
        // FOR UPDATE: M1/M2 requires the same channel lock before content and ACL removal.
        .forUpdate()
        .execute();
      const result = await write(transaction);
      const effects = await this.#terminalize(transaction, result.effects);
      await afterAuthority?.(transaction, result.value);
      const state = await transaction
        .updateTable("teamAccessState")
        .set({
          revision: sql`revision+1`,
          directoryRevision: sql`directory_revision+1`,
          updatedAt: new Date(),
        })
        .where("singletonKey", "=", "team")
        .returning("revision")
        .executeTakeFirstOrThrow();
      return { ...result, effects, revision: SequenceSchema.parse(state.revision) };
    });
    if (BigInt(committed.revision) > BigInt(this.#revision)) this.#revision = committed.revision;
    const closed = await Promise.allSettled(
      [...this.#closers].map((close) => close(committed.effects)),
    );
    const failed = closed.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
    if (failed.length)
      throw new AggregateError(failed, "Team access committed but closing a transport failed");
    return committed.value;
  }
  async mutateAs<Value>(
    actor: TeamActor,
    action: string,
    write: (
      transaction: Transaction<DatabaseSchema>,
    ) => Promise<{ readonly value: Value; readonly effects: TeamStoreAccessEffects }>,
    afterAuthority?: (transaction: Transaction<DatabaseSchema>, value: Value) => Promise<void>,
  ): Promise<Value> {
    return this.mutate(async (transaction) => {
      const member = await this.member(transaction, actor.userId);
      const admin = actor.kind === "human" && member.role !== "member";
      const known = new Set<string>();
      if (admin) {
        for (const { id } of await transaction
          .selectFrom("teamChannels")
          .select("id")
          .where("kind", "=", "private")
          .execute())
          known.add(`channel:${id}`);
        if (
          (
            await sql<{
              present: boolean;
            }>`select to_regclass('knowledge.topics') is not null as present`.execute(transaction)
          ).rows[0]?.present
        )
          for (const { id } of (
            await sql<{
              id: string;
            }>`select id from knowledge.topics where origin_channel_id is null`.execute(transaction)
          ).rows)
            known.add(`topic:${id}`);
      }
      const before = admin ? await this.#readableRestricted(transaction, actor) : new Set<string>();
      const result = await write(transaction);
      if (admin) {
        const after = await this.#readableRestricted(transaction, actor);
        for (const key of after) {
          if (before.has(key) || !known.has(key)) continue;
          const colon = key.indexOf(":");
          const resourceKind = key.slice(0, colon) === "channel" ? "channel" : "topic";
          const resourceId = key.slice(colon + 1);
          const auditId = await appendTeamAudit(transaction, {
            actor,
            action: "admin.self-added",
            resourceKind,
            resourceId,
            metadata: { via: action },
          });
          const managerIds = await this.#managers(transaction, resourceKind, resourceId);
          await addTeamSelfAddNotices(transaction, {
            actorUserId: actor.userId,
            managerIds,
            resourceKind,
            resourceId,
            auditId,
          });
        }
      }
      return result;
    }, afterAuthority);
  }
  async #readableRestricted(transaction: Transaction<DatabaseSchema>, actor: TeamActor) {
    const set = new Set<string>();
    const channels = await transaction
      .selectFrom("teamChannels")
      .select("id")
      .where("kind", "=", "private")
      .where("id", "in", teamReadableChannels(actor))
      .execute();
    for (const channel of channels) set.add(`channel:${channel.id}`);
    const exists = (
      await sql<{
        present: boolean;
      }>`select to_regclass('knowledge.topics') is not null as present`.execute(transaction)
    ).rows[0]?.present;
    if (exists) {
      const topics = await sql<{
        id: KnowledgeTopicId;
      }>`select id from knowledge.topics where origin_channel_id is null order by id`.execute(
        transaction,
      );
      for (const topic of topics.rows)
        if ((await this.topic(transaction, actor, topic.id)).read) set.add(`topic:${topic.id}`);
    }
    return set;
  }
  async #managers(transaction: Transaction<DatabaseSchema>, kind: "channel" | "topic", id: string) {
    const people = await transaction
      .selectFrom("teamMembers")
      .select("userId")
      .where("state", "=", "active")
      .orderBy("userId")
      .execute();
    const managers: UserId[] = [];
    for (const { userId } of people) {
      const rights =
        kind === "channel"
          ? (
              await sql<{
                manage: boolean;
              }>`${teamGroupPaths(userId)} select coalesce(bool_or(manage),false) as manage from team_channel_members where channel_id=${id} and ((subject_kind='person' and subject_id=${userId}) or(subject_kind='group' and subject_id in(select id from member_groups)))`.execute(
                transaction,
              )
            ).rows[0]
          : (
              await sql<{
                manage: boolean;
              }>`${teamGroupPaths(userId)} select count(*)>0 as manage from team_topic_grants where topic_id=${id} and level='manage' and ((subject_kind='person' and subject_id=${userId}) or(subject_kind='group' and subject_id in(select id from member_groups)))`.execute(
                transaction,
              )
            ).rows[0];
      if (rights?.manage) managers.push(userId);
    }
    return managers;
  }
  async #terminalize(
    transaction: Transaction<DatabaseSchema>,
    input: TeamStoreAccessEffects,
  ): Promise<TeamStoreAccessEffects> {
    const links = new Set(input.links),
      requests = new Set(input.requests),
      channels = new Set(input.channels);
    const invalidLinks = await transaction
      .selectFrom("teamLinks as l")
      .leftJoin("teamMembers as m", "m.userId", "l.ownerUserId")
      .select("l.id")
      .where("l.state", "!=", "revoked")
      .where((e) => e.or([e("m.state", "is", null), e("m.state", "!=", "active")]))
      .orderBy("l.id")
      .execute();
    for (const { id } of invalidLinks) links.add(id);
    if (links.size) {
      await transaction
        .selectFrom("teamLinks")
        .select("id")
        .where("id", "in", [...links])
        .orderBy("id")
        .forNoKeyUpdate()
        .execute();
      await transaction
        .updateTable("teamLinks")
        .set({ state: "revoked", revokedAt: new Date() })
        .where("id", "in", [...links].sort())
        .execute();
    }
    const pending = await transaction
      .selectFrom("teamAgentRequests")
      .selectAll()
      .where("state", "in", ["queued", "working", "needs_you"])
      .orderBy("channelId")
      .orderBy("id")
      .execute();
    for (const request of pending) {
      const authority = await this.channel(
        transaction,
        { kind: "agent", userId: request.ownerUserId },
        request.channelId,
      );
      if (
        links.has(request.linkId) ||
        !authority.read ||
        !authority.post ||
        requests.has(request.id)
      ) {
        requests.add(request.id);
        channels.add(request.channelId);
      }
    }
    // Access UPDATE excludes all content SHARE holders before these ordered channel locks.
    if (channels.size)
      await transaction
        .selectFrom("teamChannels")
        .select("id")
        .where("id", "in", [...channels].sort())
        .orderBy("id")
        // FOR UPDATE: Required by M1/M2 to fence ACL deletion against content SHARE through COMMIT.
        .forUpdate()
        .execute();
    const affectedRequests = pending.filter((r) => requests.has(r.id));
    await lockTeamMessages(
      transaction,
      affectedRequests.map((r) => r.threadRootId),
    );
    if (affectedRequests.length)
      await transaction
        .selectFrom("teamAgentRequests")
        .select("id")
        .where(
          "id",
          "in",
          affectedRequests.map((r) => r.id),
        )
        .orderBy("id")
        .forNoKeyUpdate()
        .execute();
    for (const channelId of [...channels].sort()) {
      const affected = pending.filter((r) => r.channelId === channelId && requests.has(r.id));
      if (!affected.length) continue;
      const { changeSeq } = await bumpTeamChannel(transaction, channelId);
      for (const request of affected) {
        await transaction
          .updateTable("teamAgentRequests")
          .set({
            state: "cancelled",
            finishedAt: new Date(),
            failureCode: links.has(request.linkId) ? "link_revoked" : "access_revoked",
            changeSeq,
          })
          .where("id", "=", request.id)
          .execute();
        await transaction
          .updateTable("teamMessages")
          .set({ changeSeq })
          .where("id", "=", request.threadRootId)
          .execute();
      }
    }
    return { ...input, channels: [...channels], links: [...links], requests: [...requests] };
  }
  async contentWrite<Value>(
    actor: TeamActor,
    channelId: TeamChannelId,
    write: (
      transaction: Transaction<DatabaseSchema>,
      authority: Awaited<ReturnType<TeamAccessStore["channel"]>>,
    ) => Promise<Value>,
  ) {
    return this.database.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom("teamAccessState")
        .select("revision")
        .where("singletonKey", "=", "team")
        .forShare()
        .executeTakeFirstOrThrow();
      await transaction
        .selectFrom("teamChannels")
        .select("id")
        .where("id", "=", channelId)
        // FOR UPDATE: Required by M1/M2 to fence ACL deletion against content SHARE through COMMIT.
        .forUpdate()
        .executeTakeFirstOrThrow();
      return write(transaction, await this.channel(transaction, actor, channelId));
    });
  }
  async knowledgeWrite<Value>(
    actor: TeamActor,
    topicId: KnowledgeTopicId,
    write: (
      transaction: Transaction<DatabaseSchema>,
      authority: Awaited<ReturnType<TeamAccessStore["topic"]>>,
    ) => Promise<Value>,
  ) {
    return this.database.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom("teamAccessState")
        .select("revision")
        .where("singletonKey", "=", "team")
        .forShare()
        .executeTakeFirstOrThrow();
      const topic = (
        await sql<{
          originChannelId: TeamChannelId | null;
        }>`select origin_channel_id from knowledge.topics where id=${topicId}`.execute(transaction)
      ).rows[0];
      if (topic?.originChannelId)
        await transaction
          .selectFrom("teamChannels")
          .select("id")
          .where("id", "=", topic.originChannelId)
          // FOR UPDATE: Required by M1/M2 to fence ACL deletion against content SHARE through COMMIT.
          .forUpdate()
          .executeTakeFirstOrThrow();
      const authority = await this.topic(transaction, actor, topicId);
      requireTeam(authority.write);
      return write(transaction, authority);
    });
  }
  async handoff<Value>(
    authorizedAt: Sequence,
    authorize: () => Promise<boolean>,
    deliver: () => Value,
  ): Promise<Value> {
    while (authorizedAt !== this.#revision) {
      authorizedAt = this.#revision;
      requireTeam(await authorize());
    }
    return deliver();
  }
}

export async function lockTeamMessages(
  transaction: Transaction<DatabaseSchema>,
  ids: readonly TeamMessageId[],
) {
  if (ids.length)
    await transaction
      .selectFrom("teamMessages")
      .select("id")
      .where("id", "in", [...new Set(ids)])
      .orderBy("id")
      .forNoKeyUpdate()
      .execute();
}

export function bumpTeamChannel(
  transaction: Transaction<DatabaseSchema>,
  channelId: TeamChannelId,
) {
  return transaction
    .updateTable("teamChannels")
    .set({ changeSeq: sql`change_seq+1`, updatedAt: new Date() })
    .where("id", "=", channelId)
    .returning(["changeSeq"])
    .executeTakeFirstOrThrow();
}
