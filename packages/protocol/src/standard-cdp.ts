import { BrowserProfileIdSchema, BrowserSessionIdSchema, IsoDateTimeSchema } from "@opensteer/core";
import { z } from "zod";

export const StandardCdpLeaseReconciliationSchema = z.strictObject({
  profileId: BrowserProfileIdSchema,
  generation: z.number().int().positive(),
});
export type StandardCdpLeaseReconciliation = z.infer<typeof StandardCdpLeaseReconciliationSchema>;
export const StandardCdpAttemptSchema = z.strictObject({
  attachmentId: z.uuid(),
  runtimeBootId: z.uuid(),
});
export const StandardCdpAttemptReconciliationSchema = StandardCdpAttemptSchema.extend({
  sessionId: BrowserSessionIdSchema,
  operationExpiresAt: IsoDateTimeSchema,
});
export type StandardCdpAttemptReconciliation = z.infer<
  typeof StandardCdpAttemptReconciliationSchema
>;
export const StandardCdpLeaseEvidenceSchema = z.strictObject({
  runtimeBootId: z.uuid(),
  attachmentId: z.uuid().optional(),
});

export const standardCdpLeasePath = "/v1/local-profiles/standard-cdp-lease";
export const standardCdpPath = "/v1/browser/cdp";
export const standardCdpDetachFrame = '{"type":"browser.detach-standard-cdp"}';
export const standardCdpSettledReason = "CDP attachment settled";
export {
  standardCdpMessageMaxBytes,
  standardCdpBufferedMaxBytes,
  standardCdpMaxPending,
} from "@opensteer/browser-core/standard-cdp-limits";
export const standardCdpChunkBytes = 192 * 1024;

export const StandardCdpChunkSchema = z.strictObject({
  type: z.literal("cdp.raw"),
  data: z
    .string()
    .min(1)
    .max((standardCdpChunkBytes / 3) * 4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/u),
  last: z.boolean(),
});
export type StandardCdpChunk = z.infer<typeof StandardCdpChunkSchema>;

export const StandardCdpModeSchema = z.enum(["session", "whole-context"]);
export type StandardCdpMode = z.infer<typeof StandardCdpModeSchema>;
