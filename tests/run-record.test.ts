import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createRerunWorktree, decideRerun } from "../scripts/integration-rerun.js";
import { homedir } from "node:os";
import {
  compareRerun,
  readRunRecord,
  recordBlockers,
  type RecordedCase,
  type RunRecord,
} from "../scripts/run-record.js";

/*
 * Ways a same-SHA decision could accept a failure it cannot account for:
 * - a later teardown (lock-order, database cleanup) or another reporter fails
 *   after the record is written, and the exit status still "explains" itself
 *   by the test failure;
 * - a part of the record is missing, so a run with nothing recorded proves;
 * - rerun cases map ambiguously to the originals (`.each` duplicates), so a
 *   different case's pass stands in for the failure;
 * - a filtered original, another contract, a worse rerun case or a non-test
 *   error still yields a composite.
 */

const repository = path.resolve(import.meta.dirname, "..");
const directories: string[] = [];
it("allocates integration reruns under home state where Docker can bind their SQL fixture", async () => {
  const directory = await createRerunWorktree("a".repeat(40));
  directories.push(directory);
  expect(directory).toMatch(new RegExp(`^${homedir()}/\\.local/state/opensteer/reruns/`));
  expect(path.basename(directory)).toMatch(/^a{40}-[\w-]+$/u);
});
afterAll(() =>
  Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }))),
);

/** Runs real Vitest on a fixture whose config wraps its reporters in the record reporter. */
async function vitestRun(options: { lateReporter?: boolean; teardownFails?: boolean }) {
  const root = await mkdtemp(path.join(tmpdir(), "opensteer-run-record-"));
  directories.push(root);
  const record = path.join(root, "record");
  const support = path.join(repository, "packages/database/src/run-record.test-support.ts");
  const files: Record<string, string> = {
    "vitest.config.ts": [
      `import { RunRecordReporter } from ${JSON.stringify(support)};`,
      'import { DefaultReporter } from "vitest/reporters";',
      'class Late { async onTestRunEnd() { await new Promise((resolve) => setTimeout(resolve, 200)); throw new Error("late reporter"); } }',
      "export default {",
      "  test: {",
      '    include: ["cases/**/*.case.ts"],',
      '    globalSetup: ["./global-setup.ts"],',
      `    reporters: [new RunRecordReporter([new DefaultReporter(), ${options.lateReporter ? "new Late()" : ""}])],`,
      "  },",
      "};",
    ].join("\n"),
    "global-setup.ts": [
      `import { recordTeardown } from ${JSON.stringify(support)};`,
      "export default () => () => recordTeardown(async () => {",
      options.teardownFails ? '  throw new Error("lock-order cycle");' : "",
      "});",
    ].join("\n"),
    "cases/a.case.ts": [
      'import { expect, it } from "vitest";',
      'it("fails", () => expect(1).toBe(2));',
      'it("passes", () => {});',
    ].join("\n"),
  };
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), contents);
  }
  await symlink(path.join(repository, "node_modules"), path.join(root, "node_modules"));
  const run = spawnSync(
    process.execPath,
    [path.join(repository, "node_modules/vitest/vitest.mjs"), "run", "--root", root],
    { cwd: root, env: { ...process.env, OPENSTEER_RUN_RECORD: record }, encoding: "utf8" },
  );
  return { run, record: readRunRecord(record) };
}

const at = (file: string, titlePath: string[], state: RecordedCase["state"]): RecordedCase => ({
  file,
  project: "",
  titlePath,
  state,
});

/** A complete original record: one failed case, a full unfiltered run. */
function record(cases: RecordedCase[], filtered = false, mode = "off"): RunRecord {
  const files = [...new Set(cases.map((testCase) => testCase.file))];
  return {
    directory: filtered ? "/records/rerun" : "/records/original",
    malformed: [],
    reporter: {
      expected: files,
      modules: files.map((file) => ({ file, state: "failed", errors: [] })),
      cases,
      suiteErrors: [],
      unhandledErrors: [],
      reporterErrors: [],
      reason: "failed",
      dispatched: true,
    },
    teardown: { completed: true, errors: [] },
    envelope: {
      attempt: filtered ? "rerun" : "original",
      contract: {
        identity: { sourceRevision: "a".repeat(40), tree: "b".repeat(40), node: "v26" },
        suite: "integration",
        recipe: ["pnpm test:integration"],
        inputs: { "lock-order": mode },
      },
      argv: [],
      filtered,
      exit: {
        code: cases.some((testCase) => testCase.state === "failed") ? 1 : 0,
        signal: null,
      },
      cleanup: { ok: true },
    },
  };
}

it("refuses launcher failure evidence even when all test cases passed", () => {
  const complete = record([at("tests/a.integration.test.ts", ["works"], "passed")]);
  const directory = "/records/build-failure";
  const failed = {
    ...complete,
    directory,
    envelope: { ...complete.envelope!, launcherError: "bundle build failed" },
  };
  expect(recordBlockers(failed)).toContain("launcher failed: bundle build failed");
});

describe("integration run records", () => {
  it(
    "record a reporter that rejects after the record reporter's own hook",
    { timeout: 60_000 },
    async () => {
      const { run, record: written } = await vitestRun({ lateReporter: true });
      expect(run.status).not.toBe(0);
      expect(
        written.reporter?.cases.map((testCase) => [testCase.titlePath, testCase.state]),
      ).toEqual([
        [["fails"], "failed"],
        [["passes"], "passed"],
      ]);
      expect(recordBlockers(written)).toContain("reporter onTestRunEnd failed: late reporter");
    },
  );

  it("record a global teardown that fails after the test run", { timeout: 60_000 }, async () => {
    const { record: written } = await vitestRun({ teardownFails: true });
    expect(written.teardown).toEqual({ completed: true, errors: ["lock-order cycle"] });
    expect(recordBlockers(written)).toContain("global teardown failed: lock-order cycle");
  });

  it("block a run that exited 0 with any part missing", () => {
    const complete = record([at("a.ts", ["t"], "passed")]);
    expect(recordBlockers(complete)).toEqual([]);
    for (const part of ["reporter", "teardown", "envelope"] as const)
      expect(recordBlockers({ ...complete, [part]: undefined })).not.toEqual([]);
  });
});

describe("same-SHA file reruns", () => {
  const original = record([
    at("a.ts", ["fails once"], "failed"),
    at("a.ts", ["passes"], "passed"),
    at("a.ts", ["skipped"], "skipped"),
  ]);

  it("issue a composite when every case reaches its original state or better", () => {
    const rerun = record(
      [
        at("a.ts", ["fails once"], "passed"),
        at("a.ts", ["passes"], "passed"),
        at("a.ts", ["skipped"], "skipped"),
      ],
      true,
    );
    expect(decideRerun(original, rerun)).toMatchObject({
      category: "passed-on-same-sha-rerun",
      flakes: [{ file: "a.ts", titlePath: ["fails once"] }],
    });
  });

  it("block a rerun whose cases end worse, fail again, or report a non-test error", () => {
    const worse = record(
      [
        at("a.ts", ["fails once"], "passed"),
        at("a.ts", ["passes"], "skipped"),
        at("a.ts", ["skipped"], "skipped"),
      ],
      true,
    );
    expect(decideRerun(original, worse).category).toBe("blocked");
    const repeat = record(
      [
        at("a.ts", ["fails once"], "failed"),
        at("a.ts", ["passes"], "passed"),
        at("a.ts", ["skipped"], "skipped"),
      ],
      true,
    );
    expect(decideRerun(original, repeat).category).toBe("blocked");
    const clean = record(
      [
        at("a.ts", ["fails once"], "passed"),
        at("a.ts", ["passes"], "passed"),
        at("a.ts", ["skipped"], "skipped"),
      ],
      true,
    );
    const hook = {
      ...clean,
      reporter: { ...clean.reporter!, suiteErrors: [{ file: "a.ts", message: "afterAll failed" }] },
    };
    expect(decideRerun(original, hook).category).toBe("blocked");
  });

  it("map .each duplicates only when every member passes on the rerun", () => {
    const duplicated = record([at("e.ts", ["case"], "failed"), at("e.ts", ["case"], "skipped")]);
    // A failed and B skipped, then A skipped and B passed: which one passed is unknowable.
    const swapped = record([at("e.ts", ["case"], "skipped"), at("e.ts", ["case"], "passed")], true);
    expect(
      compareRerun(duplicated.reporter!.cases, swapped.reporter!.cases, ["e.ts"]).problems,
    ).not.toEqual([]);
    expect(decideRerun(duplicated, swapped).category).toBe("blocked");
    const allPass = record([at("e.ts", ["case"], "passed"), at("e.ts", ["case"], "passed")], true);
    expect(decideRerun(duplicated, allPass).category).toBe("passed-on-same-sha-rerun");
  });

  it("never use a filtered original, another contract or an incomplete record", () => {
    const pass = record(
      [
        at("a.ts", ["fails once"], "passed"),
        at("a.ts", ["passes"], "passed"),
        at("a.ts", ["skipped"], "skipped"),
      ],
      true,
    );
    expect(decideRerun(record(original.reporter!.cases, true), pass).category).toBe("blocked");
    expect(decideRerun(original, record(pass.reporter!.cases, true, "enforce")).category).toBe(
      "blocked",
    );
    expect(decideRerun({ ...original, teardown: undefined }, pass).category).toBe("blocked");
  });
});
