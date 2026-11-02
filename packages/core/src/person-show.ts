import { z } from "zod";
import { BrowserSurfaceIdSchema, ThreadIdSchema } from "./ids.js";

/** Saved identities only: native viewing also needs an exact window/session generation. */
export const PersonShowTargetSchema = z.union([
  z.strictObject({ tabId: BrowserSurfaceIdSchema }),
  z.strictObject({ threadId: ThreadIdSchema }),
]);
export type PersonShowTarget = z.infer<typeof PersonShowTargetSchema>;
