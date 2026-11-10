import { RunnerModuleNameSchema, type RunnerModuleName } from "@opensteer/protocol";

/** Computers keep browser and reach authority when execution is turned off. */
export function computerRunnerGrant(
  requested: readonly RunnerModuleName[],
): readonly RunnerModuleName[] {
  return serviceRunnerGrant([...requested, "browser"]);
}

/** Supervised services retain their original preset. */
export function serviceRunnerGrant(
  requested: readonly RunnerModuleName[],
): readonly RunnerModuleName[] {
  const reach: readonly RunnerModuleName[] = ["integrations", "messaging", "shell"];
  return RunnerModuleNameSchema.options.filter(
    (module) => requested.includes(module) || reach.includes(module),
  );
}
