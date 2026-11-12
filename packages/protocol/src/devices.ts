import { z } from "zod";
import { RunnerIdSchema } from "@opensteer/core";

export const DeviceInitialAccessSchema = z.strictObject({
  browser: z.boolean(),
  apps: z.boolean(),
  files: z.boolean(),
});
export type DeviceInitialAccess = z.infer<typeof DeviceInitialAccessSchema>;
export const DeviceSessionBindingProofSchema = z.strictObject({
  issuedAt: z.iso.datetime({ offset: true }),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
export type DeviceSessionBindingProof = z.infer<typeof DeviceSessionBindingProofSchema>;
export const RunnerLeaveRequestSchema = z.strictObject({
  deploymentId: z.string().min(1).max(255),
  runnerId: z.string().min(1).max(255),
  ...DeviceSessionBindingProofSchema.shape,
});
export type RunnerLeaveRequest = z.infer<typeof RunnerLeaveRequestSchema>;
export const RunnerLeaveResponseSchema = z.object({ outcome: z.literal("removed") });
export type RunnerLeaveResponse = z.infer<typeof RunnerLeaveResponseSchema>;

export const DevicePreparedIdentitySchema = z.strictObject({
  runnerId: RunnerIdSchema,
  publicKeyPem: z.string().min(1).max(4096),
});
export type DevicePreparedIdentity = z.infer<typeof DevicePreparedIdentitySchema>;

export const DeviceRefusalContextSchema = z.object({
  machineId: RunnerIdSchema,
  capability: z.enum(["browser", "apps", "files"]),
});
export type DeviceRefusalContext = z.infer<typeof DeviceRefusalContextSchema>;
