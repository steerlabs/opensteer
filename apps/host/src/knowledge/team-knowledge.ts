import {
  createId,
  OpensteerError,
  SequenceSchema,
  type KnowledgeNoteId,
  type KnowledgeTopicId,
  type TeamActor,
  type TeamAgentRequestId,
  type TeamChannelId,
  type TeamLinkId,
  type UserId,
} from "@opensteer/core";
import {
  createTeamTopic,
  ensureTeamStarterTopic,
  readTeamNote,
  readTeamTopic,
  setTeamTopicGrants,
  teamActiveMemberCount,
  teamChannelReaders,
  teamNoteHistory,
  teamNotesPage,
  teamReadableTopicIds,
  teamTopicGrants,
  teamTopicNoteCounts,
  teamTopicReaders,
  teamTopicsAfter,
  updateTeamTopic,
  writeTeamNote,
  type DatabaseSchema,
  type TeamNoteRecord,
  type TeamNoteWrite,
  type TeamTopicGrant,
  type TeamTopicRecord,
} from "@opensteer/database";
import {
  teamKnowledgeLimits,
  teamReadSchemas,
  type TeamCommandSchema,
  type TeamKnowledgeReadInput,
  type TeamKnowledgeReadResult,
  type TeamKnowledgeTopicView,
  type TeamKnowledgeTopicsResult,
  type TeamKnowledgeWrite,
  type TeamKnowledgeWriteResult,
  type TeamNote,
  type TeamNotePreview,
  type TeamTopic,
  type TeamTopicAudience,
} from "@opensteer/protocol";
import { markdownPreview } from "@opensteer/shared/markdownPreview";
import type { Kysely, Transaction } from "kysely";
import type { z } from "zod";
import type {
  TeamAccessEffects,
  TeamAccessLockPort,
  TeamAccessResolver,
} from "../team/access-port.js";

type TeamCommand = z.infer<typeof TeamCommandSchema>;
const knowledgeCommands = new Set([
  "team.knowledge.topic.create",
  "team.knowledge.topic.update",
  "team.knowledge.topic.access.set",
  "team.knowledge.topic.archive",
  "team.knowledge.topic.restore",
  "team.knowledge.note.write",
  "team.knowledge.note.delete",
] as const);
export type TeamKnowledgeCommand = Extract<
  TeamCommand,
  { type: typeof knowledgeCommands extends Set<infer Type> ? Type : never }
>;
export type TeamKnowledgeCommandResult =
  | { readonly type: Exclude<TeamKnowledgeCommand["type"], `team.knowledge.note.${string}`> }
  | {
      readonly type: "team.knowledge.note.write" | "team.knowledge.note.delete";
      readonly noteId: KnowledgeNoteId;
      readonly version: number;
    };
const knowledgeReads = new Set([
  "team.knowledge.topics.list",
  "team.knowledge.topic.get",
  "team.knowledge.topic.access.get",
  "team.knowledge.notes.page",
  "team.knowledge.note.get",
  "team.knowledge.note.history",
] as const);
export type TeamKnowledgeReadName = typeof knowledgeReads extends Set<infer Name> ? Name : never;
type Read<Name extends TeamKnowledgeReadName> = {
  readonly input: z.infer<(typeof teamReadSchemas)[Name]["input"]>;
  readonly output: z.infer<(typeof teamReadSchemas)[Name]["output"]>;
};

/** The team's access service: the frozen ports plus the change that knows who made it. */
export interface TeamKnowledgeAccess extends TeamAccessResolver, TeamAccessLockPort {
  /** Like `mutate`, and records and announces an admin's gain of a restricted resource. */
  mutateAs<Value>(
    actor: TeamActor,
    action: string,
    write: (
      transaction: Transaction<DatabaseSchema>,
    ) => Promise<{ readonly value: Value; readonly effects: TeamAccessEffects }>,
  ): Promise<Value>;
}
/** The team audit log's writer; entries hold IDs and counts, never note text or search words. */
export type TeamKnowledgeAudit = (
  executor: Kysely<DatabaseSchema>,
  entry: {
    readonly actor: TeamActor;
    readonly action: string;
    readonly resourceKind: "topic";
    readonly resourceId?: string | undefined;
    readonly channelId?: TeamChannelId | undefined;
    readonly linkId?: TeamLinkId | undefined;
    readonly requestId?: TeamAgentRequestId | undefined;
    readonly outcome?: "allowed" | "denied";
    readonly metadata?: Readonly<Record<string, unknown>>;
  },
) => Promise<unknown>;

/** A person's agent, reached over that person's link; a request only says where the ask came from. */
export interface TeamKnowledgeAgent {
  readonly linkId: TeamLinkId;
  readonly ownerUserId: UserId;
  readonly requestId?: TeamAgentRequestId | undefined;
}
/** A buffered agent answer and the check that it may still be handed over. */
export interface TeamKnowledgeAnswer<Result> {
  readonly result: Result;
  readonly reauthorize: () => Promise<boolean>;
}

export interface TeamKnowledge {
  topics(agent: TeamKnowledgeAgent): Promise<TeamKnowledgeAnswer<TeamKnowledgeTopicsResult>>;
  readNotes(
    agent: TeamKnowledgeAgent,
    input: TeamKnowledgeReadInput,
  ): Promise<TeamKnowledgeAnswer<TeamKnowledgeReadResult>>;
  write(agent: TeamKnowledgeAgent, input: TeamKnowledgeWrite): Promise<TeamKnowledgeWriteResult>;
  /** A person's knowledge read; the output matches `teamReadSchemas[name].output`. */
  read(actor: TeamActor, name: string, input: unknown): Promise<unknown>;
  command(actor: TeamActor, command: TeamCommand): Promise<TeamKnowledgeCommandResult>;
}

export function isTeamKnowledgeRead(name: string): name is TeamKnowledgeReadName {
  return (knowledgeReads as ReadonlySet<string>).has(name);
}
export function isTeamKnowledgeCommand(command: TeamCommand): command is TeamKnowledgeCommand {
  return (knowledgeCommands as ReadonlySet<string>).has(command.type);
}

/**
 * Topics are categories whose access lists decide who reads their notes; a person's agent
 * reads and writes exactly what its owner can, wherever it was asked. Authority is resolved
 * afresh on every call; writes commit inside the access fence, and buffered reads are handed
 * over only while every topic they came from is still readable.
 */
export async function startTeamKnowledge(options: {
  readonly database: Kysely<DatabaseSchema>;
  readonly access: TeamKnowledgeAccess;
  readonly audit: TeamKnowledgeAudit;
}): Promise<TeamKnowledge> {
  const { database, access, audit } = options;
  await ensureTeamStarterTopic(database, createId("knowledgeTopic"));
  const inTransaction = <Value>(
    work: (transaction: Transaction<DatabaseSchema>) => Promise<Value>,
  ) => database.transaction().execute(work);

  async function handOff<Value>(
    authorizedAt: typeof access.revision,
    stillReadable: () => Promise<boolean>,
    answer: Value,
  ): Promise<Value> {
    let lost = false;
    try {
      return await access.handoff(
        authorizedAt,
        async () => {
          lost = !(await stillReadable().catch(() => false));
          return !lost;
        },
        () => answer,
      );
    } catch (error) {
      if (!lost) throw error;
      throw new OpensteerError({
        code: "forbidden",
        reason: "knowledge-access-changed",
        message: "Access to this topic changed while it was being read.",
        next: "Read it again.",
      });
    }
  }

  const readableBy = (actor: TeamActor, topicIds: readonly KnowledgeTopicId[]) => async () =>
    inTransaction(async (transaction) => {
      for (const topicId of new Set(topicIds))
        if (!(await access.topic(transaction, actor, topicId)).read) return false;
      return true;
    });

  async function audience(
    executor: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    topicIds: readonly KnowledgeTopicId[],
    room?: TeamChannelId,
  ): Promise<
    Map<KnowledgeTopicId, { readonly audience: TeamTopicAudience; readonly roomCanRead?: boolean }>
  > {
    const [readers, members, roomReaders] = await Promise.all([
      teamTopicReaders(executor, topicIds),
      teamActiveMemberCount(executor),
      room ? teamChannelReaders(executor, room) : undefined,
    ]);
    return new Map(
      [...readers].map(([topicId, read]) => [
        topicId,
        {
          audience:
            read === "everyone"
              ? { everyone: true, people: members }
              : { everyone: false, people: read.size },
          ...(roomReaders
            ? {
                roomCanRead:
                  read === "everyone" || [...roomReaders].every((userId) => read.has(userId)),
              }
            : {}),
        },
      ]),
    );
  }

  // ---- Agents, over their owner's link -------------------------------------------------

  /** The link's owner as an agent, and the asking channel when the call names its request. */
  async function caller(
    executor: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    agent: TeamKnowledgeAgent,
  ): Promise<{ readonly actor: TeamActor; readonly room?: TeamChannelId }> {
    const link = await executor
      .selectFrom("teamLinks as l")
      .innerJoin("teamMembers as m", "m.userId", "l.ownerUserId")
      .select("l.id")
      .where("l.id", "=", agent.linkId)
      .where("l.ownerUserId", "=", agent.ownerUserId)
      .where("l.state", "=", "active")
      .where("m.state", "=", "active")
      .executeTakeFirst();
    if (!link)
      throw new OpensteerError({
        code: "forbidden",
        reason: "knowledge-link-unavailable",
        message: "This computer's link to the team is no longer active.",
      });
    const actor: TeamActor = { kind: "agent", userId: agent.ownerUserId };
    if (agent.requestId === undefined) return { actor };
    const request = await executor
      .selectFrom("teamAgentRequests")
      .select("channelId")
      .where("id", "=", agent.requestId)
      .where("linkId", "=", agent.linkId)
      .where("ownerUserId", "=", agent.ownerUserId)
      .executeTakeFirst();
    if (!request)
      throw new OpensteerError({ code: "bad_request", message: "That request isn't this link's." });
    return { actor, room: request.channelId };
  }

  async function agentAudit(
    agent: TeamKnowledgeAgent,
    room: TeamChannelId | undefined,
    action: "knowledge.topics" | "knowledge.read" | "knowledge.write",
    outcome: "allowed" | "denied",
    metadata: Readonly<Record<string, unknown>>,
    resourceId?: KnowledgeTopicId,
  ) {
    await audit(database, {
      actor: { kind: "agent", userId: agent.ownerUserId },
      action,
      resourceKind: "topic",
      resourceId,
      linkId: agent.linkId,
      requestId: agent.requestId,
      channelId: room,
      outcome,
      metadata,
    });
  }

  async function denied<Value>(
    agent: TeamKnowledgeAgent,
    action: "knowledge.topics" | "knowledge.read" | "knowledge.write",
    work: () => Promise<Value>,
  ): Promise<Value> {
    try {
      return await work();
    } catch (error) {
      await agentAudit(agent, undefined, action, "denied", {}).catch(() => undefined);
      throw error;
    }
  }

  function topicView(
    topic: TeamTopicRecord,
    canWrite: boolean,
    seen: { readonly audience: TeamTopicAudience; readonly roomCanRead?: boolean } | undefined,
  ): TeamKnowledgeTopicView {
    return {
      id: topic.id,
      name: topic.name,
      description: topic.description,
      canWrite,
      archived: topic.archivedAt !== null,
      audience: seen?.audience ?? { everyone: false, people: 0 },
      ...(seen?.roomCanRead === undefined ? {} : { roomCanRead: seen.roomCanRead }),
    };
  }

  async function topics(
    agent: TeamKnowledgeAgent,
  ): Promise<TeamKnowledgeAnswer<TeamKnowledgeTopicsResult>> {
    const authorizedAt = access.revision;
    return denied(agent, "knowledge.topics", async () => {
      const { result, room, actor } = await inTransaction(async (transaction) => {
        const { actor, room } = await caller(transaction, agent);
        const rows = await transaction
          .selectFrom("teamTopics as t")
          .select([
            "t.id",
            "t.name",
            "t.description",
            "t.archivedAt",
            "t.updatedAt",
            "t.accessRevision",
          ])
          .where("t.id", "in", teamReadableTopicIds(agent.ownerUserId))
          .orderBy("t.archivedAt", (order) => order.desc().nullsFirst())
          .orderBy(({ fn }) => fn("lower", ["t.name"]))
          .orderBy("t.id")
          .limit(teamKnowledgeLimits.agentTopics)
          .execute();
        const seen = await audience(
          transaction,
          rows.map((row) => row.id),
          room,
        );
        const views: TeamKnowledgeTopicView[] = [];
        for (const row of rows) {
          const can = await access.topic(transaction, actor, row.id);
          views.push(topicView(row, can.write, seen.get(row.id)));
        }
        return { result: { topics: views }, room, actor };
      });
      const ids = result.topics.map((topic) => topic.id);
      const reauthorize = async () =>
        (await caller(database, agent).then(
          () => true,
          () => false,
        )) && (await readableBy(actor, ids)());
      const answer = await handOff(authorizedAt, reauthorize, result);
      await agentAudit(agent, room, "knowledge.topics", "allowed", { count: ids.length });
      return { result: answer, reauthorize };
    });
  }

  /** Keeps whole bodies until the answer reaches its size; later ones become previews. */
  function bounded(notes: readonly TeamNoteRecord[]): { notes: TeamNote[]; truncated: boolean } {
    let bytes = 0;
    let truncated = false;
    const out = notes.map((record) => {
      const full = note(record);
      const size = new TextEncoder().encode(JSON.stringify(full)).byteLength;
      if (!truncated && bytes + size <= teamKnowledgeLimits.agentReadBytes) {
        bytes += size;
        return full;
      }
      truncated = true;
      const body = preview(record.body);
      bytes += size - record.body.length + body.length;
      return { ...full, body };
    });
    return { notes: out, truncated };
  }

  async function readNotes(
    agent: TeamKnowledgeAgent,
    input: TeamKnowledgeReadInput,
  ): Promise<TeamKnowledgeAnswer<TeamKnowledgeReadResult>> {
    const authorizedAt = access.revision;
    return denied(agent, "knowledge.read", async () => {
      const read = await inTransaction(async (transaction) => {
        const { actor, room } = await caller(transaction, agent);
        let records: TeamNoteRecord[];
        let nextBefore: string | null = null;
        if (input.noteId) {
          const current = await readTeamNote(transaction, input.noteId);
          if (!current || !(await access.topic(transaction, actor, current.topicId)).read)
            throw missingNote();
          if (input.history) {
            const before = input.before === undefined ? undefined : Number(input.before);
            if (before !== undefined && (!Number.isSafeInteger(before) || before < 1))
              throw new OpensteerError({
                code: "bad_request",
                message: "That page cursor isn't valid.",
              });
            const page = await teamNoteHistory(transaction, {
              noteId: input.noteId,
              ...(before === undefined ? {} : { before }),
              limit: teamKnowledgeLimits.pageSize,
            });
            records = page.versions;
            const last = page.versions.at(-1);
            nextBefore = page.hasMore && last ? String(last.version) : null;
          } else records = [current];
        } else {
          if (input.topicId && !(await access.topic(transaction, actor, input.topicId)).read)
            throw missingTopic();
          const page = await teamNotesPage(transaction, {
            readerUserId: agent.ownerUserId,
            ...(input.topicId ? { topicId: input.topicId } : {}),
            ...(input.query ? { query: input.query } : {}),
            ...(input.before ? { cursor: input.before } : {}),
            limit: input.query ? teamKnowledgeLimits.searchResults : teamKnowledgeLimits.pageSize,
          });
          records = page.notes;
          nextBefore = page.nextCursor;
        }
        const topicIds = [...new Set(records.map((record) => record.topicId))];
        if (input.topicId && !topicIds.includes(input.topicId)) topicIds.push(input.topicId);
        const seen = await audience(transaction, topicIds, room);
        const views: TeamKnowledgeTopicView[] = [];
        for (const topicId of topicIds) {
          const topic = await readTeamTopic(transaction, topicId);
          if (!topic) continue;
          const can = await access.topic(transaction, actor, topicId);
          views.push(topicView(topic, can.write, seen.get(topicId)));
        }
        const { notes, truncated } = bounded(records);
        return {
          actor,
          room,
          topicIds,
          result: { notes, topics: views, nextBefore, truncated } satisfies TeamKnowledgeReadResult,
        };
      });
      const reauthorize = async () =>
        (await caller(database, agent).then(
          () => true,
          () => false,
        )) && (await readableBy(read.actor, read.topicIds)());
      const answer = await handOff(authorizedAt, reauthorize, read.result);
      await agentAudit(
        agent,
        read.room,
        "knowledge.read",
        "allowed",
        {
          topicIds: read.topicIds.slice(0, 50),
          noteIds: read.result.notes.slice(0, 50).map((record) => record.id),
          count: read.result.notes.length,
          search: input.query !== undefined,
          history: input.history === true,
        },
        input.topicId,
      );
      return { result: answer, reauthorize };
    });
  }

  async function writeAsAgent(
    agent: TeamKnowledgeAgent,
    input: TeamKnowledgeWrite,
  ): Promise<TeamKnowledgeWriteResult> {
    return denied(agent, "knowledge.write", async () => {
      const outcome = await access.knowledgeWrite(async (transaction) => {
        const { actor, room } = await caller(transaction, agent);
        const result = await writeTeamNote(
          transaction,
          noteWrite(input, {
            kind: "agent",
            userId: agent.ownerUserId,
            linkId: agent.linkId,
            ...(agent.requestId ? { requestId: agent.requestId } : {}),
          }),
          (topicId) => authorizeWrite(transaction, actor, topicId),
        );
        return { result, room };
      });
      const { result, room } = outcome;
      await agentAudit(
        agent,
        room,
        "knowledge.write",
        "allowed",
        {
          noteId: input.noteId,
          written: result.written,
          ...(result.written ? { version: result.version } : {}),
          ...(input.delete ? { deleted: true } : {}),
        },
        result.written ? result.topicId : result.current.topicId,
      );
      return result.written
        ? { written: true, noteId: result.noteId, topicId: result.topicId, version: result.version }
        : { written: false, current: note(result.current) };
    });
  }

  async function authorizeWrite(
    transaction: Transaction<DatabaseSchema>,
    actor: TeamActor,
    topicId: KnowledgeTopicId,
  ): Promise<void> {
    const can = await access.topic(transaction, actor, topicId);
    if (!can.read) throw missingTopic();
    if (can.write) return;
    const topic = await readTeamTopic(transaction, topicId);
    throw new OpensteerError({
      code: "forbidden",
      reason: "knowledge-topic-read-only",
      message: topic?.archivedAt
        ? "That topic is archived, so nothing new can be saved in it."
        : "You can read this topic but not write in it.",
      next: "Save it in a topic you can write, or tell the person.",
    });
  }

  // ---- People ------------------------------------------------------------------------

  async function personTopicView(
    transaction: Transaction<DatabaseSchema>,
    actor: TeamActor,
    topic: TeamTopicRecord,
  ): Promise<TeamTopic | undefined> {
    const can = await access.topic(transaction, actor, topic.id);
    if (!can.read && !can.manage) return undefined;
    const [seen, counts] = await Promise.all([
      audience(transaction, [topic.id]),
      teamTopicNoteCounts(transaction, [topic.id]),
    ]);
    return {
      id: topic.id,
      name: topic.name,
      description: topic.description,
      archivedAt: topic.archivedAt?.toISOString() ?? null,
      updatedAt: topic.updatedAt.toISOString(),
      noteCount: can.read ? (counts.get(topic.id) ?? 0) : 0,
      audience: seen.get(topic.id)?.audience ?? { everyone: false, people: 0 },
      can,
    };
  }

  async function visibleTopic(
    transaction: Transaction<DatabaseSchema>,
    actor: TeamActor,
    topicId: KnowledgeTopicId,
  ): Promise<TeamTopic> {
    const topic = await readTeamTopic(transaction, topicId);
    const seen = topic && (await personTopicView(transaction, actor, topic));
    if (!seen) throw missingTopic();
    return seen;
  }

  const stillVisible = (actor: TeamActor, topicIds: readonly KnowledgeTopicId[]) => () =>
    inTransaction(async (transaction) => {
      for (const topicId of new Set(topicIds)) await visibleTopic(transaction, actor, topicId);
      return true;
    });

  async function topicsList(actor: TeamActor, input: Read<"team.knowledge.topics.list">["input"]) {
    const authorizedAt = access.revision;
    const page = await inTransaction(async (transaction) => {
      const seen: TeamTopic[] = [];
      let after = input.after;
      for (;;) {
        const batch = await teamTopicsAfter(transaction, after, teamKnowledgeLimits.pageSize + 1);
        for (const topic of batch) {
          const shown = await personTopicView(transaction, actor, topic);
          if (!shown) continue;
          if (seen.length === teamKnowledgeLimits.pageSize) return { topics: seen, hasMore: true };
          seen.push(shown);
        }
        if (batch.length <= teamKnowledgeLimits.pageSize) return { topics: seen, hasMore: false };
        after = batch.at(-1)?.id;
      }
    });
    return handOff(
      authorizedAt,
      stillVisible(
        actor,
        page.topics.map((topic) => topic.id),
      ),
      page,
    );
  }

  async function read(actor: TeamActor, name: string, input: unknown): Promise<unknown> {
    const person = human(actor);
    if (!isTeamKnowledgeRead(name))
      throw new OpensteerError({ code: "not_found", message: "Unsupported knowledge read" });
    const authorizedAt = access.revision;
    switch (name) {
      case "team.knowledge.topics.list":
        return topicsList(person, teamReadSchemas[name].input.parse(input));
      case "team.knowledge.topic.get": {
        const { topicId } = teamReadSchemas[name].input.parse(input);
        const shown = await inTransaction((transaction) =>
          visibleTopic(transaction, person, topicId),
        );
        return handOff(authorizedAt, stillVisible(person, [topicId]), shown);
      }
      case "team.knowledge.topic.access.get": {
        const { topicId } = teamReadSchemas[name].input.parse(input);
        const shown = await inTransaction(async (transaction) => {
          const topic = await visibleTopic(transaction, person, topicId);
          const entries = await teamTopicGrants(transaction, topicId);
          const record = await readTeamTopic(transaction, topicId);
          return {
            revision: SequenceSchema.parse(record?.accessRevision ?? "0"),
            entries: entries.map((entry) => ({ subject: entry.subject, level: entry.level })),
            can: topic.can,
          } satisfies Read<"team.knowledge.topic.access.get">["output"];
        });
        return handOff(authorizedAt, stillVisible(person, [topicId]), shown);
      }
      case "team.knowledge.notes.page": {
        const parsed = teamReadSchemas[name].input.parse(input);
        const page = await inTransaction(async (transaction) => {
          if (parsed.topicId && !(await access.topic(transaction, person, parsed.topicId)).read)
            throw missingTopic();
          return teamNotesPage(transaction, {
            readerUserId: person.userId,
            ...(parsed.topicId ? { topicId: parsed.topicId } : {}),
            ...(parsed.query ? { query: parsed.query } : {}),
            ...(parsed.cursor ? { cursor: parsed.cursor } : {}),
            limit: teamKnowledgeLimits.pageSize,
          });
        });
        const shown = {
          notes: page.notes.map(notePreview),
          nextCursor: page.nextCursor,
        } satisfies Read<"team.knowledge.notes.page">["output"];
        return handOff(
          authorizedAt,
          readableBy(person, [
            ...(parsed.topicId ? [parsed.topicId] : []),
            ...page.notes.map((record) => record.topicId),
          ]),
          shown,
        );
      }
      case "team.knowledge.note.get":
      case "team.knowledge.note.history": {
        const parsed = teamReadSchemas["team.knowledge.note.history"].input
          .partial({ before: true })
          .parse(input);
        const result = await inTransaction(async (transaction) => {
          const current = await readTeamNote(transaction, parsed.noteId);
          if (!current || !(await access.topic(transaction, person, current.topicId)).read)
            throw missingNote();
          if (name === "team.knowledge.note.get")
            return { topicId: current.topicId, shown: note(current) };
          const page = await teamNoteHistory(transaction, {
            noteId: parsed.noteId,
            ...(parsed.before === undefined ? {} : { before: parsed.before }),
            limit: teamKnowledgeLimits.pageSize,
          });
          return {
            topicId: current.topicId,
            shown: { versions: page.versions.map(note), hasMore: page.hasMore },
          };
        });
        return handOff(authorizedAt, readableBy(person, [result.topicId]), result.shown);
      }
    }
  }

  /** A topic this person may change: they manage it, as owners and admins manage every topic. */
  async function managedTopic(
    transaction: Transaction<DatabaseSchema>,
    actor: TeamActor,
    topicId: KnowledgeTopicId,
  ): Promise<TeamTopicRecord> {
    const topic = await readTeamTopic(transaction, topicId);
    if (!topic) throw missingTopic();
    const can = await access.topic(transaction, actor, topicId);
    if (can.manage) return topic;
    if (!can.read) throw missingTopic();
    throw forbidden("Only this topic's managers can change it.");
  }

  async function command(
    actor: TeamActor,
    command: TeamCommand,
  ): Promise<TeamKnowledgeCommandResult> {
    const person = human(actor);
    if (!isTeamKnowledgeCommand(command))
      throw new OpensteerError({ code: "not_found", message: "Unsupported knowledge command" });
    const { userId } = person;
    const record = (
      transaction: Transaction<DatabaseSchema>,
      topicId: KnowledgeTopicId,
      metadata: Readonly<Record<string, unknown>> = {},
    ) =>
      audit(transaction, {
        actor: person,
        action: command.type,
        resourceKind: "topic",
        resourceId: topicId,
        metadata,
      });
    /** Topic changes run under the access lock, so a note write never races them. */
    const change = (
      topicId: KnowledgeTopicId,
      work: (transaction: Transaction<DatabaseSchema>) => Promise<void>,
    ) =>
      access.mutateAs(person, command.type, async (transaction) => {
        await work(transaction);
        return {
          value: undefined,
          effects: { users: [], channels: [], topics: [topicId], links: [], requests: [] },
        };
      });
    switch (command.type) {
      case "team.knowledge.topic.create":
        await change(command.id, async (transaction) => {
          const existing = await transaction
            .selectFrom("teamTopics")
            .select("createdBy")
            .where("id", "=", command.id)
            .executeTakeFirst();
          if (existing) {
            if (existing.createdBy === userId) return;
            throw conflict("That topic ID is already in use.");
          }
          await createTeamTopic(transaction, {
            id: command.id,
            name: command.name,
            description: command.description,
            createdBy: userId,
            access: command.access.map(grant),
          });
          await record(transaction, command.id);
        });
        return { type: command.type };
      case "team.knowledge.topic.update":
        await change(command.topicId, async (transaction) => {
          await managedTopic(transaction, person, command.topicId);
          await updateTeamTopic(transaction, command.topicId, {
            name: command.name,
            description: command.description,
          });
          await record(transaction, command.topicId);
        });
        return { type: command.type };
      case "team.knowledge.topic.access.set":
        await change(command.topicId, async (transaction) => {
          await managedTopic(transaction, person, command.topicId);
          const changed = await setTeamTopicGrants(transaction, {
            topicId: command.topicId,
            expectedRevision: command.expectedRevision,
            access: command.access.map(grant),
            changedBy: userId,
          });
          if (!changed)
            throw new OpensteerError({
              code: "conflict",
              reason: "knowledge-topic-access-changed",
              message: "This topic's list changed; reload it and try again.",
            });
          await record(transaction, command.topicId, { entries: command.access.length });
        });
        return { type: command.type };
      case "team.knowledge.topic.archive":
      case "team.knowledge.topic.restore":
        await change(command.topicId, async (transaction) => {
          await managedTopic(transaction, person, command.topicId);
          await updateTeamTopic(transaction, command.topicId, {
            archived: command.type === "team.knowledge.topic.archive",
          });
          await record(transaction, command.topicId);
        });
        return { type: command.type };
      case "team.knowledge.note.write":
      case "team.knowledge.note.delete": {
        const result = await access.knowledgeWrite((transaction) =>
          writeTeamNote(
            transaction,
            noteWrite(
              command.type === "team.knowledge.note.write"
                ? {
                    noteId: command.noteId,
                    topicId: command.topicId,
                    expectedVersion: command.expectedVersion,
                    title: command.title,
                    body: command.body,
                  }
                : {
                    noteId: command.noteId,
                    expectedVersion: command.expectedVersion,
                    delete: true,
                  },
              { kind: "human", userId },
            ),
            (topicId) => authorizeWrite(transaction, person, topicId),
          ),
        );
        if (!result.written)
          throw new OpensteerError({
            code: "conflict",
            reason: "knowledge-note-changed",
            message: `${result.current.writer.name} changed this note while you were editing it.`,
          });
        return { type: command.type, noteId: result.noteId, version: result.version };
      }
    }
  }

  return {
    topics: (agent) => topics(agent).catch(failure),
    readNotes: (agent, input) => readNotes(agent, input).catch(failure),
    write: (agent, input) => writeAsAgent(agent, input).catch(failure),
    read,
    command,
  };
}

function noteWrite(
  input: TeamKnowledgeWrite | Omit<TeamKnowledgeWrite, "topicId">,
  writer: TeamNoteWrite["writer"],
): TeamNoteWrite {
  return {
    noteId: input.noteId,
    ...("topicId" in input && input.topicId ? { topicId: input.topicId } : {}),
    expectedVersion: input.expectedVersion,
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(input.delete ? { delete: true as const } : {}),
    writer,
  };
}

function preview(body: string): string {
  return markdownPreview(body, teamKnowledgeLimits.previewChars);
}

function note(record: TeamNoteRecord): TeamNote {
  return {
    id: record.id,
    topicId: record.topicId,
    version: record.version,
    title: record.title,
    body: record.body,
    deleted: record.deleted,
    writtenAt: record.writtenAt.toISOString(),
    writer: record.writer,
    source: record.source,
  };
}

function notePreview(record: TeamNoteRecord): TeamNotePreview {
  const { body: _body, deleted: _deleted, ...rest } = note(record);
  return { ...rest, preview: preview(record.body) };
}

function human(actor: TeamActor): TeamActor & { readonly kind: "human" } {
  if (actor.kind !== "human")
    throw new OpensteerError({ code: "forbidden", message: "Only people use this." });
  return actor;
}

function grant(entry: {
  readonly subject: TeamTopicGrant["subject"];
  readonly level: TeamTopicGrant["level"];
}): TeamTopicGrant {
  return { subject: entry.subject, level: entry.level };
}

function missingTopic(): OpensteerError {
  return new OpensteerError({
    code: "not_found",
    reason: "knowledge-topic-not-found",
    message: "That topic doesn't exist or you can't read it.",
    next: "List the topics you can use and pick one of those.",
  });
}

function missingNote(): OpensteerError {
  return new OpensteerError({
    code: "not_found",
    reason: "knowledge-note-not-found",
    message: "That note doesn't exist or you can't read it.",
    next: "Search the topics you can read for it.",
  });
}

function forbidden(message: string): OpensteerError {
  return new OpensteerError({ code: "forbidden", message });
}

function conflict(message: string): OpensteerError {
  return new OpensteerError({ code: "conflict", message });
}

/** Agent calls fail with the team's own words, which the link carries to the agent. */
function failure(error: unknown): never {
  if (error instanceof OpensteerError) throw new TeamKnowledgeFailure(error);
  throw error;
}

/** A refusal whose message and next step are written for the agent and safe to pass on. */
export class TeamKnowledgeFailure extends OpensteerError {
  constructor(error: OpensteerError) {
    super({
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.next === undefined ? {} : { next: error.next }),
      ...(error.reason === undefined ? {} : { reason: error.reason }),
    });
  }
}
