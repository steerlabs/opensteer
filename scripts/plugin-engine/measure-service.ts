import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginService } from "../../apps/host/src/plugins/plugin-service.js";
import { pluginFixtureFiles, pluginFixtureProcesses, pluginFixtureRegistry } from "./fixture.ts";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("A private throwaway PostgreSQL URL is required");
const directory = await mkdtemp(join(tmpdir(), "opensteer-plugin-measure-"));
const registry = await pluginFixtureRegistry(directory);
const caller = { caller: "owner:measurement", mode: "automatic" as const };
const before = performance.now();
const options = {
  deployment: "personal",
  owner: "owner",
  credentialKey: new Uint8Array(32).fill(1),
  databaseUrl,
  dataDirectory: directory,
  origin: "https://fixture.invalid",
  npmRegistry: registry.origin,
  catalogUrl: registry.origin + "/catalog",
  processEntry: new URL("../../apps/host/dist/plugin-engine.js", import.meta.url),
  bridge: new URL("../../apps/host/dist/plugin-engine-bridge.json", import.meta.url).pathname,
} as const;
let service = new PluginService(options);
const ready = service.start();
const synchronousStartupMs = performance.now() - before;
try {
  await ready;
  const health = await service.health({}, caller);
  const samples = [{ plugins: 0, processes: pluginFixtureProcesses(health.pid) }];
  const readyMs = performance.now() - before;
  for (let count = 1; count <= 10; count += 1) {
    const name = `Fixture ${count}`;
    const installed = await service.install(
      { kind: "files", name, files: pluginFixtureFiles(count) },
      caller,
    );
    if (installed.status !== "installed") throw new Error(JSON.stringify(installed));
    const result = await service.call(
      { calls: { path: `tools["fixture-${count}"].read`, input: { amount: 0 } } },
      caller,
    );
    const value = result.result?.execution?.value;
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.ok !== true ||
      value.value !== count
    )
      throw new Error(JSON.stringify(result));
    if (count === 1 || count === 3 || count === 10)
      samples.push({ plugins: count, processes: pluginFixtureProcesses(health.pid) });
  }
  await service.close();
  service = new PluginService(options);
  await service.start();
  const restoredHealth = await service.health({}, caller);
  const restored = [{ plugins: 0, processes: pluginFixtureProcesses(restoredHealth.pid) }];
  for (let count = 1; count <= 10; count += 1) {
    const result = await service.call(
      { calls: { path: `tools["fixture-${count}"].read`, input: { amount: 0 } } },
      caller,
    );
    const value = result.result?.execution?.value;
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.ok !== true ||
      value.value !== count
    )
      throw new Error(JSON.stringify(result));
    if (count === 1 || count === 3 || count === 10)
      restored.push({ plugins: count, processes: pluginFixtureProcesses(restoredHealth.pid) });
  }
  console.log(
    JSON.stringify(
      {
        runtimeLimits: {
          workers: process.env.PLUGIN_ENGINE_APP_WORKERS ?? "64",
          idleSeconds: process.env.PLUGIN_ENGINE_APP_WORKER_IDLE_SECONDS ?? "300",
        },
        synchronousStartupMs,
        readyMs,
        engineStartupMs: health.startupMs,
        samples,
        restored,
      },
      null,
      2,
    ),
  );
} finally {
  const owned =
    service.state().pid === undefined ? [] : pluginFixtureProcesses(service.state().pid!);
  await service.close();
  assertStopped(owned);
  await registry.close();
  await rm(directory, { recursive: true, force: true });
}
function assertStopped(owned: ReturnType<typeof pluginFixtureProcesses>) {
  for (const row of owned) {
    try {
      process.kill(row.pid, 0);
      throw new Error(`Process ${row.pid} survived service shutdown`);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
}
