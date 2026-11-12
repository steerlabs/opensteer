import { z } from "zod";

/** Opaque, base64url-joined path segments inside Agent home; never a path. */
export const FolderFileKeySchema = z
  .string()
  .max(5_462)
  .regex(/^[A-Za-z0-9_-]*$/);

const FolderFileCursorSchema = z
  .string()
  .min(22)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);

const FolderFileEntrySchema = z.strictObject({
  executable: z.boolean(),
  hidden: z.boolean(),
  key: FolderFileKeySchema,
  kind: z.enum(["directory", "file", "opaque", "symlink"]),
  mode: z.number().int().nonnegative().max(0o7777),
  modifiedAt: z.iso.datetime({ offset: true }).nullable(),
  /** A safe display label. Navigation always uses `key`, never this value. */
  name: z.string().min(1).max(1_024),
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

export const FolderDirectoryPageSchema = z.strictObject({
  cursor: FolderFileCursorSchema.nullable(),
  entries: z.array(FolderFileEntrySchema).max(500),
  parentKey: FolderFileKeySchema,
  /** Opaque digest of the returned page and directory metadata. */
  revision: z
    .string()
    .min(16)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
});
export type FolderDirectoryPage = z.infer<typeof FolderDirectoryPageSchema>;

export const folderFilePreviewMaxBytes = 512 * 1_024;
