import { type IntegrationConnectionId } from "@opensteer/channel-core";
import {
  type AgentEvent,
  type EnvironmentId,
  type RequestId,
  type RunId,
  type RunnerId,
  type UserId,
  nonTerminalRunStatuses,
  OpensteerError,
  runnerRunsItsDeployment,
  sameStringSet,
} from "@opensteer/core";
import {
  type BrowserSessionId,
  type MachineAccessPolicy,
  type RunnerDescriptor,
  type RunnerDevice,
  type RunnerDeviceProfile,
  type RunnerModuleName,
  type RunnerModules,
  advertisedRunnerModules,
  machineAccessPolicyDefault,
  runnerDescriptorProfileRefusal,
  runnerEnvironmentIds,
} from "@opensteer/protocol";
import { type Kysely, type Transaction, sql } from "kysely";
import { discoverComputerRequestWorkspaces } from "./computer-app-approvals.js";
import { withDatabaseTransaction } from "./connection.js";
import { revokeComputerConnectionsInTransaction } from "./integration-platform-stores.js";
import { databaseOperationOptions } from "./operation-budget.js";
import { RequestLockSetChanged, withRequestWorkspaceLocks } from "./request-workspace-locks.js";
import { finalizeRunTransaction } from "./run-finalization.js";
import { lockRunProjectionRows } from "./run-projection-locks.js";
import { type DatabaseSchema } from "./schema.js";
import { type ChannelLinks, jsonValue, lockWorkspaceRow } from "./store-primitives.js";

export const configuredBootstrapEnrollmentLifetimeMs = 24 * 60 * 60 * 1_000;

export interface RunnerAuthenticationRecord {
  readonly deviceProfile: RunnerDeviceProfile | null;
  /** The enrollment's immutable grant. An advertisement must be a subset. */
  readonly allowedModules: readonly RunnerModuleName[];
  readonly connectionGeneration: number;
  readonly environmentIds: readonly EnvironmentId[];
  readonly publicKeyFingerprint: string;
  readonly publicKeyPem: string;
  readonly revokedAt: Date | null;
  readonly runnerId: RunnerId;
  readonly runnerKind: "main" | "local" | "managed";
}

export interface RunnerConnectionRecord extends RunnerAuthenticationRecord {
  readonly enrolledAt: Date;
  readonly lastSeenAt: Date;
  /**
   * The Personal route generation this connection was admitted under, or null
   * where the Personal rules do not apply. The admission commits before the
   * connection is live, so the caller carries this forward and refuses to
   * register once the route has moved underneath it.
   */
  readonly personalRemoteAccessGeneration: number | null;
}

export interface RunnerInventoryRecord {
  readonly deviceProfile: RunnerDeviceProfile | null;
  readonly updateRequired: "agent-phone-outdated" | "runner-outdated" | null;
  readonly accessPolicy: MachineAccessPolicy;
  readonly accessPolicyRevision: number;
  readonly allowedModules: readonly RunnerModuleName[];
  readonly capabilities: readonly string[];
  readonly connectionGeneration: number;
  readonly device: RunnerDevice | null;
  readonly enrolledAt: Date;
  readonly enrollmentId: string;
  readonly environmentIds: readonly EnvironmentId[];
  readonly id: RunnerId;
  readonly kind: "main" | "local" | "managed";
  readonly lastSeenAt: Date | null;
  readonly moduleDescriptors: RunnerModules;
  readonly name: string;
  readonly ownerKind: "deployment" | "user";
  /** The owning person's display name; null for a Deployment-owned Runner. */
  readonly ownerName: string | null;
  readonly ownerUserId: UserId | null;
  readonly publicKeyFingerprint: string;
  readonly revokedAt: Date | null;
}

export interface RunnerEnrollmentIssuanceRecord {
  readonly deviceProfile: RunnerDeviceProfile | null;
  readonly allowedModules: readonly RunnerModuleName[];
  readonly expiresAt: Date;
  readonly id: string;
  readonly runnerKind: "main" | "local" | "managed";
  readonly tokenHash: string;
}

export interface PendingRunnerEnrollmentRecord {
  readonly deviceProfile: RunnerDeviceProfile | null;
  readonly allowedModules: readonly RunnerModuleName[];
  readonly expiresAt: Date;
  readonly id: string;
  readonly name: string;
  readonly ownerKind: "deployment" | "user";
  readonly runnerKind: "main" | "local" | "managed";
}

/**
 * Refuses an advertisement that reaches outside the enrollment's grant. The
 * grant is the durable statement of what this computer was invited to do, so
 * widening it can only happen by issuing a new enrollment.
 */
function assertModulesWithinGrant(
  descriptor: RunnerDescriptor,
  allowedModules: readonly RunnerModuleName[],
): void {
  const granted = new Set(allowedModules);
  const advertised = advertisedRunnerModules(descriptor.modules);
  const refused = advertised.filter((module) => !granted.has(module));
  if (refused.length > 0) {
    throw new OpensteerError({
      code: "forbidden",
      message: `Runner enrollment does not allow the ${refused.sort().join(", ")} module`,
    });
  }
}

async function lockMainRunnerEnrollment(transaction: Transaction<DatabaseSchema>): Promise<void> {
  const lockKey = "deployment-main-runner-enrollment";
  await sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`.execute(
    transaction,
    databaseOperationOptions(),
  );
}

async function bindRunnerEnvironments(
  transaction: Transaction<DatabaseSchema>,
  descriptor: RunnerDescriptor,
  name: string,
): Promise<void> {
  const assigned = await transaction
    .selectFrom("executionEnvironments")
    .select("id")
    .where("runnerId", "=", descriptor.runnerId)
    .orderBy("id", "asc")
    .forNoKeyUpdate()
    .execute(databaseOperationOptions());
  const assignedIds = assigned.map((environment) => environment.id);
  const environmentIds = runnerEnvironmentIds(descriptor);
  if (assignedIds.length > 0 && !sameStringSet(assignedIds, environmentIds)) {
    throw new OpensteerError({
      code: "forbidden",
      message: "Runner execution environment binding is immutable",
    });
  }

  for (const environmentId of environmentIds) {
    const existing = await transaction
      .selectFrom("executionEnvironments")
      .select(["kind", "runnerId"])
      .where("id", "=", environmentId)
      .forNoKeyUpdate()
      .executeTakeFirst(databaseOperationOptions());
    if (existing?.runnerId && existing.runnerId !== descriptor.runnerId) {
      throw new OpensteerError({
        code: "conflict",
        message: "Execution environment is assigned to another Runner",
      });
    }
    if (existing && existing.kind !== descriptor.runnerKind) {
      throw new OpensteerError({
        code: "conflict",
        message: "Execution environment kind is immutable",
      });
    }
    if (existing) {
      await transaction
        .updateTable("executionEnvironments")
        .set({
          capabilities: jsonValue(descriptor.capabilities),
          name,
          runnerId: descriptor.runnerId,
        })
        .where("id", "=", environmentId)
        .executeTakeFirstOrThrow(databaseOperationOptions());
    } else {
      await transaction
        .insertInto("executionEnvironments")
        .values({
          capabilities: jsonValue(descriptor.capabilities),
          id: environmentId,
          kind: descriptor.runnerKind,
          name,
          runnerId: descriptor.runnerId,
        })
        .executeTakeFirstOrThrow(databaseOperationOptions());
    }
  }
}

async function activateRunnerConnection(
  transaction: Transaction<DatabaseSchema>,
  descriptor: RunnerDescriptor,
): Promise<RunnerConnectionRecord> {
  const existing = await transaction
    .selectFrom("runners")
    .select([
      "deviceProfile",
      "allowedModules",
      "id",
      "kind",
      "name",
      "ownerKind",
      "publicKeyFingerprint",
      "publicKeyPem",
      "revokedAt",
    ])
    .where("id", "=", descriptor.runnerId)
    .forNoKeyUpdate()
    .executeTakeFirst(databaseOperationOptions());
  if (existing?.revokedAt) {
    // Said apart from the refusal below, and reached when a revocation lands
    // between the read that classified this connection and this transaction.
    // Everything else stays one undifferentiated "failed", which is all an
    // unauthenticated caller is owed.
    throw new OpensteerError({
      code: "forbidden",
      message: "Runner is revoked",
      reason: runnerIdentityRevokedReason,
    });
  }
  if (!existing || existing.kind !== descriptor.runnerKind) {
    throw new OpensteerError({ code: "forbidden", message: "Runner authentication failed" });
  }
  // The grant is checked on every reconnect, not only at enrollment: a Runner
  // that could add a module later would widen its own authority for free.
  const profileRefusal = runnerDescriptorProfileRefusal(existing.deviceProfile, descriptor);
  if (profileRefusal) throw new OpensteerError({ code: "forbidden", ...profileRefusal });
  assertModulesWithinGrant(descriptor, existing.allowedModules);
  // Membership is rechecked here rather than only where the row was written:
  // this is the one place every arrival passes through, redemption and
  // reauthentication alike, and both of the Personal rules are about arrival.
  const personalRemoteAccessGeneration = await assertPersonalRunnerAdmission(transaction, {
    allowedModules: existing.allowedModules,
    ownerKind: existing.ownerKind,
    runnerKind: existing.kind,
    stage: "admission",
  });
  const environments = await transaction
    .selectFrom("executionEnvironments")
    .select("id")
    .where("runnerId", "=", descriptor.runnerId)
    .orderBy("id", "asc")
    .execute(databaseOperationOptions());
  const bound = environments.map((environment) => environment.id);
  const advertised = runnerEnvironmentIds(descriptor);
  if (!runnerAdvertisesItsEnvironmentBinding(bound, advertised)) {
    throw new OpensteerError({
      code: "forbidden",
      message: "Runner execution environment binding is immutable",
    });
  }
  // The first advertisement is the binding, and there is never a second one.
  // A computer can reach here having enrolled reach-only and come back running
  // agents: the grant already allowed it — `assertModulesWithinGrant` above
  // refuses an agents module the enrollment never granted — and until now it
  // simply had no environment to name.
  if (bound.length === 0 && advertised.length > 0) {
    await bindRunnerEnvironments(transaction, descriptor, existing.name);
  }
  const environmentIds = bound.length === 0 ? advertised : bound;

  const seenAt = new Date();
  const row = await transaction
    .updateTable("runners")
    .set({
      capabilities: jsonValue(descriptor.capabilities),
      connectionGeneration: sql`connection_generation + 1`,
      device: descriptor.device ? jsonValue(descriptor.device) : null,
      lastSeenAt: seenAt,
      maxConcurrentRuns: descriptor.modules.agents?.maxConcurrentRuns ?? null,
      moduleDescriptors: jsonValue(descriptor.modules),
      updateRequired: null,
      ...(descriptor.modules.integrations?.platform === "android" ? { name: descriptor.name } : {}),
      updatedAt: seenAt,
    })
    .where("id", "=", descriptor.runnerId)
    .where("revokedAt", "is", null)
    .returning([
      "deviceProfile",
      "allowedModules",
      "connectionGeneration",
      "enrolledAt",
      "id as runnerId",
      "kind as runnerKind",
      "lastSeenAt",
      "publicKeyFingerprint",
      "publicKeyPem",
      "revokedAt",
    ])
    .executeTakeFirstOrThrow(databaseOperationOptions());
  const connectionGeneration = Number(row.connectionGeneration);
  if (!Number.isSafeInteger(connectionGeneration) || connectionGeneration < 1) {
    throw new OpensteerError({
      code: "internal",
      message: "Stored Runner connection generation is invalid",
    });
  }
  if (!row.lastSeenAt) {
    throw new OpensteerError({ code: "internal", message: "Stored Runner last-seen is missing" });
  }
  return {
    ...row,
    connectionGeneration,
    environmentIds,
    lastSeenAt: row.lastSeenAt,
    personalRemoteAccessGeneration,
  };
}

function runnerAuthenticationRecord(row: {
  readonly deviceProfile: RunnerDeviceProfile | null;
  readonly allowedModules: readonly RunnerModuleName[];
  readonly connectionGeneration: string;
  readonly environmentIds: readonly EnvironmentId[];
  readonly publicKeyFingerprint: string;
  readonly publicKeyPem: string;
  readonly revokedAt: Date | null;
  readonly runnerId: RunnerId;
  readonly runnerKind: "main" | "local" | "managed";
}): RunnerAuthenticationRecord {
  const connectionGeneration = safeRunnerConnectionGeneration(row.connectionGeneration);
  return { ...row, connectionGeneration };
}

function safeRunnerConnectionGeneration(value: string): number {
  const connectionGeneration = Number(value);
  if (!Number.isSafeInteger(connectionGeneration) || connectionGeneration < 0) {
    throw new OpensteerError({
      code: "internal",
      message: "Stored Runner connection generation is invalid",
    });
  }
  return connectionGeneration;
}

/**
 * Fails the work that was waiting for a computer that no longer exists.
 *
 * A queued Run is waiting for dispatch, including a retry after a claim. Nothing
 * will fail it on its own: the coordinator skips an unavailable machine before claiming,
 * and disconnect recovery only knows about Runs that were already active. A
 * delegation explicitly targeted at this computer would otherwise stay pending
 * forever, with its parent agent waiting on a result that cannot come. The
 * terminal failure is what the pending-delegation outbox drains, so naming the
 * revocation here is what the parent eventually reads.
 */
/**
 * Ends every Run a revoked computer would have run or is running. A Run in
 * progress ends here too, whether or not the computer is connected: it may
 * never connect again, and its lease would otherwise be all that ended it.
 */
async function failRunsForRevokedRunner(
  transaction: Transaction<DatabaseSchema>,
  runnerId: RunnerId,
  links: ChannelLinks,
): Promise<readonly AgentEvent[]> {
  const affected = await transaction
    .selectFrom("runs")
    .innerJoin("executionEnvironments", "executionEnvironments.id", "runs.environmentId")
    .innerJoin("threads", "threads.id", "runs.threadId")
    .select(["runs.id", "runs.status", "runs.threadId", "threads.workspaceId"])
    .where("executionEnvironments.runnerId", "=", runnerId)
    .where("runs.status", "in", nonTerminalRunStatuses)
    .orderBy("runs.id", "asc")
    .forNoKeyUpdate("runs")
    .execute(databaseOperationOptions());
  // Finalizing a Run locks its Workspace. Taking every affected Workspace first,
  // in ID order as cross-Workspace delegation does, keeps two of them from
  // being taken in opposite orders.
  for (const workspaceId of [...new Set(affected.map((run) => run.workspaceId))].sort()) {
    await lockWorkspaceRow(transaction, workspaceId);
  }
  if (affected.length) {
    await transaction
      .selectFrom("threads")
      .select("id")
      .where(
        "id",
        "in",
        affected.map(({ threadId }) => threadId),
      )
      .orderBy("id", "asc")
      .forNoKeyUpdate()
      .execute(databaseOperationOptions());
  }
  await lockRunProjectionRows(transaction, {
    runIds: affected.map(({ id }) => id),
    threadIds: affected.map(({ threadId }) => threadId),
  });
  const events: AgentEvent[] = [];
  for (const run of affected) {
    events.push(
      ...(await finalizeRunTransaction(transaction, {
        completedAt: new Date(),
        failure: {
          code: "runner_revoked",
          message:
            run.status === "queued"
              ? "The computer this work was waiting for was removed from this deployment"
              : "The computer running this work was removed from this deployment",
          retryable: false,
          status: "failed",
        },
        links,
        queuedInputCancellation: "authority-cohort",
        requestCancellationReason: "process-lost",
        runId: run.id,
        source: "host",
        status: "failed",
      })),
    );
  }
  return events;
}

/**
 * The authoritative place the Personal main-Runner prohibition lives. The
 * Machines page reports it as a non-revocable row, but the rule has to hold
 * against the command path too: an administrator with a bearer token reaches
 * `machine.revoke` without ever rendering that page.
 */
async function requireRunnerIsRevocable(
  transaction: Transaction<DatabaseSchema>,
  runnerId: RunnerId,
): Promise<void> {
  const [runner, deployment] = await Promise.all([
    transaction
      .selectFrom("runners")
      .select(["kind", "ownerKind"])
      .where("id", "=", runnerId)
      .executeTakeFirst(databaseOperationOptions()),
    transaction
      .selectFrom("deployments")
      .select("deploymentShape")
      .where("singletonKey", "=", "primary")
      .executeTakeFirst(databaseOperationOptions()),
  ]);
  // A Runner that is not there is reported by the revocation itself.
  if (!runner) return;
  if (
    runnerRunsItsDeployment({
      deploymentIsPersonal: deployment?.deploymentShape.kind === "personal",
      ownerKind: runner.ownerKind,
      runnerKind: runner.kind,
    })
  ) {
    throw new OpensteerError({
      code: "forbidden",
      message:
        "This computer runs the Deployment itself and cannot be removed; removing it would leave nothing to run agents on",
    });
  }
}

/**
 * The fixed grant for Android's screen or an iPhone's data apps, through
 * `integrations`, and nothing else ever.
 *
 * A phone
 * lending its whole screen to agents is a different computer from a laptop
 * lent for reach, and a grant that also allowed `shell` would let a future
 * build of the phone app open a terminal nobody was asked about.
 */
export const phoneRunnerGrant: readonly RunnerModuleName[] = ["integrations"];

/**
 * Whether what a connecting computer says about its execution environment is
 * compatible with the one it is bound to.
 *
 * A computer's binding is set once and never changes — that is the invariant
 * `bindRunnerEnvironments` has always enforced. What it *advertises* is a
 * separate fact and does move: the same identity restarts with a smaller module
 * set when its owner turns "Runs agents" off, and a computer that is not
 * running agents has no environment to name. So an empty advertisement is
 * always compatible (it keeps the binding, it does not clear it), a first
 * advertisement against no binding is the binding, an advertisement equal to
 * the binding is the ordinary case, and a different one is a different computer
 * wearing this one's credential.
 */
export function runnerAdvertisesItsEnvironmentBinding(
  bound: readonly EnvironmentId[],
  advertised: readonly EnvironmentId[],
): boolean {
  if (advertised.length === 0 || bound.length === 0) return true;
  return sameStringSet(bound, advertised);
}

/**
 * The only grant a Personal Deployment issues to a computer that is not the one
 * hosting it. A Personal Deployment runs its agents on its own Mac, so every
 * other computer it knows is there to be reached, never to execute.
 */
const personalReachableGrant: readonly RunnerModuleName[] = ["integrations", "messaging", "shell"];

/**
 * The Personal stack's messaging service is a Deployment-owned managed
 * process beside the Host, not a computer lent over the remote-access route.
 * The Host's computer preset also grants `integrations` and `shell`, although
 * this service advertises only messaging, so this exact grant is the one
 * supervised-service exception.
 */
const personalSupervisedServiceGrant: readonly RunnerModuleName[] = [
  "integrations",
  "messaging",
  "shell",
];

/** Said when a Personal Deployment is asked for a computer that would execute. */
export const personalReachableGrantRefusal =
  "Only reachable computers can join a Personal Deployment.";

/** Said when a Personal Deployment has no route for another computer to arrive on. */
export const personalRemoteAccessRequiredRefusal =
  "Turn on remote access on this computer to connect other computers.";

/**
 * The discriminator on that refusal, so a caller branches on it rather than on
 * the sentence — which is a person's words and will be reworded.
 */
export const personalRemoteAccessRefusedReason = "personal-remote-access-off";

/**
 * The discriminator on a refusal that is terminal: this identity was retired,
 * and no amount of reconnecting brings it back.
 *
 * It is the one refusal a Runner must tell apart from the rest, because the
 * computer supervising it clears the slot on this and only this. Everything
 * else — a lease that ran out, a Deployment with no route right now, a proof
 * that did not verify — is a reason to try again.
 */
export const runnerIdentityRevokedReason = "runner-identity-revoked";

/**
 * The discriminator on a refusal of an enrollment token whose time ran out
 * before anything redeemed it. A computer that set itself up from one, such as
 * a phone paired over USB, can tell its person to mint a fresh token rather
 * than retry a token that will never work again.
 */
export const runnerEnrollmentExpiredReason = "runner-enrollment-expired";

/**
 * The two Personal membership rules, asked inside the caller's own transaction.
 *
 * Both are about computers other than the Main one: the Main Runner is the
 * Deployment, so its bootstrap grant is the sole exception to the first rule
 * and it is the machine remote access would be turned on *from*.
 *
 * `stage` says which rules apply. Minting an enrollment only fixes the grant —
 * a person may write down a computer before there is any route to it. Admitting
 * a connection, whether it is redeeming that enrollment or reauthenticating a
 * credential it kept, additionally needs a route to exist right now, and
 * rechecks the grant so a credential that no longer fits is refused rather than
 * quietly honoured.
 *
 * Returns the route generation the computer was admitted under, which is what
 * the caller fences its live registration against; null means the rules do not
 * apply to this computer at all, so there is nothing to fence.
 */
async function assertPersonalRunnerAdmission(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly allowedModules: readonly RunnerModuleName[];
    readonly ownerKind: "deployment" | "user";
    readonly runnerKind: "main" | "local" | "managed";
    readonly stage: "admission" | "issuance";
  },
): Promise<number | null> {
  const deployment = await transaction
    .selectFrom("deployments")
    .select("deploymentShape")
    .where("singletonKey", "=", "primary")
    .executeTakeFirst(databaseOperationOptions());
  if (deployment?.deploymentShape.kind !== "personal") return null;
  if (
    runnerRunsItsDeployment({
      deploymentIsPersonal: true,
      ownerKind: input.ownerKind,
      runnerKind: input.runnerKind,
    })
  ) {
    return null;
  }
  if (
    input.ownerKind === "deployment" &&
    input.runnerKind === "managed" &&
    sameStringSet(input.allowedModules, personalSupervisedServiceGrant)
  ) {
    return null;
  }
  // A phone lends its screen and nothing else, so it is reachable in exactly
  // the sense the rule asks: nothing of the Deployment's executes on it.
  if (
    !sameStringSet(input.allowedModules, personalReachableGrant) &&
    !sameStringSet(input.allowedModules, phoneRunnerGrant)
  ) {
    throw new OpensteerError({ code: "forbidden", message: personalReachableGrantRefusal });
  }
  if (input.stage === "issuance") return null;
  const remoteAccess = await transaction
    .selectFrom("personalRemoteAccess")
    .select(["generation", "mode"])
    .where("singletonKey", "=", "personal")
    .executeTakeFirst(databaseOperationOptions());
  // A missing row is the same answer as `off`: there is no route, so nothing
  // can have arrived over one.
  if (remoteAccess?.mode === undefined || remoteAccess.mode === "off") {
    throw new OpensteerError({
      code: "forbidden",
      message: personalRemoteAccessRequiredRefusal,
      reason: personalRemoteAccessRefusedReason,
    });
  }
  return Number(remoteAccess.generation);
}

/**
 * The grant the one-machine migration left on a legacy Personal Main Runner.
 *
 * Membership rather than the literal `["agents"]` it once was: later
 * migrations backfill `integrations`, `messaging` and `shell` onto every grant,
 * and a machine that has them is still the legacy agents-only machine this
 * upgrade is looking for. What it lacks is the browser.
 */
function isLegacyAgentsOnlyGrant(allowedModules: readonly RunnerModuleName[]): boolean {
  return allowedModules.includes("agents") && !allowedModules.includes("browser");
}

export async function runnerForAuthentication(
  database: Kysely<DatabaseSchema>,
  runnerId: RunnerId,
): Promise<RunnerAuthenticationRecord | null> {
  const row = await database
    .selectFrom("runners")
    .select([
      "deviceProfile",
      "allowedModules",
      "connectionGeneration",
      "id as runnerId",
      "kind as runnerKind",
      "publicKeyFingerprint",
      "publicKeyPem",
      "revokedAt",
    ])
    .where("id", "=", runnerId)
    .executeTakeFirst(databaseOperationOptions());
  if (!row) return null;
  const environments = await database
    .selectFrom("executionEnvironments")
    .select("id")
    .where("runnerId", "=", runnerId)
    .orderBy("id", "asc")
    .execute(databaseOperationOptions());
  return runnerAuthenticationRecord({
    ...row,
    environmentIds: environments.map((environment) => environment.id),
  });
}

/**
 * Which person, if anyone, the Runner behind this work location belongs to.
 *
 * A Deployment-owned Runner answers null and stays administrator-managed. A
 * user-owned one names its person, which is what lets a route refuse an
 * administrator the destructive actions that reach into somebody's own
 * machine — signing their real CLI out of their own laptop, say.
 */
export async function environmentRunnerOwner(
  database: Kysely<DatabaseSchema>,
  environmentId: EnvironmentId,
): Promise<UserId | null> {
  const row = await database
    .selectFrom("executionEnvironments")
    .innerJoin("runners", "runners.id", "executionEnvironments.runnerId")
    .innerJoin("runnerEnrollments", "runnerEnrollments.runnerId", "runners.id")
    .select("runnerEnrollments.createdBy")
    .where("executionEnvironments.id", "=", environmentId)
    .executeTakeFirst(databaseOperationOptions());
  return row?.createdBy ?? null;
}

/**
 * What the Runner advertised when it last connected. Every connection writes
 * it again, and a Run's grant pins one Runner boot, so it outlives a dropped
 * connection and a Host restart where the live registry does not.
 */
export async function runnerCapabilities(
  database: Kysely<DatabaseSchema>,
  runnerId: RunnerId,
): Promise<readonly string[] | null> {
  const row = await database
    .selectFrom("runners")
    .select("capabilities")
    .where("id", "=", runnerId)
    .executeTakeFirst(databaseOperationOptions());
  return row?.capabilities ?? null;
}

export async function bootstrapRunnerIsEnrolled(
  database: Kysely<DatabaseSchema>,
  createdBy: UserId,
): Promise<boolean> {
  const row = await database
    .selectFrom("runnerEnrollments")
    .innerJoin("runners", "runners.id", "runnerEnrollments.runnerId")
    .select("runnerEnrollments.id")
    .where("runnerEnrollments.createdBy", "=", createdBy)
    .where("runnerEnrollments.idempotencyKey", "=", "bootstrap-main")
    .where("runnerEnrollments.consumedAt", "is not", null)
    .where("runners.kind", "=", "main")
    .where("runners.ownerKind", "=", "deployment")
    .where("runners.ownerUserId", "is", null)
    .executeTakeFirst(databaseOperationOptions());
  return row !== undefined;
}

/** True once this Host has been claimed by a first owner. */
export async function hasInstanceAdministrator(database: Kysely<DatabaseSchema>): Promise<boolean> {
  const row = await database
    .selectFrom("users")
    .select("id")
    .where("instanceRole", "=", "administrator")
    .executeTakeFirst(databaseOperationOptions());
  return row !== undefined;
}

export async function deploymentMainRunnerState(
  database: Kysely<DatabaseSchema>,
): Promise<"absent" | "active" | "revoked"> {
  const active = await database
    .selectFrom("runners")
    .select("id")
    .where("kind", "=", "main")
    .where("ownerKind", "=", "deployment")
    .where("ownerUserId", "is", null)
    .where("revokedAt", "is", null)
    .executeTakeFirst(databaseOperationOptions());
  if (active) return "active";
  const revoked = await database
    .selectFrom("runners")
    .select("id")
    .where("kind", "=", "main")
    .where("ownerKind", "=", "deployment")
    .where("ownerUserId", "is", null)
    .where("revokedAt", "is not", null)
    .executeTakeFirst(databaseOperationOptions());
  return revoked ? "revoked" : "absent";
}

/**
 * Personal Desktop historically enrolled its browser as a separate Device.
 * The one-machine migration retained the existing Main Runner with an agents-
 * only grant, so widen exactly that legacy local grant when the same Personal
 * Deployment starts supervising the browser through its Main Runner.
 *
 */
export async function upgradeLegacyPersonalMainRunnerBrowserGrant(
  database: Kysely<DatabaseSchema>,
): Promise<boolean> {
  return withDatabaseTransaction(database, async (transaction) => {
    await lockMainRunnerEnrollment(transaction);
    const deployment = await transaction
      .selectFrom("deployments")
      .select("deploymentShape")
      .executeTakeFirst(databaseOperationOptions());
    if (deployment?.deploymentShape.kind !== "personal") return false;

    await transaction
      .selectFrom("runnerEnrollments")
      .innerJoin("runners", "runners.id", "runnerEnrollments.runnerId")
      .select("runnerEnrollments.id")
      .where("runners.kind", "=", "main")
      .where("runners.ownerKind", "=", "deployment")
      .where("runners.ownerUserId", "is", null)
      .where("runners.revokedAt", "is", null)
      .orderBy("runnerEnrollments.id", "asc")
      .forNoKeyUpdate("runnerEnrollments")
      .execute(databaseOperationOptions());
    const runner = await transaction
      .selectFrom("runners")
      .select(["allowedModules", "id"])
      .where("kind", "=", "main")
      .where("ownerKind", "=", "deployment")
      .where("ownerUserId", "is", null)
      .where("revokedAt", "is", null)
      .forNoKeyUpdate()
      .executeTakeFirst(databaseOperationOptions());
    if (!runner || !isLegacyAgentsOnlyGrant(runner.allowedModules)) return false;

    const enrollment = await transaction
      .selectFrom("runnerEnrollments")
      .select(["allowedModules", "id"])
      .where("runnerId", "=", runner.id)
      .where("runnerKind", "=", "main")
      .where("ownerKind", "=", "deployment")
      .where("ownerUserId", "is", null)
      .forNoKeyUpdate()
      .executeTakeFirst(databaseOperationOptions());
    if (!enrollment || !isLegacyAgentsOnlyGrant(enrollment.allowedModules)) return false;

    const allowedModules = jsonValue<readonly RunnerModuleName[]>([
      "agents",
      "browser",
      "integrations",
      "messaging",
      "shell",
    ]);
    await transaction
      .updateTable("runners")
      .set({ allowedModules })
      .where("id", "=", runner.id)
      .where("revokedAt", "is", null)
      .executeTakeFirstOrThrow(databaseOperationOptions());
    await transaction
      .updateTable("runnerEnrollments")
      .set({ allowedModules })
      .where("id", "=", enrollment.id)
      .where("runnerId", "=", runner.id)
      .executeTakeFirstOrThrow(databaseOperationOptions());
    return true;
  });
}

export async function listRunners(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly after?: RunnerId;
    readonly includeDeployment: boolean;
    readonly includeOtherOwners?: boolean;
    readonly limit: number;
    readonly ownerId: UserId;
  },
): Promise<{
  readonly nextCursor: RunnerId | null;
  readonly runners: readonly RunnerInventoryRecord[];
}> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new OpensteerError({ code: "bad_request", message: "Runner page limit is invalid" });
  }
  let query = database
    .selectFrom("runners")
    .select([
      "accessPolicy",
      "accessPolicyRevision",
      "deviceProfile",
      "allowedModules",
      "capabilities",
      "connectionGeneration",
      "device",
      "enrolledAt",
      "id",
      "kind",
      "lastSeenAt",
      "moduleDescriptors",
      "updateRequired",
      "name",
      "ownerKind",
      "ownerUserId",
      "publicKeyFingerprint",
      "revokedAt",
    ])
    .where((expression) =>
      expression.or([
        expression.and([
          expression("ownerKind", "=", "user"),
          expression("ownerUserId", "=", input.ownerId),
        ]),
        ...(input.includeDeployment ? [expression("ownerKind", "=", "deployment")] : []),
        ...(input.includeOtherOwners ? [expression("ownerKind", "=", "user")] : []),
      ]),
    );
  if (input.after) query = query.where("id", ">", input.after);
  const rows = await query
    .orderBy("id", "asc")
    .limit(input.limit + 1)
    .execute(databaseOperationOptions());
  const page = rows.slice(0, input.limit);
  const runnerIds = page.map((runner) => runner.id);
  const environments =
    runnerIds.length === 0
      ? []
      : await database
          .selectFrom("executionEnvironments")
          .select(["id", "runnerId"])
          .where("runnerId", "in", runnerIds)
          .orderBy("id", "asc")
          .execute(databaseOperationOptions());
  const environmentIdsByRunner = new Map<RunnerId, EnvironmentId[]>();
  for (const environment of environments) {
    if (!environment.runnerId) continue;
    const ids = environmentIdsByRunner.get(environment.runnerId) ?? [];
    ids.push(environment.id);
    environmentIdsByRunner.set(environment.runnerId, ids);
  }
  const enrollments =
    runnerIds.length === 0
      ? []
      : await database
          .selectFrom("runnerEnrollments")
          .select(["id", "runnerId"])
          .where("runnerId", "in", runnerIds)
          .execute(databaseOperationOptions());
  const enrollmentIdsByRunner = new Map(
    enrollments.flatMap(({ id, runnerId }) => (runnerId ? [[runnerId, id] as const] : [])),
  );
  const ownerIds = [
    ...new Set(page.flatMap(({ ownerUserId }) => (ownerUserId ? [ownerUserId] : []))),
  ];
  const owners =
    ownerIds.length === 0
      ? []
      : await database
          .selectFrom("users")
          .select(["displayName", "id"])
          .where("id", "in", ownerIds)
          .execute(databaseOperationOptions());
  const ownerNames = new Map(owners.map(({ displayName, id }) => [id, displayName]));
  return {
    nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
    runners: page.map((runner) => {
      const enrollmentId = enrollmentIdsByRunner.get(runner.id);
      if (!enrollmentId) throw new Error("Runner inventory is missing its enrollment record.");
      return {
        ...runner,
        connectionGeneration: safeRunnerConnectionGeneration(runner.connectionGeneration),
        enrollmentId,
        environmentIds: environmentIdsByRunner.get(runner.id) ?? [],
        ownerName: runner.ownerUserId ? (ownerNames.get(runner.ownerUserId) ?? null) : null,
      };
    }),
  };
}

/**
 * Retires a computer and everything it was trusted to do, in one transaction.
 *
 * The tombstone and the generation bump land together: a Runner that was only
 * tombstoned could still finish work on the socket it already holds, because
 * every fence check compares against the stored generation. Bumping it here
 * makes every frame still in flight stale, and the module cleanups below make
 * the state that outlives the socket — a browser session, a messaging
 * assignment, an unstarted delivery claim — stop naming this machine.
 *
 * A delivery whose attempt had already started stays `unknown`: the Host
 * cannot know whether the message reached the provider, and claiming it did
 * not would risk sending it twice.
 */
export async function revokeRunner(
  database: Kysely<DatabaseSchema>,
  links: ChannelLinks,
  runnerId: RunnerId,
  ownerId: UserId,
  options: { readonly allowDeployment?: boolean; readonly allowOtherOwners?: boolean } = {},
): Promise<{
  readonly cancelledRequestIds: readonly RequestId[];
  readonly closedBrowserSessions: readonly BrowserSessionId[];
  readonly events: readonly AgentEvent[];
  readonly requestEvents: readonly AgentEvent[];
  readonly revokedComputerConnectionIds: readonly IntegrationConnectionId[];
}> {
  const runs = (transaction: Transaction<DatabaseSchema>) =>
    transaction
      .selectFrom("runs")
      .innerJoin("executionEnvironments", "executionEnvironments.id", "runs.environmentId")
      .innerJoin("threads", "threads.id", "runs.threadId")
      .select(["runs.id", "threads.workspaceId"])
      .where("executionEnvironments.runnerId", "=", runnerId)
      .where("runs.status", "in", nonTerminalRunStatuses);
  const sessions = (transaction: Transaction<DatabaseSchema>) =>
    transaction
      .selectFrom("browserSessions")
      .select("id")
      .where("runnerId", "=", runnerId)
      .where("state", "in", ["starting", "ready", "closing"]);
  let runIds = new Set<RunId>();
  let sessionIds = new Set<BrowserSessionId>();
  const recheck = async (transaction: Transaction<DatabaseSchema>) => {
    const currentRuns = await runs(transaction).execute(databaseOperationOptions());
    const currentSessions = await sessions(transaction).execute(databaseOperationOptions());
    if (
      currentRuns.some(({ id }) => !runIds.has(id)) ||
      currentSessions.some(({ id }) => !sessionIds.has(id))
    ) {
      throw new RequestLockSetChanged(currentRuns.map(({ workspaceId }) => workspaceId));
    }
    return currentRuns.map(({ workspaceId }) => workspaceId);
  };
  return withRequestWorkspaceLocks(
    database,
    async (transaction) => [
      ...(await recheck(transaction)),
      ...(await discoverComputerRequestWorkspaces(transaction, runnerId)),
    ],
    async (transaction) => {
      const revokedAt = new Date();
      await requireRunnerIsRevocable(transaction, runnerId);
      const result = await transaction
        .updateTable("runners")
        .set({
          connectionGeneration: sql`connection_generation + 1`,
          revokedAt,
          updatedAt: revokedAt,
        })
        .where("id", "=", runnerId)
        .where((expression) =>
          expression.or([
            expression.and([
              expression("ownerKind", "=", "user"),
              expression("ownerUserId", "=", ownerId),
            ]),
            // Deployment-administered covers a managed Runner bound to a user:
            // the binding says whose work runs there, not who may retire it.
            ...(options.allowDeployment ? [expression("ownerKind", "=", "deployment")] : []),
            ...(options.allowOtherOwners ? [expression("ownerKind", "=", "user")] : []),
          ]),
        )
        .where("revokedAt", "is", null)
        .executeTakeFirst(databaseOperationOptions());
      if (result.numUpdatedRows !== 1n) {
        throw new OpensteerError({ code: "not_found", message: "Active Runner not found" });
      }
      // Runs first: every path that ends a Run locks it before its Workspace,
      // and the steps below lock Workspaces when they cancel Requests.
      await recheck(transaction);
      const runEvents = await failRunsForRevokedRunner(transaction, runnerId, links);
      await transaction
        .updateTable("triggerWatchActivations")
        .set({
          desired: "stopped",
          leaseExpiresAt: null,
          observed: "stopped",
          updatedAt: revokedAt,
        })
        .where((expression) =>
          expression.or([
            expression("runnerId", "=", runnerId),
            expression(
              "environmentId",
              "in",
              transaction
                .selectFrom("executionEnvironments")
                .select("id")
                .where("runnerId", "=", runnerId),
            ),
          ]),
        )
        .where("desired", "=", "active")
        .execute(databaseOperationOptions());

      const closed = await transaction
        .updateTable("browserSessions")
        .set({
          closedAt: revokedAt,
          // the session itself can never be reattached.
          state: "failed",
          updatedAt: revokedAt,
        })
        .where("runnerId", "=", runnerId)
        .where("state", "in", ["starting", "ready", "closing"])
        .returning("id")
        .execute(databaseOperationOptions());
      const closedBrowserSessions = closed.map((session) => session.id);
      if (closedBrowserSessions.length > 0) {
        await transaction
          .deleteFrom("browserSessionAttachments")
          .where("sessionId", "in", closedBrowserSessions)
          .execute(databaseOperationOptions());
      }

      const revokedComputerConnections = await revokeComputerConnectionsInTransaction(transaction, {
        runnerId,
      });

      // A messaging service's accounts may move to another; a channel pinned
      // to this computer went with its app connection above.
      await transaction
        .updateTable("integrationConnections")
        .set({ runnerId: null, updatedAt: revokedAt })
        .where("runnerId", "=", runnerId)
        .where("connectionKind", "=", "channel")
        .where("transportKind", "!=", "computer")
        .execute(databaseOperationOptions());

      await transaction
        .updateTable("channelDeliveries")
        .set({
          claimExpiresAt: null,
          claimOwner: null,
          claimTokenHash: null,
          nextAttemptAt: revokedAt,
          status: "pending",
          updatedAt: revokedAt,
        })
        .where("claimOwner", "=", runnerId)
        .where("status", "=", "leased")
        .execute(databaseOperationOptions());

      return {
        cancelledRequestIds: revokedComputerConnections.cancelledRequestIds,
        closedBrowserSessions,
        events: runEvents,
        requestEvents: revokedComputerConnections.requestEvents,
        revokedComputerConnectionIds: revokedComputerConnections.connectionIds,
      };
    },
    async (transaction) => {
      runIds = new Set(
        (
          await runs(transaction)
            .orderBy("runs.id", "asc")
            .forNoKeyUpdate("runs")
            .execute(databaseOperationOptions())
        ).map(({ id }) => id),
      );
      sessionIds = new Set(
        (
          await sessions(transaction)
            .orderBy("id", "asc")
            .forNoKeyUpdate()
            .execute(databaseOperationOptions())
        ).map(({ id }) => id),
      );
    },
  );
}

export async function renameRunner(
  database: Kysely<DatabaseSchema>,
  runnerId: RunnerId,
  ownerId: UserId,
  name: string,
  options: { readonly allowDeployment?: boolean } = {},
): Promise<void> {
  await withDatabaseTransaction(database, async (transaction) => {
    const updatedAt = new Date();
    const result = await transaction
      .updateTable("runners")
      .set({ name, updatedAt })
      .where("id", "=", runnerId)
      .where((expression) =>
        expression.or([
          expression.and([
            expression("ownerKind", "=", "user"),
            expression("ownerUserId", "=", ownerId),
          ]),
          ...(options.allowDeployment ? [expression("ownerKind", "=", "deployment")] : []),
        ]),
      )
      .where("revokedAt", "is", null)
      .executeTakeFirst(databaseOperationOptions());
    if (result.numUpdatedRows !== 1n) {
      throw new OpensteerError({ code: "not_found", message: "Active Runner not found" });
    }
    await transaction
      .updateTable("executionEnvironments")
      .set({ name })
      .where("runnerId", "=", runnerId)
      .execute(databaseOperationOptions());
    await transaction
      .selectFrom("integrationConnections")
      .select("id")
      .where("runnerId", "=", runnerId)
      .where("connectionKind", "=", "computer")
      .where("status", "!=", "revoked")
      .orderBy("id", "asc")
      .forNoKeyUpdate()
      .execute(databaseOperationOptions());
    await transaction
      .updateTable("integrationConnections")
      .set({ displayName: name, updatedAt })
      .where("runnerId", "=", runnerId)
      .where("connectionKind", "=", "computer")
      .where("status", "!=", "revoked")
      .execute(databaseOperationOptions());
  });
}

export async function listPendingRunnerEnrollments(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly includeDeployment: boolean;
    readonly limit: number;
    readonly ownerId: UserId;
  },
): Promise<readonly PendingRunnerEnrollmentRecord[]> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new OpensteerError({
      code: "bad_request",
      message: "Runner enrollment page limit is invalid",
    });
  }
  return database
    .selectFrom("runnerEnrollments")
    .select([
      "deviceProfile",
      "allowedModules",
      "expiresAt",
      "id",
      "name",
      "ownerKind",
      "runnerKind",
    ])
    .where("consumedAt", "is", null)
    .where("expiresAt", ">", new Date())
    .where((expression) =>
      expression.or([
        expression.and([
          expression("ownerKind", "=", "user"),
          expression("ownerUserId", "=", input.ownerId),
        ]),
        ...(input.includeDeployment ? [expression("ownerKind", "=", "deployment")] : []),
      ]),
    )
    .orderBy("createdAt", "desc")
    .limit(input.limit)
    .execute(databaseOperationOptions());
}

export async function ensureBootstrapRunnerEnrollment(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly allowedModules: readonly RunnerModuleName[];
    readonly createdBy: UserId;
    readonly id: string;
    readonly tokenHash: string;
  },
): Promise<void> {
  const createdAt = new Date();
  await database
    .insertInto("runnerEnrollments")
    .values({
      allowedModules: jsonValue(input.allowedModules),
      consumedAt: null,
      createdAt,
      createdBy: input.createdBy,
      expiresAt: new Date(createdAt.getTime() + configuredBootstrapEnrollmentLifetimeMs),
      id: input.id,
      idempotencyKey: "bootstrap-main",
      name: "Main computer",
      ownerKind: "deployment",
      ownerUserId: null,
      requestFingerprint: input.tokenHash,
      runnerId: null,
      runnerKind: "main",
      tokenHash: input.tokenHash,
    })
    .onConflict((conflict) => conflict.columns(["createdBy", "idempotencyKey"]).doNothing())
    .execute(databaseOperationOptions());
  const existing = await database
    .selectFrom("runnerEnrollments")
    .select([
      "deviceProfile",
      "allowedModules",
      "createdBy",
      "expiresAt",
      "name",
      "requestFingerprint",
      "runnerKind",
      "tokenHash",
    ])
    .where("createdBy", "=", input.createdBy)
    .where("idempotencyKey", "=", "bootstrap-main")
    .executeTakeFirstOrThrow(databaseOperationOptions());
  if (
    !sameStringSet(existing.allowedModules, input.allowedModules) ||
    existing.createdBy !== input.createdBy ||
    existing.expiresAt === null ||
    existing.name !== "Main computer" ||
    existing.requestFingerprint !== input.tokenHash ||
    existing.runnerKind !== "main" ||
    existing.tokenHash !== input.tokenHash
  ) {
    throw new OpensteerError({
      code: "conflict",
      message: "Bootstrap Runner enrollment is already bound to different configuration",
    });
  }
}

export async function createRunnerEnrollment(
  database: Kysely<DatabaseSchema>,
  input: {
    /**
     * The exact modules the computer redeeming this token may advertise.
     * Issuance chooses the grant; installing newer software cannot widen it.
     */
    readonly allowedModules: readonly RunnerModuleName[];
    /** Null when the deployment authored this enrollment for its own Main Runner. */
    readonly createdBy: UserId | null;
    readonly deviceProfile?: RunnerDeviceProfile;
    readonly expiresAt: Date;
    readonly id: string;
    readonly idempotencyKey: string;
    readonly mainEnrollmentPurpose?: "initial" | "replacement";
    readonly name: string;
    /**
     * The person whose work runs on a managed Runner. Administration stays
     * with the deployment (`ownerKind` is still 'deployment'), so this is only
     * an execution binding. Omitted for an admin-enrolled managed Runner, which
     * has no owning user and stays shared.
     */
    readonly ownerUserId?: UserId;
    readonly requestFingerprint: string;
    readonly runnerKind: "main" | "local" | "managed";
    readonly tokenHash: string;
  },
): Promise<RunnerEnrollmentIssuanceRecord> {
  return withDatabaseTransaction(database, async (transaction) => {
    if (input.ownerUserId && input.runnerKind !== "managed") {
      throw new OpensteerError({
        code: "bad_request",
        message: "Only a managed Runner enrollment may name an owning user",
      });
    }
    if (input.mainEnrollmentPurpose && input.runnerKind !== "main") {
      throw new OpensteerError({
        code: "bad_request",
        message: "Only a Main Runner can use a Main enrollment purpose",
      });
    }
    if (!input.mainEnrollmentPurpose && input.runnerKind === "main") {
      throw new OpensteerError({
        code: "bad_request",
        message: "Main Runner enrollment requires an explicit initial or replacement purpose",
      });
    }
    if (input.createdBy === null && input.runnerKind === "local") {
      // A local Runner belongs to whoever enrolled it, so an enrollment with
      // nobody to own it could never produce one.
      throw new OpensteerError({
        code: "bad_request",
        message: "A local Runner enrollment must name the person who authored it",
      });
    }
    if (input.mainEnrollmentPurpose) {
      await lockMainRunnerEnrollment(transaction);
    }
    // Before the idempotency lookup, so a replay of a request this Deployment
    // would no longer honour is refused rather than answered from the row it
    // once wrote.
    const allowedModules = input.allowedModules;
    await assertPersonalRunnerAdmission(transaction, {
      allowedModules,
      ownerKind: input.runnerKind === "local" ? "user" : "deployment",
      runnerKind: input.runnerKind,
      stage: "issuance",
    });
    // A local Runner is owned by whoever enrolled it; a managed one by the
    // user the attachment named, when there was one.
    const ownerUserId =
      input.runnerKind === "local" ? input.createdBy : (input.ownerUserId ?? null);
    const idempotencyLockKey = JSON.stringify([
      input.createdBy,
      "runner-enrollment-idempotency",
      input.idempotencyKey,
    ]);
    await sql`select pg_advisory_xact_lock(hashtextextended(${idempotencyLockKey}, 0))`.execute(
      transaction,
      databaseOperationOptions(),
    );
    const existing = await transaction
      .selectFrom("runnerEnrollments")
      .select([
        "deviceProfile",
        "allowedModules",
        "expiresAt",
        "id",
        "name",
        "ownerUserId",
        "requestFingerprint",
        "runnerKind",
        "tokenHash",
      ])
      // `= null` never matches, so a deployment-authored enrollment must be
      // looked up with `is null` or every replay would insert a duplicate.
      .where((expression) =>
        input.createdBy === null
          ? expression("createdBy", "is", null)
          : expression("createdBy", "=", input.createdBy),
      )
      .where("idempotencyKey", "=", input.idempotencyKey)
      .forNoKeyUpdate()
      .executeTakeFirst(databaseOperationOptions());
    if (existing) {
      if (
        existing.deviceProfile !== (input.deviceProfile ?? null) ||
        existing.requestFingerprint !== input.requestFingerprint ||
        existing.name !== input.name ||
        existing.runnerKind !== input.runnerKind ||
        existing.tokenHash !== input.tokenHash ||
        // A replay that names a different owner is a different request, not
        // the same one: re-binding a Runner to another person on replay would
        // hand them the credentials living inside it.
        existing.ownerUserId !== ownerUserId ||
        // A replay that asks for different modules is a different request:
        // honoring it would widen a grant that is supposed to be immutable.
        // The comparison is against the stored form of the request, which is
        // the asked-for set plus the modules every non-exact enrollment carries.
        !sameStringSet(existing.allowedModules, allowedModules) ||
        existing.expiresAt === null
      ) {
        throw new OpensteerError({
          code: "conflict",
          message: "Idempotency key is already bound to a different Runner enrollment request",
        });
      }
      return {
        deviceProfile: existing.deviceProfile,
        allowedModules: existing.allowedModules,
        expiresAt: existing.expiresAt,
        id: existing.id,
        runnerKind: existing.runnerKind,
        tokenHash: existing.tokenHash,
      };
    }
    if (input.mainEnrollmentPurpose) {
      const activeMain = await transaction
        .selectFrom("runners")
        .select("id")
        .where("ownerKind", "=", "deployment")
        .where("ownerUserId", "is", null)
        .where("kind", "=", "main")
        .where("revokedAt", "is", null)
        .executeTakeFirst(databaseOperationOptions());
      const revokedMain = await transaction
        .selectFrom("runners")
        .select("id")
        .where("ownerKind", "=", "deployment")
        .where("ownerUserId", "is", null)
        .where("kind", "=", "main")
        .where("revokedAt", "is not", null)
        .executeTakeFirst(databaseOperationOptions());
      const pendingMain = await transaction
        .selectFrom("runnerEnrollments")
        .select("id")
        .where("runnerKind", "=", "main")
        .where("ownerKind", "=", "deployment")
        .where("consumedAt", "is", null)
        .where("expiresAt", ">", new Date())
        .executeTakeFirst(databaseOperationOptions());
      if (input.mainEnrollmentPurpose === "initial") {
        if (activeMain || revokedMain) {
          throw new OpensteerError({
            code: "conflict",
            message: "Initial Main enrollment is unavailable after a Main has enrolled",
          });
        }
        if (pendingMain) {
          throw new OpensteerError({
            code: "conflict",
            message: "A Main Runner enrollment is already pending",
          });
        }
      } else {
        if (activeMain) {
          throw new OpensteerError({
            code: "conflict",
            message: "The active Main Runner must be revoked before replacement",
          });
        }
        if (!revokedMain) {
          throw new OpensteerError({
            code: "conflict",
            message: "There is no revoked Main Runner to replace",
          });
        }
        if (pendingMain) {
          throw new OpensteerError({
            code: "conflict",
            message: "A Main Runner enrollment is already pending",
          });
        }
      }
    }
    await transaction
      .insertInto("runnerEnrollments")
      .values({
        deviceProfile: input.deviceProfile ?? null,
        allowedModules: jsonValue(allowedModules),
        consumedAt: null,
        createdBy: input.createdBy,
        expiresAt: input.expiresAt,
        id: input.id,
        idempotencyKey: input.idempotencyKey,
        name: input.name,
        ownerKind: input.runnerKind === "local" ? "user" : "deployment",
        ownerUserId,
        requestFingerprint: input.requestFingerprint,
        runnerId: null,
        runnerKind: input.runnerKind,
        tokenHash: input.tokenHash,
      })
      .executeTakeFirstOrThrow(databaseOperationOptions());
    return {
      deviceProfile: input.deviceProfile ?? null,
      allowedModules,
      expiresAt: input.expiresAt,
      id: input.id,
      runnerKind: input.runnerKind,
      tokenHash: input.tokenHash,
    };
  });
}

/**
 * Makes a user's own enrollment unusable at once, or says why it already was.
 *
 * Retiring takes the same token and row locks as redemption, in the same
 * order, so the two serialize: either the Runner arrived first and this
 * answers `consumed`, or this moves the expiry to now and redemption refuses
 * the token as expired. The store keeps no mark of a retirement, so retiring
 * the same enrollment again answers `expired`; to every caller the two mean
 * the same thing, that nobody can redeem it.
 */
export async function retireRunnerEnrollment(
  database: Kysely<DatabaseSchema>,
  input: { readonly enrollmentId: string; readonly ownerId: UserId },
): Promise<"consumed" | "expired" | "retired"> {
  return withDatabaseTransaction(database, async (transaction) => {
    const identity = await transaction
      .selectFrom("runnerEnrollments")
      .select(["ownerKind", "ownerUserId", "tokenHash"])
      .where("id", "=", input.enrollmentId)
      .executeTakeFirst(databaseOperationOptions());
    // Someone else's enrollment is answered exactly like one that does not exist.
    if (!identity || identity.ownerKind !== "user" || identity.ownerUserId !== input.ownerId) {
      throw new OpensteerError({ code: "not_found", message: "Runner enrollment not found" });
    }
    await sql`select pg_advisory_xact_lock(hashtextextended(${identity.tokenHash}, 0))`.execute(
      transaction,
      databaseOperationOptions(),
    );
    const enrollment = await transaction
      .selectFrom("runnerEnrollments")
      .select(["consumedAt", "expiresAt", "runnerId"])
      .where("id", "=", input.enrollmentId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow(databaseOperationOptions());
    if (enrollment.consumedAt || enrollment.runnerId) return "consumed";
    const now = new Date();
    if (enrollment.expiresAt <= now) return "expired";
    await transaction
      .updateTable("runnerEnrollments")
      .set({ expiresAt: now })
      .where("id", "=", input.enrollmentId)
      .executeTakeFirstOrThrow(databaseOperationOptions());
    return "retired";
  });
}

export async function enrollRunnerConnection(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly descriptor: RunnerDescriptor;
    readonly enrollmentTokenHash: string;
    readonly publicKeyFingerprint: string;
    readonly publicKeyPem: string;
  },
): Promise<RunnerConnectionRecord> {
  return withDatabaseTransaction(database, async (transaction) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${input.enrollmentTokenHash}, 0))`.execute(
      transaction,
      databaseOperationOptions(),
    );
    const enrollmentIdentity = await transaction
      .selectFrom("runnerEnrollments")
      .select([
        "deviceProfile",
        "allowedModules",
        "createdBy",
        "name",
        "ownerKind",
        "ownerUserId",
        "runnerKind",
      ])
      .where("tokenHash", "=", input.enrollmentTokenHash)
      .executeTakeFirst(databaseOperationOptions());
    if (enrollmentIdentity) {
      const refusal = runnerDescriptorProfileRefusal(
        enrollmentIdentity.deviceProfile,
        input.descriptor,
      );
      if (refusal) throw new OpensteerError({ code: "forbidden", ...refusal });
    }
    if (!enrollmentIdentity || enrollmentIdentity.runnerKind !== input.descriptor.runnerKind) {
      throw new OpensteerError({ code: "forbidden", message: "Runner enrollment failed" });
    }
    if (enrollmentIdentity.runnerKind === "main") {
      await lockMainRunnerEnrollment(transaction);
    }
    const enrollment = await transaction
      .selectFrom("runnerEnrollments")
      .select([
        "deviceProfile",
        "allowedModules",
        "consumedAt",
        "createdBy",
        "expiresAt",
        "name",
        "ownerKind",
        "ownerUserId",
        "runnerId",
        "runnerKind",
      ])
      .where("tokenHash", "=", input.enrollmentTokenHash)
      .forNoKeyUpdate()
      .executeTakeFirst(databaseOperationOptions());
    if (
      !enrollment ||
      enrollment.createdBy !== enrollmentIdentity.createdBy ||
      enrollment.ownerKind !== enrollmentIdentity.ownerKind ||
      enrollment.ownerUserId !== enrollmentIdentity.ownerUserId ||
      enrollment.runnerKind !== enrollmentIdentity.runnerKind ||
      !sameStringSet(enrollment.allowedModules, enrollmentIdentity.allowedModules)
    ) {
      throw new OpensteerError({ code: "forbidden", message: "Runner enrollment failed" });
    }
    const profileRefusal = runnerDescriptorProfileRefusal(
      enrollment.deviceProfile,
      input.descriptor,
    );
    if (profileRefusal) throw new OpensteerError({ code: "forbidden", ...profileRefusal });
    assertModulesWithinGrant(input.descriptor, enrollment.allowedModules);
    const existing = enrollment.runnerId
      ? await transaction
          .selectFrom("runners")
          .select([
            "enrollmentTokenHash",
            "id",
            "kind",
            "ownerKind",
            "ownerUserId",
            "publicKeyFingerprint",
            "publicKeyPem",
            "revokedAt",
          ])
          .where("id", "=", enrollment.runnerId)
          .forNoKeyUpdate()
          .executeTakeFirst(databaseOperationOptions())
      : undefined;

    if (enrollment.consumedAt || enrollment.runnerId) {
      if (
        !existing ||
        existing.enrollmentTokenHash !== input.enrollmentTokenHash ||
        existing.id !== input.descriptor.runnerId ||
        existing.kind !== input.descriptor.runnerKind ||
        existing.ownerKind !== enrollment.ownerKind ||
        existing.ownerUserId !== enrollment.ownerUserId ||
        existing.publicKeyFingerprint !== input.publicKeyFingerprint ||
        existing.publicKeyPem !== input.publicKeyPem
      ) {
        throw new OpensteerError({
          code: "forbidden",
          message: "Runner enrollment token is already bound to another identity",
        });
      }
      if (existing.revokedAt) {
        throw new OpensteerError({
          code: "forbidden",
          message: "Runner is revoked",
          reason: runnerIdentityRevokedReason,
        });
      }
    } else {
      // Said apart from every other refusal of a token: an expired one will
      // never work again, so whoever is holding it has to mint another rather
      // than retry. It names nothing about the enrollment beyond that.
      if (enrollment.expiresAt <= new Date()) {
        throw new OpensteerError({
          code: "forbidden",
          message: "Runner enrollment expired",
          reason: runnerEnrollmentExpiredReason,
        });
      }
      // A fresh enrollment claiming a Runner id that some other enrollment
      // already consumed is the same denial as the replay branch above, and
      // it has to be answered here: without this the primary key raises and
      // the caller sees an internal error instead of a refusal.
      const claimed = await transaction
        .selectFrom("runners")
        .select("id")
        .where("id", "=", input.descriptor.runnerId)
        .forNoKeyUpdate()
        .executeTakeFirst(databaseOperationOptions());
      if (claimed) {
        throw new OpensteerError({
          code: "forbidden",
          message: "Runner enrollment token is already bound to another identity",
        });
      }
      await transaction
        .insertInto("runners")
        .values({
          accessPolicy: jsonValue(machineAccessPolicyDefault),
          accessPolicyRevision: 1,
          allowedModules: jsonValue(enrollment.allowedModules),
          capabilities: jsonValue(input.descriptor.capabilities),
          connectionGeneration: 0,
          deviceProfile: enrollment.deviceProfile,
          device: input.descriptor.device ? jsonValue(input.descriptor.device) : null,
          enrolledAt: new Date(),
          enrollmentTokenHash: input.enrollmentTokenHash,
          id: input.descriptor.runnerId,
          kind: input.descriptor.runnerKind,
          lastSeenAt: null,
          maxConcurrentRuns: input.descriptor.modules.agents?.maxConcurrentRuns ?? null,
          moduleDescriptors: jsonValue(input.descriptor.modules),
          name: enrollment.name,
          ownerKind: enrollment.ownerKind,
          ownerUserId: enrollment.ownerUserId,
          publicKeyFingerprint: input.publicKeyFingerprint,
          publicKeyPem: input.publicKeyPem,
          revokedAt: null,
        })
        .executeTakeFirstOrThrow(databaseOperationOptions());
      await transaction
        .updateTable("runnerEnrollments")
        .set({ consumedAt: new Date(), runnerId: input.descriptor.runnerId })
        .where("tokenHash", "=", input.enrollmentTokenHash)
        .where("consumedAt", "is", null)
        .executeTakeFirstOrThrow(databaseOperationOptions());
    }

    await bindRunnerEnvironments(transaction, input.descriptor, enrollment.name);
    return activateRunnerConnection(transaction, input.descriptor);
  });
}

export async function setRunnerShellFullDiskAccess(
  database: Kysely<DatabaseSchema>,
  runnerId: RunnerId,
  fullDiskAccess: boolean,
): Promise<boolean> {
  const result = await database
    .updateTable("runners")
    .set({
      moduleDescriptors: sql`jsonb_set(module_descriptors, '{shell,fullDiskAccess}', to_jsonb(${fullDiskAccess}::boolean))`,
    })
    .where("id", "=", runnerId)
    .where("revokedAt", "is", null)
    .where(sql<boolean>`module_descriptors ? 'shell'`)
    .executeTakeFirst(databaseOperationOptions());
  return result.numUpdatedRows > 0n;
}

export async function authenticateRunnerConnection(
  database: Kysely<DatabaseSchema>,
  descriptor: RunnerDescriptor,
): Promise<RunnerConnectionRecord> {
  return withDatabaseTransaction(database, async (transaction) =>
    activateRunnerConnection(transaction, descriptor),
  );
}

/** A rejected socket may only annotate the generation whose enrolled key it proved. */
export async function recordRunnerUpdateRequired(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly runnerId: RunnerId;
    readonly connectionGeneration: number;
    readonly reason: "agent-phone-outdated" | "runner-outdated";
  },
): Promise<boolean> {
  const result = await database
    .updateTable("runners")
    .set({ updateRequired: input.reason, updatedAt: new Date() })
    .where("id", "=", input.runnerId)
    .where("connectionGeneration", "=", String(input.connectionGeneration))
    .where("revokedAt", "is", null)
    .executeTakeFirst(databaseOperationOptions());
  return result.numUpdatedRows === 1n;
}

/**
 * The Personal route generation right now, for a caller holding the one it
 * was admitted under.
 *
 * One row, read outside any transaction on purpose: it is a fence, not a
 * lock. Every mode change bumps this and then sweeps the connected computers,
 * so a reader that sees the same number knows the sweep it would have been
 * caught by has not happened, and one that sees a different number knows it
 * missed that sweep and must not become a connection.
 */
export async function personalRemoteAccessGeneration(
  database: Kysely<DatabaseSchema>,
): Promise<number | null> {
  const row = await database
    .selectFrom("personalRemoteAccess")
    .select("generation")
    .where("singletonKey", "=", "personal")
    .executeTakeFirst(databaseOperationOptions());
  return row === undefined ? null : Number(row.generation);
}

export async function touchRunnerConnection(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly connectionGeneration: number;
    readonly runnerId: RunnerId;
  },
): Promise<boolean> {
  const seenAt = new Date();
  const result = await database
    .updateTable("runners")
    .set({ lastSeenAt: seenAt, updatedAt: seenAt })
    .where("id", "=", input.runnerId)
    .where("connectionGeneration", "=", String(input.connectionGeneration))
    .where("revokedAt", "is", null)
    .executeTakeFirst(databaseOperationOptions());
  return result.numUpdatedRows === 1n;
}
