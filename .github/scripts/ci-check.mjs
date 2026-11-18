import { allNativeMacTasks, lanes } from "./ci-changes.mjs";
const events = new Set(["pull_request", "push", "schedule", "workflow_dispatch"]);
/**
 * GitHub reports a job that hit its `timeout-minutes` only as cancelled. A cancelled job
 * that ran to within 15 seconds of its limit timed out.
 */
export function timedOutLanes(jobs, limits) {
  const lanes = new Map();
  for (const job of jobs) {
    if (job.conclusion !== "cancelled" || !job.started_at || !job.completed_at) continue;
    const lane = job.name.replace(/ \(.*\)$/, "");
    const limit = limits[job.name] ?? limits[lane];
    const ran = (Date.parse(job.completed_at) - Date.parse(job.started_at)) / 60_000;
    if (limit && ran >= limit - 0.25)
      lanes.set(lane, `${job.name} exceeded its ${limit}-minute time limit`);
  }
  return lanes;
}
/** `ignore` names lanes whose results do not count; their planning rules still apply. */
export function validateResults(
  plan,
  needs,
  event,
  sha,
  { timedOut = new Map(), ignore = new Set() } = {},
) {
  if (!events.has(event)) throw new Error(`Unknown CI event: ${event}`);
  if (needs.changes?.result !== "success" || plan?.version !== 2 || plan.detectionError === true)
    throw new Error("Change detection failed");
  const tasks = plan.nativeMac;
  let matrix;
  try {
    matrix = JSON.parse(needs.changes.outputs?.["native-mac-tasks"] ?? "");
  } catch {
    throw new Error("Missing/invalid plan output: native-mac-tasks");
  }
  if (
    !Array.isArray(tasks) ||
    !Array.isArray(matrix) ||
    JSON.stringify(matrix.map((entry) => entry?.task)) !== JSON.stringify(tasks) ||
    plan.lanes?.["native-mac"] !== tasks.length > 0
  )
    throw new Error("Missing/invalid plan output: native-mac-tasks");
  // Only a scheduled run may find nothing new on main since its last full run.
  const unchanged = plan.unchangedSince !== undefined;
  if (
    unchanged &&
    (event !== "schedule" ||
      plan.unchangedSince !== sha ||
      tasks.length ||
      !plan.lanes.lint ||
      Object.entries(plan.lanes).some(([lane, selected]) => lane !== "lint" && selected))
  )
    throw new Error("Only a scheduled run on an unchanged main may run just lint");
  // The scheduled and manual runs back up the per-change selection of PRs and main.
  const full = !unchanged && (event === "schedule" || event === "workflow_dispatch");
  if (full && tasks.length !== allNativeMacTasks.length)
    throw new Error("Scheduled/manual runs forbid skipping native-mac tasks");
  if (full && !(plan.whole?.tests === true && plan.whole?.integration === true))
    throw new Error("Scheduled/manual runs forbid partial suites");
  for (const lane of ["tests", "integration"]) {
    const files = plan.files?.[lane];
    const count = plan.shards?.[lane];
    let shards;
    try {
      shards = JSON.parse(needs.changes.outputs?.[`${lane}-shards`] ?? "");
    } catch {
      throw new Error(`Missing/invalid plan output: ${lane}-shards`);
    }
    if (
      !Array.isArray(files) ||
      !Number.isInteger(count) ||
      JSON.stringify(shards) !== JSON.stringify(Array.from({ length: count }, (_, i) => i + 1)) ||
      plan.lanes?.[lane] !== files.length > 0 ||
      count > 0 !== files.length > 0
    )
      throw new Error(`Missing/invalid plan output: ${lane}-shards`);
  }
  const failures = [];
  for (const lane of lanes) {
    const flag = plan.lanes?.[lane];
    const output = needs.changes.outputs?.[lane];
    if (typeof flag !== "boolean" || output !== String(flag))
      throw new Error(`Missing/invalid plan output: ${lane}`);
    if (lane === "lint" && !flag) throw new Error("Lint must run");
    if (!flag && full) throw new Error("Scheduled/manual runs forbid skips");
    if (ignore.has(lane)) continue;
    const result = needs[lane]?.result;
    if (result !== "success" && !(flag === false && result === "skipped"))
      failures.push(
        timedOut.get(lane) ??
          (result === "cancelled"
            ? `${lane} was cancelled before it finished`
            : `${lane}: ${result}`),
      );
  }
  if (failures.length) throw new Error(failures.join("; "));
}
