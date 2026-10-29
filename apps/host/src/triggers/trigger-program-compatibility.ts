import type { EnvironmentId } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";

export type TriggerProgramRunnerStore = Pick<
  OpensteerStore,
  "getEnvironment" | "runnerCapabilities"
>;

/** Use the last advertisement even offline; discovery support does not imply program support. */
export async function triggerProgramCompatibilityReason(
  store: TriggerProgramRunnerStore,
  environmentId: EnvironmentId,
  version: 1 | 2 | 3,
): Promise<string | null> {
  if (version !== 3) return null;
  const environment = await store.getEnvironment(environmentId);
  const capabilities = environment?.runnerId
    ? await store.runnerCapabilities(environment.runnerId)
    : null;
  return capabilities?.includes("trigger-program-v3")
    ? null
    : "This computer's Runner cannot run Trigger program version 3. Use version 2 or update that computer.";
}
