import { z } from "zod";

import { BrowserSurfaceIdSchema, RunnerIdSchema, ThreadIdSchema } from "@opensteer/core";

import { keyedStreamSchema } from "./keyed-stream.js";
export const browserPersonalTabUrlMaxLength = 16_384;

export const browserFaviconMaxBytes = 16 * 1_024;

export const BrowserFaviconSchema = z
  .string()
  .max(64 + Math.ceil(browserFaviconMaxBytes / 3) * 4)
  .regex(/^data:image\/(?:png|x-icon|gif|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/);

export const BrowserPlacementSelectorSchema = z.strictObject({
  kind: z.literal("runner"),
  runnerId: RunnerIdSchema,
});

export const BrowserPlacementSelectorViewSchema = z.object(BrowserPlacementSelectorSchema.shape);

export const HostedBrowserSessionStateSchema = z.enum([
  "starting",
  "ready",
  "closing",
  "closed",
  "failed",
]);

export const browserSessionMaxAttachedRuns = 128;

export const browserSessionMaxThreads = 16;

export const BrowserPagePresenceSchema = z.object({
  title: z.string().max(256),
  url: z.string().max(2048),
});

export const BrowserTabIconRefSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

export const BrowserSessionOpenerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("you") }),
  z.object({ kind: z.literal("task"), threadId: ThreadIdSchema }),
  z.object({ kind: z.literal("opensteer") }),
  z.object({ kind: z.literal("automation") }),
  z.object({ kind: z.literal("unknown") }),
]);

export const BrowserIconKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const BrowserTabRecordSchema = z.strictObject({
  id: BrowserSurfaceIdSchema,
  state: z.enum(["live", "suspended"]),
  title: z.string().max(256),
  url: z.string().max(browserPersonalTabUrlMaxLength),
  icon: BrowserIconKeySchema.nullable(),
  order: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  openerId: BrowserSurfaceIdSchema.nullable(),
  creatorAttachmentId: z.uuid().optional(),
  documentId: z.string().min(1).max(255),
  geometryRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  loading: z.boolean(),
  navigationFailed: z.boolean(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  sizedByAgent: z.boolean(),
  /**
   * The last wake opened this tab again at its address (ms since the epoch): its history, scroll
   * and page state are gone, and the person is told so once. Absent for a tab that came back as
   * it was.
   */
  reopenedAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});
export type BrowserTabRecord = z.infer<typeof BrowserTabRecordSchema>;
export const BrowserTabStreamMetaSchema = z.strictObject({
  activeId: BrowserSurfaceIdSchema.nullable(),
  inventoryRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type BrowserTabStreamMeta = z.infer<typeof BrowserTabStreamMetaSchema>;
export const BrowserTabStreamSchema = keyedStreamSchema(
  BrowserTabRecordSchema,
  BrowserTabStreamMetaSchema,
);
export const BrowserSavedTabStreamSchema = keyedStreamSchema(
  z.strictObject({ id: BrowserSurfaceIdSchema }),
  z.strictObject({}),
);
export const BrowserViewerSurfaceSchema = BrowserTabRecordSchema.omit({
  icon: true,
  order: true,
  openerId: true,
  creatorAttachmentId: true,
}).extend({ favicon: BrowserFaviconSchema.nullable() });
export type BrowserViewerSurface = z.infer<typeof BrowserViewerSurfaceSchema>;
