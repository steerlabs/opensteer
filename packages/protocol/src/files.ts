import { z } from "zod";

/**
 * An opaque, backing-owned reference to an entry inside one Workspace.
 * Clients must only return keys to the Host that issued them. The empty string
 * always names the Workspace root; no key is a host filesystem path.
 */
export const WorkspaceFileKeySchema = z
  .string()
  .max(5_462)
  .regex(/^[A-Za-z0-9_-]*$/);
export type WorkspaceFileKey = z.infer<typeof WorkspaceFileKeySchema>;

export const WorkspaceFileCursorSchema = z
  .string()
  .min(22)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);

export const WorkspaceFileKindSchema = z.enum(["directory", "file", "opaque", "symlink"]);

export const WorkspaceFileEntrySchema = z.strictObject({
  executable: z.boolean(),
  hidden: z.boolean(),
  key: WorkspaceFileKeySchema,
  kind: WorkspaceFileKindSchema,
  mode: z.number().int().nonnegative().max(0o7777),
  modifiedAt: z.iso.datetime({ offset: true }).nullable(),
  /** A safe display label. Navigation always uses `key`, never this value. */
  name: z.string().min(1).max(1_024),
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
const WorkspaceFileEntryViewSchema = z.object(WorkspaceFileEntrySchema.shape);
export type WorkspaceFileEntry = z.infer<typeof WorkspaceFileEntrySchema>;

export const workspaceDirectoryPageMaxEntries = 500;
export const workspaceDirectoryPageDefaultEntries = 200;

export const WorkspaceFileRevisionSchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

export const WorkspaceDirectoryPageSchema = z.strictObject({
  cursor: WorkspaceFileCursorSchema.nullable(),
  entries: z.array(WorkspaceFileEntrySchema).max(workspaceDirectoryPageMaxEntries),
  parentKey: WorkspaceFileKeySchema,
  /** Opaque digest of the returned page and directory metadata. */
  revision: WorkspaceFileRevisionSchema,
});
export const WorkspaceDirectoryPageViewSchema = z.object({
  ...WorkspaceDirectoryPageSchema.shape,
  entries: z.array(WorkspaceFileEntryViewSchema).max(workspaceDirectoryPageMaxEntries),
});
export type WorkspaceDirectoryPage = z.infer<typeof WorkspaceDirectoryPageSchema>;

export const workspaceFilePreviewMaxBytes = 512 * 1_024;

export const WorkspaceFilePreviewMetadataSchema = z.strictObject({
  contentType: z.string().min(1).max(255),
  etag: z.string().min(1).max(255),
  modifiedAt: z.iso.datetime({ offset: true }).nullable(),
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  truncated: z.boolean(),
});
export const WorkspaceFilePreviewMetadataViewSchema = z.object(
  WorkspaceFilePreviewMetadataSchema.shape,
);
export type WorkspaceFilePreviewMetadata = z.infer<typeof WorkspaceFilePreviewMetadataSchema>;
