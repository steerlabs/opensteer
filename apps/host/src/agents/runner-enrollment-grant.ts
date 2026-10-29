import { RunnerModuleNameSchema, type RunnerModuleName } from "@opensteer/protocol";

/** Computers can enable their reach modules without enrolling again; phones request their own exact grant. */
export function computerRunnerGrant(
  requested: readonly RunnerModuleName[],
): readonly RunnerModuleName[] {
  const reach: readonly RunnerModuleName[] = ["integrations", "messaging", "shell"];
  return RunnerModuleNameSchema.options.filter(
    (module) => requested.includes(module) || reach.includes(module),
  );
}
