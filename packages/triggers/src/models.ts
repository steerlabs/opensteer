import {
  CommandIdSchema,
  EnvironmentIdSchema,
  IsoDateTimeSchema,
  RunnerIdSchema,
  ThreadIdSchema,
  TriggerIdSchema,
  TriggerOccurrenceIdSchema,
  TriggerOccurrenceSourceKindSchema,
  TriggerRevisionIdSchema,
  TriggerWatchActivationIdSchema,
  UserIdSchema,
  utf8ByteLength,
} from "@opensteer/core";
import { z } from "zod";
import { AutomationScriptSchema, AutomationScriptViewSchema } from "./script.js";

export const TriggerStatusSchema = z.enum(["active", "paused", "archived"]);

export const TRIGGER_SCRIPT_UPDATE_REASON = "Needs an update: ask your agent";

export const TriggerScheduleSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    at: IsoDateTimeSchema,
    kind: z.literal("at"),
    payload: z.unknown().optional(),
  }),
  z.strictObject({
    expression: z.string().trim().min(1).max(255),
    kind: z.literal("cron"),
    payload: z.unknown().optional(),
    timezone: z.string().trim().min(1).max(255),
  }),
]);
const TriggerScheduleViewSchema = z.discriminatedUnion("kind", [
  z.object(TriggerScheduleSchema.options[0].shape),
  z.object(TriggerScheduleSchema.options[1].shape),
]);
export type TriggerSchedule = z.infer<typeof TriggerScheduleSchema>;

export const TriggerSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("schedule"), schedule: TriggerScheduleSchema }),
  z.strictObject({ kind: z.literal("webhook") }),
  z.strictObject({ kind: z.literal("watch") }),
]);
const TriggerSourceViewSchema = z.discriminatedUnion("kind", [
  z.object({
    ...TriggerSourceSchema.options[0].shape,
    schedule: TriggerScheduleViewSchema,
  }),
  z.object(TriggerSourceSchema.options[1].shape),
  z.object(TriggerSourceSchema.options[2].shape),
]);
export type TriggerSource = z.infer<typeof TriggerSourceSchema>;

export const TriggerSystemRoleSchema = z.enum(["memory-light", "memory-nightly"]);
export type TriggerSystemRole = z.infer<typeof TriggerSystemRoleSchema>;

export const MANAGED_MEMORY_REFUSAL =
  "Opensteer manages this memory pass. Pause it instead; to stop remembering, ask your agent.";
export const MANAGED_MEMORY_WAKE_SKIPPED = "Opensteer skipped this memory pass wake.";

export const TriggerSchema = z.strictObject({
  systemRole: TriggerSystemRoleSchema.nullable().optional(),
  anchorThreadId: ThreadIdSchema,
  createdAt: IsoDateTimeSchema,
  createdBy: UserIdSchema,
  createdByThreadId: ThreadIdSchema.nullable().default(null),
  currentRevisionId: TriggerRevisionIdSchema,
  id: TriggerIdSchema,
  kind: z.enum(["schedule", "webhook", "watch"]),
  name: z.string().trim().min(1).max(160),
  nextFireAt: IsoDateTimeSchema.nullable(),
  pauseReason: z.string().min(1).nullable(),
  /** A managed memory pass that is active but has no usable model; it is not paused. */
  waitingReason: z.string().min(1).nullable().optional(),
  status: TriggerStatusSchema,
  updatedAt: IsoDateTimeSchema,
  webhookRouteKey: z.string().min(32).max(255).nullable(),
});
export const TriggerViewSchema = z.object(TriggerSchema.shape);
export type Trigger = z.infer<typeof TriggerSchema>;

export const TriggerRevisionSchema = z.strictObject({
  createdAt: IsoDateTimeSchema,
  createdBy: UserIdSchema,
  createdByThreadId: ThreadIdSchema.nullable().default(null),
  id: TriggerRevisionIdSchema,
  /** Legacy v5 source kept readable on paused pre-script revisions so an agent can rewrite them (T14). */
  legacySource: z
    .string()
    .min(1)
    .max(512 * 1_024)
    .optional(),
  ordinal: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  script: AutomationScriptSchema.nullable(),
  source: TriggerSourceSchema,
  triggerId: TriggerIdSchema,
});
export const TriggerRevisionViewSchema = z.object({
  ...TriggerRevisionSchema.shape,
  script: AutomationScriptViewSchema.nullable(),
  source: TriggerSourceViewSchema,
});
export type TriggerRevision = z.infer<typeof TriggerRevisionSchema>;

export const TriggerScriptEventSchema = z.strictObject({
  id: TriggerOccurrenceIdSchema,
  payload: z.unknown(),
  receivedAt: IsoDateTimeSchema,
  source: z.discriminatedUnion("kind", [
    z.strictObject({ kind: TriggerOccurrenceSourceKindSchema.extract(["manual"]) }),
    z.strictObject({ kind: TriggerOccurrenceSourceKindSchema.extract(["watch"]) }),
    z.strictObject({
      kind: TriggerOccurrenceSourceKindSchema.extract(["schedule"]),
      scheduledFor: IsoDateTimeSchema,
    }),
    z.strictObject({
      bodyBytes: z.number().int().nonnegative().optional(),
      deliveryId: z.string().min(1).max(512).optional(),
      headers: z.record(z.string(), z.string()),
      kind: TriggerOccurrenceSourceKindSchema.extract(["webhook"]),
      method: z.string().min(1).max(16),
      path: z.string().max(2_048).optional(),
      query: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
    }),
  ]),
  trigger: z.strictObject({
    anchorThreadId: ThreadIdSchema,
    id: TriggerIdSchema,
    revisionId: TriggerRevisionIdSchema,
  }),
});
const TriggerScriptEventViewSchema = z.object({
  ...TriggerScriptEventSchema.shape,
  source: z.discriminatedUnion("kind", [
    z.object(TriggerScriptEventSchema.shape.source.options[0].shape),
    z.object(TriggerScriptEventSchema.shape.source.options[1].shape),
    z.object(TriggerScriptEventSchema.shape.source.options[2].shape),
    z.object(TriggerScriptEventSchema.shape.source.options[3].shape),
  ]),
  trigger: z.object(TriggerScriptEventSchema.shape.trigger.shape),
});
export type TriggerScriptEvent = z.infer<typeof TriggerScriptEventSchema>;

export const TriggerWatchDesiredSchema = z.enum(["active", "stopped"]);
export const TriggerWatchObservedSchema = z.enum([
  "starting",
  "running",
  "backoff",
  "halted",
  "expired",
  "stopped",
]);

export const TriggerWatchActivationSchema = z.strictObject({
  anchorThreadId: ThreadIdSchema,
  consecutiveFailures: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  contactLostAt: IsoDateTimeSchema.nullable().optional(),
  createdAt: IsoDateTimeSchema,
  createdBy: UserIdSchema,
  desired: TriggerWatchDesiredSchema,
  environmentId: EnvironmentIdSchema,
  executionGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  healthySince: IsoDateTimeSchema.nullable(),
  id: TriggerWatchActivationIdSchema,
  lastError: z.string().max(20_000).nullable(),
  lastExitCode: z.number().int().nullable(),
  leaseExpiresAt: IsoDateTimeSchema.nullable(),
  observed: TriggerWatchObservedSchema,
  restartCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  revisionId: TriggerRevisionIdSchema,
  runnerBootId: z.string().min(1).max(255).nullable(),
  runnerConnectionGeneration: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable()
    .default(null),
  runnerId: RunnerIdSchema.nullable(),
  stderrTail: z
    .string()
    .max(16 * 1_024)
    .refine((value) => utf8ByteLength(value) <= 16 * 1_024, "Watch stderr tail exceeds 16 KiB"),
  stdoutTail: z
    .string()
    .max(16 * 1_024)
    .refine((value) => utf8ByteLength(value) <= 16 * 1_024, "Watch stdout tail exceeds 16 KiB"),
  triggerId: TriggerIdSchema,
  updatedAt: IsoDateTimeSchema,
});
export const TriggerWatchActivationViewSchema = z.object(TriggerWatchActivationSchema.shape);
export type TriggerWatchActivation = z.infer<typeof TriggerWatchActivationSchema>;

const TriggerOccurrenceStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "canceled",
  "unknown",
]);

export const TriggerOccurrenceSchema = z.strictObject({
  commandId: CommandIdSchema,
  completedAt: IsoDateTimeSchema.nullable(),
  contactLostAt: IsoDateTimeSchema.nullable().optional(),
  createdAt: IsoDateTimeSchema,
  environmentId: EnvironmentIdSchema,
  error: z.unknown().nullable(),
  event: TriggerScriptEventSchema,
  exitCode: z.number().int().nullable(),
  id: TriggerOccurrenceIdSchema,
  result: z.unknown().nullable(),
  revisionId: TriggerRevisionIdSchema,
  sent: z.boolean().optional(),
  startedAt: IsoDateTimeSchema.nullable(),
  status: TriggerOccurrenceStatusSchema,
  stderr: z.string(),
  stdout: z.string(),
  triggerId: TriggerIdSchema,
});
export const TriggerOccurrenceViewSchema = z.object({
  ...TriggerOccurrenceSchema.shape,
  event: TriggerScriptEventViewSchema,
});
export type TriggerOccurrence = z.infer<typeof TriggerOccurrenceSchema>;

export const TriggerWebhookAddressSchema = z.strictObject({
  scope: z.enum(["public", "local"]),
  /** Present when the caller may run the automation; null when redacted. */
  url: z.url().nullable(),
});
export const TriggerWebhookAddressViewSchema = z.object(TriggerWebhookAddressSchema.shape);
export type TriggerWebhookAddress = z.infer<typeof TriggerWebhookAddressSchema>;

/**
 * A Trigger as a list shows it: when it runs, how its latest run went and,
 * for a watch, whether it is running — enough to tell what each one does and
 * whether it needs its owner without opening it. Schedule payloads are left
 * out; they belong to the Trigger's detail.
 */
export const TriggerSummarySchema = z.strictObject({
  ...TriggerSchema.shape,
  /** The conversation it runs in, and where it talks to its owner. */
  anchorThreadTitle: z.string(),
  latestOccurrence: z
    .strictObject({
      completedAt: IsoDateTimeSchema.nullable(),
      contactLostAt: IsoDateTimeSchema.nullable().optional(),
      createdAt: IsoDateTimeSchema,
      error: z.string().nullable(),
      exitCode: z.number().int().nullable().optional(),
      id: TriggerOccurrenceIdSchema,
      sent: z.boolean().optional(),
      source: TriggerOccurrenceSourceKindSchema,
      status: TriggerOccurrenceStatusSchema,
    })
    .nullable(),
  source: TriggerSourceSchema,
  watch: z
    .strictObject({
      contactLostAt: IsoDateTimeSchema.nullable().optional(),
      lastError: z.string().nullable(),
      observed: TriggerWatchObservedSchema,
    })
    .nullable(),
  webhook: TriggerWebhookAddressSchema.nullable().optional(),
});
export const TriggerSummaryViewSchema = z.object({
  ...TriggerSummarySchema.shape,
  latestOccurrence: z.object(TriggerSummarySchema.shape.latestOccurrence.unwrap().shape).nullable(),
  source: TriggerSourceViewSchema,
  watch: z.object(TriggerSummarySchema.shape.watch.unwrap().shape).nullable(),
  webhook: TriggerWebhookAddressViewSchema.nullable().optional(),
});
export type TriggerSummary = z.infer<typeof TriggerSummarySchema>;

/** What an Occurrence's stored error says, whichever path recorded it. */
export function triggerOccurrenceErrorMessage(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  if (typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return JSON.stringify(error);
}

export const TriggerReadInputSchema = z.strictObject({
  systemRole: TriggerSystemRoleSchema.optional(),
  action: z.enum(["list", "get"]),
  limit: z.number().int().min(1).max(100).default(50),
  occurrenceLimit: z.number().int().min(1).max(100).default(25),
  triggerId: TriggerIdSchema.optional(),
});

export const TriggerSourceInputSchema = z
  .strictObject({
    at: IsoDateTimeSchema.optional(),
    cron: z.string().trim().min(1).max(255).optional(),
    kind: z.enum(["schedule", "webhook", "watch"]),
    payload: z.unknown().optional(),
    timezone: z.string().trim().min(1).max(255).optional(),
  })
  .describe(
    'Automation source. kind "schedule" requires exactly one of at (a one-shot UTC ISO-8601 instant) or cron (a recurring expression), and cron additionally requires timezone as an IANA name; payload is the constant event payload each occurrence receives. kind "webhook" and kind "watch" accept none of at, cron, timezone, or payload.',
  );
export type TriggerSourceInput = z.infer<typeof TriggerSourceInputSchema>;

/** The real task that supplies the program's folder and access ceiling. */
export const TriggerAnchorInputSchema = ThreadIdSchema;

/** Runs the automation in a new task linked under the anchor instead of in the anchor itself. */
export const TriggerOwnTaskInputSchema = z.literal(true);

export const TriggerWriteInputSchema = z.strictObject({
  action: z.enum(["create", "update", "set_status", "set_next_fire", "run", "cancel"]),
  anchorThreadId: TriggerAnchorInputSchema.optional(),
  expectedRevisionId: TriggerRevisionIdSchema.optional(),
  name: z.string().trim().min(1).max(160).optional(),
  nextFireAt: IsoDateTimeSchema.optional(),
  occurrenceId: TriggerOccurrenceIdSchema.optional(),
  ownTask: TriggerOwnTaskInputSchema.optional(),
  payload: z.unknown().optional(),
  script: AutomationScriptSchema.optional(),
  source: TriggerSourceInputSchema.optional(),
  status: TriggerStatusSchema.optional(),
  triggerId: TriggerIdSchema.optional(),
});
export type TriggerWriteInput = z.infer<typeof TriggerWriteInputSchema>;

export const TriggerControlInputSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    anchorThreadId: TriggerAnchorInputSchema,
    idempotencyKey: z.string().trim().min(1).max(255),
    name: z.string().trim().min(1).max(160),
    operation: z.literal("create"),
    ownTask: TriggerOwnTaskInputSchema.optional(),
    script: AutomationScriptSchema,
    source: TriggerSourceSchema,
  }),
  z.strictObject({
    limit: z.number().int().min(1).max(100).default(50),
    operation: z.literal("list"),
    systemRole: TriggerSystemRoleSchema.optional(),
  }),
  z.strictObject({
    occurrenceLimit: z.number().int().min(1).max(100).default(25),
    operation: z.literal("get"),
    triggerId: TriggerIdSchema,
  }),
  z.strictObject({
    expectedRevisionId: TriggerRevisionIdSchema,
    name: z.string().trim().min(1).max(160).optional(),
    operation: z.literal("update"),
    script: AutomationScriptSchema.optional(),
    source: TriggerSourceSchema.optional(),
    triggerId: TriggerIdSchema,
  }),
  z.strictObject({
    operation: z.literal("set_status"),
    status: TriggerStatusSchema,
    triggerId: TriggerIdSchema,
  }),
  z.strictObject({
    nextFireAt: IsoDateTimeSchema,
    operation: z.literal("set_next_fire"),
    triggerId: TriggerIdSchema,
  }),
  z.strictObject({
    operation: z.literal("run"),
    payload: z.unknown().optional(),
    triggerId: TriggerIdSchema,
  }),
  z.strictObject({
    occurrenceId: TriggerOccurrenceIdSchema.optional(),
    operation: z.literal("cancel"),
    triggerId: TriggerIdSchema,
  }),
]);
export type TriggerControlInput = z.infer<typeof TriggerControlInputSchema>;

export const CreateTriggerHttpBodySchema = z.strictObject({
  anchorThreadId: ThreadIdSchema,
  name: z.string().trim().min(1).max(160),
  script: AutomationScriptSchema,
  source: TriggerSourceSchema,
});

export const UpdateTriggerHttpBodySchema = z.strictObject({
  expectedRevisionId: TriggerRevisionIdSchema,
  name: z.string().trim().min(1).max(160).optional(),
  script: AutomationScriptSchema.optional(),
  source: TriggerSourceSchema.optional(),
});

export const TriggerExecutionOutputSchema = z.strictObject({
  completedAt: IsoDateTimeSchema,
  error: z.string().max(20_000).nullable(),
  exitCode: z.number().int().nullable(),
  occurrenceId: TriggerOccurrenceIdSchema,
  result: z.unknown().nullable(),
  status: z.enum(["succeeded", "failed", "canceled", "unknown"]),
  stderr: z.string().max(512 * 1_024),
  stdout: z.string().max(512 * 1_024),
});
export type TriggerExecutionOutput = z.infer<typeof TriggerExecutionOutputSchema>;
