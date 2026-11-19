import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { test, expect, vi } from "vitest";
import {
  PluginService,
  type PluginServiceOptions,
} from "../apps/host/src/plugins/plugin-service.js";
import { createDatabase } from "../packages/database/src/connection.js";
import framework from "../packages/plugin-engine/apps/package.json" with { type: "json" };
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
} from "../packages/database/src/test-database.test-support.js";
import { withTimeout } from "@opensteer/shared/withTimeout";
import {
  pluginFixtureFiles,
  pluginFixtureProcesses,
  pluginFixtureRegistry,
} from "../scripts/plugin-engine/fixture.ts";

const caller = { caller: "owner:task", mode: "ask" as const };
const deadline = <T>(promise: Promise<T>, message: string) =>
  withTimeout(promise, 15_000, { timeoutError: () => new Error(message) });
const stopped = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

async function fixture(context: { onTestFinished(fn: () => unknown): void }) {
  const clone = await cloneTestDatabase("host");
  const directory = await mkdtemp(join(tmpdir(), "opensteer-plugin-lifecycle-"));
  context.onTestFinished(() => rm(directory, { force: true, recursive: true }));
  const registry = await pluginFixtureRegistry();
  context.onTestFinished(() => registry.close());
  const options: PluginServiceOptions = {
    processEntry: new URL("../apps/host/dist/plugin-engine.js", import.meta.url),
    bridge: new URL("../apps/host/dist/plugin-engine-bridge.json", import.meta.url).pathname,
    databaseUrl: clone.url,
    dataDirectory: directory,
    owner: "owner",
    credentialKey: new Uint8Array(32).fill(1),
    origin: "https://fixture.invalid",
    npmRegistry: registry.origin,
    catalogUrl: registry.origin + "/catalog",
    idleMs: 0,
  };
  const open = async (extra: Partial<PluginServiceOptions> = {}) => {
    const service = new PluginService({ ...options, ...extra });
    await ownTestDatabaseProducer(clone.url, async () => ({ close: () => service.close() }));
    context.onTestFinished(() => service.close());
    return service;
  };
  return { url: clone.url, open };
}

test("starts on first use for concurrent callers and stops when idle without losing a waiting execution", async (context) => {
  const { open } = await fixture(context);
  let launches = 0;
  const service = await open({
    onState: (state) => {
      if (state.status === "starting") launches += 1;
    },
  });
  await deadline(service.start(), "Service did not settle");
  expect(service.state()).toMatchObject({ status: "idle" });
  expect(service.state().pid).toBeUndefined();

  const first = await deadline(
    Promise.all([service.health({}, caller), service.health({}, caller), service.list({}, caller)]),
    "Concurrent first calls did not complete",
  );
  expect(launches).toBe(1);
  expect(first[1].pid).toBe(first[0].pid);

  const installed = await service.install(
    { kind: "files", name: "Fixture", files: pluginFixtureFiles(1) },
    caller,
  );
  expect(installed.status).toBe("installed");
  const paused = await service.execute(
    { code: "return await tools.fixture.reviewed({ amount: 7 });" },
    caller,
  );
  expect(paused.state).toBe("waiting");
  const running = service.state().pid!;
  const processes = pluginFixtureProcesses(running);
  expect(await service.stopIfIdle()).toBe(false);
  expect(service.state()).toMatchObject({ status: "ready", pid: running });

  await service.answer({ execution: paused.id, response: { action: "accept" } }, caller);
  expect((await service.resume({ execution: paused.id }, caller)).result).toMatchObject({
    status: "completed",
    execution: { value: 8 },
  });
  expect(await service.stopIfIdle()).toBe(true);
  expect(service.state()).toMatchObject({ status: "idle" });
  for (const row of processes) expect(stopped(row.pid), `process ${row.pid} survived`).toBe(true);

  const again = await service.call(
    { calls: { path: "tools.fixture.read", input: { amount: 2 } } },
    caller,
  );
  expect(again.result).toMatchObject({ execution: { value: { ok: true, value: 3 } } });
  expect(service.state().pid).not.toBe(running);
});

test("starts at boot for a claimed scheduled run and stops once the engine has recovered it", async (context) => {
  const { url, open } = await fixture(context);
  const first = await open();
  await first.start();
  await first.health({}, caller);
  await first.close();

  const database = createDatabase({ connectionString: url, maxConnections: 1 });
  try {
    await sql`INSERT INTO plugin_engine.plugin_engine_scheduled_runs
        (id, schedule_id, app, owner, name, status, scheduled_at, started_at, runner, revision)
      VALUES ('run_lost', 'schedule_lost', 'app_lost', 'owner', 'Lost', 'running',
        now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC', 'host', 'revision')`.execute(database);
  } finally {
    await database.destroy();
  }

  const service = await open();
  await deadline(service.start(), "Engine did not start for saved work");
  const pid = service.state().pid;
  expect(service.state()).toMatchObject({ status: "ready" });
  await vi.waitFor(async () => expect(await service.stopIfIdle()).toBe(true), {
    timeout: 15_000,
    interval: 250,
  });
  expect(stopped(pid!)).toBe(true);
});

test("promotes at start a version whose deploy stopped after it migrated the plugin's database", async (context) => {
  const { url, open } = await fixture(context);
  const database = createDatabase({ connectionString: url });
  context.onTestFinished(() => database.destroy());
  /** A plugin that reads which of its tables exist; `tables` lists its migrations. */
  const files = (tables: string[]) => [
    {
      path: "package.json",
      content: JSON.stringify({
        name: "fixture-plugin",
        type: "module",
        dependencies: { apps: framework.version },
      }),
    },
    ...tables.map((table, index) => ({
      path: `migrations/000${index + 1}_${table}.sql`,
      content: `CREATE TABLE ${table} (id INTEGER);`,
    })),
    {
      path: "index.ts",
      content: `
import { defineApp, object, query, router } from "apps";
export default defineApp({}, { tools: router({
  tables: query({ input: object({}) }, async (ctx) =>
    ctx.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('first', 'second') ORDER BY name").toArray().map((row) => row.name)),
}) });`,
    },
  ];
  const tables = (service: PluginService, plugin: string) =>
    service.call({ calls: { path: `tools.${plugin}.tables`, input: {} } }, caller);
  const first = await open();
  const installed = await first.install(
    { kind: "files", name: "Pending", files: files(["first"]) },
    caller,
  );
  if (installed.status !== "installed") throw new Error(JSON.stringify(installed));
  const plugin = installed.plugin.id;
  const slug = installed.plugin.slug;
  expect((await tables(first, slug)).result).toMatchObject({
    execution: { value: { ok: true, value: ["first"] } },
  });
  // The deploy's promotion waits, after its migration ran, on a lock the test holds.
  const fence = 735158100;
  await sql
    .raw(
      `
    CREATE FUNCTION plugin_engine.test_pause_promotion() RETURNS trigger LANGUAGE plpgsql AS $pause$
    BEGIN
      IF OLD.id = '${plugin}' AND NEW.active_deployment IS DISTINCT FROM OLD.active_deployment THEN
        PERFORM pg_advisory_xact_lock(${fence});
      END IF;
      RETURN NEW;
    END;
    $pause$;
    CREATE TRIGGER test_pause_promotion BEFORE UPDATE ON plugin_engine.plugin_engine_apps
    FOR EACH ROW EXECUTE FUNCTION plugin_engine.test_pause_promotion();
  `,
    )
    .execute(database);
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const blocker = database.transaction().execute(async (tx) => {
    await sql.raw(`SELECT pg_advisory_xact_lock(${fence})`).execute(tx);
    held.resolve();
    await release.promise;
  });
  try {
    await held.promise;
    const deploying = first.install(
      { kind: "files", plugin, files: files(["first", "second"]) },
      caller,
    );
    void deploying.catch(() => {});
    await vi.waitFor(
      async () => {
        const waiting = await sql<{ blocked: boolean }>`SELECT EXISTS (
          SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = 0 AND objid = ${fence}
          AND NOT granted) AS blocked`.execute(database);
        expect(waiting.rows[0]?.blocked).toBe(true);
      },
      { timeout: 30_000, interval: 100 },
    );
    // The version is saved as pending; the old one is still active.
    const pending = await sql<{ active: string; pending: string | null }>`
      SELECT active_deployment AS active, pending_deployment AS pending
      FROM plugin_engine.plugin_engine_apps WHERE id = ${plugin}`.execute(database);
    expect(pending.rows[0]).toMatchObject({
      active: installed.version.id,
      pending: expect.any(String),
    });
    // The engine stops between the migration and the promotion.
    const pid = first.state().pid!;
    process.kill(pid, "SIGKILL");
    await first.close();
  } finally {
    release.resolve();
    await blocker;
    await sql`DROP TRIGGER test_pause_promotion ON plugin_engine.plugin_engine_apps`.execute(
      database,
    );
  }
  // The next engine promotes the pending version before it serves the plugin.
  const again = await open();
  expect((await tables(again, slug)).result).toMatchObject({
    execution: { value: { ok: true, value: ["first", "second"] } },
  });
  const promoted = await sql<{ active: string; pending: string | null }>`
    SELECT active_deployment AS active, pending_deployment AS pending
    FROM plugin_engine.plugin_engine_apps WHERE id = ${plugin}`.execute(database);
  expect(promoted.rows[0]?.pending).toBeNull();
  expect(promoted.rows[0]?.active).not.toBe(installed.version.id);
  expect(await again.versions({ plugin }, caller)).toHaveLength(2);
});
