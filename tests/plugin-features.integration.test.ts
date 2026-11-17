import { beforeEach, expect, test, vi } from "vitest";
import Fastify from "fastify";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { sql } from "kysely";
import { z } from "zod";
import { createId, type AuthenticatedSession } from "../packages/core/src/index.js";
import {
  createDatabase,
  OpensteerStore,
  PluginAgentStore,
  requirePersonalOwner,
} from "../packages/database/src/index.js";
import { RunPluginsPlanSchema, type HostApiServerContext } from "../packages/protocol/src/index.js";
import { withTimeout } from "@opensteer/shared/withTimeout";
import {
  queryPath,
  mutatePath,
  subscribePath,
  versionPath,
  assetsPath,
  signingSecretSource,
} from "apps/published-compat";
import { pluginFixtureFiles, pluginFixtureRegistry } from "../scripts/plugin-engine/fixture.js";
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
} from "../packages/database/src/test-database.test-support.js";
import { seedPersonalFixture } from "../packages/database/src/personal-fixture.test-support.js";
import { PluginService } from "../apps/host/src/plugins/plugin-service.js";
import { PluginOwnerApi } from "../apps/host/src/plugins/plugin-owner-api.js";
import { PluginAuthority } from "../apps/host/src/plugins/plugin-authority.js";
import { PluginPages } from "../apps/host/src/plugins/plugin-pages.js";
import { registerPluginWebhookRoutes } from "../apps/host/src/plugins/plugin-webhook-routes.js";
import { AppGateway } from "../apps/host/src/apps/app-gateway.js";
import { registerAppRoutes } from "../apps/host/src/apps/app-routes.js";
import { cacheRunPlugins } from "../apps/runner/src/skills/plugin-cache.js";
import { PluginPackageService } from "../apps/host/src/local-servers/plugin-package-service.js";
import { engineDemand } from "../apps/host/src/plugins/engine-storage.js";
import { createPersonalRunFixturePort } from "../packages/database/src/personal-run-fixture.test-support.js";
import { RunCapabilityTokenService } from "../apps/host/src/agents/run-capability.js";
import { SignedTokenService } from "../apps/host/src/identity/host-keys.js";

import { mutationIdempotencyKey } from "../packages/client/src/host/host-session-client.js";

const owner = { caller: "personal", mode: "automatic" } as const;
const deadline = <T>(work: Promise<T>, message: string) =>
  withTimeout(work, 12_000, { timeoutError: () => new Error(message) });
let directory: string;
let database: ReturnType<typeof createDatabase>;
let service: PluginService;
let records: PluginAgentStore;
let personal: Awaited<ReturnType<typeof seedPersonalFixture>>;
let registry: Awaited<ReturnType<typeof pluginFixtureRegistry>>;
let api: PluginOwnerApi;
let pages: PluginPages;
let context: HostApiServerContext;
let url: string;
let publicOrigin: string | undefined = "https://fixture.invalid";
const states = new EventEmitter();

function files(revision = 1, wider = false) {
  return [
    ...pluginFixtureFiles(revision).filter((f) => f.path !== "index.ts"),
    {
      path: "ui/index.html",
      content:
        '<!doctype html><html><head><title>Fixture page</title></head><body>Plugin fixture<script type="module" src="./main.js"></script></body></html>',
    },
    { path: "ui/main.js", content: 'document.body.dataset.loaded = "yes";' },
    {
      path: "migrations/0001_events.sql",
      content:
        "CREATE TABLE ticks (id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL, source TEXT NOT NULL);",
    },
    {
      path: "index.ts",
      content: `
import { defineApp, defineProvider, secrets, object, string, query, mutation, router, userInterval, workflow, event } from "apps";
import { always } from "apps/operations/approval";
const service = defineProvider({ name: "Feature fixture", hosts: ${JSON.stringify(wider ? ["api.fixture.invalid", "other.fixture.invalid"] : ["api.fixture.invalid"])}, auth: { key: secrets({ label: "API key", fields: object({ token: string() }) }) } });
const received = event({ description: "Received a callback", payload: object({ body: string() }) });
const requirements = { user: { accounts: { service } }, events: { received } };
const tick = mutation({ input: object({ source: string() }) }, async (ctx, { source }) => {
  ctx.sql.exec("INSERT INTO ticks (account, source) VALUES (?, ?)", ctx.user.accounts.service.id, source);
  return { account: ctx.user.accounts.service.id, revision: ${revision} };
});
const reviewed = mutation({ input: object({ source: string() }), approval: always() }, async (ctx, { source }) => {
  ctx.sql.exec("INSERT INTO ticks (account, source) VALUES (?, ?)", ctx.user.accounts.service.id, source); return source;
});
export default defineApp(requirements, { tools: router({ tick, reviewed,
  ticks: query({ input: object({}) }, async ctx => ctx.sql.exec("SELECT account, source FROM ticks ORDER BY id").toArray()),
}), schedules: { tick: userInterval({ minutes: 1 }, tick, { source: "schedule" }), reviewed: userInterval({ minutes: 1 }, reviewed, { source: "reviewed" }) },
workflows: { quick: workflow({ input: object({}) }, async () => "done"), hold: workflow({ input: object({}) }, async ctx => { await ctx.step.sleep("hold", "1 hour"); return "done"; }) },
webhooks: { incoming: { account: { user: "service" }, config: object({}), state: object({}), setup: { instructions: "Paste the callback and signing secret at the provider.", signingSecret: ${JSON.stringify(signingSecretSource)} },
  handle: async (ctx, { request, secret }) => {
    const body = await request.text();
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const signature = request.headers.get("x-signature") || "";
    const bytes = Uint8Array.from(signature.match(/../g) || [], part => parseInt(part, 16));
    if (!await crypto.subtle.verify("HMAC", key, bytes, new TextEncoder().encode(body))) return new Response("invalid", { status: 401 });
    ctx.events.emit("received", { body });
    return Response.json({ body, account: ctx.user.accounts.service.id });
  },
} } });`,
    },
  ];
}
async function install(name: string, revision = 1, withWebhook = true) {
  const source = files(revision)
    .map((file) =>
      name === "Workflow history" && file.path === "index.ts"
        ? {
            ...file,
            content: file.content.replace('async () => "done"', 'async () => "x".repeat(900000)'),
          }
        : file,
    )
    .map((file) =>
      file.path === "index.ts" && !withWebhook
        ? {
            ...file,
            content: file.content.slice(0, file.content.indexOf("webhooks: { incoming:")) + "\n});",
          }
        : file,
    );
  const result = await service.install({ kind: "files", name, files: source }, owner);
  expect(result.status, JSON.stringify(result)).toBe("installed");
  if (result.status !== "installed") throw new Error("Fixture failed to build");
  await records.recordInstall(personal.userId, result.plugin.id, result.version.id, "agent");
  const requirement = result.plugin.requirements.accounts.service!;
  const target = { pluginId: result.plugin.id, requirement: "service", scope: "user" as const };
  const review = await api.review(target, personal.userId);
  const account = await api.command(
    {
      type: "plugins.account.create",
      idempotencyKey: randomUUID(),
      provider: requirement.provider,
      method: "key",
      fields: { token: "synthetic-key" },
      link: { ...target, consent: review.consent },
    },
    context,
  );
  if (account.type !== "plugins.account.create") throw new Error("No account");
  return {
    plugin: result.plugin.id,
    version: result.version.id,
    account: account.account.id,
    target,
  };
}
async function due(plugin: string, name: string) {
  await sql`UPDATE plugin_engine.plugin_engine_schedules SET next_at = (now() AT TIME ZONE 'UTC') WHERE app = ${plugin} AND name = ${name}`.execute(
    database,
  );
}
async function runs(plugin: string, status: string) {
  return vi.waitFor(
    async () => {
      const result = await api.reads()["plugins.schedule.runs"]({ pluginId: plugin }, context);
      expect(result.ok, "Schedule runs read failed").toBe(true);
      if (!result.ok) throw new Error("Runs read failed");
      const run = result.data.runs.find((run) => run.status === status);
      expect(run, `Schedule never reached ${status}`).toBeDefined();
      return run!;
    },
    { timeout: 10_000 },
  );
}
function onBackground<T>(read: () => T, matches: (value: Awaited<T>) => boolean) {
  const next = Promise.withResolvers<Awaited<T>>();
  const changed = () => {
    void Promise.resolve(read()).then((value) => {
      if (matches(value)) next.resolve(value);
    }, next.reject);
  };
  states.on("background", changed);
  return deadline(next.promise, "Committed background state never reached its subscriber").finally(
    () => states.off("background", changed),
  );
}
beforeEach(async (testContext) => {
  publicOrigin = "https://fixture.invalid";
  const clone = await cloneTestDatabase("host");
  url = clone.url;
  directory = await mkdtemp(join(tmpdir(), "opensteer-plugin-features-"));
  testContext.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  database = createDatabase({ connectionString: clone.url });
  testContext.onTestFinished(() => database.destroy());
  personal = await seedPersonalFixture(database, directory);
  records = new PluginAgentStore(database);
  registry = await pluginFixtureRegistry(directory, undefined, files(), (request, response) => {
    if (request.url !== "/openapi.json") return false;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        openapi: "3.0.3",
        info: { title: "Replay", version: "1" },
        servers: [{ url: registry.origin }],
        paths: {
          "/items": {
            get: { operationId: "listItems", responses: { "200": { description: "Items" } } },
          },
        },
      }),
    );
    return true;
  });
  testContext.onTestFinished(() => registry.close());
  const authority = new PluginAuthority({
    store: new OpensteerStore(database),
    settings: records,
    owner: async () => personal.userId,
  });
  service = new PluginService({
    databaseUrl: clone.url,
    dataDirectory: directory,
    owner: "personal",
    credentialKey: new Uint8Array(32).fill(9),
    origin: "https://fixture.invalid",
    webhookOrigin: async () => publicOrigin,
    npmRegistry: registry.origin,
    catalogUrl: registry.origin + "/catalog",
    selfOrigin: { origin: "https://api.fixture.invalid", address: registry.address },
    processEntry: new URL("../apps/host/dist/plugin-engine.js", import.meta.url),
    bridge: new URL("../apps/host/dist/plugin-engine-bridge.json", import.meta.url).pathname,
    authorize: (input, signal) => authority.authorize(input, signal),
    idleMs: 0,
    onState: (state) => states.emit(state.status, state),
    onResourcesChanged: () => states.emit("background"),
  });
  testContext.onTestFinished(() => service.close());
  await ownTestDatabaseProducer(clone.url, async () => ({ close: () => service.close() }));
  pages = new PluginPages({
    service,
    assertOwner: (user) => requirePersonalOwner(database, user),
    access: async (user, plugin) =>
      (await records.settings(user)).find((row) => row.pluginId === plugin)?.access ?? "all",
  });
  api = new PluginOwnerApi({
    service,
    settings: records,
    assertOwner: (user) => requirePersonalOwner(database, user),
    accountLinked: async () => {},
    changed: () => states.emit("ownerChanged"),
    pages,
    webhooks: { service, origin: () => service.webhookOrigin() },
  });
  const session: AuthenticatedSession = {
    id: createId("authSession"),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    absoluteExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    user: {
      id: personal.userId,
      displayName: "Person",
      email: "fixture@example.test",
      emailVerified: true,
      disabledAt: null,
      image: null,
    },
  };
  context = {
    session,
    headers: { host: "localhost:8799" },
    requestId: "fixture",
    requestUrl: "/",
    signal: new AbortController().signal,
    surface: "canonical",
    setHeader: () => {},
  };
  await service.start();
});

const freshOwnerApi = () =>
  new PluginOwnerApi({
    service,
    settings: records,
    assertOwner: (user) => requirePersonalOwner(database, user),
    accountLinked: async () => {},
    changed: () => {},
  });

test("account creation returns its original ID after owner cache loss and an engine restart", async () => {
  const secured = await service.install(
    {
      kind: "files",
      name: "Replay account",
      files: pluginFixtureFiles(1, ["api.fixture.invalid"]),
    },
    owner,
  );
  if (secured.status !== "installed") throw new Error("Fixture failed");
  const create = {
    type: "plugins.account.create" as const,
    idempotencyKey: randomUUID(),
    provider: secured.plugin.requirements.accounts.service!.provider,
    method: "key",
    fields: { token: "never-in-receipts" },
  };
  const failedResponse = new PluginOwnerApi({
    service,
    settings: records,
    assertOwner: (user) => requirePersonalOwner(database, user),
    accountLinked: async () => {},
    changed: () => {
      throw new Error("Lost committed response");
    },
  });
  await expect(failedResponse.command(create, context)).rejects.toThrow("Lost committed response");
  const account = (await service.accounts({}, owner))[0]!;
  expect(await service.stopIfIdle()).toBe(true);
  expect(await freshOwnerApi().command(create, context)).toMatchObject({
    type: "plugins.account.create",
    account: { id: account.id, provider: account.provider, label: account.label },
  });
  expect(await service.accounts({}, owner)).toHaveLength(1);
  const receipts = await sql`select * from plugin_engine.opensteer_resource_creations`.execute(
    database,
  );
  const history = await database.selectFrom("commands").selectAll().execute();
  expect(JSON.stringify([receipts.rows, history])).not.toContain("never-in-receipts");
});

test.each(["catalog", "url", "files"] as const)(
  "%s installation replays its committed result after an engine restart",
  async (kind) => {
    const key = randomUUID();
    const command = {
      type: "plugins.install" as const,
      source:
        kind === "catalog"
          ? { kind: "catalog" as const, catalogId: "fixture" }
          : {
              kind: "openapi" as const,
              url: `${registry.origin}/openapi.json`,
              name: "URL replay",
            },
      idempotencyKey: key,
    };
    const invoke = () =>
      kind === "files"
        ? service.install(
            { kind: "files", name: "local-replay", files: pluginFixtureFiles(1), key },
            owner,
          )
        : freshOwnerApi().command(command, context);
    const first = await invoke();
    expect(await service.stopIfIdle()).toBe(true);
    expect(await invoke()).toEqual(first);
    expect(await service.list({}, owner)).toHaveLength(1);
    if (kind === "files") {
      const plugin = (await service.list({}, owner))[0]!.id;
      const update = {
        kind: "files" as const,
        plugin,
        files: pluginFixtureFiles(2),
        key: randomUUID(),
      };
      const deployed = await service.install(update, owner);
      expect(await service.install(update, owner)).toEqual(deployed);
      expect(await service.versions({ plugin }, owner)).toHaveLength(2);
    }
  },
);

test("owner reads and commands match real catalog, accounts, schedule approvals, versions and workflow runs", async () => {
  const fixture = await install("Owner fixture");
  const detail = await api.detail(personal.userId, fixture.plugin);
  expect(
    (await service.list({}, owner)).find((plugin) => plugin.id === fixture.plugin)?.page,
  ).toEqual({ kind: "plugin", pluginId: fixture.plugin });
  expect(detail.skills).toEqual([{ name: "demo", description: "Fixture skill" }]);
  expect(detail.schedules).toMatchObject([{ name: "reviewed" }, { name: "tick" }]);
  expect(detail.workflows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "hold" }),
      expect.objectContaining({ name: "quick" }),
    ]),
  );
  expect(detail.versions).toMatchObject([{ id: fixture.version, active: true }]);
  expect(detail.requirements[0]?.links).toMatchObject([
    { current: true, account: { id: fixture.account } },
  ]);
  // Connected accounts is one read: the provider's name and the plugins each account serves.
  const saved = await api.reads()["plugins.accounts.list"]({}, context);
  expect(saved.ok && saved.data.accounts.find(({ id }) => id === fixture.account)).toMatchObject({
    providerName: detail.requirements[0]!.providerName,
    links: [{ pluginId: fixture.plugin, pluginName: detail.plugin.name }],
  });
  await api.command(
    {
      type: "plugins.schedule.configure",
      pluginId: fixture.plugin,
      schedule: "reviewed",
      enabled: true,
      approvalMode: "browser",
      idempotencyKey: randomUUID(),
    },
    context,
  );
  const scheduledChange = onBackground(
    () => api.reads()["plugins.schedule.runs"]({ pluginId: fixture.plugin }, context),
    (page) => page.ok && page.data.runs.some((run) => run.status === "awaiting-approval"),
  );
  await due(fixture.plugin, "reviewed");
  const approvalPage = await scheduledChange;
  if (!approvalPage.ok) throw new Error("Schedule read failed");
  const approved = approvalPage.data.runs.find((run) => run.status === "awaiting-approval")!;
  expect(approved.approval).toEqual({ tool: "reviewed", arguments: { source: "reviewed" } });
  await api.command(
    {
      type: "plugins.schedule.answer",
      pluginId: fixture.plugin,
      runId: approved.id,
      action: "accept",
      idempotencyKey: randomUUID(),
    },
    context,
  );
  await runs(fixture.plugin, "succeeded");
  await due(fixture.plugin, "reviewed");
  const declined = await runs(fixture.plugin, "awaiting-approval");
  expect(declined.id).not.toBe(approved.id);
  await api.command(
    {
      type: "plugins.schedule.answer",
      pluginId: fixture.plugin,
      runId: declined.id,
      action: "decline",
      idempotencyKey: randomUUID(),
    },
    context,
  );
  await runs(fixture.plugin, "denied");
  // History that outgrows one IPC message still reads: the newest page, each row bounded.
  const prefix = randomUUID();
  await sql`INSERT INTO plugin_engine.plugin_engine_scheduled_runs
      (id, schedule_id, app, installation, owner, name, status, scheduled_at, started_at,
       finished_at, request_id, expires_at, failure, runner, revision, answer)
    SELECT ${prefix} || '-' || n, schedule_id, app, installation, owner, name, 'failed',
      scheduled_at - n * interval '1 minute', started_at - n * interval '1 minute', finished_at,
      null, null, repeat('x', 40000), runner, revision, null
    FROM plugin_engine.plugin_engine_scheduled_runs, generate_series(1, 60) n
    WHERE id = ${declined.id}`.execute(database);
  const history = await api.reads()["plugins.schedule.runs"]({ pluginId: fixture.plugin }, context);
  if (!history.ok) throw new Error("A long schedule history did not read");
  expect(history.data.runs).toHaveLength(50);
  expect(history.data.runs.map(({ id }) => id)).toContain(declined.id);
  expect(Math.max(...history.data.runs.map((run) => run.failure?.length ?? 0))).toBe(1000);
  const pending = await api
    .reads()
    ["plugins.schedule.runs"]({ pluginId: fixture.plugin, pending: true }, context);
  expect(pending.ok && pending.data.runs).toEqual([]);
  // An agent pages the whole history on start time, which never changes.
  const agentRuns: string[] = [];
  let scheduleCursor: string | undefined;
  do {
    const page = z
      .object({ runs: z.array(z.object({ id: z.string() })), next: z.string().optional() })
      .passthrough()
      .parse(
        await service.resourcesRead(
          {
            pluginId: fixture.plugin,
            resource: "schedules",
            outputs: false,
            ...(scheduleCursor ? { cursor: scheduleCursor } : {}),
          },
          owner,
        ),
      );
    expect(page.runs.length).toBeLessThanOrEqual(20);
    expect("definitions" in page).toBe(scheduleCursor === undefined);
    agentRuns.push(...page.runs.map(({ id }) => id));
    scheduleCursor = page.next;
  } while (scheduleCursor);
  const stored = await sql<{
    count: number;
  }>`SELECT count(*)::int AS count FROM plugin_engine.plugin_engine_scheduled_runs WHERE app = ${fixture.plugin}`.execute(
    database,
  );
  expect(new Set(agentRuns).size).toBe(agentRuns.length);
  expect(agentRuns).toHaveLength(stored.rows[0]!.count);
  const discovered = await service.search({ query: "ticks" }, owner);
  const ticksPath = discovered.items.find((item) => item.path.endsWith(".ticks"))?.path;
  expect(ticksPath, "The query did not appear in the engine's catalog").toBeDefined();
  expect(
    (await service.call({ calls: { path: ticksPath!, input: {} } }, owner)).result,
  ).toMatchObject({
    status: "completed",
    execution: { value: { ok: true, value: [{ account: fixture.account, source: "reviewed" }] } },
  });
  await api.command(
    {
      type: "plugins.schedule.configure",
      pluginId: fixture.plugin,
      schedule: "reviewed",
      enabled: false,
      idempotencyKey: randomUUID(),
    },
    context,
  );
  const notices: string[][] = [[], []];
  const subscribers = notices.map((seen) => () => {
    seen.push("changed");
  });
  for (const subscriber of subscribers) states.on("ownerChanged", subscriber);
  try {
    const completed = onBackground(
      () => api.reads()["plugins.workflow.runs"]({ pluginId: fixture.plugin }, context),
      (page) =>
        page.ok &&
        page.data.runs.some((run) => run.workflow === "quick" && run.status === "complete"),
    );
    await api.command(
      {
        type: "plugins.workflow.start",
        pluginId: fixture.plugin,
        workflow: "quick",
        input: {},
        idempotencyKey: randomUUID(),
      },
      context,
    );
    await completed;
    const workflow = await api.command(
      {
        type: "plugins.workflow.start",
        pluginId: fixture.plugin,
        workflow: "hold",
        input: {},
        idempotencyKey: randomUUID(),
      },
      context,
    );
    if (workflow.type !== "plugins.workflow.start") throw new Error("No workflow");
    const workflowRuns = await api
      .reads()
      ["plugins.workflow.runs"]({ pluginId: fixture.plugin }, context);
    expect(workflowRuns).toMatchObject({
      ok: true,
      data: {
        runs: expect.arrayContaining([
          expect.objectContaining({ id: workflow.runId, workflow: "hold" }),
        ]),
      },
    });
    await api.command(
      {
        type: "plugins.workflow.stop",
        pluginId: fixture.plugin,
        runId: workflow.runId,
        idempotencyKey: randomUUID(),
      },
      context,
    );
    expect(notices).toEqual([
      ["changed", "changed", "changed"],
      ["changed", "changed", "changed"],
    ]);
  } finally {
    for (const subscriber of subscribers) states.off("ownerChanged", subscriber);
  }
  const invalidSkills = await service.install(
    {
      kind: "files",
      plugin: fixture.plugin,
      files: files().map((file) =>
        file.path === "skills/demo/SKILL.md"
          ? { ...file, content: "Missing skill frontmatter" }
          : file,
      ),
    },
    owner,
  );
  expect(invalidSkills).toMatchObject({ status: "build-error", error: { code: "invalid-skills" } });
  expect((await api.detail(personal.userId, fixture.plugin)).plugin.activeVersion).toBe(
    fixture.version,
  );
  const second = await service.install(
    { kind: "files", plugin: fixture.plugin, files: files(2) },
    owner,
  );
  expect(second.status, JSON.stringify(second)).toBe("installed");
  await api.command(
    {
      type: "plugins.version.activate",
      pluginId: fixture.plugin,
      versionId: fixture.version,
      idempotencyKey: randomUUID(),
    },
    context,
  );
  expect((await api.detail(personal.userId, fixture.plugin)).plugin.activeVersion).toBe(
    fixture.version,
  );
  await api.command(
    {
      type: "plugins.account.unlink",
      ...fixture.target,
      accountId: fixture.account,
      idempotencyKey: randomUUID(),
    },
    context,
  );
  expect((await api.detail(personal.userId, fixture.plugin)).plugin.status).toBe("needs-account");
  const review = await api.review(fixture.target, personal.userId);
  await api.command(
    {
      type: "plugins.account.link",
      ...fixture.target,
      accountId: fixture.account,
      consent: review.consent,
      idempotencyKey: randomUUID(),
    },
    context,
  );
  const catalog = await api.command(
    {
      type: "plugins.install",
      source: { kind: "catalog", catalogId: "fixture" },
      idempotencyKey: randomUUID(),
    },
    context,
  );
  expect(catalog).toMatchObject({ result: { status: "installed" } });
  await api.command(
    {
      type: "plugins.account.unlink",
      ...fixture.target,
      accountId: fixture.account,
      idempotencyKey: randomUUID(),
    },
    context,
  );
  for (const webhook of (await api.detail(personal.userId, fixture.plugin)).webhooks) {
    await api.command(
      {
        type: "plugins.webhook.remove",
        pluginId: fixture.plugin,
        webhookId: webhook.id,
        idempotencyKey: randomUUID(),
      },
      context,
    );
    const setup = await api
      .reads()
      ["plugins.webhook.setup.get"]({ pluginId: fixture.plugin, webhookId: webhook.id }, context);
    if (setup.ok && setup.data.step === "remove")
      await api.command(
        {
          type: "plugins.webhook.removal.confirm",
          pluginId: fixture.plugin,
          webhookId: webhook.id,
          idempotencyKey: randomUUID(),
        },
        context,
      );
  }
  await api.command(
    { type: "plugins.remove", pluginId: fixture.plugin, idempotencyKey: randomUUID() },
    context,
  );
  await api.command(
    { type: "plugins.account.remove", accountId: fixture.account, idempotencyKey: randomUUID() },
    context,
  );
});

test("a page uses its isolated gateway authority, calls tools as owner and never reaches a Host route", async (testContext) => {
  const fixture = await install("Page fixture");
  const app = Fastify();
  const apps = {
    get: async () => {
      throw new Error("No published apps");
    },
    response: async () => {
      throw new Error("No published apps");
    },
    connect: async () => {
      throw new Error("No published apps");
    },
    onRevoked: () => () => {},
    acceptTunnel: () => {},
    authorizeView: async () => {
      throw new Error("No published apps");
    },
  };
  const gateway = new AppGateway({
    apps,
    plugins: pages,
    identity: { isSessionCurrent: async () => true },
    signingKey: new Uint8Array(32).fill(8),
    canonicalOrigin: "http://localhost:8799",
    realOrigins: true,
  });
  gateway.installHttp(app);
  api.gateway(gateway);
  registerAppRoutes(app, apps, pages);
  app.get("/v1/owner-secret", async () => "Host secret");
  await app.ready();
  testContext.onTestFinished(() => app.close());
  const viewing = await api
    .reads()
    ["plugins.page.view"]({ pluginId: fixture.plugin, theme: "light" }, context);
  if (!viewing.ok || !viewing.data.entryUrl) throw new Error("No app origin");
  const entry = new URL(viewing.data.entryUrl);
  const refused = await app.inject({ url: "/v1/owner-secret", headers: { host: entry.host } });
  expect(refused.statusCode).toBe(403);
  expect(refused.body).not.toContain("Host secret");
  const document = await app.inject({
    url: entry.pathname + entry.search,
    headers: { host: entry.host },
  });
  expect(document.statusCode).toBe(200);
  expect(document.body).toContain("Plugin fixture");
  expect(document.headers["cache-control"]).toContain("private");
  const cookie = String(document.headers["set-cookie"]).split(";")[0]!;
  const hostRoute = await app.inject({
    url: "/v1/owner-secret",
    headers: { host: entry.host, cookie },
  });
  expect(hostRoute.body).not.toContain("Host secret");
  const call = await app.inject({
    method: "POST",
    url: mutatePath,
    headers: { host: entry.host, cookie, origin: entry.origin },
    payload: { version: fixture.version, name: "tick", input: { source: "page" } },
  });
  expect(call.statusCode, call.body).toBe(200);
  expect(call.json()).toMatchObject({ account: fixture.account });
  const review = await app.inject({
    method: "POST",
    url: mutatePath,
    headers: { host: entry.host, cookie, origin: entry.origin },
    payload: { version: fixture.version, name: "reviewed", input: { source: "must-not-run" } },
  });
  expect(review.statusCode).toBe(422);
  expect(review.json()).toEqual({ _tag: "UiFailed", reason: "operation_failed" });
  const result = await app.inject({
    method: "POST",
    url: queryPath,
    headers: { host: entry.host, cookie, origin: entry.origin },
    payload: { version: fixture.version, name: "ticks", input: {} },
  });
  expect(result.json()).toEqual([{ account: fixture.account, source: "page" }]);
  for (const path of [subscribePath, versionPath]) {
    const streamed = await service.page(
      {
        plugin: fixture.plugin,
        request: {
          url: entry.origin + path,
          method: path === versionPath ? "GET" : "POST",
          headers: { "content-type": "application/json" },
          body:
            path === versionPath
              ? ""
              : Buffer.from(
                  JSON.stringify({ version: fixture.version, name: "ticks", input: {} }),
                ).toString("base64"),
        },
      },
      owner,
    );
    expect(streamed.stream, "Page did not open its stream").toBeDefined();
    const reader = service.readStream(streamed.stream!)[Symbol.asyncIterator]();
    try {
      const frame = await deadline(reader.next(), "Page stream never produced its initial value");
      const text = Buffer.from(frame.value!).toString("utf8");
      if (path === versionPath) expect(text).toContain(`"version":"${fixture.version}"`);
      else
        expect(JSON.parse(text.slice("data: ".length).trim())).toEqual({
          type: "snapshot",
          value: [{ account: fixture.account, source: "page" }],
        });
    } finally {
      await reader.return?.();
    }
  }
  const assetPath = document.body.match(/src="([^"]+)"/u)?.[1];
  expect(assetPath).toContain(`${assetsPath}${fixture.version}/`);
  const asset = await app.inject({
    url: assetPath!,
    headers: { host: entry.host, cookie },
  });
  expect(asset.statusCode).toBe(200);
  expect(asset.body).toContain("dataset.loaded");
  const capability = await app.inject({ url: viewing.data.path });
  expect(capability.statusCode, capability.body).toBe(200);
  expect(capability.headers["content-security-policy"]).toContain(
    "sandbox allow-scripts allow-popups",
  );
  expect(capability.headers["content-security-policy"]).not.toContain("allow-same-origin");
  const foreign = await app.inject({
    method: "POST",
    url: mutatePath,
    headers: {
      host: entry.host,
      cookie,
      origin: "https://other.invalid",
      "sec-fetch-site": "same-site",
    },
    payload: {},
  });
  expect(foreign.statusCode).toBe(403);
  await api.command(
    {
      type: "plugins.access.set",
      pluginId: fixture.plugin,
      access: "off",
      idempotencyKey: randomUUID(),
    },
    context,
  );
  expect((await app.inject({ url: "/", headers: { host: entry.host, cookie } })).statusCode).toBe(
    403,
  );
});

test("webhook setup preserves signatures and bytes, hides unknown targets, and wakes an idle engine", async (testContext) => {
  const fixture = await install("Webhook fixture");
  const detail = await vi.waitFor(
    async () => {
      const value = await api.detail(personal.userId, fixture.plugin);
      expect(value.webhooks[0]?.status, "Webhook setup never appeared").toBe("setup-required");
      return value;
    },
    { timeout: 10_000 },
  );
  const webhook = detail.webhooks[0]!;
  const setup = await api
    .reads()
    ["plugins.webhook.setup.get"]({ pluginId: fixture.plugin, webhookId: webhook.id }, context);
  expect(setup).toMatchObject({
    ok: true,
    data: { step: "configure", signingSecret: expect.any(String) },
  });
  if (!setup.ok || !setup.data.revision || !setup.data.signingSecret)
    throw new Error("Setup lost its signing secret");
  expect(setup.data.signingSecret).not.toBe("<redacted>");
  expect(new URL(setup.data.callbackUrl).pathname).toBe(
    `/hooks/v1/plugins/${fixture.plugin}/${webhook.id}`,
  );
  await api.command(
    {
      type: "plugins.webhook.setup.complete",
      pluginId: fixture.plugin,
      webhookId: webhook.id,
      revision: setup.data.revision,
      state: {},
      idempotencyKey: randomUUID(),
    },
    context,
  );
  const app = Fastify();
  registerPluginWebhookRoutes(app, {
    service,
    origin: () => service.webhookOrigin(),
    admit: async () => true,
  });
  await app.ready();
  testContext.onTestFinished(() => app.close());
  // Other fixture sources can be pending setup; none have near-due work.
  await vi.waitFor(
    async () => expect(await service.stopIfIdle(), "Engine did not become idle").toBe(true),
    { timeout: 10_000 },
  );
  expect(service.state().status).toBe("idle");
  const { createHmac } = await import("node:crypto");
  const body = '{ "event": "created",\n "value": 7 }\n';
  const signature = createHmac("sha256", setup.data.signingSecret).update(body).digest("hex");
  const callback = new URL(setup.data.callbackUrl).pathname;
  const response = await app.inject({
    method: "POST",
    url: callback,
    headers: { "content-type": "application/json", "x-signature": signature },
    payload: body,
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toEqual({ body, account: fixture.account });
  expect(service.state().status).toBe("ready");
  const occurrence = await sql<{
    name: string;
    account: string;
  }>`SELECT name, account FROM plugin_engine.plugin_engine_events WHERE app = ${fixture.plugin} AND name = 'received'`.execute(
    database,
  );
  expect(occurrence.rows).toEqual([{ name: "received", account: fixture.account }]);
  const invalid = await app.inject({
    method: "POST",
    url: callback,
    headers: { "content-type": "application/json", "x-signature": signature },
    payload: body.trim(),
  });
  expect(invalid.statusCode).toBe(401);
  const unknown = await app.inject({
    method: "POST",
    url: `/hooks/v1/plugins/app_${randomUUID()}/whk_${randomUUID()}`,
    payload: "{}",
  });
  const missing = await app.inject({
    method: "POST",
    url: `/hooks/v1/plugins/${fixture.plugin}/whk_${randomUUID()}`,
    payload: "{}",
  });
  expect([unknown.statusCode, unknown.body]).toEqual([missing.statusCode, missing.body]);
  expect(unknown.statusCode).toBe(404);
  expect(
    (
      await app.inject({
        method: "POST",
        url: callback,
        headers: { "content-type": "application/octet-stream" },
        payload: Buffer.alloc(1024 * 1024 + 1),
      })
    ).statusCode,
  ).toBe(413);
  await api.command(
    {
      type: "plugins.access.set",
      pluginId: fixture.plugin,
      access: "off",
      idempotencyKey: randomUUID(),
    },
    context,
  );
  expect(
    (
      await app.inject({
        method: "POST",
        url: callback,
        headers: { "x-signature": signature },
        payload: body,
      })
    ).statusCode,
  ).not.toBe(200);
  const afterOff = await sql<{
    total: string;
  }>`SELECT count(*) as total FROM plugin_engine.plugin_engine_events WHERE app = ${fixture.plugin}`.execute(
    database,
  );
  expect(Number(afterOff.rows[0]?.total)).toBe(1);
  await api.command(
    {
      type: "plugins.access.set",
      pluginId: fixture.plugin,
      access: "all",
      idempotencyKey: randomUUID(),
    },
    context,
  );
  await service.install({ kind: "files", plugin: fixture.plugin, files: files(2, true) }, owner);
  expect((await api.detail(personal.userId, fixture.plugin)).backgroundUnavailable).toContain(
    "Review",
  );
  expect(
    (
      await app.inject({
        method: "POST",
        url: callback,
        headers: { "x-signature": signature },
        payload: body,
      })
    ).statusCode,
  ).not.toBe(200);
  publicOrigin = undefined;
  expect((await api.detail(personal.userId, fixture.plugin)).webhookUnavailable).toContain(
    "cannot be received",
  );
  publicOrigin = "https://fixture.invalid";
});

test("active plugin skills are pinned by digest without waking the engine and fetched by the Runner", async (testContext) => {
  const fixture = await install("Skills fixture", 1, false);
  await vi.waitFor(async () => expect(await service.stopIfIdle()).toBe(true), { timeout: 10_000 });
  const generation = service.state().generation;
  const versions = (
    await service.skillCache.versions(await records.settings(personal.userId))
  ).filter((entry) => entry.pluginId === fixture.plugin);
  expect(versions).toHaveLength(1);
  const store = new OpensteerStore(database);
  const port = createPersonalRunFixturePort(store);
  const task = await port.createTask({ ownerId: personal.userId, suffix: randomUUID() });
  const started = await port.startTask(task.threadId, "Use the plugin skill");
  const scope = await store.runCapabilityScope(started.run.id);
  if (!scope) throw new Error("Run has no active grant");
  const tokens = new RunCapabilityTokenService({
    audience: "opensteer-plugin-packages",
    authorizer: store,
    tokens: new SignedTokenService(generateKeyPairSync("ed25519"), {
      deploymentId: personal.deploymentId,
      hostInstanceId: personal.hostInstanceId,
    }),
  });
  const token = tokens.issue({ ...scope, pluginDigests: versions.map((entry) => entry.digest) });
  const packages = new PluginPackageService({
    snapshotDirectory: join(directory, "plugins/data/packages"),
    tokens,
  });
  const app = Fastify();
  app.get<{ Params: { digest: string } }>("/packages/:digest", async (request) =>
    packages.snapshot(
      request.headers.authorization?.slice("Bearer ".length) ?? "",
      request.params.digest,
    ),
  );
  await app.listen({ host: "127.0.0.1", port: 0 });
  testContext.onTestFinished(() => app.close());
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("No package server");
  const plan = RunPluginsPlanSchema.parse({
    token,
    url: `http://127.0.0.1:${address.port}/packages`,
    versions,
  });
  const cached = await cacheRunPlugins({
    plan,
    stateDirectory: join(directory, "runner"),
    signal: new AbortController().signal,
    threadId: task.threadId,
  });
  testContext.onTestFinished(() => cached.cleanup());
  expect(cached.skills).toMatchObject([
    { fullName: "skills-fixture:demo", plugin: "skills-fixture", localName: "demo" },
  ]);
  expect(await readFile(join(cached.skills[0]!.path, "SKILL.md"), "utf8")).toContain(
    "Fixture instructions.",
  );
  expect(service.state()).toMatchObject({ status: "idle", generation });
  const indexPath = join(directory, "plugins", "active", fixture.plugin + ".json");
  const previous = await readFile(indexPath, "utf8");
  const source = await service.export({ plugin: fixture.plugin }, owner);
  await service.install(
    {
      kind: "files",
      plugin: fixture.plugin,
      files: source.map((file) =>
        file.path === "skills/demo/SKILL.md" && "content" in file
          ? { ...file, content: file.content.replace("Fixture instructions.", "New instructions.") }
          : file,
      ),
    },
    owner,
  );
  const active = await readFile(indexPath, "utf8");
  await writeFile(indexPath, previous);
  expect(
    (await service.skillCache.versions(await records.settings(personal.userId))).some(
      (entry) => entry.pluginId === fixture.plugin,
    ),
    "A stale cache must not supply an earlier version's skills",
  ).toBe(false);
  await writeFile(indexPath, active);
  expect(await service.skills({ app: "skills-fixture", name: "demo" }, owner)).toMatchObject({
    content: expect.stringContaining("New instructions."),
  });
  await api.command(
    {
      type: "plugins.access.set",
      pluginId: fixture.plugin,
      access: "off",
      idempotencyKey: randomUUID(),
    },
    context,
  );
  expect(
    (await service.skillCache.versions(await records.settings(personal.userId))).some(
      (entry) => entry.pluginId === fixture.plugin,
    ),
  ).toBe(false);
});

test.each(["off", "read-only"] as const)(
  "a saved schedule wakes a stopped engine and %s plugins cannot do background work",
  async (access) => {
    const fixture = await install("Wake fixture", 1, false);
    await api.command(
      {
        type: "plugins.schedule.configure",
        pluginId: fixture.plugin,
        schedule: "tick",
        enabled: true,
        idempotencyKey: randomUUID(),
      },
      context,
    );
    await sql`UPDATE plugin_engine.plugin_engine_schedules SET next_at = (now() AT TIME ZONE 'UTC') + interval '3 minutes' WHERE app = ${fixture.plugin} AND name = 'tick'`.execute(
      database,
    );
    await vi.waitFor(
      async () => {
        const demand = await engineDemand(url);
        expect(demand.busy, "Schedule still has a claimed run").toBe(false);
        expect(demand.dueInMs, "Unrelated webhook-source work has not settled").toBeGreaterThan(
          120_000,
        );
      },
      { timeout: 10_000 },
    );
    // Only the supervisor clock advances; the child and database still use real time.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      expect(await service.stopIfIdle()).toBe(true);
      expect(service.state().status).toBe("idle");
      await due(fixture.plugin, "tick");
      const started = once(states, "starting");
      await vi.advanceTimersByTimeAsync(180_000);
      vi.useRealTimers();
      await deadline(started, "Saved schedule never woke the supervisor");
    } finally {
      vi.useRealTimers();
    }
    await runs(fixture.plugin, "succeeded");
    await api.command(
      {
        type: "plugins.access.set",
        pluginId: fixture.plugin,
        access,
        idempotencyKey: randomUUID(),
      },
      context,
    );
    await due(fixture.plugin, "tick");
    await vi.waitFor(
      async () => {
        const result = await sql<{
          advanced: boolean;
        }>`SELECT next_at > (now() AT TIME ZONE 'UTC') AS advanced
        FROM plugin_engine.plugin_engine_schedules WHERE app = ${fixture.plugin} AND name = 'tick'`.execute(
          database,
        );
        expect(result.rows[0]?.advanced, "Scheduler did not skip the due occurrence").toBe(true);
      },
      { timeout: 10_000 },
    );
    const history = await api
      .reads()
      ["plugins.schedule.runs"]({ pluginId: fixture.plugin }, context);
    expect(history.ok && history.data.runs.map(({ status }) => status)).toEqual(["succeeded"]);
    expect((await api.detail(personal.userId, fixture.plugin)).backgroundUnavailable).toContain(
      access,
    );
    await expect(
      api.command(
        {
          type: "plugins.workflow.start",
          pluginId: fixture.plugin,
          workflow: "quick",
          input: {},
          idempotencyKey: randomUUID(),
        },
        context,
      ),
    ).rejects.toThrow();
    await api.command(
      {
        type: "plugins.access.set",
        pluginId: fixture.plugin,
        access: "all",
        idempotencyKey: randomUUID(),
      },
      context,
    );
    const ticks = await service.page(
      {
        plugin: fixture.plugin,
        request: {
          url: "http://page.invalid" + queryPath,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: Buffer.from(
            JSON.stringify({ version: fixture.version, name: "ticks", input: {} }),
          ).toString("base64"),
        },
      },
      owner,
    );
    const chunks = [];
    if (ticks.stream)
      for await (const chunk of service.readStream(ticks.stream)) chunks.push(Buffer.from(chunk));
    expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual([
      { account: fixture.account, source: "schedule" },
    ]);
    await api.command(
      {
        type: "plugins.schedule.configure",
        pluginId: fixture.plugin,
        schedule: "tick",
        enabled: false,
        idempotencyKey: randomUUID(),
      },
      context,
    );
  },
);

test("successful tools and workflow checkpoints redact linked credential values", async () => {
  const token = "synthetic-success-redaction-token";
  const source = files(1)
    .filter(({ path }) => path === "index.ts" || path === "package.json")
    .map((file) =>
      file.path !== "index.ts"
        ? file
        : {
            ...file,
            content: `
import { defineApp, defineProvider, secrets, object, string, query, router, workflow } from "apps";
const service = defineProvider({ name: "Redaction fixture", auth: { key: secrets({ label: "API key", fields: object({ token: string() }) }) } });
export default defineApp({ user: { accounts: { service } } }, {
  tools: router({ echo: query({ input: object({}) }, async ctx => ({ token: ctx.user.accounts.service.fields.token })) }),
  workflows: { echo: workflow({ input: object({}) }, async ctx => {
    let seen;
    const checkpoint = await ctx.step.do("echo", async step => {
      seen = step.user.accounts.service.fields.token;
      return { token: seen };
    });
    return { checkpointRedacted: checkpoint.token !== seen, final: seen };
  }) },
});`,
          },
    );
  const installed = await service.install(
    { kind: "files", name: "Redaction fixture", files: source },
    owner,
  );
  if (installed.status !== "installed") throw new Error("Redaction fixture did not install");
  const target = { plugin: installed.plugin.id, requirement: "service", scope: "user" as const };
  const account = await service.createApiKeyAccount(
    {
      provider: installed.plugin.requirements.accounts.service!.provider,
      method: "key",
      fields: { token },
    },
    owner,
  );
  await service.linkAccount(
    {
      ...target,
      account: account.id,
      consent: await service.reviewAccountLink(target, owner),
    },
    owner,
  );
  const called = await service.call(
    {
      calls: { path: `tools[${JSON.stringify(installed.plugin.slug)}].echo`, input: {} },
    },
    owner,
  );
  expect(called.result).toMatchObject({
    execution: { value: { ok: true, value: { token: "[redacted]" } } },
  });
  const completed = onBackground(
    () => api.reads()["plugins.workflow.runs"]({ pluginId: target.plugin }, context),
    (page) => page.ok && page.data.runs.some((run) => run.status === "complete"),
  );
  const started = await api.command(
    {
      type: "plugins.workflow.start",
      pluginId: target.plugin,
      workflow: "echo",
      input: {},
      idempotencyKey: randomUUID(),
    },
    context,
  );
  if (started.type !== "plugins.workflow.start") throw new Error("Unexpected workflow response");
  await completed;
  expect(
    await service.manage(
      {
        operation: "workflowRuns.get",
        input: { app: target.plugin, run: started.runId },
      },
      owner,
    ),
  ).toMatchObject({ output: { checkpointRedacted: true, final: "[redacted]" } });
});

test("workflow history pages once on creation order, shows long-lived runs first, and needs no current declarations", async () => {
  const fixture = await install("Workflow history", 1, false);
  const started = await api.command(
    {
      type: "plugins.workflow.start",
      pluginId: fixture.plugin,
      workflow: "hold",
      input: {},
      idempotencyKey: mutationIdempotencyKey("plugins.workflow.start"),
    },
    context,
  );
  if (started.type !== "plugins.workflow.start") throw new Error("No workflow");
  const historical = await api.command(
    {
      type: "plugins.workflow.start",
      pluginId: fixture.plugin,
      workflow: "quick",
      input: {},
      idempotencyKey: randomUUID(),
    },
    context,
  );
  if (historical.type !== "plugins.workflow.start") throw new Error("No history");
  await vi.waitFor(
    async () => {
      const row = await service.manage(
        { operation: "workflowRuns.get", input: { app: fixture.plugin, run: historical.runId } },
        owner,
      );
      expect(row).toMatchObject({ status: "complete" });
    },
    { timeout: 10000 },
  );
  for (let index = 0; index < 6; index++)
    await api.command(
      {
        type: "plugins.workflow.start",
        pluginId: fixture.plugin,
        workflow: "quick",
        input: {},
        idempotencyKey: randomUUID(),
      },
      context,
    );
  await vi.waitFor(
    async () => {
      const page = (
        await import("../apps/host/src/plugins/engine-feature-schemas.js")
      ).EngineWorkflowRunPageSchema.parse(
        await service.manage(
          { operation: "workflowRuns.list", input: { app: fixture.plugin } },
          owner,
        ),
      );
      expect(
        page.items.filter((run) => run.workflow === "quick" && run.status === "complete"),
      ).toHaveLength(7);
    },
    { timeout: 10000 },
  );
  await service.unlinkAccount(
    { plugin: fixture.plugin, requirement: "service", scope: "user", account: fixture.account },
    owner,
  );
  expect((await api.detail(personal.userId, fixture.plugin)).workflows).toBeNull();
  const { EngineWorkflowRunPageSchema } =
    await import("../apps/host/src/plugins/engine-feature-schemas.js");
  const walk = async (live: boolean, betweenPages?: () => Promise<void>) => {
    const runs: { id: string; createdAt: string }[][] = [];
    let cursor: string | undefined;
    do {
      const page = EngineWorkflowRunPageSchema.parse(
        await service.manage(
          {
            operation: "workflowRuns.list",
            input: { app: fixture.plugin, limit: "2", live, ...(cursor ? { cursor } : {}) },
          },
          owner,
        ),
      );
      runs.push(page.items);
      cursor = page.next;
      if (runs.length === 1) await betweenPages?.();
    } while (cursor);
    return runs;
  };
  // Clients see the long-lived run first, though it is the oldest; the walk still reaches all.
  const shown = await walk(true);
  expect(shown[0]![0]!.id).toBe(started.runId);
  expect(new Set(shown.flat().map((run) => run.id)).size).toBe(8);
  // Newest first on creation: a run that ends between pages is read once, where it was created.
  const walked = (
    await walk(false, async () => {
      await api.command(
        {
          type: "plugins.workflow.stop",
          pluginId: fixture.plugin,
          runId: started.runId,
          idempotencyKey: randomUUID(),
        },
        context,
      );
      await vi.waitFor(
        async () =>
          expect(
            await service.manage(
              { operation: "workflowRuns.get", input: { app: fixture.plugin, run: started.runId } },
              owner,
            ),
          ).toMatchObject({ status: "terminated" }),
        { timeout: 10000 },
      );
    })
  ).flat();
  expect(walked.map((run) => run.id)).toHaveLength(8);
  expect(new Set(walked.map((run) => run.id)).size).toBe(8);
  expect(walked.map((run) => Date.parse(run.createdAt))).toEqual(
    walked.map((run) => Date.parse(run.createdAt)).sort((a, b) => b - a),
  );
  expect(
    await service.manage(
      { operation: "workflowRuns.get", input: { app: fixture.plugin, run: started.runId } },
      owner,
    ),
  ).toMatchObject({ status: "terminated" });
});
