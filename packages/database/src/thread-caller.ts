import {
  OpensteerError,
  threadAccessModeAtMost,
  threadReachScope,
  type ThreadAccessMode,
  type ThreadReachScope,
  type UserId,
  type ThreadId,
  type RunId,
} from "@opensteer/core";
import type { Kysely, Transaction } from "kysely";
import { withDatabaseTransaction } from "./connection.js";
import { lockCommandIdempotency } from "./store-primitives.js";
import type { DatabaseSchema } from "./schema.js";
import { assertActiveGrant } from "./execution-authority.js";
import {
  assertActiveTriggerExecutionBinding,
  assertActiveWatchBinding,
  type ActiveTriggerExecutionBindingInput,
  type ActiveWatchBindingInput,
} from "./trigger-store.js";
export type ThreadCallerAuthority = {
  readonly userId: UserId;
  readonly accessMode: ThreadAccessMode;
  readonly reach: ThreadReachScope;
} & (
  | { readonly kind: "run"; readonly scope: Parameters<typeof assertActiveGrant>[1] }
  | { readonly kind: "trigger"; readonly scope: ActiveTriggerExecutionBindingInput }
  | { readonly kind: "watch"; readonly scope: ActiveWatchBindingInput }
  | { readonly kind: "connection"; readonly connectionId: string }
);

/** Runs are fenced before Workspace locks, including both ends of a control. */
export async function lockThreadCaller(
  tx: Transaction<DatabaseSchema>,
  caller: ThreadCallerAuthority | undefined,
  targetRunIds: readonly RunId[] = [],
): Promise<void> {
  if (!caller) return;
  if (caller.kind === "connection") {
    await tx
      .selectFrom("agentConnections")
      .select("id")
      .where("id", "=", caller.connectionId)
      .forShare()
      .executeTakeFirst();
  }
  const ids = [
    ...new Set([...targetRunIds, ...(caller.kind === "run" ? [caller.scope.runId] : [])]),
  ].sort();
  if (ids.length)
    await tx
      .selectFrom("runs")
      .select("id")
      .where("id", "in", ids)
      .orderBy("id", "asc")
      .forNoKeyUpdate()
      .execute();
  await assertThreadCaller(tx, caller);
}

/** Live authority and target ceilings, rechecked within the mutation transaction. */
export async function assertThreadCaller(
  tx: Transaction<DatabaseSchema>,
  caller: ThreadCallerAuthority | undefined,
  target?: {
    readonly threadId?: ThreadId;
    readonly workspaceId?: import("@opensteer/core").WorkspaceId;
    readonly accessMode?: ThreadAccessMode;
  },
): Promise<void> {
  if (!caller) return;
  let reach = caller.reach;
  let accessMode = caller.accessMode;
  if (caller.kind === "connection") {
    const connection = await tx
      .selectFrom("agentConnections")
      .selectAll()
      .where("id", "=", caller.connectionId)
      .where("userId", "=", caller.userId)
      .where("revokedAt", "is", null)
      .where("expiresAt", ">", new Date())
      .executeTakeFirst();
    if (!connection || !connection.tokenHash)
      throw forbidden("The connected agent credential is invalid or expired.");
    accessMode = connection.accessMode;
    reach = connection.workspaceId
      ? { kind: "workspace", workspaceId: connection.workspaceId }
      : { kind: "user" };
    const user = await tx
      .selectFrom("users")
      .select("id")
      .where("id", "=", caller.userId)
      .where("disabledAt", "is", null)
      .executeTakeFirst();
    if (!user) throw forbidden("The connected agent credential is invalid or expired.");
    if (connection.workspaceId) {
      const membership = await tx
        .selectFrom("workspaceMemberships")
        .innerJoin("workspaces", "workspaces.id", "workspaceMemberships.workspaceId")
        .select("workspaceMemberships.id")
        .where("workspaceMemberships.workspaceId", "=", connection.workspaceId)
        .where("workspaceMemberships.userId", "=", caller.userId)
        .where("workspaceMemberships.role", "=", "owner")
        .where("workspaceMemberships.state", "=", "active")
        .where("workspaces.deletedAt", "is", null)
        .executeTakeFirst();
      if (!membership) throw forbidden("Connected agent Workspace authority is unavailable");
    }
  } else {
    let sourceId: ThreadId;
    if (caller.kind === "run") {
      const s = caller.scope;
      await assertActiveGrant(tx, s);
      sourceId = s.threadId;
    } else if (caller.kind === "trigger") {
      await assertActiveTriggerExecutionBinding(tx, caller.scope);
      sourceId = caller.scope.threadId;
    } else {
      await assertActiveWatchBinding(tx, caller.scope);
      sourceId = caller.scope.anchorThreadId;
    }
    const source = await tx
      .selectFrom("threads")
      .selectAll()
      .where("id", "=", sourceId)
      .executeTakeFirstOrThrow();
    accessMode = source.accessMode;
    reach = threadReachScope(source);
  }
  if (!threadAccessModeAtMost(caller.accessMode, accessMode))
    throw forbidden("Caller access mode was reduced");
  const thread = target?.threadId
    ? await tx
        .selectFrom("threads")
        .selectAll()
        .where("id", "=", target.threadId)
        .executeTakeFirstOrThrow()
    : undefined;
  const workspaceId = thread?.workspaceId ?? target?.workspaceId;
  if (
    workspaceId &&
    ((reach.kind === "workspace" && reach.workspaceId !== workspaceId) ||
      (reach.kind === "lineage" && thread?.lineageRootThreadId !== reach.lineageRootThreadId) ||
      (caller.reach.kind === "workspace" && caller.reach.workspaceId !== workspaceId) ||
      (caller.reach.kind === "lineage" &&
        thread?.lineageRootThreadId !== caller.reach.lineageRootThreadId))
  )
    throw forbidden("Target Thread is outside the caller's reach");
  if (
    !threadAccessModeAtMost(
      thread?.accessMode ?? target?.accessMode ?? caller.accessMode,
      caller.accessMode,
    )
  )
    throw forbidden("Target Thread has a stronger access mode than this caller");
}
function forbidden(message: string) {
  return new OpensteerError({ code: "forbidden", message });
}

export function withThreadCallerTransaction<
  Result extends { readonly thread: { readonly id: ThreadId } },
>(
  database: Kysely<DatabaseSchema>,
  input: { readonly authority?: ThreadCallerAuthority; readonly idempotencyKey: string } & (
    { readonly requestedBy: UserId } | { readonly createdBy: UserId }
  ),
  operation: (tx: Transaction<DatabaseSchema>) => Promise<Result>,
): Promise<Result> {
  return withDatabaseTransaction(database, async (tx) => {
    const userId = "requestedBy" in input ? input.requestedBy : input.createdBy;
    await lockCommandIdempotency(tx, userId, input.idempotencyKey);
    await lockThreadCaller(tx, input.authority);
    const result = await operation(tx);
    await assertThreadCaller(tx, input.authority, { threadId: result.thread.id });
    return result;
  });
}
