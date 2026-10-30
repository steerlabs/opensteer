import { sql } from "kysely";
import { createId } from "@opensteer/core";
import { expect, it } from "vitest";
import { createDatabase } from "./connection.js";
import { runStartedByMigration } from "./migrations.js";
import { stampRunStartedBy } from "./workspace-events.js";

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
          create temporary table messages (id text primary key, author jsonb not null) on commit drop;
          create temporary table runs (id text primary key, seed_input_id text not null) on commit drop;
          create temporary table workspace_events (run_id text, type text, data jsonb not null) on commit drop;

        `.execute(tx);
        await sql`insert into messages values (${messageId}, ${JSON.stringify(author)}::jsonb)`.execute(
          tx,
        );
        await sql`insert into runs values (${runId}, ${messageId})`.execute(tx);
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
          expect(await stampRunStartedBy(tx, type, runId, { status: "test" })).toEqual({
            status: "test",
            startedBy: author,
          });
          await sql`insert into workspace_events values (${runId}, ${type}, '{"keep": true}'::jsonb)`.execute(
            tx,
          );
        }
        await sql`insert into workspace_events values (${runId}, 'run.usage', '{"keep": true}'::jsonb)`.execute(
          tx,
        );
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
            row.type === "run.usage" ? { keep: true } : { keep: true, startedBy: author },
          );
      });
    } finally {
      await database.destroy();
    }
  },
);
