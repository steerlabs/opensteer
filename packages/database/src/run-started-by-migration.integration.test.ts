import { sql } from "kysely";
import { createId } from "@opensteer/core";
import { expect, it } from "vitest";
import { createDatabase } from "./connection.js";
import { runStartedByMigration, runVisibilityMigration } from "./migrations.js";
import { stampRunContext } from "./workspace-events.js";

it.runIf(Boolean(process.env.OPENSTEER_TEST_DATABASE_URL))(
  "stamps every lifecycle and backfills durable pages idempotently from the seed author",
  async () => {
    const database = createDatabase({ connectionString: process.env.OPENSTEER_TEST_DATABASE_URL! });
    try {
      await database.transaction().execute(async (tx) => {
        const runId = createId("run");
        const messageId = createId("message");
        const author = { kind: "platform", cause: "assignment-result" };
        await sql`
          create temporary table messages (id text primary key, author jsonb not null, run_id text, kind text) on commit drop;
          create temporary table runs (id text primary key, seed_input_id text not null, created_at timestamptz not null, person_waited boolean not null default false) on commit drop;
          create temporary table workspace_events (run_id text, type text, data jsonb not null) on commit drop;

        `.execute(tx);
        await sql`insert into messages values (${messageId}, ${JSON.stringify(author)}::jsonb, ${runId}, 'input')`.execute(
          tx,
        );
        await sql`insert into runs values (${runId}, ${messageId}, '2026-01-01T00:00:00Z')`.execute(
          tx,
        );
        const kinds = [
          "run.started",
          "run.status",
          "run.restarted",
          "run.phase",
          "run.completed",
          "run.failed",
          "run.interrupted",
        ];
        for (const type of kinds) {
          expect(await stampRunContext(tx, type, runId, { status: "test" })).toEqual({
            status: "test",
            startedBy: author,
            startedAt: "2026-01-01T00:00:00.000Z",
            personWaiting: false,
          });
          await sql`insert into workspace_events values (${runId}, ${type}, '{"keep": true}'::jsonb)`.execute(
            tx,
          );
        }
        await sql`insert into workspace_events values (${runId}, 'run.usage', '{"keep": true}'::jsonb)`.execute(
          tx,
        );
        await sql`insert into messages values ('steer', '{"kind":"human","userId":"test"}'::jsonb, ${runId}, 'input') on conflict do nothing`.execute(
          tx,
        );
        expect(await stampRunContext(tx, "run.failed", runId, {})).toMatchObject({
          personWaiting: true,
        });
        await runStartedByMigration.up(tx);
        const first = await sql<{
          type: string;
          data: object;
        }>`select type, data from workspace_events order by type`.execute(tx);
        await runStartedByMigration.up(tx);
        const second = await sql<{
          type: string;
          data: object;
        }>`select type, data from workspace_events order by type`.execute(tx);
        expect(second.rows).toEqual(first.rows);
        for (const row of first.rows)
          expect(row.data).toEqual(
            row.type === "run.usage"
              ? { keep: true }
              : {
                  keep: true,
                  startedBy: author,
                  startedAt: "2026-01-01T00:00:00.000Z",
                  personWaiting: true,
                },
          );
      });
    } finally {
      await database.destroy();
    }
  },
);

it.runIf(Boolean(process.env.OPENSTEER_TEST_DATABASE_URL))(
  "backfills quiet only with proof and preserves human waiting after unlinking",
  async () => {
    const database = createDatabase({ connectionString: process.env.OPENSTEER_TEST_DATABASE_URL! });
    try {
      await database.transaction().execute(async (tx) => {
        await sql`
          create schema visibility_migration_fixture;
          set local search_path to visibility_migration_fixture;
          create table messages (id text primary key, author jsonb, run_id text, kind text, thread_id text, sequence bigint);
          create table runs (id text primary key, seed_input_id text, status text, created_at timestamptz default now());
          create table workspace_events (run_id text, type text, data jsonb);
          create table delegations (parent_run_id text);
          create table requests (originating_run_id text);
          insert into messages (id, author, run_id, kind) select 'seed-' || n, '{"kind":"watch"}', null, 'input' from generate_series(1, 9) n;
          insert into runs select 'run-' || n, 'seed-' || n,
            case when n = 9 then 'running' when n = 8 then 'failed' when n = 7 then 'interrupted' else 'completed' end
            from generate_series(1, 9) n;
          update messages set author = '{"kind":"human"}' where id = 'seed-2';
          insert into messages (id, author, run_id, kind) values ('human', '{"kind":"human"}', 'run-3', 'input');
          insert into workspace_events values ('run-4', 'run.status', '{"personWaiting":true}');
          insert into messages (id, author, run_id, kind) values ('reply', '{"kind":"agent"}', 'run-5', 'assistant');
          insert into delegations values ('run-6');
          insert into requests values ('run-7');
        `.execute(tx);
        await sql`
          insert into messages (id, author, run_id, kind) select 'large-seed-' || n, '{"kind":"watch"}', null, 'input' from generate_series(1, 100000) n;
          insert into runs select 'large-run-' || n, 'large-seed-' || n, 'completed', now() from generate_series(1, 100000) n;
          insert into workspace_events select 'large-run-' || n, 'run.completed', '{"personWaiting":false}' from generate_series(1, 100000) n;
          create index on messages (run_id) where kind = 'input';
          create index on requests (originating_run_id);
          analyze messages; analyze runs; analyze workspace_events;
        `.execute(tx);
        const walStart = await sql<{
          lsn: string;
        }>`select pg_current_wal_insert_lsn()::text as lsn`.execute(tx);
        const migrationStarted = performance.now();
        await runVisibilityMigration.up(tx);
        console.info(
          "MIGRATION_BENCH",
          JSON.stringify({
            runs: 100009,
            events: 100001,
            ms: performance.now() - migrationStarted,
            walBytes: (
              await sql<{
                bytes: string;
              }>`select pg_wal_lsn_diff(pg_current_wal_insert_lsn(), ${walStart.rows[0]!.lsn}::pg_lsn)::text as bytes`.execute(
                tx,
              )
            ).rows[0]!.bytes,
          }),
        );
        const rows = await tx
          .selectFrom("runs")
          .select(["id", "personWaited", "quiet"])
          .where(sql<boolean>`id like 'run-%'`)
          .orderBy("id")
          .execute();
        expect(rows.map((r) => r.quiet)).toEqual([
          true,
          false,
          false,
          false,
          false,
          false,
          false,
          true,
          false,
        ]);
        expect(rows.map((r) => r.personWaited)).toEqual([
          false,
          true,
          true,
          true,
          false,
          false,
          false,
          false,
          false,
        ]);
        const runId = createId("run");
        await sql`insert into messages (id, author, run_id, kind) values ('waiting-seed', '{"kind":"platform","cause":"test"}', null, 'input')`.execute(
          tx,
        );
        await sql`insert into runs (id, seed_input_id, status) values (${runId}, 'waiting-seed', 'running')`.execute(
          tx,
        );
        await sql`update messages set run_id = ${runId} where id = 'human'`.execute(tx);
        expect(await stampRunContext(tx, "run.status", runId, {})).toMatchObject({
          personWaiting: true,
        });
        await sql`update messages set run_id = null where id = 'human'`.execute(tx);
        expect(await stampRunContext(tx, "run.interrupted", runId, {})).toMatchObject({
          personWaiting: true,
        });
        await sql`drop schema visibility_migration_fixture cascade`.execute(tx);
      });
    } finally {
      await database.destroy();
    }
  },
);
