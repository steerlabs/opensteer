import type { DatabaseSchema } from "./schema.js";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { expect, test } from "vitest";
import { createDatabase } from "./connection.js";
import { withLockOrderMode } from "./lock-order-checker.test-support.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import { preparePersonalConversion } from "./personal-state.test-support.js";
import { finishPersonalStateUpgrade } from "./personal-state-upgrade.js";
import { authorizedSyncState, withPersonalSyncRead } from "./personal-sync-store.js";
import {
  buildPersonalShellSnapshot,
  buildPersonalDetailSnapshot,
} from "./personal-snapshot-store.js";
import { ScopedHostMessageSchema } from "@opensteer/protocol/personal-sync";
import { createStoreFixture } from "./store.integration.test-support.js";
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
  const { database } = fixture;
  try {
    const run = await fixture.startRunFixture(`personal-perf-${events}`);
    await preparePersonalConversion(database, events + 100);
    const current = await database
      .selectFrom("runs")
      .select("actorPrincipalId")
      .where("id", "=", run.runId)
      .executeTakeFirstOrThrow();
    const messageCount = Math.floor((events * 5) / 6);
    const tools = Math.floor(events / 60);
    const createdAt = new Date();
    const author = {
      kind: "agent",
      displayName: "Opensteer",
      runId: run.runId,
      threadId: run.threadId,
    };
    const content = [{ type: "text", text: "A retained assistant update" }];
    // These rows represent messages that predate the migration's fast default.
    await sql`insert into messages(id,thread_id,run_id,sequence,kind,actor_principal_id,author,content,created_at,published)
      select 'msg_90000000-0000-4000-8000-'||lpad(n::text,12,'0'),${run.threadId},${run.runId},n+1,'assistant',${current.actorPrincipalId},
        ${JSON.stringify(author)}::jsonb,${JSON.stringify(content)}::jsonb,${createdAt},true
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
    await database
      .updateTable("runs")
      .set({ nextRunnerOrdinal: events + 1 })
      .where("id", "=", run.runId)
      .execute();
    await sql`insert into provider_sessions(id,thread_id,harness_instance_id,active,state_layout,binding_generation,status)
      select 'perf-retired-session-'||n,thread_id,harness_instance_id,false,state_layout,n,'stopped'
      from provider_sessions cross join generate_series(1,512) n
      where thread_id=${run.threadId} and active`.execute(database);
    await sql`insert into commands(id,environment_id,thread_id,run_id,requested_by,actor_principal_id,authority_source,idempotency_key,type,payload,status)
      select 'perf-retired-command-'||n,environment_id,thread_id,run_id,requested_by,actor_principal_id,
        authority_source,idempotency_key||':retired:'||n,type,payload,'failed'
      from commands cross join generate_series(1,512) n where id=${run.turn.command.id}`.execute(
      database,
    );
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
      const target = createDatabase<DatabaseSchema>({ connectionString: fixture.databaseUrl });
      return { target, close: () => target.destroy() };
    });
    const settled = await target
      .selectFrom("runs")
      .select("status")
      .where("id", "=", run.runId)
      .executeTakeFirstOrThrow();
    expect(settled.status).toBe("interrupted");
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
    // A task keeps one input row per message it was ever sent.
    await sql`insert into thread_inputs(message_id,thread_id,actor_principal_id,authority_source,causal_chain_id,
        idempotency_key,policy,queue_rank,request_fingerprint,requested_by,state,delivered_at)
      select 'msg_90000000-0000-4000-8000-'||lpad(n::text,12,'0'),input.thread_id,input.actor_principal_id,
        input.authority_source,input.causal_chain_id,input.idempotency_key||':perf:'||n,'queue',n,
        input.request_fingerprint,input.requested_by,'delivered',now()
      from thread_inputs input cross join generate_series(1,${Math.min(messageCount, 50_000)}) n
      where input.thread_id=${run.threadId} limit ${Math.min(messageCount, 50_000)}`.execute(
      target,
    );
    await sql`analyze thread_inputs, messages, transcript_items`.execute(target);
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
      channelAuthority:
        await explain(sql`select 1 from thread_inputs where thread_id=${run.threadId}
        and state in ('pending','claimed','unknown') and authority_source->>'kind'='channel-ingress'`),
      // A Run with no reply is the worst case: nothing stops the scan early.
      runReply:
        await explain(sql`select content,id,sequence from messages where thread_id=${run.threadId}
        and run_id='run_00000000-0000-4000-8000-000000000000' and kind='assistant'
        and addressed_to_user_id is null order by sequence desc limit 1`),
      toolCard: await explain(
        sql`select id from transcript_items where tool_call_id=(select id from tool_calls limit 1)`,
      ),
    };
    expect(JSON.stringify(plans.channelAuthority)).toContain("thread_inputs_channel_authority");
    expect(JSON.stringify(plans.runReply)).toContain("messages_run_sequence");
    expect(JSON.stringify(plans.toolCard)).toContain("transcript_tool_call");
    expect(JSON.stringify(plans.detail)).toContain("transcript_root");
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
      for (const result of results)
        expect(result.conversion.observedHeapGrowthBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
      expect(results[1]!.queryMs.shell.p95).toBeLessThan(500);
      expect(results[1]!.queryMs.detail.p95).toBeLessThan(500);
    });
  },
  600_000,
);
