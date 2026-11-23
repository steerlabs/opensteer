import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { AgentConnectionStore } from "./agent-connection-store.js";
import { runContextLineage, threadContextLineage } from "./run-personal-context.js";
import { startPersonalQueuedRunFixture } from "./personal-run-fixture.test-support.js";
import { sql } from "kysely";
import { TriggerStore } from "./trigger-store.js";
import {
  describeStore,
  pendingEvent,
  testModelSelection,
  type StoreFixture,
} from "./store.integration.test-support.js";

/**
 * Whose a task is, as the Runner is told it: the person's own lineage only
 * while nobody but the person has written into the task or the tasks it
 * descends from. It narrows and never widens back.
 */
async function connectedAgent(f: StoreFixture, ownerId: string) {
  const connections = new AgentConnectionStore(f.database);
  const connection = await connections.create({
    accessMode: "full-access",
    clientName: "Agent",
    expiresAt: new Date(Date.now() + 60_000),
    label: "Agent",
    resource: "https://test-host.invalid",
    userId: ownerId as never,
  });
  await connections.activate(connection.id, randomUUID());
  return connection;
}

async function finish(
  f: StoreFixture,
  fixture: Awaited<ReturnType<StoreFixture["createRunFixture"]>>,
  run: { readonly id: string; readonly threadId: string },
) {
  const started = await startPersonalQueuedRunFixture(f.store, run.id as never);
  await f.store.commitRunnerEvent({
    environmentId: fixture.environmentId,
    runnerId: fixture.runnerId,
    runnerBootId: started.runnerBootId,
    event: pendingEvent({
      type: "run.completed",
      environmentId: fixture.environmentId,
      threadId: run.threadId as never,
      runId: run.id as never,
      bindingGeneration: started.bindingGeneration,
      ordinal: 1,
      data: { status: "completed" },
    }),
  });
}

describeStore("the person's own lineage", (it) => {
  it("never counts Opensteer's own job, such as a memory pass, as the person's task", async ({
    storeFixture: f,
  }) => {
    const fixture = await f.createRunFixture("lineage-memory");
    const triggers = new TriggerStore(f.database);
    const job = await triggers.create({
      actorThreadId: null,
      anchorThreadId: fixture.threadId,
      createdBy: fixture.userId,
      idempotencyKey: "memory-job",
      name: "Memory light pass",
      program: {
        language: "javascript",
        source: "export default () => {}",
        toolContractVersion: 5,
      },
      source: {
        kind: "schedule",
        schedule: { expression: "0 3 * * *", kind: "cron", timezone: "UTC" },
      },
    });
    expect(
      (await threadContextLineage(f.database, fixture.threadId, fixture.userId)).personLineage,
    ).toBe(true);
    // What makes it a memory pass: its system role.
    await sql`update triggers set system_role = 'memory-light' where id = ${job.trigger.id}`.execute(
      f.database,
    );
    expect(
      (await threadContextLineage(f.database, fixture.threadId, fixture.userId)).personLineage,
    ).toBe(false);
  });

  it("stays the person's while only the person writes into it", async ({ storeFixture: f }) => {
    const fixture = await f.createRunFixture("lineage-own");
    const first = await f.enqueueHumanTrigger({
      content: [{ type: "text", text: "First" }],
      idempotencyKey: "own-first",
      requestedBy: fixture.userId,
      threadId: fixture.threadId,
    });
    expect((await runContextLineage(f.database, first.run.id)).personLineage).toBe(true);
    await startPersonalQueuedRunFixture(f.store, first.run.id);
    expect((await f.store.loadRunDispatchContext(first.command.id)).lineage.personLineage).toBe(
      true,
    );
  });

  it("is never the person's own again once a connected agent has written into it", async ({
    storeFixture: f,
  }) => {
    const fixture = await f.createRunFixture("lineage-connection");
    const agent = await connectedAgent(f, fixture.userId);
    const own = await f.enqueueHumanTrigger({
      content: [{ type: "text", text: "Start" }],
      idempotencyKey: "connection-start",
      requestedBy: fixture.userId,
      threadId: fixture.threadId,
    });
    await finish(f, fixture, own.run);
    // A connected agent with `everything` sends into the person's task.
    const sent = await f.store.enqueueThreadInput({
      content: [{ type: "text", text: "From the agent" }],
      idempotencyKey: "connection-sends",
      policy: "queue",
      requestedBy: fixture.userId,
      source: { connectionId: agent.id, kind: "connection" },
      threadId: fixture.threadId,
    });
    if (!sent.run) throw new Error("Expected the connected agent's Run");
    expect((await runContextLineage(f.database, sent.run.id)).personLineage).toBe(false);
    await finish(f, fixture, sent.run);
    // The person writes again: the task is still not the person's own.
    const again = await f.enqueueHumanTrigger({
      content: [{ type: "text", text: "The person again" }],
      idempotencyKey: "connection-again",
      requestedBy: fixture.userId,
      threadId: fixture.threadId,
    });
    expect((await runContextLineage(f.database, again.run.id)).personLineage).toBe(false);
    await startPersonalQueuedRunFixture(f.store, again.run.id);
    const context = await f.store.loadRunDispatchContext(again.command.id);
    expect(context.personalContext).toBe(true);
    expect(context.lineage.personLineage).toBe(false);
    // A task under it keeps that.
    const linkedUnder = async (parentThreadId: typeof fixture.threadId, key: string) =>
      (
        await f.store.createThread({
          createdBy: fixture.userId,
          environmentId: fixture.environmentId,
          harnessInstanceId: fixture.harnessInstance.id,
          idempotencyKey: key,
          modelSelection: testModelSelection,
          parentThreadId,
          title: key,
        })
      ).thread.id;
    const sub = await linkedUnder(fixture.threadId, "connection-sub");
    expect((await threadContextLineage(f.database, sub, fixture.userId)).personLineage).toBe(false);
    // The person's own automation anchored on it fires into a new task: still not own.
    const fired = async (anchorThreadId: typeof fixture.threadId, key: string) => {
      const triggers = new TriggerStore(f.database);
      const trigger = await triggers.create({
        actorThreadId: null,
        anchorThreadId,
        createdBy: fixture.userId,
        idempotencyKey: key,
        name: key,
        program: {
          language: "javascript",
          source: "export default () => {}",
          toolContractVersion: 5,
        },
        source: {
          kind: "schedule",
          schedule: { expression: "0 9 * * *", kind: "cron", timezone: "UTC" },
        },
      });
      const occurrence = await triggers.enqueueManual({
        actorThreadId: null,
        ownerId: fixture.userId,
        triggerId: trigger.trigger.id,
      });
      const { thread } = await f.store.createThread({
        createdBy: fixture.userId,
        environmentId: fixture.environmentId,
        harnessInstanceId: fixture.harnessInstance.id,
        idempotencyKey: `${key}-work`,
        modelSelection: testModelSelection,
        title: `${key} work`,
      });
      await f.enqueueHumanTrigger({
        content: [{ type: "text", text: "Fired" }],
        idempotencyKey: `${key}-work`,
        requestedBy: fixture.userId,
        threadId: thread.id,
      });
      await sql`update thread_inputs set authority_source = ${JSON.stringify({ kind: "trigger-occurrence", occurrenceId: occurrence.id, userId: fixture.userId })}::jsonb where thread_id = ${thread.id}`.execute(
        f.database,
      );
      return (await threadContextLineage(f.database, thread.id, fixture.userId)).personLineage;
    };
    expect(await fired(fixture.threadId, "fires-into-written")).toBe(false);
    // The same automation on a task nobody else wrote to stays the person's own.
    const untouched = await f.createRunFixture("lineage-untouched");
    expect(await fired(untouched.threadId, "fires-into-own")).toBe(true);
    expect(
      (await threadContextLineage(f.database, untouched.threadId, fixture.userId)).personLineage,
    ).toBe(true);
  });
});
