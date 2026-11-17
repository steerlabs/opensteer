import { FileSourceSchema } from "./file-sources.js";
import {
  imagePathMaxLength,
  ThreadIdSchema,
  ToolOutputImageMediaTypeSchema,
} from "@opensteer/core";
import { z } from "zod";

/** Paths one `asset.urls` call can resolve, so a screen of images costs one round trip. */
export const assetUrlsMaxPaths = 32;

/**
 * `preview` fits a phone screen (the Host resizes large raster images);
 * `original` is the file's own bytes, for a full-size view or a download.
 */
export const AssetVariantSchema = z.enum(["preview", "original"]);
export type AssetVariant = z.infer<typeof AssetVariantSchema>;

export const AssetUrlsInputSchema = z.strictObject({
  /** Optional owning task context; paths are decoded and the Host decides containment. */
  threadId: ThreadIdSchema.optional(),
  assets: z
    .array(
      z
        .strictObject({
          /** A file path, in the shape Hosts before `source` read; send paths this way. */
          path: z.string().min(1).max(imagePathMaxLength).optional(),
          source: FileSourceSchema.optional(),
          variant: AssetVariantSchema,
        })
        .refine((item) => (item.path === undefined) !== (item.source === undefined), {
          message: "Name a file by exactly one of path or source",
        }),
    )
    .min(1)
    .max(assetUrlsMaxPaths),
});
export type AssetUrlsInput = z.infer<typeof AssetUrlsInputSchema>;

export const AssetUrlSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    /**
     * A Host-relative address (`/media/…`) the client resolves against the
     * route it is using. Its token is the only authority, and it stays the same
     * for the same file, variant and expiry window, so caches keep hitting.
     */
    url: z.string().startsWith("/").max(8_192),
    expiresAt: z.iso.datetime(),
    /** Changes whenever the file's bytes may have; part of every client cache key. */
    revision: z.string().min(1).max(128),
    mediaType: ToolOutputImageMediaTypeSchema,
    /** Of the variant served, so a client reserves the image's space before it loads. */
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
  }),
  z.object({
    status: z.literal("unavailable"),
    reason: z.enum(["missing", "unsupported", "denied"]),
  }),
]);
export type AssetUrl = z.infer<typeof AssetUrlSchema>;

export const AssetUrlsSchema = z.object({
  /** One result per requested path, in request order. */
  assets: z.array(AssetUrlSchema).max(assetUrlsMaxPaths),
});
export type AssetUrls = z.infer<typeof AssetUrlsSchema>;
