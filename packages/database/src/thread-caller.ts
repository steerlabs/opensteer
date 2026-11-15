import {
  OpensteerError,
  threadAccessModeAtMost,
  type ThreadAccessMode,
  type UserId,
  type ThreadId,
  type RunId,
} from "@opensteer/core";
import type { Kysely, Transaction } from "kysely";
import { lockCommandIdempotency } from "./store-primitives.js";
import { requirePersonalOwner } from "./personal-settings-store.js";
import { withPersonalTransaction } from "./personal-transaction.js";
import type { DatabaseSchema } from "./schema.js";
import { assertActiveGrant, admitThreadExecution } from "./execution-authority.js";
import {
  assertActiveTriggerExecutionBinding,
  assertActiveWatchBinding,
  type ActiveTriggerExecutionBindingInput,
  type ActiveWatchBindingInput,
} from "./trigger-store.js";
export type ThreadCallerAuthority = {
  readonly userId: UserId;
  readonly accessMode: ThreadAccessMode;
} & (
  | {
      readonly kind: "run";
      readonly scope: Parameters<typeof assertActiveGrant>[1];
    }
  | {
      readonly kind: "trigger";
      readonly scope: ActiveTriggerExecutionBindingInput;
    }
  | {
      readonly kind: "watch";
      readonly scope: ActiveWatchBindingInput;
    }
  | {
      readonly kind: "connection";
      readonly connectionId: string;
    }
);
export async function lockThreadCaller(
  tx: Transaction<DatabaseSchema>,
  caller: ThreadCallerAuthority | undefined,
  targetRunIds: readonly RunId[] = [],
  admitted = false,
): Promise<void> {
  if (!caller) return;
  if (caller.kind === "connection")
    await tx
      .selectFrom("agentConnections")
      .select("id")
      .where("id", "=", caller.connectionId)
      .forShare()
      .executeTakeFirst();
  const ids = [
    ...new Set([...targetRunIds, ...(caller.kind === "run" ? [caller.scope.runId] : [])]),
  ].sort();
  if (ids.length)
    await tx
      .selectFrom("runs")
      .select("id")
      .where("id", "in", ids)
      .orderBy("id")
      .forNoKeyUpdate()
      .execute();
  await assertThreadCaller(tx, caller, {
    admitted,
  });
}
export async function assertThreadCaller(
  tx: Transaction<DatabaseSchema>,
  caller: ThreadCallerAuthority | undefined,
  target?: {
    readonly activate?: boolean;
    readonly readOnly?: boolean;
    readonly threadId?: ThreadId;
    readonly accessMode?: ThreadAccessMode;
    readonly admitted?: boolean;
  },
): Promise<void> {
  if (!caller) return;
  await requirePersonalOwner(tx, caller.userId);
  let accessMode = caller.accessMode;
  let sourceId: ThreadId | undefined;
  if (caller.kind === "connection") {
    const connection = await tx
      .selectFrom("agentConnections")
      .selectAll()
      .where("id", "=", caller.connectionId)
      .where("userId", "=", caller.userId)
      .where("revokedAt", "is", null)
      .where("expiresAt", ">", new Date())
      .executeTakeFirst();
    if (!connection?.tokenHash)
      throw forbidden("The connected agent credential is invalid or expired.");
    accessMode = connection.accessMode;
  } else if (caller.kind === "run") {
    if (!target?.admitted) await assertActiveGrant(tx, caller.scope);
    else if (!(await admitThreadExecution(tx, caller.scope.threadId, caller.userId)))
      throw forbidden("Run tool authority has ended");
    sourceId = caller.scope.threadId;
  } else if (caller.kind === "trigger") {
    await assertActiveTriggerExecutionBinding(tx, caller.scope);
    sourceId = caller.scope.threadId;
  } else {
    await assertActiveWatchBinding(tx, caller.scope);
    sourceId = caller.scope.anchorThreadId;
  }
  const source = sourceId
    ? await tx
        .selectFrom("threads")
        .selectAll()
        .where("id", "=", sourceId)
        .executeTakeFirstOrThrow()
    : null;
  accessMode = source?.accessMode ?? accessMode;
  if (!threadAccessModeAtMost(caller.accessMode, accessMode))
    throw forbidden("Caller access mode was reduced");
  const thread = target?.threadId
    ? await tx
        .selectFrom("threads")
        .selectAll()
        .where("id", "=", target.threadId)
        .executeTakeFirstOrThrow()
    : null;
  if (target?.activate && thread?.specialistId) {
    const specialist = await tx
      .selectFrom("specialists")
      .select("id")
      .where("id", "=", thread.specialistId)
      .where("ownerUserId", "=", caller.userId)
      .where("status", "=", "ready")
      .where("removedAt", "is", null)
      .executeTakeFirst();
    if (!specialist || (source?.specialistId && source.specialistId !== thread.specialistId))
      throw forbidden("Specialist registration is unavailable");
  }
  if (
    !target?.readOnly &&
    !threadAccessModeAtMost(
      thread?.accessMode ?? target?.accessMode ?? caller.accessMode,
      caller.accessMode,
    )
  )
    throw forbidden("Target task has a stronger access mode than this caller");
}
function forbidden(message: string) {
  return new OpensteerError({
    code: "forbidden",
    message,
  });
}
export function withThreadCallerTransaction<
  Result extends {
    readonly thread: {
      readonly id: ThreadId;
    };
  },
>(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly authority?: ThreadCallerAuthority;
    readonly idempotencyKey: string;
  } & (
    | {
        readonly requestedBy: UserId;
      }
    | {
        readonly createdBy: UserId;
      }
  ),
  operation: (tx: Transaction<DatabaseSchema>) => Promise<Result>,
): Promise<Result> {
  return withPersonalTransaction(database, async (tx) => {
    const userId = "requestedBy" in input ? input.requestedBy : input.createdBy;
    await requirePersonalOwner(tx, userId);
    await lockCommandIdempotency(tx, userId, input.idempotencyKey);
    await lockThreadCaller(tx, input.authority);
    const result = await operation(tx);
    await assertThreadCaller(tx, input.authority, {
      threadId: result.thread.id,
    });
    return result;
  });
}
