import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { expect, test } from "vitest";
import { createDatabase } from "./connection.js";
import { withLockOrderMode } from "./lock-order-checker.test-support.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import { applyPersonalStateSchema, type PersonalStateSchema } from "./personal-state-schema.js";
import { finishPersonalStateUpgrade } from "./personal-state-upgrade.js";
import { authorizedSyncState, withPersonalSyncRead } from "./personal-sync-store.js";
import {
  buildPersonalShellSnapshot,
  buildPersonalDetailSnapshot,
} from "./personal-snapshot-store.js";
import { ScopedHostMessageSchema } from "@opensteer/protocol/personal-sync";
import { createStoreFixture, pendingEvent } from "./store.integration.test-support.js";
import { ownTestDatabaseProducer } from "./test-database.test-support.js";

const enabled = process.env.OPENSTEER_PERSONAL_STATE_PERF === "1";

function distribution(values: number[]) {
  const ordered = values.toSorted((a, b) => a - b);
  return {
    count: ordered.length,
    p50: ordered[Math.ceil(ordered.length * 0.5) - 1],
    p95: ordered[Math.ceil(ordered.length * 0.95) - 1],
    max: ordered.at(-1),
  };
}

async function measure(events: number) {
  const fixture = await createStoreFixture();
  const { database, store } = fixture;
  try {
    const run = await fixture.startRunFixture(`personal-perf-${events}`);
    const current = await database
      .selectFrom("runs")
      .select("actorPrincipalId")
      .where("id", "=", run.runId)
      .executeTakeFirstOrThrow();
    const messageCount = Math.floor((events * 5) / 6);
    const tools = Math.floor(events / 60);
    const createdAt = new Date();
    const author = { kind: "agent", harnessInstanceId: run.harnessInstance.id };
    const content = [{ type: "text", text: "A retained assistant update" }];
    await sql`insert into messages(id,thread_id,run_id,sequence,kind,actor_principal_id,author,content,created_at)
      select 'msg_90000000-0000-4000-8000-'||lpad(n::text,12,'0'),${run.threadId},${run.runId},n+1,'assistant',${current.actorPrincipalId},
        ${JSON.stringify(author)}::jsonb,${JSON.stringify(content)}::jsonb,${createdAt}
      from generate_series(1,${messageCount}) n`.execute(database);
    await sql`insert into deployment_events(deployment_id,sequence,event_id,thread_id,run_id,environment_id,type,data,
      created_at,runner_ordinal,runner_id,runner_boot_id,runner_binding_generation)
      select ${run.deploymentId},n+100,'evt_90000000-0000-4000-8000-'||lpad(n::text,12,'0'),${run.threadId},${run.runId},${run.environmentId},
        case when n<=${messageCount} then 'assistant.message'
          when n<=${messageCount + tools} then 'tool.started'
          when n<=${messageCount + tools * 2} then 'tool.completed' else 'reasoning.completed' end,
        case when n<=${messageCount} then jsonb_build_object('messageId','msg_90000000-0000-4000-8000-'||lpad(n::text,12,'0'),'content',${JSON.stringify(content)}::jsonb)
          when n<=${messageCount + tools} then jsonb_build_object('callId','perf:'||(n-${messageCount}::int),
            'arguments','{}'::jsonb,'tool','{"namespace":"native","name":"read"}'::jsonb)
          when n<=${messageCount + tools * 2} then jsonb_build_object('callId','perf:'||(n-${messageCount + tools}::int),
            'isError',false,'output','{"text":"Work completed","images":[{"path":"/fixture/perf.png","mediaType":"image/png"}]}'::jsonb)
          else jsonb_build_object('blockId','perf:'||n,'text','Retained reasoning') end,
        ${createdAt},n,${run.runnerId},${run.runnerBootId},${run.bindingGeneration}
      from generate_series(1,${events}) n`.execute(database);
    await sql`update deployment_event_state set sequence=${events + 100} where deployment_id=${run.deploymentId}`.execute(
      database,
    );
    await database
      .updateTable("runs")
      .set({ nextRunnerOrdinal: events + 1 })
      .where("id", "=", run.runId)
      .execute();
    await store.commitRunnerEvent({
      runnerId: run.runnerId,
      runnerBootId: run.runnerBootId,
      environmentId: run.environmentId,
      event: pendingEvent({
        type: "run.completed",
        data: { status: "completed" },
        runId: run.runId,
        threadId: run.threadId,
        bindingGeneration: run.bindingGeneration,
        environmentId: run.environmentId,
        ordinal: events + 1,
      }),
    });
    await database.transaction().execute(applyPersonalStateSchema);
    const start = performance.now();
    globalThis.gc?.();
    const startMemory = process.memoryUsage();
    let observedHeap = startMemory.heapUsed;
    let observedRss = startMemory.rss;
    const peakByStage: Record<string, number> = {};
    let previousBatch = start;
    const batches: number[] = [];
    await finishPersonalStateUpgrade(database, {
      afterBatch(stage) {
        const memory = process.memoryUsage();
        observedHeap = Math.max(observedHeap, memory.heapUsed);
        observedRss = Math.max(observedRss, memory.rss);
        peakByStage[stage] = Math.max(peakByStage[stage] ?? 0, memory.heapUsed);

        const now = performance.now();
        batches.push(now - previousBatch);
        previousBatch = now;
      },
    });
    const conversionMs = performance.now() - start;
    globalThis.gc?.();
    const conversion = {
      ms: conversionMs,
      observedHeapGrowthBytes: observedHeap - startMemory.heapUsed,
      observedRssGrowthBytes: observedRss - startMemory.rss,
      postGcHeapGrowthBytes: globalThis.gc
        ? process.memoryUsage().heapUsed - startMemory.heapUsed
        : null,
      peakByStage,

      batchMs: distribution(batches),
    };
    const { target } = await ownTestDatabaseProducer(fixture.databaseUrl, async () => {
      const target = createDatabase<PersonalStateSchema>({ connectionString: fixture.databaseUrl });
      return { target, close: () => target.destroy() };
    });
    const counts = (
      await sql<{ items: string; tools: string }>`select
      (select count(*) from transcript_items where visible) as items,
      (select count(*) from tool_calls) as tools`.execute(target)
    ).rows[0]!;
    expect(Number(counts.items)).toBeGreaterThanOrEqual(messageCount + tools);
    expect(Number(counts.tools)).toBe(tools);
    const shellScope = { kind: "shell" as const };
    const detailScope = { kind: "thread" as const, threadId: run.threadId };
    const detail = () =>
      withPersonalSyncRead(target, async (tx) => {
        const state = await authorizedSyncState(tx, run.userId);
        return ScopedHostMessageSchema.parse({
          type: "host.snapshot",
          scope: detailScope,
          subscriptionId: "detail:0",
          generation: 1,
          throughSequence: state.sequence,
          snapshot: await buildPersonalDetailSnapshot(tx, state, run.userId, detailScope),
        });
      });
    const shell = () =>
      withPersonalSyncRead(target, async (tx) => {
        const state = await authorizedSyncState(tx, run.userId);
        return ScopedHostMessageSchema.parse({
          type: "host.snapshot",
          scope: shellScope,
          subscriptionId: "shell",
          generation: 1,
          throughSequence: state.sequence,
          snapshot: await buildPersonalShellSnapshot(tx, state, run.userId, run.threadId),
        });
      });
    const windowMs: number[] = [],
      detailMs: number[] = [],
      settingsMs: number[] = [];
    let shellBytes = 0,
      detailBytes = 0;
    for (let i = 0; i < 20; i++) {
      let started = performance.now();
      const window = await shell();
      windowMs.push(performance.now() - started);
      shellBytes = Math.max(shellBytes, Buffer.byteLength(JSON.stringify(window)));
      started = performance.now();
      const page = await detail();
      detailMs.push(performance.now() - started);
      detailBytes = Math.max(detailBytes, Buffer.byteLength(JSON.stringify(page)));
      started = performance.now();
      await commitPersonalMutation(target, async (_tx, mutation) =>
        mutation.bumpResource("settings"),
      );
      settingsMs.push(performance.now() - started);
    }
    const explain = async (query: ReturnType<typeof sql>) =>
      (await sql`explain(analyze,buffers,format json) ${query}`.execute(target)).rows;
    const plans = {
      tasks:
        await explain(sql`select id,title from threads where listed and removed_at is null and done_at is null
        and status<>'archived' order by asked_at desc,id desc limit 26`),
      detail: await explain(sql`select id,position,revision,view from transcript_items
        where visible and thread_id=${run.threadId} and node_id is null order by position desc,id desc limit 101`),
      anchor: await explain(
        sql`select id,position,revision,view from transcript_items where id='msg_90000000-0000-4000-8000-000000000050' and thread_id=${run.threadId} limit 1`,
      ),
      openTools:
        await explain(sql`select id from tool_calls where run_id=${run.runId} and status='open'
        and binding_generation=${run.bindingGeneration} order by id limit 11`),
      image:
        await explain(sql`select id from tool_output_images where thread_id=${run.threadId} and node_id is null
        and path_hash=sha256('/fixture/perf.png'::bytea) and path='/fixture/perf.png'
        order by completion_order desc,image_index desc limit 1`),
      attention:
        await explain(sql`select pending_request_count,unread_task_count from client_sync_state
        where deployment_id=${run.deploymentId} limit 1`),
      receipts: await explain(
        sql`select reported_digest from runner_event_receipts where run_id=${run.runId} and ordinal=0 limit 1`,
      ),
    };
    expect(shellBytes).toBeLessThanOrEqual(96 * 1024);
    expect(detailBytes).toBeLessThanOrEqual(128 * 1024);
    return {
      events,
      counts,
      conversion,
      queryMs: {
        shell: distribution(windowMs),
        detail: distribution(detailMs),
        settingsCommit: distribution(settingsMs),
      },
      shellBytes,
      detailBytes,
      plans,
    };
  } finally {
    await fixture.close();
  }
}

test.skipIf(!enabled)(
  "measures standalone personal conversion and indexed reads at 10k and 600k events",
  async () => {
    // The correctness fixtures enforce lock order. Row lock instrumentation scans whole tables.
    await withLockOrderMode("off", async () => {
      const out =
        process.env.OPENSTEER_PERSONAL_STATE_PERF_OUT ??
        join(tmpdir(), "opensteer-personal-state-perf.json");
      const results = [];
      for (const rows of [10_000, 600_000]) {
        results.push(await measure(rows));
        await writeFile(out, JSON.stringify(results, null, 2) + "\n");
      }
      expect(results[1]!.queryMs.shell.p95).toBeLessThan(500);
      expect(results[1]!.queryMs.detail.p95).toBeLessThan(500);
    });
  },
  600_000,
);
