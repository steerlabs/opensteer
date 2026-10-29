import { ComputerViewRefSchema } from "./computer-view-requests.js";
import { z } from "zod";
import {
  ComputerViewRecordSchema,
  ComputerViewWindowSchema,
  ComputerViewTargetSchema,
  ComputerAppIdentityViewSchema,
  RunnerIdSchema,
} from "@opensteer/core";
export * from "./computer-view-requests.js";

export {
  ComputerViewIdSchema,
  ComputerViewTargetSchema,
  ComputerViewRecordSchema,
  ComputerViewUnavailableReasonSchema,
  type ComputerViewId,
  type ComputerViewTarget,
  type ComputerViewRecord,
  type ComputerViewUnavailableReason,
} from "@opensteer/core";
export const computerOwnerViewVersion = 1;
export const macOwnerViewVersion = 3;
/** Mac owner-view versions whose helper streams window video: 2 brought it, 3 addresses windows. */
export const macWindowVideoOwnerViewVersions: readonly number[] = [2, macOwnerViewVersion];
/**
 * What a Host tells clients about a Mac whose app views it can open. Clients
 * of the release before window-addressed views read only this value, so it
 * does not follow the Mac's own version.
 */
export const clientMacOwnerViewVersion = 2;
/** Runner + helper (or phone) must all positively advertise the same owner-view wire. */
export function computerOwnerViewSupported(
  kind: "app" | "phone",
  ...versions: readonly (number | undefined)[]
): boolean {
  return (
    versions.length >= 2 &&
    versions.every(
      (version) => version === (kind === "app" ? macOwnerViewVersion : computerOwnerViewVersion),
    )
  );
}
export const computerViewMaxPerOwner = 64;
export const computerViewIdleMs = { app: 10 * 60_000, phone: 3 * 60_000 } as const;
export const ComputerViewTargetViewSchema = z.discriminatedUnion("kind", [
  z.object({ ...ComputerViewTargetSchema.options[0].shape, app: ComputerAppIdentityViewSchema }),
  z.object(ComputerViewTargetSchema.options[1].shape),
]);
/** Owner-only projection: never carries the owner's identity or a native capture handle. */
export const ComputerViewSchema = z
  .object({
    ...z.object(ComputerViewRecordSchema.shape).omit({ ownerUserId: true, captureTargetId: true })
      .shape,
    target: ComputerViewTargetViewSchema,
  })
  .refine(
    (view) => view.state !== "ready" || view.unavailableReason === null,
    "A ready view has no refusal.",
  );
export type ComputerView = z.infer<typeof ComputerViewSchema>;
const idempotencyKey = z.string().min(1).max(255);
export const ComputerViewOpenCommandSchema = z.strictObject({
  type: z.literal("computer.view.open"),
  machineId: RunnerIdSchema,
  target: ComputerViewTargetSchema,
  idempotencyKey,
});
export const ComputerViewCloseCommandSchema = ComputerViewRefSchema.extend({
  type: z.literal("computer.view.close"),
  idempotencyKey,
});
export const ComputerViewRenewCommandSchema = ComputerViewRefSchema.extend({
  type: z.literal("computer.view.renew"),
  idempotencyKey,
});
export type ComputerViewOpenCommand = z.infer<typeof ComputerViewOpenCommandSchema>;
export type ComputerViewCloseCommand = z.infer<typeof ComputerViewCloseCommandSchema>;
export type ComputerViewRenewCommand = z.infer<typeof ComputerViewRenewCommandSchema>;
export const ComputerViewOpenResultSchema = z.object({
  type: z.literal("computer.view.open"),
  view: ComputerViewSchema,
});
export const ComputerViewCloseResultSchema = z.object({
  type: z.literal("computer.view.close"),
  view: ComputerViewSchema,
});
export const ComputerViewRenewResultSchema = z.object({
  type: z.literal("computer.view.renew"),
  view: ComputerViewSchema,
});
export const ComputerViewNativeUnavailableSchema = z.object({
  ...ComputerViewRefSchema.shape,
  kind: z.literal("unavailable"),
  reason: z.string().min(1).max(255),
});
export const ComputerViewRefusalReasonSchema = z.enum([
  "computer-view-unsupported",
  "computer-view-ended",
  "computer-view-stale-generation",
  "computer-view-idempotency-conflict",
  "computer-view-not-approved",
  "computer-view-unavailable",
  "computer-view-limit",
]);
export type ComputerViewRefusalReason = z.infer<typeof ComputerViewRefusalReasonSchema>;
export const ComputerViewNativeResultSchema = z.union([
  z.object({
    ...ComputerViewRefSchema.shape,
    state: z.enum(["ready", "closed"]),
    captureTargetId: z.string().min(1).max(255).nullable(),
    window: ComputerViewWindowSchema.nullable().optional(),
  }),
  ComputerViewNativeUnavailableSchema,
]);
export type ComputerViewNativeResult = z.infer<typeof ComputerViewNativeResultSchema>;
export const ComputerViewChangedSchema = z.object({
  type: z.literal("host.computer-view.changed"),
  view: ComputerViewSchema,
});
export const ComputerViewRemovedSchema = z.object({
  type: z.literal("host.computer-view.removed"),
  ...ComputerViewRefSchema.shape,
  machineId: RunnerIdSchema,
  reason: z.enum(["closed", "expired", "revoked", "disconnected", "host-restarted"]),
});
/** Joins existing connected, unblocked, owner-approved connections to device identities and icons. */
export const ApprovedComputerAppSchema = z.object({
  connectionId: z.string().min(1).max(255),
  machineId: RunnerIdSchema,
  target: ComputerViewTargetViewSchema,
  name: z.string().min(1).max(512),
  iconPng: z
    .string()
    .min(1)
    .max(256 * 1024)
    .nullable(),
});
export type ApprovedComputerApp = z.infer<typeof ApprovedComputerAppSchema>;
