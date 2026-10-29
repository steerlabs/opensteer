/**
 * Prints each CI job's measured wall time across the given GitHub Actions runs
 * and the `timeout-minutes` it implies: 1.5 times the slowest run, rounded up,
 * at least 3. Shards of one job share a bound. Failed runs count, since they did
 * the work. A cancelled run counts as a lower bound: a timed-out job ran at least
 * that long, so its bound can never be read off the runs it cut short.
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
const minutes = (job: z.infer<typeof jobSchema>) =>
  (Date.parse(job.completed_at!) - Date.parse(job.started_at!)) / 60_000;
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
    // "tests (3)" and "integration (5)" are shards of one job with one bound;
    // older native-mac names also carried their timeout, "(iphone, 6)".
    const name = job.name.replace(/ \(\d+\)$/u, "").replace(/, \d+\)$/u, ")");
    const entry = measured.get(name) ?? { minutes: [], cut: [] };
    measured.set(name, entry);
    if (!job.started_at || !job.completed_at) continue;
    entry.minutes.push(minutes(job));
    if (job.conclusion !== "success" && job.conclusion !== "failure")
      entry.cut.push(`${run}:${job.conclusion ?? "unfinished"} at ${minutes(job).toFixed(1)}`);
  }
}
for (const [name, { minutes: runs, cut }] of [...measured].sort(([a], [b]) => a.localeCompare(b))) {
  const slowest = runs.length ? Math.max(...runs) : Number.NaN;
  console.log(
    [
      name.padEnd(28),
      `n=${String(runs.length).padStart(2)}`,
      `slowest=${slowest.toFixed(1).padStart(4)}`,
      `timeout=${runs.length ? Math.max(3, Math.ceil(slowest * 1.5)) : "n/a"}`,
      cut.length ? `cancelled (lower bounds): ${cut.join(", ")}` : "",
    ].join("  "),
  );
}
