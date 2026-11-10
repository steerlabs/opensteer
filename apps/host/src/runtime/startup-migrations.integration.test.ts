import * as migrations from "@opensteer/database";
import { createDatabase } from "@opensteer/database";
import { failDatabaseContainment } from "@opensteer/database/test-support/database";
import { sql } from "kysely";
import { Migrator } from "kysely/migration";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { describe, expect, it, type TestContext } from "vitest";
import { freePort, machineAccessHostConfig } from "./machine-access.test-support.js";
import { createHostRuntime } from "./runtime.js";

const integration = process.env.OPENSTEER_TEST_DATABASE_URL ? describe : describe.skip;

// Genuine cold/upgrade shapes must depend on the production startup migrator.
// Removing the startup migration call fails cold startup or the full-history assertion.
integration("production startup migrations", () => {
  it.for(["empty", "historical"])(
    "starts a truly %s database and restarts idempotently",
    async (state: string, context: TestContext) => {
      const name = `opensteer_startup_${randomUUID().replaceAll("-", "")}`;
      const url = new URL(process.env.OPENSTEER_TEST_DATABASE_URL!);
      url.pathname = "/postgres";
      const admin = createDatabase({ connectionString: url.toString(), maxConnections: 1 });
      url.pathname = `/${name}`;
      const database = createDatabase({ connectionString: url.toString() });
      const dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-startup-host-"));
      let runtime: Awaited<ReturnType<typeof createHostRuntime>> | undefined;
      context.onTestFinished(async () => {
        try {
          await runtime?.close();
          await closeStartupDatabase(database, admin, name);
        } finally {
          await admin.destroy();
          await rm(dataDirectory, { recursive: true, force: true });
        }
      });
      await sql`create database ${sql.id(name)} template template0`.execute(admin);
      const names = Object.keys(await migrations.migrationProvider().getMigrations()).sort();
      if (state === "historical") {
        const result = await new Migrator({
          db: database,
          provider: migrations.migrationProvider(),
        }).migrateTo(names.at(-2)!);
        expect(result.error).toBeUndefined();
        expect((await sql`select name from kysely_migration`.execute(database)).rows).toHaveLength(
          names.length - 1,
        );
      }
      await sql`create table startup_sentinel (value text); insert into startup_sentinel values ('preserved')`.execute(
        database,
      );
      const config = machineAccessHostConfig(
        await freePort(),
        dataDirectory,
        new URL("http://127.0.0.1:9"),
        url.toString(),
        "invite-only",
      );
      runtime = await createHostRuntime(config);
      const first = await sql<{
        name: string;
        timestamp: string;
      }>`select name, timestamp from kysely_migration order by name`.execute(database);
      expect(first.rows.map(({ name: migration }) => migration)).toEqual(names);
      expect((await sql`select value from startup_sentinel`.execute(database)).rows).toEqual([
        { value: "preserved" },
      ]);
      // The knowledge trial is off: nothing about it may exist in this database.
      expect(
        (
          await sql<{ trace: string }>`
            select 'schema' as trace from pg_catalog.pg_namespace where nspname = 'knowledge'
            union all
            select 'login ' || rolname from pg_catalog.pg_roles
            where rolname = 'opensteer_knowledge_executor_' || (
              select oid from pg_catalog.pg_database where datname = current_database())
            union all
            select 'grant or object of ' || r.rolname from pg_catalog.pg_shdepend d
            join pg_catalog.pg_roles r on r.oid = d.refobjid
            where d.dbid = (select oid from pg_catalog.pg_database where datname = current_database())
              and r.rolname like 'opensteer\\_knowledge\\_%'
          `.execute(database)
        ).rows,
      ).toEqual([]);
      await runtime.close();
      runtime = undefined;
      runtime = await createHostRuntime(config);
      expect(
        (await sql`select name, timestamp from kysely_migration order by name`.execute(database))
          .rows,
      ).toEqual(first.rows);
      expect((await sql`select value from startup_sentinel`.execute(database)).rows).toEqual([
        { value: "preserved" },
      ]);
      const evidence = await mkdtemp(join(tmpdir(), "opensteer-startup-migrations-"));
      await writeFile(
        join(evidence, `${state}.json`),
        JSON.stringify(
          { state, migrations: first.rows, restarted: true, sentinel: "preserved" },
          null,
          2,
        ),
      );
      console.info(`Startup migration evidence: ${evidence}`);
    },
  );

  it("waits for closing clients before dropping a startup database", async (context) => {
    const name = `opensteer_startup_${randomUUID().replaceAll("-", "")}`;
    const url = new URL(process.env.OPENSTEER_TEST_DATABASE_URL!);
    url.pathname = "/postgres";
    const admin = createDatabase({ connectionString: url.toString() });
    url.pathname = `/${name}`;
    const database = createDatabase({ connectionString: url.toString() });
    const pool = new Pool({ connectionString: url.toString(), max: 1 });
    const errors: Error[] = [];
    pool.on("error", (error: Error) => errors.push(error));
    let dropping: Promise<void> | undefined;
    let dropped = false;
    context.onTestFinished(async () => {
      try {
        if (!pool.ending) await pool.end();
        await (dropping ?? closeStartupDatabase(database, admin, name));
      } finally {
        await admin.destroy();
      }
    });
    await sql`create database ${sql.id(name)} template template0`.execute(admin);
    await pool.query("select 1");
    await sql`select 1`.execute(database);
    dropping = closeStartupDatabase(database, admin, name).then(() => {
      dropped = true;
    });
    // Gate on the server observing teardown, rather than sleeping long enough
    // for a force-drop to race the client's delayed disconnect.
    await expect
      .poll(async () => {
        const active = await sql`
          select 1 from pg_stat_activity
          where query = ${`drop database if exists "${name}"`}
            and state = 'active'
        `.execute(admin);
        return dropped || active.rows.length > 0;
      })
      .toBe(true);
    expect(
      errors.map((error) => `${"code" in error ? error.code : "unknown"}: ${error.message}`),
      "teardown must not terminate an idle pooled client",
    ).toEqual([]);
    expect(dropped, "teardown must not terminate a client whose disconnect is pending").toBe(false);
    await pool.end();
    await dropping;
    expect(errors).toEqual([]);
    expect(
      (await sql`select 1 from pg_database where datname = ${name}`.execute(admin)).rows,
    ).toEqual([]);
  });
});

async function closeStartupDatabase(
  database: ReturnType<typeof createDatabase>,
  admin: ReturnType<typeof createDatabase>,
  name: string,
): Promise<void> {
  try {
    await database.destroy();
    // pg-pool.end() can resolve before Client.end() finishes. Ordinary DROP
    // waits for those disconnects and fails if a session remains, rather than
    // sending 57P01 to an idle client whose pool has already ended.
    await sql`drop database if exists ${sql.id(name)}`.execute(admin);
  } catch (error) {
    failDatabaseContainment(error);
  }
}
