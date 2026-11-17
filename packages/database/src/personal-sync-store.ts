import {
  OpensteerError,
  type DeploymentId,
  type ExecutionNodeId,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import { TranscriptItemSchema } from "@opensteer/protocol/transcript";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import type {
  ClientChangesTable,
  PersonalScopeKey,
  PersonalStateSchema,
  TranscriptItemTable,
} from "./personal-state-schema.js";

type Database = Kysely<PersonalStateSchema>;
type Read = Transaction<PersonalStateSchema>;

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
    .innerJoin("personalSettings as settings", (join) =>
      join.on("settings.singletonKey", "=", "personal"),
    )
    .innerJoin("users as owner", "owner.id", "settings.ownerId")
    .selectAll("sync")
    .where("owner.id", "=", viewerId)
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
    .select(["id", "transcriptOrderRevision"])
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

interface ScopeCommit {
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

const itemColumns = [
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
type Item = Pick<Selectable<TranscriptItemTable>, (typeof itemColumns)[number]>;

export function itemView(row: Item) {
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
    view: row.view,
  };
  switch (row.kind) {
    case "message":
      return TranscriptItemSchema.parse({ ...base, messageId: row.messageId });
    case "tool":
      return TranscriptItemSchema.parse({ ...base, toolCallId: row.toolCallId });
    case "request":
      return TranscriptItemSchema.parse({ ...base, requestId: row.requestId });
    case "node":
      return TranscriptItemSchema.parse({ ...base, executionNodeId: row.executionNodeId });
    case "assignment":
    case "delegation":
      return TranscriptItemSchema.parse({ ...base, delegationId: row.delegationId });
    case "app":
      return TranscriptItemSchema.parse({ ...base, appId: row.appId });
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
    .where("visible", "=", true)
    .where("threadId", "=", scope.threadId);
  return scope.kind === "node"
    ? query.where("nodeId", "=", scope.nodeId)
    : query.where("nodeId", "is", null);
}

function itemWindow(items: readonly Item[], limit: number, maxBytes: number, maxTurns: number) {
  const result: Item[] = [];
  let bytes = 1024;
  let turns = 0;
  for (const row of items) {
    const size = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (result.length >= limit || bytes + size > maxBytes || (row.isTurnStart && turns >= maxTurns))
      break;
    bytes += size;
    if (row.isTurnStart) turns++;
    result.push(row);
  }
  return result;
}

export function readTranscriptPage(
  database: Database,
  input: {
    readonly viewerId: UserId;
    readonly scope: DetailScope;
    readonly cursor?: TranscriptCursor;
    readonly anchorItemId?: string;
    readonly limit?: number;
    readonly maxBytes?: number;
    readonly maxTurns?: number;
  },
) {
  return withPersonalSyncRead(database, async (tx) => {
    const state = await authorizedSyncState(tx, input.viewerId);
    const thread = await authorizedDetail(tx, input.viewerId, input.scope);
    if (!thread) return { kind: "unavailable" as const };
    const scope = input.scope;
    const nodeId = scope.kind === "node" ? scope.nodeId : null;
    const cursor = input.cursor;
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
      ? await from.where("id", "=", input.anchorItemId).executeTakeFirst()
      : undefined;
    const newer =
      anchor && limit > 2
        ? await from
            .where(sql<boolean>`(position,id) > (${anchor.position}::bigint,${anchor.id})`)
            .orderBy("position")
            .orderBy("id")
            .limit(Math.floor((limit - 1) / 2))
            .execute()
        : [];
    const maxTurns = Math.max(1, input.maxTurns ?? Number.MAX_SAFE_INTEGER);
    const newerSelected = itemWindow(
      newer,
      newer.length,
      Math.floor(maxBytes / 2),
      maxTurns - Number(anchor?.isTurnStart ?? false),
    );
    const newerBytes = newerSelected.reduce(
      (size, row) => size + Buffer.byteLength(JSON.stringify(row)) + 1,
      0,
    );
    const query = from.orderBy("position", "desc").orderBy("id", "desc");
    const candidates = anchor
      ? await query
          .where(sql<boolean>`(position,id) <= (${anchor.position}::bigint,${anchor.id})`)
          .limit(limit - newerSelected.length + 1)
          .execute()
      : await query
          .$if(cursor !== undefined, (part) =>
            part.where(
              sql<boolean>`(position,id) < (${cursor!.beforePosition}::bigint,${cursor!.beforeId})`,
            ),
          )
          .limit(limit + 1)
          .execute();
    const rows = itemWindow(
      candidates,
      limit - newerSelected.length,
      maxBytes - newerBytes,
      maxTurns - newerSelected.filter((row) => row.isTurnStart).length,
    );
    const oldest = rows.at(-1);
    const hasMore = candidates.length > rows.length;
    const nextBefore: TranscriptCursor | null =
      hasMore && oldest?.position
        ? {
            deploymentId: state.deploymentId,
            epoch: state.epoch,
            viewerId: input.viewerId,
            threadId: thread.id,
            nodeId,
            orderRevision: revision,
            beforePosition: oldest.position,
            beforeId: oldest.id,
          }
        : null;
    return {
      kind: "page" as const,
      orderRevision: revision,
      revision: state.sequence,
      items: [...rows.reverse(), ...newerSelected].map(itemView),
      hasMore,
      nextBefore,
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
      body = await tx
        .selectFrom("messages")
        .select(["author", "content", "quote", "revision", "editedAt", "origin", "kind"])
        .where("id", "=", item.messageId)
        .where("threadId", "=", item.threadId)
        .executeTakeFirstOrThrow();
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
        .select([
          "tool",
          "integration",
          "arguments",
          "output",
          "status",
          "isError",
          "startedAt",
          "completedAt",
        ])
        .executeTakeFirstOrThrow();
      const { output, ...facts } = tool;
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
        ...facts,
        output: output ? { text: output.text, truncation: output.truncation, images } : null,
      };
    } else if (item.kind === "reasoning" || item.kind === "node-message" || item.kind === "place") {
      body = (
        await tx
          .selectFrom("transcriptItems")
          .select("body")
          .where("id", "=", item.id)
          .executeTakeFirstOrThrow()
      ).body;
    }
    const response = { kind: "item" as const, item: itemView(item), body, truncated: false };
    return Buffer.byteLength(JSON.stringify(response)) <= 1024 * 1024 ? response : tooLarge();
  });
}
