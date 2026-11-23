import { z } from "zod";
import { BrowserSessionIdSchema, BrowserSurfaceIdSchema } from "@opensteer/core";

export const browserAgentHostRoutePrefix = "/internal/v1/browser-agent";
export const PageAgentBindInputSchema = z.strictObject({ tabId: BrowserSurfaceIdSchema });
export const PageAgentBindingSchema = z.strictObject({
  tabId: BrowserSurfaceIdSchema,
  sessionId: BrowserSessionIdSchema,
  backend: z.enum(["cdp", "actions"]),
  reloaded: z.boolean(),
  /** V4: the tab was woken by opening it again at its address; what it held is gone. */
  reopened: z.boolean().optional(),
});
export type PageAgentBinding = z.infer<typeof PageAgentBindingSchema>;

export const browserAgentRequestMaxBytes = 64 * 1024;
export const browserAgentResponseMaxBytes = 1024 * 1024;
