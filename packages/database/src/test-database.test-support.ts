import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { TestRunner, type TestContext } from "vitest";
import { withTimeout } from "@opensteer/shared/withTimeout";
import {
  databaseAdministrator,
  databaseUrl,
  dropOwnedDatabase,
  recordOwnedDatabase,
  testDatabaseRunSchema,
  type TestDatabaseAuthority,
} from "./test-database-admin.test-support.js";
import {
  failDatabaseContainment,
  ownTestDatabaseFile,
} from "./test-database-worker.test-support.js";
export { failDatabaseContainment } from "./test-database-worker.test-support.js";

export interface TestDatabase {
  readonly url: string;
  readonly drop: () => Promise<void>;
}

interface DatabaseOwner {
  readonly stops: (() => Promise<void>)[];
  closed: boolean;
}
const producers = new Map<string, DatabaseOwner>();

export function recordTestDatabaseSetup(task: TestContext["task"], started: number): void {
  const output = process.env.OPENSTEER_STORE_SETUP_TIMINGS;
  if (output)
    appendFileSync(
      output,
      JSON.stringify({
        file: task.file.filepath,
        test: task.name,
        setupMs: performance.now() - started,
      }) + "\n",
    );
}

/** Register before starting async work, so timeout also owns partial startup. */
export async function ownTestDatabaseProducer<Value extends { close(): Promise<void> }>(
  url: string,
  start: () => Promise<Value>,
): Promise<Value> {
  const context = TestRunner.getCurrentTest()?.context;
  ownTestDatabaseFile(context);
  context?.signal.throwIfAborted();
  const owner = producers.get(url);
  if (owner?.closed) throw new Error("Database fixture is already closed");
  const starting = start();
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= starting.then(
      (value) => value.close(),
      () => undefined,
    ));
  owner?.stops.push(stop);
  context?.onTestFinished(async () => {
    try {
      await withTimeout(stop(), 10_000, {
        timeoutError: () => new Error("Database producer startup/shutdown did not finish"),
      });
    } catch (error) {
      failDatabaseContainment(error);
    }
  });
  const value = await starting;
  if (context?.signal.aborted || owner?.closed) {
    await stop();
    throw new Error("Database fixture closed during producer startup");
  }
  return { ...value, close: stop };
}

/** Each returned URL is permanently bound to one clone, including after timeout. */
export async function cloneTestDatabase(
  authority: TestDatabaseAuthority,
  options: {
    readonly stopProducers?: () => Promise<void>;
    readonly producerTimeoutMs?: number;
    readonly serverUrl?: string;
  } = {},
): Promise<TestDatabase> {
  const context = TestRunner.getCurrentTest()?.context;
  ownTestDatabaseFile(context);
  context?.signal.throwIfAborted();
  const run = testDatabaseRunSchema.parse(
    JSON.parse(process.env.OPENSTEER_TEST_DATABASE_TEMPLATES ?? "null"),
  );
  const templateUrl = run[authority];
  if (options.serverUrl && new URL(options.serverUrl).host !== new URL(templateUrl).host)
    throw new Error("Fixture server does not match its run-owned template");
  const template = new URL(templateUrl).pathname.slice(1);
  const name = `opensteer_it_${run.run}_${authority === "host" ? "host" : "control"}_clone_${randomBytes(8).toString("hex")}`;
  const url = databaseUrl(templateUrl, name);
  const owner: DatabaseOwner = { stops: [], closed: false };
  producers.set(url, owner);
  const administrator = databaseAdministrator(templateUrl);
  let creating: Promise<unknown>;
  let allocated = false;
  let dropping: Promise<void> | undefined;
  const drop = () =>
    (dropping ??= (async () => {
      owner.closed = true;
      const failures: unknown[] = [];
      try {
        // Failed CREATE is still followed by a catalog check and cleanup.
        await creating.catch(() => undefined);
        try {
          await withTimeout(
            (async () => {
              const failures: unknown[] = [];
              for (const stop of allocated
                ? [options.stopProducers, ...owner.stops.toReversed()]
                : []) {
                try {
                  await stop?.();
                } catch (error) {
                  failures.push(error);
                }
              }
              if (failures.length)
                throw new AggregateError(failures, "Database producers did not stop");
            })(),
            options.producerTimeoutMs ?? 10_000,
            { timeoutError: () => new Error(`Producers of ${name} did not stop`) },
          );
        } catch (error) {
          failures.push(error);
        }
        try {
          await dropOwnedDatabase(administrator, name);
        } catch (error) {
          failures.push(error);
        }
      } catch (error) {
        failures.push(error);
      } finally {
        try {
          await administrator.end();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length)
        failDatabaseContainment(new AggregateError(failures, `Could not contain ${name}`));
    })());
  context?.onTestFinished(drop);
  recordOwnedDatabase(run, authority, name);
  creating = administrator.query(`create database "${name}" template "${template}"`);
  try {
    await creating;
    allocated = true;
  } catch (error) {
    await drop();
    throw error;
  }
  if (context?.signal.aborted) {
    await drop();
    context.signal.throwIfAborted();
  }
  return Object.freeze({ url, drop });
}
