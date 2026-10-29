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
  WorkspaceIdSchema,
  utf8ByteLength,
} from "@opensteer/core";
import { z } from "zod";

export const TriggerStatusSchema = z.enum(["active", "paused", "archived"]);

/**
 * The runtime contract for Trigger programs. Agents read it in the
 * opensteer-triggers skill, which must contain it verbatim; the automation
 * editor shows it to people. Tool metadata does not repeat it.
 */
export const triggerProgramContract = [
  "Trigger programs execute as Node.js ESM modules (Node 24 or newer) on the anchor Thread's Runner,",
  "with the anchor Workspace mounted as the working directory, so relative paths and relative imports",
  "resolve from the Workspace root. The source must export one default function (async or not):",
  "The program object must declare toolContractVersion: use 3 for new programs. Version 3 uses report/queue/steer delivery and environment_list for environment, engine and model discovery; workspace_list returns only Workspaces and its window. Saved version 2 programs preserve report/queue/steer delivery and the previous workspace_list discovery schema/results; saved version 1 programs also preserve queue/trigger delivery semantics. Editing timing or status preserves the saved program version.",
  "`export default async function ({ event, capabilities, opensteer }) { ... }`.",
  "`event` is frozen ({ id, payload, receivedAt, source, trigger });",
  '`event.source.kind` is "schedule" (with scheduledFor), "webhook" (with method, headers, and optional deliveryId),',
  '"manual" (a manual run carries only the payload), or "watch" (the single startup event for a continuous watch).',
  "A watch program runs continuously on the anchor Thread's machine and must not resolve; Opensteer restarts unexpected exits with exponential backoff and pauses the Trigger after three consecutive unexpected exits.",
  "`capabilities.mcp` and `capabilities.integrationMcp` are short-lived Opensteer MCP endpoints ({ url, token });",
  "`capabilities.browserCdp` is a short-lived CDP WebSocket endpoint ({ url, token }) or null when the Workspace has no browser grant.",
  "For a watch, every non-null capability also has expiresAt.",
  "Watch capabilities rotate while the process runs: call `opensteer.capabilities()` for the current values, and reconnect an expired CDP session with its current browserCdp value.",
  "`opensteer.callTool(name, input)` calls Opensteer product tools (Workspaces, Threads, Triggers);",
  "`opensteer.integrations.callTool(name, input)` calls integration tools already granted to the Workspace.",
  "Supply a stable observationId with each watch call to thread_message or thread_delegate; when omitted, the request ID is used. Opensteer deduplicates the ID and admits up to 120 independent observations per activation per hour.",
  "Node built-ins (node:fs, node:child_process, ...), fetch, and packages installed in the Workspace's own node_modules are available;",
  "Deno, Bun, and DOM globals such as window and document do not exist, and nothing installs packages automatically.",
  "TypeScript runs through Node's built-in type transform: type annotations, enums, and namespaces work; tsconfig paths, decorators, and JSX do not.",
  "For schedule, webhook, and manual runs, the awaited return value serialized as JSON (at most 512 KiB) becomes the occurrence result, and a thrown error fails the occurrence with its message and stack.",
  "Their console output is captured as stdout and stderr (512 KiB each); watch stdout and stderr retain only their latest 16 KiB tails.",
  "A program acts as its anchor Thread: its Opensteer tool calls reach only what that Thread can reach, and only a full-access agent can write one.",
].join(" ");

export const TriggerProgramSchema = z.strictObject({
  language: z.enum(["javascript", "typescript"]),
  source: z
    .string()
    .min(1)
    .max(512 * 1_024),
  toolContractVersion: z.literal([1, 2, 3]),
});
const TriggerProgramViewSchema = z.object(TriggerProgramSchema.shape);
export type TriggerProgram = z.infer<typeof TriggerProgramSchema>;

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

export const TriggerSchema = z.strictObject({
  anchorThreadId: ThreadIdSchema,
  consecutiveFailures: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  createdAt: IsoDateTimeSchema,
  createdBy: UserIdSchema,
  createdByThreadId: ThreadIdSchema.nullable().default(null),
  currentRevisionId: TriggerRevisionIdSchema,
  id: TriggerIdSchema,
  kind: z.enum(["schedule", "webhook", "watch"]),
  name: z.string().trim().min(1).max(160),
  nextFireAt: IsoDateTimeSchema.nullable(),
  pauseReason: z.string().min(1).nullable(),
  status: TriggerStatusSchema,
  updatedAt: IsoDateTimeSchema,
  webhookRouteKey: z.string().min(32).max(255).nullable(),
  workspaceId: WorkspaceIdSchema,
});
export const TriggerViewSchema = z.object(TriggerSchema.shape);
export type Trigger = z.infer<typeof TriggerSchema>;

export const TriggerRevisionSchema = z.strictObject({
  createdAt: IsoDateTimeSchema,
  createdBy: UserIdSchema,
  createdByThreadId: ThreadIdSchema.nullable().default(null),
  id: TriggerRevisionIdSchema,
  ordinal: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  program: TriggerProgramSchema,
  source: TriggerSourceSchema,
  triggerId: TriggerIdSchema,
});
export const TriggerRevisionViewSchema = z.object({
  ...TriggerRevisionSchema.shape,
  program: TriggerProgramViewSchema,
  source: TriggerSourceViewSchema,
});
export type TriggerRevision = z.infer<typeof TriggerRevisionSchema>;

export const TriggerProgramEventSchema = z.strictObject({
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
      deliveryId: z.string().min(1).max(512).optional(),
      headers: z.record(z.string(), z.string()),
      kind: TriggerOccurrenceSourceKindSchema.extract(["webhook"]),
      method: z.string().min(1).max(16),
    }),
  ]),
  trigger: z.strictObject({
    anchorThreadId: ThreadIdSchema,
    id: TriggerIdSchema,
    revisionId: TriggerRevisionIdSchema,
    workspaceId: WorkspaceIdSchema,
  }),
});
const TriggerProgramEventViewSchema = z.object({
  ...TriggerProgramEventSchema.shape,
  source: z.discriminatedUnion("kind", [
    z.object(TriggerProgramEventSchema.shape.source.options[0].shape),
    z.object(TriggerProgramEventSchema.shape.source.options[1].shape),
    z.object(TriggerProgramEventSchema.shape.source.options[2].shape),
    z.object(TriggerProgramEventSchema.shape.source.options[3].shape),
  ]),
  trigger: z.object(TriggerProgramEventSchema.shape.trigger.shape),
});
export type TriggerProgramEvent = z.infer<typeof TriggerProgramEventSchema>;

export const TriggerWatchDesiredSchema = z.enum(["active", "stopped"]);
export const TriggerWatchObservedSchema = z.enum([
  "starting",
  "running",
  "backoff",
  "expired",
  "stopped",
]);

export const TriggerWatchActivationSchema = z.strictObject({
  anchorThreadId: ThreadIdSchema,
  consecutiveFailures: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
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
  workspaceId: WorkspaceIdSchema,
});
export const TriggerWatchActivationViewSchema = z.object(TriggerWatchActivationSchema.shape);
export type TriggerWatchActivation = z.infer<typeof TriggerWatchActivationSchema>;

const TriggerOccurrenceStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "canceled",
]);

export const TriggerOccurrenceSchema = z.strictObject({
  commandId: CommandIdSchema,
  completedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  environmentId: EnvironmentIdSchema,
  error: z.unknown().nullable(),
  event: TriggerProgramEventSchema,
  exitCode: z.number().int().nullable(),
  id: TriggerOccurrenceIdSchema,
  result: z.unknown().nullable(),
  revisionId: TriggerRevisionIdSchema,
  startedAt: IsoDateTimeSchema.nullable(),
  status: TriggerOccurrenceStatusSchema,
  stderr: z.string(),
  stdout: z.string(),
  triggerId: TriggerIdSchema,
});
export const TriggerOccurrenceViewSchema = z.object({
  ...TriggerOccurrenceSchema.shape,
  event: TriggerProgramEventViewSchema,
});
export type TriggerOccurrence = z.infer<typeof TriggerOccurrenceSchema>;

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
      createdAt: IsoDateTimeSchema,
      error: z.string().nullable(),
      id: TriggerOccurrenceIdSchema,
      source: TriggerOccurrenceSourceKindSchema,
      status: TriggerOccurrenceStatusSchema,
    })
    .nullable(),
  source: TriggerSourceSchema,
  watch: z
    .strictObject({
      lastError: z.string().nullable(),
      observed: TriggerWatchObservedSchema,
    })
    .nullable(),
});
export const TriggerSummaryViewSchema = z.object({
  ...TriggerSummarySchema.shape,
  latestOccurrence: z.object(TriggerSummarySchema.shape.latestOccurrence.unwrap().shape).nullable(),
  source: TriggerSourceViewSchema,
  watch: z.object(TriggerSummarySchema.shape.watch.unwrap().shape).nullable(),
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
  action: z.enum(["list", "get"]),
  limit: z.number().int().min(1).max(100).default(50),
  occurrenceLimit: z.number().int().min(1).max(100).default(25),
  triggerId: TriggerIdSchema.optional(),
  workspaceId: WorkspaceIdSchema.optional(),
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
    'Trigger source. kind "schedule" requires exactly one of at (a one-shot UTC ISO-8601 instant) or cron (a recurring expression), and cron additionally requires timezone as an IANA name; payload is the constant event payload each occurrence receives. kind "webhook" and kind "watch" accept none of at, cron, timezone, or payload.',
  );
export type TriggerSourceInput = z.infer<typeof TriggerSourceInputSchema>;

/**
 * The Thread a Trigger belongs to and wakes. "home" names the person's Chat,
 * which an agent can address without knowing its id; it is resolved to the
 * id when the Trigger is created. A refined string rather than a union, so
 * the tool schema stays union-free for every model runtime.
 */
export const TriggerAnchorInputSchema = z
  .string()
  .refine(
    (value) => value === "home" || ThreadIdSchema.safeParse(value).success,
    'Anchor must be a Thread id or "home"',
  )
  .describe('A Thread id, or "home" for the person’s Chat');

export const TriggerWriteInputSchema = z.strictObject({
  action: z.enum(["create", "update", "set_status", "set_next_fire", "run", "cancel"]),
  anchorThreadId: TriggerAnchorInputSchema.optional(),
  expectedRevisionId: TriggerRevisionIdSchema.optional(),
  name: z.string().trim().min(1).max(160).optional(),
  nextFireAt: IsoDateTimeSchema.optional(),
  occurrenceId: TriggerOccurrenceIdSchema.optional(),
  payload: z.unknown().optional(),
  program: TriggerProgramSchema.optional(),
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
    program: TriggerProgramSchema,
    source: TriggerSourceSchema,
  }),
  z.strictObject({
    limit: z.number().int().min(1).max(100).default(50),
    operation: z.literal("list"),
    workspaceId: WorkspaceIdSchema.optional(),
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
    program: TriggerProgramSchema.optional(),
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
  program: TriggerProgramSchema,
  source: TriggerSourceSchema,
});

export const UpdateTriggerHttpBodySchema = z.strictObject({
  expectedRevisionId: TriggerRevisionIdSchema,
  name: z.string().trim().min(1).max(160).optional(),
  program: TriggerProgramSchema.optional(),
  source: TriggerSourceSchema.optional(),
});

export const TriggerExecutionOutputSchema = z.strictObject({
  completedAt: IsoDateTimeSchema,
  error: z.string().max(20_000).nullable(),
  exitCode: z.number().int().nullable(),
  occurrenceId: TriggerOccurrenceIdSchema,
  result: z.unknown().nullable(),
  status: z.enum(["succeeded", "failed", "canceled"]),
  stderr: z.string().max(512 * 1_024),
  stdout: z.string().max(512 * 1_024),
});
export type TriggerExecutionOutput = z.infer<typeof TriggerExecutionOutputSchema>;
