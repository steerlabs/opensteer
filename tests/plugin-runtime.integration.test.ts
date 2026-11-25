import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { parseHostConfig } from "../packages/config/src/index.js";
import { createDatabase } from "../packages/database/src/connection.js";
import { seedPersonalOwnerResources } from "../packages/database/src/personal-fixture.test-support.js";
import { personalDeploymentOwner } from "../packages/database/src/machine-store.js";
import { apiVersionHeaders } from "../packages/deployment-authority/src/index.js";
import { createId } from "../packages/core/src/index.js";
import {
  bundleNodeService,
  stagePluginRuntime,
  stageSharpRuntime,
} from "../apps/desktop/scripts/build-personal-runtime.js";
import { personalRuntimeLayout as layout } from "../apps/desktop/scripts/personal-runtime-layout.js";
import { hostProcessEntries } from "../apps/host/src/process-entries.js";
import type { createHostRuntime } from "../apps/host/src/runtime/runtime.js";
import { freePort } from "@opensteer/shared/test-support/loopbackPort";
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
} from "../packages/database/src/test-database.test-support.js";
import {
  pluginFixtureFiles,
  pluginFixtureProcesses,
  pluginFixtureRegistry,
} from "../scripts/plugin-engine/fixture.js";

const deadline = <T>(work: Promise<T>, message: string) =>
  withTimeout(work, 20_000, { timeoutError: () => new Error(message) });

test.skipIf(process.platform === "win32")(
  "starts a personal Host from packaged modules, installs and executes a plugin, and stops its children",
  async (context) => {
    const clone = await cloneTestDatabase("host");
    const directory = await realpath(await mkdtemp(join(tmpdir(), "opensteer-packaged-plugins-")));
    context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const registry = await pluginFixtureRegistry();
    context.onTestFinished(() => registry.close());
    const staged = join(directory, "runtime");
    const main = join(directory, "host-entry.ts");
    await writeFile(
      main,
      `export { createHostRuntime } from ${JSON.stringify(resolve("apps/host/src/runtime/runtime.ts"))};`,
    );
    await bundleNodeService(
      join(staged, layout.hostScript),
      "host",
      main,
      Object.fromEntries(
        Object.entries(hostProcessEntries.processes).map(([name, entry]) => [
          name,
          resolve("apps/host", entry),
        ]),
      ),
    );
    const architecture = process.arch === "x64" ? "amd64" : "arm64";
    if (!["darwin", "linux", "win32"].includes(process.platform))
      throw new Error("No desktop target for this test");
    const platform = process.platform as "darwin" | "linux" | "win32";
    await stagePluginRuntime(staged, platform, architecture);
    await stageSharpRuntime(staged, platform, architecture);
    await copyFile(
      resolve("apps/host/dist/plugin-engine-bridge.json"),
      join(staged, layout.pluginBridge),
    );
    const modules = join(staged, `${layout.pluginBridge}.modules`);
    await cp(resolve("apps/host/dist/plugin-engine-bridge.json.modules"), modules, {
      recursive: true,
    });
    const compiler = join(modules, "compiler");
    const heldCompiler = join(directory, "compiler");
    await rename(compiler, heldCompiler);
    await mkdir(compiler);
    // Use Node's ESM loader for the staged bundle, bypassing Vitest's source transforms.
    const bundled = createRequire(import.meta.url)(join(staged, layout.hostScript)) as {
      createHostRuntime: typeof createHostRuntime;
    };
    const port = await freePort();
    const data = join(directory, "data");
    const config = parseHostConfig({
      OPENSTEER_MODE: "development",
      OPENSTEER_DEPLOYMENT_KIND: "personal",
      OPENSTEER_DATABASE_URL: clone.url,
      OPENSTEER_AUTH_SECRET: randomBytes(48).toString("base64url"),
      OPENSTEER_LOCAL_OWNER_CLAIM_TOKEN: randomBytes(32).toString("base64url"),
      OPENSTEER_LOCAL_PASSWORD_ENABLED: "false",
      OPENSTEER_HOST_DATA_DIR: data,
      OPENSTEER_AGENT_HOME: join(directory, "agent-home"),
      OPENSTEER_HOSTING_ENVIRONMENT_ID: createId("environment"),
      OPENSTEER_PORT: String(port),
      OPENSTEER_BIND_ADDRESS: "127.0.0.1",
      OPENSTEER_CANONICAL_ORIGIN: `http://127.0.0.1:${port}`,
      OPENSTEER_NATIVE_FS_HELPER: resolve("apps/runner/native-fs-helper/opensteer-native-fs"),
    });
    const host = await ownTestDatabaseProducer(clone.url, async () => {
      const runtime = await bundled.createHostRuntime(config, {
        pluginEngine: { npmRegistry: registry.origin, catalogUrl: registry.origin + "/catalog" },
      });
      return { runtime, close: () => runtime.close() };
    });
    context.onTestFinished(() => host.close());
    expect(host.runtime.kind).toBe("personal");
    if (host.runtime.kind !== "personal") throw new Error("Expected personal Host");
    await host.runtime.listen();
    const claimed = await host.runtime.app.inject({
      method: "POST",
      url: "/v1/rpc/auth.setup.claim",
      headers: { origin: config.canonicalOrigin.origin, ...apiVersionHeaders() },
      payload: { kind: "local-machine-owner", token: config.identity.localOwnerClaimToken },
    });
    expect(claimed.statusCode, claimed.body).toBe(200);
    const database = createDatabase({ connectionString: clone.url });
    try {
      const deployment = await database
        .selectFrom("deployments")
        .select("id")
        .executeTakeFirstOrThrow();
      const userId = await personalDeploymentOwner(database);
      if (!userId) throw new Error("Personal owner was not claimed");
      await seedPersonalOwnerResources(database, {
        deploymentId: deployment.id,
        userId,
        path: join(directory, "agent-home"),
      });
    } finally {
      await database.destroy();
    }
    const plugins = host.runtime.plugins;
    const caller = { caller: "personal", mode: "automatic" } as const;
    const started = await deadline(
      plugins.health({}, caller),
      "Packaged Host needed the compiler at startup",
    );
    const startedWorkerd = pluginFixtureProcesses(started.pid).find(
      (child) => basename(child.command) === "workerd",
    );
    if (!startedWorkerd) throw new Error("Packaged workerd process was missing at startup");
    const compilerEntry = join(heldCompiler, "main.js");
    await cp(heldCompiler, compiler, {
      recursive: true,
      filter: (source) => source !== compilerEntry,
    });
    const install = () =>
      plugins.install(
        {
          kind: "files",
          name: "Fixture",
          files: [
            ...pluginFixtureFiles(1),
            {
              path: "ui/index.html",
              content:
                '<link rel="stylesheet" href="./style.css"><p class="text-fixture">Fixture</p>',
            },
            {
              path: "ui/style.css",
              content: "@theme { --color-fixture: #123456; } @tailwind utilities;",
            },
          ],
        },
        caller,
      );
    expect(
      await deadline(install(), "Build with a missing compiler file did not settle"),
    ).toMatchObject({
      status: "build-error",
      error: { message: expect.stringContaining("The packaged compiler module is unavailable.") },
    });
    await copyFile(compilerEntry, join(compiler, "main.js"));
    const installed = await deadline(install(), "Packaged Host did not install the fixture");
    expect(installed.status, JSON.stringify(installed)).toBe("installed");
    expect(
      (await plugins.call({ calls: { path: "tools.fixture.read", input: { amount: 2 } } }, caller))
        .result,
    ).toMatchObject({ status: "completed", execution: { value: { ok: true, value: 3 } } });
    expect(
      (await plugins.execute({ code: "return await tools.fixture.read({ amount: 4 });" }, caller))
        .result,
    ).toMatchObject({ status: "completed", execution: { value: 5 } });
    const health = await plugins.health({}, caller);
    expect(health.pid).toBe(started.pid);
    const children = pluginFixtureProcesses(health.pid);
    const workerd = children.find((child) => basename(child.command) === "workerd");
    if (!workerd) throw new Error("Packaged workerd process was missing");
    expect(workerd.pid).toBe(startedWorkerd.pid);
    const binary = join(
      staged,
      layout.serviceModules,
      `@cloudflare/workerd-${platform}-${process.arch === "x64" ? "64" : "arm64"}/bin/workerd`,
    );
    const argumentsFor = (pid: number) =>
      execFileSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" });
    expect(argumentsFor(workerd.pid).startsWith(binary + " ")).toBe(true);
    expect(argumentsFor(health.pid)).toContain(join(staged, layout.pluginEngineScript));
    console.log("Packaged plugin processes", { engine: health.pid, workerd: workerd.pid, binary });
    await deadline(host.close(), "Packaged Host did not stop");
    for (const child of children) expect(() => process.kill(child.pid, 0)).toThrow();
    await rename(binary, `${binary}.unavailable`);
    const unavailable = await ownTestDatabaseProducer(clone.url, async () => {
      const runtime = await bundled.createHostRuntime(config);
      return { runtime, close: () => runtime.close() };
    });
    context.onTestFinished(() => unavailable.close());
    await unavailable.runtime.listen();
    if (unavailable.runtime.kind !== "personal") throw new Error("Expected personal Host");
    await unavailable.runtime.plugins.start();
    expect(unavailable.runtime.plugins.state()).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("workerd"),
    });
    await expect(unavailable.runtime.plugins.health({}, caller)).rejects.toMatchObject({
      code: "unavailable",
    });
    await deadline(unavailable.close(), "Host without workerd did not stop");
  },
);
