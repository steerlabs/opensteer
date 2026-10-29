import { z } from "zod";

/**
 * The shapes a local-directory read produces. They live here rather than in the
 * native helper client because the same values now travel twice: once from the
 * helper to the owning Runner, and once from that Runner to the Host over the
 * Runner socket. One definition keeps the two hops from drifting.
 */
export const localFilesMaximumDirectoryOffset = 1_000_000;
export const localFilesMaximumPageEntries = 500;
export const localFilesMaximumReadBytes = 512 * 1_024;

export const LocalFileRevisionSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/u);

export const LocalFileMetadataSchema = z.strictObject({
  modifiedAt: z.iso.datetime({ offset: true }).nullable(),
  mode: z.number().int().nonnegative().max(0o7777),
  revision: LocalFileRevisionSchema,
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type LocalFileMetadata = z.infer<typeof LocalFileMetadataSchema>;

export const LocalDirectoryEntrySchema = z.strictObject({
  displayName: z.string().min(1).max(1_024),
  executable: z.boolean(),
  hidden: z.boolean(),
  kind: z.enum(["directory", "file", "opaque", "symlink"]),
  mode: z.number().int().nonnegative().max(0o7777),
  modifiedAt: z.iso.datetime({ offset: true }).nullable(),
  nameBase64: z
    .string()
    .max(342)
    .regex(/^[A-Za-z0-9_-]+$/u),
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

export const LocalDirectoryListingSchema = z.strictObject({
  directoryRevision: LocalFileRevisionSchema,
  entries: z.array(LocalDirectoryEntrySchema).max(localFilesMaximumPageEntries),
  hasMore: z.boolean(),
  nextOffset: z
    .number()
    .int()
    .nonnegative()
    .max(localFilesMaximumDirectoryOffset + localFilesMaximumPageEntries),
});
export type LocalDirectoryListing = z.infer<typeof LocalDirectoryListingSchema>;

export const LocalPathSegmentBase64Schema = z
  .string()
  .min(1)
  .max(1_366)
  .regex(/^[A-Za-z0-9_-]+$/u);
