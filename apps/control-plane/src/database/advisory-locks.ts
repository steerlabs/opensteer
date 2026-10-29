import { sql, type Kysely, type Transaction } from "kysely";
import type { DeploymentId } from "@opensteer/core";
import type { ControlPlaneDatabaseSchema } from "./schema.js";

/**
 * Every advisory-lock key the control plane derives lives here so two writers
 * of the same resource can never disagree about the string, the classifier, or
 * the order. `account-deployment-capacity.ts` documents the global acquisition
 * order these participate in.
 */

type Executor = Kysely<ControlPlaneDatabaseSchema> | Transaction<ControlPlaneDatabaseSchema>;

/** Serializes Deployment-identity acquisition (registration, adoption, activation). */
export async function lockDeploymentIdentity(
  transaction: Transaction<ControlPlaneDatabaseSchema>,
  deploymentId: DeploymentId,
): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${deploymentId}, 0))`.execute(
    transaction,
  );
}

/** Serializes canonical-origin acquisition across every hosting kind. */
export async function lockDeploymentOrigin(
  transaction: Transaction<ControlPlaneDatabaseSchema>,
  canonicalOrigin: string,
): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${canonicalOrigin}, 1))`.execute(
    transaction,
  );
}

/**
 * Identity of the pinned Connect session lock. `connect-lifecycle.ts` holds it
 * at session scope across a provider call; anything that must observe a settled
 * Connect resource takes the same key at transaction scope.
 */
export function connectSessionLockIdentity(deploymentId: DeploymentId): string {
  return `opensteer-connect:${deploymentId}`;
}

/** Session-scoped Connect lock spanning a provider call and its committed result. */
export async function acquireConnectSessionLock(
  database: Executor,
  deploymentId: DeploymentId,
): Promise<void> {
  const identity = connectSessionLockIdentity(deploymentId);
  await sql`select pg_advisory_lock(hashtextextended(${identity}, 0))`.execute(database);
}

/** Releases the session-scoped Connect lock, reporting whether it was held. */
export async function releaseConnectSessionLock(
  database: Executor,
  deploymentId: DeploymentId,
): Promise<boolean> {
  const identity = connectSessionLockIdentity(deploymentId);
  const result = await sql<{ readonly unlocked: boolean }>`
    select pg_advisory_unlock(hashtextextended(${identity}, 0)) as unlocked
  `.execute(database);
  return result.rows[0]?.unlocked === true;
}

/**
 * Transaction-scoped hold of the same Connect session lock. A reader that must
 * see a settled Connect resource waits behind any in-flight provider call
 * instead of racing a half-applied provision.
 */
export async function lockConnectSession(
  transaction: Transaction<ControlPlaneDatabaseSchema>,
  deploymentId: DeploymentId,
): Promise<void> {
  const identity = connectSessionLockIdentity(deploymentId);
  await sql`select pg_advisory_xact_lock(hashtextextended(${identity}, 0))`.execute(transaction);
}

/** Cloud intent and provider effects share one pinned session lock across replicas. */
export async function withCloudOperationLock<T>(
  database: Kysely<ControlPlaneDatabaseSchema>,
  operationId: string,
  action: (connection: Kysely<ControlPlaneDatabaseSchema>) => Promise<T>,
): Promise<T> {
  return database.connection().execute(async (connection) => {
    const identity = `opensteer-cloud:${operationId}`;
    await sql`select pg_advisory_lock(hashtextextended(${identity}, 0))`.execute(connection);
    try {
      return await action(connection);
    } finally {
      await sql`select pg_advisory_unlock(hashtextextended(${identity}, 0))`.execute(connection);
    }
  });
}
