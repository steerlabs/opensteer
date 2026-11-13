import { z } from "zod";
import {
  DeploymentIdSchema,
  TeamChannelIdSchema,
  TeamMessageIdSchema,
  UserIdSchema,
  MessageIdSchema,
  SequenceSchema,
  TeamAgentRequestIdSchema,
  TeamBlobIdSchema,
  RunIdSchema,
} from "./ids.js";

export const TeamChannelKindSchema = z.enum(["public", "private", "dm", "group_dm"]);
export type TeamChannelKind = z.infer<typeof TeamChannelKindSchema>;
export const TeamAudienceSchema = z.strictObject({
  teamName: z.string().min(1).max(160),
  channelName: z.string().min(1).max(160),
  channelKind: TeamChannelKindSchema,
  memberCount: z.number().int().nonnegative(),
  peopleOnly: z.boolean(),
});
export type TeamAudience = z.infer<typeof TeamAudienceSchema>;
export const TeamTaskOriginSchema = z.strictObject({
  teamId: DeploymentIdSchema,
  channelId: TeamChannelIdSchema,
  threadRootId: TeamMessageIdSchema,
});
export type TeamTaskOrigin = z.infer<typeof TeamTaskOriginSchema>;
export const TeamSourceSchema = TeamTaskOriginSchema.extend({
  threadRootId: TeamMessageIdSchema.nullable(),
  messageId: TeamMessageIdSchema.nullable(),
  audience: TeamAudienceSchema,
}).strict();
export type TeamSource = z.infer<typeof TeamSourceSchema>;
export const TeamActorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("human"), userId: UserIdSchema }),
  z.strictObject({ kind: z.literal("agent"), userId: UserIdSchema }),
]);
export type TeamActor = z.infer<typeof TeamActorSchema>;
export const TeamHandleSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(48)
  .refine((value) => !value.endsWith("-agent"));
export type TeamHandle = z.infer<typeof TeamHandleSchema>;
export function normalizeTeamHandle(displayName: string): TeamHandle {
  const base =
    displayName
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || "member";
  return TeamHandleSchema.parse(base.endsWith("-agent") ? `${base}-member` : base);
}
export function uniqueTeamHandle(displayName: string, occupied: ReadonlySet<string>): TeamHandle {
  const base = normalizeTeamHandle(displayName);
  if (!occupied.has(base)) return base;
  for (let suffix = 2; suffix <= Number.MAX_SAFE_INTEGER; suffix++) {
    const candidate = `${base.slice(0, 48 - String(suffix).length - 1).replace(/-+$/g, "")}-${suffix}`;
    if (!occupied.has(candidate)) return TeamHandleSchema.parse(candidate);
  }
  throw new Error("No team handle available");
}
export function teamAgentHandle(handle: TeamHandle): string {
  return `${handle}-agent`;
}
export const TeamAgentRequestKindSchema = z.enum(["self", "ask", "return"]);
export type TeamAgentRequestKind = z.infer<typeof TeamAgentRequestKindSchema>;
export const TeamAskDecisionSchema = z.enum(["approve", "decline"]);
export type TeamAskDecision = z.infer<typeof TeamAskDecisionSchema>;
export const TeamAskerSchema = z.strictObject({
  teamUserId: UserIdSchema,
  displayName: z.string().trim().min(1).max(160),
  actor: z.enum(["human", "agent"]),
});
export type TeamAsker = z.infer<typeof TeamAskerSchema>;
export const TeamAttachmentRefSchema = z.strictObject({
  id: TeamBlobIdSchema,
  filename: z.string().min(1).max(255),
  mediaType: z.string().min(1).max(255),
  sizeBytes: z
    .number()
    .int()
    .nonnegative()
    .max(100 * 1024 * 1024),
});
export type TeamAttachmentRef = z.infer<typeof TeamAttachmentRefSchema>;
export const TeamRequestTextSchema = z
  .string()
  .max(16384)
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= 16384,
    "Markdown exceeds 16 KiB",
  );
export const TeamAskPresentationSchema = z.strictObject({
  asker: TeamAskerSchema,
  bodyMarkdown: TeamRequestTextSchema,
  attachments: z.array(TeamAttachmentRefSchema).max(10),
  destination: TeamTaskOriginSchema,
  audience: TeamAudienceSchema,
});
export const TeamAskPresentationViewSchema = z.object({
  ...TeamAskPresentationSchema.shape,
  asker: z.object(TeamAskerSchema.shape),
  attachments: z.array(z.object(TeamAttachmentRefSchema.shape)).max(10),
  destination: z.object(TeamTaskOriginSchema.shape),
  audience: z.object(TeamAudienceSchema.shape),
});
export type TeamAskPresentation = z.infer<typeof TeamAskPresentationSchema>;
export const TeamAgentReturnOutcomeSchema = z.enum([
  "answered",
  "declined",
  "expired",
  "cancelled",
  "failed",
]);
export type TeamAgentReturnOutcome = z.infer<typeof TeamAgentReturnOutcomeSchema>;
// This payload is private to the receiving link; never include it in team member views.
export const TeamAgentReturnPayloadSchema = z.strictObject({
  originAskId: TeamAgentRequestIdSchema,
  resumeRunId: RunIdSchema,
  outcome: TeamAgentReturnOutcomeSchema,
  bodyMarkdown: TeamRequestTextSchema.nullable(),
  attachments: z.array(TeamAttachmentRefSchema).max(10),
});
export const TeamAgentReturnPayloadViewSchema = z.object({
  ...TeamAgentReturnPayloadSchema.shape,
  attachments: z.array(z.object(TeamAttachmentRefSchema.shape)).max(10),
});
export type TeamAgentReturnPayload = z.infer<typeof TeamAgentReturnPayloadSchema>;
export const TeamReturnAdmissionSchema = z.enum(["admitted", "undeliverable"]);
export type TeamReturnAdmission = z.infer<typeof TeamReturnAdmissionSchema>;

export const TeamAgentRequestStateSchema = z.enum([
  "awaiting_approval",
  "declined",
  "queued",
  "working",
  "needs_you",
  "done",
  "failed",
  "cancelled",
  "stopped",
]);
export type TeamAgentRequestState = z.infer<typeof TeamAgentRequestStateSchema>;
export const TeamStatusStepKindSchema = z.enum([
  "browsed",
  "read_files",
  "edited_files",
  "ran_commands",
  "used_integration",
  "searched_team",
  "asked_you",
]);
export const TeamStatusStepSchema = z.strictObject({
  kind: TeamStatusStepKindSchema,
  count: z.number().int().nonnegative(),
});

export const TeamRunDeliverySchema = z.strictObject({
  state: z.enum(["sending", "sent", "blocked"]),
  via: z.enum(["final", "tool"]),
  answerMessageId: MessageIdSchema.nullable(),
  teamMessageId: TeamMessageIdSchema.nullable(),
  reason: z.string().trim().min(1).max(500).nullable(),
});
export const TeamRunDeliveryViewSchema = z.object(TeamRunDeliverySchema.shape);
export type TeamRunDelivery = z.infer<typeof TeamRunDeliverySchema>;

export const TeamTurnContextSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("team"),
    source: TeamSourceSchema,
    // Non-null only for an ask approved by this Host's owner.
    asker: TeamAskerSchema.pick({ displayName: true, actor: true }).nullable().default(null),
    instructionsMarkdown: z
      .string()
      .max(16384)
      .refine(
        (value) => new TextEncoder().encode(value).byteLength <= 16384,
        "Instructions exceed 16 KiB",
      ),
    instructionsRevision: SequenceSchema,
  }),
  z.strictObject({ kind: z.literal("private") }),
]);
export type TeamTurnContext = z.infer<typeof TeamTurnContextSchema>;
