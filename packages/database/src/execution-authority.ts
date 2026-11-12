import {
  OpensteerError,
  type EnvironmentId,
  type GrantId,
  type RunId,
  type RunnerId,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";
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
    !binding ||
    binding.environmentId !== input.environmentId ||
    binding.runHarnessInstanceId !== binding.providerSessionHarnessInstanceId ||
    binding.threadId !== input.threadId ||
    binding.requestedBy !== input.requestedBy ||
    binding.runnerId !== input.runnerId ||
    binding.agentHomeComputerId !== input.runnerId ||
    binding.runnerBootId !== input.runnerBootId ||
    binding.revokedAt !== null ||
    binding.bindingGeneration !== input.bindingGeneration ||
    binding.runBindingGeneration !== input.bindingGeneration ||
    binding.leaseExpiresAt === null ||
    (input.lostExecution !== true && binding.leaseExpiresAt.getTime() <= executionNow()) ||
    !["starting", "running", "waiting"].includes(binding.runStatus) ||
    ["stopped", "broken"].includes(binding.providerSessionStatus) ||
    (input.lostExecution !== true &&
      !(await admitThreadExecution(database, input.threadId, input.requestedBy)))
  )
    throw new OpensteerError({
      code: "forbidden",
      message: "Execution capability came from a stale or invalid binding",
    });
}
export async function assertActiveGrant(
  database: Database,
  input: ActiveExecutionBindingInput & {
    readonly grantId?: GrantId | undefined;
  },
  executionNow: () => number = Date.now,
): Promise<void> {
  await assertActiveExecutionBinding(database, input, executionNow);
  const grant = await database
    .selectFrom("grants")
    .select(["runnerBootId", "runnerId"])
    .where("runId", "=", input.runId)
    .where("status", "=", "active")
    .where("bindingGeneration", "=", input.bindingGeneration)
    .$if(input.grantId !== undefined, (query) => query.where("id", "=", input.grantId!))
    .executeTakeFirst();
  if (!grant || grant.runnerId !== input.runnerId || grant.runnerBootId !== input.runnerBootId)
    throw new OpensteerError({
      code: "forbidden",
      message: "Run tool authority has ended",
    });
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
    .select("threads.environmentId")
    .where("threads.id", "=", threadId)
    .executeTakeFirst();
  return row && (await executionEnvironmentIsAvailableToUser(database, row.environmentId, userId))
    ? row
    : null;
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
