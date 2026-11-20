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
import { executionNodeFromRow, messageViewFromRow } from "./thread-row-mappers.js";
import { clientSendKeyWireReserve, TranscriptItemSchema } from "@opensteer/protocol/transcript";
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
const replayMaxBytes = 256 * 1024;

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
    const changes = await tx
      .selectFrom("clientChanges")
      .select(["sequence", "ordinal", "entityKind", "entityId", "operation", "payload"])
      .where("deploymentId", "=", state.deploymentId)
      .where("scopeKey", "=", scopeKey)
      .where("sequence", ">", cursor.afterSequence)
      .where("sequence", "<=", state.sequence)
      .orderBy("sequence")
      .orderBy("ordinal")
      .limit(replayMaxRows + 1)
      .execute();
    if (changes.length > replayMaxRows || changes.some((row) => row.operation === "reset"))
      return snapshot();
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

export function itemView(row: Item) {
  const {
    version,
    completedAt,
    tool,
    requestKind,
    waitedSince,
    endedAt,
    replyMessageId,
    failure,
    usage,
    runDelivery,
    messageKind,
    messageAuthor,
    edit,
    delivery,
    assignment,
    teamSource,
    ...view
  } = row.view;
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
    case "message":
      return TranscriptItemSchema.parse({
        ...base,
        ...row.refs,
        messageId: row.messageId,
        messageKind,
        author: messageAuthor,
        edit,
        delivery,
        teamSource,
      });
    case "run":
      return TranscriptItemSchema.parse({
        ...base,
        endedAt,
        replyMessageId,
        failure,
        usage,
        delivery: runDelivery,
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

export function drawableItems(tx: Read, scope: DetailScope) {
  const query = tx
    .selectFrom("transcriptItems")
    .select(itemColumns)
    .select(sql<PlaceView | null>`case when kind = 'place' then body end`.as("place"))
    .select(nodeFacts.as("node"))
    .select(questionFacts.as("question"))
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

function itemBytes(row: Item) {
  const item = itemView(row);
  const privateBytes =
    item.kind === "message" && item.author?.kind === "human" ? clientSendKeyWireReserve : 0;
  return Buffer.byteLength(JSON.stringify(item)) + privateBytes + 1;
}

function itemWindow(items: readonly Item[], limit: number, maxBytes: number, maxTurns: number) {
  const selected: Item[] = [];
  let bytes = 0;
  let turns = 0;
  for (const row of items) {
    const size = itemBytes(row);
    if (
      selected.length >= limit ||
      bytes + size > maxBytes ||
      (row.isTurnStart && turns >= maxTurns)
    )
      break;
    bytes += size;
    if (row.isTurnStart) turns++;
    selected.push(row);
  }
  return { selected, bytes, turns };
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
    const maxBytes = Math.max(8192, Math.min(input.maxBytes ?? 128 * 1024, 128 * 1024));
    const from = drawableItems(tx, scope);
    const anchor = input.anchorItemId
      ? ((await from.where("id", "=", input.anchorItemId).executeTakeFirst()) ??
        (await from.where(sql<boolean>`message_id = ${input.anchorItemId}`).executeTakeFirst()))
      : undefined;
    const budget = maxBytes - 1024;
    const maxTurns = Math.max(1, input.maxTurns ?? Number.MAX_SAFE_INTEGER);
    const query = from.orderBy("position", "desc").orderBy("id", "desc");
    let olderQuery = query;
    if (cursor)
      olderQuery = query.where(
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
      const candidates = await from
        .where(
          sql<boolean>`(position,id) > (${input.after.beforePosition}::bigint,${input.after.beforeId})`,
        )
        .orderBy("position")
        .orderBy("id")
        .limit(limit + 1)
        .execute();
      const { selected } = itemWindow(candidates, limit, budget, maxTurns);
      const hasMore = candidates.length > selected.length;
      return {
        kind: "page" as const,
        revision: state.sequence,
        items: selected.map(itemView),
        hasMore,
        nextBefore: null,
        nextAfter: hasMore ? makeCursor(selected.at(-1)) : null,
      };
    }
    let rows: Item[];
    let newer: Item[] = [];
    let hasMore: boolean;
    let nextAfter: TranscriptCursor | null = null;
    if (anchor?.position) {
      const newerLimit = Math.floor((limit - 1) / 2);
      const olderLimit = limit - 1 - newerLimit;
      const anchorBytes = itemBytes(anchor);
      const anchorTurns = Number(anchor.isTurnStart);
      const newerCandidates = newerLimit
        ? await from
            .where(sql<boolean>`(position,id) > (${anchor.position}::bigint,${anchor.id})`)
            .orderBy("position")
            .orderBy("id")
            .limit(newerLimit)
            .execute()
        : [];
      const selectedNewer = itemWindow(
        newerCandidates,
        newerLimit,
        Math.floor((budget - anchorBytes) / 2),
        maxTurns - anchorTurns,
      );
      const olderCandidates = await query
        .where(sql<boolean>`(position,id) < (${anchor.position}::bigint,${anchor.id})`)
        .limit(olderLimit + 1)
        .execute();
      const selectedOlder = itemWindow(
        olderCandidates,
        olderLimit,
        budget - anchorBytes - selectedNewer.bytes,
        maxTurns - anchorTurns - selectedNewer.turns,
      );
      rows = [anchor, ...selectedOlder.selected];
      newer = selectedNewer.selected;
      const newest = newer.at(-1) ?? anchor;
      const remainingNewer =
        newer.length < newerCandidates.length ||
        Boolean(
          await from
            .clearSelect()
            .select("id")
            .where(sql<boolean>`(position,id) > (${newest.position}::bigint,${newest.id})`)
            .orderBy("position")
            .orderBy("id")
            .limit(1)
            .executeTakeFirst(),
        );
      if (remainingNewer) nextAfter = makeCursor(newest);
      hasMore = olderCandidates.length > selectedOlder.selected.length;
    } else {
      const candidates = await olderQuery.limit(limit + 1).execute();
      rows = itemWindow(candidates, limit, budget, maxTurns).selected;
      hasMore = candidates.length > rows.length;
    }
    const oldest = rows.at(-1);
    const nextBefore = hasMore ? makeCursor(oldest) : null;
    return {
      kind: "page" as const,
      revision: state.sequence,
      items: [...rows.reverse(), ...newer].map(itemView),
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
    const item = await drawableItems(tx, input.scope)
      .where("id", "=", input.itemId)
      .executeTakeFirst();
    if (!item) return { kind: "unavailable" as const };
    if (input.expectedRevision !== undefined && item.revision !== input.expectedRevision)
      return { kind: "revision-conflict" as const, revision: item.revision };
    let body: unknown = null;
    const tooLarge = () => ({
      kind: "item" as const,
      item: itemView(item),
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
      body = { kind: "message", message: messageViewFromRow(message) };
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
    const response = { kind: "item" as const, item: itemView(item), body, truncated: false };
    return Buffer.byteLength(JSON.stringify(response)) <= 1024 * 1024 - 1024
      ? response
      : tooLarge();
  });
}
