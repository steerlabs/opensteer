import {
  AssignmentRunContextSchema,
  CommandIdSchema,
  EnvironmentIdSchema,
  HarnessIdSchema,
  HarnessInstanceIdSchema,
  HarnessInstanceStateKindSchema,
  HarnessRuntimeRevisionSchema,
  IsoDateTimeSchema,
  messageAuthorCanWriteKind,
  MessageAuthorSchema,
  MessageContentSchema,
  MessageIdSchema,
  MessageKindSchema,
  MessageQuoteSchema,
  MessageSchema,
  ModelSelectionSchema,
  ProviderSessionIdSchema,
  RunIdSchema,
  RunThreadStateSchema,
  SequenceSchema,
  ThreadAccessModeSchema,
  ThreadIdSchema,
  threadReportBatchMaxEntries,
  threadReportBatchMaxSerializedBytes,
  ThreadRoleSchema,
  TriggerIdSchema,
  TriggerOccurrenceIdSchema,
  TriggerRevisionIdSchema,
  TriggerWatchActivationIdSchema,
  UserIdSchema,
  utf8ByteLength,
  WorkspaceIdSchema,
  WorkspaceKindSchema,
} from "@opensteer/core";
import { TriggerProgramEventSchema, TriggerProgramSchema } from "@opensteer/triggers";
import { WorkspaceExecutionAccessPlanSchema } from "@opensteer/workspace";
import { z } from "zod";
import { RunEgressPlanSchema } from "./access.js";
import {
  RunAgentToolsPlanSchema,
  RunBrowserCdpPlanSchema,
  RunPluginsPlanSchema,
} from "./run-plans.js";
import { RunAttachmentPlanSchema } from "./attachments.js";
import { CorrelationIdSchema } from "./common.js";
import { MachineAccessRunContextSchema } from "./shell.js";
import { VoiceSessionIdSchema } from "./voice.js";

/** Who an account of an engine talks to; see `HarnessSourceDescriptorSchema`. */
export const HarnessSourceIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/)
  .max(100);

export const runHistoryMaxMessages = 200;
export const runHistoryMaxSerializedBytes = 384 * 1_024;
export const runHarnessConfigMaxSerializedBytes = 128 * 1_024;

export const RunHarnessConfigSchema = z.unknown().refine((config) => {
  try {
    const serialized = JSON.stringify(config);
    return (
      serialized !== undefined &&
      new TextEncoder().encode(serialized).byteLength <= runHarnessConfigMaxSerializedBytes
    );
  } catch {
    return false;
  }
}, `Harness configuration must not exceed ${runHarnessConfigMaxSerializedBytes} serialized bytes`);

export const RunHistoryWindowSchema = z.strictObject({
  byteCount: z.number().int().nonnegative().max(runHistoryMaxSerializedBytes),
  hasEarlier: z.boolean(),
  itemCount: z.number().int().nonnegative().max(runHistoryMaxMessages),
});
export type RunHistoryWindow = z.infer<typeof RunHistoryWindowSchema>;

/** Historical context authorized by an explicit native-session continuation. */
export const RunInitialContextSchema = z
  .strictObject({
    messages: z.array(MessageSchema).max(runHistoryMaxMessages),
    throughSequence: SequenceSchema.nullable(),
    omittedCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .superRefine((context, refinement) => {
    if (utf8ByteLength(JSON.stringify(context.messages)) > runHistoryMaxSerializedBytes) {
      refinement.addIssue({
        code: "custom",
        message: "Initial context exceeds the history byte limit",
      });
    }
  });
export type RunInitialContext = z.infer<typeof RunInitialContextSchema>;

export const executionLeaseMsSchema = z.number().int().min(10_000).max(3_600_000);

export const RunExecutionContextSchema = z.strictObject({
  accessMode: ThreadAccessModeSchema,
  assignment: AssignmentRunContextSchema.nullable(),
  /** Scoped to files already admitted to this provider session and this frozen Run. */
  attachments: RunAttachmentPlanSchema.optional(),
  agentTools: RunAgentToolsPlanSchema,
  browserCdp: RunBrowserCdpPlanSchema,
  specialistId: z
    .string()
    .regex(/^[a-zA-Z0-9-]+$/u)
    .optional(),
  plugins: RunPluginsPlanSchema,
  bindingGeneration: z.number().int().positive(),
  membershipGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  egress: RunEgressPlanSchema,
  environmentId: EnvironmentIdSchema,
  /**
   * How long the Run survives without a renewal from the Host. The Runner
   * stops the Run itself once this passes unrenewed, so it never acts on
   * authority the Host may already have withdrawn.
   */
  executionLeaseMs: executionLeaseMsSchema,
  /**
   * When to ask for fresh capability tokens, from a Host that answers
   * `runner.grants.refresh`. Absent, the Run keeps the tokens it was given.
   */
  credentialRefreshAfterMs: z.number().int().min(1_000).max(86_400_000).optional(),
  /**
   * The ordinal this execution's first event takes. A restarted Run's next
   * attempt continues the Run's events where the Host's committed ones end;
   * absent, an execution starts at zero.
   */
  firstOrdinal: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  harness: z.strictObject({
    config: RunHarnessConfigSchema,
    driverKind: HarnessIdSchema,
    name: z.string().min(1).max(120),
    runtimeRevision: HarnessRuntimeRevisionSchema,
    sourceId: HarnessSourceIdSchema,
    stateKind: HarnessInstanceStateKindSchema,
  }),
  harnessInstanceId: HarnessInstanceIdSchema,
  history: z.array(MessageSchema).max(runHistoryMaxMessages),
  historyWindow: RunHistoryWindowSchema,
  initialContext: RunInitialContextSchema.nullable(),
  modelSelection: ModelSelectionSchema,
  providerSessionId: ProviderSessionIdSchema,
  providerSessionStateLayout: z.enum(["thread", "session"]),
  providerSessionReference: z.string().min(1).max(2_048).nullable(),
  machineAccess: MachineAccessRunContextSchema,
  requestedBy: UserIdSchema,
  /**
   * The zone the requester's client last reported, null when none has. Checked
   * for shape, not against this runtime's `Intl`: a Runner whose time zone
   * data predates a name the Host accepted would otherwise refuse the whole
   * command and drop its connection, rather than run without the local time.
   */
  requesterTimeZone: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_+:/-]+$/u)
    .nullable()
    // A Host that predates the field sends none, and its Runs still run.
    .default(null),
  runId: RunIdSchema,
  threadId: ThreadIdSchema,
  threadRole: ThreadRoleSchema,
  /**
   * Present only for a voice call's one Run, sent only to a Runner advertising
   * `voice-run-v1`. The execution holds the call until it ends and is never
   * resumed or restarted; its offer arrives through the `start` voice command.
   */
  voiceCall: z
    .strictObject({
      sessionId: VoiceSessionIdSchema,
      /** When the Host admitted the call; it ends at most `voiceMaxCallMs` later. */
      admittedAt: IsoDateTimeSchema,
    })
    .optional(),
  threadState: RunThreadStateSchema,
  workspaceId: WorkspaceIdSchema,
  workspaceKind: WorkspaceKindSchema,
  workspaceAccess: WorkspaceExecutionAccessPlanSchema,
  workspaceInstructionsPath: z.string().min(1).max(4_096).nullable(),
});

/**
 * One immutable Thread input claimed by the Host for delivery to a harness.
 * Delivery policy is intentionally absent: queueing and Run creation are Host
 * concerns, while a harness only sees the inputs assigned to this execution.
 */
export const HarnessInputSchema = z
  .strictObject({
    author: MessageAuthorSchema,
    content: MessageContentSchema,
    createdAt: IsoDateTimeSchema,
    kind: MessageKindSchema.exclude(["assistant"]),
    messageId: MessageIdSchema,
    quote: MessageQuoteSchema.optional(),
  })
  .superRefine((input, context) => {
    if (!messageAuthorCanWriteKind(input.author, input.kind)) {
      context.addIssue({
        code: "custom",
        message: `Message kind ${input.kind} cannot be authored by ${input.author.kind}`,
        path: ["author"],
      });
    }
  });
export type HarnessInput = z.infer<typeof HarnessInputSchema>;

export const HarnessRunReportsSchema = z
  .strictObject({
    messages: z.array(HarnessInputSchema).max(threadReportBatchMaxEntries),
    omittedCount: z.number().int().nonnegative(),
    throughSequence: SequenceSchema.nullable(),
  })
  .refine(
    ({ messages }) =>
      utf8ByteLength(JSON.stringify(messages)) <= threadReportBatchMaxSerializedBytes,
    `Run report context must not exceed ${threadReportBatchMaxSerializedBytes} serialized bytes`,
  );
export type HarnessRunReports = z.infer<typeof HarnessRunReportsSchema>;

export const RunnerCommandBaseSchema = z.strictObject({
  commandId: CommandIdSchema,
  correlationId: CorrelationIdSchema,
  environmentId: EnvironmentIdSchema,
});

/**
 * The most messages one execution starts with. A Run's first attempt starts
 * with its one queued message; an attempt a restart began, with every message
 * steered into it before it started.
 */
export const runExecuteInputsMax = 32;

export const ExecuteRunSchema = RunnerCommandBaseSchema.extend({
  type: z.literal("run.execute"),
  context: RunExecutionContextSchema,
  inputs: z
    .array(HarnessInputSchema)
    .min(1)
    .max(runExecuteInputsMax)
    .refine(
      (inputs) => new Set(inputs.map((input) => input.messageId)).size === inputs.length,
      "Each input is a different message",
    ),
  reports: HarnessRunReportsSchema,
});

export const TriggerCapabilityPlanSchema = z.strictObject({
  token: z.string().min(1).max(4_096),
  url: z.url(),
});

export const WatchCapabilityPlanSchema = TriggerCapabilityPlanSchema.extend({
  expiresAt: IsoDateTimeSchema,
});

export const WatchReconcileActivationSchema = z.strictObject({
  activationId: TriggerWatchActivationIdSchema,
  anchorThreadId: ThreadIdSchema,
  capabilities: z.strictObject({
    browserCdp: WatchCapabilityPlanSchema.nullable(),
    mcp: WatchCapabilityPlanSchema,
  }),
  executionGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  revisionId: TriggerRevisionIdSchema,
  triggerId: TriggerIdSchema,
  workspaceAccess: WorkspaceExecutionAccessPlanSchema,
  workspaceId: WorkspaceIdSchema,
});
export type WatchReconcileActivation = z.infer<typeof WatchReconcileActivationSchema>;

export const TriggerExecutionContextSchema = z.strictObject({
  anchorThreadId: ThreadIdSchema,
  browserCdp: TriggerCapabilityPlanSchema.nullable(),
  event: TriggerProgramEventSchema,
  executionGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  mcp: TriggerCapabilityPlanSchema,
  occurrenceId: TriggerOccurrenceIdSchema,
  program: TriggerProgramSchema,
  revisionId: TriggerRevisionIdSchema,
  triggerId: TriggerIdSchema,
  workspaceId: WorkspaceIdSchema,
  workspaceAccess: WorkspaceExecutionAccessPlanSchema,
});
export type TriggerExecutionContext = z.infer<typeof TriggerExecutionContextSchema>;

export const ExecuteTriggerSchema = RunnerCommandBaseSchema.extend({
  context: TriggerExecutionContextSchema,
  type: z.literal("trigger.execute"),
});

export const ReconcileWatchesSchema = RunnerCommandBaseSchema.extend({
  desired: z.array(WatchReconcileActivationSchema).max(32),
  reconcileGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  type: z.literal("watch.reconcile"),
});

export const runnerCommandMaxSerializedBytes = 1_024 * 1_024 - 4 * 1_024;

export const pendingAgentEventMaxSerializedBytes = 480 * 1_024;
