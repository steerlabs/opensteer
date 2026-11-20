import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  BackgroundModelChoiceSchema,
  HarnessIdSchema,
  TabSchema,
  createId,
  type AgentGrant,
  type BrowserProfileId,
  type RequestId,
  type ThreadAccessMode,
} from "@opensteer/core";
import { AgentConnectionStore } from "@opensteer/database";
import { createStoreFixture, describeStore } from "@opensteer/database/test-support/store";
import { expect, vi } from "vitest";
import { HarnessInstanceCatalogSchema } from "@opensteer/protocol";
import { createAgentReviewer } from "./agent-reviewer.js";
import { TabToolHandlers } from "../mcp/handlers/tabs.js";
import { createConnectionRpcHandlers } from "../mcp/connections/connection-routes.js";
import {
  clients,
  commands,
  connection,
  errorText,
  serveMcp,
} from "../mcp/connection-caller.test-support.js";
import type { TabActor, TabServicePort } from "../tabs/ports.js";
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
const tab = TabSchema.parse({
  tabId: "page-opened-by-session",
  kind: "page",
  title: "Page",
  url: "https://example.test",
  profile: null,
  computer: { computerId: createId("runner"), name: "Mac" },
  groupId: null,
  state: "open",
  openedBy: "person",
  usedBy: [],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

/** The tab service as the tools reach it: it records who acted, and can hold an effect open. */
function recordingTabs() {
  const opened: { actor: TabActor; target: unknown }[] = [];
  let hold: Promise<void> | null = null;
  let entered: (() => void) | null = null;
  let ignoresAbort = false;
  const tabs = {
    list: async () => ({ tabs: [], groups: [], nextCursor: null }),
    open: async (actor: TabActor, target: unknown) => {
      opened.push({ actor, target });
      entered?.();
      if (hold && ignoresAbort) await hold;
      else if (hold) {
        const signal = actor.kind === "browser-binding" ? actor.signal : undefined;
        const aborted = new Promise<never>((_, reject) =>
          signal?.addEventListener("abort", () => reject(new OperationOutcomeUnknown()), {
            once: true,
          }),
        );
        // An abort after the hold won the race has no one left to tell.
        aborted.catch(() => undefined);
        await Promise.race([hold, aborted]);
      }
      return { tab };
    },
    close: async () => ({ closed: [], failed: [] }),
  } as unknown as TabServicePort;
  return {
    tabs,
    opened,
    /**
     * The next open blocks until released; resolves when it has started. An executor that
     * ignores its abort keeps running after Stop or Disconnect until it is released.
     */
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
  const recorded = recordingTabs();
  const sessions = new AgentSessionService({
    store: storeFixture.store,
    holdMs: 0,
    ...(options.reviewer ? { reviewer: options.reviewer } : {}),
  });
  const url = await serveMcp(storeFixture, {
    tabHandlers: new TabToolHandlers(recorded.tabs, sessions, async () => "Work"),
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
  /**
   * The same tab_open the tool handler makes, through the pipeline itself: Disconnect closes the
   * agent's MCP session, and these cases are about the executor, not the transport.
   */
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
      execute: (context) =>
        recorded.tabs.open(
          {
            kind: "browser-binding",
            authority: { agentBindingId: context.bindingId, ownerId: context.ownerUserId },
            threadId: context.taskId,
            signal: context.signal,
          },
          page(profile),
          `operation:${context.operationId}`,
        ),
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
    const result = await s.ok("tab_open", { target: page(profile), operationKey: "reviewed-open" });
    expect(result).toMatchObject({ status: "completed" });
    expect(backgroundText).toHaveBeenCalledOnce();
    expect(s.opened).toHaveLength(1);
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
    const pending = await s.ok("tab_open", { target: page(profile), operationKey: "open-1" });
    expect(pending).toMatchObject({ status: "pending", requestId: expect.any(String) });
    expect(s.opened).toEqual([]);
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
        calls: expect.stringContaining("tab_open"),
        agentReason: null,
        decisionFieldId: "decision",
      },
    });
    const activity = await createConnectionRpcHandlers({
      store: new AgentConnectionStore(database),
    } as never)["threads.activity"]({ threadId: pending.taskId as never }, {
      session: { id: "session", user: { id: s.f.userId, disabledAt: null } },
    } as never);
    expect(activity).toMatchObject({
      ok: true,
      data: { operations: [{ tool: "tab_open", state: "pending" }], nextBefore: null },
    });
    expect(request.originatingAgentSessionId).toBeTruthy();
    expect(request.presentation).toMatchObject({
      title: "Open a tab in Work?",
      fields: [{ choices: [{ label: "Allow once" }, { label: "Don't allow" }] }],
    });
    expect(request.agentOperation).toMatchObject({
      summary: "A connected agent wants to open a tab in Work.",
    });
    expect(
      await database
        .selectFrom("threads")
        .select("status")
        .where("id", "=", pending.taskId as never)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "waiting" });
    // A repeat before the answer is still pending, and a different call cannot take its key.
    expect(await s.ok("tab_open", { target: page(profile), operationKey: "open-1" })).toMatchObject(
      {
        status: "pending",
      },
    );
    expect(
      errorText(
        await s.call("tab_open", {
          target: { ...page(profile), url: "https://elsewhere.test/" },
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
    expect(await s.ok("tab_open", { target: page(profile), operationKey: "open-2" })).toMatchObject(
      { status: "pending" },
    );
    expect(s.opened).toEqual([]);
    const held = s.holdNext();
    const resumes = [
      s.ok("tab_open", { target: page(profile), operationKey: "open-1" }),
      s.ok("tab_open", { target: page(profile), operationKey: "open-1" }),
    ];
    await held.started;
    held.release();
    const both = await Promise.all(resumes);
    expect(both.map(({ status }) => status)).toEqual(["completed", "completed"]);
    expect(s.opened).toHaveLength(1);
    expect(s.opened[0]!.actor).toMatchObject({
      kind: "browser-binding",
      threadId: pending.taskId,
      authority: { agentBindingId: expect.stringMatching(/^session:/) },
    });
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
      errorText(await s.call("tab_open", { target: page(profile), operationKey: "open-2" })),
    ).toBe("The person did not allow it.");
    expect(s.opened).toHaveLength(1);
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
    expect(request.agentOperation).toMatchObject({ summary: "A connected agent wants to act on Work." });
  });

  it("needs a fresh review when the grant changed between approval and resume, and refuses an ungranted profile", async ({
    storeFixture,
  }) => {
    const { database } = storeFixture;
    const s = await setUp(storeFixture, "session-regrant", { accessMode: "approval-required" });
    const refusal = await s.call("tab_open", { target: page(other), operationKey: "elsewhere" });
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
    const pending = await s.ok("tab_open", { target: page(profile), operationKey: "regrant" });
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
    const resumed = await s.ok("tab_open", { target: page(profile), operationKey: "regrant" });
    expect(resumed).toMatchObject({ status: "pending" });
    expect(resumed.requestId).not.toBe(request.id);
    expect(s.opened).toEqual([]);
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
      name: "tab_open",
      arguments: { target: page(profile), operationKey: "theirs" },
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
    await new AgentSessionService({ store: storeFixture.store, holdMs: 0 }).start();
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
