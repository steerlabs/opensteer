import { createId } from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import { expect, test } from "vitest";
import { createDatabase } from "./connection.js";
import { ensureDeployment } from "./deployment-store.js";
import { applyPersonalStateSchema, type PersonalStateSchema } from "./personal-state-schema.js";
import { finishPersonalStateUpgrade } from "./personal-state-upgrade.js";
import type { DatabaseSchema } from "./schema.js";
import { createStoreFixture, pendingEvent } from "./store.integration.test-support.js";
import { cloneTestDatabase } from "./test-database.test-support.js";
import { outputImagePathHash } from "./transcript-store.js";

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
      await database.transaction().execute(applyPersonalStateSchema);
      await finishPersonalStateUpgrade(database);
      await finishPersonalStateUpgrade(database);
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

    const newer = await sql<{ nextTranscriptPosition: string }>`update threads
      set next_transcript_position=next_transcript_position+1 where id=${active.threadId}
      returning next_transcript_position`.execute(database);
    const order = newer.rows[0]!.nextTranscriptPosition;
    const original = await target
      .selectFrom("toolOutputImages")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(BigInt(order)).toBeGreaterThan(BigInt(original.completionOrder));
    const newerTool = {
      ...tools[2]!,
      id: "new-image-tool",
      callId: "new-image",
      completionOrder: order,
    };
    await target.insertInto("toolCalls").values(newerTool).execute();
    await target
      .insertInto("toolOutputImages")
      .values({
        ...original,
        id: "newer-image",
        toolCallId: newerTool.id,
        completionOrder: order,
      })
      .execute();
    const latest = await target
      .selectFrom("toolOutputImages")
      .select("id")
      .where("threadId", "=", active.threadId)
      .where("pathHash", "=", outputImagePathHash(imagePath))
      .where("path", "=", imagePath)
      .orderBy("completionOrder", "desc")
      .orderBy("imageIndex", "desc")
      .limit(1)
      .executeTakeFirstOrThrow();
    expect(latest.id).toBe("newer-image");
  } finally {
    await fixture.close();
  }
});
