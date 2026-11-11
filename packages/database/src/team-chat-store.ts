import { createHash } from "node:crypto";
import {
  createId,
  SequenceSchema,
  type DeploymentId,
  type Sequence,
  type TeamActor,
  type TeamChannelId,
  type TeamLinkId,
  type TeamAgentRequestId,
  type TeamMessageId,
  type TeamSource,
  type UserId,
} from "@opensteer/core";
import {
  TeamAgentRequestSchema,
  TeamChannelSchema,
  TeamConsistentCutSchema,
  TeamMarkdownSchema,
  TeamMessageSchema,
  type TeamChannel,
  type TeamMessage,
  type TeamMentionSchema,
  type TeamPageDirectionSchema,
  type TeamSearchInputSchema,
  type TeamSubscriptionScopeSchema,
} from "@opensteer/protocol";
import { plainTextExcerpt } from "@opensteer/shared/plainTextExcerpt";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import type { z } from "zod";
import type { DatabaseSchema, TeamAgentRequestTable, TeamMessageTable } from "./schema.js";
import type { ChannelTopicPort } from "./team-topics-port.js";
import {
  TeamAccessStore,
  bumpTeamChannel,
  lockTeamMessages,
  emptyTeamAccessEffects,
  requireTeam,
  teamConflict,
  teamReadableChannels,
  teamReadableChannelIds,
} from "./team-access-store.js";
import { appendTeamAudit } from "./team-audit-store.js";
import { bindTeamFiles, teamFileView } from "./team-files-store.js";

type Mention = z.infer<typeof TeamMentionSchema>;
type ChannelAccess = z.infer<typeof import("@opensteer/protocol").TeamChannelAccessEntrySchema>;
type Page = z.infer<typeof TeamPageDirectionSchema>;
type MessageRow = Selectable<TeamMessageTable>;
export function teamRequestView(row: Selectable<TeamAgentRequestTable>) {
  return TeamAgentRequestSchema.strip().parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  });
}
export async function teamMessageViews(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  rows: readonly MessageRow[],
): Promise<TeamMessage[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [mentions, attachments, pins, requests, summaries] = await Promise.all([
    database.selectFrom("teamMentions").selectAll().where("messageId", "in", ids).execute(),
    database
      .selectFrom("teamMessageAttachments as a")
      .innerJoin("teamBlobs as b", "b.id", "a.blobId")
      .selectAll("b")
      .select(["a.messageId", "a.position"])
      .where("a.messageId", "in", ids)
      .orderBy("a.position")
      .execute(),
    database
      .selectFrom("teamMessagePins")
      .select("messageId")
      .where("messageId", "in", ids)
      .execute(),
    database
      .selectFrom("teamAgentRequests")
      .selectAll()
      .where("threadRootId", "in", ids)
      .orderBy("createdAt")
      .execute(),
    sql<{
      rootId: TeamMessageId;
      count: string;
      latestMessageId: TeamMessageId | null;
      repliers: UserId[];
    }>`select r.id as root_id,count(m.id)::text as count,max(m.id)::text as latest_message_id,
      array(select distinct on (recent.author_user_id) recent.author_user_id from
        (select author_user_id,max(id) as id from team_messages where thread_root_id=r.id and deleted_at is null group by author_user_id order by max(id) desc limit 4) recent order by recent.author_user_id) as repliers
      from team_messages r left join team_messages m on m.thread_root_id=r.id and m.deleted_at is null where r.id in (${sql.join(ids)}) group by r.id`.execute(
      database,
    ),
  ]);
  return rows.map((row) => {
    const summary = summaries.rows.find((r) => r.rootId === row.id);
    return TeamMessageSchema.strip().parse({
      ...row,
      bodyMarkdown: row.deletedAt ? "" : row.bodyMarkdown,
      plainText: row.deletedAt ? "" : row.plainText,
      createdAt: row.createdAt.toISOString(),
      editedAt: row.editedAt?.toISOString() ?? null,
      deletedAt: row.deletedAt?.toISOString() ?? null,
      mentions: row.deletedAt
        ? []
        : mentions
            .filter((r) => r.messageId === row.id)
            .map((r) => ({ userId: r.targetUserId, kind: r.targetKind })),
      attachments: row.deletedAt
        ? []
        : attachments.filter((r) => r.messageId === row.id).map(teamFileView),
      pinned: pins.some((r) => r.messageId === row.id),
      replySummary: {
        count: Number(summary?.count ?? 0),
        latestMessageId: summary?.latestMessageId ?? null,
        repliers: summary?.repliers ?? [],
      },
      requests: requests
        .filter((r) => r.threadRootId === row.id)
        .slice(-32)
        .map(teamRequestView),
    });
  });
}

export interface TeamRequestChange {
  readonly kind: "queued" | "cancelled";
  readonly linkId: TeamLinkId;
  readonly requestId: TeamAgentRequestId;
}
export class TeamChatStore {
  readonly #requestListeners = new Set<(event: TeamRequestChange) => Promise<void> | void>();
  readonly #listeners = new Set<(channelId: TeamChannelId) => void>();
  readonly access: TeamAccessStore;
  readonly topics: ChannelTopicPort;
  readonly identity: { readonly teamId: DeploymentId; readonly teamName: string };
  constructor(
    access: TeamAccessStore,
    topics: ChannelTopicPort,
    identity: { readonly teamId: DeploymentId; readonly teamName: string },
  ) {
    this.access = access;
    this.topics = topics;
    this.identity = identity;
  }
  onChange(listener: (channelId: TeamChannelId) => void) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  onRequestChange(listener: (event: TeamRequestChange) => Promise<void> | void) {
    this.#requestListeners.add(listener);
    return () => {
      this.#requestListeners.delete(listener);
    };
  }
  async requestChanged(event: TeamRequestChange) {
    await Promise.allSettled(
      [...this.#requestListeners].map((listener) => Promise.resolve().then(() => listener(event))),
    );
  }
  changed(channelId: TeamChannelId) {
    for (const listener of this.#listeners) listener(channelId);
  }
  async source(
    transaction: Transaction<DatabaseSchema>,
    actor: TeamActor,
    channelId: TeamChannelId,
    rootId: TeamMessageId,
    messageId: TeamMessageId | null = null,
  ): Promise<TeamSource> {
    requireTeam((await this.access.channel(transaction, actor, channelId)).read);
    const channel = await transaction
      .selectFrom("teamChannels")
      .selectAll()
      .where("id", "=", channelId)
      .executeTakeFirstOrThrow();
    const count =
      (
        await sql<{
          count: string;
        }>`select count(*)::text as count from team_members m where m.state='active' and ${channelId} in ${teamReadableChannelIds(sql.ref("m.userId"), "human")}`.execute(
          transaction,
        )
      ).rows[0]?.count ?? "0";
    return {
      teamId: this.identity.teamId,
      channelId,
      threadRootId: rootId,
      messageId,
      audience: {
        teamName: this.identity.teamName,
        channelName: channel.name ?? "Direct message",
        channelKind: channel.kind,
        peopleOnly: channel.peopleOnly,
        memberCount: Number(count),
      },
    };
  }
  async channelView(
    transaction: Transaction<DatabaseSchema>,
    actor: TeamActor,
    id: TeamChannelId,
    metadataOnly = false,
  ): Promise<TeamChannel> {
    const authority = await this.access.channel(transaction, actor, id);
    requireTeam(authority.read || (metadataOnly && authority.manage));
    const row = await transaction
      .selectFrom("teamChannels")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    const activeLink = await transaction
      .selectFrom("teamLinks")
      .select("id")
      .where("ownerUserId", "=", actor.userId)
      .where("state", "=", "active")
      .executeTakeFirst();
    return TeamChannelSchema.strip().parse({
      ...row,
      name: row.name ?? "Direct message",
      archivedAt: row.archivedAt?.toISOString() ?? null,
      instructionsMarkdown: authority.read ? row.instructionsMarkdown : "",
      can: {
        read: authority.read,
        post: authority.post,
        manage: authority.manage,
        join: false,
        leave: authority.read && (row.kind === "public" || row.kind === "private"),
        wakeOwnAgent: authority.post && !authority.peopleOnly && !!activeLink,
      },
    });
  }
  async #validateAccess(
    transaction: Transaction<DatabaseSchema>,
    entries: readonly ChannelAccess[],
  ) {
    const keys = new Set<string>();
    for (const entry of entries) {
      const id = entry.subject.kind === "person" ? entry.subject.userId : entry.subject.groupId;
      const key = `${entry.subject.kind}:${id}`;
      requireTeam(!keys.has(key), "Duplicate access entry");
      keys.add(key);
      if (entry.subject.kind === "person")
        await this.access.member(transaction, entry.subject.userId);
      else
        requireTeam(
          await transaction
            .selectFrom("teamGroups")
            .select("id")
            .where("id", "=", entry.subject.groupId)
            .where("deletedAt", "is", null)
            .executeTakeFirst(),
        );
    }
  }
  async #setEntries(
    transaction: Transaction<DatabaseSchema>,
    actor: TeamActor,
    channelId: TeamChannelId,
    entries: readonly ChannelAccess[],
  ) {
    await this.#validateAccess(transaction, entries);
    await transaction
      .selectFrom("teamChannelMembers")
      .select(["channelId", "subjectKind", "subjectId"])
      .where("channelId", "=", channelId)
      .orderBy("channelId")
      .orderBy("subjectKind")
      .orderBy("subjectId")
      // FOR UPDATE: Replacing the ACL deletes these entries.
      .forUpdate()
      .execute();
    await transaction.deleteFrom("teamChannelMembers").where("channelId", "=", channelId).execute();
    if (entries.length)
      await transaction
        .insertInto("teamChannelMembers")
        .values(
          entries.map((e) => ({
            channelId,
            subjectKind: e.subject.kind,
            subjectId: e.subject.kind === "person" ? e.subject.userId : e.subject.groupId,
            level: e.level,
            manage: e.manage,
            addedBy: actor.userId,
            addedAt: new Date(),
          })),
        )
        .execute();
  }
  async create(
    actor: TeamActor,
    input: {
      id: TeamChannelId;
      kind: "public" | "private";
      name: string;
      peopleOnly: boolean;
      access: readonly ChannelAccess[];
    },
  ) {
    const channel = await this.access.mutateAs(actor, "channel.create", async (transaction) => {
      requireTeam(actor.kind === "human");
      await this.access.member(transaction, actor.userId);
      const existing = await transaction
        .selectFrom("teamChannels")
        .select("createdBy")
        .where("id", "=", input.id)
        .executeTakeFirst();
      if (existing) {
        requireTeam(existing.createdBy === actor.userId);
        return {
          value: await this.channelView(transaction, actor, input.id),
          effects: emptyTeamAccessEffects,
        };
      }
      await transaction
        .insertInto("teamChannels")
        .values({
          id: input.id,
          kind: input.kind,
          name: input.name,
          normalizedName: input.name.normalize("NFKC").toLowerCase(),
          peopleOnly: input.peopleOnly,
          createdBy: actor.userId,
          createdAt: new Date(),
          updatedAt: new Date(),
          archivedAt: null,
          instructionsMarkdown: "",
          latestMessageId: null,
          dmKey: null,
        })
        .execute();
      const access = input.access.filter(
        (e) => e.subject.kind !== "person" || e.subject.userId !== actor.userId,
      );
      await this.#setEntries(transaction, actor, input.id, [
        ...access,
        { subject: { kind: "person", userId: actor.userId }, level: "post", manage: true },
      ]);
      await this.topics.createChannelTopic(transaction, {
        channelId: input.id,
        name: input.name,
        createdBy: actor.userId,
        peopleOnly: false,
      });
      await appendTeamAudit(transaction, {
        actor,
        action: "channel.create",
        resourceKind: "channel",
        resourceId: input.id,
      });
      return {
        value: await this.channelView(transaction, actor, input.id),
        effects: { ...emptyTeamAccessEffects, channels: [input.id] },
      };
    });
    this.changed(input.id);
    return channel;
  }
  async openDm(actor: TeamActor, participants: readonly UserId[]) {
    requireTeam(actor.kind === "human");
    const ids = [...new Set([actor.userId, ...participants])].sort();
    requireTeam(ids.length >= 2 && ids.length <= 32);
    const dmKey = createHash("sha256").update(JSON.stringify(ids)).digest("hex");
    const channel = await this.access.mutate(async (transaction) => {
      for (const userId of ids) await this.access.member(transaction, userId);
      let row = await transaction
        .selectFrom("teamChannels")
        .selectAll()
        .where("dmKey", "=", dmKey)
        .executeTakeFirst();
      if (!row) {
        const id = createId("teamChannel");
        row = await transaction
          .insertInto("teamChannels")
          .values({
            id,
            kind: ids.length === 2 ? "dm" : "group_dm",
            name: null,
            normalizedName: null,
            peopleOnly: false,
            createdBy: actor.userId,
            createdAt: new Date(),
            updatedAt: new Date(),
            archivedAt: null,
            instructionsMarkdown: "",
            latestMessageId: null,
            dmKey,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await this.#setEntries(
          transaction,
          actor,
          id,
          ids.map((userId) => ({
            subject: { kind: "person", userId },
            level: "post",
            manage: true,
          })),
        );
        await this.topics.createChannelTopic(transaction, {
          channelId: id,
          name: "Direct message",
          createdBy: actor.userId,
          peopleOnly: false,
        });
      }
      return {
        value: await this.channelView(transaction, actor, row.id),
        effects: { ...emptyTeamAccessEffects, channels: [row.id] },
      };
    });
    this.changed(channel.id);
    return channel;
  }
  async addDmPeople(
    actor: TeamActor,
    channelId: TeamChannelId,
    userIds: readonly UserId[],
    confirmed: boolean,
  ) {
    await this.access.mutateAs(actor, "dm.people.add", async (transaction) => {
      requireTeam(
        actor.kind === "human" && confirmed,
        "Confirm that new participants can read the full history",
      );
      const row = await transaction
        .selectFrom("teamChannels")
        .selectAll()
        .where("id", "=", channelId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      requireTeam(
        row.kind === "group_dm" && (await this.access.channel(transaction, actor, channelId)).post,
        "Only group DM participants can add people",
      );
      const entries = await transaction
        .selectFrom("teamChannelMembers")
        .selectAll()
        .where("channelId", "=", channelId)
        .execute();
      const ids = [...new Set([...entries.map((e) => e.subjectId), ...userIds])].sort();
      requireTeam(ids.length <= 32);
      for (const userId of userIds) await this.access.member(transaction, userId);
      const missing = userIds.filter((id) => !entries.some((e) => e.subjectId === id));
      if (missing.length) {
        await transaction
          .insertInto("teamChannelMembers")
          .values(
            missing.map((userId) => ({
              channelId,
              subjectKind: "person" as const,
              subjectId: userId,
              level: "post" as const,
              manage: true,
              addedBy: actor.userId,
              addedAt: new Date(),
            })),
          )
          .execute();
        await transaction
          .updateTable("teamChannels")
          .set({ dmKey: createHash("sha256").update(JSON.stringify(ids)).digest("hex") })
          .where("id", "=", channelId)
          .execute();
        await bumpTeamChannel(transaction, channelId);
        await appendTeamAudit(transaction, {
          actor,
          action: "dm.people.add",
          resourceKind: "channel",
          resourceId: channelId,
          metadata: { userIds: missing },
        });
      }
      return { value: undefined, effects: { ...emptyTeamAccessEffects, channels: [channelId] } };
    });
    this.changed(channelId);
  }
  async accessList(actor: TeamActor, channelId: TeamChannelId) {
    return this.access.database.transaction().execute(async (transaction) => {
      const channel = await this.channelView(transaction, actor, channelId, true);
      const entries = await transaction
        .selectFrom("teamChannelMembers")
        .selectAll()
        .where("channelId", "=", channelId)
        .orderBy("subjectKind")
        .orderBy("subjectId")
        .execute();
      return {
        revision: (
          await transaction
            .selectFrom("teamAccessState")
            .select("revision")
            .executeTakeFirstOrThrow()
        ).revision,
        entries: entries.map((e) => ({
          subject:
            e.subjectKind === "person"
              ? { kind: "person", userId: e.subjectId }
              : { kind: "group", groupId: e.subjectId },
          level: e.level,
          manage: e.manage,
        })),
        can: channel.can,
      };
    });
  }
  async setAccess(
    actor: TeamActor,
    channelId: TeamChannelId,
    expectedRevision: Sequence,
    entries: readonly ChannelAccess[],
  ) {
    await this.access.mutateAs(actor, "channel.access.set", async (transaction) => {
      const channel = await transaction
        .selectFrom("teamChannels")
        .selectAll()
        .where("id", "=", channelId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      requireTeam(
        actor.kind === "human" && (await this.access.channel(transaction, actor, channelId)).manage,
      );
      requireTeam(
        channel.kind === "public" || channel.kind === "private",
        "DM membership cannot be replaced",
      );
      const current = await transaction
        .selectFrom("teamChannelMembers")
        .select(["subjectKind", "subjectId", "level", "manage"])
        .where("channelId", "=", channelId)
        .execute();
      const canonical = (list: readonly ChannelAccess[]) =>
        JSON.stringify(
          list
            .map((e) => [
              e.subject.kind,
              e.subject.kind === "person" ? e.subject.userId : e.subject.groupId,
              e.level,
              e.manage,
            ])
            .sort(),
        );
      const existing = current.map((e) => ({
        subject:
          e.subjectKind === "person"
            ? { kind: "person" as const, userId: e.subjectId as UserId }
            : {
                kind: "group" as const,
                groupId: e.subjectId as import("@opensteer/core").TeamGroupId,
              },
        level: e.level,
        manage: e.manage,
      }));
      if (canonical(existing) !== canonical(entries)) {
        const state = await transaction
          .selectFrom("teamAccessState")
          .select("revision")
          .executeTakeFirstOrThrow();
        if (state.revision !== expectedRevision) teamConflict("The access list changed; reload it");
        await this.#setEntries(transaction, actor, channelId, entries);
        await bumpTeamChannel(transaction, channelId);
        await appendTeamAudit(transaction, {
          actor,
          action: "channel.access.set",
          resourceKind: "channel",
          resourceId: channelId,
        });
      }
      return { value: undefined, effects: { ...emptyTeamAccessEffects, channels: [channelId] } };
    });
    this.changed(channelId);
  }
  async joinOrLeave(actor: TeamActor, channelId: TeamChannelId, join: boolean) {
    await this.access.mutateAs(
      actor,
      join ? "channel.join" : "channel.leave",
      async (transaction) => {
        requireTeam(actor.kind === "human");
        await this.access.member(transaction, actor.userId);
        const channel = await transaction
          .selectFrom("teamChannels")
          .selectAll()
          .where("id", "=", channelId)
          .forNoKeyUpdate()
          .executeTakeFirstOrThrow();
        requireTeam(
          join
            ? channel.kind === "public"
            : channel.kind === "public" || channel.kind === "private",
        );
        const result = join
          ? await transaction
              .insertInto("teamChannelMembers")
              .values({
                channelId,
                subjectKind: "person",
                subjectId: actor.userId,
                level: "post",
                manage: false,
                addedBy: actor.userId,
                addedAt: new Date(),
              })
              .onConflict((c) => c.columns(["channelId", "subjectKind", "subjectId"]).doNothing())
              .returning("subjectId")
              .execute()
          : await transaction
              .deleteFrom("teamChannelMembers")
              .where("channelId", "=", channelId)
              .where("subjectKind", "=", "person")
              .where("subjectId", "=", actor.userId)
              .returning("subjectId")
              .execute();
        if (result.length) {
          await bumpTeamChannel(transaction, channelId);
          await appendTeamAudit(transaction, {
            actor,
            action: join ? "channel.join" : "channel.leave",
            resourceKind: "channel",
            resourceId: channelId,
          });
        }
        return { value: undefined, effects: { ...emptyTeamAccessEffects, channels: [channelId] } };
      },
    );
    this.changed(channelId);
  }
  async update(
    actor: TeamActor,
    channelId: TeamChannelId,
    input: {
      name?: string;
      peopleOnly?: boolean;
      archived?: boolean;
      instructionsMarkdown?: string;
      expectedRevision?: Sequence;
    },
  ) {
    await this.access.mutateAs(actor, "channel.update", async (transaction) => {
      requireTeam(
        actor.kind === "human" && (await this.access.channel(transaction, actor, channelId)).manage,
      );
      const row = await transaction
        .selectFrom("teamChannels")
        .selectAll()
        .where("id", "=", channelId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      if (
        input.expectedRevision !== undefined &&
        row.instructionsRevision !== input.expectedRevision &&
        input.instructionsMarkdown !== row.instructionsMarkdown
      )
        teamConflict("Channel instructions changed");
      if (input.name !== undefined) requireTeam(row.kind === "public" || row.kind === "private");
      const changed =
        (input.name !== undefined && input.name !== row.name) ||
        (input.peopleOnly !== undefined && input.peopleOnly !== row.peopleOnly) ||
        (input.archived !== undefined && input.archived !== (row.archivedAt !== null)) ||
        (input.instructionsMarkdown !== undefined &&
          input.instructionsMarkdown !== row.instructionsMarkdown);
      if (!changed) return { value: undefined, effects: emptyTeamAccessEffects };
      const change = {
        ...(input.name !== undefined
          ? { name: input.name, normalizedName: input.name.normalize("NFKC").toLowerCase() }
          : {}),
        ...(input.peopleOnly !== undefined ? { peopleOnly: input.peopleOnly } : {}),
        ...(input.archived !== undefined
          ? { archivedAt: input.archived ? (row.archivedAt ?? new Date()) : null }
          : {}),
        ...(input.instructionsMarkdown !== undefined
          ? {
              instructionsMarkdown: TeamMarkdownSchema.parse(input.instructionsMarkdown),
              instructionsRevision: sql<string>`instructions_revision+1`,
            }
          : {}),
      };
      await transaction
        .updateTable("teamChannels")
        .set(change)
        .where("id", "=", channelId)
        .execute();
      await bumpTeamChannel(transaction, channelId);
      await appendTeamAudit(transaction, {
        actor,
        action: "channel.update",
        resourceKind: "channel",
        resourceId: channelId,
      });
      return { value: undefined, effects: { ...emptyTeamAccessEffects, channels: [channelId] } };
    });
    this.changed(channelId);
  }
  async #mentions(
    transaction: Transaction<DatabaseSchema>,
    _actor: TeamActor,
    channelId: TeamChannelId,
    mentions: readonly Mention[],
  ) {
    requireTeam(
      mentions.length <= 20 &&
        new Set(mentions.map((m) => `${m.kind}:${m.userId}`)).size === mentions.length,
      "Invalid mentions",
    );
    for (const mention of mentions)
      requireTeam(
        (
          await this.access.channel(
            transaction,
            { kind: "human", userId: mention.userId },
            channelId,
          )
        ).read,
        "Mention target must belong to this channel",
      );
    return mentions;
  }
  async send(
    actor: TeamActor,
    input: {
      channelId: TeamChannelId;
      threadRootId: TeamMessageId | null;
      clientMessageId: string;
      bodyMarkdown: string;
      mentions: readonly Mention[];
      attachmentIds: readonly import("@opensteer/core").TeamBlobId[];
      agentRequestId?: import("@opensteer/core").TeamAgentRequestId;
    },
  ) {
    const result = await this.access.contentWrite(
      actor,
      input.channelId,
      async (transaction, authority) => {
        requireTeam(authority.post);
        TeamMarkdownSchema.parse(input.bodyMarkdown);
        requireTeam(input.attachmentIds.length <= 10);
        const existing = await transaction
          .selectFrom("teamMessages")
          .selectAll()
          .where("channelId", "=", input.channelId)
          .where("authorUserId", "=", actor.userId)
          .where("authorKind", "=", actor.kind)
          .where("clientMessageId", "=", input.clientMessageId)
          .executeTakeFirst();
        if (existing)
          return {
            message: (await teamMessageViews(transaction, [existing]))[0]!,
            wake: "not-requested" as const,
          };
        return this.insert(transaction, actor, input);
      },
    );
    this.changed(input.channelId);
    if (result.wake === "queued") {
      const request = await this.access.database
        .selectFrom("teamAgentRequests")
        .select(["id", "linkId"])
        .where("triggerMessageId", "=", result.message.id)
        .where("ownerUserId", "=", actor.userId)
        .executeTakeFirstOrThrow();
      await this.requestChanged({ kind: "queued", linkId: request.linkId, requestId: request.id });
    }
    return result;
  }
  async insert(
    transaction: Transaction<DatabaseSchema>,
    actor: TeamActor,
    input: {
      channelId: TeamChannelId;
      threadRootId: TeamMessageId | null;
      clientMessageId: string;
      bodyMarkdown: string;
      mentions: readonly Mention[];
      attachmentIds: readonly import("@opensteer/core").TeamBlobId[];
      agentRequestId?: import("@opensteer/core").TeamAgentRequestId;
    },
  ) {
    TeamMarkdownSchema.parse(input.bodyMarkdown);
    requireTeam(
      input.bodyMarkdown.trim() || input.attachmentIds.length,
      "A message needs text or files",
    );
    requireTeam(
      actor.kind === "human" || input.agentRequestId,
      "An agent reply requires a request",
    );
    if (actor.kind === "agent") {
      const request = await transaction
        .selectFrom("teamAgentRequests as r")
        .innerJoin("teamLinks as l", "l.id", "r.linkId")
        .select("r.id")
        .where("r.id", "=", input.agentRequestId!)
        .where("r.ownerUserId", "=", actor.userId)
        .where("r.channelId", "=", input.channelId)
        .where("r.threadRootId", "=", input.threadRootId!)
        .where("r.state", "in", ["working", "needs_you"])
        .where("r.expiresAt", ">", new Date())
        .where("l.state", "=", "active")
        .executeTakeFirst();
      requireTeam(request, "Active request scope required");
    }
    const mentions = await this.#mentions(transaction, actor, input.channelId, input.mentions);
    if (input.threadRootId) {
      const root = await transaction
        .selectFrom("teamMessages")
        .select(["id", "threadRootId"])
        .where("channelId", "=", input.channelId)
        .where("id", "=", input.threadRootId)
        .executeTakeFirst();
      requireTeam(
        root && root.threadRootId === null,
        "Replies require a top-level message in the same channel",
      );
    }
    // This owner row serializes the one rate budget across different channel writers.
    await transaction
      .selectFrom("teamMembers")
      .select("userId")
      .where("userId", "=", actor.userId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    const { changeSeq } = await bumpTeamChannel(transaction, input.channelId);
    const row = await transaction
      .insertInto("teamMessages")
      .values({
        channelId: input.channelId,
        threadRootId: input.threadRootId,
        authorUserId: actor.userId,
        authorKind: actor.kind,
        agentRequestId: input.agentRequestId ?? null,
        clientMessageId: input.clientMessageId,
        bodyMarkdown: input.bodyMarkdown,
        plainText: plainTextExcerpt(input.bodyMarkdown, 32768) ?? "",
        createdAt: new Date(),
        editedAt: null,
        deletedAt: null,
        changeSeq,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    if (mentions.length)
      await transaction
        .insertInto("teamMentions")
        .values(
          mentions.map((m) => ({
            messageId: row.id,
            channelId: row.channelId,
            targetUserId: m.userId,
            targetKind: m.kind,
            createdAt: new Date(),
          })),
        )
        .execute();
    await bindTeamFiles(transaction, actor, row, input.attachmentIds);
    await transaction
      .updateTable("teamChannels")
      .set({ latestMessageId: row.id })
      .where("id", "=", input.channelId)
      .execute();
    if (input.threadRootId)
      await transaction
        .updateTable("teamMessages")
        .set({ changeSeq })
        .where("id", "=", input.threadRootId)
        .execute();
    let wake: "queued" | "no-link" | "not-requested" | "rate-limited" | "people-only" =
      "not-requested";
    if (
      actor.kind === "human" &&
      mentions.some((m) => m.kind === "agent" && m.userId === actor.userId)
    ) {
      const authority = await this.access.channel(
        transaction,
        { kind: "agent", userId: actor.userId },
        row.channelId,
      );
      const link = await transaction
        .selectFrom("teamLinks")
        .select("id")
        .where("ownerUserId", "=", actor.userId)
        .where("state", "=", "active")
        .executeTakeFirst();
      if (!authority.post) wake = "people-only";
      else if (!link) wake = "no-link";
      else {
        const counts = (
          await sql<{
            minute: string;
            queued: string;
          }>`select count(*) filter(where created_at>now()-interval '1 minute')::text as minute,count(*) filter(where state='queued')::text as queued from team_agent_requests where owner_user_id=${actor.userId}`.execute(
            transaction,
          )
        ).rows[0]!;
        if (Number(counts.minute) >= 10 || Number(counts.queued) >= 32) wake = "rate-limited";
        else {
          wake = "queued";
          await transaction
            .insertInto("teamAgentRequests")
            .values({
              id: createId("teamAgentRequest"),
              ownerUserId: actor.userId,
              channelId: row.channelId,
              threadRootId: input.threadRootId ?? row.id,
              triggerMessageId: row.id,
              linkId: link.id,
              state: "queued",
              steps: sql`'[]'::jsonb`,
              createdAt: new Date(),
              acceptedAt: null,
              expiresAt: null,
              finishedAt: null,
              replyMessageId: null,
              failureCode: null,
              changeSeq,
            })
            .execute();
        }
      }
    }
    await transaction
      .insertInto("teamOutbox")
      .values({
        kind: "message",
        channelId: row.channelId,
        messageId: row.id,
        noticeId: null,
        createdAt: new Date(),
      })
      .execute();
    if (actor.kind === "agent")
      await appendTeamAudit(transaction, {
        actor,
        action: "agent.post",
        resourceKind: "message",
        resourceId: row.id,
        channelId: row.channelId,
        requestId: input.agentRequestId,
      });
    return { message: (await teamMessageViews(transaction, [row]))[0]!, wake };
  }
  async editOrDelete(
    actor: TeamActor,
    channelId: TeamChannelId,
    messageId: TeamMessageId,
    input: { bodyMarkdown: string; mentions: readonly Mention[] } | null,
  ) {
    const deletedRequests: import("@opensteer/core").TeamAgentRequestId[] = [];
    await this.access.contentWrite(actor, channelId, async (transaction, authority) => {
      requireTeam(authority.read && actor.kind === "human");
      const row = await transaction
        .selectFrom("teamMessages")
        .selectAll()
        .where("channelId", "=", channelId)
        .where("id", "=", messageId)
        .executeTakeFirstOrThrow();
      requireTeam(
        (row.authorUserId === actor.userId && row.authorKind === "human") ||
          (input === null && authority.manage),
      );
      if (row.deletedAt) return;
      await lockTeamMessages(transaction, [
        messageId,
        ...(row.threadRootId ? [row.threadRootId] : []),
      ]);
      if (!input) {
        const bindings = await transaction
          .selectFrom("teamMessageAttachments")
          .select("blobId")
          .where("messageId", "=", messageId)
          .execute();
        if (bindings.length)
          await transaction
            .selectFrom("teamBlobs")
            .select("id")
            .where(
              "id",
              "in",
              bindings.map((r) => r.blobId),
            )
            .orderBy("id")
            .forNoKeyUpdate()
            .execute();
        await transaction
          .selectFrom("teamMessageAttachments")
          .select(["messageId", "position"])
          .where("messageId", "=", messageId)
          .orderBy("messageId")
          .orderBy("position")
          // FOR UPDATE: A deleted message loses its attachment bindings.
          .forUpdate()
          .execute();
      }
      await transaction
        .selectFrom("teamMentions")
        .selectAll()
        .where("messageId", "=", messageId)
        .orderBy("messageId")
        .orderBy("targetKind")
        .orderBy("targetUserId")
        // FOR UPDATE: An edit or deletion replaces these mentions.
        .forUpdate()
        .execute();
      const { changeSeq } = await bumpTeamChannel(transaction, channelId);
      if (input) {
        TeamMarkdownSchema.parse(input.bodyMarkdown);
        requireTeam(
          authority.post && row.authorUserId === actor.userId && row.authorKind === "human",
        );
        await this.#mentions(transaction, actor, channelId, input.mentions);
      }
      await transaction
        .updateTable("teamMessages")
        .set(
          input
            ? {
                bodyMarkdown: input.bodyMarkdown,
                plainText: plainTextExcerpt(input.bodyMarkdown, 32768) ?? "",
                editedAt: new Date(),
                changeSeq,
              }
            : { bodyMarkdown: "", plainText: "", deletedAt: new Date(), changeSeq },
        )
        .where("id", "=", messageId)
        .execute();
      await transaction.deleteFrom("teamMentions").where("messageId", "=", messageId).execute();
      if (input?.mentions.length)
        await transaction
          .insertInto("teamMentions")
          .values(
            input.mentions.map((m) => ({
              messageId,
              channelId,
              targetUserId: m.userId,
              targetKind: m.kind,
              createdAt: new Date(),
            })),
          )
          .execute();
      if (row.threadRootId)
        await transaction
          .updateTable("teamMessages")
          .set({ changeSeq })
          .where("id", "=", row.threadRootId)
          .execute();
      if (!input) {
        await transaction
          .selectFrom("teamAgentRequests")
          .select("id")
          .where("triggerMessageId", "=", messageId)
          .where("state", "=", "queued")
          .orderBy("id")
          .forNoKeyUpdate()
          .execute();
        const queued = await transaction
          .updateTable("teamAgentRequests")
          .set({
            state: "cancelled",
            failureCode: "trigger_deleted",
            finishedAt: new Date(),
            changeSeq,
          })
          .where("triggerMessageId", "=", messageId)
          .where("state", "=", "queued")
          .returning(["id", "threadRootId"])
          .execute();
        deletedRequests.push(...queued.map((r) => r.id));
        for (const { threadRootId } of queued)
          await transaction
            .updateTable("teamMessages")
            .set({ changeSeq })
            .where("id", "=", threadRootId)
            .execute();
        await transaction
          .updateTable("teamBlobs")
          .set({ state: "deleting" })
          .where(
            "id",
            "in",
            transaction
              .selectFrom("teamMessageAttachments")
              .select("blobId")
              .where("messageId", "=", messageId),
          )
          .execute();
        await transaction
          .deleteFrom("teamMessageAttachments")
          .where("messageId", "=", messageId)
          .execute();
        await appendTeamAudit(transaction, {
          actor,
          action: "message.delete",
          resourceKind: "message",
          resourceId: messageId,
          channelId,
        });
      }
    });
    this.changed(channelId);
    if (deletedRequests.length)
      for (const request of await this.access.database
        .selectFrom("teamAgentRequests")
        .select(["id", "linkId"])
        .where("id", "in", deletedRequests)
        .execute())
        await this.requestChanged({
          kind: "cancelled",
          linkId: request.linkId,
          requestId: request.id,
        });
    return deletedRequests;
  }
  async pin(actor: TeamActor, channelId: TeamChannelId, messageId: TeamMessageId, pin: boolean) {
    await this.access.contentWrite(actor, channelId, async (transaction, authority) => {
      requireTeam(actor.kind === "human" && authority.read);
      requireTeam(
        await transaction
          .selectFrom("teamMessages")
          .select("id")
          .where("channelId", "=", channelId)
          .where("id", "=", messageId)
          .where("deletedAt", "is", null)
          .executeTakeFirst(),
      );
      const result = pin
        ? await transaction
            .insertInto("teamMessagePins")
            .values({ messageId, channelId, pinnedBy: actor.userId, pinnedAt: new Date() })
            .onConflict((c) => c.column("messageId").doNothing())
            .returning("messageId")
            .execute()
        : await transaction
            .deleteFrom("teamMessagePins")
            .where("messageId", "=", messageId)
            .returning("messageId")
            .execute();
      if (result.length) {
        const { changeSeq } = await bumpTeamChannel(transaction, channelId);
        await transaction
          .updateTable("teamMessages")
          .set({ changeSeq })
          .where("id", "=", messageId)
          .execute();
      }
    });
    this.changed(channelId);
  }
  async pageIn(
    transaction: Transaction<DatabaseSchema>,
    actor: TeamActor,
    channelId: TeamChannelId,
    page: Page,
    rootId?: TeamMessageId,
  ) {
    const channel = await this.channelView(transaction, actor, channelId);
    let query = transaction
      .selectFrom("teamMessages")
      .selectAll()
      .where("channelId", "=", channelId);
    query = rootId
      ? query.where((e) => e.or([e("id", "=", rootId), e("threadRootId", "=", rootId)]))
      : query.where("threadRootId", "is", null);
    if (page.direction !== "newest")
      query = query.where("id", page.direction === "before" ? "<" : ">", page.messageId);
    const rows = await query
      .orderBy("id", page.direction === "after" ? "asc" : "desc")
      .limit(51)
      .execute();
    const selected = rows.slice(0, 50).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    return {
      messages: await teamMessageViews(transaction, selected),
      hasMore: rows.length > 50,
      throughSeq: channel.changeSeq,
      channel,
    };
  }
  async read<Value>(
    actor: TeamActor,
    action: string,
    channelId: TeamChannelId | undefined,
    read: (transaction: Transaction<DatabaseSchema>) => Promise<Value>,
  ): Promise<Value> {
    const revision = this.access.revision;
    try {
      const value = await this.access.database
        .transaction()
        .setIsolationLevel("repeatable read")
        .execute(async (transaction) => {
          await this.access.member(transaction, actor.userId);
          await this.access.checkSession(transaction);
          if (channelId)
            requireTeam((await this.access.channel(transaction, actor, channelId)).read);
          const result = await read(transaction);
          if (actor.kind === "agent")
            await appendTeamAudit(transaction, {
              actor,
              action: `agent.${action}`,
              resourceKind: channelId ? "channel" : "team",
              ...(channelId ? { resourceId: channelId, channelId } : {}),
            });
          return result;
        });
      return this.access.handoff(
        revision,
        () =>
          this.access.database.transaction().execute(async (t) => {
            await this.access.member(t, actor.userId);
            await this.access.checkSession(t);
            return channelId ? (await this.access.channel(t, actor, channelId)).read : false;
          }),
        () => value,
      );
    } catch (error) {
      if (actor.kind === "agent")
        await appendTeamAudit(this.access.database, {
          actor,
          action: `agent.${action}`,
          resourceKind: channelId ? "channel" : "team",
          ...(channelId ? { resourceId: channelId, channelId } : {}),
          outcome: "denied",
        });
      throw error;
    }
  }
  page(
    actor: TeamActor,
    channelId: TeamChannelId,
    page: Page = { direction: "newest" },
    rootId?: TeamMessageId,
  ) {
    return this.read(actor, "read", channelId, (t) =>
      this.pageIn(t, actor, channelId, page, rootId),
    );
  }
  async message(actor: TeamActor, channelId: TeamChannelId, messageId: TeamMessageId) {
    return this.read(actor, "read", channelId, async (t) => {
      const row = await t
        .selectFrom("teamMessages")
        .selectAll()
        .where("channelId", "=", channelId)
        .where("id", "=", messageId)
        .executeTakeFirstOrThrow();
      return (await teamMessageViews(t, [row]))[0]!;
    });
  }
  async check(actor: TeamActor, channelId: TeamChannelId, clientIds: readonly string[]) {
    requireTeam(clientIds.length <= 50);
    return this.read(actor, "read", channelId, async (t) => ({
      messages: clientIds.length
        ? await teamMessageViews(
            t,
            await t
              .selectFrom("teamMessages")
              .selectAll()
              .where("channelId", "=", channelId)
              .where("authorKind", "=", actor.kind)
              .where("authorUserId", "=", actor.userId)
              .where("clientMessageId", "in", [...clientIds])
              .execute(),
          )
        : [],
    }));
  }
  async resume(
    actor: TeamActor,
    input: {
      subscriptionId: string;
      generation: number;
      scope: z.infer<typeof TeamSubscriptionScopeSchema>;
      sinceSeq: Sequence | null;
      linkPresence?: { ownerUserId: UserId; online: boolean }[];
    },
  ) {
    return this.read(actor, "read", input.scope.channelId, async (t) => {
      const channel = await this.channelView(t, actor, input.scope.channelId);
      const base = {
        subscriptionId: input.subscriptionId,
        generation: input.generation,
        scope: input.scope,
        throughSeq: channel.changeSeq,
        channel,
        linkPresence: input.linkPresence ?? [],
      };
      let messages = t.selectFrom("teamMessages").selectAll().where("channelId", "=", channel.id);
      let requests = t
        .selectFrom("teamAgentRequests")
        .selectAll()
        .where("channelId", "=", channel.id);
      if (input.scope.kind === "thread") {
        const rootId = input.scope.rootId;
        messages = messages.where((e) =>
          e.or([e("id", "=", rootId), e("threadRootId", "=", rootId)]),
        );
        requests = requests.where("threadRootId", "=", rootId);
      } else messages = messages.where("threadRootId", "is", null);
      if (input.sinceSeq !== null && BigInt(input.sinceSeq) <= BigInt(channel.changeSeq)) {
        const rows = await messages
          .where("changeSeq", ">", input.sinceSeq)
          .orderBy("changeSeq")
          .limit(201)
          .execute();
        const statuses = await requests
          .where("changeSeq", ">", input.sinceSeq)
          .orderBy("changeSeq")
          .limit(201)
          .execute();
        if (rows.length + statuses.length <= 200) {
          const cut = {
            ...base,
            type: "resumed" as const,
            changedRows: await teamMessageViews(
              t,
              rows.filter((r) => !r.deletedAt),
            ),
            deletedIds: rows.filter((r) => r.deletedAt).map((r) => r.id),
            requests: statuses.map(teamRequestView),
          };
          if (TeamConsistentCutSchema.safeParse(cut).success)
            return TeamConsistentCutSchema.parse(cut);
        }
      }
      const page = await this.pageIn(
        t,
        actor,
        channel.id,
        { direction: "newest" },
        input.scope.kind === "thread" ? input.scope.rootId : undefined,
      );
      const cut = {
        ...base,
        type: "snapshot" as const,
        messages: page.messages,
        requests: (await requests.orderBy("createdAt", "desc").limit(200).execute()).map(
          teamRequestView,
        ),
        hasMore: page.hasMore,
      };
      while (!TeamConsistentCutSchema.safeParse(cut).success && cut.messages.length > 1) {
        cut.messages.shift();
        cut.hasMore = true;
      }
      return TeamConsistentCutSchema.parse(cut);
    });
  }
  async search(actor: TeamActor, input: z.infer<typeof TeamSearchInputSchema>) {
    const revision = this.access.revision;
    const result = await this.read(actor, "search", undefined, async (t) => {
      await sql`set local statement_timeout='2s'`.execute(t);
      let query = t
        .selectFrom("teamMessages")
        .selectAll()
        .where("channelId", "in", teamReadableChannels(actor))
        .where("deletedAt", "is", null)
        .where(sql<boolean>`search_document @@ websearch_to_tsquery('simple',${input.query})`);
      if (input.channelId) query = query.where("channelId", "=", input.channelId);
      if (input.authorUserId) query = query.where("authorUserId", "=", input.authorUserId);
      if (input.threadRootId)
        query = query.where((e) =>
          e.or([e("threadRootId", "=", input.threadRootId!), e("id", "=", input.threadRootId!)]),
        );
      if (input.before) query = query.where("id", "<", input.before);
      if (input.hasFile !== undefined)
        query = query.where((e) =>
          input.hasFile
            ? e.exists(
                e
                  .selectFrom("teamMessageAttachments as a")
                  .select("a.blobId")
                  .whereRef("a.messageId", "=", "teamMessages.id"),
              )
            : e.not(
                e.exists(
                  e
                    .selectFrom("teamMessageAttachments as a")
                    .select("a.blobId")
                    .whereRef("a.messageId", "=", "teamMessages.id"),
                ),
              ),
        );
      const rows = await query.orderBy("id", "desc").limit(51).execute();
      const messages = await teamMessageViews(t, rows.slice(0, 50));
      return {
        results: await Promise.all(
          messages.map(async (message) => ({
            message,
            source: await this.source(
              t,
              actor,
              message.channelId,
              message.threadRootId ?? message.id,
              message.id,
            ),
          })),
        ),
        hasMore: rows.length > 50,
      };
    });
    return this.access.handoff(
      revision,
      () =>
        this.access.database.transaction().execute(async (t) => {
          for (const { message } of result.results)
            if (!(await this.access.channel(t, actor, message.channelId)).read) return false;
          return true;
        }),
      () => result,
    );
  }
  async readMarker(actor: TeamActor, channelId: TeamChannelId, throughMessageId: TeamMessageId) {
    await this.access.contentWrite(actor, channelId, async (t, a) => {
      requireTeam(actor.kind === "human" && a.read);
      requireTeam(
        await t
          .selectFrom("teamMessages")
          .select("id")
          .where("channelId", "=", channelId)
          .where("id", "=", throughMessageId)
          .executeTakeFirst(),
      );
      await t
        .insertInto("teamChannelMemberState")
        .values({
          channelId,
          userId: actor.userId,
          lastReadMessageId: throughMessageId,
          notificationLevel: "mentions",
          updatedAt: new Date(),
        })
        .onConflict((c) =>
          c.columns(["channelId", "userId"]).doUpdateSet({
            lastReadMessageId: sql`greatest(team_channel_member_state.last_read_message_id,excluded.last_read_message_id)`,
            updatedAt: new Date(),
          }),
        )
        .execute();
    });
    this.changed(channelId);
  }
  async preferences(
    actor: TeamActor,
    channelId: TeamChannelId,
    notificationLevel: "mentions" | "all" | "muted",
  ) {
    await this.access.contentWrite(actor, channelId, async (t, a) => {
      requireTeam(actor.kind === "human" && a.read);
      await t
        .insertInto("teamChannelMemberState")
        .values({
          channelId,
          userId: actor.userId,
          lastReadMessageId: null,
          notificationLevel,
          updatedAt: new Date(),
        })
        .onConflict((c) =>
          c
            .columns(["channelId", "userId"])
            .doUpdateSet({ notificationLevel, updatedAt: new Date() }),
        )
        .execute();
    });
    this.changed(channelId);
  }
  async directory(actor: TeamActor, after?: TeamChannelId, sidebar = false) {
    for (;;) {
      const revision = this.access.revision;
      const result = await this.access.database.transaction().execute(async (t) => {
        const member = await this.access.member(t, actor.userId);
        let query = t
          .selectFrom("teamChannels")
          .selectAll()
          .where((e) =>
            sidebar || actor.kind === "agent"
              ? e("id", "in", teamReadableChannels(actor))
              : e.or([
                  e("id", "in", teamReadableChannels(actor)),
                  e("kind", "=", "public"),
                  ...(member.role !== "member" ? [e("kind", "=", "private")] : []),
                ]),
          );
        if (after) query = query.where("id", ">", after);
        const rows = await query.orderBy("id").limit(51).execute();
        const channels = [];
        for (const row of rows.slice(0, 50)) {
          const authority = await this.access.channel(t, actor, row.id);
          const summary = {
            id: row.id,
            kind: row.kind,
            name: row.name ?? "Direct message",
            peopleOnly: row.peopleOnly,
            archivedAt: row.archivedAt?.toISOString() ?? null,
            changeSeq: SequenceSchema.parse(row.changeSeq),
            latestMessageId: authority.read ? row.latestMessageId : null,
            can: {
              read: authority.read,
              post: authority.post,
              manage: authority.manage,
              join: !authority.read && row.kind === "public" && !row.archivedAt,
              leave: authority.read && (row.kind === "public" || row.kind === "private"),
              wakeOwnAgent:
                authority.post &&
                !authority.peopleOnly &&
                !!(await t
                  .selectFrom("teamLinks")
                  .select("id")
                  .where("ownerUserId", "=", actor.userId)
                  .where("state", "=", "active")
                  .executeTakeFirst()),
            },
          };
          const state = await t
            .selectFrom("teamChannelMemberState")
            .selectAll()
            .where("channelId", "=", row.id)
            .where("userId", "=", actor.userId)
            .executeTakeFirst();
          const unread = (
            await sql<{
              unread: boolean;
              mentionCount: string;
            }>`select exists(select 1 from team_messages m where m.channel_id=${row.id} and m.id>coalesce(${state?.lastReadMessageId ?? null}::bigint,0) and m.deleted_at is null and not(m.author_kind='human' and m.author_user_id=${actor.userId})) as unread,
          (select count(*)::text from team_mentions n join team_messages m on m.id=n.message_id where n.channel_id=${row.id} and n.target_user_id=${actor.userId} and n.target_kind='person' and m.id>coalesce(${state?.lastReadMessageId ?? null}::bigint,0) and m.deleted_at is null and not(m.author_kind='human' and m.author_user_id=${actor.userId})) as mention_count`.execute(
              t,
            )
          ).rows[0]!;
          channels.push({
            channel: summary,
            unread: unread.unread,
            mentionCount: Number(unread.mentionCount),
            lastReadMessageId: state?.lastReadMessageId ?? null,
            notificationLevel:
              state?.notificationLevel ??
              (row.kind === "dm" || row.kind === "group_dm" ? "all" : "mentions"),
            agentOnline: false,
          });
        }
        if (actor.kind === "agent")
          await appendTeamAudit(t, { actor, action: "agent.directory", resourceKind: "team" });
        return {
          channels,
          nextCursor: rows.length > 50 ? rows[49]!.id : null,
          accessRevision: revision,
        };
      });
      if (revision === this.access.revision) return result;
    }
  }
}
