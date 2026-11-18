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
  utf8Prefix,
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
const maxSqlPlacementRows = 4_096;
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
    with keys as materialized (
      select sequence,type from deployment_events
      where deployment_id=$1 and sequence>$2::bigint and sequence<=$3::bigint
      order by sequence limit ${maxSqlPlacementRows}
    ), placement_end as (
      select min(sequence) as first_other from keys
      where type not in ('message.created','message.placed','assistant.message')
    ), placement_count as (
      select count(*) from keys,placement_end where first_other is null or sequence<first_other
    ), sized as materialized (
      select key.sequence,
        case when key.type in ('tool.started','tool.completed','reasoning.completed','node.message')
          then octet_length(event.data::text) else 256 end as bytes
      from (
        select sequence,type from keys order by sequence
        limit greatest((select count from placement_count),${maxLegacyBatchRows})
      ) key
      join deployment_events event on event.deployment_id=$1 and event.sequence=key.sequence
    ), bounded as (
      select sequence,bytes,sum(bytes) over(order by sequence) as batch_bytes,
        row_number() over(order by sequence) as row_no from sized
    ), selected as materialized (
      select e.sequence,e.event_id,e.run_id,e.thread_id,e.runner_ordinal,e.runner_binding_generation,
        e.type,e.created_at,
        case when b.bytes > ${maxLegacyBatchBytes} then
          case when e.type in ('reasoning.completed','node.message') then jsonb_strip_nulls(jsonb_build_object(
            'blockId',left(e.data->>'blockId',255),'nodeId',left(e.data->>'nodeId',255),
            'text',left(e.data->>'text',75000))) else null end
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
    ), locked as materialized (
      select i.id,$4::bigint + p.sequence as position
      from placements p join transcript_items i on i.id=p.id and i.thread_id=p.thread_id
      where i.visible and (p.move or i.position <= $4::bigint)
      order by i.id for no key update of i
    ), placed as (
      update transcript_items i set position=locked.position from locked where i.id=locked.id
    ), blocks as (
      -- Match transcriptIdentity's compact JSON array for these root blocks.
      select 'reasoning:' || encode(sha256(convert_to(concat(
          '[',to_json(run_id),',',coalesce(to_json(attempt_id)::text,'null'),',',
          coalesce(runner_binding_generation::text,'null'),',null,',to_json(data->>'blockId'),']'
        ),'UTF8')),'hex') as id, thread_id,run_id,attempt_id,runner_binding_generation,sequence,
        created_at,data->>'blockId' as block_id,data->>'text' as body
      from resolved where (select reasoning_only from batch)
    ), imported_blocks as (
      insert into transcript_items(id,thread_id,run_id,attempt_id,binding_generation,kind,position,
        visible,is_turn_start,created_at,block_id,body,view)
      select distinct on (id) id,thread_id,run_id,attempt_id,runner_binding_generation,'reasoning',
        $4::bigint + sequence,true,false,date_trunc('milliseconds',created_at),
        block_id,to_jsonb(body),jsonb_build_object('preview',body)
      from blocks order by id,sequence desc
      on conflict (id) do nothing returning 1
    )
    select b.sequence,
      case when b.type='node.message' and b.runner_ordinal is null then b.event_id end as "eventId",
      b.run_id as "runId",b.thread_id as "threadId",b.runner_ordinal as "runnerOrdinal",
      b.runner_binding_generation as "runnerBindingGeneration",b.type,b.created_at as "createdAt",b.data,
      b.node_id as "nodeId",b.attempt_id as "attemptId",false as "importedInSql",0 as reasoning
    from resolved b
    where not (select message_only or reasoning_only from batch)
    union all
    select last,null,null,null,null,null,null,null,null,null,null,true,
      (select count(*)::int from imported_blocks)
    from batch where message_only or reasoning_only
    order by sequence
`;

export async function convertLegacyActivityBatch(
  tx: Tx,
  deploymentId: DeploymentId,
  after: string,
  through: string,
  reservedPosition: string,
): Promise<{ through: string | null; counts: LegacyImportCounts }> {
  const page = await tx.executeQuery<
    LegacyActivity & { importedInSql: boolean; reasoning: number }
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
  return {
    through: last?.sequence ?? null,
    counts:
      !last || last.importedInSql
        ? { ...emptyCounts, reasoning: last?.reasoning ?? 0 }
        : await importLegacyActivity(tx, page.rows, reservedPosition),
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
  const text = utf8Prefix(event.data.text, 480 * 1024);
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
    await sql`insert into tool_calls(id,thread_id,run_id,attempt_id,binding_generation,node_id,call_id,origin,
      tool,integration,arguments,status,output,is_error,started_at,completed_at,completion_order)
    select value.id,value."threadId",value."runId",value."attemptId",value."bindingGeneration",value."nodeId",
      value."callId",value.origin,value.tool,value.integration,coalesce(value.arguments::jsonb,old.arguments),
      value.status,value.output,value."isError",value."startedAt",value."completedAt",value."completionOrder"
    from jsonb_to_recordset(${JSON.stringify([...writes.values()])}::jsonb) as value(
      id text,"threadId" text,"runId" text,"attemptId" text,"bindingGeneration" int,"nodeId" text,"callId" text,
      origin text,tool jsonb,integration jsonb,arguments text,status text,output jsonb,"isError" boolean,
      "startedAt" timestamptz,"completedAt" timestamptz,"completionOrder" bigint)
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
    await sql`insert into transcript_items(id,thread_id,run_id,attempt_id,node_id,kind,
      visible,is_turn_start,created_at,position,tool_call_id,view)
    select id,"threadId","runId","attemptId","nodeId",kind,visible,"isTurnStart","createdAt",position,"toolCallId",view
    from jsonb_to_recordset(${JSON.stringify([...cards.values()])}::jsonb) as card(
      id text,"threadId" text,"runId" text,"attemptId" text,"nodeId" text,kind text,visible boolean,
      "isTurnStart" boolean,"createdAt" timestamptz,position bigint,"toolCallId" text,view jsonb)
    on conflict(id) do update set view=excluded.view
    `.execute(tx);
  if (images.length) {
    const values = images.map((image) => ({ ...image, pathHash: image.pathHash.toString("hex") }));
    await sql`insert into tool_output_images(id,tool_call_id,image_index,thread_id,node_id,
      path,path_hash,media_type,generated,completion_order)
    select id,"toolCallId","imageIndex","threadId","nodeId",path,decode("pathHash",'hex'),
      "mediaType",generated,"completionOrder" from jsonb_to_recordset(${JSON.stringify(values)}::jsonb) as image(
        id text,"toolCallId" text,"imageIndex" int,"threadId" text,"nodeId" text,path text,
        "pathHash" text,"mediaType" text,generated boolean,"completionOrder" bigint)
    `.execute(tx);
  }
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
  if (placements.size)
    await sql`with records as materialized (
      select * from jsonb_to_recordset(${JSON.stringify([...placements.values()])}::jsonb)
        as record(id text,thread text,place bigint,move boolean)
    ), locked as materialized (
      select i.id,record.place from records record
      join transcript_items i on i.id=record.id and i.thread_id=record.thread
      where i.visible and (record.move or i.position <= ${reservedPosition}::bigint)
      order by i.id for no key update of i
    )
    update transcript_items i set position=locked.place from locked where i.id=locked.id`.execute(
      tx,
    );
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
