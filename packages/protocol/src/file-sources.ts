import { AttachmentIdSchema, SequenceSchema, imagePathMaxLength } from "@opensteer/core";
import { z } from "zod";

/** Paths are already decoded; callers must not percent-decode them again. */
export const FileSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("path"), path: z.string().min(1).max(imagePathMaxLength) }),
  z.strictObject({ kind: z.literal("attachment"), attachmentId: AttachmentIdSchema }),
]);
export type FileSource = z.infer<typeof FileSourceSchema>;
const revision = z.string().min(1).max(128);
const resourceShapes = {
  home: { kind: z.literal("home"), key: z.string().min(1).max(16_384), revision },
  attachment: { kind: z.literal("attachment"), attachmentId: AttachmentIdSchema, revision },
  outputImage: {
    kind: z.literal("output-image"),
    sequence: SequenceSchema,
    index: z.number().int().nonnegative(),
    revision,
  },
};
export const FileResourceSchema = z.discriminatedUnion("kind", [
  z.strictObject(resourceShapes.home),
  z.strictObject(resourceShapes.attachment),
  z.strictObject(resourceShapes.outputImage),
]);
export type FileResource = z.infer<typeof FileResourceSchema>;
/** The same resource as a Host returns it: newer fields are dropped, not refused. */
export const FileResourceViewSchema = z.discriminatedUnion("kind", [
  z.object(resourceShapes.home),
  z.object(resourceShapes.attachment),
  z.object(resourceShapes.outputImage),
]);
