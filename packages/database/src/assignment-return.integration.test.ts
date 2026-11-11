import { lockDeploymentEvents } from "./deployment-events.js";
import { createId, type AssignmentId } from "@opensteer/core";

import { withTimeout } from "@opensteer/shared/withTimeout";
import { sql } from "kysely";
import { expect, vi } from "vitest";
import {
  beginAssignmentResultWait,
  endAssignmentResultWait,
  readAssignmentResult,
  recoverAssignmentResultWaits,
} from "./thread-inbox.js";
import type { ThreadCallerAuthority } from "./thread-caller.js";
import {
  describeStore,
  pendingEvent,
  testContinuationIdentity,
  testModelSelection,
  type StoreFixture,
} from "./store.integration.test-support.js";
function byDeadline<T>(promise: Promise<T>, message: string) {
  return withTimeout(promise, 5_000, {
    timeoutError: () => new Error(message),
  });
}
async function deliveryFixture(storeFixture: StoreFixture, suffix: string) {
  const { store, database } = storeFixture;
  const f = await storeFixture.startRunFixture(suffix);
  const authority: ThreadCallerAuthority = {
    kind: "run",
    userId: f.userId,

    accessMode: f.thread.accessMode,
    scope: {
      runId: f.run.id,
      threadId: f.thread.id,
      environmentId: f.environmentId,
      requestedBy: f.userId,
      runnerId: f.runnerId,
      runnerBootId: f.runnerBootId,
      bindingGeneration: f.bindingGeneration,
    },
  };
  const delegate = async (
    title: string,
    origin: Parameters<StoreFixture["store"]["delegateThread"]>[0]["origin"] = {
      kind: "run",
      parentRunId: f.run.id,
      parentThreadId: f.thread.id,
    },
  ) => {
    const task = await store.delegateThread({
      accessMode: f.thread.accessMode,
      createdBy: f.userId,
      environmentId: f.environmentId,
      harnessInstanceId: f.harnessInstance.id,
      idempotencyKey: `${suffix}-${title}`,
      modelSelection: testModelSelection,
      origin,
      task: [
        {
          type: "text",
          text: title,
        },
      ],
      title,
    });
    await store.claimCommand(task.command.id, `${suffix}-${title}-dispatcher`);
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: f.harnessInstance.id,
      leaseTokenHash: `${suffix}-${title}-lease`,
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
      runId: task.run.id,
      threadId: task.thread.id,
    });
    const commit = (event: Parameters<typeof pendingEvent>[0]) =>
      store.commitRunnerEvent({
        environmentId: f.environmentId,
        runnerBootId: f.runnerBootId,
        runnerId: f.runnerId,
        event: pendingEvent(event),
      });
    const event = {
      environmentId: f.environmentId,
      bindingGeneration: binding.bindingGeneration,
      runId: task.run.id,
      threadId: task.thread.id,
    };
    await commit({
      ...event,
      ordinal: 0,
      type: "run.started",
      data: {
        status: "running",
      },
    });
    return {
      ...task,
      settle: async (text: string) => {
        await commit({
          ...event,
          ordinal: 1,
          type: "assistant.message",
          data: {
            content: [
              {
                type: "text",
                text,
              },
            ],
            messageId: createId("message"),
          },
        });
        await commit({
          ...event,
          ordinal: 2,
          type: "run.completed",
          data: {
            status: "completed",
          },
        });
      },
    };
  };
  const returns = () =>
    database
      .selectFrom("threadInputs")
      .innerJoin("messages", "messages.id", "threadInputs.messageId")
      .select(["messages.id", "messages.content", "threadInputs.state", "threadInputs.policy"])
      .where("threadInputs.threadId", "=", f.thread.id)
      .where("messages.kind", "=", "continuation")
      .where("threadInputs.state", "!=", "cancelled")
      .orderBy("messages.sequence", "asc")
      .execute();
  const read = (assignmentId: AssignmentId) =>
    readAssignmentResult(database, {
      assignmentId,
      authority,
    });
  const begin = (assignmentId: AssignmentId) =>
    beginAssignmentResultWait(database, {
      assignmentId,
      authority,
      timeoutMs: 100_000,
    });
  const race = async (first: () => Promise<unknown>, second: () => Promise<unknown>) => {
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const blocker = database.transaction().execute(async (tx) => {
      await lockDeploymentEvents(tx);
      held.resolve();
      await byDeadline(
        release.promise,
        "Concurrent return transactions never released their fence",
      );
    });
    let operations: Promise<unknown>[] = [];
    try {
      await byDeadline(held.promise, "Return race never acquired the Deployment fence");
      operations = [first(), second()];
      for (const operation of operations) void operation.catch(() => {});
      await vi.waitFor(
        async () => {
          const { rows } = await sql<{
            waiting: number;
          }>`select count(*)::integer as waiting
          from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`.execute(
            database,
          );
          expect(
            rows[0]!.waiting,
            "Both return transactions never reached the fence",
          ).toBeGreaterThanOrEqual(2);
        },
        {
          timeout: 2_000,
        },
      );
    } finally {
      release.resolve();
      await byDeadline(blocker, "Return race fence never committed");
    }
    return byDeadline(Promise.all(operations), "Concurrent return transactions never settled");
  };
  return {
    ...storeFixture,
    f,
    authority,
    delegate,
    returns,
    read,
    begin,
    race,
  };
}
describeStore("Assignment result delivery", (it) => {
  for (const kind of ["trigger", "watch"] as const) {
    it(`groups ${kind} siblings by their occurrence or observation`, async ({ storeFixture }) => {
      const s = await deliveryFixture(storeFixture, `return-${kind}-groups`);
      const occurrence =
        kind === "trigger" ? await s.startTriggerOccurrence(s.f, "return-first") : null;
      const nextOccurrence =
        kind === "trigger" ? await s.startTriggerOccurrence(s.f, "return-next") : null;
      const watch =
        kind === "watch"
          ? await s.triggers.create({
              actorThreadId: null,
              anchorThreadId: s.f.thread.id,
              createdBy: s.f.userId,
              idempotencyKey: "return-watch",
              name: "Watch returns",
              source: {
                kind: "watch",
              },
              program: {
                toolContractVersion: 3,
                language: "javascript",
                source: "export default async () => null",
              },
            })
          : null;
      const watches = watch
        ? await s.triggers.reconcileWatchesForRunner({
            environmentId: s.f.environmentId,
            leaseExpiresAt: new Date(Date.now() + 60_000),
            runnerBootId: s.f.runnerBootId,
            runnerConnectionGeneration: 1,
            runnerId: s.f.runnerId,
          })
        : null;
      const activation = watches?.activations[0]!.activation;
      for (const [index, title] of ["First", "Sibling", "Different source"].entries()) {
        const origin =
          watch && activation
            ? {
                kind: "watch" as const,
                activationId: activation.id,
                observationId: index === 2 ? "next" : "first",
                revisionId: watch.revision.id,
                triggerId: watch.trigger.id,
                parentThreadId: s.f.thread.id,
              }
            : {
                kind: "trigger" as const,
                occurrenceId: (index === 2 ? nextOccurrence! : occurrence!).id,
                parentThreadId: s.f.thread.id,
              };
        const task = await s.delegate(title, origin);
        await task.settle(`${title} result`);
        await s.store.drainAssignmentReturn(task.assignment.id);
      }
      const messages = await s.returns();
      expect(messages).toHaveLength(2);
      expect(JSON.stringify(messages[0]!.content)).toContain("First result");
      expect(JSON.stringify(messages[0]!.content)).toContain("Sibling result");
      expect(JSON.stringify(messages[0]!.content)).not.toContain("Different source result");
      expect(JSON.stringify(messages[1]!.content)).toContain("Different source result");
    });
  }
  it("joins three settled siblings, bounds their notice, and seals it when taken", async ({
    storeFixture,
  }) => {
    const s = await deliveryFixture(storeFixture, "grouped-returns");
    const tasks = [];
    const longResult = `Long result ${'🙂"\n'.repeat(20_000)}`;
    for (const title of ["First worker", "Second worker", "Third worker", "Late worker"])
      tasks.push(await s.delegate(title));
    for (const [index, task] of tasks.slice(0, 3).entries()) {
      await task.settle(index === 1 ? longResult : `Result ${index}`);
      await s.store.drainAssignmentReturn(task.assignment.id);
    }
    const messages = await s.returns();
    expect(messages).toHaveLength(1);
    const content = JSON.stringify(messages[0]!.content);
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(64 * 1_024);
    for (const task of tasks.slice(0, 3)) {
      expect(content).toContain(task.thread.title);
      expect(content).toContain(task.assignment.id);
      expect(content).toContain(task.thread.id);
    }
    expect(content).toContain("Result 0");
    expect(content).toContain("Result 2");
    expect(content).toContain("Result shortened");
    expect(content).toContain("task_status");
    expect(content).toContain("thread_read");
    expect(content).not.toContain("\ufffd");
    expect((await s.read(tasks[0]!.assignment.id)).result).toBe("Result 0");
    const sealedContent = (await s.returns())[0]!.content;
    expect(Buffer.byteLength(JSON.stringify(sealedContent))).toBeLessThanOrEqual(
      Buffer.byteLength(content),
    );
    expect(JSON.stringify(sealedContent)).not.toContain("Result 0");
    await s.store.commitRunnerEvent({
      environmentId: s.f.environmentId,
      runnerBootId: s.f.runnerBootId,
      runnerId: s.f.runnerId,
      event: pendingEvent({
        bindingGeneration: s.f.bindingGeneration,
        environmentId: s.f.environmentId,
        ordinal: 1,
        runId: s.f.run.id,
        threadId: s.f.thread.id,
        type: "run.completed",
        data: {
          status: "completed",
        },
      }),
    });
    const next = await s.database
      .selectFrom("commands")
      .select(["id", "runId"])
      .where("threadId", "=", s.f.thread.id)
      .where("type", "=", "run.execute")
      .where("status", "=", "pending")
      .executeTakeFirstOrThrow();
    await s.store.claimCommand(next.id, "take-grouped-results");
    expect(await s.returns()).toMatchObject([
      {
        state: "claimed",
      },
    ]);
    await tasks[3]!.settle("Late result");
    await s.store.drainAssignmentReturn(tasks[3]!.assignment.id);
    const after = await s.returns();
    expect(after).toHaveLength(2);
    expect(after[0]!.content).toEqual(sealedContent);
    expect(JSON.stringify(after[1]!.content)).toContain("Late result");
    expect((await s.returns())[0]!.content).toEqual(sealedContent);
  });
  it("keeps every result when sibling returns race, and reading removes only its member", async ({
    storeFixture,
  }) => {
    const s = await deliveryFixture(storeFixture, "return-races");
    const a = await s.delegate("First result");
    const b = await s.delegate("Second result");
    await a.settle("Answer A");
    await b.settle("Answer B");
    await s.race(
      () => s.store.drainAssignmentReturn(a.assignment.id),
      () => s.store.drainAssignmentReturn(b.assignment.id),
    );
    expect(await s.returns()).toHaveLength(1);
    const c = await s.delegate("Third result");
    await c.settle("Answer C");
    await s.race(
      () => s.read(a.assignment.id),
      () => s.store.drainAssignmentReturn(c.assignment.id),
    );
    const messages = await s.returns();
    expect(messages).toHaveLength(1);
    expect(JSON.stringify(messages[0]!.content)).not.toContain("Answer A");
    expect(JSON.stringify(messages[0]!.content)).toContain("Answer B");
    expect(JSON.stringify(messages[0]!.content)).toContain("Answer C");
    expect((await s.read(a.assignment.id)).result).toBe("Answer A");
    expect((await s.read(b.assignment.id)).result).toBe("Answer B");
    expect(await s.returns()).toHaveLength(1);
    expect((await s.read(c.assignment.id)).result).toBe("Answer C");
    expect(await s.returns()).toEqual([]);
    const rows = await s.database
      .selectFrom("delegations")
      .select(["resultMessageId", "resultReason"])
      .where("id", "in", [a.assignment.id, b.assignment.id, c.assignment.id])
      .execute();
    expect(new Set(rows.map(({ resultMessageId }) => resultMessageId)).size).toBe(1);
    expect(rows.every(({ resultReason }) => resultReason === "read-by-assigner")).toBe(true);
    const d = await s.delegate("Concurrent settlement D");
    const e = await s.delegate("Concurrent settlement E");
    await s.race(
      () => d.settle("Answer D"),
      () => e.settle("Answer E"),
    );
    await Promise.all([
      s.store.drainAssignmentReturn(d.assignment.id),
      s.store.drainAssignmentReturn(e.assignment.id),
    ]);
    expect(await s.returns()).toHaveLength(1);
    const f = await s.delegate("Settlement against read");
    let resultRead: string | null | undefined;
    await s.race(
      () => f.settle("Answer F"),
      async () => {
        resultRead = (await s.read(f.assignment.id)).result;
      },
    );
    await s.store.drainAssignmentReturn(f.assignment.id);
    const remaining = await s.returns();
    expect(remaining).toHaveLength(1);
    const text = JSON.stringify(remaining[0]!.content);
    expect(text).toContain("Answer D");
    expect(text).toContain("Answer E");
    expect([null, "Answer F"]).toContain(resultRead);
    expect(text.split("Answer F")).toHaveLength(resultRead === "Answer F" ? 1 : 2);
  });

  it("holds a result for concurrent live waits and returns it once after their last release", async ({
    storeFixture,
  }) => {
    const s = await deliveryFixture(storeFixture, "return-waits");
    const task = await s.delegate("Waited task");
    const waitId = (await s.begin(task.assignment.id))!;
    const otherId = (await s.begin(task.assignment.id))!;
    await task.settle("Waited result");
    expect(await s.store.drainAssignmentReturn(task.assignment.id)).toEqual([]);
    expect(await s.returns()).toEqual([]);
    await endAssignmentResultWait(s.database, {
      assignmentId: task.assignment.id,
      waitId,
    });
    expect(await s.returns()).toEqual([]);
    await endAssignmentResultWait(s.database, {
      assignmentId: task.assignment.id,
      waitId: otherId,
    });
    await s.store.drainPendingAssignmentReturns();
    await endAssignmentResultWait(s.database, {
      assignmentId: task.assignment.id,
      waitId: otherId,
    });
    expect(await s.returns()).toHaveLength(1);
  });
  for (const ending of ["restart", "deadline", "run-end"] as const) {
    it(`recovers exactly one return when a persistent wait ends by ${ending}`, async ({
      storeFixture,
    }) => {
      const s = await deliveryFixture(storeFixture, `return-${ending}`);
      const task = await s.delegate("Waiting task");
      await s.begin(task.assignment.id);
      await task.settle("Recovered result");
      await s.store.drainPendingAssignmentReturns();
      expect(await s.returns()).toEqual([]);
      if (ending === "restart") await recoverAssignmentResultWaits(s.database);
      else if (ending === "deadline") {
        await sql`update delegations set result_waits = (
          select jsonb_agg(jsonb_set(wait, '{expiresAt}', '0')) from jsonb_array_elements(result_waits) wait
        ) where id = ${task.assignment.id}`.execute(s.database);
      } else {
        await s.store.commitRunnerEvent({
          environmentId: s.f.environmentId,
          runnerBootId: s.f.runnerBootId,
          runnerId: s.f.runnerId,
          event: pendingEvent({
            bindingGeneration: s.f.bindingGeneration,
            environmentId: s.f.environmentId,
            ordinal: 1,
            runId: s.f.run.id,
            threadId: s.f.thread.id,
            type: "run.completed",
            data: {
              status: "completed",
            },
          }),
        });
      }
      await s.store.drainPendingAssignmentReturns();
      await s.store.drainPendingAssignmentReturns();
      expect(await s.returns()).toHaveLength(1);
      expect(JSON.stringify((await s.returns())[0]!.content)).toContain("Recovered result");
    });
  }
});
