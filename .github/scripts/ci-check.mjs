import { lanes } from "./ci-changes.mjs";
export function validateResults(plan, needs, event) {
  if (needs.changes?.result !== "success" || plan?.version !== 1 || plan.detectionError === true)
    throw new Error("Change detection failed");
  for (const lane of lanes) {
    const flag = plan.lanes?.[lane];
    const output = needs.changes.outputs?.[lane];
    if (typeof flag !== "boolean" || output !== String(flag))
      throw new Error(`Missing/invalid plan output: ${lane}`);
    if (lane === "lint" && !flag) throw new Error("Lint must run");
    if (event !== "pull_request" && !flag) throw new Error("Main/manual forbids skips");
    const result = needs[lane]?.result;
    if (result !== "success" && !(flag === false && result === "skipped"))
      throw new Error(`${lane}: ${result}`);
  }
}
