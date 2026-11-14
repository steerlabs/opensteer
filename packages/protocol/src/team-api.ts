import { z } from "zod";
import {
  DeploymentIdSchema,
  IsoDateTimeSchema,
  KnowledgeNoteIdSchema,
  KnowledgeTopicIdSchema,
  SequenceSchema,
  TeamAgentRequestIdSchema,
  TeamAskDecisionSchema,
  TeamBlobIdSchema,
  TeamChannelIdSchema,
  TeamGroupIdSchema,
  TeamHandleSchema,
  TeamInviteIdSchema,
  TeamLinkIdSchema,
  TeamMessageIdSchema,
  TeamNoticeIdSchema,
  TeamOriginSchema,
  ThreadIdSchema,
  UserIdSchema,
} from "@opensteer/core";
import {
  TeamAuditSchema,
  TeamChannelAccessEntrySchema,
  TeamChannelAccessSchema,
  TeamCurrentInviteSchema,
  TeamGroupSchema,
  TeamInviteExpiryDaysSchema,
  TeamInviteMaxUsesSchema,
  TeamInviteSchema,
  TeamMemberRoleSchema,
  TeamMemberSchema,
  TeamNoticeSchema,
  TeamTopicAccessEntrySchema,
  TeamTopicAccessSchema,
} from "./team-access.js";
import {
  TeamRemotePeopleSchema,
  TeamAgentRequestSchema,
  TeamAgentRecipientSchema,
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
  TeamKnowledgeCursorSchema,
  TeamNoteBodySchema,
  TeamNotePreviewSchema,
  TeamNoteSchema,
  TeamNoteTitleSchema,
  TeamNoteVersionSchema,
  TeamTopicDescriptionSchema,
  TeamTopicNameSchema,
  TeamTopicSchema,
  teamKnowledgeLimits,
} from "./team-knowledge.js";
import {
  PersonalTeamLinkSchema,
  TeamUploadMetadataSchema,
  TeamLinkOfferTextSchema,
  TeamLinkViewSchema,
} from "./team-link.js";

import {
  TeamPartnerLinkSchema,
  TeamPartnerInviteSchema,
  TeamPartnerOfferTextSchema,
  TeamSharingPolicySchema,
} from "./team-partner.js";

const name = z.string().trim().min(1).max(160);

/** The key a team keeps live channel names unique by, so `General` and `general` are one name. */
export function teamChannelNameKey(value: string): string {
  return value.trim().normalize("NFKC").toLowerCase();
}
/** The `reason` of the conflict a name another live channel holds is refused with. */
export const teamChannelNameTakenReason = "channel-name-taken";
/** The most people a direct message can add to the one who opens it. */
export const teamDmMaxParticipants = 31;
export const TeamCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("team.share.participant.restore"),
    shareId: z.uuid(),
    principalId: UserIdSchema,
  }),
  z.strictObject({
    type: z.literal("team.share.participant.remove"),
    shareId: z.uuid(),
    principalId: UserIdSchema,
  }),
  z.strictObject({
    type: z.literal("team.share.offer"),
    channelId: TeamChannelIdSchema,
    linkId: z.uuid(),
    historyVisibleConfirmed: z.literal(true),
  }),
  z.strictObject({ type: z.literal("team.share.approve"), shareId: z.uuid() }),
  z.strictObject({
    type: z.literal("team.share.accept"),
    shareId: z.uuid(),
    id: TeamChannelIdSchema,
    kind: z.enum(["public", "private"]),
    name: name,
    peopleOnly: z.boolean(),
    access: z.array(TeamChannelAccessEntrySchema).max(1000),
  }),
  z.strictObject({ type: z.literal("team.share.end"), shareId: z.uuid() }),
  z.strictObject({ type: z.literal("team.partner.invite.create") }),
  z.strictObject({ type: z.literal("team.partner.invite.revoke"), inviteId: z.uuid() }),
  z.strictObject({
    type: z.literal("team.partner.invite.redeem"),
    offer: TeamPartnerOfferTextSchema,
  }),
  z.strictObject({ type: z.literal("team.partner.approve"), linkId: z.uuid() }),
  z.strictObject({ type: z.literal("team.partner.revoke"), linkId: z.uuid() }),
  z.strictObject({ type: z.literal("team.sharing.policy.set"), policy: TeamSharingPolicySchema }),
  z.strictObject({
    type: z.literal("team.agent.recipient.set"),
    channelId: TeamChannelIdSchema,
    rootId: TeamMessageIdSchema,
    enabled: z.boolean(),
  }),
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
    participants: z.array(UserIdSchema).min(1).max(teamDmMaxParticipants),
  }),
  z.strictObject({
    type: z.literal("team.dm.people.add"),
    channelId: TeamChannelIdSchema,
    userIds: z.array(UserIdSchema).min(1).max(teamDmMaxParticipants),
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
    metadata: TeamUploadMetadataSchema,
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
  /**
   * Replaces the team's current reusable invite only when it is still `replaces` (null: when
   * there is none); otherwise answers the one another manager made meanwhile. `id` names the new
   * invite, so a retried reset returns it instead of replacing it again.
   */
  z.strictObject({
    type: z.literal("team.invite.reset"),
    id: TeamInviteIdSchema,
    replaces: TeamInviteIdSchema.nullable(),
    expiresInDays: TeamInviteExpiryDaysSchema,
    maxUses: TeamInviteMaxUsesSchema,
  }),
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
    name: TeamTopicNameSchema,
    description: TeamTopicDescriptionSchema,
    access: z.array(TeamTopicAccessEntrySchema).max(1000),
  }),
  z.strictObject({
    type: z.literal("team.knowledge.topic.update"),
    topicId: KnowledgeTopicIdSchema,
    name: TeamTopicNameSchema,
    description: TeamTopicDescriptionSchema,
  }),
  z.strictObject({
    type: z.literal("team.knowledge.topic.access.set"),
    topicId: KnowledgeTopicIdSchema,
    expectedRevision: SequenceSchema,
    access: z.array(TeamTopicAccessEntrySchema).max(1000),
  }),
  z.strictObject({
    type: z.literal("team.knowledge.note.write"),
    noteId: KnowledgeNoteIdSchema,
    topicId: KnowledgeTopicIdSchema,
    /** null creates the note; otherwise the version you edited, refused if it moved on. */
    expectedVersion: TeamNoteVersionSchema.nullable(),
    title: TeamNoteTitleSchema,
    body: TeamNoteBodySchema,
  }),
  z.strictObject({
    type: z.literal("team.knowledge.note.delete"),
    noteId: KnowledgeNoteIdSchema,
    expectedVersion: TeamNoteVersionSchema,
  }),
  z.strictObject({
    type: z.literal("team.agent.request.cancel"),
    requestId: TeamAgentRequestIdSchema,
  }),
  z.strictObject({ type: z.literal("teams.link.join"), link: TeamLinkOfferTextSchema }),
  z.strictObject({ type: z.literal("teams.link.leave"), teamId: DeploymentIdSchema }),
  z.strictObject({
    type: z.literal("teams.ask.decide"),
    teamId: DeploymentIdSchema,
    requestId: TeamAgentRequestIdSchema,
    decision: TeamAskDecisionSchema,
  }),
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
  "team.share.participants.get": {
    input: z.strictObject({
      channelId: TeamChannelIdSchema,
      after: TeamHandleSchema.optional(),
      query: z.string().trim().min(1).max(80).optional(),
    }),
    output: z.object({
      participants: z
        .array(
          z.object({
            userId: UserIdSchema,
            handle: TeamHandleSchema,
            level: z.enum(["read", "post"]),
            state: z.enum(["active", "removed"]),
          }),
        )
        .max(50),
      people: TeamRemotePeopleSchema,
      nextCursor: TeamHandleSchema.nullable(),
    }),
  },
  "team.shares.list": {
    input: z.strictObject({ channelId: TeamChannelIdSchema.optional() }),
    output: z.object({
      shares: z
        .array(
          z.object({
            id: z.uuid(),
            historyFromShareId: z.uuid().nullable().optional(),
            channelId: TeamChannelIdSchema.nullable(),
            partnerName: name,
            role: z.enum(["owner", "follower"]),
            state: z.enum(["offered", "active", "ended"]),
            generation: z.number().int().positive(),
            name: name,
            ready: z.boolean(),
            localApproved: z.boolean(),
            canApprove: z.boolean().optional(),
            canAccept: z.boolean().optional(),
            canEnd: z.boolean().optional(),
            peopleOnly: z.boolean().optional(),
          }),
        )
        .max(50),
    }),
  },
  "team.partners.list": {
    input: z.strictObject({ after: z.uuid().optional() }),
    output: z.object({
      links: z.array(TeamPartnerLinkSchema).max(50),
      nextCursor: z.uuid().nullable(),
    }),
  },
  "team.partner.invites.list": {
    input: z.strictObject({ after: z.uuid().optional() }),
    output: z.object({
      invites: z.array(TeamPartnerInviteSchema).max(50),
      nextCursor: z.uuid().nullable(),
    }),
  },
  "team.sharing.policy.get": {
    input: z.strictObject({}),
    output: z.object({
      policy: TeamSharingPolicySchema,
      canSet: z.boolean(),
      canPropose: z.boolean().optional(),
    }),
  },
  "team.partner.invite.preview": {
    input: z.strictObject({ offer: TeamPartnerOfferTextSchema }),
    output: z.object({
      name: z.string().min(1).max(160),
      origin: TeamOriginSchema,
      expiresAt: IsoDateTimeSchema,
    }),
  },
  "team.agent.recipient.get": {
    input: z.strictObject({ channelId: TeamChannelIdSchema, rootId: TeamMessageIdSchema }),
    output: TeamAgentRecipientSchema,
  },
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
    output: TeamMessageSchema.extend({ people: TeamRemotePeopleSchema.optional() }),
  },
  "team.messages.check": {
    input: z.strictObject({
      channelId: TeamChannelIdSchema,
      clientMessageIds: z.array(z.uuid()).max(50),
    }),
    output: z.strictObject({
      people: TeamRemotePeopleSchema.optional(),
      messages: z.array(TeamMessageSchema).max(50),
    }),
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
  "team.invite.current.get": {
    input: z.strictObject({}),
    output: z.strictObject({ invite: TeamCurrentInviteSchema.nullable() }),
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
    input: z.strictObject({ after: KnowledgeTopicIdSchema.optional() }),
    output: z.strictObject({
      topics: z.array(TeamTopicSchema).max(teamKnowledgeLimits.pageSize),
      hasMore: z.boolean(),
    }),
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
      z.strictObject({ taskId: ThreadIdSchema, completedAt: IsoDateTimeSchema }),
      z.strictObject({ taskId: z.null(), completedAt: z.null() }),
    ]),
  },
  "team.mentions.page": {
    input: z.strictObject({
      channelId: TeamChannelIdSchema.optional(),
      before: TeamMessageIdSchema.optional(),
    }),
    output: z.strictObject({
      people: TeamRemotePeopleSchema.optional(),
      messages: z.array(TeamMessageSchema).max(50),
      hasMore: z.boolean(),
    }),
  },
  "team.pins.page": {
    input: z.strictObject({
      channelId: TeamChannelIdSchema.optional(),
      before: TeamMessageIdSchema.optional(),
    }),
    output: z.strictObject({
      people: TeamRemotePeopleSchema.optional(),
      messages: z.array(TeamMessageSchema).max(50),
      hasMore: z.boolean(),
    }),
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
  /** Newest-changed first in one topic or every readable topic; with `query`, best matches first. */
  "team.knowledge.notes.page": {
    input: z.strictObject({
      topicId: KnowledgeTopicIdSchema.optional(),
      query: z.string().trim().min(1).max(teamKnowledgeLimits.queryChars).optional(),
      cursor: TeamKnowledgeCursorSchema.optional(),
    }),
    output: z.strictObject({
      notes: z.array(TeamNotePreviewSchema).max(teamKnowledgeLimits.pageSize),
      nextCursor: TeamKnowledgeCursorSchema.nullable(),
    }),
  },
  "team.knowledge.note.get": {
    input: z.strictObject({ noteId: KnowledgeNoteIdSchema }),
    output: TeamNoteSchema,
  },
  /** Every version of a note, newest first. */
  "team.knowledge.note.history": {
    input: z.strictObject({
      noteId: KnowledgeNoteIdSchema,
      before: TeamNoteVersionSchema.optional(),
    }),
    output: z.strictObject({
      versions: z.array(TeamNoteSchema).max(teamKnowledgeLimits.pageSize),
      hasMore: z.boolean(),
    }),
  },
} as const;
