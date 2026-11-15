import { z } from "zod";
import {
  ComputerViewIdSchema,
  LegacyComputerViewTargetSchema,
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
export const LegacyComputerViewNativeRequestSchema = z.discriminatedUnion("method", [
  z.strictObject({
    method: z.literal("view.open"),
    ...ComputerViewAuthoritySchema.shape,
    target: LegacyComputerViewTargetSchema,
  }),
  z.strictObject({ method: z.literal("view.renew"), ...ComputerViewAuthoritySchema.shape }),
  z.strictObject({ method: z.literal("view.close"), ...ComputerViewAuthoritySchema.shape }),
  z.strictObject({
    method: z.literal("view.activate"),
    ...ComputerViewAuthoritySchema.shape,
    app: ComputerAppIdentityViewSchema,
  }),
]);
export type LegacyComputerViewNativeRequest = z.infer<typeof LegacyComputerViewNativeRequestSchema>;
const computerViewHelperBase = {
  id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  timeoutMs: z.number().int().positive().max(60_000).optional(),
};
export const LegacyComputerViewHelperRequestSchema = z.discriminatedUnion("method", [
  z.strictObject({
    ...computerViewHelperBase,
    method: z.literal("view.open"),
    params: LegacyComputerViewNativeRequestSchema.options[0].omit({ method: true }),
  }),
  z.strictObject({
    ...computerViewHelperBase,
    method: z.literal("view.renew"),
    params: LegacyComputerViewNativeRequestSchema.options[1].omit({ method: true }),
  }),
  z.strictObject({
    ...computerViewHelperBase,
    method: z.literal("view.close"),
    params: LegacyComputerViewNativeRequestSchema.options[2].omit({ method: true }),
  }),
  z.strictObject({
    ...computerViewHelperBase,
    method: z.literal("view.activate"),
    params: LegacyComputerViewNativeRequestSchema.options[3].omit({ method: true }),
  }),
]);
export type LegacyComputerViewHelperRequest = z.infer<typeof LegacyComputerViewHelperRequestSchema>;

import { ComputerViewTargetSchema } from "@opensteer/core";
export const ComputerViewNativeRequestSchema = z.discriminatedUnion("method", [
  LegacyComputerViewNativeRequestSchema.options[0].extend({ target: ComputerViewTargetSchema }),
  LegacyComputerViewNativeRequestSchema.options[1],
  LegacyComputerViewNativeRequestSchema.options[2],
  LegacyComputerViewNativeRequestSchema.options[3],
]);
export type ComputerViewNativeRequest = z.infer<typeof ComputerViewNativeRequestSchema>;
export const ComputerViewHelperRequestSchema = z.discriminatedUnion("method", [
  LegacyComputerViewHelperRequestSchema.options[0].extend({
    params: ComputerViewNativeRequestSchema.options[0].omit({ method: true }),
  }),
  LegacyComputerViewHelperRequestSchema.options[1],
  LegacyComputerViewHelperRequestSchema.options[2],
  LegacyComputerViewHelperRequestSchema.options[3],
]);
export type ComputerViewHelperRequest = z.infer<typeof ComputerViewHelperRequestSchema>;
