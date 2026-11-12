import { jsonValue } from "./store-primitives.js";
import { readEmptyPersonalResources } from "./store.integration.test-support.js";
import { personalFixtureOwner } from "./personal-run-fixture.test-support.js";

import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
  recordTestDatabaseSetup,
} from "./test-database.test-support.js";
import { pauseAfterLock } from "./lock-race.test-support.js";
import { createHash, randomUUID } from "node:crypto";
import {
  HarnessIdSchema,
  ModelSelectionSchema,
  ThreadAccessModeSchema,
  createId,
  type EnvironmentId,
  type MessageId,
  type RunnerId,
  type UserId,
} from "@opensteer/core";
import {
  HarnessInstanceCatalogSchema,
  type PendingAgentEvent,
  type RunnerDescriptor,
} from "@opensteer/protocol";
import { sql } from "kysely";
import { describe, expect, it as baseIt } from "vitest";
import { createDatabase, OpensteerStore } from "./index.js";
import { AgentConnectionStore } from "./agent-connection-store.js";
import { AttachmentStore } from "./attachment-store.js";
const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const modelSelection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: {
    effort: "low",
  },
  providerId: "openai",
});
const continuationIdentity = {
  continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
  driverKind: HarnessIdSchema.parse("native"),
} as const;
integration.sequential("thread input queue promotion", () => {
  async function createTestFixture() {
    const clone = await cloneTestDatabase("host");
    const databaseUrl = clone.url;
    const { database } = await ownTestDatabaseProducer(databaseUrl, async () => {
      const database = createDatabase({
        applicationName: "opensteer-thread-input-queue-test",
        connectionString: databaseUrl,
        maxConnections: 4,
      });
      return {
        database,
        close: () => database.destroy(),
      };
    });
    const store = new OpensteerStore(database, {
      readPersonalResources: readEmptyPersonalResources,
    });
    const attachments = new AttachmentStore(database);
    async function fixture(suffix: string) {
      const personal = await personalFixtureOwner(database, databaseUrl);
      const { userId: ownerId, runnerId, environmentId } = personal;
      await enrollRunner({ environmentId, runnerId, suffix, userId: ownerId });
      const harness = await store.createHarnessInstance({
        config: {
          model: "test",
        },
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
      const userId = ownerId;
      const { thread } = await store.createThread({
        createdBy: userId,
        environmentId,
        harnessInstanceId: harness.id,
        idempotencyKey: `thread-${suffix}`,
        modelSelection,
        title: `Thread ${suffix}`,
      });
      const initial = await store.enqueueThreadInput({
        content: [
          {
            text: "Start work",
            type: "text",
          },
        ],
        idempotencyKey: `${suffix}-initial`,
        policy: "queue",
        requestedBy: userId,
        source: {
          kind: "human",
        },
        threadId: thread.id,
      });
      if (!initial.command || !initial.run) throw new Error("Expected initial Run");
      await store.claimCommand(initial.command.id, `${suffix}-dispatcher`);
      const runnerBootId = `boot-${suffix}`;
      const binding = await store.acquireExecutionBinding({
        bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
        continuationIdentity,
        harnessInstanceId: harness.id,
        leaseTokenHash: `${suffix}-lease`,
        runnerBootId,
        runnerId,
        runId: initial.run.id,
        threadId: thread.id,
      });
      await store.commitRunnerEvent({
        environmentId,
        event: pendingEvent({
          bindingGeneration: binding.bindingGeneration,
          data: {
            status: "running",
          },
          environmentId,
          ordinal: 0,
          runId: initial.run.id,
          threadId: thread.id,
          type: "run.started",
        }),
        runnerBootId,
        runnerId,
      });
      return {
        bindingGeneration: binding.bindingGeneration,
        environmentId,
        harness,
        initial,
        ownerId,
        runnerBootId,
        runnerId,
        thread,
        userId,
      };
    }
    async function queued(f: Awaited<ReturnType<typeof fixture>>, suffix: string) {
      return store.enqueueThreadInput({
        content: [
          {
            text: `Queued ${suffix}`,
            type: "text",
          },
        ],
        idempotencyKey: `send-${suffix}`,
        policy: "queue",
        requestedBy: f.userId,
        source: {
          kind: "human",
        },
        threadId: f.thread.id,
      });
    }
    function move(
      f: Awaited<ReturnType<typeof fixture>>,
      messageId: string,
      beforeMessageId: string | null,
      idempotencyKey: string,
    ) {
      return store.moveThreadInput({
        beforeMessageId: beforeMessageId as MessageId | null,
        idempotencyKey,
        messageId: messageId as MessageId,
        requestedBy: f.userId,
        threadId: f.thread.id,
      });
    }
    async function order(f: Awaited<ReturnType<typeof fixture>>) {
      const view = await store.getThreadInputQueue({
        requestedBy: f.userId,
        threadId: f.thread.id,
      });
      return view.items.map(({ message }) => message.id);
    }
    async function complete(f: Awaited<ReturnType<typeof fixture>>, ordinal: number) {
      await store.commitRunnerEvent({
        environmentId: f.environmentId,
        event: pendingEvent({
          bindingGeneration: f.bindingGeneration,
          data: {
            status: "completed",
          },
          environmentId: f.environmentId,
          ordinal,
          runId: f.initial.run!.id,
          threadId: f.thread.id,
          type: "run.completed",
        }),
        runnerBootId: f.runnerBootId,
        runnerId: f.runnerId,
      });
    }
    async function assistantReply(f: Awaited<ReturnType<typeof fixture>>, ordinal: number) {
      const messageId = createId("message");
      await store.commitRunnerEvent({
        environmentId: f.environmentId,
        event: pendingEvent({
          bindingGeneration: f.bindingGeneration,
          data: {
            content: [
              {
                text: "Working on it",
                type: "text",
              },
            ],
            messageId,
          },
          environmentId: f.environmentId,
          ordinal,
          runId: f.initial.run!.id,
          threadId: f.thread.id,
          type: "assistant.message",
        }),
        runnerBootId: f.runnerBootId,
        runnerId: f.runnerId,
      });
      return messageId;
    }
    async function queuedRunSeed(f: Awaited<ReturnType<typeof fixture>>) {
      const run = await database
        .selectFrom("runs")
        .select("seedInputId")
        .where("threadId", "=", f.thread.id)
        .where("status", "=", "queued")
        .executeTakeFirst();
      return run?.seedInputId ?? null;
    }
    async function messageSequences(f: Awaited<ReturnType<typeof fixture>>) {
      return database
        .selectFrom("messages")
        .select(["id", "sequence"])
        .where("threadId", "=", f.thread.id)
        .orderBy("sequence", "asc")
        .execute();
    }
    async function threadEvents(f: Awaited<ReturnType<typeof fixture>>) {
      const page = await store.threadEventPageForOwner({
        ownerId: f.userId,
        threadId: f.thread.id,
      });
      return page?.events ?? [];
    }
    async function enrollRunner(input: {
      environmentId: EnvironmentId;
      runnerId: RunnerId;
      suffix: string;
      userId: UserId;
    }) {
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

            maxConcurrentRuns: 4,
            providerStateModes: ["isolated"],
          },
        },
      };
      await database
        .updateTable("runners")
        .set({
          capabilities: jsonValue(descriptor.capabilities),
          moduleDescriptors: descriptor.modules,
        })
        .where("id", "=", input.runnerId)
        .execute();
    }
    return Object.freeze({
      database,
      store,
      attachments,
      fixture,
      queued,
      move,
      order,
      complete,
      assistantReply,
      queuedRunSeed,
      messageSequences,
      threadEvents,
      enrollRunner,
      databaseUrl,
    });
  }
  type StoreFixture = Awaited<ReturnType<typeof createTestFixture>>;
  const it = baseIt.extend<{
    storeFixture: StoreFixture;
  }>({
    storeFixture: async ({ task }, use) => {
      const started = performance.now();
      const fixture = await createTestFixture();
      recordTestDatabaseSetup(task, started);
      await use(fixture);
    },
  });

  /** A call that has reached its Runner, so it can take input. */
  async function startedCall(
    { fixture, store, database }: StoreFixture,
    name: string,
    capabilities: readonly string[] = ["steer-answer-v1"],
  ) {
    const f = await fixture(name);
    await database
      .updateTable("runners")
      .set({
        capabilities: JSON.stringify(capabilities) as never,
      })
      .where("id", "=", f.runnerId)
      .execute();
    const input = {
      ownerId: f.ownerId,
      environmentId: f.environmentId,
      harnessInstanceId: f.harness.id,
      sessionId: randomUUID(),
    };
    const call = await store.startVoiceCall(input);
    if (call.busy) throw new Error("Expected an idle Voice Thread");
    const command = await database
      .selectFrom("commands")
      .select("id")
      .where("runId", "=", call.runId)
      .where("type", "=", "run.execute")
      .executeTakeFirstOrThrow();
    await store.claimCommand(command.id, `${name}-dispatcher`);
    const { bindingGeneration } = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity,
      harnessInstanceId: f.harness.id,
      leaseTokenHash: `${name}-lease`,
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
      runId: call.runId,
      threadId: call.threadId,
    });
    const emit = (
      ordinal: number,
      event: {
        type: string;
        data: unknown;
      },
    ) =>
      store.commitRunnerEvent({
        environmentId: f.environmentId,
        runnerId: f.runnerId,
        runnerBootId: f.runnerBootId,
        event: pendingEvent({
          bindingGeneration,
          environmentId: f.environmentId,
          ordinal,
          runId: call.runId,
          threadId: call.threadId,
          ...event,
        } as never),
      });
    await emit(0, {
      type: "run.started",
      data: {
        status: "running",
      },
    });
    return {
      call,
      emit,
      f,
      input,
    };
  }
  it("keeps one permanent Voice Thread: a new call waits for the last to end, then reuses it", async ({
    storeFixture,
  }) => {
    const { store, database } = storeFixture;
    const {
      call,

      input,
    } = await startedCall(storeFixture, "voice-permanent");
    expect(await store.startVoiceCall(input)).toMatchObject({
      busy: false,
      runId: call.runId,
      threadId: call.threadId,
    });
    const next = {
      ...input,
      sessionId: randomUUID(),
    };
    expect(await store.startVoiceCall(next)).toMatchObject({
      busy: true,
    });
    expect(
      await database
        .selectFrom("commands")
        .select("type")
        .where("runId", "=", call.runId)
        .where("type", "=", "run.interrupt")
        .execute(),
    ).toHaveLength(1);
    await database
      .updateTable("runs")
      .set({
        status: "interrupted",
      })
      .where("id", "=", call.runId)
      .execute();
    const second = await store.startVoiceCall(next);
    if (second.busy) throw new Error("Expected the Thread to be free");
    expect(second.threadId).toBe(call.threadId);
    expect(second.runId).not.toBe(call.runId);
    expect(
      await database
        .selectFrom("threads")
        .select(["threads.status", "threads.purpose", "threads.listed"])
        .where("threads.id", "=", call.threadId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      listed: false,
      purpose: "voice",
    });
    expect(
      await database
        .selectFrom("personalSettings")
        .select("voiceThreadId")
        .executeTakeFirstOrThrow(),
    ).toEqual({ voiceThreadId: call.threadId });
  });
  it.for([
    {
      name: "voice-terra",
      models: ["gpt-6.1-sol", "gpt-6.1-terra"],
      expected: "gpt-6.1-terra",
    },
    {
      name: "voice-default",
      models: ["gpt-6.1-sol"],
      expected: "gpt-6.1-sol",
    },
  ])(
    "starts the Voice Thread at low effort and Fast on $expected",
    async ({ expected, models, name }, { storeFixture }) => {
      const { fixture, store, database } = storeFixture;
      const speed = {
        defaultValue: "default",
        id: "speed",
        label: "Speed",
        type: "select" as const,
        values: ["default", "priority"].map((value) => ({
          label: value,
          value,
        })),
      };
      const effort = {
        defaultValue: "medium",
        id: "effort",
        label: "Effort",
        type: "select" as const,
        values: ["low", "medium", "high"].map((value) => ({
          label: value,
          value,
        })),
      };
      const f = await fixture(name);
      await store.recordHarnessCatalogs({
        catalogs: [
          HarnessInstanceCatalogSchema.parse({
            continuationIdentity,
            driverKind: "native",
            harnessInstanceId: f.harness.id,
            models: models.map((modelId, index) => ({
              displayName: modelId,
              isDefault: index === 0,
              modelId,
              options: [effort, speed],
              providerId: "openai",
            })),
            status: "ready",
          }),
        ],
        environmentId: f.environmentId,
        expectedRevisions: new Map([[f.harness.id, f.harness.runtimeRevision]]),
      });
      const { threadId } = await store.openVoiceThread({
        ownerId: f.ownerId,
        environmentId: f.environmentId,
        harnessInstanceId: f.harness.id,
      });
      expect(
        await database
          .selectFrom("threads")
          .select("modelSelection")
          .where("id", "=", threadId)
          .executeTakeFirstOrThrow(),
      ).toMatchObject({
        modelSelection: {
          modelId: expected,
          options: {
            effort: "low",
            speed: "priority",
          },
        },
      });
    },
  );
  it("takes its next call on the account the Voice Thread moved to", async ({ storeFixture }) => {
    const { store, database } = storeFixture;
    const { call, f, input } = await startedCall(storeFixture, "voice-move");
    await database
      .updateTable("runs")
      .set({
        status: "interrupted",
      })
      .where("id", "=", call.runId)
      .execute();
    const next = await store.createHarnessInstance({
      config: {
        model: "test",
      },
      driverKind: HarnessIdSchema.parse("native"),
      environmentId: f.environmentId,
      name: "Second account",
      stateKind: "isolated",
    });
    const thread = await store.getThreadForOwner(call.threadId, f.ownerId);
    await store.updateThreadExecutionSelection({
      continuation: {
        expectedProviderSessionId: thread!.providerSessionId,
      },
      continuationIdentity: {
        ...continuationIdentity,
        continuationKey: "runner:v1:XBFO4gDBdSg2fXioCLyTd-RGpc_Zcz838BvyfVUY5d0",
      },
      harnessInstanceId: next.id,
      idempotencyKey: "voice-move",
      modelSelection: thread!.modelSelection,
      requestedBy: f.ownerId,
      threadId: call.threadId,
    });
    expect(await store.openVoiceThread(input)).toMatchObject({
      threadId: call.threadId,
      harnessInstanceId: next.id,
    });
    await expect(
      store.startVoiceCall({
        ...input,
        sessionId: randomUUID(),
      }),
    ).rejects.toMatchObject({
      reason: "voice-account-unavailable",
    });
    expect(
      await store.startVoiceCall({
        ...input,
        harnessInstanceId: next.id,
        sessionId: randomUUID(),
      }),
    ).toMatchObject({
      busy: false,
      threadId: call.threadId,
    });
  });
  it("hands everything sent to the Voice Thread into a live call", async ({ storeFixture }) => {
    const { store, database } = storeFixture;
    const { call, f } = await startedCall(storeFixture, "voice-inbox");
    const sent = await store.enqueueThreadInput({
      threadId: call.threadId,
      requestedBy: f.ownerId,
      source: {
        cause: "assignment-result",
        kind: "platform",
        sourceRunId: call.runId,
      },
      content: [
        {
          type: "text",
          text: "A task finished.",
        },
      ],
      policy: "queue",
      idempotencyKey: "voice-news",
    });
    expect(sent.disposition).toBe("steering");
    expect(
      await database
        .selectFrom("commands")
        .select("type")
        .where("runId", "=", call.runId)
        .where("type", "=", "run.steer")
        .execute(),
    ).toHaveLength(1);
  });
  it("keeps what arrives as a call ends for the next Run, and wakes it", async ({
    storeFixture,
  }) => {
    const { store, database } = storeFixture;
    const { call, emit, f } = await startedCall(storeFixture, "voice-hang-up");
    await store.stopVoiceCall(f.ownerId, call.sessionId!);
    const late = await store.enqueueThreadInput({
      threadId: call.threadId,
      requestedBy: f.ownerId,
      source: {
        cause: "assignment-result",
        kind: "platform",
        sourceRunId: call.runId,
      },
      content: [
        {
          type: "text",
          text: "A task finished.",
        },
      ],
      policy: "queue",
      idempotencyKey: "voice-late",
    });
    await emit(1, {
      type: "run.interrupted",
      data: {
        status: "interrupted",
      },
    });
    const input = await database
      .selectFrom("threadInputs")
      .select("state")
      .where("messageId", "=", late.message.id)
      .executeTakeFirstOrThrow();
    expect(input.state).not.toBe("cancelled");
    expect(
      await database
        .selectFrom("runs")
        .select(["seedInputId", "voiceSessionId"])
        .where("threadId", "=", call.threadId)
        .where("status", "=", "queued")
        .executeTakeFirstOrThrow(),
    ).toEqual({
      seedInputId: late.message.id,
      voiceSessionId: null,
    });
  });
  it("opens Requests from a call, and releases their answers while it runs", async ({
    storeFixture,
  }) => {
    const { store } = storeFixture;
    const { call, f } = await startedCall(storeFixture, "voice-request");
    const { request } = await store.requests.create({
      callId: "voice-durable",
      kind: "browser.access",
      mode: "durable",
      originatingRunId: call.runId,
      originatingThreadId: call.threadId,
      payload: {
        kind: "browser.access",
        reason: "Sign in",
        suggestion: {
          kind: "new",
          suggestedName: "Personal",
        },
      },
      presentation: {
        detail: "Sign in",
        kind: "external",
        subject: {
          id: call.threadId,
          kind: "task",
        },
        title: "Browser profile",
      },
      requestedBy: f.ownerId,
      requiredActor: "requester",
    });
    const { requests } = await store.requests.waitingOnUserPage({
      userId: f.ownerId,
      limit: 10,
    });
    expect(
      requests.find((item) => item.request.id === request.id)?.request.originatingThreadId,
    ).toBe(call.threadId);
  });
  it("delivers an answer on a call while another Request still waits", async ({ storeFixture }) => {
    const { store } = storeFixture;
    const { call, f } = await startedCall(storeFixture, "voice-answers");
    const ask = (callId: string) =>
      store.requests.create({
        callId,
        kind: "browser.access",
        mode: "durable",
        originatingRunId: call.runId,
        originatingThreadId: call.threadId,
        payload: {
          kind: "browser.access",
          reason: "Sign in",
          suggestion: {
            kind: "new",
            suggestedName: "Personal",
          },
        },
        presentation: {
          detail: "Sign in",
          kind: "external",
          subject: {
            id: call.threadId,
            kind: "task",
          },
          title: "Browser profile",
        },
        requestedBy: f.ownerId,
        requiredActor: "requester",
      });
    const answered = await ask("voice-answered");
    await ask("voice-unanswered");
    await store.requests.resolveBrowserRequest({
      requestId: answered.request.id,
      resolvedBy: f.ownerId,
      response: {
        kind: "external",
        value: {
          decision: "declined",
        },
      },
    });
    expect(
      (await store.requests.listPendingContinuations()).map(({ request }) => request.id),
    ).toEqual([answered.request.id]);
  });
  it("delivers what the person said into the Thread as their own words", async ({
    storeFixture,
  }) => {
    const { store, database } = storeFixture;
    const { call, emit, f } = await startedCall(storeFixture, "voice-heard");
    const messageId = createId("message");
    await emit(1, {
      type: "voice.heard",
      data: {
        messageId,
        text: "Open Brex",
      },
    });
    const message = await database
      .selectFrom("messages")
      .select(["author", "content", "kind", "threadId"])
      .where("id", "=", messageId)
      .executeTakeFirstOrThrow();
    expect(message).toMatchObject({
      author: {
        kind: "human",
        userId: f.ownerId,
      },
      content: [
        {
          text: "Open Brex",
          type: "text",
        },
      ],
      kind: "input",
      threadId: call.threadId,
    });
    expect(store).toBeDefined();
  });
  it("lists a task the call started, and fails a lost call without restarting it", async ({
    storeFixture,
  }) => {
    const { store, database } = storeFixture;
    const { call, f, input } = await startedCall(storeFixture, "voice-lost");
    const delegated = await store.delegateThread({
      accessMode: f.thread.accessMode,
      createdBy: f.ownerId,
      environmentId: f.environmentId,
      harnessInstanceId: f.harness.id,
      idempotencyKey: "voice-task",
      modelSelection,
      origin: {
        kind: "run",
        parentRunId: call.runId,
        parentThreadId: call.threadId,
      },
      task: [
        {
          type: "text",
          text: "Compare flights",
        },
      ],
      title: "Compare flights",
    });
    expect(
      await database
        .selectFrom("threads")
        .select("listed")
        .where("id", "=", delegated.thread.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      listed: true,
    });
    await database
      .updateTable("providerSessions")
      .set({
        leaseExpiresAt: new Date(Date.now() - 1_000),
      })
      .where("threadId", "=", call.threadId)
      .execute();
    await store.recoverRunsWithExpiredExecutionBindings();
    const runs = await database
      .selectFrom("runs")
      .select(["id", "status"])
      .where("threadId", "=", call.threadId)
      .execute();
    expect(runs).toEqual([
      {
        id: call.runId,
        status: "failed",
      },
    ]);
    const next = await store.startVoiceCall({
      ...input,
      sessionId: randomUUID(),
    });
    expect(next).toMatchObject({
      busy: false,
      threadId: call.threadId,
    });
  });
  it("claims a ready upload once and replays the exact accepted send after binding", async ({
    storeFixture,
  }) => {
    const { fixture, attachments, store } = storeFixture;
    const f = await fixture("attachment-claim");
    const reserved = await attachments.reserve({
      idempotencyKey: "upload-claim",
      mediaType: "text/plain",
      name: "notes.txt",
      sizeBytes: 5,
      uploaderId: f.userId,
    });
    await attachments.complete({
      attachmentId: reserved.id,
      install: async () => undefined,
      sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      uploaderId: f.userId,
    });
    const content = [
      {
        artifactId: reserved.id,
        mediaType: "text/plain",
        name: "notes.txt",
        sizeBytes: 5,
        type: "artifact" as const,
      },
    ];
    const sent = await store.enqueueThreadInput({
      content,
      idempotencyKey: "send-claim",
      policy: "queue",
      requestedBy: f.userId,
      source: {
        kind: "human",
      },
      threadId: f.thread.id,
    });
    expect((await attachments.get(reserved.id))?.messageId).toBe(sent.message.id);
    expect((await attachments.get(reserved.id))?.threadId).toBe(f.thread.id);
    await expect(
      attachments.discard({
        attachmentId: reserved.id,
        uploaderId: f.userId,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    const replay = await store.enqueueThreadInput({
      content,
      idempotencyKey: "send-claim",
      policy: "queue",
      requestedBy: f.userId,
      source: {
        kind: "human",
      },
      threadId: f.thread.id,
    });
    expect(replay.wasDuplicate).toBe(true);
    expect(replay.message.id).toBe(sent.message.id);
    await expect(
      store.enqueueThreadInput({
        content,
        idempotencyKey: "send-again",
        policy: "queue",
        requestedBy: f.userId,
        source: {
          kind: "human",
        },
        threadId: f.thread.id,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
  });
  it("refuses unready, foreign and forged artifacts before durable admission", async ({
    storeFixture,
  }) => {
    const { fixture, attachments, store } = storeFixture;
    const f = await fixture("attachment-refusal");
    const reserved = await attachments.reserve({
      idempotencyKey: "upload-refusal",
      mediaType: "text/plain",
      name: "notes.txt",
      sizeBytes: 5,
      uploaderId: f.userId,
    });
    const content = [
      {
        artifactId: reserved.id,
        mediaType: "text/plain",
        name: "notes.txt",
        sizeBytes: 5,
        type: "artifact" as const,
      },
    ];
    const send = (
      parts: typeof content,
      source: Parameters<StoreFixture["store"]["enqueueThreadInput"]>[0]["source"],
    ) =>
      store.enqueueThreadInput({
        content: parts,
        idempotencyKey: `refuse-${Math.random()}`,
        policy: "queue",
        requestedBy: f.userId,
        source,
        threadId: f.thread.id,
      });
    await expect(
      send(content, {
        kind: "human",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    await attachments.complete({
      attachmentId: reserved.id,
      install: async () => undefined,
      sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      uploaderId: f.userId,
    });
    await expect(
      send(
        [
          {
            ...content[0]!,
            name: "spoofed.txt",
          },
        ],
        {
          kind: "human",
        },
      ),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      send(content, {
        kind: "agent",
        runId: f.initial.run!.id,
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    expect((await attachments.get(reserved.id))?.messageId).toBeNull();
  });
  it("keeps pending queue attachments out of the active Run inventory", async ({
    storeFixture,
  }) => {
    const { fixture, attachments, store } = storeFixture;
    const f = await fixture("attachment-inventory");
    const reserved = await attachments.reserve({
      idempotencyKey: "upload-inventory",
      mediaType: "text/plain",
      name: "future.txt",
      sizeBytes: 5,
      uploaderId: f.userId,
    });
    await attachments.complete({
      attachmentId: reserved.id,
      install: async () => undefined,
      sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      uploaderId: f.userId,
    });
    const queued = await store.enqueueThreadInput({
      content: [
        {
          artifactId: reserved.id,
          mediaType: "text/plain",
          name: "future.txt",
          sizeBytes: 5,
          type: "artifact",
        },
      ],
      idempotencyKey: "send-inventory",
      policy: "queue",
      requestedBy: f.userId,
      source: {
        kind: "human",
      },
      threadId: f.thread.id,
    });
    expect(queued.input.state).toBe("pending");
    expect(
      await attachments.listForRun({
        after: null,
        limit: 50,
        runId: f.initial.run!.id,
        threadId: f.thread.id,
      }),
    ).toEqual([]);
    await store.steerThreadInput({
      expectedRunId: f.initial.run!.id,
      idempotencyKey: "steer-inventory",
      messageId: queued.message.id,
      requestedBy: f.userId,
      threadId: f.thread.id,
    });
    expect(
      (
        await attachments.listForRun({
          after: null,
          limit: 50,
          runId: f.initial.run!.id,
          threadId: f.thread.id,
        })
      ).map((entry) => entry.id),
    ).toEqual([reserved.id]);
  });
  it("transfers a withdrawn never-admitted attachment to one edited send while preserving old replay", async ({
    storeFixture,
  }) => {
    const { fixture, attachments, store } = storeFixture;
    const f = await fixture("attachment-edit");
    const reserved = await attachments.reserve({
      idempotencyKey: "upload-edit",
      mediaType: "text/plain",
      name: "draft.txt",
      sizeBytes: 5,
      uploaderId: f.userId,
    });
    await attachments.complete({
      attachmentId: reserved.id,
      install: async () => undefined,
      sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      uploaderId: f.userId,
    });
    const content = [
      {
        artifactId: reserved.id,
        mediaType: "text/plain",
        name: "draft.txt",
        sizeBytes: 5,
        type: "artifact" as const,
      },
    ];
    const send = (idempotencyKey: string) =>
      store.enqueueThreadInput({
        content,
        idempotencyKey,
        policy: "queue",
        requestedBy: f.userId,
        source: {
          kind: "human",
        },
        threadId: f.thread.id,
      });
    const original = await send("original-edit-send");
    await store.cancelThreadInput({
      idempotencyKey: "withdraw-edit",
      messageId: original.message.id,
      requestedBy: f.userId,
      threadId: f.thread.id,
    });
    const contenders = await Promise.allSettled([send("edited-send-one"), send("edited-send-two")]);
    expect(contenders.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const accepted = contenders.find((result) => result.status === "fulfilled");
    if (!accepted || accepted.status !== "fulfilled") throw new Error("Expected one edited send");
    expect((await attachments.get(reserved.id))?.messageId).toBe(accepted.value.message.id);
    expect((await send("original-edit-send")).message.id).toBe(original.message.id);
    expect((await attachments.get(reserved.id))?.messageId).toBe(accepted.value.message.id);
    expect(
      await attachments.listForRun({
        after: null,
        limit: 50,
        runId: f.initial.run!.id,
        threadId: f.thread.id,
      }),
    ).toEqual([]);
  });
  it("can edit the same file after a promoted steer is proven refused and withdrawn", async ({
    storeFixture,
  }) => {
    const { fixture, attachments, store } = storeFixture;
    const f = await fixture("attachment-refused-edit");
    const reserved = await attachments.reserve({
      idempotencyKey: "upload-refused-edit",
      mediaType: "text/plain",
      name: "draft.txt",
      sizeBytes: 5,
      uploaderId: f.userId,
    });
    await attachments.complete({
      attachmentId: reserved.id,
      install: async () => undefined,
      sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      uploaderId: f.userId,
    });
    const content = [
      {
        artifactId: reserved.id,
        mediaType: "text/plain",
        name: "draft.txt",
        sizeBytes: 5,
        type: "artifact" as const,
      },
    ];
    const send = (idempotencyKey: string) =>
      store.enqueueThreadInput({
        content,
        idempotencyKey,
        policy: "queue",
        requestedBy: f.userId,
        source: {
          kind: "human",
        },
        threadId: f.thread.id,
      });
    const original = await send("original-refused-edit");
    const promotion = await store.steerThreadInput({
      expectedRunId: f.initial.run!.id,
      idempotencyKey: "promote-refused-edit",
      messageId: original.message.id,
      requestedBy: f.userId,
      threadId: f.thread.id,
    });
    if (!promotion.command) throw new Error("Expected a steer command");
    await store.refuseSteer(promotion.command.id, "Provider refused the steer");
    await store.cancelThreadInput({
      idempotencyKey: "withdraw-refused-edit",
      messageId: original.message.id,
      requestedBy: f.userId,
      threadId: f.thread.id,
    });
    const edited = await send("edited-refused-send");
    expect((await attachments.get(reserved.id))?.messageId).toBe(edited.message.id);
    expect((await send("original-refused-edit")).message.id).toBe(original.message.id);
  });
  it("keeps accepted input durable without creating a future Run and promotes the same message idempotently", async ({
    storeFixture,
  }) => {
    const { fixture, queued, database, store } = storeFixture;
    const f = await fixture("promote");
    const accepted = await queued(f, "promote");
    expect(accepted).toMatchObject({
      command: null,
      disposition: "pending",
      input: {
        state: "pending",
      },
      run: null,
    });
    expect(
      await database
        .selectFrom("runs")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("threadId", "=", f.thread.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      count: "1",
    });
    const view = await store.getThreadInputQueue({
      requestedBy: f.userId,
      threadId: f.thread.id,
    });
    expect(view).toMatchObject({
      steerRunId: f.initial.run!.id,
      items: [
        {
          canCancel: true,
          canSteer: true,
          message: {
            id: accepted.message.id,
          },
        },
      ],
    });
    const promoted = await store.steerThreadInput({
      expectedRunId: f.initial.run!.id,
      idempotencyKey: "steer-promote",
      messageId: accepted.message.id,
      requestedBy: f.userId,
      threadId: f.thread.id,
    });
    expect(promoted).toMatchObject({
      disposition: "steering",
      message: {
        id: accepted.message.id,
      },
      wasDuplicate: false,
    });
    await expect(
      store.steerThreadInput({
        expectedRunId: f.initial.run!.id,
        idempotencyKey: "steer-promote",
        messageId: accepted.message.id,
        requestedBy: f.userId,
        threadId: f.thread.id,
      }),
    ).resolves.toMatchObject({
      message: {
        id: accepted.message.id,
      },
      wasDuplicate: true,
    });
    await expect(queued(f, "promote")).resolves.toMatchObject({
      message: {
        id: accepted.message.id,
      },
      wasDuplicate: true,
    });
    expect(accepted.input.causalChainId).not.toBe(f.initial.input.causalChainId);
    if (!promoted.command) throw new Error("Expected steer command");
    const claimed = await store.claimCommand(promoted.command.id, "steer-ack-dispatcher");
    expect(claimed).toBeDefined();
    expect(claimed?.terminalFailure).toBeUndefined();
    await store.succeedCommand(promoted.command.id);
    await expect(
      database
        .selectFrom("threadInputs")
        .select(["deliveredAt", "state"])
        .where("messageId", "=", accepted.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      deliveredAt: expect.any(Date),
      state: "delivered",
    });
    await expect(
      store.getThreadInputQueue({
        requestedBy: f.userId,
        threadId: f.thread.id,
      }),
    ).resolves.toMatchObject({
      items: [],
    });
  });
  it("refuses stale, unsupported, and paused promotion without consuming queued input", async ({
    storeFixture,
  }) => {
    const { fixture, queued, store, database } = storeFixture;
    const f = await fixture("refuse");
    const accepted = await queued(f, "refuse");
    const request = {
      expectedRunId: createId("run"),
      idempotencyKey: "steer-refuse",
      messageId: accepted.message.id,
      requestedBy: f.userId,
      threadId: f.thread.id,
    };
    await expect(store.steerThreadInput(request)).rejects.toMatchObject({
      code: "conflict",
    });
    // A Runner whose engine cannot steer, and that cannot restart an attempt.
    await database
      .updateTable("runners")
      .set({
        moduleDescriptors: sql`jsonb_set(module_descriptors, '{agents,harnessDrivers,0,steering}', 'false')`,
      })
      .where("id", "=", f.runnerId)
      .execute();
    await expect(
      store.steerThreadInput({
        ...request,
        expectedRunId: f.initial.run!.id,
        idempotencyKey: "steer-unsupported",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    await database
      .updateTable("threads")
      .set({
        inputQueuePaused: true,
        inputQueuePausedBy: f.userId,
      })
      .where("id", "=", f.thread.id)
      .execute();
    await expect(
      store.steerThreadInput({
        ...request,
        expectedRunId: f.initial.run!.id,
        idempotencyKey: "steer-paused",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      database
        .selectFrom("threadInputs")
        .select(["state", "steerCommandId"])
        .where("messageId", "=", accepted.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      state: "pending",
      steerCommandId: null,
    });
  });
  it("restores a definitively refused steer but never redelivers an unknown steer", async ({
    storeFixture,
  }) => {
    const { fixture, queued, store, database } = storeFixture;
    const f = await fixture("settle");
    const refusedInput = await queued(f, "refused");
    const refused = await store.steerThreadInput({
      expectedRunId: f.initial.run!.id,
      idempotencyKey: "steer-refused",
      messageId: refusedInput.message.id,
      requestedBy: f.userId,
      threadId: f.thread.id,
    });
    if (!refused.command) throw new Error("Expected steer command");
    await store.refuseSteer(refused.command.id, "Driver refused");
    await expect(
      database
        .selectFrom("threadInputs")
        .select(["runId", "state", "steerCommandId"])
        .where("messageId", "=", refusedInput.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      runId: null,
      state: "pending",
      steerCommandId: null,
    });
    const unknownInput = await queued(f, "unknown");
    const unknown = await store.steerThreadInput({
      expectedRunId: f.initial.run!.id,
      idempotencyKey: "steer-unknown",
      messageId: unknownInput.message.id,
      requestedBy: f.userId,
      threadId: f.thread.id,
    });
    if (!unknown.command) throw new Error("Expected steer command");
    await store.markSteerUnknown(unknown.command.id, "Lost acknowledgement");
    await store.commitRunnerEvent({
      environmentId: f.environmentId,
      event: pendingEvent({
        bindingGeneration: f.bindingGeneration,
        data: {
          status: "completed",
        },
        environmentId: f.environmentId,
        ordinal: 1,
        runId: f.initial.run!.id,
        threadId: f.thread.id,
        type: "run.completed",
      }),
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
    });
    await expect(
      database
        .selectFrom("threadInputs")
        .select(["runId", "state", "steerCommandId"])
        .where("messageId", "=", unknownInput.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      runId: f.initial.run!.id,
      state: "unknown",
      steerCommandId: unknown.command.id,
    });
    // The Run may already have heard it, so it is no longer the queue's to offer.
    const queue = await store.getThreadInputQueue({
      requestedBy: f.userId,
      threadId: f.thread.id,
    });
    expect(queue.items.map(({ message }) => message.id)).not.toContain(unknownInput.message.id);
  });
  it("revalidates the personal owner when claiming a promoted steer without ending its active Run", async ({
    storeFixture,
  }) => {
    const { fixture, queued, store, database } = storeFixture;
    const f = await fixture("claim-revoked");
    const accepted = await queued(f, "claim-revoked");
    const promoted = await store.steerThreadInput({
      expectedRunId: f.initial.run!.id,
      idempotencyKey: "steer-claim-revoked",
      messageId: accepted.message.id,
      requestedBy: f.userId,
      threadId: f.thread.id,
    });
    if (!promoted.command) throw new Error("Expected steer command");
    await database
      .updateTable("users")
      .set({ disabledAt: new Date() })
      .where("id", "=", f.userId)
      .execute();
    const claim = await store.claimCommand(promoted.command.id, "revoked-steer-dispatcher");
    expect(claim?.terminalFailure).toBe(
      "The Run can no longer accept this message under its original execution authority.",
    );
    await expect(
      database
        .selectFrom("runs")
        .select("status")
        .where("id", "=", f.initial.run!.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      status: "running",
    });
    await expect(
      database
        .selectFrom("threadInputs")
        .select("state")
        .where("messageId", "=", accepted.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      state: "claimed",
    });
  });
  it("serializes promotion against completion without duplicating or losing the queued message", async ({
    storeFixture,
  }) => {
    const { fixture, queued, store, database } = storeFixture;
    const f = await fixture("completion-race");
    const accepted = await queued(f, "completion-race");
    const [promotion, completion] = await Promise.allSettled([
      store.steerThreadInput({
        expectedRunId: f.initial.run!.id,
        idempotencyKey: "steer-completion-race",
        messageId: accepted.message.id,
        requestedBy: f.userId,
        threadId: f.thread.id,
      }),
      store.commitRunnerEvent({
        environmentId: f.environmentId,
        event: pendingEvent({
          bindingGeneration: f.bindingGeneration,
          data: {
            status: "completed",
          },
          environmentId: f.environmentId,
          ordinal: 1,
          runId: f.initial.run!.id,
          threadId: f.thread.id,
          type: "run.completed",
        }),
        runnerBootId: f.runnerBootId,
        runnerId: f.runnerId,
      }),
    ]);
    expect(completion.status).toBe("fulfilled");
    if (promotion.status === "rejected")
      expect(promotion.reason).toMatchObject({
        code: "conflict",
      });
    await expect(
      database
        .selectFrom("threadInputs")
        .select(["state", "runId", "steerCommandId"])
        .where("messageId", "=", accepted.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      state: "pending",
      runId: null,
      steerCommandId: null,
    });
    await expect(
      database
        .selectFrom("runs")
        .select(["seedInputId", "status"])
        .where("threadId", "=", f.thread.id)
        .where("status", "=", "queued")
        .execute(),
    ).resolves.toEqual([
      {
        seedInputId: accepted.message.id,
        status: "queued",
      },
    ]);
    await expect(queued(f, "completion-race")).resolves.toMatchObject({
      message: {
        id: accepted.message.id,
      },
      wasDuplicate: true,
    });
  });
  it("withdraws one's own queued message behind an active Run and keeps the Message", async ({
    storeFixture,
  }) => {
    const { fixture, queued, store, database } = storeFixture;
    const f = await fixture("withdraw");
    const accepted = await queued(f, "withdraw");
    const request = {
      idempotencyKey: "cancel-withdraw",
      messageId: accepted.message.id,
      requestedBy: f.userId,
      threadId: f.thread.id,
    };
    const cancelled = await store.cancelThreadInput(request);
    expect(cancelled).toMatchObject({
      events: [
        {
          data: {
            input: {
              cancelReason: "withdrawn",
              state: "cancelled",
            },
          },
          runId: null,
          threadId: f.thread.id,
          type: "thread-input.updated",
        },
      ],
      input: {
        cancelReason: "withdrawn",
        messageId: accepted.message.id,
        state: "cancelled",
      },
      wasDuplicate: false,
    });
    await expect(
      database
        .selectFrom("messages")
        .select("id")
        .where("id", "=", accepted.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      id: accepted.message.id,
    });
    await expect(
      store.getThreadInputQueue({
        requestedBy: f.userId,
        threadId: f.thread.id,
      }),
    ).resolves.toMatchObject({
      items: [],
    });
    await expect(store.cancelThreadInput(request)).resolves.toMatchObject({
      events: [],
      input: {
        cancelReason: "withdrawn",
        state: "cancelled",
      },
      wasDuplicate: true,
    });
    await expect(
      store.cancelThreadInput({
        ...request,
        idempotencyKey: "cancel-withdraw-again",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      database
        .selectFrom("runs")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("threadId", "=", f.thread.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      count: "1",
    });
  });
  it("neither lists nor withdraws a message once a queued Run seeds it", async ({
    storeFixture,
  }) => {
    const { fixture, queued, store, database } = storeFixture;
    const f = await fixture("seeded");
    const accepted = await queued(f, "seeded");
    await store.commitRunnerEvent({
      environmentId: f.environmentId,
      event: pendingEvent({
        bindingGeneration: f.bindingGeneration,
        data: {
          status: "completed",
        },
        environmentId: f.environmentId,
        ordinal: 1,
        runId: f.initial.run!.id,
        threadId: f.thread.id,
        type: "run.completed",
      }),
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
    });
    await expect(
      database
        .selectFrom("runs")
        .select(["seedInputId", "status"])
        .where("threadId", "=", f.thread.id)
        .where("status", "=", "queued")
        .execute(),
    ).resolves.toEqual([
      {
        seedInputId: accepted.message.id,
        status: "queued",
      },
    ]);
    await expect(
      store.getThreadInputQueue({
        requestedBy: f.userId,
        threadId: f.thread.id,
      }),
    ).resolves.toMatchObject({
      items: [],
      steerRunId: null,
    });
    await expect(
      store.cancelThreadInput({
        idempotencyKey: "cancel-seeded",
        messageId: accepted.message.id,
        requestedBy: f.userId,
        threadId: f.thread.id,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      database
        .selectFrom("threadInputs")
        .select(["cancelReason", "state"])
        .where("messageId", "=", accepted.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      cancelReason: null,
      state: "pending",
    });
  });
  it("withdraws a queued message left waiting on a paused, idle Thread", async ({
    storeFixture,
  }) => {
    const { fixture, queued, database, store } = storeFixture;
    const f = await fixture("paused");
    const accepted = await queued(f, "paused");
    await database
      .updateTable("threads")
      .set({
        inputQueuePaused: true,
        inputQueuePausedBy: f.userId,
      })
      .where("id", "=", f.thread.id)
      .execute();
    await store.commitRunnerEvent({
      environmentId: f.environmentId,
      event: pendingEvent({
        bindingGeneration: f.bindingGeneration,
        data: {
          status: "completed",
        },
        environmentId: f.environmentId,
        ordinal: 1,
        runId: f.initial.run!.id,
        threadId: f.thread.id,
        type: "run.completed",
      }),
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
    });
    await expect(
      database
        .selectFrom("runs")
        .select("id")
        .where("threadId", "=", f.thread.id)
        .where("status", "in", ["queued", "running"])
        .execute(),
    ).resolves.toEqual([]);
    await expect(
      store.getThreadInputQueue({
        requestedBy: f.userId,
        threadId: f.thread.id,
      }),
    ).resolves.toMatchObject({
      items: [
        {
          canCancel: true,
          canSteer: false,
          message: {
            id: accepted.message.id,
          },
        },
      ],
      paused: true,
      steerRunId: null,
    });
    await expect(
      store.cancelThreadInput({
        idempotencyKey: "cancel-paused",
        messageId: accepted.message.id,
        requestedBy: f.userId,
        threadId: f.thread.id,
      }),
    ).resolves.toMatchObject({
      input: {
        cancelReason: "withdrawn",
        state: "cancelled",
      },
      wasDuplicate: false,
    });
    await expect(
      store.getThreadInputQueue({
        requestedBy: f.userId,
        threadId: f.thread.id,
      }),
    ).resolves.toMatchObject({
      items: [],
    });
  });
  it("refuses a nonowner's withdrawal of a personal queued message", async ({ storeFixture }) => {
    const { fixture, queued, store, database } = storeFixture;
    const f = await fixture("withdraw-other");
    const sent = await queued(f, "withdraw-other");
    await expect(
      store.cancelThreadInput({
        idempotencyKey: "unauthorized-withdrawal",
        messageId: sent.message.id,
        requestedBy: await store.createUser("Outsider"),
        threadId: f.thread.id,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(
      await database
        .selectFrom("threadInputs")
        .select("state")
        .where("messageId", "=", sent.message.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "pending" });
  });

  it("refuses to withdraw a message a promotion has already claimed", async ({ storeFixture }) => {
    const { fixture, queued, store, database } = storeFixture;
    const f = await fixture("withdraw-claimed");
    const accepted = await queued(f, "withdraw-claimed");
    const promoted = await store.steerThreadInput({
      expectedRunId: f.initial.run!.id,
      idempotencyKey: "steer-withdraw-claimed",
      messageId: accepted.message.id,
      requestedBy: f.userId,
      threadId: f.thread.id,
    });
    if (!promoted.command) throw new Error("Expected steer command");
    await expect(
      store.cancelThreadInput({
        idempotencyKey: "cancel-withdraw-claimed",
        messageId: accepted.message.id,
        requestedBy: f.userId,
        threadId: f.thread.id,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "This message is no longer waiting in the queue",
    });
    await expect(
      database
        .selectFrom("threadInputs")
        .select(["cancelReason", "runId", "state", "steerCommandId"])
        .where("messageId", "=", accepted.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      cancelReason: null,
      runId: f.initial.run!.id,
      state: "claimed",
      steerCommandId: promoted.command.id,
    });
  });
  it("refuses to withdraw from an archived Thread", async ({ storeFixture }) => {
    const { fixture, queued, database, store } = storeFixture;
    const f = await fixture("withdraw-archived");
    const accepted = await queued(f, "withdraw-archived");
    await database
      .updateTable("threads")
      .set({
        status: "archived",
        updatedAt: new Date(),
      })
      .where("id", "=", f.thread.id)
      .execute();
    await expect(
      store.getThreadInputQueue({
        requestedBy: f.userId,
        threadId: f.thread.id,
      }),
    ).resolves.toMatchObject({
      items: [
        {
          canCancel: false,
          canSteer: false,
          message: {
            id: accepted.message.id,
          },
        },
      ],
      steerRunId: null,
    });
    await expect(
      store.cancelThreadInput({
        idempotencyKey: "cancel-withdraw-archived",
        messageId: accepted.message.id,
        requestedBy: f.userId,
        threadId: f.thread.id,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "Archived threads cannot run",
    });
    await expect(
      database
        .selectFrom("threadInputs")
        .select(["cancelReason", "state", "steerCommandId"])
        .where("messageId", "=", accepted.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      cancelReason: null,
      state: "pending",
      steerCommandId: null,
    });
  });
  it("omits a withdrawn message from the Workspace snapshot but keeps it in the ledger", async ({
    storeFixture,
  }) => {
    const { fixture, queued, store } = storeFixture;
    const f = await fixture("snapshot");
    const withdrawn = await queued(f, "snapshot-withdrawn");
    const kept = await queued(f, "snapshot-kept");
    await store.cancelThreadInput({
      idempotencyKey: "cancel-snapshot",
      messageId: withdrawn.message.id,
      requestedBy: f.userId,
      threadId: f.thread.id,
    });
    const snapshot = await store.deploymentSnapshot();
    expect(snapshot.messages.map(({ id }) => id)).toEqual([f.initial.message.id, kept.message.id]);
    expect(snapshot.messageWindows).toMatchObject([
      {
        hasMore: false,
        itemCount: 2,
        nextBefore: null,
        threadId: f.thread.id,
        totalItems: 2,
      },
    ]);
    const ledger = await store.threadEventPageForOwner({
      ownerId: f.userId,
      threadId: f.thread.id,
    });
    expect(ledger?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            message: expect.objectContaining({
              id: withdrawn.message.id,
            }),
          }),
          type: "message.created",
        }),
        expect.objectContaining({
          data: {
            input: expect.objectContaining({
              cancelReason: "withdrawn",
              messageId: withdrawn.message.id,
              state: "cancelled",
            }),
          },
          type: "thread-input.updated",
        }),
      ]),
    );
  });

  /*
   * Queue order and conversation placement. What can go wrong:
   * - a person rearranges the queue but the Host still admits the old order;
   * - a message sent after a move jumps ahead of the rearranged ones;
   * - a move reaches a message a Run already owns (seeded or steered), or is
   *   placed before a neighbour that has left the queue, and silently
   *   reorders around something that is no longer waiting;
   * - someone moves another member's message or an Opensteer follow-up;
   * - a retried move replays over a newer arrangement;
   * - a paused queue forgets the order it was given before Resume;
   * - an archived Thread is still rearranged;
   * - a queued message joins the conversation where it was sent, inside the
   *   turn that was running, instead of where a Run takes it, so the next
   *   turn's history misses what came before it.
   */

  it("admits queued messages in the order the person arranges them", async ({ storeFixture }) => {
    const { fixture, queued, order, move, complete, queuedRunSeed } = storeFixture;
    const f = await fixture("arrange");
    const a = await queued(f, "arrange-a");
    const b = await queued(f, "arrange-b");
    const c = await queued(f, "arrange-c");
    await expect(order(f)).resolves.toEqual([a.message.id, b.message.id, c.message.id]);
    const moved = await move(f, c.message.id, a.message.id, "move-arrange-1");
    expect(moved).toMatchObject({
      events: [
        {
          data: {
            paused: false,
          },
          type: "thread.input-queue-updated",
        },
      ],
      wasDuplicate: false,
    });
    await expect(order(f)).resolves.toEqual([c.message.id, a.message.id, b.message.id]);
    await move(f, a.message.id, null, "move-arrange-2");
    await expect(order(f)).resolves.toEqual([c.message.id, b.message.id, a.message.id]);
    // Moving a message before itself, or to where it already is, changes nothing.
    await move(f, b.message.id, a.message.id, "move-arrange-3");
    await move(f, b.message.id, b.message.id, "move-arrange-4");
    await expect(order(f)).resolves.toEqual([c.message.id, b.message.id, a.message.id]);
    const d = await queued(f, "arrange-d");
    await expect(order(f)).resolves.toEqual([
      c.message.id,
      b.message.id,
      a.message.id,
      d.message.id,
    ]);
    await complete(f, 1);
    await expect(queuedRunSeed(f)).resolves.toBe(c.message.id);
    await expect(order(f)).resolves.toEqual([b.message.id, a.message.id, d.message.id]);
  });
  it("reserves continuation budgets before settling returned steer messages", async ({
    storeFixture,
  }) => {
    const { fixture, queued, store, database, complete, queuedRunSeed } = storeFixture;
    const f = await fixture("budget-message-order");
    const a = await queued(f, "budget-a");
    const b = await queued(f, "budget-b");
    await store.steerThreadInput({
      expectedRunId: f.initial.run!.id,
      idempotencyKey: "budget-steer",
      messageId: b.message.id,
      requestedBy: f.userId,
      threadId: f.thread.id,
    });
    const pending = await database
      .selectFrom("threadInputs")
      .select("causalChainId")
      .where("messageId", "=", a.message.id)
      .executeTakeFirstOrThrow();
    const barrier = pauseAfterLock(database, (node) => /"name":"causal_?chains"/iu.test(node));
    const peer = barrier.database.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom("causalChains")
        .select("id")
        .where("id", "=", pending.causalChainId!)
        .forNoKeyUpdate()
        .execute();
      await transaction
        .selectFrom("messages")
        .select("id")
        .where("id", "=", b.message.id)
        .forNoKeyUpdate()
        .execute();
    });
    void peer.catch(() => undefined);
    let completion: Promise<void> | undefined;
    try {
      await barrier.reached;
      completion = complete(f, 1);
      void completion.catch(() => undefined);
      await expect
        .poll(async () =>
          (
            await sql<{
              query: string;
            }>`select query from pg_stat_activity
        where datname=current_database() and application_name='opensteer-thread-input-queue-test' and wait_event_type='Lock'
      `.execute(database)
          ).rows.some(({ query }) => query.includes('"causal_chains"')),
        )
        .toBe(true);
      barrier.release();
      const results = await Promise.allSettled([peer, completion]);
      expect(barrier.conflicts).toEqual([]);
      expect(results.filter(({ status }) => status === "rejected")).toEqual([]);
      await expect(queuedRunSeed(f)).resolves.toBe(a.message.id);
    } finally {
      barrier.release();
      await Promise.allSettled([peer, completion]);
    }
  });
  it("refuses to move a message a Run already owns or to place one beside it", async ({
    storeFixture,
  }) => {
    const { fixture, queued, store, move, complete, queuedRunSeed, order } = storeFixture;
    const f = await fixture("owned");
    const a = await queued(f, "owned-a");
    const b = await queued(f, "owned-b");
    const c = await queued(f, "owned-c");
    await store.steerThreadInput({
      expectedRunId: f.initial.run!.id,
      idempotencyKey: "steer-owned",
      messageId: b.message.id,
      requestedBy: f.userId,
      threadId: f.thread.id,
    });
    const gone = {
      code: "conflict",
      message: "This message is no longer waiting in the queue",
    };
    await expect(move(f, b.message.id, a.message.id, "move-steered")).rejects.toMatchObject(gone);
    await expect(move(f, a.message.id, b.message.id, "move-before-steered")).rejects.toMatchObject(
      gone,
    );
    await store.cancelThreadInput({
      idempotencyKey: "cancel-owned",
      messageId: c.message.id,
      requestedBy: f.userId,
      threadId: f.thread.id,
    });
    await expect(
      move(f, a.message.id, c.message.id, "move-before-withdrawn"),
    ).rejects.toMatchObject(gone);
    const d = await queued(f, "owned-d");
    await complete(f, 1);
    await expect(queuedRunSeed(f)).resolves.toBe(a.message.id);
    await expect(move(f, a.message.id, null, "move-seeded")).rejects.toMatchObject(gone);
    await expect(move(f, d.message.id, a.message.id, "move-before-seeded")).rejects.toMatchObject(
      gone,
    );
    await expect(
      move(f, d.message.id, createId("message"), "move-before-unknown"),
    ).rejects.toMatchObject(gone);
    // The steer was never dispatched, so the ended Run handed it back to the queue.
    await expect(order(f)).resolves.toEqual([b.message.id, d.message.id]);
  });
  for (const revoked of [false, true]) {
    it(`lets the person manage their connection's queue, revoked=${revoked}`, async ({
      storeFixture,
    }) => {
      const { fixture, queued, database, store } = storeFixture;
      const f = await fixture(`connection-person-${revoked}`);
      const connections = new AgentConnectionStore(database);
      const createConnection = async () => {
        const connection = await connections.create({
          userId: f.userId,
          label: "Agent",
          clientName: "Agent",
          accessMode: "full-access",

          resource: "https://test-host.invalid/internal/v1/mcp",
          expiresAt: new Date(Date.now() + 60_000),
        });
        await connections.activate(
          connection.id,
          createHash("sha256").update(connection.id).digest("hex"),
        );
        return {
          kind: "connection",
          connectionId: connection.id,
          userId: f.userId,
          accessMode: "full-access",
        } as const;
      };
      const author = await createConnection();
      const other = await createConnection();
      const anchor = await queued(f, "connection-anchor");
      const send = (key: string) =>
        store.enqueueThreadInput({
          authority: author,
          content: [
            {
              type: "text",
              text: key,
            },
          ],
          idempotencyKey: key,
          policy: "queue",
          requestedBy: f.userId,
          source: {
            kind: "connection",
            connectionId: author.connectionId,
          },
          threadId: f.thread.id,
        });
      const cancel = await send("connection-cancel");
      const move = await send("connection-move");
      const steer = await send("connection-steer");
      if (revoked) await connections.revoke(f.userId, author.connectionId);
      const person = {
        requestedBy: f.userId,
        threadId: f.thread.id,
      };
      const view = await store.getThreadInputQueue(person);
      expect(view.items.filter(({ message }) => message.id !== anchor.message.id)).toEqual(
        expect.arrayContaining(
          [cancel, move, steer].map(({ message }) =>
            expect.objectContaining({
              message: expect.objectContaining({
                id: message.id,
              }),
              canCancel: true,
              canMove: true,
              canSteer: true,
            }),
          ),
        ),
      );
      for (const caller of [
        {
          ...person,
          authority: other,
        },
      ]) {
        const restricted = await store.getThreadInputQueue(caller);
        expect(
          restricted.items.find(({ message }) => message.id === cancel.message.id),
        ).toMatchObject({
          canCancel: false,
          canMove: false,
          canSteer: false,
        });
        await expect(
          store.cancelThreadInput({
            ...caller,
            messageId: cancel.message.id,
            idempotencyKey: `cancel-denied-${caller.requestedBy}-${"authority" in caller}`,
          }),
        ).rejects.toMatchObject({
          code: "forbidden",
        });
        await expect(
          store.moveThreadInput({
            ...caller,
            messageId: move.message.id,
            beforeMessageId: anchor.message.id,
            idempotencyKey: `move-denied-${caller.requestedBy}-${"authority" in caller}`,
          }),
        ).rejects.toMatchObject({
          code: "forbidden",
        });
        await expect(
          store.steerThreadInput({
            ...caller,
            messageId: steer.message.id,
            expectedRunId: f.initial.run!.id,
            idempotencyKey: `steer-denied-${caller.requestedBy}-${"authority" in caller}`,
          }),
        ).rejects.toMatchObject({
          code: "forbidden",
        });
      }
      await store.moveThreadInput({
        ...person,
        messageId: move.message.id,
        beforeMessageId: anchor.message.id,
        idempotencyKey: "person-move",
      });
      expect((await store.getThreadInputQueue(person)).items[0]?.message.id).toBe(move.message.id);
      await store.cancelThreadInput({
        ...person,
        messageId: cancel.message.id,
        idempotencyKey: "person-cancel",
      });
      await store.steerThreadInput({
        ...person,
        messageId: steer.message.id,
        expectedRunId: f.initial.run!.id,
        idempotencyKey: "person-steer",
      });
      const remaining = (await store.getThreadInputQueue(person)).items.map(
        ({ message }) => message.id,
      );
      expect(remaining).toEqual([move.message.id, anchor.message.id]);
    });
  }
  it("moves the person's queued messages around a platform continuation without moving it", async ({
    storeFixture,
  }) => {
    const { fixture, queued, store, move, order } = storeFixture;
    const f = await fixture("own-move");
    const mine = await queued(f, "own-move");
    const followUp = await store.enqueueThreadInput({
      content: [{ text: "Request fulfilled. Continue.", type: "text" }],
      idempotencyKey: "platform-own-move",
      policy: "queue",
      requestedBy: f.userId,
      source: {
        cause: "request-resolved",
        kind: "platform",
        referenceId: "req_own_move",
        sourceRunId: f.initial.run!.id,
      },
      threadId: f.thread.id,
    });
    const view = await store.getThreadInputQueue({ requestedBy: f.userId, threadId: f.thread.id });
    expect(
      view.items.map(({ canMove, canCancel, message }) => ({ canMove, canCancel, id: message.id })),
    ).toEqual([
      { canMove: true, canCancel: true, id: mine.message.id },
      { canMove: false, canCancel: false, id: followUp.message.id },
    ]);
    await expect(
      move(f, followUp.message.id, mine.message.id, "move-follow-up"),
    ).rejects.toMatchObject({ code: "forbidden" });
    await move(f, mine.message.id, null, "move-mine-last");
    await expect(order(f)).resolves.toEqual([followUp.message.id, mine.message.id]);
  });
  it("replays a retried move instead of applying it over a newer arrangement", async ({
    storeFixture,
  }) => {
    const { fixture, queued, move, order } = storeFixture;
    const f = await fixture("move-replay");
    const a = await queued(f, "move-replay-a");
    const b = await queued(f, "move-replay-b");
    await move(f, b.message.id, a.message.id, "move-replay-1");
    await move(f, b.message.id, null, "move-replay-2");
    await expect(order(f)).resolves.toEqual([a.message.id, b.message.id]);
    await expect(move(f, b.message.id, a.message.id, "move-replay-1")).resolves.toMatchObject({
      events: [],
      wasDuplicate: true,
    });
    await expect(order(f)).resolves.toEqual([a.message.id, b.message.id]);
    await expect(move(f, a.message.id, null, "move-replay-1")).rejects.toMatchObject({
      code: "conflict",
      message: "The idempotency key was already used for a different command",
    });
  });
  it("keeps the arranged order through a pause and admits it on Resume", async ({
    storeFixture,
  }) => {
    const { fixture, queued, database, complete, move, queuedRunSeed, store } = storeFixture;
    const f = await fixture("move-paused");
    const a = await queued(f, "move-paused-a");
    const b = await queued(f, "move-paused-b");
    await database
      .updateTable("threads")
      .set({
        inputQueuePaused: true,
        inputQueuePausedBy: f.userId,
      })
      .where("id", "=", f.thread.id)
      .execute();
    await complete(f, 1);
    await move(f, b.message.id, a.message.id, "move-paused");
    await expect(queuedRunSeed(f)).resolves.toBeNull();
    await store.resumeThreadInputQueue({
      idempotencyKey: "resume-move-paused",
      requestedBy: f.userId,
      threadId: f.thread.id,
    });
    await expect(queuedRunSeed(f)).resolves.toBe(b.message.id);
  });
  it("refuses to rearrange an archived Thread", async ({ storeFixture }) => {
    const { fixture, queued, database, store, move } = storeFixture;
    const f = await fixture("move-archived");
    const a = await queued(f, "move-archived-a");
    const b = await queued(f, "move-archived-b");
    await database
      .updateTable("threads")
      .set({
        status: "archived",
        updatedAt: new Date(),
      })
      .where("id", "=", f.thread.id)
      .execute();
    await expect(
      store.getThreadInputQueue({
        requestedBy: f.userId,
        threadId: f.thread.id,
      }),
    ).resolves.toMatchObject({
      items: [
        {
          canMove: false,
        },
        {
          canMove: false,
        },
      ],
    });
    await expect(move(f, b.message.id, a.message.id, "move-archived")).rejects.toMatchObject({
      code: "conflict",
      message: "Archived threads cannot run",
    });
  });
  it("places a queued message after everything the Thread said while it waited", async ({
    storeFixture,
  }) => {
    const {
      fixture,
      queued,
      move,
      assistantReply,
      complete,
      queuedRunSeed,
      messageSequences,
      threadEvents,
      database,
      store,
    } = storeFixture;
    const f = await fixture("placed");
    const a = await queued(f, "placed-a");
    const b = await queued(f, "placed-b");
    await move(f, b.message.id, a.message.id, "move-placed");
    const reply = await assistantReply(f, 1);
    await complete(f, 2);
    await expect(queuedRunSeed(f)).resolves.toBe(b.message.id);
    const sequences = await messageSequences(f);
    expect(sequences.map(({ id }) => id)).toEqual([
      f.initial.message.id,
      a.message.id,
      reply,
      b.message.id,
    ]);
    const events = await threadEvents(f);
    const placedAt = events.findIndex(
      (event) => event.type === "message.placed" && event.data.message.id === b.message.id,
    );
    expect(events[placedAt]).toMatchObject({
      data: {
        message: {
          id: b.message.id,
          sequence: sequences.at(-1)!.sequence,
        },
      },
    });
    expect(
      events.some(
        (event) => event.type === "message.placed" && event.data.message.id === a.message.id,
      ),
    ).toBe(false);
    // Placement precedes the Run it seeds, so a reader sees the message first.
    expect(placedAt).toBe(events.findLastIndex((event) => event.type === "run.queued") - 1);
    const seededRun = await database
      .selectFrom("runs")
      .select("id")
      .where("seedInputId", "=", b.message.id)
      .executeTakeFirstOrThrow();
    const command = await database
      .selectFrom("commands")
      .select("id")
      .where("runId", "=", seededRun.id)
      .where("type", "=", "run.execute")
      .executeTakeFirstOrThrow();
    await store.claimCommand(command.id, "placed-dispatcher");
    const context = await store.loadRunDispatchContext(command.id);
    expect(context.inputs.map(({ id }) => id)).toEqual([b.message.id]);
    expect(context.history.map(({ id }) => id)).toContain(reply);
    expect(context.history.map(({ id }) => id)).not.toContain(a.message.id);
  });
  it("leaves a message sent to an idle Thread where it was sent", async ({ storeFixture }) => {
    const { fixture, complete, messageSequences, queued } = storeFixture;
    const f = await fixture("placed-idle");
    await complete(f, 1);
    const before = await messageSequences(f);
    const next = await queued(f, "placed-idle");
    expect(next.disposition).toBe("run-queued");
    const after = await messageSequences(f);
    expect(after.at(-1)).toEqual({
      id: next.message.id,
      sequence: String(before.length),
    });
  });
  it("places a steered message where the running turn takes it", async ({ storeFixture }) => {
    const { fixture, queued, assistantReply, store, messageSequences, threadEvents } = storeFixture;
    const f = await fixture("placed-steer");
    const a = await queued(f, "placed-steer");
    const reply = await assistantReply(f, 1);
    await store.steerThreadInput({
      expectedRunId: f.initial.run!.id,
      idempotencyKey: "steer-placed",
      messageId: a.message.id,
      requestedBy: f.userId,
      threadId: f.thread.id,
    });
    const sequences = await messageSequences(f);
    expect(sequences.map(({ id }) => id)).toEqual([f.initial.message.id, reply, a.message.id]);
    await expect(threadEvents(f)).resolves.toContainEqual(
      expect.objectContaining({
        data: {
          message: expect.objectContaining({
            id: a.message.id,
            runId: f.initial.run!.id,
          }),
        },
        type: "message.placed",
      }),
    );
  });
});
function pendingEvent<T extends PendingAgentEvent>(input: Omit<T, "emittedAt">): T {
  return {
    ...input,
    emittedAt: new Date().toISOString(),
  } as T;
}
