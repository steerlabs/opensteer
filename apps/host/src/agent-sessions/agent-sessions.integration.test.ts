import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  BackgroundModelChoiceSchema,
  DeviceIdSchema,
  HarnessIdSchema,
  ToolBlockedError,
  agentSessionIdleMs,
  createId,
  type AgentGrant,
  type BrowserProfileId,
  type RequestId,
  type ThreadAccessMode,
} from "@opensteer/core";
import { AgentConnectionStore, agentOperationRequestLifetimeMs } from "@opensteer/database";
import { createStoreFixture, describeStore } from "@opensteer/database/test-support/store";
import { expect, vi } from "vitest";
import { HarnessInstanceCatalogSchema } from "@opensteer/protocol";
import { createAgentReviewer } from "./agent-reviewer.js";
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
} from "../mcp/connection-caller.test-support.js";
import type { TabServicePort } from "../tabs/ports.js";
import {
  AgentSessionService,
  OperationOutcomeUnknown,
  type AgentReviewerPort,
} from "./agent-session-service.js";

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
    readonly reviewer?: AgentReviewerPort;
    readonly run?: Awaited<ReturnType<Fixture["startRunFixture"]>>;
  } = {},
) {
  const f = options.run ?? (await storeFixture.startRunFixture(key));
  const recorded = recordingExecutor();
  const sessions = new AgentSessionService({
    store: storeFixture.store,
    holdMs: 0,
    ...(options.reviewer ? { reviewer: options.reviewer } : {}),
  });
  const unexpectedTabOperation = () => {
    throw new Error("This fixture runs scripts by profile ID.");
  };
  const tabs: TabServicePort & Pick<BrowserToolPorts["tabs"], "bindBrowserScript"> = {
    list: async () => ({ tabs: [], groups: [], nextCursor: null }),
    open: unexpectedTabOperation,
    connectionTab: unexpectedTabOperation,
    bindBrowserScript: unexpectedTabOperation,
    close: unexpectedTabOperation,
    reopen: unexpectedTabOperation,
    activate: unexpectedTabOperation,
    organize: unexpectedTabOperation,
    updateGroup: unexpectedTabOperation,
    deleteGroup: unexpectedTabOperation,
    get: unexpectedTabOperation,
    bootstrap: unexpectedTabOperation,
    requireOpenPage: unexpectedTabOperation,
    authorizeShow: unexpectedTabOperation,
    appsChanged: unexpectedTabOperation,
  };
  const home = { runnerId: createId("runner"), name: "Mac" };
  const url = await serveMcp(storeFixture, {
    tabHandlers: new TabToolHandlers(tabs, sessions),
    browser: new BrowserToolHandlers({
      sessions,
      tabs,
      scripts: recorded,
      confinement: new BrowserScriptConfinement(),
      profiles: async () => [{ id: profile, name: "Work", home }, { id: other, name: "Other", home }],
      requireDevice: async () => DeviceIdSchema.parse(home.runnerId),
      issueTicket: unexpectedTabOperation,
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
  it("records a fake background model's allow decision before executing an Auto effect", async ({
    storeFixture,
  }) => {
    const backgroundText = vi
      .fn<Parameters<typeof createAgentReviewer>[0]["runners"]["backgroundText"]>()
      .mockResolvedValue({ ok: true, text: "allow" });
    const f = await storeFixture.startRunFixture("reviewer-model");
    const harness = {
      ...(await storeFixture.database
        .selectFrom("harnessInstances")
        .selectAll()
        .where("environmentId", "=", f.environmentId)
        .executeTakeFirstOrThrow()),
      driverKind: HarnessIdSchema.parse("codex"),
      sourceId: "codex",
    };
    const catalog = HarnessInstanceCatalogSchema.parse({
      driverKind: harness.driverKind,
      harnessInstanceId: harness.id,
      status: "ready",
      continuationIdentity: {
        driverKind: harness.driverKind,
        continuationKey: "runner:v1:" + "a".repeat(43),
      },
      connections: [],
      models: [
        {
          providerId: "openai",
          modelId: "review-model",
          nativeModelId: "review-model",
          displayName: "Review model",
          isDefault: false,
          options: [],
        },
      ],
    });
    const reviewer = createAgentReviewer({
      model: BackgroundModelChoiceSchema.parse({
        engine: harness.driverKind,
        account: harness.id,
        model: "review-model",
      }),
      store: {
        getAgentHomeSettings: storeFixture.store.getAgentHomeSettings.bind(storeFixture.store),
        listEnvironmentsForUser: storeFixture.store.listEnvironmentsForUser.bind(
          storeFixture.store,
        ),
        listHarnessInstances: async () => [harness],
        listHarnessCatalogs: async () => [
          {
            environmentId: f.environmentId,
            harnessInstanceId: harness.id,
            catalog,
            capturedAt: new Date(),
          },
        ],
      },
      runners: {
        isAvailable: () => true,
        canRunHarness: () => true,
        identityForEnvironment: () =>
          ({ capabilities: ["background-text-v1"] }) as ReturnType<
            Parameters<typeof createAgentReviewer>[0]["runners"]["identityForEnvironment"]
          >,
        backgroundText,
      },
    });
    const s = await setUp(storeFixture, "session-auto", { accessMode: "auto", reviewer, run: f });
    // The resolver must use the connection owner's authorized environment.
    const result = await s.ok("browser_use", { ...script, operationKey: "reviewed-open" });
    expect(result).toMatchObject({ status: "completed" });
    expect(backgroundText).toHaveBeenCalledOnce();
    expect(s.runBrowserScript).toHaveBeenCalledOnce();
    const receipt = await storeFixture.database
      .selectFrom("agentOperations")
      .select(["decision", "requestId", "state"])
      .where("operationKey", "=", "reviewed-open")
      .executeTakeFirstOrThrow();
    expect(receipt).toEqual({ decision: { by: "reviewer" }, requestId: null, state: "completed" });
  });

  it("starts a session on the first direct call, continues it across transports, and refuses input to its task", async ({
    storeFixture,
  }) => {
    const { database, store } = storeFixture;
    const s = await setUp(storeFixture, "session-start");
    // A browser-only agent works on a Home where no native engine is enabled.
    await database.updateTable("harnessInstances").set({ enabled: false }).execute();
    const first = await s.ok("tab_list", {});
    expect(first).toMatchObject({ status: "completed", tabs: [] });
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
    expect((await s.ok("tab_list", {}, second)).taskId).toBe(first.taskId);
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
    const { taskId } = await s.ok("tab_list", {});
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
    expect(errorText(await s.call("tab_list", { taskId }))).toBe(stopped);
    expect(errorText(await s.call("tab_list", {}))).toBe(stopped);
    const next = await s.ok("tab_list", {});
    expect(next.taskId).not.toBe(taskId);
    expect(errorText(await s.call("tab_list", { taskId }))).toBe(stopped);
  });

  it("asks the person in approval-required, executes an approval exactly once under two resumes, and refuses a denial", async ({
    storeFixture,
  }) => {
    const { database } = storeFixture;
    const s = await setUp(storeFixture, "session-approval", { accessMode: "approval-required" });
    const pending = await s.ok("browser_use", { ...script, operationKey: "open-1" });
    expect(pending).toMatchObject({ status: "pending", requestId: expect.any(String) });
    expect(s.runBrowserScript).not.toHaveBeenCalled();
    const request = await database
      .selectFrom("requests")
      .select(["id", "kind", "status", "originatingAgentSessionId", "revision", "presentation", "agentOperation"])
      .where("id", "=", pending.requestId as never)
      .executeTakeFirstOrThrow();
    expect(request).toMatchObject({ kind: "person.question", status: "pending" });
    // The Request carries the operation in its parts, and the task's activity lists it.
    expect(await storeFixture.store.requests.get(request.id as RequestId)).toMatchObject({
      agentOperation: {
        connectionId: s.agent.id,
        target: { name: "Work" },
        calls: script.code,
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
    expect(await reads["threads.activity"]({ threadId: pending.taskId as never }, ownerContext)).toMatchObject({
      ok: true,
      data: { operations: [{ tool: "browser_use", state: "pending" }], nextBefore: null },
    });
    expect(await reads["connections.activity"]({ connectionId: s.agent.id }, ownerContext)).toMatchObject({
      ok: true,
      data: { operations: [{ id: pending.operationId, taskId: pending.taskId, tool: "browser_use", state: "pending" }] },
    });
    expect(request.originatingAgentSessionId).toBeTruthy();
    expect(request.presentation).toMatchObject({
      title: "Run a script in Work?",
      fields: [{ choices: [{ label: "Allow once" }, { label: "Don't allow" }] }],
    });
    expect(request.agentOperation).toMatchObject({
      summary: "Work · Mac\nTest agent wants to run a script in Work.",
    });
    expect(
      await database
        .selectFrom("threads")
        .select("status")
        .where("id", "=", pending.taskId as never)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "waiting" });
    // A repeat before the answer is still pending, and a different call cannot take its key.
    expect(await s.ok("browser_use", { ...script, operationKey: "open-1" })).toMatchObject(
      {
        status: "pending",
      },
    );
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
    expect(await s.ok("browser_use", { ...script, operationKey: "open-2" })).toMatchObject(
      { status: "pending" },
    );
    expect(s.runBrowserScript).not.toHaveBeenCalled();
    const held = s.holdNext();
    const resumes = [
      s.ok("browser_use", { ...script, operationKey: "open-1" }),
      s.ok("browser_use", { ...script, operationKey: "open-1" }),
    ];
    await held.started;
    held.release();
    const both = await Promise.all(resumes);
    expect(both.map(({ status }) => status)).toEqual(["completed", "completed"]);
    expect(s.runBrowserScript).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      authority: { agentBindingId: `session:${request.originatingAgentSessionId}`, ownerId: s.f.userId },
      contextKey: profile,
      code: script.code,
    }));
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
    expect(
      errorText(await s.call("browser_use", { ...script, operationKey: "open-2" })),
    ).toBe("The person did not allow it.");
    expect(s.runBrowserScript).toHaveBeenCalledOnce();
  });

  it("uses a plain fallback for an unmapped operation in the person's request", async ({ storeFixture }) => {
    const s = await setUp(storeFixture, "session-unmapped-copy", { accessMode: "approval-required" });
    const result = await s.sessions.run({
      ownerUserId: s.f.userId,
      agentConnectionId: s.agent.id,
      operationKey: "unmapped-copy",
      tool: "unmapped_internal_tool",
      input: {},
      target: { grant: { kind: "browser-profile", profileId: profile }, name: "Work", device: null },
      effect: "write",
      calls: "Apply the change",
      execute: async () => { throw new Error("Await the person's decision."); },
    });
    expect(result.status).toBe("pending");
    if (result.status !== "pending") throw new Error("Expected the operation to await a decision.");
    const request = await storeFixture.database.selectFrom("requests")
      .select(["presentation", "agentOperation"])
      .where("id", "=", result.requestId!)
      .executeTakeFirstOrThrow();
    expect(request.presentation).toMatchObject({ title: "Act on Work?" });
    expect(request.agentOperation).toMatchObject({ summary: "Test agent wants to act on Work." });
  });

  it("needs a fresh review when the grant changed between approval and resume, and refuses an ungranted profile", async ({
    storeFixture,
  }) => {
    const { database } = storeFixture;
    const s = await setUp(storeFixture, "session-regrant", { accessMode: "approval-required" });
    const refusal = await s.call("browser_use", { ...script, profileId: other, operationKey: "elsewhere" });
    expect(errorText(refusal)).toMatch(/not shared with this connected agent/);
    expect(JSON.stringify(refusal)).not.toContain(other);
    await expect(s.sessions.run({
      ownerUserId: s.f.userId,
      agentConnectionId: s.agent.id,
      operationKey: "resolved-target",
      tool: "tab_open",
      input: { target: page(other) },
      target: { grant: { kind: "browser-profile", profileId: other }, name: "Hidden profile", device: null },
      effect: "write",
      calls: "Open a tab",
      execute: async () => { throw new Error("An unshared target must not execute."); },
    })).rejects.toMatchObject({ message: "This resource is not shared with this connected agent." });
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

  it("requires a new approval for a replacement target generation, then executes it once", async ({ storeFixture }) => {
    const s = await setUp(storeFixture, "session-target-generation", { accessMode: "approval-required" });
    const executed = vi.fn(async () => ({}));
    const run = (targetGeneration: string) => s.sessions.run({
      ownerUserId: s.f.userId, agentConnectionId: s.agent.id, operationKey: "replaced-target",
      tool: "tab_open", input: { target: page(profile) },
      target: { grant: { kind: "browser-profile", profileId: profile }, name: "Work", device: null },
      targetGeneration, effect: "write", calls: "Open a tab in Work", execute: executed,
    });
    const approve = async (requestId: RequestId) => {
      const request = await storeFixture.database.selectFrom("requests").select("revision")
        .where("id", "=", requestId).executeTakeFirstOrThrow();
      await s.sessions.respond({
        requestId, expectedRevision: request.revision, resolvedBy: s.f.userId,
        response: { kind: "form", answers: { decision: ["allow"] } },
      });
    };
    const first = await run("first");
    if (first.status !== "pending" || !first.requestId) throw new Error("Expected the first approval");
    await approve(first.requestId);
    const second = await run("replacement");
    if (second.status !== "pending" || !second.requestId) throw new Error("Expected a fresh approval");
    expect(second.requestId).not.toBe(first.requestId);
    expect(executed).not.toHaveBeenCalled();
    await approve(second.requestId);
    await expect(run("replacement")).resolves.toMatchObject({ status: "completed" });
    expect(executed).toHaveBeenCalledOnce();
  });

  it("ends quiet sessions at the idle threshold, but keeps a live Request until it expires", async ({ storeFixture }) => {
    const { database, store } = storeFixture;
    const quiet = await setUp(storeFixture, "session-idle");
    await quiet.direct("quiet-work");
    const asking = await connection(store, quiet.url, {
      userId: quiet.f.userId, accessMode: "approval-required", grant: granted,
    });
    const pending = await quiet.call("browser_use", {
      ...script, operationKey: "idle-request",
    }, asking.client);
    expect(pending.structuredContent).toMatchObject({ status: "pending" });
    const { requestId } = pending.structuredContent as { requestId: RequestId };
    const sessions = () => database.selectFrom("agentSessions").select(["connectionId", "status", "endReason"])
      .where("connectionId", "in", [quiet.agent.id, asking.id]).execute();
    const lastActiveAt = new Date();
    await database.updateTable("agentSessions").set({ lastActiveAt })
      .where("connectionId", "in", [quiet.agent.id, asking.id]).execute();
    await database.updateTable("requests").set({ createdAt: lastActiveAt }).where("id", "=", requestId).execute();
    await quiet.sessions.endIdle(lastActiveAt.getTime() + agentSessionIdleMs - 1);
    expect((await sessions()).map(({ status }) => status)).toEqual(["active", "active"]);
    await quiet.sessions.endIdle(lastActiveAt.getTime() + agentSessionIdleMs + 1);
    expect(await sessions()).toEqual(expect.arrayContaining([
      { connectionId: quiet.agent.id, status: "ended", endReason: "idle" },
      { connectionId: asking.id, status: "active", endReason: null },
    ]));
    expect(await store.requests.get(requestId)).toMatchObject({ status: "pending" });
    await quiet.sessions.endIdle(lastActiveAt.getTime() + agentOperationRequestLifetimeMs + 1);
    expect(await store.requests.get(requestId)).toMatchObject({
      status: "cancelled", agentOperation: { expired: true },
    });
    expect(await database.selectFrom("requestContinuations").select("requestId")
      .where("requestId", "=", requestId).execute()).toEqual([]);
    expect((await sessions()).find(({ connectionId }) => connectionId === asking.id))
      .toMatchObject({ status: "ended", endReason: "idle" });
  });

  it("ends a session using a withdrawn profile but keeps its operation outstanding until it returns", async ({ storeFixture }) => {
    const { database } = storeFixture;
    const s = await setUp(storeFixture, "session-narrowed");
    const held = s.holdNext({ ignoreAbort: true });
    const execution = s.direct("withdrawn-in-flight").catch((error: unknown) => error);
    const stopped: string[] = [];
    const home = commands(storeFixture, s.f.userId, {
      stopper: { stop: async () => {}, async stopDirectOperation(attempt) {
        stopped.push(attempt.id);
        await s.sessions.stopDirectOperation(attempt.id);
      } },
      afterStop: (connectionId, reason) => s.sessions.closeConnection(connectionId, reason === "disconnect"),
    });
    try {
      await Promise.race([held.started, execution.then(() => { throw new Error("Executor did not start"); })]);
      await home.update(s.agent.id, { grant: { scope: "selected", tasks: false, resources: [] } });
      expect(home.failures).toEqual([]);
      expect(await database.selectFrom("agentSessions").select(["status", "endReason"])
        .where("connectionId", "=", s.agent.id).executeTakeFirstOrThrow())
        .toEqual({ status: "ended", endReason: "narrowed" });
      const operation = await database.selectFrom("agentOperations").select(["id", "state", "terminalEvidenceAt"])
        .where("connectionId", "=", s.agent.id).executeTakeFirstOrThrow();
      expect(operation).toMatchObject({ state: "handed-off", terminalEvidenceAt: null });
      expect(stopped).toEqual([operation.id]);
    } finally {
      held.release();
      await execution;
    }
    await s.sessions.drain();
    expect(await database.selectFrom("agentOperations").select(["state", "terminalEvidenceAt"])
      .where("connectionId", "=", s.agent.id).executeTakeFirstOrThrow())
      .toEqual({ state: "completed", terminalEvidenceAt: expect.any(Date) });
  });

  it("stops only the old admission when the session still uses a granted profile", async ({ storeFixture }) => {
    const s = await setUp(storeFixture, "session-retained", {
      grant: { ...granted, resources: [...granted.resources, { kind: "browser-profile", profileId: other }] },
    });
    const gate = () => {
      const started = Promise.withResolvers<AbortSignal>();
      const release = Promise.withResolvers<void>();
      return { started, release };
    };
    const old = gate(), current = gate();
    const run = (operationKey: string, barrier: ReturnType<typeof gate>) => s.sessions.run({
      ownerUserId: s.f.userId, agentConnectionId: s.agent.id, operationKey,
      tool: "tab_open", input: { target: page(profile) },
      target: { grant: { kind: "browser-profile", profileId: profile }, name: "Work", device: null },
      effect: "write", calls: "Open a tab in Work",
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
      const oldSignal = await Promise.race([old.started.promise, previous.then(() => { throw new Error("Old operation did not start"); })]);
      await new AgentConnectionStore(storeFixture.database).update(s.f.userId, {
        connectionId: s.agent.id, expectedRevision: 1, grant: granted,
      });
      newer = run("retain-new", current);
      const newSignal = await Promise.race([current.started.promise, newer.then(() => { throw new Error("New operation did not start"); })]);
      const result = await storeFixture.store.driveConnectionCleanups({ stopper: {
        stop: async () => {}, stopDirectOperation: (attempt) => s.sessions.stopDirectOperation(attempt.id),
      } });
      expect(result.failures).toEqual([]);
      expect(oldSignal.aborted).toBe(true);
      expect(newSignal.aborted).toBe(false);
      expect(await storeFixture.database.selectFrom("agentSessions").select("status")
        .where("connectionId", "=", s.agent.id).execute()).toEqual([{ status: "active" }]);
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
    expect(await storeFixture.database.selectFrom("agentOperations")
      .select(["operationKey", "grantRevision", "state", "outcome", "terminalEvidenceAt", "contactLostAt"])
      .where("connectionId", "=", s.agent.id).orderBy("grantRevision").execute()).toEqual([
      { operationKey: "retain-old", grantRevision: 1, state: "unknown", outcome: "unknown",
        terminalEvidenceAt: expect.any(Date), contactLostAt: expect.any(Date) },
      { operationKey: "retain-new", grantRevision: 2, state: "completed", outcome: "completed",
        terminalEvidenceAt: expect.any(Date), contactLostAt: null },
    ]);
  });

  it("returns an unknown receipt for a lost reply without a Stop or authority refusal", async ({ storeFixture }) => {
    const s = await setUp(storeFixture, "session-lost-reply");
    s.runBrowserScript.mockRejectedValueOnce(new OperationOutcomeUnknown());
    const input = { ...script, operationKey: "lost-reply" };
    const receipt = await s.ok("browser_use", input);
    expect(receipt).toMatchObject({ status: "unknown", operationId: expect.any(String) });
    expect(await s.ok("browser_use", input)).toMatchObject({
      status: "unknown", operationId: receipt.operationId,
    });
    expect(s.runBrowserScript).toHaveBeenCalledOnce();
    const row = await storeFixture.database.selectFrom("agentOperations")
      .select(["state", "outcome"])
      .where("connectionId", "=", s.agent.id)
      .where("operationKey", "=", input.operationKey)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ state: "unknown", outcome: "unknown" });
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
