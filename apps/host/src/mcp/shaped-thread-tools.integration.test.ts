import { OpensteerMcpService } from "./opensteer-mcp-service.js";
import { ThreadAccessModeSchema } from "@opensteer/core";
import { onTestFinished } from "vitest";
import { DeviceIdSchema } from "@opensteer/core";
import { WindowIdSchema, OpensteerError } from "@opensteer/core";
import { productToolOutput } from "./tool-output.js";
import {
  opensteer_subagent_read,
  opensteer_subagent_stop,
  opensteer_task_resume,
} from "@opensteer/agent-tools/tools";
import { personalBrowserRepository } from "@opensteer/database/test-support/store";
import { personalTestExecution } from "./personal-execution.test-support.js";
import { randomUUID } from "node:crypto";
import { commitPersonalMutation } from "@opensteer/database/personal-mutation";
import { AesGcmSecretVault, StaticEncryptionKeyProvider } from "@opensteer/access/host";
import { expect, vi } from "vitest";
import { sql } from "kysely";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { ownTestDatabaseProducer } from "@opensteer/database/test-support/database";
import {
  createId,
  formatReferenceLink,
  MessageIdSchema,
  BrowserSurfaceIdSchema,
  type RunId,
  type PlaceIdentity,
  RequestKindSchema,
  PendingRequestSchema,
  SequenceSchema,
  type RequestPayload,
  type RequestResponse,
} from "@opensteer/core";
import {
  opensteer_task_read,
  opensteer_task_send,
  opensteer_task_list,
  opensteer_task_configure,
  show_to_person,
  opensteer_task_queue,
  opensteer_task_delegate,
  opensteer_task_update,
  opensteer_task_interrupt,
  opensteer_delegation_wait,
  opensteer_request_list,
  opensteer_request_read,
  opensteer_task_wait,
  opensteer_request_answer,
  opensteer_ai_account_list,
} from "@opensteer/agent-tools/tools";
import { ThreadReadOutputSchema } from "@opensteer/agent-tools/outputs";
import {
  needsYouPage,
  dispatchNodeStop,
  TabStore,
  withDatabaseOperationSignal,
  AgentConnectionStore,
  deliverTaskQuestionNotice,
  cancelSettledTaskQuestionNotice,
  encodeThreadHistoryCursor,
  requestInsert,
  createDatabase,
  OpensteerStore,
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
  type PendingAgentEvent,
  type PersonShowMessage,
} from "@opensteer/protocol";
import { BrowserService } from "../browser/browser-service.js";
import { ThreadService } from "../threads/thread-service.js";
import { ThreadWaitService } from "../threads/thread-wait.js";
import { ProductToolHandlers } from "./handlers/product.js";
import type { AgentCaller, RunCaller } from "./agent-caller.js";
import { TaskQuestionNotices } from "../threads/task-question-notices.js";
import { openRequestResponse, sealRequestResponse } from "../identity/request-response-vault.js";

type Fixture = Awaited<ReturnType<StoreFixture["startRunFixture"]>>;
function setup(storeFixture: StoreFixture, f: Fixture) {
  const { store } = storeFixture;
  const frames: PersonShowMessage[] = [];
  const realtime = new RealtimeHub();
  const detach = storeFixture.observePersonalCommits((head, scopes) => realtime.wake(head, scopes));
  onTestFinished(detach);
  const vault = new AesGcmSecretVault(
    new StaticEncryptionKeyProvider(new Map([[1, Buffer.alloc(32, 7)]]), 1),
  );
  const questionNotices = new TaskQuestionNotices({
    database: store.database,
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
  });
  const browser = new BrowserService({
    deploymentId: f.deploymentId,
    repository: personalBrowserRepository(store),
    signer: {} as never,
    hostOrigin: new URL("https://host.test"),
    onSessionsChanged: () => {},
  });
  const computerUse = {
    sessionsForRunner: vi.fn<
      import("../computer-use/computer-use-service.js").ComputerUseService["sessionsForRunner"]
    >(() => []),
    authorizeDisplay: vi.fn(async () => ({ deviceId: DeviceIdSchema.parse(f.runnerId) })),
  };
  const threads = new ThreadService({
    store,
    commands,
    browser,
    runners: {
      canRunHarness: () => true,
      harnessAccessModes: () => ThreadAccessModeSchema.options,
      isAvailable: () => true,
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
    threads,
    realtime,
    requestResponseVault: vault,
    questionNotices,
    computerUse,
    tabs: {
      get: async (owner, id) => {
        const row = await new TabStore(store.database).get(owner, id);
        if (!row) throw new OpensteerError({ code: "not_found", message: "Tab not found" });
        return {} as import("@opensteer/core").Tab;
      },
      authorizeShow: async (claims, id) => {
        if (!(await new TabStore(store.database).get(claims.requestedBy, id)))
          throw new OpensteerError({ code: "not_found", message: "Tab not found" });
      },
    },
    personShow: async (_userId, frame) => {
      frames.push(frame);
      return 1;
    },
    isEnvironmentConnected: () => true,
    canRunHarness: () => true,
    browserSources: {} as never,
    savedLogins: {} as never,
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
    product.opensteer_task_read({
      caller: actor,
      input: opensteer_task_read.input.parse(input),
      operationKey: randomUUID(),
    });
  const show = (target: unknown, actor: RunCaller = caller) =>
    product.show_to_person({
      caller: actor,
      input: show_to_person.input.parse({ target }),
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
  const task = await s.product.opensteer_task_delegate({
    caller: s.caller,
    input: opensteer_task_delegate.input.parse({ message: "Find the answer" }),
    operationKey: randomUUID(),
  });
  const assignmentId = task.assignmentId!;
  const wake = async () => {
    s.realtime.wake("0", new Set([`thread:${task.threadId}`, `thread:${f.thread.id}`]));
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
    s.product.opensteer_task_wait({
      caller,
      input:
        caller.kind === "connection"
          ? opensteer_task_wait.input.parse({ taskId: task.threadId, timeoutMs })
          : opensteer_delegation_wait.input.parse({ delegationId: assignmentId, timeoutMs }),
      operationKey: randomUUID(),
      checkLive,
      ...(signal ? { signal } : {}),
    });
  const status = (caller: AgentCaller = s.caller) =>
    s.product.opensteer_delegation_status({
      caller,
      input: { delegationId: assignmentId },
      operationKey: randomUUID(),
    });
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
  await storeFixture.store.commitRunnerEvent({
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
  const revision = (await storeFixture.store.requests.revision(request.id))!;
  const opened = storeFixture.reactions.findLast(
    (reaction) => reaction.type === "requestChanged" && reaction.requestId === request.id,
  );
  if (opened?.type !== "requestChanged")
    throw new Error("Opening the Request emitted no current-state reaction");
  const readRequest = (actor: AgentCaller = s.caller, requestId = request.id) =>
    s.product.opensteer_request_answer({
      caller: actor,
      input: { ...opensteer_request_read.input.parse({ requestId }), action: "read", limit: 50 },
      operationKey: randomUUID(),
    });
  const respond = (
    actor: AgentCaller = s.caller,
    expectedRevision = revision,
    requestId = request.id,
  ) =>
    s.product.opensteer_request_answer({
      caller: actor,
      input: {
        ...opensteer_request_answer.input.parse({
          requestId,
          expectedRevision,
          response: { kind: "form", answers: { format: ["CSV"] } },
        }),
        action: "respond",
        limit: 50,
      },
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
    await storeFixture.store.dispatchRequestResponse(command.id, async (beforeAck) => {
      received = await openRequestResponse(s.vault, command.encryptedRequestResponse!, {
        requestId: request.id,
        runId: s.task.runId!,
        threadId: s.task.threadId,
      });
      await beforeAck();
    });
    return { received, command };
  };
  const stored = (await storeFixture.store.requests.get(request.id))!;
  return {
    ...s,
    request: stored,
    opened,
    revision,
    binding,
    readRequest,
    respond: (actor: AgentCaller = s.caller, expectedRevision = revision, requestId = request.id) =>
      respond(actor, expectedRevision, requestId),
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
      request: { presentation: s.request.presentation, revision: s.revision },
    });
    await s.respond();
    const { received, command } = await s.dispatch();
    expect(received).toEqual({ kind: "form", answers: { format: ["CSV"] } });
    expect(command.authoritySource).toMatchObject({ kind: "thread-agent", runId: s.f.run.id });
    expect(
      storeFixture.reactions.filter(
        (reaction) =>
          reaction.type === "requestChanged" &&
          reaction.requestId === s.request.id &&
          reaction.status === "fulfilled",
      ),
    ).toHaveLength(1);
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
      "device.access": {
        kind: "device.access",
        reason,
        machineId: DeviceIdSchema.parse(s.f.runnerId),
        machineName: "Mac",
        access: "files",
      },
      "machine.full-disk-access": {
        kind: "machine.full-disk-access",
        reason,
        machineId: DeviceIdSchema.parse(s.f.runnerId),
        machineName: "Mac",
      },
      "computer.app.access": {
        kind: "computer.app.access",
        reason,
        access: "read",
        app: null,
        definitionId: "android-phone",
        deviceId: DeviceIdSchema.parse(s.f.runnerId),
        setupRequestId: randomUUID(),
      },
      "plugin.account": {
        kind: "plugin.account",
        plugin: "fixture",
        requirement: "service",
        scope: "user",
        consent: { digest: "a".repeat(64), sites: [], credential: "value" },
      },
      "plugin.approval": {
        kind: "plugin.approval",
        executionId: "execution",
        interactionId: "interaction",
      },
      "plugin.input": {
        kind: "plugin.input",
        executionId: "execution",
        interactionId: "interaction",
      },
      "person.question": { kind: "person.question" },
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
        s.respond(s.caller, (await storeFixture.store.requests.revision(request.id))!, request.id),
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
    await commitPersonalMutation(storeFixture.database, (tx, mutation) =>
      tx
        .updateTable("requests")
        .set({
          revision: mutation.sequence,
          presentation: sql`${JSON.stringify({ ...s.request.presentation, title: "Updated export question" })}::jsonb`,
        })
        .where("id", "=", s.request.id)
        .execute(),
    );
    await expect(s.respond(s.caller, s.revision)).rejects.toMatchObject({
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
        expectedRevision: s.revision,
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
    await Promise.all([
      deliverTaskQuestionNotice(storeFixture.database, s.request.id, () => false),
      deliverTaskQuestionNotice(storeFixture.database, s.request.id, () => false),
    ]);
    expect(
      await storeFixture.database
        .selectFrom("taskQuestionNotices")
        .select("messageId")
        .where("requestId", "=", s.request.id)
        .execute(),
    ).toEqual([{ messageId: expect.any(String) }]);
    const row = await storeFixture.database
      .selectFrom("taskQuestionNotices")
      .innerJoin("messages", "messages.id", "taskQuestionNotices.messageId")
      .selectAll("messages")
      .where("requestId", "=", s.request.id)
      .executeTakeFirstOrThrow();
    expect(row.author).toMatchObject({ kind: "platform", cause: "task-question" });
    expect(JSON.stringify(row.content)).toContain("opensteer_request_answer");
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
    await deliverTaskQuestionNotice(storeFixture.database, s.request.id, () => false);
  });

  it("delivers a waiting parent's question through opensteer_task_wait without a second notice", async ({
    storeFixture,
  }) => {
    let waiting: ReturnType<Awaited<ReturnType<typeof waitingTask>>["wait"]> | undefined;
    const s = await questionTask(storeFixture, "question-notice-wait", async (task) => {
      const registered = Promise.withResolvers<void>();
      const wait = task.questionNotices.wait.bind(task.questionNotices);
      vi.spyOn(task.questionNotices, "wait").mockImplementationOnce((...args) => {
        const finish = wait(...args);
        registered.resolve();
        return finish;
      });
      waiting = task.wait();
      await withTimeout(registered.promise, 1_000, {
        timeoutError: () => new Error("The parent wait never registered for question delivery"),
      });
    });
    s.questionNotices.requestChanged(s.opened);
    expect(await waiting).toMatchObject({ pendingRequest: { id: s.request.id } });
    await s.questionNotices.close();
    expect(
      await storeFixture.database
        .selectFrom("taskQuestionNotices")
        .selectAll()
        .where("requestId", "=", s.request.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ requestId: s.request.id, messageId: null });
    await deliverTaskQuestionNotice(storeFixture.database, s.request.id, () => false);
  });

  it("creates no parent notice for a program task", async ({ storeFixture }) => {
    const s = await questionTask(storeFixture, "question-notice-program");
    const occurrence = await storeFixture.startTriggerOccurrence(s.f, "question-notice-program");
    await storeFixture.database
      .updateTable("delegations")
      .set({ origin: "trigger", parentRunId: null, parentOccurrenceId: occurrence.id })
      .where("id", "=", s.assignmentId)
      .execute();
    await deliverTaskQuestionNotice(storeFixture.database, s.request.id, () => false);
    expect(
      await storeFixture.database.selectFrom("taskQuestionNotices").selectAll().execute(),
    ).toEqual([]);
  });

  it("keeps the notice when a wait ends without delivering the question", async ({
    storeFixture,
  }) => {
    const s = await questionTask(storeFixture, "question-notice-timeout");
    const finish = s.questionNotices.wait(s.f.thread.id, s.task.threadId);
    s.questionNotices.requestChanged(s.opened);
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
    await deliverTaskQuestionNotice(storeFixture.database, request.id, () => false);
    await expect(
      s.respond(s.caller, (await storeFixture.store.requests.revision(request.id))!, request.id),
    ).rejects.toMatchObject({
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
  const id =
    value.kind === "browser"
      ? value.surfaceId
      : BrowserSurfaceIdSchema.parse(
          value.kind === "app"
            ? `window:${value.machineId}:${value.appKey}`
            : `phone:${value.machineId}`,
        );
  if (
    value.kind === "browser" &&
    !(await storeFixture.store.getBrowserSessionForOwner(value.sessionId, f.userId))
  )
    await storeFixture.store.createBrowserSession({
      id: value.sessionId,
      ownerId: f.userId,
      runnerId: f.runnerId,
      origin: "agent",
      profileId: null,
      placementKey: "place",
      runtimeId: "test",
    });
  await new TabStore(storeFixture.database).open(
    {
      id,
      ownerId: f.userId,
      computerId:
        value.kind === "browser"
          ? await storeFixture.store.requireSelfDeviceId(f.runnerId)
          : value.machineId,
      kind: value.kind === "browser" ? "page" : value.kind === "app" ? "window" : "phone",
      title,
      openedBy: "person",
      ...(value.kind === "browser"
        ? {
            url: "https://example.com/",
            pageBinding: { lineageId: value.sessionId, sessionId: value.sessionId, surfaceId: id },
          }
        : value.kind === "app"
          ? {
              windowId: WindowIdSchema.parse(`win_${randomUUID()}`),
              windowApp: { bundleId: value.appKey, displayName: title, teamId: null },
            }
          : {}),
    },
    randomUUID(),
  );
  await commitPersonalMutation(storeFixture.database, async (tx, mutation) => {
    const { nextTranscriptPosition: position } = await tx
      .updateTable("threads")
      .set({ nextTranscriptPosition: sql<string>`next_transcript_position + 1` })
      .where("id", "=", f.thread.id)
      .returning("nextTranscriptPosition")
      .executeTakeFirstOrThrow();
    await tx
      .insertInto("transcriptItems")
      .values({
        id: `place:${f.run.id}:${position}`,
        threadId: f.thread.id,
        runId: f.run.id,
        attemptId: null,
        nodeId: null,
        kind: "place",
        position,
        revision: mutation.sequence,
        visible: true,
        isTurnStart: false,
        createdAt: new Date(),
        body: { tabId: id, title, site: null },
        view: { title },
      })
      .execute();
  });
}
async function tool(storeFixture: StoreFixture, f: Fixture, name: string) {
  const callId = randomUUID();
  const base = {
    bindingGeneration: f.bindingGeneration,
    threadId: f.thread.id,
    runId: f.run.id,
    environmentId: f.environmentId,
  };
  const run = await storeFixture.database
    .selectFrom("runs")
    .select("nextRunnerOrdinal")
    .where("id", "=", f.run.id)
    .executeTakeFirstOrThrow();
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
      ordinal: run.nextRunnerOrdinal,
      type: "tool.started",
      data: {
        callId,
        tool: { namespace: "opensteer", name },
        arguments: { secret: "typed-value" },
      },
    }),
  );
  const row = await storeFixture.database
    .selectFrom("toolCalls")
    .select("id")
    .where("runId", "=", f.run.id)
    .where("callId", "=", callId)
    .executeTakeFirstOrThrow();
  return {
    itemId: `tool:${row.id}`,
    complete: () =>
      commit(
        pendingEvent({
          ...base,
          ordinal: run.nextRunnerOrdinal + 1,
          type: "tool.completed",
          data: { callId, isError: false, output: { text: "output-secret ".repeat(100) } },
        }),
      ),
  };
}

describeStore("shaped agent task tools", (it) => {
  for (const ending of ["timeout", "disconnect"] as const) {
    it(`joins a blocked store snapshot and returns its checkout on ${ending}`, async ({
      storeFixture,
    }) => {
      const f = await storeFixture.createRunFixture(`blocked-wait-${ending}`);
      const { database } = await ownTestDatabaseProducer(storeFixture.databaseUrl, async () => {
        const database = createDatabase({
          connectionString: storeFixture.databaseUrl,
          maxConnections: 1,
        });
        return { database, close: () => database.destroy() };
      });
      const store = new OpensteerStore(database);
      const locked = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const blocker = storeFixture.database.transaction().execute(async (tx) => {
        // MVCC reads ignore row locks; an exclusive relation lock blocks the real store's SELECT.
        await sql`lock table threads in access exclusive mode`.execute(tx);
        locked.resolve();
        await withTimeout(release.promise, 3000, {
          timeoutError: () => new Error("Snapshot blocker was not released"),
        });
      });
      void blocker.catch(locked.reject);
      const controller = new AbortController();
      const disconnected = new Error("Disconnected");
      const unsubscribe = vi.fn();
      const reading = Promise.withResolvers<void>();
      const service = new ThreadWaitService({
        subscribe: () => unsubscribe,
        read: ({ signal, expiresAt }) =>
          withDatabaseOperationSignal(signal, expiresAt, async () => {
            reading.resolve();
            await store.getThreadForOwner(f.thread.id, f.userId);
            return { connected: true, messages: [] };
          }),
      });
      let pending: Promise<unknown> | undefined;
      try {
        await withTimeout(locked.promise, 1000, {
          timeoutError: () => new Error("task relation was not locked"),
        });
        pending = service.wait({
          timeoutMs: ending === "timeout" ? 100 : 2000,
          signal: controller.signal,
        });
        const outcome = pending.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        await withTimeout(reading.promise, 1000, {
          timeoutError: () => new Error("Snapshot did not start"),
        });
        if (ending === "disconnect") {
          await vi.waitFor(
            async () => {
              const { rows } = await sql<{
                count: number;
              }>`select count(*)::int as count from pg_stat_activity
              where datname = current_database() and wait_event_type = 'Lock'`.execute(
                storeFixture.database,
              );
              expect(rows[0]?.count, "Snapshot never reached the relation lock").toBe(1);
            },
            { timeout: 500 },
          );
          controller.abort(disconnected);
        }
        const result = await withTimeout(outcome, 1000, {
          timeoutError: () => new Error("task wait did not join its cancelled store read"),
        });
        if (ending === "timeout") expect(result).toMatchObject({ value: { status: "timed_out" } });
        else expect(result).toEqual({ error: disconnected });
        expect(unsubscribe).toHaveBeenCalledOnce();
        expect(
          (
            await withTimeout(sql`select 1 as alive`.execute(database), 500, {
              timeoutError: () => new Error("task wait retained the only checkout"),
            })
          ).rows,
        ).toEqual([{ alive: 1 }]);
      } finally {
        controller.abort(disconnected);
        release.resolve();
        await withTimeout(Promise.all([blocker, pending?.catch(() => undefined)]), 1000, {
          timeoutError: () => new Error("Blocked snapshot did not release its checkout"),
        });
      }
    });
  }
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
        tool: { name: "computer_use", namespace: "opensteer" },
        arguments: { secret: "NEVER_RETURN" },
      },
    });
    await emit({
      type: "tool.completed",
      data: { nodeId, callId: "sensitive", isError: false, output: { text: "NEVER_RETURN" } },
    });
    const read = (extra: Record<string, unknown> = {}, caller: AgentCaller = s.caller) =>
      s.product.opensteer_task_read({
        caller,
        input: opensteer_subagent_read.input.parse({
          subagentId: nodeId,
          view: "activity",
          limit: 2,
          ...extra,
        }),
        operationKey: randomUUID(),
      });
    const page = await read();
    expect(ThreadReadOutputSchema.parse(productToolOutput(page)).subagent).toMatchObject({
      id: nodeId,
      title: "Inspect parser",
      model: "child-model",
      prompt: "Find the parser",
      status: "running",
      stopSupported: true,
      stopping: false,
    });
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({ type: "tool.completed", text: null });
    expect(page.items[1]).toMatchObject({
      type: "tool.completed",
      text: "😀".repeat(500),
      textTruncated: true,
      nextTextOffset: 500,
    });
    expect(JSON.stringify(page)).not.toContain("NEVER_RETURN");
    const full = await read({ itemId: page.items[1]!.itemId, textOffset: 500 });
    expect(full.items[0]).toMatchObject({ text: "😀".repeat(200), textTruncated: false });
    const oldest = await read({ cursor: page.nextBefore });
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
      s.product.opensteer_delegation_cancel({
        caller: { ...s.caller, claims: { ...s.caller.claims, runId: createId("run") } },
        input: opensteer_subagent_stop.input.parse({ subagentId: nodeId }),
        operationKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await storeFixture.database
      .updateTable("executionNodes")
      .set({ stopSupported: false })
      .where("id", "=", nodeId)
      .execute();
    await expect(
      s.product.opensteer_delegation_cancel({
        caller: s.caller,
        input: opensteer_subagent_stop.input.parse({ subagentId: nodeId }),
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
    const result = await s.product.opensteer_delegation_cancel({
      caller: s.caller,
      input: opensteer_subagent_stop.input.parse({ subagentId: nodeId }),
      operationKey: randomUUID(),
    });
    expect(result).toEqual({ subagentId: nodeId, status: "stopping" });
    expect(ThreadReadOutputSchema.parse(productToolOutput(await read())).subagent).toMatchObject({
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
      s.product.opensteer_delegation_cancel({
        caller: s.caller,
        input: opensteer_subagent_stop.input.parse({ subagentId: nodeId }),
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
    await storeFixture.store.drainAssignmentReturn(s.assignmentId);
  });

  it("hands the result once to a Run that waits on its own task's task", async ({
    storeFixture,
  }) => {
    const s = await waitingTask(storeFixture, "wait-own-thread");
    const pending = s.product.opensteer_task_wait({
      caller: s.caller,
      input: opensteer_task_wait.input.parse({ taskId: s.task.threadId, timeoutMs: 2_000 }),
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
    await storeFixture.store.drainAssignmentReturn(s.assignmentId);
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
    const pending = s.product.opensteer_task_wait({
      caller: s.caller,
      input: opensteer_task_wait.input.parse({
        taskId: s.task.threadId,
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
      const read = Promise.withResolvers<void>();
      const releaseRead = Promise.withResolvers<void>();
      if (ending === "abort") {
        s.checkLive.mockImplementationOnce(async () => {
          read.resolve();
          await releaseRead.promise;
        });
      } else {
        s.checkLive
          .mockImplementationOnce(async () => {})
          .mockImplementationOnce(async () => read.resolve());
      }
      const abort = new AbortController();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const pending = withDatabaseOperationSignal(abort.signal, Date.now() + 10_000, () =>
          s.wait(2_000, s.caller, abort.signal),
        );
        const outcome = pending.then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        await withTimeout(read.promise, 1_000, {
          signal: AbortSignal.timeout(1_000),
          timeoutError: () => new Error("Task result wait did not read its initial state"),
        });
        await s.settle();
        await storeFixture.store.drainAssignmentReturn(s.assignmentId);
        expect(await s.returns()).toEqual([]);
        if (ending === "abort") {
          abort.abort(new Error("Tool call cut off"));
          releaseRead.resolve();
        } else await vi.advanceTimersByTimeAsync(2_000);
        const result = await outcome;
        if (ending === "abort")
          expect(result).toMatchObject({ error: new Error("Tool call cut off") });
        else expect(result).toMatchObject({ value: { status: "timed_out" } });
      } finally {
        abort.abort();
        releaseRead.resolve();
        vi.useRealTimers();
      }
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
        await s.wait(2_000, {
          kind: "connection",
          grant: { scope: "everything" },
          grantRevision: 1,
          key: `connection:${connection.id}`,
          connectionId: connection.id,
          userId: s.f.userId,
          accessMode: "full-access",
        })
      ).task?.result,
    ).toBe("42");
    await storeFixture.store.drainAssignmentReturn(s.assignmentId);
    expect(await s.returns()).toHaveLength(1);
  });

  it("refuses self and ancestor waits", async ({ storeFixture }) => {
    const s = await waitingTask(storeFixture, "wait-ancestry");
    const wait = (threadId: Fixture["thread"]["id"], caller = s.caller) =>
      s.product.opensteer_task_wait({
        caller,
        input: opensteer_task_wait.input.parse({ taskId: threadId, timeoutMs: 1 }),
        operationKey: randomUUID(),
      });
    await expect(wait(s.f.thread.id)).rejects.toThrow("Cannot wait on yourself");
    const child = (await storeFixture.store.getThreadForOwner(s.task.threadId, s.f.userId))!;
    await expect(wait(s.f.thread.id, { ...s.caller, thread: child })).rejects.toThrow(
      "task you are working for",
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

  it("uses the same waiter for opensteer_task_delegate wait mode", async ({ storeFixture }) => {
    const s = await waitingTask(storeFixture, "delegate-wait");
    const input = opensteer_task_delegate.input.parse({
      message: "Another answer",
      mode: "wait",
      timeoutMs: 2_000,
    });
    const created =
      Promise.withResolvers<Awaited<ReturnType<CommandService["delegateAdmittedThread"]>>>();
    const delegate = s.commands.delegateAdmittedThread.bind(s.commands);
    vi.spyOn(s.commands, "delegateAdmittedThread").mockImplementationOnce((request) => {
      const result = delegate(request);
      void result.then(created.resolve, created.reject);
      return result;
    });
    const reading = Promise.withResolvers<void>();
    const checkLive = vi.fn(async () => {
      if (checkLive.mock.calls.length === 2) reading.resolve();
    });
    const abort = new AbortController();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const pending = s.product.opensteer_task_delegate({
      caller: s.caller,
      input,
      operationKey: randomUUID(),
      checkLive,
      signal: abort.signal,
    });
    void pending.catch(created.reject);
    try {
      const delegated = await created.promise;
      const assignmentId = delegated.assignment.id;
      expect(assignmentId).not.toBe(s.assignmentId);
      await Promise.race([
        reading.promise,
        pending.then(() => {
          throw new Error("The delegation returned before its waiter read the open task");
        }),
      ]);
      await storeFixture.runDelegatedTurn(
        s.f,
        { id: delegated.run.id, threadId: delegated.thread.id },
        {
          replies: ["84"],
          end: "completed",
          suffix: "delegate-wait-mode",
        },
      );
      await storeFixture.store.drainRunFinish(delegated.run.id);
      expect(await pending).toMatchObject({
        result: "84",
        status: "completed",
        wait: { status: "settled" },
      });
      await expect(storeFixture.store.drainAssignmentReturn(assignmentId)).resolves.toBe("settled");
    } finally {
      abort.abort();
      await pending.catch(() => undefined);
      vi.useRealTimers();
    }
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
    expect(await pending).toMatchObject({
      status: "running",
      pendingRequest: { id: created.request.id },
    });
    const read = await s.product.opensteer_request_answer({
      caller: s.caller,
      input: {
        ...opensteer_request_read.input.parse({ requestId: created.request.id }),
        action: "read",
        limit: 50,
      },
      operationKey: randomUUID(),
    });
    expect(read).toMatchObject({
      request: {
        id: created.request.id,
        status: "pending",
        title: "Browser access",
        link: formatReferenceLink(created.request.id, "Browser access"),
      },
    });
    expect(read).not.toHaveProperty("request.payload");
    await expect(
      s.product.opensteer_request_answer({
        caller: s.caller,
        input: {
          ...opensteer_request_read.input.parse({ requestId: createId("request") }),
          action: "read",
          limit: 50,
        },
        operationKey: randomUUID(),
      }),
    ).rejects.toThrow("Request is unavailable");
  });

  it("discovers enforced budgets and names each AI account's computer", async ({
    storeFixture,
  }) => {
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
    const result = await s.product.opensteer_ai_account_list({
      caller: s.caller,
      input: opensteer_ai_account_list.input.parse({}),
      operationKey: randomUUID(),
    });
    expect(result.accounts).toContainEqual(
      expect.objectContaining({ aiAccountId: s.f.harnessInstance.id, computerId: s.f.runnerId }),
    );
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
      { kind: "app", machineId: DeviceIdSchema.parse(nativeRunner), appKey: "com.apple.finder" },
      { kind: "phone", machineId: DeviceIdSchema.parse(nativeRunner), display: "main" },
      { kind: "browser", sessionId, surfaceId: BrowserSurfaceIdSchema.parse("shared") },
      {
        kind: "browser",
        sessionId: createBrowserSessionId(),
        surfaceId: BrowserSurfaceIdSchema.parse("private"),
      },
    ];
    for (const value of values) await place(storeFixture, f, value);
    const owner = await s.read({ view: "activity" });
    expect(owner.recentPlaces.map((p) => p.tabId)).toEqual(
      values
        .map((value) =>
          value.kind === "browser"
            ? value.surfaceId
            : BrowserSurfaceIdSchema.parse(
                value.kind === "app"
                  ? `window:${value.machineId}:${value.appKey}`
                  : `phone:${value.machineId}`,
              ),
        )
        .reverse(),
    );
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

  it("withholds sensitive tools and reads a tool through one stable item before and after completion", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("shaped-tools");
    const s = setup(storeFixture, f);
    for (const name of [
      "saved_login_request",
      "chrome_cookies_request",
      "card_request",
      "computer_use",
      "computer_use.type",
    ]) {
      const t = await tool(storeFixture, f, name);
      const point = () => s.read({ view: "activity", itemId: t.itemId });
      expect((await point()).items[0]).toMatchObject({
        itemId: t.itemId,
        type: "tool.started",
        title: name,
        text: null,
        textTruncated: false,
      });
      await t.complete();
      expect((await point()).items[0]).toMatchObject({
        itemId: t.itemId,
        type: "tool.completed",
        title: name,
        text: null,
        textTruncated: false,
      });
      expect((await s.read({ view: "activity", limit: 1 })).items[0]).toMatchObject({
        title: name,
        text: null,
      });
    }
    const safe = await tool(storeFixture, f, "shell");
    expect((await s.read({ itemId: safe.itemId })).items[0]!.text).toContain("typed-value");
    await safe.complete();
    const clipped = (await s.read({ view: "activity", limit: 1 })).items[0]!;
    expect(clipped).toMatchObject({
      itemId: safe.itemId,
      title: "shell",
      textTruncated: true,
      nextTextOffset: 500,
    });
    expect(clipped.text).toHaveLength(500);
    expect((await s.read({ itemId: safe.itemId })).items[0]!.text).toContain("output-secret");
  });

  it("orders retained activity items, pages by item position, and omits reasoning, node text and Request payloads", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("shaped-events");
    const s = setup(storeFixture, f);
    const requestId = createId("request");
    await storeFixture.openLiveRequest(f, requestId);
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
    expect(page.items[0]!.link).toBe(formatReferenceLink(messageId, "Message"));
    const earlier = await s.read({ view: "activity", cursor: page.nextBefore });
    expect(
      earlier.items
        .filter((i) => i.type.startsWith("node."))
        .map((i) => ({ title: i.title, status: i.status, text: i.text })),
    ).toEqual([{ title: "Research", status: "completed", text: null }]);
    expect(earlier.items.some((item) => item.type === "request.opened")).toBe(false);
    const pending = await s.product.opensteer_request_answer({
      caller: s.caller,
      input: { ...opensteer_request_read.input.parse({ requestId }), action: "read", limit: 50 },
      operationKey: randomUUID(),
    });
    expect(pending).toMatchObject({
      request: {
        title: "Approval required",
        link: formatReferenceLink(requestId, "Approval required"),
      },
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
    await expect(
      s.read({ view: "activity", itemId: `request:${requestId}` }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
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
    for (let i = 1; i <= 20; i++) {
      const id = createId("message");
      await storeFixture.database
        .insertInto("messages")
        .values({
          ...original,
          id,
          sequence: String(BigInt(original.sequence) + BigInt(i)),
          content: sql`${JSON.stringify([{ type: "text", text: "z".repeat(50000) }])}::jsonb`,
        })
        .execute();
      await storeFixture.database
        .insertInto("transcriptItems")
        .values({
          id,
          threadId: original.threadId,
          runId: original.runId,
          attemptId: null,
          nodeId: null,
          kind: "message",
          position: String(1000 + i),
          messageId: id,
          visible: true,
          isTurnStart: false,
          createdAt: original.createdAt,
          view: { preview: "z".repeat(200) },
        })
        .execute();
    }
    const page = await s.read({ limit: 100, maxCharsPerItem: 50000 });
    expect(Buffer.byteLength(JSON.stringify(page.items))).toBeLessThanOrEqual(256 * 1024);
    expect(page.hasMore).toBe(true);
    expect(page.nextBefore).not.toBeNull();
    const shaped = ThreadReadOutputSchema.parse(productToolOutput(page));
    expect(shaped.task.link).toBe(formatReferenceLink(page.thread.id, page.thread.title));
    expect(
      shaped.recentRuns.every(
        (run) => run.link === formatReferenceLink(run.runId, `Run · ${page.thread.title}`),
      ),
    ).toBe(true);
    expect(
      shaped.items.every(
        (item) => item.link === formatReferenceLink(MessageIdSchema.parse(item.itemId), "Message"),
      ),
    ).toBe(true);
    const older = await s.read({ limit: 100, maxCharsPerItem: 50000, cursor: page.nextBefore });
    expect(older.items.length).toBeGreaterThan(0);
    expect(older.items.some((i) => page.items.some((p) => p.itemId === i.itemId))).toBe(false);
  });

  it("reads configure and lists queue by default on this task and refuses unnamed connection targets", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("shaped-configure");
    const s = setup(storeFixture, f);
    const configuration = await s.read({});
    expect(configuration.thread).toMatchObject({
      id: f.thread.id,
      link: formatReferenceLink(f.thread.id, f.thread.title),
      modelSelection: testModelSelection,
      accessMode: f.thread.accessMode,
    });
    const queue = await s.product.opensteer_task_queue({
      caller: s.caller,
      input: opensteer_task_queue.input.parse({ action: "list" }),
      operationKey: randomUUID(),
    });
    expect(queue).toEqual({
      paused: false,
      items: [],
      link: formatReferenceLink(f.thread.id, f.thread.title),
    });
    await storeFixture.database
      .updateTable("threads")
      .set({ accessMode: "full-access" })
      .where("id", "=", f.thread.id)
      .execute();
    const lower = { ...s.caller, accessMode: "approval-required" as const };
    const listing = opensteer_task_queue.input.parse({ action: "list" });
    expect(opensteer_task_queue.readsOnly?.(listing)).toBe(true);
    expect(
      await s.product.opensteer_task_queue({
        caller: lower,
        input: listing,
        operationKey: randomUUID(),
      }),
    ).toEqual({ paused: false, items: [], link: formatReferenceLink(f.thread.id, f.thread.title) });
    await expect(
      s.product.opensteer_task_queue({
        caller: lower,
        input: { ...opensteer_task_resume.input.parse({}), action: "resume" },
        operationKey: randomUUID(),
      }),
    ).rejects.toThrow("stronger access mode");
    await storeFixture.database
      .updateTable("threads")
      .set({ accessMode: f.thread.accessMode })
      .where("id", "=", f.thread.id)
      .execute();
    expect((await s.read({})).thread.id).toBe(f.thread.id);
    await s.product.opensteer_task_delegate({
      caller: s.caller,
      input: opensteer_task_delegate.input.parse({
        aiAccountId: f.harnessInstance.id,
        model: { ...testModelSelection, options: {} },
        message: "Work here",
      }),
      operationKey: randomUUID(),
    });
    const connection: AgentCaller = {
      kind: "connection",
      grant: { scope: "everything" },
      grantRevision: 1,
      key: "connection:test",
      connectionId: "test",
      userId: f.userId,
      accessMode: "full-access",
    };
    await expect(
      s.product.opensteer_task_configure({
        caller: connection,
        input: opensteer_task_configure.input.parse({ modelSelection: testModelSelection }),
        operationKey: randomUUID(),
      }),
    ).rejects.toThrow("must name taskId");
    await expect(
      s.product.opensteer_task_queue({
        caller: connection,
        input: opensteer_task_queue.input.parse({ action: "list" }),
        operationKey: randomUUID(),
      }),
    ).rejects.toThrow("must name taskId");
    const mcp = new OpensteerMcpService({
      callers: { authenticate: async () => connection },
      handlers: {
        opensteer_task_configure: (call) => s.product.opensteer_task_configure(call),
        opensteer_task_queue: (call) => s.product.opensteer_task_queue(call),
      },
      store: storeFixture.store,
      publicUrl: new URL("https://host.test"),
    });
    try {
      const options = { operationKey: randomUUID() };
      const absent = await mcp.callToolResult("token", "unknown_fixture_tool", {}, options);
      expect(absent).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "not_found" } },
      });
      for (const [name, input] of [
        ["opensteer_task_configure", { modelSelection: testModelSelection }],
        ["opensteer_task_queue", { action: "list" }],
      ] as const)
        expect(JSON.stringify(await mcp.callToolResult("token", name, input, options))).toBe(
          JSON.stringify(absent),
        );
    } finally {
      await mcp.close();
    }
    await expect(s.read({}, connection)).rejects.toThrow("must name taskId");
  });

  it("keeps sent and queued message links through output validation and strips previews before clipping", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("send-reference-links");
    const s = setup(storeFixture, f);
    const target = await storeFixture.startRunFixture("send-reference-target");
    const label = "Readable title ".repeat(50);
    const message = formatReferenceLink(f.thread.id, label);
    const sent = opensteer_task_send.output.parse(
      productToolOutput(
        await s.product.opensteer_task_send({
          caller: s.caller,
          input: opensteer_task_send.input.parse({
            taskId: target.thread.id,
            delivery: "queue",
            message,
          }),
          operationKey: randomUUID(),
        }),
      ),
    );
    const link = formatReferenceLink(sent.messageId, `Message · ${target.thread.title}`);
    expect(sent.link).toBe(link);
    expect(sent.disposition).toBe("pending");
    const queue = opensteer_task_queue.output.parse(
      productToolOutput(
        await s.product.opensteer_task_queue({
          caller: s.caller,
          input: opensteer_task_queue.input.parse({ taskId: target.thread.id, action: "list" }),
          operationKey: randomUUID(),
        }),
      ),
    );
    expect(queue.items).toContainEqual(
      expect.objectContaining({
        messageId: sent.messageId,
        link,
        preview: label.slice(0, 500),
        truncated: true,
      }),
    );
    expect(queue.items.find((item) => item.messageId === sent.messageId)!.preview).not.toContain(
      "opensteer:",
    );
    expect(
      (
        await storeFixture.database
          .selectFrom("messages")
          .select("content")
          .where("id", "=", sent.messageId)
          .executeTakeFirstOrThrow()
      ).content,
    ).toEqual([{ type: "text", text: message }]);
  });

  it("returns one task shape on delegation and replay, full results, and open/latest assignments across personal tasks", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("shaped-tasks");
    const s = setup(storeFixture, f);
    const input = opensteer_task_delegate.input.parse({
      aiAccountId: f.harnessInstance.id,
      model: { ...testModelSelection, options: {} },
      title: "Worker",
      message: "Do the work",
    });
    const operationKey = randomUUID();
    const delegated = await s.product.opensteer_task_delegate({
      caller: s.caller,
      input,
      operationKey,
    });
    expect(delegated).toMatchObject({
      link: formatReferenceLink(delegated.threadId, delegated.title),
      assignmentId: expect.any(String),
      status: "open",
      threadId: expect.any(String),
      parentThreadId: f.thread.id,
    });
    expect(
      await s.product.opensteer_task_delegate({ caller: s.caller, input, operationKey }),
    ).toEqual(delegated);
    const list = () =>
      s.product.opensteer_task_list({
        caller: s.caller,
        input: opensteer_task_list.input.parse({ parentTaskId: f.thread.id }),
        operationKey: randomUUID(),
      });
    expect((await list()).threads).toContainEqual(
      expect.objectContaining({
        id: delegated.threadId,
        link: delegated.link,
        assignmentId: delegated.assignmentId,
        taskStatus: "open",
      }),
    );
    const changedSince = async (since: string) =>
      opensteer_task_list.output
        .parse(
          productToolOutput(
            await s.product.opensteer_task_list({
              caller: s.caller,
              input: opensteer_task_list.input.parse({ changedSince: since }),
              operationKey: randomUUID(),
            }),
          ),
        )
        .tasks.find((task) => task.id === f.thread.id);
    const all = (await changedSince("2000-01-01T00:00:00Z"))!;
    const history = opensteer_task_read.output.parse(
      productToolOutput(
        await s.product.opensteer_task_read({
          caller: s.caller,
          input: opensteer_task_read.input.parse({ taskId: f.thread.id, limit: 100 }),
          operationKey: randomUUID(),
        }),
      ),
    ).items;
    // A pass reads back to firstNewAt, so it must be where task history shows the oldest one.
    expect(all.newMessages).toBe(history.length);
    expect(all.firstNewAt).toBe(history.map((item) => item.createdAt).toSorted()[0]);
    expect(await changedSince(new Date(Date.now() + 60_000).toISOString())).toBeUndefined();
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
    await new TabStore(storeFixture.database).open(
      {
        id: tabId,
        ownerId: f.userId,
        computerId: DeviceIdSchema.parse(f.runnerId),
        kind: "page",
        title: "Guest",
        url: "https://example.com",
        openedBy: "person",
        pageBinding: { lineageId: sessionId, sessionId, surfaceId: tabId },
      },
      randomUUID(),
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
    await s.show({ tabId });
    expect(s.frames.at(-1)).toMatchObject({
      runId: f.run.id,
      target: { tabId },
    });
    const next = await s.product.opensteer_task_delegate({
      caller: s.caller,
      input: opensteer_task_delegate.input.parse({
        taskId: delegated.threadId,
        message: "Continue",
      }),
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
    await storeFixture.database
      .updateTable("runs")
      .set({ status: "completed", completedAt: new Date() })
      .where("id", "=", next.runId!)
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
      grant: { scope: "everything" },
      grantRevision: 1,
      key: `connection:${record.id}`,
      connectionId: record.id,
      userId: f.userId,
      accessMode: "approval-required",
    };
    const status = await s.product.opensteer_task_wait({
      caller: connection,
      input: opensteer_task_wait.input.parse({ taskId: next.threadId }),
      operationKey: randomUUID(),
    });
    expect(status.task?.result).toBe(result);
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
      await s.product.opensteer_task_interrupt({
        caller: s.caller,
        input: opensteer_task_interrupt.input.parse({}),
        operationKey: randomUUID(),
      }),
    ).toEqual({
      interruptedRunId: null,
      link: formatReferenceLink(
        f.thread.id,
        (await storeFixture.store.getThreadForOwner(f.thread.id, f.userId))!.title,
      ),
    });
  });

  it("exposes cross-task Requests, non-secret person.question cards, doneBy, lastVisitedAt and task filters", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("request-visibility-caller");
    const s = setup(storeFixture, f);
    const other = await storeFixture.startRunFixture("request-visibility-other");
    const secretTask = await storeFixture.startRunFixture("request-visibility-secret");

    await storeFixture.store.enqueueThreadInput({
      threadId: other.thread.id,
      requestedBy: f.userId,
      policy: "report",
      content: [{ type: "text", text: "Autopay statement for card 2509 arrived" }],
      source: { kind: "human" },
      idempotencyKey: "other-searchable-msg",
    });

    const pendingQuestion = await storeFixture.store.requests.create({
      callId: "q-pending",
      kind: "person.question",
      mode: "durable",
      originatingRunId: other.run.id,
      originatingThreadId: other.thread.id,
      payload: { kind: "person.question" },
      presentation: {
        kind: "form",
        title: "Card 2509 payment",
        detail: "Card 2509 has a statement due Monday.",
        fields: [
          {
            id: "choice",
            prompt: "Want me to check the billing portal?",
            choices: [
              {
                label: "Leave it alone",
                value: "leave",
                description: "Assume AutoPay covers it unless an error arrives",
              },
              { label: "Check portal", value: "check" },
            ],
            custom: true,
            multiSelect: false,
            secret: false,
          },
        ],
      },
      requestedBy: f.userId,
      requiredActor: "requester",
    });

    const secretQuestion = await storeFixture.store.requests.create({
      callId: "q-secret",
      kind: "person.question",
      mode: "durable",
      originatingRunId: secretTask.run.id,
      originatingThreadId: secretTask.thread.id,
      payload: { kind: "person.question" },
      presentation: {
        kind: "form",
        title: "Private PIN",
        detail: "Enter your private PIN.",
        fields: [
          {
            id: "pin",
            prompt: "PIN",
            custom: true,
            multiSelect: false,
            secret: true,
          },
        ],
      },
      requestedBy: f.userId,
      requiredActor: "requester",
    });

    // Cross-task opensteer_request_list returns pending requests across the caller's tasks,
    // exposing non-secret question wording while redacting secret-field questions.
    const listedPending = opensteer_request_list.output.parse(
      productToolOutput(
        await s.product.opensteer_request_answer({
          caller: s.caller,
          input: {
            ...opensteer_request_list.input.parse({ status: "pending" }),
            action: "list",
          },
          operationKey: randomUUID(),
        }),
      ),
    );
    const listedNonSecret = listedPending.requests.find((r) => r.id === pendingQuestion.request.id);
    expect(listedNonSecret).toMatchObject({
      id: pendingQuestion.request.id,
      originatingTaskId: other.thread.id,
      status: "pending",
      question: {
        outcome: "pending",
        detail: "Card 2509 has a statement due Monday.",
        questions: [
          {
            prompt: "Want me to check the billing portal?",
            options: [
              {
                label: "Leave it alone",
                description: "Assume AutoPay covers it unless an error arrives",
              },
              { label: "Check portal" },
            ],
          },
        ],
      },
    });
    const listedSecret = listedPending.requests.find((r) => r.id === secretQuestion.request.id);
    expect(listedSecret).toBeDefined();
    expect(listedSecret?.question).toBeUndefined();
    expect(JSON.stringify(listedPending)).not.toContain("Enter your private PIN.");

    // opensteer_request_list filters by taskId.
    const filteredList = opensteer_request_list.output.parse(
      productToolOutput(
        await s.product.opensteer_request_answer({
          caller: s.caller,
          input: {
            ...opensteer_request_list.input.parse({ taskId: other.thread.id, status: "pending" }),
            action: "list",
          },
          operationKey: randomUUID(),
        }),
      ),
    );
    expect(filteredList.requests.map((r) => r.id)).toEqual([pendingQuestion.request.id]);

    // opensteer_task_read returns pendingRequests with non-secret question wording alongside the task.
    const readPending = ThreadReadOutputSchema.parse(
      productToolOutput(
        await s.product.opensteer_task_read({
          caller: s.caller,
          input: opensteer_task_read.input.parse({ taskId: other.thread.id }),
          operationKey: randomUUID(),
        }),
      ),
    );
    expect(readPending.pendingRequests).toMatchObject([
      {
        id: pendingQuestion.request.id,
        question: {
          outcome: "pending",
          detail: "Card 2509 has a statement due Monday.",
        },
      },
    ]);

    // opensteer_request_read shows non-secret question details, omits presentation, and
    // opensteer_request_answer still forbids answering person.question on the person's behalf.
    const readReq = opensteer_request_read.output.parse(
      productToolOutput(
        await s.product.opensteer_request_answer({
          caller: s.caller,
          input: {
            ...opensteer_request_read.input.parse({ requestId: pendingQuestion.request.id }),
            action: "read",
            limit: 50,
          },
          operationKey: randomUUID(),
        }),
      ),
    );
    expect(readReq.request).toMatchObject({
      id: pendingQuestion.request.id,
      question: { outcome: "pending" },
    });
    expect(readReq.request).not.toHaveProperty("presentation");
    const requestRevision = readReq.request.revision!;
    await expect(
      s.product.opensteer_request_answer({
        caller: s.caller,
        input: {
          ...opensteer_request_answer.input.parse({
            requestId: pendingQuestion.request.id,
            expectedRevision: requestRevision,
            response: { kind: "form", answers: { choice: ["leave"] } },
          }),
          action: "respond",
          limit: 50,
        },
        operationKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    // Task list supports hasPendingRequests, message-text query, and done filters.
    const withPending = opensteer_task_list.output.parse(
      productToolOutput(
        await s.product.opensteer_task_list({
          caller: s.caller,
          input: opensteer_task_list.input.parse({ hasPendingRequests: true }),
          operationKey: randomUUID(),
        }),
      ),
    );
    expect(withPending.tasks.map((t) => t.id)).toContain(other.thread.id);
    expect(withPending.tasks.map((t) => t.id)).not.toContain(f.thread.id);

    const byMessageText = opensteer_task_list.output.parse(
      productToolOutput(
        await s.product.opensteer_task_list({
          caller: s.caller,
          input: opensteer_task_list.input.parse({ query: "2509" }),
          operationKey: randomUUID(),
        }),
      ),
    );
    expect(byMessageText.tasks.map((t) => t.id)).toEqual([other.thread.id]);

    // Dismiss the question, record a human visit, and mark the task Done as the person.
    const beforeDismiss = new Date(Date.now() - 1000).toISOString();
    await storeFixture.store.requests.answerPersonQuestion({
      expectedRevision: requestRevision,
      requestId: pendingQuestion.request.id,
      resolvedBy: f.userId,
      response: { kind: "external", value: { decision: "declined" } },
    });
    const visitedAt = new Date().toISOString();
    await storeFixture.store.recordThreadVisit({
      threadId: other.thread.id,
      userId: f.userId,
      visitedAt,
    });
    await storeFixture.store.setThreadDone({
      done: true,
      idempotencyKey: "person-done-other",
      requestedBy: f.userId,
      threadId: other.thread.id,
    });

    // opensteer_task_read now shows doneBy: "person", lastVisitedAt, no pendingRequests,
    // and the settled dismissed question card inline in messages view!
    const readAfter = ThreadReadOutputSchema.parse(
      productToolOutput(
        await s.product.opensteer_task_read({
          caller: s.caller,
          input: opensteer_task_read.input.parse({ taskId: other.thread.id }),
          operationKey: randomUUID(),
        }),
      ),
    );
    expect(readAfter.task).toMatchObject({
      id: other.thread.id,
      doneBy: "person",
      lastVisitedAt: expect.any(String),
    });
    expect(readAfter.pendingRequests).toBeUndefined();
    const questionCard = readAfter.items.find(
      (item) => item.itemId === `request:${pendingQuestion.request.id}`,
    );
    expect(questionCard).toMatchObject({
      type: "request.resolved",
      status: "declined",
      title: "Card 2509 payment",
    });
    expect(questionCard?.text).toContain("Want me to check the billing portal?");
    expect(questionCard?.text).toContain("Dismissed by the person without answering.");

    // Reading the settled question card directly by itemId works.
    const readByItem = ThreadReadOutputSchema.parse(
      productToolOutput(
        await s.product.opensteer_task_read({
          caller: s.caller,
          input: opensteer_task_read.input.parse({
            taskId: other.thread.id,
            itemId: `request:${pendingQuestion.request.id}`,
          }),
          operationKey: randomUUID(),
        }),
      ),
    );
    expect(readByItem.items).toHaveLength(1);
    expect(readByItem.items[0]?.status).toBe("declined");

    // opensteer_task_list filters by done and reports questionsDismissed in changedSince.
    const doneTasks = opensteer_task_list.output.parse(
      productToolOutput(
        await s.product.opensteer_task_list({
          caller: s.caller,
          input: opensteer_task_list.input.parse({ done: true, changedSince: beforeDismiss }),
          operationKey: randomUUID(),
        }),
      ),
    );
    expect(doneTasks.tasks).toContainEqual(
      expect.objectContaining({
        id: other.thread.id,
        doneBy: "person",
        questionsDismissed: 1,
      }),
    );

    // Lineage-scoped agentPage strictly hides Requests from unrelated lineages, even if named.
    const lineageAll = await storeFixture.store.requests.agentPage({
      ownerId: f.userId,
      scope: { kind: "lineage", threadId: f.thread.id },
      scopeId: f.thread.id,
      limit: 50,
    });
    expect(lineageAll.requests.map((r) => r.originatingThreadId)).not.toContain(other.thread.id);
    const lineageNamed = await storeFixture.store.requests.agentPage({
      ownerId: f.userId,
      scope: { kind: "lineage", threadId: f.thread.id },
      scopeId: f.thread.id,
      originatingThreadId: other.thread.id,
      limit: 50,
    });
    expect(lineageNamed.requests).toEqual([]);

    // Agent Run marking another task Done records doneBy: "agent", never "person".
    const agentDoneTarget = await storeFixture.startRunFixture("request-visibility-agent-done");
    await s.product.opensteer_task_update({
      caller: s.caller,
      input: opensteer_task_update.input.parse({ taskId: agentDoneTarget.thread.id, done: true }),
      operationKey: randomUUID(),
    });
    expect(
      await storeFixture.store.getThreadForOwner(agentDoneTarget.thread.id, f.userId),
    ).toMatchObject({
      doneAt: expect.any(String),
      doneBy: "agent",
    });

    // opensteer_request_list window.byteCount never leaks the serialized size of redacted answers.
    const secretBefore = opensteer_request_list.output.parse(
      productToolOutput(
        await s.product.opensteer_request_answer({
          caller: s.caller,
          input: {
            ...opensteer_request_list.input.parse({ taskId: secretTask.thread.id, limit: 1 }),
            action: "list",
          },
          operationKey: randomUUID(),
        }),
      ),
    );
    const secretRev = (await storeFixture.store.requests.revision(secretQuestion.request.id))!;
    await storeFixture.store.requests.answerPersonQuestion({
      expectedRevision: secretRev,
      requestId: secretQuestion.request.id,
      resolvedBy: f.userId,
      response: { kind: "form", answers: { pin: ["9".repeat(1_200)] } },
    });
    const secretAfter = opensteer_request_list.output.parse(
      productToolOutput(
        await s.product.opensteer_request_answer({
          caller: s.caller,
          input: {
            ...opensteer_request_list.input.parse({ taskId: secretTask.thread.id, limit: 1 }),
            action: "list",
          },
          operationKey: randomUUID(),
        }),
      ),
    );
    expect(secretAfter.requests[0]?.question).toBeUndefined();
    expect(JSON.stringify(secretAfter)).not.toContain("9999");
    expect(secretAfter.window.byteCount).toBe(
      Buffer.byteLength(JSON.stringify(secretAfter.requests), "utf8"),
    );
    expect(Math.abs(secretAfter.window.byteCount - secretBefore.window.byteCount)).toBeLessThan(64);
  });

  it("supports anchored and legacy message-sequence cursors, long question offsets, and bounded pendingRequests", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("anchored-long-pending");
    const s = setup(storeFixture, f);

    // Create 4 messages so aroundMessageId has earlier messages to page into.
    const msgIds = [f.turn.message.id];
    for (let i = 1; i <= 3; i++) {
      const enq = await storeFixture.store.enqueueThreadInput({
        threadId: f.thread.id,
        requestedBy: f.userId,
        policy: "report",
        content: [{ type: "text", text: `History message ${i}` }],
        source: { kind: "human" },
        idempotencyKey: `anchor-msg-${i}`,
      });
      msgIds.push(enq.message.id);
    }

    // Anchored read returns a thread-history cursor; following it without aroundMessageId works.
    const anchored = ThreadReadOutputSchema.parse(
      productToolOutput(
        await s.product.opensteer_task_read({
          caller: s.caller,
          input: opensteer_task_read.input.parse({
            taskId: f.thread.id,
            aroundMessageId: msgIds[3],
            limit: 2,
          }),
          operationKey: randomUUID(),
        }),
      ),
    );
    expect(anchored.hasMore).toBe(true);
    expect(anchored.nextCursor).not.toBeNull();
    const followed = ThreadReadOutputSchema.parse(
      productToolOutput(
        await s.product.opensteer_task_read({
          caller: s.caller,
          input: opensteer_task_read.input.parse({
            taskId: f.thread.id,
            cursor: anchored.nextCursor!,
            limit: 10,
          }),
          operationKey: randomUUID(),
        }),
      ),
    );
    expect(followed.items.length).toBeGreaterThan(0);

    // Pre-upgrade legacy message-sequence cursor also pages cleanly.
    const latestRow = await storeFixture.database
      .selectFrom("messages")
      .select("sequence")
      .where("id", "=", msgIds[3]!)
      .executeTakeFirstOrThrow();
    const legacyCursor = encodeThreadHistoryCursor(
      f.thread.id,
      SequenceSchema.parse(latestRow.sequence),
    );
    const fromLegacy = ThreadReadOutputSchema.parse(
      productToolOutput(
        await s.product.opensteer_task_read({
          caller: s.caller,
          input: opensteer_task_read.input.parse({
            taskId: f.thread.id,
            cursor: legacyCursor,
            limit: 10,
          }),
          operationKey: randomUUID(),
        }),
      ),
    );
    expect(fromLegacy.items.map((item) => item.itemId)).not.toContain(msgIds[3]);
    expect(fromLegacy.items.length).toBeGreaterThan(0);

    // A 10,000-character settled question clips with textTruncated: true and resumes seamlessly.
    const longPrompt = "Q".repeat(10_000);
    const longReq = await storeFixture.store.requests.create({
      callId: "long-q",
      kind: "person.question",
      mode: "durable",
      originatingRunId: f.run.id,
      originatingThreadId: f.thread.id,
      payload: { kind: "person.question" },
      presentation: {
        kind: "form",
        title: "Long question",
        fields: [
          {
            id: "ans",
            prompt: longPrompt,
            choices: [{ label: "Yes", value: "yes", description: "Go ahead now" }],
            custom: true,
            multiSelect: false,
            secret: false,
          },
        ],
      },
      requestedBy: f.userId,
      requiredActor: "requester",
    });
    const longRev = (await storeFixture.store.requests.revision(longReq.request.id))!;
    await storeFixture.store.requests.answerPersonQuestion({
      expectedRevision: longRev,
      requestId: longReq.request.id,
      resolvedBy: f.userId,
      response: { kind: "form", answers: { ans: ["yes"] } },
    });
    const listRead = ThreadReadOutputSchema.parse(
      productToolOutput(
        await s.product.opensteer_task_read({
          caller: s.caller,
          input: opensteer_task_read.input.parse({ taskId: f.thread.id, limit: 20 }),
          operationKey: randomUUID(),
        }),
      ),
    );
    const card = listRead.items.find((item) => item.itemId === `request:${longReq.request.id}`)!;
    expect(card.textTruncated).toBe(true);
    expect(card.nextTextOffset).toBe(4_096);
    const resumed = ThreadReadOutputSchema.parse(
      productToolOutput(
        await s.product.opensteer_task_read({
          caller: s.caller,
          input: opensteer_task_read.input.parse({
            taskId: f.thread.id,
            itemId: card.itemId,
            textOffset: card.nextTextOffset!,
            maxCharsPerItem: 20_000,
          }),
          operationKey: randomUUID(),
        }),
      ),
    );
    expect(resumed.items[0]?.textTruncated).toBe(false);
    expect(`${card.text}${resumed.items[0]?.text}`).toBe(
      `Question: ${longPrompt}\nOptions: Yes — Go ahead now\nAnswer: Yes`,
    );

    // A >480 KiB valid form answer (600 KiB) stays readable rather than silently dropping.
    const hugeReq = await storeFixture.store.requests.create({
      callId: "huge-q",
      kind: "person.question",
      mode: "durable",
      originatingRunId: f.run.id,
      originatingThreadId: f.thread.id,
      payload: { kind: "person.question" },
      presentation: {
        kind: "form",
        title: "Huge form answer",
        fields: Array.from({ length: 6 }, (_, i) => ({
          id: `f_${i}`,
          prompt: `Field ${i}`,
          custom: true,
          multiSelect: false,
          secret: false,
        })),
      },
      requestedBy: f.userId,
      requiredActor: "requester",
    });
    const hugeRev = (await storeFixture.store.requests.revision(hugeReq.request.id))!;
    await storeFixture.store.requests.answerPersonQuestion({
      expectedRevision: hugeRev,
      requestId: hugeReq.request.id,
      resolvedBy: f.userId,
      response: {
        kind: "form",
        answers: Object.fromEntries(
          Array.from({ length: 6 }, (_, i) => [`f_${i}`, ["A".repeat(95_000)]]),
        ),
      },
    });
    const hugeNamed = ThreadReadOutputSchema.parse(
      productToolOutput(
        await s.product.opensteer_task_read({
          caller: s.caller,
          input: opensteer_task_read.input.parse({
            taskId: f.thread.id,
            itemId: `request:${hugeReq.request.id}`,
            maxCharsPerItem: 50_000,
          }),
          operationKey: randomUUID(),
        }),
      ),
    );
    expect(hugeNamed.items[0]?.textTruncated).toBe(true);
    expect(hugeNamed.items[0]?.text).toContain("Question: Field 0\nAnswer: AAAA");
    expect(hugeNamed.items[0]?.nextTextOffset).toBe(50_000);

    // 25 large pending questions still fit comfortably inside ThreadReadOutputSchema's 432 KiB limit.
    const bulkTask = await storeFixture.startRunFixture("bulk-pending-requests");
    for (let i = 0; i < 25; i++) {
      await storeFixture.store.requests.create({
        callId: `bulk-${i}`,
        kind: "person.question",
        mode: "durable",
        originatingRunId: bulkTask.run.id,
        originatingThreadId: bulkTask.thread.id,
        payload: { kind: "person.question" },
        presentation: {
          kind: "form",
          title: `Bulk question ${i}`,
          detail: `Detail ${i} ` + "D".repeat(10_000),
          fields: [
            {
              id: "choice",
              prompt: "Choose?",
              choices: [{ label: "Ok", value: "ok" }],
              custom: true,
              multiSelect: false,
              secret: false,
            },
          ],
        },
        requestedBy: f.userId,
        requiredActor: "requester",
      });
    }
    const bulkRead = ThreadReadOutputSchema.parse(
      productToolOutput(
        await s.product.opensteer_task_read({
          caller: s.caller,
          input: opensteer_task_read.input.parse({ taskId: bulkTask.thread.id }),
          operationKey: randomUUID(),
        }),
      ),
    );
    expect(bulkRead.pendingRequests?.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(bulkRead.pendingRequests), "utf8")).toBeLessThanOrEqual(
      64 * 1024,
    );
  });
});
