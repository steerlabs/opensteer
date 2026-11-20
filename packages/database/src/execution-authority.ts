import {
  OpensteerError,
  agentGrantAllowsTasks,
  type AssignmentId,
  type EnvironmentId,
  type GrantId,
  type RunId,
  type RunnerId,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { bindingLineageConnectionId, lineageEndedMessage, liveLineage } from "./resource-access.js";
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
): Promise<void> {
  await assertActiveExecutionBinding(database, input, executionNow);
  const run = await database
    .selectFrom("runs")
    .select("assignmentId")
    .where("id", "=", input.runId)
    .executeTakeFirstOrThrow();
  const grant = await database
    .selectFrom("grants")
    .select(["runnerBootId", "runnerId"])
    .where("runId", "=", input.runId)
    .where("status", "=", "active")
    .where("bindingGeneration", "=", input.bindingGeneration)
    .$if(input.grantId !== undefined, (query) => query.where("id", "=", input.grantId!))
    .executeTakeFirst();
  if (
    !grant ||
    grant.runnerId !== input.runnerId ||
    grant.runnerBootId !== input.runnerBootId ||
    (await assignmentWasCancelled(database, run.assignmentId))
  )
    throw new OpensteerError({
      code: "forbidden",
      message: "Run tool authority has ended",
    });
  await assertRunLineageLive(database, input.runId, input.requestedBy);
}
/** A Run in a connection's lineage has authority only while that connection does. */
export async function assertRunLineageLive(
  database: Database,
  runId: RunId,
  requestedBy: UserId,
): Promise<void> {
  const lineageId = await bindingLineageConnectionId(database, `run:${runId}`);
  if (!lineageId) return;
  const lineage = await liveLineage(database, requestedBy, lineageId);
  if (!agentGrantAllowsTasks(lineage.grant))
    throw new OpensteerError({ code: "forbidden", message: lineageEndedMessage });
}
export async function executionEnvironmentIsAvailableToUser(
  database: Database,
  environmentId: EnvironmentId,
  userId: UserId,
): Promise<boolean> {
  const row = await database
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
    .where("executionEnvironments.id", "=", environmentId)
    .where("runners.revokedAt", "is", null)
    .executeTakeFirst();
  return row !== undefined;
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
    .select(["threads.environmentId", "threads.originConnectionId"])
    .where("threads.id", "=", threadId)
    .executeTakeFirst();
  if (!row || !(await executionEnvironmentIsAvailableToUser(database, row.environmentId, userId)))
    return null;
  // A task in a connection's lineage executes only while that connection may delegate.
  if (row.originConnectionId) {
    const lineage = await liveLineage(database, userId, row.originConnectionId).catch(() => null);
    if (!lineage || !agentGrantAllowsTasks(lineage.grant)) return null;
  }
  return { environmentId: row.environmentId };
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
