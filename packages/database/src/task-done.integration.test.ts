import {
  createStoreFixture,
  testModelSelection,
  testContinuationIdentity,
  testRunnerDescriptor,
  type StoreFixture,
} from "./store.integration.test-support.js";
import { jsonValue } from "./store-primitives.js";

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PendingRequestSchema, createId, type RunId } from "@opensteer/core";
import { type PendingAgentEvent } from "@opensteer/protocol";

import { afterAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { OpensteerStore } from "./index.js";
import { pauseAfterLock } from "./lock-race.test-support.js";
import { TriggerStore } from "./trigger-store.js";
import { AutomationFailureStore, recordAutomationFailure } from "./automation-failure-store.js";
import { withPersonalTransaction } from "./personal-transaction.js";

/**
 * Stage 1 fault matrix, database side: every way a Stop, an answer, a steer or
 * a lease could slip past the authority that ended. Each scenario records its
 * outcome in `journeys.json`.
 */
const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const modelSelection = testModelSelection;
const continuationIdentity = testContinuationIdentity;
const matrix: Record<string, unknown> = {};
const now = new Date();
integration.sequential("Shared task Done", () => {
  let context: StoreFixture;
  let database: StoreFixture["database"];
  let store: StoreFixture["store"];
  beforeEach(async () => {
    context = await createStoreFixture();
    database = context.database;
    store = context.store;
  });
  afterEach(async () => context.close());
  afterAll(async () => {
    const directory = "/tmp/opensteer-task-done";
    await mkdir(directory, {
      recursive: true,
    });
    const artifact = join(directory, "journeys.json");
    await writeFile(artifact, `${JSON.stringify(matrix, null, 2)}\n`);
    console.info(`Database fault matrix: ${artifact}`);
  });
  it.each(["queued", "starting", "running"] as const)(
    "stops %s work, freezes inputs and reopens before interrupt acknowledgement",
    async (status) => {
      const f = await fixture(status);
      const run =
        status === "running"
          ? await running(f, status)
          : status === "starting"
            ? await claim(f, status)
            : (await send(f, status)).run!;
      const steered =
        status === "running"
          ? await store.enqueueThreadInput({
              content: [
                {
                  type: "text",
                  text: "Steering being delivered",
                },
              ],
              idempotencyKey: "steer-before-done",
              policy: "steer",
              requestedBy: f.userId,
              source: {
                kind: "human",
              },
              threadId: f.thread.id,
            })
          : null;
      if (steered?.command) await store.claimCommand(steered.command.id, "steer-dispatcher");
      const request = status === "running" ? await openRequest(f, run, 1) : null;
      const queued = await send(f, "follow-up");
      const done = await setDone(f, true, "done");
      expect(done.thread.doneAt).not.toBeNull();
      expect(done.thread.inputQueuePaused).toBe(false);
      expect(
        await database
          .selectFrom("threadInputs")
          .selectAll()
          .where("messageId", "=", queued.input.messageId)
          .executeTakeFirst(),
      ).toMatchObject({
        state: "cancelled",
        cancelReason: "task-done",
      });
      if (steered)
        expect(
          await database
            .selectFrom("threadInputs")
            .select(["state", "cancelReason"])
            .where("messageId", "=", steered.input.messageId)
            .executeTakeFirst(),
        ).toEqual({
          state: "cancelled",
          cancelReason: "task-done",
        });
      if (request)
        expect(
          await database
            .selectFrom("requests")
            .selectAll()
            .where("id", "=", request.id)
            .executeTakeFirst(),
        ).toMatchObject({
          status: "cancelled",
          cancellationReason: "thread-archived",
        });
      expect((await setDone(f, true, "done")).wasDuplicate).toBe(true);
      expect((await setDone(f, false, "reopen")).thread.doneAt).toBeNull();
      const next = await send(f, "after-reopen");
      expect(next.input.state).toBe("pending");
      if (status === "running") {
        await store.commitRunnerEvent({
          environmentId: f.environmentId,
          runnerBootId: f.runnerBootId,
          runnerId: f.runnerId,
          event: pendingEvent({
            bindingGeneration: f.bindingGeneration,
            data: {
              status: "interrupted",
            },
            environmentId: f.environmentId,
            ordinal: f.ordinal++,
            runId: run.id,
            threadId: f.thread.id,
            type: "run.interrupted",
          }),
        });
      }
      const followOn = await database
        .selectFrom("runs")
        .selectAll()
        .where("threadId", "=", f.thread.id)
        .where("status", "=", "queued")
        .executeTakeFirstOrThrow();
      const command = await database
        .selectFrom("commands")
        .select("id")
        .where("runId", "=", followOn.id)
        .where("type", "=", "run.execute")
        .executeTakeFirstOrThrow();
      await store.claimCommand(command.id, "reopen-dispatcher");
      await expect(bind(f, followOn.id)).resolves.toMatchObject({
        bindingGeneration: expect.any(Number),
      });
      matrix[status] = {
        threadId: f.thread.id,
        runId: run.id,
        events: done.events,
        rows: await database
          .selectFrom("threadInputs")
          .selectAll()
          .where("threadId", "=", f.thread.id)
          .execute(),
      };
    },
  );
  it.each([false, true])(
    "applies self-Done at Run end unless a person queues work: %s",
    async (pending) => {
      const f = await fixture(`self-${pending}`);
      const run = await running(f, `self-${pending}`);
      const result = await store.setThreadDone({
        done: true,
        actorRunId: run.id,
        threadId: f.thread.id,
        requestedBy: f.userId,
        idempotencyKey: "self-done",
      });
      expect(result.doneWhenRunEnds).toBe(true);
      expect(result.thread.doneAt).toBeNull();
      if (pending) await send(f, "person-during-run");
      await finish(f, run.id);
      const thread = await store.getThreadForOwner(f.thread.id, f.userId);
      expect(thread?.doneAt === null).toBe(pending);
      expect(
        await database
          .selectFrom("runs")
          .select("doneWhenFinished")
          .where("id", "=", run.id)
          .executeTakeFirst(),
      ).toEqual({
        doneWhenFinished: false,
      });
      matrix[`self-${pending}`] = {
        runId: run.id,
        thread,
      };
    },
  );
  it("reopen clears a pending self-Done intent", async () => {
    const f = await fixture("self-reopen");
    const run = await running(f, "self-reopen");
    await store.setThreadDone({
      done: true,
      actorRunId: run.id,
      threadId: f.thread.id,
      requestedBy: f.userId,
      idempotencyKey: "self-intent",
    });
    await setDone(f, false, "reopen-intent");
    await finish(f, run.id);
    expect((await store.getThreadForOwner(f.thread.id, f.userId))?.doneAt).toBeNull();
  });
  it("keeps an agent's self-Done intent when it reopens another task", async () => {
    const f = await fixture("self-reopen-other");
    const { thread: other } = await store.createThread({
      createdBy: f.userId,
      environmentId: f.environmentId,
      harnessInstanceId: f.harness.id,
      idempotencyKey: "thread-self-reopen-other-second",
      modelSelection,
      title: "Another task",
    });
    await store.setThreadDone({
      done: true,
      threadId: other.id,
      requestedBy: f.userId,
      idempotencyKey: "other-done",
    });
    const run = await running(f, "self-reopen-other");
    await store.setThreadDone({
      done: true,
      actorRunId: run.id,
      threadId: f.thread.id,
      requestedBy: f.userId,
      idempotencyKey: "self-intent-before-reopen",
    });
    await store.setThreadDone({
      done: false,
      actorRunId: run.id,
      threadId: other.id,
      requestedBy: f.userId,
      idempotencyKey: "reopen-other",
    });
    await finish(f, run.id);
    expect((await store.getThreadForOwner(f.thread.id, f.userId))?.doneAt).not.toBeNull();
    expect((await store.getThreadForOwner(other.id, f.userId))?.doneAt).toBeNull();
  });

  it("lets a Main worker write its assigner, stop its subtree and pause its Trigger", async () => {
    const f = await fixture("cascade");
    const parentRun = await running(f, "cascade");
    const child = await delegate(f, parentRun.id, "cascade-child");
    await database
      .updateTable("runs")
      .set({
        status: "running",
      })
      .where("id", "=", child.run.id)
      .execute();
    await store.renameThread({
      actorRunId: child.run.id,
      threadId: f.thread.id,
      requestedBy: f.userId,
      idempotencyKey: "child-renames-parent",
      title: "Renamed by a Main worker",
    });
    expect((await store.getThreadForOwner(f.thread.id, f.userId))?.title).toBe(
      "Renamed by a Main worker",
    );
    const triggers = new TriggerStore(database);
    const trigger = await triggers.create({
      actorThreadId: null,
      anchorThreadId: child.thread.id,
      createdBy: f.userId,
      idempotencyKey: "child-trigger",
      name: "Child schedule",
      program: {
        toolContractVersion: 3,
        language: "typescript",
        source: "export default async () => null;",
      },
      source: {
        kind: "schedule",
        schedule: {
          kind: "at",
          at: new Date(Date.now() + 60_000).toISOString(),
          payload: null,
        },
      },
    });
    const done = await store.setThreadDone({
      done: true,
      actorRunId: child.run.id,
      threadId: f.thread.id,
      requestedBy: f.userId,
      idempotencyKey: "child-stops-parent-subtree",
    });
    expect((await store.getThreadForOwner(child.thread.id, f.userId))?.doneAt).not.toBeNull();
    expect(
      await database
        .selectFrom("delegations")
        .select("status")
        .where("id", "=", child.assignment.id)
        .executeTakeFirst(),
    ).toEqual({
      status: "cancelled",
    });
    expect(
      await database
        .selectFrom("triggers")
        .select(["status", "nextFireAt"])
        .where("id", "=", trigger.trigger.id)
        .executeTakeFirst(),
    ).toEqual({
      status: "paused",
      nextFireAt: null,
    });
    expect(done.interruptCommands.map(({ runId }) => runId).sort()).toEqual(
      [parentRun.id, child.run.id].sort(),
    );
    matrix.cascade = {
      events: done.events,
      childThreadId: child.thread.id,
      assignmentId: child.assignment.id,
      triggerId: trigger.trigger.id,
    };
  });
  it("keeps an own-task automation running past its Done parent, which its reports and notices reopen", async () => {
    const f = await fixture("own-task");
    const triggers = new TriggerStore(database);
    const monitor = await triggers.create({
      actorThreadId: null,
      anchorThreadId: f.thread.id,
      createdBy: f.userId,
      idempotencyKey: "own-task-monitor",
      name: "Deal monitor",
      ownTask: true,
      program: {
        toolContractVersion: 3,
        language: "typescript",
        source: "export default async () => null;",
      },
      source: {
        kind: "schedule",
        schedule: { kind: "cron", expression: "*/30 * * * *", timezone: "UTC" },
      },
    });
    const ownTask = monitor.trigger.anchorThreadId;
    const runIn = async (threadId: typeof ownTask, key: string) => {
      const sent = await store.enqueueThreadInput({
        content: [{ type: "text", text: key }],
        idempotencyKey: key,
        policy: "queue",
        requestedBy: f.userId,
        source: { kind: "human" },
        threadId,
      });
      await database
        .updateTable("runs")
        .set({ status: "running" })
        .where("id", "=", sent.run!.id)
        .execute();
      return sent.run!.id;
    };
    const { thread: unrelated } = await store.createThread({
      createdBy: f.userId,
      environmentId: f.environmentId,
      harnessInstanceId: f.harness.id,
      idempotencyKey: "own-task-unrelated",
      modelSelection,
      title: "Unrelated",
    });
    const [monitorRun, unrelatedRun] = [
      await runIn(ownTask, "own-task-check"),
      await runIn(unrelated.id, "own-task-unrelated-work"),
    ];
    const isDone = async () =>
      (await store.getThreadForOwner(f.thread.id, f.userId))?.doneAt != null;
    await setDone(f, true, "own-task-done");
    expect(
      await database
        .selectFrom("triggers")
        .select("status")
        .where("id", "=", monitor.trigger.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "active" });

    // A stopped automation is reported where its owner finds it: the Done parent.
    await withPersonalTransaction(database, (transaction) =>
      recordAutomationFailure(transaction, {
        detail: "Site changed",
        reason: "paused",
        triggerId: monitor.trigger.id,
      }),
    );
    const [notice] = await new AutomationFailureStore(database).listDue();
    expect(notice).toMatchObject({
      anchorThreadId: ownTask,
      anchorThreadTitle: "Deal monitor",
      destinationThreadId: f.thread.id,
    });
    const deliverNotice = (threadId: typeof ownTask) =>
      store.enqueueThreadInput({
        content: [{ type: "text", text: "The automation stopped." }],
        idempotencyKey: `automation-failure:${notice!.id}:${threadId}`,
        policy: "queue",
        requestedBy: f.userId,
        source: { kind: "automation", noticeId: notice!.id, triggerId: monitor.trigger.id },
        threadId,
      });
    await expect(deliverNotice(unrelated.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(deliverNotice(ownTask)).rejects.toMatchObject({ code: "forbidden" });
    await deliverNotice(f.thread.id);
    expect(await isDone()).toBe(false);

    // Queued work reopens it only from a task linked under it.
    await setDone(f, true, "own-task-done-again");
    const report = (sourceRunId: typeof monitorRun, key: string) =>
      store.enqueueThreadInput({
        content: [{ type: "text", text: "Found a deal" }],
        idempotencyKey: key,
        policy: "queue",
        requestedBy: f.userId,
        source: { kind: "agent", runId: sourceRunId },
        threadId: f.thread.id,
      });
    await expect(report(unrelatedRun, "own-task-unrelated-report")).rejects.toMatchObject({
      code: "conflict",
      message: "This task is Done. Reopen it first.",
    });
    expect(await isDone()).toBe(true);
    expect((await report(monitorRun, "own-task-report")).input.state).toBe("pending");
    expect(await isDone()).toBe(false);
  });
  it("delivers a completed child's return to a Done parent as a report", async () => {
    const f = await fixture("return");
    const parentRun = await running(f, "return");
    const child = await delegate(f, parentRun.id, "return-child");
    const childFixture = {
      ...f,
      thread: child.thread,
    };
    await store.claimCommand(child.command.id, "child-dispatcher");
    const binding = await bind(childFixture, child.run.id);
    childFixture.bindingGeneration = binding.bindingGeneration;
    childFixture.ordinal = 0;
    await store.commitRunnerEvent({
      environmentId: f.environmentId,
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
      event: pendingEvent({
        bindingGeneration: binding.bindingGeneration,
        data: {
          status: "running",
        },
        environmentId: f.environmentId,
        ordinal: childFixture.ordinal++,
        runId: child.run.id,
        threadId: child.thread.id,
        type: "run.started",
      }),
    });
    await store.commitRunnerEvent({
      environmentId: f.environmentId,
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
      event: pendingEvent({
        bindingGeneration: binding.bindingGeneration,
        data: {
          content: [
            {
              type: "text",
              text: "Checked.",
            },
          ],
          messageId: createId("message"),
        },
        environmentId: f.environmentId,
        ordinal: childFixture.ordinal++,
        runId: child.run.id,
        threadId: child.thread.id,
        type: "assistant.message",
      }),
    });
    await finish(childFixture, child.run.id);
    await setDone(f, true, "parent-done");
    await store.drainPendingAssignmentReturns();
    const assignment = await database
      .selectFrom("delegations")
      .selectAll()
      .where("id", "=", child.assignment.id)
      .executeTakeFirstOrThrow();
    expect(assignment.resultStatus).toBe("delivered");
    const reports = await database
      .selectFrom("threadInputs")
      .selectAll()
      .where("threadId", "=", f.thread.id)
      .where("policy", "=", "report")
      .execute();
    expect(reports).toHaveLength(1);
    matrix.return = {
      assignment,
      reports,
    };
  });
  function delegate(f: Fixture, parentRunId: RunId, key: string) {
    return store.delegateThread({
      accessMode: "auto",
      createdBy: f.userId,
      environmentId: f.environmentId,
      harnessInstanceId: f.harness.id,
      idempotencyKey: key,
      modelSelection,
      origin: {
        kind: "run",
        parentRunId,
        parentThreadId: f.thread.id,
      },
      task: [
        {
          type: "text",
          text: key,
        },
      ],
      title: key,
    });
  }
  async function finish(f: Fixture, runId: RunId) {
    return store.commitRunnerEvent({
      environmentId: f.environmentId,
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
      event: pendingEvent({
        bindingGeneration: f.bindingGeneration,
        data: {
          status: "completed",
        },
        environmentId: f.environmentId,
        ordinal: f.ordinal++,
        runId,
        threadId: f.thread.id,
        type: "run.completed",
      }),
    });
  }
  it("keeps Done private to the personal owner and preserves unread content", async () => {
    const f = await fixture("members");
    const member = await store.createUser("Reader");

    await expect(
      store.setThreadDone({
        done: true,
        threadId: f.thread.id,
        requestedBy: member,
        idempotencyKey: "member-refused",
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    const done = await setDone(f, true, "creator-done");
    await expect(store.getThreadForOwner(f.thread.id, member)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(done.events).toContainEqual(
      expect.objectContaining({
        type: "thread.state-changed",
        data: expect.objectContaining({
          doneAt: done.thread.doneAt,
        }),
      }),
    );
    matrix.members = {
      threadId: f.thread.id,
      member,
      doneAt: done.thread.doneAt,
    };
  });
  it("settles a delegated agent's Assignment before applying its self-Done", async () => {
    const f = await fixture("delegated-self");
    const parent = await running(f, "delegated-self");
    const child = await delegate(f, parent.id, "delegated-self-child");
    const worker = {
      ...f,
      thread: child.thread,
    };
    await activateChild(worker, child);
    const intent = await store.setThreadDone({
      done: true,
      actorRunId: child.run.id,
      threadId: child.thread.id,
      requestedBy: f.userId,
      idempotencyKey: "worker-intent",
    });
    expect(intent.doneWhenRunEnds).toBe(true);
    await finish(worker, child.run.id);
    expect(
      (
        await database
          .selectFrom("delegations")
          .select("status")
          .where("id", "=", child.assignment.id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("completed");
    expect((await store.getThreadForOwner(child.thread.id, f.userId))?.doneAt).not.toBeNull();
  });
  it("keeps parent and child Done when the child completes while Done holds its Run fence", async () => {
    const f = await fixture("completion-race");
    const parent = await running(f, "completion-race");
    const child = await delegate(f, parent.id, "completion-race-child");
    const worker = {
      ...f,
      thread: child.thread,
    };
    await activateChild(worker, child);
    const barrier = pauseAfterLock(
      database,
      (node) => node.includes('"name":"runs"') && node.includes("ForNoKeyUpdate"),
    );
    const peer = new OpensteerStore(barrier.database);
    const done = peer.setThreadDone({
      done: true,
      threadId: f.thread.id,
      requestedBy: f.userId,
      idempotencyKey: "racing-done",
    });
    let completion: ReturnType<typeof finish> | undefined;
    try {
      await barrier.reached;
      completion = finish(worker, child.run.id);
      barrier.release();
      await done;
      await completion;
      expect((await store.getThreadForOwner(child.thread.id, f.userId))?.doneAt).not.toBeNull();
      expect((await store.getThreadForOwner(f.thread.id, f.userId))?.doneAt).not.toBeNull();
      expect(
        (
          await database
            .selectFrom("delegations")
            .select("status")
            .where("id", "=", child.assignment.id)
            .executeTakeFirstOrThrow()
        ).status,
      ).toBe("cancelled");
      expect(barrier.conflicts).toEqual([]);
      matrix.completionRace = {
        parent: f.thread.id,
        child: child.thread.id,
        assignmentId: child.assignment.id,
      };
    } finally {
      barrier.release();
      await Promise.allSettled([done, ...(completion ? [completion] : [])]);
    }
  });
  async function activateChild(f: Fixture, child: Awaited<ReturnType<typeof delegate>>) {
    await store.claimCommand(child.command.id, "child-dispatcher");
    const binding = await bind(f, child.run.id);
    f.bindingGeneration = binding.bindingGeneration;
    f.ordinal = 0;
    await store.commitRunnerEvent({
      environmentId: f.environmentId,
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
      event: pendingEvent({
        bindingGeneration: binding.bindingGeneration,
        data: {
          status: "running",
        },
        environmentId: f.environmentId,
        ordinal: f.ordinal++,
        runId: child.run.id,
        threadId: f.thread.id,
        type: "run.started",
      }),
    });
  }
  it("moves a quiet task to Done for its creator, and only while it stays quiet", async () => {
    const f = await fixture("quiet");
    const quiet = () =>
      store.listQuietTasks({
        now,
        limit: 100,
      });
    await touched(f, 2);
    expect(await quiet()).toEqual([]);
    await touched(f, 4);
    expect(await quiet()).toEqual([
      expect.objectContaining({
        threadId: f.thread.id,
        createdBy: f.userId,
      }),
    ]);
    // Reading it is touching it.
    await database
      .insertInto("threadReadMarkers")
      .values({
        threadId: f.thread.id,
        userId: f.userId,
        sequence: "0",
        updatedAt: new Date(),
      })
      .execute();
    expect(await quiet()).toEqual([]);
    await database
      .updateTable("threadReadMarkers")
      .set({
        updatedAt: daysAgo(4),
      })
      .where("threadId", "=", f.thread.id)
      .execute();
    await database
      .updateTable("personalSettings")
      .set({
        quietTaskDays: 0,
      })
      .where("ownerId", "=", f.userId)
      .execute();
    expect(await quiet()).toEqual([]);
    await database
      .updateTable("personalSettings")
      .set({
        quietTaskDays: 3,
      })
      .where("ownerId", "=", f.userId)
      .execute();
    const trigger = await new TriggerStore(database).create({
      actorThreadId: null,
      anchorThreadId: f.thread.id,
      createdBy: f.userId,
      idempotencyKey: "quiet-trigger",
      name: "Quiet schedule",
      program: {
        toolContractVersion: 3,
        language: "typescript",
        source: "export default async () => null;",
      },
      source: {
        kind: "schedule",
        schedule: {
          kind: "at",
          at: new Date(Date.now() + 60_000).toISOString(),
          payload: null,
        },
      },
    });
    await touched(f, 4);
    expect(await quiet()).toEqual([]);
    await database
      .updateTable("triggers")
      .set({
        status: "paused",
      })
      .where("id", "=", trigger.trigger.id)
      .execute();
    expect(await quiet()).toEqual([]);
    await database
      .updateTable("triggers")
      .set({
        status: "archived",
        nextFireAt: null,
      })
      .where("id", "=", trigger.trigger.id)
      .execute();
    expect(await quiet()).toEqual([
      expect.objectContaining({
        threadId: f.thread.id,
      }),
    ]);
    const [candidate] = await quiet();

    // Touched between the scan and its turn: nothing changes and nothing is recorded.
    await touched(f, 0);
    const skipped = await moveQuietly(f, candidate!.updatedAt);
    expect(skipped.thread).toMatchObject({
      doneAt: null,
      doneReason: null,
    });
    expect(skipped.events).toEqual([]);
    expect(await quietCommands(f)).toEqual([]);
    await touched(f, 4);
    const moved = await moveQuietly(f, candidate!.updatedAt);
    expect(moved.thread).toMatchObject({
      doneReason: "quiet",
      doneAt: expect.any(String),
    });
    expect(moved.events).toContainEqual(
      expect.objectContaining({
        type: "thread.state-changed",
        data: expect.objectContaining({
          doneReason: "quiet",
        }),
      }),
    );
    expect(await quietCommands(f)).toEqual([
      {
        authoritySource: {
          kind: "quiet-tasks",
          userId: f.userId,
        },
      },
    ]);
    // Reopening forgets why, and restarts the quiet clock.
    const reopened = await setDone(f, false, "quiet-reopen");
    expect(reopened.thread).toMatchObject({
      doneAt: null,
      doneReason: null,
    });
    expect(await quiet()).toEqual([]);
  });
  it("leaves a task whose last message's delivery is unknown where it is", async () => {
    const f = await fixture("quiet-unknown");
    await running(f, "quiet-unknown");
    const sent = await store.enqueueThreadInput({
      content: [
        {
          type: "text",
          text: "A steer the Run may not have seen",
        },
      ],
      idempotencyKey: "quiet-unknown-steer",
      policy: "steer",
      requestedBy: f.userId,
      source: {
        kind: "human",
      },
      threadId: f.thread.id,
    });
    await database
      .updateTable("runs")
      .set({
        status: "interrupted",
        completedAt: new Date(),
      })
      .where("threadId", "=", f.thread.id)
      .execute();
    await database
      .updateTable("threadInputs")
      .set({
        state: "unknown",
      })
      .where("messageId", "=", sent.input.messageId)
      .execute();
    await touched(f, 4);
    const quiet = () =>
      store.listQuietTasks({
        now: new Date(),
        limit: 100,
      });
    expect(await quiet()).toEqual([]);
    await database
      .updateTable("threadInputs")
      .set({
        state: "delivered",
        deliveredAt: new Date(),
      })
      .where("messageId", "=", sent.input.messageId)
      .execute();
    expect(await quiet()).toEqual([
      expect.objectContaining({
        threadId: f.thread.id,
      }),
    ]);
  });
  it("reopens a Done task its writer may reopen, and refuses another member's message", async () => {
    const f = await fixture("write-reopens");
    await setDone(f, true, "write-reopens-done");
    const sent = await send(f, "write-reopens-message");
    expect(sent.input.state).toBe("pending");
    expect(sent.events).toContainEqual(
      expect.objectContaining({
        type: "thread.state-changed",
        data: expect.objectContaining({
          doneAt: null,
          doneReason: null,
        }),
      }),
    );
    expect(await store.getThreadForOwner(f.thread.id, f.userId)).toMatchObject({
      doneAt: null,
    });
    const { thread: theirs } = await store.createThread({
      createdBy: f.userId,
      environmentId: f.environmentId,
      harnessInstanceId: f.harness.id,
      idempotencyKey: "thread-write-reopens-theirs",
      modelSelection,
      title: "Not the member's",
    });
    await setDone(
      {
        ...f,
        thread: theirs,
      },
      true,
      "write-reopens-theirs-done",
    );
    const member = await store.createUser("Member");

    await expect(
      store.enqueueThreadInput({
        content: [
          {
            type: "text",
            text: "From a member",
          },
        ],
        idempotencyKey: "member-message",
        policy: "queue",
        requestedBy: member,
        source: {
          kind: "human",
        },
        threadId: theirs.id,
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
  });
  it("lists Done tasks newest Done first, apart from when they were asked", async () => {
    const f = await fixture("done-order");
    const { thread: later } = await store.createThread({
      createdBy: f.userId,
      environmentId: f.environmentId,
      harnessInstanceId: f.harness.id,
      idempotencyKey: "thread-done-order-later",
      modelSelection,
      title: "Asked later",
    });
    await setDone(
      {
        ...f,
        thread: later,
      },
      true,
      "done-order-later",
    );
    await setDone(f, true, "done-order-first");
    const page = await store.taskPageForUser({
      done: true,
      maxItems: 1,
      userId: f.userId,
    });
    expect(page.tasks.map(({ thread }) => thread.id)).toEqual([f.thread.id]);
    expect(page.window).toMatchObject({
      hasMore: true,
      totalItems: 2,
    });
    const next = await store.taskPageForUser({
      before: page.window.nextBefore!,
      done: true,
      maxItems: 1,
      userId: f.userId,
    });
    expect(next.tasks.map(({ thread }) => thread.id)).toEqual([later.id]);
  });
  async function touched(f: Fixture, days: number) {
    await database
      .updateTable("threads")
      .set({
        updatedAt: daysAgo(days),
        status: "idle",
      })
      .where("id", "=", f.thread.id)
      .execute();
  }
  function moveQuietly(f: Fixture, updatedAt: Date) {
    return store.setThreadDone({
      done: true,
      quiet: true,
      threadId: f.thread.id,
      requestedBy: f.userId,
      idempotencyKey: `quiet-done:${f.thread.id}:${updatedAt.toISOString()}`,
    });
  }
  async function quietCommands(f: Fixture) {
    return database
      .selectFrom("commands")
      .select("authoritySource")
      .where("threadId", "=", f.thread.id)
      .where("idempotencyKey", "like", "quiet-done:%")
      .execute();
  }

  function send(f: Fixture, key: string) {
    return store.enqueueThreadInput({
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
        kind: "human",
      },
      threadId: f.thread.id,
    });
  }
  function setDone(f: Fixture, done: boolean, key: string) {
    return store.setThreadDone({
      done,
      threadId: f.thread.id,
      requestedBy: f.userId,
      idempotencyKey: key,
    });
  }
  async function claim(f: Fixture, suffix: string) {
    const sent = await store.enqueueThreadInput({
      content: [
        {
          text: `Work ${suffix}`,
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
    if (!sent.command || !sent.run) throw new Error("Expected a queued Run");
    await store.claimCommand(sent.command.id, `${suffix}-dispatcher`);
    return sent.run;
  }
  async function bind(
    f: Fixture,
    runId: Parameters<OpensteerStore["acquireExecutionBinding"]>[0]["runId"],
  ) {
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity,
      harnessInstanceId: f.harness.id,
      leaseTokenHash: `lease-${runId}`,
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
      runId,
      threadId: f.thread.id,
    });
    await store.bindProviderSession({
      bindingGeneration: binding.bindingGeneration,
      harnessInstanceId: f.harness.id,
      providerSessionId: binding.providerSessionId,
      providerSessionReference: `session-${f.thread.id}`,
      runId,
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
      threadId: f.thread.id,
    });
    return binding;
  }
  async function running(f: Fixture, suffix: string) {
    const run = await claim(f, suffix);
    const binding = await bind(f, run.id);
    f.bindingGeneration = binding.bindingGeneration;
    f.ordinal = 0;
    await store.commitRunnerEvent({
      environmentId: f.environmentId,
      event: pendingEvent({
        bindingGeneration: binding.bindingGeneration,
        data: {
          status: "running",
        },
        environmentId: f.environmentId,
        ordinal: f.ordinal++,
        runId: run.id,
        threadId: f.thread.id,
        type: "run.started",
      }),
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
    });
    return run;
  }
  async function openRequest(
    f: Fixture,
    run: {
      readonly id: RunId;
    },
    index: number,
  ) {
    const request = PendingRequestSchema.parse({
      callId: `call-${index}`,
      cancellationReason: null,
      createdAt: new Date().toISOString(),
      id: createId("request"),
      kind: "harness.approval",
      mode: "live",
      originatingOccurrenceId: null,
      originatingRunId: run.id,
      originatingThreadId: f.thread.id,
      payload: {
        kind: "harness.approval",
      },
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
        title: "Continue?",
      },
      requestedBy: f.userId,
      requiredActor: "requester",
      resolvedAt: null,
      resolvedBy: null,
      response: null,
      status: "pending",
    });
    await store.commitRunnerEvent({
      environmentId: f.environmentId,
      event: pendingEvent({
        bindingGeneration: f.bindingGeneration,
        data: {
          request,
        },
        environmentId: f.environmentId,
        ordinal: f.ordinal++,
        runId: run.id,
        threadId: f.thread.id,
        type: "request.opened",
      }),
      runnerBootId: f.runnerBootId,
      runnerId: f.runnerId,
    });
    return request;
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function fixture(suffix: string) {
    const f = await context.createRunFixture(suffix);
    await database.updateTable("personalSettings").set({ quietTaskDays: 3 }).execute();
    const descriptor = testRunnerDescriptor({
      environmentId: f.environmentId,
      runnerId: f.runnerId,
      name: "Fixture",
      runnerKind: "main",
    });
    await database
      .updateTable("runners")
      .set({
        capabilities: jsonValue(descriptor.capabilities),
        moduleDescriptors: descriptor.modules,
      })
      .where("id", "=", f.runnerId)
      .execute();
    return {
      bindingGeneration: 0,
      environmentId: f.environmentId,
      harness: f.harnessInstance,
      ordinal: 0,
      runnerBootId: `boot-${suffix}`,
      runnerId: f.runnerId,
      thread: f.thread,
      userId: f.userId,
    };
  }
});
function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1_000);
}
function pendingEvent<T extends PendingAgentEvent>(input: Omit<T, "emittedAt">): T {
  return {
    ...input,
    emittedAt: new Date().toISOString(),
  } as T;
}
