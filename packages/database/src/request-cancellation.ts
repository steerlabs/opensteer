import { lockRequestWorkspaces } from "./request-workspace-locks.js";
import {
  type AgentEvent,
  type Request,
  type RequestCancellationReason,
  type RequestId,
  type RunId,
  type ThreadId,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import type { Transaction } from "kysely";
import { assignmentActivityEventsForRun } from "./assignment-store.js";
import { requestFromRow, requestOriginEnvironment } from "./request-persistence.js";
import type { DatabaseSchema } from "./schema.js";
import { jsonValue } from "./store-primitives.js";
import { appendHostWorkspaceEvent } from "./workspace-events.js";

export { withRequestWorkspaceLocks } from "./request-workspace-locks.js";

export async function cancelPending(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly reason: RequestCancellationReason;
    readonly resolvedAt: Date;
    readonly runId?: RunId;
    readonly originatingThreadId?: ThreadId;
    readonly requestIds?: readonly RequestId[];
    readonly requestedBy?: UserId;
    readonly workspaceId?: WorkspaceId;
  },
): Promise<readonly AgentEvent[]> {
  let pending = transaction.selectFrom("requests").selectAll().where("status", "=", "pending");
  if (input.requestIds) {
    if (input.requestIds.length === 0) return [];
    pending = pending.where("id", "in", [...input.requestIds]);
  }
  if (input.runId)
    pending = pending.where("originatingRunId", "=", input.runId).where("mode", "=", "live");
  if (input.originatingThreadId) {
    pending = pending.where("originatingThreadId", "=", input.originatingThreadId);
  }
  if (input.workspaceId) {
    pending = pending.where((expression) =>
      expression.or([
        expression("originatingWorkspaceId", "=", input.workspaceId!),
        expression("targetWorkspaceId", "=", input.workspaceId!),
      ]),
    );
  }
  if (input.requestedBy) pending = pending.where("requestedBy", "=", input.requestedBy);
  await lockRequestWorkspaces(
    transaction,
    (await pending.execute()).map((row) => row.originatingWorkspaceId),
  );
  const locked = await pending.orderBy("id", "asc").forNoKeyUpdate().execute();
  if (locked.length === 0) return [];
  const responseCommandIds = locked
    .map(({ responseCommandId }) => responseCommandId)
    .filter((id): id is NonNullable<typeof id> => id !== null);
  if (responseCommandIds.length > 0) {
    await transaction
      .updateTable("commands")
      .set({
        lastError: jsonValue({
          message: "The Request was cancelled before its response completed",
        }),
        status: "failed",
        updatedAt: input.resolvedAt,
      })
      .where("id", "in", responseCommandIds)
      .where("type", "=", "request.respond")
      .where("status", "in", ["pending", "dispatched", "unknown"])
      .execute();
  }
  const rows = await transaction
    .updateTable("requests")
    .set({
      cancellationReason: input.reason,
      resolvedAt: input.resolvedAt,
      resolvedBy: null,
      responseCommandId: null,
      status: "cancelled",
    })
    .where(
      "id",
      "in",
      locked.map(({ id }) => id),
    )
    .where("status", "=", "pending")
    .returningAll()
    .execute();
  const events = await Promise.all(
    rows.map((row) => cancellationEvent(transaction, requestFromRow(row))),
  );
  const runIds = new Set(
    rows.map((row) => row.originatingRunId).filter((id): id is RunId => id !== null),
  );
  for (const runId of runIds) {
    events.push(...(await assignmentActivityEventsForRun(transaction, runId)));
  }
  return events;
}

async function cancellationEvent(
  transaction: Transaction<DatabaseSchema>,
  request: Request,
): Promise<AgentEvent> {
  if (request.status !== "cancelled") throw new Error("Cancellation event requires cancellation");
  return appendHostWorkspaceEvent(transaction, {
    data: { reason: request.cancellationReason, requestId: request.id },
    environmentId: await requestOriginEnvironment(transaction, request),
    runId: request.originatingRunId,
    threadId: request.originatingThreadId,
    type: "request.cancelled",
    workspaceId: request.originatingWorkspaceId,
  });
}
