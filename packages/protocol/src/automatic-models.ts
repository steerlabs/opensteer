import {
  DelegationModelChoiceSchema,
  HarnessIdSchema,
  ModelCandidateSkipReasonSchema,
  type SelectionCatalog,
} from "@opensteer/core";
import { HarnessModelDescriptorViewSchema } from "./runner.js";
import { z } from "zod";
import {
  AutomaticModelConfigViewSchema,
  AutomaticModelRankViewSchema,
  AutomaticModelSourceViewSchema,
  EnvironmentIdSchema,
  HarnessInstanceIdSchema,
  HarnessRuntimeRevisionSchema,
  ModelSelectionViewSchema,
} from "@opensteer/core";

/** A reason this client predates reads as plain text rather than failing the view. */
const SkipReasonViewSchema = z.union([ModelCandidateSkipReasonSchema, z.string()]);
/** Clients gate the read and the person-only command on this Host capability. */
export const automaticModelsCapability = "automatic-models-v1" as const;
const displayNames = {
  accountDisplayName: z.string(),
  computerDisplayName: z.string(),
};
/** What the editor needs from a catalog: Settings is read over cellular links. */
const AutomaticModelCatalogViewSchema = z.object({
  status: z.string(),
  detail: z.string().optional(),
  lightModel: DelegationModelChoiceSchema.strip().optional(),
  models: z.array(
    HarnessModelDescriptorViewSchema.pick({
      providerId: true,
      modelId: true,
      displayName: true,
      unavailableReason: true,
    }),
  ),
});
export function automaticModelCatalogView(catalog: SelectionCatalog | null) {
  return (
    catalog && {
      status: catalog.status,
      ...(catalog.detail ? { detail: catalog.detail } : {}),
      ...(catalog.lightModel
        ? { lightModel: { ...catalog.lightModel, options: catalog.lightModel.options ?? {} } }
        : {}),
      models: catalog.models.map(({ providerId, modelId, displayName, unavailableReason }) => ({
        providerId,
        modelId,
        displayName,
        ...(unavailableReason ? { unavailableReason } : {}),
      })),
    }
  );
}
export const AutomaticModelCandidateViewSchema = z.object({
  environmentId: EnvironmentIdSchema,
  harnessInstanceId: HarnessInstanceIdSchema,
  harnessRevision: HarnessRuntimeRevisionSchema,
  modelSelection: ModelSelectionViewSchema,
  usageLimited: z.boolean(),
  original: z.boolean(),
  providerDisplayName: z.string(),
  modelDisplayName: z.string(),
  ...displayNames,
});
export const AutomaticModelSkipViewSchema = z.object({
  want: AutomaticModelSourceViewSchema.nullable(),
  harnessInstanceId: HarnessInstanceIdSchema.optional(),
  environmentId: EnvironmentIdSchema.optional(),
  reason: SkipReasonViewSchema,
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
  config: AutomaticModelConfigViewSchema,
  maintainedDefaults: z.object({
    light: z.array(AutomaticModelRankViewSchema),
    deep: z.array(AutomaticModelRankViewSchema),
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
      catalog: AutomaticModelCatalogViewSchema.nullable(),
      eligible: z.boolean(),
      reason: SkipReasonViewSchema.nullable(),
    }),
  ),
  light: preview.extend({ label: z.literal("General preference") }),
  deep: preview,
});
export type AutomaticModelsView = z.infer<typeof AutomaticModelsViewSchema>;
