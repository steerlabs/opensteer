import { CommandTools } from "./handlers/commands.js";
import {
  createId,
  DeviceIdSchema,
  TabIdSchema,
  WindowIdSchema,
  type AgentGrant,
  type ExecutionNodeId,
  type RunId,
  type TabId,
  type ThreadId,
} from "@opensteer/core";
import * as databaseModule from "@opensteer/database";
import {
  AgentConnectionStore,
  TabStore,
  TriggerStore,
  beginAgentSession,
  readAgentThreadRecent,
} from "@opensteer/database";
import pg from "pg";
import { expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describeStore, testModelSelection } from "@opensteer/database/test-support/store";
import { startPersonalQueuedRunFixture } from "@opensteer/database/test-support/personal-run";
import { sql } from "kysely";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { RunToolScope } from "../agents/run-tool-tokens.js";
import type { TabActor } from "../tabs/ports.js";
import {
  authorizeTabActor,
  canReadTab,
  readableTabTasks,
  tabComputer,
  tabReadAuthority,
} from "../tabs/tab-authority.js";
import { TabService } from "../tabs/tab-service.js";
import { CommandService, KeyedAdmissionQueue, RealtimeHub } from "@opensteer/orchestration";
import { ThreadService } from "../threads/thread-service.js";
import type { AgentCaller } from "./agent-caller.js";
import { ProductToolHandlers } from "./handlers/product.js";
import { personalTestExecution } from "./personal-execution.test-support.js";
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

  it("a tab on an extension's page does not exist to a connection's lineage (N3)", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("lineage-extension-page");
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
    const url = await serveMcp(storeFixture, {});
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
      grant,
    });
    const own = await createTask(agent, f, "extension-page-own");
    const ownRun = await startPersonalQueuedRunFixture(
      storeFixture.store,
      (await queuedRun(storeFixture, own)).id,
    );
    const tab = async (label: string, address: string): Promise<TabId> => {
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
          title: `Title ${label}`,
          url: address,
          profileId,
          profileName: "Shared",
          openedBy: { taskId: own },
          pageBinding: { lineageId: sessionId, sessionId, surfaceId: id },
        },
        label,
      );
      return id;
    };
    const extensionPage = `chrome-extension://${"a".repeat(32)}/options.html`;
    // The Home's tab store keeps no extension address: neither a new tab's nor a navigation's.
    await expect(tab("refused", extensionPage)).rejects.toThrow();
    const webTab = await tab("web", "https://web.test/");
    const extensionTab = await tab("extension", "https://was-web.test/");
    const written = await tabs.get(f.userId, extensionTab, true);
    await expect(
      tabs.updatePage(f.userId, extensionTab, written!.generation, written!.pageBinding!, {
        title: "Options",
        url: extensionPage,
      }),
    ).rejects.toThrow();
    // Should a row ever hold one, the authority still says it does not exist to the lineage.
    await storeFixture.database
      .updateTable("personalTabs")
      .set({ url: extensionPage, title: "My Extension Options" })
      .where("id", "=", extensionTab)
      .execute();
    const unused = async (): Promise<never> => {
      throw new Error("Unexpected native work");
    };
    const service = new TabService({
      store: tabs,
      devices: storeFixture.store,
      pages: {
        open: unused,
        state: async () => ({ state: "open" as const, usedBy: [{ taskId: own }] }),
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
      canRead: canReadTab,
      readAuthority: tabReadAuthority,
      canReadTask: async (actor, id, db) => (await readableTabTasks(actor, [id], db)).has(id),
      readableTasks: readableTabTasks,
      authorize: unused,
      authorizeMembership: authorizeTabActor,
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
    const connectionActor = {
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
    } as const satisfies TabActor;
    try {
      for (const actor of [connectionActor, { kind: "run", claims }] as TabActor[]) {
        // Not listed (tab_list, discover and browser_use's pages() all project through here).
        const { tabs: shown } = await service.project(actor);
        expect(
          shown.map(({ tabId }) => tabId),
          actor.kind,
        ).toEqual([webTab]);
        expect(JSON.stringify(shown)).not.toContain("chrome-extension:");
        // Not readable: the same answer as a tab that never existed.
        const row = await tabs.get(f.userId, extensionTab, true);
        expect(await canReadTab(actor, row!, storeFixture.database), actor.kind).toBe(false);
      }
      const absent = await service
        .connectionTab(connectionActor, TabIdSchema.parse("bsf_absent"))
        .catch((error: unknown) => error);
      const hidden = await service
        .connectionTab(connectionActor, extensionTab)
        .catch((error: unknown) => error);
      expect(hidden).toMatchObject({ code: "not_found", message: "Tab not found." });
      expect({ ...(hidden as object) }).toEqual({ ...(absent as object) });
      // The person sees it.
      const { tabs: person } = await service.project({ kind: "person", ownerId: f.userId });
      expect(person.map(({ tabId }) => tabId).sort()).toEqual([extensionTab, webTab].sort());
    } finally {
      service.dispose();
    }
  });

  it("keeps an extension page's place for the person and their own agents, and from every connection, but not a Mac app's or phone's (P3, P9)", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("extension-place");
    const tabs = new TabStore(storeFixture.database);
    const runScopes: Record<string, RunToolScope> = {};
    const url = await serveMcp(storeFixture, {
      runScopes,
      tabs: {
        get: async (owner, tabId) => {
          const row = await tabs.get(owner, tabId, true);
          if (!row) throw new Error("No such tab");
          return { ...row, profile: null } as never;
        },
      },
    });
    const tab = async (label: string): Promise<TabId> => {
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
          url: "https://web.test/",
          openedBy: "person",
          pageBinding: { lineageId: sessionId, sessionId, surfaceId: id },
        },
        label,
      );
      return id;
    };
    const extensionTab = await tab("extension");
    const webTab = await tab("web");
    // A Mac app's window and a phone's screen: places without an address, never pages.
    const windowTab = TabIdSchema.parse("bsf_window");
    await tabs.open(
      {
        id: windowTab,
        ownerId: f.userId,
        computerId: DeviceIdSchema.parse(f.runnerId),
        kind: "window",
        windowId: WindowIdSchema.parse(`win_${randomUUID()}`),
        windowApp: { bundleId: "test.app", displayName: "Test", teamId: null },
        title: "Window",
        openedBy: "person",
      },
      "window",
    );
    const phoneTab = TabIdSchema.parse("bsf_phone");
    await tabs.open(
      {
        id: phoneTab,
        ownerId: f.userId,
        computerId: DeviceIdSchema.parse(f.runnerId),
        kind: "phone",
        title: "iPhone",
        openedBy: "person",
      },
      "phone",
    );
    // One of your own agents' Runs entered an extension's options page, a web page, a Mac app's
    // window and a phone's screen: the extension's page keeps no site (it has no web origin), as
    // rows always have, and so do the window and the screen.
    for (const [tabId, title, site] of [
      [extensionTab, "My Extension Options", null],
      [webTab, "Web", "https://web.test"],
      [windowTab, "Window", null],
      [phoneTab, "iPhone", null],
    ] as const)
      await storeFixture.store.recordRunTabPlace({
        runId: f.runId,
        bindingGeneration: f.bindingGeneration,
        data: { tabId, title, site },
      });
    const placesOf = (result: Awaited<ReturnType<Client["callTool"]>>) => {
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      return (result.structuredContent as { recentPlaces: { tabId: string }[] }).recentPlaces
        .map(({ tabId }) => tabId)
        .sort();
    };
    const all = [extensionTab, webTab, windowTab, phoneTab].sort();
    // The Run itself reads all four.
    runScopes.own = fixtureRunScope({ ...f, threadId: f.threadId });
    const own = await runClient(url, "own");
    expect(
      placesOf(
        await own.callTool({ name: "opensteer_task_read", arguments: { taskId: f.threadId } }),
      ),
    ).toEqual(all);
    // So does the person's record of the task.
    const recent = await readAgentThreadRecent(storeFixture.database, {
      threadId: f.threadId,
      ownerId: f.userId,
      runLimit: 5,
    });
    expect(recent?.places.map(({ tabId }) => tabId).sort()).toEqual(all);
    // A connection that may read every task reads the web tab's place, the window's and the
    // screen's: the page rule judges only a browser tab's place.
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
      grant: { scope: "everything" },
    });
    expect(
      placesOf(
        await agent.client.callTool({
          name: "opensteer_task_read",
          arguments: { taskId: f.threadId },
        }),
      ),
    ).toEqual([webTab, windowTab, phoneTab].sort());
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
      script: {
        interpreter: null,
        text: "console.log('ok')",
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
        driverKind: f.harnessInstance.driverKind,
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

  it("applies connectionRequests inside SQL before pending caps and activity paging, matching absence byte-for-byte across Request-derived fields (excluding task.status, which stays truthful as the task's own state)", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("lineage-sql-paging-and-caps");
    const runScopes: Record<string, RunToolScope> = {};
    // The state tool over the person's own Needs you list (every pending Request, as the person
    // reads it); what the tool cuts it to is the code under test.
    const commands = new CommandTools({
      database: storeFixture.database,
      registry: {} as never,
      requests: () => undefined,
      administration: {} as never,
      reads: () => ({
        "requests.list": async () => ({
          ok: true,
          data: {
            requests: (
              await storeFixture.database
                .selectFrom("requests")
                .select(["id", "originatingThreadId"])
                .where("requestedBy", "=", f.userId)
                .where("status", "=", "pending")
                .orderBy("id")
                .execute()
            ).map((request) => ({ request })),
          },
        }),
      }),
    });
    const url = await serveMcp(storeFixture, { runScopes, commands });
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
    const taskA = await createTask(agentA, f, "r5-reader");
    const taskB = await createTask(agentB, f, "r5-pending-cap");
    const runA = await startPersonalQueuedRunFixture(
      storeFixture.store,
      (await queuedRun(storeFixture, taskA)).id,
    );
    const runB = await startPersonalQueuedRunFixture(
      storeFixture.store,
      (await queuedRun(storeFixture, taskB)).id,
    );
    runScopes["r5-run-a"] = fixtureRunScope({ ...f, ...runA, threadId: taskA });
    const clientA = await runClient(url, "r5-run-a");
    const callA = (name: string, arguments_: Record<string, unknown>) =>
      clientA.callTool({ name, arguments: arguments_ });

    const questionPresentation = (title: string) => ({
      kind: "form" as const,
      title,
      fields: [{ id: "answer", prompt: "Ready?", secret: false, custom: true, multiSelect: false }],
    });

    // 1. 26 earlier hidden pending Requests from connection B + 1 newer visible pending Request
    // (person automation, no connection asker): visible Request must survive the 25-row cap.
    for (let i = 0; i < 26; i++) {
      await storeFixture.store.requests.create({
        callId: `r5-hidden-pending-${i}`,
        kind: "person.question",
        mode: "durable",
        originatingRunId: runB.runId,
        originatingThreadId: taskB,
        requestedBy: f.userId,
        requiredActor: "requester",
        payload: { kind: "person.question" },
        presentation: questionPresentation(`Hidden ${i}`),
      });
    }
    const triggers = new TriggerStore(storeFixture.database);
    const automation = await triggers.create({
      actorThreadId: null,
      anchorThreadId: taskB,
      createdBy: f.userId,
      idempotencyKey: "r5-person-automation-on-b",
      name: "Person automation on B",
      script: {
        interpreter: null,
        text: "console.log('ok')",
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
    await storeFixture.store.claimCommand(occurrence.commandId, "r5-occurrence");
    await triggers.startExecution({
      runnerId: f.runnerId,
      runnerBootId: f.runnerBootId,
      commandId: occurrence.commandId,
    });
    const visiblePending = await storeFixture.store.requests.create({
      callId: "r5-visible-pending",
      kind: "person.question",
      mode: "durable",
      originatingOccurrenceId: occurrence.id,
      originatingThreadId: taskB,
      requestedBy: f.userId,
      requiredActor: "requester",
      payload: { kind: "person.question" },
      presentation: questionPresentation("Visible after 26 hidden"),
    });

    const cappedRead = await callA("opensteer_task_read", { taskId: taskB });
    expect(cappedRead.isError, JSON.stringify(cappedRead.content)).not.toBe(true);
    const cappedBody = cappedRead.structuredContent as {
      task: { pendingRequests: number };
      pendingRequests?: { id: string }[];
    };
    expect(cappedBody.task.pendingRequests).toBe(1);
    expect(cappedBody.pendingRequests?.map(({ id }) => id)).toEqual([visiblePending.request.id]);

    // The state tool's requests area is the same one predicate (K5): what this lineage may see
    // of B's task is there, the hidden ones are not, and one more hidden changes no byte.
    const stateRequests = async () => {
      const state = await callA("opensteer_state", { area: "requests" });
      expect(state.isError, JSON.stringify(state.content)).not.toBe(true);
      return state.structuredContent as {
        view: { requests: { request: { id: string; originatingThreadId: string } }[] };
      };
    };
    const stateBefore = await stateRequests();
    expect(
      stateBefore.view.requests
        .filter(({ request }) => request.originatingThreadId === taskB)
        .map(({ request }) => request.id),
    ).toEqual([visiblePending.request.id]);
    await storeFixture.store.requests.create({
      callId: "r5-hidden-pending-state",
      kind: "person.question",
      mode: "durable",
      originatingRunId: runB.runId,
      originatingThreadId: taskB,
      requestedBy: f.userId,
      requiredActor: "requester",
      payload: { kind: "person.question" },
      presentation: questionPresentation("Hidden from the state tool"),
    });
    expect(JSON.stringify(await stateRequests())).toBe(JSON.stringify(stateBefore));

    // 2. Default (messagesOnly) and activity views: a newer hidden person.question from B must
    // neither appear nor shorten/split pages or change page bytes compared to its absence.
    const taskBActivity = await createTask(agentB, f, "r5-activity-paging");
    const runBActivity = await startPersonalQueuedRunFixture(
      storeFixture.store,
      (await queuedRun(storeFixture, taskBActivity)).id,
    );
    await storeFixture.store.enqueueThreadInput({
      threadId: taskBActivity,
      requestedBy: f.userId,
      policy: "report",
      content: [{ type: "text", text: "Second visible message" }],
      source: { kind: "human" },
      idempotencyKey: "r5-second-visible-message",
    });

    // Compared fields (all Request-derived and paged outputs): items, hasMore, nextBefore,
    // pendingRequests, and task.pendingRequests. task.status is explicitly excluded because
    // a task's status is the task's own state and stays truthful while the Request stays hidden.
    const requestScopedAbsenceSlice = (result: Awaited<ReturnType<typeof callA>>) => {
      const body = result.structuredContent as {
        items: unknown[];
        hasMore: boolean;
        nextBefore: string | null;
        pendingRequests?: unknown[];
        task: { pendingRequests: number; status: string };
      };
      return {
        items: body.items,
        hasMore: body.hasMore,
        nextBefore: body.nextBefore,
        pendingRequests: body.pendingRequests ?? null,
        taskPendingRequests: body.task.pendingRequests,
      };
    };
    const taskStatus = (result: Awaited<ReturnType<typeof callA>>) =>
      (result.structuredContent as { task: { status: string } }).task.status;

    const baseDefault = await callA("opensteer_task_read", { taskId: taskBActivity, limit: 2 });
    expect(baseDefault.isError, JSON.stringify(baseDefault.content)).not.toBe(true);
    expect(requestScopedAbsenceSlice(baseDefault).items).toHaveLength(2);
    expect(requestScopedAbsenceSlice(baseDefault).hasMore).toBe(false);
    expect(taskStatus(baseDefault)).toBe("running");

    const baseActivity = await callA("opensteer_task_read", {
      taskId: taskBActivity,
      view: "activity",
      limit: 2,
    });
    expect(baseActivity.isError, JSON.stringify(baseActivity.content)).not.toBe(true);
    expect(requestScopedAbsenceSlice(baseActivity).items).toHaveLength(2);
    expect(requestScopedAbsenceSlice(baseActivity).hasMore).toBe(false);

    const hiddenActivityReq = await storeFixture.store.requests.create({
      callId: "r5-hidden-activity-question",
      kind: "person.question",
      mode: "durable",
      originatingRunId: runBActivity.runId,
      originatingThreadId: taskBActivity,
      requestedBy: f.userId,
      requiredActor: "requester",
      payload: { kind: "person.question" },
      presentation: questionPresentation("Hidden newest question"),
    });
    // Reflect the task's own waiting state while B's Run waits on that hidden Request.
    await storeFixture.database
      .updateTable("runs")
      .set({ status: "waiting" })
      .where("id", "=", runBActivity.runId)
      .execute();
    await storeFixture.database
      .updateTable("threads")
      .set({ status: "waiting" })
      .where("id", "=", taskBActivity)
      .execute();

    const afterDefault = await callA("opensteer_task_read", { taskId: taskBActivity, limit: 2 });
    expect(afterDefault.isError, JSON.stringify(afterDefault.content)).not.toBe(true);
    expect(afterDefault.structuredContent).not.toHaveProperty("pendingRequests");
    expect(JSON.stringify(afterDefault.structuredContent)).not.toContain(
      hiddenActivityReq.request.id,
    );
    expect(JSON.stringify(requestScopedAbsenceSlice(afterDefault))).toBe(
      JSON.stringify(requestScopedAbsenceSlice(baseDefault)),
    );
    // Excluded from the absence comparison above: task.status truthfully reports the task's own state.
    expect(taskStatus(afterDefault)).toBe("waiting");

    const afterActivity = await callA("opensteer_task_read", {
      taskId: taskBActivity,
      view: "activity",
      limit: 2,
    });
    expect(afterActivity.isError, JSON.stringify(afterActivity.content)).not.toBe(true);
    expect(JSON.stringify(afterActivity.structuredContent)).not.toContain(
      hiddenActivityReq.request.id,
    );
    expect(JSON.stringify(requestScopedAbsenceSlice(afterActivity))).toBe(
      JSON.stringify(requestScopedAbsenceSlice(baseActivity)),
    );
    expect(taskStatus(afterActivity)).toBe("waiting");

    const architectureDoc = readFileSync(
      new URL("../../../../docs/architecture.md", import.meta.url),
      "utf8",
    );
    expect(architectureDoc).toMatch(/status.*task's own state.*truthful/iu);

    expect(
      await callA("opensteer_task_read", {
        taskId: taskBActivity,
        itemId: hiddenActivityReq.request.id,
      }),
    ).toEqual(
      await callA("opensteer_task_read", {
        taskId: taskBActivity,
        itemId: createId("request"),
      }),
    );
  });

  it("scopes pendingRequests in the handler itself for connection callers, even on tools not named opensteer_task_*", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("connection-handler-pending-count");
    const url = await serveMcp(storeFixture);
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
    const taskB = await createTask(agentB, f, "handler-foreign-parent");
    const runB = await startPersonalQueuedRunFixture(
      storeFixture.store,
      (await queuedRun(storeFixture, taskB)).id,
    );
    const childB = await storeFixture.store.delegateThread({
      accessMode: "full-access",
      createdBy: f.userId,
      environmentId: f.environmentId,
      harnessInstanceId: f.harnessInstance.id,
      idempotencyKey: "handler-foreign-child",
      modelSelection: testModelSelection,
      origin: { kind: "run", parentRunId: runB.runId, parentThreadId: taskB },
      task: [{ type: "text", text: "Foreign child work" }],
      title: "Foreign child task",
    });
    const childRunB = await startPersonalQueuedRunFixture(storeFixture.store, childB.run.id);
    await storeFixture.store.requests.create({
      callId: "handler-foreign-child-question",
      kind: "person.question",
      mode: "durable",
      originatingRunId: childRunB.runId,
      originatingThreadId: childB.thread.id,
      requestedBy: f.userId,
      requiredActor: "requester",
      payload: { kind: "person.question" },
      presentation: {
        kind: "form",
        title: "Foreign connection question",
        fields: [
          { id: "answer", prompt: "Ready?", secret: false, custom: true, multiSelect: false },
        ],
      },
    });

    const unavailable = new Proxy(
      {},
      {
        get: () => async () => {
          throw new Error("Unexpected tool");
        },
      },
    );
    const realtime = new RealtimeHub();
    const commands = new CommandService({
      store: storeFixture.store,
      admission: new KeyedAdmissionQueue({
        maxInFlight: 8,
        maxQueuedBytes: 1024 * 1024,
        maxQueuedCommands: 100,
      }),
      onExecutionQueued: () => {},
    });
    const settings = await storeFixture.database
      .selectFrom("personalSettings")
      .selectAll()
      .executeTakeFirstOrThrow();
    const threads = new ThreadService({
      store: storeFixture.store,
      commands,
      runners: {
        canRunHarness: () => true,
        isAvailable: () => true,
        harnessAccessModes: () => undefined,
        identityForEnvironment: () => undefined,
        attachmentInputFailure: () => null,
      },
      placeContext: unavailable as never,
      browser: unavailable as never,
    });
    const handlers = new ProductToolHandlers({
      execution: personalTestExecution(storeFixture.store, {
        userId: settings.ownerId,
        environmentId: f.environmentId,
        agentHome: { computerId: settings.agentHomeComputerId, path: settings.agentHomePath },
      }),
      deploymentId: (
        await storeFixture.database.selectFrom("deployments").select("id").executeTakeFirstOrThrow()
      ).id,
      store: storeFixture.store,
      threads,
      realtime: {
        observe: realtime.observe.bind(realtime),
        observeScopes: realtime.observeScopes.bind(realtime),
        sendToUsers: realtime.sendToUsers.bind(realtime),
      },
      commands,
      browser: {
        readablePlaces: async (_owner: unknown, references: readonly unknown[]) => [...references],
      },
      isEnvironmentConnected: () => true,
      canRunHarness: () => true,
    } as unknown as ConstructorParameters<typeof ProductToolHandlers>[0]);

    const connectionACaller: AgentCaller = {
      kind: "connection",
      key: `connection:${agentA.id}`,
      connectionId: agentA.id,
      grant: { scope: "everything" },
      grantRevision: 1,
      userId: f.userId,
      accessMode: "full-access",
    };

    // opensteer_delegation_status is NOT named opensteer_task_*, so withoutRequestCounts
    // does not strip its output: the handler itself must not carry another connection's count.
    const delegation = await handlers.opensteer_delegation_status({
      caller: connectionACaller,
      input: { delegationId: childB.assignment.id },
      operationKey: "p2-delegation-status",
    });
    expect(delegation.pendingRequests).toBe(0);
  });

  it("computes scoped pendingRequests inside the read transaction without separate countPendingConnectionRequests queries", async ({
    storeFixture,
  }) => {
    const countStatements = async (action: () => Promise<unknown>): Promise<number> => {
      let count = 0;
      const prototype: { query(...args: unknown[]): unknown } = pg.Client.prototype;
      const query = prototype.query;
      const spy = vi.spyOn(prototype, "query").mockImplementation(function (
        this: pg.Client,
        ...args: unknown[]
      ) {
        count += 1;
        return Reflect.apply(query, this, args);
      });
      try {
        await action();
      } finally {
        spy.mockRestore();
      }
      return count;
    };

    const f = await storeFixture.startRunFixture("p3-inline-scoped-counts");
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
    const taskA = await createTask(agentA, f, "p3-lineage-parent");
    const taskB = await createTask(agentB, f, "p3-foreign-parent");
    const runA = await startPersonalQueuedRunFixture(
      storeFixture.store,
      (await queuedRun(storeFixture, taskA)).id,
    );
    const runB = await startPersonalQueuedRunFixture(
      storeFixture.store,
      (await queuedRun(storeFixture, taskB)).id,
    );
    runScopes["p3-run-a"] = fixtureRunScope({ ...f, ...runA, threadId: taskA });
    const clientA = await runClient(url, "p3-run-a");
    const callA = (name: string, arguments_: Record<string, unknown>) =>
      clientA.callTool({ name, arguments: arguments_ });

    // Child delegation of runA, settled so wait returns immediately.
    const childA = await storeFixture.store.delegateThread({
      accessMode: "full-access",
      createdBy: f.userId,
      environmentId: f.environmentId,
      harnessInstanceId: f.harnessInstance.id,
      idempotencyKey: "p3-settled-child",
      modelSelection: testModelSelection,
      origin: { kind: "run", parentRunId: runA.runId, parentThreadId: taskA },
      task: [{ type: "text", text: "Child work" }],
      title: "Settled child",
    });
    await storeFixture.store.cancelAssignment({
      assignmentId: childA.assignment.id,
      requestedBy: f.userId,
      idempotencyKey: "p3-settled-child-cancel",
    });

    // Foreign connection B's pending Request on taskB (readable by everything-grant runA,
    // but B's Request must stay hidden so scoped pendingRequests is 0).
    const nodeB = await subagent(storeFixture, runB.runId);
    await storeFixture.store.requests.create({
      callId: "p3-foreign-question",
      kind: "person.question",
      mode: "durable",
      originatingRunId: runB.runId,
      originatingThreadId: taskB,
      requestedBy: f.userId,
      requiredActor: "requester",
      payload: { kind: "person.question" },
      presentation: {
        kind: "form",
        title: "Foreign question",
        fields: [
          { id: "answer", prompt: "Ready?", secret: false, custom: true, multiSelect: false },
        ],
      },
    });

    // Warm each call once, check scoped pendingRequests === 0, then measure statements.
    const warmSubagent = await callA("opensteer_subagent_read", { subagentId: nodeB });
    expect(warmSubagent.isError, JSON.stringify(warmSubagent.content)).not.toBe(true);
    expect(
      (warmSubagent.structuredContent as { task: { pendingRequests: number } }).task
        .pendingRequests,
    ).toBe(0);

    const warmDelegation = await callA("opensteer_delegation_status", {
      delegationId: childA.assignment.id,
    });
    expect(warmDelegation.isError, JSON.stringify(warmDelegation.content)).not.toBe(true);
    expect((warmDelegation.structuredContent as { pendingRequests: number }).pendingRequests).toBe(
      0,
    );

    const warmWait = await callA("opensteer_task_wait", {
      taskId: childA.thread.id,
      timeoutMs: 5_000,
    });
    expect(warmWait.isError, JSON.stringify(warmWait.content)).not.toBe(true);
    expect(
      warmWait.structuredContent as { status: string; task: { pendingRequests: number } },
    ).toMatchObject({ status: "settled", task: { pendingRequests: 0 } });

    const counts = {
      subagentRead: await countStatements(async () => {
        const res = await callA("opensteer_subagent_read", { subagentId: nodeB });
        expect(res.isError, JSON.stringify(res.content)).not.toBe(true);
      }),
      delegationStatus: await countStatements(async () => {
        const res = await callA("opensteer_delegation_status", {
          delegationId: childA.assignment.id,
        });
        expect(res.isError, JSON.stringify(res.content)).not.toBe(true);
      }),
      settledWait: await countStatements(async () => {
        const res = await callA("opensteer_task_wait", {
          taskId: childA.thread.id,
          timeoutMs: 5_000,
        });
        expect(res.isError, JSON.stringify(res.content)).not.toBe(true);
      }),
    };
    // Verify the inline scoped count inside getAssignmentForOwner (used by #task) and
    // getThreadForOwner (used by #readSubagent and standalone create) directly too.
    const authorityA = {
      kind: "connection" as const,
      userId: f.userId,
      connectionId: agentA.id,
      accessMode: "full-access" as const,
    };
    const scopedThreadB = await storeFixture.store.getThreadForOwner(
      taskB,
      f.userId,
      undefined,
      undefined,
      authorityA,
    );
    expect(scopedThreadB?.pendingRequests).toBe(0);
    const scopedAssignmentA = await storeFixture.store.getAssignmentForOwner({
      assignmentId: childA.assignment.id,
      ownerId: f.userId,
      reader: { kind: "person" },
      connectionAuthority: authorityA,
    });
    expect(scopedAssignmentA?.pendingRequests).toBe(0);
    expect("countPendingConnectionRequests" in databaseModule).toBe(false);
    // Before P3: subagentRead=28, delegationStatus=78, settledWait=239 (each had a separate
    // 5-statement countPendingConnectionRequests transaction; folding dropped 4 statements each,
    // and merging 808b6d4b1 trimmed 1 more from delegationStatus and 2 from settledWait).
    expect(counts).toEqual({
      subagentRead: 24,
      delegationStatus: 73,
      settledWait: 233,
    });
  });
});
