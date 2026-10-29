import { assertIntegrationTestConfig } from "./integration-config.test-support.js";
import { writeFileSync } from "node:fs";
import type { TestProject } from "vitest/node";
import setupLockOrder from "./lock-order-global-setup.test-support.js";
import { recordTeardown } from "./run-record.test-support.js";
import {
  createTestDatabaseRun,
  ownedDatabases,
  type TestDatabaseRun,
} from "./test-database-admin.test-support.js";

export interface IntegrationDatabasePair {
  readonly host: string;
  readonly controlPlane: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    integrationDatabases: readonly IntegrationDatabasePair[];
  }
}

export default async function setup(
  project: TestProject,
  options: Parameters<typeof createTestDatabaseRun>[1] = {},
) {
  assertIntegrationTestConfig(project.config);
  const host = process.env.OPENSTEER_TEST_DATABASE_URL;
  const controlPlane = process.env.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL;
  if (!host || !controlPlane)
    throw new Error("Integration tests require both Host and Control Plane database URLs.");
  const urls = { host, controlPlane };
  const teardownLocks = setupLockOrder(project);
  const evidence = process.env.OPENSTEER_LOCK_ORDER_TRACE! + ".databases.json";
  let templates: TestDatabaseRun | undefined;
  let databases: Awaited<ReturnType<typeof createTestDatabaseRun>> | undefined;

  function writeEvidence(cleaned: boolean): void {
    writeFileSync(
      evidence,
      JSON.stringify(
        {
          run: templates?.run,
          databases: templates
            ? ownedDatabases(templates).map(({ name, authority }) => ({
                name,
                authority,
                server: new URL(urls[authority]).host,
              }))
            : [],
          cleaned,
        },
        null,
        2,
      ) + "\n",
    );
  }
  try {
    databases = await createTestDatabaseRun(urls, {
      ...options,
      recorded: (run) => {
        templates = run;
        writeEvidence(false);
      },
      cleaned: writeEvidence,
    });
    // Passed through the environment so real child processes use this run's
    // templates too; a nested Vitest invocation provisions its own run.
    process.env.OPENSTEER_TEST_DATABASE_TEMPLATES = JSON.stringify(databases.templates);
    const pairs: IntegrationDatabasePair[] = [];
    for (let slot = 1; slot <= project.config.maxWorkers; slot++) {
      const pair = {} as { host: string; controlPlane: string };
      for (const authority of ["host", "controlPlane"] as const) {
        const name = `opensteer_it_${databases.templates.run}_${authority === "host" ? "host" : "control"}_${slot}`;
        pair[authority] = await databases.create(
          authority,
          name,
          new URL(databases.templates[authority]).pathname.slice(1),
        );
      }
      pairs.push(pair);
    }
    project.provide("integrationDatabases", pairs);
  } catch (error) {
    try {
      await databases?.cleanup();
    } catch (cleanupError) {
      writeEvidence(false);
      throw new AggregateError(
        [error, cleanupError],
        "Integration database setup and cleanup failed",
      );
    }
    throw error;
  }
  return () =>
    recordTeardown(async () => {
      const failures: unknown[] = [];
      try {
        await teardownLocks();
      } catch (error) {
        failures.push(error);
      }
      try {
        await databases!.cleanup();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length) {
        process.exitCode = 1;
        if (failures.length === 1) throw failures[0];
        throw new AggregateError(failures, "Integration teardown failed");
      }
    });
}
