import { ProjectRequestCancellationReasonSchema } from "./request-lifecycle.js";
export { ProjectRequestCancellationReasonSchema } from "./request-lifecycle.js";
import { z } from "zod";
import { UserIdSchema, RequestIdSchema } from "./ids.js";

export const TeamReasonSchema = z.enum([
  "team-unavailable",
  "team-not-implemented",
  "guests-unavailable",
  "projects-prevent-replacement",
  "requester-only",
  "manager-only",
  "human-session-required",
  "team-admin-required",
  "project-manage-required",
  "member-suspended",
  "member-removed",
  "membership-lost",
  "connection-revoked",
  "sign-in-required",
  "member-generation-changed",
  "team-object-unavailable",
  "access-revision-changed",
  "last-active-admin",
  "immutable-everyone",
  "invite-unavailable",
  "idempotency-conflict",
  "settings-revision-changed",
  "access-cycle",
  "access-depth",
  "invalid-subject",
  "invalid-level",
  "unsupported-target",
  "invalid-selection",
  "access-capacity",
]);
export const LevelSchema = z.enum(["use", "manage"]);
export const CanSchema = z.object({ allowed: z.boolean(), reason: TeamReasonSchema.optional() });
const name = z.string().trim().min(1).max(160);
export const SnapshotAudienceSchema = z.object({
  people: z.number().int().nonnegative().safe(),
  myLevel: LevelSchema.nullable(),
});
export const TaskStartedBySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("person"), userId: UserIdSchema, name }),
  z.object({ kind: z.literal("trigger"), name }),
  z.object({ kind: z.literal("watch"), name }),
]);
export const AutomationSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("trigger"), name }),
  z.object({ kind: z.literal("watch"), name }),
]);
export const ProjectWorkStopReasonSchema = z.enum([
  "authority-revoked",
  "membership-revoked",
  "no-eligible-manager",
]);
export const TaskStoppedSchema = z.object({
  reason: ProjectWorkStopReasonSchema,
  starterName: name.optional(),
});
export const RequestWaitingOnSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("person"), name }),
  z.object({ kind: z.literal("managers") }),
]);
export const RequestAnswerConflictReasonSchema = z.literal("request-already-settled");
export type SnapshotAudience = z.infer<typeof SnapshotAudienceSchema>;
export type TaskStartedBy = z.infer<typeof TaskStartedBySchema>;
export type TaskStopped = z.infer<typeof TaskStoppedSchema>;

export const RequestCancelledForSchema = z.object({ name });

export const threadRequestFactLimit = 32;
export const ThreadRequestWaitSchema = z.object({
  requestId: RequestIdSchema,
  class: z.enum(["question", "approval"]),
  since: z.iso.datetime({ offset: true }),
  waitingOn: RequestWaitingOnSchema,
});
export const ThreadRequestWaitsSchema = z
  .object({
    items: z.array(ThreadRequestWaitSchema).max(threadRequestFactLimit),
    total: z.number().int().nonnegative().safe(),
  })
  .refine(
    (value) => value.total >= value.items.length,
    "Wait total cannot be smaller than its window",
  );
export const ThreadRequestOutcomeSchema = z.discriminatedUnion("status", [
  z.object({
    requestId: RequestIdSchema,
    class: ThreadRequestWaitSchema.shape.class.optional(),
    status: z.enum(["fulfilled", "declined", "withdrawn"]),
    at: z.iso.datetime({ offset: true }),
    resolvedByName: name,
  }),
  z.object({
    requestId: RequestIdSchema,
    class: ThreadRequestWaitSchema.shape.class.optional(),
    status: z.literal("cancelled"),
    at: z.iso.datetime({ offset: true }),
    reason: ProjectRequestCancellationReasonSchema,
    cancelledFor: RequestCancelledForSchema.optional(),
  }),
]);
export const ThreadRequestOutcomesSchema = z
  .array(ThreadRequestOutcomeSchema)
  .max(threadRequestFactLimit);
export type ThreadRequestWaits = z.infer<typeof ThreadRequestWaitsSchema>;
export type ThreadRequestOutcome = z.infer<typeof ThreadRequestOutcomeSchema>;
