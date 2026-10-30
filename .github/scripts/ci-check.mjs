import { allNativeMacTasks, lanes } from "./ci-changes.mjs";
export function validateResults(plan, needs, event) {
  if (needs.changes?.result !== "success" || plan?.version !== 1 || plan.detectionError === true)
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
    (event !== "schedule" || tasks.length || Object.values(plan.lanes).some(Boolean))
  )
    throw new Error("Only a scheduled run may skip everything, and only everything");
  // The scheduled and manual runs back up main's per-push macOS selection.
  const full = !unchanged && (event === "schedule" || event === "workflow_dispatch");
  if (full && tasks.length !== allNativeMacTasks.length)
    throw new Error("Scheduled/manual runs forbid skipping native-mac tasks");
  for (const lane of lanes) {
    const flag = plan.lanes?.[lane];
    const output = needs.changes.outputs?.[lane];
    if (typeof flag !== "boolean" || output !== String(flag))
      throw new Error(`Missing/invalid plan output: ${lane}`);
    if (lane === "lint" && !flag && !unchanged) throw new Error("Lint must run");
    // Main selects its macOS tasks per push; every other lane runs there.
    if (!flag && (full || (event === "push" && lane !== "native-mac")))
      throw new Error("Main/scheduled/manual forbids skips");
    const result = needs[lane]?.result;
    if (result !== "success" && !(flag === false && result === "skipped"))
      throw new Error(`${lane}: ${result}`);
  }
}
