import { RequestIdSchema, RequestKindSchema, RequestStatusSchema } from "@opensteer/core";

import { z } from "zod";

export const RequestCreationResultSchema = z.strictObject({
  kind: RequestKindSchema,
  replayed: z.boolean(),
  requestId: RequestIdSchema,
  status: RequestStatusSchema,
});
export type RequestCreationResult = z.infer<typeof RequestCreationResultSchema>;

export const RunToolTokenPlanSchema = z.strictObject({
  token: z.string().min(1).max(4_096),
  url: z.url(),
});

export const RunBrowserCdpPlanSchema = z.strictObject({
  token: z.string().min(1).max(4_096),
  url: z.url(),
});
export type RunBrowserCdpPlan = z.infer<typeof RunBrowserCdpPlanSchema>;

export const RunAgentToolsPlanSchema = z.strictObject({
  token: z.string().min(1).max(4_096),
  url: z.url(),
  tools: z
    .array(z.string().min(1).max(128))
    .max(256)
    .refine((tools) => new Set(tools).size === tools.length, "Tool names must be unique"),
  toolsRevision: z.string().min(1).max(256),
  instructions: z.string().max(128 * 1_024),
  skills: z.array(z.string().min(1).max(256)).max(256),
});
export type RunAgentToolsPlan = z.infer<typeof RunAgentToolsPlanSchema>;

export const PinnedPluginSchema = z.strictObject({
  pluginId: z.string().min(1).max(256),
  name: z.string().min(1).max(64),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
});
export const RunPluginsPlanSchema = z.strictObject({
  token: z.string().min(1).max(16_000),
  url: z.url(),
  versions: z.array(PinnedPluginSchema).max(128),
});
export type RunPluginsPlan = z.infer<typeof RunPluginsPlanSchema>;
