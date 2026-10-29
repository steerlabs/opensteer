import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { Client, Pool } from "pg";
import { afterAll, expect, it } from "vitest";

// Capture at import time, just like the application's integration fixtures.
const hostUrl = process.env.OPENSTEER_TEST_DATABASE_URL!;
const controlPlaneUrl = process.env.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL!;
const directory = process.env.OPENSTEER_PARALLELISM_FIXTURE_DIR!;
const scenario = process.env.OPENSTEER_PARALLELISM_FIXTURE_SCENARIO;

export function databaseJourney(label: string): void {
  it("keeps overlapping destructive fixtures isolated before module imports", async () => {
    for (const [kind, connectionString] of [
      ["host", hostUrl],
      ["control", controlPlaneUrl],
    ]) {
      const pool = new Pool({ connectionString, max: 1 });
      try {
        await pool.query("create table if not exists parallel_sentinel (label text primary key)");
        await pool.query("truncate parallel_sentinel");
        await pool.query("insert into parallel_sentinel values ($1)", [label]);
        writeFileSync(join(directory, `${kind}-${label}.ready`), "");
        await expect
          .poll(
            async () => {
              try {
                await access(join(directory, `${kind}-${label === "a" ? "b" : "a"}.ready`));
                return true;
              } catch {
                return false;
              }
            },
            { timeout: 10_000 },
          )
          .toBe(true);
        expect(
          (await pool.query<{ label: string }>("select label from parallel_sentinel")).rows,
        ).toEqual([{ label }]);
      } finally {
        await pool.end();
      }
    }
    writeFileSync(
      join(directory, `${label}.json`),
      JSON.stringify({
        host: new URL(hostUrl).pathname,
        controlPlane: new URL(controlPlaneUrl).pathname,
        slot: process.env.VITEST_POOL_ID,
      }),
    );
    if (scenario === "cycle") {
      const from = label === "a" ? "workspaces" : "threads";
      const to = label === "a" ? "threads" : "workspaces";
      appendFileSync(
        process.env.OPENSTEER_LOCK_ORDER_TRACE!,
        JSON.stringify({
          database: new URL(hostUrl).pathname.slice(1),
          from,
          to,
          type: "edge",
          heldKey: "held",
          requestedKey: "requested",
          heldMode: "NO KEY UPDATE",
          requestedMode: "NO KEY UPDATE",
          previous: `select 1 from ${from} for no key update`,
          statement: `select 1 from ${to} for no key update`,
          previousStack: "application (first.ts:1:1)",
          stack: "application (second.ts:1:1)",
        }) + "\n",
      );
    }
    if (scenario?.startsWith("reversal") && label === "a") {
      // A real reversed acquisition: Threads ranks after Workspaces.
      const client = new Client({ connectionString: hostUrl });
      await client.connect();
      try {
        await client.query("create temporary table workspaces (id text primary key)");
        await client.query("create temporary table threads (id text primary key)");
        await client.query("insert into workspaces values ('w')");
        await client.query("insert into threads values ('t')");
        await client.query("begin");
        await client.query("select * from threads for no key update");
        await client.query("select * from workspaces for no key update");
        await client.query("commit");
      } finally {
        await client.end();
      }
    }
  });

  afterAll(() => {
    if (label !== "a") return;
    if (scenario === "missing") rmSync(process.env.OPENSTEER_LOCK_ORDER_TRACE!);
    if (scenario === "malformed")
      appendFileSync(process.env.OPENSTEER_LOCK_ORDER_TRACE!, "{broken\n");
  });
}
