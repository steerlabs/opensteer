import { AttachmentIdSchema, attachmentMaxBytes } from "@opensteer/core";
import { z } from "zod";

export const AttachmentReferenceInputSchema = z.strictObject({ attachmentId: AttachmentIdSchema });

export const AttachmentContentMetadataSchema = z.object({
  contentType: z.string().min(1).max(255),
  etag: z.string().min(1).max(255),
  modifiedAt: z.iso.datetime({ offset: true }).nullable(),
  sizeBytes: z.number().int().nonnegative().max(attachmentMaxBytes),
  truncated: z.literal(false),
});

export const AttachmentContentSchema = z.object({
  bytes: z.instanceof(Uint8Array),
  metadata: AttachmentContentMetadataSchema,
});

export const RunAttachmentPlanSchema = z.strictObject({
  token: z.string().min(1).max(32_768),
});
export type RunAttachmentPlan = z.infer<typeof RunAttachmentPlanSchema>;
