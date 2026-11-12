import {
  automaticAccountEligibility,
  automaticAccountOrder,
  DEFAULT_THREAD_ACCESS_MODE,
  OpensteerError,
  storedModelSelection,
  type EnvironmentId,
  type ExecutionPreferences,
  type ExecutionSelection,
  type UserId,
} from "@opensteer/core";
import type { RunnerRegistry } from "@opensteer/orchestration";
import {
  personalExecution,
  readAuthorizedModelAccounts,
  type AutomaticModelDependencies,
} from "../agents/automatic-models.js";

export async function resolveTeamTaskExecution(
  dependencies: AutomaticModelDependencies & {
    readonly runners: Pick<RunnerRegistry, "isAvailable" | "canRunHarness" | "harnessAccessModes">;
  },
  input: {
    readonly ownerId: UserId;
    readonly environmentId: EnvironmentId;
    readonly preferences: ExecutionPreferences;
  },
): Promise<ExecutionSelection> {
  const prior = input.preferences.history[0];
  if (prior?.environmentId === input.environmentId) return prior;
  const { accounts } = await readAuthorizedModelAccounts(dependencies, input.ownerId);
  const canRun = personalExecution(dependencies.runners, {
    environmentId: input.environmentId,
    accessMode: DEFAULT_THREAD_ACCESS_MODE,
  });
  for (const account of automaticAccountOrder(accounts)) {
    if (!automaticAccountEligibility(account, { excludedAccounts: [], canRun }).ok) continue;
    const models = account.catalog?.models.filter((model) => !model.unavailableReason) ?? [];
    const model = models.find((candidate) => candidate.isDefault) ?? models[0];
    if (model)
      return {
        environmentId: account.environmentId,
        harnessInstanceId: account.harnessInstanceId,
        modelSelection: storedModelSelection(
          { providerId: model.providerId, modelId: model.modelId, options: {} },
          model,
        ),
      };
  }
  throw new OpensteerError({
    code: "conflict",
    message: "Choose an available engine for your agent",
  });
}
