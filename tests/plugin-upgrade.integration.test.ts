import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sql } from "kysely";
import { expect, test, vi, type TestContext } from "vitest";
import { Schema } from "effect";
import { UiUpdating } from "apps/ui/contracts";
import { PluginService } from "../apps/host/src/plugins/plugin-service.js";
import { createDatabase, PluginAgentStore } from "../packages/database/src/index.js";
import { seedPersonalFixture } from "../packages/database/src/personal-fixture.test-support.js";
import { recordPluginAuthor } from "../packages/database/src/plugin-agent-store.test-support.js";
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
} from "../packages/database/src/test-database.test-support.js";
import { pluginFixtureRegistry } from "../scripts/plugin-engine/fixture.ts";
import { rewriteUpstreamSource } from "@opensteer/plugin-engine-catalog";
import names from "../packages/plugin-engine/upstream-names.json" with { type: "json" };

// The old names come from the rules data; this file names none itself.
const old = (scope: string, suffix = "") => {
  const rule = names.rules.find(
    (candidate) => candidate.scope === scope && candidate.from.endsWith(suffix),
  );
  if (rule === undefined) throw new Error(scope);
  return rule.from;
};
const caller = { caller: "owner:task", mode: "ask" as const };

/**
 * A plugin as the Host on the baseline built it: written for upstream's names, with a page, a
 * schedule, a manual webhook and a package from the registry. `dependency` names the package.
 */
const source = (framework: string, dependency: string) => [
  {
    path: "package.json",
    content: JSON.stringify({
      name: `${old("package")}upgrade-fixture`,
      type: "module",
      [old("manifest-key")]: { title: "Upgrade fixture" },
      dependencies: { apps: framework, [dependency]: "1.0.0" },
    }),
  },
  {
    path: "migrations/0001_notes.sql",
    content: `CREATE TABLE notes (body TEXT NOT NULL);\nINSERT INTO notes (body) SELECT body FROM ${old("reserved-table", "_legacy_rows")};\n`,
  },
  {
    path: "index.ts",
    content: `
import { defineApp, defineProvider, secrets, object, string, query, mutation, router, dynamicRouter, userInterval, workflow } from "apps";
import { always } from "apps/operations/approval";
import { label } from "${dependency}";
const service = defineProvider({ name: "Upgrade fixture", auth: { key: secrets({ label: "API key", fields: object({ token: string() }) }) } });
const add = mutation({ input: object({ body: string() }) }, async (ctx, { body }) => {
  ctx.sql.exec("INSERT INTO notes (body) VALUES (?)", body);
  return body;
});
const reviewed = mutation({ input: object({ body: string() }), approval: always() }, async (ctx, { body }) => {
  ctx.sql.exec("INSERT INTO notes (body) VALUES (?)", body);
  return body;
});
const count = query({ input: object({}) }, async (ctx) => ctx.sql.exec("SELECT count(*) AS total FROM notes").one().total);
export default defineApp({ user: { accounts: { service } } }, {
  tools: router({
    add,
    reviewed,
    count,
    evaluated: dynamicRouter({
      list: () => [{ name: "runtime", description: "evaluated:" + Date.now(), readOnly: true, inputSchema: { type: "object" } }],
      resolve: () => count,
    }),
    notes: query({ input: object({}) }, async (ctx) => ({
      notes: ctx.sql.exec("SELECT body FROM notes ORDER BY rowid").toArray().map((row) => row.body),
      applied: ctx.sql.exec("SELECT count(*) AS applied FROM ${old("reserved-table", "_migrations")}").one().applied,
      token: ctx.user.accounts.service.fields.token,
      label,
    })),
  }),
  schedules: {
    tick: userInterval({ minutes: 60 }, add, { body: "schedule" }),
    approved: userInterval({ minutes: 60 }, reviewed, { body: "approved" }),
  },
  workflows: { counted: workflow({ input: object({}) }, async (ctx) => ctx.step.runQuery("count", count, {})) },
  webhooks: { incoming: { account: { user: "service" }, config: object({}), state: object({}),
    setup: { instructions: "Paste the callback and signing secret at the provider.", signingSecret: ${JSON.stringify(old("signing-secret"))} },
    handle: async () => new Response("ok"),
  } },
});`,
  },
  {
    path: "ui/index.html",
    content:
      "<!doctype html><html><head><title>Upgrade page</title></head><body>Upgrade page</body></html>",
  },
];

/**
 * Drives the baseline's Host: installs the plugin that keeps working and the one that stops
 * building, then gives the first an account, data, a schedule and a completed manual setup.
 */
const driver = `
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { sql } from "kysely";
import { createDatabase } from "./packages/database/src/index.ts";
import { PluginService } from "./apps/host/src/plugins/plugin-service.ts";
import { pluginFixtureRegistry } from "./scripts/plugin-engine/fixture.ts";
const [databaseUrl, dataDirectory, registryDirectory, workDirectory, resultFile] = process.argv.slice(2);
const caller = { caller: "owner:task", mode: "ask" };
const packages = {
  "upgrade-label": await readFile(workDirectory + "/label.tgz"),
  "upgrade-broken": await readFile(workDirectory + "/broken.tgz"),
};
let origin = "";
const registry = await pluginFixtureRegistry(registryDirectory, undefined, undefined, (request, response) => {
  const name = (request.url ?? "").slice(1).replace(/\\.tgz$/u, "");
  const tarball = packages[name];
  if (tarball === undefined) return false;
  if (request.url.endsWith(".tgz")) response.end(tarball);
  else response.end(JSON.stringify({ name, "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { name, version: "1.0.0",
    dist: { tarball: origin + "/" + name + ".tgz", integrity: "sha512-" + createHash("sha512").update(tarball).digest("base64") } } } }));
  return true;
});
origin = registry.origin;
const service = new PluginService({
  processEntry: new URL("./apps/host/dist/plugin-engine.js", import.meta.url),
  bridge: new URL("./apps/host/dist/plugin-engine-bridge.json", import.meta.url).pathname,
  databaseUrl, dataDirectory, owner: "owner", credentialKey: new Uint8Array(32).fill(1),
  origin: "https://fixture.invalid", webhookOrigin: async () => "https://hooks.fixture.invalid",
  npmRegistry: registry.origin, catalogUrl: registry.origin + "/catalog", idleMs: 0,
  // While \`queueing\`, background work is refused its standing authority, so a started workflow
  // run is saved and stays queued, never handed to the workflow engine.
  authorize: async (input) => ({
    allowed: (input.caller === "owner" || input.caller.startsWith("owner:")) && !(queueing && input.operation === "background"),
  }),
});
let queueing = false;
const db = createDatabase({ connectionString: databaseUrl });
try {
  await service.start();
  const install = async (name, file) => {
    const installed = await service.install({ kind: "files", name, files: JSON.parse(await readFile(workDirectory + "/" + file, "utf8")) }, caller);
    if (installed.status !== "installed") throw new Error(JSON.stringify(installed));
    return installed;
  };
  const installed = await install("Upgrade", "upgrade.json");
  const broken = await install("Broken", "broken.json");
  const plugin = installed.plugin.id;
  const provider = installed.plugin.requirements.accounts.service.provider;
  const account = await service.createApiKeyAccount({ provider, method: "key", fields: { token: "synthetic" }, key: "upgrade-account" }, caller);
  const target = { plugin, requirement: "service", scope: "user" };
  const consent = await service.reviewAccountLink(target, caller);
  await service.linkAccount({ ...target, account: account.id, consent }, caller);
  const added = await service.call({ calls: { path: "tools.upgrade.add", input: { body: "before" } } }, caller);
  await service.manage({ operation: "schedules.configure", input: { app: plugin, name: "tick", enabled: true, key: "upgrade-schedule" } }, caller);
  let webhook;
  for (let attempt = 0; attempt < 150 && !webhook; attempt++) {
    webhook = (await service.detail({ plugin }, caller)).webhooks.find((hook) => hook.status === "setup-required");
    if (!webhook) await sleep(200);
  }
  if (!webhook) throw new Error("The manual webhook never needed setup");
  const setup = await service.manage({ operation: "webhookSetup.read", input: { app: plugin, subscription: webhook.id } }, caller);
  await service.manage({ operation: "webhookSetup.complete", input: { app: plugin, subscription: webhook.id, revision: setup.revision, state: {} } }, caller);
  // A scheduled call waiting for approval, answered only after the upgrade.
  await service.manage({ operation: "schedules.configure", input: { app: plugin, name: "approved", enabled: true, approvalMode: "browser", key: "approved-schedule" } }, caller);
  await sql.raw("UPDATE plugin_engine.plugin_engine_schedules SET next_at = now() - interval '1 second' WHERE name = 'approved'").execute(db);
  let approval;
  for (let attempt = 0; attempt < 150 && !approval; attempt++) {
    approval = (await service.manage({ operation: "schedules.runs", input: { app: plugin, pending: true } }, caller))[0];
    if (!approval) await sleep(100);
  }
  if (!approval) throw new Error("The schedule never asked for approval");
  // A workflow run saved and not yet started, as one whose dispatch waits.
  queueing = true;
  await service.manage({ operation: "workflowRuns.start", input: { app: plugin, workflow: "counted", input: {}, key: "before-upgrade" } }, caller).catch(() => undefined);
  const queued = (await sql.raw("SELECT id FROM plugin_engine.plugin_engine_workflow_runs WHERE status = 'queued'").execute(db)).rows[0];
  if (!queued) throw new Error("No queued workflow run");
  const detail = await service.detail({ plugin }, caller);
  await writeFile(resultFile, JSON.stringify({ plugin, version: installed.version.id, broken: broken.plugin.id, account: account.id, added, webhook: webhook.id, setup, detail, approval: approval.id, queued: queued.id }));
} finally {
  await service.close();
  await registry.close();
  await db.destroy();
}
`;

/** The baseline's checkout, installed and built once per revision. */
async function baselineCheckout() {
  const revision = execFileSync("git", ["merge-base", "HEAD", "origin/main"], {
    encoding: "utf8",
  }).trim();
  const directory = join(tmpdir(), `opensteer-plugin-upgrade-${revision.slice(0, 12)}`);
  if (existsSync(join(directory, ".built"))) return { revision, directory };
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const archive = join(directory, "..", `opensteer-plugin-upgrade-${revision.slice(0, 12)}.tar`);
  execFileSync("git", ["archive", "--format=tar", `--output=${archive}`, revision]);
  execFileSync("tar", ["-xf", archive, "-C", directory]);
  await rm(archive, { force: true });
  const pnpm = (...args: string[]) =>
    execFileSync("pnpm", args, {
      cwd: directory,
      stdio: "inherit",
      env: { ...process.env, CI: "1" },
    });
  pnpm("install", "--frozen-lockfile", "--prefer-offline", "--ignore-scripts");
  pnpm("--filter", "apps", "build");
  pnpm("--filter", "@opensteer/host", "build");
  await writeFile(join(directory, ".built"), revision);
  return { revision, directory };
}

/** An npm archive of one package whose `index.js` is `content`. */
async function archive(directory: string, name: string, content: string, file: string) {
  const root = join(directory, `${file}.package`);
  await mkdir(join(root, "package"), { recursive: true });
  await writeFile(
    join(root, "package", "package.json"),
    JSON.stringify({ name, version: "1.0.0", type: "module", main: "index.js" }),
  );
  await writeFile(join(root, "package", "index.js"), content);
  execFileSync("tar", ["--format=ustar", "-czf", join(directory, file), "-C", root, "package"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  return readFile(join(directory, file));
}

/**
 * The baseline Host's plugins in a cloned database, and the upgraded Host's service over them with
 * a registry that is down until `outage.down` is false.
 */
async function upgraded(context: TestContext) {
  const baseline = await baselineCheckout();
  const clone = await cloneTestDatabase("host");
  const database = createDatabase({ connectionString: clone.url });
  context.onTestFinished(() => database.destroy());
  const work = await mkdtemp(join(tmpdir(), "opensteer-plugin-upgrade-run-"));
  context.onTestFinished(() => rm(work, { recursive: true, force: true }));
  const dataDirectory = join(work, "plugins");
  const baselineFramework = JSON.parse(
    await readFile(
      createRequire(join(baseline.directory, "apps/host/package.json")).resolve(
        "apps/package.json",
      ),
      "utf8",
    ),
  ).version as string;
  const label = await archive(
    work,
    "upgrade-label",
    'export const label = "from the registry";',
    "label.tgz",
  );
  // The baseline's registry serves this one; the driver reads it from `work`.
  await archive(work, "upgrade-broken", 'export const label = "then";', "broken.tgz");
  // The same package as the registry serves it after the upgrade: it no longer has the export.
  const changed = await archive(
    work,
    "upgrade-broken",
    'export const other = "now";',
    "changed.tgz",
  );
  await writeFile(
    join(work, "upgrade.json"),
    JSON.stringify(source(baselineFramework, "upgrade-label")),
  );
  await writeFile(
    join(work, "broken.json"),
    JSON.stringify(source(baselineFramework, "upgrade-broken")),
  );
  await writeFile(join(baseline.directory, "plugin-upgrade-driver.ts"), driver);
  execFileSync(
    join(baseline.directory, "node_modules/.bin/tsx"),
    [
      "plugin-upgrade-driver.ts",
      clone.url,
      dataDirectory,
      join(work, "registry"),
      work,
      join(work, "before.json"),
    ],
    { cwd: baseline.directory, stdio: "inherit" },
  );
  const before = JSON.parse(await readFile(join(work, "before.json"), "utf8"));
  expect(before.added.result).toMatchObject({ execution: { value: { ok: true } } });
  expect(before.detail.webhooks).toMatchObject([{ id: before.webhook, status: "active" }]);
  const plugin = before.plugin as string;
  const queued = async () =>
    (
      await sql<{
        status: string;
        failure: string | null;
        deployment: string;
      }>`select status, failure, deployment from plugin_engine.plugin_engine_workflow_runs where id = ${before.queued}`.execute(
        database,
      )
    ).rows[0];
  expect(await queued()).toMatchObject({ status: "queued", deployment: before.version });
  const approvalState = async () =>
    (
      await sql<{
        status: string;
        failure: string | null;
      }>`select status, failure from plugin_engine.plugin_engine_scheduled_runs where id = ${before.approval}`.execute(
        database,
      )
    ).rows[0];
  expect(await approvalState()).toMatchObject({ status: "awaiting-approval" });
  // The person's access settings live with the Host, beside the engine's own store, with who
  // wrote each version.
  const personal = await seedPersonalFixture(database, work);
  const settings = new PluginAgentStore(database);
  await settings.setAccess(personal.userId, plugin, "read-only");
  await recordPluginAuthor(database, personal.userId, plugin, before.version, "catalog");
  const authorOf = async (version: string) =>
    (await settings.versionAuthors(personal.userId, [{ pluginId: plugin, version }])).get(
      `${plugin}\u0000${version}`,
    );

  // The upgraded Host: the same database and plugin store, and a registry that is down at first.
  const outage = { down: true };
  const packages: Record<string, Buffer> = { "upgrade-label": label, "upgrade-broken": changed };
  const registry = await pluginFixtureRegistry(undefined, undefined, (request, response) => {
    const name = (request.url ?? "").slice(1).replace(/\.tgz$/u, "");
    const tarball = packages[name];
    if (tarball === undefined) return false;
    if (outage.down) {
      response.statusCode = 503;
      response.end("temporarily unavailable");
    } else if (request.url?.endsWith(".tgz")) response.end(tarball);
    else
      response.end(
        JSON.stringify({
          name,
          "dist-tags": { latest: "1.0.0" },
          versions: {
            "1.0.0": {
              name,
              version: "1.0.0",
              dist: {
                tarball: `${registry.origin}/${name}.tgz`,
                integrity: "sha512-" + createHash("sha512").update(tarball).digest("base64"),
              },
            },
          },
        }),
      );
    return true;
  });
  context.onTestFinished(() => registry.close());
  const open = async (onDiagnostic?: (phase: string) => void) => {
    const service = new PluginService({
      processEntry: new URL("../apps/host/dist/plugin-engine.js", import.meta.url),
      bridge: resolve("apps/host/dist/plugin-engine-bridge.json"),
      databaseUrl: clone.url,
      dataDirectory,
      owner: "owner",
      credentialKey: new Uint8Array(32).fill(1),
      origin: "https://fixture.invalid",
      webhookOrigin: async () => "https://hooks.fixture.invalid",
      npmRegistry: registry.origin,
      catalogUrl: registry.origin + "/catalog",
      idleMs: 0,
      ...(onDiagnostic === undefined ? {} : { onDiagnostic }),
    });
    await ownTestDatabaseProducer(clone.url, async () => ({ close: () => service.close() }));
    context.onTestFinished(() => service.close());
    await service.start();
    await service.health({}, caller);
    return service;
  };
  /** Wait until the engine has no plugin waiting for its rebuild. */
  const settle = (service: PluginService) =>
    vi.waitFor(() => expect(service.rebuilding()).toBe(false), {
      timeout: 120_000,
      interval: 100,
    });
  const installed = async (service: PluginService, id: string) =>
    (await service.installed({ plugins: [id] }, caller))[0]!;
  const notes = (service: PluginService) =>
    service.call({ calls: { path: "tools.upgrade.notes", input: {} } }, caller);
  const runs = async () =>
    Number(
      (
        await sql<{
          count: string;
        }>`select count(*) as count from plugin_engine.plugin_engine_scheduled_runs where app = ${plugin} and name = 'tick'`.execute(
          database,
        )
      ).rows[0]!.count,
    );

  return {
    before,
    plugin,
    database,
    registry,
    outage,
    open,
    settle,
    installed,
    notes,
    runs,
    queued,
    approvalState,
    authorOf,
    settings,
    personal,
    baselineFramework,
  };
}

test(
  "rebuilds plugins installed by the baseline Host for this Host's framework, serving none until then",
  async (context) => {
    const {
      before,
      plugin,
      database,
      registry,
      outage,
      open,
      settle,
      installed,
      notes,
      runs,
      queued,
      approvalState,
      authorOf,
      settings,
      personal,
    } = await upgraded(context);
    // The upgraded Host starts while the registry is down.
    const upgradedAt = Date.now();
    const first = await open();
    expect(first.rebuilding()).toBe(true);
    // A plugin waiting for its rebuild keeps its version and serves nothing: each refusal is typed
    // and says to try again, and nothing reaches the plugin.
    await vi.waitFor(
      async () =>
        expect((await installed(first, plugin)).updating?.reason).toContain(
          "tried again: App build failed at the dependencies stage",
        ),
      { timeout: 60_000, interval: 250 },
    );
    expect((await installed(first, plugin)).plugin.activeVersion).toBe(before.version);
    expect(JSON.stringify((await notes(first)).result)).toContain("plugin_updating");
    // A batched call is refused call by call.
    const batch = await first.call(
      {
        calls: [
          { path: "tools.upgrade.notes", input: {} },
          { path: "tools.upgrade.add", input: { body: "during" } },
        ],
      },
      caller,
    );
    expect(JSON.stringify(batch.result).match(/plugin_updating/gu)).toHaveLength(2);
    // The owner's detail evaluates no dynamic tool on the build that waits for its rebuild.
    const tools = await first.detailSection({ plugin, section: "tools" }, caller);
    for (const tool of tools.items) {
      const stamp = /^evaluated:(\d+)$/u.exec(String(tool.description ?? ""))?.[1];
      if (stamp !== undefined) expect(Number(stamp)).toBeLessThan(upgradedAt);
    }
    // A webhook delivery runs nothing of it, and the service is told to deliver again.
    const delivered = await first.webhook(
      {
        plugin,
        subscription: before.webhook,
        request: {
          url: "https://hooks.fixture.invalid/delivery",
          method: "POST",
          headers: {},
          body: "",
        },
      },
      caller,
    );
    if (delivered.stream) first.discardStream(delivered.stream);
    expect([delivered.status, delivered.headers["retry-after"]]).toEqual([503, "60"]);
    // Nor is an asset of its build served.
    const asset = await first.page(
      {
        plugin,
        request: {
          url: `http://plugin-page.internal/_plugin-engine/assets/${before.version}/main.js`,
          method: "GET",
          headers: {},
          body: "",
        },
      },
      caller,
    );
    if (asset.stream) first.discardStream(asset.stream);
    expect(asset.status).toBe(503);
    // The person answers the scheduled call meanwhile; it waits, answered, for the rebuild.
    await first.manage(
      { operation: "schedules.answer", input: { run: before.approval, action: "accept" } },
      caller,
    );
    expect(await approvalState()).toMatchObject({ status: "ready" });
    // A new workflow run is refused as a call is: typed, unsent, and to be tried again.
    await expect(
      first.manage(
        {
          operation: "workflowRuns.start",
          input: { app: plugin, workflow: "counted", input: {}, key: "during-upgrade" },
        },
        caller,
      ),
    ).rejects.toMatchObject({ tag: "PluginUpdating", code: "unavailable" });
    expect(
      await first.resourcesUpdate(
        {
          pluginId: plugin,
          change: { action: "workflow.start", workflow: "counted", input: {}, key: "agent" },
        },
        caller,
      ),
    ).toMatchObject({ kind: "blocked", blocked: { code: "plugin_updating" } });
    const page = await first.page(
      {
        plugin,
        request: { url: "http://plugin-page.internal/", method: "GET", headers: {}, body: "" },
      },
      caller,
    );
    if (page.stream) first.discardStream(page.stream);
    expect(page.status).toBe(503);
    expect(page.headers["retry-after"]).toBe("10");
    expect(page.headers["content-type"]).toContain("text/html");
    const api = await first.page(
      {
        plugin,
        request: {
          url: `http://plugin-page.internal/_plugin-engine/api/query`,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: Buffer.from("{}").toString("base64"),
        },
      },
      caller,
    );
    expect([api.status, api.headers["content-type"]]).toEqual([503, "application/json"]);
    // Its body is the page contract's own answer for an app that is updating.
    const body: Uint8Array[] = [];
    if (api.stream) for await (const chunk of first.readStream(api.stream)) body.push(chunk);
    expect(
      Schema.decodeUnknownSync(UiUpdating)(JSON.parse(Buffer.concat(body).toString())),
    ).toMatchObject({ _tag: "UiUpdating", message: expect.stringContaining("tried again") });
    // An occurrence that comes due meanwhile is neither run nor dropped.
    const ran = await runs();
    await sql`update plugin_engine.plugin_engine_schedules set next_at = now() - interval '1 second' where app = ${plugin} and name = 'tick'`.execute(
      database,
    );
    // The scheduler ticks every second; by the engines' next rebuild attempt, five seconds on,
    // it has seen the occurrence due several times.
    const asked = registry.requests.length;
    await vi.waitFor(() => expect(registry.requests.length).toBeGreaterThan(asked), {
      timeout: 60_000,
      interval: 250,
    });
    expect(await runs()).toBe(ran);
    expect(
      (
        await sql<{
          due: boolean;
        }>`select next_at <= now() as due from plugin_engine.plugin_engine_schedules where app = ${plugin} and name = 'tick'`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ due: true }]);
    expect(await first.versions({ plugin }, caller)).toHaveLength(1);
    expect(await queued()).toMatchObject({ status: "queued", deployment: before.version });

    // The Host restarts abruptly: its new engine finds the plugin store held by the old one, which
    // is still running, and waits for it, opening nothing of the store meanwhile.
    const phases: string[] = [];
    const opening = open((phase) => phases.push(phase));
    await vi.waitFor(() => expect(phases).toContain("directory-wait"), {
      timeout: 20_000,
      interval: 100,
    });
    expect(phases).not.toContain("database");
    // The old engine dies without shutting down; the waiting one takes the store and the
    // database over and finishes the rebuild.
    const crashed = first.state().pid!;
    process.kill(crashed, "SIGKILL");
    await first.close();
    const second = await opening;
    expect(second.state()).toMatchObject({ status: "ready" });
    expect(second.state().pid).not.toBe(crashed);
    expect(phases).toContain("database");

    // The registry recovers: each plugin is rebuilt once.
    outage.down = false;
    await settle(second);
    const versions = await second.versions({ plugin }, caller);
    expect(versions).toHaveLength(2);
    const rebuilt = versions.find((version) => version.id !== before.version)!.id;
    expect(await installed(second, plugin)).toMatchObject({
      plugin: { activeVersion: rebuilt },
    });
    // The rebuilt version is published as an install is: the Host's skill record names it, and
    // it keeps the author of the version it was rebuilt from.
    expect(await second.skillCache.get(plugin)).toMatchObject({ version: rebuilt });
    expect(await authorOf(rebuilt)).toBe("catalog");
    // Work saved on the old build never runs on it: the queued run moves to the rebuilt version,
    // which takes its workflow and input, and runs there, as does the answered scheduled call.
    await vi.waitFor(
      async () =>
        expect(
          await second.manage(
            { operation: "workflowRuns.get", input: { app: plugin, run: before.queued } },
            caller,
          ),
        ).toMatchObject({ status: "complete" }),
      { timeout: 30_000, interval: 250 },
    );
    expect(await queued()).toMatchObject({ status: "complete", deployment: rebuilt });
    await vi.waitFor(
      async () => expect(await approvalState()).toMatchObject({ status: "succeeded" }),
      { timeout: 30_000, interval: 250 },
    );
    // The due occurrence ran on the rebuilt version, and the account, its link, the plugin's rows
    // and its renamed migration history all survived.
    await vi.waitFor(async () => expect(await runs()).toBe(ran + 1), {
      timeout: 30_000,
      interval: 250,
    });
    expect((await notes(second)).result).toMatchObject({
      execution: {
        value: {
          ok: true,
          value: {
            notes: expect.arrayContaining(["before", "approved", "schedule"]),
            applied: 1,
            token: "synthetic",
            label: "from the registry",
          },
        },
      },
    });
    expect((await second.accounts({}, caller)).map((account) => account.id)).toContain(
      before.account,
    );
    expect((await installed(second, plugin)).links).toMatchObject([
      { requirement: "service", account: before.account },
    ]);
    expect(await settings.settings(personal.userId)).toMatchObject([
      { pluginId: plugin, access: "read-only" },
    ]);
    const detail = await second.detail({ plugin }, caller);
    expect(detail.schedules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "tick",
          settings: expect.objectContaining({ enabled: true }),
        }),
      ]),
    );

    // The plugin whose source no longer builds is left with no active version, and its owner reads
    // the build's own diagnostic.
    expect(await installed(second, before.broken)).toMatchObject({
      plugin: { activeVersion: null },
      buildFailure: { message: expect.stringContaining("No matching export") },
    });
    expect(await second.detail({ plugin: before.broken }, caller)).toMatchObject({
      buildFailure: { message: expect.stringContaining("No matching export") },
    });
    // Its source exports from the version whose build failed, as its detail shows.
    expect(await second.export({ plugin: before.broken }, caller)).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "index.ts" })]),
    );

    // A manual setup completed before the upgrade is set up again, not carried: the person sees a
    // subscription that needs setup at the service, with a new callback URL and signing secret.
    const webhooks = await vi.waitFor(
      async () => {
        const listed = (await second.detail({ plugin }, caller)).webhooks;
        expect(listed.map((hook) => hook.status).sort()).toEqual(["setup-required", "stopped"]);
        return listed;
      },
      { timeout: 60_000, interval: 250 },
    );
    expect(webhooks.find((hook) => hook.status === "stopped")?.id).toBe(before.webhook);
    const setup = (await second.manage(
      {
        operation: "webhookSetup.read",
        input: {
          app: plugin,
          subscription: webhooks.find((hook) => hook.id !== before.webhook)!.id,
        },
      },
      caller,
    )) as {
      step: string;
      subscription: { callbackUrl: string };
      signingSecret: { source: string; value?: unknown };
    };
    expect(setup.step).toBe("configure");
    expect(setup.subscription.callbackUrl).not.toBe(before.setup.subscription.callbackUrl);
    expect(setup.signingSecret).toMatchObject({
      source: "plugin-engine",
      value: expect.anything(),
    });

    // Rolling back to the version from before the upgrade rebuilds its source first, and the
    // version that becomes active is the one published, with that version's author.
    const activated = await second.activate({ plugin, version: before.version }, caller);
    const rolled = await second.versions({ plugin }, caller);
    expect(rolled).toHaveLength(3);
    const active = (await installed(second, plugin)).plugin.activeVersion;
    expect([before.version, rebuilt]).not.toContain(active);
    expect(activated).toMatchObject({ activeVersion: active });
    expect(await second.skillCache.get(plugin)).toMatchObject({ version: active });
    expect(await authorOf(active!)).toBe("catalog");
    expect((await notes(second)).result).toMatchObject({
      execution: {
        value: {
          ok: true,
          value: { notes: expect.arrayContaining(["before", "approved", "schedule"]), applied: 1 },
        },
      },
    });

    // A later start finds every plugin built for this framework, or not built, and builds nothing.
    await second.close();
    const again = await open();
    await settle(again);
    expect(await again.versions({ plugin }, caller)).toHaveLength(3);
    expect(await installed(again, plugin)).toMatchObject({ plugin: { activeVersion: active } });
    expect(await again.versions({ plugin: before.broken }, caller)).toHaveLength(1);
    expect(await installed(again, before.broken)).toMatchObject({
      plugin: { activeVersion: null },
      buildFailure: { message: expect.stringContaining("No matching export") },
    });
  },
  15 * 60_000,
);

test(
  "ends the work saved for a held plugin's build when its owner replaces the plugin with other source",
  async (context) => {
    const { before, plugin, open, installed, notes, queued, approvalState, baselineFramework } =
      await upgraded(context);
    const first = await open();
    await vi.waitFor(
      async () =>
        expect((await installed(first, plugin)).updating?.reason).toContain("dependencies stage"),
      { timeout: 60_000, interval: 250 },
    );
    // While the plugin waits for its rebuild, its owner installs changed source into it: its
    // reviewed tool writes something else, its approval policy denies every call, and its
    // workflow answers differently.
    const replacement = rewriteUpstreamSource(source(baselineFramework, "upgrade-label")).files.map(
      (file) => {
        if (file.path === "package.json") {
          const manifest = JSON.parse(file.content);
          delete manifest.dependencies["upgrade-label"];
          return { ...file, content: JSON.stringify(manifest) };
        }
        if (file.path !== "index.ts") return file;
        return {
          ...file,
          content: file.content
            .replace('import { label } from "upgrade-label";', 'const label = "owner replacement";')
            .replace(
              'ctx.sql.exec("INSERT INTO notes (body) VALUES (?)", body);\n  return body;\n});\nconst count',
              'ctx.sql.exec("INSERT INTO notes (body) VALUES (?)", `replacement:${body}`);\n  return body;\n});\nconst count',
            )
            .replace("approval: always()", 'approval: () => "denied"')
            .replace('async (ctx) => ctx.step.runQuery("count", count, {})', "async () => 949"),
        };
      },
    );
    expect(
      await first.install({ kind: "files", plugin, files: replacement }, caller),
    ).toMatchObject({
      status: "installed",
    });
    expect((await installed(first, plugin)).updating).toBeUndefined();
    // The call approved for the replaced build is not the replacement's to run: it ends stale.
    await first.manage(
      { operation: "schedules.answer", input: { run: before.approval, action: "accept" } },
      caller,
    );
    await vi.waitFor(
      async () =>
        expect(await approvalState()).toMatchObject({ status: "failed", failure: "stale" }),
      { timeout: 30_000, interval: 250 },
    );
    // So does the run queued for it, which the replacement's handler never answers.
    await vi.waitFor(
      async () =>
        expect(await queued()).toMatchObject({
          status: "errored",
          failure: "stale",
          deployment: before.version,
        }),
      { timeout: 30_000, interval: 250 },
    );
    expect(
      await first.manage(
        { operation: "workflowRuns.get", input: { app: plugin, run: before.queued } },
        caller,
      ),
    ).not.toMatchObject({ output: 949 });
    expect((await notes(first)).result).toMatchObject({
      execution: { value: { ok: true, value: { notes: ["before"], label: "owner replacement" } } },
    });
  },
  15 * 60_000,
);
