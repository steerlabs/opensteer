import { z } from "zod";
import type { SelectionModelDescriptor } from "./model-candidates.js";
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
/** How hard a model reasons, in engine-neutral words; "default" lets the engine choose. */
export const ModelEffortSchema = z.enum([...modelEffortTiers, "default"]);
export type ModelEffort = z.infer<typeof ModelEffortSchema>;

type Ladder = Extract<SelectionModelDescriptor["options"][number], { type: "select" }>;
const automaticValues = new Set(["auto", "default"]);

/** The select that sets how hard the model reasons, when every value on it is a known tier. */
export function modelEffortLadder(model: SelectionModelDescriptor): Ladder | undefined {
  const option = model.options.find(
    (candidate): candidate is Ladder =>
      candidate.type === "select" && (candidate.id === "effort" || candidate.id === "thinking"),
  );
  if (!option) return undefined;
  const known = option.values.every(
    ({ value }) =>
      automaticValues.has(value) || value === "off" || modelEffortTiers.some((t) => t === value),
  );
  return known ? option : undefined;
}

function ladderValue(ladder: Ladder, effort: ModelEffortTier | "highest"): string | undefined {
  const offered = ladder.values.flatMap(({ value }) => {
    if (automaticValues.has(value)) return [];
    const tier = value === "off" ? "none" : modelEffortTiers.find((t) => t === value);
    return tier ? [{ tier, value }] : [];
  });
  if (effort !== "highest") return offered.find(({ tier }) => tier === effort)?.value;
  return offered.sort(
    (a, b) => modelEffortTiers.indexOf(b.tier) - modelEffortTiers.indexOf(a.tier),
  )[0]?.value;
}

/**
 * The selection at that effort on this model, or null when the model's ladder lacks it.
 * A model with no ladder has one effort, so any effort leaves it unchanged.
 */
export function withModelEffort(
  selection: ModelSelection,
  model: SelectionModelDescriptor,
  effort: ModelEffort | "highest",
): ModelSelection | null {
  const ladder = modelEffortLadder(model);
  if (!ladder) return selection;
  const { [ladder.id]: _previous, ...options } = selection.options;
  if (effort === "default") return { ...selection, options };
  const value = ladderValue(ladder, effort);
  if (value === undefined) return null;
  return {
    ...selection,
    options: value === ladder.defaultValue ? options : { ...options, [ladder.id]: value },
  };
}

/** This model at the effort, or at the engine's choice when it doesn't offer that effort. */
export function selectionForModelEffort(
  model: SelectionModelDescriptor,
  effort: ModelEffort | "highest",
): ModelSelection {
  const selection = { providerId: model.providerId, modelId: model.modelId, options: {} };
  return storedModelSelection(withModelEffort(selection, model, effort) ?? selection, model);
}

/** The effort a model runs at with these complete options, in the engine's own words. */
export function modelEffortLabel(
  model: SelectionModelDescriptor,
  options: ModelSelection["options"],
): string | null {
  const ladder = modelEffortLadder(model);
  const step = ladder?.values.find(({ value }) => value === options[ladder.id]);
  return step ? (step.label ?? step.value) : null;
}
