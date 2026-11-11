import {
  catalogDefaultModel,
  type SelectionCatalog,
  type SelectionModelDescriptor,
} from "./model-candidates.js";
import type { ModelSelection } from "./models.js";
import { storedModelSelection } from "./model-selection.js";

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

/** What opens a call in its Thread; it stands for the call and carries nothing to answer. */
export const voiceCallSeed = "Voice call";

/** Speech waits on the work, so the Voice Thread starts on a quick model, at speed. */
export function voiceModelSelection(catalog: SelectionCatalog | null): ModelSelection | null {
  if (catalog?.status !== "ready") return null;
  const model =
    catalog.models.find(
      ({ modelId, providerId }) => providerId === "openai" && modelId === "gpt-6.1-terra",
    ) ?? catalogDefaultModel(catalog);
  if (!model) return null;
  const selection = selectionForModelEffort(model, "low");
  const speed = model.options.find(({ id, type }) => id === "speed" && type === "select");
  const fast =
    speed?.type === "select"
      ? speed.values.find(({ value }) => value !== speed.defaultValue)?.value
      : undefined;
  return fast ? { ...selection, options: { ...selection.options, speed: fast } } : selection;
}

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
