import { HarnessIdSchema, ProviderSessionIdSchema, type RunId } from "@opensteer/core";
import { expect } from "vitest";
import { startPersonalQueuedRunFixture } from "./personal-run-fixture.test-support.js";
import {
  describeStore,
  pendingEvent,
  testContinuationIdentity,
  testModelSelection,
  type StoreFixture,
} from "./store.integration.test-support.js";
import { ensureSelectedProviderSession } from "./thread-inbox.js";

async function complete(f: StoreFixture, runId: RunId) {
  const run = await f.database
    .selectFrom("runs")
    .selectAll()
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  const session = await f.database
    .selectFrom("providerSessions")
    .selectAll()
    .where("id", "=", run.providerSessionId)
    .executeTakeFirstOrThrow();
  await f.store.commitRunnerEvent({
    environmentId: run.environmentId,
    runnerBootId: session.runnerBootId!,
    runnerId: session.runnerId!,
    event: pendingEvent({
      bindingGeneration: session.bindingGeneration,
      data: { status: "completed" },
      environmentId: run.environmentId,
      ordinal: 1,
      runId,
      threadId: run.threadId,
      type: "run.completed",
    }),
  });
}

describeStore("fresh model context", (it) => {
  it("rotates at dispatch, freezes empty history, and keeps the pinned session through recovery", async ({
    storeFixture: f,
  }) => {
    const prior = await f.startRunFixture("fresh-rotation");
    await complete(f, prior.run.id);
    const fresh = await f.enqueueHumanTrigger({
      content: [
        { type: "text", text: "Check again. Criteria and state are in automations/test/." },
      ],
      freshContext: true,
      idempotencyKey: "fresh",
      requestedBy: prior.userId,
      threadId: prior.thread.id,
    });
    // Merely waiting for dispatch must not change the selected native session.
    expect(fresh.run.providerSessionId).toBe(prior.run.providerSessionId);
    const claimed = await f.store.claimCommand(fresh.command.id, "first-dispatch");
    const context = await f.store.loadRunDispatchContext(fresh.command.id);
    expect(context.run.providerSessionId).not.toBe(prior.run.providerSessionId);
    expect(claimed?.events.filter(({ type }) => type === "thread.execution-updated")).toMatchObject(
      [
        {
          threadId: prior.thread.id,
          runId: null,
          data: {
            thread: {
              providerSessionId: context.run.providerSessionId,
              continuationIdentity: null,
            },
          },
        },
      ],
    );
    expect(context.history).toEqual([]);
    expect(context.initialContext).toBeNull();
    const selected = await f.database
      .selectFrom("providerSessions")
      .selectAll()
      .where("id", "=", context.run.providerSessionId)
      .executeTakeFirstOrThrow();
    expect(selected).toMatchObject({ bindingGeneration: 0, providerSessionReference: null });
    // Recovery must lock the inactive sessions before the pinned session, regardless of generated IDs.
    const inactiveSessionId = ProviderSessionIdSchema.parse(
      "psn_00000000-0000-4000-8000-000000000000",
    );
    await f.database
      .insertInto("providerSessions")
      .values({ ...selected, active: false, id: inactiveSessionId })
      .execute();
    await f.store.recoverCommandsAfterHostRestart();
    const recoveredClaim = await f.store.claimCommand(fresh.command.id, "recovered-dispatch");
    expect(
      recoveredClaim?.events.filter(({ type }) => type === "thread.execution-updated"),
    ).toEqual([]);
    const recovered = await f.store.loadRunDispatchContext(fresh.command.id);
    expect(recovered.run.providerSessionId).toBe(context.run.providerSessionId);
    expect(recovered.history).toEqual([]);
    expect(recovered.initialContext).toBeNull();

    const started = await startPersonalQueuedRunFixture(f.store, fresh.run.id);
    await f.store.succeedCommand(fresh.command.id);
    await f.store.attachRunnerExecutions({
      dispatchingRunIds: [],
      executions: [],
      leaseExpiresAt: new Date(Date.now() + 60_000),
      runnerBootId: started.runnerBootId,
      runnerId: prior.runnerId,
    });
    const replacement = await f.database
      .selectFrom("commands")
      .selectAll()
      .where("runId", "=", fresh.run.id)
      .where("type", "=", "run.execute")
      .where("status", "=", "pending")
      .executeTakeFirstOrThrow();
    await f.store.claimCommand(replacement.id, "attempt-recovery");
    const rebound = await f.store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: prior.harnessInstance.id,
      leaseTokenHash: "recovered-lease",
      runnerBootId: started.runnerBootId,
      runnerId: prior.runnerId,
      runId: fresh.run.id,
      threadId: prior.thread.id,
    });
    expect(rebound.providerSessionId).toBe(context.run.providerSessionId);
    expect(rebound.providerSessionReference).toBe(`fixture:${prior.thread.id}`);
    const resumed = await f.store.loadRunDispatchContext(replacement.id);
    expect(resumed.run.providerSessionId).toBe(context.run.providerSessionId);
    expect(resumed.executionBinding?.providerSessionReference).toBe(`fixture:${prior.thread.id}`);
    expect(
      await f.database
        .selectFrom("providerSessions")
        .select("id")
        .where("threadId", "=", prior.thread.id)
        .orderBy("id", "asc")
        .execute(),
    ).toEqual(
      [inactiveSessionId, prior.run.providerSessionId, context.run.providerSessionId]
        .sort()
        .map((id) => ({ id })),
    );
  });

  it.for(["runner-disconnect", "refused-event", "expired-binding"] as const)(
    "locks a fresh task's sessions in ID order when %s ends its Run",
    async (path, { storeFixture: f }) => {
      const prior = await f.startRunFixture(`fresh-recovery-${path}`);
      await complete(f, prior.run.id);
      const fresh = await f.enqueueHumanTrigger({
        content: [{ type: "text", text: "Check again" }],
        freshContext: true,
        idempotencyKey: "fresh-recovery",
        requestedBy: prior.userId,
        threadId: prior.thread.id,
      });
      await f.store.claimCommand(fresh.command.id, "fresh-recovery-dispatch");
      const started = await startPersonalQueuedRunFixture(f.store, fresh.run.id);
      const run = await f.database
        .selectFrom("runs")
        .selectAll()
        .where("id", "=", fresh.run.id)
        .executeTakeFirstOrThrow();
      const selected = await f.database
        .selectFrom("providerSessions")
        .selectAll()
        .where("id", "=", run.providerSessionId)
        .executeTakeFirstOrThrow();
      // The lowest ID is not the Run's own session, so locking that one first would descend.
      await f.database
        .insertInto("providerSessions")
        .values({
          ...selected,
          active: false,
          id: ProviderSessionIdSchema.parse("psn_00000000-0000-4000-8000-000000000000"),
        })
        .execute();
      if (path === "runner-disconnect")
        await f.store.failActiveRunsForRunnerDisconnect({
          activeRunIds: [fresh.run.id],
          runnerBootId: started.runnerBootId,
          runnerId: prior.runnerId,
        });
      else if (path === "refused-event")
        await f.store.failRunForRefusedRunnerEvent({
          bindingGeneration: run.bindingGeneration!,
          message: "Unknown event",
          runId: fresh.run.id,
          runnerBootId: started.runnerBootId,
          runnerId: prior.runnerId,
        });
      else await f.store.recoverRunsWithExpiredExecutionBindings(new Date(Date.now() + 3_600_000));
      const after = await f.database
        .selectFrom("runs")
        .select("status")
        .where("id", "=", fresh.run.id)
        .executeTakeFirstOrThrow();
      expect(after.status).not.toBe("running");
    },
  );

  it.for(["failed-startup", "completed"] as const)(
    "keeps the effective boundary after %s, audience rotation and engine switch",
    async (outcome, { storeFixture: f }) => {
      const prior = await f.startRunFixture(`fresh-boundary-${outcome}`);
      await complete(f, prior.run.id);
      const fresh = await f.enqueueHumanTrigger({
        content: [{ type: "text", text: "New boundary" }],
        freshContext: true,
        idempotencyKey: "boundary",
        requestedBy: prior.userId,
        threadId: prior.thread.id,
      });
      const claimed = await f.store.claimCommand(fresh.command.id, "boundary-dispatch");
      if (outcome === "failed-startup")
        await f.store.failCommand(fresh.command.id, "Native process failed before acceptance");
      else {
        await startPersonalQueuedRunFixture(f.store, fresh.run.id);
        await complete(f, fresh.run.id);
      }
      const selected = await f.store.getThreadForOwner(prior.thread.id, prior.userId);
      expect(selected!.providerSessionId).not.toBe(prior.run.providerSessionId);
      expect(claimed?.events).toContainEqual(
        expect.objectContaining({
          type: "thread.execution-updated",
          data: expect.objectContaining({
            thread: expect.objectContaining({ providerSessionId: selected!.providerSessionId }),
          }),
        }),
      );
      // Audience rotation also creates a new session, so it must reconstruct from the boundary.
      await f.database
        .transaction()
        .execute((tx) =>
          ensureSelectedProviderSession(tx, prior.thread, { personalContext: false }),
        );
      const next = await f.enqueueHumanTrigger({
        content: [{ type: "text", text: "Continue" }],
        idempotencyKey: "after-rotation",
        requestedBy: prior.userId,
        threadId: prior.thread.id,
      });
      await f.store.claimCommand(next.command.id, "rotation-dispatch");
      const rotated = await f.store.loadRunDispatchContext(next.command.id);
      expect(rotated.history.map(({ id }) => id)).not.toContain(prior.run.seedInputId);
      expect(rotated.initialContext?.messages.map(({ id }) => id) ?? []).not.toContain(
        prior.run.seedInputId,
      );
      if (outcome === "completed")
        expect(rotated.initialContext?.messages.map(({ id }) => id)).toContain(fresh.message.id);
      await f.store.failCommand(next.command.id, "No native start");
      const claude = await f.store.createHarnessInstance({
        config: {},
        driverKind: HarnessIdSchema.parse("claude"),
        environmentId: prior.environmentId,
        name: "Claude",
        stateKind: "isolated",
      });
      const current = await f.store.getThreadForOwner(prior.thread.id, prior.userId);
      await f.store.updateThreadExecutionSelection({
        continuation: { expectedProviderSessionId: current!.providerSessionId },
        continuationIdentity: {
          ...testContinuationIdentity,
          driverKind: HarnessIdSchema.parse("claude"),
        },
        harnessInstanceId: claude.id,
        idempotencyKey: "switch-engine",
        modelSelection: testModelSelection,
        requestedBy: prior.userId,
        threadId: prior.thread.id,
      });
      const switched = await f.enqueueHumanTrigger({
        content: [{ type: "text", text: "Continue in Claude" }],
        idempotencyKey: "after-switch",
        requestedBy: prior.userId,
        threadId: prior.thread.id,
      });
      await f.store.claimCommand(switched.command.id, "switch-dispatch");
      const handoff = await f.store.loadRunDispatchContext(switched.command.id);
      expect(handoff.history.map(({ id }) => id)).not.toContain(prior.run.seedInputId);
      expect(handoff.initialContext?.messages.map(({ id }) => id) ?? []).not.toContain(
        prior.run.seedInputId,
      );
      expect(handoff.run.harnessInstanceId).toBe(claude.id);
    },
  );

  it("leaves a fresh wake out of a background Run, refuses promotion, and ignores it when cancelled", async ({
    storeFixture: f,
  }) => {
    const prior = await f.startRunFixture("fresh-cancel");
    await f.database
      .updateTable("runs")
      .set({ phase: "background" })
      .where("id", "=", prior.run.id)
      .execute();
    const request = {
      content: [{ type: "text" as const, text: "Separate check" }],
      freshContext: true,
      idempotencyKey: "pending-fresh",
      requestedBy: prior.userId,
      threadId: prior.thread.id,
      policy: "queue" as const,
      source: { kind: "human" as const },
    };
    const queued = await f.store.enqueueThreadInput(request);
    expect(queued).toMatchObject({
      disposition: "pending",
      run: null,
      input: { runId: null, freshContext: true },
    });
    const queue = await f.store.getThreadInputQueue({
      requestedBy: prior.userId,
      threadId: prior.thread.id,
    });
    expect(queue.items.find(({ input }) => input.messageId === queued.message.id)?.canSteer).toBe(
      false,
    );
    await expect(
      f.store.steerThreadInput({
        expectedRunId: prior.run.id,
        idempotencyKey: "promote-fresh",
        messageId: queued.message.id,
        requestedBy: prior.userId,
        threadId: prior.thread.id,
      }),
    ).rejects.toThrow("cannot be steered");
    await f.store.cancelThreadInput({
      idempotencyKey: "cancel-fresh",
      messageId: queued.message.id,
      requestedBy: prior.userId,
      threadId: prior.thread.id,
    });
    await complete(f, prior.run.id);
    const next = await f.enqueueHumanTrigger({
      content: [{ type: "text", text: "Ordinary follow-up" }],
      idempotencyKey: "ordinary",
      requestedBy: prior.userId,
      threadId: prior.thread.id,
    });
    await f.store.claimCommand(next.command.id, "ordinary-dispatch");
    const context = await f.store.loadRunDispatchContext(next.command.id);
    expect(context.run.providerSessionId).toBe(prior.run.providerSessionId);
    expect(context.history.map(({ id }) => id)).toContain(prior.run.seedInputId);
  });

  it("treats a fresh wake as a barrier to conversational follow-up batching", async ({
    storeFixture: f,
  }) => {
    const prior = await f.createRunFixture("fresh-batch");
    await f.database
      .updateTable("threads")
      .set({ purpose: "voice" })
      .where("id", "=", prior.thread.id)
      .execute();
    const first = await f.enqueueHumanTrigger({
      content: [{ type: "text", text: "First" }],
      idempotencyKey: "first",
      requestedBy: prior.userId,
      threadId: prior.thread.id,
    });
    const send = (key: string, freshContext = false) =>
      f.store.enqueueThreadInput({
        content: [{ type: "text", text: key }],
        freshContext,
        idempotencyKey: key,
        requestedBy: prior.userId,
        threadId: prior.thread.id,
        policy: "queue",
        source: { kind: "human" },
      });
    const before = await send("before");
    const barrier = await send("barrier", true);
    const after = await send("after");
    await f.store.claimCommand(first.command.id, "batch-dispatch");
    const context = await f.store.loadRunDispatchContext(first.command.id);
    expect(context.inputs.map(({ id }) => id)).toEqual([first.message.id, before.message.id]);
    const pending = await f.store.getThreadInputQueue({
      requestedBy: prior.userId,
      threadId: prior.thread.id,
    });
    expect(pending.items.map(({ message }) => message.id)).toEqual([
      barrier.message.id,
      after.message.id,
    ]);
  });

  it("rejects non-queue fresh inputs and fingerprints only an enabled fresh context", async ({
    storeFixture: f,
  }) => {
    const prior = await f.createRunFixture("fresh-validation");
    const request = {
      content: [{ type: "text" as const, text: "Check" }],
      idempotencyKey: "same",
      requestedBy: prior.userId,
      threadId: prior.thread.id,
      source: { kind: "human" as const },
    };
    for (const policy of ["report", "steer"] as const)
      await expect(
        f.store.enqueueThreadInput({ ...request, policy, freshContext: true }),
      ).rejects.toThrow("freshContext requires queue");
    const absent = await f.store.enqueueThreadInput({ ...request, policy: "queue" });
    const disabled = await f.store.enqueueThreadInput({
      ...request,
      policy: "queue",
      freshContext: false,
    });
    expect(disabled.wasDuplicate).toBe(true);
    expect(disabled.message.id).toBe(absent.message.id);
    await expect(
      f.store.enqueueThreadInput({ ...request, policy: "queue", freshContext: true }),
    ).rejects.toThrow(/idempotency/i);
  });
});
