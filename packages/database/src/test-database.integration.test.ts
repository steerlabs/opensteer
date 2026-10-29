import { fork } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect, createServer, type Socket } from "node:net";
import { Pool } from "pg";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { templateDatabasePool } from "./test-database-admin.test-support.js";

const heldBodySchema = z.object({
  url: z.url(),
  workerPid: z.number().int().positive(),
  producerPid: z.number().int().positive(),
  queryBlocked: z.literal(true),
});

// Failure cases: live template connections prevent cloning; a template contains
// deployment identity; clones share writes; a timed-out body reconnects to the
// next fixture; sessions/processes survive cleanup; failed cleanup reuses a worker.
const integration = process.env.OPENSTEER_TEST_DATABASE_URL ? describe : describe.skip;

integration("run-owned database templates", () => {
  it("waits for template pool connections to close before proceeding", async () => {
    const source = new URL(process.env.OPENSTEER_TEST_DATABASE_URL!);
    const sockets = new Set<Socket>();
    let holdClose!: () => void;
    const closeHeld = new Promise<void>((resolve) => (holdClose = resolve));
    let releaseClose!: () => void;
    let holdWrites = false;
    const proxy = createServer({ allowHalfOpen: true }, (client) => {
      const upstream = connect({
        host: source.hostname,
        port: Number(source.port || 5432),
        allowHalfOpen: true,
      });
      sockets.add(client);
      sockets.add(upstream);
      const pending: Buffer[] = [];
      client.on("data", (data) => {
        if (holdWrites) pending.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
        else upstream.write(data);
      });
      client.on("end", () => {
        if (holdWrites) {
          releaseClose = () => {
            holdWrites = false;
            upstream.end(Buffer.concat(pending));
          };
          holdClose();
        } else upstream.end();
      });
      upstream.on("data", (data) => client.write(data));
      upstream.on("end", () => client.end());
      client.on("error", () => {});
      upstream.on("error", () => {});
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("Proxy has no TCP address");
    const proxyUrl = new URL(source);
    proxyUrl.hostname = "127.0.0.1";
    proxyUrl.port = String(address.port);
    const template = templateDatabasePool(proxyUrl.toString());
    const observer = new Pool({ connectionString: process.env.OPENSTEER_TEST_DATABASE_URL });
    let closing: Promise<void> | undefined;
    try {
      const result = await template.pool.query<{ pid: number }>("select pg_backend_pid() as pid");
      const pid = result.rows[0]!.pid;
      let closed = false;
      holdWrites = true;
      closing = template
        .close(() => template.pool.end())
        .then(() => {
          closed = true;
        });
      await closeHeld;
      expect(
        (await observer.query("select 1 from pg_stat_activity where pid = $1", [pid])).rowCount,
      ).toBe(1);
      expect(closed).toBe(false);
      releaseClose();
      releaseClose = () => {};
      await closing;
      expect(
        (await observer.query("select 1 from pg_stat_activity where pid = $1", [pid])).rowCount,
      ).toBe(0);
    } finally {
      closing ??= template.close(() => template.pool.end());
      releaseClose?.();
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        new Promise<void>((resolve) => proxy.close(() => resolve())),
        closing,
        observer.end(),
      ]);
    }
  });

  it.each(["host", "controlPlane"] as const)(
    "clones a migrated, identity-free %s template",
    async (authority) => {
      // Keep timeout regression selectable on the pre-implementation checkpoint.
      const { cloneTestDatabase }: typeof import("./test-database.test-support.js") = await import(
        new URL("./test-database.test-support.ts", import.meta.url).href
      );
      const first = await cloneTestDatabase(authority);
      const second = await cloneTestDatabase(authority);
      expect(Object.isFrozen(first)).toBe(true);
      expect(first.url).not.toBe(second.url);
      const pools = [first, second].map(({ url }) => new Pool({ connectionString: url, max: 1 }));
      try {
        for (const pool of pools) {
          expect((await pool.query("select * from kysely_migration")).rowCount).toBeGreaterThan(0);
          expect(
            (await pool.query("select extname from pg_extension where extname = 'pgrowlocks'"))
              .rows,
          ).toEqual([{ extname: "pgrowlocks" }]);
          expect((await pool.query("select * from deployments")).rows).toEqual([]);
        }
        await pools[0]!.query("create table clone_sentinel (value text)");
        expect(
          (await pools[1]!.query("select to_regclass('clone_sentinel') as name")).rows,
        ).toEqual([{ name: null }]);
      } finally {
        await Promise.all(pools.map((pool) => pool.end()));
        await Promise.all([first.drop(), second.drop()]);
      }
    },
  );

  it.each(["timeout", "cleanup-failure", "corrupt-template"])(
    "contains %s in a real Vitest worker",
    async (scenario) => {
      const directory = await mkdtemp(join(tmpdir(), `opensteer-db-${scenario}-`));
      const repository = resolve(import.meta.dirname, "../../..");
      const config = join(directory, "vitest.config.mts");
      await writeFile(
        config,
        `import config from ${JSON.stringify(join(repository, "vitest.integration.config.ts"))};
export default { ...config, test: { ...config.test, ${scenario === "corrupt-template" ? `globalSetup: [${JSON.stringify(join(import.meta.dirname, "test-database-fixtures/corrupt-template.test-support.ts"))}],` : ""} include: [${JSON.stringify(join(repository, "apps/host/src/runtime/test-database-containment.test-support.ts"))}], maxWorkers: 1 } };\n`,
      );
      const output: Buffer[] = [];
      const child = fork(
        join(repository, "node_modules/vitest/vitest.mjs"),
        [
          "run",
          "--config",
          config,
          "--reporter=default",
          "--reporter=json",
          `--outputFile=${join(directory, "tests.json")}`,
        ],
        {
          cwd: repository,
          env: {
            ...process.env,
            VITEST_MAX_WORKERS: "1",
            OPENSTEER_DATABASE_CONTAINMENT_SCENARIO: scenario,
            OPENSTEER_DATABASE_CONTAINMENT_OUTPUT: directory,
            OPENSTEER_LOCK_ORDER_TRACE: join(directory, "locks.jsonl"),
          },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
          detached: process.platform !== "win32",
        },
      );
      child.stdout!.on("data", (chunk: Buffer) => output.push(chunk));
      child.stderr!.on("data", (chunk: Buffer) => output.push(chunk));
      const exit = new Promise<number | null>((resolveExit, reject) => {
        child.once("error", reject);
        child.once("exit", resolveExit);
      });
      const close = async () => {
        if (child.exitCode === null && child.signalCode === null) {
          if (process.platform === "win32") child.kill("SIGKILL");
          else {
            try {
              process.kill(-child.pid!, "SIGKILL");
            } catch (error) {
              if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
                throw error;
            }
          }
          await exit;
        }
        await writeFile(join(directory, "run.log"), Buffer.concat(output).toString("utf8"));
      };
      onTestFinished(close);
      try {
        const code = await exit;
        const log = Buffer.concat(output).toString("utf8");
        await writeFile(join(directory, "run.log"), log);
        expect(code, log).toBe(1);
        if (scenario === "timeout") {
          expect(log).toMatch(/timed out/i);
          expect(log).toContain(
            "worker contaminated by holds its body and a query beyond the timeout:",
          );
          expect(log).not.toMatch(/worker.*exited unexpectedly/i);
          const report = z
            .object({
              testResults: z.array(
                z.object({
                  assertionResults: z.array(
                    z.object({
                      status: z.string(),
                      failureMessages: z.array(z.string()),
                      meta: z.object({ originalFailure: z.string().optional() }),
                    }),
                  ),
                }),
              ),
            })
            .parse(JSON.parse(await readFile(join(directory, "tests.json"), "utf8")));
          const results = report.testResults.flatMap((file) => file.assertionResults);
          expect(results.map(({ status }) => status)).toEqual(["failed", "failed"]);
          expect(results[0]!.meta.originalFailure).toMatch(/Test timed out/);
          await expect(readFile(join(directory, "later-fixture-entered"))).rejects.toMatchObject({
            code: "ENOENT",
          });
          const old = heldBodySchema.parse(
            JSON.parse(await readFile(join(directory, "first-test.json"), "utf8")),
          );
          expect(() => process.kill(old.workerPid, 0)).toThrowError(
            expect.objectContaining({ code: "ESRCH" }),
          );
          expect(() => process.kill(old.producerPid, 0)).toThrowError(
            expect.objectContaining({ code: "ESRCH" }),
          );
          const { cloneTestDatabase } = await import("./test-database.test-support.js");
          const next = await cloneTestDatabase("host");
          const pool = new Pool({ connectionString: next.url, max: 1 });
          try {
            await pool.query("create table containment_sentinel (value text)");
            await pool.query("insert into containment_sentinel values ('next')");
            const oldName = new URL(old.url).pathname.slice(1);
            const oldSessions = (
              await pool.query<{ count: number }>(
                "select count(*)::int as count from pg_stat_activity where datname = $1",
                [oldName],
              )
            ).rows[0]!.count;
            const oldDatabaseExists =
              (await pool.query("select 1 from pg_database where datname = $1", [oldName]))
                .rowCount !== 0;
            const rows = (await pool.query("select * from containment_sentinel")).rows;
            expect(rows).toEqual([{ value: "next" }]);
            expect(oldSessions).toBe(0);
            expect(oldDatabaseExists).toBe(false);
            await writeFile(
              join(directory, "containment.json"),
              JSON.stringify(
                {
                  untouched: true,
                  filePoisoned: true,
                  producerAlive: false,
                  oldSessions,
                  oldDatabaseExists,
                  queryBlocked: old.queryBlocked,
                  events: [
                    "file-poisoned",
                    "later-fixture-refused",
                    "file-cleanup-drained-body",
                    "isolated-next-fixture-started",
                  ],
                },
                null,
                2,
              ),
            );
          } finally {
            await pool.end();
            await next.drop();
          }
        } else if (scenario === "cleanup-failure") {
          expect(log).toContain("Database fixture containment failed");
          expect(await readFile(join(directory, "cleanup-attempted"), "utf8")).toBe("complete");
          await expect(readFile(join(directory, "later-fixture-entered"))).rejects.toMatchObject({
            code: "ENOENT",
          });
        } else {
          expect(log).toContain("Database migration failed");
          await expect(readFile(join(directory, "body-started"))).rejects.toMatchObject({
            code: "ENOENT",
          });
          expect(
            JSON.parse(await readFile(join(directory, "locks.jsonl.databases.json"), "utf8")),
          ).toMatchObject({ cleaned: true });
        }
        console.info(`Database containment evidence: ${directory}`);
      } finally {
        await close();
      }
    },
  );
});
