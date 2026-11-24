import {
  type RequestCancellationReason,
  type RequestId,
  type RunId,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import { isOfflineSettlement } from "./personal-transaction.js";
import { sql, type Transaction } from "kysely";
import { lockRequestThreads, refreshRequestState } from "./request-persistence.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import type { DatabaseSchema } from "./schema.js";
import { jsonValue } from "./store-primitives.js";
interface Cancellation {
  readonly reason: RequestCancellationReason;
  readonly resolvedAt: Date;
  readonly runId?: RunId;
  readonly cancelHandedOffPlugins?: boolean;
  /** A Run stopped: the commands it proposed close too, as nothing it asked may run after. */
  readonly cancelProposals?: boolean;
  readonly originatingThreadId?: ThreadId;
  readonly requestIds?: readonly RequestId[];
  readonly requestedBy?: UserId;
  readonly expireAgentOperation?: boolean;
}

export function cancelPending(
  transaction: Transaction<DatabaseSchema>,
  input: Cancellation,
): Promise<readonly RequestId[]> {
  if (input.requestIds?.length === 0) return Promise.resolve([]);
  const cancel = async (tx: Transaction<DatabaseSchema>) => {
    const prepared = await preparePendingCancellation(tx, input);
    await prepared.lockThreads();
    return prepared.apply();
  };
  if (isOfflineSettlement(transaction)) return cancel(transaction);
  return commitPersonalMutation(transaction, cancel);
}

function pendingCancellationQuery(transaction: Transaction<DatabaseSchema>, input: Cancellation) {
  let pending = transaction.selectFrom("requests").selectAll().where("status", "=", "pending");
  if (input.requestIds) {
    pending = pending.where("id", "in", [...input.requestIds]);
  }
  if (input.runId)
    pending = pending
      .where("originatingRunId", "=", input.runId)
      .where((eb) =>
        eb.or([
          eb("mode", "=", "live"),
          input.cancelProposals ? eb("command", "is not", null) : eb.val(false),
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
  return pending;
}

export async function preparePendingCancellation(
  transaction: Transaction<DatabaseSchema>,
  input: Cancellation,
) {
  const pending = pendingCancellationQuery(transaction, input);
  const refresh = !isOfflineSettlement(transaction);
  if (
    ["resource-deleted", "authority-revoked", "plugin-interrupted", "plugin-expired"].includes(
      input.reason,
    )
  ) {
    const durable = await pending
      .clearSelect()
      .select("id")
      .where("mode", "=", "durable")
      .where("originatingAgentSessionId", "is", null)
      .orderBy("id", "asc")
      .execute();
    for (const row of durable) {
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
  const lockThreads = async () => {
    if (!refresh) return;
    const parents = await pending.clearSelect().select("originatingThreadId").distinct().execute();
    await lockRequestThreads(
      transaction,
      parents.map(({ originatingThreadId }) => originatingThreadId),
    );
  };
  return {
    lockThreads,
    apply: () => cancelInTransaction(transaction, input, pending, refresh),
  };
}

async function cancelInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: Cancellation,
  pending: ReturnType<typeof pendingCancellationQuery>,
  refresh: boolean,
): Promise<readonly RequestId[]> {
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
      ...(input.expireAgentOperation
        ? { agentOperation: sql`agent_operation || '{"expired": true}'::jsonb` }
        : {}),
    })
    .where(
      "id",
      "in",
      locked.map(({ id }) => id),
    )
    .where("status", "=", "pending")
    .returningAll()
    .execute();
  const ids = rows.map((row) => row.id).sort();
  if (refresh) for (const id of ids) await refreshRequestState(transaction, id);
  return ids;
}
