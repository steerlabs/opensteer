import {
  OpensteerError,
  agentGrantAllowsTasks,
  minThreadAccessMode,
  nonTerminalRunStatuses,
  threadAccessModeAtMost,
  type ThreadAccessMode,
  type UserId,
  type ThreadId,
  type RunId,
} from "@opensteer/core";
import type { Kysely, Transaction } from "kysely";
import {
  bindingAgentConnectionId,
  lineageEndedMessage,
  liveAgentConnection,
  tasksWithdrawnMessage,
  type AgentConnectionAuthority,
} from "./resource-access.js";
import { admitBridgeSender } from "./bridge-admission.js";
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
      /**
       * A chat's message: who wrote it and the bridge's revision it was admitted under. Every
       * task tool it reaches asks again whether this sender may speak, at the moment it acts.
       */
      readonly chat?: { readonly externalUserId: string; readonly revision: number };
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
      return bindingAgentConnectionId(tx, `run:${caller.scope.runId}`);
    case "trigger":
      return bindingAgentConnectionId(tx, `trigger:${caller.scope.occurrenceId}`);
    case "watch":
      return bindingAgentConnectionId(tx, `watch:${caller.scope.activationId}`);
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
  /** Also lock this task's active Runs, in the same ordered statement as the caller's. */
  activeRunsOf?: ThreadId,
): Promise<void> {
  if (!caller) return;
  await lockLineageConnection(tx, await threadCallerLineageId(tx, caller));
  const ids = [
    ...new Set([...targetRunIds, ...(caller.kind === "run" ? [caller.scope.runId] : [])]),
  ].sort();
  if (activeRunsOf)
    await tx
      .selectFrom("runs")
      .select("id")
      .where((eb) =>
        eb.or([
          ...(ids.length ? [eb("id", "in", ids)] : []),
          eb.and([eb("threadId", "=", activeRunsOf), eb("status", "in", nonTerminalRunStatuses)]),
        ]),
      )
      .orderBy("id")
      .forNoKeyUpdate()
      .execute();
  else if (ids.length)
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
/**
 * Task tools, rechecked under the caller's locks: the execution is live, and the target task is
 * one this caller may touch at the mode the caller now has. Work for a connection may change only
 * its own lineage's tasks, or, with an `everything` grant, the person's own; a `selected` grant
 * also reads only its own.
 */
export async function assertThreadCaller(
  tx: Transaction<DatabaseSchema>,
  caller: ThreadCallerAuthority | undefined,
  target?: {
    readonly activate?: boolean;
    readonly enqueue?: boolean;
    readonly readOnly?: boolean;
    readonly threadId?: ThreadId;
    readonly accessMode?: ThreadAccessMode;
    readonly admitted?: boolean;
  },
): Promise<void> {
  if (!caller) return;
  await requirePersonalOwner(tx, caller.userId);
  let sourceId: ThreadId | undefined;
  const lineageId = await threadCallerLineageId(tx, caller);
  let lineage: AgentConnectionAuthority | null = null;
  if (lineageId) {
    try {
      lineage = await liveAgentConnection(tx, caller.userId, lineageId);
    } catch {
      throw forbidden(
        caller.kind === "connection"
          ? "The connected agent credential is invalid or expired."
          : lineageEndedMessage,
      );
    }
    if (!agentGrantAllowsTasks(lineage.grant)) throw forbidden(tasksWithdrawnMessage);
    if (
      caller.kind === "connection" &&
      caller.chat &&
      (
        await admitBridgeSender(tx, {
          ownerUserId: caller.userId,
          bridgeId: caller.connectionId,
          externalUserId: caller.chat.externalUserId,
          expectedRevision: caller.chat.revision,
        })
      ).kind !== "admitted"
    )
      throw forbidden("This chat may no longer ask your agents to work.");
  }
  let runMode: ThreadAccessMode | null = null;
  if (caller.kind === "run") {
    if (!target?.admitted) await assertActiveGrant(tx, caller.scope);
    else if (!(await admitThreadExecution(tx, caller.scope.threadId, caller.userId)))
      throw forbidden("Run tool authority has ended");
    sourceId = caller.scope.threadId;
    if (lineage)
      runMode =
        (
          await tx
            .selectFrom("runs")
            .select("accessMode")
            .where("id", "=", caller.scope.runId)
            .executeTakeFirst()
        )?.accessMode ?? null;
  } else if (caller.kind === "trigger") {
    await assertActiveTriggerExecutionBinding(tx, caller.scope);
    sourceId = caller.scope.threadId;
  } else if (caller.kind === "watch") {
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
  // The person's own work keeps its task's mode; lineaged work takes every mode in its lineage.
  const accessMode = lineage
    ? minThreadAccessMode(lineage.accessMode, source?.accessMode, runMode)
    : (source?.accessMode ?? caller.accessMode);
  if (!threadAccessModeAtMost(caller.accessMode, accessMode))
    throw forbidden("Caller access mode was reduced");
  const thread = target?.threadId
    ? await tx
        .selectFrom("threads")
        .selectAll()
        .where("id", "=", target.threadId)
        .executeTakeFirstOrThrow()
    : null;
  if (thread && lineage) {
    const own = thread.originConnectionId === lineage.agentConnectionId;
    const persons = thread.originConnectionId === null && lineage.grant.scope === "everything";
    if (lineage.grant.scope === "selected" ? !own : !target?.readOnly && !own && !persons)
      throw forbidden("Task is unavailable");
  }
  // A task in this caller's lineage runs at most at the connection's mode, whatever its own says.
  const targetMode =
    thread && lineage && target?.enqueue
      ? minThreadAccessMode(thread.accessMode, accessMode)
      : thread && lineage && thread.originConnectionId === lineage.agentConnectionId
        ? minThreadAccessMode(thread.accessMode, lineage.accessMode)
        : (thread?.accessMode ?? target?.accessMode ?? accessMode);
  if (!target?.readOnly && !threadAccessModeAtMost(targetMode, accessMode))
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
