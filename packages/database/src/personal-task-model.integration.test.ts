import { personTaskReader } from "./task-reader.js";
import { sql } from "kysely";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createId,
  ModelSelectionSchema,
  HarnessIdSchema,
  ProviderContinuationIdentitySchema,
  type ContentPart,
  type ThreadId,
  type RunId,
} from "@opensteer/core";
import { afterEach, expect, it, vi } from "vitest";
import { createDatabase } from "./connection.js";
import { cloneTestDatabase } from "./test-database.test-support.js";
import { seedPersonalFixture } from "./personal-fixture.test-support.js";

// These tests exercise the personal scheduler without a browser, integration or Messaging bridge.
const adapters = vi.hoisted(() => ({
  unexpected: () => {
    throw new Error("This personal task fixture has no private-resource adapter");
  },
}));
vi.mock("./computer-app-approvals.js", () => ({
  askForComputerAppApprovalInTransaction: adapters.unexpected,
  computerUsePolicyInTransaction: adapters.unexpected,
  lockComputerApprovalScopeInTransaction: adapters.unexpected,
}));
vi.mock("./computer-app-setup.js", () => ({
  computerAppAccessPresentation: adapters.unexpected,
  computerAppScopeOf: adapters.unexpected,
  computerAppSetupRequestFromRow: adapters.unexpected,
}));
vi.mock("./integration-platform-stores.js", () => ({
  IntegrationGrantStore: adapters.unexpected,
  approveComputerAppAutomaticallyInTransaction: adapters.unexpected,
  installIntegrationInTransaction: adapters.unexpected,
  lockIntegrationCatalogDefinitionInTransaction: adapters.unexpected,
  lockIntegrationInstallationIdentityInTransaction: adapters.unexpected,
}));
vi.mock("./browser-home-store.js", () => ({ lockBrowserHomeRunner: adapters.unexpected }));
vi.mock("./browser-session-store.js", () => ({
  insertBrowserProfileOnLockedHome: adapters.unexpected,
  recordIncludedBrowserPages: async (
    _tx: unknown,
    input: { content: readonly { type: string }[] },
  ) => {
    if (input.content.some((part) => part.type === "browser-page")) adapters.unexpected();
    return [];
  },
}));
vi.mock("./channel-authority.js", () => ({ resolveChannelAuthority: adapters.unexpected }));
vi.mock("./channel-execution.js", () => ({
  lockThreadChannelAuthorities: async () => {},
  channelInputAuthorityIsCurrent: async () => true,
  channelRunAuthorityIsCurrent: async () => true,
}));
vi.mock("./channel-deliveries.js", () => ({
  enqueueChannelConversationStatus: adapters.unexpected,
  enqueueChannelReply: adapters.unexpected,
}));

import { agentThreadPageForOwner, createThread, enqueueThreadInput } from "./thread-store.js";
import { claimCommand } from "./command-store.js";
import { acquireExecutionBinding, bindProviderSession } from "./execution-store.js";
import { commitRunnerEvent } from "./runner-event-store.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import { publishRunQueue } from "./thread-status.js";
import { returnRunToQueue } from "./store-primitives.js";
import { openVoiceThread } from "./voice-store.js";
import { createMemoryPass } from "./memory-pass-store.js";
import { TriggerStore } from "./trigger-store.js";
import { testRunnerDescriptor } from "./store.integration.test-support.js";
import { withPersonalTransaction } from "./personal-transaction.js";
import { jsonValue, threadPathLinks } from "./store-primitives.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "opensteer-personal-model-")));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const clone = await cloneTestDatabase("host");
  cleanups.push(clone.drop);
  const database = createDatabase({ connectionString: clone.url, maxConnections: 4 });
  cleanups.push(() => database.destroy());
  const personal = await seedPersonalFixture(database, directory);
  const harnessInstanceId = createId("harnessInstance");
  await database
    .insertInto("harnessInstances")
    .values({
      id: harnessInstanceId,
      environmentId: personal.environmentId,
      driverKind: HarnessIdSchema.parse("codex"),
      sourceId: "codex",
      name: "Fixture",
      config: {},
      runtimeRevision: 1,
      enabled: true,
      isDefault: true,
      stateKind: "ambient",
      removedAt: null,
    })
    .execute();
  const modelSelection = ModelSelectionSchema.parse({
    providerId: "openai",
    modelId: "gpt-5.6-sol",
    options: {},
  });
  const execution = { environmentId: personal.environmentId, harnessInstanceId, modelSelection };
  const task = async (title: string) =>
    (
      await createThread(database, {
        ...execution,
        createdBy: personal.userId,
        idempotencyKey: `task:${title}`,
        title,
      })
    ).thread;
  const start = async (runId: RunId) => {
    const command = await database
      .selectFrom("commands")
      .select("id")
      .where("runId", "=", runId)
      .where("type", "=", "run.execute")
      .executeTakeFirstOrThrow();
    await claimCommand(database, command.id, "fixture");
    const run = await database
      .selectFrom("runs")
      .selectAll()
      .where("id", "=", runId)
      .executeTakeFirstOrThrow();
    const bound = await acquireExecutionBinding(database, {
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: ProviderContinuationIdentitySchema.parse({
        driverKind: "codex",
        continuationKey: `runner:v1:${"A".repeat(43)}`,
      }),
      harnessInstanceId,
      leaseTokenHash: "fixture",
      runnerBootId: "fixture",
      runnerId: personal.runnerId,
      runId,
      threadId: run.threadId,
    });
    await bindProviderSession(database, {
      bindingGeneration: bound.bindingGeneration,
      harnessInstanceId,
      providerSessionId: bound.providerSessionId,
      providerSessionReference: `fixture:${run.threadId}`,
      runId,
      runnerBootId: "fixture",
      runnerId: personal.runnerId,
      threadId: run.threadId,
    });
    await commitRunnerEvent(database, threadPathLinks, {
      environmentId: personal.environmentId,
      runnerId: personal.runnerId,
      runnerBootId: "fixture",
      event: {
        type: "run.started",
        environmentId: personal.environmentId,
        emittedAt: new Date().toISOString(),
        ordinal: 0,
        bindingGeneration: bound.bindingGeneration,
        runId,
        threadId: run.threadId,
        data: { status: "running" },
      },
    });
    return { run, bindingGeneration: bound.bindingGeneration };
  };
  const emit = async (runId: RunId, bindingGeneration: number, text: string) => {
    const run = await database
      .selectFrom("runs")
      .selectAll()
      .where("id", "=", runId)
      .executeTakeFirstOrThrow();
    await commitRunnerEvent(database, threadPathLinks, {
      environmentId: personal.environmentId,
      runnerId: personal.runnerId,
      runnerBootId: "fixture",
      event: {
        type: "assistant.message",
        environmentId: personal.environmentId,
        emittedAt: new Date().toISOString(),
        ordinal: run.nextRunnerOrdinal,
        bindingGeneration,
        runId,
        threadId: run.threadId,
        data: { messageId: createId("message"), content: [{ type: "text", text }] },
      },
    });
  };
  const finish = async (runId: RunId, bindingGeneration: number) => {
    const run = await database
      .selectFrom("runs")
      .selectAll()
      .where("id", "=", runId)
      .executeTakeFirstOrThrow();
    await commitRunnerEvent(database, threadPathLinks, {
      environmentId: personal.environmentId,
      runnerId: personal.runnerId,
      runnerBootId: "fixture",
      event: {
        type: "run.completed",
        environmentId: personal.environmentId,
        emittedAt: new Date().toISOString(),
        ordinal: run.nextRunnerOrdinal,
        bindingGeneration,
        runId,
        threadId: run.threadId,
        data: { status: "completed" },
      },
    });
  };
  return { ...personal, database, execution, task, start, finish, emit };
}

it("keeps Voice in personal settings and uses real task anchors for Triggers", async () => {
  const f = await fixture();
  const { HarnessInstanceCatalogSchema } = await import("@opensteer/protocol");
  const catalog = HarnessInstanceCatalogSchema.parse({
    status: "ready",
    driverKind: "codex",
    harnessInstanceId: f.execution.harnessInstanceId,
    continuationIdentity: { driverKind: "codex", continuationKey: `runner:v1:${"A".repeat(43)}` },
    models: [
      {
        providerId: "openai",
        modelId: "gpt-5.6-sol",
        displayName: "Fixture",
        isDefault: true,
        options: [],
      },
    ],
  });
  await f.database
    .insertInto("harnessCatalogs")
    .values({
      environmentId: f.environmentId,
      harnessInstanceId: f.execution.harnessInstanceId,
      catalog,
      capturedAt: new Date(),
    })
    .execute();
  const opened = await openVoiceThread(f.database, { ownerId: f.userId, ...f.execution });
  const again = await openVoiceThread(f.database, { ownerId: f.userId, ...f.execution });
  expect(again.threadId).toBe(opened.threadId);
  expect(
    await f.database
      .selectFrom("threads")
      .select(["purpose", "parentThreadId"])
      .where("id", "=", opened.threadId)
      .executeTakeFirstOrThrow(),
  ).toEqual({ purpose: "voice", parentThreadId: null });
  expect(
    (
      await f.database
        .selectFrom("personalSettings")
        .select("voiceThreadId")
        .executeTakeFirstOrThrow()
    ).voiceThreadId,
  ).toBe(opened.threadId);
  const anchor = await f.task("Watch anchor");
  const triggers = new TriggerStore(f.database);
  const created = await triggers.create({
    actorThreadId: null,
    anchorThreadId: anchor.id,
    createdBy: f.userId,
    idempotencyKey: "anchor",
    name: "A schedule",
    source: {
      kind: "schedule",
      schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() },
    },
    script: {
      interpreter: null,
      text: "console.log('ok')",
    },
  });
  expect(created.trigger.anchorThreadId).toBe(anchor.id);
  await expect(
    triggers.create({
      actorThreadId: null,
      anchorThreadId: "home" as ThreadId,
      createdBy: f.userId,
      idempotencyKey: "no-home-alias",
      name: "Invalid",
      source: {
        kind: "schedule",
        schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() },
      },
      script: {
        interpreter: null,
        text: "console.log('ok')",
      },
    }),
  ).rejects.toThrow();
});

it("owns independent memory jobs that see ordinary tasks as changed", async () => {
  const f = await fixture();
  const {
    rows: [clock],
  } = await sql<{ since: Date }>`select clock_timestamp() as since`.execute(f.database);
  const since = clock!.since;
  const ordinary = await f.task("Ordinary source");
  await enqueueThreadInput(f.database, {
    threadId: ordinary.id,
    requestedBy: f.userId,
    source: { kind: "human" },
    policy: "queue",
    content: [{ type: "text", text: "Personal work" }],
    idempotencyKey: "personal-source",
  });
  const personalRun = await f.database
    .selectFrom("runs")
    .select("id")
    .where("threadId", "=", ordinary.id)
    .executeTakeFirstOrThrow();
  const started = await f.start(personalRun.id);
  await f.finish(personalRun.id, started.bindingGeneration);
  for (const systemRole of ["memory-light", "memory-nightly"] as const) {
    const created = await createMemoryPass(f.database, {
      ownerId: f.userId,
      execution: f.execution,
      systemRole,
      pauseReason: null,
      script: {
        interpreter: null,
        text: "console.log('ok')",
      },
      source: {
        kind: "schedule",
        schedule: { kind: "cron", expression: "0 3 * * *", timezone: "UTC" },
      },
    });
    expect(created).not.toBeNull();
    const worker = await f.database
      .selectFrom("threads")
      .selectAll()
      .where("id", "=", created!.trigger.anchorThreadId)
      .executeTakeFirstOrThrow();
    expect(worker).toMatchObject({
      parentThreadId: null,
      purpose: "background-job",
      listed: false,
    });
  }
  const changed = await agentThreadPageForOwner(f.database, {
    reader: personTaskReader,
    ownerId: f.userId,
    scope: { kind: "personal" },
    scopeId: f.userId,
    changedSince: since,
  });
  expect(changed.threads.map(({ id }) => id).sort()).toEqual([ordinary.id].sort());
  expect(
    (
      await f.database
        .selectFrom("triggers")
        .select("systemRole")
        .where("systemRole", "is not", null)
        .execute()
    )
      .map((row) => row.systemRole)
      .sort(),
  ).toEqual(["memory-light", "memory-nightly"]);
});

it("preserves a reply reported by the live attempt while its steer restart is pending", async () => {
  const f = await fixture();
  const task = await f.task("Waiting for the original reply");
  const descriptor = testRunnerDescriptor({
    runnerId: f.runnerId,
    environmentId: f.environmentId,
    name: "Fixture",
    runnerKind: "main",
  });
  if (!descriptor.modules.agents) throw new Error("Missing fixture agents");
  await f.database
    .updateTable("runners")
    .set({
      capabilities: jsonValue([...descriptor.capabilities, "attempts-v1"]),
      moduleDescriptors: {
        agents: {
          ...descriptor.modules.agents,
          harnessDrivers: descriptor.modules.agents.harnessDrivers.map((driver) => ({
            ...driver,
            driverKind: HarnessIdSchema.parse("codex"),
            steering: false,
          })),
        },
      },
    })
    .where("id", "=", f.runnerId)
    .execute();
  const send = (policy: "queue" | "steer") =>
    enqueueThreadInput(f.database, {
      threadId: task.id,
      requestedBy: f.userId,
      source: { kind: "human" },
      policy,
      content: [
        { type: "text", text: policy === "queue" ? "Draft the plan" : "Use the blue palette" },
      ],
      idempotencyKey: `pending-restart:${policy}`,
    });
  const initial = await send("queue");
  const { run, bindingGeneration } = await f.start(initial.run!.id);
  const steer = await send("steer");
  expect(steer.command?.type).toBe("run.restart");
  await f.emit(run.id, bindingGeneration, "Original answer");
  await f.finish(run.id, bindingGeneration);
  expect(
    await f.database
      .selectFrom("messages")
      .select("content")
      .where("runId", "=", run.id)
      .where("kind", "=", "assistant")
      .execute(),
  ).toEqual([{ content: [{ type: "text", text: "Original answer" }] }]);
});

it("bounds Deployment-wide Needs you and rolls navigation up without changing Request origin", async () => {
  const f = await fixture();
  const parent = await f.task("Assigning task");
  const child = (
    await createThread(f.database, {
      ...f.execution,
      createdBy: f.userId,
      parentThreadId: parent.id,
      idempotencyKey: "needs-you-child",
      title: "Private helper",
    })
  ).thread;
  const queued = await enqueueThreadInput(f.database, {
    threadId: child.id,
    requestedBy: f.userId,
    source: { kind: "human" },
    policy: "queue",
    content: [{ type: "text", text: "Read a private source" }],
    idempotencyKey: "needs-you-start",
  });
  await f.start(queued.run!.id);
  const { RequestStore } = await import("./request-store.js");
  const requests = new RequestStore(f.database);
  for (let i = 0; i < 3; i++)
    await requests.create({
      callId: `needs-you-${i}`,
      kind: "browser.access",
      mode: "durable",
      originatingRunId: queued.run!.id,
      originatingThreadId: child.id,
      requestedBy: f.userId,
      requiredActor: "requester",
      payload: {
        kind: "browser.access",
        reason: "Read a source",
        suggestion: { kind: "user_choice" },
      },
      presentation: {
        kind: "external",
        title: "Choose a profile",
        subject: { kind: "task", id: child.id },
      },
    });
  const { needsYouPage } = await import("./needs-you-store.js");
  const first = await needsYouPage(f.database, { userId: f.userId, limit: 2 });
  expect(first).toMatchObject({ count: 3, window: { hasMore: true, itemCount: 2 } });
  expect(
    first.entries.every(
      (entry) =>
        entry.kind === "request" &&
        entry.originThreadId === child.id &&
        entry.navigationThreadId === parent.id &&
        entry.request.originatingThreadId === child.id,
    ),
  ).toBe(true);
  const second = await needsYouPage(f.database, {
    userId: f.userId,
    limit: 2,
    before: first.window.nextBefore!,
  });
  expect(second).toMatchObject({ count: 3, window: { hasMore: false, itemCount: 1 } });
  expect(
    new Set(
      [...first.entries, ...second.entries]
        .filter((entry) => entry.kind === "request")
        .map((entry) => entry.request.id),
    ).size,
  ).toBe(3);
  expect(await f.database.selectFrom("requests").select("originatingThreadId").execute()).toEqual(
    Array.from({ length: 3 }, () => ({ originatingThreadId: child.id })),
  );
  const { readPersonalShellSnapshot } = await import("./snapshot-store.js");
  const { withPersonalSyncRead } = await import("./personal-sync-store.js");
  const ready = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let resourceCount = 0;
  const snapshot = withPersonalSyncRead(f.database, async (tx) => {
    resourceCount = Number(
      (
        await tx
          .selectFrom("requests")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .executeTakeFirstOrThrow()
      ).count,
    );
    ready.resolve();
    await withTimeout(release.promise, 5_000, {
      timeoutError: () => new Error("Snapshot read never released"),
    });
    return readPersonalShellSnapshot(tx, { viewerId: f.userId });
  });
  let snapshotError: unknown;
  void snapshot.catch((error) => {
    snapshotError = error;
  });
  let writer: ReturnType<typeof requests.create> | undefined;
  try {
    await withTimeout(ready.promise, 5_000, {
      timeoutError: () => new Error("Snapshot never entered its read transaction"),
    });
    writer = requests.create({
      callId: "needs-you-later",
      kind: "browser.access",
      mode: "durable",
      originatingRunId: queued.run!.id,
      originatingThreadId: child.id,
      requestedBy: f.userId,
      requiredActor: "requester",
      payload: {
        kind: "browser.access",
        reason: "Another source",
        suggestion: { kind: "user_choice" },
      },
      presentation: {
        kind: "external",
        title: "Another profile",
        subject: { kind: "task", id: child.id },
      },
    });
    // A pure read holds no mutation fence: the later Request commits while the
    // snapshot is open, and the snapshot keeps its own point in time.
    await withTimeout(writer, 5_000, {
      timeoutError: () => new Error("A later Request waited on an open snapshot"),
    });
    if (snapshotError) throw snapshotError;
    const committed = await f.database
      .selectFrom("clientSyncState")
      .select("sequence")
      .executeTakeFirstOrThrow();
    release.resolve();
    const view = await snapshot;
    // The reader resumes after the snapshot's sequence, so it still hears the later Request.
    expect(BigInt(view.state.sequence)).toBeLessThan(BigInt(committed.sequence));
    if (view.kind !== "snapshot") throw new Error("Expected a shell snapshot");
    expect(resourceCount).toBe(3);
    expect(view.snapshot.counts.needsYouCount).toBe(3);
    expect(Buffer.byteLength(JSON.stringify(view.snapshot))).toBeLessThanOrEqual(96 * 1024);
    expect((await needsYouPage(f.database, { userId: f.userId })).count).toBe(4);
  } finally {
    release.resolve();
    await Promise.allSettled([snapshot, writer]);
  }
});

it("navigates a reused worker's Request to the current assigning task without changing its origin", async () => {
  const f = await fixture();
  const original = await f.task("Original lineage parent");
  const assigning = await f.task("Current assigning task");
  const child = (
    await createThread(f.database, {
      ...f.execution,
      createdBy: f.userId,
      parentThreadId: original.id,
      idempotencyKey: "reused-needs-you",
      title: "Reused helper",
    })
  ).thread;
  const send = (threadId: ThreadId, idempotencyKey: string) =>
    enqueueThreadInput(f.database, {
      threadId,
      requestedBy: f.userId,
      source: { kind: "human" },
      policy: "queue",
      content: [{ type: "text", text: "Work" }],
      idempotencyKey,
    });
  const parentInput = await send(assigning.id, "assigner-needs-you");
  await f.start(parentInput.run!.id);
  const childInput = await send(child.id, "worker-needs-you");
  const assignmentId = createId("delegation");
  await withPersonalTransaction(f.database, async (transaction) => {
    await transaction
      .updateTable("runs")
      .set({ assignmentId })
      .where("id", "=", childInput.run!.id)
      .execute();
    await transaction
      .updateTable("threadInputs")
      .set({ assignmentId })
      .where("messageId", "=", childInput.message.id)
      .execute();
    await transaction
      .insertInto("delegations")
      .values({
        id: assignmentId,
        childRunId: childInput.run!.id,
        childThreadId: child.id,
        initialInputMessageId: childInput.message.id,
        objective: "Work",
        origin: "run",
        parentAssignmentId: null,
        parentRunId: parentInput.run!.id,
        parentThreadId: assigning.id,
        parentOccurrenceId: null,
        parentWatchActivationId: null,
        status: "open",
        revision: 1,
        resultStatus: "pending",
        resultText: null,
        finishedAt: null,
        completedAt: null,
        replyTarget: null,
        resultAttemptedAt: null,
        resultMessageId: null,
        resultReason: null,
      })
      .execute();
  });
  await f.start(childInput.run!.id);
  const { RequestStore } = await import("./request-store.js");
  const request = await new RequestStore(f.database).create({
    callId: "reused-needs-you-request",
    kind: "browser.access",
    mode: "durable",
    originatingRunId: childInput.run!.id,
    originatingThreadId: child.id,
    requestedBy: f.userId,
    requiredActor: "requester",
    payload: {
      kind: "browser.access",
      reason: "Read a source",
      suggestion: { kind: "user_choice" },
    },
    presentation: {
      kind: "external",
      title: "Choose a profile",
      subject: { kind: "task", id: child.id },
    },
  });
  const { needsYouPage } = await import("./needs-you-store.js");
  expect((await needsYouPage(f.database, { userId: f.userId })).entries).toMatchObject([
    {
      originThreadId: child.id,
      navigationThreadId: assigning.id,
      title: assigning.title,
      request: {
        id: request.request.id,
        originatingThreadId: child.id,
        originatingRunId: childInput.run!.id,
      },
    },
  ]);
  await expect(
    f.database
      .selectFrom("threads")
      .select("parentThreadId")
      .where("id", "=", child.id)
      .executeTakeFirstOrThrow(),
  ).resolves.toEqual({ parentThreadId: original.id });
});

it("shows a Request from an automation's own task, or work it handed out, on the task above", async () => {
  const f = await fixture();
  const parent = await f.task("Watch prices");
  const linked = async (parentThreadId: ThreadId, title: string) =>
    (
      await createThread(f.database, {
        ...f.execution,
        createdBy: f.userId,
        parentThreadId,
        idempotencyKey: `linked:${title}`,
        title,
      })
    ).thread;
  const monitor = await linked(parent.id, "Price monitor");
  const helper = await linked(monitor.id, "Checkout helper");
  const send = (threadId: ThreadId, idempotencyKey: string) =>
    enqueueThreadInput(f.database, {
      threadId,
      requestedBy: f.userId,
      source: { kind: "human" },
      policy: "queue",
      content: [{ type: "text", text: "Work" }],
      idempotencyKey,
    });
  const monitorInput = await send(monitor.id, "monitor-asks");
  await f.start(monitorInput.run!.id);
  const helperInput = await send(helper.id, "helper-asks");
  const assignmentId = createId("delegation");
  await withPersonalTransaction(f.database, async (transaction) => {
    await transaction
      .updateTable("runs")
      .set({ assignmentId })
      .where("id", "=", helperInput.run!.id)
      .execute();
    await transaction
      .insertInto("delegations")
      .values({
        id: assignmentId,
        childRunId: helperInput.run!.id,
        childThreadId: helper.id,
        initialInputMessageId: helperInput.message.id,
        objective: "Check out",
        origin: "run",
        parentAssignmentId: null,
        parentRunId: monitorInput.run!.id,
        parentThreadId: monitor.id,
        parentOccurrenceId: null,
        parentWatchActivationId: null,
        status: "open",
        revision: 1,
        resultStatus: "pending",
        resultText: null,
        finishedAt: null,
        completedAt: null,
        replyTarget: null,
        resultAttemptedAt: null,
        resultMessageId: null,
        resultReason: null,
      })
      .execute();
  });
  await f.start(helperInput.run!.id);
  const { RequestStore } = await import("./request-store.js");
  const requests = new RequestStore(f.database);
  const ask = async (runId: RunId, threadId: ThreadId) =>
    (
      await requests.create({
        callId: `ask:${threadId}`,
        kind: "browser.access",
        mode: "durable",
        originatingRunId: runId,
        originatingThreadId: threadId,
        requestedBy: f.userId,
        requiredActor: "requester",
        payload: { kind: "browser.access", reason: "Sign in", suggestion: { kind: "user_choice" } },
        presentation: {
          kind: "external",
          title: "Choose a profile",
          subject: { kind: "task", id: threadId },
        },
      })
    ).request.id;
  const fromMonitor = await ask(monitorInput.run!.id, monitor.id);
  const fromHelper = await ask(helperInput.run!.id, helper.id);
  const shown = { threadId: parent.id, workerThread: { id: monitor.id, title: "Price monitor" } };
  const page = await requests.waitingOnUserPage({ userId: f.userId, limit: 10 });
  expect(
    Object.fromEntries(
      page.requests.map(({ presentation, request }) => [request.id, presentation]),
    ),
  ).toEqual({ [fromMonitor]: shown, [fromHelper]: shown });
  const { needsYouPage } = await import("./needs-you-store.js");
  expect(
    Object.fromEntries(
      (await needsYouPage(f.database, { userId: f.userId })).entries
        .filter((entry) => entry.kind === "request")
        .map((entry) => [entry.request.id, entry.navigationThreadId]),
    ),
  ).toEqual({ [fromMonitor]: parent.id, [fromHelper]: parent.id });
});

it("keeps a reply that says nothing out of the transcript, and a file-only reply in it", async () => {
  const f = await fixture();
  const task = await f.task("Quiet check");
  const input = await enqueueThreadInput(f.database, {
    threadId: task.id,
    requestedBy: f.userId,
    source: { kind: "human" },
    policy: "queue",
    content: [{ type: "text", text: "Check" }],
    idempotencyKey: "quiet-check",
  });
  const { run, bindingGeneration } = await f.start(input.run!.id);
  const reply = async (content: readonly ContentPart[]) => {
    const messageId = createId("message");
    const ordinal = (
      await f.database
        .selectFrom("runs")
        .select("nextRunnerOrdinal")
        .where("id", "=", run.id)
        .executeTakeFirstOrThrow()
    ).nextRunnerOrdinal;
    const committed = await commitRunnerEvent(f.database, threadPathLinks, {
      environmentId: f.environmentId,
      runnerId: f.runnerId,
      runnerBootId: "fixture",
      event: {
        type: "assistant.message",
        environmentId: f.environmentId,
        emittedAt: new Date().toISOString(),
        ordinal,
        bindingGeneration,
        runId: run.id,
        threadId: task.id,
        data: { messageId, content: [...content] },
      },
    });
    return { committed, messageId };
  };
  const sequence = async () =>
    Number(
      (
        await f.database
          .selectFrom("threads")
          .select("nextMessageSequence")
          .where("id", "=", task.id)
          .executeTakeFirstOrThrow()
      ).nextMessageSequence,
    );
  const before = await sequence();
  const blank = await reply([{ type: "text", text: " \n" }]);
  expect(blank.committed.replayed).toBe(false);
  const blankReceipt = await f.database
    .selectFrom("runnerEventReceipts")
    .select("ordinal")
    .where("runId", "=", run.id)
    .where("ordinal", "=", 1)
    .executeTakeFirst();
  expect(blankReceipt).toBeDefined();
  expect(await sequence()).toBe(before);
  const file = await reply([
    { type: "artifact", artifactId: "art_report", mediaType: "text/csv", name: "deals.csv" },
  ]);
  expect(
    await f.database
      .selectFrom("transcriptItems")
      .select(["id", "visible"])
      .where("threadId", "=", task.id)
      .where("id", "in", [blank.messageId, file.messageId])
      .execute(),
  ).toEqual([{ id: file.messageId, visible: true }]);
  expect(
    (
      await f.database
        .selectFrom("messages")
        .select("id")
        .where("id", "in", [blank.messageId, file.messageId])
        .execute()
    ).map(({ id }) => id),
  ).toEqual([file.messageId]);
  expect(await sequence()).toBe(before + 1);
});

it("says on the shell task row whether a Run waits to start with none executing", async () => {
  const f = await fixture();
  const task = await f.task("Queued work");
  const queued = await enqueueThreadInput(f.database, {
    threadId: task.id,
    requestedBy: f.userId,
    source: { kind: "human" },
    policy: "queue",
    content: [{ type: "text", text: "Start when the account is ready" }],
    idempotencyKey: "queued-row",
  });
  const { readPersonalShellSnapshot } = await import("./snapshot-store.js");
  const row = async () => {
    const cut = await readPersonalShellSnapshot(f.database, { viewerId: f.userId });
    if (cut.kind !== "snapshot") throw new Error("Expected a shell snapshot");
    return cut.snapshot.tasks.find(({ id }) => id === task.id);
  };
  expect(await row()).toMatchObject({
    runQueued: true,
    environmentId: task.environmentId,
    harnessInstanceId: task.harnessInstanceId,
  });
  await f.start(queued.run!.id);
  expect((await row())?.runQueued).toBe(false);
  // The change reached viewers as the task row's value, not only in a new snapshot.
  const published = await f.database
    .selectFrom("clientChanges")
    .select("payload")
    .where("scopeKey", "=", "shell")
    .where("entityKind", "=", "task")
    .where("entityId", "=", task.id)
    .orderBy("sequence", "desc")
    .executeTakeFirstOrThrow();
  expect(published.payload).toMatchObject({ runQueued: false });
});

it("republishes the shell row when a starting Run returns to the queue", async () => {
  const f = await fixture();
  const task = await f.task("Requeued work");
  const queued = await enqueueThreadInput(f.database, {
    threadId: task.id,
    requestedBy: f.userId,
    source: { kind: "human" },
    policy: "queue",
    content: [{ type: "text", text: "Start, then wait again" }],
    idempotencyKey: "requeued-row",
  });
  const runId = queued.run!.id;
  const command = await f.database
    .selectFrom("commands")
    .select("id")
    .where("runId", "=", runId)
    .where("type", "=", "run.execute")
    .executeTakeFirstOrThrow();
  await claimCommand(f.database, command.id, "fixture");
  await commitPersonalMutation(f.database, async (tx) => {
    await tx.updateTable("runs").set({ status: "starting" }).where("id", "=", runId).execute();
    await publishRunQueue(tx, task.id, runId);
  });
  const latest = async () =>
    (
      await f.database
        .selectFrom("clientChanges")
        .select("payload")
        .where("scopeKey", "=", "shell")
        .where("entityKind", "=", "task")
        .where("entityId", "=", task.id)
        .orderBy("sequence", "desc")
        .executeTakeFirstOrThrow()
    ).payload;
  expect(await latest()).toMatchObject({ runQueued: false, status: "running" });
  const run = await f.database
    .selectFrom("runs")
    .select(["id", "environmentId", "threadId"])
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  await commitPersonalMutation(f.database, (tx) => returnRunToQueue(tx, { run }));
  // The task status stays running; only the row's queued bit moved, and viewers get it.
  expect(await latest()).toMatchObject({ runQueued: true, status: "running" });
});
