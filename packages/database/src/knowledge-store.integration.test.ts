import { createId, type KnowledgeTopicId } from "@opensteer/core";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { createDatabase } from "./connection.js";
import {
  createKnowledgeExecutorPool,
  prepareKnowledgeExecutor,
  type KnowledgeExecutorCredentials,
} from "./knowledge-executor.js";
import {
  ensureKnowledgeGeneralTopic,
  listKnowledgeTopics,
  runKnowledgeStatement,
  type KnowledgeFactKey,
  type KnowledgeJson,
  type KnowledgeResult,
  type KnowledgeWriter,
} from "./knowledge-store.js";
import { cloneTestDatabase, ownTestDatabaseProducer } from "./test-database.test-support.js";

const owner = createId("user");
const writer: KnowledgeWriter = {
  kind: "person",
  id: owner,
  initiatorId: null,
  agentId: "agent-1",
  taskId: "thr-1",
  runId: "run-1",
};

async function fixture() {
  const clone = await cloneTestDatabase("host");
  return ownTestDatabaseProducer(clone.url, async () => {
    const database = createDatabase({ connectionString: clone.url, maxConnections: 4 });
    const credentials = await prepareKnowledgeExecutor(database);
    const pool = createKnowledgeExecutorPool(clone.url, credentials);
    const clients: pg.Client[] = [];
    const open = createId("knowledgeTopic");
    const hidden = createId("knowledgeTopic");
    await sql`
      insert into knowledge.topics (id, name, created_by_kind, created_by_id) values
        (${open}, 'Open', 'person', ${owner}), (${hidden}, 'Hidden', 'person', ${owner})
    `.execute(database);
    await sql`
      insert into knowledge.operations (id, writer_kind, writer_id, input_hash, row_count, receipt)
        values ('seed', 'person', ${owner}, repeat('0', 64), 5, '{}')
    `.execute(database);
    await sql`
      insert into knowledge.fact_log
        (topic, thing, property, value, writer_kind, writer_id, agent_id, operation_id, operation_row)
      values
        (${open}, 'trip/kyoto', 'hotel', '"Hotel A"', 'person', ${owner}, 'seed', 'seed', 1),
        (${open}, 'n', 'count', '5', 'person', ${owner}, 'seed', 'seed', 2),
        (${hidden}, 'trip/kyoto', 'hotel', '"HIDDEN_HOTEL"', 'person', ${owner}, 'seed', 'seed', 3),
        (${hidden}, 'n', 'count', '"HIDDEN_NOT_AN_INTEGER"', 'person', ${owner}, 'seed', 'seed', 4),
        (${hidden}, 'z', 'divisor', '0', 'person', ${owner}, 'seed', 'seed', 5)
    `.execute(database);
    return {
      url: clone.url,
      database,
      credentials,
      pool,
      open,
      hidden,
      async executorClient() {
        const client = new pg.Client({ connectionString: executorUrl(clone.url, credentials) });
        client.on("error", () => undefined);
        await client.connect();
        clients.push(client);
        return client;
      },
      async count(where = "true") {
        const { rows } = await sql<{ count: string }>`
          select count(*)::text as count from knowledge.fact_log where ${sql.raw(where)}
        `.execute(database);
        return Number(rows[0]!.count);
      },
      async close() {
        for (const client of clients) await client.end().catch(() => undefined);
        await pool.end();
        const role = sql.id(credentials.role);
        await sql`drop owned by ${role}; drop role ${role}`.execute(database);
        await database.destroy();
      },
    };
  });
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function executorUrl(hostUrl: string, credentials: KnowledgeExecutorCredentials) {
  const url = new URL(hostUrl);
  url.username = credentials.role;
  url.password = credentials.password;
  return url.toString();
}

function select(
  context: Fixture,
  text: string,
  options: {
    parameters?: KnowledgeJson[];
    read?: KnowledgeTopicId[];
    statementTimeoutMs?: number;
  } = {},
) {
  return runKnowledgeStatement(context.pool, {
    statement: { kind: "select", text, parameters: options.parameters ?? [] },
    readTopicIds: options.read ?? [context.open],
    writeTopicIds: [],
    writer,
  });
}

function insert(
  context: Fixture,
  text: string,
  options: {
    parameters?: KnowledgeJson[];
    read?: KnowledgeTopicId[];
    write?: KnowledgeTopicId[];
    operationKey?: string;
    onlyIfUnchanged?: boolean;
    lockTimeoutMs?: number;
    writer?: KnowledgeWriter;
    keys?: KnowledgeFactKey[];
  } = {},
) {
  return runKnowledgeStatement(context.pool, {
    statement: {
      kind: "insert",
      text,
      parameters: options.parameters ?? [],
      operationKey: options.operationKey ?? randomUUID(),
      onlyIfUnchanged: options.onlyIfUnchanged ?? false,
      keys: options.keys ?? [],
    },
    readTopicIds: options.read ?? [context.open],
    writeTopicIds: options.write ?? [context.open],
    writer: options.writer ?? writer,
    ...(options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs }),
  });
}

function rowsOf(result: KnowledgeResult) {
  if (result.kind !== "select") throw new Error("Expected a SELECT result");
  return result.rows;
}

function receiptOf(result: KnowledgeResult) {
  if (result.kind !== "insert") throw new Error("Expected an INSERT result");
  return result.receipt;
}

async function scoped(
  client: pg.Client,
  context: Fixture,
  options: {
    isolation?: string;
    operation?: string;
    onlyIfUnchanged?: boolean;
    writerId?: string;
    agentId?: string;
  } = {},
) {
  await client.query(`begin isolation level ${options.isolation ?? "read committed"}`);
  await client.query(
    `select set_config('knowledge.read_topics', $1::text[]::text, true),
      set_config('knowledge.write_topics', $1::text[]::text, true),
      set_config('knowledge.writer_kind', 'person', true),
      set_config('knowledge.writer_id', $2, true),
      set_config('knowledge.agent_id', $3, true),
      set_config('knowledge.operation_id', $4, true),
      set_config('knowledge.only_if_unchanged', $5, true)`,
    [
      [context.open],
      options.writerId ?? owner,
      options.agentId ?? "agent-2",
      options.operation ?? randomUUID(),
      String(options.onlyIfUnchanged ?? false),
    ],
  );
}

async function begin(client: pg.Client) {
  await client.query("select knowledge.begin_operation(repeat('a', 64))");
}

async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  return promise.then(
    () => undefined,
    (error: unknown) => (error as { code?: string }).code,
  );
}

async function hotelId(context: Fixture): Promise<string> {
  const rows = rowsOf(
    await select(context, "select id from facts where thing = 'trip/kyoto' and property = 'hotel'"),
  );
  return rows[0]![0] as string;
}

// Skip outside the integration launcher, which supplies an isolated PostgreSQL clone.
const integration = process.env.OPENSTEER_TEST_DATABASE_URL ? describe : describe.skip;
integration("knowledge storage", () => {
  it("seeds one General topic for the Personal owner and lists unarchived topics", async () => {
    const clone = await cloneTestDatabase("host");
    const { database } = await ownTestDatabaseProducer(clone.url, async () => {
      const database = createDatabase({ connectionString: clone.url, maxConnections: 2 });
      return { database, close: () => database.destroy() };
    });
    await ensureKnowledgeGeneralTopic(database, owner);
    await ensureKnowledgeGeneralTopic(database, owner);
    const [general, ...rest] = await listKnowledgeTopics(database);
    expect(rest).toEqual([]);
    expect(general).toMatchObject({ name: "General", createdByKind: "person", createdById: owner });
    await sql`update knowledge.topics set archived_at = now()`.execute(database);
    await ensureKnowledgeGeneralTopic(database, owner);
    expect(await listKnowledgeTopics(database)).toEqual([]);
    expect(await listKnowledgeTopics(database, { includeArchived: true })).toHaveLength(1);
  });

  it("shows a caller only its readable topics, through counts, joins and predicates that fail on hidden values", async () => {
    const context = await fixture();
    expect(rowsOf(await select(context, "select count(*) from facts"))).toEqual([["2"]]);
    expect(rowsOf(await select(context, "select count(*) from fact_history"))).toEqual([["2"]]);
    expect(
      rowsOf(
        await select(
          context,
          `select count(*) from facts f join fact_history h on h.thing = f.thing
           join knowledge.fact_log l on l.thing = h.thing`,
        ),
      ),
    ).toEqual([["2"]]);
    expect(
      rowsOf(
        await select(
          context,
          "select thing, text from fact_history where case when thing = 'n' then text::int > 0 end",
        ),
      ),
    ).toEqual([["n", "5"]]);
    expect(
      rowsOf(
        await select(
          context,
          "select count(*) from facts where case when thing = 'z' then 1 / text::int > 0 end",
        ),
      ),
    ).toEqual([["0"]]);
    expect(
      rowsOf(await select(context, "select count(*) from fact_history where text like '%HIDDEN%'")),
    ).toEqual([["0"]]);
    expect(
      rowsOf(await select(context, "select topic, count(*) from fact_history group by topic")),
    ).toEqual([[context.open, "2"]]);
    expect(rowsOf(await select(context, "select count(*) from facts", { read: [] }))).toEqual([
      ["0"],
    ]);
  });

  it("refuses a write to an unwritable topic exactly as it refuses an unknown one", async () => {
    const context = await fixture();
    const statement =
      "insert into facts (topic, thing, property, value) values ($1, 'x', 'p', '1')";
    const unknown = await insert(context, statement, {
      parameters: [createId("knowledgeTopic")],
    }).catch((error: unknown) => error);
    const unwritable = await insert(context, statement, {
      parameters: [context.hidden],
      read: [context.open, context.hidden],
    }).catch((error: unknown) => error);
    expect(unknown).toMatchObject({ code: "forbidden", reason: "knowledge-topic-not-writable" });
    expect(unwritable).toEqual(unknown);
    expect((unwritable as Error).message).toBe((unknown as Error).message);
    expect(await context.count()).toBe(5);
  });

  it("never lets a caller supply writer or replacement columns, change history, or write the log", async () => {
    const context = await fixture();
    for (const statement of [
      `insert into facts (topic, thing, property, value, writer_id) values ($1, 'x', 'p', '1', 'usr_forged')`,
      `insert into facts (topic, thing, property, value, replaces_id) values ($1, 'x', 'p', '1', 1)`,
      `insert into facts (topic, thing, property, value, agent_id) values ($1, 'x', 'p', '1', 'forged')`,
      `insert into fact_history (topic, thing, property, value) values ($1, 'x', 'p', '1')`,
      `insert into knowledge.fact_log (topic, thing, property, value, writer_kind, writer_id, agent_id,
        operation_id, operation_row) values ($1, 'x', 'p', '1', 'person', 'usr_forged', 'a', 'seed', 9)`,
      `update facts set value = '2' where topic = $1`,
      `update knowledge.fact_log set writer_id = 'usr_forged' where topic = $1`,
      `delete from fact_history where topic = $1`,
      `delete from knowledge.fact_log where topic = $1`,
    ])
      await expect(
        insert(context, statement, { parameters: [context.open] }),
        statement,
      ).rejects.toMatchObject({ code: "forbidden", reason: "knowledge-not-permitted" });
    await expect(insert(context, "truncate knowledge.fact_log")).rejects.toMatchObject({
      code: "forbidden",
      reason: "knowledge-not-permitted",
    });
    expect(await context.count()).toBe(5);
    expect(await context.count("writer_id <> agent_id and agent_id <> 'seed'")).toBe(0);
  });

  it("connects only as the restricted login, whatever the Host's connection string carries", async () => {
    const context = await fixture();
    const host = new URL(context.url);
    const user = decodeURIComponent(host.username);
    const password = decodeURIComponent(host.password);
    const carrying = new URL(context.url);
    carrying.searchParams.set("user", user);
    carrying.searchParams.set("password", password);
    carrying.searchParams.set("options", `-c role=${user}`);
    const pool = createKnowledgeExecutorPool(carrying.toString(), context.credentials);
    try {
      const { rows } = await pool.query<{ session: string; current: string }>(
        "select session_user::text as session, current_user::text as current",
      );
      expect(rows).toEqual([
        { session: context.credentials.role, current: context.credentials.role },
      ]);
    } finally {
      await pool.end();
    }
    const superuser = createKnowledgeExecutorPool(context.url, { role: user, password });
    try {
      await expect(superuser.query("select 1")).rejects.toThrow(
        "The knowledge pool is not logged in as its restricted login",
      );
    } finally {
      await superuser.end();
    }
  });

  it("logs in as its own role, which cannot become another or read any application table", async () => {
    const context = await fixture();
    const client = await context.executorClient();
    const host = decodeURIComponent(new URL(process.env.OPENSTEER_TEST_DATABASE_URL!).username);
    const { rows } = await client.query(
      `select session_user::text as session, current_user::text as current,
        r.rolsuper, r.rolinherit, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls, r.rolreplication,
        (select count(*)::int from pg_auth_members where member = r.oid) as memberships,
        current_setting('search_path') as search_path,
        current_setting('log_min_messages') as log_min_messages
       from pg_roles r where r.rolname = current_user`,
    );
    expect(rows).toEqual([
      {
        session: context.credentials.role,
        current: context.credentials.role,
        rolsuper: false,
        rolinherit: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolbypassrls: false,
        rolreplication: false,
        memberships: 0,
        search_path: "pg_catalog, knowledge, pg_temp",
        log_min_messages: "fatal",
      },
    ]);
    for (const attempt of [
      `set role "${host}"`,
      `set session authorization "${host}"`,
      `select set_config('role', '${host}', false)`,
      `select set_config('session_authorization', '${host}', false)`,
      "set log_min_messages = 'error'",
      `set role ${context.credentials.role.replace("executor", "owner").replace(/_\d+$/u, "")}`,
    ])
      expect(await sqlState(client.query(attempt)), attempt).toBe("42501");
    const tables = await sql<{ name: string }>`
      select format('%I.%I', schemaname, tablename) as name from pg_tables
      where schemaname in ('public', 'knowledge') and tablename not in ('fact_log')
    `.execute(context.database);
    expect(tables.rows.length).toBeGreaterThan(100);
    for (const { name } of tables.rows)
      expect(await sqlState(client.query(`select from ${name} limit 0`)), name).toBe("42501");
    expect(await sqlState(client.query("select knowledge.require_read_committed()"))).toBe("42501");
  });

  it("sees nothing on a reused connection whose scope was not set", async () => {
    const context = await fixture();
    const client = await context.executorClient();
    await scoped(client, context);
    expect((await client.query("select count(*)::int as n from facts")).rows).toEqual([{ n: 2 }]);
    await client.query("commit");
    await client.query("begin isolation level read committed");
    for (const relation of ["facts", "fact_history", "knowledge.fact_log"])
      expect((await client.query(`select count(*)::int as n from ${relation}`)).rows).toEqual([
        { n: 0 },
      ]);
    await client.query("rollback");
  });

  it("saves two simultaneous replacements, and the second receipt names the one it missed", async () => {
    const context = await fixture();
    const baseline = await hotelId(context);
    const first = await context.executorClient();
    const probe = await context.executorClient();
    const replace = `insert into facts (topic, thing, property, value, seen_fact_id)
      values ($1, 'trip/kyoto', 'hotel', $2, $3) returning id`;
    await scoped(first, context);
    await begin(first);
    const held = await first.query(replace, [context.open, '"Hotel B"', baseline]);
    const firstId = held.rows[0].id as string;
    await scoped(probe, context);
    await begin(probe);
    await probe.query("set local lock_timeout = '50ms'");
    expect(await sqlState(probe.query(replace, [context.open, '"Probe"', baseline]))).toBe("55P03");
    await probe.query("rollback");
    const second = insert(context, replace, {
      parameters: [context.open, '"Hotel C"', baseline],
      lockTimeoutMs: 10_000,
    });
    await first.query("commit");
    const result = await second;
    expect(receiptOf(result).facts).toEqual([
      expect.objectContaining({
        replacesId: firstId,
        seenFactId: baseline,
        baseline: "observed",
        unseenCount: 1,
        unseen: [expect.objectContaining({ id: firstId, writerId: owner, agentId: "agent-2" })],
      }),
    ]);
    const history = await select(
      context,
      "select value, replaces_id from fact_history where thing = 'trip/kyoto' order by id",
    );
    expect(rowsOf(history)).toEqual([
      ["Hotel A", null],
      ["Hotel B", baseline],
      ["Hotel C", firstId],
    ]);
  });

  it("refuses only-if-unchanged on a changed key and on a new key two writers create at once", async () => {
    const context = await fixture();
    const baseline = await hotelId(context);
    const replace = `insert into facts (topic, thing, property, value, seen_fact_id)
      values ($1, $2, 'hotel', $3, $4)`;
    const newer = receiptOf(
      await insert(context, replace, { parameters: [context.open, "trip/kyoto", '"B"', baseline] }),
    ).facts[0]!.id;
    await expect(
      insert(context, replace, {
        parameters: [context.open, "trip/kyoto", '"C"', baseline],
        onlyIfUnchanged: true,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "knowledge-fact-changed",
      details: { thing: "trip/kyoto", currentFactId: newer, seenFactId: baseline },
    });

    const first = await context.executorClient();
    await scoped(first, context, { onlyIfUnchanged: true });
    await begin(first);
    const created = await first.query(`${replace} returning id`, [
      context.open,
      "trip/osaka",
      '"First"',
      null,
    ]);
    const probe = await context.executorClient();
    await scoped(probe, context, { onlyIfUnchanged: true });
    await begin(probe);
    await probe.query("set local lock_timeout = '50ms'");
    expect(
      await sqlState(probe.query(replace, [context.open, "trip/osaka", '"Probe"', null])),
    ).toBe("55P03");
    await probe.query("rollback");
    const racing = insert(context, replace, {
      parameters: [context.open, "trip/osaka", '"Second"', null],
      onlyIfUnchanged: true,
      lockTimeoutMs: 10_000,
    });
    await first.query("commit");
    await expect(racing).rejects.toMatchObject({
      code: "conflict",
      reason: "knowledge-fact-changed",
      details: { thing: "trip/osaka", currentFactId: created.rows[0].id, seenFactId: null },
    });
    expect(await context.count("thing = 'trip/osaka'")).toBe(1);
  });

  it("lets two writers of the same keys in opposite row orders both commit", async () => {
    const context = await fixture();
    const key = (thing: string) => ({ topic: context.open, thing, property: "p" });
    const write = (things: [string, string]) =>
      insert(
        context,
        `insert into facts (topic, thing, property, value) values ($1, $2, 'p', '1'), ($1, $3, 'p', '2')`,
        {
          parameters: [context.open, ...things],
          keys: things.map(key),
          lockTimeoutMs: 10_000,
        },
      );
    const holder = await context.executorClient();
    await holder.query("begin");
    await holder.query(
      `select pg_advisory_xact_lock(hashtextextended('knowledge:' || jsonb_build_array($1::text, 'x'::text, 'p'::text)::text, 0))`,
      [context.open],
    );
    const writers = [write(["x", "y"]), write(["y", "x"])];
    await vi.waitFor(
      async () => {
        const { rows } = await sql<{ waiting: string }>`
          select count(*)::text as waiting from pg_catalog.pg_locks
          where locktype = 'advisory' and not granted
            and database = (select oid from pg_catalog.pg_database where datname = current_database())
        `.execute(context.database);
        if (rows[0]?.waiting !== "2") throw new Error("Both writers never waited on a key lock");
      },
      { timeout: 10_000, interval: 20 },
    );
    await holder.query("commit");
    const settled = await Promise.allSettled(writers);
    expect(settled.map(({ status }) => status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await context.count(`topic = '${context.open}' and property = 'p'`)).toBe(4);
  });

  it("aborts the whole statement at the 26th row", async () => {
    const context = await fixture();
    const values = (count: number) =>
      Array.from({ length: count }, (_, row) => `($1, 'cap/${row}', 'p', '${row}')`).join(", ");
    const operationKey = randomUUID();
    await expect(
      insert(context, `insert into facts (topic, thing, property, value) values ${values(26)}`, {
        parameters: [context.open],
        operationKey,
      }),
    ).rejects.toMatchObject({ code: "resource_exhausted", reason: "knowledge-too-many-facts" });
    expect(await context.count()).toBe(5);
    expect(
      (
        await sql`select id from knowledge.operations where id = ${operationKey}`.execute(
          context.database,
        )
      ).rows,
    ).toEqual([]);
    const saved = await insert(
      context,
      `insert into facts (topic, thing, property, value) values ${values(25)}`,
      { parameters: [context.open] },
    );
    expect(receiptOf(saved).facts.map((fact) => fact.thing)).toEqual(
      Array.from({ length: 25 }, (_, row) => `cap/${row}`),
    );
  });

  it("replays an operation key's receipt without writing, and refuses the key for a different write", async () => {
    const context = await fixture();
    const operationKey = randomUUID();
    const statement = "insert into facts (topic, thing, property, value) values ($1, 'k', 'p', $2)";
    const first = await insert(context, statement, {
      parameters: [context.open, "1"],
      operationKey,
    });
    expect(first).toMatchObject({ replayed: false });
    const again = await insert(context, statement, {
      parameters: [context.open, "1"],
      operationKey,
    });
    expect(again).toEqual({ ...first, replayed: true, returning: null });
    expect(await context.count("thing = 'k'")).toBe(1);
    await expect(
      insert(context, statement, { parameters: [context.open, "2"], operationKey }),
    ).rejects.toMatchObject({ code: "conflict", reason: "knowledge-operation-key-reused" });
    await expect(
      insert(context, statement, {
        parameters: [context.open, "1"],
        operationKey,
        writer: { ...writer, id: createId("user") },
      }),
    ).rejects.toMatchObject({ code: "conflict", reason: "knowledge-operation-key-reused" });
    await expect(
      insert(context, statement, {
        parameters: [context.open, "1"],
        operationKey,
        read: [context.hidden],
        write: [context.hidden],
      }),
    ).rejects.toMatchObject({ code: "forbidden", reason: "knowledge-topic-not-writable" });
    expect(await context.count("thing = 'k'")).toBe(1);
  });

  it("refuses any isolation level but READ COMMITTED", async () => {
    const context = await fixture();
    const client = await context.executorClient();
    for (const isolation of ["repeatable read", "serializable"]) {
      await scoped(client, context, { isolation });
      expect(await sqlState(begin(client))).toBe("KB005");
      await client.query("rollback");
    }
    const operation = randomUUID();
    await scoped(client, context, { operation });
    await begin(client);
    await client.query("commit");
    await scoped(client, context, { isolation: "repeatable read", operation });
    expect(
      await sqlState(
        client.query(
          "insert into facts (topic, thing, property, value) values ($1, 'x', 'p', '1')",
          [context.open],
        ),
      ),
    ).toBe("KB005");
    await client.query("rollback");
    expect(await context.count()).toBe(5);
  });

  it("refuses a write into a topic archived while the write is in flight", async () => {
    const context = await fixture();
    const statement =
      "insert into facts (topic, thing, property, value) values ($1, 'x', 'p', '1')";
    const writing = await context.executorClient();
    await scoped(writing, context);
    await begin(writing);
    await writing.query(statement, [context.open]);
    await expect(
      context.database.transaction().execute(async (transaction) => {
        await sql`set local lock_timeout = '50ms'`.execute(transaction);
        await sql`update knowledge.topics set archived_at = now() where id = ${context.open}`.execute(
          transaction,
        );
      }),
    ).rejects.toMatchObject({ code: "55P03" });
    await writing.query("rollback");

    const archived = Promise.withResolvers<void>();
    const commit = Promise.withResolvers<void>();
    const archiving = context.database.transaction().execute(async (transaction) => {
      await sql`update knowledge.topics set archived_at = now() where id = ${context.open}`.execute(
        transaction,
      );
      archived.resolve();
      await commit.promise;
    });
    await archived.promise;
    const write = insert(context, statement, {
      parameters: [context.open],
      lockTimeoutMs: 10_000,
    });
    commit.resolve();
    await archiving;
    await expect(write).rejects.toMatchObject({
      code: "forbidden",
      reason: "knowledge-topic-not-writable",
    });
    expect(await context.count()).toBe(5);
  });

  it("refuses an empty writer", async () => {
    const context = await fixture();
    const statement =
      "insert into facts (topic, thing, property, value) values ($1, 'x', 'p', '1')";
    await expect(
      insert(context, statement, {
        parameters: [context.open],
        writer: { ...writer, agentId: "" },
      }),
    ).rejects.toMatchObject({ code: "internal", reason: "knowledge-failed" });
    const client = await context.executorClient();
    await scoped(client, context);
    await begin(client);
    await client.query("select set_config('knowledge.writer_id', '', true)");
    expect(await sqlState(client.query(statement, [context.open]))).toBe("23514");
    await client.query("rollback");
    await scoped(client, context, { writerId: "" });
    expect(await sqlState(begin(client))).toBe("KB008");
    await client.query("rollback");
    expect(await context.count()).toBe(5);
  });

  it("bounds a result row to 512 KB and a fact value to 64 KB inside PostgreSQL", async () => {
    const context = await fixture();
    expect(rowsOf(await select(context, "select length(repeat('x', 524000))"))).toEqual([[524000]]);
    expect(rowsOf(await select(context, "select repeat('x', 524000) as big"))[0]![0]).toHaveLength(
      524000,
    );
    for (const statement of [
      "select repeat('x', 524289) as big",
      "select repeat('x', 524289) as a, 1 as q",
      "select 1 as q, repeat('x', 524289) as a from facts",
      'select 1 as "Q", 2 as r, 3 as "q.*", 4 as text, repeat(\'x\', 524289) as a',
      "select q.q, repeat('x', 524289) as a from (select 1 as q) as q",
      "select 1 as q, 2 as q, repeat('x', 524289) as a",
    ])
      await expect(select(context, statement), statement).rejects.toMatchObject({
        code: "resource_exhausted",
        reason: "knowledge-row-too-large",
      });
    const statement =
      "insert into facts (topic, thing, property, value) values ($1, 'big', 'v', $2::jsonb)";
    await insert(context, statement, {
      parameters: [context.open, JSON.stringify("x".repeat(65_534))],
    });
    await expect(
      insert(context, statement, {
        parameters: [context.open, JSON.stringify("x".repeat(65_535))],
      }),
    ).rejects.toMatchObject({ code: "bad_request", reason: "knowledge-value-too-large" });
    expect(await context.count("thing = 'big'")).toBe(1);
  });

  it("drops a connection that receives a message over 1 MB before the driver parses it", async () => {
    const context = await fixture();
    await expect(
      select(context, "select (repeat('x', 4000000) || 'y')::int4 as a"),
    ).rejects.toMatchObject({ code: "resource_exhausted", reason: "knowledge-message-too-large" });
    await expect(
      select(context, "select 1 as q, repeat('x', 524000) as a, repeat('y', 524000) as b"),
    ).rejects.toMatchObject({ code: "resource_exhausted", reason: "knowledge-row-too-large" });
    const after = await Promise.all([
      select(context, "select count(*) from facts"),
      select(context, "select count(*) from facts"),
    ]);
    expect(after.map(rowsOf)).toEqual([[["2"]], [["2"]]]);
    expect(context.pool.totalCount).toBeLessThanOrEqual(2);
  });

  it("returns typed array rows, at most 200, and stops a statement at its timeout", async () => {
    const context = await fixture();
    const many = await select(context, "select n from generate_series(1, 500) as n");
    expect(many).toMatchObject({
      kind: "select",
      columns: [{ name: "n", postgresType: "integer" }],
      truncated: true,
    });
    expect(rowsOf(many)).toHaveLength(200);
    expect(
      await select(
        context,
        `select 9007199254740993::bigint as a, 1.50::numeric as a, '{"b":[1]}'::jsonb as j,
          true as t, 'x'::text as s`,
      ),
    ).toEqual({
      kind: "select",
      columns: [
        { name: "a", postgresType: "bigint" },
        { name: "a", postgresType: "numeric" },
        { name: "j", postgresType: "jsonb" },
        { name: "t", postgresType: "boolean" },
        { name: "s", postgresType: "text" },
      ],
      rows: [["9007199254740993", "1.50", { b: [1] }, true, "x"]],
      truncated: false,
    });
    await expect(
      runKnowledgeStatement(context.pool, {
        statement: { kind: "select", text: "select pg_sleep(5)", parameters: [] },
        readTopicIds: [context.open],
        writeTopicIds: [],
        writer,
        statementTimeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: "timeout", reason: "knowledge-statement-timeout" });
    const after = await Promise.all([
      select(context, "select count(*) from facts"),
      select(context, "select count(*) from facts"),
    ]);
    expect(after.map(rowsOf)).toEqual([[["2"]], [["2"]]]);
  });
});
