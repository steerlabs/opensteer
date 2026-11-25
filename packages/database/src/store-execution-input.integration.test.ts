import { commitRunnerEvent } from "./runner-event-store.js";
import { jsonValue, threadPathLinks } from "./store-primitives.js";
import { DeviceIdSchema } from "@opensteer/core";
import type { StoreFixture } from "./store.integration.test-support.js";
import {
  HarnessIdSchema,
  TabIdSchema,
  MessageContentSchema,
  messageContentMaxSerializedBytes,
  ModelSelectionSchema,
  createId,
  createToolArguments,
  createToolOutput,
  toolArgumentsMaxSerializedBytes,
} from "@opensteer/core";
import {
  RunnerModulesSchema,
  type PendingAgentEvent,
  type PendingAgentEventV2,
} from "@opensteer/protocol";
import { sql } from "kysely";
import { z } from "zod";
import { describe, expect, vi } from "vitest";
import { OpensteerStore } from "./index.js";
import {
  describeStore,
  testModelSelection,
  testContinuationIdentity,
  pendingEvent,
} from "./store.integration.test-support.js";
describeStore("PostgreSQL store", (it) => {
  it.for(["deactivated-session", "started-run", "runner-restart"])(
    "refuses a replacement conversation with %s evidence",
    async (evidence, { storeFixture }) => {
      const { createRunFixture, enqueueHumanTrigger, store, database } = storeFixture;
      const fixture = await createRunFixture("lost-continuation");
      const first = await enqueueHumanTrigger({
        content: [
          {
            text: "Start",
            type: "text",
          },
        ],
        idempotencyKey: "lost-first",
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      const bindingInput = {
        bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
        continuationIdentity: testContinuationIdentity,
        harnessInstanceId: fixture.harnessInstance.id,
        leaseTokenHash: "lost-lease",
        runnerBootId: "lost-boot",
        runnerId: fixture.runnerId,
        threadId: fixture.thread.id,
      };
      await store.claimCommand(first.command.id, "test");
      const binding = await store.acquireExecutionBinding({
        ...bindingInput,
        runId: first.run.id,
      });
      if (evidence !== "runner-restart")
        await store.bindProviderSession({
          bindingGeneration: binding.bindingGeneration,
          harnessInstanceId: fixture.harnessInstance.id,
          providerSessionId: binding.providerSessionId,
          providerSessionReference: "established-session",
          runId: first.run.id,
          runnerBootId: bindingInput.runnerBootId,
          runnerId: fixture.runnerId,
          threadId: fixture.thread.id,
        });
      if (evidence === "runner-restart") {
        // The Runner confirmed the Run, then came back as a new boot without it.
        await store.succeedCommand(first.command.id);
        await store.attachRunnerExecutions({
          dispatchingRunIds: [],
          executions: [],
          leaseExpiresAt: new Date(Date.now() + 60_000),
          runnerBootId: "lost-boot-restarted",
          runnerId: fixture.runnerId,
        });
      } else await store.failCommand(first.command.id, "Execution failed");
      if (evidence === "deactivated-session") {
        await database
          .updateTable("providerSessions")
          .set({
            active: false,
            status: "stopped",
          })
          .where("id", "=", binding.providerSessionId)
          .execute();
      } else if (evidence === "started-run") {
        // Even a missing/corrupt reference must not erase evidence of execution.
        await database
          .updateTable("providerSessions")
          .set({
            providerSessionReference: null,
          })
          .where("id", "=", binding.providerSessionId)
          .execute();
        await database
          .updateTable("runs")
          .set({
            startedAt: new Date(),
          })
          .where("id", "=", first.run.id)
          .execute();
      }
      if (evidence === "deactivated-session") {
        await expect(
          store.enqueueThreadInput({
            content: [
              {
                text: "Continue",
                type: "text",
              },
            ],
            idempotencyKey: "lost-retry",
            policy: "queue",
            requestedBy: fixture.userId,
            source: {
              kind: "human",
            },
            threadId: fixture.thread.id,
          }),
        ).rejects.toThrow("no selected provider session");
        return;
      }
      const retry = await enqueueHumanTrigger({
        content: [
          {
            text: "Continue",
            type: "text",
          },
        ],
        idempotencyKey: "lost-retry",
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      await store.claimCommand(retry.command.id, "test");
      await expect(
        store.acquireExecutionBinding({
          ...bindingInput,
          runId: retry.run.id,
        }),
      ).rejects.toThrow("uncertain native start");
    },
  );

  it("serializes simultaneous exact retries for every durable command writer", async ({
    storeFixture,
  }) => {
    const { database, store } = storeFixture;
    const secondHostStore = new OpensteerStore(database);
    const base = await storeFixture.createRunFixture("concurrent-command-base");
    const { userId, environmentId, harnessInstance: harness } = base;
    const threadInput = {
      createdBy: userId,
      environmentId,
      harnessInstanceId: harness.id,
      idempotencyKey: "concurrent-command-thread",
      modelSelection: testModelSelection,
      title: "Concurrent Thread",
    };
    const threads = await Promise.all(
      Array.from(
        {
          length: 8,
        },
        (_, index) => (index % 2 === 0 ? store : secondHostStore).createThread(threadInput),
      ),
    );
    expect(threads.filter(({ wasDuplicate }) => !wasDuplicate)).toHaveLength(1);
    expect(new Set(threads.map(({ thread }) => thread.id)).size).toBe(1);
    const threadId = threads[0]!.thread.id;
    const messageInput = {
      content: [
        {
          text: "Run this once",
          type: "text" as const,
        },
      ],
      idempotencyKey: "concurrent-command-message",
      policy: "queue" as const,
      requestedBy: userId,
      source: {
        kind: "human" as const,
      },
      threadId,
    };
    const messages = await Promise.all(
      Array.from(
        {
          length: 8,
        },
        (_, index) => (index % 2 === 0 ? store : secondHostStore).enqueueThreadInput(messageInput),
      ),
    );
    expect(messages.filter(({ wasDuplicate }) => !wasDuplicate)).toHaveLength(1);
    expect(new Set(messages.map(({ message }) => message.id)).size).toBe(1);
    await expect(
      database
        .selectFrom("runs")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("threadId", "=", threadId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      count: "1",
    });
    const controlInput = {
      idempotencyKey: "concurrent-command-stop",
      requestedBy: userId,
      runId: messages[0]!.run!.id,
      threadId,
      type: "run.interrupt" as const,
    };
    const controls = await Promise.all(
      Array.from(
        {
          length: 8,
        },
        (_, index) =>
          (index % 2 === 0 ? store : secondHostStore).enqueueRunnerControl(controlInput),
      ),
    );
    expect(controls.filter(({ wasDuplicate }) => !wasDuplicate)).toHaveLength(1);
    expect(new Set(controls.map(({ command }) => command.id)).size).toBe(1);
    await expect(
      database
        .selectFrom("commands")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("requestedBy", "=", userId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      count: "4",
    });
  });

  it("keeps a Thread-create retry idempotent when the native model id has moved", async ({
    storeFixture,
  }) => {
    const { createRunFixture, store } = storeFixture;
    const fixture = await createRunFixture("native-model-retry");
    const input = {
      createdBy: fixture.userId,
      environmentId: fixture.environmentId,
      harnessInstanceId: fixture.harnessInstance.id,
      idempotencyKey: "native-model-retry",
      modelSelection: ModelSelectionSchema.parse({
        ...testModelSelection,
        nativeModelId: "openai/gpt-5.6-sol",
      }),
      title: "Through a gateway",
    };
    const created = await store.createThread(input);
    expect(created.wasDuplicate).toBe(false);
    expect(created.thread.modelSelection.nativeModelId).toBe("openai/gpt-5.6-sol");
    // The Host reads the native id off a live catalog, so a retry can carry a
    // different one — or none. That is the same request, not a reused key.
    await expect(
      store.findThreadCreationByIdempotency({
        ...input,
        modelSelection: testModelSelection,
      }),
    ).resolves.toMatchObject({
      thread: {
        id: created.thread.id,
      },
      wasDuplicate: true,
    });
    await expect(
      store.createThread({
        ...input,
        modelSelection: ModelSelectionSchema.parse({
          ...testModelSelection,
          nativeModelId: "openai/gpt-5.6-sol:nitro",
        }),
      }),
    ).resolves.toMatchObject({
      thread: {
        id: created.thread.id,
      },
      wasDuplicate: true,
    });
    // The canonical pair is still the request, so changing it is a reuse.
    await expect(
      store.createThread({
        ...input,
        modelSelection: ModelSelectionSchema.parse({
          ...testModelSelection,
          modelId: "gpt-5.6-terra",
        }),
      }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
  });
  it("keeps reports passive and admits one queued work item per Run", async ({ storeFixture }) => {
    const { createRunFixture, store, database } = storeFixture;
    const fixture = await createRunFixture("thread-input-policy");
    const queueRequest = {
      content: [
        {
          text: "Hold this input",
          type: "text" as const,
        },
      ],
      idempotencyKey: "thread-input-policy-queue",
      policy: "report" as const,
      requestedBy: fixture.userId,
      source: {
        kind: "human" as const,
      },
      threadId: fixture.thread.id,
    };
    const queued = await store.enqueueThreadInput(queueRequest);
    const reports = [
      queued,
      ...(await Promise.all(
        Array.from(
          {
            length: 7,
          },
          (_, index) =>
            store.enqueueThreadInput({
              ...queueRequest,
              content: [
                {
                  text: `Historical report ${index + 2}`,
                  type: "text",
                },
              ],
              idempotencyKey: `thread-input-policy-report-${index + 2}`,
            }),
        ),
      )),
    ];
    expect(queued).toMatchObject({
      command: null,
      disposition: "pending",
      input: {
        policy: "report",
        runId: null,
        state: "pending",
      },
      message: {
        author: {
          displayName: "Alex",
          kind: "human",
          userId: fixture.userId,
        },
        kind: "input",
        runId: null,
      },
      run: null,
      wasDuplicate: false,
    });
    const replayed = await store.enqueueThreadInput(queueRequest);
    expect(replayed).toMatchObject({
      command: null,
      disposition: "pending",
      input: {
        messageId: queued.message.id,
      },
      message: {
        id: queued.message.id,
      },
      run: null,
      wasDuplicate: true,
    });
    await expect(
      store.enqueueThreadInput({
        ...queueRequest,
        policy: "queue",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      database
        .selectFrom("causalChains")
        .select(["rootMessageId", "rootOccurrenceId"])
        .where("id", "=", queued.input.causalChainId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      rootMessageId: queued.message.id,
      rootOccurrenceId: null,
    });
    await expect(
      database.deleteFrom("messages").where("id", "=", queued.message.id).execute(),
    ).rejects.toThrow(/causal_chains_root_message_fk/u);
    const triggered = await store.enqueueThreadInput({
      content: [
        {
          text: "Start processing the inbox",
          type: "text",
        },
      ],
      idempotencyKey: "thread-input-policy-trigger",
      policy: "queue",
      requestedBy: fixture.userId,
      source: {
        kind: "human",
      },
      threadId: fixture.thread.id,
    });
    expect(triggered).toMatchObject({
      command: {
        type: "run.execute",
      },
      disposition: "run-queued",
      input: {
        policy: "queue",
        runId: null,
        state: "pending",
      },
      run: {
        status: "queued",
        seedInputId: triggered.message.id,
      },
    });
    if (!triggered.command || !triggered.run) throw new Error("Expected a queued inbox Run");
    await store.claimCommand(triggered.command.id, "thread-input-policy-dispatcher");
    const context = await store.loadRunDispatchContext(triggered.command.id);
    expect(context.inputs.map(({ id }) => id)).toEqual([triggered.message.id]);
    expect(new Set(context.reports.messages.map(({ id }) => id))).toEqual(
      new Set(reports.map(({ message }) => message.id)),
    );
    expect(context.run.seedInputId).toBe(triggered.message.id);
    await expect(
      database
        .selectFrom("runs")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("threadId", "=", fixture.thread.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      count: "1",
    });
    await expect(
      database
        .selectFrom("threadInputs")
        .select(["runId", "state"])
        .where("messageId", "=", triggered.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      runId: triggered.run.id,
      state: "claimed",
    });
    const runnerBootId = "boot-thread-input-policy";
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: fixture.harnessInstance.id,
      leaseTokenHash: "thread-input-policy-lease",
      runnerBootId,
      runnerId: fixture.runnerId,
      runId: triggered.run.id,
      threadId: fixture.thread.id,
    });
    await commitRunnerEvent(store.database, threadPathLinks, {
      environmentId: fixture.environmentId,
      event: pendingEvent({
        bindingGeneration: binding.bindingGeneration,
        data: {
          status: "running",
        },
        environmentId: fixture.environmentId,
        ordinal: 0,
        runId: triggered.run.id,
        threadId: fixture.thread.id,
        type: "run.started",
      }),
      runnerBootId,
      runnerId: fixture.runnerId,
    });
    const lateReport = await store.enqueueThreadInput({
      ...queueRequest,
      content: [
        {
          text: "Late passive report",
          type: "text",
        },
      ],
      idempotencyKey: "thread-input-policy-late-report",
    });
    await commitRunnerEvent(store.database, threadPathLinks, {
      environmentId: fixture.environmentId,
      event: pendingEvent({
        bindingGeneration: binding.bindingGeneration,
        data: {
          status: "completed",
        },
        environmentId: fixture.environmentId,
        ordinal: 1,
        runId: triggered.run.id,
        threadId: fixture.thread.id,
        type: "run.completed",
      }),
      runnerBootId,
      runnerId: fixture.runnerId,
    });
    await expect(
      database
        .selectFrom("threadInputs")
        .select(["runId", "state"])
        .where("messageId", "=", lateReport.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      runId: null,
      state: "pending",
    });
    await expect(store.recoverThreadWorkQueues()).resolves.toBeUndefined();
    await expect(
      database
        .selectFrom("runs")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("threadId", "=", fixture.thread.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      count: "1",
    });
    const { thread: otherThread } = await store.createThread({
      createdBy: fixture.userId,
      environmentId: fixture.environmentId,
      harnessInstanceId: fixture.harnessInstance.id,
      idempotencyKey: "thread-input-policy-cross-thread",
      modelSelection: testModelSelection,
      title: "Cross-thread integrity target",
    });
    const otherInput = await store.enqueueThreadInput({
      content: [
        {
          text: "Must remain on the other Thread",
          type: "text",
        },
      ],
      idempotencyKey: "thread-input-policy-cross-thread-input",
      policy: "report",
      requestedBy: fixture.userId,
      source: {
        kind: "human",
      },
      threadId: otherThread.id,
    });
    await expect(
      database
        .updateTable("messages")
        .set({
          runId: triggered.run.id,
        })
        .where("id", "=", otherInput.message.id)
        .execute(),
    ).rejects.toThrow(/messages_run_thread_fk/u);
    await expect(
      database
        .updateTable("threadInputs")
        .set({
          runId: triggered.run.id,
          state: "claimed",
        })
        .where("messageId", "=", otherInput.message.id)
        .execute(),
    ).rejects.toThrow(/thread_inputs_run_thread_fk/u);
  });
  it("delivers a maximum-size report without starving later context", async ({ storeFixture }) => {
    const { createRunFixture, store, enqueueHumanTrigger } = storeFixture;
    const fixture = await createRunFixture("maximum-report-context");
    const content = [
      {
        type: "text" as const,
        text: "x".repeat(256 * 1_024),
      },
      {
        type: "text" as const,
        text: "",
      },
    ];
    content[1]!.text = "y".repeat(
      messageContentMaxSerializedBytes - Buffer.byteLength(JSON.stringify(content)),
    );
    expect(Buffer.byteLength(JSON.stringify(MessageContentSchema.parse(content)))).toBe(
      messageContentMaxSerializedBytes,
    );
    const maximum = await store.enqueueThreadInput({
      content,
      idempotencyKey: "maximum-report-context-large",
      policy: "report",
      requestedBy: fixture.userId,
      source: {
        kind: "human",
      },
      threadId: fixture.thread.id,
    });
    const next = await store.enqueueThreadInput({
      content: [
        {
          type: "text",
          text: "A later report must remain reachable",
        },
      ],
      idempotencyKey: "maximum-report-context-next",
      policy: "report",
      requestedBy: fixture.userId,
      source: {
        kind: "human",
      },
      threadId: fixture.thread.id,
    });
    const work = await enqueueHumanTrigger({
      content: [
        {
          type: "text",
          text: "Use available context",
        },
      ],
      idempotencyKey: "maximum-report-context-work",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    await store.claimCommand(work.command.id, "maximum-report-context-dispatcher");
    const context = await store.loadRunDispatchContext(work.command.id);
    expect(context.reports.messages.map(({ id }) => id)).toEqual([
      maximum.message.id,
      next.message.id,
    ]);
    expect(context.reports.omittedCount).toBe(0);
  });
  it("freezes a bounded report sidecar and retries an unknown report only with real work", async ({
    storeFixture,
  }) => {
    const { createRunFixture, store, database } = storeFixture;
    const fixture = await createRunFixture("thread-report-sidecar-cap");
    const reports = [];
    // One overflowing report keeps fixture preparation bounded under load.
    for (let index = 0; index < 51; index += 1) {
      reports.push(
        await store.enqueueThreadInput({
          content: [
            {
              text: `Passive report ${index}`,
              type: "text",
            },
          ],
          idempotencyKey: `thread-report-sidecar-cap-${index}`,
          policy: "report",
          requestedBy: fixture.userId,
          source: {
            kind: "human",
          },
          threadId: fixture.thread.id,
        }),
      );
    }
    await expect(
      database
        .selectFrom("runs")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("threadId", "=", fixture.thread.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      count: "0",
    });
    const work = await store.enqueueThreadInput({
      content: [
        {
          text: "Process one real task",
          type: "text",
        },
      ],
      idempotencyKey: "thread-report-sidecar-cap-work",
      policy: "queue",
      requestedBy: fixture.userId,
      source: {
        kind: "human",
      },
      threadId: fixture.thread.id,
    });
    if (!work.command || !work.run) throw new Error("Expected one queued work Run");
    await database
      .updateTable("threadInputs")
      .set({
        runId: work.run.id,
        state: "unknown",
      })
      .where("messageId", "=", reports[0]!.message.id)
      .executeTakeFirstOrThrow();
    await store.claimCommand(work.command.id, "thread-report-sidecar-cap-dispatcher");
    const context = await store.loadRunDispatchContext(work.command.id);
    expect(context.inputs.map(({ id }) => id)).toEqual([work.message.id]);
    expect(context.reports.messages).toHaveLength(50);
    expect(context.reports.messages.map(({ id }) => id)).toContain(reports[0]!.message.id);
    expect(context.reports.omittedCount).toBe(1);
    expect(context.reports.throughSequence).not.toBeNull();
    const late = await store.enqueueThreadInput({
      content: [
        {
          text: "Arrived after the frozen snapshot",
          type: "text",
        },
      ],
      idempotencyKey: "thread-report-sidecar-cap-late",
      policy: "report",
      requestedBy: fixture.userId,
      source: {
        kind: "human",
      },
      threadId: fixture.thread.id,
    });
    await store.retryCommand(work.command.id, new Error("Retry the same native dispatch"));
    await store.claimCommand(work.command.id, "thread-report-sidecar-cap-retry");
    const retry = await store.loadRunDispatchContext(work.command.id);
    expect(retry.reports).toEqual(context.reports);
    expect(retry.reports.messages.map(({ id }) => id)).not.toContain(late.message.id);
    await expect(
      database
        .selectFrom("threadInputs")
        .select(["runId", "state"])
        .where("messageId", "=", late.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      runId: null,
      state: "pending",
    });
  }, 120_000);

  it("drains an incompatible trigger after the FIFO Run ahead of it terminates", async ({
    storeFixture,
  }) => {
    const { createRunFixture, store, database } = storeFixture;
    const fixture = await createRunFixture("thread-input-terminal-trigger-drain");
    const first = await store.enqueueThreadInput({
      content: [
        {
          text: "Run this older independent root first",
          type: "text",
        },
      ],
      idempotencyKey: "thread-input-terminal-trigger-drain-first",
      policy: "queue",
      requestedBy: fixture.userId,
      source: {
        kind: "human",
      },
      threadId: fixture.thread.id,
    });
    const trigger = await store.enqueueThreadInput({
      content: [
        {
          text: "Then run this incompatible root",
          type: "text",
        },
      ],
      idempotencyKey: "thread-input-terminal-trigger-drain-trigger",
      policy: "queue",
      requestedBy: fixture.userId,
      source: {
        kind: "human",
      },
      threadId: fixture.thread.id,
    });
    expect(trigger).toMatchObject({
      command: null,
      disposition: "pending",
      run: null,
    });
    if (!first.command || !first.run) throw new Error("Expected the FIFO Run");
    const claimed = await store.claimCommand(
      first.command.id,
      "thread-input-terminal-trigger-drain-dispatcher",
    );
    expect(claimed?.command.status).toBe("dispatched");
    await expect(
      database
        .selectFrom("threadInputs")
        .select("state")
        .where("messageId", "=", first.run.seedInputId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ state: "claimed" });
    const runnerBootId = "boot-thread-input-terminal-trigger-drain";
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: fixture.harnessInstance.id,
      leaseTokenHash: "thread-input-terminal-trigger-drain-lease",
      runnerBootId,
      runnerId: fixture.runnerId,
      runId: first.run.id,
      threadId: fixture.thread.id,
    });
    const started = await commitRunnerEvent(store.database, threadPathLinks, {
      environmentId: fixture.environmentId,
      event: pendingEvent({
        bindingGeneration: binding.bindingGeneration,
        data: {
          status: "running",
        },
        environmentId: fixture.environmentId,
        ordinal: 0,
        runId: first.run.id,
        threadId: fixture.thread.id,
        type: "run.started",
      }),
      runnerBootId,
      runnerId: fixture.runnerId,
    });
    expect(started).toMatchObject({ throughOrdinal: 0, replayed: false });
    const completed = await commitRunnerEvent(store.database, threadPathLinks, {
      environmentId: fixture.environmentId,
      event: pendingEvent({
        bindingGeneration: binding.bindingGeneration,
        data: {
          status: "completed",
        },
        environmentId: fixture.environmentId,
        ordinal: 1,
        runId: first.run.id,
        threadId: fixture.thread.id,
        type: "run.completed",
      }),
      runnerBootId,
      runnerId: fixture.runnerId,
    });
    expect(completed).toMatchObject({ throughOrdinal: 1, replayed: false });
    await expect(
      database
        .selectFrom("runs")
        .select(["status", "seedInputId"])
        .where("threadId", "=", fixture.thread.id)
        .where("status", "=", "queued")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      status: "queued",
      seedInputId: trigger.message.id,
    });
  });

  /*
   * A provider session keeps the lease its last Run held after that Run ends.
   * Failure mode: the expiry sweep judges the Thread's next Run, claimed and
   * still being prepared, by that stale lease and fails a Run that never held
   * a binding.
   */
  it("leaves a Run being prepared alone when its session's last lease expired", async ({
    storeFixture,
  }) => {
    const { createRunFixture, store, database } = storeFixture;
    const fixture = await createRunFixture("stale-session-lease");
    const enqueue = (key: string) =>
      store.enqueueThreadInput({
        content: [
          {
            text: key,
            type: "text",
          },
        ],
        idempotencyKey: key,
        policy: "queue",
        requestedBy: fixture.userId,
        source: {
          kind: "human",
        },
        threadId: fixture.thread.id,
      });
    const first = await enqueue("stale-session-lease-first");
    if (!first.command || !first.run) throw new Error("Expected a Run");
    await store.claimCommand(first.command.id, "dispatcher");
    const runnerBootId = "boot-stale-session-lease";
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: fixture.harnessInstance.id,
      leaseTokenHash: "stale-session-lease",
      runnerBootId,
      runnerId: fixture.runnerId,
      runId: first.run.id,
      threadId: fixture.thread.id,
    });
    const base = {
      bindingGeneration: binding.bindingGeneration,
      environmentId: fixture.environmentId,
      runId: first.run.id,
      threadId: fixture.thread.id,
    };
    for (const [ordinal, type, data] of [
      [
        0,
        "run.started",
        {
          status: "running",
        },
      ],
      [
        1,
        "run.completed",
        {
          status: "completed",
        },
      ],
    ] as const) {
      await commitRunnerEvent(store.database, threadPathLinks, {
        environmentId: fixture.environmentId,
        event: pendingEvent({
          ...base,
          data,
          ordinal,
          type,
        }),
        runnerBootId,
        runnerId: fixture.runnerId,
      });
    }
    await database
      .updateTable("providerSessions")
      .set({
        leaseExpiresAt: new Date(Date.now() - 60_000),
      })
      .where("id", "=", binding.providerSessionId)
      .execute();
    const next = await enqueue("stale-session-lease-next");
    if (!next.command || !next.run) throw new Error("Expected a second Run");
    await store.claimCommand(next.command.id, "dispatcher");
    const swept = await store.recoverRunsWithExpiredExecutionBindings();
    expect(swept.terminatedRuns).toEqual([]);
    await expect(
      database
        .selectFrom("runs")
        .select("status")
        .where("id", "=", next.run.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      status: "starting",
    });
  });

  /*
   * A Host that stops mid-dispatch leaves the Run's execute command claimed.
   * Failure modes after its restart:
   * - a Run claimed but never bound to a Runner has no lease and no Runner to
   *   announce it, so nothing would ever start or end it, and its Thread
   *   would wait behind it forever;
   * - a Run already bound may be running on its Runner, so only that Runner's
   *   attach may settle it.
   */
  it("returns a Run a stopped Host claimed but never bound to its queue", async ({
    storeFixture,
  }) => {
    const { createRunFixture, store, database } = storeFixture;
    const fixture = await createRunFixture("claimed-unbound-restart");
    const enqueue = (key: string) =>
      store.enqueueThreadInput({
        content: [
          {
            text: key,
            type: "text",
          },
        ],
        idempotencyKey: key,
        policy: "queue",
        requestedBy: fixture.userId,
        source: {
          kind: "human",
        },
        threadId: fixture.thread.id,
      });
    const unbound = await enqueue("claimed-unbound-input");
    if (!unbound.command || !unbound.run) throw new Error("Expected a Run");
    await store.claimCommand(unbound.command.id, "host-before-restart");
    await store.recoverCommandsAfterHostRestart();
    expect(
      await database
        .selectFrom("runs")
        .select(["status", "createdAt", "personWaited", "requestedBy"])
        .where("id", "=", unbound.run.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      status: "queued",
      createdAt: new Date(unbound.run.createdAt),
      personWaited: true,
      requestedBy: fixture.userId,
    });
    await expect(
      database
        .selectFrom("commands")
        .select("status")
        .where("id", "=", unbound.command.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      status: "pending",
    });
    await store.claimCommand(unbound.command.id, "host-after-restart");
    await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: fixture.harnessInstance.id,
      leaseTokenHash: "claimed-bound-lease",
      runnerBootId: "boot-claimed-bound",
      runnerId: fixture.runnerId,
      runId: unbound.run.id,
      threadId: fixture.thread.id,
    });
    await store.recoverCommandsAfterHostRestart();
    await expect(
      database
        .selectFrom("runs")
        .select("status")
        .where("id", "=", unbound.run.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      status: "starting",
    });
  });
  it("holds a starting Run after its replayed session binding commits across Host restarts", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, store, database } = storeFixture;
    const fixture = await createRunFixture("replayed-binding-restart");
    const turn = await enqueueHumanTrigger({
      content: [
        {
          text: "Start",
          type: "text",
        },
      ],
      idempotencyKey: "replayed-binding-input",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    await store.claimCommand(turn.command.id, "host-before-restart");
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: fixture.harnessInstance.id,
      leaseTokenHash: "replayed-binding-lease",
      runnerBootId: "replayed-binding-boot",
      runnerId: fixture.runnerId,
      runId: turn.run.id,
      threadId: fixture.thread.id,
    });
    const attachment = {
      dispatchingRunIds: [],
      executions: [
        {
          bindingGeneration: binding.bindingGeneration,
          environmentId: fixture.environmentId,
          nextOrdinal: 1,
          runId: turn.run.id,
          terminal: false,
          threadId: fixture.thread.id,
        },
      ],
      leaseExpiresAt: new Date(Date.now() + 60_000),
      runnerBootId: "replayed-binding-boot",
      runnerId: fixture.runnerId,
    };
    await store.attachRunnerExecutions(attachment);
    await store.bindProviderSession({
      bindingGeneration: binding.bindingGeneration,
      harnessInstanceId: fixture.harnessInstance.id,
      providerSessionId: binding.providerSessionId,
      providerSessionReference: "replayed-native-session",
      runId: turn.run.id,
      runnerBootId: attachment.runnerBootId,
      runnerId: fixture.runnerId,
      threadId: fixture.thread.id,
    });
    // The execute acknowledgement and run.started were both lost. Only the
    // session binding committed before the Host stopped a second time.
    expect(await store.recoverCommandsAfterHostRestart()).toBeUndefined();
    await expect(
      database
        .selectFrom("runs")
        .select(["status", "bindingGeneration"])
        .where("id", "=", turn.run.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      bindingGeneration: binding.bindingGeneration,
      status: "starting",
    });
    await expect(
      database
        .selectFrom("commands")
        .select("status")
        .where("id", "=", turn.command.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      status: "dispatched",
    });
    expect((await store.attachRunnerExecutions(attachment)).results).toEqual([
      {
        nextOrdinal: 0,
        runId: turn.run.id,
        status: "attached",
      },
    ]);
  });
  it.for(["live", "expired"] as const)(
    "requeues a same-boot omission only with a live lease (%s)",
    async (lease, { storeFixture }) => {
      const { createRunFixture, enqueueHumanTrigger, store, database } = storeFixture;
      const fixture = await createRunFixture("omitted-binding");
      const turn = await enqueueHumanTrigger({
        content: [
          {
            text: "Start",
            type: "text",
          },
        ],
        idempotencyKey: "omitted-binding-input",
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      await store.claimCommand(turn.command.id, "host-before-attach");
      await store.acquireExecutionBinding({
        bindingLeaseExpiresAt: new Date(Date.now() + (lease === "live" ? 60_000 : -60_000)),
        continuationIdentity: testContinuationIdentity,
        harnessInstanceId: fixture.harnessInstance.id,
        leaseTokenHash: "omitted-binding-lease",
        runnerBootId: "omitted-binding-boot",
        runnerId: fixture.runnerId,
        runId: turn.run.id,
        threadId: fixture.thread.id,
      });
      await store.attachRunnerExecutions({
        dispatchingRunIds: [],
        executions: [],
        leaseExpiresAt: new Date(Date.now() + 60_000),
        runnerBootId: "omitted-binding-boot",
        runnerId: fixture.runnerId,
      });
      const settled = await database
        .selectFrom("runs")
        .select(["status", "bindingGeneration", "failure"])
        .where("id", "=", turn.run.id)
        .executeTakeFirstOrThrow();
      if (lease === "live")
        expect(settled).toEqual({ bindingGeneration: null, status: "queued", failure: null });
      else
        expect(settled).toMatchObject({
          status: "failed",
          failure: { code: "execution_binding_expired", status: "failed" },
        });
      await expect(
        database
          .selectFrom("commands")
          .select("status")
          .where("id", "=", turn.command.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        status: lease === "live" ? "pending" : "failed",
      });
    },
  );
  it.for([null, 0])(
    "ignores a pre-acquire Run with binding generation %s when its session's Runner attaches",
    async (bindingGeneration, { storeFixture }) => {
      const { startRunFixture, store, enqueueHumanTrigger, database } = storeFixture;
      const fixture = await startRunFixture("pre-acquire-attach");
      await commitRunnerEvent(store.database, threadPathLinks, {
        environmentId: fixture.environmentId,
        event: pendingEvent({
          bindingGeneration: fixture.bindingGeneration,
          data: {
            status: "completed",
          },
          environmentId: fixture.environmentId,
          ordinal: 1,
          runId: fixture.run.id,
          threadId: fixture.thread.id,
          type: "run.completed",
        }),
        runnerBootId: fixture.runnerBootId,
        runnerId: fixture.runnerId,
      });
      const next = await enqueueHumanTrigger({
        content: [
          {
            text: "Continue",
            type: "text",
          },
        ],
        idempotencyKey: "pre-acquire-next",
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      await store.claimCommand(next.command.id, "host-before-acquire");
      if (bindingGeneration !== null) {
        await database
          .updateTable("runs")
          .set({
            bindingGeneration,
          })
          .where("id", "=", next.run.id)
          .executeTakeFirstOrThrow();
      }
      const outcome = await store.attachRunnerExecutions({
        dispatchingRunIds: [],
        executions: [],
        leaseExpiresAt: new Date(Date.now() + 60_000),
        runnerBootId: fixture.runnerBootId,
        runnerId: fixture.runnerId,
      });
      expect(outcome.resumed).toEqual([]);
      await expect(
        database
          .selectFrom("runs")
          .select("status")
          .where("id", "=", next.run.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        status: "starting",
      });
      await store.recoverCommandsAfterHostRestart();
      await expect(
        database
          .selectFrom("runs")
          .select("status")
          .where("id", "=", next.run.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ status: "queued" });
    },
  );

  /*
   * PostgreSQL refuses half of a surrogate pair in jsonb, and an engine can put
   * one in any text it reports. Failure modes:
   * - the event log stores it well-formed but a projection (the message row)
   *   writes the original, failing the whole commit;
   * - the Runner replays the identical event after a reconnect and the Host
   *   compares its normalized record with the raw replay, refusing it.
   */
  it("commits and replays an answer holding half of a surrogate pair", async ({ storeFixture }) => {
    const { createRunFixture, store, database } = storeFixture;
    const fixture = await createRunFixture("lone-surrogate-answer");
    const work = await store.enqueueThreadInput({
      content: [
        {
          text: "Write an emoji",
          type: "text",
        },
      ],
      idempotencyKey: "lone-surrogate-answer-input",
      policy: "queue",
      requestedBy: fixture.userId,
      source: {
        kind: "human",
      },
      threadId: fixture.thread.id,
    });
    if (!work.command || !work.run) throw new Error("Expected a Run");
    await store.claimCommand(work.command.id, "lone-surrogate-dispatcher");
    const runnerBootId = "boot-lone-surrogate";
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: fixture.harnessInstance.id,
      leaseTokenHash: "lone-surrogate-lease",
      runnerBootId,
      runnerId: fixture.runnerId,
      runId: work.run.id,
      threadId: fixture.thread.id,
    });
    const base = {
      bindingGeneration: binding.bindingGeneration,
      environmentId: fixture.environmentId,
      runId: work.run.id,
      threadId: fixture.thread.id,
    };
    const commit = (event: ReturnType<typeof pendingEvent>) =>
      commitRunnerEvent(store.database, threadPathLinks, {
        environmentId: fixture.environmentId,
        event,
        runnerBootId,
        runnerId: fixture.runnerId,
      });
    await commit(
      pendingEvent({
        ...base,
        data: {
          status: "running",
        },
        ordinal: 0,
        type: "run.started",
      }),
    );
    const messageId = createId("message");
    const answer = pendingEvent({
      ...base,
      data: {
        content: [
          {
            text: "Here it is: \ud83d",
            type: "text",
          },
        ],
        messageId,
      },
      ordinal: 1,
      type: "assistant.message",
    });
    const committed = await commit(answer);
    const replayed = await commit(answer);
    expect(committed.replayed).toBe(false);
    expect(replayed.replayed).toBe(true);
    const message = await database
      .selectFrom("messages")
      .select("content")
      .where("id", "=", messageId)
      .executeTakeFirstOrThrow();
    expect(message.content).toEqual([
      {
        text: "Here it is: �",
        type: "text",
      },
    ]);
  });

  /*
   * Runner payload failure modes at the real jsonb boundary:
   * - a fitted shell command exceeds the event or database byte budget;
   * - jsonb formatting or replay changes the recorded arguments;
   * - fitting bulk rows loses the integration reference or Host subject;
   * - NUL passes JSON validation but fails the insert, or its message projection
   *   or replay uses the raw text instead of the durable replacement.
   */
  describe("bounded Runner event persistence", () => {
    async function runningFixture(storeFixture: StoreFixture, suffix: string) {
      const { createRunFixture, enqueueHumanTrigger, store } = storeFixture;
      const fixture = await createRunFixture(suffix);
      const work = await enqueueHumanTrigger({
        content: [
          {
            text: "Record the provider's tool call",
            type: "text",
          },
        ],
        idempotencyKey: `${suffix}-input`,
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      await store.claimCommand(work.command.id, `${suffix}-dispatcher`);
      const runnerBootId = `boot-${suffix}`;
      const binding = await store.acquireExecutionBinding({
        bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
        continuationIdentity: testContinuationIdentity,
        harnessInstanceId: fixture.harnessInstance.id,
        leaseTokenHash: `${suffix}-lease`,
        runnerBootId,
        runnerId: fixture.runnerId,
        runId: work.run.id,
        threadId: fixture.thread.id,
      });
      const base = {
        bindingGeneration: binding.bindingGeneration,
        environmentId: fixture.environmentId,
        runId: work.run.id,
        threadId: fixture.thread.id,
      };
      const commit = (
        event: PendingAgentEventV2,
        integration?: Parameters<OpensteerStore["commitRunnerEvent"]>[0]["integration"],
      ) =>
        commitRunnerEvent(store.database, threadPathLinks, {
          environmentId: fixture.environmentId,
          event,
          ...(integration
            ? {
                integration,
              }
            : {}),
          runnerBootId,
          runnerId: fixture.runnerId,
        });
      await commit(
        pendingEvent({
          ...base,
          data: {
            status: "running",
          },
          ordinal: 0,
          type: "run.started",
        }),
      );
      return {
        base,
        commit,
      };
    }
    async function storedCall(
      storeFixture: StoreFixture,
      runId: import("@opensteer/core").RunId,
      callId: string,
    ) {
      return storeFixture.database
        .selectFrom("toolCalls")
        .select(["callId", "tool", "arguments", "integration"])
        .where("runId", "=", runId)
        .where("callId", "=", callId)
        .executeTakeFirstOrThrow();
    }
    it("commits and exactly replays a fitted 600 KiB Codex inline shell command", async ({
      storeFixture,
    }) => {
      const { database } = storeFixture;
      const { base, commit } = await runningFixture(storeFixture, "bounded-shell-arguments");
      const script = Buffer.from(
        `import base64\npayload = '${"x".repeat(460_800)}'\nprint(len(payload))\n`,
      ).toString("base64");
      const raw = {
        command: `/bin/zsh -lc 'python3 - <<"PY"\nimport base64\nexec(base64.b64decode("${script}"))\nPY'`,
        commandActions: [
          {
            type: "unknown",
          },
        ],
        cwd: "/workspace/opensteer",
      };
      expect(Buffer.byteLength(JSON.stringify(raw))).toBeGreaterThan(600 * 1_024);
      const args = createToolArguments(raw);
      expect(Buffer.byteLength(JSON.stringify(args))).toBeLessThanOrEqual(
        toolArgumentsMaxSerializedBytes,
      );
      const fitted = z
        .object({
          command: z.string(),
          commandActions: z.array(
            z.object({
              type: z.string(),
            }),
          ),
          cwd: z.string(),
        })
        .parse(args);
      expect(fitted.command).toMatch(/\n… \d+ bytes omitted …\n/u);
      expect(fitted.command.startsWith(raw.command.slice(0, 100))).toBe(true);
      expect(fitted.command.endsWith(raw.command.slice(-100))).toBe(true);
      expect(fitted.cwd).toBe(raw.cwd);
      expect(fitted.commandActions).toEqual(raw.commandActions);
      const event = pendingEvent({
        ...base,
        data: {
          arguments: args,
          callId: "call-inline-python",
          tool: {
            name: "exec_command",
            namespace: "functions",
          },
        },
        ordinal: 1,
        type: "tool.started",
      });
      const committed = await commit(event);
      expect(committed.replayed).toBe(false);
      expect(await storedCall(storeFixture, base.runId, "call-inline-python")).toEqual({
        ...event.data,
        integration: null,
      });
      const replayed = await commit(event);
      expect(replayed.replayed).toBe(true);
      expect(replayed.throughOrdinal).toBe(committed.throughOrdinal);
      expect(
        await database
          .selectFrom("runnerEventReceipts")
          .select(sql<number>`count(*)::int`.as("count"))
          .where("runId", "=", base.runId)
          .where("ordinal", "=", 1)
          .executeTakeFirstOrThrow(),
      ).toEqual({
        count: 1,
      });
    });
    it("keeps a bulk integration call's operation and persists the Host-resolved subject", async ({
      storeFixture,
    }) => {
      const { base, commit } = await runningFixture(storeFixture, "bounded-integration-arguments");
      const operation = `spreadsheets.values.batchUpdate.${"a".repeat(90)}`;
      const args = createToolArguments({
        arguments: {
          values: Array.from(
            {
              length: 5_000,
            },
            (_, index) => [index, `row-${index}`, "ready"],
          ),
        },
        operation,
      });
      expect(Buffer.byteLength(JSON.stringify(args))).toBeLessThanOrEqual(
        toolArgumentsMaxSerializedBytes,
      );
      const fitted = z
        .object({
          arguments: z.string(),
          operation: z.string(),
        })
        .parse(args);
      expect(fitted.arguments).toMatch(/\n… \d+ bytes omitted …\n/u);
      expect(fitted.operation).toBe(operation);
      const subject = {
        account: "Work",
        computerApp: null,
        effect: "write" as const,
        integration: "Sheets",
        operation: {
          name: "append_rows",
          title: "Append rows",
        },
      };
      const event = pendingEvent({
        ...base,
        data: {
          arguments: args,
          callId: "call-bulk-rows",
          tool: {
            name: "plugin_call",
            namespace: "opensteer.integrations",
          },
        },
        ordinal: 1,
        type: "tool.started",
      });
      const committed = await commit(event, subject);
      expect(committed.replayed).toBe(false);
      expect(await storedCall(storeFixture, base.runId, "call-bulk-rows")).toEqual({
        ...event.data,
        integration: subject,
      });
      const replayed = await commit(event);
      expect(replayed.replayed).toBe(true);
      expect(replayed.throughOrdinal).toBe(committed.throughOrdinal);
    });
    it("keeps one Claude tool card across provisional and final receipts", async ({
      storeFixture,
    }) => {
      const { database } = storeFixture;
      const { base, commit } = await runningFixture(storeFixture, "provisional-tool");
      const start = {
        ...base,
        type: "tool.started",
        ordinal: 1,
        emittedAt: new Date().toISOString(),
        data: {
          callId: "claude-provisional",
          arguments: {},
          tool: { name: "Read", namespace: "claude" },
          provisional: true,
        },
      } satisfies PendingAgentEventV2;
      const find = () =>
        database
          .selectFrom("toolCalls")
          .select(["id", "startedAt", "arguments", "provisional"])
          .where("runId", "=", base.runId)
          .where("callId", "=", start.data.callId)
          .executeTakeFirstOrThrow();
      const args = { file_path: "notes.txt" };
      await expect(commit(start)).resolves.toMatchObject({ throughOrdinal: 1, replayed: false });
      const provisional = await find();
      const final = {
        ...start,
        ordinal: 2,
        data: { callId: start.data.callId, tool: start.data.tool, arguments: args },
      };
      await expect(commit(final)).resolves.toMatchObject({ throughOrdinal: 2, replayed: false });
      expect(await find()).toEqual({ ...provisional, arguments: args, provisional: false });
      const cards = await database
        .selectFrom("transcriptItems")
        .select("id")
        .where("toolCallId", "=", provisional.id)
        .execute();
      expect(cards).toEqual([{ id: `tool:${provisional.id}` }]);
      await expect(commit(start)).resolves.toMatchObject({ throughOrdinal: 2, replayed: true });
      await expect(
        commit({ ...final, data: { ...final.data, arguments: { file_path: "changed.txt" } } }),
      ).rejects.toMatchObject({ code: "conflict" });
    });
    it.for(["tool.started", "assistant.message"] as const)(
      "commits and replays %s containing NUL as U+FFFD",
      async (type, { storeFixture }) => {
        const { database } = storeFixture;
        const { base, commit } = await runningFixture(
          storeFixture,
          `nul-${type.replaceAll(".", "-")}`,
        );
        const messageId = createId("message");
        const event =
          type === "tool.started"
            ? pendingEvent({
                ...base,
                data: {
                  arguments: createToolArguments({
                    command: "a\u0000b",
                  }),
                  callId: "call-nul",
                  tool: {
                    name: "exec_command",
                    namespace: "functions",
                  },
                },
                ordinal: 1,
                type,
              })
            : pendingEvent({
                ...base,
                data: {
                  content: [
                    {
                      text: "a\u0000b",
                      type: "text",
                    },
                  ],
                  messageId,
                },
                ordinal: 1,
                type,
              });
        const committed = await commit(event);
        expect(committed).toMatchObject({ throughOrdinal: 1, replayed: false });
        const replacement = createToolOutput("a\u0000b").text;
        expect(replacement).toBe("a\uFFFDb");
        if (event.type === "tool.started") {
          expect(await storedCall(storeFixture, base.runId, event.data.callId)).toMatchObject({
            arguments: { command: replacement },
          });
        }
        if (type === "assistant.message") {
          expect(
            await database
              .selectFrom("messages")
              .select("content")
              .where("id", "=", messageId)
              .executeTakeFirstOrThrow(),
          ).toEqual({
            content: [
              {
                text: replacement,
                type: "text",
              },
            ],
          });
        }
        const replayed = await commit(event);
        expect(replayed.replayed).toBe(true);
        expect(replayed.throughOrdinal).toBe(committed.throughOrdinal);
      },
    );
  });
  it("stores the Host's subject of an integration call, and keeps a replay a replay", async ({
    storeFixture,
  }) => {
    const { createRunFixture, store, database } = storeFixture;
    const fixture = await createRunFixture("integration-call-subject");
    const work = await store.enqueueThreadInput({
      content: [
        {
          text: "Open the Opensteer workspace in Slack",
          type: "text",
        },
      ],
      idempotencyKey: "integration-call-subject-input",
      policy: "queue",
      requestedBy: fixture.userId,
      source: {
        kind: "human",
      },
      threadId: fixture.thread.id,
    });
    if (!work.command || !work.run) throw new Error("Expected a Run");
    await store.claimCommand(work.command.id, "integration-call-subject-dispatcher");
    const runnerBootId = "boot-integration-call-subject";
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: fixture.harnessInstance.id,
      leaseTokenHash: "integration-call-subject-lease",
      runnerBootId,
      runnerId: fixture.runnerId,
      runId: work.run.id,
      threadId: fixture.thread.id,
    });
    const base = {
      bindingGeneration: binding.bindingGeneration,
      environmentId: fixture.environmentId,
      runId: work.run.id,
      threadId: fixture.thread.id,
    };
    await commitRunnerEvent(store.database, threadPathLinks, {
      environmentId: fixture.environmentId,
      event: pendingEvent({
        ...base,
        data: {
          status: "running",
        },
        ordinal: 0,
        type: "run.started",
      }),
      runnerBootId,
      runnerId: fixture.runnerId,
    });
    const subject = {
      account: "Slack on Alex's Mac",
      computerApp: {
        app: "Slack",
        bundleId: "com.tinyspeck.slackmacgap",
        computer: "Alex's MacBook Pro",
        runnerId: DeviceIdSchema.parse(fixture.runnerId),
      },
      effect: "write" as const,
      integration: "Computer use",
      operation: {
        name: "act",
        title: "Act",
      },
    };
    const reported = {
      arguments: {
        arguments: {
          actions: [],
        },
        toolRef: "igr_x.itl_y.digest",
      },
      callId: "call-act",
      tool: {
        name: "plugin_call",
        namespace: "opensteer",
      },
    };
    // A Runner cannot name the subject itself; its copy is dropped at the
    // boundary and the Host's stands.
    const forged = {
      ...subject,
      account: "Someone else's account",
      computerApp: null,
    };
    const started = pendingEvent({
      ...base,
      data: {
        ...reported,
        integration: forged,
      } as never,
      ordinal: 1,
      type: "tool.started",
    });
    const commit = (integration?: typeof subject) =>
      commitRunnerEvent(store.database, threadPathLinks, {
        environmentId: fixture.environmentId,
        event: started,
        ...(integration
          ? {
              integration,
            }
          : {}),
        runnerBootId,
        runnerId: fixture.runnerId,
      });
    const committed = await commit(subject);
    expect(committed.replayed).toBe(false);
    const tool = () =>
      database
        .selectFrom("toolCalls")
        .select(["callId", "arguments", "tool", "integration"])
        .where("runId", "=", base.runId)
        .where("callId", "=", reported.callId)
        .executeTakeFirstOrThrow();
    await expect(tool()).resolves.toEqual({ ...reported, integration: subject });
    // The same Runner payload again is a replay whatever the Host resolves
    // this time — a subject that is gone, or one that has changed — and it
    // answers with the event as it was first recorded.
    for (const replayed of [
      await commit(),
      await commit({
        ...subject,
        account: "Renamed",
      }),
    ]) {
      expect(replayed.replayed).toBe(true);
      expect(replayed.throughOrdinal).toBe(committed.throughOrdinal);
    }
    await expect(
      commitRunnerEvent(store.database, threadPathLinks, {
        environmentId: fixture.environmentId,
        // The same ordinal and moment, with different content.
        event: {
          ...started,
          data: {
            ...reported,
            callId: "call-other",
          },
        } as PendingAgentEvent,
        integration: subject,
        runnerBootId,
        runnerId: fixture.runnerId,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
    });

    // Without a subject the Runner's copy is still not stored.
    const unnamed = await commitRunnerEvent(store.database, threadPathLinks, {
      environmentId: fixture.environmentId,
      event: pendingEvent({
        ...base,
        data: {
          ...reported,
          callId: "call-unnamed",
          integration: forged,
        } as never,
        ordinal: 2,
        type: "tool.started",
      }),
      runnerBootId,
      runnerId: fixture.runnerId,
    });
    expect(unnamed).toMatchObject({ throughOrdinal: 2, replayed: false });
    await expect(
      database
        .selectFrom("toolCalls")
        .select("integration")
        .where("runId", "=", base.runId)
        .where("callId", "=", "call-unnamed")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ integration: null });
    await expect(
      commitRunnerEvent(store.database, threadPathLinks, {
        environmentId: fixture.environmentId,
        event: pendingEvent({
          ...base,
          data: {
            callId: "call-unnamed",
            isError: false,
            output: {
              text: "done",
            },
          },
          ordinal: 3,
          type: "tool.completed",
        }),
        integration: subject,
        runnerBootId,
        runnerId: fixture.runnerId,
      }),
    ).rejects.toThrow("Only tool.started reports can have an integration subject");

    // An integration subject alone neither invents a durable tab nor a recent place;
    // only an explicit tab entry recovers one.
    await commitRunnerEvent(store.database, threadPathLinks, {
      environmentId: fixture.environmentId,
      event: pendingEvent({
        ...base,
        data: {
          callId: "call-act",
          isError: false,
          output: {
            text: "done",
          },
        },
        ordinal: 3,
        type: "tool.completed",
      }),
      runnerBootId,
      runnerId: fixture.runnerId,
    });
    await expect(
      database
        .selectFrom("runs")
        .select("latestPlace")
        .where("id", "=", work.run.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ latestPlace: null });
    expect(await database.selectFrom("personalTabs").select("id").execute()).toEqual([]);
    const place = { tabId: TabIdSchema.parse("slack-window-tab"), title: "Slack", site: null };
    await store.recordRunTabPlace({
      runId: work.run.id,
      bindingGeneration: binding.bindingGeneration,
      data: place,
    });
    await expect(
      database
        .selectFrom("runs")
        .select("latestPlace")
        .where("id", "=", work.run.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ latestPlace: place });
  });
  it("names a Run's requester only for its own Thread", async ({ storeFixture }) => {
    const { createRunFixture, store } = storeFixture;
    const fixture = await createRunFixture("run-requester");
    const work = await store.enqueueThreadInput({
      content: [
        {
          text: "Whose is this?",
          type: "text",
        },
      ],
      idempotencyKey: "run-requester-input",
      policy: "queue",
      requestedBy: fixture.userId,
      source: {
        kind: "human",
      },
      threadId: fixture.thread.id,
    });
    if (!work.run) throw new Error("Expected a Run");
    const scope = {
      runId: work.run.id,
      threadId: fixture.thread.id,
    };
    await expect(store.runRequester(scope)).resolves.toBe(fixture.userId);
    await expect(
      store.runRequester({
        ...scope,
        threadId: createId("thread"),
      }),
    ).resolves.toBeNull();
    await expect(
      store.runRequester({
        ...scope,
        runId: createId("run"),
      }),
    ).resolves.toBeNull();
  });
  it("claims one fixed FIFO batch and preserves typed Host-authored attribution", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, database, store } = storeFixture;
    const fixture = await createRunFixture("thread-input-batch");
    const source = await enqueueHumanTrigger({
      content: [
        {
          text: "Coordinate the batch",
          type: "text",
        },
      ],
      idempotencyKey: "thread-input-batch-source",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    await database
      .updateTable("runs")
      .set({
        status: "running",
      })
      .where("id", "=", source.run.id)
      .executeTakeFirstOrThrow();
    const { thread: target } = await store.createThread({
      createdBy: fixture.userId,
      environmentId: fixture.environmentId,
      harnessInstanceId: fixture.harnessInstance.id,
      idempotencyKey: "thread-input-batch-target",
      modelSelection: testModelSelection,
      title: "Batch target",
    });
    const agentInput = (
      idempotencyKey: string,
      text: string,
      policy: "report" | "queue" | "steer",
    ) =>
      store.enqueueThreadInput({
        content: [
          {
            text,
            type: "text",
          },
        ],
        idempotencyKey,
        policy,
        requestedBy: fixture.userId,
        source: {
          kind: "agent",
          runId: source.run.id,
        },
        threadId: target.id,
      });
    const first = await agentInput("thread-input-batch-1", "FIRST", "report");
    const second = await agentInput("thread-input-batch-2", "SECOND", "report");
    const wake = await agentInput("thread-input-batch-3", "THIRD", "queue");
    const incompatible = await store.enqueueThreadInput({
      content: [
        {
          text: "FOURTH",
          type: "text",
        },
      ],
      idempotencyKey: "thread-input-batch-4",
      policy: "queue",
      requestedBy: fixture.userId,
      source: {
        kind: "human",
      },
      threadId: target.id,
    });
    expect(first.disposition).toBe("pending");
    expect(second.disposition).toBe("pending");
    expect(wake).toMatchObject({
      command: {
        type: "run.execute",
      },
      disposition: "run-queued",
      run: {
        seedInputId: wake.message.id,
      },
    });
    expect(incompatible).toMatchObject({
      command: null,
      disposition: "pending",
      run: null,
    });
    if (!wake.command) throw new Error("Expected batch dispatch Command");
    await store.claimCommand(wake.command.id, "thread-input-batch-dispatcher");
    const context = await store.loadRunDispatchContext(wake.command.id);
    expect(context.inputs.map(({ id }) => id)).toEqual([wake.message.id]);
    expect(context.reports.messages.map(({ id }) => id)).toEqual([
      first.message.id,
      second.message.id,
    ]);
    expect(
      context.reports.messages.map(({ author }) => ({
        kind: author.kind,
        runId: author.kind === "agent" ? author.runId : null,
      })),
    ).toEqual([
      {
        kind: "agent",
        runId: source.run.id,
      },
      {
        kind: "agent",
        runId: source.run.id,
      },
    ]);
    await expect(
      database
        .selectFrom("threadInputs")
        .select(["runId", "state"])
        .where("messageId", "=", incompatible.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      runId: null,
      state: "pending",
    });
  });
  it("leaves queued inputs pending while active work continues", async ({ storeFixture }) => {
    const { startRunFixture, store } = storeFixture;
    const started = await startRunFixture("thread-input-steer-fifo");
    const collaboratorId = started.userId;

    const earlier = await store.enqueueThreadInput({
      content: [
        {
          text: "Earlier collaborator input",
          type: "text",
        },
      ],
      idempotencyKey: "thread-input-steer-fifo-earlier",
      policy: "report",
      requestedBy: collaboratorId,
      source: {
        kind: "human",
      },
      threadId: started.thread.id,
    });
    expect(earlier).toMatchObject({
      command: null,
      disposition: "pending",
    });
    const later = await store.enqueueThreadInput({
      content: [
        {
          text: "Later owner input",
          type: "text",
        },
      ],
      idempotencyKey: "thread-input-steer-fifo-later",
      policy: "queue",
      requestedBy: started.userId,
      source: {
        kind: "human",
      },
      threadId: started.thread.id,
    });
    expect(later).toMatchObject({
      command: null,
      disposition: "pending",
      input: {
        runId: null,
        state: "pending",
      },
      message: {
        runId: null,
      },
    });
    const wake = await store.enqueueThreadInput({
      content: [
        {
          text: "Wake the oldest authority",
          type: "text",
        },
      ],
      idempotencyKey: "thread-input-steer-fifo-wake",
      policy: "queue",
      requestedBy: started.userId,
      source: {
        kind: "human",
      },
      threadId: started.thread.id,
    });
    expect(wake).toMatchObject({
      command: null,
      disposition: "pending",
      run: null,
    });
  });
  it("retries run.execute with the same already-claimed fixed batch", async ({ storeFixture }) => {
    const { createRunFixture, enqueueHumanTrigger, database, store } = storeFixture;
    const fixture = await createRunFixture("thread-input-fixed-batch-retry");
    const source = await enqueueHumanTrigger({
      content: [
        {
          text: "Create a shared input chain",
          type: "text",
        },
      ],
      idempotencyKey: "thread-input-fixed-batch-retry-source",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    await database
      .updateTable("runs")
      .set({
        status: "running",
      })
      .where("id", "=", source.run.id)
      .executeTakeFirstOrThrow();
    const { thread: target } = await store.createThread({
      createdBy: fixture.userId,
      environmentId: fixture.environmentId,
      harnessInstanceId: fixture.harnessInstance.id,
      idempotencyKey: "thread-input-fixed-batch-retry-target",
      modelSelection: testModelSelection,
      title: "Fixed batch retry target",
    });
    const first = await store.enqueueThreadInput({
      content: [
        {
          text: "First fixed input",
          type: "text",
        },
      ],
      idempotencyKey: "thread-input-fixed-batch-retry-first",
      policy: "report",
      requestedBy: fixture.userId,
      source: {
        kind: "agent",
        runId: source.run.id,
      },
      threadId: target.id,
    });
    const wake = await store.enqueueThreadInput({
      content: [
        {
          text: "Second fixed input",
          type: "text",
        },
      ],
      idempotencyKey: "thread-input-fixed-batch-retry-wake",
      policy: "queue",
      requestedBy: fixture.userId,
      source: {
        kind: "agent",
        runId: source.run.id,
      },
      threadId: target.id,
    });
    if (!wake.command) throw new Error("Expected fixed batch Run command");
    await store.claimCommand(wake.command.id, "fixed-batch-first-dispatcher");
    const firstContext = await store.loadRunDispatchContext(wake.command.id);
    expect(firstContext.inputs.map(({ id }) => id)).toEqual([wake.message.id]);
    expect(firstContext.reports.messages.map(({ id }) => id)).toEqual([first.message.id]);
    await store.retryCommand(wake.command.id, new Error("Runner unavailable before dispatch"));
    await store.claimCommand(wake.command.id, "fixed-batch-second-dispatcher");
    const retriedContext = await store.loadRunDispatchContext(wake.command.id);
    expect(retriedContext.inputs.map(({ id }) => id)).toEqual(
      firstContext.inputs.map(({ id }) => id),
    );
  });
  it("delivers a steer only after the Runner acknowledges its exact Message", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, database } = storeFixture;
    const started = await startRunFixture("thread-steer-delivered");
    const steered = await store.enqueueThreadInput({
      content: [
        {
          text: "Use the updated constraint",
          type: "text",
        },
      ],
      idempotencyKey: "thread-steer-delivered",
      policy: "steer",
      requestedBy: started.userId,
      source: {
        kind: "human",
      },
      threadId: started.thread.id,
    });
    expect(steered).toMatchObject({
      command: {
        runId: started.run.id,
        type: "run.steer",
      },
      disposition: "steering",
      input: {
        runId: started.run.id,
        state: "claimed",
      },
      message: {
        runId: started.run.id,
      },
      run: {
        id: started.run.id,
      },
    });
    expect(steered.input.causalChainId).toBe(started.run.causalChainId);
    await expect(
      database
        .selectFrom("causalChains")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("rootMessageId", "=", steered.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      count: "0",
    });
    if (!steered.command) throw new Error("Expected steer Command");
    await store.claimCommand(steered.command.id, "thread-steer-delivered-dispatcher");
    const delivered = await commitRunnerEvent(store.database, threadPathLinks, {
      environmentId: started.environmentId,
      event: pendingEvent({
        bindingGeneration: started.bindingGeneration,
        data: {
          messageId: steered.message.id,
        },
        environmentId: started.environmentId,
        ordinal: 1,
        runId: started.run.id,
        threadId: started.thread.id,
        type: "message.injected",
      }),
      runnerBootId: started.runnerBootId,
      runnerId: started.runnerId,
    });
    expect(delivered).toMatchObject({ throughOrdinal: 1, replayed: false });
    await expect(
      store.markSteerUnknown(steered.command.id, "Late ambiguous transport result"),
    ).resolves.toBeUndefined();
    await expect(
      database
        .selectFrom("threadInputs")
        .select(["deliveredAt", "runId", "state"])
        .where("messageId", "=", steered.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      runId: started.run.id,
      state: "delivered",
    });
    await expect(
      database
        .selectFrom("commands")
        .select("status")
        .where("id", "=", steered.command.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      status: "succeeded",
    });
  });
  it("terminally cancels a proven-refused strict steer", async ({ storeFixture }) => {
    const { startRunFixture, database, store } = storeFixture;
    const refusedRun = await startRunFixture("thread-steer-refused");
    await database
      .updateTable("causalChains")
      .set({
        usedAutonomousRuns: sql`max_autonomous_runs`,
      })
      .where("id", "=", refusedRun.run.causalChainId)
      .executeTakeFirstOrThrow();
    const refused = await store.enqueueThreadInput({
      content: [
        {
          text: "Retry this after refusal",
          type: "text",
        },
      ],
      idempotencyKey: "thread-steer-refused",
      policy: "steer",
      requestedBy: refusedRun.userId,
      source: {
        kind: "human",
      },
      threadId: refusedRun.thread.id,
    });
    if (!refused.command) throw new Error("Expected refused steer Command");
    expect(refused.input.causalChainId).toBe(refusedRun.run.causalChainId);
    await store.refuseSteer(refused.command.id, "Harness refused steer");
    const refusedInput = await database
      .selectFrom("threadInputs")
      .select(["causalChainId", "runId", "state", "steerCommandId"])
      .where("messageId", "=", refused.message.id)
      .executeTakeFirstOrThrow();
    expect(refusedInput).toMatchObject({
      runId: refusedRun.run.id,
      state: "cancelled",
      steerCommandId: refused.command.id,
    });
    expect(refusedInput.causalChainId).toBe(refusedRun.run.causalChainId);
    expect(
      await database
        .selectFrom("runs")
        .select(["runOrdinal", "status"])
        .where("threadId", "=", refusedRun.thread.id)
        .where("status", "in", ["running", "queued"])
        .orderBy("runOrdinal")
        .execute(),
    ).toEqual([
      {
        runOrdinal: 0,
        status: "running",
      },
    ]);
    await commitRunnerEvent(store.database, threadPathLinks, {
      environmentId: refusedRun.environmentId,
      event: pendingEvent({
        bindingGeneration: refusedRun.bindingGeneration,
        data: {
          status: "completed",
        },
        environmentId: refusedRun.environmentId,
        ordinal: 1,
        runId: refusedRun.run.id,
        threadId: refusedRun.thread.id,
        type: "run.completed",
      }),
      runnerBootId: refusedRun.runnerBootId,
      runnerId: refusedRun.runnerId,
    });
    await expect(
      database
        .selectFrom("threadInputs")
        .select(["cancelReason", "state"])
        .where("messageId", "=", refused.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      cancelReason: "steer-refused",
      state: "cancelled",
    });
  });
  it("returns a strict steer refused for a pending Request to the inbox and starts its next Run", async ({
    storeFixture,
  }) => {
    const { startRunFixture, database, store } = storeFixture;
    const started = await startRunFixture("parked-strict-steer");
    const { thread: parent } = await store.createThread({
      createdBy: started.userId,
      environmentId: started.environmentId,
      harnessInstanceId: started.harnessInstance.id,
      idempotencyKey: "parked-strict-parent",
      modelSelection: testModelSelection,
      title: "Parent",
    });
    const parentTurn = await store.enqueueThreadInput({
      content: [
        {
          text: "Coordinate the child",
          type: "text",
        },
      ],
      idempotencyKey: "parked-strict-parent-turn",
      policy: "queue",
      requestedBy: started.userId,
      source: {
        kind: "human",
      },
      threadId: parent.id,
    });
    if (!parentTurn.run) throw new Error("Expected a parent Run");
    await database
      .updateTable("runs")
      .set({
        status: "running",
      })
      .where("id", "=", parentTurn.run.id)
      .execute();
    const steered = await store.enqueueThreadInput({
      content: [
        {
          text: "Use my work account",
          type: "text",
        },
      ],
      idempotencyKey: "parked-strict-steer",
      policy: "steer",
      requestedBy: started.userId,
      source: {
        kind: "agent",
        runId: parentTurn.run.id,
      },
      threadId: started.thread.id,
    });
    expect(steered.disposition).toBe("steering");
    if (!steered.command) throw new Error("Expected a strict steer Command");
    await store.refuseSteer(
      steered.command.id,
      "Run is stopping for a pending Request",
      "request-pending",
    );
    expect(
      await database
        .selectFrom("threadInputs")
        .select(["state", "runId"])
        .where("messageId", "=", steered.message.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      state: "pending",
      runId: null,
    });
    await commitRunnerEvent(store.database, threadPathLinks, {
      environmentId: started.environmentId,
      runnerBootId: started.runnerBootId,
      runnerId: started.runnerId,
      event: pendingEvent({
        bindingGeneration: started.bindingGeneration,
        environmentId: started.environmentId,
        ordinal: 1,
        runId: started.run.id,
        threadId: started.thread.id,
        type: "run.completed",
        data: {
          status: "completed",
        },
      }),
    });
    const next = await database
      .selectFrom("runs")
      .select(["id", "seedInputId", "status"])
      .where("threadId", "=", started.thread.id)
      .where("id", "!=", started.run.id)
      .executeTakeFirstOrThrow();
    expect(next).toMatchObject({
      seedInputId: steered.message.id,
      status: "queued",
    });
  });
  it("keeps an ambiguous steer attached without retrying it", async ({ storeFixture }) => {
    const { startRunFixture, store, database } = storeFixture;
    const unknownRun = await startRunFixture("thread-steer-unknown");
    const unknown = await store.enqueueThreadInput({
      content: [
        {
          text: "Delivery could not be confirmed",
          type: "text",
        },
      ],
      idempotencyKey: "thread-steer-unknown",
      policy: "steer",
      requestedBy: unknownRun.userId,
      source: {
        kind: "human",
      },
      threadId: unknownRun.thread.id,
    });
    if (!unknown.command) throw new Error("Expected unknown steer Command");
    await store.claimCommand(unknown.command.id, "thread-steer-unknown-dispatcher");
    await store.markSteerUnknown(unknown.command.id, "Runner disconnected after dispatch");
    await expect(
      database
        .selectFrom("threadInputs")
        .select(["runId", "state", "steerCommandId"])
        .where("messageId", "=", unknown.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      runId: unknownRun.run.id,
      state: "unknown",
      steerCommandId: unknown.command.id,
    });
    const lateProof = await commitRunnerEvent(store.database, threadPathLinks, {
      environmentId: unknownRun.environmentId,
      event: pendingEvent({
        bindingGeneration: unknownRun.bindingGeneration,
        data: {
          messageId: unknown.message.id,
        },
        environmentId: unknownRun.environmentId,
        ordinal: 1,
        runId: unknownRun.run.id,
        threadId: unknownRun.thread.id,
        type: "message.injected",
      }),
      runnerBootId: unknownRun.runnerBootId,
      runnerId: unknownRun.runnerId,
    });
    expect(lateProof).toMatchObject({ throughOrdinal: 1, replayed: false });
    await expect(
      database
        .selectFrom("threadInputs")
        .select(["state", "deliveredAt"])
        .where("messageId", "=", unknown.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      state: "delivered",
    });
    await expect(
      database
        .selectFrom("commands")
        .select("status")
        .where("id", "=", unknown.command.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      status: "succeeded",
    });
  });

  it("preserves unknown steer command status when the Run finishes without delivery proof (T1)", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, database } = storeFixture;
    const activeRun = await startRunFixture("thread-steer-unknown-finish");
    const unknown = await store.enqueueThreadInput({
      content: [{ text: "Delivery remained unknown until finish", type: "text" }],
      idempotencyKey: "thread-steer-unknown-finish",
      policy: "steer",
      requestedBy: activeRun.userId,
      source: { kind: "human" },
      threadId: activeRun.thread.id,
    });
    if (!unknown.command) throw new Error("Expected unknown steer Command");
    await store.claimCommand(unknown.command.id, "thread-steer-unknown-finish-dispatcher");
    await store.markSteerUnknown(unknown.command.id, "Runner disconnected after dispatch");

    const inflight = await store.enqueueThreadInput({
      content: [{ text: "Dispatched steer raced Run completion", type: "text" }],
      idempotencyKey: "thread-steer-dispatched-finish",
      policy: "steer",
      requestedBy: activeRun.userId,
      source: { kind: "human" },
      threadId: activeRun.thread.id,
    });
    if (!inflight.command) throw new Error("Expected dispatched steer Command");
    await store.claimCommand(inflight.command.id, "thread-steer-dispatched-finish-dispatcher");

    const unsent = await store.enqueueThreadInput({
      content: [{ text: "Pending steer was never dispatched", type: "text" }],
      idempotencyKey: "thread-steer-pending-finish",
      policy: "steer",
      requestedBy: activeRun.userId,
      source: { kind: "human" },
      threadId: activeRun.thread.id,
    });
    if (!unsent.command) throw new Error("Expected pending steer Command");

    await commitRunnerEvent(store.database, threadPathLinks, {
      environmentId: activeRun.environmentId,
      event: pendingEvent({
        bindingGeneration: activeRun.bindingGeneration,
        data: { status: "completed" },
        environmentId: activeRun.environmentId,
        ordinal: 1,
        runId: activeRun.run.id,
        threadId: activeRun.thread.id,
        type: "run.completed",
      }),
      runnerBootId: activeRun.runnerBootId,
      runnerId: activeRun.runnerId,
    });

    await expect(
      database
        .selectFrom("commands")
        .select(["status", "lastError"])
        .where("id", "=", unknown.command.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      lastError: { message: "Runner disconnected after dispatch" },
      status: "unknown",
    });
    await expect(
      database
        .selectFrom("commands")
        .select("status")
        .where("id", "=", inflight.command.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "unknown" });
    await expect(
      database
        .selectFrom("commands")
        .select("status")
        .where("id", "=", unsent.command.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "failed" });
    await expect(
      database
        .selectFrom("threadInputs")
        .select(["state"])
        .where("messageId", "=", unknown.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ state: "unknown" });
  });

  it("settles an in-flight strict steer input and command together as unknown on Run finish (X2)", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, database } = storeFixture;
    const activeRun = await startRunFixture("strict-steer-finish-unknown");
    const inflight = await store.enqueueThreadInput({
      content: [{ text: "Strict steer raced Run completion", type: "text" }],
      idempotencyKey: "strict-steer-finish-unknown",
      policy: "steer",
      requestedBy: activeRun.userId,
      source: { kind: "human" },
      threadId: activeRun.thread.id,
    });
    if (!inflight.command) throw new Error("Expected strict steer Command");
    await store.claimCommand(inflight.command.id, "strict-steer-finish-unknown-dispatcher");

    // Finish wins BEFORE markSteerUnknown arrives.
    await commitRunnerEvent(store.database, threadPathLinks, {
      environmentId: activeRun.environmentId,
      event: pendingEvent({
        bindingGeneration: activeRun.bindingGeneration,
        data: { status: "completed" },
        environmentId: activeRun.environmentId,
        ordinal: 1,
        runId: activeRun.run.id,
        threadId: activeRun.thread.id,
        type: "run.completed",
      }),
      runnerBootId: activeRun.runnerBootId,
      runnerId: activeRun.runnerId,
    });

    await expect(
      database
        .selectFrom("threadInputs")
        .select(["state", "cancelReason", "runId"])
        .where("messageId", "=", inflight.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      cancelReason: null,
      runId: activeRun.run.id,
      state: "unknown",
    });
    await expect(
      database
        .selectFrom("commands")
        .select(["status"])
        .where("id", "=", inflight.command.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "unknown" });

    // Late uncertainty report is accepted (not ignored) and keeps the input unknown without requeuing.
    await store.markSteerUnknown(inflight.command.id, "Runner lost contact after dispatch");
    await expect(
      database
        .selectFrom("commands")
        .select(["status", "lastError"])
        .where("id", "=", inflight.command.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      lastError: { message: "Runner lost contact after dispatch" },
      status: "unknown",
    });
    await expect(
      database
        .selectFrom("threadInputs")
        .select(["state", "cancelReason", "runId"])
        .where("messageId", "=", inflight.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      cancelReason: null,
      runId: activeRun.run.id,
      state: "unknown",
    });
  });

  it("does not count terminal unknown steers against active task inbox capacity (X3)", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, database } = storeFixture;
    const activeRun = await startRunFixture("terminal-unknown-capacity");
    const first = await store.enqueueThreadInput({
      content: [{ text: "Real uncertain steer", type: "text" }],
      idempotencyKey: "terminal-unknown-capacity-real",
      policy: "steer",
      requestedBy: activeRun.userId,
      source: { kind: "human" },
      threadId: activeRun.thread.id,
    });
    if (!first.command) throw new Error("Expected steer Command");
    await store.claimCommand(first.command.id, "terminal-unknown-capacity-dispatcher");
    await store.markSteerUnknown(first.command.id, "Delivery could not be confirmed");

    const sampleInput = await database
      .selectFrom("threadInputs")
      .selectAll()
      .where("messageId", "=", first.message.id)
      .executeTakeFirstOrThrow();
    const sampleMessage = await database
      .selectFrom("messages")
      .selectAll()
      .where("id", "=", first.message.id)
      .executeTakeFirstOrThrow();
    const baseSequence = Number(sampleMessage.sequence);
    const baseRank = Number(sampleInput.queueRank);
    const now = new Date();
    const seededMessages = Array.from({ length: 99 }, (_, index) => ({
      actorPrincipalId: sampleMessage.actorPrincipalId,
      author: jsonValue(sampleMessage.author),
      content: jsonValue([{ text: `Seeded uncertain steer ${index + 1}`, type: "text" }]),
      createdAt: now,
      id: createId("message"),
      kind: sampleMessage.kind,
      runId: activeRun.run.id,
      sequence: baseSequence + index + 1,
      threadId: activeRun.thread.id,
    }));
    await database.insertInto("messages").values(seededMessages).execute();
    await database
      .updateTable("threads")
      .set({ nextMessageSequence: String(baseSequence + 100) })
      .where("id", "=", activeRun.thread.id)
      .execute();
    await database
      .insertInto("threadInputs")
      .values(
        seededMessages.map((message, index) => ({
          actorPrincipalId: sampleInput.actorPrincipalId,
          authoritySource: jsonValue(sampleInput.authoritySource),
          cancelReason: null,
          causalChainId: sampleInput.causalChainId,
          createdAt: now,
          deliveredAt: null,
          idempotencyKey: `terminal-unknown-capacity-seed-${index + 1}`,
          messageId: message.id,
          policy: "steer" as const,
          queueRank: baseRank + index + 1,
          replyTarget: null,
          requestFingerprint: `fp-seed-${index + 1}`,
          requestedBy: activeRun.userId,
          runId: activeRun.run.id,
          state: "unknown" as const,
          steerCommandId: first.command!.id,
          threadId: activeRun.thread.id,
          updatedAt: now,
        })),
      )
      .execute();

    // Complete the Run so all 100 unknown steers become terminal delivery history.
    await commitRunnerEvent(store.database, threadPathLinks, {
      environmentId: activeRun.environmentId,
      event: pendingEvent({
        bindingGeneration: activeRun.bindingGeneration,
        data: { status: "completed" },
        environmentId: activeRun.environmentId,
        ordinal: 1,
        runId: activeRun.run.id,
        threadId: activeRun.thread.id,
        type: "run.completed",
      }),
      runnerBootId: activeRun.runnerBootId,
      runnerId: activeRun.runnerId,
    });

    // A normal follow-up send must succeed instead of failing with resource_exhausted.
    const next = await store.enqueueThreadInput({
      content: [{ text: "Fresh message after terminal unknown steers", type: "text" }],
      idempotencyKey: "terminal-unknown-capacity-next",
      policy: "queue",
      requestedBy: activeRun.userId,
      source: { kind: "human" },
      threadId: activeRun.thread.id,
    });
    expect(next.disposition).toBe("run-queued");
    expect(next.run?.seedInputId).toBe(next.message.id);
    const retainedUnknown = await database
      .selectFrom("threadInputs")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("threadId", "=", activeRun.thread.id)
      .where("state", "=", "unknown")
      .executeTakeFirstOrThrow();
    expect(Number(retainedUnknown.count)).toBe(100);
  });

  it("does not count live-Run unknown inputs against inbox capacity and checks capacity without joining runs (Y3)", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, database } = storeFixture;
    const activeRun = await startRunFixture("live-unknown-capacity");
    const first = await store.enqueueThreadInput({
      content: [{ text: "Live uncertain steer", type: "text" }],
      idempotencyKey: "live-unknown-capacity-real",
      policy: "steer",
      requestedBy: activeRun.userId,
      source: { kind: "human" },
      threadId: activeRun.thread.id,
    });
    if (!first.command) throw new Error("Expected steer Command");
    await store.claimCommand(first.command.id, "live-unknown-capacity-dispatcher");
    await store.markSteerUnknown(first.command.id, "Delivery could not be confirmed");

    const sampleInput = await database
      .selectFrom("threadInputs")
      .selectAll()
      .where("messageId", "=", first.message.id)
      .executeTakeFirstOrThrow();
    const sampleMessage = await database
      .selectFrom("messages")
      .selectAll()
      .where("id", "=", first.message.id)
      .executeTakeFirstOrThrow();
    const baseSequence = Number(sampleMessage.sequence);
    const baseRank = Number(sampleInput.queueRank);
    const now = new Date();
    // Seed 99 pending inputs alongside the LIVE Run's unknown input (100 rows total).
    // Because an unknown input is delivery history (never dispatched again), the 100th
    // active slot is still free and a normal send must succeed.
    const seededMessages = Array.from({ length: 99 }, (_, index) => ({
      actorPrincipalId: sampleMessage.actorPrincipalId,
      author: jsonValue(sampleMessage.author),
      content: jsonValue([{ text: `Queued input ${index + 1}`, type: "text" }]),
      createdAt: now,
      id: createId("message"),
      kind: sampleMessage.kind,
      runId: null,
      sequence: baseSequence + index + 1,
      threadId: activeRun.thread.id,
    }));
    await database.insertInto("messages").values(seededMessages).execute();
    await database
      .updateTable("threads")
      .set({ nextMessageSequence: String(baseSequence + 100) })
      .where("id", "=", activeRun.thread.id)
      .execute();
    await database
      .insertInto("threadInputs")
      .values(
        seededMessages.map((message, index) => ({
          actorPrincipalId: sampleInput.actorPrincipalId,
          authoritySource: jsonValue(sampleInput.authoritySource),
          cancelReason: null,
          causalChainId: sampleInput.causalChainId,
          createdAt: now,
          deliveredAt: null,
          idempotencyKey: `live-unknown-capacity-seed-${index + 1}`,
          messageId: message.id,
          policy: "queue" as const,
          queueRank: baseRank + index + 1,
          replyTarget: null,
          requestFingerprint: `fp-live-seed-${index + 1}`,
          requestedBy: activeRun.userId,
          runId: null,
          state: "pending" as const,
          steerCommandId: null,
          threadId: activeRun.thread.id,
          updatedAt: now,
        })),
      )
      .execute();

    // Capture the capacity SQL issued on an ordinary send: no join on `runs`.
    const { default: pg } = await import("pg");
    const recordedSql: string[] = [];
    const originalQuery = pg.Client.prototype.query;
    const spy = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (
      this: InstanceType<typeof pg.Client>,
      ...args: unknown[]
    ) {
      const firstArg = args[0];
      const text =
        typeof firstArg === "string"
          ? firstArg
          : firstArg &&
              typeof firstArg === "object" &&
              "text" in firstArg &&
              typeof firstArg.text === "string"
            ? firstArg.text
            : "";
      if (text) recordedSql.push(text);
      return Reflect.apply(originalQuery, this, args);
    });
    try {
      const accepted = await store.enqueueThreadInput({
        content: [{ text: "100th queued input while live Run has an unknown steer", type: "text" }],
        idempotencyKey: "live-unknown-capacity-next",
        policy: "queue",
        requestedBy: activeRun.userId,
        source: { kind: "human" },
        threadId: activeRun.thread.id,
      });
      expect(accepted.disposition).toBe("pending");
    } finally {
      spy.mockRestore();
    }

    const capacitySql = recordedSql.filter((sqlText) =>
      sqlText.includes("octet_length(messages.content::text)"),
    );
    expect(capacitySql).toHaveLength(1);
    expect(capacitySql[0]).not.toMatch(/left join "runs"/iu);
    expect(capacitySql[0]).not.toMatch(/"runs"\."status"/iu);
  });

  it("counts unknown passive reports toward the report cap without joining runs (Z3)", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, database } = storeFixture;
    const base = await startRunFixture("report-unknown-capacity");
    const firstReport = await store.enqueueThreadInput({
      content: [{ text: "Passive report 1", type: "text" }],
      idempotencyKey: "report-unknown-capacity-1",
      policy: "report",
      requestedBy: base.userId,
      source: { kind: "human" },
      threadId: base.thread.id,
    });
    const sampleInput = await database
      .selectFrom("threadInputs")
      .selectAll()
      .where("messageId", "=", firstReport.message.id)
      .executeTakeFirstOrThrow();
    const sampleMessage = await database
      .selectFrom("messages")
      .selectAll()
      .where("id", "=", firstReport.message.id)
      .executeTakeFirstOrThrow();
    await database
      .updateTable("threadInputs")
      .set({ state: "unknown" })
      .where("messageId", "=", firstReport.message.id)
      .execute();

    // Seed 999 more unknown passive reports (1,000 total — at `threadReportMaxPendingEntries`).
    // Because unknown passive reports are claimed again by a later Run, they must count against
    // the report backlog cap without joining `runs`.
    const baseSequence = Number(sampleMessage.sequence);
    const baseRank = Number(sampleInput.queueRank);
    const now = new Date();
    const seededMessages = Array.from({ length: 999 }, (_, index) => ({
      actorPrincipalId: sampleMessage.actorPrincipalId,
      author: jsonValue(sampleMessage.author),
      content: jsonValue([{ text: `Passive report ${index + 2}`, type: "text" }]),
      createdAt: now,
      id: createId("message"),
      kind: sampleMessage.kind,
      runId: null,
      sequence: baseSequence + index + 1,
      threadId: base.thread.id,
    }));
    await database.insertInto("messages").values(seededMessages).execute();
    await database
      .updateTable("threads")
      .set({ nextMessageSequence: String(baseSequence + 1_000) })
      .where("id", "=", base.thread.id)
      .execute();
    await database
      .insertInto("threadInputs")
      .values(
        seededMessages.map((message, index) => ({
          actorPrincipalId: sampleInput.actorPrincipalId,
          authoritySource: jsonValue(sampleInput.authoritySource),
          cancelReason: null,
          causalChainId: sampleInput.causalChainId,
          createdAt: now,
          deliveredAt: null,
          idempotencyKey: `report-unknown-capacity-seed-${index + 2}`,
          messageId: message.id,
          policy: "report" as const,
          queueRank: baseRank + index + 1,
          replyTarget: null,
          requestFingerprint: `fp-report-unknown-seed-${index + 2}`,
          requestedBy: base.userId,
          runId: null,
          state: "unknown" as const,
          steerCommandId: null,
          threadId: base.thread.id,
          updatedAt: now,
        })),
      )
      .execute();

    const { default: pg } = await import("pg");
    const recordedSql: string[] = [];
    const originalQuery = pg.Client.prototype.query;
    const spy = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (
      this: InstanceType<typeof pg.Client>,
      ...args: unknown[]
    ) {
      const firstArg = args[0];
      const text =
        typeof firstArg === "string"
          ? firstArg
          : firstArg &&
              typeof firstArg === "object" &&
              "text" in firstArg &&
              typeof firstArg.text === "string"
            ? firstArg.text
            : "";
      if (text) recordedSql.push(text);
      return Reflect.apply(originalQuery, this, args);
    });
    try {
      await expect(
        store.enqueueThreadInput({
          content: [{ text: "1001st passive report", type: "text" }],
          idempotencyKey: "report-unknown-capacity-1001",
          policy: "report",
          requestedBy: base.userId,
          source: { kind: "human" },
          threadId: base.thread.id,
        }),
      ).rejects.toMatchObject({
        code: "resource_exhausted",
        message: "A task can hold at most 1000 undelivered reports",
      });
    } finally {
      spy.mockRestore();
    }

    const capacitySql = recordedSql.filter((sqlText) =>
      sqlText.includes("octet_length(messages.content::text)"),
    );
    expect(capacitySql).toHaveLength(1);
    expect(capacitySql[0]).not.toMatch(/left join "runs"/iu);
    expect(capacitySql[0]).not.toMatch(/"runs"\."status"/iu);
  });

  it("routes steers on a Run held by an Antigravity Runner through restart to a definite delivered outcome (X1)", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, database } = storeFixture;
    const base = await startRunFixture("antigravity-restart-base");
    const now = new Date();
    const antigravityDriverKind = HarnessIdSchema.parse("antigravity");
    const antigravityInstanceId = createId("harnessInstance");
    await database
      .insertInto("harnessInstances")
      .values({
        config: jsonValue({}),
        createdAt: now,
        driverKind: antigravityDriverKind,
        enabled: true,
        environmentId: base.environmentId,
        id: antigravityInstanceId,
        isDefault: false,
        name: "Antigravity",
        removedAt: null,
        runtimeRevision: 1,
        sourceId: "google",
        stateKind: "isolated",
        updatedAt: now,
      })
      .execute();
    await database
      .updateTable("runners")
      .set({
        capabilities: jsonValue(["attempts-v1"]),
        moduleDescriptors: jsonValue(
          RunnerModulesSchema.parse({
            agents: {
              environmentIds: [base.environmentId],
              harnessDrivers: [
                {
                  accessModes: ["approval-required", "auto-accept-edits", "auto", "full-access"],
                  driverKind: antigravityDriverKind,
                  mcpImageContent: true,
                  readiness: "runtime-check",
                  sources: [
                    {
                      fields: [],
                      kind: "first-party",
                      label: "Google",
                      quota: "windows",
                      sourceId: "google",
                      stateKinds: ["isolated"],
                    },
                  ],
                  steering: false,
                },
              ],
              maxConcurrentRuns: 4,
            },
          }),
        ),
      })
      .where("id", "=", base.runnerId)
      .execute();
    const { thread } = await store.createThread({
      createdBy: base.userId,
      environmentId: base.environmentId,
      harnessInstanceId: antigravityInstanceId,
      idempotencyKey: "antigravity-restart-thread",
      modelSelection: testModelSelection,
      title: "Antigravity restart steer",
    });
    const initial = await store.enqueueThreadInput({
      content: [{ text: "Start Antigravity turn", type: "text" }],
      idempotencyKey: "antigravity-restart-initial",
      policy: "queue",
      requestedBy: base.userId,
      source: { kind: "human" },
      threadId: thread.id,
    });
    if (!initial.run || !initial.command) throw new Error("Expected initial Antigravity Run");
    await store.claimCommand(initial.command.id, "antigravity-dispatcher");
    const antigravityContinuationIdentity = {
      ...testContinuationIdentity,
      driverKind: antigravityDriverKind,
    };
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: antigravityContinuationIdentity,
      harnessInstanceId: antigravityInstanceId,
      leaseTokenHash: "antigravity-lease-1",
      runnerBootId: base.runnerBootId,
      runnerId: base.runnerId,
      runId: initial.run.id,
      threadId: thread.id,
    });
    await commitRunnerEvent(store.database, threadPathLinks, {
      environmentId: base.environmentId,
      event: pendingEvent({
        bindingGeneration: binding.bindingGeneration,
        data: { status: "running" },
        environmentId: base.environmentId,
        ordinal: 0,
        runId: initial.run.id,
        threadId: thread.id,
        type: "run.started",
      }),
      runnerBootId: base.runnerBootId,
      runnerId: base.runnerId,
    });

    const steered = await store.enqueueThreadInput({
      content: [{ text: "Steer Antigravity via restart", type: "text" }],
      idempotencyKey: "antigravity-restart-steer",
      policy: "steer",
      requestedBy: base.userId,
      source: { kind: "human" },
      threadId: thread.id,
    });
    expect(steered.disposition).toBe("steering");
    expect(steered.command?.type).toBe("run.restart");

    // First attempt is interrupted for restart, replacement attempt takes the steered message.
    await commitRunnerEvent(store.database, threadPathLinks, {
      environmentId: base.environmentId,
      event: pendingEvent({
        bindingGeneration: binding.bindingGeneration,
        data: { status: "interrupted" },
        environmentId: base.environmentId,
        ordinal: 1,
        runId: initial.run.id,
        threadId: thread.id,
        type: "run.interrupted",
      }),
      runnerBootId: base.runnerBootId,
      runnerId: base.runnerId,
    });
    const replacementExecute = await database
      .selectFrom("commands")
      .select("id")
      .where("runId", "=", initial.run.id)
      .where("type", "=", "run.execute")
      .where("status", "=", "pending")
      .executeTakeFirstOrThrow();
    await store.claimCommand(replacementExecute.id, "antigravity-dispatcher");
    const replacementBinding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: antigravityContinuationIdentity,
      harnessInstanceId: antigravityInstanceId,
      leaseTokenHash: "antigravity-lease-2",
      runnerBootId: base.runnerBootId,
      runnerId: base.runnerId,
      runId: initial.run.id,
      threadId: thread.id,
    });
    await commitRunnerEvent(store.database, threadPathLinks, {
      environmentId: base.environmentId,
      event: pendingEvent({
        bindingGeneration: replacementBinding.bindingGeneration,
        data: { status: "running" },
        environmentId: base.environmentId,
        ordinal: 2,
        runId: initial.run.id,
        threadId: thread.id,
        type: "run.started",
      }),
      runnerBootId: base.runnerBootId,
      runnerId: base.runnerId,
    });
    await commitRunnerEvent(store.database, threadPathLinks, {
      environmentId: base.environmentId,
      event: pendingEvent({
        bindingGeneration: replacementBinding.bindingGeneration,
        data: { status: "completed" },
        environmentId: base.environmentId,
        ordinal: 3,
        runId: initial.run.id,
        threadId: thread.id,
        type: "run.completed",
      }),
      runnerBootId: base.runnerBootId,
      runnerId: base.runnerId,
    });
    await expect(
      database
        .selectFrom("threadInputs")
        .select(["state", "cancelReason"])
        .where("messageId", "=", steered.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ cancelReason: null, state: "delivered" });
  });

  it("distinguishes pre-write and post-write replacement attempt failures for restart-steered messages (Y5)", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, database } = storeFixture;
    const base = await startRunFixture("antigravity-restart-y5-base");
    const now = new Date();
    const antigravityDriverKind = HarnessIdSchema.parse("antigravity");
    const antigravityInstanceId = createId("harnessInstance");
    await database
      .insertInto("harnessInstances")
      .values({
        config: jsonValue({}),
        createdAt: now,
        driverKind: antigravityDriverKind,
        enabled: true,
        environmentId: base.environmentId,
        id: antigravityInstanceId,
        isDefault: false,
        name: "Antigravity Y5",
        removedAt: null,
        runtimeRevision: 1,
        sourceId: "google",
        stateKind: "isolated",
        updatedAt: now,
      })
      .execute();
    await database
      .updateTable("runners")
      .set({
        capabilities: jsonValue(["attempts-v1"]),
        moduleDescriptors: jsonValue(
          RunnerModulesSchema.parse({
            agents: {
              environmentIds: [base.environmentId],
              harnessDrivers: [
                {
                  accessModes: ["approval-required", "auto-accept-edits", "auto", "full-access"],
                  driverKind: antigravityDriverKind,
                  mcpImageContent: true,
                  readiness: "runtime-check",
                  sources: [
                    {
                      fields: [],
                      kind: "first-party",
                      label: "Google",
                      quota: "windows",
                      sourceId: "google",
                      stateKinds: ["isolated"],
                    },
                  ],
                  steering: false,
                },
              ],
              maxConcurrentRuns: 4,
            },
          }),
        ),
      })
      .where("id", "=", base.runnerId)
      .execute();

    for (const scenario of ["pre-write-failure", "post-write-failure"] as const) {
      const { thread } = await store.createThread({
        createdBy: base.userId,
        environmentId: base.environmentId,
        harnessInstanceId: antigravityInstanceId,
        idempotencyKey: `y5-thread-${scenario}`,
        modelSelection: testModelSelection,
        title: `Antigravity Y5 ${scenario}`,
      });
      const initial = await store.enqueueThreadInput({
        content: [{ text: "Initial Antigravity turn", type: "text" }],
        idempotencyKey: `y5-initial-${scenario}`,
        policy: "queue",
        requestedBy: base.userId,
        source: { kind: "human" },
        threadId: thread.id,
      });
      if (!initial.run) throw new Error("Expected initial Run");
      const firstExecute = await database
        .selectFrom("commands")
        .select("id")
        .where("runId", "=", initial.run.id)
        .where("type", "=", "run.execute")
        .executeTakeFirstOrThrow();
      await store.claimCommand(firstExecute.id, `y5-dispatcher-${scenario}`);
      const continuationIdentity = {
        ...testContinuationIdentity,
        driverKind: antigravityDriverKind,
      };
      const firstBinding = await store.acquireExecutionBinding({
        bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
        continuationIdentity,
        harnessInstanceId: antigravityInstanceId,
        leaseTokenHash: `y5-lease-1-${scenario}`,
        runnerBootId: base.runnerBootId,
        runnerId: base.runnerId,
        runId: initial.run.id,
        threadId: thread.id,
      });
      await commitRunnerEvent(store.database, threadPathLinks, {
        environmentId: base.environmentId,
        event: pendingEvent({
          bindingGeneration: firstBinding.bindingGeneration,
          data: { status: "running" },
          environmentId: base.environmentId,
          ordinal: 0,
          runId: initial.run.id,
          threadId: thread.id,
          type: "run.started",
        }),
        runnerBootId: base.runnerBootId,
        runnerId: base.runnerId,
      });

      const steered = await store.enqueueThreadInput({
        content: [{ text: `Restart steer (${scenario})`, type: "text" }],
        idempotencyKey: `y5-steer-${scenario}`,
        policy: "steer",
        requestedBy: base.userId,
        source: { kind: "human" },
        threadId: thread.id,
      });
      expect(steered.command?.type).toBe("run.restart");

      await commitRunnerEvent(store.database, threadPathLinks, {
        environmentId: base.environmentId,
        event: pendingEvent({
          bindingGeneration: firstBinding.bindingGeneration,
          data: { status: "interrupted" },
          environmentId: base.environmentId,
          ordinal: 1,
          runId: initial.run.id,
          threadId: thread.id,
          type: "run.interrupted",
        }),
        runnerBootId: base.runnerBootId,
        runnerId: base.runnerId,
      });

      const replacementExecute = await database
        .selectFrom("commands")
        .select("id")
        .where("runId", "=", initial.run.id)
        .where("type", "=", "run.execute")
        .where("status", "=", "pending")
        .executeTakeFirstOrThrow();
      await store.claimCommand(replacementExecute.id, `y5-dispatcher-2-${scenario}`);
      const replacementBinding = await store.acquireExecutionBinding({
        bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
        continuationIdentity,
        harnessInstanceId: antigravityInstanceId,
        leaseTokenHash: `y5-lease-2-${scenario}`,
        runnerBootId: base.runnerBootId,
        runnerId: base.runnerId,
        runId: initial.run.id,
        threadId: thread.id,
      });

      if (scenario === "pre-write-failure") {
        // ACP failed before writing `session/prompt`, so `run.started` was never emitted.
        await commitRunnerEvent(store.database, threadPathLinks, {
          environmentId: base.environmentId,
          event: pendingEvent({
            bindingGeneration: replacementBinding.bindingGeneration,
            data: {
              code: "harness_error",
              message: "ACP pipe closed before prompt write",
              retryable: false,
              status: "failed",
            },
            environmentId: base.environmentId,
            ordinal: 2,
            runId: initial.run.id,
            threadId: thread.id,
            type: "run.failed",
          }),
          runnerBootId: base.runnerBootId,
          runnerId: base.runnerId,
        });
        // The replacement input must NEVER be marked delivered when `run.started` did not fire.
        await expect(
          database
            .selectFrom("threadInputs")
            .select(["state", "cancelReason"])
            .where("messageId", "=", steered.message.id)
            .executeTakeFirstOrThrow(),
        ).resolves.toEqual({ cancelReason: null, state: "unknown" });
      } else {
        // ACP wrote `session/prompt` to stdin -> emitted `run.started` -> failed later.
        await commitRunnerEvent(store.database, threadPathLinks, {
          environmentId: base.environmentId,
          event: pendingEvent({
            bindingGeneration: replacementBinding.bindingGeneration,
            data: { status: "running" },
            environmentId: base.environmentId,
            ordinal: 2,
            runId: initial.run.id,
            threadId: thread.id,
            type: "run.started",
          }),
          runnerBootId: base.runnerBootId,
          runnerId: base.runnerId,
        });
        await commitRunnerEvent(store.database, threadPathLinks, {
          environmentId: base.environmentId,
          event: pendingEvent({
            bindingGeneration: replacementBinding.bindingGeneration,
            data: {
              code: "harness_error",
              message: "Engine failed after receiving prompt",
              retryable: false,
              status: "failed",
            },
            environmentId: base.environmentId,
            ordinal: 3,
            runId: initial.run.id,
            threadId: thread.id,
            type: "run.failed",
          }),
          runnerBootId: base.runnerBootId,
          runnerId: base.runnerId,
        });
        await expect(
          database
            .selectFrom("threadInputs")
            .select(["state", "cancelReason"])
            .where("messageId", "=", steered.message.id)
            .executeTakeFirstOrThrow(),
        ).resolves.toEqual({ cancelReason: null, state: "delivered" });
      }

      await expect(
        database
          .selectFrom("runs")
          .select("status")
          .where("id", "=", initial.run.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ status: "failed" });
    }
  });
});
