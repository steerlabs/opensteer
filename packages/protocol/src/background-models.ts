import { z } from "zod";
import {
  BackgroundModelModeSchema,
  BackgroundProviderConsentSchema,
  ResolvedBackgroundCandidateSchema,
} from "@opensteer/core";
export const BackgroundCandidateViewSchema = z.object({
  ...ResolvedBackgroundCandidateSchema.shape,
  providerDisplayName: z.string(),
  modelDisplayName: z.string(),
  accountDisplayName: z.string(),
  computerDisplayName: z.string(),
  skipReason: z
    .enum([
      "consent-required",
      "offline",
      "unsupported",
      "disabled",
      "catalog-not-ready",
      "model-unavailable",
      "option-unavailable",
      "usage-limit",
    ])
    .nullable(),
});
const roleView = z.object({
  mode: BackgroundModelModeSchema,
  effectivePick: BackgroundCandidateViewSchema.nullable(),
  candidates: z.array(BackgroundCandidateViewSchema),
});
export const BackgroundModelsViewSchema = z.object({
  backgroundProviderConsent: BackgroundProviderConsentSchema,
  light: roleView,
  deep: roleView,
});
export type BackgroundModelsView = z.infer<typeof BackgroundModelsViewSchema>;
