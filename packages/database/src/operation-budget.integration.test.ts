import { sql } from "kysely";
import { expect, it } from "vitest";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { createDatabase, withDatabaseTransaction } from "./connection.js";
import { databaseOperationOptions, withDatabaseOperationSignal } from "./operation-budget.js";

it("cancels a database lock and an exhausted pool without retaining a checkout", async () => {
  const database = createDatabase({
    connectionString: process.env.OPENSTEER_TEST_DATABASE_URL!,
    maxConnections: 1,
  });
  const blocker = createDatabase({
    connectionString: process.env.OPENSTEER_TEST_DATABASE_URL!,
    maxConnections: 1,
  });
  const lockHeld = Promise.withResolvers<void>(),
    releaseLock = Promise.withResolvers<void>();
  const held = blocker.connection().execute(async (connection) => {
    await sql`select pg_advisory_lock(9302505)`.execute(connection);
    lockHeld.resolve();
    try {
      await withTimeout(releaseLock.promise, 4000, {
        timeoutError: () => new Error("Test did not release blocker"),
      });
    } finally {
      await sql`select pg_advisory_unlock(9302505)`.execute(connection);
    }
  });
  void held.catch(() => undefined);
  try {
    await withTimeout(lockHeld.promise, 1000, {
      timeoutError: () => new Error("Fixture did not hold lock"),
    });
    const budget = AbortSignal.timeout(100);
    await expect(
      withTimeout(
        withDatabaseOperationSignal(budget, Date.now() + 100, () =>
          withDatabaseTransaction(database, async (tx) => {
            await sql`select pg_advisory_xact_lock(9302505)`.execute(
              tx,
              databaseOperationOptions(),
            );
          }),
        ),
        1500,
        { timeoutError: () => new Error("Database lock ignored operation deadline") },
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(
      (
        await withTimeout(sql`select 1 as alive`.execute(database), 500, {
          timeoutError: () => new Error("Lock cancellation retained checkout"),
        })
      ).rows,
    ).toEqual([{ alive: 1 }]);
    const poolHeld = Promise.withResolvers<void>(),
      releasePool = Promise.withResolvers<void>();
    const checkout = database.connection().execute(async () => {
      poolHeld.resolve();
      await withTimeout(releasePool.promise, 2000, {
        timeoutError: () => new Error("Test did not return checkout"),
      });
    });
    try {
      await poolHeld.promise;
      await expect(
        withTimeout(
          withDatabaseOperationSignal(AbortSignal.timeout(100), Date.now() + 100, () =>
            withDatabaseTransaction(database, async (tx) => {
              await sql`select 1`.execute(tx, databaseOperationOptions());
            }),
          ),
          1000,
          { timeoutError: () => new Error("Pool acquisition ignored operation deadline") },
        ),
      ).rejects.toMatchObject({ name: "TimeoutError" });
    } finally {
      releasePool.resolve();
      await checkout;
    }
    expect((await sql`select 2 as alive`.execute(database)).rows).toEqual([{ alive: 2 }]);
  } finally {
    releaseLock.resolve();
    await held.catch(() => undefined);
    await database.destroy();
    await blocker.destroy();
  }
});
