import { iphoneIntegrationsProtocolVersion, iphoneOutdatedReason } from "./iphone-apps.js";
import { ChannelRuntimeCapabilitySchema } from "@opensteer/channel-core";
import { ComputerAppPlatformSchema } from "@opensteer/integration-core/computer-app";
import {
  AssignmentRunContextSchema,
  CommandIdSchema,
  type EnvironmentId,
  EnvironmentIdSchema,
  HarnessIdSchema,
  HarnessInstanceIdSchema,
  HarnessInstanceStateKindSchema,
  HarnessRuntimeRevisionSchema,
  IsoDateTimeSchema,
  LiveRunProgressSchema,
  MessageAuthorSchema,
  MessageSchema,
  MessageQuoteSchema,
  MessageContentSchema,
  MessageIdSchema,
  MessageKindSchema,
  ModelIdSchema,
  ModelProviderIdSchema,
  ProviderContinuationIdentitySchema,
  ProviderContinuationIdentityViewSchema,
  ModelSelectionSchema,
  ProviderSessionIdSchema,
  RequestIdSchema,
  RequestResponseSchema,
  RunIdSchema,
  SequenceSchema,
  RunnerCapabilitySchema,
  RunnerIdSchema,
  RunThreadStateSchema,
  GeneratedThreadTitleSchema,
  ThreadIdSchema,
  ThreadRoleSchema,
  ThreadAccessModeSchema,
  threadTitleRequestMaxLength,
  TriggerIdSchema,
  WorkspaceIconNameSchema,
  TriggerOccurrenceIdSchema,
  TriggerRevisionIdSchema,
  TriggerWatchActivationIdSchema,
  UserIdSchema,
  WorkspaceKindSchema,
  WorkspaceBackingKindSchema,
  WorkspaceIdSchema,
  messageAuthorCanWriteKind,
  runnerEventDataSchemas,
  threadReportBatchMaxEntries,
  threadReportBatchMaxSerializedBytes,
  utf8ByteLength,
} from "@opensteer/core";
import { RunAttachmentPlanSchema } from "./attachments.js";
import {
  TriggerExecutionOutputSchema,
  TriggerProgramEventSchema,
  TriggerProgramSchema,
} from "@opensteer/triggers";
import { WorkspaceExecutionAccessPlanSchema } from "@opensteer/workspace";
import { z } from "zod";
import { CorrelationIdSchema, ProtocolErrorSchema } from "./common.js";
import {
  RunnerAuxiliaryModuleSchema,
  RunnerBootIdSchema,
  RunnerChallengeIdSchema,
  RunnerConnectionFenceSchema,
  RunnerDeviceSchema,
  RunnerModuleNameSchema,
  type RunnerConnectionFence,
  type RunnerModuleName,
} from "./runner-identity.js";
import { RunnerAuxiliaryRequestIdSchema, RunnerAuxiliaryTicketSchema } from "./runner-auxiliary.js";
import { MachineAccessRunContextSchema, RunnerShellModuleSchema } from "./shell.js";
import {
  HostWorkspaceLocalRequestSchema,
  RunnerLocalStorageInventorySchema,
  RunnerWorkspaceLocalResultSchema,
} from "./workspace-local.js";
import { RunEgressPlanSchema } from "./access.js";
import {
  RunAgentControlPlanSchema,
  RunAgentToolsPlanSchema,
  RunBrowserCdpPlanSchema,
  RunIntegrationToolsPlanSchema,
  RunIntegrationSkillsPlanSchema,
} from "./agent-control.js";

/** Who an account of an engine talks to; see `HarnessSourceDescriptorSchema`. */
export const HarnessSourceIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/)
  .max(100);

const MountClientCertificateRequestSchema = z
  .string()
  .includes("-----BEGIN CERTIFICATE REQUEST-----")
  .max(32_768);

export const MountGrantExchangeRequestSchema = z.strictObject({
  clientCertificateRequestPem: MountClientCertificateRequestSchema,
});

const MountAuthoritySchema = z.discriminatedUnion("transport", [
  z.strictObject({
    address: z.string().min(1).max(512),
    caCertificatePem: z.string().includes("-----BEGIN CERTIFICATE-----"),
    serverName: z.string().min(1).max(253),
    transport: z.literal("tls-private-ca"),
  }),
  z.strictObject({
    address: z.string().min(1).max(512),
    serverName: z.string().min(1).max(253),
    transport: z.literal("tls-system-pki"),
  }),
]);

export const MountGrantExchangeResponseSchema = z.strictObject({
  automaticReauthorization: z.strictObject({
    authorityGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    enrollmentCertificatePem: z
      .string()
      .includes("-----BEGIN CERTIFICATE-----")
      .max(1024 * 1024),
    enrollmentId: z.string().min(1).max(256),
    manager: z.strictObject({
      caCertificatePem: z
        .string()
        .includes("-----BEGIN CERTIFICATE-----")
        .max(1024 * 1024),
      serverName: z.string().min(1).max(253),
      url: z.url(),
    }),
  }),
  authority: MountAuthoritySchema,
  capability: z.string().min(1).max(32_768),
  clientCertificatePem: z.string().includes("-----BEGIN CERTIFICATE-----"),
  expiresAt: IsoDateTimeSchema,
  volumeId: z.string().min(1).max(255),
});
export type MountGrantExchangeResponse = z.infer<typeof MountGrantExchangeResponseSchema>;

export const runHistoryMaxMessages = 200;
export const runHistoryMaxSerializedBytes = 384 * 1_024;
export const runHarnessConfigMaxSerializedBytes = 128 * 1_024;

const RunHarnessConfigSchema = z.unknown().refine((config) => {
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

const capabilityTokenSchema = z.string().min(1).max(4_096);

export const RunExecutionContextSchema = z.strictObject({
  accessMode: ThreadAccessModeSchema,
  assignment: AssignmentRunContextSchema.nullable(),
  agentControl: RunAgentControlPlanSchema,
  /** Scoped to files already admitted to this provider session and this frozen Run. */
  attachments: RunAttachmentPlanSchema.optional(),
  agentTools: RunAgentToolsPlanSchema,
  browserCdp: RunBrowserCdpPlanSchema,
  integrationTools: RunIntegrationToolsPlanSchema,
  integrationSkills: RunIntegrationSkillsPlanSchema,
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
  threadState: RunThreadStateSchema,
  /**
   * Present while the Thread still shows the first line of what started it,
   * sent only to a Runner that advertises `thread-title-v1`: that first
   * message, for this Run's engine to name the Thread with this Run's account.
   * The Runner answers with `runner.thread-title`, or says nothing. `icon`
   * asks for the Thread's symbol too; the Host sends it, and sends a request
   * whose title is already settled, only to a Runner advertising
   * `thread-icon-v1`.
   */
  titleRequest: z
    .strictObject({
      icon: z.literal(true).optional(),
      request: z.string().min(1).max(threadTitleRequestMaxLength),
    })
    .optional(),
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

const runnerCommandBase = z.strictObject({
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

const ExecuteRunSchema = runnerCommandBase.extend({
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
    integrationMcp: WatchCapabilityPlanSchema,
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
  integrationMcp: TriggerCapabilityPlanSchema,
  mcp: TriggerCapabilityPlanSchema,
  occurrenceId: TriggerOccurrenceIdSchema,
  program: TriggerProgramSchema,
  revisionId: TriggerRevisionIdSchema,
  triggerId: TriggerIdSchema,
  workspaceId: WorkspaceIdSchema,
  workspaceAccess: WorkspaceExecutionAccessPlanSchema,
});
export type TriggerExecutionContext = z.infer<typeof TriggerExecutionContextSchema>;

const ExecuteTriggerSchema = runnerCommandBase.extend({
  context: TriggerExecutionContextSchema,
  type: z.literal("trigger.execute"),
});

const ReconcileWatchesSchema = runnerCommandBase.extend({
  desired: z.array(WatchReconcileActivationSchema).max(32),
  reconcileGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  type: z.literal("watch.reconcile"),
});

const InterruptExecutionSchema = runnerCommandBase.extend({
  /** Present when only that execution of the Run is to stop: a restart's predecessor. */
  bindingGeneration: z.number().int().positive().optional(),
  type: z.literal("run.interrupt"),
  runId: RunIdSchema,
  threadId: ThreadIdSchema,
});

const InterruptTriggerExecutionSchema = runnerCommandBase.extend({
  occurrenceId: TriggerOccurrenceIdSchema,
  type: z.literal("trigger.interrupt"),
});

const ResolveRequestSchema = runnerCommandBase.extend({
  type: z.literal("request.resolve"),
  requestId: RequestIdSchema,
  response: RequestResponseSchema,
  runId: RunIdSchema,
});

const SteerExecutionSchema = runnerCommandBase.extend({
  type: z.literal("run.steer"),
  input: HarnessInputSchema,
  runId: RunIdSchema,
  threadId: ThreadIdSchema,
});

const MountWorkspaceSchema = runnerCommandBase.extend({
  plan: WorkspaceExecutionAccessPlanSchema,
  runId: RunIdSchema,
  threadId: ThreadIdSchema,
  type: z.literal("workspace.mount"),
  workspaceId: WorkspaceIdSchema,
});

const DetachWorkspaceSchema = runnerCommandBase.extend({
  type: z.literal("workspace.detach"),
  volumeId: z.string().min(1).max(255),
  workspaceId: WorkspaceIdSchema,
});

export const runnerCommandMaxSerializedBytes = 1_024 * 1_024 - 4 * 1_024;

export const RunnerCommandSchema = z
  .discriminatedUnion("type", [
    ExecuteRunSchema,
    ExecuteTriggerSchema,
    ReconcileWatchesSchema,
    InterruptExecutionSchema,
    InterruptTriggerExecutionSchema,
    ResolveRequestSchema,
    SteerExecutionSchema,
    MountWorkspaceSchema,
    DetachWorkspaceSchema,
  ])
  .refine(
    (command) =>
      new TextEncoder().encode(JSON.stringify(command)).byteLength <=
      runnerCommandMaxSerializedBytes,
    `Runner command must not exceed ${runnerCommandMaxSerializedBytes} serialized bytes`,
  );
export type RunnerCommand = z.infer<typeof RunnerCommandSchema>;

function pendingEventVariant<T extends keyof typeof runnerEventDataSchemas>(type: T) {
  return z.strictObject({
    bindingGeneration: z.number().int().positive(),
    data: runnerEventDataSchemas[type],
    emittedAt: IsoDateTimeSchema,
    environmentId: EnvironmentIdSchema,
    ordinal: z.number().int().nonnegative(),
    runId: RunIdSchema,
    threadId: ThreadIdSchema,
    type: z.literal(type),
    workspaceId: WorkspaceIdSchema,
  });
}

export const pendingAgentEventMaxSerializedBytes = 480 * 1_024;

export const PendingAgentEventSchema = z
  .discriminatedUnion("type", [
    pendingEventVariant("request.cancelled"),
    pendingEventVariant("request.opened"),
    pendingEventVariant("assistant.message"),
    pendingEventVariant("message.injected"),
    pendingEventVariant("reasoning.completed"),
    pendingEventVariant("run.completed"),
    pendingEventVariant("run.failed"),
    pendingEventVariant("run.interrupted"),
    pendingEventVariant("run.started"),
    pendingEventVariant("run.status"),
    pendingEventVariant("run.usage"),
    pendingEventVariant("run.phase"),
    pendingEventVariant("node.started"),
    pendingEventVariant("node.updated"),
    pendingEventVariant("node.completed"),
    pendingEventVariant("tool.completed"),
    pendingEventVariant("tool.started"),
  ])
  .refine(
    (event) =>
      new TextEncoder().encode(JSON.stringify(event)).byteLength <=
      pendingAgentEventMaxSerializedBytes,
    `Pending agent event must not exceed ${pendingAgentEventMaxSerializedBytes} serialized bytes`,
  );
export type PendingAgentEvent = z.infer<typeof PendingAgentEventSchema>;

/**
 * Who an account of an engine talks to. A source is the provider an account
 * signs in with and is billed by — the lab itself, a compatible endpoint the
 * person points the engine at, a cloud identity, or a hosted gateway. The
 * engine declares the sources it can drive; the Host and every client only
 * ever read the declaration.
 */
export const HarnessSourceKindSchema = z.enum([
  "first-party",
  "compatible-endpoint",
  "cloud-identity",
  "gateway",
]);
export type HarnessSourceKind = z.infer<typeof HarnessSourceKindSchema>;
/**
 * One value the person supplies when adding an account of this source — a
 * base URL for a compatible endpoint, a region for a cloud identity. Secrets
 * are never fields: they go through a setup method so they reach the Runner
 * and nothing else.
 */
const HarnessSourceFieldOptionSchema = z.object({
  label: z.string().trim().min(1).max(120),
  value: z.string().min(1).max(255),
});
export const HarnessSourceFieldSchema = z.object({
  defaultValue: z.string().min(1).max(255).optional(),
  detail: z.string().trim().min(1).max(300).optional(),
  id: z
    .string()
    .regex(/^[a-z][a-zA-Z0-9]*$/)
    .max(60),
  kind: z.enum(["url", "text", "select"]),
  label: z.string().trim().min(1).max(80),
  options: z.array(HarnessSourceFieldOptionSchema).min(1).max(16).optional(),
  placeholder: z.string().trim().min(1).max(200).optional(),
  required: z.boolean().optional(),
});
export type HarnessSourceField = z.infer<typeof HarnessSourceFieldSchema>;
export const HarnessSourceDescriptorSchema = z.object({
  detail: z.string().trim().min(1).max(300).optional(),
  // Unknown optional inputs can be skipped independently. A required unknown
  // input makes the whole source unsupported; the sources field below omits it.
  fields: z
    .array(z.unknown())
    .max(8)
    .transform((fields) =>
      fields.filter(
        (field) =>
          !(
            field !== null &&
            typeof field === "object" &&
            "kind" in field &&
            typeof field.kind === "string" &&
            !HarnessSourceFieldSchema.shape.kind.safeParse(field.kind).success &&
            "required" in field &&
            field.required === false
          ),
      ),
    )
    .pipe(z.array(HarnessSourceFieldSchema).max(8))
    .default([]),
  kind: HarnessSourceKindSchema,
  label: z.string().trim().min(1).max(80),
  modelSettings: z.boolean().optional(),
  /** What usage this source can ever report. "none" means a bar would be a lie. */
  quota: z.enum(["windows", "none"]),
  sourceId: HarnessSourceIdSchema,
  /** Which profile state kinds may hold an account of this source. */
  // Added state choices do not invalidate the understood choices.
  stateKinds: z
    .array(z.string())
    .max(100)
    .transform((kinds) =>
      kinds.filter((kind) => HarnessInstanceStateKindSchema.safeParse(kind).success),
    )
    .pipe(z.array(HarnessInstanceStateKindSchema).min(1).max(2)),
});
export type HarnessSourceDescriptor = z.infer<typeof HarnessSourceDescriptorSchema>;

const runnableHarnessDriver = z.object({
  /**
   * The Thread access modes this engine can enforce for a Run. The Host refuses
   * a Thread any mode absent from this list. Distinct from the machine-access
   * modes in `harnessCatalog`, which say where the engine's command sandbox can
   * reach the relay socket.
   */
  // Only understood access alternatives can be offered to a Thread.
  accessModes: z
    .array(z.string())
    .max(100)
    .transform((modes) => modes.filter((mode) => ThreadAccessModeSchema.safeParse(mode).success))
    .pipe(z.array(ThreadAccessModeSchema).min(1).max(4)),
  driverKind: HarnessIdSchema,
  /**
   * Whether this engine renders an MCP image content block to the model.
   *
   * Absent on an older Runner and therefore treated as not rendering one: a
   * tool that answers with a picture sends the block only to an engine that
   * says it shows it, and tells every other model in words that the picture
   * is unavailable there. Silence is not a declaration.
   */
  mcpImageContent: z.boolean().optional(),
  /** Absent on older Runners. File paths are always readable when advertised. */
  messageAttachments: z
    .object({
      nativeImages: z
        .object({
          maxBytes: z.number().int().positive(),
          maxPixels: z.number().int().positive(),
          mediaTypes: z.array(z.string().min(1)).min(1),
          steering: z.boolean(),
        })
        .nullable(),
    })
    .optional(),
  note: z.string().trim().min(1).max(500).optional(),
  readiness: z.enum(["configured", "runtime-check"]),
  /** Absent on an older Runner and therefore treated as unsupported. */
  steering: z.boolean().optional(),
  // Sources are independent alternatives. Never offer one whose required
  // configuration includes a field this Host cannot ask the person to supply.
  sources: z
    .array(z.unknown())
    .max(32)
    .transform((sources) =>
      sources.filter((source) => {
        if (source === null || typeof source !== "object") return true;
        if (
          "kind" in source &&
          typeof source.kind === "string" &&
          !HarnessSourceKindSchema.safeParse(source.kind).success
        )
          return false;
        return !(
          "fields" in source &&
          Array.isArray(source.fields) &&
          source.fields.some(
            (field: unknown) =>
              field !== null &&
              typeof field === "object" &&
              "kind" in field &&
              typeof field.kind === "string" &&
              !HarnessSourceFieldSchema.shape.kind.safeParse(field.kind).success &&
              (!("required" in field) || field.required !== false),
          )
        );
      }),
    )
    .pipe(z.array(HarnessSourceDescriptorSchema).min(1).max(32))
    .superRefine((sources, context) => {
      const seen = new Set<string>();
      for (const [index, source] of sources.entries()) {
        if (seen.has(source.sourceId)) {
          context.addIssue({
            code: "custom",
            message: `Source ${source.sourceId} is declared more than once`,
            path: [index, "sourceId"],
          });
        }
        seen.add(source.sourceId);
      }
    }),
});
const unavailableHarnessDriver = z.object({
  driverKind: HarnessIdSchema,
  readiness: z.literal("unavailable"),
  reason: z.string().trim().min(1).max(500),
});

export const RunnerHarnessDriverSchema = z.discriminatedUnion("readiness", [
  runnableHarnessDriver,
  unavailableHarnessDriver,
]);
export const RunnerHarnessDriverViewSchema = RunnerHarnessDriverSchema;
export type RunnerHarnessDriver = z.infer<typeof RunnerHarnessDriverSchema>;

const HarnessModelOptionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    defaultValue: z.string().max(255).optional(),
    id: z
      .string()
      .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/)
      .max(100),
    label: z.string().trim().min(1).max(120),
    type: z.literal("select"),
    values: z
      .array(
        z.strictObject({
          description: z.string().trim().min(1).max(500).optional(),
          label: z.string().trim().min(1).max(120),
          value: z.string().min(1).max(255),
        }),
      )
      .min(1)
      .max(32),
  }),
  z.strictObject({
    defaultValue: z.boolean(),
    id: z
      .string()
      .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/)
      .max(100),
    label: z.string().trim().min(1).max(120),
    type: z.literal("toggle"),
  }),
]);
const HarnessModelOptionViewSchema = z.discriminatedUnion("type", [
  z.object({
    ...HarnessModelOptionSchema.options[0].shape,
    values: z
      .array(
        z.object({
          description: z.string().trim().min(1).max(500).optional(),
          label: z.string().trim().min(1).max(120),
          value: z.string().min(1).max(255),
        }),
      )
      .min(1)
      .max(32),
  }),
  z.object(HarnessModelOptionSchema.options[1].shape),
]);

export const HarnessModelDescriptorSchema = z.strictObject({
  /**
   * Whether this model reads images. Absent means the engine's own catalog
   * does not say, and the Host treats unknown as false: a picture sent to a
   * model that cannot see it is a picture nobody saw and nobody can report,
   * so a tool that has one describes it in words instead.
   */
  acceptsImages: z.boolean().optional(),
  contextWindow: z.number().int().positive().max(10_000_000).optional(),
  description: z.string().trim().min(1).max(500).optional(),
  displayName: z.string().trim().min(1).max(120),
  isDefault: z.boolean(),
  maxOutputTokens: z.number().int().positive().max(10_000_000).optional(),
  modelId: ModelIdSchema,
  /**
   * The id this account's endpoint answers to, when it differs from modelId.
   * A Run sends it verbatim; the canonical pair stays the grouping key.
   */
  nativeModelId: z.string().min(1).max(255).optional(),
  /** The model's only blocker is an unknown context window a person can supply. */
  needsContextWindow: z.literal(true).optional(),
  options: z.array(HarnessModelOptionSchema).max(16),
  providerId: ModelProviderIdSchema,
  unavailableReason: z.string().trim().min(1).max(500).optional(),
});
const HarnessModelDescriptorViewSchema = z.object({
  ...HarnessModelDescriptorSchema.shape,
  options: z.array(HarnessModelOptionViewSchema).max(16),
});
export type HarnessModelDescriptor = z.infer<typeof HarnessModelDescriptorSchema>;

/** A person's explicit limit for one native endpoint model id. */
export const HarnessModelSettingsSchema = z
  .strictObject({
    contextWindow: z.number().int().positive().max(10_000_000),
    maxOutputTokens: z.number().int().positive().max(10_000_000).optional(),
  })
  .refine(
    ({ contextWindow, maxOutputTokens }) =>
      maxOutputTokens === undefined || maxOutputTokens < contextWindow,
    {
      message: "Maximum output tokens must be below the context window",
      path: ["maxOutputTokens"],
    },
  );
export type HarnessModelSettings = z.infer<typeof HarnessModelSettingsSchema>;
/** One account catalog cannot exceed this many native model ids. */
export const maxHarnessModelsPerCatalog = 8_192;
export const HarnessModelSettingsMapSchema = z
  .record(z.string().min(1).max(255), HarnessModelSettingsSchema)
  .refine(
    (models) => Object.keys(models).length <= maxHarnessModelsPerCatalog,
    `At most ${maxHarnessModelsPerCatalog} model settings are allowed`,
  );
export type HarnessModelSettingsMap = z.infer<typeof HarnessModelSettingsMapSchema>;
const HarnessModelSettingsViewSchema = HarnessModelSettingsSchema.strip();
export const HarnessModelSettingsMapViewSchema = z
  .record(z.string().min(1).max(255), HarnessModelSettingsViewSchema)
  .refine(
    (models) => Object.keys(models).length <= maxHarnessModelsPerCatalog,
    `At most ${maxHarnessModelsPerCatalog} model settings are allowed`,
  );

/**
 * A complete account catalog travels in one Runner frame. The frame's byte
 * limit remains the primary transport bound; this count also keeps a compact
 * or malicious catalog from growing without limit before serialization.
 */
const HarnessConnectionSlotSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/)
  .max(100);
const HarnessSetupMethodIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/)
  .max(100);
const HarnessSetupMethodBaseSchema = {
  connectionSlot: HarnessConnectionSlotSchema.optional(),
  detail: z.string().trim().min(1).max(500).optional(),
  label: z.string().trim().min(1).max(120),
  methodId: HarnessSetupMethodIdSchema,
} as const;
/**
 * Every advertised setup method is something a person completes interactively,
 * so a catalog's `setupMethods` is exactly the set the sign-in dialog can offer.
 * There is deliberately no "the Runner handles it silently" kind: a method the
 * UI could not drive would be advertised and then refused. `local-import` is
 * the person saying "use the key this computer already holds" — one click, no
 * input — and the Runner then copies that key into the account.
 */
export const HarnessSetupMethodSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...HarnessSetupMethodBaseSchema,
    kind: z.enum(["device-code", "browser-code", "local-import"]),
  }),
  z.strictObject({
    ...HarnessSetupMethodBaseSchema,
    inputLabel: z.string().trim().min(1).max(120),
    inputPlaceholder: z.string().trim().min(1).max(200).optional(),
    kind: z.literal("secret-input"),
  }),
]);
const HarnessSetupMethodViewSchema = z.discriminatedUnion("kind", [
  z.object(HarnessSetupMethodSchema.options[0].shape),
  z.object(HarnessSetupMethodSchema.options[1].shape),
]);
export type HarnessSetupMethod = z.infer<typeof HarnessSetupMethodSchema>;

/**
 * Whose capacity a window is about.
 *
 * An absent scope is the account as a whole, which is what every provider that
 * meters a plan reports today. A model scope is a limit the provider states
 * for one model only: a reader planning around another model must ignore it,
 * because a window that cannot constrain the work in hand would otherwise read
 * as capacity that is gone.
 */
export const HarnessObservedUsageScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("account") }),
  z.strictObject({
    kind: z.literal("model"),
    modelId: ModelIdSchema,
    providerId: ModelProviderIdSchema,
  }),
]);
const HarnessObservedUsageScopeViewSchema = z.discriminatedUnion("kind", [
  z.object(HarnessObservedUsageScopeSchema.options[0].shape),
  z.object(HarnessObservedUsageScopeSchema.options[1].shape),
]);
export type HarnessObservedUsageScope = z.infer<typeof HarnessObservedUsageScopeSchema>;

export const HarnessObservedUsageWindowSchema = z.strictObject({
  /** The provider's own framing of the window — "5h", "weekly", "30d". */
  label: z.string().trim().min(1).max(24),
  resetsAt: IsoDateTimeSchema.nullable(),
  /** Absent means the account as a whole. */
  scope: HarnessObservedUsageScopeSchema.optional(),
  usedPercent: z.number().min(0).max(100),
});
const HarnessObservedUsageWindowViewSchema = z.object({
  ...HarnessObservedUsageWindowSchema.shape,
  scope: HarnessObservedUsageScopeViewSchema.optional(),
});
export type HarnessObservedUsageWindow = z.infer<typeof HarnessObservedUsageWindowSchema>;

/**
 * Provider-neutral consumption against one connection's account. Only what a
 * reader can act on crosses the wire: how much of each window is spent, when
 * it comes back, and whether the account is out. Plan and credit wording stays
 * in `billingLabel`.
 */
export const HarnessObservedUsageSchema = z.strictObject({
  limitReached: z.boolean(),
  /**
   * When the Runner took the reading. It travels with the usage rather than
   * with the catalog so a reader can always tell a fresh percentage from one
   * that has aged out.
   */
  observedAt: IsoDateTimeSchema,
  windows: z.array(HarnessObservedUsageWindowSchema).max(8),
});
const HarnessObservedUsageViewSchema = z.object({
  ...HarnessObservedUsageSchema.shape,
  windows: z.array(HarnessObservedUsageWindowViewSchema).max(8),
});
export type HarnessObservedUsage = z.infer<typeof HarnessObservedUsageSchema>;

/**
 * How a connection is authorised, as data rather than as a label a driver
 * formats: a subscription carries a person's identity and plan windows, a key
 * carries neither, a cloud identity belongs to the machine.
 */
export const HarnessAuthKindSchema = z.enum(["subscription", "api-key", "cloud-identity", "none"]);
export type HarnessAuthKind = z.infer<typeof HarnessAuthKindSchema>;
export const HarnessObservedConnectionSchema = z.strictObject({
  accountLabel: z.string().trim().min(1).max(200).optional(),
  authKind: HarnessAuthKindSchema.optional(),
  billingLabel: z.string().trim().min(1).max(200).optional(),
  connectionSlot: HarnessConnectionSlotSchema,
  label: z.string().trim().min(1).max(120),
  logoutSupported: z.boolean().optional(),
  status: z.enum(["connected", "authentication-required", "unavailable"]),
  usage: HarnessObservedUsageSchema.optional(),
});
const HarnessObservedConnectionViewSchema = z.object({
  ...HarnessObservedConnectionSchema.shape,
  usage: HarnessObservedUsageViewSchema.optional(),
});
export type HarnessObservedConnection = z.infer<typeof HarnessObservedConnectionSchema>;

const HarnessSetupCatalogFields = {
  connections: z.array(HarnessObservedConnectionSchema).max(32).default([]),
  setupMethods: z.array(HarnessSetupMethodSchema).max(16).default([]),
} as const;
const HarnessSetupCatalogViewFields = {
  connections: z.array(HarnessObservedConnectionViewSchema).max(32).default([]),
  setupMethods: z.array(HarnessSetupMethodViewSchema).max(16).default([]),
} as const;

export const HarnessInstanceCatalogSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...HarnessSetupCatalogFields,
    continuationIdentity: ProviderContinuationIdentitySchema,
    driverKind: HarnessIdSchema,
    harnessInstanceId: HarnessInstanceIdSchema,
    models: z.array(HarnessModelDescriptorSchema).min(1).max(maxHarnessModelsPerCatalog),
    status: z.literal("ready"),
    steering: z.boolean().default(false),
    /**
     * Projected continuation keys this profile's native session store answered
     * under before. They exist only so a Host can move Threads pinned to a
     * retired identity onto the current one; nothing resumes through them.
     */
    supersededContinuationIdentities: z
      .array(ProviderContinuationIdentitySchema.shape.continuationKey)
      .max(256)
      .default([]),
    detail: z.string().trim().min(1).max(500).optional(),
  }),
  z.strictObject({
    ...HarnessSetupCatalogFields,
    driverKind: HarnessIdSchema,
    harnessInstanceId: HarnessInstanceIdSchema,
    models: z.array(HarnessModelDescriptorSchema).max(0),
    status: z.literal("authentication-required"),
    detail: z.string().trim().min(1).max(500),
  }),
  z.strictObject({
    connections: z.array(HarnessObservedConnectionSchema).max(0).default([]),
    setupMethods: z.array(HarnessSetupMethodSchema).max(0).default([]),
    driverKind: HarnessIdSchema,
    harnessInstanceId: HarnessInstanceIdSchema,
    models: z.array(HarnessModelDescriptorSchema).max(0),
    status: z.literal("preparing"),
    detail: z.string().trim().min(1).max(500),
  }),
  z.strictObject({
    ...HarnessSetupCatalogFields,
    driverKind: HarnessIdSchema,
    harnessInstanceId: HarnessInstanceIdSchema,
    models: z.array(HarnessModelDescriptorSchema).max(0),
    status: z.enum(["unavailable", "error"]),
    detail: z.string().trim().min(1).max(500),
  }),
]);
export const HarnessInstanceCatalogViewSchema = z.discriminatedUnion("status", [
  z.object({
    ...HarnessInstanceCatalogSchema.options[0].shape,
    ...HarnessSetupCatalogViewFields,
    capturedAt: IsoDateTimeSchema.optional(),
    continuationIdentity: ProviderContinuationIdentityViewSchema,
    models: z.array(HarnessModelDescriptorViewSchema).min(1).max(maxHarnessModelsPerCatalog),
  }),
  z.object({
    ...HarnessInstanceCatalogSchema.options[1].shape,
    ...HarnessSetupCatalogViewFields,
    capturedAt: IsoDateTimeSchema.optional(),
    models: z.array(HarnessModelDescriptorViewSchema).max(0),
  }),
  z.object({
    ...HarnessInstanceCatalogSchema.options[2].shape,
    capturedAt: IsoDateTimeSchema.optional(),
    connections: z.array(HarnessObservedConnectionViewSchema).max(0).default([]),
    models: z.array(HarnessModelDescriptorViewSchema).max(0),
    setupMethods: z.array(HarnessSetupMethodViewSchema).max(0).default([]),
  }),
  z.object({
    ...HarnessInstanceCatalogSchema.options[3].shape,
    ...HarnessSetupCatalogViewFields,
    capturedAt: IsoDateTimeSchema.optional(),
    models: z.array(HarnessModelDescriptorViewSchema).max(0),
  }),
]);
export type HarnessInstanceCatalog = z.infer<typeof HarnessInstanceCatalogSchema>;
export type HarnessInstanceCatalogView = z.infer<typeof HarnessInstanceCatalogViewSchema>;

export const HarnessAuthenticationStateSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("not-started") }),
  z.strictObject({
    challenge: z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("device-code"),
        userCode: z.string().trim().min(1).max(256),
        verificationUrl: z.url().max(2_048),
      }),
      z.strictObject({
        authorizationUrl: z.url().max(2_048),
        inputPrompt: z.string().trim().min(1).max(200),
        kind: z.literal("browser-code"),
      }),
      z.strictObject({
        inputLabel: z.string().trim().min(1).max(120),
        inputPlaceholder: z.string().trim().min(1).max(200).optional(),
        kind: z.literal("secret-input"),
      }),
    ]),
    connectionSlot: HarnessConnectionSlotSchema.optional(),
    methodId: HarnessSetupMethodIdSchema.optional(),
    status: z.literal("pending"),
  }),
  z.strictObject({ status: z.literal("ready") }),
  z.strictObject({
    detail: z.string().trim().min(1).max(500),
    status: z.literal("failed"),
  }),
]);
export const HarnessAuthenticationStateViewSchema = z.discriminatedUnion("status", [
  z.object(HarnessAuthenticationStateSchema.options[0].shape),
  z.object({
    ...HarnessAuthenticationStateSchema.options[1].shape,
    challenge: z.discriminatedUnion("kind", [
      z.object(HarnessAuthenticationStateSchema.options[1].shape.challenge.options[0].shape),
      z.object(HarnessAuthenticationStateSchema.options[1].shape.challenge.options[1].shape),
      z.object(HarnessAuthenticationStateSchema.options[1].shape.challenge.options[2].shape),
    ]),
  }),
  z.object(HarnessAuthenticationStateSchema.options[2].shape),
  z.object(HarnessAuthenticationStateSchema.options[3].shape),
]);
export type HarnessAuthenticationState = z.infer<typeof HarnessAuthenticationStateSchema>;

/**
 * The model servers an account of a Model server source can talk to, by the
 * API each one answers. `generic` is any server with an OpenAI model list.
 */
export const ModelServerRuntimeSchema = z.enum(["generic", "ollama", "lmstudio", "omlx"]);
export type ModelServerRuntime = z.infer<typeof ModelServerRuntimeSchema>;

/**
 * A model server as the Runner found it: on its own computer, or at an address
 * the person gave. It says what the server is and whether an account could use
 * it now. It never carries a credential; one the server's own settings hold
 * stays on the Runner.
 */
const modelServerFields = {
  baseUrl: z.url({ protocol: /^https?$/u }).max(2_048),
  /** Why the server cannot serve an account yet, or why no model can run. */
  detail: z.string().trim().min(1).max(500).optional(),
  /**
   * Chat models the server lists, and how many of them can run a Thread now.
   * Absent when that could not be read: a server that has not answered, or one
   * whose list is behind a key nothing sends until the person connects.
   */
  models: z.number().int().nonnegative().max(maxHarnessModelsPerCatalog).optional(),
  runnableModels: z.number().int().nonnegative().max(maxHarnessModelsPerCatalog).optional(),
  runtime: ModelServerRuntimeSchema,
  status: z.enum(["ready", "needs-key", "not-running", "unavailable"]),
};
export const ModelServerSchema = z.strictObject(modelServerFields);
export const ModelServerViewSchema = z.object(modelServerFields);
export type ModelServer = z.infer<typeof ModelServerSchema>;
/** One per runtime the Runner looks for, or the one address it was given. */
export const maxModelServers = 8;

/**
 * How many AI engine profiles one work location may hold.
 *
 * This is a protocol bound before it is a product one: a reconcile carries the
 * environment's *complete* desired set, so a set that does not fit in one
 * message is a set the Runner can never be told about. The durable store
 * enforces the same number when a profile is created, which is what keeps the
 * bound reachable as a conflict somebody can read rather than as an
 * unrepresentable desired state discovered at reconcile time.
 */
export const maxHarnessInstancesPerEnvironment = 100;

const HarnessInspectionDefinitionSchema = z.strictObject({
  config: RunHarnessConfigSchema,
  driverKind: HarnessIdSchema,
  id: HarnessInstanceIdSchema,
  name: z.string().trim().min(1).max(120),
  runtimeRevision: HarnessRuntimeRevisionSchema,
  sourceId: HarnessSourceIdSchema,
  stateKind: HarnessInstanceStateKindSchema,
});

const RunnerHarnessDriversSchema = z
  .array(z.unknown())
  .max(100)
  // Engines/readiness alternatives unknown to this Host cannot be selected.
  .transform((drivers) =>
    drivers.filter((driver) => {
      if (driver === null || typeof driver !== "object") return true;
      if (
        "driverKind" in driver &&
        typeof driver.driverKind === "string" &&
        !HarnessIdSchema.safeParse(driver.driverKind).success
      )
        return false;
      return !(
        "readiness" in driver &&
        typeof driver.readiness === "string" &&
        !RunnerHarnessDriverSchema.options.some(
          (option) => option.shape.readiness.safeParse(driver.readiness).success,
        )
      );
    }),
  )
  .pipe(z.array(RunnerHarnessDriverSchema).max(100))
  .superRefine((drivers, context) => {
    const seen = new Set<string>();
    for (const [index, driver] of drivers.entries()) {
      if (seen.has(driver.driverKind)) {
        context.addIssue({
          code: "custom",
          message: `Harness driver ${driver.driverKind} is advertised more than once`,
          path: [index, "driverKind"],
        });
      }
      seen.add(driver.driverKind);
    }
  });

const runnerMessageBase = {} as const;

/**
 * The fence every post-authentication frame repeats in both directions. A
 * message that names a superseded connection is refused rather than applied to
 * whichever socket happens to be current.
 */
const fencedMessageBase = { ...RunnerConnectionFenceSchema.shape } as const;

export const RunnerWorkspaceMountSchema = z.object({
  enrollmentId: z.string().min(1).max(256),
  volumeId: z.string().min(1).max(255),
  workspaceId: WorkspaceIdSchema,
});
export type RunnerWorkspaceMount = z.infer<typeof RunnerWorkspaceMountSchema>;

/**
 * Everything an agent-executing machine offers. Only this module carries an
 * environment, harnesses and storage: a Runner that exists to relay a browser
 * or a messaging transport has no work location and must not be made to invent
 * one.
 */
export const RunnerAgentsModuleSchema = z
  .object({
    // Exactly one. A Runner holds a single unscoped harness registry and its
    // identity refuses any other environment, so advertising a list the
    // reconciler could never honor per-environment only invited callers to
    // loop over it.
    environmentIds: z.array(EnvironmentIdSchema).length(1),
    computerTool: z.literal(1).optional(),
    harnessDrivers: RunnerHarnessDriversSchema,
    // Present exactly when this Runner advertises local-directory. It carries
    // the disk's durable identity plus what that disk currently holds, so a
    // reconnect is reconciled without asking binding by binding.
    localStorage: RunnerLocalStorageInventorySchema.nullable(),
    loginFill: z
      .number()
      .int()
      .positive()
      .transform((version) => (version === 1 ? (1 as const) : undefined))
      .optional(),
    maxConcurrentRuns: z.number().int().positive().max(1_000),
    // New choices may coexist with supported ones; a required set must remain usable.
    providerStateModes: z
      .array(z.string())
      .max(100)
      .transform((values) =>
        values.filter((value) => HarnessInstanceStateKindSchema.safeParse(value).success),
      )
      .pipe(z.array(HarnessInstanceStateKindSchema).min(1).max(2)),
    // New choices may coexist with supported ones; a required set must remain usable.
    workspaceBackings: z
      .array(z.string())
      .max(100)
      .transform((values) =>
        values.filter((value) => WorkspaceBackingKindSchema.safeParse(value).success),
      )
      .pipe(z.array(WorkspaceBackingKindSchema).min(1).max(2)),
    workspaceMounts: z.array(RunnerWorkspaceMountSchema).max(10_000),
  })
  .superRefine((module, context) => {
    if (new Set(module.providerStateModes).size !== module.providerStateModes.length) {
      context.addIssue({ code: "custom", message: "Runner provider state modes must be unique" });
    }
    if (new Set(module.workspaceBackings).size !== module.workspaceBackings.length) {
      context.addIssue({ code: "custom", message: "Runner Workspace backings must be unique" });
    }
    if (module.workspaceBackings.includes("local-directory") !== (module.localStorage !== null)) {
      context.addIssue({
        code: "custom",
        message: "A local-directory Runner must advertise exactly one local storage authority",
        path: ["localStorage"],
      });
    }
    if (
      module.localStorage !== null &&
      new Set(module.localStorage.bindings.map((binding) => binding.bindingId)).size !==
        module.localStorage.bindings.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Runner local Workspace binding identifiers must be unique",
        path: ["localStorage", "bindings"],
      });
    }
    if (
      new Set(module.workspaceMounts.map((mount) => mount.workspaceId)).size !==
      module.workspaceMounts.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Runner Workspace mount identifiers must be unique",
      });
    }
  });
export type RunnerAgentsModule = z.infer<typeof RunnerAgentsModuleSchema>;

export const RunnerBrowserModuleSchema = z
  .object({
    /** Page-provider contract, available only after the engine Security probe. */
    passkeys: z
      .number()
      .int()
      .positive()
      .transform((version) => (version === 1 ? version : undefined))
      .optional(),
    navigationVersion: z
      .number()
      .int()
      .positive()
      .transform((version) => (version === 1 ? version : undefined))
      .optional(),
    workspaceTabRestoreVersion: z
      .number()
      .int()
      .positive()
      .transform((version) => (version === 1 ? version : undefined))
      .optional(),
    // Older signed Runner descriptors have no version. Keep them admissible so
    // their agents, shell and integrations modules continue to work; browser
    // placement checks the capability version before it can be used.
    profileSnapshotVersion: z.number().int().positive().optional(),
    runtimeId: z.string().min(1).max(255),
    /**
     * The browser this Runner serves applies a Host-originated `state.import`
     * to a live context. Absent on an older Runner, which is never sent a frame
     * it cannot parse.
     */
    stateImport: z.literal(true).optional(),
    /**
     * The browser this Runner serves stages page-bound files through
     * `Opensteer.stageFile` and accepts file inputs and drag data inside each
     * session's staged folder. Absent on an older Runner.
     */
    fileStaging: z.literal(true).optional(),
    /** Authorizes saved-login field fills on the Mac running this browser. */
    // Unsupported optional feature versions are disabled, never reinterpreted.
    signIn: z
      .object({ version: z.number().int().positive() })
      .transform((value) => (value.version === 3 ? { version: 3 as const } : undefined))
      .optional(),
    /**
     * The browser this Runner serves applies the agent CDP boundary: page-level
     * methods, parameters and events only. The Host gives agents no CDP on a
     * browser without it.
     */
    cdpBoundary: z
      .number()
      .int()
      .positive()
      .transform((version) => (version === 1 ? version : undefined))
      .optional(),
    /**
     * Independent human/agent targets, exact viewer surface metadata and dialog
     * IDs. Pages follow the person's view (`viewport.follow`) and start at the
     * attach ticket's size. The Host translates viewer messages for older Runners.
     */
    sharedControl: z
      .number()
      .int()
      .positive()
      .transform((version) => (version === 1 ? version : undefined))
      .optional(),
    /**
     * A viewer may follow a target without pictures (`stream.subscribe` with
     * `frames: false`): it gets the target's dialogs and changes and starts no
     * screencast. Natively shown desktop pages need it.
     */
    targetControl: z
      .number()
      .int()
      .positive()
      .transform((version) => (version === 1 ? version : undefined))
      .optional(),
    /** Explicit top-left capture regions and capture-revision aiming. */
    captureRegion: z
      .number()
      .int()
      .positive()
      .transform((version) => (version === 1 ? version : undefined))
      .optional(),
    /**
     * The editing contract (`editing.ts`): keystrokes with text, commands,
     * live compositions, verified text edits and editing context. V1 includes an
     * isolated engine clipboard; v2 advertises that separately.
     */
    editing: z
      .number()
      .int()
      .positive()
      .transform((version): 1 | 2 | undefined =>
        version === 1 || version === 2 ? version : undefined,
      )
      .optional(),
    /** Required for editing v2; true means the engine isolates clipboard operations. */
    clipboard: z.boolean().optional(),
  })
  .transform(({ editing, clipboard, ...module }) => {
    const version = editing === 2 && clipboard === undefined ? undefined : editing;
    return {
      ...module,
      ...(version ? { editing: version } : {}),
      ...(version === 2 ? { clipboard } : {}),
    };
  });
export type RunnerBrowserModule = z.infer<typeof RunnerBrowserModuleSchema>;

export const RunnerMessagingModuleSchema = z.object({
  capabilities: z.array(ChannelRuntimeCapabilitySchema).min(1).max(64),
});
export type RunnerMessagingModule = z.infer<typeof RunnerMessagingModuleSchema>;

/** Mac protocol 5 carries the remaining startup budget. */
export const runnerIntegrationsProtocolVersion = 5;
export const androidIntegrationsProtocolVersion = 4;

export const RunnerIntegrationsModuleSchema = z.object({
  computerUseVersion: z
    .number()
    .int()
    .positive()
    .transform((version) => (version === 2 ? (2 as const) : undefined))
    .optional(),
  /** Ciphertext may reach the executor only when every Mac hop supports this version. */
  loginText: z
    .number()
    .int()
    .positive()
    .transform((version) => (version === 1 ? (1 as const) : undefined))
    .optional(),
  /** Only the Personal desktop's live vault authority supplies this control path. */
  passwordSignIn: z
    .number()
    .int()
    .positive()
    .transform((version) => (version === 1 ? (1 as const) : undefined))
    .optional(),
  ownerViewVersion: z.number().int().positive().max(1000).optional(),
  /**
   * This Runner relays computer-app approvals between its Host and the
   * desktop app supervising it or the iPhone's native executor
   * (`host.integrations.computer-app-approvals` and the answer frames).
   * Absent on an older Runner, which is never sent a frame it cannot parse.
   */
  computerAppApprovals: z.literal(true).optional(),
  /**
   * The person's input into exact Mac app windows, shared with the agent's
   * actions. Only version 2 is understood; the exclusive version 1 is disabled.
   */
  macOwnerInputVersion: z
    .number()
    .int()
    .positive()
    .transform((version) => (version === 2 ? version : undefined))
    .optional(),
  macWindowVideoVersion: z
    .number()
    .int()
    .positive()
    .transform((version) => (version === 1 ? version : undefined))
    .optional(),
  /** Selected-text Cut; requires integrations.editing and Host display.start confirmation. */
  displayCut: z
    .number()
    .int()
    .positive()
    .transform((version) => (version === 1 ? version : undefined))
    .optional(),
  /** Android display editing. A Host confirms support on display.start before new frames flow. */
  editing: z
    .number()
    .int()
    .positive()
    .transform((version) => (version === 1 ? version : undefined))
    .optional(),
  /**
   * Android accepts the person's display input alongside the agent's acts,
   * with no Take over. A Host confirms it on display.start before sending input.
   */
  sharedInput: z
    .number()
    .int()
    .positive()
    .transform((version) => (version === 1 ? version : undefined))
    .optional(),
  platform: ComputerAppPlatformSchema,
  // Android, Mac and iPhone have independent protocol versions.
  protocolVersion: z.number().int().positive().optional(),
});
export type RunnerIntegrationsModule = z.infer<typeof RunnerIntegrationsModuleSchema>;

/**
 * What an Android phone's owner does about an app too old for this Host. A
 * current app updates itself from its Host when refused; an app too old to do
 * that shows this sentence, and only setup over USB can update it.
 */
export const agentPhoneOutdatedReason =
  "This phone's Opensteer app is out of date. Plug the phone into a computer and add it again to update it.";

export function runnerSupportsComputerUse(module: RunnerIntegrationsModule | undefined): boolean {
  return (
    module?.platform === "darwin" &&
    module.protocolVersion === runnerIntegrationsProtocolVersion &&
    module.computerUseVersion === 2
  );
}

export function runnerIntegrationsCompatibilityReason(
  module: RunnerIntegrationsModule | undefined,
): string | null {
  if (module?.platform === "ios")
    return module.protocolVersion === iphoneIntegrationsProtocolVersion
      ? null
      : iphoneOutdatedReason;
  if (
    module?.protocolVersion ===
    (module?.platform === "android"
      ? androidIntegrationsProtocolVersion
      : runnerIntegrationsProtocolVersion)
  )
    return null;
  return module?.platform === "android"
    ? agentPhoneOutdatedReason
    : "Update Opensteer on this computer to use app approvals and local MCP servers.";
}

export const RunnerModulesSchema = z
  .object({
    agents: RunnerAgentsModuleSchema.optional(),
    browser: RunnerBrowserModuleSchema.optional(),
    integrations: RunnerIntegrationsModuleSchema.optional(),
    messaging: RunnerMessagingModuleSchema.optional(),
    shell: RunnerShellModuleSchema.optional(),
  })
  .superRefine((modules, context) => {
    if (
      !modules.agents &&
      !modules.browser &&
      !modules.integrations &&
      !modules.messaging &&
      !modules.shell
    ) {
      context.addIssue({ code: "custom", message: "A Runner must advertise at least one module" });
    }
  });
export type RunnerModules = z.infer<typeof RunnerModulesSchema>;

export function advertisedRunnerModules(modules: RunnerModules): readonly RunnerModuleName[] {
  return RunnerModuleNameSchema.options.filter((name) => modules[name] !== undefined);
}

export const RunnerDescriptorSchema = z
  .object({
    bootId: RunnerBootIdSchema,
    // Capability names are an extensible set, independent of required semantics.
    capabilities: z
      .array(z.string())
      .max(100)
      .transform((names) => names.filter((name) => RunnerCapabilitySchema.safeParse(name).success))
      .pipe(z.array(RunnerCapabilitySchema).max(100)),
    /**
     * The computer this Runner runs on. Absent from an older Runner, and from
     * the Deployment's own browser and messaging services, which are not
     * computers anybody recognises by shape.
     */
    device: RunnerDeviceSchema.optional(),
    // Unknown module names are stripped by the owning modules object.
    modules: RunnerModulesSchema,
    name: z.string().trim().min(1).max(120),
    runnerId: RunnerIdSchema,
    runnerKind: z.enum(["main", "local", "managed"]),
    runtimeVersion: z.string().min(1).max(120),
  })
  .superRefine((descriptor, context) => {
    const phone = descriptor.modules.integrations;
    if (
      phone?.platform === "android" &&
      (phone.protocolVersion !== androidIntegrationsProtocolVersion ||
        phone.ownerViewVersion !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: agentPhoneOutdatedReason,
        path: ["modules", "integrations"],
      });
    }
    if (new Set(descriptor.capabilities).size !== descriptor.capabilities.length) {
      context.addIssue({ code: "custom", message: "Runner capabilities must be unique" });
    }
  });
export type RunnerDescriptor = z.infer<typeof RunnerDescriptorSchema>;

/** The environments this Runner may execute on, which is empty without agents. */
export function runnerEnvironmentIds(
  descriptor: Pick<RunnerDescriptor, "modules">,
): readonly EnvironmentId[] {
  return descriptor.modules.agents?.environmentIds ?? [];
}

/**
 * Whether a module can serve work right now, which the descriptor never says.
 * A descriptor is a claim about what the machine offers; readiness is the
 * Runner's own check of whether the thing behind that claim actually answered.
 * A heartbeat renews connection authority and deliberately reports nothing
 * here, so a live socket alone can never make a module routable.
 */
export const RunnerModuleReadinessSchema = z.enum(["ready", "degraded", "unavailable"]);
export type RunnerModuleReadiness = z.infer<typeof RunnerModuleReadinessSchema>;

export const RunnerModuleReadinessReportSchema = z.strictObject({
  checkedAt: IsoDateTimeSchema,
  detail: z.string().trim().min(1).max(500).nullable(),
  module: RunnerModuleNameSchema,
  readiness: RunnerModuleReadinessSchema,
});
export type RunnerModuleReadinessReport = z.infer<typeof RunnerModuleReadinessReportSchema>;

/** Primary Runner identity proof format; independent of the browser/client API epoch. */
export const runnerProofFormatVersion = 2;
export const runnerProofFormatUpdateReason =
  "Runner proof format differs from this Host. Update Opensteer on the Host and this computer; update Agent Phone over USB once for proof format v2.";

export const RunnerChallengeSchema = z.object({
  ...runnerMessageBase,
  challengeId: RunnerChallengeIdSchema,
  expiresAt: IsoDateTimeSchema,
  hostSessionId: z.string().regex(/^[A-Za-z0-9_-]{32,255}$/),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{32,255}$/),
  // Missing on a pre-v2 Host, so the producer can report an actionable refusal.
  proofFormatVersion: z.number().int().positive().optional(),
  type: z.literal("host.challenge"),
});
export type RunnerChallenge = z.infer<typeof RunnerChallengeSchema>;

const runnerProofBase = {
  ...runnerMessageBase,
  challengeId: RunnerChallengeIdSchema,
  descriptor: RunnerDescriptorSchema,
  proofFormatVersion: z.literal(runnerProofFormatVersion),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
} as const;

export const RunnerAuthenticateSchema = z.strictObject({
  ...runnerProofBase,
  type: z.literal("runner.authenticate"),
});

export const RunnerEnrollmentCredentialSchema = z.strictObject({
  enrollmentToken: z.string().min(32).max(4_096),
  kind: z.literal("host-enrollment-token"),
});
export type RunnerEnrollmentCredential = z.infer<typeof RunnerEnrollmentCredentialSchema>;

export const RunnerEnrollSchema = z.strictObject({
  ...runnerProofBase,
  credential: RunnerEnrollmentCredentialSchema,
  publicKeyPem: z.string().min(64).max(16_384),
  type: z.literal("runner.enroll"),
});

const RunnerProofSchema = z.discriminatedUnion("type", [
  RunnerAuthenticateSchema,
  RunnerEnrollSchema,
]);
export type RunnerProof = z.infer<typeof RunnerProofSchema>;

/** Envelope parsing must preserve the descriptor value exactly as received. */
const runnerWireProofBase = {
  challengeId: RunnerChallengeIdSchema,
  descriptor: z
    .unknown()
    .refine(
      (value) => value !== null && typeof value === "object" && !Array.isArray(value),
      "Runner descriptor must be a JSON object",
    ),
  proofFormatVersion: z.number().int().positive().optional(),
  signature: runnerProofBase.signature,
};
export const RunnerWireAuthenticateSchema = z.strictObject({
  ...runnerWireProofBase,
  type: z.literal("runner.authenticate"),
});
export const RunnerWireProofSchema = z.discriminatedUnion("type", [
  RunnerWireAuthenticateSchema,
  z.strictObject({
    ...runnerWireProofBase,
    credential: RunnerEnrollmentCredentialSchema,
    publicKeyPem: RunnerEnrollSchema.shape.publicKeyPem,
    type: z.literal("runner.enroll"),
  }),
]);
export type RunnerWireProof = z.infer<typeof RunnerWireProofSchema>;
/** Identity-only update verification shares the raw v2 proof, never a domain projection. */
export const RunnerUpdateProofSchema = RunnerWireAuthenticateSchema;
export type RunnerUpdateProof = z.infer<typeof RunnerUpdateProofSchema>;

const watchLogTailSchema = z
  .string()
  .max(16 * 1_024)
  .refine((value) => utf8ByteLength(value) <= 16 * 1_024, "Watch log tail exceeds 16 KiB");

export const RunnerOperationalMessageSchema = z.discriminatedUnion("type", [
  ...RunnerWorkspaceLocalResultSchema.options,
  z.strictObject({
    ...fencedMessageBase,
    type: z.literal("runner.heartbeat"),
    activeRunIds: z.array(RunIdSchema).max(1_000),
    activeTriggerOccurrenceIds: z.array(TriggerOccurrenceIdSchema).max(1_000),
    activeWatchActivationIds: z.array(TriggerWatchActivationIdSchema).max(1_000),
    sentAt: IsoDateTimeSchema,
  }),
  z.strictObject({
    ...fencedMessageBase,
    modules: z.array(RunnerModuleReadinessReportSchema).min(1).max(5),
    type: z.literal("runner.modules.report"),
  }),
  /**
   * The macOS Full Disk Access grant changed since this Runner said hello.
   *
   * The descriptor is signed once, at connect; this is the one fact in it that
   * a person changes underneath a live connection, in System Settings, so the
   * Runner announces the new answer on the fenced connection instead of
   * reconnecting. The connection fence is the whole authority — enough for a
   * boolean that grants nothing on the Host, and never a way to change the
   * host key, which only a signed hello may state.
   */
  z.strictObject({
    ...fencedMessageBase,
    fullDiskAccess: z.boolean(),
    type: z.literal("runner.shell.full-disk-access"),
  }),
  z.strictObject({
    ...fencedMessageBase,
    module: RunnerAuxiliaryModuleSchema,
    requestId: RunnerAuxiliaryRequestIdSchema,
    type: z.literal("runner.auxiliary.ticket-request"),
  }),
  /** Fresh capability tokens for a Run this connection holds, while its grant stands. */
  z.strictObject({
    ...fencedMessageBase,
    requestId: RunnerAuxiliaryRequestIdSchema,
    runId: RunIdSchema,
    type: z.literal("runner.grants.refresh"),
  }),
  z.strictObject({
    ...fencedMessageBase,
    type: z.literal("runner.command-accepted"),
    commandId: CommandIdSchema,
    correlationId: CorrelationIdSchema,
    workspacePath: z.string().min(1).max(4_096).optional(),
  }),
  z.strictObject({
    ...fencedMessageBase,
    type: z.literal("runner.command-rejected"),
    commandId: CommandIdSchema,
    correlationId: CorrelationIdSchema,
    error: ProtocolErrorSchema,
  }),
  z.strictObject({
    ...fencedMessageBase,
    type: z.literal("runner.command-uncertain"),
    commandId: CommandIdSchema,
    correlationId: CorrelationIdSchema,
    message: z.string().min(1).max(2_000),
  }),
  z.strictObject({
    ...fencedMessageBase,
    type: z.literal("runner.event"),
    event: PendingAgentEventSchema,
  }),
  /**
   * What a Run's streams are saying before they complete. Live progress is
   * never durable and never acknowledged: a frame that is lost costs a reader
   * some streaming text, which the completing durable event replaces.
   */
  z.strictObject({
    ...fencedMessageBase,
    bindingGeneration: z.number().int().positive(),
    environmentId: EnvironmentIdSchema,
    progress: LiveRunProgressSchema,
    type: z.literal("runner.live"),
  }),
  /**
   * The name a Run's engine gave its Thread, answering the Run's
   * `titleRequest`. Like live progress it is never durable or acknowledged: a
   * lost one leaves the Thread's first-line title, and its next Run asks again.
   */
  z.strictObject({
    ...fencedMessageBase,
    bindingGeneration: z.number().int().positive(),
    environmentId: EnvironmentIdSchema,
    runId: RunIdSchema,
    threadId: ThreadIdSchema,
    /**
     * The symbol, only when the request asked with `icon`: one of
     * `taskSymbolNames`, or `defaultTaskSymbol` when nothing fits. The Runner
     * sends at least one of `title` and `icon`; a request whose title was
     * already settled may be answered with `icon` alone.
     */
    icon: WorkspaceIconNameSchema.optional(),
    title: GeneratedThreadTitleSchema.optional(),
    type: z.literal("runner.thread-title"),
    workspaceId: WorkspaceIdSchema,
  }),
  z.strictObject({
    ...fencedMessageBase,
    environmentId: EnvironmentIdSchema,
    executionGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    output: TriggerExecutionOutputSchema,
    type: z.literal("runner.trigger-result"),
  }),
  z.strictObject({
    ...fencedMessageBase,
    activationId: TriggerWatchActivationIdSchema,
    executionGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    healthySince: IsoDateTimeSchema.nullable(),
    lastError: z.string().max(20_000).nullable(),
    lastExitCode: z.number().int().nullable(),
    observed: z.enum(["starting", "running", "backoff", "expired", "stopped"]),
    restartCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    stderrTail: watchLogTailSchema,
    stdoutTail: watchLogTailSchema,
    type: z.literal("runner.watch-status"),
  }),
  z.strictObject({
    ...fencedMessageBase,
    type: z.literal("runner.session-bound"),
    bindingGeneration: z.number().int().positive(),
    /** Whether the engine was already running for the Thread; older Runners leave it out. */
    engineStart: z.enum(["cold", "warm"]).optional(),
    harnessInstanceId: HarnessInstanceIdSchema,
    providerSessionId: ProviderSessionIdSchema,
    providerSessionReference: z.string().min(1).max(2_048),
    runId: RunIdSchema,
    threadId: ThreadIdSchema,
  }),
  z.strictObject({
    ...fencedMessageBase,
    harnessInstanceId: HarnessInstanceIdSchema,
    type: z.literal("runner.harness-catalog-invalidated"),
  }),
  /**
   * Every Run this Runner holds — executing, or ended with events the Host has
   * not acknowledged — sent once on each new connection before any other work.
   * It is complete by construction: a Run it omits is one this Runner does not
   * hold, and the Host settles it accordingly.
   */
  z.strictObject({
    ...fencedMessageBase,
    complete: z.literal(true),
    executions: z
      .array(
        z.strictObject({
          bindingGeneration: z.number().int().positive(),
          environmentId: EnvironmentIdSchema,
          nextOrdinal: z.number().int().nonnegative(),
          runId: RunIdSchema,
          terminal: z.boolean(),
          threadId: ThreadIdSchema,
          workspaceId: WorkspaceIdSchema,
        }),
      )
      .max(1_000),
    type: z.literal("runner.executions.attach"),
  }),
  z.strictObject({
    ...fencedMessageBase,
    catalogs: z.array(HarnessInstanceCatalogSchema).max(maxHarnessInstancesPerEnvironment),
    requestId: CorrelationIdSchema,
    type: z.literal("runner.harness-catalog"),
  }),
  z.strictObject({
    ...fencedMessageBase,
    driverKind: HarnessIdSchema,
    harnessInstanceId: HarnessInstanceIdSchema,
    requestId: CorrelationIdSchema,
    state: HarnessAuthenticationStateSchema,
    type: z.literal("runner.harness-authentication"),
  }),
  z.strictObject({
    ...fencedMessageBase,
    /** Why the Runner could not look at all; `servers` is then empty. */
    error: z.string().trim().min(1).max(500).optional(),
    requestId: CorrelationIdSchema,
    servers: z.array(ModelServerSchema).max(maxModelServers),
    type: z.literal("runner.model-servers"),
  }),
]);
export type RunnerOperationalMessage = z.infer<typeof RunnerOperationalMessageSchema>;

/**
 * What a Runner's own code produces, before the transport stamps the fence.
 *
 * Only the socket knows which connection it is: threading the fence through
 * every place that reports an event would give a hundred call sites the chance
 * to stamp a stale one.
 */
export type RunnerOperationalReport = DistributiveOmit<
  RunnerOperationalMessage,
  keyof RunnerConnectionFence
>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type RunnerCommandAccepted = Extract<
  RunnerOperationalMessage,
  { readonly type: "runner.command-accepted" }
>;

export const RunnerToHostMessageSchema = z.discriminatedUnion("type", [
  RunnerAuthenticateSchema,
  RunnerEnrollSchema,
  ...RunnerOperationalMessageSchema.options,
]);
export type RunnerToHostMessage = z.infer<typeof RunnerToHostMessageSchema>;

export const HostToRunnerMessageSchema = z.discriminatedUnion("type", [
  RunnerChallengeSchema,
  ...HostWorkspaceLocalRequestSchema.options,
  z.strictObject({
    ...fencedMessageBase,
    /**
     * What this enrollment may ever advertise. The Runner is told so a module
     * it cannot use fails at start-up rather than at the first routed request.
     */
    allowedModules: z.array(RunnerModuleNameSchema).min(1).max(5),
    connectionLeaseExpiresAt: IsoDateTimeSchema,
    environmentIds: z.array(EnvironmentIdSchema).max(100),
    heartbeatIntervalMs: z.number().int().min(1_000).max(300_000),
    serverTime: IsoDateTimeSchema,
    type: z.literal("host.welcome"),
  }),
  z.strictObject({
    ...fencedMessageBase,
    connectionLeaseExpiresAt: IsoDateTimeSchema,
    type: z.literal("host.connection.lease-renewed"),
  }),
  z.strictObject({
    ...fencedMessageBase,
    expiresAt: IsoDateTimeSchema,
    module: RunnerAuxiliaryModuleSchema,
    requestId: RunnerAuxiliaryRequestIdSchema,
    ticket: RunnerAuxiliaryTicketSchema,
    type: z.literal("host.auxiliary.ticket"),
  }),
  /**
   * The answer to `runner.grants.refresh`. `refused` is final: the Run's grant
   * has ended. `unavailable` says only that the Host could not decide now, so
   * the Runner keeps its tokens and asks again.
   */
  z.strictObject({
    ...fencedMessageBase,
    requestId: RunnerAuxiliaryRequestIdSchema,
    result: z.discriminatedUnion("status", [
      z.strictObject({
        credentials: z.strictObject({
          agentControl: capabilityTokenSchema,
          attachments: capabilityTokenSchema.optional(),
          integrationSkills: capabilityTokenSchema,
          integrationTools: capabilityTokenSchema,
        }),
        status: z.literal("issued"),
      }),
      z.strictObject({ status: z.literal("refused") }),
      z.strictObject({ status: z.literal("unavailable") }),
    ]),
    runId: RunIdSchema,
    type: z.literal("host.grants.credentials"),
  }),
  z.strictObject({
    ...fencedMessageBase,
    type: z.literal("host.command"),
    command: RunnerCommandSchema,
  }),
  /**
   * The Host's answer to `runner.executions.attach`, one result per Run. An
   * attached Run continues on this connection from `nextOrdinal`, the first
   * event the Host has not committed, and states an unacknowledged session
   * binding again, which the Host records idempotently; a revoked Run is
   * stopped and forgotten.
   */
  z.strictObject({
    ...fencedMessageBase,
    leaseMs: executionLeaseMsSchema,
    results: z
      .array(
        z.discriminatedUnion("status", [
          z.strictObject({
            nextOrdinal: z.number().int().nonnegative(),
            runId: RunIdSchema,
            status: z.literal("attached"),
          }),
          z.strictObject({
            reason: z.string().trim().min(1).max(500),
            runId: RunIdSchema,
            status: z.literal("revoked"),
          }),
        ]),
      )
      .max(1_000),
    type: z.literal("host.executions.attached"),
  }),
  /**
   * Events the Host has committed, per Run: every ordinal through
   * `throughOrdinal`, and the session binding when `sessionBound`. The Runner
   * stops holding them for replay.
   */
  z.strictObject({
    ...fencedMessageBase,
    acks: z
      .array(
        z.strictObject({
          runId: RunIdSchema,
          sessionBound: z.boolean(),
          throughOrdinal: z.number().int().min(-1),
        }),
      )
      .min(1)
      .max(1_000),
    type: z.literal("host.events.acked"),
  }),
  /**
   * The Host renewed these Runs' leases for `leaseMs` from the heartbeat sent
   * at `heartbeatSentAt`, after the renewal was durable.
   */
  z.strictObject({
    ...fencedMessageBase,
    heartbeatSentAt: IsoDateTimeSchema,
    leaseMs: executionLeaseMsSchema,
    runIds: z.array(RunIdSchema).max(1_000),
    type: z.literal("host.executions.renewed"),
  }),
  /**
   * The Host has ended these Runs without them. The Runner stops each one and
   * sends nothing more for it: its outcome is already durable on the Host.
   */
  z.strictObject({
    ...fencedMessageBase,
    revocations: z
      .array(
        z.strictObject({
          reason: z.string().trim().min(1).max(500),
          runId: RunIdSchema,
        }),
      )
      .min(1)
      .max(1_000),
    type: z.literal("host.runs.revoked"),
  }),
  // Two separate messages rather than one with an `authoritative` flag: a
  // reconcile carries the environment's *complete* desired profile set and the
  // Runner closes everything absent from it, while an inspection is a read of
  // whichever subset the caller happened to care about. A boolean between them
  // meant one dropped element of a partial list silently became a removal.
  z.strictObject({
    ...fencedMessageBase,
    harnesses: z.array(HarnessInspectionDefinitionSchema).max(maxHarnessInstancesPerEnvironment),
    requestId: CorrelationIdSchema,
    type: z.literal("host.reconcile-harnesses"),
  }),
  z.strictObject({
    ...fencedMessageBase,
    harnesses: z.array(HarnessInspectionDefinitionSchema).max(maxHarnessInstancesPerEnvironment),
    requestId: CorrelationIdSchema,
    type: z.literal("host.inspect-harnesses"),
  }),
  z.strictObject({
    ...fencedMessageBase,
    request: z.discriminatedUnion("action", [
      z.strictObject({
        action: z.literal("start"),
        connectionSlot: HarnessConnectionSlotSchema.optional(),
        harness: HarnessInspectionDefinitionSchema,
        methodId: HarnessSetupMethodIdSchema,
      }),
      z.strictObject({
        action: z.literal("submit"),
        driverKind: HarnessIdSchema,
        harnessInstanceId: HarnessInstanceIdSchema,
        value: z.string().min(1).max(16_384),
      }),
      z.strictObject({
        action: z.literal("logout"),
        connectionSlot: HarnessConnectionSlotSchema.optional(),
        harness: HarnessInspectionDefinitionSchema,
      }),
      z.strictObject({
        action: z.literal("remove"),
        harness: HarnessInspectionDefinitionSchema,
      }),
      z.strictObject({
        action: z.enum(["cancel", "read"]),
        driverKind: HarnessIdSchema,
        harnessInstanceId: HarnessInstanceIdSchema,
      }),
    ]),
    requestId: CorrelationIdSchema,
    type: z.literal("host.harness-authentication"),
  }),
  z.strictObject({
    ...fencedMessageBase,
    /**
     * The one server the person typed; absent, the Runner looks for the
     * servers installed on its own computer.
     */
    address: z.string().trim().min(1).max(2_048).optional(),
    requestId: CorrelationIdSchema,
    type: z.literal("host.discover-model-servers"),
  }),
  z.strictObject({
    type: z.literal("host.error"),
    error: ProtocolErrorSchema,
  }),
]);
export type HostToRunnerMessage = z.infer<typeof HostToRunnerMessageSchema>;
