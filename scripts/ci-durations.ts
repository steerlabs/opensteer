/**
 * Regenerates .github/scripts/ci-durations.json from one green CI run:
 *   gh run download <run> -R steerlabs/opensteer -D <dir> -p 'tests-*' -p 'integration-*'
 *   pnpm exec tsx scripts/ci-durations.ts <dir>
 * Each lane's per-file Vitest JSON report gives the file's own wall time; the
 * sequencer's default weight for unknown files is added as per-file startup.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { unknownDuration as startup } from "../.github/scripts/ci-sharding.mjs";

type Lane = keyof typeof startup;

const reportSchema = z.object({
  testResults: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      startTime: z.number(),
      endTime: z.number(),
    }),
  ),
});

const root = resolve(import.meta.dirname, "..");
const directory = process.argv[2];
if (!directory)
  throw new Error("Usage: pnpm exec tsx scripts/ci-durations.ts <artifact directory>");
const tracked = new Set(
  execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0"),
);
// Reports name files by the runner's absolute path; keep the tracked suffix.
function repositoryPath(name: string): string {
  const parts = name.split("/");
  for (let index = 1; index < parts.length; index++) {
    const candidate = parts.slice(index).join("/");
    if (tracked.has(candidate)) return candidate;
  }
  throw new Error(`Not a tracked test file: ${name}`);
}

const durations: Record<Lane, Record<string, number>> = { tests: {}, integration: {} };
for (const file of readdirSync(directory, { recursive: true, encoding: "utf8" })) {
  const lane = /(?:^|\/)(tests|integration)-\d+\.results\.json$/u.exec(file)?.[1] as
    Lane | undefined;
  if (!lane) continue;
  const report = reportSchema.parse(JSON.parse(readFileSync(join(directory, file), "utf8")));
  for (const result of report.testResults) {
    if (result.status !== "passed")
      throw new Error(`Durations come from a green run; ${result.name} was ${result.status}`);
    const path = repositoryPath(result.name);
    if (path in durations[lane]) throw new Error(`Reported twice: ${path}`);
    durations[lane][path] = Math.round(result.endTime - result.startTime) + startup[lane];
  }
}
for (const lane of Object.keys(startup) as Lane[])
  if (!Object.keys(durations[lane]).length) throw new Error(`No ${lane} reports in ${directory}`);

const sorted = Object.fromEntries(
  (Object.keys(startup) as Lane[]).map((lane) => [
    lane,
    Object.fromEntries(
      Object.entries(durations[lane]).sort(([left], [right]) => left.localeCompare(right, "en")),
    ),
  ]),
);
writeFileSync(
  join(root, ".github/scripts/ci-durations.json"),
  JSON.stringify(sorted, null, 2) + "\n",
);
console.info(
  `Wrote ${Object.keys(durations.tests).length} tests and ${Object.keys(durations.integration).length} integration durations.`,
);
