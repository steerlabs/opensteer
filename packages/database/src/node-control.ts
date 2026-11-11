import { z } from "zod";
import {
  EnvironmentIdSchema,
  ExecutionNodeIdSchema,
  GrantIdSchema,
  RunIdSchema,
  RunnerIdSchema,
  ThreadIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
  ThreadAccessModeSchema,
} from "@opensteer/core";
import { createId } from "@opensteer/core";
import { isDeepStrictEqual } from "node:util";
import { withDatabaseTransaction } from "./connection.js";
import { appendHostWorkspaceEvent } from "./workspace-events.js";
import {
  lockCommandIdempotency,
  findCommandByIdempotency,
  idempotencyConflict,
  principalIdForUser,
  jsonValue,
} from "./store-primitives.js";
import {
  OpensteerError,
  type AgentEventView,
  type ExecutionNodeId,
  type ExecutionNode,
  type RunId,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import { sql, type Kysely, type Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import {
  assertThreadCaller,
  lockThreadCaller,
  type ThreadCallerAuthority,
} from "./thread-caller.js";
import {
  lockWorkspaceRow,
  requireActiveWorkspaceMembership,
  threadExecutionIsAvailableToUser,
} from "./store-primitives.js";
import { runHasActiveGrant } from "./run-grants.js";

type Database = Kysely<DatabaseSchema> | Transaction<DatabaseSchema>;

export async function reachableNode(database: Database, nodeId: ExecutionNodeId, ownerId: UserId) {
  return database
    .selectFrom("executionNodes as node")
    .innerJoin("runs", "runs.id", "node.runId")
    .innerJoin("threads", "threads.id", "runs.threadId")
    .innerJoin(
      "workspaceMemberships as membership",
      "membership.workspaceId",
      "threads.workspaceId",
    )
    .selectAll("node")
    .select(["runs.threadId", "runs.requestedBy", "threads.workspaceId"])
    .where("node.id", "=", nodeId)
    .where("membership.userId", "=", ownerId)
    .where("membership.state", "=", "active")
    .executeTakeFirst();
}

export async function nodeControlsForOwner(
  database: Database,
  nodeIds: readonly ExecutionNodeId[],
  ownerId: UserId,
) {
  if (!nodeIds.length) return new Map<ExecutionNodeId, { canStop: boolean; stopping: boolean }>();
  const rows = await database
    .selectFrom("executionNodes as node")
    .innerJoin("runs", "runs.id", "node.runId")
    .innerJoin("runAttempts as attempt", "attempt.id", "node.attemptId")
    .innerJoin("threads", "threads.id", "runs.threadId")
    .innerJoin("workspaceMemberships as member", "member.workspaceId", "threads.workspaceId")
    .select([
      "node.id",
      sql<boolean>`node.status = 'running' and node.stop_supported
      and runs.status in ('running','waiting') and attempt.status = 'current' and attempt.ended_at is null
      and attempt.binding_generation = runs.binding_generation
      and (runs.requested_by = ${ownerId} or member.role = 'owner')
      and exists (select 1 from grants g where g.run_id = runs.id and g.status = 'active')
      and opensteer_user_can_execute_thread(threads.id, ${ownerId})`.as("canStop"),
      sql<boolean>`node.status = 'running' and exists (select 1 from commands c
        where c.type = 'node.stop' and c.run_id = node.run_id and c.payload->>'nodeId' = node.id
          and c.status in ('pending','dispatched','succeeded'))`.as("stopping"),
    ])
    .where("node.id", "in", nodeIds)
    .where("member.userId", "=", ownerId)
    .where("member.state", "=", "active")
    .execute();
  return new Map(
    rows.map(({ id, canStop, stopping }) => [id, { canStop: canStop && !stopping, stopping }]),
  );
}

export async function nodeControlEventsForOwner<T extends AgentEventView>(
  database: Database,
  events: readonly T[],
  ownerId: UserId,
): Promise<T[]> {
  const ids = events.flatMap((e) =>
    e.type === "node.started" || e.type === "node.updated" ? [e.data.nodeId] : [],
  );
  if (!ids.length) return [...events];
  const controls = await nodeControlsForOwner(database, ids, ownerId);
  return events.map((event) =>
    event.type === "node.started" || event.type === "node.updated"
      ? {
          ...event,
          data: {
            ...event.data,
            ...(controls.get(event.data.nodeId) ?? { canStop: false, stopping: false }),
          },
        }
      : event,
  );
}

export async function nodeViewsForOwner(
  database: Database,
  nodes: readonly ExecutionNode[],
  ownerId: UserId,
) {
  const controls = await nodeControlsForOwner(
    database,
    nodes.map((node) => node.id),
    ownerId,
  );
  return nodes.map((node) => ({
    ...node,
    ...(controls.get(node.id) ?? { canStop: false, stopping: false }),
  }));
}

export const NodeStopAuthoritySchema = z.object({
  kind: z.literal("run"),
  userId: UserIdSchema,
  accessMode: ThreadAccessModeSchema,
  reach: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("user") }),
    z.object({ kind: z.literal("workspace"), workspaceId: WorkspaceIdSchema }),
    z.object({ kind: z.literal("lineage"), lineageRootThreadId: ThreadIdSchema }),
  ]),
  scope: z.object({
    bindingGeneration: z.number().int().positive(),
    environmentId: EnvironmentIdSchema,
    grantId: GrantIdSchema.optional(),
    membershipGeneration: z.number().int().positive(),
    requestedBy: UserIdSchema,
    runId: RunIdSchema,
    runnerBootId: z.string().min(1).max(255),
    runnerId: RunnerIdSchema,
    threadId: ThreadIdSchema,
    workspaceId: WorkspaceIdSchema,
  }),
});

export interface NodeStopInput {
  readonly nodeId: ExecutionNodeId;
  readonly runId: RunId;
  readonly threadId: ThreadId;
  readonly requestedBy: UserId;
  readonly idempotencyKey: string;
  readonly authority?: ThreadCallerAuthority;
}

export async function assertNodeStop(
  transaction: Transaction<DatabaseSchema>,
  input: NodeStopInput,
  bindingGeneration?: number,
) {
  await lockThreadCaller(transaction, input.authority, [input.runId]);
  const run = await transaction
    .selectFrom("runs")
    .selectAll()
    .where("id", "=", input.runId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  const node = await reachableNode(transaction, input.nodeId, input.requestedBy);
  if (!node || !run || node.runId !== run.id || run.threadId !== input.threadId)
    throw new OpensteerError({ code: "not_found", message: "Subagent is unavailable" });
  await lockWorkspaceRow(transaction, node.workspaceId);
  const membership = await requireActiveWorkspaceMembership(
    transaction,
    node.workspaceId,
    input.requestedBy,
    true,
  );
  await assertThreadCaller(transaction, input.authority, { threadId: input.threadId });
  if (input.authority && (input.authority.kind !== "run" || input.authority.scope.runId !== run.id))
    throw new OpensteerError({
      code: "forbidden",
      message: "Only this Run's agent may stop its subagents",
    });
  if (run.requestedBy !== input.requestedBy && membership.role !== "owner")
    throw new OpensteerError({
      code: "forbidden",
      message: "Only a Workspace owner may stop another member's Run",
    });
  const attempt = await transaction
    .selectFrom("runAttempts")
    .selectAll()
    .where("id", "=", node.attemptId)
    .executeTakeFirstOrThrow();
  if (
    !["running", "waiting"].includes(run.status) ||
    node.status !== "running" ||
    attempt.status !== "current" ||
    attempt.endedAt !== null ||
    attempt.bindingGeneration !== run.bindingGeneration ||
    (bindingGeneration !== undefined && run.bindingGeneration !== bindingGeneration) ||
    !(await runHasActiveGrant(transaction, run.id)) ||
    !(await threadExecutionIsAvailableToUser(transaction, run.threadId, input.requestedBy))
  )
    throw new OpensteerError({
      code: "conflict",
      message: "Subagent is no longer running in the current attempt",
    });
  if (!node.stopSupported)
    throw new OpensteerError({
      code: "conflict",
      message: "This engine cannot stop this subagent separately",
    });
  return { node, run, bindingGeneration: Number(run.bindingGeneration) };
}

export async function enqueueNodeStop(database: Kysely<DatabaseSchema>, input: NodeStopInput) {
  return withDatabaseTransaction(database, async (tx) => {
    await lockCommandIdempotency(tx, input.requestedBy, input.idempotencyKey);
    const { node, run, bindingGeneration } = await assertNodeStop(tx, input);
    const payload = {
      type: "node.stop",
      nodeId: node.id,
      runId: run.id,
      threadId: run.threadId,
      bindingGeneration,
      ...(input.authority ? { authority: NodeStopAuthoritySchema.parse(input.authority) } : {}),
    };
    const existing = await findCommandByIdempotency(tx, input.requestedBy, input.idempotencyKey);
    if (existing) {
      if (existing.type !== "node.stop" || !isDeepStrictEqual(existing.payload, payload))
        throw idempotencyConflict(input.idempotencyKey);
      return { command: existing, events: [], wasDuplicate: true };
    }
    const principalId = await principalIdForUser(tx, input.requestedBy);
    const command = await tx
      .insertInto("commands")
      .values({
        id: createId("command"),
        type: "node.stop",
        idempotencyKey: input.idempotencyKey,
        requestedBy: input.requestedBy,
        actorPrincipalId: principalId,
        authoritySource: jsonValue(
          input.authority?.kind === "run"
            ? { kind: "run", runId: input.authority.scope.runId, userId: input.requestedBy }
            : { kind: "workspace-membership", userId: input.requestedBy },
        ),
        threadId: run.threadId,
        runId: run.id,
        environmentId: run.environmentId,
        payload: jsonValue(payload),
        status: "pending",
        dispatcherId: null,
        lastError: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const event = await appendHostWorkspaceEvent(tx, {
      type: "node.updated",
      data: { nodeId: node.id },
      runId: run.id,
      threadId: run.threadId,
      workspaceId: node.workspaceId,
      environmentId: run.environmentId,
    });
    return { command, events: [event], wasDuplicate: false };
  });
}

export async function failNodeStop(
  database: Kysely<DatabaseSchema>,
  commandId: import("@opensteer/core").CommandId,
  message: string,
) {
  return withDatabaseTransaction(database, async (tx) => {
    const command = await tx
      .selectFrom("commands")
      .selectAll()
      .where("id", "=", commandId)
      .executeTakeFirstOrThrow();
    if (command.type !== "node.stop" || !command.runId || command.status !== "dispatched")
      return [];
    await tx
      .selectFrom("runs")
      .select("id")
      .where("id", "=", command.runId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    const payload = z.object({ nodeId: ExecutionNodeIdSchema }).parse(command.payload);
    const node = await tx
      .selectFrom("executionNodes as node")
      .innerJoin("runs", "runs.id", "node.runId")
      .innerJoin("threads", "threads.id", "runs.threadId")
      .select(["node.id", "runs.environmentId", "runs.threadId", "threads.workspaceId"])
      .where("node.id", "=", payload.nodeId)
      .where("runs.id", "=", command.runId)
      .executeTakeFirstOrThrow();
    await lockWorkspaceRow(tx, node.workspaceId);
    const event = await appendHostWorkspaceEvent(tx, {
      type: "node.updated",
      data: { nodeId: node.id },
      runId: command.runId,
      environmentId: node.environmentId,
      threadId: node.threadId,
      workspaceId: node.workspaceId,
    });
    await tx
      .updateTable("commands")
      .set({
        status: "failed",
        lastError: jsonValue({
          code: "dispatch_failed",
          message: message.slice(0, 500),
          retryable: false,
        }),
        updatedAt: new Date(),
      })
      .where("id", "=", commandId)
      .execute();
    return [event];
  });
}

export async function dispatchNodeStop(
  database: Kysely<DatabaseSchema>,
  input: NodeStopInput,
  bindingGeneration: number,
  commandId: import("@opensteer/core").CommandId,
  send: (beforeAck: () => Promise<void>) => Promise<unknown>,
): Promise<void> {
  const accepted = Promise.withResolvers<void>();
  const committed = Promise.withResolvers<void>();
  void committed.promise.catch(() => undefined);
  let sending: Promise<unknown> | undefined;
  try {
    // A remote effect cannot be retried with a database transaction.
    await database.transaction().execute(async (tx) => {
      await assertNodeStop(tx, input, bindingGeneration);
      sending = send(async () => {
        accepted.resolve();
        await committed.promise;
      });
      void sending.catch(accepted.reject);
      await accepted.promise;
      await tx
        .updateTable("commands")
        .set({ status: "succeeded", lastError: null, updatedAt: new Date() })
        .where("id", "=", commandId)
        .where("status", "=", "dispatched")
        .execute();
    });
    committed.resolve();
    await sending?.catch(() => undefined);
  } catch (error) {
    committed.reject(error);
    await sending?.catch(() => undefined);
    throw error;
  }
}
