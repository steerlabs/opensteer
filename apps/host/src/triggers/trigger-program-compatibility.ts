import type { EnvironmentId } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import { TRIGGER_PROGRAM_VERSION_REFUSAL } from "@opensteer/triggers";

export type TriggerProgramRunnerStore = Pick<
  OpensteerStore,
  "getEnvironment" | "runnerCapabilities"
>;

/** Use the last advertisement even offline; discovery support does not imply program support. */
export async function triggerProgramCompatibilityReason(
  store: TriggerProgramRunnerStore,
  environmentId: EnvironmentId,
  version: number,
): Promise<string | null> {
  if (version !== 5) return TRIGGER_PROGRAM_VERSION_REFUSAL;
  const environment = await store.getEnvironment(environmentId);
  const capabilities = environment?.runnerId
    ? await store.runnerCapabilities(environment.runnerId)
    : null;
  return capabilities?.includes("trigger-program-v5")
    ? null
    : "Update this computer to run automation programs with tool contract version 5.";
}
