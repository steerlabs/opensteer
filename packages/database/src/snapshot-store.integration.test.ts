import { recoverThreadWorkQueues } from "./execution-recovery.js";
import { AgentEventSchema } from "@opensteer/core";
import { finalizeRunTransaction } from "./run-finalization.js";
import { messageFromRow, threadInputFromRow } from "./thread-row-mappers.js";
import { jsonValue } from "./store-primitives.js";
import { sql, CompiledQuery, PostgresQueryCompiler, type KyselyPlugin } from "kysely";
import { conversationHistoryScanCap, conversationHistoryMetadata } from "./snapshot-store.js";
import { quietRunPredicate } from "./run-visibility.js";
import { createId, ModelSelectionSchema, type RunId, type MessageId } from "@opensteer/core";
import { expect } from "vitest";
import { OpensteerStore } from "./store.js";
import {
  describeStore,
  testModelSelection,
  testContinuationIdentity,
} from "./store.integration.test-support.js";

describeStore("Workspace snapshot history", (it) => {
  for (const status of ["completed", "failed", "interrupted"] as const) {
    it(`classifies quiet at the ${status} terminal transition`, async ({ storeFixture }) => {
      const { database, startRunFixture } = storeFixture;
      const f = await startRunFixture(`quiet-${status}`);
      await database
        .updateTable("messages")
        .set({
          author: {
            kind: "watch",
            displayName: "Watcher",
            activationId: createId("triggerWatchActivation"),
            revisionId: createId("triggerRevision"),
            triggerId: createId("trigger"),
          },
        })
        .where("id", "=", f.run.seedInputId)
        .execute();
      await database
        .updateTable("runs")
        .set({ personWaited: false })
        .where("id", "=", f.run.id)
        .execute();
      await database.transaction().execute((tx) =>
        finalizeRunTransaction(tx, {
          completedAt: new Date(),
          links: { threadUrl: (id) => `https://example.test/thread/${id}` },
          queuedInputCancellation: "seed-input",
          runId: f.run.id,
          source: "runner",
          status,
          ...(status === "failed"
            ? {
                failure: {
                  status: "failed" as const,
                  code: "test",
                  message: "Test failure",
                  retryable: false,
                },
              }
            : {}),
        }),
      );
      expect(
        await database
          .selectFrom("runs")
          .select(["status", "quiet"])
          .where("id", "=", f.run.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status, quiet: true });
    });
  }

  it("remembers a human hand-off returned to the queue at finalization", async ({
    storeFixture,
  }) => {
    const { database, store, startRunFixture } = storeFixture;
    const f = await startRunFixture("waited-returned-steer");
    await database
      .updateTable("threads")
      .set({ role: "conversation", inputQueuePaused: true, inputQueuePausedBy: f.userId })
      .where("id", "=", f.thread.id)
      .execute();
    await database
      .updateTable("messages")
      .set({
        author: {
          kind: "watch",
          displayName: "Watcher",
          activationId: createId("triggerWatchActivation"),
          revisionId: createId("triggerRevision"),
          triggerId: createId("trigger"),
        },
      })
      .where("id", "=", f.run.seedInputId)
      .execute();
    await database
      .updateTable("runs")
      .set({ personWaited: false })
      .where("id", "=", f.run.id)
      .execute();
    const queued = await store.enqueueThreadInput({
      content: [{ type: "text", text: "Please help" }],
      idempotencyKey: "waited-return",
      policy: "queue",
      requestedBy: f.userId,
      source: { kind: "human" },
      threadId: f.thread.id,
    });
    await database
      .updateTable("threads")
      .set({ inputQueuePaused: false, inputQueuePausedBy: null })
      .where("id", "=", f.thread.id)
      .execute();
    const steered = await store.steerThreadInput({
      threadId: f.thread.id,
      expectedRunId: f.run.id,
      messageId: queued.message.id,
      requestedBy: f.userId,
      idempotencyKey: "waited-steer",
    });
    expect(steered.command).not.toBeNull();
    await database
      .updateTable("threads")
      .set({ inputQueuePaused: true, inputQueuePausedBy: f.userId })
      .where("id", "=", f.thread.id)
      .execute();
    await database.transaction().execute((tx) =>
      finalizeRunTransaction(tx, {
        completedAt: new Date(),
        links: { threadUrl: (id) => `https://example.test/thread/${id}` },
        queuedInputCancellation: "seed-input",
        runId: f.run.id,
        source: "runner",
        status: "completed",
      }),
    );
    expect(
      await database
        .selectFrom("messages")
        .select("runId")
        .where("id", "=", queued.message.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ runId: null });
    expect(
      await database
        .selectFrom("runs")
        .select(["personWaited", "quiet"])
        .where("id", "=", f.run.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ personWaited: true, quiet: false });
  });

  it("classifies legacy report-driven queued Runs during recovery", async ({ storeFixture }) => {
    const { database, createRunFixture, enqueueHumanTrigger } = storeFixture;
    const f = await createRunFixture("quiet-legacy-report");
    const admitted = await enqueueHumanTrigger({
      content: [{ type: "text", text: "Legacy report" }],
      requestedBy: f.userId,
      idempotencyKey: "legacy-report",
      threadId: f.thread.id,
    });
    await database
      .updateTable("messages")
      .set({
        author: {
          kind: "watch",
          displayName: "Watcher",
          activationId: createId("triggerWatchActivation"),
          revisionId: createId("triggerRevision"),
          triggerId: createId("trigger"),
        },
      })
      .where("id", "=", admitted.run.seedInputId)
      .execute();
    await database
      .updateTable("runs")
      .set({ personWaited: false })
      .where("id", "=", admitted.run.id)
      .execute();
    await database
      .updateTable("threadInputs")
      .set({ policy: "report" })
      .where("messageId", "=", admitted.run.seedInputId)
      .execute();
    await recoverThreadWorkQueues(database);
    expect(
      await database
        .selectFrom("runs")
        .select(["status", "quiet"])
        .where("id", "=", admitted.run.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "interrupted", quiet: true });
  });

  it("keeps a human-seeded Run stopped before claim", async ({ storeFixture }) => {
    const { database, store, createRunFixture, enqueueHumanTrigger } = storeFixture;
    const f = await createRunFixture("human-stop-before-claim");
    const admitted = await enqueueHumanTrigger({
      content: [{ type: "text", text: "Please help" }],
      requestedBy: f.userId,
      idempotencyKey: "human-stop",
      threadId: f.thread.id,
    });
    await database.transaction().execute((tx) =>
      finalizeRunTransaction(tx, {
        completedAt: new Date(),
        links: { threadUrl: (id) => `https://example.test/thread/${id}` },
        queuedInputCancellation: "seed-input",
        runId: admitted.run.id,
        source: "host",
        status: "interrupted",
      }),
    );
    expect(
      await database
        .selectFrom("runs")
        .select(["quiet", "personWaited"])
        .where("id", "=", admitted.run.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ quiet: false, personWaited: true });
    expect(
      await store.threadEventPageForOwner({
        ownerId: f.userId,
        threadId: f.thread.id,
        maxTurns: 10,
        view: "conversation",
      }),
    ).not.toBeNull();
  });

  it("scans quiet watcher history for ten human turns and continues across an empty capped page", async ({
    storeFixture,
  }) => {
    const { database, store, startRunFixture } = storeFixture;
    const f = await startRunFixture("conversation-history");
    await database
      .updateTable("runs")
      .set({ status: "completed" })
      .where("id", "=", f.run.id)
      .execute();
    await database
      .updateTable("threads")
      .set({ role: "conversation" })
      .where("id", "=", f.thread.id)
      .execute();
    const humanIds: RunId[] = [];
    const quietIds: RunId[] = [];
    const quietMessageIds: MessageId[] = [];
    await database.transaction().execute(async (tx) => {
      const eventRows: Array<
        import("kysely").Insertable<import("./schema.js").WorkspaceEventTable>
      > = [];
      const clock = await tx
        .updateTable("workspaces")
        .set({ eventSequence: sql`event_sequence + 5000` })
        .where("id", "=", f.workspace.id)
        .returning("eventSequence")
        .executeTakeFirstOrThrow();
      let sequence = BigInt(clock.eventSequence) - 5000n;
      const append = async (
        _tx: typeof tx,
        input: Pick<
          import("@opensteer/core").AgentEvent,
          "type" | "data" | "environmentId" | "runId" | "threadId" | "workspaceId"
        >,
      ) => {
        const event = AgentEventSchema.parse({
          ...input,
          eventId: createId("event"),
          sequence: String(++sequence),
          createdAt: new Date().toISOString(),
        });
        eventRows.push({
          ...event,
          data: jsonValue(event.data),
          createdAt: new Date(event.createdAt),
          runnerBindingGeneration: null,
          runnerBootId: null,
          runnerId: null,
          runnerOrdinal: null,
        });
        return event;
      };
      const template = await tx
        .selectFrom("messages")
        .selectAll()
        .where("id", "=", f.run.seedInputId)
        .executeTakeFirstOrThrow();
      for (let index = 0; index < 310; index++) {
        const runId = createId("run");
        const messageId = createId("message");
        const human = index < 10;
        (human ? humanIds : quietIds).push(runId);
        if (!human) quietMessageIds.push(messageId);
        await tx
          .insertInto("messages")
          .values({
            ...template,
            content: jsonValue(template.content),
            id: messageId,
            runId: null,
            sequence: String(100 + index),
            author: human
              ? template.author
              : {
                  kind: "watch",
                  displayName: "Watcher",
                  activationId: createId("triggerWatchActivation"),
                  revisionId: createId("triggerRevision"),
                  triggerId: createId("trigger"),
                },
          })
          .execute();
        await sql`insert into thread_inputs select (jsonb_populate_record(null::thread_inputs, to_jsonb(i) ||
          jsonb_build_object('message_id', ${messageId}::text, 'run_id', null, 'state', 'pending', 'delivered_at', null, 'steer_command_id', null,
            'idempotency_key', ${messageId}::text, 'queue_rank', ${100 + index}::integer))).*
          from thread_inputs i where message_id = ${f.run.seedInputId}`.execute(tx);
        await sql`insert into runs select (jsonb_populate_record(null::runs, to_jsonb(r) ||
          jsonb_build_object('id', ${runId}::text, 'seed_input_id', ${messageId}::text,
            'activation_input_id', ${messageId}::text, 'run_ordinal', ${100 + index}::integer,
            'person_waited', ${human}::boolean, 'quiet', ${!human}::boolean))).* from runs r where id = ${f.run.id}`.execute(
          tx,
        );
        if (index !== 309)
          await tx.updateTable("messages").set({ runId }).where("id", "=", messageId).execute();
        const base = {
          environmentId: f.environmentId,
          threadId: f.thread.id,
          workspaceId: f.workspace.id,
        };
        const message = messageFromRow({
          ...template,
          id: messageId,
          runId,
          sequence: String(100 + index),
          author: human
            ? template.author
            : {
                kind: "watch",
                displayName: "Watcher",
                activationId: createId("triggerWatchActivation"),
                revisionId: createId("triggerRevision"),
                triggerId: createId("trigger"),
              },
        });
        await append(tx, {
          ...base,
          runId: null,
          type: "message.created",
          data: {
            message,
            input: threadInputFromRow(
              await tx
                .selectFrom("threadInputs")
                .selectAll()
                .where("messageId", "=", messageId)
                .executeTakeFirstOrThrow(),
            ),
          },
        });
        await append(tx, {
          ...base,
          runId,
          type: "message.placed",
          data: { message },
        });
        await append(tx, { ...base, runId: null, type: "message.injected", data: { messageId } });
        await append(tx, {
          ...base,
          runId: null,
          type: "thread-input.updated",
          data: {
            input: threadInputFromRow(
              await tx
                .selectFrom("threadInputs")
                .selectAll()
                .where("messageId", "=", messageId)
                .executeTakeFirstOrThrow(),
            ),
          },
        });
        await append(tx, {
          ...base,
          runId,
          type: "run.started",
          data: {
            status: "running",
            startedBy: message.author,
            startedAt: template.createdAt.toISOString(),
            personWaiting: human,
          },
        });
        await append(tx, {
          ...base,
          runId: null,
          type: "thread.state-changed",
          data: {
            status: "running",
            inputQueuePaused: false,
            pendingRequests: 0,
            title: f.thread.title,
            icon: null,
          },
        });
        await append(tx, {
          ...base,
          runId,
          type: "tool.started",
          data: {
            callId: `watch-${index}`,
            tool: { namespace: "test", name: "watch" },
            arguments: {},
          },
        });
        await append(tx, {
          ...base,
          runId,
          type: "tool.completed",
          data: {
            callId: `watch-${index}`,
            isError: false,
            output: { text: "No change" },
          },
        });
        if (index === 150) {
          for (const origin of ["watch", "trigger"] as const) {
            const assignment = {
              id: createId("delegation"),
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              finishedAt: null,
              currentRunId: runId,
              currentRunStatus: "running" as const,
              initialRunId: runId,
              modelLabel: null,
              objectivePreview: "Watch for updates",
              origin,
              parentThreadId: f.thread.id,
              resultPreview: null,
              returnStatus: "pending" as const,
              revision: 1,
              status: "open" as const,
              workerThread: {
                environmentId: f.environmentId,
                id: f.thread.id,
                pendingRequests: 0,
                status: "running" as const,
                title: "Watcher",
                icon: null,
                workspaceId: f.workspace.id,
              },
            };
            await append(tx, {
              ...base,
              runId: null,
              type: "assignment.created",
              data: { assignment },
            });
            await append(tx, {
              ...base,
              runId: f.run.id,
              type: "assignment.updated",
              data: { assignment: { ...assignment, revision: 2 } },
            });
          }
          await append(tx, {
            ...base,
            runId: null,
            type: "request.cancelled",
            data: { requestId: createId("request"), reason: "run-ended" },
          });
        }
        await append(tx, {
          ...base,
          runId,
          type: "run.completed",
          data: {
            status: "completed",
            replyMessageId: null,
            startedBy: message.author,
            startedAt: template.createdAt.toISOString(),
            personWaiting: human,
          },
        });
        await append(tx, {
          ...base,
          runId: null,
          type: "thread.state-changed",
          data: {
            status: "idle",
            inputQueuePaused: false,
            pendingRequests: 0,
            title: f.thread.title,
            icon: null,
          },
        });
      }
      await tx.insertInto("workspaceEvents").values(eventRows).execute();
    });
    const captured: CompiledQuery[] = [];
    const capture: KyselyPlugin = {
      transformQuery({ node, queryId }) {
        if (node.kind === "SelectQueryNode")
          captured.push(new PostgresQueryCompiler().compileQuery(node, queryId));
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    };
    const measuredStore =
      process.env.OPENSTEER_HISTORY_PLAN_BENCH === "1"
        ? new OpensteerStore(database.withPlugin(capture))
        : store;
    const read = (
      input: { view?: "conversation"; before?: string; maxItems?: number; maxBytes?: number } = {},
    ) =>
      measuredStore.threadEventPageForOwner({
        ownerId: f.userId,
        threadId: f.thread.id,
        maxTurns: 10,
        ...input,
      });
    if (process.env.OPENSTEER_HISTORY_PLAN_BENCH === "1") {
      const planQuery = conversationHistoryMetadata(database, f.thread.id, null)
        .orderBy("sequence", "desc")
        .limit(conversationHistoryScanCap + 1)
        .compile();
      await sql`analyze workspace_events; analyze runs; analyze messages`.execute(database);
      await sql`create extension pg_buffercache`.execute(database);
      for (const variant of ["existing-cold", "existing-warm", "covering-cold", "covering-warm"]) {
        if (variant === "covering-cold") {
          await sql`drop index workspace_events_thread_history`.execute(database);
          await sql`create index history_covering_candidate on workspace_events(thread_id, sequence) include(type, run_id)`.execute(
            database,
          );
        }
        if (variant.endsWith("cold")) {
          await sql`select pg_buffercache_evict_relation('workspace_events'::regclass)`.execute(
            database,
          );
          const indexName =
            variant === "existing-cold"
              ? "workspace_events_thread_history"
              : "history_covering_candidate";
          await sql`select pg_buffercache_evict_relation(${indexName}::regclass)`.execute(database);
        }
        const plan = await database.executeQuery(
          CompiledQuery.raw("explain (analyze, buffers, format json) " + planQuery.sql, [
            ...planQuery.parameters,
          ]),
        );
        console.info("HISTORY_PLAN", variant, JSON.stringify(plan.rows));
      }
      await sql`drop index history_covering_candidate`.execute(database);
      await sql`create index workspace_events_thread_history on workspace_events(thread_id, sequence) include(type)`.execute(
        database,
      );
    }
    const started = performance.now();
    const visible = (await read({ view: "conversation" }))!;
    const newMs = performance.now() - started;
    const newQueries = captured.splice(0);
    expect(visible.events.filter((e) => e.type === "message.placed")).toHaveLength(10);
    expect(visible.events.some((e) => e.runId && quietIds.includes(e.runId))).toBe(false);
    expect(visible.events.some((e) => e.type === "thread.state-changed")).toBe(false);
    expect(visible.events.filter((e) => e.type === "assignment.created")).toHaveLength(2);
    expect(visible.events.filter((e) => e.type === "assignment.updated")).toHaveLength(2);
    expect(visible.events.filter((e) => e.type === "request.cancelled")).toHaveLength(1);
    expect(
      visible.events.some(
        (e) =>
          (e.type === "message.created" || e.type === "message.placed") &&
          e.data.message.author.kind === "watch",
      ),
    ).toBe(false);
    expect(
      visible.events.some(
        (e) =>
          e.type === "thread-input.updated" && quietMessageIds.includes(e.data.input.messageId),
      ),
    ).toBe(false);
    expect(
      visible.events.some(
        (e) => e.type === "message.injected" && quietMessageIds.includes(e.data.messageId),
      ),
    ).toBe(false);
    const byteBound = (await read({ view: "conversation", maxBytes: 4000 }))!;
    expect(byteBound.window.byteCount).toBeLessThanOrEqual(4000);
    expect(byteBound.window.hasMore).toBe(true);
    expect(byteBound.window.nextBefore).toBe(byteBound.events[0]!.sequence);
    expect(visible.window.totalItems).toBeUndefined();
    captured.length = 0;
    const oldStarted = performance.now();
    let roundTrips = 0,
      bytes = 0,
      humanTurns = 0;
    let before: string | undefined;
    do {
      const page = (await read(before ? { before } : {}))!;
      roundTrips++;
      bytes += Buffer.byteLength(JSON.stringify(page));
      humanTurns += page.events.filter(
        (e) => e.type === "message.placed" && e.runId && humanIds.includes(e.runId),
      ).length;
      if (!page.window.hasMore) break;
      expect(page.window.nextBefore).not.toBe(before);
      before = page.window.nextBefore!;
    } while (humanTurns < 10);
    console.info(
      "HISTORY_BENCH",
      JSON.stringify({
        oldMs: performance.now() - oldStarted,
        roundTrips,
        bytes,
        newMs,
        newBytes: Buffer.byteLength(JSON.stringify(visible)),
      }),
    );
    if (process.env.OPENSTEER_HISTORY_PLAN_BENCH === "1") {
      const oldQueries = captured.splice(0);
      for (const [name, queries] of [
        ["new", newQueries],
        ["old", oldQueries],
      ] as const) {
        let hits = 0,
          reads = 0,
          ms = 0;
        for (const query of queries) {
          const result = await database.executeQuery<{
            "QUERY PLAN": Array<{
              Plan: { "Shared Hit Blocks": number; "Shared Read Blocks": number };
              "Execution Time": number;
            }>;
          }>(
            CompiledQuery.raw("explain (analyze, buffers, format json) " + query.sql, [
              ...query.parameters,
            ]),
          );
          const plan = result.rows[0]!["QUERY PLAN"][0]!;
          hits += plan.Plan["Shared Hit Blocks"];
          reads += plan.Plan["Shared Read Blocks"];
          ms += plan["Execution Time"];
        }
        console.info(
          "HISTORY_READ_PLANS",
          name,
          JSON.stringify({ statements: queries.length, hits, reads, ms }),
        );
      }
    }
    const unfiltered = await read();
    const around = await store.threadEventPageForOwner({
      ownerId: f.userId,
      threadId: f.thread.id,
      aroundMessageId: f.run.seedInputId,
    });
    expect(
      await store.threadEventPageForOwner({
        ownerId: f.userId,
        threadId: f.thread.id,
        aroundMessageId: f.run.seedInputId,
        view: "conversation",
      }),
    ).toEqual(around);
    await database
      .updateTable("threads")
      .set({ role: "work" })
      .where("id", "=", f.thread.id)
      .execute();
    expect(await read({ view: "conversation" })).toEqual(await read());
    await database
      .updateTable("threads")
      .set({ role: "conversation" })
      .where("id", "=", f.thread.id)
      .execute();
    expect(await read()).toEqual(unfiltered);
    const bounded = (await read({ view: "conversation", maxItems: 3 }))!;
    expect(bounded.events).toHaveLength(3);
    expect(bounded.window.nextBefore).toBe(bounded.events[0]!.sequence);
    await sql`insert into workspace_events (sequence, event_id, workspace_id, thread_id, environment_id, run_id, type, data, created_at)
      select event_sequence + n, 'evt_' || gen_random_uuid(), ${f.workspace.id}, ${f.thread.id}, ${f.environmentId},
        null, 'thread.state-changed', '{"status":"idle","inputQueuePaused":false,"pendingRequests":0}'::jsonb, now()
      from workspaces, generate_series(1, ${conversationHistoryScanCap + 1}) n where id = ${f.workspace.id}`.execute(
      database,
    );
    const empty = (await read({ view: "conversation" }))!;
    expect(empty.events).toEqual([]);
    expect(empty.window.hasMore).toBe(true);
    expect(empty.window.nextBefore).not.toBeNull();
    const continuation = (await read({ view: "conversation", before: empty.window.nextBefore! }))!;
    expect(continuation.events.filter((e) => e.type === "message.placed")).toHaveLength(10);
    expect(BigInt(continuation.events.at(-1)!.sequence)).toBeLessThan(
      BigInt(empty.window.nextBefore!),
    );
    expect(
      await database
        .selectFrom("runs")
        .select(quietRunPredicate.as("quiet"))
        .where("id", "in", quietIds)
        .execute(),
    ).toEqual(quietIds.map(() => ({ quiet: true })));
  });

  it("moves tasks only for admitted human work, including steering a running turn", async ({
    storeFixture,
  }) => {
    const { database, store, startRunFixture } = storeFixture;
    const f = await startRunFixture("task-asked");
    const other = await store.createThread({
      createdBy: f.userId,
      environmentId: f.environmentId,
      harnessInstanceId: f.harnessInstance.id,
      idempotencyKey: "task-asked-other",
      modelSelection: testModelSelection,
      title: "Other",
      workspaceId: f.workspace.id,
    });
    expect(other.thread.askedAt).toBe(other.thread.createdAt);
    await database
      .updateTable("threads")
      .set({ askedAt: new Date("2020-01-01") })
      .where("id", "=", f.thread.id)
      .execute();
    await database
      .updateTable("threads")
      .set({ askedAt: new Date("2021-01-01") })
      .where("id", "=", other.thread.id)
      .execute();
    const page = () => store.taskPageForUser({ userId: f.userId });
    expect((await page()).tasks.map(({ thread }) => thread.id)).toEqual([
      other.thread.id,
      f.thread.id,
    ]);
    const steer = await store.enqueueThreadInput({
      content: [{ type: "text", text: "Please change direction" }],
      idempotencyKey: "task-asked-steer",
      policy: "steer",
      requestedBy: f.userId,
      source: { kind: "human" },
      threadId: f.thread.id,
    });
    expect(steer.disposition).toBe("steering");
    const asked = (await page()).tasks[0]!.thread;
    expect(asked.id).toBe(f.thread.id);
    expect(Date.parse(asked.askedAt!)).toBeGreaterThan(Date.parse("2021-01-01"));
    const unchanged = async () =>
      expect(
        (await page()).tasks.find(({ thread }) => thread.id === f.thread.id)!.thread.askedAt,
      ).toBe(asked.askedAt);
    await store.enqueueThreadInput({
      content: [{ type: "text", text: "Agent context" }],
      idempotencyKey: "task-asked-agent",
      policy: "queue",
      requestedBy: f.userId,
      source: { kind: "agent", runId: f.run.id },
      threadId: f.thread.id,
    });
    await unchanged();
    const child = await store.delegateThread({
      accessMode: "auto",
      createdBy: f.userId,
      environmentId: f.environmentId,
      harnessInstanceId: f.harnessInstance.id,
      idempotencyKey: "task-asked-child",
      modelSelection: testModelSelection,
      origin: { kind: "run", parentRunId: f.run.id, parentThreadId: f.thread.id },
      task: [{ type: "text", text: "Check something" }],
      title: "Child",
      workspaceId: f.workspace.id,
    });
    await database
      .updateTable("runs")
      .set({ status: "completed" })
      .where("id", "=", child.run.id)
      .execute();
    await database
      .updateTable("delegations")
      .set({
        status: "completed",
        resultRunId: child.run.id,
        resultText: "Checked",
        finishedAt: new Date(),
      })
      .where("id", "=", child.assignment.id)
      .execute();
    expect(
      (await store.drainAssignmentReturn(child.assignment.id)).some(
        ({ type }) => type === "message.created",
      ),
    ).toBe(true);
    await unchanged();

    await store.enqueueThreadInput({
      content: [{ type: "text", text: "Human report" }],
      idempotencyKey: "task-asked-report",
      policy: "report",
      requestedBy: f.userId,
      source: { kind: "human" },
      threadId: f.thread.id,
    });
    await unchanged();
    await database
      .updateTable("threads")
      .set({ titleSource: "provisional", iconSource: "provisional" })
      .where("id", "=", f.thread.id)
      .execute();
    expect(
      await store.applyGeneratedThreadName({
        threadId: f.thread.id,
        title: "Generated",
        icon: "code",
      }),
    ).not.toBeNull();
    await unchanged();
    await store.renameThread({
      threadId: f.thread.id,
      requestedBy: f.userId,
      idempotencyKey: "task-asked-rename",
      title: "Renamed",
    });
    await unchanged();
    await database
      .updateTable("runs")
      .set({ status: "completed" })
      .where("threadId", "=", f.thread.id)
      .execute();
    await store.updateThreadExecutionSelection({
      threadId: f.thread.id,
      requestedBy: f.userId,
      idempotencyKey: "task-asked-model",
      harnessInstanceId: f.harnessInstance.id,
      continuationIdentity: testContinuationIdentity,
      modelSelection: ModelSelectionSchema.parse({
        ...testModelSelection,
        modelId: "another-model",
      }),
    });
    await unchanged();
    await database
      .updateTable("threads")
      .set({ askedAt: new Date("2020-01-01") })
      .where("id", "=", other.thread.id)
      .execute();
    await store.enqueueThreadInput({
      content: [{ type: "text", text: "Start other" }],
      idempotencyKey: "task-asked-human",
      policy: "queue",
      requestedBy: f.userId,
      source: { kind: "human" },
      threadId: other.thread.id,
    });
    expect((await page()).tasks[0]!.thread.id).toBe(other.thread.id);
  });

  it("omits history without reading message rows or counts and retains metadata", async ({
    storeFixture,
  }) => {
    const { database, store, startRunFixture, openLiveRequest } = storeFixture;
    const f = await startRunFixture("snapshot-omitted-history");
    const requestId = createId("request");
    await openLiveRequest(f, requestId);
    let messageQueries = 0;
    const observed = new OpensteerStore(
      database.withPlugin({
        transformQuery({ node }) {
          if (JSON.stringify(node).includes('"name":"messages"')) messageQueries += 1;
          return node;
        },
        async transformResult({ result }) {
          return result;
        },
      }),
    );
    const full = await observed.workspaceSnapshot(f.workspace.id);
    expect(full.messages.length).toBeGreaterThan(0);
    expect(full.messageWindows).toContainEqual(
      expect.objectContaining({ threadId: f.thread.id, totalItems: 1 }),
    );
    expect(full).not.toHaveProperty("messagesOmitted");
    expect(messageQueries).toBe(2);
    messageQueries = 0;
    const omitted = await observed.workspaceSnapshot(f.workspace.id, { omitMessages: true });
    expect.soft(omitted.messages).toEqual([]);
    expect.soft(omitted.messageWindows).toEqual([]);
    expect.soft(omitted).toHaveProperty("messagesOmitted", true);
    expect(messageQueries).toBe(0);
    expect(omitted.serializedBytes).toBe(Buffer.byteLength(JSON.stringify(omitted), "utf8"));
    const metadata = ({
      messages: _messages,
      messageWindows: _windows,
      serializedBytes: _bytes,
      messagesOmitted: _omitted,
      ...rest
    }: typeof omitted) => rest;
    expect(metadata(omitted)).toEqual(metadata(full));
    // Viewer state still reads the latest published sequence, never history bodies.
    const withViewer = await store.workspaceSnapshot(f.workspace.id, { viewerId: f.userId });
    const omittedWithViewer = await store.workspaceSnapshot(f.workspace.id, {
      viewerId: f.userId,
      omitMessages: true,
    });
    expect(omittedWithViewer.readStates).toHaveLength(1);
    expect(metadata(omittedWithViewer)).toEqual(metadata(withViewer));
    expect(omittedWithViewer.pendingRequests).toContainEqual(
      expect.objectContaining({ id: requestId }),
    );
    expect(omittedWithViewer.runQueue).toContainEqual(expect.objectContaining({ id: f.run.id }));
  });
});
