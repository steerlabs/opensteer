import { isDeepStrictEqual } from "node:util";
import { sql } from "kysely";
import { assertProjectAuthority } from "./deployment-execution-authority.js";
import { jsonValue } from "./store-primitives.js";
import {
  ProjectRuntimeSnapshotSchema,
  resolveAdmittedProjectRuntime,
} from "./project-runtime-settings-store.js";
import { HumanRootSchema, ProjectRunBindingSchema, type ProjectRunBinding } from "@opensteer/core";
import { deploymentPolicy } from "@opensteer/core";
import {
  OpensteerError,
  type HumanRoot,
  type EnvironmentId,
  type GrantId,
  type RunId,
  type RunnerId,
  type ThreadId,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import type { ExpressionBuilder, Kysely, Transaction } from "kysely";
import type { RunRow, DatabaseSchema } from "./schema.js";

type Database = Kysely<DatabaseSchema> | Transaction<DatabaseSchema>;

export function requireHumanRequester(requestedBy: UserId | null): UserId {
  if (requestedBy === null) refuseUnattendedHumanPath();
  return requestedBy;
}

export function requireHumanMembershipGeneration(
  generation: string | number | null,
): string | number {
  if (generation === null) refuseUnattendedHumanPath();
  return generation;
}

function refuseUnattendedHumanPath(): never {
  throw new OpensteerError({
    code: "conflict",
    message: "This path does not support unattended Project work yet",
    reason: "unattended-project-work-unsupported",
  });
}

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
      safeGeneration(requireHumanMembershipGeneration(binding.membershipGeneration)) ===
        input.membershipGeneration) &&
    (input.lostExecution === true ||
      (await threadExecutionIsAvailableToUser(
        database,
        binding.threadId,
        requireHumanRequester(binding.requestedBy),
        safeGeneration(requireHumanMembershipGeneration(binding.membershipGeneration)),
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
  if (deploymentPolicy(deployment.deploymentShape).executionAccess === "member") return true;
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

export function projectOriginFromRow(
  row: Pick<
    RunRow,
    "requestedBy" | "membershipGeneration" | "initiatorGeneration" | "originConnectionId"
  >,
): HumanRoot | null {
  if (row.requestedBy === null) {
    if (
      row.membershipGeneration !== null ||
      row.initiatorGeneration !== null ||
      row.originConnectionId !== null
    )
      throw new OpensteerError({
        code: "forbidden",
        reason: "invalid-root-shape",
        message: "Stored Project work has an invalid human root",
      });
    return null;
  }
  return HumanRootSchema.parse({
    userId: row.requestedBy,
    membershipGeneration: Number(row.membershipGeneration),
    initiatorGeneration: Number(row.initiatorGeneration),
    originConnectionId: row.originConnectionId,
  });
}

export async function projectWorkIsCurrent(
  database: Database,
  row: Pick<
    RunRow,
    | "threadId"
    | "actorPrincipalId"
    | "requestedBy"
    | "membershipGeneration"
    | "initiatorGeneration"
    | "originConnectionId"
    | "authoritySource"
  >,
): Promise<boolean> {
  const result = await sql<{ valid: boolean }>`select public.opensteer_project_work_is_valid(
    ${row.threadId}, ${row.actorPrincipalId}, ${row.requestedBy}, ${row.membershipGeneration},
    ${row.initiatorGeneration}, ${row.originConnectionId}, ${jsonValue(row.authoritySource)}
  ) as valid`.execute(database);
  return result.rows[0]?.valid === true;
}

export async function readProjectRunBinding(
  database: Database,
  input: Pick<ProjectRunBinding, "runId" | "grantId">,
) {
  const row = await database
    .selectFrom("runs")
    .innerJoin("threads", "threads.id", "runs.threadId")
    .innerJoin("principals", "principals.id", "runs.actorPrincipalId")
    .innerJoin("grants", "grants.runId", "runs.id")
    .innerJoin("providerSessions", "providerSessions.id", "runs.providerSessionId")
    .selectAll("runs")
    .select([
      "threads.workspaceId",
      "threads.status as threadStatus",
      "principals.kind as principalKind",
      "principals.workspaceId as principalWorkspaceId",
      "grants.id as grantId",
      "grants.bindingGeneration as grantGeneration",
      "grants.runnerId as grantRunnerId",
      "grants.runnerBootId as grantRunnerBootId",
      "grants.status as grantStatus",
      "providerSessions.active as sessionActive",
      "providerSessions.status as sessionStatus",
      "providerSessions.runnerId as sessionRunnerId",
      "providerSessions.runnerBootId as sessionBootId",
      "providerSessions.bindingGeneration as sessionGeneration",
      "providerSessions.leaseExpiresAt",
      "providerSessions.harnessInstanceId as sessionHarnessId",
    ])
    .where("runs.id", "=", input.runId)
    .where("grants.id", "=", input.grantId)
    .executeTakeFirst();
  if (!row || row.principalKind !== "project" || row.principalWorkspaceId !== row.workspaceId)
    return null;
  const origin = projectOriginFromRow(row);
  return {
    row,
    binding: ProjectRunBindingSchema.parse({
      authority: {
        version: 1,
        principal: {
          kind: "project",
          principalId: row.actorPrincipalId,
          workspaceId: row.workspaceId,
        },
        origin,
      },
      runId: row.id,
      threadId: row.threadId,
      workspaceId: row.workspaceId,
      environmentId: row.environmentId,
      grantId: row.grantId,
      bindingGeneration: row.grantGeneration,
      runnerId: row.grantRunnerId,
      runnerBootId: row.grantRunnerBootId,
    }),
  };
}

/** A mutation reserves the Run before calling this, and holds its authority fences until commit. */
export async function assertActiveProjectBinding(
  database: Database,
  input: ProjectRunBinding,
  dependencies: {
    runnerIsAttached: (runnerId: RunnerId, runnerBootId: string) => boolean;
    now?: () => number;
  },
) {
  const binding = ProjectRunBindingSchema.parse(input);
  await assertProjectAuthority(database);
  const saved = await readProjectRunBinding(database, binding);
  if (!saved || !isDeepStrictEqual(saved.binding, binding))
    throw new OpensteerError({
      code: "forbidden",
      message: "Project binding does not match its stored origin",
    });
  const { row } = saved;
  if (
    row.threadStatus === "archived" ||
    row.grantStatus !== "active" ||
    !["starting", "running", "waiting"].includes(row.status) ||
    row.bindingGeneration !== binding.bindingGeneration ||
    !row.sessionActive ||
    !["starting", "running", "ready"].includes(row.sessionStatus) ||
    row.sessionRunnerId !== binding.runnerId ||
    row.sessionBootId !== binding.runnerBootId ||
    row.sessionGeneration !== binding.bindingGeneration ||
    row.sessionHarnessId !== row.harnessInstanceId ||
    row.leaseExpiresAt === null ||
    row.leaseExpiresAt.getTime() <= (dependencies.now ?? Date.now)() ||
    !(await projectWorkIsCurrent(database, row))
  )
    throw new OpensteerError({
      code: "forbidden",
      message: "Project execution authority has ended",
    });
  const snapshot = ProjectRuntimeSnapshotSchema.safeParse(row.authoritySource.projectRuntime);
  if (
    !snapshot.success ||
    snapshot.data.harnessInstanceId !== row.harnessInstanceId ||
    !isDeepStrictEqual(snapshot.data.modelSelection, row.modelSelection) ||
    snapshot.data.accessMode !== row.accessMode
  )
    throw new OpensteerError({
      code: "conflict",
      reason: "admitted-runtime-snapshot-mismatch",
      message: "Project Run has no matching admitted runtime snapshot",
    });
  const runtime = await resolveAdmittedProjectRuntime(
    database,
    row.workspaceId,
    snapshot.data,
    (runnerId) =>
      runnerId === binding.runnerId &&
      dependencies.runnerIsAttached(runnerId, binding.runnerBootId),
  );
  if (runtime.state !== "ready" || runtime.environmentId !== binding.environmentId)
    throw new OpensteerError({
      code: "conflict",
      reason: runtime.state === "ready" ? "placement-changed" : runtime.reason,
      message: "Project execution runtime is unavailable",
    });
  return saved;
}
