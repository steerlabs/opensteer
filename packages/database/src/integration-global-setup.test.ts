import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestProject } from "vitest/node";
import setup from "./integration-global-setup.test-support.js";

const pg = vi.hoisted(() => ({ endFails: false }));
vi.mock("./test-database-admin.test-support.js", () => ({
  createTestDatabaseRun: async () => ({
    templates: {
      run: "0000000000000000",
      host: "postgres://fixture/host_template",
      controlPlane: "postgres://fixture/control_template",
    },
    create: async (_authority: string, name: string) => `postgres://fixture/${name}`,
    cleanup: async () => {
      if (pg.endFails) throw new Error("pool end failed");
    },
  }),
  ownedDatabases: () => [],
}));

/*
 * Ways the integration teardown can let a broken run exit 0, because Vitest
 * reports a global teardown error without failing the process:
 * - database cleanup throws outside the drop failures it already reports;
 * - the lock-order teardown throws before it judges the graph (see
 *   lock-order-global-setup.test.ts).
 */
describe("integration database teardown", () => {
  const names = [
    "OPENSTEER_TEST_DATABASE_URL",
    "OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL",
    "OPENSTEER_TEST_DATABASE_TEMPLATES",
    "OPENSTEER_LOCK_ORDER_TRACE",
    "OPENSTEER_LOCK_ORDER_TRACE_DIRECTORY",
    "OPENSTEER_LOCK_ORDER_MODE",
  ] as const;
  const inherited = Object.fromEntries(names.map((name) => [name, process.env[name]]));

  beforeEach(() => {
    for (const name of names) delete process.env[name];
    process.env.OPENSTEER_TEST_DATABASE_URL = "postgres://test:test@127.0.0.1:1/opensteer";
    process.env.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL =
      "postgres://test:test@127.0.0.1:1/opensteer_control_plane";
  });

  afterEach(() => {
    pg.endFails = false;
    process.exitCode = undefined;
    for (const name of names) {
      if (inherited[name] === undefined) delete process.env[name];
      else process.env[name] = inherited[name];
    }
  });

  it("fails the process when database cleanup throws", async () => {
    const project = {
      config: { maxWorkers: 1, pool: "forks", isolate: true, retry: 0 },
      provide: () => {},
      vitest: { state: { getFilepaths: () => [] } },
    } as unknown as TestProject;
    const teardown = await setup(project);
    // A complete, acyclic lock trace: only cleanup fails.
    writeFileSync(
      join(process.env.OPENSTEER_LOCK_ORDER_TRACE_DIRECTORY!, "worker-1.jsonl"),
      [
        { type: "file-start", file: "/fixture.ts", worker: "1" },
        { type: "file-end", file: "/fixture.ts", worker: "1" },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
    );
    pg.endFails = true;

    await expect(teardown()).rejects.toThrow("pool end failed");
    expect(process.exitCode).toBe(1);
  });
});
