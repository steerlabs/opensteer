import {
  ArtifactContentPartSchema,
  DeploymentIdSchema,
  MessageAuthorViewSchema,
  MessageIdSchema,
  MessageEditViewSchema,
  RunIdSchema,
  TeamAgentRequestIdSchema,
  TeamAudienceViewSchema,
  ThreadIdSchema,
  ThreadInputViewSchema,
  utf8ByteLength,
} from "@opensteer/core";
import { z } from "zod";
import { PersonalRevisionSchema } from "./resources.js";

export const WaitingInputViewSchema = z.object({
  message: z.object({
    id: MessageIdSchema,
    clientSendKey: z.string().min(1).max(255).optional(),
    revision: z.int().nonnegative(),
    edit: MessageEditViewSchema.optional(),
    author: MessageAuthorViewSchema,
    createdAt: z.iso.datetime(),
    preview: z.string(),
    truncated: z.boolean(),
    attachments: z.array(ArtifactContentPartSchema).max(6).optional(),
  }),
  input: z.object({
    messageId: MessageIdSchema,
    state: ThreadInputViewSchema.shape.state,
    queueRank: PersonalRevisionSchema,
  }),
  ask: z
    .object({
      teamId: DeploymentIdSchema,
      requestId: TeamAgentRequestIdSchema,
      audience: TeamAudienceViewSchema,
    })
    .nullable(),
  canEdit: z.boolean(),
  canCancel: z.boolean(),
  canMove: z.boolean(),
  canSteer: z.boolean(),
  lease: z
    .object({
      deviceLabel: z.string(),
      expiresAt: z.iso.datetime(),
      ownedBySession: z.boolean(),
    })
    .nullable(),
});

export const PersonalInputQueueViewSchema = z
  .object({
    threadId: ThreadIdSchema,
    revision: PersonalRevisionSchema,
    paused: z.boolean(),
    steerRunId: RunIdSchema.nullable(),
    items: z.array(WaitingInputViewSchema).max(100),
  })
  .refine((queue) => utf8ByteLength(JSON.stringify(queue)) <= 96 * 1024);

export type PersonalInputQueue = z.infer<typeof PersonalInputQueueViewSchema>;
export type WaitingInputView = z.infer<typeof WaitingInputViewSchema>;
