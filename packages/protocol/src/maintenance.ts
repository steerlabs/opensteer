import { z } from "zod";
import { DesktopUpdateChannelSchema, DesktopUpdateStateSchema } from "./desktop-update-state.js";
export { DesktopUpdateChannelSchema, DesktopUpdateStateSchema } from "./desktop-update-state.js";
export type { DesktopUpdateChannel, DesktopUpdateState } from "./desktop-update-state.js";

// Maintenance v1 survives Host API epochs: evolve only with optional additions.
export const desktopUpdateLongPollMs = 25_000;
export const desktopUpdateMaximumBytes = 16_384;
const version = z.string().min(1).max(64);
export const DesktopUpdateIntentSchema = z.union([
  z.object({ action: z.literal("update") }),
  z.object({ action: z.literal("channel"), channel: DesktopUpdateChannelSchema }),
]);
export type DesktopUpdateIntent = z.infer<typeof DesktopUpdateIntentSchema>;
export const DesktopUpdatePhaseSchema = z.enum([
  "pending",
  "running",
  "staged",
  "installing",
  "succeeded",
  "failed",
]);
export type DesktopUpdatePhase = z.infer<typeof DesktopUpdatePhaseSchema>;
export const DesktopUpdateRequestSchema = z.object({
  idempotencyKey: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_.:-]+$/u),
  intent: DesktopUpdateIntentSchema,
});
export type DesktopUpdateRequest = z.infer<typeof DesktopUpdateRequestSchema>;
export const DesktopUpdateOperationSchema = z.object({
  id: z.string().uuid(),
  intent: DesktopUpdateIntentSchema,
  state: DesktopUpdatePhaseSchema,
  fromVersion: version.nullable(),
  targetVersion: version.nullable(),
  incarnationId: z.string().uuid().nullable(),
  detail: z
    .enum(["up-to-date", "ahead", "not-applied", "update-failed", "handoff-failed"])
    .nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type DesktopUpdateOperation = z.infer<typeof DesktopUpdateOperationSchema>;
export const DesktopUpdateStatusSchema = z.object({
  supported: z.boolean(),
  state: DesktopUpdateStateSchema.nullable(),
  operation: DesktopUpdateOperationSchema.nullable(),
  revision: z.string().min(1).max(100),
});
export type DesktopUpdateStatus = z.infer<typeof DesktopUpdateStatusSchema>;
export const DesktopUpdateStatusQuerySchema = z.object({
  after: z.string().min(1).max(100).optional(),
});
