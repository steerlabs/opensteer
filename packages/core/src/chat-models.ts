import type { SelectionModelDescriptor } from "./model-candidates.js";
import type { ModelSelection } from "./models.js";
import { storedModelSelection } from "./model-selection.js";
import { canonicalModelReference } from "./model-registry.js";
import type { ModelReference } from "./model-registry.js";

export const modelEffortTiers = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
export type ModelEffortTier = (typeof modelEffortTiers)[number];

export interface ChatModelPreference extends ModelReference {
  readonly effort: ModelEffortTier | "default" | "highest";
}

/** Chat's defaults, best first. Tasks keep using the person's execution history. */
export const chatModelPreferences: readonly ChatModelPreference[] = [
  { providerId: "openai", modelId: "gpt-6.1-terra", effort: "high" },
  { providerId: "anthropic", modelId: "claude-sonnet-5-5", effort: "medium" },
  { providerId: "xai", modelId: "grok-4.7", effort: "highest" },
  { providerId: "deepseek", modelId: "deepseek-v4-pro", effort: "high" },
  { providerId: "meta", modelId: "muse-spark-1.3", effort: "default" },
  { providerId: "google", modelId: "gemini-3.1-pro", effort: "default" },
];

export function selectionForModelEffort(
  model: SelectionModelDescriptor,
  effort: ModelEffortTier | "default" | "highest",
): ModelSelection {
  const selection: ModelSelection = {
    providerId: model.providerId,
    modelId: model.modelId,
    options: {},
  };
  const option = model.options.find(
    (candidate) =>
      candidate.type === "select" && (candidate.id === "effort" || candidate.id === "thinking"),
  );
  if (effort === "default" || !option || option.type !== "select")
    return storedModelSelection(selection, model);
  const offered: { tier: ModelEffortTier; value: string }[] = [];
  for (const { value } of option.values) {
    if (value === "auto" || value === "default") continue;
    const tier =
      value === "off" ? "none" : modelEffortTiers.find((candidate) => candidate === value);
    if (tier === undefined) return storedModelSelection(selection, model);
    offered.push({ tier, value });
  }
  const value =
    effort === "highest"
      ? offered.sort(
          (a, b) => modelEffortTiers.indexOf(b.tier) - modelEffortTiers.indexOf(a.tier),
        )[0]?.value
      : offered.find((candidate) => candidate.tier === effort)?.value;
  if (value !== undefined && value !== option.defaultValue) selection.options[option.id] = value;
  return storedModelSelection(selection, model);
}
/** Pure ranked empty-choice search. Callers supply their already eligible placements. */
export function rankedChatModelSelection<
  T extends { readonly models: readonly SelectionModelDescriptor[] },
>(placements: readonly T[]): { placement: T; modelSelection: ModelSelection } | null {
  for (const preferred of chatModelPreferences)
    for (const placement of placements) {
      const model = placement.models.find((candidate) => {
        const reference = canonicalModelReference(candidate.modelId, candidate.providerId);
        return (
          !candidate.unavailableReason &&
          reference.providerId === preferred.providerId &&
          reference.modelId === preferred.modelId
        );
      });
      if (model)
        return { placement, modelSelection: selectionForModelEffort(model, preferred.effort) };
    }
  return null;
}
