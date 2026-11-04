import { z } from "zod";
import { HarnessIdSchema, ModelSelectionSchema } from "./models.js";
import { HarnessInstanceIdSchema } from "./ids.js";
import { harnessKinds } from "./harness-catalog.js";

export const AutomaticModelRoleSchema = z.enum(["light", "deep"]);
export type AutomaticModelRole = z.infer<typeof AutomaticModelRoleSchema>;
export const ExactModelWantSchema = z.strictObject({
  engine: HarnessIdSchema.refine(
    (value) => harnessKinds.some((kind) => kind === value),
    "Unknown engine",
  ),
  model: ModelSelectionSchema.shape.modelId,
  options: ModelSelectionSchema.shape.options.optional(),
});
export const AutomaticModelWantSchema = ExactModelWantSchema.extend({
  harnessInstanceId: HarnessInstanceIdSchema.optional(),
});
export type AutomaticModelWant = z.infer<typeof AutomaticModelWantSchema>;
export const ModelPolicyEntrySchema = z.union([
  ExactModelWantSchema,
  z.strictObject({ role: AutomaticModelRoleSchema }),
]);
export type ModelPolicyEntry = z.infer<typeof ModelPolicyEntrySchema>;
export const AutomaticModelConfigSchema = z.strictObject({
  roles: z.strictObject({
    light: z.array(AutomaticModelWantSchema).min(1).max(16).optional(),
    deep: z.array(AutomaticModelWantSchema).min(1).max(16).optional(),
  }),
  excludedAccounts: z.array(HarnessInstanceIdSchema).max(256),
});
export type AutomaticModelConfig = z.infer<typeof AutomaticModelConfigSchema>;
export const emptyAutomaticModelConfig: AutomaticModelConfig = { roles: {}, excludedAccounts: [] };
export const AutomaticModelRankSchema = z.discriminatedUnion("kind", [
  ModelSelectionSchema.omit({ nativeModelId: true }).extend({
    kind: z.literal("model"),
    driverKind: HarnessIdSchema,
  }),
  z.strictObject({ kind: z.literal("catalog-light"), driverKind: HarnessIdSchema }),
]);
export type AutomaticModelRank = z.infer<typeof AutomaticModelRankSchema>;
const fixed = (
  driverKind: string,
  providerId: string,
  modelIds: readonly string[],
  effort: string,
): AutomaticModelRank[] =>
  modelIds.map((modelId) =>
    AutomaticModelRankSchema.parse({
      kind: "model",
      driverKind,
      providerId,
      modelId,
      options: { effort },
    }),
  );
export const automaticModelDefaults: Readonly<
  Record<AutomaticModelRole, readonly AutomaticModelRank[]>
> = {
  light: [
    ...fixed(
      "claude",
      "anthropic",
      ["claude-haiku-5-5", "claude-haiku-4-5", "claude-haiku-4-5-20251001"],
      "low",
    ),
    ...fixed("codex", "openai", ["gpt-6-luna", "gpt-5.6-luna"], "low"),
    ...fixed("cursor", "xai", ["composer-2.5", "composer-2"], "low"),
    { kind: "catalog-light", driverKind: HarnessIdSchema.parse("opencode") },
    { kind: "catalog-light", driverKind: HarnessIdSchema.parse("pi") },
  ],
  deep: [
    ...fixed("claude", "anthropic", ["claude-opus-5-5"], "high"),
    ...fixed("codex", "openai", ["gpt-6.1-sol", "gpt-6-sol"], "high"),
    ...fixed("cursor", "xai", ["composer-2.5", "composer-2"], "high"),
  ],
};
/** Catalog owners use the same fixed ranking as background resolution. */
export function backgroundLightModels(driverKind: string) {
  return automaticModelDefaults.light.flatMap((entry) =>
    entry.kind === "model" && entry.driverKind === driverKind
      ? [{ modelId: entry.modelId, options: entry.options }]
      : [],
  );
}
const opencodeSmallModelFamilies = ["gemini-flash", "gpt-nano", "claude-haiku"];
export function opencodeLightModelFamilies(providerId: string): readonly string[] {
  return providerId.startsWith("opencode") ? ["gpt-nano"] : opencodeSmallModelFamilies;
}

export type ModelWant = AutomaticModelWant | AutomaticModelRank;
export function automaticModelWants(
  config: AutomaticModelConfig,
  role: AutomaticModelRole,
): readonly ModelWant[] {
  return config.roles[role] ?? automaticModelDefaults[role];
}
export function expandModelWants(
  entries: readonly ModelPolicyEntry[],
  config: AutomaticModelConfig,
): ModelWant[] {
  return entries.flatMap<ModelWant>((entry) =>
    "role" in entry ? [...automaticModelWants(config, entry.role)] : [entry],
  );
}
