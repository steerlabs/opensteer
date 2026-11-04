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

// Response readers. Executable input stays strict above; what a Host sends
// back must survive additive fields and variants a newer Host adds.
/** A known variant, read tolerantly, or `{ unknown }` for one this client predates. */
export function tolerantVariant<T>(variants: readonly z.ZodType<T>[]) {
  return z.unknown().transform((value): T | { readonly unknown: unknown } => {
    for (const variant of variants) {
      const parsed = variant.safeParse(value);
      if (parsed.success) return parsed.data;
    }
    return { unknown: value };
  });
}
const ExactModelWantViewSchema = z.object({
  engine: HarnessIdSchema,
  model: ModelSelectionSchema.shape.modelId,
  options: ModelSelectionSchema.shape.options.optional(),
});
const PersonWantViewSchema = ExactModelWantViewSchema.extend({
  harnessInstanceId: HarnessInstanceIdSchema.optional(),
});
const RankViewSchemas = [
  z.object({
    kind: z.literal("model"),
    driverKind: HarnessIdSchema,
    providerId: ModelSelectionSchema.shape.providerId,
    modelId: ModelSelectionSchema.shape.modelId,
    options: ModelSelectionSchema.shape.options,
  }),
  z.object({ kind: z.literal("catalog-light"), driverKind: HarnessIdSchema }),
] as const;
type RankView = z.infer<(typeof RankViewSchemas)[number]>;
type PersonWantView = z.infer<typeof PersonWantViewSchema>;
export const AutomaticModelWantViewSchema = tolerantVariant<PersonWantView>([PersonWantViewSchema]);
export const ModelPolicyEntryViewSchema = tolerantVariant<
  z.infer<typeof ExactModelWantViewSchema> | { readonly role: AutomaticModelRole }
>([ExactModelWantViewSchema, z.object({ role: AutomaticModelRoleSchema })]);
export const AutomaticModelRankViewSchema = tolerantVariant<RankView>(RankViewSchemas);
/** What a skipped preview entry came from: a person's want or a maintained rank. */
export const AutomaticModelSourceViewSchema = tolerantVariant<PersonWantView | RankView>([
  ...RankViewSchemas,
  PersonWantViewSchema,
]);
export const AutomaticModelConfigViewSchema = z.object({
  roles: z.object({
    light: z.array(AutomaticModelWantViewSchema).optional(),
    deep: z.array(AutomaticModelWantViewSchema).optional(),
  }),
  excludedAccounts: z.array(HarnessInstanceIdSchema),
});
export type AutomaticModelConfigView = z.infer<typeof AutomaticModelConfigViewSchema>;
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
