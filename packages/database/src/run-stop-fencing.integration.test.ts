import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
  recordTestDatabaseSetup,
} from "./test-database.test-support.js";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HarnessIdSchema,
  ModelSelectionSchema,
  PendingRequestSchema,
  ThreadAccessModeSchema,
  createId,
  type EnvironmentId,
  type RequestId,
  type RunId,
  type RunnerId,
  type UserId,
} from "@opensteer/core";
import {
  HarnessInstanceCatalogSchema,
  type PendingAgentEvent,
  type RunnerDescriptor,
} from "@opensteer/protocol";

import { afterAll, describe, expect, it as baseIt } from "vitest";
import { withDatabaseTransaction } from "./connection.js";
import { createDatabase, OpensteerStore } from "./index.js";
import { revokeRunGrants } from "./run-grants.js";

/**
 * Stage 1 fault matrix, database side: every way a Stop, an answer, a steer or
 * a lease could slip past the authority that ended. Each scenario records its
 * outcome in `fault-matrix-database.json`.
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

integration.sequential("Run stop fencing", () => {
  async function createTestFixture() {
    type Fixture = Awaited<ReturnType<typeof fixture>>;
    const clone = await cloneTestDatabase("host");
    const databaseUrl = clone.url;
    const { database } = await ownTestDatabaseProducer(databaseUrl, async () => {
      const database = createDatabase({
        applicationName: "opensteer-run-stop-fencing-test",
        connectionString: databaseUrl,
        maxConnections: 4,
      });
      return { database, close: () => database.destroy() };
    });
    const store = new OpensteerStore(database);
    async function runStatus(runId: RunId): Promise<string | undefined> {
      return (
        await database
          .selectFrom("runs")
          .select("status")
          .where("id", "=", runId)
          .executeTakeFirst()
      )?.status;
    }
    async function requestStatus(requestId: RequestId): Promise<string | undefined> {
      return (
        await database
          .selectFrom("requests")
          .select("status")
          .where("id", "=", requestId)
          .executeTakeFirst()
      )?.status;
    }
    async function commandStatus(
      runId: RunId,
      type: "run.execute" | "run.interrupt",
    ): Promise<string | undefined> {
      return (
        await database
          .selectFrom("commands")
          .select("status")
          .where("runId", "=", runId)
          .where("type", "=", type)
          .executeTakeFirst()
      )?.status;
    }
    async function executeCommand(runId: RunId) {
      return (
        await database
          .selectFrom("commands")
          .select("id")
          .where("runId", "=", runId)
          .where("type", "=", "run.execute")
          .executeTakeFirstOrThrow()
      ).id;
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
    function bind(
      f: Fixture,
      runId: Parameters<OpensteerStore["acquireExecutionBinding"]>[0]["runId"],
    ) {
      return store.acquireExecutionBinding({
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
    function answer(f: Fixture, runId: RunId, requestId: RequestId, key: string) {
      return store.enqueueRunnerControl({
        idempotencyKey: `answer-${key}`,
        requestId,
        requestedBy: f.userId,
        response: { kind: "choice", optionId: "yes" },
        runId,
        sealedResponse: {
          envelope: Buffer.from("encrypted-test-response"),
          keyVersion: 1,
          requestFingerprint: `hmac-sha256-v1:1:${key}`,
        },
        threadId: f.thread.id,
        type: "request.respond",
      });
    }
    function stop(f: Fixture, runId: RunId, key: string) {
      return store.enqueueRunnerControl({
        idempotencyKey: `stop-${key}`,
        requestedBy: f.userId,
        runId,
        threadId: f.thread.id,
        type: "run.interrupt",
      });
    }
    function resume(f: Fixture, key: string) {
      return store.resumeThreadInputQueue({
        idempotencyKey: `resume-${key}`,
        requestedBy: f.userId,
        threadId: f.thread.id,
      });
    }
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

    return Object.freeze({
      database,
      store,
      runStatus,
      requestStatus,
      commandStatus,
      executeCommand,
      claim,
      bind,
      running,
      openRequest,
      answer,
      stop,
      resume,
      fixture,
      enrollRunner,
      databaseUrl,
    });
  }
  type StoreFixture = Awaited<ReturnType<typeof createTestFixture>>;
  const it = baseIt.extend<{ storeFixture: StoreFixture }>({
    storeFixture: async ({ task }, use) => {
      const started = performance.now();
      const fixture = await createTestFixture();
      recordTestDatabaseSetup(task, started);
      await use(fixture);
    },
  });

  afterAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), "opensteer-fault-matrix-"));
    const artifact = join(directory, "fault-matrix-database.json");
    await writeFile(artifact, `${JSON.stringify(matrix, null, 2)}\n`);
    console.info(`Database fault matrix: ${artifact}`);
  });

  it("ends a Run stopped before it was bound, and the Thread's next Run starts", async ({
    storeFixture,
  }) => {
    const { fixture, claim, stop, runStatus, bind, commandStatus, resume } = storeFixture;
    const f = await fixture("unbound");
    const run = await claim(f, "unbound");

    const stopped = await stop(f, run.id, "unbound");
    expect(await runStatus(run.id)).toBe("interrupted");
    expect(stopped.command.status).toBe("succeeded");
    await expect(bind(f, run.id)).rejects.toMatchObject({ code: "conflict" });
    expect(await commandStatus(run.id, "run.execute")).toBe("failed");

    await resume(f, "unbound");
    const next = await claim(f, "unbound-next");
    await expect(bind(f, next.id)).resolves.toMatchObject({ bindingGeneration: 1 });
    matrix["stop-before-binding"] = {
      nextRunBinds: true,
      runStatus: "interrupted",
      runnerReceivedExecute: false,
    };
  });

  it("ends a stopped Run its Runner never held instead of queueing it again", async ({
    storeFixture,
  }) => {
    const { fixture, claim, bind, stop, runStatus, store, resume } = storeFixture;
    const f = await fixture("unheld");
    const run = await claim(f, "unheld");
    await bind(f, run.id);
    await stop(f, run.id, "unheld");
    expect(await runStatus(run.id)).toBe("starting");

    // The same Runner boot reattaches holding nothing: it never received the Run.
    await store.attachRunnerExecutions({
      dispatchingRunIds: [],
      executions: [],
      leaseExpiresAt: new Date(Date.now() + 60_000),
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
    });
    expect(await runStatus(run.id)).toBe("interrupted");

    await resume(f, "unheld");
    const next = await claim(f, "unheld-next");
    await expect(bind(f, next.id)).resolves.toMatchObject({ bindingGeneration: 2 });
    matrix["stop-then-runner-never-held"] = { requeued: false, runStatus: "interrupted" };
  });

  it("ends a stopped Run whose dispatch is retried instead of queueing it again", async ({
    storeFixture,
  }) => {
    const { fixture, claim, bind, stop, executeCommand, store, runStatus, resume } = storeFixture;
    const f = await fixture("retried");
    const run = await claim(f, "retried");
    await bind(f, run.id);
    await stop(f, run.id, "retried");
    const execute = await executeCommand(run.id);

    // The registry refuses an execute its Stop overtook before the send, and
    // retries it as unsent work.
    await store.retryCommand(execute, new Error("Run execution authority was revoked"));
    expect(await runStatus(run.id)).toBe("interrupted");
    await resume(f, "retried");
    const next = await claim(f, "retried-next");
    await expect(bind(f, next.id)).resolves.toMatchObject({ bindingGeneration: 2 });
    matrix["stop-then-dispatch-retry"] = {
      nextRunBinds: true,
      requeued: false,
      runStatus: "interrupted",
    };
  });

  it("cancels a stopped Run's questions, refuses new answers and never delivers an admitted one", async ({
    storeFixture,
  }) => {
    const { fixture, running, openRequest, answer, store, runStatus, stop, requestStatus } =
      storeFixture;
    const f = await fixture("answers");
    const run = await running(f, "answers");
    const asked = await openRequest(f, run, 1);
    const answeredFirst = await openRequest(f, run, 2);
    const admitted = await answer(f, run.id, answeredFirst.id, "admitted");
    await store.claimCommand(admitted.command.id, "answers-dispatcher");

    expect(await runStatus(run.id)).toBe("waiting");
    await stop(f, run.id, "answers");
    expect(await requestStatus(asked.id)).toBe("cancelled");
    expect(await requestStatus(answeredFirst.id)).toBe("cancelled");
    // Nothing is left to answer, so no one is shown a question that is gone.
    expect(await runStatus(run.id)).toBe("running");

    await expect(answer(f, run.id, asked.id, "late")).rejects.toMatchObject({
      code: "conflict",
    });
    let delivered = false;
    await expect(
      store.dispatchRequestResponse(admitted.command.id, async () => {
        delivered = true;
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(delivered).toBe(false);
    matrix["answers-after-stop"] = {
      admittedAnswerDelivered: false,
      lateAnswer: "refused",
      pendingRequests: "cancelled",
    };
  });

  it("records an engine's question asked after Stop as cancelled, leaving the Run running", async ({
    storeFixture,
  }) => {
    const { fixture, running, stop, openRequest, requestStatus, runStatus } = storeFixture;
    const f = await fixture("late-ask");
    const run = await running(f, "late-ask");
    await stop(f, run.id, "late-ask");

    const late = await openRequest(f, run, 1);
    expect(await requestStatus(late.id)).toBe("cancelled");
    expect(await runStatus(run.id)).toBe("running");
    matrix["engine-asks-after-stop"] = { request: "cancelled", runStatus: "running" };
  });

  it("refuses a steer into a Run whose authority ended while it still runs", async ({
    storeFixture,
  }) => {
    const { fixture, running, store, database } = storeFixture;
    const f = await fixture("steer");
    const run = await running(f, "steer");
    const waiting = await store.enqueueThreadInput({
      content: [{ text: "Also do this", type: "text" }],
      idempotencyKey: "steer-waiting",
      policy: "queue",
      requestedBy: f.userId,
      source: { kind: "human" },
      threadId: f.thread.id,
    });
    // An Assignment cancel ends a worker's grant without pausing its queue.
    await withDatabaseTransaction(database, (transaction) =>
      revokeRunGrants(transaction, [run.id], "assignment-cancelled"),
    );

    await expect(
      store.steerThreadInput({
        expectedRunId: run.id,
        idempotencyKey: "steer-attempt",
        messageId: waiting.message.id,
        requestedBy: f.userId,
        threadId: f.thread.id,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    matrix["steer-after-authority-ended"] = { steer: "refused" };
  });

  it("never renews a lease that already ran out, nor one the Run no longer holds", async ({
    storeFixture,
  }) => {
    const { fixture, running, database, store } = storeFixture;
    const f = await fixture("leases");
    const run = await running(f, "leases");
    await database
      .updateTable("providerSessions")
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .execute();
    const renewed = await store.renewActiveExecutionBindings({
      activeRunIds: [run.id],
      leaseExpiresAt: new Date(Date.now() + 60_000),
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
    });
    expect(renewed).toEqual([]);

    // A Host that was down heard nothing: its boot restarts the lease once.
    await store.restartExecutionLeases(new Date(Date.now() + 60_000));
    expect(
      await store.renewActiveExecutionBindings({
        activeRunIds: [run.id],
        leaseExpiresAt: new Date(Date.now() + 60_000),
        runnerBootId: f.runnerBootId,
        runnerId: f.runnerId,
      }),
    ).toEqual([run.id]);

    // A binding the Run does not hold is never renewed in its name.
    await database
      .updateTable("runs")
      .set({ bindingGeneration: f.bindingGeneration + 1 })
      .where("id", "=", run.id)
      .execute();
    expect(
      await store.renewActiveExecutionBindings({
        activeRunIds: [run.id],
        leaseExpiresAt: new Date(Date.now() + 60_000),
        runnerBootId: f.runnerBootId,
        runnerId: f.runnerId,
      }),
    ).toEqual([]);
    matrix["lease-renewal"] = {
      expiredLeaseRenewed: false,
      restartedAfterHostBoot: true,
      supersededBindingRenewed: false,
    };
  });
});

function pendingEvent<T extends PendingAgentEvent>(input: Omit<T, "emittedAt">): T {
  return { ...input, emittedAt: new Date().toISOString() } as T;
}
