import type { DelegationModelChoice } from "@opensteer/core";
import type { HarnessModelDescriptor } from "./types.js";

/** Resolve only live, available candidates and only options the account actually offers. */
export function resolveLightModel(
  models: readonly HarnessModelDescriptor[],
  ranking: readonly {
    readonly modelId: string;
    readonly options: DelegationModelChoice["options"];
  }[],
): DelegationModelChoice | undefined {
  for (const candidate of ranking) {
    const model = models.find(
      (model) => model.modelId === candidate.modelId && !model.unavailableReason,
    );
    if (!model) continue;
    return {
      modelId: model.modelId,
      providerId: model.providerId,
      options: Object.fromEntries(
        Object.entries(candidate.options).filter(([id, value]) => {
          const option = model.options.find((option) => option.id === id);
          return option?.type === "toggle"
            ? typeof value === "boolean"
            : option?.values.some((entry) => entry.value === value) === true;
        }),
      ),
    };
  }
  return undefined;
}
