import { z } from "zod";
import { BrowserProfileAccessSchema } from "@opensteer/browser-profile/grant";
import {
  BrowserSurfaceIdSchema,
  BrowserProfileIdSchema,
  BrowserSessionIdSchema,
  IsoDateTimeSchema,
  WorkspaceIdSchema,
  RunnerIdSchema,
  RunIdSchema,
  ThreadIdSchema,
} from "@opensteer/core";
import { PlaceOccupantSchema } from "./places.js";
import { keyedStreamSchema } from "./keyed-stream.js";
export const browserWorkspaceTabUrlMaxLength = 16_384;

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
  url: z.string().max(browserWorkspaceTabUrlMaxLength),
  icon: BrowserIconKeySchema.nullable(),
  order: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  openerId: BrowserSurfaceIdSchema.nullable(),
  documentId: z.string().min(1).max(255),
  geometryRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  loading: z.boolean(),
  navigationFailed: z.boolean(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  sizedByAgent: z.boolean(),
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
export const BrowserGroupRowSchema = z.strictObject({
  id: BrowserSessionIdSchema,
  createdAt: IsoDateTimeSchema.max(64),
  unavailableReason: z.string().max(1000).nullable(),
  tabCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  inventoryRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sessionId: BrowserSessionIdSchema,
  workspaceId: WorkspaceIdSchema,
  state: HostedBrowserSessionStateSchema,
  origin: z.enum(["agent", "trigger", "workspace"]),
  access: BrowserProfileAccessSchema,
  placement: BrowserPlacementSelectorViewSchema,
  profileId: BrowserProfileIdSchema.nullable(),
  runtimeId: z.string().min(1).max(255),
  opener: BrowserSessionOpenerSchema,
  navigation: z.boolean(),
  sessionCreatedAt: IsoDateTimeSchema.max(64),
  updatedAt: IsoDateTimeSchema.max(64),
  acting: z.boolean(),
  page: BrowserPagePresenceSchema.nullable(),
  attachedRunIds: z.array(RunIdSchema).max(browserSessionMaxAttachedRuns),
  threadIds: z.array(ThreadIdSchema).max(browserSessionMaxThreads),
});
export type BrowserGroupRow = z.infer<typeof BrowserGroupRowSchema>;
export const BrowserTabRowSchema = z.strictObject({
  id: BrowserSurfaceIdSchema,
  sessionId: BrowserSessionIdSchema,
  title: z.string().max(256),
  site: z.string().max(2048),
  iconRef: BrowserTabIconRefSchema.nullable(),
  order: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  openerId: BrowserSurfaceIdSchema.nullable(),
  createdAt: IsoDateTimeSchema.max(64),
  state: z.enum(["live", "suspended", "restoring"]),
  availability: z.enum(["ready", "starting", "unavailable"]),
  loading: z.boolean(),
  navigationFailed: z.boolean(),
  documentId: z.string().min(1).max(255).nullable(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  occupants: z.array(PlaceOccupantSchema).max(browserSessionMaxThreads),
});
export type BrowserTabRow = z.infer<typeof BrowserTabRowSchema>;
