/**
 * A plugin's version change as one protocol: its complete version saved as pending, its SQLite
 * data migrated, then the version activated, with nothing of the plugin running in between and
 * only the active version ever running. Each test drives a real engine against a private database.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql, type Kysely } from "kysely";
import { expect, test, vi, type TestContext } from "vitest";
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
import { pluginFixtureRegistry } from "../scripts/plugin-engine/fixture.ts";

const caller = { caller: "owner:task", mode: "ask" as const };

/**
 * A plugin of revision `revision` whose data is a `notes` table. `migrations` are its SQL files in
 * order; a revision whose migrations rename `body` to `text` reads and writes `text`. Every row it
 * writes names its revision, so a row shows which version's code wrote it.
 */
const source = (
  revision: number,
  options: {
    readonly migrations?: readonly string[];
    readonly column?: "body" | "text";
    readonly dependency?: string;
    readonly appAccount?: boolean;
    /** The package's name; the fixture catalog's entry names `fixture-plugin`. */
    readonly name?: string;
  } = {},
) => {
  const column = options.column ?? "body";
  const migrations = options.migrations ?? ["CREATE TABLE notes (body TEXT NOT NULL);"];
  return [
    {
      path: "package.json",
      content: JSON.stringify({
        name: options.name ?? "version-fixture",
        type: "module",
        dependencies: {
          apps: framework.version,
          ...(options.dependency === undefined ? {} : { "version-label": options.dependency }),
        },
      }),
    },
    ...migrations.map((content, index) => ({
      path: `migrations/000${index + 1}_step.sql`,
      content,
    })),
    {
      path: "index.ts",
      content: `
import { defineApp, defineProvider, secrets, object, string, query, mutation, router, userInterval, appInterval, workflow } from "apps";
import { always } from "apps/operations/approval";
${options.dependency === undefined ? 'const label = "none";' : 'import { label } from "version-label";'}
const service = defineProvider({ name: "Version fixture", auth: { key: secrets({ label: "API key", fields: object({ token: string() }) }) } });
const write = (ctx, body) => ctx.sql.exec("INSERT INTO notes (${column}) VALUES (?)", "v${revision}:" + body);
const add = mutation({ input: object({ body: string() }) }, async (ctx, { body }) => { write(ctx, body); return body; });
const reviewed = mutation({ input: object({ body: string() }), approval: always() }, async (ctx, { body }) => { write(ctx, body); return body; });
const notes = query({ input: object({}) }, async (ctx) => ({
  revision: ${revision},
  label,
  notes: ctx.sql.exec("SELECT ${column} AS value FROM notes ORDER BY rowid").toArray().map((row) => row.value),
}));
const wait = query({ input: object({}) }, async (ctx) => (await ctx.fetch("https://api.fixture.invalid/wait")).text());
const ask = query({ input: object({}) }, async (ctx) => ctx.elicit({ mode: "form", message: "Name it", requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }));
export default defineApp(${options.appAccount ? "{ app: { accounts: { service } } }" : "{}"}, {
  tools: router({ add, reviewed, notes, wait, ask }),
  schedules: {
    tick: ${options.appAccount ? 'appInterval({ minutes: 60 }, add, { body: "schedule" })' : 'userInterval({ minutes: 60 }, add, { body: "schedule" })'},
    approved: userInterval({ minutes: 60 }, reviewed, { body: "approved" }),
  },
  workflows: { counted: workflow({ input: object({}) }, async (ctx) => (await ctx.step.runQuery("notes", notes, {})).notes.length) },
});`,
    },
  ];
};

/** A migration that keeps SQLite busy for a few seconds, so the engine can stop during it. */
const slow =
  "CREATE TABLE slow AS WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 30000000) SELECT count(*) AS n FROM c;";

/** An npm archive of `version-label` at `version`, exporting `label`. */
async function archive(directory: string, version: string) {
  const root = join(directory, `label-${version}`);
  await mkdir(join(root, "package"), { recursive: true });
  await writeFile(
    join(root, "package", "package.json"),
    JSON.stringify({ name: "version-label", version, type: "module", main: "index.js" }),
  );
  await writeFile(join(root, "package", "index.js"), `export const label = "label ${version}";`);
  execFileSync(
    "tar",
    ["--format=ustar", "-czf", join(root, "package.tgz"), "-C", root, "package"],
    {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    },
  );
  return readFile(join(root, "package.tgz"));
}

async function fixture(
  context: TestContext,
  options: { readonly catalog?: ReturnType<typeof source> } = {},
) {
  const clone = await cloneTestDatabase("host");
  const directory = await mkdtemp(join(tmpdir(), "opensteer-version-change-"));
  context.onTestFinished(() => rm(directory, { force: true, recursive: true }));
  const database = createDatabase({ connectionString: clone.url });
  context.onTestFinished(() => database.destroy());
  /** Published versions of `version-label`, and the one its `latest` tag names. */
  const labels = new Map<string, Buffer>();
  let latest = "1.0.0";
  /** `/wait` holds a call until the test releases it. */
  const waiting: Array<() => void> = [];
  let reached = Promise.withResolvers<void>();
  const registry = await pluginFixtureRegistry(undefined, options.catalog, (request, response) => {
    if (request.url === "/wait") {
      waiting.push(() => response.end("released"));
      reached.resolve();
      return true;
    }
    const name = (request.url ?? "").slice(1).replace(/-([0-9.]+)\.tgz$/u, "");
    if (name !== "version-label") return false;
    const file = /-([0-9.]+)\.tgz$/u.exec(request.url ?? "")?.[1];
    if (file !== undefined) {
      response.end(labels.get(file));
      return true;
    }
    response.end(
      JSON.stringify({
        name,
        "dist-tags": { latest },
        versions: Object.fromEntries(
          [...labels].map(([version, tarball]) => [
            version,
            {
              name,
              version,
              dist: {
                tarball: `${registry.origin}/version-label-${version}.tgz`,
                integrity: "sha512-" + createHash("sha512").update(tarball).digest("base64"),
              },
            },
          ]),
        ),
      }),
    );
    return true;
  });
  context.onTestFinished(() => registry.close());
  /** Background work and calls are refused while `refuse` says so. */
  const refuse = { background: false, writes: false };
  /** The operation of every authorization the engine asked for, in order. */
  const authorized: string[] = [];
  const authorize: PluginServiceOptions["authorize"] = async (input) => (
    authorized.push(input.operation),
    {
      allowed:
        (input.caller === "owner" || input.caller.startsWith("owner:")) &&
        !(refuse.background && input.operation === "background") &&
        !(refuse.writes && "write" in input && input.write === true),
    }
  );
  const options_: PluginServiceOptions = {
    processEntry: new URL("../apps/host/dist/plugin-engine.js", import.meta.url),
    bridge: new URL("../apps/host/dist/plugin-engine-bridge.json", import.meta.url).pathname,
    databaseUrl: clone.url,
    dataDirectory: directory,
    owner: "owner",
    credentialKey: new Uint8Array(32).fill(1),
    origin: "https://fixture.invalid",
    npmRegistry: registry.origin,
    catalogUrl: registry.origin + "/catalog",
    selfOrigin: { origin: "https://api.fixture.invalid", address: registry.address },
    idleMs: 0,
    authorize,
  };
  const open = async () => {
    const service = new PluginService(options_);
    await ownTestDatabaseProducer(clone.url, async () => ({ close: () => service.close() }));
    context.onTestFinished(() => service.close());
    await service.health({}, caller);
    return service;
  };
  const install = async (
    service: PluginService,
    files: ReturnType<typeof source>,
    plugin?: string,
  ) => {
    const installed = await service.install(
      plugin === undefined
        ? { kind: "files", name: "Version", files }
        : { kind: "files", plugin, files },
      caller,
    );
    if (installed.status !== "installed") throw new Error(JSON.stringify(installed));
    return installed;
  };
  const slugOf = async (service: PluginService, plugin: string) =>
    (await service.installed({ plugins: [plugin] }, caller))[0]!.plugin.slug;
  const call = async (service: PluginService, plugin: string, tool: string, input = {}) =>
    (
      await service.call(
        {
          calls: { path: `tools[${JSON.stringify(await slugOf(service, plugin))}].${tool}`, input },
        },
        caller,
      )
    ).result as Record<string, unknown>;
  /** The plugin's notes, as its active version reads them. */
  const notes = async (service: PluginService, plugin: string) => {
    const result = (await call(service, plugin, "notes")) as {
      execution?: {
        value?: { ok?: boolean; value?: { revision: number; notes: string[]; label: string } };
      };
    };
    if (result.execution?.value?.ok !== true) throw new Error(JSON.stringify(result));
    return result.execution.value.value!;
  };
  const row = async (plugin: string) =>
    (
      await sql<{ active: string | null; pending: string | null }>`
        SELECT active_deployment AS active, pending_deployment AS pending
        FROM plugin_engine.plugin_engine_apps WHERE id = ${plugin}`.execute(database)
    ).rows[0];
  const versions = async (plugin: string) =>
    Number(
      (
        await sql<{
          count: string;
        }>`SELECT count(*) AS count FROM plugin_engine.plugin_engine_deployments
          WHERE code = (SELECT code FROM plugin_engine.plugin_engine_apps WHERE id = ${plugin})`.execute(
          database,
        )
      ).rows[0]!.count,
    );
  /** Stop the engine as a crash would. */
  const crash = async (service: PluginService) => {
    process.kill(service.state().pid!, "SIGKILL");
    await service.close();
  };
  return {
    url: clone.url,
    directory,
    database,
    registry,
    labels,
    setLatest: (version: string) => {
      latest = version;
    },
    waiting,
    reached: () => reached.promise,
    resetReached: () => {
      reached = Promise.withResolvers<void>();
    },
    refuse,
    authorized,
    open,
    install,
    call,
    notes,
    row,
    versions,
    crash,
  };
}

/**
 * Hold a version change at a step: `activate`, where step 3 makes a pending version active, until
 * `release`; `fail`, where step 3 fails until `release`; or `prepare`, where step 1 saves the
 * version, until `release`, when step 1 fails and the change does nothing.
 */
async function hold<D>(database: Kysely<D>, kind: "activate" | "fail" | "prepare") {
  const fence = 735158200;
  if (kind === "prepare")
    await sql
      .raw(
        `
    CREATE OR REPLACE FUNCTION plugin_engine.test_hold_prepare() RETURNS trigger LANGUAGE plpgsql AS $hold$
    BEGIN
      PERFORM pg_advisory_xact_lock(${fence});
      RAISE EXCEPTION 'prepare refused by the test';
    END;
    $hold$;
    DROP TRIGGER IF EXISTS test_hold_prepare ON plugin_engine.plugin_engine_deployments;
    CREATE TRIGGER test_hold_prepare BEFORE INSERT ON plugin_engine.plugin_engine_deployments
    FOR EACH ROW EXECUTE FUNCTION plugin_engine.test_hold_prepare();
  `,
      )
      .execute(database);
  else
    await sql
      .raw(
        `
    CREATE TABLE IF NOT EXISTS plugin_engine.test_refuse_activation (refused boolean);
    CREATE OR REPLACE FUNCTION plugin_engine.test_hold_activation() RETURNS trigger LANGUAGE plpgsql AS $hold$
    BEGIN
      IF OLD.pending_deployment IS NOT NULL AND NEW.pending_deployment IS NULL
        AND NEW.active_deployment IS NOT DISTINCT FROM OLD.pending_deployment THEN
        ${kind === "activate" ? `PERFORM pg_advisory_xact_lock(${fence});` : "IF EXISTS (SELECT 1 FROM plugin_engine.test_refuse_activation) THEN RAISE EXCEPTION 'activation refused by the test'; END IF;"}
      END IF;
      RETURN NEW;
    END;
    $hold$;
    DROP TRIGGER IF EXISTS test_hold_activation ON plugin_engine.plugin_engine_apps;
    CREATE TRIGGER test_hold_activation BEFORE UPDATE ON plugin_engine.plugin_engine_apps
    FOR EACH ROW EXECUTE FUNCTION plugin_engine.test_hold_activation();
  `,
      )
      .execute(database);
  if (kind === "fail") {
    await sql
      .raw("INSERT INTO plugin_engine.test_refuse_activation VALUES (true)")
      .execute(database);
    return {
      waiting: async (_early?: () => void) => {},
      release: async () => {
        await sql.raw("DELETE FROM plugin_engine.test_refuse_activation").execute(database);
      },
    };
  }
  const held = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const blocker = database.transaction().execute(async (tx) => {
    await sql.raw(`SELECT pg_advisory_xact_lock(${fence})`).execute(tx);
    held.resolve();
    await released.promise;
  });
  await held.promise;
  return {
    /** Until a change waits at step 3. */
    waiting: (early: () => void = () => {}) =>
      vi.waitFor(
        async () => {
          early();
          const blocked = await sql<{ blocked: boolean }>`SELECT EXISTS (
            SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = 0 AND objid = ${fence}
            AND NOT granted) AS blocked`.execute(database);
          expect(blocked.rows[0]?.blocked).toBe(true);
        },
        { timeout: 60_000, interval: 100 },
      ),
    release: async () => {
      released.resolve();
      await blocker;
      await sql
        .raw(
          kind === "prepare"
            ? "DROP TRIGGER test_hold_prepare ON plugin_engine.plugin_engine_deployments"
            : "DROP TRIGGER test_hold_activation ON plugin_engine.plugin_engine_apps",
        )
        .execute(database);
    },
  };
}

/**
 * Make the plugin's active build one the Host does not run as it is, as an upgrade of the Host's
 * framework does: its record names another framework. The next engine rebuilds it.
 */
async function outdate<D>(directory: string, database: Kysely<D>, plugin: string) {
  const build = (
    await sql<{ build: string }>`SELECT d.build FROM plugin_engine.plugin_engine_apps a
      JOIN plugin_engine.plugin_engine_deployments d ON d.id = a.active_deployment
      WHERE a.id = ${plugin}`.execute(database)
  ).rows[0]!.build;
  const file = join(directory, "plugins", "builds", build, "worker.json");
  const record = JSON.parse(await readFile(file, "utf8")) as {
    framework: { version: string; sha256: string };
  };
  record.framework = { version: record.framework.version, sha256: "0".repeat(64) };
  await writeFile(file, JSON.stringify(record));
}

test("only the active version runs: work saved for the version a deploy replaced ends stale", async (context) => {
  const f = await fixture(context);
  const service = await f.open();
  const v1 = await f.install(service, source(1));
  const plugin = v1.plugin.id;
  // Work saved on the first version: an approval waiting in a call, the approval of a scheduled
  // call, and a workflow run queued while background work is refused.
  const slug = (await service.installed({ plugins: [plugin] }, caller))[0]!.plugin.slug;
  const paused = await service.execute(
    { code: `return await tools.${slug}.reviewed({ body: "approved" });` },
    caller,
  );
  expect(paused.state).toBe("waiting");
  await service.manage(
    {
      operation: "schedules.configure",
      input: {
        app: plugin,
        name: "approved",
        enabled: true,
        approvalMode: "browser",
        key: "approved",
      },
    },
    caller,
  );
  await sql`UPDATE plugin_engine.plugin_engine_schedules SET next_at = now() - interval '1 second' WHERE app = ${plugin} AND name = 'approved'`.execute(
    f.database,
  );
  const scheduled = await vi.waitFor(
    async () => {
      const runs = (await service.manage(
        { operation: "schedules.runs", input: { app: plugin, pending: true } },
        caller,
      )) as Array<{ id: string }>;
      expect(runs).toHaveLength(1);
      return runs[0]!;
    },
    { timeout: 30_000, interval: 100 },
  );
  f.refuse.background = true;
  await service
    .manage(
      {
        operation: "workflowRuns.start",
        input: { app: plugin, workflow: "counted", input: {}, key: "queued" },
      },
      caller,
    )
    .catch(() => undefined);
  const queued = (
    await sql<{
      id: string;
    }>`SELECT id FROM plugin_engine.plugin_engine_workflow_runs WHERE app = ${plugin} AND status = 'queued'`.execute(
      f.database,
    )
  ).rows[0]!;
  // A deploy under the same framework renames the column the first version writes.
  await f.install(
    service,
    source(2, {
      migrations: [
        "CREATE TABLE notes (body TEXT NOT NULL);",
        "ALTER TABLE notes RENAME COLUMN body TO text;",
      ],
      column: "text",
    }),
    plugin,
  );
  f.refuse.background = false;
  // Every one of them ends stale, and none ran the first version's code on the second's data.
  await service.answer({ execution: paused.id, response: { action: "accept" } }, caller);
  // The approved call is stale: it is not run, and the person approves it again.
  expect(JSON.stringify((await service.resume({ execution: paused.id }, caller)).result)).toContain(
    '"code":"ApprovalUnavailable"',
  );
  await service.manage(
    { operation: "schedules.answer", input: { run: scheduled.id, action: "accept" } },
    caller,
  );
  await vi.waitFor(
    async () =>
      expect(
        (
          await sql<{
            status: string;
            failure: string | null;
          }>`SELECT status, failure FROM plugin_engine.plugin_engine_scheduled_runs WHERE id = ${scheduled.id}`.execute(
            f.database,
          )
        ).rows[0],
      ).toMatchObject({ status: "failed", failure: "stale" }),
    { timeout: 30_000, interval: 250 },
  );
  await vi.waitFor(
    async () =>
      expect(
        (
          await sql<{
            status: string;
            failure: string | null;
          }>`SELECT status, failure FROM plugin_engine.plugin_engine_workflow_runs WHERE id = ${queued.id}`.execute(
            f.database,
          )
        ).rows[0],
      ).toMatchObject({ status: "errored", failure: "stale" }),
    { timeout: 30_000, interval: 250 },
  );
  expect(await f.notes(service, plugin)).toMatchObject({ revision: 2, notes: [] });
}, 300_000);

test("activating a version whose migrations the data has moved past is refused, and changes nothing", async (context) => {
  const f = await fixture(context);
  const service = await f.open();
  const v1 = await f.install(service, source(1));
  const plugin = v1.plugin.id;
  await f.call(service, plugin, "add", { body: "first" });
  await f.install(
    service,
    source(2, {
      migrations: [
        "CREATE TABLE notes (body TEXT NOT NULL);",
        "ALTER TABLE notes RENAME COLUMN body TO text;",
      ],
      column: "text",
    }),
    plugin,
  );
  const active = (await f.row(plugin))!.active;
  const count = await f.versions(plugin);
  await expect(service.activate({ plugin, version: v1.version.id }, caller)).rejects.toMatchObject({
    tag: "VersionBuildFailed",
    message: expect.stringContaining(
      "0002_step.sql was applied to this app's database but is no longer in migrations/",
    ),
  });
  expect(await f.row(plugin)).toMatchObject({ active, pending: null });
  expect(await f.versions(plugin)).toBe(count);
  expect(await f.notes(service, plugin)).toMatchObject({ revision: 2, notes: ["v1:first"] });
  // A deploy whose migration fails is told so, and is never activated later.
  const failed = await service.install(
    {
      kind: "files",
      plugin,
      files: source(3, {
        migrations: [
          "CREATE TABLE notes (body TEXT NOT NULL);",
          "ALTER TABLE notes RENAME COLUMN body TO text;",
          "ALTER TABLE missing ADD COLUMN x;",
        ],
        column: "text",
      }),
    },
    caller,
  );
  expect(failed).toMatchObject({ status: "build-error", error: { stage: "migrate" } });
  await f.crash(service);
  const again = await f.open();
  expect(await f.row(plugin)).toMatchObject({ active, pending: null });
  expect(await f.notes(again, plugin)).toMatchObject({ revision: 2 });
}, 300_000);

/**
 * Interrupt a change once its step `step` is done, then start again and check it completed once.
 * After step 1 the engine stops while the migration runs; after step 2 while activation waits;
 * after step 3 once the version is active. A rebuild builds the same source, whose migrations are
 * all applied already, so its step 2 applies nothing: stopping after its step 1 is stopping after
 * its step 2.
 */
const interruptions = [
  ["owner deploy", 1],
  ["owner deploy", 2],
  ["owner deploy", 3],
  ["catalog install", 1],
  ["catalog install", 2],
  ["catalog install", 3],
  ["rebuild", 2],
  ["rebuild", 3],
] as const;

test.for(interruptions.map(([kind, step]) => ({ kind, step })))(
  "an engine stopped once a $kind's change is past step $step completes it at its next start",
  { timeout: 300_000 },
  async ({ kind, step }, context) => {
    // Revision 2 adds a migration that is slow when it is the change's step 2.
    const next = source(2, {
      migrations: [
        "CREATE TABLE notes (body TEXT NOT NULL);",
        step === 1 ? slow : "CREATE TABLE second (id INTEGER);",
      ],
      name: "fixture-plugin",
    });
    const f = await fixture(context, kind === "catalog install" ? { catalog: next } : {});
    let service = await f.open();
    let plugin: string | undefined;
    if (kind !== "catalog install") {
      plugin = (await f.install(service, source(1))).plugin.id;
      await f.call(service, plugin, "add", { body: "before" });
    }
    if (kind === "rebuild") {
      // The plugin runs revision 2 now; the next engine rebuilds it.
      plugin = (await f.install(service, next, plugin)).plugin.id;
      await f.crash(service);
      await outdate(f.directory, f.database, plugin);
    }
    const held = step === 2 ? await hold(f.database, "activate") : undefined;
    const before = plugin === undefined ? 0 : await f.versions(plugin);
    let installing: Promise<unknown> | undefined;
    if (kind === "rebuild") service = await f.open();
    else
      installing =
        kind === "owner deploy"
          ? service.install({ kind: "files", plugin: plugin!, files: next }, caller)
          : service.install({ kind: "catalog", id: "fixture", key: "catalog-install" }, caller);
    // An install that ends before the engine stops ends the test with what it said.
    let ended: unknown;
    void installing?.then(
      (outcome) => {
        ended = outcome;
      },
      () => {},
    );
    const early = () => {
      if (ended !== undefined && step !== 3)
        throw new Error(`The install ended: ${JSON.stringify(ended)}`);
    };
    // Find the app the change is for, once its version is pending or, after step 3, active.
    const target = async () =>
      plugin ??
      (
        await sql<{
          id: string;
        }>`SELECT id FROM plugin_engine.plugin_engine_apps ORDER BY created_at DESC LIMIT 1`.execute(
          f.database,
        )
      ).rows[0]?.id;
    if (step === 3)
      await vi.waitFor(
        async () => {
          const app = await target();
          expect(app).toBeDefined();
          const state = await f.row(app!);
          expect(state?.pending).toBeNull();
          expect(state?.active).not.toBeNull();
          if (plugin !== undefined) expect(await f.versions(plugin)).toBe(before + 1);
        },
        { timeout: 120_000, interval: 50 },
      );
    else if (step === 2) await held!.waiting(early);
    else
      await vi.waitFor(
        async () => {
          early();
          const app = await target();
          expect(app).toBeDefined();
          expect((await f.row(app!))?.pending).not.toBeNull();
        },
        { timeout: 120_000, interval: 20 },
      );
    const app = (await target())!;
    await f.crash(service);
    await held?.release();
    const again = await f.open();
    await vi.waitFor(async () => expect((await f.row(app))?.pending).toBeNull(), {
      timeout: 120_000,
      interval: 250,
    });
    await vi.waitFor(() => expect(again.rebuilding()).toBe(false), {
      timeout: 120_000,
      interval: 250,
    });
    expect(await f.notes(again, app)).toMatchObject({
      revision: 2,
      notes: kind === "catalog install" ? [] : ["v1:before"],
    });
    // One version came of the change, and an install's caller can read it with its key.
    if (kind === "catalog install") {
      expect(await f.versions(app)).toBe(1);
      expect(
        await again.install({ kind: "catalog", id: "fixture", key: "catalog-install" }, caller),
      ).toMatchObject({ status: "installed", plugin: { id: app } });
    } else expect(await f.versions(app)).toBe(before + 1);
  },
);

test("a change whose activation fails keeps its plugin updating, never on the old version, until it completes", async (context) => {
  const f = await fixture(context);
  const service = await f.open();
  const plugin = (await f.install(service, source(1))).plugin.id;
  const held = await hold(f.database, "fail");
  await expect(
    service.install(
      {
        kind: "files",
        plugin,
        files: source(2, {
          migrations: [
            "CREATE TABLE notes (body TEXT NOT NULL);",
            "CREATE TABLE second (id INTEGER);",
          ],
        }),
      },
      caller,
    ),
  ).rejects.toMatchObject({ tag: "PluginUpdating" });
  expect((await f.row(plugin))?.pending).not.toBeNull();
  expect(JSON.stringify(await f.call(service, plugin, "notes"))).toContain("plugin_updating");
  expect((await service.installed({ plugins: [plugin] }, caller))[0]?.updating).toBeDefined();
  // The same engine completes it once activating succeeds.
  await held.release();
  await vi.waitFor(async () => expect((await f.row(plugin))?.pending).toBeNull(), {
    timeout: 60_000,
    interval: 250,
  });
  expect(await f.notes(service, plugin)).toMatchObject({ revision: 2 });
  expect((await service.installed({ plugins: [plugin] }, caller))[0]?.updating).toBeUndefined();
}, 300_000);

test("an engine that completes a change at start for a plugin with an app-account schedule starts", async (context) => {
  const f = await fixture(context);
  const service = await f.open();
  const v1 = await f.install(service, source(1, { appAccount: true }));
  const plugin = v1.plugin.id;
  const provider = v1.plugin.requirements.accounts.service!.provider;
  const account = await service.createApiKeyAccount(
    { provider, method: "key", fields: { token: "synthetic" }, key: "account" },
    caller,
  );
  const target = { plugin, requirement: "service", scope: "app" as const };
  const consent = await service.reviewAccountLink(target, caller);
  await service.linkAccount({ ...target, account: account.id, consent }, caller);
  await service.manage(
    {
      operation: "schedules.configure",
      input: { app: plugin, name: "tick", enabled: true, scope: "app", key: "tick" },
    },
    caller,
  );
  const held = await hold(f.database, "activate");
  void service
    .install(
      {
        kind: "files",
        plugin,
        files: source(2, {
          appAccount: true,
          migrations: [
            "CREATE TABLE notes (body TEXT NOT NULL);",
            "CREATE TABLE second (id INTEGER);",
          ],
        }),
      },
      caller,
    )
    .catch(() => {});
  await held.waiting();
  await f.crash(service);
  await held.release();
  // Completing the change reconciles the schedule, which reads the app's account links from the
  // engine; the engine is ready first, so its start never waits on itself.
  const again = await f.open();
  await vi.waitFor(async () => expect((await f.row(plugin))?.pending).toBeNull(), {
    timeout: 60_000,
    interval: 250,
  });
  expect(await f.notes(again, plugin)).toMatchObject({ revision: 2 });
  const detail = await again.detail({ plugin }, caller);
  expect(detail.schedules).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "tick",
        settings: expect.objectContaining({ enabled: true }),
      }),
    ]),
  );
}, 300_000);

test("a rebuild installs the packages its version's build installed, not newer ones", async (context) => {
  const f = await fixture(context);
  f.labels.set("1.0.0", await archive(f.directory, "1.0.0"));
  const service = await f.open();
  const v1 = await f.install(service, source(1, { dependency: "^1.0.0" }));
  const plugin = v1.plugin.id;
  expect(await f.notes(service, plugin)).toMatchObject({ label: "label 1.0.0" });
  const slug = (await service.installed({ plugins: [plugin] }, caller))[0]!.plugin.slug;
  const paused = await service.execute(
    { code: `return await tools.${slug}.reviewed({ body: "reviewed" });` },
    caller,
  );
  expect(paused.state).toBe("waiting");
  // A newer release of the package is published since, and the range and tag both name it.
  f.labels.set("1.1.0", await archive(f.directory, "1.1.0"));
  f.setLatest("1.1.0");
  // Activating the version builds its source again with the package its build installed, so
  // the work reviewed on it continues on the new version.
  await service.activate({ plugin, version: v1.version.id }, caller);
  expect(await f.notes(service, plugin)).toMatchObject({ label: "label 1.0.0" });
  await service.answer({ execution: paused.id, response: { action: "accept" } }, caller);
  expect((await service.resume({ execution: paused.id }, caller)).result).toMatchObject({
    status: "completed",
    execution: { ok: true, value: "reviewed" },
  });
  // A deploy of the same source resolves its range again.
  await f.install(service, source(1, { dependency: "^1.0.0" }), plugin);
  expect(await f.notes(service, plugin)).toMatchObject({ label: "label 1.1.0" });
}, 300_000);

test("a version change waits a bounded time for a call that waits on a person, and no call overtakes it", async (context) => {
  const f = await fixture(context);
  const service = await f.open();
  const plugin = (await f.install(service, source(1))).plugin.id;
  const slug = (await service.installed({ plugins: [plugin] }, caller))[0]!.plugin.slug;
  // A call that asks the person something holds the plugin while it waits for the answer.
  const asking = await service.execute({ code: `return await tools.${slug}.ask({});` }, caller);
  expect(asking.state).toBe("waiting");
  const order: string[] = [];
  const changing = service.install({ kind: "files", plugin, files: source(2) }, caller).then(
    () => order.push("changed"),
    (error: unknown) => {
      order.push("busy");
      return error;
    },
  );
  // Once the change waits, a new call waits behind it rather than starting first.
  await vi.waitFor(
    async () =>
      expect((await service.installed({ plugins: [plugin] }, caller))[0]?.updating).toEqual({
        reason: "Its version is changing.",
      }),
    { timeout: 60_000, interval: 50 },
  );
  const calling = f.notes(service, plugin).then((value) => {
    order.push("called");
    return value;
  });
  const refused = await changing;
  expect(order[0]).toBe("busy");
  expect(refused).toMatchObject({ tag: "PluginBusy" });
  expect(await calling).toMatchObject({ revision: 1 });
  expect(order).toEqual(["busy", "called"]);
  // Nothing of the change happened.
  expect(await f.versions(plugin)).toBe(1);
  expect((await f.row(plugin))?.pending).toBeNull();
  await service.answer(
    { execution: asking.id, response: { action: "accept", content: { name: "x" } } },
    caller,
  );
  expect((await service.resume({ execution: asking.id }, caller)).result).toMatchObject({
    status: "completed",
  });
}, 300_000);

test("a call that waited behind a version change is decided on access and links as they are when it runs", async (context) => {
  const f = await fixture(context);
  const service = await f.open();
  const v1 = await f.install(service, source(1, { appAccount: true }));
  const plugin = v1.plugin.id;
  const provider = v1.plugin.requirements.accounts.service!.provider;
  const account = await service.createApiKeyAccount(
    { provider, method: "key", fields: { token: "synthetic" }, key: "account" },
    caller,
  );
  const link = { plugin, requirement: "service", scope: "app" as const };
  const consent = await service.reviewAccountLink(link, caller);
  await service.linkAccount({ ...link, account: account.id, consent }, caller);
  /**
   * A change that waits for a running call of the plugin, so no new call starts, and then changes
   * nothing: its step 1 is refused. Until `done` the call it waits for runs.
   */
  const pausedChange = async () => {
    await sql
      .raw(
        `CREATE OR REPLACE FUNCTION plugin_engine.test_refuse_prepare() RETURNS trigger LANGUAGE plpgsql AS $refuse$
        BEGIN RAISE EXCEPTION 'prepare refused by the test'; END; $refuse$;
        DROP TRIGGER IF EXISTS test_refuse_prepare ON plugin_engine.plugin_engine_deployments;
        CREATE TRIGGER test_refuse_prepare BEFORE INSERT ON plugin_engine.plugin_engine_deployments
        FOR EACH ROW EXECUTE FUNCTION plugin_engine.test_refuse_prepare();`,
      )
      .execute(f.database);
    f.resetReached();
    const running = f.call(service, plugin, "wait");
    await f.reached();
    const changing = service
      .install({ kind: "files", plugin, files: source(2, { appAccount: true }) }, caller)
      .then(
        () => "changed",
        () => "refused",
      );
    // The owner sees the plugin updating as soon as a change waits for it.
    await vi.waitFor(
      async () =>
        expect((await service.installed({ plugins: [plugin] }, caller))[0]?.updating).toEqual({
          reason: "Its version is changing.",
        }),
      { timeout: 60_000, interval: 50 },
    );
    return {
      done: async () => {
        f.waiting.shift()!();
        await running;
        expect(await changing).toBe("refused");
        await sql
          .raw("DROP TRIGGER test_refuse_prepare ON plugin_engine.plugin_engine_deployments")
          .execute(f.database);
      },
    };
  };
  /** Until the engine has asked to authorize `count` more calls than `before`. */
  const asked = (before: number, count: number) =>
    vi.waitFor(
      () =>
        expect(f.authorized.filter((operation) => operation === "call").length).toBe(
          before + count,
        ),
      { timeout: 30_000, interval: 20 },
    );
  // The plugin becomes read-only while a write waits behind the change. The calls are decided on
  // what is true once they run, whenever they queued.
  let change = await pausedChange();
  let before = f.authorized.filter((operation) => operation === "call").length;
  const writing = f.call(service, plugin, "add", { body: "late" });
  const reading = f.notes(service, plugin);
  await asked(before, 2);
  f.refuse.writes = true;
  await change.done();
  expect(await writing).toMatchObject({ execution: { ok: true, value: { ok: false } } });
  expect(await reading).toMatchObject({ revision: 1, notes: [] });
  f.refuse.writes = false;
  // The app account is unlinked while a call that captured it waits behind the change.
  change = await pausedChange();
  before = f.authorized.filter((operation) => operation === "call").length;
  const linked = f.call(service, plugin, "notes");
  await asked(before, 1);
  await service.unlinkAccount({ ...link, account: account.id }, caller);
  await change.done();
  expect(await linked).toMatchObject({ execution: { ok: true, value: { ok: false } } });
  expect(await f.versions(plugin)).toBe(1);
}, 300_000);
