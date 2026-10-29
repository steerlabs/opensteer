import { sql } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import * as connection from "./connection.js";
import { takeTransactionConflicts } from "./lock-order-checker.test-support.js";

const integration = process.env.OPENSTEER_TEST_DATABASE_URL ? describe : describe.skip;
integration("database-only transaction retry", () => {
  const database = connection.createDatabase({
    connectionString: process.env.OPENSTEER_TEST_DATABASE_URL ?? "postgres://unconfigured",
    maxConnections: 1,
  });
  afterAll(async () => {
    await database.destroy();
  });
  it.each(["40P01", "40001"])("retries %s and returns only committed events", async (code) => {
    await sql`create temporary table phase3m_retry (attempt integer)`.execute(database);
    let attempts = 0;
    try {
      const events = await connection.withDatabaseTransaction(database, async (transaction) => {
        attempts += 1;
        await sql`insert into phase3m_retry values (${attempts})`.execute(transaction);
        if (attempts < 3)
          await sql
            .raw(
              `do $$ begin raise exception 'injected conflict' using errcode = '${code}'; end $$`,
            )
            .execute(transaction);
        return [{ attempt: attempts }];
      });
      expect(attempts).toBe(3);
      expect(events).toEqual([{ attempt: 3 }]);
      expect(takeTransactionConflicts().map((conflict) => conflict.code)).toEqual([code, code]);
      expect((await sql`select * from phase3m_retry`.execute(database)).rows).toEqual([
        { attempt: 3 },
      ]);
    } finally {
      await sql`drop table phase3m_retry`.execute(database);
    }
  });
  it("retries a changed discovered fence set within the shared four-attempt budget", async () => {
    await sql`create temporary table phase3m_discovery (attempt integer)`.execute(database);
    const changed = new Error("Discovered authority changed before its fence");
    let attempts = 0;
    try {
      const committed = await connection.withDatabaseTransaction(
        database,
        async (transaction) => {
          attempts++;
          await sql`insert into phase3m_discovery values (${attempts})`.execute(transaction);
          if (attempts < 4) throw changed;
          return attempts;
        },
        undefined,
        (error: unknown) => error === changed,
      );
      expect(committed).toBe(4);
      expect((await sql`select * from phase3m_discovery`.execute(database)).rows).toEqual([
        { attempt: 4 },
      ]);
      attempts = 0;
      await expect(
        connection.withDatabaseTransaction(
          database,
          async () => {
            attempts++;
            throw changed;
          },
          undefined,
          (error: unknown) => error === changed,
        ),
      ).rejects.toBe(changed);
      expect(attempts).toBe(4);
    } finally {
      await sql`drop table phase3m_discovery`.execute(database);
    }
  });

  it("reports a lock scope that never settles as a conflict the caller may retry", async () => {
    let attempts = 0;
    await expect(
      connection.withDatabaseTransaction(
        database,
        async () => {
          attempts++;
          throw new connection.TransactionScopeChanged("Discovered rows changed before the fence");
        },
        undefined,
        (error: unknown) => error instanceof connection.TransactionScopeChanged,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(attempts).toBe(4);
  });

  it.each(["40P01", "40001", "23514"])("bounds retry of %s", async (code) => {
    let attempts = 0;
    await expect(
      connection.withDatabaseTransaction(database, async (transaction) => {
        attempts += 1;
        await sql
          .raw(`do $$ begin raise exception 'injected error' using errcode = '${code}'; end $$`)
          .execute(transaction);
      }),
    ).rejects.toMatchObject(
      // An exhausted conflict reaches the caller as one it may try again.
      code === "23514" ? { code } : { cause: { code }, code: "conflict", retryable: true },
    );
    expect(attempts).toBe(code === "23514" ? 1 : 4);
    expect(takeTransactionConflicts().map((conflict) => conflict.code)).toEqual(
      code === "23514" ? [] : [code, code, code, code],
    );
  });
});
