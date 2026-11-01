import { BrowserProfileIdSchema, DeploymentIdSchema, RunnerIdSchema } from "@opensteer/core";
import { z } from "zod";

export const BrowserEngineSchema = z.enum(["electron", "chromium"]);
export type BrowserEngine = z.infer<typeof BrowserEngineSchema>;

export const LocalProfileBindingSchema = z.strictObject({
  version: z.literal(1),
  deploymentId: DeploymentIdSchema,
  profileId: BrowserProfileIdSchema,
  runnerId: RunnerIdSchema,
  storageInstanceId: z.uuid(),
  bindingId: z.uuid(),
  engine: BrowserEngineSchema,
});
export type LocalProfileBinding = z.infer<typeof LocalProfileBindingSchema>;

export const BrowserProfileStorageSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("unbound") }),
  z.strictObject({
    kind: z.literal("local"),
    binding: LocalProfileBindingSchema,
    initialized: z.boolean(),
  }),
]);
export type BrowserProfileStorage = z.infer<typeof BrowserProfileStorageSchema>;
export const HeldLocalProfileSchema = z.discriminatedUnion("phase", [
  z.strictObject({ phase: z.literal("ready"), binding: LocalProfileBindingSchema }),
  z.strictObject({
    phase: z.literal("deleted"),
    binding: LocalProfileBindingSchema,
    deletionId: z.uuid(),
    erasure: z.enum(["pending-restart", "deleted"]),
  }),
]);
export type HeldLocalProfile = z.infer<typeof HeldLocalProfileSchema>;
export const PendingBrowserProfileDeletionSchema = z.object({
  profileId: BrowserProfileIdSchema,
  computerId: RunnerIdSchema,
  state: z.enum(["pending-computer", "pending-restart"]),
});
export type PendingBrowserProfileDeletion = z.infer<typeof PendingBrowserProfileDeletionSchema>;

export const BrowserProfileDeletionSchema = PendingBrowserProfileDeletionSchema.extend({
  state: z.enum(["pending-computer", "pending-restart", "deleted"]),
});
export type BrowserProfileDeletion = z.infer<typeof BrowserProfileDeletionSchema>;
