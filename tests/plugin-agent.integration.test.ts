import { beforeAll, afterAll, afterEach, test, expect, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, rename, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { z } from "zod";
import {
  createId,
  RequestIdSchema,
  TeamMessageIdSchema,
  type ThreadAccessMode,
  type RequestId,
} from "../packages/core/src/index.js";
import {
  createDatabase,
  OpensteerStore,
  PluginAgentStore,
  TriggerStore,
  AgentConnectionStore,
} from "../packages/database/src/index.js";
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
} from "../packages/database/src/test-database.test-support.js";
import { seedPersonalFixture } from "../packages/database/src/personal-fixture.test-support.js";
import { recordPluginAuthor } from "../packages/database/src/plugin-agent-store.test-support.js";
import {
  createPersonalRunFixturePort,
  startPersonalQueuedRunFixture,
} from "../packages/database/src/personal-run-fixture.test-support.js";
import { AgentHomeFiles } from "../apps/host/src/threads/agent-home-files.js";
import { withFolderPluginPackage } from "../apps/host/src/local-servers/folder-plugin-package.js";
import { PluginOwnerApi } from "../apps/host/src/plugins/plugin-owner-api.js";
import { PluginService } from "../apps/host/src/plugins/plugin-service.js";
import { PluginAuthority } from "../apps/host/src/plugins/plugin-authority.js";
import { PluginExecutions } from "../apps/host/src/plugins/plugin-executions.js";
import { PluginToolHandlers } from "../apps/host/src/mcp/handlers/plugins.js";
import { OpensteerMcpService } from "../apps/host/src/mcp/opensteer-mcp-service.js";
import { pluginSourceFiles, exportPluginSource } from "../apps/host/src/plugins/plugin-source.js";
import type { AgentCaller, RunCaller } from "../apps/host/src/mcp/agent-caller.js";
import { pluginFixtureFiles, pluginFixtureRegistry } from "../scripts/plugin-engine/fixture.js";
import { continuationMessage } from "../apps/host/src/agents/continuation-service.js";
import { pendingEvent } from "../packages/database/src/store.integration.test-support.js";
import { ContinuationService } from "../apps/host/src/agents/continuation-service.js";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { NativeFsHelper } from "@opensteer/shared/files/native-fs-helper";

const deadline = <T>(promise: Promise<T>, message: string) =>
  withTimeout(promise, 15000, { timeoutError: () => new Error(message) });
const ownerContext = { caller: "personal", mode: "automatic" as const };
let directory: string;
let database: ReturnType<typeof createDatabase>;
let store: OpensteerStore;
let records: PluginAgentStore;
let authority: PluginAuthority;
let service: PluginService;
let executions: PluginExecutions;
let handlers: PluginToolHandlers;
let mcp: OpensteerMcpService;
let registry: Awaited<ReturnType<typeof pluginFixtureRegistry>>;
let personal: Awaited<ReturnType<typeof seedPersonalFixture>>;
let plugin: string;
let homeFiles: AgentHomeFiles;
const events = new EventEmitter();
const errors: unknown[] = [];
const enginePhases: string[] = [];
let effects = 0;
let exportWait: (() => Promise<void>) | undefined;
let current: AgentCaller;
let authorizationWait:
  | ((
      input: import("../apps/host/src/plugins/engine-protocol.js").PluginAuthorization,
    ) => Promise<void>)
  | undefined;
const activeCallers: RunCaller[] = [];

async function run(mode: ThreadAccessMode = "approval-required"): Promise<RunCaller> {
  const port = createPersonalRunFixturePort(store);
  const task = await port.createTask({ ownerId: personal.userId, suffix: randomUUID() });
  await database
    .updateTable("threads")
    .set({ accessMode: mode })
    .where("id", "=", task.threadId)
    .execute();
  const started = await port.startTask(task.threadId, "Use plugins");
  const claims = await store.runCapabilityScope(started.run.id);
  if (!claims) throw new Error("Run fixture has no scope");
  const thread = await store.getThreadForOwner(task.threadId, personal.userId);
  if (!thread) throw new Error("Run fixture has no task");
  const caller: RunCaller = {
    kind: "run",
    key: `run:${started.run.id}`,
    userId: personal.userId,
    accessMode: mode,
    thread,
    claims: {
      ...claims,
      aud: "opensteer-run-tools",
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      iss: "opensteer-host",
      jti: randomUUID(),
    },
  };
  activeCallers.push(caller);
  return caller;
}
const record = z.record(z.string(), z.unknown());
async function call(
  caller: AgentCaller,
  name: string,
  input: unknown,
  held = false,
  operationKey = randomUUID(),
) {
  current = caller;
  const result = held
    ? await mcp.callToolResult("token", name, input, {
        operationKey,
        caller,
        longRequestHold: false,
      })
    : await mcp.callTool("token", name, input, { operationKey, caller });
  return record.parse(held ? record.parse(result).structuredContent : result);
}
async function pendingRequest(caller: RunCaller) {
  return vi.waitFor(
    async () => {
      const row = await database
        .selectFrom("requests")
        .select("id")
        .where("originatingRunId", "=", caller.claims.runId)
        .where("status", "=", "pending")
        .executeTakeFirst();
      expect(row, "Plugin did not open its Request").toBeDefined();
      return (await store.requests.get(row!.id))!;
    },
    { timeout: 12000 },
  );
}
async function answer(
  id: RequestId,
  accept = true,
  content?: Record<string, z.infer<ReturnType<typeof z.json>>>,
) {
  const request = await store.requests.get(id);
  return executions.respond({
    requestId: id,
    resolvedBy: personal.userId,
    response:
      request?.kind === "plugin.approval"
        ? { kind: "choice", optionId: accept ? "accept" : "decline" }
        : {
            kind: "external",
            value: { action: accept ? "accept" : "decline", ...(content ? { content } : {}) },
          },
  });
}
beforeAll(async () => {
  const clone = await cloneTestDatabase("host");
  database = createDatabase({ connectionString: clone.url });
  directory = await mkdtemp(join(tmpdir(), "opensteer-plugin-agent-"));
  personal = await seedPersonalFixture(database, directory);
  store = new OpensteerStore(database);
  records = new PluginAgentStore(database);
  authority = new PluginAuthority({
    store,
    settings: records,
    owner: async () => personal.userId,
    // Like the Host, wait for the execution report before checking its authority.
    beforeAuthorize: () => executions.settled(),
  });
  registry = await pluginFixtureRegistry(undefined, pluginFixtureFiles(1), (request, response) => {
    if (request.url !== "/effect") return false;
    effects++;
    response.end("ok");
    return true;
  });
  homeFiles = new AgentHomeFiles({
    agentHome: async () => personal.agentHome,
    helperPath: new URL("../apps/runner/native-fs-helper/opensteer-native-fs-test", import.meta.url)
      .pathname,
  });
  service = new PluginService({
    limits: { interactionTtlMs: 5000 },
    databaseUrl: clone.url,
    dataDirectory: directory,
    owner: "personal",
    credentialKey: new Uint8Array(32).fill(2),
    origin: "https://fixture.invalid",
    npmRegistry: registry.origin,
    catalogUrl: registry.origin + "/catalog",
    selfOrigin: { origin: "https://api.fixture.invalid", address: registry.address },
    processEntry: new URL("../apps/host/dist/plugin-engine.js", import.meta.url),
    bridge: new URL("../apps/host/dist/plugin-engine-bridge.json", import.meta.url).pathname,
    authorize: async (input, signal) => {
      const result = await authority.authorize(input, signal);
      await authorizationWait?.(input);
      return result;
    },
    onExecution: (e) => executions?.report(e),
    onDiagnostic: (phase) => enginePhases.push(phase),
    onState: (s) => events.emit(s.status),
  });
  await ownTestDatabaseProducer(clone.url, async () => ({ close: () => service.close() }));
  const publish = (event: import("../packages/core/src/index.js").AgentEvent) => {
    events.emit(event.type, event);
    executions.observe(event);
  };
  executions = new PluginExecutions({
    service,
    store,
    records,
    authority,
    publish,
    notify: () => {},
    onError: (e) => errors.push(e),
    onStopped: (s) => {
      for (const e of s.events) publish(e);
    },
  });
  await executions.recover();
  await deadline(service.start(), "Plugin engine did not start").catch((cause: unknown) => {
    throw new Error(
      `Plugin engine did not start: ${JSON.stringify({ state: service.state(), phases: enginePhases })}`,
      { cause },
    );
  });
  const files = pluginFixtureFiles(1).map((file) =>
    file.path === "index.ts"
      ? {
          ...file,
          content: file.content
            .replace("number }", "number, userInterval, workflow }")
            .replace(
              "async (_ctx, { amount }) => amount + 1),\n  wait:",
              'async (ctx, { amount }) => { await ctx.fetch("https://api.fixture.invalid/effect"); return amount + 1; }),\n  wait:',
            )
            .replace(
              "export default defineApp",
              'const periodic = mutation({ input: object({}) }, async () => "ran"); export default defineApp',
            )
            .replace("tools: router({", "tools: router({ periodic,")
            .replace(
              "}) });",
              ' }), schedules: { periodic: userInterval({minutes:1}, periodic, {}) }, workflows: { quick: workflow({input:object({})}, async () => "done") } });',
            )
            .replace(
              "  wait: query",
              `  input: query({ input: object({ label: string() }) }, async (ctx, { label }) => ({ label, response: await ctx.elicit({ mode: "form", message: "Name it", requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }) })),\n  wait: query`,
            ),
        }
      : file,
  );
  const installed = await service.install({ kind: "files", name: "Fixture", files }, ownerContext);
  if (installed.status !== "installed")
    throw new Error("Fixture did not install: " + JSON.stringify(installed));
  plugin = installed.plugin.id;
  await recordPluginAuthor(database, personal.userId, plugin, installed.version.id, "agent");
  handlers = new PluginToolHandlers({
    service,
    authority,
    executions,
    store,
    settings: records,
    publish,
    notify: () => {},
    folder: async (_c, d) =>
      withFolderPluginPackage({ directory: d, files: homeFiles, install: pluginSourceFiles }),
    exportFiles: async (_c, d, f, authorize, signal) => {
      await exportWait?.();
      return exportPluginSource(
        directory,
        d,
        f.files,
        new URL("../apps/runner/native-fs-helper/opensteer-native-fs-test", import.meta.url)
          .pathname,
        authorize,
        signal,
      );
    },
  });
  mcp = new OpensteerMcpService({
    callers: { authenticate: async () => current },
    store,
    publicUrl: new URL("http://127.0.0.1"),
    handlers: handlers.handlers(),
    pluginExecutions: executions,
  });
}, 60000);
afterEach(async () => {
  await records.setAccess(personal.userId, plugin, "all");
  expect(errors).toEqual([]);
});
afterAll(async () => {
  homeFiles?.close();
  await mcp?.close();
  await executions?.close();
  await service?.close();
  await registry?.close();
  await database?.destroy();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function program(
  kind: "trigger" | "watch",
  mode: ThreadAccessMode = "approval-required",
): Promise<AgentCaller> {
  const owner = await run(mode);
  const triggers = new TriggerStore(database);
  const created = await triggers.create({
    actorThreadId: null,
    anchorThreadId: owner.thread.id,
    createdBy: personal.userId,
    idempotencyKey: randomUUID(),
    name: kind,
    source:
      kind === "watch"
        ? { kind: "watch" }
        : {
            kind: "schedule",
            schedule: { kind: "cron", expression: "0 0 * * *", timezone: "UTC" },
          },
    program: {
      language: "javascript",
      source:
        kind === "watch"
          ? "export default async()=>new Promise(()=>{})"
          : "export default ()=>null",
      toolContractVersion: 5,
    },
  });
  const common = {
    kind: "program" as const,
    userId: personal.userId,
    accessMode: owner.accessMode,
    anchor: owner.thread,
  };
  const token = {
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    iss: "opensteer-host" as const,
    jti: randomUUID(),
  };
  if (kind === "trigger") {
    const occurrence = await triggers.enqueueManual({
      actorThreadId: null,
      ownerId: personal.userId,
      triggerId: created.trigger.id,
      idempotencyKey: randomUUID(),
    });
    await store.claimCommand(occurrence.commandId, "plugin-test");
    const started = await triggers.startExecution({
      commandId: occurrence.commandId,
      runnerBootId: "fixture-boot",
      runnerId: personal.runnerId,
    });
    return {
      ...common,
      key: `trigger:${occurrence.id}`,
      program: {
        ...token,
        kind: "trigger",
        aud: "opensteer-trigger-control",
        environmentId: personal.environmentId,
        executionGeneration: started.executionGeneration,
        occurrenceId: occurrence.id,
        requestedBy: personal.userId,
        runnerBootId: "fixture-boot",
        runnerId: personal.runnerId,
        threadId: owner.thread.id,
        toolContractVersion: 5,
      },
    };
  }
  const reconciled = await triggers.reconcileWatchesForRunner({
    environmentId: personal.environmentId,
    leaseExpiresAt: new Date(Date.now() + 60000),
    runnerBootId: "fixture-boot",
    runnerConnectionGeneration: 1,
    runnerId: personal.runnerId,
  });
  const activation = reconciled.activations.find(
    (a) => a.activation.triggerId === created.trigger.id,
  )!.activation;
  await triggers.applyWatchStatus({
    activationId: activation.id,
    executionGeneration: activation.executionGeneration,
    healthySince: new Date(),
    lastError: null,
    lastExitCode: null,
    observed: "running",
    restartCount: 0,
    runnerBootId: "fixture-boot",
    runnerConnectionGeneration: 1,
    runnerId: personal.runnerId,
    stderrTail: "",
    stdoutTail: "",
  });
  return {
    ...common,
    key: `watch:${activation.id}`,
    program: {
      ...token,
      kind: "watch",
      aud: "opensteer-watch-control",
      activationId: activation.id,
      anchorThreadId: owner.thread.id,
      createdBy: personal.userId,
      environmentId: personal.environmentId,
      executionGeneration: activation.executionGeneration,
      revisionId: created.revision.id,
      triggerId: created.trigger.id,
      toolContractVersion: 5,
    },
  };
}

test.each(["trigger", "watch"] as const)(
  "%s programs discover/call/execute and resume pending, but cannot manage or request accounts",
  async (kind) => {
    const caller = await program(kind);
    expect(await call(caller, "plugin_search", { namespace: "fixture" })).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ path: "tools.fixture.read" })]),
    });
    expect(await call(caller, "plugin_describe", { paths: ["tools.fixture.read"] })).toMatchObject({
      items: [expect.objectContaining({ path: "tools.fixture.read" })],
    });
    expect(
      await call(caller, "plugin_execute", {
        code: "return await tools.fixture.read({amount:3});",
      }),
    ).toMatchObject({ status: "completed", result: { execution: { value: 4 } } });
    const pending = await call(
      caller,
      "plugin_call",
      { calls: { path: "tools.fixture.reviewed", input: { amount: 4 } } },
      true,
    );
    expect(pending.status).toBe("pending");
    await answer(z.custom<RequestId>().parse(pending.requestId));
    expect(await call(caller, "plugin_resume", { executionId: pending.executionId })).toMatchObject(
      { status: "completed" },
    );
    for (const [name, input] of [
      ["opensteer_plugin_list", {}],
      ["opensteer_plugin_install", { source: "catalog", catalogId: "fixture" }],
      [
        "plugin_account_request",
        { pluginId: plugin, requirement: "service", scope: "user", reason: "Read" },
      ],
    ] as const)
      await expect(call(caller, name, input)).rejects.toThrow();
  },
);

test("connected external agents can discover and list, but cannot execute, manage or ask for accounts", async () => {
  const connections = new AgentConnectionStore(database);
  const connection = await connections.create({
    userId: personal.userId,
    label: "External",
    clientName: "Fixture",
    accessMode: "full-access",
    resource: "http://127.0.0.1/mcp",
    expiresAt: new Date(Date.now() + 60000),
  });
  await connections.activate(connection.id, "fixture-token-hash");
  const caller: AgentCaller = {
    kind: "connection",
    key: `connection:${connection.id}`,
    userId: personal.userId,
    accessMode: "full-access",
    connectionId: connection.id,
  };
  expect(await call(caller, "plugin_search", { namespace: "fixture" })).toMatchObject({
    items: expect.any(Array),
  });
  expect(await call(caller, "plugin_describe", { paths: ["tools.fixture.read"] })).toMatchObject({
    items: [expect.objectContaining({ path: "tools.fixture.read" })],
  });
  // A write it is kept from by Read-only is named without its input type or signature.
  await records.setAccess(personal.userId, plugin, "read-only");
  const found = await call(caller, "plugin_search", { namespace: "fixture" });
  const items = found.items as { path: string; input?: string }[];
  expect(items.find(({ path }) => path === "tools.fixture.read")).toHaveProperty("input");
  expect(items.find(({ path }) => path === "tools.fixture.reviewed")).toEqual({
    path: "tools.fixture.reviewed",
    description: expect.any(String),
    blocked: expect.objectContaining({ code: "access_denied" }),
  });
  expect(
    await call(caller, "plugin_describe", { paths: ["tools.fixture.reviewed"] }),
  ).toMatchObject({
    items: [{ path: "tools.fixture.reviewed", blocked: { code: "access_denied" } }],
  });
  expect(
    (await call(caller, "plugin_describe", { paths: ["tools.fixture.reviewed"] })).items,
  ).toEqual([expect.not.objectContaining({ signature: expect.anything() })]);
  await records.setAccess(personal.userId, plugin, "all");
  expect(await call(caller, "opensteer_plugin_list", {})).toMatchObject({
    plugins: expect.arrayContaining([expect.objectContaining({ id: plugin })]),
  });
  for (const [name, input] of [
    ["plugin_call", { calls: { path: "tools.fixture.read", input: { amount: 1 } } }],
    ["plugin_execute", { code: "return 1;" }],
    ["opensteer_plugin_install", { source: "catalog", catalogId: "fixture" }],
    [
      "plugin_account_request",
      { pluginId: plugin, requirement: "service", scope: "user", reason: "Read" },
    ],
  ] as const)
    await expect(call(caller, name, input)).rejects.toThrow();
  await connections.revoke(personal.userId, connection.id);
  await expect(call(caller, "plugin_search", {})).rejects.toThrow();
});

test.each(["background", "voice", "team"] as const)(
  "%s Runs retain plugin call authority, with non-foreground waits pending immediately",
  async (kind) => {
    const caller = await run();
    if (kind === "background")
      await database
        .updateTable("runs")
        .set({ phase: "background" })
        .where("id", "=", caller.claims.runId)
        .execute();
    if (kind === "voice")
      await database
        .updateTable("runs")
        .set({ voiceSessionId: randomUUID() })
        .where("id", "=", caller.claims.runId)
        .execute();
    if (kind === "team") {
      await database
        .updateTable("threads")
        .set({ teamAskOrigin: true })
        .where("id", "=", caller.thread.id)
        .execute();
      await database
        .updateTable("runs")
        .set({
          replyTarget: {
            kind: "team-thread",
            teamId: createId("deployment"),
            channelId: createId("teamChannel"),
            threadRootId: TeamMessageIdSchema.parse("1"),
            requestId: createId("teamAgentRequest"),
          },
        })
        .where("id", "=", caller.claims.runId)
        .execute();
    }
    expect(
      await call(
        caller,
        "plugin_call",
        { calls: { path: "tools.fixture.read", input: { amount: 1 } } },
        true,
      ),
    ).toMatchObject({ status: "completed" });
    if (kind !== "team")
      expect(
        await call(
          caller,
          "plugin_call",
          { calls: { path: "tools.fixture.reviewed", input: { amount: 2 } } },
          true,
        ),
      ).toMatchObject({ status: "pending" });
  },
);

test("plugin access settings keep known tools visible with typed refusals", async () => {
  const caller = await run();
  for (const [access, path, input, label] of [
    ["read-only", "tools.fixture.reviewed", { amount: 2 }, "Read-only"],
    ["off", "tools.fixture.read", { amount: 1 }, "Off"],
  ] as const) {
    await records.setAccess(personal.userId, plugin, access);
    const blocked = {
      code: "access_denied",
      message: expect.stringContaining(label),
      next: expect.stringMatching(/person.*Plugins/u),
    };
    // Off keeps the whole plugin, so its namespace says so once; Read-only keeps each write.
    for (const found of [
      await call(caller, "plugin_search", { namespace: "fixture" }),
      await call(caller, "plugin_describe", { paths: [path] }),
    ]) {
      const items = found.items as { path: string; blocked?: unknown }[];
      expect(items.map((item) => item.path)).toContain(path);
      if (access === "off") {
        expect(found.namespaces).toEqual([expect.objectContaining({ blocked })]);
        expect(items.filter((item) => "blocked" in item)).toEqual([]);
      } else expect(items.find((item) => item.path === path)).toMatchObject({ blocked });
    }
    expect(await call(caller, "plugin_call", { calls: { path, input } }, true)).toMatchObject({
      error: blocked,
    });
    // Inside a program the refused call fails with the Host's code, as every refusal there does.
    expect(
      await call(caller, "plugin_execute", {
        code: `try { return await ${path}(${JSON.stringify(input)}); } catch (error) { return { refused: JSON.parse(error.message) }; }`,
      }),
    ).toMatchObject({
      result: {
        execution: {
          ok: true,
          value: {
            refused: {
              code: blocked.code,
              message: blocked.message,
              recovery: { instructions: blocked.next },
            },
          },
        },
      },
    });
  }
  expect(await call(caller, "opensteer_plugin_list", {})).toEqual({
    plugins: [],
    local: [],
    cursor: null,
  });
});

test("an ask-mode held write returns the actual result after the person approves", async () => {
  const caller = await run();
  const attaching = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const attachInteraction = records.attachInteraction.bind(records);
  const attach = vi.spyOn(records, "attachInteraction").mockImplementation(async (...args) => {
    attaching.resolve();
    await release.promise;
    return attachInteraction(...args);
  });
  const work = call(
    caller,
    "plugin_call",
    { calls: { path: "tools.fixture.reviewed", input: { amount: 7 } } },
    true,
  );
  try {
    await Promise.race([
      attaching.promise,
      work.then((result) => {
        throw new Error(
          `Plugin call ended before attaching its Request: ${JSON.stringify(result)}`,
        );
      }),
    ]);
    const premature = await database
      .selectFrom("requests")
      .select("id")
      .where("originatingRunId", "=", caller.claims.runId)
      .where("status", "=", "pending")
      .executeTakeFirst();
    expect(premature).toBeUndefined();
  } finally {
    release.resolve();
    attach.mockRestore();
  }
  const request = await pendingRequest(caller);
  expect(request.kind).toBe("plugin.approval");
  expect(request.presentation.plugin).toMatchObject({
    plugin: { id: plugin, author: "agent" },
    decision: { kind: "approval", tool: "reviewed", arguments: { amount: 7 } },
  });
  await answer(request.id);
  expect(await deadline(work, "Held plugin call did not return")).toMatchObject({
    status: "completed",
    result: { execution: { value: { ok: true, value: 8 } } },
  });
});

test("stopping a Run before its plugin input Request attaches rolls back the Request", async ({
  signal,
}) => {
  const caller = await run("full-access");
  const attaching = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const abort = () => release.resolve();
  signal.addEventListener("abort", abort, { once: true });
  const attachInteraction = records.attachInteraction.bind(records);
  const attach = vi.spyOn(records, "attachInteraction").mockImplementation(async (...args) => {
    attaching.resolve();
    await release.promise;
    return attachInteraction(...args);
  });
  const work = call(caller, "plugin_call", {
    calls: { path: "tools.fixture.input", input: { label: "Interrupted input" } },
  });
  try {
    await Promise.race([
      attaching.promise,
      work.then((result) => {
        throw new Error(
          `Plugin call ended before attaching its Request: ${JSON.stringify(result)}`,
        );
      }),
    ]);
    await executions.stopRun(caller.claims.runId);
  } finally {
    release.resolve();
    signal.removeEventListener("abort", abort);
    attach.mockRestore();
  }
  expect(await work).toMatchObject({ status: "cancelled" });
  expect(
    await database
      .selectFrom("requests")
      .select("id")
      .where("originatingRunId", "=", caller.claims.runId)
      .where("kind", "=", "plugin.input")
      .execute(),
  ).toEqual([]);
});

test("declining a held approval returns a refusal without executing the approved mutation", async () => {
  const caller = await run("auto-accept-edits");
  const work = call(
    caller,
    "plugin_call",
    { calls: { path: "tools.fixture.reviewed", input: { amount: 4 } } },
    true,
  );
  const request = await Promise.race([
    pendingRequest(caller),
    work.then((result) => {
      throw new Error(`Plugin call ended before its approval Request: ${JSON.stringify(result)}`);
    }),
  ]);
  await answer(request.id, false);
  expect(await deadline(work, "Declined plugin call remained held")).toMatchObject({
    status: "completed",
    result: { execution: { value: { ok: false } } },
  });
});

test("hold handoff wakes the task; a later Run can resume and another task cannot", async () => {
  const caller = await run();
  const pending = await call(caller, "plugin_execute", {
    code: "const first=await tools.fixture.reviewed({amount:1});return first+await tools.fixture.reviewed({amount:2});",
  });
  const id = z.string().parse(pending.executionId);
  expect(
    await executions.hold({
      caller,
      record: pending,
      limitMs: 1,
      admittedAt: Date.now() - 2,
      steersAtAdmission: 0,
      signal: new AbortController().signal,
    }),
  ).toMatchObject({ status: "pending" });
  const request = await pendingRequest(caller);
  const original = await database
    .selectFrom("runs")
    .selectAll()
    .where("id", "=", caller.claims.runId)
    .executeTakeFirstOrThrow();
  await store.commitRunnerEvent({
    environmentId: caller.claims.environmentId,
    runnerId: caller.claims.runnerId,
    runnerBootId: caller.claims.runnerBootId,
    event: pendingEvent({
      type: "run.interrupted",
      environmentId: caller.claims.environmentId,
      bindingGeneration: caller.claims.bindingGeneration,
      ordinal: original.nextRunnerOrdinal,
      runId: caller.claims.runId,
      threadId: caller.thread.id,
      data: { status: "interrupted" },
    }),
  });
  await answer(request.id);
  const queued: unknown[] = [];
  const continuations = new ContinuationService({
    requests: store.requests,
    integrations: {} as never,
    commands: {
      enqueueThreadInput: async (input) => {
        const delivered = await store.enqueueThreadInput(input);
        if (input.threadId === caller.thread.id) queued.push(delivered);
        return delivered;
      },
    },
    onError: (e) => errors.push(e),
  });
  continuations.start();
  await vi.waitFor(() => expect(queued).toHaveLength(1), { timeout: 2000 });
  await continuations.close();
  expect(JSON.stringify(queued)).toContain("plugin_resume");
  const other = await run();
  await expect(call(other, "plugin_resume", { executionId: id })).rejects.toThrow("unavailable");
  const continued = z.object({ run: z.object({ id: z.string() }) }).parse(queued[0]);
  const resumedRun = await startPersonalQueuedRunFixture(
    store,
    continued.run.id as RunCaller["claims"]["runId"],
  );
  const claims = await store.runCapabilityScope(resumedRun.run.id);
  if (!claims) throw new Error("Continuation has no live Run scope");
  const later: RunCaller = {
    ...caller,
    key: `run:${resumedRun.run.id}`,
    claims: {
      ...claims,
      aud: "opensteer-run-tools",
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      iss: "opensteer-host",
      jti: randomUUID(),
    },
  };
  const continuedWork = call(later, "plugin_resume", { executionId: id }, true);
  const nextRequest = await pendingRequest(later);
  expect(nextRequest.originatingRunId).toBe(later.claims.runId);
  await answer(nextRequest.id);
  expect(
    await deadline(continuedWork, "Resumed plugin call did not consume its second answer"),
  ).toMatchObject({ status: "completed", result: { execution: { value: 5 } } });
});

test.each(["auto", "full-access"] as const)(
  "%s accepts tool approval rules without opening a Request",
  async (mode) => {
    const caller = await run(mode);
    expect(
      await call(
        caller,
        "plugin_call",
        { calls: { path: "tools.fixture.reviewed", input: { amount: 2 } } },
        true,
      ),
    ).toMatchObject({ status: "completed" });
    expect(
      await database
        .selectFrom("requests")
        .select("id")
        .where("originatingRunId", "=", caller.claims.runId)
        .execute(),
    ).toEqual([]);
  },
);

test("input always goes to the person, and its answer reaches only that execution", async () => {
  const caller = await run("auto");
  const first = await call(caller, "plugin_call", {
    calls: { path: "tools.fixture.input", input: { label: "first" } },
  });
  const second = await call(caller, "plugin_call", {
    calls: { path: "tools.fixture.input", input: { label: "second" } },
  });
  expect(first, JSON.stringify(first)).toMatchObject({
    status: "pending",
    requestId: expect.any(String),
  });
  expect(second, JSON.stringify(second)).toMatchObject({
    status: "pending",
    requestId: expect.any(String),
  });
  const firstRequest = await store.requests.get(z.custom<RequestId>().parse(first.requestId));
  expect(firstRequest?.kind).toBe("plugin.input");
  expect(firstRequest?.presentation.plugin?.decision).toMatchObject({
    kind: "input",
    schema: { required: ["name"] },
  });
  await answer(firstRequest!.id, true, { name: "private answer" });
  expect(await call(caller, "plugin_resume", { executionId: first.executionId })).toMatchObject({
    status: "completed",
    result: {
      execution: {
        value: {
          ok: true,
          value: { label: "first", response: { content: { name: "private answer" } } },
        },
      },
    },
  });
  expect(await call(caller, "plugin_resume", { executionId: second.executionId })).toMatchObject({
    status: "pending",
  });
  expect(JSON.stringify(await store.requests.get(firstRequest!.id))).not.toContain(
    "private answer",
  );
});

test.each(["approval-required", "auto-accept-edits"] as const)(
  "downgrading an automatic program to %s interrupts it at answer delivery and resume",
  async (mode) => {
    for (const stage of ["answer", "resume"] as const) {
      const caller = await run("full-access");
      const pending = await call(caller, "plugin_execute", {
        code: 'await tools.fixture.input({label:"before write"}); return await tools.fixture.reviewed({amount:2});',
      });
      expect(pending).toMatchObject({ status: "pending" });
      const requestId = RequestIdSchema.parse(pending.requestId);
      if (stage === "resume") await answer(requestId, true, { name: "answer" });
      await database
        .updateTable("threads")
        .set({ accessMode: mode })
        .where("id", "=", caller.thread.id)
        .execute();
      if (stage === "answer")
        await expect(answer(requestId, true, { name: "answer" })).rejects.toThrow(
          /authority changed/iu,
        );
      const ended = await executions.resume(caller, String(pending.executionId));
      expect(ended).toMatchObject({
        status: "interrupted",
        reason: expect.stringMatching(/authority changed/iu),
        next: expect.stringContaining("never rerun blindly"),
      });
      expect((await store.requests.get(requestId))?.cancellationReason).toBe("plugin-interrupted");
    }
  },
);

test.each(["trigger", "watch", "voice", "background"] as const)(
  "%s work loses captured automatic approval when its task is downgraded",
  async (kind) => {
    const caller =
      kind === "trigger" || kind === "watch"
        ? await program(kind, "full-access")
        : await run("full-access");
    if (caller.kind === "connection") throw new Error("Invalid program fixture");
    if (caller.kind === "run")
      await database
        .updateTable("runs")
        .set(kind === "voice" ? { voiceSessionId: randomUUID() } : { phase: "background" })
        .where("id", "=", caller.claims.runId)
        .execute();
    const pending = await call(caller, "plugin_execute", {
      code: 'await tools.fixture.input({label:"before write"}); return await tools.fixture.reviewed({amount:2});',
    });
    expect(pending).toMatchObject({ status: "pending" });
    const requestId = RequestIdSchema.parse(pending.requestId);
    await database
      .updateTable("threads")
      .set({ accessMode: "approval-required" })
      .where("id", "=", caller.kind === "run" ? caller.thread.id : caller.anchor.id)
      .execute();
    await expect(answer(requestId, true, { name: "answer" })).rejects.toThrow(
      /authority changed/iu,
    );
    expect(await executions.resume(caller, String(pending.executionId))).toMatchObject({
      status: "interrupted",
    });
    // An answer that arrives after the interruption is told the same thing.
    await expect(answer(requestId, true, { name: "answer" })).rejects.toThrow(
      /authority changed/iu,
    );
  },
);

test("task and plugin settings commit while source export is in flight", async () => {
  const caller = await run("full-access");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  exportWait = async () => {
    entered.resolve();
    await deadline(release.promise, "Export was never released");
  };
  const pending = call(caller, "opensteer_plugin_export", {
    pluginId: plugin,
    directory: "blocked-export",
  }).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  try {
    await deadline(entered.promise, "Export did not reach its pending file write");
    const changed = Promise.all([
      store.updateThreadAccessMode({
        threadId: caller.thread.id,
        requestedBy: personal.userId,
        accessMode: "approval-required",
      }),
      records.setAccess(personal.userId, plugin, "off"),
    ]);
    await withTimeout(changed, 3000, {
      timeoutError: () => new Error("A person's setting change waited for plugin export"),
    });
    release.resolve();
    expect(await deadline(pending, "Narrowed export did not return")).toHaveProperty("error");
  } finally {
    exportWait = undefined;
    release.resolve();
    await pending;
  }
});

test("cancelling an export during the root lookup leaves no draft", async () => {
  const caller = await run("full-access");
  current = caller;
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = NativeFsHelper.prototype.directoryIdentity;
  const lookup = vi
    .spyOn(NativeFsHelper.prototype, "directoryIdentity")
    .mockImplementationOnce(async function (this: NativeFsHelper, ...args) {
      const identity = await original.apply(this, args);
      entered.resolve();
      await deadline(release.promise, "Export root lookup was never released");
      return identity;
    });
  const pending = mcp
    .callTool(
      "token",
      "opensteer_plugin_export",
      { pluginId: plugin, directory: "cancelled-export" },
      { caller, operationKey: randomUUID(), signal: controller.signal },
    )
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  try {
    await deadline(entered.promise, "Export never looked up its root");
    controller.abort();
    release.resolve();
    expect(await deadline(pending, "Cancelled export never returned")).toHaveProperty("error");
    await expect(stat(join(directory, "cancelled-export"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    release.resolve();
    lookup.mockRestore();
    await pending;
  }
});

test("a later discovery call leaves the submitted execution's approval mode intact", async () => {
  const caller = await run();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  authorizationWait = async (input) => {
    if (input.operation !== "call" || input.plugin) return;
    entered.resolve();
    await deadline(release.promise, "Original execution was never released");
  };
  const pending = call(caller, "plugin_call", {
    calls: { path: "tools.fixture.reviewed", input: { amount: 1 } },
  });
  try {
    await deadline(entered.promise, "Original execution did not reach engine admission");
    await store.updateThreadAccessMode({
      threadId: caller.thread.id,
      requestedBy: personal.userId,
      accessMode: "auto",
    });
    const automatic = { ...caller, accessMode: "auto" as const };
    await call(automatic, "plugin_search", { namespace: "fixture" });
    release.resolve();
    const result = await deadline(pending, "Original execution did not ask for approval");
    expect(result.status).toBe("pending");
    expect((await records.execution(String(result.executionId)))?.mode).toBe("ask");
    await answer(z.custom<RequestId>().parse(result.requestId));
    expect(await executions.resume(automatic, String(result.executionId))).toMatchObject({
      status: "completed",
    });
  } finally {
    authorizationWait = undefined;
    release.resolve();
    await pending.catch(() => undefined);
  }
});

test("raising a task to automatic never answers its existing approval Request", async () => {
  const caller = await run();
  const pending = await call(caller, "plugin_call", {
    calls: { path: "tools.fixture.reviewed", input: { amount: 1 } },
  });
  await database
    .updateTable("threads")
    .set({ accessMode: "full-access" })
    .where("id", "=", caller.thread.id)
    .execute();
  const automatic = { ...caller, accessMode: "full-access" as const };
  expect(await executions.resume(automatic, String(pending.executionId))).toMatchObject({
    status: "pending",
  });
  expect((await store.requests.get(z.custom<RequestId>().parse(pending.requestId)))?.status).toBe(
    "pending",
  );
  await answer(z.custom<RequestId>().parse(pending.requestId));
  expect(await executions.resume(automatic, String(pending.executionId))).toMatchObject({
    status: "completed",
  });
});

test.each(["off", "remove", "unlink", "delete account"] as const)(
  "plugin %s cancels its execution and removes the pending Request",
  async (change) => {
    const caller = await run();
    const installed = await service.install(
      {
        kind: "files",
        name: `Cancellation fixture ${change}`,
        files: pluginFixtureFiles(1, ["api.fixture.invalid"]),
      },
      ownerContext,
    );
    if (installed.status !== "installed") throw new Error("Cancellation fixture did not install");
    const pluginId = installed.plugin.id;
    const target = { plugin: pluginId, requirement: "service", scope: "user" as const };
    const account = await service.createApiKeyAccount(
      {
        provider: installed.plugin.requirements.accounts.service!.provider,
        method: "key",
        fields: { token: "fixture-cancellation-key" },
      },
      ownerContext,
    );
    await service.linkAccount(
      {
        ...target,
        account: account.id,
        consent: await service.reviewAccountLink(target, ownerContext),
      },
      ownerContext,
    );
    const accountRequest = await call(caller, "plugin_account_request", {
      pluginId,
      requirement: target.requirement,
      scope: target.scope,
      reason: "Review this link",
    });
    const pending = await call(caller, "plugin_call", {
      calls: {
        path: `tools[${JSON.stringify(installed.plugin.slug)}].reviewed`,
        input: { amount: 1 },
      },
    });
    const requestId = z.custom<RequestId>().parse(pending.requestId);
    const api = new PluginOwnerApi({
      service,
      settings: records,
      assertOwner: async () => {},
      accountLinked: async () => {},
      cancelPlugin: (owner, plugin) => executions.cancelPlugin(owner, plugin),
      changed: () => {},
    });
    const key = { pluginId, idempotencyKey: randomUUID() };
    const changeCommand =
      change === "off"
        ? { ...key, type: "plugins.access.set" as const, access: "off" as const }
        : change === "remove"
          ? { ...key, type: "plugins.remove" as const }
          : change === "delete account"
            ? {
                type: "plugins.account.remove" as const,
                idempotencyKey: key.idempotencyKey,
                accountId: account.id,
              }
            : {
                ...key,
                type: "plugins.account.unlink" as const,
                requirement: target.requirement,
                scope: target.scope,
                accountId: account.id,
              };
    await api.command(changeCommand, {
      session: {
        id: createId("authSession"),
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        absoluteExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        user: {
          id: personal.userId,
          displayName: "Person",
          email: "fixture@example.test",
          emailVerified: true,
          disabledAt: null,
          image: null,
        },
      },
      headers: {},
      requestId: "fixture",
      requestUrl: "/",
      signal: new AbortController().signal,
      surface: "canonical",
      setHeader: () => {},
    });
    expect(await store.requests.get(requestId)).toMatchObject({
      status: "cancelled",
      cancellationReason: "plugin-interrupted",
    });
    expect(
      await store.requests.get(z.custom<RequestId>().parse(accountRequest.requestId)),
    ).toMatchObject({ status: "cancelled", cancellationReason: "plugin-interrupted" });
    await expect(answer(requestId)).rejects.toThrow();
    expect(await call(caller, "plugin_resume", { executionId: pending.executionId })).toMatchObject(
      {
        status: "interrupted",
      },
    );
  },
);

test("a refused plugin update leaves the active SQLite schema and version intact", async () => {
  const readSource = pluginFixtureFiles(1).map((file) =>
    file.path !== "index.ts"
      ? file
      : {
          ...file,
          content: file.content.replace(
            "async (_ctx, { amount }) => amount + 1",
            'async (ctx) => ctx.sql.exec("SELECT value FROM counter").one().value',
          ),
        },
  );
  const files = [
    ...readSource,
    {
      path: "migrations/0001_counter.sql",
      content: "CREATE TABLE counter (value INTEGER); INSERT INTO counter VALUES (7);",
    },
  ];
  const prior = await service.install(
    { kind: "files", name: "Migration fixture", files },
    ownerContext,
  );
  if (prior.status !== "installed") throw new Error("Migration fixture did not install");
  const caller = await run("full-access");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  authorizationWait = async (input) => {
    if (input.operation !== "install" || input.plugin !== prior.plugin.id) return;
    entered.resolve();
    await deadline(release.promise, "Update was never released");
  };
  const update = authority
    .scoped(caller, () =>
      service.install(
        {
          kind: "files",
          plugin: prior.plugin.id,
          files: [
            ...files,
            {
              path: "migrations/0002_rename.sql",
              content: "ALTER TABLE counter RENAME COLUMN value TO renamed;",
            },
          ],
        },
        authority.admit(caller),
      ),
    )
    .catch((error: unknown) => error);
  try {
    await deadline(entered.promise, "Update did not pass admission before its build");
    await store.updateThreadAccessMode({
      threadId: caller.thread.id,
      requestedBy: personal.userId,
      accessMode: "approval-required",
    });
    authorizationWait = undefined;
    release.resolve();
    expect(await deadline(update, "Refused update did not end")).toMatchObject({
      code: "forbidden",
    });
    expect(
      (await service.detail({ plugin: prior.plugin.id }, ownerContext)).plugin.activeVersion,
    ).toBe(prior.version.id);
    expect(
      (
        await service.call(
          {
            calls: {
              path: `tools[${JSON.stringify(prior.plugin.slug)}].read`,
              input: { amount: 0 },
            },
          },
          ownerContext,
        )
      ).result,
    ).toMatchObject({ execution: { value: { ok: true, value: 7 } } });
  } finally {
    authorizationWait = undefined;
    release.resolve();
    await update;
  }
});

test("Stop discards an execution and cancels its Request", async () => {
  const caller = await run();
  const pending = await call(caller, "plugin_call", {
    calls: { path: "tools.fixture.reviewed", input: { amount: 9 } },
  });
  const stopped = await store.enqueueRunnerControl({
    type: "run.interrupt",
    runId: caller.claims.runId,
    threadId: caller.thread.id,
    requestedBy: personal.userId,
    idempotencyKey: randomUUID(),
  });
  for (const event of stopped.events) executions.observe(event);
  await vi.waitFor(
    async () =>
      expect(await records.execution(z.string().parse(pending.executionId))).toMatchObject({
        state: "cancelled",
      }),
    { timeout: 3000 },
  );
  expect(await store.requests.get(z.custom<RequestId>().parse(pending.requestId))).toMatchObject({
    status: "cancelled",
    cancellationReason: "run-ended",
  });
  await expect(
    call(caller, "plugin_resume", { executionId: pending.executionId }),
  ).rejects.toThrow();
});

test("an empty many account slot is usable and changed consent needs owner review", async () => {
  const caller = await run();
  const source = (sites: string[]) =>
    pluginFixtureFiles(1, sites).map((file) =>
      file.path === "index.ts"
        ? {
            ...file,
            content: file.content.replace(
              "accounts: { service }",
              "accounts: { service: service.many() }",
            ),
          }
        : file,
    );
  const installed = await service.install(
    {
      kind: "files",
      name: "Account readiness fixture",
      files: source(["api.fixture.invalid"]),
    },
    ownerContext,
  );
  if (installed.status !== "installed")
    throw new Error("Account readiness fixture did not install");
  const { id, slug } = installed.plugin;
  const toolList = async () =>
    z
      .object({ plugins: z.array(z.record(z.string(), z.unknown())) })
      .parse(await call(caller, "opensteer_plugin_list", {}))
      .plugins.find((item) => item.id === id);
  const empty = await toolList();
  expect(empty).toMatchObject({ status: "active", links: [] });
  expect(empty).not.toHaveProperty("blocked");
  const target = { plugin: id, requirement: "service", scope: "user" as const };
  const account = await service.createApiKeyAccount(
    {
      provider: installed.plugin.requirements.accounts.service!.provider,
      method: "key",
      fields: { token: "fixture-readiness-key" },
    },
    ownerContext,
  );
  await service.linkAccount(
    {
      ...target,
      account: account.id,
      consent: await service.reviewAccountLink(target, ownerContext),
    },
    ownerContext,
  );
  const updated = await service.install(
    {
      kind: "files",
      plugin: id,
      files: source(["api.fixture.invalid", "other.fixture.invalid"]),
    },
    ownerContext,
  );
  if (updated.status !== "installed")
    throw new Error("Changed account declaration did not install");
  const guidance = {
    code: "sign_in_required",
    message: expect.stringContaining("account link reviewed"),
    next: expect.stringContaining("review the changed account link in Plugins"),
  };
  expect(await toolList()).toMatchObject({ status: "unavailable", blocked: guidance });
  expect(await call(caller, "plugin_search", { namespace: slug })).toMatchObject({
    unavailableApps: expect.arrayContaining([
      expect.objectContaining({ app: id, blocked: guidance }),
    ]),
  });
});

test("account Request pins disclosure and a person-reviewed link fulfils it", async () => {
  const caller = await run();
  const installed = await service.install(
    {
      kind: "files",
      name: "Account fixture",
      files: pluginFixtureFiles(1, ["api.fixture.invalid"]),
    },
    ownerContext,
  );
  if (installed.status !== "installed") throw new Error("Account fixture did not install");
  const target = { plugin: installed.plugin.id, requirement: "service", scope: "user" as const };
  await recordPluginAuthor(database, personal.userId, installed.plugin.id, installed.version.id, "agent");
  await recordPluginAuthor(database, personal.userId, installed.plugin.id, "older-version", "catalog");
  const unavailable = await call(caller, "plugin_search", { namespace: installed.plugin.slug });
  expect(unavailable.unavailableApps).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        app: target.plugin,
        blocked: {
          code: "sign_in_required",
          message: expect.any(String),
          next: expect.stringContaining(`"pluginId":"${target.plugin}"`),
        },
      }),
    ]),
  );
  const result = await call(caller, "plugin_account_request", {
    pluginId: target.plugin,
    requirement: target.requirement,
    scope: target.scope,
    reason: "Read this account",
  });
  const request = (await store.requests.get(z.custom<RequestId>().parse(result.requestId)))!;
  expect(request).toMatchObject({
    kind: "plugin.account",
    mode: "durable",
    presentation: {
      plugin: {
        plugin: { author: "agent" },
        decision: {
          kind: "account",
          consent: { sites: ["api.fixture.invalid"], credential: "sealed" },
        },
      },
    },
  });
  const requirement = installed.plugin.requirements.accounts.service!;
  const account = await service.createApiKeyAccount(
    { provider: requirement.provider, method: "key", fields: { token: "fixture-key" } },
    ownerContext,
  );
  const consent = await service.reviewAccountLink(target, ownerContext);
  await service.linkAccount({ ...target, account: account.id, consent }, ownerContext);
  await handlers.accountLinked({ owner: personal.userId, ...target, consent });
  const fulfilled = (await store.requests.get(request.id))!;
  expect(fulfilled.status).toBe("fulfilled");
  expect(await continuationMessage(fulfilled, {} as never)).toContain("plugin_search");
});

test("folder build errors are data; a fixed draft deploys a version and can roll back", async () => {
  const caller = await run("full-access");
  const folder = "draft";
  await mkdir(join(directory, folder));
  for (const file of pluginFixtureFiles(1).filter((f) => !f.path.includes("/")))
    await writeFile(
      join(directory, folder, file.path),
      file.path === "index.ts" ? "invalid TypeScript [" : file.content,
    );
  expect(
    await call(caller, "opensteer_plugin_install", { source: "folder", directory: folder }),
  ).toMatchObject({ status: "build-error", error: expect.any(Object) });
  const binary = Buffer.from([0, 255, 128, 10, 0, 127, 42]);
  await mkdir(join(directory, folder, "ui", "public"), { recursive: true });
  await writeFile(join(directory, folder, "ui", "public", "page-asset.bin"), binary);
  const source = pluginFixtureFiles(1).find((f) => f.path === "index.ts")!;
  await writeFile(join(directory, folder, "index.ts"), source.content);
  const installKey = randomUUID();
  const installInput = { source: "folder", directory: folder, name: "Draft" };
  const first = await call(
    caller,
    "opensteer_plugin_install",
    {
      source: "folder",
      directory: folder,
      name: "Draft",
    },
    false,
    installKey,
  );
  expect(await call(caller, "opensteer_plugin_install", installInput, false, installKey)).toEqual(
    first,
  );
  // The receipt answers before the folder is read: a moved draft cannot hide the finished install.
  await rename(join(directory, folder), join(directory, "draft-moved"));
  try {
    expect(await call(caller, "opensteer_plugin_install", installInput, false, installKey)).toEqual(
      first,
    );
  } finally {
    await rename(join(directory, "draft-moved"), join(directory, folder));
  }
  const deployed = record.parse(first.plugin);
  const version = record.parse(first.version);
  await writeFile(
    join(directory, folder, "index.ts"),
    source.content.replace("amount + 1", "amount + 2"),
  );
  const second = await call(caller, "opensteer_plugin_install", {
    source: "folder",
    directory: folder,
    pluginId: deployed.id,
  });
  expect(record.parse(second.version).id).not.toBe(version.id);
  await call(caller, "opensteer_plugin_activate", { pluginId: deployed.id, versionId: version.id });
  expect(
    (await service.detail({ plugin: z.string().parse(deployed.id) }, ownerContext)).plugin
      .activeVersion,
  ).toBe(version.id);
  await call(caller, "opensteer_plugin_export", { pluginId: deployed.id, directory: "exported" });
  expect(await readFile(join(directory, "exported", "index.ts"), "utf8")).toBe(source.content);
  expect(await readFile(join(directory, "exported", "ui", "public", "page-asset.bin"))).toEqual(
    binary,
  );
  await expect(
    call(caller, "opensteer_plugin_export", { pluginId: deployed.id, directory: "exported" }),
  ).rejects.toThrow();
  expect(await readFile(join(directory, "exported", "ui", "public", "page-asset.bin"))).toEqual(
    binary,
  );
  await symlink(directory, join(directory, "export-link"));
  await expect(
    call(caller, "opensteer_plugin_export", {
      pluginId: deployed.id,
      directory: "export-link/escaped",
    }),
  ).rejects.toThrow();
});

test("discovers a catalog entry, reads live skills and installs without asking the person", async () => {
  const caller = await run("full-access");
  const catalog = await call(caller, "opensteer_plugin_catalog", { search: "fixture", limit: 1 });
  expect(catalog).toMatchObject({
    items: [{ id: "fixture", name: "Catalog fixture", accounts: [] }],
    cursor: null,
  });
  const id = z.object({ items: z.array(z.object({ id: z.string() })) }).parse(catalog).items[0]!.id;
  expect(
    JSON.stringify(await call(caller, "plugin_skills", { app: "fixture", name: "demo" })),
  ).toContain("Fixture skill");
  expect(
    await call(caller, "plugin_resources", { pluginId: plugin, resource: "workflows" }),
  ).toMatchObject({ items: [], definitions: [{ name: "quick" }] });
  expect(
    await call(caller, "opensteer_plugin_install", { source: "catalog", catalogId: id }),
  ).toMatchObject({ status: "installed" });
  expect(
    await database
      .selectFrom("requests")
      .select("id")
      .where("originatingRunId", "=", caller.claims.runId)
      .execute(),
  ).toEqual([]);
});

test("engine interaction expiry ends both the execution and its Request with that reason", async () => {
  const caller = await run();
  const pending = await call(caller, "plugin_call", {
    calls: { path: "tools.fixture.reviewed", input: { amount: 1 } },
  });
  const expired = Promise.withResolvers<void>();
  const listener = (event: import("../packages/core/src/index.js").AgentEvent) => {
    if ("requestId" in event.data && event.data.requestId === pending.requestId) expired.resolve();
  };
  events.on("request.cancelled", listener);
  try {
    await deadline(expired.promise, "Engine interaction did not expire");
  } finally {
    events.off("request.cancelled", listener);
  }
  expect(await store.requests.get(z.custom<RequestId>().parse(pending.requestId))).toMatchObject({
    status: "cancelled",
    cancellationReason: "plugin-expired",
  });
  expect(await call(caller, "plugin_resume", { executionId: pending.executionId })).toMatchObject({
    status: "expired",
    next: expect.stringContaining("never rerun"),
  });
});

test("engine loss interrupts open and answered-but-unconsumed waits", async () => {
  const caller = await run();
  const pending = await call(caller, "plugin_call", {
    calls: { path: "tools.fixture.reviewed", input: { amount: 5 } },
  });
  const answered = await call(caller, "plugin_call", {
    calls: { path: "tools.fixture.reviewed", input: { amount: 6 } },
  });
  await answer(z.custom<RequestId>().parse(answered.requestId));
  const lost = Promise.withResolvers<void>();
  events.once("restarting", () => {
    void executions.recover().then(() => lost.resolve(), lost.reject);
  });
  const health = await service.health({}, ownerContext);
  process.kill(health.pid, "SIGKILL");
  await deadline(lost.promise, "Engine loss did not recover executions");
  for (const result of [pending, answered]) {
    const requestId = RequestIdSchema.parse(result.requestId);
    expect(await store.requests.get(requestId)).toMatchObject({
      status: "cancelled",
      cancellationReason: "plugin-interrupted",
    });
    await expect(answer(requestId)).rejects.toThrow(/plugin engine stopped/iu);
    expect(await call(caller, "plugin_resume", { executionId: result.executionId })).toMatchObject({
      status: "interrupted",
      next: expect.stringContaining("never rerun"),
    });
  }
}, 30000);

test("resource updates respect plugin settings and schedule run operations replay durably", async () => {
  const caller = await run("full-access");
  const configuration = {
    pluginId: plugin,
    change: { action: "schedule.configure", schedule: "periodic", enabled: true },
  };
  const configurationKey = randomUUID();
  const configured = await call(
    caller,
    "opensteer_plugin_resource_update",
    configuration,
    false,
    configurationKey,
  );
  expect(configured).toMatchObject({ approvalMode: "browser" });
  const { sql } = await import("kysely");
  await sql`update plugin_engine.plugin_engine_schedules set next_at = (now() at time zone 'UTC') + interval '1 hour', revision = 'configured' where app = ${plugin}`.execute(
    database,
  );
  expect(
    await call(caller, "opensteer_plugin_resource_update", configuration, false, configurationKey),
  ).toEqual(configured);
  const schedules = await service.manage(
    { operation: "schedules.list", input: { app: plugin } },
    ownerContext,
  );
  const schedule = z.array(z.object({ id: z.string() })).parse(schedules)[0]!;
  const input = {
    pluginId: plugin,
    change: { action: "schedule.run", schedule: "periodic", scheduleId: schedule.id },
  };
  const key = randomUUID();
  const first = await call(caller, "opensteer_plugin_resource_update", input, false, key);
  // Simulate the scheduler consuming this intent; replay must return the saved revision.
  await sql`update plugin_engine.plugin_engine_schedules set next_at = (now() at time zone 'UTC') + interval '1 hour', active_run = null, revision = 'consumed' where id = ${schedule.id}`.execute(
    database,
  );
  expect(await call(caller, "opensteer_plugin_resource_update", input, false, key)).toEqual(first);
  await service.manage(
    {
      operation: "schedules.configure",
      input: { app: plugin, name: "periodic", enabled: true, approvalMode: "automatic" },
    },
    ownerContext,
  );
  await records.setAccess(personal.userId, plugin, "read-only");
  await expect(
    call(caller, "opensteer_plugin_resource_update", {
      pluginId: plugin,
      change: { action: "workflow.start", workflow: "quick", input: {}, key: randomUUID() },
    }),
  ).rejects.toThrow();
  await expect(call(caller, "opensteer_plugin_resource_update", input)).rejects.toThrow();
  await records.setAccess(personal.userId, plugin, "off");
  await expect(
    call(caller, "opensteer_plugin_resource_update", {
      pluginId: plugin,
      change: {
        action: "schedule.configure",
        schedule: "periodic",
        enabled: false,
        approvalMode: "browser",
      },
    }),
  ).rejects.toThrow();
  await expect(
    call(caller, "opensteer_plugin_resource_update", {
      pluginId: plugin,
      change: { action: "schedule.configure", schedule: "periodic", enabled: false },
    }),
  ).resolves.toMatchObject({ enabled: false, approvalMode: "automatic" });
});

test.each(["cloud", "resource"] as const)(
  "task narrowing during %s account resolution prevents dispatch or commit",
  async (path) => {
    const caller = await run("full-access");
    let targetPlugin = plugin;
    let toolPath = "tools.fixture.reviewed";
    if (path === "cloud") {
      const files = pluginFixtureFiles(1, ["api.fixture.invalid"]).map((file) =>
        file.path === "index.ts"
          ? {
              ...file,
              content: file.content.replace(
                "async (_ctx, { amount }) => amount + 1),\n  wait:",
                'async (ctx, { amount }) => { await ctx.fetch("https://api.fixture.invalid/effect"); return amount + 1; }),\n  wait:',
              ),
            }
          : file,
      );
      const installed = await service.install(
        { kind: "files", name: "Cloud admission", files },
        ownerContext,
      );
      if (installed.status !== "installed")
        throw new Error("Cloud admission fixture did not install");
      targetPlugin = installed.plugin.id;
      toolPath = `tools[${JSON.stringify(installed.plugin.slug)}].reviewed`;
      const target = { plugin: targetPlugin, requirement: "service", scope: "user" as const };
      const account = await service.createApiKeyAccount(
        {
          provider: installed.plugin.requirements.accounts.service!.provider,
          method: "key",
          fields: { token: "synthetic-admission-key" },
        },
        ownerContext,
      );
      await service.linkAccount(
        {
          ...target,
          account: account.id,
          consent: await service.reviewAccountLink(target, ownerContext),
        },
        ownerContext,
      );
    }
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    let armed = false;
    const before = effects;
    const history = await service.manage(
      { operation: "workflowRuns.list", input: { app: plugin } },
      ownerContext,
    );
    authorizationWait = async (input) => {
      if (input.operation === (path === "cloud" ? "resumeInvocation" : "resourcesUpdate"))
        armed = true;
      if (armed && input.operation === "resolve" && input.plugin === targetPlugin) {
        armed = false;
        entered.resolve();
        await deadline(released.promise, "Account resolution was never released");
      }
    };
    const sent =
      path === "cloud"
        ? call(caller, "plugin_call", {
            calls: { path: toolPath, input: { amount: 1 } },
          })
        : call(caller, "opensteer_plugin_resource_update", {
            pluginId: plugin,
            change: { action: "workflow.start", workflow: "quick", input: {}, key: randomUUID() },
          });
    const outcome = sent.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await deadline(
        Promise.race([
          entered.promise,
          outcome.then((value) => {
            throw new Error(`Call ended before account resolution: ${JSON.stringify(value)}`);
          }),
        ]),
        "Call did not reach post-check account resolution",
      );
      await store.updateThreadAccessMode({
        threadId: caller.thread.id,
        requestedBy: personal.userId,
        accessMode: "approval-required",
      });
      released.resolve();
      const result = await deadline(outcome, "Narrowed call did not end");
      if (path === "cloud") {
        expect(result).not.toMatchObject({
          value: { result: { execution: { value: { ok: true } } } },
        });
        expect(effects).toBe(before);
      } else {
        expect(result).toHaveProperty("error");
        expect(
          await service.manage(
            { operation: "workflowRuns.list", input: { app: plugin } },
            ownerContext,
          ),
        ).toEqual(history);
      }
    } finally {
      authorizationWait = undefined;
      released.resolve();
      await outcome;
    }
  },
);

test("workflow history projects metadata when a plugin turns off before the engine handles the read", async () => {
  const caller = await run("full-access");
  await call(caller, "opensteer_plugin_resource_update", {
    pluginId: plugin,
    change: { action: "workflow.start", workflow: "quick", input: {}, key: randomUUID() },
  });
  const read = () => call(caller, "plugin_resources", { pluginId: plugin, resource: "workflows" });
  await vi.waitFor(
    async () => {
      expect(await read(), "The completed workflow output was never available").toMatchObject({
        items: [{ status: "complete", output: { preview: '"done"', truncated: false } }],
      });
    },
    { timeout: 10_000 },
  );
  const original = authority.authorize.bind(authority);
  const authorize = vi.spyOn(authority, "authorize").mockImplementation(async (input, signal) => {
    if (input.operation === "resourcesRead" && input.plugin === plugin)
      await records.setAccess(personal.userId, plugin, "off");
    return original(input, signal);
  });
  try {
    // A background authorization can arrive before the resource read.
    await authority.authorize({ ...ownerContext, operation: "background", plugin });
    const history = await read();
    expect(history.items).toEqual([expect.objectContaining({ status: "complete" })]);
    expect(history.items).toEqual([expect.not.objectContaining({ output: expect.anything() })]);
  } finally {
    authorize.mockRestore();
  }
});

test("new plugin tools enforce their caller and standing-access matrix", async () => {
  const connections = new AgentConnectionStore(database);
  const connection = await connections.create({
    userId: personal.userId,
    label: "Matrix",
    clientName: "Fixture",
    accessMode: "full-access",
    resource: "http://127.0.0.1/mcp",
    expiresAt: new Date(Date.now() + 60000),
  });
  await connections.activate(connection.id, "matrix-token-hash");
  const callers: AgentCaller[] = [
    await run("full-access"),
    await run("approval-required"),
    await program("trigger", "full-access"),
    await program("watch", "full-access"),
    {
      kind: "connection",
      key: `connection:${connection.id}`,
      userId: personal.userId,
      accessMode: "full-access",
      connectionId: connection.id,
    },
  ];
  const started = z.object({ id: z.string() }).parse(
    await call(callers[0]!, "opensteer_plugin_resource_update", {
      pluginId: plugin,
      change: { action: "workflow.start", workflow: "quick", input: {}, key: randomUUID() },
    }),
  );
  await vi.waitFor(
    async () =>
      expect(
        await service.manage(
          { operation: "workflowRuns.get", input: { app: plugin, run: started.id } },
          ownerContext,
        ),
      ).toMatchObject({ status: "complete" }),
    { timeout: 10000 },
  );
  for (const access of ["all", "read-only", "off"] as const) {
    await records.setAccess(personal.userId, plugin, access);
    for (const caller of callers) {
      const catalog = call(caller, "opensteer_plugin_catalog", { search: "fixture" });
      if (caller.kind === "program") await expect(catalog).rejects.toThrow();
      else await expect(catalog).resolves.toHaveProperty("items");
      const skills = call(caller, "plugin_skills", { app: "fixture", name: "demo" });
      if (access === "off") await expect(skills).rejects.toThrow();
      else expect(JSON.stringify(await skills)).toContain("Fixture skill");
      const resources = call(caller, "plugin_resources", {
        pluginId: plugin,
        resource: "workflows",
      });
      if (caller.kind === "program") await expect(resources).rejects.toThrow();
      else {
        // Outputs reach the person's own agent; a connection, or any caller while off, reads
        // only what ran, when and how it ended.
        const items = z
          .array(z.object({ id: z.string() }).passthrough())
          .parse(record.parse(await resources).items);
        const run = items.find(({ id }) => id === started.id);
        expect(run).toMatchObject({ status: "complete" });
        if (caller.kind === "run" && access !== "off")
          expect(run?.output).toEqual({ preview: '"done"', truncated: false });
        else expect(items.filter((item) => "output" in item || "failure" in item)).toEqual([]);
      }
      const update = call(caller, "opensteer_plugin_resource_update", {
        pluginId: plugin,
        change: { action: "workflow.start", workflow: "quick", input: {}, key: randomUUID() },
      });
      if (caller.kind === "run" && caller.accessMode === "full-access" && access === "all")
        await expect(update).resolves.toHaveProperty("id");
      else await expect(update).rejects.toThrow();
    }
  }
});
