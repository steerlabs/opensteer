import { BrowserSessionIdSchema, BrowserSurfaceIdSchema } from "@opensteer/core";
import { z } from "zod";
import { browserBase } from "./browser-message-base.js";
import {
  DisplayStreamIdSchema,
  DisplaySequenceSchema,
  displayFrameHeaderFields,
  displayKeyHasCodec,
  encodeDisplayEnvelope,
  decodeDisplayEnvelope,
} from "./media-frame.js";

const token = z.string().min(1).max(512);
export const BrowserVideoU64Schema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,19})$/)
  .refine((value) => BigInt(value) <= 18_446_744_073_709_551_615n, "Counter exceeds uint64");
/** The only conversion from the producer's decimal counters into the media wire. */
export function browserVideoCounter(value: string): number {
  BrowserVideoU64Schema.parse(value);
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new Error("Browser video counter exceeds safe integer range.");
  return result;
}
export const BrowserVideoTargetSchema = z.strictObject({
  kind: z.literal("browser-tab"),
  sessionId: BrowserSessionIdSchema,
  surfaceId: BrowserSurfaceIdSchema,
});
export type BrowserVideoTarget = z.infer<typeof BrowserVideoTargetSchema>;
const dimension = z
  .number()
  .int()
  .min(2)
  .max(3840)
  .refine((n) => n % 2 === 0, "Even raster required");
const css = z.number().finite().positive().max(1_000_000);
const rasterOffset = z.number().int().min(0).max(3840);
const rasterSize = z.number().int().positive().max(3840);
const rect = z.strictObject({
  x: rasterOffset,
  y: rasterOffset,
  width: rasterSize,
  height: rasterSize,
});
export const BrowserPresentedFrameSchema = z.object({
  producerStreamId: z.uuid(),
  documentGeneration: token,
  authorityEpoch: token,
  drawnRevision: token,
  rootCssWidth: css,
  rootCssHeight: css,
  rasterCrop: rect,
});
export type BrowserPresentedFrame = z.infer<typeof BrowserPresentedFrameSchema>;
export const BrowserVideoFrameHeaderSchema = z
  .strictObject({
    streamId: DisplayStreamIdSchema,
    ...displayFrameHeaderFields,
    width: dimension,
    height: dimension,
    presentation: BrowserPresentedFrameSchema,
    geometryRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .refine(displayKeyHasCodec, "Only keyframes carry a required avc1 codec")
  .refine(
    (h) =>
      h.width * h.height <= 3840 * 2160 &&
      h.height <= 2160 &&
      h.presentation.rasterCrop.x + h.presentation.rasterCrop.width <= h.width &&
      h.presentation.rasterCrop.y + h.presentation.rasterCrop.height <= h.height,
    "Browser raster exceeds its bounds",
  );
export type BrowserVideoFrameHeader = z.infer<typeof BrowserVideoFrameHeaderSchema>;
export const BrowserPresentationRefSchema = z.strictObject({
  generation: displayFrameHeaderFields.generation,
  sequence: DisplaySequenceSchema,
  producerStreamId: z.uuid(),
  documentGeneration: token,
  authorityEpoch: token,
  drawnRevision: token,
});
export type BrowserPresentationRef = z.infer<typeof BrowserPresentationRefSchema>;
export function browserPresentationRef(h: BrowserVideoFrameHeader): BrowserPresentationRef {
  return Object.freeze({
    generation: h.generation,
    sequence: h.sequence,
    producerStreamId: h.presentation.producerStreamId,
    documentGeneration: h.presentation.documentGeneration,
    authorityEpoch: h.presentation.authorityEpoch,
    drawnRevision: h.presentation.drawnRevision,
  });
}
export function sameBrowserPresentation(
  a: BrowserPresentationRef,
  b: BrowserPresentationRef,
): boolean {
  return (
    a.generation === b.generation &&
    a.sequence === b.sequence &&
    a.producerStreamId === b.producerStreamId &&
    a.documentGeneration === b.documentGeneration &&
    a.authorityEpoch === b.authorityEpoch &&
    a.drawnRevision === b.drawnRevision
  );
}
export function browserVideoRootPoint(
  h: BrowserVideoFrameHeader,
  p: { x: number; y: number },
): { x: number; y: number } {
  const crop = h.presentation.rasterCrop;
  if (
    !Number.isFinite(p.x) ||
    !Number.isFinite(p.y) ||
    p.x < crop.x ||
    p.y < crop.y ||
    p.x >= crop.x + crop.width ||
    p.y >= crop.y + crop.height
  )
    throw new Error("Point is outside the presented browser content.");
  return {
    x: ((p.x - crop.x) * h.presentation.rootCssWidth) / crop.width,
    y: ((p.y - crop.y) * h.presentation.rootCssHeight) / crop.height,
  };
}
export const BrowserVideoBudgetSchema = z
  .strictObject({
    maxWidth: dimension,
    maxHeight: dimension.refine((n) => n <= 2160),
    maxFps: z.number().int().min(1).max(60),
    maxBitrate: z.number().int().min(50_000).max(20_000_000),
  })
  .refine((b) => b.maxWidth * b.maxHeight <= 3840 * 2160);
export type BrowserVideoBudget = z.infer<typeof BrowserVideoBudgetSchema>;
export const BrowserVideoCapacitySchema = z.strictObject({
  backend: z.enum(["hardware", "software"]),
  maxSessions: z.number().int().min(1).max(8),
  maxFps: z.number().int().min(1).max(60),
});
export const BrowserVideoStateSchema = z.strictObject({
  type: z.literal("browser.video.state"),
  surfaceId: BrowserSurfaceIdSchema,
  streamId: DisplayStreamIdSchema,
  producerStreamId: z.uuid().optional(),
  state: z.enum(["starting", "live", "paused", "stopped", "failed"]),
  reason: z
    .enum([
      "capacity",
      "unsupported",
      "replaced",
      "revoked",
      "source-ended",
      "encoder-failed",
      "budget",
      "protocol",
      "timeout",
      "transport",
    ])
    .optional(),
  budget: BrowserVideoBudgetSchema.optional(),
  capacity: BrowserVideoCapacitySchema.optional(),
  replayThrough: DisplaySequenceSchema.optional(),
});
export type BrowserVideoState = z.infer<typeof BrowserVideoStateSchema>;
export const BrowserVideoReplaySchema = z.strictObject({ replayThrough: DisplaySequenceSchema });
export const BrowserVideoClickResultSchema = z.strictObject({
  type: z.literal("browser.guarded-click.result"),
  surfaceId: BrowserSurfaceIdSchema,
  streamId: DisplayStreamIdSchema,
  gestureId: z.uuid(),
  viewerSlot: z.uuid().optional(),
  outcome: z.enum(["dispatched", "refused", "uncertain"]),
});
export const BrowserVideoAttachmentSchema = z.strictObject({
  type: z.literal("browser.video.attached"),
  surfaceId: BrowserSurfaceIdSchema,
  streamId: DisplayStreamIdSchema,
  /** One use, bound to this already admitted outlet. It confers no input authority. */
  mediaToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export const BrowserVideoClientMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...browserBase,
    type: z.literal("video.presented"),
    surfaceId: BrowserSurfaceIdSchema,
    streamId: DisplayStreamIdSchema,
    reference: BrowserPresentationRefSchema,
  }),
  z.strictObject({
    ...browserBase,
    type: z.literal("video.gesture"),
    surfaceId: BrowserSurfaceIdSchema,
    streamId: DisplayStreamIdSchema,
    reference: BrowserPresentationRefSchema,
    gestureId: z.uuid(),
    phase: z.enum(["begin", "cancel"]),
  }),
  z.strictObject({
    ...browserBase,
    type: z.literal("video.subscribe"),
    surfaceId: BrowserSurfaceIdSchema,
    budget: BrowserVideoBudgetSchema,
  }),
  z.strictObject({
    ...browserBase,
    type: z.literal("video.budget"),
    surfaceId: BrowserSurfaceIdSchema,
    streamId: DisplayStreamIdSchema,
    budget: BrowserVideoBudgetSchema,
    focus: z.boolean().optional(),
  }),
  z.strictObject({
    ...browserBase,
    type: z.literal("video.unsubscribe"),
    surfaceId: BrowserSurfaceIdSchema,
  }),
  z.strictObject({
    ...browserBase,
    type: z.literal("input.guarded-click"),
    viewerSlot: z.uuid().optional(),
    gestureId: z.uuid(),
    surfaceId: BrowserSurfaceIdSchema,
    streamId: DisplayStreamIdSchema,
    reference: BrowserPresentationRefSchema,
    point: z.strictObject({
      x: z.number().finite().min(0).max(3840),
      y: z.number().finite().min(0).max(2160),
    }),
    button: z.literal("left"),
    modifiers: z.number().int().min(0).max(15),
  }),
]);
export const BrowserVideoAckSchema = z.strictObject({
  type: z.literal("video.ack"),
  streamId: DisplayStreamIdSchema,
  sequence: DisplaySequenceSchema,
});
export const BrowserVideoMediaClientMessageSchema = z.discriminatedUnion("type", [
  BrowserVideoAckSchema,
  z.strictObject({ type: z.literal("video.keyframe"), streamId: DisplayStreamIdSchema }),
]);
export const BrowserVideoSourceAckSchema = BrowserVideoAckSchema;

export function encodeBrowserVideoFrame(
  header: BrowserVideoFrameHeader,
  payload: Uint8Array,
): Uint8Array {
  return encodeDisplayEnvelope(BrowserVideoFrameHeaderSchema.parse(header), payload);
}
export function decodeBrowserVideoFrame(bytes: Uint8Array): {
  header: BrowserVideoFrameHeader;
  payload: Uint8Array;
} {
  const { header, payload } = decodeDisplayEnvelope(bytes);
  return { header: immutableBrowserVideoHeader(header), payload };
}
export function immutableBrowserVideoHeader(header: unknown): BrowserVideoFrameHeader {
  const parsed = BrowserVideoFrameHeaderSchema.parse(header);
  Object.freeze(parsed.presentation.rasterCrop);
  Object.freeze(parsed.presentation);
  Object.freeze(parsed);
  return parsed;
}
