import { localNamespace } from "../apps/host/src/plugins/provider-names.js";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "vitest";
import { PluginService } from "../apps/host/src/plugins/plugin-service.js";
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
import { withTimeout } from "@opensteer/shared/withTimeout";
import {
  pluginFixtureFiles,
  pluginFixtureProcesses,
  pluginFixtureRegistry,
} from "../scripts/plugin-engine/fixture.ts";

const caller = { caller: "owner:task", mode: "ask" as const };
const deadline = <T>(promise: Promise<T>, message: string) =>
  withTimeout(promise, 15_000, { timeoutError: () => new Error(message) });

test("supervises plugins, consent, mixed codemode, approvals and lost executions through the Promise service", async (context) => {
  const clone = await cloneTestDatabase("host");
  const directory = await mkdtemp(join(tmpdir(), "opensteer-plugin-service-"));
  context.onTestFinished(() => rm(directory, { force: true, recursive: true }));
  const events = new EventEmitter();
  const registry = await pluginFixtureRegistry(directory, () => events.emit("waiting"));
  context.onTestFinished(() => registry.close());
  const origin = registry.origin;
  let refused = false;
  const interrupted: PluginExecution[] = [];
  const calls: { caller: string; execution: string }[] = [];
  const hostProvider: PluginHostProvider = {
    id: "app_host_fixture",
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
  expect(skillBundle.digest).toMatch(/^[a-f0-9]{64}$/u);
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

async function outputFixture(context: import("vitest").TestContext) {
  const clone = await cloneTestDatabase("host");
  const directory = await mkdtemp(join(tmpdir(), "opensteer-plugin-output-"));
  context.onTestFinished(() => rm(directory, { force: true, recursive: true }));
  const registry = await pluginFixtureRegistry(directory);
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
  return service;
}

test("consent discloses a raw secret that reaches plugin code", async (context) => {
  const service = await outputFixture(context);
  const target = { requirement: "service", scope: "user" as const };
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
                .replace("amount + 1", "_ctx.user.accounts.service.fields.token"),
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
      fields: { token: "synthetic-raw-key" },
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
  ).toMatchObject({ execution: { value: { value: "synthetic-raw-key" } } });
});

test("oversized execution results are refused before IPC and terminal state is pruned", async (context) => {
  const service = await outputFixture(context);
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
