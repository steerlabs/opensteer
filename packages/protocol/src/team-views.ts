import { z } from "zod";
import { teamReadSchemas } from "./team-api.js";
import { teamPageSize, teamPreviewMaxBytes } from "./team-chat.js";
import {
  TeamAuditSchema,
  TeamCanSchema,
  TeamChannelAccessEntrySchema,
  TeamChannelAccessSchema,
  TeamChannelCanSchema,
  TeamGroupSchema,
  TeamInviteSchema,
  TeamMemberSchema,
  TeamNoticeSchema,
  TeamTopicAccessEntrySchema,
  TeamTopicAccessSchema,
  TeamTopicCanSchema,
} from "./team-access.js";
import {
  TeamAgentRequestSchema,
  TeamBootstrapSchema,
  TeamChannelSummarySchema,
  TeamFileSchema,
  TeamMarkdownSchema,
  TeamMentionSchema,
  TeamMessagePageSchema,
  TeamMessageSchema,
  TeamSearchPageSchema,
  TeamSidebarEntrySchema,
  TeamSidebarSchema,
} from "./team-chat.js";
import {
  IsoDateTimeSchema,
  SequenceSchema,
  TaskFolderSchema,
  TeamAudienceSchema,
  TeamBlobIdSchema,
  TeamChannelIdSchema,
  TeamGroupIdSchema,
  TeamMessageIdSchema,
  TeamStatusStepSchema,
  TeamTaskOriginSchema,
  ThreadIdSchema,
  UserIdSchema,
} from "@opensteer/core";
import {
  PersonalTeamLinkSchema,
  TeamLinkOfferTextSchema,
  TeamLinkViewSchema,
} from "./team-link.js";

import { TeamFactInputSchema, TeamTopicSchema } from "./team-knowledge.js";

export const TeamChannelCanViewSchema = z.object({ ...TeamChannelCanSchema.shape });

export const TeamChannelSummaryViewSchema = z.object({
  ...TeamChannelSummarySchema.shape,
  can: TeamChannelCanViewSchema,
});

export const TeamChannelViewSchema = TeamChannelSummaryViewSchema.extend({
  instructionsMarkdown: TeamMarkdownSchema,
  instructionsRevision: SequenceSchema,
}).strip();

export const TeamMentionViewSchema = z.object({ ...TeamMentionSchema.shape });

export const TeamFileViewSchema = z.object({
  ...TeamFileSchema.shape,
  preview: z
    .object({
      mediaType: z.enum(["image/jpeg", "image/png", "image/webp"]),
      sizeBytes: z.number().int().positive().max(teamPreviewMaxBytes),
    })
    .nullable(),
});

export const TeamStatusStepViewSchema = z.object({ ...TeamStatusStepSchema.shape });

export const TeamAgentRequestViewSchema = z.object({
  ...TeamAgentRequestSchema.shape,
  steps: z.array(TeamStatusStepViewSchema).max(8),
});

export const TeamMessageViewSchema = z.object({
  ...TeamMessageSchema.shape,
  mentions: z.array(TeamMentionViewSchema).max(20),
  attachments: z.array(TeamFileViewSchema).max(10),
  replySummary: z.object({
    count: z.number().int().nonnegative(),
    latestMessageId: TeamMessageIdSchema.nullable(),
    repliers: z.array(UserIdSchema).max(4),
  }),
  requests: z.array(TeamAgentRequestViewSchema).max(32),
});

export const TeamInviteViewSchema = z.object({ ...TeamInviteSchema.shape });

export const TeamLinkViewViewSchema = z.object({ ...TeamLinkViewSchema.shape });

export const PersonalTeamLinkViewSchema = z.object({ ...PersonalTeamLinkSchema.shape });

export const TeamCommandResultViewSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("team.channel.create"), channel: TeamChannelViewSchema }),
  z.object({ type: z.literal("team.channel.update") }),
  z.object({ type: z.literal("team.channel.access.set") }),
  z.object({ type: z.literal("team.channel.instructions.set") }),
  z.object({ type: z.literal("team.dm.open"), channel: TeamChannelViewSchema }),
  z.object({ type: z.literal("team.dm.people.add") }),
  z.object({
    type: z.literal("team.message.send"),
    message: TeamMessageViewSchema,
    wake: z.enum(["queued", "no-link", "not-requested", "rate-limited", "people-only"]),
  }),
  z.object({ type: z.literal("team.message.edit") }),
  z.object({ type: z.literal("team.channel.read") }),
  z.object({ type: z.literal("team.channel.preferences.set") }),
  z.object({ type: z.literal("team.upload.begin"), fileId: TeamBlobIdSchema }),
  z.object({ type: z.literal("team.member.role.set") }),
  z.object({ type: z.literal("team.member.remove") }),
  z.object({ type: z.literal("team.owner.transfer") }),
  z.object({ type: z.literal("team.group.create") }),
  z.object({ type: z.literal("team.group.rename") }),
  z.object({ type: z.literal("team.group.delete") }),
  z.object({ type: z.literal("team.invite.create"), invite: TeamInviteViewSchema, url: z.url() }),
  z.object({ type: z.literal("team.invite.revoke") }),
  z.object({ type: z.literal("team.invite.accept") }),
  z.object({
    type: z.literal("team.link.code.create"),
    offer: TeamLinkOfferTextSchema,
    replacing: TeamLinkViewViewSchema.nullable(),
  }),
  z.object({ type: z.literal("team.link.revoke") }),
  z.object({ type: z.literal("team.notice.read") }),
  z.object({ type: z.literal("team.knowledge.topic.create") }),
  z.object({ type: z.literal("team.knowledge.topic.rename") }),
  z.object({ type: z.literal("team.knowledge.topic.access.set") }),
  z.object({ type: z.literal("team.knowledge.topic.peopleOnly.set") }),
  z.object({ type: z.literal("team.knowledge.fact.append") }),
  z.object({ type: z.literal("team.agent.request.cancel") }),
  z.object({ type: z.literal("teams.link.join"), link: PersonalTeamLinkViewSchema }),
  z.object({ type: z.literal("teams.link.leave") }),
  z.object({ type: z.literal("teams.channelFolder.set") }),
  z.object({ type: z.literal("team.channel.archive") }),
  z.object({ type: z.literal("team.channel.restore") }),
  z.object({ type: z.literal("team.channel.join") }),
  z.object({ type: z.literal("team.channel.leave") }),
  z.object({ type: z.literal("team.message.delete") }),
  z.object({ type: z.literal("team.message.pin") }),
  z.object({ type: z.literal("team.message.unpin") }),
  z.object({ type: z.literal("team.upload.complete") }),
  z.object({ type: z.literal("team.upload.cancel") }),
  z.object({ type: z.literal("team.group.person.add") }),
  z.object({ type: z.literal("team.group.person.remove") }),
  z.object({ type: z.literal("team.group.child.add") }),
  z.object({ type: z.literal("team.group.child.remove") }),
  z.object({ type: z.literal("team.knowledge.topic.archive") }),
  z.object({ type: z.literal("team.knowledge.topic.restore") }),
  z.object({ type: z.literal("team.channel.topic.attach") }),
  z.object({ type: z.literal("team.channel.topic.detach") }),
]);

export const TeamMemberViewSchema = z.object({ ...TeamMemberSchema.shape });

export const TeamCanViewSchema = z.object({ ...TeamCanSchema.shape });

export const TeamSidebarEntryViewSchema = z.object({
  ...TeamSidebarEntrySchema.shape,
  channel: TeamChannelSummaryViewSchema,
});

export const TeamSidebarViewSchema = z.object({
  ...TeamSidebarSchema.shape,
  channels: z.array(TeamSidebarEntryViewSchema).max(50),
});

export const TeamBootstrapViewSchema = z.object({
  ...TeamBootstrapSchema.shape,
  member: TeamMemberViewSchema,
  can: TeamCanViewSchema,
  sidebar: TeamSidebarViewSchema,
});

export const TeamAccessSubjectViewSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("person"), userId: UserIdSchema }),
  z.object({ kind: z.literal("group"), groupId: TeamGroupIdSchema }),
]);

export const TeamChannelAccessEntryViewSchema = z.object({
  ...TeamChannelAccessEntrySchema.shape,
  subject: TeamAccessSubjectViewSchema,
});

export const TeamChannelAccessViewSchema = z.object({
  ...TeamChannelAccessSchema.shape,
  entries: z.array(TeamChannelAccessEntryViewSchema).max(1000),
  can: TeamChannelCanViewSchema,
});

export const TeamMessagePageViewSchema = z.object({
  ...TeamMessagePageSchema.shape,
  messages: z.array(TeamMessageViewSchema).max(teamPageSize),
  channel: TeamChannelViewSchema,
});

export const TeamTaskOriginViewSchema = z.object({ ...TeamTaskOriginSchema.shape });

export const TeamAudienceViewSchema = z.object({ ...TeamAudienceSchema.shape });

export const TeamSourceViewSchema = TeamTaskOriginViewSchema.extend({
  messageId: TeamMessageIdSchema.nullable(),
  audience: TeamAudienceViewSchema,
}).strip();

export const TeamSearchPageViewSchema = z.object({
  ...TeamSearchPageSchema.shape,
  results: z
    .array(z.object({ message: TeamMessageViewSchema, source: TeamSourceViewSchema }))
    .max(50),
});

export const TeamGroupViewSchema = z.object({ ...TeamGroupSchema.shape });

export const TeamActorViewSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("human"), userId: UserIdSchema }),
  z.object({ kind: z.literal("agent"), userId: UserIdSchema }),
]);

export const TeamAuditViewSchema = z.object({
  ...TeamAuditSchema.shape,
  actor: TeamActorViewSchema.nullable(),
});

export const TeamNoticeViewSchema = z.object({ ...TeamNoticeSchema.shape });

export const TeamTopicCanViewSchema = z.object({ ...TeamTopicCanSchema.shape });

export const TeamTopicViewSchema = z.object({
  ...TeamTopicSchema.shape,
  can: TeamTopicCanViewSchema,
});

export const TeamTopicAccessEntryViewSchema = z.object({
  ...TeamTopicAccessEntrySchema.shape,
  subject: TeamAccessSubjectViewSchema,
});

export const TeamTopicAccessViewSchema = z.object({
  ...TeamTopicAccessSchema.shape,
  entries: z.array(TeamTopicAccessEntryViewSchema).max(1000),
  can: TeamTopicCanViewSchema,
});

export const TaskFolderViewSchema = z.object({ ...TaskFolderSchema.shape });

export const TeamFactInputViewSchema = z.object({ ...TeamFactInputSchema.shape });

export const TeamFactViewSchema = TeamFactInputViewSchema.extend({
  id: SequenceSchema,
  writerUserId: UserIdSchema,
  /** "agent" is the writer's own agent. */
  writerKind: z.enum(["human", "agent"]),
  writtenAt: IsoDateTimeSchema,
  /** The asking message an agent's write answered. */
  source: z.object({ channelId: TeamChannelIdSchema, messageId: TeamMessageIdSchema }).nullable(),
});

export const teamReadViews = {
  "team.bootstrap.get": TeamBootstrapViewSchema,
  "team.sidebar.get": TeamSidebarViewSchema,
  "team.channels.list": z.object({
    channels: z.array(TeamChannelSummaryViewSchema).max(50),
    hasMore: z.boolean(),
  }),
  "team.channel.get": TeamChannelViewSchema,
  "team.channel.access.get": TeamChannelAccessViewSchema,
  "team.channel.instructions.get": z.object({
    instructionsMarkdown: TeamMarkdownSchema,
    revision: SequenceSchema,
  }),
  "team.messages.page": TeamMessagePageViewSchema,
  "team.thread.page": TeamMessagePageViewSchema,
  "team.message.get": TeamMessageViewSchema,
  "team.messages.check": z.object({ messages: z.array(TeamMessageViewSchema).max(50) }),
  "team.search": TeamSearchPageViewSchema,
  "team.members.list": z.object({
    members: z.array(TeamMemberViewSchema).max(50),
    hasMore: z.boolean(),
  }),
  "team.groups.list": z.object({
    groups: z.array(TeamGroupViewSchema).max(50),
    hasMore: z.boolean(),
  }),
  "team.group.get": TeamGroupViewSchema,
  "team.invites.list": z.object({
    invites: z.array(TeamInviteViewSchema).max(50),
    hasMore: z.boolean(),
  }),
  "team.audit.page": z.object({
    audit: z.array(TeamAuditViewSchema).max(50),
    hasMore: z.boolean(),
  }),
  "team.notices.page": z.object({
    notices: z.array(TeamNoticeViewSchema).max(50),
    hasMore: z.boolean(),
  }),
  "team.knowledge.topics.list": z.object({
    topics: z.array(TeamTopicViewSchema).max(50),
    hasMore: z.boolean(),
  }),
  "team.knowledge.topic.get": TeamTopicViewSchema,
  "team.knowledge.topic.access.get": TeamTopicAccessViewSchema,
  "team.agent.requests.get": z.object({ requests: z.array(TeamAgentRequestViewSchema).max(32) }),
  "team.links.list": z.object({ links: z.array(TeamLinkViewViewSchema).max(50) }),
  "teams.links.list": z.object({ links: z.array(PersonalTeamLinkViewSchema).max(100) }),
  "teams.channelFolder.get": z.object({ folder: TaskFolderViewSchema }),
  "teams.threadTask.get": z.object({ taskId: ThreadIdSchema.nullable() }),
  "teams.replyTask.get": z.union([
    teamReadSchemas["teams.replyTask.get"].output.options[0].strip(),
    teamReadSchemas["teams.replyTask.get"].output.options[1].strip(),
  ]),
  "team.mentions.page": z.object({
    messages: z.array(TeamMessageViewSchema).max(50),
    hasMore: z.boolean(),
  }),
  "team.pins.page": z.object({
    messages: z.array(TeamMessageViewSchema).max(50),
    hasMore: z.boolean(),
  }),
  "team.files.page": z.object({
    files: z.array(z.object({ messageId: TeamMessageIdSchema, file: TeamFileViewSchema })).max(50),
    hasMore: z.boolean(),
  }),
  "team.knowledge.facts.page": z.object({
    facts: z.array(TeamFactViewSchema).max(50),
    hasMore: z.boolean(),
  }),
  "team.knowledge.history.page": z.object({
    facts: z.array(TeamFactViewSchema).max(50),
    hasMore: z.boolean(),
  }),
} as const;
