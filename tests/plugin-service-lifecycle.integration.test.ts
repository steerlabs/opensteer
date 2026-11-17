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
  const registry = await pluginFixtureRegistry(directory);
  context.onTestFinished(() => registry.close());
  const options: PluginServiceOptions = {
    processEntry: new URL("../apps/host/dist/plugin-engine.js", import.meta.url),
    bridge: new URL("../apps/host/dist/plugin-engine-bridge.json", import.meta.url).pathname,
    deployment: "personal",
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
