import {
  OpensteerError,
  type EventData,
  type ExecutionNodeId,
  type RunAttemptId,
  type RunId,
  type ThreadId,
} from "@opensteer/core";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import { commitPersonalMutation } from "./personal-mutation.js";
import { writeExecutionItem } from "./execution-changes.js";
import { transcriptPreview } from "./transcript-store.js";
import { itemView } from "./personal-sync-store.js";
import { executionNodeFromRow } from "./thread-row-mappers.js";
import { isOfflineSettlement } from "./personal-transaction.js";
import type { DatabaseSchema, ExecutionNodeTable } from "./schema.js";

export type ExecutionNodeRow = Selectable<ExecutionNodeTable>;

/**
 * Nodes rank just before attempts in ./lock-order.ts: every writer already
 * holds the Run, and writes them among its last locks.
 */

export async function startExecutionNode(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly attemptId: RunAttemptId;
    readonly node: EventData<"node.started">;
    readonly runId: RunId;
    readonly startedAt: Date;
  },
): Promise<void> {
  const { node } = input;
  if (node.parentNodeId) await requireRunNode(transaction, input.runId, node.parentNodeId);
  await transaction
    .insertInto("executionNodes")
    .values({
      attemptId: input.attemptId,
      stopSupported: node.stopSupported ?? false,
      endedAt: null,
      effort: node.effort ?? null,
      phaseIndex: node.phaseIndex ?? null,
      phases: sql`${JSON.stringify([])}::jsonb`,
      id: node.nodeId,
      kind: node.kind,
      model: node.model,
      nativeRef: node.nativeRef,
      originCallId: node.originCallId,
      parentNodeId: node.parentNodeId,
      prompt: node.prompt,
      result: null,
      runId: input.runId,
      sessionRef: node.sessionRef,
      startedAt: input.startedAt,
      status: "running",
      title: node.title,
    })
    .execute();
  await publishExecutionNode(transaction, node.nodeId);
}

export async function updateExecutionNode(
  transaction: Transaction<DatabaseSchema>,
  runId: RunId,
  update: EventData<"node.updated">,
): Promise<void> {
  await requireRunNode(transaction, runId, update.nodeId);
  if (update.stopping !== undefined)
    throw new OpensteerError({
      code: "conflict",
      message: "Runner event cannot say a subagent is stopping",
    });
  if (update.parentNodeId !== undefined) {
    await requireRunNode(transaction, runId, update.parentNodeId);
    const node = await transaction
      .selectFrom("executionNodes")
      .select("parentNodeId")
      .where("id", "=", update.nodeId)
      .executeTakeFirstOrThrow();
    const ancestors = await sql<{ id: ExecutionNodeId }>`
      with recursive ancestors as (
        select id, parent_node_id from execution_nodes where id = ${update.parentNodeId}
        union
        select node.id, node.parent_node_id from execution_nodes node
        join ancestors on node.id = ancestors.parent_node_id
      ) select id from ancestors where id = ${update.nodeId}
    `.execute(transaction);
    if (node.parentNodeId !== null || ancestors.rows.length > 0) {
      throw new OpensteerError({
        code: "conflict",
        message: "Runner event cannot change this subagent's parent",
      });
    }
  }
  await transaction
    .updateTable("executionNodes")
    .set({
      ...(update.effort === undefined ? {} : { effort: update.effort }),
      ...(update.stopSupported === undefined ? {} : { stopSupported: update.stopSupported }),
      ...(update.parentNodeId === undefined ? {} : { parentNodeId: update.parentNodeId }),
      ...(update.phaseIndex === undefined ? {} : { phaseIndex: update.phaseIndex }),
      ...(update.phases === undefined
        ? {}
        : { phases: sql`${JSON.stringify(update.phases)}::jsonb` }),
      ...(update.model === undefined ? {} : { model: update.model }),
      ...(update.originCallId === undefined ? {} : { originCallId: update.originCallId }),
      ...(update.prompt === undefined ? {} : { prompt: update.prompt }),
      ...(update.title === undefined ? {} : { title: update.title }),
    })
    .where("id", "=", update.nodeId)
    .execute();
  await publishExecutionNode(transaction, update.nodeId);
}

/** Records how a subagent ended, once; a repeat of a finished node changes nothing. */
export async function completeExecutionNode(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly completion: EventData<"node.completed">;
    readonly endedAt: Date;
    readonly runId: RunId;
  },
): Promise<void> {
  const { completion } = input;
  await requireRunNode(transaction, input.runId, completion.nodeId);
  const ended = await transaction
    .updateTable("executionNodes")
    .set({
      cacheWriteTokens: completion.usage?.cacheWriteTokens ?? null,
      cachedInputTokens: completion.usage?.cachedInputTokens ?? null,
      costUsd: completion.usage?.costUsd ?? null,
      endedAt: input.endedAt,
      inputTokens: completion.usage?.inputTokens ?? null,
      outputTokens: completion.usage?.outputTokens ?? null,
      reasoningTokens: completion.usage?.reasoningTokens ?? null,
      result: completion.result,
      status: completion.status,
    })
    .where("id", "=", completion.nodeId)
    .where("status", "=", "running")
    .executeTakeFirst();
  if (ended.numUpdatedRows > 0n) await publishExecutionNode(transaction, completion.nodeId);
}

/**
 * Ends the subagents still running when their attempt or Run ended without the
 * engine saying so: they were stopped with it.
 */
export async function endLiveExecutionNodes(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly attemptId?: RunAttemptId;
    readonly endedAt: Date;
    readonly runId: RunId;
    readonly ids?: readonly ExecutionNodeId[];
  },
): Promise<void> {
  if (input.ids?.length === 0) return;
  const live = await transaction
    .selectFrom("executionNodes")
    .select("id")
    .where("runId", "=", input.runId)
    .$if(input.attemptId !== undefined, (query) => query.where("attemptId", "=", input.attemptId!))
    .where("status", "=", "running")
    .$if(input.ids !== undefined, (query) => query.where("id", "in", [...input.ids!]))
    .orderBy("id", "asc")
    .forNoKeyUpdate()
    .execute();
  if (live.length === 0) return;
  await transaction
    .updateTable("executionNodes")
    .set({ endedAt: input.endedAt, status: "interrupted" })
    .where(
      "id",
      "in",
      live.map(({ id }) => id),
    )
    .execute();
  for (const { id } of live) await publishExecutionNode(transaction, id);
}

export async function publishExecutionNode(
  transaction: Transaction<DatabaseSchema>,
  id: ExecutionNodeId,
) {
  if (isOfflineSettlement(transaction)) return;
  await commitPersonalMutation(transaction, async (tx, mutation) => {
    const row = await tx
      .selectFrom("executionNodes")
      .innerJoin("runs", "runs.id", "executionNodes.runId")
      .select([
        "executionNodes.id",
        "executionNodes.status",
        "executionNodes.stopping",
        "executionNodes.title",
        "executionNodes.result",
        "executionNodes.startedAt",
        "executionNodes.parentNodeId",
        "executionNodes.runId",
        "executionNodes.attemptId",
        "runs.threadId",
      ])
      .where("executionNodes.id", "=", id)
      .executeTakeFirstOrThrow();
    mutation.react({
      type: "nodeProgressPlacement",
      runId: row.runId,
      attemptId: row.attemptId,
      nodeId: row.id,
      parentNodeId: row.parentNodeId,
      active: row.status === "running",
    });
    await writeExecutionItem(tx, mutation, {
      id: `node:${row.id}`,
      kind: "node",
      executionNodeId: row.id,
      threadId: row.threadId,
      runId: row.runId,
      attemptId: row.attemptId,
      nodeId: row.parentNodeId,
      createdAt: row.startedAt,
      visible: true,
      isTurnStart: false,
      // A settled subagent's row says what it found, as its card did on main.
      view: transcriptPreview({
        title: row.title,
        status: row.stopping && row.status === "running" ? "stopping" : row.status,
        ...(row.status !== "running" && row.result ? { preview: row.result } : {}),
      }),
    });
    // Runs after the card's own staged write, so the subject carries its new revision.
    mutation.stageTranscript(`node:${row.id}`, undefined, async () => {
      const subject = await nodeSubjectView(tx, row.threadId, row.id);
      if (subject)
        mutation.change(
          { scopeKey: `node:${row.id}`, entityKind: "node", entityId: row.id, operation: "upsert" },
          () => subject,
        );
    });
  });
}

/** A node scope's subject: the node's card with its full node view. */
export async function nodeSubjectView(
  tx: Transaction<DatabaseSchema>,
  threadId: ThreadId,
  nodeId: ExecutionNodeId,
) {
  const node = await tx
    .selectFrom("executionNodes as node")
    .innerJoin("runs as run", "run.id", "node.runId")
    .selectAll("node")
    .where("node.id", "=", nodeId)
    .where("run.threadId", "=", threadId)
    .executeTakeFirst();
  const card = await tx
    .selectFrom("transcriptItems")
    .selectAll()
    .where("id", "=", `node:${nodeId}`)
    .where("threadId", "=", threadId)
    .executeTakeFirst();
  if (!node || !card) return undefined;
  const subject = itemView(card);
  return subject.kind === "node" ? { ...subject, node: executionNodeFromRow(node) } : undefined;
}

/** A node the Runner names must be one this Run's engine reported. */
export async function requireRunNode(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  runId: RunId,
  nodeId: ExecutionNodeId,
  attemptId?: RunAttemptId,
): Promise<void> {
  const node = await database
    .selectFrom("executionNodes")
    .select("id")
    .where("id", "=", nodeId)
    .where("runId", "=", runId)
    .$if(attemptId !== undefined, (query) => query.where("attemptId", "=", attemptId!))
    .executeTakeFirst();
  if (!node) {
    throw new OpensteerError({
      code: "conflict",
      message: "Runner event names a subagent this Run never reported",
    });
  }
}

/** The Run's subagents in the order they started; the newest 200 of a Run with more. */
export async function listRunNodes(
  database: Kysely<DatabaseSchema>,
  runId: RunId,
): Promise<readonly ExecutionNodeRow[]> {
  const newest = await database
    .selectFrom("executionNodes")
    .selectAll()
    .where("runId", "=", runId)
    .orderBy("startedAt", "desc")
    .orderBy("id", "desc")
    .limit(200)
    .execute();
  return newest.reverse();
}
