import { sql, type QueryResult } from "kysely";
import { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { createDatabase, withDatabaseTransaction } from "./connection.js";
import { databaseOperationOptions, withDatabaseOperationSignal } from "./operation-budget.js";
import { describeStore } from "./store.integration.test-support.js";
import { ownTestDatabaseProducer } from "./test-database.test-support.js";

describeStore("automatic database operation budgets", (it) => {
  for (const ending of ["abort", "deadline", "explicit options"] as const) {
    it(`cancels a locking read on ${ending} and returns its checkout`, async ({ storeFixture }) => {
      const f = await storeFixture.createRunFixture("operation-read");
      const { database } = await ownTestDatabaseProducer(storeFixture.databaseUrl, async () => {
        const database = createDatabase({
          connectionString: storeFixture.databaseUrl,
          applicationName: "operation-budget-read",
          maxConnections: 1,
        });
        return { database, close: () => database.destroy() };
      });
      const locked = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const blocker = storeFixture.database.transaction().execute(async (tx) => {
        await tx
          .selectFrom("threads")
          .select("id")
          .where("id", "=", f.thread.id)
          .forUpdate()
          .execute();
        locked.resolve();
        await withTimeout(release.promise, 3000, {
          timeoutError: () => new Error("Read blocker was not released"),
        });
      });
      void blocker.catch(locked.reject);
      const controller = new AbortController();
      const reason = new Error("Read cancelled");
      let reading: Promise<unknown> | undefined;
      try {
        await withTimeout(locked.promise, 1000, {
          timeoutError: () => new Error("Thread row was not locked"),
        });
        reading = withDatabaseOperationSignal(
          controller.signal,
          Date.now() + (ending === "deadline" ? 100 : 2000),
          () =>
            database
              .withSchema("public")
              .selectFrom("threads")
              .select("id")
              .where("id", "=", f.thread.id)
              .forUpdate()
              .execute(ending === "explicit options" ? databaseOperationOptions() : undefined),
        );
        const rejected = expect(
          withTimeout(reading, 1000, {
            timeoutError: () => new Error("Locking read ignored its operation budget"),
          }),
        ).rejects;
        if (ending !== "deadline") {
          await vi.waitFor(
            async () => {
              const { rows } = await sql<{
                count: number;
              }>`select count(*)::int as count from pg_stat_activity
              where application_name = 'operation-budget-read' and wait_event_type = 'Lock'`.execute(
                storeFixture.database,
              );
              expect(rows[0]?.count, "Read never reached the row lock").toBe(1);
            },
            { timeout: 500 },
          );
          controller.abort(reason);
          await rejected.toBe(reason);
        } else {
          await rejected.toMatchObject({ name: "TimeoutError" });
          expect(controller.signal.aborted).toBe(false);
        }
        expect(
          (
            await withTimeout(sql`select 1 as alive`.execute(database), 500, {
              timeoutError: () => new Error("Cancelled read retained the only checkout"),
            })
          ).rows,
        ).toEqual([{ alive: 1 }]);
      } finally {
        release.resolve();
        await withTimeout(Promise.all([blocker, reading?.catch(() => undefined)]), 1000, {
          timeoutError: () => new Error("Read did not release its database checkout"),
        });
      }
    });
  }

  for (const lifecycle of ["direct transaction", "controlled transaction", "reserved connection"]) {
    it(`leaves a ${lifecycle} in charge of its running query after abort`, async ({
      storeFixture,
    }) => {
      const f = await storeFixture.createRunFixture("operation-single-connection");
      const { database, pool } = await ownTestDatabaseProducer(
        storeFixture.databaseUrl,
        async () => {
          const pool = new Pool({
            connectionString: storeFixture.databaseUrl,
            application_name: "operation-budget-single-connection",
            max: 1,
          });
          const database = createDatabase({ connectionString: storeFixture.databaseUrl }, pool);
          return { database, pool, close: () => database.destroy() };
        },
      );
      const locked = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const blocker = storeFixture.database.transaction().execute(async (tx) => {
        await tx
          .selectFrom("threads")
          .select("id")
          .where("id", "=", f.thread.id)
          .forUpdate()
          .execute();
        locked.resolve();
        await withTimeout(release.promise, 3000, {
          timeoutError: () => new Error("Single-connection blocker was not released"),
        });
      });
      void blocker.catch(locked.reject);
      const controller = new AbortController();
      let querySettled = false;
      const read = async (connection: typeof database) => {
        try {
          return await connection
            .withSchema("public")
            .selectFrom("threads")
            .select("id")
            .where("id", "=", f.thread.id)
            .forUpdate()
            .execute();
        } finally {
          querySettled = true;
        }
      };
      let reading: Promise<unknown> | undefined;
      let nextCheckout: Promise<QueryResult<{ alive: number }>> | undefined;
      try {
        await withTimeout(locked.promise, 1000, {
          timeoutError: () => new Error("Thread row was not locked"),
        });
        reading = withDatabaseOperationSignal(controller.signal, Date.now() + 2000, async () => {
          if (lifecycle === "direct transaction") return database.transaction().execute(read);
          if (lifecycle === "reserved connection") return database.connection().execute(read);
          const transaction = await database.startTransaction().execute();
          try {
            return await read(transaction);
          } finally {
            await transaction.rollback().execute();
          }
        });
        void reading.catch(() => undefined);
        await vi.waitFor(
          async () => {
            const { rows } = await sql<{ count: number }>`
              select count(*)::int as count from pg_stat_activity
              where application_name = 'operation-budget-single-connection'
                and wait_event_type = 'Lock'
            `.execute(storeFixture.database);
            expect(rows[0]?.count, "Single-connection query never reached the row lock").toBe(1);
          },
          { timeout: 500 },
        );
        controller.abort(new Error("Operation cancelled"));
        const activity = await withTimeout(
          sql<{ count: number }>`
            select count(*)::int as count from pg_stat_activity
            where application_name = 'operation-budget-single-connection' and state = 'active'
          `.execute(storeFixture.database),
          500,
          { timeoutError: () => new Error("Could not observe the aborted operation's backend") },
        );
        expect(querySettled, "Query settled before its connection owner finished it").toBe(false);
        expect(activity.rows).toEqual([{ count: 1 }]);
        expect(pool.idleCount, "Running query was returned to the pool").toBe(0);

        nextCheckout = sql<{ alive: number }>`select 1 as alive`.execute(database);
        release.resolve();
        await expect(
          withTimeout(reading, 1000, {
            timeoutError: () => new Error("Single-connection query did not finish after unlock"),
          }),
        ).resolves.toEqual([{ id: f.thread.id }]);
        expect(
          (
            await withTimeout(nextCheckout, 500, {
              timeoutError: () => new Error("Single-connection query retained the only checkout"),
            })
          ).rows,
        ).toEqual([{ alive: 1 }]);
        expect(
          (
            await sql<{ count: number }>`
              select count(*)::int as count from pg_stat_activity
              where application_name = 'operation-budget-single-connection' and state <> 'idle'
            `.execute(storeFixture.database)
          ).rows,
        ).toEqual([{ count: 0 }]);
      } finally {
        release.resolve();
        nextCheckout ??= sql<{ alive: number }>`select 1 as alive`.execute(database);
        await withTimeout(
          Promise.all([
            blocker,
            reading?.catch(() => undefined),
            nextCheckout?.catch(() => undefined),
          ]),
          1000,
          {
            timeoutError: () =>
              new Error("Single-connection operation did not release its checkout"),
          },
        );
      }
    });
  }
});

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
      await withTimeout(poolHeld.promise, 500, {
        timeoutError: () => new Error("Fixture did not acquire the only checkout"),
      });
      for (const transactional of [false, true]) {
        await expect(
          withTimeout(
            withDatabaseOperationSignal(AbortSignal.timeout(100), Date.now() + 100, async () => {
              if (transactional) {
                await withDatabaseTransaction(database, async (tx) => {
                  await sql`select 1`.execute(tx, databaseOperationOptions());
                });
              } else {
                await sql`select 1`.execute(database.withoutPlugins());
              }
            }),
            1000,
            { timeoutError: () => new Error("Pool acquisition ignored operation deadline") },
          ),
        ).rejects.toMatchObject({ name: "TimeoutError" });
      }
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
