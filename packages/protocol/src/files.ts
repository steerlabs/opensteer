import { z } from "zod";

export const FolderFileKeySchema = z
  .string()
  .max(5_462)
  .regex(/^[A-Za-z0-9_-]*$/);
export type FolderFileKey = z.infer<typeof FolderFileKeySchema>;

export const FolderFileCursorSchema = z
  .string()
  .min(22)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);

export const FolderFileKindSchema = z.enum(["directory", "file", "opaque", "symlink"]);

export const FolderFileEntrySchema = z.strictObject({
  executable: z.boolean(),
  hidden: z.boolean(),
  key: FolderFileKeySchema,
  kind: FolderFileKindSchema,
  mode: z.number().int().nonnegative().max(0o7777),
  modifiedAt: z.iso.datetime({ offset: true }).nullable(),
  /** A safe display label. Navigation always uses `key`, never this value. */
  name: z.string().min(1).max(1_024),
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
const FolderFileEntryViewSchema = z.object(FolderFileEntrySchema.shape);
export type FolderFileEntry = z.infer<typeof FolderFileEntrySchema>;

export const folderDirectoryPageMaxEntries = 500;
export const folderDirectoryPageDefaultEntries = 200;

export const FolderFileRevisionSchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

export const FolderDirectoryPageSchema = z.strictObject({
  cursor: FolderFileCursorSchema.nullable(),
  entries: z.array(FolderFileEntrySchema).max(folderDirectoryPageMaxEntries),
  parentKey: FolderFileKeySchema,
  /** Opaque digest of the returned page and directory metadata. */
  revision: FolderFileRevisionSchema,
});
export const FolderDirectoryPageViewSchema = z.object({
  ...FolderDirectoryPageSchema.shape,
  entries: z.array(FolderFileEntryViewSchema).max(folderDirectoryPageMaxEntries),
});
export type FolderDirectoryPage = z.infer<typeof FolderDirectoryPageSchema>;

export const folderFilePreviewMaxBytes = 512 * 1_024;

export const FolderFilePreviewMetadataSchema = z.strictObject({
  contentType: z.string().min(1).max(255),
  etag: z.string().min(1).max(255),
  modifiedAt: z.iso.datetime({ offset: true }).nullable(),
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  truncated: z.boolean(),
});
export const FolderFilePreviewMetadataViewSchema = z.object(FolderFilePreviewMetadataSchema.shape);
export type FolderFilePreviewMetadata = z.infer<typeof FolderFilePreviewMetadataSchema>;
