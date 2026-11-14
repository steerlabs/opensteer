import { withTimeout } from "@opensteer/shared/withTimeout";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createId,
  ModelSelectionSchema,
  HarnessIdSchema,
  TeamMessageIdSchema,
  ProviderContinuationIdentitySchema,
  type ContentPart,
  type TeamSource,
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
vi.mock("./resource-access.js", () => ({ assertLineageCompatibleReuse: adapters.unexpected }));
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

import { createThread, enqueueThreadInput } from "./thread-store.js";
import { claimCommand } from "./command-store.js";
import { acquireExecutionBinding, bindProviderSession } from "./execution-store.js";
import { commitRunnerEvent } from "./runner-event-store.js";
import {
  admitTeamTaskRequest,
  cancelTeamTaskRequest,
  hydrateTeamTaskInput,
} from "./task-admission-store.js";
import { openVoiceThread } from "./voice-store.js";
import { createMemoryPass, memoryPassWakeContext } from "./memory-pass-store.js";
import { TriggerStore } from "./trigger-store.js";
import { AgentConnectionStore } from "./agent-connection-store.js";
import { testRunnerDescriptor } from "./store.integration.test-support.js";
import { personalTeamRunOutcome } from "./personal-team-run-store.js";
import { PersonalTeamRequestsStore } from "./personal-team-requests-store.js";
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
  const teamId = createId("deployment");
  const origin = {
    teamId,
    channelId: createId("teamChannel"),
    threadRootId: TeamMessageIdSchema.parse("1"),
  };
  const source: TeamSource = {
    ...origin,
    messageId: null,
    audience: {
      teamName: "Studio",
      channelName: "Design",
      channelKind: "private",
      memberCount: 2,
      peopleOnly: false,
    },
  };
  await database
    .insertInto("personalTeamLinks")
    .values({
      id: crypto.randomUUID(),
      teamDeploymentId: teamId,
      teamHostInstanceId: createId("hostInstance"),
      hostKeyFingerprint: "fixture",
      approvedOrigin: "https://team.example.invalid",
      authorityEnvelope: {},
      remoteLinkId: null,
      remoteOwnerUserId: null,
      state: "active",
      credentialReference: null,
      lastContactAt: null,
    })
    .execute();
  const task = async (title: string) =>
    (
      await createThread(database, {
        ...execution,
        createdBy: personal.userId,
        idempotencyKey: `task:${title}`,
        title,
      })
    ).thread;
  let nextMessage = 1;
  const ask = async () => {
    const requestId = createId("teamAgentRequest");
    return {
      requestId,
      ...(await admitTeamTaskRequest(database, {
        origin,
        requestId,
        triggerMessageId: TeamMessageIdSchema.parse(String(++nextMessage)),
        source,
        ownerId: personal.userId,
        execution,
      })),
    };
  };
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
  return { ...personal, database, execution, origin, source, task, ask, start, finish, emit };
}

it("gives two team asks two Runs, while a private follow-up gets no request authority", async () => {
  const f = await fixture();
  const first = await f.ask();
  const second = await f.ask();
  expect(second.receipt).toMatchObject({ taskId: first.receipt.taskId, runId: null });
  const privateInput = await enqueueThreadInput(f.database, {
    threadId: first.receipt.taskId,
    requestedBy: f.userId,
    source: { kind: "human" },
    policy: "queue",
    content: [{ type: "text", text: "Keep this follow-up private" }],
    idempotencyKey: "private-follow-up",
  });
  const started = await f.start(first.receipt.runId!);
  await f.finish(started.run.id, started.bindingGeneration);
  const next = await f.database
    .selectFrom("runs")
    .selectAll()
    .where("seedInputId", "=", second.receipt.inputId)
    .executeTakeFirstOrThrow();
  expect(next.teamRequestId).toBe(second.requestId);
  const startedSecond = await f.start(next.id);
  await f.finish(next.id, startedSecond.bindingGeneration);
  const privateRun = await f.database
    .selectFrom("runs")
    .selectAll()
    .where("seedInputId", "=", privateInput.message.id)
    .executeTakeFirstOrThrow();
  expect(privateRun.teamRequestId).toBeNull();
  expect(
    (
      await f.database
        .selectFrom("runs")
        .select("teamRequestId")
        .where("threadId", "=", first.receipt.taskId)
        .orderBy("runOrdinal")
        .execute()
    ).map((row) => row.teamRequestId),
  ).toEqual([first.requestId, second.requestId, null]);
});

it("cancels a team input before start and reopens its Done bound task on a later ask", async () => {
  const f = await fixture();
  const first = await f.ask();
  await new PersonalTeamRequestsStore(f.database).terminal(
    f.origin.teamId,
    first.requestId,
    first.receipt.runId,
    "cancelled",
  );
  await cancelTeamTaskRequest(f.database, { teamId: f.origin.teamId, requestId: first.requestId });
  expect(
    await f.database
      .selectFrom("threadInputs")
      .select("state")
      .where("messageId", "=", first.receipt.inputId)
      .executeTakeFirstOrThrow(),
  ).toEqual({ state: "cancelled" });
  expect(
    await f.database
      .selectFrom("runs")
      .select("status")
      .where("id", "=", first.receipt.runId!)
      .executeTakeFirstOrThrow(),
  ).toEqual({ status: "interrupted" });
  await f.database
    .updateTable("threads")
    .set({ doneAt: new Date(), doneReason: null })
    .where("id", "=", first.receipt.taskId)
    .execute();
  const second = await f.ask();
  expect(second.receipt.taskId).toBe(first.receipt.taskId);
  expect(
    (
      await f.database
        .selectFrom("threads")
        .select("doneAt")
        .where("id", "=", second.receipt.taskId)
        .executeTakeFirstOrThrow()
    ).doneAt,
  ).toBeNull();
});

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
    program: {
      language: "typescript",
      toolContractVersion: 3,
      source: "export default async function () {}",
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
      program: {
        language: "typescript",
        toolContractVersion: 3,
        source: "export default async function () {}",
      },
    }),
  ).rejects.toThrow();
});

it("owns independent memory jobs and includes ordinary and team tasks with captured audiences", async () => {
  const f = await fixture();
  const ordinary = await f.task("Ordinary source");
  const team = await f.ask();
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
  const startedTeam = await f.start(team.receipt.runId!);
  await f.finish(startedTeam.run.id, startedTeam.bindingGeneration);
  for (const systemRole of ["memory-light", "memory-nightly"] as const) {
    const created = await createMemoryPass(f.database, {
      ownerId: f.userId,
      execution: f.execution,
      systemRole,
      pauseReason: null,
      program: {
        language: "typescript",
        toolContractVersion: 3,
        source: "export default async function () {}",
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
    const context = await withPersonalTransaction(f.database, (tx) =>
      memoryPassWakeContext(tx, worker),
    );
    expect(context).toContain(ordinary.id);
    expect(context).toContain(team.receipt.taskId);
    expect(context).toContain('"channelKind":"private"');
    expect(context).toContain('"memberCount":2');
    expect(context).not.toContain(worker.id);
  }
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

it("publishes only the consuming Run's completion answer after an offline interval", async () => {
  const f = await fixture();
  const first = await f.ask();
  const receipt = (await new PersonalTeamRequestsStore(f.database).get(
    f.origin.teamId,
    first.requestId,
  ))!;
  expect(await personalTeamRunOutcome(f.database, receipt)).toMatchObject({
    state: "pending",
    finalMessage: null,
  });
  const run = await f.start(first.receipt.runId!);
  await f.emit(run.run.id, run.bindingGeneration, "An unfinished answer");
  expect(await personalTeamRunOutcome(f.database, receipt)).toMatchObject({
    state: "working",
    finalMessage: null,
  });
  await f.emit(run.run.id, run.bindingGeneration, "The authoritative team answer");
  await f.finish(run.run.id, run.bindingGeneration);
  const privateInput = await enqueueThreadInput(f.database, {
    threadId: first.receipt.taskId,
    requestedBy: f.userId,
    source: { kind: "human" },
    policy: "queue",
    content: [{ type: "text", text: "Private follow-up" }],
    idempotencyKey: "outcome-private",
  });
  const privateRun = await f.start(privateInput.run!.id);
  await f.emit(privateRun.run.id, privateRun.bindingGeneration, "A private later answer");
  await f.finish(privateRun.run.id, privateRun.bindingGeneration);
  expect(await personalTeamRunOutcome(f.database, receipt)).toEqual({
    runId: run.run.id,
    state: "done",
    finalMessage: "The authoritative team answer",
  });
});

it("removes only the pending team request and keeps another admitted ask", async () => {
  const f = await fixture();
  const first = await f.ask();
  const second = await f.ask();
  const third = await f.ask();
  const started = await f.start(first.receipt.runId!);
  await cancelTeamTaskRequest(f.database, { teamId: f.origin.teamId, requestId: second.requestId });
  await f.finish(started.run.id, started.bindingGeneration);
  expect(
    await f.database
      .selectFrom("runs")
      .select("id")
      .where("seedInputId", "=", second.receipt.inputId)
      .executeTakeFirst(),
  ).toBeUndefined();
  expect(
    await f.database
      .selectFrom("runs")
      .select("teamRequestId")
      .where("seedInputId", "=", third.receipt.inputId)
      .executeTakeFirstOrThrow(),
  ).toEqual({ teamRequestId: third.requestId });
  expect(
    await personalTeamRunOutcome(
      f.database,
      (await new PersonalTeamRequestsStore(f.database).get(f.origin.teamId, second.requestId))!,
    ),
  ).toMatchObject({ runId: null, state: "cancelled", finalMessage: null });
});

it("stops an active team Run without pausing later queued requests", async () => {
  const f = await fixture();
  const first = await f.ask();
  const second = await f.ask();
  const started = await f.start(first.receipt.runId!);
  await new PersonalTeamRequestsStore(f.database).terminal(
    f.origin.teamId,
    first.requestId,
    first.receipt.runId,
    "cancelled",
  );
  const stopped = await cancelTeamTaskRequest(f.database, {
    teamId: f.origin.teamId,
    requestId: first.requestId,
  });
  expect(stopped.revokedGrants).toHaveLength(1);
  expect(
    await f.database
      .selectFrom("threads")
      .select("inputQueuePaused")
      .where("id", "=", first.receipt.taskId)
      .executeTakeFirstOrThrow(),
  ).toEqual({ inputQueuePaused: false });
  const run = await f.database
    .selectFrom("runs")
    .selectAll()
    .where("id", "=", started.run.id)
    .executeTakeFirstOrThrow();
  await commitRunnerEvent(f.database, threadPathLinks, {
    environmentId: f.environmentId,
    runnerId: f.runnerId,
    runnerBootId: "fixture",
    event: {
      type: "run.interrupted",
      environmentId: f.environmentId,
      emittedAt: new Date().toISOString(),
      ordinal: run.nextRunnerOrdinal,
      bindingGeneration: started.bindingGeneration,
      runId: run.id,
      threadId: run.threadId,
      data: { status: "interrupted" },
    },
  });
  expect(
    await f.database
      .selectFrom("runs")
      .select("teamRequestId")
      .where("seedInputId", "=", second.receipt.inputId)
      .executeTakeFirstOrThrow(),
  ).toEqual({ teamRequestId: second.requestId });
});

it("joins an explicit private steer to the active team Run without assigning a request to that input", async () => {
  const f = await fixture();
  const first = await f.ask();
  await f.start(first.receipt.runId!);
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
      capabilities: jsonValue(descriptor.capabilities),
      moduleDescriptors: {
        agents: {
          ...descriptor.modules.agents,
          harnessDrivers: descriptor.modules.agents.harnessDrivers.map((driver) => ({
            ...driver,
            driverKind: HarnessIdSchema.parse("codex"),
          })),
        },
      },
    })
    .where("id", "=", f.runnerId)
    .execute();
  const steered = await enqueueThreadInput(f.database, {
    threadId: first.receipt.taskId,
    requestedBy: f.userId,
    source: { kind: "human" },
    policy: "steer",
    content: [{ type: "text", text: "Private steering instructions" }],
    idempotencyKey: "private-team-steer",
  });
  expect(steered).toMatchObject({
    disposition: "steering",
    input: { runId: first.receipt.runId, teamRequestId: null, teamSource: null },
  });
  expect(
    await f.database
      .selectFrom("runs")
      .select("teamRequestId")
      .where("id", "=", first.receipt.runId!)
      .executeTakeFirstOrThrow(),
  ).toEqual({ teamRequestId: first.requestId });
});

it("keeps external-agent and Trigger turns on a bound task free of team request authority", async () => {
  const f = await fixture();
  const first = await f.ask();
  const started = await f.start(first.receipt.runId!);
  const connections = new AgentConnectionStore(f.database);
  const connection = await connections.create({
    userId: f.userId,
    label: "External agent",
    clientName: "Fixture",
    accessMode: "full-access",
    resource: "http://127.0.0.1:4310/mcp",
    expiresAt: new Date(Date.now() + 60_000),
  });
  await connections.activate(connection.id, "fixture-external-token-hash");
  const external = await enqueueThreadInput(f.database, {
    threadId: first.receipt.taskId,
    requestedBy: f.userId,
    source: { kind: "connection", connectionId: connection.id },
    policy: "queue",
    content: [{ type: "text", text: "An external agent turn" }],
    idempotencyKey: "external-team-task",
  });
  const triggers = new TriggerStore(f.database);
  const trigger = await triggers.create({
    actorThreadId: null,
    anchorThreadId: first.receipt.taskId,
    createdBy: f.userId,
    idempotencyKey: "team-task-trigger",
    name: "Team task schedule",
    source: {
      kind: "schedule",
      schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() },
    },
    program: {
      language: "javascript",
      toolContractVersion: 3,
      source: "export default async () => null",
    },
  });
  const occurrence = await triggers.enqueueManual({
    actorThreadId: null,
    ownerId: f.userId,
    triggerId: trigger.trigger.id,
  });
  await claimCommand(f.database, occurrence.commandId, "fixture-trigger");
  await triggers.startExecution({
    commandId: occurrence.commandId,
    runnerId: f.runnerId,
    runnerBootId: "fixture",
  });
  const scheduled = await enqueueThreadInput(f.database, {
    threadId: first.receipt.taskId,
    requestedBy: f.userId,
    source: { kind: "trigger", occurrenceId: occurrence.id },
    policy: "queue",
    content: [{ type: "text", text: "A scheduled turn" }],
    idempotencyKey: "trigger-team-task",
  });
  await f.finish(started.run.id, started.bindingGeneration);
  const externalRun = await f.database
    .selectFrom("runs")
    .selectAll()
    .where("seedInputId", "=", external.message.id)
    .executeTakeFirstOrThrow();
  expect(externalRun.teamRequestId).toBeNull();
  const next = await f.start(externalRun.id);
  await f.finish(externalRun.id, next.bindingGeneration);
  expect(
    await f.database
      .selectFrom("runs")
      .select("teamRequestId")
      .where("seedInputId", "=", scheduled.message.id)
      .executeTakeFirstOrThrow(),
  ).toEqual({ teamRequestId: null });
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
  expect(new Set([...first.entries, ...second.entries].map((entry) => entry.request.id)).size).toBe(
    3,
  );
  expect(await f.database.selectFrom("requests").select("originatingThreadId").execute()).toEqual(
    Array.from({ length: 3 }, () => ({ originatingThreadId: child.id })),
  );
  const { deploymentSnapshot } = await import("./snapshot-store.js");
  const { NotificationStateStore } = await import("./notification-state.js");
  const ready = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let resourceCount = 0;
  const snapshot = deploymentSnapshot(f.database, new NotificationStateStore(f.database), {
    viewerId: f.userId,
    omitMessages: true,
    readResources: async ({ database }) => {
      expect(database.isTransaction).toBe(true);
      resourceCount = Number(
        (
          await database
            .selectFrom("requests")
            .select(({ fn }) => fn.countAll<string>().as("count"))
            .executeTakeFirstOrThrow()
        ).count,
      );
      ready.resolve();
      await withTimeout(release.promise, 5_000, {
        timeoutError: () => new Error("Snapshot resource reader never released"),
      });
      return {
        appTabs: [],
        browser: {
          available: false,
          placements: [],
          profiles: [],
          groups: { rows: [], complete: true },
          tabs: [],
        },
      };
    },
  });
  let snapshotError: unknown;
  void snapshot.catch((error) => {
    snapshotError = error;
  });
  let writer: ReturnType<typeof requests.create> | undefined;
  try {
    await withTimeout(ready.promise, 5_000, {
      timeoutError: () => new Error("Snapshot never entered its resource transaction"),
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
      .selectFrom("deploymentEventState")
      .select("sequence")
      .executeTakeFirstOrThrow();
    release.resolve();
    const view = await snapshot;
    // The reader resumes after the snapshot's sequence, so it still hears the later Request.
    expect(BigInt(view.sequence)).toBeLessThan(BigInt(committed.sequence));
    expect(resourceCount).toBe(3);
    expect(view.needsYou.count).toBe(3);
    expect(view.serializedBytes).toBeLessThanOrEqual(900 * 1024);
    expect(view.serializedBytes).toBe(Buffer.byteLength(JSON.stringify(view)));
    expect((await needsYouPage(f.database, { userId: f.userId })).count).toBe(4);
  } finally {
    release.resolve();
    await Promise.allSettled([snapshot, writer]);
  }
});

async function twoTeamsWithOneRequestId() {
  const f = await fixture();
  const first = await f.ask();
  const otherTeamId = createId("deployment");
  const link = await f.database
    .selectFrom("personalTeamLinks")
    .selectAll()
    .where("teamDeploymentId", "=", f.origin.teamId)
    .executeTakeFirstOrThrow();
  await f.database
    .insertInto("personalTeamLinks")
    .values({ ...link, id: crypto.randomUUID(), teamDeploymentId: otherTeamId })
    .execute();
  const origin = { ...f.origin, teamId: otherTeamId };
  const second = await admitTeamTaskRequest(f.database, {
    origin,
    requestId: first.requestId,
    triggerMessageId: TeamMessageIdSchema.parse("2"),
    source: { ...f.source, teamId: otherTeamId },
    ownerId: f.userId,
    execution: f.execution,
  });
  return { f, first, second, otherTeamId };
}

it("cancels only the exact team input when two teams reuse a request ID", async () => {
  const { f, first, second, otherTeamId } = await twoTeamsWithOneRequestId();
  expect(second.receipt.taskId).not.toBe(first.receipt.taskId);
  await cancelTeamTaskRequest(f.database, { teamId: otherTeamId, requestId: first.requestId });
  await expect(
    f.database
      .selectFrom("runs")
      .select("status")
      .where("id", "=", first.receipt.runId!)
      .executeTakeFirstOrThrow(),
  ).resolves.toEqual({ status: "queued" });
  await expect(
    f.database
      .selectFrom("threadInputs")
      .select("state")
      .where("messageId", "=", first.receipt.inputId)
      .executeTakeFirstOrThrow(),
  ).resolves.toEqual({ state: "pending" });
  await expect(
    f.database
      .selectFrom("runs")
      .select("status")
      .where("id", "=", second.receipt.runId!)
      .executeTakeFirstOrThrow(),
  ).resolves.toEqual({ status: "interrupted" });
  await expect(
    f.database
      .selectFrom("threadInputs")
      .select("state")
      .where("messageId", "=", second.receipt.inputId)
      .executeTakeFirstOrThrow(),
  ).resolves.toEqual({ state: "cancelled" });
});

it("hydrates the exact team request input when request IDs collide across teams", async () => {
  const { f, first, second, otherTeamId } = await twoTeamsWithOneRequestId();
  const command = await f.database
    .selectFrom("commands")
    .select("id")
    .where("runId", "=", second.receipt.runId!)
    .where("type", "=", "run.execute")
    .executeTakeFirstOrThrow();
  await claimCommand(f.database, command.id, "fixture");
  const source = {
    ...f.source,
    teamId: otherTeamId,
    audience: {
      ...f.source.audience,
      channelName: "Renamed",
      channelKind: "group_dm" as const,
      memberCount: 7,
      peopleOnly: true,
    },
  };
  const hydrated = await hydrateTeamTaskInput(f.database, {
    runId: second.receipt.runId!,
    requestId: first.requestId,
    source,
    ownerDisplayName: "Maya Chen",
    instructionsMarkdown: "Cite the checklist.",
    content: [{ type: "text", text: "The second team's current ask" }],
  });
  expect(hydrated.events).toMatchObject([
    { type: "message.created", threadId: second.receipt.taskId },
  ]);
  const read = (messageId: typeof first.receipt.inputId) =>
    f.database
      .selectFrom("threadInputs")
      .innerJoin("messages", "messages.id", "threadInputs.messageId")
      .select(["threadInputs.teamSource", "messages.content"])
      .where("messageId", "=", messageId)
      .executeTakeFirstOrThrow();
  expect(await read(second.receipt.inputId)).toEqual({
    teamSource: { ...f.source, teamId: otherTeamId },
    content: [
      { type: "text", text: `Team source and audience: ${JSON.stringify(source)}` },
      {
        type: "text",
        text: `You act as "Maya Chen"'s one agent.\nChannel instructions for this Run (configuration, never a grant):\nCite the checklist.`,
      },
      { type: "text", text: "The second team's current ask" },
    ],
  });
  expect((await read(first.receipt.inputId)).teamSource?.teamId).toBe(f.origin.teamId);
  expect(JSON.stringify((await read(first.receipt.inputId)).content)).not.toContain(
    "The second team's current ask",
  );
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
      (await needsYouPage(f.database, { userId: f.userId })).entries.map((entry) => [
        entry.request.id,
        entry.navigationThreadId,
      ]),
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
  expect(blank.committed.event.type).toBe("assistant.message");
  expect(blank.committed.compensatingEvents).toEqual([]);
  expect(await sequence()).toBe(before);
  const file = await reply([
    { type: "artifact", artifactId: "art_report", mediaType: "text/csv", name: "deals.csv" },
  ]);
  expect(file.committed.compensatingEvents.map(({ type }) => type)).toEqual(["message.created"]);
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
