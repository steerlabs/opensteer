/**
 * Prints each CI job's measured wall time across the given GitHub Actions runs
 * and the `timeout-minutes` it implies: 1.5 times the slowest completed run,
 * rounded up, at least 3. Shards of one job share a bound. Failed runs count,
 * since they did the work; cancelled and timed-out ones are listed, so a bound
 * is never read off the runs it already cut short.
 *   pnpm exec tsx scripts/ci-timeouts.ts <run id>...
 */
import { execFileSync } from "node:child_process";
import { z } from "zod";

const jobSchema = z.object({
  name: z.string(),
  conclusion: z.string().nullable(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
});

const runs = process.argv.slice(2);
if (!runs.length || runs.some((run) => !/^\d+$/u.test(run)))
  throw new Error("Usage: pnpm exec tsx scripts/ci-timeouts.ts <run id>...");
const measured = new Map<string, { minutes: number[]; cut: string[] }>();
for (const run of runs) {
  const lines = execFileSync(
    "gh",
    [
      "api",
      "--paginate",
      `repos/steerlabs/opensteer/actions/runs/${run}/jobs`,
      "--jq",
      ".jobs[] | @json",
    ],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean);
  for (const line of lines) {
    const job = jobSchema.parse(JSON.parse(line));
    if (job.conclusion === "skipped") continue;
    // "tests (3)" and "integration (5)" are shards of one job with one bound.
    const name = job.name.replace(/ \(\d+\)$/u, "");
    const entry = measured.get(name) ?? { minutes: [], cut: [] };
    measured.set(name, entry);
    if (
      (job.conclusion === "success" || job.conclusion === "failure") &&
      job.started_at &&
      job.completed_at
    )
      entry.minutes.push((Date.parse(job.completed_at) - Date.parse(job.started_at)) / 60_000);
    else entry.cut.push(`${run}:${job.conclusion ?? "unfinished"}`);
  }
}
for (const [name, { minutes, cut }] of [...measured].sort(([a], [b]) => a.localeCompare(b))) {
  const slowest = minutes.length ? Math.max(...minutes) : Number.NaN;
  console.log(
    [
      name.padEnd(28),
      `n=${String(minutes.length).padStart(2)}`,
      `slowest=${slowest.toFixed(1).padStart(4)}`,
      `timeout=${minutes.length ? Math.max(3, Math.ceil(slowest * 1.5)) : "n/a"}`,
      cut.length ? `cut short: ${cut.join(", ")}` : "",
    ].join("  "),
  );
}
