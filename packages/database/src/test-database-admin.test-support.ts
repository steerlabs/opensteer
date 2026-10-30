import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Pool, type PoolClient } from "pg";
import { z } from "zod";
import { createDatabase } from "./connection.js";
import { migrateToLatest } from "./migrations.js";

export type TestDatabaseAuthority = "host" | "controlPlane";
export const testDatabaseRunSchema = z
  .object({
    run: z.string().regex(/^[a-f0-9]{16}$/u),
    directory: z.string(),
    host: z.url(),
    controlPlane: z.url(),
  })
  .superRefine((run, context) => {
    for (const authority of ["host", "controlPlane"] as const) {
      const expected = `opensteer_it_${run.run}_${authority === "host" ? "host" : "control"}_template`;
      if (new URL(run[authority]).pathname !== `/${expected}`)
        context.addIssue({
          code: "custom",
          message: "Template does not belong to this test run",
          path: [authority],
        });
    }
  });
export type TestDatabaseRun = z.infer<typeof testDatabaseRunSchema>;
const ownedDatabaseSchema = z.object({
  name: z
    .string()
    .regex(/^opensteer_it_[a-f0-9]{16}_(host|control)_(template|[0-9]+|clone_[a-f0-9]{16})$/u),
  authority: z.enum(["host", "controlPlane"]),
});

export function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  url.searchParams.delete("options");
  return url.toString();
}

export function databaseAdministrator(url: string): Pool {
  return new Pool({
    connectionString: databaseUrl(url, "postgres"),
    application_name: "opensteer-test-database-admin",
    max: 1,
    connectionTimeoutMillis: 2_000,
    query_timeout: 5_000,
  });
}

export function templateDatabasePool(url: string): {
  pool: Pool;
  close: (end: () => Promise<void>) => Promise<void>;
} {
  const pool = new Pool({ connectionString: url, application_name: "opensteer-test-template" });
  const clients = new Set<PoolClient>();
  let drained: (() => void) | undefined;
  pool.on("connect", (client) => clients.add(client));
  pool.on("remove", (client) => {
    clients.delete(client);
    if (clients.size === 0) drained?.();
  });
  return {
    pool,
    close: async (end) => {
      // pg.Pool.end resolves after initiating removal, before clients close.
      const closed = new Promise<void>((resolve) => {
        drained = resolve;
        if (clients.size === 0) resolve();
      });
      await end();
      await closed;
    },
  };
}

export async function dropOwnedDatabase(pool: Pool, name: string): Promise<void> {
  ownedDatabaseSchema.shape.name.parse(name);
  const exists = await pool.query("select 1 from pg_database where datname = $1", [name]);
  if (exists.rowCount) {
    // Fence reconnects before draining. A leaked body retains only this unique URL.
    await pool.query(`alter database "${name}" allow_connections false`);
    const deadline = performance.now() + 250;
    while (performance.now() < deadline) {
      const sessions = await pool.query("select 1 from pg_stat_activity where datname = $1", [
        name,
      ]);
      if (!sessions.rowCount) break;
      await delay(10);
    }
    await pool.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1", [
      name,
    ]);
    await pool.query(`drop database "${name}" with (force)`);
  }
  const remaining = await pool.query(
    "select 1 from pg_stat_activity where datname = $1 union all select 1 from pg_database where datname = $1",
    [name],
  );
  if (remaining.rowCount) throw new Error(`Database or sessions remain after dropping ${name}`);
}

export function recordOwnedDatabase(
  run: TestDatabaseRun,
  authority: TestDatabaseAuthority,
  name: string,
): void {
  const record = ownedDatabaseSchema.parse({ authority, name });
  if (!name.startsWith(`opensteer_it_${run.run}_`))
    throw new Error("Database belongs to another test run");
  writeFileSync(join(run.directory, `${name}.json`), JSON.stringify(record), { flag: "wx" });
}

export function ownedDatabases(run: TestDatabaseRun) {
  return readdirSync(run.directory)
    .filter((name) => name.endsWith(".json"))
    .map((file) => {
      // The filename is reserved before CREATE, even if a worker dies while
      // writing the receipt. All ownership information is encoded in that name.
      const name = file.slice(0, -5);
      const record = ownedDatabaseSchema.parse({
        name,
        authority: name.startsWith(`opensteer_it_${run.run}_host_`) ? "host" : "controlPlane",
      });
      if (!record.name.startsWith(`opensteer_it_${run.run}_`))
        throw new Error("Database belongs to another test run");
      return record;
    });
}

export async function createTestDatabaseRun(
  urls: { readonly host: string; readonly controlPlane: string },
  options: {
    readonly recorded?: (run: TestDatabaseRun) => void;
    readonly cleaned?: (success: boolean) => void;
    readonly migrate?: (authority: TestDatabaseAuthority, url: string) => Promise<void>;
  } = {},
) {
  const run = randomBytes(8).toString("hex");
  const directory = mkdtempSync(join(tmpdir(), `opensteer-databases-${run}-`));
  const templates: TestDatabaseRun = {
    run,
    directory,
    host: databaseUrl(urls.host, `opensteer_it_${run}_host_template`),
    controlPlane: databaseUrl(urls.controlPlane, `opensteer_it_${run}_control_template`),
  };
  const pools = {
    host: databaseAdministrator(urls.host),
    controlPlane: databaseAdministrator(urls.controlPlane),
  };
  async function cleanup() {
    const failures: unknown[] = [];
    try {
      for (const { authority, name } of ownedDatabases(templates).toReversed()) {
        try {
          await dropOwnedDatabase(pools[authority], name);
        } catch (error) {
          failures.push(error);
        }
      }
    } catch (error) {
      failures.push(error);
    } finally {
      const results = await Promise.allSettled(Object.values(pools).map((pool) => pool.end()));
      for (const result of results) if (result.status === "rejected") failures.push(result.reason);
      options.cleaned?.(failures.length === 0);
    }
    if (failures.length) {
      process.exitCode = 1;
      throw new AggregateError(failures, "Integration database cleanup failed");
    }
  }
  async function create(authority: TestDatabaseAuthority, name: string, template: string) {
    // Authentication must succeed before this authority can own any DDL.
    const client = await pools[authority].connect();
    try {
      // Record before CREATE so teardown also covers interruption during DDL.
      recordOwnedDatabase(templates, authority, name);
      options.recorded?.(templates);
      await client.query(`create database "${name}" template "${template}"`);
    } finally {
      client.release();
    }
    return databaseUrl(urls[authority], name);
  }
  try {
    for (const authority of ["host", "controlPlane"] as const) {
      const name = new URL(templates[authority]).pathname.slice(1);
      await create(authority, name, "template0");
      if (options.migrate) {
        await options.migrate(authority, templates[authority]);
      } else if (authority === "host") {
        const template = templateDatabasePool(templates.host);
        const database = createDatabase({ connectionString: templates.host }, template.pool);
        try {
          await migrateToLatest(database);
        } finally {
          await template.close(() => database.destroy());
        }
      } else {
        // The app owns its schema and migrator. Its production migration entry
        // point closes the pool before exiting and seeds no Account identity.
        await promisify(execFile)(
          process.execPath,
          [
            "--import",
            "tsx",
            fileURLToPath(
              new URL("../../../apps/control-plane/src/migrate-main.ts", import.meta.url),
            ),
          ],
          {
            env: { ...process.env, OPENSTEER_CONTROL_PLANE_DATABASE_URL: templates.controlPlane },
            timeout: 30_000,
            killSignal: "SIGKILL",
          },
        );
      }
      // Row-lock tests need this in every checker mode. Installing it once here
      // gives worker databases and per-test clones the same observation support.
      const template = templateDatabasePool(templates[authority]);
      try {
        await template.pool.query("create extension if not exists pgrowlocks with schema public");
      } finally {
        await template.close(() => template.pool.end());
      }
      // No runtime has booted: templates contain schema, never an installation.
      await pools[authority].query(`alter database "${name}" allow_connections false`);
      // Autovacuum may still be analyzing the fresh schema; it is no leak, and
      // cloning the template signals it to stop.
      const sessions = await pools[authority].query(
        "select 1 from pg_stat_activity where datname = $1 and backend_type = 'client backend'",
        [name],
      );
      if (sessions.rowCount) throw new Error(`Template ${name} still has connections`);
    }
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Template setup and cleanup failed");
    }
    throw error;
  }
  return { templates, pools, create, cleanup };
}
