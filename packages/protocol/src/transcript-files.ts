import { ThreadIdSchema } from "@opensteer/core";
import { z } from "zod";
import { AssetUrlSchema } from "./assets.js";
import { FileSourceSchema, FileResourceSchema } from "./file-sources.js";

export const transcriptFilePreviewMaxBytes = 512 * 1024;
export const transcriptFileContentMaxBytes = 32 * 1024 * 1024;
export const TranscriptFileOpenInputSchema = z.strictObject({
  threadId: ThreadIdSchema.nullable(),
  source: FileSourceSchema,
});
export const TranscriptFileOpenSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("unavailable") }),
  z.strictObject({
    status: z.literal("ok"),
    resource: FileResourceSchema,
    name: z.string().min(1).max(4096),
    sizeBytes: z.number().int().nonnegative(),
    mediaType: z.string().min(1).max(255),
    preview: z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("text"),
        text: z
          .string()
          .refine(
            (value) => new TextEncoder().encode(value).byteLength <= transcriptFilePreviewMaxBytes,
          ),
        truncated: z.boolean(),
      }),
      z.strictObject({ kind: z.literal("image"), image: AssetUrlSchema }),
      z.strictObject({ kind: z.literal("download") }),
    ]),
  }),
]);
export const TranscriptFileContentInputSchema = z.strictObject({
  threadId: ThreadIdSchema.nullable(),
  resource: FileResourceSchema,
});
export const TranscriptFileContentSchema = z.strictObject({
  bytes: z
    .instanceof(Uint8Array)
    .refine((value) => value.byteLength <= transcriptFileContentMaxBytes),
  metadata: z.strictObject({
    contentType: z.string().min(1).max(255),
    etag: z.string().min(1).max(255),
    modifiedAt: z.iso.datetime({ offset: true }).nullable(),
    sizeBytes: z.number().int().nonnegative().max(transcriptFileContentMaxBytes),
    truncated: z.literal(false),
  }),
});
export type TranscriptFileOpenInput = z.infer<typeof TranscriptFileOpenInputSchema>;
export type TranscriptFileOpen = z.infer<typeof TranscriptFileOpenSchema>;
export type TranscriptFileContentInput = z.infer<typeof TranscriptFileContentInputSchema>;
export type TranscriptFileContent = z.infer<typeof TranscriptFileContentSchema>;
