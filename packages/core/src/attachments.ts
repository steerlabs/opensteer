import { z } from "zod";
import {
  AttachmentIdSchema,
  MessageIdSchema,
  ThreadIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
} from "./ids.js";

export const attachmentMaxBytes = 25 * 1_024 * 1_024;
export const attachmentMessageMaxBytes = 50 * 1_024 * 1_024;
export const attachmentMessageMaxCount = 10;
export const attachmentPendingMaxBytes = 250 * 1_024 * 1_024;
/**
 * The Host's resource bound on one decoded image. It admits 48 MP phone photos,
 * 8192×6144 "50 MP" sensor output and panoramas; each engine driver fits what it
 * delivers to its own engine, so this is not a model limit.
 */
export const attachmentImageMaxPixels = 100_000_000;
export const attachmentUploadLifetimeMs = 24 * 60 * 60 * 1_000;
export const attachmentPageMaxEntries = 100;
export const attachmentNativeImageMediaTypes = ["image/png", "image/jpeg", "image/webp"] as const;

const isoBaseMediaBrands: ReadonlyMap<string, string> = new Map([
  ["avif", "image/avif"],
  ["avis", "image/avif"],
  ["heic", "image/heic"],
  ["heix", "image/heic"],
  ["heim", "image/heic"],
  ["heis", "image/heic"],
  ["hevc", "image/heic"],
  ["hevx", "image/heic"],
  ["hevm", "image/heic"],
  ["hevs", "image/heic"],
  ["mif1", "image/heif"],
  ["msf1", "image/heif"],
]);

/**
 * The image format the leading bytes of a file actually hold, or null when they
 * are not a recognized image. Pickers and browsers label files by name or leave
 * the type empty; the Host refuses a label its decoded bytes contradict, so a
 * client names a file by its contents before reserving the upload.
 */
export function detectImageMediaType(bytes: Uint8Array): string | null {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    ascii(1, 4) === "PNG" &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  )
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a"))
    return "image/gif";
  if (bytes.length >= 16 && ascii(4, 8) === "ftyp") {
    const boxSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    const end = Math.min(bytes.length, Math.max(16, boxSize));
    // The major brand names the file; a generic `mif1`/`msf1` major brand
    // defers to the first specific compatible brand.
    const brands = [ascii(8, 12)];
    for (let offset = 16; offset + 4 <= end; offset += 4) brands.push(ascii(offset, offset + 4));
    const specific = brands
      .map((brand) => isoBaseMediaBrands.get(brand))
      .find((mediaType) => mediaType !== undefined && mediaType !== "image/heif");
    if (specific) return specific;
    if (brands.some((brand) => isoBaseMediaBrands.has(brand))) return "image/heif";
  }
  return null;
}

export const AttachmentNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (name) =>
      name !== "." &&
      name !== ".." &&
      !/[\p{Cc}/\\]/u.test(name) &&
      new TextEncoder().encode(name).byteLength <= 255,
    "Choose a filename without path separators or control characters, at most 255 bytes",
  );
export const AttachmentMediaTypeSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u);
export const AttachmentDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

const attachmentShape = {
  createdAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  height: z.number().int().positive().nullable(),
  id: AttachmentIdSchema,
  kind: z.enum(["image", "file"]).nullable(),
  mediaType: AttachmentMediaTypeSchema,
  messageId: MessageIdSchema.nullable(),
  name: AttachmentNameSchema,
  sha256: AttachmentDigestSchema.nullable(),
  sizeBytes: z.number().int().nonnegative().max(attachmentMaxBytes),
  state: z.enum(["uploading", "ready", "deleting"]),
  threadId: ThreadIdSchema.nullable(),
  uploaderId: UserIdSchema,
  width: z.number().int().positive().nullable(),
  workspaceId: WorkspaceIdSchema,
} as const;

export const AttachmentSchema = z.object(attachmentShape);
export type Attachment = z.infer<typeof AttachmentSchema>;
export const ReadyAttachmentSchema = AttachmentSchema.extend({
  kind: z.enum(["image", "file"]),
  sha256: AttachmentDigestSchema,
  state: z.literal("ready"),
});
export type ReadyAttachment = z.infer<typeof ReadyAttachmentSchema>;

export const AttachmentPageSchema = z.object({
  attachments: z.array(ReadyAttachmentSchema).max(attachmentPageMaxEntries),
  nextCursor: AttachmentIdSchema.nullable(),
});
export type AttachmentPage = z.infer<typeof AttachmentPageSchema>;
