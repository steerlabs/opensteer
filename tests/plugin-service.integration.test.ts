import { localNamespace } from "../apps/host/src/plugins/provider-names.js";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "vitest";
import { sql } from "kysely";
import {
  PluginService,
  type PluginServiceOptions,
} from "../apps/host/src/plugins/plugin-service.js";
import {
  PluginServiceError,
  type PluginExecution,
  type PluginHostProvider,
  type PluginOperation,
  type PluginInput,
} from "../apps/host/src/plugins/engine-protocol.js";
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
} from "../packages/database/src/test-database.test-support.js";
import { createDatabase } from "../packages/database/src/connection.js";
import { PluginAgentStore } from "../packages/database/src/index.js";
import { seedPersonalFixture } from "../packages/database/src/personal-fixture.test-support.js";
import { withTimeout } from "@opensteer/shared/withTimeout";
import {
  pluginFixtureFiles,
  pluginFixtureProcesses,
  pluginFixtureRegistry,
} from "../scripts/plugin-engine/fixture.ts";

const caller = { caller: "owner:task", mode: "ask" as const };
const deadline = <T>(promise: Promise<T>, message: string) =>
  withTimeout(promise, 15_000, { timeoutError: () => new Error(message) });

const hostProvider: PluginHostProvider = {
  id: "app_server_fixture",
  name: "Local fixture",
  slug: "local",
  version: "dpl_host_fixture",
  tools: [
    {
      name: "double",
      description: "Double a number",
      readOnly: true,
      inputSchema: {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
      },
    },
  ],
};
const localPath = `tools[${JSON.stringify(localNamespace(hostProvider.slug, hostProvider.id))}].double`;

test("supervises plugins, consent, mixed codemode, approvals and lost executions through the Promise service", async (context) => {
  const clone = await cloneTestDatabase("host");
  const directory = await mkdtemp(join(tmpdir(), "opensteer-plugin-service-"));
  context.onTestFinished(() => rm(directory, { force: true, recursive: true }));
  const events = new EventEmitter();
  const registry = await pluginFixtureRegistry(() => events.emit("waiting"));
  context.onTestFinished(() => registry.close());
  const origin = registry.origin;
  let refused = false;
  const interrupted: PluginExecution[] = [];
  const calls: { caller: string; execution: string }[] = [];
  const service = new PluginService({
    onDiagnostic: (phase) => console.log("Engine phase", phase),
    processEntry: new URL("../apps/host/dist/plugin-engine.js", import.meta.url),
    bridge: new URL("../apps/host/dist/plugin-engine-bridge.json", import.meta.url).pathname,
    databaseUrl: clone.url,
    dataDirectory: directory,
    owner: "owner",
    credentialKey: new Uint8Array(32).fill(1),
    origin: "https://fixture.invalid",
    npmRegistry: origin,
    catalogUrl: origin + "/catalog",
    selfOrigin: { origin: "https://api.fixture.invalid", address: registry.address },
    authorize: async () => ({ allowed: !refused }),
    providers: async () => [hostProvider],
    providerCall: async (input) => {
      calls.push(input);
      if (
        input.input === null ||
        typeof input.input !== "object" ||
        Array.isArray(input.input) ||
        typeof input.input.value !== "number"
      )
        throw new Error("Invalid fixture value");
      return { kind: "value", value: input.input.value * 2 };
    },
    onExecution: (execution) => {
      events.emit("execution", execution);
      if (execution.state === "interrupted") interrupted.push(execution);
    },
    onState: (state) => events.emit(state.status, state),
  });
  await ownTestDatabaseProducer(clone.url, async () => ({ close: () => service.close() }));
  context.onTestFinished(() => service.close());
  await deadline(service.start(), "Engine did not initialize");
  const health = await service.health({}, caller);
  const initial = pluginFixtureProcesses(health.pid);
  console.log("Plugin service measurements", {
    startupMs: health.startupMs,
    childIdleKiB: health.rss / 1024,
    workerdIdle: initial.filter((row) => row.command.endsWith("workerd")),
  });
  const installed = await service.install(
    { kind: "files", name: "Fixture", files: pluginFixtureFiles(1) },
    caller,
  );
  expect(installed.status).toBe("installed");
  if (
    installed.status !== "installed" ||
    typeof installed.plugin.id !== "string" ||
    typeof installed.version.id !== "string"
  )
    throw new Error("Fixture did not install");
  const plugin = installed.plugin.id;
  const v1 = installed.version.id;
  const direct = await service.call(
    { calls: { path: "tools.fixture.read", input: { amount: 2 } } },
    caller,
  );
  expect(direct.result, JSON.stringify(direct.result)).toMatchObject({
    status: "completed",
    execution: { value: { ok: true, value: 3 } },
  });
  expect(await service.search({ query: "double" }, caller)).toMatchObject({
    items: [{ path: localPath }],
  });
  expect(await service.describe({ paths: [localPath] }, caller)).toMatchObject({
    items: [{ path: localPath }],
  });
  const mixed = await service.execute(
    {
      code: `return await ${localPath}({ value: await tools.fixture.read({ amount: 4 }) });`,
    },
    caller,
  );
  expect(mixed.result).toMatchObject({ status: "completed", execution: { ok: true, value: 10 } });
  expect(calls).toEqual([
    expect.objectContaining({ caller: caller.caller, execution: expect.any(String) }),
  ]);
  const skillBundle = await service.skillFiles({ plugin }, caller);
  expect(skillBundle).toMatchObject({ plugin, slug: "fixture", version: v1, hasPage: false });
  expect(skillBundle.files).toEqual(
    expect.arrayContaining([expect.objectContaining({ path: "demo/SKILL.md" })]),
  );
  expect(await service.skills({ app: "fixture", name: "demo" }, caller)).toMatchObject({
    content: expect.stringContaining("Fixture instructions."),
  });
  const paused = await service.execute(
    { code: "return await tools.fixture.reviewed({ amount: 7 });" },
    caller,
  );
  expect(paused.state).toBe("waiting");
  await service.answer({ execution: paused.id, response: { action: "accept" } }, caller);
  expect((await service.resume({ execution: paused.id }, caller)).result).toMatchObject({
    status: "completed",
    execution: { value: 8 },
  });
  refused = true;
  const refusedOperations: [PluginOperation, PluginInput<PluginOperation>][] = [
    ["search", {}],
    ["describe", { paths: ["tools.fixture.read"] }],
    ["call", { calls: { path: "tools.fixture.read", input: { amount: 0 } } }],
    ["execute", { code: "return 1;" }],
    ["resume", { execution: paused.id }],
    ["answer", { execution: paused.id, response: { action: "accept" } }],
    ["skills", {}],
    ["cancel", { execution: paused.id }],
  ];
  for (const [operation, input] of refusedOperations)
    await expect(service.request(operation, input, caller)).rejects.toMatchObject({
      code: "forbidden",
    });
  refused = false;
  const v2 = await service.install({ kind: "files", plugin, files: pluginFixtureFiles(2) }, caller);
  expect(v2.status).toBe("installed");
  await service.activate({ plugin, version: v1 }, caller);
  expect(
    (await service.call({ calls: { path: "tools.fixture.read", input: { amount: 2 } } }, caller))
      .result,
  ).toMatchObject({ execution: { value: { value: 3 } } });
  const secured = await service.install(
    { kind: "files", name: "Secured", files: pluginFixtureFiles(1, ["api.fixture.invalid"]) },
    caller,
  );
  if (secured.status !== "installed" || typeof secured.plugin.id !== "string")
    throw new Error("Secured fixture did not install: " + JSON.stringify(secured));
  const detail = await service.detail({ plugin: secured.plugin.id }, caller);
  const requirements = detail.plugin.requirements;
  if (!requirements || typeof requirements !== "object" || Array.isArray(requirements))
    throw new Error("Missing requirements");
  const parsed = JSON.parse(JSON.stringify(requirements)) as {
    accounts: { service: { provider: string } };
  };
  const account = await service.createApiKeyAccount(
    {
      provider: parsed.accounts.service.provider,
      method: "key",
      fields: { token: "synthetic-test-only" },
    },
    caller,
  );
  if (typeof account.id !== "string") throw new Error("Missing account id");
  const target = { plugin: secured.plugin.id, requirement: "service", scope: "user" as const };
  const consent = await service.reviewAccountLink(target, caller);
  expect(consent.credential).toBe("sealed");
  await service.linkAccount({ ...target, account: account.id, consent }, caller);
  expect(
    (await service.call({ calls: { path: "tools.secured.read", input: { amount: 0 } } }, caller))
      .result,
  ).toMatchObject({ execution: { value: { value: 1 } } });
  await service.install(
    {
      kind: "files",
      plugin: secured.plugin.id,
      files: pluginFixtureFiles(2, ["api.fixture.invalid", "other.fixture.invalid"]),
    },
    caller,
  );
  await expect(
    service.linkAccount({ ...target, account: account.id, consent }, caller),
  ).rejects.toMatchObject({ code: "consent-changed" });
  const blocked = await service.call(
    { calls: { path: "tools.secured.read", input: { amount: 0 } } },
    caller,
  );
  expect(blocked.result, JSON.stringify(blocked.result)).toMatchObject({
    status: "completed",
    execution: { ok: true, value: { ok: false, error: { kind: "ToolFailure" } } },
  });
  await service.linkAccount(
    { ...target, account: account.id, consent: await service.reviewAccountLink(target, caller) },
    caller,
  );
  const retained = await service.execute(
    { code: "return await tools.secured.reviewed({ amount: 0 });" },
    caller,
  );
  expect(retained.state).toBe("waiting");
  await service.activate({ plugin: secured.plugin.id, version: secured.version.id }, caller);
  await service.linkAccount(
    { ...target, account: account.id, consent: await service.reviewAccountLink(target, caller) },
    caller,
  );
  await service.answer({ execution: retained.id, response: { action: "accept" } }, caller);
  const retainedResult = await service.resume({ execution: retained.id }, caller);
  expect(retainedResult.result, JSON.stringify(retainedResult.result)).toMatchObject({
    status: "completed",
    execution: { ok: false },
  });
  console.log("Plugin service one plugin RSS", pluginFixtureProcesses(health.pid));
  const waiting = once(events, "waiting");
  const pending = service.execute({ code: "return await tools.fixture.wait({});" }, caller);
  const failure = expect(pending).rejects.toBeInstanceOf(PluginServiceError);
  await deadline(waiting, "Plugin call never reached fixture server");
  const old = pluginFixtureProcesses(health.pid);
  const restarted = once(events, "ready");
  process.kill(health.pid, "SIGKILL");
  await failure;
  await deadline(restarted, "Engine did not restart");
  expect(interrupted.some((execution) => execution.state === "interrupted")).toBe(true);
  for (const row of old) expect(() => process.kill(row.pid, 0)).toThrow();
  const final = pluginFixtureProcesses(service.state().pid!);
  await service.close();
  for (const row of final) expect(() => process.kill(row.pid, 0)).toThrow();
});

async function outputFixture(
  context: import("vitest").TestContext,
  options: Pick<PluginServiceOptions, "providers" | "authorize"> = {},
  handle?: Parameters<typeof pluginFixtureRegistry>[2],
) {
  const clone = await cloneTestDatabase("host");
  const directory = await mkdtemp(join(tmpdir(), "opensteer-plugin-output-"));
  context.onTestFinished(() => rm(directory, { force: true, recursive: true }));
  const registry = await pluginFixtureRegistry(undefined, undefined, handle);
  context.onTestFinished(() => registry.close());
  const service = new PluginService({
    ...options,
    databaseUrl: clone.url,
    dataDirectory: directory,
    owner: "owner",
    credentialKey: new Uint8Array(32).fill(1),
    origin: "https://fixture.invalid",
    npmRegistry: registry.origin,
    catalogUrl: registry.origin + "/catalog",
    selfOrigin: { origin: "https://api.fixture.invalid", address: registry.address },
    processEntry: new URL("../apps/host/dist/plugin-engine.js", import.meta.url),
    bridge: new URL("../apps/host/dist/plugin-engine-bridge.json", import.meta.url).pathname,
  });
  await ownTestDatabaseProducer(clone.url, async () => ({ close: () => service.close() }));
  context.onTestFinished(() => service.close());
  return { service, databaseUrl: clone.url };
}

test("a version change of one plugin holds that plugin alone, and only while it commits", async (context) => {
  // A call of the first plugin that runs until the test releases it.
  const reached = Promise.withResolvers<void>();
  let release = () => {};
  const { service } = await outputFixture(context, {}, (request, response) => {
    if (request.url !== "/wait") return false;
    release = () => response.end("released");
    reached.resolve();
    return true;
  });
  const installed = await Promise.all(
    ["First", "Second"].map((name) =>
      service.install({ kind: "files", name, files: pluginFixtureFiles(1) }, caller),
    ),
  );
  const [a, b] = installed.map((result) => {
    if (result.status !== "installed") throw new Error("Fixture did not install");
    return { plugin: result.plugin.id, version: result.version.id, slug: result.plugin.slug };
  });
  const calling = service.call({ calls: { path: `tools.${a!.slug}.wait`, input: {} } }, caller);
  await deadline(reached.promise, "The call never reached the fixture");
  // Four installs into the first plugin build at once; a commit waits for the call that runs on
  // the version it replaces.
  const installs = [2, 3, 4, 5].map((revision) =>
    service
      .install({ kind: "files", plugin: a!.plugin, files: pluginFixtureFiles(revision) }, caller)
      .then(
        (result) => ({ ok: true as const, result }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
  );
  // The other plugin's changes go on meanwhile, and the first plugin is still the version the
  // call runs on.
  await deadline(
    service.activate({ plugin: b!.plugin, version: b!.version }, caller),
    "Another plugin's activation waited",
  );
  await deadline(service.remove({ plugin: b!.plugin }, caller), "Another plugin's removal waited");
  expect((await service.installed({ plugins: [a!.plugin] }, caller))[0]).toMatchObject({
    plugin: { activeVersion: a!.version },
  });
  release();
  expect((await deadline(calling, "The call never finished")).result).toMatchObject({
    execution: { value: { ok: true, value: "released" } },
  });
  // One install commits; the others expected the version it replaced and change nothing.
  const results = await deadline(Promise.all(installs), "The installs never finished");
  const committed = results.flatMap((outcome) =>
    outcome.ok && outcome.result.status === "installed" ? [outcome.result.version.id] : [],
  );
  expect(committed).toHaveLength(1);
  for (const outcome of results.filter((outcome) => !outcome.ok))
    expect(outcome).toMatchObject({ error: { tag: "AppVersionChanged" } });
  expect((await service.installed({ plugins: [a!.plugin] }, caller))[0]).toMatchObject({
    plugin: { activeVersion: committed[0] },
  });
});

test("reads installed metadata without decoding unrequested plugins", async (context) => {
  const { service, databaseUrl } = await outputFixture(context);
  const installed = await service.install(
    { kind: "files", name: "Requested", files: pluginFixtureFiles(1) },
    caller,
  );
  if (installed.status !== "installed") throw new Error("Fixture did not install");
  const id = installed.plugin.id;
  const database = createDatabase({ connectionString: databaseUrl });
  try {
    // A row whose slug fails SDK decoding detects queries that read outside the requested IDs.
    await sql`insert into plugin_engine.plugin_engine_apps (id, code, owner, name, slug, created_at)
      select 'app_unrequested', code, owner, 'Unrequested', 'INVALID', created_at
      from plugin_engine.plugin_engine_apps where id = ${id}`.execute(database);
    await expect(service.installed({ plugins: [id, "unknown"] }, caller)).resolves.toMatchObject([
      { plugin: { id } },
    ]);
    await expect(service.installed({ plugins: ["unknown"] }, caller)).resolves.toEqual([]);
  } finally {
    await database.destroy();
  }
});

test("search and describe project local blockers from one inventory per answer", async (context) => {
  const blocked = {
    code: "read_only_task",
    message: "This task runs read-only.",
    next: "Use read operations.",
  };
  let reads = 0;
  const { service } = await outputFixture(context, {
    providers: async () => {
      reads++;
      return [{ ...hostProvider, toolBlockers: { double: blocked } }];
    },
  });

  await expect(service.search({ query: "double" }, caller)).resolves.toMatchObject({
    items: [{ path: localPath, blocked }],
  });
  expect(reads).toBe(1);
  await expect(service.describe({ paths: [localPath] }, caller)).resolves.toMatchObject({
    items: [{ path: localPath, blocked }],
  });
  expect(reads).toBe(2);
});

test("consent discloses a raw secret that reaches plugin code", async (context) => {
  const { service } = await outputFixture(context);
  const target = { requirement: "service", scope: "user" as const };
  const syntheticKey = "synthetic-raw-key";
  const exposed = await service.install(
    {
      kind: "files",
      name: "Exposed",
      files: pluginFixtureFiles(1, ["api.fixture.invalid"]).map((file) =>
        file.path === "index.ts"
          ? {
              ...file,
              content: file.content
                .replace("string, query", "string, raw, query")
                .replace("token: string()", "token: raw(string())")
                .replace(
                  "amount + 1",
                  `{
                    const token = _ctx.user.accounts.service.fields.token;
                    return { receivedRawValue: token === ${JSON.stringify(syntheticKey)}, token };
                  }`,
                ),
            }
          : file,
      ),
    },
    caller,
  );
  if (exposed.status !== "installed") throw new Error("Raw fixture did not install");
  const exposedTarget = { ...target, plugin: exposed.plugin.id };
  const exposedConsent = await service.reviewAccountLink(exposedTarget, caller);
  expect(exposedConsent.credential).toBe("value");
  expect((await service.prepareOAuth(exposedTarget, caller)).consent).toEqual(exposedConsent);
  const exposedAccount = await service.createApiKeyAccount(
    {
      provider: exposed.plugin.requirements.accounts.service!.provider,
      method: "key",
      fields: { token: syntheticKey },
    },
    caller,
  );
  await service.linkAccount(
    { ...exposedTarget, account: exposedAccount.id, consent: exposedConsent },
    caller,
  );
  expect(
    (await service.call({ calls: { path: "tools.exposed.read", input: { amount: 0 } } }, caller))
      .result,
  ).toMatchObject({
    execution: { value: { ok: true, value: { receivedRawValue: true, token: syntheticKey } } },
  });
});

test("oversized execution results are refused before IPC and terminal state is pruned", async (context) => {
  const { service } = await outputFixture(context);
  for (const code of ['return "字".repeat(30000);', 'console.log("字".repeat(30000)); return 1;']) {
    const oversized = await service.execute({ code }, caller);
    expect(oversized).toMatchObject({
      state: "failed",
      reason: expect.stringMatching(/result too large/iu),
    });
    expect(JSON.stringify(oversized).length).toBeLessThan(2000);
  }
  expect(service.listExecutions()).toEqual([]);
  expect(await service.request("executions", {}, caller)).toEqual([]);
});

test("a skill refresh that failed fails no install and is repaired by the next, and a replay changes no author", async (context) => {
  const clone = await cloneTestDatabase("host");
  const directory = await mkdtemp(join(tmpdir(), "opensteer-plugin-publication-"));
  context.onTestFinished(() => rm(directory, { force: true, recursive: true }));
  const database = createDatabase({ connectionString: clone.url });
  context.onTestFinished(() => database.destroy());
  const personal = await seedPersonalFixture(database, directory);
  const settings = new PluginAgentStore(database);
  const registry = await pluginFixtureRegistry(undefined, pluginFixtureFiles(1));
  context.onTestFinished(() => registry.close());
  const service = new PluginService({
    databaseUrl: clone.url,
    dataDirectory: directory,
    owner: "owner",
    credentialKey: new Uint8Array(32).fill(1),
    origin: "https://fixture.invalid",
    npmRegistry: registry.origin,
    catalogUrl: registry.origin + "/catalog",
    processEntry: new URL("../apps/host/dist/plugin-engine.js", import.meta.url),
    bridge: new URL("../apps/host/dist/plugin-engine-bridge.json", import.meta.url).pathname,
  });
  await ownTestDatabaseProducer(clone.url, async () => ({ close: () => service.close() }));
  context.onTestFinished(() => service.close());
  const authors = (plugin: string, versions: string[]) =>
    settings
      .versionAuthors(
        personal.userId,
        versions.map((version) => ({ pluginId: plugin, version })),
      )
      .then((found) => versions.map((version) => found.get(`${plugin}\u0000${version}`)));
  // Reviewed catalog source, then an agent's update of it.
  const catalog = { kind: "catalog" as const, id: "fixture", key: "catalog-install" };
  const first = await service.install(catalog, caller);
  if (first.status !== "installed") throw new Error(JSON.stringify(first));
  const plugin = first.plugin.id;
  expect(await service.skillCache.get(plugin)).toMatchObject({ version: first.version.id });
  // The skill record cannot be written while the update promotes.
  const active = join(directory, "plugins", "active");
  await rm(active, { recursive: true, force: true });
  await writeFile(active, "not a folder");
  const update = await service.install(
    { kind: "files", plugin, files: pluginFixtureFiles(2), key: "agent-update" },
    caller,
  );
  if (update.status !== "installed") throw new Error(JSON.stringify(update));
  expect((await service.installed({ plugins: [plugin] }, caller))[0]).toMatchObject({
    plugin: { activeVersion: update.version.id },
  });
  // The author was recorded with each promotion.
  expect(await authors(plugin, [first.version.id, update.version.id])).toEqual([
    "catalog",
    "agent",
  ]);
  expect(
    (await settings.settings(personal.userId)).find((row) => row.pluginId === plugin),
  ).toMatchObject({
    author: "agent",
  });
  // The catalog install replayed from its receipt repairs the skill record, which follows the
  // active version, and changes no author.
  await rm(active, { force: true });
  expect(await service.install(catalog, caller)).toMatchObject({
    status: "installed",
    version: { id: first.version.id },
  });
  expect(await service.skillCache.get(plugin)).toMatchObject({ version: update.version.id });
  expect(
    (await settings.settings(personal.userId)).find((row) => row.pluginId === plugin),
  ).toMatchObject({
    author: "agent",
  });
  expect(await authors(plugin, [first.version.id, update.version.id])).toEqual([
    "catalog",
    "agent",
  ]);
});
