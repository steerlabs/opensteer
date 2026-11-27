/**
 * Runs the web journeys listed in `journeys.ts`, one after another, and fails if any fails.
 *
 *   pnpm --filter @opensteer/web test:journeys [--shard 1/2] [--evidence DIR] [--inventory FILE]
 *     [name ...]
 *
 * Each journey runs with its own temporary directory under the evidence directory (default
 * `opensteer-web-journeys` in the system's), so its screenshots and results stay there.
 * A failing journey does not stop the others; `journeys.json` there says how each one ended.
 * `--inventory` writes which journeys this shard ran, in the form CI's Check reads for every
 * sharded lane (ci-inventories.mjs), so a journey no shard ran fails Check.
 */
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { journeyShard, webJourneys } from "./journeys.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    evidence: { type: "string" },
    inventory: { type: "string" },
    shard: { type: "string" },
  },
});
if (values.inventory && positionals.length)
  throw new Error("An inventory is of a whole shard: name no journeys with --inventory.");
const [index, count] = (values.shard ?? "1/1").split("/").map(Number);
const unknown = positionals.filter((name) => !webJourneys.some((journey) => journey.name === name));
if (unknown.length) throw new Error(`No web journey named ${unknown.join(", ")}.`);
const chosen = journeyShard(webJourneys, index!, count!).filter(
  (journey) => !positionals.length || positionals.includes(journey.name),
);
const evidence = path.resolve(values.evidence ?? path.join(tmpdir(), "opensteer-web-journeys"));
const webRoot = path.resolve(import.meta.dirname, "..");
await mkdir(evidence, { recursive: true });

const results: { name: string; passed: boolean; seconds: number; exit: number | string }[] = [];
for (const journey of chosen) {
  const directory = path.join(evidence, journey.name);
  await rm(directory, { force: true, recursive: true });
  await mkdir(directory, { recursive: true });
  console.log(`\n=== ${journey.name}`);
  const began = performance.now();
  const exit = await new Promise<number | string>((resolve) => {
    // tsx as a loader, not its command: the command opens a socket under TMPDIR, whose path
    // can pass the socket path limit there.
    const child = spawn(
      process.execPath,
      ["--import", "tsx", `scripts/${journey.name}-journey.ts`],
      {
        cwd: webRoot,
        // Every journey keeps its evidence under the system's temporary directory.
        env: { ...process.env, TMPDIR: directory },
        stdio: "inherit",
      },
    );
    child.on("error", (error) => resolve(error.message));
    child.on("exit", (code, signal) => resolve(code ?? signal ?? "unknown"));
  });
  const seconds = Math.round((performance.now() - began) / 100) / 10;
  results.push({ name: journey.name, passed: exit === 0, seconds, exit });
  console.log(`=== ${journey.name}: ${exit === 0 ? "passed" : `failed (${exit})`} in ${seconds} s`);
}

await writeFile(path.join(evidence, "journeys.json"), `${JSON.stringify(results, null, 2)}\n`);
if (values.inventory)
  await writeFile(
    path.resolve(values.inventory),
    `${JSON.stringify(
      {
        version: 1,
        lane: "journeys",
        shard: index,
        total: count,
        discovered: webJourneys.map((journey) => journey.name).sort(),
        executed: results.map((result) => result.name).sort(),
      },
      null,
      2,
    )}\n`,
  );
console.log(`\nWeb journeys, shard ${index}/${count}:`);
for (const result of results)
  console.log(`  ${result.passed ? "ok  " : "FAIL"} ${result.name} (${result.seconds} s)`);
const failed = results.filter((result) => !result.passed);
console.log(
  `${results.length - failed.length} of ${results.length} passed; evidence in ${evidence}`,
);
process.exitCode = failed.length ? 1 : 0;
