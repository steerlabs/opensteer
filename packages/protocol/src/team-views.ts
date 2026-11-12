import { z } from "zod";
import { teamReadSchemas } from "./team-api.js";
import { ProtocolErrorSchema } from "./common.js";
import { teamPageSize, teamPreviewMaxBytes } from "./team-chat.js";
import {
  TeamAuditSchema,
  TeamCanSchema,
  TeamChannelAccessEntrySchema,
  TeamChannelAccessSchema,
  TeamChannelCanSchema,
  TeamGroupSchema,
  TeamCurrentInviteSchema,
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
  TeamClientFrameSchema,
  TeamConsistentCutSchema,
  TeamFileSchema,
  TeamLinkPresenceSchema,
  TeamMarkdownSchema,
  TeamMentionSchema,
  TeamMessagePageSchema,
  TeamMessageSchema,
  TeamRequestContextSchema,
  TeamSearchPageSchema,
  TeamServerFrameSchema,
  TeamSidebarEntrySchema,
  TeamSidebarSchema,
  TeamSubscriptionScopeSchema,
} from "./team-chat.js";
import {
  IsoDateTimeSchema,
  KnowledgeTopicIdSchema,
  SequenceSchema,
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
  TeamLinkClientFrameSchema,
  TeamLinkOfferTextSchema,
  TeamLinkResultSchema,
  TeamLinkServerFrameSchema,
  TeamLinkViewSchema,
} from "./team-link.js";

import { teamKnowledgeLimits, TeamFactInputSchema, TeamTopicSchema } from "./team-knowledge.js";

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

export const TeamCurrentInviteViewSchema = z.object({ ...TeamCurrentInviteSchema.shape });

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
  z.object({ type: z.literal("team.invite.reset"), invite: TeamCurrentInviteViewSchema }),
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
  "team.invite.current.get": z.object({ invite: TeamCurrentInviteViewSchema.nullable() }),
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

const TeamSqlColumnViewSchema = z.object({
  name: z.string().max(255),
  postgresType: z.string().max(255),
});

export const TeamSqlResultViewSchema = z.object({
  relations: z
    .array(
      z.object({
        name: z.string().max(64),
        columns: z.array(TeamSqlColumnViewSchema).max(64),
        insertable: z.array(z.string().max(64)).max(16),
      }),
    )
    .max(8)
    .optional(),
  topics: z
    .array(z.object({ id: KnowledgeTopicIdSchema, name: z.string().max(160) }))
    .max(50)
    .optional(),
  nextCursor: KnowledgeTopicIdSchema.optional(),
  columns: z.array(TeamSqlColumnViewSchema).max(1664).optional(),
  rows: z.array(z.array(z.json()).max(1664)).max(200).optional(),
  truncated: z.boolean().optional(),
  receipt: z
    .object({
      committed: z.literal(true),
      replayed: z.boolean(),
      facts: z
        .array(
          z.object({
            id: SequenceSchema,
            topic: KnowledgeTopicIdSchema,
            thing: z.string(),
            property: z.string(),
            replacesId: SequenceSchema.nullable(),
            seenFactId: SequenceSchema.nullable(),
            baseline: z.enum(["observed", "unknown"]),
            unseenCount: z.number().int().nonnegative().nullable(),
            unseen: z
              .array(
                z.object({
                  id: SequenceSchema,
                  writerKind: z.enum(["human", "agent"]),
                  writerId: UserIdSchema,
                  writtenAt: z.string(),
                }),
              )
              .max(20)
              .nullable(),
          }),
        )
        .max(teamKnowledgeLimits.factsPerWrite),
    })
    .optional(),
});

const [channelScope, threadScope] = TeamSubscriptionScopeSchema.options;
const TeamSubscriptionScopeViewSchema = z.discriminatedUnion("kind", [
  channelScope.strip(),
  threadScope.strip(),
]);

const [snapshotCut, resumedCut] = TeamConsistentCutSchema.options;
const cutView = {
  linkPresence: z.array(TeamLinkPresenceSchema.strip()).max(200),
  scope: TeamSubscriptionScopeViewSchema,
  channel: TeamChannelViewSchema,
  requests: z.array(TeamAgentRequestViewSchema).max(200),
};
/** Bounds stay with reduceTeamCut, which parses the canonical cut. */
export const TeamConsistentCutViewSchema = z.discriminatedUnion("type", [
  z.object({
    ...snapshotCut.shape,
    ...cutView,
    messages: z.array(TeamMessageViewSchema).max(50),
  }),
  z.object({
    ...resumedCut.shape,
    ...cutView,
    changedRows: z.array(TeamMessageViewSchema).max(200),
  }),
]);

/*
 * Frame views are what a peer reads: unknown fields are dropped, and
 * readTeamFrame skips unknown frame types. Writers keep the strict schemas.
 */
const [cut, sidebar, sidebarDirty, linkPresence, typing, presence, accessChanged] =
  TeamServerFrameSchema.options;
export const TeamServerFrameViewSchema = z.discriminatedUnion("type", [
  z.object({ ...cut.shape, cut: TeamConsistentCutViewSchema }),
  z.object({ ...sidebar.shape, sidebar: TeamSidebarViewSchema }),
  sidebarDirty.strip(),
  linkPresence.strip(),
  typing.strip(),
  z.object({ ...presence.shape, people: z.array(presence.shape.people.element.strip()).max(50) }),
  accessChanged.strip(),
]);

const [subscribe, clientTyping, clientPresence] = TeamClientFrameSchema.options;
export const TeamClientFrameViewSchema = z.discriminatedUnion("type", [
  z.object({ ...subscribe.shape, scope: TeamSubscriptionScopeViewSchema.nullable() }),
  clientTyping.strip(),
  clientPresence.strip(),
]);

const TeamRequestContextViewSchema = z.object({
  ...TeamRequestContextSchema.shape,
  request: TeamAgentRequestViewSchema,
  messages: z.array(TeamMessageViewSchema).max(50),
  source: TeamSourceViewSchema,
  audience: TeamAudienceViewSchema,
});
const [accepted, context, receipt, read, search, sql, file, ok] = TeamLinkResultSchema.options;
const TeamLinkResultViewSchema = z.discriminatedUnion("kind", [
  z.object({ ...accepted.shape, request: TeamAgentRequestViewSchema }),
  z.object({ ...context.shape, context: TeamRequestContextViewSchema }),
  receipt.strip(),
  z.object({
    ...read.shape,
    result: z.object({ page: TeamMessagePageViewSchema, source: TeamSourceViewSchema }),
  }),
  z.object({ ...search.shape, result: TeamSearchPageViewSchema }),
  z.object({ ...sql.shape, result: TeamSqlResultViewSchema }),
  z.object({ ...file.shape, file: TeamFileViewSchema, source: TeamSourceViewSchema }),
  ok.strip(),
]);
const [ready, requests, cancel, result, error, revoked, pong] = TeamLinkServerFrameSchema.options;
export const TeamLinkServerFrameViewSchema = z.discriminatedUnion("type", [
  z.object({ ...ready.shape, link: TeamLinkViewViewSchema }),
  z.object({
    ...requests.shape,
    requests: z
      .array(z.object({ request: TeamAgentRequestViewSchema, source: TeamSourceViewSchema }))
      .max(32),
  }),
  cancel.strip(),
  z.object({ ...result.shape, result: TeamLinkResultViewSchema }),
  z.object({ ...error.shape, error: z.object(ProtocolErrorSchema.shape) }),
  revoked.strip(),
  pong.strip(),
]);

const [
  hello,
  accept,
  contextCall,
  status,
  reply,
  receiptCall,
  readCall,
  searchCall,
  sqlCall,
  revoke,
  ping,
] = TeamLinkClientFrameSchema.options;
export const TeamLinkClientFrameViewSchema = z.discriminatedUnion("type", [
  z.object({
    ...hello.shape,
    terminalRequests: z.array(hello.shape.terminalRequests.element.strip()).max(32),
  }),
  accept.strip(),
  contextCall.strip(),
  z.object({ ...status.shape, steps: z.array(TeamStatusStepViewSchema).max(8) }),
  reply.strip(),
  receiptCall.strip(),
  readCall.strip(),
  // Their inputs stay strict, as in the rpcs: a dropped filter or write guard would change the answer.
  searchCall.strip(),
  sqlCall.strip(),
  revoke.strip(),
  ping.strip(),
]);

/** A frame from a peer of any version in the window, or null for a type this side does not know. */
export function readTeamFrame<Schema extends z.ZodDiscriminatedUnion>(
  schema: Schema,
  raw: unknown,
): z.output<Schema> | null {
  const type = typeof raw === "object" && raw !== null && "type" in raw ? raw.type : undefined;
  if (typeof type === "string" && !schema._zod.propValues.type?.has(type)) return null;
  return schema.parse(raw);
}
