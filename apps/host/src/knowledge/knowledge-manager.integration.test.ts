import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createId, threadReachScope, type Thread } from "@opensteer/core";
import { createDatabase, knowledgeExecutorRole } from "@opensteer/database";
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
} from "@opensteer/database/test-support/database";
import { sql } from "kysely";
import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { AgentCaller, RunCaller } from "../mcp/agent-caller.js";
import { agentToolHandlers } from "../mcp/handlers/index.js";
import { OpensteerMcpService } from "../mcp/opensteer-mcp-service.js";
import { startKnowledgeManager } from "./knowledge-manager.js";

const unavailable = new Proxy(
  {},
  {
    get: () => async () => {
      throw new Error("Unexpected tool");
    },
  },
);

async function fixture(options: { knowledge?: boolean; statementTimeoutMs?: number } = {}) {
  const clone = await cloneTestDatabase("host");
  return ownTestDatabaseProducer(clone.url, async () => {
    const database = createDatabase({ connectionString: clone.url, maxConnections: 4 });
    const owner = createId("user");
    await database
      .insertInto("users")
      .values({
        id: owner,
        displayName: "Owner",
        email: "owner@example.test",
        emailVerified: true,
        image: null,
        instanceRole: "administrator",
        disabledAt: null,
      })
      .execute();
    const manager =
      options.knowledge === false
        ? undefined
        : await startKnowledgeManager({
            database,
            databaseUrl: clone.url,
            ...(options.statementTimeoutMs === undefined
              ? {}
              : { statementTimeoutMs: options.statementTimeoutMs }),
          });
    const workspaceId = createId("workspace");
    const environmentId = createId("environment");
    const thread = (inheritsMain: boolean) => {
      const id = createId("thread");
      return {
        id,
        workspaceId,
        environmentId,
        lineageRootThreadId: id,
        accessMode: "full-access",
        inheritsMain,
        specialistId: null,
        harnessInstanceId: `hin-${id}`,
      } as unknown as Thread;
    };
    const run = (anchor: Thread): RunCaller => {
      const runId = createId("run");
      return {
        kind: "run",
        key: `run:${runId}`,
        userId: owner,
        accessMode: "full-access",
        reach: threadReachScope(anchor),
        thread: anchor,
        claims: {
          runId,
          requestedBy: owner,
          threadId: anchor.id,
          workspaceId,
          environmentId,
        } as unknown as RunCaller["claims"],
      };
    };
    const main = run(thread(true));
    // A channel conversation others can write to: the Host withholds Main inheritance.
    const shared = run(thread(false));
    const callers: Record<string, AgentCaller> = {
      owner: main,
      shared,
      connection: {
        kind: "connection",
        key: "connection:c",
        connectionId: "c",
        userId: owner,
        accessMode: "full-access",
        reach: { kind: "user" },
      },
      program: {
        kind: "program",
        key: "trigger:t",
        userId: owner,
        accessMode: "full-access",
        reach: { kind: "user" },
        anchor: main.thread,
        program: { kind: "trigger" } as never,
      },
    };
    const onToolError = vi.fn();
    const handlers = agentToolHandlers({
      administration: unavailable as never,
      integrations: unavailable as never,
      product: unavailable as never,
      triggers: unavailable as never,
      apps: unavailable as never,
      pluginInstall: async () => {
        throw new Error("Unexpected install");
      },
      knowledge: manager,
    });
    let service!: OpensteerMcpService;
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        const text = Buffer.concat(chunks).toString();
        const token = request.headers.authorization?.slice(7) ?? "";
        await service.handle(
          request,
          response,
          text ? JSON.parse(text) : undefined,
          token,
          token === "connection" ? service.options.publicUrl.origin : undefined,
        );
      })().catch(() => response.destroy());
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("The test server did not listen");
    const url = new URL(`http://127.0.0.1:${address.port}/internal/v1/mcp`);
    service = new OpensteerMcpService({
      handlers,
      publicUrl: url,
      onToolError,
      ...(manager ? { knowledgeFor: async (caller: AgentCaller) => caller.kind === "run" } : {}),
      store: {
        requests: { get: async () => null },
        getThreadForOwner: async () => null,
        findMainWorkspaceForOwner: async () => null,
      } as never,
      callers: {
        authenticate: async (token: string) => {
          const caller = callers[token];
          if (!caller) throw new Error("Unknown token");
          return caller;
        },
      },
    });
    const clients: Client[] = [];
    const sessions = new Map<string, Client>();
    const connect = async (token: string) => {
      const client = new Client({ name: "knowledge-test", version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(url, {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }) as unknown as Transport,
        { timeout: 5_000 },
      );
      clients.push(client);
      return client;
    };
    const general = async () =>
      (
        await sql<{ id: string }>`select id from knowledge.topics where name = 'General'`.execute(
          database,
        )
      ).rows[0]!.id;
    return {
      database,
      owner,
      main,
      onToolError,
      service,
      general,
      connect,
      async call(args: Record<string, unknown>, token = "owner") {
        let client = sessions.get(token);
        if (!client) sessions.set(token, (client = await connect(token)));
        return (await client.callTool({ name: "sql", arguments: args }, undefined, {
          timeout: 10_000,
        })) as {
          content: { type: string; text: string }[];
          structuredContent?: Record<string, unknown>;
          isError?: boolean;
        };
      },
      async count() {
        const { rows } = await sql<{ count: string }>`
          select count(*)::text as count from knowledge.fact_log
        `.execute(database);
        return Number(rows[0]!.count);
      },
      async close() {
        for (const client of clients) await client.close().catch(() => undefined);
        await service.close();
        server.close();
        if (manager) {
          await manager.close();
          const role = sql.id(await knowledgeExecutorRole(database));
          await sql`drop owned by ${role}; drop role ${role}`.execute(database);
        }
        await database.destroy();
      },
    };
  });
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function record(result: Awaited<ReturnType<Fixture["call"]>>) {
  expect(result.isError).toBeFalsy();
  expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  return result.structuredContent as Record<string, unknown> & {
    rows?: unknown[][];
    receipt?: { replayed: boolean; facts: Record<string, unknown>[] };
  };
}

function refusal(result: Awaited<ReturnType<Fixture["call"]>>) {
  expect(result.isError).toBe(true);
  const text = result.content.map((part) => part.text).join(" ");
  const error = (result.structuredContent as { error: { code: string; message: string } }).error;
  expect(error.message).toBe(text);
  return { code: error.code, text };
}

const insertHotel = (value: string, seen?: string) =>
  `INSERT INTO facts (topic, thing, property, value${seen === undefined ? "" : ", seen_fact_id"})
   VALUES ($1, 'trip/kyoto', 'hotel', '${JSON.stringify(value)}'${seen === undefined ? "" : `, ${seen}`})`;

// Skip outside the integration launcher, which supplies an isolated PostgreSQL clone.
const integration = process.env.OPENSTEER_TEST_DATABASE_URL ? describe : describe.skip;
integration("knowledge through the sql tool", () => {
  it("discovers, reads, writes with receipts and reports what a replacement had not seen", async () => {
    const f = await fixture();
    const topic = await f.general();
    const discovered = record(await f.call({}));
    expect(discovered.topics).toEqual([{ id: topic, name: "General" }]);
    expect(discovered.relations).toEqual([
      expect.objectContaining({
        name: "facts",
        insertable: ["topic", "thing", "property", "value", "seen_fact_id"],
        columns: expect.arrayContaining([
          { name: "value", postgresType: "jsonb" },
          { name: "text", postgresType: "text" },
        ]),
      }),
      expect.objectContaining({ name: "fact_history", insertable: [] }),
    ]);

    const first = record(
      await f.call({ query: insertHotel("Hotel A"), parameters: [topic], mode: "write" }),
    ).receipt!.facts[0]!;
    expect(first).toMatchObject({ baseline: "unknown", replacesId: null, unseenCount: null });
    const { rows: stamped } = await sql<Record<string, string | null>>`
      select writer_kind, writer_id, initiator_id, agent_id, task_id, run_id
      from knowledge.fact_log where id = ${first.id}
    `.execute(f.database);
    expect(stamped).toEqual([
      {
        writerKind: "person",
        writerId: f.owner,
        initiatorId: f.owner,
        agentId: f.main.thread.harnessInstanceId,
        taskId: f.main.thread.id,
        runId: f.main.claims.runId,
      },
    ]);
    expect(
      record(
        await f.call({
          query: "SELECT id, text FROM facts WHERE topic = $1 AND property = 'hotel'",
          parameters: [topic],
        }),
      ).rows,
    ).toEqual([[first.id, "Hotel A"]]);

    const second = record(
      await f.call({
        query: insertHotel("Hotel B", first.id as string),
        parameters: [topic],
        mode: "write",
      }),
    ).receipt!.facts[0]!;
    const third = record(
      await f.call({
        query: insertHotel("Hotel C", first.id as string),
        parameters: [topic],
        mode: "write",
      }),
    ).receipt!.facts[0]!;
    expect(third).toMatchObject({
      baseline: "observed",
      seenFactId: first.id,
      replacesId: second.id,
      unseenCount: 1,
      unseen: [expect.objectContaining({ id: second.id, writerId: f.owner })],
    });

    const changed = refusal(
      await f.call({
        query: insertHotel("Hotel D", second.id as string),
        parameters: [topic],
        mode: "write",
        onlyIfUnchanged: true,
      }),
    );
    expect(changed.code).toBe("conflict");
    expect(changed.text).toContain(
      `A fact changed since it was read; its current id is ${third.id}.`,
    );
    expect(changed.text).toContain("No facts were saved.");
    expect(changed.text).not.toContain("Hotel D");

    const unsaid = refusal(await f.call({ query: insertHotel("Hotel E"), parameters: [topic] }));
    expect(unsaid.text).toContain('INSERT needs mode "write". Nothing was saved.');
    expect(await f.count()).toBe(3);
  });

  it("returns a replayed operation's receipt without writing, and refuses the key for another write", async () => {
    const f = await fixture();
    const topic = await f.general();
    const call = (value: string) =>
      f.service.callTool(
        "owner",
        "sql",
        { query: insertHotel(value), parameters: [topic], mode: "write" },
        { operationKey: "one-call" },
      );
    const original = (await call("Hotel A")) as { receipt: { replayed: boolean } };
    const replay = (await call("Hotel A")) as { receipt: { replayed: boolean } };
    expect(original.receipt.replayed).toBe(false);
    expect(replay).toEqual({ ...original, receipt: { ...original.receipt, replayed: true } });
    expect(await f.count()).toBe(1);
    await expect(call("Hotel B")).rejects.toMatchObject({
      code: "conflict",
      reason: "knowledge-operation-key-reused",
    });
    expect(await f.count()).toBe(1);
  });

  it("refuses with sentences written for the agent that carry nothing from the statement", async () => {
    const f = await fixture();
    const topic = await f.general();
    record(
      await f.call({ query: insertHotel("SECRET_VALUE"), parameters: [topic], mode: "write" }),
    );
    const cases = [
      [
        { query: "SELECT set_config('knowledge.read_topics', 'SECRET_SCOPE', true)" },
        "bad_request",
      ],
      [{ query: "SELECT * FROM users WHERE email = 'SECRET_EMAIL'" }, "bad_request"],
      [
        { query: "SELECT text::int FROM facts WHERE topic = $1", parameters: [topic] },
        "bad_request",
      ],
      [
        {
          query:
            "INSERT INTO facts (topic, thing, property, value) VALUES ('SECRET_TOPIC', 'a', 'b', '1')",
          mode: "write",
        },
        "forbidden",
      ],
      [
        {
          query:
            "INSERT INTO facts (topic, thing, property, value) VALUES ($1, 'a', 'b', 'SECRET_JSON')",
          parameters: [topic],
          mode: "write",
        },
        "bad_request",
      ],
    ] as const;
    for (const [args, code] of cases) {
      const refused = refusal(await f.call(args));
      expect(refused.code, args.query).toBe(code);
      expect(refused.text, args.query).not.toMatch(/SECRET|invalid input|syntax for type|email/u);
    }
    expect(f.onToolError).not.toHaveBeenCalled();
    expect(await f.count()).toBe(1);
  });

  it("bounds the whole result, a row, the row count and the statement's time", async () => {
    const f = await fixture({ statementTimeoutMs: 100 });
    const topic = await f.general();
    const values = Array.from({ length: 12 }, (_, i) => `($1, 'n/${i}', 'v', '${i}')`).join(", ");
    record(
      await f.call({
        query: `INSERT INTO facts (topic, thing, property, value) VALUES ${values}`,
        parameters: [topic],
        mode: "write",
      }),
    );
    const capped = record(
      await f.call({
        query: "SELECT a.id FROM facts a, facts b, facts c WHERE a.topic = $1",
        parameters: [topic],
      }),
    );
    expect(capped.rows).toHaveLength(200);
    expect(capped.truncated).toBe(true);

    const whole = refusal(
      await f.call({
        query: "SELECT lpad('x', 4000, 'x') FROM facts a, facts b WHERE a.topic = $1",
        parameters: [topic],
      }),
    );
    expect(whole).toEqual({
      code: "resource_exhausted",
      text: "The result is over 512 KB. Select fewer columns or rows, or aggregate, and call sql again.",
    });
    const row = refusal(await f.call({ query: "SELECT lpad('x', 600000, 'x')" }));
    expect(row.code).toBe("resource_exhausted");
    expect(row.text).toContain("A result row is over 512 KB.");
    const slow = refusal(
      await f.call({
        query:
          "SELECT count(*) FROM facts a, facts b, facts c, facts d, facts e, facts g, facts h, facts i WHERE a.topic = $1",
        parameters: [topic],
      }),
    );
    expect(slow.code).toBe("timeout");
    expect(slow.text).toContain("The statement ran out of time.");
  });

  it("offers and serves sql only to the owner's own Main-inheriting Runs", async () => {
    const f = await fixture();
    const topic = await f.general();
    for (const token of ["owner", "shared", "connection", "program"]) {
      const names = (await (await f.connect(token)).listTools()).tools.map(({ name }) => name);
      expect(names.includes("sql"), token).toBe(token === "owner");
    }
    for (const token of ["shared", "connection", "program"]) {
      await expect(
        f.service.callTool(
          token,
          "sql",
          { query: insertHotel("X"), parameters: [topic], mode: "write" },
          {
            operationKey: `by-name-${token}`,
          },
        ),
        token,
      ).rejects.toMatchObject({ code: "forbidden" });
      const named = await (await f.connect(token)).callTool({ name: "sql", arguments: {} });
      expect(named.isError, token).toBe(true);
    }
    expect(await f.count()).toBe(0);
  });

  it("with the trial off, has no tool and refuses a call by name", async () => {
    const f = await fixture({ knowledge: false });
    expect(
      (await (await f.connect("owner")).listTools()).tools.map(({ name }) => name),
    ).not.toContain("sql");
    await expect(
      f.service.callTool("owner", "sql", {}, { operationKey: "off" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const { rows } = await sql<{ topics: string }>`
      select count(*)::text as topics from knowledge.topics
    `.execute(f.database);
    expect(rows).toEqual([{ topics: "0" }]);
  });
});
