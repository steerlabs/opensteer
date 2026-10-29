import {
  OpensteerError,
  type EventData,
  type ExecutionNodeId,
  type RunAttemptId,
  type RunId,
} from "@opensteer/core";
import type { Kysely, Selectable, Transaction } from "kysely";
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
      endedAt: null,
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
}

export async function updateExecutionNode(
  transaction: Transaction<DatabaseSchema>,
  runId: RunId,
  update: EventData<"node.updated">,
): Promise<void> {
  await requireRunNode(transaction, runId, update.nodeId);
  await transaction
    .updateTable("executionNodes")
    .set({
      ...(update.model === undefined ? {} : { model: update.model }),
      ...(update.originCallId === undefined ? {} : { originCallId: update.originCallId }),
      ...(update.prompt === undefined ? {} : { prompt: update.prompt }),
      ...(update.title === undefined ? {} : { title: update.title }),
    })
    .where("id", "=", update.nodeId)
    .execute();
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
  await transaction
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
    .execute();
}

/**
 * Ends the subagents still running when their attempt or Run ended without the
 * engine saying so: they were stopped with it.
 */
export async function endLiveExecutionNodes(
  transaction: Transaction<DatabaseSchema>,
  input: { readonly attemptId?: RunAttemptId; readonly endedAt: Date; readonly runId: RunId },
): Promise<void> {
  const live = await transaction
    .selectFrom("executionNodes")
    .select("id")
    .where("runId", "=", input.runId)
    .$if(input.attemptId !== undefined, (query) => query.where("attemptId", "=", input.attemptId!))
    .where("status", "=", "running")
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
}

/** A node the Runner names must be one this Run's engine reported. */
export async function requireRunNode(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  runId: RunId,
  nodeId: ExecutionNodeId,
): Promise<void> {
  const node = await database
    .selectFrom("executionNodes")
    .select("id")
    .where("id", "=", nodeId)
    .where("runId", "=", runId)
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
