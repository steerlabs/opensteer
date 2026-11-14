import { teamAskerCanPost, cancelUnavailableSharedAsks } from "./team-shared-agents.js";
import { teamSharedChannelsApiVersion } from "@opensteer/protocol";
import { AsyncLocalStorage } from "node:async_hooks";
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
  type AuthenticatedSession,
  type AuthSessionId,
} from "@opensteer/core";
import { sql, type Kysely, type Transaction, type RawBuilder } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { createTeamAskReturn } from "./team-request-returns.js";
import { appendTeamAudit } from "./team-audit-store.js";
import { addTeamSelfAddNotices } from "./team-notices-store.js";
import { teamReadableTopicIds } from "./team-knowledge-store.js";

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
export function teamConflict(message: string, reason?: string): never {
  throw new OpensteerError({ code: "conflict", message, ...(reason ? { reason } : {}) });
}

const teamPeerVersion = new AsyncLocalStorage<number>();
export function withTeamPeerVersion<Value>(version: number, run: () => Value): Value {
  return teamPeerVersion.run(version, run);
}
export function teamPeerSupportsSharedChannels() {
  return (
    (teamPeerVersion.getStore() ?? teamSharedChannelsApiVersion) >= teamSharedChannelsApiVersion
  );
}
export function assertTeamSharedChannelVersion(shared: boolean) {
  if (shared && !teamPeerSupportsSharedChannels())
    teamConflict(
      "Update Opensteer to use shared channels and their external audience.",
      "api-version-mismatch",
    );
}
export function teamSharedChannelIds() {
  return sql<TeamChannelId>`(select channel_id from team_shares where channel_id is not null and (state='active' or role='follower'))`;
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
export function teamChannelPeopleOnly() {
  return sql<boolean>`(c.people_only or exists(select 1 from team_shares s where s.channel_id=c.id and s.role='follower' and s.people_only))`;
}
function teamChannelAgentsBlocked() {
  return sql<boolean>`(${teamChannelPeopleOnly()} or exists(select 1 from team_shares s where s.channel_id=c.id and s.state='active' and not s.agents_enabled))`;
}
export function teamReadableChannelIds(
  userId: UserId | RawBuilder<unknown>,
  kind: TeamActor["kind"],
  localAclOnly = false,
) {
  return sql<TeamChannelId>`(${teamGroupPaths(userId)}
    select c.id from team_channels c where (${kind}='human' or not ${teamChannelAgentsBlocked()})
    and exists(select 1 from team_members m where m.user_id=${userId} and m.state='active')
    and (${localAclOnly} or not exists(select 1 from team_shares s where s.channel_id=c.id and s.role='follower' and not s.ready and s.state<>'ended'))
    and (${localAclOnly} or not exists(select 1 from team_shares s join team_share_participants p on p.share_id=s.id
      where s.channel_id=c.id and s.role='follower' and p.principal_id=${userId} and p.state='removed'))
    and exists(select 1 from team_channel_members a where a.channel_id=c.id and
      ((a.subject_kind='person' and a.subject_id=${userId}) or
       (a.subject_kind='group' and a.subject_id in (select id from member_groups))))
  )`;
}

export function teamReadableChannels(actor: TeamActor) {
  return teamPeerSupportsSharedChannels()
    ? teamReadableChannelIds(actor.userId, actor.kind)
    : sql<TeamChannelId>`(select id from team_channels where id in ${teamReadableChannelIds(actor.userId, actor.kind)} and id not in ${teamSharedChannelIds()})`;
}

export class TeamAccessStore {
  readonly #sessions = new AsyncLocalStorage<{ sessionId: AuthSessionId; userId: UserId }>();
  #revision: Sequence = SequenceSchema.parse("0");
  readonly #closers = new Set<(effects: TeamStoreAccessEffects) => Promise<void> | void>();
  readonly #beforeCommit = new Set<
    (transaction: Transaction<DatabaseSchema>, effects: TeamStoreAccessEffects) => Promise<void>
  >();
  readonly database: Kysely<DatabaseSchema>;
  constructor(database: Kysely<DatabaseSchema>) {
    this.database = database;
  }
  get revision() {
    return this.#revision;
  }
  withHumanSession<Value>(session: AuthenticatedSession, run: () => Promise<Value>) {
    return this.#sessions.run({ sessionId: session.id, userId: session.user.id }, run);
  }
  outsideHumanSession<Value>(run: () => Value): Value {
    return teamPeerVersion.exit(() => this.#sessions.exit(run));
  }
  async checkSession(transaction: Transaction<DatabaseSchema>) {
    const session = this.#sessions.getStore();
    if (!session) return;
    const valid = await transaction
      .selectFrom("authSessions as s")
      .innerJoin("teamMembers as m", "m.userId", "s.userId")
      .select("s.id")
      .where("s.id", "=", session.sessionId)
      .where("s.userId", "=", session.userId)
      .where("m.state", "=", "active")
      .whereRef("s.memberGeneration", "=", "m.generation")
      .where("s.expiresAt", ">", new Date())
      .where("s.absoluteExpiresAt", ">", new Date())
      .executeTakeFirst();
    requireTeam(valid, "Team session generation changed");
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
  /** Hooks run under the access fence and use only this transaction. */
  beforeAccessCommit(
    write: (
      transaction: Transaction<DatabaseSchema>,
      effects: TeamStoreAccessEffects,
    ) => Promise<void>,
  ) {
    this.#beforeCommit.add(write);
    return () => {
      this.#beforeCommit.delete(write);
    };
  }
  async link(transaction: Transaction<DatabaseSchema>, actor: TeamActor, linkId: TeamLinkId) {
    await transaction
      .selectFrom("teamAccessState")
      .select("revision")
      .where("singletonKey", "=", "team")
      .forShare()
      .executeTakeFirstOrThrow();
    requireTeam(actor.kind === "agent");
    const link = await transaction
      .selectFrom("teamLinks as l")
      .innerJoin("teamMembers as m", "m.userId", "l.ownerUserId")
      .selectAll("l")
      .where("l.id", "=", linkId)
      .where("l.ownerUserId", "=", actor.userId)
      .where("l.state", "=", "active")
      .where("m.state", "=", "active")
      .executeTakeFirst();
    requireTeam(link, "Active owner link required");
    return link;
  }
  async member(transaction: Transaction<DatabaseSchema>, userId: UserId) {
    const member = await transaction
      .selectFrom("teamMembers")
      .selectAll()
      .where("userId", "=", userId)
      .where("state", "=", "active")
      .executeTakeFirst();
    if (!member)
      throw new OpensteerError({
        code: "forbidden",
        reason: "removed",
        message: "Active team membership required",
      });
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
    return (
      (await this.channels(transaction, actor, [channelId])).get(channelId) ?? {
        read: false,
        post: false,
        manage: false,
        peopleOnly: false,
      }
    );
  }
  async channels(
    transaction: Transaction<DatabaseSchema>,
    actor: TeamActor,
    channelIds: readonly TeamChannelId[],
  ) {
    type Authority = { read: boolean; post: boolean; manage: boolean; peopleOnly: boolean };
    if (!channelIds.length) return new Map<TeamChannelId, Authority>();
    const result = await sql<
      Authority & { channelId: TeamChannelId; shared: boolean }
    >`${teamGroupPaths(actor.userId)}
      select c.id as channel_id, c.id in ${teamSharedChannelIds()} as shared,${teamChannelPeopleOnly()} as people_only,
      coalesce(bool_or(a.subject_id is not null),false) and (not ${teamChannelAgentsBlocked()} or ${actor.kind}='human')
        and not exists(select 1 from team_shares s where s.channel_id=c.id and s.role='follower' and not s.ready and s.state<>'ended')
        and not exists(select 1 from team_shares s join team_share_participants p on p.share_id=s.id where s.channel_id=c.id and s.role='follower' and p.principal_id=${actor.userId} and p.state='removed') as read,
      coalesce(bool_or(a.level='post'),false) and c.archived_at is null and (not ${teamChannelAgentsBlocked()} or ${actor.kind}='human')
        and not exists(select 1 from team_shares s where s.channel_id=c.id and s.role='follower' and
          (s.state<>'active' or not s.ready or not exists(select 1 from team_sharing_settings where policy<>'off') or not exists(select 1 from team_partner_links l where l.id=s.partner_link_id and l.state='active') or not exists(select 1 from team_share_participants p where p.share_id=s.id and p.principal_id=${actor.userId} and p.state='active' and p.level='post'))) as post,
      (${actor.kind}='human' and (coalesce(bool_or(a.manage),false) or (c.kind in ('public','private') and m.role in ('owner','admin')))) as manage
      from team_channels c join team_members m on m.user_id=${actor.userId} and m.state='active'
      left join team_channel_members a on a.channel_id=c.id and ((a.subject_kind='person' and a.subject_id=m.user_id) or (a.subject_kind='group' and a.subject_id in(select id from member_groups)))
      where c.id in (${sql.join(channelIds)}) group by c.id,m.role`.execute(transaction);
    for (const row of result.rows)
      assertTeamSharedChannelVersion(row.shared && (row.read || row.manage));
    return new Map(
      result.rows.map(({ channelId, shared: _, ...authority }) => [channelId, authority]),
    );
  }
  /** A person reads a topic granted to them, a group they are in, or everyone; their agent the same, never managing. */
  async topic(
    transaction: Transaction<DatabaseSchema>,
    actor: TeamActor,
    topicId: KnowledgeTopicId,
  ) {
    const topic = await transaction
      .selectFrom("teamTopics")
      .select("archivedAt")
      .where("id", "=", topicId)
      .executeTakeFirst();
    if (!topic) return { read: false, write: false, manage: false };
    const grants = (
      await sql<{ read: boolean; write: boolean; manage: boolean }>`${teamGroupPaths(actor.userId)}
      select count(g.topic_id)>0 as read,coalesce(bool_or(g.level in ('write','manage')),false) as write,
      (${actor.kind}='human' and (coalesce(bool_or(g.level='manage'),false) or m.role in ('owner','admin'))) as manage
      from team_members m left join team_topic_grants g on g.topic_id=${topicId} and
      (g.subject_kind='everyone' or (g.subject_kind='person' and g.subject_id=m.user_id)
        or (g.subject_kind='group' and g.subject_id in(select id from member_groups)))
      where m.user_id=${actor.userId} and m.state='active' group by m.role`.execute(transaction)
    ).rows[0];
    return {
      read: !!grants?.read,
      write: !!grants?.write && !topic.archivedAt,
      manage: !!grants?.manage,
    };
  }
  async mutate<Value>(
    write: (transaction: Transaction<DatabaseSchema>) => Promise<{
      readonly value: Value;
      readonly effects: TeamStoreAccessEffects;
      /** Content-only replication must not invalidate unrelated buffered reads. */
      readonly accessChanged?: boolean;
    }>,
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
      await this.checkSession(transaction);
      const result = await write(transaction);
      if (result.accessChanged === false) return { ...result, revision: null };
      for (const write of this.#beforeCommit) await write(transaction, result.effects);
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
    if (committed.revision === null) return committed.value;
    if (BigInt(committed.revision) > BigInt(this.#revision)) this.#revision = committed.revision;
    const closed = await Promise.allSettled(
      [...this.#closers].map((close) =>
        Promise.resolve().then(() => this.outsideHumanSession(() => close(committed.effects))),
      ),
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
        for (const { id } of await transaction
          .selectFrom("teamTopics")
          .select("id")
          .where(({ not, exists, selectFrom }) =>
            not(
              exists(
                selectFrom("teamTopicGrants as g")
                  .select("g.topicId")
                  .whereRef("g.topicId", "=", "teamTopics.id")
                  .where("g.subjectKind", "=", "everyone"),
              ),
            ),
          )
          .execute())
          known.add(`topic:${id}`);
      }
      const before = admin ? await this.#readableRestricted(transaction, actor) : new Set<string>();
      const candidates = [...known].filter((key) => !before.has(key));
      const previousManagers = await this.#managerLists(transaction, candidates);
      const result = await write(transaction);
      if (admin) {
        const after = await this.#readableRestricted(transaction, actor);
        const gained = [...after].filter((key) => !before.has(key) && known.has(key));
        const currentManagers = await this.#managerLists(transaction, gained);
        for (const key of gained) {
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
          const managerIds = [
            ...new Set([...(previousManagers.get(key) ?? []), ...(currentManagers.get(key) ?? [])]),
          ];
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
    const topics = await transaction
      .selectFrom("teamTopics")
      .select("id")
      .where("id", "in", teamReadableTopicIds(actor.userId))
      .orderBy("id")
      .execute();
    for (const topic of topics) set.add(`topic:${topic.id}`);
    return set;
  }
  async #managerLists(transaction: Transaction<DatabaseSchema>, keys: readonly string[]) {
    const managers = new Map<string, UserId[]>();
    if (!keys.length) return managers;
    const rows = await sql<{ resourceKey: string; userId: UserId }>`
      select distinct managed.resource_key,m.user_id from team_members m
      cross join lateral (
        ${teamGroupPaths(sql.ref("m.user_id"))}
        select 'channel:'||a.channel_id as resource_key from team_channel_members a
        where a.manage and ((a.subject_kind='person' and a.subject_id=m.user_id)
          or (a.subject_kind='group' and a.subject_id in(select id from member_groups)))
        union all
        select 'topic:'||g.topic_id as resource_key from team_topic_grants g
        where g.level='manage' and ((g.subject_kind='person' and g.subject_id=m.user_id)
          or (g.subject_kind='group' and g.subject_id in(select id from member_groups)))
      ) managed where m.state='active' and managed.resource_key=any(${keys}::text[])
    `.execute(transaction);
    for (const row of rows.rows) {
      const people = managers.get(row.resourceKey) ?? [];
      people.push(row.userId);
      managers.set(row.resourceKey, people);
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
      .where("state", "in", ["awaiting_approval", "queued", "working", "needs_you"])
      .orderBy("channelId")
      .orderBy("id")
      .execute();
    for (const request of pending) {
      const authority = await this.channel(
        transaction,
        { kind: "agent", userId: request.ownerUserId },
        request.channelId,
      );
      const asker = request.presentation?.asker;
      const askerAllowed =
        !asker ||
        (await teamAskerCanPost(
          transaction,
          this,
          { kind: asker.actor, userId: asker.teamUserId },
          request.channelId,
        ));
      const share = request.shareId
        ? await transaction
            .selectFrom("teamShares")
            .select(["state", "partnerLinkId"])
            .where("id", "=", request.shareId)
            .executeTakeFirst()
        : null;
      const shareActive =
        !request.shareId ||
        (share?.state === "active" &&
          !!(await transaction
            .selectFrom("teamPartnerLinks")
            .select("id")
            .where("id", "=", share.partnerLinkId)
            .where("state", "=", "active")
            .executeTakeFirst()));
      const trigger =
        asker?.actor === "agent"
          ? await transaction
              .selectFrom("teamMessages")
              .select("agentLinkId")
              .where("id", "=", request.triggerMessageId)
              .executeTakeFirstOrThrow()
          : null;
      if (
        links.has(request.linkId) ||
        (trigger?.agentLinkId && links.has(trigger.agentLinkId)) ||
        !askerAllowed ||
        !shareActive ||
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
    const sharedPending = await transaction
      .selectFrom("teamShareAsks")
      .select(["triggerMessageId", "threadRootId"])
      .where("outcome", "is", null)
      .execute();
    await lockTeamMessages(
      transaction,
      [...affectedRequests, ...sharedPending].flatMap((r) => [r.threadRootId, r.triggerMessageId]),
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
    await transaction
      .selectFrom("teamShareAsks")
      .select("id")
      .where("outcome", "is", null)
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
          .where("id", "in", [request.threadRootId, request.triggerMessageId])
          .execute();
        const returned = await createTeamAskReturn(transaction, request, "cancelled", changeSeq);
        if (returned && request.presentation) {
          const asker = request.presentation.asker;
          const rights = await this.channel(
            transaction,
            { kind: "agent", userId: asker.teamUserId },
            request.channelId,
          );
          if (!rights.read || !rights.post)
            await transaction
              .updateTable("teamAgentRequests")
              .set({ state: "cancelled", finishedAt: new Date(), failureCode: "access_revoked" })
              .where("id", "=", returned.id)
              .execute();
        }
      }
    }
    for (const channelId of await cancelUnavailableSharedAsks(transaction, this))
      channels.add(channelId);
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
      await this.checkSession(transaction);
      return write(transaction, await this.channel(transaction, actor, channelId));
    });
  }
  /** Knowledge writes hold the access fence through commit; the writer authorizes inside it. */
  async knowledgeWrite<Value>(write: (transaction: Transaction<DatabaseSchema>) => Promise<Value>) {
    return this.database.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom("teamAccessState")
        .select("revision")
        .where("singletonKey", "=", "team")
        .forShare()
        .executeTakeFirstOrThrow();
      await this.checkSession(transaction);
      return write(transaction);
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
