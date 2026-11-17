import { beforeAll, afterAll, afterEach, test, expect, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { z } from "zod";
import {
  createId,
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
import {
  createPersonalRunFixturePort,
  startPersonalQueuedRunFixture,
} from "../packages/database/src/personal-run-fixture.test-support.js";
import { AgentHomeFiles } from "../apps/host/src/threads/agent-home-files.js";
import { withFolderPluginPackage } from "../apps/host/src/integrations/folder-plugin-package.js";
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
let current: AgentCaller;
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
async function call(caller: AgentCaller, name: string, input: unknown, held = false) {
  current = caller;
  const result = held
    ? await mcp.callToolResult("token", name, input, {
        operationKey: randomUUID(),
        caller,
        longRequestHold: false,
      })
    : await mcp.callTool("token", name, input, { operationKey: randomUUID(), caller });
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
  authority = new PluginAuthority({ store, settings: records, owner: async () => personal.userId });
  registry = await pluginFixtureRegistry(directory, undefined, pluginFixtureFiles(1));
  homeFiles = new AgentHomeFiles({
    agentHome: async () => personal.agentHome,
    helperPath: new URL("../apps/runner/native-fs-helper/opensteer-native-fs-test", import.meta.url)
      .pathname,
  });
  service = new PluginService({
    limits: { interactionTtlMs: 5000 },
    deployment: "personal",
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
    authorize: (input) => authority.authorize(input),
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
          content: file.content.replace(
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
  await records.recordInstall(personal.userId, plugin, installed.version.id, "agent");
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
    exportFiles: async (_c, d, f) =>
      exportPluginSource(
        directory,
        d,
        f.files,
        new URL("../apps/runner/native-fs-helper/opensteer-native-fs-test", import.meta.url)
          .pathname,
      ),
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

async function program(kind: "trigger" | "watch"): Promise<AgentCaller> {
  const owner = await run("approval-required");
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

test("read-only hides and refuses writes; off hides the plugin from discovery and list", async () => {
  const caller = await run();
  await records.setAccess(personal.userId, plugin, "read-only");
  expect(await call(caller, "plugin_search", {})).toMatchObject({
    items: expect.arrayContaining([expect.objectContaining({ path: "tools.fixture.read" })]),
  });
  expect(JSON.stringify(await call(caller, "plugin_search", {}))).not.toContain(
    "tools.fixture.reviewed",
  );
  const refused = await call(caller, "plugin_call", {
    calls: { path: "tools.fixture.reviewed", input: { amount: 2 } },
  });
  expect(refused).toMatchObject({
    status: "completed",
    result: { execution: { value: { ok: false } } },
  });
  await records.setAccess(personal.userId, plugin, "off");
  expect(await call(caller, "plugin_search", {})).toMatchObject({ items: [] });
  expect(await call(caller, "opensteer_plugin_list", {})).toEqual({ plugins: [] });
});

test("an ask-mode held write returns the actual result after the person approves", async () => {
  const caller = await run();
  const work = call(
    caller,
    "plugin_call",
    { calls: { path: "tools.fixture.reviewed", input: { amount: 7 } } },
    true,
  );
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

test("declining a held approval returns a refusal without executing the approved mutation", async () => {
  const caller = await run("auto-accept-edits");
  const work = call(
    caller,
    "plugin_call",
    { calls: { path: "tools.fixture.reviewed", input: { amount: 4 } } },
    true,
  );
  const request = await pendingRequest(caller);
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

test("turning access off refuses both answer delivery and later resume", async () => {
  const caller = await run();
  const result = await call(caller, "plugin_call", {
    calls: { path: "tools.fixture.reviewed", input: { amount: 1 } },
  });
  await records.setAccess(personal.userId, plugin, "off");
  await expect(answer(z.custom<RequestId>().parse(result.requestId))).rejects.toThrow();
  await expect(
    call(caller, "plugin_resume", { executionId: result.executionId }),
  ).rejects.toThrow();
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
  const first = await call(caller, "opensteer_plugin_install", {
    source: "folder",
    directory: folder,
    name: "Draft",
  });
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

test("installs a catalog plugin without asking the person", async () => {
  const caller = await run("full-access");
  expect(
    await call(caller, "opensteer_plugin_install", { source: "catalog", catalogId: "fixture" }),
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
    expect(await store.requests.get(z.custom<RequestId>().parse(result.requestId))).toMatchObject({
      status: "cancelled",
      cancellationReason: "plugin-interrupted",
    });
    expect(await call(caller, "plugin_resume", { executionId: result.executionId })).toMatchObject({
      status: "interrupted",
      next: expect.stringContaining("never rerun"),
    });
  }
}, 30000);
