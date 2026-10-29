import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TestProject } from "vitest/node";
import type { LockOrderEdge } from "./lock-order-checker.test-support.js";
import setup from "./lock-order-global-setup.test-support.js";

/*
 * Ways the whole-suite lock check can let a bad graph through:
 * - a conflicting cycle across files is found but the run still exits 0,
 *   because Vitest reports a teardown error without failing the process;
 * - a violation that reached only the trace (caught by application code after
 *   a file's last test) is counted but does not fail the run;
 * - a passing run deletes the summary it is meant to leave as evidence;
 * - the teardown itself throws (say, it cannot read the traces or write the
 *   summary) before it judges the graph, and the run still exits 0.
 */
describe("whole-suite lock graph teardown", () => {
  const inheritedTrace = process.env.OPENSTEER_LOCK_ORDER_TRACE;
  const inheritedDirectory = process.env.OPENSTEER_LOCK_ORDER_TRACE_DIRECTORY;
  const inheritedMode = process.env.OPENSTEER_LOCK_ORDER_MODE;

  beforeEach(() => {
    delete process.env.OPENSTEER_LOCK_ORDER_TRACE;
    // The full integration run's enforcing teardown; unset is off.
    process.env.OPENSTEER_LOCK_ORDER_MODE = "enforce";
    delete process.env.OPENSTEER_LOCK_ORDER_TRACE_DIRECTORY;
  });

  afterEach(() => {
    process.exitCode = undefined;
    if (inheritedTrace === undefined) delete process.env.OPENSTEER_LOCK_ORDER_TRACE;
    else process.env.OPENSTEER_LOCK_ORDER_TRACE = inheritedTrace;
    if (inheritedDirectory === undefined) delete process.env.OPENSTEER_LOCK_ORDER_TRACE_DIRECTORY;
    else process.env.OPENSTEER_LOCK_ORDER_TRACE_DIRECTORY = inheritedDirectory;
    if (inheritedMode === undefined) delete process.env.OPENSTEER_LOCK_ORDER_MODE;
    else process.env.OPENSTEER_LOCK_ORDER_MODE = inheritedMode;
  });

  function edge(from: string, to: string): LockOrderEdge {
    return {
      database: "opensteer_test",
      from,
      heldKey: '["held"]',
      heldMode: "NO KEY UPDATE",
      previous: `select 1 from "${from}" for no key update`,
      previousStack: "Error: Lock acquisition\n    at application (store.ts:1:1)",
      requestedKey: '["requested"]',
      requestedMode: "NO KEY UPDATE",
      stack: "Error: Lock acquisition\n    at application (store.ts:2:1)",
      statement: `select 1 from "${to}" for no key update`,
      to,
      type: "edge",
    };
  }

  function seeded(lines: readonly unknown[]): { teardown: () => Promise<void>; trace: string } {
    const teardown = setup();
    const trace = process.env.OPENSTEER_LOCK_ORDER_TRACE!;
    writeFileSync(
      join(process.env.OPENSTEER_LOCK_ORDER_TRACE_DIRECTORY!, "worker-1.jsonl"),
      [
        { type: "file-start", file: "/fixture.ts", worker: "1" },
        ...lines,
        { type: "file-end", file: "/fixture.ts", worker: "1" },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
    );
    return { teardown, trace };
  }

  it("fails the process when two transactions lock the same tables in opposite orders", async () => {
    const { teardown, trace } = seeded([
      edge("workspaces", "threads"),
      edge("threads", "workspaces"),
    ]);

    await expect(teardown()).rejects.toThrow(/1 conflicting cycle witnesses|conflicting cycle/u);
    expect(process.exitCode).toBe(1);
    expect(existsSync(trace + ".graph.json")).toBe(true);
  });

  it("fails the process for a violation that only reached the trace", async () => {
    const { teardown } = seeded([{ message: "threads -> workspaces", type: "violation" }]);

    await expect(teardown()).rejects.toThrow(/1 rank\/order violations/u);
    expect(process.exitCode).toBe(1);
  });

  it("keeps the summary and drops the raw trace after a clean run", async () => {
    const { teardown, trace } = seeded([edge("workspaces", "threads")]);

    await teardown();

    expect(process.exitCode).toBeUndefined();
    expect(existsSync(trace)).toBe(false);
    expect(JSON.parse(readFileSync(trace + ".graph.json", "utf8"))).toMatchObject({
      cycles: [],
      mode: "enforce",
      violations: 0,
    });
  });

  it("fails the process when a file the run started left no trace", async () => {
    const started = { vitest: { state: { getFilepaths: () => ["/fixture.ts", "/silent.ts"] } } };
    const teardown = setup(started as unknown as TestProject);
    writeFileSync(
      join(process.env.OPENSTEER_LOCK_ORDER_TRACE_DIRECTORY!, "worker-1.jsonl"),
      [
        { type: "file-start", file: "/fixture.ts", worker: "1" },
        { type: "file-end", file: "/fixture.ts", worker: "1" },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
    );

    await expect(teardown()).rejects.toThrow(/Missing lock trace for \/silent\.ts/u);
    expect(process.exitCode).toBe(1);
  });

  it("holds each shard of a real Vitest run to the files it ran", { timeout: 60_000 }, () => {
    // CI splits the integration suite across shards; each discovers every file.
    const repository = resolve(import.meta.dirname, "../../..");
    // Vitest reports real paths; macOS's temporary directory is behind a symlink.
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "opensteer-lock-shards-")));
    try {
      const files = ["first.test.ts", "second.test.ts"].map((name) => join(directory, name));
      for (const file of files) writeFileSync(file, `it("runs", () => {});\n`);
      const config = join(directory, "vitest.config.mts");
      const support = (name: string) => JSON.stringify(join(import.meta.dirname, name));
      writeFileSync(
        config,
        `export default { root: ${JSON.stringify(directory)}, test: { globals: true, include: ["*.test.ts"], globalSetup: [${support("lock-order-global-setup.test-support.ts")}], setupFiles: [${support("lock-order-setup.test-support.ts")}], runner: ${support("lock-order-runner.test-support.ts")} } };\n`,
      );
      const ran = [1, 2].map((shard) => {
        const trace = join(directory, `shard-${shard}.jsonl`);
        const environment: NodeJS.ProcessEnv = {
          ...process.env,
          OPENSTEER_LOCK_ORDER_MODE: "enforce",
          OPENSTEER_LOCK_ORDER_TRACE: trace,
        };
        delete environment.OPENSTEER_LOCK_ORDER_TRACE_DIRECTORY;
        delete environment.VITEST_MAX_WORKERS;
        const run = spawnSync(
          process.execPath,
          [
            join(repository, "node_modules/vitest/vitest.mjs"),
            "run",
            "--config",
            config,
            `--shard=${shard}/2`,
          ],
          { cwd: repository, env: environment, encoding: "utf8", timeout: 60_000 },
        );
        expect(run.status, run.stdout + run.stderr).toBe(0);
        return JSON.parse(readFileSync(trace + ".graph.json", "utf8")).files as string[];
      });

      expect(ran.map((shard) => shard.length)).toEqual([1, 1]);
      expect(ran.flat().sort()).toEqual(files);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("fails the process when the teardown throws before it judges the graph", async () => {
    const { teardown } = seeded([]);
    rmSync(process.env.OPENSTEER_LOCK_ORDER_TRACE_DIRECTORY!, { recursive: true });

    await expect(teardown()).rejects.toThrow(/ENOENT/u);
    expect(process.exitCode).toBe(1);
  });

  it("fails a real Vitest run whose lock-order teardown throws", { timeout: 60_000 }, () => {
    // Vitest 4 logs a global teardown error as "error during close" and exits 0.
    const repository = resolve(import.meta.dirname, "../../..");
    const directory = mkdtempSync(join(tmpdir(), "opensteer-teardown-exit-"));
    writeFileSync(
      join(directory, "lose-traces.test.ts"),
      `import { rmSync } from "node:fs";
it("loses the worker traces", () => {
  rmSync(process.env.OPENSTEER_LOCK_ORDER_TRACE_DIRECTORY!, { recursive: true });
});
`,
    );
    const config = join(directory, "vitest.config.mts");
    writeFileSync(
      config,
      `export default { root: ${JSON.stringify(directory)}, test: { globals: true, include: ["lose-traces.test.ts"], globalSetup: [${JSON.stringify(join(import.meta.dirname, "lock-order-global-setup.test-support.ts"))}] } };\n`,
    );
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      OPENSTEER_LOCK_ORDER_TRACE: join(directory, "locks.jsonl"),
    };
    delete environment.VITEST_MAX_WORKERS;

    const run = spawnSync(
      process.execPath,
      [join(repository, "node_modules/vitest/vitest.mjs"), "run", "--config", config],
      { cwd: repository, env: environment, encoding: "utf8", timeout: 60_000 },
    );

    const output = run.stdout + run.stderr;
    expect(output).toContain("1 passed");
    expect(output).toMatch(/error during close[\s\S]*ENOENT/u);
    expect(run.status, output).toBe(1);
  });
});
