import { PluginAgentStore, TriggerStore } from "@opensteer/database";
import { assertEngineMayRun } from "@opensteer/harness";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginExecutions } from "../plugins/plugin-executions.js";
import { pluginCaller } from "../plugins/plugin-authority.js";
import type { RunCaller } from "./agent-caller.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  createBrowserSessionId,
  HarnessInstanceCatalogSchema,
  RunnerBootIdSchema,
  RunnerConnectionIdSchema,
  RunnerConnectionLeaseIdSchema,
} from "@opensteer/protocol";
import type { RunnerIdentity } from "@opensteer/orchestration";
import { WatchService, type WatchServiceOptions } from "../triggers/watch-service.js";
import {
  createId,
  runTerminationUnprovenCode,
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
  beginAgentSession,
  commandAdmission,
  commandSubject,
  type OpensteerStore,
} from "@opensteer/database";
import {
  describeStore,
  testContinuationIdentity,
  testModelSelection,
  testReadyHarnessCatalog,
  pendingEvent,
} from "@opensteer/database/test-support/store";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { expect, vi } from "vitest";
import { writeAgentHomeSettings } from "@opensteer/database/test-support/personal";
import { startPersonalQueuedRunFixture } from "@opensteer/database/test-support/personal-run";
import { readableTabTasks } from "../tabs/tab-authority.js";
import { connectionCredentialPrefix } from "./connections/connection-authenticator.js";
import { mcpResourceMetadataPath } from "./connections/connection-oauth.js";
import {
  clients,
  commands,
  connection,
  createTask,
  errorText,
  expectUnknownTool,
  fixtureRunScope,
  runClient,
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
    // Consented on the grant screen, as every connection now does; one that consented before
    // direct work is listed none of it (connection-contract, B5).
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
      grant: { scope: "everything" },
    });
    const listed = (await agent.client.listTools()).tools.map(({ name }) => name);
    expect(listed.toSorted()).toEqual([
      "ask_person",
      "browser_connect",
      "browser_use",
      "card_request",
      "computer_use",
      "discover",
      "opensteer_command",
      "opensteer_commands",
      "opensteer_state",
      "opensteer_task_create",
      "opensteer_task_interrupt",
      "opensteer_task_read",
      "opensteer_task_send",
      "opensteer_task_wait",
      "plugin_call",
      "plugin_execute",
      "plugin_resume",
      "saved_login_request",
    ]);
    await expectUnknownTool(agent.client, "opensteer_task_update");

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

  it("discovers all native tasks with Everything and only its own native lineage when selected", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("discovery-task-lineage");
    const url = await serveMcp(storeFixture);
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
    });
    const selected = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
      grant: { scope: "selected", tasks: true, resources: [] },
    });
    const own = await createTask(agent, f, "discover-own");
    const theirs = await createTask(selected, f, "discover-other");
    const direct = await beginAgentSession(storeFixture.database, {
      userId: f.userId,
      agentConnectionId: selected.id,
    });
    const ids = async (client: Client) => {
      const result = await client.callTool({ name: "discover", arguments: {} });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      return (result.structuredContent as { items: { id: string; kind: string }[] }).items
        .filter(({ kind }) => kind === "task")
        .map(({ id }) => id);
    };
    expect(await ids(agent.client)).toEqual([theirs, own, f.threadId]);
    expect(await ids(selected.client)).toEqual([theirs]);
    const read = async (id: string) =>
      agent.client.callTool({ name: "discover", arguments: { id } });
    expect((await read(theirs)).structuredContent).toMatchObject({ item: { id: theirs } });
    expect(await read(direct.session.threadId)).toEqual(await read(createId("thread")));
  });

  it("refuses with Everything any change to another connected agent's task, the same way whatever its state or mode", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("other-agent-task");
    const url = await serveMcp(storeFixture);
    const bold = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
      grant: { scope: "everything" },
    });
    const cautious = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "approval-required",
      grant: { scope: "everything" },
    });
    const other = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
      grant: { scope: "selected", tasks: true, resources: [] },
    });
    const theirs = await createTask(other, f, "theirs");
    // It can read it: Everything reads every task, so nothing about it is hidden.
    const read = await bold.client.callTool({ name: "discover", arguments: { id: theirs } });
    expect(read.structuredContent).toMatchObject({ item: { id: theirs } });
    // A change is refused before its state (idle) or its mode (stronger than Supervised) is
    // looked at, in the same body for every caller and every write tool.
    const interrupt = (agent: typeof bold) =>
      agent.client.callTool({ name: "opensteer_task_interrupt", arguments: { taskId: theirs } });
    const steer = (agent: typeof bold) =>
      agent.client.callTool({
        name: "opensteer_task_send",
        arguments: { taskId: theirs, message: "More", delivery: "steer", operationKey: "steer" },
      });
    const idle = await interrupt(bold);
    expect(idle.isError).toBe(true);
    expect(await interrupt(cautious)).toEqual(idle);
    expect(await steer(bold)).toEqual(idle);
    expect(await steer(cautious)).toEqual(idle);
    expect(JSON.stringify(idle)).not.toContain("access mode");
  });

  it("shows a disconnected agent no task in a tab's users, not even its own task's", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("tab-users-ended");
    const url = await serveMcp(storeFixture);
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
      grant: { scope: "selected", tasks: true, resources: [] },
    });
    const own = await createTask(agent, f, "tab-users-own");
    const actor = {
      kind: "connection",
      caller: { connectionId: agent.id, userId: f.userId },
    } as never;
    expect(await readableTabTasks(actor, [own, f.threadId], storeFixture.database)).toEqual(
      new Set([own]),
    );
    await agent.revoke();
    expect(await readableTabTasks(actor, [own, f.threadId], storeFixture.database)).toEqual(
      new Set(),
    );
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
    const sent = await send(cautious, fullAccess.id, "queue-capped-work");
    expect(sent.isError, JSON.stringify(sent.content)).not.toBe(true);
    const queued = await queuedRun(storeFixture, fullAccess.id);
    expect(
      await storeFixture.store.admitExecution({
        ownerUserId: f.userId,
        subject: { kind: "binding", bindingId: `run:${queued.id}` },
      }),
    ).toMatchObject({
      mode: "approval-required",
      agentConnection: { agentConnectionId: cautious.id },
    });
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
    expect(JSON.stringify(result)).not.toContain("originConnectionId");
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
    expect(JSON.stringify(result)).not.toContain("pendingRequests");
    // A repeat reads the task again; the count it now has never reaches the connection.
    await storeFixture.database
      .updateTable("threads")
      .set({ pendingRequestCount: 2 })
      .where("id", "=", threadId)
      .execute();
    const replay = await agent.client.callTool({
      name: "opensteer_task_create",
      arguments: {
        title: "External work",
        message: "Inspect the project",
        operationKey: "external-create",
      },
    });
    expect(replay.structuredContent).toEqual(result.structuredContent);
    expect(JSON.stringify(replay)).not.toContain("pendingRequests");
    const conflicting = await agent.client.callTool({
      name: "opensteer_task_create",
      arguments: {
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
    // The connection stopped it, not the person, so its end is still news to them.
    expect(
      await storeFixture.database
        .selectFrom("commands")
        .select("authoritySource")
        .where("threadId", "=", threadId)
        .where("type", "=", "run.interrupt")
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ authoritySource: { kind: "connection" } });
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
    const url = await serveMcp(storeFixture, { runScope: fixtureRunScope(f) });
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "approval-required",
      grant: { scope: "selected", tasks: true, resources: [] },
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
    await expectUnknownTool(agent.client, "opensteer_ai_account_list");
    const native = await runClient(url);
    const accounts = await native.callTool({ name: "opensteer_ai_account_list", arguments: {} });
    expect(accounts.isError, JSON.stringify(accounts.content)).not.toBe(true);
    expect(JSON.stringify(accounts.structuredContent)).toContain(second.id);
    expect(f.harnessInstance.isDefault).toBe(true);
    await exclude(f.harnessInstance.id, second.id);
    expect(errorText(await call("all-excluded"))).toContain("No default AI account is available");
    await exclude(f.harnessInstance.id);
    const started = await call("default-excluded");
    expect(started.isError, JSON.stringify(started.content)).not.toBe(true);
    const threadId = ThreadIdSchema.parse((started.structuredContent as { taskId: string }).taskId);
    expect(await storeFixture.store.getThreadForOwner(threadId, f.userId)).toMatchObject({
      harnessInstanceId: second.id,
    });
  });

  it("explains both taskId crossings in its own lineage and hides a foreign direct task", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("connection-task-kinds");
    const url = await serveMcp(storeFixture);
    const makeAgent = () =>
      connection(storeFixture.store, url, {
        userId: f.userId,
        accessMode: "full-access",
        grant: {
          scope: "selected",
          tasks: true,
          resources: [{ kind: "browser-profile", profileId: createId("browserProfile") }],
        },
      });
    const [agent, foreign] = await Promise.all([makeAgent(), makeAgent()]);
    const startDirect = async (agentConnectionId: typeof agent.id) =>
      (await beginAgentSession(storeFixture.database, { userId: f.userId, agentConnectionId }))
        .session.threadId;
    const direct = await startDirect(agent.id);
    const other = await startDirect(foreign.id);
    const native = await createTask(agent, f, "person-agent-work");
    expect(
      errorText(await agent.client.callTool({ name: "discover", arguments: { taskId: native } })),
    ).toContain("Pass a direct-work taskId");
    expect(errorText(await send(agent, direct, "send-to-direct"))).toContain(
      "Pass a taskId for work run by one of the person's agents",
    );
    expect((await send(agent, other, "send-to-foreign")).structuredContent).toEqual(
      (await send(agent, createId("thread"), "send-to-missing")).structuredContent,
    );
  });

  it("does not let a connection use the removed inspection and update tools", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("connection-read-write");
    const toolErrors: unknown[] = [];
    const url = await serveMcp(storeFixture, {
      runScope: fixtureRunScope(f),
      onToolError: (error, name) => toolErrors.push(`${name}: ${String(error)}`),
    });
    const native = await runClient(url);
    const target = await ownerTask(storeFixture, f, "inspect-update");
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
      await expectUnknownTool(agent.client, name);
      const result = await native.callTool({ name, arguments: {} });
      expect(result.isError, `${name}: ${toolErrors.join("\n")}`).not.toBe(true);
    }
    for (const arguments_ of [{ title: "Renamed" }, { done: true }, { done: false }])
      await expectUnknownTool(agent.client, "opensteer_task_update", {
        taskId: f.thread.id,
        ...arguments_,
      });
    expect(await storeFixture.store.getThreadForOwner(f.thread.id, f.userId)).toMatchObject({
      title: f.thread.title,
      doneAt: null,
    });
    for (const arguments_ of [{ title: "Renamed" }, { done: true }, { done: false }]) {
      const result = await native.callTool({
        name: "opensteer_task_update",
        arguments: { taskId: target, ...arguments_ },
      });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      expect(await storeFixture.store.getThreadForOwner(target, f.userId)).toMatchObject({
        title: "Renamed",
        doneAt: arguments_.done === true ? expect.any(String) : null,
      });
    }
  });

  it("keeps model configuration unavailable while enforcing the connection ceiling for interrupt", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.createRunFixture("configure-connection");
    const source = await storeFixture.startRunFixture("configure-from-run");
    const url = await serveMcp(storeFixture, { runScope: fixtureRunScope(source) });
    const native = await runClient(url);
    const configure = (modelSelection: unknown) =>
      native.callTool({
        name: "opensteer_task_configure",
        arguments: { taskId: f.threadId, modelSelection },
      });
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
    });
    const unavailableModel = { providerId: "openai", modelId: "not-offered", options: {} };
    await expectUnknownTool(agent.client, "opensteer_task_configure", {
      taskId: f.thread.id,
      modelSelection: unavailableModel,
    });
    expect(errorText(await configure(unavailableModel))).toBe(
      "The selected model is not available in this AI engine on this Runner",
    );
    const configured = await configure(testModelSelection);
    expect(configured.isError, JSON.stringify(configured.content)).not.toBe(true);
    expect(configured.structuredContent).toMatchObject({
      taskId: f.threadId,
      aiAccountId: f.harnessInstance.id,
      modelSelection: testModelSelection,
    });
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
    await expectUnknownTool(agent.client, "opensteer_task_configure", {
      taskId: f.thread.id,
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
    await storeFixture.store.updateThreadAccessMode({
      threadId: source.threadId,
      requestedBy: f.userId,
      accessMode: "approval-required",
    });
    expect(errorText(await configure(testModelSelection))).toContain("stronger access mode");
    const cautious = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "approval-required",
    });
    await expectUnknownTool(cautious.client, "opensteer_task_configure", {
      taskId: f.thread.id,
      modelSelection: testModelSelection,
    });
    expect(
      errorText(
        await cautious.client.callTool({
          name: "opensteer_task_interrupt",
          arguments: { taskId: f.thread.id },
        }),
      ),
    ).toContain("stronger access mode");
  });

  it("lets a Run reorder, cancel and steer only its own queued messages", async ({
    storeFixture,
  }) => {
    const a = await storeFixture.startRunFixture("queue-a");
    const b = await storeFixture.startRunFixture("queue-b");
    // The caller sorts after the target. Move and cancel must lock both in ID order.
    const [target, first] = a.runId < b.runId ? [a, b] : [b, a];
    const second = await storeFixture.startRunFixture("queue-second");
    const url = await serveMcp(storeFixture, {
      runScopes: {
        first: fixtureRunScope(first),
        second: fixtureRunScope(second),
      },
    });
    const [native, other] = await Promise.all([runClient(url, "first"), runClient(url, "second")]);
    const agent = await connection(storeFixture.store, url, {
      userId: target.userId,
      accessMode: "full-access",
    });
    const sendNative = async (message: string) => {
      const result = await native.callTool({
        name: "opensteer_task_send",
        arguments: {
          taskId: target.threadId,
          delivery: "queue",
          message,
        },
      });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      return (result.structuredContent as { messageId: string }).messageId;
    };
    const callQueue = (client: Client, action: string, args = {}) =>
      client.callTool({
        name: "opensteer_task_queue",
        arguments: { taskId: target.threadId, action, ...args },
      });
    const firstId = await sendNative("First");
    const secondId = await sendNative("Second");
    expect(errorText(await callQueue(other, "cancel", { messageId: firstId }))).toBe(
      "Only your own queued messages can be cancelled",
    );
    expect(
      (await callQueue(native, "move", { messageId: secondId, beforeMessageId: firstId }))
        .structuredContent,
    ).toMatchObject({
      items: [
        {
          messageId: secondId,
          preview: "Second",
          truncated: false,
          author: { kind: "agent", taskId: first.threadId, runId: first.runId },
        },
        { messageId: firstId, preview: "First", truncated: false },
      ],
    });
    expect(
      (await callQueue(native, "cancel", { messageId: firstId })).structuredContent,
    ).toMatchObject({ items: [{ messageId: secondId }] });
    expect(
      (await callQueue(native, "steer", { messageId: secondId, expectedRunId: target.runId }))
        .structuredContent,
    ).toMatchObject({ items: [] });
    const long = await sendNative("x".repeat(1_000));
    expect((await callQueue(native, "list")).structuredContent).toMatchObject({
      items: [{ messageId: long, preview: "x".repeat(500), truncated: true }],
    });
    const connected = await send(agent, target.threadId, "external-queue-input");
    expect(connected.isError).not.toBe(true);
    const externalId = (connected.structuredContent as { messageId: string }).messageId;
    expect((await callQueue(native, "list")).structuredContent).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          messageId: externalId,
          author: { kind: "connection", connectionId: agent.id, displayName: "Test agent" },
          canCancel: false,
        }),
      ]),
    });
    expect(errorText(await callQueue(native, "cancel", { messageId: externalId }))).toBe(
      "Only your own queued messages can be cancelled",
    );
  });

  it("keeps a paused queue paused when a connection sends work, until the person resumes it", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("connection-queue");
    const { store } = storeFixture;
    const url = await serveMcp(storeFixture);
    const agent = await connection(store, url, {
      userId: f.userId,
      accessMode: "full-access",
    });
    const task = { taskId: f.thread.id };
    const stopped = await agent.client.callTool({
      name: "opensteer_task_interrupt",
      arguments: task,
    });
    expect(stopped.isError, JSON.stringify(stopped.content)).not.toBe(true);
    expect(stopped.structuredContent).toMatchObject({ interruptedRunId: f.run.id });
    const queue = () =>
      store.getThreadInputQueue({
        threadId: f.thread.id,
        requestedBy: f.userId,
      });
    expect(await queue()).toMatchObject({ paused: true });
    await expectUnknownTool(agent.client, "opensteer_task_resume", task);
    await expectUnknownTool(agent.client, "opensteer_task_queue", { ...task, action: "resume" });
    const sent = await send(agent, f.thread.id, "wait-while-paused");
    expect(sent.isError).not.toBe(true);
    expect(sent.structuredContent).toMatchObject({ disposition: "pending", runId: null });
    expect(await queue()).toMatchObject({
      paused: true,
      items: [
        {
          message: {
            id: (sent.structuredContent as { messageId: string }).messageId,
            author: { kind: "connection", connectionId: agent.id },
          },
        },
      ],
    });
    const report = await agent.client.callTool({
      name: "opensteer_task_send",
      arguments: {
        ...task,
        delivery: "report",
        message: "A report while paused",
      },
    });
    expect(report.isError, JSON.stringify(report.content)).not.toBe(true);
    expect(report.structuredContent).toMatchObject({ runId: null });
    const steer = await agent.client.callTool({
      name: "opensteer_task_send",
      arguments: {
        ...task,
        delivery: "steer",
        message: "A steer while paused",
      },
    });
    // The interrupt ended the turn, and steering never starts one while the queue waits.
    expect(steer).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "conflict",
          message: "Steer requires a compatible running turn. Use Queue to start a new turn.",
        },
      },
    });
    expect(await queue()).toMatchObject({ paused: true });
    const interrupted = await storeFixture.database
      .selectFrom("runs")
      .select("id")
      .where("threadId", "=", f.threadId)
      .execute();
    expect(interrupted).toEqual([{ id: f.runId }]);
    const created = await createTask(agent, f, "person-paused-task");
    const pendingRun = await queuedRun(storeFixture, created);
    await store.enqueueRunnerControl({
      type: "run.interrupt",
      requestedBy: f.userId,
      threadId: created,
      runId: pendingRun.id,
      idempotencyKey: "person-pauses-created-task",
    });
    const newTaskQueue = () =>
      store.getThreadInputQueue({ threadId: created, requestedBy: f.userId });
    expect(await newTaskQueue()).toMatchObject({ paused: true });
    expect(await createTask(agent, f, "person-paused-task")).toBe(created);
    expect(await newTaskQueue()).toMatchObject({ paused: true });
    expect(
      await storeFixture.database
        .selectFrom("runs")
        .select("id")
        .where("threadId", "=", created)
        .execute(),
    ).toEqual([{ id: pendingRun.id }]);
    const separate = await createTask(agent, f, "new-task-with-other-queue-paused");
    expect((await queuedRun(storeFixture, separate)).status).toBe("queued");
    expect(created).not.toBe(f.threadId);
    expect(await queue()).toMatchObject({ paused: true });
    await store.resumeThreadInputQueue({
      threadId: f.thread.id,
      requestedBy: f.userId,
      idempotencyKey: "person-resumes",
    });
    expect(await queue()).toMatchObject({ paused: false });
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
      // An agent's Stop is recorded as the agent's, never as its person's.
      expect(
        await storeFixture.database
          .selectFrom("commands")
          .select("authoritySource")
          .where("runId", "=", f.run.id)
          .where("type", "=", "run.interrupt")
          .executeTakeFirstOrThrow(),
      ).toMatchObject({ authoritySource: { kind: "thread-agent", runId: f.run.id } });
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
  it("requires explicit person authority instead of accepting an empty resource scope", async ({
    storeFixture,
  }) => {
    const { userId } = await storeFixture.startRunFixture("explicit-person-authority");
    const input = { ownerUserId: userId, explicitAccess: "read-write" } as const;
    const { store } = storeFixture;
    // @ts-expect-error An empty authority scope must also be rejected by the type.
    await expect(store.resolveResourceAccess(input)).rejects.toMatchObject({ code: "forbidden" });
    await expect(store.resolveResourceAccess({ ...input, kind: "person" })).resolves.toMatchObject({
      execution: { actor: "person" },
      access: "read-write",
    });
  });

  const tasksOnly: AgentGrant = { scope: "selected", tasks: true, resources: [] };
  const script = {
    interpreter: null,
    text: "console.log('ok')",
  } as const;
  function scheduled(anchor: import("@opensteer/core").ThreadId, userId: UserId, key: string) {
    return {
      actorThreadId: null,
      anchorThreadId: anchor,
      createdBy: userId,
      idempotencyKey: key,
      name: `Automation ${key}`,
      script,
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
    // No task tool; the Home's command tools, cut to what the grant holds, are not task tools.
    expect(
      listed.filter(
        (name) =>
          name.startsWith("opensteer_") &&
          !["opensteer_commands", "opensteer_command", "opensteer_state"].includes(name),
      ),
    ).toEqual([]);
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
      accessMode: "full-access",
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

    const listed = await agent.client.callTool({ name: "discover", arguments: {} });
    expect(listed.isError, JSON.stringify(listed.content)).not.toBe(true);
    expect(
      (listed.structuredContent as { items: { id: string }[] }).items.map(({ id }) => id),
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
    const active = await startPersonalQueuedRunFixture(store, ownRun.id);
    const owned = await request(own, ownRun.id, "lineage");
    const owners = await request(f.thread.id, f.run.id, "owner");
    const pending = await agent.client.callTool({
      name: "opensteer_task_wait",
      arguments: { taskId: own },
    });
    expect(pending.isError, JSON.stringify(pending.content)).not.toBe(true);
    expect(pending.structuredContent).toMatchObject({ pendingRequest: { id: owned.request.id } });
    expect(JSON.stringify(pending)).not.toContain(owners.request.id);
    await expectUnknownTool(agent.client, "opensteer_request_list");
    await expectUnknownTool(agent.client, "opensteer_request_read", {
      requestId: owners.request.id,
    });

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
    await expectUnknownTool(agent.client, "opensteer_automation_list");
    const scopedRun = await runClient(
      await serveMcp(storeFixture, {
        runScope: fixtureRunScope({ ...f, ...active, threadId: own }),
      }),
    );
    const list = await scopedRun.callTool({ name: "opensteer_automation_list", arguments: {} });
    expect(list.isError, JSON.stringify(list.content)).not.toBe(true);
    expect(
      (list.structuredContent as { automations: { id: string }[] }).automations.map(({ id }) => id),
    ).toEqual([lineage.trigger.id]);
    const requestIds = await scopedRun.callTool({ name: "opensteer_request_list", arguments: {} });
    expect(requestIds.isError, JSON.stringify(requestIds.content)).not.toBe(true);
    expect(
      (requestIds.structuredContent as { requests: { id: string }[] }).requests.map(({ id }) => id),
    ).toEqual([owned.request.id]);
    for (const [name, args] of [
      ["opensteer_automation_read", { automationId: owner.trigger.id }],
      ["opensteer_automation_control", { automationId: owner.trigger.id, action: "pause" }],
      [
        "opensteer_automation_update",
        {
          automationId: owner.trigger.id,
          expectedRevisionId: owner.revision.id,
          script: { ...script, text: "console.log('replaced')" },
        },
      ],
    ] as const)
      await expectUnknownTool(agent.client, name, args);
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
    await storeFixture.database
      .updateTable("agentConnections")
      .set({ cleanupCompletedAt: null })
      .where("id", "=", agent.id)
      .execute();
    expect((await host.list()).find(({ id }) => id === agent.id)?.state).toBe("stopped");
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

  it("includes a human report in the dispatched batch of its connected task", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("lineage-report");
    const { database, store } = storeFixture;
    const agent = await connection(store, await serveMcp(storeFixture), {
      userId: f.userId,
      accessMode: "full-access",
      grant: tasksOnly,
    });
    const task = await createTask(agent, f, "lineage-report");
    const report = await store.enqueueThreadInput({
      requestedBy: f.userId,
      threadId: task,
      idempotencyKey: "owner-lineage-report",
      source: { kind: "human" },
      policy: "report",
      content: [{ type: "text", text: "Owner report" }],
    });
    const run = await queuedRun(storeFixture, task);
    const command = await database
      .selectFrom("commands")
      .select("id")
      .where("runId", "=", run.id)
      .where("type", "=", "run.execute")
      .executeTakeFirstOrThrow();
    await store.claimCommand(command.id, "lineage-report");
    const context = await store.loadRunDispatchContext(command.id);
    expect(context.reports.messages.map(({ id }) => id)).toEqual([report.message.id]);
  });

  it("rotates off the owner's provider session on an everything seed and fails the queued seed if access ends", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("lineage-provider-session");
    const { database, store } = storeFixture;
    const agent = await connection(store, await serveMcp(storeFixture), {
      userId: f.userId,
      accessMode: "full-access",
    });
    const task = await ownerTask(storeFixture, f, "lineage-provider-session");
    const read = () =>
      database
        .selectFrom("runs")
        .select(["id", "providerSessionId", "status"])
        .where("threadId", "=", task)
        .orderBy("runOrdinal")
        .execute();
    const session = await database
      .selectFrom("providerSessions")
      .select("id")
      .where("threadId", "=", task)
      .where("active", "=", true)
      .executeTakeFirstOrThrow();
    expect((await send(agent, task, "join-owner-session")).isError).not.toBe(true);
    const [reserved] = await read();
    expect(reserved?.status).toBe("queued");
    // A connected agent's Run never resumes a provider session created under the
    // person's own configuration (`person_lineage = true`).
    expect(reserved?.providerSessionId).not.toBe(session.id);
    const rotated = await database
      .selectFrom("providerSessions")
      .select(["id", "personalContext", "personLineage"])
      .where("id", "=", reserved!.providerSessionId!)
      .executeTakeFirstOrThrow();
    expect(rotated).toEqual({
      id: reserved!.providerSessionId,
      personalContext: true,
      personLineage: false,
    });
    const command = await database
      .selectFrom("commands")
      .select("id")
      .where("runId", "=", reserved!.id)
      .where("type", "=", "run.execute")
      .executeTakeFirstOrThrow();
    await new AgentConnectionStore(database).update(f.userId, {
      connectionId: agent.id,
      expectedRevision: 1,
      grant: tasksOnly,
    });
    expect(await store.claimCommand(command.id, "lineage-provider-session")).toMatchObject({
      terminalFailureInput: "seed-input",
      terminalFailure: "The connected agent's access ended before this work could be delivered.",
    });
    expect((await read())[0]?.status).toBe("queued");
  });

  it("refuses binding the owner's provider session when a queued connection narrows after claim", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("provider-bind-narrowing");
    const { database, store } = storeFixture;
    const agent = await connection(store, await serveMcp(storeFixture), {
      userId: f.userId,
      accessMode: "full-access",
    });
    const task = await ownerTask(storeFixture, f, "provider-bind-narrowing");
    expect((await send(agent, task, "provider-bind-narrowing")).isError).not.toBe(true);
    const run = await queuedRun(storeFixture, task);
    const command = await database
      .selectFrom("commands")
      .select("id")
      .where("runId", "=", run.id)
      .where("type", "=", "run.execute")
      .executeTakeFirstOrThrow();
    expect(await store.claimCommand(command.id, "provider-bind-narrowing")).not.toHaveProperty(
      "terminalFailure",
    );
    await new AgentConnectionStore(database).update(f.userId, {
      connectionId: agent.id,
      expectedRevision: 1,
      grant: tasksOnly,
    });
    await expect(
      store.acquireExecutionBinding({
        bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
        continuationIdentity: testContinuationIdentity,
        harnessInstanceId: f.harnessInstance.id,
        leaseTokenHash: crypto.randomUUID(),
        runnerBootId: "fixture-boot",
        runnerId: f.runnerId,
        runId: run.id,
        threadId: task,
      }),
    ).rejects.toMatchObject({ code: "forbidden", message: "Task is unavailable" });
    expect(
      await database
        .selectFrom("runs")
        .select("bindingGeneration")
        .where("id", "=", run.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ bindingGeneration: null });
  });

  it("runs lineage work at the minimum mode and only within its grant", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("grant-min-mode");
    const url = await serveMcp(storeFixture);
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
      grant: tasksOnly,
    });
    const own = await createTask(agent, f, "min-mode");
    const { database, store } = storeFixture;
    const triggers = new TriggerStore(database);
    const made = await triggers.create({
      ...scheduled(own, f.userId, "lineage-made"),
      actorConnectionId: agent.id,
    });
    await new AgentConnectionStore(database).update(f.userId, {
      connectionId: agent.id,
      expectedRevision: 1,
      accessMode: "approval-required",
    });
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
    const afterLowering = scheduled(own, f.userId, "lineage-made-after-lowering");
    await expect(
      triggers.create({
        ...afterLowering,
        actorConnectionId: agent.id,
        commandIdentity: commandAdmission({
          ownerUserId: f.userId,
          subject: commandSubject(`connection:${agent.id}`),
          command: {
            type: "trigger.create",
            idempotencyKey: afterLowering.idempotencyKey,
            input: {
              anchorThreadId: afterLowering.anchorThreadId,
              name: afterLowering.name,
              script: afterLowering.script,
              source: afterLowering.source,
            },
          },
        }),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
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
    await expect(
      store.admitExecution({ ownerUserId: f.userId, subject: binding }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
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
      grant: { scope: "everything" },
    });
    const second = await connection(store, url, {
      userId: f.userId,
      accessMode: "full-access",
      grant: tasksOnly,
    });
    const firstTask = await createTask(first, f, "first");
    const firstRun = await queuedRun(storeFixture, firstTask);
    const execution = await startPersonalQueuedRunFixture(store, firstRun.id);
    const runAttempt = await database
      .selectFrom("runAttempts")
      .select("id")
      .where("runId", "=", firstRun.id)
      .where("bindingGeneration", "=", execution.bindingGeneration)
      .executeTakeFirstOrThrow();
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
      ...scheduled(f.thread.id, f.userId, "first-automation"),
      actorConnectionId: first.id,
    });
    const triggers = new TriggerStore(database);
    const occurrence = await triggers.enqueueManual({
      actorThreadId: null,
      ownerId: f.userId,
      triggerId: automation.trigger.id,
    });
    await store.claimCommand(occurrence.commandId, "cleanup-occurrence");
    const runner = { runnerId: f.runnerId, runnerBootId: execution.runnerBootId };
    const dispatched = await triggers.startExecution({
      ...runner,
      commandId: occurrence.commandId,
    });
    const programRequest = await store.requests.create({
      callId: "occurrence-ask",
      kind: "browser.access",
      mode: "durable",
      originatingOccurrenceId: occurrence.id,
      originatingThreadId: f.thread.id,
      requestedBy: f.userId,
      requiredActor: "requester",
      payload: { kind: "browser.access", reason: "Choose", suggestion: { kind: "user_choice" } },
      presentation: {
        kind: "external",
        title: "Program browser access",
        subject: { kind: "thread", id: f.thread.id },
      },
    });
    const watch = await triggers.create({
      ...scheduled(firstTask, f.userId, "first-watch"),
      actorConnectionId: first.id,
      source: { kind: "watch" },
    });
    const snapshot = await triggers.reconcileWatchesForRunner({
      ...runner,
      environmentId: f.environmentId,
      runnerConnectionGeneration: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const activation = snapshot.activations.find(
      ({ activation }) => activation.triggerId === watch.trigger.id,
    )!.activation;
    expect(activation.observed).toBe("starting");
    const secondTask = await createTask(second, f, "second");
    const secondRun = await queuedRun(storeFixture, secondTask);
    await startPersonalQueuedRunFixture(store, secondRun.id);

    const browserSessionId = createBrowserSessionId();
    await store.createBrowserSession({
      id: browserSessionId,
      runnerId: runner.runnerId,
      profileId: null,
      origin: "agent",
      ownerId: f.userId,
      runtimeId: "browser",
      placementKey: `runner:${runner.runnerId}`,
    });
    await store.transitionBrowserSession({ sessionId: browserSessionId, state: "ready" });
    const cdp = store.connectionCdpAttempts();
    const attachmentId = "disconnect-standard-cdp";
    await cdp.open(browserSessionId, attachmentId, {
      connectionId: first.id,
      grantRevision: 1,
      mode: "full-access",
      threadId: firstTask,
    });
    const stopEntered = Promise.withResolvers<void>();
    const releaseStop = Promise.withResolvers<void>();
    const stopped: string[] = [];
    const host = commands(storeFixture, f.userId, {
      stopper: {
        async stop(attempt) {
          stopped.push(attempt.id);
          if (attempt.id === attachmentId) await cdp.lost(browserSessionId, attachmentId);
          if (attempt.id === occurrence.id) {
            stopEntered.resolve();
            await releaseStop.promise;
          }
        },
      },
    });
    const revoked = host.revoke(first.id);
    await Promise.race([
      stopEntered.promise,
      revoked.then(() => {
        throw new Error("The cleanup pass returned before asking the occurrence to stop");
      }),
    ]);
    try {
      await host.effects.driveCleanups();
      expect(stopped).toEqual([occurrence.id]);
      await expect(host.remove(first.id)).rejects.toMatchObject({ reason: "cleanup-outstanding" });
    } finally {
      releaseStop.resolve();
      await revoked;
    }
    expect(stopped).toEqual([occurrence.id, runAttempt.id, attachmentId, activation.id]);
    expect(host.failures).toEqual([]);
    expect(
      await database
        .selectFrom("threadInputs")
        .select("state")
        .where("messageId", "=", pendingInput.messageId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "cancelled" });
    expect(await store.requests.get(programRequest.request.id)).toMatchObject({
      status: "cancelled",
      cancellationReason: "authority-revoked",
    });
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
    await expect(first.client.callTool({ name: "discover", arguments: {} })).rejects.toThrow(
      "Agent tools authorization is invalid or expired",
    );
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
    const secondList = await second.client.callTool({ name: "discover", arguments: {} });
    expect(
      (secondList.structuredContent as { items: { id: string }[] }).items.map(({ id }) => id),
    ).toEqual([secondTask]);
    expect((await host.list()).find(({ id }) => id === second.id)).toMatchObject({
      state: "active",
    });
    const status = () =>
      database
        .selectFrom("triggerWatchActivations")
        .select(["desired", "observed", "terminalEvidenceAt"])
        .where("id", "=", activation.id)
        .executeTakeFirstOrThrow();
    expect(await status()).toMatchObject({
      desired: "stopped",
      observed: "starting",
      terminalEvidenceAt: null,
    });
    await store.commitRunnerEvent({
      ...runner,
      environmentId: f.environmentId,
      event: pendingEvent({
        type: "run.failed",
        runId: firstRun.id,
        threadId: firstTask,
        ordinal: 1,
        bindingGeneration: execution.bindingGeneration,
        environmentId: f.environmentId,
        data: {
          status: "failed",
          code: runTerminationUnprovenCode,
          message: "Containment unverified",
          retryable: false,
        },
      }),
    });
    expect(
      await database
        .selectFrom("runAttempts")
        .select("terminalEvidenceAt")
        .where("runId", "=", firstRun.id)
        .where("bindingGeneration", "=", execution.bindingGeneration)
        .executeTakeFirstOrThrow(),
    ).toEqual({ terminalEvidenceAt: null });
    await store.commitRunnerEvent({
      ...runner,
      verifiedContainment: false,
      environmentId: f.environmentId,
      event: pendingEvent({
        type: "run.interrupted",
        runId: firstRun.id,
        threadId: firstTask,
        ordinal: 2,
        bindingGeneration: execution.bindingGeneration,
        environmentId: f.environmentId,
        data: { status: "interrupted" },
      }),
    });
    expect(
      await database
        .selectFrom("runAttempts")
        .select(["terminalEvidenceAt", "contactLostAt"])
        .where("runId", "=", firstRun.id)
        .where("bindingGeneration", "=", execution.bindingGeneration)
        .executeTakeFirstOrThrow(),
    ).toEqual({ terminalEvidenceAt: expect.any(Date), contactLostAt: expect.any(Date) });
    const occurrenceReceipt = {
      ...runner,
      executionGeneration: dispatched.executionGeneration,
      output: {
        completedAt: new Date().toISOString(),
        error: null,
        exitCode: null,
        occurrenceId: occurrence.id,
        result: null,
        status: "canceled" as const,
        stderr: "",
        stdout: "",
      },
    };
    await expect(
      triggers.completeExecution({
        ...occurrenceReceipt,
        executionGeneration: dispatched.executionGeneration + 1,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await triggers.completeExecution(occurrenceReceipt);
    const restarted = commands(storeFixture, f.userId);
    await restarted.effects.driveCleanups();
    expect((await restarted.list()).find(({ id }) => id === first.id)).toMatchObject({
      state: "stopping",
    });
    await store.markConnectionAttemptsContactLost(runner);
    expect((await restarted.list()).find(({ id }) => id === first.id)).toMatchObject({
      state: "stopping",
      lastActionUncertain: true,
      lastActionUncertainDetail: { device: expect.any(String) },
    });
    const watchReceipt = {
      ...runner,
      activationId: activation.id,
      executionGeneration: activation.executionGeneration,
      runnerConnectionGeneration: 1,
      observed: "stopped" as const,
      restartCount: 0,
      healthySince: null,
      lastError: null,
      lastExitCode: null,
      stderrTail: "",
      stdoutTail: "",
    };
    await expect(
      triggers.applyWatchStatus({
        ...watchReceipt,
        executionGeneration: activation.executionGeneration + 1,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await triggers.applyWatchStatus(watchReceipt);
    await restarted.effects.driveCleanups();
    // The transport close leaves the attachment outstanding until the browser reports it drained.
    await expect(restarted.remove(first.id)).rejects.toMatchObject({
      reason: "cleanup-outstanding",
    });
    await cdp.settled(browserSessionId, attachmentId);
    await restarted.effects.driveCleanups();
    expect((await restarted.list()).find(({ id }) => id === first.id)).toMatchObject({
      state: "stopped",
      lastActionUncertain: true,
    });
    await restarted.remove(first.id);
    expect((await restarted.list()).map(({ id }) => id)).not.toContain(first.id);
  });

  for (const end of ["terminal report", "confirmed contact loss"] as const) {
    it(`holds a retired Trigger generation until its ${end}`, async ({ storeFixture }) => {
      const f = await storeFixture.startRunFixture(`trigger-retry-${end}`);
      const { store, database } = storeFixture;
      const agent = await connection(store, await serveMcp(storeFixture), {
        userId: f.userId,
        accessMode: "full-access",
        grant: tasksOnly,
      });
      const task = await createTask(agent, f, `trigger-retry-${end}`);
      const triggers = new TriggerStore(database);
      const { trigger } = await triggers.create({
        ...scheduled(task, f.userId, `trigger-retry-${end}`),
        actorConnectionId: agent.id,
      });
      const occurrence = await triggers.enqueueManual({
        actorThreadId: null,
        ownerId: f.userId,
        triggerId: trigger.id,
      });
      const runner = { runnerId: f.runnerId, runnerBootId: "first-boot" };
      expect(await store.claimCommand(occurrence.commandId, "trigger-first")).not.toBeNull();
      const first = await triggers.startExecution({ ...runner, commandId: occurrence.commandId });
      await store.retryCommand(occurrence.commandId, new Error("Retried without an end report"));
      expect(await store.claimCommand(occurrence.commandId, "trigger-second")).not.toBeNull();
      const second = await triggers.startExecution({ ...runner, commandId: occurrence.commandId });
      expect(second.executionGeneration).toBe(first.executionGeneration + 1);
      const stops: { generation: number | null; id: string }[] = [];
      const host = commands(storeFixture, f.userId, {
        stopper: {
          async stop(attempt) {
            if (attempt.kind !== "occurrence") return;
            stops.push({ generation: attempt.generation, id: store.connectionStopId(attempt) });
          },
        },
      });
      await host.revoke(agent.id);
      expect(host.failures).toEqual([]);
      expect(stops).toEqual(
        expect.arrayContaining([
          { generation: first.executionGeneration, id: expect.any(String) },
          { generation: second.executionGeneration, id: expect.any(String) },
        ]),
      );
      expect(stops).toHaveLength(2);
      const oldStop = stops.find(({ generation }) => generation === first.executionGeneration)!;
      expect(oldStop.id).not.toBe(
        stops.find(({ generation }) => generation === second.executionGeneration)!.id,
      );
      const evidence = () =>
        database
          .selectFrom("triggerOccurrenceAttempts")
          .select(["terminalEvidenceAt", "contactLostAt"])
          .where("occurrenceId", "=", occurrence.id)
          .where("executionGeneration", "=", first.executionGeneration)
          .executeTakeFirstOrThrow();
      const current = () =>
        database
          .selectFrom("triggerOccurrences")
          .select(["status", "executionGeneration", "terminalEvidenceAt", "contactLostAt"])
          .where("id", "=", occurrence.id)
          .executeTakeFirstOrThrow();
      const receipt = (executionGeneration: number) => ({
        ...runner,
        executionGeneration,
        verifiedContainment: true,
        output: {
          occurrenceId: occurrence.id,
          status: "canceled" as const,
          completedAt: new Date().toISOString(),
          error: null,
          exitCode: null,
          result: null,
          stderr: "",
          stdout: "",
        },
      });
      await expect(
        triggers.completeExecution({
          ...receipt(first.executionGeneration),
          runnerBootId: "wrong-boot",
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(await evidence()).toEqual({ terminalEvidenceAt: null, contactLostAt: null });
      if (end === "terminal report") {
        await triggers.completeExecution(receipt(first.executionGeneration));
        expect(await current()).toEqual({
          status: "running",
          executionGeneration: second.executionGeneration,
          terminalEvidenceAt: null,
          contactLostAt: null,
        });
        expect(await evidence()).toEqual({
          terminalEvidenceAt: expect.any(Date),
          contactLostAt: null,
        });
        expect((await host.list()).find(({ id }) => id === agent.id)).toMatchObject({
          state: "stopping",
        });
      }
      await triggers.completeExecution(receipt(second.executionGeneration));
      if (end === "confirmed contact loss") {
        await expect(host.remove(agent.id)).rejects.toMatchObject({
          reason: "cleanup-outstanding",
        });
        expect((await host.list()).find(({ id }) => id === agent.id)).toMatchObject({
          state: "stopping",
          lastActionUncertain: false,
        });
        const recovery = commands(storeFixture, f.userId, {
          stopper: {
            async stop(attempt) {
              expect(attempt).toMatchObject({
                ...runner,
                kind: "occurrence",
                id: occurrence.id,
                generation: first.executionGeneration,
              });
              expect(store.connectionStopId(attempt)).toBe(oldStop.id);
              return "contact-lost";
            },
          },
        });
        await recovery.effects.driveCleanups();
        expect(recovery.failures).toEqual([]);
        expect(await evidence()).toEqual({
          terminalEvidenceAt: expect.any(Date),
          contactLostAt: expect.any(Date),
        });
      }
      await host.effects.driveCleanups();
      expect((await host.list()).find(({ id }) => id === agent.id)).toMatchObject({
        state: "stopped",
        lastActionUncertain: end === "confirmed contact loss",
      });
      await host.remove(agent.id);
    });
  }

  it("preserves a connected Watch's old witness when its Runner boots again", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("watch-rebind");
    const { database, store } = storeFixture;
    const agent = await connection(store, await serveMcp(storeFixture), {
      userId: f.userId,
      accessMode: "full-access",
      grant: tasksOnly,
    });
    const task = await createTask(agent, f, "watch-rebind");
    const triggers = new TriggerStore(database);
    const watch = await triggers.create({
      ...scheduled(task, f.userId, "watch-rebind"),
      actorConnectionId: agent.id,
      source: { kind: "watch" },
    });
    const reconcile = async (runnerBootId: string, runnerConnectionGeneration: number) => {
      const result = await triggers.reconcileWatchesForRunner({
        environmentId: f.environmentId,
        runnerBootId,
        runnerConnectionGeneration,
        runnerId: f.runnerId,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      });
      return result.activations.find(({ activation }) => activation.triggerId === watch.trigger.id)!
        .activation;
    };
    const old = await reconcile("old-watch-boot", 1);
    const current = await reconcile("new-watch-boot", 2);
    expect(current.id).not.toBe(old.id);
    expect(
      await database
        .selectFrom("triggerWatchActivations")
        .select(["executionGeneration", "desired", "terminalEvidenceAt", "contactLostAt"])
        .where("triggerId", "=", watch.trigger.id)
        .orderBy("executionGeneration")
        .execute(),
    ).toEqual([
      {
        executionGeneration: String(old.executionGeneration),
        desired: "stopped",
        terminalEvidenceAt: expect.any(Date),
        contactLostAt: expect.any(Date),
      },
      {
        executionGeneration: String(current.executionGeneration),
        desired: "active",
        terminalEvidenceAt: null,
        contactLostAt: null,
      },
    ]);
  });

  it("settles Disconnect when an older Runner's first snapshot omitted the Watch", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("watch-old-runner");
    const { database, store } = storeFixture;
    const connections = new AgentConnectionStore(database);
    const agent = await connection(store, await serveMcp(storeFixture), {
      userId: f.userId,
      accessMode: "full-access",
      grant: tasksOnly,
    });
    const task = await createTask(agent, f, "watch-old-runner");
    const triggers = new TriggerStore(database);
    const watch = await triggers.create({
      ...scheduled(task, f.userId, "watch-old-runner"),
      actorConnectionId: agent.id,
      source: { kind: "watch" },
    });
    const fence = {
      bootId: RunnerBootIdSchema.parse(`rbt_${crypto.randomUUID()}`),
      connectionId: RunnerConnectionIdSchema.parse(`rcn_${crypto.randomUUID()}`),
      connectionLeaseId: RunnerConnectionLeaseIdSchema.parse(`rls_${crypto.randomUUID()}`),
      connectionGeneration: 1,
      runnerId: f.runnerId,
    };
    const identity: RunnerIdentity = {
      ...fence,
      fence,
      name: "Older runner",
      runtimeVersion: "test",
      runnerKind: "main",
      capabilities: ["agent-tools-plan-v1"],
      modules: {},
      allowedModules: ["agents"],
      environmentIds: [f.environmentId],
      personalRemoteAccessGeneration: null,
    };
    const reconcileWatches = vi.fn<WatchServiceOptions["runners"]["reconcileWatches"]>(
      async () => undefined,
    );
    const issue = vi.fn(() => {
      throw new Error("An incompatible Watch was given a capability");
    });
    const service = new WatchService({
      store: triggers,
      runnerStore: {
        getEnvironment: store.getEnvironment.bind(store),
        runnerCapabilities: async () => identity.capabilities,
      },
      runners: { identityForEnvironment: () => identity, reconcileWatches },
      browser: { hasBrowserProfiles: async () => false },
      browserCdpUrl: "wss://host.test",
      mcpUrl: "https://host.test",
      controlTokens: { issue },
      watchBrowserTokens: { issue },
      onChanged: () => undefined,
      onError: (error) => {
        throw error;
      },
    });
    try {
      await service.reconcile(f.environmentId);
      expect(reconcileWatches).toHaveBeenCalledOnce();
      expect(reconcileWatches.mock.calls[0]?.[2]).toEqual([]);
      expect(issue).not.toHaveBeenCalled();
      const readWatch = () =>
        database
          .selectFrom("triggerWatchActivations")
          .select(["runnerId", "leaseExpiresAt", "observed", "desired"])
          .where("triggerId", "=", watch.trigger.id)
          .executeTakeFirstOrThrow();
      expect(await readWatch()).toEqual({
        runnerId: null,
        leaseExpiresAt: null,
        observed: "backoff",
        desired: "active",
      });

      await connections.revoke(f.userId, agent.id);
      const stop = vi.fn(async () => undefined);
      await store.driveConnectionCleanups({ stopper: { stop } });
      expect(stop).not.toHaveBeenCalled();
      expect(await readWatch()).toMatchObject({ desired: "stopped", observed: "stopped" });
      const history = await connections.list(f.userId, { includeRevoked: true });
      expect(history.find(({ id }) => id === agent.id)).toMatchObject({
        state: "stopped",
        lastActionUncertain: false,
      });
    } finally {
      await service.close();
    }
  });

  it("retries an older floor without interrupting a Run admitted under the new grant", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("narrow-retry");
    const url = await serveMcp(storeFixture);
    const { database, store } = storeFixture;
    const agent = await connection(store, url, {
      userId: f.userId,
      accessMode: "full-access",
      grant: tasksOnly,
    });
    const oldTask = await createTask(agent, f, "before-floor");
    const oldRun = await queuedRun(storeFixture, oldTask);
    await startPersonalQueuedRunFixture(store, oldRun.id);
    const enumerated = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const host = commands(storeFixture, f.userId, {
      async afterStop() {
        enumerated.resolve();
        await proceed.promise;
      },
    });
    const change = host.update(agent.id, { accessMode: "auto" });
    await Promise.race([
      enumerated.promise,
      change.then(() => {
        throw new Error("Narrowing returned before reaching the cleanup worker");
      }),
    ]);
    let newRunId: RunId;
    try {
      const thread = await createTask(agent, f, "after-floor");
      const run = await queuedRun(storeFixture, thread);
      newRunId = run.id;
      await startPersonalQueuedRunFixture(store, run.id);
    } finally {
      proceed.resolve();
      await change;
    }
    await commands(storeFixture, f.userId).effects.driveCleanups();
    expect(
      await database
        .selectFrom("runs")
        .select(["id", "admittedGrantRevision", "admittedAccessMode"])
        .where("id", "=", newRunId)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      id: newRunId,
      admittedGrantRevision: 2,
      admittedAccessMode: "auto",
    });
    expect(
      await database
        .selectFrom("commands")
        .select("runId")
        .where("type", "=", "run.interrupt")
        .execute(),
    ).toEqual([{ runId: oldRun.id }]);
  });

  it("refuses a plugin submission whose authorization read predates the revoke", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("plugin-before-ipc");
    const { database, store } = storeFixture;
    const url = await serveMcp(storeFixture);
    const agent = await connection(store, url, { userId: f.userId, accessMode: "full-access" });
    const checked = Promise.withResolvers<void>();
    const continueSubmission = Promise.withResolvers<void>();
    const execute = vi.fn(async () => {
      throw new Error("Plugin IPC was reached");
    });
    const service = new PluginExecutions({
      service: { execute },
      store,
      records: new PluginAgentStore(database),
      authority: {
        admit: pluginCaller,
        assert: async () => {
          checked.resolve();
          await continueSubmission.promise;
        },
        assertCallComputerRunning: () => {},
        session: () => undefined,
      },
    } as unknown as ConstructorParameters<typeof PluginExecutions>[0]);
    const caller = {
      kind: "run",
      userId: f.userId,
      accessMode: "full-access",
      thread: f.thread,
      claims: { runId: f.run.id },
      agentConnection: {
        agentConnectionId: agent.id,
        grant: { scope: "everything" },
        grantRevision: 1,
      },
    } as RunCaller;
    const submission = service.execute(caller, "execute", { code: "return 1" });
    const rejected = expect(submission).rejects.toMatchObject({ code: "forbidden" });
    try {
      await checked.promise;
      await new AgentConnectionStore(database).revoke(f.userId, agent.id);
    } finally {
      continueSubmission.resolve();
      await rejected;
    }
    expect(execute).not.toHaveBeenCalled();
    expect(await database.selectFrom("pluginExecutions").select("id").execute()).toEqual([]);
  });

  it("keeps a plugin witness before IPC and settles a refusal during engine startup", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("plugin-startup-revoke");
    const { database, store } = storeFixture;
    const agent = await connection(store, await serveMcp(storeFixture), {
      userId: f.userId,
      accessMode: "full-access",
    });
    const ipc = vi.fn();
    const execute = vi.fn(
      async (
        input: { executionId: string },
        _context: unknown,
        _signal: AbortSignal,
        beforeSend: () => Promise<void>,
      ) => {
        expect(
          await database
            .selectFrom("pluginExecutions")
            .select("connectionId")
            .where("id", "=", input.executionId)
            .executeTakeFirst(),
        ).toEqual({ connectionId: agent.id });
        await new AgentConnectionStore(database).revoke(f.userId, agent.id);
        await beforeSend();
        ipc();
      },
    );
    const service = new PluginExecutions({
      service: { execute, executionWasSent: () => false },
      store,
      records: new PluginAgentStore(database),
      authority: {
        admit: pluginCaller,
        assert: async () => {},
        assertCallComputerRunning: () => {},
        session: () => undefined,
      },
    } as unknown as ConstructorParameters<typeof PluginExecutions>[0]);
    const caller = {
      kind: "run",
      userId: f.userId,
      accessMode: "full-access",
      thread: f.thread,
      claims: { runId: f.run.id },
      agentConnection: {
        agentConnectionId: agent.id,
        grant: { scope: "everything" },
        grantRevision: 1,
      },
    } as RunCaller;
    await expect(service.execute(caller, "execute", { code: "return 1" })).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(ipc).not.toHaveBeenCalled();
    expect(
      await database
        .selectFrom("pluginExecutions")
        .select(["state", "terminalEvidenceAt"])
        .where("connectionId", "=", agent.id)
        .execute(),
    ).toEqual([{ state: "cancelled", terminalEvidenceAt: expect.any(Date) }]);
  });

  it("recovers a legacy revoke and keeps a plugin handed off after enumeration outstanding", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("late-plugin");
    const url = await serveMcp(storeFixture);
    const { database, store } = storeFixture;
    const agent = await connection(store, url, { userId: f.userId, accessMode: "full-access" });
    const pluginId = "late-plugin-execution";
    const writeStarted = Promise.withResolvers<void>();
    const commitWrite = Promise.withResolvers<void>();
    const late = database.transaction().execute(async (tx) => {
      await tx
        .insertInto("pluginExecutions")
        .values({
          id: pluginId,
          caller: "plugin-test",
          ownerUserId: f.userId,
          threadId: f.thread.id,
          occurrenceId: null,
          watchActivationId: null,
          runId: f.run.id,
          mode: "automatic",
          state: "running",
          requestId: null,
          interactionId: null,
          handoff: true,
          result: null,
          reason: null,
          connectionId: agent.id,
          admittedGrantRevision: 1,
          admittedAccessMode: "full-access",
        })
        .execute();
      writeStarted.resolve();
      await commitWrite.promise;
    });
    await Promise.race([writeStarted.promise, late]);
    await database
      .updateTable("agentConnections")
      .set({ revokedAt: new Date(), tokenHash: null })
      .where("id", "=", agent.id)
      .execute();
    // The writer already holds its attempt but is invisible to this pass's first SELECT.
    const stopped: string[] = [];
    const recovery = commands(storeFixture, f.userId, {
      async afterStop() {
        commitWrite.resolve();
        await late;
      },
      stopper: {
        async stop(attempt) {
          stopped.push(attempt.id);
        },
      },
    });
    try {
      await recovery.effects.driveCleanups();
    } finally {
      commitWrite.resolve();
      await late;
    }
    expect(stopped).toEqual([]);
    expect((await recovery.list()).find(({ id }) => id === agent.id)).toMatchObject({
      state: "stopping",
    });
    await recovery.effects.driveCleanups();
    expect(stopped).toEqual([pluginId]);
    // A local 'cancelled' label and receipt of the stop command don't prove it ended.
    await database
      .updateTable("pluginExecutions")
      .set({ state: "cancelled" })
      .where("id", "=", pluginId)
      .execute();
    await recovery.effects.driveCleanups();
    await expect(recovery.remove(agent.id)).rejects.toMatchObject({
      reason: "cleanup-outstanding",
    });
    await database
      .updateTable("pluginExecutions")
      .set({ terminalEvidenceAt: new Date() })
      .where("id", "=", pluginId)
      .execute();
    await recovery.effects.driveCleanups();
    expect((await recovery.list()).find(({ id }) => id === agent.id)).toMatchObject({
      state: "stopped",
    });
  });

  it("preserves a Run's old proof without carrying it into a rebind", async ({ storeFixture }) => {
    const f = await storeFixture.startRunFixture("disconnect-rebind");
    const { database, store } = storeFixture;
    const url = await serveMcp(storeFixture);
    const agent = await connection(store, url, {
      userId: f.userId,
      accessMode: "full-access",
      grant: tasksOnly,
    });
    const task = await createTask(agent, f, "disconnect-rebind");
    const run = await queuedRun(storeFixture, task);
    const prior = await startPersonalQueuedRunFixture(store, run.id);
    const evidence = new Date();
    await database
      .updateTable("runAttempts")
      .set({ terminalEvidenceAt: evidence })
      .where("runId", "=", run.id)
      .execute();
    await database
      .updateTable("runs")
      .set({ status: "starting" })
      .where("id", "=", run.id)
      .execute();
    const thread = await store.getThreadForOwner(task, f.userId);
    const { runnerId } = await database
      .selectFrom("executionEnvironments")
      .select("runnerId")
      .where("id", "=", f.environmentId)
      .executeTakeFirstOrThrow();
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: thread!.harnessInstanceId,
      leaseTokenHash: crypto.randomUUID(),
      runnerBootId: prior.runnerBootId,
      runnerId: runnerId!,
      runId: run.id,
      threadId: task,
    });
    expect(
      await database
        .selectFrom("runAttempts")
        .select(["bindingGeneration", "terminalEvidenceAt"])
        .where("runId", "=", run.id)
        .orderBy("ordinal")
        .execute(),
    ).toEqual([
      { bindingGeneration: prior.bindingGeneration, terminalEvidenceAt: evidence },
      { bindingGeneration: binding.bindingGeneration, terminalEvidenceAt: null },
    ]);
  });

  it("uses one stop ID for a legacy Run and settles its terminal report as uncertain", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("legacy-run-first-event");
    const { database, store } = storeFixture;
    const agent = await connection(store, await serveMcp(storeFixture), {
      userId: f.userId,
      accessMode: "full-access",
      grant: tasksOnly,
    });
    const task = await createTask(agent, f, "legacy-run-first-event");
    const run = await queuedRun(storeFixture, task);
    const { bindingGeneration, runnerBootId } = await startPersonalQueuedRunFixture(store, run.id);
    const legacy = await database
      .updateTable("runAttempts")
      .set({ admittedGrantRevision: null, admittedAccessMode: null })
      .where("runId", "=", run.id)
      .where("bindingGeneration", "=", bindingGeneration)
      .returning(["id", "firstEventAt"])
      .executeTakeFirstOrThrow();
    expect(legacy.firstEventAt).toBeInstanceOf(Date);
    await new AgentConnectionStore(database).revoke(f.userId, agent.id);

    const directIds: string[] = [];
    const stopper = {
      async stop(attempt: Parameters<typeof store.connectionStopId>[0]) {
        if (attempt.kind !== "run-attempt") return;
        expect(attempt).toMatchObject({ id: legacy.id, generation: bindingGeneration });
        directIds.push(store.connectionStopId(attempt));
      },
    };
    await store.driveConnectionCleanups({ stopper });
    await store.driveConnectionCleanups({ stopper });
    expect(directIds).toHaveLength(2);
    expect(new Set(directIds).size).toBe(1);
    expect(
      await database
        .selectFrom("commands")
        .select("id")
        .where("runId", "=", run.id)
        .where("type", "=", "run.interrupt")
        .execute(),
    ).toEqual([{ id: directIds[0] }]);
    const host = commands(storeFixture, f.userId);
    expect((await host.list()).find(({ id }) => id === agent.id)?.state).toBe("stopping");
    await store.commitRunnerEvent({
      environmentId: f.environmentId,
      runnerId: f.runnerId,
      runnerBootId,
      event: pendingEvent({
        bindingGeneration,
        data: { status: "interrupted" },
        environmentId: f.environmentId,
        ordinal: 1,
        runId: run.id,
        threadId: task,
        type: "run.interrupted",
      }),
    });
    await store.driveConnectionCleanups({ stopper });
    expect((await host.list()).find(({ id }) => id === agent.id)).toMatchObject({
      state: "stopped",
      lastActionUncertain: true,
    });
  });

  it("reuses the stop ID after claim takeover and discards the first worker's proof", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("cleanup-takeover");
    const { database, store } = storeFixture;
    const url = await serveMcp(storeFixture);
    const agent = await connection(store, url, {
      userId: f.userId,
      accessMode: "full-access",
      grant: tasksOnly,
    });
    const task = await createTask(agent, f, "cleanup-takeover");
    const run = await queuedRun(storeFixture, task);
    await startPersonalQueuedRunFixture(store, run.id);
    await new AgentConnectionStore(database).revoke(f.userId, agent.id);
    const entered = Promise.withResolvers<string>();
    const finish = Promise.withResolvers<void>();
    const first = store.driveConnectionCleanups({
      stopper: {
        async stop(attempt) {
          if (attempt.kind !== "run-attempt") return;
          entered.resolve(store.connectionStopId(attempt));
          await finish.promise;
          return "ended";
        },
      },
    });
    try {
      const firstId = await Promise.race([
        entered.promise,
        first.then(() => {
          throw new Error("No stop sent");
        }),
      ]);
      await database
        .updateTable("agentConnections")
        .set({ cleanupClaimExpiresAt: new Date(0) })
        .where("id", "=", agent.id)
        .execute();
      const ids: string[] = [];
      await store.driveConnectionCleanups({
        stopper: {
          async stop(attempt) {
            if (attempt.kind === "run-attempt") ids.push(store.connectionStopId(attempt));
          },
        },
      });
      expect(ids).toEqual([firstId]);
      expect(
        await database
          .selectFrom("commands")
          .select("id")
          .where("runId", "=", run.id)
          .where("type", "=", "run.interrupt")
          .execute(),
      ).toEqual([{ id: firstId }]);
    } finally {
      finish.resolve();
      await first;
    }
    expect(
      await database
        .selectFrom("runAttempts")
        .select("terminalEvidenceAt")
        .where("runId", "=", run.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ terminalEvidenceAt: null });
  });

  it("drives an expired connection through the same durable cleanup", async ({ storeFixture }) => {
    const f = await storeFixture.startRunFixture("expiry");
    const subscribed = Promise.withResolvers<void>();
    const detached = Promise.withResolvers<void>();
    const url = await serveMcp(storeFixture, {
      subscribed: subscribed.resolve,
      unsubscribed: detached.resolve,
    });
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
      grant: tasksOnly,
    });
    const own = await createTask(agent, f, "expiry");
    const held = agent.client
      .callTool({
        name: "opensteer_task_wait",
        arguments: { taskId: own },
      })
      .then(
        (response) => expect(response.isError).toBe(true),
        (error: unknown) => expect(error).toBeInstanceOf(Error),
      );
    await Promise.race([
      subscribed.promise,
      held.then(() => {
        throw new Error("Wait returned before it held a subscription");
      }),
    ]);
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
    await Promise.all([held, detached.promise]);
  });

  it("refuses a send after Disconnect and creates no new input", async ({ storeFixture }) => {
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
    const inputIds = () =>
      database
        .selectFrom("threadInputs")
        .select("messageId")
        .where("threadId", "=", own)
        .orderBy("messageId")
        .execute();
    const before = await inputIds();
    await host.revoke(agent.id);
    await expect(send(agent, own, "race")).rejects.toThrow(/invalid or expired|access ended/iu);
    expect(host.failures).toEqual([]);
    expect(await inputIds()).toEqual(before);
    expect(
      await database
        .selectFrom("commands")
        .select("runId")
        .where("type", "=", "run.interrupt")
        .execute(),
    ).toEqual([{ runId: run.id }]);
  });

  it("gives a connected agent identical neutral bytes for every engine refusal while showing the person the exact reason", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("engine-refusal-audiences");
    const url = await serveMcp(storeFixture);
    const { database, store } = storeFixture;
    const agent = await connection(store, url, {
      userId: f.userId,
      accessMode: "full-access",
      grant: tasksOnly,
    });
    const root = await mkdtemp(join(tmpdir(), "opensteer-refusal-contract-"));
    try {
      const piHome = join(root, "pi-home");
      await mkdir(join(piHome, ".pi", "agent"), { recursive: true });
      await writeFile(
        join(piHome, ".pi", "agent", "models.json"),
        JSON.stringify({ providers: { corp: { apiKey: "!op read op://vault/key" } } }),
      );
      const codexHome = join(root, "codex-home");
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, "config.toml"), 'cli_auth_credentials_store = "keyring"\n');

      const cases = [
        {
          engine: "pi",
          context: {
            environment: { HOME: piHome },
            personalContext: true,
            personLineage: false,
            providerState: { kind: "ambient" as const },
          },
          expectedOwnerFragment: 'a "!" value in models.json or auth.json',
        },
        {
          engine: "codex",
          context: {
            environment: { CODEX_HOME: codexHome },
            personalContext: true,
            personLineage: false,
            providerState: { kind: "ambient" as const },
          },
          expectedOwnerFragment: 'cli_auth_credentials_store = "file"',
        },
        {
          engine: "opencode",
          context: { personalContext: true, personLineage: false },
          expectedOwnerFragment:
            "OpenCode is not yet verified to keep your settings out of tasks a connected agent or chat started",
        },
        {
          engine: "antigravity",
          context: { personalContext: true, personLineage: false },
          expectedOwnerFragment:
            "Antigravity is not yet verified to keep your settings out of tasks a connected agent or chat started",
        },
      ] as const;

      const normalize = (value: unknown) =>
        JSON.stringify(value)
          .replace(/\b(?:thr|run|msg|itm|asg|psn|req|cmd)_[0-9a-f-]{36}\b/gu, "<ID>")
          .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/gu, "<TS>");

      const observedConnectionPayloads: string[] = [];
      for (const testCase of cases) {
        let caught: (Error & { code?: string; ownerMessage?: string }) | undefined;
        try {
          assertEngineMayRun(testCase.engine, testCase.context);
        } catch (error) {
          caught = error as Error & { code?: string; ownerMessage?: string };
        }
        expect(caught, testCase.engine).toBeDefined();
        expect(caught!.code, testCase.engine).toBe("forbidden");

        const created = await agent.client.callTool({
          name: "opensteer_task_create",
          arguments: {
            title: "Same refusal task",
            message: "Work on it",
            operationKey: `refusal-case:${testCase.engine}`,
          },
        });
        expect(created.isError, JSON.stringify(created.content)).not.toBe(true);
        const taskId = ThreadIdSchema.parse(
          (created.structuredContent as { taskId: string }).taskId,
        );
        const run = await queuedRun(storeFixture, taskId);
        const execution = await startPersonalQueuedRunFixture(store, run.id);
        await store.commitRunnerEvent({
          runnerId: f.runnerId,
          runnerBootId: execution.runnerBootId,
          environmentId: f.environmentId,
          event: pendingEvent({
            type: "run.failed",
            runId: run.id,
            threadId: taskId,
            ordinal: 1,
            bindingGeneration: execution.bindingGeneration,
            environmentId: f.environmentId,
            data: {
              status: "failed",
              code: "forbidden",
              message: caught!.message,
              ...(caught!.ownerMessage ? { ownerMessage: caught!.ownerMessage } : {}),
              retryable: false,
            },
          }),
        });

        const messagesRead = await agent.client.callTool({
          name: "opensteer_task_read",
          arguments: { taskId },
        });
        const activityRead = await agent.client.callTool({
          name: "opensteer_task_read",
          arguments: { taskId, view: "activity" },
        });
        const waited = await agent.client.callTool({
          name: "opensteer_task_wait",
          arguments: { taskId, timeoutMs: 2_000 },
        });

        // Person reads the exact reason in their task transcript card and task list preview.
        const card = await database
          .selectFrom("transcriptItems")
          .select("view")
          .where("id", "=", `run:${run.id}`)
          .executeTakeFirstOrThrow();
        expect(
          (card.view as { failure?: { message?: string; ownerMessage?: string } }).failure,
        ).toMatchObject({
          message: "This engine is not available for this task.",
          ownerMessage: expect.stringContaining(testCase.expectedOwnerFragment),
        });
        const threadRow = await database
          .selectFrom("threads")
          .select("failurePreview")
          .where("id", "=", taskId)
          .executeTakeFirstOrThrow();
        expect(threadRow.failurePreview).toContain(testCase.expectedOwnerFragment);

        // Enqueue a follow-up Run so we also observe what its engine context sees in `previousRun.failure`.
        const followUp = await store.enqueueThreadInput({
          requestedBy: f.userId,
          threadId: taskId,
          content: [{ type: "text", text: "Follow up" }],
          source: { kind: "human" },
          policy: "queue",
          idempotencyKey: `refusal-followup:${testCase.engine}`,
        });
        const nextRunState = await store.loadRunThreadState({
          runId: followUp.run!.id,
          viewerId: f.userId,
        });
        const connectionBytes = normalize({ messagesRead, activityRead, waited, nextRunState });
        observedConnectionPayloads.push(connectionBytes);

        // Connected agent and follow-up Run see only the neutral refusal, never setup details.
        expect(nextRunState.previousRun?.failure).toEqual({
          code: "forbidden",
          message: "This engine is not available for this task.",
        });
        expect(connectionBytes).toContain("This engine is not available for this task.");
        for (const forbidden of [
          "keyring",
          "auth.json",
          "models.json",
          "codex login",
          "OpenCode",
          "Antigravity",
          "shell command",
        ]) {
          expect(connectionBytes).not.toContain(forbidden);
        }
      }

      // Byte-for-byte identical across Pi, Codex, OpenCode, and Antigravity.
      expect(new Set(observedConnectionPayloads).size).toBe(1);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
