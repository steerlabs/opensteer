import { z } from "zod";
import {
  ComputerViewIdSchema,
  ComputerViewTargetSchema,
  ComputerAppIdentityViewSchema,
} from "@opensteer/core";

export const ComputerViewRefSchema = z.strictObject({
  viewId: ComputerViewIdSchema,
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type ComputerViewRef = z.infer<typeof ComputerViewRefSchema>;
export const ComputerViewAuthoritySchema = ComputerViewRefSchema.extend({
  leaseDurationMs: z.number().int().positive().max(600_000),
});
export type ComputerViewAuthority = z.infer<typeof ComputerViewAuthoritySchema>;
export const ComputerViewNativeRequestSchema = z.discriminatedUnion("method", [
  z.strictObject({
    method: z.literal("view.open"),
    ...ComputerViewAuthoritySchema.shape,
    target: ComputerViewTargetSchema,
  }),
  z.strictObject({ method: z.literal("view.renew"), ...ComputerViewAuthoritySchema.shape }),
  z.strictObject({ method: z.literal("view.close"), ...ComputerViewAuthoritySchema.shape }),
  z.strictObject({
    method: z.literal("view.activate"),
    ...ComputerViewAuthoritySchema.shape,
    app: ComputerAppIdentityViewSchema,
  }),
]);
export type ComputerViewNativeRequest = z.infer<typeof ComputerViewNativeRequestSchema>;
const computerViewHelperBase = {
  id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  timeoutMs: z.number().int().positive().max(60_000).optional(),
};
export const ComputerViewHelperRequestSchema = z.discriminatedUnion("method", [
  z.strictObject({
    ...computerViewHelperBase,
    method: z.literal("view.open"),
    params: ComputerViewNativeRequestSchema.options[0].omit({ method: true }),
  }),
  z.strictObject({
    ...computerViewHelperBase,
    method: z.literal("view.renew"),
    params: ComputerViewNativeRequestSchema.options[1].omit({ method: true }),
  }),
  z.strictObject({
    ...computerViewHelperBase,
    method: z.literal("view.close"),
    params: ComputerViewNativeRequestSchema.options[2].omit({ method: true }),
  }),
  z.strictObject({
    ...computerViewHelperBase,
    method: z.literal("view.activate"),
    params: ComputerViewNativeRequestSchema.options[3].omit({ method: true }),
  }),
]);
export type ComputerViewHelperRequest = z.infer<typeof ComputerViewHelperRequestSchema>;
