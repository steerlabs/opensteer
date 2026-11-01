import { ModelIdSchema, ModelProviderIdSchema } from "@opensteer/core";
import type { HarnessModelDescriptor } from "@opensteer/harness";
import { z } from "zod";

const EffortSchema = z.looseObject({
  default: z.boolean().optional(),
  description: z.string().optional(),
  id: z.string(),
  label: z.string().optional(),
  value: z.string().optional(),
});

const ModelSchema = z.looseObject({
  description: z.string().optional(),
  modelId: z.string(),
  name: z.string().optional(),
  _meta: z
    .looseObject({
      reasoningEffort: z.string().optional(),
      reasoningEfforts: z.array(EffortSchema).optional(),
      supportsReasoningEffort: z.boolean().optional(),
      totalContextTokens: z.number().int().positive().optional(),
    })
    .optional(),
});

const ModelStateSchema = z.looseObject({
  availableModels: z.array(ModelSchema),
  currentModelId: z.string().optional(),
});

export function grokModelsFromInitializeMetadata(
  metadata: Readonly<Record<string, unknown>>,
): readonly HarnessModelDescriptor[] {
  const parsed = ModelStateSchema.safeParse(metadata.modelState);
  if (!parsed.success) return [];
  const providerId = ModelProviderIdSchema.parse("xai");
  return parsed.data.availableModels.flatMap((model) => {
    if (isBuildAlias(model.modelId)) return [];
    const modelId = ModelIdSchema.safeParse(model.modelId);
    if (!modelId.success) return [];
    const efforts = (model._meta?.reasoningEfforts ?? []).map((effort) => ({
      ...(effort.description ? { description: effort.description } : {}),
      label: effort.label ?? effort.id,
      value: effort.value ?? effort.id,
    }));
    const defaultEffort =
      model._meta?.reasoningEfforts?.find((effort) => effort.default)?.value ??
      model._meta?.reasoningEffort;
    return [
      {
        acceptsImages: true,
        ...(model._meta?.totalContextTokens
          ? { contextWindow: model._meta.totalContextTokens }
          : {}),
        ...(model.description ? { description: model.description } : {}),
        displayName: model.name ?? model.modelId,
        isDefault: model.modelId === parsed.data.currentModelId,
        modelId: modelId.data,
        options:
          efforts.length > 0
            ? [
                {
                  ...(defaultEffort ? { defaultValue: defaultEffort } : {}),
                  id: "effort",
                  label: "Effort",
                  type: "select" as const,
                  values: efforts,
                },
              ]
            : [],
        providerId,
      },
    ];
  });
}

export function parseGrokModelsOutput(output: string): readonly HarnessModelDescriptor[] {
  const defaultModel = /^Default model:\s*(\S+)/imu.exec(output)?.[1];
  const ids = [...output.matchAll(/^\s*(?:\*|-)\s+(\S+)(?:\s+\(default\))?\s*$/gmu)].map(
    (match) => match[1]!,
  );
  const providerId = ModelProviderIdSchema.parse("xai");
  return [...new Set(ids)].flatMap((candidate) => {
    const modelId = ModelIdSchema.safeParse(candidate);
    if (isBuildAlias(candidate) || !modelId.success) return [];
    return [
      {
        displayName: candidate,
        isDefault: candidate === defaultModel,
        modelId: modelId.data,
        options: [],
        providerId,
      },
    ];
  });
}

export function completeGrokModelCatalog(
  initialized: readonly HarnessModelDescriptor[],
  listed: readonly HarnessModelDescriptor[],
): readonly HarnessModelDescriptor[] {
  return initialized.length >= listed.length ? initialized : listed;
}

function isBuildAlias(modelId: string): boolean {
  return modelId === "grok-build" || modelId.startsWith("grok-build-");
}
