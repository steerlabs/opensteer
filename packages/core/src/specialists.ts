import { z } from "zod";
import { ComputerAppBundleIdSchema } from "./computer-app.js";
import { ModelPolicyEntrySchema, ModelPolicyEntryViewSchema } from "./background-models.js";
import { ResourceAccessLevelSchema } from "./resource-access.js";

const reason = z.string().trim().min(1).max(4_000);
const access = { level: ResourceAccessLevelSchema, reason };
export const SpecialistAccessRequirementSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("integration"),
    service: z.string().trim().min(1).max(255),
    ...access,
  }),
  z.strictObject({ type: z.literal("browser-profile"), ...access }),
  z.strictObject({
    type: z.literal("computer-app"),
    app: ComputerAppBundleIdSchema,
    ...access,
  }),
  z.strictObject({ type: z.literal("phone"), ...access }),
]);
export const SpecialistManifestSchema = z.strictObject({
  version: z.literal(1),
  models: z.array(ModelPolicyEntrySchema).min(1).max(8),
  fallback: z.enum(["none", "caller"]).default("none"),
  access: z.array(SpecialistAccessRequirementSchema).max(128).optional(),
});
export type SpecialistManifest = z.infer<typeof SpecialistManifestSchema>;
export type SpecialistAccessRequirement = z.infer<typeof SpecialistAccessRequirementSchema>;
export const SpecialistBindingSchema = z.strictObject({
  rebind: z.boolean().optional(),
  requirement: z.number().int().nonnegative(),
  resourceId: z.string().min(1),
  level: ResourceAccessLevelSchema,
});
export type SpecialistBinding = z.infer<typeof SpecialistBindingSchema>;

const SpecialistAccessRequirementViewSchema = z.discriminatedUnion("type", [
  SpecialistAccessRequirementSchema.options[0].strip(),
  SpecialistAccessRequirementSchema.options[1].strip(),
  SpecialistAccessRequirementSchema.options[2].strip(),
  SpecialistAccessRequirementSchema.options[3].strip(),
]);

export const SpecialistRegistrationViewSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  pluginId: z.string().min(1),
  pluginVersionId: z.string().min(1),
  ownerUserId: z.string().min(1),
  ownerName: z.string().optional(),
  canUse: z.boolean().optional(),
  plugin: z.string(),
  version: z.string(),
  status: z.enum(["pending", "ready", "removing", "removal-failed"]),
  models: z.array(ModelPolicyEntryViewSchema).min(1).max(8),
  fallback: z.enum(["none", "caller"]),
  access: z.array(
    z.intersection(
      SpecialistAccessRequirementViewSchema,
      z.object({
        binding: SpecialistBindingSchema.strip().nullable(),
        state: z.enum(["bound", "choose", "needs-access", "rebind"]),
        candidates: z.array(z.object({ resourceId: z.string().min(1), name: z.string() })),
      }),
    ),
  ),
});
export const SpecialistRegistrationSchema = SpecialistRegistrationViewSchema;
export type SpecialistRegistration = z.infer<typeof SpecialistRegistrationSchema>;
