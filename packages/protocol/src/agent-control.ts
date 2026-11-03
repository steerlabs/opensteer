import {
  AgentCapabilityProfileIdSchema,
  RequestIdSchema,
  RequestKindSchema,
  RequestStatusSchema,
} from "@opensteer/core";

import { z } from "zod";

export const RequestCreationResultSchema = z.strictObject({
  kind: RequestKindSchema,
  replayed: z.boolean(),
  requestId: RequestIdSchema,
  status: RequestStatusSchema,
});
export type RequestCreationResult = z.infer<typeof RequestCreationResultSchema>;

export const RunAgentControlPlanSchema = z.strictObject({
  token: z.string().min(1).max(4_096),
  url: z.url(),
});
export type RunAgentControlPlan = z.infer<typeof RunAgentControlPlanSchema>;

export const RunBrowserCdpPlanSchema = z.strictObject({
  token: z.string().min(1).max(4_096),
  url: z.url(),
});
export type RunBrowserCdpPlan = z.infer<typeof RunBrowserCdpPlanSchema>;

export const RunAgentToolsPlanSchema = z.strictObject({
  capabilityProfileId: AgentCapabilityProfileIdSchema,
  token: z.string().min(1).max(4_096),
  url: z.url(),
});
export type RunAgentToolsPlan = z.infer<typeof RunAgentToolsPlanSchema>;

export const RunIntegrationToolsPlanSchema = z.strictObject({
  token: z.string().min(1).max(4_096),
  url: z.url(),
});
export type RunIntegrationToolsPlan = z.infer<typeof RunIntegrationToolsPlanSchema>;

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
