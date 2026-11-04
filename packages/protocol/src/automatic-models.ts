import { HarnessIdSchema, ModelCandidateSkipReasonSchema } from "@opensteer/core";
import { HarnessInstanceCatalogViewSchema } from "./runner.js";
import { z } from "zod";
import {
  AutomaticModelConfigSchema,
  AutomaticModelRankSchema,
  AutomaticModelWantSchema,
  EnvironmentIdSchema,
  HarnessInstanceIdSchema,
  HarnessRuntimeRevisionSchema,
  ModelSelectionViewSchema,
} from "@opensteer/core";

/** Clients gate the read and the person-only command on this Host capability. */
export const automaticModelsCapability = "automatic-models-v1" as const;
const displayNames = {
  accountDisplayName: z.string(),
  computerDisplayName: z.string(),
};
export const AutomaticModelCandidateViewSchema = z.object({
  environmentId: EnvironmentIdSchema,
  harnessInstanceId: HarnessInstanceIdSchema,
  harnessRevision: HarnessRuntimeRevisionSchema,
  storedModelSelection: ModelSelectionViewSchema,
  runModelSelection: ModelSelectionViewSchema,
  usageLimited: z.boolean(),
  original: z.boolean(),
  providerDisplayName: z.string(),
  modelDisplayName: z.string(),
  ...displayNames,
});
export const AutomaticModelSkipViewSchema = z.object({
  want: z.union([AutomaticModelWantSchema, AutomaticModelRankSchema]).nullable(),
  harnessInstanceId: HarnessInstanceIdSchema.optional(),
  environmentId: EnvironmentIdSchema.optional(),
  reason: ModelCandidateSkipReasonSchema,
  detail: z.string().optional(),
  accountDisplayName: z.string().optional(),
  computerDisplayName: z.string().optional(),
  modelDisplayName: z.string().optional(),
  providerDisplayName: z.string().optional(),
});
const preview = z.object({
  candidates: z.array(AutomaticModelCandidateViewSchema),
  skipped: z.array(AutomaticModelSkipViewSchema),
});
export const AutomaticModelsViewSchema = z.object({
  config: AutomaticModelConfigSchema,
  maintainedDefaults: z.object({
    light: z.array(AutomaticModelRankSchema),
    deep: z.array(AutomaticModelRankSchema),
  }),
  /** Available to this viewer only. Execution sites apply their own additional requirements. */
  accounts: z.array(
    z.object({
      harnessInstanceId: HarnessInstanceIdSchema,
      environmentId: EnvironmentIdSchema,
      ...displayNames,
      driverKind: HarnessIdSchema,
      harnessRevision: HarnessRuntimeRevisionSchema,
      sourceId: z.string(),
      isDefault: z.boolean(),
      enabled: z.boolean(),
      removed: z.boolean(),
      available: z.boolean(),
      catalog: HarnessInstanceCatalogViewSchema.nullable(),
      eligible: z.boolean(),
      reason: ModelCandidateSkipReasonSchema.nullable(),
    }),
  ),
  light: preview.extend({ label: z.literal("General preference") }),
  deep: preview,
});
export type AutomaticModelsView = z.infer<typeof AutomaticModelsViewSchema>;
