import { z } from "zod";
import {
  PendingRequestViewSchema,
  TaskPurposeSchema,
  ThreadIdSchema,
  DeploymentIdSchema,
  TeamAgentRequestIdSchema,
  TeamAskPresentationViewSchema,
  IsoDateTimeSchema,
  MessageIdSchema,
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
/**
 * A teammate's ask awaiting its owner. It lives in a task as a waiting message
 * (`threadId`, `messageId`), which the owner can edit before approving, so the
 * decision names the `revision` it approves. A failed ask whose task was
 * removed has neither and carries `failureReason` instead.
 */
export const NeedsYouTeamAskEntrySchema = z.object({
  kind: z.literal("team-ask"),
  teamId: DeploymentIdSchema,
  requestId: TeamAgentRequestIdSchema,
  presentation: TeamAskPresentationViewSchema,
  createdAt: IsoDateTimeSchema,
  consentExpiresAt: IsoDateTimeSchema,
  failureReason: z.string().min(1).max(500).optional(),
  task: z
    .object({
      threadId: ThreadIdSchema,
      messageId: MessageIdSchema,
      revision: z.number().int().nonnegative(),
    })
    .optional(),
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
