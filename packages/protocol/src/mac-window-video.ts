import { z } from "zod";
import {
  DisplayDemandSchema,
  DisplaySourceSchema,
  DisplayStreamIdSchema,
  MacWindowTargetSchema,
  MacDisplayWarmSchema,
  DisplayMaxLongSideSchema,
  DisplayInputSchema,
  DisplayInputResultSchema,
  DisplayEditingSchema,
  DisplayClipboardSchema,
} from "./display-stream.js";

export const MacOwnerSourceSchema = DisplaySourceSchema.options[1];
/**
 * Owner input version 2 is shared input: the person's batches go into an app
 * alongside the agent's actions. Version 1 was an exclusive Take over lease and
 * is read as unsupported.
 */
export const macOwnerInputVersion = 2;
export const MacOwnerInputVersionSchema = z
  .number()
  .int()
  .positive()
  .transform((value) => (value === macOwnerInputVersion ? macOwnerInputVersion : undefined))
  .optional();
/** The person's input for one owner view, in the Host's single person lane for its stream. */
export const MacOwnerInputParamsSchema = z.strictObject({
  streamId: DisplayStreamIdSchema,
  source: MacOwnerSourceSchema,
  ...DisplayInputSchema.shape,
});
/** The viewer holding the person lane left mid-gesture: release what it holds and drop the rest. */
export const MacOwnerInputResetParamsSchema = z.strictObject({
  streamId: DisplayStreamIdSchema,
  source: MacOwnerSourceSchema,
});
export const MacOwnerInputMessageSchema = z.union([
  DisplayInputResultSchema,
  DisplayEditingSchema,
  DisplayClipboardSchema,
]);
export const MacOwnerInputEventSchema = z.strictObject({
  streamId: DisplayStreamIdSchema,
  source: MacOwnerSourceSchema,
  message: MacOwnerInputMessageSchema,
});

export const macWindowVideoParams = {
  "display.input": MacOwnerInputParamsSchema,
  "display.input-reset": MacOwnerInputResetParamsSchema,
  "display.resolve": z.strictObject({
    source: DisplaySourceSchema,
    ownerInputVersion: MacOwnerInputVersionSchema,
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
  "display.input": DisplayInputResultSchema.omit({ type: true }),
  "display.input-reset": z.strictObject({}),
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
