import { createHash } from "node:crypto";
import { expect } from "vitest";
import { sql } from "kysely";
import { createId, type RequestCancellationReason } from "@opensteer/core";
import { OpensteerStore } from "./store.js";
import { cancelPending } from "./request-cancellation.js";
import { withDatabaseTransaction } from "./connection.js";
import {
  describeStore,
  pendingEvent,
  type StoreFixture,
  testContinuationIdentity,
} from "./store.integration.test-support.js";

type Started = Awaited<ReturnType<StoreFixture["startRunFixture"]>>;

function open(store: OpensteerStore, fixture: Started, callId: string) {
  return store.requests.create({
    callId,
    kind: "browser.access",
    mode: "durable",
    originatingRunId: fixture.run.id,
    originatingThreadId: fixture.thread.id,
    originatingWorkspaceId: fixture.workspace.id,
    targetWorkspaceId: fixture.workspace.id,
    requestedBy: fixture.userId,
    requiredActor: "requester",
    payload: { kind: "browser.access", reason: "Read email", suggestion: { kind: "user_choice" } },
    presentation: {
      kind: "external",
      title: "Choose a profile",
      subject: { kind: "workspace", id: fixture.workspace.id },
    },
  });
}

async function finish(store: OpensteerStore, fixture: Started, interrupted = false) {
  const row = await store.database
    .selectFrom("runs")
    .select("nextRunnerOrdinal")
    .where("id", "=", fixture.run.id)
    .executeTakeFirstOrThrow();
  await store.commitRunnerEvent({
    environmentId: fixture.environmentId,
    runnerId: fixture.runnerId,
    runnerBootId: fixture.runnerBootId,
    event: pendingEvent({
      bindingGeneration: fixture.bindingGeneration,
      environmentId: fixture.environmentId,
      runId: fixture.run.id,
      threadId: fixture.thread.id,
      workspaceId: fixture.workspace.id,
      ordinal: row.nextRunnerOrdinal,
      ...(interrupted
        ? ({ type: "run.interrupted", data: { status: "interrupted" } } as const)
        : ({ type: "run.completed", data: { status: "completed" } } as const)),
    }),
  });
}

describeStore("Request continuation admission", (it) => {
  for (const [narration, heldStop] of [
    [null, false],
    ["Let me check your calendar", false],
    ["I asked you to connect Gmail.", false],
    [null, true],
  ] as const) {
    it(`sends the channel an input-needed notice alongside ${heldStop ? "a hold stop" : (narration ?? "no reply")}`, async ({
      storeFixture,
    }) => {
      const { store, database, createChannelDeliveryFixture, enqueueHumanTrigger } = storeFixture;
      const channel = await createChannelDeliveryFixture("durable-request-notice");
      const base = channel.fixture;
      const turn = await enqueueHumanTrigger({
        content: [{ type: "text", text: "Check email" }],
        idempotencyKey: "channel-parked-seed",
        requestedBy: base.userId,
        threadId: base.thread.id,
      });
      await store.claimCommand(turn.command.id, "channel-parked-dispatcher");
      const runnerBootId = "channel-parked-boot";
      const binding = await store.acquireExecutionBinding({
        bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
        continuationIdentity: testContinuationIdentity,
        harnessInstanceId: base.harnessInstance.id,
        leaseTokenHash: "channel-parked-lease",
        membershipGeneration: 1,
        runnerBootId,
        runnerId: base.runnerId,
        runId: turn.run.id,
        threadId: base.thread.id,
      });
      const fixture = {
        ...base,
        run: turn.run,
        turn,
        runnerBootId,
        bindingGeneration: binding.bindingGeneration,
      };
      await store.commitRunnerEvent({
        environmentId: fixture.environmentId,
        runnerId: fixture.runnerId,
        runnerBootId,
        event: pendingEvent({
          bindingGeneration: fixture.bindingGeneration,
          environmentId: fixture.environmentId,
          runId: fixture.run.id,
          threadId: fixture.thread.id,
          workspaceId: fixture.workspace.id,
          ordinal: 0,
          type: "run.started",
          data: { status: "running" },
        }),
      });
      await database
        .updateTable("runs")
        .set({
          replyTarget: sql`${JSON.stringify({ kind: "channel", conversationId: channel.conversationId })}::jsonb`,
        })
        .where("id", "=", fixture.run.id)
        .execute();
      await open(store, fixture, "needs-profile");
      await open(store, fixture, "needs-gmail");
      const earlyNotices = await database
        .selectFrom("channelDeliveries")
        .select("id")
        .where("conversationId", "=", channel.conversationId)
        .where("kind", "=", "status")
        .execute();
      expect(
        earlyNotices,
        "The channel must hear the Request while the Run is working",
      ).toHaveLength(1);
      if (narration)
        await store.commitRunnerEvent({
          environmentId: fixture.environmentId,
          runnerId: fixture.runnerId,
          runnerBootId,
          event: pendingEvent({
            bindingGeneration: fixture.bindingGeneration,
            environmentId: fixture.environmentId,
            runId: fixture.run.id,
            threadId: fixture.thread.id,
            workspaceId: fixture.workspace.id,
            ordinal: 1,
            type: "assistant.message",
            data: { content: [{ type: "text", text: narration }], messageId: createId("message") },
          }),
        });
      if (heldStop)
        await store.stopHeldRun((await store.runCapabilityScope(fixture.run.id))!, "limit");
      await finish(store, fixture, heldStop);
      const notices = await database
        .selectFrom("channelDeliveries")
        .select("content")
        .where("conversationId", "=", channel.conversationId)
        .where("kind", "=", "status")
        .execute();
      expect(notices).toHaveLength(1);
      expect(JSON.stringify(notices)).toContain("The agent has asked for your input.");
      expect(JSON.stringify(notices)).toContain(fixture.thread.id);
    });
  }
  it("holds early answers until the Run ends and all durable siblings settle across Hosts", async ({
    storeFixture,
  }) => {
    const { store, database, startRunFixture } = storeFixture;
    const fixture = await startRunFixture("request-continuation-batch");
    const secondHost = new OpensteerStore(database);
    const first = await open(store, fixture, "first");
    const second = await open(store, fixture, "second");
    const decline = (host: OpensteerStore, requestId: typeof first.request.id) =>
      host.requests.resolveBrowserRequest({
        requestId,
        resolvedBy: fixture.userId,
        response: { kind: "external", value: { decision: "declined" } },
      });
    await decline(secondHost, first.request.id);
    const visible = await store.requests.visiblePage({
      originatingThreadId: fixture.thread.id,
      targetWorkspaceId: fixture.workspace.id,
      limit: 50,
    });
    expect(visible.requests.find(({ id }) => id === first.request.id)?.status).toBe("declined");
    expect(visible.requests.find(({ id }) => id === second.request.id)?.status).toBe("pending");
    expect(await store.requests.listPendingContinuations()).toEqual([]);
    await finish(store, fixture);
    expect(await secondHost.requests.listPendingContinuations()).toEqual([]);
    const resolutions = await Promise.allSettled([
      decline(store, second.request.id),
      decline(secondHost, second.request.id),
    ]);
    expect(resolutions.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(resolutions.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "conflict" },
    });
    const eligible = await Promise.all([
      store.requests.listPendingContinuations(),
      secondHost.requests.listPendingContinuations(),
    ]);
    const ids = [first.request.id, second.request.id].sort();
    for (const rows of eligible) expect(rows.map(({ request }) => request.id).sort()).toEqual(ids);
    const idempotencyKey = `request-continuation:${createHash("sha256").update(JSON.stringify(ids)).digest("hex")}`;
    const input = {
      content: [{ type: "text" as const, text: "Both Requests were declined." }],
      idempotencyKey,
      policy: "queue" as const,
      requestedBy: fixture.userId,
      source: {
        kind: "platform" as const,
        cause: "request-resolved" as const,
        referenceId: first.request.id,
        sourceRunId: fixture.run.id,
      },
      threadId: fixture.thread.id,
    };
    const admitted = await Promise.all([
      store.enqueueThreadInput(input),
      secondHost.enqueueThreadInput(input),
    ]);
    expect(admitted[0].input.messageId).toBe(admitted[1].input.messageId);
    expect(
      await database
        .selectFrom("threadInputs")
        .select("messageId")
        .where("idempotencyKey", "=", idempotencyKey)
        .execute(),
    ).toHaveLength(1);
  });

  for (const ends of ["before-enqueue", "after-enqueue", "after-delivery"] as const) {
    it(`joins background after all siblings settle, preserving one continuation when it ends ${ends}`, async ({
      storeFixture,
    }) => {
      const { store, database, startRunFixture } = storeFixture;
      const fixture = await startRunFixture(`background-requests-${ends}`);
      const first = await open(store, fixture, "first");
      const second = await open(store, fixture, "second");
      const answer = (requestId: typeof first.request.id) =>
        store.requests.resolveBrowserRequest({
          requestId,
          resolvedBy: fixture.userId,
          response: { kind: "external", value: { decision: "declined" } },
        });
      await answer(first.request.id);
      await store.commitRunnerEvent({
        environmentId: fixture.environmentId,
        runnerId: fixture.runnerId,
        runnerBootId: fixture.runnerBootId,
        event: pendingEvent({
          bindingGeneration: fixture.bindingGeneration,
          environmentId: fixture.environmentId,
          runId: fixture.run.id,
          threadId: fixture.thread.id,
          workspaceId: fixture.workspace.id,
          ordinal: 1,
          type: "run.phase",
          data: { phase: "background" },
        }),
      });
      expect(await store.requests.listPendingContinuations()).toEqual([]);
      await answer(second.request.id);
      expect(
        (await store.requests.listPendingContinuations()).map(({ request }) => request.id).sort(),
      ).toEqual([first.request.id, second.request.id].sort());
      if (ends === "before-enqueue") await finish(store, fixture);
      const input = {
        content: [{ type: "text" as const, text: "Both profiles were declined." }],
        idempotencyKey: `background-answers-${ends}`,
        policy: "queue" as const,
        requestedBy: fixture.userId,
        source: {
          kind: "platform" as const,
          cause: "request-resolved" as const,
          referenceId: first.request.id,
          sourceRunId: fixture.run.id,
        },
        threadId: fixture.thread.id,
      };
      const admitted = await store.enqueueThreadInput(input);
      expect(admitted.disposition).toBe(ends === "before-enqueue" ? "run-queued" : "steering");
      if (ends !== "before-enqueue") {
        expect(admitted.input.runId).toBe(fixture.run.id);
        if (ends === "after-delivery") {
          await store.claimCommand(admitted.command!.id, "background-continuation");
          await store.succeedCommand(admitted.command!.id);
        }
        await finish(store, fixture);
      }
      const replay = await store.enqueueThreadInput(input);
      expect(replay.input.messageId).toBe(admitted.input.messageId);
      const rows = await database
        .selectFrom("threadInputs")
        .selectAll()
        .where("idempotencyKey", "=", input.idempotencyKey)
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.state).toBe(ends === "after-delivery" ? "delivered" : "pending");
    });
  }

  it("does not release answered Requests while the origin Run can still open another", async ({
    storeFixture,
  }) => {
    const { store, startRunFixture } = storeFixture;
    const fixture = await startRunFixture("request-continuation-before-end");
    const request = await open(store, fixture, "first");
    await store.requests.resolveBrowserRequest({
      requestId: request.request.id,
      resolvedBy: fixture.userId,
      response: { kind: "external", value: { decision: "declined" } },
    });
    expect(await store.requests.listPendingContinuations()).toEqual([]);
    await finish(store, fixture);
    expect(
      (await store.requests.listPendingContinuations()).map(({ request }) => request.id),
    ).toEqual([request.request.id]);
  });

  it("delivers a held answer once and retains fallback for an abandoned call", async ({
    storeFixture,
  }) => {
    const { store, startRunFixture } = storeFixture;
    const fixture = await startRunFixture("held-request-delivery");
    const claims = (await store.runCapabilityScope(fixture.run.id))!;
    const held = await open(store, fixture, "held");
    const abandoned = await open(store, fixture, "abandoned");
    for (const requestId of [held.request.id, abandoned.request.id])
      await store.requests.resolveBrowserRequest({
        requestId,
        resolvedBy: fixture.userId,
        response: { kind: "external", value: { decision: "declined" } },
      });
    expect(await store.requests.markToolDelivered(held.request.id, claims)).toBe("delivered");
    expect(await store.requests.markToolDelivered(held.request.id, claims)).toBe(
      "already-delivered",
    );
    await finish(store, fixture);
    expect(
      (await store.requests.listPendingContinuations()).map(({ request }) => request.id),
    ).toEqual([abandoned.request.id]);
  });

  it("refuses stale delivery and stop without consuming fallback", async ({ storeFixture }) => {
    const { store, startRunFixture } = storeFixture;
    const fixture = await startRunFixture("stale-held-request");
    const claims = (await store.runCapabilityScope(fixture.run.id))!;
    const opened = await open(store, fixture, "held");
    await store.requests.resolveBrowserRequest({
      requestId: opened.request.id,
      resolvedBy: fixture.userId,
      response: { kind: "external", value: { decision: "declined" } },
    });
    const stale = { ...claims, bindingGeneration: claims.bindingGeneration + 1 };
    expect(await store.requests.markToolDelivered(opened.request.id, stale)).toBe("refused");
    expect(await store.stopHeldRun(stale, "limit")).toBeNull();
    await finish(store, fixture);
    expect(
      (await store.requests.listPendingContinuations()).map(({ request }) => request.id),
    ).toEqual([opened.request.id]);
  });

  it("refuses an answered outcome after grant revocation while its Run is still running", async ({
    storeFixture,
  }) => {
    const { store, database, startRunFixture } = storeFixture;
    const fixture = await startRunFixture("revoked-held-answer");
    const claims = (await store.runCapabilityScope(fixture.run.id))!;
    const opened = await open(store, fixture, "held");
    await store.requests.resolveBrowserRequest({
      requestId: opened.request.id,
      resolvedBy: fixture.userId,
      response: { kind: "external", value: { decision: "declined" } },
    });
    expect(await store.stopHeldRun(claims, "limit")).not.toBeNull();
    expect(
      await database
        .selectFrom("runs")
        .select("status")
        .where("id", "=", fixture.run.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "running" });
    expect(await store.requests.markToolDelivered(opened.request.id, claims)).toBe("refused");
    expect(
      await database
        .selectFrom("requestContinuations")
        .select("status")
        .where("requestId", "=", opened.request.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "waiting" });
    await finish(store, fixture, true);
    expect(
      (await store.requests.listPendingContinuations()).map(({ request }) => request.id),
    ).toEqual([opened.request.id]);
  });

  for (const reason of ["limit", "queued-input"] as const) {
    it(`stops a held Run for ${reason} without pausing or closing its Request`, async ({
      storeFixture,
    }) => {
      const { store, database, startRunFixture } = storeFixture;
      const fixture = await startRunFixture(`held-stop-${reason}`);
      const claims = (await store.runCapabilityScope(fixture.run.id))!;
      const opened = await open(store, fixture, "held");
      expect(await store.stopHeldRun(claims, reason)).toMatchObject({
        commandId: expect.any(String),
      });
      expect(await store.requests.markToolDelivered(opened.request.id, claims)).toBe("refused");
      expect((await store.requests.get(opened.request.id))?.status).toBe("pending");
      expect(
        await database
          .selectFrom("threads")
          .select("inputQueuePaused")
          .where("id", "=", fixture.thread.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ inputQueuePaused: false });
      await finish(store, fixture);
      await store.requests.resolveBrowserRequest({
        requestId: opened.request.id,
        resolvedBy: fixture.userId,
        response: { kind: "external", value: { decision: "declined" } },
      });
      expect(
        (await store.requests.listPendingContinuations()).map(({ request }) => request.id),
      ).toEqual([opened.request.id]);
    });
  }

  it("sees delivered person steers in every current hold, without replaying them into a later call", async ({
    storeFixture,
  }) => {
    const { store, database, startRunFixture } = storeFixture;
    const fixture = await startRunFixture("held-person-steer");
    const opened = await open(store, fixture, "held");
    const steersAtAdmission = await store.requests.personSteerCount(fixture.run.id);
    const steered = await store.enqueueThreadInput({
      content: [{ type: "text", text: "Use another route" }],
      idempotencyKey: "person-steer",
      policy: "steer",
      requestedBy: fixture.userId,
      source: { kind: "human" },
      threadId: fixture.thread.id,
    });
    const command = await database
      .selectFrom("commands")
      .selectAll()
      .where("id", "=", steered.command!.id)
      .executeTakeFirstOrThrow();
    expect(command.type).toBe("run.steer");
    await store.claimCommand(command.id, "person-steer-dispatch");
    expect(
      await store.requests.holdSnapshot(opened.request.id, fixture.run.id, steersAtAdmission),
      "A steer still on its way must keep the call held",
    ).toMatchObject({ steered: false, queued: false });
    await store.commitRunnerEvent({
      environmentId: fixture.environmentId,
      runnerId: fixture.runnerId,
      runnerBootId: fixture.runnerBootId,
      event: pendingEvent({
        bindingGeneration: fixture.bindingGeneration,
        environmentId: fixture.environmentId,
        runId: fixture.run.id,
        threadId: fixture.thread.id,
        workspaceId: fixture.workspace.id,
        ordinal: 1,
        type: "message.injected",
        data: { messageId: steered.input.messageId },
      }),
    });
    expect(
      await database
        .selectFrom("threadInputs")
        .select("state")
        .where("messageId", "=", steered.input.messageId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "delivered" });
    for (const snapshot of await Promise.all([
      store.requests.holdSnapshot(opened.request.id, fixture.run.id, steersAtAdmission),
      store.requests.holdSnapshot(opened.request.id, fixture.run.id, steersAtAdmission),
    ]))
      expect(snapshot).toMatchObject({ steered: true, queued: false });
    expect(
      await store.requests.holdSnapshot(
        opened.request.id,
        fixture.run.id,
        await store.requests.personSteerCount(fixture.run.id),
      ),
    ).toMatchObject({ steered: false, queued: false });
  });

  it("ignores continuations, reports and agent messages while a Request is held", async ({
    storeFixture,
  }) => {
    const { store, startRunFixture } = storeFixture;
    const fixture = await startRunFixture("held-machine-inputs");
    const opened = await open(store, fixture, "held");
    const steersAtAdmission = await store.requests.personSteerCount(fixture.run.id);
    const sources = [
      {
        source: {
          kind: "platform" as const,
          cause: "request-resolved",
          sourceRunId: fixture.run.id,
        },
        policy: "queue" as const,
      },
      { source: { kind: "human" as const }, policy: "report" as const },
      { source: { kind: "agent" as const, runId: fixture.run.id }, policy: "queue" as const },
    ];
    for (const [index, input] of sources.entries()) {
      await store.enqueueThreadInput({
        ...input,
        content: [{ type: "text", text: "Machine work" }],
        idempotencyKey: `machine-${index}`,
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      expect(
        await store.requests.holdSnapshot(opened.request.id, fixture.run.id, steersAtAdmission),
      ).toMatchObject({ queued: false, steered: false });
    }
  });

  it("releases an old Run's settled outcomes when a person starts newer work without holding their message", async ({
    storeFixture,
  }) => {
    const { store, startRunFixture } = storeFixture;
    const fixture = await startRunFixture("request-continuation-newer");
    const first = await open(store, fixture, "answered");
    await open(store, fixture, "still-pending");
    await store.requests.resolveBrowserRequest({
      requestId: first.request.id,
      resolvedBy: fixture.userId,
      response: { kind: "external", value: { decision: "declined" } },
    });
    await finish(store, fixture);
    expect(await store.requests.listPendingContinuations()).toEqual([]);
    const next = await store.enqueueThreadInput({
      content: [{ type: "text", text: "Skip that, continue with something else" }],
      idempotencyKey: "continue-after-request",
      policy: "queue",
      requestedBy: fixture.userId,
      source: { kind: "human" },
      threadId: fixture.thread.id,
    });
    expect(next.disposition).toBe("run-queued");
    expect(
      (await store.requests.listPendingContinuations()).map(({ request }) => request.id),
    ).toEqual([first.request.id]);
  });

  for (const reason of [
    "resource-deleted",
    "authority-revoked",
    "run-ended",
    "process-lost",
    "source-closed",
    "thread-archived",
    "workspace-deleted",
    "membership-revoked",
  ] satisfies RequestCancellationReason[]) {
    it(`continues cancellation only when work remains (${reason})`, async ({ storeFixture }) => {
      const { store, database, startRunFixture } = storeFixture;
      const fixture = await startRunFixture(`request-cancel-${reason}`);
      const request = await open(store, fixture, "cancelled");
      await finish(store, fixture);
      await withDatabaseTransaction(database, (tx) =>
        cancelPending(tx, { requestIds: [request.request.id], reason, resolvedAt: new Date() }),
      );
      const eligible = await store.requests.listPendingContinuations();
      expect(eligible.map(({ request }) => request.id)).toEqual(
        reason === "resource-deleted" || reason === "authority-revoked" ? [request.request.id] : [],
      );
    });
  }
});
