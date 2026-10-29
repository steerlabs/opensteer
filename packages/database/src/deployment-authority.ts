import { OpensteerError } from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";

export interface DeploymentAuthorityLease {
  close(): Promise<void>;
}

/**
 * Holds one PostgreSQL session lock for the lifetime of a running Host. This
 * fences two Host processes that point at the same live Deployment database
 * without keeping a transaction open.
 */
export async function acquireDeploymentAuthorityLease(
  database: Kysely<DatabaseSchema>,
): Promise<DeploymentAuthorityLease> {
  // One Host database contains exactly one Deployment. A database-scoped key
  // can therefore fence startup before the schema or Deployment row exists.
  const key = "opensteer-deployment-authority";
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let resolveAcquired!: (acquired: boolean) => void;
  let rejectAcquired!: (error: unknown) => void;
  const acquired = new Promise<boolean>((resolve, reject) => {
    resolveAcquired = resolve;
    rejectAcquired = reject;
  });
  let acquisitionSettled = false;
  const task = database.connection().execute(async (connection) => {
    let locked = false;
    try {
      const result = await sql<{ locked: boolean }>`
        select pg_try_advisory_lock(hashtextextended(${key}, 0)) as locked
      `.execute(connection);
      locked = result.rows[0]?.locked === true;
      acquisitionSettled = true;
      resolveAcquired(locked);
      if (locked) await released;
    } catch (error) {
      if (!acquisitionSettled) {
        acquisitionSettled = true;
        rejectAcquired(error);
      }
      throw error;
    } finally {
      if (locked) {
        await sql`select pg_advisory_unlock(hashtextextended(${key}, 0))`.execute(connection);
      }
    }
  });
  // The lease object owns the task rejection once acquisition has succeeded.
  void task.catch(() => undefined);

  if (!(await acquired)) {
    await task;
    throw new OpensteerError({
      code: "conflict",
      message: "Another Host process already owns this Deployment database",
    });
  }

  let closed = false;
  return {
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      release();
      await task;
    },
  };
}
