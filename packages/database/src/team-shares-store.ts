import { randomUUID } from "node:crypto";
import {
  createId,
  OpensteerError,
  SequenceSchema,
  UserIdSchema,
  uniqueTeamHandle,
  type TeamActor,
  type TeamChannelId,
  type TeamMessageId,
  type UserId,
} from "@opensteer/core";
import {
  TeamShareBatchSchema,
  TeamShareRowSchema,
  teamShareBatchRows,
  teamShareRosterBytes,
  teamShareMaxRows,
  teamShareMaxBytes,
  type TeamShareBatch,
  type TeamShareOperation,
  type TeamSharePerson,
  type TeamShareRow,
} from "@opensteer/protocol";
import { sql, type Selectable, type Transaction } from "kysely";
import { plainTextExcerpt } from "@opensteer/shared/plainTextExcerpt";
import { teamMentions } from "@opensteer/shared/teamMentions";
import type { DatabaseSchema, TeamMessageTable, TeamShareTable } from "./schema.js";
import {
  type TeamStoreAccessEffects,
  TeamAccessStore,
  bumpTeamChannel,
  lockTeamMessages,
  emptyTeamAccessEffects,
  requireTeam,
  teamGroupPaths,
  teamReadableChannelIds,
  teamReadableChannels,
} from "./team-access-store.js";
import { TeamChatStore } from "./team-chat-store.js";
import { teamPrincipalProfiles } from "./team-principals-store.js";
import {
  authorizePartnerWrite,
  channelShare,
  shareNotFound,
  type TeamPartnerWriteContext,
} from "./team-share-access.js";
import { appendTeamAudit } from "./team-audit-store.js";

type Tx = Transaction<DatabaseSchema>;
export type Share = Selectable<TeamShareTable>;
export class TeamSharesStore {
  readonly access: TeamAccessStore;
  readonly chat: TeamChatStore;
  constructor(access: TeamAccessStore, chat: TeamChatStore) {
    this.access = access;
    this.chat = chat;
  }
  get db() {
    return this.access.database;
  }
  async policy(t: Tx, actor: TeamActor, approval = false) {
    requireTeam(actor.kind === "human");
    const member = await this.access.member(t, actor.userId);
    const { policy } = await t
      .selectFrom("teamSharingSettings")
      .select("policy")
      .executeTakeFirstOrThrow();
    requireTeam(policy !== "off", "Team sharing is off");
    requireTeam(
      member.role !== "member" ||
        policy === "members" ||
        (!approval && policy === "members-propose"),
    );
    return member.role !== "member" || policy === "members";
  }
  async scoped(
    t: Tx,
    linkId: string,
    id: string,
    generation: number,
    role?: Share["role"],
    offered = false,
  ) {
    const row = await t
      .selectFrom("teamShares as s")
      .innerJoin("teamPartnerLinks as l", "l.id", "s.partnerLinkId")
      .selectAll("s")
      .where("s.id", "=", id)
      .where("s.partnerLinkId", "=", linkId)
      .where("s.generation", "=", generation)
      .where("l.state", "=", "active")
      .where("s.state", "in", offered ? ["active", "offered"] : ["active"])
      .where((eb) =>
        eb.exists(
          eb.selectFrom("teamSharingSettings").select("singletonKey").where("policy", "!=", "off"),
        ),
      )
      .executeTakeFirst();
    if (!row || (role && row.role !== role)) shareNotFound();
    return row;
  }
  get(id: string) {
    return this.db
      .selectFrom("teamShares")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
  }
  async local(actor: TeamActor, channelId: TeamChannelId, post = true) {
    const found = await this.db
      .selectFrom("teamShares")
      .selectAll()
      .where("channelId", "=", channelId)
      .where("role", "=", "follower")
      .executeTakeFirst();
    if (!found) return undefined;
    return this.db.transaction().execute(async (t) => {
      await this.access.checkSession(t);
      const authority = await this.access.channel(t, actor, channelId);
      requireTeam(authority.read && (!post || authority.post));
      const share = await channelShare(t, channelId);
      if (share?.role !== "follower") return undefined;
      requireTeam(
        share.state === "active" && share.ready,
        "This shared channel is disconnected or still syncing",
      );
      if (share.syncError === "update-required")
        throw new OpensteerError({
          code: "conflict",
          reason: "shared-channel-update-required",
          message: "Update Opensteer to use this shared channel",
        });
      if (actor.kind === "agent") requireTeam(!share.peopleOnly);
      return share;
    });
  }
  async offer(actor: TeamActor, channelId: TeamChannelId, linkId: string, confirmed: boolean) {
    return this.access.mutate(async (t) => {
      const approved = await this.policy(t, actor);
      const authority = await this.access.channel(t, actor, channelId);
      requireTeam(
        authority.read && authority.manage && confirmed,
        "Confirm sharing the channel's full history, including agent answers",
      );
      const channel = await t
        .selectFrom("teamChannels")
        .selectAll()
        .where("id", "=", channelId)
        .executeTakeFirstOrThrow();
      requireTeam(
        (channel.kind === "public" || channel.kind === "private") &&
          !channel.archivedAt &&
          channel.normalizedName !== "general",
        "The default channel and direct messages cannot be shared",
      );
      const link = await t
        .selectFrom("teamPartnerLinks")
        .selectAll()
        .where("id", "=", linkId)
        .where("state", "=", "active")
        .executeTakeFirst();
      requireTeam(link);
      requireTeam(
        !(await t
          .selectFrom("teamShares")
          .select("id")
          .where("channelId", "=", channelId)
          .where((eb) => eb.or([eb("state", "!=", "ended"), eb("role", "=", "follower")]))
          .executeTakeFirst()),
        "This channel already has a share",
      );
      requireTeam(
        !(await t
          .selectFrom("teamMessageAttachments")
          .select("messageId")
          .where("channelId", "=", channelId)
          .executeTakeFirst()),
        "Files are not supported in shared channels yet",
      );
      requireTeam(
        !(await t
          .selectFrom("teamMessages as m")
          .innerJoin("teamPrincipals as p", "p.id", "m.authorUserId")
          .select("m.id")
          .where("m.channelId", "=", channelId)
          .where("p.homeTeamId", "not in", [this.chat.identity.teamId, link.partnerTeamId])
          .executeTakeFirst()),
        "History includes another partner team",
      );
      requireTeam(
        !(await t
          .selectFrom("teamMessagePins as n")
          .innerJoin("teamPrincipals as p", "p.id", "n.pinnedBy")
          .select("n.messageId")
          .where("n.channelId", "=", channelId)
          .where("p.homeTeamId", "not in", [this.chat.identity.teamId, link.partnerTeamId])
          .executeTakeFirst()),
        "History includes another partner team",
      );
      const previous = await t
        .selectFrom("teamShares as s")
        .innerJoin("teamPartnerLinks as l", "l.id", "s.partnerLinkId")
        .select("s.id")
        .where("s.channelId", "=", channelId)
        .where("s.role", "=", "owner")
        .where("s.state", "=", "ended")
        .where("l.partnerTeamId", "=", link.partnerTeamId)
        .orderBy("s.createdAt", "desc")
        .executeTakeFirst();
      const share = await t
        .insertInto("teamShares")
        .values({
          id: randomUUID(),
          historyFromShareId: previous?.id ?? null,
          channelId,
          partnerLinkId: linkId,
          role: "owner",
          state: "offered",
          generation: 1,
          name: channel.name!,
          peopleOnly: channel.peopleOnly,
          offeredBy: actor.userId,
          acceptedBy: null,
          localApproved: approved,
          endedAt: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit(t, actor, "offered", share);
      return { value: share, effects: { ...emptyTeamAccessEffects, channels: [channelId] } };
    });
  }
  async incomingOffer(linkId: string, op: Extract<TeamShareOperation, { op: "offer" }>) {
    return this.access.mutate(async (t) => {
      const link = await t
        .selectFrom("teamPartnerLinks")
        .selectAll()
        .where("id", "=", linkId)
        .where("state", "=", "active")
        .executeTakeFirst();
      if (!link || op.generation !== 1) shareNotFound();
      if (op.historyFromShareId) {
        const previous = await t
          .selectFrom("teamShares as s")
          .innerJoin("teamPartnerLinks as l", "l.id", "s.partnerLinkId")
          .select("s.id")
          .where("s.id", "=", op.historyFromShareId)
          .where("s.role", "=", "follower")
          .where("s.state", "=", "ended")
          .where("l.partnerTeamId", "=", link.partnerTeamId)
          .executeTakeFirst();
        if (!previous) shareNotFound();
      }
      const offered = await t
        .selectFrom("teamShares")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where("partnerLinkId", "=", linkId)
        .executeTakeFirstOrThrow();
      if (Number(offered.count) >= 128) shareNotFound();
      const policy = await t
        .selectFrom("teamSharingSettings")
        .select("policy")
        .executeTakeFirstOrThrow();
      if (policy.policy === "off") shareNotFound();
      const prior = await t
        .selectFrom("teamShares")
        .selectAll()
        .where("id", "=", op.shareId)
        .executeTakeFirst();
      if (prior) {
        if (prior.partnerLinkId !== linkId || prior.role !== "follower" || prior.state === "ended")
          shareNotFound();
      } else
        await t
          .insertInto("teamShares")
          .values({
            id: op.shareId,
            historyFromShareId: op.historyFromShareId,
            channelId: null,
            partnerLinkId: linkId,
            role: "follower",
            state: "offered",
            generation: 1,
            name: op.name,
            peopleOnly: op.peopleOnly,
            offeredBy: null,
            acceptedBy: null,
            localApproved: false,
            endedAt: null,
          })
          .execute();
      return { value: {}, effects: emptyTeamAccessEffects };
    });
  }
  async approve(actor: TeamActor, id: string) {
    return this.access.mutate(async (t) => {
      await this.policy(t, actor, true);
      const s = await t
        .selectFrom("teamShares")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      requireTeam(s.role === "owner" && s.state === "offered");
      requireTeam((await this.access.channel(t, actor, s.channelId!)).manage);
      await t.updateTable("teamShares").set({ localApproved: true }).where("id", "=", id).execute();
      return { value: { ...s, localApproved: true }, effects: emptyTeamAccessEffects };
    });
  }
  async prepareAccept(actor: TeamActor, id: string, input: Parameters<TeamChatStore["create"]>[1]) {
    return this.access.mutate(async (t) => {
      await this.policy(t, actor, true);
      const s = await t
        .selectFrom("teamShares")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      requireTeam(
        s.role === "follower" &&
          s.state === "offered" &&
          (!s.channelId || s.channelId === input.id),
      );
      await t
        .selectFrom("teamShares")
        .select("id")
        .where("id", "=", s.id)
        .forNoKeyUpdate()
        .execute();
      if (!s.channelId) {
        requireTeam(
          !(await t
            .selectFrom("teamChannels")
            .select("id")
            .where("id", "=", input.id)
            .executeTakeFirst()),
          "Choose a fresh follower channel",
        );
        await this.chat.insertChannel(t, actor, input);
      } else requireTeam((await this.access.channel(t, actor, input.id)).manage);
      if (s.historyFromShareId)
        await t
          .insertInto("teamShareRelays")
          .columns([
            "shareId",
            "authorUserId",
            "authorKind",
            "clientMessageId",
            "bodyMarkdown",
            "threadRootPublicId",
            "publicId",
            "agentLinkId",
            "personalDeploymentId",
            "callerRunId",
          ])
          .expression(
            t
              .selectFrom("teamShareRelays")
              .select([
                sql<string>`${s.id}`.as("shareId"),
                "authorUserId",
                "authorKind",
                "clientMessageId",
                "bodyMarkdown",
                "threadRootPublicId",
                "publicId",
                "agentLinkId",
                "personalDeploymentId",
                "callerRunId",
              ])
              .where("shareId", "=", s.historyFromShareId),
          )
          .onConflict((c) =>
            c.columns(["shareId", "authorUserId", "authorKind", "clientMessageId"]).doNothing(),
          )
          .execute();
      const share = await t
        .updateTable("teamShares")
        .set({ channelId: input.id, acceptedBy: actor.userId, localApproved: true })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { value: share, effects: { ...emptyTeamAccessEffects, channels: [input.id] } };
    });
  }
  async localRoster(t: Tx, share: Share): Promise<TeamSharePerson[]> {
    if (!share.channelId) return [];
    const rows = (
      await sql<{
        userId: UserId;
        name: string;
        handle: TeamSharePerson["handle"];
        level: "read" | "post";
      }>`
      select m.user_id,u.display_name as name,m.handle,
        case when exists (${teamGroupPaths(sql.ref("m.user_id"))}
          select 1 from team_channel_members a where a.channel_id=${share.channelId} and a.level='post'
          and ((a.subject_kind='person' and a.subject_id=m.user_id) or (a.subject_kind='group' and a.subject_id in(select id from member_groups)))) then 'post' else 'read' end as level
      from team_members m join users u on u.id=m.user_id
      where m.state='active' and ${share.channelId} in ${teamReadableChannelIds(sql.ref("m.user_id"), "human", true)}
      order by m.user_id limit 1001`.execute(t)
    ).rows;
    requireTeam(rows.length <= 1000, "Shared channels support up to 1000 people");
    return rows.map((r) => ({
      teamId: this.chat.identity.teamId,
      userId: r.userId,
      name: r.name,
      handle: r.handle,
      level: r.level,
      state: "active",
    }));
  }
  async roster(s: Share) {
    return this.db
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute(async (t) => {
        const current = await this.scoped(t, s.partnerLinkId, s.id, s.generation, undefined, true);
        return this.localRoster(t, current);
      });
  }
  async lockRoster(t: Tx, s: Share, people: TeamSharePerson[] = []) {
    await t
      .selectFrom("teamPrincipals")
      .select("id")
      .where((eb) =>
        eb.or([
          eb(
            "id",
            "in",
            t.selectFrom("teamShareParticipants").select("principalId").where("shareId", "=", s.id),
          ),
          ...people.map((p) =>
            eb.and([eb("homeTeamId", "=", p.teamId), eb("homeUserId", "=", p.userId)]),
          ),
        ]),
      )
      .orderBy("id")
      .forNoKeyUpdate()
      .execute();
  }
  async mergeRoster(t: Tx, share: Share, people: TeamSharePerson[], homeTeamId: string) {
    if (
      people.some((p) => p.teamId !== homeTeamId) ||
      new Set(people.map((p) => p.userId)).size !== people.length
    )
      shareNotFound();
    const prior = await t
      .selectFrom("teamShareParticipants as a")
      .innerJoin("teamPrincipals as p", "p.id", "a.principalId")
      .selectAll("a")
      .select(["p.homeTeamId", "p.homeUserId"])
      .where("a.shareId", "=", share.id)
      .execute();
    const occupied = new Set(prior.map((p) => p.handle));
    const existing = people.length
      ? await teamPrincipalProfiles(t)
          .where("p.homeTeamId", "=", homeTeamId as TeamSharePerson["teamId"])
          .where(
            "p.homeUserId",
            "in",
            people.map((p) => p.userId),
          )
          .execute()
      : [];
    const byHome = new Map<string, (typeof existing)[number]>(
      existing.map((p) => [p.homeUserId, p]),
    );
    const remote = people.filter((p) => !byHome.has(p.userId));
    if (homeTeamId !== this.chat.identity.teamId && people.length) {
      const profiles = people
        .map((p) => ({
          id: byHome.get(p.userId)?.id ?? createId("user"),
          homeTeamId: p.teamId,
          homeUserId: p.userId,
          memberUserId: null,
          displayName: p.name,
          handle: p.handle,
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
      const updated = await t
        .insertInto("teamPrincipals")
        .values(profiles)
        .onConflict((c) =>
          c.columns(["homeTeamId", "homeUserId"]).doUpdateSet({
            displayName: sql`excluded.display_name`,
            handle: sql`excluded.handle`,
            updatedAt: new Date(),
          }),
        )
        .returningAll()
        .execute();
      for (const p of updated)
        byHome.set(p.homeUserId, {
          ...p,
          displayName: p.displayName!,
          handle: p.handle!,
          image: null,
        });
    }
    if (remote.length && homeTeamId === this.chat.identity.teamId) shareNotFound();
    const incoming = new Set<string>(people.map((p) => p.userId));
    const updates = prior
      .filter((p) => p.homeTeamId === homeTeamId && !incoming.has(p.homeUserId))
      .map((p) => ({ ...p, state: "removed" as const }));
    const values = people.map((p) => {
      const principal = byHome.get(p.userId)!;
      const old = prior.find((a) => a.principalId === principal.id);
      const handle =
        share.role === "follower"
          ? p.handle
          : (old?.handle ?? uniqueTeamHandle(p.handle, occupied));
      occupied.add(handle);
      return {
        shareId: share.id,
        principalId: principal.id,
        handle,
        level: p.level,
        state: p.state,
      };
    });
    requireTeam(
      prior.length +
        values.filter((v) => !prior.some((p) => p.principalId === v.principalId)).length <=
        1000,
      "Shared channels support up to 1000 people",
    );
    const entries = [
      ...values,
      ...updates.map((p) => ({
        shareId: share.id,
        principalId: p.principalId,
        handle: p.handle,
        level: p.level,
        state: p.state,
      })),
    ].sort((a, b) => a.principalId.localeCompare(b.principalId));
    if (entries.length)
      await t
        .insertInto("teamShareParticipants")
        .values(entries)
        .onConflict((c) =>
          c.columns(["shareId", "principalId"]).doUpdateSet({
            handle: sql`excluded.handle`,
            level: sql`excluded.level`,
            state: sql`excluded.state`,
          }),
        )
        .execute();
  }
  async accept(linkId: string, op: Extract<TeamShareOperation, { op: "accept" | "roster" }>) {
    return this.access.mutate(async (t) => {
      const s = await this.scoped(
        t,
        linkId,
        op.shareId,
        op.generation,
        "owner",
        op.op === "accept",
      );
      if (!s.localApproved) shareNotFound();
      await this.lockRoster(t, s, op.people);
      await t
        .selectFrom("teamShares")
        .select("id")
        .where("id", "=", s.id)
        .forNoKeyUpdate()
        .execute();
      await t
        .selectFrom("teamShareParticipants")
        .select(["shareId", "principalId"])
        .where("shareId", "=", s.id)
        .orderBy("shareId")
        .orderBy("principalId")
        .forNoKeyUpdate()
        .execute();
      const link = await t
        .selectFrom("teamPartnerLinks")
        .selectAll()
        .where("id", "=", linkId)
        .executeTakeFirstOrThrow();
      const history = await this.historicalPeople(t, s),
        local = await this.localRoster(t, s);
      const withHistory = (people: TeamSharePerson[], home: string) => [
        ...people,
        ...history.filter((p) => p.teamId === home && !people.some((a) => a.userId === p.userId)),
      ];
      await this.mergeRoster(
        t,
        s,
        withHistory(local, this.chat.identity.teamId),
        this.chat.identity.teamId,
      );
      await this.mergeRoster(t, s, withHistory(op.people, link.partnerTeamId), link.partnerTeamId);
      this.validateRoster(await this.pullProjection(t, s));
      await t
        .updateTable("teamShares")
        .set({ state: "active", ready: true })
        .where("id", "=", s.id)
        .execute();
      return {
        value: {},
        effects: { ...emptyTeamAccessEffects, channels: s.channelId ? [s.channelId] : [] },
      };
    });
  }
  async activate(id: string) {
    await this.access.mutate(async (t) => {
      const s = await t
        .selectFrom("teamShares")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      requireTeam(s.role === "follower" && s.localApproved && s.state !== "ended");
      await t.updateTable("teamShares").set({ state: "active" }).where("id", "=", id).execute();
      return {
        value: undefined,
        effects: { ...emptyTeamAccessEffects, channels: s.channelId ? [s.channelId] : [] },
      };
    });
  }
  async exportRows(t: Tx, s: Share, rows: Selectable<TeamMessageTable>[]): Promise<TeamShareRow[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const rootIds = rows.flatMap((r) => (r.threadRootId ? [r.threadRootId] : []));
    const [principals, roots, pins] = await Promise.all([
      t
        .selectFrom("teamPrincipals")
        .selectAll()
        .where("id", "in", [...new Set(rows.map((r) => r.authorUserId))])
        .execute(),
      rootIds.length
        ? t
            .selectFrom("teamMessages")
            .select(["id", "publicId"])
            .where("channelId", "=", s.channelId!)
            .where("id", "in", rootIds)
            .execute()
        : Promise.resolve([]),
      t
        .selectFrom("teamMessagePins as n")
        .innerJoin("teamPrincipals as p", "p.id", "n.pinnedBy")
        .select(["n.messageId", "p.homeTeamId", "p.homeUserId"])
        .where("n.messageId", "in", ids)
        .execute(),
    ]);
    return rows.map((r) => {
      const p = principals.find((p) => p.id === r.authorUserId)!;
      const pin = pins.find((p) => p.messageId === r.id);
      return TeamShareRowSchema.parse({
        kind: "text",
        publicId: r.publicId,
        ordinal: r.createdSeq,
        sequence: r.changeSeq,
        author: { teamId: p.homeTeamId, userId: p.homeUserId },
        authorKind: r.authorKind,
        clientMessageId: r.clientMessageId,
        bodyMarkdown: r.deletedAt ? "" : r.bodyMarkdown,
        threadRootPublicId: r.threadRootId
          ? roots.find((p) => p.id === r.threadRootId)!.publicId
          : null,
        createdAt: r.createdAt.toISOString(),
        editedAt: r.editedAt?.toISOString() ?? null,
        deletedAt: r.deletedAt?.toISOString() ?? null,
        pinnedBy: pin ? { teamId: pin.homeTeamId, userId: pin.homeUserId } : null,
      });
    });
  }
  async historicalPeople(t: Tx, s: Share): Promise<TeamSharePerson[]> {
    const rows = await teamPrincipalProfiles(t)
      .where((eb) =>
        eb.or([
          eb(
            "p.id",
            "in",
            t
              .selectFrom("teamMessages")
              .select("authorUserId")
              .where("channelId", "=", s.channelId!),
          ),
          eb(
            "p.id",
            "in",
            t
              .selectFrom("teamMessagePins")
              .select("pinnedBy")
              .where("channelId", "=", s.channelId!),
          ),
        ]),
      )
      .execute();
    return rows.map((p) => ({
      teamId: p.homeTeamId,
      userId: UserIdSchema.parse(p.homeUserId),
      name: p.displayName,
      handle: p.handle,
      level: "read",
      state: "removed",
    }));
  }
  async pullProjection(t: Tx, s: Share): Promise<TeamSharePerson[]> {
    const participants = await t
      .selectFrom("teamShareParticipants as a")
      .innerJoin("teamPrincipals as p", "p.id", "a.principalId")
      .leftJoin("teamMembers as m", "m.userId", "p.memberUserId")
      .leftJoin("users as u", "u.id", "m.userId")
      .select([
        "p.homeTeamId as teamId",
        "p.homeUserId as userId",
        "a.handle",
        "a.level",
        sql<TeamSharePerson["state"]>`case when a.blocked then 'removed' else a.state end`.as(
          "state",
        ),
        sql<string>`coalesce(u.display_name,p.display_name)`.as("name"),
      ])
      .where("a.shareId", "=", s.id)
      .orderBy("p.id")
      .execute();
    // Historical authors remain profile cards without gaining participation or authority.
    const historical = await this.historicalPeople(t, s);
    const people: TeamSharePerson[] = participants.map((p) => ({
      ...p,
      userId: p.userId as UserId,
    }));
    for (const p of historical)
      if (!people.some((a) => a.teamId === p.teamId && a.userId === p.userId)) people.push(p);
    return people;
  }
  async pull(linkId: string, op: Extract<TeamShareOperation, { op: "pull" }>) {
    return this.db
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute(async (t) => {
        const s = await this.scoped(t, linkId, op.shareId, op.generation, "owner");
        const channel = await t
          .selectFrom("teamChannels")
          .selectAll()
          .where("id", "=", s.channelId!)
          .executeTakeFirstOrThrow();
        if (channel.archivedAt) shareNotFound();
        const created = await t
          .selectFrom("teamMessages")
          .selectAll()
          .where("channelId", "=", s.channelId!)
          .where("createdSeq", ">", op.cursor.created)
          .orderBy("createdSeq")
          .limit(teamShareBatchRows + 1)
          .execute();
        const creation = created.length > 0;
        const rows = creation
          ? created
          : await t
              .selectFrom("teamMessages")
              .selectAll()
              .where("channelId", "=", s.channelId!)
              .where((eb) =>
                eb.or([
                  eb("changeSeq", ">", op.cursor.sequence),
                  ...(op.cursor.publicId
                    ? [
                        eb.and([
                          eb("changeSeq", "=", op.cursor.sequence),
                          eb("publicId", ">", op.cursor.publicId),
                        ]),
                      ]
                    : []),
                ]),
              )
              .orderBy("changeSeq")
              .orderBy("publicId")
              .limit(teamShareBatchRows + 1)
              .execute();
        const people = await this.pullProjection(t, s);
        const projected = await this.exportRows(t, s, rows.slice(0, teamShareBatchRows));
        for (let count = projected.length; count >= 0; count--) {
          const selected = projected.slice(0, count),
            last = selected.at(-1);
          const cursor = last
            ? creation
              ? { ...op.cursor, created: SequenceSchema.parse(last.ordinal) }
              : {
                  ...op.cursor,
                  sequence: SequenceSchema.parse(last.sequence),
                  publicId: last.publicId,
                }
            : { ...op.cursor, sequence: SequenceSchema.parse(channel.changeSeq), publicId: "" };
          const batch = {
            rows: selected,
            people,
            peopleOnly: channel.peopleOnly,
            cursor,
            more: creation || rows.length > count,
          };
          if (TeamShareBatchSchema.safeParse(batch).success && (count > 0 || !rows.length))
            return batch;
        }
        throw new OpensteerError({
          code: "resource_exhausted",
          message: "Shared channel batch exceeds limits",
        });
      });
  }
  async write(linkId: string, op: Extract<TeamShareOperation, { op: "write" }>) {
    const { s, actor, target } = await this.db.transaction().execute(async (t) => {
      const s = await this.scoped(t, linkId, op.shareId, op.generation, "owner");
      const link = await t
        .selectFrom("teamPartnerLinks")
        .selectAll()
        .where("id", "=", linkId)
        .executeTakeFirstOrThrow();
      if (op.write.author.teamId !== link.partnerTeamId) shareNotFound();
      const p = await t
        .selectFrom("teamPrincipals")
        .select("id")
        .where("homeTeamId", "=", link.partnerTeamId)
        .where("homeUserId", "=", op.write.author.userId)
        .executeTakeFirst();
      if (!p) shareNotFound();
      const actor: TeamActor = {
        kind: op.write.action === "send" ? op.write.authorKind : "human",
        userId: p.id,
      };
      const context = { shareId: s.id, partnerLinkId: linkId, generation: s.generation };
      await authorizePartnerWrite(t, actor, s.channelId!, context);
      let target: Selectable<TeamMessageTable> | undefined;
      if (op.write.action !== "send") {
        target = await t
          .selectFrom("teamMessages")
          .selectAll()
          .where("channelId", "=", s.channelId!)
          .where("publicId", "=", op.write.publicId)
          .where("deletedAt", "is", null)
          .executeTakeFirst();
        if (!target) shareNotFound();
      }
      return { s, actor, target };
    });
    const context: TeamPartnerWriteContext = {
      shareId: s.id,
      partnerLinkId: linkId,
      generation: s.generation,
    };
    let id: TeamMessageId;
    if (op.write.action === "send") {
      const w = op.write;
      const result = await this.access.contentWrite(actor, s.channelId!, async (t) => {
        await authorizePartnerWrite(t, actor, s.channelId!, context);
        const existing = await t
          .selectFrom("teamMessages")
          .selectAll()
          .where("channelId", "=", s.channelId!)
          .where("authorUserId", "=", actor.userId)
          .where("authorKind", "=", actor.kind)
          .where("clientMessageId", "=", w.clientMessageId)
          .executeTakeFirst();
        if (existing) return existing.id;
        const root = w.threadRootPublicId
          ? await t
              .selectFrom("teamMessages")
              .select("id")
              .where("channelId", "=", s.channelId!)
              .where("publicId", "=", w.threadRootPublicId)
              .where("threadRootId", "is", null)
              .where("deletedAt", "is", null)
              .executeTakeFirst()
          : undefined;
        if (w.threadRootPublicId && !root) shareNotFound();
        return (
          await this.chat.insert(t, actor, {
            channelId: s.channelId!,
            threadRootId: root?.id ?? null,
            clientMessageId: w.clientMessageId,
            bodyMarkdown: w.bodyMarkdown,
            mentions: [],
            attachmentIds: [],
            partner: context,
          })
        ).message.id;
      });
      id = result;
    } else {
      id = target!.id;
      if (op.write.action === "pin")
        await this.chat.pin(actor, s.channelId!, id, op.write.pinned, context);
      else
        await this.chat.editOrDelete(
          actor,
          s.channelId!,
          id,
          op.write.action === "edit" ? { bodyMarkdown: op.write.bodyMarkdown, mentions: [] } : null,
          context,
        );
    }
    this.chat.changed(s.channelId!);
    return this.db
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute(async (t) => {
        await this.scoped(t, linkId, s.id, s.generation, "owner");
        const committed = await t
          .selectFrom("teamMessages")
          .selectAll()
          .where("channelId", "=", s.channelId!)
          .where("id", "=", id)
          .executeTakeFirstOrThrow();
        const rows = await t
          .selectFrom("teamMessages")
          .selectAll()
          .where("channelId", "=", s.channelId!)
          .where("createdSeq", ">", op.createdThrough)
          .where("createdSeq", "<=", committed.createdSeq)
          .orderBy("createdSeq")
          .limit(teamShareBatchRows + 1)
          .execute();
        if (!rows.some((r) => r.id === committed.id)) rows.push(committed);
        const parsed = TeamShareBatchSchema.safeParse({
          rows: await this.exportRows(t, s, rows),
          people: await this.pullProjection(t, s),
          peopleOnly: s.peopleOnly,
          cursor: { created: op.createdThrough, sequence: SequenceSchema.parse("0"), publicId: "" },
          more: false,
        });
        if (!parsed.success)
          throw new OpensteerError({
            code: "conflict",
            retryable: true,
            message: "Shared channel is catching up. Retry this change.",
          });
        return { publicId: committed.publicId, batch: parsed.data };
      });
  }

  async recordRelay(
    actor: TeamActor,
    s: Share,
    write: Extract<TeamShareOperation, { op: "write" }>["write"],
    provenance?: Pick<Parameters<TeamChatStore["send"]>[1], "linkId" | "runId">,
  ) {
    return this.access.contentWrite(actor, s.channelId!, async (t, a) => {
      requireTeam(a.post);
      if (actor.kind === "agent") requireTeam(!a.peopleOnly);
      const current = await this.scoped(t, s.partnerLinkId, s.id, s.generation, "follower");
      const link =
        actor.kind === "agent" && provenance?.linkId
          ? await this.access.link(t, actor, provenance.linkId)
          : null;
      requireTeam(actor.kind !== "agent" || link);
      if (write.action === "send")
        await t
          .insertInto("teamShareRelays")
          .values({
            shareId: s.id,
            authorUserId: actor.userId,
            authorKind: actor.kind,
            clientMessageId: write.clientMessageId,
            bodyMarkdown: write.bodyMarkdown,
            threadRootPublicId: write.threadRootPublicId,
            publicId: null,
            agentLinkId: link?.id ?? null,
            personalDeploymentId: link?.personalDeploymentId ?? null,
            callerRunId: provenance?.runId ?? null,
          })
          .onConflict((c) =>
            c.columns(["shareId", "authorUserId", "authorKind", "clientMessageId"]).doNothing(),
          )
          .execute();
      if (write.action === "edit")
        await t
          .updateTable("teamShareRelays")
          .set({ bodyMarkdown: write.bodyMarkdown })
          .where("shareId", "=", s.id)
          .where("authorUserId", "=", actor.userId)
          .where("publicId", "=", write.publicId)
          .execute();
      return current;
    });
  }
  async apply(
    linkId: string,
    id: string,
    generation: number,
    batch: TeamShareBatch,
    advance = true,
  ) {
    TeamShareBatchSchema.parse(batch);
    await this.access.mutate(async (t) => {
      const s = await this.scoped(t, linkId, id, generation, "follower");
      if (
        advance &&
        (BigInt(batch.cursor.created) < BigInt(s.creationCursor) ||
          BigInt(batch.cursor.sequence) < BigInt(s.cursor))
      )
        shareNotFound();
      await this.lockRoster(t, s, batch.people);
      await t
        .selectFrom("teamChannelMemberState")
        .select(["channelId", "userId"])
        .where("channelId", "=", s.channelId!)
        .orderBy("channelId")
        .orderBy("userId")
        .forNoKeyUpdate()
        .execute();
      await t
        .selectFrom("teamShares")
        .select("id")
        .where("id", "=", s.id)
        .forNoKeyUpdate()
        .execute();
      await t
        .selectFrom("teamShareParticipants")
        .select(["shareId", "principalId"])
        .where("shareId", "=", s.id)
        .orderBy("shareId")
        .orderBy("principalId")
        .forNoKeyUpdate()
        .execute();
      const link = await t
        .selectFrom("teamPartnerLinks")
        .selectAll()
        .where("id", "=", linkId)
        .executeTakeFirstOrThrow();
      if (
        batch.people.some(
          (p) => p.teamId !== link.partnerTeamId && p.teamId !== this.chat.identity.teamId,
        )
      )
        shareNotFound();
      const previous = await t
        .selectFrom("teamShareParticipants as a")
        .innerJoin("teamPrincipals as p", "p.id", "a.principalId")
        .select(["p.homeTeamId", "p.homeUserId", "a.state", "a.level"])
        .where("a.shareId", "=", s.id)
        .where("p.memberUserId", "is not", null)
        .execute();
      const localRoster = batch.people.filter((p) => p.teamId === this.chat.identity.teamId);
      const accessChanged =
        !s.ready ||
        batch.peopleOnly !== s.peopleOnly ||
        localRoster.length !== previous.length ||
        localRoster.some(
          (p) =>
            !previous.some(
              (old) =>
                old.homeUserId === p.userId && old.state === p.state && old.level === p.level,
            ),
        );
      const own = await this.localRoster(t, s),
        allowedOwn = new Map(own.map((p) => [p.userId, p]));

      const remote = batch.people.filter((p) => p.teamId === link.partnerTeamId);
      await this.mergeRoster(t, s, remote, link.partnerTeamId);
      const localPeople = batch.people.filter((p) => p.teamId === this.chat.identity.teamId);
      if (localPeople.some((p) => !allowedOwn.has(p.userId) && p.state === "active"))
        shareNotFound();
      await this.mergeRoster(t, s, localPeople, this.chat.identity.teamId);
      // The owner's handles are authoritative on the follower, including collisions with local names.
      const participants = await t
        .selectFrom("teamShareParticipants as a")
        .innerJoin("teamPrincipals as p", "p.id", "a.principalId")
        .select(["p.id", "p.homeTeamId", "p.homeUserId", "a.handle", "a.state"])
        .where("a.shareId", "=", s.id)
        .execute();
      const key = (team: string, user: string) => `${team}:${user}`;
      const principals = new Map(participants.map((p) => [key(p.homeTeamId, p.homeUserId), p]));
      const existing = batch.rows.length
        ? await t
            .selectFrom("teamMessages")
            .selectAll()
            .where("channelId", "=", s.channelId!)
            .where(
              "publicId",
              "in",
              batch.rows.map((r) => r.publicId),
            )
            .execute()
        : [];
      const roots = batch.rows.flatMap((r) => (r.threadRootPublicId ? [r.threadRootPublicId] : []));
      const rootRows = roots.length
        ? await t
            .selectFrom("teamMessages")
            .select(["id", "publicId", "threadRootId"])
            .where("channelId", "=", s.channelId!)
            .where("publicId", "in", roots)
            .execute()
        : [];
      const byPublic = new Map(existing.map((r) => [r.publicId, r]));
      const rootMap = new Map(
        rootRows.filter((r) => !r.threadRootId).map((r) => [r.publicId, r.id]),
      );
      const ledger = localPeople.length
        ? await t
            .selectFrom("teamShareRelays")
            .selectAll()
            .where(
              "authorUserId",
              "in",
              localPeople.map((p) => p.userId),
            )
            .where("shareId", "=", s.id)
            .execute()
        : [];
      const verified = batch.rows.map((row) => {
        const p = principals.get(key(row.author.teamId, row.author.userId));
        if (!p) shareNotFound();
        let proof: Selectable<DatabaseSchema["teamShareRelays"]> | undefined;
        if (row.author.teamId === this.chat.identity.teamId) {
          proof = ledger.find(
            (l) =>
              l.authorUserId === p.id &&
              l.authorKind === row.authorKind &&
              l.clientMessageId === row.clientMessageId &&
              (l.publicId === null || l.publicId === row.publicId) &&
              l.threadRootPublicId === row.threadRootPublicId &&
              (row.deletedAt || l.bodyMarkdown === row.bodyMarkdown),
          );
          if (!proof) shareNotFound();
        }
        return { row, p, old: byPublic.get(row.publicId), proof };
      });
      await t
        .selectFrom("teamShareRelays")
        .select(["shareId", "authorUserId", "authorKind", "clientMessageId"])
        .where("shareId", "=", s.id)
        .orderBy("shareId")
        .orderBy("authorUserId")
        .orderBy("authorKind")
        .orderBy("clientMessageId")
        .forNoKeyUpdate()
        .execute();
      const ownRows = verified.filter((v) => v.row.author.teamId === this.chat.identity.teamId);
      if (ownRows.length)
        await t
          .insertInto("teamShareRelays")
          .values(
            ownRows.map(({ row, p, proof }) => ({
              shareId: s.id,
              agentLinkId: proof?.agentLinkId ?? null,
              personalDeploymentId: proof?.personalDeploymentId ?? null,
              callerRunId: proof?.callerRunId ?? null,
              authorUserId: p.id,
              authorKind: row.authorKind,
              clientMessageId: row.clientMessageId,
              bodyMarkdown: ledger.find(
                (l) =>
                  l.authorUserId === p.id &&
                  l.authorKind === row.authorKind &&
                  l.clientMessageId === row.clientMessageId,
              )!.bodyMarkdown,
              threadRootPublicId: row.threadRootPublicId,
              publicId: row.publicId,
            })),
          )
          .onConflict((c) =>
            c
              .columns(["shareId", "authorUserId", "authorKind", "clientMessageId"])
              .doUpdateSet({ publicId: sql`excluded.public_id` }),
          )
          .execute();
      await lockTeamMessages(t, [...existing.map((r) => r.id), ...rootRows.map((r) => r.id)]);
      const { changeSeq } = await bumpTeamChannel(t, s.channelId!);
      const changed = verified
        .filter((v) => !v.old || BigInt(v.old.ownerChangeSeq ?? "0") < BigInt(v.row.sequence))
        .sort((a, b) => (BigInt(a.row.ordinal) < BigInt(b.row.ordinal) ? -1 : 1));
      const fresh = changed.filter((v) => !v.old);
      const storedRows = s.storedRows + fresh.length;
      const storedBytes =
        Number(s.storedBytes) +
        changed.reduce(
          (total, v) =>
            total +
            Buffer.byteLength(v.row.deletedAt ? "" : v.row.bodyMarkdown) -
            Buffer.byteLength(v.old?.bodyMarkdown ?? ""),
          0,
        );
      requireTeam(
        storedRows <= teamShareMaxRows && storedBytes <= teamShareMaxBytes,
        "Shared channel storage limit reached",
      );
      const allocated = fresh.length
        ? (
            await sql<{
              id: TeamMessageId;
            }>`select nextval(pg_get_serial_sequence('team_messages','id'))::text as id from generate_series(1,${fresh.length})`.execute(
              t,
            )
          ).rows
        : [];
      const localIds = new Map(
        changed.map((v) => [v.row.publicId, v.old?.id ?? allocated[fresh.indexOf(v)]!.id]),
      );
      for (const v of changed)
        if (!v.row.threadRootPublicId) rootMap.set(v.row.publicId, localIds.get(v.row.publicId)!);
      const saved = changed.map(({ row, p, old, proof }) => {
        const root = row.threadRootPublicId ? rootMap.get(row.threadRootPublicId) : null;
        if (row.threadRootPublicId && !root) shareNotFound();
        if (row.pinnedBy && !principals.has(key(row.pinnedBy.teamId, row.pinnedBy.userId)))
          shareNotFound();
        if (
          old &&
          (old.authorUserId !== p.id ||
            old.authorKind !== row.authorKind ||
            old.clientMessageId !== row.clientMessageId ||
            old.threadRootId !== (root ?? null))
        )
          shareNotFound();
        return {
          row,
          id: localIds.get(row.publicId)!,
          fresh: !old,
          principalId: p.id,
          proof,
          root: root ?? null,
        };
      });
      // Reserve local identities in owner creation order before the single insert, including thread roots.
      if (saved.length)
        await sql`insert into team_messages
        (id,channel_id,public_id,created_seq,owner_change_seq,thread_root_id,author_user_id,author_kind,agent_link_id,personal_deployment_id,caller_run_id,agent_request_id,client_message_id,body_markdown,plain_text,created_at,edited_at,deleted_at,change_seq)
        overriding system value values ${sql.join(saved.map(({ row, id, principalId, root, proof }) => sql`(${id},${s.channelId},${row.publicId},${row.ordinal},${row.sequence},${root},${principalId},${row.authorKind},${proof?.agentLinkId ?? null},${proof?.personalDeploymentId ?? null},${proof?.callerRunId ?? null},null,${row.clientMessageId},${row.deletedAt ? "" : row.bodyMarkdown},${row.deletedAt ? "" : (plainTextExcerpt(row.bodyMarkdown, 32768) ?? "")},${new Date(row.createdAt)},${row.editedAt ? new Date(row.editedAt) : null},${row.deletedAt ? new Date(row.deletedAt) : null},${changeSeq})`))}
        on conflict(channel_id,public_id) do update set body_markdown=excluded.body_markdown,plain_text=excluded.plain_text,
          edited_at=excluded.edited_at,deleted_at=excluded.deleted_at,owner_change_seq=excluded.owner_change_seq,change_seq=excluded.change_seq`.execute(
          t,
        );
      const rootIds = [...new Set(saved.flatMap((v) => (v.root ? [v.root] : [])))];
      if (rootIds.length)
        await t
          .updateTable("teamMessages")
          .set({ changeSeq })
          .where("channelId", "=", s.channelId!)
          .where("id", "in", rootIds)
          .execute();
      // Message locks precede all mention and pin changes; each relation is changed in key order.
      const savedIds = saved.map((r) => r.id).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
      if (savedIds.length) {
        await t
          .selectFrom("teamMentions")
          .selectAll()
          .where("messageId", "in", savedIds)
          .orderBy("messageId")
          .orderBy("targetUserId")
          .orderBy("targetKind")
          // FOR UPDATE: Applying a row replaces its mention bindings.
          .forUpdate()
          .execute();
        await t.deleteFrom("teamMentions").where("messageId", "in", savedIds).execute();
        const handles = participants
          .filter((p) => p.state === "active")
          .map((p) => ({ userId: p.id, handle: p.handle }));
        const mentions = saved.flatMap(({ row, id }) =>
          row.deletedAt
            ? []
            : teamMentions(row.bodyMarkdown, handles).map((m) => ({
                messageId: id,
                channelId: s.channelId!,
                targetUserId: m.userId,
                targetKind: m.kind,
                createdAt: new Date(),
              })),
        );
        if (mentions.length) await t.insertInto("teamMentions").values(mentions).execute();
        await t
          .selectFrom("teamMessagePins")
          .selectAll()
          .where("messageId", "in", savedIds)
          .orderBy("messageId")
          // FOR UPDATE: Applying a row replaces its pin binding.
          .forUpdate()
          .execute();
        await t.deleteFrom("teamMessagePins").where("messageId", "in", savedIds).execute();
        const pins = saved.flatMap(({ row, id }) =>
          row.pinnedBy && !row.deletedAt
            ? [
                {
                  messageId: id,
                  channelId: s.channelId!,
                  pinnedBy: principals.get(key(row.pinnedBy.teamId, row.pinnedBy.userId))!.id,
                  pinnedAt: new Date(),
                },
              ]
            : [],
        );
        if (pins.length) await t.insertInto("teamMessagePins").values(pins).execute();
        if (s.ready) {
          const outgoing = saved.filter((r) => r.fresh && !r.row.deletedAt);
          if (outgoing.length)
            await t
              .insertInto("teamOutbox")
              .values(
                outgoing.map((r) => ({
                  kind: "message" as const,
                  channelId: s.channelId!,
                  messageId: r.id,
                  noticeId: null,
                  createdAt: new Date(),
                })),
              )
              .execute();
        }
      }
      const latest = await t
        .selectFrom("teamMessages")
        .select("id")
        .where("channelId", "=", s.channelId!)
        .orderBy("id", "desc")
        .executeTakeFirst();
      // Backfill is inert: read markers start at the imported head and no outbox rows are made.
      if (!s.ready && latest) {
        if (own.length)
          await t
            .insertInto("teamChannelMemberState")
            .values(
              own
                .sort((a, b) => a.userId.localeCompare(b.userId))
                .map((p) => ({
                  channelId: s.channelId!,
                  userId: p.userId,
                  lastReadMessageId: latest.id,
                  notificationLevel: "mentions" as const,
                  updatedAt: new Date(),
                })),
            )
            .onConflict((c) =>
              c.columns(["channelId", "userId"]).doUpdateSet({ lastReadMessageId: latest.id }),
            )
            .execute();
      }
      await t
        .updateTable("teamChannels")
        .set({ latestMessageId: latest?.id ?? null })
        .where("id", "=", s.channelId!)
        .execute();
      await t
        .updateTable("teamShares")
        .set({
          peopleOnly: batch.peopleOnly,
          syncError: null,
          storedRows,
          storedBytes: String(storedBytes),
          ...(advance
            ? {
                cursor: batch.cursor.sequence,
                creationCursor: batch.cursor.created,
                cursorPublicId: batch.cursor.publicId,
                ready: s.ready || !batch.more,
              }
            : {}),
        })
        .where("id", "=", s.id)
        .execute();
      return {
        value: undefined,
        accessChanged,
        effects: { ...emptyTeamAccessEffects, channels: [s.channelId!] },
      };
    });
    const s = await this.get(id);
    this.chat.changed(s.channelId!);
  }
  async setParticipant(actor: TeamActor, id: string, principalId: UserId, blocked: boolean) {
    const s = await this.access.mutate(async (t) => {
      await this.policy(t, actor, true);
      const s = await t
        .selectFrom("teamShares")
        .selectAll()
        .where("id", "=", id)
        .where("role", "=", "owner")
        .where("state", "=", "active")
        .executeTakeFirstOrThrow();
      requireTeam((await this.access.channel(t, actor, s.channelId!)).manage);
      const p = await t
        .selectFrom("teamShareParticipants as a")
        .innerJoin("teamPrincipals as p", "p.id", "a.principalId")
        .select("a.principalId")
        .where("a.shareId", "=", id)
        .where("a.principalId", "=", principalId)
        .where("p.memberUserId", "is", null)
        .executeTakeFirst();
      requireTeam(p);
      await t
        .updateTable("teamShareParticipants")
        .set({ blocked })
        .where("shareId", "=", id)
        .where("principalId", "=", principalId)
        .execute();
      return { value: s, effects: { ...emptyTeamAccessEffects, channels: [s.channelId!] } };
    });
    this.chat.changed(s.channelId!);
  }
  validateRoster(people: TeamSharePerson[]) {
    requireTeam(
      people.length <= 1000 && Buffer.byteLength(JSON.stringify(people)) <= teamShareRosterBytes,
      "Shared channel roster exceeds its size limit",
    );
  }
  async reconcileAccess(t: Tx, effects: TeamStoreAccessEffects) {
    let query = t.selectFrom("teamShares").selectAll().where("state", "=", "active");
    if (effects.channels.length && !effects.users.length)
      query = query.where("channelId", "in", [...effects.channels]);
    const shares = await query.orderBy("id").execute();
    for (const share of shares) {
      const local = await this.localRoster(t, share);
      let changed = false;
      if (share.role === "owner") {
        const previous = await t
          .selectFrom("teamShareParticipants as a")
          .innerJoin("teamPrincipals as p", "p.id", "a.principalId")
          .select(["p.homeUserId", "a.state", "a.level"])
          .where("a.shareId", "=", share.id)
          .where("p.memberUserId", "is not", null)
          .where("a.state", "=", "active")
          .execute();
        if (
          previous.length !== local.length ||
          local.some(
            (p) => !previous.some((old) => old.homeUserId === p.userId && old.level === p.level),
          )
        ) {
          changed = true;
          await t
            .selectFrom("teamShareParticipants")
            .select(["shareId", "principalId"])
            .where("shareId", "=", share.id)
            .orderBy("shareId")
            .orderBy("principalId")
            .forNoKeyUpdate()
            .execute();
          await this.mergeRoster(t, share, local, this.chat.identity.teamId);
        }
      }
      if (share.role === "owner" && !changed) continue;
      const roster = await this.pullProjection(t, share);
      if (share.role === "follower") {
        const prior = roster.filter(
          (p) => p.teamId === this.chat.identity.teamId && p.state === "active",
        );
        changed =
          prior.length !== local.length ||
          local.some((p) => !prior.some((old) => old.userId === p.userId && old.level === p.level));
        if (!changed) continue;
      }
      const people =
        share.role === "owner"
          ? roster
          : [...roster.filter((p) => p.teamId !== this.chat.identity.teamId), ...local];
      this.validateRoster(people);
    }
  }
  async end(id: string, actor?: TeamActor, context?: { linkId: string; generation: number }) {
    return this.access.mutate(async (t) => {
      const s = await t
        .selectFrom("teamShares")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      if (!s) shareNotFound();
      if (context && (s.partnerLinkId !== context.linkId || s.generation !== context.generation))
        shareNotFound();
      if (actor) {
        const member = await this.access.member(t, actor.userId);
        const policy = await t
          .selectFrom("teamSharingSettings")
          .select("policy")
          .executeTakeFirstOrThrow();
        requireTeam(
          actor.kind === "human" && (member.role !== "member" || policy.policy === "members"),
        );
        if (s.channelId) requireTeam((await this.access.channel(t, actor, s.channelId)).manage);
      }
      if (s.state !== "ended")
        await t
          .updateTable("teamShares")
          .set({ state: "ended", generation: s.generation + 1, endedAt: new Date() })
          .where("id", "=", s.id)
          .execute();
      await this.audit(t, actor ?? null, "ended", s);
      return {
        value: s,
        effects: { ...emptyTeamAccessEffects, channels: s.channelId ? [s.channelId] : [] },
      };
    });
  }
  async participants(
    actor: TeamActor,
    input: { channelId: TeamChannelId; after?: string | undefined; query?: string | undefined },
  ) {
    return this.chat.read(actor, "read", input.channelId, async (t) => {
      const share = await channelShare(t, input.channelId);
      if (!share || (share.role === "owner" && share.state !== "active"))
        return { participants: [], people: {}, nextCursor: null };
      let query = t
        .selectFrom("teamShareParticipants as a")
        .innerJoin("teamPrincipals as p", "p.id", "a.principalId")
        .leftJoin("teamMembers as m", "m.userId", "p.memberUserId")
        .leftJoin("users as u", "u.id", "m.userId")
        .select([
          "p.id as userId",
          "p.memberUserId",
          "a.handle",
          "a.level",
          sql<TeamSharePerson["state"]>`case when a.blocked then 'removed' else a.state end`.as(
            "state",
          ),
          sql<string>`coalesce(u.display_name,p.display_name)`.as("name"),
        ])
        .where("a.shareId", "=", share.id);
      if (input.after) query = query.where("a.handle", ">", input.after);
      if (input.query)
        query = query.where((eb) =>
          eb.or([
            eb("a.handle", "ilike", `%${input.query}%`),
            sql<boolean>`coalesce(u.display_name,p.display_name) ilike ${`%${input.query}%`}`,
          ]),
        );
      const rows = await query.orderBy("a.handle").limit(51).execute(),
        selected = rows.slice(0, 50);
      const link = await t
        .selectFrom("teamPartnerLinks")
        .select("partnerName")
        .where("id", "=", share.partnerLinkId)
        .executeTakeFirstOrThrow();
      return {
        participants: selected.map((p) => ({
          userId: p.userId,
          handle: p.handle,
          level: p.level,
          state: p.state,
        })),
        people: Object.fromEntries(
          selected
            .filter((p) => !p.memberUserId)
            .map((p) => [
              p.userId,
              {
                name: p.name,
                handle: p.handle,
                homeTeamName: link.partnerName,
                external: true as const,
              },
            ]),
        ),
        nextCursor: rows.length > 50 ? selected.at(-1)!.handle : null,
      };
    });
  }
  async list(actor: TeamActor, channelId?: TeamChannelId) {
    return this.db.transaction().execute(async (t) => {
      await this.access.member(t, actor.userId);
      let q = t
        .selectFrom("teamShares as s")
        .innerJoin("teamPartnerLinks as l", "l.id", "s.partnerLinkId")
        .selectAll("s")
        .select("l.partnerName");
      if (channelId) {
        requireTeam((await this.access.channel(t, actor, channelId)).read);
        q = q.where("s.channelId", "=", channelId);
      } else {
        const member = await this.access.member(t, actor.userId);
        const settings = await t
          .selectFrom("teamSharingSettings")
          .select("policy")
          .executeTakeFirstOrThrow();
        requireTeam(
          actor.kind === "human" && (member.role !== "member" || settings.policy === "members"),
        );
        q = q.where((eb) =>
          eb.or([
            eb.and([eb("s.role", "=", "follower"), eb("s.channelId", "is", null)]),
            eb("s.channelId", "in", teamReadableChannels(actor)),
            ...(member.role !== "member"
              ? [
                  eb(
                    "s.channelId",
                    "in",
                    t
                      .selectFrom("teamChannels")
                      .select("id")
                      .where("kind", "in", ["public", "private"]),
                  ),
                ]
              : []),
          ]),
        );
      }
      const rows = await q.orderBy("s.createdAt", "desc").limit(50).execute();
      return {
        shares: rows.map((s) => ({
          id: s.id,
          historyFromShareId: s.historyFromShareId,
          channelId: s.channelId,
          partnerName: s.partnerName,
          role: s.role,
          state: s.state,
          generation: s.generation,
          name: s.name,
          ready: s.ready,
          localApproved: s.localApproved,
        })),
      };
    });
  }
  audit(t: Tx, actor: TeamActor | null, event: string, s: Share) {
    return appendTeamAudit(t, {
      actor,
      action: `share.${event}`,
      resourceKind: "channel",
      resourceId: s.channelId ?? undefined,
      channelId: s.channelId ?? undefined,
      metadata: { shareId: s.id },
    });
  }
}
