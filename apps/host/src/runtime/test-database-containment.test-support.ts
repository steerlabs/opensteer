import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { afterAll, expect, it } from "vitest";
import { createMachineAccessDatabase } from "./machine-access.test-support.js";

declare module "vitest" {
  interface TaskMeta {
    originalFailure?: string;
  }
}

const directory = process.env.OPENSTEER_DATABASE_CONTAINMENT_OUTPUT!;
const failedCleanup = process.env.OPENSTEER_DATABASE_CONTAINMENT_SCENARIO === "cleanup-failure";
// Deliberately reproduce the legacy suite pattern: the old body reads `stack`
// after its await, rather than retaining an immutable fixture reference.
let stack: Pool;
let bodyHeld = false;
async function released(): Promise<void> {
  for (;;) {
    try {
      await readFile(join(directory, "release-old-body"));
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await delay(10);
  }
}
const fallbacks: (() => Promise<void>)[] = [];
afterAll(async () => {
  await writeFile(join(directory, "release-old-body"), "released after later tests were refused");
  if (bodyHeld) await lateResult.promise;
  for (const stop of fallbacks.toReversed()) await stop();
});
const lateResult = Promise.withResolvers<{
  url: string;
  pid: number;
  lateWriteRejected: boolean;
  blockedQueryRejected: boolean;
}>();

it("holds its body and a query beyond the timeout", { timeout: 1_000 }, async (context) => {
  // Registered first, so this runs after a later clone cleanup fails. Retirement
  // must still allow every registered cleanup to make its attempt.
  context.onTestFinished(async () => {
    // Vitest's JSON reporter prefers its synthetic timeout stack over this message.
    const originalFailure = context.task.result?.errors?.[0]?.message;
    if (originalFailure !== undefined) context.task.meta.originalFailure = originalFailure;
    await writeFile(join(directory, "cleanup-attempted"), "complete");
  });
  await writeFile(join(directory, "body-started"), "started");
  const producer = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  const exited = new Promise<void>((resolve) => producer.once("exit", () => resolve()));
  const stopProducer = async () => {
    producer.kill("SIGKILL");
    await exited;
  };
  fallbacks.push(stopProducer);
  const database = await createMachineAccessDatabase(process.env.OPENSTEER_TEST_DATABASE_URL!, {
    stopProducers: async () => {
      await stopProducer();
      if (failedCleanup) throw new Error("injected producer cleanup failure");
    },
  });
  fallbacks.push(database.drop);
  const pool = new Pool({ connectionString: database.url, max: 1 });
  stack = pool;
  pool.on("error", () => undefined);
  await pool.query("create table containment_sentinel (value text)");
  const query = pool.query("select pg_advisory_lock(987654321)").then(
    () => false,
    () => true,
  );
  // The pool's single connection already owns this lock; use a second session
  // to block deterministically and prove the query really reached PostgreSQL.
  const waiter = new Pool({ connectionString: database.url, max: 1 });
  waiter.on("error", () => undefined);
  await query;
  const blocked = waiter.query("select pg_advisory_lock(987654321)").then(
    () => false,
    () => true,
  );
  await expect
    .poll(async () => {
      const admin = new Pool({
        connectionString: process.env.OPENSTEER_TEST_DATABASE_URL!,
        max: 1,
      });
      try {
        return (
          await admin.query(
            "select count(*)::int as count from pg_stat_activity where datname = $1 and wait_event = 'advisory'",
            [new URL(database.url).pathname.slice(1)],
          )
        ).rows[0].count;
      } finally {
        await admin.end();
      }
    })
    .toBe(1);
  await writeFile(
    join(directory, "first-test.json"),
    JSON.stringify({
      url: database.url,
      workerPid: process.pid,
      producerPid: producer.pid,
      queryBlocked: true,
    }),
  );
  // This variant finishes its body normally: failed cleanup alone must retire
  // the worker, after the remaining registered cleanup has been attempted.
  if (failedCleanup) return;
  bodyHeld = true;
  await released();
  const lateWriteRejected = await stack
    .query("insert into containment_sentinel values ('leaked')")
    .then(
      () => false,
      () => true,
    );
  await Promise.all([pool.end(), waiter.end()]);
  lateResult.resolve({
    url: database.url,
    pid: producer.pid!,
    lateWriteRejected,
    blockedQueryRejected: await blocked,
  });
});

it("must fail before entering another fixture after contamination", async () => {
  await writeFile(join(directory, "later-fixture-entered"), "unsafe");
  if (failedCleanup) {
    return;
  }
  const database = await createMachineAccessDatabase(process.env.OPENSTEER_TEST_DATABASE_URL!);
  const pool = new Pool({ connectionString: database.url, max: 1 });
  stack = pool;
  try {
    await pool.query("create table containment_sentinel (value text)");
    await pool.query("insert into containment_sentinel values ('next')");
    await writeFile(join(directory, "release-old-body"), "released after rebind");
    const old = await lateResult.promise;
    const oldName = new URL(old.url).pathname.slice(1);
    const oldSessions = (
      await pool.query("select count(*)::int as count from pg_stat_activity where datname = $1", [
        oldName,
      ])
    ).rows[0].count;
    const oldDatabaseExists =
      (await pool.query("select 1 from pg_database where datname = $1", [oldName])).rowCount !== 0;
    let producerAlive = true;
    try {
      process.kill(old.pid, 0);
    } catch {
      producerAlive = false;
    }
    const rows = (await pool.query("select * from containment_sentinel")).rows;
    const receipt = {
      untouched: JSON.stringify(rows) === JSON.stringify([{ value: "next" }]),
      oldDatabaseExists,
      oldSessions,
      producerAlive,
      lateWriteRejected: old.lateWriteRejected,
      blockedQueryRejected: old.blockedQueryRejected,
    };
    await writeFile(join(directory, "containment.json"), JSON.stringify(receipt, null, 2));
    expect(receipt).toEqual({
      untouched: true,
      oldDatabaseExists: false,
      oldSessions: 0,
      producerAlive: false,
      lateWriteRejected: true,
      blockedQueryRejected: true,
    });
  } finally {
    await writeFile(join(directory, "release-old-body"), "released in cleanup");
    await pool.end();
    await database.drop();
  }
});
