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

export const FrozenProfileSeedSchema = z.strictObject({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type FrozenProfileSeed = z.infer<typeof FrozenProfileSeedSchema>;

export const BrowserProfileStorageSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("vault") }),
  z.strictObject({
    kind: z.literal("initializing"),
    binding: LocalProfileBindingSchema,
    seed: FrozenProfileSeedSchema,
  }),
  z.strictObject({
    kind: z.literal("local"),
    binding: LocalProfileBindingSchema,
    seed: FrozenProfileSeedSchema,
  }),
]);
export type BrowserProfileStorage = z.infer<typeof BrowserProfileStorageSchema>;

export const HeldLocalProfileSchema = z.discriminatedUnion("phase", [
  z.strictObject({
    phase: z.enum(["initializing", "ready"]),
    binding: LocalProfileBindingSchema,
    seed: FrozenProfileSeedSchema,
  }),
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
