import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { PluginService } from "../apps/host/src/plugins/plugin-service.js";
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
} from "../packages/database/src/test-database.test-support.js";
import { pluginFixtureRegistry } from "../scripts/plugin-engine/fixture.ts";
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

/** A plugin as the Host on the baseline built it: written for upstream's names. */
const source = (framework: string) => [
  {
    path: "package.json",
    content: JSON.stringify({
      name: `${old("manifest-name")}upgrade-fixture`,
      type: "module",
      [old("manifest-key")]: { title: "Upgrade fixture" },
      dependencies: { apps: framework },
    }),
  },
  {
    path: "migrations/0001_notes.sql",
    content: `CREATE TABLE notes (body TEXT NOT NULL);\nINSERT INTO notes (body) SELECT body FROM ${old("reserved-table", "_legacy_rows")};\n`,
  },
  {
    path: "index.ts",
    content: `
import { defineApp, defineProvider, secrets, object, string, query, mutation, router, userInterval } from "apps";
const service = defineProvider({ name: "Upgrade fixture", auth: { key: secrets({ label: "API key", fields: object({ token: string() }) }) } });
const add = mutation({ input: object({ body: string() }) }, async (ctx, { body }) => {
  ctx.sql.exec("INSERT INTO notes (body) VALUES (?)", body);
  return body;
});
export default defineApp({ user: { accounts: { service } } }, {
  tools: router({
    add,
    notes: query({ input: object({}) }, async (ctx) => ({
      notes: ctx.sql.exec("SELECT body FROM notes ORDER BY rowid").toArray().map((row) => row.body),
      applied: ctx.sql.exec("SELECT count(*) AS applied FROM ${old("reserved-table", "_migrations")}").one().applied,
      token: ctx.user.accounts.service.fields.token,
    })),
  }),
  schedules: { tick: userInterval({ minutes: 60 }, add, { body: "schedule" }) },
  webhooks: { incoming: { account: { user: "service" }, config: object({}), state: object({}),
    setup: { instructions: "Paste the callback and signing secret at the provider.", signingSecret: ${JSON.stringify(old("signing-secret"))} },
    handle: async () => new Response("ok"),
  } },
});`,
  },
];

/** Drives the baseline's Host: install, account, data, schedule and a completed manual setup. */
const driver = `
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { PluginService } from "./apps/host/src/plugins/plugin-service.ts";
import { pluginFixtureRegistry } from "./scripts/plugin-engine/fixture.ts";
const [databaseUrl, dataDirectory, registryDirectory, sourceFile, resultFile] = process.argv.slice(2);
const caller = { caller: "owner:task", mode: "ask" };
const registry = await pluginFixtureRegistry(registryDirectory);
const service = new PluginService({
  processEntry: new URL("./apps/host/dist/plugin-engine.js", import.meta.url),
  bridge: new URL("./apps/host/dist/plugin-engine-bridge.json", import.meta.url).pathname,
  databaseUrl, dataDirectory, owner: "owner", credentialKey: new Uint8Array(32).fill(1),
  origin: "https://fixture.invalid", webhookOrigin: async () => "https://hooks.fixture.invalid",
  npmRegistry: registry.origin, catalogUrl: registry.origin + "/catalog", idleMs: 0,
});
try {
  await service.start();
  const files = JSON.parse(await readFile(sourceFile, "utf8"));
  const installed = await service.install({ kind: "files", name: "Upgrade", files }, caller);
  if (installed.status !== "installed") throw new Error(JSON.stringify(installed));
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
  const detail = await service.detail({ plugin }, caller);
  await writeFile(resultFile, JSON.stringify({ plugin, version: installed.version.id, account: account.id, added, webhook: webhook.id, setup, detail }));
} finally {
  await service.close();
  await registry.close();
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

test(
  "rebuilds a plugin installed by the baseline Host for this Host's framework, keeping its state",
  async (context) => {
    const baseline = await baselineCheckout();
    const clone = await cloneTestDatabase("host");
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
    await writeFile(join(work, "source.json"), JSON.stringify(source(baselineFramework)));
    await writeFile(join(baseline.directory, "plugin-upgrade-driver.ts"), driver);
    execFileSync(
      join(baseline.directory, "node_modules/.bin/tsx"),
      [
        "plugin-upgrade-driver.ts",
        clone.url,
        dataDirectory,
        join(work, "registry"),
        join(work, "source.json"),
        join(work, "before.json"),
      ],
      { cwd: baseline.directory, stdio: "inherit" },
    );
    const before = JSON.parse(await readFile(join(work, "before.json"), "utf8"));
    expect(before.added.result).toMatchObject({ execution: { value: { ok: true } } });
    expect(before.detail.webhooks).toMatchObject([{ id: before.webhook, status: "active" }]);

    // The upgraded Host: the same database and plugin store, and a registry with no framework.
    const registry = await pluginFixtureRegistry();
    context.onTestFinished(() => registry.close());
    const open = async () => {
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
      });
      await ownTestDatabaseProducer(clone.url, async () => ({ close: () => service.close() }));
      context.onTestFinished(() => service.close());
      await service.start();
      return service;
    };
    /** Start the engine and wait until its rebuild pass is done. */
    const settle = async (service: PluginService) => {
      await service.health({}, caller);
      await vi.waitFor(() => expect(service.rebuilding()).toBe(false), {
        timeout: 120_000,
        interval: 100,
      });
    };

    const service = await open();
    await settle(service);
    const versions = await service.versions({ plugin: before.plugin }, caller);
    expect(versions).toHaveLength(2);
    const rebuilt = versions.find((version) => version.id !== before.version);
    expect(rebuilt).toBeDefined();

    const listed = await service.list({}, caller);
    expect(listed).toMatchObject([{ id: before.plugin, activeVersion: rebuilt!.id }]);
    // The account, its link, the plugin's rows and its renamed migration history all survived.
    const called = await service.call(
      { calls: { path: "tools.upgrade.notes", input: {} } },
      caller,
    );
    expect(called.result).toMatchObject({
      execution: {
        value: { ok: true, value: { notes: ["before"], applied: 1, token: "synthetic" } },
      },
    });
    expect((await service.accounts({}, caller)).map((account) => account.id)).toContain(
      before.account,
    );
    const detail = await service.detail({ plugin: before.plugin }, caller);
    expect(detail.schedules).toMatchObject([{ name: "tick", settings: { enabled: true } }]);
    // The completed setup is not carried: once the new version's webhooks reconcile, the webhook
    // needs setting up again, with a new callback URL and secret, as a newly installed one does.
    const webhooks = await vi.waitFor(
      async () => {
        const listed = (await service.detail({ plugin: before.plugin }, caller)).webhooks;
        expect(listed.map((hook) => hook.status).sort()).toEqual(["setup-required", "stopped"]);
        return listed;
      },
      { timeout: 60_000, interval: 250 },
    );
    const webhook = webhooks.find((hook) => hook.status === "setup-required");
    expect(webhooks.find((hook) => hook.status === "stopped")?.id).toBe(before.webhook);
    const setup = (await service.manage(
      {
        operation: "webhookSetup.read",
        input: { app: before.plugin, subscription: webhook!.id },
      },
      caller,
    )) as { step: string; subscription: { callbackUrl: string }; signingSecret: unknown };
    expect(setup.step).toBe("configure");
    expect(setup.subscription.callbackUrl).not.toBe(before.setup.subscription.callbackUrl);
    expect(setup.signingSecret).toMatchObject({ source: "plugin-engine" });

    // A second start finds every plugin built for this framework and builds nothing.
    await service.close();
    const again = await open();
    await settle(again);
    expect(await again.versions({ plugin: before.plugin }, caller)).toHaveLength(2);
    expect(await again.list({}, caller)).toMatchObject([{ activeVersion: rebuilt!.id }]);
  },
  15 * 60_000,
);
