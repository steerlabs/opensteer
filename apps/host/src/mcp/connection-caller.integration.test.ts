import { TriggerStore } from "@opensteer/database";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { agentTools } from "@opensteer/agent-tools";
import { HarnessInstanceCatalogSchema } from "@opensteer/protocol";
import {
  createId,
  ModelSelectionSchema,
  ThreadIdSchema,
  MessageIdSchema,
  type AgentGrant,
  type RunId,
  type UserId,
} from "@opensteer/core";
import {
  AgentConnectionStore,
  assertLineageCompatibleReuse,
  type OpensteerStore,
} from "@opensteer/database";
import {
  describeStore,
  testModelSelection,
  testReadyHarnessCatalog,
  pendingEvent,
} from "@opensteer/database/test-support/store";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { expect, vi } from "vitest";
import { writeAgentHomeSettings } from "@opensteer/database/test-support/personal";
import { startPersonalQueuedRunFixture } from "@opensteer/database/test-support/personal-run";
import { connectionCredentialPrefix } from "./connections/connection-authenticator.js";
import { mcpResourceMetadataPath } from "./connections/connection-oauth.js";
import {
  clients,
  commands,
  connection,
  createTask,
  errorText,
  ownerTask,
  queuedRun,
  send,
  serveMcp,
} from "./connection-caller.test-support.js";

describeStore("connected agents on the Opensteer MCP", (it) => {
  it("lists only connection tools and refuses a revoked connection on its open session", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("connection-tools");
    const url = await serveMcp(storeFixture);
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
    });
    const listed = (await agent.client.listTools()).tools.map(({ name }) => name);
    expect(listed).toEqual(
      agentTools.filter((tool) => tool.callers.includes("connection")).map(({ name }) => name),
    );
    expect(listed).toContain("opensteer_task_update");

    const read = await agent.client.callTool({
      name: "opensteer_task_read",
      arguments: { taskId: f.thread.id },
    });
    expect(read.isError).not.toBe(true);
    expect(read.structuredContent).toMatchObject({ task: { id: f.thread.id } });

    await agent.revoke();
    // The open session's next request is refused before any tool runs.
    await expect(
      agent.client.callTool({ name: "opensteer_task_read", arguments: { taskId: f.thread.id } }),
    ).rejects.toThrow("Agent tools authorization is invalid or expired");
  });

  it("keeps an approval-required connection out of full-access changes", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("connection-reach");
    const { thread: fullAccess } = await storeFixture.store.createThread({
      accessMode: "full-access",
      createdBy: f.userId,
      environmentId: f.environmentId,
      harnessInstanceId: f.harnessInstance.id,
      idempotencyKey: "connection-full-access",
      modelSelection: testModelSelection,
      title: "Full access",
    });
    const url = await serveMcp(storeFixture);
    const cautious = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "approval-required",
    });
    expect(
      errorText(
        await cautious.client.callTool({
          name: "opensteer_task_interrupt",
          arguments: { taskId: fullAccess.id },
        }),
      ),
    ).toContain("stronger access mode");
    expect((await storeFixture.store.getThreadForOwner(fullAccess.id, f.userId))?.title).toBe(
      "Full access",
    );
  });

  it("delegates independent personal work and preserves connection authorship", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("connection-delegate");
    const url = await serveMcp(storeFixture);
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "approval-required",
    });
    const result = await agent.client.callTool({
      name: "opensteer_task_create",
      arguments: {
        aiAccountId: f.harnessInstance.id,
        model: { ...testModelSelection, options: {} },
        title: "External work",
        message: "Inspect the project",
        operationKey: "external-create",
      },
    });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      delegationId: null,
      parentTaskId: null,
      status: "open",
    });
    const threadId = ThreadIdSchema.parse((result.structuredContent as { taskId: string }).taskId);
    expect(
      await storeFixture.database
        .selectFrom("threadInputs")
        .select("authoritySource")
        .where("threadId", "=", threadId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ authoritySource: { kind: "connection", connectionId: agent.id } });
    expect(
      await storeFixture.database
        .selectFrom("delegations")
        .select("id")
        .where("childThreadId", "=", threadId)
        .execute(),
    ).toEqual([]);
    expect(
      (await storeFixture.database.introspection.getTables()).map((t) => t.name),
    ).not.toContain("agent_tool_operations");
    const replay = await agent.client.callTool({
      name: "opensteer_task_create",
      arguments: {
        aiAccountId: f.harnessInstance.id,
        model: { ...testModelSelection, options: {} },
        title: "External work",
        message: "Inspect the project",
        operationKey: "external-create",
      },
    });
    expect(replay.structuredContent).toEqual(result.structuredContent);
    const conflicting = await agent.client.callTool({
      name: "opensteer_task_create",
      arguments: {
        aiAccountId: f.harnessInstance.id,
        model: { ...testModelSelection, options: {} },
        title: "External work",
        message: "Different",
        operationKey: "external-create",
      },
    });
    expect(errorText(conflicting)).toMatch(/idempotency|different input/i);
    const message = await agent.client.callTool({
      name: "opensteer_task_send",
      arguments: {
        taskId: threadId,
        delivery: "report",
        message: "A connection report",
        operationKey: "report-retry",
      },
    });
    expect(message.isError).not.toBe(true);
    const messageId = (message.structuredContent as { messageId: string }).messageId;
    expect(
      await storeFixture.database
        .selectFrom("messages")
        .select("author")
        .where("id", "=", MessageIdSchema.parse(messageId))
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ author: { kind: "connection", connectionId: agent.id } });
    const messageReplay = await agent.client.callTool({
      name: "opensteer_task_send",
      arguments: {
        taskId: threadId,
        delivery: "report",
        message: "A connection report",
        operationKey: "report-retry",
      },
    });
    expect(messageReplay.structuredContent).toEqual(message.structuredContent);
    const messageConflict = await agent.client.callTool({
      name: "opensteer_task_send",
      arguments: {
        taskId: threadId,
        delivery: "report",
        message: "Changed",
        operationKey: "report-retry",
      },
    });
    expect(errorText(messageConflict)).toMatch(/idempotency|different input/i);
    expect(
      await storeFixture.database
        .selectFrom("messages")
        .select("id")
        .where("threadId", "=", threadId)
        .execute(),
    ).toHaveLength(2);
    const stopped = await agent.client.callTool({
      name: "opensteer_task_interrupt",
      arguments: { taskId: threadId },
    });
    expect(stopped.isError, JSON.stringify(stopped.content)).not.toBe(true);
    expect(stopped.structuredContent).toMatchObject({
      interruptedRunId: (result.structuredContent as { runId: string }).runId,
    });
    const stopReplay = await agent.client.callTool({
      name: "opensteer_task_interrupt",
      arguments: { taskId: threadId },
    });
    expect(stopReplay.structuredContent).toEqual({
      interruptedRunId: null,
      link: expect.stringMatching(new RegExp(`\\]\\(opensteer:${threadId}\\)$`, "u")),
    });
  });

  it("returns a connection's original task on retry after the person's defaults change", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("connection-delegate-defaults");
    const url = await serveMcp(storeFixture);
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "approval-required",
    });
    const catalog = testReadyHarnessCatalog(f.harnessInstance.id);
    await storeFixture.store.recordHarnessCatalogs({
      catalogs: [
        HarnessInstanceCatalogSchema.parse({
          ...catalog,
          models: [
            ...(catalog.status === "ready" ? catalog.models : []),
            {
              displayName: "GPT-6 Sol",
              isDefault: false,
              modelId: "gpt-6-sol",
              options: [],
              providerId: testModelSelection.providerId,
            },
          ],
        }),
      ],
      environmentId: f.environmentId,
      expectedRevisions: new Map([[f.harnessInstance.id, f.harnessInstance.runtimeRevision]]),
    });
    const remember = (modelId: string) =>
      storeFixture.store.rememberExecutionChoice(f.userId, {
        selection: {
          environmentId: f.environmentId,
          harnessInstanceId: f.harnessInstance.id,
          modelSelection: ModelSelectionSchema.parse({
            ...testModelSelection,
            modelId,
            options: {},
          }),
        },
      });
    await remember(testModelSelection.modelId);
    // The model is left to the person's remembered choice.
    const call = (title: string) =>
      agent.client.callTool({
        name: "opensteer_task_create",
        arguments: {
          aiAccountId: f.harnessInstance.id,
          title,
          message: "Inspect the project",
          operationKey: "defaults-retry",
        },
      });
    const first = await call("External work");
    expect(first.isError, JSON.stringify(first.content)).not.toBe(true);
    await remember("gpt-6-sol");
    const retry = await call("External work");
    expect(retry.isError, JSON.stringify(retry.content)).not.toBe(true);
    expect(retry.structuredContent).toEqual(first.structuredContent);
    expect(errorText(await call("Renamed work"))).toMatch(/idempotency|different input/i);
  });

  it("starts a task named by no account or history only on an account the person left on", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("connection-delegate-excluded");
    const url = await serveMcp(storeFixture);
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "approval-required",
    });
    const second = await storeFixture.store.createHarnessInstance({
      config: {},
      driverKind: f.harnessInstance.driverKind,
      environmentId: f.environmentId,
      name: "Second account",
      stateKind: "isolated",
    });
    await storeFixture.store.recordHarnessCatalogs({
      catalogs: [testReadyHarnessCatalog(f.harnessInstance.id), testReadyHarnessCatalog(second.id)],
      environmentId: f.environmentId,
      expectedRevisions: new Map([
        [f.harnessInstance.id, f.harnessInstance.runtimeRevision],
        [second.id, second.runtimeRevision],
      ]),
    });
    const exclude = (...excludedAccounts: (typeof second.id)[]) =>
      writeAgentHomeSettings(storeFixture.store.database, {
        backgroundModels: { excludedAccounts },
      });
    const call = (operationKey: string) =>
      agent.client.callTool({
        name: "opensteer_task_create",
        arguments: {
          title: "Automatic work",
          message: "Inspect the project",
          operationKey,
        },
      });
    expect(f.harnessInstance.isDefault).toBe(true);
    await exclude(f.harnessInstance.id, second.id);
    expect(errorText(await call("all-excluded"))).toContain("Choose aiAccountId for the new task");
    await exclude(f.harnessInstance.id);
    const started = await call("default-excluded");
    expect(started.isError, JSON.stringify(started.content)).not.toBe(true);
    const threadId = ThreadIdSchema.parse((started.structuredContent as { taskId: string }).taskId);
    expect(await storeFixture.store.getThreadForOwner(threadId, f.userId)).toMatchObject({
      harnessInstanceId: second.id,
    });
  });

  it("lets a connection inspect and update a task through shared domain commands", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("connection-read-write");
    const url = await serveMcp(storeFixture);
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
    });
    for (const name of [
      "opensteer_ai_account_list",
      "opensteer_request_list",
      "opensteer_automation_list",
      "app_list",
      "computer_apps",
    ]) {
      const result = await agent.client.callTool({ name, arguments: {} });
      expect(result.isError, `${name}: ${JSON.stringify(result.content)}`).not.toBe(true);
    }
    for (const arguments_ of [{ title: "Renamed" }, { done: true }, { done: false }]) {
      const result = await agent.client.callTool({
        name: "opensteer_task_update",
        arguments: { taskId: f.thread.id, ...arguments_ },
      });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    }
    expect(await storeFixture.store.getThreadForOwner(f.thread.id, f.userId)).toMatchObject({
      title: "Renamed",
      doneAt: null,
    });
  });

  it("uses the client's model error and enforces the connection ceiling for configure and interrupt", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.createRunFixture("configure-connection");
    const url = await serveMcp(storeFixture);
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
    });
    const unavailableModel = { providerId: "openai", modelId: "not-offered", options: {} };
    const result = await agent.client.callTool({
      name: "opensteer_task_configure",
      arguments: { taskId: f.thread.id, modelSelection: unavailableModel },
    });
    expect(errorText(result)).toBe(
      "The selected model is not available in this AI engine on this Runner",
    );
    const read = await agent.client.callTool({
      name: "opensteer_task_read",
      arguments: { taskId: f.thread.id },
    });
    expect(read.structuredContent).toMatchObject({
      task: {
        id: f.thread.id,
        aiAccountId: f.harnessInstance.id,
        modelSelection: testModelSelection,
      },
    });
    const changed = await agent.client.callTool({
      name: "opensteer_task_configure",
      arguments: {
        taskId: f.thread.id,
        modelSelection: { ...testModelSelection, options: {} },
      },
    });
    expect(changed.isError, JSON.stringify(changed.content)).not.toBe(true);
    expect(changed.structuredContent).toMatchObject({
      modelSelection: { ...testModelSelection, options: {} },
    });
    expect((await storeFixture.store.getThreadForOwner(f.thread.id, f.userId))?.accessMode).toBe(
      f.thread.accessMode,
    );
    await storeFixture.store.updateThreadAccessMode({
      threadId: f.thread.id,
      requestedBy: f.userId,
      accessMode: "full-access",
    });
    const cautious = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "approval-required",
    });
    for (const name of ["opensteer_task_configure", "opensteer_task_interrupt"]) {
      expect(
        errorText(
          await cautious.client.callTool({
            name,
            arguments: {
              taskId: f.thread.id,

              ...(name === "opensteer_task_configure"
                ? { modelSelection: testModelSelection }
                : {}),
            },
          }),
        ),
      ).toContain("stronger access mode");
    }
  });

  it("cancels, reorders, promotes and resumes the same durable queue through MCP", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("connection-queue");
    const url = await serveMcp(storeFixture);
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
    });
    const send = async (message: string) => {
      const result = await agent.client.callTool({
        name: "opensteer_task_send",
        arguments: { taskId: f.thread.id, delivery: "queue", message },
      });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      return (result.structuredContent as { messageId: string }).messageId;
    };
    const first = await send("First");
    const second = await send("Second");
    const other = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
    });
    expect(
      errorText(
        await other.client.callTool({
          name: "opensteer_task_queue",
          arguments: { taskId: f.thread.id, action: "cancel", messageId: first },
        }),
      ),
    ).toBe("Only your own queued messages can be cancelled");
    const queue = async (action: string, args = {}) => {
      const result = await agent.client.callTool({
        name: action === "resume" ? "opensteer_task_resume" : "opensteer_task_queue",
        arguments: { taskId: f.thread.id, ...(action === "resume" ? {} : { action }), ...args },
      });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      return result.structuredContent;
    };
    expect(await queue("move", { messageId: second, beforeMessageId: first })).toMatchObject({
      items: [
        {
          messageId: second,
          preview: "Second",
          truncated: false,
          author: { kind: "connection", connectionId: agent.id },
        },
        { messageId: first },
      ],
    });
    expect(await queue("cancel", { messageId: first })).toMatchObject({
      items: [{ messageId: second }],
    });
    expect(await queue("steer", { messageId: second, expectedRunId: f.run.id })).toMatchObject({
      items: [],
    });
    const long = await send("x".repeat(1000));
    expect(await queue("list")).toMatchObject({
      items: [{ messageId: long, preview: "x".repeat(500), truncated: true }],
    });
    await queue("cancel", { messageId: long });
    const stopped = await agent.client.callTool({
      name: "opensteer_task_interrupt",
      arguments: { taskId: f.thread.id },
    });
    expect(stopped.isError, JSON.stringify(stopped.content)).not.toBe(true);
    expect(stopped.structuredContent).toMatchObject({ interruptedRunId: f.run.id });
    expect(await queue("list")).toMatchObject({ paused: true });
    expect(await queue("resume")).toMatchObject({ paused: false });
  });

  it("waits on committed completion events, reports offline, times out, and releases disconnected waits", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("connection-wait");
    const subscribed = vi.fn();
    const unsubscribed = vi.fn();
    let connected = true;
    const url = await serveMcp(storeFixture, {
      subscribed,
      unsubscribed,
      connected: () => connected,
    });
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "approval-required",
    });
    const timed = await agent.client.callTool({
      name: "opensteer_task_wait",
      arguments: { taskId: f.thread.id, timeoutMs: 10 },
    });
    expect(timed.isError, JSON.stringify(timed.content)).not.toBe(true);
    expect(timed.structuredContent).toMatchObject({ status: "timed_out", items: [] });
    connected = false;
    expect(
      (
        await agent.client.callTool({
          name: "opensteer_task_wait",
          arguments: { taskId: f.thread.id },
        })
      ).structuredContent,
    ).toMatchObject({ status: "offline" });
    connected = true;
    const controller = new AbortController();
    const disconnected = fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${agent.token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-session-id": "detached-wait",
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 81,
        method: "tools/call",
        params: { name: "opensteer_task_wait", arguments: { taskId: f.thread.id } },
      }),
    });
    const rejected = expect(disconnected).rejects.toThrow();
    await vi.waitFor(() => expect(subscribed).toHaveBeenCalledTimes(3), { timeout: 2000 });
    controller.abort();
    await rejected;
    await vi.waitFor(() => expect(unsubscribed).toHaveBeenCalledTimes(3), { timeout: 2000 });
    expect(
      (
        await storeFixture.database
          .selectFrom("runs")
          .select("status")
          .where("id", "=", f.run.id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("running");
    const waiting = agent.client.callTool({
      name: "opensteer_task_wait",
      arguments: { taskId: f.thread.id },
    });
    await vi.waitFor(() => expect(subscribed).toHaveBeenCalledTimes(4), { timeout: 2000 });
    await storeFixture.store.commitRunnerEvent({
      environmentId: f.environmentId,
      runnerId: f.runnerId,
      runnerBootId: f.runnerBootId,
      event: pendingEvent({
        bindingGeneration: f.bindingGeneration,
        data: { status: "completed" },
        environmentId: f.environmentId,
        ordinal: 1,
        runId: f.run.id,
        threadId: f.thread.id,
        type: "run.completed",
      }),
    });
    expect((await waiting).structuredContent).toMatchObject({
      status: "settled",
      run: { id: f.run.id, status: "completed" },
    });
    expect(unsubscribed).toHaveBeenCalledTimes(4);
  });

  it("returns a pending Request without granting approval authority", async ({ storeFixture }) => {
    const f = await storeFixture.startRunFixture("connection-wait-request");
    const subscribed = vi.fn();
    const url = await serveMcp(storeFixture, { subscribed });
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "approval-required",
    });
    const waiting = agent.client.callTool({
      name: "opensteer_task_wait",
      arguments: { taskId: f.thread.id },
    });
    const observed = waiting.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await vi.waitFor(
      () =>
        expect(
          subscribed,
          "task wait never subscribed for the pending Request",
        ).toHaveBeenCalledOnce(),
      { timeout: 1000 },
    );
    const created = await storeFixture.store.requests.create({
      callId: "pending-wait",
      kind: "browser.access",
      mode: "durable",
      originatingRunId: f.run.id,
      originatingThreadId: f.thread.id,
      requestedBy: f.userId,
      requiredActor: "requester",
      payload: {
        kind: "browser.access",
        reason: "Choose a browser",
        suggestion: { kind: "user_choice" },
      },
      presentation: {
        kind: "external",
        title: "Browser access",
        subject: { kind: "thread", id: f.thread.id },
      },
    });
    const result = await withTimeout(observed, 5000, {
      timeoutError: () => new Error("Pending Request never ended its task wait"),
    });
    if ("error" in result) throw result.error;
    expect(result.value.structuredContent).toMatchObject({
      pendingRequest: { id: created.request.id, kind: "browser.access" },
    });
    expect((await agent.client.listTools()).tools.map((t) => t.name)).not.toContain(
      "request_resolve",
    );
    expect((await storeFixture.store.requests.get(created.request.id))?.status).toBe("pending");
  });

  it("returns only newly published messages after the requested message", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("connection-wait-message");
    const subscribed = vi.fn();
    const url = await serveMcp(storeFixture, { subscribed });
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
    });
    const send = (message: string) =>
      agent.client.callTool({
        name: "opensteer_task_send",
        arguments: { taskId: f.thread.id, delivery: "report", message },
      });
    const anchor = await send("Already seen");
    const afterMessageId = (anchor.structuredContent as { messageId: string }).messageId;
    const waiting = agent.client.callTool({
      name: "opensteer_task_wait",
      arguments: { taskId: f.thread.id, afterMessageId },
    });
    await vi.waitFor(() => expect(subscribed).toHaveBeenCalledOnce(), { timeout: 2000 });
    const next = await send("New context");
    const result = await waiting;
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "running",
      items: [
        {
          itemId: (next.structuredContent as { messageId: string }).messageId,
          author: { kind: "connection", connectionId: agent.id },
        },
      ],
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain(afterMessageId);
  });

  it("commits a self-interrupt command before announcing grant revocation and returns it over MCP", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("self-interrupt");
    const url = await serveMcp(storeFixture, {
      runScope: {
        aud: "opensteer-run-tools",
        exp: Math.floor(Date.now() / 1000) + 60,
        iat: Math.floor(Date.now() / 1000),
        iss: "opensteer-host",
        jti: "self-interrupt",
        bindingGeneration: f.bindingGeneration,
        environmentId: f.environmentId,
        requestedBy: f.userId,
        runId: f.run.id,
        runnerBootId: f.runnerBootId,
        runnerId: f.runnerId,
        threadId: f.thread.id,
      },
    });
    const client = new Client({ name: "self", version: "1" });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: "Bearer test-run" } },
      }) as unknown as Transport,
      { timeout: 5000 },
    );
    let detach = () => {};
    const revoked = new Promise<unknown>((resolve, reject) => {
      detach = storeFixture.store.onRunGrantsRevoked(() => {
        void storeFixture.database
          .selectFrom("commands")
          .select("payload")
          .where("threadId", "=", f.thread.id)
          .where("type", "=", "run.interrupt")
          .executeTakeFirstOrThrow()
          .then((row) => resolve(row.payload), reject);
      });
    });
    try {
      const result = await client.callTool({
        name: "opensteer_task_interrupt",
        arguments: {},
      });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ interruptedRunId: f.run.id });
      expect(
        await withTimeout(revoked, 2000, {
          timeoutError: () => new Error("Self interrupt never revoked its grant"),
        }),
      ).toMatchObject({ runId: f.run.id, threadId: f.thread.id });
    } finally {
      detach();
    }
  });

  it("ends a revoked connection's pending wait without stopping its Run", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("connection-revoke-wait");
    const subscribed = vi.fn();
    const unsubscribed = vi.fn();
    const notify: { current?: () => void } = {};
    const url = await serveMcp(storeFixture, { subscribed, unsubscribed, notify });
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
    });
    const waiting = agent.client.callTool({
      name: "opensteer_task_wait",
      arguments: { taskId: f.thread.id },
    });
    await vi.waitFor(() => expect(subscribed).toHaveBeenCalledOnce(), { timeout: 2000 });
    await expect(
      new AgentConnectionStore(storeFixture.database).revoke(createId("user"), agent.id),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(unsubscribed).not.toHaveBeenCalled();
    // Revocation closes the session, unless a Thread change wakes the wait first:
    // its recheck then answers with an error. Either way the wait fails.
    const ended = waiting.then(
      (result) => expect(result.isError).toBe(true),
      (error: unknown) => expect(error).toBeInstanceOf(Error),
    );
    await agent.revoke();
    notify.current?.();
    await ended;
    await vi.waitFor(() => expect(unsubscribed).toHaveBeenCalledOnce(), { timeout: 2000 });
    expect(
      (
        await storeFixture.database
          .selectFrom("runs")
          .select("status")
          .where("id", "=", f.run.id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("running");
  });

  it("challenges an unauthenticated connection with its resource metadata", async ({
    storeFixture,
  }) => {
    await storeFixture.createRunFixture("connection-challenge");
    const url = await serveMcp(storeFixture);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${connectionCredentialPrefix}${"x".repeat(43)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${url.origin}${mcpResourceMetadataPath}"`,
    );
  });
});

describeStore("connection grants and lineage", (it) => {
  const tasksOnly: AgentGrant = { scope: "selected", tasks: true, resources: [] };
  const program = {
    language: "javascript",
    source: "export default async () => null",
    toolContractVersion: 5,
  } as const;
  function scheduled(anchor: import("@opensteer/core").ThreadId, userId: UserId, key: string) {
    return {
      actorThreadId: null,
      anchorThreadId: anchor,
      createdBy: userId,
      idempotencyKey: key,
      name: `Automation ${key}`,
      program,
      source: {
        kind: "schedule" as const,
        schedule: { expression: "0 9 * * *", kind: "cron" as const, timezone: "UTC" },
      },
    };
  }

  it("offers a selected connection without tasks no task tool, by listing or by name", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("grant-no-tasks");
    const url = await serveMcp(storeFixture);
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
      grant: { scope: "selected", tasks: false, resources: [] },
    });
    expect((await agent.client.listTools()).tools).toEqual([]);
    // With nothing granted the session serves no tool at all.
    await expect(
      agent.client.callTool({ name: "opensteer_task_list", arguments: {} }),
    ).rejects.toThrow("Method not found");
    const plugins = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
      grant: {
        scope: "selected",
        tasks: false,
        resources: [
          { kind: "plugin", target: { kind: "installed", pluginId: "notes" }, access: "read" },
        ],
      },
    });
    const listed = (await plugins.client.listTools()).tools.map(({ name }) => name);
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.filter((name) => name.startsWith("opensteer_"))).toEqual([]);
    for (const name of [
      "opensteer_task_list",
      "opensteer_task_read",
      "opensteer_ai_account_list",
    ]) {
      const result = await plugins.client.callTool({
        name,
        arguments: name === "opensteer_task_read" ? { taskId: f.thread.id } : {},
      });
      // Not registered for this session: the SDK refuses the name before any handler runs.
      expect(result.isError, name).toBe(true);
      expect(JSON.stringify(result.content), name).toMatch(/not found/iu);
    }
    expect(
      await storeFixture.database.selectFrom("threadInputs").select("messageId").execute(),
    ).toHaveLength(1);
  });

  it("keeps a selected connection to its own tasks, Requests and automations", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("grant-lineage");
    const url = await serveMcp(storeFixture);
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "auto",
      grant: tasksOnly,
    });
    const own = await createTask(agent, f, "own-task");
    const { database, store } = storeFixture;
    expect(
      await database
        .selectFrom("threads")
        .select("originConnectionId")
        .where("id", "=", own)
        .executeTakeFirstOrThrow(),
    ).toEqual({ originConnectionId: agent.id });
    expect(
      await database
        .selectFrom("threadInputs")
        .select("connectionId")
        .where("threadId", "=", own)
        .execute(),
    ).toEqual([{ connectionId: agent.id }]);
    expect(await queuedRun(storeFixture, own)).toMatchObject({ connectionId: agent.id });

    const listed = await agent.client.callTool({ name: "opensteer_task_list", arguments: {} });
    expect(listed.isError, JSON.stringify(listed.content)).not.toBe(true);
    expect(
      (listed.structuredContent as { tasks: { id: string }[] }).tasks.map(({ id }) => id),
    ).toEqual([own]);
    for (const name of ["opensteer_task_read", "opensteer_task_send", "opensteer_task_interrupt"])
      expect(
        errorText(
          await agent.client.callTool({
            name,
            arguments:
              name === "opensteer_task_send"
                ? {
                    taskId: f.thread.id,
                    message: "Hello",
                    delivery: "queue",
                    operationKey: "send-owner",
                  }
                : { taskId: f.thread.id },
          }),
        ),
      ).toContain("Task is unavailable");

    const request = (threadId: import("@opensteer/core").ThreadId, runId: RunId, callId: string) =>
      store.requests.create({
        callId,
        kind: "browser.access",
        mode: "durable",
        originatingRunId: runId,
        originatingThreadId: threadId,
        requestedBy: f.userId,
        requiredActor: "requester",
        payload: { kind: "browser.access", reason: "Choose", suggestion: { kind: "user_choice" } },
        presentation: {
          kind: "external",
          title: "Browser access",
          subject: { kind: "thread", id: threadId },
        },
      });
    const ownRun = await queuedRun(storeFixture, own);
    await startPersonalQueuedRunFixture(store, ownRun.id);
    const owned = await request(own, ownRun.id, "lineage");
    const owners = await request(f.thread.id, f.run.id, "owner");
    const requests = await agent.client.callTool({
      name: "opensteer_request_list",
      arguments: {},
    });
    expect(requests.isError, JSON.stringify(requests.content)).not.toBe(true);
    expect(
      (requests.structuredContent as { requests: { id: string }[] }).requests.map(({ id }) => id),
    ).toEqual([owned.request.id]);
    expect(
      errorText(
        await agent.client.callTool({
          name: "opensteer_request_read",
          arguments: { requestId: owners.request.id },
        }),
      ),
    ).toContain("Request is unavailable");

    const triggers = new TriggerStore(database);
    const lineage = await triggers.create({
      ...scheduled(own, f.userId, "lineage-automation"),
      actorConnectionId: agent.id,
    });
    const owner = await triggers.create(scheduled(f.thread.id, f.userId, "owner-automation"));
    expect(
      await database
        .selectFrom("triggers")
        .select(["id", "originConnectionId"])
        .orderBy("createdAt")
        .execute(),
    ).toEqual([
      { id: lineage.trigger.id, originConnectionId: agent.id },
      { id: owner.trigger.id, originConnectionId: null },
    ]);
    const automations = await agent.client.callTool({
      name: "opensteer_automation_list",
      arguments: {},
    });
    expect(automations.isError, JSON.stringify(automations.content)).not.toBe(true);
    expect(
      (automations.structuredContent as { automations: { id: string }[] }).automations.map(
        ({ id }) => id,
      ),
    ).toEqual([lineage.trigger.id]);
    for (const [name, args] of [
      ["opensteer_automation_read", { automationId: owner.trigger.id }],
      ["opensteer_automation_control", { automationId: owner.trigger.id, action: "pause" }],
      [
        "opensteer_automation_update",
        {
          automationId: owner.trigger.id,
          expectedRevisionId: owner.revision.id,
          program: { ...program, source: "export default async () => 'replaced'" },
        },
      ],
    ] as const)
      expect(errorText(await agent.client.callTool({ name, arguments: args }))).toContain(
        "Automation not found",
      );
    expect(
      await database
        .selectFrom("triggers")
        .select("status")
        .where("id", "=", owner.trigger.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "active" });
  });

  it("carries an everything connection's input on an owner task through dequeue and Disconnect", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("everything-dequeue");
    const url = await serveMcp(storeFixture);
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
      grant: { scope: "everything" },
    });
    const task = await ownerTask(storeFixture, f, "dequeue");
    const sent = await send(agent, task, "everything-send");
    expect(sent.isError, JSON.stringify(sent.content)).not.toBe(true);
    // The queued Run was created from the input read through `thread_work_inputs`.
    const run = await queuedRun(storeFixture, task);
    expect(run).toMatchObject({ connectionId: agent.id, status: "queued" });
    expect(
      await storeFixture.store.admitExecution({
        ownerUserId: f.userId,
        subject: { kind: "binding", bindingId: `run:${run.id}` },
      }),
    ).toMatchObject({ mode: "full-access", agentConnection: { agentConnectionId: agent.id } });

    const host = commands(storeFixture, f.userId);
    await host.revoke(agent.id);
    expect(host.failures).toEqual([]);
    // A Run that never left the Home ends there, so the cleanup settles and the agent is Stopped.
    expect((await queuedRun(storeFixture, task)).status).toBe("interrupted");
    expect((await host.list()).find(({ id }) => id === agent.id)).toMatchObject({
      state: "stopped",
      lastActionUncertain: false,
    });
    await host.remove(agent.id);
    expect((await host.list()).map(({ id }) => id)).not.toContain(agent.id);
  });

  it("lets a connection send only into its own lineage, or the person's tasks with everything", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("send-lineage");
    const url = await serveMcp(storeFixture);
    const first = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
      grant: tasksOnly,
    });
    const everything = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
      grant: { scope: "everything" },
    });
    const firstTask = await createTask(first, f, "first-lineage");
    const owners = await ownerTask(storeFixture, f, "send-lineage");
    expect(errorText(await send(everything, firstTask, "into-first"))).toContain(
      "Task is unavailable",
    );
    expect(errorText(await send(first, owners, "into-owner"))).toContain("Task is unavailable");
    const allowed = await send(everything, owners, "into-owners");
    expect(allowed.isError, JSON.stringify(allowed.content)).not.toBe(true);
    // A task delegating stays inside its lineage: a different lineage is never reused.
    await expect(
      assertLineageCompatibleReuse(storeFixture.database, firstTask, owners),
    ).rejects.toThrow("Start a new task for this work");
  });

  it("runs lineage work at the minimum mode and only within its grant", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("grant-min-mode");
    const url = await serveMcp(storeFixture);
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "approval-required",
      grant: tasksOnly,
    });
    const own = await createTask(agent, f, "min-mode");
    const { database, store } = storeFixture;
    await database
      .updateTable("threads")
      .set({ accessMode: "full-access" })
      .where("id", "=", own)
      .execute();
    const run = await queuedRun(storeFixture, own);
    const binding = { kind: "binding", bindingId: `run:${run.id}` } as const;
    expect(await store.admitExecution({ ownerUserId: f.userId, subject: binding })).toMatchObject({
      mode: "approval-required",
      agentConnection: { agentConnectionId: agent.id },
    });
    const access = (
      grantTarget?: Parameters<OpensteerStore["resolveResourceAccess"]>[0]["grantTarget"],
    ) =>
      store
        .resolveResourceAccess({
          ownerUserId: f.userId,
          agentBindingId: `run:${run.id}`,
          explicitAccess: "read-write",
          ...(grantTarget ? { grantTarget } : {}),
        })
        .then(({ access }) => access);
    expect(await access()).toBeNull();
    expect(await access({ kind: "device" })).toBeNull();
    expect(
      await access({ kind: "browser-profile", profileId: createId("browserProfile") }),
    ).toBeNull();
    expect(
      await access({ kind: "plugin", target: { kind: "installed", pluginId: "gmail" } }),
    ).toBeNull();
    // An automation it made, and a child of its task, carry the same lineage and the same refusals.
    const made = await new TriggerStore(database).create({
      ...scheduled(own, f.userId, "lineage-made"),
      actorConnectionId: agent.id,
    });
    expect(made.trigger.id).toBeTruthy();
    expect(
      await database
        .selectFrom("triggers")
        .select("originConnectionId")
        .where("id", "=", made.trigger.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ originConnectionId: agent.id });
    const child = (
      await store.createThread({
        createdBy: f.userId,
        environmentId: f.environmentId,
        harnessInstanceId: f.harnessInstance.id,
        modelSelection: testModelSelection,
        idempotencyKey: "lineage-child",
        title: "Child",
        parentThreadId: own,
      })
    ).thread.id;
    expect(
      (await store.threadOrigins([child])).get(child),
      "a child task inherits its parent's lineage",
    ).toBe(agent.id);
    expect(
      (
        await store.resolveResourceAccess({
          ownerUserId: f.userId,
          agentBindingId: `thread:${child}`,
          explicitAccess: "read-write",
          grantTarget: { kind: "device" },
        })
      ).access,
    ).toBeNull();

    // The person's own Run resolves exactly as before: no connection, its own snapshot.
    const ownerRun = await store.admitExecution({
      ownerUserId: f.userId,
      subject: { kind: "binding", bindingId: `run:${f.run.id}` },
    });
    expect(ownerRun).toMatchObject({ agentConnection: null, mode: f.run.accessMode });
    expect(
      (
        await store.resolveResourceAccess({
          ownerUserId: f.userId,
          agentBindingId: `run:${f.run.id}`,
          explicitAccess: "read-write",
        })
      ).access,
    ).toBe("read-write");

    await commands(storeFixture, f.userId).revoke(agent.id);
    await expect(store.admitExecution({ ownerUserId: f.userId, subject: binding })).rejects.toThrow(
      "access ended",
    );
    // A new occurrence of its automation is refused; the person may still pause it.
    await expect(
      new TriggerStore(database).enqueueManual({
        actorThreadId: null,
        ownerId: f.userId,
        triggerId: made.trigger.id,
      }),
    ).rejects.toThrow("Automation execution authority is no longer active");
  });

  it("applies a narrowed grant through the update command: the live Run stops and the session retires", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("grant-narrow");
    const url = await serveMcp(storeFixture);
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
      grant: tasksOnly,
    });
    const own = await createTask(agent, f, "narrow");
    const run = await queuedRun(storeFixture, own);
    await startPersonalQueuedRunFixture(storeFixture.store, run.id);
    const host = commands(storeFixture, f.userId);
    const updated = await host.update(agent.id, {
      grant: { scope: "selected", tasks: false, resources: [] },
    });
    expect(updated).toMatchObject({ type: "connection.update", connection: { grantRevision: 2 } });
    await expect(host.update(agent.id, { label: "Stale" })).rejects.toMatchObject({
      code: "conflict",
      reason: "revision-changed",
    });
    expect(
      await storeFixture.database
        .selectFrom("commands")
        .select("type")
        .where("runId", "=", run.id)
        .where("type", "=", "run.interrupt")
        .execute(),
    ).toEqual([{ type: "run.interrupt" }]);
    // The open session advertised the old grant: its next request is served under the new one.
    expect((await agent.client.listTools()).tools).toEqual([]);
    await expect(
      storeFixture.store.admitExecution({
        ownerUserId: f.userId,
        subject: { kind: "binding", bindingId: `run:${run.id}` },
      }),
    ).rejects.toThrow("may no longer ask");
    // A task mutation under the connection's own fence is refused for the same reason.
    await expect(
      storeFixture.store.createThread({
        createdBy: f.userId,
        environmentId: f.environmentId,
        harnessInstanceId: f.harnessInstance.id,
        modelSelection: testModelSelection,
        idempotencyKey: "after-narrow",
        title: "After",
        authority: {
          kind: "connection",
          connectionId: agent.id,
          userId: f.userId,
          accessMode: "full-access",
        },
      }),
    ).rejects.toThrow("may no longer ask");
  });

  it("disconnects one agent's lineage and leaves the person's and a second agent's work running", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("disconnect");
    const url = await serveMcp(storeFixture);
    const { database, store } = storeFixture;
    const first = await connection(store, url, {
      userId: f.userId,
      accessMode: "full-access",
      grant: tasksOnly,
    });
    const second = await connection(store, url, {
      userId: f.userId,
      accessMode: "full-access",
      grant: tasksOnly,
    });
    const firstTask = await createTask(first, f, "first");
    const firstRun = await queuedRun(storeFixture, firstTask);
    await startPersonalQueuedRunFixture(store, firstRun.id);
    const queued = await send(first, firstTask, "queued");
    expect(queued.isError, JSON.stringify(queued.content)).not.toBe(true);
    const pendingInput = await database
      .selectFrom("threadInputs")
      .select(["messageId", "connectionId"])
      .where("threadId", "=", firstTask)
      .where("state", "=", "pending")
      .executeTakeFirstOrThrow();
    expect(pendingInput.connectionId).toBe(first.id);
    const asked = await store.requests.create({
      callId: "first-ask",
      kind: "browser.access",
      mode: "durable",
      originatingRunId: firstRun.id,
      originatingThreadId: firstTask,
      requestedBy: f.userId,
      requiredActor: "requester",
      payload: { kind: "browser.access", reason: "Choose", suggestion: { kind: "user_choice" } },
      presentation: {
        kind: "external",
        title: "Browser access",
        subject: { kind: "thread", id: firstTask },
      },
    });
    const automation = await new TriggerStore(database).create({
      ...scheduled(firstTask, f.userId, "first-automation"),
      actorConnectionId: first.id,
    });
    const secondTask = await createTask(second, f, "second");
    const secondRun = await queuedRun(storeFixture, secondTask);
    await startPersonalQueuedRunFixture(store, secondRun.id);

    const host = commands(storeFixture, f.userId);
    await host.revoke(first.id);
    expect(host.failures).toEqual([]);
    expect(
      await database
        .selectFrom("threadInputs")
        .select("state")
        .where("messageId", "=", pendingInput.messageId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "cancelled" });
    expect(await store.requests.get(asked.request.id)).toMatchObject({
      status: "cancelled",
      cancellationReason: "authority-revoked",
    });
    expect(
      await database
        .selectFrom("triggers")
        .select("status")
        .where("id", "=", automation.trigger.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "paused" });
    expect(
      await database
        .selectFrom("commands")
        .select("runId")
        .where("type", "=", "run.interrupt")
        .execute(),
    ).toEqual([{ runId: firstRun.id }]);
    await expect(
      first.client.callTool({ name: "opensteer_task_list", arguments: {} }),
    ).rejects.toThrow("Agent tools authorization is invalid or expired");
    // Its Run was handed off and has not confirmed it ended: Stopping, and not removable yet.
    expect((await host.list()).find(({ id }) => id === first.id)).toMatchObject({
      state: "stopping",
    });
    await expect(host.remove(first.id)).rejects.toMatchObject({ reason: "cleanup-outstanding" });
    expect(
      await database
        .selectFrom("agentConnections")
        .select(["cleanupReason", "cleanupCompletedAt"])
        .where("id", "=", first.id)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ cleanupReason: "revoked", cleanupCompletedAt: null });

    for (const id of [f.run.id, secondRun.id])
      expect(
        await database.selectFrom("runs").select("status").where("id", "=", id).executeTakeFirst(),
      ).toEqual({ status: "running" });
    const secondList = await second.client.callTool({ name: "opensteer_task_list", arguments: {} });
    expect(
      (secondList.structuredContent as { tasks: { id: string }[] }).tasks.map(({ id }) => id),
    ).toEqual([secondTask]);
    expect((await host.list()).find(({ id }) => id === second.id)).toMatchObject({
      state: "active",
    });
  });

  it("drives an expired connection through the same durable cleanup", async ({ storeFixture }) => {
    const f = await storeFixture.startRunFixture("expiry");
    const url = await serveMcp(storeFixture);
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
      grant: tasksOnly,
    });
    const own = await createTask(agent, f, "expiry");
    await storeFixture.database
      .updateTable("agentConnections")
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where("id", "=", agent.id)
      .execute();
    await commands(storeFixture, f.userId).effects.driveCleanups();
    expect(
      await storeFixture.database
        .selectFrom("agentConnections")
        .select(["cleanupReason", "cleanupCompletedAt"])
        .where("id", "=", agent.id)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ cleanupReason: "expired", cleanupCompletedAt: expect.any(Date) });
    expect((await queuedRun(storeFixture, own)).status).toBe("interrupted");
  });

  it("serializes Disconnect with an admitted send: it lands before and is stopped, or is refused", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("disconnect-race");
    const url = await serveMcp(storeFixture);
    const { database, store } = storeFixture;
    const agent = await connection(store, url, {
      userId: f.userId,
      accessMode: "full-access",
      grant: tasksOnly,
    });
    const own = await createTask(agent, f, "race");
    const run = await queuedRun(storeFixture, own);
    await startPersonalQueuedRunFixture(store, run.id);
    const host = commands(storeFixture, f.userId);
    const [sent] = await Promise.allSettled([send(agent, own, "race"), host.revoke(agent.id)]);
    expect(host.failures).toEqual([]);
    const refused =
      sent.status === "rejected" ||
      (sent.value.isError === true &&
        /invalid or expired|access ended/iu.test(errorText(sent.value)));
    const pending = await database
      .selectFrom("threadInputs")
      .select("state")
      .where("threadId", "=", own)
      .where("state", "in", ["pending", "awaiting-approval"])
      .execute();
    // Either the send was refused, or it landed first and the one revoke's cleanup cancelled it.
    expect({ refusedOrLandedAndStopped: refused || pending.length === 0, pending }).toEqual({
      refusedOrLandedAndStopped: true,
      pending: [],
    });
    expect(
      await database
        .selectFrom("commands")
        .select("runId")
        .where("type", "=", "run.interrupt")
        .execute(),
    ).toEqual([{ runId: run.id }]);
  });
});
