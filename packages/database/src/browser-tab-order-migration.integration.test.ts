/** Upgrade can use the latest session's date, leave legacy tabs null, or precompute personal order. */
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { expect, it } from "vitest";
import { createDatabase } from "./connection.js";
import { browserTabOrderMigration } from "./migrations.js";

it.runIf(Boolean(process.env.OPENSTEER_TEST_DATABASE_URL))(
  "backfills tab recording time from the lineage root and leaves personal order unmaterialized",
  async () => {
    const database = createDatabase({ connectionString: process.env.OPENSTEER_TEST_DATABASE_URL! });
    try {
      const result = await database.transaction().execute(async (tx) => {
        // Temporary upgrade tables shadow the worker's current schema on this connection only.
        await sql`
          create temporary table browser_sessions (id text primary key, created_at timestamptz not null) on commit drop;
          create temporary table workspace_tabs (id text primary key, group_id text not null, session_id text not null) on commit drop;
          create temporary table browser_tab_layouts (owner_id text primary key, revision bigint not null default 0) on commit drop;
          insert into browser_sessions values ('root', '2025-01-02T03:04:05Z'), ('restored', '2026-10-25T12:00:00Z');
          insert into workspace_tabs values ('saved', 'root', 'restored');
          insert into browser_tab_layouts (owner_id) values ('person');
        `.execute(tx);
        await browserTabOrderMigration.up(tx);
        const legacy = await sql<{
          createdAt: Date;
        }>`select created_at from workspace_tabs where id = 'saved'`.execute(tx);
        const layouts = await sql<{
          tabOrder: string[] | null;
        }>`select tab_order from browser_tab_layouts`.execute(tx);
        await sql`insert into workspace_tabs (id, group_id, session_id) values ('new', 'root', 'restored')`.execute(
          tx,
        );
        const fresh = await sql<{
          createdAt: Date;
        }>`select created_at from workspace_tabs where id = 'new'`.execute(tx);
        return { legacy: legacy.rows, layouts: layouts.rows, fresh: fresh.rows };
      });
      expect(result.legacy[0]?.createdAt.toISOString()).toBe("2025-01-02T03:04:05.000Z");
      expect(result.layouts).toEqual([{ tabOrder: null }]);
      expect(result.fresh[0]?.createdAt.getTime()).toBeGreaterThan(Date.parse("2026-01-01"));
      const directory = await mkdtemp(join(tmpdir(), "opensteer-tab-order-upgrade-"));
      await writeFile(
        join(directory, "journey.json"),
        JSON.stringify(
          {
            gitSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
            command:
              "pnpm test:integration packages/database/src/browser-tab-order-migration.integration.test.ts",
            result,
          },
          null,
          2,
        ),
      );
    } finally {
      await database.destroy();
    }
  },
);
