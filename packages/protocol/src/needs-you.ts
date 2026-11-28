import { z } from "zod";
import { PendingRequestViewSchema, TaskPurposeSchema, ThreadIdSchema } from "@opensteer/core";
import { DurableWindowSchema } from "./client.js";

export const NeedsYouRequestEntrySchema = z.object({
  kind: z.literal("request"),
  request: PendingRequestViewSchema,
  originThreadId: ThreadIdSchema,
  navigationThreadId: ThreadIdSchema,
  purpose: TaskPurposeSchema,
  title: z.string().min(1).max(240),
});
export const NeedsYouEntrySchema = z.discriminatedUnion("kind", [NeedsYouRequestEntrySchema]);
export type NeedsYouEntry = z.infer<typeof NeedsYouEntrySchema>;
export const NeedsYouPageSchema = z.object({
  count: z.number().int().nonnegative(),
  entries: z.array(NeedsYouEntrySchema).max(50),
  window: z.lazy(() => DurableWindowSchema),
});
export type NeedsYouPage = z.infer<typeof NeedsYouPageSchema>;
