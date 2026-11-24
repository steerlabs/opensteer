import type { DatabaseSchema } from "./schema.js";
import {
  answeredQuestion,
  answeredQuestionPreviewBytes,
  answeredQuestionWithin,
  OpensteerError,
  utf8Prefix,
  type DeploymentId,
  type ExecutionNode,
  type ExecutionNodeId,
  type Request,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import {
  executionNodeFromRow,
  isRetiredMessageRow,
  messageViewFromRow,
} from "./thread-row-mappers.js";
import {
  clientSendKeyWireReserve,
  fitsInlineTranscriptText,
  transcriptInlineTextMaxBytes,
  TranscriptItemSchema,
  type TranscriptItem,
} from "@opensteer/protocol/transcript";
import type { MessageTextFacts } from "./transcript-store.js";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import type {
  ClientChangesTable,
  PersonalScopeKey,
  PlaceView,
  TranscriptItemTable,
} from "./personal-state-schema.js";
import type { ExecutionNodeTable } from "./schema.js";
import { nodeItemsPredicate, taskItemsPredicate } from "./personal-state-schema.js";

type Database = Kysely<DatabaseSchema>;
type Read = Transaction<DatabaseSchema>;

export type PersonalReadScope =
  | { readonly kind: "shell" }
  | { readonly kind: "thread"; readonly threadId: ThreadId }
  | { readonly kind: "node"; readonly threadId: ThreadId; readonly nodeId: ExecutionNodeId };

export interface PersonalResumeCursor {
  readonly deploymentId: DeploymentId;
  readonly epoch: string;
  readonly viewerId: UserId;
  readonly scopeKey: PersonalScopeKey;
  readonly afterSequence: string;
}

export function personalScopeKey(scope: PersonalReadScope): PersonalScopeKey {
  switch (scope.kind) {
    case "shell":
      return "shell";
    case "thread":
      return `thread:${scope.threadId}`;
    case "node":
      return `node:${scope.nodeId}`;
  }
}

const scopedReadTransactions = new WeakSet<Read>();

export function withPersonalSyncRead<Result>(
  database: Database,
  action: (tx: Read) => Promise<Result>,
) {
  if (database.isTransaction) {
    const tx = database as Read;
    if (!scopedReadTransactions.has(tx))
      throw new Error("Personal sync reads require their own repeatable-read cut");
    return action(tx);
  }
  return database
    .transaction()
    .setIsolationLevel("repeatable read")
    .setAccessMode("read only")
    .execute(async (tx) => {
      scopedReadTransactions.add(tx);
      return action(tx);
    });
}

export async function authorizedSyncState(tx: Read, viewerId: UserId) {
  const state = await tx
    .selectFrom("clientSyncState as sync")
    .innerJoin("deployments as deployment", "deployment.id", "sync.deploymentId")
    .leftJoin("personalSettings as settings", (join) =>
      join.on("settings.singletonKey", "=", "personal"),
    )
    .innerJoin("users as owner", (join) => join.on("owner.id", "=", viewerId))
    .selectAll("sync")
    .where((eb) =>
      eb.or([
        eb("settings.ownerId", "=", viewerId),
        eb.and([
          eb("settings.ownerId", "is", null),
          eb(
            "owner.id",
            "=",
            eb
              .selectFrom("users")
              .select("users.id")
              .orderBy("users.createdAt", "asc")
              .orderBy("users.id", "asc")
              .limit(1),
          ),
        ]),
      ]),
    )
    .where(sql<boolean>`deployment.deployment_shape->>'kind' = 'personal'`)
    .where("owner.disabledAt", "is", null)
    .where("deployment.lifecycle", "=", "active")
    .where("sync.ready", "=", true)
    .limit(1)
    .executeTakeFirst();
  if (!state)
    throw new OpensteerError({
      code: "forbidden",
      message: "Personal Opensteer is unavailable to this viewer",
    });
  return state;
}

type DetailScope = Exclude<PersonalReadScope, { kind: "shell" }>;

export async function authorizedDetail(tx: Read, viewerId: UserId, scope: DetailScope) {
  const thread = await tx
    .selectFrom("threads")
    .select(["id", "revision"])
    .where("id", "=", scope.threadId)
    .where("removedAt", "is", null)
    .where("createdBy", "=", viewerId)
    .executeTakeFirst();
  if (!thread) return null;
  if (scope.kind === "node") {
    const node = await tx
      .selectFrom("executionNodes as node")
      .innerJoin("runs as run", "run.id", "node.runId")
      .select("node.id")
      .where("node.id", "=", scope.nodeId)
      .where("run.threadId", "=", thread.id)
      .executeTakeFirst();
    if (!node) return null;
  }
  return thread;
}

const replayMaxRows = 128;
const replayMaxBytes = 1024 * 1024;

export type ReplayChange = Pick<
  Selectable<ClientChangesTable>,
  "sequence" | "ordinal" | "entityKind" | "entityId" | "operation"
> & { readonly value?: Record<string, unknown> };

export interface ScopeCommit {
  readonly fromSequence: string;
  readonly throughSequence: string;
  readonly changes: readonly ReplayChange[];
}

export async function readPersonalScopeCut<Snapshot>(
  database: Database,
  input: {
    readonly viewerId: UserId;
    readonly scope: PersonalReadScope;
    readonly cursor?: PersonalResumeCursor;
    readonly snapshot: (
      tx: Read,
      state: Awaited<ReturnType<typeof authorizedSyncState>>,
    ) => Promise<Snapshot>;
    /** Derived values a resumed reader must see even when no feed row carried them. */
    readonly resume?: (
      tx: Read,
      state: Awaited<ReturnType<typeof authorizedSyncState>>,
      after: string,
    ) => Promise<Omit<ReplayChange, "sequence" | "ordinal"> | null>;
  },
) {
  return withPersonalSyncRead(database, async (tx) => {
    const state = await authorizedSyncState(tx, input.viewerId);
    const selected = input.scope;
    const cursor = input.cursor;
    if (
      cursor &&
      (cursor.deploymentId !== state.deploymentId || cursor.viewerId !== input.viewerId)
    )
      throw new OpensteerError({
        code: "forbidden",
        message: "The resume cursor belongs to another viewer or Deployment",
      });
    if (selected.kind !== "shell" && !(await authorizedDetail(tx, input.viewerId, selected)))
      return { kind: "removed" as const, state };
    const scopeKey = personalScopeKey(selected);
    // The Host repairs any scope it cannot replay with a snapshot on the same subscription.
    const snapshot = async () =>
      ({ kind: "snapshot" as const, state, snapshot: await input.snapshot(tx, state) }) as const;
    if (!cursor || cursor.scopeKey !== scopeKey || cursor.epoch !== state.epoch) return snapshot();
    const after = BigInt(cursor.afterSequence);
    if (after > BigInt(state.sequence) || after < BigInt(state.prunedThroughSequence))
      return snapshot();
    if (after === BigInt(state.sequence)) return { kind: "replay" as const, state, commits: [] };
    // Check row count, resets and stored `byte_count` before transferring JSONB payloads.
    const headers = await tx
      .selectFrom("clientChanges")
      .select(["sequence", "ordinal", "operation", "byteCount"])
      .where("deploymentId", "=", state.deploymentId)
      .where("scopeKey", "=", scopeKey)
      .where("sequence", ">", cursor.afterSequence)
      .where("sequence", "<=", state.sequence)
      .orderBy("sequence")
      .orderBy("ordinal")
      .limit(replayMaxRows + 1)
      .execute();
    if (headers.length > replayMaxRows || headers.some((row) => row.operation === "reset"))
      return snapshot();
    let headerBytes = 0;
    for (const row of headers) {
      headerBytes += row.byteCount;
      if (headerBytes > replayMaxBytes) return snapshot();
    }
    const changes = headers.length
      ? await tx
          .selectFrom("clientChanges")
          .select(["sequence", "ordinal", "entityKind", "entityId", "operation", "payload"])
          .where("deploymentId", "=", state.deploymentId)
          .where("scopeKey", "=", scopeKey)
          .where("sequence", ">", cursor.afterSequence)
          .where("sequence", "<=", state.sequence)
          .orderBy("sequence")
          .orderBy("ordinal")
          .limit(replayMaxRows)
          .execute()
      : [];
    let previous = cursor.afterSequence;
    let batch: ReplayChange[] = [];
    let bytes = 0;
    const commits: ScopeCommit[] = [];
    for (const row of changes) {
      const last = batch.at(-1);
      if (last && last.sequence !== row.sequence) {
        commits.push({ fromSequence: previous, throughSequence: last.sequence, changes: batch });
        previous = last.sequence;
        batch = [];
      }
      const { payload, ...change } = row;
      const value = row.operation === "remove" ? change : { ...change, value: payload };
      bytes += Buffer.byteLength(JSON.stringify(value));
      if (bytes > replayMaxBytes) return snapshot();
      batch.push(value);
    }
    const last = batch.at(-1);
    if (last) {
      commits.push({ fromSequence: previous, throughSequence: last.sequence, changes: batch });
      previous = last.sequence;
    }
    if (previous !== state.sequence)
      commits.push({ fromSequence: previous, throughSequence: state.sequence, changes: [] });
    const derived = await input.resume?.(tx, state, cursor.afterSequence);
    const final = commits.at(-1)!;
    if (
      derived &&
      !final.changes.some(
        (row) => row.entityKind === derived.entityKind && row.entityId === derived.entityId,
      )
    ) {
      const ordinal = (final.changes.at(-1)?.ordinal ?? -1) + 1;
      if (ordinal > replayMaxRows - 1) return snapshot();
      commits[commits.length - 1] = {
        ...final,
        changes: [...final.changes, { ...derived, sequence: state.sequence, ordinal }],
      };
    }
    return { kind: "replay" as const, state, commits };
  });
}

export const itemColumns = [
  "id",
  "threadId",
  "runId",
  "attemptId",
  "nodeId",
  "kind",
  "position",
  "revision",
  "isTurnStart",
  "createdAt",
  "messageId",
  "toolCallId",
  "requestId",
  "executionNodeId",
  "delegationId",
  "appId",
  "blockId",
  "bindingGeneration",
  "view",
  "refs",
] as const;
/** A node's facts as its card reads them: a row, or the same fields read as JSON. */
export type NodeFacts = Omit<
  Selectable<ExecutionNodeTable>,
  "nativeRef" | "sessionRef" | "originCallId" | "startedAt" | "endedAt"
> & { readonly startedAt: Date | string; readonly endedAt: Date | string | null };
/** A settled agent question's facts, read beside its card like a node's. */
export type QuestionFacts = Pick<Request, "kind" | "presentation" | "response" | "status">;
type Item = Pick<Selectable<TranscriptItemTable>, (typeof itemColumns)[number]> & {
  readonly place?: PlaceView | null;
  readonly body?: Selectable<TranscriptItemTable>["body"];
  readonly node?: NodeFacts | null;
  readonly question?: QuestionFacts | null;
  readonly messageText?: MessageTextFacts | null;
  readonly nodeMessageText?: string | null;
};

/**
 * What a node's card draws, from the node itself: its times, model, phases and stop support. Its
 * prompt is cut to the first line and its result to a preview; its own scope has the rest.
 */
export function nodeCardView(facts: NodeFacts): ExecutionNode {
  const node = executionNodeFromRow({
    ...facts,
    startedAt: new Date(facts.startedAt),
    endedAt: facts.endedAt === null ? null : new Date(facts.endedAt),
  });
  const line = node.prompt?.split("\n").find((text) => text.trim()) ?? null;
  return {
    ...node,
    prompt: line === null ? null : utf8Prefix(line, 256),
    result: node.result === null ? null : utf8Prefix(node.result, 1024),
  };
}

/** A node card's facts, read beside it, in `NodeFacts`'s names. */
const nodeFacts = sql<NodeFacts | null>`case when kind = 'node' then (
  select jsonb_build_object('id',n.id,'runId',n.run_id,'attemptId',n.attempt_id,
    'parentNodeId',n.parent_node_id,'kind',n.kind,'title',n.title,'status',n.status,
    'model',n.model,'effort',n.effort,'phaseIndex',n.phase_index,'phases',n.phases,
    'stopSupported',n.stop_supported,'stopping',n.stopping,'startedAt',n.started_at,
    'endedAt',n.ended_at,'prompt',left(n.prompt,1024),'result',left(n.result,2048),
    'inputTokens',n.input_tokens::text,'outputTokens',n.output_tokens::text,
    'cachedInputTokens',n.cached_input_tokens::text,'cacheWriteTokens',n.cache_write_tokens::text,
    'reasoningTokens',n.reasoning_tokens::text,'costUsd',n.cost_usd::text)
  from execution_nodes n where n.id = transcript_items.execution_node_id) end`;

/**
 * A settled agent question's facts, read beside its card when drawn, so every
 * receipt shows the same record however long ago it was answered. Each text is
 * read no longer than the whole record may be, so the record drawn from these
 * is the one drawn from the full Request, and a page reads little per card.
 */
const questionFacts = sql<QuestionFacts | null>`case when kind = 'request' then (
  select jsonb_build_object('kind',r.kind,'status',r.status,
    'presentation',jsonb_strip_nulls(jsonb_build_object(
      'kind',r.presentation->'kind','title',r.presentation->'title',
      'detailFormat',r.presentation->'detailFormat',
      'detail',left(r.presentation->>'detail',${sql.lit(answeredQuestionPreviewBytes)}),
      'fields',(select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
          'id',f.field->'id','secret',f.field->'secret',
          'prompt',left(f.field->>'prompt',${sql.lit(answeredQuestionPreviewBytes)}),
          'choices',(select jsonb_agg(jsonb_build_object('label',c->'label','value',c->'value'))
            from jsonb_array_elements(f.field->'choices') c))) order by f.at)
        from jsonb_array_elements(r.presentation->'fields') with ordinality f(field,at)))),
    'response',case when r.response->>'kind' = 'form' then jsonb_build_object('kind','form',
      'answers',coalesce((select jsonb_object_agg(a.key,(select coalesce(jsonb_agg(
          left(v.value,${sql.lit(answeredQuestionPreviewBytes)}) order by v.at),'[]'::jsonb)
        from jsonb_array_elements_text(a.value) with ordinality v(value,at)))
        from jsonb_each(r.response->'answers') a),'{}'::jsonb))
      else r.response end)
  from requests r where r.id = transcript_items.request_id
    and r.kind = 'person.question' and r.status in ('fulfilled','declined')) end`;

/**
 * Full unstripped conversation prose read beside a message card when it fits within
 * `transcriptInlineTextMaxBytes`, plus the count of rich parts so the wire item knows whether
 * every reference rode on the card. Oversized bodies stay null and load via `transcript.item.get`.
 */
const messageTextFacts = sql<MessageTextFacts | null>`case when kind = 'message' then (
  select (
    select jsonb_build_object(
      'text', case when octet_length(to_jsonb(t.text)::text) <= ${sql.lit(transcriptInlineTextMaxBytes)} then t.text else null end,
      'richPartCount', t.rich_part_count
    )
    from (
      select
        coalesce(
          string_agg(p.part->>'text', E'\n' order by p.at) filter (where p.part->>'type' = 'text'),
          ''
        ) as text,
        count(*) filter (where p.part->>'type' <> 'text') as rich_part_count
      from jsonb_array_elements(m.content) with ordinality p(part, at)
    ) t
  )
  from messages m
  where m.id = transcript_items.message_id and m.thread_id = transcript_items.thread_id
) end`;

const nodeMessageTextFacts = sql<string | null>`case
  when kind = 'node-message' and octet_length(body::text) <= ${sql.lit(transcriptInlineTextMaxBytes)}
  then body #>> '{}'
end`;

export function itemView(row: Item): TranscriptItem {
  const {
    version,
    completedAt,
    tool,
    requestKind,
    waitedSince,
    endedAt,
    replyMessageId,
    failure,
    interruptedCause,
    stopConfirmedAt,
    retry,
    usage,
    messageKind,
    messageAuthor,
    edit,
    delivery,
    assignment,
    ...stored
  } = row.view;
  // An item stored before team removal may still carry a team source or delivery; neither is read.
  const {
    teamSource: _teamSource,
    runDelivery: _runDelivery,
    ...view
  } = stored as typeof stored & { readonly teamSource?: unknown; readonly runDelivery?: unknown };
  const base = {
    id: row.id,
    kind: row.kind,
    revision: row.revision,
    position: row.position,
    runId: row.runId,
    attemptId: row.attemptId,
    nodeId: itemScopeNodeId(row),
    isTurnStart: row.isTurnStart,
    createdAt: row.createdAt.toISOString(),
    view,
  };
  switch (row.kind) {
    case "message": {
      const facts = row.messageText;
      const carried =
        (row.refs?.attachments?.length ?? 0) +
        (row.refs?.pages?.length ?? 0) +
        (row.refs?.places?.length ?? 0);
      const inlineText =
        facts && facts.text !== null && fitsInlineTranscriptText(facts.text)
          ? facts.text
          : undefined;
      const { truncated: _truncated, ...cleanView } = view;
      const messageView =
        facts === undefined || facts === null
          ? view
          : inlineText === undefined || carried < facts.richPartCount
            ? { ...cleanView, truncated: true }
            : cleanView;
      return TranscriptItemSchema.parse({
        ...base,
        view: messageView,
        ...row.refs,
        messageId: row.messageId,
        messageKind,
        // A teammate's message kept from before team removal shows without an author.
        author:
          (messageAuthor as { readonly kind?: string } | undefined)?.kind === "team-member"
            ? undefined
            : messageAuthor,
        edit,
        delivery,
        ...(inlineText !== undefined ? { text: inlineText } : {}),
      });
    }
    case "node-message": {
      const raw = row.nodeMessageText ?? (typeof row.body === "string" ? row.body : undefined);
      const inlineText = raw !== undefined && fitsInlineTranscriptText(raw) ? raw : undefined;
      const { truncated: _truncated, ...cleanView } = view;
      return TranscriptItemSchema.parse({
        ...base,
        view: inlineText === undefined ? view : cleanView,
        ...(inlineText !== undefined ? { text: inlineText } : {}),
      });
    }
    case "run":
      return TranscriptItemSchema.parse({
        ...base,
        endedAt,
        replyMessageId,
        failure,
        ...(interruptedCause ? { interruptedCause } : {}),
        ...(stopConfirmedAt ? { stopConfirmedAt } : {}),
        retry,
        usage,
      });
    case "tool":
      return TranscriptItemSchema.parse({ ...base, toolCallId: row.toolCallId, tool, completedAt });
    case "request": {
      const question = row.question ? answeredQuestion(row.question) : null;
      return TranscriptItemSchema.parse({
        ...base,
        requestId: row.requestId,
        requestKind,
        waitedSince,
        ...(question
          ? { question: answeredQuestionWithin(question, answeredQuestionPreviewBytes) }
          : {}),
      });
    }
    case "node":
      return TranscriptItemSchema.parse({
        ...base,
        executionNodeId: row.executionNodeId,
        ...(row.node ? { node: nodeCardView(row.node) } : {}),
      });
    case "assignment":
    case "delegation":
      return TranscriptItemSchema.parse({
        ...base,
        kind: "assignment",
        delegationId: row.delegationId,
        assignment,
      });
    case "app":
      return TranscriptItemSchema.parse({ ...base, appId: row.appId, version });
    case "place":
      return TranscriptItemSchema.parse({
        ...base,
        place: row.place ?? (typeof row.body === "object" ? (row.body ?? undefined) : undefined),
      });
    case "reasoning":
      return TranscriptItemSchema.parse({
        ...base,
        blockId: row.blockId,
        bindingGeneration: row.bindingGeneration,
      });
    default:
      return TranscriptItemSchema.parse(base);
  }
}

export interface TranscriptCursor {
  readonly deploymentId: DeploymentId;
  readonly epoch: string;
  readonly viewerId: UserId;
  readonly threadId: ThreadId;
  readonly nodeId: ExecutionNodeId | null;
  readonly beforePosition: string;
  readonly beforeId: string;
}

export function drawableItems(tx: Read, scope: DetailScope, includeProse = true) {
  const query = tx
    .selectFrom("transcriptItems")
    .select(itemColumns)
    .select(sql<PlaceView | null>`case when kind = 'place' then body end`.as("place"))
    .select(nodeFacts.as("node"))
    .select(questionFacts.as("question"))
    .select(
      (includeProse ? messageTextFacts : sql<MessageTextFacts | null>`null`).as("messageText"),
    )
    .select((includeProse ? nodeMessageTextFacts : sql<string | null>`null`).as("nodeMessageText"))
    .where("visible", "=", true)
    .where("threadId", "=", scope.threadId);
  return scope.kind === "node"
    ? query.where("nodeId", "=", scope.nodeId).where(sql.raw<boolean>(nodeItemsPredicate))
    : query.where(sql.raw<boolean>(taskItemsPredicate));
}

/** The node whose scope draws an item: null for the task, by the rule `drawableItems` reads with. */
export function itemScopeNodeId(row: Pick<Item, "kind" | "nodeId" | "view">) {
  return row.kind === "request" && row.view.requestKind === "harness.approval" ? null : row.nodeId;
}

const transcriptHydrationBatchSize = 25;

/**
 * Exact JSON-encoded inline prose byte length computed in SQL without transferring prose text.
 * Matches `fitsInlineTranscriptText` for valid UTF-8 strings and acts as a strict lower bound on
 * `encodedItemBytes(item)` so `selectHydratedWindow` never hydrates items that cannot fit.
 */
const inlineTextMinBytes = sql<number>`(
  case
    when kind = 'message' then coalesce((
      select case
        when octet_length(to_jsonb(t.text)::text) <= ${sql.lit(transcriptInlineTextMaxBytes)}
        then octet_length(to_jsonb(t.text)::text)
        else 0
      end
      from messages m,
      lateral (
        select coalesce(
          string_agg(p.part->>'text', E'\n' order by p.at) filter (where p.part->>'type' = 'text'),
          ''
        ) as text
        from jsonb_array_elements(m.content) with ordinality p(part, at)
      ) t
      where m.id = transcript_items.message_id and m.thread_id = transcript_items.thread_id
    ), 0)
    when kind = 'node-message' and octet_length(body::text) <= ${sql.lit(transcriptInlineTextMaxBytes)}
      then octet_length(body::text)
    else 0
  end
)::int`;

const estimatedItemBytes = sql<number>`(
  octet_length(view::text) + coalesce(octet_length(refs::text), 0) + 256 + ${inlineTextMinBytes}
)::int`;

function drawableItemKeys(tx: Read, scope: DetailScope) {
  const query = tx
    .selectFrom("transcriptItems")
    .select(["id", "position", "isTurnStart"])
    .select(inlineTextMinBytes.as("minBytes"))
    .select(estimatedItemBytes.as("estimatedBytes"))
    .where("visible", "=", true)
    .where("threadId", "=", scope.threadId);
  return scope.kind === "node"
    ? query.where("nodeId", "=", scope.nodeId).where(sql.raw<boolean>(nodeItemsPredicate))
    : query.where(sql.raw<boolean>(taskItemsPredicate));
}

function encodedItemBytes(item: TranscriptItem) {
  const privateBytes =
    item.kind === "message" && item.author?.kind === "human" ? clientSendKeyWireReserve : 0;
  return Buffer.byteLength(JSON.stringify(item)) + privateBytes + 1;
}

/** Strips inline prose down to a bounded card if a single item would exceed a hard frame ceiling. */
function cardWithinCeiling(row: Item, item: TranscriptItem, hardMaxBytes: number): TranscriptItem {
  if (encodedItemBytes(item) <= hardMaxBytes) return item;
  return itemView({
    ...row,
    body: null,
    messageText: null,
    nodeMessageText: null,
    view:
      row.kind === "message" || row.kind === "node-message"
        ? { ...row.view, truncated: true }
        : row.view,
  });
}

/**
 * Hydrates candidate items in budget-sized batches (never more than `transcriptHydrationBatchSize`
 * rows at a time), stopping before hydration whenever the next candidate's exact inline prose lower
 * bound already exceeds the remaining byte budget. When `allowFirstOverBudget` is true, the first
 * item still enters whole up to `hardMaxBytes`.
 */
async function selectHydratedWindow(
  tx: Read,
  scope: DetailScope,
  candidates: readonly {
    readonly id: string;
    readonly minBytes: number;
    readonly estimatedBytes: number;
  }[],
  limit: number,
  maxBytes: number,
  hardMaxBytes: number,
  maxTurns: number,
  allowFirstOverBudget = true,
) {
  const selected: { readonly row: Item; readonly item: TranscriptItem }[] = [];
  let bytes = 0;
  let turns = 0;
  let offset = 0;
  while (offset < candidates.length && selected.length < limit) {
    const remaining = Math.max(0, maxBytes - bytes);
    const enforceBounds = selected.length > 0 || !allowFirstOverBudget;
    const first = candidates[offset]!;
    if (enforceBounds && (remaining === 0 || (Number(first.minBytes) || 0) > remaining)) break;
    const batchIds: string[] = [];
    let batchEstimated = 0;
    while (
      offset < candidates.length &&
      batchIds.length < transcriptHydrationBatchSize &&
      selected.length + batchIds.length < limit
    ) {
      const candidate = candidates[offset]!;
      const nextMin = Number(candidate.minBytes) || 0;
      const nextEstimate = Math.max(256, Number(candidate.estimatedBytes) || 256);
      if (batchIds.length > 0 && (batchEstimated + nextEstimate > remaining || nextMin > remaining))
        break;
      batchIds.push(candidate.id);
      batchEstimated += nextEstimate;
      offset += 1;
    }
    const hydrated = await drawableItems(tx, scope).where("id", "in", batchIds).execute();
    const byId = new Map(hydrated.map((row) => [row.id, row]));
    for (const id of batchIds) {
      if (selected.length >= limit) break;
      const row = byId.get(id);
      if (!row) continue;
      const rawItem = itemView(row);
      const item =
        selected.length === 0 && allowFirstOverBudget
          ? cardWithinCeiling(row, rawItem, hardMaxBytes)
          : rawItem;
      const size = encodedItemBytes(item);
      const enforceBounds = selected.length > 0 || !allowFirstOverBudget;
      if (enforceBounds && (bytes + size > maxBytes || (row.isTurnStart && turns >= maxTurns))) {
        return { selected, bytes, turns };
      }
      bytes += size;
      if (row.isTurnStart) turns++;
      selected.push({ row, item });
    }
  }
  return { selected, bytes, turns };
}

type Selected = { readonly row: Item; readonly item: TranscriptItem };

/**
 * The Run cards of the Runs a page's rows belong to that the rows do not hold. Every row of a Run
 * reads its state and its reply from the Run's card, however far above a page the Run began, so a
 * page carries them beside its rows. They count against the page's bytes like its rows: while the
 * two do not fit, the page gives up rows at its far ends, each part (in `parts` order, as `min`
 * allows) from its end, and the cards those rows needed with them. A task's Runs only: a
 * subagent's steps draw none.
 */
async function fitRunCards(
  tx: Read,
  scope: DetailScope,
  parts: readonly { readonly rows: Selected[]; readonly min: number }[],
  budget: number,
): Promise<TranscriptItem[]> {
  if (scope.kind !== "thread") return [];
  const all = parts.flatMap(({ rows }) => rows);
  const runIds = [...new Set(all.flatMap(({ row }) => (row.runId ? [row.runId] : [])))];
  if (!runIds.length) return [];
  const cards = new Map(
    (
      await drawableItems(tx, scope)
        .where("kind", "=", "run")
        .where("runId", "in", runIds)
        .execute()
    ).map((row) => [row.runId!, itemView(row)] as const),
  );
  const needed = () => {
    const rows = parts.flatMap(({ rows }) => rows);
    const held = new Set(rows.flatMap(({ row }) => (row.kind === "run" ? [row.runId] : [])));
    const ids = new Set(
      rows.flatMap(({ row }) => (row.runId && !held.has(row.runId) ? [row.runId] : [])),
    );
    return [...ids].flatMap((id) => cards.get(id) ?? []);
  };
  const bytes = (runs: readonly TranscriptItem[]) =>
    parts.reduce(
      (sum, { rows }) => rows.reduce((total, { item }) => total + encodedItemBytes(item), sum),
      0,
    ) + runs.reduce((sum, run) => sum + encodedItemBytes(run), 0);
  let runs = needed();
  while (runs.length && bytes(runs) > budget) {
    const part = parts.find(({ rows, min }) => rows.length > min);
    if (!part) break;
    part.rows.pop();
    runs = needed();
  }
  return runs;
}

export function readTranscriptPage(
  database: Database,
  input: {
    readonly viewerId: UserId;
    readonly scope: DetailScope;
    readonly cursor?: TranscriptCursor;
    readonly after?: TranscriptCursor;
    readonly anchorItemId?: string;
    readonly limit?: number;
    readonly maxBytes?: number;
    readonly maxTurns?: number;
    /** Already authorized in this read (a detail snapshot): its cut and its task, not read again. */
    readonly authorized?: {
      readonly state: {
        readonly deploymentId: DeploymentId;
        readonly epoch: string;
        readonly sequence: string;
      };
      readonly thread: { readonly id: ThreadId; readonly revision: string };
    };
  },
) {
  return withPersonalSyncRead(database, async (tx) => {
    if ((input.cursor && input.after) || (input.anchorItemId && (input.cursor || input.after)))
      throw new OpensteerError({
        code: "bad_request",
        message: "Choose one transcript page boundary",
      });
    const state = input.authorized?.state ?? (await authorizedSyncState(tx, input.viewerId));
    const thread =
      input.authorized?.thread ?? (await authorizedDetail(tx, input.viewerId, input.scope));
    if (!thread) return { kind: "unavailable" as const };
    const scope = input.scope;
    const nodeId = scope.kind === "node" ? scope.nodeId : null;
    const cursor = input.cursor ?? input.after;
    if (
      cursor &&
      (cursor.deploymentId !== state.deploymentId ||
        cursor.viewerId !== input.viewerId ||
        cursor.threadId !== scope.threadId ||
        cursor.nodeId !== nodeId)
    )
      throw new OpensteerError({
        code: "forbidden",
        message: "The transcript cursor belongs to another scope",
      });
    // Keyset cursors stay valid while cards move or hide; only a new epoch resets history.
    if (cursor && cursor.epoch !== state.epoch) return { kind: "history-reset" as const };
    const limit = Math.max(1, Math.min(input.limit ?? 100, 100));
    const maxBytes = Math.max(8192, Math.min(input.maxBytes ?? 1024 * 1024, 1024 * 1024));
    const from = drawableItems(tx, scope);
    const keys = drawableItemKeys(tx, scope);
    const anchor = input.anchorItemId
      ? ((await from.where("id", "=", input.anchorItemId).executeTakeFirst()) ??
        (await from.where(sql<boolean>`message_id = ${input.anchorItemId}`).executeTakeFirst()))
      : undefined;
    const budget = maxBytes - 1024;
    const hardCeiling = Math.max(budget, 768 * 1024);
    const maxTurns = Math.max(1, input.maxTurns ?? Number.MAX_SAFE_INTEGER);
    const keyQuery = keys.orderBy("position", "desc").orderBy("id", "desc");
    let olderKeyQuery = keyQuery;
    if (cursor)
      olderKeyQuery = keyQuery.where(
        sql<boolean>`(position,id) < (${cursor.beforePosition}::bigint,${cursor.beforeId})`,
      );
    const makeCursor = (boundary: Item | undefined): TranscriptCursor | null =>
      boundary?.position
        ? {
            deploymentId: state.deploymentId,
            epoch: state.epoch,
            viewerId: input.viewerId,
            threadId: thread.id,
            nodeId,
            beforePosition: boundary.position,
            beforeId: boundary.id,
          }
        : null;
    if (input.after) {
      const candidates = await keys
        .where(
          sql<boolean>`(position,id) > (${input.after.beforePosition}::bigint,${input.after.beforeId})`,
        )
        .orderBy("position")
        .orderBy("id")
        .limit(limit + 1)
        .execute();
      const { selected } = await selectHydratedWindow(
        tx,
        scope,
        candidates,
        limit,
        budget,
        hardCeiling,
        maxTurns,
      );
      const runs = await fitRunCards(tx, scope, [{ rows: selected, min: 1 }], budget);
      const hasMore = candidates.length > selected.length;
      return {
        kind: "page" as const,
        revision: state.sequence,
        items: selected.map(({ item }) => item),
        ...(runs.length ? { runs } : {}),
        hasMore,
        anchorItemId: null,
        nextBefore: null,
        nextAfter: hasMore ? makeCursor(selected.at(-1)?.row) : null,
      };
    }
    let rows: Selected[];
    let newer: Selected[] = [];
    let runs: TranscriptItem[] = [];
    let hasMore: boolean;
    let nextAfter: TranscriptCursor | null = null;
    if (anchor?.position) {
      const newerLimit = Math.floor((limit - 1) / 2);
      const olderLimit = limit - 1 - newerLimit;
      const anchorItem = cardWithinCeiling(anchor, itemView(anchor), hardCeiling);
      const anchorBytes = encodedItemBytes(anchorItem);
      const anchorTurns = Number(anchor.isTurnStart);
      const newerCandidates = newerLimit
        ? await keys
            .where(sql<boolean>`(position,id) > (${anchor.position}::bigint,${anchor.id})`)
            .orderBy("position")
            .orderBy("id")
            .limit(newerLimit)
            .execute()
        : [];
      const selectedNewer = await selectHydratedWindow(
        tx,
        scope,
        newerCandidates,
        newerLimit,
        Math.max(0, Math.floor((budget - anchorBytes) / 2)),
        hardCeiling,
        maxTurns - anchorTurns,
        false,
      );
      const olderCandidates = await keyQuery
        .where(sql<boolean>`(position,id) < (${anchor.position}::bigint,${anchor.id})`)
        .limit(olderLimit + 1)
        .execute();
      const selectedOlder = await selectHydratedWindow(
        tx,
        scope,
        olderCandidates,
        olderLimit,
        Math.max(0, budget - anchorBytes - selectedNewer.bytes),
        hardCeiling,
        maxTurns - anchorTurns - selectedNewer.turns,
        false,
      );
      rows = [{ row: anchor, item: anchorItem }, ...selectedOlder.selected];
      newer = selectedNewer.selected;
      // The older rows give way first, then the newer: the anchor always stays.
      runs = await fitRunCards(
        tx,
        scope,
        [
          { rows, min: 1 },
          { rows: newer, min: 0 },
        ],
        budget,
      );
      const newest = newer.at(-1)?.row ?? anchor;
      const remainingNewer =
        newer.length < newerCandidates.length ||
        Boolean(
          await keys
            .clearSelect()
            .select("id")
            .where(sql<boolean>`(position,id) > (${newest.position}::bigint,${newest.id})`)
            .orderBy("position")
            .orderBy("id")
            .limit(1)
            .executeTakeFirst(),
        );
      if (remainingNewer) nextAfter = makeCursor(newest);
      hasMore = olderCandidates.length > rows.length - 1;
    } else {
      const candidates = await olderKeyQuery.limit(limit + 1).execute();
      rows = (
        await selectHydratedWindow(tx, scope, candidates, limit, budget, hardCeiling, maxTurns)
      ).selected;
      runs = await fitRunCards(tx, scope, [{ rows, min: 1 }], budget);
      hasMore = candidates.length > rows.length;
    }
    const oldest = rows.at(-1)?.row;
    const nextBefore = hasMore ? makeCursor(oldest) : null;
    return {
      kind: "page" as const,
      revision: state.sequence,
      ...(runs.length ? { runs } : {}),
      items: [...rows.reverse(), ...newer].map(({ item }) => item),
      hasMore,
      nextBefore,
      nextAfter,
      anchorItemId: anchor?.id ?? null,
    };
  });
}

export function readTranscriptItem(
  database: Database,
  input: {
    readonly viewerId: UserId;
    readonly scope: DetailScope;
    readonly itemId: string;
    readonly expectedRevision?: string;
  },
) {
  return withPersonalSyncRead(database, async (tx) => {
    await authorizedSyncState(tx, input.viewerId);
    if (!(await authorizedDetail(tx, input.viewerId, input.scope)))
      return { kind: "unavailable" as const };
    const item = await drawableItems(tx, input.scope, false)
      .where("id", "=", input.itemId)
      .executeTakeFirst();
    if (!item) return { kind: "unavailable" as const };
    if (input.expectedRevision !== undefined && item.revision !== input.expectedRevision)
      return { kind: "revision-conflict" as const, revision: item.revision };
    let body: unknown = null;
    // The response carries the full body in `body`; omit duplicate inline prose from `item`.
    const headerItem = () =>
      itemView({ ...item, body: null, messageText: null, nodeMessageText: null });
    const tooLarge = () => ({
      kind: "item" as const,
      item: headerItem(),
      body: null,
      truncated: true,
    });
    if (item.messageId) {
      const fits = await tx
        .selectFrom("messages")
        .select(
          sql<boolean>`octet_length(jsonb_build_array(author,content,quote,origin)::text) <= 1000000`.as(
            "fits",
          ),
        )
        .where("id", "=", item.messageId)
        .where("threadId", "=", item.threadId)
        .executeTakeFirst();
      if (!fits) return { kind: "unavailable" as const };
      if (!fits.fits) return tooLarge();
      const message = await tx
        .selectFrom("messages")
        .selectAll()
        .where("id", "=", item.messageId)
        .where("threadId", "=", item.threadId)
        .executeTakeFirstOrThrow();
      if (isRetiredMessageRow(message)) {
        // A teammate's message has no Message without its author: its text, without the author.
        const text = (
          message.content as readonly { readonly type: string; readonly text?: string }[]
        )
          .flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : []))
          .join("\n\n");
        if (!fitsInlineTranscriptText(text)) return tooLarge();
        body = { kind: "text", text };
      } else
        try {
          body = { kind: "message", message: messageViewFromRow(message) };
        } catch {
          return tooLarge();
        }
    } else if (item.toolCallId) {
      const toolScope = tx
        .selectFrom("toolCalls")
        .where("id", "=", item.toolCallId)
        .where("threadId", "=", item.threadId)
        .where(
          sql<boolean>`run_id is not distinct from ${item.runId} and attempt_id is not distinct from ${item.attemptId} and node_id is not distinct from ${item.nodeId}`,
        );
      const fits = await toolScope
        .select(
          sql<boolean>`octet_length(jsonb_build_array(integration,arguments,output)::text) <= 1000000`.as(
            "fits",
          ),
        )
        .executeTakeFirst();
      if (!fits) return { kind: "unavailable" as const };
      if (!fits.fits) return tooLarge();
      const tool = await toolScope
        .select(["arguments", "output", "integration"])
        .executeTakeFirstOrThrow();
      const { output } = tool;
      const images = await tx
        .selectFrom("toolOutputImages")
        .select(["id", "mediaType", "generated"])
        .where("toolCallId", "=", item.toolCallId)
        .where("threadId", "=", item.threadId)
        .where(sql<boolean>`node_id is not distinct from ${item.nodeId}`)
        .orderBy("imageIndex")
        .limit(8)
        .execute();
      body = {
        kind: "tool",
        arguments: tool.arguments,
        ...(tool.integration ? { integration: tool.integration } : {}),
        ...(output ? { output: { text: output.text, truncation: output.truncation } } : {}),
        ...(images.length
          ? {
              images: images.map(({ generated, ...image }) => ({
                ...image,
                ...(generated ? { generated: true } : {}),
              })),
            }
          : {}),
      };
    } else if (item.kind === "reasoning" || item.kind === "node-message" || item.kind === "place") {
      const owned = await tx
        .selectFrom("transcriptItems")
        .select(
          sql<
            string | Record<string, unknown> | null
          >`case when octet_length(body::text) <= 1000000 then body end`.as("body"),
        )
        .where("id", "=", item.id)
        .executeTakeFirstOrThrow();
      if (owned.body === null) return tooLarge();
      body =
        typeof owned.body === "string"
          ? { kind: "text", text: owned.body }
          : { kind: "place", place: owned.body };
    }
    const response = { kind: "item" as const, item: headerItem(), body, truncated: false };
    return Buffer.byteLength(JSON.stringify(response)) <= 1024 * 1024 - 1024
      ? response
      : tooLarge();
  });
}
