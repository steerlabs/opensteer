import { setImmediate } from "node:timers/promises";
import { sql } from "kysely";
import { Pool, type PoolClient } from "pg";
import { expect, vi } from "vitest";
import { createDatabase } from "./connection.js";
import { describeStore } from "./store.integration.test-support.js";
import { ownTestDatabaseProducer } from "./test-database.test-support.js";

describeStore("the database driver", (it) => {
  it("handles PostgreSQL terminating a checked-out reader before its next query", async ({
    storeFixture,
  }) => {
    const { reader, pool } = await ownTestDatabaseProducer(storeFixture.databaseUrl, async () => {
      const pool = new Pool({ connectionString: storeFixture.databaseUrl });
      const reader = createDatabase({ connectionString: storeFixture.databaseUrl }, pool);
      return { reader, pool, close: () => reader.destroy() };
    });
    const ended = Promise.withResolvers<void>();
    const unhandled: unknown[] = [];
    pool.once("connect", (client) => {
      client.once("end", ended.resolve);
      const emit = client.emit.bind(client);
      vi.spyOn(client, "emit").mockImplementation((event, ...args) => {
        if (event === "error" && client.listenerCount("error") === 0) {
          unhandled.push(args[0]);
          return false;
        }
        return emit(event, ...args);
      });
    });
    await reader.connection().execute(async (connection) => {
      const { rows } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(
        connection,
      );
      const killed = await sql<{
        terminated: boolean;
      }>`select pg_terminate_backend(${rows[0]!.pid}) as terminated`.execute(storeFixture.database);
      expect(killed.rows).toEqual([{ terminated: true }]);
      await ended.promise;
      await expect(sql`select 1`.execute(connection)).rejects.toThrow();
    });
    expect(unhandled).toEqual([]);
  });

  it("drains a new checkout that reaches the driver while the pool is closing", async ({
    storeFixture,
  }) => {
    const { reader, pool } = await ownTestDatabaseProducer(storeFixture.databaseUrl, async () => {
      const pool = new Pool({ connectionString: storeFixture.databaseUrl, maxUses: 1 });
      const reader = createDatabase({ connectionString: storeFixture.databaseUrl }, pool);
      return { reader, pool, close: () => reader.destroy() };
    });
    await sql`select 1`.execute(reader);
    const checkedOut = Promise.withResolvers<PoolClient>();
    const deliverCheckout = Promise.withResolvers<void>();
    const connect = pool.connect.bind(pool);
    const heldConnect = async () => {
      const client = await connect();
      checkedOut.resolve(client);
      await deliverCheckout.promise;
      return client;
    };
    // pg types connect() with a callback overload that returns void; this is the promise form.
    const checkout = vi.spyOn(pool, "connect").mockImplementation(heldConnect as never);
    const read = sql<{ value: number }>`select 1 as value`.execute(reader);
    void read.catch(() => undefined);
    const client = await checkedOut.promise;
    const closing = reader.destroy();
    try {
      // Let destruction reach the driver before returning the new pg client.
      await setImmediate();
      deliverCheckout.resolve();
      await expect(read).resolves.toMatchObject({ rows: [{ value: 1 }] });
    } finally {
      deliverCheckout.resolve();
      checkout.mockRestore();
      await read.catch(() => {
        // Reclaim the fixture client if the driver rejected before taking ownership.
        if (pool.totalCount) client.release(true);
      });
      await closing;
    }
    expect(pool.totalCount).toBe(0);
  });
});
