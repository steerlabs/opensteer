import { ModelIdSchema, ModelProviderIdSchema, OpensteerError } from "@opensteer/core";
import { reasoningEffortLabel, type HarnessModelDescriptor } from "@opensteer/harness";
import type { ModelCatalogEntry, ModelListResult } from "./generated/msp.js";

export const museEffortOptionId = "effort";

const effortTiers = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
const effortTierSet: ReadonlySet<string> = new Set(effortTiers);
const fallbackEfforts = ["low", "medium", "high", "xhigh", "max"] as const;

export function museModelDescriptors(catalog: ModelListResult): readonly HarnessModelDescriptor[] {
  if (catalog.providerId !== "meta") {
    throw new OpensteerError({
      code: "harness_error",
      message: "Muse Code returned a model catalog for a provider other than Meta",
    });
  }
  const seen = new Set<string>();
  return catalog.models.flatMap((model): readonly HarnessModelDescriptor[] => {
    if (model.providerId !== "meta" || seen.has(model.modelId)) return [];
    seen.add(model.modelId);
    const modelId = ModelIdSchema.parse(model.modelId);
    const providerId = ModelProviderIdSchema.parse("meta");
    return [
      {
        acceptsImages: true,
        ...(model.contextLimit === null ? {} : { contextWindow: model.contextLimit }),
        ...(model.description ? { description: model.description } : {}),
        displayName: model.displayLabel.trim() || displayName(model.modelId),
        isDefault: model.isDefault,
        ...(model.outputLimit === null ? {} : { maxOutputTokens: model.outputLimit }),
        modelId,
        options: effortOption(model),
        providerId,
      },
    ];
  });
}

function effortOption(model: ModelCatalogEntry): HarnessModelDescriptor["options"] {
  const values = Array.isArray(model.variants)
    ? model.variants.filter((tier) => effortTierSet.has(tier))
    : [...fallbackEfforts];
  const reportedDefault = model.defaultReasoningEffort;
  const defaultValue =
    reportedDefault && values.includes(reportedDefault)
      ? reportedDefault
      : values.includes("high")
        ? "high"
        : values[0];
  if (!defaultValue) return [];
  return [
    {
      defaultValue,
      id: museEffortOptionId,
      label: "Reasoning",
      type: "select",
      values: values.map((value) => ({
        ...effortDescription(model, value),
        label: reasoningEffortLabel(value),
        value,
      })),
    },
  ];
}

function effortDescription(
  model: ModelCatalogEntry,
  value: string,
): { readonly description?: string } {
  const description = model.reasoningEffortVariants?.find(
    (entry) => entry.tier === value,
  )?.description;
  return description ? { description } : {};
}

export function museSelectedEffort(options: Readonly<Record<string, unknown>>): string | undefined {
  const value = options[museEffortOptionId];
  return typeof value === "string" && effortTierSet.has(value) ? value : undefined;
}

function displayName(modelId: string): string {
  return modelId
    .split("-")
    .filter(Boolean)
    .map((part) => `${part[0]?.toLocaleUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}
