import { z } from "zod";
import {
  IsoDateTimeSchema,
  SequenceSchema,
  TeamActorSchema,
  TeamGroupIdSchema,
  TeamHandleSchema,
  TeamInviteIdSchema,
  TeamLinkIdSchema,
  TeamNoticeIdSchema,
  UserIdSchema,
} from "@opensteer/core";

export const TeamMemberRoleSchema = z.enum(["owner", "admin", "member"]);
export const TeamMemberSchema = z.strictObject({
  userId: UserIdSchema,
  displayName: z.string().min(1).max(120),
  handle: TeamHandleSchema,
  image: z.url().nullable(),
  role: TeamMemberRoleSchema,
  state: z.enum(["active", "removed"]),
  generation: SequenceSchema,
  joinedAt: IsoDateTimeSchema,
});
export type TeamMember = z.infer<typeof TeamMemberSchema>;
export const TeamAccessSubjectSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("person"), userId: UserIdSchema }),
  z.strictObject({ kind: z.literal("group"), groupId: TeamGroupIdSchema }),
]);
export const TeamChannelAccessEntrySchema = z.strictObject({
  subject: TeamAccessSubjectSchema,
  level: z.enum(["read", "post"]),
  manage: z.boolean(),
});
export const TeamTopicAccessEntrySchema = z.strictObject({
  subject: TeamAccessSubjectSchema,
  level: z.enum(["read", "write", "manage"]),
});
export const TeamChannelCanSchema = z.strictObject({
  read: z.boolean(),
  post: z.boolean(),
  manage: z.boolean(),
  join: z.boolean(),
  leave: z.boolean(),
  wakeOwnAgent: z.boolean(),
});
export const TeamTopicCanSchema = z.strictObject({
  read: z.boolean(),
  write: z.boolean(),
  manage: z.boolean(),
});
export const TeamCanSchema = z.strictObject({
  createChannel: z.boolean(),
  manageMembers: z.boolean(),
  manageGroups: z.boolean(),
  manageInvites: z.boolean(),
  transferOwner: z.boolean(),
  viewAudit: z.boolean(),
  connectAgent: z.boolean(),
});
export const TeamChannelAccessSchema = z.strictObject({
  revision: SequenceSchema,
  entries: z.array(TeamChannelAccessEntrySchema).max(1000),
  can: TeamChannelCanSchema,
});
export const TeamTopicAccessSchema = z.strictObject({
  revision: SequenceSchema,
  entries: z.array(TeamTopicAccessEntrySchema).max(1000),
  can: TeamTopicCanSchema,
});
export const TeamGroupSchema = z.strictObject({
  id: TeamGroupIdSchema,
  name: z.string().trim().min(1).max(160),
  people: z.array(UserIdSchema).max(1000),
  children: z.array(TeamGroupIdSchema).max(1000),
  updatedAt: IsoDateTimeSchema,
});
export const TeamInviteSchema = z.strictObject({
  id: TeamInviteIdSchema,
  selector: z.string().min(24).max(96),
  maxUses: z.number().int().positive().max(1000),
  usedCount: z.number().int().nonnegative(),
  expiresAt: IsoDateTimeSchema,
  revokedAt: IsoDateTimeSchema.nullable(),
  createdBy: UserIdSchema,
  createdAt: IsoDateTimeSchema,
});
export const TeamAuditSchema = z.strictObject({
  id: SequenceSchema,
  occurredAt: IsoDateTimeSchema,
  actor: TeamActorSchema.nullable(),
  linkId: TeamLinkIdSchema.nullable(),
  action: z.string().min(1).max(120),
  resourceKind: z.enum([
    "team",
    "member",
    "group",
    "channel",
    "topic",
    "message",
    "file",
    "link",
    "request",
  ]),
  resourceId: z.string().max(255).nullable(),
  outcome: z.enum(["allowed", "denied"]),
});
export const TeamNoticeSchema = z.strictObject({
  id: TeamNoticeIdSchema,
  kind: z.literal("admin-self-added"),
  resourceKind: z.enum(["channel", "topic"]),
  resourceId: z.string().min(1).max(255),
  auditId: SequenceSchema,
  createdAt: IsoDateTimeSchema,
  readAt: IsoDateTimeSchema.nullable(),
});
