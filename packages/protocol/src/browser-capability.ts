import { IsoDateTimeSchema } from "@opensteer/core";
import { z } from "zod";
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export const BrowserChannelIdSchema = z
  .string()
  .regex(new RegExp(`^bch_${uuid}$`, "i"))
  .brand<"BrowserChannelId">();
export type BrowserChannelId = z.infer<typeof BrowserChannelIdSchema>;

export const BrowserCapabilityLeaseIdSchema = z
  .string()
  .regex(new RegExp(`^bcl_${uuid}$`, "i"))
  .brand<"BrowserCapabilityLeaseId">();
export type BrowserCapabilityLeaseId = z.infer<typeof BrowserCapabilityLeaseIdSchema>;

/**
 * A time-bounded permission to serve browser sessions on one runtime. It is
 * separate from the stream lease: losing the grant stops new sessions without
 * tearing the module's transport down.
 */
export const BrowserCapabilityLeaseSchema = z.strictObject({
  capabilityGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  capabilityLeaseId: BrowserCapabilityLeaseIdSchema,
  expiresAt: IsoDateTimeSchema,
  runtimeId: z.string().min(1).max(255),
});
export type BrowserCapabilityLease = z.infer<typeof BrowserCapabilityLeaseSchema>;

export const BrowserCapabilityReferenceSchema = BrowserCapabilityLeaseSchema.pick({
  capabilityGeneration: true,
  capabilityLeaseId: true,
  runtimeId: true,
});
export type BrowserCapabilityReference = z.infer<typeof BrowserCapabilityReferenceSchema>;
