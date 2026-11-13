import { z } from "zod";
import {
  PendingRequestViewSchema,
  TaskPurposeSchema,
  ThreadIdSchema,
  DeploymentIdSchema,
  TeamAgentRequestIdSchema,
  TeamAskPresentationViewSchema,
  IsoDateTimeSchema,
} from "@opensteer/core";
import { DurableWindowSchema } from "./client.js";

export const NeedsYouRequestEntrySchema = z.object({
  kind: z.literal("request"),
  request: PendingRequestViewSchema,
  originThreadId: ThreadIdSchema,
  navigationThreadId: ThreadIdSchema,
  purpose: TaskPurposeSchema,
  title: z.string().min(1).max(240),
});
export const NeedsYouTeamAskEntrySchema = z.object({
  kind: z.literal("team-ask"),
  teamId: DeploymentIdSchema,
  requestId: TeamAgentRequestIdSchema,
  presentation: TeamAskPresentationViewSchema,
  createdAt: IsoDateTimeSchema,
  consentExpiresAt: IsoDateTimeSchema,
});
export type NeedsYouTeamAskEntry = z.infer<typeof NeedsYouTeamAskEntrySchema>;
export const NeedsYouEntrySchema = z.discriminatedUnion("kind", [
  NeedsYouRequestEntrySchema,
  NeedsYouTeamAskEntrySchema,
]);
export type NeedsYouEntry = z.infer<typeof NeedsYouEntrySchema>;
export const NeedsYouPageSchema = z.object({
  count: z.number().int().nonnegative(),
  entries: z.array(NeedsYouEntrySchema).max(50),
  window: z.lazy(() => DurableWindowSchema),
});
export type NeedsYouPage = z.infer<typeof NeedsYouPageSchema>;
