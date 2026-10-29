import { prepareThreadInsertion } from "./thread-insertion.js";
import { setTimeout as delay } from "node:timers/promises";
import { takeTransactionConflicts } from "./lock-order-checker.test-support.js";
import { jsonValue, lockWorkspaceRow } from "./store-primitives.js";
import { cancelPending } from "./request-cancellation.js";
import {
  HarnessIdSchema,
  WorkspaceIdSchema,
  createId,
  type AgentEvent,
  type RunnerId,
} from "@opensteer/core";
import { CamelCasePlugin, Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import type { DatabaseSchema } from "./schema.js";
import { describe, expect } from "vitest";
import { OpensteerStore, TriggerStore } from "./index.js";
import {
  describeStore,
  testModelSelection,
  enrollTestRunner,
  pendingEvent,
  liveRequest,
  sealedTestRequestResponse,
} from "./store.integration.test-support.js";

describeStore("PostgreSQL store", (it) => {
  it("pages only authorized active listed tasks across Workspaces with filter-bound cursors and read states", async ({
    storeFixture,
  }) => {
    const { createRunFixture, store, database } = storeFixture;
    const fixture = await createRunFixture("active-tasks");
    const otherWorkspace = await store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: "wsp_active-other",
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: fixture.userId,
      idempotencyKey: "active-other-workspace",
      name: "Other",
      status: "ready",
    });
    const other = {
      workspace: otherWorkspace,
      ...(await store.createThread({
        createdBy: fixture.userId,
        environmentId: fixture.environmentId,
        harnessInstanceId: fixture.harnessInstance.id,
        idempotencyKey: "active-other-thread",
        modelSelection: testModelSelection,
        title: "Other task",
        workspaceId: otherWorkspace.id,
      })),
    };
    const otherOwner = await store.createUser("Remaining owner");
    await database
      .insertInto("workspaceMemberships")
      .values(
        [fixture.workspace.id, other.workspace.id].map((workspaceId) => ({
          generation: 1,
          id: createId("workspaceMembership"),
          invitedBy: fixture.userId,
          joinedAt: new Date(),
          revokedAt: null,
          revokedBy: null,
          role: "owner" as const,
          state: "active" as const,
          updatedAt: new Date(),
          userId: otherOwner,
          workspaceId,
        })),
      )
      .execute();
    await database
      .updateTable("workspaceMemberships")
      .set({ state: "revoked", revokedAt: new Date(), revokedBy: otherOwner })
      .where("workspaceId", "=", other.workspace.id)
      .where("userId", "=", fixture.userId)
      .execute();
    const outsider = await store.createUser("Outsider");
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
        workspaceId: fixture.workspace.id,
      });
      await database
        .updateTable("threads")
        .set({ status, listed })
        .where("id", "=", thread.id)
        .execute();
      return thread.id;
    };
    const running = await make("running", "running");
    const waiting = await make("waiting-reader", "waiting");
    await make("idle", "idle");
    await make("failed", "failed");
    await make("archived", "archived");
    await make("unlisted", "running", false);
    await database
      .updateTable("threads")
      .set({ status: "running" })
      .where("id", "=", other.thread.id)
      .execute();
    const page = await store.taskPageForUser({
      active: true,
      maxItems: 1,
      userId: fixture.userId,
    });
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
    expect((await store.taskPageForUser({ active: true, userId: outsider })).tasks).toEqual([]);
    await expect(
      store.taskPageForUser({
        active: true,
        userId: outsider,
        workspaceId: fixture.workspace.id,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await database
      .updateTable("workspaceMemberships")
      .set({ state: "active", revokedAt: null, revokedBy: null })
      .where("workspaceId", "=", other.workspace.id)
      .where("userId", "=", fixture.userId)
      .execute();
    expect(
      (await store.taskPageForUser({ active: true, userId: fixture.userId })).window.totalItems,
    ).toBe(3);
    expect(
      (
        await store.taskPageForUser({
          active: true,
          userId: fixture.userId,
          workspaceId: other.workspace.id,
        })
      ).tasks.map(({ thread }) => thread.id),
    ).toEqual([other.thread.id]);
    await database
      .updateTable("workspaceMemberships")
      .set({ state: "revoked", revokedAt: new Date(), revokedBy: otherOwner })
      .where("workspaceId", "=", other.workspace.id)
      .where("userId", "=", fixture.userId)
      .execute();
    expect(
      (await store.taskPageForUser({ active: true, userId: fixture.userId })).window.totalItems,
    ).toBe(2);
    await database
      .updateTable("users")
      .set({ disabledAt: new Date() })
      .where("id", "=", fixture.userId)
      .execute();
    expect((await store.taskPageForUser({ active: true, userId: fixture.userId })).tasks).toEqual(
      [],
    );
  });

  it.for(["wsp_00000000-0000-4000-8000-000000000001", "wsp_ffffffff-ffff-4fff-bfff-ffffffffffff"])(
    "orders withdrawal against target removal (%s)",
    async (targetId, { storeFixture }) => {
      const { startRunFixture, createSpecializedWorkspace, store, stagedRequestRace } =
        storeFixture;
      const fixture = await startRunFixture("withdraw-target-removal");
      const target = await createSpecializedWorkspace(
        fixture.userId,
        "withdraw-target-removal-target",
        WorkspaceIdSchema.parse(targetId),
      );
      const opened = await store.requests.create({
        callId: "withdraw-target-removal",
        kind: "browser.access",
        mode: "durable",
        originatingRunId: fixture.run.id,
        originatingThreadId: fixture.thread.id,
        originatingWorkspaceId: fixture.workspace.id,
        payload: {
          kind: "browser.access",
          reason: "Choose browser",
          suggestion: { kind: "user_choice" },
        },
        presentation: {
          kind: "external",
          subject: { id: target.id, kind: "workspace" },
          title: "Choose browser",
        },
        requestedBy: fixture.userId,
        requiredActor: "requester",
        targetWorkspaceId: target.id,
      });
      const results = await stagedRequestRace(
        (transaction) =>
          transaction
            .selectFrom("workspaces")
            .select("id")
            .where("id", "=", fixture.workspace.id)
            .forNoKeyUpdate()
            .execute(),
        () =>
          store.requestWorkspaceDeletion({
            requestedBy: fixture.userId,
            workspaceId: target.id,
            purgeAfter: new Date(Date.now() + 86_400_000),
          }),
        () =>
          store.requests.withdraw({
            requestId: opened.request.id,
            threadId: fixture.thread.id,
            withdrawnBy: fixture.userId,
          }),
      );
      expect(results[0]).toMatchObject({ status: "fulfilled" });
      expect((await store.requests.get(opened.request.id))?.status).toMatch(/cancelled|withdrawn/);
    },
  );

  it("retries Request Workspace discovery with the expanded sorted set", async ({
    storeFixture,
  }) => {
    const { createRunFixture, createSpecializedWorkspace, database } = storeFixture;
    const { withRequestWorkspaceLocks } = await import("./request-cancellation.js");
    const fixture = await createRunFixture("request-lock-discovery");
    const other = await createSpecializedWorkspace(fixture.userId, "request-lock-discovery-other");
    let discoveries = 0;
    const attempts: number[] = [];
    const result = await withRequestWorkspaceLocks(
      database,
      async (transaction) => {
        const identity = await sql<{ id: number }>`select txid_current()::integer as id`.execute(
          transaction,
        );
        attempts.push(identity.rows[0]!.id);
        discoveries += 1;
        return discoveries === 1 ? [fixture.workspace.id] : [fixture.workspace.id, other.id];
      },
      async (transaction) => {
        const locks = await sql<{ count: number }>`select count(*)::integer as count from pg_locks
        where pid = pg_backend_pid() and locktype = 'relation' and mode = 'RowShareLock'
        and relation = 'workspaces'::regclass`.execute(transaction);
        expect(locks.rows[0]!.count).toBe(1);
        return "mutated";
      },
    );
    expect(result).toBe("mutated");
    expect(discoveries).toBe(4);
    expect(attempts[0]).toBe(attempts[1]);
    expect(attempts[2]).toBe(attempts[3]);
    expect(attempts[0]).not.toBe(attempts[2]);
  });

  it.for(["40P01", "40001"])(
    "retries Request transaction conflict %s within a bound",
    async (code, { storeFixture }) => {
      const { database } = storeFixture;
      const { withRequestWorkspaceLocks } = await import("./request-cancellation.js");
      let attempts = 0;
      await expect(
        withRequestWorkspaceLocks(
          database,
          async () => [],
          async (transaction) => {
            attempts += 1;
            if (attempts < 3)
              await sql
                .raw(`do $$ begin raise exception 'retry' using errcode = '${code}'; end $$`)
                .execute(transaction);
            return attempts;
          },
        ),
      ).resolves.toBe(3);
      attempts = 0;
      await expect(
        withRequestWorkspaceLocks(
          database,
          async () => [],
          async (transaction) => {
            attempts += 1;
            await sql
              .raw(`do $$ begin raise exception 'retry' using errcode = '${code}'; end $$`)
              .execute(transaction);
          },
        ),
      ).rejects.toMatchObject({ cause: { code }, code: "conflict", retryable: true });
      expect(attempts).toBe(4);
      // Two injected before the first commit, four in the bounded failure.
      expect(takeTransactionConflicts().map((conflict) => conflict.code)).toEqual(
        Array.from({ length: 6 }, () => code),
      );
    },
  );

  it("avoids a deadlock between delegation and membership cancellation", async ({
    storeFixture,
  }) => {
    const { startRunFixture, createSpecializedWorkspace, store, database, stagedRequestRace } =
      storeFixture;
    const fixture = await startRunFixture("delegation-membership-race");
    const target = await createSpecializedWorkspace(fixture.userId, "delegation-membership-target");
    const input = {
      callId: "pending-state",
      kind: "browser.access" as const,
      mode: "durable" as const,
      originatingRunId: fixture.run.id,
      originatingThreadId: fixture.thread.id,
      originatingWorkspaceId: fixture.workspace.id,
      targetWorkspaceId: target.id,
      payload: {
        kind: "browser.access" as const,
        reason: "Choose a profile",
        suggestion: { kind: "user_choice" as const },
      },
      presentation: {
        kind: "external" as const,
        subject: { id: fixture.workspace.id, kind: "workspace" as const },
        title: "Browser",
      },
      requestedBy: fixture.userId,
      requiredActor: "requester" as const,
    };
    await store.requests.create(input);
    const owner = await store.createUser("Remaining owner");
    await database
      .insertInto("workspaceMemberships")
      .values({
        generation: 1,
        id: createId("workspaceMembership"),
        invitedBy: fixture.userId,
        joinedAt: new Date(),
        revokedAt: null,
        revokedBy: null,
        role: "owner",
        state: "active",
        updatedAt: new Date(),
        userId: owner,
        workspaceId: fixture.workspace.id,
      })
      .execute();
    const results = await stagedRequestRace(
      (transaction) =>
        transaction
          .selectFrom("threads")
          .select("id")
          .where("id", "=", fixture.thread.id)
          .forUpdate()
          .execute(),
      () =>
        store.changeWorkspaceMembership({
          actorId: owner,
          state: "revoked",
          targetUserId: fixture.userId,
          workspaceId: fixture.workspace.id,
        }),
      () =>
        store.delegateThread({
          accessMode: "auto",
          createdBy: fixture.userId,
          environmentId: fixture.environmentId,
          harnessInstanceId: fixture.harnessInstance.id,
          idempotencyKey: "delegation-membership-race",
          modelSelection: testModelSelection,
          origin: { kind: "run", parentRunId: fixture.run.id, parentThreadId: fixture.thread.id },
          task: [{ text: "Check", type: "text" }],
          title: "Worker",
          workspaceId: fixture.workspace.id,
        }),
    );
    expect(results[0]!.status).toBe("fulfilled");
  });

  describe("pending Thread state", () => {
    it("publishes each committed projection before waiting on the next Thread", async ({
      storeFixture,
    }) => {
      const { createRunFixture, createSpecializedWorkspace, store, database } = storeFixture;
      const first = await createRunFixture("drain-first");
      const workspace = await createSpecializedWorkspace(first.userId, "drain-second");
      const { thread } = await store.createThread({
        createdBy: first.userId,
        environmentId: first.environmentId,
        harnessInstanceId: first.harnessInstance.id,
        idempotencyKey: "drain-second",
        modelSelection: testModelSelection,
        title: "Second",
        workspaceId: workspace.id,
      });
      const second = { ...first, thread, workspace };
      for (const [index, fixture] of [first, second].entries()) {
        await database
          .updateTable("threads")
          .set({ pendingRequestCount: 7 })
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
          .selectFrom("workspaces")
          .select("id")
          .where("id", "=", second.workspace.id)
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
      const { startRunFixture, createSpecializedWorkspace, database, store } = storeFixture;
      const fixture = await startRunFixture("pending-state");
      const target = await createSpecializedWorkspace(fixture.userId, "pending-state-target");
      const input = {
        callId: "pending-state",
        kind: "browser.access" as const,
        mode: "durable" as const,
        originatingRunId: fixture.run.id,
        originatingThreadId: fixture.thread.id,
        originatingWorkspaceId: fixture.workspace.id,
        targetWorkspaceId: target.id,
        payload: {
          kind: "browser.access" as const,
          reason: "Choose a profile",
          suggestion: { kind: "user_choice" as const },
        },
        presentation: {
          kind: "external" as const,
          subject: { id: fixture.workspace.id, kind: "workspace" as const },
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
      expect(await pending()).toEqual([{ threadId: fixture.thread.id }]);
      expect(
        (await store.getThreadForOwner(fixture.thread.id, fixture.userId))?.pendingRequests,
      ).toBe(0);
      const drained = await store.drainPendingThreadStates();
      expect(drained).toMatchObject([
        {
          type: "thread.state-changed",
          data: { pendingRequests: 1, status: "running", inputQueuePaused: false },
        },
      ]);
      expect(BigInt(drained[0]!.sequence)).toBeGreaterThan(BigInt(opened.events[0]!.sequence));
      expect(await pending()).toEqual([]);
      expect(await store.drainPendingThreadStates()).toEqual([]);
      const resolved = await store.requests.resolveBrowserRequest({
        requestId: opened.request.id,
        resolvedBy: fixture.userId,
        response: { kind: "external", value: { decision: "declined" } },
      });
      expect(resolved.events.map(({ type }) => type)).toEqual(["request.resolved"]);
      expect(await pending()).toEqual([{ threadId: fixture.thread.id }]);
      expect(await store.drainPendingThreadStates()).toMatchObject([
        { data: { pendingRequests: 0 } },
      ]);
      const second = await store.requests.create({ ...input, callId: "pending-state-second" });
      await store.drainPendingThreadStates();
      const cancelled = await database.transaction().execute((transaction) =>
        cancelPending(transaction, {
          workspaceId: fixture.workspace.id,
          reason: "workspace-deleted",
          resolvedAt: new Date(),
        }),
      );
      expect(cancelled.map(({ type }) => type)).toEqual(["request.cancelled"]);
      expect(await pending()).toEqual([{ threadId: fixture.thread.id }]);
      expect(await store.drainPendingThreadStates()).toMatchObject([
        { data: { pendingRequests: 0 } },
      ]);
      expect((await store.requests.get(second.request.id))?.status).toBe("cancelled");
      await store.requests.create({ ...input, callId: "pending-state-coalesce" });
      await database.transaction().execute((transaction) =>
        cancelPending(transaction, {
          workspaceId: fixture.workspace.id,
          reason: "workspace-deleted",
          resolvedAt: new Date(),
        }),
      );
      expect(await pending()).toHaveLength(1);
      expect(await store.drainPendingThreadStates()).toEqual([]);
      await store.requests.create({ ...input, callId: "pending-state-sync" });
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
          { data: { pendingRequests: count, status, inputQueuePaused: paused } },
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
            options: [{ hint: "confirm", id: "yes", label: "Yes" }],
          },
          requestedBy: fixture.userId,
          runId: fixture.run.id,
          threadId: fixture.thread.id,
          workspaceId: fixture.workspace.id,
        });
        const result = await store.commitRunnerEvent({
          ...fixture,
          event: pendingEvent({
            bindingGeneration: fixture.bindingGeneration,
            environmentId: fixture.environmentId,
            runId: fixture.run.id,
            threadId: fixture.thread.id,
            workspaceId: fixture.workspace.id,
            ordinal: ordinal++,
            type: "request.opened",
            data: { request },
          }),
        });
        return { request, result };
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
        response: { kind: "choice", optionId: "yes" },
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
        content: [{ type: "text", text: "Start" }],
        idempotencyKey: "status-events",
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      const statusEvents = (events: readonly AgentEvent[]) =>
        events.filter((event) => event.type === "thread.state-changed");
      expect(statusEvents(turn.events)).toMatchObject([
        {
          data: { status: "running" },
          environmentId: fixture.environmentId,
          runId: null,
          threadId: fixture.thread.id,
          workspaceId: fixture.workspace.id,
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
        { data: { status: "idle", inputQueuePaused: true, pendingRequests: 0 } },
      ]);
      expect(await store.retryCommand(turn.command.id, new Error("Not dispatched"))).toEqual([]);
      const later = await store.enqueueThreadInput({
        content: [{ type: "text", text: "Next" }],
        idempotencyKey: "status-events-next",
        policy: "queue",
        requestedBy: fixture.userId,
        source: { kind: "human" },
        threadId: fixture.thread.id,
      });
      expect(statusEvents(later.events)).toEqual([]);
      const resumed = await store.resumeThreadInputQueue({
        idempotencyKey: "status-events-resume",
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      expect(statusEvents(resumed.events)).toMatchObject([{ data: { status: "running" } }]);
      const again = await store.resumeThreadInputQueue({
        idempotencyKey: "status-events-resume-again",
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      expect(statusEvents(again.events)).toEqual([]);
      const stored = await database
        .selectFrom("workspaceEvents")
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
        },
        {
          status: "idle",
          inputQueuePaused: true,
          pendingRequests: 0,
          title: fixture.thread.title,
          icon: fixture.thread.icon,
          doneAt: null,
        },
        {
          status: "running",
          inputQueuePaused: false,
          pendingRequests: 0,
          title: fixture.thread.title,
          icon: fixture.thread.icon,
          doneAt: null,
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
        content: [{ type: "text", text: "Start" }],
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
        .set({ status: "waiting" })
        .where("id", "=", fixture.thread.id)
        .execute();
      await store.commitRunnerEvent({
        environmentId: fixture.environmentId,
        runnerBootId: binding.runnerBootId,
        runnerId: fixture.runnerId,
        event: pendingEvent({
          bindingGeneration: binding.bindingGeneration,
          environmentId: fixture.environmentId,
          workspaceId: fixture.workspace.id,
          threadId: fixture.thread.id,
          runId: turn.run.id,
          ordinal: 0,
          type: "run.started",
          data: { status: "running" },
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
          options: [{ hint: "allow-once", id: "allow", label: "Allow" }],
        },
        requestedBy: fixture.userId,
        runId: fixture.run.id,
        threadId: fixture.thread.id,
        workspaceId: fixture.workspace.id,
      });
      const base = {
        bindingGeneration: fixture.bindingGeneration,
        environmentId: fixture.environmentId,
        runId: fixture.run.id,
        threadId: fixture.thread.id,
        workspaceId: fixture.workspace.id,
      };
      await store.commitRunnerEvent({
        ...fixture,
        event: pendingEvent({ ...base, ordinal: 1, type: "request.opened", data: { request } }),
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
          data: { status: "running" },
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
          data: { requestId: request.id, reason: "source-closed" },
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
        content: [{ type: "text", text: "Start" }],
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
        content: [{ type: "text", text: "Next" }],
        idempotencyKey: "status-paused-next",
        policy: "queue",
        requestedBy: fixture.userId,
        source: { kind: "human" },
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
        content: [{ type: "text", text: "Start" }],
        idempotencyKey: "status-resume-waiting",
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      await database
        .updateTable("threads")
        .set({ inputQueuePaused: true, inputQueuePausedBy: fixture.userId, status: "waiting" })
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
        content: [{ type: "text", text: "Fail" }],
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
        content: [{ type: "text", text: "Retry" }],
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
          content: [{ type: "text", text: "Follow on" }],
          idempotencyKey: "status-follow",
          policy: "queue",
          source: { kind: "human" },
          requestedBy: fixture.userId,
          threadId: fixture.thread.id,
        });
        const base = {
          bindingGeneration: fixture.bindingGeneration,
          environmentId: fixture.environmentId,
          workspaceId: fixture.workspace.id,
          threadId: fixture.thread.id,
          runId: fixture.run.id,
          ordinal: 1,
        };
        await store.commitRunnerEvent({
          ...fixture,
          event:
            status === "completed"
              ? pendingEvent({ ...base, type: "run.completed", data: { status } })
              : pendingEvent({
                  ...base,
                  type: "run.failed",
                  data: { status, code: "test_failure", message: "Failed", retryable: false },
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
        content: [{ type: "text", text: "Start" }],
        idempotencyKey: "status-done",
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      await store.claimCommand(turn.command.id, "status-done");
      await store.enqueueThreadInput({
        content: [{ type: "text", text: "Then this" }],
        idempotencyKey: "status-done-follow-up",
        policy: "queue",
        requestedBy: fixture.userId,
        source: { kind: "human" },
        threadId: fixture.thread.id,
      });
      // Done landing between admission and the Run's end, as the freeze must hold.
      await database
        .updateTable("threads")
        .set({ doneAt: new Date() })
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
        originatingWorkspaceId: fixture.workspace.id,
        targetWorkspaceId: fixture.workspace.id,
        requestedBy: fixture.userId,
        payload: {
          kind: "machine.full-disk-access",
          machineId: target,
          machineName: "Mac",
          reason: "Read Mail",
        },
        presentation: {
          kind: "external",
          subject: { kind: "machine", id: target },
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
        response: { kind: "external", value: { decision: "declined" } },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      store.requests.declineMachineFullDiskAccessRequest({
        requestId: declined.request.id,
        resolvedBy: fixture.userId,
        response: { kind: "external", value: { decision: "fulfilled" } },
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    expect(
      await store.requests.declineMachineFullDiskAccessRequest({
        requestId: declined.request.id,
        resolvedBy: fixture.userId,
        response: { kind: "external", value: { decision: "declined" } },
      }),
    ).toMatchObject({ request: { status: "declined", resolvedBy: fixture.userId } });
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
    const { startRunFixture, createSpecializedWorkspace, store } = storeFixture;
    const fixture = await startRunFixture("request-withdrawal");
    const targetWorkspace = await createSpecializedWorkspace(
      fixture.userId,
      "request_withdrawal_target",
    );
    const input = {
      callId: "browser-access-call-1",
      kind: "browser.access" as const,
      mode: "durable" as const,
      originatingRunId: fixture.run.id,
      originatingThreadId: fixture.thread.id,
      originatingWorkspaceId: fixture.workspace.id,
      payload: {
        kind: "browser.access" as const,
        reason: "Use the signed-in browser profile",
        suggestion: { kind: "user_choice" as const },
      },
      presentation: {
        kind: "external" as const,
        subject: { id: targetWorkspace.id, kind: "workspace" },
        title: "Choose browser access",
      },
      requestedBy: fixture.userId,
      requiredActor: "requester" as const,
      targetWorkspaceId: targetWorkspace.id,
    };

    const created = await store.requests.create(input);
    const replay = await store.requests.create(input);
    expect(created).toMatchObject({ replayed: false, request: { status: "pending" } });
    expect(replay).toMatchObject({ replayed: true, request: { id: created.request.id } });

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
      events: [expect.objectContaining({ type: "request.resolved" })],
      replayed: false,
      request: { status: "withdrawn" },
    });
    expect(withdrawnReplay).toMatchObject({
      events: [],
      replayed: true,
      request: { status: "withdrawn" },
    });
    await expect(
      store.requests.originatingPendingPage({ limit: 1, threadId: fixture.thread.id }),
    ).resolves.toMatchObject({ requests: [], window: { totalItems: 0 } });
    await store.drainPendingThreadStates();
    await expect(store.getThreadForOwner(fixture.thread.id, fixture.userId)).resolves.toMatchObject(
      {
        pendingRequests: 0,
      },
    );
    await expect(store.requests.listPendingContinuations()).resolves.toEqual([]);
  });

  it.for(
    (["update", "resume"] as const).flatMap((mutation) =>
      (["drain", "resolution"] as const).flatMap((writer) =>
        (["watch-first", "workspace-first"] as const).map((order) => ({
          mutation,
          writer,
          order,
        })),
      ),
    ),
  )(
    "keeps Watch $mutation foreign keys transparent to $writer ($order)",
    async ({ mutation, writer, order }, { storeFixture }) => {
      const { startRunFixture, store, triggers, createSpecializedWorkspace, database } =
        storeFixture;
      const fixture = await startRunFixture(`watch-fk-${mutation}-${writer}-${order}`);
      const { thread: anchor } = await store.createThread({
        createdBy: fixture.userId,
        environmentId: fixture.environmentId,
        harnessInstanceId: fixture.harnessInstance.id,
        idempotencyKey: "watch-fk-anchor",
        modelSelection: testModelSelection,
        title: "Independent Watch anchor",
        workspaceId: fixture.workspace.id,
      });
      const watch = await triggers.create({
        actorThreadId: null,
        anchorThreadId: anchor.id,
        createdBy: fixture.userId,
        idempotencyKey: "watch-fk",
        name: "Watch FK race",
        program: {
          language: "javascript",
          toolContractVersion: 2,
          source: "export default async () => null",
        },
        source: { kind: "watch" },
      });
      if (mutation === "resume") {
        await triggers.setStatus({
          actorThreadId: null,
          ownerId: fixture.userId,
          status: "paused",
          triggerId: watch.trigger.id,
        });
      }
      const target = await createSpecializedWorkspace(fixture.userId, "watch-fk-target");
      const opened = await store.requests.create({
        callId: "watch-fk-request",
        kind: "browser.access",
        mode: "durable",
        originatingRunId: fixture.run.id,
        originatingThreadId: fixture.thread.id,
        originatingWorkspaceId: fixture.workspace.id,
        targetWorkspaceId: target.id,
        requestedBy: fixture.userId,
        requiredActor: "requester",
        payload: {
          kind: "browser.access",
          reason: "Choose a profile",
          suggestion: { kind: "user_choice" },
        },
        presentation: {
          kind: "external",
          title: "Choose browser access",
          subject: { id: target.id, kind: "workspace" },
        },
      });
      // Capture even retried statement failures: Request resolution's retry cannot
      // turn a deadlock into a passing race.
      const queryErrors: { code: unknown; message: string }[] = [];
      const racingDatabase = new Kysely<DatabaseSchema>({
        dialect: new PostgresDialect({
          pool: new Pool({
            connectionString: storeFixture.databaseUrl,
            max: 2,
            application_name: "opensteer-watch-fk-race",
          }),
        }),
        plugins: [new CamelCasePlugin({ maintainNestedObjectKeys: true })],
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
      // This barrier stops the activation INSERT. Watch writes now take their
      // Workspace before the environment, so the second writer may instead wait at
      // that Workspace: the case checks both commit without a deadlock, whichever
      // fence they meet at. It changes no production query or lock mode.
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
      const waitFor = (fragment: string) =>
        expect
          .poll(async () => {
            const result = await sql<{
              waiting: number;
            }>`select count(*)::integer as waiting from pg_stat_activity
        where datname = current_database() and application_name = 'opensteer-watch-fk-race'
        and wait_event_type = 'Lock' and (query like ${`%${fragment}%`} or query like '%from "workspaces"%')`.execute(
              database,
            );
            return result.rows[0]!.waiting;
          })
          .toBe(1);
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
              response: { kind: "external", value: { decision: "declined" } },
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
          await waitFor('insert into "trigger_watch_activations"');
          start(startWriter);
          await waitFor(`from "${writer === "drain" ? "threads" : "requests"}"`);
        } else {
          start(startWriter);
          await waitFor(`from "${writer === "drain" ? "threads" : "requests"}"`);
          start(startWatch);
          await waitFor('insert into "trigger_watch_activations"');
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
          .selectFrom("workspaceEvents")
          .select(["type", "data"])
          .where("threadId", "=", fixture.thread.id)
          .orderBy("sequence", "desc")
          .execute();
        if (writer === "drain") {
          expect(events).toContainEqual(
            expect.objectContaining({
              type: "thread.state-changed",
              data: expect.objectContaining({ pendingRequests: 1 }),
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
          expect(events).toContainEqual(expect.objectContaining({ type: "request.resolved" }));
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

  it.for([
    { creator: "delegation", mutation: "reassign" },
    { creator: "delegation", mutation: "retire" },
    { creator: "channel", mutation: "reassign" },
    { creator: "channel", mutation: "retire" },
  ] as const)(
    "fences every Thread creator against parent changes ($creator / $mutation)",
    async ({ creator, mutation }, { storeFixture, signal, onTestFinished }) => {
      const {
        createChannelNoticeFixture,
        startRunFixture,
        store,
        recordReadyHarnessCatalog,
        database,
      } = storeFixture;
      const channel =
        creator === "channel"
          ? await createChannelNoticeFixture(`parent-fence-${mutation}`, { accessMode: "anyone" })
          : null;
      const parent = channel ? null : await startRunFixture(`parent-fence-${mutation}`);
      const fixture = channel?.fixture ?? parent!;
      const environmentId = await store.createEnvironment({
        kind: "local",
        name: "Unbound child environment",
        runnerId: fixture.runnerId,
      });
      const harness = await store.createHarnessInstance({
        config: {},
        driverKind: HarnessIdSchema.parse("native"),
        environmentId,
        name: "Child engine",
        sourceId: "native",
        stateKind: "isolated",
      });
      await recordReadyHarnessCatalog(environmentId, harness);
      const otherUserId = await store.createUser("Other parent owner");
      const otherRunnerId = createId("runner");
      await enrollTestRunner(store, {
        createdBy: otherUserId,
        environmentId: createId("environment"),
        name: "Other parent runner",
        runnerId: otherRunnerId,
        runnerKind: "local",
        tokenSuffix: "parent-fence-other",
      });
      if (channel)
        channel.placementCandidates.splice(0, 1, {
          environmentId,
          harnessInstanceId: harness.id,
        });
      const held = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      await sql`create function phase3l_thread_barrier() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(731004, 1); return new; end $$`.execute(database);
      await sql`create constraint trigger phase3l_thread_barrier after insert on threads
      deferrable initially deferred for each row execute function phase3l_thread_barrier()`.execute(
        database,
      );
      const blocker = database.transaction().execute(async (transaction) => {
        await sql`select pg_advisory_xact_lock(731004, 1)`.execute(transaction);
        held.resolve();
        await release.promise;
      });
      await held.promise;
      const creating = channel
        ? channel.adopt({ eventId: "Ev-PARENT-FENCE" })
        : store.delegateThread({
            accessMode: "auto",
            createdBy: fixture.userId,
            environmentId,
            harnessInstanceId: harness.id,
            idempotencyKey: "parent-fence-child",
            modelSelection: testModelSelection,
            origin: {
              kind: "run",
              parentRunId: parent!.run.id,
              parentThreadId: fixture.thread.id,
            },
            task: [{ text: "Child task", type: "text" }],
            title: "Child task",
            workspaceId: fixture.workspace.id,
          });
      void creating.catch(() => undefined);
      let changing: Promise<unknown> | undefined;
      const waiters = async () =>
        (
          await sql<{ query: string }>`select query from pg_stat_activity
      where datname = current_database() and application_name = 'opensteer-integration-test'
      and wait_event_type = 'Lock'`.execute(database)
        ).rows;
      const waitForPhase = async (ready: () => Promise<boolean>) => {
        while (!(await ready())) await delay(10, undefined, { signal: signal });
        signal.throwIfAborted();
      };
      let cleanup: Promise<void> | undefined;
      const dispose = () =>
        (cleanup ??= (async () => {
          release.resolve();
          await blocker;
          await Promise.allSettled([creating, changing]);
          await sql`drop trigger phase3l_thread_barrier on threads`.execute(database);
          await sql`drop function phase3l_thread_barrier()`.execute(database);
        })());
      onTestFinished(dispose);
      try {
        // Both lock phases share the test's cancellation and overall deadline.
        await waitForPhase(async () =>
          (await waiters()).some(({ query }) =>
            ["commit", "set constraints all immediate"].includes(query.toLowerCase()),
          ),
        );
        let changed = false;
        changing =
          mutation === "reassign"
            ? store.assignEnvironmentRunner(environmentId, otherRunnerId)
            : store.removeHarnessInstance(environmentId, harness.id);
        void changing.then(
          () => {
            changed = true;
          },
          () => {
            changed = true;
          },
        );
        await waitForPhase(
          async () =>
            changed ||
            (await waiters()).some(
              ({ query }) =>
                query.startsWith("select") && query.includes('from "execution_environments"'),
            ),
        );
        release.resolve();
        await blocker;
        const outcomes = await Promise.allSettled([creating, changing]);
        expect(outcomes[0].status).toBe("fulfilled");
        expect(outcomes[1]).toMatchObject({ status: "rejected", reason: { code: "conflict" } });
        expect(
          await database
            .selectFrom("threads")
            .select("id")
            .where("environmentId", "=", environmentId)
            .execute(),
        ).toHaveLength(1);
        expect(
          await database
            .selectFrom("executionEnvironments")
            .select("runnerId")
            .where("id", "=", environmentId)
            .executeTakeFirstOrThrow(),
        ).toEqual({ runnerId: fixture.runnerId });
        expect(
          await database
            .selectFrom("harnessInstances")
            .select(["enabled", "removedAt"])
            .where("id", "=", harness.id)
            .executeTakeFirstOrThrow(),
        ).toEqual({ enabled: true, removedAt: null });
      } finally {
        await dispose();
      }
    },
  );

  it.for([
    { creator: "delegation", mutation: "reassign" },
    { creator: "delegation", mutation: "retire" },
    { creator: "channel", mutation: "reassign" },
    { creator: "channel", mutation: "retire" },
  ] as const)(
    "revalidates every Thread creator after waiting for parent changes ($creator / $mutation)",
    async ({ creator, mutation }, { storeFixture }) => {
      const {
        createChannelNoticeFixture,
        startRunFixture,
        store,
        recordReadyHarnessCatalog,
        database,
      } = storeFixture;
      const channel =
        creator === "channel"
          ? await createChannelNoticeFixture(`parent-fence-${mutation}`, { accessMode: "anyone" })
          : null;
      const parent = channel ? null : await startRunFixture(`parent-fence-${mutation}`);
      const fixture = channel?.fixture ?? parent!;
      const environmentId = await store.createEnvironment({
        kind: "local",
        name: "Unbound child environment",
        runnerId: fixture.runnerId,
      });
      const harness = await store.createHarnessInstance({
        config: {},
        driverKind: HarnessIdSchema.parse("native"),
        environmentId,
        name: "Child engine",
        sourceId: "native",
        stateKind: "isolated",
      });
      await recordReadyHarnessCatalog(environmentId, harness);
      const otherUserId = await store.createUser("Other parent owner");
      const otherRunnerId = createId("runner");
      await enrollTestRunner(store, {
        createdBy: otherUserId,
        environmentId: createId("environment"),
        name: "Other parent runner",
        runnerId: otherRunnerId,
        runnerKind: "local",
        tokenSuffix: "parent-fence-other",
      });
      if (channel)
        channel.placementCandidates.splice(0, 1, {
          environmentId,
          harnessInstanceId: harness.id,
        });
      const held = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const blocker = database.transaction().execute(async (transaction) => {
        await transaction
          .selectFrom("executionEnvironments")
          .select("id")
          .where("id", "=", environmentId)
          .forNoKeyUpdate()
          .execute();
        if (mutation === "reassign") {
          await transaction
            .updateTable("executionEnvironments")
            .set({ runnerId: otherRunnerId })
            .where("id", "=", environmentId)
            .execute();
        } else {
          await transaction
            .updateTable("harnessInstances")
            .set({ enabled: false, isDefault: false, removedAt: new Date() })
            .where("id", "=", harness.id)
            .execute();
        }
        held.resolve();
        await release.promise;
      });
      await held.promise;
      const creating = channel
        ? channel.adopt({ eventId: "Ev-PARENT-FENCE" })
        : store.delegateThread({
            accessMode: "auto",
            createdBy: fixture.userId,
            environmentId,
            harnessInstanceId: harness.id,
            idempotencyKey: "parent-fence-child",
            modelSelection: testModelSelection,
            origin: {
              kind: "run",
              parentRunId: parent!.run.id,
              parentThreadId: fixture.thread.id,
            },
            task: [{ text: "Child task", type: "text" }],
            title: "Child task",
            workspaceId: fixture.workspace.id,
          });
      void creating.catch(() => undefined);
      let settled = false;
      void creating.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      const waiters = async () =>
        (
          await sql<{ query: string }>`select query from pg_stat_activity
      where datname = current_database() and application_name = 'opensteer-integration-test'
      and wait_event_type = 'Lock'`.execute(database)
        ).rows;
      try {
        await expect.poll(async () => settled || (await waiters()).length > 0).toBe(true);
        const blockedBeforeValidation =
          !settled &&
          (await waiters()).some(
            ({ query }) =>
              query.startsWith("select") && query.includes('from "execution_environments"'),
          );
        release.resolve();
        await blocker;
        const outcome = await Promise.allSettled([creating]);
        expect(blockedBeforeValidation).toBe(true);
        expect(outcome[0].status).toBe("rejected");
        expect(
          await database
            .selectFrom("threads")
            .select("id")
            .where("environmentId", "=", environmentId)
            .execute(),
        ).toEqual([]);
      } finally {
        release.resolve();
        await blocker;
        await Promise.allSettled([creating]);
      }
    },
  );

  it("fences Thread creation before rechecking a reassigned execution environment", async ({
    storeFixture,
  }) => {
    const { createRunFixture, store, database } = storeFixture;
    const fixture = await createRunFixture("environment-fence-creator");
    const otherUserId = await store.createUser("Other environment owner");
    const otherRunnerId = createId("runner");
    await enrollTestRunner(store, {
      createdBy: otherUserId,
      environmentId: createId("environment"),
      name: "Other owner",
      runnerId: otherRunnerId,
      runnerKind: "local",
      tokenSuffix: "environment-fence-other",
    });
    const environmentId = await store.createEnvironment({
      kind: "local",
      name: "Unbound environment",
      runnerId: fixture.runnerId,
    });
    const harness = await store.createHarnessInstance({
      config: {},
      driverKind: HarnessIdSchema.parse("native"),
      environmentId,
      name: "Native",
      sourceId: "native",
      stateKind: "isolated",
    });
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await sql`create function phase3k_environment_barrier() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(731003, 2); return new; end $$`.execute(database);
    await sql`create trigger phase3k_environment_barrier before update of runner_id on execution_environments
      for each row when (old.runner_id is distinct from new.runner_id) execute function phase3k_environment_barrier()`.execute(
      database,
    );
    const blocker = database.transaction().execute(async (transaction) => {
      await sql`select pg_advisory_xact_lock(731003, 2)`.execute(transaction);
      held.resolve();
      await release.promise;
    });
    await held.promise;
    const assigning = store.assignEnvironmentRunner(environmentId, otherRunnerId);
    void assigning.catch(() => undefined);
    let creating: ReturnType<OpensteerStore["createThread"]> | undefined;
    const waiters = async () =>
      (
        await sql<{ query: string }>`select query from pg_stat_activity
      where datname = current_database() and application_name = 'opensteer-integration-test'
      and wait_event_type = 'Lock'`.execute(database)
      ).rows;
    try {
      await expect
        .poll(async () =>
          (await waiters()).some(({ query }) =>
            query.startsWith('update "execution_environments"'),
          ),
        )
        .toBe(true);
      creating = store.createThread({
        createdBy: fixture.userId,
        environmentId,
        harnessInstanceId: harness.id,
        idempotencyKey: "environment-fence-thread",
        modelSelection: testModelSelection,
        title: "Must recheck ownership",
        workspaceId: fixture.workspace.id,
      });
      void creating.catch(() => undefined);
      await expect.poll(async () => (await waiters()).length).toBe(2);
      expect(
        (await waiters()).some(
          ({ query }) =>
            query.startsWith("select") && query.includes('from "execution_environments"'),
        ),
      ).toBe(true);
      release.resolve();
      await blocker;
      await expect(assigning).resolves.toBeUndefined();
      await expect(creating).rejects.toMatchObject({ code: "forbidden" });
      expect(
        await database
          .selectFrom("threads")
          .select("id")
          .where("environmentId", "=", environmentId)
          .execute(),
      ).toEqual([]);
    } finally {
      release.resolve();
      await blocker;
      await Promise.allSettled([assigning, creating]);
      await sql`drop trigger phase3k_environment_barrier on execution_environments`.execute(
        database,
      );
      await sql`drop function phase3k_environment_barrier()`.execute(database);
    }
  });

  it.for(["row", "owner-change"] as const)(
    "keeps Workspace foreign keys transparent while Workspace fences still serialize (%s)",
    async (fence, { storeFixture }) => {
      const { startRunFixture, database, store } = storeFixture;
      const fixture = await startRunFixture("workspace-fk-transparent");
      const template = await database
        .selectFrom("workspaceEvents")
        .selectAll()
        .where("workspaceId", "=", fixture.workspace.id)
        .where("runnerOrdinal", "is", null)
        .executeTakeFirstOrThrow();
      if (fence === "owner-change") {
        const secondOwner = await store.createUser("Second Workspace owner");
        const membership = await database
          .selectFrom("workspaceMemberships")
          .selectAll()
          .where("workspaceId", "=", fixture.workspace.id)
          .where("userId", "=", fixture.userId)
          .executeTakeFirstOrThrow();
        await database
          .insertInto("workspaceMemberships")
          .values({ ...membership, id: createId("workspaceMembership"), userId: secondOwner })
          .execute();
      }
      const held = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let secondEntered = false;
      let inserted = false;
      const first = database.transaction().execute(async (transaction) => {
        await lockWorkspaceRow(transaction, fixture.workspace.id);
        if (fence === "owner-change") {
          // Exercise the installed last-owner trigger, which must not upgrade
          // the Workspace fence just because its membership row changes.
          await transaction
            .updateTable("workspaceMemberships")
            .set({ role: "collaborator" })
            .where("workspaceId", "=", fixture.workspace.id)
            .where("userId", "=", fixture.userId)
            .execute();
        }
        held.resolve();
        await release.promise;
      });
      await held.promise;
      const second = database.transaction().execute(async (transaction) => {
        await lockWorkspaceRow(transaction, fixture.workspace.id);
        secondEntered = true;
      });
      void second.catch(() => undefined);
      let child: Promise<unknown> | undefined;
      const waiters = async () =>
        (
          await sql<{ query: string }>`select query from pg_stat_activity
      where datname = current_database() and application_name = 'opensteer-integration-test'
      and wait_event_type = 'Lock'`.execute(database)
        ).rows;
      try {
        await expect
          .poll(async () =>
            (await waiters()).some(({ query }) => query.includes('from "workspaces"')),
          )
          .toBe(true);
        // An unrelated history INSERT needs referential integrity, not lifecycle
        // authority. It must finish while both Workspace writers remain staged.
        child = database
          .insertInto("workspaceEvents")
          .values({
            ...template,
            data: jsonValue(template.data),
            eventId: createId("event"),
            sequence: "1000000",
          })
          .execute()
          .then(() => {
            inserted = true;
          });
        void child.catch(() => undefined);
        await expect
          .poll(
            async () =>
              inserted ||
              (await waiters()).some(({ query }) =>
                query.includes('insert into "workspace_events"'),
              ),
          )
          .toBe(true);
        expect(inserted).toBe(true);
        expect(secondEntered).toBe(false);
        expect((await waiters()).some(({ query }) => query.includes('from "workspaces"'))).toBe(
          true,
        );
      } finally {
        release.resolve();
        await first;
        await Promise.all([second, child]);
      }
      expect(secondEntered).toBe(true);
      expect(inserted).toBe(true);
    },
  );

  it("keeps durable Request event foreign keys compatible with Runner ingestion", async ({
    storeFixture,
  }) => {
    const { startRunFixture, createSpecializedWorkspace, store, stagedRequestRace, database } =
      storeFixture;
    const fixture = await startRunFixture("request-run-fk-race");
    const target = await createSpecializedWorkspace(fixture.userId, "request-run-fk-race-target");
    const opened = await store.requests.create({
      callId: "request-run-fk-race",
      kind: "browser.access",
      mode: "durable",
      originatingRunId: fixture.run.id,
      originatingThreadId: fixture.thread.id,
      originatingWorkspaceId: fixture.workspace.id,
      targetWorkspaceId: target.id,
      requestedBy: fixture.userId,
      requiredActor: "requester",
      payload: {
        kind: "browser.access",
        reason: "Choose a profile",
        suggestion: { kind: "user_choice" },
      },
      presentation: {
        kind: "external",
        title: "Choose browser access",
        subject: { id: target.id, kind: "workspace" },
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
          response: { kind: "external", value: { decision: "declined" } },
        }),
      () =>
        store.commitRunnerEvent({
          environmentId: fixture.environmentId,
          runnerBootId: fixture.runnerBootId,
          runnerId: fixture.runnerId,
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
        }),
    );
    expect(results.map(({ status }) => status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await store.requests.get(opened.request.id)).toMatchObject({ status: "declined" });
    const events = await database
      .selectFrom("workspaceEvents")
      .select("type")
      .where("runId", "=", fixture.run.id)
      .orderBy("sequence", "asc")
      .execute();
    expect(events.map(({ type }) => type)).toEqual(
      expect.arrayContaining(["request.resolved", "run.completed"]),
    );
  });
});
