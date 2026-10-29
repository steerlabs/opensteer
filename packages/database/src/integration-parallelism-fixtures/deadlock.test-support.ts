import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";

const pool = new Pool({
  connectionString: process.env.OPENSTEER_PARALLELISM_FIXTURE_SCENARIO?.startsWith("deadlock-host")
    ? process.env.OPENSTEER_TEST_DATABASE_URL
    : process.env.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL,
});

beforeAll(async () => {
  await pool.query("create table fixture_deadlock_a (value text)");
  await pool.query("create table fixture_deadlock_b (value text)");
});
afterAll(async () => {
  await pool.end();
});

it("catches a real deadlock without claiming the conflict", async () => {
  const first = await pool.connect();
  const second = await pool.connect();
  const conflicts: { code: string; detail: string }[] = [];
  try {
    for (const client of [first, second]) {
      await client.query("set statement_timeout = '5s'");
      await client.query("begin");
    }
    await first.query("lock table fixture_deadlock_a in access exclusive mode");
    await second.query("lock table fixture_deadlock_b in access exclusive mode");
    await Promise.all(
      (
        [
          [first, "fixture_deadlock_b"],
          [second, "fixture_deadlock_a"],
        ] as const
      ).map(async ([client, table]) => {
        try {
          await client.query(`lock table ${table} in access exclusive mode`);
        } catch (error) {
          conflicts.push(z.object({ code: z.string(), detail: z.string() }).parse(error));
          await client.query("rollback");
        }
      }),
    );
    writeFileSync(
      join(process.env.OPENSTEER_PARALLELISM_FIXTURE_DIR!, "deadlock.json"),
      JSON.stringify(conflicts, null, 2),
    );
    expect(conflicts).toEqual([{ code: "40P01", detail: expect.stringContaining("waits for") }]);
  } finally {
    for (const client of [first, second]) {
      await client.query("rollback");
      client.release();
    }
  }
});
