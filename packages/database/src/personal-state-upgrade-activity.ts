import {
  eventDataSchemas,
  RunAttemptIdSchema,
  RunIdSchema,
  ThreadIdSchema,
  type AgentEvent,
  type DeploymentId,
  type EventId,
  type ExecutionNodeId,
  type RunAttemptId,
  type RunId,
  type ThreadId,
} from "@opensteer/core";
import { CompiledQuery, sql, type Insertable, type Selectable, type Transaction } from "kysely";
import { z } from "zod";
import type { DatabaseSchema } from "./schema.js";
import type {
  ToolCallTable,
  ToolOutputImageTable,
  TranscriptItemTable,
} from "./personal-state-schema.js";
import {
  retainedToolImages,
  toolCallId,
  transcriptIdentity,
  transcriptPreview,
} from "./transcript-store.js";

type Tx = Transaction<DatabaseSchema>;
interface LegacyActivity {
  readonly eventId: EventId | null;
  readonly sequence: string;
  readonly runId: RunId | null;
  readonly threadId: ThreadId | null;
  readonly runnerOrdinal: number | null;
  readonly runnerBindingGeneration: number | null;
  readonly createdAt: Date;
  readonly type: AgentEvent["type"];
  readonly data: unknown;
  readonly attemptId: RunAttemptId | null;
  readonly nodeId: ExecutionNodeId | null;
}

export interface LegacyImportCounts {
  tools: number;
  images: number;
  reasoning: number;
  nodeMessages: number;
  skipped: number;
}

const maxLegacyBatchBytes = 2 * 1024 * 1024;
const maxLegacyBatchRows = 500;
export const legacyRunIdPattern = z.toJSONSchema(RunIdSchema, { io: "input" }).pattern!;
export const legacyAttemptIdPattern = z.toJSONSchema(RunAttemptIdSchema, { io: "input" }).pattern!;
const threadIdPattern = z.toJSONSchema(ThreadIdSchema, { io: "input" }).pattern!;
const emptyCounts: LegacyImportCounts = {
  tools: 0,
  images: 0,
  reasoning: 0,
  nodeMessages: 0,
  skipped: 0,
};

const legacyBatchSql = `
    with sized as materialized (
      select sequence,
        case when type in ('tool.started','tool.completed','reasoning.completed','node.message')
          then octet_length(data::text) else 256 end as bytes
      from deployment_events
      where deployment_id=$1 and sequence>$2::bigint and sequence<=$3::bigint
      order by sequence limit ${maxLegacyBatchRows}
    ), bounded as (
      select sequence,bytes,sum(bytes) over(order by sequence) as batch_bytes,
        row_number() over(order by sequence) as row_no from sized
    ), selected as materialized (
      select e.sequence,e.event_id,e.run_id,e.thread_id,e.runner_ordinal,e.runner_binding_generation,
        e.type,e.created_at,
        case when b.bytes > ${maxLegacyBatchBytes} then
          case when e.type in ('reasoning.completed','node.message') then jsonb_strip_nulls(jsonb_build_object(
            'blockId',left(e.data->>'blockId',255),'nodeId',left(e.data->>'nodeId',255),
            'text',left(e.data->>'text',300001))) else null end
        else case e.type
          when 'message.created' then jsonb_build_object('id',e.data#>>'{message,id}')
          when 'message.placed' then jsonb_build_object('id',e.data#>>'{message,id}')
          when 'assistant.message' then jsonb_build_object('id',e.data->>'messageId')
          when 'request.opened' then jsonb_build_object('id',e.data#>>'{request,id}')
          when 'request.resolved' then jsonb_build_object('id',e.data#>>'{request,id}')
          when 'request.cancelled' then jsonb_build_object('id',e.data->>'requestId')
          when 'node.started' then jsonb_build_object('id',e.data->>'nodeId')
          when 'app.published' then jsonb_build_object('id',e.data->>'appId')
          when 'assignment.created' then jsonb_build_object('id',e.data#>>'{assignment,id}')
          when 'assignment.updated' then jsonb_build_object('id',e.data#>>'{assignment,id}')
          when 'delegation.settled' then jsonb_build_object('id',e.data->>'delegationId')
          when 'run.completed' then jsonb_build_object('replyId',e.data->>'replyMessageId')
          when 'tool.started' then e.data
          when 'tool.completed' then e.data
          when 'reasoning.completed' then e.data
          when 'node.message' then e.data
          else null
        end end as data
      from bounded b
      join deployment_events e on e.deployment_id=$1 and e.sequence=b.sequence
      where b.batch_bytes <= ${maxLegacyBatchBytes} or b.row_no=1
    ), resolved as materialized (
      select b.*,node.id as node_id,coalesce(node.attempt_id,attempt.id) as attempt_id
      from selected b
      left join execution_nodes node on node.id=b.data->>'nodeId' and node.run_id=b.run_id
        and b.type in ('tool.started','tool.completed','reasoning.completed','node.message')
      left join lateral (
        select a.id from run_attempts a where a.run_id=b.run_id
          and a.binding_generation=b.runner_binding_generation
          and b.type in ('tool.started','tool.completed','reasoning.completed','node.message')
        order by a.id limit 1
      ) attempt on node.id is null
    ), batch as materialized (
      select max(sequence) as last, coalesce(bool_and(
        type in ('message.created','message.placed','assistant.message')
      ),false) as message_only, coalesce(bool_and((
        type='reasoning.completed' and not (data ? 'nodeId')
          and run_id collate "C" ~* $5
          and thread_id collate "C" ~* $6
          and (attempt_id is null or attempt_id collate "C" ~* $7)
          and (runner_binding_generation is null or runner_binding_generation >= 0)
          and (runner_ordinal is null or (attempt_id is not null and runner_binding_generation is not null))
          and jsonb_typeof(data->'blockId')='string'
          and (data->>'blockId') collate "C" ~ '^[a-zA-Z0-9:_.-]{1,255}$'
          and jsonb_typeof(data->'text')='string'
          and octet_length(data->>'text') between 1 and 256
          and isfinite(created_at)
      ) is true),false) as reasoning_only from resolved
    ), markers as (
      select data->>'id' as id,thread_id,sequence,type='message.placed' as move
      from selected where (select message_only from batch)
        and thread_id is not null and data->>'id' is not null
    ), placements as (
      select distinct on (id) id,thread_id,sequence,move from markers
      order by id,move desc,case when move then sequence end desc,sequence
    ), blocks as (
      -- Match transcriptIdentity's compact JSON array for these root blocks.
      select 'reasoning:' || encode(sha256(convert_to(concat(
          '[',to_json(run_id),',',coalesce(to_json(attempt_id)::text,'null'),',',
          coalesce(runner_binding_generation::text,'null'),',null,',to_json(data->>'blockId'),']'
        ),'UTF8')),'hex') as id, thread_id,run_id,attempt_id,runner_binding_generation,sequence,
        created_at,data->>'blockId' as block_id,data->>'text' as body
      from resolved where (select reasoning_only from batch)
    )
    select b.sequence,
      case when b.type='node.message' and b.runner_ordinal is null then b.event_id end as "eventId",
      b.run_id as "runId",b.thread_id as "threadId",b.runner_ordinal as "runnerOrdinal",
      b.runner_binding_generation as "runnerBindingGeneration",b.type,b.created_at as "createdAt",b.data,
      b.node_id as "nodeId",b.attempt_id as "attemptId",null::json as placements,null::json as blocks
    from resolved b
    where not (select message_only or reasoning_only from batch)
    union all
    select last,null,null,null,null,null,null,null,null,null,null,
      (select json_agg(row) from (
        select id,thread_id,($4::bigint + sequence)::text as place,move from placements
      ) row),
      (select json_agg(row) from (select distinct on (id) id,thread_id,run_id,attempt_id,
        runner_binding_generation,sequence::text,created_at,block_id,body
        from blocks order by id,sequence desc) row)
    from batch where message_only or reasoning_only
    order by sequence
`;

type LegacyPlacement = { id: string; thread: ThreadId; place: string; move: boolean };

async function applyLegacyPlacements(
  tx: Tx,
  positions: readonly LegacyPlacement[],
  reserved: string,
) {
  if (!positions.length) return;
  const rows = sql`jsonb_to_recordset(${JSON.stringify(positions)}::jsonb)
    as record(id text,thread text,place bigint,move boolean)`;
  await sql`select i.id from ${rows}
    join transcript_items i on i.id=record.id and i.thread_id=record.thread
    where i.visible and (record.move or i.position <= ${reserved}::bigint)
    order by i.id for no key update of i`.execute(tx);
  await sql`update transcript_items i set position=record.place from ${rows}
    where i.id=record.id and i.thread_id=record.thread and i.visible
    and (record.move or i.position <= ${reserved}::bigint)`.execute(tx);
}

export async function convertLegacyActivityBatch(
  tx: Tx,
  deploymentId: DeploymentId,
  after: string,
  through: string,
  reservedPosition: string,
): Promise<{ through: string | null; counts: LegacyImportCounts }> {
  const page = await tx.executeQuery<
    LegacyActivity & {
      placements: { id: string; thread_id: ThreadId; place: string; move: boolean }[] | null;
      blocks: unknown[] | null;
    }
  >(
    CompiledQuery.raw(legacyBatchSql, [
      deploymentId,
      after,
      through,
      reservedPosition,
      legacyRunIdPattern,
      threadIdPattern,
      legacyAttemptIdPattern,
    ]),
  );
  const last = page.rows.at(-1);
  const counts = { ...emptyCounts };
  if (last?.placements)
    await applyLegacyPlacements(
      tx,
      last.placements.map(({ thread_id, ...row }) => ({ ...row, thread: thread_id })),
      reservedPosition,
    );
  if (last?.blocks) {
    const imported = await sql`
      insert into transcript_items(id,thread_id,run_id,attempt_id,binding_generation,kind,position,
        visible,is_turn_start,created_at,block_id,body,view)
      select id,thread_id,run_id,attempt_id,runner_binding_generation,'reasoning',
        ${reservedPosition}::bigint + sequence,true,false,date_trunc('milliseconds',created_at),
        block_id,to_jsonb(body),jsonb_build_object('preview',body)
      from jsonb_to_recordset(${JSON.stringify(last.blocks)}::jsonb)
        as record(id text,thread_id text,run_id text,attempt_id text,runner_binding_generation int,
          sequence bigint,created_at timestamptz,block_id text,body text)
      order by id on conflict (id) do nothing
    `.execute(tx);
    counts.reasoning = Number(imported.numAffectedRows ?? 0);
  }
  return {
    through: last?.sequence ?? null,
    counts: last?.type ? await importLegacyActivity(tx, page.rows, reservedPosition) : counts,
  };
}

type DisplayKind = "tool.started" | "tool.completed" | "reasoning.completed" | "node.message";
type DisplayEvent = {
  [Kind in DisplayKind]: Pick<Extract<AgentEvent, { type: Kind }>, "type" | "data">;
}[DisplayKind];
type ToolEvent = Extract<DisplayEvent, { type: "tool.started" | "tool.completed" }>;
type ToolSource = { row: LegacyActivity; event: ToolEvent; call: Selectable<ToolCallTable> };

function eventDataId(data: unknown, key: string): string | null {
  if (typeof data !== "object" || data === null) return null;
  const value = (data as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function canonicalCard(row: LegacyActivity): { id: string; move: boolean } | null {
  const id = eventDataId(row.data, "id");
  switch (row.type) {
    case "message.created":
    case "assistant.message":
      return id ? { id, move: false } : null;
    case "message.placed":
      return id ? { id, move: true } : null;
    case "run.queued":
    case "run.started":
    case "run.completed":
    case "run.failed":
    case "run.interrupted":
      return row.runId ? { id: `run:${row.runId}`, move: false } : null;
    case "request.opened":
    case "request.cancelled":
    case "request.resolved":
      return id ? { id: `request:${id}`, move: false } : null;
    case "assignment.created":
    case "assignment.updated":
      return id ? { id: `assignment:${id}`, move: false } : null;
    case "node.started":
      return id ? { id: `node:${id}`, move: false } : null;
    case "delegation.settled":
      return id ? { id: `delegation:${id}`, move: false } : null;
    case "app.published":
      return id ? { id: `app:${id}`, move: true } : null;
    default:
      return null;
  }
}

function classifyDisplay(row: LegacyActivity): DisplayEvent | null {
  if (row.runnerOrdinal !== null && (!row.attemptId || row.runnerBindingGeneration === null))
    return null;
  const type = row.type;
  const node = eventDataId(row.data, "nodeId");
  if (node !== null && row.nodeId !== node) return null;
  switch (type) {
    case "tool.started": {
      const result = eventDataSchemas[type].safeParse(row.data);
      return result.success ? { type, data: result.data } : null;
    }
    case "tool.completed": {
      const result = eventDataSchemas[type].safeParse(row.data);
      return result.success ? { type, data: result.data } : null;
    }
    case "reasoning.completed": {
      const result = eventDataSchemas[type].safeParse(row.data);
      return result.success ? { type, data: result.data } : null;
    }
    case "node.message": {
      const result = eventDataSchemas[type].safeParse(row.data);
      return result.success ? { type, data: result.data } : null;
    }
    default:
      return null;
  }
}

function makeToolCandidate(row: LegacyActivity, event: ToolEvent): ToolSource | null {
  if (!row.runId || !row.threadId) return null;
  const origin =
    row.runnerOrdinal !== null
      ? "runner"
      : event.data.callId.startsWith("computer:")
        ? "host-computer"
        : "host-harness";
  const key = {
    runId: row.runId,
    attemptId: row.attemptId,
    bindingGeneration: row.runnerBindingGeneration,
    nodeId: row.nodeId,
    callId: event.data.callId,
  };
  return {
    row,
    event,
    call: {
      ...key,
      id: toolCallId(key),
      threadId: row.threadId,
      origin,
      tool: null,
      integration: null,
      arguments: null,
      argumentDigest: null,
      provisional: false,
      status: "open",
      output: null,
      isError: null,
      startedAt: null,
      completedAt: null,
      completionOrder: null,
    },
  };
}

function toOwnedCard(
  row: LegacyActivity,
  event: Exclude<DisplayEvent, ToolEvent>,
  position: string,
): Insertable<TranscriptItemTable> | null {
  if (!row.runId || !row.threadId || !event.data.text) return null;
  const kind = event.type === "reasoning.completed" ? "reasoning" : "node-message";
  const text = event.data.text;
  return {
    id:
      event.type === "reasoning.completed"
        ? transcriptIdentity(
            kind,
            row.runId,
            row.attemptId,
            row.runnerBindingGeneration,
            row.nodeId,
            event.data.blockId,
          )
        : transcriptIdentity(kind, row.runId, row.runnerOrdinal ?? row.eventId),
    threadId: row.threadId,
    runId: row.runId,
    attemptId: row.attemptId,
    bindingGeneration: row.runnerBindingGeneration,
    nodeId: row.nodeId,
    kind,
    blockId: event.type === "reasoning.completed" ? event.data.blockId : null,
    position,
    visible: true,
    isTurnStart: false,
    createdAt: row.createdAt,
    body: sql`${JSON.stringify(text)}::jsonb`,
    view: transcriptPreview({ preview: text }),
  } as Insertable<TranscriptItemTable>;
}

async function importToolBatch(
  tx: Tx,
  candidates: readonly ToolSource[],
  reserved: bigint,
  placementIds: readonly string[],
): Promise<Pick<LegacyImportCounts, "tools" | "images" | "skipped">> {
  const stats = { tools: 0, images: 0, skipped: 0 };
  if (!candidates.length) return stats;
  const ids = [...new Set(candidates.map(({ call }) => call.id))];
  const current = new Map(
    (
      await tx
        .selectFrom("toolCalls")
        .select(["id", "origin", "status", "tool", "startedAt", "integration", "completedAt"])
        .where("id", "in", ids)
        .orderBy("id")
        .forNoKeyUpdate()
        .execute()
    ).map((row) => [row.id, row]),
  );
  const writes = new Map<string, Selectable<ToolCallTable>>();
  const cards = new Map<string, Insertable<TranscriptItemTable>>();
  const images: Insertable<ToolOutputImageTable>[] = [];
  for (const { call, row, event } of candidates) {
    const prior = current.get(call.id);
    if (
      prior &&
      (prior.status !== "open" ||
        prior.origin !== call.origin ||
        (event.type === "tool.started" &&
          prior.tool !== null &&
          (prior.tool.name !== event.data.tool.name ||
            prior.tool.namespace !== event.data.tool.namespace)))
    ) {
      stats.skipped++;
      continue;
    }
    const position = (reserved + BigInt(row.sequence)).toString();
    const tool = prior?.tool ?? (event.type === "tool.started" ? event.data.tool : null);
    const startedAt = prior?.startedAt ?? (event.type === "tool.started" ? row.createdAt : null);
    const integration = prior
      ? prior.integration
      : event.type === "tool.started"
        ? (event.data.integration ?? null)
        : null;
    const status = event.type === "tool.started" ? "open" : "completed";
    const completedAt = event.type === "tool.completed" ? row.createdAt : null;
    const previousWrite = writes.get(call.id);
    writes.set(call.id, {
      ...call,
      status,
      tool,
      integration,
      startedAt,
      arguments:
        event.type === "tool.started"
          ? JSON.stringify(event.data.arguments ?? null)
          : (previousWrite?.arguments ?? null),
      output: event.type === "tool.completed" ? event.data.output : null,
      isError: event.type === "tool.completed" ? event.data.isError : null,
      completedAt,
      completionOrder: event.type === "tool.completed" ? position : null,
    });
    const key = `tool:${call.id}`;
    cards.set(key, {
      id: key,
      threadId: call.threadId,
      runId: call.runId,
      attemptId: call.attemptId,
      nodeId: call.nodeId,
      kind: "tool",
      visible: true,
      isTurnStart: false,
      createdAt: startedAt ?? row.createdAt,
      position: cards.get(key)?.position ?? position,
      toolCallId: call.id,
      view: transcriptPreview({
        title: tool?.name,
        status: event.type === "tool.started" ? "running" : event.data.isError ? "failed" : "done",
        tool,
        ...(completedAt ? { completedAt: completedAt.toISOString() } : {}),
      }),
    });
    if (event.type === "tool.completed")
      images.push(...retainedToolImages(call, event.data.output.images ?? [], position));
    if (!prior) stats.tools++;
    current.set(call.id, {
      id: call.id,
      origin: call.origin,
      status,
      tool,
      startedAt,
      integration,
      completedAt,
    });
  }
  if (writes.size) {
    const values = [...writes.values()].map(
      (row) => sql`(
      ${row.id}::text,${row.threadId}::text,${row.runId}::text,${row.attemptId}::text,
      ${row.bindingGeneration}::integer,${row.nodeId}::text,${row.callId}::text,${row.origin}::text,
      ${row.tool === null ? null : JSON.stringify(row.tool)}::jsonb,
      ${row.integration === null ? null : JSON.stringify(row.integration)}::jsonb,
      ${row.arguments}::jsonb,${row.status}::text,
      ${row.output === null ? null : JSON.stringify(row.output)}::jsonb,
      ${row.isError}::boolean,${row.startedAt}::timestamptz,${row.completedAt}::timestamptz,
      ${row.completionOrder}::bigint
    )`,
    );
    await sql`insert into tool_calls(id,thread_id,run_id,attempt_id,binding_generation,node_id,call_id,origin,
      tool,integration,arguments,status,output,is_error,started_at,completed_at,completion_order)
    select value.id,value.thread_id,value.run_id,value.attempt_id,value.binding_generation,value.node_id,
      value.call_id,value.origin,value.tool,value.integration,coalesce(value.arguments,old.arguments),
      value.status,value.output,value.is_error,value.started_at,value.completed_at,value.completion_order
    from (values ${sql.join(values)}) as value(id,thread_id,run_id,attempt_id,binding_generation,node_id,call_id,
      origin,tool,integration,arguments,status,output,is_error,started_at,completed_at,completion_order)
    left join tool_calls old on old.id=value.id
    on conflict(id) do update set arguments=excluded.arguments,status=excluded.status,output=excluded.output,
      is_error=excluded.is_error,completed_at=excluded.completed_at,completion_order=excluded.completion_order
    `.execute(tx);
  }
  const itemIds = [...placementIds, ...cards.keys()];
  if (itemIds.length)
    await sql`select id from transcript_items where id=any(${itemIds}::text[]) order by id for no key update`.execute(
      tx,
    );
  if (cards.size)
    await tx
      .insertInto("transcriptItems")
      .values([...cards.values()])
      .onConflict((conflict) =>
        conflict.column("id").doUpdateSet((eb) => ({ view: eb.ref("excluded.view") })),
      )
      .execute();
  if (images.length) await tx.insertInto("toolOutputImages").values(images).execute();
  return { ...stats, images: images.length };
}

async function importLegacyActivity(
  tx: Tx,
  page: readonly LegacyActivity[],
  reservedPosition: string,
): Promise<LegacyImportCounts> {
  const reserved = BigInt(reservedPosition);
  const counts = { ...emptyCounts };
  const candidates: ToolSource[] = [];
  const owned = new Map<string, Insertable<TranscriptItemTable>>();
  const placements = new Map<
    string,
    { id: string; thread: ThreadId; place: string; move: boolean }
  >();
  const terminal = new Map<RunId, { run: RunId; thread: ThreadId; reply: string | null }>();
  const runnerSafe = new Set<RunId>();
  let scope: { runId: RunId | null; threadId: ThreadId; valid: boolean } | undefined;
  for (const row of page) {
    if (!row.threadId) continue;
    const position = (reserved + BigInt(row.sequence)).toString();
    const marker = canonicalCard(row);
    if (marker && (marker.move || !placements.has(marker.id))) {
      placements.set(marker.id, {
        id: marker.id,
        thread: row.threadId,
        place: position,
        move: marker.move,
      });
    }
    if (row.type === "run.completed" && row.runId)
      terminal.set(row.runId, {
        run: row.runId,
        thread: row.threadId,
        reply: eventDataId(row.data, "replyId"),
      });
    if (
      (row.type === "run.failed" || row.type === "run.interrupted") &&
      row.runId &&
      row.runnerOrdinal !== null
    )
      runnerSafe.add(row.runId);
    if (
      row.type !== "tool.started" &&
      row.type !== "tool.completed" &&
      row.type !== "reasoning.completed" &&
      row.type !== "node.message"
    )
      continue;
    // Consecutive display events commonly share the same Run and thread.
    if (!scope || row.runId !== scope.runId || row.threadId !== scope.threadId) {
      scope = {
        runId: row.runId,
        threadId: row.threadId,
        valid:
          RunIdSchema.safeParse(row.runId).success &&
          ThreadIdSchema.safeParse(row.threadId).success,
      };
    }
    const display = scope.valid ? classifyDisplay(row) : null;
    if (!display) {
      counts.skipped++;
    } else if (display.type === "tool.started" || display.type === "tool.completed") {
      const candidate = makeToolCandidate(row, display);
      if (candidate) candidates.push(candidate);
    } else {
      const card = toOwnedCard(row, display, position);
      if (card) owned.set(card.id, card);
    }
  }
  const runIds = [...new Set([...runnerSafe, ...terminal.keys()])];
  if (runIds.length)
    await tx
      .selectFrom("runs")
      .select("id")
      .where("id", "in", runIds)
      .orderBy("id")
      .forNoKeyUpdate()
      .execute();
  if (runnerSafe.size)
    await sql`update runs set runner_safety_terminal=true
    where id = any(${[...runnerSafe]}::text[])`.execute(tx);
  if (terminal.size)
    await sql`update runs r set terminal_reply_message_id=(
      select id from messages m where m.id=record.reply and m.run_id=r.id and m.thread_id=r.thread_id
        and m.kind='assistant' and m.addressed_to_user_id is null and m.published limit 1)
    from jsonb_to_recordset(${JSON.stringify([...terminal.values()])}::jsonb)
      as record(run text,thread text,reply text)
    where r.id=record.run and r.thread_id=record.thread and r.status='completed'`.execute(tx);
  const tools = await importToolBatch(tx, candidates, reserved, [...placements.keys()]);
  await applyLegacyPlacements(tx, [...placements.values()], reservedPosition);
  counts.tools = tools.tools;
  counts.images = tools.images;
  counts.skipped += tools.skipped;
  if (owned.size) {
    const inserted = await tx
      .insertInto("transcriptItems")
      .values([...owned.values()])
      .onConflict((conflict) => conflict.column("id").doNothing())
      .returning("kind")
      .execute();
    for (const row of inserted) {
      if (row.kind === "reasoning") counts.reasoning++;
      else counts.nodeMessages++;
    }
  }
  return counts;
}
