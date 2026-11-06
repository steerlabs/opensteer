import { z } from "zod";
import { BrowserSurfaceIdSchema, RunIdSchema, ThreadIdSchema } from "./ids.js";

export const PersonShowTargetSchema = z.union([
  z.strictObject({ tabId: BrowserSurfaceIdSchema }),
  z.strictObject({ threadId: ThreadIdSchema }),
  z.strictObject({ current: z.literal(true) }),
  z.strictObject({ runId: RunIdSchema }),
]);
export type PersonShowTarget = z.infer<typeof PersonShowTargetSchema>;
