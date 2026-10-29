import { z } from "zod";
import {
  DisplayDemandSchema,
  DisplaySourceSchema,
  DisplayStreamIdSchema,
  MacWindowTargetSchema,
  MacDisplayWarmSchema,
  DisplayMaxLongSideSchema,
  DisplayControlIdSchema,
  DisplayInputSchema,
  DisplayInputResultSchema,
  DisplayEditingSchema,
  DisplayClipboardSchema,
  DisplayViewerControlSchema,
} from "./display-stream.js";

export const MacOwnerSourceSchema = DisplaySourceSchema.options[1];
export const MacOwnerControlParamsSchema = z.strictObject({
  streamId: DisplayStreamIdSchema,
  source: MacOwnerSourceSchema,
  controlId: DisplayControlIdSchema,
  action: z.enum(["acquire", "release"]),
  access: z.literal("read-write"),
});
export const MacOwnerInputParamsSchema = z.strictObject({
  streamId: DisplayStreamIdSchema,
  source: MacOwnerSourceSchema,
  ...DisplayInputSchema.shape,
});
export const MacOwnerInputMessageSchema = z.union([
  DisplayViewerControlSchema,
  DisplayInputResultSchema,
  DisplayEditingSchema,
  DisplayClipboardSchema,
]);
export const MacOwnerInputEventSchema = z.strictObject({
  streamId: DisplayStreamIdSchema,
  source: MacOwnerSourceSchema,
  controlId: DisplayControlIdSchema,
  message: MacOwnerInputMessageSchema,
});

export const macWindowVideoParams = {
  "display.control": MacOwnerControlParamsSchema,
  "display.input": MacOwnerInputParamsSchema,
  "display.resolve": z.strictObject({
    source: DisplaySourceSchema,
    ownerInputVersion: z.literal(1).optional(),
  }),
  "display.start": z.strictObject({
    streamId: DisplayStreamIdSchema,
    target: MacWindowTargetSchema,
    sources: DisplayDemandSchema,
    maxLongSide: DisplayMaxLongSideSchema,
    maxFps: z.number().int().min(1).max(30),
  }),
  "display.demand": z.strictObject({
    streamId: DisplayStreamIdSchema,
    revision: z.number().int().nonnegative(),
    sources: DisplayDemandSchema,
    warm: MacDisplayWarmSchema.optional(),
    maxLongSide: DisplayMaxLongSideSchema.optional(),
  }),
  "display.refresh": z.strictObject({ streamId: DisplayStreamIdSchema }),
  "display.stop": z.strictObject({ streamId: DisplayStreamIdSchema }),
  "display.attach": z.strictObject({ token: z.string().uuid() }),
};
export const macWindowVideoResults = {
  "display.control": DisplayViewerControlSchema.omit({ type: true }),
  "display.input": DisplayInputResultSchema.omit({ type: true }),
  "display.resolve": z.strictObject({
    target: MacWindowTargetSchema,
  }),
  "display.start": z.strictObject({ attachmentToken: z.string().uuid() }),
  "display.demand": z.strictObject({}),
  "display.refresh": z.strictObject({}),
  "display.stop": z.strictObject({}),
  "display.attach": z.strictObject({}),
};

import { DisplayStreamStateSchema, DisplayStreamReasonSchema } from "./display-stream.js";
export const MacWindowVideoStateSchema = z.strictObject({
  streamId: DisplayStreamIdSchema,
  state: DisplayStreamStateSchema,
  reason: DisplayStreamReasonSchema.optional(),
  generation: z.number().int().nonnegative(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
});
export const MacWindowVideoSourceEventSchema = z.strictObject({
  streamId: DisplayStreamIdSchema,
  source: DisplaySourceSchema,
  reason: z.enum(["session-ended", "owner-ended", "owner-expired", "owner-revoked"]),
});
