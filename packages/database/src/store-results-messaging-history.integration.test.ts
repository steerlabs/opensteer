import { withTimeout } from "@opensteer/shared/withTimeout";
import { readTranscriptPage, readTranscriptItem } from "./personal-sync-store.js";
import { readPersonalDetailSnapshot } from "./snapshot-store.js";
import type { TranscriptOrderCursor } from "@opensteer/protocol/transcript";

import {
  MessageContentSchema,
  createId,
  createToolOutput,
  type RunUsage,
  type RequestId,
} from "@opensteer/core";
import { type PendingAgentEvent } from "@opensteer/protocol";
import { sql } from "kysely";
import { expect } from "vitest";
import { runFromRow } from "./thread-row-mappers.js";
import { OpensteerStore } from "./index.js";
import {
  describeStore,
  testModelSelection,
  testContinuationIdentity,
  pendingEvent,
  liveRequest,
  sealedTestRequestResponse,
} from "./store.integration.test-support.js";
describeStore("PostgreSQL store", (it) => {
  it("terminally cancels an undelivered strict steer when its Run terminates", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, database } = storeFixture;
    const endedRun = await startRunFixture("thread-steer-terminal");
    const stranded = await store.enqueueThreadInput({
      content: [
        {
          text: "Preserve this after the Run ends",
          type: "text",
        },
      ],
      idempotencyKey: "thread-steer-terminal",
      policy: "steer",
      requestedBy: endedRun.userId,
      source: {
        kind: "human",
      },
      threadId: endedRun.thread.id,
    });
    const terminal = await store.commitRunnerEvent({
      environmentId: endedRun.environmentId,
      event: pendingEvent({
        bindingGeneration: endedRun.bindingGeneration,
        data: {
          status: "completed",
        },
        environmentId: endedRun.environmentId,
        ordinal: 1,
        runId: endedRun.run.id,
        threadId: endedRun.thread.id,
        type: "run.completed",
      }),
      runnerBootId: endedRun.runnerBootId,
      runnerId: endedRun.runnerId,
    });
    expect(terminal.throughOrdinal).toBe(1);
    await expect(
      database
        .selectFrom("threadInputs")
        .select(["runId", "state", "steerCommandId"])
        .where("messageId", "=", stranded.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      runId: endedRun.run.id,
      state: "cancelled",
      steerCommandId: stranded.command?.id,
    });
  });
  it("records a Run's usage once and keeps the engine's first statement", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, database } = storeFixture;
    const fixture = await startRunFixture("run-usage");
    const stated = {
      cacheWriteTokens: 1_984,
      cachedInputTokens: 12_760,
      costUsd: 0.0873,
      inputTokens: 18_430,
      outputTokens: 1_265,
    };
    function usageEvent(ordinal: number, data: RunUsage) {
      return {
        environmentId: fixture.environmentId,
        event: pendingEvent({
          bindingGeneration: fixture.bindingGeneration,
          data,
          environmentId: fixture.environmentId,
          ordinal,
          runId: fixture.run.id,
          threadId: fixture.thread.id,
          type: "run.usage" as const,
        }),
        runnerBootId: fixture.runnerBootId,
        runnerId: fixture.runnerId,
      };
    }
    const first = await store.commitRunnerEvent(usageEvent(1, stated));
    expect(first.duplicateRunUsage).toBe(false);
    // A second statement is a driver fault, not a Runner delivery failure: the
    // event is still committed and the first numbers stand.
    const second = await store.commitRunnerEvent(
      usageEvent(2, {
        inputTokens: 999_999,
        outputTokens: 999_999,
      }),
    );
    expect(second.duplicateRunUsage).toBe(true);
    const row = await database
      .selectFrom("runs")
      .selectAll()
      .where("id", "=", fixture.run.id)
      .executeTakeFirstOrThrow();
    expect(runFromRow(row).usage).toEqual(stated);
    expect(row.reasoningTokens).toBeNull();
  });
  it("refuses usage the engine could not have counted", async ({ storeFixture }) => {
    const { startRunFixture, database } = storeFixture;
    const fixture = await startRunFixture("run-usage-bounds");
    await expect(
      database
        .updateTable("runs")
        .set({
          inputTokens: -1,
          outputTokens: 1,
        })
        .where("id", "=", fixture.run.id)
        .execute(),
    ).rejects.toThrow(/runs_usage_tokens_check/u);
    await expect(
      database
        .updateTable("runs")
        .set({
          costUsd: -0.01,
          inputTokens: 1,
          outputTokens: 1,
        })
        .where("id", "=", fixture.run.id)
        .execute(),
    ).rejects.toThrow(/runs_cost_usd_check/u);
    await expect(
      database
        .updateTable("runs")
        .set({
          inputTokens: 1,
        })
        .where("id", "=", fixture.run.id)
        .execute(),
    ).rejects.toThrow(/runs_usage_tokens_check/u);
  });
  it("enforces the causal Run budget atomically", async ({ storeFixture }) => {
    const { createRunFixture, enqueueHumanTrigger, database, store } = storeFixture;
    const fixture = await createRunFixture("thread-input-causal-budget");
    const source = await enqueueHumanTrigger({
      content: [
        {
          text: "Create the causal root",
          type: "text",
        },
      ],
      idempotencyKey: "thread-input-causal-budget-source",
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
      idempotencyKey: "thread-input-causal-budget-target",
      modelSelection: testModelSelection,
      title: "Causal budget target",
    });
    await database
      .updateTable("causalChains")
      .set(({ ref }) => ({
        usedAutonomousRuns: ref("maxAutonomousRuns"),
      }))
      .where("id", "=", source.run.causalChainId)
      .executeTakeFirstOrThrow();
    const before = await database
      .selectFrom("messages")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("threadId", "=", target.id)
      .executeTakeFirstOrThrow();
    const blocked = await store.enqueueThreadInput({
      content: [
        {
          text: "This cannot spend another Run",
          type: "text",
        },
      ],
      idempotencyKey: "thread-input-causal-budget-blocked",
      policy: "queue",
      requestedBy: fixture.userId,
      source: {
        kind: "agent",
        runId: source.run.id,
      },
      threadId: target.id,
    });
    expect(blocked).toMatchObject({
      command: null,
      disposition: "cancelled",
      input: {
        cancelReason: "causal-run-budget-exhausted",
        state: "cancelled",
      },
      run: null,
    });
    await expect(
      database
        .selectFrom("messages")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("threadId", "=", target.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      count: String(Number(before.count) + 1),
    });
  });
  it("cancels an exhausted pending chain and advances to the next FIFO root", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, database, store } = storeFixture;
    const fixture = await createRunFixture("thread-input-causal-advance");
    const source = await enqueueHumanTrigger({
      content: [
        {
          text: "Create the chain that will later exhaust",
          type: "text",
        },
      ],
      idempotencyKey: "thread-input-causal-advance-source",
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
      idempotencyKey: "thread-input-causal-advance-target",
      modelSelection: testModelSelection,
      title: "Causal advance target",
    });
    await database
      .updateTable("causalChains")
      .set(({ ref }) => ({
        usedAutonomousRuns: ref("maxAutonomousRuns"),
      }))
      .where("id", "=", source.run.causalChainId)
      .executeTakeFirstOrThrow();
    const exhaustedHead = await store.enqueueThreadInput({
      content: [
        {
          text: "This pending result later exhausts",
          type: "text",
        },
      ],
      idempotencyKey: "thread-input-causal-advance-head",
      policy: "queue",
      requestedBy: fixture.userId,
      source: {
        kind: "agent",
        runId: source.run.id,
      },
      threadId: target.id,
    });
    const independent = await store.enqueueThreadInput({
      content: [
        {
          text: "Independent human root",
          type: "text",
        },
      ],
      idempotencyKey: "thread-input-causal-advance-independent",
      policy: "queue",
      requestedBy: fixture.userId,
      source: {
        kind: "human",
      },
      threadId: target.id,
    });
    expect(independent).toMatchObject({
      disposition: "run-queued",
      run: {
        seedInputId: independent.message.id,
      },
    });
    await expect(
      database
        .selectFrom("threadInputs")
        .select(["cancelReason", "state"])
        .where("messageId", "=", exhaustedHead.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      cancelReason: "causal-run-budget-exhausted",
      state: "cancelled",
    });
  });
  it("returns a completed Assignment's final reply once despite a replayed terminal Run event", async ({
    storeFixture,
  }) => {
    const { startRunFixture, database, store } = storeFixture;
    const fixture = await startRunFixture("delegation-result-once");
    await database
      .updateTable("causalChains")
      .set({
        usedAutonomousRuns: sql`max_autonomous_runs - 1`,
      })
      .where("id", "=", fixture.run.causalChainId)
      .executeTakeFirstOrThrow();
    const delegated = await store.delegateThread({
      accessMode: "auto",
      createdBy: fixture.userId,
      environmentId: fixture.environmentId,
      harnessInstanceId: fixture.harnessInstance.id,
      idempotencyKey: "delegation-result-once-child",
      modelSelection: testModelSelection,
      origin: {
        kind: "run",
        parentRunId: fixture.run.id,
        parentThreadId: fixture.thread.id,
      },
      task: [
        {
          text: "Return the evidence",
          type: "text",
        },
      ],
      title: "Evidence worker",
    });
    await store.claimCommand(delegated.command.id, "delegation-result-once-dispatcher");
    const runnerBootId = "boot-delegation-result-once";
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: fixture.harnessInstance.id,
      leaseTokenHash: "delegation-result-once-lease",
      runnerBootId,
      runnerId: fixture.runnerId,
      runId: delegated.run.id,
      threadId: delegated.thread.id,
    });
    await store.commitRunnerEvent({
      environmentId: fixture.environmentId,
      event: pendingEvent({
        bindingGeneration: binding.bindingGeneration,
        data: {
          status: "running",
        },
        environmentId: fixture.environmentId,
        ordinal: 0,
        runId: delegated.run.id,
        threadId: delegated.thread.id,
        type: "run.started",
      }),
      runnerBootId,
      runnerId: fixture.runnerId,
    });
    const childAssistantMessageId = createId("message");
    const childResult = `The evidence is ready\n${"🙂".repeat(14_000)}`;
    await store.commitRunnerEvent({
      environmentId: fixture.environmentId,
      event: pendingEvent({
        bindingGeneration: binding.bindingGeneration,
        data: {
          content: [
            {
              text: childResult,
              type: "text",
            },
          ],
          messageId: childAssistantMessageId,
        },
        environmentId: fixture.environmentId,
        ordinal: 1,
        runId: delegated.run.id,
        threadId: delegated.thread.id,
        type: "assistant.message",
      }),
      runnerBootId,
      runnerId: fixture.runnerId,
    });
    await store.commitRunnerEvent({
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
    const completedEvent = pendingEvent({
      bindingGeneration: binding.bindingGeneration,
      data: {
        status: "completed",
      },
      environmentId: fixture.environmentId,
      ordinal: 2,
      runId: delegated.run.id,
      threadId: delegated.thread.id,
      type: "run.completed",
    });
    const completed = await store.commitRunnerEvent({
      environmentId: fixture.environmentId,
      event: completedEvent,
      runnerBootId,
      runnerId: fixture.runnerId,
    });
    const replayed = await store.commitRunnerEvent({
      environmentId: fixture.environmentId,
      event: completedEvent,
      runnerBootId,
      runnerId: fixture.runnerId,
    });

    expect(completed.throughOrdinal).toBeGreaterThan(0);
    const cut = await readPersonalDetailSnapshot(database, {
      viewerId: fixture.userId,
      scope: { kind: "thread", threadId: delegated.thread.id },
    });
    if (cut.kind !== "snapshot") throw new Error("Expected worker detail");
    expect(cut.snapshot.items).toContainEqual(
      expect.objectContaining({
        id: `assignment:${delegated.assignment.id}`,
      }),
    );
    await expect(
      database
        .selectFrom("delegations")
        .select(["resultRunId", "resultText"])
        .where("id", "=", delegated.assignment.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      resultRunId: delegated.run.id,
      resultText: childResult,
    });
    await store.drainAssignmentReturn(delegated.assignment.id);
    const assignments = await store.listThreadAssignmentsForOwner({
      threadId: fixture.thread.id,
      ownerId: fixture.userId,
    });
    const settled = assignments?.assignments.find(({ id }) => id === delegated.assignment.id);
    expect(settled).toMatchObject({
      id: delegated.assignment.id,
      returnStatus: "delivered",
      status: "completed",
      resultPreview: expect.stringMatching(/^The evidence is ready/u),
    });
    expect(Buffer.byteLength(settled!.resultPreview!, "utf8")).toBeLessThanOrEqual(8 * 1_024);
    expect(settled!.resultPreview).not.toBe(childResult);
    expect(replayed).toMatchObject({
      replayed: true,
    });
    const delegatedRun = await database
      .selectFrom("runs")
      .select("actorPrincipalId")
      .where("id", "=", delegated.run.id)
      .executeTakeFirstOrThrow();
    await expect(
      database
        .selectFrom("messages")
        .select(["actorPrincipalId", "author", "kind"])
        .where("id", "=", childAssistantMessageId)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      actorPrincipalId: delegatedRun.actorPrincipalId,
      author: {
        // The system principal's stored display name is a seeded database
        // value, not prose; it keeps its original spelling byte for byte.
        displayName: "Opensteer",
        kind: "agent",
        runId: delegated.run.id,
        threadId: delegated.thread.id,
      },
      kind: "assistant",
    });
    const results = await database
      .selectFrom("messages")
      .select(["author", "content", "id", "kind"])
      .where("threadId", "=", fixture.thread.id)
      .where("kind", "=", "continuation")
      .execute();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      author: {
        cause: "assignment-result",
        kind: "platform",
        referenceId: delegated.assignment.id,
      },
      kind: "continuation",
    });
    const resultText = MessageContentSchema.parse(results[0]!.content)[0];
    expect(resultText).toMatchObject({
      type: "text",
    });
    if (resultText?.type !== "text") throw new Error("Expected delegated result text");
    expect(resultText.text).toBe(
      `Task completed: Evidence worker\nTask: ${delegated.thread.id} · Delegation: ${delegated.assignment.id}\n\n${childResult}`,
    );
    await expect(
      database
        .selectFrom("delegations")
        .select("resultMessageId")
        .where("id", "=", delegated.assignment.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      resultMessageId: results[0]!.id,
    });
    await expect(
      database
        .selectFrom("runs")
        .select(["status", "seedInputId"])
        .where("threadId", "=", fixture.thread.id)
        .where("status", "=", "queued")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      status: "queued",
      seedInputId: results[0]!.id,
    });
    const exhaustedChain = await database
      .selectFrom("causalChains")
      .select(["maxAutonomousRuns", "usedAutonomousRuns"])
      .where("id", "=", fixture.run.causalChainId)
      .executeTakeFirstOrThrow();
    expect(exhaustedChain.usedAutonomousRuns).toBe(exhaustedChain.maxAutonomousRuns);
    await expect(
      database.deleteFrom("messages").where("id", "=", results[0]!.id).execute(),
    ).rejects.toThrow(/foreign key|RESTRICT/u);
    await expect(
      database.deleteFrom("runs").where("id", "=", delegated.run.id).execute(),
    ).rejects.toThrow(/foreign key|RESTRICT/u);
    await expect(
      database.deleteFrom("runs").where("id", "=", fixture.run.id).execute(),
    ).rejects.toThrow(/foreign key|RESTRICT/u);
    await expect(
      database
        .updateTable("delegations")
        .set({
          childThreadId: fixture.thread.id,
        })
        .where("id", "=", delegated.assignment.id)
        .execute(),
    ).rejects.toThrow(/delegations_child_run_thread_fk/u);
    await expect(
      database
        .updateTable("delegations")
        .set({
          parentThreadId: delegated.thread.id,
        })
        .where("id", "=", delegated.assignment.id)
        .execute(),
    ).rejects.toThrow(/delegations_parent_run_thread_fk|delegations_result_message_thread_fk/u);
    await expect(
      database
        .updateTable("delegations")
        .set({
          resultMessageId: childAssistantMessageId,
        })
        .where("id", "=", delegated.assignment.id)
        .execute(),
    ).rejects.toThrow(/delegations_result_message_thread_fk/u);
  });
  it("queues a completed Assignment's return behind the parent's running turn", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, runDelegatedTurn, database } = storeFixture;
    const fixture = await startRunFixture("delegation-result-delivery-unknown");
    const delegated = await store.delegateThread({
      accessMode: "auto",
      createdBy: fixture.userId,
      environmentId: fixture.environmentId,
      harnessInstanceId: fixture.harnessInstance.id,
      idempotencyKey: "delegation-result-delivery-unknown-child",
      modelSelection: testModelSelection,
      origin: {
        kind: "run",
        parentRunId: fixture.run.id,
        parentThreadId: fixture.thread.id,
      },
      task: [
        {
          text: "Report back while the parent still runs",
          type: "text",
        },
      ],
      title: "Delivery-unknown worker",
    });
    await runDelegatedTurn(fixture, delegated.run, {
      end: "completed",
      replies: ["The worker finished while the parent still runs"],
      suffix: "delegation-result-delivery-unknown-child",
    });
    await store.drainAssignmentReturn(delegated.assignment.id);
    const steered = await database
      .selectFrom("threadInputs")
      .select(["messageId", "policy", "state", "steerCommandId"])
      .where("threadId", "=", fixture.thread.id)
      .where("idempotencyKey", "=", `assignment-return:${delegated.assignment.id}`)
      .executeTakeFirstOrThrow();
    expect(steered).toMatchObject({
      policy: "queue",
      state: "pending",
      steerCommandId: null,
    });
    const terminal = await store.commitRunnerEvent({
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
    expect(terminal.throughOrdinal).toBe(1);
    // A delivered Assignment is never drained again, so cancelling this input
    // would leave the result in the Thread with no Run that reads it.
    await expect(
      database
        .selectFrom("threadInputs")
        .select(["cancelReason", "runId", "state", "steerCommandId"])
        .where("messageId", "=", steered.messageId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      cancelReason: null,
      runId: null,
      state: "pending",
      steerCommandId: null,
    });
    await expect(
      database
        .selectFrom("messages")
        .select("runId")
        .where("id", "=", steered.messageId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      runId: null,
    });
    await expect(
      database
        .selectFrom("runs")
        .select(["seedInputId", "status"])
        .where("threadId", "=", fixture.thread.id)
        .where("status", "=", "queued")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      seedInputId: steered.messageId,
      status: "queued",
    });
    await expect(
      database
        .selectFrom("delegations")
        .select("resultStatus")
        .where("id", "=", delegated.assignment.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      resultStatus: "delivered",
    });
    await expect(store.drainAssignmentReturn(delegated.assignment.id)).resolves.toBe("settled");
  });
  it.for(["failed", "interrupted"] as const)(
    "settles the Assignment from how its child Run ended: %s",
    async (outcome, { storeFixture }) => {
      const { startRunFixture, store, runDelegatedTurn, database } = storeFixture;
      const fixture = await startRunFixture(`delegation-result-${outcome}`);
      const delegated = await store.delegateThread({
        accessMode: "auto",
        createdBy: fixture.userId,
        environmentId: fixture.environmentId,
        harnessInstanceId: fixture.harnessInstance.id,
        idempotencyKey: `delegation-result-${outcome}-child`,
        modelSelection: testModelSelection,
        origin: {
          kind: "run",
          parentRunId: fixture.run.id,
          parentThreadId: fixture.thread.id,
        },
        task: [
          {
            text: `Exercise the ${outcome} outcome`,
            type: "text",
          },
        ],
        title: `${outcome} worker`,
      });
      await runDelegatedTurn(fixture, delegated.run, {
        end: outcome,
        replies: ["Checked two of the three sources"],
        suffix: `delegation-result-${outcome}-child`,
      });
      await store.drainAssignmentReturn(delegated.assignment.id);
      const assignment = await database
        .selectFrom("delegations")
        .select(["status", "resultStatus", "resultText"])
        .where("id", "=", delegated.assignment.id)
        .executeTakeFirstOrThrow();
      if (outcome === "failed") {
        expect(assignment).toEqual({
          resultStatus: "delivered",
          resultText:
            "The task stopped because of an error: The child provider failed.\n\nLast reply before the error:\nChecked two of the three sources",
          status: "failed",
        });
        // Failure is work for the parent: it decides whether to retry.
        await expect(
          database
            .selectFrom("threadInputs")
            .select("policy")
            .where("idempotencyKey", "=", `assignment-return:${delegated.assignment.id}`)
            .executeTakeFirstOrThrow(),
        ).resolves.toEqual({
          policy: "queue",
        });
      } else {
        // A person stopped this Run, not the task; a later Run continues it.
        expect(
          await database
            .selectFrom("threadInputs")
            .select("messageId")
            .where("idempotencyKey", "=", `assignment-return:${delegated.assignment.id}`)
            .executeTakeFirst(),
        ).toBeUndefined();
        expect(assignment).toEqual({
          resultStatus: "pending",
          resultText: null,
          status: "open",
        });
      }
      await expect(store.drainAssignmentReturn(delegated.assignment.id)).resolves.toBe("settled");
    },
  );
  it.for(["archived-thread", "disabled-owner"] as const)(
    "records an undeliverable Assignment return when its parent is invalid: %s",
    async (invalidParent, { storeFixture }) => {
      const { startRunFixture, store, runDelegatedTurn, database } = storeFixture;
      const fixture = await startRunFixture(`delegation-result-${invalidParent}`);
      const delegated = await store.delegateThread({
        accessMode: "auto",
        createdBy: fixture.userId,
        environmentId: fixture.environmentId,
        harnessInstanceId: fixture.harnessInstance.id,
        idempotencyKey: `delegation-result-${invalidParent}-child`,
        modelSelection: testModelSelection,
        origin: {
          kind: "run",
          parentRunId: fixture.run.id,
          parentThreadId: fixture.thread.id,
        },
        task: [
          {
            text: "Return even if the parent can no longer run",
            type: "text",
          },
        ],
        title: `Invalid parent worker ${invalidParent}`,
      });
      await runDelegatedTurn(fixture, delegated.run, {
        end: "completed",
        replies: ["Completed before the parent lost authority"],
        suffix: `delegation-invalid-parent-${invalidParent}-child`,
      });
      const now = new Date();
      await database
        .updateTable("runs")
        .set({
          completedAt: now,
          status: "completed",
        })
        .where("id", "=", fixture.run.id)
        .execute();
      if (invalidParent === "archived-thread") {
        await database
          .updateTable("threads")
          .set({
            status: "archived",
            updatedAt: now,
          })
          .where("id", "=", fixture.thread.id)
          .executeTakeFirstOrThrow();
      } else {
        await database
          .updateTable("users")
          .set({ disabledAt: now })
          .where("id", "=", fixture.userId)
          .execute();
      }
      await store.drainAssignmentReturn(delegated.assignment.id);
      expect(
        await database
          .selectFrom("transcriptItems")
          .select("id")
          .where("threadId", "=", delegated.thread.id)
          .where("delegationId", "=", delegated.assignment.id)
          .execute(),
      ).toEqual([{ id: `assignment:${delegated.assignment.id}` }]);
      await expect(
        database
          .selectFrom("messages")
          .select("id")
          .where("threadId", "=", fixture.thread.id)
          .where("kind", "=", "continuation")
          .execute(),
      ).resolves.toEqual([]);
      await expect(
        database
          .selectFrom("delegations")
          .select(["resultMessageId", "resultReason", "resultStatus"])
          .where("id", "=", delegated.assignment.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        resultMessageId: null,
        resultReason: "execution-authority-unavailable",
        resultStatus: "undeliverable",
      });
      expect(
        await database
          .selectFrom("runs")
          .select("id")
          .where("threadId", "=", fixture.thread.id)
          .where("status", "=", "queued")
          .executeTakeFirst(),
      ).toBeUndefined();
      await expect(store.drainAssignmentReturn(delegated.assignment.id)).resolves.toBe("settled");
    },
  );
  it("charges delegation fan-out once per causal root and not per lifetime Thread", async ({
    storeFixture,
  }) => {
    const { startRunFixture, database, store } = storeFixture;
    const fixture = await startRunFixture("delegation-causal-budget");
    await database
      .updateTable("causalChains")
      .set({
        maxDelegations: 1,
      })
      .where("id", "=", fixture.run.causalChainId)
      .executeTakeFirstOrThrow();
    const request = {
      accessMode: "auto" as const,
      createdBy: fixture.userId,
      environmentId: fixture.environmentId,
      harnessInstanceId: fixture.harnessInstance.id,
      idempotencyKey: "delegation-causal-budget-first",
      modelSelection: testModelSelection,
      origin: {
        kind: "run" as const,
        parentRunId: fixture.run.id,
        parentThreadId: fixture.thread.id,
      },
      task: [
        {
          text: "Use the only delegation slot",
          type: "text" as const,
        },
      ],
      title: "Only child",
    };
    const first = await store.delegateThread(request);
    await expect(store.delegateThread(request)).resolves.toMatchObject({
      thread: {
        id: first.thread.id,
      },
      wasDuplicate: true,
    });
    await expect(
      store.delegateThread({
        ...request,
        idempotencyKey: "delegation-causal-budget-second",
        title: "Over budget child",
      }),
    ).rejects.toMatchObject({
      code: "resource_exhausted",
    });
    await expect(
      database
        .selectFrom("causalChains")
        .select(["maxDelegations", "usedDelegations"])
        .where("id", "=", fixture.run.causalChainId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      maxDelegations: 1,
      usedDelegations: 1,
    });
  });
  it("admits the next FIFO Run only after completion and allows one claim winner", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, database } = storeFixture;
    const started = await startRunFixture("thread-input-concurrent-claim");
    const pending = await store.enqueueThreadInput({
      content: [
        {
          text: "Run after the active work",
          type: "text",
        },
      ],
      idempotencyKey: "thread-input-concurrent-claim",
      policy: "queue",
      requestedBy: started.userId,
      source: {
        kind: "human",
      },
      threadId: started.thread.id,
    });
    expect(pending).toMatchObject({
      command: null,
      run: null,
      disposition: "pending",
    });
    expect(
      await database
        .selectFrom("runs")
        .select("id")
        .where("threadId", "=", started.thread.id)
        .where("status", "=", "queued")
        .execute(),
    ).toEqual([]);
    await store.commitRunnerEvent({
      environmentId: started.environmentId,
      event: pendingEvent({
        bindingGeneration: started.bindingGeneration,
        data: {
          status: "completed",
        },
        environmentId: started.environmentId,
        ordinal: 1,
        runId: started.run.id,
        threadId: started.thread.id,
        type: "run.completed",
      }),
      runnerBootId: started.runnerBootId,
      runnerId: started.runnerId,
    });
    const queuedCommand = await database
      .selectFrom("commands")
      .selectAll()
      .where("threadId", "=", started.thread.id)
      .where("type", "=", "run.execute")
      .where("status", "=", "pending")
      .executeTakeFirstOrThrow();
    const afterTerminal = await Promise.all([
      store.claimCommand(queuedCommand.id, "thread-input-claim-c"),
      new OpensteerStore(database, {}).claimCommand(queuedCommand.id, "thread-input-claim-d"),
    ]);
    expect(afterTerminal.filter((claim) => claim !== null)).toHaveLength(1);
  });
  it("interrupts a queued Run and pauses the remaining work queue", async ({ storeFixture }) => {
    const { createRunFixture, store, database } = storeFixture;
    const fixture = await createRunFixture("queued-interrupt-activation");
    const seed = await store.enqueueThreadInput({
      content: [
        {
          text: "Hold this oldest input",
          type: "text",
        },
      ],
      idempotencyKey: "queued-interrupt-seed",
      policy: "queue",
      requestedBy: fixture.userId,
      source: {
        kind: "human",
      },
      threadId: fixture.thread.id,
    });
    const activation = await store.enqueueThreadInput({
      content: [
        {
          text: "Start the queued work",
          type: "text",
        },
      ],
      idempotencyKey: "queued-interrupt-activation",
      policy: "queue",
      requestedBy: fixture.userId,
      source: {
        kind: "human",
      },
      threadId: fixture.thread.id,
    });
    expect(seed.run).toMatchObject({
      activationInputId: seed.message.id,
      seedInputId: seed.message.id,
      status: "queued",
    });
    if (!seed.run || !seed.command) throw new Error("Expected queued seed Run");
    await store.claimCommand(seed.command.id, "queued-interrupt-retry-dispatcher");
    await store.retryCommand(seed.command.id, new Error("Runner unavailable before dispatch"));
    const stopped = await store.enqueueRunnerControl({
      idempotencyKey: "queued-interrupt-control",
      requestedBy: fixture.userId,
      runId: seed.run.id,
      threadId: fixture.thread.id,
      type: "run.interrupt",
    });
    expect(stopped.command.status).toBe("succeeded");
    await expect(
      database
        .selectFrom("threadInputs")
        .select(["messageId", "state"])
        .where("messageId", "in", [seed.message.id, activation.message.id])
        .orderBy("messageId")
        .execute(),
    ).resolves.toEqual(
      [
        {
          messageId: seed.message.id,
          state: "cancelled",
        },
        {
          messageId: activation.message.id,
          state: "pending",
        },
      ].sort((left, right) => left.messageId.localeCompare(right.messageId)),
    );
    await expect(
      database
        .selectFrom("runs")
        .select("id")
        .where("threadId", "=", fixture.thread.id)
        .where("status", "=", "queued")
        .execute(),
    ).resolves.toEqual([]);
    await expect(
      database
        .selectFrom("threads")
        .select("inputQueuePaused")
        .where("id", "=", fixture.thread.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      inputQueuePaused: true,
    });
    const resumed = await store.resumeThreadInputQueue({
      idempotencyKey: "queued-interrupt-resume",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    expect(resumed.thread.inputQueuePaused).toBe(false);
    expect(
      await database
        .selectFrom("clientChanges")
        .select(["entityKind", "entityId"])
        .where("scopeKey", "=", `thread:${fixture.thread.id}`)
        .where("sequence", "=", resumed.asOfSequence)
        .execute(),
    ).toEqual(expect.arrayContaining([{ entityKind: "run-queue", entityId: fixture.thread.id }]));
    await expect(
      database
        .selectFrom("runs")
        .select(["seedInputId", "status"])
        .where("threadId", "=", fixture.thread.id)
        .where("status", "=", "queued")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      seedInputId: activation.message.id,
      status: "queued",
    });
  });
  it("windows dispatch history and paginates canonical Threads and messages without gaps", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, store } = storeFixture;
    const { environmentId, harnessInstance, runnerId, thread, userId } =
      await createRunFixture("durable_windows");
    const complete = async (
      admitted: Awaited<ReturnType<typeof enqueueHumanTrigger>>,
      suffix: string,
    ) => {
      await store.claimCommand(admitted.command.id, `durable-window-${suffix}-dispatcher`);
      const binding = await store.acquireExecutionBinding({
        bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
        continuationIdentity: testContinuationIdentity,
        harnessInstanceId: harnessInstance.id,
        leaseTokenHash: `durable-window-${suffix}-lease`,
        runnerBootId: "durable-window-boot",
        runnerId,
        runId: admitted.run.id,
        threadId: thread.id,
      });
      await store.bindProviderSession({
        bindingGeneration: binding.bindingGeneration,
        harnessInstanceId: harnessInstance.id,
        providerSessionId: binding.providerSessionId,
        providerSessionReference: "native-session-durable-window",
        runId: admitted.run.id,
        runnerBootId: "durable-window-boot",
        runnerId,
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
          runId: admitted.run.id,
          threadId: thread.id,
          type: "run.started",
        }),
        runnerBootId: "durable-window-boot",
        runnerId,
      });
      await store.commitRunnerEvent({
        environmentId,
        event: pendingEvent({
          bindingGeneration: binding.bindingGeneration,
          data: {
            status: "completed",
          },
          environmentId,
          ordinal: 1,
          runId: admitted.run.id,
          threadId: thread.id,
          type: "run.completed",
        }),
        runnerBootId: "durable-window-boot",
        runnerId,
      });
    };
    const first = await enqueueHumanTrigger({
      content: [
        {
          text: "FIRST",
          type: "text",
        },
      ],
      idempotencyKey: "durable-window-message-1",
      requestedBy: userId,
      threadId: thread.id,
    });
    await complete(first, "first");
    const second = await enqueueHumanTrigger({
      content: [
        {
          text: "SECOND",
          type: "text",
        },
      ],
      idempotencyKey: "durable-window-message-2",
      requestedBy: userId,
      threadId: thread.id,
    });
    await complete(second, "second");
    const largestPageMessage = "🚀".repeat(86 * 1_024);
    const third = await enqueueHumanTrigger({
      content: [
        {
          text: largestPageMessage,
          type: "text",
        },
      ],
      idempotencyKey: "durable-window-message-3",
      requestedBy: userId,
      threadId: thread.id,
    });
    await store.claimCommand(third.command.id, "durable-window-third-dispatcher");
    const dispatch = await store.loadRunDispatchContext(third.command.id, {
      maxItems: 1,
    });
    expect(dispatch.history.map(({ id }) => id)).toEqual([second.message.id]);
    expect(dispatch.historyWindow).toMatchObject({
      hasEarlier: true,
      itemCount: 1,
    });
    expect(dispatch.historyWindow.byteCount).toBe(
      Buffer.byteLength(JSON.stringify(dispatch.history), "utf8"),
    );
    const messageSnapshot = await readPersonalDetailSnapshot(store.database, {
      viewerId: userId,
      scope: { kind: "thread", threadId: thread.id },
    });
    if (messageSnapshot.kind !== "snapshot") throw new Error("Expected thread detail");
    expect(Buffer.byteLength(JSON.stringify(messageSnapshot.snapshot))).toBeLessThanOrEqual(
      1024 * 1024,
    );
    expect(
      messageSnapshot.snapshot.items.filter(({ kind }) => kind === "message").map(({ id }) => id),
    ).toEqual([first.message.id, second.message.id, third.message.id]);
    const thirdBinding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: harnessInstance.id,
      leaseTokenHash: "durable-window-third-lease",
      runnerBootId: "durable-window-boot",
      runnerId,
      runId: third.run.id,
      threadId: thread.id,
    });
    for (const [ordinal, type, status] of [
      [0, "run.started", "running"],
      [1, "run.completed", "completed"],
    ] as const) {
      await store.commitRunnerEvent({
        environmentId,
        event: pendingEvent({
          bindingGeneration: thirdBinding.bindingGeneration,
          data: {
            status,
          },
          environmentId,
          ordinal,
          runId: third.run.id,
          threadId: thread.id,
          type,
        }),
        runnerBootId: "durable-window-boot",
        runnerId,
      });
    }
    for (const suffix of ["older-a", "older-b"]) {
      await store.createThread({
        createdBy: userId,
        environmentId,
        harnessInstanceId: harnessInstance.id,
        idempotencyKey: `durable-window-${suffix}`,
        modelSelection: testModelSelection,
        title: suffix,
      });
    }
    const newestTasks = await store.taskPageForUser({
      window: "recent",
      limit: 1,
      viewerId: userId,
    });
    expect(newestTasks.hasMore).toBe(true);
    expect(newestTasks.tasks).toHaveLength(1);
    const olderTasks = await store.taskPageForUser({
      before: newestTasks.nextBefore!,
      window: "recent",
      limit: 1,
      viewerId: userId,
    });
    expect(olderTasks.tasks[0]?.id).not.toBe(newestTasks.tasks[0]?.id);
    const ownerThreads = await store.ownerThreadPageForOwner({
      maxItems: 1,
      ownerId: userId,
    });
    expect(ownerThreads.window).toMatchObject({
      hasMore: true,
      itemCount: 1,
      totalItems: 3,
    });
    expect(ownerThreads.window.nextBefore).not.toBeNull();
    const olderOwnerThreads = await store.ownerThreadPageForOwner({
      before: ownerThreads.window.nextBefore!,
      maxItems: 1,
      ownerId: userId,
    });
    expect(olderOwnerThreads.threads[0]?.id).not.toBe(ownerThreads.threads[0]?.id);
    const newestHistory = await store.threadMessagePageForOwner({
      maxItems: 1,
      ownerId: userId,
      threadId: thread.id,
    });
    expect(newestHistory?.messages.map(({ id }) => id)).toEqual([third.message.id]);
    const earlier = await store.threadMessagePageForOwner({
      before: newestHistory!.window.nextBefore!,
      maxItems: 1,
      ownerId: userId,
      threadId: thread.id,
    });
    expect(earlier?.messages.map(({ id }) => id)).toEqual([second.message.id]);
    expect(earlier?.window).toMatchObject({
      hasMore: true,
      itemCount: 1,
    });
    const oldest = await store.threadMessagePageForOwner({
      before: earlier!.window.nextBefore!,
      maxItems: 1,
      ownerId: userId,
      threadId: thread.id,
    });
    expect(oldest?.messages.map(({ id }) => id)).toEqual([first.message.id]);
    expect(oldest?.window.hasMore).toBe(false);
    const largestMessagePage = await store.threadMessagePageForOwner({
      maxItems: 1,
      ownerId: userId,
      threadId: thread.id,
    });
    expect(largestMessagePage?.messages[0]?.content).toEqual([
      {
        text: largestPageMessage,
        type: "text",
      },
    ]);
    expect(largestMessagePage?.window.itemCount).toBe(1);
    expect(largestMessagePage?.window.nextBefore).not.toBeNull();
  });
  it("pages durable Thread event history without delta events", async ({ storeFixture }) => {
    const { createRunFixture, enqueueHumanTrigger, store } = storeFixture;
    const { environmentId, runnerId, thread, userId } = await createRunFixture("event_history");
    const turn = await enqueueHumanTrigger({
      content: [
        {
          type: "text",
          text: "Trace this run",
        },
      ],
      idempotencyKey: "event-history-turn",
      requestedBy: userId,
      threadId: thread.id,
    });
    await store.claimCommand(turn.command.id, "host-worker-event-history");
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: thread.harnessInstanceId,
      leaseTokenHash: "lease-event-history",
      runnerBootId: "boot-event-history",
      runnerId,
      runId: turn.run.id,
      threadId: thread.id,
    });
    const base = {
      bindingGeneration: binding.bindingGeneration,
      environmentId,
      runId: turn.run.id,
      threadId: thread.id,
    } as const;
    const commit = (event: PendingAgentEvent) =>
      store.commitRunnerEvent({
        environmentId,
        event,
        runnerBootId: "boot-event-history",
        runnerId,
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
    await commit(
      pendingEvent({
        ...base,
        data: {
          blockId: "block-1",
          text: "Considering… settled.",
        },
        ordinal: 1,
        type: "reasoning.completed",
      }),
    );
    await commit(
      pendingEvent({
        ...base,
        data: {
          arguments: {
            path: "notes.md",
          },
          callId: "call-1",
          tool: {
            name: "read_file",
            namespace: "test",
          },
        },
        ordinal: 2,
        type: "tool.started",
      }),
    );
    await commit(
      pendingEvent({
        ...base,
        data: {
          callId: "call-1",
          isError: false,
          output: {
            text: "file contents",
          },
        },
        ordinal: 3,
        type: "tool.completed",
      }),
    );
    await commit(
      pendingEvent({
        ...base,
        data: {
          status: "completed",
        },
        ordinal: 4,
        type: "run.completed",
      }),
    );

    const scope = { kind: "thread", threadId: thread.id } as const;
    const read = { scope, viewerId: userId };
    const full = await readTranscriptPage(store.database, read);
    if (full.kind !== "page") throw new Error("Expected transcript page");
    expect(full.hasMore).toBe(false);
    expect(full.nextBefore).toBeNull();
    expect(full.items.map(({ kind }) => kind)).toEqual(["message", "run", "reasoning", "tool"]);
    const newest = await readTranscriptPage(store.database, { ...read, limit: 2 });
    if (newest.kind !== "page") throw new Error("Expected newest page");
    expect(newest.items).toEqual(full.items.slice(-2));
    expect(newest.hasMore).toBe(true);
    expect(newest.nextBefore).toMatchObject({
      beforeId: newest.items[0]!.id,
      beforePosition: newest.items[0]!.position,
    });
    const older = await readTranscriptPage(store.database, {
      ...read,
      cursor: newest.nextBefore!,
      limit: 2,
    });
    if (older.kind !== "page") throw new Error("Expected older page");
    expect(older.items).toEqual(full.items.slice(0, 2));
    expect(older.hasMore).toBe(false);
    expect(older.nextBefore).toBeNull();
    const outsider = await store.createUser("Outsider");
    await expect(
      readTranscriptPage(store.database, { ...read, viewerId: outsider }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
  it("pages human and silent automatic Thread turns with split-turn budgets", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, store, database } = storeFixture;
    const { environmentId, runnerId, thread, userId } = await createRunFixture("turn_history");
    const runTurn = async (index: number, outputs: readonly string[], toolArguments = {}) => {
      const turn = await enqueueHumanTrigger({
        content: [
          {
            type: "text",
            text: `Turn ${index}`,
          },
        ],
        idempotencyKey: `turn-history-${index}`,
        requestedBy: userId,
        threadId: thread.id,
      });
      if (index === 3) {
        await database
          .updateTable("threads")
          .set({
            purpose: "voice",
          })
          .where("id", "=", thread.id)
          .execute();
        await database
          .updateTable("messages")
          .set({
            author: {
              kind: "watch",
              displayName: "Watcher",
              activationId: createId("triggerWatchActivation"),
              revisionId: createId("triggerRevision"),
              triggerId: createId("trigger"),
            },
          })
          .where("id", "=", turn.run.seedInputId)
          .execute();
        await database
          .updateTable("runs")
          .set({
            personWaited: false,
          })
          .where("id", "=", turn.run.id)
          .execute();
      }
      await store.claimCommand(turn.command.id, `host-worker-turn-history-${index}`);
      const binding = await store.acquireExecutionBinding({
        bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
        continuationIdentity: testContinuationIdentity,
        harnessInstanceId: thread.harnessInstanceId,
        leaseTokenHash: `lease-turn-history-${index}`,
        runnerBootId: "boot-turn-history",
        runnerId,
        runId: turn.run.id,
        threadId: thread.id,
      });
      await store.bindProviderSession({
        bindingGeneration: binding.bindingGeneration,
        harnessInstanceId: thread.harnessInstanceId,
        providerSessionId: binding.providerSessionId,
        providerSessionReference: "native-session-turn-history",
        runId: turn.run.id,
        runnerBootId: "boot-turn-history",
        runnerId,
        threadId: thread.id,
      });
      const base = {
        bindingGeneration: binding.bindingGeneration,
        environmentId,
        runId: turn.run.id,
        threadId: thread.id,
      } as const;
      let ordinal = 0;
      const commit = (event: PendingAgentEvent) =>
        store.commitRunnerEvent({
          environmentId,
          event,
          runnerBootId: "boot-turn-history",
          runnerId,
        });
      await commit(
        pendingEvent({
          ...base,
          data: {
            status: "running",
          },
          ordinal: ordinal++,
          type: "run.started",
        }),
      );
      for (const [call, text] of outputs.entries()) {
        const callId = `call-${index}-${call}`;
        await commit(
          pendingEvent({
            ...base,
            data: {
              arguments: toolArguments,
              callId,
              tool: {
                name: "read_file",
                namespace: "test",
              },
            },
            ordinal: ordinal++,
            type: "tool.started",
          }),
        );
        await commit(
          pendingEvent({
            ...base,
            data: {
              callId,
              isError: false,
              output: {
                text,
              },
            },
            ordinal: ordinal++,
            type: "tool.completed",
          }),
        );
      }
      await commit(
        pendingEvent({
          ...base,
          data: {
            status: "completed",
          },
          ordinal: ordinal++,
          type: "run.completed",
        }),
      );
    };
    const large = "x".repeat(40_000);
    await runTurn(1, ["a", "b"]);
    await runTurn(2, ["c", large, "d"]);
    // Stored JSON spells this a third longer than the wire does.
    await runTurn(3, ["e"], {
      values: Array.from(
        {
          length: 20_000,
        },
        () => 1,
      ),
    });
    const page = async (input: {
      cursor?: TranscriptOrderCursor;
      maxBytes?: number;
      limit?: number;
      maxTurns?: number;
    }) => {
      const result = await readTranscriptPage(database, {
        ...input,
        viewerId: userId,
        scope: { kind: "thread", threadId: thread.id },
      });
      if (result.kind !== "page") throw new Error("Expected transcript page");
      return result;
    };
    const all = await page({ maxTurns: 20 });
    expect(all.hasMore).toBe(false);
    expect(all.nextBefore).toBeNull();
    const starts = all.items.flatMap(({ isTurnStart }, index) => (isTurnStart ? [index] : []));
    expect(starts).toHaveLength(3);
    const [first, second, third] = starts as [number, number, number];
    const newest = await page({ maxTurns: 2 });
    expect(newest.items).toEqual(all.items.slice(first + 1));
    expect(newest.hasMore).toBe(true);
    expect(newest.nextBefore).toMatchObject({ beforeId: all.items[first + 1]!.id });
    const oldest = await page({ cursor: newest.nextBefore!, maxTurns: 2 });
    expect(oldest.items).toEqual(all.items.slice(0, first + 1));
    expect(oldest.hasMore).toBe(false);
    const newestTurn = all.items.slice(third);
    const bounded = await page({ maxBytes: 8192, maxTurns: 1 });
    expect(bounded.items).toEqual(all.items.slice(second + 1));
    expect(bounded.items.slice(-newestTurn.length)).toEqual(newestTurn);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(8192);
    const counted = await page({ limit: 2, maxTurns: 1 });
    expect(counted.items).toEqual(newestTurn.slice(-2));
    const rest = await page({ cursor: counted.nextBefore!, maxTurns: 1 });
    expect(rest.items).toEqual(all.items.slice(second + 1, -2));
    const { id: toolCallId } = await database
      .selectFrom("toolCalls")
      .select("id")
      .where("threadId", "=", thread.id)
      .where("callId", "=", "call-2-1")
      .executeTakeFirstOrThrow();
    const tool = all.items.find((item) => item.kind === "tool" && item.toolCallId === toolCallId);
    expect(tool).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(tool))).toBeLessThan(Buffer.byteLength(large));
    await expect(
      readTranscriptItem(database, {
        itemId: tool!.id,
        scope: { kind: "thread", threadId: thread.id },
        viewerId: userId,
      }),
    ).resolves.toMatchObject({ kind: "item", body: { kind: "tool", output: { text: large } } });
  });
  it("persists tool output whose source text carried NUL bytes", async ({ storeFixture }) => {
    const { createRunFixture, enqueueHumanTrigger, store } = storeFixture;
    const { environmentId, runnerId, thread, userId } = await createRunFixture("nul_tool_output");
    const turn = await enqueueHumanTrigger({
      content: [
        {
          type: "text",
          text: "Read a binary",
        },
      ],
      idempotencyKey: "nul-tool-output-turn",
      requestedBy: userId,
      threadId: thread.id,
    });
    await store.claimCommand(turn.command.id, "host-worker-nul-tool-output");
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: thread.harnessInstanceId,
      leaseTokenHash: "lease-nul-tool-output",
      runnerBootId: "boot-nul-tool-output",
      runnerId,
      runId: turn.run.id,
      threadId: thread.id,
    });
    const base = {
      bindingGeneration: binding.bindingGeneration,
      environmentId,
      runId: turn.run.id,
      threadId: thread.id,
    } as const;
    const commit = (event: PendingAgentEvent) =>
      store.commitRunnerEvent({
        environmentId,
        event,
        runnerBootId: "boot-nul-tool-output",
        runnerId,
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

    // What a `head -30` of a Mach-O binary produces. PostgreSQL refuses raw
    // NUL in `jsonb` with 22P05 — "unsupported Unicode escape sequence" — so
    // the Host stores it as U+FFFD, the text tool output's canonical
    // constructor makes, and the canonical form sent again is a replay.
    const machOHead = `\u00CF\u00FA\u00ED\u00FE${"\u0000".repeat(5_000)}__TEXT`;
    const raw = pendingEvent<
      Extract<
        PendingAgentEvent,
        {
          type: "tool.completed";
        }
      >
    >({
      ...base,
      data: {
        callId: "call-nul",
        isError: false,
        output: {
          text: machOHead,
        },
      },
      ordinal: 1,
      type: "tool.completed",
    });
    expect(await commit(raw)).toMatchObject({
      replayed: false,
    });
    const output = createToolOutput(machOHead);
    expect(output.text).not.toContain("\u0000");
    expect(await commit(raw)).toMatchObject({
      replayed: true,
    });
    expect(
      await commit({
        ...raw,
        data: {
          ...raw.data,
          output,
        },
      }),
    ).toMatchObject({
      replayed: true,
    });
    await commit(
      pendingEvent({
        ...base,
        data: {
          status: "completed",
        },
        ordinal: 2,
        type: "run.completed",
      }),
    );
    const scope = { kind: "thread", threadId: thread.id } as const;
    const page = await readTranscriptPage(store.database, { viewerId: userId, scope });
    if (page.kind !== "page") throw new Error("Expected tool page");
    const tool = page.items.find(({ kind }) => kind === "tool")!;
    expect(
      await readTranscriptItem(store.database, { viewerId: userId, scope, itemId: tool.id }),
    ).toMatchObject({ kind: "item", body: { kind: "tool", output } });
  });
  it("accepts only contiguous Runner events and legal Run transitions", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, store, database } = storeFixture;
    const { environmentId, runnerId, thread, userId } = await createRunFixture("event_order");
    const turn = await enqueueHumanTrigger({
      content: [
        {
          type: "text",
          text: "Run safely",
        },
      ],
      idempotencyKey: "event-order-turn",
      requestedBy: userId,
      threadId: thread.id,
    });
    await store.claimCommand(turn.command.id, "host-worker-event-order");
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: thread.harnessInstanceId,
      leaseTokenHash: "lease-event-order",
      runnerBootId: "boot-event-order",
      runnerId,
      runId: turn.run.id,
      threadId: thread.id,
    });
    const base = {
      bindingGeneration: binding.bindingGeneration,
      environmentId,
      runId: turn.run.id,
      threadId: thread.id,
    } as const;
    await expect(
      store.commitRunnerEvent({
        environmentId,
        event: pendingEvent({
          ...base,
          data: {
            status: "completed",
          },
          ordinal: 7,
          type: "run.completed",
        }),
        runnerBootId: "boot-event-order",
        runnerId,
      }),
    ).rejects.toMatchObject({ code: "conflict", message: "Expected Runner ordinal 0" });
    await expect(
      store.commitRunnerEvent({
        environmentId,
        event: pendingEvent({
          ...base,
          data: {
            status: "completed",
          },
          ordinal: 0,
          type: "run.completed",
        }),
        runnerBootId: "boot-event-order",
        runnerId,
      }),
    ).rejects.toThrow(/invalid while the Run is starting/);
    expect(
      await database
        .selectFrom("runs")
        .select(["nextRunnerOrdinal", "startedAt", "status"])
        .where("id", "=", turn.run.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      nextRunnerOrdinal: 0,
      startedAt: null,
      status: "starting",
    });
    const started = pendingEvent({
      ...base,
      data: {
        status: "running",
      },
      ordinal: 0,
      type: "run.started",
    });
    await store.commitRunnerEvent({
      environmentId,
      event: started,
      runnerBootId: "boot-event-order",
      runnerId,
    });
    await expect(
      store.commitRunnerEvent({
        environmentId,
        event: pendingEvent({
          ...base,
          data: {
            status: "waiting",
          },
          ordinal: 0,
          type: "run.status",
        }),
        runnerBootId: "boot-event-order",
        runnerId,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "Runner ordinal was already used by another statement",
    });
    await expect(
      store.commitRunnerEvent({
        environmentId,
        event: pendingEvent({
          ...base,
          data: {
            status: "completed",
          },
          ordinal: 2,
          type: "run.completed",
        }),
        runnerBootId: "boot-event-order",
        runnerId,
      }),
    ).rejects.toMatchObject({ code: "conflict", message: "Expected Runner ordinal 1" });
    const later = await store.enqueueThreadInput({
      content: [
        {
          type: "text",
          text: "Continue after the failure",
        },
      ],
      idempotencyKey: "event-order-later-message",
      policy: "steer",
      requestedBy: userId,
      source: {
        kind: "human",
      },
      threadId: thread.id,
    });
    expect(later).toMatchObject({
      command: {
        type: "run.steer",
      },
      disposition: "steering",
    });
    const failed = pendingEvent({
      ...base,
      data: {
        code: "test_failure",
        message: "The harness failed",
        retryable: false,
        status: "failed",
      },
      ordinal: 1,
      type: "run.failed",
    });
    const committed = await store.commitRunnerEvent({
      environmentId,
      event: failed,
      runnerBootId: "boot-event-order",
      runnerId,
    });
    const duplicate = await store.commitRunnerEvent({
      environmentId,
      event: failed,
      runnerBootId: "boot-event-order",
      runnerId,
    });
    expect(committed.replayed).toBe(false);
    expect(duplicate.replayed).toBe(true);
    expect(duplicate.throughOrdinal).toBe(committed.throughOrdinal);
    expect(
      await database
        .selectFrom("runs")
        .select(["nextRunnerOrdinal", "status"])
        .where("id", "=", turn.run.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      nextRunnerOrdinal: 2,
      status: "failed",
    });
    await expect(
      database
        .selectFrom("threads")
        .select("status")
        .where("id", "=", thread.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      status: "failed",
    });
    await expect(
      database
        .selectFrom("threadInputs")
        .select(["runId", "state", "steerCommandId"])
        .where("messageId", "=", later.message.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      runId: turn.run.id,
      state: "cancelled",
      steerCommandId: later.command?.id,
    });
    await expect(
      database
        .selectFrom("commands")
        .select(["status", "type"])
        .where("id", "=", later.command!.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      status: "failed",
      type: "run.steer",
    });
  });
  it("resolves only the exact pending Request and records the response atomically", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, store, database } = storeFixture;
    const { environmentId, runnerId, thread, userId } =
      await createRunFixture("opensteer_request_list");
    const turn = await enqueueHumanTrigger({
      content: [
        {
          type: "text",
          text: "Ask before acting",
        },
      ],
      idempotencyKey: "pending-request-turn",
      requestedBy: userId,
      threadId: thread.id,
    });
    await store.claimCommand(turn.command.id, "host-worker-pending-request");
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: thread.harnessInstanceId,
      leaseTokenHash: "lease-pending-request",
      runnerBootId: "boot-pending-request",
      runnerId,
      runId: turn.run.id,
      threadId: thread.id,
    });
    const base = {
      bindingGeneration: binding.bindingGeneration,
      environmentId,
      runId: turn.run.id,
      threadId: thread.id,
    } as const;
    const commit = (event: PendingAgentEvent) =>
      store.commitRunnerEvent({
        environmentId,
        event,
        runnerBootId: "boot-pending-request",
        runnerId,
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
    const requestId = createId("request");
    await commit(
      pendingEvent({
        ...base,
        data: {
          request: liveRequest({
            harnessInstanceId: thread.harnessInstanceId,
            id: requestId,
            presentation: {
              detail: "Write the release file",
              kind: "choice",
              options: [
                {
                  hint: "reject-once",
                  id: "decline",
                  label: "Decline",
                },
                {
                  hint: "allow-once",
                  id: "allow",
                  label: "Allow",
                },
              ],
              risk: "medium",
              title: "Approve write",
            },
            requestedBy: userId,
            runId: turn.run.id,
            threadId: thread.id,
          }),
        },
        ordinal: 1,
        type: "request.opened",
      }),
    );
    expect(
      await database
        .selectFrom("runs")
        .select(["nextRunnerOrdinal", "status"])
        .where("id", "=", turn.run.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      nextRunnerOrdinal: 2,
      status: "waiting",
    });
    const waiting = await readPersonalDetailSnapshot(database, {
      viewerId: userId,
      scope: { kind: "thread", threadId: thread.id },
    });
    if (waiting.kind !== "snapshot") throw new Error("Expected waiting detail");
    expect(waiting.snapshot.pendingRequests).toEqual([
      expect.objectContaining({ id: requestId, title: "Approve write", status: "pending" }),
    ]);
    const reviewedRevision = (await store.requests.revision(requestId))!;
    await expect(
      store.enqueueRunnerControl({
        idempotencyKey: "stale-review",
        requestId,
        expectedRevision: (BigInt(reviewedRevision) - 1n).toString(),
        requestedBy: userId,
        response: { kind: "choice", optionId: "allow" },
        sealedResponse: sealedTestRequestResponse(),
        threadId: thread.id,
        runId: turn.run.id,
        type: "request.respond",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      store.enqueueRunnerControl({
        requestId,
        idempotencyKey: "wrong-kind-control",
        requestedBy: userId,
        response: {
          answers: {
            choice: ["yes"],
          },
          kind: "form",
        },
        sealedResponse: sealedTestRequestResponse(),
        runId: turn.run.id,
        threadId: thread.id,
        expectedRevision: (await store.requests.revision(requestId))!,
        type: "request.respond",
      }),
    ).rejects.toMatchObject({
      code: "bad_request",
    });
    await expect(
      store.enqueueRunnerControl({
        requestId: createId("request"),
        idempotencyKey: "wrong-id-control",
        requestedBy: userId,
        response: {
          kind: "choice",
          optionId: "allow",
        },
        sealedResponse: sealedTestRequestResponse(),
        runId: turn.run.id,
        threadId: thread.id,
        expectedRevision: reviewedRevision,
        type: "request.respond",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    const controlInput = {
      requestId,
      idempotencyKey: "exact-approval-control",
      requestedBy: userId,
      response: {
        kind: "choice" as const,
        optionId: "allow",
      },
      sealedResponse: sealedTestRequestResponse(),
      runId: turn.run.id,
      threadId: thread.id,
      expectedRevision: (await store.requests.revision(requestId))!,
      type: "request.respond" as const,
    };
    const control = await store.enqueueRunnerControl(controlInput);
    const repeatedControl = await store.enqueueRunnerControl(controlInput);
    expect(control.wasDuplicate).toBe(false);
    expect(repeatedControl.wasDuplicate).toBe(true);
    expect(repeatedControl.command.id).toBe(control.command.id);
    await expect(
      store.enqueueRunnerControl({
        ...controlInput,
        response: {
          kind: "choice",
          optionId: "decline",
        },
        sealedResponse: {
          ...controlInput.sealedResponse,
          requestFingerprint: "hmac-sha256-v1:1:different-choice-response",
        },
      }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    const claimedControl = await store.claimCommand(
      control.command.id,
      "host-worker-pending-control",
    );
    expect(claimedControl?.command.type).toBe("request.respond");
    await expect(
      database
        .selectFrom("runs")
        .select("status")
        .where("id", "=", turn.run.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      status: "waiting",
    });
    expect(
      await database
        .selectFrom("requests")
        .select(["response", "responseCommandId", "status"])
        .where("id", "=", requestId)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      response: null,
      responseCommandId: control.command.id,
      status: "pending",
    });
    await store.succeedCommand(control.command.id);
    expect(
      await database
        .selectFrom("requests")
        .select(["response", "responseCommandId", "status"])
        .where("id", "=", requestId)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      response: {
        kind: "choice",
        optionId: "allow",
      },
      responseCommandId: null,
      status: "fulfilled",
    });
    await commit(
      pendingEvent({
        ...base,
        data: {
          status: "running",
        },
        ordinal: 2,
        type: "run.status",
      }),
    );
    expect(
      await database
        .selectFrom("runs")
        .select(["nextRunnerOrdinal", "status"])
        .where("id", "=", turn.run.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      nextRunnerOrdinal: 3,
      status: "running",
    });
    const inputRequestId = createId("request");
    await commit(
      pendingEvent({
        ...base,
        data: {
          request: liveRequest({
            harnessInstanceId: thread.harnessInstanceId,
            id: inputRequestId,
            presentation: {
              fields: [
                {
                  id: "choice",
                  multiSelect: false,
                  prompt: "Which option?",
                  secret: false,
                },
              ],
              kind: "form",
              title: "Input needed",
            },
            requestedBy: userId,
            runId: turn.run.id,
            threadId: thread.id,
          }),
        },
        ordinal: 3,
        type: "request.opened",
      }),
    );
    await commit(
      pendingEvent({
        ...base,
        data: {
          code: "provider_disconnected",
          message: "Provider disconnected while input was pending",
          retryable: false,
          status: "failed",
        },
        ordinal: 4,
        type: "run.failed",
      }),
    );
    expect(
      await database
        .selectFrom("requests")
        .select(["cancellationReason", "status"])
        .where("id", "=", inputRequestId)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      cancellationReason: "run-ended",
      status: "cancelled",
    });
  });

  it("settles reserved Request responses deterministically against provider cancellation", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, database } = storeFixture;
    const fixture = await startRunFixture("action-cancellation-race");
    const commit = (event: PendingAgentEvent) =>
      store.commitRunnerEvent({
        environmentId: fixture.environmentId,
        event,
        runnerBootId: fixture.runnerBootId,
        runnerId: fixture.runnerId,
      });
    const openRequest = async (requestId: RequestId, ordinal: number) => {
      await commit(
        pendingEvent({
          bindingGeneration: fixture.bindingGeneration,
          data: {
            request: liveRequest({
              harnessInstanceId: fixture.harnessInstance.id,
              id: requestId,
              presentation: {
                detail: "Confirm",
                kind: "choice",
                options: [
                  {
                    hint: "confirm",
                    id: "yes",
                    label: "Yes",
                  },
                ],
                title: "Confirm action",
              },
              requestedBy: fixture.userId,
              runId: fixture.run.id,
              threadId: fixture.thread.id,
            }),
          },
          environmentId: fixture.environmentId,
          ordinal,
          runId: fixture.run.id,
          threadId: fixture.thread.id,
          type: "request.opened",
        }),
      );
    };
    const respond = async (requestId: RequestId, suffix: string) =>
      store.enqueueRunnerControl({
        requestId,
        idempotencyKey: `action-cancellation-${suffix}`,
        requestedBy: fixture.userId,
        response: {
          kind: "choice",
          optionId: "yes",
        },
        sealedResponse: sealedTestRequestResponse(),
        runId: fixture.run.id,
        threadId: fixture.thread.id,
        expectedRevision: (await store.requests.revision(requestId))!,
        type: "request.respond",
      });
    const cancelledId = createId("request");
    await openRequest(cancelledId, 1);
    const cancelledResponse = await respond(cancelledId, "cancelled");
    await store.claimCommand(cancelledResponse.command.id, "action-cancellation-worker");
    await commit(
      pendingEvent({
        bindingGeneration: fixture.bindingGeneration,
        data: {
          requestId: cancelledId,
          reason: "source-closed",
        },
        environmentId: fixture.environmentId,
        ordinal: 2,
        runId: fixture.run.id,
        threadId: fixture.thread.id,
        type: "request.cancelled",
      }),
    );
    await expect(
      database
        .selectFrom("requests")
        .select(["cancellationReason", "responseCommandId", "status"])
        .where("id", "=", cancelledId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      cancellationReason: "source-closed",
      responseCommandId: null,
      status: "cancelled",
    });
    await expect(
      database
        .selectFrom("commands")
        .select("status")
        .where("id", "=", cancelledResponse.command.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      status: "failed",
    });
    await store.succeedCommand(cancelledResponse.command.id);
    await expect(
      database
        .selectFrom("commands")
        .select("status")
        .where("id", "=", cancelledResponse.command.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "failed" });
    const acceptedId = createId("request");
    await openRequest(acceptedId, 3);
    const acceptedResponse = await respond(acceptedId, "accepted");
    await store.claimCommand(acceptedResponse.command.id, "action-accepted-worker");
    await store.succeedCommand(acceptedResponse.command.id);
    await commit(
      pendingEvent({
        bindingGeneration: fixture.bindingGeneration,
        data: {
          requestId: acceptedId,
          reason: "source-closed",
        },
        environmentId: fixture.environmentId,
        ordinal: 4,
        runId: fixture.run.id,
        threadId: fixture.thread.id,
        type: "request.cancelled",
      }),
    );
    await expect(
      database
        .selectFrom("requests")
        .select(["cancellationReason", "response", "status"])
        .where("id", "=", acceptedId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      cancellationReason: null,
      response: {
        kind: "choice",
        optionId: "yes",
      },
      status: "fulfilled",
    });
    const authorityCancelledId = createId("request");
    await openRequest(authorityCancelledId, 5);
    const authorityCancelledResponse = await respond(authorityCancelledId, "authority-cancelled");
    await expect(store.requests.cancelForRun(fixture.run.id, "run-ended")).resolves.toEqual([
      authorityCancelledId,
    ]);
    await expect(
      database
        .selectFrom("requests")
        .select(["status", "cancellationReason"])
        .where("id", "=", authorityCancelledId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "cancelled", cancellationReason: "run-ended" });
    await expect(
      database
        .selectFrom("commands")
        .select(["lastError", "status"])
        .where("id", "=", authorityCancelledResponse.command.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      lastError: {
        message: "The Request was cancelled before its response completed",
      },
      status: "failed",
    });
    await expect(
      store.claimCommand(authorityCancelledResponse.command.id, "cancelled-response-worker"),
    ).resolves.toBeNull();
  });
  it("rejects the Runner receipt when Stop revokes authority after the response handoff", async ({
    storeFixture,
  }) => {
    const { startRunFixture, openLiveRequest, store, database, reactions } = storeFixture;
    const fixture = await startRunFixture("request-response-dispatch-fence");
    const requestId = createId("request");
    await openLiveRequest(fixture, requestId);
    const claims = (await store.runCapabilityScope(fixture.run.id))!;
    const response = await store.enqueueRunnerControl({
      idempotencyKey: "request-response-dispatch-fence",
      requestId,
      requestedBy: fixture.userId,
      response: { kind: "choice", optionId: "allow" },
      sealedResponse: sealedTestRequestResponse(),
      runId: fixture.run.id,
      threadId: fixture.thread.id,
      expectedRevision: (await store.requests.revision(requestId))!,
      type: "request.respond",
    });
    await store.claimCommand(response.command.id, "request-response-dispatch-fence-worker");
    const offered = Promise.withResolvers<void>();
    const receipt = Promise.withResolvers<void>();
    const delivery = store.dispatchRequestResponse(response.command.id, async (beforeAck) => {
      offered.resolve();
      await receipt.promise;
      await beforeAck();
    });
    void delivery.catch(offered.reject);
    try {
      await withTimeout(offered.promise, 5_000, {
        timeoutError: () => new Error("The Runner never received the Request response intent"),
      });
      expect(await store.stopHeldRun(claims, "device-access")).not.toBeNull();
    } finally {
      receipt.resolve();
      await expect(delivery).rejects.toMatchObject({ code: "conflict" });
    }
    expect(
      reactions.filter(
        (reaction) =>
          reaction.type === "requestChanged" &&
          reaction.requestId === requestId &&
          reaction.status !== "pending",
      ),
    ).toEqual([expect.objectContaining({ type: "requestChanged", status: "cancelled" })]);
    await expect(
      database
        .selectFrom("requests")
        .select(["cancellationReason", "response", "status"])
        .where("id", "=", requestId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      cancellationReason: "run-ended",
      response: null,
      status: "cancelled",
    });
  });
  it("allows a Runner infrastructure failure before run.started", async ({ storeFixture }) => {
    const { createRunFixture, enqueueHumanTrigger, store, database } = storeFixture;
    const { environmentId, runnerId, thread, userId } = await createRunFixture("startup_failure");
    const turn = await enqueueHumanTrigger({
      content: [
        {
          type: "text",
          text: "Start the provider",
        },
      ],
      idempotencyKey: "startup-failure-turn",
      requestedBy: userId,
      threadId: thread.id,
    });
    await store.claimCommand(turn.command.id, "host-worker-startup-failure");
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: thread.harnessInstanceId,
      leaseTokenHash: "lease-startup-failure",
      runnerBootId: "boot-startup-failure",
      runnerId,
      runId: turn.run.id,
      threadId: thread.id,
    });
    await store.commitRunnerEvent({
      environmentId,
      event: pendingEvent({
        bindingGeneration: binding.bindingGeneration,
        data: {
          code: "runner_start_failed",
          message: "Harness process could not start",
          retryable: false,
          status: "failed",
        },
        environmentId,
        ordinal: 0,
        runId: turn.run.id,
        threadId: thread.id,
        type: "run.failed",
      }),
      runnerBootId: "boot-startup-failure",
      runnerId,
    });
    expect(
      await database
        .selectFrom("runs")
        .select(["nextRunnerOrdinal", "startedAt", "status"])
        .where("id", "=", turn.run.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      nextRunnerOrdinal: 1,
      startedAt: null,
      status: "failed",
    });
  });
});
