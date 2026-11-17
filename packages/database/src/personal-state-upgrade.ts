import { sql, type Kysely, type Transaction } from "kysely";
import {
  type DeploymentId,
  type MessageId,
  type RunId,
  type ThreadId,
  nonTerminalRunStatuses,
} from "@opensteer/core";
import { z } from "zod";
import { checkoutSession } from "./connection.js";
import { publishedMessagePredicate } from "./message-visibility.js";
import { runOfflineSettlement } from "./personal-transaction.js";
import { finalizeRunTransaction } from "./run-finalization.js";
import { threadPathLinks } from "./store-primitives.js";
import type { DatabaseSchema } from "./schema.js";
import {
  importLegacyActivity,
  readLegacyActivityBatch,
  type LegacyImportCounts,
} from "./personal-state-upgrade-activity.js";

export const personalCurrentStateMigrationName = "0029_personal_current_state";

const batchSize = 500;
const canonicalKinds = [
  "message",
  "run",
  "request",
  "node",
  "assignment",
  "delegation",
  "app",
] as const;

const cursorSchema = z.strictObject({
  stage: z.enum([
    "settle",
    ...canonicalKinds,
    "ledger",
    "close-tools",
    "summaries",
    "attention-requests",
    "attention-asks",
    "attention-links",
    "verify",
    "finalize",
  ]),
  key: z.string(),
  position: z.string().regex(/^\d+$/),
  reserved: z.string().regex(/^\d+$/),
  through: z.string().regex(/^\d+$/),
  counts: z.strictObject({
    tools: z.number().int().nonnegative(),
    images: z.number().int().nonnegative(),
    reasoning: z.number().int().nonnegative(),
    nodeMessages: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }),
});

type UpgradeCursor = z.infer<typeof cursorSchema>;
type CanonicalKind = (typeof canonicalKinds)[number];
type Tx = Transaction<DatabaseSchema>;
type Source = { readonly id: DeploymentId; readonly sequence: string; readonly cutAt: Date };

const initialCursor: UpgradeCursor = {
  stage: "settle",
  key: "",
  position: "0",
  reserved: "0",
  through: "0",
  counts: { tools: 0, images: 0, reasoning: 0, nodeMessages: 0, skipped: 0 },
};

function stage(cursor: UpgradeCursor, next: UpgradeCursor["stage"]): UpgradeCursor {
  return { ...cursor, key: "", stage: next };
}

async function countCanonical(tx: Tx) {
  const result = await sql<{ count: string }>`
    select (select count(*) from messages)
      + (select count(*) from runs)
      + (select count(*) from requests)
      + (select count(*) from execution_nodes)
      + (select count(*) from delegations)
      + (select count(*) from delegations where result_status <> 'pending')
      + (select count(*) from apps where thread_id is not null and latest_version > 0 and not deleting)
      as count
  `.execute(tx);
  return result.rows[0]!.count;
}

async function settleNextRun(tx: Tx, source: Source, cursor: UpgradeCursor) {
  const run = await tx
    .selectFrom("runs")
    .select(["id", "seedInputId", "threadId"])
    .where("id", ">", cursor.key as RunId)
    .where("status", "in", nonTerminalRunStatuses)
    .orderBy("id")
    .limit(1)
    .executeTakeFirst();
  if (!run) {
    const expected = await countCanonical(tx);
    return { ...stage(cursor, "message"), reserved: expected };
  }
  // Keep a marker for a seed whose input settlement will cancel it. The message
  // pass derives its actual visibility and assigns its canonical fallback.
  await sql`
    insert into transcript_items(id,thread_id,run_id,kind,visible,is_turn_start,created_at,message_id,view)
    select m.id,m.thread_id,${run.id},'message',false,false,m.created_at,m.id,'{}'
    from messages m join thread_inputs i on i.message_id = m.id
    where m.id = ${run.seedInputId} and i.state in ('pending','claimed')
    on conflict (id) do nothing
  `.execute(tx);
  await runOfflineSettlement(tx, () =>
    finalizeRunTransaction(tx, {
      completedAt: source.cutAt,
      links: threadPathLinks,
      source: "host",
      queuedInputCancellation: "seed-input",
      runId: run.id,
      status: "interrupted",
    }),
  );
  return { ...cursor, key: run.id };
}

async function deriveMessages(tx: Tx, cursor: UpgradeCursor): Promise<UpgradeCursor> {
  const key = cursor.key
    ? z.tuple([z.string(), z.string()]).parse(JSON.parse(cursor.key))
    : ["", "0"];
  const page = await sql<{ id: MessageId; threadId: ThreadId; sequence: string }>`
    select id,thread_id,sequence from messages where (thread_id,sequence) > (${key[0]},${key[1]}::bigint)
      order by thread_id,sequence limit ${batchSize}
  `.execute(tx);
  const last = page.rows.at(-1);
  if (!last) return stage(cursor, "run");
  const ids = page.rows.map((row) => row.id);
  await tx
    .selectFrom("messages")
    .select("id")
    .where("id", "in", ids)
    .orderBy("id")
    .forNoKeyUpdate()
    .execute();
  await sql`
    update messages m set published=${publishedMessagePredicate("input")}
    from messages source left join thread_inputs input on input.message_id=source.id
    where source.id=m.id and m.id=any(${ids}::text[])
  `.execute(tx);
  await sql`select id from transcript_items where id=any(${ids}::text[]) order by id for no key update`.execute(
    tx,
  );
  await sql`
    insert into transcript_items(id,thread_id,run_id,kind,position,visible,is_turn_start,created_at,message_id,view)
    with derived as (
      select m.id,m.thread_id,m.sequence,coalesce(m.run_id,seed.id) as run_id,m.kind,m.author,
        m.revision,m.created_at, input.policy,
        m.published,
        seed.id is not null and input.state in ('pending','claimed') or marker.id is not null as admitted,
        seed.id is not null as is_seed,
        exists (
          select 1 from jsonb_array_elements(m.content) part
          where part->>'type' in ('artifact','browser-page','computer-app','phone')
            or (part->>'type' = 'text' and part->>'text' ~ '[^[:space:]]')
          limit 1
        ) as has_content,
        coalesce((
          select left(part->>'text',200) from jsonb_array_elements(m.content) part
          where part->>'type' = 'text' and part->>'text' ~ '[^[:space:]]' limit 1
        ),'') as preview
      from messages m left join thread_inputs input on input.message_id=m.id
      left join transcript_items marker on marker.id=m.id
      left join lateral (
        select id from runs where seed_input_id=m.id and thread_id=m.thread_id
        order by run_ordinal desc limit 1
      ) seed on true
      where m.id=any(${ids}::text[])
    ), cards as (
      select *, (
        has_content and (published or coalesce(admitted,false))
        and (author->>'cause') is distinct from 'claude-compaction'
        and (kind in ('input','assistant') or coalesce(author->>'cause' = 'assignment-result',false)
          or (kind='continuation' and coalesce(author->>'cause' = 'run-recovery',false)))
      ) as shown,
      ${cursor.position}::bigint + row_number() over(order by thread_id,sequence) as fallback
      from derived
    )
    select id,thread_id,run_id,'message',case when shown then fallback end,shown,
        shown and kind='input' and policy is distinct from 'report'
          and (author->>'kind'='human' or run_id is null or is_seed),
        created_at,id,jsonb_build_object('author',author->>'kind','preview',preview,'published',published,
          'edited',revision>0,'truncated',length(preview)=200)
      from cards
      order by id
      on conflict (id) do update set position=excluded.position,visible=excluded.visible,
        is_turn_start=excluded.is_turn_start,view=excluded.view,run_id=excluded.run_id
  `.execute(tx);
  return {
    ...cursor,
    key: JSON.stringify([last.threadId, last.sequence]),
    position: (BigInt(cursor.position) + BigInt(page.rows.length)).toString(),
  };
}

function canonicalSource(kind: Exclude<CanonicalKind, "message">, key: string) {
  switch (kind) {
    case "run":
      return sql`select id as source_id,thread_id,id as run_id,created_at,status,
        null::text as attempt_id,null::text as node_id,null::text as title,true as visible
        from runs where id > ${key} order by id limit ${batchSize}`;
    case "request":
      return sql`select r.id as source_id,r.originating_thread_id as thread_id,r.originating_run_id as run_id,
        r.created_at,r.status,n.attempt_id,r.originating_node_id as node_id,left(r.presentation->>'title',192) as title,
        r.status <> 'pending' or r.mode='live' as visible
        from requests r left join execution_nodes n on n.id=r.originating_node_id
        where r.id > ${key} order by r.id limit ${batchSize}`;
    case "node":
      return sql`select n.id as source_id,r.thread_id,n.run_id,n.started_at as created_at,n.status,
        n.attempt_id,n.parent_node_id as node_id,left(n.title,192) as title,true as visible
        from execution_nodes n join runs r on r.id=n.run_id where n.id > ${key} order by n.id limit ${batchSize}`;
    case "assignment":
      return sql`select id as source_id,child_thread_id as thread_id,child_run_id as run_id,created_at,status,
        null::text as attempt_id,null::text as node_id,left(objective,192) as title,true as visible
        from delegations where id > ${key} order by id limit ${batchSize}`;
    case "delegation":
      return sql`select id as source_id,parent_thread_id as thread_id,parent_run_id as run_id,coalesce(completed_at,created_at) as created_at,status,
        null::text as attempt_id,null::text as node_id,left(objective,192) as title,true as visible
        from delegations where id > ${key} and result_status <> 'pending' order by id limit ${batchSize}`;
    case "app":
      return sql`select id as source_id,thread_id,run_id,created_at,null::text as status,
        null::text as attempt_id,null::text as node_id,left(name,192) as title,true as visible
        from apps where id > ${key} and thread_id is not null and latest_version > 0 and not deleting order by id limit ${batchSize}`;
  }
}

async function deriveCards(tx: Tx, cursor: UpgradeCursor, kind: Exclude<CanonicalKind, "message">) {
  const page = await sql<{ id: string }>`
      insert into transcript_items(id,thread_id,run_id,attempt_id,node_id,kind,position,visible,is_turn_start,created_at,
        request_id,execution_node_id,delegation_id,app_id,view)
      select ${kind}::text || ':' || source_id,thread_id,run_id,attempt_id,node_id,${kind},
        case when visible then ${cursor.position}::bigint + row_number() over (order by source_id) end,
        visible,false,created_at,
        case when ${kind}='request' then source_id end,
        case when ${kind}='node' then source_id end,
        case when ${kind} in ('assignment','delegation') then source_id end,
        case when ${kind}='app' then source_id end,
        jsonb_strip_nulls(jsonb_build_object('status',status,'title',title))
        from (${canonicalSource(kind, cursor.key)}) source order by source_id returning id
  `.execute(tx);
  const ids = page.rows.map((row) => row.id.slice(kind.length + 1));
  const last = ids.at(-1);
  if (!last) {
    if (kind === "app" && cursor.position !== cursor.reserved)
      throw new Error("Personal conversion canonical card count changed");
    return stage(cursor, canonicalKinds[canonicalKinds.indexOf(kind) + 1] ?? "ledger");
  }
  if (kind === "run") {
    await sql`select id from runs where id = any(${ids}::text[]) order by id for no key update`.execute(
      tx,
    );
    await sql`update runs r set execute_claim_state=case
      when exists (select 1 from commands where run_id=r.id and type='run.execute' and attempts=0 limit 1) then 'unclaimed'
      when exists (select 1 from commands where run_id=r.id and type='run.execute' limit 1) then 'claimed'
      else 'not-created' end where r.id = any(${ids}::text[])`.execute(tx);
  }
  return {
    ...cursor,
    key: last,
    position: (BigInt(cursor.position) + BigInt(page.rows.length)).toString(),
  } satisfies UpgradeCursor;
}

async function closeOpenTools(tx: Tx, source: Source, cursor: UpgradeCursor) {
  const page = await sql<{ id: string }>`
    select id from tool_calls where status='open' and id > ${cursor.key} order by id limit ${batchSize} for no key update
  `.execute(tx);
  const last = page.rows.at(-1);
  if (!last) return stage(cursor, "summaries");
  const ids = page.rows.map((row) => row.id);
  const itemIds = ids.map((id) => `tool:${id}`);
  await sql`update tool_calls set status='interrupted',completed_at=${source.cutAt} where id = any(${ids}::text[])`.execute(
    tx,
  );
  await sql`select id from transcript_items where id=any(${itemIds}::text[]) order by id for no key update`.execute(
    tx,
  );
  await sql`update transcript_items set view=view||'{"status":"interrupted"}' where id = any(${itemIds}::text[])`.execute(
    tx,
  );
  return { ...cursor, key: last.id };
}

async function deriveThreadSummaries(tx: Tx, source: Source, cursor: UpgradeCursor) {
  const page = await tx
    .selectFrom("threads")
    .select("id")
    .where("id", ">", cursor.key as ThreadId)
    .orderBy("id")
    .limit(batchSize)
    .execute();
  const last = page.at(-1);
  if (!last) return stage(cursor, "attention-requests");
  await tx
    .selectFrom("threads")
    .select("id")
    .where(
      "id",
      "in",
      page.map((row) => row.id),
    )
    .orderBy("id")
    .forNoKeyUpdate()
    .execute();
  await sql`
    update threads t set
      next_transcript_position=${(BigInt(cursor.reserved) + BigInt(source.sequence)).toString()}::bigint,
      pending_request_count=summary.pending,
      latest_run_completed_at=summary.completed_at,
      last_reply_message_id=summary.reply_id,
      last_reply_preview=summary.reply,
      failure_preview=summary.failure,
      status=case when t.status='archived' then t.status when summary.pending > 0 then 'waiting'
        when summary.status='failed' then 'failed' else 'idle' end
    from (
      select source_thread.id,
        (select count(*) from requests where originating_thread_id=source_thread.id and status='pending')
          + (select count(*) from thread_inputs where thread_id=source_thread.id and state='awaiting-approval') as pending,
        case when latest.status in ('completed','failed','interrupted') then latest.completed_at end as completed_at,
        latest.status,
        case when latest.status='failed' then left(latest.failure->>'message',280) end as failure,
        reply.id as reply_id,left(reply.view->>'preview',280) as reply
      from threads source_thread
      left join lateral (
        select status,completed_at,failure from runs where thread_id=source_thread.id and maintenance is null
        order by run_ordinal desc limit 1
      ) latest on true
      left join lateral (
        select m.id,i.view from messages m join transcript_items i on i.message_id=m.id
        where m.thread_id=source_thread.id and m.published and m.kind='assistant' and i.visible
        order by m.sequence desc limit 1
      ) reply on true
      where source_thread.id = any(${page.map((row) => row.id)}::text[])
    ) summary where t.id=summary.id
  `.execute(tx);
  return { ...cursor, key: last.id };
}

async function deriveAttentionRequests(tx: Tx, cursor: UpgradeCursor) {
  const page = await sql<{ id: string }>`
    insert into personal_attention(id,kind,request_id,thread_id,sort_at)
    select 'request:'||id,'request',id,originating_thread_id,created_at from requests
    where status='pending' and id > ${cursor.key} order by id limit ${batchSize} returning id
  `.execute(tx);
  const last = page.rows.at(-1);
  return last
    ? { ...cursor, key: last.id.slice("request:".length) }
    : stage(cursor, "attention-asks");
}

async function deriveAttentionAsks(tx: Tx, source: Source, cursor: UpgradeCursor) {
  const key = cursor.key
    ? z.tuple([z.string(), z.string()]).parse(JSON.parse(cursor.key))
    : ["", ""];
  const page = await sql<{ teamDeploymentId: string; teamRequestId: string }>`
    insert into personal_attention(id,kind,team_deployment_id,team_request_id,thread_id,sort_at,expires_at)
    select 'team:'||team_deployment_id||':'||request_id,
      case when terminal_state='failed' then 'failed-ask' else 'team-ask' end,
      team_deployment_id,request_id,local_task_id,created_at,
      case when terminal_state is null then consent_expires_at end
    from personal_team_requests where kind='ask'
      and (team_deployment_id,request_id)>(${key[0]},${key[1]})
      and ((remote_state='awaiting_approval' and local_decision is null and terminal_state is null
        and consent_expires_at > ${source.cutAt})
        or (terminal_state='failed' and released_at is null and blocked_reason is not null))
    order by team_deployment_id,request_id limit ${batchSize}
    returning team_deployment_id,team_request_id
  `.execute(tx);
  const last = page.rows.at(-1);
  return last
    ? { ...cursor, key: JSON.stringify([last.teamDeploymentId, last.teamRequestId]) }
    : stage(cursor, "attention-links");
}

async function deriveAttentionLinks(tx: Tx, source: Source, cursor: UpgradeCursor) {
  const page = await sql<{ id: string }>`
    select id from personal_team_links where id>${cursor.key} order by id limit ${batchSize} for no key update
  `.execute(tx);
  const last = page.rows.at(-1);
  if (last) {
    await sql`update personal_team_links link set approval_attention_count=(
      select count(*) from personal_attention where kind='team-ask' and team_deployment_id=link.team_deployment_id
    ) where id=any(${page.rows.map((row) => row.id)}::text[])`.execute(tx);
    return { ...cursor, key: last.id };
  }
  await sql`update client_sync_state set
      pending_request_count=(select count(*) from personal_attention where kind='request'),
      needs_you_count=(select count(*) from personal_attention where kind in ('request','failed-ask'))
        + coalesce((select sum(approval_attention_count) from personal_team_links
          where state in ('active','unreachable','needs_update')),0),
      unread_task_count=(select count(*) from threads t left join thread_visits v on v.thread_id=t.id and v.user_id=t.created_by
        where t.listed and t.purpose='task' and t.status<>'archived' and t.removed_at is null
          and t.latest_run_completed_at is not null and (v.last_visited_at is null or t.latest_run_completed_at>v.last_visited_at))
      where deployment_id=${source.id}`.execute(tx);
  return stage(cursor, "verify");
}

async function verifyConversion(tx: Tx, cursor: UpgradeCursor) {
  const parity = (
    await sql<{
      canonical: string;
      tools: string;
      toolCards: string;
      images: string;
      reasoning: string;
      nodeMessages: string;
      invalid: boolean;
    }>`
    select (select count(*) from transcript_items where kind not in ('tool','reasoning','node-message')) as canonical,
      (select count(*) from tool_calls) as tools,
      (select count(*) from transcript_items where kind='tool') as tool_cards,
      (select count(*) from tool_output_images) as images,
      (select count(*) from transcript_items where kind='reasoning') as reasoning,
      (select count(*) from transcript_items where kind='node-message') as node_messages,
      (exists(select 1 from transcript_items i join threads t on t.id=i.thread_id where i.position>t.next_transcript_position limit 1)
        or exists(select 1 from tool_calls c join threads t on t.id=c.thread_id where c.completion_order>t.next_transcript_position limit 1)
        or exists(select 1 from messages m where not exists(select 1 from transcript_items where message_id=m.id limit 1) limit 1)
        or exists(select 1 from runs r where not exists(select 1 from transcript_items where id='run:'||r.id limit 1) limit 1)
        or exists(select 1 from requests r where not exists(select 1 from transcript_items where request_id=r.id limit 1) limit 1)
        or exists(select 1 from execution_nodes n where not exists(select 1 from transcript_items where execution_node_id=n.id limit 1) limit 1)
        or exists(select 1 from delegations d where not exists(select 1 from transcript_items where id='assignment:'||d.id limit 1) limit 1)
        or exists(select 1 from delegations d where result_status<>'pending'
          and not exists(select 1 from transcript_items where id='delegation:'||d.id limit 1) limit 1)
        or exists(select 1 from apps a where thread_id is not null and latest_version>0 and not deleting
          and not exists(select 1 from transcript_items where id='app:'||a.id limit 1) limit 1)
        or exists(select 1 from runner_event_receipts limit 1)) as invalid
  `.execute(tx)
  ).rows[0]!;
  if (
    parity.invalid ||
    parity.canonical !== cursor.reserved ||
    Number(parity.tools) !== cursor.counts.tools ||
    parity.tools !== parity.toolCards ||
    Number(parity.images) !== cursor.counts.images ||
    Number(parity.reasoning) !== cursor.counts.reasoning ||
    Number(parity.nodeMessages) !== cursor.counts.nodeMessages
  ) {
    throw new Error("Personal conversion parity check failed");
  }
  return stage(cursor, "finalize");
}

async function dropOldState(tx: Tx) {
  await sql`drop table deployment_events,thread_state_pending;
    alter table threads drop column projected_input_queue_paused;
    alter table client_sync_state drop column upgrade_cursor`.execute(tx);
}

async function convertBatch(
  tx: Tx,
): Promise<{ stage: UpgradeCursor["stage"]; done: boolean } | null> {
  const schema = (
    await sql<{
      legacy: boolean;
    }>`select to_regclass('deployment_events') is not null as legacy`.execute(tx)
  ).rows[0];
  if (!schema?.legacy) return null;
  const deployment = (
    await sql<{ id: DeploymentId; kind: string }>`
    select id,deployment_shape->>'kind' as kind from deployments where singleton_key='primary' limit 1
  `.execute(tx)
  ).rows[0];
  if (deployment?.kind !== "personal") {
    const unexpected = (
      await sql<{ present: boolean }>`select
      (exists(select 1 from deployment_events limit 1) or exists(select 1 from client_sync_state limit 1)) as present`.execute(
        tx,
      )
    ).rows[0];
    if (unexpected?.present)
      throw new Error("Unexpected personal event history outside a personal Deployment");
    await dropOldState(tx);
    return { stage: "finalize", done: true };
  }
  const state = (
    await sql<{
      deploymentId: DeploymentId;
      sequence: string;
      ready: boolean;
      lastCommitAt: Date;
      upgradeCursor: unknown;
    }>`select deployment_id,sequence,ready,last_commit_at,upgrade_cursor from client_sync_state
      where deployment_id=${deployment.id} for no key update`.execute(tx)
  ).rows[0];
  if (!state || state.ready) throw new Error("Personal conversion has no unready deployment fence");
  const source: Source = {
    id: state.deploymentId,
    sequence: state.sequence,
    cutAt: state.lastCommitAt,
  };
  const cursor =
    state.upgradeCursor === null
      ? { ...initialCursor, through: state.sequence }
      : cursorSchema.parse(state.upgradeCursor);
  if (state.sequence !== cursor.through) throw new Error("Personal conversion head changed");
  let next: UpgradeCursor;
  switch (cursor.stage) {
    case "settle":
      next = await settleNextRun(tx, source, cursor);
      break;
    case "message":
      next = await deriveMessages(tx, cursor);
      break;
    case "ledger": {
      const page = await readLegacyActivityBatch(tx, source.id, cursor.key || "0", source.sequence);
      const last = page.at(-1);
      if (!last) {
        next = stage(cursor, "close-tools");
      } else {
        const imported = await importLegacyActivity(tx, page, cursor.reserved);
        const counts: LegacyImportCounts = { ...cursor.counts };
        for (const key of Object.keys(counts) as (keyof LegacyImportCounts)[])
          counts[key] += imported[key];
        next = { ...cursor, key: last.sequence, counts };
      }
      break;
    }
    case "close-tools":
      next = await closeOpenTools(tx, source, cursor);
      break;
    case "summaries":
      next = await deriveThreadSummaries(tx, source, cursor);
      break;
    case "attention-requests":
      next = await deriveAttentionRequests(tx, cursor);
      break;
    case "attention-asks":
      next = await deriveAttentionAsks(tx, source, cursor);
      break;
    case "attention-links":
      next = await deriveAttentionLinks(tx, source, cursor);
      break;
    case "verify":
      next = await verifyConversion(tx, cursor);
      break;
    case "finalize":
      await sql`update client_sync_state set ready=true,pruned_through_sequence=sequence
        where deployment_id=${source.id} and sequence=${source.sequence}::bigint`.execute(tx);
      await dropOldState(tx);
      await sql`analyze threads,messages,runs,transcript_items,tool_calls,tool_output_images,personal_attention`.execute(
        tx,
      );
      return { stage: cursor.stage, done: true };
    default:
      next = await deriveCards(tx, cursor, cursor.stage);
  }
  await sql`update client_sync_state set upgrade_cursor=${JSON.stringify(next)}::jsonb
    where deployment_id=${source.id} and sequence=${source.sequence}::bigint`.execute(tx);
  return { stage: cursor.stage, done: false };
}

export async function withPersonalStateStartupLock<Result>(
  database: Kysely<DatabaseSchema>,
  run: (signal: AbortSignal) => Promise<Result>,
) {
  const session = await checkoutSession(database);
  const controller = new AbortController();
  let acquired = false;
  const lost = (error?: Error) =>
    controller.abort(error ?? new Error("The migration lock session ended"));
  const end = () => lost();
  session.on("error", lost);
  session.on("end", end);
  try {
    await session.query("select pg_advisory_lock(hashtextextended('opensteer-host-migration',0))");
    acquired = true;
    controller.signal.throwIfAborted();
    const result = await run(controller.signal);
    controller.signal.throwIfAborted();
    return result;
  } finally {
    try {
      if (acquired && !controller.signal.aborted)
        await session.query(
          "select pg_advisory_unlock(hashtextextended('opensteer-host-migration',0))",
        );
    } finally {
      session.off("error", lost);
      session.off("end", end);
      session.release(
        controller.signal.aborted ? new Error("Migration lock session ended") : undefined,
      );
    }
  }
}

export async function completePersonalStateConversion(
  database: Kysely<DatabaseSchema>,
  signal: AbortSignal,
  options?: { readonly afterBatch?: (stage: UpgradeCursor["stage"]) => void },
): Promise<void> {
  for (;;) {
    signal.throwIfAborted();
    const batch = await database.transaction().execute(async (tx) => {
      const result = await convertBatch(tx);
      signal.throwIfAborted();
      return result;
    });
    if (!batch) return;
    options?.afterBatch?.(batch.stage);
    if (batch.done) break;
  }
}

export function finishPersonalStateUpgrade(
  database: Kysely<DatabaseSchema>,
  options?: Parameters<typeof completePersonalStateConversion>[2],
) {
  return withPersonalStateStartupLock(database, (signal) =>
    completePersonalStateConversion(database, signal, options),
  );
}
