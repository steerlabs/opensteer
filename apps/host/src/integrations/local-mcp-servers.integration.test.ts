/** Host-owner consent, exact launch binding, Runner execution and teardown on real sockets. */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { IntegrationPlatformStore } from "@opensteer/database";
import type { ComputerAppSetupRequest, LocalMcpLaunch } from "@opensteer/integration-core";
import { localMcpLaunchDigest } from "@opensteer/integration-core/digest";

import { LocalMcpServers, prepareIntegrationsModule, type LocalMcpFrame } from "@opensteer/runner";
import { testRpcData } from "../server/test-host-api-request.js";
import {
  connectComputerAppMachine,
  integrationGateway,
  operation,
  startFakeDesktop,
  toolText,
  toolReadiness,
} from "../runtime/computer-apps.test-support.js";
import {
  connectCallerMachine,
  createMachineAccessDatabase,
  dispatchCallerRun,
  enrollmentToken,
  resetMachineAccessDatabase,
  startMachineAccessHost,
  waitForCondition,
  type MachineAccessHost,
} from "../runtime/machine-access.test-support.js";

const baseDatabaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = baseDatabaseUrl ? describe : describe.skip;
let database: Awaited<ReturnType<typeof createMachineAccessDatabase>> | undefined;
let databaseUrl = "postgres://unconfigured";

integration("MCP servers on a computer", () => {
  beforeAll(async () => {
    database = await createMachineAccessDatabase(baseDatabaseUrl ?? "");
    databaseUrl = database.url;
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
    database = undefined;
  }, 120_000);

  beforeEach(async () => resetMachineAccessDatabase(databaseUrl));

  let closeCurrent: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await closeCurrent?.();
    closeCurrent = undefined;
  }, 60_000);

  it("runs a plugin's server on the Mac its owner approved it on, and nowhere else", async () => {
    const artifactDirectory =
      process.env.OPENSTEER_LOCAL_MCP_E2E_ARTIFACT_DIR ??
      (await mkdtemp(join(tmpdir(), "opensteer-local-mcp-e2e-")));
    const steps: { readonly observed: unknown; readonly step: string }[] = [];
    const record = (step: string, observed: unknown) => steps.push({ observed, step });
    let failure: unknown = null;
    let serverState: (() => Promise<unknown>) | undefined;
    try {
      const work = await mkdtemp(join(tmpdir(), "opensteer-local-mcp-"));
      const fixture = await pluginFixture(work);
      const host = await startMachineAccessHost(databaseUrl, { signupPolicy: "open" });
      // What the Host held for the server, written beside a failure.
      serverState = async () =>
        host.store.database
          .selectFrom("integrationServers")
          .select(["approvedLaunchDigest", "id", "status", "statusDetail"])
          .execute();
      const closers: (() => Promise<void>)[] = [() => host.close()];
      closeCurrent = async () => {
        for (const close of closers) await close().catch(() => undefined);
      };
      const caller = await connectCallerMachine(host, {
        name: "Caller",
        token: await enrollmentToken(host, {
          allowedModules: ["agents"],
          idempotencyKey: "local-mcp-caller",
          name: "Caller",
        }),
      });
      closers.unshift(() => caller.close());
      const desktop = await startFakeDesktop();
      closers.unshift(() => desktop.close());
      const prepare = (dataDirectory: string) => {
        const prepared = prepareIntegrationsModule({
          computerUseBridge: { token: desktop.token, url: desktop.url },
          dataDirectory,
          platform: "darwin",
        });
        const { computerUse, localMcp } = prepared ?? {};
        if (!prepared || !computerUse || !localMcp) {
          throw new Error("A Mac with its desktop runs MCP servers");
        }
        closers.push(async () => computerUse.close());
        return { computerUse, localMcp, providers: prepared.providers };
      };
      const runnerData = join(work, "runner");
      const mac = prepare(runnerData);
      const computer = await connectComputerAppMachine(host, mac.providers, {
        desktop: { computerUse: mac.computerUse, localMcp: mac.localMcp },
      });
      closers.unshift(() => computer.close());

      // 1. Installed, pinned to the Mac, and nothing started anywhere yet.
      const installed = await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          idempotencyKey: "local-mcp-install",
          input: { directory: fixture.plugin, runnerId: computer.runnerId },
          type: "integration.agentPlugin.install",
        },
        { headers: host.ownerHeaders },
      );
      if (installed.type !== "integration.agentPlugin.install") throw new Error("Mismatch");
      const server = await serverRow(host);
      expect(server.transport).toMatchObject({ runnerId: computer.runnerId, type: "runner" });
      expect(server.status).toBe("needs-attention");
      const launch = (server.transport as { readonly launch: LocalMcpLaunch }).launch;
      expect(launch).toMatchObject({ command: "sh", type: "stdio" });
      expect(await readPid(fixture.pidFile)).toBeNull();
      record("installed and waiting", { launch, server: server.id });

      // Review is owner-only; summaries never carry launch secrets.
      const asked = await waitingRequest(host, server.id);
      expect(asked.server?.launch).toEqual(launch);
      expect(asked.definitionDigest).toBe(localMcpLaunchDigest(launch));
      const summaries = await testRpcData(
        host.origin,
        "integration.computer.setup.list",
        {},
        { headers: host.ownerHeaders },
      );
      expect(summaries.requests.find(({ id }) => id === asked.id)?.server).not.toHaveProperty(
        "launch",
      );
      const reviewed = await testRpcData(
        host.origin,
        "integration.computer.setup.review",
        { setupRequestId: asked.id },
        { headers: host.ownerHeaders },
      );
      expect(reviewed.request.server?.launch).toEqual(launch);

      // 3. Approved on the Mac: started there once, and its tools listed.
      const approved = await computer.answer(asked.id, {
        setupRequestId: asked.id,
        kind: "allow",
      });
      expect(approved.kind).toBe("allowed");
      await waitForCondition(async () => (await serverRow(host)).status === "active", 30_000);
      const tools = await host.store.database
        .selectFrom("integrationTools")
        .select("name")
        .where("serverId", "=", server.id)
        .where("status", "=", "active")
        .orderBy("name", "asc")
        .execute();
      expect(tools.map(({ name }) => name)).toEqual([
        "crash",
        "echo",
        "huge",
        "malformed",
        "note",
        "orphan",
        "pid",
        "unframed",
      ]);
      expect(await readPid(fixture.pidFile)).not.toBeNull();
      record("approved and discovered", tools);

      const fence = {
        auxiliaryStreamId: "rax_00000000-0000-4000-8000-000000000000",
        bootId: "rbt_00000000-0000-4000-8000-000000000000",
        connectionGeneration: 1,
        connectionId: "rcn_00000000-0000-4000-8000-000000000000",
        connectionLeaseId: "rls_00000000-0000-4000-8000-000000000000",
        module: "integrations",
        runnerId: computer.runnerId,
      } as const;
      // A spawn error can both reject start() and emit onerror. It still ends
      // one session exactly once, with no spurious opened frame.
      const failedLaunch: LocalMcpLaunch = {
        type: "stdio",
        command: join(work, "missing-program"),
        args: [],
        cwd: work,
        env: {},
      };
      const failedFrames: LocalMcpFrame[] = [];
      const failing = new LocalMcpServers();
      failing.attach(async (frame) => {
        failedFrames.push(frame);
      });
      await failing.open({
        ...fence,
        launch: failedLaunch,
        module: "integrations",
        runnerId: computer.runnerId,
        serverId: server.id,
        sessionId: randomUUID(),
        type: "host.integrations.mcp.open",
      } as Parameters<LocalMcpServers["open"]>[0]);
      await waitForCondition(async () => failedFrames.length > 0);
      expect(failedFrames).toEqual([
        expect.objectContaining({
          type: "runner.integrations.mcp.closed",
          error: expect.objectContaining({ code: "failed" }),
        }),
      ]);
      failing.detach();
      record("failed spawn closed exactly once", failedFrames);

      // 5. A Run's agent reaches the server on the Mac, and back.
      const run = await dispatchCallerRun(host, caller, {
        key: "local-mcp-run",
        title: "Take a note",
      });
      closers.unshift(() => run.complete());
      await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          idempotencyKey: "local-mcp-grant",
          input: {
            access: "read-write",
            alias: "Notes on Studio Mac",
            connectionId: null,
            installationId: server.installationId,
            isDefault: true,
            workspaceId: run.workspaceId,
          },
          type: "integration.grant.create",
        },
        { headers: host.ownerHeaders },
      );
      const gateway = await integrationGateway(run.integrationTools);
      closers.unshift(() => gateway.close());
      const search = () => gateway.call("integration_search", { query: "notes" });
      const call = async (name: string, args: Record<string, unknown>) =>
        gateway.callRaw("integration_call", {
          arguments: args,
          toolRef: operation(await search(), name).toolRef,
        });
      await waitForCondition(
        async () => toolReadiness(await search(), "echo").code === "READY",
        30_000,
      );
      expect(toolText(await call("echo", { text: "hello" }))).toBe("echo: hello");
      expect(toolText(await call("note", { text: "buy milk" }))).toBe("noted");
      expect(await readFile(fixture.notesFile, "utf8")).toBe("buy milk\n");
      record("called through the gateway", { notes: await readFile(fixture.notesFile, "utf8") });

      // 6. Too large for the stream: that call fails, and the next one works.
      const huge = await call("huge", {});
      expect(huge.isError).toBe(true);
      expect(toolText(huge)).toBe(
        "notes-fixture's answer was too large to carry from Studio Mac; ask for less.",
      );
      expect(toolText(await call("echo", { text: "still here" }))).toBe("echo: still here");

      for (const name of ["unframed", "malformed"]) {
        const pid = await readPid(fixture.pidFile);
        if (pid === null) throw new Error("The server is running");
        const started = Date.now();
        const result = await call(name, {});
        expect(result.isError).toBe(true);
        expect(Date.now() - started).toBeLessThan(15_000);
        await waitForCondition(async () => !alive(pid), 5_000);
        expect(toolText(await call("echo", { text: name }))).toBe(`echo: ${name}`);
        record(`${name} output ended its process and session`, {
          elapsedMs: Date.now() - started,
          pid,
          result: toolText(result),
        });
      }

      // 7. A write whose answer was lost is unconfirmed, not failed.
      const crashed = await call("crash", {});
      expect(crashed.isError).toBe(true);
      expect(toolText(crashed)).toBe(
        "Studio Mac did not confirm this. Check whether it happened before trying again.",
      );
      expect(toolText(await call("echo", { text: "again" }))).toBe("echo: again");
      // The program exits cleanly, but a process it started still holds its
      // output: the session ends with the program, well before the call's
      // deadline, and takes that process with it.
      const orphaned = Date.now();
      expect(toolText(await call("orphan", {}))).toBe(
        "Studio Mac did not confirm this. Check whether it happened before trying again.",
      );
      expect(Date.now() - orphaned).toBeLessThan(15_000);
      const orphan = await readPid(`${fixture.pidFile}.orphan`);
      if (orphan === null) throw new Error("The program started a process");
      await waitForCondition(async () => !alive(orphan), 15_000);
      expect(toolText(await call("echo", { text: "after" }))).toBe("echo: after");
      record("large and lost answers", {
        crashed: toolText(crashed),
        huge: toolText(huge),
        orphan,
      });

      // 8. Offline: the program ends, the tools say so, and return with the Mac.
      const running = await readPid(fixture.pidFile);
      if (running === null) throw new Error("The server is running");
      await computer.disconnectModule();
      await waitForCondition(async () => !alive(running), 15_000);
      const offline = toolReadiness(await search(), "echo");
      expect(offline.code).toBe("INTEGRATION_UNAVAILABLE");
      expect(offline.detail).toContain("Studio Mac");
      await computer.reconnectModule();
      await waitForCondition(
        async () => toolReadiness(await search(), "echo").code === "READY",
        30_000,
      );
      expect(toolText(await call("echo", { text: "back" }))).toBe("echo: back");
      record("offline and back", offline);

      // Host-held exact-launch consent survives a fresh Runner instance.
      await computer.disconnectModule();
      const restarted = prepare(join(work, "restarted-runner"));
      await computer.reconnectModule({
        computerUse: restarted.computerUse,
        localMcp: restarted.localMcp,
      });
      await waitForCondition(async () => (await serverRow(host)).status === "active", 30_000);
      expect(
        await host.store.database
          .selectFrom("computerAppSetupRequests")
          .select("id")
          .where("definitionId", "=", server.id)
          .execute(),
      ).toEqual([]);
      // 10. Installed again as it was, twice over, the second while the first
      // is still being listed: still approved, and listed again now.
      for (const key of ["local-mcp-reinstall", "local-mcp-reinstall-again"]) {
        await testRpcData(
          host.origin,
          "commands.dispatch",
          {
            idempotencyKey: key,
            input: { directory: fixture.plugin, runnerId: computer.runnerId },
            type: "integration.agentPlugin.install",
          },
          { headers: host.ownerHeaders },
        );
      }
      await waitForCondition(async () => (await serverRow(host)).status === "active", 30_000);
      expect(toolText(await call("echo", { text: "reinstalled" }))).toBe("echo: reinstalled");
      const reasked = await host.store.database
        .selectFrom("computerAppSetupRequests")
        .select("id")
        .where("kind", "=", "server")
        .execute();
      expect(reasked).toEqual([]);
      record("installed again", { reasked });

      // 11. Installed with a changed launch: what ran ends, and the new launch
      // runs only once the Mac is asked about it and allows it.
      const previous = Number(toolText(await call("pid", {})));
      expect(alive(previous)).toBe(true);
      await fixture.changeLaunch();
      await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          idempotencyKey: "local-mcp-changed",
          input: { directory: fixture.plugin, runnerId: computer.runnerId },
          type: "integration.agentPlugin.install",
        },
        { headers: host.ownerHeaders },
      );
      await waitForCondition(async () => !alive(previous), 15_000);
      const changed = await serverRow(host);
      const changedLaunch = (changed.transport as { readonly launch: LocalMcpLaunch }).launch;
      expect(changedLaunch).not.toEqual(launch);
      expect(changed.status).toBe("needs-attention");
      const askedChanged = await waitingRequest(host, server.id);
      expect(askedChanged.definitionDigest).toBe(localMcpLaunchDigest(changedLaunch));
      expect(
        await host.store.database
          .selectFrom("integrationTools")
          .select("name")
          .where("serverId", "=", server.id)
          .where("status", "=", "active")
          .execute(),
      ).toEqual([]);
      const allowedChange = await computer.answer(askedChanged.id, {
        setupRequestId: askedChanged.id,
        kind: "allow",
      });
      expect(allowedChange.kind).toBe("allowed");
      await waitForCondition(async () => (await serverRow(host)).status === "active", 30_000);
      expect(toolText(await call("echo", { text: "changed" }))).toBe("echo: changed");
      record("installed with a changed launch", { previous, request: askedChanged.id });

      // 12. Uninstalled: nothing waits on the Mac and nothing runs.
      const last = Number(toolText(await call("pid", {})));
      expect(alive(last)).toBe(true);
      await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          idempotencyKey: "local-mcp-uninstall",
          installationId: server.installationId,
          type: "integration.uninstall",
        },
        { headers: host.ownerHeaders },
      );
      await waitForCondition(async () => !alive(last), 15_000);
      const leftover = await host.store.database
        .selectFrom("computerAppSetupRequests")
        .select("id")
        .where("kind", "=", "server")
        .execute();
      expect(leftover).toEqual([]);
      record("uninstalled", { leftover });
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      await mkdir(artifactDirectory, { recursive: true });
      await writeFile(
        join(artifactDirectory, "result.json"),
        `${JSON.stringify(
          {
            failure: failure instanceof Error ? failure.message : failure,
            passed: failure === null,
            servers: failure === null ? undefined : await serverState?.().catch(String),
            steps,
          },
          null,
          2,
        )}\n`,
      );
    }
  }, 240_000);
});

async function serverRow(host: MachineAccessHost) {
  return host.store.database
    .selectFrom("integrationServers")
    .select(["id", "installationId", "status", "statusDetail", "transport"])
    .where(({ ref }) => ref("transport", "->>").key("type"), "=", "runner")
    .executeTakeFirstOrThrow();
}

async function waitingRequest(
  host: MachineAccessHost,
  serverId: string,
): Promise<ComputerAppSetupRequest> {
  let found: ComputerAppSetupRequest | undefined;
  await waitForCondition(async () => {
    const requests = await new IntegrationPlatformStore(
      host.store.database,
    ).listComputerAppSetupRequests(host.ownerId);
    found = requests.find(
      (request) => request.kind === "server" && request.definitionId === serverId,
    );
    return found !== undefined;
  }, 15_000);
  if (!found) throw new Error("The Mac was not asked");
  return found;
}

async function readPid(file: string): Promise<number | null> {
  try {
    return Number((await readFile(file, "utf8")).trim());
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * An Agent Plugin with one stdio MCP server: a program written with the MCP
 * SDK that echoes, appends notes to a file, answers larger than a stream
 * frame, or exits mid-call, and records its process id when it starts.
 */
async function pluginFixture(work: string) {
  const plugin = join(work, "plugin");
  await mkdir(plugin, { recursive: true });
  const require = createRequire(import.meta.url);
  const sdk = (path: string) =>
    JSON.stringify(require.resolve(`@modelcontextprotocol/sdk/${path}`));
  const pidFile = join(work, "server.pid");
  const notesFile = join(work, "notes.txt");
  await writeFile(
    join(plugin, "plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "notes-fixture",
    }),
  );
  const writeLaunch = (env: Record<string, string>) =>
    writeFile(
      join(plugin, "mcp.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: {
          notes: {
            // A launcher, as npx and uvx are: the server is its child, which
            // must end with the session as surely as the launcher does.
            args: ["-c", 'node "$PLUGIN_ROOT/server.cjs"; exit $?'],
            command: "sh",
            env: { NOTES_FILE: notesFile, PID_FILE: pidFile, ...env },
            type: "stdio",
          },
        },
      }),
    );
  await writeLaunch({});
  await writeFile(
    join(plugin, "server.cjs"),
    `const { appendFileSync, writeFileSync } = require("node:fs");
const { Server } = require(${sdk("server/index.js")});
const { StdioServerTransport } = require(${sdk("server/stdio.js")});
const { CallToolRequestSchema, ListToolsRequestSchema } = require(${sdk("types.js")});
writeFileSync(process.env.PID_FILE, String(process.pid));
const text = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };
const server = new Server({ name: "notes-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { annotations: { readOnlyHint: true }, description: "Echo", inputSchema: text, name: "echo" },
    { description: "Append a note", inputSchema: text, name: "note" },
    { annotations: { readOnlyHint: true }, description: "Too big", inputSchema: { type: "object" }, name: "huge" },
    { annotations: { readOnlyHint: true }, description: "Never ends its frame", inputSchema: { type: "object" }, name: "unframed" },
    { annotations: { readOnlyHint: true }, description: "Invalid JSON", inputSchema: { type: "object" }, name: "malformed" },
    { description: "Stop mid-call", inputSchema: { type: "object" }, name: "crash" },
    { annotations: { readOnlyHint: true }, description: "Its process", inputSchema: { type: "object" }, name: "pid" },
    { description: "Exit, leaving a process holding stdout", inputSchema: { type: "object" }, name: "orphan" },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  if (params.name === "echo") return { content: [{ text: "echo: " + params.arguments.text, type: "text" }] };
  if (params.name === "note") {
    appendFileSync(process.env.NOTES_FILE, params.arguments.text + "\\n");
    return { content: [{ text: "noted", type: "text" }] };
  }
  if (params.name === "huge") return { content: [{ text: "x".repeat(1200000), type: "text" }] };
  if (params.name === "unframed" || params.name === "malformed") {
    process.stdout.write(params.name === "unframed" ? "x".repeat(17 * 1024 * 1024) : "not json\\n");
    await new Promise(() => {});
  }
  if (params.name === "crash") process.exit(3);
  if (params.name === "pid") return { content: [{ text: String(process.pid), type: "text" }] };
  if (params.name === "orphan") {
    const child = require("node:child_process").spawn("sleep", ["120"], { stdio: ["ignore", "inherit", "inherit"] });
    writeFileSync(process.env.PID_FILE + ".orphan", String(child.pid));
    process.exit(0);
  }
  throw new Error("Unknown tool");
});
server.connect(new StdioServerTransport());
`,
  );
  await mkdir(dirname(pidFile), { recursive: true });
  return {
    /** The same server, launched differently. */
    changeLaunch: () => writeLaunch({ NOTES_EDITION: "2" }),
    notesFile,
    pidFile,
    plugin,
  };
}
