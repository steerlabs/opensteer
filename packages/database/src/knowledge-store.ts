import { createId, OpensteerError, type KnowledgeTopicId, type UserId } from "@opensteer/core";
import { sql, type Kysely, type Selectable } from "kysely";
import { createHash } from "node:crypto";
import type { FieldDef, Pool, PoolClient, QueryArrayConfig, QueryArrayResult } from "pg";
import { z } from "zod";
import { KnowledgeMessageTooLarge } from "./knowledge-executor.js";
import type { KnowledgeTables, KnowledgeWriterKind } from "./knowledge-schema.js";
import type { DatabaseSchema } from "./schema.js";

export type KnowledgeTopic = Selectable<KnowledgeTables["knowledge.topics"]>;

export type KnowledgeJson =
  | string
  | number
  | boolean
  | null
  | readonly KnowledgeJson[]
  | { readonly [key: string]: KnowledgeJson };

export interface KnowledgeWriter {
  readonly kind: KnowledgeWriterKind;
  readonly id: string;
  readonly initiatorId: string | null;
  readonly agentId: string;
  readonly taskId: string | null;
  readonly runId: string | null;
}

export interface KnowledgeFactKey {
  readonly topic: string;
  readonly thing: string;
  readonly property: string;
}

export type KnowledgeStatement =
  | {
      readonly kind: "select";
      readonly text: string;
      readonly parameters: readonly KnowledgeJson[];
    }
  | {
      readonly kind: "insert";
      readonly text: string;
      readonly parameters: readonly KnowledgeJson[];
      readonly operationKey: string;
      readonly onlyIfUnchanged: boolean;
      /** Every key the INSERT writes; locked in one order first, so writers never wait on each other in a cycle. */
      readonly keys: readonly KnowledgeFactKey[];
    };

export interface KnowledgeRunInput {
  readonly statement: KnowledgeStatement;
  readonly readTopicIds: readonly KnowledgeTopicId[];
  readonly writeTopicIds: readonly KnowledgeTopicId[];
  readonly writer: KnowledgeWriter;
  readonly statementTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
  /** Runs inside the write transaction just before COMMIT; a throw rolls the write back. */
  readonly beforeCommit?: () => Promise<void>;
}

export interface KnowledgeRows {
  readonly columns: readonly { readonly name: string; readonly postgresType: string }[];
  readonly rows: readonly KnowledgeJson[][];
  readonly truncated: boolean;
}

const ReceiptSchema = z.object({
  operationId: z.string(),
  facts: z.array(
    z.object({
      id: z.string(),
      topic: z.string(),
      thing: z.string(),
      property: z.string(),
      replacesId: z.string().nullable(),
      seenFactId: z.string().nullable(),
      baseline: z.enum(["observed", "unknown"]),
      unseenCount: z.number().int().nullable(),
      unseen: z
        .array(
          z.object({
            id: z.string(),
            writerKind: z.enum(["person", "project"]),
            writerId: z.string(),
            agentId: z.string(),
            taskId: z.string().nullable(),
            writtenAt: z.string(),
          }),
        )
        .nullable(),
    }),
  ),
});
export type KnowledgeReceipt = z.infer<typeof ReceiptSchema>;

export type KnowledgeResult =
  | ({ readonly kind: "select" } & KnowledgeRows)
  | {
      readonly kind: "insert";
      readonly receipt: KnowledgeReceipt;
      readonly replayed: boolean;
      /** The statement's own RETURNING rows; null for a replay, which runs nothing. */
      readonly returning: KnowledgeRows | null;
    };

const rowLimit = 200;
const rowBytes = 524_288;

/** Seeds one open topic for a Personal owner, once, on a knowledge base that has none. */
export async function ensureKnowledgeGeneralTopic(
  database: Kysely<DatabaseSchema>,
  owner: UserId,
): Promise<void> {
  await sql`
    insert into knowledge.topics (id, name, created_by_kind, created_by_id)
    select ${createId("knowledgeTopic")}, 'General', 'person', ${owner}
    where not exists (select from knowledge.topics)
  `.execute(database);
}

export async function listKnowledgeTopics(
  database: Kysely<DatabaseSchema>,
  options: { readonly ids?: readonly KnowledgeTopicId[]; readonly includeArchived?: boolean } = {},
): Promise<KnowledgeTopic[]> {
  let query = database.selectFrom("knowledge.topics").selectAll().orderBy("name").orderBy("id");
  if (options.ids) {
    if (!options.ids.length) return [];
    query = query.where("id", "in", options.ids);
  }
  if (!options.includeArchived) query = query.where("archivedAt", "is", null);
  return query.execute();
}

/**
 * Runs one already-validated SELECT or INSERT as the restricted role, scoped to
 * the caller's topics. Failures are typed; no PostgreSQL text leaves here.
 */
export async function runKnowledgeStatement(
  pool: Pool,
  input: KnowledgeRunInput,
): Promise<KnowledgeResult> {
  const { statement } = input;
  const readable = new Set(input.readTopicIds);
  if (input.writeTopicIds.some((topic) => !readable.has(topic)))
    throw internal("A writable topic must also be readable");
  if (statement.kind === "insert" && !/^[\x21-\x7e]{1,128}$/u.test(statement.operationKey))
    throw internal("An operation key is 1 to 128 visible ASCII characters");
  const client = await pool.connect().catch(() => {
    throw new OpensteerError({
      code: "resource_exhausted",
      reason: "knowledge-busy",
      message: "Knowledge is busy; try again shortly.",
      retryable: true,
    });
  });
  // A dropped connection fails the running query; the client's own error event has no one else to hear it.
  const dropped = () => undefined;
  client.on("error", dropped);
  let names = typeNames.get(pool);
  if (!names) typeNames.set(pool, (names = new Map()));
  let clean = false;
  try {
    const result = await run(client, input, names);
    clean = true;
    return result;
  } catch (error) {
    clean = await rollback(client, error);
    throw knowledgeError(error, statement.kind);
  } finally {
    if (clean) clean = await discard(client);
    client.off("error", dropped);
    client.release(!clean);
  }
}

async function run(
  client: PoolClient,
  input: KnowledgeRunInput,
  names: Map<number, string>,
): Promise<KnowledgeResult> {
  const { statement, writer } = input;
  await client.query(
    `begin isolation level read committed ${statement.kind === "select" ? "read only" : "read write"}`,
  );
  await client.query({
    text: `select set_config('knowledge.read_topics', $1::text[]::text, true),
      set_config('knowledge.write_topics', $2::text[]::text, true),
      set_config('knowledge.writer_kind', $3, true),
      set_config('knowledge.writer_id', $4, true),
      set_config('knowledge.initiator_id', $5, true),
      set_config('knowledge.agent_id', $6, true),
      set_config('knowledge.task_id', $7, true),
      set_config('knowledge.run_id', $8, true),
      set_config('knowledge.operation_id', $9, true),
      set_config('knowledge.only_if_unchanged', $10, true),
      set_config('search_path', 'pg_catalog, knowledge, pg_temp', true),
      set_config('standard_conforming_strings', 'on', true),
      set_config('backslash_quote', 'safe_encoding', true),
      set_config('client_encoding', 'UTF8', true),
      set_config('statement_timeout', $11, true),
      set_config('lock_timeout', $12, true),
      set_config('idle_in_transaction_session_timeout', '5000', true)`,
    values: [
      [...input.readTopicIds],
      [...input.writeTopicIds],
      writer.kind,
      writer.id,
      writer.initiatorId ?? "",
      writer.agentId,
      writer.taskId ?? "",
      writer.runId ?? "",
      statement.kind === "insert" ? statement.operationKey : "",
      statement.kind === "insert" && statement.onlyIfUnchanged ? "true" : "false",
      String(input.statementTimeoutMs ?? 2_000),
      String(input.lockTimeoutMs ?? 250),
    ],
  });
  const parameters = statement.parameters.map((value) =>
    value !== null && typeof value === "object" ? JSON.stringify(value) : value,
  );
  if (statement.kind === "select") {
    const result = await query(
      client,
      `select q.* from (\n${statement.text}\n) as q
       where octet_length((q.*)::text) <= ${rowBytes} or knowledge.result_row_too_large()
       limit ${rowLimit + 1}`,
      parameters,
    );
    await client.query("rollback");
    return { kind: "select", ...(await rows(client, result, names)) };
  }
  const hash = createHash("sha256")
    .update(JSON.stringify([statement.text, parameters, statement.onlyIfUnchanged]))
    .digest("hex");
  const begun = await client.query<{ receipt: unknown }>(
    "select knowledge.begin_operation($1) as receipt",
    [hash],
  );
  const recorded = begun.rows[0]?.receipt;
  if (recorded != null) {
    await client.query("rollback");
    const receipt = ReceiptSchema.parse(recorded);
    const writable = new Set<string>(input.writeTopicIds);
    if (receipt.facts.some((fact) => !writable.has(fact.topic))) throw notWritable();
    return { kind: "insert", receipt, replayed: true, returning: null };
  }
  const keys = [
    ...new Map(
      statement.keys.map((key) => [JSON.stringify([key.topic, key.thing, key.property]), key]),
    ),
  ].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  if (keys.length)
    await client.query(
      `select count(pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
         'knowledge:' || pg_catalog.jsonb_build_array(k.topic, k.thing, k.property)::text, 0)))
       from unnest($1::text[], $2::text[], $3::text[]) as k(topic, thing, property)`,
      [
        keys.map(([, key]) => key.topic),
        keys.map(([, key]) => key.thing),
        keys.map(([, key]) => key.property),
      ],
    );
  const result = await query(client, statement.text, parameters);
  const completed = await client.query<{ receipt: unknown }>(
    "select knowledge.complete_operation() as receipt",
  );
  const receipt = ReceiptSchema.parse(completed.rows[0]?.receipt);
  const returning = result.fields.length ? await rows(client, result, names) : null;
  await input.beforeCommit?.();
  try {
    await client.query("commit");
  } catch {
    throw new UncertainCommit();
  }
  return { kind: "insert", receipt, replayed: false, returning };
}

function query(client: PoolClient, text: string, values: readonly unknown[]) {
  // Extended protocol: one statement per message, whatever the text holds.
  const config: QueryArrayConfig & { readonly queryMode: "extended" } = {
    text,
    values: [...values],
    rowMode: "array",
    queryMode: "extended",
    types: { getTypeParser: parserFor },
  };
  return client.query<unknown[]>(config);
}

function parserFor(oid: number): (value: string) => KnowledgeJson {
  switch (oid) {
    case 16:
      return (value) => value === "t";
    case 21:
    case 23:
    case 26:
      return Number;
    case 700:
    case 701:
      return (value) => (Number.isFinite(Number(value)) ? Number(value) : value);
    case 114:
    case 3802:
      return (value) => JSON.parse(value) as KnowledgeJson;
    default:
      return (value) => value;
  }
}

const typeNames = new WeakMap<Pool, Map<number, string>>();

async function rows(
  client: PoolClient,
  result: QueryArrayResult<unknown[]>,
  names: Map<number, string>,
): Promise<KnowledgeRows> {
  const unknown = [...new Set(result.fields.map((field: FieldDef) => field.dataTypeID))].filter(
    (oid) => !names.has(oid),
  );
  if (unknown.length) {
    const { rows: found } = await client.query<{ oid: number; name: string }>(
      "select oid::int as oid, pg_catalog.format_type(oid, null) as name from pg_catalog.pg_type where oid = any($1::oid[])",
      [unknown],
    );
    for (const { oid, name } of found) names.set(oid, name);
  }
  return {
    columns: result.fields.map((field) => ({
      name: field.name,
      postgresType: names.get(field.dataTypeID) ?? "unknown",
    })),
    rows: result.rows.slice(0, rowLimit) as KnowledgeJson[][],
    truncated: result.rows.length > rowLimit,
  };
}

class UncertainCommit extends Error {}

/** True only when the session is provably back outside any transaction. */
async function rollback(client: PoolClient, error: unknown): Promise<boolean> {
  if (error instanceof UncertainCommit) return false;
  try {
    await client.query("rollback");
    return true;
  } catch {
    return false;
  }
}

async function discard(client: PoolClient): Promise<boolean> {
  try {
    await client.query("discard all");
    return true;
  } catch {
    return false;
  }
}

function sqlState(error: unknown): string | undefined {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^[0-9A-Z]{5}$/u.test(code) ? code : undefined;
}

const ChangedSchema = z.object({
  topic: z.string(),
  thing: z.string(),
  property: z.string(),
  currentFactId: z.string().nullable(),
  seenFactId: z.string().nullable(),
});

function knowledgeError(error: unknown, kind: KnowledgeStatement["kind"]): OpensteerError {
  if (error instanceof OpensteerError) return error;
  const nothingSaved =
    kind === "insert" ? " No facts were saved; read facts and decide again." : "";
  const refuse = (
    code: OpensteerError["code"],
    reason: string,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown> } = {},
  ) => new OpensteerError({ code, reason, message: message + nothingSaved, ...options });
  if (error instanceof KnowledgeMessageTooLarge)
    return refuse(
      "resource_exhausted",
      "knowledge-message-too-large",
      "PostgreSQL's answer to the statement, a row or an error, was over 1 MB.",
    );
  if (error instanceof UncertainCommit)
    return new OpensteerError({
      code: "internal",
      reason: "knowledge-commit-uncertain",
      message: "The write may have committed; check this operation key before retrying.",
    });
  const state = sqlState(error);
  const constraint =
    error instanceof Error && "constraint" in error && typeof error.constraint === "string"
      ? error.constraint
      : undefined;
  switch (state) {
    case "KB001":
      return notWritable(nothingSaved);
    case "KB002":
      return refuse(
        "bad_request",
        "knowledge-seen-fact-mismatch",
        "seen_fact_id must be the id of a version of the same topic, thing and property.",
      );
    case "KB003": {
      const detail = error instanceof Error && "detail" in error ? error.detail : undefined;
      const parsed =
        typeof detail === "string" ? ChangedSchema.safeParse(safeJson(detail)) : undefined;
      return refuse(
        "conflict",
        "knowledge-fact-changed",
        "A fact changed since it was read.",
        parsed?.success ? { details: parsed.data } : {},
      );
    }
    case "KB004":
      return refuse(
        "resource_exhausted",
        "knowledge-too-many-facts",
        "One write appends at most 25 facts.",
      );
    case "KB006":
      return refuse(
        "conflict",
        "knowledge-operation-key-reused",
        "This operation key was already used for a different write.",
      );
    case "KB007":
      return refuse(
        "resource_exhausted",
        "knowledge-row-too-large",
        "A result row is over 512 KB.",
      );
    case "57014":
      return refuse("timeout", "knowledge-statement-timeout", "The statement ran out of time.");
    case "55P03":
    case "40P01":
    case "40001":
      return refuse("conflict", "knowledge-busy", "Another write held the same facts.", {
        retryable: true,
      });
    case "42501":
    case "55000":
      return refuse(
        "forbidden",
        "knowledge-not-permitted",
        "Only SELECT and INSERT into facts are allowed.",
      );
    case "25006":
      return refuse("bad_request", "knowledge-read-only", "This statement only reads.");
    case "23514":
      if (constraint === "fact_log_value_size")
        return refuse("bad_request", "knowledge-value-too-large", "A fact value is over 64 KB.");
      if (constraint === "fact_log_writer_present") break;
      return refuse(
        "bad_request",
        "knowledge-invalid-fact",
        "A topic, thing or property is empty or too long.",
      );
    case "23502":
      return refuse(
        "bad_request",
        "knowledge-invalid-fact",
        "topic, thing, property and value are required.",
      );
  }
  if (state?.startsWith("53") || state?.startsWith("54"))
    return refuse(
      "resource_exhausted",
      "knowledge-resource-limit",
      "The statement used too many resources.",
    );
  if (state?.startsWith("22"))
    return refuse(
      "bad_request",
      "knowledge-invalid-value",
      "The statement failed on a value it read or wrote.",
    );
  if (state?.startsWith("42"))
    return refuse(
      "bad_request",
      "knowledge-invalid-statement",
      "PostgreSQL could not run this statement.",
    );
  return refuse("internal", "knowledge-failed", "The knowledge statement failed.");
}

function notWritable(suffix = ""): OpensteerError {
  return new OpensteerError({
    code: "forbidden",
    reason: "knowledge-topic-not-writable",
    message: "That topic doesn't exist or can't be written." + suffix,
  });
}

function internal(message: string): OpensteerError {
  return new OpensteerError({ code: "internal", reason: "knowledge-failed", message });
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
