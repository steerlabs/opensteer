import { z } from "zod";
import {
  MessageIdSchema,
  ScreenPresentationContextSchema,
  ScreenPresentationReceiptSchema,
  ScreenSurfaceSchema,
  ScreenShowTargetSchema,
} from "@opensteer/core";
import { VoiceSessionIdSchema } from "./voice.js";

export const screenShowCapability = "screen-show-v1";
export const screenPresentationEligibilityMs = 120_000;
export const screenPresentationDispatchMs = 5_000;

/** Socket-issued possession proof; never persisted, logged, or shown to an agent. */
export const ScreenEndpointRefSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const [browserSurface, appSurface, phoneSurface] = ScreenSurfaceSchema.options;
const ScreenSurfaceViewSchema = z.discriminatedUnion("kind", [
  z.object(browserSurface.shape),
  z.object({
    ...appSurface.shape,
    source: z.discriminatedUnion("kind", [
      z.object(appSurface.shape.source.options[0].shape),
      z.object(appSurface.shape.source.options[1].shape),
    ]),
  }),
  z.object({
    ...phoneSurface.shape,
    source: z.discriminatedUnion("kind", [
      z.object(phoneSurface.shape.source.options[0].shape),
      z.object(phoneSurface.shape.source.options[1].shape),
    ]),
  }),
]);
// Host response readers tolerate additive facts; the model-facing input stays strict.
const ScreenShowTargetViewSchema = ScreenShowTargetSchema.strip().safeExtend({
  surface: ScreenSurfaceViewSchema.optional(),
});

export const ScreenPresentationInputSchema = ScreenPresentationContextSchema.extend({
  endpointRef: ScreenEndpointRefSchema,
  voiceSessionId: VoiceSessionIdSchema,
  utteranceSequence: revision,
  interactionRevision: revision,
});
export type ScreenPresentationInput = z.infer<typeof ScreenPresentationInputSchema>;

export const ScreenReadyMessageSchema = z.object({
  type: z.literal("host.screen.ready"),
  endpointRef: ScreenEndpointRefSchema,
  /** Host monotonic time; the client bounds it using its subscribe round trip. */
  serverTime: z.number().finite().nonnegative(),
});
export type ScreenReadyMessage = z.infer<typeof ScreenReadyMessageSchema>;

export const ScreenShowMessageSchema = z.object({
  type: z.literal("host.screen.show"),
  endpointRef: ScreenEndpointRefSchema,
  operationId: z.uuid(),
  messageId: MessageIdSchema,
  voiceSessionId: VoiceSessionIdSchema,
  utteranceSequence: revision,
  interactionRevision: revision,
  /** Deadline on the same Host monotonic clock as host.screen.ready. */
  deadlineAt: z.number().finite().nonnegative(),
  target: ScreenShowTargetViewSchema,
});
export type ScreenShowMessage = z.infer<typeof ScreenShowMessageSchema>;

export const ScreenDoneMessageSchema = z.strictObject({
  type: z.literal("client.screen.done"),
  operationId: z.uuid(),
  receipt: ScreenPresentationReceiptSchema,
});
export type ScreenDoneMessage = z.infer<typeof ScreenDoneMessageSchema>;
