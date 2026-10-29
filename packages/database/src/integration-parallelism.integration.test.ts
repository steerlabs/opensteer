import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { runParallelismFixture } from "./integration-parallelism-fixtures/run.test-support.js";

/*
 * Failure scenarios: destructive fixtures overlap; a cycle spans physical
 * databases; one file loses/corrupts its trace; setup fails halfway through;
 * cleanup drops caller-owned or another run's databases; a caught PostgreSQL
 * deadlock bypasses the conflict guard. Drive real Vitest
 * subprocesses and PostgreSQL so the pool, import timing and exit status count.
 */
const integration = process.env.OPENSTEER_TEST_DATABASE_URL ? describe : describe.skip;
const databaseReceipt = z.object({
  databases: z.array(
    z.object({ name: z.string(), authority: z.enum(["host", "controlPlane"]), server: z.string() }),
  ),
  cleaned: z.boolean(),
});
const fixtureReceipt = z.object({ host: z.string(), controlPlane: z.string(), slot: z.string() });

integration("parallel integration lifecycle", () => {
  const repository = resolve(import.meta.dirname, "../../..");
  const authorities = (
    [
      ["host", process.env.OPENSTEER_TEST_DATABASE_URL],
      ["controlPlane", process.env.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL],
    ] as const
  ).map(([authority, value]) => {
    const url = new URL(value ?? "postgres://unset");
    const callerDatabase = url.pathname.slice(1);
    url.pathname = "/postgres";
    return {
      authority,
      server: url.host,
      callerDatabase,
      maintenanceUrl: url,
      pool: new Pool({ connectionString: url.toString(), max: 1 }),
      sentinel: `opensteer_integration_other_${randomBytes(8).toString("hex")}`,
    };
  });
  let evidence: string;

  beforeAll(async () => {
    evidence = await mkdtemp(join(tmpdir(), "opensteer-parallel-integration-e2e-"));
    for (const { pool, sentinel } of authorities) {
      await pool.query(`create database ${sentinel}`);
    }
  });

  afterAll(async () => {
    for (const { pool, sentinel } of authorities) {
      try {
        await pool.query(`drop database if exists ${sentinel}`);
      } finally {
        await pool.end();
      }
    }
    console.info(`Parallel integration lifecycle evidence: ${evidence}`);
  });

  async function databases(pool: Pool): Promise<string[]> {
    const result = await pool.query<{ datname: string }>(
      "select datname from pg_database order by datname",
    );
    return result.rows.map(({ datname }) => datname);
  }

  async function journey(scenario: string, environment: NodeJS.ProcessEnv = {}) {
    const directory = join(evidence, scenario);
    await mkdir(directory);
    const config = join(directory, "vitest.config.mts");
    await writeFile(
      config,
      `import config from ${JSON.stringify(join(repository, "vitest.integration.config.ts"))};
export default { ...config, test: { ...config.test, include: [${JSON.stringify(join(import.meta.dirname, `integration-parallelism-fixtures/${scenario.startsWith("deadlock-") ? "deadlock" : "[abc]"}.test-support.ts`))}], maxWorkers: 2 } };\n`,
    );
    const before = await Promise.all(authorities.map(({ pool }) => databases(pool)));
    // The fixture config's maxWorkers sizes the slot databases this journey
    // counts; a caller's VITEST_MAX_WORKERS would override it.
    const inherited = { ...process.env };
    delete inherited.VITEST_MAX_WORKERS;
    const started = Date.now();
    const outcome = await runParallelismFixture(
      process.execPath,
      [
        join(repository, "node_modules/vitest/vitest.mjs"),
        "run",
        "--config",
        config,
        "--reporter=json",
        `--outputFile=${join(directory, "tests.json")}`,
      ],
      {
        cwd: repository,
        env: {
          ...inherited,
          OPENSTEER_LOCK_ORDER_TRACE: join(directory, "locks.jsonl"),
          OPENSTEER_PARALLELISM_FIXTURE_DIR: directory,
          OPENSTEER_PARALLELISM_FIXTURE_SCENARIO: scenario,
          ...environment,
        },
        outputFile: join(directory, "run.log"),
        timeoutMs: 20_000,
      },
    );
    const { code } = outcome;
    const elapsedMs = Date.now() - started;
    const log = await readFile(join(directory, "run.log"), "utf8");
    // A killed fixture cannot attest to teardown; preserve its outcome before
    // reading receipts that may be missing or still say cleaned=false.
    await writeFile(
      join(directory, "child.json"),
      JSON.stringify({ ...outcome, elapsedMs }, null, 2),
    );
    expect(
      outcome.timedOut,
      `Fixture ${scenario} exceeded its 20000 ms deadline; child group stopped. Evidence: ${directory}\n${log}`,
    ).toBe(false);
    expect(
      outcome.error,
      `Fixture ${scenario} did not finish: ${outcome.error ?? ""}. Evidence: ${directory}\n${log}`,
    ).toBeUndefined();
    const after = await Promise.all(authorities.map(({ pool }) => databases(pool)));
    const receipt = databaseReceipt.parse(
      JSON.parse(await readFile(join(directory, "locks.jsonl.databases.json"), "utf8")),
    );
    const catalogs = authorities.map(({ authority, server, callerDatabase, sentinel }, index) => ({
      authority,
      server,
      callerOwned: [sentinel, callerDatabase],
      created: receipt.databases
        .filter((entry) => entry.authority === authority && entry.server === server)
        .map(({ name }) => name),
      before: before[index]!,
      after: after[index]!,
    }));
    await writeFile(
      join(directory, "lifecycle.json"),
      JSON.stringify({ ...outcome, elapsedMs, authorities: catalogs }, null, 2),
    );
    for (const catalog of catalogs) {
      for (const name of catalog.callerOwned) {
        expect(catalog.before, log).toContain(name);
        expect(catalog.after, log).toContain(name);
      }
    }
    expect(receipt.cleaned, log).toBe(true);
    for (const { name, authority, server } of receipt.databases) {
      const catalog = catalogs.find(
        (entry) => entry.authority === authority && entry.server === server,
      );
      expect(catalog, log).toBeDefined();
      expect(catalog!.after, log).not.toContain(name);
    }
    return { code, directory, log };
  }

  it("isolates simultaneous truncation and preserves all caller-owned databases", async () => {
    const { code, directory, log } = await journey("clean");
    expect(code, log).toBe(0);
    const report = z
      .object({ numPendingTests: z.number().int().nonnegative() })
      .parse(JSON.parse(await readFile(join(directory, "tests.json"), "utf8")));
    expect(report.numPendingTests).toBe(1);
    const first = fixtureReceipt.parse(
      JSON.parse(await readFile(join(directory, "a.json"), "utf8")),
    );
    const second = fixtureReceipt.parse(
      JSON.parse(await readFile(join(directory, "b.json"), "utf8")),
    );
    expect(first.host).not.toBe(second.host);
    expect(first.controlPlane).not.toBe(second.controlPlane);
    expect(first.slot).not.toBe(second.slot);
  });

  it("checks preservation and cleanup on each authority's server", async () => {
    const { code, directory, log } = await journey("authority-catalogs");
    expect(code, log).toBe(0);
    const receipt = z
      .object({
        authorities: z.array(
          z.object({
            authority: z.enum(["host", "controlPlane"]),
            server: z.string(),
            callerOwned: z.array(z.string()),
            created: z.array(z.string()),
            before: z.array(z.string()),
            after: z.array(z.string()),
          }),
        ),
      })
      .parse(JSON.parse(await readFile(join(directory, "lifecycle.json"), "utf8")));
    expect(receipt.authorities.map(({ authority }) => authority)).toEqual(["host", "controlPlane"]);
    for (const catalog of receipt.authorities) {
      const source =
        catalog.authority === "host"
          ? process.env.OPENSTEER_TEST_DATABASE_URL!
          : process.env.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL!;
      expect(catalog.server).toBe(new URL(source).host);
      expect(catalog.callerOwned).toContain(new URL(source).pathname.slice(1));
      // One migrated run template plus the two worker databases, on each server.
      expect(catalog.created).toHaveLength(3);
      for (const name of catalog.callerOwned) {
        expect(catalog.before).toContain(name);
        expect(catalog.after).toContain(name);
      }
      for (const name of catalog.created) expect(catalog.after).not.toContain(name);
    }
  });

  it("preserves artifact evidence across overlapping runs and files", async () => {
    const coordination = join(evidence, "artifact-coordination");
    await mkdir(coordination);
    const overrides = Object.fromEntries(
      [
        "OPENSTEER_SHARED_BROWSER_E2E_ARTIFACT_DIR",
        "OPENSTEER_BROWSER_FOLLOW_E2E_ARTIFACT_DIR",
        "OPENSTEER_PROPOSAL_CREDENTIAL_ARTIFACT_DIR",
        "OPENSTEER_BROWSER_SOURCE_E2E_ARTIFACT_DIR",
        "OPENSTEER_STATE_IMPORT_E2E_ARTIFACT_DIR",
        "OPENSTEER_PASSKEY_POLICY_E2E_ARTIFACT_DIR",
        "OPENSTEER_CDP_BOUNDARY_E2E_ARTIFACT_DIR",
      ].map((key) => [key, undefined]),
    );
    const runs = await Promise.all(
      ["left", "right"].map((side) =>
        journey(`artifacts-${side}`, {
          ...overrides,
          OPENSTEER_PARALLELISM_ARTIFACT_COORDINATION: coordination,
          OPENSTEER_PARALLELISM_OVERRIDE_ARTIFACT_DIR: join(coordination, "directories"),
          OPENSTEER_PARALLELISM_OVERRIDE_ARTIFACT_PATH: join(coordination, "files", "report.json"),
        }),
      ),
    );
    const paths: string[] = [];
    for (const { code, directory, log } of runs) {
      expect(code, log).toBe(0);
      for (const label of ["a", "b"]) {
        const receipt = z
          .record(z.string(), z.string())
          .parse(JSON.parse(await readFile(join(directory, `${label}-artifacts.json`), "utf8")));
        paths.push(...Object.values(receipt));
      }
    }
    expect(paths).toHaveLength(36);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it.each(["host", "controlPlane"])("fails for a caught real deadlock on %s", async (authority) => {
    const { code, directory, log } = await journey(`deadlock-${authority}`);
    expect(code, log).toBe(1);
    const report = z
      .object({
        testResults: z.array(
          z.object({
            assertionResults: z.array(
              z.object({ status: z.string(), failureMessages: z.array(z.string()) }),
            ),
          }),
        ),
      })
      .parse(JSON.parse(await readFile(join(directory, "tests.json"), "utf8")));
    const tests = report.testResults.flatMap(({ assertionResults }) => assertionResults);
    expect(
      tests.map(({ status }) => status),
      log,
    ).toEqual(["failed"]);
    expect(tests[0]!.failureMessages.join("\n"), log).toContain(
      "Deadlocks or serialization failures, including retried ones",
    );
    expect(JSON.parse(await readFile(join(directory, "deadlock.json"), "utf8"))).toEqual([
      { code: "40P01", detail: expect.stringContaining("waits for") },
    ]);
  });

  /** Nested runs report through JSON only, so failure messages live in tests.json. */
  async function failureMessages(directory: string): Promise<string[]> {
    const report = z
      .object({
        testResults: z.array(
          z.object({
            assertionResults: z.array(z.object({ failureMessages: z.array(z.string()) })),
          }),
        ),
      })
      .parse(JSON.parse(await readFile(join(directory, "tests.json"), "utf8")));
    return report.testResults.flatMap(({ assertionResults }) =>
      assertionResults.flatMap(({ failureMessages }) => failureMessages),
    );
  }

  it("observes no lock order when unset, while enforcing rejects the same reversal", async () => {
    // Unset is off, the merge gates' mode.
    const off = await journey("reversal-default", { OPENSTEER_LOCK_ORDER_MODE: undefined });
    expect(off.code, off.log).toBe(0);
    expect(
      JSON.parse(await readFile(join(off.directory, "locks.jsonl.graph.json"), "utf8")),
    ).toMatchObject({ mode: "off", acquisitions: 0, signatures: 0, violations: 0, cycles: [] });
    const enforced = await journey("reversal-enforce", { OPENSTEER_LOCK_ORDER_MODE: "enforce" });
    expect(enforced.code, enforced.log).toBe(1);
    expect((await failureMessages(enforced.directory)).join("\n"), enforced.log).toMatch(
      /Database lock order: threads -> workspaces/u,
    );
  });

  it("still fails for a caught real deadlock when lock order is off", async () => {
    const { code, directory, log } = await journey("deadlock-host-default", {
      OPENSTEER_LOCK_ORDER_MODE: undefined,
    });
    expect(code, log).toBe(1);
    expect((await failureMessages(directory)).join("\n"), log).toContain(
      "Deadlocks or serialization failures, including retried ones",
    );
    expect(JSON.parse(await readFile(join(directory, "deadlock.json"), "utf8"))).toEqual([
      { code: "40P01", detail: expect.stringContaining("waits for") },
    ]);
  });

  it("fails for a cycle present only in the union of two workers", async () => {
    const { code, log } = await journey("cycle");
    expect(code, log).toBe(1);
    expect(log).toMatch(/1 conflicting cycle witnesses/u);
  });

  it.each(["missing", "malformed"])("fails closed for a %s file trace", async (scenario) => {
    const { code, log } = await journey(scenario);
    expect(code, log).toBe(1);
    expect(log).toMatch(/trace/iu);
  });

  it("removes already-created databases when provisioning the second authority fails", async () => {
    const restricted = new URL(authorities[1]!.maintenanceUrl);
    restricted.username = `parallel_missing_${randomBytes(8).toString("hex")}`;
    restricted.password = "fixture";
    const { code, log } = await journey("provisioning-failure", {
      OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL: restricted.toString(),
    });
    expect(code, log).toBe(1);
    expect(log).toMatch(/password authentication failed|role .* does not exist/u);
  });
});
