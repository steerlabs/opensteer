import { describeTranscriptRun, transcriptRuns } from "./execution-changes.js";
import { describeTranscriptRequest, requestFromRow } from "./request-persistence.js";
import { itemView } from "./personal-sync-store.js";
import { sql, type Kysely, type Transaction } from "kysely";
import {
  type DeploymentId,
  type DeploymentKind,
  deploymentPolicy,
  MessageIdSchema,
  type MessageAuthor,
  type MessageId,
  type MessageKind,
  type TeamSource,
  type ThreadInputPolicy,
  ExecutionNodeIdSchema,
  type RunId,
  type ThreadId,
  nonTerminalRunStatuses,
} from "@opensteer/core";
import { z } from "zod";
import { resendableControlCommandTypes } from "./command-delivery.js";
import { checkoutSession } from "./connection.js";
import { describeTranscriptMessage, transcriptMessageTextBytes } from "./transcript-store.js";
import { messageEditFromRow } from "./thread-row-mappers.js";
import { runOfflineSettlement } from "./personal-transaction.js";
import { createNextPersonalTranscriptOrderIndex } from "./personal-state-schema.js";
import { finalizeRunTransaction } from "./run-finalization.js";
import { threadPathLinks } from "./store-primitives.js";
import type { DatabaseSchema } from "./schema.js";
import {
  convertLegacyActivityBatch,
  legacyAttemptIdPattern,
  legacyRunIdPattern,
} from "./personal-state-upgrade-activity.js";

export const personalCurrentStateMigrationName = "0036_personal_current_state";

const batchSize = 500;
const messageBatchSize = 500;
const verifyBatchSize = 500;
const messageIdPattern = z.toJSONSchema(MessageIdSchema, { io: "input" }).pattern!;
const nodeIdPattern = z.toJSONSchema(ExecutionNodeIdSchema, { io: "input" }).pattern!;
const settlementBatchSize = 128;
const messageWhitespace =
  "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
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
    "run-details",
    "close-tools",
    "summaries",
    "attention-requests",
    "attention-asks",
    "attention-links",
    "verify",
    "index",
    "analyze",
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
type Deployment = { readonly id: DeploymentId; readonly kind: DeploymentKind };

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

const offlineCommandTypes = ["run.execute", "run.steer", ...resendableControlCommandTypes];

async function retireOfflineDelivery(tx: Tx, runId: RunId, cutAt: Date) {
  // A team reply target is unique to its admitted Run. It cannot be admitted again.
  const inputs = await sql<{ message_id: MessageId; can_requeue: boolean; delivery: string }>`
      select i.message_id, i.policy='queue' and not (
        i.message_id=r.seed_input_id and (r.reply_target->>'kind'='team-thread') is true
      ) as can_requeue,
        case
          when c.type='run.steer' and c.status='succeeded' then 'delivered'
          when (i.steer_command_id is null or c.type='run.restart') and
            a.first_event_at >= i.updated_at then 'delivered'
          when c.type='run.steer' and c.status in ('pending','failed') and c.attempts=0 then 'unsent'
          when c.type='run.restart' and a.reason='steer_restart'
            and a.dispatched_at is null then 'unsent'
          when i.steer_command_id is null and i.policy<>'report'
            and (r.binding_generation is null or (a.id is not null and a.dispatched_at is null))
            then 'unsent'
          else 'unknown'
        end as delivery
      from thread_inputs i join runs r on r.id=i.run_id
      left join commands c on c.id=i.steer_command_id and c.run_id=i.run_id
      left join run_attempts a on a.run_id=i.run_id and a.status='current'
      where i.run_id=${runId} and i.state='claimed'
      order by i.message_id limit ${settlementBatchSize} for no key update of i
  `.execute(tx.withoutPlugins());
  if (inputs.rows.length) {
    await sql`
      update thread_inputs i set
        state=case
          when b.delivery='delivered' then 'delivered'
          when b.delivery='unsent' and b.can_requeue then 'pending'
          when b.delivery='unsent' then 'cancelled'
          else 'unknown' end,
        delivered_at=case when b.delivery='delivered' then coalesce(i.delivered_at,${cutAt}) end,
        cancel_reason=case when b.delivery='unsent' and not b.can_requeue
          then case when i.steer_command_id is null then 'run-ended-before-start' else 'steer-not-delivered' end
        end,
        run_id=case when b.delivery='unsent' and b.can_requeue then null else i.run_id end,
        steer_command_id=case when b.delivery='unsent' and b.can_requeue then null else i.steer_command_id end,
        updated_at=${cutAt}
      from jsonb_to_recordset(${JSON.stringify(inputs.rows)}::jsonb)
        as b(message_id text, can_requeue boolean, delivery text) where i.message_id=b.message_id
    `.execute(tx);
    const requeued = inputs.rows
      .filter((row) => row.can_requeue && row.delivery === "unsent")
      .map(({ message_id }) => message_id);
    if (requeued.length) {
      await tx
        .selectFrom("messages")
        .select("id")
        .where("id", "in", requeued)
        .orderBy("id")
        .forNoKeyUpdate()
        .execute();
      await tx.updateTable("messages").set({ runId: null }).where("id", "in", requeued).execute();
    }
    return true;
  }
  const batch = await sql<{ id: string; unsent: boolean }>`
      select c.id, (
        (c.status='pending' and c.attempts=0)
        or (c.type='run.execute' and r.binding_generation is null)
      ) as unsent
      from commands c join runs r on r.id=c.run_id
      where c.run_id=${runId} and c.type=any(${offlineCommandTypes}::text[])
        and c.status in ('pending','dispatched')
      order by c.id limit ${settlementBatchSize} for no key update of c
  `.execute(tx);
  if (!batch.rows.length) return false;
  const commands = await sql`
    update commands c set status=case when b.unsent then 'failed' else 'unknown' end,
      last_error=jsonb_build_object('message',case when b.unsent then
        'The Run ended during upgrade before dispatch' else
        'The Run ended during upgrade before delivery could be confirmed' end),
      updated_at=${cutAt}
    from jsonb_to_recordset(${JSON.stringify(batch.rows)}::jsonb)
      as b(id text, unsent boolean) where c.id=b.id
  `.execute(tx);
  return Boolean(commands.numAffectedRows);
}

async function retireOfflineChildren(tx: Tx, runId: RunId, cutAt: Date) {
  // The regular finalizer settles the same live Request set with its response commands.
  const requests = await tx
    .selectFrom("requests")
    .select("id")
    .where("originatingRunId", "=", runId)
    .where(
      sql<boolean>`status='pending' and (mode='live' or (kind in ('plugin.approval','plugin.input') and not exists (select 1 from plugin_executions where request_id=requests.id and handoff)))`,
    )
    .orderBy("id")
    .limit(settlementBatchSize)
    .forNoKeyUpdate()
    .execute();
  if (requests.length) {
    const ids = requests.map(({ id }) => id);
    await tx
      .updateTable("requests")
      .set({
        cancellationReason: "run-ended",
        resolvedAt: cutAt,
        resolvedBy: null,
        responseCommandId: null,
        status: "cancelled",
      })
      .where("id", "in", ids)
      .execute();
    return true;
  }
  const nodes = await tx
    .selectFrom("executionNodes")
    .select("id")
    .where("runId", "=", runId)
    .where(sql<boolean>`status='running'`)
    .orderBy("id")
    .limit(settlementBatchSize)
    .forNoKeyUpdate()
    .execute();
  if (nodes.length) {
    await tx
      .updateTable("executionNodes")
      .set({ endedAt: cutAt, status: "interrupted" })
      .where(
        "id",
        "in",
        nodes.map(({ id }) => id),
      )
      .execute();
    return true;
  }
  const grants = await tx
    .selectFrom("grants")
    .select("id")
    .where("runId", "=", runId)
    .where(sql<boolean>`status='active'`)
    .orderBy("id")
    .limit(settlementBatchSize)
    .forNoKeyUpdate()
    .execute();
  if (!grants.length) return false;
  await tx
    .updateTable("grants")
    .set({ status: "revoked", revokedReason: "superseded", revokedAt: cutAt })
    .where(
      "id",
      "in",
      grants.map(({ id }) => id),
    )
    .execute();
  return true;
}

async function settleNextRun(tx: Tx, source: Source, cursor: UpgradeCursor) {
  const run = await tx
    .selectFrom("runs")
    .select(["id", "seedInputId", "status"])
    .where("id", ">", cursor.key as RunId)
    .where(
      sql<boolean>`(status=any(${nonTerminalRunStatuses}::text[]) or (status='interrupted' and (
      exists(select 1 from commands c where c.run_id=runs.id and c.type=any(${offlineCommandTypes}::text[])
        and c.status in ('pending','dispatched'))
      or exists(select 1 from thread_inputs i where i.run_id=runs.id and i.state='claimed')
    )))`,
    )
    .orderBy("id")
    .limit(1)
    .executeTakeFirst();
  if (!run) {
    const expected = await countCanonical(tx);
    return { ...stage(cursor, "message"), reserved: expected };
  }
  if (run.status === "interrupted") {
    return (await retireOfflineDelivery(tx, run.id, source.cutAt))
      ? cursor
      : { ...cursor, key: run.id };
  }
  // Keep a marker for a seed whose input settlement will cancel it. The message
  // pass derives its actual visibility and assigns its canonical fallback.
  await sql`
    insert into transcript_items(id,thread_id,run_id,kind,visible,is_turn_start,created_at,message_id,view)
    select m.id,m.thread_id,${run.id},'message',false,false,m.created_at,m.id,'{}'
    from messages m join thread_inputs i on i.message_id = m.id
    where m.id = ${run.seedInputId} and i.state='pending' and ${run.status}='queued'
    on conflict (id) do nothing
  `.execute(tx);
  if (await retireOfflineChildren(tx, run.id, source.cutAt)) return cursor;
  if (await retireOfflineDelivery(tx, run.id, source.cutAt)) return cursor;
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
  const textLimit = transcriptMessageTextBytes + 1;
  type MessageGroup = {
    ids: MessageId[];
    offsets: number[];
    runId: RunId | null;
    kind: MessageKind;
    author: MessageAuthor;
    revision: number;
    editedAt: string | null;
    policy: ThreadInputPolicy | null;
    state: string | null;
    cancelReason: string | null;
    teamSource: TeamSource | null;
    admittedSeed: boolean;
    seedInRun: boolean;
    assigned: boolean;
    hasContent: boolean;
    hasRichParts: boolean;
    text: string;
  };
  const {
    rows: [page],
  } = await sql<{
    key: [ThreadId, string] | null;
    count: number;
    groups: MessageGroup[] | null;
  }>`
    with page as materialized (
      select id,thread_id,sequence,
        row_number() over (order by thread_id,sequence)::int as batch_offset
      from messages
      where (thread_id,sequence) > (${key[0]},${key[1]}::bigint)
      order by thread_id,sequence limit ${messageBatchSize}
    ), derived as (
    select m.id,page.batch_offset,
      placement.run_id as "runId",m.kind,m.author,m.revision,m.edited_at as "editedAt",
      i.policy,i.state,i.cancel_reason as "cancelReason",i.team_source as "teamSource",
      (seed.status in ('queued','starting','running','waiting')) is true
        or marker.id is not null as "admittedSeed",
      (placement.run_id=seed.id) is true as "seedInRun",
      r.assignment_id is not null as assigned,
      content.has_content as "hasContent",content.has_rich_parts as "hasRichParts",content.text
    from page join messages m using (id)
    left join thread_inputs i on i.message_id=m.id
    left join transcript_items marker on marker.id=m.id
    left join lateral (
      select id,status from runs where seed_input_id=m.id and thread_id=m.thread_id
      order by run_ordinal desc limit 1
    ) seed on true
    cross join lateral (
      values (coalesce(m.run_id,i.run_id,marker.run_id,
        case when i.state in ('pending','claimed') then seed.id end))
    ) placement(run_id)
    left join runs r on r.id=placement.run_id
    cross join lateral (
      select coalesce(bool_or(part->>'type' in ('artifact','browser-page','computer-app','phone')),false)
          as has_rich_parts,
        coalesce(bool_or(part->>'type' in ('artifact','browser-page','computer-app','phone')
          or (part->>'type'='text' and btrim(part->>'text',${messageWhitespace})<>'')),false)
          as has_content,
        coalesce(left(string_agg(left(part->>'text',${textLimit}),E'\\n' order by n)
          filter (where part->>'type'='text'),${textLimit}),'') as text
      from jsonb_array_elements(m.content) with ordinality as parts(part,n)
    ) content
    ), groups as (
      select array_agg(id order by batch_offset) as ids,
        array_agg(batch_offset order by batch_offset) as offsets,
        "runId",kind,author,revision,"editedAt",policy,state,"cancelReason","teamSource",
        "admittedSeed","seedInRun",assigned,"hasContent","hasRichParts",text
      from derived group by "runId",kind,author,revision,"editedAt",policy,state,"cancelReason",
        "teamSource","admittedSeed","seedInRun",assigned,"hasContent","hasRichParts",text
    )
    select (select json_build_array(thread_id,sequence::text) from page
        order by batch_offset desc limit 1) as key,
      (select count(*)::int from page) as count,
      (select json_agg(groups) from groups) as groups
  `.execute(tx.withoutPlugins());
  if (!page?.key) return stage(cursor, "run");
  const projected = page.groups!.map((row) => {
    const edit = messageEditFromRow({
      author: row.author,
      revision: row.revision,
      editedAt: row.editedAt ? new Date(row.editedAt) : null,
    });
    const card = describeTranscriptMessage({
      kind: row.kind,
      content: row,
      author: row.author,
      ...(row.policy && row.state ? { policy: row.policy, state: row.state } : {}),
      cancelReason: row.cancelReason,
      ...(row.teamSource ? { teamSource: row.teamSource } : {}),
      ...(edit ? { edit } : {}),
      edited: row.revision > 0,
      admittedSeed: row.admittedSeed,
      seedInRun: row.seedInRun,
      assigned: row.assigned,
    });
    return {
      ids: row.ids,
      offsets: row.offsets,
      run_id: row.runId,
      visible: card.visible,
      published: card.published,
      turn_start: card.isTurnStart,
      view: card.view,
    };
  });
  const cards = sql`(
      select item.id,card.run_id,
        case when card.visible then ${cursor.position}::bigint + item.batch_offset end as position,
        card.visible,card.published,card.turn_start,card.view
      from jsonb_to_recordset(${JSON.stringify(projected)}::jsonb)
        as card(ids text[],offsets int[],run_id text,visible boolean,published boolean,turn_start boolean,view jsonb)
      cross join lateral unnest(card.ids,card.offsets) as item(id,batch_offset)
    )`;
  await sql`select m.id from messages m join ${cards} c on c.id=m.id
    where m.published is distinct from c.published order by m.id for no key update of m`.execute(
    tx,
  );
  await sql`update messages m set published=c.published from ${cards} c
    where m.id=c.id and m.published is distinct from c.published`.execute(tx);
  await sql`select i.id from transcript_items i join ${cards} c on c.id=i.id
    order by i.id for no key update of i`.execute(tx);
  await sql`
    insert into transcript_items(id,thread_id,run_id,kind,position,visible,is_turn_start,created_at,message_id,view)
    select m.id,m.thread_id,c.run_id,'message',c.position,c.visible,c.turn_start,m.created_at,m.id,c.view
    from ${cards} c join messages m on m.id=c.id order by m.id
    on conflict (id) do update set position=excluded.position,visible=excluded.visible,
      is_turn_start=excluded.is_turn_start,view=excluded.view,run_id=excluded.run_id
  `.execute(tx);
  return {
    ...cursor,
    key: JSON.stringify(page.key),
    position: (BigInt(cursor.position) + BigInt(page.count)).toString(),
  };
}

async function deriveRequests(tx: Tx, cursor: UpgradeCursor) {
  const rows = await tx
    .selectFrom("requests")
    .leftJoin("executionNodes", "executionNodes.id", "requests.originatingNodeId")
    .selectAll("requests")
    .select("executionNodes.attemptId")
    .where(sql<boolean>`requests.id > ${cursor.key}`)
    .orderBy("requests.id")
    .limit(settlementBatchSize)
    .execute();
  const last = rows.at(-1);
  if (!last) return stage(cursor, "node");
  const position = BigInt(cursor.position);
  await tx
    .insertInto("transcriptItems")
    .values(
      rows.map((row, index) => {
        const request = requestFromRow(row);
        const visible = request.status !== "pending";
        return {
          id: `request:${row.id}`,
          threadId: row.originatingThreadId,
          runId: row.originatingRunId,
          attemptId: row.attemptId,
          nodeId: row.originatingNodeId,
          kind: "request" as const,
          position: visible ? (position + BigInt(index + 1)).toString() : null,
          visible,
          isTurnStart: false,
          createdAt: row.resolvedAt ?? row.createdAt,
          requestId: row.id,
          view: describeTranscriptRequest(request),
        };
      }),
    )
    .execute();
  return {
    ...cursor,
    key: last.id,
    position: (position + BigInt(rows.length)).toString(),
  };
}

async function deriveRunDetails(tx: Tx, cursor: UpgradeCursor) {
  const runs = await transcriptRuns(tx)
    .where("id", ">", cursor.key as RunId)
    .orderBy("id")
    .limit(batchSize)
    .execute();
  const last = runs.at(-1);
  if (!last) return stage(cursor, "close-tools");
  const cards = runs.map((run) => ({ id: `run:${run.id}`, view: describeTranscriptRun(run) }));
  await tx
    .selectFrom("transcriptItems")
    .select("id")
    .where(
      "id",
      "in",
      cards.map(({ id }) => id),
    )
    .orderBy("id")
    .forNoKeyUpdate()
    .execute();
  await sql`update transcript_items i set view=c.view
    from jsonb_to_recordset(${JSON.stringify(cards)}::jsonb) as c(id text,view jsonb)
    where i.id=c.id`.execute(tx);
  return { ...cursor, key: last.id };
}

function canonicalSource(kind: Exclude<CanonicalKind, "message" | "request">, key: string) {
  switch (kind) {
    case "run":
      return sql`select id as source_id,thread_id,id as run_id,created_at,status,
        null::text as attempt_id,null::text as node_id,null::text as title,true as visible
        from runs where id > ${key} order by id limit ${batchSize}`;
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

async function deriveCards(
  tx: Tx,
  cursor: UpgradeCursor,
  kind: Exclude<CanonicalKind, "message" | "request">,
) {
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
        jsonb_strip_nulls(jsonb_build_object('status',status,'title',
          case when octet_length(title)<=192 then title
          else (select left(title,n) from generate_series(48,192) n
            where octet_length(left(title,n))<=192 order by n desc limit 1) end))
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
  await sql`update transcript_items set view=view||jsonb_build_object('status','stopped','completedAt',${source.cutAt.toISOString()}::text) where id = any(${itemIds}::text[])`.execute(
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
      status=case when t.status='archived' then t.status
        when summary.active_status='waiting' then 'waiting'
        when summary.active_status is not null and not (t.input_queue_paused and summary.active_status='queued') then 'running'
        when summary.latest_failed then 'failed' else 'idle' end
    from (
      select source_thread.id,
        (select count(*) from requests where originating_thread_id=source_thread.id and status='pending')
          + (select count(*) from thread_inputs where thread_id=source_thread.id and state='awaiting-approval') as pending,
        case when latest.status in ('completed','failed','interrupted') then latest.completed_at end as completed_at,
        current_run.status as active_status,
        last_run.status='failed' and last_run.maintenance is null as latest_failed,
        case when last_run.status='failed' and last_run.maintenance is null then left(last_run.failure->>'message',280) end as failure,
        reply.id as reply_id,left(reply.view->>'preview',280) as reply
      from threads source_thread
      left join lateral (
        select status,completed_at,failure from runs where thread_id=source_thread.id and maintenance is null
        order by run_ordinal desc limit 1
      ) latest on true
      left join lateral (
        select status,maintenance,failure from runs where thread_id=source_thread.id
        order by run_ordinal desc limit 1
      ) last_run on true
      left join lateral (
        select status from runs where thread_id=source_thread.id and maintenance is null
          and status in ('queued','starting','running','waiting') order by run_ordinal limit 1
      ) current_run on true
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

async function deriveAttentionAsks(tx: Tx, cursor: UpgradeCursor) {
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
        and consent_expires_at > clock_timestamp())
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
      pending_device_access_request_count=(select count(*) from requests where status='pending' and kind='device.access'),
      needs_you_count=(select count(*) from personal_attention where kind in ('request','failed-ask'))
        + coalesce((select sum(approval_attention_count) from personal_team_links
          where state in ('active','unreachable','needs_update')),0),
      unread_task_count=(select count(*) from threads t left join thread_visits v on v.thread_id=t.id and v.user_id=t.created_by
        where t.listed and t.purpose='task' and t.status<>'archived' and t.removed_at is null
          and t.latest_run_completed_at is not null and (v.last_visited_at is null or t.latest_run_completed_at>v.last_visited_at))
      where deployment_id=${source.id}`.execute(tx);
  return stage(cursor, "verify");
}

async function verifyConversion(tx: Tx, source: Source, cursor: UpgradeCursor) {
  const {
    rows: [page],
  } = await sql<{ lastId: string | null; ids: string[]; badText: boolean }>`
    with page as materialized (
      select id,kind,view,position,case
        when kind='message' then id=message_id and id collate "C" ~* ${messageIdPattern}
        when kind='reasoning' then octet_length(id) between 1 and 600
          and octet_length(block_id) between 1 and 255
        else false
      end and (run_id is null or run_id collate "C" ~* ${legacyRunIdPattern})
        and (attempt_id is null or attempt_id collate "C" ~* ${legacyAttemptIdPattern})
        and (node_id is null or node_id collate "C" ~* ${nodeIdPattern})
        and created_at >= '0001-01-01 00:00:00+00'::timestamptz
        and created_at < '10000-01-01 00:00:00+00'::timestamptz as shape_checked
      from transcript_items where id > ${cursor.key} order by id limit ${verifyBatchSize}
    )
    select (select max(id) from page) as "lastId",
      array(select id from page where shape_checked is not true
        union all
        select id from (
          select distinct on (kind,view) id from page where shape_checked
          order by kind,view,id
        ) checked) as ids,
      exists (
        select 1 from page p join transcript_items i on i.id=p.id
        left join deployment_events e on e.deployment_id=${source.id}
          and e.sequence=p.position-${cursor.reserved}::bigint
        where p.kind in ('reasoning','node-message')
          and i.body is distinct from e.data->'text'
        limit 1
      ) as "badText"
  `.execute(tx.withoutPlugins());
  // Imported reasoning and subagent text is display-only: a mismatch is
  // reported and the conversion goes on.
  if (page?.badText) reportDisplayDrift({ check: "imported-text", afterKey: cursor.key });
  const cards = page!.ids.length
    ? await tx
        .selectFrom("transcriptItems")
        .select([
          "id",
          "threadId",
          "kind",
          "revision",
          "runId",
          "attemptId",
          "nodeId",
          "isTurnStart",
          "createdAt",
          "view",
          "messageId",
          "toolCallId",
          "requestId",
          "executionNodeId",
          "delegationId",
          "appId",
          "blockId",
          "bindingGeneration",
        ])
        .select(sql<string>`coalesce(position,1)::text`.as("position"))
        .where(sql<boolean>`id=any(${page!.ids}::text[])`)
        .execute()
    : [];
  for (const card of cards) {
    try {
      itemView(card);
    } catch {
      throw new Error(`Personal conversion parity check failed at card ${card.id}`);
    }
  }
  if (page!.lastId) return { ...cursor, key: page!.lastId };
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
        or exists(select 1 from transcript_items i join messages m on m.id=i.message_id
          where i.thread_id<>m.thread_id limit 1)
        or exists(select 1 from thread_inputs t join transcript_items i on i.message_id=t.message_id
          where i.view#>>'{delivery,status}' is distinct from case
            when t.state='unknown' then 'unconfirmed'
            when t.state='cancelled' and t.cancel_reason is distinct from 'withdrawn' then 'failed' end
          limit 1)
        or exists(select 1 from transcript_items i join requests r on r.id=i.request_id
          where (i.thread_id,i.run_id,i.node_id) is distinct from (r.originating_thread_id,r.originating_run_id,r.originating_node_id)
            or i.view->>'requestKind' is distinct from r.kind
            or (r.mode='live') is distinct from (i.view ? 'waitedSince') limit 1)
        or exists(select 1 from transcript_items i join runs r on r.id=i.run_id
          where i.kind='run' and (i.thread_id<>r.thread_id
            or i.view->>'replyMessageId' is distinct from r.terminal_reply_message_id) limit 1)
        or exists(select 1 from transcript_items i join execution_nodes n on n.id=i.execution_node_id
          join runs r on r.id=n.run_id
          where (i.thread_id,i.run_id,i.attempt_id,i.node_id)
            is distinct from (r.thread_id,n.run_id,n.attempt_id,n.parent_node_id) limit 1)
        or exists(select 1 from transcript_items i join tool_calls c on c.id=i.tool_call_id
          where (i.thread_id,i.run_id,i.node_id,i.attempt_id) is distinct from (c.thread_id,c.run_id,c.node_id,c.attempt_id) limit 1)
        or exists(select 1 from tool_output_images i join tool_calls c on c.id=i.tool_call_id
          where (i.thread_id,i.node_id) is distinct from (c.thread_id,c.node_id) limit 1)
        or exists(select 1 from commands c join runs r on r.id=c.run_id
          where r.status='interrupted' and c.type=any(${offlineCommandTypes}::text[])
            and c.status in ('pending','dispatched') limit 1)
        or exists(select 1 from thread_inputs i join runs r on r.id=i.run_id
          where r.status='interrupted' and i.state='claimed' limit 1)
        or exists(select 1 from runner_event_receipts limit 1)) as invalid
  `.execute(tx)
  ).rows[0]!;
  // Authority parity stays fatal: every canonical card, Request, Run, delegation,
  // delivery and command state must match, or the converted state is not used.
  if (parity.invalid || parity.canonical !== cursor.reserved) {
    throw new Error("Personal conversion parity check failed");
  }
  // Counts of imported tool, image, reasoning and subagent rows only change
  // what history shows, so a difference is reported and the conversion goes on.
  const counts = {
    tools: [Number(parity.tools), cursor.counts.tools],
    toolCards: [Number(parity.toolCards), Number(parity.tools)],
    images: [Number(parity.images), cursor.counts.images],
    reasoning: [Number(parity.reasoning), cursor.counts.reasoning],
    nodeMessages: [Number(parity.nodeMessages), cursor.counts.nodeMessages],
  } as const;
  for (const [check, [found, expected]] of Object.entries(counts))
    if (found !== expected) reportDisplayDrift({ check, found, expected });
  return stage(cursor, "index");
}

/** Counts and identifiers only; never imported text. */
function reportDisplayDrift(detail: Readonly<Record<string, string | number>>): void {
  console.warn(JSON.stringify({ event: "personal-conversion-display-drift", ...detail }));
}

/** Names the conversion step that failed, so the app can say which one. */
export class PersonalStateConversionError extends Error {
  readonly step: string;
  constructor(step: string, cause: unknown) {
    super(
      `Personal state conversion failed at step "${step}": ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "PersonalStateConversionError";
    this.step = step;
  }
}

async function dropOldState(tx: Tx) {
  await sql`set local transaction_timeout = '10s'; set local lock_timeout = '5s'`.execute(tx);
  await sql`drop index if exists runs_unsettled_upgrade;
    drop table deployment_events,thread_state_pending;
    alter table threads drop column projected_input_queue_paused;
    alter table client_sync_state drop column upgrade_cursor`.execute(tx);
}

async function convertBatch(
  tx: Tx,
  deployment: Deployment | null,
): Promise<{ stage: UpgradeCursor["stage"]; done: boolean }> {
  if (!deployment || !deploymentPolicy(deployment).services.personal) {
    const unexpected = (
      await sql<{ present: boolean }>`select
      (exists(select 1 from deployment_events limit 1) or exists(select 1 from client_sync_state limit 1)) as present`.execute(
        tx,
      )
    ).rows[0];
    if (unexpected?.present)
      throw new Error("Unexpected personal event history outside a personal Deployment");
    let previous = "";
    for (;;) {
      const next = await createNextPersonalTranscriptOrderIndex(tx, previous);
      if (next === null) break;
      previous = next;
    }
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
  try {
    return await convertStage(tx, source, cursor);
  } catch (error) {
    throw new PersonalStateConversionError(cursor.stage, error);
  }
}

async function convertStage(
  tx: Tx,
  source: Source,
  cursor: UpgradeCursor,
): Promise<{ stage: UpgradeCursor["stage"]; done: boolean }> {
  let next: UpgradeCursor;
  switch (cursor.stage) {
    case "settle":
      next = await settleNextRun(tx, source, cursor);
      break;
    case "message":
      next = await deriveMessages(tx, cursor);
      break;
    case "request":
      next = await deriveRequests(tx, cursor);
      break;
    case "ledger": {
      const page = await convertLegacyActivityBatch(
        tx,
        source.id,
        cursor.key || "0",
        source.sequence,
        cursor.reserved,
      );
      if (!page.through) {
        next = stage(cursor, "run-details");
      } else {
        const counts = { ...cursor.counts };
        for (const key of Object.keys(counts) as (keyof typeof counts)[])
          counts[key] += page.counts[key];
        next = { ...cursor, key: page.through, counts };
      }
      break;
    }
    case "run-details":
      next = await deriveRunDetails(tx, cursor);
      break;
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
      next = await deriveAttentionAsks(tx, cursor);
      break;
    case "attention-links":
      next = await deriveAttentionLinks(tx, source, cursor);
      break;
    case "verify":
      next = await verifyConversion(tx, source, cursor);
      break;
    case "index": {
      const name = await createNextPersonalTranscriptOrderIndex(tx, cursor.key);
      next = name ? { ...cursor, key: name } : stage(cursor, "analyze");
      break;
    }
    case "analyze":
      await sql`analyze threads,messages,runs,transcript_items,tool_calls,tool_output_images,personal_attention`.execute(
        tx,
      );
      next = stage(cursor, "finalize");
      break;
    case "finalize":
      await dropOldState(tx);
      await sql`update client_sync_state set ready=true,pruned_through_sequence=sequence
        where deployment_id=${source.id} and sequence=${source.sequence}::bigint`.execute(tx);
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
  options?: { readonly afterBatch?: ((stage: UpgradeCursor["stage"]) => void) | undefined },
): Promise<void> {
  signal.throwIfAborted();
  const startup = (
    await sql<{ legacy: boolean; deployment: Deployment | null }>`
      select to_regclass('deployment_events') is not null as legacy, (
        select json_build_object('id',id,'kind',deployment_shape->>'kind')
        from deployments where singleton_key='primary'
      ) as deployment
    `.execute(database)
  ).rows[0]!;
  if (!startup.legacy) return;
  for (;;) {
    signal.throwIfAborted();
    const batch = await database.transaction().execute(async (tx) => {
      const result = await convertBatch(tx, startup.deployment);
      signal.throwIfAborted();
      return result;
    });
    if (startup.deployment && deploymentPolicy(startup.deployment).services.personal)
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
