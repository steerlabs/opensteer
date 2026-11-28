import { readTranscriptItem, readTranscriptPage } from "./personal-sync-store.js";
import { RequestSchema, TabIdSchema, createId } from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import { expect, test, vi } from "vitest";
import { createDatabase } from "./connection.js";
import { ensureDeployment } from "./deployment-store.js";
import {
  commandRequestsMigrationName,
  migrateToLatest,
  migrationProvider,
  personalCurrentStateMigrationName,
} from "./migrations.js";
import {
  answeredQuestionRecordsMigrationName,
  dropDeviceAccessCountMigrationName,
  browserSessionTabsIndexMigrationName,
  inlineTranscriptMessagesMigrationName,
  runProviderRetryMigrationName,
  stoppedRunsNotNewsMigrationName,
  taskOpenIndexesMigrationName,
  threadDoneByMigrationName,
  taskApprovalReceiptsMigrationName,
} from "./personal-state-schema.js";
import { agentGrantsMigrationName } from "./agent-grants-migration.js";
import { agentSessionsMigrationName } from "./agent-sessions-migration.js";
import { agentDirectoryMigrationName } from "./agent-directory-migration.js";
import {
  removeOrganizationsMigrationName,
  workHomeMigrationName,
} from "./one-person-home-migration.js";
import { removePlatformVerificationMigrationName } from "./platform-verification-removal-migration.js";
import {
  browserPoolMigrationName,
  browserPoolSessionsMigrationName,
} from "./browser-pool-migration.js";
import { bridgeConnectionsMigrationName } from "./bridge-connections-migration.js";
import { chatRoutesEndMigrationName } from "./chat-routes-end-migration.js";
import { preparePersonalConversion } from "./personal-state.test-support.js";
import { finishPersonalStateUpgrade } from "./personal-state-upgrade.js";
import type { DatabaseSchema } from "./schema.js";
import { createStoreFixture, pendingEvent } from "./store.integration.test-support.js";
import { cloneTestDatabase } from "./test-database.test-support.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import { completePersonalToolCall } from "./personal-tool-calls.js";
import { resolvePersonalToolImages } from "./personal-tool-images.js";
import { seedPersonalFixture } from "./personal-fixture.test-support.js";
import { enrollTestRunner } from "./store.integration.test-support.js";
import { personalReachableGrant } from "./runner-store.js";
import { OpensteerStore } from "./store.js";
import { TabStore } from "./tab-store.js";
import { bindBrowserProfile } from "./browser-profile-storage-store.js";
import { LocalProfileBindingSchema } from "@opensteer/protocol";
import { jsonValue } from "./store-primitives.js";
import { liveRequest } from "./store.integration.test-support.js";
import { requestInsert } from "./request-persistence.js";
import { transcriptIdentity } from "./transcript-store.js";
import { startPersonalQueuedRunFixture } from "./personal-run-fixture.test-support.js";

function legacyState(database: Kysely<DatabaseSchema>) {
  return sql<{ legacy: boolean; cursor: boolean }>`
    select to_regclass('deployment_events') is not null as legacy,
      exists(select 1 from information_schema.columns where table_schema='public'
        and table_name='client_sync_state' and column_name='upgrade_cursor') as cursor
  `
    .execute(database)
    .then(({ rows }) => rows[0]);
}

test.each(["empty", "personal", "personal-0035"] as const)(
  "finalizes the %s pre-conversion database before owner setup",
  async (start) => {
    const kind = start === "personal-0035" ? "personal" : start;
    const fixture = await cloneTestDatabase("host");
    const database = createDatabase({ connectionString: fixture.url });
    try {
      await sql`drop schema public cascade; create schema public`.execute(database);
      // personal-0035 stops before main's shipped plugin migrations, which then run
      // ahead of the conversion; the others start from main's latest (0037).
      await migrateToLatest(
        database,
        start === "personal-0035"
          ? {
              async getMigrations() {
                const all = await migrationProvider({
                  personalCurrentState: false,
                }).getMigrations();
                return Object.fromEntries(
                  Object.entries(all).filter(([name]) => name < "0036_one_plugin_per_owner_name"),
                );
              },
            }
          : migrationProvider({ personalCurrentState: false }),
      );
      if (kind !== "empty") {
        const id = createId("deployment");
        await sql`insert into deployments (id,singleton_key,active_host_instance_id,canonical_origin,lifecycle,deployment_shape)
          values (${id},'primary',${createId("hostInstance")},'https://fixture.example.invalid','active',
            jsonb_build_object('kind',${kind}::text))`.execute(database);
        if (kind === "personal")
          await sql`insert into deployment_event_state(deployment_id) values (${id})`.execute(
            database,
          );
      }
      const lineage = migrationProvider({ personalCurrentState: true });
      await Promise.all([migrateToLatest(database, lineage), migrateToLatest(database, lineage)]);
      const applied = await sql<{ name: string }>`select name from kysely_migration
        where name >= '0036' order by timestamp, name`.execute(database);
      expect(applied.rows.map(({ name }) => name)).toEqual([
        "0036_one_plugin_per_owner_name",
        "0037_plugin_package_format",
        personalCurrentStateMigrationName,
        taskApprovalReceiptsMigrationName,
        answeredQuestionRecordsMigrationName,
        dropDeviceAccessCountMigrationName,
        browserSessionTabsIndexMigrationName,
        inlineTranscriptMessagesMigrationName,
        stoppedRunsNotNewsMigrationName,
        threadDoneByMigrationName,
        runProviderRetryMigrationName,
        taskOpenIndexesMigrationName,
        agentGrantsMigrationName,
        agentSessionsMigrationName,
        "0102_chrome_live_tabs_source",
        agentDirectoryMigrationName,
        "0104_shared_chrome_grants",
        workHomeMigrationName,
        browserPoolMigrationName,
        "0107_needs_you_counts_requests",
        bridgeConnectionsMigrationName,
        chatRoutesEndMigrationName,
        removeOrganizationsMigrationName,
        removePlatformVerificationMigrationName,
        commandRequestsMigrationName,
        "0113_automations_contract",
        "0114_thread_inputs_written_by_connection",
        "0115_provider_session_person_lineage",
        browserPoolSessionsMigrationName,
        "0117_stop_truth_and_recovery",
        "0118_problem_reports",
        "0119_automation_secret_names",
        "0120_run_waiting_for_run",
        "0121_one_device_switch_record_contract",
        "0122_command_attempt_outcomes",
        "0123_agent_operation_endings",
        "0124_agent_session_device_holds",
        "0125_retire_archived_profile_tabs",
        "0126_agent_operation_profile_deleted",
        "0127_task_done_agent_session_endings",
      ]);
      const endings = await sql<{ name: string; definition: string }>`
        select conname as name, pg_get_constraintdef(oid) as definition
        from pg_constraint
        where conname in ('agent_operations_ending_check', 'agent_sessions_end_reason_check')
        order by conname
      `.execute(database);
      expect(endings.rows).toEqual([
        {
          name: "agent_operations_ending_check",
          definition: expect.stringMatching(/'profile-deleted'.*'task-done'/u),
        },
        { name: "agent_sessions_end_reason_check", definition: expect.stringContaining("'done'") },
      ]);
      expect(await legacyState(database)).toEqual({ legacy: false, cursor: false });
      const indexes = await sql<{ name: string }>`
        select indexname as name from pg_indexes
        where schemaname = 'public' and tablename = 'runs'
          and indexname in ('runs_finishing', 'runs_with_finish_intent', 'runs_unsettled_upgrade')
      `.execute(database);
      expect(indexes.rows).toEqual([{ name: "runs_finishing" }]);
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

    await preparePersonalConversion(database, 1013);
    const sharedPage = {
      type: "browser-page",
      sessionId: `bsn_${crypto.randomUUID()}`,
      tabId: "tab-shared",
      title: "Shared page",
      url: "https://example.com/shared",
    };
    await sql`update messages set content = content || jsonb_build_array(${JSON.stringify(sharedPage)}::jsonb)
      where id = ${prompt.id}`.execute(database);
    const imagePath = "/disposable-fixture/screenshot.png";
    const reasoningText = "考".repeat(200_000);
    await sql`delete from deployment_events`.execute(database);
    const identity = { callId: "legacy-test", tool: { namespace: "native", name: "image" } };
    const output = { text: "result", images: [{ path: imagePath, mediaType: "image/png" }] };
    for (const event of [
      { sequence: 850, type: "tool.started", data: { ...identity, arguments: {} }, ordinal: 3 },
      {
        sequence: 851,
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
        sequence: 1012,
        type: "reasoning.completed",
        data: { blockId: "thought", text: "Superseded reasoning" },
        ordinal: 8,
      },
      {
        sequence: 1013,
        type: "reasoning.completed",
        data: { blockId: "thought", text: reasoningText },
        ordinal: 9,
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
        case when seq in (508,510) then 'message.placed' else 'message.created' end,
        jsonb_build_object('message',jsonb_build_object('id',${prompt.id}::text))
      from generate_series(12,1011) seq
      where seq not in (850,851,899,900,902,904)`.execute(database);
    for (const boundary of [
      "settle",
      "message",
      "ledger",
      "verify",
      "index",
      "finalize",
    ] as const) {
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
          DatabaseSchema,
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
      sequence: "1013",
      prunedThroughSequence: "1013",
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

    expect((await store.listPendingCommands()).map(({ id }) => id)).not.toContain(seed.command?.id);
    expect(
      await database
        .selectFrom("commands")
        .select("status")
        .where("id", "=", seed.command!.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "failed" });
    const next = await store.enqueueThreadInput({
      requestedBy: active.userId,
      threadId: active.threadId,
      content: [{ type: "text", text: "New work after the upgrade" }],
      source: { kind: "human" },
      policy: "queue",
      idempotencyKey: "migration:new-work",
    });
    expect((await store.listPendingCommands()).map(({ id }) => id)).toContain(next.command!.id);
    const started = await startPersonalQueuedRunFixture(store, next.run!.id);
    expect(started.runId).toBe(next.run!.id);

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
    expect(BigInt(tools[1]!.completionOrder!) - BigInt(card.position!)).toBe(50n);
    const placed = await target
      .selectFrom("transcriptItems")
      .select("position")
      .where("id", "=", prompt.id)
      .executeTakeFirstOrThrow();
    expect(BigInt(tools[1]!.completionOrder!) - BigInt(placed.position!)).toBe(390n);
    expect(
      await target
        .selectFrom("transcriptItems")
        .select("refs")
        .where("id", "=", prompt.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ refs: { pages: [sharedPage] } });
    expect(
      await target
        .selectFrom("transcriptItems")
        .select(["id", "body", "view"])
        .where("runId", "=", active.runId)
        .where("kind", "=", "reasoning")
        .execute(),
    ).toEqual([
      {
        id: transcriptIdentity(
          "reasoning",
          active.runId,
          tools[1]!.attemptId,
          active.bindingGeneration,
          null,
          "thought",
        ),
        body: reasoningText,
        view: { preview: reasoningText.slice(0, 341), truncated: true },
      },
    ]);

    await expect(
      readTranscriptItem(target, {
        viewerId: active.userId,
        scope: { kind: "thread", threadId: active.threadId },
        itemId: transcriptIdentity(
          "reasoning",
          active.runId,
          tools[1]!.attemptId,
          active.bindingGeneration,
          null,
          "thought",
        ),
      }),
    ).resolves.toMatchObject({ body: { kind: "text", text: reasoningText }, truncated: false });

    const original = await target
      .selectFrom("toolOutputImages")
      .selectAll()
      .executeTakeFirstOrThrow();
    const current = createDatabase<DatabaseSchema>({ connectionString: fixture.databaseUrl });
    try {
      const newAttempt = await current
        .selectFrom("runAttempts")
        .select("id")
        .where("runId", "=", started.runId)
        .where("status", "=", "current")
        .executeTakeFirstOrThrow();
      const fresh = await commitPersonalMutation(current, (tx, mutation) =>
        completePersonalToolCall(tx, mutation, {
          runId: started.runId,
          threadId: active.threadId,
          attemptId: newAttempt.id,
          bindingGeneration: started.bindingGeneration,
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

test.each(["missing card", "invalid preview", "invalid visible timestamp"] as const)(
  "a parity failure (%s) keeps the source ledger and the unready cursor",
  async (fault) => {
    const fixture = await createStoreFixture();
    const { database } = fixture;
    try {
      const { deploymentId, threadId } = await fixture.startRunFixture("migration-parity");
      await preparePersonalConversion(database, 1);
      await sql`insert into deployment_events (deployment_id,sequence,event_id,thread_id,type,data)
        values (${deploymentId},1,${createId("event")},${threadId},'thread.created','{}')`.execute(
        database,
      );

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
          : fault === "invalid preview"
            ? await sql`update transcript_items set view=jsonb_build_object('title', ${"a".repeat(193)}::text)
                where id = ${card} returning id`.execute(database)
            : await sql`update transcript_items set created_at='infinity'
                where id = ${card} and visible returning id`.execute(database);
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

      await expect(finishPersonalStateUpgrade(database)).rejects.toThrow(
        'Personal state conversion failed at step "verify": Personal conversion parity check failed',
      );
      expect(await legacyState(database)).toEqual({ legacy: true, cursor: true });
      expect(await readSource()).toEqual(source);
    } finally {
      await fixture.close();
    }
  },
);

test.each([
  ["reasoning", 2, "finishes"],
  ["tools", 1, "fails"],
  ["images", 1, "fails"],
  ["nodeMessages", 1, "fails"],
] as const)(
  "a difference in imported %s rows: the conversion %s",
  async (counter, missing, outcome) => {
    const fixture = await createStoreFixture();
    const { database } = fixture;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { deploymentId, threadId } = await fixture.startRunFixture(
        `migration-drift-${counter}`,
      );
      await preparePersonalConversion(database, 1);
      await sql`insert into deployment_events (deployment_id,sequence,event_id,thread_id,type,data)
        values (${deploymentId},1,${createId("event")},${threadId},'thread.created','{}')`.execute(
        database,
      );
      const stopBeforeVerify = new Error("Stop before verification");
      await expect(
        finishPersonalStateUpgrade(database, {
          afterBatch(stage) {
            if (stage === "attention-links") throw stopBeforeVerify;
          },
        }),
      ).rejects.toBe(stopBeforeVerify);
      // The ledger said more rows of this kind were imported than arrived.
      await sql`update client_sync_state set upgrade_cursor = jsonb_set(upgrade_cursor,
        ${`{counts,${counter}}`}::text[],
        to_jsonb((upgrade_cursor#>>${`{counts,${counter}}`}::text[])::int + ${missing}))`.execute(
        database,
      );
      if (outcome === "fails") {
        // An agent reads these rows back, or a file reference resolves through them.
        await expect(finishPersonalStateUpgrade(database)).rejects.toThrow(
          'step "verify": Personal conversion parity check failed',
        );
        expect(await legacyState(database)).toEqual({ legacy: true, cursor: true });
        return;
      }
      await finishPersonalStateUpgrade(database);
      expect(await legacyState(database)).toEqual({ legacy: false, cursor: false });
      expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual(
        expect.objectContaining({ event: "personal-conversion-display-drift", check: counter }),
      );
    } finally {
      warn.mockRestore();
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
    await preparePersonalConversion(database);
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

test("settles proven, unsent and uncertain deliveries under the upgrade cursor", async () => {
  const fixture = await createStoreFixture();
  const { database, store } = fixture;
  try {
    const run = await fixture.startRunFixture("offline-delivery");
    const deliveries = [
      {
        type: "run.steer",
        commandStatus: "succeeded",
        attempts: 1,
        expectedCommand: "succeeded",
        expectedInput: "delivered",
      },
      {
        type: "run.steer",
        commandStatus: "pending",
        attempts: 0,
        expectedCommand: "failed",
        expectedInput: "pending",
      },
      {
        type: "run.restart",
        commandStatus: "dispatched",
        attempts: 1,
        expectedCommand: "unknown",
        expectedInput: "unknown",
      },
    ] as const;
    const controls = [];
    for (const delivery of deliveries) {
      const pending = await store.enqueueThreadInput({
        requestedBy: run.userId,
        threadId: run.threadId,
        content: [{ type: "text", text: delivery.expectedInput }],
        source: { kind: "human" },
        policy: "queue",
        idempotencyKey: `migration:${delivery.expectedInput}`,
      });
      const commandId = createId("command");
      await sql`insert into commands(id,environment_id,thread_id,run_id,requested_by,actor_principal_id,
        authority_source,idempotency_key,type,payload,status,attempts)
        select ${commandId},environment_id,thread_id,run_id,requested_by,actor_principal_id,authority_source,
          ${commandId},${delivery.type},jsonb_build_object('messageId',${pending.message.id}::text),
          ${delivery.commandStatus},${delivery.attempts} from commands where id=${run.turn.command.id}`.execute(
        database,
      );
      await database
        .updateTable("threadInputs")
        .set({ runId: run.runId, state: "claimed", steerCommandId: commandId })
        .where("messageId", "=", pending.message.id)
        .execute();
      await database
        .updateTable("messages")
        .set({ runId: run.runId })
        .where("id", "=", pending.message.id)
        .execute();
      controls.push({ ...delivery, commandId, messageId: pending.message.id });
    }
    await preparePersonalConversion(database);
    await finishPersonalStateUpgrade(database);

    for (const control of controls) {
      const input = await database
        .selectFrom("threadInputs")
        .select(["state", "runId", "steerCommandId"])
        .where("messageId", "=", control.messageId)
        .executeTakeFirstOrThrow();
      expect(input).toEqual({
        state: control.expectedInput,
        runId: control.expectedInput === "pending" ? null : run.runId,
        steerCommandId: control.expectedInput === "pending" ? null : control.commandId,
      });
      const command = await database
        .selectFrom("commands")
        .select("status")
        .where("id", "=", control.commandId)
        .executeTakeFirstOrThrow();
      expect(command.status).toBe(control.expectedCommand);
    }
    expect(await store.listPendingCommands()).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("resumes offline settlement of a Run with a large live node set", async () => {
  const fixture = await createStoreFixture();
  const { database } = fixture;
  try {
    const run = await fixture.startRunFixture("offline-node-batches");
    await sql`insert into execution_nodes(id,run_id,attempt_id,kind,title,native_ref,status,started_at,phases)
      select 'nod_90000000-0000-4000-8000-'||lpad(n::text,12,'0'), run_id, id,
        'subagent', ${"🌱".repeat(110)}, 'fixture:'||n, 'running', clock_timestamp(), '[]'::jsonb
      from run_attempts cross join generate_series(1,140) n where run_id=${run.runId} and status='current'`.execute(
      database,
    );
    await sql`insert into execution_nodes(id,run_id,attempt_id,kind,title,native_ref,status,started_at,ended_at,phases,result)
      select 'nod_90000000-0000-4000-8000-000000000999', run_id, id, 'subagent', 'Trace the tap',
        'fixture:done', 'completed', clock_timestamp(), clock_timestamp(), '[]'::jsonb,
        ${"Lost in PayButton.tsx:42.\n" + "x".repeat(480)}
      from run_attempts where run_id=${run.runId} and status='current'`.execute(database);
    // A subagent's settled approval from before the upgrade, stored on the subagent that asked.
    const approval = RequestSchema.parse({
      ...liveRequest({
        harnessInstanceId: run.harnessInstance.id,
        id: createId("request"),
        requestedBy: run.userId,
        runId: run.runId,
        threadId: run.threadId,
        presentation: {
          kind: "choice",
          title: "Run this command?",
          options: [{ id: "allow", label: "Allow once", hint: "allow-once" }],
        },
      }),
      kind: "harness.approval",
      payload: { kind: "harness.approval" },
      originatingNodeId: "nod_90000000-0000-4000-8000-000000000999",
      status: "fulfilled",
      response: { kind: "choice", optionId: "allow" },
      resolvedAt: new Date().toISOString(),
      resolvedBy: run.userId,
    });
    await database.insertInto("requests").values(requestInsert(approval)).execute();
    await preparePersonalConversion(database);
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
      from transcript_items where run_id=${run.runId} and kind='node'
        and id<>'node:nod_90000000-0000-4000-8000-000000000999'`.execute(database);
    expect(cards.rows).toEqual([{ count: "140", maxBytes: 192 }]);
    // A subagent that had settled before conversion keeps what it found on its card.
    const found = await sql<{ view: { preview?: string; truncated?: boolean } }>`select view
      from transcript_items where id='node:nod_90000000-0000-4000-8000-000000000999'`.execute(
      database,
    );
    expect(found.rows[0]?.view.preview).toBe(`Lost in PayButton.tsx:42. ${"x".repeat(480)}`);
    expect(found.rows[0]?.view.truncated).toBeUndefined();
    // Converted on the subagent, its approval is drawn in the task, and only there.
    const scope = { kind: "thread", threadId: run.threadId } as const;
    const task = await readTranscriptPage(database, {
      viewerId: run.userId,
      scope,
      anchorItemId: `request:${approval.id}`,
    });
    const subagent = await readTranscriptItem(database, {
      viewerId: run.userId,
      scope: { ...scope, kind: "node", nodeId: approval.originatingNodeId! },
      itemId: `request:${approval.id}`,
    });
    if (task.kind !== "page") throw new Error("Expected history");
    expect(task.items.filter(({ kind }) => kind === "request")).toEqual([
      expect.objectContaining({
        id: `request:${approval.id}`,
        nodeId: null,
        view: expect.objectContaining({ preview: "Fulfilled · Allow once" }),
      }),
    ]);
    expect(subagent).toEqual({ kind: "unavailable" });
  } finally {
    await fixture.close();
  }
});

test("0125 retires only tabs with explicit deletion provenance, preserves device-removal and ambiguous archived tabs, and advances durable sync stamps only when rows retire", async () => {
  const clone = await cloneTestDatabase("host");
  const database = createDatabase<DatabaseSchema>({ connectionString: clone.url });
  try {
    await sql`drop schema public cascade; create schema public`.execute(database);
    const all = await migrationProvider().getMigrations();
    const through0124 = Object.fromEntries(
      Object.entries(all).filter(([name]) => name <= "0124_agent_session_device_holds"),
    );
    await migrateToLatest(database, {
      async getMigrations() {
        return through0124;
      },
    });
    const owner = await seedPersonalFixture(database, "/fixture/retire-archived-tabs");
    const store = new OpensteerStore(database);
    const principal = await database
      .selectFrom("principals")
      .select("id")
      .where("userId", "=", owner.userId)
      .executeTakeFirstOrThrow();

    // Enable remote access so a second computer can enroll and then be removed via real revokeRunner.
    const enabled = {
      generation: 1,
      mode: "private" as const,
      routeOrigin: "https://personal.test.invalid",
      updatedAt: new Date(),
    };
    await database
      .insertInto("personalRemoteAccess")
      .values({ singletonKey: "personal", ...enabled })
      .onConflict((c) => c.column("singletonKey").doUpdateSet(enabled))
      .execute();

    // A second computer that will be removed via real revokeRunner (device removal).
    const removedRunnerId = createId("runner");
    await enrollTestRunner(store, {
      createdBy: owner.userId,
      environmentId: createId("environment"),
      runnerId: removedRunnerId,
      runnerKind: "local",
      name: "Old Laptop",
      tokenSuffix: removedRunnerId,
      allowedModules: personalReachableGrant,
      modules: { browser: { runtimeId: removedRunnerId, wireVersion: 2 } },
    });

    const deletedLocalProfile = createId("browserProfile");
    const deletedCommandProfile = createId("browserProfile");
    const removedDeviceProfile = createId("browserProfile");
    const ambiguousArchivedProfile = createId("browserProfile");
    const activeProfile = createId("browserProfile");
    await database
      .insertInto("browserProfiles")
      .values([
        {
          id: deletedLocalProfile,
          ownerId: owner.userId,
          homeRunnerId: owner.runnerId,
          name: "Deleted Local",
          archivedAt: new Date("2026-01-01T00:00:00Z"),
        },
        {
          id: deletedCommandProfile,
          ownerId: owner.userId,
          homeRunnerId: owner.runnerId,
          name: "Deleted By Command",
          archivedAt: new Date("2026-01-02T00:00:00Z"),
        },
        {
          id: removedDeviceProfile,
          ownerId: owner.userId,
          homeRunnerId: removedRunnerId,
          name: "Removed Device Profile",
          archivedAt: null,
        },
        {
          id: ambiguousArchivedProfile,
          ownerId: owner.userId,
          homeRunnerId: owner.runnerId,
          name: "Ambiguous Archived",
          archivedAt: new Date("2026-01-03T00:00:00Z"),
        },
        {
          id: activeProfile,
          ownerId: owner.userId,
          homeRunnerId: owner.runnerId,
          name: "Active",
          archivedAt: null,
        },
      ])
      .execute();

    // Provenance A: explicit local erasure row (`pending-computer`) for deletedLocalProfile.
    await database
      .insertInto("browserProfileDeletions")
      .values({
        deletionId: crypto.randomUUID(),
        profileId: deletedLocalProfile,
        bindingVersion: 1,
        deploymentId: owner.deploymentId,
        runnerId: owner.runnerId,
        storageInstanceId: crypto.randomUUID(),
        bindingId: crypto.randomUUID(),
        engine: "chromium",
        state: "pending-computer",
        deletedAt: null,
      })
      .execute();

    // Provenance B: explicit succeeded `browser.profile.delete` command receipt for deletedCommandProfile.
    await database
      .insertInto("commands")
      .values({
        id: createId("command"),
        requestedBy: owner.userId,
        actorPrincipalId: principal.id,
        authoritySource: jsonValue({
          kind: "mcp",
          callerKind: "connection",
          callerKey: "connection:conn_test",
        }),
        idempotencyKey: `delete-${deletedCommandProfile}`,
        type: "browser.profile.delete",
        payload: jsonValue({
          request: { profileId: deletedCommandProfile },
          result: { deletion: null },
        }),
        status: "succeeded",
        environmentId: null,
        threadId: null,
        runId: null,
        dispatcherId: null,
        lastError: null,
      })
      .execute();

    // Bind removedDeviceProfile to removedRunnerId and run the real device removal sequence.
    await bindBrowserProfile(
      database,
      LocalProfileBindingSchema.parse({
        version: 1,
        profileId: removedDeviceProfile,
        deploymentId: owner.deploymentId,
        runnerId: removedRunnerId,
        storageInstanceId: crypto.randomUUID(),
        bindingId: crypto.randomUUID(),
        engine: "chromium",
      }),
    );

    const archivedOpenTab = TabIdSchema.parse(`tab_${crypto.randomUUID()}`);
    const deletedCommandTab = TabIdSchema.parse(`tab_${crypto.randomUUID()}`);
    const archivedClosedTab = TabIdSchema.parse(`tab_${crypto.randomUUID()}`);
    const activeClosedTab = TabIdSchema.parse(`tab_${crypto.randomUUID()}`);
    const singleGroupTab = TabIdSchema.parse(`tab_${crypto.randomUUID()}`);
    const mixedArchivedTab = TabIdSchema.parse(`tab_${crypto.randomUUID()}`);
    const mixedActiveTab = TabIdSchema.parse(`tab_${crypto.randomUUID()}`);
    const removedDeviceTab = TabIdSchema.parse(`tab_${crypto.randomUUID()}`);
    const ambiguousArchivedTab = TabIdSchema.parse(`tab_${crypto.randomUUID()}`);
    const guestTab = TabIdSchema.parse(`tab_${crypto.randomUUID()}`);
    const singleGroupId = `tgp_${crypto.randomUUID()}`;
    const mixedGroupId = `tgp_${crypto.randomUUID()}`;
    const removedDeviceGroupId = `tgp_${crypto.randomUUID()}`;
    const unrelatedGroupId = `tgp_${crypto.randomUUID()}`;
    const alreadyEmptyGroupId = `tgp_${crypto.randomUUID()}`;

    await sql`
      insert into personal_tabs(id, owner_id, kind, computer_id, title, url, profile_id, profile_name, opened_by, closed_at)
      values
        (${archivedOpenTab}, ${owner.userId}, 'page', ${owner.runnerId}, 'Archived Open', 'https://archived.test/open', ${deletedLocalProfile}, 'Deleted Local', '"person"'::jsonb, null),
        (${deletedCommandTab}, ${owner.userId}, 'page', ${owner.runnerId}, 'Deleted Cmd', 'https://archived.test/cmd', ${deletedCommandProfile}, 'Deleted By Command', '"person"'::jsonb, null),
        (${archivedClosedTab}, ${owner.userId}, 'page', ${owner.runnerId}, 'Archived Closed', 'https://archived.test/closed', ${deletedLocalProfile}, 'Deleted Local', '"person"'::jsonb, '2026-02-02T00:00:00Z'::timestamptz),
        (${activeClosedTab}, ${owner.userId}, 'page', ${owner.runnerId}, 'Active Closed', 'https://active.test/closed', ${activeProfile}, 'Active', '"person"'::jsonb, '2026-02-01T00:00:00Z'::timestamptz),
        (${singleGroupTab}, ${owner.userId}, 'page', ${owner.runnerId}, 'Single Group', 'https://archived.test/group', ${deletedLocalProfile}, 'Deleted Local', '"person"'::jsonb, null),
        (${mixedArchivedTab}, ${owner.userId}, 'page', ${owner.runnerId}, 'Mixed Archived', 'https://archived.test/mixed', ${deletedLocalProfile}, 'Deleted Local', '"person"'::jsonb, null),
        (${mixedActiveTab}, ${owner.userId}, 'page', ${owner.runnerId}, 'Mixed Active', 'https://active.test/mixed', ${activeProfile}, 'Active', '"person"'::jsonb, null),
        (${removedDeviceTab}, ${owner.userId}, 'page', ${removedRunnerId}, 'Removed Device Saved', 'https://removed-device.test/', ${removedDeviceProfile}, 'Removed Device Profile', '"person"'::jsonb, null),
        (${ambiguousArchivedTab}, ${owner.userId}, 'page', ${owner.runnerId}, 'Ambiguous Saved', 'https://ambiguous.test/', ${ambiguousArchivedProfile}, 'Ambiguous Archived', '"person"'::jsonb, null),
        (${guestTab}, ${owner.userId}, 'page', ${owner.runnerId}, 'Guest', 'https://guest.test/', null, null, '"person"'::jsonb, null)
    `.execute(database);

    // Run real device removal (`revokeRunner`): archives removedDeviceProfile with state='unconfirmed' and keeps its open saved tab.
    await store.revokeRunner(removedRunnerId, owner.userId, {
      administration: {
        requestedBy: owner.userId,
        idempotencyKey: `revoke-${removedRunnerId}`,
        type: "machine.revoke",
        request: { runnerId: removedRunnerId },
        authoritySource: { kind: "user-session", userId: owner.userId },
      },
    });

    const beforeItems = [
      { kind: "tab", tabId: archivedOpenTab },
      { kind: "tab", tabId: deletedCommandTab },
      { kind: "tab", tabId: ambiguousArchivedTab },
      {
        kind: "group",
        group: {
          groupId: singleGroupId,
          name: "Single Archived",
          color: "red",
          collapsed: false,
          tabIds: [singleGroupTab],
        },
      },
      {
        kind: "group",
        group: {
          groupId: mixedGroupId,
          name: "Mixed",
          color: "blue",
          collapsed: false,
          tabIds: [mixedArchivedTab, mixedActiveTab],
        },
      },
      {
        kind: "group",
        group: {
          groupId: removedDeviceGroupId,
          name: "Removed Device Group",
          color: "yellow",
          collapsed: false,
          tabIds: [removedDeviceTab],
        },
      },
      {
        kind: "group",
        group: {
          groupId: unrelatedGroupId,
          name: "Guest Group",
          color: "grey",
          collapsed: false,
          tabIds: [guestTab],
        },
      },
      {
        kind: "group",
        group: {
          groupId: alreadyEmptyGroupId,
          name: "Empty Unrelated",
          color: "green",
          collapsed: false,
          tabIds: [],
        },
      },
    ];
    await database
      .insertInto("tabLayouts")
      .values({
        ownerId: owner.userId,
        revision: 5,
        items: sql`${JSON.stringify(beforeItems)}::jsonb`,
      })
      .execute();

    // Capture client_sync_state sequence & resource_revisions before running 0125.
    const syncBefore = await database
      .selectFrom("clientSyncState")
      .select(["sequence", "resourceRevisions"])
      .where("deploymentId", "=", owner.deploymentId)
      .executeTakeFirstOrThrow();
    const expectedNextSequence = String(BigInt(syncBefore.sequence) + 1n);

    // Run migrations up to latest (including 0125).
    await migrateToLatest(database);

    const remainingIds = (
      await database
        .selectFrom("personalTabs")
        .select("id")
        .where("ownerId", "=", owner.userId)
        .execute()
    )
      .map((row) => row.id)
      .toSorted();
    expect(remainingIds).toEqual(
      [
        activeClosedTab,
        ambiguousArchivedTab,
        guestTab,
        mixedActiveTab,
        removedDeviceTab,
      ].toSorted(),
    );

    const layout = await database
      .selectFrom("tabLayouts")
      .select(["revision", "items"])
      .where("ownerId", "=", owner.userId)
      .executeTakeFirstOrThrow();
    expect(Number(layout.revision)).toBe(6);
    expect(layout.items).toEqual([
      { kind: "tab", tabId: ambiguousArchivedTab },
      {
        kind: "group",
        group: {
          groupId: mixedGroupId,
          name: "Mixed",
          color: "blue",
          collapsed: false,
          tabIds: [mixedActiveTab],
        },
      },
      {
        kind: "group",
        group: {
          groupId: removedDeviceGroupId,
          name: "Removed Device Group",
          color: "yellow",
          collapsed: false,
          tabIds: [removedDeviceTab],
        },
      },
      {
        kind: "group",
        group: {
          groupId: unrelatedGroupId,
          name: "Guest Group",
          color: "grey",
          collapsed: false,
          tabIds: [guestTab],
        },
      },
      {
        kind: "group",
        group: {
          groupId: alreadyEmptyGroupId,
          name: "Empty Unrelated",
          color: "green",
          collapsed: false,
          tabIds: [],
        },
      },
    ]);

    // Durable sync stamps (`sequence`, `tab`, and `tab-layout`) advance atomically when rows retire.
    const syncAfter = await database
      .selectFrom("clientSyncState")
      .select(["sequence", "resourceRevisions"])
      .where("deploymentId", "=", owner.deploymentId)
      .executeTakeFirstOrThrow();
    expect(syncAfter.sequence).toBe(expectedNextSequence);
    expect(syncAfter.resourceRevisions).toMatchObject({
      tab: expectedNextSequence,
      "tab-layout": expectedNextSequence,
      "browser-profile": syncBefore.resourceRevisions["browser-profile"],
    });

    // Running 0125 again when 0 rows retire leaves sequence and resource_revisions unchanged.
    await all["0125_retire_archived_profile_tabs"]!.up(database);
    const syncNoop = await database
      .selectFrom("clientSyncState")
      .select(["sequence", "resourceRevisions"])
      .where("deploymentId", "=", owner.deploymentId)
      .executeTakeFirstOrThrow();
    expect(syncNoop.sequence).toBe(expectedNextSequence);
    expect(syncNoop.resourceRevisions).toMatchObject({
      tab: expectedNextSequence,
      "tab-layout": expectedNextSequence,
      "browser-profile": syncBefore.resourceRevisions["browser-profile"],
    });

    // Archived closed tab no longer hijacks latestClosed reopen.
    const reopened = await new TabStore(database).reopen(owner.userId, undefined, "reopen-latest");
    expect(reopened.tabIds).toEqual([activeClosedTab]);
  } finally {
    await database.destroy();
    await clone.drop();
  }
});

test("0125 advances durable client_sync_state sequence and tab/tab-layout revisions only when rows retire", async () => {
  const clone = await cloneTestDatabase("host");
  const database = createDatabase({ connectionString: clone.url });
  try {
    await sql`drop schema public cascade; create schema public`.execute(database);
    const all = await migrationProvider().getMigrations();
    const through0124 = Object.fromEntries(
      Object.entries(all).filter(([name]) => name < "0125_retire_archived_profile_tabs"),
    );
    await migrateToLatest(database, {
      async getMigrations() {
        return through0124;
      },
    });
    const owner = await seedPersonalFixture(database, "/fixture/retire-archived-tabs-sync");
    const deletedProfile = createId("browserProfile");
    await database
      .insertInto("browserProfiles")
      .values({
        id: deletedProfile,
        ownerId: owner.userId,
        homeRunnerId: owner.runnerId,
        name: "Deleted Local",
        archivedAt: new Date("2026-01-01T00:00:00Z"),
      })
      .execute();
    await database
      .insertInto("browserProfileDeletions")
      .values({
        deletionId: crypto.randomUUID(),
        profileId: deletedProfile,
        bindingVersion: 1,
        deploymentId: owner.deploymentId,
        runnerId: owner.runnerId,
        storageInstanceId: crypto.randomUUID(),
        bindingId: crypto.randomUUID(),
        engine: "chromium",
        state: "pending-computer",
        deletedAt: null,
      })
      .execute();
    const deletedTab = TabIdSchema.parse(`tab_${crypto.randomUUID()}`);
    await sql`
      insert into personal_tabs(id, owner_id, kind, computer_id, title, url, profile_id, profile_name, opened_by, closed_at)
      values (${deletedTab}, ${owner.userId}, 'page', ${owner.runnerId}, 'Deleted Tab', 'https://deleted.test/', ${deletedProfile}, 'Deleted Local', '"person"'::jsonb, null)
    `.execute(database);

    const syncBefore = await database
      .selectFrom("clientSyncState")
      .select(["sequence", "resourceRevisions"])
      .where("deploymentId", "=", owner.deploymentId)
      .executeTakeFirstOrThrow();
    const expectedNextSequence = String(BigInt(syncBefore.sequence) + 1n);

    await migrateToLatest(database);

    const syncAfter = await database
      .selectFrom("clientSyncState")
      .select(["sequence", "resourceRevisions"])
      .where("deploymentId", "=", owner.deploymentId)
      .executeTakeFirstOrThrow();
    expect(syncAfter.sequence).toBe(expectedNextSequence);
    expect(syncAfter.resourceRevisions).toMatchObject({
      tab: expectedNextSequence,
      "tab-layout": expectedNextSequence,
      "browser-profile": syncBefore.resourceRevisions["browser-profile"],
    });

    // Running 0125 again when 0 rows retire leaves sequence and resource_revisions unchanged.
    await all["0125_retire_archived_profile_tabs"]!.up(database);
    const syncNoop = await database
      .selectFrom("clientSyncState")
      .select(["sequence", "resourceRevisions"])
      .where("deploymentId", "=", owner.deploymentId)
      .executeTakeFirstOrThrow();
    expect(syncNoop.sequence).toBe(expectedNextSequence);
    expect(syncNoop.resourceRevisions).toMatchObject({
      tab: expectedNextSequence,
      "tab-layout": expectedNextSequence,
      "browser-profile": syncBefore.resourceRevisions["browser-profile"],
    });
  } finally {
    await database.destroy();
    await clone.drop();
  }
});

test("0125 preserves a future client_sync_state.last_commit_at when retiring archived profile tabs", async () => {
  const clone = await cloneTestDatabase("host");
  const database = createDatabase({ connectionString: clone.url });
  try {
    await sql`drop schema public cascade; create schema public`.execute(database);
    const all = await migrationProvider().getMigrations();
    const through0124 = Object.fromEntries(
      Object.entries(all).filter(([name]) => name < "0125_retire_archived_profile_tabs"),
    );
    await migrateToLatest(database, {
      async getMigrations() {
        return through0124;
      },
    });
    const owner = await seedPersonalFixture(database, "/fixture/retire-archived-tabs-future-clock");
    const deletedProfile = createId("browserProfile");
    await database
      .insertInto("browserProfiles")
      .values({
        id: deletedProfile,
        ownerId: owner.userId,
        homeRunnerId: owner.runnerId,
        name: "Deleted Future Clock",
        archivedAt: new Date("2026-01-01T00:00:00Z"),
      })
      .execute();
    await database
      .insertInto("browserProfileDeletions")
      .values({
        deletionId: crypto.randomUUID(),
        profileId: deletedProfile,
        bindingVersion: 1,
        deploymentId: owner.deploymentId,
        runnerId: owner.runnerId,
        storageInstanceId: crypto.randomUUID(),
        bindingId: crypto.randomUUID(),
        engine: "chromium",
        state: "pending-computer",
        deletedAt: null,
      })
      .execute();
    const deletedTab = TabIdSchema.parse(`tab_${crypto.randomUUID()}`);
    await sql`
      insert into personal_tabs(id, owner_id, kind, computer_id, title, url, profile_id, profile_name, opened_by, closed_at)
      values (${deletedTab}, ${owner.userId}, 'page', ${owner.runnerId}, 'Deleted Tab', 'https://deleted.test/', ${deletedProfile}, 'Deleted Future Clock', '"person"'::jsonb, null)
    `.execute(database);

    const futureCommitAt = new Date("2099-01-01T00:00:00.000Z");
    await database
      .updateTable("clientSyncState")
      .set({ lastCommitAt: futureCommitAt })
      .where("deploymentId", "=", owner.deploymentId)
      .execute();

    await migrateToLatest(database);

    const syncAfter = await database
      .selectFrom("clientSyncState")
      .select(["sequence", "lastCommitAt", "resourceRevisions"])
      .where("deploymentId", "=", owner.deploymentId)
      .executeTakeFirstOrThrow();
    expect(syncAfter.lastCommitAt.toISOString()).toBe(futureCommitAt.toISOString());
  } finally {
    await database.destroy();
    await clone.drop();
  }
});
