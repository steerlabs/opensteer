import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, expect, it } from "vitest";

/*
 * Ways the integration failure reporter can fail its purpose, driven through
 * a real Vitest run:
 * - a failure appears only in the final summary, after the rest of the run;
 * - a failure line carries no time, so it cannot be placed in a long run;
 * - a hook or collection error, which fails no single test, is not printed;
 * - adding the reporter drops the default reporter's final summary;
 * - passing tests add noise.
 */

const repository = resolve(import.meta.dirname, "../../..");
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it("prints each failure with its time while the run continues, keeping the summary", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opensteer-failure-reporter-"));
  directories.push(directory);
  const reported = join(directory, "reported");
  writeFileSync(
    join(directory, "first.test.ts"),
    `import { existsSync } from "node:fs";
it("fails at once", () => {
  expect(1).toBe(2);
});
// The run goes on test by test, as a real suite does: Vitest's worker sends a
// result with its next task update, so a failure arrives within about one test.
for (let index = 0; index < 80; index++)
  it("keeps running " + index, async () => {
    if (!existsSync(${JSON.stringify(reported)})) await new Promise((resolve) => setTimeout(resolve, 250));
  });
it("ends only once that failure has been printed", () => {
  if (!existsSync(${JSON.stringify(reported)})) throw new Error("the failure was not printed while the run went on");
});
`,
  );
  writeFileSync(
    join(directory, "hook.test.ts"),
    `beforeAll(() => {
  throw new Error("the hook broke");
});
it("never runs", () => {});
`,
  );
  const config = join(directory, "vitest.config.mts");
  writeFileSync(
    config,
    `export default { root: ${JSON.stringify(directory)}, test: { globals: true, fileParallelism: false, include: ["*.test.ts"], reporters: ["default", ${JSON.stringify(join(import.meta.dirname, "integration-failure-reporter.test-support.ts"))}] } };\n`,
  );
  const environment: NodeJS.ProcessEnv = { ...process.env, CI: "1" };
  delete environment.VITEST_MAX_WORKERS;

  const child = spawn(
    process.execPath,
    [join(repository, "node_modules/vitest/vitest.mjs"), "run", "--config", config],
    { cwd: repository, env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  const watch = (chunk: Buffer) => {
    output += chunk.toString();
    if (/\] FAIL first\.test\.ts > fails at once/u.test(output)) writeFileSync(reported, "");
  };
  child.stdout.on("data", watch);
  child.stderr.on("data", watch);
  const status = await new Promise<number | null>((resolve) => child.once("close", resolve));

  const plain = stripVTControlCharacters(output);
  const failure = plain.match(
    /^\[\d{2}:\d{2}:\d{2}Z \+\d+m\d{2}s\] FAIL first\.test\.ts > fails at once\n {4}.*expected 1 to be 2/mu,
  );
  expect(failure, plain).not.toBeNull();
  const hook = plain.search(
    /^\[\d{2}:\d{2}:\d{2}Z \+\d+m\d{2}s\] FAIL hook\.test\.ts.*\n.*the hook broke/mu,
  );
  const summary = plain.search(/Test Files .*2 failed/u);
  expect(hook, plain).toBeGreaterThanOrEqual(0);
  expect(summary, plain).toBeGreaterThan(hook);
  expect(plain.search(/Tests .*1 failed.*81 passed/u), plain).toBeGreaterThan(failure!.index!);
  expect(plain).not.toMatch(/\] FAIL first\.test\.ts > (?:keeps running|ends only)/u);
  expect(plain).not.toMatch(/\] (?:PASS|ok) /u);
  expect(status, plain).toBe(1);
}, 60_000);
