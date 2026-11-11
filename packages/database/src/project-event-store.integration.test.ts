import { randomUUID } from "node:crypto";
import { createId, type ProjectEngineRequestEvent } from "@opensteer/core";
import { RunnerConnectionFenceSchema, type ProjectRunControl } from "@opensteer/protocol";
import { expect } from "vitest";
import { describeStore } from "./store.integration.test-support.js";
import { prepareProjectAdmission } from "./project-work.test-support.js";
import { ProjectBindingStore, ProjectExecutionStore } from "./project-execution-store.js";
import { ProjectProposalAcceptanceStore } from "./project-event-store.js";
import { pauseAfterLock } from "./lock-race.test-support.js";
import { withTimeout } from "@opensteer/shared/withTimeout";

async function proposalFixture(fixture: Parameters<typeof prepareProjectAdmission>[0]) {
  const context = await prepareProjectAdmission(fixture);
  const { project, prepared, store, origin, database } = context;
  const admitted = await store.admitProjectWork({
    threadId: prepared.thread.id,
    origin,
    source: { kind: "human" },
    content: [{ type: "text", text: "Work" }],
    policy: "queue",
    idempotencyKey: "proposal-seed",
  });
  if (!admitted.commandId) throw new Error("Proposal fixture has no command");
  const bootId = `rbt_${randomUUID()}`;
  const bound = await new ProjectBindingStore(database, {
    runnerIsAttached: (runnerId, boot) => runnerId === project.runnerId && boot === bootId,
  }).acquire({
    commandId: admitted.commandId,
    runnerId: project.runnerId,
    runnerBootId: bootId,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    leaseTokenHash: "proposal-fixture-lease",
    dispatcherId: "proposal-fixture",
  });
  const peer = RunnerConnectionFenceSchema.parse({
    runnerId: project.runnerId,
    bootId,
    connectionGeneration: 1,
    connectionId: `rcn_${randomUUID()}`,
    connectionLeaseId: `rls_${randomUUID()}`,
  });
  const event = {
    type: "request.proposed.project" as const,
    binding: bound.binding,
    ordinal: 0,
    emittedAt: new Date().toISOString(),
    data: {
      request: {
        id: createId("request"),
        callId: "question-one",
        createdAt: new Date().toISOString(),
        mode: "live" as const,
        kind: "harness.input" as const,
        requestClass: "question" as const,
        payload: { kind: "harness.input" as const },
        presentation: {
          kind: "choice" as const,
          title: "Choose",
          options: [{ id: "yes", hint: "confirm" as const, label: "Yes" }],
        },
      },
    },
  };
  const frame = { ...peer, type: "runner.project.event", event };
  return { ...context, peer, event, frame, binding: bound.binding };
}

describeStore("Project proposal acceptance", (it) => {
  it("commits one exact source proposal and its durable refusal before returning, then rejects ordinal mutations", async ({
    storeFixture,
  }) => {
    const { database, peer, event, frame, binding } = await proposalFixture(storeFixture);
    const controls = new ProjectExecutionStore();
    const calls: ProjectEngineRequestEvent[] = [];
    const barrier = pauseAfterLock(
      database,
      (node) => node.includes('"InsertQueryNode"') && node.includes('"agent_control_requests"'),
    );
    const handler = new ProjectProposalAcceptanceStore(barrier.database, {
      currentPeerIsProjectCapable: () => true,
      requests: {
        async propose(transaction, input) {
          calls.push(input);
          const control: Extract<ProjectRunControl, { kind: "request.refuse" }> = {
            kind: "request.refuse",
            requestId: input.data.request.id,
            callId: input.data.request.callId,
            reason: "unsupported-request-kind",
          };
          await controls.enqueue(transaction, {
            binding: input.binding,
            idempotencyKey: JSON.stringify([
              "project-request",
              input.data.request.id,
              input.data.request.callId,
            ]),
            control,
          });
          return { state: "refused", control };
        },
      },
    });
    let returned = false;
    const accepted = handler.accept(peer, frame).then((result) => {
      returned = true;
      return result;
    });
    void accepted.catch(() => undefined);
    try {
      await withTimeout(barrier.reached, 3000, {
        timeoutError: () => new Error("Proposal acceptance never reserved its receipt"),
      });
      expect(returned).toBe(false);
      expect(
        await database.selectFrom("agentControlRequests").select("requestId").execute(),
      ).toEqual([]);
      barrier.release();
      const result = await withTimeout(accepted, 3000, {
        timeoutError: () =>
          new Error("Proposal acceptance did not commit after its receipt barrier"),
      });
      expect(result).toMatchObject({
        binding,
        ordinal: 0,
        wasDuplicate: false,
        proposalState: "refused",
        events: [],
      });
      expect(calls).toEqual([{ type: "request.proposed.project", binding, data: event.data }]);
      expect(calls[0]?.data.request).not.toHaveProperty("requestedBy");
      expect(calls[0]?.data.request).not.toHaveProperty("requiredActor");
      expect(calls[0]?.data.request).not.toHaveProperty("audience");
      expect(await handler.accept(peer, frame)).toMatchObject({
        ordinal: 0,
        wasDuplicate: true,
        events: [],
      });
      expect(calls).toHaveLength(1);
      const receipts = await database
        .selectFrom("agentControlRequests")
        .select(["action", "actionClass"])
        .execute();
      expect(receipts).toEqual([{ action: "project.event", actionClass: "project.event" }]);
      expect(
        await database
          .selectFrom("commands")
          .select("id")
          .where("type", "=", "run.control.project")
          .execute(),
      ).toHaveLength(1);
      expect(await database.selectFrom("requests").select("id").execute()).toEqual([]);
      await expect(
        handler.accept(peer, {
          ...frame,
          event: { ...event, data: { request: { ...event.data.request, callId: "changed" } } },
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(
        handler.accept(peer, { ...frame, event: { ...event, ordinal: 2 } }),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(
        (
          await database
            .selectFrom("runs")
            .select("nextRunnerOrdinal")
            .where("id", "=", binding.runId)
            .executeTakeFirstOrThrow()
        ).nextRunnerOrdinal,
      ).toBe(1);
    } finally {
      barrier.release();
      await withTimeout(Promise.allSettled([accepted]), 3000, {
        timeoutError: () => new Error("Proposal barrier cleanup did not settle"),
      });
    }
  });

  it("refuses stale connections and mixed envelopes before SQL and rolls back both receipt and Q control on failure", async ({
    storeFixture,
  }) => {
    const { database, peer, frame, binding } = await proposalFixture(storeFixture);
    let statements = 0;
    const measured = database.withPlugin({
      transformQuery(args) {
        statements += 1;
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    });
    let current = false;
    const failure = new Error("Q failed before commit");
    const controls = new ProjectExecutionStore();
    let calls = 0;
    const handler = new ProjectProposalAcceptanceStore(measured, {
      currentPeerIsProjectCapable: () => current,
      requests: {
        async propose(transaction, input) {
          calls += 1;
          await controls.enqueue(transaction, {
            binding: input.binding,
            idempotencyKey: "rolled-back",
            control: {
              kind: "request.refuse",
              requestId: input.data.request.id,
              callId: input.data.request.callId,
              reason: "unsupported-request-kind",
            },
          });
          throw failure;
        },
      },
    });
    await expect(handler.accept(peer, frame)).rejects.toMatchObject({ code: "forbidden" });
    expect(statements).toBe(0);
    current = true;
    await expect(
      handler.accept(peer, {
        ...frame,
        event: {
          ...frame.event,
          data: { request: { ...frame.event.data.request, requestedBy: createId("user") } },
        },
      }),
    ).rejects.toThrow();
    await expect(handler.accept(peer, { ...frame, connectionGeneration: 2 })).rejects.toMatchObject(
      { code: "forbidden" },
    );
    expect(statements).toBe(0);
    await expect(handler.accept(peer, frame)).rejects.toBe(failure);
    expect(calls).toBe(1);
    expect(await database.selectFrom("agentControlRequests").select("requestId").execute()).toEqual(
      [],
    );
    expect(
      await database
        .selectFrom("commands")
        .select("id")
        .where("type", "=", "run.control.project")
        .execute(),
    ).toEqual([]);
    expect(
      (
        await database
          .selectFrom("runs")
          .select("nextRunnerOrdinal")
          .where("id", "=", binding.runId)
          .executeTakeFirstOrThrow()
      ).nextRunnerOrdinal,
    ).toBe(0);
    const origin = binding.authority.origin;
    if (!origin) throw new Error("Proposal fixture must retain its human root");
    await database
      .updateTable("users")
      .set({ authorityGeneration: "2" })
      .where("id", "=", origin.userId)
      .execute();
    await expect(handler.accept(peer, frame)).rejects.toMatchObject({ code: "forbidden" });
    expect(calls).toBe(1);
  });
});
