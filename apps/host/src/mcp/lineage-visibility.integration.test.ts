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
import { AgentConnectionStore, TabStore, beginAgentSession } from "@opensteer/database";
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
});
