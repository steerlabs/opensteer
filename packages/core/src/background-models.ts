import { z } from "zod";
import { HarnessIdSchema, ModelSelectionSchema } from "./models.js";
import { HarnessInstanceIdSchema } from "./ids.js";
import { harnessKinds } from "./harness-catalog.js";

export const BackgroundModelRoleSchema = z.enum(["naming", "light", "deep"]);
export type BackgroundModelRole = z.infer<typeof BackgroundModelRoleSchema>;
/** Specialist manifests ask for a role's models; naming is the Host's own job. */
export const SpecialistModelRoleSchema = BackgroundModelRoleSchema.exclude(["naming"]);
const EngineSchema = HarnessIdSchema.refine(
  (value) => harnessKinds.some((kind) => kind === value),
  "Unknown engine",
);
export const ExactModelWantSchema = z.strictObject({
  engine: EngineSchema,
  model: ModelSelectionSchema.shape.modelId,
  options: ModelSelectionSchema.shape.options.optional(),
});
/** One entry in settings.json: no model means that account's own small model. */
export const BackgroundModelChoiceSchema = z.strictObject({
  engine: EngineSchema,
  model: ModelSelectionSchema.shape.modelId.optional(),
  account: HarnessInstanceIdSchema.optional(),
});
export type BackgroundModelChoice = z.infer<typeof BackgroundModelChoiceSchema>;
const choices = z.array(BackgroundModelChoiceSchema).max(16).optional();
/** `settings.json` in Agent home. Agents edit it; the hosting Runner reports it to the Host. */
export const AgentHomeSettingsSchema = z.strictObject({
  backgroundModels: z
    .strictObject({
      naming: choices,
      light: choices,
      deep: choices,
      excludedAccounts: z.array(HarnessInstanceIdSchema).max(256).optional(),
    })
    .optional(),
});
export type AgentHomeSettings = z.infer<typeof AgentHomeSettingsSchema>;
export const agentHomeSettingsFileName = "settings.json";
export const ModelPolicyEntrySchema = z.union([
  ExactModelWantSchema,
  z.strictObject({ role: SpecialistModelRoleSchema }),
]);
export type ModelPolicyEntry = z.infer<typeof ModelPolicyEntrySchema>;
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
export const ModelPolicyEntryViewSchema = tolerantVariant<
  z.infer<typeof ExactModelWantViewSchema> | { readonly role: "light" | "deep" }
>([ExactModelWantViewSchema, z.object({ role: SpecialistModelRoleSchema })]);
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
const recommendedLight: readonly AutomaticModelRank[] = [
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
];
/** The recommended order, which always follows a person's own list. */
export const automaticModelDefaults: Readonly<
  Record<BackgroundModelRole, readonly AutomaticModelRank[]>
> = {
  naming: recommendedLight,
  light: recommendedLight,
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

export type ModelWant =
  BackgroundModelChoice | z.infer<typeof ExactModelWantSchema> | AutomaticModelRank;
/**
 * The person's list first, then the recommended order, so no list can strand a
 * job. The resolver drops a recommended entry that repeats one already chosen.
 */
export function backgroundModelWants(
  settings: AgentHomeSettings,
  role: BackgroundModelRole,
): readonly ModelWant[] {
  return [...(settings.backgroundModels?.[role] ?? []), ...automaticModelDefaults[role]];
}
export function excludedBackgroundAccounts(settings: AgentHomeSettings) {
  return settings.backgroundModels?.excludedAccounts ?? [];
}
export function expandModelWants(
  entries: readonly ModelPolicyEntry[],
  settings: AgentHomeSettings,
): ModelWant[] {
  return entries.flatMap<ModelWant>((entry) =>
    "role" in entry ? [...backgroundModelWants(settings, entry.role)] : [entry],
  );
}
