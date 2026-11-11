import {
  OpensteerError,
  type KnowledgeTopicId,
  type TeamActor,
  type TeamAgentRequestId,
  type TeamChannelId,
  type TeamLinkId,
  type UserId,
} from "@opensteer/core";
import {
  attachTeamTopic,
  createKnowledgeExecutorPool,
  createSharedTeamTopic,
  detachTeamTopic,
  liveTeamKnowledgeRequest,
  readTeamTopic,
  runKnowledgeStatement,
  setTeamTopicGrants,
  teamChannelScopeTopics,
  teamFactsPage,
  teamKnowledgeCaller,
  teamTopicGrants,
  teamTopicsAfter,
  updateTeamTopic,
  type DatabaseSchema,
  type KnowledgeExecutorCredentials,
  type KnowledgeJson,
  type KnowledgeRows,
  type KnowledgeStatement,
  type KnowledgeWriter,
  type TeamFactRecord,
  type TeamTopicGrant,
  type TeamTopicRecord,
} from "@opensteer/database";
import {
  teamKnowledgeLimits,
  teamReadSchemas,
  type TeamCommandSchema,
  type TeamFact,
  type TeamSqlInput,
  type TeamSqlResult,
  type TeamTopic,
} from "@opensteer/protocol";
import type { Kysely, Transaction } from "kysely";
import { createHash } from "node:crypto";
import type { z } from "zod";
import type {
  TeamAccessEffects,
  TeamAccessLockPort,
  TeamAccessResolver,
  TeamTopicAuthority,
} from "../team/access-port.js";
import { admitKnowledgeSql } from "./sql-gate.js";

type TeamCommand = z.infer<typeof TeamCommandSchema>;
const knowledgeCommands = new Set([
  "team.knowledge.topic.create",
  "team.knowledge.topic.rename",
  "team.knowledge.topic.access.set",
  "team.knowledge.topic.peopleOnly.set",
  "team.knowledge.fact.append",
  "team.knowledge.topic.archive",
  "team.knowledge.topic.restore",
  "team.channel.topic.attach",
  "team.channel.topic.detach",
] as const);
export type TeamKnowledgeCommand = Extract<
  TeamCommand,
  { type: typeof knowledgeCommands extends Set<infer Type> ? Type : never }
>;
export type TeamKnowledgeReadName =
  | "team.knowledge.topics.list"
  | "team.knowledge.topic.get"
  | "team.knowledge.topic.access.get"
  | "team.knowledge.facts.page"
  | "team.knowledge.history.page";
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
/** The team audit log's writer; entries hold IDs, counts and fingerprints, never SQL text or values. */
export type TeamKnowledgeAudit = (
  executor: Kysely<DatabaseSchema>,
  entry: {
    readonly actor: TeamActor;
    readonly action: string;
    readonly resourceKind: "topic" | "channel";
    readonly resourceId?: string | undefined;
    readonly channelId?: TeamChannelId | undefined;
    readonly linkId?: TeamLinkId | undefined;
    readonly requestId?: TeamAgentRequestId | undefined;
    readonly outcome?: "allowed" | "denied";
    readonly metadata?: Readonly<Record<string, unknown>>;
  },
) => Promise<unknown>;

/**
 * A buffered answer and the check of the whole scope that produced it, for the link's
 * final handoff: true only while every topic it read or wrote is still readable.
 */
export interface TeamKnowledgeSqlAnswer {
  readonly result: TeamSqlResult;
  readonly reauthorize: () => Promise<boolean>;
}

export interface TeamKnowledgeSqlCall {
  /** The link the call arrived on, already authenticated. */
  readonly linkId: TeamLinkId;
  readonly requestId: TeamAgentRequestId;
  readonly input: TeamSqlInput;
}

export interface TeamKnowledge {
  /** An agent's `sql` call, scoped to the ticket's channel topic and attached topics. */
  sql(call: TeamKnowledgeSqlCall): Promise<TeamKnowledgeSqlAnswer>;
  /** A person's knowledge read; the output matches `teamReadSchemas[name].output`. */
  read(actor: TeamActor, name: string, input: unknown): Promise<unknown>;
  command(actor: TeamActor, command: TeamCommand): Promise<{ readonly type: TeamCommand["type"] }>;
  close(): Promise<void>;
}

const pageSize = 50;
const relationNames = ["facts", "fact_history"] as const;
const insertable = ["topic", "thing", "property", "value", "seen_fact_id"];

/**
 * Serves team knowledge over the restricted login's two connections; prepare the schema
 * and login first with `prepareKnowledgeExecutor`. Who may read or write which topic is
 * resolved freshly for every call, and topic names in SQL are never grants. Writes commit
 * inside the access fence; every buffered answer is handed off only while its authority holds.
 */
export async function startTeamKnowledge(options: {
  readonly database: Kysely<DatabaseSchema>;
  readonly databaseUrl: string;
  readonly credentials: KnowledgeExecutorCredentials;
  readonly access: TeamKnowledgeAccess;
  readonly audit: TeamKnowledgeAudit;
  readonly statementTimeoutMs?: number;
}): Promise<TeamKnowledge> {
  const { database, access, audit } = options;
  // Loads the parser now, so a Host that cannot is refused at start rather than at an agent's first call.
  await admitKnowledgeSql({ text: "SELECT 1", parameters: [] });
  const pool = createKnowledgeExecutorPool(options.databaseUrl, options.credentials);
  try {
    (await pool.connect()).release();
  } catch (error) {
    await pool.end();
    throw error;
  }
  const timeout =
    options.statementTimeoutMs === undefined
      ? {}
      : { statementTimeoutMs: options.statementTimeoutMs };
  const inTransaction = <Value>(
    work: (transaction: Transaction<DatabaseSchema>) => Promise<Value>,
  ) => database.transaction().execute(work);

  let relations: Promise<NonNullable<TeamSqlResult["relations"]>> | undefined;
  const describe = (writer: KnowledgeWriter) =>
    (relations ??= Promise.all(
      relationNames.map(async (name) => {
        const result = await runKnowledgeStatement(pool, {
          statement: {
            kind: "select",
            text: `select * from knowledge.${name} where false`,
            parameters: [],
          },
          readTopicIds: [],
          writeTopicIds: [],
          writer,
        });
        if (result.kind !== "select") throw new Error("Discovery returned a write");
        return {
          name,
          columns: [...result.columns],
          insertable: name === "facts" ? insertable : [],
        };
      }),
    ).catch((error: unknown) => {
      relations = undefined;
      throw error;
    }));

  /** The ticket's scope now: its channel's topic plus attached topics this owner's agent may use. */
  async function agentScope(
    transaction: Transaction<DatabaseSchema>,
    linkId: TeamLinkId,
    requestId: TeamAgentRequestId,
  ) {
    const request = await liveTeamKnowledgeRequest(transaction, linkId, requestId);
    if (!request) throw unavailable();
    const actor: TeamActor = { kind: "agent", userId: request.ownerUserId };
    const channel = await access.channel(transaction, actor, request.channelId);
    if (!channel.read || channel.peopleOnly) throw unavailable();
    const read: KnowledgeTopicId[] = [];
    const write: KnowledgeTopicId[] = [];
    const listed: { id: KnowledgeTopicId; name: string }[] = [];
    for (const topic of await teamChannelScopeTopics(transaction, request.channelId)) {
      const can = await access.topic(transaction, actor, topic.id);
      if (!can.read || can.peopleOnly) continue;
      read.push(topic.id);
      if (topic.archivedAt === null) listed.push({ id: topic.id, name: topic.name });
      if (can.write && topic.archivedAt === null) write.push(topic.id);
    }
    const writer: KnowledgeWriter = { kind: "agent", id: request.ownerUserId, requestId };
    return { request, actor, writer, read, write, listed };
  }

  /** Hands `answer` over only if its authority still holds; on loss, nothing at all. */
  async function handOff<Value>(
    authorizedAt: typeof access.revision,
    stillReadable: () => Promise<boolean>,
    answer: Value,
    lostMessage: string,
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
        message: lostMessage,
      });
    }
  }

  /** The access fence for a write: a refusal before the write ran means the topic can't be written now. */
  async function fenced<Value>(
    actor: TeamActor,
    topicId: KnowledgeTopicId,
    write: (transaction: Transaction<DatabaseSchema>) => Promise<Value>,
  ): Promise<Value> {
    let entered = false;
    try {
      return await access.knowledgeWrite(actor, topicId, (transaction) => {
        entered = true;
        return write(transaction);
      });
    } catch (error) {
      if (!entered && error instanceof OpensteerError && error.code === "forbidden")
        throw notWritable();
      throw error;
    }
  }

  async function sql(call: TeamKnowledgeSqlCall): Promise<TeamKnowledgeSqlAnswer> {
    const { linkId, requestId, input } = call;
    const authorizedAt = access.revision;
    let scope: Awaited<ReturnType<typeof agentScope>>;
    try {
      scope = await inTransaction((transaction) => agentScope(transaction, linkId, requestId));
    } catch (error) {
      const caller = await teamKnowledgeCaller(database, linkId, requestId);
      if (caller)
        await audit(database, {
          actor: { kind: "agent", userId: caller.ownerUserId },
          linkId,
          requestId: caller.requestId ?? undefined,
          channelId: caller.channelId ?? undefined,
          action: "knowledge.sql",
          resourceKind: "topic",
          outcome: "denied",
          metadata: { kind: input.sql === undefined ? "discover" : "statement" },
        });
      throw error;
    }
    const allowed = (
      executor: Kysely<DatabaseSchema>,
      metadata: Readonly<Record<string, unknown>>,
    ) =>
      audit(executor, {
        actor: scope.actor,
        linkId,
        requestId,
        channelId: scope.request.channelId,
        action: "knowledge.sql",
        resourceKind: "topic",
        metadata,
      });
    const covers = (topics: readonly KnowledgeTopicId[]) => async () => {
      const fresh = await inTransaction((transaction) =>
        agentScope(transaction, linkId, requestId),
      ).catch(() => undefined);
      const readable = new Set(fresh?.read);
      return fresh !== undefined && topics.every((topic) => readable.has(topic));
    };
    const answer = async (
      result: TeamSqlResult,
      topics: readonly KnowledgeTopicId[],
      lostMessage = unseenMessage,
    ): Promise<TeamKnowledgeSqlAnswer> => {
      const reauthorize = covers(topics);
      return { result: await handOff(authorizedAt, reauthorize, result, lostMessage), reauthorize };
    };

    if (input.sql === undefined) {
      if (
        input.mode === "write" ||
        input.parameters.length > 0 ||
        input.onlyIfUnchanged !== undefined ||
        input.operationId !== undefined
      )
        throw refusal(
          "Send sql with mode, parameters, onlyIfUnchanged or operationId.",
          "sql without a statement only describes facts and topics.",
        );
      const start =
        input.cursor === undefined
          ? 0
          : scope.listed.findIndex((topic) => topic.id === input.cursor) + 1;
      if (start === 0 && input.cursor !== undefined)
        throw refusal("That cursor is no longer valid.", "Call sql without a statement or cursor.");
      const page = scope.listed.slice(start, start + pageSize);
      const last = page.at(-1);
      const discovered = bounded({
        relations: await describe(scope.writer),
        topics: page,
        ...(last && start + pageSize < scope.listed.length ? { nextCursor: last.id } : {}),
      });
      await allowed(database, { kind: "discover", topics: page.map((topic) => topic.id) });
      return answer(
        discovered,
        page.map((topic) => topic.id),
      );
    }
    if (input.cursor !== undefined)
      throw refusal("cursor pages topics; send it without a statement.");
    const parameters = input.parameters as KnowledgeJson[];
    const admitted = await admitKnowledgeSql({ text: input.sql, parameters });
    const fingerprint = createHash("sha256").update(input.sql).digest("hex");
    if (admitted.kind === "select") {
      if (input.onlyIfUnchanged !== undefined)
        throw refusal("onlyIfUnchanged applies only to an INSERT.");
      const result = await runKnowledgeStatement(pool, {
        statement: { kind: "select", text: admitted.text, parameters },
        readTopicIds: scope.read,
        writeTopicIds: [],
        writer: scope.writer,
        ...timeout,
      });
      if (result.kind !== "select") throw new Error("A SELECT returned a write");
      const selected = bounded(rows(result));
      await allowed(database, {
        kind: "select",
        fingerprint,
        topics: scope.read,
        rows: result.rows.length,
      });
      return answer(selected, scope.read);
    }
    if (input.mode !== "write") throw refusal('INSERT needs mode "write". Nothing was saved.');
    if (input.operationId === undefined)
      throw refusal(
        "A write needs operationId: a new UUID, reused only to retry this same write. Nothing was saved.",
      );
    const statement: KnowledgeStatement = {
      kind: "insert",
      text: admitted.text,
      parameters,
      operationKey: operationId("agent", requestId, input.operationId),
      onlyIfUnchanged: input.onlyIfUnchanged === true,
      suppliesBaseline: admitted.suppliesBaseline,
      keys: admitted.keys,
    };
    const topics = admitted.topicIds as KnowledgeTopicId[];
    if (!topics.every((topic) => scope.write.includes(topic))) throw notWritable();
    const result = await fenced(scope.actor, topics[0]!, async (transaction) => {
      const fresh = await agentScope(transaction, linkId, requestId);
      if (!topics.every((topic) => fresh.write.includes(topic))) throw notWritable();
      const written = await runKnowledgeStatement(pool, {
        statement,
        readTopicIds: fresh.read,
        writeTopicIds: fresh.write,
        writer: fresh.writer,
        ...timeout,
      });
      if (written.kind !== "insert") throw new Error("An INSERT returned rows only");
      await allowed(transaction, {
        kind: "insert",
        fingerprint,
        topics,
        rows: written.receipt.facts.length,
        replayed: written.replayed,
      });
      return written;
    });
    const receipt = bounded({
      receipt: {
        committed: true,
        replayed: result.replayed,
        // The engine's receipt, whose IDs the wire schema brands.
        facts: result.receipt.facts as NonNullable<TeamSqlResult["receipt"]>["facts"],
      },
      ...(result.returning ? rows(result.returning) : {}),
    });
    return answer(receipt, topics, `${unseenMessage} The write was saved; don't repeat it.`);
  }

  /** What a person sees of a topic: its readers and managers (admins manage shared topics) see it. */
  async function view(
    transaction: Transaction<DatabaseSchema>,
    actor: TeamActor,
    topic: TeamTopicRecord,
  ): Promise<TeamTopic | undefined> {
    const can = await access.topic(transaction, actor, topic.id);
    if (!can.read && !can.manage) return undefined;
    return {
      id: topic.id,
      name: topic.name,
      originChannelId: topic.originChannelId,
      peopleOnly: can.peopleOnly,
      archivedAt: topic.archivedAt?.toISOString() ?? null,
      updatedAt: topic.updatedAt.toISOString(),
      can: { read: can.read, write: can.write, manage: can.manage },
    };
  }

  async function visibleTopic(
    transaction: Transaction<DatabaseSchema>,
    actor: TeamActor,
    topicId: KnowledgeTopicId,
  ): Promise<TeamTopic> {
    const topic = await readTeamTopic(transaction, topicId);
    const seen = topic && (await view(transaction, actor, topic));
    if (!seen) throw missingTopic();
    return seen;
  }

  const stillVisible = (actor: TeamActor, topicIds: readonly KnowledgeTopicId[]) => () =>
    inTransaction(async (transaction) => {
      for (const topicId of topicIds) await visibleTopic(transaction, actor, topicId);
      return true;
    });
  const changedMessage = "Your access to this topic changed.";

  async function topicsList(actor: TeamActor, input: Read<"team.knowledge.topics.list">["input"]) {
    const authorizedAt = access.revision;
    const page = await inTransaction(async (transaction) => {
      if (input.channelId) {
        const channel = await access.channel(transaction, actor, input.channelId);
        if (!channel.read)
          throw new OpensteerError({
            code: "not_found",
            reason: "team-channel-not-found",
            message: "That channel doesn't exist or you can't read it.",
          });
        const all = await teamChannelScopeTopics(transaction, input.channelId);
        const start = input.after ? all.findIndex((topic) => topic.id === input.after) + 1 : 0;
        const seen: TeamTopic[] = [];
        for (const topic of all.slice(start)) {
          const shown = await view(transaction, actor, topic);
          if (shown?.can.read) seen.push(shown);
        }
        return { topics: seen.slice(0, pageSize), hasMore: seen.length > pageSize };
      }
      const seen: TeamTopic[] = [];
      let after = input.after;
      for (;;) {
        const batch = await teamTopicsAfter(transaction, after, pageSize * 2);
        for (const topic of batch) {
          const shown = await view(transaction, actor, topic);
          if (shown) seen.push(shown);
          if (seen.length > pageSize) return { topics: seen.slice(0, pageSize), hasMore: true };
        }
        if (batch.length < pageSize * 2) return { topics: seen, hasMore: false };
        after = batch.at(-1)!.id;
      }
    });
    return handOff(
      authorizedAt,
      stillVisible(
        actor,
        page.topics.map((topic) => topic.id),
      ),
      page,
      "Your access to these topics changed.",
    );
  }

  async function topicAccess(
    actor: TeamActor,
    input: Read<"team.knowledge.topic.access.get">["input"],
  ): Promise<Read<"team.knowledge.topic.access.get">["output"]> {
    const authorizedAt = access.revision;
    const answer = await inTransaction(async (transaction) => {
      const shown = await visibleTopic(transaction, actor, input.topicId);
      const topic = await readTeamTopic(transaction, input.topicId);
      if (!topic || topic.originChannelId !== null)
        throw new OpensteerError({
          code: "bad_request",
          reason: "team-topic-follows-channel",
          message: "A channel's topic has the channel's access.",
        });
      return {
        revision:
          topic.accessRevision as Read<"team.knowledge.topic.access.get">["output"]["revision"],
        entries: await teamTopicGrants(transaction, input.topicId),
        can: shown.can,
      };
    });
    return handOff(authorizedAt, stillVisible(actor, [input.topicId]), answer, changedMessage);
  }

  async function factPage(
    actor: TeamActor,
    input: { readonly topicId: KnowledgeTopicId; readonly before?: string | undefined },
    current: boolean,
  ) {
    const authorizedAt = access.revision;
    const readable = () =>
      inTransaction(
        async (transaction) => (await access.topic(transaction, actor, input.topicId)).read,
      );
    if (!(await readable())) throw missingTopic();
    const page = await teamFactsPage(database, {
      topicId: input.topicId,
      before: input.before,
      current,
      limit: pageSize,
    });
    return handOff(
      authorizedAt,
      readable,
      { facts: page.facts.map(fact), hasMore: page.hasMore },
      changedMessage,
    );
  }

  async function read(actor: TeamActor, name: string, input: unknown): Promise<unknown> {
    const person = human(actor);
    switch (name) {
      case "team.knowledge.topics.list":
        return topicsList(person, teamReadSchemas[name].input.parse(input));
      case "team.knowledge.topic.get": {
        const { topicId } = teamReadSchemas[name].input.parse(input);
        const authorizedAt = access.revision;
        const shown = await inTransaction((transaction) =>
          visibleTopic(transaction, person, topicId),
        );
        return handOff(authorizedAt, stillVisible(person, [topicId]), shown, changedMessage);
      }
      case "team.knowledge.topic.access.get":
        return topicAccess(person, teamReadSchemas[name].input.parse(input));
      case "team.knowledge.facts.page":
        return factPage(person, teamReadSchemas[name].input.parse(input), true);
      case "team.knowledge.history.page":
        return factPage(person, teamReadSchemas[name].input.parse(input), false);
      default:
        throw new OpensteerError({ code: "not_found", message: "Unsupported knowledge read" });
    }
  }

  /** A shared topic this person may change: they manage it (admins manage every shared topic). */
  async function managedSharedTopic(
    transaction: Transaction<DatabaseSchema>,
    actor: TeamActor,
    topicId: KnowledgeTopicId,
    channelTopics: "refuse" | "allow" = "refuse",
  ): Promise<{ readonly topic: TeamTopicRecord; readonly can: TeamTopicAuthority }> {
    const topic = await readTeamTopic(transaction, topicId);
    if (!topic) throw missingTopic();
    const can = await access.topic(transaction, actor, topicId);
    if (!can.manage) {
      if (!can.read) throw missingTopic();
      throw forbidden("Only this topic's managers can change it.");
    }
    if (topic.originChannelId !== null && channelTopics === "refuse")
      throw new OpensteerError({
        code: "bad_request",
        reason: "team-topic-follows-channel",
        message: "A channel's topic follows its channel; change the channel instead.",
      });
    return { topic, can };
  }

  async function command(actor: TeamActor, command: TeamCommand) {
    const person = human(actor);
    if (!isKnowledgeCommand(command))
      throw new OpensteerError({ code: "not_found", message: "Unsupported knowledge command" });
    const { userId } = person;
    const record = (
      transaction: Transaction<DatabaseSchema>,
      topicId: KnowledgeTopicId,
      metadata: Readonly<Record<string, unknown>> = {},
      channelId?: TeamChannelId,
    ) =>
      audit(transaction, {
        actor: person,
        action: command.type,
        resourceKind: "topic",
        resourceId: topicId,
        channelId,
        metadata,
      });
    /** Changes that move what someone may read run as that person under the access lock. */
    const change = (
      topics: readonly KnowledgeTopicId[],
      channels: readonly TeamChannelId[],
      work: (transaction: Transaction<DatabaseSchema>) => Promise<void>,
    ) =>
      access.mutateAs(person, command.type, async (transaction) => {
        await work(transaction);
        return {
          value: undefined,
          effects: {
            users: [],
            channels: [...channels],
            topics: [...topics],
            links: [],
            requests: [],
          },
        };
      });
    switch (command.type) {
      case "team.knowledge.topic.create":
        await change([command.id], [], async (transaction) => {
          const existing = await transaction
            .selectFrom("knowledge.topics")
            .select(["createdBy", "originChannelId"])
            .where("id", "=", command.id)
            .executeTakeFirst();
          if (existing) {
            if (existing.createdBy === userId && existing.originChannelId === null) return;
            throw conflict("That topic ID is already in use.");
          }
          if (!(await isActiveMember(transaction, userId)))
            throw forbidden("Only team members can create topics.");
          await createSharedTeamTopic(transaction, {
            id: command.id,
            name: command.name,
            peopleOnly: command.peopleOnly,
            createdBy: userId,
            access: command.access.map(grant),
          });
          await record(transaction, command.id);
        });
        break;
      case "team.knowledge.topic.access.set":
        await change([command.topicId], [], async (transaction) => {
          await managedSharedTopic(transaction, person, command.topicId);
          const changed = await setTeamTopicGrants(transaction, {
            topicId: command.topicId,
            expectedRevision: command.expectedRevision,
            access: command.access.map(grant),
            changedBy: userId,
          });
          if (!changed) throw conflict("This topic's list changed; reload it and try again.");
          await record(transaction, command.topicId, { entries: command.access.length });
        });
        break;
      case "team.knowledge.topic.peopleOnly.set":
        await change([command.topicId], [], async (transaction) => {
          await managedSharedTopic(transaction, person, command.topicId, "allow");
          await updateTeamTopic(transaction, command.topicId, { peopleOnly: command.peopleOnly });
          await record(transaction, command.topicId, { peopleOnly: command.peopleOnly });
        });
        break;
      case "team.channel.topic.attach":
      case "team.channel.topic.detach":
        await change([command.topicId], [command.channelId], async (transaction) => {
          const channel = await access.channel(transaction, person, command.channelId);
          if (!channel.manage)
            throw forbidden("Only this channel's managers can change its topics.");
          if (command.type === "team.channel.topic.detach") {
            await detachTeamTopic(transaction, command.channelId, command.topicId);
          } else {
            if (!(await access.topic(transaction, person, command.topicId)).read)
              throw missingTopic();
            if (
              !(await attachTeamTopic(transaction, {
                channelId: command.channelId,
                topicId: command.topicId,
                attachedBy: userId,
              }))
            )
              throw new OpensteerError({
                code: "bad_request",
                reason: "team-topic-follows-channel",
                message: "Only shared topics can be attached to a channel.",
              });
          }
          await record(transaction, command.topicId, {}, command.channelId);
        });
        break;
      case "team.knowledge.topic.rename":
      case "team.knowledge.topic.archive":
      case "team.knowledge.topic.restore":
        await inTransaction(async (transaction) => {
          await managedSharedTopic(transaction, person, command.topicId);
          await updateTeamTopic(
            transaction,
            command.topicId,
            command.type === "team.knowledge.topic.rename"
              ? { name: command.name }
              : { archived: command.type === "team.knowledge.topic.archive" },
          );
          await record(transaction, command.topicId);
        });
        break;
      case "team.knowledge.fact.append":
        await appendFacts(person, command);
        break;
    }
    return { type: command.type };
  }

  async function appendFacts(
    actor: TeamActor,
    command: Extract<TeamKnowledgeCommand, { type: "team.knowledge.fact.append" }>,
  ): Promise<void> {
    const topics = [...new Set(command.facts.map((fact) => fact.topicId))].sort();
    const statement: KnowledgeStatement = {
      kind: "insert",
      text: `insert into facts (topic, thing, property, value, seen_fact_id) values ${command.facts
        .map((_, row) => {
          const at = row * 5;
          return `($${at + 1}, $${at + 2}, $${at + 3}, $${at + 4}::jsonb, $${at + 5}::bigint)`;
        })
        .join(", ")}`,
      parameters: command.facts.flatMap((fact) => [
        fact.topicId,
        fact.thing,
        fact.property,
        JSON.stringify(fact.value),
        fact.replacesId,
      ]),
      operationKey: operationId("human", actor.userId, command.operationId),
      onlyIfUnchanged: true,
      suppliesBaseline: true,
      keys: command.facts.map((fact) => ({
        topic: fact.topicId,
        thing: fact.thing,
        property: fact.property,
      })),
    };
    await fenced(actor, topics[0]!, async (transaction) => {
      for (const topicId of topics)
        if (!(await access.topic(transaction, actor, topicId)).write) throw notWritable();
      const written = await runKnowledgeStatement(pool, {
        statement,
        readTopicIds: topics,
        writeTopicIds: topics,
        writer: { kind: "human", id: actor.userId, requestId: null },
        ...timeout,
      });
      if (written.kind !== "insert") throw new Error("An INSERT returned rows only");
      for (const topicId of topics)
        await audit(transaction, {
          actor,
          action: command.type,
          resourceKind: "topic",
          resourceId: topicId,
          metadata: { rows: written.receipt.facts.length, replayed: written.replayed },
        });
    });
  }

  return {
    async sql(call) {
      try {
        return await sql(call);
      } catch (error) {
        throw failure(error);
      }
    },
    read,
    command,
    async close() {
      await pool.end();
    },
  };
}

function human(actor: TeamActor): TeamActor & { readonly kind: "human" } {
  if (actor.kind !== "human")
    throw new OpensteerError({ code: "forbidden", message: "Only people use this." });
  return actor;
}

function isKnowledgeCommand(command: TeamCommand): command is TeamKnowledgeCommand {
  return (knowledgeCommands as ReadonlySet<string>).has(command.type);
}

async function isActiveMember(
  transaction: Transaction<DatabaseSchema>,
  userId: UserId,
): Promise<boolean> {
  return Boolean(
    await transaction
      .selectFrom("teamMembers")
      .select("userId")
      .where("userId", "=", userId)
      .where("state", "=", "active")
      .executeTakeFirst(),
  );
}

function grant(entry: {
  readonly subject: TeamTopicGrant["subject"];
  readonly level: TeamTopicGrant["level"];
}): TeamTopicGrant {
  return { subject: entry.subject, level: entry.level };
}

function fact(record: TeamFactRecord): TeamFact {
  return {
    id: record.id as TeamFact["id"],
    topicId: record.topicId,
    thing: record.thing,
    property: record.property,
    value: record.value as TeamFact["value"],
    replacesId: record.replacesId as TeamFact["replacesId"],
    writerUserId: record.writerUserId,
    writerKind: record.writerKind,
    writtenAt: record.writtenAt.toISOString(),
    source: record.source,
  };
}

/** Operation keys are scoped to the request or person that sent them, and opaque to readers. */
function operationId(kind: "agent" | "human", scope: string, key: string): string {
  return createHash("sha256")
    .update(JSON.stringify([kind, scope, key]))
    .digest("hex");
}

function rows(result: KnowledgeRows) {
  return {
    columns: [...result.columns],
    rows: result.rows as TeamSqlResult["rows"],
    truncated: result.truncated,
  };
}

function bounded(output: TeamSqlResult): TeamSqlResult {
  if (encodedBytes(output) <= teamKnowledgeLimits.sqlResultBytes) return output;
  throw new OpensteerError({
    code: "resource_exhausted",
    reason: "knowledge-result-too-large",
    message: `The result is over 512 KB${output.receipt ? ", though the write was saved" : ""}.`,
    next: output.receipt
      ? "Read facts to see what was saved; don't repeat the INSERT."
      : "Select fewer columns or rows, or aggregate, and call sql again.",
  });
}

/** A value nested too deeply to encode counts as too large: the agent can select less of it. */
function encodedBytes(output: TeamSqlResult): number {
  try {
    return Buffer.byteLength(JSON.stringify(output), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

const unseenMessage = "Access to this knowledge changed while answering, so nothing was returned.";

function unavailable(): OpensteerError {
  return new OpensteerError({
    code: "forbidden",
    reason: "knowledge-request-unavailable",
    message: "This request can no longer use team knowledge.",
  });
}

function notWritable(): OpensteerError {
  return new OpensteerError({
    code: "forbidden",
    reason: "knowledge-topic-not-writable",
    message: "That topic doesn't exist or can't be written. No facts were saved.",
  });
}

function missingTopic(): OpensteerError {
  return new OpensteerError({
    code: "not_found",
    reason: "team-topic-not-found",
    message: "That topic doesn't exist or you can't see it.",
  });
}

function forbidden(message: string): OpensteerError {
  return new OpensteerError({ code: "forbidden", reason: "team-topic-not-permitted", message });
}

function conflict(message: string): OpensteerError {
  return new OpensteerError({ code: "conflict", reason: "team-topic-conflict", message });
}

function refusal(message: string, next?: string): OpensteerError {
  return new OpensteerError({
    code: "bad_request",
    reason: "knowledge-bad-call",
    message,
    ...(next ? { next } : {}),
  });
}

const gateReasons = new Set([
  "too-large",
  "syntax",
  "statement",
  "relation",
  "function",
  "operator",
  "type",
  "form",
  "insert",
  "parameter",
]);

/** Every failure leaves here as a sentence written for the agent; nothing from PostgreSQL or the statement. */
function failure(error: unknown): OpensteerError {
  if (!(error instanceof OpensteerError))
    return new OpensteerError({
      code: "internal",
      reason: "knowledge-failed",
      message: "The knowledge statement failed.",
      next: "Call sql again once; if it fails again, tell the person knowledge failed.",
    });
  if (error.next !== undefined) return error;
  const again = (
    next: string,
    overrides: { code?: OpensteerError["code"]; message?: string } = {},
  ) =>
    new OpensteerError({
      code: overrides.code ?? error.code,
      message: overrides.message ?? error.message,
      next,
      retryable: error.retryable,
      ...(error.reason === undefined ? {} : { reason: error.reason }),
    });
  if (error.reason !== undefined && gateReasons.has(error.reason))
    return again(
      "Rewrite the statement and call sql again; call sql without query for the columns.",
    );
  switch (error.reason) {
    case "knowledge-request-unavailable":
    case "knowledge-access-changed":
      return again("Don't call sql again for this request; answer from what you already have.");
    case "knowledge-fact-changed": {
      const current = error.details?.currentFactId;
      return again(
        "Read facts again, then decide whether to write with the new id as seen_fact_id.",
        {
          message: `A fact changed since it was read${typeof current === "string" ? `; its current id is ${current}` : current === null ? "; it no longer has a value" : ""}. No facts were saved.`,
        },
      );
    }
    case "knowledge-commit-uncertain":
      return again(
        "Read facts to check whether it was saved before writing again; never repeat the INSERT blindly.",
        { code: "conflict" },
      );
    case "knowledge-statement-timeout":
    case "knowledge-resource-limit":
    case "knowledge-row-too-large":
    case "knowledge-message-too-large":
    case "knowledge-result-too-large":
      return again(
        "Filter by topic and key, select fewer or smaller columns, or aggregate, and call sql again.",
      );
    case "knowledge-topic-not-writable":
      return again("Call sql without query for the topics you can use.");
    case "knowledge-invalid-value":
      return again(
        "Compare text to text, cast text only where every row holds that type (filter by topic and property first), pass values as parameters, and call sql again.",
      );
    case "knowledge-invalid-statement":
      return again(
        "Call sql without query for the columns of facts and fact_history, rewrite the statement, and call sql again.",
      );
    case "knowledge-invalid-fact":
      return again(
        "Give a topic id from sql without query, a thing up to 256 bytes, a property up to 128 bytes and a JSON value, and call sql again.",
      );
    case "knowledge-value-too-large":
      return again("Split the value across properties of under 64 KB each and call sql again.");
    case "knowledge-value-too-deep":
      return again(
        "Nest the value at most 64 arrays and objects deep, or split it across properties, and call sql again.",
      );
    case "knowledge-too-many-facts":
      return again("Split the write into INSERTs of at most 25 rows and call sql once for each.");
    case "knowledge-seen-fact-mismatch":
      return again(
        "Read facts for the same topic, thing and property, and call sql again with its id as seen_fact_id.",
      );
    case "knowledge-operation-key-reused":
      return again(
        "Read facts to see what that earlier write saved before you call sql to write again.",
      );
    case "knowledge-busy":
      return again("Call sql again with the same statement shortly.");
    case "knowledge-read-only":
    case "knowledge-not-permitted":
      return again(
        'Call sql with one SELECT on facts or fact_history, or one INSERT INTO facts with mode "write".',
      );
    case "knowledge-failed":
      return again("Call sql again once; if it fails again, tell the person knowledge failed.");
    default:
      return error;
  }
}
