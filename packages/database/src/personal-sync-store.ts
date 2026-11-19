import type { DatabaseSchema } from "./schema.js";
import {
  OpensteerError,
  type DeploymentId,
  type ExecutionNodeId,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import { messageViewFromRow } from "./thread-row-mappers.js";
import { clientSendKeyWireReserve, TranscriptItemSchema } from "@opensteer/protocol/transcript";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import type {
  ClientChangesTable,
  PersonalScopeKey,
  PlaceView,
  TranscriptItemTable,
} from "./personal-state-schema.js";

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
            eb.selectFrom("users").select("users.id").orderBy("users.createdAt", "asc").limit(1),
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
    .select(["id", "revision", "transcriptOrderRevision"])
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

type ReplayChange = Pick<
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
    if (!cursor)
      return { kind: "snapshot" as const, state, snapshot: await input.snapshot(tx, state) };
    if (cursor.scopeKey !== scopeKey || cursor.epoch !== state.epoch)
      return { kind: "snapshot-required" as const, reason: "scope-changed" as const, state };
    const after = BigInt(cursor.afterSequence);
    if (after > BigInt(state.sequence) || after < BigInt(state.prunedThroughSequence))
      return { kind: "snapshot-required" as const, reason: "cursor-unavailable" as const, state };
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
    if (changes.length > replayMaxRows)
      return { kind: "snapshot-required" as const, reason: "replay-overflow" as const, state };
    let previous = cursor.afterSequence;
    let batch: ReplayChange[] = [];
    let bytes = 0;
    const commits: ScopeCommit[] = [];
    for (const row of changes) {
      if (
        row.operation === "invalidate" &&
        row.entityKind === "collection" &&
        row.entityId === "scope"
      )
        return { kind: "snapshot-required" as const, reason: "scope-invalidated" as const, state };
      const last = batch.at(-1);
      if (last && last.sequence !== row.sequence) {
        commits.push({ fromSequence: previous, throughSequence: last.sequence, changes: batch });
        previous = last.sequence;
        batch = [];
      }
      const { payload, ...change } = row;
      const value = row.operation === "remove" ? change : { ...change, value: payload };
      bytes += Buffer.byteLength(JSON.stringify(value));
      if (bytes > replayMaxBytes)
        return { kind: "snapshot-required" as const, reason: "replay-overflow" as const, state };
      batch.push(value);
    }
    const last = batch.at(-1);
    if (last) {
      commits.push({ fromSequence: previous, throughSequence: last.sequence, changes: batch });
      previous = last.sequence;
    }
    if (previous !== state.sequence)
      commits.push({ fromSequence: previous, throughSequence: state.sequence, changes: [] });
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
] as const;
type Item = Pick<Selectable<TranscriptItemTable>, (typeof itemColumns)[number]> & {
  readonly place?: PlaceView | null;
  readonly body?: Selectable<TranscriptItemTable>["body"];
};

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
    nodeId: row.nodeId,
    isTurnStart: row.isTurnStart,
    createdAt: row.createdAt.toISOString(),
    view,
  };
  switch (row.kind) {
    case "message":
      return TranscriptItemSchema.parse({
        ...base,
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
    case "request":
      return TranscriptItemSchema.parse({
        ...base,
        requestId: row.requestId,
        requestKind,
        waitedSince,
      });
    case "node":
      return TranscriptItemSchema.parse({ ...base, executionNodeId: row.executionNodeId });
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
  readonly orderRevision: string;
  readonly beforePosition: string;
  readonly beforeId: string;
}

export function drawableItems(tx: Read, scope: DetailScope) {
  const query = tx
    .selectFrom("transcriptItems")
    .select(itemColumns)
    .select(sql<PlaceView | null>`case when kind = 'place' then body end`.as("place"))
    .where("visible", "=", true)
    .where("threadId", "=", scope.threadId);
  return scope.kind === "node"
    ? query.where("nodeId", "=", scope.nodeId)
    : query.where("nodeId", "is", null);
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
  },
) {
  return withPersonalSyncRead(database, async (tx) => {
    if ((input.cursor && input.after) || (input.anchorItemId && (input.cursor || input.after)))
      throw new OpensteerError({
        code: "bad_request",
        message: "Choose one transcript page boundary",
      });
    const state = await authorizedSyncState(tx, input.viewerId);
    const thread = await authorizedDetail(tx, input.viewerId, input.scope);
    if (!thread) return { kind: "unavailable" as const };
    const scope = input.scope;
    const nodeId = scope.kind === "node" ? scope.nodeId : null;
    const cursor = input.cursor ?? input.after;
    const revision = thread.transcriptOrderRevision;
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
    if (cursor && (cursor.epoch !== state.epoch || cursor.orderRevision !== revision))
      return { kind: "history-reset" as const, orderRevision: revision };
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
            orderRevision: revision,
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
        orderRevision: revision,
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
      orderRevision: revision,
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
