import { z } from "zod";
import { BrowserSurfaceIdSchema, ThreadIdSchema } from "./ids.js";

export const PersonShowTargetSchema = z.union([
  z.strictObject({ tabId: BrowserSurfaceIdSchema }),
  z.strictObject({ taskId: ThreadIdSchema }),
]);
export type PersonShowTarget = z.infer<typeof PersonShowTargetSchema>;
