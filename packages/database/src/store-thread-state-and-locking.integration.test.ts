import { ChannelStore, ChannelIngressDeferredError } from "./channel-store.js";
import { pauseAfterLock } from "./lock-race.test-support.js";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { withPersonalTransaction } from "./personal-transaction.js";

import { prepareThreadInsertion } from "./thread-insertion.js";
import { takeTransactionConflicts } from "./lock-order-checker.test-support.js";

import { cancelPending } from "./request-cancellation.js";
import { HarnessIdSchema, createId, type AgentEvent, type RunnerId } from "@opensteer/core";
import { CamelCasePlugin, Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import type { DatabaseSchema } from "./schema.js";
import { describe, expect, vi } from "vitest";
import { OpensteerStore, TriggerStore } from "./index.js";
import {
  describeStore,
  testModelSelection,
  testChannelNotices,
  pendingEvent,
  liveRequest,
  sealedTestRequestResponse,
} from "./store.integration.test-support.js";
describeStore("PostgreSQL store", (it) => {
  it("pages the owner's active listed tasks with filter-bound cursors and read states", async ({
    storeFixture,
  }) => {
    const { createRunFixture, store, database } = storeFixture;
    const fixture = await createRunFixture("active-tasks");
    const make = async (
      title: string,
      status: "running" | "waiting" | "idle" | "failed" | "archived",
      listed = true,
    ) => {
      const { thread } = await store.createThread({
        createdBy: fixture.userId,
        environmentId: fixture.environmentId,
        harnessInstanceId: fixture.harnessInstance.id,
        idempotencyKey: `active-${title}`,
        modelSelection: testModelSelection,
        title,
      });
      await database
        .updateTable("threads")
        .set({ status, listed })
        .where("id", "=", thread.id)
        .execute();
      return thread.id;
    };
    const running = await make("running", "running");
    const waiting = await make("waiting", "waiting");
    await make("idle", "idle");
    await make("failed", "failed");
    await make("archived", "archived");
    await make("hidden", "running", false);
    const page = await store.taskPageForUser({ active: true, maxItems: 1, userId: fixture.userId });
    expect(page.window).toMatchObject({ hasMore: true, itemCount: 1, totalItems: 2 });
    const next = await store.taskPageForUser({
      active: true,
      before: page.window.nextBefore!,
      maxItems: 1,
      userId: fixture.userId,
    });
    expect(next.window.hasMore).toBe(false);
    expect(new Set([...page.tasks, ...next.tasks].map(({ thread }) => thread.id))).toEqual(
      new Set([running, waiting]),
    );
    expect([...page.readStates, ...next.readStates].map((state) => state.threadId)).toEqual(
      [...page.tasks, ...next.tasks].map(({ thread }) => thread.id),
    );
    await expect(
      store.taskPageForUser({ before: page.window.nextBefore!, userId: fixture.userId }),
    ).rejects.toMatchObject({ code: "bad_request" });
    const outsider = await store.createUser("Outsider");
    await expect(store.taskPageForUser({ active: true, userId: outsider })).rejects.toMatchObject({
      code: "forbidden",
    });
    await database
      .updateTable("users")
      .set({ disabledAt: new Date() })
      .where("id", "=", fixture.userId)
      .execute();
    await expect(
      store.taskPageForUser({ active: true, userId: fixture.userId }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it.for(["40P01", "40001"])(
    "retries Request transaction conflict %s within a bound",
    async (code, { storeFixture }) => {
      const { database, createRunFixture } = storeFixture;
      await createRunFixture("transaction-retry");

      let attempts = 0;
      await expect(
        withPersonalTransaction(database, async (transaction) => {
          attempts += 1;
          if (attempts < 3)
            await sql
              .raw(`do $$ begin raise exception 'retry' using errcode = '${code}'; end $$`)
              .execute(transaction);
          return attempts;
        }),
      ).resolves.toBe(3);
      attempts = 0;
      await expect(
        withPersonalTransaction(database, async (transaction) => {
          attempts += 1;
          await sql
            .raw(`do $$ begin raise exception 'retry' using errcode = '${code}'; end $$`)
            .execute(transaction);
        }),
      ).rejects.toMatchObject({
        cause: {
          code,
        },
        code: "conflict",
        retryable: true,
      });
      expect(attempts).toBe(4);
      // Two injected before the first commit, four in the bounded failure.
      expect(takeTransactionConflicts().map((conflict) => conflict.code)).toEqual(
        Array.from(
          {
            length: 6,
          },
          () => code,
        ),
      );
    },
  );

  describe("pending Thread state", () => {
    it("publishes each committed projection before waiting on the next Thread", async ({
      storeFixture,
    }) => {
      const { createRunFixture, createTaskForOwner, store, database } = storeFixture;
      const first = await createRunFixture("drain-first");
      const workspace = await createTaskForOwner(first.userId, "drain-second");
      const { thread } = await store.createThread({
        createdBy: first.userId,
        environmentId: first.environmentId,
        harnessInstanceId: first.harnessInstance.id,
        idempotencyKey: "drain-second",
        modelSelection: testModelSelection,
        title: "Second",
      });
      const second = {
        ...first,
        thread,
        workspace,
      };
      for (const [index, fixture] of [first, second].entries()) {
        await database
          .updateTable("threads")
          .set({
            pendingRequestCount: 7,
          })
          .where("id", "=", fixture.thread.id)
          .execute();
        await sql`insert into thread_state_pending (thread_id, requested_at) values (${fixture.thread.id}, ${new Date(1000 + index)})`.execute(
          database,
        );
      }
      const held = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const blocker = database.transaction().execute(async (transaction) => {
        await transaction
          .selectFrom("threads")
          .select("id")
          .where("id", "=", second.thread.id)
          .forUpdate()
          .execute();
        held.resolve();
        await release.promise;
      });
      await held.promise;
      const published: AgentEvent[] = [];
      const draining = store.drainPendingThreadStates((events) => {
        published.push(...events);
      });
      try {
        await expect
          .poll(() => published.map(({ threadId }) => threadId))
          .toEqual([first.thread.id]);
      } finally {
        release.resolve();
        await blocker;
        await draining;
      }
      expect(published.map(({ threadId }) => threadId)).toEqual([
        first.thread.id,
        second.thread.id,
      ]);
    });
    it("records Request changes and drains one absolute event only for a changed tuple", async ({
      storeFixture,
    }) => {
      const {
        startRunFixture,

        database,
        store,
      } = storeFixture;
      const fixture = await startRunFixture("pending-state");
      const input = {
        callId: "pending-state",
        kind: "browser.access" as const,
        mode: "durable" as const,
        originatingRunId: fixture.run.id,
        originatingThreadId: fixture.thread.id,
        payload: {
          kind: "browser.access" as const,
          reason: "Choose a profile",
          suggestion: {
            kind: "user_choice" as const,
          },
        },
        presentation: {
          kind: "external" as const,
          subject: {
            id: fixture.threadId,
            kind: "task" as const,
          },
          title: "Browser",
        },
        requestedBy: fixture.userId,
        requiredActor: "requester" as const,
      };
      const pending = async () =>
        (
          await sql<{
            threadId: string;
          }>`select thread_id from thread_state_pending order by thread_id`.execute(database)
        ).rows;
      const opened = await store.requests.create(input);
      expect(opened.events.map(({ type }) => type)).toEqual(["request.opened"]);
      expect(await pending()).toEqual([
        {
          threadId: fixture.thread.id,
        },
      ]);
      expect(
        (await store.getThreadForOwner(fixture.thread.id, fixture.userId))?.pendingRequests,
      ).toBe(0);
      const drained = await store.drainPendingThreadStates();
      expect(drained).toMatchObject([
        {
          type: "thread.state-changed",
          data: {
            pendingRequests: 1,
            status: "running",
            inputQueuePaused: false,
          },
        },
      ]);
      expect(BigInt(drained[0]!.sequence)).toBeGreaterThan(BigInt(opened.events[0]!.sequence));
      expect(await pending()).toEqual([]);
      expect(await store.drainPendingThreadStates()).toEqual([]);
      const resolved = await store.requests.resolveBrowserRequest({
        requestId: opened.request.id,
        resolvedBy: fixture.userId,
        response: {
          kind: "external",
          value: {
            decision: "declined",
          },
        },
      });
      expect(resolved.events.map(({ type }) => type)).toEqual(["request.resolved"]);
      expect(await pending()).toEqual([
        {
          threadId: fixture.thread.id,
        },
      ]);
      expect(await store.drainPendingThreadStates()).toMatchObject([
        {
          data: {
            pendingRequests: 0,
          },
        },
      ]);
      const second = await store.requests.create({
        ...input,
        callId: "pending-state-second",
      });
      await store.drainPendingThreadStates();
      const cancelled = await database.transaction().execute((transaction) =>
        cancelPending(transaction, {
          reason: "task-deleted",
          resolvedAt: new Date(),
        }),
      );
      expect(cancelled.map(({ type }) => type)).toEqual(["request.cancelled"]);
      expect(await pending()).toEqual([
        {
          threadId: fixture.thread.id,
        },
      ]);
      expect(await store.drainPendingThreadStates()).toMatchObject([
        {
          data: {
            pendingRequests: 0,
          },
        },
      ]);
      expect((await store.requests.get(second.request.id))?.status).toBe("cancelled");
      await store.requests.create({
        ...input,
        callId: "pending-state-coalesce",
      });
      await database.transaction().execute((transaction) =>
        cancelPending(transaction, {
          reason: "task-deleted",
          resolvedAt: new Date(),
        }),
      );
      expect(await pending()).toHaveLength(1);
      expect(await store.drainPendingThreadStates()).toEqual([]);
      await store.requests.create({
        ...input,
        callId: "pending-state-sync",
      });
      const interrupted = await store.enqueueRunnerControl({
        idempotencyKey: "pending-state-pause",
        requestedBy: fixture.userId,
        runId: fixture.run.id,
        threadId: fixture.thread.id,
        type: "run.interrupt",
      });
      expect(interrupted.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "thread.state-changed",
            data: {
              pendingRequests: 1,
              inputQueuePaused: true,
              status: "running",
              title: fixture.thread.title,
              icon: fixture.thread.icon,
              doneAt: null,
              doneReason: null,
            },
          }),
        ]),
      );
      expect(await pending()).toEqual([]);
      expect(await store.drainPendingThreadStates()).toEqual([]);
    });
  });
  it("accepts concurrent colour collisions without a global allocator lock", async ({
    storeFixture,
  }) => {
    const { createRunFixture, database } = storeFixture;
    const f = await createRunFixture("mark-collision");
    const values = await database
      .selectFrom("threads")
      .selectAll()
      .where("id", "=", f.thread.id)
      .executeTakeFirstOrThrow();
    let release = () => undefined as void;
    const observed = new Promise<void>((resolve) => {
      release = resolve;
    });
    let readers = 0;
    const rows = await Promise.all(
      [0, 1].map(() =>
        database
          .transaction()
          .setIsolationLevel("repeatable read")
          .execute(async (transaction) => {
            // Both creation snapshots see the same newest six, even if a later lock serializes inserts.
            await transaction
              .selectFrom("threads")
              .select("color")
              .where("createdBy", "=", f.userId)
              .orderBy("createdAt", "desc")
              .orderBy("id", "desc")
              .limit(6)
              .execute();
            readers += 1;
            if (readers === 2) release();
            await observed;
            const insert = await prepareThreadInsertion(transaction, {
              createdBy: f.userId,
              environmentId: f.environmentId,
              harnessInstanceId: f.harnessInstance.id,
            });
            const id = createId("thread");
            return insert({
              ...values,
              id,
              lineageRootThreadId: id,
              titleSource: "chosen",
              icon: null,
              iconSource: "provisional",
            });
          }),
      ),
    );
    expect(rows.map((value) => value.color)).toEqual(["lime", "lime"]);
  });
  describe("absolute Thread state", () => {
    it("publishes absolute state for open, resolve, cancel, pause and resume exactly when it changes", async ({
      storeFixture,
    }) => {
      const { startRunFixture, database, store } = storeFixture;
      const fixture = await startRunFixture("absolute-state");
      const states = (events: readonly AgentEvent[]) =>
        events.filter((event) => event.type === "thread.state-changed");
      const check = async (
        events: readonly AgentEvent[],
        count: number,
        status: string,
        paused = false,
      ) => {
        expect(states(events)).toMatchObject([
          {
            data: {
              pendingRequests: count,
              status,
              inputQueuePaused: paused,
            },
          },
        ]);
        const row = await sql<{
          pendingRequestCount: number;
        }>`select pending_request_count from threads where id = ${fixture.thread.id}`.execute(
          database,
        );
        const actual = await database
          .selectFrom("requests")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("originatingThreadId", "=", fixture.thread.id)
          .where("status", "=", "pending")
          .executeTakeFirstOrThrow();
        expect(row.rows[0]?.pendingRequestCount).toBe(Number(actual.count));
        expect(
          (await store.getThreadForOwner(fixture.thread.id, fixture.userId))?.pendingRequests,
        ).toBe(count);
      };
      let ordinal = 1;
      const open = async () => {
        const request = liveRequest({
          harnessInstanceId: fixture.harnessInstance.id,
          id: createId("request"),
          presentation: {
            kind: "choice",
            title: "Continue?",
            detail: "Confirm",
            options: [
              {
                hint: "confirm",
                id: "yes",
                label: "Yes",
              },
            ],
          },
          requestedBy: fixture.userId,
          runId: fixture.run.id,
          threadId: fixture.thread.id,
        });
        const result = await store.commitRunnerEvent({
          ...fixture,
          event: pendingEvent({
            bindingGeneration: fixture.bindingGeneration,
            environmentId: fixture.environmentId,
            runId: fixture.run.id,
            threadId: fixture.thread.id,
            ordinal: ordinal++,
            type: "request.opened",
            data: {
              request,
            },
          }),
        });
        return {
          request,
          result,
        };
      };
      const first = await open();
      expect(states(first.result.compensatingEvents)).toEqual([]);
      await check(await store.drainPendingThreadStates(), 1, "waiting");
      const second = await open();
      expect(states(second.result.compensatingEvents)).toEqual([]);
      await check(await store.drainPendingThreadStates(), 2, "waiting");
      const response = await store.enqueueRunnerControl({
        idempotencyKey: "absolute-resolve",
        requestedBy: fixture.userId,
        runId: fixture.run.id,
        threadId: fixture.thread.id,
        type: "request.respond",
        requestId: first.request.id,
        response: {
          kind: "choice",
          optionId: "yes",
        },
        sealedResponse: sealedTestRequestResponse(),
      });
      expect(states(response.events)).toEqual([]);
      await store.claimCommand(response.command.id, "absolute-state");
      expect(states(await store.succeedCommand(response.command.id))).toEqual([]);
      await check(await store.drainPendingThreadStates(), 1, "waiting");
      expect(states(await store.succeedCommand(response.command.id))).toEqual([]);
      expect(states(await store.requests.cancelForRun(fixture.run.id, "run-ended"))).toEqual([]);
      await check(await store.drainPendingThreadStates(), 0, "waiting");
      expect(states(await store.requests.cancelForRun(fixture.run.id, "run-ended"))).toEqual([]);
      const interrupted = await store.enqueueRunnerControl({
        idempotencyKey: "absolute-pause",
        requestedBy: fixture.userId,
        runId: fixture.run.id,
        threadId: fixture.thread.id,
        type: "run.interrupt",
      });
      // With nothing left to answer, the stopped Run is no longer waiting on anyone.
      await check(interrupted.events, 0, "running", true);
      const resumed = await store.resumeThreadInputQueue({
        idempotencyKey: "absolute-resume",
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      await check(resumed.events, 0, "running");
      expect(resumed).toHaveProperty("asOfSequence");
      const again = await store.resumeThreadInputQueue({
        idempotencyKey: "absolute-resume-again",
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      expect(states(again.events)).toEqual([]);
    });
  });
  describe("Thread status projection", () => {
    it("publishes a durable status event exactly when the stored projection changes", async ({
      storeFixture,
    }) => {
      const { createRunFixture, enqueueHumanTrigger, store, database } = storeFixture;
      const fixture = await createRunFixture("status-events");
      const turn = await enqueueHumanTrigger({
        content: [
          {
            type: "text",
            text: "Start",
          },
        ],
        idempotencyKey: "status-events",
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      const statusEvents = (events: readonly AgentEvent[]) =>
        events.filter((event) => event.type === "thread.state-changed");
      expect(statusEvents(turn.events)).toMatchObject([
        {
          data: {
            status: "running",
          },
          environmentId: fixture.environmentId,
          runId: null,
          threadId: fixture.thread.id,
        },
      ]);
      const claimed = await store.claimCommand(turn.command.id, "status-events");
      expect(statusEvents(claimed?.events ?? [])).toEqual([]);
      const interrupted = await store.enqueueRunnerControl({
        idempotencyKey: "status-events-pause",
        requestedBy: fixture.userId,
        runId: turn.run.id,
        threadId: fixture.thread.id,
        type: "run.interrupt",
      });
      // Stopped before it was bound, the Run ends at once: one change, not two.
      expect(statusEvents(interrupted.events)).toMatchObject([
        {
          data: {
            status: "idle",
            inputQueuePaused: true,
            pendingRequests: 0,
          },
        },
      ]);
      expect(await store.retryCommand(turn.command.id, new Error("Not dispatched"))).toEqual([]);
      const later = await store.enqueueThreadInput({
        content: [
          {
            type: "text",
            text: "Next",
          },
        ],
        idempotencyKey: "status-events-next",
        policy: "queue",
        requestedBy: fixture.userId,
        source: {
          kind: "human",
        },
        threadId: fixture.thread.id,
      });
      expect(statusEvents(later.events)).toEqual([]);
      const resumed = await store.resumeThreadInputQueue({
        idempotencyKey: "status-events-resume",
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      expect(statusEvents(resumed.events)).toMatchObject([
        {
          data: {
            status: "running",
          },
        },
      ]);
      const again = await store.resumeThreadInputQueue({
        idempotencyKey: "status-events-resume-again",
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      expect(statusEvents(again.events)).toEqual([]);
      const stored = await database
        .selectFrom("deploymentEvents")
        .selectAll()
        .where("threadId", "=", fixture.thread.id)
        .where("type", "=", "thread.state-changed")
        .orderBy("sequence", "asc")
        .execute();
      expect(stored.map(({ data }) => data)).toEqual([
        {
          status: "running",
          inputQueuePaused: false,
          pendingRequests: 0,
          title: fixture.thread.title,
          icon: fixture.thread.icon,
          doneAt: null,
          doneReason: null,
        },
        {
          status: "idle",
          inputQueuePaused: true,
          pendingRequests: 0,
          title: fixture.thread.title,
          icon: fixture.thread.icon,
          doneAt: null,
          doneReason: null,
        },
        {
          status: "running",
          inputQueuePaused: false,
          pendingRequests: 0,
          title: fixture.thread.title,
          icon: fixture.thread.icon,
          doneAt: null,
          doneReason: null,
        },
      ]);
      expect(stored.map(({ eventId }) => eventId)).toEqual(
        [
          ...statusEvents(turn.events),
          ...statusEvents(interrupted.events),
          ...statusEvents(resumed.events),
        ].map((event) => event.eventId),
      );
    });
    it("projects queued, starting, and running from the Run instead of a stale waiting projection", async ({
      storeFixture,
    }) => {
      const { createRunFixture, enqueueHumanTrigger, store, bindAgentControlRun, database } =
        storeFixture;
      const fixture = await createRunFixture("status-start");
      const turn = await enqueueHumanTrigger({
        content: [
          {
            type: "text",
            text: "Start",
          },
        ],
        idempotencyKey: "status-start",
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      expect((await store.getThreadForOwner(fixture.thread.id, fixture.userId))?.status).toBe(
        "running",
      );
      await store.claimCommand(turn.command.id, "status-start");
      expect((await store.getThreadForOwner(fixture.thread.id, fixture.userId))?.status).toBe(
        "running",
      );
      const binding = await bindAgentControlRun(fixture, turn.run.id, "status-start");
      await database
        .updateTable("threads")
        .set({
          status: "waiting",
        })
        .where("id", "=", fixture.thread.id)
        .execute();
      await store.commitRunnerEvent({
        environmentId: fixture.environmentId,
        runnerBootId: binding.runnerBootId,
        runnerId: fixture.runnerId,
        event: pendingEvent({
          bindingGeneration: binding.bindingGeneration,
          environmentId: fixture.environmentId,
          threadId: fixture.thread.id,
          runId: turn.run.id,
          ordinal: 0,
          type: "run.started",
          data: {
            status: "running",
          },
        }),
      });
      expect((await store.getThreadForOwner(fixture.thread.id, fixture.userId))?.status).toBe(
        "running",
      );
    });
    it("projects a live Request as waiting until the provider cancels it", async ({
      storeFixture,
    }) => {
      const { startRunFixture, store } = storeFixture;
      const fixture = await startRunFixture("status-request");
      const request = liveRequest({
        harnessInstanceId: fixture.harnessInstance.id,
        id: createId("request"),
        presentation: {
          detail: "Approve work",
          kind: "choice",
          risk: "medium",
          title: "Approval",
          options: [
            {
              hint: "allow-once",
              id: "allow",
              label: "Allow",
            },
          ],
        },
        requestedBy: fixture.userId,
        runId: fixture.run.id,
        threadId: fixture.thread.id,
      });
      const base = {
        bindingGeneration: fixture.bindingGeneration,
        environmentId: fixture.environmentId,
        runId: fixture.run.id,
        threadId: fixture.thread.id,
      };
      await store.commitRunnerEvent({
        ...fixture,
        event: pendingEvent({
          ...base,
          ordinal: 1,
          type: "request.opened",
          data: {
            request,
          },
        }),
      });
      await store.drainPendingThreadStates();
      expect((await store.getThreadForOwner(fixture.thread.id, fixture.userId))?.status).toBe(
        "waiting",
      );
      await store.commitRunnerEvent({
        ...fixture,
        event: pendingEvent({
          ...base,
          ordinal: 2,
          type: "run.status",
          data: {
            status: "running",
          },
        }),
      });
      await store.drainPendingThreadStates();
      expect((await store.getThreadForOwner(fixture.thread.id, fixture.userId))?.status).toBe(
        "waiting",
      );
      await store.commitRunnerEvent({
        ...fixture,
        event: pendingEvent({
          ...base,
          ordinal: 3,
          type: "request.cancelled",
          data: {
            requestId: request.id,
            reason: "source-closed",
          },
        }),
      });
      await store.drainPendingThreadStates();
      expect((await store.getThreadForOwner(fixture.thread.id, fixture.userId))?.status).toBe(
        "running",
      );
    });
    it("ends a stopped unbound Run for good, so resuming runs only later work", async ({
      storeFixture,
    }) => {
      const { createRunFixture, enqueueHumanTrigger, store, database } = storeFixture;
      const fixture = await createRunFixture("status-paused");
      const turn = await enqueueHumanTrigger({
        content: [
          {
            type: "text",
            text: "Start",
          },
        ],
        idempotencyKey: "status-paused",
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      await store.claimCommand(turn.command.id, "status-paused");
      await store.enqueueRunnerControl({
        idempotencyKey: "status-pause",
        requestedBy: fixture.userId,
        runId: turn.run.id,
        threadId: fixture.thread.id,
        type: "run.interrupt",
      });
      expect(
        (
          await database
            .selectFrom("runs")
            .select("status")
            .where("id", "=", turn.run.id)
            .executeTakeFirstOrThrow()
        ).status,
      ).toBe("interrupted");
      expect((await store.getThreadForOwner(fixture.thread.id, fixture.userId))?.status).toBe(
        "idle",
      );
      // A dispatch retry finds nothing to put back.
      expect(await store.retryCommand(turn.command.id, new Error("Not dispatched"))).toEqual([]);
      // Sent while paused, the next message waits without a Run until resume.
      const later = await store.enqueueThreadInput({
        content: [
          {
            type: "text",
            text: "Next",
          },
        ],
        idempotencyKey: "status-paused-next",
        policy: "queue",
        requestedBy: fixture.userId,
        source: {
          kind: "human",
        },
        threadId: fixture.thread.id,
      });
      expect(later.disposition).toBe("pending");
      expect((await store.getThreadForOwner(fixture.thread.id, fixture.userId))?.status).toBe(
        "idle",
      );
      const resumed = await store.resumeThreadInputQueue({
        idempotencyKey: "status-resume",
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      expect(resumed.thread.status).toBe("running");
      expect(
        await database
          .selectFrom("runs")
          .select("status")
          .where("threadId", "=", fixture.thread.id)
          .where("status", "=", "queued")
          .execute(),
      ).toHaveLength(1);
      expect(
        (
          await database
            .selectFrom("runs")
            .select("status")
            .where("id", "=", turn.run.id)
            .executeTakeFirstOrThrow()
        ).status,
      ).toBe("interrupted");
    });
    it("repairs a stale waiting projection when resuming an existing queued Run", async ({
      storeFixture,
    }) => {
      const { createRunFixture, enqueueHumanTrigger, database, store } = storeFixture;
      const fixture = await createRunFixture("status-resume-waiting");
      await enqueueHumanTrigger({
        content: [
          {
            type: "text",
            text: "Start",
          },
        ],
        idempotencyKey: "status-resume-waiting",
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      await database
        .updateTable("threads")
        .set({
          inputQueuePaused: true,
          inputQueuePausedBy: fixture.userId,
          status: "waiting",
        })
        .where("id", "=", fixture.thread.id)
        .execute();
      const resumed = await store.resumeThreadInputQueue({
        idempotencyKey: "status-resume-waiting-resume",
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      expect(resumed.thread.status).toBe("running");
    });
    it("keeps a failed Run visible through recovery and resume until the next Run", async ({
      storeFixture,
    }) => {
      const { createRunFixture, enqueueHumanTrigger, store } = storeFixture;
      const fixture = await createRunFixture("status-failed");
      const turn = await enqueueHumanTrigger({
        content: [
          {
            type: "text",
            text: "Fail",
          },
        ],
        idempotencyKey: "status-failed",
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      await store.claimCommand(turn.command.id, "status-failed");
      await store.failCommand(turn.command.id, "Cannot dispatch");
      expect((await store.getThreadForOwner(fixture.thread.id, fixture.userId))?.status).toBe(
        "failed",
      );
      await store.recoverThreadWorkQueues();
      await store.resumeThreadInputQueue({
        idempotencyKey: "status-failed-resume",
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      expect((await store.getThreadForOwner(fixture.thread.id, fixture.userId))?.status).toBe(
        "failed",
      );
      await enqueueHumanTrigger({
        content: [
          {
            type: "text",
            text: "Retry",
          },
        ],
        idempotencyKey: "status-next",
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      expect((await store.getThreadForOwner(fixture.thread.id, fixture.userId))?.status).toBe(
        "running",
      );
    });
    it.for(["completed", "failed"] as const)(
      "projects the follow-on Run after its predecessor %s",
      async (status, { storeFixture }) => {
        const { startRunFixture, store, database } = storeFixture;
        const fixture = await startRunFixture(`status-follow-${status}`);
        await store.enqueueThreadInput({
          content: [
            {
              type: "text",
              text: "Follow on",
            },
          ],
          idempotencyKey: "status-follow",
          policy: "queue",
          source: {
            kind: "human",
          },
          requestedBy: fixture.userId,
          threadId: fixture.thread.id,
        });
        const base = {
          bindingGeneration: fixture.bindingGeneration,
          environmentId: fixture.environmentId,
          threadId: fixture.thread.id,
          runId: fixture.run.id,
          ordinal: 1,
        };
        await store.commitRunnerEvent({
          ...fixture,
          event:
            status === "completed"
              ? pendingEvent({
                  ...base,
                  type: "run.completed",
                  data: {
                    status,
                  },
                })
              : pendingEvent({
                  ...base,
                  type: "run.failed",
                  data: {
                    status,
                    code: "test_failure",
                    message: "Failed",
                    retryable: false,
                  },
                }),
        });
        const next = await database
          .selectFrom("runs")
          .select(["status", "runOrdinal"])
          .where("threadId", "=", fixture.thread.id)
          .orderBy("runOrdinal", "desc")
          .executeTakeFirstOrThrow();
        expect(next.status).toBe("queued");
        expect((await store.getThreadForOwner(fixture.thread.id, fixture.userId))?.status).toBe(
          "running",
        );
      },
    );
    it("starts no queued work on a Done task when a previously admitted Run ends", async ({
      storeFixture,
    }) => {
      const { createRunFixture, enqueueHumanTrigger, store, database } = storeFixture;
      const fixture = await createRunFixture("status-done");
      const turn = await enqueueHumanTrigger({
        content: [
          {
            type: "text",
            text: "Start",
          },
        ],
        idempotencyKey: "status-done",
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      await store.claimCommand(turn.command.id, "status-done");
      await store.enqueueThreadInput({
        content: [
          {
            type: "text",
            text: "Then this",
          },
        ],
        idempotencyKey: "status-done-follow-up",
        policy: "queue",
        requestedBy: fixture.userId,
        source: {
          kind: "human",
        },
        threadId: fixture.thread.id,
      });
      // Done landing between admission and the Run's end, as the freeze must hold.
      await database
        .updateTable("threads")
        .set({
          doneAt: new Date(),
        })
        .where("id", "=", fixture.thread.id)
        .execute();
      await store.failCommand(turn.command.id, "Done while dispatching");
      await store.recoverThreadWorkQueues();
      expect((await store.getThreadForOwner(fixture.thread.id, fixture.userId))?.doneAt).not.toBe(
        null,
      );
      expect(
        await database
          .selectFrom("runs")
          .select("id")
          .where("threadId", "=", fixture.thread.id)
          .where("status", "in", ["queued", "starting", "running", "waiting"])
          .execute(),
      ).toEqual([]);
    });
  });
  it("declines full access only for its requester and fulfills only the reporting machine replay-safely", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, database } = storeFixture;
    const fixture = await startRunFixture("full-disk-access");
    const machineId = createId("runner");
    const otherMachineId = createId("runner");
    const create = (callId: string, target: RunnerId) =>
      store.requests.create({
        callId,
        kind: "machine.full-disk-access",
        mode: "durable",
        requiredActor: "requester",
        originatingRunId: fixture.run.id,
        originatingThreadId: fixture.thread.id,
        requestedBy: fixture.userId,
        payload: {
          kind: "machine.full-disk-access",
          machineId: target,
          machineName: "Mac",
          reason: "Read Mail",
        },
        presentation: {
          kind: "external",
          subject: {
            kind: "machine",
            id: target,
          },
          title: "Allow full access on Mac",
          detail: "Read Mail",
        },
      });
    const declined = await create("decline", machineId);
    const otherUser = await store.createUser("Other requester");
    await expect(
      store.requests.declineMachineFullDiskAccessRequest({
        requestId: declined.request.id,
        resolvedBy: otherUser,
        response: {
          kind: "external",
          value: {
            decision: "declined",
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      store.requests.declineMachineFullDiskAccessRequest({
        requestId: declined.request.id,
        resolvedBy: fixture.userId,
        response: {
          kind: "external",
          value: {
            decision: "fulfilled",
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "bad_request",
    });
    expect(
      await store.requests.declineMachineFullDiskAccessRequest({
        requestId: declined.request.id,
        resolvedBy: fixture.userId,
        response: {
          kind: "external",
          value: {
            decision: "declined",
          },
        },
      }),
    ).toMatchObject({
      request: {
        status: "declined",
        resolvedBy: fixture.userId,
      },
    });
    const first = await create("first", machineId);
    const second = await create("second", machineId);
    const other = await create("other", otherMachineId);
    const fulfilled = await store.requests.fulfillMachineFullDiskAccessRequests(machineId);
    expect(fulfilled.requests.map((request) => request.id).sort()).toEqual(
      [first.request.id, second.request.id].sort(),
    );
    expect(
      fulfilled.requests.every(
        (request) => request.status === "fulfilled" && request.resolvedBy === fixture.userId,
      ),
    ).toBe(true);
    expect(fulfilled.events.map((event) => event.type)).toEqual([
      "request.resolved",
      "request.resolved",
    ]);
    expect((await store.requests.get(other.request.id))?.status).toBe("pending");
    expect(await store.requests.fulfillMachineFullDiskAccessRequests(machineId)).toEqual({
      events: [],
      requests: [],
    });
    const continuations = await database
      .selectFrom("requestContinuations")
      .select("requestId")
      .where("requestId", "in", [declined.request.id, first.request.id, second.request.id])
      .execute();
    expect(continuations).toHaveLength(3);
  });
  it("deduplicates durable Requests by call identity and withdraws them replay-safely", async ({
    storeFixture,
  }) => {
    const { startRunFixture, createTaskForOwner, store, database } = storeFixture;
    const fixture = await startRunFixture("request-withdrawal");
    const targetWorkspace = await createTaskForOwner(fixture.userId, "request_withdrawal_target");
    const input = {
      callId: "browser-access-call-1",
      kind: "browser.access" as const,
      mode: "durable" as const,
      originatingRunId: fixture.run.id,
      originatingThreadId: fixture.thread.id,
      payload: {
        kind: "browser.access" as const,
        reason: "Use the signed-in browser profile",
        suggestion: {
          kind: "user_choice" as const,
        },
      },
      presentation: {
        kind: "external" as const,
        subject: {
          id: targetWorkspace.id,
          kind: "thread",
        },
        title: "Choose browser access",
      },
      requestedBy: fixture.userId,
      requiredActor: "requester" as const,
    };
    const created = await store.requests.create(input);
    const replay = await store.requests.create(input);
    expect(created).toMatchObject({
      replayed: false,
      request: {
        status: "pending",
      },
    });
    expect(replay).toMatchObject({
      replayed: true,
      request: {
        id: created.request.id,
      },
    });
    const pendingPage = await store.requests.originatingPendingPage({
      limit: 1,
      threadId: fixture.thread.id,
    });
    expect(pendingPage.requests.map(({ id }) => id)).toEqual([created.request.id]);
    expect(pendingPage.window).toMatchObject({
      hasMore: false,
      itemCount: 1,
      totalItems: 1,
    });
    await store.drainPendingThreadStates();
    await expect(store.getThreadForOwner(fixture.thread.id, fixture.userId)).resolves.toMatchObject(
      {
        pendingRequests: 1,
      },
    );
    const withdrawn = await store.requests.withdraw({
      requestId: created.request.id,
      threadId: fixture.thread.id,
      withdrawnBy: fixture.userId,
    });
    const withdrawnReplay = await store.requests.withdraw({
      requestId: created.request.id,
      threadId: fixture.thread.id,
      withdrawnBy: fixture.userId,
    });
    expect(withdrawn).toMatchObject({
      events: [
        expect.objectContaining({
          type: "request.resolved",
        }),
      ],
      replayed: false,
      request: {
        status: "withdrawn",
      },
    });
    expect(withdrawnReplay).toMatchObject({
      events: [],
      replayed: true,
      request: {
        status: "withdrawn",
      },
    });
    await expect(
      store.requests.originatingPendingPage({
        limit: 1,
        threadId: fixture.thread.id,
      }),
    ).resolves.toMatchObject({
      requests: [],
      window: {
        totalItems: 0,
      },
    });
    await store.drainPendingThreadStates();
    await expect(store.getThreadForOwner(fixture.thread.id, fixture.userId)).resolves.toMatchObject(
      {
        pendingRequests: 0,
      },
    );
    await expect(
      database
        .selectFrom("requestContinuations")
        .selectAll()
        .where("requestId", "=", created.request.id)
        .execute(),
    ).resolves.toEqual([]);
  });
  it.for(
    (["update", "resume"] as const).flatMap((mutation) =>
      (["drain", "resolution"] as const).flatMap((writer) =>
        (["watch-first", "writer-first"] as const).map((order) => ({
          mutation,
          writer,
          order,
        })),
      ),
    ),
  )(
    "keeps Watch $mutation foreign keys transparent to $writer ($order)",
    async ({ mutation, writer, order }, { storeFixture }) => {
      const { startRunFixture, store, triggers, createTaskForOwner, database } = storeFixture;
      const fixture = await startRunFixture(`watch-fk-${mutation}-${writer}-${order}`);
      const { thread: anchor } = await store.createThread({
        createdBy: fixture.userId,
        environmentId: fixture.environmentId,
        harnessInstanceId: fixture.harnessInstance.id,
        idempotencyKey: "watch-fk-anchor",
        modelSelection: testModelSelection,
        title: "Independent Watch anchor",
      });
      const watch = await triggers.create({
        actorThreadId: null,
        anchorThreadId: anchor.id,
        createdBy: fixture.userId,
        idempotencyKey: "watch-fk",
        name: "Watch FK race",
        program: {
          language: "javascript",
          toolContractVersion: 3,
          source: "export default async () => null",
        },
        source: {
          kind: "watch",
        },
      });
      if (mutation === "resume") {
        await triggers.setStatus({
          actorThreadId: null,
          ownerId: fixture.userId,
          status: "paused",
          triggerId: watch.trigger.id,
        });
      }
      const target = await createTaskForOwner(fixture.userId, "watch-fk-target");
      const opened = await store.requests.create({
        callId: "watch-fk-request",
        kind: "browser.access",
        mode: "durable",
        originatingRunId: fixture.run.id,
        originatingThreadId: fixture.thread.id,
        requestedBy: fixture.userId,
        requiredActor: "requester",
        payload: {
          kind: "browser.access",
          reason: "Choose a profile",
          suggestion: {
            kind: "user_choice",
          },
        },
        presentation: {
          kind: "external",
          title: "Choose browser access",
          subject: {
            id: target.id,
            kind: "thread",
          },
        },
      });
      // Capture even retried statement failures: Request resolution's retry cannot
      // turn a deadlock into a passing race.
      const queryErrors: {
        code: unknown;
        message: string;
      }[] = [];
      const racingDatabase = new Kysely<DatabaseSchema>({
        dialect: new PostgresDialect({
          pool: new Pool({
            connectionString: storeFixture.databaseUrl,
            max: 2,
            application_name: "opensteer-watch-fk-race",
          }),
        }),
        plugins: [
          new CamelCasePlugin({
            maintainNestedObjectKeys: true,
          }),
        ],
        log(event) {
          if (event.level === "error" && event.error instanceof Error) {
            queryErrors.push({
              code: "code" in event.error ? event.error.code : undefined,
              message: event.error.message,
            });
          }
        },
      });
      const racingStore = new OpensteerStore(racingDatabase);
      const racingTriggers = new TriggerStore(racingDatabase);
      const release = Promise.withResolvers<void>();
      const held = Promise.withResolvers<void>();
      const operations: Promise<unknown>[] = [];
      // The second writer waits on Deployment event order while the first holds its domain fence.
      await sql`create function phase3k_watch_barrier() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(731003, 1); return new; end $$`.execute(database);
      await sql`create trigger phase3k_watch_barrier before insert on trigger_watch_activations
      for each row execute function phase3k_watch_barrier()`.execute(database);
      const blocker = database.transaction().execute(async (transaction) => {
        await sql`select pg_advisory_xact_lock(731003, 1)`.execute(transaction);
        if (writer === "drain") {
          await transaction
            .selectFrom("threads")
            .select("id")
            .where("id", "=", fixture.thread.id)
            .forUpdate()
            .execute();
        } else {
          await transaction
            .selectFrom("requests")
            .select("id")
            .where("id", "=", opened.request.id)
            .forUpdate()
            .execute();
        }
        held.resolve();
        await release.promise;
      });
      let waitingCount = 0;
      const waitFor = async () => {
        waitingCount += 1;
        await vi.waitFor(
          async () => {
            const result = await sql<{
              waiting: number;
            }>`select count(*)::integer as waiting from pg_stat_activity
            where datname=current_database() and application_name='opensteer-watch-fk-race'
            and wait_event_type='Lock'`.execute(database);
            expect(
              result.rows[0]!.waiting,
              "Watch and projection writers never reached their fences",
            ).toBe(waitingCount);
          },
          { timeout: 1_000 },
        );
      };
      const startWatch = () =>
        mutation === "update"
          ? racingTriggers.update({
              actorThreadId: null,
              expectedRevisionId: watch.revision.id,
              name: "Updated Watch",
              ownerId: fixture.userId,
              triggerId: watch.trigger.id,
            })
          : racingTriggers.setStatus({
              actorThreadId: null,
              ownerId: fixture.userId,
              status: "active",
              triggerId: watch.trigger.id,
            });
      const startWriter = () =>
        writer === "drain"
          ? racingStore.drainPendingThreadStates()
          : racingStore.requests.resolveBrowserRequest({
              requestId: opened.request.id,
              resolvedBy: fixture.userId,
              response: {
                kind: "external",
                value: {
                  decision: "declined",
                },
              },
            });
      const start = (operation: () => Promise<unknown>) => {
        const running = operation();
        void running.catch(() => undefined);
        operations.push(running);
      };
      try {
        await held.promise;
        if (order === "watch-first") {
          start(startWatch);
          await waitFor();
          start(startWriter);
          await waitFor();
        } else {
          start(startWriter);
          await waitFor();
          start(startWatch);
          await waitFor();
        }
        release.resolve();
        await blocker;
        const results = await Promise.allSettled(operations);
        expect(queryErrors).toEqual([]);
        expect(results.map(({ status }) => status)).toEqual(["fulfilled", "fulfilled"]);
        const active = await database
          .selectFrom("triggerWatchActivations")
          .selectAll()
          .where("triggerId", "=", watch.trigger.id)
          .where("desired", "=", "active")
          .execute();
        expect(active).toHaveLength(1);
        const events = await database
          .selectFrom("deploymentEvents")
          .select(["type", "data"])
          .where("threadId", "=", fixture.thread.id)
          .orderBy("sequence", "desc")
          .execute();
        if (writer === "drain") {
          expect(events).toContainEqual(
            expect.objectContaining({
              type: "thread.state-changed",
              data: expect.objectContaining({
                pendingRequests: 1,
              }),
            }),
          );
          expect(
            await database
              .selectFrom("threadStatePending")
              .selectAll()
              .where("threadId", "=", fixture.thread.id)
              .execute(),
          ).toEqual([]);
        } else {
          expect(await store.requests.get(opened.request.id)).toMatchObject({
            status: "declined",
          });
          expect(events).toContainEqual(
            expect.objectContaining({
              type: "request.resolved",
            }),
          );
        }
      } finally {
        release.resolve();
        await blocker;
        await Promise.allSettled(operations);
        await sql`drop trigger phase3k_watch_barrier on trigger_watch_activations`.execute(
          database,
        );
        await sql`drop function phase3k_watch_barrier()`.execute(database);
        await racingDatabase.destroy();
      }
    },
  );
  it.for(["task", "delegation"] as const)(
    "fences %s creation against profile retirement",
    async (creator, { storeFixture }) => {
      const { startRunFixture, store, database, recordReadyHarnessCatalog } = storeFixture;
      const f = await startRunFixture("parent-fence");
      const harness = await store.createHarnessInstance({
        config: {},
        driverKind: HarnessIdSchema.parse("native"),
        environmentId: f.environmentId,
        name: "Child engine",
        stateKind: "isolated",
      });
      await recordReadyHarnessCatalog(f.environmentId, harness);
      const create = (target: OpensteerStore) =>
        creator === "task"
          ? target.createThread({
              createdBy: f.userId,
              environmentId: f.environmentId,
              harnessInstanceId: harness.id,
              idempotencyKey: "parent-fence-create",
              modelSelection: testModelSelection,
              title: "Child",
            })
          : target.delegateThread({
              createdBy: f.userId,
              environmentId: f.environmentId,
              harnessInstanceId: harness.id,
              idempotencyKey: "parent-fence-create",
              modelSelection: testModelSelection,
              title: "Child",
              accessMode: "auto",
              origin: { kind: "run", parentRunId: f.run.id, parentThreadId: f.thread.id },
              task: [{ type: "text", text: "Child" }],
            });
      const barrier = pauseAfterLock(
        database,
        (node) => node.includes('"name":"execution_environments"') && node.includes("ForShare"),
      );
      const creating = create(new OpensteerStore(barrier.database));
      void creating.catch(() => undefined);
      let removing: ReturnType<OpensteerStore["removeHarnessInstance"]> | undefined;
      try {
        await withTimeout(barrier.reached, 5_000, {
          timeoutError: () => new Error("Creation never held the environment fence"),
        });
        removing = store.removeHarnessInstance(f.environmentId, harness.id);
        void removing.catch(() => undefined);
        await vi.waitFor(
          async () => {
            const waiting = await sql<{
              query: string;
            }>`select query from pg_stat_activity where datname=current_database() and wait_event_type='Lock'`.execute(
              database,
            );
            expect(
              waiting.rows.some(({ query }) => query.includes('from "execution_environments"')),
              "Retirement never waited on creation",
            ).toBe(true);
          },
          { timeout: 5_000 },
        );
        barrier.release();
        await expect(creating).resolves.toMatchObject({
          thread: { harnessInstanceId: harness.id },
        });
        await expect(removing).rejects.toMatchObject({ code: "conflict" });
        expect(barrier.conflicts).toEqual([]);
      } finally {
        barrier.release();
        await Promise.allSettled([creating, removing]);
      }
    },
  );
  it.for(["task", "delegation"] as const)(
    "revalidates %s creation after profile retirement",
    async (creator, { storeFixture }) => {
      const { startRunFixture, store, database, recordReadyHarnessCatalog } = storeFixture;
      const f = await startRunFixture("parent-fence");
      const harness = await store.createHarnessInstance({
        config: {},
        driverKind: HarnessIdSchema.parse("native"),
        environmentId: f.environmentId,
        name: "Child engine",
        stateKind: "isolated",
      });
      await recordReadyHarnessCatalog(f.environmentId, harness);
      const create = (target: OpensteerStore) =>
        creator === "task"
          ? target.createThread({
              createdBy: f.userId,
              environmentId: f.environmentId,
              harnessInstanceId: harness.id,
              idempotencyKey: "parent-fence-create",
              modelSelection: testModelSelection,
              title: "Child",
            })
          : target.delegateThread({
              createdBy: f.userId,
              environmentId: f.environmentId,
              harnessInstanceId: harness.id,
              idempotencyKey: "parent-fence-create",
              modelSelection: testModelSelection,
              title: "Child",
              accessMode: "auto",
              origin: { kind: "run", parentRunId: f.run.id, parentThreadId: f.thread.id },
              task: [{ type: "text", text: "Child" }],
            });
      const barrier = pauseAfterLock(
        database,
        (node) =>
          node.includes('"name":"execution_environments"') && node.includes("ForNoKeyUpdate"),
      );
      const removing = new OpensteerStore(barrier.database).removeHarnessInstance(
        f.environmentId,
        harness.id,
      );
      void removing.catch(() => undefined);
      let creating: ReturnType<typeof create> | undefined;
      try {
        await withTimeout(barrier.reached, 5_000, {
          timeoutError: () => new Error("Retirement never held the environment fence"),
        });
        creating = create(store);
        void creating.catch(() => undefined);
        await vi.waitFor(
          async () => {
            const waiting = await sql<{
              query: string;
            }>`select query from pg_stat_activity where datname=current_database() and wait_event_type='Lock'`.execute(
              database,
            );
            expect(
              waiting.rows.some(({ query }) => query.includes('from "execution_environments"')),
              "Creation never waited on retirement",
            ).toBe(true);
          },
          { timeout: 5_000 },
        );
        barrier.release();
        await removing;
        await expect(creating).rejects.toMatchObject({ code: "conflict" });
        expect(
          await database
            .selectFrom("threads")
            .select("id")
            .where("harnessInstanceId", "=", harness.id)
            .execute(),
        ).toEqual([]);
        expect(barrier.conflicts).toEqual([]);
      } finally {
        barrier.release();
        await Promise.allSettled([removing, creating]);
      }
    },
  );

  it.for(["creation-first", "retirement-first"] as const)(
    "fences messaging task creation against profile retirement (%s)",
    async (order, { storeFixture }) => {
      const { createChannelNoticeFixture, store, database, recordReadyHarnessCatalog } =
        storeFixture;
      const channel = await createChannelNoticeFixture("profile-retirement", {
        accessMode: "anyone",
      });
      const f = channel.fixture;
      const environmentId = await store.createEnvironment({
        kind: "local",
        name: "Messaging engine",
        runnerId: f.runnerId,
      });
      const harness = await store.createHarnessInstance({
        config: {},
        driverKind: HarnessIdSchema.parse("native"),
        environmentId,
        name: "Messaging profile",
        stateKind: "isolated",
      });
      await recordReadyHarnessCatalog(environmentId, harness);
      const committed = await channel.channels.commitIngress(
        channel.configured.connection.id,
        channel.event({ eventId: "profile-retirement" }),
      );
      const claimed = await channel.claimFor(committed.ingressId);
      const input = {
        ingressId: claimed.id,
        claimToken: claimed.claimToken,
        notices: testChannelNotices,
        availableEngines: [{ environmentId, driverKinds: [harness.driverKind] }],
      };
      const barrier = pauseAfterLock(
        database,
        (node) =>
          node.includes('"name":"execution_environments"') &&
          node.includes(order === "creation-first" ? "ForShare" : "ForNoKeyUpdate"),
      );
      let adoption: ReturnType<ChannelStore["adoptIngress"]> | undefined;
      let removal: ReturnType<OpensteerStore["removeHarnessInstance"]> | undefined;
      try {
        if (order === "creation-first") {
          adoption = new ChannelStore(barrier.database).adoptIngress(input);
          void adoption.catch(() => undefined);
        } else {
          removal = new OpensteerStore(barrier.database).removeHarnessInstance(
            environmentId,
            harness.id,
          );
          void removal.catch(() => undefined);
        }
        await withTimeout(barrier.reached, 5_000, {
          timeoutError: () => new Error("Messaging profile race never held its environment fence"),
        });
        if (order === "creation-first")
          removal = store.removeHarnessInstance(environmentId, harness.id);
        else adoption = channel.channels.adoptIngress(input);
        void removal!.catch(() => undefined);
        void adoption!.catch(() => undefined);
        await vi.waitFor(
          async () => {
            const waiting = await sql<{
              query: string;
            }>`select query from pg_stat_activity where datname=current_database() and wait_event_type='Lock'`.execute(
              database,
            );
            expect(
              waiting.rows.some(({ query }) => query.includes('from "execution_environments"')),
              "Messaging creation and retirement never met at the environment fence",
            ).toBe(true);
          },
          { timeout: 5_000 },
        );
        barrier.release();
        if (order === "creation-first") {
          await expect(adoption).resolves.toMatchObject({ kind: "adopted" });
          await expect(removal).rejects.toMatchObject({ code: "conflict" });
          expect(
            await database
              .selectFrom("threads")
              .select("harnessInstanceId")
              .where("environmentId", "=", environmentId)
              .execute(),
          ).toEqual([{ harnessInstanceId: harness.id }]);
        } else {
          await removal;
          await expect(adoption).rejects.toBeInstanceOf(ChannelIngressDeferredError);
          expect(
            await database
              .selectFrom("threads")
              .select("id")
              .where("environmentId", "=", environmentId)
              .execute(),
          ).toEqual([]);
        }
        expect(barrier.conflicts).toEqual([]);
      } finally {
        barrier.release();
        await Promise.allSettled([adoption, removal]);
      }
    },
  );
  it("keeps durable Request event foreign keys compatible with Runner ingestion", async ({
    storeFixture,
  }) => {
    const { startRunFixture, createTaskForOwner, store, stagedRequestRace, database } =
      storeFixture;
    const fixture = await startRunFixture("request-run-fk-race");
    const target = await createTaskForOwner(fixture.userId, "request-run-fk-race-target");
    const opened = await store.requests.create({
      callId: "request-run-fk-race",
      kind: "browser.access",
      mode: "durable",
      originatingRunId: fixture.run.id,
      originatingThreadId: fixture.thread.id,
      requestedBy: fixture.userId,
      requiredActor: "requester",
      payload: {
        kind: "browser.access",
        reason: "Choose a profile",
        suggestion: {
          kind: "user_choice",
        },
      },
      presentation: {
        kind: "external",
        title: "Choose browser access",
        subject: {
          id: target.id,
          kind: "thread",
        },
      },
    });
    // Resolution owns its Workspaces before waiting on this Request; ingestion
    // then owns the Run before waiting on the origin Workspace. The resolution
    // event's Run foreign key must pass that prefix lock when the blocker exits.
    const results = await stagedRequestRace(
      (transaction) =>
        transaction
          .selectFrom("requests")
          .select("id")
          .where("id", "=", opened.request.id)
          .forUpdate()
          .execute(),
      () =>
        store.requests.resolveBrowserRequest({
          requestId: opened.request.id,
          resolvedBy: fixture.userId,
          response: {
            kind: "external",
            value: {
              decision: "declined",
            },
          },
        }),
      () =>
        store.commitRunnerEvent({
          environmentId: fixture.environmentId,
          runnerBootId: fixture.runnerBootId,
          runnerId: fixture.runnerId,
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
        }),
    );
    expect(results.map(({ status }) => status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await store.requests.get(opened.request.id)).toMatchObject({
      status: "declined",
    });
    const events = await database
      .selectFrom("deploymentEvents")
      .select("type")
      .where("runId", "=", fixture.run.id)
      .orderBy("sequence", "asc")
      .execute();
    expect(events.map(({ type }) => type)).toEqual(
      expect.arrayContaining(["request.resolved", "run.completed"]),
    );
  });
});
