import { z } from "zod";
import {
  DeploymentIdSchema,
  TeamChannelIdSchema,
  TeamMessageIdSchema,
  UserIdSchema,
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
export const TeamAgentRequestStateSchema = z.enum([
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
