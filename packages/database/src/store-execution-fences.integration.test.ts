import { lockDeploymentEvents } from "./deployment-events.js";

import { pauseAfterLock } from "./lock-race.test-support.js";
import { lockCommandIdempotency } from "./store-primitives.js";
import { HarnessIdSchema, ModelSelectionSchema, createId } from "@opensteer/core";
import { nodeDetailEventNodeId } from "@opensteer/core";
import { type PendingAgentEvent, HarnessInstanceCatalogSchema } from "@opensteer/protocol";
import { sql } from "kysely";
import { expect } from "vitest";
import { ChannelStore, OpensteerStore } from "./index.js";
import {
  describeStore,
  testModelSelection,
  testContinuationIdentity,
  testReadyHarnessCatalog,
  pendingEvent,
} from "./store.integration.test-support.js";
describeStore("PostgreSQL store", (it) => {
  it("reserves delegation task idempotency before execution fences", async ({ storeFixture }) => {
    const { startRunFixture, database, store } = storeFixture;
    const fixture = await startRunFixture("delegation-idempotency-order");
    const key = "delegation-idempotency-order";
    const barrier = pauseAfterLock(database, (node) => node.includes("pg_advisory_xact_lock"));
    const peer = barrier.database.transaction().execute(async (transaction) => {
      await lockCommandIdempotency(transaction, fixture.userId, `${key}:task`);
      await lockDeploymentEvents(transaction);
    });
    void peer.catch(() => undefined);
    let delegation: ReturnType<OpensteerStore["delegateThread"]> | undefined;
    try {
      await barrier.reached;
      delegation = store.delegateThread({
        accessMode: "auto",
        createdBy: fixture.userId,
        environmentId: fixture.environmentId,
        harnessInstanceId: fixture.harnessInstance.id,
        idempotencyKey: key,
        modelSelection: testModelSelection,
        origin: {
          kind: "run",
          parentRunId: fixture.run.id,
          parentThreadId: fixture.thread.id,
        },
        task: [
          {
            text: "Child task",
            type: "text",
          },
        ],
        title: "Child",
      });
      void delegation.catch(() => undefined);
      await expect
        .poll(async () =>
          (
            await sql<{
              query: string;
            }>`
        select query from pg_stat_activity where datname=current_database()
        and application_name='opensteer-integration-test' and wait_event_type='Lock'
      `.execute(database)
          ).rows.some(({ query }) => query.includes("pg_advisory_xact_lock")),
        )
        .toBe(true);
      barrier.release();
      const results = await Promise.allSettled([peer, delegation]);
      expect(barrier.conflicts).toEqual([]);
      expect(results.filter(({ status }) => status === "rejected")).toEqual([]);
      expect(results[1]).toMatchObject({
        value: {
          wasDuplicate: false,
        },
      });
    } finally {
      barrier.release();
      await Promise.allSettled([peer, delegation]);
    }
  });
  it("reserves Assignment cancellation idempotency before its scope fence", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, database } = storeFixture;
    const fixture = await startRunFixture("cancel-idempotency-order");
    const delegated = await store.delegateThread({
      accessMode: "auto",
      createdBy: fixture.userId,
      environmentId: fixture.environmentId,
      harnessInstanceId: fixture.harnessInstance.id,
      idempotencyKey: "cancel-idempotency-child",
      modelSelection: testModelSelection,
      origin: {
        kind: "run",
        parentRunId: fixture.run.id,
        parentThreadId: fixture.thread.id,
      },
      task: [
        {
          text: "Child task",
          type: "text",
        },
      ],
      title: "Child",
    });
    const key = "cancel-idempotency-order";
    const barrier = pauseAfterLock(database, (node) => node.includes("pg_advisory_xact_lock"));
    const peer = barrier.database.transaction().execute(async (transaction) => {
      await lockCommandIdempotency(transaction, fixture.userId, key);
      await transaction
        .selectFrom("delegations")
        .select("id")
        .where("id", "=", delegated.assignment.id)
        .forNoKeyUpdate()
        .execute();
    });
    void peer.catch(() => undefined);
    let cancellation: ReturnType<OpensteerStore["cancelAssignment"]> | undefined;
    try {
      await barrier.reached;
      cancellation = store.cancelAssignment({
        assignmentId: delegated.assignment.id,
        actorRunId: fixture.run.id,
        requestedBy: fixture.userId,
        idempotencyKey: key,
      });
      void cancellation.catch(() => undefined);
      await expect
        .poll(async () =>
          (
            await sql<{
              query: string;
            }>`
        select query from pg_stat_activity where datname=current_database()
        and application_name='opensteer-integration-test' and wait_event_type='Lock'
      `.execute(database)
          ).rows.some(({ query }) => query.includes("pg_advisory_xact_lock")),
        )
        .toBe(true);
      barrier.release();
      const results = await Promise.allSettled([peer, cancellation]);
      expect(barrier.conflicts).toEqual([]);
      expect(results.filter(({ status }) => status === "rejected")).toEqual([]);
    } finally {
      barrier.release();
      await Promise.allSettled([peer, cancellation]);
    }
  });
  it.for([
    {
      eventType: "run.started",
      fence: "provider_sessions",
    },
    {
      eventType: "run.interrupted",
      fence: "provider_sessions",
    },
    {
      eventType: "run.interrupted",
      fence: "commands",
    },
  ] as const)(
    "fences $fence before input projection for $eventType",
    async ({ eventType, fence }, { storeFixture }) => {
      const { createRunFixture, enqueueHumanTrigger, store, bindAgentControlRun, database } =
        storeFixture;
      const fixture = await createRunFixture(`projection-${eventType.replace(".", "-")}-${fence}`);
      const turn = await enqueueHumanTrigger({
        content: [
          {
            type: "text",
            text: "Work",
          },
        ],
        idempotencyKey: "projection-fences",
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      await store.claimCommand(turn.command.id, "projection-fences");
      const binding = await bindAgentControlRun(fixture, turn.run.id, "projection-fences");
      const provider = await database
        .selectFrom("runs")
        .select("providerSessionId")
        .where("id", "=", turn.run.id)
        .executeTakeFirstOrThrow();
      const barrier = pauseAfterLock(database, (node) => node.includes(fence));
      const peer = barrier.database.transaction().execute(async (transaction) => {
        await sql`select id from ${sql.table(fence)} where id=${fence === "commands" ? turn.command.id : provider.providerSessionId} for no key update`.execute(
          transaction,
        );
        await transaction
          .selectFrom("threadInputs")
          .select("messageId")
          .where("messageId", "=", turn.message.id)
          .forNoKeyUpdate()
          .execute();
      });
      void peer.catch(() => undefined);
      let projecting: ReturnType<OpensteerStore["commitRunnerEvent"]> | undefined;
      try {
        await barrier.reached;
        projecting = store.commitRunnerEvent({
          environmentId: fixture.environmentId,
          runnerBootId: binding.runnerBootId,
          runnerId: fixture.runnerId,
          event: pendingEvent({
            bindingGeneration: binding.bindingGeneration,
            data: {
              status: eventType === "run.started" ? "running" : "interrupted",
            },
            environmentId: fixture.environmentId,
            ordinal: 0,
            runId: turn.run.id,
            threadId: fixture.thread.id,
            type: eventType,
          }),
        });
        void projecting.catch(() => undefined);
        await expect
          .poll(async () =>
            (
              await sql<{
                query: string;
              }>`
        select query from pg_stat_activity where datname=current_database()
        and application_name='opensteer-integration-test' and wait_event_type='Lock'
      `.execute(database)
            ).rows.some(({ query }) => query.includes(fence)),
          )
          .toBe(true);
        barrier.release();
        const results = await Promise.allSettled([peer, projecting]);
        expect(barrier.conflicts).toEqual([]);
        expect(results.filter(({ status }) => status === "rejected")).toEqual([]);
      } finally {
        barrier.release();
        await Promise.allSettled([peer, projecting]);
      }
    },
  );
  it.for(["provider_sessions", "commands"] as const)(
    "fences Assignment %s before cancelled inputs",
    async (fence, { storeFixture }) => {
      const { startRunFixture, store, database } = storeFixture;
      const fixture = await startRunFixture("cancel-projection-order");
      const delegated = await store.delegateThread({
        accessMode: "auto",
        createdBy: fixture.userId,
        environmentId: fixture.environmentId,
        harnessInstanceId: fixture.harnessInstance.id,
        idempotencyKey: "cancel-projection-child",
        modelSelection: testModelSelection,
        origin: {
          kind: "run",
          parentRunId: fixture.run.id,
          parentThreadId: fixture.thread.id,
        },
        task: [
          {
            text: "Child",
            type: "text",
          },
        ],
        title: "Child",
      });
      const barrier = pauseAfterLock(database, (node) => node.includes(fence));
      const peer = barrier.database.transaction().execute(async (transaction) => {
        await sql`select id from ${sql.table(fence)} where thread_id=${delegated.thread.id} order by id for no key update`.execute(
          transaction,
        );
        await transaction
          .selectFrom("threadInputs")
          .select("messageId")
          .where("assignmentId", "=", delegated.assignment.id)
          .orderBy("messageId", "asc")
          .forNoKeyUpdate()
          .execute();
      });
      void peer.catch(() => undefined);
      let cancellation: ReturnType<OpensteerStore["cancelAssignment"]> | undefined;
      try {
        await barrier.reached;
        cancellation = store.cancelAssignment({
          assignmentId: delegated.assignment.id,
          actorRunId: fixture.run.id,
          requestedBy: fixture.userId,
          idempotencyKey: "cancel-projection",
        });
        void cancellation.catch(() => undefined);
        await expect
          .poll(async () =>
            (
              await sql<{
                query: string;
              }>`select query from pg_stat_activity
        where datname=current_database() and application_name='opensteer-integration-test' and wait_event_type='Lock'
      `.execute(database)
            ).rows.some(({ query }) => query.includes(fence)),
          )
          .toBe(true);
        barrier.release();
        const results = await Promise.allSettled([peer, cancellation]);
        expect(barrier.conflicts).toEqual([]);
        expect(results.filter(({ status }) => status === "rejected")).toEqual([]);
      } finally {
        barrier.release();
        await Promise.allSettled([peer, cancellation]);
      }
    },
  );
  it("does not interrupt a worker Run that finished while cancellation waited on it", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, database } = storeFixture;
    const fixture = await startRunFixture("cancel-finished-worker");
    const delegated = await store.delegateThread({
      accessMode: "auto",
      createdBy: fixture.userId,
      environmentId: fixture.environmentId,
      harnessInstanceId: fixture.harnessInstance.id,
      idempotencyKey: "cancel-finished-worker-child",
      modelSelection: testModelSelection,
      origin: {
        kind: "run",
        parentRunId: fixture.run.id,
        parentThreadId: fixture.thread.id,
      },
      task: [
        {
          text: "Child",
          type: "text",
        },
      ],
      title: "Child",
    });
    const workerRunId = delegated.run.id;
    // A dispatched worker: cancellation would interrupt it rather than finalize it.
    await database
      .updateTable("runs")
      .set({
        status: "running",
      })
      .where("id", "=", workerRunId)
      .execute();
    const held = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const worker = database.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom("runs")
        .select("id")
        .where("id", "=", workerRunId)
        .forNoKeyUpdate()
        .execute();
      held.resolve();
      await finish.promise;
      await transaction
        .updateTable("runs")
        .set({
          completedAt: new Date(),
          status: "interrupted",
        })
        .where("id", "=", workerRunId)
        .execute();
    });
    void worker.catch(() => undefined);
    let cancellation: ReturnType<OpensteerStore["cancelAssignment"]> | undefined;
    try {
      await held.promise;
      cancellation = store.cancelAssignment({
        assignmentId: delegated.assignment.id,
        actorRunId: fixture.run.id,
        requestedBy: fixture.userId,
        idempotencyKey: "cancel-finished-worker",
      });
      void cancellation.catch(() => undefined);
      await expect
        .poll(async () =>
          (
            await sql<{
              query: string;
            }>`select query from pg_stat_activity
        where datname=current_database() and application_name='opensteer-integration-test' and wait_event_type='Lock'
      `.execute(database)
          ).rows.some(({ query }) => query.includes('from "runs"')),
        )
        .toBe(true);
      finish.resolve();
      await worker;
      await cancellation;
    } finally {
      finish.resolve();
      await Promise.allSettled([worker, ...(cancellation ? [cancellation] : [])]);
    }
    expect(
      await database
        .selectFrom("commands")
        .select("id")
        .where("runId", "=", workerRunId)
        .where("type", "=", "run.interrupt")
        .execute(),
    ).toEqual([]);
  });
  it.for(["channel_bindings", "channel_identities"] as const)(
    "fences queued channel %s before its Thread",
    async (resource, { storeFixture }) => {
      const { createChannelNoticeFixture, database, store } = storeFixture;
      const fixture = await createChannelNoticeFixture("channel-claim-prefix", {
        accessMode: "anyone",
      });
      const adopted = await fixture.adopt({
        eventId: "claim-prefix",
        type: "dm",
      });
      if (adopted.result.kind !== "adopted" || !adopted.result.run)
        throw new Error("Expected queued channel Run");
      const run = adopted.result.run;
      const command = await database
        .selectFrom("commands")
        .select("id")
        .where("runId", "=", run.id)
        .where("type", "=", "run.execute")
        .executeTakeFirstOrThrow();
      const barrier = pauseAfterLock(database, (node) => node.includes(resource));
      const peer = barrier.database.transaction().execute(async (transaction) => {
        await sql`select id from ${sql.table(resource)} where account_id=${fixture.configured.account.id} order by id for no key update`.execute(
          transaction,
        );
        await transaction
          .selectFrom("threads")
          .select("id")
          .where("id", "=", run.threadId)
          .forNoKeyUpdate()
          .execute();
      });
      void peer.catch(() => undefined);
      let claiming: Promise<unknown> | undefined;
      try {
        await barrier.reached;
        claiming = store.claimCommand(command.id, "channel-claim-prefix");
        void claiming.catch(() => undefined);
        await expect
          .poll(async () =>
            (
              await sql<{
                query: string;
              }>`
          select query from pg_stat_activity where datname=current_database()
          and application_name='opensteer-integration-test' and wait_event_type='Lock'
        `.execute(database)
            ).rows.some(({ query }) => query.includes(resource)),
          )
          .toBe(true);
        barrier.release();
        const results = await Promise.allSettled([peer, claiming]);
        expect(barrier.conflicts).toEqual([]);
        expect(results.filter(({ status }) => status === "rejected")).toEqual([]);
      } finally {
        barrier.release();
        await Promise.allSettled([peer, claiming]);
      }
    },
  );
  it("fences the Assignment before claiming its Command", async ({ storeFixture }) => {
    const { startRunFixture, store, database } = storeFixture;
    const fixture = await startRunFixture("assignment-claim-prefix");
    const delegated = await store.delegateThread({
      accessMode: "auto",
      createdBy: fixture.userId,
      environmentId: fixture.environmentId,
      harnessInstanceId: fixture.harnessInstance.id,
      idempotencyKey: "assignment-claim-child",
      modelSelection: testModelSelection,
      origin: {
        kind: "run",
        parentRunId: fixture.run.id,
        parentThreadId: fixture.thread.id,
      },
      task: [
        {
          text: "Child",
          type: "text",
        },
      ],
      title: "Child",
    });
    const command = await database
      .selectFrom("commands")
      .select("id")
      .where("threadId", "=", delegated.thread.id)
      .where("type", "=", "run.execute")
      .executeTakeFirstOrThrow();
    const barrier = pauseAfterLock(database, (node) => /"name":"delegations"/u.test(node));
    const peer = barrier.database.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom("delegations")
        .select("id")
        .where("id", "=", delegated.assignment.id)
        .forNoKeyUpdate()
        .execute();
      await transaction
        .selectFrom("commands")
        .select("id")
        .where("id", "=", command.id)
        .forNoKeyUpdate()
        .execute();
    });
    void peer.catch(() => undefined);
    let claiming: Promise<unknown> | undefined;
    try {
      await barrier.reached;
      claiming = store.claimCommand(command.id, "assignment-claim-prefix");
      void claiming.catch(() => undefined);
      await expect
        .poll(async () =>
          (
            await sql<{
              query: string;
            }>`
        select query from pg_stat_activity where datname=current_database()
        and application_name='opensteer-integration-test' and wait_event_type='Lock'
      `.execute(database)
          ).rows.some(({ query }) => query.includes('"delegations"')),
        )
        .toBe(true);
      barrier.release();
      const results = await Promise.allSettled([peer, claiming]);
      expect(barrier.conflicts).toEqual([]);
      expect(results.filter(({ status }) => status === "rejected")).toEqual([]);
    } finally {
      barrier.release();
      await Promise.allSettled([peer, claiming]);
    }
  });
  it.for(["nested-delegation", "cancel-request", "drain-pending"] as const)(
    "orders Assignment projection fences (%s)",
    async (scenario, { storeFixture }) => {
      const { startRunFixture, store, database, bindAgentControlRun, createTaskForOwner } =
        storeFixture;
      const fixture = await startRunFixture("assignment-projection-prefix");
      const delegated = await store.delegateThread({
        accessMode: "auto",
        createdBy: fixture.userId,
        environmentId: fixture.environmentId,
        harnessInstanceId: fixture.harnessInstance.id,
        idempotencyKey: "projection-child",
        modelSelection: testModelSelection,
        origin: {
          kind: "run",
          parentRunId: fixture.run.id,
          parentThreadId: fixture.thread.id,
        },
        task: [
          {
            text: "Child",
            type: "text",
          },
        ],
        title: "Child",
      });
      const command = await database
        .selectFrom("commands")
        .select("id")
        .where("runId", "=", delegated.run.id)
        .where("type", "=", "run.execute")
        .executeTakeFirstOrThrow();
      await store.claimCommand(command.id, "projection-child");
      const binding = await bindAgentControlRun(
        fixture,
        delegated.run.id,
        "projection-child",
        delegated.thread.id,
      );
      await store.commitRunnerEvent({
        environmentId: fixture.environmentId,
        runnerBootId: binding.runnerBootId,
        runnerId: fixture.runnerId,
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
      });
      const target = await createTaskForOwner(fixture.userId, "projection-request-target");
      const opened =
        scenario !== "nested-delegation"
          ? await store.requests.create({
              callId: "projection-request",
              kind: "browser.access",
              mode: "durable",
              originatingRunId: delegated.run.id,
              originatingThreadId: delegated.thread.id,
              payload: {
                kind: "browser.access",
                reason: "Choose browser",
                suggestion: {
                  kind: "user_choice",
                },
              },
              presentation: {
                kind: "external",
                subject: {
                  id: target.id,
                  kind: "workspace",
                },
                title: "Choose browser",
              },
              requestedBy: fixture.userId,
              requiredActor: "requester",
            })
          : null;
      const resource =
        scenario === "nested-delegation"
          ? "causal_chains"
          : scenario === "cancel-request"
            ? "requests"
            : "delegations";
      const run = await database
        .selectFrom("runs")
        .select("causalChainId")
        .where("id", "=", delegated.run.id)
        .executeTakeFirstOrThrow();
      const barrier = pauseAfterLock(database, (node) => node.includes(resource));
      const peer = barrier.database.transaction().execute(async (transaction) => {
        await sql`select id from ${sql.table(resource)} where id=${scenario === "nested-delegation" ? run.causalChainId : scenario === "cancel-request" ? opened!.request.id : delegated.assignment.id} for no key update`.execute(
          transaction,
        );
        if (scenario === "drain-pending") {
          await transaction
            .selectFrom("threadStatePending")
            .select("threadId")
            .where("threadId", "=", delegated.thread.id)
            .forUpdate()
            .execute();
        } else {
          await transaction
            .selectFrom("delegations")
            .select("id")
            .where("id", "=", delegated.assignment.id)
            .forNoKeyUpdate()
            .execute();
        }
      });
      void peer.catch(() => undefined);
      let mutation: Promise<unknown> | undefined;
      try {
        await barrier.reached;
        mutation =
          scenario === "nested-delegation"
            ? store.delegateThread({
                accessMode: "auto",
                createdBy: fixture.userId,
                environmentId: fixture.environmentId,
                harnessInstanceId: fixture.harnessInstance.id,
                idempotencyKey: "projection-grandchild",
                modelSelection: testModelSelection,
                origin: {
                  kind: "run",
                  parentRunId: delegated.run.id,
                  parentThreadId: delegated.thread.id,
                },
                task: [
                  {
                    text: "Grandchild",
                    type: "text",
                  },
                ],
                title: "Grandchild",
              })
            : scenario === "cancel-request"
              ? store.cancelAssignment({
                  assignmentId: delegated.assignment.id,
                  actorRunId: fixture.run.id,
                  requestedBy: fixture.userId,
                  idempotencyKey: "projection-cancel",
                })
              : store.drainPendingThreadStates();
        void mutation.catch(() => undefined);
        await expect
          .poll(async () =>
            (
              await sql<{
                query: string;
              }>`
          select query from pg_stat_activity where datname=current_database()
          and application_name='opensteer-integration-test' and wait_event_type='Lock'
        `.execute(database)
            ).rows.some(({ query }) => query.includes(resource)),
          )
          .toBe(true);
        barrier.release();
        const results = await Promise.allSettled([peer, mutation]);
        expect(barrier.conflicts).toEqual([]);
        expect(results.filter(({ status }) => status === "rejected")).toEqual([]);
      } finally {
        barrier.release();
        await Promise.allSettled([peer, mutation]);
      }
    },
  );
  it.for(["Thread", "Account"] as const)(
    "fences dispatch %s before its messaging receipt",
    async (scope, { storeFixture }) => {
      const { createChannelNoticeFixture, database, store } = storeFixture;
      const fixture = await createChannelNoticeFixture("channel-receipt-prefix", {
        accessMode: "anyone",
      });
      const adopted = await fixture.adopt({
        eventId: "receipt-prefix",
        type: "dm",
      });
      if (adopted.result.kind !== "adopted" || !adopted.result.run)
        throw new Error("Expected channel Run");
      const run = adopted.result.run;
      const command = await database
        .selectFrom("commands")
        .select("id")
        .where("runId", "=", run.id)
        .where("type", "=", "run.execute")
        .executeTakeFirstOrThrow();
      await store.claimCommand(command.id, "channel-receipt-prefix");
      const barrier = pauseAfterLock(database, (node) =>
        scope === "Thread"
          ? /"name":"threads"/u.test(node)
          : /"name":"channel_?accounts"/iu.test(node),
      );
      const peer = barrier.database.transaction().execute(async (transaction) => {
        if (scope === "Account") {
          await transaction
            .selectFrom("channelAccounts")
            .select("id")
            .where("id", "=", fixture.configured.account.id)
            .forNoKeyUpdate()
            .execute();
          await transaction
            .selectFrom("channelBindings")
            .select("id")
            .where("accountId", "=", fixture.configured.account.id)
            .orderBy("id", "asc")
            .forNoKeyUpdate()
            .execute();
        } else {
          await transaction
            .selectFrom("threads")
            .select("id")
            .where("id", "=", run.threadId)
            .forNoKeyUpdate()
            .execute();
          await transaction
            .selectFrom("commands")
            .select("id")
            .where("id", "=", command.id)
            .forNoKeyUpdate()
            .execute();
        }
      });
      void peer.catch(() => undefined);
      let dispatching: Promise<unknown> | undefined;
      try {
        await barrier.reached;
        dispatching = store.dispatchChannelCommand(command.id, async (beforeAck) => beforeAck());
        void dispatching.catch(() => undefined);
        await expect
          .poll(async () =>
            (
              await sql<{
                query: string;
              }>`
        select query from pg_stat_activity where datname=current_database()
        and application_name='opensteer-integration-test' and wait_event_type='Lock'
      `.execute(database)
            ).rows.some(({ query }) =>
              query.includes(scope === "Thread" ? '"threads"' : '"channel_accounts"'),
            ),
          )
          .toBe(true);
        barrier.release();
        const results = await Promise.allSettled([peer, dispatching]);
        expect(barrier.conflicts).toEqual([]);
        expect(results.filter(({ status }) => status === "rejected")).toEqual([]);
      } finally {
        barrier.release();
        await Promise.allSettled([peer, dispatching]);
      }
    },
  );
  it("fences the channel identity before redeeming its link code", async ({ storeFixture }) => {
    const { createChannelNoticeFixture, database } = storeFixture;
    const fixture = await createChannelNoticeFixture("link-order");
    await fixture.adopt({
      eventId: "link-order-event",
      type: "dm",
    });
    const code = await database
      .selectFrom("channelLinkCodes")
      .selectAll()
      .where("accountId", "=", fixture.configured.account.id)
      .executeTakeFirstOrThrow();
    const barrier = pauseAfterLock(database, (node) => /"name":"channel_?identities"/iu.test(node));
    const peer = barrier.database.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom("channelIdentities")
        .select("id")
        .where("id", "=", code.identityId)
        .forNoKeyUpdate()
        .execute();
      await transaction
        .selectFrom("channelLinkCodes")
        .select("id")
        .where("id", "=", code.id)
        .forNoKeyUpdate()
        .execute();
    });
    void peer.catch(() => undefined);
    let linking: ReturnType<ChannelStore["linkIdentity"]> | undefined;
    try {
      await barrier.reached;
      linking = fixture.channels.linkIdentity({
        codeHash: code.codeHash,
        userId: fixture.fixture.userId,
      });
      void linking.catch(() => undefined);
      await expect
        .poll(async () =>
          (
            await sql<{
              query: string;
            }>`select query from pg_stat_activity
        where datname=current_database() and application_name='opensteer-integration-test' and wait_event_type='Lock'
      `.execute(database)
          ).rows.some(({ query }) => query.includes('"channel_identities"')),
        )
        .toBe(true);
      barrier.release();
      const results = await Promise.allSettled([peer, linking]);
      expect(barrier.conflicts).toEqual([]);
      expect(results.filter(({ status }) => status === "rejected")).toEqual([]);
      expect(
        await database
          .selectFrom("channelIdentities")
          .select("linkedUserId")
          .where("id", "=", code.identityId)
          .executeTakeFirstOrThrow(),
      ).toEqual({
        linkedUserId: fixture.fixture.userId,
      });
    } finally {
      barrier.release();
      await Promise.allSettled([peer, linking]);
    }
  });

  it("orders injected-message command fencing before its input receipt", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, database } = storeFixture;
    const fixture = await startRunFixture("injected-command-order");
    const steer = await store.enqueueThreadInput({
      content: [
        {
          text: "Steer the active work",
          type: "text",
        },
      ],
      idempotencyKey: "injected-command-order",
      policy: "steer",
      requestedBy: fixture.userId,
      source: {
        kind: "human",
      },
      threadId: fixture.thread.id,
    });
    if (!steer.command) throw new Error("Expected steer command");
    const barrier = pauseAfterLock(
      database,
      (node) =>
        node.includes('"kind":"SelectQueryNode"') &&
        node.includes('"name":"commands"') &&
        node.includes("ForNoKeyUpdate"),
    );
    const peer = barrier.database.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom("commands")
        .select("id")
        .where("id", "=", steer.command!.id)
        .forNoKeyUpdate()
        .execute();
      await transaction
        .selectFrom("threadInputs")
        .select("messageId")
        .where("messageId", "=", steer.message.id)
        .forNoKeyUpdate()
        .execute();
    });
    void peer.catch(() => undefined);
    let injected: ReturnType<OpensteerStore["commitRunnerEvent"]> | undefined;
    try {
      await barrier.reached;
      injected = store.commitRunnerEvent({
        environmentId: fixture.environmentId,
        event: pendingEvent({
          bindingGeneration: fixture.bindingGeneration,
          data: {
            messageId: steer.message.id,
          },
          environmentId: fixture.environmentId,
          ordinal: 1,
          runId: fixture.run.id,
          threadId: fixture.thread.id,
          type: "message.injected",
        }),
        runnerBootId: fixture.runnerBootId,
        runnerId: fixture.runnerId,
      });
      void injected.catch(() => undefined);
      await expect
        .poll(async () =>
          (
            await sql<{
              query: string;
            }>`
        select query from pg_stat_activity where datname=current_database()
        and application_name='opensteer-integration-test' and wait_event_type='Lock'
      `.execute(database)
          ).rows.some(({ query }) => query.includes('"commands"')),
        )
        .toBe(true);
      barrier.release();
      const results = await Promise.allSettled([peer, injected]);
      expect(barrier.conflicts).toEqual([]);
      expect(results.filter(({ status }) => status === "rejected")).toEqual([]);
      expect(
        await database
          .selectFrom("threadInputs")
          .select("state")
          .where("messageId", "=", steer.message.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({
        state: "delivered",
      });
    } finally {
      barrier.release();
      await Promise.allSettled([peer, injected]);
    }
  });
  it("orders catalog adoption with execution binding without a deadlock", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, store, database } = storeFixture;
    const fixture = await createRunFixture("catalog-binding-order");
    const turn = await enqueueHumanTrigger({
      content: [
        {
          text: "Bind while adopting",
          type: "text",
        },
      ],
      idempotencyKey: "catalog-binding-order",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    await store.claimCommand(turn.command.id, "catalog-binding-order");
    await database
      .updateTable("providerSessions")
      .set({
        continuationIdentity: sql`${JSON.stringify(testContinuationIdentity)}::jsonb`,
      })
      .where("id", "=", turn.run.providerSessionId!)
      .execute();
    const replacement = {
      ...testContinuationIdentity,
      continuationKey: "runner:v1:XBFO4gDBdSg2fXioCLyTd-RGpc_Zcz838BvyfVUY5d0",
    };
    const barrier = pauseAfterLock(
      database,
      (node) =>
        node.includes('"kind":"SelectQueryNode"') &&
        /"name":"harness_?instances"/iu.test(node) &&
        node.includes("ForNoKeyUpdate"),
    );
    const adopting = new OpensteerStore(barrier.database).recordHarnessCatalogs({
      catalogs: [
        HarnessInstanceCatalogSchema.parse({
          ...testReadyHarnessCatalog(fixture.harnessInstance.id),
          continuationIdentity: replacement,
          supersededContinuationIdentities: [testContinuationIdentity.continuationKey],
        }),
      ],
      environmentId: fixture.environmentId,
      expectedRevisions: new Map([
        [fixture.harnessInstance.id, fixture.harnessInstance.runtimeRevision],
      ]),
    });
    void adopting.catch(() => undefined);
    let binding: ReturnType<OpensteerStore["acquireExecutionBinding"]> | undefined;
    try {
      await barrier.reached;
      binding = store.acquireExecutionBinding({
        bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
        continuationIdentity: replacement,
        harnessInstanceId: fixture.harnessInstance.id,
        leaseTokenHash: "catalog-binding-order",
        runnerBootId: "catalog-binding-order",
        runnerId: fixture.runnerId,
        runId: turn.run.id,
        threadId: fixture.thread.id,
      });
      void binding.catch(() => undefined);
      await expect
        .poll(async () =>
          (
            await sql<{
              query: string;
            }>`select query from pg_stat_activity where datname=current_database() and application_name='opensteer-integration-test' and wait_event_type='Lock'`.execute(
              database,
            )
          ).rows.some(({ query }) => query.includes('from "harness_instances"')),
        )
        .toBe(true);
      barrier.release();
      const results = await Promise.allSettled([adopting, binding]);
      expect(barrier.conflicts).toEqual([]);
      expect(results.filter(({ status }) => status === "rejected")).toEqual([]);
      expect(await store.getThreadForOwner(fixture.thread.id, fixture.userId)).toMatchObject({
        continuationIdentity: replacement,
      });
    } finally {
      barrier.release();
      await Promise.allSettled([adopting, binding]);
    }
  });
  it("moves Threads onto a superseded continuation identity's replacement", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, store } = storeFixture;
    const fixture = await createRunFixture("catalog-supersede");
    const supersededKey = testContinuationIdentity.continuationKey;
    const replacement = {
      continuationKey: "runner:v1:XBFO4gDBdSg2fXioCLyTd-RGpc_Zcz838BvyfVUY5d0",
      driverKind: HarnessIdSchema.parse("native"),
    };
    const turn = await enqueueHumanTrigger({
      content: [
        {
          text: "Start the Thread",
          type: "text",
        },
      ],
      idempotencyKey: "catalog-supersede-first",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    await store.claimCommand(turn.command.id, "catalog-supersede-dispatcher");
    await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: fixture.harnessInstance.id,
      leaseTokenHash: "catalog-supersede-lease",
      runnerBootId: "catalog-supersede-boot",
      runnerId: fixture.runnerId,
      runId: turn.run.id,
      threadId: fixture.thread.id,
    });
    const models = [
      {
        displayName: "GPT-5.6 Sol",
        isDefault: true,
        modelId: "gpt-5.6-sol",
        options: [],
        providerId: "openai",
      },
    ];
    const laptopEnvironmentId = await store.createEnvironment({
      kind: "local",
      name: "Laptop",
    });
    const laptopHarness = await store.createHarnessInstance({
      config: {
        model: "test",
      },
      driverKind: HarnessIdSchema.parse("native"),
      environmentId: laptopEnvironmentId,
      name: "Native",
      stateKind: "isolated",
    });
    const codexHarness = await store.createHarnessInstance({
      config: {
        model: "test",
      },
      driverKind: HarnessIdSchema.parse("codex"),
      environmentId: fixture.environmentId,
      name: "Codex",
      stateKind: "isolated",
    });
    // A retired key is only ever retired by the store that owned it: another
    // work location, or another driver, must not drag this Thread anywhere.
    await store.recordHarnessCatalogs({
      catalogs: [
        HarnessInstanceCatalogSchema.parse({
          continuationIdentity: replacement,
          driverKind: "native",
          harnessInstanceId: laptopHarness.id,
          models,
          status: "ready",
          supersededContinuationIdentities: [supersededKey],
        }),
      ],
      environmentId: laptopEnvironmentId,
      expectedRevisions: new Map([[laptopHarness.id, laptopHarness.runtimeRevision]]),
    });
    await store.recordHarnessCatalogs({
      catalogs: [
        HarnessInstanceCatalogSchema.parse({
          continuationIdentity: {
            continuationKey: "runner:v1:8tErnQuB1d-nw979Rab9a4JN0RE_tKRvI_Rtmy45Bbo",
            driverKind: "codex",
          },
          driverKind: "codex",
          harnessInstanceId: codexHarness.id,
          models,
          status: "ready",
          supersededContinuationIdentities: [supersededKey],
        }),
      ],
      environmentId: fixture.environmentId,
      expectedRevisions: new Map([[codexHarness.id, codexHarness.runtimeRevision]]),
    });
    await expect(store.getThreadForOwner(fixture.thread.id, fixture.userId)).resolves.toMatchObject(
      {
        continuationIdentity: testContinuationIdentity,
      },
    );
    const catalog = HarnessInstanceCatalogSchema.parse({
      continuationIdentity: replacement,
      driverKind: "native",
      harnessInstanceId: fixture.harnessInstance.id,
      models,
      status: "ready",
      supersededContinuationIdentities: [supersededKey],
    });
    await store.recordHarnessCatalogs({
      catalogs: [catalog],
      environmentId: fixture.environmentId,
      expectedRevisions: new Map([
        [fixture.harnessInstance.id, fixture.harnessInstance.runtimeRevision],
      ]),
    });
    // Recording is the only path a Runner's answer becomes durable, so it also
    // has to be safe to repeat.
    await store.recordHarnessCatalogs({
      catalogs: [catalog],
      environmentId: fixture.environmentId,
      expectedRevisions: new Map([
        [fixture.harnessInstance.id, fixture.harnessInstance.runtimeRevision],
      ]),
    });
    await expect(store.getThreadForOwner(fixture.thread.id, fixture.userId)).resolves.toMatchObject(
      {
        continuationIdentity: replacement,
      },
    );
  });
  it("pins an admitted Run while an explicit native-session switch races it", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, store, database } = storeFixture;
    const fixture = await createRunFixture("session-switch-admission");
    const firstSessionId = fixture.thread.providerSessionId;
    expect(firstSessionId).not.toBeNull();
    const admitted = await enqueueHumanTrigger({
      content: [
        {
          text: "Already admitted",
          type: "text",
        },
      ],
      idempotencyKey: "session-switch-admitted",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    expect(admitted.run.providerSessionId).toBe(firstSessionId);
    const claude = await store.createHarnessInstance({
      config: {
        model: "sonnet",
        modelProviderId: "anthropic",
      },
      driverKind: HarnessIdSchema.parse("claude"),
      environmentId: fixture.environmentId,
      name: "Session switch Claude",
      stateKind: "isolated",
    });
    const change = {
      continuation: {
        expectedProviderSessionId: firstSessionId,
      },
      continuationIdentity: {
        continuationKey: "runner:v1:XBFO4gDBdSg2fXioCLyTd-RGpc_Zcz838BvyfVUY5d0",
        driverKind: HarnessIdSchema.parse("claude"),
      },
      harnessInstanceId: claude.id,
      idempotencyKey: "session-switch-apply",
      modelSelection: ModelSelectionSchema.parse({
        modelId: "sonnet",
        options: {},
        providerId: "anthropic",
      }),
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    };
    await expect(store.updateThreadExecutionSelection(change)).rejects.toMatchObject({
      code: "conflict",
    });
    const retained = await store.getThreadForOwner(fixture.thread.id, fixture.userId);
    expect(retained?.providerSessionId).toBe(firstSessionId);
    expect(retained?.harnessInstanceId).toBe(fixture.harnessInstance.id);
    const persistedRun = await database
      .selectFrom("runs")
      .select(["providerSessionId", "status"])
      .where("id", "=", admitted.run.id)
      .executeTakeFirstOrThrow();
    expect(persistedRun).toEqual({
      providerSessionId: firstSessionId,
      status: "queued",
    });
  });
  it("refuses idempotent Thread and execution-selection replays after the personal owner is disabled", async ({
    storeFixture,
  }) => {
    const { createRunFixture, store, database } = storeFixture;
    const fixture = await createRunFixture("replay-revoked-access");
    const create = {
      createdBy: fixture.userId,
      environmentId: fixture.environmentId,
      harnessInstanceId: fixture.harnessInstance.id,
      idempotencyKey: "replay-revoked-create",
      modelSelection: testModelSelection,
      title: "Revoked replay target",
    };
    const created = await store.createThread(create);
    const selection = {
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: fixture.harnessInstance.id,
      idempotencyKey: "replay-revoked-selection",
      modelSelection: testModelSelection,
      requestedBy: fixture.userId,
      threadId: created.thread.id,
    };
    await store.updateThreadExecutionSelection(selection);
    await expect(store.findThreadCreationByIdempotency(create)).resolves.toMatchObject({
      thread: {
        id: created.thread.id,
      },
      wasDuplicate: true,
    });
    await expect(store.createThread(create)).resolves.toMatchObject({
      wasDuplicate: true,
    });
    await expect(store.updateThreadExecutionSelection(selection)).resolves.toMatchObject({
      wasDuplicate: true,
    });

    // A committed access change between Host admission and store replay must
    // win over the earlier idempotency receipt.
    await database
      .updateTable("users")
      .set({ disabledAt: new Date() })
      .where("id", "=", fixture.userId)
      .execute();
    await expect(store.findThreadCreationByIdempotency(create)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(store.createThread(create)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(store.updateThreadExecutionSelection(selection)).rejects.toMatchObject({
      code: "forbidden",
    });
  });
  it("keeps node detail out of parent history and pages it only for its own Thread", async ({
    storeFixture,
  }) => {
    const { startRunFixture, enqueueHumanTrigger, store, database } = storeFixture;
    const fixture = await startRunFixture("node-detail");
    const sibling = await store.createThread({
      createdBy: fixture.userId,
      environmentId: fixture.environmentId,
      harnessInstanceId: fixture.harnessInstance.id,
      idempotencyKey: "node-detail-sibling",
      modelSelection: testModelSelection,
      title: "Sibling",
    });
    const turn = await enqueueHumanTrigger({
      content: [
        {
          type: "text",
          text: "Other Run",
        },
      ],
      idempotencyKey: "node-detail-other-run",
      requestedBy: fixture.userId,
      threadId: sibling.thread.id,
    });
    await store.claimCommand(turn.command.id, "node-detail-other-dispatcher");
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: fixture.harnessInstance.id,
      leaseTokenHash: "node-detail-other-lease",
      runnerBootId: fixture.runnerBootId,
      runnerId: fixture.runnerId,
      runId: turn.run.id,
      threadId: sibling.thread.id,
    });
    const other = {
      ...fixture,
      thread: sibling.thread,
      run: turn.run,
      bindingGeneration: binding.bindingGeneration,
    };
    await store.commitRunnerEvent({
      environmentId: other.environmentId,
      runnerId: other.runnerId,
      runnerBootId: other.runnerBootId,
      event: pendingEvent({
        type: "run.started",
        data: {
          status: "running",
        },
        ordinal: 0,
        bindingGeneration: other.bindingGeneration,
        environmentId: other.environmentId,
        runId: other.run.id,
        threadId: other.thread.id,
      }),
    });
    let ordinal = 1;
    type RunEvent = {
      [K in PendingAgentEvent["type"]]: Pick<
        Extract<
          PendingAgentEvent,
          {
            type: K;
          }
        >,
        "type" | "data"
      >;
    }[PendingAgentEvent["type"]];
    const emit = async (event: RunEvent) => {
      const result = await store.commitRunnerEvent({
        environmentId: fixture.environmentId,
        runnerId: fixture.runnerId,
        runnerBootId: fixture.runnerBootId,
        event: pendingEvent({
          ...event,
          ordinal,
          runId: fixture.run.id,
          threadId: fixture.thread.id,
          environmentId: fixture.environmentId,
          bindingGeneration: fixture.bindingGeneration,
        }),
      });
      ordinal += 1;
      return result;
    };
    const nodeId = createId("executionNode");
    const workflowId = createId("executionNode");
    for (const [id, kind] of [
      [nodeId, "subagent"],
      [workflowId, "workflow"],
    ] as const) {
      await emit({
        type: "node.started",
        data: {
          nodeId: id,
          kind,
          effort: "high",
          model: "research-model",
          phaseIndex: 0,
          nativeRef: id,
          sessionRef: null,
          originCallId: null,
          parentNodeId: null,
          prompt: "Research",
          title: "Research",
        },
      });
    }
    await emit({
      type: "node.updated",
      data: {
        nodeId,
        parentNodeId: workflowId,
      },
    });
    await emit({
      type: "node.updated",
      data: {
        nodeId: workflowId,
        phases: ["Research", "Review"],
        effort: "medium",
      },
    });
    await expect(
      emit({
        type: "node.updated",
        data: {
          nodeId,
          parentNodeId: workflowId,
        },
      }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      emit({
        type: "node.updated",
        data: {
          nodeId: workflowId,
          parentNodeId: nodeId,
        },
      }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    const foreignNodeId = createId("executionNode");
    await store.commitRunnerEvent({
      environmentId: other.environmentId,
      runnerId: other.runnerId,
      runnerBootId: other.runnerBootId,
      event: pendingEvent({
        type: "node.started",
        bindingGeneration: other.bindingGeneration,
        ordinal: 1,
        runId: other.run.id,
        threadId: other.thread.id,
        environmentId: other.environmentId,
        data: {
          nodeId: foreignNodeId,
          kind: "subagent",
          model: null,
          title: "Other",
          nativeRef: "other",
          parentNodeId: null,
          originCallId: null,
          sessionRef: null,
          prompt: null,
        },
      }),
    });
    for (const event of [
      {
        type: "node.message",
        data: {
          nodeId: foreignNodeId,
          text: "Foreign",
        },
      },
      {
        type: "reasoning.completed",
        data: {
          nodeId: foreignNodeId,
          blockId: "foreign",
          text: "Foreign",
        },
      },
      {
        type: "node.updated",
        data: {
          nodeId: workflowId,
          parentNodeId: foreignNodeId,
        },
      },
    ] as const)
      await expect(emit(event)).rejects.toMatchObject({
        code: "conflict",
      });
    const detail = [
      {
        type: "node.message",
        data: {
          nodeId,
          text: "I found the answer",
        },
      },
      {
        type: "reasoning.completed",
        data: {
          nodeId,
          blockId: "thinking",
          text: "Check the source",
        },
      },
      {
        type: "tool.started",
        data: {
          nodeId,
          callId: "child-call",
          tool: {
            namespace: "test",
            name: "read",
          },
          arguments: {},
        },
      },
      {
        type: "tool.completed",
        data: {
          nodeId,
          callId: "child-call",
          isError: false,
          output: {
            text: "Source",
          },
        },
      },
    ] as const;
    for (const event of detail) await emit(event);
    await emit({
      type: "node.completed",
      data: {
        nodeId,
        status: "completed",
        result: "Answer",
        usage: null,
      },
    });
    const stored = await database
      .selectFrom("deploymentEvents")
      .selectAll()
      .where("runId", "=", fixture.run.id)
      .where("nodeDetailId", "=", nodeId)
      .orderBy("sequence", "asc")
      .execute();
    expect(stored.map((row) => row.type)).toEqual(detail.map((event) => event.type));
    const read = {
      ownerId: fixture.userId,
      threadId: fixture.thread.id,
    };
    for (const mode of [
      {},
      {
        maxTurns: 1,
      },
      {
        aroundMessageId: fixture.run.seedInputId,
      },
    ] as const) {
      const page = await store.threadEventPageForOwner({
        ...read,
        ...mode,
      });
      expect(page!.events.some((event) => nodeDetailEventNodeId(event) !== undefined)).toBe(false);
      expect(page!.events.map((event) => event.type)).toEqual(
        expect.arrayContaining(["node.started", "node.completed"]),
      );
      expect(page!.window.itemCount).toBe(page!.events.length);
      expect(page!.window.byteCount).toBe(Buffer.byteLength(JSON.stringify(page!.events)));
    }
    const page = await store.nodeEventPageForOwner({
      ...read,
      nodeId,
    });
    expect(
      page!.events.map((event) => ({
        type: event.type,
        data: event.data,
      })),
    ).toEqual(detail);
    // The subagent itself comes with its page, whatever its conversation's history holds.
    expect(page!.node.id).toBe(nodeId);
    expect(page!.window).toMatchObject({
      itemCount: 4,
      totalItems: 4,
      hasMore: false,
      byteCount: Buffer.byteLength(JSON.stringify(page!.events)),
    });
    const through = page!.events[2]!.sequence;
    const newest = await store.nodeEventPageForOwner({
      ...read,
      nodeId,
      through,
      maxItems: 2,
    });
    expect(newest!.events).toEqual(page!.events.slice(1, 3));
    expect(newest!.window).toMatchObject({
      hasMore: true,
      totalItems: 3,
    });
    const older = await store.nodeEventPageForOwner({
      ...read,
      nodeId,
      through,
      before: newest!.window.nextBefore!,
      maxItems: 2,
    });
    expect(older!.events).toEqual(page!.events.slice(0, 1));
    expect(older!.window.hasMore).toBe(false);
    await expect(
      store.nodeEventPageForOwner({
        ...read,
        threadId: sibling.thread.id,
        nodeId,
      }),
    ).resolves.toBeNull();
    await expect(
      store.nodeEventPageForOwner({
        ...read,
        ownerId: await store.createUser("Outsider"),
        nodeId,
      }),
    ).resolves.toBeNull();
    const nodes = (await store.listRunAttemptsForOwner({
      ownerId: fixture.userId,
      runId: fixture.run.id,
    }))!.nodes;
    expect(nodes.find((node) => node.id === nodeId)).toMatchObject({
      effort: "high",
      phaseIndex: 0,
      phases: [],
      parentNodeId: workflowId,
    });
    expect(nodes.find((node) => node.id === workflowId)).toMatchObject({
      kind: "workflow",
      effort: "medium",
      phases: ["Research", "Review"],
      parentNodeId: null,
    });
  });
  it("anchors an event page on a delivered message and retains nearby Run events", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store } = storeFixture;
    const fixture = await startRunFixture("event-message-anchor");
    const page = await store.threadEventPageForOwner({
      aroundMessageId: fixture.run.seedInputId,
      maxItems: 20,
      ownerId: fixture.userId,
      threadId: fixture.thread.id,
    });
    expect(page?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "message.placed",
          runId: fixture.run.id,
        }),
        expect.objectContaining({
          type: "run.started",
          runId: fixture.run.id,
        }),
      ]),
    );
    expect(page?.events.map((event) => event.sequence)).toEqual(
      [...(page?.events ?? [])]
        .map((event) => event.sequence)
        .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0)),
    );
    expect(page?.thread.id).toBe(fixture.thread.id);
    expect(page?.thread.providerSessionId).toBe(fixture.thread.providerSessionId);
    const anchor = page?.events.find((event) => event.type === "message.placed");
    expect(anchor).toBeDefined();
    const anchorBytes = Buffer.byteLength(JSON.stringify([anchor]), "utf8");
    const bounded = await store.threadEventPageForOwner({
      aroundMessageId: fixture.run.seedInputId,
      maxBytes: anchorBytes,
      maxItems: 20,
      ownerId: fixture.userId,
      threadId: fixture.thread.id,
    });
    expect(bounded?.events).toContainEqual(anchor);
    await expect(
      store.threadEventPageForOwner({
        aroundMessageId: fixture.run.seedInputId,
        maxBytes: anchorBytes - 1,
        maxItems: 20,
        ownerId: fixture.userId,
        threadId: fixture.thread.id,
      }),
    ).rejects.toMatchObject({
      code: "internal",
    });
  });
  it("anchors steer history on a rendered Message rather than its later delivery receipt", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store } = storeFixture;
    const fixture = await startRunFixture("steer-message-anchor");
    const steered = await store.enqueueThreadInput({
      content: [
        {
          text: "Use this constraint",
          type: "text",
        },
      ],
      idempotencyKey: "steer-message-anchor-input",
      policy: "steer",
      requestedBy: fixture.userId,
      source: {
        kind: "human",
      },
      threadId: fixture.thread.id,
    });
    if (!steered.command) throw new Error("Expected steer command");
    await store.claimCommand(steered.command.id, "steer-message-anchor-dispatcher");
    await store.commitRunnerEvent({
      environmentId: fixture.environmentId,
      event: pendingEvent({
        bindingGeneration: fixture.bindingGeneration,
        data: {
          messageId: steered.message.id,
        },
        environmentId: fixture.environmentId,
        ordinal: 1,
        runId: fixture.run.id,
        threadId: fixture.thread.id,
        type: "message.injected",
      }),
      runnerBootId: fixture.runnerBootId,
      runnerId: fixture.runnerId,
    });
    const page = await store.threadEventPageForOwner({
      aroundMessageId: steered.message.id,
      maxItems: 1,
      ownerId: fixture.userId,
      threadId: fixture.thread.id,
    });
    expect(page?.events).toHaveLength(1);
    expect(["message.created", "message.placed"]).toContain(page?.events[0]?.type);
    expect(page?.events[0]?.data).toMatchObject({
      message: {
        id: steered.message.id,
      },
    });
  });
  it("keeps a frozen handoff after native reference creation but before first acceptance", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, enqueueHumanTrigger } = storeFixture;
    const fixture = await startRunFixture("first-context-crash");
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
    const claude = await store.createHarnessInstance({
      config: {
        model: "sonnet",
        modelProviderId: "anthropic",
      },
      driverKind: HarnessIdSchema.parse("claude"),
      environmentId: fixture.environmentId,
      name: "Handoff Claude",
      stateKind: "isolated",
    });
    const switched = await store.updateThreadExecutionSelection({
      continuation: {
        expectedProviderSessionId: fixture.thread.providerSessionId,
      },
      continuationIdentity: {
        continuationKey: "runner:v1:XBFO4gDBdSg2fXioCLyTd-RGpc_Zcz838BvyfVUY5d0",
        driverKind: HarnessIdSchema.parse("claude"),
      },
      harnessInstanceId: claude.id,
      idempotencyKey: "first-context-switch",
      modelSelection: ModelSelectionSchema.parse({
        modelId: "sonnet",
        options: {},
        providerId: "anthropic",
      }),
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    expect(switched.thread.id).toBe(fixture.thread.id);
    expect(switched.thread.providerSessionId).not.toBe(fixture.thread.providerSessionId);
    const first = await enqueueHumanTrigger({
      content: [
        {
          text: "Continue in Claude",
          type: "text",
        },
      ],
      idempotencyKey: "first-context-input",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    expect(first.run.providerSessionId).toBe(switched.thread.providerSessionId);
    await store.claimCommand(first.command.id, "first-context-dispatcher");
    const beforeNativeStart = await store.loadRunDispatchContext(first.command.id);
    expect(beforeNativeStart.initialContext?.messages.map((message) => message.id)).toContain(
      fixture.run.seedInputId,
    );
    expect(beforeNativeStart.initialContext?.messages.map((message) => message.id)).not.toContain(
      first.run.seedInputId,
    );
    const identity = {
      continuationKey: "runner:v1:XBFO4gDBdSg2fXioCLyTd-RGpc_Zcz838BvyfVUY5d0",
      driverKind: HarnessIdSchema.parse("claude"),
    };
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: identity,
      harnessInstanceId: claude.id,
      leaseTokenHash: "first-context-lease",
      runnerBootId: "first-context-boot",
      runnerId: fixture.runnerId,
      runId: first.run.id,
      threadId: fixture.thread.id,
    });
    await store.bindProviderSession({
      bindingGeneration: binding.bindingGeneration,
      harnessInstanceId: claude.id,
      providerSessionId: binding.providerSessionId,
      providerSessionReference: "allocated-before-first-input",
      runId: first.run.id,
      runnerBootId: "first-context-boot",
      runnerId: fixture.runnerId,
      threadId: fixture.thread.id,
    });
    const afterNativeStart = await store.loadRunDispatchContext(first.command.id);
    expect(afterNativeStart.initialContext).toEqual(beforeNativeStart.initialContext);
    expect(afterNativeStart.executionBinding?.providerSessionReference).toBe(
      "allocated-before-first-input",
    );
  });
  it("finalizes a frozen initial context once from ordered candidates", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, enqueueHumanTrigger } = storeFixture;
    const fixture = await startRunFixture("finalized-initial-context");
    const assistantMessageId = createId("message");
    await store.commitRunnerEvent({
      environmentId: fixture.environmentId,
      event: pendingEvent({
        bindingGeneration: fixture.bindingGeneration,
        data: {
          content: [
            {
              text: "Earlier assistant answer",
              type: "text",
            },
          ],
          messageId: assistantMessageId,
        },
        environmentId: fixture.environmentId,
        ordinal: 1,
        runId: fixture.run.id,
        threadId: fixture.thread.id,
        type: "assistant.message",
      }),
      runnerBootId: fixture.runnerBootId,
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
        ordinal: 2,
        runId: fixture.run.id,
        threadId: fixture.thread.id,
        type: "run.completed",
      }),
      runnerBootId: fixture.runnerBootId,
      runnerId: fixture.runnerId,
    });
    const claude = await store.createHarnessInstance({
      config: {
        model: "sonnet",
        modelProviderId: "anthropic",
      },
      driverKind: HarnessIdSchema.parse("claude"),
      environmentId: fixture.environmentId,
      name: "Context finalization Claude",
      stateKind: "isolated",
    });
    await store.updateThreadExecutionSelection({
      continuation: {
        expectedProviderSessionId: fixture.thread.providerSessionId,
      },
      continuationIdentity: {
        continuationKey: "runner:v1:XBFO4gDBdSg2fXioCLyTd-RGpc_Zcz838BvyfVUY5d0",
        driverKind: HarnessIdSchema.parse("claude"),
      },
      harnessInstanceId: claude.id,
      idempotencyKey: "finalized-context-switch",
      modelSelection: ModelSelectionSchema.parse({
        modelId: "sonnet",
        options: {},
        providerId: "anthropic",
      }),
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    const next = await enqueueHumanTrigger({
      content: [
        {
          text: "Continue with less context",
          type: "text",
        },
      ],
      idempotencyKey: "finalized-context-next",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    await store.claimCommand(next.command.id, "finalized-context-dispatcher");
    const before = (await store.loadRunDispatchContext(next.command.id)).initialContext;
    expect(before?.finalized).toBe(false);
    expect(before?.messages.map((message) => message.id)).toEqual([
      fixture.run.seedInputId,
      assistantMessageId,
    ]);
    await expect(
      store.finalizeRunInitialContext({
        commandId: next.command.id,
        messageIds: [assistantMessageId, fixture.run.seedInputId],
      }),
    ).rejects.toMatchObject({
      code: "bad_request",
    });
    await expect(
      store.finalizeRunInitialContext({
        commandId: next.command.id,
        messageIds: [createId("message")],
      }),
    ).rejects.toMatchObject({
      code: "bad_request",
    });
    const finalized = await store.finalizeRunInitialContext({
      commandId: next.command.id,
      messageIds: [assistantMessageId],
    });
    expect(finalized).toEqual({
      finalized: true,
      messages: [
        expect.objectContaining({
          id: assistantMessageId,
        }),
      ],
      omittedCount: before!.omittedCount + 1,
      throughSequence: before!.throughSequence,
    });
    expect(
      await store.finalizeRunInitialContext({
        commandId: next.command.id,
        messageIds: [fixture.run.seedInputId],
      }),
    ).toEqual(finalized);
    expect((await store.loadRunDispatchContext(next.command.id)).initialContext).toEqual(finalized);
  });
  it("keeps a compatible native continuation across model selection changes", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, store, database } = storeFixture;
    const fixture = await createRunFixture("execution-selection");
    const first = await enqueueHumanTrigger({
      content: [
        {
          text: "Use the initial selection",
          type: "text",
        },
      ],
      idempotencyKey: "execution-selection-first",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    expect(first.run).toMatchObject({
      environmentId: fixture.environmentId,
      harnessInstanceId: fixture.harnessInstance.id,
      modelSelection: testModelSelection,
    });
    await store.claimCommand(first.command.id, "execution-selection-dispatcher");
    const firstBinding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: fixture.harnessInstance.id,
      leaseTokenHash: "execution-selection-lease",
      runnerBootId: "execution-selection-boot",
      runnerId: fixture.runnerId,
      runId: first.run.id,
      threadId: fixture.thread.id,
    });
    await store.bindProviderSession({
      bindingGeneration: firstBinding.bindingGeneration,
      harnessInstanceId: fixture.harnessInstance.id,
      providerSessionId: firstBinding.providerSessionId,
      providerSessionReference: "native-session-1",
      runId: first.run.id,
      runnerBootId: "execution-selection-boot",
      runnerId: fixture.runnerId,
      threadId: fixture.thread.id,
    });
    await store.commitRunnerEvent({
      environmentId: fixture.environmentId,
      event: pendingEvent({
        bindingGeneration: firstBinding.bindingGeneration,
        data: {
          status: "running",
        },
        environmentId: fixture.environmentId,
        ordinal: 0,
        runId: first.run.id,
        threadId: fixture.thread.id,
        type: "run.started",
      }),
      runnerBootId: "execution-selection-boot",
      runnerId: fixture.runnerId,
    });
    await store.failCommand(first.command.id, "Initial selection finished unsuccessfully.");
    const claude = await store.createHarnessInstance({
      config: {
        model: "sonnet",
        modelProviderId: "anthropic",
      },
      driverKind: HarnessIdSchema.parse("claude"),
      environmentId: fixture.environmentId,
      name: "Claude Code",
      stateKind: "isolated",
    });
    const claudeSelection = ModelSelectionSchema.parse({
      modelId: "sonnet",
      options: {
        effort: "high",
      },
      providerId: "anthropic",
    });
    await expect(
      store.updateThreadExecutionSelection({
        continuationIdentity: {
          continuationKey: "runner:v1:XBFO4gDBdSg2fXioCLyTd-RGpc_Zcz838BvyfVUY5d0",
          driverKind: HarnessIdSchema.parse("claude"),
        },
        harnessInstanceId: claude.id,
        idempotencyKey: "execution-selection-incompatible",
        modelSelection: claudeSelection,
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    const foreignEnvironmentId = await store.createEnvironment({
      kind: "local",
      name: "Other computer",
    });
    const foreignHarness = await store.createHarnessInstance({
      config: {},
      driverKind: HarnessIdSchema.parse("native"),
      environmentId: foreignEnvironmentId,
      name: "Other computer Native",
      stateKind: "ambient",
    });
    await expect(
      store.updateThreadExecutionSelection({
        continuationIdentity: testContinuationIdentity,
        harnessInstanceId: foreignHarness.id,
        idempotencyKey: "execution-selection-foreign-environment",
        modelSelection: testModelSelection,
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      }),
    ).rejects.toMatchObject({
      code: "bad_request",
    });
    await expect(
      store.createThread({
        createdBy: fixture.userId,
        environmentId: fixture.environmentId,
        harnessInstanceId: foreignHarness.id,
        idempotencyKey: "execution-selection-cross-environment",
        modelSelection: testModelSelection,
        title: "Invalid environment binding",
      }),
    ).rejects.toMatchObject({
      code: "bad_request",
    });
    const compatible = await store.createHarnessInstance({
      config: {
        model: "gpt-5.6-sol",
      },
      driverKind: HarnessIdSchema.parse("native"),
      environmentId: fixture.environmentId,
      name: "Compatible Native",
      stateKind: "isolated",
    });
    const updated = await store.updateThreadExecutionSelection({
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: compatible.id,
      idempotencyKey: "execution-selection-compatible",
      modelSelection: testModelSelection,
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    expect(updated.thread).toMatchObject({
      continuationIdentity: testContinuationIdentity,
      environmentId: fixture.environmentId,
      harnessInstanceId: compatible.id,
      modelSelection: testModelSelection,
      status: "failed",
    });
    await expect(
      database
        .selectFrom("providerSessions")
        .select(["active", "harnessInstanceId", "providerSessionReference", "status"])
        .where("threadId", "=", fixture.thread.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      active: true,
      harnessInstanceId: compatible.id,
      providerSessionReference: "native-session-1",
      status: "broken",
    });
    const second = await enqueueHumanTrigger({
      content: [
        {
          text: "Use the new selection",
          type: "text",
        },
      ],
      idempotencyKey: "execution-selection-second",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    expect(second.run).toMatchObject({
      environmentId: fixture.environmentId,
      harnessInstanceId: compatible.id,
      modelSelection: testModelSelection,
    });
    await store.claimCommand(second.command.id, "execution-selection-dispatcher");
    const secondBinding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: compatible.id,
      leaseTokenHash: "execution-selection-second-lease",
      runnerBootId: "execution-selection-boot",
      runnerId: fixture.runnerId,
      runId: second.run.id,
      threadId: fixture.thread.id,
    });
    expect(secondBinding).toMatchObject({
      bindingGeneration: firstBinding.bindingGeneration + 1,
      providerSessionId: firstBinding.providerSessionId,
      providerSessionReference: "native-session-1",
    });
    await expect(
      store.commitRunnerEvent({
        environmentId: fixture.environmentId,
        event: pendingEvent({
          bindingGeneration: secondBinding.bindingGeneration,
          data: {
            status: "running",
          },
          environmentId: fixture.environmentId,
          ordinal: 0,
          runId: second.run.id,
          threadId: fixture.thread.id,
          type: "run.started",
        }),
        runnerBootId: "execution-selection-boot",
        runnerId: fixture.runnerId,
      }),
    ).resolves.toMatchObject({
      wasDuplicate: false,
    });
    expect(first.run).toMatchObject({
      harnessInstanceId: fixture.harnessInstance.id,
      modelSelection: testModelSelection,
    });
    await expect(
      store.updateThreadExecutionSelection({
        continuationIdentity: testContinuationIdentity,
        harnessInstanceId: fixture.harnessInstance.id,
        idempotencyKey: "execution-selection-busy",
        modelSelection: testModelSelection,
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
  });

  // Only a bound Run can have reached a Runner: a Host failure before the
  // binding proves dispatch never began, while one after it is ambiguous.
  it.for([false, true])(
    "refuses a later start only after an ambiguous Host failure (binding created: %s)",
    async (createBinding, { storeFixture }) => {
      const { createRunFixture, enqueueHumanTrigger, store } = storeFixture;
      const fixture = await createRunFixture("unstarted-retry");
      const first = await enqueueHumanTrigger({
        content: [
          {
            text: "First attempt",
            type: "text",
          },
        ],
        idempotencyKey: "unstarted-first",
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      const bindingInput = {
        bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
        continuationIdentity: testContinuationIdentity,
        harnessInstanceId: fixture.harnessInstance.id,
        leaseTokenHash: "unstarted-lease",
        runnerBootId: "unstarted-boot",
        runnerId: fixture.runnerId,
        threadId: fixture.thread.id,
      };
      await store.claimCommand(first.command.id, "test");
      if (createBinding)
        await store.acquireExecutionBinding({
          ...bindingInput,
          runId: first.run.id,
        });
      await store.failCommand(
        first.command.id,
        "Workspace mount unavailable before engine startup",
      );
      const retry = await enqueueHumanTrigger({
        content: [
          {
            text: "Retry",
            type: "text",
          },
        ],
        idempotencyKey: "unstarted-retry",
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      await store.claimCommand(retry.command.id, "test");
      const started = store.acquireExecutionBinding({
        ...bindingInput,
        runId: retry.run.id,
      });
      if (createBinding) await expect(started).rejects.toThrow("uncertain native start");
      else
        await expect(started).resolves.toMatchObject({
          runnerBootId: "unstarted-boot",
        });
    },
  );
  it("refuses an unknown first delivery after its native reference was minted", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, store, database } = storeFixture;
    const fixture = await createRunFixture("minted-reference-unknown-delivery");
    const first = await enqueueHumanTrigger({
      content: [
        {
          text: "First delivery may have begun",
          type: "text",
        },
      ],
      idempotencyKey: "minted-reference-first",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    const bindingInput = {
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: testContinuationIdentity,
      harnessInstanceId: fixture.harnessInstance.id,
      leaseTokenHash: "minted-reference-lease",
      runnerBootId: "minted-reference-boot",
      runnerId: fixture.runnerId,
      threadId: fixture.thread.id,
    };
    await store.claimCommand(first.command.id, "test");
    const firstBinding = await store.acquireExecutionBinding({
      ...bindingInput,
      runId: first.run.id,
    });
    await store.bindProviderSession({
      bindingGeneration: firstBinding.bindingGeneration,
      harnessInstanceId: fixture.harnessInstance.id,
      providerSessionId: firstBinding.providerSessionId,
      providerSessionReference: "minted-before-acceptance",
      runId: first.run.id,
      runnerBootId: bindingInput.runnerBootId,
      runnerId: fixture.runnerId,
      threadId: fixture.thread.id,
    });
    await store.failCommand(first.command.id, "Runner acknowledgement was lost");
    const retry = await enqueueHumanTrigger({
      content: [
        {
          text: "Continue after uncertainty",
          type: "text",
        },
      ],
      idempotencyKey: "minted-reference-retry",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    await store.claimCommand(retry.command.id, "test");
    await expect(
      store.acquireExecutionBinding({
        ...bindingInput,
        runId: retry.run.id,
      }),
    ).rejects.toThrow("uncertain native start");
    const retained = await database
      .selectFrom("runs")
      .select(["providerSessionId", "status"])
      .where("id", "=", retry.run.id)
      .executeTakeFirstOrThrow();
    expect(retained).toEqual({
      providerSessionId: firstBinding.providerSessionId,
      status: "starting",
    });
  });
  it("commits a terminal Run while deferring a successor under corrupt engine selection", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, database } = storeFixture;
    const fixture = await startRunFixture("terminal-selection-corruption");
    const followUp = await store.enqueueThreadInput({
      content: [
        {
          text: "Wait for the current Run",
          type: "text",
        },
      ],
      idempotencyKey: "terminal-selection-follow-up",
      policy: "queue",
      requestedBy: fixture.userId,
      source: {
        kind: "human",
      },
      threadId: fixture.thread.id,
    });
    expect(followUp.run).toBeNull();
    const incompatible = await store.createHarnessInstance({
      config: {
        model: "sonnet",
        modelProviderId: "anthropic",
      },
      driverKind: HarnessIdSchema.parse("claude"),
      environmentId: fixture.environmentId,
      name: "Corrupt selection fixture",
      stateKind: "isolated",
    });
    await database
      .updateTable("threads")
      .set({
        harnessInstanceId: incompatible.id,
      })
      .where("id", "=", fixture.thread.id)
      .executeTakeFirstOrThrow();
    await expect(
      store.commitRunnerEvent({
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
      }),
    ).resolves.toMatchObject({
      wasDuplicate: false,
    });
    expect(
      await database
        .selectFrom("runs")
        .select("status")
        .where("id", "=", fixture.run.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      status: "completed",
    });
    expect(
      await database
        .selectFrom("threadInputs")
        .select("state")
        .where("messageId", "=", followUp.message.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      state: "pending",
    });
  });
  it.for(["run.failed", "run.interrupted"] as const)(
    "allows first startup after an ordered %s receipt without a provider session",
    async (type, { storeFixture }) => {
      const { createRunFixture, enqueueHumanTrigger, store } = storeFixture;
      const fixture = await createRunFixture("startup-receipt");
      const first = await enqueueHumanTrigger({
        content: [
          {
            text: "First",
            type: "text",
          },
        ],
        idempotencyKey: "receipt-first",
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      const bindingInput = {
        bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
        continuationIdentity: testContinuationIdentity,
        harnessInstanceId: fixture.harnessInstance.id,
        leaseTokenHash: "receipt-lease",
        runnerBootId: "receipt-boot",
        runnerId: fixture.runnerId,
        threadId: fixture.thread.id,
      };
      await store.claimCommand(first.command.id, "test");
      const binding = await store.acquireExecutionBinding({
        ...bindingInput,
        runId: first.run.id,
      });
      await store.commitRunnerEvent({
        environmentId: fixture.environmentId,
        runnerBootId: bindingInput.runnerBootId,
        runnerId: fixture.runnerId,
        event: pendingEvent({
          bindingGeneration: binding.bindingGeneration,
          environmentId: fixture.environmentId,
          ordinal: 0,
          runId: first.run.id,
          threadId: fixture.thread.id,
          type,
          data:
            type === "run.failed"
              ? {
                  code: "runner_execution_error",
                  message: "Mount failed",
                  status: "failed",
                  retryable: false,
                }
              : {
                  status: "interrupted",
                },
        }),
      });
      const retry = await enqueueHumanTrigger({
        content: [
          {
            text: "Retry",
            type: "text",
          },
        ],
        idempotencyKey: "receipt-retry",
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
      });
      await store.claimCommand(retry.command.id, "test");
      await expect(
        store.acquireExecutionBinding({
          ...bindingInput,
          runId: retry.run.id,
        }),
      ).resolves.toMatchObject({
        providerSessionReference: null,
      });
    },
  );
});
