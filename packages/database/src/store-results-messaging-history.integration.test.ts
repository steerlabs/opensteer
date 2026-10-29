import { createHash } from "node:crypto";
import { slackChannelProviderManifest } from "@opensteer/channel-core";
import {
  HarnessIdSchema,
  MessageContentSchema,
  createId,
  createToolOutput,
  type RunUsage,
  type RequestId,
  type Sequence,
} from "@opensteer/core";
import { type PendingAgentEvent } from "@opensteer/protocol";
import { sql } from "kysely";
import { expect } from "vitest";
import { runFromRow } from "./thread-row-mappers.js";
import { ChannelStore, OpensteerStore } from "./index.js";
import {
  describeStore,
  testModelSelection,
  testContinuationIdentity,
  testReadyHarnessCatalog,
  testMessagingRunnerId,
  replacementMessagingRunnerId,
  testChannelNotices,
  testChannelAccessPolicy,
  enrollTestRunner,
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
      content: [{ text: "Preserve this after the Run ends", type: "text" }],
      idempotencyKey: "thread-steer-terminal",
      policy: "steer",
      requestedBy: endedRun.userId,
      source: { kind: "human" },
      threadId: endedRun.thread.id,
    });
    const terminal = await store.commitRunnerEvent({
      environmentId: endedRun.environmentId,
      event: pendingEvent({
        bindingGeneration: endedRun.bindingGeneration,
        data: { status: "completed" },
        environmentId: endedRun.environmentId,
        ordinal: 1,
        runId: endedRun.run.id,
        threadId: endedRun.thread.id,
        type: "run.completed",
        workspaceId: endedRun.workspace.id,
      }),
      runnerBootId: endedRun.runnerBootId,
      runnerId: endedRun.runnerId,
    });
    expect(terminal.compensatingEvents.map(({ type }) => type)).toEqual([
      "thread-input.updated",
      "thread.state-changed",
    ]);
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
          workspaceId: fixture.workspace.id,
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
      usageEvent(2, { inputTokens: 999_999, outputTokens: 999_999 }),
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
        .set({ inputTokens: -1, outputTokens: 1 })
        .where("id", "=", fixture.run.id)
        .execute(),
    ).rejects.toThrow(/runs_usage_tokens_check/u);
    await expect(
      database
        .updateTable("runs")
        .set({ costUsd: -0.01, inputTokens: 1, outputTokens: 1 })
        .where("id", "=", fixture.run.id)
        .execute(),
    ).rejects.toThrow(/runs_cost_usd_check/u);
    await expect(
      database
        .updateTable("runs")
        .set({ inputTokens: 1 })
        .where("id", "=", fixture.run.id)
        .execute(),
    ).rejects.toThrow(/runs_usage_tokens_check/u);
  });

  it("enforces the causal Run budget atomically", async ({ storeFixture }) => {
    const { createRunFixture, enqueueHumanTrigger, database, store } = storeFixture;
    const fixture = await createRunFixture("thread-input-causal-budget");
    const source = await enqueueHumanTrigger({
      content: [{ text: "Create the causal root", type: "text" }],
      idempotencyKey: "thread-input-causal-budget-source",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    await database
      .updateTable("runs")
      .set({ status: "running" })
      .where("id", "=", source.run.id)
      .executeTakeFirstOrThrow();
    const { thread: target } = await store.createThread({
      createdBy: fixture.userId,
      environmentId: fixture.environmentId,
      harnessInstanceId: fixture.harnessInstance.id,
      idempotencyKey: "thread-input-causal-budget-target",
      modelSelection: testModelSelection,
      title: "Causal budget target",
      workspaceId: fixture.workspace.id,
    });
    await database
      .updateTable("causalChains")
      .set(({ ref }) => ({ usedAutonomousRuns: ref("maxAutonomousRuns") }))
      .where("id", "=", source.run.causalChainId)
      .executeTakeFirstOrThrow();
    const before = await database
      .selectFrom("messages")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("threadId", "=", target.id)
      .executeTakeFirstOrThrow();

    const blocked = await store.enqueueThreadInput({
      content: [{ text: "This cannot spend another Run", type: "text" }],
      idempotencyKey: "thread-input-causal-budget-blocked",
      policy: "queue",
      requestedBy: fixture.userId,
      source: { kind: "agent", runId: source.run.id },
      threadId: target.id,
    });
    expect(blocked).toMatchObject({
      command: null,
      disposition: "cancelled",
      input: { cancelReason: "causal-run-budget-exhausted", state: "cancelled" },
      run: null,
    });
    await expect(
      database
        .selectFrom("messages")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("threadId", "=", target.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: String(Number(before.count) + 1) });
  });

  it("cancels an exhausted pending chain and advances to the next FIFO root", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, database, store } = storeFixture;
    const fixture = await createRunFixture("thread-input-causal-advance");
    const source = await enqueueHumanTrigger({
      content: [{ text: "Create the chain that will later exhaust", type: "text" }],
      idempotencyKey: "thread-input-causal-advance-source",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    await database
      .updateTable("runs")
      .set({ status: "running" })
      .where("id", "=", source.run.id)
      .executeTakeFirstOrThrow();
    const { thread: target } = await store.createThread({
      createdBy: fixture.userId,
      environmentId: fixture.environmentId,
      harnessInstanceId: fixture.harnessInstance.id,
      idempotencyKey: "thread-input-causal-advance-target",
      modelSelection: testModelSelection,
      title: "Causal advance target",
      workspaceId: fixture.workspace.id,
    });
    await database
      .updateTable("causalChains")
      .set(({ ref }) => ({ usedAutonomousRuns: ref("maxAutonomousRuns") }))
      .where("id", "=", source.run.causalChainId)
      .executeTakeFirstOrThrow();
    const exhaustedHead = await store.enqueueThreadInput({
      content: [{ text: "This pending result later exhausts", type: "text" }],
      idempotencyKey: "thread-input-causal-advance-head",
      policy: "queue",
      requestedBy: fixture.userId,
      source: { kind: "agent", runId: source.run.id },
      threadId: target.id,
    });
    const independent = await store.enqueueThreadInput({
      content: [{ text: "Independent human root", type: "text" }],
      idempotencyKey: "thread-input-causal-advance-independent",
      policy: "queue",
      requestedBy: fixture.userId,
      source: { kind: "human" },
      threadId: target.id,
    });
    expect(independent).toMatchObject({
      disposition: "run-queued",
      run: { seedInputId: independent.message.id },
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
      .set({ usedAutonomousRuns: sql`max_autonomous_runs - 1` })
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
      task: [{ text: "Return the evidence", type: "text" }],
      title: "Evidence worker",
      workspaceId: fixture.workspace.id,
    });
    await store.claimCommand(delegated.command.id, "delegation-result-once-dispatcher");
    const runnerBootId = "boot-delegation-result-once";
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: fixture.harnessInstance.id,
      leaseTokenHash: "delegation-result-once-lease",
      membershipGeneration: 1,
      runnerBootId,
      runnerId: fixture.runnerId,
      runId: delegated.run.id,
      threadId: delegated.thread.id,
    });
    await store.commitRunnerEvent({
      environmentId: fixture.environmentId,
      event: pendingEvent({
        bindingGeneration: binding.bindingGeneration,
        data: { status: "running" },
        environmentId: fixture.environmentId,
        ordinal: 0,
        runId: delegated.run.id,
        threadId: delegated.thread.id,
        type: "run.started",
        workspaceId: fixture.workspace.id,
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
          content: [{ text: childResult, type: "text" }],
          messageId: childAssistantMessageId,
        },
        environmentId: fixture.environmentId,
        ordinal: 1,
        runId: delegated.run.id,
        threadId: delegated.thread.id,
        type: "assistant.message",
        workspaceId: fixture.workspace.id,
      }),
      runnerBootId,
      runnerId: fixture.runnerId,
    });
    await store.commitRunnerEvent({
      environmentId: fixture.environmentId,
      event: pendingEvent({
        bindingGeneration: fixture.bindingGeneration,
        data: { status: "completed" },
        environmentId: fixture.environmentId,
        ordinal: 1,
        runId: fixture.run.id,
        threadId: fixture.thread.id,
        type: "run.completed",
        workspaceId: fixture.workspace.id,
      }),
      runnerBootId: fixture.runnerBootId,
      runnerId: fixture.runnerId,
    });
    const completedEvent = pendingEvent({
      bindingGeneration: binding.bindingGeneration,
      data: { status: "completed" },
      environmentId: fixture.environmentId,
      ordinal: 2,
      runId: delegated.run.id,
      threadId: delegated.thread.id,
      type: "run.completed",
      workspaceId: fixture.workspace.id,
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

    // Completion is written only into the worker Workspace; the parent hears
    // through return delivery.
    const completion = completed.compensatingEvents.filter(
      ({ type }) => type === "assignment.updated",
    );
    expect(completion).toEqual([
      expect.objectContaining({
        data: {
          assignment: expect.objectContaining({
            id: delegated.assignment.id,
            returnStatus: "pending",
            status: "completed",
          }),
        },
        threadId: delegated.thread.id,
      }),
    ]);
    await expect(
      database
        .selectFrom("delegations")
        .select(["resultRunId", "resultText"])
        .where("id", "=", delegated.assignment.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ resultRunId: delegated.run.id, resultText: childResult });
    const resultEvents = await store.drainAssignmentReturn(delegated.assignment.id);
    expect(resultEvents.map(({ type }) => type)).toContain("message.created");
    expect(resultEvents.map(({ type }) => type)).toContain("run.queued");
    const settlementEvent = resultEvents.find(
      (event) => event.type === "assignment.updated" && event.threadId === fixture.thread.id,
    );
    expect(settlementEvent).toMatchObject({
      data: {
        assignment: {
          id: delegated.assignment.id,
          returnStatus: "delivered",
          status: "completed",
          resultPreview: expect.stringMatching(/^The evidence is ready/u),
        },
      },
      threadId: fixture.thread.id,
      type: "assignment.updated",
    });
    if (
      settlementEvent?.type !== "assignment.updated" ||
      !settlementEvent.data.assignment.resultPreview
    ) {
      throw new Error("Expected Assignment result preview");
    }
    expect(
      Buffer.byteLength(settlementEvent.data.assignment.resultPreview, "utf8"),
    ).toBeLessThanOrEqual(8 * 1_024);
    expect(settlementEvent.data.assignment.resultPreview).not.toBe(childResult);
    expect(replayed).toMatchObject({ compensatingEvents: [], wasDuplicate: true });
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
    expect(resultText).toMatchObject({ type: "text" });
    if (resultText?.type !== "text") throw new Error("Expected delegated result text");
    expect(resultText.text).toBe(
      `Task completed: Evidence worker\nTask Thread: ${delegated.thread.id} · Assignment: ${delegated.assignment.id}\n\n${childResult}`,
    );
    await expect(
      database
        .selectFrom("delegations")
        .select("resultMessageId")
        .where("id", "=", delegated.assignment.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ resultMessageId: results[0]!.id });
    await expect(
      database
        .selectFrom("runs")
        .select(["status", "seedInputId"])
        .where("threadId", "=", fixture.thread.id)
        .where("status", "=", "queued")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "queued", seedInputId: results[0]!.id });
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
        .set({ childThreadId: fixture.thread.id })
        .where("id", "=", delegated.assignment.id)
        .execute(),
    ).rejects.toThrow(/delegations_child_run_thread_fk/u);
    await expect(
      database
        .updateTable("delegations")
        .set({ parentThreadId: delegated.thread.id })
        .where("id", "=", delegated.assignment.id)
        .execute(),
    ).rejects.toThrow(/delegations_parent_run_thread_fk|delegations_result_message_thread_fk/u);
    await expect(
      database
        .updateTable("delegations")
        .set({ resultMessageId: childAssistantMessageId })
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
      origin: { kind: "run", parentRunId: fixture.run.id, parentThreadId: fixture.thread.id },
      task: [{ text: "Report back while the parent still runs", type: "text" }],
      title: "Delivery-unknown worker",
      workspaceId: fixture.workspace.id,
    });
    await runDelegatedTurn(fixture, delegated.run, {
      end: "completed",
      replies: ["The worker finished while the parent still runs"],
      suffix: "delegation-result-delivery-unknown-child",
    });

    const delivered = await store.drainAssignmentReturn(delegated.assignment.id);
    expect(delivered.map(({ type }) => type)).toContain("message.created");
    expect(delivered.map(({ type }) => type)).toContain("assignment.updated");
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
        data: { status: "completed" },
        environmentId: fixture.environmentId,
        ordinal: 1,
        runId: fixture.run.id,
        threadId: fixture.thread.id,
        type: "run.completed",
        workspaceId: fixture.workspace.id,
      }),
      runnerBootId: fixture.runnerBootId,
      runnerId: fixture.runnerId,
    });

    expect(terminal.compensatingEvents.map(({ type }) => type)).toEqual([
      "message.placed",
      "run.queued",
    ]);
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
    ).resolves.toEqual({ runId: null });
    await expect(
      database
        .selectFrom("runs")
        .select(["seedInputId", "status"])
        .where("threadId", "=", fixture.thread.id)
        .where("status", "=", "queued")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ seedInputId: steered.messageId, status: "queued" });
    await expect(
      database
        .selectFrom("delegations")
        .select("resultStatus")
        .where("id", "=", delegated.assignment.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ resultStatus: "delivered" });
    await expect(store.drainAssignmentReturn(delegated.assignment.id)).resolves.toEqual([]);
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
        task: [{ text: `Exercise the ${outcome} outcome`, type: "text" }],
        title: `${outcome} worker`,
        workspaceId: fixture.workspace.id,
      });
      await runDelegatedTurn(fixture, delegated.run, {
        end: outcome,
        replies: ["Checked two of the three sources"],
        suffix: `delegation-result-${outcome}-child`,
      });

      const events = await store.drainAssignmentReturn(delegated.assignment.id);
      const assignment = await database
        .selectFrom("delegations")
        .select(["status", "resultStatus", "resultText"])
        .where("id", "=", delegated.assignment.id)
        .executeTakeFirstOrThrow();
      if (outcome === "failed") {
        expect(events.map(({ type }) => type)).toContain("message.created");
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
        ).resolves.toEqual({ policy: "queue" });
      } else {
        // A person stopped this Run, not the task; a later Run continues it.
        expect(events).toEqual([]);
        expect(assignment).toEqual({ resultStatus: "pending", resultText: null, status: "open" });
      }
      await expect(store.drainAssignmentReturn(delegated.assignment.id)).resolves.toEqual([]);
    },
  );

  it.for(["archived-thread", "deleting-workspace"] as const)(
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
        task: [{ text: "Return even if the parent can no longer run", type: "text" }],
        title: `Invalid parent worker ${invalidParent}`,
        workspaceId: fixture.workspace.id,
      });
      await runDelegatedTurn(fixture, delegated.run, {
        end: "completed",
        replies: ["Completed before the parent lost authority"],
        suffix: `delegation-invalid-parent-${invalidParent}-child`,
      });
      const now = new Date();
      await database
        .updateTable("runs")
        .set({ completedAt: now, status: "completed" })
        .where("id", "=", fixture.run.id)
        .execute();
      if (invalidParent === "archived-thread") {
        await database
          .updateTable("threads")
          .set({ status: "archived", updatedAt: now })
          .where("id", "=", fixture.thread.id)
          .executeTakeFirstOrThrow();
      } else {
        await database
          .updateTable("workspaces")
          .set({
            deletionRequestedAt: now,
            deletionRequestedBy: fixture.userId,
            purgeAfter: new Date(now.getTime() + 60_000),
            status: "deleting",
            updatedAt: now,
          })
          .where("id", "=", fixture.workspace.id)
          .executeTakeFirstOrThrow();
      }

      const events = await store.drainAssignmentReturn(delegated.assignment.id);
      expect(events).toContainEqual(
        expect.objectContaining({
          data: expect.objectContaining({
            assignment: expect.objectContaining({
              id: delegated.assignment.id,
              returnStatus: "undeliverable",
              status: "completed",
            }),
          }),
          threadId: fixture.thread.id,
          type: "assignment.updated",
        }),
      );
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
      await expect(store.drainAssignmentReturn(delegated.assignment.id)).resolves.toEqual([]);
    },
  );

  it("charges delegation fan-out once per causal root and not per lifetime Thread", async ({
    storeFixture,
  }) => {
    const { startRunFixture, database, store } = storeFixture;
    const fixture = await startRunFixture("delegation-causal-budget");
    await database
      .updateTable("causalChains")
      .set({ maxDelegations: 1 })
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
      task: [{ text: "Use the only delegation slot", type: "text" as const }],
      title: "Only child",
      workspaceId: fixture.workspace.id,
    };
    const first = await store.delegateThread(request);
    await expect(store.delegateThread(request)).resolves.toMatchObject({
      thread: { id: first.thread.id },
      wasDuplicate: true,
    });
    await expect(
      store.delegateThread({
        ...request,
        idempotencyKey: "delegation-causal-budget-second",
        title: "Over budget child",
      }),
    ).rejects.toMatchObject({ code: "resource_exhausted" });
    await expect(
      database
        .selectFrom("causalChains")
        .select(["maxDelegations", "usedDelegations"])
        .where("id", "=", fixture.run.causalChainId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ maxDelegations: 1, usedDelegations: 1 });
  });

  it("admits the next FIFO Run only after completion and allows one claim winner", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, database } = storeFixture;
    const started = await startRunFixture("thread-input-concurrent-claim");
    const pending = await store.enqueueThreadInput({
      content: [{ text: "Run after the active work", type: "text" }],
      idempotencyKey: "thread-input-concurrent-claim",
      policy: "queue",
      requestedBy: started.userId,
      source: { kind: "human" },
      threadId: started.thread.id,
    });
    expect(pending).toMatchObject({ command: null, run: null, disposition: "pending" });
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
        data: { status: "completed" },
        environmentId: started.environmentId,
        ordinal: 1,
        runId: started.run.id,
        threadId: started.thread.id,
        type: "run.completed",
        workspaceId: started.workspace.id,
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
      new OpensteerStore(database).claimCommand(queuedCommand.id, "thread-input-claim-d"),
    ]);
    expect(afterTerminal.filter((claim) => claim !== null)).toHaveLength(1);
  });

  it("interrupts a queued Run and pauses the remaining work queue", async ({ storeFixture }) => {
    const { createRunFixture, store, database } = storeFixture;
    const fixture = await createRunFixture("queued-interrupt-activation");
    const seed = await store.enqueueThreadInput({
      content: [{ text: "Hold this oldest input", type: "text" }],
      idempotencyKey: "queued-interrupt-seed",
      policy: "queue",
      requestedBy: fixture.userId,
      source: { kind: "human" },
      threadId: fixture.thread.id,
    });
    const activation = await store.enqueueThreadInput({
      content: [{ text: "Start the queued work", type: "text" }],
      idempotencyKey: "queued-interrupt-activation",
      policy: "queue",
      requestedBy: fixture.userId,
      source: { kind: "human" },
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
        { messageId: seed.message.id, state: "cancelled" },
        { messageId: activation.message.id, state: "pending" },
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
    ).resolves.toEqual({ inputQueuePaused: true });
    const resumed = await store.resumeThreadInputQueue({
      idempotencyKey: "queued-interrupt-resume",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    expect(resumed.thread.inputQueuePaused).toBe(false);
    expect(resumed.events.map(({ type }) => type)).toEqual([
      "thread.input-queue-updated",
      "message.placed",
      "run.queued",
      "thread.state-changed",
    ]);
    await expect(
      database
        .selectFrom("runs")
        .select(["seedInputId", "status"])
        .where("threadId", "=", fixture.thread.id)
        .where("status", "=", "queued")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ seedInputId: activation.message.id, status: "queued" });
  });

  it("adopts channel ingress with explicit authority and durably delivers the reply", async ({
    storeFixture,
  }) => {
    const { enrollMessagingRunner, store, recordReadyHarnessCatalog, database } = storeFixture;
    await enrollMessagingRunner(testMessagingRunnerId, "Test messaging service");
    const userId = await store.createUser("Channel owner");
    const runnerId = createId("runner");
    const environmentId = createId("environment");
    await enrollTestRunner(store, {
      createdBy: userId,
      environmentId,
      name: "Channel runner",
      runnerId,
      tokenSuffix: "channel-ingress-delivery",
    });
    const workspace = await store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: "wsp_channel_ingress_delivery",
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: userId,
      idempotencyKey: "workspace-channel-ingress-delivery",
      name: "Channel Workspace",
      status: "ready",
    });
    const harness = await store.createHarnessInstance({
      config: { model: "test" },
      driverKind: HarnessIdSchema.parse("native"),
      environmentId,
      name: "Channel native harness",
      stateKind: "isolated",
    });
    await recordReadyHarnessCatalog(environmentId, harness);
    const credential = {
      encryptedPayload: Buffer.from("encrypted-channel-credential"),
      encryptionKeyVersion: 1,
      id: createId("credential"),
      name: "Slack bot",
      ownerId: userId,
      provider: "channel:slack",
    } as const;
    const channels = new ChannelStore(database);
    const configured = await channels.createConnection({
      accessPolicy: testChannelAccessPolicy("anyone"),
      account: {
        displayName: "Opensteer",
        externalAccountId: "T-CHANNEL-TEST",
        handle: "@opensteer",
        routingMode: "dedicated",
      },
      connection: {
        capabilities: ["messages", "threads"],
        runnerId: testMessagingRunnerId,
        connectionMethod: "bring-your-own",
        displayName: "Test Slack",
        externalIdentityId: "U-BOT-CHANNEL-TEST",
        externalTenantId: "T-CHANNEL-TEST",
        provider: "slack",
        transportKind: "socket",
      },
      createdBy: userId,
      credential,
      executionPolicy: { harness: "default", harnessInstanceId: null },
      selector: {
        conversationId: null,
        conversationType: null,
        scopeId: null,
        threadId: null,
      },
      workspaceId: workspace.id,
    });
    await channels.setRuntimeConnectionHealth({
      connectionId: configured.connection.id,
      detail: null,
      reason: null,
      runnerId: testMessagingRunnerId,
      status: "connected",
    });
    const duplicateCredential = {
      encryptedPayload: Buffer.from("duplicate-bot-credential"),
      encryptionKeyVersion: 1,
      id: createId("credential"),
      name: "Duplicate Slack bot",
      ownerId: userId,
      provider: "channel:slack",
    } as const;
    await expect(
      channels.createConnection({
        accessPolicy: testChannelAccessPolicy("anyone"),
        account: {
          displayName: "Opensteer duplicate",
          externalAccountId: "T-CHANNEL-TEST",
          routingMode: "dedicated",
        },
        connection: {
          runnerId: testMessagingRunnerId,
          connectionMethod: "bring-your-own",
          displayName: "Duplicate Test Slack",
          externalIdentityId: "U-BOT-CHANNEL-TEST",
          externalTenantId: "T-CHANNEL-TEST",
          provider: "slack",
          transportKind: "socket",
        },
        createdBy: userId,
        credential: duplicateCredential,
        executionPolicy: { harness: "default", harnessInstanceId: null },
        selector: {
          conversationId: null,
          conversationType: null,
          scopeId: null,
          threadId: null,
        },
        workspaceId: workspace.id,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      channels.createBinding({
        accessPolicy: testChannelAccessPolicy("anyone"),
        accountId: configured.account.id,
        createdBy: userId,
        executionPolicy: { harness: "default", harnessInstanceId: null },
        selector: {
          conversationId: "C-OTHER",
          conversationType: null,
          scopeId: "T-CHANNEL-TEST",
          threadId: null,
        },
        workspaceId: workspace.id,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    const event = {
      accountExternalId: "T-CHANNEL-TEST",
      actor: { displayName: "External operator", externalUserId: "U-EXTERNAL" },
      content: [{ text: "Investigate this", type: "text" as const }],
      conversation: {
        displayName: "operations",
        externalConversationId: "C-OPERATIONS",
        externalScopeId: "T-CHANNEL-TEST",
        externalThreadId: "1786320000.000100",
        type: "channel" as const,
      },
      eventId: "Ev-CHANNEL-1",
      occurredAt: new Date().toISOString(),
      provider: "slack" as const,
      providerMessageId: "1786320000.000100",
      trigger: "mention" as const,
    };
    const committed = await channels.commitIngress(configured.connection.id, event);
    const duplicate = await channels.commitIngress(configured.connection.id, event);
    expect(duplicate).toMatchObject({ duplicate: true, ingressId: committed.ingressId });

    const ingress = await channels.claimIngress("channel-ingress-worker");
    expect(ingress?.id).toBe(committed.ingressId);
    const adopted = await channels.adoptIngress({
      claimToken: ingress!.claimToken,
      ingressId: ingress!.id,
      notices: testChannelNotices,
      placementCandidates: [{ environmentId, harnessInstanceId: harness.id }],
    });
    expect(adopted).toMatchObject({
      kind: "adopted",
      run: { requestedBy: userId, status: "queued" },
    });
    if (adopted.kind !== "adopted" || !adopted.run) {
      throw new Error("Expected channel ingress adoption to queue a Run");
    }
    expect(adopted.events.map(({ type }) => type)).toEqual([
      "thread.created",
      "message.created",
      "message.placed",
      "run.queued",
      "thread.state-changed",
    ]);

    const followupCommitted = await channels.commitIngress(configured.connection.id, {
      ...event,
      content: [{ text: "Queue this after the investigation", type: "text" as const }],
      eventId: "Ev-CHANNEL-2",
      providerMessageId: "1786320001.000200",
      trigger: "conversation-followup",
    });
    const followupIngress = await channels.claimIngress("channel-followup-worker");
    expect(followupIngress?.id).toBe(followupCommitted.ingressId);
    const followup = await channels.adoptIngress({
      claimToken: followupIngress!.claimToken,
      ingressId: followupIngress!.id,
      notices: testChannelNotices,
      placementCandidates: [{ environmentId, harnessInstanceId: harness.id }],
    });
    expect(followup).toMatchObject({ kind: "adopted", run: null });
    if (followup.kind !== "adopted") throw new Error("Expected channel follow-up adoption");
    expect(followup.events.map(({ type }) => type)).toEqual(["message.created"]);
    const followupRow = await database
      .selectFrom("channelIngressEvents")
      .innerJoin("threadInputs", "threadInputs.messageId", "channelIngressEvents.messageId")
      .select(["threadInputs.replyTarget", "threadInputs.runId", "threadInputs.state"])
      .where("channelIngressEvents.id", "=", followupCommitted.ingressId)
      .executeTakeFirstOrThrow();
    expect(followupRow).toEqual({
      replyTarget: adopted.run.replyTarget,
      runId: null,
      state: "pending",
    });

    // `anyone` access resolved to the route's creator, not to the sender, so
    // the Thread runs on the Workspace profile even though that creator owns
    // this Workspace.
    await expect(
      database
        .selectFrom("threads")
        .select("capabilityProfileId")
        .where("id", "=", adopted.run.threadId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ capabilityProfileId: "workspace" });

    const attribution = await database
      .selectFrom("runs")
      .innerJoin("principals", "principals.id", "runs.actorPrincipalId")
      .select([
        "principals.kind",
        "runs.actorPrincipalId",
        "runs.authoritySource",
        "runs.requestedBy",
      ])
      .where("runs.id", "=", adopted.run.id)
      .executeTakeFirstOrThrow();
    expect(attribution).toMatchObject({
      authoritySource: {
        bindingId: configured.binding.id,
        bindingRevision: configured.binding.revision,
        kind: "channel-ingress",
      },
      kind: "channel-identity",
      requestedBy: userId,
    });

    const command = await store.claimNextCommand(environmentId, "channel-command-worker");
    expect(command?.command.runId).toBe(adopted.run.id);
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: harness.id,
      leaseTokenHash: "channel-run-lease",
      membershipGeneration: 1,
      runnerBootId: "channel-run-boot",
      runnerId,
      runId: adopted.run.id,
      threadId: adopted.run.threadId,
    });
    await store.commitRunnerEvent({
      environmentId,
      event: pendingEvent({
        bindingGeneration: binding.bindingGeneration,
        data: { status: "running" },
        environmentId,
        ordinal: 0,
        runId: adopted.run.id,
        threadId: adopted.run.threadId,
        type: "run.started",
        workspaceId: workspace.id,
      }),
      runnerBootId: "channel-run-boot",
      runnerId,
    });
    const replyMessageId = createId("message");
    await store.commitRunnerEvent({
      environmentId,
      event: pendingEvent({
        bindingGeneration: binding.bindingGeneration,
        data: {
          content: [{ text: "Investigation complete", type: "text" }],
          messageId: replyMessageId,
        },
        environmentId,
        ordinal: 1,
        runId: adopted.run.id,
        threadId: adopted.run.threadId,
        type: "assistant.message",
        workspaceId: workspace.id,
      }),
      runnerBootId: "channel-run-boot",
      runnerId,
    });
    // The reply is sent once the Run completes, not as it is written.
    await expect(channels.claimDelivery(testMessagingRunnerId)).resolves.toBeNull();
    await store.commitRunnerEvent({
      environmentId,
      event: pendingEvent({
        bindingGeneration: binding.bindingGeneration,
        data: { status: "completed" },
        environmentId,
        ordinal: 2,
        runId: adopted.run.id,
        threadId: adopted.run.threadId,
        type: "run.completed",
        workspaceId: workspace.id,
      }),
      runnerBootId: "channel-run-boot",
      runnerId,
    });

    const delivery = await channels.claimDelivery(testMessagingRunnerId);
    expect(delivery).toMatchObject({
      connection: { provider: "slack" },
      delivery: {
        audience: "conversation",
        content: [{ text: "Investigation complete", type: "text" }],
        kind: "reply",
        messageId: replyMessageId,
        status: "leased",
      },
      destination: {
        externalConversationId: "C-OPERATIONS",
        externalScopeId: "T-CHANNEL-TEST",
        externalThreadId: "1786320000.000100",
        externalUserId: null,
      },
      mayHaveBeenSent: false,
    });
    await channels.startDeliveryAttempt(delivery!.delivery.id, delivery!.claimToken);
    await channels.finishDelivery({
      claimToken: delivery!.claimToken,
      deliveryId: delivery!.delivery.id,
      outcome: "sent",
      receipt: { providerMessageId: "1786320001.000200" },
    });
    await expect(
      database
        .selectFrom("channelDeliveries")
        .select(["attempts", "receipt", "status"])
        .where("id", "=", delivery!.delivery.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      attempts: 1,
      receipt: { providerMessageId: "1786320001.000200" },
      status: "sent",
    });

    const secondWorkspace = await store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: "wsp_second_dedicated_bot",
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: userId,
      idempotencyKey: "workspace-second-dedicated-bot",
      name: "Research Workspace",
      status: "ready",
    });
    const secondCredential = {
      encryptedPayload: Buffer.from("second-bot-credential"),
      encryptionKeyVersion: 1,
      id: createId("credential"),
      name: "Research Slack bot",
      ownerId: userId,
      provider: "channel:slack",
    } as const;
    const secondBot = await channels.createConnection({
      accessPolicy: testChannelAccessPolicy("anyone"),
      account: {
        displayName: "Research Bot",
        externalAccountId: "T-CHANNEL-TEST",
        handle: "@research",
        routingMode: "dedicated",
      },
      connection: {
        runnerId: testMessagingRunnerId,
        connectionMethod: "bring-your-own",
        displayName: "Research Bot · Test Slack",
        externalIdentityId: "U-BOT-RESEARCH",
        externalTenantId: "T-CHANNEL-TEST",
        provider: "slack",
        transportKind: "socket",
      },
      createdBy: userId,
      credential: secondCredential,
      executionPolicy: { harness: "default", harnessInstanceId: null },
      selector: {
        conversationId: null,
        conversationType: null,
        scopeId: null,
        threadId: null,
      },
      workspaceId: secondWorkspace.id,
    });
    await channels.setRuntimeConnectionHealth({
      connectionId: secondBot.connection.id,
      detail: null,
      reason: null,
      runnerId: testMessagingRunnerId,
      status: "connected",
    });
    const unownedReply = {
      ...event,
      content: [{ text: "Do not claim an unaddressed thread", type: "text" as const }],
      conversation: {
        ...event.conversation,
        externalThreadId: "1786320200.000100",
      },
      eventId: "Ev-CHANNEL-UNOWNED-REPLY",
      providerMessageId: "1786320201.000200",
      trigger: "conversation-followup" as const,
    };
    const unownedCommitted = await channels.commitIngress(secondBot.connection.id, unownedReply);
    const unownedIngress = await channels.claimIngress("unowned-thread-worker");
    expect(unownedIngress?.id).toBe(unownedCommitted.ingressId);
    await expect(
      channels.adoptIngress({
        claimToken: unownedIngress!.claimToken,
        ingressId: unownedIngress!.id,
        notices: testChannelNotices,
        placementCandidates: [{ environmentId, harnessInstanceId: harness.id }],
      }),
    ).resolves.toEqual({ identityId: null, kind: "ignored", reason: "conversation-not-owned" });

    const foreignReply = {
      ...event,
      content: [{ text: "Only the owning bot should receive this", type: "text" as const }],
      eventId: "Ev-CHANNEL-FOREIGN-REPLY",
      providerMessageId: "1786320002.000300",
      trigger: "conversation-followup" as const,
    };
    const foreignCommitted = await channels.commitIngress(secondBot.connection.id, foreignReply);
    const foreignIngress = await channels.claimIngress("foreign-bot-worker");
    expect(foreignIngress?.id).toBe(foreignCommitted.ingressId);
    await expect(
      channels.adoptIngress({
        claimToken: foreignIngress!.claimToken,
        ingressId: foreignIngress!.id,
        notices: testChannelNotices,
        placementCandidates: [{ environmentId, harnessInstanceId: harness.id }],
      }),
    ).resolves.toEqual({
      identityId: null,
      kind: "ignored",
      reason: "conversation-owned-by-another-identity",
    });

    const secondMention = {
      ...event,
      content: [{ text: "Start independent research", type: "text" as const }],
      conversation: {
        ...event.conversation,
        externalThreadId: "1786320100.000100",
      },
      eventId: "Ev-CHANNEL-SECOND-BOT",
      providerMessageId: "1786320100.000100",
      trigger: "mention" as const,
    };
    const secondCommitted = await channels.commitIngress(secondBot.connection.id, secondMention);
    const secondIngress = await channels.claimIngress("second-bot-worker");
    expect(secondIngress?.id).toBe(secondCommitted.ingressId);
    const secondAdopted = await channels.adoptIngress({
      claimToken: secondIngress!.claimToken,
      ingressId: secondIngress!.id,
      notices: testChannelNotices,
      placementCandidates: [{ environmentId, harnessInstanceId: harness.id }],
    });
    expect(secondAdopted).toMatchObject({ kind: "adopted" });
    if (secondAdopted.kind !== "adopted" || !secondAdopted.run) {
      throw new Error("Expected second bot adoption to queue a Run");
    }
    await expect(
      database
        .selectFrom("threads")
        .select("workspaceId")
        .where("id", "=", secondAdopted.run.threadId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ workspaceId: secondWorkspace.id });

    await enrollMessagingRunner(replacementMessagingRunnerId, "Replacement messaging service");
    await channels.reassignDisconnectedRuntimeConnections({
      capabilities: [
        {
          manifest: slackChannelProviderManifest,
          provider: "slack",
          transportKinds: ["socket"],
        },
      ],
      connectedRunnerIds: [replacementMessagingRunnerId],
      runnerId: replacementMessagingRunnerId,
    });
    await expect(channels.assignedRuntimeConnections(testMessagingRunnerId)).resolves.toEqual([]);
    await expect(
      channels.assignedRuntimeConnections(replacementMessagingRunnerId),
    ).resolves.toHaveLength(2);
  });

  it("takes the channel Thread's model from the account's catalog, never from a guess", async ({
    storeFixture,
  }) => {
    const { createChannelNoticeFixture, store, database } = storeFixture;
    const fixture = await createChannelNoticeFixture("model", { accessMode: "anyone" });
    const catalog = testReadyHarnessCatalog(fixture.fixture.harnessInstance.id);
    const record = (models: typeof catalog.models) =>
      store.recordHarnessCatalogs({
        catalogs: [{ ...catalog, models }],
        environmentId: fixture.fixture.environmentId,
        expectedRevisions: new Map([
          [fixture.fixture.harnessInstance.id, fixture.fixture.harnessInstance.runtimeRevision],
        ]),
      });
    const threadModel = async (result: Awaited<ReturnType<typeof fixture.adopt>>) => {
      if (result.result.kind !== "adopted" || !result.result.run) {
        throw new Error("Expected channel ingress adoption to queue a Run");
      }
      return database
        .selectFrom("threads")
        .select("modelSelection")
        .where("id", "=", result.result.run.threadId)
        .executeTakeFirstOrThrow();
    };

    await expect(
      threadModel(await fixture.adopt({ eventId: "Ev-MODEL-1", type: "dm" })),
    ).resolves.toEqual({
      modelSelection: {
        modelId: testModelSelection.modelId,
        options: {},
        providerId: testModelSelection.providerId,
      },
    });

    // The catalog's default carries its endpoint's own spelling, exactly as a
    // person's selection of that model would. A new conversation, so a new
    // Thread is created from the catalog rather than continued.
    await record(
      catalog.models.map((model) =>
        model.isDefault ? { ...model, nativeModelId: `gateway/${model.modelId}` } : model,
      ),
    );
    await expect(
      threadModel(await fixture.adopt({ eventId: "Ev-MODEL-2", type: "channel" })),
    ).resolves.toEqual({
      modelSelection: {
        modelId: testModelSelection.modelId,
        nativeModelId: `gateway/${testModelSelection.modelId}`,
        options: {},
        providerId: testModelSelection.providerId,
      },
    });

    // A ready catalog that marks nothing default is a driver contract the Host
    // cannot satisfy, and it is refused rather than guessed at — for a
    // continued conversation as much as a new one. The refused event goes back
    // to its lane with a backoff, so the remaining case uses the other one.
    await record(catalog.models.map((model) => ({ ...model, isDefault: false })));
    await expect(fixture.adopt({ eventId: "Ev-MODEL-3", type: "dm" })).rejects.toMatchObject({
      code: "conflict",
      message: "Selected AI engine reports no default model",
    });

    // The account has reported nothing yet: there is no bundled pair to fall
    // back to, so the message waits for the Runner's answer instead of
    // starting a Thread on a model the account may not offer.
    await store.discardHarnessCatalog(
      fixture.fixture.environmentId,
      fixture.fixture.harnessInstance.id,
    );
    await expect(fixture.adopt({ eventId: "Ev-MODEL-4", type: "channel" })).rejects.toThrow(
      /reported no models yet/u,
    );
  });

  it("persists approval before a Thread and runs only after owner review and resend", async ({
    storeFixture,
  }) => {
    const { createChannelNoticeFixture, database } = storeFixture;
    const fixture = await createChannelNoticeFixture("approval", { accessMode: "approved" });

    const requested = await fixture.adopt({ eventId: "Ev-APPROVAL-1", type: "dm" });
    expect(requested.result).toMatchObject({ kind: "ignored", reason: "approval-pending" });
    await expect(
      database
        .selectFrom("channelAccessGrants")
        .select(["revision", "status"])
        .where("bindingId", "=", fixture.configured.binding.id)
        .where("externalUserId", "=", "U-approval")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ revision: 1, status: "pending" });
    await expect(
      database
        .selectFrom("channelConversations")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("accountId", "=", fixture.configured.account.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: "0" });

    const approved = await fixture.channels.reviewAccess({
      bindingId: fixture.configured.binding.id,
      decision: "approved",
      expectedRevision: 1,
      externalUserId: "U-approval",
      ownerUserId: fixture.fixture.userId,
    });
    expect(approved).toMatchObject({ revision: 2, status: "approved" });
    const requestNotices = await fixture.notices(requested.ingressId);
    expect(requestNotices).toHaveLength(2);
    expect(JSON.stringify(requestNotices)).toContain("Send your message again");
    await expect(
      fixture.channels.reviewAccess({
        bindingId: fixture.configured.binding.id,
        decision: "revoked",
        expectedRevision: 1,
        externalUserId: "U-approval",
        ownerUserId: fixture.fixture.userId,
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    const resent = await fixture.adopt({ eventId: "Ev-APPROVAL-2", type: "dm" });
    expect(resent.result).toMatchObject({ kind: "adopted" });
    if (resent.result.kind !== "adopted" || !resent.result.run) {
      throw new Error("Expected approved resend to queue a Run");
    }
    expect(resent.result.run.requestedBy).toBe(fixture.fixture.userId);
    await expect(
      database
        .selectFrom("threads")
        .select(["capabilityProfileId", "parentThreadId"])
        .where("id", "=", resent.result.run.threadId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ capabilityProfileId: "workspace", parentThreadId: null });

    const revoked = await fixture.channels.reviewAccess({
      bindingId: fixture.configured.binding.id,
      decision: "revoked",
      expectedRevision: 2,
      externalUserId: "U-approval",
      ownerUserId: fixture.fixture.userId,
    });
    expect(revoked).toMatchObject({ revision: 3, status: "revoked" });
    const afterRevoke = await fixture.adopt({ eventId: "Ev-APPROVAL-3", type: "dm" });
    expect(afterRevoke.result).toMatchObject({ kind: "ignored", reason: "approval-pending" });
    await expect(
      fixture.channels.dashboard(fixture.fixture.userId, [slackChannelProviderManifest], []),
    ).resolves.toMatchObject({ accessGrants: [expect.objectContaining({ status: "revoked" })] });
    await fixture.channels.revokeBinding({
      bindingId: fixture.configured.binding.id,
      ownerUserId: fixture.fixture.userId,
    });
    await expect(
      fixture.channels.dashboard(fixture.fixture.userId, [slackChannelProviderManifest], []),
    ).resolves.toMatchObject({ accessGrants: [] });
  });

  it("does not adopt ingress that was committed before its connection paused", async ({
    storeFixture,
  }) => {
    const { createChannelNoticeFixture, database } = storeFixture;
    const fixture = await createChannelNoticeFixture("pause", { accessMode: "anyone" });
    const committed = await fixture.channels.commitIngress(
      fixture.configured.connection.id,
      fixture.event({ eventId: "Ev-PAUSE-1", type: "dm" }),
    );
    const claimed = await fixture.claimFor(committed.ingressId);

    await fixture.channels.setConnectionStatus(
      fixture.configured.connection.id,
      fixture.fixture.userId,
      "paused",
    );
    await expect(
      fixture.channels.adoptIngress({
        claimToken: claimed.claimToken,
        ingressId: claimed.id,
        notices: testChannelNotices,
        placementCandidates: fixture.placementCandidates,
      }),
    ).resolves.toMatchObject({ kind: "ignored", reason: "no-route" });
    await expect(
      database
        .selectFrom("channelConversations")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("accountId", "=", fixture.configured.account.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: "0" });
  });

  it("answers an unlinked sender in the transaction that ignored their message", async ({
    storeFixture,
  }) => {
    const { createChannelNoticeFixture, database } = storeFixture;
    const fixture = await createChannelNoticeFixture("link");

    const first = await fixture.adopt({ eventId: "Ev-NOTICE-LINK-1" });

    expect(first.result).toMatchObject({ kind: "ignored", reason: "identity-not-authorized" });
    // The ignored row and the answer to it are one write, so there is no state
    // in which the message is closed and the person was told nothing.
    await expect(
      database
        .selectFrom("channelIngressEvents")
        .select(["processedAt", "status"])
        .where("id", "=", first.ingressId)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ status: "ignored" });
    const answered = await fixture.notices(first.ingressId);
    expect(answered).toHaveLength(1);
    expect(answered[0]).toMatchObject({ audience: "actor", kind: "status", status: "pending" });
    const code = /\*\*([A-HJ-NP-Z2-9]{8})\*\*/u.exec(JSON.stringify(answered[0]?.content))?.[1];
    expect(code).toBeDefined();

    // An explicitly addressed retry replaces the old code, so the latest
    // private notice always contains the one redeemable value.
    const second = await fixture.adopt({ eventId: "Ev-NOTICE-LINK-2" });
    expect(second.result).toMatchObject({ reason: "identity-not-authorized" });
    const secondAnswer = await fixture.notices(second.ingressId);
    expect(secondAnswer).toMatchObject([{ audience: "actor", kind: "status" }]);
    const latestCode = /\*\*([A-HJ-NP-Z2-9]{8})\*\*/u.exec(
      JSON.stringify(secondAnswer[0]?.content),
    )?.[1];
    expect(latestCode).toBeDefined();
    expect(latestCode).not.toBe(code);
    await expect(
      database
        .selectFrom("channelLinkCodes")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("accountId", "=", fixture.configured.account.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: "1" });
    await expect(
      fixture.channels.linkIdentity({
        codeHash: createHash("sha256")
          .update(code ?? "")
          .digest("base64url"),
        userId: fixture.fixture.userId,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    // The latest code is stored hashed, and the one the person was handed is
    // what redeems it — the Host hashes nothing on its way in any more.
    await expect(
      fixture.channels.linkIdentity({
        codeHash: createHash("sha256")
          .update(latestCode ?? "")
          .digest("base64url"),
        userId: fixture.fixture.userId,
      }),
    ).resolves.toMatchObject({ identity: { externalUserId: "U-link" } });
  });

  it.for([
    {
      label: "Personal with local-directory storage",
      runFixture: {
        deploymentShape: {
          defaultWorkspaceBacking: "local-directory" as const,
          kind: "personal" as const,
        },
        workspaceBacking: "local-directory" as const,
      },
      suffix: "personal-local",
    },
    {
      label: "Server with local-directory storage",
      runFixture: {
        deploymentShape: {
          defaultWorkspaceBacking: "local-directory" as const,
          kind: "server" as const,
        },
        workspaceBacking: "local-directory" as const,
      },
      suffix: "server-local",
    },
    {
      label: "Server with PortableFS storage",
      runFixture: {
        deploymentShape: {
          defaultWorkspaceBacking: "portablefs" as const,
          kind: "server" as const,
        },
        workspaceBacking: "portablefs" as const,
      },
      suffix: "server-portable",
    },
  ])(
    "$label keeps shared messaging on a fresh Workspace context",
    async ({ runFixture, suffix }, { storeFixture }) => {
      const { createChannelNoticeFixture, database } = storeFixture;
      const fixture = await createChannelNoticeFixture(`shape-${suffix}`, { runFixture });
      const linkOffer = await fixture.adopt({
        eventId: `Ev-${suffix}-LINK`,
        externalUserId: `U-${suffix}-OWNER`,
      });
      expect(linkOffer.result).toMatchObject({
        kind: "ignored",
        reason: "identity-not-authorized",
      });
      const linkNotices = await fixture.notices(linkOffer.ingressId);
      const code = /\*\*([A-HJ-NP-Z2-9]{8})\*\*/u.exec(
        JSON.stringify(linkNotices[0]?.content),
      )?.[1];
      expect(code).toBeDefined();
      await fixture.channels.linkIdentity({
        codeHash: createHash("sha256")
          .update(code ?? "")
          .digest("base64url"),
        userId: fixture.fixture.userId,
      });

      const linkedOwner = await fixture.adopt({
        eventId: `Ev-${suffix}-OWNER`,
        externalUserId: `U-${suffix}-OWNER`,
      });
      expect(linkedOwner.result).toMatchObject({ kind: "adopted" });
      if (linkedOwner.result.kind !== "adopted" || !linkedOwner.result.run) {
        throw new Error("Expected the linked owner message to queue a Run");
      }

      const updated = await fixture.channels.updateBinding({
        accessPolicy: testChannelAccessPolicy("anyone"),
        bindingId: fixture.configured.binding.id,
        expectedRevision: fixture.configured.binding.revision,
        ownerUserId: fixture.fixture.userId,
      });
      expect(updated.revision).toBe(2);
      const externalSender = await fixture.adopt({
        displayName: "Unlinked external sender",
        eventId: `Ev-${suffix}-EXTERNAL`,
        externalUserId: `U-${suffix}-EXTERNAL`,
      });
      expect(externalSender.result).toMatchObject({ kind: "adopted" });
      if (externalSender.result.kind !== "adopted" || !externalSender.result.run) {
        throw new Error("Expected the unlinked shared sender message to queue a Run");
      }

      expect(externalSender.result.run.requestedBy).toBe(fixture.fixture.userId);
      expect(externalSender.result.run.threadId).not.toBe(linkedOwner.result.run.threadId);
      const messagingThreads = await database
        .selectFrom("threads")
        .select(["capabilityProfileId", "createdBy", "id", "parentThreadId"])
        .where("id", "in", [linkedOwner.result.run.threadId, externalSender.result.run.threadId])
        .orderBy("id", "asc")
        .execute();
      expect(messagingThreads).toHaveLength(2);
      expect(messagingThreads).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            capabilityProfileId: "workspace",
            createdBy: fixture.fixture.userId,
            parentThreadId: null,
          }),
          expect.objectContaining({
            capabilityProfileId: "workspace",
            createdBy: fixture.fixture.userId,
            parentThreadId: null,
          }),
        ]),
      );
      await expect(
        database
          .selectFrom("channelConversationContexts")
          .select(["activeThreadId", "authorityUserId", "bindingRevision"])
          .where("authorityUserId", "=", fixture.fixture.userId)
          .execute(),
      ).resolves.toEqual([
        {
          activeThreadId: externalSender.result.run.threadId,
          authorityUserId: fixture.fixture.userId,
          bindingRevision: 2,
        },
      ]);
    },
  );

  it("tells an explicitly addressed sender that nothing routes their conversation", async ({
    storeFixture,
  }) => {
    const { createChannelNoticeFixture } = storeFixture;
    const fixture = await createChannelNoticeFixture("route");

    await fixture.channels.revokeBinding({
      bindingId: fixture.configured.binding.id,
      ownerUserId: fixture.fixture.userId,
    });
    const declined = await fixture.adopt({ eventId: "Ev-NOTICE-ROUTE-1" });

    expect(declined.result).toMatchObject({ kind: "ignored", reason: "no-route" });
    expect(await fixture.notices(declined.ingressId)).toMatchObject([
      { audience: "actor", kind: "status" },
    ]);
    expect(JSON.stringify((await fixture.notices(declined.ingressId))[0]?.content)).toContain(
      testChannelNotices.noRoute,
    );

    // A message the bot merely overheard is not an occasion to explain itself.
    const overheard = await fixture.adopt({
      eventId: "Ev-NOTICE-ROUTE-2",
      trigger: "conversation-followup",
    });
    expect(overheard.result).toMatchObject({ kind: "ignored" });
    expect(await fixture.notices(overheard.ingressId)).toEqual([]);
  });

  it("sends a channel to a direct message when the provider cannot whisper", async ({
    storeFixture,
  }) => {
    const { createChannelNoticeFixture, database } = storeFixture;
    const whisperless = [
      { ...slackChannelProviderManifest, actorDelivery: "direct-message-only" as const },
    ];
    const fixture = await createChannelNoticeFixture("whisper", { providers: whisperless });

    const inChannel = await fixture.adopt({ eventId: "Ev-NOTICE-WHISPER-1" });

    // A code posted where the rest of the room can read it is not a secret, so
    // the room is told how to ask for one privately instead.
    expect(inChannel.result).toMatchObject({ reason: "identity-not-authorized" });
    const posted = await fixture.notices(inChannel.ingressId);
    expect(posted).toMatchObject([{ audience: "conversation", kind: "status" }]);
    expect(JSON.stringify(posted[0]?.content)).toContain(testChannelNotices.linkByDirectMessage);
    await expect(
      database
        .selectFrom("channelLinkCodes")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("accountId", "=", fixture.configured.account.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: "0" });

    // The same provider in a direct message can carry the code itself.
    const inDirectMessage = await fixture.adopt({ eventId: "Ev-NOTICE-WHISPER-2", type: "dm" });
    expect(inDirectMessage.result).toMatchObject({ reason: "identity-not-authorized" });
    expect(await fixture.notices(inDirectMessage.ingressId)).toMatchObject([{ audience: "actor" }]);
    await expect(
      database
        .selectFrom("channelLinkCodes")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("accountId", "=", fixture.configured.account.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: "1" });
  });

  it("says something when a channel message runs out of attempts", async ({ storeFixture }) => {
    const { createChannelNoticeFixture, database } = storeFixture;
    const fixture = await createChannelNoticeFixture("ceiling");
    const addressed = await fixture.channels.commitIngress(
      fixture.configured.connection.id,
      fixture.event({ eventId: "Ev-NOTICE-CEILING-1" }),
    );
    const overheard = await fixture.channels.commitIngress(
      fixture.configured.connection.id,
      fixture.event({ eventId: "Ev-NOTICE-CEILING-2", trigger: "conversation-followup" }),
    );
    await database
      .updateTable("channelIngressEvents")
      .set({ attempts: 20 })
      .where("id", "in", [addressed.ingressId, overheard.ingressId])
      .execute();

    await fixture.channels.claimIngress("ceiling-worker");

    const rows = await database
      .selectFrom("channelIngressEvents")
      .select(["id", "status"])
      .where("id", "in", [addressed.ingressId, overheard.ingressId])
      .execute();
    expect(rows.every(({ status }) => status === "dead")).toBe(true);
    const answered = await fixture.notices(addressed.ingressId);
    expect(answered).toMatchObject([{ audience: "actor", kind: "status" }]);
    expect(JSON.stringify(answered[0]?.content)).toContain(
      "Something went wrong while handling your message.",
    );
    // Nobody addressed the follow-up, so nothing is said about it.
    expect(await fixture.notices(overheard.ingressId)).toEqual([]);
  });

  it("declines with an answer when membership is revoked mid-adoption", async ({
    storeFixture,
  }) => {
    const { createChannelNoticeFixture, store, database } = storeFixture;
    // `anyone` runs as the person who created the route, so revoking that
    // person's membership is what leaves the resolved user outside the
    // Workspace the route points at.
    const fixture = await createChannelNoticeFixture("member", { accessMode: "anyone" });
    const secondOwnerId = await store.createUser("Channel notice second owner");
    await database
      .insertInto("workspaceMemberships")
      .values({
        generation: 1,
        id: createId("workspaceMembership"),
        invitedBy: fixture.fixture.userId,
        joinedAt: new Date(),
        revokedAt: null,
        revokedBy: null,
        role: "owner",
        state: "active",
        updatedAt: new Date(),
        userId: secondOwnerId,
        workspaceId: fixture.fixture.workspace.id,
      })
      .executeTakeFirstOrThrow();
    const committed = await fixture.channels.commitIngress(
      fixture.configured.connection.id,
      fixture.event({ eventId: "Ev-NOTICE-MEMBER-1" }),
    );
    const claimed = await fixture.claimFor(committed.ingressId);

    // Authority is resolved with a plain read and the placement check re-reads
    // the same membership `for update`, so a revocation that commits between
    // them is exactly the interleaving this decline exists for.
    const revoker = await database.startTransaction().execute();
    let revokerOpen = true;
    try {
      await revoker
        .updateTable("workspaceMemberships")
        .set({ revokedAt: new Date(), revokedBy: secondOwnerId, state: "revoked" })
        .where("workspaceId", "=", fixture.fixture.workspace.id)
        .where("userId", "=", fixture.fixture.userId)
        .executeTakeFirstOrThrow();
      const adoption = fixture.channels.adoptIngress({
        claimToken: claimed.claimToken,
        ingressId: claimed.id,
        notices: testChannelNotices,
        placementCandidates: fixture.placementCandidates,
      });
      const settled = adoption.then(
        () => "settled" as const,
        () => "settled" as const,
      );
      await expect(
        Promise.race([
          settled,
          new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 250)),
        ]),
      ).resolves.toBe("blocked");
      revokerOpen = false;
      await revoker.commit().execute();

      await expect(adoption).resolves.toMatchObject({ kind: "ignored", reason: "not-a-member" });
    } finally {
      if (revokerOpen) await revoker.rollback().execute();
    }
    const answered = await fixture.notices(committed.ingressId);
    expect(answered).toMatchObject([{ audience: "actor", kind: "status" }]);
    expect(JSON.stringify(answered[0]?.content)).toContain(testChannelNotices.notAMember);
  });

  it("settles every nonterminal channel delivery when its connection is revoked", async ({
    storeFixture,
  }) => {
    const { createChannelDeliveryFixture, insertChannelDelivery, database } = storeFixture;
    const { channels, configured, conversationId } =
      await createChannelDeliveryFixture("revoke-terminal");
    const statuses = ["pending", "retryable-failed", "leased", "attempt-started"] as const;
    const ids = await Promise.all(
      statuses.map((status) =>
        insertChannelDelivery({ accountId: configured.account.id, conversationId, status }),
      ),
    );

    await channels.setConnectionStatus(
      configured.connection.id,
      configured.connection.ownerUserId,
      "revoked",
    );

    const deliveries = await database
      .selectFrom("channelDeliveries")
      .select(["claimOwner", "claimTokenHash", "id", "lastError", "status"])
      .where("id", "in", ids)
      .execute();
    const byId = new Map(deliveries.map((delivery) => [delivery.id, delivery]));
    expect(ids.map((id) => byId.get(id)?.status)).toEqual(["dead", "dead", "dead", "unknown"]);
    expect(
      deliveries.every(({ claimOwner, claimTokenHash }) => !claimOwner && !claimTokenHash),
    ).toBe(true);
    expect(ids.map((id) => byId.get(id)?.lastError)).toEqual([
      "Channel connection was revoked before delivery",
      "Channel connection was revoked before delivery",
      "Channel connection was revoked before delivery",
      "Channel connection was revoked after delivery began",
    ]);
    await expect(channels.claimDelivery(testMessagingRunnerId)).resolves.toBeNull();
  });

  it("serializes delivery attempt-start against terminal channel revocation", async ({
    storeFixture,
  }) => {
    const { createChannelDeliveryFixture, insertChannelDelivery, database } = storeFixture;
    const { channels, configured, conversationId } =
      await createChannelDeliveryFixture("revoke-race");
    const deliveryId = await insertChannelDelivery({
      accountId: configured.account.id,
      conversationId,
      status: "pending",
    });
    const claim = await channels.claimDelivery(testMessagingRunnerId);
    expect(claim?.delivery.id).toBe(deliveryId);

    const [attempt, revocation] = await Promise.allSettled([
      channels.startDeliveryAttempt(deliveryId, claim!.claimToken),
      channels.setConnectionStatus(
        configured.connection.id,
        configured.connection.ownerUserId,
        "revoked",
      ),
    ]);

    expect(revocation.status).toBe("fulfilled");
    const row = await database
      .selectFrom("channelDeliveries")
      .select(["claimOwner", "claimTokenHash", "lastError", "status"])
      .where("id", "=", deliveryId)
      .executeTakeFirstOrThrow();
    expect(["dead", "unknown"]).toContain(row.status);
    expect(row.claimOwner).toBeNull();
    expect(row.claimTokenHash).toBeNull();
    if (attempt.status === "fulfilled") {
      expect(row).toMatchObject({
        lastError: "Channel connection was revoked after delivery began",
        status: "unknown",
      });
    } else {
      expect(row).toMatchObject({
        lastError: "Channel connection was revoked before delivery",
        status: "dead",
      });
    }
  });

  it("windows dispatch history and paginates canonical Threads and messages without gaps", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, store } = storeFixture;
    const { environmentId, harnessInstance, runnerId, thread, userId, workspace } =
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
        membershipGeneration: 1,
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
          data: { status: "running" },
          environmentId,
          ordinal: 0,
          runId: admitted.run.id,
          threadId: thread.id,
          type: "run.started",
          workspaceId: workspace.id,
        }),
        runnerBootId: "durable-window-boot",
        runnerId,
      });
      await store.commitRunnerEvent({
        environmentId,
        event: pendingEvent({
          bindingGeneration: binding.bindingGeneration,
          data: { status: "completed" },
          environmentId,
          ordinal: 1,
          runId: admitted.run.id,
          threadId: thread.id,
          type: "run.completed",
          workspaceId: workspace.id,
        }),
        runnerBootId: "durable-window-boot",
        runnerId,
      });
    };
    const first = await enqueueHumanTrigger({
      content: [{ text: "FIRST", type: "text" }],
      idempotencyKey: "durable-window-message-1",
      requestedBy: userId,
      threadId: thread.id,
    });
    await complete(first, "first");
    const second = await enqueueHumanTrigger({
      content: [{ text: "SECOND", type: "text" }],
      idempotencyKey: "durable-window-message-2",
      requestedBy: userId,
      threadId: thread.id,
    });
    await complete(second, "second");
    const largestPageMessage = "🚀".repeat(86 * 1_024);
    const third = await enqueueHumanTrigger({
      content: [{ text: largestPageMessage, type: "text" }],
      idempotencyKey: "durable-window-message-3",
      requestedBy: userId,
      threadId: thread.id,
    });

    await store.claimCommand(third.command.id, "durable-window-third-dispatcher");
    const dispatch = await store.loadRunDispatchContext(third.command.id, { maxItems: 1 });
    expect(dispatch.history.map(({ id }) => id)).toEqual([second.message.id]);
    expect(dispatch.historyWindow).toMatchObject({ hasEarlier: true, itemCount: 1 });
    expect(dispatch.historyWindow.byteCount).toBe(
      Buffer.byteLength(JSON.stringify(dispatch.history), "utf8"),
    );

    const messageSnapshot = await store.workspaceSnapshot(workspace.id, { maxMessages: 1 });
    expect(messageSnapshot.serializedBytes).toBe(
      Buffer.byteLength(JSON.stringify(messageSnapshot), "utf8"),
    );
    expect(messageSnapshot.serializedBytes).toBeLessThanOrEqual(900 * 1_024);
    expect(messageSnapshot.messages).toHaveLength(1);
    const messageWindow = messageSnapshot.messageWindows.find(
      ({ threadId }) => threadId === thread.id,
    );
    expect(messageWindow).toMatchObject({ hasMore: true, itemCount: 1, totalItems: 3 });
    expect(messageSnapshot.messages[0]?.id).toBe(third.message.id);
    expect(messageWindow?.nextBefore).not.toBeNull();

    const thirdBinding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: harnessInstance.id,
      leaseTokenHash: "durable-window-third-lease",
      membershipGeneration: 1,
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
          data: { status },
          environmentId,
          ordinal,
          runId: third.run.id,
          threadId: thread.id,
          type,
          workspaceId: workspace.id,
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
        workspaceId: workspace.id,
      });
    }
    const snapshot = await store.workspaceSnapshot(workspace.id, {
      maxMessages: 1,
      maxThreads: 2,
    });
    expect(snapshot.threadWindow).toMatchObject({ hasMore: true, itemCount: 2, totalItems: 3 });

    const newestTasks = await store.taskPageForUser({
      maxItems: 1,
      userId,
      workspaceId: workspace.id,
    });
    expect(newestTasks.window).toMatchObject({ hasMore: true, itemCount: 1, totalItems: 3 });
    const olderTasks = await store.taskPageForUser({
      before: newestTasks.window.nextBefore!,
      maxItems: 1,
      userId,
      workspaceId: workspace.id,
    });
    expect(olderTasks.tasks[0]?.thread.id).not.toBe(newestTasks.tasks[0]?.thread.id);

    const ownerThreads = await store.ownerThreadPageForOwner({
      maxItems: 1,
      ownerId: userId,
    });
    expect(ownerThreads.window).toMatchObject({ hasMore: true, itemCount: 1, totalItems: 3 });
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
    expect(earlier?.window).toMatchObject({ hasMore: true, itemCount: 1, totalItems: 3 });
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
      { text: largestPageMessage, type: "text" },
    ]);
    expect(largestMessagePage?.window.itemCount).toBe(1);
    expect(largestMessagePage?.window.nextBefore).not.toBeNull();
  });

  it("pages durable Thread event history without delta events", async ({ storeFixture }) => {
    const { createRunFixture, enqueueHumanTrigger, store } = storeFixture;
    const { environmentId, runnerId, thread, userId, workspace } =
      await createRunFixture("event_history");
    const turn = await enqueueHumanTrigger({
      content: [{ type: "text", text: "Trace this run" }],
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
      membershipGeneration: 1,
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
      workspaceId: workspace.id,
    } as const;
    const commit = (event: PendingAgentEvent) =>
      store.commitRunnerEvent({
        environmentId,
        event,
        runnerBootId: "boot-event-history",
        runnerId,
      });
    // Earlier Hosts stored streaming deltas as durable events. Nothing writes
    // them any more, but rows that already exist stay in the log and every
    // read of it must step over them.
    const legacyDelta = async (type: string, data: unknown) => {
      const sequence = await store.database
        .updateTable("workspaces")
        .set({ eventSequence: sql<string>`event_sequence + 1` })
        .where("id", "=", workspace.id)
        .returning("eventSequence")
        .executeTakeFirstOrThrow();
      await sql`
        insert into workspace_events
          (sequence, event_id, workspace_id, thread_id, run_id, environment_id, type, data, created_at)
        values (
          ${String(sequence.eventSequence)}, ${createId("event")}, ${workspace.id}, ${thread.id},
          ${turn.run.id}, ${environmentId}, ${type}, ${JSON.stringify(data)}::jsonb, now()
        )
      `.execute(store.database);
      return String(sequence.eventSequence);
    };
    await commit(
      pendingEvent({ ...base, data: { status: "running" }, ordinal: 0, type: "run.started" }),
    );
    const firstLegacy = await legacyDelta("reasoning.delta", {
      blockId: "block-1",
      text: "Considering…",
    });
    await commit(
      pendingEvent({
        ...base,
        data: { blockId: "block-1", text: "Considering… settled." },
        ordinal: 1,
        type: "reasoning.completed",
      }),
    );
    await legacyDelta("assistant.delta", { text: "Working " });
    await commit(
      pendingEvent({
        ...base,
        data: {
          arguments: { path: "notes.md" },
          callId: "call-1",
          tool: { name: "read_file", namespace: "test" },
        },
        ordinal: 2,
        type: "tool.started",
      }),
    );
    const lastLegacy = await legacyDelta("tool.delta", { callId: "call-1", text: "chunk" });
    await commit(
      pendingEvent({
        ...base,
        data: { callId: "call-1", isError: false, output: { text: "file contents" } },
        ordinal: 3,
        type: "tool.completed",
      }),
    );
    await commit(
      pendingEvent({ ...base, data: { status: "completed" }, ordinal: 4, type: "run.completed" }),
    );

    // A replay window made only of legacy rows still advances its reader.
    const legacyOnly = await store.eventsAfterWindow(
      workspace.id,
      String(BigInt(firstLegacy) - 1n) as Sequence,
      { maxBytes: 1_024 * 1_024, maxItems: 1, throughSequence: lastLegacy as Sequence },
    );
    expect(legacyOnly.events).toEqual([]);
    expect(legacyOnly.scannedThrough).toBe(firstLegacy);
    expect(legacyOnly.hasMore).toBe(true);
    const acrossLegacy = await store.eventsAfterWindow(
      workspace.id,
      String(BigInt(firstLegacy) - 1n) as Sequence,
      { maxBytes: 1_024 * 1_024, maxItems: 100, throughSequence: lastLegacy as Sequence },
    );
    expect(acrossLegacy.events.map(({ type }) => type)).toEqual([
      "reasoning.completed",
      "tool.started",
    ]);
    expect(acrossLegacy).toMatchObject({ hasMore: false, scannedThrough: lastLegacy });

    const fullPage = await store.threadEventPageForOwner({
      ownerId: userId,
      threadId: thread.id,
    });
    expect(fullPage?.events.map(({ type }) => type)).toEqual([
      "thread.created",
      "message.created",
      "message.placed",
      "run.queued",
      "thread.state-changed",
      "thread-input.updated",
      "run.status",
      "thread.continuation-established",
      "run.started",
      "thread-input.updated",
      "reasoning.completed",
      "tool.started",
      "tool.completed",
      "run.completed",
      "thread.state-changed",
    ]);
    expect(fullPage?.window).toMatchObject({
      hasMore: false,
      itemCount: 15,
      nextBefore: null,
      threadId: thread.id,
      totalItems: 15,
    });
    expect(fullPage?.window.byteCount).toBe(
      Buffer.byteLength(JSON.stringify(fullPage?.events), "utf8"),
    );
    const sequences = fullPage!.events.map(({ sequence }) => BigInt(sequence));
    expect([...sequences].sort((left, right) => (left < right ? -1 : 1))).toEqual(sequences);

    const newest = await store.threadEventPageForOwner({
      maxItems: 5,
      ownerId: userId,
      threadId: thread.id,
    });
    expect(newest?.events.map(({ type }) => type)).toEqual([
      "reasoning.completed",
      "tool.started",
      "tool.completed",
      "run.completed",
      "thread.state-changed",
    ]);
    expect(newest?.window).toMatchObject({ hasMore: true, itemCount: 5, totalItems: 15 });
    expect(newest?.window.nextBefore).toBe(newest?.events[0]?.sequence);
    const older = await store.threadEventPageForOwner({
      before: newest!.window.nextBefore!,
      maxItems: 5,
      ownerId: userId,
      threadId: thread.id,
    });
    expect(older?.events.map(({ type }) => type)).toEqual([
      "thread-input.updated",
      "run.status",
      "thread.continuation-established",
      "run.started",
      "thread-input.updated",
    ]);
    expect(older?.window).toMatchObject({
      hasMore: true,
      itemCount: 5,
      nextBefore: older?.events[0]?.sequence,
      totalItems: 15,
    });
    const oldest = await store.threadEventPageForOwner({
      before: older!.window.nextBefore!,
      maxItems: 5,
      ownerId: userId,
      threadId: thread.id,
    });
    expect(oldest?.events.map(({ type }) => type)).toEqual([
      "thread.created",
      "message.created",
      "message.placed",
      "run.queued",
      "thread.state-changed",
    ]);
    expect(oldest?.window).toMatchObject({
      hasMore: false,
      itemCount: 5,
      nextBefore: null,
      totalItems: 15,
    });

    await expect(
      store.threadEventPageForOwner({
        before: "not a sequence",
        ownerId: userId,
        threadId: thread.id,
      }),
    ).rejects.toMatchObject({ code: "bad_request" });

    const outsider = await store.createUser("Outsider");
    await expect(
      store.threadEventPageForOwner({ ownerId: outsider, threadId: thread.id }),
    ).resolves.toBeNull();
  });

  it("persists tool output whose source text carried NUL bytes", async ({ storeFixture }) => {
    const { createRunFixture, enqueueHumanTrigger, store } = storeFixture;
    const { environmentId, runnerId, thread, userId, workspace } =
      await createRunFixture("nul_tool_output");
    const turn = await enqueueHumanTrigger({
      content: [{ type: "text", text: "Read a binary" }],
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
      membershipGeneration: 1,
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
      workspaceId: workspace.id,
    } as const;
    const commit = (event: PendingAgentEvent) =>
      store.commitRunnerEvent({
        environmentId,
        event,
        runnerBootId: "boot-nul-tool-output",
        runnerId,
      });
    await commit(
      pendingEvent({ ...base, data: { status: "running" }, ordinal: 0, type: "run.started" }),
    );

    // What a `head -30` of a Mach-O binary produces. PostgreSQL refuses raw
    // NUL in `jsonb` with 22P05 — "unsupported Unicode escape sequence" — so
    // the Host stores it as U+FFFD, the text tool output's canonical
    // constructor makes, and the canonical form sent again is a replay.
    const machOHead = `\u00CF\u00FA\u00ED\u00FE${"\u0000".repeat(5_000)}__TEXT`;
    const raw = pendingEvent<Extract<PendingAgentEvent, { type: "tool.completed" }>>({
      ...base,
      data: { callId: "call-nul", isError: false, output: { text: machOHead } },
      ordinal: 1,
      type: "tool.completed",
    });
    expect(await commit(raw)).toMatchObject({ wasDuplicate: false });

    const output = createToolOutput(machOHead);
    expect(output.text).not.toContain("\u0000");
    expect(await commit(raw)).toMatchObject({ wasDuplicate: true });
    expect(await commit({ ...raw, data: { ...raw.data, output } })).toMatchObject({
      wasDuplicate: true,
    });
    await commit(
      pendingEvent({ ...base, data: { status: "completed" }, ordinal: 2, type: "run.completed" }),
    );

    const page = await store.threadEventPageForOwner({ ownerId: userId, threadId: thread.id });
    const completed = page?.events.find(({ type }) => type === "tool.completed");
    expect(completed?.data).toEqual({ callId: "call-nul", isError: false, output });
  });

  it("accepts only contiguous Runner events and legal Run transitions", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, store, database } = storeFixture;
    const { environmentId, runnerId, thread, userId, workspace } =
      await createRunFixture("event_order");
    const turn = await enqueueHumanTrigger({
      content: [{ type: "text", text: "Run safely" }],
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
      membershipGeneration: 1,
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
      workspaceId: workspace.id,
    } as const;
    await expect(
      store.commitRunnerEvent({
        environmentId,
        event: pendingEvent({
          ...base,
          data: { status: "completed" },
          ordinal: 7,
          type: "run.completed",
        }),
        runnerBootId: "boot-event-order",
        runnerId,
      }),
    ).rejects.toThrow(/out of sequence; expected 0/);
    await expect(
      store.commitRunnerEvent({
        environmentId,
        event: pendingEvent({
          ...base,
          data: { status: "completed" },
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
    ).toEqual({ nextRunnerOrdinal: 0, startedAt: null, status: "starting" });

    const started = pendingEvent({
      ...base,
      data: { status: "running" },
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
          data: { status: "waiting" },
          ordinal: 0,
          type: "run.status",
        }),
        runnerBootId: "boot-event-order",
        runnerId,
      }),
    ).rejects.toThrow(/already committed with different content/);
    await expect(
      store.commitRunnerEvent({
        environmentId,
        event: pendingEvent({
          ...base,
          data: { status: "completed" },
          ordinal: 2,
          type: "run.completed",
        }),
        runnerBootId: "boot-event-order",
        runnerId,
      }),
    ).rejects.toThrow(/out of sequence; expected 1/);

    const later = await store.enqueueThreadInput({
      content: [{ type: "text", text: "Continue after the failure" }],
      idempotencyKey: "event-order-later-message",
      policy: "steer",
      requestedBy: userId,
      source: { kind: "human" },
      threadId: thread.id,
    });
    expect(later).toMatchObject({
      command: { type: "run.steer" },
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
    expect(committed.wasDuplicate).toBe(false);
    expect(duplicate.wasDuplicate).toBe(true);
    expect(duplicate.event.sequence).toBe(committed.event.sequence);
    expect(
      await database
        .selectFrom("runs")
        .select(["nextRunnerOrdinal", "status"])
        .where("id", "=", turn.run.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ nextRunnerOrdinal: 2, status: "failed" });
    await expect(
      database
        .selectFrom("threads")
        .select("status")
        .where("id", "=", thread.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "failed" });
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
    ).resolves.toEqual({ status: "failed", type: "run.steer" });
  });

  it("resolves only the exact pending Request and records the response atomically", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, store, database } = storeFixture;
    const { environmentId, runnerId, thread, userId, workspace } =
      await createRunFixture("pending_request");
    const turn = await enqueueHumanTrigger({
      content: [{ type: "text", text: "Ask before acting" }],
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
      membershipGeneration: 1,
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
      workspaceId: workspace.id,
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
        data: { status: "running" },
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
                { hint: "reject-once", id: "decline", label: "Decline" },
                { hint: "allow-once", id: "allow", label: "Allow" },
              ],
              risk: "medium",
              title: "Approve write",
            },
            requestedBy: userId,
            runId: turn.run.id,
            threadId: thread.id,
            workspaceId: workspace.id,
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
    const waitingSnapshot = await store.workspaceSnapshot(workspace.id);
    expect(waitingSnapshot.pendingRequests).toHaveLength(1);
    expect(waitingSnapshot.pendingRequests[0]).toMatchObject({
      id: requestId,
      originatingRunId: turn.run.id,
      presentation: { kind: "choice", title: "Approve write" },
    });
    expect(waitingSnapshot.pendingRequestWindow).toMatchObject({
      hasMore: false,
      itemCount: 1,
      totalItems: 1,
    });
    await expect(
      store.enqueueRunnerControl({
        requestId,
        idempotencyKey: "wrong-kind-control",
        requestedBy: userId,
        response: { answers: { choice: ["yes"] }, kind: "form" },
        sealedResponse: sealedTestRequestResponse(),
        runId: turn.run.id,
        threadId: thread.id,
        type: "request.respond",
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      store.enqueueRunnerControl({
        requestId: createId("request"),
        idempotencyKey: "wrong-id-control",
        requestedBy: userId,
        response: { kind: "choice", optionId: "allow" },
        sealedResponse: sealedTestRequestResponse(),
        runId: turn.run.id,
        threadId: thread.id,
        type: "request.respond",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    const controlInput = {
      requestId,
      idempotencyKey: "exact-approval-control",
      requestedBy: userId,
      response: { kind: "choice" as const, optionId: "allow" },
      sealedResponse: sealedTestRequestResponse(),
      runId: turn.run.id,
      threadId: thread.id,
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
        response: { kind: "choice", optionId: "decline" },
        sealedResponse: {
          ...controlInput.sealedResponse,
          requestFingerprint: "hmac-sha256-v1:1:different-choice-response",
        },
      }),
    ).rejects.toMatchObject({ code: "conflict" });

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
    ).resolves.toEqual({ status: "waiting" });

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
    const resolutionEvents = await store.succeedCommand(control.command.id);
    expect(resolutionEvents).toEqual([expect.objectContaining({ type: "request.resolved" })]);
    expect(
      await database
        .selectFrom("requests")
        .select(["response", "responseCommandId", "status"])
        .where("id", "=", requestId)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      response: { kind: "choice", optionId: "allow" },
      responseCommandId: null,
      status: "fulfilled",
    });
    await commit(
      pendingEvent({
        ...base,
        data: { status: "running" },
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
                { id: "choice", multiSelect: false, prompt: "Which option?", secret: false },
              ],
              kind: "form",
              title: "Input needed",
            },
            requestedBy: userId,
            runId: turn.run.id,
            threadId: thread.id,
            workspaceId: workspace.id,
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
    ).toEqual({ cancellationReason: "run-ended", status: "cancelled" });
  });

  it("serializes live Request projection against membership revocation", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, database, openLiveRequest } = storeFixture;
    const membershipFixture = await startRunFixture("live-request-membership-race");
    const revokingOwnerId = await store.createUser("Live Request revoking owner");
    await database
      .insertInto("workspaceMemberships")
      .values({
        generation: 1,
        id: createId("workspaceMembership"),
        invitedBy: membershipFixture.userId,
        joinedAt: new Date(),
        revokedAt: null,
        revokedBy: null,
        role: "owner",
        state: "active",
        updatedAt: new Date(),
        userId: revokingOwnerId,
        workspaceId: membershipFixture.workspace.id,
      })
      .executeTakeFirstOrThrow();
    const membershipRequestId = createId("request");
    const [revocation, membershipOpen] = await Promise.allSettled([
      store.changeWorkspaceMembership({
        actorId: revokingOwnerId,
        state: "revoked",
        targetUserId: membershipFixture.userId,
        workspaceId: membershipFixture.workspace.id,
      }),
      openLiveRequest(membershipFixture, membershipRequestId),
    ]);
    expect(revocation.status).toBe("fulfilled");
    if (membershipOpen.status === "rejected") {
      expect(membershipOpen.reason).toMatchObject({ code: "forbidden" });
    }
    const membershipRequest = await database
      .selectFrom("requests")
      .select(["cancellationReason", "status"])
      .where("id", "=", membershipRequestId)
      .executeTakeFirst();
    if (membershipRequest) {
      expect(membershipRequest).toEqual({
        cancellationReason: "membership-revoked",
        status: "cancelled",
      });
    }
  });

  it("serializes live Request projection against Workspace deletion", async ({ storeFixture }) => {
    const { startRunFixture, store, openLiveRequest, database } = storeFixture;
    const deletionFixture = await startRunFixture("live-request-deletion-race");
    const deletionRequestId = createId("request");
    const [deletion, deletionOpen] = await Promise.allSettled([
      store.requestWorkspaceDeletion({
        purgeAfter: new Date(Date.now() + 60_000),
        requestedBy: deletionFixture.userId,
        workspaceId: deletionFixture.workspace.id,
      }),
      openLiveRequest(deletionFixture, deletionRequestId),
    ]);
    expect(deletion.status).toBe("fulfilled");
    if (deletionOpen.status === "rejected") {
      expect(deletionOpen.reason).toMatchObject({ code: "forbidden" });
    }
    const deletionRequest = await database
      .selectFrom("requests")
      .select(["cancellationReason", "status"])
      .where("id", "=", deletionRequestId)
      .executeTakeFirst();
    if (deletionRequest) {
      expect(deletionRequest).toEqual({
        cancellationReason: "workspace-deleted",
        status: "cancelled",
      });
    }
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
                options: [{ hint: "confirm", id: "yes", label: "Yes" }],
                title: "Confirm action",
              },
              requestedBy: fixture.userId,
              runId: fixture.run.id,
              threadId: fixture.thread.id,
              workspaceId: fixture.workspace.id,
            }),
          },
          environmentId: fixture.environmentId,
          ordinal,
          runId: fixture.run.id,
          threadId: fixture.thread.id,
          type: "request.opened",
          workspaceId: fixture.workspace.id,
        }),
      );
    };
    const respond = (requestId: RequestId, suffix: string) =>
      store.enqueueRunnerControl({
        requestId,
        idempotencyKey: `action-cancellation-${suffix}`,
        requestedBy: fixture.userId,
        response: { kind: "choice", optionId: "yes" },
        sealedResponse: sealedTestRequestResponse(),
        runId: fixture.run.id,
        threadId: fixture.thread.id,
        type: "request.respond",
      });

    const cancelledId = createId("request");
    await openRequest(cancelledId, 1);
    const cancelledResponse = await respond(cancelledId, "cancelled");
    await store.claimCommand(cancelledResponse.command.id, "action-cancellation-worker");
    await commit(
      pendingEvent({
        bindingGeneration: fixture.bindingGeneration,
        data: { requestId: cancelledId, reason: "source-closed" },
        environmentId: fixture.environmentId,
        ordinal: 2,
        runId: fixture.run.id,
        threadId: fixture.thread.id,
        type: "request.cancelled",
        workspaceId: fixture.workspace.id,
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
    ).resolves.toEqual({ status: "failed" });
    await expect(store.succeedCommand(cancelledResponse.command.id)).resolves.toEqual([]);

    const acceptedId = createId("request");
    await openRequest(acceptedId, 3);
    const acceptedResponse = await respond(acceptedId, "accepted");
    await store.claimCommand(acceptedResponse.command.id, "action-accepted-worker");
    await store.succeedCommand(acceptedResponse.command.id);
    await commit(
      pendingEvent({
        bindingGeneration: fixture.bindingGeneration,
        data: { requestId: acceptedId, reason: "source-closed" },
        environmentId: fixture.environmentId,
        ordinal: 4,
        runId: fixture.run.id,
        threadId: fixture.thread.id,
        type: "request.cancelled",
        workspaceId: fixture.workspace.id,
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
      response: { kind: "choice", optionId: "yes" },
      status: "fulfilled",
    });

    const authorityCancelledId = createId("request");
    await openRequest(authorityCancelledId, 5);
    const authorityCancelledResponse = await respond(authorityCancelledId, "authority-cancelled");
    await expect(store.requests.cancelForRun(fixture.run.id, "run-ended")).resolves.toEqual([
      expect.objectContaining({
        data: { reason: "run-ended", requestId: authorityCancelledId },
        type: "request.cancelled",
      }),
    ]);
    await expect(
      database
        .selectFrom("commands")
        .select(["lastError", "status"])
        .where("id", "=", authorityCancelledResponse.command.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      lastError: { message: "The Request was cancelled before its response completed" },
      status: "failed",
    });
    await expect(
      store.claimCommand(authorityCancelledResponse.command.id, "cancelled-response-worker"),
    ).resolves.toBeNull();
  });

  it("holds cancellation behind the transactional Runner response boundary", async ({
    storeFixture,
  }) => {
    const { startRunFixture, openLiveRequest, store, database } = storeFixture;
    const fixture = await startRunFixture("request-response-dispatch-fence");
    const requestId = createId("request");
    await openLiveRequest(fixture, requestId);
    const response = await store.enqueueRunnerControl({
      idempotencyKey: "request-response-dispatch-fence",
      requestId,
      requestedBy: fixture.userId,
      response: { kind: "choice", optionId: "allow" },
      sealedResponse: sealedTestRequestResponse(),
      runId: fixture.run.id,
      threadId: fixture.thread.id,
      type: "request.respond",
    });
    await store.claimCommand(response.command.id, "request-response-dispatch-fence-worker");

    let announceSend!: () => void;
    const sendStarted = new Promise<void>((resolve) => {
      announceSend = resolve;
    });
    let releaseReceipt!: () => void;
    const receipt = new Promise<void>((resolve) => {
      releaseReceipt = resolve;
    });
    const delivery = store.dispatchRequestResponse(response.command.id, async (beforeAck) => {
      announceSend();
      await receipt;
      await beforeAck();
    });
    void delivery.catch(() => undefined);
    await sendStarted;

    const cancellation = store.requests.cancelForRun(fixture.run.id, "run-ended");
    void cancellation.catch(() => undefined);
    let waiting = 0;
    for (let attempt = 0; attempt < 200 && waiting === 0; attempt += 1) {
      const result = await sql<{ readonly waiting: number }>`
        select count(*)::integer as waiting
        from pg_locks locks
        join pg_stat_activity activity on activity.pid = locks.pid
        where locks.granted = false
          and locks.locktype = 'transactionid'
          and activity.datname = current_database()
          and activity.application_name = 'opensteer-integration-test'
      `.execute(database);
      waiting = Number(result.rows[0]?.waiting ?? 0);
      if (waiting === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(waiting).toBeGreaterThan(0);

    releaseReceipt();
    await expect(delivery).resolves.toEqual([
      expect.objectContaining({ type: "request.resolved" }),
    ]);
    await expect(cancellation).resolves.toEqual([]);
    await expect(
      database
        .selectFrom("requests")
        .select(["cancellationReason", "response", "status"])
        .where("id", "=", requestId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      cancellationReason: null,
      response: { kind: "choice", optionId: "allow" },
      status: "fulfilled",
    });
  });

  it("allows a Runner infrastructure failure before run.started", async ({ storeFixture }) => {
    const { createRunFixture, enqueueHumanTrigger, store, database } = storeFixture;
    const { environmentId, runnerId, thread, userId, workspace } =
      await createRunFixture("startup_failure");
    const turn = await enqueueHumanTrigger({
      content: [{ type: "text", text: "Start the provider" }],
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
      membershipGeneration: 1,
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
        workspaceId: workspace.id,
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
