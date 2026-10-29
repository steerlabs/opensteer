import { fork } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import integration from "../vitest.integration.config.js";

// Failure cases: ctx.skip after a cleanup timeout bypasses the runner's final
// hook; retries re-enter fixtures; SIGKILL discards the original assertion;
// an unhealthy file admits a later fixture; a healthy file is falsely poisoned;
// non-isolated or non-fork integration workers retain poisoned module state.
const reportSchema = z.object({
  testResults: z.array(
    z.object({
      assertionResults: z.array(
        z.object({ title: z.string(), status: z.string(), failureMessages: z.array(z.string()) }),
      ),
    }),
  ),
});
const repository = resolve(import.meta.dirname, "..");

it("pins isolated fork files and forbids integration retries", () => {
  expect(integration.test?.pool).toBe("forks");
  expect(integration.test?.isolate).not.toBe(false);
  expect(integration.test?.retry).toBe(0);
});

it.for(["skip", "diagnostics", "timeout", "healthy", "expected-timeout"])(
  "preserves file results for %s",
  { timeout: 20_000 },
  async (scenario, context) => {
    const directory = await mkdtemp(join(tmpdir(), `opensteer-file-poison-${scenario}-`));
    const config = join(directory, "vitest.config.mts");
    await writeFile(
      config,
      `import config from ${JSON.stringify(join(repository, "vitest.config.ts"))};
export default { ...config, test: { ...config.test, setupFiles: [${JSON.stringify(join(repository, "packages/database/src/test-database-setup.test-support.ts"))}], include: [${JSON.stringify(join(repository, "packages/database/src/file-poison-fixtures/journey.test-support.ts"))}], maxWorkers: 1 } };\n`,
    );
    const chunks: Buffer[] = [];
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
          OPENSTEER_FILE_POISON_OUTPUT: directory,
          OPENSTEER_FILE_POISON_SCENARIO: scenario,
        },
        detached: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    child.stdout!.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr!.on("data", (chunk: Buffer) => chunks.push(chunk));
    const exited = new Promise<number | null>((resolveExit, reject) => {
      child.once("exit", resolveExit);
      child.once("error", reject);
    });
    context.onTestFinished(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        process.kill(-child.pid!, "SIGKILL");
        await exited;
      }
      await writeFile(join(directory, "run.log"), Buffer.concat(chunks).toString("utf8"));
    });
    const code = await exited;
    const log = Buffer.concat(chunks).toString("utf8");
    expect(code, log).toBe(["healthy", "expected-timeout"].includes(scenario) ? 0 : 1);
    const report = reportSchema.parse(
      JSON.parse(await readFile(join(directory, "tests.json"), "utf8")),
    );
    const tests = report.testResults.flatMap((file) => file.assertionResults);
    expect(tests, log).toHaveLength(2);
    if (["healthy", "expected-timeout"].includes(scenario)) {
      if (scenario === "expected-timeout")
        expect(await readFile(join(directory, "expected-abort"), "utf8")).toBe("true");
      expect(tests.map(({ status }) => status)).toEqual(["passed", "passed"]);
      expect(await readFile(join(directory, "fixture-entered"), "utf8")).toContain(
        "unsafe after contamination",
      );
    } else {
      const next = tests.find(({ title }) => title === "next-fixture")!;
      expect(next.status, log).toBe("failed");
      expect(next.failureMessages.join("\n"), log).toContain(
        "worker contaminated by poison-origin:",
      );
      expect(next.failureMessages.join("\n"), log).toContain(
        scenario === "timeout" ? "Test timed out" : "ORIGINAL_BODY_FAILURE_SENTINEL",
      );
      await expect(readFile(join(directory, "fixture-entered"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(log).not.toMatch(/worker.*exited unexpectedly/i);
      if (scenario === "diagnostics") {
        expect(
          tests.find(({ title }) => title === "poison-origin")!.failureMessages.join("\n"),
        ).toContain("ORIGINAL_BODY_FAILURE_SENTINEL");
        expect(log).toContain("CLEANUP_FAILURE_SENTINEL");
        expect(log).toContain("ORIGINAL_BODY_FAILURE_SENTINEL");
      }
    }
    console.info(`File containment evidence: ${directory}`);
  },
);

it.for([
  { label: "retry", override: "retry: 1", sentinel: "Integration retries must be 0" },
  {
    label: "isolation",
    override: "isolate: false",
    sentinel: "Integration databases require isolated forks",
  },
  {
    label: "pool",
    override: "pool: 'threads'",
    sentinel: "Integration databases require isolated forks",
  },
])(
  "rejects unsafe $label configuration before any database access",
  { timeout: 20_000 },
  async ({ label, override, sentinel }, context) => {
    const directory = await mkdtemp(join(tmpdir(), `opensteer-config-${label}-`));
    const config = join(directory, "vitest.config.mts");
    await writeFile(
      config,
      `import config from ${JSON.stringify(join(repository, "vitest.integration.config.ts"))};
export default { ...config, test: { ...config.test, ${override}, setupFiles: [], include: [${JSON.stringify(join(repository, "packages/database/src/file-poison-fixtures/journey.test-support.ts"))}], maxWorkers: 1 } };\n`,
    );
    const environment: NodeJS.ProcessEnv = { ...process.env, VITEST_MAX_WORKERS: "1" };
    delete environment.OPENSTEER_TEST_DATABASE_URL;
    delete environment.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL;
    const child = fork(
      join(repository, "node_modules/vitest/vitest.mjs"),
      ["run", "--config", config],
      {
        cwd: repository,
        env: environment,
        detached: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    const chunks: Buffer[] = [];
    child.stdout!.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr!.on("data", (chunk: Buffer) => chunks.push(chunk));
    const exited = new Promise<number | null>((resolveExit, reject) => {
      child.once("exit", resolveExit);
      child.once("error", reject);
    });
    context.onTestFinished(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        process.kill(-child.pid!, "SIGKILL");
        await exited;
      }
      await writeFile(join(directory, "run.log"), Buffer.concat(chunks).toString("utf8"));
    });
    expect(await exited).toBe(1);
    expect(Buffer.concat(chunks).toString("utf8")).toContain(sentinel);
  },
);
