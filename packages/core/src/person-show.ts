import { z } from "zod";
import { BrowserSurfaceIdSchema, ThreadIdSchema } from "./ids.js";

export const PersonShowTargetSchema = z.union([
  z.strictObject({ tabId: BrowserSurfaceIdSchema }),
  z.strictObject({ threadId: ThreadIdSchema }),
  z.strictObject({ current: z.literal(true) }),
]);
export type PersonShowTarget = z.infer<typeof PersonShowTargetSchema>;
