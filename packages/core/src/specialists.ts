import { z } from "zod";
import { ModelPolicyEntrySchema, ModelPolicyEntryViewSchema } from "./background-models.js";

export const SpecialistManifestSchema = z.strictObject({
  version: z.literal(1),
  models: z.array(ModelPolicyEntrySchema).min(1).max(8),
  fallback: z.enum(["none", "caller"]).default("none"),
  /** Installed manifests may carry this; it grants and limits nothing. */
  access: z.array(z.unknown()).optional(),
});
export type SpecialistManifest = z.infer<typeof SpecialistManifestSchema>;
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
  /** Older clients on this protocol epoch require this field; nothing reads it now. */
  access: z.array(z.unknown()).optional(),
});
export type SpecialistRegistration = z.infer<typeof SpecialistRegistrationViewSchema>;
