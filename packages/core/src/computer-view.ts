import { z } from "zod";
import { RunnerIdSchema, UserIdSchema } from "./ids.js";
import { IsoDateTimeSchema } from "./models.js";
import { ComputerAppIdentitySchema } from "./computer-app.js";

export const ComputerViewIdSchema = z
  .string()
  .regex(/^cvw_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
export type ComputerViewId = z.infer<typeof ComputerViewIdSchema>;
export const ComputerWindowIdSchema = z.number().int().nonnegative();
export const ComputerViewWindowSchema = z.object({
  id: ComputerWindowIdSchema,
  title: z.string().max(1_024),
});
export type ComputerViewWindow = z.infer<typeof ComputerViewWindowSchema>;
export const ComputerViewTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("app"),
    app: ComputerAppIdentitySchema,
    window: ComputerWindowIdSchema.optional(),
  }),
  z.strictObject({ kind: z.literal("phone"), display: z.string().min(1).max(255) }),
]);
export type ComputerViewTarget = z.infer<typeof ComputerViewTargetSchema>;
export const ComputerViewUnavailableReasonSchema = z.enum([
  "locked",
  "minimized",
  "window-closed",
  "window-unreadable",
  "accessibility-error",
  "capture-failed",
  "capture-timeout",
  "capacity",
  "offline",
  "unsupported",
  "permission-required",
  "connection-revoked",
  "target-unavailable",
  "paused",
  "protected",
  "expired",
  "closed",
  "host-restarted",
]);
export type ComputerViewUnavailableReason = z.infer<typeof ComputerViewUnavailableReasonSchema>;
/** Private authority record. A view never holds a Run, a control grant, or an app reservation. */
export const ComputerViewRecordSchema = z
  .strictObject({
    ownerUserId: UserIdSchema,
    connectionId: z.string().min(1).max(255),
    machineId: RunnerIdSchema,
    target: ComputerViewTargetSchema,
    window: ComputerViewWindowSchema.nullable().default(null),
    viewId: ComputerViewIdSchema,
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    captureTargetId: z.string().min(1).max(255).nullable(),
    state: z.enum(["opening", "ready", "unavailable", "closed", "expired"]),
    openedAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
    unavailableReason: ComputerViewUnavailableReasonSchema.nullable(),
  })
  .refine(
    (view) =>
      view.state !== "ready" ||
      ((view.target.kind === "phone" || view.captureTargetId !== null) &&
        view.unavailableReason === null),
    "A ready view requires a verified capture target and no refusal.",
  );
export type ComputerViewRecord = z.infer<typeof ComputerViewRecordSchema>;
