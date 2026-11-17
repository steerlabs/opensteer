import {
  ArtifactContentPartSchema,
  DeploymentIdSchema,
  MessageAuthorSchema,
  MessageIdSchema,
  MessageEditSchema,
  RunIdSchema,
  TeamAgentRequestIdSchema,
  TeamAudienceSchema,
  ThreadIdSchema,
  ThreadInputViewSchema,
  utf8ByteLength,
} from "@opensteer/core";
import { z } from "zod";
import { PersonalRevisionSchema } from "./resources.js";

const WaitingInputSchema = z.strictObject({
  message: z.strictObject({
    id: MessageIdSchema,
    revision: z.int().nonnegative(),
    edit: MessageEditSchema.optional(),
    author: MessageAuthorSchema,
    createdAt: z.iso.datetime(),
    preview: z.string(),
    truncated: z.boolean(),
    attachments: z.array(ArtifactContentPartSchema).max(6).optional(),
  }),
  input: z.strictObject({
    messageId: MessageIdSchema,
    state: ThreadInputViewSchema.shape.state,
    queueRank: PersonalRevisionSchema,
  }),
  ask: z
    .strictObject({
      teamId: DeploymentIdSchema,
      requestId: TeamAgentRequestIdSchema,
      audience: TeamAudienceSchema,
    })
    .nullable(),
  canEdit: z.boolean(),
  canCancel: z.boolean(),
  canMove: z.boolean(),
  canSteer: z.boolean(),
  lease: z
    .strictObject({
      deviceLabel: z.string(),
      expiresAt: z.iso.datetime(),
      ownedBySession: z.boolean(),
    })
    .nullable(),
});

export const PersonalInputQueueSchema = z
  .strictObject({
    threadId: ThreadIdSchema,
    revision: PersonalRevisionSchema,
    paused: z.boolean(),
    steerRunId: RunIdSchema.nullable(),
    items: z.array(WaitingInputSchema).max(100),
  })
  .refine((queue) => utf8ByteLength(JSON.stringify(queue)) <= 96 * 1024);

export type PersonalInputQueue = z.infer<typeof PersonalInputQueueSchema>;
