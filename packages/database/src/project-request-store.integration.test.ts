import {
  createId,
  ProjectEngineRequestEventSchema,
  type ProjectEngineRequestEvent,
} from "@opensteer/core";
import { sql } from "kysely";
import { expect } from "vitest";
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
            expect(input).toEqual({ runIds: [fixture.run.id], reason: "authority-revoked" });
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
    expect(result.events).toEqual([]);
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
        expect(input).toEqual({ runIds: [fixture.run.id], reason: "no-eligible-manager" });
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
    await expect(
      sql`update requests set status = 'pending', cancellation_reason = null, resolved_at = null
      where id = ${event.data.request.id}`.execute(database),
    ).rejects.toMatchObject({ code: "23514" });
    expect(
      await database.transaction().execute((tx) => requests.canContinue(tx, event.data.request.id)),
    ).toBe(false);
  });
});
