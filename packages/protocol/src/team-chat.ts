import { z } from "zod";
import {
  DeploymentIdSchema,
  IsoDateTimeSchema,
  SequenceSchema,
  TeamAgentRequestIdSchema,
  TeamAgentRequestStateSchema,
  TeamAudienceSchema,
  TeamBlobIdSchema,
  TeamChannelIdSchema,
  TeamChannelKindSchema,
  TeamMessageIdSchema,
  TeamSourceSchema,
  TeamStatusStepSchema,
  UserIdSchema,
} from "@opensteer/core";
import { TeamCanSchema, TeamChannelCanSchema, TeamMemberSchema } from "./team-access.js";

export const teamPageSize = 50;
export const teamResumeMaxRows = 200;
export const teamResumeMaxBytes = 256 * 1024;
export const teamUploadMaxBytes = 100 * 1024 * 1024;
export const teamPreviewMaxBytes = 64 * 1024;
export const TeamMarkdownSchema = z
  .string()
  .max(16384)
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= 16384,
    "Markdown exceeds 16 KiB",
  );
export const TeamMentionSchema = z.strictObject({
  userId: UserIdSchema,
  kind: z.enum(["person", "agent"]),
});
export const TeamFileSchema = z.strictObject({
  id: TeamBlobIdSchema,
  channelId: TeamChannelIdSchema,
  filename: z.string().min(1).max(255),
  mediaType: z.string().min(1).max(255),
  sizeBytes: z.number().int().nonnegative().max(teamUploadMaxBytes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  preview: z
    .strictObject({
      mediaType: z.enum(["image/jpeg", "image/png", "image/webp"]),
      sizeBytes: z.number().int().positive().max(teamPreviewMaxBytes),
    })
    .nullable(),
});
export const TeamAgentRequestSchema = z.strictObject({
  id: TeamAgentRequestIdSchema,
  ownerUserId: UserIdSchema,
  channelId: TeamChannelIdSchema,
  threadRootId: TeamMessageIdSchema,
  triggerMessageId: TeamMessageIdSchema,
  state: TeamAgentRequestStateSchema,
  steps: z.array(TeamStatusStepSchema).max(8),
  createdAt: IsoDateTimeSchema,
  acceptedAt: IsoDateTimeSchema.nullable(),
  expiresAt: IsoDateTimeSchema.nullable(),
  finishedAt: IsoDateTimeSchema.nullable(),
  replyMessageId: TeamMessageIdSchema.nullable(),
  failureCode: z
    .enum(["expired", "access_revoked", "link_revoked", "trigger_deleted", "execution_failed"])
    .nullable(),
  changeSeq: SequenceSchema,
});
export type TeamAgentRequest = z.infer<typeof TeamAgentRequestSchema>;
export const TeamChannelSummarySchema = z.strictObject({
  id: TeamChannelIdSchema,
  kind: TeamChannelKindSchema,
  name: z.string().min(1).max(160),
  peopleOnly: z.boolean(),
  archivedAt: IsoDateTimeSchema.nullable(),
  changeSeq: SequenceSchema,
  latestMessageId: TeamMessageIdSchema.nullable(),
  can: TeamChannelCanSchema,
});
export const TeamChannelSchema = TeamChannelSummarySchema.extend({
  instructionsMarkdown: TeamMarkdownSchema,
  instructionsRevision: SequenceSchema,
}).strict();
export type TeamChannel = z.infer<typeof TeamChannelSchema>;
export const TeamMessageSchema = z.strictObject({
  id: TeamMessageIdSchema,
  channelId: TeamChannelIdSchema,
  threadRootId: TeamMessageIdSchema.nullable(),
  authorUserId: UserIdSchema,
  authorKind: z.enum(["human", "agent"]),
  agentRequestId: TeamAgentRequestIdSchema.nullable(),
  clientMessageId: z.uuid(),
  bodyMarkdown: TeamMarkdownSchema,
  plainText: z.string().max(32768),
  createdAt: IsoDateTimeSchema,
  editedAt: IsoDateTimeSchema.nullable(),
  deletedAt: IsoDateTimeSchema.nullable(),
  changeSeq: SequenceSchema,
  mentions: z.array(TeamMentionSchema).max(20),
  attachments: z.array(TeamFileSchema).max(10),
  pinned: z.boolean(),
  replySummary: z.strictObject({
    count: z.number().int().nonnegative(),
    latestMessageId: TeamMessageIdSchema.nullable(),
    repliers: z.array(UserIdSchema).max(4),
  }),
  requests: z.array(TeamAgentRequestSchema).max(32),
});
export type TeamMessage = z.infer<typeof TeamMessageSchema>;
export const TeamPageDirectionSchema = z.discriminatedUnion("direction", [
  z.strictObject({ direction: z.literal("newest") }),
  z.strictObject({ direction: z.literal("before"), messageId: TeamMessageIdSchema }),
  z.strictObject({ direction: z.literal("after"), messageId: TeamMessageIdSchema }),
]);
export const TeamMessagePageSchema = z.strictObject({
  messages: z.array(TeamMessageSchema).max(teamPageSize),
  hasMore: z.boolean(),
  throughSeq: SequenceSchema,
  channel: TeamChannelSchema,
});
export const TeamSubscriptionScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("channel"), channelId: TeamChannelIdSchema }),
  z.strictObject({
    kind: z.literal("thread"),
    channelId: TeamChannelIdSchema,
    rootId: TeamMessageIdSchema,
  }),
]);
export const TeamLinkPresenceSchema = z.strictObject({
  ownerUserId: UserIdSchema,
  online: z.boolean(),
});
const cutShape = {
  linkPresence: z.array(TeamLinkPresenceSchema).max(200),
  subscriptionId: z.string().min(1).max(128),
  generation: z.number().int().positive(),
  scope: TeamSubscriptionScopeSchema,
  throughSeq: SequenceSchema,
  channel: TeamChannelSchema,
};
// Missing integers are compacted row versions; only throughSeq advances the scope's cursor.
export const TeamConsistentCutSchema = z
  .discriminatedUnion("type", [
    z.strictObject({
      ...cutShape,
      type: z.literal("snapshot"),
      messages: z.array(TeamMessageSchema).max(50),
      requests: z.array(TeamAgentRequestSchema).max(200),
      hasMore: z.boolean(),
    }),
    z
      .strictObject({
        ...cutShape,
        type: z.literal("resumed"),
        changedRows: z.array(TeamMessageSchema).max(200),
        deletedIds: z.array(TeamMessageIdSchema).max(200),
        requests: z.array(TeamAgentRequestSchema).max(200),
      })
      .refine(
        (cut) =>
          cut.changedRows.length + cut.deletedIds.length + cut.requests.length <= teamResumeMaxRows,
        "Delta exceeds row bound",
      ),
  ])
  .refine(
    (cut) => new TextEncoder().encode(JSON.stringify(cut)).byteLength <= teamResumeMaxBytes,
    "Cut exceeds byte bound",
  );
export type TeamConsistentCut = z.infer<typeof TeamConsistentCutSchema>;
export const TeamSidebarEntrySchema = z.strictObject({
  channel: TeamChannelSummarySchema,
  unread: z.boolean(),
  mentionCount: z.number().int().nonnegative(),
  lastReadMessageId: TeamMessageIdSchema.nullable(),
  notificationLevel: z.enum(["mentions", "all", "muted"]),
  agentOnline: z.boolean(),
});
export const TeamSidebarSchema = z.strictObject({
  channels: z.array(TeamSidebarEntrySchema).max(50),
  totalMentionCount: z.number().int().nonnegative(),
  nextCursor: TeamChannelIdSchema.nullable(),
  accessRevision: SequenceSchema,
});
export const TeamBootstrapSchema = z.strictObject({
  teamId: DeploymentIdSchema,
  teamName: z.string().min(1).max(160),
  member: TeamMemberSchema,
  can: TeamCanSchema,
  sidebar: TeamSidebarSchema,
});
export const TeamSearchInputSchema = z.strictObject({
  query: z.string().trim().min(1).max(256),
  channelId: TeamChannelIdSchema.optional(),
  authorUserId: UserIdSchema.optional(),
  threadRootId: TeamMessageIdSchema.optional(),
  hasFile: z.boolean().optional(),
  threadsOnly: z.boolean().optional(),
  before: TeamMessageIdSchema.optional(),
});
export const TeamSearchPageSchema = z.strictObject({
  results: z
    .array(z.strictObject({ message: TeamMessageSchema, source: TeamSourceSchema }))
    .max(50),
  hasMore: z.boolean(),
});
export const TeamReadResultSchema = z.strictObject({
  page: TeamMessagePageSchema,
  source: TeamSourceSchema,
});
export const TeamFileResultSchema = z.strictObject({
  file: TeamFileSchema,
  source: TeamSourceSchema,
});
export const TeamRequestContextSchema = z
  .strictObject({
    request: TeamAgentRequestSchema,
    instructionsMarkdown: TeamMarkdownSchema,
    messages: z.array(TeamMessageSchema).max(50),
    source: TeamSourceSchema,
    audience: TeamAudienceSchema,
  })
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value.messages)).byteLength <= 32768,
    "Context exceeds 32 KiB",
  );
export const TeamClientFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("team.subscribe"),
    teamApiVersion: z.number().int().positive(),
    sidebar: z.boolean(),
    subscriptionId: z.string().min(1).max(128),
    generation: z.number().int().positive(),
    scope: TeamSubscriptionScopeSchema.nullable(),
    sinceSeq: SequenceSchema.nullable(),
  }),
  z.strictObject({
    type: z.literal("team.typing"),
    channelId: TeamChannelIdSchema,
    rootId: TeamMessageIdSchema.nullable(),
    typing: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("team.presence"),
    visible: z.boolean(),
    watchedUserIds: z.array(UserIdSchema).max(50),
  }),
]);
export const TeamServerFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("team.cut"), cut: TeamConsistentCutSchema }),
  z.strictObject({ type: z.literal("team.sidebar"), sidebar: TeamSidebarSchema }),
  z.strictObject({
    type: z.literal("team.sidebar.dirty"),
    channelIds: z.array(TeamChannelIdSchema).max(200),
    accessRevision: SequenceSchema,
  }),
  z.strictObject({
    type: z.literal("team.link.presence"),
    userId: UserIdSchema,
    online: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("team.typing"),
    channelId: TeamChannelIdSchema,
    rootId: TeamMessageIdSchema.nullable(),
    userIds: z.array(UserIdSchema).max(50),
  }),
  z.strictObject({
    type: z.literal("team.presence"),
    people: z.array(z.strictObject({ userId: UserIdSchema, online: z.boolean() })).max(50),
  }),
  z.strictObject({ type: z.literal("team.access.changed"), accessRevision: SequenceSchema }),
]);
