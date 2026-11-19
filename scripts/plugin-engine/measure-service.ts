// Memory of the plugin engine in each state a person reaches. Builds the Host, then measures:
//   OPENSTEER_TEST_DATABASE_URL=<private throwaway PostgreSQL> pnpm measure:plugin-engine
// Prints resident memory (RSS) per process and, on macOS, physical footprint, in MiB.
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stagePluginEngineRuntime } from "./stage-runtime.js";
import { PluginService } from "../../apps/host/src/plugins/plugin-service.js";
import { pluginFixtureFiles, pluginFixtureProcesses, pluginFixtureRegistry } from "./fixture.ts";

const payload = await mkdtemp(join(tmpdir(), "opensteer-plugin-payload-"));
try {
  const modules = join(payload, "modules");
  const files = await stagePluginEngineRuntime(modules, process.platform, process.arch);
  const sizes = await Promise.all(
    files.map(async ({ path }) => (await stat(join(modules, path))).size),
  );
  const archive = join(payload, "payload.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", modules, "."], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  console.log("Selected external runtime payload (excludes Host/engine bundles and bridge)", {
    files: files.length,
    unpackedMiB: Math.round(sizes.reduce((sum, size) => sum + size, 0) / 1024 / 1024),
    gzipMiB: Math.round((await stat(archive)).size / 1024 / 1024),
  });
} finally {
  await rm(payload, { recursive: true, force: true });
}

if (!process.argv.includes("--payload-only")) {
  const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error("A private throwaway PostgreSQL URL is required");
  const directory = await mkdtemp(join(tmpdir(), "opensteer-plugin-measure-"));
  const registry = await pluginFixtureRegistry();
  const caller = { caller: "owner:measurement", mode: "automatic" as const };
  const options = {
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
  const mib = (kib: number) => Math.round(kib / 1024);
  const footprint = (pid: number) => {
    if (process.platform !== "darwin") return undefined;
    const output = execFileSync("footprint", ["-p", String(pid)], { encoding: "utf8" });
    const [, amount, unit] = /Footprint:\s*([\d.]+)\s*(KB|MB|GB)/u.exec(output) ?? [];
    if (!amount) return undefined;
    return Math.round(Number(amount) * (unit === "GB" ? 1024 : unit === "KB" ? 1 / 1024 : 1));
  };
  const rows: Record<string, string | number | undefined>[] = [];
  const sample = (state: string, service: PluginService) => {
    const pid = service.state().status === "ready" ? service.state().pid : undefined;
    const processes = pid === undefined ? [] : pluginFixtureProcesses(pid);
    const of = (name: string) => processes.find((row) => row.command.endsWith(name));
    const engine = processes.find((row) => row.pid === pid);
    const workerd = of("workerd");
    rows.push({
      state,
      engineRss: engine && mib(engine.rss),
      engineFootprint: engine && footprint(engine.pid),
      workerdRss: workerd && mib(workerd.rss),
      workerdFootprint: workerd && footprint(workerd.pid),
      engineAndSandboxRss: mib(processes.reduce((sum, row) => sum + row.rss, 0)),
      measurementDriverRss: Math.round(process.memoryUsage().rss / 1024 / 1024),
    });
  };
  const call = async (service: PluginService, count: number) => {
    const result = await service.call(
      { calls: { path: `tools["fixture-${count}"].read`, input: { amount: 0 } } },
      caller,
    );
    const value = result.result?.execution?.value;
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.value !== count
    )
      throw new Error(JSON.stringify(result));
  };
  let service = new PluginService(options);
  const owned = new Set<number>();
  const track = () => {
    const pid = service.state().pid;
    if (pid !== undefined) for (const row of pluginFixtureProcesses(pid)) owned.add(row.pid);
  };
  try {
    await service.start();
    sample("Host started, no plugins", service);
    const before = performance.now();
    await service.health({}, caller);
    const firstCallMs = Math.round(performance.now() - before);
    track();
    sample("engine running, no plugins", service);
    for (let count = 1; count <= 10; count += 1) {
      const installed = await service.install(
        { kind: "files", name: `Fixture ${count}`, files: pluginFixtureFiles(count) },
        caller,
      );
      if (installed.status !== "installed") throw new Error(JSON.stringify(installed));
      await call(service, count);
      if (count === 1 || count === 10) sample(`${count} built and called`, service);
    }
    track();
    await service.close();
    service = new PluginService(options);
    await service.start();
    sample("Host started, 10 plugins installed", service);
    await call(service, 1);
    track();
    sample("1 plugin in use (retained build)", service);
    for (let count = 2; count <= 10; count += 1) await call(service, count);
    sample("10 plugins in use (retained builds)", service);
    await service.execute({ code: `return await tools["fixture-1"].read({ amount: 1 });` }, caller);
    sample("10 plugins in use, after one program", service);
    track();
    console.log(`First call from idle, including engine start: ${firstCallMs} ms`);
    console.table(rows);
  } finally {
    await service.close();
    await registry.close();
    await rm(directory, { recursive: true, force: true });
    const survivors = [...owned].filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (survivors.length > 0) {
      console.error(`Processes survived shutdown: ${survivors.join(", ")}`);
      process.exitCode = 1;
    }
  }
}
