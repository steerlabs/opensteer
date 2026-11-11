import { mutateAccess } from "./access-store.js";
import { RunnerConnectionFenceSchema } from "@opensteer/protocol";
import {
  prepareProjectAdmission,
  bindProjectRun,
  projectWatchWorkSource,
} from "./project-work.test-support.js";
import { readProjectRunThreadState } from "./run-thread-state.js";
import { ProjectBindingStore, ProjectControlDeliveryStore } from "./project-execution-store.js";
import { loadProjectRunDispatchContext } from "./execution-store.js";
import { settleAssignmentAfterRun } from "./assignment-store.js";
import { assertActiveProjectBinding, readProjectRunBinding } from "./execution-authority.js";
import { randomUUID } from "node:crypto";
import { ProjectRunBindingSchema, HumanRootSchema, createId } from "@opensteer/core";
import { sql } from "kysely";
import { expect } from "vitest";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { pauseAfterLock } from "./lock-race.test-support.js";
import type { DatabaseSchema } from "./schema.js";
import type { Kysely } from "kysely";
import { describeStore, type StoreFixture } from "./store.integration.test-support.js";
import { jsonValue } from "./store-primitives.js";
import { setProjectRuntimeSettings } from "./project-runtime-settings-store.js";
import { testModelSelection } from "./store.integration.test-support.js";
import { ensureProjectPrincipal, ProjectWorkStore } from "./project-work-store.js";

describeStore("Project principal lookup", (it) => {
  it("uses the principal created by access admission for first work and concurrent lookups", async ({
    storeFixture,
  }) => {
    const context = await prepareProjectAdmission(storeFixture);
    const { database, project, origin, prepared } = context;
    const workspaceId = createId("workspace");
    const created = await mutateAccess(database, {
      actor: { userId: project.userId },
      expectedRevision: 1,
      commandIdentity: createId("command"),
      changes: [
        {
          kind: "create-project",
          workspaceId,
          entryId: randomUUID(),
          name: "Access-created",
          color: "blue",
          backing: {
            kind: "local-directory",
            generation: 1,
            bindingId: createId("workspaceBinding"),
            ownerEnvironmentId: project.environmentId,
            storageAuthorityId: null,
          },
        },
      ],
    });
    const principal = await database
      .selectFrom("principals")
      .select("id")
      .where("workspaceId", "=", workspaceId)
      .executeTakeFirstOrThrow();
    await database
      .updateTable("workspaces")
      .set({ status: "ready" })
      .where("id", "=", workspaceId)
      .execute();
    await setProjectRuntimeSettings(
      database,
      { userId: project.userId, authorityGeneration: 1 },
      {
        workspaceId,
        expectedAccessRevision: created.revision,
        expectedSettingsRevision: null,
        commandIdentity: createId("command"),
        harnessInstanceId: prepared.harnessInstance.id,
        modelSelection: testModelSelection,
        accessMode: "full-access",
        instructions: "Project only",
        timeZone: "UTC",
      },
    );
    let principalInserts = 0;
    const observed = database.withPlugin({
      transformQuery(args) {
        if (
          database
            .getExecutor()
            .compileQuery(args.node, args.queryId)
            .sql.startsWith('insert into "principals"')
        )
          principalInserts++;
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    });
    const work = new ProjectWorkStore(observed, {
      runnerIsConnected: () => true,
      runnerIsAttached: () => true,
    });
    const lookup = () =>
      observed.transaction().execute(async (tx) => {
        await tx
          .selectFrom("workspaces")
          .select("id")
          .where("id", "=", workspaceId)
          .forShare()
          .executeTakeFirstOrThrow();
        return ensureProjectPrincipal(tx, workspaceId);
      });
    const [first, second, thread] = await Promise.all([
      lookup(),
      lookup(),
      work.createProjectThread({
        workspaceId,
        origin,
        home: false,
        role: "work",
        title: "First work",
        idempotencyKey: "first-thread",
      }),
    ]);
    expect([first, second]).toEqual([principal.id, principal.id]);
    expect(
      await database
        .selectFrom("threads")
        .select("createdByPrincipalId")
        .where("id", "=", thread.thread.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ createdByPrincipalId: principal.id });
    const admitted = await work.admitProjectWork({
      threadId: thread.thread.id,
      origin,
      source: { kind: "human" },
      content: [{ type: "text", text: "First work" }],
      policy: "queue",
      idempotencyKey: "first-work",
    });
    expect(admitted.runId).not.toBeNull();
    expect(principalInserts).toBe(0);
    expect(
      await database
        .selectFrom("principals")
        .select("id")
        .where("workspaceId", "=", workspaceId)
        .execute(),
    ).toEqual([principal]);
  });

  it("converges concurrent admission lookups and retains the principal after deletion", async ({
    storeFixture,
  }) => {
    const database = storeFixture.database;
    const userId = await storeFixture.store.createUser("Project creator");
    const workspaceId = createId("workspace");
    const environmentId = createId("environment");
    await database
      .insertInto("deployments")
      .values({
        id: createId("deployment"),
        singletonKey: "primary",
        activeHostInstanceId: createId("hostInstance"),
        authorityModelVersion: 2,
        canonicalOrigin: "https://project.test.invalid",
        lifecycle: "active",
        deploymentShape: { kind: "server", defaultWorkspaceBacking: "local-directory" },
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .execute();
    await database.transaction().execute(async (transaction) => {
      await sql`insert into execution_environments (id, name, kind, capabilities)
        values (${environmentId}, 'Project computer', 'main', '[]'::jsonb)`.execute(transaction);
      await sql`insert into workspaces (id, kind, name, created_by, color, backing)
        values (${workspaceId}, 'project', 'Team Project', ${userId}, 'blue', ${JSON.stringify({
          kind: "local-directory",
          ownerEnvironmentId: environmentId,
          bindingId: createId("workspaceBinding"),
          storageAuthorityId: null,
          generation: 1,
        })}::jsonb)`.execute(transaction);
      await sql`insert into workspace_memberships (id, workspace_id, user_id, role, state)
        values (${createId("workspaceMembership")}, ${workspaceId}, ${userId}, 'owner', 'active')`.execute(
        transaction,
      );
    });
    const inserted = pauseAfterLock(
      database,
      (node) => node.includes('"InsertQueryNode"') && node.includes('"principals"'),
    );
    const observed = pauseAfterLock(
      database,
      (node) => node.includes('"SelectQueryNode"') && node.includes('"principals"'),
    );
    const lookup = (connection: Kysely<DatabaseSchema>) =>
      connection.transaction().execute(async (transaction) => {
        await transaction
          .selectFrom("workspaces")
          .select("id")
          .where("id", "=", workspaceId)
          .forShare()
          .executeTakeFirstOrThrow();
        return ensureProjectPrincipal(transaction, workspaceId);
      });
    const first = lookup(inserted.database);
    void first.catch(() => undefined);
    let second: ReturnType<typeof lookup> | undefined;
    let ids: Awaited<ReturnType<typeof lookup>>[];
    try {
      await withTimeout(inserted.reached, 3000, {
        timeoutError: () => new Error("First principal insert never reached its barrier"),
      });
      second = lookup(observed.database);
      void second.catch(() => undefined);
      await withTimeout(observed.reached, 3000, {
        timeoutError: () =>
          new Error("Concurrent principal lookup never read the absent uncommitted row"),
      });
      observed.release();
      inserted.release();
      ids = await withTimeout(Promise.all([first, second]), 3000, {
        timeoutError: () => new Error("Concurrent principal lookups did not settle"),
      });
    } finally {
      observed.release();
      inserted.release();
      await withTimeout(Promise.allSettled([first, second]), 3000, {
        timeoutError: () => new Error("Principal lookup cleanup did not settle"),
      });
    }
    expect(new Set(ids).size).toBe(1);
    const rows = await database
      .selectFrom("principals")
      .selectAll()
      .where("workspaceId", "=", workspaceId)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: ids[0], kind: "project", userId: null });
    expect(
      await database
        .transaction()
        .execute((transaction) => ensureProjectPrincipal(transaction, workspaceId)),
    ).toBe(ids[0]);
    await database
      .updateTable("workspaces")
      .set({ status: "deleted", deletedAt: new Date() })
      .where("id", "=", workspaceId)
      .execute();
    await expect(
      database
        .transaction()
        .execute((transaction) => ensureProjectPrincipal(transaction, workspaceId)),
    ).rejects.toMatchObject({ code: "workspace_unavailable" });
    expect(
      await database
        .selectFrom("principals")
        .select("id")
        .where("workspaceId", "=", workspaceId)
        .execute(),
    ).toEqual([{ id: ids[0] }]);
  });
});

async function completedProjectAssignment(fixture: StoreFixture) {
  const context = await prepareProjectAdmission(fixture);
  const { project, prepared, database, origin, store } = context;
  const parent = await store.admitProjectWork({
    threadId: prepared.thread.id,
    origin,
    source: { kind: "human" },
    content: [{ type: "text", text: "parent task" }],
    policy: "queue",
    idempotencyKey: "parent",
  });
  if (!parent.runId) throw new Error("Parent was not queued");
  const binding = await bindProjectRun(fixture, parent.runId, project.runnerId);
  const child = await store.delegateProjectWork({
    binding,
    title: "Check",
    content: [{ type: "text", text: "report the answer" }],
    idempotencyKey: randomUUID(),
  });
  await bindProjectRun(fixture, child.runId, project.runnerId);
  await database.transaction().execute(async (transaction) => {
    const run = await transaction
      .selectFrom("runs")
      .selectAll()
      .where("id", "=", child.runId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    await transaction
      .selectFrom("workspaces")
      .select("id")
      .where("id", "=", project.workspace.id)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    const thread = await transaction
      .selectFrom("threads")
      .selectAll()
      .where("id", "=", child.threadId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    await transaction
      .selectFrom("delegations")
      .select("id")
      .where("id", "=", child.assignmentId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable("threadInputs")
      .set({ state: "delivered", runId: run.id, deliveredAt: new Date() })
      .where("messageId", "=", run.seedInputId)
      .execute();
    await transaction
      .insertInto("messages")
      .values({
        id: createId("message"),
        threadId: thread.id,
        runId: run.id,
        sequence: thread.nextMessageSequence,
        kind: "assistant",
        actorPrincipalId: run.actorPrincipalId,
        author: jsonValue({
          kind: "agent",
          runId: run.id,
          threadId: thread.id,
          workspaceId: project.workspace.id,
          workspaceName: project.workspace.name,
          displayName: "Project",
        }),
        content: jsonValue([{ type: "text", text: "The answer" }]),
        createdAt: new Date(),
      })
      .execute();
    await transaction
      .updateTable("threads")
      .set({ nextMessageSequence: sql<string>`next_message_sequence + 1` })
      .where("id", "=", thread.id)
      .execute();
    await transaction
      .updateTable("runs")
      .set({ status: "completed", completedAt: new Date() })
      .where("id", "=", run.id)
      .execute();
    await settleAssignmentAfterRun(transaction, {
      assignmentId: child.assignmentId,
      failureSummary: null,
      finishedAt: new Date(),
      run: { id: run.id, threadId: run.threadId },
      status: "completed",
    });
  });
  return { ...context, parent, child };
}

describeStore("Project work admission", (it) => {
  it("freezes a bounded canonical exchange into an exact boot binding, retains its settings and never rebinds by replay", async ({
    storeFixture,
  }) => {
    const { database, store, project, prepared, origin } =
      await prepareProjectAdmission(storeFixture);
    await database
      .updateTable("threads")
      .set({ role: "conversation" })
      .where("id", "=", prepared.thread.id)
      .execute();
    const admit = (key: string, policy: "queue" | "report" = "queue") =>
      store.admitProjectWork({
        threadId: prepared.thread.id,
        origin,
        source: { kind: "human" },
        content: [{ type: "text", text: key }],
        policy,
        idempotencyKey: key,
      });
    const first = await admit("binding-seed");
    const followup = await admit("binding-followup");
    const report = await admit("binding-report", "report");
    const otherUser = await storeFixture.store.createUser("Other Project member");
    await database
      .updateTable("users")
      .set({ admittedAt: new Date() })
      .where("id", "=", otherUser)
      .execute();
    await database
      .insertInto("workspaceMemberships")
      .values({
        id: createId("workspaceMembership"),
        workspaceId: project.workspace.id,
        userId: otherUser,
        role: "collaborator",
        state: "active",
        generation: 1,
        invitedBy: project.userId,
        joinedAt: new Date(),
        revokedAt: null,
        revokedBy: null,
        updatedAt: new Date(),
      })
      .execute();
    const other = await store.admitProjectWork({
      threadId: prepared.thread.id,
      origin: { ...origin, userId: otherUser },
      source: { kind: "human" },
      content: [{ type: "text", text: "Other person's work" }],
      policy: "queue",
      idempotencyKey: "other-root",
    });

    if (!first.commandId || !first.runId) throw new Error("Project admission did not queue a Run");
    const runnerBootId = `rbt_${randomUUID()}`;
    const bindings = new ProjectBindingStore(database, {
      runnerIsAttached: (id, boot) => id === project.runnerId && boot === runnerBootId,
    });
    const input = {
      commandId: first.commandId,
      runnerId: project.runnerId,
      runnerBootId,
      leaseTokenHash: "binding-secret-hash",
      leaseExpiresAt: new Date(Date.now() + 60_000),
      dispatcherId: "project-dispatch-test",
    };
    const bound = await bindings.acquire(input);
    expect(
      await database
        .selectFrom("threadInputs")
        .select(["state", "runId"])
        .where("messageId", "=", other.input.messageId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "pending", runId: null });
    expect(bound.created).toBe(true);
    expect(bound.binding.authority.origin).toEqual(origin);
    expect(bound.snapshot).toMatchObject({
      settingsRevision: 1,
      instructions: "Project only",
      timeZone: "UTC",
    });
    const context = await loadProjectRunDispatchContext(
      database,
      first.commandId,
      bound.binding,
      () => true,
    );
    expect(context.inputs.map((message) => message.id)).toEqual([
      first.input.messageId,
      followup.input.messageId,
    ]);
    expect(context.reports.messages.map((message) => message.id)).toEqual([report.input.messageId]);
    expect(context).not.toHaveProperty("membershipGeneration");
    expect(context).not.toHaveProperty("voiceCall");
    expect(context.run.status).toBe("starting");
    expect(await readProjectRunThreadState(database, bound.binding, () => true)).toEqual({
      previousRun: null,
      previousAssignment: null,
    });
    await expect(
      readProjectRunThreadState(database, bound.binding, () => false),
    ).rejects.toMatchObject({ code: "conflict", reason: "computer-offline" });

    expect(await bindings.acquire(input)).toMatchObject({
      binding: bound.binding,
      created: false,
      events: [],
    });
    expect(
      await database.selectFrom("grants").select("id").where("runId", "=", first.runId).execute(),
    ).toHaveLength(1);
    const restarted = new ProjectBindingStore(database, { runnerIsAttached: () => true });
    await expect(
      restarted.acquire({ ...input, runnerBootId: `rbt_${randomUUID()}` }),
    ).rejects.toMatchObject({
      reason: "binding-recovery-required",
    });
    await expect(
      store.admitProjectWork({
        threadId: prepared.thread.id,
        origin: { ...origin, userId: otherUser },
        source: { kind: "human" },
        content: [{ type: "text", text: "Other person's steer" }],
        policy: "steer",
        idempotencyKey: "other-steer",
      }),
    ).rejects.toMatchObject({ reason: "steer-exchange-mismatch" });
    const steering = {
      threadId: prepared.thread.id,
      origin,
      source: { kind: "human" as const },
      content: [{ type: "text" as const, text: "Take this direction" }],
      policy: "steer" as const,
      idempotencyKey: "same-root-steer",
    };
    const steered = await store.admitProjectWork(steering);
    expect(steered).toMatchObject({
      runId: first.runId,
      input: { policy: "steer", state: "claimed" },
    });
    expect(await store.admitProjectWork(steering)).toMatchObject({
      commandId: steered.commandId,
      runId: first.runId,
      wasDuplicate: true,
    });
    if (!steered.commandId) throw new Error("Steer did not persist a control");
    const deliveries = new ProjectControlDeliveryStore(database, {
      currentRunnerBootId: () => runnerBootId,
      currentPeerIsProjectCapable: () => true,
      canContinue: async () => true,
    });
    const control = await deliveries.claim(steered.commandId, "steer-delivery");
    if (control.state !== "ready") throw new Error("Steer was not deliverable");
    expect(control).toMatchObject({
      binding: bound.binding,
      control: { kind: "run.steer", input: { messageId: steered.input.messageId } },
    });
    const peer = RunnerConnectionFenceSchema.parse({
      runnerId: project.runnerId,
      bootId: runnerBootId,
      connectionId: `rcn_${randomUUID()}`,
      connectionLeaseId: `rls_${randomUUID()}`,
      connectionGeneration: 1,
    });
    const receipt = await deliveries.recordResult(peer, {
      ...peer,
      type: "runner.project.control-result",
      commandId: control.commandId,
      correlationId: control.correlationId,
      binding: control.binding,
      result: { status: "accepted" },
    });
    expect(receipt).toMatchObject({ state: "recorded", replayed: false });
    expect(
      await database
        .selectFrom("threadInputs")
        .select("state")
        .where("messageId", "=", steered.input.messageId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "delivered" });
    expect(
      await deliveries.recordResult(peer, {
        ...peer,
        type: "runner.project.control-result",
        commandId: control.commandId,
        correlationId: control.correlationId,
        binding: control.binding,
        result: { status: "accepted" },
      }),
    ).toMatchObject({ replayed: true });
    const later = await admit("after-freeze");
    expect(later.runId).not.toBe(first.runId);
    expect(
      (
        await loadProjectRunDispatchContext(database, first.commandId, bound.binding, () => true)
      ).inputs.map((message) => message.id),
    ).toEqual([first.input.messageId, followup.input.messageId]);
  });
  it("queues as the Project, freezes settings and replays without borrowing the root's preferences", async ({
    storeFixture,
  }) => {
    const { project, prepared, database, origin, store } =
      await prepareProjectAdmission(storeFixture);
    const input = {
      threadId: prepared.thread.id,
      origin,
      source: { kind: "human" as const },
      content: [{ type: "text" as const, text: "do work" }],
      policy: "queue" as const,
      idempotencyKey: "one",
    };
    const first = await store.admitProjectWork(input);
    const replay = await store.admitProjectWork(input);
    expect(first.runId).not.toBeNull();
    expect(replay).toMatchObject({
      runId: first.runId,
      commandId: first.commandId,
      wasDuplicate: true,
      events: [],
    });
    expect(first.events.map((event) => event.type)).toContain("run.queued");
    const run = await database
      .selectFrom("runs")
      .selectAll()
      .where("id", "=", first.runId)
      .executeTakeFirstOrThrow();
    expect(run).toMatchObject({
      actorPrincipalId: project.principalId,
      requestedBy: project.userId,
      initiatorGeneration: "1",
      membershipGeneration: "1",
      authoritySource: {
        projectRuntime: { instructions: "Project only", timeZone: "UTC", settingsRevision: 1 },
      },
    });
    await expect(
      store.admitProjectWork({ ...input, content: [{ type: "text", text: "different" }] }),
    ).rejects.toMatchObject({ reason: "idempotency-conflict" });
    await database
      .updateTable("users")
      .set({ authorityGeneration: "2" })
      .where("id", "=", project.userId)
      .execute();
    await expect(
      store.admitProjectWork({ ...input, idempotencyKey: "stale" }),
    ).rejects.toMatchObject({ reason: "captured-root-unavailable" });
  });
  it("creates a same-Project child with root attribution and Project authority, retaining the exact source and assignment", async ({
    storeFixture,
  }) => {
    const { project, prepared, database, origin, store } = await prepareProjectAdmission(
      storeFixture,
      true,
    );
    const grant = await database
      .selectFrom("grants")
      .selectAll()
      .where("runId", "=", prepared.run.id)
      .executeTakeFirstOrThrow();
    const binding = ProjectRunBindingSchema.parse({
      authority: {
        version: 1,
        principal: {
          kind: "project",
          principalId: project.principalId,
          workspaceId: project.workspace.id,
        },
        origin,
      },
      runId: prepared.run.id,
      threadId: prepared.thread.id,
      workspaceId: project.workspace.id,
      environmentId: project.environmentId,
      grantId: grant.id,
      bindingGeneration: grant.bindingGeneration,
      runnerId: grant.runnerId,
      runnerBootId: grant.runnerBootId,
    });
    const input = {
      binding,
      title: "Child",
      content: [{ type: "text" as const, text: "child task" }],
      idempotencyKey: randomUUID(),
    };
    const child = await store.delegateProjectWork(input);
    const replay = await store.delegateProjectWork(input);
    expect(replay).toMatchObject({
      threadId: child.threadId,
      assignmentId: child.assignmentId,
      runId: child.runId,
      wasDuplicate: true,
      events: [],
    });
    expect(
      await database
        .selectFrom("threads")
        .selectAll()
        .where("id", "=", child.threadId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      createdBy: origin.userId,
      createdByPrincipalId: project.principalId,
      workspaceId: project.workspace.id,
      parentThreadId: prepared.thread.id,
    });
    expect(
      await database
        .selectFrom("runs")
        .selectAll()
        .where("id", "=", child.runId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      requestedBy: origin.userId,
      actorPrincipalId: project.principalId,
      initiatorGeneration: "1",
      membershipGeneration: "1",
      originConnectionId: null,
      assignmentId: child.assignmentId,
      causalChainId: prepared.run.causalChainId,
      authoritySource: {
        kind: "workspace-membership",
        userId: origin.userId,
        parentRunId: prepared.run.id,
      },
    });
    expect(child.events.map((event) => event.type)).toContain("assignment.created");
  });

  it("keeps unattended observations separate, refuses stale source generations and refuses creatorless children before writing", async ({
    storeFixture,
  }) => {
    const { project, prepared, database, store } = await prepareProjectAdmission(storeFixture);
    const { activation, source } = await projectWatchWorkSource({ database, project, prepared });
    const input = {
      threadId: prepared.thread.id,
      origin: null,
      source,
      content: [{ type: "text" as const, text: "changed" }],
      policy: "queue" as const,
      idempotencyKey: "one",
    };
    const first = await store.admitProjectWork(input);
    expect(await store.admitProjectWork(input)).toMatchObject({
      runId: first.runId,
      wasDuplicate: true,
    });
    const second = await store.admitProjectWork({
      ...input,
      source: { ...source, observationId: "two" },
    });
    expect(second.runId).toBeNull();
    const run = await database
      .selectFrom("runs")
      .selectAll()
      .where("id", "=", first.runId)
      .executeTakeFirstOrThrow();
    expect(run).toMatchObject({
      requestedBy: null,
      membershipGeneration: null,
      initiatorGeneration: null,
      originConnectionId: null,
      actorPrincipalId: project.principalId,
      authoritySource: {
        kind: "watch-observation",
        observationId: "one",
        incarnation: activation.executionGeneration,
      },
    });
    if (!first.commandId) throw new Error("Unattended work has no execute command");
    const bound = await new ProjectBindingStore(database, { runnerIsAttached: () => true }).acquire(
      {
        commandId: first.commandId,
        runnerId: project.runnerId,
        runnerBootId: `rbt_${randomUUID()}`,
        leaseTokenHash: "unattended-steer",
        leaseExpiresAt: new Date(Date.now() + 60_000),
        dispatcherId: "unattended-steer",
      },
    );
    await expect(
      store.admitProjectWork({
        ...input,
        source: { ...source, observationId: "two" },
        policy: "steer",
        idempotencyKey: "wrong-occurrence",
      }),
    ).rejects.toMatchObject({ reason: "steer-exchange-mismatch" });
    expect(
      await store.admitProjectWork({
        ...input,
        policy: "steer",
        idempotencyKey: "same-occurrence",
      }),
    ).toMatchObject({
      runId: first.runId,
      input: { policy: "steer", state: "claimed" },
    });
    expect(
      await database
        .selectFrom("threadInputs")
        .select("requestedBy")
        .where("runId", "=", first.runId)
        .where("policy", "=", "steer")
        .executeTakeFirstOrThrow(),
    ).toEqual({ requestedBy: null });
    const fakeBinding = bound.binding;
    const before = await database.selectFrom("threads").select("id").execute();
    await expect(
      store.delegateProjectWork({
        binding: fakeBinding,
        title: "No creator",
        content: input.content,
        idempotencyKey: "creatorless",
      }),
    ).rejects.toMatchObject({ reason: "creatorless-tasks-not-supported" });
    expect(await database.selectFrom("threads").select("id").execute()).toEqual(before);
    expect(await database.selectFrom("agentControlRequests").select("requestId").execute()).toEqual(
      [],
    );
    await database
      .updateTable("triggerWatchActivations")
      .set({ executionGeneration: Number(activation.executionGeneration) + 1 })
      .where("id", "=", activation.id)
      .execute();
    await expect(
      store.admitProjectWork({ ...input, idempotencyKey: "late" }),
    ).rejects.toMatchObject({ reason: "source-unavailable" });
  });
  it("restarts admission from the Run reservation when a concurrent input expands the scope", async ({
    storeFixture,
  }) => {
    const { prepared, database, origin, store } = await prepareProjectAdmission(storeFixture);
    const barrier = pauseAfterLock(
      database,
      (node) =>
        node.includes('"SelectQueryNode"') &&
        node.includes('"runs"') &&
        node.includes("ForNoKeyUpdate"),
    );
    let reservations = 0;
    const measured = barrier.database.withPlugin({
      transformQuery(args) {
        const node = JSON.stringify(args.node);
        if (
          node.includes('"SelectQueryNode"') &&
          node.includes('"runs"') &&
          node.includes("ForNoKeyUpdate")
        )
          reservations += 1;
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    });
    const raced = new ProjectWorkStore(measured, {
      runnerIsConnected: () => true,
      runnerIsAttached: () => true,
    });
    const input = {
      threadId: prepared.thread.id,
      origin,
      source: { kind: "human" as const },
      content: [{ type: "text" as const, text: "first" }],
      policy: "queue" as const,
      idempotencyKey: "first",
    };
    const first = raced.admitProjectWork(input);
    void first.catch(() => undefined);
    try {
      await withTimeout(barrier.reached, 3000, {
        timeoutError: () => new Error("Admission never reached the Run reservation barrier"),
      });
      const second = await store.admitProjectWork({
        ...input,
        idempotencyKey: "second",
        content: [{ type: "text", text: "second" }],
      });
      barrier.release();
      const completed = await withTimeout(first, 3000, {
        timeoutError: () => new Error("Admission did not restart after its Run scope expanded"),
      });
      expect(completed.runId).toBeNull();
      expect(second.runId).not.toBeNull();
      expect(reservations).toBe(2);
      expect(
        await database
          .selectFrom("runs")
          .select("id")
          .where("threadId", "=", prepared.thread.id)
          .execute(),
      ).toHaveLength(1);
      expect((await store.admitProjectWork(input)).runId).toBeNull();
    } finally {
      barrier.release();
      await withTimeout(Promise.allSettled([first]), 3000, {
        timeoutError: () => new Error("Admission race cleanup did not settle"),
      });
    }
  });
  it("recovers a pending exchange from immutable input settings and never re-roots it", async ({
    storeFixture,
  }) => {
    const { project, prepared, database, origin, store } =
      await prepareProjectAdmission(storeFixture);
    const input = {
      threadId: prepared.thread.id,
      origin,
      source: { kind: "human" as const },
      content: [{ type: "text" as const, text: "first" }],
      policy: "queue" as const,
      idempotencyKey: "recovery-first",
    };
    const first = await store.admitProjectWork(input);
    const pending = await store.admitProjectWork({
      ...input,
      idempotencyKey: "recovery-next",
      content: [{ type: "text", text: "next" }],
    });
    await database
      .updateTable("runs")
      .set({ status: "completed", completedAt: new Date() })
      .where("id", "=", first.runId)
      .execute();
    await database
      .updateTable("threadInputs")
      .set({ state: "delivered", runId: first.runId, deliveredAt: new Date() })
      .where("messageId", "=", first.input.messageId)
      .execute();
    const settings = await database
      .selectFrom("projectRuntimeSettings")
      .selectAll()
      .where("workspaceId", "=", project.workspace.id)
      .executeTakeFirstOrThrow();
    await setProjectRuntimeSettings(
      database,
      { userId: project.userId, authorityGeneration: 1 },
      {
        workspaceId: project.workspace.id,
        expectedAccessRevision: 1,
        expectedSettingsRevision: Number(settings.revision),
        commandIdentity: createId("command"),
        harnessInstanceId: prepared.harnessInstance.id,
        modelSelection: testModelSelection,
        accessMode: "approval-required",
        instructions: "Changed after admission",
        timeZone: "America/Chicago",
      },
    );
    const recovered = await store.recoverPendingProjectWork(prepared.thread.id);
    expect(recovered.state).toBe("queued");
    const run = await database
      .selectFrom("runs")
      .selectAll()
      .where("id", "=", recovered.runId)
      .executeTakeFirstOrThrow();
    expect(run).toMatchObject({
      seedInputId: pending.input.messageId,
      requestedBy: origin.userId,
      initiatorGeneration: "1",
      membershipGeneration: "1",
      accessMode: "full-access",
      authoritySource: {
        projectRuntime: { settingsRevision: 1, instructions: "Project only", timeZone: "UTC" },
      },
    });
    expect((await store.recoverPendingProjectWork(prepared.thread.id)).runId).toBe(run.id);
    expect(
      await database
        .selectFrom("runs")
        .select("id")
        .where("threadId", "=", prepared.thread.id)
        .execute(),
    ).toHaveLength(2);
    await database
      .updateTable("runs")
      .set({ status: "failed", completedAt: new Date() })
      .where("id", "=", run.id)
      .execute();
    await database
      .updateTable("users")
      .set({ authorityGeneration: "2" })
      .where("id", "=", origin.userId)
      .execute();
    const cancelled = await store.recoverPendingProjectWork(prepared.thread.id);
    expect(cancelled.state).toBe("cancelled");
    expect(
      await database
        .selectFrom("threadInputs")
        .select(["state", "cancelReason", "initiatorGeneration"])
        .where("messageId", "=", pending.input.messageId)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      state: "cancelled",
      cancelReason: "execution-authority-unavailable",
      initiatorGeneration: "1",
    });
  });
  it("returns a child's stored result into its original Project exchange, idempotently", async ({
    storeFixture,
  }) => {
    const { database, store, project, prepared, parent, child } =
      await completedProjectAssignment(storeFixture);
    const delivered = await store.deliverAssignmentResult(child.assignmentId);
    expect(delivered.state).toBe("delivered");
    expect(await store.deliverAssignmentResult(child.assignmentId)).toEqual({
      state: "settled",
      events: [],
    });
    const assignment = await database
      .selectFrom("delegations")
      .selectAll()
      .where("id", "=", child.assignmentId)
      .executeTakeFirstOrThrow();
    expect(assignment).toMatchObject({ resultStatus: "delivered", resultRunId: child.runId });
    const receipt = await database
      .selectFrom("threadInputs")
      .selectAll()
      .where("messageId", "=", assignment.resultMessageId)
      .executeTakeFirstOrThrow();
    expect(receipt).toMatchObject({
      threadId: prepared.thread.id,
      actorPrincipalId: project.principalId,
      requestedBy: project.userId,
      initiatorGeneration: "1",
      membershipGeneration: "1",
      originConnectionId: null,
      authoritySource: { kind: "workspace-membership", parentRunId: parent.runId },
    });
    expect(
      await database
        .selectFrom("messages")
        .select(["kind", "content"])
        .where("id", "=", receipt.messageId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ kind: "continuation", content: [{ type: "text", text: "The answer" }] });
    expect(delivered.events.filter((event) => event.type === "assignment.updated")).toHaveLength(2);
  });

  it("makes a departed root's result explicitly undeliverable while retaining both Project task cards", async ({
    storeFixture,
  }) => {
    const { database, store, project, child } = await completedProjectAssignment(storeFixture);
    const before = await database.selectFrom("threadInputs").select("messageId").execute();
    await database
      .updateTable("users")
      .set({ authorityGeneration: "2" })
      .where("id", "=", project.userId)
      .execute();
    const result = await store.deliverAssignmentResult(child.assignmentId);
    expect(result.state).toBe("undeliverable");
    expect(await database.selectFrom("threadInputs").select("messageId").execute()).toEqual(before);
    expect(
      await database
        .selectFrom("delegations")
        .select(["resultStatus", "resultReason"])
        .where("id", "=", child.assignmentId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ resultStatus: "undeliverable", resultReason: "execution-authority-unavailable" });
    expect(result.events.filter((event) => event.type === "assignment.updated")).toHaveLength(2);
  });
  it("creates Chat from Project settings with the actual human root as attribution, and refuses a missing configuration", async ({
    storeFixture,
  }) => {
    const { project, database, origin, store, prepared } =
      await prepareProjectAdmission(storeFixture);
    const userId = await storeFixture.store.createUser("Project member");
    await database
      .updateTable("users")
      .set({ admittedAt: new Date() })
      .where("id", "=", userId)
      .execute();
    await database
      .insertInto("workspaceMemberships")
      .values({
        id: createId("workspaceMembership"),
        workspaceId: project.workspace.id,
        userId,
        role: "collaborator",
        state: "active",
        generation: 1,
        invitedBy: project.userId,
        joinedAt: new Date(),
        revokedAt: null,
        revokedBy: null,
        updatedAt: new Date(),
      })
      .execute();
    const memberRoot = HumanRootSchema.parse({ ...origin, userId });
    const request = {
      workspaceId: project.workspace.id,
      origin: memberRoot,
      title: "Chat",
      role: "conversation" as const,
      home: true,
      idempotencyKey: "chat",
    };
    const created = await store.createProjectThread(request);
    expect(created.thread).toMatchObject({
      createdBy: userId,
      harnessInstanceId: prepared.harnessInstance.id,
      accessMode: "full-access",
    });
    expect(
      await database
        .selectFrom("threads")
        .select(["createdBy", "createdByPrincipalId"])
        .where("id", "=", created.thread.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ createdBy: userId, createdByPrincipalId: project.principalId });
    expect((await store.createProjectThread(request)).thread.id).toBe(created.thread.id);
    expect(
      (await store.createProjectThread({ ...request, origin, idempotencyKey: "another-person" }))
        .thread.id,
    ).toBe(created.thread.id);
    expect(
      (
        await database
          .selectFrom("workspaces")
          .select("homeThreadId")
          .where("id", "=", project.workspace.id)
          .executeTakeFirstOrThrow()
      ).homeThreadId,
    ).toBe(created.thread.id);
    await database
      .deleteFrom("projectRuntimeSettings")
      .where("workspaceId", "=", project.workspace.id)
      .execute();
    const before = await database.selectFrom("threads").select("id").execute();
    await expect(
      store.createProjectThread({
        ...request,
        origin,
        home: false,
        role: "work",
        title: "No configuration",
        idempotencyKey: "unconfigured",
      }),
    ).rejects.toMatchObject({ reason: "not-configured" });
    expect(await database.selectFrom("threads").select("id").execute()).toEqual(before);
  });
  it("refuses a superseded Runner boot and a changed native model without changing the admitted binding", async ({
    storeFixture,
  }) => {
    const { prepared, project, database } = await prepareProjectAdmission(storeFixture, true);
    const grant = await database
      .selectFrom("grants")
      .select("id")
      .where("runId", "=", prepared.run.id)
      .where("status", "=", "active")
      .executeTakeFirstOrThrow();
    const saved = await readProjectRunBinding(database, {
      runId: prepared.run.id,
      grantId: grant.id,
    });
    if (!saved) throw new Error("Missing admitted binding");
    await expect(
      assertActiveProjectBinding(database, saved.binding, { runnerIsAttached: () => false }),
    ).rejects.toMatchObject({ reason: "computer-offline" });
    await assertActiveProjectBinding(database, saved.binding, {
      runnerIsAttached: (id, boot) =>
        id === project.runnerId && boot === saved.binding.runnerBootId,
    });
    const row = await database
      .selectFrom("harnessCatalogs")
      .select("catalog")
      .where("harnessInstanceId", "=", prepared.harnessInstance.id)
      .executeTakeFirstOrThrow();
    if (row.catalog.status !== "ready") throw new Error("Project fixture has no model catalog");
    await database
      .updateTable("harnessCatalogs")
      .set({
        catalog: jsonValue({
          ...row.catalog,
          models: row.catalog.models.map((model) => ({
            ...model,
            nativeModelId: "different-provider-model",
          })),
        }),
      })
      .where("harnessInstanceId", "=", prepared.harnessInstance.id)
      .execute();
    await expect(
      assertActiveProjectBinding(database, saved.binding, { runnerIsAttached: () => true }),
    ).rejects.toMatchObject({ reason: "model-unavailable" });
    expect((await readProjectRunBinding(database, saved.binding))?.binding).toEqual(saved.binding);
  });
});
