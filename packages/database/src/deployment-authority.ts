import { OpensteerError } from "@opensteer/core";
import type { Kysely } from "kysely";
import { checkoutSession } from "./connection.js";
import type { DatabaseSchema } from "./schema.js";

export interface DeploymentAuthorityLease {
  /**
   * Settles if the lock's session ends before `close()`. The Host then no
   * longer fences its Deployment database and must stop.
   */
  readonly lost: Promise<Error>;
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
  const session = await checkoutSession(database);
  let state: "held" | "lost" | "closed" = "held";
  let resolveLost!: (error: Error) => void;
  const lost = new Promise<Error>((resolve) => {
    resolveLost = resolve;
  });
  const end = (error?: unknown) => {
    if (state !== "held") return;
    state = "lost";
    resolveLost(
      error instanceof Error ? error : new Error("The Deployment authority session ended"),
    );
  };
  const ended = () => end();
  session.on("error", end);
  session.on("end", ended);
  const release = (error?: Error) => {
    session.off("error", end);
    session.off("end", ended);
    session.release(error);
  };

  let locked: boolean;
  try {
    const result = await session.query<{ locked: boolean }>(
      "select pg_try_advisory_lock(hashtextextended($1, 0)) as locked",
      [key],
    );
    locked = result.rows[0]?.locked === true;
  } catch (error) {
    release(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
  if (!locked) {
    release();
    throw new OpensteerError({
      code: "conflict",
      message: "Another Host process already owns this Deployment database",
    });
  }

  let closing: Promise<void> | undefined;
  return {
    lost,
    close: () =>
      (closing ??= (async () => {
        if (state === "lost") {
          state = "closed";
          release(await lost);
          return;
        }
        state = "closed";
        try {
          await session.query("select pg_advisory_unlock(hashtextextended($1, 0))", [key]);
        } catch (error) {
          release(error instanceof Error ? error : new Error(String(error)));
          throw error;
        }
        release();
      })()),
  };
}
