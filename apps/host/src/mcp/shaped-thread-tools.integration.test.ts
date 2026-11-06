import { randomUUID } from "node:crypto";
import { expect, vi } from "vitest";
import { sql } from "kysely";
import {
  createId,
  BrowserSurfaceIdSchema,
  type AgentEvent,
  type RunId,
  type PlaceIdentity,
  ThreadAccessModeSchema,
} from "@opensteer/core";
import {
  thread_read,
  thread_list,
  person_show,
  thread_configure,
  thread_queue,
  thread_delegate,
  task_status,
  thread_interrupt,
} from "@opensteer/agent-tools/tools";
import { ThreadReadOutputSchema } from "@opensteer/agent-tools/outputs";
import {
  appendHostWorkspaceEvent,
  withDatabaseTransaction,
  BrowserTabGroupStore,
  WorkspaceTabStore,
} from "@opensteer/database";
import {
  describeStore,
  testModelSelection,
  pendingEvent,
  enrollTestRunner,
  type StoreFixture,
} from "@opensteer/database/test-support/store";
import { CommandService, KeyedAdmissionQueue, RealtimeHub } from "@opensteer/orchestration";
import {
  createBrowserSessionId,
  ComputerUseSessionSummarySchema,
  mintComputerUseSessionId,
  type PendingAgentEvent,
  type PersonShowMessage,
} from "@opensteer/protocol";
import { BrowserService } from "../browser/browser-service.js";
import { BrowserTabGroupService } from "../browser/browser-tab-group-service.js";
import { ThreadService } from "../threads/thread-service.js";
import { ProductToolHandlers } from "./handlers/product.js";
import type { AgentCaller, RunCaller } from "./agent-caller.js";

type Fixture = Awaited<ReturnType<StoreFixture["startRunFixture"]>>;
function setup(storeFixture: StoreFixture, f: Fixture) {
  const { store } = storeFixture;
  const frames: PersonShowMessage[] = [];
  const realtime = new RealtimeHub({ store });
  const commands = new CommandService({
    store,
    admission: new KeyedAdmissionQueue({
      maxInFlight: 8,
      maxQueuedBytes: 4_000_000,
      maxQueuedCommands: 100,
    }),
    onExecutionQueued: () => {},
    onWorkspaceEvent: () => {},
  });
  const browser = new BrowserService({
    repository: store,
    signer: {} as never,
    hostOrigin: new URL("https://host.test"),
    onSessionsChanged: () => {},
    onWorkspaceEvent: () => {},
  });
  const computerUse = {
    sessionsForRunner: vi.fn<
      import("../computer-use/computer-use-service.js").ComputerUseService["sessionsForRunner"]
    >(() => []),
    authorizeDisplay: vi.fn(async () => f.runnerId),
  };
  const browserTabs = new BrowserTabGroupService({
    groups: new BrowserTabGroupStore(store.database),
    browser,
    publish: () => {},
  });
  const threads = new ThreadService({
    store,
    commands,
    browser,
    runners: {
      canRunHarness: () => true,
      isAvailable: () => true,
      harnessAccessModes: () => ThreadAccessModeSchema.options,
      identityForEnvironment: () => undefined,
      attachmentInputFailure: () => null,
    },
    placeContext: {} as never,
  });
  const product = new ProductToolHandlers({
    store,
    commands,
    browser,
    browserTabs,
    threads,
    realtime,
    computerUse,
    personShow: async (_userId, frame) => {
      frames.push(frame);
      return 1;
    },
    isEnvironmentConnected: () => true,
    canRunHarness: () => true,
    harnessAccessModes: () => ThreadAccessModeSchema.options,
    environmentWorkspaceBackings: () => ["local-directory"],
    defaultWorkspaceBacking: "local-directory",
    onWorkspaceEvent: () => {},
    browserSources: {} as never,
    machineFullDiskAccess: {} as never,
    workspaceMounts: {} as never,
    workspaces: {} as never,
  });
  const caller: RunCaller = {
    kind: "run",
    key: `run:${f.run.id}`,
    userId: f.userId,
    accessMode: f.thread.accessMode,
    reach: { kind: "user" },
    thread: f.thread,
    claims: {
      aud: "opensteer-run-tools",
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      iss: "opensteer-host",
      jti: randomUUID(),
      runId: f.run.id,
      threadId: f.thread.id,
      workspaceId: f.workspace.id,
      environmentId: f.environmentId,
      requestedBy: f.userId,
      bindingGeneration: f.bindingGeneration,
      membershipGeneration: 1,
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
    },
  };
  const read = (input: Record<string, unknown> = {}, actor: AgentCaller = caller) =>
    product.thread_read({
      caller: actor,
      input: thread_read.input.parse({ threadId: f.thread.id, ...input }),
      operationKey: randomUUID(),
    });
  const show = (target: unknown, actor: RunCaller = caller) =>
    product.person_show({
      caller: actor,
      input: person_show.input.parse({ target }),
      operationKey: randomUUID(),
    });
  return { product, caller, read, show, frames, browser, computerUse, commands };
}
async function share(storeFixture: StoreFixture, f: Fixture) {
  const reader = await storeFixture.store.createUser("Reader");
  await storeFixture.database
    .insertInto("workspaceMemberships")
    .values({
      workspaceId: f.workspace.id,
      userId: reader,
      id: createId("workspaceMembership"),
      role: "collaborator",
      state: "active",
      generation: 1,
      joinedAt: new Date(),
      invitedBy: f.userId,
    })
    .execute();
  return reader;
}
async function place(
  storeFixture: StoreFixture,
  f: Fixture,
  value: PlaceIdentity,
  title = "Place",
) {
  return withDatabaseTransaction(storeFixture.database, (tx) =>
    appendHostWorkspaceEvent(tx, {
      type: "place.entered",
      workspaceId: f.workspace.id,
      threadId: f.thread.id,
      runId: f.run.id,
      environmentId: f.environmentId,
      data: { place: value, title, site: null },
    }),
  );
}
async function tool(
  storeFixture: StoreFixture,
  f: Fixture,
  name: string,
  subject?: Extract<AgentEvent, { type: "tool.started" }>["data"]["integration"],
) {
  const callId = randomUUID();
  const base = {
    workspaceId: f.workspace.id,
    threadId: f.thread.id,
    runId: f.run.id,
    environmentId: f.environmentId,
  };
  const started = await withDatabaseTransaction(storeFixture.database, (tx) =>
    appendHostWorkspaceEvent(tx, {
      ...base,
      type: "tool.started",
      data: {
        callId,
        tool: { namespace: "opensteer", name },
        arguments: { secret: "typed-value" },
        ...(subject ? { integration: subject } : {}),
      },
    }),
  );
  const completed = await withDatabaseTransaction(storeFixture.database, (tx) =>
    appendHostWorkspaceEvent(tx, {
      ...base,
      type: "tool.completed",
      data: { callId, isError: false, output: { text: "output-secret ".repeat(100) } },
    }),
  );
  return { started, completed };
}

describeStore("shaped agent Thread tools", (it) => {
  it("filters recent places and activity for each reader in a shared Workspace", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("shaped-places");
    const nativeRunner = createId("runner");
    await enrollTestRunner(storeFixture.store, {
      createdBy: f.userId,
      runnerKind: "local",
      runnerId: nativeRunner,
      environmentId: createId("environment"),
      name: "Owned machine",
      tokenSuffix: randomUUID(),
    });
    const reader = await share(storeFixture, f);
    const s = setup(storeFixture, f);
    const sessionId = createBrowserSessionId();
    await storeFixture.store.createBrowserSession({
      id: sessionId,
      runnerId: f.runnerId,
      origin: "workspace",
      placementKey: "shared",
      profileId: null,
      runtimeId: "test",
      workspaceId: f.workspace.id,
    });
    const values: PlaceIdentity[] = [
      { kind: "app", machineId: nativeRunner, appKey: "com.apple.finder" },
      { kind: "phone", machineId: nativeRunner, display: "main" },
      { kind: "browser", sessionId, surfaceId: BrowserSurfaceIdSchema.parse("shared") },
      {
        kind: "browser",
        sessionId: createBrowserSessionId(),
        surfaceId: BrowserSurfaceIdSchema.parse("private"),
      },
    ];
    for (const value of values) await place(storeFixture, f, value);
    const owner = await s.read({ view: "activity" });
    expect(owner.recentPlaces.map((p) => p.place)).toEqual(values.slice(0, 3).reverse());
    const actor = { ...s.caller, userId: reader };
    const visible = await s.read({ view: "activity" }, actor);
    expect(visible.recentPlaces.map((p) => p.place)).toEqual([values[2]]);
    expect(visible.items.filter((i) => i.type === "place.entered")).toHaveLength(1);
    await expect(
      s.read(
        { view: "activity", itemId: (await place(storeFixture, f, values[0]!)).sequence },
        actor,
      ),
    ).rejects.toMatchObject({ code: "forbidden", message: "Item is unavailable in this Thread" });
    const outsider = await storeFixture.store.createUser("Outsider");
    await expect(s.read({}, { ...actor, userId: outsider })).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("bounds recent places to the newest 25 Runs, deduplicates them, and returns the newest ten", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("shaped-place-bounds"),
      s = setup(storeFixture, f);
    const sessionId = createBrowserSessionId();
    await storeFixture.store.createBrowserSession({
      id: sessionId,
      runnerId: f.runnerId,
      origin: "workspace",
      placementKey: "bounds",
      profileId: null,
      runtimeId: "test",
      workspaceId: f.workspace.id,
    });
    const row = await storeFixture.database
      .selectFrom("runs")
      .selectAll()
      .where("id", "=", f.run.id)
      .executeTakeFirstOrThrow();
    const runIds: RunId[] = [];
    for (let i = 0; i < 30; i++) {
      const id = createId("run");
      runIds.push(id);
      await storeFixture.database
        .insertInto("runs")
        .values({
          ...row,
          inputTokens: null,
          outputTokens: null,
          cachedInputTokens: null,
          cacheWriteTokens: null,
          reasoningTokens: null,
          costUsd: null,
          id,
          runOrdinal: row.runOrdinal + i + 1,
          status: "completed",
          completedAt: new Date(),
        })
        .execute();
      const target = { ...f, run: { ...f.run, id } };
      await place(
        storeFixture,
        target,
        { kind: "browser", sessionId, surfaceId: BrowserSurfaceIdSchema.parse(`tab-${i}`) },
        String(i),
      );
    }
    const last = { ...f, run: { ...f.run, id: runIds.at(-1)! } };
    await place(
      storeFixture,
      last,
      { kind: "browser", sessionId, surfaceId: BrowserSurfaceIdSchema.parse("tab-29") },
      "Newest duplicate",
    );
    const read = await s.read({ runLimit: 3 });
    expect(read.recentRuns.map((r) => r.runId)).toEqual(runIds.slice(-3).reverse());
    expect(read.recentPlaces).toHaveLength(10);
    expect(read.recentPlaces.map((p) => p.title)).toEqual([
      "Newest duplicate",
      ...Array.from({ length: 9 }, (_, i) => String(28 - i)),
    ]);
    const { readAgentThreadRecent } = await import("@opensteer/database");
    expect(
      (await readAgentThreadRecent(storeFixture.database, {
        threadId: f.thread.id,
        ownerId: f.userId,
        runLimit: 3,
      }))!.places.every((p) => runIds.slice(-25).includes(p.runId!)),
    ).toBe(true);
  });

  it("withholds sensitive tools even by itemId and resolves starts outside a completion-only page", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("shaped-tools");
    const s = setup(storeFixture, f);
    for (const name of ["sign_in", "use_card", "computer", "computer.type"]) {
      const t = await tool(storeFixture, f, name);
      for (const event of [t.started, t.completed])
        expect((await s.read({ view: "activity", itemId: event.sequence })).items[0]).toMatchObject(
          { title: name, text: null, textTruncated: false },
        );
      expect((await s.read({ view: "activity", limit: 1 })).items[0]).toMatchObject({
        title: name,
        text: null,
      });
    }
    const safe = await tool(storeFixture, f, "shell");
    const clipped = (await s.read({ view: "activity", limit: 1 })).items[0]!;
    expect(clipped).toMatchObject({ title: "shell", textTruncated: true, nextTextOffset: 500 });
    expect(clipped.text).toHaveLength(500);
    expect(
      (await s.read({ view: "activity", itemId: safe.completed.sequence })).items[0]!.text,
    ).toBe("output-secret ".repeat(100));
    expect(
      (await s.read({ view: "activity", itemId: safe.started.sequence })).items[0]!.text,
    ).toContain("typed-value");
    const nativeRunner = createId("runner");
    await enrollTestRunner(storeFixture.store, {
      createdBy: f.userId,
      runnerKind: "local",
      runnerId: nativeRunner,
      environmentId: createId("environment"),
      name: "Owned machine",
      tokenSuffix: randomUUID(),
    });
    const subject = {
      account: "Mac",
      computerApp: {
        runnerId: nativeRunner,
        bundleId: "com.apple.finder",
        app: "Finder",
        computer: "Mac",
      },
      effect: "read" as const,
      integration: "Computer",
      operation: { name: "observe", title: "Observe" },
    };
    const reader = await share(storeFixture, f);
    for (const native of [
      subject,
      { ...subject, computerApp: null, phone: { runnerId: nativeRunner, computer: "Phone" } },
    ]) {
      const t = await tool(storeFixture, f, "integration_call", native);
      for (const e of [t.started, t.completed])
        await expect(
          s.read({ view: "activity", itemId: e.sequence }, { ...s.caller, userId: reader }),
        ).rejects.toMatchObject({
          code: "forbidden",
          message: "Item is unavailable in this Thread",
        });
    }
    await storeFixture.database
      .deleteFrom("workspaceEvents")
      .where("sequence", "=", safe.started.sequence)
      .execute();
    expect(
      (await s.read({ view: "activity", itemId: safe.completed.sequence })).items[0]!.text,
    ).toBeNull();
  });

  it("orders activity messages with events, pages by event sequence, and omits reasoning, node text and Request payloads", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("shaped-events");
    const s = setup(storeFixture, f);
    const request = await storeFixture.openLiveRequest(f, createId("request"));
    const base = {
      bindingGeneration: f.bindingGeneration,
      environmentId: f.environmentId,
      runId: f.run.id,
      threadId: f.thread.id,
      workspaceId: f.workspace.id,
    };
    const commit = (event: PendingAgentEvent) =>
      storeFixture.store.commitRunnerEvent({
        environmentId: f.environmentId,
        runnerId: f.runnerId,
        runnerBootId: f.runnerBootId,
        event,
      });
    await commit(
      pendingEvent({
        ...base,
        ordinal: 2,
        type: "reasoning.completed",
        data: { blockId: "private", text: "PRIVATE_REASONING" },
      }),
    );
    const nodeId = createId("executionNode");
    await commit(
      pendingEvent({
        ...base,
        ordinal: 3,
        type: "node.started",
        data: {
          kind: "subagent",
          model: null,
          nativeRef: "child",
          nodeId,
          originCallId: null,
          parentNodeId: null,
          prompt: "PRIVATE_PROMPT",
          sessionRef: null,
          title: "Research",
        },
      }),
    );
    await commit(
      pendingEvent({
        ...base,
        ordinal: 4,
        type: "node.completed",
        data: { nodeId, status: "completed", result: "PRIVATE_RESULT", usage: null },
      }),
    );
    const messageId = createId("message");
    await commit(
      pendingEvent({
        ...base,
        ordinal: 5,
        type: "assistant.message",
        data: { messageId, content: [{ type: "text", text: "Published answer" }] },
      }),
    );
    const page = await s.read({ view: "activity", limit: 1 });
    expect(page.items[0]).toMatchObject({ itemId: messageId, text: "Published answer" });
    const earlier = await s.read({ view: "activity", before: page.nextBefore });
    expect(
      earlier.items
        .filter((i) => i.type.startsWith("node."))
        .map((i) => ({ title: i.title, status: i.status, text: i.text })),
    ).toEqual([
      { title: "Research", status: "completed", text: null },
      { title: "Research", status: "started", text: null },
    ]);
    expect(earlier.items.find((i) => i.type === "request.opened")).toMatchObject({
      title: "Approval required",
    });
    const serialized = JSON.stringify(earlier);
    for (const secret of [
      "PRIVATE_REASONING",
      "PRIVATE_PROMPT",
      "PRIVATE_RESULT",
      "payload",
      "response",
    ])
      expect(serialized).not.toContain(secret);
    expect((await s.read({ view: "activity", itemId: messageId })).items).toEqual(page.items);
    expect(
      (await s.read({ view: "activity", itemId: request.event.sequence })).items[0],
    ).toMatchObject({ title: "Approval required" });
  });

  it("pages projected text and large messages within the agent byte limit without splitting a surrogate pair", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("shaped-paging");
    const s = setup(storeFixture, f);
    await storeFixture.database
      .updateTable("messages")
      .set({
        content: sql`${JSON.stringify([
          { type: "text", text: "a😀" + "x".repeat(175000) },
          { type: "text", text: "x".repeat(175000) },
        ])}::jsonb`,
      })
      .where("id", "=", f.turn.message.id)
      .execute();
    const first = await s.read({ maxCharsPerItem: 2 });
    expect(first.items[0]).toMatchObject({ text: "a😀", textTruncated: true, nextTextOffset: 2 });
    const rest = await s.read({ itemId: f.turn.message.id, textOffset: 2, maxCharsPerItem: 4 });
    expect(rest.items[0]!.text).toBe("xxxx");
    const original = await storeFixture.database
      .selectFrom("messages")
      .selectAll()
      .where("id", "=", f.turn.message.id)
      .executeTakeFirstOrThrow();
    for (let i = 1; i <= 20; i++)
      await storeFixture.database
        .insertInto("messages")
        .values({
          ...original,
          id: createId("message"),
          sequence: String(BigInt(original.sequence) + BigInt(i)),
          content: sql`${JSON.stringify([{ type: "text", text: "z".repeat(50000) }])}::jsonb`,
        })
        .execute();
    const page = await s.read({ limit: 100, maxCharsPerItem: 50000 });
    expect(Buffer.byteLength(JSON.stringify(page.items))).toBeLessThanOrEqual(256 * 1024);
    expect(page.hasMore).toBe(true);
    expect(page.nextBefore).not.toBeNull();
    ThreadReadOutputSchema.parse(page);
    const older = await s.read({ limit: 100, maxCharsPerItem: 50000, before: page.nextBefore });
    expect(older.items.length).toBeGreaterThan(0);
    expect(older.items.some((i) => page.items.some((p) => p.itemId === i.itemId))).toBe(false);
  });

  it("reads configure and lists queue by default on this Thread and refuses unnamed connection targets", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("shaped-configure");
    const s = setup(storeFixture, f);
    const configuration = await s.product.thread_configure({
      caller: s.caller,
      input: thread_configure.input.parse({}),
      operationKey: randomUUID(),
    });
    expect(configuration).toMatchObject({
      threadId: f.thread.id,
      providerSessionId: f.thread.providerSessionId,
      modelSelection: testModelSelection,
    });
    const queue = await s.product.thread_queue({
      caller: s.caller,
      input: thread_queue.input.parse({ action: "list" }),
      operationKey: randomUUID(),
    });
    expect(queue).toEqual({ paused: false, items: [] });
    expect((await s.read({ threadId: "self" })).thread.id).toBe(f.thread.id);
    const here = await s.product.thread_delegate({
      caller: s.caller,
      input: thread_delegate.input.parse({
        environmentId: f.environmentId,
        harnessInstanceId: f.harnessInstance.id,
        model: { ...testModelSelection, options: {} },
        task: "Work here",
      }),
      operationKey: randomUUID(),
    });
    expect(here.workspaceId).toBe(f.thread.workspaceId);
    const connection: AgentCaller = {
      kind: "connection",
      key: "connection:test",
      connectionId: "test",
      userId: f.userId,
      reach: { kind: "user" },
      accessMode: "full-access",
    };
    await expect(
      s.product.thread_configure({
        caller: connection,
        input: thread_configure.input.parse({}),
        operationKey: randomUUID(),
      }),
    ).rejects.toThrow("must name threadId");
    await expect(
      s.product.thread_queue({
        caller: connection,
        input: thread_queue.input.parse({ action: "list" }),
        operationKey: randomUUID(),
      }),
    ).rejects.toThrow("must name threadId");
    await expect(s.read({ threadId: "self" }, connection)).rejects.toThrow("must name threadId");
    await expect(
      s.product.thread_list({
        caller: connection,
        input: thread_list.input.parse({ parentThreadId: "self" }),
        operationKey: randomUUID(),
      }),
    ).rejects.toThrow("must name parentThreadId");
  });

  it("returns one task shape on delegation and replay, full results, and open/latest assignments across Workspaces", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("shaped-tasks");
    const s = setup(storeFixture, f);
    const { createTestWorkspace } = await import("@opensteer/database/test-support/workspace");
    const workspace = await createTestWorkspace(storeFixture.store, {
      createdBy: f.userId,
      kind: "project",
      name: "Workers",
      idempotencyKey: "worker-workspace",
      status: "ready",
      backing: {
        ...f.workspace.backing,
        bindingId: createId("workspaceBinding"),
        storageAuthorityId: createId("storageAuthority"),
      },
    });
    const input = thread_delegate.input.parse({
      workspaceId: workspace.id,
      environmentId: f.environmentId,
      harnessInstanceId: f.harnessInstance.id,
      model: { ...testModelSelection, options: {} },
      title: "Worker",
      task: "Do the work",
    });
    const operationKey = randomUUID();
    const delegated = await s.product.thread_delegate({ caller: s.caller, input, operationKey });
    expect(delegated).toMatchObject({
      assignmentId: expect.any(String),
      status: "open",
      threadId: expect.any(String),
      parentThreadId: f.thread.id,
    });
    expect(await s.product.thread_delegate({ caller: s.caller, input, operationKey })).toEqual(
      delegated,
    );
    const list = () =>
      s.product.thread_list({
        caller: s.caller,
        input: thread_list.input.parse({ parentThreadId: "self" }),
        operationKey: randomUUID(),
      });
    expect((await list()).threads).toContainEqual(
      expect.objectContaining({
        id: delegated.threadId,
        assignmentId: delegated.assignmentId,
        taskStatus: "open",
        workspaceId: workspace.id,
      }),
    );
    await storeFixture.store.cancelAssignment({
      assignmentId: delegated.assignmentId!,
      requestedBy: f.userId,
      actorRunId: f.run.id,
      idempotencyKey: "close-first",
    });
    const sessionId = createBrowserSessionId(),
      tabId = BrowserSurfaceIdSchema.parse("cross-workspace-guest");
    await storeFixture.store.createBrowserSession({
      id: sessionId,
      runnerId: f.runnerId,
      origin: "agent",
      placementKey: "cross-guest",
      profileId: null,
      runtimeId: "test",
      workspaceId: workspace.id,
    });
    await new WorkspaceTabStore(storeFixture.database).record(
      sessionId,
      [{ id: tabId, title: "Guest", url: "https://example.com", order: 0, openerId: null }],
      [],
    );
    await place(
      storeFixture,
      {
        ...f,
        thread: (await storeFixture.store.getThreadForOwner(delegated.threadId, f.userId))!,
        run: { ...f.run, id: delegated.runId! },
      },
      { kind: "browser", sessionId, surfaceId: tabId },
    );
    await s.show({ runId: delegated.runId });
    expect(s.frames.at(-1)).toMatchObject({
      runId: f.run.id,
      target: { runId: delegated.runId, place: { surfaceId: tabId } },
    });
    const next = await s.product.thread_delegate({
      caller: s.caller,
      input: thread_delegate.input.parse({ threadId: delegated.threadId, task: "Continue" }),
      operationKey: randomUUID(),
    });
    expect((await list()).threads.find((t) => t.id === delegated.threadId)).toMatchObject({
      assignmentId: next.assignmentId,
      taskStatus: "open",
    });
    const result = "full-result ".repeat(2000);
    await storeFixture.database
      .updateTable("delegations")
      .set({
        status: "completed",
        resultText: result,
        resultRunId: next.runId,
        finishedAt: new Date(),
      })
      .where("id", "=", next.assignmentId!)
      .execute();
    const connection: AgentCaller = {
      kind: "connection",
      key: "connection:task",
      connectionId: "task",
      userId: f.userId,
      reach: { kind: "user" },
      accessMode: "approval-required",
    };
    const status = await s.product.task_status({
      caller: connection,
      input: task_status.input.parse({ assignmentId: next.assignmentId }),
      operationKey: randomUUID(),
    });
    expect(status.result).toBe(result);
    const program: AgentCaller = {
      kind: "program",
      key: "program:test",
      userId: f.userId,
      reach: { kind: "user" },
      accessMode: "approval-required",
      anchor: f.thread,
      program: {} as never,
    };
    expect(
      (
        await s.product.task_status({
          caller: program,
          input: { assignmentId: next.assignmentId! },
          operationKey: randomUUID(),
        })
      ).result,
    ).toBe(result);
    await expect(
      s.product.task_status({
        caller: { ...connection, reach: { kind: "workspace", workspaceId: f.workspace.id } },
        input: { assignmentId: next.assignmentId! },
        operationKey: randomUUID(),
      }),
    ).rejects.toThrow("reach");
    expect((await list()).threads.find((t) => t.id === delegated.threadId)).toMatchObject({
      assignmentId: next.assignmentId,
      taskStatus: "completed",
    });
    const reader = await storeFixture.store.createUser("Worker reader");
    await storeFixture.database
      .insertInto("workspaceMemberships")
      .values({
        id: createId("workspaceMembership"),
        workspaceId: workspace.id,
        userId: reader,
        role: "collaborator",
        state: "active",
        generation: 1,
        joinedAt: new Date(),
        invitedBy: f.userId,
      })
      .execute();
    const hidden = await s.product.thread_list({
      caller: { ...connection, userId: reader },
      input: thread_list.input.parse({}),
      operationKey: randomUUID(),
    });
    expect(hidden.threads.find((t) => t.id === delegated.threadId)).toMatchObject({
      assignmentId: null,
      taskStatus: null,
      parentThreadId: null,
    });
    await storeFixture.database
      .updateTable("runs")
      .set({ status: "completed", completedAt: new Date() })
      .where("threadId", "=", f.thread.id)
      .execute();
    expect(
      await s.product.thread_interrupt({
        caller: s.caller,
        input: thread_interrupt.input.parse({}),
        operationKey: randomUUID(),
      }),
    ).toEqual({ interruptedRunId: null });
  });

  it("shows another Run using the caller actor and emits both Run identities, with reach but no write ceiling", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("shaped-show");
    const s = setup(storeFixture, f);
    const nativeRunner = createId("runner");
    await enrollTestRunner(storeFixture.store, {
      createdBy: f.userId,
      runnerKind: "local",
      runnerId: nativeRunner,
      environmentId: createId("environment"),
      name: "Owned machine",
      tokenSuffix: randomUUID(),
    });
    const delegated = await storeFixture.store.delegateThread({
      createdBy: f.userId,
      environmentId: f.environmentId,
      harnessInstanceId: f.harnessInstance.id,
      modelSelection: testModelSelection,
      workspaceId: f.workspace.id,
      origin: { kind: "run", parentRunId: f.run.id, parentThreadId: f.thread.id },
      task: [{ type: "text", text: "Task" }],
      title: "Task",
      accessMode: "full-access",
      idempotencyKey: "show-task",
    });
    const target = { ...f, run: delegated.run, thread: delegated.thread };
    await expect(s.show({ runId: delegated.run.id })).rejects.toThrow("thread_read");
    const sessionId = createBrowserSessionId();
    const tabId = BrowserSurfaceIdSchema.parse("guest-task");
    await storeFixture.store.createBrowserSession({
      id: sessionId,
      runnerId: f.runnerId,
      origin: "agent",
      placementKey: "guest",
      profileId: null,
      runtimeId: "test",
      workspaceId: f.workspace.id,
    });
    await new WorkspaceTabStore(storeFixture.database).record(
      sessionId,
      [{ id: tabId, title: "Guest", url: "https://example.com", order: 0, openerId: null }],
      [],
    );
    await place(storeFixture, target, { kind: "browser", sessionId, surfaceId: tabId });
    await s.show({ runId: delegated.run.id }, { ...s.caller, accessMode: "approval-required" });
    expect(s.frames[0]).toMatchObject({
      runId: f.run.id,
      target: { runId: delegated.run.id, place: { kind: "browser", surfaceId: tabId } },
    });
    await expect(
      s.show(
        { runId: delegated.run.id },
        { ...s.caller, reach: { kind: "lineage", lineageRootThreadId: createId("thread") } },
      ),
    ).rejects.toThrow("reach");
    await expect(
      s.show(
        { current: true },
        { ...s.caller, claims: { ...s.caller.claims, runId: delegated.run.id } },
      ),
    ).rejects.toThrow("assigned it");
    await place(storeFixture, target, {
      kind: "app",
      machineId: nativeRunner,
      appKey: "com.apple.finder",
    });
    await expect(s.show({ runId: delegated.run.id })).rejects.toThrow("Run's app session ended");
    const appSession = ComputerUseSessionSummarySchema.parse({
      sessionId: mintComputerUseSessionId(),
      runId: f.run.id,
      threadId: f.thread.id,
      threadTitle: "Other Run",
      openedAt: new Date().toISOString(),
      actionCount: 0,
      apps: [{ bundleId: "com.apple.finder", displayName: "Finder", teamId: null }],
      display: false,
    });
    s.computerUse.sessionsForRunner.mockReturnValue([appSession]);
    await expect(s.show({ runId: delegated.run.id })).rejects.toThrow("Run's app session ended");
    expect(s.computerUse.authorizeDisplay).not.toHaveBeenCalled();
    s.computerUse.sessionsForRunner.mockReturnValue([{ ...appSession, runId: delegated.run.id }]);
    await s.show({ runId: delegated.run.id });
    s.computerUse.sessionsForRunner.mockReturnValue([]);
    await expect(s.show({ runId: delegated.run.id })).rejects.toThrow("Run's app session ended");
    await place(storeFixture, target, { kind: "phone", machineId: nativeRunner, display: "main" });
    await storeFixture.database
      .updateTable("runs")
      .set({ status: "completed", completedAt: new Date() })
      .where("id", "=", delegated.run.id)
      .execute();
    await s.show({ runId: delegated.run.id });
    const reader = await share(storeFixture, f);
    await expect(
      s.show(
        { runId: delegated.run.id },
        { ...s.caller, userId: reader, claims: { ...s.caller.claims, requestedBy: reader } },
      ),
    ).rejects.toThrow("unavailable");
  });
});
