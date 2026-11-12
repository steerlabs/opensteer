import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventId, Request, RequestResponse } from "@opensteer/core";
import { IntegrationPlatformStore } from "@opensteer/database";
import { LocalMcpServers } from "@opensteer/runner";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { testRpcData } from "../server/test-host-api-request.js";
import {
  connectComputerAppMachine,
  integrationGateway,
  operation,
  toolText,
} from "../runtime/computer-apps.test-support.js";
import {
  connectCallerMachine,
  createMachineAccessDatabase,
  dispatchCallerRun,
  startPrivateMachineHost,
  type MachineAccessHost,
} from "../integrations/personal-machine.test-support.js";
import { IntegrationPlatformService } from "./integration-platform-service.js";
import { createHostRuntime } from "../runtime/runtime.js";
import { ownTestDatabaseProducer } from "@opensteer/database/test-support/database";

const baseDatabaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
// Requires the run-owned PostgreSQL server supplied by the integration launcher.
const integration = baseDatabaseUrl ? describe : describe.skip;
let database: Awaited<ReturnType<typeof createMachineAccessDatabase>>;
const closers: (() => Promise<unknown>)[] = [];

integration("input from a computer's MCP server", () => {
  beforeAll(async () => {
    database = await createMachineAccessDatabase(baseDatabaseUrl ?? "");
  }, 120_000);
  afterAll(async () => {
    await database?.drop();
  }, 120_000);
  beforeEach(async () => {
    undefined;
  });
  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
    vi.restoreAllMocks();
  }, 60_000);

  it("delivers secret fields to the server, redacting rows, commands, events and the agent result", async () => {
    const s = await scenario();
    const answer = bounded(
      s.gateway.callRaw("integration_call", { ...s.address, arguments: {} }),
      "The MCP call did not return after input",
    );
    const request = await pendingInput(s.host);
    expect(request).toMatchObject({
      kind: "integration.input",
      mode: "durable",
      originatingRunId: s.run.runId,
      originatingThreadId: s.run.threadId,

      requestedBy: s.host.ownerId,
      requiredActor: "requester",
      payload: {
        kind: "integration.input",
        installationId: s.callable.installation.id,
        serverId: s.callable.server.id,
      },
      presentation: {
        kind: "form",
        title: "pairing-fixture",
        agentProposed: true,
        detail: expect.stringMatching(/^From its plugin on .+\n\nEnter the code shown on your TV$/),
      },
    });
    if (request.presentation.kind !== "form") throw new Error("Expected a secret form");
    expect(request.presentation.fields).toHaveLength(5);
    expect(request.presentation.fields.every((field) => field.secret)).toBe(true);
    if (!s.caller.run) throw new Error("The calling Run was not captured");
    await expect(
      s.host.store.requests.settleIntegrationInput({
        requestId: request.id,
        resolvedBy: s.host.ownerId,
        action: "accept",
        caller: { ...s.caller.run, bindingGeneration: s.caller.run.bindingGeneration + 1 },
      }),
    ).rejects.toThrow("stale or invalid binding");
    await expect(
      respond(s.host, request, { kind: "form", answers: { code: ["Q!Z?"], count: ["1.5"] } }),
    ).rejects.toThrow("does not match");
    // Non-hex code, >12-digit integer and negative decimal cannot occur in IDs/timestamps.
    await respond(s.host, request, {
      kind: "form",
      answers: {
        code: ["Q!Z?"],
        count: ["6723672367236723"],
        enabled: ["true"],
        ratio: ["-13.75"],
        room: ["Living room"],
      },
    });
    const result = await answer;
    expect(result.structuredContent).toHaveProperty("****", "paired");
    const raw = result.structuredContent ?? result;
    expect(raw).toMatchObject({
      matched: "yes",
      received: {
        code: "****",
        count: "****************",
        enabled: "****",
        ratio: "******",
        room: "***********",
      },
    });
    for (const secret of ["Q!Z?", "6723672367236723", "-13.75", "Living room"])
      expect(JSON.stringify(result)).not.toContain(secret);
    const saved = await s.host.store.requests.get(request.id);
    expect(saved).toMatchObject({
      status: "fulfilled",
      response: {
        kind: "form",
        answers: { code: [], count: [], enabled: [], ratio: [], room: [] },
      },
    });
    await assertNoAnswers(s.host, request, ["Q!Z?", "6723672367236723", "-13.75"]);
  }, 60_000);

  it("redacts accepted values from later presentations, results and errors on the reused client", async () => {
    const s = await scenario();
    const first = bounded(
      s.platform.callTool(s.callable, {}, s.caller),
      "First pairing did not finish",
    );
    await respond(s.host, await pendingInput(s.host), {
      kind: "form",
      answers: {
        code: ["Q!Z?"],
        count: ["6723672367236723"],
        enabled: ["true"],
        ratio: ["-13.75"],
        room: ["Living room"],
      },
    });
    await first;
    for (const mode of ["echo", "error"]) {
      const result = await bounded(
        s.platform.callTool(s.callable, { mode }, s.caller),
        "Later call did not finish",
      );
      expect(JSON.stringify(result)).toContain("****");
      expect(JSON.stringify(result)).not.toContain("Q!Z?");
    }
    const later = bounded(
      s.platform.callTool(s.callable, { mode: "repeat" }, s.caller),
      "Later input did not finish",
    );
    const request = await pendingInput(s.host);
    expect(JSON.stringify(request.presentation)).not.toContain("Q!Z?");
    await respond(s.host, request, { kind: "choice", optionId: "decline" });
    await later;
    const events = await s.host.store.database
      .selectFrom("deploymentEvents")
      .selectAll()
      .where("threadId", "=", s.run.threadId)
      .execute();
    expect(JSON.stringify(events)).not.toContain("Q!Z?");
  }, 60_000);

  it.each(["decline", "cancel"] as const)(
    "returns %s without a continuation",
    async (action) => {
      const s = await scenario();
      const result = bounded(
        s.platform.callTool(s.callable, {}, s.caller),
        `The server did not receive ${action}`,
      );
      const request = await pendingInput(s.host);
      await respond(s.host, request, { kind: "choice", optionId: action });
      expect(toolText(await result)).toBe(action);
      expect(await s.host.store.requests.get(request.id)).toMatchObject({ status: "declined" });
      expect(
        await s.host.store.database
          .selectFrom("requestContinuations")
          .selectAll()
          .where("requestId", "=", request.id)
          .execute(),
      ).toEqual([]);
    },
    60_000,
  );

  it("declines callers without a Run and engines without long holds", async () => {
    const s = await scenario(false);
    const noRun = await bounded(
      s.platform.callTool(s.callable, {}, { threadId: s.run.threadId, run: null }),
      "A non-Run call did not decline",
    );
    expect(toolText(noRun)).toContain("decline");
    expect(toolText(noRun)).toContain("single active call from a Run");
    const short = await bounded(
      s.platform.callTool(s.callable, {}, s.caller),
      "A short-hold engine did not decline",
    );
    expect(toolText(short)).toContain("decline");
    expect(toolText(short)).toContain("cannot wait for device input");
    expect(
      await s.host.store.database
        .selectFrom("requests")
        .select("id")
        .where("kind", "=", "integration.input")
        .execute(),
    ).toEqual([]);
  }, 60_000);

  it("cancels input when its call is aborted and rejects a late answer", async () => {
    const s = await scenario();
    const cancel = new AbortController();
    const result = bounded(
      s.platform.callTool(s.callable, {}, s.caller, cancel.signal),
      "The aborted call did not return",
    );
    const request = await pendingInput(s.host);
    cancel.abort();
    await result;
    expect(await s.host.store.requests.get(request.id)).toMatchObject({
      status: "cancelled",
      cancellationReason: "source-closed",
    });
    await expect(
      respond(s.host, request, { kind: "form", answers: { code: ["Q!Z?"] } }),
    ).rejects.toThrow("no longer pending");
    // Keep old marker collisions in the full scan of unrelated IDs and timestamps.
    await s.host.store.database
      .updateTable("deploymentEvents")
      .set({
        eventId: "evt_f1867319-d42f-4d69-b727-5a8d77c76723" as EventId,
        createdAt: new Date("2026-11-07T14:32:13.750Z"),
      })
      .where("threadId", "=", s.run.threadId)
      .where("type", "=", "request.opened")
      .returning("eventId")
      .executeTakeFirstOrThrow();
    expect((await s.host.store.requests.get(request.id))?.response).toBeNull();
    await assertNoAnswers(s.host, request, ["Q!Z?", "6723672367236723", "-13.75"]);
  }, 60_000);

  it("keeps the upstream call open beyond its original deadline while input is pending", async () => {
    const s = await scenario();
    try {
      await bounded(
        Promise.resolve().then(async () => {
          vi.useFakeTimers({
            toFake: ["setTimeout", "clearTimeout"],
            shouldClearNativeTimers: true,
          });
          const result = s.platform.callTool(s.callable, {}, s.caller);
          const request = await pendingInput(s.host);
          await vi.advanceTimersByTimeAsync(61_000);
          expect(
            await s.host.store.requests.get(request.id),
            "Waiting input must extend the tool call past one minute",
          ).toMatchObject({ status: "pending" });
          await respond(s.host, request, { kind: "choice", optionId: "decline" });
          expect(toolText(await result)).toBe("decline");
        }),
        "The extended MCP call did not settle",
      );
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);

  it("cancels input when the session closes or the Run ends", async () => {
    const s = await scenario();
    const result = bounded(
      s.platform.callTool(s.callable, {}, s.caller),
      "The disconnected session did not finish",
    );
    const request = await pendingInput(s.host);
    await s.computer.disconnectModule();
    await result;
    expect(await s.host.store.requests.get(request.id)).toMatchObject({
      status: "cancelled",
      cancellationReason: "source-closed",
    });
    await s.computer.reconnectModule();
    const second = bounded(
      s.platform.callTool(s.callable, {}, s.caller),
      "The ended Run did not release its input",
    );
    const next = await pendingInput(s.host);
    await s.run.complete();
    await second;
    expect(await s.host.store.requests.get(next.id)).toMatchObject({
      status: "cancelled",
      cancellationReason: "run-ended",
    });
  }, 60_000);

  it("declines ambiguous calls and unsupported schemas and modes", async () => {
    const s = await scenario();
    const waiting = bounded(
      s.platform.callTool(s.callable, {}, s.caller),
      "The original call was stranded",
    );
    const request = await pendingInput(s.host);
    const ambiguous = await bounded(
      s.platform.callTool(s.callable, {}, s.caller),
      "An ambiguous call did not decline",
    );
    expect(toolText(ambiguous)).toContain("single active call from a Run");
    await respond(s.host, request, { kind: "choice", optionId: "decline" });
    await waiting;
    for (const mode of ["array", "large", "optional"]) {
      const result = await bounded(
        s.platform.callTool(s.callable, { mode }, s.caller),
        `Unsupported ${mode} input did not decline`,
      );
      expect(toolText(result)).toContain("decline");
      if (mode === "optional")
        expect(toolText(result)).toContain("Every device input field must be required");
    }
    // The SDK client refuses URL mode, which it was never offered, and forms outside the
    // elicitation schema before Opensteer's handler runs; no Request opens for them.
    for (const mode of ["nested", "url"]) {
      const result = await bounded(
        s.platform.callTool(s.callable, { mode }, s.caller),
        `Unsupported ${mode} input was not refused`,
      );
      expect(toolText(result)).toContain("could not complete");
    }
    expect(
      await s.host.store.database
        .selectFrom("requests")
        .select("id")
        .where("status", "=", "pending")
        .where("kind", "=", "integration.input")
        .execute(),
    ).toEqual([]);
  }, 60_000);

  it("cancels a stranded Request during Host startup", async () => {
    const s = await scenario();
    const orphan = await s.host.store.requests.create({
      callId: randomUUID(),
      kind: "integration.input",
      mode: "durable",
      originatingRunId: s.run.runId,
      originatingThreadId: s.run.threadId,

      payload: {
        kind: "integration.input",
        installationId: s.callable.installation.id,
        serverId: s.callable.server.id,
      },
      presentation: {
        kind: "form",
        title: "TV",
        fields: [{ id: "code", prompt: "Code", secret: true, multiSelect: false }],
      },
      requiredActor: "requester",
      requestedBy: s.host.ownerId,
    });
    await s.host.runtime.close();
    const restarted = await ownTestDatabaseProducer(database.url, async () => {
      const runtime = await createHostRuntime(s.host.config, { logger: false });
      if (runtime.kind !== "personal") {
        await runtime.close();
        throw new Error("Expected Personal Host");
      }
      return runtime;
    });
    closers.push(() => restarted.close());
    await restarted.listen();
    expect(await restarted.store.requests.get(orphan.request.id)).toMatchObject({
      status: "cancelled",
      cancellationReason: "source-closed",
    });
  }, 60_000);
});

async function scenario(longRequestHold = true) {
  const work = await mkdtemp(join(tmpdir(), "opensteer-integration-input-"));
  closers.push(() => rm(work, { recursive: true, force: true }));
  const plugin = await pluginFixture(work);
  const host = await startPrivateMachineHost(database.url, { remoteAccess: true });
  closers.push(() => host.close());
  const caller = await connectCallerMachine(host, {
    name: "Caller",
    longRequestHold,
    token: await host.hostingRunnerEnrollmentToken,
  });
  closers.push(() => caller.close());
  const localMcp = new LocalMcpServers({ stateDirectory: join(work, "runner-state") });
  const computer = await connectComputerAppMachine(host, [], { desktop: { localMcp } });
  closers.push(() => computer.close());
  await dispatch(host, {
    type: "plugin.install",
    input: { directory: plugin, runnerId: computer.runnerId },
  });
  const store = new IntegrationPlatformStore(host.store.database);
  let setupId: string | undefined;
  await vi.waitFor(
    async () => {
      const requests = await store.listComputerAppSetupRequests(host.ownerId);
      setupId = requests.find((row) => row.kind === "server")?.id;
      expect(setupId, "The plugin's launch approval did not open").toBeDefined();
    },
    { timeout: 10_000 },
  );
  expect(
    await computer.answer(setupId!, { setupRequestId: setupId!, kind: "allow" }),
  ).toMatchObject({ kind: "allowed" });
  await vi.waitFor(
    async () => {
      expect(
        await host.store.database
          .selectFrom("integrationServers")
          .select(["status", "statusDetail"])
          .executeTakeFirst(),
        "The plugin's MCP server was not discovered",
      ).toMatchObject({ status: "active" });
    },
    { timeout: 10_000 },
  );
  const server = await host.store.database
    .selectFrom("integrationServers")
    .selectAll()
    .executeTakeFirstOrThrow();
  const run = await dispatchCallerRun(host, caller, { key: "pair", title: "Pair the TV" });
  await dispatch(host, {
    type: "integration.grant.create",
    input: {
      access: "read-write",
      alias: "TV",
      connectionId: null,
      installationId: server.installationId,
      isDefault: true,
    },
  });
  const gateway = await integrationGateway(run.integrationTools);
  closers.push(() => gateway.close());
  const search = await gateway.call("integration_search", { query: "pairing" });
  const captured = vi.spyOn(IntegrationPlatformService.prototype, "callTool");
  await bounded(
    gateway.callRaw("integration_call", { ...operation(search, "ping").address, arguments: {} }),
    "The fixture's ping did not return",
  );
  const platform = captured.mock.contexts.at(-1);
  if (!(platform instanceof IntegrationPlatformService))
    throw new Error("The integration gateway did not reach the platform");
  const toolCaller = captured.mock.calls.at(-1)![2];
  const callable = (
    await platform.listCallableTools({
      ownerUserId: host.ownerId,
      threadId: run.threadId,
    })
  ).find((entry) => entry.tool.name === "pair")!;
  if (!callable) throw new Error("No pairing tool was discovered");
  captured.mockRestore();
  return {
    host,
    run,
    gateway,
    platform,
    caller: toolCaller,
    callable,
    computer,
    address: operation(search, "pair").address,
  };
}

async function pendingInput(host: MachineAccessHost): Promise<Request> {
  let found: Request | null = null;
  await vi.waitFor(
    async () => {
      const row = await host.store.database
        .selectFrom("requests")
        .select("id")
        .where("kind", "=", "integration.input")
        .where("status", "=", "pending")
        .executeTakeFirst();
      found = row ? await host.store.requests.get(row.id) : null;
      expect(found, "The MCP server did not open an input Request").not.toBeNull();
    },
    { timeout: 10_000 },
  );
  return found!;
}

function dispatch(host: MachineAccessHost, command: Record<string, unknown>) {
  return testRpcData(
    host.origin,
    "commands.dispatch",
    { ...command, idempotencyKey: randomUUID() } as never,
    { headers: host.ownerHeaders },
  );
}
function respond(host: MachineAccessHost, request: Request, response: RequestResponse) {
  return dispatch(host, { type: "request.respond", requestId: request.id, response });
}
function bounded<T>(promise: Promise<T>, message: string) {
  return withTimeout(promise, 15_000, { timeoutError: () => new Error(message) });
}
async function assertNoAnswers(
  host: MachineAccessHost,
  request: Request,
  secrets: readonly string[],
) {
  const rows = await host.store.database
    .selectFrom("requests")
    .selectAll()
    .where("id", "=", request.id)
    .execute();
  const events = await host.store.database
    .selectFrom("deploymentEvents")
    .selectAll()
    .where("threadId", "=", request.originatingThreadId)
    .execute();
  const commands = await host.store.database
    .selectFrom("commands")
    .selectAll()
    .where("threadId", "=", request.originatingThreadId)
    .execute();
  const history = await host.store.database
    .selectFrom("threadInputs")
    .selectAll()
    .where("threadId", "=", request.originatingThreadId)
    .execute();
  for (const secret of secrets)
    expect(JSON.stringify({ rows, events, commands, history })).not.toContain(secret);
  expect(events.filter((event) => event.type === "request.opened")).toHaveLength(1);
  expect(
    await host.store.database
      .selectFrom("requestContinuations")
      .selectAll()
      .where("requestId", "=", request.id)
      .execute(),
  ).toEqual([]);
}

async function pluginFixture(work: string) {
  const plugin = join(work, "plugin");
  await mkdir(plugin);
  const require = createRequire(import.meta.url);
  const sdk = (path: string) =>
    JSON.stringify(require.resolve(`@modelcontextprotocol/sdk/${path}`));
  await writeFile(
    join(plugin, "plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "pairing-fixture",
    }),
  );
  await writeFile(
    join(plugin, "mcp.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { tv: { type: "stdio", command: "node", args: ["${PLUGIN_ROOT}/server.cjs"] } },
    }),
  );
  await writeFile(
    join(plugin, "server.cjs"),
    `
const { Server } = require(${sdk("server/index.js")});
const { StdioServerTransport } = require(${sdk("server/stdio.js")});
const { CallToolRequestSchema, ListToolsRequestSchema, ElicitResultSchema } = require(${sdk("types.js")});
const server = new Server({ name: "pairing-fixture", version: "1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ["ping", "pair"].map(name => ({ name, description: name, annotations: { readOnlyHint: true }, inputSchema: { type: "object" } })) }));
let acceptedCode;
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  if (params.name === "ping") return { content: [{ type: "text", text: "ready" }] };
  const mode = params.arguments?.mode;
  if (mode === "echo") return { content: [{ type: "text", text: acceptedCode }] };
  if (mode === "error") throw new Error("Failed " + acceptedCode);
  let properties = { code: { type: "string", title: "Pairing code", minLength: 4, maxLength: 4 }, count: { type: "integer" }, enabled: { type: "boolean" }, ratio: { type: "number" }, room: { type: "string", enum: ["Living room", "Den"] } };
  if (mode === "array") properties = { codes: { type: "array", items: { type: "string", enum: ["one"] } } };
  if (mode === "nested") properties = { code: { type: "object", properties: { value: { type: "string" } } } };
  if (mode === "large") properties = Object.fromEntries(Array.from({ length: 17 }, (_, i) => ["field" + i, { type: "string" }]));
  const input = mode === "url" ? { mode: "url", message: "Sign in", url: "https://example.test/pair", elicitationId: "pair" }
    : { message: "Enter the code shown on your TV", requestedSchema: { type: "object", properties, required: Object.keys(properties) } };
  if (mode === "optional") input.requestedSchema.required = ["code"];
  if (mode === "repeat") { input.message += acceptedCode; input.requestedSchema.properties = { next: { type: "string", title: "Repeat " + acceptedCode, description: "Previous " + acceptedCode } }; input.requestedSchema.required = ["next"]; }
  const options = { timeout: 180000, maxTotalTimeout: 180000 };
  const result = mode === "url"
    ? await server.request({ method: "elicitation/create", params: input }, ElicitResultSchema, options)
    : await server.elicitInput(input, options);
  if (result.action !== "accept") return { content: [{ type: "text", text: result.action + (result._meta ? " " + JSON.stringify(result._meta) : "") }] };
  acceptedCode = result.content.code;
  const matched = JSON.stringify(result.content) === JSON.stringify({ code: "Q!Z?", count: 6723672367236723, enabled: true, ratio: -13.75, room: "Living room" });
  return { content: [{ type: "text", text: "accepted " + JSON.stringify(result.content) }], structuredContent: { [result.content.code]: "paired", matched: matched ? "yes" : "no", received: result.content } };
});
server.connect(new StdioServerTransport());
`,
  );
  return plugin;
}
