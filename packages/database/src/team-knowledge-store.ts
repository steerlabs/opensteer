import {
  OpensteerError,
  type KnowledgeNoteId,
  type KnowledgeTopicId,
  type TeamAgentRequestId,
  type TeamChannelId,
  type TeamGroupId,
  type TeamLinkId,
  type TeamMessageId,
  type UserId,
} from "@opensteer/core";
import { sql, type Kysely, type Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { teamPrincipalProfiles } from "./team-principals-store.js";

type Executor = Kysely<DatabaseSchema> | Transaction<DatabaseSchema>;

export interface TeamTopicRecord {
  readonly id: KnowledgeTopicId;
  readonly name: string;
  readonly description: string;
  readonly archivedAt: Date | null;
  readonly updatedAt: Date;
  readonly accessRevision: string;
}

export type TeamTopicSubject =
  | { readonly kind: "person"; readonly userId: UserId }
  | { readonly kind: "group"; readonly groupId: TeamGroupId }
  | { readonly kind: "everyone" };
export type TeamTopicLevel = "read" | "write" | "manage";
export interface TeamTopicGrant {
  readonly subject: TeamTopicSubject;
  readonly level: TeamTopicLevel;
}

const everyoneSubjectId = "team";
const levelRank = { read: 1, write: 2, manage: 3 } as const;
const subjectId = (subject: TeamTopicSubject) =>
  subject.kind === "person"
    ? subject.userId
    : subject.kind === "group"
      ? subject.groupId
      : everyoneSubjectId;

function topicRows(executor: Executor) {
  return executor
    .selectFrom("teamTopics as t")
    .select(["t.id", "t.name", "t.description", "t.archivedAt", "t.updatedAt", "t.accessRevision"]);
}

export async function readTeamTopic(
  executor: Executor,
  topicId: KnowledgeTopicId,
): Promise<TeamTopicRecord | undefined> {
  return topicRows(executor).where("t.id", "=", topicId).executeTakeFirst();
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
      sql<boolean>`(lower(t.name), t.id) > (select lower(a.name), a.id from team_topics a where a.id = ${after})`,
    );
  return query
    .orderBy(sql`lower(t.name)`)
    .orderBy("t.id")
    .limit(limit)
    .execute();
}

/**
 * The topics this person can read: granted to them, to a group they are in (nested), or to
 * everyone. Their agent reads exactly the same.
 */
export function teamReadableTopicIds(userId: UserId) {
  return sql<KnowledgeTopicId>`(with recursive member_groups(id, path) as (
    select p.group_id, array[p.group_id] from team_group_people p
    join team_groups g on g.id=p.group_id and g.deleted_at is null where p.user_id=${userId}
    union all
    select e.parent_group_id, p.path || e.parent_group_id from member_groups p
    join team_group_edges e on e.child_group_id=p.id
    join team_groups g on g.id=e.parent_group_id and g.deleted_at is null
    where cardinality(p.path)<16 and not e.parent_group_id=any(p.path)
  )
  select g.topic_id from team_topic_grants g
  where exists(select 1 from team_members m where m.user_id=${userId} and m.state='active')
    and (g.subject_kind='everyone'
      or (g.subject_kind='person' and g.subject_id=${userId})
      or (g.subject_kind='group' and g.subject_id in (select id from member_groups))))`;
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
        : row.subjectKind === "group"
          ? { kind: "group", groupId: row.subjectId as TeamGroupId }
          : { kind: "everyone" },
    level: row.level,
  }));
}

/** One entry per subject (the highest level wins); every person and group is live in the team. */
async function checkedGrants(
  transaction: Transaction<DatabaseSchema>,
  grants: readonly TeamTopicGrant[],
): Promise<TeamTopicGrant[]> {
  const bySubject = new Map<string, TeamTopicGrant>();
  for (const grant of grants) {
    if (grant.subject.kind === "everyone" && grant.level === "manage")
      throw new OpensteerError({
        code: "bad_request",
        reason: "team-topic-everyone-manage",
        message: "Everyone can read or write a topic; managing it is for people and groups.",
      });
    const key = `${grant.subject.kind}:${subjectId(grant.subject)}`;
    const held = bySubject.get(key);
    if (!held || levelRank[grant.level] > levelRank[held.level]) bySubject.set(key, grant);
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
  return [...bySubject.values()];
}

async function insertGrants(
  transaction: Transaction<DatabaseSchema>,
  topicId: KnowledgeTopicId,
  grants: readonly TeamTopicGrant[],
  addedBy: UserId | null,
): Promise<void> {
  if (!grants.length) return;
  await transaction
    .insertInto("teamTopicGrants")
    .values(
      grants.map((grant) => ({
        topicId,
        subjectKind: grant.subject.kind,
        subjectId: subjectId(grant.subject),
        level: grant.level,
        addedBy,
      })),
    )
    .execute();
}

/** A new topic; its creator always manages it. */
export async function createTeamTopic(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly id: KnowledgeTopicId;
    readonly name: string;
    readonly description: string;
    readonly createdBy: UserId;
    readonly access: readonly TeamTopicGrant[];
  },
): Promise<void> {
  const grants = await checkedGrants(transaction, [
    ...input.access,
    { subject: { kind: "person", userId: input.createdBy }, level: "manage" },
  ]);
  await transaction
    .insertInto("teamTopics")
    .values({
      id: input.id,
      name: input.name,
      description: input.description,
      createdBy: input.createdBy,
    })
    .execute();
  await insertGrants(transaction, input.id, grants, input.createdBy);
}

/** Every team starts with one topic everyone can write, so agents have somewhere to save. */
export async function ensureTeamStarterTopic(
  database: Kysely<DatabaseSchema>,
  id: KnowledgeTopicId,
): Promise<void> {
  await database.transaction().execute(async (transaction) => {
    const inserted = await sql<{ id: KnowledgeTopicId }>`
      insert into team_topics (id, name, description)
      select ${id}, 'General', 'Anything the team should know that has no better home.'
      where not exists (select 1 from team_topics)
      returning id`.execute(transaction);
    if (inserted.rows.length)
      await insertGrants(
        transaction,
        id,
        [{ subject: { kind: "everyone" }, level: "write" }],
        null,
      );
  });
}

/** Replaces a topic's list when it is still at `expectedRevision`; false when it moved on. */
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
    .updateTable("teamTopics")
    .set({ accessRevision: sql<string>`access_revision + 1`, updatedAt: sql<Date>`now()` })
    .where("id", "=", input.topicId)
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
  await insertGrants(transaction, input.topicId, grants, input.changedBy);
  return true;
}

/** Drops a person or group from every topic list, as removing them from the team does. */
export async function deleteTeamTopicGrantsFor(
  transaction: Transaction<DatabaseSchema>,
  subject: Exclude<TeamTopicSubject, { kind: "everyone" }>,
): Promise<KnowledgeTopicId[]> {
  const held = await transaction
    .selectFrom("teamTopicGrants")
    .select("topicId")
    .where("subjectKind", "=", subject.kind)
    .where("subjectId", "=", subjectId(subject))
    .orderBy("topicId")
    .orderBy("subjectKind")
    .orderBy("subjectId")
    // FOR UPDATE: Removing the subject deletes these rows.
    .forUpdate()
    .execute();
  await transaction
    .deleteFrom("teamTopicGrants")
    .where("subjectKind", "=", subject.kind)
    .where("subjectId", "=", subjectId(subject))
    .execute();
  return held.map((row) => row.topicId);
}

export async function updateTeamTopic(
  transaction: Transaction<DatabaseSchema>,
  topicId: KnowledgeTopicId,
  change: { readonly name: string; readonly description: string } | { readonly archived: boolean },
): Promise<boolean> {
  const updated = await transaction
    .updateTable("teamTopics")
    .set(
      "archived" in change
        ? { archivedAt: change.archived ? sql<Date>`now()` : null, updatedAt: sql<Date>`now()` }
        : { name: change.name, description: change.description, updatedAt: sql<Date>`now()` },
    )
    .where("id", "=", topicId)
    .executeTakeFirst();
  return updated.numUpdatedRows === 1n;
}

/**
 * Who can read each topic now, as active members: everyone, or this set of people.
 * Groups count their nested groups' people.
 */
export async function teamTopicReaders(
  executor: Executor,
  topicIds: readonly KnowledgeTopicId[],
): Promise<Map<KnowledgeTopicId, "everyone" | ReadonlySet<UserId>>> {
  const readers = new Map<KnowledgeTopicId, "everyone" | Set<UserId>>(
    topicIds.map((id) => [id, new Set<UserId>()]),
  );
  if (!topicIds.length) return readers;
  const ids = [...new Set(topicIds)];
  const everyone = await executor
    .selectFrom("teamTopicGrants")
    .select("topicId")
    .where("topicId", "in", ids)
    .where("subjectKind", "=", "everyone")
    .execute();
  for (const row of everyone) readers.set(row.topicId, "everyone");
  const rows = await sql<{ topicId: KnowledgeTopicId; userId: UserId }>`
    with recursive granted(topic_id, group_id, path) as (
      select g.topic_id, g.subject_id, array[g.subject_id] from team_topic_grants g
      join team_groups gr on gr.id=g.subject_id and gr.deleted_at is null
      where g.subject_kind='group' and g.topic_id in (${sql.join(ids)})
      union all
      select p.topic_id, e.child_group_id, p.path || e.child_group_id from granted p
      join team_group_edges e on e.parent_group_id=p.group_id
      join team_groups gr on gr.id=e.child_group_id and gr.deleted_at is null
      where cardinality(p.path)<16 and not e.child_group_id=any(p.path)
    )
    select distinct r.topic_id, r.user_id from (
      select topic_id, subject_id as user_id from team_topic_grants
      where subject_kind='person' and topic_id in (${sql.join(ids)})
      union all
      select granted.topic_id, gp.user_id from granted
      join team_group_people gp on gp.group_id=granted.group_id
    ) r join team_members m on m.user_id=r.user_id and m.state='active'`.execute(executor);
  for (const row of rows.rows) {
    const set = readers.get(row.topicId);
    if (set && set !== "everyone") set.add(row.userId);
  }
  return readers;
}

/** The active people who can read a channel, the room an agent's answer lands in. */
export async function teamChannelReaders(
  executor: Executor,
  channelId: TeamChannelId,
): Promise<ReadonlySet<UserId>> {
  const rows = await sql<{ userId: UserId }>`
    with recursive granted(group_id, path) as (
      select a.subject_id, array[a.subject_id] from team_channel_members a
      join team_groups gr on gr.id=a.subject_id and gr.deleted_at is null
      where a.subject_kind='group' and a.channel_id=${channelId}
      union all
      select e.child_group_id, p.path || e.child_group_id from granted p
      join team_group_edges e on e.parent_group_id=p.group_id
      join team_groups gr on gr.id=e.child_group_id and gr.deleted_at is null
      where cardinality(p.path)<16 and not e.child_group_id=any(p.path)
    )
    select distinct r.user_id from (
      select subject_id as user_id from team_channel_members
      where subject_kind='person' and channel_id=${channelId}
      union all
      select gp.user_id from granted join team_group_people gp on gp.group_id=granted.group_id
    ) r join team_members m on m.user_id=r.user_id and m.state='active'`.execute(executor);
  return new Set(rows.rows.map((row) => row.userId));
}

export async function teamActiveMemberCount(executor: Executor): Promise<number> {
  const row = await executor
    .selectFrom("teamMembers")
    .select((eb) => eb.fn.countAll<string>().as("count"))
    .where("state", "=", "active")
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

export async function teamTopicNoteCounts(
  executor: Executor,
  topicIds: readonly KnowledgeTopicId[],
): Promise<Map<KnowledgeTopicId, number>> {
  const counts = new Map<KnowledgeTopicId, number>(topicIds.map((id) => [id, 0]));
  if (!topicIds.length) return counts;
  const rows = await executor
    .selectFrom("teamNotes")
    .select(["topicId", (eb) => eb.fn.countAll<string>().as("count")])
    .where("topicId", "in", [...new Set(topicIds)])
    .where("deletedAt", "is", null)
    .groupBy("topicId")
    .execute();
  for (const row of rows) counts.set(row.topicId, Number(row.count));
  return counts;
}

export interface TeamNoteWriterRecord {
  readonly kind: "human" | "agent";
  readonly userId: UserId;
  readonly name: string;
}
export interface TeamNoteRecord {
  readonly id: KnowledgeNoteId;
  readonly topicId: KnowledgeTopicId;
  readonly version: number;
  readonly title: string;
  readonly body: string;
  readonly deleted: boolean;
  readonly writtenAt: Date;
  readonly writer: TeamNoteWriterRecord;
  readonly source: { readonly channelId: TeamChannelId; readonly messageId: TeamMessageId } | null;
}

function versionRows(executor: Executor) {
  return executor
    .selectFrom("teamNoteVersions as v")
    .innerJoin("teamNotes as n", "n.id", "v.noteId")
    .innerJoin(teamPrincipalProfiles(executor).as("writer"), "writer.id", "v.writerUserId")
    .leftJoin("teamAgentRequests as r", "r.id", "v.requestId")
    .select([
      "v.noteId",
      "n.topicId",
      "v.version",
      "v.title",
      "v.body",
      "v.deleted",
      "v.writtenAt",
      "v.writerKind",
      "v.writerUserId",
      "writer.displayName",
      "r.channelId",
      "r.triggerMessageId",
    ]);
}
type VersionRow = Awaited<ReturnType<ReturnType<typeof versionRows>["execute"]>>[number];
const noteRecord = (row: VersionRow): TeamNoteRecord => ({
  id: row.noteId,
  topicId: row.topicId,
  version: row.version,
  title: row.title,
  body: row.body,
  deleted: row.deleted,
  writtenAt: row.writtenAt,
  writer: { kind: row.writerKind, userId: row.writerUserId, name: row.displayName },
  source:
    row.channelId && row.triggerMessageId
      ? { channelId: row.channelId, messageId: row.triggerMessageId }
      : null,
});

/** The note as it is now (its newest version), deleted or not. */
export async function readTeamNote(
  executor: Executor,
  noteId: KnowledgeNoteId,
): Promise<TeamNoteRecord | undefined> {
  const row = await versionRows(executor)
    .where("v.noteId", "=", noteId)
    .whereRef("v.version", "=", "n.version")
    .executeTakeFirst();
  return row && noteRecord(row);
}

/** Every version, newest first. */
export async function teamNoteHistory(
  executor: Executor,
  input: { readonly noteId: KnowledgeNoteId; readonly before?: number; readonly limit: number },
): Promise<{ readonly versions: TeamNoteRecord[]; readonly hasMore: boolean }> {
  let query = versionRows(executor).where("v.noteId", "=", input.noteId);
  if (input.before !== undefined) query = query.where("v.version", "<", input.before);
  const rows = await query
    .orderBy("v.version", "desc")
    .limit(input.limit + 1)
    .execute();
  return {
    versions: rows.slice(0, input.limit).map(noteRecord),
    hasMore: rows.length > input.limit,
  };
}

/**
 * Words as a prefix search, so a half-typed word still finds its note.
 * Undefined when the text has no searchable word.
 */
export function teamNoteSearchQuery(text: string): string | undefined {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 16);
  return words.length ? words.map((word) => `'${word}':*`).join(" & ") : undefined;
}

type NoteCursor =
  | { readonly kind: "recent"; readonly micros: string; readonly id: KnowledgeNoteId }
  | { readonly kind: "rank"; readonly offset: number };
const encodeCursor = (cursor: NoteCursor) =>
  Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
function decodeCursor(cursor: string | undefined): NoteCursor | undefined {
  if (cursor === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof value === "object" && value !== null && "kind" in value) {
      if (
        value.kind === "recent" &&
        "micros" in value &&
        typeof value.micros === "string" &&
        /^\d{1,18}$/u.test(value.micros) &&
        "id" in value &&
        typeof value.id === "string"
      )
        return { kind: "recent", micros: value.micros, id: value.id as KnowledgeNoteId };
      if (
        value.kind === "rank" &&
        "offset" in value &&
        Number.isSafeInteger(value.offset) &&
        (value.offset as number) >= 0 &&
        (value.offset as number) <= 10_000
      )
        return { kind: "rank", offset: value.offset as number };
    }
  } catch {
    // Falls through to the refusal below.
  }
  throw new OpensteerError({ code: "bad_request", message: "That page cursor isn't valid." });
}

/**
 * Current, undeleted notes in readable topics: newest-changed first, or best matches first
 * with `query`. Bodies come back whole; callers shorten them for previews.
 */
export async function teamNotesPage(
  executor: Executor,
  input: {
    readonly readerUserId: UserId;
    readonly topicId?: KnowledgeTopicId;
    readonly query?: string;
    readonly cursor?: string;
    readonly limit: number;
  },
): Promise<{ readonly notes: TeamNoteRecord[]; readonly nextCursor: string | null }> {
  const cursor = decodeCursor(input.cursor);
  const search = input.query === undefined ? undefined : teamNoteSearchQuery(input.query);
  if (input.query !== undefined && search === undefined) return { notes: [], nextCursor: null };
  let query = versionRows(executor)
    .whereRef("v.version", "=", "n.version")
    .where("n.deletedAt", "is", null)
    .where("n.topicId", "in", teamReadableTopicIds(input.readerUserId))
    .select([
      "n.updatedAt",
      // Exact to the microsecond, which a JavaScript Date is not, so a page boundary never skips.
      sql<string>`(extract(epoch from n.updated_at) * 1000000)::bigint::text`.as("updatedMicros"),
    ]);
  if (input.topicId) query = query.where("n.topicId", "=", input.topicId);
  if (search !== undefined) {
    if (cursor && cursor.kind !== "rank")
      throw new OpensteerError({ code: "bad_request", message: "That page cursor isn't valid." });
    const offset = cursor?.offset ?? 0;
    const tsquery = sql`to_tsquery('simple', ${search})`;
    const rows = await query
      .where(sql<boolean>`n.search @@ ${tsquery}`)
      .orderBy(sql`ts_rank(n.search, ${tsquery})`, "desc")
      .orderBy("n.updatedAt", "desc")
      .orderBy("n.id", "desc")
      .offset(offset)
      .limit(input.limit + 1)
      .execute();
    return {
      notes: rows.slice(0, input.limit).map(noteRecord),
      nextCursor:
        rows.length > input.limit
          ? encodeCursor({ kind: "rank", offset: offset + input.limit })
          : null,
    };
  }
  if (cursor && cursor.kind !== "recent")
    throw new OpensteerError({ code: "bad_request", message: "That page cursor isn't valid." });
  if (cursor)
    query = query.where(
      sql<boolean>`(n.updated_at, n.id) < (timestamptz 'epoch' + ${cursor.micros}::bigint * interval '1 microsecond', ${cursor.id})`,
    );
  const rows = await query
    .orderBy("n.updatedAt", "desc")
    .orderBy("n.id", "desc")
    .limit(input.limit + 1)
    .execute();
  const last = rows[input.limit - 1];
  return {
    notes: rows.slice(0, input.limit).map(noteRecord),
    nextCursor:
      rows.length > input.limit && last
        ? encodeCursor({ kind: "recent", micros: last.updatedMicros, id: last.noteId })
        : null,
  };
}

export interface TeamNoteWrite {
  readonly noteId: KnowledgeNoteId;
  /** Required to create; a change stays in the note's own topic. */
  readonly topicId?: KnowledgeTopicId;
  /** null creates the note; otherwise the version the writer read. */
  readonly expectedVersion: number | null;
  readonly title?: string;
  readonly body?: string;
  readonly delete?: true;
  readonly writer: {
    readonly kind: "human" | "agent";
    readonly userId: UserId;
    readonly linkId?: TeamLinkId;
    readonly requestId?: TeamAgentRequestId;
  };
}
export type TeamNoteWriteOutcome =
  | {
      readonly written: true;
      readonly noteId: KnowledgeNoteId;
      readonly topicId: KnowledgeTopicId;
      readonly version: number;
    }
  | { readonly written: false; readonly current: TeamNoteRecord };

/**
 * Appends one version when the note is still at `expectedVersion`. A retry of the same
 * write by the same writer returns its first outcome; any other mismatch returns the
 * note as it is now. `authorize` runs against the note's topic before anything changes.
 */
export async function writeTeamNote(
  transaction: Transaction<DatabaseSchema>,
  input: TeamNoteWrite,
  authorize: (topicId: KnowledgeTopicId) => Promise<void>,
): Promise<TeamNoteWriteOutcome> {
  const head = await transaction
    .selectFrom("teamNotes")
    .select(["id", "topicId", "version", "title", "body", "deletedAt"])
    .where("id", "=", input.noteId)
    // NO KEY UPDATE: the head's version is the note's write fence.
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (!head) {
    if (input.expectedVersion !== null || !input.topicId)
      throw new OpensteerError({
        code: "not_found",
        reason: "team-note-not-found",
        message: "That note doesn't exist or you can't read it.",
      });
    await authorize(input.topicId);
    const title = input.title ?? "";
    const body = input.body ?? "";
    const created = await transaction
      .insertInto("teamNotes")
      .values({ id: input.noteId, topicId: input.topicId, version: 1, title, body })
      .onConflict((conflict) => conflict.column("id").doNothing())
      .returning("id")
      .executeTakeFirst();
    // A concurrent write of this id committed first: answer as against its head.
    if (!created) return writeTeamNote(transaction, input, authorize);
    await insertVersion(transaction, input, 1, title, body, false);
    return { written: true, noteId: input.noteId, topicId: input.topicId, version: 1 };
  }
  await authorize(head.topicId);
  // The version this write would have made: if this writer already made it with exactly
  // this change, a resent write answers with that, even after later edits.
  const made = (input.expectedVersion ?? 0) + 1;
  if (head.version >= made && (input.expectedVersion !== null || input.topicId === head.topicId)) {
    const rows = await transaction
      .selectFrom("teamNoteVersions")
      .select(["version", "writerUserId", "writerKind", "title", "body", "deleted"])
      .where("noteId", "=", head.id)
      .where(
        "version",
        "in",
        input.expectedVersion === null ? [made] : [input.expectedVersion, made],
      )
      .execute();
    const base = rows.find((row) => row.version === input.expectedVersion);
    const written = rows.find((row) => row.version === made);
    const intended =
      input.expectedVersion === null
        ? { title: input.title ?? "", body: input.body ?? "", deleted: false }
        : base && {
            title: input.title ?? base.title,
            body: input.body ?? base.body,
            deleted: input.delete === true,
          };
    if (
      intended &&
      written &&
      written.writerUserId === input.writer.userId &&
      written.writerKind === input.writer.kind &&
      written.title === intended.title &&
      written.body === intended.body &&
      written.deleted === intended.deleted
    )
      return { written: true, noteId: head.id, topicId: head.topicId, version: made };
  }
  if (input.expectedVersion === null || head.version !== input.expectedVersion) {
    const current = await readTeamNote(transaction, head.id);
    if (!current) throw new Error("A note head has no current version");
    return { written: false, current };
  }
  const target = {
    title: input.title ?? head.title,
    body: input.body ?? head.body,
    deleted: input.delete === true,
  };
  if (head.deletedAt !== null && target.deleted)
    return { written: true, noteId: head.id, topicId: head.topicId, version: head.version };
  const version = head.version + 1;
  await transaction
    .updateTable("teamNotes")
    .set({
      version,
      title: target.title,
      body: target.body,
      updatedAt: sql<Date>`now()`,
      deletedAt: target.deleted ? sql<Date>`now()` : null,
    })
    .where("id", "=", head.id)
    .execute();
  await insertVersion(transaction, input, version, target.title, target.body, target.deleted);
  return { written: true, noteId: head.id, topicId: head.topicId, version };
}

async function insertVersion(
  transaction: Transaction<DatabaseSchema>,
  input: TeamNoteWrite,
  version: number,
  title: string,
  body: string,
  deleted: boolean,
): Promise<void> {
  await transaction
    .insertInto("teamNoteVersions")
    .values({
      noteId: input.noteId,
      version,
      title,
      body,
      deleted,
      writerKind: input.writer.kind,
      writerUserId: input.writer.userId,
      linkId: input.writer.kind === "agent" ? (input.writer.linkId ?? null) : null,
      requestId: input.writer.kind === "agent" ? (input.writer.requestId ?? null) : null,
    })
    .execute();
}
