import { Kysely, PostgresDialect, sql } from "kysely";
import { Migrator } from "kysely/migration";
import { Client, Pool } from "pg";
import * as checker from "./lock-order-checker.test-support.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as lockOrder from "./lock-order.js";
const integration = process.env.OPENSTEER_TEST_DATABASE_URL ? describe : describe.skip;
integration("PostgreSQL global lock order checker", () => {
  const client = new Client({
    connectionString: process.env.OPENSTEER_TEST_DATABASE_URL,
  });
  const inheritedMode = process.env.OPENSTEER_LOCK_ORDER_MODE;
  beforeAll(async () => {
    process.env.OPENSTEER_LOCK_ORDER_MODE = "enforce";
    await client.connect();
    await client.query("create temporary table client_sync_state (id text primary key, name text)");
    await client.query("create temporary table threads (id text primary key, name text)");
    await client.query("create temporary table commands (id text primary key, name text)");
    await client.query("insert into commands values ('a', 'A')");
    await client.query("insert into client_sync_state values ('a', 'A'), ('b', 'B')");
    await client.query("insert into threads values ('a', 'A'), ('b', 'B')");
  });
  afterAll(async () => {
    await client.end();
    if (inheritedMode === undefined) delete process.env.OPENSTEER_LOCK_ORDER_MODE;
    else process.env.OPENSTEER_LOCK_ORDER_MODE = inheritedMode;
  });
  it.each([
    "select * from client_sync_state for update",
    "select * from client_sync_state for no key update",
    "select * from client_sync_state order by id for share",
    "select w.id from client_sync_state as w join threads as t on w.id=t.id for share of w",
    "update client_sync_state set name = 'changed' where id = 'a'",
    "delete from client_sync_state where id = 'a'",
    "insert into client_sync_state values ('a', 'changed') on conflict (id) do update set name=excluded.name",
    "select * from client_sync_state FOR /* a fence */ UPDATE",
  ])("rejects Thread then Deployment: %s", async (statement) => {
    await client.query("begin");
    try {
      await client.query("select * from threads where id='a' for no key update");
      await expect(client.query(statement)).rejects.toThrow(
        /lock order.*threads.*client_sync_state/is,
      );
    } finally {
      await client.query("rollback");
    }
  });
  it.each([
    ["KEY SHARE", "KEY SHARE", false],
    ["KEY SHARE", "SHARE", false],
    ["KEY SHARE", "NO KEY UPDATE", false],
    ["KEY SHARE", "UPDATE", true],
    ["SHARE", "KEY SHARE", false],
    ["SHARE", "SHARE", false],
    ["SHARE", "NO KEY UPDATE", true],
    ["SHARE", "UPDATE", true],
    ["NO KEY UPDATE", "KEY SHARE", false],
    ["NO KEY UPDATE", "SHARE", true],
    ["NO KEY UPDATE", "NO KEY UPDATE", true],
    ["NO KEY UPDATE", "UPDATE", true],
    ["UPDATE", "KEY SHARE", true],
    ["UPDATE", "SHARE", true],
    ["UPDATE", "NO KEY UPDATE", true],
    ["UPDATE", "UPDATE", true],
  ] as const)(
    "enforces a reversed %s -> %s edge only when modes conflict (%s)",
    async (held, requested, conflicts) => {
      await client.query("begin");
      try {
        await client.query(`select * from threads where id='a' for ${held}`);
        const acquisition = client.query(
          `select * from client_sync_state where id='a' for ${requested}`,
        );
        if (conflicts)
          await expect(acquisition).rejects.toThrow(/lock order.*threads.*client_sync_state/is);
        else
          await expect(acquisition).resolves.toMatchObject({
            rowCount: 1,
          });
      } finally {
        await client.query("rollback");
      }
    },
  );
  it.each([
    {
      name: "compatible readers",
      expected: false,
      paths: [
        ["client_sync_state", "threads", "SHARE", "SHARE"],
        ["threads", "client_sync_state", "SHARE", "SHARE"],
      ],
    },
    {
      name: "opposite readers and writers",
      expected: true,
      paths: [
        ["client_sync_state", "threads", "SHARE", "SHARE"],
        ["threads", "client_sync_state", "UPDATE", "UPDATE"],
      ],
    },
    {
      name: "three transaction cycle",
      expected: true,
      paths: [
        ["client_sync_state", "threads", "NO KEY UPDATE", "SHARE"],
        ["threads", "commands", "NO KEY UPDATE", "SHARE"],
        ["commands", "client_sync_state", "NO KEY UPDATE", "SHARE"],
      ],
    },
    {
      name: "compatible junction",
      expected: false,
      paths: [
        ["client_sync_state", "threads", "UPDATE", "KEY SHARE"],
        ["threads", "client_sync_state", "KEY SHARE", "UPDATE"],
      ],
    },
    {
      name: "separate databases",
      expected: false,
      separateDatabases: true,
      paths: [
        ["client_sync_state", "threads", "UPDATE", "UPDATE"],
        ["threads", "client_sync_state", "UPDATE", "UPDATE"],
      ],
    },
    {
      name: "mixed three transaction cycle",
      expected: true,
      paths: [
        ["client_sync_state", "threads", "NO KEY UPDATE", "NO KEY UPDATE"],
        ["threads", "commands", "SHARE", "KEY SHARE"],
        ["commands", "client_sync_state", "UPDATE", "SHARE"],
      ],
    },
    {
      name: "same Host paths in different test databases",
      expected: true,
      separateDatabases: true,
      applicationGraph: true,
      paths: [
        ["client_sync_state", "threads", "NO KEY UPDATE", "NO KEY UPDATE"],
        ["threads", "client_sync_state", "SHARE", "SHARE"],
      ],
    },
    {
      name: "Host and Account schema paths remain separate",
      expected: false,
      separateDatabases: true,
      applicationGraph: true,
      accountSchema: true,
      paths: [
        ["client_sync_state", "threads", "NO KEY UPDATE", "NO KEY UPDATE"],
        ["threads", "client_sync_state", "SHARE", "SHARE"],
      ],
    },
  ])(
    "finds all-length conflicting cycles: $name",
    async ({ expected, paths, separateDatabases, applicationGraph, accountSchema }) => {
      await checker.withLockOrderMode("record", async () => {
        const start = checker.recordedLockOrderEdges.length;
        try {
          for (const [from, to, held, requested] of paths) {
            await client.query("begin");
            await client.query(`select * from ${from} where id='a' for ${held}`);
            await client.query(`select * from ${to} where id='a' for ${requested}`);
            await client.query("commit");
          }
          const analyze = Reflect.get(
            checker,
            applicationGraph ? "findConflictingApplicationLockCycles" : "findConflictingLockCycles",
          );
          expect(analyze).toBeTypeOf("function");
          expect(
            analyze(
              checker.recordedLockOrderEdges.slice(start).map((edge, index) => ({
                ...edge,
                ...(separateDatabases
                  ? {
                      database: `database-${index}`,
                    }
                  : {}),
                ...(accountSchema && index === 1
                  ? {
                      from: `control-plane:${edge.from}`,
                      to: `control-plane:${edge.to}`,
                    }
                  : {}),
              })),
            ).length > 0,
          ).toBe(expected);
        } finally {
          await client.query("rollback");
        }
      });
    },
  );
  it("commits a read-only transaction on a Device while fixture truncation waits for it", async () => {
    const blocker = new Client({ connectionString: process.env.OPENSTEER_TEST_DATABASE_URL });
    await blocker.connect();
    const pid = (await blocker.query("select pg_backend_pid() as pid")).rows[0]!.pid as number;
    let truncating: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      await client.query("begin");
      await client.query("set local lock_timeout = '5s'");
      await client.query("select * from public.devices");
      await blocker.query("begin");
      await blocker.query("set local lock_timeout = '5s'");
      truncating = Promise.allSettled([
        blocker.query(
          "truncate table credential_vault_canaries, deployments,users,runners restart identity cascade",
        ),
      ]);
      await vi.waitFor(async () => {
        const waiting = await client.query(
          "select exists(select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock') as waiting",
          [pid],
        );
        expect(
          waiting.rows[0]!.waiting,
          "Fixture truncation never waited on the Device reader",
        ).toBe(true);
      });
      const results = [
        ...(await Promise.allSettled([client.query("commit")])),
        ...(await truncating),
      ];
      for (const result of results) expect(result).toMatchObject({ status: "fulfilled" });
    } finally {
      await client.query("rollback");
      await truncating;
      await blocker.query("rollback");
      await blocker.end();
    }
  });
  it.each([
    "update threads set name='deferred' where id='a'",
    "select pg_temp.phase3m_queue_deferred()",
    "do $$ begin perform pg_temp.phase3m_queue_deferred(); end $$",
  ])("checks deferred trigger acquisitions before COMMIT: %s", async (statement) => {
    await client.query(
      "create function pg_temp.phase3m_deferred_deployment() returns trigger language plpgsql as $$ begin perform id from pg_temp.client_sync_state where id='a' for share; return new; end $$",
    );
    await client.query(
      "create constraint trigger phase3m_deferred_deployment after update on threads deferrable initially deferred for each row execute function pg_temp.phase3m_deferred_deployment()",
    );
    await client.query(
      "create function pg_temp.phase3m_queue_deferred() returns void language plpgsql as $$ begin update pg_temp.threads set name='deferred' where id='a'; end $$",
    );
    try {
      await client.query("begin");
      await client.query("select * from threads where id='a' for no key update");
      await client.query(statement);
      await expect(client.query("commit")).rejects.toThrow(
        /lock order.*threads.*client_sync_state/is,
      );
    } finally {
      await client.query("rollback");
      await client.query("drop function pg_temp.phase3m_queue_deferred()");
      await client.query("drop trigger phase3m_deferred_deployment on threads");
      await client.query("drop function pg_temp.phase3m_deferred_deployment()");
    }
  });
  it("accepts ordered acquisition and already held rows", async () => {
    await client.query("begin");
    try {
      await client.query("select * from client_sync_state where id='a' for no key update");
      await client.query("select * from threads where id='a' for no key update");
      await client.query("update client_sync_state set name='changed' where id='a'");
    } finally {
      await client.query("rollback");
    }
  });
  it("checks a large ordered batch in linear work and records one edge per statement and mode", async () => {
    const start = checker.recordedLockOrderEdges.length;
    await client.query(
      "insert into threads select 'bulk-' || lpad(i::text, 4, '0'), 'Bulk' from generate_series(1, 1000) i",
    );
    await client.query("begin");
    try {
      await client.query("select * from client_sync_state order by id for no key update");
      const ranks = vi.spyOn(lockOrder, "databaseLockRank");
      const batch = await client.query("select * from threads order by id for no key update");
      expect(batch.rowCount).toBe(1002);
      expect(ranks.mock.calls.length).toBeLessThan(4 * batch.rowCount!);
      ranks.mockRestore();
      expect(checker.recordedLockOrderEdges.slice(start)).toHaveLength(1);
      await expect(
        client.query("select * from commands where id='a' for no key update"),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(client.query("select * from threads where id='a' for update")).rejects.toThrow(
        /lock order.*commands.*threads/is,
      );
    } finally {
      vi.restoreAllMocks();
      await client.query("rollback");
      await client.query("delete from threads where id like 'bulk-%'");
    }
  });
  it("retains separate acquisitions with identical SQL and different bound row IDs", async () => {
    const start = checker.recordedLockOrderEdges.length;
    await client.query("begin");
    try {
      for (const id of ["a", "b"])
        await client.query("select * from client_sync_state where id=$1 for no key update", [id]);
      await client.query("select * from threads order by id for no key update");
      const edges = checker.recordedLockOrderEdges.slice(start);
      expect(edges).toHaveLength(2);
      expect(new Set(edges.map((edge) => edge.heldKey)).size).toBe(2);
    } finally {
      await client.query("rollback");
    }
  });
  it("does not mistake a previously held table for a previously held row", async () => {
    await client.query("begin");
    try {
      await client.query("select * from client_sync_state where id='a' for no key update");
      await client.query("select * from threads where id='a' for no key update");
      await expect(
        client.query("select * from client_sync_state where id='b' for no key update"),
      ).rejects.toThrow(/lock order/is);
    } finally {
      await client.query("rollback");
    }
  });
  it("isolates successive transactions and ignores empty locks and new private rows", async () => {
    await client.query("begin");
    await client.query("select * from threads order by id for share");
    await client.query("commit");
    await client.query("begin");
    try {
      await client.query("select * from client_sync_state order by id for share");
      await client.query("select * from threads order by id for share");
      await client.query("update client_sync_state set name='empty' where id='missing'");
      await client.query("insert into client_sync_state values ('private', 'new')");
      await client.query("update client_sync_state set name='private' where id='private'");
    } finally {
      await client.query("rollback");
    }
  });
  it("does not treat a subquery ORDER BY as ordering a multi-row UPDATE", async () => {
    await client.query("begin");
    try {
      await expect(
        client.query(
          "update client_sync_state set name='changed' where id in (select id from client_sync_state order by id)",
        ),
      ).rejects.toThrow(/unordered multi-row/is);
    } finally {
      await client.query("rollback");
    }
  });
  it("accepts a multi-row UPDATE of rows an ordered read already fenced", async () => {
    await client.query("begin");
    try {
      await client.query("select * from client_sync_state order by id for no key update");
      await client.query("update client_sync_state set name='changed' where id in ('a', 'b')");
    } finally {
      await client.query("rollback");
    }
  });
  it("refuses data-modifying statements whose row locks it cannot see", async () => {
    await client.query("begin");
    try {
      await expect(
        client.query(
          "with changed as (update client_sync_state set name='changed' where id='a' returning id) select * from changed",
        ),
      ).rejects.toThrow(/cannot classify/is);
    } finally {
      await client.query("rollback");
    }
  });
  it("rejects descending new row IDs in a table", async () => {
    await client.query("begin");
    try {
      await client.query("select * from client_sync_state where id='b' for no key update");
      await expect(
        client.query("select * from client_sync_state where id='a' for no key update"),
      ).rejects.toThrow(/lock order/is);
    } finally {
      await client.query("rollback");
    }
  });
  it("checks row locks acquired inside installed functions and triggers", async () => {
    await client.query(
      "create function pg_temp.phase3m_lock_deployment() returns void language plpgsql as $$ begin perform id from pg_temp.client_sync_state where id='a' for share; end $$",
    );
    await client.query(
      "create function pg_temp.phase3m_lock_deployment_trigger() returns trigger language plpgsql as $$ begin perform pg_temp.phase3m_lock_deployment(); return new; end $$",
    );
    await client.query(
      "create trigger phase3m_lock_deployment before update on threads for each row execute function pg_temp.phase3m_lock_deployment_trigger()",
    );
    try {
      for (const statement of [
        "select pg_temp.phase3m_lock_deployment()",
        "update threads set name='trigger' where id='a'",
      ]) {
        await client.query("begin");
        try {
          await client.query("select * from threads where id='a' for no key update");
          await expect(client.query(statement)).rejects.toThrow(
            /lock order.*threads.*client_sync_state/is,
          );
        } finally {
          await client.query("rollback");
        }
      }
    } finally {
      await client.query("drop trigger phase3m_lock_deployment on threads");
      await client.query("drop function pg_temp.phase3m_lock_deployment_trigger()");
      await client.query("drop function pg_temp.phase3m_lock_deployment()");
    }
  });
  it("checks a trigger's remaining targets after another target is dropped mid-transaction", async () => {
    await client.query("create temporary table parity_gone (id text primary key)");
    await client.query(
      "create function pg_temp.parity_two_targets() returns trigger language plpgsql as $$ begin if false then perform id from pg_temp.parity_gone; end if; perform id from pg_temp.client_sync_state where id='a' for share; return new; end $$",
    );
    await client.query(
      "create trigger parity_two_targets after update on threads for each row execute function pg_temp.parity_two_targets()",
    );
    try {
      await client.query("begin");
      try {
        await client.query("drop table pg_temp.parity_gone");
        await expect(client.query("update threads set name='gone' where id='a'")).rejects.toThrow(
          /lock order.*threads.*client_sync_state/is,
        );
      } finally {
        await client.query("rollback");
      }
    } finally {
      await client.query("drop trigger parity_two_targets on threads");
      await client.query("drop function pg_temp.parity_two_targets()");
      await client.query("drop table if exists pg_temp.parity_gone");
    }
  });
  it("rejects a trigger that takes the Deployment fence after writing settings", async () => {
    await client.query("create temporary table personal_settings (id text primary key, name text)");
    await client.query("insert into personal_settings values ('a', 'A')");
    await client.query(
      "create function pg_temp.parity_settings_deployment() returns trigger language plpgsql as $$ begin perform id from pg_temp.client_sync_state where id='a' for share; return new; end $$",
    );
    await client.query(
      "create trigger parity_settings_deployment after update on personal_settings for each row execute function pg_temp.parity_settings_deployment()",
    );
    try {
      await client.query("begin");
      try {
        await expect(
          client.query("update personal_settings set name='changed' where id='a'"),
        ).rejects.toThrow(/lock order.*personal_settings.*client_sync_state/is);
      } finally {
        await client.query("rollback");
      }
    } finally {
      await client.query("drop table pg_temp.personal_settings");
      await client.query("drop function pg_temp.parity_settings_deployment()");
    }
  });
  it("keys rows of a table without a primary key by their position", async () => {
    await client.query("create temporary table messages (name text)");
    await client.query("insert into messages values ('a'), ('b')");
    try {
      await client.query("begin");
      try {
        await client.query("select * from messages where name='b' for no key update");
        await expect(
          client.query("select * from messages where name='a' for no key update"),
        ).rejects.toThrow(/descending messages IDs/is);
      } finally {
        await client.query("rollback");
      }
    } finally {
      await client.query("drop table pg_temp.messages");
    }
  });
  it("attributes each locked row to its own table when one statement locks several", async () => {
    const start = checker.recordedLockOrderEdges.length;
    await client.query("begin");
    try {
      await client.query("select * from client_sync_state where id='b' for no key update");
      await client.query(
        "select t.id from threads t join commands c on c.id='a' where t.id='b' for share of t, c",
      );
      const edges = checker.recordedLockOrderEdges
        .slice(start)
        .map(({ from, to, heldKey, requestedKey }) => ({
          from,
          to,
          heldKey,
          requestedKey,
        }));
      expect(edges).toEqual(
        expect.arrayContaining([
          {
            from: "client_sync_state",
            to: "threads",
            heldKey: '["b"]',
            requestedKey: '["b"]',
          },
          {
            from: "client_sync_state",
            to: "commands",
            heldKey: '["b"]',
            requestedKey: '["a"]',
          },
          {
            from: "threads",
            to: "commands",
            heldKey: '["b"]',
            requestedKey: '["a"]',
          },
        ]),
      );
      expect(edges).toHaveLength(3);
    } finally {
      await client.query("rollback");
    }
  });
  it("rereads a function whose body was replaced between transactions", async () => {
    await client.query(
      "create function pg_temp.parity_replaced() returns void language plpgsql as $$ begin perform id from pg_temp.client_sync_state where id='a' for share; end $$",
    );
    try {
      await client.query("begin");
      try {
        await client.query("select * from threads where id='a' for no key update");
        await expect(client.query("select pg_temp.parity_replaced()")).rejects.toThrow(
          /lock order.*threads.*client_sync_state/is,
        );
      } finally {
        await client.query("rollback");
      }
      await client.query(
        "create or replace function pg_temp.parity_replaced() returns void language plpgsql as $$ begin perform id from pg_temp.commands where id='a' for share; end $$",
      );
      const start = checker.recordedLockOrderEdges.length;
      await client.query("begin");
      try {
        await client.query("select * from threads where id='a' for no key update");
        await client.query("select pg_temp.parity_replaced()");
        expect(checker.recordedLockOrderEdges.slice(start)).toEqual([
          expect.objectContaining({
            from: "threads",
            to: "commands",
            heldMode: "NO KEY UPDATE",
            requestedMode: "SHARE",
          }),
        ]);
      } finally {
        await client.query("rollback");
      }
    } finally {
      await client.query("drop function pg_temp.parity_replaced()");
    }
  });
  it("leaves a migration's batches unchecked and checks the next transaction", async () => {
    // One connection, so the migration's temporary tables are the ones checked afterwards.
    const database = new Kysely<unknown>({
      dialect: new PostgresDialect({
        pool: new Pool({
          connectionString: process.env.OPENSTEER_TEST_DATABASE_URL,
          max: 1,
        }),
      }),
    });
    const schema = "lock_order_checker_migration";
    try {
      const migrator = new Migrator({
        db: database,
        migrationTableSchema: schema,
        provider: {
          getMigrations: async () => ({
            "0001_reversed_locks": {
              up: async (transaction) => {
                await sql
                  .raw(
                    "create temporary table client_sync_state (id text primary key, name text); create temporary table threads (id text primary key, name text); insert into client_sync_state values ('a', 'A'), ('b', 'B'); insert into threads values ('a', 'A'); select id from threads where id='a' for no key update; update client_sync_state set name='migrated' where id in ('a', 'b')",
                  )
                  .execute(transaction);
              },
            },
          }),
        },
      });
      const { error, results } = await migrator.migrateToLatest();
      expect(error).toBeUndefined();
      expect(results).toEqual([
        expect.objectContaining({
          status: "Success",
        }),
      ]);
      await expect(
        database.transaction().execute(async (transaction) => {
          await sql`select * from threads where id='a' for no key update`.execute(transaction);
          await sql`select * from client_sync_state where id='a' for share`.execute(transaction);
        }),
      ).rejects.toThrow(/lock order.*threads.*client_sync_state/is);
    } finally {
      await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(database);
      await database.destroy();
    }
  });
  it("checks every OF target, including the second alias", async () => {
    await client.query("begin");
    try {
      await client.query("select * from threads where id='a' for no key update");
      await expect(
        client.query(
          "select t.id from threads t join client_sync_state w using(id) where t.id='a' for share of t, w",
        ),
      ).rejects.toThrow(/lock order.*threads.*client_sync_state/is);
    } finally {
      await client.query("rollback");
    }
  });
  it.each([
    "select t.id from threads t, client_sync_state w where t.id='a' and w.id='a' for share of t, w",
    "select t.id from threads as t, pg_temp.client_sync_state as w where t.id='a' and w.id='a' for share",
    "select t.id from threads t join commands c on c.id='a', client_sync_state w where t.id='a' and w.id='a' for share of w",
  ])("checks a comma-separated FROM relation: %s", async (statement) => {
    await client.query("begin");
    try {
      await client.query("select * from threads where id='a' for no key update");
      await expect(client.query(statement)).rejects.toThrow(
        /lock order.*threads.*client_sync_state/is,
      );
    } finally {
      await client.query("rollback");
    }
  });
  it.each([
    "select t.id from threads t, unnest(array['a']) as u(id) where t.id=u.id for share of t",
    "select t.id from threads t, lateral (select t.id as id) x where t.id='a' for share of t",
    "select t.id from threads t, (select 'a' as id) x where t.id=x.id for share of t",
    "with picked as (select 'a' as id) select t.id from threads t, picked where t.id=picked.id for share of t",
    "with picked as materialized (select 'a' as id) select t.id from threads t, picked where t.id=picked.id for share",
    "select t.id from threads t where t.id in ('a', 'b') order by t.id for share",
  ])("does not take a comma-separated non-relation for a lock target: %s", async (statement) => {
    await client.query("begin");
    try {
      await expect(client.query(statement)).resolves.toMatchObject({
        rowCount: expect.any(Number),
      });
    } finally {
      await client.query("rollback");
    }
  });
  it("does not let an ordered batch extend backwards from a held row", async () => {
    await client.query("begin");
    try {
      await client.query("select * from client_sync_state where id='b' for no key update");
      await expect(
        client.query("select * from client_sync_state order by id for no key update"),
      ).rejects.toThrow(/lock order/is);
    } finally {
      await client.query("rollback");
    }
  });
  it("separates Main Runner admission from enrollment idempotency", async () => {
    await client.query("begin");
    try {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        "deployment-main-runner-enrollment",
      ]);
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        JSON.stringify(["user", "runner-enrollment-idempotency", "request"]),
      ]);
    } finally {
      await client.query("rollback");
    }
  });
  it("rejects Main Runner admission after enrollment idempotency", async () => {
    await client.query("begin");
    try {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        JSON.stringify(["user", "runner-enrollment-idempotency", "request"]),
      ]);
      await expect(
        client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
          "deployment-main-runner-enrollment",
        ]),
      ).rejects.toThrow(/lock order/is);
    } finally {
      await client.query("rollback");
    }
  });
  it("resolves advisory key expressions rather than treating parameters as the key", async () => {
    await client.query("begin");
    try {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", ["dep_a"]);
      await expect(
        client.query(
          "select pg_advisory_xact_lock(hashtextextended('opensteer:account-deployment-quota:' || $1, 0))",
          ["user_a"],
        ),
      ).rejects.toThrow(/lock order/is);
    } finally {
      await client.query("rollback");
    }
  });
  it("record mode preserves every requested mode and continues beyond a reversal", async () => {
    await checker.withLockOrderMode("record", async () => {
      try {
        await client.query("begin");
        await client.query("select * from threads where id='a' for share");
        await client.query("update client_sync_state set name='mode' where id='a'");
        await client.query("select * from client_sync_state where id='b' for key share");
        await client.query("delete from threads where id='b'");
        const edges = Reflect.get(checker, "recordedLockOrderEdges");
        expect(edges).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              from: "threads",
              to: "client_sync_state",
              heldMode: "SHARE",
              requestedMode: "NO KEY UPDATE",
            }),
            expect.objectContaining({
              from: "threads",
              to: "client_sync_state",
              heldMode: "SHARE",
              requestedMode: "KEY SHARE",
            }),
            expect.objectContaining({
              from: "client_sync_state",
              to: "threads",
              heldMode: "NO KEY UPDATE",
              requestedMode: "UPDATE",
            }),
          ]),
        );
      } finally {
        await client.query("rollback");
      }
    });
  });
  it("records an upgrade of an already held row instead of silently reusing its old mode", async () => {
    await checker.withLockOrderMode("record", async () => {
      try {
        await client.query("begin");
        await client.query("select * from client_sync_state where id='a' for share");
        await client.query("select * from threads where id='a' for no key update");
        await client.query("update client_sync_state set name='upgrade' where id='a'");
        expect(Reflect.get(checker, "recordedLockOrderEdges")).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              from: "threads",
              to: "client_sync_state",
              heldMode: "NO KEY UPDATE",
              requestedMode: "NO KEY UPDATE",
            }),
          ]),
        );
      } finally {
        await client.query("rollback");
      }
    });
  });
  it("records no lock order in off mode but still every deadlock and serialization failure", async () => {
    const pool = new Pool({
      connectionString: process.env.OPENSTEER_TEST_DATABASE_URL,
      max: 2,
    });
    try {
      await checker.withLockOrderMode("off", async () => {
        const edges = checker.recordedLockOrderEdges.length;
        const violations = checker.recordedLockOrderViolations.length;
        await client.query("begin");
        try {
          await client.query("select * from threads where id='a' for no key update");
          await expect(
            client.query("select * from client_sync_state where id='a' for no key update"),
          ).resolves.toMatchObject({
            rowCount: 1,
          });
        } finally {
          await client.query("rollback");
        }
        expect(checker.recordedLockOrderEdges.slice(edges)).toEqual([]);
        expect(checker.recordedLockOrderViolations.slice(violations)).toEqual([]);
        checker.takeTransactionConflicts();
        await pool.query("create table lock_order_off_conflicts (id text primary key, n int)");
        const [first, second] = [await pool.connect(), await pool.connect()];
        try {
          await first.query("insert into lock_order_off_conflicts values ('a', 0), ('b', 0)");
          await first.query("begin isolation level repeatable read");
          await first.query("select * from lock_order_off_conflicts");
          await second.query("update lock_order_off_conflicts set n = 1 where id = 'a'");
          await expect(
            first.query("update lock_order_off_conflicts set n = 2 where id = 'a'"),
          ).rejects.toMatchObject({
            code: "40001",
          });
          await first.query("rollback");
          for (const connection of [first, second]) await connection.query("begin");
          await first.query("update lock_order_off_conflicts set n = 3 where id = 'a'");
          await second.query("update lock_order_off_conflicts set n = 3 where id = 'b'");
          const crossed = await Promise.allSettled([
            first.query("update lock_order_off_conflicts set n = 4 where id = 'b'"),
            second.query("update lock_order_off_conflicts set n = 4 where id = 'a'"),
          ]);
          expect(crossed.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
          for (const connection of [first, second]) await connection.query("rollback");
          expect(
            checker
              .takeTransactionConflicts()
              .map(({ code }) => code)
              .sort(),
          ).toEqual(["40001", "40P01"]);
        } finally {
          first.release();
          second.release();
          await pool.query("drop table lock_order_off_conflicts");
        }
      });
    } finally {
      await pool.end();
    }
  });
  it("observes a scope opened before its transaction, under any inherited mode", async () => {
    const start = checker.recordedLockOrderEdges.length;
    await checker.withLockOrderMode("off", () =>
      checker.withLockOrderMode("enforce", async () => {
        await client.query("begin");
        try {
          await client.query("select * from client_sync_state where id='a' for no key update");
          await client.query("select * from threads where id='a' for no key update");
        } finally {
          await client.query("rollback");
        }
      }),
    );
    expect(checker.recordedLockOrderEdges.slice(start)).toEqual([
      expect.objectContaining({
        from: "client_sync_state",
        to: "threads",
      }),
    ]);
  });
  it("repairs pgrowlocks after schema recreation on the same client", async () => {
    await client.query("begin");
    await client.query("rollback");
    await client.query("create schema phase3m_checker_extension");
    await client.query("alter extension pgrowlocks set schema phase3m_checker_extension");
    await client.query("drop schema phase3m_checker_extension cascade");
    try {
      await client.query("begin");
      await expect(
        client.query("select * from client_sync_state where id='a' for share"),
      ).resolves.toMatchObject({
        rowCount: 1,
      });
    } finally {
      await client.query("rollback");
      await client.query("create extension if not exists pgrowlocks");
    }
  });
  it("keeps disjoint advisory key domains out of one shared identity vertex", async () => {
    await checker.withLockOrderMode("record", async () => {
      try {
        await client.query("begin");
        for (const key of [
          "browser-source-pairing:owner",
          "browser-sources-owner:owner",
          "browser-profile:owner",
          "browser-grants:owner",
          "integration-grant:owner:w:i",
        ]) {
          await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
        }
        await client.query("select * from threads where id='a' for share");
        const edges = Reflect.get(checker, "recordedLockOrderEdges");
        expect(edges).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              from: "advisory:browser-source-pairing",
              to: "advisory:browser-sources-owner",
            }),
            expect.objectContaining({
              from: "advisory:browser-profile",
              to: "advisory:browser-grants",
            }),
            expect.objectContaining({
              from: "advisory:browser-grants",
              to: "advisory:integration-grant",
            }),
          ]),
        );
      } finally {
        await client.query("rollback");
      }
    });
  });
  it("preserves transaction batches while checking each mutation target", async () => {
    await checker.withLockOrderMode("record", async () => {
      try {
        await client.query("begin");
        await expect(
          client.query(
            "insert into threads values ('batch', 'new'); update client_sync_state set name='batch' where id='a'; update threads set name='batch' where id='a';",
          ),
        ).resolves.toMatchObject([
          {
            rowCount: 1,
          },
          {
            rowCount: 1,
          },
          {
            rowCount: 1,
          },
        ]);
        expect(Reflect.get(checker, "recordedLockOrderEdges")).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              from: "client_sync_state",
              to: "threads",
              heldMode: "NO KEY UPDATE",
              requestedMode: "NO KEY UPDATE",
            }),
          ]),
        );
      } finally {
        await client.query("rollback");
      }
    });
  });
  it("tracks a pinned session advisory across transaction boundaries until unlock", async () => {
    await checker.withLockOrderMode("record", async () => {
      try {
        await client.query(
          "select pg_advisory_lock(hashtextextended('opensteer-connect:dep_checker', 0))",
        );
        await client.query("begin");
        await client.query("select * from client_sync_state where id='a' for no key update");
        await client.query("commit");
        expect(Reflect.get(checker, "recordedLockOrderEdges")).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              from: "advisory:connect",
              to: "client_sync_state",
              heldMode: "UPDATE",
              requestedMode: "NO KEY UPDATE",
            }),
          ]),
        );
        await client.query(
          "select pg_advisory_unlock(hashtextextended('opensteer-connect:dep_checker', 0))",
        );
        checker.recordedLockOrderEdges.splice(0);
        await client.query("begin");
        await client.query("select * from client_sync_state where id='a' for no key update");
        expect(checker.recordedLockOrderEdges).toEqual([]);
      } finally {
        await client.query("rollback");
        await client.query("select pg_advisory_unlock_all()");
      }
    });
  });
});
