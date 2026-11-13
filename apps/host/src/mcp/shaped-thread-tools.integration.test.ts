import { personalBrowserRepository } from "@opensteer/database/test-support/store";
import { personalTestExecution } from "./personal-execution.test-support.js";
import { randomUUID } from "node:crypto";
import { AesGcmSecretVault, StaticEncryptionKeyProvider } from "@opensteer/access/host";
import { expect, vi } from "vitest";
import { sql } from "kysely";
import {
  createId,
  BrowserSurfaceIdSchema,
  type AgentEvent,
  type RunId,
  type PlaceIdentity,
  ThreadAccessModeSchema,
  RequestKindSchema,
  PendingRequestSchema,
  type RequestPayload,
  type RequestResponse,
} from "@opensteer/core";
import {
  thread_read,
  thread_list,
  person_show,
  thread_configure,
  thread_queue,
  delegate_task,
  task_status,
  task_cancel,
  thread_interrupt,
  thread_wait,
  pending_request,
  orchestrator_capabilities,
} from "@opensteer/agent-tools/tools";
import { ThreadReadOutputSchema } from "@opensteer/agent-tools/outputs";
import {
  appendHostDeploymentEvent,
  needsYouPage,
  dispatchNodeStop,
  withDatabaseTransaction,
  BrowserTabGroupStore,
  PersonalTabStore,
  assignmentSummaryInTransaction,
  withDatabaseOperationSignal,
  AgentConnectionStore,
  requestRevision,
  deliverTaskQuestionNotice,
  cancelSettledTaskQuestionNotice,
  requestInsert,
} from "@opensteer/database";
import {
  describeStore,
  testModelSelection,
  pendingEvent,
  liveRequest,
  testContinuationIdentity,
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
import { TaskQuestionNotices } from "../threads/task-question-notices.js";
import { openRequestResponse, sealRequestResponse } from "../identity/request-response-vault.js";

type Fixture = Awaited<ReturnType<StoreFixture["startRunFixture"]>>;
function setup(storeFixture: StoreFixture, f: Fixture) {
  const { store } = storeFixture;
  const frames: PersonShowMessage[] = [];
  const realtime = new RealtimeHub({ store });
  const vault = new AesGcmSecretVault(
    new StaticEncryptionKeyProvider(new Map([[1, Buffer.alloc(32, 7)]]), 1),
  );
  const questionNotices = new TaskQuestionNotices({
    database: store.database,
    publish: (event) => realtime.publish(event),
    wake: () => {},
    onError: (error) => {
      throw error;
    },
  });
  const commands = new CommandService({
    store,
    admission: new KeyedAdmissionQueue({
      maxInFlight: 8,
      maxQueuedBytes: 4_000_000,
      maxQueuedCommands: 100,
    }),
    onExecutionQueued: () => {},
    onDeploymentEvent: (event) => realtime.publish(event),
  });
  const browser = new BrowserService({
    deploymentId: f.deploymentId,
    repository: personalBrowserRepository(store),
    signer: {} as never,
    hostOrigin: new URL("https://host.test"),
    onSessionsChanged: () => {},
    onDeploymentEvent: (event) => realtime.publish(event),
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
    deploymentId: createId("deployment"),
    store,
    commands,
    browser,
    browserTabs,
    threads,
    realtime,
    requestResponseVault: vault,
    questionNotices,
    computerUse,
    personShow: async (_userId, frame) => {
      frames.push(frame);
      return 1;
    },
    isEnvironmentConnected: () => true,
    canRunHarness: () => true,
    harnessAccessModes: () => ThreadAccessModeSchema.options,
    onEvent: () => {},
    browserSources: {} as never,
    deviceAccess: {} as never,
    machineFullDiskAccess: {} as never,
    execution: personalTestExecution(store, f),
  });
  const caller: RunCaller = {
    kind: "run",
    key: `run:${f.run.id}`,
    userId: f.userId,
    accessMode: f.thread.accessMode,
    thread: f.thread,
    claims: {
      aud: "opensteer-run-tools",
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      iss: "opensteer-host",
      jti: randomUUID(),
      runId: f.run.id,
      threadId: f.thread.id,
      environmentId: f.environmentId,
      requestedBy: f.userId,
      bindingGeneration: f.bindingGeneration,
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
  return {
    product,
    caller,
    read,
    show,
    frames,
    browser,
    computerUse,
    commands,
    realtime,
    vault,
    questionNotices,
  };
}

async function waitingTask(storeFixture: StoreFixture, suffix: string) {
  const f = await storeFixture.startRunFixture(suffix);
  const s = setup(storeFixture, f);
  const task = await s.product.delegate_task({
    caller: s.caller,
    input: delegate_task.input.parse({ task: "Find the answer" }),
    operationKey: randomUUID(),
  });
  const assignmentId = task.assignmentId!;
  const wake = async () => {
    const event = await withDatabaseTransaction(storeFixture.database, async (tx) => {
      const row = await tx
        .selectFrom("delegations")
        .selectAll()
        .where("id", "=", assignmentId)
        .executeTakeFirstOrThrow();
      return appendHostDeploymentEvent(tx, {
        type: "assignment.updated",
        threadId: task.threadId,
        environmentId: task.environmentId,
        runId: null,
        data: { assignment: await assignmentSummaryInTransaction(tx, row) },
      });
    });
    s.realtime.publish(event);
  };
  const settle = async (result = "42") => {
    await storeFixture.database
      .updateTable("delegations")
      .set({
        status: "completed",
        resultText: result,
        resultRunId: task.runId,
        finishedAt: new Date(),
      })
      .where("id", "=", assignmentId)
      .execute();
  };
  const startWorker = async () => {
    const command = await storeFixture.database
      .selectFrom("commands")
      .select("id")
      .where("runId", "=", task.runId)
      .where("type", "=", "run.execute")
      .executeTakeFirstOrThrow();
    await storeFixture.store.claimCommand(command.id, `${suffix}-child`);
    const binding = await storeFixture.store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: f.harnessInstance.id,
      leaseTokenHash: `${suffix}-child`,
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
      runId: task.runId!,
      threadId: task.threadId,
    });
    await storeFixture.store.commitRunnerEvent({
      environmentId: f.environmentId,
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
      event: pendingEvent({
        bindingGeneration: binding.bindingGeneration,
        data: { status: "running" },
        environmentId: f.environmentId,
        ordinal: 0,
        runId: task.runId!,
        threadId: task.threadId,
        type: "run.started",
      }),
    });
    return binding;
  };
  const checkLive = vi.fn(async () => {});
  const wait = (timeoutMs = 2_000, caller: AgentCaller = s.caller, signal?: AbortSignal) =>
    s.product.thread_wait({
      caller,
      input: thread_wait.input.parse({ assignmentId, timeoutMs }),
      operationKey: randomUUID(),
      checkLive,
      ...(signal ? { signal } : {}),
    });
  const status = (caller: AgentCaller = s.caller) =>
    s.product.task_status({ caller, input: { assignmentId }, operationKey: randomUUID() });
  const returns = () =>
    storeFixture.database
      .selectFrom("threadInputs")
      .selectAll()
      .where("threadId", "=", f.thread.id)
      .where("idempotencyKey", "=", `assignment-return:${assignmentId}`)
      .where("state", "!=", "cancelled")
      .execute();
  return {
    ...s,
    f,
    task,
    assignmentId,
    wake,
    settle,
    startWorker,
    wait,
    status,
    returns,
    checkLive,
  };
}

async function questionTask(
  storeFixture: StoreFixture,
  suffix: string,
  beforeOpen?: (task: Awaited<ReturnType<typeof waitingTask>>) => Promise<void>,
) {
  const s = await waitingTask(storeFixture, suffix);
  const binding = await s.startWorker();
  await beforeOpen?.(s);
  const request = liveRequest({
    id: createId("request"),
    harnessInstanceId: s.f.harnessInstance.id,
    requestedBy: s.f.userId,
    runId: s.task.runId!,
    threadId: s.task.threadId,
    presentation: {
      kind: "form",
      title: "Which format?",
      fields: [
        { id: "format", prompt: "Choose the export format", multiSelect: false, secret: false },
      ],
    },
  });
  const opened = await storeFixture.store.commitRunnerEvent({
    environmentId: s.f.environmentId,
    runnerBootId: s.f.runnerBootId,
    runnerId: s.f.runnerId,
    event: pendingEvent({
      environmentId: s.f.environmentId,
      runId: s.task.runId!,
      threadId: s.task.threadId,
      bindingGeneration: binding.bindingGeneration,
      ordinal: 1,
      type: "request.opened",
      data: { request },
    }),
  });
  const readRequest = (actor: AgentCaller = s.caller, requestId = request.id) =>
    s.product.pending_request({
      caller: actor,
      input: pending_request.input.parse({ action: "read", requestId }),
      operationKey: randomUUID(),
    });
  const respond = (
    actor: AgentCaller = s.caller,
    expectedRevision = requestRevision(request),
    requestId = request.id,
  ) =>
    s.product.pending_request({
      caller: actor,
      input: pending_request.input.parse({
        action: "respond",
        requestId,
        expectedRevision,
        response: { kind: "form", answers: { format: ["CSV"] } },
      }),
      operationKey: randomUUID(),
    });
  const dispatch = async () => {
    const command = await storeFixture.database
      .selectFrom("commands")
      .selectAll()
      .where("type", "=", "request.respond")
      .where("runId", "=", s.task.runId)
      .executeTakeFirstOrThrow();
    await storeFixture.store.claimCommand(command.id, `${suffix}-response`);
    let received: RequestResponse | undefined;
    const events = await storeFixture.store.dispatchRequestResponse(
      command.id,
      async (beforeAck) => {
        received = await openRequestResponse(s.vault, command.encryptedRequestResponse!, {
          requestId: request.id,
          runId: s.task.runId!,
          threadId: s.task.threadId,
        });
        await beforeAck();
      },
    );
    return { events, received, command };
  };
  const stored = (await storeFixture.store.requests.get(request.id))!;
  return {
    ...s,
    request: stored,
    opened,
    binding,
    readRequest,
    respond: (
      actor: AgentCaller = s.caller,
      expectedRevision = requestRevision(stored),
      requestId = request.id,
    ) => respond(actor, expectedRevision, requestId),
    dispatch,
  };
}

describeStore("agents answering task questions", (it) => {
  it("allows an unrelated agent with write authority to answer", async ({ storeFixture }) => {
    const s = await questionTask(storeFixture, "question-unrelated");
    const { thread } = await storeFixture.store.createThread({
      createdBy: s.f.userId,
      environmentId: s.f.environmentId,
      harnessInstanceId: s.f.harnessInstance.id,
      idempotencyKey: randomUUID(),
      modelSelection: testModelSelection,
      title: "Independent reviewer",
    });
    const turn = await storeFixture.enqueueHumanTrigger({
      content: [{ type: "text", text: "Review the export" }],
      idempotencyKey: randomUUID(),
      requestedBy: s.f.userId,
      threadId: thread.id,
    });
    await storeFixture.store.claimCommand(turn.command.id, "independent-reviewer");
    const binding = await storeFixture.store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: s.f.harnessInstance.id,
      leaseTokenHash: randomUUID(),
      runnerBootId: s.f.runnerBootId,
      runnerId: s.f.runnerId,
      runId: turn.run.id,
      threadId: thread.id,
    });
    await storeFixture.store.commitRunnerEvent({
      environmentId: s.f.environmentId,
      runnerBootId: s.f.runnerBootId,
      runnerId: s.f.runnerId,
      event: pendingEvent({
        environmentId: s.f.environmentId,
        threadId: thread.id,
        runId: turn.run.id,
        bindingGeneration: binding.bindingGeneration,
        ordinal: 0,
        type: "run.started",
        data: { status: "running" },
      }),
    });
    const reviewer: RunCaller = {
      ...s.caller,
      thread,
      key: `run:${turn.run.id}`,
      claims: {
        ...s.caller.claims,
        runId: turn.run.id,
        threadId: thread.id,
        bindingGeneration: binding.bindingGeneration,
      },
    };
    await s.respond(reviewer);
    await s.dispatch();
    expect(await storeFixture.store.requests.get(s.request.id)).toMatchObject({
      status: "fulfilled",
      resolvedBy: null,
      settlementProvenance: { kind: "agent", runId: turn.run.id, title: "Independent reviewer" },
    });
  });

  it("delivers the parent's answer to the waiting Run with agent attribution and clears Needs you", async ({
    storeFixture,
  }) => {
    const s = await questionTask(storeFixture, "question-answer");
    expect(await s.readRequest()).toMatchObject({
      request: { presentation: s.request.presentation, revision: requestRevision(s.request) },
    });
    await s.respond();
    const { received, events, command } = await s.dispatch();
    expect(received).toEqual({ kind: "form", answers: { format: ["CSV"] } });
    expect(command.authoritySource).toMatchObject({ kind: "thread-agent", runId: s.f.run.id });
    expect(events.filter((event) => event.type === "request.resolved")).toHaveLength(1);
    const settled = await storeFixture.store.requests.get(s.request.id);
    expect(settled).toMatchObject({
      status: "fulfilled",
      resolvedBy: null,
      settlementProvenance: {
        kind: "agent",
        runId: s.f.run.id,
        threadId: s.f.thread.id,
        title: s.f.thread.title,
      },
    });
    expect((await needsYouPage(storeFixture.database, { userId: s.f.userId })).entries).toEqual([]);
    expect(
      await storeFixture.database
        .selectFrom("runs")
        .select("status")
        .where("id", "=", s.task.runId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "running" });
  });

  it("refuses every human-only kind without exposing question fields", async ({ storeFixture }) => {
    const s = await questionTask(storeFixture, "question-human-only");
    const reason = "Person must decide";
    const payloads: Record<typeof s.request.kind, RequestPayload> = {
      "harness.input": { kind: "harness.input" },
      "harness.approval": { kind: "harness.approval" },
      "browser.access": { kind: "browser.access", reason, suggestion: { kind: "user_choice" } },
      "browser.sign-in": {
        kind: "browser.sign-in",
        reason,
        sessionId: "session",
        site: "https://example.com",
      },
      "browser.password-sign-in": {
        kind: "browser.password-sign-in",
        reason,
        computerName: "Mac",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        operationId: randomUUID(),
        runnerId: s.f.runnerId,
        scope: "personal",
        permissionVersion: 6,
        site: "https://example.com",
      },
      "integration.access": {
        kind: "integration.access",
        reason,
        access: "read",
        installationId: "installation",
        manifest: null,
        requestedConnectionId: null,
        requestedServerId: null,
      },
      "integration.install": { kind: "integration.install", reason, manifest: {} },
      "device.access": {
        kind: "device.access",
        reason,
        machineId: s.f.runnerId,
        machineName: "Mac",
        access: "files",
      },
      "machine.full-disk-access": {
        kind: "machine.full-disk-access",
        reason,
        machineId: s.f.runnerId,
        machineName: "Mac",
      },
      "computer.app.access": {
        kind: "computer.app.access",
        reason,
        access: "read",
        app: null,
        definitionId: "android-phone",
        runnerId: s.f.runnerId,
        setupRequestId: randomUUID(),
      },
      "integration.input": {
        kind: "integration.input",
        installationId: "installation",
        serverId: "server",
      },
    };
    for (const kind of RequestKindSchema.options.filter((kind) => kind !== "harness.input")) {
      const request = PendingRequestSchema.parse({
        ...s.request,
        id: createId("request"),
        callId: randomUUID(),
        kind,
        mode: kind.startsWith("harness.") ? "live" : "durable",
        payload: payloads[kind],
      });
      await storeFixture.database.insertInto("requests").values(requestInsert(request)).execute();
      const read = await s.readRequest(s.caller, request.id);
      expect(read).not.toHaveProperty("request.presentation");
      await expect(
        s.respond(s.caller, requestRevision(request), request.id),
        kind,
      ).rejects.toMatchObject({ code: "forbidden" });
    }
  });

  it("refuses self answers and stale revisions", async ({ storeFixture }) => {
    const s = await questionTask(storeFixture, "question-stale-self");
    const thread = (await storeFixture.store.getThreadForOwner(s.task.threadId, s.f.userId))!;
    const worker: RunCaller = {
      ...s.caller,
      thread,
      key: `run:${s.task.runId}`,
      claims: {
        ...s.caller.claims,
        runId: s.task.runId!,
        threadId: s.task.threadId,
        bindingGeneration: s.binding.bindingGeneration,
      },
    };
    await expect(s.respond(worker)).rejects.toMatchObject({ code: "forbidden" });
    await storeFixture.database
      .updateTable("requests")
      .set({
        presentation: sql`${JSON.stringify({ ...s.request.presentation, title: "Updated export question" })}::jsonb`,
      })
      .where("id", "=", s.request.id)
      .execute();
    await expect(s.respond(s.caller, requestRevision(s.request))).rejects.toMatchObject({
      code: "conflict",
    });
    expect((await storeFixture.store.requests.get(s.request.id))?.status).toBe("pending");
  });

  it("delivers an accepted answer after the answering Run has ended", async ({ storeFixture }) => {
    const s = await questionTask(storeFixture, "question-answerer-ended");
    await s.respond();
    await storeFixture.store.commitRunnerEvent({
      environmentId: s.f.environmentId,
      runnerBootId: s.f.runnerBootId,
      runnerId: s.f.runnerId,
      event: pendingEvent({
        environmentId: s.f.environmentId,
        runId: s.f.run.id,
        threadId: s.f.thread.id,
        bindingGeneration: s.f.bindingGeneration,
        ordinal: 1,
        type: "run.completed",
        data: { status: "completed" },
      }),
    });
    const { received } = await s.dispatch();
    expect(received).toEqual({ kind: "form", answers: { format: ["CSV"] } });
    expect(await storeFixture.store.requests.get(s.request.id)).toMatchObject({
      status: "fulfilled",
      settlementProvenance: { kind: "agent", runId: s.f.run.id },
    });
  });

  it("lets exactly one answer win when a person and an agent race", async ({ storeFixture }) => {
    const s = await questionTask(storeFixture, "question-answer-race");
    const response = { kind: "form" as const, answers: { format: ["JSON"] } };
    const sealedResponse = await sealRequestResponse(s.vault, response, {
      requestId: s.request.id,
      runId: s.task.runId!,
      threadId: s.task.threadId,
    });
    const results = await Promise.allSettled([
      s.respond(),
      s.commands.sendControl({
        type: "request.respond",
        requestId: s.request.id,
        runId: s.task.runId!,
        threadId: s.task.threadId,
        requestedBy: s.f.userId,
        idempotencyKey: randomUUID(),
        response,
        sealedResponse,
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const { received } = await s.dispatch();
    expect(["CSV", "JSON"]).toContain(
      received?.kind === "form" ? received.answers.format?.[0] : null,
    );
    expect((await storeFixture.store.requests.get(s.request.id))?.status).toBe("fulfilled");
  });

  it("queues one Host-authored notice and cancels it if the question settles before it is taken", async ({
    storeFixture,
  }) => {
    const s = await questionTask(storeFixture, "question-notice");
    const notices = await Promise.all([
      deliverTaskQuestionNotice(storeFixture.database, s.request.id, () => false),
      deliverTaskQuestionNotice(storeFixture.database, s.request.id, () => false),
    ]);
    expect(notices.flat().filter((event) => event.type === "message.created")).toHaveLength(1);
    const row = await storeFixture.database
      .selectFrom("taskQuestionNotices")
      .innerJoin("messages", "messages.id", "taskQuestionNotices.messageId")
      .selectAll("messages")
      .where("requestId", "=", s.request.id)
      .executeTakeFirstOrThrow();
    expect(row.author).toMatchObject({ kind: "platform", cause: "task-question" });
    expect(JSON.stringify(row.content)).toContain("pending_request");
    await s.respond();
    await s.dispatch();
    await cancelSettledTaskQuestionNotice(storeFixture.database, s.request.id);
    expect(
      await storeFixture.database
        .selectFrom("threadInputs")
        .select("state")
        .where("messageId", "=", row.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "cancelled" });
    expect(
      await deliverTaskQuestionNotice(storeFixture.database, s.request.id, () => false),
    ).toEqual([]);
  });

  it("delivers a waiting parent's question through thread_wait without a second notice", async ({
    storeFixture,
  }) => {
    let waiting: ReturnType<Awaited<ReturnType<typeof waitingTask>>["wait"]> | undefined;
    const s = await questionTask(storeFixture, "question-notice-wait", async (task) => {
      waiting = task.wait();
      await vi.waitFor(() => expect(task.checkLive).toHaveBeenCalledTimes(2), { timeout: 1000 });
    });
    s.questionNotices.observe(s.opened.event);
    s.realtime.publish(s.opened.event);
    expect(await waiting).toMatchObject({ pendingRequest: { id: s.request.id } });
    await s.questionNotices.close();
    expect(
      await storeFixture.database
        .selectFrom("taskQuestionNotices")
        .selectAll()
        .where("requestId", "=", s.request.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ requestId: s.request.id, messageId: null });
    expect(
      await deliverTaskQuestionNotice(storeFixture.database, s.request.id, () => false),
    ).toEqual([]);
  });

  it("creates no parent notice for a program task", async ({ storeFixture }) => {
    const s = await questionTask(storeFixture, "question-notice-program");
    const occurrence = await storeFixture.startTriggerOccurrence(s.f, "question-notice-program");
    await storeFixture.database
      .updateTable("delegations")
      .set({ origin: "trigger", parentRunId: null, parentOccurrenceId: occurrence.id })
      .where("id", "=", s.assignmentId)
      .execute();
    expect(
      await deliverTaskQuestionNotice(storeFixture.database, s.request.id, () => false),
    ).toEqual([]);
    expect(
      await storeFixture.database.selectFrom("taskQuestionNotices").selectAll().execute(),
    ).toEqual([]);
  });

  it("keeps the notice when a wait ends without delivering the question", async ({
    storeFixture,
  }) => {
    const s = await questionTask(storeFixture, "question-notice-timeout");
    const finish = s.questionNotices.wait(s.f.thread.id, s.task.threadId);
    s.questionNotices.observe(s.opened.event);
    finish();
    await s.questionNotices.close();
    expect(
      await storeFixture.database
        .selectFrom("taskQuestionNotices")
        .select("messageId")
        .where("requestId", "=", s.request.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ messageId: expect.any(String) });
  });

  it("keeps a native subagent's question with the person", async ({ storeFixture }) => {
    const s = await questionTask(storeFixture, "question-native");
    const nodeId = createId("executionNode");
    const base = {
      environmentId: s.f.environmentId,
      runId: s.task.runId!,
      threadId: s.task.threadId,
      bindingGeneration: s.binding.bindingGeneration,
    };
    await storeFixture.store.commitRunnerEvent({
      environmentId: s.f.environmentId,
      runnerBootId: s.f.runnerBootId,
      runnerId: s.f.runnerId,
      event: pendingEvent({
        ...base,
        ordinal: 2,
        type: "node.started",
        data: {
          nodeId,
          kind: "subagent",
          nativeRef: "native-question",
          title: "Native helper",
          model: null,
          originCallId: null,
          parentNodeId: null,
          prompt: null,
          sessionRef: null,
        },
      }),
    });
    const request = PendingRequestSchema.parse({
      ...s.request,
      id: createId("request"),
      callId: randomUUID(),
      originatingNodeId: nodeId,
    });
    await storeFixture.store.commitRunnerEvent({
      environmentId: s.f.environmentId,
      runnerBootId: s.f.runnerBootId,
      runnerId: s.f.runnerId,
      event: pendingEvent({ ...base, ordinal: 3, type: "request.opened", data: { request } }),
    });
    expect(await deliverTaskQuestionNotice(storeFixture.database, request.id, () => false)).toEqual(
      [],
    );
    await expect(s.respond(s.caller, requestRevision(request), request.id)).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("cancels a queued notice Run when the question is withdrawn before dispatch", async ({
    storeFixture,
  }) => {
    const s = await questionTask(storeFixture, "question-notice-queued");
    await storeFixture.store.commitRunnerEvent({
      environmentId: s.f.environmentId,
      runnerBootId: s.f.runnerBootId,
      runnerId: s.f.runnerId,
      event: pendingEvent({
        environmentId: s.f.environmentId,
        runId: s.f.run.id,
        threadId: s.f.thread.id,
        bindingGeneration: s.f.bindingGeneration,
        ordinal: 1,
        type: "run.completed",
        data: { status: "completed" },
      }),
    });
    await deliverTaskQuestionNotice(storeFixture.database, s.request.id, () => false);
    const notice = await storeFixture.database
      .selectFrom("taskQuestionNotices")
      .select("messageId")
      .where("requestId", "=", s.request.id)
      .executeTakeFirstOrThrow();
    const queued = await storeFixture.database
      .selectFrom("runs")
      .select(["id", "status"])
      .where("seedInputId", "=", notice.messageId)
      .executeTakeFirstOrThrow();
    expect(queued.status).toBe("queued");
    await storeFixture.store.requests.cancelForRun(s.task.runId!, "source-closed");
    await cancelSettledTaskQuestionNotice(storeFixture.database, s.request.id);
    expect(
      await storeFixture.database
        .selectFrom("runs")
        .select("status")
        .where("id", "=", queued.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "interrupted" });
    expect(
      await storeFixture.database
        .selectFrom("threadInputs")
        .select("state")
        .where("messageId", "=", notice.messageId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "cancelled" });
  });
});
async function place(
  storeFixture: StoreFixture,
  f: Fixture,
  value: PlaceIdentity,
  title = "Place",
) {
  return withDatabaseTransaction(storeFixture.database, (tx) =>
    appendHostDeploymentEvent(tx, {
      type: "place.entered",
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
    threadId: f.thread.id,
    runId: f.run.id,
    environmentId: f.environmentId,
  };
  const started = await withDatabaseTransaction(storeFixture.database, (tx) =>
    appendHostDeploymentEvent(tx, {
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
    appendHostDeploymentEvent(tx, {
      ...base,
      type: "tool.completed",
      data: { callId, isError: false, output: { text: "output-secret ".repeat(100) } },
    }),
  );
  return { started, completed };
}

describeStore("shaped agent Thread tools", (it) => {
  it("reads only a reachable subagent's paged, clipped items and fences its Stop to the current attempt", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("node-read-stop");
    const s = setup(storeFixture, f);
    const nodeId = createId("executionNode");
    let ordinal = 1;
    const emit = (event: Pick<PendingAgentEvent, "type" | "data">) =>
      storeFixture.store.commitRunnerEvent({
        environmentId: f.environmentId,
        runnerId: f.runnerId,
        runnerBootId: f.runnerBootId,
        event: pendingEvent({
          ...event,
          bindingGeneration: f.bindingGeneration,
          environmentId: f.environmentId,
          runId: f.run.id,
          threadId: f.thread.id,
          ordinal: ordinal++,
        }),
      });
    await emit({
      type: "node.started",
      data: {
        nodeId,
        kind: "subagent",
        stopSupported: true,
        model: "child-model",
        nativeRef: "child-task",
        sessionRef: null,
        originCallId: null,
        parentNodeId: null,
        title: "Inspect parser",
        prompt: "Find the parser",
      },
    });
    await emit({ type: "node.message", data: { nodeId, text: "Child reply 😀" } });
    await emit({
      type: "reasoning.completed",
      data: { nodeId, blockId: "thinking", text: "PRIVATE_REASONING" },
    });
    await emit({
      type: "tool.started",
      data: {
        nodeId,
        callId: "child-tool",
        tool: { name: "Read", namespace: "engine" },
        arguments: { path: "parser.ts" },
      },
    });
    const output = "😀".repeat(700);
    await emit({
      type: "tool.completed",
      data: { nodeId, callId: "child-tool", isError: false, output: { text: output } },
    });
    await emit({
      type: "tool.started",
      data: {
        nodeId,
        callId: "sensitive",
        tool: { name: "computer", namespace: "opensteer" },
        arguments: { secret: "NEVER_RETURN" },
      },
    });
    await emit({
      type: "tool.completed",
      data: { nodeId, callId: "sensitive", isError: false, output: { text: "NEVER_RETURN" } },
    });
    const read = (extra: Record<string, unknown> = {}, caller: AgentCaller = s.caller) =>
      s.product.thread_read({
        caller,
        input: thread_read.input.parse({
          subagentId: nodeId,
          view: "activity",
          limit: 2,
          ...extra,
        }),
        operationKey: randomUUID(),
      });
    const page = await read();
    expect(ThreadReadOutputSchema.parse(page).subagent).toMatchObject({
      id: nodeId,
      title: "Inspect parser",
      model: "child-model",
      prompt: "Find the parser",
      status: "running",
      stopSupported: true,
      stopping: false,
    });
    expect(page.items.map((item) => item.text)).toEqual([null, null]);
    expect(JSON.stringify(page)).not.toContain("NEVER_RETURN");
    const older = await read({ before: page.nextBefore });
    expect(older.items[0]).toMatchObject({
      type: "tool.completed",
      text: "😀".repeat(500),
      textTruncated: true,
      nextTextOffset: 500,
    });
    const full = await read({ itemId: older.items[0]!.itemId, textOffset: 500 });
    expect(full.items[0]).toMatchObject({ text: "😀".repeat(200), textTruncated: false });
    const oldest = await read({ before: older.nextBefore });
    expect(oldest.items).toHaveLength(1);
    expect(oldest.items[0]).toMatchObject({ type: "node.message", text: "Child reply 😀" });
    expect(oldest.hasMore).toBe(false);
    const outside: AgentCaller = {
      ...s.caller,
      userId: createId("user"),
    };
    const refusal = await read({}, outside).catch((error: unknown) => error);
    const missing = await read({ subagentId: createId("executionNode") }).catch(
      (error: unknown) => error,
    );
    expect(refusal).toMatchObject({
      code: "forbidden",
      message: "The personal owner is required.",
    });
    expect(missing).toMatchObject({ code: "forbidden", message: "Subagent is unavailable" });
    await expect(
      s.product.task_cancel({
        caller: { ...s.caller, claims: { ...s.caller.claims, runId: createId("run") } },
        input: task_cancel.input.parse({ subagentId: nodeId }),
        operationKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await storeFixture.database
      .updateTable("executionNodes")
      .set({ stopSupported: false })
      .where("id", "=", nodeId)
      .execute();
    await expect(
      s.product.task_cancel({
        caller: s.caller,
        input: task_cancel.input.parse({ subagentId: nodeId }),
        operationKey: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "This engine cannot stop this subagent separately",
    });
    await storeFixture.database
      .updateTable("executionNodes")
      .set({ stopSupported: true })
      .where("id", "=", nodeId)
      .execute();
    const result = await s.product.task_cancel({
      caller: s.caller,
      input: task_cancel.input.parse({ subagentId: nodeId }),
      operationKey: randomUUID(),
    });
    expect(result).toEqual({ subagentId: nodeId, status: "stopping" });
    expect(ThreadReadOutputSchema.parse(await read()).subagent).toMatchObject({
      stopSupported: true,
      stopping: true,
    });
    const node = await storeFixture.database
      .selectFrom("executionNodes")
      .selectAll()
      .where("id", "=", nodeId)
      .executeTakeFirstOrThrow();
    await storeFixture.database
      .updateTable("runAttempts")
      .set({
        status: "superseded",
        supersededAt: new Date(),
        outcome: "interrupted",
        endedAt: new Date(),
      })
      .where("id", "=", node.attemptId)
      .execute();
    await expect(
      s.product.task_cancel({
        caller: s.caller,
        input: task_cancel.input.parse({ subagentId: nodeId }),
        operationKey: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "Subagent is no longer running in the current attempt",
    });
    const command = await storeFixture.database
      .selectFrom("commands")
      .selectAll()
      .where("runId", "=", f.run.id)
      .where("type", "=", "node.stop")
      .executeTakeFirstOrThrow();
    expect(command.authoritySource).toMatchObject({ kind: "run", runId: f.run.id });
    const send = vi.fn(async () => undefined);
    await expect(
      dispatchNodeStop(
        storeFixture.database,
        {
          nodeId,
          runId: f.run.id,
          threadId: f.thread.id,
          requestedBy: f.userId,
          idempotencyKey: command.idempotencyKey,
        },
        f.bindingGeneration,
        command.id,
        send,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(send).not.toHaveBeenCalled();
    expect(
      (
        await storeFixture.database
          .selectFrom("runs")
          .select("status")
          .where("id", "=", f.run.id)
          .executeTakeFirst()
      )?.status,
    ).toBe("running");
  });

  it("keeps the personal owner's subagent stop through a Host restart and a retry", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("node-stop-kept");
    const nodeId = createId("executionNode");
    let ordinal = 1;
    const emit = (event: Pick<PendingAgentEvent, "type" | "data">) =>
      storeFixture.store.commitRunnerEvent({
        environmentId: f.environmentId,
        runnerId: f.runnerId,
        runnerBootId: f.runnerBootId,
        event: pendingEvent({
          ...event,
          bindingGeneration: f.bindingGeneration,
          environmentId: f.environmentId,
          runId: f.run.id,
          threadId: f.thread.id,
          ordinal: ordinal++,
        }),
      });
    await emit({
      type: "node.started",
      data: {
        nodeId,
        kind: "subagent",
        stopSupported: true,
        model: null,
        nativeRef: "child-task",
        sessionRef: null,
        originCallId: null,
        parentNodeId: null,
        title: "Inspect parser",
        prompt: null,
      },
    });
    const owner = f.userId;
    const stop = () =>
      storeFixture.store.stopNode({
        nodeId,
        runId: f.run.id,
        threadId: f.thread.id,
        requestedBy: owner,
        idempotencyKey: "owner-stops-child",
      });
    const first = await stop();
    expect(first.wasDuplicate).toBe(false);
    const status = async () =>
      (
        await storeFixture.database
          .selectFrom("commands")
          .select("status")
          .where("id", "=", first.command.id)
          .executeTakeFirstOrThrow()
      ).status;
    await storeFixture.store.claimCommand(first.command.id, "host-before-restart");
    expect(await status()).toBe("dispatched");
    await storeFixture.store.recoverCommandsAfterHostRestart();
    expect(await status()).toBe("pending");
    await emit({
      type: "node.completed",
      data: { nodeId, status: "interrupted", result: null, usage: null },
    });
    expect(await stop()).toMatchObject({ wasDuplicate: true, command: { id: first.command.id } });
  });

  it("waits in a Run, reads the result and withdraws its unclaimed automatic return", async ({
    storeFixture,
  }) => {
    const s = await waitingTask(storeFixture, "wait-result");
    const pending = s.wait();
    await vi.waitFor(() => expect(s.checkLive).toHaveBeenCalledTimes(2), { timeout: 1000 });
    await s.settle();
    await storeFixture.store.drainAssignmentReturn(s.assignmentId);
    const queuedWhileWaiting = await s.returns();
    await s.wake();
    expect(await pending).toMatchObject({
      status: "settled",
      task: { result: "42", status: "completed" },
    });
    expect(queuedWhileWaiting).toEqual([]);
    expect(await s.returns()).toEqual([]);
    expect(await storeFixture.store.drainAssignmentReturn(s.assignmentId)).toEqual([]);
  });

  it("hands the result once to a Run that waits on its own task's conversation", async ({
    storeFixture,
  }) => {
    const s = await waitingTask(storeFixture, "wait-own-thread");
    const pending = s.product.thread_wait({
      caller: s.caller,
      input: thread_wait.input.parse({ threadId: s.task.threadId, timeoutMs: 2_000 }),
      operationKey: randomUUID(),
      checkLive: s.checkLive,
    });
    await vi.waitFor(() => expect(s.checkLive).toHaveBeenCalledTimes(2), { timeout: 1000 });
    await s.settle();
    await storeFixture.store.drainAssignmentReturn(s.assignmentId);
    await s.wake();
    expect(await pending).toMatchObject({
      status: "settled",
      task: { result: "42", status: "completed" },
    });
    expect(await s.returns()).toEqual([]);
    expect(await storeFixture.store.drainAssignmentReturn(s.assignmentId)).toEqual([]);
  });

  it("holds its task's return while a Run watches that task's messages", async ({
    storeFixture,
  }) => {
    const s = await waitingTask(storeFixture, "wait-own-messages");
    await s.startWorker();
    const seed = await storeFixture.database
      .selectFrom("messages")
      .select("id")
      .where("threadId", "=", s.task.threadId)
      .orderBy("createdAt", "asc")
      .executeTakeFirstOrThrow();
    const pending = s.product.thread_wait({
      caller: s.caller,
      input: thread_wait.input.parse({
        threadId: s.task.threadId,
        afterMessageId: seed.id,
        timeoutMs: 2_000,
      }),
      operationKey: randomUUID(),
      checkLive: s.checkLive,
    });
    await vi.waitFor(() => expect(s.checkLive).toHaveBeenCalledTimes(2), { timeout: 1000 });
    await s.settle();
    await storeFixture.store.drainAssignmentReturn(s.assignmentId);
    // Nothing is queued for the assigner while its own wait can still hand it the result.
    expect(await s.returns()).toEqual([]);
    await s.wake();
    await pending;
  });

  it("leaves automatic return intact after a timeout and reports an empty settled result", async ({
    storeFixture,
  }) => {
    const s = await waitingTask(storeFixture, "wait-timeout");
    expect(await s.wait(1)).toMatchObject({ status: "timed_out" });
    await s.settle();
    await storeFixture.store.drainAssignmentReturn(s.assignmentId);
    expect(await s.returns()).toHaveLength(1);
  });

  for (const ending of ["timeout", "abort"] as const) {
    it(`releases a held settled result once when its live wait ends by ${ending}`, async ({
      storeFixture,
    }) => {
      const s = await waitingTask(storeFixture, `wait-held-${ending}`);
      const abort = new AbortController();
      const pending = withDatabaseOperationSignal(abort.signal, Date.now() + 10_000, () =>
        s.wait(2_000, s.caller, abort.signal),
      );
      const outcome = pending.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await vi.waitFor(() => expect(s.checkLive).toHaveBeenCalledTimes(2), { timeout: 1000 });
      await s.settle();
      await storeFixture.store.drainAssignmentReturn(s.assignmentId);
      const during = await s.returns();
      if (ending === "abort") abort.abort(new Error("Tool call cut off"));
      const result = await outcome;
      if (ending === "abort")
        expect(result).toMatchObject({ error: new Error("Tool call cut off") });
      else expect(result).toMatchObject({ value: { status: "timed_out" } });
      expect(during).toEqual([]);
      await storeFixture.store.drainPendingAssignmentReturns();
      expect(await s.returns()).toHaveLength(1);
    });
  }

  it("returns an empty result after automatic silent settlement", async ({ storeFixture }) => {
    const s = await waitingTask(storeFixture, "wait-empty");
    await s.settle("");
    await storeFixture.store.drainAssignmentReturn(s.assignmentId);
    expect(await s.wait()).toMatchObject({ status: "settled", task: { result: "" } });
    expect(await s.returns()).toEqual([]);
  });

  it("serializes a result read racing automatic return so only one delivery remains", async ({
    storeFixture,
  }) => {
    const s = await waitingTask(storeFixture, "wait-race");
    await s.settle();
    const [read] = await Promise.all([
      s.status(),
      storeFixture.store.drainAssignmentReturn(s.assignmentId),
    ]);
    expect(read.result).toBe("42");
    expect(await s.returns()).toEqual([]);
    const row = await storeFixture.database
      .selectFrom("delegations")
      .select(["resultStatus", "resultReason"])
      .where("id", "=", s.assignmentId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ resultStatus: "delivered", resultReason: "read-by-assigner" });
  });

  it("does not consume a result for another caller", async ({ storeFixture }) => {
    const s = await waitingTask(storeFixture, "wait-other-reader");
    const connections = new AgentConnectionStore(storeFixture.database);
    const connection = await connections.create({
      userId: s.f.userId,
      label: "Reader",
      clientName: "Reader",
      resource: "https://host.test/mcp",
      accessMode: "full-access",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await connections.activate(connection.id, "1".repeat(64));
    await s.settle();
    expect(
      (
        await s.status({
          kind: "connection",
          key: `connection:${connection.id}`,
          connectionId: connection.id,
          userId: s.f.userId,
          accessMode: "full-access",
        })
      ).result,
    ).toBe("42");
    await storeFixture.store.drainAssignmentReturn(s.assignmentId);
    expect(await s.returns()).toHaveLength(1);
  });

  it("refuses self and ancestor waits", async ({ storeFixture }) => {
    const s = await waitingTask(storeFixture, "wait-ancestry");
    const wait = (threadId: Fixture["thread"]["id"], caller = s.caller) =>
      s.product.thread_wait({
        caller,
        input: thread_wait.input.parse({ threadId, timeoutMs: 1 }),
        operationKey: randomUUID(),
      });
    await expect(wait(s.f.thread.id)).rejects.toThrow("Cannot wait on yourself");
    const child = (await storeFixture.store.getThreadForOwner(s.task.threadId, s.f.userId))!;
    await expect(wait(s.f.thread.id, { ...s.caller, thread: child })).rejects.toThrow(
      "conversation you are working for",
    );
  });

  it("ends a wait without its result after authority is revoked", async ({ storeFixture }) => {
    const s = await waitingTask(storeFixture, "wait-authority");
    const pending = s.wait();
    const rejected = expect(pending).rejects.toThrow("Run tool authority has ended");
    await vi.waitFor(() => expect(s.checkLive).toHaveBeenCalledTimes(2), { timeout: 1000 });
    await storeFixture.database
      .updateTable("grants")
      .set({ status: "revoked", revokedAt: new Date(), revokedReason: "stopped" })
      .where("runId", "=", s.f.run.id)
      .execute();
    await s.settle();
    await s.wake();
    await rejected;
    await storeFixture.store.drainAssignmentReturn(s.assignmentId);
    expect(await s.returns()).toHaveLength(1);
  });

  it("uses the same waiter for delegate_task wait mode", async ({ storeFixture }) => {
    const s = await waitingTask(storeFixture, "delegate-wait");
    const input = delegate_task.input.parse({
      task: "Another answer",
      mode: "wait",
      timeoutMs: 2_000,
    });
    const pending = s.product.delegate_task({
      caller: s.caller,
      input,
      operationKey: randomUUID(),
    });
    let assignmentId: typeof s.assignmentId | undefined;
    await vi.waitFor(
      async () => {
        const row = await storeFixture.database
          .selectFrom("delegations")
          .selectAll()
          .where("parentRunId", "=", s.f.run.id)
          .where("id", "!=", s.assignmentId)
          .executeTakeFirst();
        expect(row, "wait-mode delegation never created its Assignment").toBeDefined();
        assignmentId = row!.id;
      },
      { timeout: 1000 },
    );
    const row = await storeFixture.database
      .selectFrom("delegations")
      .select(["childRunId", "childThreadId"])
      .where("id", "=", assignmentId!)
      .executeTakeFirstOrThrow();
    const { terminal } = await storeFixture.runDelegatedTurn(
      s.f,
      { id: row.childRunId, threadId: row.childThreadId },
      {
        replies: ["84"],
        end: "completed",
        suffix: "delegate-wait-mode",
      },
    );
    for (const event of terminal.compensatingEvents) s.realtime.publish(event);
    expect(await pending).toMatchObject({
      result: "84",
      status: "completed",
      wait: { status: "settled" },
    });
    expect(await storeFixture.store.drainAssignmentReturn(assignmentId!)).toEqual([]);
  });

  it("returns a task's Request promptly and reads it without exposing its payload", async ({
    storeFixture,
  }) => {
    const s = await waitingTask(storeFixture, "wait-request");
    await s.startWorker();
    const pending = s.wait();
    await vi.waitFor(() => expect(s.checkLive).toHaveBeenCalledTimes(2), { timeout: 1000 });
    const created = await storeFixture.store.requests.create({
      callId: "child-browser",
      kind: "browser.access",
      mode: "durable",
      originatingRunId: s.task.runId!,
      originatingThreadId: s.task.threadId,
      requestedBy: s.f.userId,
      requiredActor: "requester",
      payload: {
        kind: "browser.access",
        reason: "Choose a browser",
        suggestion: { kind: "user_choice" },
      },
      presentation: {
        kind: "external",
        title: "Browser access",
        subject: { kind: "thread", id: s.f.thread.id },
      },
    });
    for (const event of created.events) s.realtime.publish(event);
    expect(await pending).toMatchObject({
      status: "running",
      pendingRequest: { id: created.request.id },
    });
    const read = await s.product.pending_request({
      caller: s.caller,
      input: pending_request.input.parse({ action: "read", requestId: created.request.id }),
      operationKey: randomUUID(),
    });
    expect(read).toMatchObject({
      request: { id: created.request.id, status: "pending", title: "Browser access" },
    });
    expect(read).not.toHaveProperty("request.payload");
    await expect(
      s.product.pending_request({
        caller: s.caller,
        input: pending_request.input.parse({ action: "read", requestId: createId("request") }),
        operationKey: randomUUID(),
      }),
    ).rejects.toThrow("Request is unavailable");
  });

  it("discovers enforced budgets separately from computer tools", async ({ storeFixture }) => {
    const s = await waitingTask(storeFixture, "orchestration-limits");
    const run = await storeFixture.database
      .selectFrom("runs")
      .select("causalChainId")
      .where("id", "=", s.f.run.id)
      .executeTakeFirstOrThrow();
    await storeFixture.database
      .updateTable("causalChains")
      .set({ maxDelegations: 7, usedDelegations: 2, maxAutonomousRuns: 12, usedAutonomousRuns: 4 })
      .where("id", "=", run.causalChainId)
      .execute();
    const result = await s.product.orchestrator_capabilities({
      caller: s.caller,
      input: orchestrator_capabilities.input.parse({}),
      operationKey: randomUUID(),
    });
    expect(result).toMatchObject({
      accessCeiling: s.caller.accessMode,
      limits: {
        maxTasks: 7,
        remainingTasks: 5,
        maxAutonomousRuns: 12,
        remainingAutonomousRuns: 8,
        maxWaitMs: 100_000,
      },
    });
    const computers = await s.product.environment_list({
      caller: s.caller,
      input: {},
      operationKey: randomUUID(),
    });
    expect(computers.environments).toHaveLength(1);
    expect(computers).not.toHaveProperty("harnesses");
  });
  it("lists personal recent places and refuses another person", async ({ storeFixture }) => {
    const f = await storeFixture.startRunFixture("shaped-places");
    const nativeRunner = f.runnerId;
    const reader = await storeFixture.store.createUser("Other person");
    const s = setup(storeFixture, f);
    const sessionId = createBrowserSessionId();
    await storeFixture.store.createBrowserSession({
      id: sessionId,
      runnerId: f.runnerId,
      origin: "agent",
      ownerId: f.userId,
      placementKey: "shared",
      profileId: null,
      runtimeId: "test",
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
    await expect(s.read({ view: "activity" }, actor)).rejects.toMatchObject({ code: "forbidden" });
    const part = {
      type: "computer-app",
      machineId: createId("runner"),
      app: { bundleId: "com.apple.Notes", teamId: null, displayName: "Notes" },
      name: "Private Notes",
    };
    await storeFixture.database
      .updateTable("messages")
      .set({ content: sql`${JSON.stringify([{ type: "text", text: "Look" }, part])}::jsonb` })
      .where("threadId", "=", f.thread.id)
      .execute();
    const [seen] = (await s.read({})).items;
    expect(seen).toMatchObject({ text: "Look\n[Place unavailable]" });
    expect(seen!.places).toBeUndefined();
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
      origin: "agent",
      ownerId: f.userId,
      placementKey: "bounds",
      profileId: null,
      runtimeId: "test",
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
    await storeFixture.database
      .deleteFrom("deploymentEvents")
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
    await storeFixture.database
      .updateTable("threads")
      .set({ accessMode: "full-access" })
      .where("id", "=", f.thread.id)
      .execute();
    const lower = { ...s.caller, accessMode: "approval-required" as const };
    const listing = thread_queue.input.parse({ action: "list" });
    expect(thread_queue.readsOnly?.(listing)).toBe(true);
    expect(
      await s.product.thread_queue({ caller: lower, input: listing, operationKey: randomUUID() }),
    ).toEqual({ paused: false, items: [] });
    await expect(
      s.product.thread_queue({
        caller: lower,
        input: thread_queue.input.parse({ action: "resume" }),
        operationKey: randomUUID(),
      }),
    ).rejects.toThrow("stronger access mode");
    await storeFixture.database
      .updateTable("threads")
      .set({ accessMode: f.thread.accessMode })
      .where("id", "=", f.thread.id)
      .execute();
    expect((await s.read({ threadId: "self" })).thread.id).toBe(f.thread.id);
    await s.product.delegate_task({
      caller: s.caller,
      input: delegate_task.input.parse({
        harnessInstanceId: f.harnessInstance.id,
        model: { ...testModelSelection, options: {} },
        task: "Work here",
      }),
      operationKey: randomUUID(),
    });
    const connection: AgentCaller = {
      kind: "connection",
      key: "connection:test",
      connectionId: "test",
      userId: f.userId,
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

  it("returns one task shape on delegation and replay, full results, and open/latest assignments across personal tasks", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("shaped-tasks");
    const s = setup(storeFixture, f);
    const input = delegate_task.input.parse({
      harnessInstanceId: f.harnessInstance.id,
      model: { ...testModelSelection, options: {} },
      title: "Worker",
      task: "Do the work",
    });
    const operationKey = randomUUID();
    const delegated = await s.product.delegate_task({ caller: s.caller, input, operationKey });
    expect(delegated).toMatchObject({
      assignmentId: expect.any(String),
      status: "open",
      threadId: expect.any(String),
      parentThreadId: f.thread.id,
    });
    expect(await s.product.delegate_task({ caller: s.caller, input, operationKey })).toEqual(
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
      ownerId: f.userId,
      placementKey: "cross-guest",
      profileId: null,
      runtimeId: "test",
    });
    await new PersonalTabStore(storeFixture.database).recordChanges(
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
    const next = await s.product.delegate_task({
      caller: s.caller,
      input: delegate_task.input.parse({ threadId: delegated.threadId, task: "Continue" }),
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
    const connections = new AgentConnectionStore(storeFixture.database);
    const record = await connections.create({
      userId: f.userId,
      label: "Reader",
      clientName: "Reader",
      resource: "https://host.test/mcp",
      accessMode: "approval-required",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await connections.activate(record.id, "2".repeat(64));
    const connection: AgentCaller = {
      kind: "connection",
      key: `connection:${record.id}`,
      connectionId: record.id,
      userId: f.userId,
      accessMode: "approval-required",
    };
    const status = await s.product.task_status({
      caller: connection,
      input: task_status.input.parse({ assignmentId: next.assignmentId }),
      operationKey: randomUUID(),
    });
    expect(status.result).toBe(result);
    expect((await list()).threads.find((t) => t.id === delegated.threadId)).toMatchObject({
      assignmentId: next.assignmentId,
      taskStatus: "completed",
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
    const nativeRunner = f.runnerId;
    const delegated = await storeFixture.store.delegateThread({
      createdBy: f.userId,
      environmentId: f.environmentId,
      harnessInstanceId: f.harnessInstance.id,
      modelSelection: testModelSelection,
      origin: { kind: "run", parentRunId: f.run.id, parentThreadId: f.thread.id },
      task: [{ type: "text", text: "Task" }],
      title: "Task",
      accessMode: "full-access",
      idempotencyKey: "show-task",
    });
    const target = { ...f, run: delegated.run, thread: delegated.thread };
    await expect(s.show({ runId: delegated.run.id })).rejects.toMatchObject({
      next: "Read recentPlaces with thread_read.",
    });
    const sessionId = createBrowserSessionId();
    const tabId = BrowserSurfaceIdSchema.parse("guest-task");
    await storeFixture.store.createBrowserSession({
      id: sessionId,
      runnerId: f.runnerId,
      origin: "agent",
      ownerId: f.userId,
      placementKey: "guest",
      profileId: null,
      runtimeId: "test",
    });
    await new PersonalTabStore(storeFixture.database).recordChanges(
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
    const reader = await storeFixture.store.createUser("Other person");
    await expect(
      s.show(
        { runId: delegated.run.id },
        { ...s.caller, userId: reader, claims: { ...s.caller.claims, requestedBy: reader } },
      ),
    ).rejects.toMatchObject({ code: "forbidden", message: "The personal owner is required." });
  });
});
