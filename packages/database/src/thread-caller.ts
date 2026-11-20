import {
  OpensteerError,
  agentGrantAllowsTasks,
  minThreadAccessMode,
  threadAccessModeAtMost,
  type ThreadAccessMode,
  type UserId,
  type ThreadId,
  type RunId,
} from "@opensteer/core";
import type { Kysely, Transaction } from "kysely";
import {
  bindingLineageConnectionId,
  lineageEndedMessage,
  liveLineage,
  type AuthorityLineage,
} from "./resource-access.js";
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
/** The connection a caller works for, read from its immutable binding; null for owner work. */
export async function threadCallerLineageId(
  tx: Kysely<DatabaseSchema>,
  caller: ThreadCallerAuthority,
): Promise<string | null> {
  switch (caller.kind) {
    case "connection":
      return caller.connectionId;
    case "run":
      return bindingLineageConnectionId(tx, `run:${caller.scope.runId}`);
    case "trigger":
      return bindingLineageConnectionId(tx, `trigger:${caller.scope.occurrenceId}`);
    case "watch":
      return bindingLineageConnectionId(tx, `watch:${caller.scope.activationId}`);
  }
}
/**
 * Every admission in a connection's lineage holds that connection's row `FOR SHARE` before any
 * Run, so Disconnect (`FOR NO KEY UPDATE`) serializes against all of them.
 */
export async function lockLineageConnection(
  tx: Transaction<DatabaseSchema>,
  connectionId: string | null,
): Promise<void> {
  if (connectionId)
    await tx
      .selectFrom("agentConnections")
      .select("id")
      .where("id", "=", connectionId)
      .forShare()
      .executeTakeFirst();
}
export async function lockThreadCaller(
  tx: Transaction<DatabaseSchema>,
  caller: ThreadCallerAuthority | undefined,
  targetRunIds: readonly RunId[] = [],
  admitted = false,
): Promise<void> {
  if (!caller) return;
  await lockLineageConnection(tx, await threadCallerLineageId(tx, caller));
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
  const lineageId = await threadCallerLineageId(tx, caller);
  let lineage: AuthorityLineage | null = null;
  if (lineageId) {
    try {
      lineage = await liveLineage(tx, caller.userId, lineageId);
    } catch {
      throw forbidden(
        caller.kind === "connection"
          ? "The connected agent credential is invalid or expired."
          : lineageEndedMessage,
      );
    }
    if (caller.kind !== "connection" && !agentGrantAllowsTasks(lineage.grant))
      throw forbidden(lineageEndedMessage);
  }
  if (caller.kind === "connection") {
    accessMode = lineage!.accessMode;
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
  if (lineage && caller.kind !== "connection")
    accessMode = minThreadAccessMode(accessMode, lineage.accessMode);
  if (!threadAccessModeAtMost(caller.accessMode, accessMode))
    throw forbidden("Caller access mode was reduced");
  const thread = target?.threadId
    ? await tx
        .selectFrom("threads")
        .selectAll()
        .where("id", "=", target.threadId)
        .executeTakeFirstOrThrow()
    : null;
  // A selected connection only ever touches tasks in its own lineage.
  if (
    thread &&
    lineage?.grant.scope === "selected" &&
    thread.originConnectionId !== lineage.connectionId
  )
    throw forbidden("Task is unavailable");
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
