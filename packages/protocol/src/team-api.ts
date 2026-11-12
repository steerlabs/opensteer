import { z } from "zod";
import {
  DeploymentIdSchema,
  IsoDateTimeSchema,
  KnowledgeTopicIdSchema,
  SequenceSchema,
  TeamAgentRequestIdSchema,
  TeamBlobIdSchema,
  TeamChannelIdSchema,
  TeamGroupIdSchema,
  TeamInviteIdSchema,
  TeamLinkIdSchema,
  TeamMessageIdSchema,
  TeamNoticeIdSchema,
  ThreadIdSchema,
  UserIdSchema,
} from "@opensteer/core";
import {
  TeamAuditSchema,
  TeamChannelAccessEntrySchema,
  TeamChannelAccessSchema,
  TeamGroupSchema,
  TeamInviteSchema,
  TeamMemberRoleSchema,
  TeamMemberSchema,
  TeamNoticeSchema,
  TeamTopicAccessEntrySchema,
  TeamTopicAccessSchema,
} from "./team-access.js";
import {
  TeamAgentRequestSchema,
  TeamBootstrapSchema,
  TeamChannelSchema,
  TeamChannelSummarySchema,
  TeamFileSchema,
  TeamMarkdownSchema,
  TeamMentionSchema,
  TeamMessagePageSchema,
  TeamMessageSchema,
  TeamPageDirectionSchema,
  TeamSearchInputSchema,
  TeamSearchPageSchema,
  TeamSidebarSchema,
} from "./team-chat.js";
import {
  TeamFactInputSchema,
  TeamFactSchema,
  TeamTopicSchema,
  teamKnowledgeLimits,
} from "./team-knowledge.js";
import {
  PersonalTeamLinkSchema,
  TeamBinaryUploadMetadataSchema,
  TeamLinkOfferTextSchema,
  TeamLinkViewSchema,
} from "./team-link.js";

const name = z.string().trim().min(1).max(160);
export const TeamCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("team.channel.create"),
    id: TeamChannelIdSchema,
    kind: z.enum(["public", "private"]),
    name: name,
    peopleOnly: z.boolean(),
    access: z.array(TeamChannelAccessEntrySchema).max(1000),
  }),
  z.strictObject({
    type: z.literal("team.channel.update"),
    channelId: TeamChannelIdSchema,
    name: name,
    peopleOnly: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("team.channel.access.set"),
    channelId: TeamChannelIdSchema,
    expectedRevision: SequenceSchema,
    access: z.array(TeamChannelAccessEntrySchema).max(1000),
  }),
  z.strictObject({
    type: z.literal("team.channel.instructions.set"),
    channelId: TeamChannelIdSchema,
    expectedRevision: SequenceSchema,
    instructionsMarkdown: TeamMarkdownSchema,
  }),
  z.strictObject({
    type: z.literal("team.dm.open"),
    participants: z.array(UserIdSchema).min(1).max(31),
  }),
  z.strictObject({
    type: z.literal("team.dm.people.add"),
    channelId: TeamChannelIdSchema,
    userIds: z.array(UserIdSchema).min(1).max(31),
    historyVisibleConfirmed: z.literal(true),
  }),
  z.strictObject({
    type: z.literal("team.message.send"),
    channelId: TeamChannelIdSchema,
    threadRootId: TeamMessageIdSchema.nullable(),
    clientMessageId: z.uuid(),
    bodyMarkdown: TeamMarkdownSchema,
    mentions: z.array(TeamMentionSchema).max(20),
    attachmentIds: z.array(TeamBlobIdSchema).max(10),
  }),
  z.strictObject({
    type: z.literal("team.message.edit"),
    channelId: TeamChannelIdSchema,
    messageId: TeamMessageIdSchema,
    bodyMarkdown: TeamMarkdownSchema,
    mentions: z.array(TeamMentionSchema).max(20),
  }),
  z.strictObject({
    type: z.literal("team.channel.read"),
    channelId: TeamChannelIdSchema,
    throughMessageId: TeamMessageIdSchema,
  }),
  z.strictObject({
    type: z.literal("team.channel.preferences.set"),
    channelId: TeamChannelIdSchema,
    notificationLevel: z.enum(["mentions", "all", "muted"]),
  }),
  z.strictObject({
    type: z.literal("team.upload.begin"),
    channelId: TeamChannelIdSchema,
    metadata: TeamBinaryUploadMetadataSchema,
  }),
  z.strictObject({
    type: z.literal("team.member.role.set"),
    userId: UserIdSchema,
    role: TeamMemberRoleSchema.exclude(["owner"]),
  }),
  z.strictObject({ type: z.literal("team.member.remove"), userId: UserIdSchema }),
  z.strictObject({ type: z.literal("team.owner.transfer"), userId: UserIdSchema }),
  z.strictObject({ type: z.literal("team.group.create"), id: TeamGroupIdSchema, name: name }),
  z.strictObject({ type: z.literal("team.group.rename"), groupId: TeamGroupIdSchema, name: name }),
  z.strictObject({ type: z.literal("team.group.delete"), groupId: TeamGroupIdSchema }),
  z.strictObject({
    type: z.literal("team.invite.create"),
    id: TeamInviteIdSchema,
    maxUses: z.literal(1),
    expiresAt: IsoDateTimeSchema,
  }),
  z.strictObject({ type: z.literal("team.invite.revoke"), inviteId: TeamInviteIdSchema }),
  z.strictObject({
    type: z.literal("team.invite.accept"),
    selector: z.string().min(24).max(96),
    verifier: z.string().min(24).max(128),
  }),
  z.strictObject({ type: z.literal("team.link.code.create") }),
  z.strictObject({ type: z.literal("team.link.revoke"), linkId: TeamLinkIdSchema }),
  z.strictObject({ type: z.literal("team.notice.read"), noticeId: TeamNoticeIdSchema }),
  z.strictObject({
    type: z.literal("team.knowledge.topic.create"),
    id: KnowledgeTopicIdSchema,
    name: name,
    peopleOnly: z.boolean(),
    access: z.array(TeamTopicAccessEntrySchema).max(1000),
  }),
  z.strictObject({
    type: z.literal("team.knowledge.topic.rename"),
    topicId: KnowledgeTopicIdSchema,
    name: name,
  }),
  z.strictObject({
    type: z.literal("team.knowledge.topic.access.set"),
    topicId: KnowledgeTopicIdSchema,
    expectedRevision: SequenceSchema,
    access: z.array(TeamTopicAccessEntrySchema).max(1000),
  }),
  z.strictObject({
    type: z.literal("team.knowledge.topic.peopleOnly.set"),
    topicId: KnowledgeTopicIdSchema,
    peopleOnly: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("team.knowledge.fact.append"),
    operationId: z.uuid(),
    facts: z.array(TeamFactInputSchema).min(1).max(teamKnowledgeLimits.factsPerWrite),
  }),
  z.strictObject({
    type: z.literal("team.agent.request.cancel"),
    requestId: TeamAgentRequestIdSchema,
  }),
  z.strictObject({ type: z.literal("teams.link.join"), link: TeamLinkOfferTextSchema }),
  z.strictObject({ type: z.literal("teams.link.leave"), teamId: DeploymentIdSchema }),
  z.strictObject({ type: z.literal("team.channel.archive"), channelId: TeamChannelIdSchema }),
  z.strictObject({ type: z.literal("team.channel.restore"), channelId: TeamChannelIdSchema }),
  z.strictObject({ type: z.literal("team.channel.join"), channelId: TeamChannelIdSchema }),
  z.strictObject({ type: z.literal("team.channel.leave"), channelId: TeamChannelIdSchema }),
  z.strictObject({
    type: z.literal("team.message.delete"),
    channelId: TeamChannelIdSchema,
    messageId: TeamMessageIdSchema,
  }),
  z.strictObject({
    type: z.literal("team.message.pin"),
    channelId: TeamChannelIdSchema,
    messageId: TeamMessageIdSchema,
  }),
  z.strictObject({
    type: z.literal("team.message.unpin"),
    channelId: TeamChannelIdSchema,
    messageId: TeamMessageIdSchema,
  }),
  z.strictObject({ type: z.literal("team.upload.complete"), blobId: TeamBlobIdSchema }),
  z.strictObject({ type: z.literal("team.upload.cancel"), blobId: TeamBlobIdSchema }),
  z.strictObject({
    type: z.literal("team.group.person.add"),
    groupId: TeamGroupIdSchema,
    userId: UserIdSchema,
  }),
  z.strictObject({
    type: z.literal("team.group.person.remove"),
    groupId: TeamGroupIdSchema,
    userId: UserIdSchema,
  }),
  z.strictObject({
    type: z.literal("team.group.child.add"),
    groupId: TeamGroupIdSchema,
    childGroupId: TeamGroupIdSchema,
  }),
  z.strictObject({
    type: z.literal("team.group.child.remove"),
    groupId: TeamGroupIdSchema,
    childGroupId: TeamGroupIdSchema,
  }),
  z.strictObject({
    type: z.literal("team.knowledge.topic.archive"),
    topicId: KnowledgeTopicIdSchema,
  }),
  z.strictObject({
    type: z.literal("team.knowledge.topic.restore"),
    topicId: KnowledgeTopicIdSchema,
  }),
  z.strictObject({
    type: z.literal("team.channel.topic.attach"),
    channelId: TeamChannelIdSchema,
    topicId: KnowledgeTopicIdSchema,
  }),
  z.strictObject({
    type: z.literal("team.channel.topic.detach"),
    channelId: TeamChannelIdSchema,
    topicId: KnowledgeTopicIdSchema,
  }),
]);
/** The identity RPCs a team Host serves beside its own `team.*` reads and commands. */
export const teamIdentityRpcNames = [
  "auth.config",
  "auth.native.complete",
  "auth.oidc.begin",
  "auth.signOut",
  "sessions.list",
] as const;
export const teamReadSchemas = {
  "team.bootstrap.get": { input: z.strictObject({}), output: TeamBootstrapSchema },
  "team.sidebar.get": {
    input: z
      .strictObject({
        after: TeamChannelIdSchema.optional(),
        channelIds: z.array(TeamChannelIdSchema).min(1).max(50).optional(),
      })
      .refine((input) => !input.after || !input.channelIds, "Choose after or channelIds"),
    output: TeamSidebarSchema,
  },
  "team.channels.list": {
    input: z.strictObject({ after: TeamChannelIdSchema.optional() }),
    output: z.strictObject({
      channels: z.array(TeamChannelSummarySchema).max(50),
      hasMore: z.boolean(),
    }),
  },
  "team.channel.get": {
    input: z.strictObject({ channelId: TeamChannelIdSchema }),
    output: TeamChannelSchema,
  },
  "team.channel.access.get": {
    input: z.strictObject({ channelId: TeamChannelIdSchema }),
    output: TeamChannelAccessSchema,
  },
  "team.channel.instructions.get": {
    input: z.strictObject({ channelId: TeamChannelIdSchema }),
    output: z.strictObject({ instructionsMarkdown: TeamMarkdownSchema, revision: SequenceSchema }),
  },
  "team.messages.page": {
    input: z.strictObject({ channelId: TeamChannelIdSchema, page: TeamPageDirectionSchema }),
    output: TeamMessagePageSchema,
  },
  "team.thread.page": {
    input: z.strictObject({
      channelId: TeamChannelIdSchema,
      rootId: TeamMessageIdSchema,
      page: TeamPageDirectionSchema,
    }),
    output: TeamMessagePageSchema,
  },
  "team.message.get": {
    input: z.strictObject({ channelId: TeamChannelIdSchema, messageId: TeamMessageIdSchema }),
    output: TeamMessageSchema,
  },
  "team.messages.check": {
    input: z.strictObject({
      channelId: TeamChannelIdSchema,
      clientMessageIds: z.array(z.uuid()).max(50),
    }),
    output: z.strictObject({ messages: z.array(TeamMessageSchema).max(50) }),
  },
  "team.search": {
    input: z.strictObject({ input: TeamSearchInputSchema }),
    output: TeamSearchPageSchema,
  },
  "team.members.list": {
    input: z.strictObject({ after: UserIdSchema.optional() }),
    output: z.strictObject({ members: z.array(TeamMemberSchema).max(50), hasMore: z.boolean() }),
  },
  "team.groups.list": {
    input: z.strictObject({ after: TeamGroupIdSchema.optional() }),
    output: z.strictObject({ groups: z.array(TeamGroupSchema).max(50), hasMore: z.boolean() }),
  },
  "team.group.get": {
    input: z.strictObject({ groupId: TeamGroupIdSchema }),
    output: TeamGroupSchema,
  },
  "team.invites.list": {
    input: z.strictObject({ after: TeamInviteIdSchema.optional() }),
    output: z.strictObject({ invites: z.array(TeamInviteSchema).max(50), hasMore: z.boolean() }),
  },
  "team.audit.page": {
    input: z.strictObject({ before: SequenceSchema.optional() }),
    output: z.strictObject({ audit: z.array(TeamAuditSchema).max(50), hasMore: z.boolean() }),
  },
  "team.notices.page": {
    input: z.strictObject({ before: TeamNoticeIdSchema.optional() }),
    output: z.strictObject({ notices: z.array(TeamNoticeSchema).max(50), hasMore: z.boolean() }),
  },
  "team.knowledge.topics.list": {
    input: z.strictObject({
      channelId: TeamChannelIdSchema.optional(),
      after: KnowledgeTopicIdSchema.optional(),
    }),
    output: z.strictObject({ topics: z.array(TeamTopicSchema).max(50), hasMore: z.boolean() }),
  },
  "team.knowledge.topic.get": {
    input: z.strictObject({ topicId: KnowledgeTopicIdSchema }),
    output: TeamTopicSchema,
  },
  "team.knowledge.topic.access.get": {
    input: z.strictObject({ topicId: KnowledgeTopicIdSchema }),
    output: TeamTopicAccessSchema,
  },
  "team.agent.requests.get": {
    input: z.strictObject({ channelId: TeamChannelIdSchema, rootId: TeamMessageIdSchema }),
    output: z.strictObject({ requests: z.array(TeamAgentRequestSchema).max(32) }),
  },
  "team.links.list": {
    input: z.strictObject({}),
    output: z.strictObject({ links: z.array(TeamLinkViewSchema).max(50) }),
  },
  "teams.links.list": {
    input: z.strictObject({}),
    output: z.strictObject({ links: z.array(PersonalTeamLinkSchema).max(100) }),
  },
  "teams.threadTask.get": {
    input: z.strictObject({
      teamId: DeploymentIdSchema,
      channelId: TeamChannelIdSchema,
      threadRootId: TeamMessageIdSchema,
    }),
    output: z.strictObject({ taskId: ThreadIdSchema.nullable() }),
  },
  "teams.replyTask.get": {
    input: z.strictObject({
      teamId: DeploymentIdSchema,
      channelId: TeamChannelIdSchema,
      threadRootId: TeamMessageIdSchema,
      replyMessageId: TeamMessageIdSchema,
    }),
    output: z.union([
      z.strictObject({ taskId: ThreadIdSchema, throughSequence: SequenceSchema }),
      z.strictObject({ taskId: z.null(), throughSequence: z.null() }),
    ]),
  },
  "team.mentions.page": {
    input: z.strictObject({
      channelId: TeamChannelIdSchema.optional(),
      before: TeamMessageIdSchema.optional(),
    }),
    output: z.strictObject({ messages: z.array(TeamMessageSchema).max(50), hasMore: z.boolean() }),
  },
  "team.pins.page": {
    input: z.strictObject({
      channelId: TeamChannelIdSchema.optional(),
      before: TeamMessageIdSchema.optional(),
    }),
    output: z.strictObject({ messages: z.array(TeamMessageSchema).max(50), hasMore: z.boolean() }),
  },
  "team.files.page": {
    input: z.strictObject({
      channelId: TeamChannelIdSchema,
      before: TeamMessageIdSchema.optional(),
    }),
    output: z.strictObject({
      files: z
        .array(z.strictObject({ messageId: TeamMessageIdSchema, file: TeamFileSchema }))
        .max(50),
      hasMore: z.boolean(),
    }),
  },
  "team.knowledge.facts.page": {
    input: z.strictObject({ topicId: KnowledgeTopicIdSchema, before: SequenceSchema.optional() }),
    output: z.strictObject({ facts: z.array(TeamFactSchema).max(50), hasMore: z.boolean() }),
  },
  "team.knowledge.history.page": {
    input: z.strictObject({ topicId: KnowledgeTopicIdSchema, before: SequenceSchema.optional() }),
    output: z.strictObject({ facts: z.array(TeamFactSchema).max(50), hasMore: z.boolean() }),
  },
} as const;
