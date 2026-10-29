import {
  OpensteerError,
  type EnvironmentId,
  type GrantId,
  type RunId,
  type RunnerId,
  type ThreadId,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import type { ExpressionBuilder, Kysely, Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";

type Database = Kysely<DatabaseSchema> | Transaction<DatabaseSchema>;

interface ThreadExecutionAdmission {
  readonly environmentId: EnvironmentId;
  readonly membershipGeneration: number;
  readonly workspaceId: WorkspaceId;
}

interface ActiveExecutionBindingInput {
  /** Loss classification owns the authority/deadline outcome; binding identity still must match. */
  readonly lostExecution?: boolean;
  readonly bindingGeneration: number;
  readonly environmentId: EnvironmentId;
  readonly membershipGeneration?: number;
  readonly requestedBy: UserId;
  readonly runId: RunId;
  readonly runnerBootId: string;
  readonly runnerId: RunnerId;
  readonly threadId: ThreadId;
  readonly workspaceId: WorkspaceId;
}

/**
 * Validates the complete renewable execution capability against durable state.
 * Callers that already hold the Run row lock keep that lock through this check,
 * so a first-seen mutation and a terminal transition cannot both win.
 */
export async function assertActiveExecutionBinding(
  database: Database,
  input: ActiveExecutionBindingInput,
  executionNow: () => number = Date.now,
): Promise<void> {
  const binding = await database
    .selectFrom("runs")
    .innerJoin("threads", "threads.id", "runs.threadId")
    .innerJoin("providerSessions", "providerSessions.id", "runs.providerSessionId")
    .select([
      "runs.environmentId",
      "runs.harnessInstanceId as runHarnessInstanceId",
      "runs.membershipGeneration",
      "runs.requestedBy",
      "runs.status as runStatus",
      "runs.bindingGeneration as runBindingGeneration",
      "runs.threadId",
      "threads.workspaceId",
      "providerSessions.bindingGeneration",
      "providerSessions.harnessInstanceId as providerSessionHarnessInstanceId",
      "providerSessions.leaseExpiresAt",
      "providerSessions.runnerBootId",
      "providerSessions.runnerId",
      "providerSessions.status as providerSessionStatus",
    ])
    .where("runs.id", "=", input.runId)
    .where("providerSessions.active", "=", true)
    .where("providerSessions.bindingGeneration", "=", input.bindingGeneration)
    .executeTakeFirst();
  const valid =
    binding !== undefined &&
    binding.environmentId === input.environmentId &&
    binding.runHarnessInstanceId === binding.providerSessionHarnessInstanceId &&
    binding.threadId === input.threadId &&
    binding.requestedBy === input.requestedBy &&
    binding.workspaceId === input.workspaceId &&
    binding.runnerId === input.runnerId &&
    binding.runnerBootId === input.runnerBootId &&
    binding.bindingGeneration === input.bindingGeneration &&
    binding.runBindingGeneration === input.bindingGeneration &&
    binding.leaseExpiresAt !== null &&
    (input.lostExecution === true || binding.leaseExpiresAt.getTime() > executionNow()) &&
    (binding.runStatus === "starting" ||
      binding.runStatus === "running" ||
      binding.runStatus === "waiting") &&
    binding.providerSessionStatus !== "stopped" &&
    binding.providerSessionStatus !== "broken" &&
    (input.membershipGeneration === undefined ||
      safeGeneration(binding.membershipGeneration) === input.membershipGeneration) &&
    (input.lostExecution === true ||
      (await threadExecutionIsAvailableToUser(
        database,
        binding.threadId,
        binding.requestedBy,
        safeGeneration(binding.membershipGeneration),
      )));
  if (!valid) {
    throw new OpensteerError({
      code: "forbidden",
      message: "Execution capability came from a stale or invalid binding",
    });
  }
}

/**
 * Tool authority: the live binding plus the grant issued for it. The Runner's
 * own reporting needs only the binding, so a stopped Run still records how it
 * ended. A Workspace being deleted lends no tools to its Runs.
 */
export async function assertActiveGrant(
  database: Database,
  input: ActiveExecutionBindingInput & { readonly grantId?: GrantId | undefined },
  executionNow: () => number = Date.now,
): Promise<void> {
  await assertActiveExecutionBinding(database, input, executionNow);
  const grant = await database
    .selectFrom("grants")
    .innerJoin("runs", "runs.id", "grants.runId")
    .innerJoin("threads", "threads.id", "runs.threadId")
    .innerJoin("workspaces", "workspaces.id", "threads.workspaceId")
    .select(["grants.runnerBootId", "grants.runnerId", "workspaces.status as workspaceStatus"])
    .where("grants.runId", "=", input.runId)
    .where("grants.status", "=", "active")
    .where("grants.bindingGeneration", "=", input.bindingGeneration)
    .$if(input.grantId !== undefined, (query) => query.where("grants.id", "=", input.grantId!))
    .executeTakeFirst();
  if (
    !grant ||
    grant.runnerId !== input.runnerId ||
    grant.runnerBootId !== input.runnerBootId ||
    grant.workspaceStatus === "deleting" ||
    grant.workspaceStatus === "deleted"
  ) {
    throw new OpensteerError({ code: "forbidden", message: "Run tool authority has ended" });
  }
}

/**
 * A managed Runner belongs to the person it was attached for, even though it
 * is administered by the deployment. Enforcement activates only once
 * a binding exists: a self-hosted deployment enrolls managed Runners through an
 * admin route that names no owner, and those stay shared exactly as before.
 *
 * This predicate is mirrored by the SQL function
 * opensteer_user_can_execute_environment (four triggers enforce it on write)
 * and by OpensteerStore.listEnvironmentsForUser. All three move together.
 */
export function managedEnvironmentBindingAllowsUser(
  expression: ExpressionBuilder<DatabaseSchema, "executionEnvironments" | "runners">,
  userId: UserId,
) {
  return expression.or([
    expression("runners.kind", "<>", "managed"),
    expression("runners.ownerUserId", "is", null),
    expression("runners.ownerUserId", "=", userId),
  ]);
}

/**
 * The one durable execution-ownership invariant used by Threads and Triggers.
 * User-owned Runners are private to that user. Deployment-owned Runners are
 * shared only outside Personal mode; Personal's Main Runner belongs to the
 * sole Deployment administrator. A managed Runner bound to a user is private to
 * that user regardless of who administers it.
 */
export async function executionEnvironmentIsAvailableToUser(
  database: Database,
  environmentId: EnvironmentId,
  userId: UserId,
): Promise<boolean> {
  const deploymentOwnedAvailable = await deploymentOwnedExecutionIsAvailableToUser(
    database,
    userId,
  );
  const row = await database
    .selectFrom("executionEnvironments")
    .innerJoin("runners", "runners.id", "executionEnvironments.runnerId")
    .select("executionEnvironments.id")
    .where("executionEnvironments.id", "=", environmentId)
    .where((expression) =>
      expression.or([
        ...(deploymentOwnedAvailable ? [expression("runners.ownerKind", "=", "deployment")] : []),
        expression.and([
          expression("runners.ownerKind", "=", "user"),
          expression("runners.ownerUserId", "=", userId),
        ]),
      ]),
    )
    .where((expression) => managedEnvironmentBindingAllowsUser(expression, userId))
    .where("runners.revokedAt", "is", null)
    .executeTakeFirst();
  return row !== undefined;
}

export async function admitThreadExecution(
  database: Database,
  threadId: ThreadId,
  userId: UserId,
  expectedMembershipGeneration?: number,
): Promise<ThreadExecutionAdmission | null> {
  const row = await database
    .selectFrom("threads")
    .innerJoin("workspaceMemberships", "workspaceMemberships.workspaceId", "threads.workspaceId")
    .select(["threads.environmentId", "threads.workspaceId", "workspaceMemberships.generation"])
    .where("threads.id", "=", threadId)
    .where("workspaceMemberships.userId", "=", userId)
    .where("workspaceMemberships.state", "=", "active")
    .executeTakeFirst();
  if (!row) return null;
  const membershipGeneration = safeGeneration(row.generation);
  if (
    expectedMembershipGeneration !== undefined &&
    membershipGeneration !== expectedMembershipGeneration
  ) {
    return null;
  }
  if (!(await executionEnvironmentIsAvailableToUser(database, row.environmentId, userId))) {
    return null;
  }
  return {
    environmentId: row.environmentId,
    membershipGeneration,
    workspaceId: row.workspaceId,
  };
}

async function threadExecutionIsAvailableToUser(
  database: Database,
  threadId: ThreadId,
  userId: UserId,
  expectedMembershipGeneration: number,
): Promise<boolean> {
  return (
    (await admitThreadExecution(database, threadId, userId, expectedMembershipGeneration)) !== null
  );
}

export async function deploymentOwnedExecutionIsAvailableToUser(
  database: Database,
  userId: UserId,
): Promise<boolean> {
  const deployment = await database
    .selectFrom("deployments")
    .select("deploymentShape")
    .where("singletonKey", "=", "primary")
    .executeTakeFirst();
  if (!deployment) return false;
  if (deployment.deploymentShape.kind === "server") return true;
  const user = await database
    .selectFrom("users")
    .select("instanceRole")
    .where("id", "=", userId)
    .executeTakeFirst();
  return user?.instanceRole === "administrator";
}

function safeGeneration(value: string | number): number {
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("Stored Workspace membership generation is invalid");
  }
  return generation;
}
