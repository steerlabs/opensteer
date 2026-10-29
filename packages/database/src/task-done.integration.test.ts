import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  HarnessIdSchema,
  ModelSelectionSchema,
  PendingRequestSchema,
  ThreadAccessModeSchema,
  createId,
  type EnvironmentId,
  type RunId,
  type RunnerId,
  type UserId,
} from "@opensteer/core";
import {
  HarnessInstanceCatalogSchema,
  type PendingAgentEvent,
  type RunnerDescriptor,
} from "@opensteer/protocol";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, migrateToLatest, OpensteerStore } from "./index.js";
import { pauseAfterLock } from "./lock-race.test-support.js";
import { TriggerStore } from "./trigger-store.js";

/**
 * Stage 1 fault matrix, database side: every way a Stop, an answer, a steer or
 * a lease could slip past the authority that ended. Each scenario records its
 * outcome in `journeys.json`.
 */
const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const modelSelection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: { effort: "low" },
  providerId: "openai",
});
const continuationIdentity = {
  continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
  driverKind: HarnessIdSchema.parse("native"),
} as const;
const matrix: Record<string, unknown> = {};

integration.sequential("Shared task Done", () => {
  const database = createDatabase({
    applicationName: "opensteer-run-stop-fencing-test",
    connectionString: databaseUrl ?? "postgres://unconfigured",
    maxConnections: 4,
  });
  const store = new OpensteerStore(database);

  beforeAll(async () => migrateToLatest(database));
  beforeEach(async () => {
    await sql`truncate table messages, runs, threads, harness_catalogs, harness_instances,
      runner_enrollments, requests,
      workspaces, execution_environments, runners, deployments, users restart identity cascade`.execute(
      database,
    );
    await sql`insert into principals(id, kind, user_id, display_name)
      values ('pri_00000000-0000-4000-8000-000000000001', 'system', null, 'Opensteer')
      on conflict (id) do nothing`.execute(database);
  });
  afterAll(async () => {
    await database.destroy();
    const directory = "/tmp/opensteer-task-done";
    await mkdir(directory, { recursive: true });
    const artifact = join(directory, "journeys.json");
    await writeFile(artifact, `${JSON.stringify(matrix, null, 2)}\n`);
    console.info(`Database fault matrix: ${artifact}`);
  });

  it.each(["queued", "starting", "running"] as const)(
    "stops %s work, freezes inputs and reopens before interrupt acknowledgement",
    async (status) => {
      const f = await fixture(status);
      const run =
        status === "running"
          ? await running(f, status)
          : status === "starting"
            ? await claim(f, status)
            : (await send(f, status)).run!;
      const steered =
        status === "running"
          ? await store.enqueueThreadInput({
              content: [{ type: "text", text: "Steering being delivered" }],
              idempotencyKey: "steer-before-done",
              policy: "steer",
              requestedBy: f.userId,
              source: { kind: "human" },
              threadId: f.thread.id,
            })
          : null;
      if (steered?.command) await store.claimCommand(steered.command.id, "steer-dispatcher");
      const request = status === "running" ? await openRequest(f, run, 1) : null;
      const queued = await send(f, "follow-up");
      const done = await setDone(f, true, "done");
      expect(done.thread.doneAt).not.toBeNull();
      expect(done.thread.inputQueuePaused).toBe(false);
      expect(
        await database
          .selectFrom("threadInputs")
          .selectAll()
          .where("messageId", "=", queued.input.messageId)
          .executeTakeFirst(),
      ).toMatchObject({ state: "cancelled", cancelReason: "task-done" });
      if (steered)
        expect(
          await database
            .selectFrom("threadInputs")
            .select(["state", "cancelReason"])
            .where("messageId", "=", steered.input.messageId)
            .executeTakeFirst(),
        ).toEqual({ state: "cancelled", cancelReason: "task-done" });
      if (request)
        expect(
          await database
            .selectFrom("requests")
            .selectAll()
            .where("id", "=", request.id)
            .executeTakeFirst(),
        ).toMatchObject({ status: "cancelled", cancellationReason: "thread-archived" });
      await expect(send(f, "refused")).rejects.toMatchObject({
        code: "conflict",
        message: "This task is Done. Reopen it first.",
      });
      expect((await setDone(f, true, "done")).wasDuplicate).toBe(true);
      expect((await setDone(f, false, "reopen")).thread.doneAt).toBeNull();
      const next = await send(f, "after-reopen");
      expect(next.input.state).toBe("pending");
      if (status === "running") {
        await store.commitRunnerEvent({
          environmentId: f.environmentId,
          runnerBootId: f.runnerBootId,
          runnerId: f.runnerId,
          event: pendingEvent({
            bindingGeneration: f.bindingGeneration,
            data: { status: "interrupted" },
            environmentId: f.environmentId,
            ordinal: f.ordinal++,
            runId: run.id,
            threadId: f.thread.id,
            type: "run.interrupted",
            workspaceId: f.workspace.id,
          }),
        });
      }
      const followOn = await database
        .selectFrom("runs")
        .selectAll()
        .where("threadId", "=", f.thread.id)
        .where("status", "=", "queued")
        .executeTakeFirstOrThrow();
      const command = await database
        .selectFrom("commands")
        .select("id")
        .where("runId", "=", followOn.id)
        .where("type", "=", "run.execute")
        .executeTakeFirstOrThrow();
      await store.claimCommand(command.id, "reopen-dispatcher");
      await expect(bind(f, followOn.id)).resolves.toMatchObject({
        bindingGeneration: expect.any(Number),
      });
      matrix[status] = {
        threadId: f.thread.id,
        runId: run.id,
        events: done.events,
        rows: await database
          .selectFrom("threadInputs")
          .selectAll()
          .where("threadId", "=", f.thread.id)
          .execute(),
      };
    },
  );

  it.each([false, true])(
    "applies self-Done at Run end unless a person queues work: %s",
    async (pending) => {
      const f = await fixture(`self-${pending}`);
      const run = await running(f, `self-${pending}`);
      const result = await store.setThreadDone({
        done: true,
        actorRunId: run.id,
        threadId: f.thread.id,
        requestedBy: f.userId,
        idempotencyKey: "self-done",
      });
      expect(result.doneWhenRunEnds).toBe(true);
      expect(result.thread.doneAt).toBeNull();
      if (pending) await send(f, "person-during-run");
      await finish(f, run.id);
      const thread = await store.getThreadForOwner(f.thread.id, f.userId);
      expect(thread?.doneAt === null).toBe(pending);
      expect(
        await database
          .selectFrom("runs")
          .select("doneWhenFinished")
          .where("id", "=", run.id)
          .executeTakeFirst(),
      ).toEqual({ doneWhenFinished: false });
      matrix[`self-${pending}`] = { runId: run.id, thread };
    },
  );

  it("reopen clears a pending self-Done intent", async () => {
    const f = await fixture("self-reopen");
    const run = await running(f, "self-reopen");
    await store.setThreadDone({
      done: true,
      actorRunId: run.id,
      threadId: f.thread.id,
      requestedBy: f.userId,
      idempotencyKey: "self-intent",
    });
    await setDone(f, false, "reopen-intent");
    await finish(f, run.id);
    expect((await store.getThreadForOwner(f.thread.id, f.userId))?.doneAt).toBeNull();
  });

  it("keeps an agent's self-Done intent when it reopens another task", async () => {
    const f = await fixture("self-reopen-other");
    const { thread: other } = await store.createThread({
      createdBy: f.userId,
      environmentId: f.environmentId,
      harnessInstanceId: f.harness.id,
      idempotencyKey: "thread-self-reopen-other-second",
      modelSelection,
      title: "Another task",
      workspaceId: f.workspace.id,
    });
    await store.setThreadDone({
      done: true,
      threadId: other.id,
      requestedBy: f.userId,
      idempotencyKey: "other-done",
    });
    const run = await running(f, "self-reopen-other");
    await store.setThreadDone({
      done: true,
      actorRunId: run.id,
      threadId: f.thread.id,
      requestedBy: f.userId,
      idempotencyKey: "self-intent-before-reopen",
    });
    await store.setThreadDone({
      done: false,
      actorRunId: run.id,
      threadId: other.id,
      requestedBy: f.userId,
      idempotencyKey: "reopen-other",
    });
    await finish(f, run.id);
    expect((await store.getThreadForOwner(f.thread.id, f.userId))?.doneAt).not.toBeNull();
    expect((await store.getThreadForOwner(other.id, f.userId))?.doneAt).toBeNull();
  });

  it("stops a child, pauses its Trigger and forbids a delegated agent from writing its assigner", async () => {
    const f = await fixture("cascade");
    const parentRun = await running(f, "cascade");
    const child = await delegate(f, parentRun.id, "cascade-child");
    await database
      .updateTable("runs")
      .set({ status: "running" })
      .where("id", "=", child.run.id)
      .execute();
    await expect(
      store.setThreadDone({
        done: true,
        actorRunId: child.run.id,
        threadId: f.thread.id,
        requestedBy: f.userId,
        idempotencyKey: "child-cannot-stop-parent",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      store.renameThread({
        actorRunId: child.run.id,
        threadId: f.thread.id,
        requestedBy: f.userId,
        idempotencyKey: "child-cannot-rename-parent",
        title: "Forbidden",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const triggers = new TriggerStore(database);
    const trigger = await triggers.create({
      actorThreadId: null,
      anchorThreadId: child.thread.id,
      createdBy: f.userId,
      idempotencyKey: "child-trigger",
      name: "Child schedule",
      program: {
        toolContractVersion: 2,
        language: "typescript",
        source: "export default async () => null;",
      },
      source: {
        kind: "schedule",
        schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString(), payload: null },
      },
    });
    const done = await setDone(f, true, "cascade-done");
    expect((await store.getThreadForOwner(child.thread.id, f.userId))?.doneAt).not.toBeNull();
    expect(
      await database
        .selectFrom("delegations")
        .select("status")
        .where("id", "=", child.assignment.id)
        .executeTakeFirst(),
    ).toEqual({ status: "cancelled" });
    expect(
      await database
        .selectFrom("triggers")
        .select(["status", "nextFireAt"])
        .where("id", "=", trigger.trigger.id)
        .executeTakeFirst(),
    ).toEqual({ status: "paused", nextFireAt: null });
    expect(done.interruptCommands.map(({ runId }) => runId).sort()).toEqual(
      [parentRun.id, child.run.id].sort(),
    );
    matrix.cascade = {
      events: done.events,
      childThreadId: child.thread.id,
      assignmentId: child.assignment.id,
      triggerId: trigger.trigger.id,
    };
  });

  it("delivers a completed child's return to a Done parent as a report", async () => {
    const f = await fixture("return");
    const parentRun = await running(f, "return");
    const child = await delegate(f, parentRun.id, "return-child");
    const childFixture = { ...f, thread: child.thread };
    await store.claimCommand(child.command.id, "child-dispatcher");
    const binding = await bind(childFixture, child.run.id);
    childFixture.bindingGeneration = binding.bindingGeneration;
    childFixture.ordinal = 0;
    await store.commitRunnerEvent({
      environmentId: f.environmentId,
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
      event: pendingEvent({
        bindingGeneration: binding.bindingGeneration,
        data: { status: "running" },
        environmentId: f.environmentId,
        ordinal: childFixture.ordinal++,
        runId: child.run.id,
        threadId: child.thread.id,
        type: "run.started",
        workspaceId: f.workspace.id,
      }),
    });
    await finish(childFixture, child.run.id);
    await setDone(f, true, "parent-done");
    await store.drainPendingAssignmentReturns();
    const assignment = await database
      .selectFrom("delegations")
      .selectAll()
      .where("id", "=", child.assignment.id)
      .executeTakeFirstOrThrow();
    expect(assignment.resultStatus).toBe("delivered");
    const reports = await database
      .selectFrom("threadInputs")
      .selectAll()
      .where("threadId", "=", f.thread.id)
      .where("policy", "=", "report")
      .execute();
    expect(reports).toHaveLength(1);
    matrix.return = { assignment, reports };
  });

  function delegate(f: Fixture, parentRunId: RunId, key: string) {
    return store.delegateThread({
      accessMode: "auto",
      createdBy: f.userId,
      environmentId: f.environmentId,
      harnessInstanceId: f.harness.id,
      idempotencyKey: key,
      modelSelection,
      origin: { kind: "run", parentRunId, parentThreadId: f.thread.id },
      task: [{ type: "text", text: key }],
      title: key,
      workspaceId: f.workspace.id,
    });
  }
  async function finish(f: Fixture, runId: RunId) {
    return store.commitRunnerEvent({
      environmentId: f.environmentId,
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
      event: pendingEvent({
        bindingGeneration: f.bindingGeneration,
        data: { status: "completed" },
        environmentId: f.environmentId,
        ordinal: f.ordinal++,
        runId,
        threadId: f.thread.id,
        type: "run.completed",
        workspaceId: f.workspace.id,
      }),
    });
  }

  it("shares Done with another member while preserving unread content and requiring creator authority", async () => {
    const f = await fixture("members");
    const member = await store.createUser("Reader");
    const now = new Date();
    await database
      .insertInto("workspaceMemberships")
      .values({
        id: createId("workspaceMembership"),
        workspaceId: f.workspace.id,
        userId: member,
        role: "collaborator",
        state: "active",
        generation: "1",
        invitedBy: f.userId,
        joinedAt: now,
        revokedAt: null,
        revokedBy: null,
        updatedAt: now,
      })
      .execute();
    await expect(
      store.setThreadDone({
        done: true,
        threadId: f.thread.id,
        requestedBy: member,
        idempotencyKey: "member-refused",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const done = await setDone(f, true, "creator-done");
    expect((await store.getThreadForOwner(f.thread.id, member))?.doneAt).toBe(done.thread.doneAt);
    expect(done.events).toContainEqual(
      expect.objectContaining({
        type: "thread.state-changed",
        workspaceId: f.workspace.id,
        data: expect.objectContaining({ doneAt: done.thread.doneAt }),
      }),
    );
    matrix.members = { threadId: f.thread.id, member, doneAt: done.thread.doneAt };
  });

  it("settles a delegated agent's Assignment before applying its self-Done", async () => {
    const f = await fixture("delegated-self");
    const parent = await running(f, "delegated-self");
    const child = await delegate(f, parent.id, "delegated-self-child");
    const worker = { ...f, thread: child.thread };
    await activateChild(worker, child);
    const intent = await store.setThreadDone({
      done: true,
      actorRunId: child.run.id,
      threadId: child.thread.id,
      requestedBy: f.userId,
      idempotencyKey: "worker-intent",
    });
    expect(intent.doneWhenRunEnds).toBe(true);
    await finish(worker, child.run.id);
    expect(
      (
        await database
          .selectFrom("delegations")
          .select("status")
          .where("id", "=", child.assignment.id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("completed");
    expect((await store.getThreadForOwner(child.thread.id, f.userId))?.doneAt).not.toBeNull();
  });

  it("keeps parent and child Done when the child completes while Done holds its Run fence", async () => {
    const f = await fixture("completion-race");
    const parent = await running(f, "completion-race");
    const child = await delegate(f, parent.id, "completion-race-child");
    const worker = { ...f, thread: child.thread };
    await activateChild(worker, child);
    const barrier = pauseAfterLock(
      database,
      (node) => node.includes('"name":"runs"') && node.includes("ForNoKeyUpdate"),
    );
    const peer = new OpensteerStore(barrier.database);
    const done = peer.setThreadDone({
      done: true,
      threadId: f.thread.id,
      requestedBy: f.userId,
      idempotencyKey: "racing-done",
    });
    let completion: ReturnType<typeof finish> | undefined;
    try {
      await barrier.reached;
      completion = finish(worker, child.run.id);
      barrier.release();
      await done;
      await completion;
      expect((await store.getThreadForOwner(child.thread.id, f.userId))?.doneAt).not.toBeNull();
      expect((await store.getThreadForOwner(f.thread.id, f.userId))?.doneAt).not.toBeNull();
      expect(
        (
          await database
            .selectFrom("delegations")
            .select("status")
            .where("id", "=", child.assignment.id)
            .executeTakeFirstOrThrow()
        ).status,
      ).toBe("cancelled");
      expect(barrier.conflicts).toEqual([]);
      matrix.completionRace = {
        parent: f.thread.id,
        child: child.thread.id,
        assignmentId: child.assignment.id,
      };
    } finally {
      barrier.release();
      await Promise.allSettled([done, ...(completion ? [completion] : [])]);
    }
  });

  async function activateChild(f: Fixture, child: Awaited<ReturnType<typeof delegate>>) {
    await store.claimCommand(child.command.id, "child-dispatcher");
    const binding = await bind(f, child.run.id);
    f.bindingGeneration = binding.bindingGeneration;
    f.ordinal = 0;
    await store.commitRunnerEvent({
      environmentId: f.environmentId,
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
      event: pendingEvent({
        bindingGeneration: binding.bindingGeneration,
        data: { status: "running" },
        environmentId: f.environmentId,
        ordinal: f.ordinal++,
        runId: child.run.id,
        threadId: f.thread.id,
        type: "run.started",
        workspaceId: f.workspace.id,
      }),
    });
  }

  it("refuses Chat", async () => {
    const f = await fixture("chat");
    await database
      .updateTable("workspaces")
      .set({ homeThreadId: f.thread.id })
      .where("id", "=", f.workspace.id)
      .execute();
    await expect(setDone(f, true, "chat-done")).rejects.toMatchObject({ code: "bad_request" });
  });

  function send(f: Fixture, key: string) {
    return store.enqueueThreadInput({
      content: [{ type: "text", text: key }],
      idempotencyKey: key,
      policy: "queue",
      requestedBy: f.userId,
      source: { kind: "human" },
      threadId: f.thread.id,
    });
  }
  function setDone(f: Fixture, done: boolean, key: string) {
    return store.setThreadDone({
      done,
      threadId: f.thread.id,
      requestedBy: f.userId,
      idempotencyKey: key,
    });
  }

  async function claim(f: Fixture, suffix: string) {
    const sent = await store.enqueueThreadInput({
      content: [{ text: `Work ${suffix}`, type: "text" }],
      idempotencyKey: `send-${suffix}`,
      policy: "queue",
      requestedBy: f.userId,
      source: { kind: "human" },
      threadId: f.thread.id,
    });
    if (!sent.command || !sent.run) throw new Error("Expected a queued Run");
    await store.claimCommand(sent.command.id, `${suffix}-dispatcher`);
    return sent.run;
  }

  async function bind(
    f: Fixture,
    runId: Parameters<OpensteerStore["acquireExecutionBinding"]>[0]["runId"],
  ) {
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity,
      harnessInstanceId: f.harness.id,
      leaseTokenHash: `lease-${runId}`,
      membershipGeneration: 1,
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
      runId,
      threadId: f.thread.id,
    });
    await store.bindProviderSession({
      bindingGeneration: binding.bindingGeneration,
      harnessInstanceId: f.harness.id,
      providerSessionId: binding.providerSessionId,
      providerSessionReference: `session-${f.thread.id}`,
      runId,
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
      threadId: f.thread.id,
    });
    return binding;
  }

  async function running(f: Fixture, suffix: string) {
    const run = await claim(f, suffix);
    const binding = await bind(f, run.id);
    f.bindingGeneration = binding.bindingGeneration;
    f.ordinal = 0;
    await store.commitRunnerEvent({
      environmentId: f.environmentId,
      event: pendingEvent({
        bindingGeneration: binding.bindingGeneration,
        data: { status: "running" },
        environmentId: f.environmentId,
        ordinal: f.ordinal++,
        runId: run.id,
        threadId: f.thread.id,
        type: "run.started",
        workspaceId: f.workspace.id,
      }),
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
    });
    return run;
  }

  async function openRequest(f: Fixture, run: { readonly id: RunId }, index: number) {
    const request = PendingRequestSchema.parse({
      callId: `call-${index}`,
      cancellationReason: null,
      createdAt: new Date().toISOString(),
      id: createId("request"),
      kind: "harness.approval",
      mode: "live",
      originatingOccurrenceId: null,
      originatingRunId: run.id,
      originatingThreadId: f.thread.id,
      originatingWorkspaceId: f.workspace.id,
      payload: { kind: "harness.approval" },
      presentation: {
        detail: "Confirm",
        kind: "choice",
        options: [{ hint: "confirm", id: "yes", label: "Yes" }],
        title: "Continue?",
      },
      requestedBy: f.userId,
      requiredActor: "requester",
      resolvedAt: null,
      resolvedBy: null,
      response: null,
      status: "pending",
      targetWorkspaceId: f.workspace.id,
    });
    await store.commitRunnerEvent({
      environmentId: f.environmentId,
      event: pendingEvent({
        bindingGeneration: f.bindingGeneration,
        data: { request },
        environmentId: f.environmentId,
        ordinal: f.ordinal++,
        runId: run.id,
        threadId: f.thread.id,
        type: "request.opened",
        workspaceId: f.workspace.id,
      }),
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
    });
    return request;
  }

  type Fixture = Awaited<ReturnType<typeof fixture>>;

  async function fixture(suffix: string) {
    await store.ensureDeployment({
      canonicalOrigin: "https://test-host.invalid",
      deploymentShape: { defaultWorkspaceBacking: "portablefs", kind: "server" },
      hostInstanceId: createId("hostInstance"),
    });
    const userId = await store.createUser("Owner");
    const runnerId = createId("runner");
    const environmentId = createId("environment");
    await enrollRunner({ environmentId, runnerId, suffix, userId });
    const workspace = await store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: `wsp_${suffix}`,
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: userId,
      idempotencyKey: `workspace-${suffix}`,
      name: `Workspace ${suffix}`,
      status: "ready",
    });
    const harness = await store.createHarnessInstance({
      config: { model: "test" },
      driverKind: HarnessIdSchema.parse("native"),
      environmentId,
      name: "Native",
      stateKind: "isolated",
    });
    await store.recordHarnessCatalogs({
      catalogs: [
        HarnessInstanceCatalogSchema.parse({
          continuationIdentity,
          driverKind: "native",
          harnessInstanceId: harness.id,
          models: [
            {
              displayName: "GPT-5.6 Sol",
              isDefault: true,
              modelId: modelSelection.modelId,
              options: [],
              providerId: modelSelection.providerId,
            },
          ],
          status: "ready",
        }),
      ],
      environmentId,
      expectedRevisions: new Map([[harness.id, harness.runtimeRevision]]),
    });
    const { thread } = await store.createThread({
      createdBy: userId,
      environmentId,
      harnessInstanceId: harness.id,
      idempotencyKey: `thread-${suffix}`,
      modelSelection,
      title: `Thread ${suffix}`,
      workspaceId: workspace.id,
    });
    return {
      bindingGeneration: 0,
      environmentId,
      harness,
      ordinal: 0,
      runnerBootId: `boot-${suffix}`,
      runnerId,
      thread,
      userId,
      workspace,
    };
  }

  async function enrollRunner(input: {
    environmentId: EnvironmentId;
    runnerId: RunnerId;
    suffix: string;
    userId: UserId;
  }) {
    const pair = generateKeyPairSync("ed25519");
    const descriptor: RunnerDescriptor = {
      bootId: `rbt_${randomUUID()}` as RunnerDescriptor["bootId"],
      capabilities: ["filesystem"],
      name: "Main runner",
      runnerId: input.runnerId,
      runnerKind: "main",
      runtimeVersion: "test",
      modules: {
        agents: {
          environmentIds: [input.environmentId],
          harnessDrivers: [
            {
              accessModes: ThreadAccessModeSchema.options,
              driverKind: HarnessIdSchema.parse("native"),
              readiness: "configured",
              steering: true,
              sources: [
                {
                  fields: [],
                  kind: "first-party",
                  label: "Native",
                  quota: "none",
                  sourceId: "native",
                  stateKinds: ["isolated"],
                },
              ],
            },
          ],
          localStorage: null,
          maxConcurrentRuns: 4,
          providerStateModes: ["isolated"],
          workspaceBackings: ["portablefs"],
          workspaceMounts: [],
        },
      },
    };
    const tokenHash = `sha256:${createHash("sha256").update(input.suffix).digest("base64url")}`;
    await store.createRunnerEnrollment({
      allowedModules: ["agents"],
      createdBy: input.userId,
      expiresAt: new Date(Date.now() + 60_000),
      id: `ren_${randomUUID()}`,
      idempotencyKey: `runner-${input.suffix}`,
      mainEnrollmentPurpose: "initial",
      name: descriptor.name,
      requestFingerprint: `sha256:${input.suffix}`,
      runnerKind: "main",
      tokenHash,
    });
    await store.enrollRunnerConnection({
      descriptor,
      enrollmentTokenHash: tokenHash,
      publicKeyFingerprint: `sha256:${createHash("sha256")
        .update(pair.publicKey.export({ format: "der", type: "spki" }))
        .digest("base64url")}`,
      publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
    });
  }
});

function pendingEvent<T extends PendingAgentEvent>(input: Omit<T, "emittedAt">): T {
  return { ...input, emittedAt: new Date().toISOString() } as T;
}
