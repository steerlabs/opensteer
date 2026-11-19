import { commitPersonalMutation, wakeExecutionCommands } from "./personal-mutation.js";
import { requirePersonalOwner } from "./personal-settings-store.js";
import { z } from "zod";
import {
  EnvironmentIdSchema,
  ExecutionNodeIdSchema,
  GrantIdSchema,
  RunIdSchema,
  RunnerIdSchema,
  ThreadIdSchema,
  UserIdSchema,
  ThreadAccessModeSchema,
} from "@opensteer/core";
import { createId } from "@opensteer/core";
import "./connection.js";
import { publishExecutionNode } from "./execution-nodes.js";
import {
  lockCommandIdempotency,
  findCommandByIdempotency,
  idempotencyConflict,
  principalIdForUser,
  jsonValue,
} from "./store-primitives.js";
import {
  OpensteerError,
  type ExecutionNodeId,
  type RunId,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import type { Kysely, Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import {
  assertThreadCaller,
  lockThreadCaller,
  type ThreadCallerAuthority,
} from "./thread-caller.js";
import "./store-primitives.js";
import { runHasActiveGrant } from "./run-grants.js";
type Database = Kysely<DatabaseSchema> | Transaction<DatabaseSchema>;
export async function reachableNode(database: Database, nodeId: ExecutionNodeId, ownerId: UserId) {
  await requirePersonalOwner(database, ownerId);
  return database
    .selectFrom("executionNodes as node")
    .innerJoin("runs", "runs.id", "node.runId")
    .innerJoin("threads", "threads.id", "runs.threadId")
    .selectAll("node")
    .select(["runs.threadId", "runs.requestedBy"])
    .where("node.id", "=", nodeId)
    .executeTakeFirst();
}
export const NodeStopAuthoritySchema = z.object({
  kind: z.literal("run"),
  userId: UserIdSchema,
  accessMode: ThreadAccessModeSchema,
  scope: z.object({
    bindingGeneration: z.number().int().positive(),
    environmentId: EnvironmentIdSchema,
    grantId: GrantIdSchema.optional(),
    requestedBy: UserIdSchema,
    runId: RunIdSchema,
    runnerBootId: z.string().min(1).max(255),
    runnerId: RunnerIdSchema,
    threadId: ThreadIdSchema,
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
    throw new OpensteerError({
      code: "not_found",
      message: "Subagent is unavailable",
    });
  await requirePersonalOwner(transaction, input.requestedBy);
  await assertThreadCaller(transaction, input.authority, {
    threadId: input.threadId,
  });
  if (input.authority && (input.authority.kind !== "run" || input.authority.scope.runId !== run.id))
    throw new OpensteerError({
      code: "forbidden",
      message: "Only this Run's agent may stop its subagents",
    });
  const attempt = await transaction
    .selectFrom("runAttempts")
    .selectAll()
    .where("id", "=", node.attemptId)
    .executeTakeFirstOrThrow();
  if (
    !["running", "waiting"].includes(run.status) ||
    run.finishIntent !== null ||
    node.status !== "running" ||
    attempt.status !== "current" ||
    attempt.endedAt !== null ||
    attempt.bindingGeneration !== run.bindingGeneration ||
    (bindingGeneration !== undefined && run.bindingGeneration !== bindingGeneration) ||
    !(await runHasActiveGrant(transaction, run.id))
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
  return {
    node,
    run,
    bindingGeneration: Number(run.bindingGeneration),
  };
}
export async function enqueueNodeStop(database: Kysely<DatabaseSchema>, input: NodeStopInput) {
  return commitPersonalMutation(database, async (tx) => {
    await lockCommandIdempotency(tx, input.requestedBy, input.idempotencyKey);
    await lockThreadCaller(tx, input.authority, [input.runId]);
    // A replay answers as it first did, even once the subagent has ended.
    const existing = await findCommandByIdempotency(tx, input.requestedBy, input.idempotencyKey);
    if (existing) {
      const sent = z
        .object({
          nodeId: ExecutionNodeIdSchema,
          runId: RunIdSchema,
          threadId: ThreadIdSchema,
        })
        .safeParse(existing.payload);
      if (
        existing.type !== "node.stop" ||
        !sent.success ||
        sent.data.nodeId !== input.nodeId ||
        sent.data.runId !== input.runId ||
        sent.data.threadId !== input.threadId
      )
        throw idempotencyConflict(input.idempotencyKey);
      if (!(await reachableNode(tx, input.nodeId, input.requestedBy)))
        throw new OpensteerError({
          code: "not_found",
          message: "Subagent is unavailable",
        });
      return {
        command: existing,
        wasDuplicate: true,
      };
    }
    const { node, run, bindingGeneration } = await assertNodeStop(tx, input);
    const payload = {
      type: "node.stop",
      nodeId: node.id,
      runId: run.id,
      threadId: run.threadId,
      bindingGeneration,
      ...(input.authority
        ? {
            authority: NodeStopAuthoritySchema.parse(input.authority),
          }
        : {}),
    };
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
            ? {
                kind: "run",
                runId: input.authority.scope.runId,
                userId: input.requestedBy,
              }
            : {
                kind: "user-session",
                userId: input.requestedBy,
              },
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
    await wakeExecutionCommands(tx);
    await tx
      .updateTable("executionNodes")
      .set({
        stopping: true,
      })
      .where("id", "=", node.id)
      .execute();
    await publishExecutionNode(tx, node.id);
    return {
      command,
      wasDuplicate: false,
    };
  });
}
export async function failNodeStop(
  database: Kysely<DatabaseSchema>,
  commandId: import("@opensteer/core").CommandId,
  message: string,
) {
  return commitPersonalMutation(database, async (tx) => {
    const command = await tx
      .selectFrom("commands")
      .selectAll()
      .where("id", "=", commandId)
      .executeTakeFirstOrThrow();
    if (command.type !== "node.stop" || !command.runId || command.status !== "dispatched") return;
    await tx
      .selectFrom("runs")
      .select("id")
      .where("id", "=", command.runId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    const payload = z
      .object({
        nodeId: ExecutionNodeIdSchema,
      })
      .parse(command.payload);
    const node = await tx
      .selectFrom("executionNodes as node")
      .innerJoin("runs", "runs.id", "node.runId")
      .innerJoin("threads", "threads.id", "runs.threadId")
      .select(["node.id", "runs.environmentId", "runs.threadId"])
      .where("node.id", "=", payload.nodeId)
      .where("runs.id", "=", command.runId)
      .executeTakeFirstOrThrow();
    await tx
      .updateTable("executionNodes")
      .set({
        stopping: false,
      })
      .where("id", "=", node.id)
      .execute();
    await publishExecutionNode(tx, node.id);
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
    return;
  });
}
export async function dispatchNodeStop(
  database: Kysely<DatabaseSchema>,
  input: NodeStopInput,
  bindingGeneration: number,
  commandId: import("@opensteer/core").CommandId,
  send: (beforeAck: () => Promise<void>) => Promise<unknown>,
): Promise<void> {
  await commitPersonalMutation(database, async (tx) => {
    await assertNodeStop(tx, input, bindingGeneration);
    const intent = await tx
      .updateTable("commands")
      .set({ updatedAt: new Date() })
      .where("id", "=", commandId)
      .where("status", "=", "dispatched")
      .executeTakeFirst();
    if (!intent.numUpdatedRows)
      throw new OpensteerError({ code: "conflict", message: "Subagent stop was retired" });
  });
  await send(async () => {
    await commitPersonalMutation(database, async (tx) => {
      await tx
        .updateTable("commands")
        .set({ status: "succeeded", lastError: null, updatedAt: new Date() })
        .where("id", "=", commandId)
        .where("status", "=", "dispatched")
        .execute();
    });
  });
}
