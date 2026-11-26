import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  BrowserSessionIdSchema,
  DeviceIdSchema,
  OpensteerError,
  ToolBlockedError,
  agentSessionIdleMs,
  createId,
  ThreadIdSchema,
  type AgentGrant,
  type AgentOperationTarget,
  type BrowserProfileId,
  type RequestId,
  type ThreadAccessMode,
} from "@opensteer/core";
import { connectedAgentsNow, sessionSlotFromHome, sessionTaskView } from "@opensteer/client/host";
import {
  AgentConnectionStore,
  BrowserPoolAdmissionClosed,
  NotificationStore,
  installBrowserPoolSlot,
  agentOperationRequestLifetimeMs,
  listAgentOperations,
  needsYouPage,
  readTranscriptItem,
  readBrowserPoolSlot,
} from "@opensteer/database";
import { createStoreFixture, describeStore } from "@opensteer/database/test-support/store";
import { expect, vi } from "vitest";
import { sql } from "kysely";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { withDatabaseOperationSignal } from "@opensteer/database";
import { randomUUID } from "node:crypto";
import { NotificationDispatcher } from "../notifications/notification-dispatcher.js";
import { BrowserReplService } from "../browser-use/browser-repl-service.js";
import { BrowserPoolGate } from "../browser/browser-pool-gate.js";
import {
  BrowserScriptConfinement,
  BrowserToolHandlers,
  type BrowserToolPorts,
} from "../mcp/handlers/browser.js";
import { TabToolHandlers } from "../mcp/handlers/tabs.js";
import { createConnectionRpcHandlers } from "../mcp/connections/connection-routes.js";
import {
  clients,
  commands,
  connection,
  errorText,
  serveMcp,
  lastService,
} from "../mcp/connection-caller.test-support.js";
import type { TabServicePort } from "../tabs/ports.js";
import { AgentSessionService, OperationOutcomeUnknown } from "./agent-session-service.js";
import { createPersonalReads } from "../server/personal-reads.js";

type Fixture = Awaited<ReturnType<typeof createStoreFixture>>;
const profile = createId("browserProfile") as BrowserProfileId;
const other = createId("browserProfile") as BrowserProfileId;
const granted: AgentGrant = {
  scope: "selected",
  tasks: false,
  resources: [{ kind: "browser-profile", profileId: profile }],
};
const page = (profileId: BrowserProfileId) => ({
  kind: "page" as const,
  url: "https://example.test/",
  profileId,
});
const script = { profileId: profile, code: 'print("done")' };

/** Backends transitively blocked on `blockerPid` (PostgreSQL queues a 2nd row updater on the 1st). */
async function blockedBehind(database: Fixture["database"], blockerPid: number): Promise<number> {
  return Number(
    (
      await sql<{ count: string }>`
        with recursive blocked(pid) as (
          select pid from pg_stat_activity
          where datname = current_database()
            and wait_event_type = 'Lock'
            and ${blockerPid} = any(pg_blocking_pids(pid))
          union
          select a.pid from pg_stat_activity a
          join blocked b on b.pid = any(pg_blocking_pids(a.pid))
          where a.datname = current_database()
            and a.wait_event_type = 'Lock'
        )
        select count(*)::text as count from blocked
      `.execute(database)
    ).rows[0]?.count ?? 0,
  );
}

function recordingExecutor() {
  let hold: Promise<void> | null = null;
  let entered: (() => void) | null = null;
  let ignoresAbort = false;
  const execute = async (signal?: AbortSignal) => {
    entered?.();
    if (hold && ignoresAbort) await hold;
    else if (hold) {
      const aborted = new Promise<never>((_, reject) =>
        signal?.addEventListener("abort", () => reject(new OperationOutcomeUnknown()), {
          once: true,
        }),
      );
      await Promise.race([hold, aborted]);
    }
  };
  const runBrowserScript = vi.fn<BrowserToolPorts["scripts"]["runBrowserScript"]>(
    async ({ signal }) => {
      await execute(signal);
      return { content: [{ type: "text", text: "done" }] };
    },
  );
  return {
    execute,
    runBrowserScript,
    holdNext(options: { readonly ignoreAbort?: boolean } = {}) {
      const release = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      ignoresAbort = options.ignoreAbort === true;
      hold = release.promise;
      entered = () => started.resolve();
      return { started: started.promise, release: () => release.resolve() };
    },
  };
}

async function setUp(
  storeFixture: Fixture,
  key: string,
  options: {
    readonly accessMode?: ThreadAccessMode;
    readonly grant?: AgentGrant;
    readonly run?: Awaited<ReturnType<Fixture["startRunFixture"]>>;
    readonly browserConnect?: Pick<BrowserToolPorts, "issueTicket"> &
      Pick<BrowserToolPorts["tabs"], "open" | "bindBrowserScript">;
    readonly pooledBrowser?: BrowserToolPorts["pooledBrowser"];
  } = {},
) {
  const f = options.run ?? (await storeFixture.startRunFixture(key));
  const recorded = recordingExecutor();
  const sessions = new AgentSessionService({
    store: storeFixture.store,
    holdMs: 0,
  });
  const unexpectedTabOperation = () => {
    throw new Error("This fixture runs scripts by profile ID.");
  };
  const tabs: TabServicePort & Pick<BrowserToolPorts["tabs"], "bindBrowserScript"> = {
    list: async () => ({ tabs: [], groups: [], nextCursor: null }),
    open: options.browserConnect?.open ?? unexpectedTabOperation,
    connectionTab: unexpectedTabOperation,
    bindBrowserScript: options.browserConnect?.bindBrowserScript ?? unexpectedTabOperation,
    close: unexpectedTabOperation,
    reopen: unexpectedTabOperation,
    activate: unexpectedTabOperation,
    organize: unexpectedTabOperation,
    updateGroup: unexpectedTabOperation,
    deleteGroup: unexpectedTabOperation,
    closeGroup: unexpectedTabOperation,
    get: unexpectedTabOperation,
    bootstrap: unexpectedTabOperation,
    requireOpenPage: unexpectedTabOperation,
    authorizeShow: unexpectedTabOperation,
    authorizeBind: unexpectedTabOperation,
    appsChanged: unexpectedTabOperation,
  };
  const home = { runnerId: createId("runner"), name: "Mac" };
  const url = await serveMcp(storeFixture, {
    browserProfiles: [{ id: profile, name: "Work", home: null }],
    tabHandlers: new TabToolHandlers(tabs, sessions),
    browser: new BrowserToolHandlers({
      sessions,
      tabs,
      scripts: recorded,
      confinement: new BrowserScriptConfinement(),
      profiles: async () => [
        { id: profile, name: "Work", home },
        { id: other, name: "Other", home },
      ],
      requireDevice: async () => DeviceIdSchema.parse(home.runnerId),
      issueTicket: options.browserConnect?.issueTicket ?? unexpectedTabOperation,
      ...(options.pooledBrowser ? { pooledBrowser: options.pooledBrowser } : {}),
      origin: new URL("https://home.example.test"),
    }),
  });
  const agent = await connection(storeFixture.store, url, {
    userId: f.userId,
    accessMode: options.accessMode ?? "full-access",
    grant: options.grant ?? granted,
  });
  const call = async (name: string, args: Record<string, unknown>, client = agent.client) => {
    const result = await client.callTool({ name, arguments: args });
    return result;
  };
  const ok = async (name: string, args: Record<string, unknown>, client = agent.client) => {
    const result = await call(name, args, client);
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return result.structuredContent as Record<string, unknown> & { taskId: string };
  };
  // These cases keep the executor observable after Disconnect closes the MCP transport.
  const direct = (operationKey: string) =>
    sessions.run({
      ownerUserId: f.userId,
      agentConnectionId: agent.id,
      operationKey,
      tool: "tab_open",
      input: { target: page(profile) },
      target: {
        grant: { kind: "browser-profile", profileId: profile },
        name: "Work",
        device: null,
      },
      effect: "write",
      calls: `tab_open ${JSON.stringify({ target: page(profile) })}`,
      execute: ({ signal }) => recorded.execute(signal),
    });
  return { f, sessions, url, agent, call, ok, direct, ...recorded };
}

describeStore("an external agent's direct work through sessions", (it) => {
  for (const cut of [
    "Stop",
    "Disconnect",
    "grant cut",
    "task-mode cut",
    "no cut",
    "refused before any send",
  ] as const) {
    it(`keeps an approved pooled script outside hand-off during wake with ${cut}`, async ({
      storeFixture,
    }) => {
      const { database, store } = storeFixture;
      const f = await storeFixture.startRunFixture(`approved-pool-${cut}`);
      const identity = {
        runnerId: f.runnerId,
        runtimeId: "pooled-browser",
        slotId: "slot",
        instanceId: randomUUID(),
        term: 1,
        epoch: 1,
      };
      const releaseWake = Promise.withResolvers<void>();
      const wakeStarted = Promise.withResolvers<void>();
      const waking = Promise.withResolvers<void>();
      const reserveCancelled = Promise.withResolvers<void>();
      const read = () => readBrowserPoolSlot(database, identity.runnerId);
      await installBrowserPoolSlot(database, identity);
      // The loop's facts without the slot row: only the gate holds work back. Demand on the
      // parked browser starts one wake, as the loop would.
      const gate = new BrowserPoolGate();
      gate.set({ recovered: true, away: "parked", hold: null });
      let woke = false;
      gate.onChange = () => {
        if (woke || gate.away !== "parked" || !gate.demand) return;
        woke = true;
        gate.set({ away: "waking" });
        wakeStarted.resolve();
        void releaseWake.promise
          .then(() => gate.set({ away: null }))
          .finally(() => waking.resolve());
      };
      const s = await setUp(storeFixture, `approved-pool-${cut}`, {
        run: f,
        accessMode: cut === "task-mode cut" ? "auto" : "approval-required",
        grant: {
          ...granted,
          resources: [...granted.resources, { kind: "browser-profile", profileId: other }],
        },
        pooledBrowser: () => ({
          identity: () => identity,
          pageDocument: () => undefined,
          reserve: async (signal) => {
            try {
              return await gate.reserve(signal);
            } finally {
              if (signal.aborted) reserveCancelled.resolve();
            }
          },
        }),
      });
      s.runBrowserScript.mockImplementation(async ({ browserSend }) => {
        expect(browserSend?.target).toEqual(identity);
        // The send-side check refuses after hand-off and before any command left the Home.
        if (cut === "refused before any send")
          throw new OperationOutcomeUnknown(
            "The connected agent's access changed during this work.",
          );
        await browserSend!.recheck();
        browserSend!.submitted();
        browserSend!.acknowledged();
        return { content: [{ type: "text", text: "done" }] };
      });
      const pending = await s.ok("browser_use", script);
      expect(pending.status).toBe("pending");
      const requestId = pending.requestId as RequestId;
      const revision = (await store.requests.revision(requestId))!;
      await s.sessions.respond({
        requestId,
        expectedRevision: revision,
        resolvedBy: f.userId,
        response: { kind: "form", answers: { decision: ["allow"] } },
      });
      const operation = () =>
        database
          .selectFrom("agentOperations")
          .selectAll()
          .where("requestId", "=", requestId)
          .executeTakeFirstOrThrow();
      expect(await operation()).toMatchObject({ state: "approved", handedOffAt: null });
      const resumed = s.call("browser_use", { ...script, operationId: pending.operationId }).then(
        (result) => result,
        () => null,
      );
      try {
        await wakeStarted.promise;
        expect(s.runBrowserScript).not.toHaveBeenCalled();
        expect(gate.phase).toBe("waking");
        expect(await read()).toMatchObject({ phase: "running" });
        expect(await operation()).toMatchObject({ state: "approved", handedOffAt: null });
        const current = await operation();
        const threadId = ThreadIdSchema.parse(pending.taskId);
        const home = commands(storeFixture, f.userId, {
          afterStop: (id, reason) => s.sessions.closeConnection(id, reason === "disconnect"),
        });
        switch (cut) {
          case "Stop":
            await s.sessions.stopSession({
              ownerUserId: f.userId,
              sessionId: current.sessionId,
              threadId,
            });
            break;
          case "Disconnect":
            await home.revoke(s.agent.id);
            break;
          case "grant cut":
            await home.update(s.agent.id, { grant: granted });
            break;
          case "task-mode cut":
            await store.updateThreadAccessMode({
              threadId,
              requestedBy: f.userId,
              accessMode: "approval-required",
            });
            await s.sessions.lowerTaskMode(threadId, "approval-required");
            break;
          case "refused before any send":
            releaseWake.resolve();
            expect(await resumed).toMatchObject({
              structuredContent: { status: "refused", error: { code: "access_changed" } },
            });
            expect(await operation()).toMatchObject({
              state: "refused",
              outcome: "refused",
              handedOffAt: expect.any(Date),
              terminalEvidenceAt: expect.any(Date),
            });
            break;
          case "no cut":
            releaseWake.resolve();
            expect(await resumed).toMatchObject({ structuredContent: { status: "completed" } });
            expect(await operation()).toMatchObject({
              state: "completed",
              terminalEvidenceAt: expect.any(Date),
            });
            expect(s.runBrowserScript).toHaveBeenCalledOnce();
            break;
        }
        if (cut !== "no cut" && cut !== "refused before any send") {
          await reserveCancelled.promise;
          await s.sessions.drain();
          expect(await operation()).toMatchObject({ state: "refused", handedOffAt: null });
          expect(s.runBrowserScript).not.toHaveBeenCalled();
        }
      } finally {
        releaseWake.resolve();
        await resumed;
        await waking.promise;
      }
    });
  }

  it("refuses a pooled send with nothing sent only for an admission or authority reason, and fails it for any other", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("pool-unsent");
    const identity = {
      runnerId: f.runnerId,
      runtimeId: "pooled-browser",
      slotId: "slot",
      instanceId: randomUUID(),
      term: 1,
      epoch: 1,
    };
    await installBrowserPoolSlot(storeFixture.database, identity);
    const gate = new BrowserPoolGate();
    gate.set({ recovered: true, away: null, hold: null });
    const s = await setUp(storeFixture, "pool-unsent", {
      run: f,
      pooledBrowser: () => ({
        identity: () => identity,
        pageDocument: () => undefined,
        reserve: (signal) => gate.reserve(signal),
      }),
    });
    const cases = [
      {
        // A closed admission: the device was removed, or the browser could not be reached.
        error: new BrowserPoolAdmissionClosed("This device was removed. Nothing was sent."),
        status: "refused",
        code: "computer_offline",
        decision: { by: "refused", reason: "changed" },
      },
      {
        // The page the call named changed: it reads as not found.
        error: new OpensteerError({ code: "not_found", message: "This tab is unavailable." }),
        status: "refused",
        code: "not_found",
        decision: { by: "refused", reason: "changed" },
      },
      {
        // The authority recheck before a send.
        error: new OperationOutcomeUnknown(
          "The connected agent's access changed during this work.",
        ),
        status: "refused",
        code: "access_changed",
        decision: { by: "refused", reason: "authority" },
      },
      {
        // The work's own conflict is not a refusal: it failed, with its own code.
        error: new OpensteerError({
          code: "conflict",
          message: "This browser profile is already exclusively held.",
        }),
        status: "failed",
        code: "conflict",
        decision: { by: "full-access" },
      },
      {
        // Nor is an error of the script's machinery.
        error: new Error("The script runtime could not start."),
        status: "failed",
        code: "internal_error",
        decision: { by: "full-access" },
      },
    ] as const;
    for (const [index, entry] of cases.entries()) {
      s.runBrowserScript.mockRejectedValueOnce(entry.error);
      const result = await s.call("browser_use", { ...script, code: `print(${index})` });
      expect(result, JSON.stringify(result.content)).toMatchObject({
        isError: true,
        structuredContent: { status: entry.status, error: { code: entry.code } },
      });
      // A refusal says nothing was sent; nothing says part of it may have happened.
      expect(JSON.stringify(result.content)).not.toContain("may have happened");
      if (entry.status === "refused" && entry.code !== "not_found")
        expect(result.structuredContent).toMatchObject({
          error: { next: expect.stringContaining("Nothing was sent.") },
        });
      expect(JSON.stringify(result.content)).not.toContain("runner_offline");
      const operation = await storeFixture.database
        .selectFrom("agentOperations")
        .select(["state", "outcome", "decision", "handedOffAt"])
        .where("id", "=", (result.structuredContent as { operationId: never }).operationId)
        .executeTakeFirstOrThrow();
      expect(operation).toMatchObject({
        state: entry.status,
        outcome: entry.status,
        decision: entry.decision,
        handedOffAt: expect.any(Date),
      });
    }
    expect(gate.held).toBe(0);
  });

  for (const sent of [true, false])
    it(`gives a pooled script that ignores a restart its recorded outcome, ${sent ? "unknown after a send" : "refused with nothing sent"}`, async ({
      storeFixture,
    }) => {
      const f = await storeFixture.startRunFixture(`pool-forced-${sent}`);
      const identity = {
        runnerId: f.runnerId,
        runtimeId: "pooled-browser",
        slotId: "slot",
        instanceId: randomUUID(),
        term: 1,
        epoch: 1,
      };
      await installBrowserPoolSlot(storeFixture.database, identity);
      const gate = new BrowserPoolGate();
      gate.set({ recovered: true, away: null, hold: null });
      const s = await setUp(storeFixture, `pool-forced-${sent}`, {
        run: f,
        pooledBrowser: () => ({
          identity: () => identity,
          pageDocument: () => undefined,
          reserve: (signal) => gate.reserve(signal),
        }),
      });
      const running = Promise.withResolvers<void>();
      const hang = Promise.withResolvers<void>();
      s.runBrowserScript.mockImplementationOnce(async ({ browserSend }) => {
        if (sent) {
          await browserSend!.recheck();
          browserSend!.submitted();
        }
        running.resolve();
        // It ignores its abort.
        await hang.promise;
        return { content: [{ type: "text", text: "late" }] };
      });
      const call = s.call("browser_use", script);
      await running.promise;
      // The restart holds admission, and after its wait records what each holder did.
      gate.set({ hold: "restart" });
      await gate.settleHolders();
      const operation = () =>
        storeFixture.database
          .selectFrom("agentOperations")
          .select(["state", "outcome", "decision"])
          .where("tool", "=", "browser_use")
          .executeTakeFirstOrThrow();
      expect(await operation()).toMatchObject(
        sent
          ? { state: "unknown", outcome: "unknown" }
          : {
              state: "refused",
              outcome: "refused",
              decision: { by: "refused", reason: "changed" },
            },
      );
      // The script returns later: what was recorded stands.
      hang.resolve();
      expect((await call).structuredContent).toMatchObject({ status: "unknown" });
      expect(await operation()).toMatchObject({ state: sent ? "unknown" : "refused" });
      gate.set({ hold: null });
      expect(gate.held).toBe(0);
    });

  it("gives a holder whose hand-off commits while a restart settles it a durable outcome before the restart goes on", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("pool-handoff-window");
    const identity = {
      runnerId: f.runnerId,
      runtimeId: "pooled-browser",
      slotId: "slot",
      instanceId: randomUUID(),
      term: 1,
      epoch: 1,
    };
    await installBrowserPoolSlot(storeFixture.database, identity);
    const gate = new BrowserPoolGate();
    gate.set({ recovered: true, away: null, hold: null });
    const database = storeFixture.database;
    // The operation's row is locked by another session just before the hand-off's write, so that
    // write waits: the holder is between its reservation and the execution's own settler.
    const locked = Promise.withResolvers<number>();
    const unlock = Promise.withResolvers<void>();
    let holder: Promise<unknown> | undefined;
    let settled: Promise<void> | undefined;
    const s = await setUp(storeFixture, "pool-handoff-window", {
      run: f,
      pooledBrowser: () => ({
        identity: () => identity,
        pageDocument: () => undefined,
        reserve: async (signal) => {
          const { id } = await database
            .selectFrom("agentOperations")
            .select("id")
            .where("tool", "=", "browser_use")
            .executeTakeFirstOrThrow();
          holder = database.transaction().execute(async (tx) => {
            const { pid } = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(tx))
              .rows[0]!;
            await tx
              .selectFrom("agentOperations")
              .select("id")
              .where("id", "=", id)
              .forUpdate()
              .execute();
            locked.resolve(pid);
            await unlock.promise;
          });
          await locked.promise;
          return gate.reserve(signal);
        },
      }),
    });
    s.runBrowserScript.mockResolvedValueOnce({ content: [{ type: "text", text: "ran" }] });
    const call = s.call("browser_use", script);
    void call.catch(() => undefined);
    try {
      const blockerPid = await locked.promise;
      // The hand-off's write waits on the lock; the restart begins and settles every holder.
      await vi.waitFor(
        async () => expect(await blockedBehind(database, blockerPid)).toBeGreaterThan(0),
        { timeout: 10_000 },
      );
      gate.set({ hold: "restart" });
      settled = gate.settleHolders();
      void settled.catch(() => undefined);
      await vi.waitFor(
        async () => expect(await blockedBehind(database, blockerPid)).toBeGreaterThan(1),
        { timeout: 10_000 },
      );
      // The hand-off commits first, then the settlement's own write.
      unlock.resolve();
      await holder;
      await settled;
      // Before the restart may stop the guest, the handed-off operation has its outcome: refused,
      // since nothing can have been sent while the hold stood.
      expect(
        await database
          .selectFrom("agentOperations")
          .select(["state", "outcome"])
          .where("tool", "=", "browser_use")
          .executeTakeFirstOrThrow(),
      ).toMatchObject({ state: "refused", outcome: "refused" });
      await call;
      gate.set({ hold: null });
      expect(gate.held).toBe(0);
    } finally {
      unlock.resolve();
      gate.set({ hold: null });
      await Promise.allSettled([holder, settled, call]);
    }
  });

  it("lets a holder's settler take its own refusal of a handed-off operation as the outcome, with nothing more read", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("pool-settler-answer");
    const identity = {
      runnerId: f.runnerId,
      runtimeId: "pooled-browser",
      slotId: "slot",
      instanceId: randomUUID(),
      term: 1,
      epoch: 1,
    };
    await installBrowserPoolSlot(storeFixture.database, identity);
    const database = storeFixture.database;
    // The seam: the reservation the holder takes is this one, so its settler is held here, and
    // the work is held after its hand-off, before anything is sent.
    let settle: (() => Promise<void>) | undefined;
    const work = Promise.withResolvers<{ content: { type: "text"; text: string }[] }>();
    const s = await setUp(storeFixture, "pool-settler-answer", {
      run: f,
      pooledBrowser: () => ({
        identity: () => identity,
        pageDocument: () => undefined,
        reserve: async () => ({
          release: () => {},
          // The holder's own settler, the first registered (the execution's replaces it later).
          onForcedEnd: (settler: () => Promise<void>) => {
            settle ??= settler;
          },
        }),
      }),
    });
    s.runBrowserScript.mockImplementationOnce(() => work.promise);
    const call = s.call("browser_use", script);
    const state = async () =>
      (
        await database
          .selectFrom("agentOperations")
          .select("state")
          .where("tool", "=", "browser_use")
          .executeTakeFirstOrThrow()
      ).state;
    await vi.waitFor(async () => expect(await state()).toBe("handed-off"), { timeout: 10_000 });
    expect(settle).toBeDefined();
    // The settler reads the row once, writes its refusal, and takes that write's answer as the
    // outcome: no second read of the operation.
    // Counted on every Kysely the Home holds (the service's own store included), outside a
    // transaction: the reads, not the refusal's own write.
    let kysely = Object.getPrototypeOf(database) as {
      selectFrom: (...args: unknown[]) => unknown;
    };
    while (!Object.hasOwn(kysely, "selectFrom")) kysely = Object.getPrototypeOf(kysely);
    const select = kysely.selectFrom;
    const operationReads: unknown[] = [];
    kysely.selectFrom = function (this: { isTransaction: boolean }, ...args: unknown[]) {
      if (!this.isTransaction && args[0] === "agentOperations") operationReads.push(args[0]);
      return select.apply(this, args);
    };
    try {
      await settle!();
    } finally {
      kysely.selectFrom = select;
    }
    expect(operationReads).toHaveLength(1);
    expect(await state()).toBe("refused");
    work.resolve({ content: [{ type: "text", text: "ran" }] });
    await call.catch(() => undefined);
  });

  it("ends a restart's settlement of a holder whose row stays locked with the step's deadline", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("pool-settle-locked");
    const identity = {
      runnerId: f.runnerId,
      runtimeId: "pooled-browser",
      slotId: "slot",
      instanceId: randomUUID(),
      term: 1,
      epoch: 1,
    };
    await installBrowserPoolSlot(storeFixture.database, identity);
    const gate = new BrowserPoolGate();
    gate.set({ recovered: true, away: null, hold: null });
    const database = storeFixture.database;
    const locked = Promise.withResolvers<number>();
    const unlock = Promise.withResolvers<void>();
    let holder: Promise<unknown> | undefined;
    let settled: Promise<void> | undefined;
    const s = await setUp(storeFixture, "pool-settle-locked", {
      run: f,
      pooledBrowser: () => ({
        identity: () => identity,
        pageDocument: () => undefined,
        reserve: async (signal) => {
          const { id } = await database
            .selectFrom("agentOperations")
            .select("id")
            .where("tool", "=", "browser_use")
            .executeTakeFirstOrThrow();
          holder = database.transaction().execute(async (tx) => {
            const { pid } = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(tx))
              .rows[0]!;
            await tx
              .selectFrom("agentOperations")
              .select("id")
              .where("id", "=", id)
              .forUpdate()
              .execute();
            locked.resolve(pid);
            await unlock.promise;
          });
          await locked.promise;
          return gate.reserve(signal);
        },
      }),
    });
    s.runBrowserScript.mockResolvedValueOnce({ content: [{ type: "text", text: "ran" }] });
    const call = s.call("browser_use", script);
    void call.catch(() => undefined);
    try {
      const blockerPid = await locked.promise;
      await vi.waitFor(
        async () => expect(await blockedBehind(database, blockerPid)).toBeGreaterThan(0),
        { timeout: 10_000 },
      );
      gate.set({ hold: "restart" });
      // The row stays locked: the settlement waits on it only until its step's deadline.
      const started = Date.now();
      settled = withDatabaseOperationSignal(AbortSignal.timeout(1_000), Date.now() + 1_000, () =>
        gate.settleHolders(),
      );
      const outcome = await withTimeout(settled, 10_000, {
        timeoutError: () => new Error("The settlement still waits on the locked row."),
      }).then(
        () => "settled",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      expect(outcome).not.toBe("The settlement still waits on the locked row.");
      expect(outcome).not.toBe("settled");
      expect(Date.now() - started).toBeLessThan(5_000);
      // And nothing of it is left behind: no statement of the settlement still waits on the row
      // after its step ended (only the hand-off's own write does).
      await vi.waitFor(async () =>
        expect(
          (
            await sql<{ query: string }>`
              select query from pg_stat_activity
              where datname = current_database() and wait_event_type = 'Lock'
                and query like 'update "agent_operations" set "state" = $1, "outcome"%'
            `.execute(database)
          ).rows,
        ).toEqual([]),
      );
      unlock.resolve();
      await holder;
      gate.set({ hold: null });
    } finally {
      unlock.resolve();
      gate.set({ hold: null });
      await Promise.allSettled([holder, settled, call]);
    }
  });

  it("settles a holder whose operation was reviewed again while it waited, with its current revision", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("pool-settle-revised");
    const identity = {
      runnerId: f.runnerId,
      runtimeId: "pooled-browser",
      slotId: "slot",
      instanceId: randomUUID(),
      term: 1,
      epoch: 1,
    };
    await installBrowserPoolSlot(storeFixture.database, identity);
    const gate = new BrowserPoolGate();
    gate.set({ recovered: true, away: null, hold: null });
    const database = storeFixture.database;
    const locked = Promise.withResolvers<number>();
    const unlock = Promise.withResolvers<void>();
    let holder: Promise<unknown> | undefined;
    let settled: Promise<void> | undefined;
    const s = await setUp(storeFixture, "pool-settle-revised", {
      run: f,
      pooledBrowser: () => ({
        identity: () => identity,
        pageDocument: () => undefined,
        reserve: async (signal) => {
          const { id } = await database
            .selectFrom("agentOperations")
            .select("id")
            .where("tool", "=", "browser_use")
            .executeTakeFirstOrThrow();
          // The operation is reviewed again under a newer grant while its holder waits: the
          // review commits after the hand-off and the restart's settlement both read it.
          holder = database.transaction().execute(async (tx) => {
            const { pid } = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(tx))
              .rows[0]!;
            await tx
              .selectFrom("agentOperations")
              .select("id")
              .where("id", "=", id)
              .forUpdate()
              .execute();
            await tx
              .updateTable("agentOperations")
              .set({ grantRevision: sql`grant_revision + 1` })
              .where("id", "=", id)
              .execute();
            locked.resolve(pid);
            await unlock.promise;
          });
          await locked.promise;
          return gate.reserve(signal);
        },
      }),
    });
    s.runBrowserScript.mockResolvedValueOnce({ content: [{ type: "text", text: "ran" }] });
    const call = s.call("browser_use", script);
    void call.catch(() => undefined);
    try {
      const blockerPid = await locked.promise;
      await vi.waitFor(
        async () => expect(await blockedBehind(database, blockerPid)).toBeGreaterThan(0),
        { timeout: 10_000 },
      );
      gate.set({ hold: "restart" });
      settled = gate.settleHolders();
      void settled.catch(() => undefined);
      await vi.waitFor(
        async () => expect(await blockedBehind(database, blockerPid)).toBeGreaterThan(1),
        { timeout: 10_000 },
      );
      unlock.resolve();
      await holder;
      await settled;
      expect(
        await database
          .selectFrom("agentOperations")
          .select(["state", "outcome"])
          .where("tool", "=", "browser_use")
          .executeTakeFirstOrThrow(),
      ).toMatchObject({ state: "refused", outcome: "refused" });
      await call;
      gate.set({ hold: null });
    } finally {
      unlock.resolve();
      gate.set({ hold: null });
      await Promise.allSettled([holder, settled, call]);
    }
  });

  it("refuses a pooled operation whose reservation failed under the revision it holds now, after it was reviewed again", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("pool-reserve-revised");
    const identity = {
      runnerId: f.runnerId,
      runtimeId: "pooled-browser",
      slotId: "slot",
      instanceId: randomUUID(),
      term: 1,
      epoch: 1,
    };
    await installBrowserPoolSlot(storeFixture.database, identity);
    const database = storeFixture.database;
    const s = await setUp(storeFixture, "pool-reserve-revised", {
      run: f,
      pooledBrowser: () => ({
        identity: () => identity,
        pageDocument: () => undefined,
        // The operation is reviewed again while its reservation waits; then the reservation
        // fails, with nothing handed off.
        reserve: async () => {
          await database
            .updateTable("agentOperations")
            .set({ grantRevision: sql`grant_revision + 1` })
            .where("tool", "=", "browser_use")
            .execute();
          throw new Error("The browser could not be reserved.");
        },
      }),
    });
    await s.call("browser_use", script).catch(() => undefined);
    expect(
      await database
        .selectFrom("agentOperations")
        .select(["state", "outcome"])
        .where("tool", "=", "browser_use")
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ state: "refused", outcome: "refused" });
  });

  it("starts a session on the first direct call, continues it across transports, and refuses input to its task", async ({
    storeFixture,
  }) => {
    const { database, store } = storeFixture;
    const s = await setUp(storeFixture, "session-start");
    // A browser-only agent works on a Home where no native engine is enabled.
    await database.updateTable("harnessInstances").set({ enabled: false }).execute();
    const first = await s.ok("discover", { id: profile });
    expect(first).toMatchObject({ status: "completed", items: [] });
    const task = await database
      .selectFrom("threads")
      .select(["id", "worker", "listed", "status", "originConnectionId"])
      .where("id", "=", first.taskId as never)
      .executeTakeFirstOrThrow();
    expect(task).toMatchObject({
      worker: "external",
      listed: true,
      status: "running",
      originConnectionId: s.agent.id,
    });
    // A second transport of the same connection continues the one session.
    const second = new Client({ name: "second-transport", version: "1" });
    clients.push(second);
    await second.connect(
      new StreamableHTTPClientTransport(s.url, {
        requestInit: { headers: { Authorization: `Bearer ${s.agent.token}` } },
      }) as unknown as Transport,
      { timeout: 5000 },
    );
    expect((await s.ok("discover", { id: profile }, second)).taskId).toBe(first.taskId);
    const service = lastService!;
    const caller = await service.options.callers.authenticate(s.agent.token);
    expect(
      await service.options.handlers.tab_list!({
        caller,
        input: {},
        operationKey: "retained-whole-tab-read",
      }),
    ).toMatchObject({
      status: "completed",
      taskId: first.taskId,
      tabs: [],
      groups: [],
      nextCursor: null,
    });
    await expect(
      store.enqueueThreadInput({
        requestedBy: s.f.userId,
        threadId: first.taskId as never,
        content: [{ type: "text", text: "Do something else" }],
        source: { kind: "human" },
        policy: "queue",
        idempotencyKey: "input-to-session-task",
      }),
    ).rejects.toMatchObject({ reason: "external-agent-task" });
  });

  it("ends a session on Stop: calls naming it are refused, the next one is told once, then a new one starts", async ({
    storeFixture,
  }) => {
    const s = await setUp(storeFixture, "session-stop");
    const { taskId } = await s.ok("discover", { id: profile });
    const session = await storeFixture.database
      .selectFrom("agentSessions")
      .select("id")
      .where("threadId", "=", taskId as never)
      .executeTakeFirstOrThrow();
    // A late Stop for some other session on this task ends nothing.
    expect(
      await s.sessions.stopSession({
        ownerUserId: s.f.userId,
        threadId: taskId as never,
        sessionId: createId("agentSession"),
      }),
    ).toEqual({ ended: false });
    expect(
      await s.sessions.stopSession({
        ownerUserId: s.f.userId,
        threadId: taskId as never,
        sessionId: session.id,
      }),
    ).toEqual({ ended: true });
    expect(
      await storeFixture.database
        .selectFrom("threads")
        .select("status")
        .where("id", "=", taskId as never)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "idle" });
    // The task row clients receive still names the agent and why its session ended.
    const published = await storeFixture.database
      .selectFrom("clientChanges")
      .select("payload")
      .where("scopeKey", "=", "shell")
      .where("entityKind", "=", "task")
      .where("entityId", "=", taskId)
      .orderBy("sequence", "desc")
      .executeTakeFirstOrThrow();
    expect(published.payload).toMatchObject({
      externalWork: {
        sessionId: session.id,
        status: "ended",
        endReason: "stopped",
        connection: { id: s.agent.id, label: "Test agent", clientName: "Test agent" },
      },
    });
    const stopped = "The person stopped this work. Do not continue it; ask before starting again.";
    expect(errorText(await s.call("discover", { id: profile, taskId }))).toBe(stopped);
    expect(errorText(await s.call("discover", { id: profile }))).toBe(stopped);
    const next = await s.ok("discover", { id: profile });
    expect(next.taskId).not.toBe(taskId);
    expect(errorText(await s.call("discover", { id: profile, taskId }))).toBe(stopped);
  });

  it("returns guidance instead of reissuing a completed browser connection", async ({
    storeFixture,
  }) => {
    const tabId = createId("tab");
    const sessionId = BrowserSessionIdSchema.parse(`bsn_${randomUUID()}`);
    const issueTicket = vi.fn<BrowserToolPorts["issueTicket"]>(async () => {
      const ticket = randomUUID();
      return { ticket, path: `/cdp/${ticket}`, mode: "whole-context" };
    });
    const s = await setUp(storeFixture, "session-browser-connect-repeat", {
      browserConnect: {
        open: async () => {
          const timestamp = new Date().toISOString();
          return {
            tab: {
              tabId,
              kind: "page",
              title: "Work",
              computer: { computerId: DeviceIdSchema.parse(createId("runner")), name: "Mac" },
              groupId: null,
              state: "open",
              openedBy: "person",
              usedBy: [],
              createdAt: timestamp,
              updatedAt: timestamp,
              url: "about:blank",
              profile: { profileId: profile, name: "Work" },
            },
          };
        },
        bindBrowserScript: async () => ({
          tabId,
          sessionId,
          backend: "cdp",
          reloaded: false,
          grantRevision: null,
        }),
        issueTicket,
      },
    });
    const args = { profileId: profile };
    const first = await s.ok("browser_connect", args);
    expect(first).toMatchObject({ status: "completed", endpoint: expect.any(String) });
    const repeat = await s.ok("browser_connect", { ...args, operationId: first.operationId });
    expect(repeat).toEqual({
      taskId: first.taskId,
      operationId: first.operationId,
      status: "completed",
      summary: { tabId, mode: "whole-context" },
      next: "This connection was already handed out. Call browser_connect without the operationId for a new connection.",
    });
    expect(issueTicket).toHaveBeenCalledOnce();

    const fresh = await s.ok("browser_connect", args);
    expect(fresh).toMatchObject({ status: "completed", endpoint: expect.any(String) });
    expect(fresh.operationId).not.toBe(first.operationId);
    expect(fresh.endpoint).not.toBe(first.endpoint);
    expect(issueTicket).toHaveBeenCalledTimes(2);
  });

  it("names the same stoppable session in the owner's task and Now while an approved call runs", async ({
    storeFixture,
  }) => {
    const s = await setUp(storeFixture, "session-owner-stop", { accessMode: "approval-required" });
    const { database, store } = storeFixture;
    const pending = await s.ok("browser_use", script);
    expect(pending.status).toBe("pending");
    const threadId = ThreadIdSchema.parse(pending.taskId);
    const requestId = pending.requestId as RequestId;
    const request = await store.requests.get(requestId);
    const sessionId = request?.originatingAgentSessionId;
    if (!sessionId) throw new Error("The pending Request did not name its session");
    const sessions = () =>
      database
        .selectFrom("agentSessions")
        .select(["id", "threadId", "status"])
        .where("connectionId", "=", s.agent.id)
        .execute();
    expect(await sessions()).toEqual([{ id: sessionId, threadId, status: "active" }]);
    const revision = await store.requests.revision(requestId);
    if (!revision) throw new Error("Missing Request revision");
    await s.sessions.respond({
      requestId,
      expectedRevision: revision,
      resolvedBy: s.f.userId,
      response: { kind: "form", answers: { decision: ["allow"] } },
    });
    expect(await sessions()).toEqual([{ id: sessionId, threadId, status: "active" }]);

    const held = s.holdNext();
    const running = s.call("browser_use", { ...script, operationId: pending.operationId });
    try {
      await held.started;
      expect(await sessions()).toEqual([{ id: sessionId, threadId, status: "active" }]);
      const owner = {
        session: {
          id: createId("authSession"),
          user: {
            id: s.f.userId,
            disabledAt: null,
            displayName: "Owner",
            email: "owner@example.test",
            emailVerified: true,
            image: null,
          },
        },
        surface: "canonical",
      } as Parameters<ReturnType<typeof createPersonalReads>["handlers"]["personal.shell.get"]>[1];
      const { handlers } = createPersonalReads({ store } as never, {} as never);
      const shell = await handlers["personal.shell.get"]({}, owner);
      const detail = await handlers["thread.snapshot.get"]({ threadId }, owner);
      const activity = await createConnectionRpcHandlers({
        store: new AgentConnectionStore(database),
      } as never)["threads.activity"]({ threadId }, owner);
      if (!shell.ok || !detail.ok || !activity.ok) throw new Error("The owner's read failed");
      const row = shell.data.tasks.find(({ id }) => id === threadId);
      if (!row) throw new Error("The owner’s shell did not include the running task");
      expect(shell.data.activeTaskIds).toContain(threadId);
      expect(row).toMatchObject({
        status: "running",
        agentSessionId: sessionId,
        externalWork: { sessionId },
      });
      expect(detail.data.thread).toMatchObject({
        status: "running",
        agentSessionId: sessionId,
        externalWork: { sessionId },
      });
      expect(activity.data.operations).toMatchObject([
        { id: pending.operationId, state: "handed-off" },
      ]);
      const now = connectedAgentsNow({
        tasks: [{ ...row, externalWork: row.externalWork ?? null }],
        waitingRequests: [],
        operations: activity.data.operations,
      });
      expect(now.agents).toMatchObject([{ threadId, sessionId }]);
      const view = sessionTaskView({
        thread: detail.data.thread,
        slot: sessionSlotFromHome(detail.data.thread.externalWork, activity.data.operations),
      });
      expect(view?.stop?.sessionId).toBe(sessionId);

      await s.sessions.stopSession({ ownerUserId: s.f.userId, threadId, sessionId });
      expect(await running).toMatchObject({
        structuredContent: {
          taskId: threadId,
          operationId: pending.operationId,
          status: "unknown",
          error: { code: "stopped_by_person" },
        },
      });
      expect(await sessions()).toEqual([{ id: sessionId, threadId, status: "ended" }]);
      expect(s.runBrowserScript).toHaveBeenCalledOnce();
    } finally {
      held.release();
      await running.catch(() => undefined);
    }
  });

  it("resumes by operationId without a key and replays the receipt after idle and restart", async ({
    storeFixture,
  }) => {
    const s = await setUp(storeFixture, "session-operation-id", {
      accessMode: "approval-required",
    });
    const pending = await s.ok("browser_use", script);
    expect(pending).toMatchObject({
      status: "pending",
      next: expect.stringMatching(/same arguments and this operationId.*up to 25 seconds/u),
    });
    const resume = { ...script, operationId: pending.operationId };
    const foreign = await connection(storeFixture.store, s.url, {
      userId: s.f.userId,
      accessMode: "approval-required",
      grant: granted,
    });
    const wrongArgs = await s.call("browser_use", { ...resume, code: 'print("different")' });
    expect(wrongArgs.isError).toBe(true);
    const wrongCaller = await s.call("browser_use", resume, foreign.client);
    const missing = await s.call(
      "browser_use",
      { ...resume, operationId: createId("agentOperation") },
      foreign.client,
    );
    expect(wrongCaller.isError).toBe(true);
    expect(errorText(wrongCaller)).toBe(errorText(missing));
    const requestId = pending.requestId as RequestId;
    const revision = await storeFixture.store.requests.revision(requestId);
    if (!revision) throw new Error("Missing Request revision");
    await s.sessions.respond({
      requestId,
      expectedRevision: revision,
      resolvedBy: s.f.userId,
      response: { kind: "form", answers: { decision: ["allow"] } },
    });
    expect(await s.ok("browser_use", resume)).toMatchObject({
      status: "completed",
      operationId: pending.operationId,
      taskId: pending.taskId,
    });
    await s.sessions.endIdle(Date.now() + agentSessionIdleMs + 1);
    expect(
      await storeFixture.database
        .selectFrom("agentSessions")
        .select("status")
        .where("threadId", "=", pending.taskId as never)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "ended" });
    const restarted = new AgentSessionService({ store: storeFixture.store, holdMs: 0 });
    await restarted.start();
    restarted.stop();
    expect(await s.ok("browser_use", resume)).toMatchObject({
      status: "completed",
      operationId: pending.operationId,
      taskId: pending.taskId,
    });
    expect(s.runBrowserScript).toHaveBeenCalledOnce();
    expect(
      await storeFixture.database
        .selectFrom("agentSessions")
        .select("threadId")
        .where("connectionId", "=", s.agent.id)
        .execute(),
    ).toEqual([{ threadId: pending.taskId }]);
  });

  it("keeps the grant revision on rename and closes an obsolete Request on a real change", async ({
    storeFixture,
  }) => {
    const s = await setUp(storeFixture, "session-revision", { accessMode: "auto" });
    const pending = await s.ok("browser_use", script);
    const requestId = pending.requestId as RequestId;
    const connections = new AgentConnectionStore(storeFixture.database);
    const revision = await storeFixture.database
      .selectFrom("agentConnections")
      .select("grantRevision")
      .where("id", "=", s.agent.id)
      .executeTakeFirstOrThrow();
    const renamed = await connections.update(s.f.userId, {
      connectionId: s.agent.id,
      expectedRevision: revision.grantRevision,
      label: "Renamed agent",
    });
    expect(renamed.connection.grantRevision).toBe(revision.grantRevision);
    expect(await storeFixture.store.requests.get(requestId)).toMatchObject({ status: "pending" });
    const changed = await connections.update(s.f.userId, {
      connectionId: s.agent.id,
      expectedRevision: revision.grantRevision,
      accessMode: "approval-required",
    });
    expect(changed.connection.grantRevision).toBe(revision.grantRevision + 1);
    expect(await storeFixture.store.requests.get(requestId)).toMatchObject({ status: "cancelled" });
    expect(
      await storeFixture.database
        .selectFrom("agentOperations")
        .select(["state", "outcome"])
        .where("requestId", "=", requestId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "refused", outcome: "refused" });
    expect(s.runBrowserScript).not.toHaveBeenCalled();
  });

  it("closes a Request on a lowered task mode and does not revive it on restore", async ({
    storeFixture,
  }) => {
    const { store } = storeFixture;
    const s = await setUp(storeFixture, "session-mode-requests", { accessMode: "auto" });
    const pending = await s.ok("browser_use", script);
    const taskId = ThreadIdSchema.parse(pending.taskId);
    const requestId = pending.requestId as RequestId;
    const attention = async () =>
      (await needsYouPage(store.database, { userId: s.f.userId })).entries.flatMap((entry) =>
        entry.kind === "request" ? [entry.request.id] : [],
      );
    const accessMode = (mode: ThreadAccessMode) =>
      store.updateThreadAccessMode({ threadId: taskId, requestedBy: s.f.userId, accessMode: mode });
    const resume = () => s.call("browser_use", { ...script, operationId: pending.operationId });
    expect(await attention()).toContain(requestId);
    const lowered = await accessMode("approval-required");
    expect(lowered.thread.pendingRequests).toBe(0);
    expect(await store.requests.get(requestId)).toMatchObject({ status: "cancelled" });
    expect(await attention()).not.toContain(requestId);
    const refused = await resume();
    expect(refused).toMatchObject({
      isError: true,
      structuredContent: {
        status: "refused",
        operationId: pending.operationId,
        error: { code: "access_changed" },
      },
    });
    await accessMode("auto");
    expect(await resume()).toEqual(refused);
    expect(await attention()).not.toContain(requestId);
    expect(s.runBrowserScript).not.toHaveBeenCalled();
  });

  it("replays a recorded discover receipt for its connection only and rechecks its target", async ({
    storeFixture,
  }) => {
    const s = await setUp(storeFixture, "discover-replay");
    const service = lastService!;
    const args = { id: profile };
    const identity = { operationKey: "discover-replay" };
    const call = (token: string) => service.callTool(token, "discover", args, identity);
    const initial = await call(s.agent.token);
    expect(initial).toMatchObject({
      status: "completed",
      items: [],
      operationId: expect.any(String),
    });
    const { taskId, operationId } = initial as { taskId: string; operationId: string };
    const repeat = await call(s.agent.token);
    expect(repeat).toMatchObject({
      taskId,
      operationId,
      status: "completed",
      replayed: true,
      next: expect.stringContaining("stored receipt"),
    });
    expect(repeat).not.toHaveProperty("items");
    const other = await connection(storeFixture.store, s.url, {
      userId: s.f.userId,
      accessMode: "full-access",
      grant: granted,
    });
    const independent = await call(other.token);
    expect(independent).toMatchObject({ status: "completed", items: [] });
    expect(independent).not.toHaveProperty("operationId", operationId);
    expect(
      await storeFixture.database
        .selectFrom("agentOperations")
        .select("connectionId")
        .where("operationKey", "=", identity.operationKey)
        .execute(),
    ).toEqual(expect.arrayContaining([{ connectionId: s.agent.id }, { connectionId: other.id }]));
    // Still a browser grant, so only the profile's own authority can refuse the repeat.
    await commands(storeFixture, s.f.userId).update(s.agent.id, {
      grant: {
        ...granted,
        resources: [{ kind: "browser-profile", profileId: createId("browserProfile") }],
      },
    });
    const hidden = await service.callToolResult(s.agent.token, "discover", args, identity);
    const missing = await service.callToolResult(
      s.agent.token,
      "discover",
      { id: createId("browserProfile") },
      identity,
    );
    expect(JSON.stringify(hidden)).toBe(JSON.stringify(missing));
    expect(hidden.structuredContent).toEqual({
      error: {
        code: "not_found",
        message: "That item is unavailable.",
        next: null,
      },
    });
  });

  it("marks a repeated discovery read even if its outcome is still unknown", async ({
    storeFixture,
  }) => {
    const s = await setUp(storeFixture, "in-flight-discover-replay");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const execute = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      return [];
    });
    const operation = {
      ownerUserId: s.f.userId,
      agentConnectionId: s.agent.id,
      operationKey: "in-flight-discover",
      tool: "tab_list",
      input: {},
      target: null,
      effect: "read",
      calls: "tab_list {}",
      reportReplay: true,
      execute,
    } as const;
    const original = s.sessions.run(operation);
    await entered.promise;
    try {
      // A process without the in-memory hand-off can give the stored identity and
      // its unknown outcome, but has no result to return.
      const replacement = new AgentSessionService({ store: storeFixture.store, holdMs: 0 });
      const row = await storeFixture.database
        .selectFrom("agentOperations")
        .select("id")
        .where("operationKey", "=", operation.operationKey)
        .executeTakeFirstOrThrow();
      expect(await replacement.run(operation)).toEqual({
        taskId: expect.any(String),
        operationId: row.id,
        status: "unknown",
        next: expect.any(String),
        replayed: true,
      });
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await original;
    }
  });

  it("hides a completed operation when narrowing removes its tool", async ({ storeFixture }) => {
    const s = await setUp(storeFixture, "session-unlisted-receipt");
    const completed = await s.ok("browser_use", script);
    expect(completed.status).toBe("completed");
    await commands(storeFixture, s.f.userId).update(s.agent.id, {
      grant: { scope: "selected", tasks: true, resources: [] },
    });
    const client = new Client({ name: "Narrowed agent", version: "1" });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(s.url), {
        requestInit: { headers: { authorization: `Bearer ${s.agent.token}` } },
      }) as unknown as Transport,
    );
    expect((await client.listTools()).tools.map(({ name }) => name)).not.toContain("browser_use");
    const missing = await s.call(
      "browser_use",
      {
        ...script,
        operationId: createId("agentOperation"),
      },
      client,
    );
    expect(missing).toMatchObject({ isError: true });
    expect(missing.content).toEqual([
      { type: "text", text: "MCP error -32602: Tool browser_use not found" },
    ]);
    expect(
      await s.call("browser_use", { ...script, operationId: completed.operationId }, client),
    ).toEqual(missing);
    expect(s.runBrowserScript).toHaveBeenCalledOnce();
  });

  it("records a throwing browser script as failed and replays the same error receipt", async ({
    storeFixture,
  }) => {
    const s = await setUp(storeFixture, "session-browser-script-failed");
    const repl = new BrowserReplService({
      port: {
        listPages: async () => [],
        openPage: async () => {
          throw new Error("No page was requested");
        },
        newPage: async () => {
          throw new Error("No page was requested");
        },
        command: async () => {
          throw new Error("No command was requested");
        },
        subscribe: () => () => {},
      },
    });
    try {
      s.runBrowserScript.mockImplementation(({ code, signal }) =>
        repl.execute("failure", code, signal),
      );
      const args = { ...script, code: 'throw new Error("Browser script failed here")' };
      const first = await s.call("browser_use", args);
      const receipt = first.structuredContent as Record<string, unknown>;
      expect(first).toMatchObject({
        isError: true,
        structuredContent: {
          taskId: expect.any(String),
          operationId: expect.any(String),
          status: "failed",
          profileId: profile,
          next: expect.stringContaining("Earlier steps may have taken effect"),
          error: { message: expect.stringContaining("Browser script failed here") },
        },
      });
      const activity = await listAgentOperations(storeFixture.database, {
        userId: s.f.userId,
        connectionId: s.agent.id,
        limit: 10,
      });
      expect(activity.operations).toContainEqual(
        expect.objectContaining({
          id: receipt.operationId,
          state: "failed",
          outcome: "failed",
        }),
      );
      const replay = await s.call("browser_use", { ...args, operationId: receipt.operationId });
      expect(replay).toMatchObject({ isError: true, structuredContent: receipt });
      expect(s.runBrowserScript).toHaveBeenCalledOnce();
    } finally {
      await repl.close();
    }
  });

  it("asks the person in approval-required, executes an approval exactly once under two resumes, and refuses a denial", async ({
    storeFixture,
  }) => {
    const { database } = storeFixture;
    const s = await setUp(storeFixture, "session-approval", { accessMode: "approval-required" });
    const code = "print(`\n# Heading\n**bold** _emphasis_ <tag>\n`)";
    const reviewedScript = { ...script, code, operationKey: "open-1" };
    const pending = await s.ok("browser_use", reviewedScript);
    expect(pending).toMatchObject({ status: "pending", requestId: expect.any(String) });
    expect(s.runBrowserScript).not.toHaveBeenCalled();
    const opened = storeFixture.reactions.find(
      (reaction) =>
        reaction.type === "requestChanged" &&
        reaction.requestId === pending.requestId &&
        reaction.opened,
    );
    if (opened?.type !== "requestChanged")
      throw new Error("No notification transition for the held Request");
    const onLive = vi.fn();
    const onError = vi.fn();
    const notifications = new NotificationDispatcher({
      store: new NotificationStore(database),
      onLive,
      onError,
      onWarning: onError,
      ready: Promise.resolve(),
    });
    notifications.dispatch(opened);
    await notifications.drain();
    expect(onError).not.toHaveBeenCalled();
    expect(onLive).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        userId: s.f.userId,
        view: expect.objectContaining({
          kind: "request-opened",
          requestId: pending.requestId,
          threadId: pending.taskId,
          body: "Run a script in Work?",
        }),
      }),
    );
    const request = await database
      .selectFrom("requests")
      .select([
        "id",
        "kind",
        "status",
        "originatingAgentSessionId",
        "revision",
        "presentation",
        "agentOperation",
      ])
      .where("id", "=", pending.requestId as never)
      .executeTakeFirstOrThrow();
    expect(request).toMatchObject({ kind: "person.question", status: "pending" });
    // The Request carries the operation in its parts, and the task's activity lists it.
    expect(await storeFixture.store.requests.get(request.id as RequestId)).toMatchObject({
      agentOperation: {
        connectionId: s.agent.id,
        target: { name: "Work" },
        calls: code,
        agentReason: null,
        decisionFieldId: "decision",
      },
    });
    const reads = createConnectionRpcHandlers({
      store: new AgentConnectionStore(database),
    } as never);
    const ownerContext = {
      session: { id: "session", user: { id: s.f.userId, disabledAt: null } },
    } as never;
    expect(
      await reads["threads.activity"]({ threadId: pending.taskId as never }, ownerContext),
    ).toMatchObject({
      ok: true,
      data: { operations: [{ tool: "browser_use", state: "pending" }], nextBefore: null },
    });
    expect(
      await reads["connections.activity"]({ connectionId: s.agent.id }, ownerContext),
    ).toMatchObject({
      ok: true,
      data: {
        operations: [
          {
            id: pending.operationId,
            taskId: pending.taskId,
            tool: "browser_use",
            state: "pending",
          },
        ],
      },
    });
    expect(request.originatingAgentSessionId).toBeTruthy();
    expect(request.presentation).toMatchObject({
      title: "Run a script in Work?",
      detailFormat: "plain",
      detail: `Work · Mac\n“\u2068Test agent\u2069” wants to run a script in Work.\n\nWhat it will run:\n${code}`,
      fields: [{ choices: [{ label: "Allow once" }, { label: "Don't allow" }] }],
    });
    expect(request.agentOperation).toMatchObject({
      summary: "Work · Mac\n“\u2068Test agent\u2069” wants to run a script in Work.",
    });
    expect(
      await database
        .selectFrom("threads")
        .select("status")
        .where("id", "=", pending.taskId as never)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "waiting" });
    // A repeat before the answer is still pending, and a different call cannot take its key.
    expect(await s.ok("browser_use", reviewedScript)).toMatchObject({
      status: "pending",
    });
    expect(
      errorText(
        await s.call("browser_use", {
          ...script,
          code: 'print("changed")',
          operationKey: "open-1",
        }),
      ),
    ).toBe("This operationKey already names a different call.");
    await s.sessions.respond({
      requestId: request.id as RequestId,
      expectedRevision: request.revision,
      resolvedBy: s.f.userId,
      response: { kind: "form", answers: { decision: ["allow"] } },
    });
    // A stale approval never executes a different operation.
    expect(await s.ok("browser_use", { ...script, operationKey: "open-2" })).toMatchObject({
      status: "pending",
    });
    expect(s.runBrowserScript).not.toHaveBeenCalled();
    const held = s.holdNext();
    const resumes = [s.ok("browser_use", reviewedScript), s.ok("browser_use", reviewedScript)];
    await held.started;
    held.release();
    const both = await Promise.all(resumes);
    expect(both.map(({ status }) => status)).toEqual(["completed", "completed"]);
    expect(s.runBrowserScript).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        authority: {
          agentBindingId: `session:${request.originatingAgentSessionId}`,
          ownerId: s.f.userId,
        },
        contextKey: profile,
        code,
      }),
    );
    // The person declines the second: resuming it is refused and nothing runs.
    const second = await database
      .selectFrom("agentOperations")
      .innerJoin("requests", "requests.id", "agentOperations.requestId")
      .select(["requests.id", "requests.revision"])
      .where("agentOperations.operationKey", "=", "open-2")
      .executeTakeFirstOrThrow();
    await s.sessions.respond({
      requestId: second.id as RequestId,
      expectedRevision: second.revision,
      resolvedBy: s.f.userId,
      response: { kind: "form", answers: { decision: ["deny"] } },
    });
    expect(errorText(await s.call("browser_use", { ...script, operationKey: "open-2" }))).toBe(
      "The person did not allow it.",
    );
    expect(s.runBrowserScript).toHaveBeenCalledOnce();
  });

  it("uses a plain fallback for an unmapped operation in the person's request", async ({
    storeFixture,
  }) => {
    const s = await setUp(storeFixture, "session-unmapped-copy", {
      accessMode: "approval-required",
    });
    const result = await s.sessions.run({
      ownerUserId: s.f.userId,
      agentConnectionId: s.agent.id,
      operationKey: "unmapped-copy",
      tool: "unmapped_internal_tool",
      input: {},
      target: {
        grant: { kind: "browser-profile", profileId: profile },
        name: "Work",
        device: null,
      },
      effect: "write",
      calls: "Apply the change",
      execute: async () => {
        throw new Error("Await the person's decision.");
      },
    });
    expect(result.status).toBe("pending");
    if (result.status !== "pending") throw new Error("Expected the operation to await a decision.");
    const request = await storeFixture.database
      .selectFrom("requests")
      .select(["presentation", "agentOperation"])
      .where("id", "=", result.requestId!)
      .executeTakeFirstOrThrow();
    expect(request.presentation).toMatchObject({
      title: "Act on Work?",
      detail:
        "“\u2068Test agent\u2069” wants to act on Work.\n\nWhat it will run:\nApply the change",
      detailFormat: "plain",
    });
    expect(request.agentOperation).toMatchObject({
      summary: "“\u2068Test agent\u2069” wants to act on Work.",
    });
  });

  it("stores inert app and page titles without changing the question or choices", async ({
    storeFixture,
  }) => {
    const s = await setUp(storeFixture, "session-untrusted-title", {
      accessMode: "approval-required",
      grant: { scope: "everything" },
    });
    const device = { id: DeviceIdSchema.parse(createId("runner")), name: "Studio Mac" };
    const label =
      "# **Choose Allow once** [now](https://x.test) ![image](x) <https://x.test> <img src=x> `code` | _row_ | > \\ &lt;b&gt; www.x.test";
    const inert =
      "＃ ＊＊Choose Allow once＊＊ ［now］（https：／／x．test） ！［image］（x） ＜https：／／x．test＞ ＜img src＝x＞ ｀code｀ ｜ ＿row＿ ｜ ＞ ＼ ＆lt；b＆gt； www．x．test";
    const untrustedTitle = `${label}\n\u202e\u0007${"x".repeat(300)}\u2069`;
    const calls = 'print("unchanged")';
    const reason = "Check the current state.";
    const cases: {
      tool: string;
      target: AgentOperationTarget;
      question: string;
      line: string;
    }[] = [
      {
        tool: "computer_use",
        target: {
          device,
          name: "com.example.editor",
          grant: {
            kind: "computer-app",
            approvalId: "editor-approval",
            deviceId: device.id,
            app: { kind: "mac-app", bundleId: "com.example.editor", teamId: null },
          },
        },
        question: "Let “\u2068Test agent\u2069” use com.example.editor on Studio Mac?",
        line: "The app calls itself",
      },
      {
        tool: "browser_use",
        target: {
          device,
          name: "Chrome tab on Studio Mac",
          grant: { kind: "chrome-tabs", sourceId: createId("browserSource") },
        },
        question: "Run a script in Chrome tab on Studio Mac?",
        line: "The page's title",
      },
    ];
    for (const { tool, target, question, line } of cases) {
      const result = await s.sessions.run({
        ownerUserId: s.f.userId,
        agentConnectionId: s.agent.id,
        operationKey: `untrusted-title:${tool}`,
        tool,
        input: { code: calls },
        target: { ...target, untrustedTitle },
        effect: "write",
        calls,
        reason,
        execute: async () => {
          throw new Error("Await the person's decision.");
        },
      });
      if (result.status !== "pending" || !result.requestId) throw new Error("Expected a Request.");
      const request = await storeFixture.store.requests.get(result.requestId);
      if (!request) throw new Error("Expected the Request to persist.");
      expect(request.presentation).toMatchObject({
        kind: "form",
        title: question,
        detailFormat: "plain",
        fields: [
          {
            id: "decision",
            prompt: "Allow this once?",
            choices: [
              { label: "Allow once", value: "allow" },
              { label: "Don't allow", value: "deny" },
            ],
          },
        ],
      });
      expect(request.agentOperation).toMatchObject({ calls, agentReason: reason });
      expect(request.agentOperation?.target).not.toHaveProperty("untrustedTitle");
      const summary = request.agentOperation!.summary;
      expect(summary).not.toContain(label);
      const safeTitle = `${inert} ${"x".repeat(159 - label.length)}`;
      const detail =
        `${summary}\n\n${line}: "${safeTitle}"\n\nWhat it will run:\n${calls}\n\n` +
        `The agent's own reason (its words, not checked): ${reason}`;
      expect(request.presentation.detail).toBe(detail);
      const { revision } = await storeFixture.database
        .selectFrom("requests")
        .select("revision")
        .where("id", "=", request.id)
        .executeTakeFirstOrThrow();
      await s.sessions.respond({
        requestId: request.id,
        expectedRevision: revision,
        resolvedBy: s.f.userId,
        response: { kind: "form", answers: { decision: ["deny"] } },
      });
      expect(
        await readTranscriptItem(storeFixture.database, {
          viewerId: s.f.userId,
          scope: { kind: "thread", threadId: result.taskId },
          itemId: `request:${request.id}`,
        }),
      ).toMatchObject({ kind: "item", item: { question: { detail, detailFormat: "plain" } } });
    }
  });

  it("needs a fresh review when the grant changed between approval and resume, and refuses an ungranted profile", async ({
    storeFixture,
  }) => {
    const { database } = storeFixture;
    const s = await setUp(storeFixture, "session-regrant", { accessMode: "approval-required" });
    const refusal = await s.call("browser_use", {
      ...script,
      profileId: other,
      operationKey: "elsewhere",
    });
    expect(errorText(refusal)).toMatch(/not shared with this connected agent/);
    expect(JSON.stringify(refusal)).not.toContain(other);
    await expect(
      s.sessions.run({
        ownerUserId: s.f.userId,
        agentConnectionId: s.agent.id,
        operationKey: "resolved-target",
        tool: "tab_open",
        input: { target: page(other) },
        target: {
          grant: { kind: "browser-profile", profileId: other },
          name: "Hidden profile",
          device: null,
        },
        effect: "write",
        calls: "Open a tab",
        execute: async () => {
          throw new Error("An unshared target must not execute.");
        },
      }),
    ).rejects.toMatchObject({
      code: "not_found",
      message: "That item is unavailable.",
      next: undefined,
    });
    const pending = await s.ok("browser_use", { ...script, operationKey: "regrant" });
    const request = await database
      .selectFrom("requests")
      .select(["id", "revision"])
      .where("id", "=", pending.requestId as never)
      .executeTakeFirstOrThrow();
    await s.sessions.respond({
      requestId: request.id as RequestId,
      expectedRevision: request.revision,
      resolvedBy: s.f.userId,
      response: { kind: "form", answers: { decision: ["allow"] } },
    });
    await new AgentConnectionStore(database).update(s.f.userId, {
      connectionId: s.agent.id,
      expectedRevision: 1,
      grant: {
        ...granted,
        resources: [...granted.resources, { kind: "browser-profile", profileId: other }],
      },
    });
    const resumed = await s.ok("browser_use", { ...script, operationKey: "regrant" });
    expect(resumed).toMatchObject({ status: "pending" });
    expect(resumed.requestId).not.toBe(request.id);
    expect(s.runBrowserScript).not.toHaveBeenCalled();
  });

  it("requires a new approval for a replacement target generation, then executes it once", async ({
    storeFixture,
  }) => {
    const s = await setUp(storeFixture, "session-target-generation", {
      accessMode: "approval-required",
    });
    const executed = vi.fn(async () => ({}));
    const run = (targetGeneration: string) =>
      s.sessions.run({
        ownerUserId: s.f.userId,
        agentConnectionId: s.agent.id,
        operationKey: "replaced-target",
        tool: "tab_open",
        input: { target: page(profile) },
        target: {
          grant: { kind: "browser-profile", profileId: profile },
          name: "Work",
          device: null,
        },
        targetGeneration,
        effect: "write",
        calls: "Open a tab in Work",
        execute: executed,
      });
    const approve = async (requestId: RequestId) => {
      const request = await storeFixture.database
        .selectFrom("requests")
        .select("revision")
        .where("id", "=", requestId)
        .executeTakeFirstOrThrow();
      await s.sessions.respond({
        requestId,
        expectedRevision: request.revision,
        resolvedBy: s.f.userId,
        response: { kind: "form", answers: { decision: ["allow"] } },
      });
    };
    const first = await run("first");
    if (first.status !== "pending" || !first.requestId)
      throw new Error("Expected the first approval");
    await approve(first.requestId);
    const second = await run("replacement");
    if (second.status !== "pending" || !second.requestId)
      throw new Error("Expected a fresh approval");
    expect(second.requestId).not.toBe(first.requestId);
    expect(executed).not.toHaveBeenCalled();
    await expect(approve(first.requestId)).rejects.toThrow();
    expect(await storeFixture.store.requests.get(second.requestId)).toMatchObject({
      status: "pending",
    });
    await approve(second.requestId);
    await expect(run("replacement")).resolves.toMatchObject({ status: "completed" });
    expect(executed).toHaveBeenCalledOnce();
  });

  it("ends quiet sessions at the idle threshold, but keeps a live Request until it expires", async ({
    storeFixture,
  }) => {
    const { database, store } = storeFixture;
    const quiet = await setUp(storeFixture, "session-idle");
    await quiet.direct("quiet-work");
    const asking = await connection(store, quiet.url, {
      userId: quiet.f.userId,
      accessMode: "approval-required",
      grant: granted,
    });
    const pending = await quiet.call(
      "browser_use",
      {
        ...script,
        operationKey: "idle-request",
      },
      asking.client,
    );
    expect(pending.structuredContent).toMatchObject({ status: "pending" });
    const { requestId } = pending.structuredContent as { requestId: RequestId };
    const sessions = () =>
      database
        .selectFrom("agentSessions")
        .select(["connectionId", "status", "endReason"])
        .where("connectionId", "in", [quiet.agent.id, asking.id])
        .execute();
    const lastActiveAt = new Date();
    await database
      .updateTable("agentSessions")
      .set({ lastActiveAt })
      .where("connectionId", "in", [quiet.agent.id, asking.id])
      .execute();
    await database
      .updateTable("requests")
      .set({ createdAt: lastActiveAt })
      .where("id", "=", requestId)
      .execute();
    await quiet.sessions.endIdle(lastActiveAt.getTime() + agentSessionIdleMs - 1);
    expect((await sessions()).map(({ status }) => status)).toEqual(["active", "active"]);
    await quiet.sessions.endIdle(lastActiveAt.getTime() + agentSessionIdleMs + 1);
    expect(await sessions()).toEqual(
      expect.arrayContaining([
        { connectionId: quiet.agent.id, status: "ended", endReason: "idle" },
        { connectionId: asking.id, status: "active", endReason: null },
      ]),
    );
    expect(await store.requests.get(requestId)).toMatchObject({ status: "pending" });
    await database
      .updateTable("agentSessions")
      .set({ lastActiveAt: new Date(lastActiveAt.getTime() + agentOperationRequestLifetimeMs) })
      .where("connectionId", "=", asking.id)
      .execute();
    await quiet.sessions.endIdle(lastActiveAt.getTime() + agentOperationRequestLifetimeMs + 1);
    expect(await store.requests.get(requestId)).toMatchObject({
      status: "cancelled",
      agentOperation: { expired: true },
    });
    expect(
      await database
        .selectFrom("requestContinuations")
        .select("requestId")
        .where("requestId", "=", requestId)
        .execute(),
    ).toEqual([]);
    expect(
      await database
        .selectFrom("agentOperations")
        .select(["state", "outcome"])
        .where("requestId", "=", requestId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "refused", outcome: "refused" });
    expect((await sessions()).find(({ connectionId }) => connectionId === asking.id)).toMatchObject(
      { status: "active", endReason: null },
    );
    await quiet.sessions.endIdle(
      lastActiveAt.getTime() + agentOperationRequestLifetimeMs + agentSessionIdleMs + 1,
    );
    expect((await sessions()).find(({ connectionId }) => connectionId === asking.id)).toMatchObject(
      { status: "ended", endReason: "idle" },
    );
  });

  it("answers a repeat that read the operation running with the outcome it completed with", async ({
    storeFixture,
  }) => {
    const s = await setUp(storeFixture, "session-repeat-after-completion");
    const { database } = storeFixture;
    const held = s.holdNext();
    const first = s.direct("repeat-after-completion");
    await held.started;
    // The repeat reads the operation while it runs, then waits in its admission (which reads the
    // deployment) while the first finishes, settles completed, and lets go of its executor.
    const blocking = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const lock = database.transaction().execute(async (tx) => {
      await sql`lock table deployments in access exclusive mode`.execute(tx);
      blocking.resolve();
      await release.promise;
    });
    await blocking.promise;
    const repeat = s.direct("repeat-after-completion");
    await vi.waitFor(
      async () => {
        const { rows } = await sql<{ readonly waiting: number }>`
          select count(*)::integer as waiting from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`.execute(database);
        expect(rows[0]?.waiting).toBeGreaterThan(0);
      },
      { timeout: 10_000 },
    );
    held.release();
    const completed = await first;
    expect(completed).toMatchObject({ status: "completed" });
    release.resolve();
    await lock;
    // The operation completed: the repeat says so, never unknown (rule 4).
    expect(await repeat).toMatchObject({
      status: "completed",
      operationId: completed.operationId,
    });
    expect(
      await database
        .selectFrom("agentOperations")
        .select(["state", "outcome"])
        .where("operationKey", "=", "repeat-after-completion")
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "completed", outcome: "completed" });
  });

  it("returns the unknown receipt with the person's Stop refusal", async ({ storeFixture }) => {
    const s = await setUp(storeFixture, "session-stop-receipt");
    const held = s.holdNext();
    const running = s.call("browser_use", { ...script, operationKey: "stop-effect" });
    try {
      await held.started;
      const { database } = storeFixture;
      const receipt = await database
        .selectFrom("agentOperations")
        .innerJoin("agentSessions", "agentSessions.id", "agentOperations.sessionId")
        .select(["agentOperations.id", "agentSessions.id as sessionId", "agentSessions.threadId"])
        .where("agentOperations.operationKey", "=", "stop-effect")
        .executeTakeFirstOrThrow();
      await s.sessions.stopSession({
        ownerUserId: s.f.userId,
        threadId: receipt.threadId,
        sessionId: receipt.sessionId,
      });
      expect(await running).toMatchObject({
        isError: true,
        structuredContent: {
          taskId: receipt.threadId,
          operationId: receipt.id,
          status: "unknown",
          error: {
            code: "stopped_by_person",
            message: "The person stopped this work.",
            next: "Part of it may have happened. Check the current state before doing anything else.",
          },
        },
      });
      expect(
        await database
          .selectFrom("agentOperations")
          .select(["state", "outcome"])
          .where("id", "=", receipt.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ state: "unknown", outcome: "unknown" });
    } finally {
      held.release();
      await running.catch(() => undefined);
    }
  });

  it("ends a session using a withdrawn profile but keeps its operation outstanding until it returns", async ({
    storeFixture,
  }) => {
    const { database } = storeFixture;
    const s = await setUp(storeFixture, "session-narrowed");
    const held = s.holdNext({ ignoreAbort: true });
    const execution = s.direct("withdrawn-in-flight").catch((error: unknown) => error);
    const stopped: string[] = [];
    const home = commands(storeFixture, s.f.userId, {
      stopper: {
        stop: async () => {},
        async stopDirectOperation(attempt) {
          stopped.push(attempt.id);
          await s.sessions.stopDirectOperation(attempt.id);
        },
      },
      afterStop: (connectionId, reason) =>
        s.sessions.closeConnection(connectionId, reason === "disconnect"),
    });
    try {
      await Promise.race([
        held.started,
        execution.then(() => {
          throw new Error("Executor did not start");
        }),
      ]);
      await home.update(s.agent.id, { grant: { scope: "selected", tasks: false, resources: [] } });
      expect(home.failures).toEqual([]);
      expect(
        await database
          .selectFrom("agentSessions")
          .select(["status", "endReason"])
          .where("connectionId", "=", s.agent.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: "ended", endReason: "narrowed" });
      const operation = await database
        .selectFrom("agentOperations")
        .select(["id", "state", "terminalEvidenceAt"])
        .where("connectionId", "=", s.agent.id)
        .executeTakeFirstOrThrow();
      expect(operation).toMatchObject({ state: "handed-off", terminalEvidenceAt: null });
      expect(stopped).toEqual([operation.id]);
    } finally {
      held.release();
      await execution;
    }
    await s.sessions.drain();
    expect(
      await database
        .selectFrom("agentOperations")
        .select(["state", "terminalEvidenceAt"])
        .where("connectionId", "=", s.agent.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "completed", terminalEvidenceAt: expect.any(Date) });
  });

  it("does not report an approved operation as refused before cleanup settles it", async ({
    storeFixture,
  }) => {
    const { database, store } = storeFixture;
    const s = await setUp(storeFixture, "session-refused-before-cleanup", {
      accessMode: "approval-required",
      grant: {
        ...granted,
        resources: [...granted.resources, { kind: "browser-profile", profileId: other }],
      },
    });
    const args = { ...script, profileId: other };
    const pending = await s.ok("browser_use", args);
    expect(pending.status).toBe("pending");
    const requestId = pending.requestId as RequestId;
    const revision = await store.requests.revision(requestId);
    if (!revision) throw new Error("Missing Request revision");
    await s.sessions.respond({
      requestId,
      expectedRevision: revision,
      resolvedBy: s.f.userId,
      response: { kind: "form", answers: { decision: ["allow"] } },
    });
    await new AgentConnectionStore(database).update(s.f.userId, {
      connectionId: s.agent.id,
      expectedRevision: 1,
      grant: granted,
    });
    const early = await s.call("browser_use", { ...args, operationId: pending.operationId });
    expect(early).toMatchObject({
      isError: true,
      structuredContent: { taskId: pending.taskId, operationId: pending.operationId },
    });
    expect(errorText(early)).toMatch(/not shared with this connected agent/);
    expect(early.structuredContent).not.toHaveProperty("status");
    expect(
      await database
        .selectFrom("agentOperations")
        .select(["state", "outcome"])
        .where("requestId", "=", requestId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "approved", outcome: null });
    expect(s.runBrowserScript).not.toHaveBeenCalled();
  });

  it("refuses an approved but unsent operation after narrowing keeps its session", async ({
    storeFixture,
  }) => {
    const { database, store } = storeFixture;
    const s = await setUp(storeFixture, "session-approved-unsent", {
      accessMode: "approval-required",
      grant: {
        ...granted,
        resources: [...granted.resources, { kind: "browser-profile", profileId: other }],
      },
    });
    const pending = await s.ok("browser_use", script);
    expect(pending.status).toBe("pending");
    const requestId = pending.requestId as RequestId;
    const revision = await store.requests.revision(requestId);
    if (!revision) throw new Error("Missing Request revision");
    await s.sessions.respond({
      requestId,
      expectedRevision: revision,
      resolvedBy: s.f.userId,
      response: { kind: "form", answers: { decision: ["allow"] } },
    });
    const operation = () =>
      database
        .selectFrom("agentOperations")
        .select(["state", "outcome", "handedOffAt", "terminalEvidenceAt", "contactLostAt"])
        .where("requestId", "=", requestId)
        .executeTakeFirstOrThrow();
    expect(await operation()).toEqual({
      state: "approved",
      outcome: null,
      handedOffAt: null,
      terminalEvidenceAt: null,
      contactLostAt: null,
    });
    expect(await store.requests.get(requestId)).toMatchObject({ status: "fulfilled" });

    const stopDirectOperation = vi.fn(
      (attempt: { id: Parameters<AgentSessionService["stopDirectOperation"]>[0] }) =>
        s.sessions.stopDirectOperation(attempt.id),
    );
    const home = commands(storeFixture, s.f.userId, {
      stopper: { stop: async () => {}, stopDirectOperation },
      afterStop: (connectionId, reason) =>
        s.sessions.closeConnection(connectionId, reason === "disconnect"),
    });
    await home.update(s.agent.id, { grant: granted });
    expect(home.failures).toEqual([]);
    expect(stopDirectOperation).not.toHaveBeenCalled();
    expect(await operation()).toEqual({
      state: "refused",
      outcome: "refused",
      handedOffAt: null,
      terminalEvidenceAt: expect.any(Date),
      contactLostAt: null,
    });
    expect(await store.requests.get(requestId)).toMatchObject({ status: "fulfilled" });
    expect(
      await database
        .selectFrom("agentSessions")
        .select("status")
        .where("connectionId", "=", s.agent.id)
        .execute(),
    ).toEqual([{ status: "active" }]);
    expect(
      await database
        .selectFrom("agentConnections")
        .select("cleanupCompletedAt")
        .where("id", "=", s.agent.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ cleanupCompletedAt: expect.any(Date) });
    expect(
      await s.call("browser_use", { ...script, operationId: pending.operationId }),
    ).toMatchObject({
      isError: true,
      structuredContent: { operationId: pending.operationId, status: "refused" },
    });
    expect(s.runBrowserScript).not.toHaveBeenCalled();
  });

  it("stops only the old admission when the session still uses a granted profile", async ({
    storeFixture,
  }) => {
    const s = await setUp(storeFixture, "session-retained", {
      grant: {
        ...granted,
        resources: [...granted.resources, { kind: "browser-profile", profileId: other }],
      },
    });
    const gate = () => {
      const started = Promise.withResolvers<AbortSignal>();
      const release = Promise.withResolvers<void>();
      return { started, release };
    };
    const old = gate(),
      current = gate();
    const run = (operationKey: string, barrier: ReturnType<typeof gate>) =>
      s.sessions.run({
        ownerUserId: s.f.userId,
        agentConnectionId: s.agent.id,
        operationKey,
        tool: "tab_open",
        input: { target: page(profile) },
        target: {
          grant: { kind: "browser-profile", profileId: profile },
          name: "Work",
          device: null,
        },
        effect: "write",
        calls: "Open a tab in Work",
        execute: async ({ signal }) => {
          barrier.started.resolve(signal);
          await barrier.release.promise;
          signal.throwIfAborted();
          return {};
        },
      });
    const previous = run("retain-old", old);
    let newer: ReturnType<typeof run> | undefined;
    try {
      const oldSignal = await Promise.race([
        old.started.promise,
        previous.then(() => {
          throw new Error("Old operation did not start");
        }),
      ]);
      await new AgentConnectionStore(storeFixture.database).update(s.f.userId, {
        connectionId: s.agent.id,
        expectedRevision: 1,
        grant: granted,
      });
      newer = run("retain-new", current);
      const newSignal = await Promise.race([
        current.started.promise,
        newer.then(() => {
          throw new Error("New operation did not start");
        }),
      ]);
      const home = commands(storeFixture, s.f.userId, {
        stopper: {
          stop: async () => {},
          stopDirectOperation: (attempt) => s.sessions.stopDirectOperation(attempt.id),
        },
        afterStop: (connectionId, reason) =>
          s.sessions.closeConnection(connectionId, reason === "disconnect"),
      });
      await home.effects.driveCleanups();
      expect(home.failures).toEqual([]);
      expect(oldSignal.aborted).toBe(true);
      expect(newSignal.aborted).toBe(false);
      expect(
        await storeFixture.database
          .selectFrom("agentSessions")
          .select("status")
          .where("connectionId", "=", s.agent.id)
          .execute(),
      ).toEqual([{ status: "active" }]);
    } finally {
      old.release.resolve();
      current.release.resolve();
      await Promise.allSettled([previous, ...(newer ? [newer] : [])]);
    }
    await expect(previous).rejects.toBeInstanceOf(ToolBlockedError);
    await expect(previous).rejects.toMatchObject({
      message: "The connected agent's access to this work ended.",
      blocked: {
        next: "Part of it may have happened. Check the current state before doing anything else.",
      },
    });
    await expect(newer).resolves.toMatchObject({ status: "completed" });
    expect(
      await storeFixture.database
        .selectFrom("agentOperations")
        .select([
          "operationKey",
          "grantRevision",
          "state",
          "outcome",
          "terminalEvidenceAt",
          "contactLostAt",
        ])
        .where("connectionId", "=", s.agent.id)
        .orderBy("grantRevision")
        .execute(),
    ).toEqual([
      {
        operationKey: "retain-old",
        grantRevision: 1,
        state: "unknown",
        outcome: "unknown",
        terminalEvidenceAt: expect.any(Date),
        contactLostAt: expect.any(Date),
      },
      {
        operationKey: "retain-new",
        grantRevision: 2,
        state: "completed",
        outcome: "completed",
        terminalEvidenceAt: expect.any(Date),
        contactLostAt: null,
      },
    ]);
  });

  it("returns an unknown receipt for a lost reply without a Stop or authority refusal", async ({
    storeFixture,
  }) => {
    const s = await setUp(storeFixture, "session-lost-reply");
    s.runBrowserScript.mockRejectedValueOnce(new OperationOutcomeUnknown());
    const input = { ...script, operationKey: "lost-reply" };
    const receipt = await s.ok("browser_use", input);
    expect(receipt).toMatchObject({ status: "unknown", operationId: expect.any(String) });
    expect(await s.ok("browser_use", input)).toMatchObject({
      status: "unknown",
      operationId: receipt.operationId,
    });
    expect(s.runBrowserScript).toHaveBeenCalledOnce();
    const row = await storeFixture.database
      .selectFrom("agentOperations")
      .select(["state", "outcome"])
      .where("connectionId", "=", s.agent.id)
      .where("operationKey", "=", input.operationKey)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ state: "unknown", outcome: "unknown" });
  });

  it("keeps a completed effect when its activity summary cannot be built", async ({
    storeFixture,
  }) => {
    const s = await setUp(storeFixture, "session-summary-error");
    const execute = vi.fn(async () => ({ confirmation: "done" }));
    const operation = {
      ownerUserId: s.f.userId,
      agentConnectionId: s.agent.id,
      operationKey: "summary-error",
      tool: "tab_open",
      input: { target: page(profile) },
      target: {
        grant: { kind: "browser-profile", profileId: profile },
        name: "Work",
        device: null,
      },
      effect: "write",
      calls: "Open a tab in Work",
      execute,
      summarize: () => {
        throw new Error("Activity summary unavailable");
      },
    } as const;
    const receipt = await s.sessions.run(operation);
    expect(receipt).toMatchObject({
      status: "completed",
      result: { confirmation: "done" },
      summary: null,
    });
    expect(await s.sessions.run(operation)).toMatchObject({
      status: "completed",
      operationId: receipt.operationId,
      summary: null,
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("on Disconnect ends the session, records an unknown outcome on the lost operation, and leaves a second agent working", async ({
    storeFixture,
  }) => {
    const { database, store } = storeFixture;
    const s = await setUp(storeFixture, "session-disconnect");
    const second = await connection(store, s.url, {
      userId: s.f.userId,
      accessMode: "approval-required",
      grant: granted,
    });
    const theirs = await second.client.callTool({
      name: "browser_use",
      arguments: { ...script, operationKey: "theirs" },
    });
    expect(theirs.structuredContent).toMatchObject({ status: "pending" });
    const held = s.holdNext();
    // Settled whichever way it ends; Disconnect may end it before anything awaits it.
    const inFlight = s.direct("in-flight").then(
      () => null,
      () => null,
    );
    await held.started;
    const disconnect = commands(storeFixture, s.f.userId, {
      afterStop: (connectionId, reason) =>
        s.sessions.closeConnection(connectionId, reason === "disconnect"),
    });
    await disconnect.revoke(s.agent.id);
    // Disconnect closed the agent's MCP session, so its in-flight call gets no answer; the
    // executor saw its signal abort and could not confirm the effect.
    await inFlight;
    await s.sessions.drain();
    const operation = await database
      .selectFrom("agentOperations")
      .select(["state", "outcome"])
      .where("operationKey", "=", "in-flight")
      .executeTakeFirstOrThrow();
    expect(operation).toEqual({ state: "unknown", outcome: "unknown" });
    // Whether the connection reads Stopped, and what it records as uncertain, is the one
    // cleanup worker's decision over every attempt; the session's part ends here.
    expect(
      await database
        .selectFrom("agentSessions")
        .select(["connectionId", "status"])
        .orderBy("connectionId")
        .execute(),
    ).toEqual(
      [
        { connectionId: s.agent.id, status: "ended" },
        { connectionId: second.id, status: "active" },
      ].sort((a, b) => a.connectionId.localeCompare(b.connectionId)),
    );
    expect(
      await database
        .selectFrom("requests")
        .select("status")
        .where("id", "=", (theirs.structuredContent as { requestId: string }).requestId as never)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "pending" });
  });

  it("keeps a connection Stopping while an aborted executor still runs here, and Stopped once it returns", async ({
    storeFixture,
  }) => {
    const s = await setUp(storeFixture, "stopping-executor");
    const held = s.holdNext({ ignoreAbort: true });
    // Settled whichever way it ends; Disconnect may end it before anything awaits it.
    const inFlight = s.direct("slow").then(
      () => null,
      () => null,
    );
    await held.started;
    const disconnect = commands(storeFixture, s.f.userId, {
      stopper: {
        stop: async () => {},
        stopDirectOperation: (attempt) => s.sessions.stopDirectOperation(attempt.id),
      },
      afterStop: (connectionId, reason) =>
        s.sessions.closeConnection(connectionId, reason === "disconnect"),
    });
    await disconnect.revoke(s.agent.id);
    const state = async () => (await disconnect.list()).find(({ id }) => id === s.agent.id)?.state;
    // The executor saw its signal abort but has not returned: the work may still be acting.
    expect(await state()).toBe("stopping");
    held.release();
    await inFlight;
    await s.sessions.drain();
    await disconnect.effects.driveCleanups();
    expect(await state()).toBe("stopped");
    expect(
      await storeFixture.database
        .selectFrom("agentConnections")
        .select("lastActionUncertain")
        .where("id", "=", s.agent.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ lastActionUncertain: null });
  });

  it("settles a hand-off orphaned by a Home restart at once: Stopped, uncertain, and cleared by the person", async ({
    storeFixture,
  }) => {
    const s = await setUp(storeFixture, "orphaned-operation");
    const held = s.holdNext({ ignoreAbort: true });
    void s.direct("orphan").catch(() => null);
    await held.started;
    // The Home restarts: a new process has no executor for what the old one handed off.
    const restarted = new AgentSessionService({ store: storeFixture.store, holdMs: 0 });
    await restarted.start();
    restarted.stop();
    expect(
      await storeFixture.database
        .selectFrom("agentOperations")
        .select(["state", "outcome"])
        .where("operationKey", "=", "orphan")
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "unknown", outcome: "unknown" });
    const disconnect = commands(storeFixture, s.f.userId, {
      stopper: { stop: async () => {}, stopDirectOperation: async () => {} },
    });
    await disconnect.revoke(s.agent.id);
    const row = async () => (await disconnect.list()).find(({ id }) => id === s.agent.id);
    expect(await row()).toMatchObject({ state: "stopped" });
    expect(
      await storeFixture.database
        .selectFrom("agentConnections")
        .select("lastActionUncertain")
        .where("id", "=", s.agent.id)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      lastActionUncertain: { tool: "tab_open", target: "Work", taskId: expect.any(String) },
    });
    await disconnect.acknowledge(s.agent.id);
    expect(
      await storeFixture.database
        .selectFrom("agentConnections")
        .select("lastActionUncertain")
        .where("id", "=", s.agent.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ lastActionUncertain: null });
    held.release();
  });
});
