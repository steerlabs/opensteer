import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { LocalMcpServers } from "@opensteer/runner";
import type { RequestId } from "@opensteer/core";
import { testRpcData } from "../server/test-host-api-request.js";
import {
  connectComputerAppMachine,
  integrationGateway,
  pluginPath,
} from "../runtime/computer-apps.test-support.js";
import {
  connectCallerMachine,
  createMachineAccessDatabase,
  dispatchCallerRun,
  resetMachineAccessDatabase,
  startMachineAccessWireHost,
  type MachineAccessHost,
} from "../runtime/machine-access-protocol.test-support.js";

const baseDatabaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
// Needs the PostgreSQL that `pnpm test:integration` provides.
const integration = baseDatabaseUrl ? describe : describe.skip;
let database: Awaited<ReturnType<typeof createMachineAccessDatabase>> | undefined;
let databaseUrl = "postgres://unconfigured";

integration("local servers as plugin tools", () => {
  beforeAll(async () => {
    database = await createMachineAccessDatabase(baseDatabaseUrl ?? "");
    databaseUrl = database.url;
  }, 120_000);
  afterAll(async () => {
    await database?.drop();
  }, 120_000);
  beforeEach(async () => resetMachineAccessDatabase(databaseUrl));
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close().catch(() => undefined);
  }, 60_000);

  it("is registered by an agent, approved by the owner, asks each caller its own question and is removed with its data", async () => {
    const work = await mkdtemp(join(tmpdir(), "opensteer-local-server-tools-"));
    closers.push(() => rm(work, { recursive: true, force: true }));
    const server = await pairingServer(work);
    const host = await startMachineAccessWireHost(databaseUrl, {
      remoteAccess: true,
      manualRunner: true,
    });
    closers.unshift(() => host.close());
    const caller = await connectCallerMachine(host, {
      name: "Caller",
      token: host.hostingRunnerEnrollmentToken,
    });
    closers.unshift(() => caller.close());
    const localMcp = new LocalMcpServers({ stateDirectory: join(work, "runner-state") });
    const computer = await connectComputerAppMachine(host, [], { desktop: { localMcp } });
    closers.unshift(() => computer.close());
    const first = await dispatchCallerRun(host, caller, { key: "pair-a", title: "Pair the TV" });
    closers.unshift(() => first.complete());
    const gateway = await integrationGateway(first.integrationTools);
    closers.unshift(() => gateway.close());

    // The agent registers the server on the Mac; nothing runs until its owner approves.
    const added = await gateway.call("local_server_add", {
      name: "tv",
      computerId: computer.runnerId,
      launch: { command: "node", args: [server] },
      device: { name: "Living room TV", kind: "tv" },
    });
    expect(added).toMatchObject({
      server: { name: "tv", path: "tools.tv", kind: "program", state: "waiting" },
    });
    const setup = await vi.waitFor(
      async () => {
        const row = await host.store.database
          .selectFrom("computerAppSetupRequests")
          .select("id")
          .where("kind", "=", "server")
          .executeTakeFirst();
        expect(row, "The launch approval did not open").toBeDefined();
        return row!;
      },
      { timeout: 10_000 },
    );
    expect(
      await computer.answer(setup.id, { setupRequestId: setup.id, kind: "allow" }),
    ).toMatchObject({ kind: "allowed" });
    const installation = await vi.waitFor(
      async () => {
        const row = await host.store.database
          .selectFrom("integrationServers")
          .select(["installationId", "status"])
          .executeTakeFirst();
        expect(row?.status, "The approved server was not discovered").toBe("active");
        return row!;
      },
      { timeout: 15_000 },
    );
    await dispatch(host, {
      type: "integration.grant.create",
      input: {
        access: "read-write",
        alias: "TV",
        connectionId: null,
        installationId: installation.installationId,
        isDefault: true,
      },
    });
    expect(await gateway.call("local_server_list", {})).toMatchObject({
      servers: [{ name: "tv", state: "approved", device: { name: "Living room TV" } }],
    });
    await vi.waitFor(
      async () => {
        const found = await gateway.call("plugin_search", { namespace: "tv" });
        expect(JSON.stringify(found), "The server's tools were not listed").toContain(
          "tools.tv.pair",
        );
      },
      { timeout: 30_000 },
    );
    expect(await pluginPath(gateway, "pair", "pair")).toBe("tools.tv.pair");

    // Two tasks call it at once. Each question reaches the person for its own call only.
    const second = await dispatchCallerRun(host, caller, { key: "pair-b", title: "Pair again" });
    closers.unshift(() => second.complete());
    const otherGateway = await integrationGateway(second.integrationTools);
    closers.unshift(() => otherGateway.close());
    const call = (target: typeof gateway) =>
      target.call("plugin_call", { calls: { path: "tools.tv.pair", input: {} } });
    const callA = call(gateway);
    const askedA = await pendingInput(host);
    const callB = call(otherGateway);
    const answers = (code: string) => ({
      code,
      count: 7,
      enabled: true,
      ratio: 0.25,
      room: "Den",
    });
    expect(askedA.runId).toBe(first.runId);
    await respond(host, askedA.id, answers("AB89"));
    const resultA = await settled(callA, gateway);
    const askedB = await pendingInput(host, askedA.id);
    expect(askedB.runId).toBe(second.runId);
    await respond(host, askedB.id, answers("CD34"));
    const resultB = await settled(callB, otherGateway);
    // The server echoes the code's last digits; answered values themselves are redacted.
    expect(resultA).toMatchObject({
      result: { execution: { value: { value: { digits: "89" } } } },
    });
    expect(resultB).toMatchObject({
      result: { execution: { value: { value: { digits: "34" } } } },
    });
    // Answers reach only the server: no Request or event keeps the code.
    const stored = await host.store.database.selectFrom("requests").selectAll().execute();
    const events = await host.store.database.selectFrom("deploymentEvents").selectAll().execute();
    expect(JSON.stringify([stored, events])).not.toContain("AB89");

    // Removed: its tools are gone and its data removal reaches the Mac.
    await gateway.call("local_server_remove", { name: "tv" });
    expect(await gateway.call("local_server_list", {})).toEqual({ servers: [] });
    const after = await gateway.call("plugin_search", { query: "pair" });
    expect(after.items).toEqual([]);
    expect(
      await host.store.database.selectFrom("integrationServers").select("id").execute(),
    ).toEqual([]);
    // The Mac that ran it deletes its data when it confirms; delivery is the existing removal path.
    expect(
      await host.store.database.selectFrom("runnerPluginDataRemovals").select("runnerId").execute(),
    ).toEqual([{ runnerId: computer.runnerId }]);
  }, 300_000);
});

/** The person's form answer through the same command every client sends. */
function respond(host: MachineAccessHost, requestId: RequestId, content: Record<string, unknown>) {
  return dispatch(host, {
    type: "request.respond",
    requestId,
    response: { kind: "external", value: { action: "accept", content } },
  });
}

/** A held call returns the result; one handed to its task is collected with plugin_resume. */
async function settled(
  call: Promise<Record<string, unknown>>,
  gateway: Awaited<ReturnType<typeof integrationGateway>>,
) {
  const first = await withTimeout(call, 30_000, {
    timeoutError: () => new Error("The plugin call did not return"),
  });
  if (first.status !== "pending") return first;
  return vi.waitFor(
    async () => {
      const resumed = await gateway.call("plugin_resume", { executionId: first.executionId });
      expect(resumed.status, "The answered call did not complete").toBe("completed");
      return resumed;
    },
    { timeout: 20_000 },
  );
}

async function pendingInput(host: MachineAccessHost, after?: RequestId) {
  return vi.waitFor(
    async () => {
      const rows = await host.store.database
        .selectFrom("requests")
        .select(["id", "originatingRunId as runId"])
        .where("kind", "=", "plugin.input")
        .where("status", "=", "pending")
        .execute();
      expect(rows.length, "More than one question is open on a shared session").toBeLessThan(2);
      const row = rows.find(({ id }) => id !== after);
      expect(row, "The server's question did not reach Needs you").toBeDefined();
      return row!;
    },
    { timeout: 20_000 },
  );
}

function dispatch(host: MachineAccessHost, command: Record<string, unknown>) {
  return testRpcData(
    host.origin,
    "commands.dispatch",
    { ...command, idempotencyKey: randomUUID() } as never,
    { headers: host.ownerHeaders },
  );
}

/** A TV's pairing server: each call asks for the code shown on screen and answers with it. */
async function pairingServer(work: string) {
  const require = createRequire(import.meta.url);
  const sdk = (path: string) =>
    JSON.stringify(require.resolve(`@modelcontextprotocol/sdk/${path}`));
  const path = join(work, "server.cjs");
  await writeFile(
    path,
    `
const { Server } = require(${sdk("server/index.js")});
const { StdioServerTransport } = require(${sdk("server/stdio.js")});
const { CallToolRequestSchema, ListToolsRequestSchema } = require(${sdk("types.js")});
const server = new Server({ name: "tv", version: "1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "pair", description: "Pair with the TV", inputSchema: { type: "object" } }] }));
server.setRequestHandler(CallToolRequestSchema, async () => {
  const properties = { code: { type: "string", title: "Pairing code", minLength: 4, maxLength: 4 }, count: { type: "integer" }, enabled: { type: "boolean" }, ratio: { type: "number" }, room: { type: "string", enum: ["Living room", "Den"] } };
  const result = await server.elicitInput({ message: "Enter the code shown on your TV", requestedSchema: { type: "object", properties, required: Object.keys(properties) } }, { timeout: 180000, maxTotalTimeout: 180000 });
  if (result.action !== "accept") return { content: [{ type: "text", text: result.action }] };
  return { content: [{ type: "text", text: "paired" }], structuredContent: { digits: result.content.code.slice(2) } };
});
server.connect(new StdioServerTransport());
`,
  );
  return path;
}
