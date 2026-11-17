import { z } from "zod";
import { BrowserSessionIdSchema, BrowserSurfaceIdSchema } from "@opensteer/core";

export const browserAgentHostRoutePrefix = "/internal/v1/browser-agent";
export const PageAgentBindInputSchema = z.strictObject({ tabId: BrowserSurfaceIdSchema });
export const PageAgentBindingSchema = z.strictObject({
  tabId: BrowserSurfaceIdSchema,
  sessionId: BrowserSessionIdSchema,
  backend: z.enum(["cdp", "actions"]),
  reloaded: z.boolean(),
});
export type PageAgentBinding = z.infer<typeof PageAgentBindingSchema>;

export const browserAgentRequestMaxBytes = 64 * 1024;
export const browserAgentResponseMaxBytes = 1024 * 1024;
