import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { PluginService } from "../apps/host/src/plugins/plugin-service.js";
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
} from "../packages/database/src/test-database.test-support.js";
import { pluginFixtureRegistry } from "../scripts/plugin-engine/fixture.ts";
import framework from "../packages/plugin-engine/apps/package.json" with { type: "json" };

const caller = { caller: "owner:task", mode: "ask" as const };

/** An npm archive of one package whose `index.js` exports `content`. */
async function archive(directory: string, name: string, content: string) {
  const root = join(directory, name);
  await mkdir(join(root, "package"), { recursive: true });
  await writeFile(
    join(root, "package", "package.json"),
    JSON.stringify({ name, version: "1.0.0", type: "module", main: "index.js" }),
  );
  await writeFile(join(root, "package", "index.js"), content);
  const file = join(root, "package.tgz");
  execFileSync("tar", ["--format=ustar", "-czf", file, "-C", root, "package"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  return readFile(file);
}

const source = (apps: string, dependency: string) => [
  {
    path: "package.json",
    content: JSON.stringify({
      name: "framework-fixture",
      type: "module",
      dependencies: { apps, [dependency]: "1.0.0" },
    }),
  },
  {
    path: "index.ts",
    content: `
import { defineApp, object, query, router } from "apps";
import { label } from "${dependency}";
export default defineApp({}, { tools: router({
  read: query({ input: object({}) }, async () => label),
}) });`,
  },
];

test("builds every plugin against the Host's framework and checks other packages' digests", async (context) => {
  const clone = await cloneTestDatabase("host");
  const directory = await mkdtemp(join(tmpdir(), "opensteer-plugin-framework-"));
  context.onTestFinished(() => rm(directory, { force: true, recursive: true }));
  const good = await archive(directory, "fixture-label", 'export const label = "from npm";');
  const forged = await archive(directory, "fixture-forged", 'export const label = "forged";');
  const integrity = (bytes: Buffer) =>
    "sha512-" + createHash("sha512").update(bytes).digest("base64");
  const packages: Record<string, { tarball: Buffer; integrity: string }> = {
    "fixture-label": { tarball: good, integrity: integrity(good) },
    // The registry publishes one digest and serves other bytes.
    "fixture-forged": { tarball: forged, integrity: integrity(good) },
  };
  let origin = "";
  const registry = await pluginFixtureRegistry(undefined, undefined, (request, response) => {
    const name = request.url?.slice(1).replace(/\.tgz$/u, "") ?? "";
    const entry = packages[name];
    if (entry === undefined) return false;
    if (request.url?.endsWith(".tgz")) response.end(entry.tarball);
    else
      response.end(
        JSON.stringify({
          name,
          "dist-tags": { latest: "1.0.0" },
          versions: {
            "1.0.0": {
              name,
              version: "1.0.0",
              dist: { tarball: `${origin}/${name}.tgz`, integrity: entry.integrity },
            },
          },
        }),
      );
    return true;
  });
  origin = registry.origin;
  context.onTestFinished(() => registry.close());
  const service = new PluginService({
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
  });
  await ownTestDatabaseProducer(clone.url, async () => ({ close: () => service.close() }));
  context.onTestFinished(() => service.close());

  // The Host's own version, the catalog's version and one no registry has ever published.
  for (const [name, apps] of [
    ["alpha", framework.version],
    ["beta", "0.0.1-beta.140"],
    ["gamma", "99.0.0"],
  ] as const) {
    const installed = await service.install(
      { kind: "files", name, files: source(apps, "fixture-label") },
      caller,
    );
    expect(installed, `apps ${apps}`).toMatchObject({ status: "installed" });
    const called = await service.call({ calls: { path: `tools.${name}.read`, input: {} } }, caller);
    expect(called.result, `apps ${apps}`).toMatchObject({
      execution: { value: { ok: true, value: "from npm" } },
    });
  }
  const forgedInstall = await service.install(
    { kind: "files", name: "Forged", files: source(framework.version, "fixture-forged") },
    caller,
  );
  expect(JSON.stringify(forgedInstall)).toContain("does not match its published sha512 integrity");

  const host = `127.0.0.1:${new URL(registry.origin).port}`;
  expect(new Set(registry.requests.map((request) => request.slice(0, host.length)))).toEqual(
    new Set([host]),
  );
  expect(registry.requests.map((request) => request.slice(host.length)).sort()).toEqual(
    [
      "/fixture-forged",
      "/fixture-forged.tgz",
      // Each build installs its declared packages afresh.
      ...Array.from({ length: 3 }, () => ["/fixture-label", "/fixture-label.tgz"]).flat(),
    ].sort(),
  );
});
