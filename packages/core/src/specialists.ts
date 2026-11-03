import { z } from "zod";
import { ComputerAppBundleIdSchema } from "./computer-app.js";
import { harnessKinds } from "./harness-catalog.js";
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
  models: z
    .array(
      z.strictObject({
        engine: z
          .string()
          .refine((value) => harnessKinds.some((kind) => kind === value), "Unknown engine"),
        model: z.string().trim().min(1).max(255),
        options: z.record(z.string(), z.json()).optional(),
      }),
    )
    .min(1)
    .max(8),
  fallback: z.enum(["none", "caller"]).default("none"),
  access: z.array(SpecialistAccessRequirementSchema).max(128).optional(),
});
export type SpecialistManifest = z.infer<typeof SpecialistManifestSchema>;
export type SpecialistAccessRequirement = z.infer<typeof SpecialistAccessRequirementSchema>;
export const SpecialistBindingSchema = z.strictObject({
  requirement: z.number().int().nonnegative(),
  resourceId: z.string().min(1),
  level: ResourceAccessLevelSchema,
});
export type SpecialistBinding = z.infer<typeof SpecialistBindingSchema>;
