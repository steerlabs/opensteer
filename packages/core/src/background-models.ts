import { z } from "zod";
import { ExecutionSelectionSchema } from "./execution-preferences.js";
import { HarnessIdSchema, HarnessRuntimeRevisionSchema, ModelSelectionSchema } from "./models.js";

export const BackgroundModelRoleSchema = z.enum(["light", "deep"]);
export type BackgroundModelRole = z.infer<typeof BackgroundModelRoleSchema>;
export const BackgroundModelModeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("automatic") }),
  z.strictObject({ kind: z.literal("pinned"), selection: ExecutionSelectionSchema }),
]);
export type BackgroundModelMode = z.infer<typeof BackgroundModelModeSchema>;
export const BackgroundProviderConsentSchema = z
  .array(ModelSelectionSchema.shape.providerId)
  .max(256);
export const BackgroundModelPreferencesSchema = z.strictObject({
  backgroundModels: z.strictObject({
    light: BackgroundModelModeSchema,
    deep: BackgroundModelModeSchema,
  }),
  backgroundProviderConsent: BackgroundProviderConsentSchema,
});
export type BackgroundModelPreferences = z.infer<typeof BackgroundModelPreferencesSchema>;
export const emptyBackgroundModelPreferences: BackgroundModelPreferences = {
  backgroundModels: { light: { kind: "automatic" }, deep: { kind: "automatic" } },
  backgroundProviderConsent: [],
};
export const BackgroundModelRankSchema = z.discriminatedUnion("kind", [
  ModelSelectionSchema.omit({ nativeModelId: true }).extend({
    kind: z.literal("model"),
    driverKind: HarnessIdSchema,
  }),
  z.strictObject({ kind: z.literal("catalog-light"), driverKind: HarnessIdSchema }),
]);
export type BackgroundModelRank = z.infer<typeof BackgroundModelRankSchema>;
const fixed = (
  driverKind: string,
  providerId: string,
  modelIds: readonly string[],
  effort: string,
): BackgroundModelRank[] =>
  modelIds.map((modelId) =>
    BackgroundModelRankSchema.parse({
      kind: "model",
      driverKind,
      providerId,
      modelId,
      options: { effort },
    }),
  );
export const backgroundModelRankings: Readonly<
  Record<BackgroundModelRole, readonly BackgroundModelRank[]>
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
  return backgroundModelRankings.light.flatMap((entry) =>
    entry.kind === "model" && entry.driverKind === driverKind
      ? [{ modelId: entry.modelId, options: entry.options }]
      : [],
  );
}
const opencodeSmallModelFamilies = ["gemini-flash", "gpt-nano", "claude-haiku"];
export function opencodeLightModelFamilies(providerId: string): readonly string[] {
  return providerId.startsWith("opencode") ? ["gpt-nano"] : opencodeSmallModelFamilies;
}
export const ResolvedBackgroundCandidateSchema = ExecutionSelectionSchema.extend({
  harnessRevision: HarnessRuntimeRevisionSchema,
  reason: z.enum(["ranked", "pinned", "task-model"]),
});
export type ResolvedBackgroundCandidate = z.infer<typeof ResolvedBackgroundCandidateSchema>;
