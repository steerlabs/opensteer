import { createId } from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import { expect, test } from "vitest";
import { createDatabase } from "./connection.js";
import { ensureDeployment } from "./deployment-store.js";
import {
  migrateToLatest,
  migrationProvider,
  personalCurrentStateMigrationName,
} from "./migrations.js";
import { applyPersonalStateSchema, type PersonalStateSchema } from "./personal-state-schema.js";
import { finishPersonalStateUpgrade } from "./personal-state-upgrade.js";
import type { DatabaseSchema } from "./schema.js";
import { createStoreFixture, pendingEvent } from "./store.integration.test-support.js";
import { cloneTestDatabase } from "./test-database.test-support.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import { completePersonalToolCall } from "./personal-tool-calls.js";
import { resolvePersonalToolImages } from "./personal-tool-images.js";
import { liveRequest } from "./store.integration.test-support.js";
import { requestInsert } from "./request-persistence.js";

function legacyState(database: Kysely<DatabaseSchema>) {
  return sql<{ legacy: boolean; cursor: boolean }>`
    select to_regclass('deployment_events') is not null as legacy,
      exists(select 1 from information_schema.columns where table_schema='public'
        and table_name='client_sync_state' and column_name='upgrade_cursor') as cursor
  `
    .execute(database)
    .then(({ rows }) => rows[0]);
}

test.each(["empty", "personal", "team"] as const)(
  "finalizes the %s 0028 database before owner setup",
  async (kind) => {
    const fixture = await cloneTestDatabase("host");
    const database = createDatabase({ connectionString: fixture.url });
    try {
      if (kind !== "empty")
        await ensureDeployment(database, {
          canonicalOrigin: "https://fixture.example.invalid",
          hostInstanceId: createId("hostInstance"),
          deploymentShape: { kind },
        });
      const lineage = migrationProvider({ personalCurrentState: true });
      await Promise.all([migrateToLatest(database, lineage), migrateToLatest(database, lineage)]);
      const applied = await sql<{ name: string }>`select name from kysely_migration
        where name = ${personalCurrentStateMigrationName}`.execute(database);
      expect(applied.rows).toEqual([{ name: personalCurrentStateMigrationName }]);
      expect(await legacyState(database)).toEqual({ legacy: false, cursor: false });
      const state =
        await sql`select ready,sequence,pruned_through_sequence from client_sync_state limit 1`.execute(
          database,
        );
      const settings = await database
        .selectFrom("personalSettings")
        .select("ownerId")
        .limit(1)
        .execute();
      expect(state.rows).toEqual(
        kind === "personal" ? [{ ready: true, sequence: "0", prunedThroughSequence: "0" }] : [],
      );
      expect(settings).toEqual([]);
      if (kind === "empty") {
        const fresh = await ensureDeployment(database, {
          canonicalOrigin: "https://fresh-fixture.example.invalid",
          hostInstanceId: createId("hostInstance"),
          deploymentShape: { kind: "personal" },
          personalCurrentState: true,
        });
        const sync = await sql`select deployment_id, epoch, ready, sequence,
          pruned_through_sequence, retained_change_count, pending_request_count, needs_you_count,
          unread_task_count, last_commit_at from client_sync_state where deployment_id = ${fresh.id}`.execute(
          database,
        );
        expect(sync.rows).toEqual([
          {
            deploymentId: fresh.id,
            epoch: expect.stringMatching(/^[a-f0-9-]{36}$/u),
            ready: true,
            sequence: "0",
            prunedThroughSequence: "0",
            retainedChangeCount: 0,
            pendingRequestCount: 0,
            needsYouCount: 0,
            unreadTaskCount: 0,
            lastCommitAt: expect.any(Date),
          },
        ]);
      }
    } finally {
      await database.destroy();
      await fixture.drop();
    }
  },
);

test("resumes conversion with exact tools, images and admitted seeds", async () => {
  const fixture = await createStoreFixture();
  const { database, store } = fixture;
  try {
    const active = await fixture.startRunFixture("migration-active");
    const queued = await fixture.createRunFixture("migration-queued");
    const seed = await store.enqueueThreadInput({
      requestedBy: queued.userId,
      threadId: queued.threadId,
      content: [{ type: "text", text: "Admitted before going offline" }],
      source: { kind: "human" },
      policy: "queue",
      idempotencyKey: "migration:admitted",
    });
    expect(seed.run).toBeTruthy();
    await database
      .updateTable("threads")
      .set({ inputQueuePaused: true })
      .where("id", "=", queued.threadId)
      .execute();
    const waiting = await store.enqueueThreadInput({
      requestedBy: queued.userId,
      threadId: queued.threadId,
      content: [{ type: "text", text: "Still waiting" }],
      source: { kind: "human" },
      policy: "queue",
      idempotencyKey: "migration:waiting",
    });
    expect(waiting.run).toBeNull();

    const prompt = await database
      .selectFrom("messages")
      .select("id")
      .where("threadId", "=", active.threadId)
      .orderBy("sequence")
      .limit(1)
      .executeTakeFirstOrThrow();
    const assistantMessageId = createId("message");
    await store.commitRunnerEvent({
      runnerId: active.runnerId,
      runnerBootId: active.runnerBootId,
      environmentId: active.environmentId,
      event: pendingEvent({
        type: "assistant.message",
        data: { messageId: assistantMessageId, content: [{ type: "text", text: "Stored reply" }] },
        runId: active.runId,
        threadId: active.threadId,
        ordinal: 1,
        bindingGeneration: active.bindingGeneration,
        environmentId: active.environmentId,
      }),
    });
    await store.commitRunnerEvent({
      runnerId: active.runnerId,
      runnerBootId: active.runnerBootId,
      environmentId: active.environmentId,
      event: pendingEvent({
        type: "run.completed",
        data: { status: "completed" },
        runId: active.runId,
        threadId: active.threadId,
        ordinal: 2,
        bindingGeneration: active.bindingGeneration,
        environmentId: active.environmentId,
      }),
    });

    const imagePath = "/disposable-fixture/screenshot.png";
    await sql`delete from deployment_events`.execute(database);
    const identity = { callId: "legacy-test", tool: { namespace: "native", name: "image" } };
    const output = { text: "result", images: [{ path: imagePath, mediaType: "image/png" }] };
    for (const event of [
      { sequence: 10, type: "tool.started", data: { ...identity, arguments: {} }, ordinal: 3 },
      {
        sequence: 11,
        type: "tool.started",
        data: { ...identity, arguments: { final: true } },
        ordinal: 4,
      },
      {
        sequence: 899,
        type: "run.completed",
        data: { replyMessageId: assistantMessageId },
        ordinal: 5,
      },
      {
        sequence: 900,
        type: "tool.completed",
        data: { callId: identity.callId, isError: false, output },
        ordinal: 6,
      },
      {
        sequence: 902,
        type: "tool.completed",
        data: { callId: "result-only", isError: false, output: { text: "only" } },
        ordinal: 7,
      },
      {
        sequence: 904,
        type: "tool.started",
        data: { ...identity, callId: "harness:older", arguments: {} },
        ordinal: null,
      },
      {
        sequence: 905,
        type: "reasoning.completed",
        data: { blockId: "thought", text: "Retained reasoning" },
        ordinal: 8,
      },
    ]) {
      const binding = event.ordinal === null ? null : active.bindingGeneration;
      await sql`insert into deployment_events(deployment_id,sequence,event_id,thread_id,run_id,environment_id,type,data,
        runner_ordinal,runner_id,runner_boot_id,runner_binding_generation)
        values(${active.deploymentId},${event.sequence},${createId("event")},${active.threadId},${active.runId},
          ${active.environmentId},${event.type},${JSON.stringify(event.data)}::jsonb,${event.ordinal},
          ${binding === null ? null : active.runnerId},${binding === null ? null : active.runnerBootId},${binding})`.execute(
        database,
      );
    }
    await sql`insert into deployment_events(deployment_id,sequence,event_id,thread_id,run_id,environment_id,type,data)
      select ${active.deploymentId},seq,'evt_fixture_'||seq,${active.threadId},${active.runId},${active.environmentId},
        'message.created',jsonb_build_object('message',jsonb_build_object('id',${prompt.id}::text))
      from generate_series(12,525) seq`.execute(database);
    await sql`update deployment_event_state set sequence=905`.execute(database);

    await database.transaction().execute(applyPersonalStateSchema);
    for (const boundary of ["settle", "message", "ledger", "verify", "finalize"] as const) {
      await expect(
        finishPersonalStateUpgrade(database, {
          afterBatch(stage) {
            if (stage === boundary) throw new Error(`crash after ${boundary}`);
          },
        }),
      ).rejects.toThrow(`crash after ${boundary}`);
      expect(await legacyState(database)).toEqual({
        legacy: boundary !== "finalize",
        cursor: boundary !== "finalize",
      });
    }
    await finishPersonalStateUpgrade(database);

    const target =
      database.withTables<
        Pick<
          PersonalStateSchema,
          | "clientSyncState"
          | "runnerEventReceipts"
          | "runs"
          | "transcriptItems"
          | "toolCalls"
          | "toolOutputImages"
        >
      >();
    const state = await target.selectFrom("clientSyncState").selectAll().executeTakeFirstOrThrow();
    expect(state).toMatchObject({
      ready: true,
      sequence: "905",
      prunedThroughSequence: "905",
      retainedChangeCount: 0,
    });
    expect(
      await target.selectFrom("runnerEventReceipts").select("ordinal").limit(1).execute(),
    ).toEqual([]);
    const storedReply = await target
      .selectFrom("runs")
      .select("terminalReplyMessageId")
      .where("id", "=", active.runId)
      .executeTakeFirstOrThrow();
    expect(storedReply.terminalReplyMessageId).toBe(assistantMessageId);

    const seedCard = await target
      .selectFrom("transcriptItems")
      .select(["visible", "isTurnStart"])
      .where("id", "=", seed.message.id)
      .executeTakeFirstOrThrow();
    const waitingCard = await target
      .selectFrom("transcriptItems")
      .select(["visible", "position"])
      .where("id", "=", waiting.message.id)
      .executeTakeFirstOrThrow();
    expect(seedCard).toEqual({ visible: true, isTurnStart: true });
    expect(waitingCard).toEqual({ visible: false, position: null });
    const tools = await target.selectFrom("toolCalls").selectAll().orderBy("callId").execute();
    expect(tools.map(({ callId, status, arguments: args }) => ({ callId, status, args }))).toEqual([
      { callId: "harness:older", status: "interrupted", args: {} },
      { callId: "legacy-test", status: "completed", args: { final: true } },
      { callId: "result-only", status: "completed", args: null },
    ]);
    const card = await target
      .selectFrom("transcriptItems")
      .select("position")
      .where("toolCallId", "=", tools[1]!.id)
      .executeTakeFirstOrThrow();
    expect(BigInt(tools[1]!.completionOrder!) - BigInt(card.position!)).toBe(890n);

    const original = await target
      .selectFrom("toolOutputImages")
      .selectAll()
      .executeTakeFirstOrThrow();
    const current = createDatabase<PersonalStateSchema>({ connectionString: fixture.databaseUrl });
    try {
      const newRunId = createId("run");
      const newAttemptId = createId("runAttempt");
      await sql`insert into runs
        select (jsonb_populate_record(null::runs, to_jsonb(source) || jsonb_build_object(
          'id',${newRunId}::text,'status','running','run_ordinal',source.run_ordinal+1,
          'terminal_reply_message_id',null,'completed_at',null,'next_runner_ordinal',0
        ))).* from runs source where source.id=${active.runId}`.execute(current);
      await sql`insert into run_attempts
        select (jsonb_populate_record(null::run_attempts, to_jsonb(source) || jsonb_build_object(
          'id',${newAttemptId}::text,'run_id',${newRunId}::text,'ended_at',null,'outcome',null
        ))).* from run_attempts source where source.run_id=${active.runId} and source.status='current'`.execute(
        current,
      );
      const fresh = await commitPersonalMutation(current, (tx, mutation) =>
        completePersonalToolCall(tx, mutation, {
          runId: newRunId,
          threadId: active.threadId,
          attemptId: newAttemptId,
          bindingGeneration: active.bindingGeneration,
          origin: "runner",
          nodeId: null,
          callId: "new-image",
          output: { text: "new output", images: [{ path: imagePath, mediaType: "image/png" }] },
          isError: false,
        }),
      );
      expect(BigInt(fresh.call.completionOrder!)).toBeGreaterThan(BigInt(original.completionOrder));
      const latest = await resolvePersonalToolImages(current, {
        viewerId: active.userId,
        threadId: active.threadId,
        paths: [imagePath],
      });
      expect(latest.map(({ id }) => id)).toEqual([`${fresh.call.id}:0`]);
    } finally {
      await current.destroy();
    }
  } finally {
    await fixture.close();
  }
});

test.each(["missing card", "invalid preview"] as const)(
  "a parity failure (%s) keeps the source ledger and the unready cursor",
  async (fault) => {
    const fixture = await createStoreFixture();
    const { database } = fixture;
    try {
      const { threadId } = await fixture.startRunFixture("migration-parity");
      await database.transaction().execute(applyPersonalStateSchema);

      const stopBeforeVerify = new Error("Stop before verification");
      await expect(
        finishPersonalStateUpgrade(database, {
          afterBatch(stage) {
            if (stage === "attention-links") throw stopBeforeVerify;
          },
        }),
      ).rejects.toBe(stopBeforeVerify);

      const card = sql`(select id from transcript_items where thread_id = ${threadId} and kind='message' order by id limit 1)`;
      const injected =
        fault === "missing card"
          ? await sql`delete from transcript_items where id = ${card} returning id`.execute(
              database,
            )
          : await sql`update transcript_items set view=jsonb_build_object('title', ${"a".repeat(193)}::text)
          where id = ${card} returning id`.execute(database);
      expect(injected.rows).toHaveLength(1);

      const readSource = () =>
        sql<{ count: string; ready: boolean; stage: string }>`
      select (select count(*) from deployment_events)::text as count,
        ready, upgrade_cursor->>'stage' as stage from client_sync_state
    `
          .execute(database)
          .then(({ rows }) => rows[0]);
      const source = await readSource();
      expect(source).toMatchObject({ ready: false, stage: "verify" });
      expect(Number(source?.count)).toBeGreaterThan(0);

      await expect(finishPersonalStateUpgrade(database)).rejects.toThrow("parity check failed");
      expect(await legacyState(database)).toEqual({ legacy: true, cursor: true });
      expect(await readSource()).toEqual(source);
    } finally {
      await fixture.close();
    }
  },
);

test("conversion rebuilds pending Requests without moving an idle task into Active", async () => {
  const fixture = await createStoreFixture();
  const { database } = fixture;
  try {
    const run = await fixture.startRunFixture("migration-durable-request");
    const request = liveRequest({
      harnessInstanceId: run.harnessInstance.id,
      id: createId("request"),
      requestedBy: run.userId,
      runId: run.runId,
      threadId: run.threadId,
      presentation: {
        kind: "choice",
        title: "Decide later",
        options: [{ id: "allow", label: "Allow", hint: "allow-once" }],
      },
    });
    await database
      .insertInto("requests")
      .values({
        ...requestInsert(request),
        mode: "durable",
        kind: "browser.sign-in",
        payload: {
          kind: "browser.sign-in",
          sessionId: "fixture",
          reason: "Decide later",
          site: "https://fixture.example.invalid",
        },
      })
      .execute();
    await database.transaction().execute(applyPersonalStateSchema);
    await finishPersonalStateUpgrade(database);
    expect(
      await database
        .selectFrom("threads")
        .select(["status", "pendingRequestCount"])
        .where("id", "=", run.threadId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "idle", pendingRequestCount: 1 });
    expect(
      await database
        .selectFrom("requests")
        .select("status")
        .where("id", "=", request.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "pending" });
  } finally {
    await fixture.close();
  }
});

test("resumes offline settlement of a Run with a large live node set", async () => {
  const fixture = await createStoreFixture();
  const { database } = fixture;
  try {
    const run = await fixture.startRunFixture("offline-node-batches");
    await sql`insert into execution_nodes(id,run_id,attempt_id,kind,title,native_ref,status,started_at)
      select 'nod_90000000-0000-4000-8000-'||lpad(n::text,12,'0'), run_id, id,
        'subagent', ${"🌱".repeat(110)}, 'fixture:'||n, 'running', clock_timestamp()
      from run_attempts cross join generate_series(1,140) n where run_id=${run.runId} and status='current'`.execute(
      database,
    );
    await database.transaction().execute(applyPersonalStateSchema);
    const stopped = new Error("Stop after the first node batch");
    await expect(
      finishPersonalStateUpgrade(database, {
        afterBatch(stage) {
          if (stage === "settle") throw stopped;
        },
      }),
    ).rejects.toBe(stopped);
    const active = () =>
      database
        .selectFrom("executionNodes")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("runId", "=", run.runId)
        .where("status", "=", "running")
        .executeTakeFirstOrThrow();
    expect(await active()).toEqual({ count: "12" });
    await finishPersonalStateUpgrade(database);
    expect(await active()).toEqual({ count: "0" });
    const cards = await sql<{ count: string; maxBytes: number }>`select
      count(*)::text as count, max(octet_length(view->>'title')) as max_bytes
      from transcript_items where run_id=${run.runId} and kind='node'`.execute(database);
    expect(cards.rows).toEqual([{ count: "140", maxBytes: 192 }]);
  } finally {
    await fixture.close();
  }
});

test("the current-state lineage refuses a team database with a private legacy fence", async () => {
  const fixture = await cloneTestDatabase("host");
  const database = createDatabase({ connectionString: fixture.url });
  try {
    const team = await ensureDeployment(database, {
      canonicalOrigin: "https://team-fixture.example.invalid",
      hostInstanceId: createId("hostInstance"),
      deploymentShape: { kind: "team" },
    });
    await sql`insert into deployment_event_state (deployment_id) values (${team.id})`.execute(
      database,
    );
    await expect(
      migrateToLatest(database, migrationProvider({ personalCurrentState: true })),
    ).rejects.toThrow(/team.*personal/i);
    expect(await legacyState(database)).toEqual({ legacy: true, cursor: true });
  } finally {
    await database.destroy();
    await fixture.drop();
  }
});
