import {
  type RequestCancellationReason,
  type RequestId,
  type RunId,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import { isOfflineSettlement } from "./personal-transaction.js";
import type { Transaction } from "kysely";
import { lockRequestThreads, refreshRequestState } from "./request-persistence.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import type { DatabaseSchema } from "./schema.js";
import { jsonValue } from "./store-primitives.js";
interface Cancellation {
  readonly reason: RequestCancellationReason;
  readonly resolvedAt: Date;
  readonly runId?: RunId;
  readonly cancelHandedOffPlugins?: boolean;
  readonly originatingThreadId?: ThreadId;
  readonly requestIds?: readonly RequestId[];
  readonly requestedBy?: UserId;
}

export function cancelPending(
  transaction: Transaction<DatabaseSchema>,
  input: Cancellation,
): Promise<readonly RequestId[]> {
  if (isOfflineSettlement(transaction)) return cancelInTransaction(transaction, input, false);
  return commitPersonalMutation(transaction, (tx) => cancelInTransaction(tx, input, true));
}

async function cancelInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: Cancellation,
  refresh: boolean,
): Promise<readonly RequestId[]> {
  let pending = transaction.selectFrom("requests").selectAll().where("status", "=", "pending");
  if (input.requestIds) {
    if (input.requestIds.length === 0) return [];
    pending = pending.where("id", "in", [...input.requestIds]);
  }
  if (input.runId)
    pending = pending
      .where("originatingRunId", "=", input.runId)
      .where((eb) =>
        eb.or([
          eb("mode", "=", "live"),
          eb.and([
            eb("kind", "in", ["plugin.approval", "plugin.input"]),
            input.cancelHandedOffPlugins
              ? eb.val(true)
              : eb.not(
                  eb.exists(
                    eb
                      .selectFrom("pluginExecutions")
                      .select("id")
                      .whereRef("pluginExecutions.requestId", "=", "requests.id")
                      .where("handoff", "=", true),
                  ),
                ),
          ]),
        ]),
      );
  if (input.originatingThreadId) {
    pending = pending.where("originatingThreadId", "=", input.originatingThreadId);
  }
  if (input.requestedBy) pending = pending.where("requestedBy", "=", input.requestedBy);
  if (refresh) {
    const parents = await pending.clearSelect().select("originatingThreadId").distinct().execute();
    await lockRequestThreads(
      transaction,
      parents.map(({ originatingThreadId }) => originatingThreadId),
    );
  }
  const locked = await pending.orderBy("id", "asc").forNoKeyUpdate().execute();
  if (locked.length === 0) return [];
  const responseCommandIds = locked
    .map(({ responseCommandId }) => responseCommandId)
    .filter((id): id is NonNullable<typeof id> => id !== null);
  if (responseCommandIds.length > 0) {
    await transaction
      .selectFrom("commands")
      .select("id")
      .where("id", "in", responseCommandIds)
      .orderBy("id")
      .forNoKeyUpdate()
      .execute();
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
  if (
    ["resource-deleted", "authority-revoked", "plugin-interrupted", "plugin-expired"].includes(
      input.reason,
    )
  ) {
    for (const row of rows) {
      if (row.mode !== "durable") continue;
      await transaction
        .insertInto("requestContinuations")
        .values({
          requestId: row.id,
          status: "waiting",
          reason: null,
          attemptedAt: null,
          createdAt: input.resolvedAt,
          updatedAt: input.resolvedAt,
        })
        .onConflict((conflict) => conflict.column("requestId").doNothing())
        .execute();
    }
  }
  const ids = rows.map((row) => row.id).sort();
  if (refresh) for (const id of ids) await refreshRequestState(transaction, id);
  return ids;
}
