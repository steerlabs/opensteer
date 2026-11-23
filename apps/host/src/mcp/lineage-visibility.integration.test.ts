import {
  createId,
  DeviceIdSchema,
  TabIdSchema,
  type AgentGrant,
  type ExecutionNodeId,
  type RunId,
  type TabId,
  type ThreadId,
} from "@opensteer/core";
import {
  AgentConnectionStore,
  TabStore,
  TriggerStore,
  beginAgentSession,
} from "@opensteer/database";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describeStore, testModelSelection } from "@opensteer/database/test-support/store";
import { startPersonalQueuedRunFixture } from "@opensteer/database/test-support/personal-run";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { RunToolScope } from "../agents/run-tool-tokens.js";
import type { TabActor } from "../tabs/ports.js";
import { readableTabTasks, tabComputer, tabReadAuthority } from "../tabs/tab-authority.js";
import { TabService } from "../tabs/tab-service.js";
import {
  clients,
  connection,
  createTask,
  errorText,
  expectUnknownTool,
  fixtureRunScope,
  runClient,
  queuedRun,
  serveMcp,
} from "./connection-caller.test-support.js";

type StoreFixture = Parameters<typeof queuedRun>[0];

/** A subagent node on a started Run. */
async function subagent(storeFixture: StoreFixture, runId: RunId): Promise<ExecutionNodeId> {
  const attempt = await storeFixture.database
    .selectFrom("runAttempts")
    .select("id")
    .where("runId", "=", runId)
    .where("status", "=", "current")
    .executeTakeFirstOrThrow();
  const id = createId("executionNode");
  await storeFixture.database
    .insertInto("executionNodes")
    .values({
      id,
      attemptId: attempt.id,
      runId,
      status: "running",
      kind: "subagent",
      effort: null,
      phaseIndex: null,
      phases: sql`'[]'::jsonb`,
      title: "Subagent",
      startedAt: new Date(),
      endedAt: null,
      nativeRef: `native:${id}`,
      originCallId: null,
      parentNodeId: null,
      prompt: null,
      result: null,
      sessionRef: null,
      model: null,
    })
    .execute();
  return id;
}

describeStore("a selected connection reads only its own lineage", (it) => {
  const tasksOnly: AgentGrant = { scope: "selected", tasks: true, resources: [] };

  it("subagents, parent tasks and delegations outside it read as unknown or refused", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("lineage-reads");
    const url = await serveMcp(storeFixture);
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
      grant: tasksOnly,
    });
    const second = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
      grant: tasksOnly,
    });
    const own = await createTask(agent, f, "lineage-own");
    const foreign = await createTask(second, f, "lineage-foreign");
    const ownRun = await startPersonalQueuedRunFixture(
      storeFixture.store,
      (await queuedRun(storeFixture, own)).id,
    );
    const call = (name: string, args: Record<string, unknown>) =>
      agent.client.callTool({ name, arguments: args });

    const ownTask = await call("opensteer_task_read", { taskId: own });
    expect(ownTask.isError, JSON.stringify(ownTask.content)).not.toBe(true);
    const foreignDirect = await beginAgentSession(storeFixture.database, {
      userId: f.userId,
      agentConnectionId: second.id,
    });
    const missingTask = await call("opensteer_task_read", { taskId: createId("thread") });
    for (const taskId of [foreign, foreignDirect.session.threadId]) {
      const hiddenTask = await call("opensteer_task_read", { taskId });
      expect(errorText(hiddenTask)).toBe(errorText(missingTask));
      expect(hiddenTask.structuredContent).toEqual(missingTask.structuredContent);
    }

    const request = async (threadId: ThreadId, runId: RunId, callId: string) =>
      storeFixture.store.requests.create({
        callId,
        kind: "person.question",
        mode: "durable",
        originatingRunId: runId,
        originatingThreadId: threadId,
        requestedBy: f.userId,
        requiredActor: "requester",
        payload: { kind: "person.question" },
        presentation: {
          kind: "form",
          title: "Question",
          fields: [
            { id: "answer", prompt: "Ready?", secret: false, custom: true, multiSelect: false },
          ],
        },
      });
    const ownedRequest = await request(own, ownRun.runId, "own-question");
    const hiddenRequest = await request(f.threadId, f.run.id, "owner-question");
    const ownRequest = await call("opensteer_task_wait", { taskId: own });
    expect(ownRequest.isError, JSON.stringify(ownRequest.content)).not.toBe(true);
    expect(ownRequest.structuredContent).toMatchObject({
      pendingRequest: { id: ownedRequest.request.id },
    });
    await expectUnknownTool(agent.client, "opensteer_request_read", {
      requestId: hiddenRequest.request.id,
    });

    const ownNode = await subagent(storeFixture, ownRun.runId);
    const ownerNode = await subagent(storeFixture, f.run.id);
    const scopedRun = await runClient(
      await serveMcp(storeFixture, {
        runScope: fixtureRunScope({ ...f, ...ownRun, threadId: own }),
      }),
    );
    const runTool = (name: string, arguments_: Record<string, unknown>) =>
      scopedRun.callTool({ name, arguments: arguments_ });
    expect(
      (await runTool("opensteer_subagent_read", { subagentId: ownNode })).structuredContent,
    ).toMatchObject({ subagent: { id: ownNode } });
    expect(await runTool("opensteer_subagent_read", { subagentId: ownerNode })).toEqual(
      await runTool("opensteer_subagent_read", { subagentId: createId("executionNode") }),
    );
    const waitForTask = (taskId: ThreadId) =>
      call("opensteer_task_wait", { taskId, timeoutMs: 250 });
    expect(await waitForTask(f.threadId)).toEqual(await waitForTask(createId("thread")));
    expect(
      await runTool("opensteer_request_read", { requestId: hiddenRequest.request.id }),
    ).toEqual(await runTool("opensteer_request_read", { requestId: createId("request") }));
    const listedRequests = await runTool("opensteer_request_list", { status: "pending" });
    expect(listedRequests.isError, JSON.stringify(listedRequests.content)).not.toBe(true);
    expect(
      (listedRequests.structuredContent as { requests: { id: string }[] }).requests.map(
        ({ id }) => id,
      ),
    ).toEqual([ownedRequest.request.id]);
    expect(await runTool("opensteer_request_list", { taskId: f.threadId })).toEqual(
      await runTool("opensteer_request_list", { taskId: createId("thread") }),
    );
    const listedPendingTasks = await runTool("opensteer_task_list", { hasPendingRequests: true });
    expect(listedPendingTasks.isError, JSON.stringify(listedPendingTasks.content)).not.toBe(true);
    expect(
      (listedPendingTasks.structuredContent as { tasks: { id: string }[] }).tasks.map(
        ({ id }) => id,
      ),
    ).toEqual([own]);

    for (const subagentId of [ownNode, ownerNode, createId("executionNode")])
      await expectUnknownTool(agent.client, "opensteer_subagent_read", { subagentId });

    const listed = await call("discover", { id: own });
    expect(listed.isError, JSON.stringify(listed.content)).not.toBe(true);
    const unknownParent = await call("discover", { id: createId("thread") });
    expect(unknownParent).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: "not_found", message: "That item is unavailable.", next: null },
      },
    });
    for (const id of [f.threadId, foreign])
      expect(JSON.stringify(await call("discover", { id }))).toBe(JSON.stringify(unknownParent));

    // Delegations: a delegation whose child is in the lineage but whose parent is the person's.
    const delegated = await storeFixture.store.delegateThread({
      accessMode: "full-access",
      createdBy: f.userId,
      environmentId: f.environmentId,
      harnessInstanceId: f.harnessInstance.id,
      idempotencyKey: "lineage-delegation",
      modelSelection: testModelSelection,
      origin: { kind: "run", parentRunId: f.run.id, parentThreadId: f.threadId },
      task: [{ type: "text", text: "Private work" }],
      title: "Private child",
    });
    await storeFixture.database
      .updateTable("threads")
      .set({ originConnectionId: agent.id })
      .where("id", "=", delegated.thread.id)
      .execute();
    await expectUnknownTool(agent.client, "opensteer_delegation_status", {
      delegationId: delegated.assignment.id,
    });
    const privateChild = await call("opensteer_task_wait", {
      taskId: delegated.thread.id,
      timeoutMs: 1,
    });
    expect(privateChild.structuredContent).not.toHaveProperty("task");
    expect(JSON.stringify(privateChild)).not.toContain(delegated.assignment.id);
    expect(
      await runTool("opensteer_delegation_status", { delegationId: delegated.assignment.id }),
    ).toEqual(
      await runTool("opensteer_delegation_status", { delegationId: createId("delegation") }),
    );

    // A Run of the connection's own task can delegate work the connection can follow.
    const child = await storeFixture.store.delegateThread({
      accessMode: "full-access",
      createdBy: f.userId,
      environmentId: f.environmentId,
      harnessInstanceId: f.harnessInstance.id,
      idempotencyKey: "lineage-delegation-visible",
      modelSelection: testModelSelection,
      origin: { kind: "run", parentRunId: ownRun.runId, parentThreadId: own },
      task: [{ type: "text", text: "Sub-work" }],
      title: "Child of the connection's task",
    });
    const delegationId = child.assignment.id;
    const identifiers = { delegationId, taskId: child.thread.id, parentTaskId: own };
    expect((await waitForTask(child.thread.id)).structuredContent).toMatchObject({
      task: { ...identifiers, status: "open" },
    });

    expect((await call("discover", { id: own })).structuredContent).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id: child.thread.id, kind: "task", status: "open" }),
      ]),
    });
    await storeFixture.store.cancelAssignment({
      assignmentId: delegationId,
      requestedBy: f.userId,
      idempotencyKey: "lineage-delegation-cancelled",
    });
    const inaccessible = await storeFixture.database
      .selectFrom("delegations")
      .selectAll()
      .where("id", "=", delegationId)
      .executeTakeFirstOrThrow();
    const newerId = createId("delegation");
    const newerRunId = createId("run");
    // Model a retained assignment from a parent that the connection no longer shares.
    const latest = await storeFixture.database
      .selectFrom("runs")
      .select([
        "accessMode",
        "activationInputId",
        "causalChainId",
        "threadId",
        "environmentId",
        "harnessInstanceId",
        "modelSelection",
        "requestedBy",
        "actorPrincipalId",
        "authoritySource",
        "runOrdinal",
        "seedInputId",
      ])
      .where("id", "=", child.run.id)
      .executeTakeFirstOrThrow();
    await storeFixture.database
      .insertInto("runs")
      .values({
        ...latest,
        id: newerRunId,
        runOrdinal: latest.runOrdinal + 1,
        providerSessionId: null,
        replyTarget: null,
        status: "completed",
        completedAt: new Date(),
      })
      .execute();
    await storeFixture.database
      .insertInto("delegations")
      .values({
        ...inaccessible,
        id: newerId,
        parentRunId: f.runId,
        parentThreadId: f.threadId,
        childRunId: newerRunId,
        createdAt: new Date(inaccessible.createdAt.getTime() + 1_000),
        resultText: "private return from another assignment",
      })
      .execute();
    const settled = await waitForTask(child.thread.id);
    expect(settled.structuredContent).toMatchObject({ status: "settled", task: identifiers });
    expect(settled.structuredContent).not.toHaveProperty("task.pendingRequests");
    expect(JSON.stringify(settled)).not.toMatch(new RegExp(`${newerId}|private return`, "u"));
  });

  it("task_read's recent places and a tab's users show only the lineage's tasks", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("lineage-places");
    const profileId = createId("browserProfile");
    await storeFixture.database
      .insertInto("browserProfiles")
      .values({ id: profileId, ownerId: f.userId, homeRunnerId: f.runnerId, name: "Shared" })
      .execute();
    const grant: AgentGrant = {
      scope: "selected",
      tasks: true,
      resources: [{ kind: "browser-profile", profileId }],
    };
    const tabs = new TabStore(storeFixture.database);
    // Every tab exists for the person, so only the lineage's own filter decides.
    const url = await serveMcp(storeFixture, {
      tabs: {
        // As the tab service projects it: a page names its profile.
        get: async (owner, tabId) => {
          const row = await tabs.get(owner, tabId, true);
          if (!row) throw new Error("No such tab");
          return {
            ...row,
            profile:
              row.kind === "page" && row.profileId
                ? { profileId: row.profileId, name: row.profileName }
                : null,
          } as never;
        },
      },
    });
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
      grant,
    });
    const own = await createTask(agent, f, "places-own");
    const ownRun = await startPersonalQueuedRunFixture(
      storeFixture.store,
      (await queuedRun(storeFixture, own)).id,
    );
    const tab = async (label: string, openedBy: ThreadId): Promise<TabId> => {
      const sessionId = `bsn_${randomUUID()}` as import("@opensteer/core").BrowserSessionId;
      await storeFixture.store.createBrowserSession({
        id: sessionId,
        ownerId: f.userId,
        runnerId: f.runnerId,
        origin: "agent",
        opener: { kind: "person", userId: f.userId },
        placementKey: "test",
        profileId: null,
        runtimeId: "test",
      });
      const id = TabIdSchema.parse(`bsf_${label}`);
      await tabs.open(
        {
          id,
          ownerId: f.userId,
          computerId: DeviceIdSchema.parse(f.runnerId),
          kind: "page",
          title: label,
          url: `https://${label}.test/private`,
          profileId,
          profileName: "Shared",
          openedBy: { taskId: openedBy },
          pageBinding: { lineageId: sessionId, sessionId, surfaceId: id },
        },
        label,
      );
      return id;
    };
    const ownTab = await tab("own", own);
    const ownerTab = await tab("owner", f.threadId);

    // The lineage's own Run entered both tabs; only the one its lineage opened is read back.
    for (const tabId of [ownTab, ownerTab])
      await storeFixture.store.recordRunTabPlace({
        runId: ownRun.runId,
        bindingGeneration: ownRun.bindingGeneration,
        data: { tabId, title: `Title ${tabId}`, site: `https://${tabId}.test` },
      });
    const read = await agent.client.callTool({
      name: "opensteer_task_read",
      arguments: { taskId: own },
    });
    expect(read.isError, JSON.stringify(read.content)).not.toBe(true);
    expect(
      (read.structuredContent as { recentPlaces: { tabId: string }[] }).recentPlaces.map(
        (place) => place.tabId,
      ),
    ).toEqual([ownTab]);
    expect(JSON.stringify(read.structuredContent)).not.toContain(ownerTab);

    // The tab strip, through the runtime's own task filter: the person's task using the
    // lineage's tab is not named to the connection, nor to a Run in its lineage.
    const unused = async (): Promise<never> => {
      throw new Error("Unexpected native work");
    };
    const service = new TabService({
      store: tabs,
      devices: storeFixture.store,
      pages: {
        open: unused,
        state: async () => ({
          state: "open" as const,
          usedBy: [{ taskId: own }, { taskId: f.threadId }],
        }),
        activate: unused,
        bind: unused,
        closeViewers: async () => {},
      },
      nativeTargets: {
        resolveWindow: unused,
        windowState: unused,
        phoneState: unused,
        openOwnerView: unused,
        closeOwnerViews: async () => {},
        onTargetAcquired: () => () => {},
      },
      apps: { get: unused },
      computer: async (owner, id, db) => ({
        ...(await tabComputer(owner, id, db)),
        connected: true,
      }),
      canRead: async () => {
        throw new Error("Unexpected row read");
      },
      readAuthority: tabReadAuthority,
      canReadTask: async (actor, id, db) => (await readableTabTasks(actor, [id], db)).has(id),
      readableTasks: readableTabTasks,
      authorize: unused,
      authorizeMembership: unused,
      onError: (error) => {
        throw error;
      },
    });
    const claims: RunToolScope = {
      aud: "opensteer-run-tools",
      iss: "opensteer-host",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      jti: randomUUID(),
      requestedBy: f.userId,
      threadId: own,
      runId: ownRun.runId,
      environmentId: f.environmentId,
      runnerId: f.runnerId,
      runnerBootId: ownRun.runnerBootId,
      bindingGeneration: ownRun.bindingGeneration,
    };
    const actors: TabActor[] = [
      {
        kind: "connection",
        caller: {
          kind: "connection",
          key: `connection:${agent.id}`,
          connectionId: agent.id,
          grant,
          grantRevision: 1,
          userId: f.userId,
          accessMode: "full-access",
        },
      },
      { kind: "run", claims },
    ];
    try {
      for (const actor of actors) {
        const { tabs: shown } = await service.project(actor);
        expect(
          shown.map(({ tabId, usedBy, openedBy }) => ({ tabId, usedBy, openedBy })),
          actor.kind,
        ).toEqual([{ tabId: ownTab, usedBy: [{ taskId: own }], openedBy: { taskId: own } }]);
      }
      // The person still sees who uses it.
      expect(
        (
          await readableTabTasks(
            { kind: "person", ownerId: f.userId },
            [own, f.threadId],
            storeFixture.database,
          )
        ).size,
      ).toBe(2);
    } finally {
      service.dispose();
    }
    // Tasks stay, the profile is withdrawn: the lineage's own places in it are no longer read.
    await new AgentConnectionStore(storeFixture.database).update(f.userId, {
      connectionId: agent.id,
      expectedRevision: 1,
      grant: { scope: "selected", tasks: true, resources: [] },
    });
    const again = new Client({ name: "after-withdrawal", version: "1" });
    clients.push(again);
    await again.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${agent.token}` } },
      }) as unknown as Transport,
      { timeout: 5000 },
    );
    const withdrawn = await again.callTool({
      name: "opensteer_task_read",
      arguments: { taskId: own },
    });
    expect(withdrawn.isError, JSON.stringify(withdrawn.content)).not.toBe(true);
    expect((withdrawn.structuredContent as { recentPlaces: unknown[] }).recentPlaces).toEqual([]);
  });

  it("derives task list pending filter, counts, changedSince questions, and task read pendingRequests from connectionRequests", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("lineage-requests-predicate");
    const runScopes: Record<string, RunToolScope> = {};
    const url = await serveMcp(storeFixture, { runScopes });
    const agentA = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
      grant: { scope: "everything" },
    });
    const agentB = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
      grant: tasksOnly,
    });
    const taskA = await createTask(agentA, f, "everything-reader");
    const taskB = await createTask(agentB, f, "foreign-connection-task");
    const runA = await startPersonalQueuedRunFixture(
      storeFixture.store,
      (await queuedRun(storeFixture, taskA)).id,
    );
    const runB = await startPersonalQueuedRunFixture(
      storeFixture.store,
      (await queuedRun(storeFixture, taskB)).id,
    );
    runScopes["run-a"] = fixtureRunScope({ ...f, ...runA, threadId: taskA });
    runScopes["run-b"] = fixtureRunScope({ ...f, ...runB, threadId: taskB });
    const clientA = await runClient(url, "run-a");
    const callA = (name: string, arguments_: Record<string, unknown>) =>
      clientA.callTool({ name, arguments: arguments_ });

    const questionPresentation = {
      kind: "form" as const,
      title: "Question",
      fields: [{ id: "answer", prompt: "Ready?", secret: false, custom: true, multiSelect: false }],
    };

    // 1. Everything-grant lineage Run A vs foreign connection B's Request on B's task.
    const qB = await storeFixture.store.requests.create({
      callId: "foreign-b-question",
      kind: "person.question",
      mode: "durable",
      originatingRunId: runB.runId,
      originatingThreadId: taskB,
      requestedBy: f.userId,
      requiredActor: "requester",
      payload: { kind: "person.question" },
      presentation: questionPresentation,
    });

    const pendingListA = await callA("opensteer_task_list", { hasPendingRequests: true });
    expect(pendingListA.isError, JSON.stringify(pendingListA.content)).not.toBe(true);
    expect(
      (pendingListA.structuredContent as { tasks: { id: string }[] }).tasks.map(({ id }) => id),
    ).not.toContain(taskB);

    const allListA = await callA("opensteer_task_list", {});
    expect(allListA.isError, JSON.stringify(allListA.content)).not.toBe(true);
    const taskBSummary = (
      allListA.structuredContent as { tasks: { id: string; pendingRequests: number }[] }
    ).tasks.find(({ id }) => id === taskB);
    expect(taskBSummary?.pendingRequests).toBe(0);

    const readBA = await callA("opensteer_task_read", { taskId: taskB });
    expect(readBA.isError, JSON.stringify(readBA.content)).not.toBe(true);
    expect(
      (readBA.structuredContent as { task: { pendingRequests: number }; pendingRequests?: unknown })
        .task.pendingRequests,
    ).toBe(0);
    expect(readBA.structuredContent).not.toHaveProperty("pendingRequests");

    const reqListBA = await callA("opensteer_request_list", { taskId: taskB });
    expect(reqListBA.isError, JSON.stringify(reqListBA.content)).not.toBe(true);
    expect((reqListBA.structuredContent as { requests: unknown[] }).requests).toEqual([]);
    expect(await callA("opensteer_request_read", { requestId: qB.request.id })).toEqual(
      await callA("opensteer_request_read", { requestId: createId("request") }),
    );

    const sinceBeforeAnswer = new Date(Date.now() + 30_000);
    const revB = await storeFixture.store.requests.revision(qB.request.id);
    await storeFixture.store.requests.answerPersonQuestion({
      requestId: qB.request.id,
      expectedRevision: revB!,
      resolvedBy: f.userId,
      response: { kind: "form", answers: { answer: ["yes"] } },
    });
    await storeFixture.database
      .updateTable("requests")
      .set({ resolvedAt: new Date(sinceBeforeAnswer.getTime() + 10_000) })
      .where("id", "=", qB.request.id)
      .execute();

    const changedA = await callA("opensteer_task_list", {
      changedSince: sinceBeforeAnswer.toISOString(),
    });
    expect(changedA.isError, JSON.stringify(changedA.content)).not.toBe(true);
    const changedBEntry = (
      changedA.structuredContent as {
        tasks: { id: string; questionsAnswered?: number; questionsDismissed?: number }[];
      }
    ).tasks.find(({ id }) => id === taskB);
    expect(changedBEntry).toBeUndefined();
    const reqListAllBA = await callA("opensteer_request_list", { taskId: taskB, status: "all" });
    expect(reqListAllBA.isError, JSON.stringify(reqListAllBA.content)).not.toBe(true);
    expect((reqListAllBA.structuredContent as { requests: unknown[] }).requests).toEqual([]);

    // 2. Selected-grant lineage Run B vs a person's automation Request (no connection asker) on B's own task.
    const clientB = await runClient(url, "run-b");
    const callB = (name: string, arguments_: Record<string, unknown>) =>
      clientB.callTool({ name, arguments: arguments_ });

    const taskB2 = await createTask(agentB, f, "selected-no-asker-task");
    const triggers = new TriggerStore(storeFixture.database);
    const automation = await triggers.create({
      actorThreadId: null,
      anchorThreadId: taskB2,
      createdBy: f.userId,
      idempotencyKey: "person-automation-on-b-task",
      name: "Person automation on B task",
      program: {
        language: "javascript",
        source: "export default async () => null",
        toolContractVersion: 5,
      },
      source: {
        kind: "schedule",
        schedule: { expression: "0 9 * * *", kind: "cron", timezone: "UTC" },
      },
    });
    const occurrence = await triggers.enqueueManual({
      actorThreadId: null,
      ownerId: f.userId,
      triggerId: automation.trigger.id,
    });
    await storeFixture.store.claimCommand(occurrence.commandId, "r1-no-asker-occurrence");
    await triggers.startExecution({
      runnerId: f.runnerId,
      runnerBootId: f.runnerBootId,
      commandId: occurrence.commandId,
    });
    const qNoAsker = await storeFixture.store.requests.create({
      callId: "no-asker-question",
      kind: "person.question",
      mode: "durable",
      originatingOccurrenceId: occurrence.id,
      originatingThreadId: taskB2,
      requestedBy: f.userId,
      requiredActor: "requester",
      payload: { kind: "person.question" },
      presentation: questionPresentation,
    });

    const pendingListB = await callB("opensteer_task_list", { hasPendingRequests: true });
    expect(pendingListB.isError, JSON.stringify(pendingListB.content)).not.toBe(true);
    expect(
      (pendingListB.structuredContent as { tasks: { id: string }[] }).tasks.map(({ id }) => id),
    ).not.toContain(taskB2);

    const allListB = await callB("opensteer_task_list", {});
    expect(allListB.isError, JSON.stringify(allListB.content)).not.toBe(true);
    const ownTaskB2Summary = (
      allListB.structuredContent as { tasks: { id: string; pendingRequests: number }[] }
    ).tasks.find(({ id }) => id === taskB2);
    expect(ownTaskB2Summary?.pendingRequests).toBe(0);

    const readB2B = await callB("opensteer_task_read", { taskId: taskB2 });
    expect(readB2B.isError, JSON.stringify(readB2B.content)).not.toBe(true);
    expect(
      (readB2B.structuredContent as { task: { pendingRequests: number } }).task.pendingRequests,
    ).toBe(0);
    expect(readB2B.structuredContent).not.toHaveProperty("pendingRequests");

    expect(await callB("opensteer_request_read", { requestId: qNoAsker.request.id })).toEqual(
      await callB("opensteer_request_read", { requestId: createId("request") }),
    );

    const sinceBeforeNoAskerAnswer = new Date(Date.now() + 30_000);
    const revNoAsker = await storeFixture.store.requests.revision(qNoAsker.request.id);
    await storeFixture.store.requests.answerPersonQuestion({
      requestId: qNoAsker.request.id,
      expectedRevision: revNoAsker!,
      resolvedBy: f.userId,
      response: { kind: "form", answers: { answer: ["done"] } },
    });
    await storeFixture.database
      .updateTable("requests")
      .set({ resolvedAt: new Date(sinceBeforeNoAskerAnswer.getTime() + 10_000) })
      .where("id", "=", qNoAsker.request.id)
      .execute();

    const changedB = await callB("opensteer_task_list", {
      changedSince: sinceBeforeNoAskerAnswer.toISOString(),
    });
    expect(changedB.isError, JSON.stringify(changedB.content)).not.toBe(true);
    expect(
      (changedB.structuredContent as { tasks: { id: string }[] }).tasks.find(
        ({ id }) => id === taskB2,
      ),
    ).toBeUndefined();

    // And B's own Request on B's own task remains visible across all four surfaces.
    const qOwnB = await storeFixture.store.requests.create({
      callId: "own-b-question",
      kind: "person.question",
      mode: "durable",
      originatingRunId: runB.runId,
      originatingThreadId: taskB,
      requestedBy: f.userId,
      requiredActor: "requester",
      payload: { kind: "person.question" },
      presentation: questionPresentation,
    });
    const ownPendingListB = await callB("opensteer_task_list", { hasPendingRequests: true });
    expect(ownPendingListB.isError, JSON.stringify(ownPendingListB.content)).not.toBe(true);
    expect(
      (ownPendingListB.structuredContent as { tasks: { id: string; pendingRequests: number }[] })
        .tasks,
    ).toEqual([expect.objectContaining({ id: taskB, pendingRequests: 1 })]);
    const ownReadBB = await callB("opensteer_task_read", { taskId: taskB });
    expect(ownReadBB.isError, JSON.stringify(ownReadBB.content)).not.toBe(true);
    expect(
      (ownReadBB.structuredContent as { task: { pendingRequests: number } }).task.pendingRequests,
    ).toBe(1);
    const ownReqReadB = await callB("opensteer_request_read", { requestId: qOwnB.request.id });
    expect(ownReqReadB.isError, JSON.stringify(ownReqReadB.content)).not.toBe(true);
    expect((ownReqReadB.structuredContent as { request: { id: string } }).request.id).toBe(
      qOwnB.request.id,
    );
  });

  it("hides Requests on tasks whose execution environment is unavailable in both list and read", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("lineage-unavailable-env");
    const runScopes: Record<string, RunToolScope> = {};
    const url = await serveMcp(storeFixture, { runScopes });
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
      grant: { scope: "everything" },
    });
    const liveTask = await createTask(agent, f, "live-env-reader");
    const unavailableTask = await createTask(agent, f, "unavailable-env-task");
    const liveRun = await startPersonalQueuedRunFixture(
      storeFixture.store,
      (await queuedRun(storeFixture, liveTask)).id,
    );
    const unavailableRun = await startPersonalQueuedRunFixture(
      storeFixture.store,
      (await queuedRun(storeFixture, unavailableTask)).id,
    );
    runScopes["live-run"] = fixtureRunScope({ ...f, ...liveRun, threadId: liveTask });
    const client = await runClient(url, "live-run");
    const call = (name: string, arguments_: Record<string, unknown>) =>
      client.callTool({ name, arguments: arguments_ });

    const req = await storeFixture.store.requests.create({
      callId: "unavailable-env-question",
      kind: "person.question",
      mode: "durable",
      originatingRunId: unavailableRun.runId,
      originatingThreadId: unavailableTask,
      requestedBy: f.userId,
      requiredActor: "requester",
      payload: { kind: "person.question" },
      presentation: {
        kind: "form",
        title: "Unavailable env question",
        fields: [
          { id: "answer", prompt: "Ready?", secret: false, custom: true, multiSelect: false },
        ],
      },
    });

    const unavailableEnv = await storeFixture.store.createEnvironment({
      kind: "local",
      name: "Unavailable computer",
      runnerId: null,
    });
    const unavailableHarnessId = createId("harnessInstance");
    await storeFixture.database
      .insertInto("harnessInstances")
      .values({
        id: unavailableHarnessId,
        environmentId: unavailableEnv,
        driverKind: "native",
        name: "Unavailable Harness",
        config: sql`'{}'::jsonb`,
        runtimeRevision: 1,
        stateKind: "isolated",
        enabled: true,
        isDefault: false,
        sourceId: "unavailable-env-fixture",
      })
      .execute();
    await storeFixture.database
      .updateTable("threads")
      .set({ environmentId: unavailableEnv, harnessInstanceId: unavailableHarnessId })
      .where("id", "=", unavailableTask)
      .execute();

    const listedAll = await call("opensteer_request_list", { status: "all" });
    expect(listedAll.isError, JSON.stringify(listedAll.content)).not.toBe(true);
    expect((listedAll.structuredContent as { requests: unknown[] }).requests).toEqual([]);

    const listedTask = await call("opensteer_request_list", {
      taskId: unavailableTask,
      status: "all",
    });
    expect(listedTask.isError, JSON.stringify(listedTask.content)).not.toBe(true);
    expect((listedTask.structuredContent as { requests: unknown[] }).requests).toEqual([]);

    expect(await call("opensteer_request_read", { requestId: req.request.id })).toEqual(
      await call("opensteer_request_read", { requestId: createId("request") }),
    );

    const pendingTasks = await call("opensteer_task_list", { hasPendingRequests: true });
    expect(pendingTasks.isError, JSON.stringify(pendingTasks.content)).not.toBe(true);
    expect(
      (pendingTasks.structuredContent as { tasks: { id: string }[] }).tasks.map(({ id }) => id),
    ).not.toContain(unavailableTask);
  });
});
