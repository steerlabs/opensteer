import {
  AgentConnectionStore,
  OpensteerStore,
  TabStore,
  TriggerStore,
  admitAgentOperation,
  beginAgentSession,
  decideAgentOperation,
  handOffAgentOperation,
} from "@opensteer/database";
import { createPersonalRunFixturePort } from "@opensteer/database/test-support/personal-run";
import { cloneTestDatabase } from "@opensteer/database/test-support/database";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createHttpHostApiClient } from "@opensteer/client/host-api";
import { AgentSessionService } from "../agent-sessions/agent-session-service.js";
import { ExecutionCoordinator } from "@opensteer/orchestration";
import { TabService } from "../tabs/tab-service.js";
import { OwnerProfileService } from "../administration/owner-profile.js";
import { MemoryPassService } from "../agents/memory-pass-service.js";
import { createId } from "@opensteer/core";
import { decodeBrowserFrameEnvelope } from "@opensteer/protocol";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile, writeFile } from "node:fs/promises";
import pg from "pg";
import { expect, it, vi } from "vitest";
import { startBrowserRuntime } from "../browser/browser-runtime.test-support.js";
import {
  connectComputerAppMachine,
  integrationGateway,
  pluginCall,
  pluginPath,
  requestComputerAppSetup,
  setComputerApp,
} from "./computer-apps.test-support.js";
import { hostInternalRoutePaths } from "../server/internal-routes.js";
import {
  acceptCallerRun,
  acknowledgeCommands,
  connectCallerMachine,
  configurePersonalRemoteAccess,
  dispatchCallerRun,
  startPrivateMachineHost,
  waitForExecute,
  waitForMessage,
  waitForValue,
} from "./private-machine-host.test-support.js";

const reportPath = process.env.OPENSTEER_HOT_PATH_REPORT;
const iterations = reportPath ? Number(process.env.OPENSTEER_HOT_PATH_ITERATIONS ?? 31) : 1;
const warmups = iterations > 1 ? 4 : 0;

function traceQueries(record: (sql: string) => void) {
  const prototype: { query(...args: unknown[]): unknown } = pg.Client.prototype;
  const query = prototype.query;
  return vi.spyOn(prototype, "query").mockImplementation(function (
    this: pg.Client,
    ...args: unknown[]
  ) {
    const first = args[0];
    record(
      typeof first === "string"
        ? first
        : first && typeof first === "object" && "text" in first && typeof first.text === "string"
          ? first.text
          : "<unknown>",
    );
    return Reflect.apply(query, this, args);
  });
}

it.skipIf(Boolean(reportPath))(
  "keeps Personal shell and warm tab reads within their query budgets",
  async () => {
    const database = await cloneTestDatabase("host");
    let tracing: string[] | undefined;
    const trace = traceQueries((statement) => tracing?.push(statement));
    let host: Awaited<ReturnType<typeof startPrivateMachineHost>> | undefined;
    try {
      const personal = await startPrivateMachineHost(database.url, { logger: false });
      host = personal;
      const fixture = createPersonalRunFixturePort(personal.store);
      await fixture.createTask({ ownerId: personal.ownerId, suffix: "hot-path-reads" });
      await personal.api["personal.shell.get"]({});
      const shellSql: string[] = [];
      tracing = shellSql;
      const shell = await personal.api["personal.shell.get"]({});
      tracing = undefined;
      expect(shell).toMatchObject({ ok: true, data: { session: { role: "owner" } } });
      expect(shellSql).toHaveLength(18);

      const project = () =>
        personal.runtime.tabs.project({ kind: "person", ownerId: personal.ownerId });
      await project();
      const tabSql: string[] = [];
      tracing = tabSql;
      const projected = await project();
      tracing = undefined;
      expect(projected.tabs).toEqual([]);
      expect(tabSql).toHaveLength(1);
      expect([...shellSql, ...tabSql].filter((sql) => /browser_pool_slots/u.test(sql))).toEqual([]);
    } finally {
      trace.mockRestore();
      try {
        await host?.close();
      } finally {
        await database.drop();
      }
    }
  },
);

const parityReport = process.env.OPENSTEER_POOL_PARITY_REPORT;
const parityFixture = new URL("./personal-hot-paths.parity.json", import.meta.url);

/**
 * The pooled browser must leave an ordinary Home's statements alone. Each path records only the
 * statements its own async work issues (the Runner's and the Run's background work runs in
 * contexts of its own and is never counted), and every path's statement texts, sorted, must
 * equal those recorded with this same test on the overhaul head before the pool (4910b97d7),
 * less the statements the team server's removal took off Home startup, less the embedder
 * statements' replay sweep (gone with verification through a platform), and plus the one read
 * that refuses a team server's database before migrating it: a statement added,
 * removed or changed on any of these paths fails it. Two paths pin your own agents' tool calls
 * as rule 7 asks (B9): "Run MCP task read", a native Run's, and "automation program task read",
 * a Trigger program's, each one MCP call over its own open session. To record the fixture again,
 * run with OPENSTEER_POOL_PARITY_REPORT set to a file path on the base.
 */
it.skipIf(Boolean(reportPath))(
  "keeps an ordinary Home's browser and direct-work statements as they were before the pool",
  async () => {
    const database = await cloneTestDatabase("host");
    const close: (() => unknown | Promise<unknown>)[] = [() => database.drop()];
    const own = new AsyncLocalStorage<string[]>();
    // A later local names the agent's own tab; the traces keep a name of their own.
    const traces = own;
    const trace = traceQueries((statement) => own.getStore()?.push(statement));
    const recorded: Record<string, string[]> = {};
    // A path's first shell read refreshes the owner's name in the background, and that
    // transaction's last statement raced the end of the path. Each refresh runs in a trace of its
    // own; the path waits for it after its own statements are taken, and counts it whole.
    const refreshes = new Map<string[], { sql: string[]; done: Promise<unknown> }[]>();
    const refresh = OwnerProfileService.prototype.refresh;
    const refreshing = vi
      .spyOn(OwnerProfileService.prototype, "refresh")
      .mockImplementation(function (this: OwnerProfileService) {
        const path = own.getStore();
        if (!path) return Reflect.apply(refresh, this, []) as Promise<void>;
        const sql: string[] = [];
        const done = own.run(sql, () => Reflect.apply(refresh, this, []) as Promise<void>);
        refreshes.set(path, [...(refreshes.get(path) ?? []), { sql, done }]);
        return done;
      });
    close.unshift(() => refreshing.mockRestore());
    // MemoryPassService's provisioning drain (`reconcileMissing`, run by its DeadlineDrain) is
    // work the start leaves running: it is counted on no path, and its cost is pinned on a path
    // of its own, "memory provisioning pass", one pass the test makes by itself. The fixture once held the first
    // statement of its two passes at the start (`select "owner_id" from "personal_settings"`),
    // which always ran inside the start while the rest of each pass raced its end; those two are
    // deliberately not listed, so a raw trace of a start shows two statements more.
    const reconcile = MemoryPassService.prototype.reconcileMissing;
    const memoryPasses = new Set<MemoryPassService>();
    const reconciling = vi
      .spyOn(MemoryPassService.prototype, "reconcileMissing")
      .mockImplementation(function (this: MemoryPassService) {
        memoryPasses.add(this);
        return own.exit(() => Reflect.apply(reconcile, this, []) as ReturnType<typeof reconcile>);
      });
    close.unshift(() => reconciling.mockRestore());
    // The execution coordinator's dispatch loop (`ExecutionCoordinator`, reading
    // `OpensteerStore.listPendingCommands` each pass) is work the start leaves running too: a
    // pass runs where it was woken, and its read is counted on no path of the start. The fixture once held
    // its three reads at the start, which usually, not always, landed inside it; they are
    // deliberately not listed, so a raw trace of a start shows them. Its cost is pinned on a path
    // of its own, "execution dispatch pass": one pass the test asks for (the coordinator's
    // `wake()`, made inside that path's own trace), every statement of it.
    const dispatchSql: string[] = [];
    let passRead: PromiseWithResolvers<void> | undefined;
    const listPending = OpensteerStore.prototype.listPendingCommands;
    const reading = vi
      .spyOn(OpensteerStore.prototype, "listPendingCommands")
      .mockImplementation(function (this: OpensteerStore, ...args) {
        const run = () => Reflect.apply(listPending, this, args) as ReturnType<typeof listPending>;
        if (own.getStore() !== dispatchSql) return own.exit(run);
        const read = run();
        const pass = passRead;
        passRead = undefined;
        if (pass) void read.finally(() => pass.resolve());
        return read;
      });
    const dispatchers = new Set<ExecutionCoordinator>();
    const start = ExecutionCoordinator.prototype.start;
    const starting = vi.spyOn(ExecutionCoordinator.prototype, "start").mockImplementation(function (
      this: ExecutionCoordinator,
    ) {
      dispatchers.add(this);
      Reflect.apply(start, this, []);
    });
    close.unshift(() => starting.mockRestore());
    close.unshift(() => reading.mockRestore());
    const record = async <T>(path: string, action: () => Promise<T>): Promise<T> => {
      const sql: string[] = [];
      try {
        return await own.run(sql, action);
      } finally {
        // Work the path left running is not its statement; only what it awaited counts, taken
        // here and now. A statement timeout is the time left to a deadline, so only its
        // presence is compared.
        const counted = [...sql];
        for (const started of refreshes.get(sql) ?? []) {
          await started.done.catch(() => undefined);
          counted.push(...started.sql);
        }
        recorded[path] = counted
          .map((statement) => statement.replace(/\b(\w*timeout) = \d+/gu, "$1 = <ms>"))
          .sort();
      }
    };
    // A tab's runtime frames mark it changed in the tab catalog when their work ends, which is
    // sometimes while a tab command's own catalog refresh is in flight: the command then
    // refreshes once more. On the paths that open or activate a tab, the order is fixed to the
    // fixture's: a mark from the runtime's background frames is applied once the command has
    // answered. A mark issues no statement; none is dropped, and the command's own marks are
    // never deferred.
    // A mark from the runtime's background frames starts in the broker's socket handler: no
    // frame of the command is in its stack. The command's own marks (activation's before its
    // read, the open's through its awaited admission) carry the command and stay in the path.
    const fromBackgroundFrame = () => {
      const limit = Error.stackTraceLimit;
      Error.stackTraceLimit = 200;
      const stack = new Error().stack ?? "";
      Error.stackTraceLimit = limit;
      return !/TabService\.(open|activate)\b|executeCoreCommand/u.test(stack);
    };
    const marksAfter = async <T>(command: () => Promise<T>): Promise<T> => {
      const changed = TabService.prototype.changed;
      const marks: { service: TabService; args: Parameters<TabService["changed"]> }[] = [];
      const deferring = vi.spyOn(TabService.prototype, "changed").mockImplementation(function (
        this: TabService,
        ...args
      ) {
        if (args[1] && fromBackgroundFrame()) marks.push({ service: this, args });
        else Reflect.apply(changed, this, args);
      });
      try {
        return await command();
      } finally {
        deferring.mockRestore();
        for (const { service, args } of marks) Reflect.apply(changed, service, args);
      }
    };
    try {
      // The Home's real startup, all of it that runs in its own async work.
      const host = await record("home startup", () =>
        startPrivateMachineHost(database.url, { logger: false }),
      );
      // Its first shell read refreshed the owner's name: counted whole, never only in part.
      expect(recorded["home startup"]).toEqual(
        expect.arrayContaining([
          expect.stringContaining('update "personal_settings" set "owner_name_account"'),
        ]),
      );
      close.unshift(() => host.close());
      // Startup's one read for command Requests (an approval a restart cut off) is served by its
      // partial index, never a scan of every Request the Home has ever had.
      const recovery = recorded["home startup"]!.find((statement) =>
        statement.includes("'running'"),
      );
      expect(recovery).toBeDefined();
      const planner = new pg.Client({ connectionString: database.url });
      await planner.connect();
      try {
        await planner.query("begin");
        await planner.query("set local enable_seqscan = off");
        const plan = (await planner.query(`explain ${recovery!}`)).rows
          .map((row: Record<string, string>) => row["QUERY PLAN"])
          .join("\n");
        expect(plan).toContain("requests_command_running");
        expect(plan).not.toContain("Seq Scan");
        await planner.query("rollback");
      } finally {
        await planner.end();
      }
      const runner = await connectCallerMachine(host, {
        name: "Parity fixture",
        token: host.hostingRunnerEnrollmentToken,
        automations: true,
        browser: {
          runtimeId: "browser-runtime-integration",
          wireVersion: 2,
          cdpBoundary: 1,
          sharedControl: 1,
          tabRestoreVersion: 1,
          surfaceState: 1,
          // A Standard CDP ticket is issued, not refused.
          standardCdp: 1,
          standardCdpAttemptRecovery: 1,
        },
      });
      close.unshift(() => runner.close());
      const browser = await startBrowserRuntime(host.hostPort, "unused-existing-main", {
        primary: runner.primary,
        agentReady: true,
        targetedStreaming: true,
        personalTabs: true,
        surfaceState: true,
        uniqueTabs: true,
        tabCommands: true,
      });
      close.unshift(() => browser.close());
      await waitForValue(async () => (host.runtime.browser.available ? true : undefined));
      await record("startup sweep", () => host.runtime.browser.initialize());
      const rpc = async (
        result: Promise<{ ok: true; data: unknown } | { ok: false; error: { message: string } }>,
      ) => {
        const reply = await result;
        if (!reply.ok) throw new Error(reply.error.message);
        return reply.data;
      };
      // The person's commands go in process, so the Host's handling of each stays in the
      // path's own async context and is counted as the path's.
      const api = createHttpHostApiClient({
        baseUrl: host.origin,
        fetch: async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          const reply = await host.runtime.app.inject({
            method: (init?.method ?? "GET") as "GET" | "POST",
            url: `${url.pathname}${url.search}`,
            headers: { ...Object.fromEntries(new Headers(init?.headers)), ...host.ownerHeaders },
            ...(typeof init?.body === "string" ? { payload: init.body } : {}),
          });
          return new Response(reply.body, {
            status: reply.statusCode,
            headers: { "content-type": String(reply.headers["content-type"] ?? "") },
          });
        },
        onAuthenticationRequired: () => {
          throw new Error("Personal owner session expired");
        },
      });
      // An ordinary Home's broker allocates nothing for the pool: no controller for a pooled
      // end, so none of its closes constructs that end's error either.
      const brokerControllers: string[] = [];
      const Original = globalThis.AbortController;
      globalThis.AbortController = class extends Original {
        constructor() {
          super();
          const stack = new Error().stack ?? "";
          if (/new HostedBrowserBroker/u.test(stack)) brokerControllers.push(stack);
        }
      };
      close.unshift(() => {
        globalThis.AbortController = Original;
      });
      const target = { kind: "page", guest: true, url: "about:blank" } as const;
      const opened = (await record("person tab open", () =>
        marksAfter(() =>
          rpc(api["commands.dispatch"]({ type: "tab.open", idempotencyKey: "parity", target })),
        ),
      )) as { tab: { tabId: Parameters<TabStore["get"]>[1] } };
      const tabId = opened.tab.tabId;
      const row = await new TabStore(host.store.database).get(host.ownerId, tabId);
      const sessionId = row?.pageBinding?.sessionId;
      if (!sessionId) throw new Error("No Browser Session");
      const viewer = await record("viewer attach", () =>
        host.runtime.browser.attach(
          host.ownerId,
          sessionId,
          { id: "parity-owner", isOpen: () => true, close() {}, async send() {} },
          { authSessionId: createId("authSession"), mode: "control", signedIn: async () => true },
        ),
      );
      close.unshift(() => viewer.close());
      await record("workspace activation", () =>
        marksAfter(() =>
          rpc(
            api["commands.dispatch"]({
              type: "tab.activate",
              idempotencyKey: "parity-activate",
              tabId,
            }),
          ),
        ),
      );
      const run = await dispatchCallerRun(host, runner, { key: "parity", title: "Parity Run" });
      const authority = {
        agentBindingId: `run:${run.runId}`,
        ownerId: host.ownerId,
        environmentId: runner.environmentId,
      };
      const own = await host.runtime.browser.openAgentTab(
        { ...authority, threadId: run.threadId },
        { identity: { kind: "guest", computer: runner.runnerId }, operationKey: "parity-run" },
      );
      const issued = await record("standard CDP issue", () =>
        host.runtime.browser
          .issueStandardCdpTicket({
            authority,
            browserSessionId: own.sessionId,
            seedTabId: own.tabId,
            mode: "session",
          })
          .then(
            () => "issued",
            (error: unknown) => (error instanceof Error ? error.message : "refused"),
          ),
      );
      const connections = new AgentConnectionStore(host.store.database);
      const connection = await connections.create({
        userId: host.ownerId,
        label: "Parity connection",
        clientName: "Parity agent",
        accessMode: "full-access",
        grant: { scope: "everything" },
        resource: "https://parity.test/mcp",
        expiresAt: new Date(Date.now() + 60_000),
      });
      expect(await connections.activate(connection.id, crypto.randomUUID())).toBe(true);
      const { grantRevision } = await host.store.database
        .selectFrom("agentConnections")
        .select("grantRevision")
        .where("id", "=", connection.id)
        .executeTakeFirstOrThrow();
      const lineage = { userId: host.ownerId, agentConnectionId: connection.id };
      const profile = await host.store.createBrowserProfile({
        name: "Parity profile",
        ownerId: host.ownerId,
        homeRunnerId: runner.runnerId,
        idempotencyKey: "parity-profile",
      });
      const { session } = await beginAgentSession(host.store.database, lineage);
      const { operation } = await admitAgentOperation(host.store.database, {
        ...lineage,
        sessionId: session.id,
        operationKey: "parity",
        tool: "browser_use",
        argumentDigest: "parity",
        target: {
          grant: { kind: "browser-profile", profileId: profile.id },
          name: "Parity profile",
          device: null,
        },
        targetGeneration: null,
        grantRevision,
        mode: "full-access",
        effect: "write",
        calls: "parity",
        agentReason: null,
      } as Parameters<typeof admitAgentOperation>[1]);
      const reviewed = await decideAgentOperation(host.store.database, operation, {
        by: "full-access",
      });
      const handed = await record("direct hand-off", () =>
        handOffAgentOperation(host.store.database, { ...lineage, reviewed }),
      );
      expect(handed?.state).toBe("handed-off");
      // The hand-off's real caller: a connected agent's direct operation through the one door.
      const sessions = new AgentSessionService({ store: host.store, holdMs: 0 });
      const ran = await record("direct operation run", () =>
        sessions.run({
          ownerUserId: host.ownerId,
          agentConnectionId: connection.id,
          operationKey: "parity-run-operation",
          tool: "browser_use",
          input: { code: "parity" },
          target: {
            grant: { kind: "browser-profile", profileId: profile.id },
            name: "Parity profile",
            device: null,
          },
          targetGeneration: null,
          effect: "write",
          calls: "parity",
          execute: async (context) => {
            await context.recheck();
            return "done";
          },
        }),
      );
      expect(ran.status).toBe("completed");
      expect(brokerControllers).toEqual([]);
      // Each background pass, made once on purpose and measured by itself.
      const [dispatcher] = dispatchers;
      const [memoryPass] = memoryPasses;
      if (!dispatcher || !memoryPass) throw new Error("A background pass never started.");
      // A pass with nothing pending ends with its read: what it issues is in this trace by two
      // turns of the event loop after that read.
      dispatchSql.length = 0;
      passRead = Promise.withResolvers<void>();
      const read = passRead.promise;
      traces.run(dispatchSql, () => dispatcher.wake());
      await read;
      for (let turn = 0; turn < 2; turn++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      recorded["execution dispatch pass"] = [...dispatchSql].sort();
      const memory = memoryPass;
      await record("memory provisioning pass", () => Reflect.apply(reconcile, memory, []));
      // Your own agents' tool calls over MCP with their own bearer, in process (rule 7, B9): a
      // native Run's, and an automation program's from the token its Trigger was dispatched with.
      // Each opens its session first, as a real client does; only the call is the path.
      const mcpPost = (token: string, body: unknown, sessionId?: string) =>
        host.runtime.app.inject({
          method: "POST",
          url: hostInternalRoutePaths.mcp,
          headers: {
            host: new URL(host.origin).host,
            authorization: `Bearer ${token}`,
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            "mcp-protocol-version": "2025-11-25",
            ...(sessionId ? { "mcp-session-id": sessionId } : {}),
          },
          payload: JSON.stringify(body),
        });
      const mcpSession = async (token: string) => {
        const reply = await mcpPost(token, {
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "parity", version: "1" },
          },
        });
        expect(reply.statusCode, reply.body).toBe(200);
        const sessionId = reply.headers["mcp-session-id"];
        if (typeof sessionId !== "string") throw new Error("No MCP session");
        const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
        expect((await mcpPost(token, initialized, sessionId)).statusCode).toBe(202);
        return async (name: string, args: Record<string, unknown>) => {
          const call = {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: args },
          };
          const answer = await mcpPost(token, call, sessionId);
          expect(answer.statusCode, answer.body).toBe(200);
          expect(answer.body).toContain(run.threadId);
          expect(answer.body).not.toContain('"isError":true');
        };
      };
      const runTool = await mcpSession(run.toolsToken);
      await record("Run MCP task read", () =>
        runTool("opensteer_task_read", { taskId: run.threadId }),
      );
      const triggers = new TriggerStore(host.store.database);
      const automation = await triggers.create({
        actorThreadId: null,
        anchorThreadId: run.threadId,
        createdBy: host.ownerId,
        idempotencyKey: "parity-trigger",
        name: "Parity automation",
        source: {
          kind: "schedule",
          schedule: { kind: "cron", expression: "0 0 * * *", timezone: "UTC" },
        },
        script: { interpreter: null, text: "console.log('ok');" },
      });
      acknowledgeCommands(runner.primary, ({ type }) => type === "trigger.execute");
      const dispatched = waitForMessage(runner.primary.socket, (message) => {
        const { command } = message as {
          command?: { type: string; context?: { triggerId: string } };
        };
        return (
          message.type === "host.command" &&
          command?.type === "trigger.execute" &&
          command.context?.triggerId === automation.trigger.id
        );
      }) as unknown as Promise<{ command: { context: { mcp: { token: string } } } }>;
      await triggers.enqueueManual({
        actorThreadId: null,
        ownerId: host.ownerId,
        triggerId: automation.trigger.id,
        idempotencyKey: "parity-occurrence",
      });
      // A store-level enqueue notifies no coordinator: it is woken here, outside every path.
      dispatcher.wake();
      const programTool = await mcpSession((await dispatched).command.context.mcp.token);
      await record("automation program task read", () =>
        programTool("opensteer_task_read", { taskId: run.threadId }),
      );
      // An ordinary Home's Stop, last: a pooled Stop's wait for the runtime's answer adds nothing.
      await record("person stop", () => host.runtime.browser.stop(host.ownerId, sessionId));
      if (parityReport)
        await writeFile(parityReport, `${JSON.stringify({ issued, recorded }, null, 2)}\n`);
      expect(
        Object.values(recorded)
          .flat()
          .filter((sql) => /browser_pool/u.test(sql)),
      ).toEqual([]);
      const base = JSON.parse(await readFile(parityFixture, "utf8")) as {
        issued: string;
        recorded: Record<string, string[]>;
      };
      expect(issued).toBe(base.issued);
      expect(recorded).toEqual(base.recorded);
    } finally {
      trace.mockRestore();
      for (const step of close) await step();
    }
  },
);

it.skipIf(Boolean(reportPath))(
  "keeps concurrent holds by a person's own agents on a personal Home unserialized and without extra re-admission queries (PH6)",
  async () => {
    const database = await cloneTestDatabase("host");
    const close: (() => unknown | Promise<unknown>)[] = [() => database.drop()];
    const own = new AsyncLocalStorage<string[]>();
    const trace = traceQueries((statement) => own.getStore()?.push(statement));
    const reconcile = MemoryPassService.prototype.reconcileMissing;
    const reconciling = vi
      .spyOn(MemoryPassService.prototype, "reconcileMissing")
      .mockImplementation(function (this: MemoryPassService) {
        return own.exit(() => Reflect.apply(reconcile, this, []) as ReturnType<typeof reconcile>);
      });
    close.unshift(() => reconciling.mockRestore());
    const listPending = OpensteerStore.prototype.listPendingCommands;
    const reading = vi
      .spyOn(OpensteerStore.prototype, "listPendingCommands")
      .mockImplementation(function (this: OpensteerStore, ...args) {
        return own.exit(
          () => Reflect.apply(listPending, this, args) as ReturnType<typeof listPending>,
        );
      });
    close.unshift(() => reading.mockRestore());
    try {
      const host = await startPrivateMachineHost(database.url, { logger: false });
      close.unshift(() => host.close());
      const runner = await connectCallerMachine(host, {
        name: "PH6 fixture",
        token: host.hostingRunnerEnrollmentToken,
        browser: {
          runtimeId: "browser-runtime-ph6",
          wireVersion: 2,
          cdpBoundary: 1,
          sharedControl: 1,
          tabRestoreVersion: 1,
          surfaceState: 1,
        },
      });
      close.unshift(() => runner.close());
      const browser = await startBrowserRuntime(host.hostPort, "unused-existing-main", {
        primary: runner.primary,
        agentReady: true,
        targetedStreaming: true,
        personalTabs: true,
        surfaceState: true,
        uniqueTabs: true,
        tabCommands: true,
      });
      close.unshift(() => browser.close());
      await waitForValue(async () => (host.runtime.browser.available ? true : undefined));

      const opened = await host.api["commands.dispatch"]({
        type: "tab.open",
        idempotencyKey: "ph6-person-tab",
        target: { kind: "page", guest: true, url: "about:blank" },
      });
      if (!opened.ok) throw new Error(opened.error.message);
      const tabId = (opened.data as { tab: { tabId: Parameters<TabStore["get"]>[1] } }).tab.tabId;
      const tabRow = (await new TabStore(host.store.database).get(host.ownerId, tabId))!;
      expect(tabRow.pageBinding?.sessionId).toBeTruthy();

      const runA = await dispatchCallerRun(host, runner, { key: "ph6-a", title: "PH6 Run A" });
      const runB = await dispatchCallerRun(host, runner, { key: "ph6-b", title: "PH6 Run B" });
      const claimsA = {
        requestedBy: host.ownerId,
        runId: runA.runId,
        threadId: runA.threadId,
      } as unknown as Parameters<typeof host.runtime.browser.bindPage>[0];
      const claimsB = {
        requestedBy: host.ownerId,
        runId: runB.runId,
        threadId: runB.threadId,
      } as unknown as Parameters<typeof host.runtime.browser.bindPage>[0];

      // Pause the first attachBrowserSession briefly so a second concurrent bindPage overlaps it
      // unless #holdForAgent queues the two holds behind each other on the runner lane.
      let activeAttaches = 0;
      let overlapped = false;
      const firstEntered = Promise.withResolvers<void>();
      const releaseFirst = Promise.withResolvers<void>();
      const originalAttach = host.store.attachBrowserSession.bind(host.store);
      const attachSpy = vi
        .spyOn(host.store, "attachBrowserSession")
        .mockImplementation(async (input) => {
          activeAttaches++;
          try {
            if (activeAttaches === 1) {
              firstEntered.resolve();
              await withTimeout(releaseFirst.promise, 250, {
                timeoutError: () => new Error("attach overlap wait elapsed"),
              }).catch(() => undefined);
            } else {
              overlapped = true;
              releaseFirst.resolve();
            }
            return await originalAttach(input);
          } finally {
            activeAttaches--;
          }
        });
      const resolveSpy = vi.spyOn(host.store, "resolveResourceAccess");
      const concurrentSql: string[] = [];
      try {
        await own.run(concurrentSql, () =>
          Promise.all([
            host.runtime.browser.bindPage(claimsA, tabRow),
            host.runtime.browser.bindPage(claimsB, tabRow),
          ]),
        );
      } finally {
        releaseFirst.resolve();
        attachSpy.mockRestore();
      }
      const resolveCalls = resolveSpy.mock.calls.length;
      resolveSpy.mockRestore();

      expect(
        concurrentSql.filter((sql) => /work_home_policy|organization|browser_pool/u.test(sql)),
      ).toEqual([]);
      expect(overlapped).toBe(true);
      // Matches the 5369592d9 baseline (8 resolveResourceAccess calls across two concurrent
      // bindPage holds; before PH6 it was 9 resolveCalls / 194 statements and serialized).
      expect(resolveCalls).toBe(8);
      expect(concurrentSql.length).toBeLessThanOrEqual(186);

      // Device switch is still honoured even without queuing holds on the runner admission lane:
      // turning browser access off while attachBrowserSession is in flight refuses and leaves no hold.
      const runC = await dispatchCallerRun(host, runner, { key: "ph6-c", title: "PH6 Run C" });
      const claimsC = {
        requestedBy: host.ownerId,
        runId: runC.runId,
        threadId: runC.threadId,
      } as unknown as Parameters<typeof host.runtime.browser.bindPage>[0];
      const enteredC = Promise.withResolvers<void>();
      const releaseC = Promise.withResolvers<void>();
      const attachCSpy = vi
        .spyOn(host.store, "attachBrowserSession")
        .mockImplementationOnce(async (input) => {
          enteredC.resolve();
          await releaseC.promise;
          return originalAttach(input);
        });
      const bindingC = host.runtime.browser.bindPage(claimsC, tabRow);
      bindingC.catch(() => undefined);
      try {
        await enteredC.promise;
        await host.runtime.browser.disableAgentAccess(runner.runnerId);
        releaseC.resolve();
        await expect(bindingC).rejects.toThrow(/turned off/u);
        expect(
          await host.store.listBrowserSessionAttachmentBindings(tabRow.pageBinding!.sessionId),
        ).toEqual([]);
      } finally {
        releaseC.resolve();
        attachCSpy.mockRestore();
      }
    } finally {
      trace.mockRestore();
      for (const step of close) await step();
    }
  },
);

it.skipIf(!reportPath)(
  "measures a Personal Home with its own Run, without a connection",
  async () => {
    const database = await cloneTestDatabase("host");
    const close: (() => unknown | Promise<unknown>)[] = [() => database.drop()];
    const samples: Record<string, { ms: number; sql: string[] }[]> = {};
    const failures: unknown[] = [];
    let tracing: string[] | undefined;
    const trace = traceQueries((sql) => tracing?.push(sql));

    const measure = async <T>(
      path: string,
      repeat: number,
      action: (index: number) => Promise<T>,
      afterward?: (value: T) => Promise<unknown>,
    ) => {
      const entries: { ms: number; sql: string[] }[] = [];
      samples[path] = entries;
      if (reportPath) console.info(path);
      for (let index = -warmups; index < repeat; index++) {
        const sql: string[] = [];
        tracing = sql;
        const started = performance.now();
        let value: T;
        try {
          value = await action(index);
        } finally {
          tracing = undefined;
        }
        const ms = performance.now() - started;
        if (index >= 0) entries.push({ ms, sql });
        await afterward?.(value);
      }
    };

    try {
      const host = await startPrivateMachineHost(database.url, { logger: false });
      close.unshift(() => host.close());
      const connect = () =>
        connectCallerMachine(host, {
          name: "Hot path fixture",
          token: host.hostingRunnerEnrollmentToken,
        });
      await measure(
        "runner reconnect through ready",
        Math.min(iterations, 15),
        connect,
        async (runner) => {
          const readLastSeen = async () =>
            (
              await host.store.database
                .selectFrom("runners")
                .select("lastSeenAt")
                .where("id", "=", runner.runnerId)
                .executeTakeFirstOrThrow()
            ).lastSeenAt?.getTime() ?? 0;
          const lastSeen = await readLastSeen();
          await runner.close();
          await vi.waitFor(async () => expect(await readLastSeen()).toBeGreaterThan(lastSeen));
        },
      );
      const runner = await connectCallerMachine(host, {
        name: "Hot path fixture",
        token: host.hostingRunnerEnrollmentToken,
        browser: {
          runtimeId: "browser-runtime-integration",
          wireVersion: 2,
          cdpBoundary: 1,
          sharedControl: 1,
          tabRestoreVersion: 1,
          surfaceState: 1,
        },
      });
      close.unshift(() => runner.close());
      const browser = await startBrowserRuntime(host.hostPort, "unused-existing-main", {
        primary: runner.primary,
        agentReady: true,
        targetedStreaming: true,
        personalTabs: true,
        surfaceState: true,
        uniqueTabs: true,
        tabCommands: true,
      });
      close.unshift(() => browser.close());
      await waitForValue(async () => (host.runtime.browser.available ? true : undefined));

      const run = await dispatchCallerRun(host, runner, { key: "hot", title: "Hot path Run" });
      const client = new Client({ name: "personal-hot-paths", version: "1" });
      close.unshift(async () => {
        await client.close();
      });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(hostInternalRoutePaths.mcp, host.origin), {
          requestInit: { headers: { authorization: `Bearer ${run.toolsToken}` } },
        }) as unknown as Transport,
      );
      const tool = async (name: string, args: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
        return result.structuredContent;
      };
      const rpc = async (
        result: Promise<{ ok: true; data: unknown } | { ok: false; error: { message: string } }>,
      ) => {
        const reply = await result;
        if (!reply.ok) throw new Error(reply.error.message);
        return reply.data;
      };
      const target = { kind: "page", guest: true, url: "about:blank" } as const;

      await measure("Run MCP task read", iterations, () =>
        tool("opensteer_task_read", { taskId: run.threadId }),
      );
      // A task write of your own agent on its own lineage, through the one door (A3, rule 7).
      await measure("Run MCP task resume (own task)", iterations, () =>
        tool("opensteer_task_resume", { taskId: run.threadId }),
      );
      const opened = (await rpc(
        host.api["commands.dispatch"]({
          type: "tab.open",
          idempotencyKey: "owner-page",
          target,
        }),
      )) as { tab: { tabId: Parameters<TabStore["get"]>[1] } };
      const tabId = opened.tab.tabId;
      const row = await new TabStore(host.store.database).get(host.ownerId, tabId);
      const sessionId = row?.pageBinding?.sessionId;
      if (!sessionId) throw new Error("No Browser Session");

      let onFrame: ((frame: Buffer) => void) | undefined;
      const ownerViewer = await host.runtime.browser.attach(
        host.ownerId,
        sessionId,
        {
          id: "hot-path-owner",
          isOpen: () => true,
          close() {},
          async send(frame, binary) {
            if (binary && Buffer.isBuffer(frame)) onFrame?.(frame);
          },
        },
        { authSessionId: createId("authSession"), mode: "control", signedIn: async () => true },
      );
      close.unshift(() => ownerViewer.close());
      await ownerViewer.handle(
        Buffer.from(
          JSON.stringify({
            type: "stream.subscribe",
            surfaceId: tabId,
          }),
        ),
        false,
      );
      await measure("browser frame to owner", iterations, async (index) => {
        const received = Promise.withResolvers<Buffer>();
        onFrame = received.resolve;
        browser.sendFrame(browserFrame(index + warmups + 1, tabId));
        const frame = await withTimeout(received.promise, 5_000, {
          timeoutError: () => new Error("Owner did not receive a browser frame"),
        });
        expect(frame.subarray(-4)).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
        onFrame = undefined;
        const { watchToken } = decodeBrowserFrameEnvelope(frame).header;
        if (watchToken) {
          await ownerViewer.handle(
            Buffer.from(
              JSON.stringify({
                type: "stream.ack",
                token: watchToken,
              }),
            ),
            false,
          );
        }
      });
      await ownerViewer.handle(
        Buffer.from(
          JSON.stringify({
            type: "stream.unsubscribe",
            surfaceId: tabId,
          }),
        ),
        false,
      );

      await measure(
        "Run MCP tab open",
        Math.min(iterations, 17),
        () => tool("tab_open", { target }),
        async (value) => {
          const openedTab = (value as { tab: { tabId: string } }).tab.tabId;
          await tool("tab_close", { tabIds: [openedTab] });
        },
      );
      // Measure moving from one open task tab back to the owner page, with the same open set as before.
      let closing = await tool("tab_open", { target });
      await measure(
        "Run MCP tab close",
        Math.min(iterations, 17),
        async () => {
          const openedTab = (closing as { tab: { tabId: string } }).tab.tabId;
          expect(await tool("tab_close", { tabIds: [openedTab] })).toMatchObject({
            closed: [openedTab],
            failed: [],
          });
        },
        async () => {
          closing = await tool("tab_open", { target });
        },
      );
      await tool("tab_close", { tabIds: [(closing as { tab: { tabId: string } }).tab.tabId] });

      await measure("personal shell RPC", iterations, () =>
        rpc(host.api["personal.shell.get"]({})),
      );
      await measure("person tab projection", iterations, () =>
        host.runtime.tabs.project({ kind: "person", ownerId: host.ownerId }),
      );
      await measure("thread list RPC", iterations, () => rpc(host.api["tasks.page"]({})));
      await measure("Requests list RPC", iterations, () => rpc(host.api["requests.list"]({})));

      const attachment = await host.runtime.browser.attachCdpForAgent(
        {
          agentBindingId: `run:${run.runId}`,
          ownerId: host.ownerId,
          sessionId,
        },
        () => {},
      );
      close.unshift(() => attachment.close());
      const nextBrowserCommand = async (
        matches: (command: Awaited<ReturnType<typeof browser.nextCommand>>) => boolean,
      ) => {
        for (;;) {
          const command = await browser.nextCommand();
          if (matches(command)) return command;
        }
      };
      await measure("Run page CDP command", iterations, async () => {
        const method = "Target.getTargets";
        const forwarded = nextBrowserCommand(
          (command) =>
            command.type === "cdp.command" &&
            (command.command as { method?: string } | undefined)?.method === method,
        );
        const { result } = await attachment.dispatch({ method });
        const command = await forwarded;
        if (command.type !== "cdp.command") throw new Error("Expected CDP command");
        browser.sendServer(
          { type: "cdp.result", requestId: command.requestId, result: { targetInfos: [] } },
          sessionId,
        );
        expect(await result).toEqual({ targetInfos: [] });
      });

      const personCommand = async (message: Record<string, unknown> & { type: string }) => {
        const forwarded = nextBrowserCommand((command) => command.type === message.type);
        await ownerViewer.handle(
          Buffer.from(JSON.stringify({ ...message, surfaceId: tabId })),
          false,
        );
        await withTimeout(forwarded, 5_000, {
          timeoutError: () => new Error(`Browser Runtime did not receive ${message.type}`),
        });
      };
      await measure("person page command", iterations, () =>
        personCommand({ type: "navigation.reload" }),
      );
      await measure("person browser keystroke", iterations, () =>
        personCommand({
          type: "input.key",
          action: "down",
          code: "KeyA",
          key: "a",
          modifiers: [],
        }),
      );

      const { socket, fence } = runner.primary;
      const base = {
        environmentId: runner.environmentId,
        runId: run.runId,
        threadId: run.threadId,
        bindingGeneration: run.attempt.bindingGeneration,
      };
      let ordinal = run.attempt.nextOrdinal;
      await measure("Runner durable event burst (3)", iterations, async () => {
        const through = ordinal + 2;
        const received = waitForMessage(
          socket,
          (message) =>
            message.type === "host.executions.acked" &&
            (message as { acks?: { runId: string; throughOrdinal: number }[] }).acks?.some(
              (ack) => ack.runId === run.runId && ack.throughOrdinal >= through,
            ) === true,
        );
        for (let index = 0; index < 3; index++) {
          socket.send(
            JSON.stringify({
              ...fence,
              type: "runner.event",
              event: {
                ...base,
                ordinal: ordinal++,
                type: "run.phase",
                emittedAt: new Date().toISOString(),
                data: { phase: index % 2 ? "turn" : "background" },
              },
            }),
          );
        }
        await received;
      });

      // Leave the measured Run live. A separate task receives repeated turns through the Runner wire.
      const created = (await rpc(
        host.api["commands.dispatch"]({
          type: "thread.create",
          idempotencyKey: "dispatch-task",
          environmentId: runner.environmentId,
          harnessInstanceId: runner.harnessInstanceId,
          modelSelection: {
            modelId: "gpt-5.6-sol",
            options: { effort: "low" },
            providerId: "openai",
          },
          title: "Hot path dispatch",
        }),
      )) as { thread: { id: typeof run.threadId } };
      await measure(
        "send input through Run delivery",
        iterations,
        async (index) => {
          const execute = waitForExecute(runner.primary.socket);
          await rpc(
            host.api["commands.dispatch"]({
              type: "thread.sendMessage",
              idempotencyKey: `dispatch:${index}`,
              threadId: created.thread.id,
              delivery: "queue",
              content: [{ type: "text", text: "Fixture message" }],
            }),
          );
          return execute;
        },
        async (execute) => {
          await (await acceptCallerRun(host, runner, execute)).complete();
        },
      );

      await configurePersonalRemoteAccess(host, {
        schemaVersion: 1,
        mode: "private",
        routeOrigin: "https://personal.hot-path.test",
      });
      const computer = await connectComputerAppMachine(host, {
        definitionId: "apple-messages",
        platforms: ["darwin"],
        async inspect() {
          return [
            { detail: null, operation: "query_messages", remedy: null, state: "ready" },
            { detail: null, operation: "send_message", remedy: null, state: "ready" },
          ];
        },
        async invoke(operation) {
          expect(operation).toBe("query_messages");
          return { columns: ["guid"], rows: [["fixture-result"]], truncated: false };
        },
      });
      close.unshift(() => computer.close());
      const setup = await requestComputerAppSetup(host, computer.runnerId, "read", "hot-plugin");
      const { connection } = await setComputerApp(host, computer, setup, setup.id);
      const { id: installationId } = await host.store.database
        .selectFrom("integrationInstallations")
        .select("id")
        .where("name", "=", "apple-messages")
        .executeTakeFirstOrThrow();
      await rpc(
        host.api["commands.dispatch"]({
          type: "integration.grant.create",
          idempotencyKey: "hot-plugin-grant",
          input: {
            access: "read",
            alias: "Fixture Messages",
            connectionId: connection.id,
            installationId,
            isDefault: true,
          },
        }),
      );
      const gateway = await integrationGateway(run.integrationTools);
      close.unshift(() => gateway.close());
      const path = await pluginPath(gateway, "query_messages", "query_messages");
      await measure("Run plugin call to a device tool", iterations, async () => {
        const result = await pluginCall(gateway, path, { sql: "SELECT 1" });
        expect(result.failure).toBeUndefined();
        expect(result.value).toMatchObject({ rows: [["fixture-result"]] });
      });
    } catch (error) {
      failures.push(error);
    } finally {
      for (const cleanup of [
        () => trace.mockRestore(),
        () => (reportPath ? writeFile(reportPath, JSON.stringify(samples, null, 2)) : undefined),
        ...close,
      ]) {
        try {
          await cleanup();
        } catch (error) {
          failures.push(error);
        }
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "Hot-path measurement or cleanup failed");
  },
  100_000,
);

function browserFrame(frameId: number, surfaceId: string): Buffer {
  const header = Buffer.from(
    JSON.stringify({
      encoding: "jpeg",
      frameId,
      geometryRevision: 0,
      rasterHeight: 1,
      rasterWidth: 1,
      surfaceId,
      viewportHeight: 720,
      viewportWidth: 1280,
    }),
  );
  const frame = Buffer.alloc(4 + header.byteLength + 4);
  frame.writeUInt32BE(header.byteLength);
  header.copy(frame, 4);
  frame.set([0xff, 0xd8, 0xff, 0xd9], frame.length - 4);
  return frame;
}
