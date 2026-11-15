/**
 * Records each CI job's 95th-percentile wall time over its last 30 successful runs in
 * .github/scripts/ci-job-durations.json. ci-timeouts.test.mjs holds every `timeout-minutes`
 * to at least twice that, so a timeout catches a hang, not a slow runner. Shards of one job
 * share an entry; a job with no success in the scanned runs keeps its recorded value.
 *   pnpm exec tsx scripts/ci-timeouts.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const samples = 30;
const maxRuns = 200;
const path = resolve(import.meta.dirname, "../.github/scripts/ci-job-durations.json");
const jobSchema = z.object({
  name: z.string(),
  conclusion: z.string().nullable(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
});
const gh = (endpoint: string) =>
  execFileSync("gh", ["api", "--paginate", endpoint, "--jq", ".[] | arrays | .[] | @json"], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
  })
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);

export const jobName = (name: string) =>
  // "tests (3)" and "integration (5)" are shards of one job with one bound.
  name.replace(/ \(\d+\)$/u, "");
export function p95(minutes: readonly number[]) {
  const sorted = [...minutes].sort((a, b) => a - b);
  return Math.ceil(sorted[Math.ceil(0.95 * sorted.length) - 1]! * 10) / 10;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const recorded = z
    .record(z.string(), z.object({ p95: z.number(), runs: z.number() }))
    .parse(JSON.parse(readFileSync(path, "utf8")));
  const measured = new Map<string, number[]>();
  const runIds = execFileSync(
    "gh",
    [
      "run",
      "list",
      "-R",
      "steerlabs/opensteer",
      "--workflow",
      "ci.yml",
      "--status",
      "success",
      "--limit",
      String(maxRuns),
      "--json",
      "databaseId",
      "--jq",
      ".[].databaseId",
    ],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean);
  for (const run of runIds) {
    for (const raw of gh(`repos/steerlabs/opensteer/actions/runs/${run}/jobs?filter=latest`)) {
      const job = jobSchema.parse(raw);
      if (job.conclusion !== "success" || !job.started_at || !job.completed_at) continue;
      const list = measured.get(jobName(job.name)) ?? [];
      if (list.length < samples)
        list.push((Date.parse(job.completed_at) - Date.parse(job.started_at)) / 60_000);
      measured.set(jobName(job.name), list);
    }
    if (measured.size && [...measured.values()].every((list) => list.length >= samples)) break;
  }
  const next = { ...recorded };
  for (const [name, minutes] of measured) next[name] = { p95: p95(minutes), runs: minutes.length };
  const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(path, JSON.stringify(sorted, null, 2) + "\n");
  for (const [name, { p95: value, runs }] of Object.entries(sorted))
    console.log(
      `${name.padEnd(32)} n=${String(runs).padStart(2)}  p95=${value.toFixed(1)}  min timeout=${Math.ceil(2 * value)}`,
    );
}
