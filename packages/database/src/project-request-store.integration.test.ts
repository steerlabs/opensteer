import {
  createId,
  AgentEventSchema,
  ProjectEngineRequestEventSchema,
  type ProjectEngineRequestEvent,
} from "@opensteer/core";
import { sql } from "kysely";
import { mutateAccess, plannedManagerlessProjects } from "./access-store.js";
import { ProjectWorkRevocationStore } from "./project-work-revocation.js";
import { ProjectWorkStopStore, reserveProjectWorkStop } from "./run-finalization.js";
import { expect } from "vitest";
import { createProjectIdentityFixture } from "./project-work.test-support.js";
import { requestFromRow } from "./request-persistence.js";
import { startExecutionNode } from "./execution-nodes.js";
import { projectRequestStorageSql } from "./project-authority-migration.js";
import { ProjectNotificationStore } from "./notification-store.js";
import { describeStore } from "./store.integration.test-support.js";
import {
  ProjectRequestStore,
  eligibleProjectRequestManagers,
  projectRequestRevocationHooks,
} from "./project-request-store.js";
import { projectRequestFixture, durableProjectControls } from "./project-request.test-support.js";

function proposal(binding: ProjectEngineRequestEvent["binding"]): ProjectEngineRequestEvent {
  return ProjectEngineRequestEventSchema.parse({
    type: "request.proposed.project",
    binding,
    data: {
      request: {
        id: createId("request"),
        callId: "provider-call",
        createdAt: new Date(0).toISOString(),
        mode: "live",
        kind: "harness.approval",
        requestClass: "harness-approval",
        payload: { kind: "harness.approval" },
        presentation: {
          kind: "choice",
          title: "Run command?",
          options: [{ id: "yes", hint: "allow-once", label: "Allow" }],
        },
      },
    },
  });
}

describeStore("Project Requests", (it) => {
  it("projects bounded payload-free facts for members using stored causes and current attribution", async ({
    storeFixture,
  }) => {
    const { database, store: legacy } = storeFixture;
    const fixture = await projectRequestFixture(storeFixture, "facts");
    const requests = new ProjectRequestStore(database);
    const member = await legacy.createUser("Member");
    const outsider = await legacy.createUser("Outsider");
    await database
      .updateTable("users")
      .set({ admittedAt: new Date() })
      .where("id", "in", [member, outsider])
      .execute();
    await database
      .insertInto("workspaceMemberships")
      .values({
        id: createId("workspaceMembership"),
        workspaceId: fixture.workspace.id,
        userId: member,
        role: "collaborator",
        state: "active",
        generation: 1,
        invitedBy: fixture.userId,
        joinedAt: new Date(),
        revokedAt: null,
        revokedBy: null,
        updatedAt: new Date(),
      })
      .execute();
    const event = proposal(fixture.binding);
    await database.transaction().execute((tx) => requests.propose(tx, event));
    let refusedQueries = 0;
    const poisonDatabase = database.withPlugin({
      transformQuery(args) {
        refusedQueries++;
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    });
    await expect(
      new ProjectRequestStore(poisonDatabase).activityFacts(
        { ...fixture.binding, workspaceId: createId("workspace") },
        { threadId: fixture.thread.id, requestIds: [event.data.request.id] },
        () => true,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(refusedQueries).toBe(0);
    const activity = await fixture.work.projectActivity(fixture.binding, {
      threadId: fixture.thread.id,
      limit: 50,
    });
    expect([...activity.requestActivity.values()]).toEqual([
      {
        title: "Approval",
        status: "pending",
        text: "Waiting for Alex",
        runId: fixture.run.id,
        type: "request.opened",
      },
    ]);
    expect(JSON.stringify([...activity.requestActivity.values()])).not.toContain("Run command?");
    const read = (userId = member) =>
      requests.threadFacts({ threadIds: [fixture.thread.id], userId });
    const facts = (await read()).get(fixture.thread.id)!;
    expect(facts.requestWaits).toMatchObject({
      total: 1,
      items: [
        {
          requestId: event.data.request.id,
          class: "approval",
          waitingOn: { kind: "person", name: "Alex" },
        },
      ],
    });
    expect(await read(fixture.userId)).toEqual(await read());
    const detail = await database
      .transaction()
      .execute((tx) =>
        requests.detailView(tx, { requestId: event.data.request.id, userId: fixture.userId }),
      );
    expect(detail).toMatchObject({
      answer: { allowed: true },
      waitingOn: { kind: "person", name: "Alex" },
      resolvedByName: null,
    });
    expect(detail.source).toBeUndefined();
    let viewQueries = 0;
    const viewDatabase = database.withPlugin({
      transformQuery(args) {
        viewQueries++;
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    });
    await viewDatabase
      .transaction()
      .execute((tx) => new ProjectRequestStore(viewDatabase).listViews(tx, fixture.userId));
    expect(viewQueries).toBe(3);

    expect(await read(outsider)).toEqual(new Map());
    const snapshot = await legacy.workspaceSnapshot(fixture.workspace.id, { viewerId: member });
    expect(snapshot.pendingRequests).toEqual([]);
    expect(snapshot.pendingRequestWindow.totalItems).toBe(0);
    expect(
      snapshot.threads.find((thread) => thread.id === fixture.thread.id)?.requestWaits,
    ).toEqual(facts.requestWaits);
    expect(JSON.stringify(snapshot)).not.toContain("Run command?");
    await expect(
      database.transaction().execute((tx) =>
        requests.detail(tx, {
          requestId: event.data.request.id,
          userId: member,
        }),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await database.transaction().execute((tx) =>
      requests.answer(tx, {
        requestId: event.data.request.id,
        userId: fixture.userId,
        sessionId: fixture.sessionId,
        response: { kind: "choice", optionId: "yes" },
      }),
    );
    await database
      .updateTable("users")
      .set({ displayName: "Renamed" })
      .where("id", "=", fixture.userId)
      .execute();
    const ended = (await read()).get(fixture.thread.id)!;
    const settledView = await database
      .transaction()
      .execute((tx) =>
        requests.detailView(tx, { requestId: event.data.request.id, userId: fixture.userId }),
      );
    expect(settledView.answer).toBeUndefined();
    expect(settledView.waitingOn).toBeNull();
    expect(settledView.resolvedByName).toBe("Renamed");
    await expect(
      database.transaction().execute((tx) =>
        requests.answer(tx, {
          requestId: event.data.request.id,
          userId: fixture.userId,
          sessionId: fixture.sessionId,
          response: { kind: "choice", optionId: "different" },
        }),
      ),
    ).rejects.toMatchObject({ code: "conflict", reason: "request-already-settled" });

    expect(ended.requestWaits).toEqual({ total: 0, items: [] });
    const settledActivity = await fixture.work.projectActivity(fixture.binding, {
      threadId: fixture.thread.id,
      limit: 50,
    });
    expect(
      [...settledActivity.requestActivity.values()].every(
        (item) => item.text === "Answered by Renamed",
      ),
    ).toBe(true);
    expect(ended.requestOutcomes).toEqual([
      {
        requestId: event.data.request.id,
        class: "approval",
        status: "fulfilled",
        at: expect.any(String),
        resolvedByName: "Renamed",
      },
    ]);
    await expect(
      database.deleteFrom("users").where("id", "=", fixture.userId).execute(),
    ).rejects.toMatchObject({ code: "23001" });
    const second = proposal(fixture.binding);
    second.data.request.callId = "second";
    second.data.request = {
      ...second.data.request,
      kind: "harness.input",
      requestClass: "question",
      payload: { kind: "harness.input" },
    };
    await database.transaction().execute((tx) => requests.propose(tx, second));
    const row = await database
      .selectFrom("requests")
      .selectAll()
      .where("id", "=", second.data.request.id)
      .executeTakeFirstOrThrow();
    await database
      .insertInto("requests")
      .values(
        Array.from({ length: 35 }, (_, i) => ({
          ...row,
          id: createId("request"),
          callId: `bulk-${i}`,
          createdAt: new Date(row.createdAt.getTime() + i + 1),
        })),
      )
      .execute();
    const bounded = (await read()).get(fixture.thread.id)!;
    viewQueries = 0;
    const views = await viewDatabase
      .transaction()
      .execute((tx) => new ProjectRequestStore(viewDatabase).listViews(tx, fixture.userId));
    expect(views).toHaveLength(36);
    expect(viewQueries).toBe(3);
    expect(bounded.requestWaits.total).toBe(36);
    expect(bounded.requestWaits.items).toHaveLength(32);
    expect(bounded.requestWaits.items[0]!.requestId).toBe(second.data.request.id);
    expect(bounded.requestWaits.items.every((item) => item.class === "question")).toBe(true);
    expect(JSON.stringify(bounded)).not.toContain("Run command?");
    await database.transaction().execute(async (tx) => {
      await reserveProjectWorkStop(tx, { runIds: [fixture.run.id] });
      await requests.cancelRun(tx, {
        runId: fixture.run.id,
        reason: "authority-revoked",
        resolvedAt: new Date(),
      });
    });
    const cancelled = (await read()).get(fixture.thread.id)!;
    const cancelView = await database
      .transaction()
      .execute((tx) =>
        requests.detailView(tx, { requestId: second.data.request.id, userId: fixture.userId }),
      );
    expect(cancelView.answer).toBeUndefined();
    expect(cancelView.cancelledFor).toEqual({ name: "Renamed" });
    const cancellationEvent = await database
      .selectFrom("workspaceEvents")
      .selectAll()
      .where("type", "=", "request.cancelled")
      .where(sql<boolean>`data->>'requestId' = ${second.data.request.id}`)
      .executeTakeFirstOrThrow();
    const parsedCancellation = AgentEventSchema.parse({
      ...cancellationEvent,
      createdAt: cancellationEvent.createdAt.toISOString(),
    });
    if (parsedCancellation.type !== "request.cancelled")
      throw new Error("Expected Request cancellation");
    const eventView = await database
      .transaction()
      .execute((tx) => requests.cancelledEventViews(tx, [parsedCancellation], fixture.userId));
    expect(eventView[0]?.data.cancelledFor).toEqual({ name: "Renamed" });

    expect(cancelled.requestWaits).toEqual({ total: 0, items: [] });
    expect(cancelled.requestOutcomes).toHaveLength(32);
    expect(
      cancelled.requestOutcomes.every(
        (item) => item.status === "cancelled" && item.cancelledFor?.name === "Renamed",
      ),
    ).toBe(true);
    await database
      .updateTable("users")
      .set({ memberState: "removed", authorityGeneration: "2" })
      .where("id", "=", fixture.userId)
      .execute();
    expect((await read()).get(fixture.thread.id)?.requestOutcomes).toEqual(
      cancelled.requestOutcomes,
    );
    await database
      .updateTable("users")
      .set({ memberState: "active", authorityGeneration: "3", displayName: "Rejoined" })
      .where("id", "=", fixture.userId)
      .execute();
    expect(
      (await read())
        .get(fixture.thread.id)
        ?.requestOutcomes.every(
          (item) => item.status === "cancelled" && item.cancelledFor?.name === "Rejoined",
        ),
    ).toBe(true);
    let queries = 0;
    const observed = database.withPlugin({
      transformQuery(args) {
        queries++;
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    });
    await new ProjectRequestStore(observed).threadFacts({
      threadIds: [fixture.thread.id],
      userId: member,
    });
    expect(queries).toBe(1);
    await new ProjectRequestStore(observed).threadFacts({ threadIds: [], userId: member });
    expect(queries).toBe(1);
  });

  for (const kind of ["personal", "server"] as const) {
    it(`refuses the no-manager producer before any write on model-1 ${kind}`, async ({
      storeFixture,
    }) => {
      const fixture = await createProjectIdentityFixture(
        storeFixture,
        `no-manager-${kind}`,
        1,
        kind,
      );
      const nodes: string[] = [];
      const observed = storeFixture.database.withPlugin({
        transformQuery(args) {
          nodes.push(args.node.kind);
          return args.node;
        },
        async transformResult(args) {
          return args.result;
        },
      });
      await expect(
        observed.transaction().execute((tx) =>
          new ProjectRequestStore(observed).cancelPlannedManagerless(tx, [fixture.workspace.id], {
            async stop() {
              throw new Error("Model 1 reached Project work cancellation");
            },
          }),
        ),
      ).rejects.toMatchObject({ code: "forbidden", message: "Project authority is not activated" });
      expect(nodes).toEqual(["SelectQueryNode"]);
    });
  }

  it("derives the human audience, persists once, resolves to the original grant, and rechecks continuation", async ({
    storeFixture,
  }) => {
    const fixture = await projectRequestFixture(storeFixture, "project-request-human");
    const { database } = storeFixture;
    const controls = durableProjectControls(database);
    const store = new ProjectRequestStore(database, controls.port);
    const event = proposal(fixture.binding);
    const opened = await controls.transact(database, (tx) => store.propose(tx, event));
    expect(opened.state).toBe("ready");
    if (opened.state !== "ready") throw new Error("Request was refused");
    expect(opened.request).toMatchObject({
      requestedBy: fixture.userId,
      requiredActor: "requester",
      originatingGrantId: fixture.grant.id,
    });
    expect(opened.request.createdAt).not.toBe(event.data.request.createdAt);
    expect(await controls.transact(database, (tx) => store.propose(tx, event))).toMatchObject({
      replayed: true,
    });
    await controls.transact(database, async (tx) => {
      expect(await store.count(tx, fixture.userId)).toBe(1);
      expect((await store.list(tx, fixture.userId)).map((row) => row.id)).toEqual([
        event.data.request.id,
      ]);
      expect(await store.recipients(tx, event.data.request.id)).toEqual([fixture.userId]);
      expect(
        (await store.detail(tx, { requestId: event.data.request.id, userId: fixture.userId })).id,
      ).toBe(event.data.request.id);
    });
    const notifications = new ProjectNotificationStore(database);
    expect((await notifications.decide(opened.events[0]!)).map((entry) => entry.userId)).toEqual([
      fixture.userId,
    ]);
    const managerId = await storeFixture.store.createUser("Other manager");
    await database
      .updateTable("users")
      .set({ admittedAt: new Date(), instanceRole: "administrator" })
      .where("id", "=", managerId)
      .execute();
    await database
      .insertInto("workspaceMemberships")
      .values({
        id: createId("workspaceMembership"),
        workspaceId: fixture.workspace.id,
        userId: managerId,
        role: "owner",
        state: "active",
        generation: 1,
        invitedBy: fixture.userId,
        joinedAt: new Date(),
        revokedAt: null,
        revokedBy: null,
        updatedAt: new Date(),
      })
      .execute();
    await controls.transact(database, async (tx) => {
      expect(await store.list(tx, managerId)).toEqual([]);
      expect(await store.count(tx, managerId)).toBe(0);
    });
    await expect(
      controls.transact(database, (tx) =>
        store.detail(tx, { requestId: event.data.request.id, userId: managerId }),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    const answer = {
      requestId: event.data.request.id,
      userId: fixture.userId,
      sessionId: fixture.sessionId,
      response: { kind: "choice" as const, optionId: "yes" },
    };
    await database
      .updateTable("authSessions")
      .set({ memberGeneration: "2" })
      .where("id", "=", fixture.sessionId)
      .execute();
    await expect(
      controls.transact(database, (tx) => store.answer(tx, answer)),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect((await controls.read()).length).toBe(0);
    expect(
      await database
        .selectFrom("requests")
        .select("status")
        .where("id", "=", answer.requestId)
        .executeTakeFirst(),
    ).toEqual({ status: "pending" });
    await database
      .updateTable("authSessions")
      .set({ memberGeneration: "1" })
      .where("id", "=", fixture.sessionId)
      .execute();
    await expect(
      controls.transact(database, (tx) => store.answer(tx, { ...answer, userId: managerId })),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(await controls.transact(database, (tx) => store.answer(tx, answer))).toMatchObject({
      replayed: false,
    });
    expect(await controls.transact(database, (tx) => store.answer(tx, answer))).toMatchObject({
      replayed: true,
    });
    expect(await controls.read()).toEqual([
      { kind: "request.resolve", requestId: answer.requestId, response: answer.response },
    ]);
    expect(await controls.transact(database, (tx) => store.canContinue(tx, answer.requestId))).toBe(
      true,
    );
    await database
      .updateTable("users")
      .set({ authorityGeneration: "2" })
      .where("id", "=", fixture.userId)
      .execute();
    expect(await controls.transact(database, (tx) => store.canContinue(tx, answer.requestId))).toBe(
      false,
    );
  });

  it("retains node attribution without letting a node change the human audience", async ({
    storeFixture,
  }) => {
    const fixture = await projectRequestFixture(storeFixture, "request-node");
    const { database } = storeFixture;
    const requests = new ProjectRequestStore(database);
    const nodeId = createId("executionNode");
    const event = proposal(fixture.binding);
    event.data.request.originatingNodeId = nodeId;
    await expect(
      database.transaction().execute((tx) => requests.propose(tx, event)),
    ).rejects.toMatchObject({ code: "forbidden" });
    await database.transaction().execute((tx) =>
      startExecutionNode(tx, {
        attemptId: fixture.grant.attemptId,
        runId: fixture.run.id,
        startedAt: new Date(),
        node: {
          nodeId,
          parentNodeId: null,
          kind: "subagent",
          title: "Inspect",
          prompt: null,
          model: null,
          nativeRef: "child-1",
          sessionRef: null,
          originCallId: null,
        },
      }),
    );
    const opened = await database.transaction().execute((tx) => requests.propose(tx, event));
    expect(opened).toMatchObject({
      state: "ready",
      request: {
        originatingNodeId: nodeId,
        requestedBy: fixture.userId,
        requiredActor: "requester",
      },
    });
    if (opened.state !== "ready") throw new Error("Expected attributed Request");
    expect(opened.events[0]).toMatchObject({ data: { request: { originatingNodeId: nodeId } } });
    expect(
      await database
        .transaction()
        .execute((tx) =>
          requests.detail(tx, { requestId: event.data.request.id, userId: fixture.userId }),
        ),
    ).toMatchObject({ originatingNodeId: nodeId });
  });

  it("refuses injected roots and unsupported proposals without a card; a lost-root refusal is idempotent", async ({
    storeFixture,
  }) => {
    const fixture = await projectRequestFixture(storeFixture, "project-request-refusal");
    const { database } = storeFixture;
    const controls = durableProjectControls(database);
    const store = new ProjectRequestStore(database, controls.port);
    const event = proposal(fixture.binding);
    const wrong = structuredClone(event);
    if (!wrong.binding.authority.origin) throw new Error("Expected root");
    wrong.binding.authority.origin.initiatorGeneration++;
    await expect(
      controls.transact(database, (tx) => store.propose(tx, wrong)),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      controls.transact(database, (tx) =>
        store.propose(tx, {
          ...event,
          data: { request: { ...event.data.request, kind: "browser.access" } },
        } as unknown as ProjectEngineRequestEvent),
      ),
    ).rejects.toThrow();
    await database
      .updateTable("users")
      .set({ authorityGeneration: "2" })
      .where("id", "=", fixture.userId)
      .execute();
    expect(await controls.transact(database, (tx) => store.propose(tx, event))).toMatchObject({
      state: "refused",
      control: { reason: "authority-revoked" },
    });
    expect(await controls.transact(database, (tx) => store.propose(tx, event))).toMatchObject({
      state: "refused",
    });
    expect((await controls.read()).length).toBe(1);
    expect(await database.selectFrom("requests").select("id").execute()).toHaveLength(0);
  });

  it("refuses a Project secret form before creating a card that its answer path cannot settle", async ({
    storeFixture,
  }) => {
    const fixture = await projectRequestFixture(storeFixture, "project-secret-form");
    const { database } = storeFixture;
    const controls = durableProjectControls(database);
    const requests = new ProjectRequestStore(database, controls.port);
    const event = ProjectEngineRequestEventSchema.parse({
      ...proposal(fixture.binding),
      data: {
        request: {
          ...proposal(fixture.binding).data.request,
          kind: "harness.input",
          requestClass: "question",
          payload: { kind: "harness.input" },
          presentation: {
            kind: "form",
            title: "Private credential",
            fields: [{ id: "credential", prompt: "Credential", secret: true }],
          },
        },
      },
    });
    for (let attempt = 0; attempt < 2; attempt++)
      expect(await controls.transact(database, (tx) => requests.propose(tx, event))).toMatchObject({
        state: "refused",
        control: { kind: "request.refuse", reason: "unsupported-request-kind" },
      });
    expect(await database.selectFrom("requests").select("id").execute()).toEqual([]);
    expect(await controls.read()).toHaveLength(1);
  });

  it("enforces grant scope, audience and immutable origin by direct SQL and retains the grant", async ({
    storeFixture,
  }) => {
    const fixture = await projectRequestFixture(storeFixture, "project-request-ddl");
    const { database } = storeFixture;
    const controls = durableProjectControls(database);
    const store = new ProjectRequestStore(database, controls.port);
    const event = proposal(fixture.binding);
    await controls.transact(database, (tx) => store.propose(tx, event));
    for (const change of [
      sql`requested_by = null`,
      sql`originating_grant_id = null`,
      sql`required_actor = 'workspace-owner'`,
      sql`call_id = 'changed'`,
    ]) {
      await expect(
        sql`update requests set ${change} where id = ${event.data.request.id}`.execute(database),
      ).rejects.toMatchObject({ code: "23514" });
    }
    await expect(
      sql`delete from grants where id = ${fixture.grant.id}`.execute(database),
    ).rejects.toMatchObject({ code: "23001" });
    await expect(
      sql`update grants set runner_boot_id = 'replacement' where id = ${fixture.grant.id}`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: "23514" });
    const other = await storeFixture.store.createUser("Administrator without this Project");
    await database
      .updateTable("users")
      .set({ admittedAt: new Date(), instanceRole: "administrator" })
      .where("id", "=", other)
      .execute();
    await expect(
      sql`update requests set status = 'fulfilled', resolved_by = ${other}, resolved_at = now(),
      response = '{"kind":"choice","optionId":"yes"}'::jsonb where id = ${event.data.request.id}`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: "23514" });
    const constraints = await sql<{ convalidated: boolean }>`select convalidated from pg_constraint
      where conname in ('requests_originating_grant_id_fkey', 'requests_requester_audience')`.execute(
      database,
    );
    expect(constraints.rows).toHaveLength(2);
    expect(constraints.rows.every((row) => !row.convalidated)).toBe(true);
  });

  for (const kind of ["member", "membership", "connection"] as const) {
    it(`cancels only the captured ${kind} root without contacting a Runner`, async ({
      storeFixture,
    }) => {
      const fixture = await projectRequestFixture(
        storeFixture,
        `project-request-cancel-${kind}`,
        kind === "connection" ? "connection" : "human",
      );
      const { database } = storeFixture;
      const controls = durableProjectControls(database);
      const store = new ProjectRequestStore(database, controls.port);
      const event = proposal(fixture.binding);
      await controls.transact(database, (tx) => store.propose(tx, event));
      const rootScope =
        kind === "member"
          ? { kind, userId: fixture.userId, memberGenerationCutoff: 1 }
          : kind === "membership"
            ? {
                kind,
                userId: fixture.userId,
                workspaceId: fixture.workspace.id,
                membershipGenerationCutoff: 1,
              }
            : {
                kind,
                userId: fixture.userId,
                workspaceId: fixture.workspace.id,
                connectionId: fixture.connectionId,
                memberGenerationCutoff: 1,
                membershipGenerationCutoff: 1,
              };
      expect(await database.transaction().execute((tx) => store.discover(tx, [rootScope]))).toEqual(
        { runIds: [fixture.run.id], workspaceIds: [fixture.workspace.id] },
      );

      await controls.transact(database, async (tx) => {
        await tx
          .selectFrom("runs")
          .select("id")
          .where("id", "=", fixture.run.id)
          .forNoKeyUpdate()
          .execute();
        await tx
          .selectFrom("workspaces")
          .select("id")
          .where("id", "=", fixture.workspace.id)
          .forNoKeyUpdate()
          .execute();
        const root =
          kind === "member"
            ? { kind, userId: fixture.userId, memberGenerationCutoff: 1 }
            : kind === "membership"
              ? {
                  kind,
                  userId: fixture.userId,
                  workspaceId: fixture.workspace.id,
                  membershipGenerationCutoff: 1,
                }
              : {
                  kind,
                  userId: fixture.userId,
                  workspaceId: fixture.workspace.id,
                  connectionId: fixture.connectionId,
                  memberGenerationCutoff: 1,
                  membershipGenerationCutoff: 1,
                };
        const older =
          root.kind === "member"
            ? { ...root, memberGenerationCutoff: 0 }
            : { ...root, membershipGenerationCutoff: 0 };
        expect((await store.cancel(tx, [older])).runIds).toEqual([]);
        const hooks = projectRequestRevocationHooks(store, {
          stop: async (transaction, input) => {
            expect(input).toEqual({
              runIds: [fixture.run.id],
              reason: "authority-revoked",
              requestEvents: expect.arrayContaining([
                expect.objectContaining({
                  type: "request.cancelled",
                  data: { requestId: event.data.request.id, reason: "authority-revoked" },
                }),
              ]),
            });
            await transaction
              .updateTable("runs")
              .set({ status: "interrupted", completedAt: new Date() })
              .where("id", "in", [...input.runIds])
              .execute();
          },
        });
        await hooks.cancel(tx, [root]);
      });
      expect(
        await database
          .selectFrom("requests")
          .select("status")
          .where("id", "=", event.data.request.id)
          .executeTakeFirst(),
      ).toEqual({ status: "cancelled" });
    });
  }

  it("adds the Request columns and NOT VALID constraints without scanning or rewriting existing rows", async ({
    storeFixture,
  }) => {
    const fixture = await projectRequestFixture(storeFixture, "project-request-scans");
    const { database } = storeFixture;
    const controls = durableProjectControls(database);
    const store = new ProjectRequestStore(database, controls.port);
    await controls.transact(database, (tx) => store.propose(tx, proposal(fixture.binding)));
    await controls.transact(database, async (tx) => {
      await sql`alter table requests drop column originating_grant_id, drop constraint requests_requester_audience`.execute(
        tx,
      );
      const facts = async () =>
        (
          await sql`select relname, relfilenode, pg_stat_get_xact_numscans(oid) as scans
        from pg_class where oid in ('requests'::regclass, 'grants'::regclass) order by relname`.execute(
            tx,
          )
        ).rows;
      const before = await facts();
      await projectRequestStorageSql.execute(tx);
      expect(await facts()).toEqual(before);
      const locks = await sql<{ relname: string; mode: string }>`select distinct c.relname, l.mode
        from pg_locks l join pg_class c on c.oid = l.relation where l.pid = pg_backend_pid()
        and l.granted and c.relname in ('requests', 'grants')`.execute(tx);
      expect(locks.rows).toContainEqual({ relname: "requests", mode: "AccessExclusiveLock" });
      expect(locks.rows).toContainEqual({ relname: "grants", mode: "ShareRowExclusiveLock" });
    });
  });

  it("counts only admitted full managers, never a guest or an administrator without manage", async ({
    storeFixture,
  }) => {
    const fixture = await projectRequestFixture(storeFixture, "project-request-managers");
    const { database } = storeFixture;
    const administrator = await storeFixture.store.createUser(
      "Administrator without Project access",
    );
    await database
      .updateTable("users")
      .set({ admittedAt: new Date(), instanceRole: "administrator" })
      .where("id", "=", administrator)
      .execute();
    expect(await eligibleProjectRequestManagers(database, fixture.workspace.id)).toEqual([
      fixture.userId,
    ]);
    await database
      .updateTable("users")
      .set({ memberKind: "guest" })
      .where("id", "=", fixture.userId)
      .execute();
    expect(await eligibleProjectRequestManagers(database, fixture.workspace.id)).toEqual([]);
  });
});

// These Requests originate in admitted Runs; no Request is created by a Watch occurrence.
describeStore("Unattended Project Requests", (it) => {
  it("addresses live managers consistently and resolves the original unattended attempt through durable controls", async ({
    storeFixture,
  }) => {
    const fixture = await projectRequestFixture(storeFixture, "unattended-answer", "unattended");
    const { database } = storeFixture;
    const controls = durableProjectControls(database);
    const requests = new ProjectRequestStore(database);
    const event = proposal(fixture.binding);
    const result = await controls.transact(database, (tx) => requests.propose(tx, event));
    expect(result).toMatchObject({
      state: "ready",
      request: {
        requestedBy: null,
        requiredActor: "workspace-owner",
        originatingGrantId: fixture.grant.id,
      },
    });
    if (result.state !== "ready") throw new Error("Expected manager Request");
    expect(result.events).toMatchObject([
      { type: "thread.execution-updated", threadId: fixture.thread.id },
    ]);
    expect(JSON.stringify(result.events)).not.toContain("Run command?");
    const display = await database
      .transaction()
      .execute((tx) =>
        requests.viewFacts(tx, { userId: fixture.userId, requestIds: [event.data.request.id] }),
      );
    expect(display.get(event.data.request.id)).toMatchObject({
      answer: { allowed: true },
      waitingOn: { kind: "managers" },
      source: { kind: "watch", name: "Files" },
    });
    await expect(
      database
        .transaction()
        .execute((tx) =>
          requests.detailView(tx, { requestId: event.data.request.id, userId: fixture.userId }),
        ),
    ).rejects.toMatchObject({ reason: "unattended-project-request-unsupported" });

    const activity = await fixture.work.projectActivity(fixture.binding, {
      threadId: fixture.thread.id,
      limit: 50,
    });
    expect([...activity.requestActivity.values()]).toEqual([
      {
        title: "Approval",
        status: "pending",
        text: "Waiting for managers",
        runId: fixture.run.id,
        type: "request.opened",
      },
    ]);
    const outsider = await storeFixture.store.createUser("Administrator");
    await database
      .updateTable("users")
      .set({ admittedAt: new Date(), instanceRole: "administrator" })
      .where("id", "=", outsider)
      .execute();
    await controls.transact(database, async (tx) => {
      expect(await requests.count(tx, fixture.userId)).toBe(1);
      expect((await requests.list(tx, fixture.userId)).map((row) => row.id)).toEqual([
        event.data.request.id,
      ]);
      expect(
        (await requests.detail(tx, { requestId: event.data.request.id, userId: fixture.userId }))
          .requestedBy,
      ).toBeNull();
      expect(await requests.recipients(tx, event.data.request.id)).toEqual([fixture.userId]);
      expect(await requests.count(tx, outsider)).toBe(0);
      expect(await requests.list(tx, outsider)).toEqual([]);
    });
    await expect(
      controls.transact(database, (tx) =>
        requests.detail(tx, { requestId: event.data.request.id, userId: outsider }),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    const manager = await storeFixture.store.createUser("Other manager");
    await database
      .updateTable("users")
      .set({ admittedAt: new Date() })
      .where("id", "=", manager)
      .execute();
    await database
      .insertInto("workspaceMemberships")
      .values([
        {
          id: createId("workspaceMembership"),
          workspaceId: fixture.workspace.id,
          userId: manager,
          role: "owner",
          state: "active",
          generation: 1,
        },
        {
          id: createId("workspaceMembership"),
          workspaceId: fixture.workspace.id,
          userId: outsider,
          role: "collaborator",
          state: "active",
          generation: 1,
        },
      ])
      .execute();
    for (const userId of [fixture.userId, manager, outsider]) {
      expect(
        (await requests.threadFacts({ threadIds: [fixture.thread.id], userId })).get(
          fixture.thread.id,
        )?.requestWaits,
      ).toMatchObject({ total: 1, items: [{ waitingOn: { kind: "managers" } }] });
    }
    const answer = {
      requestId: event.data.request.id,
      userId: fixture.userId,
      sessionId: fixture.sessionId,
      response: { kind: "choice" as const, optionId: "yes" },
    };
    await expect(
      controls.transact(database, (tx) => requests.answer(tx, { ...answer, userId: outsider })),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(await controls.transact(database, (tx) => requests.answer(tx, answer))).toMatchObject({
      replayed: false,
    });
    expect(await controls.transact(database, (tx) => requests.answer(tx, answer))).toMatchObject({
      replayed: true,
    });
    for (const userId of [manager, outsider]) {
      const facts = (await requests.threadFacts({ threadIds: [fixture.thread.id], userId })).get(
        fixture.thread.id,
      )!;
      expect(facts.requestWaits).toEqual({ total: 0, items: [] });
      expect(facts.requestOutcomes).toMatchObject([
        { status: "fulfilled", class: "approval", resolvedByName: "Alex" },
      ]);
    }
    const originalSession = await database
      .selectFrom("authSessions")
      .selectAll()
      .where("id", "=", fixture.sessionId)
      .executeTakeFirstOrThrow();
    const managerSessionId = createId("authSession");
    await database
      .insertInto("authSessions")
      .values({
        ...originalSession,
        id: managerSessionId,
        userId: manager,
        token: `other-${originalSession.token}`,
      })
      .execute();
    await expect(
      database
        .transaction()
        .execute((tx) =>
          requests.answer(tx, { ...answer, userId: manager, sessionId: managerSessionId }),
        ),
    ).rejects.toMatchObject({ code: "conflict", reason: "request-already-settled" });
    const commands = await database
      .selectFrom("commands")
      .selectAll()
      .where("type", "=", "run.control.project")
      .execute();
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      requestedBy: null,
      originatingGrantId: fixture.grant.id,
      payload: {
        binding: fixture.binding,
        control: {
          kind: "request.resolve",
          requestId: event.data.request.id,
          response: answer.response,
        },
      },
    });
    expect(
      await controls.transact(database, (tx) => requests.canContinue(tx, answer.requestId)),
    ).toBe(true);
    const competing = proposal(fixture.binding);
    competing.data.request.callId = "competing";
    await database.transaction().execute((tx) => requests.propose(tx, competing));
    const race = await Promise.allSettled([
      database
        .transaction()
        .execute((tx) => requests.answer(tx, { ...answer, requestId: competing.data.request.id })),
      database.transaction().execute((tx) =>
        requests.answer(tx, {
          ...answer,
          requestId: competing.data.request.id,
          userId: manager,
          sessionId: managerSessionId,
        }),
      ),
    ]);
    expect(race.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      race.filter((result) => result.status === "rejected").map((result) => result.reason),
    ).toMatchObject([{ code: "conflict", reason: "request-already-settled" }]);
    await database
      .updateTable("users")
      .set({ memberKind: "guest" })
      .where("id", "=", fixture.userId)
      .execute();
    expect(
      await controls.transact(database, (tx) => requests.canContinue(tx, answer.requestId)),
    ).toBe(false);
  });

  it("persists a managerless refusal without a card and never redecides it after a manager appears", async ({
    storeFixture,
  }) => {
    const fixture = await projectRequestFixture(storeFixture, "unattended-refuse", "unattended");
    const { database } = storeFixture;
    const controls = durableProjectControls(database);
    const requests = new ProjectRequestStore(database);
    await database
      .updateTable("users")
      .set({ memberKind: "guest" })
      .where("id", "=", fixture.userId)
      .execute();
    const event = proposal(fixture.binding);
    expect(await controls.transact(database, (tx) => requests.propose(tx, event))).toMatchObject({
      state: "refused",
      control: { reason: "no-eligible-manager" },
    });
    expect(await database.selectFrom("requests").select("id").execute()).toEqual([]);
    await expect(
      sql`update grants set runner_boot_id = 'readdressed' where id = ${fixture.grant.id}`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      sql`delete from grants where id = ${fixture.grant.id}`.execute(database),
    ).rejects.toMatchObject({ code: "23001" });

    await database
      .updateTable("users")
      .set({ memberKind: "full" })
      .where("id", "=", fixture.userId)
      .execute();
    expect(await controls.transact(database, (tx) => requests.propose(tx, event))).toMatchObject({
      state: "refused",
      control: { reason: "no-eligible-manager" },
    });
    expect(await controls.read()).toHaveLength(1);
    expect(await database.selectFrom("requests").select("id").execute()).toEqual([]);
    const newEvent = proposal(fixture.binding);
    newEvent.data.request.callId = "new-provider-call";
    expect(await controls.transact(database, (tx) => requests.propose(tx, newEvent))).toMatchObject(
      { state: "ready" },
    );
    await database
      .updateTable("triggerWatchActivations")
      .set({ executionGeneration: 2 })
      .where("workspaceId", "=", fixture.workspace.id)
      .execute();
    const staleSource = proposal(fixture.binding);
    staleSource.data.request.callId = "stale-source-call";
    expect(
      await controls.transact(database, (tx) => requests.propose(tx, staleSource)),
    ).toMatchObject({
      state: "refused",
      control: { reason: "authority-revoked" },
    });
  });

  it("cancels an unattended Run's card without sending the private row through the public DTO", async ({
    storeFixture,
  }) => {
    const fixture = await projectRequestFixture(storeFixture, "unattended-run-end", "unattended");
    const requests = new ProjectRequestStore(storeFixture.database);
    const event = proposal(fixture.binding);
    await storeFixture.database.transaction().execute((tx) => requests.propose(tx, event));
    const events = await storeFixture.store.requests.cancelForRun(fixture.run.id, "run-ended");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "request.cancelled",
          data: { requestId: event.data.request.id, reason: "run-ended" },
        }),
      ]),
    );
    expect(
      await storeFixture.database
        .selectFrom("requests")
        .select(["status", "requestedBy"])
        .where("id", "=", event.data.request.id)
        .executeTakeFirst(),
    ).toEqual({ status: "cancelled", requestedBy: null });
  });

  it("cancels managerless waits atomically with the work port and never revives them", async ({
    storeFixture,
  }) => {
    const fixture = await projectRequestFixture(
      storeFixture,
      "unattended-manager-loss",
      "unattended",
    );
    const { database } = storeFixture;
    const requests = new ProjectRequestStore(database);
    const event = proposal(fixture.binding);
    await database.transaction().execute((tx) => requests.propose(tx, event));
    expect(
      await database
        .transaction()
        .execute((tx) => requests.discoverManagerless(tx, [fixture.workspace.id])),
    ).toEqual({ runIds: [fixture.run.id], workspaceIds: [fixture.workspace.id] });
    await database
      .updateTable("users")
      .set({ memberState: "suspended", authorityGeneration: "2" })
      .where("id", "=", fixture.userId)
      .execute();
    const cancel = (work: import("./project-request-store.js").ProjectRequestStopPort) =>
      database.transaction().execute(async (tx) => {
        await tx
          .selectFrom("runs")
          .select("id")
          .where("id", "=", fixture.run.id)
          .forNoKeyUpdate()
          .execute();
        await tx
          .selectFrom("workspaces")
          .select("id")
          .where("id", "=", fixture.workspace.id)
          .forNoKeyUpdate()
          .execute();
        return requests.cancelManagerless(tx, fixture.workspace.id, work);
      });
    const abort = new Error("stop adapter rejected");
    await expect(
      cancel({
        stop: async () => {
          throw abort;
        },
      }),
    ).rejects.toBe(abort);
    expect(
      await database
        .selectFrom("requests")
        .select("status")
        .where("id", "=", event.data.request.id)
        .executeTakeFirst(),
    ).toEqual({ status: "pending" });
    // E's Project terminalizer is not in e1c2306bf; this transaction double proves the handover/rollback boundary.
    const stopped = await cancel({
      stop: async (tx, input) => {
        expect(input).toEqual({
          runIds: [fixture.run.id],
          reason: "no-eligible-manager",
          requestEvents: expect.arrayContaining([
            expect.objectContaining({
              type: "request.cancelled",
              data: { requestId: event.data.request.id, reason: "no-eligible-manager" },
            }),
          ]),
        });
        await tx
          .updateTable("runs")
          .set({ status: "interrupted", completedAt: new Date() })
          .where("id", "in", [...input.runIds])
          .execute();
      },
    });
    expect(stopped.runIds).toEqual([fixture.run.id]);
    expect(
      await database
        .selectFrom("requests")
        .select(["status", "cancellationReason"])
        .where("id", "=", event.data.request.id)
        .executeTakeFirst(),
    ).toEqual({ status: "cancelled", cancellationReason: "no-eligible-manager" });
    expect(
      await database
        .selectFrom("runs")
        .select("status")
        .where("id", "=", fixture.run.id)
        .executeTakeFirst(),
    ).toEqual({ status: "interrupted" });
    await database
      .updateTable("users")
      .set({ memberState: "active", authorityGeneration: "3" })
      .where("id", "=", fixture.userId)
      .execute();
    expect(
      await cancel({
        stop: async () => {
          throw new Error("Cancelled Request was revived");
        },
      }),
    ).toEqual({ runIds: [], events: [] });
    expect(
      (await requests.threadFacts({ threadIds: [fixture.thread.id], userId: fixture.userId })).get(
        fixture.thread.id,
      )?.requestOutcomes,
    ).toEqual([
      {
        requestId: event.data.request.id,
        class: "approval",
        status: "cancelled",
        at: expect.any(String),
        reason: "no-eligible-manager",
      },
    ]);
    await expect(
      sql`update requests set status = 'pending', cancellation_reason = null, resolved_at = null
      where id = ${event.data.request.id}`.execute(database),
    ).rejects.toMatchObject({ code: "23514" });
    expect(
      await database.transaction().execute((tx) => requests.canContinue(tx, event.data.request.id)),
    ).toBe(false);
  });

  for (const change of ["guest", "suspended"] as const) {
    it(`cancels a planned last-manager ${change} transition before user writes, including zero revoked roots`, async ({
      storeFixture,
    }) => {
      const fixture = await projectRequestFixture(
        storeFixture,
        `planned-manager-${change}`,
        "unattended",
      );
      const { database, store } = storeFixture;
      const requests = new ProjectRequestStore(database);
      const event = proposal(fixture.binding);
      await database.transaction().execute((tx) => requests.propose(tx, event));
      const actorId = await store.createUser("Other administrator without Project access");
      await database
        .updateTable("users")
        .set({ admittedAt: new Date(), instanceRole: "administrator" })
        .where("id", "=", actorId)
        .execute();
      const revision = Number(
        (await database.selectFrom("accessState").select("revision").executeTakeFirstOrThrow())
          .revision,
      );
      const abort = new Error("roll back planned cancellation");
      let reject = true;
      const stopped: import("@opensteer/core").AgentEvent[] = [];
      const work = new ProjectWorkStopStore((_tx, events) => {
        if (reject) throw abort;
        stopped.push(...events);
      });
      const adapter = new ProjectWorkRevocationStore({
        requests: projectRequestRevocationHooks(requests, work),
        work,
        plannedManagerless: plannedManagerlessProjects,
        managerlessRequests: {
          discover: requests.discoverManagerless.bind(requests),
          cancelPlanned: async (tx, ids) => {
            expect(ids).toEqual([fixture.workspace.id]);
            expect(
              await tx
                .selectFrom("users")
                .select(["memberKind", "memberState"])
                .where("id", "=", fixture.userId)
                .executeTakeFirstOrThrow(),
            ).toEqual({ memberKind: "full", memberState: "active" });
            await requests.cancelPlannedManagerless(tx, ids, work);
          },
        },
      });
      const command = {
        actor: { userId: actorId, authorityGeneration: 1 },
        expectedRevision: revision,
        commandIdentity: createId("command"),
        changes: [
          {
            kind: "member" as const,
            userId: fixture.userId,
            ...(change === "guest"
              ? { memberKind: "guest" as const }
              : { memberState: "suspended" as const }),
          },
        ],
      };
      const port = {
        discover: adapter.discover.bind(adapter),
        cancel: async (
          tx: import("kysely").Transaction<import("./schema.js").DatabaseSchema>,
          roots: Parameters<typeof adapter.cancel>[1],
        ) => {
          if (change === "guest") expect(roots).toEqual([]);
          await adapter.cancel(tx, roots);
        },
      };
      if (change === "guest")
        await expect(mutateAccess(database, command)).rejects.toMatchObject({
          reason: "project-request-cancellation-unavailable",
        });
      await expect(mutateAccess(database, command, port)).rejects.toBe(abort);
      expect(
        await database
          .selectFrom("requests")
          .select("status")
          .where("id", "=", event.data.request.id)
          .executeTakeFirst(),
      ).toEqual({ status: "pending" });
      expect(
        await database
          .selectFrom("users")
          .select(["memberKind", "memberState"])
          .where("id", "=", fixture.userId)
          .executeTakeFirst(),
      ).toEqual({ memberKind: "full", memberState: "active" });
      reject = false;
      await mutateAccess(database, command, port);
      expect(
        await database
          .selectFrom("requests")
          .select(["status", "cancellationReason"])
          .where("id", "=", event.data.request.id)
          .executeTakeFirst(),
      ).toEqual({ status: "cancelled", cancellationReason: "no-eligible-manager" });
      expect(
        await database
          .selectFrom("runs")
          .select(["status", "failure"])
          .where("id", "=", fixture.run.id)
          .executeTakeFirst(),
      ).toMatchObject({ status: "failed", failure: { code: "no_eligible_manager" } });
      expect(stopped.some((entry) => entry.type === "request.cancelled")).toBe(true);
      const cancelled = await database
        .selectFrom("requests")
        .selectAll()
        .where("id", "=", event.data.request.id)
        .executeTakeFirstOrThrow();
      expect(() => requestFromRow(cancelled)).toThrowError(
        expect.objectContaining({
          code: "conflict",
          reason: "no-eligible-manager",
          message:
            "A no-eligible-manager cancellation cannot be mapped to this Request API version",
        }),
      );
    });
  }

  it("cancels an engine call and the remaining Run Requests through the same stored cancellation boundary", async ({
    storeFixture,
  }) => {
    const fixture = await projectRequestFixture(storeFixture, "request-cancel-seams", "unattended");
    const { database } = storeFixture;
    const requests = new ProjectRequestStore(database);
    const first = proposal(fixture.binding);
    const second = proposal(fixture.binding);
    second.data.request.callId = "other-call";
    await database.transaction().execute(async (tx) => {
      await requests.propose(tx, first);
      await requests.propose(tx, second);
    });
    await database.transaction().execute(async (tx) => {
      await reserveProjectWorkStop(tx, { runIds: [fixture.run.id] });
      const events = await requests.cancelEngineRequest(tx, {
        type: "request.cancelled",
        ordinal: 0,
        bindingGeneration: fixture.binding.bindingGeneration,
        emittedAt: new Date().toISOString(),
        runId: fixture.run.id,
        threadId: fixture.thread.id,
        workspaceId: fixture.workspace.id,
        environmentId: fixture.environmentId,
        data: { requestId: first.data.request.id, reason: "source-closed" },
      });
      expect(events.map((event) => event.type)).toEqual([
        "request.cancelled",
        "thread.execution-updated",
      ]);
      const remaining = await requests.cancelRun(tx, {
        runId: fixture.run.id,
        reason: "run-ended",
        resolvedAt: new Date(),
      });
      expect(remaining.map((event) => event.type)).toEqual([
        "request.cancelled",
        "thread.execution-updated",
      ]);
      expect(
        await requests.cancelRun(tx, {
          runId: fixture.run.id,
          reason: "run-ended",
          resolvedAt: new Date(),
        }),
      ).toEqual([]);
    });
    expect(
      await database
        .selectFrom("requests")
        .select(["id", "status", "cancellationReason"])
        .where("id", "in", [first.data.request.id, second.data.request.id])
        .orderBy("id")
        .execute(),
    ).toEqual(
      [
        { id: first.data.request.id, status: "cancelled", cancellationReason: "source-closed" },
        { id: second.data.request.id, status: "cancelled", cancellationReason: "run-ended" },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });

  it("keeps an unattended wait when an unchanged eligible manager is outside the member-only plan", async ({
    storeFixture,
  }) => {
    const fixture = await projectRequestFixture(storeFixture, "unchanged-manager", "unattended");
    const { database, store } = storeFixture;
    const requests = new ProjectRequestStore(database);
    const event = proposal(fixture.binding);
    await database.transaction().execute((tx) => requests.propose(tx, event));
    const manager = await store.createUser("Unchanged manager");
    await database
      .updateTable("users")
      .set({ admittedAt: new Date(), instanceRole: "administrator" })
      .where("id", "=", manager)
      .execute();
    await database
      .insertInto("workspaceMemberships")
      .values({
        id: createId("workspaceMembership"),
        workspaceId: fixture.workspace.id,
        userId: manager,
        role: "owner",
        state: "active",
        generation: 1,
        invitedBy: fixture.userId,
        joinedAt: new Date(),
        revokedAt: null,
        revokedBy: null,
        updatedAt: new Date(),
      })
      .execute();
    await mutateAccess(database, {
      actor: { userId: manager, authorityGeneration: 1 },
      expectedRevision: 1,
      commandIdentity: createId("command"),
      changes: [{ kind: "member", userId: fixture.userId, memberKind: "guest" }],
    });
    expect(await eligibleProjectRequestManagers(database, fixture.workspace.id)).toEqual([manager]);
    expect(
      await database
        .selectFrom("requests")
        .select("status")
        .where("id", "=", event.data.request.id)
        .executeTakeFirst(),
    ).toEqual({ status: "pending" });
  });
});
