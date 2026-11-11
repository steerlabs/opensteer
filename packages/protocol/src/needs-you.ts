import { z } from "zod";
import { PendingRequestViewSchema, TaskPurposeSchema, ThreadIdSchema } from "@opensteer/core";
import { DurableWindowSchema } from "./client.js";

export const NeedsYouPageSchema = z.strictObject({
  count: z.number().int().nonnegative(),
  entries: z
    .array(
      z.strictObject({
        request: PendingRequestViewSchema,
        originThreadId: ThreadIdSchema,
        navigationThreadId: ThreadIdSchema,
        purpose: TaskPurposeSchema,
        title: z.string().min(1).max(240),
      }),
    )
    .max(50),
  window: DurableWindowSchema,
});
export type NeedsYouPage = z.infer<typeof NeedsYouPageSchema>;
