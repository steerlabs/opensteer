import type { EnvironmentId } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";

export type AutomationScriptRunnerStore = Pick<
  OpensteerStore,
  "getEnvironment" | "runnerCapabilities"
>;

export const AUTOMATION_SCRIPT_UPDATE_COMPUTER_REASON =
  "Update this computer to run script automations.";

/** Checks whether the environment's Runner advertises `automation-script-v1`. */
export async function automationScriptCompatibilityReason(
  store: AutomationScriptRunnerStore,
  environmentId: EnvironmentId,
): Promise<string | null> {
  const environment = await store.getEnvironment(environmentId);
  const capabilities = environment?.runnerId
    ? await store.runnerCapabilities(environment.runnerId)
    : null;
  return capabilities?.includes("automation-script-v1")
    ? null
    : AUTOMATION_SCRIPT_UPDATE_COMPUTER_REASON;
}
