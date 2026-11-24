import {
  OpensteerError,
  threadAccessModeAtMost,
  type AssignmentId,
  type EnvironmentId,
  type GrantId,
  type RunId,
  type RunnerId,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import { expressionBuilder, sql, type Expression, type Kysely, type SqlBool } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { withPersonalReadTransaction } from "./personal-transaction.js";
import { delegatingConnectionStanding, liveDelegatingConnection } from "./resource-access.js";
type Database = Kysely<DatabaseSchema>;
export interface ActiveExecutionBindingInput {
  readonly lostExecution?: boolean;
  readonly bindingGeneration: number;
  readonly environmentId: EnvironmentId;
  readonly requestedBy: UserId;
  readonly runId: RunId;
  readonly runnerBootId: string;
  readonly runnerId: RunnerId;
  readonly threadId: ThreadId;
}
/** The Run, its active provider session and the hosting computer, as one binding check reads them. */
export interface ExecutionBindingFacts {
  readonly environmentId: EnvironmentId;
  readonly finishIntent: unknown;
  readonly runHarnessInstanceId: string;
  readonly requestedBy: UserId;
  readonly runStatus: string;
  readonly runBindingGeneration: number | null;
  readonly threadId: ThreadId;
  readonly agentHomeComputerId: RunnerId;
  readonly bindingGeneration: number | null;
  readonly providerSessionHarnessInstanceId: string;
  readonly leaseExpiresAt: Date | null;
  readonly runnerBootId: string | null;
  readonly runnerId: RunnerId | null;
  readonly providerSessionStatus: string;
  readonly revokedAt: Date | null;
}
export function executionBindingHolds(
  binding: ExecutionBindingFacts | undefined,
  input: ActiveExecutionBindingInput,
  now: number,
): boolean {
  return (
    binding !== undefined &&
    binding.finishIntent === null &&
    binding.environmentId === input.environmentId &&
    binding.runHarnessInstanceId === binding.providerSessionHarnessInstanceId &&
    binding.threadId === input.threadId &&
    binding.requestedBy === input.requestedBy &&
    binding.runnerId === input.runnerId &&
    binding.agentHomeComputerId === input.runnerId &&
    binding.runnerBootId === input.runnerBootId &&
    binding.revokedAt === null &&
    binding.bindingGeneration === input.bindingGeneration &&
    binding.runBindingGeneration === input.bindingGeneration &&
    binding.leaseExpiresAt !== null &&
    (input.lostExecution === true || binding.leaseExpiresAt.getTime() > now) &&
    ["starting", "running", "waiting"].includes(binding.runStatus) &&
    !["stopped", "broken"].includes(binding.providerSessionStatus)
  );
}
export function refuseExecutionBinding(): never {
  throw new OpensteerError({
    code: "forbidden",
    message: "Execution capability came from a stale or invalid binding",
  });
}
export async function assertActiveExecutionBinding(
  database: Database,
  input: ActiveExecutionBindingInput,
  executionNow: () => number = Date.now,
): Promise<void> {
  const binding = await database
    .selectFrom("runs")
    .innerJoin("personalSettings", "personalSettings.ownerId", "runs.requestedBy")
    .innerJoin("providerSessions", "providerSessions.id", "runs.providerSessionId")
    .innerJoin("runners", "runners.id", "providerSessions.runnerId")
    .select([
      "runs.environmentId",
      "runs.finishIntent",
      "runs.harnessInstanceId as runHarnessInstanceId",
      "runs.requestedBy",
      "runs.status as runStatus",
      "runs.bindingGeneration as runBindingGeneration",
      "runs.threadId",
      "personalSettings.agentHomeComputerId",
      "providerSessions.bindingGeneration",
      "providerSessions.harnessInstanceId as providerSessionHarnessInstanceId",
      "providerSessions.leaseExpiresAt",
      "providerSessions.runnerBootId",
      "providerSessions.runnerId",
      "providerSessions.status as providerSessionStatus",
      "runners.revokedAt",
    ])
    .where("runs.id", "=", input.runId)
    .where("providerSessions.active", "=", true)
    .executeTakeFirst();
  if (
    !executionBindingHolds(binding, input, executionNow()) ||
    (input.lostExecution !== true &&
      !(await admitThreadExecution(database, input.threadId, input.requestedBy)))
  )
    refuseExecutionBinding();
}
export async function assignmentWasCancelled(
  database: Database,
  assignmentId: AssignmentId | null,
): Promise<boolean> {
  if (!assignmentId) return false;
  const { rows } = await sql<{ cancelled: boolean }>`
    with recursive ancestors(id, parent_assignment_id, status) as (
      select id, parent_assignment_id, status from delegations where id = ${assignmentId}
      union
      select parent.id, parent.parent_assignment_id, parent.status
      from delegations parent join ancestors on parent.id = ancestors.parent_assignment_id
    )
    select exists (select 1 from ancestors where status = 'cancelled') as cancelled
  `.execute(database);
  return rows[0]!.cancelled;
}

export async function assertActiveGrant(
  database: Database,
  input: ActiveExecutionBindingInput & {
    readonly grantId?: GrantId | undefined;
  },
  executionNow: () => number = Date.now,
): Promise<RunLineage> {
  const row = await database
    .selectFrom("runs")
    .innerJoin("threads", "threads.id", "runs.threadId")
    .innerJoin("personalSettings", "personalSettings.ownerId", "runs.requestedBy")
    .innerJoin("users", "users.id", "personalSettings.ownerId")
    .innerJoin("providerSessions", "providerSessions.id", "runs.providerSessionId")
    .innerJoin("runners", "runners.id", "providerSessions.runnerId")
    .leftJoin("executionEnvironments", (join) =>
      join
        .onRef("executionEnvironments.id", "=", "threads.environmentId")
        .onRef("executionEnvironments.runnerId", "=", "personalSettings.agentHomeComputerId"),
    )
    .select((eb) => [
      "runs.environmentId",
      "runs.finishIntent",
      "runs.harnessInstanceId as runHarnessInstanceId",
      "runs.requestedBy",
      "runs.status as runStatus",
      "runs.bindingGeneration as runBindingGeneration",
      "runs.threadId",
      "runs.assignmentId",
      "runs.connectionId",
      "runs.admittedGrantRevision",
      "runs.admittedAccessMode",
      "threads.originConnectionId",
      "personalSettings.agentHomeComputerId",
      "users.disabledAt as ownerDisabledAt",
      "providerSessions.bindingGeneration",
      "providerSessions.harnessInstanceId as providerSessionHarnessInstanceId",
      "providerSessions.leaseExpiresAt",
      "providerSessions.runnerBootId",
      "providerSessions.runnerId",
      "providerSessions.status as providerSessionStatus",
      "runners.revokedAt",
      "executionEnvironments.id as availableEnvironmentId",
      eb
        .selectFrom("grants")
        .select(
          sql<boolean>`count(*) = 1 and coalesce(bool_and(grants.runner_id = ${input.runnerId} and grants.runner_boot_id = ${input.runnerBootId}), false)`.as(
            "matched",
          ),
        )
        .where("grants.runId", "=", input.runId)
        .where("grants.status", "=", "active")
        .where("grants.bindingGeneration", "=", input.bindingGeneration)
        .$if(input.grantId !== undefined, (query) => query.where("grants.id", "=", input.grantId!))
        .where((geb) =>
          geb.not(
            geb.exists(
              geb
                .selectFrom("runAttempts")
                .select("id")
                .whereRef("runAttempts.runId", "=", "grants.runId")
                .whereRef("runAttempts.bindingGeneration", "=", "grants.bindingGeneration")
                .whereRef("runAttempts.runnerId", "=", "grants.runnerId")
                .whereRef("runAttempts.runnerBootId", "=", "grants.runnerBootId")
                .where("runAttempts.terminalEvidenceAt", "is not", null),
            ),
          ),
        )
        .as("hasActiveGrant"),
    ])
    .where("runs.id", "=", input.runId)
    .where("personalSettings.singletonKey", "=", "personal")
    .where("providerSessions.active", "=", true)
    .executeTakeFirst();
  const threadAdmitted =
    row !== undefined && row.ownerDisabledAt === null && row.availableEnvironmentId !== null;
  if (
    !row ||
    !executionBindingHolds(row, input, executionNow()) ||
    (input.lostExecution !== true && !threadAdmitted)
  )
    refuseExecutionBinding();
  if (!row.hasActiveGrant)
    throw new OpensteerError({
      code: "forbidden",
      message: "Run tool authority has ended",
    });
  // A native personal Run with no delegation or connection completes in one atomic MVCC read.
  if (row.assignmentId === null && row.connectionId === null)
    return { agentConnectionId: null, taskOriginConnectionId: row.originConnectionId };
  // Delegated and connected-agent Runs keep one repeatable-read snapshot across the grant,
  // delegation ancestry and connection rows.
  if (!database.isTransaction) {
    return withPersonalReadTransaction(database, (transaction) =>
      assertActiveGrant(transaction, input, executionNow),
    );
  }
  if (await assignmentWasCancelled(database, row.assignmentId))
    throw new OpensteerError({
      code: "forbidden",
      message: "Run tool authority has ended",
    });
  if (row.connectionId) {
    const connection = await liveDelegatingConnection(
      database,
      input.requestedBy,
      row.connectionId,
    );
    if (
      row.runBindingGeneration !== input.bindingGeneration ||
      (connection.cleanupMinimumGrantRevision !== null &&
        (row.admittedGrantRevision === null ||
          row.admittedGrantRevision < connection.cleanupMinimumGrantRevision ||
          (row.admittedGrantRevision === connection.cleanupMinimumGrantRevision &&
            connection.cleanupMaximumMode !== null &&
            (row.admittedAccessMode === null ||
              !threadAccessModeAtMost(row.admittedAccessMode, connection.cleanupMaximumMode)))))
    )
      refuseExecutionBinding();
  }
  return { agentConnectionId: row.connectionId, taskOriginConnectionId: row.originConnectionId };
}
/** Whom an authenticated Run works for, from the row that authenticated it. */
export interface RunLineage {
  readonly agentConnectionId: string | null;
  readonly taskOriginConnectionId: string | null;
}
/**
 * New work in a task: the task's environment, and the connection it would work for, if any,
 * still live and still granted Tasks. Receipts and cleanup of work already admitted never ask this.
 */
export async function admitLineageExecution(
  database: Database,
  input: {
    readonly threadId: ThreadId;
    readonly userId: UserId;
    readonly agentConnectionId: string | null;
  },
): Promise<{ readonly environmentId: EnvironmentId } | null> {
  const admission = await admitThreadExecution(database, input.threadId, input.userId);
  if (!admission || !input.agentConnectionId) return admission;
  return (await liveDelegatingConnection(database, input.userId, input.agentConnectionId).then(
    () => true,
    () => false,
  ))
    ? admission
    : null;
}
/**
 * The same admission, telling held from lost: the connection's standing is read first, in one
 * statement, so a chat that is waiting is `waiting` whatever else is true, and one that is live
 * is never reported lost because its account changed between two reads.
 */
export async function lineageExecutionStanding(
  database: Database,
  input: {
    readonly threadId: ThreadId;
    readonly userId: UserId;
    readonly agentConnectionId: string | null;
  },
  options?: {
    /** Lock the anchor `threads` row (`FOR SHARE`) in the same statement as the standing read. */
    readonly lockAnchor?: boolean;
  },
): Promise<
  | { readonly kind: "admitted"; readonly environmentId: EnvironmentId }
  | { readonly kind: "waiting" }
  | {
      readonly kind: "held";
      readonly reason: "previous-stop-unconfirmed";
      readonly environmentId: EnvironmentId;
    }
  | { readonly kind: "lost" }
> {
  if (input.agentConnectionId) {
    const standing = await delegatingConnectionStanding(
      database,
      input.userId,
      input.agentConnectionId,
    );
    if (standing === "waiting") return { kind: "waiting" };
    if (standing === "ended") return { kind: "lost" };
  }
  let query = database
    .selectFrom("threads")
    .select(["threads.environmentId", "threads.unconfirmedStopRunId"])
    .where("threads.id", "=", input.threadId)
    .where(threadExecutionAdmitted(input.userId));
  if (options?.lockAnchor) query = query.forShare();
  const row = await query.executeTakeFirst();
  if (!row) return { kind: "lost" };
  if (row.unconfirmedStopRunId !== null) {
    return {
      kind: "held",
      reason: "previous-stop-unconfirmed",
      environmentId: row.environmentId,
    };
  }
  return { kind: "admitted", environmentId: row.environmentId };
}
function availableExecutionEnvironmentSubquery(userId: UserId) {
  return expressionBuilder<DatabaseSchema, "threads">()
    .selectFrom("personalSettings")
    .innerJoin("users", "users.id", "personalSettings.ownerId")
    .innerJoin(
      "executionEnvironments",
      "executionEnvironments.runnerId",
      "personalSettings.agentHomeComputerId",
    )
    .innerJoin("runners", "runners.id", "executionEnvironments.runnerId")
    .select("executionEnvironments.id")
    .where("personalSettings.singletonKey", "=", "personal")
    .where("personalSettings.ownerId", "=", userId)
    .where("users.disabledAt", "is", null)
    .where("runners.revokedAt", "is", null);
}

/**
 * The single SQL predicate for whether a `threads` row's execution is admitted for `userId`.
 * Both `admitThreadExecution` and `connectionRequests` call this builder so execution admission
 * cannot drift between execution checks and request visibility.
 */
export function threadExecutionAdmitted(userId: UserId): Expression<SqlBool> {
  const eb = expressionBuilder<DatabaseSchema, "threads">();
  return eb.exists(
    availableExecutionEnvironmentSubquery(userId).whereRef(
      "executionEnvironments.id",
      "=",
      "threads.environmentId",
    ),
  );
}

export async function executionEnvironmentIsAvailableToUser(
  database: Database,
  environmentId: EnvironmentId,
  userId: UserId,
): Promise<boolean> {
  const eb = expressionBuilder<DatabaseSchema, never>();
  const row = await database
    .selectNoFrom(
      eb
        .exists(
          availableExecutionEnvironmentSubquery(userId).where(
            "executionEnvironments.id",
            "=",
            environmentId,
          ),
        )
        .as("available"),
    )
    .executeTakeFirstOrThrow();
  return Boolean(row.available);
}
export async function admitThreadExecution(
  database: Database,
  threadId: ThreadId,
  userId: UserId,
): Promise<{
  readonly environmentId: EnvironmentId;
} | null> {
  const row = await database
    .selectFrom("threads")
    .select("threads.environmentId")
    .where("threads.id", "=", threadId)
    .where(threadExecutionAdmitted(userId))
    .executeTakeFirst();
  return row ?? null;
}
export async function deploymentOwnedExecutionIsAvailableToUser(
  database: Database,
  userId: UserId,
): Promise<boolean> {
  return Boolean(
    await database
      .selectFrom("personalSettings")
      .innerJoin("users", "users.id", "personalSettings.ownerId")
      .select("ownerId")
      .where("ownerId", "=", userId)
      .where("users.disabledAt", "is", null)
      .executeTakeFirst(),
  );
}
