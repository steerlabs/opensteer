import { z } from "zod";
import {
  DictationAvailabilitySchema,
  DictationEventSchema,
  DictationSessionInputSchema,
} from "./dictation.js";
export const dictationHelperMaxFrameBytes = 256 * 1024;
export const dictationHelperProtocolVersion = 1;
export const DictationHelperMethodSchema = z.enum([
  "availability",
  "start",
  "download",
  "stop",
  "cancel",
  "interrupt",
]);
export type DictationHelperMethod = z.infer<typeof DictationHelperMethodSchema>;
export const DictationHelperRequestSchema = z
  .strictObject({
    id: z.number().int().positive(),
    method: DictationHelperMethodSchema,
    params: z.union([DictationSessionInputSchema, z.strictObject({})]),
  })
  .superRefine((value, ctx) => {
    const sessionMethod = ["start", "download", "stop", "cancel"].includes(value.method);
    if (sessionMethod !== "session" in value.params)
      ctx.addIssue({ code: "custom", message: "Wrong method parameters" });
  });
export const DictationHelperReplySchema = z.union([
  z.strictObject({
    id: z.number().int().positive(),
    result: z.union([DictationAvailabilitySchema, z.null()]),
  }),
  z.strictObject({ event: DictationEventSchema }),
]);
