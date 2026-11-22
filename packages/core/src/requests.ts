import {
  DeviceIdSchema,
  isPhoneDisplayDefinitionId,
  PhoneDisplayDefinitionIdSchema,
} from "./devices.js";
import { z } from "zod";
import { AgentOperationTargetViewSchema } from "./agent-sessions.js";
import { BrowserSiteSchema } from "./browser-sources.js";
import { ComputerAppIdentitySchema } from "./computer-app.js";
import {
  AgentOperationIdSchema,
  AgentSessionIdSchema,
  AssignmentIdSchema,
  BrowserProfileIdSchema,
  BrowserSurfaceIdSchema,
  ExecutionNodeIdSchema,
  RequestIdSchema,
  RunIdSchema,
  RunnerIdSchema,
  ThreadIdSchema,
  TriggerOccurrenceIdSchema,
  TriggerWatchActivationIdSchema,
  UserIdSchema,
  type UserId,
  type ExecutionNodeId,
} from "./ids.js";
import { causalChainMaxDelegations, IsoDateTimeSchema } from "./models.js";

const RequestIdentifierSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.includes("\0"), "Request identifiers cannot contain a null byte");

export const RequestKindSchema = z.enum([
  "harness.approval",
  "harness.input",
  "browser.access",
  // Historical payloads/events only; the Host refuses new writes.
  "browser.sign-in",
  "browser.password-sign-in",
  "integration.access",
  "machine.full-disk-access",
  "device.access",
  "computer.app.access",
  "plugin.account",
  "plugin.approval",
  "plugin.input",
  "person.question",
]);
type RequestKind = z.infer<typeof RequestKindSchema>;

export const RequestModeSchema = z.enum(["live", "durable"]);

/** How long the Host keeps a tool call open for a person, on an engine qualified for it. */
export const requestHoldLimitMs = 10 * 60_000;
/** The hold on every other engine: inside Cursor's fixed 60 second MCP call limit. */
export const shortRequestHoldMs = 45_000;
/** A qualified engine's MCP tool timeout: the hold, plus the tool's own working time. */
export const heldToolCallTimeoutMs = requestHoldLimitMs + 120_000;

type RequestMode = z.infer<typeof RequestModeSchema>;

export const RequestStatusSchema = z.enum([
  "pending",
  "fulfilled",
  "declined",
  "withdrawn",
  "cancelled",
]);

export const RequestCancellationReasonSchema = z.enum([
  "run-ended",
  "process-lost",
  "source-closed",
  // Shared Done puts a task away using the reason released readers know.
  "thread-archived",
  "task-deleted",
  "resource-deleted",
  "authority-revoked",
  "plugin-interrupted",
  "plugin-expired",
]);
export type RequestCancellationReason = z.infer<typeof RequestCancellationReasonSchema>;

export const RequestRequiredActorSchema = z.enum(["requester", "owner"]);
export type RequestRequiredActor = z.infer<typeof RequestRequiredActorSchema>;

export const RequestOptionHintSchema = z.enum([
  "allow-once",
  "allow-for-run",
  "reject-once",
  "confirm",
  "cancel",
  "other",
]);

/** The longest a Request's title may be, in UTF-16 units. */
export const requestTitleMaxLength = 240;
/** The longest a Request's detail or a form field's prompt may be, in UTF-16 units. */
export const requestTextMaxLength = 20_000;
export const requestOperationContextMaxLength = 1_024;
export const requestOperationCallsHeading = "\n\nWhat it will run:\n";
export const requestOperationCallsMaxLength =
  requestTextMaxLength - requestOperationContextMaxLength - requestOperationCallsHeading.length;

export function formatRequestOperationDetail(input: {
  readonly summary: string;
  readonly titleLine: string;
  readonly calls: string;
  readonly reason: string;
}): string {
  const summary = input.summary.slice(0, requestOperationContextMaxLength - input.titleLine.length);
  const detail = `${summary}${input.titleLine}${requestOperationCallsHeading}${input.calls}`;
  return detail + input.reason.slice(0, Math.max(0, requestTextMaxLength - detail.length));
}

/** The longest an option's or a form field's label may be, in UTF-16 units. */
export const requestLabelMaxLength = 160;
/** The longest an option's description, or a form choice's text, may be, in UTF-16 units. */
export const requestChoiceTextMaxLength = 2_000;

const requestOptionShape = {
  description: z.string().trim().min(1).max(requestChoiceTextMaxLength).optional(),
  hint: RequestOptionHintSchema,
  id: RequestIdentifierSchema,
  label: z.string().trim().min(1).max(requestLabelMaxLength),
} as const;
export const RequestOptionSchema = z.strictObject(requestOptionShape);
const RequestOptionViewSchema = z.object(requestOptionShape);
export type RequestOption = z.infer<typeof RequestOptionSchema>;

/** Choosing an option that rejects or cancels declines its Request; any other fulfils it. */
export function requestOptionDeclines(option: Pick<RequestOption, "hint">): boolean {
  return option.hint === "reject-once" || option.hint === "cancel";
}

const requestFormChoiceShape = {
  description: z.string().max(requestChoiceTextMaxLength).optional(),
  label: z.string().min(1).max(requestChoiceTextMaxLength),
  value: z.string().min(1).max(requestChoiceTextMaxLength),
} as const;
export const RequestFormChoiceSchema = z.strictObject(requestFormChoiceShape);
const RequestFormChoiceViewSchema = z.object(requestFormChoiceShape);

const requestFormFieldShape = {
  choices: z.array(RequestFormChoiceSchema).max(100).optional(),
  /**
   * The person may type their own answer instead of choosing. A field without
   * choices is always typed, so this only changes one that offers them.
   */
  custom: z.boolean().default(false),
  id: RequestIdentifierSchema,
  label: z.string().trim().min(1).max(requestLabelMaxLength).optional(),
  multiSelect: z.boolean().default(false),
  prompt: z.string().max(requestTextMaxLength),
  secret: z.boolean().default(false),
} as const;
export const RequestFormFieldSchema = z.strictObject(requestFormFieldShape);
const RequestFormFieldViewSchema = z.object({
  ...requestFormFieldShape,
  choices: z.array(RequestFormChoiceViewSchema).max(100).optional(),
});
export type RequestFormField = z.infer<typeof RequestFormFieldSchema>;

export const RequestFormAnswersSchema = z.record(
  RequestIdentifierSchema,
  z.array(z.string().max(100_000)).max(100),
);
export type RequestFormAnswers = z.infer<typeof RequestFormAnswersSchema>;

/**
 * Why one field's answer would be refused, or null when it fits. A typed
 * answer stands alone: it replaces the choices rather than joining them.
 */
export function requestFieldAnswerProblem(
  field: Pick<RequestFormField, "choices" | "custom" | "multiSelect">,
  values: readonly string[],
): string | null {
  if (values.length === 0) return "is not answered";
  const offered = field.choices?.map((choice) => choice.value);
  const typed = offered === undefined || values.some((value) => !offered.includes(value));
  if (typed) {
    if (offered !== undefined && !field.custom) return "is not one of the offered choices";
    return values.length === 1 && values[0]!.trim() !== "" ? null : "needs one typed answer";
  }
  if (!field.multiSelect && values.length !== 1) return "takes exactly one choice";
  return new Set(values).size === values.length ? null : "repeats a choice";
}

/** Why answers don't fit a form's fields, or null when every field has exactly its answer. */
export function requestFormAnswersProblem(
  fields: readonly RequestFormField[],
  answers: RequestFormAnswers,
): string | null {
  const ids = new Set(fields.map(({ id }) => id));
  const extra = Object.keys(answers).find((id) => !ids.has(id));
  if (extra !== undefined) return `${extra} is not one of its questions`;
  for (const field of fields) {
    const problem = requestFieldAnswerProblem(
      field,
      Object.hasOwn(answers, field.id) ? answers[field.id]! : [],
    );
    if (problem !== null) return `${field.label ?? field.prompt} ${problem}`;
  }
  return null;
}

/**
 * Set when the title names something an agent proposed, such as a plugin it
 * wrote, rather than something Opensteer vouches for. The title stays
 * the plain name and every surface shows the provenance beside it, so a name
 * like `Gmail — approved by your administrator` never reads as Opensteer's own
 * words.
 */
const RequestAgentProposedSchema = z.literal(true).optional();

export const PluginRequestContextSchema = z.strictObject({
  id: RequestIdentifierSchema,
  name: z.string().min(1).max(240),
  author: z.enum(["catalog", "agent"]),
});
export const PluginAccountConsentSchema = z.strictObject({
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  sites: z.array(z.string().max(2048)).max(100),
  credential: z.enum(["sealed", "value"]),
});
const pluginPresentation = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("account"),
    requirement: RequestIdentifierSchema,
    scope: z.enum(["app", "user"]),
    consent: PluginAccountConsentSchema,
  }),
  z.strictObject({
    kind: z.literal("approval"),
    executionId: RequestIdentifierSchema,
    tool: RequestIdentifierSchema,
    arguments: z.json(),
  }),
  z.strictObject({
    kind: z.literal("input"),
    executionId: RequestIdentifierSchema,
    tool: RequestIdentifierSchema,
    schema: z.record(z.string(), z.json()),
  }),
]);
const pluginContext = z.strictObject({
  plugin: PluginRequestContextSchema,
  decision: pluginPresentation,
});
const PluginAccountConsentViewSchema = z.object(PluginAccountConsentSchema.shape);
const pluginContextView = z
  .object({
    plugin: z.object(PluginRequestContextSchema.shape),
    decision: z.discriminatedUnion("kind", [
      z.object({
        ...pluginPresentation.options[0].shape,
        consent: PluginAccountConsentViewSchema,
      }),
      z.object(pluginPresentation.options[1].shape),
      z.object(pluginPresentation.options[2].shape),
    ]),
  })
  .optional();

const requestPresentationVariants = [
  z.strictObject({
    agentProposed: RequestAgentProposedSchema,
    plugin: pluginContext.optional(),
    detail: z.string().max(requestTextMaxLength).optional(),
    kind: z.literal("choice"),
    options: z.array(RequestOptionSchema).min(1).max(32),
    risk: z.enum(["low", "medium", "high"]).optional(),
    title: z.string().trim().min(1).max(requestTitleMaxLength),
  }),
  z.strictObject({
    agentProposed: RequestAgentProposedSchema,
    plugin: pluginContext.optional(),
    detail: z.string().max(requestTextMaxLength).optional(),
    detailFormat: z.enum(["plain"]).optional(),
    fields: z.array(RequestFormFieldSchema).min(1).max(16),
    kind: z.literal("form"),
    title: z.string().trim().min(1).max(requestTitleMaxLength),
  }),
  z.strictObject({
    agentProposed: RequestAgentProposedSchema,
    plugin: pluginContext.optional(),
    detail: z.string().max(requestTextMaxLength).optional(),
    kind: z.literal("external"),
    subject: z.strictObject({
      id: RequestIdentifierSchema,
      kind: RequestIdentifierSchema,
    }),
    title: z.string().trim().min(1).max(requestTitleMaxLength),
  }),
] as const;
export const RequestPresentationSchema = z.discriminatedUnion("kind", requestPresentationVariants);
const RequestPresentationViewSchema = z.discriminatedUnion("kind", [
  z.object({
    ...requestPresentationVariants[0].shape,
    plugin: pluginContextView,
    options: z.array(RequestOptionViewSchema).min(1).max(32),
  }),
  z.object({
    ...requestPresentationVariants[1].shape,
    plugin: pluginContextView,
    fields: z.array(RequestFormFieldViewSchema).min(1).max(16),
  }),
  z.object({
    ...requestPresentationVariants[2].shape,
    plugin: pluginContextView,
    subject: z.object(requestPresentationVariants[2].shape.subject.shape),
  }),
]);
export type RequestPresentation = z.infer<typeof RequestPresentationSchema>;

/**
 * What a surface shows beside the title of a Request whose subject an agent
 * proposed.
 */
export const requestAgentProposedLabel = "Proposed by an agent";

/**
 * What the label means, for its tooltip.
 */
export const requestAgentProposedDetail =
  "An agent proposed this integration; it isn’t part of Opensteer’s reviewed catalog.";

/**
 * A name an agent may have chosen, as one line of plain text, for a place with
 * no room for the label beside it: a native select option, a notification, a
 * tooltip, a status line, a screen reader.
 */
export function agentProposedText(name: string, agentProposed: boolean): string {
  return agentProposed ? `${name} · ${requestAgentProposedLabel}` : name;
}

/** A Request's title as one line of plain text. */
export function requestTitleText(presentation: {
  readonly agentProposed?: true | undefined;
  readonly title: string;
}): string {
  return agentProposedText(presentation.title, presentation.agentProposed === true);
}

export const requestJsonMaxSerializedBytes = 256 * 1_024;

export const RequestJsonObjectSchema = z.record(z.string(), z.json()).refine((value) => {
  try {
    return (
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= requestJsonMaxSerializedBytes
    );
  } catch {
    return false;
  }
}, `Request JSON must not exceed ${requestJsonMaxSerializedBytes} serialized bytes`);

const requestResponseVariants = [
  z.strictObject({
    kind: z.literal("choice"),
    optionId: RequestIdentifierSchema,
    text: z.string().max(20_000).optional(),
  }),
  z.strictObject({
    answers: RequestFormAnswersSchema,
    kind: z.literal("form"),
  }),
  z.strictObject({
    kind: z.literal("external"),
    value: RequestJsonObjectSchema.optional(),
  }),
] as const;
export const RequestResponseSchema = z.discriminatedUnion("kind", requestResponseVariants);
const RequestResponseViewSchema = z.discriminatedUnion("kind", [
  z.object(requestResponseVariants[0].shape),
  z.object(requestResponseVariants[1].shape),
  z.object(requestResponseVariants[2].shape),
]);
export type RequestResponse = z.infer<typeof RequestResponseSchema>;

export const BrowserRequestOutcomeSchema = z.object({
  profile: z.strictObject({
    id: BrowserProfileIdSchema,
    name: z.string().min(1).max(120),
  }),
});

const browserAccessSuggestionVariants = [
  z.strictObject({ kind: z.literal("existing"), profileId: BrowserProfileIdSchema }),
  z.strictObject({
    kind: z.literal("new"),
    suggestedName: z.string().trim().min(1).max(120).optional(),
  }),
  z.strictObject({ kind: z.literal("user_choice") }),
] as const;
export const BrowserAccessSuggestionSchema = z.discriminatedUnion(
  "kind",
  browserAccessSuggestionVariants,
);
const BrowserAccessSuggestionViewSchema = z.discriminatedUnion("kind", [
  z.object(browserAccessSuggestionVariants[0].shape),
  z.object(browserAccessSuggestionVariants[1].shape),
  z.object(browserAccessSuggestionVariants[2].shape),
]);
export type BrowserAccessSuggestion = z.infer<typeof BrowserAccessSuggestionSchema>;

const IntegrationIdentifierSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !value.includes("\0"), "Integration identifiers cannot contain a null byte");

const computerAppIdentityShape = {
  ...ComputerAppIdentitySchema.shape,
  displayName: z.string().trim().min(1).max(255),
} as const;

/**
 * The longest reason any Request carries. A computer-app request may become an
 * ordinary `integration.access` grant request, so every kind shares one bound.
 */
export const requestReasonMaxLength = 4_000;
const RequestReasonSchema = z.string().trim().min(1).max(requestReasonMaxLength);

const requestPayloadVariants = [
  z.strictObject({ kind: z.literal("harness.approval") }),
  z.strictObject({ kind: z.literal("harness.input") }),
  z.strictObject({
    kind: z.literal("browser.access"),
    reason: RequestReasonSchema,
    suggestion: BrowserAccessSuggestionSchema,
  }),
  z.strictObject({
    access: z.enum(["read", "read-write"]),
    installationId: IntegrationIdentifierSchema.nullable(),
    kind: z.literal("integration.access"),
    manifest: RequestJsonObjectSchema.nullable(),
    reason: RequestReasonSchema,
    requestedConnectionId: IntegrationIdentifierSchema.nullable(),
    requestedServerId: IntegrationIdentifierSchema.nullable(),
  }),
  /**
   * An agent needs macOS Full Disk Access on one lent Mac. The machine's name
   * is copied in at creation so the card and the continuation read the name the
   * person knows, even after the computer is renamed or removed. It resolves
   * from the machine's own report of the grant, never from a tap: nobody can
   * mark it fulfilled from a phone, only decline it.
   */
  z.strictObject({
    kind: z.literal("machine.full-disk-access"),
    machineId: DeviceIdSchema,
    machineName: z.string().trim().min(1).max(160),
    reason: RequestReasonSchema,
  }),
  z.strictObject({
    kind: z.literal("browser.sign-in"),
    tabId: BrowserSurfaceIdSchema.optional(),
    reason: RequestReasonSchema,
    sessionId: z.string().min(1).max(128),
    site: BrowserSiteSchema,
  }),
  /**
   * An agent wants to see and operate one app on one Mac, or the whole screen
   * of one Android phone. A Mac app's identity is copied in at creation — the
   * bundle identifier, the signing team, and the display name the helper
   * resolved — so the card, the approval panel on that Mac and the
   * continuation all name the app the person was asked about, even after it is
   * renamed; a phone has no app, because its connection is the display. It
   * pairs with a `computer_app_setup_requests` row, named here so declining
   * either declines both, and it resolves only from that row being consumed on
   * the Mac itself for app access. Phone access may be approved by the owner
   * from any connected client.
   */

  z.strictObject({
    /** The approving Runner and its computer name when the Request was opened. */
    computerName: z.string().trim().min(1).max(160),
    expiresAt: IsoDateTimeSchema,
    kind: z.literal("browser.password-sign-in"),
    credential: z.literal("card").optional(),

    operationId: z.uuid(),
    reason: RequestReasonSchema,
    runnerId: RunnerIdSchema,
    scope: z.literal("personal"),
    permissionVersion: z.literal(6),
    site: BrowserSiteSchema,
  }),
  z
    .strictObject({
      access: z.enum(["read", "read-write"]),
      app: z.strictObject(computerAppIdentityShape).nullable(),
      definitionId: z.union([z.literal("macos-app"), PhoneDisplayDefinitionIdSchema]),
      kind: z.literal("computer.app.access"),
      reason: RequestReasonSchema,
      deviceId: DeviceIdSchema,
      setupRequestId: z.uuid(),
    })
    .superRefine((payload, context) => {
      if ((payload.app === null) !== isPhoneDisplayDefinitionId(payload.definitionId)) {
        context.addIssue({
          code: "custom",
          message: "A Mac app access request names its app; a phone access request names none",
          path: ["app"],
        });
      }
    }),
  z.strictObject({
    kind: z.literal("device.access"),
    machineId: DeviceIdSchema,
    machineName: z.string().trim().min(1).max(160),
    access: z.enum(["browser", "apps", "files"]),
    reason: RequestReasonSchema,
  }),
  /**
   * An agent asked the person something with `ask_person`. Its questions are
   * the form's fields; the answer wakes the task that asked, however late.
   */
  z.strictObject({ kind: z.literal("person.question") }),
  z.strictObject({
    kind: z.literal("plugin.account"),
    plugin: RequestIdentifierSchema,
    requirement: RequestIdentifierSchema,
    scope: z.enum(["app", "user"]),
    consent: PluginAccountConsentSchema,
  }),
  z.strictObject({
    kind: z.literal("plugin.approval"),
    executionId: RequestIdentifierSchema,
    interactionId: RequestIdentifierSchema,
  }),
  z.strictObject({
    kind: z.literal("plugin.input"),
    executionId: RequestIdentifierSchema,
    interactionId: RequestIdentifierSchema,
  }),
] as const;
const canonicalRequestPayloadSchema = z.discriminatedUnion("kind", requestPayloadVariants);
export const LegacyComputerAppAccessPayloadSchema = z
  .strictObject({ ...requestPayloadVariants[7].shape, runnerId: RunnerIdSchema })
  .omit({ deviceId: true });
function normalizeLegacyComputerAccess(value: unknown) {
  const legacy = LegacyComputerAppAccessPayloadSchema.safeParse(value);
  if (!legacy.success) return value;
  const { runnerId, ...payload } = legacy.data;
  return { ...payload, deviceId: DeviceIdSchema.parse(runnerId) };
}
export const RequestPayloadSchema = z.preprocess(
  normalizeLegacyComputerAccess,
  canonicalRequestPayloadSchema,
);
const canonicalRequestPayloadViewSchema = z.discriminatedUnion("kind", [
  z.object(requestPayloadVariants[0].shape),
  z.object(requestPayloadVariants[1].shape),
  z.object({
    ...requestPayloadVariants[2].shape,
    suggestion: BrowserAccessSuggestionViewSchema,
  }),
  z.object(requestPayloadVariants[3].shape),
  z.object(requestPayloadVariants[4].shape),
  z.object(requestPayloadVariants[5].shape),
  z.object(requestPayloadVariants[6].shape),
  z.object({
    ...requestPayloadVariants[7].shape,
    app: z.object(computerAppIdentityShape).nullable(),
  }),
  z.object(requestPayloadVariants[8].shape),
  z.object(requestPayloadVariants[9].shape),
  z.object({
    ...requestPayloadVariants[10].shape,
    consent: PluginAccountConsentViewSchema,
  }),
  z.object(requestPayloadVariants[11].shape),
  z.object(requestPayloadVariants[12].shape),
]);
const RequestPayloadViewSchema = z.preprocess(
  normalizeLegacyComputerAccess,
  canonicalRequestPayloadViewSchema,
);
export type RequestPayload = z.infer<typeof RequestPayloadSchema>;

export const RequestSettlementProvenanceSchema = z.strictObject({
  sessionId: z.string().min(1).max(256),
  deviceLabel: z.string().min(1).max(200),
});
export type RequestSettlementProvenance = z.infer<typeof RequestSettlementProvenanceSchema>;

export const RequestAgentAnswererSchema = z.strictObject({
  kind: z.literal("agent"),
  runId: RunIdSchema,
  threadId: ThreadIdSchema,
  title: z.string().min(1).max(240),
});

export const RequestAnswererViewSchema = z.union([
  z.object({ deviceLabel: RequestSettlementProvenanceSchema.shape.deviceLabel }),
  z.object(RequestAgentAnswererSchema.shape),
]);

/**
 * A Home command an agent proposed, in its parts: what changes in the Home's own words, what it
 * gives to whom when it widens something, the command as proposed (never a value only the person
 * types), who proposed it, and the agent's own reason, kept apart. A client that knows it shows
 * the change and the screen that performs it; one that does not shows the Request's form.
 */
export const commandRequestOutcomeSchema = z.discriminatedUnion("status", [
  /** The person approved it and it is running. */
  z.object({ status: z.literal("running") }),
  z.object({ status: z.literal("done"), result: z.json().optional() }),
  /** It was refused before anything happened. */
  z.object({
    status: z.literal("failed"),
    code: z.string().max(100),
    message: z.string().max(2_000),
  }),
  /** It may have happened; the Home does not know and never runs it again. */
  z.object({ status: z.literal("unknown") }),
]);
export const CommandRequestPartSchema = z.object({
  type: z.string().min(1).max(100),
  family: z.string().min(1).max(40),
  /** The class of the face the person is asked about (`widen-other`, `approve`, …). */
  face: z.string().min(1).max(40),
  /** The change, in the Home's words: who proposes what. */
  summary: z.string().min(1).max(requestTitleMaxLength),
  /** What it gives to whom, when it widens something; null when it does not. */
  gives: z.string().max(1_000).nullable(),
  /** The command as proposed, without its key and without anything only the person types. */
  command: RequestJsonObjectSchema,
  /** Input paths the person types on the card before approving. */
  secretPaths: z.array(z.string().min(1).max(200)).max(8),
  governs: z.object({
    kind: z.string().min(1).max(40),
    id: z.string().max(512).nullable(),
    ids: z.array(z.string().max(512)).max(100).optional(),
    task: z.string().max(512).optional(),
    mode: z.string().max(40).optional(),
  }),
  /** One open ask per proposer and thing: the proposer and what is governed, as a digest. */
  askKey: z.string().regex(/^[0-9a-f]{64}$/u),
  /** The arguments as proposed, as a digest: the same ask with other arguments is a conflict. */
  argumentsDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  proposer: z.object({
    kind: z.enum(["run", "program", "connection"]),
    /** The agent as the person knows it: an engine, an automation, a connected agent's label. */
    name: z.string().min(1).max(200),
    taskTitle: z.string().max(240).nullable(),
    key: z.string().min(1).max(300),
  }),
  /** The agent's own words, not checked. */
  agentReason: z.string().max(500).nullable(),
  /** The screen that performs it, filled in; null where only this card can. */
  editor: z.object({ screen: z.string().min(1).max(60) }).nullable(),
  outcome: commandRequestOutcomeSchema.optional(),
  /** It reached the end of its lifetime unanswered. */
  expired: z.boolean().optional(),
});
export type CommandRequestPart = z.infer<typeof CommandRequestPartSchema>;
export type CommandRequestOutcome = z.infer<typeof commandRequestOutcomeSchema>;

const requestBaseShape = {
  settlementProvenance: z
    .union([
      RequestSettlementProvenanceSchema.extend({
        sessionId: RequestSettlementProvenanceSchema.shape.sessionId.optional(),
      }),
      RequestAgentAnswererSchema,
    ])
    .nullable()
    .optional(),
  callId: RequestIdentifierSchema,
  createdAt: IsoDateTimeSchema,
  id: RequestIdSchema,
  kind: RequestKindSchema,
  mode: RequestModeSchema,
  /**
   * A Request originates from exactly one execution: an agent Run, or a Trigger
   * Occurrence, which produces no Run row at all. Both columns are therefore
   * nullable and the pair carries the invariant instead.
   */
  originatingOccurrenceId: TriggerOccurrenceIdSchema.nullable(),
  originatingWatchActivationId: TriggerWatchActivationIdSchema.nullable().optional(),
  /** An external agent's session, for a Request about its direct work. */
  originatingAgentSessionId: AgentSessionIdSchema.nullable().optional(),
  /**
   * A connected agent's direct operation this Request decides, in its parts: the Home's
   * summary, the exact calls and the agent's own reason, kept apart.
   */
  agentOperation: z
    .object({
      operationId: AgentOperationIdSchema,
      connectionId: z.string().min(1).max(255),
      summary: z.string().max(requestTextMaxLength),
      calls: z.string().max(requestTextMaxLength),
      agentReason: z.string().max(2_000).nullable(),
      target: AgentOperationTargetViewSchema,
      /** The form field the person answers it on: `allow` or `deny`. */
      decisionFieldId: RequestIdentifierSchema,
      /** It reached the end of its lifetime unanswered, rather than being no longer needed. */
      expired: z.boolean().optional(),
    })
    .optional(),
  /** A Home command an agent proposed, which the person approves on its screen or declines. */
  command: CommandRequestPartSchema.optional(),
  /** The subagent of the originating Run that asked; absent for the Run's own agent. */
  originatingNodeId: ExecutionNodeIdSchema.optional(),
  originatingRunId: RunIdSchema.nullable(),
  originatingThreadId: ThreadIdSchema,
  payload: RequestPayloadSchema,
  presentation: RequestPresentationSchema,
  requestedBy: UserIdSchema,
  requiredActor: RequestRequiredActorSchema,
} as const;
const requestViewBaseShape = {
  ...requestBaseShape,
  settlementProvenance: RequestAnswererViewSchema.nullable().optional(),
  payload: RequestPayloadViewSchema,
  presentation: RequestPresentationViewSchema,
} as const;

function validateRequestInvariants(
  request: {
    readonly kind: RequestKind;
    readonly mode: RequestMode;
    readonly originatingOccurrenceId: string | null;
    readonly originatingWatchActivationId?: string | null | undefined;
    readonly originatingAgentSessionId?: string | null | undefined;
    readonly originatingRunId: string | null;
    readonly payload: RequestPayload;
    readonly resolvedBy?: UserId | null;
    readonly status?: string;
    readonly settlementProvenance?: unknown;
    readonly originatingNodeId?: ExecutionNodeId | undefined;
    readonly presentation: RequestPresentation;
  },
  context: z.RefinementCtx,
): void {
  if (request.status === "fulfilled" || request.status === "declined") {
    const answerer = RequestAgentAnswererSchema.safeParse(request.settlementProvenance);
    const agent = answerer.success;
    if (
      (request.resolvedBy === null) !== agent ||
      (agent &&
        (!requestIsAgentAnswerable(request) || answerer.data.runId === request.originatingRunId))
    ) {
      context.addIssue({
        code: "custom",
        message: "An agent answer names its Run, never a person",
      });
    }
  }
  if (
    [
      request.originatingRunId,
      request.originatingOccurrenceId,
      request.originatingWatchActivationId,
      request.originatingAgentSessionId,
    ].filter((id) => id != null).length !== 1
  ) {
    context.addIssue({
      code: "custom",
      message:
        "A Request originates from exactly one of a Run, a Trigger Occurrence, a Watch activation or an agent session",
      path: ["originatingRunId"],
    });
  }
  // A live Request is answered back into the process that opened it, and only a
  // Run has one; a Trigger Occurrence can only originate durable Requests.
  if (request.mode === "live" && request.originatingRunId === null) {
    context.addIssue({
      code: "custom",
      message: "A live Request must originate from a Run",
      path: ["originatingRunId"],
    });
  }
  if (request.payload.kind !== request.kind) {
    context.addIssue({
      code: "custom",
      message: "Request payload kind must match the Request kind",
      path: ["payload", "kind"],
    });
  }
  if (
    request.payload.kind === "integration.access" &&
    (request.payload.installationId === null) === (request.payload.manifest === null)
  ) {
    context.addIssue({
      code: "custom",
      message:
        "An access Request targets exactly one installed app or server, or one device app to install",
      path: ["payload", "installationId"],
    });
  }
  const expectedMode = request.kind.startsWith("harness.") ? "live" : "durable";
  if (request.mode !== expectedMode) {
    context.addIssue({
      code: "custom",
      message: `${request.kind} Requests must use ${expectedMode} mode`,
      path: ["mode"],
    });
  }
}

export const PendingRequestSchema = z
  .strictObject({
    ...requestBaseShape,
    cancellationReason: z.null(),
    resolvedAt: z.null(),
    resolvedBy: z.null(),
    response: z.null(),
    status: z.literal("pending"),
  })
  .superRefine(validateRequestInvariants);
export const PendingRequestViewSchema = z
  .object({
    ...requestViewBaseShape,
    cancellationReason: z.null(),
    resolvedAt: z.null(),
    resolvedBy: z.null(),
    response: z.null(),
    status: z.literal("pending"),
  })
  .superRefine(validateRequestInvariants);
export type PendingRequest = z.infer<typeof PendingRequestSchema>;

export const FulfilledRequestSchema = z
  .strictObject({
    ...requestBaseShape,
    cancellationReason: z.null(),
    resolvedAt: IsoDateTimeSchema,
    resolvedBy: UserIdSchema.nullable(),
    response: RequestResponseSchema,
    status: z.literal("fulfilled"),
  })
  .superRefine(validateRequestInvariants);
const FulfilledRequestViewSchema = z
  .object({
    ...requestViewBaseShape,
    cancellationReason: z.null(),
    resolvedAt: IsoDateTimeSchema,
    resolvedBy: UserIdSchema.nullable(),
    response: RequestResponseViewSchema,
    status: z.literal("fulfilled"),
  })
  .superRefine(validateRequestInvariants);

export const DeclinedRequestSchema = z
  .strictObject({
    ...requestBaseShape,
    cancellationReason: z.null(),
    resolvedAt: IsoDateTimeSchema,
    resolvedBy: UserIdSchema.nullable(),
    response: RequestResponseSchema,
    status: z.literal("declined"),
  })
  .superRefine(validateRequestInvariants);
const DeclinedRequestViewSchema = z
  .object({
    ...requestViewBaseShape,
    cancellationReason: z.null(),
    resolvedAt: IsoDateTimeSchema,
    resolvedBy: UserIdSchema.nullable(),
    response: RequestResponseViewSchema,
    status: z.literal("declined"),
  })
  .superRefine(validateRequestInvariants);

export const WithdrawnRequestSchema = z
  .strictObject({
    ...requestBaseShape,
    cancellationReason: z.null(),
    resolvedAt: IsoDateTimeSchema,
    resolvedBy: UserIdSchema,
    response: z.null(),
    status: z.literal("withdrawn"),
  })
  .superRefine(validateRequestInvariants);
const WithdrawnRequestViewSchema = z
  .object({
    ...requestViewBaseShape,
    cancellationReason: z.null(),
    resolvedAt: IsoDateTimeSchema,
    resolvedBy: UserIdSchema,
    response: z.null(),
    status: z.literal("withdrawn"),
  })
  .superRefine(validateRequestInvariants);

export const CancelledRequestSchema = z
  .strictObject({
    ...requestBaseShape,
    cancellationReason: RequestCancellationReasonSchema,
    resolvedAt: IsoDateTimeSchema,
    resolvedBy: z.null(),
    response: z.null(),
    status: z.literal("cancelled"),
  })
  .superRefine(validateRequestInvariants);
const CancelledRequestViewSchema = z
  .object({
    ...requestViewBaseShape,
    cancellationReason: RequestCancellationReasonSchema,
    resolvedAt: IsoDateTimeSchema,
    resolvedBy: z.null(),
    response: z.null(),
    status: z.literal("cancelled"),
  })
  .superRefine(validateRequestInvariants);

export const ResolvedRequestSchema = z.union([
  FulfilledRequestSchema,
  DeclinedRequestSchema,
  WithdrawnRequestSchema,
]);

export const TerminalRequestSchema = z.union([ResolvedRequestSchema, CancelledRequestSchema]);

export const RequestSchema = z.union([PendingRequestSchema, TerminalRequestSchema]);
export const RequestViewSchema = z.union([
  PendingRequestViewSchema,
  FulfilledRequestViewSchema,
  DeclinedRequestViewSchema,
  WithdrawnRequestViewSchema,
  CancelledRequestViewSchema,
]);
export type Request = z.infer<typeof RequestSchema>;

/** One piece of handed-out work a pending Request is holding up. */
export const HeldAssignmentSchema = z.object({
  id: AssignmentIdSchema,
  parentThreadId: ThreadIdSchema,
  workerThread: z.object({
    id: ThreadIdSchema,
    title: z.string().trim().min(1).max(240),
  }),
});
export type HeldAssignment = z.infer<typeof HeldAssignmentSchema>;

const waitingRequestAssignments = z
  .array(HeldAssignmentSchema)
  // Every Assignment above a Run's own was handed out inside the same causal
  // chain, so the chain's delegation budget bounds how far this can reach.
  .max(causalChainMaxDelegations);

/**
 * A pending Request its reader is the one to answer, with the work it holds
 * up: the Assignment whose Run asked it, then each Assignment that handed that
 * work out, innermost first, as far as the reader may see. A Request no
 * Assignment's Run asked holds up nothing handed out.
 */
/** The subagent that asked a Request, as its Run named it. */
const subagentName = z.object({ id: ExecutionNodeIdSchema, title: z.string().min(1).max(240) });
const askingSubagent = subagentName.extend({
  /** The subagent it runs inside, when it is nested. */
  within: subagentName.nullable().optional(),
});

export const WaitingRequestPresentationSchema = z.object({
  threadId: ThreadIdSchema,
  workerThread: z.object({ id: ThreadIdSchema, title: z.string().min(1).max(240) }),
});

export const WaitingRequestSchema = z.object({
  presentation: WaitingRequestPresentationSchema.nullable().optional(),
  assignments: waitingRequestAssignments,
  /** The subagent of the Run that asked, when it was not the Run's own agent. */
  subagent: askingSubagent.nullable().default(null),
  request: PendingRequestSchema,
});
export const WaitingRequestViewSchema = z.object({
  presentation: WaitingRequestPresentationSchema.nullable().optional(),
  assignments: waitingRequestAssignments,
  subagent: askingSubagent.nullable().default(null),
  request: PendingRequestViewSchema,
});
export type WaitingRequest = z.infer<typeof WaitingRequestSchema>;

export function hasSecretRequestFields(request: Pick<Request, "presentation">): boolean {
  return (
    request.presentation.kind === "form" &&
    request.presentation.fields.some((field) => field.secret)
  );
}

export function requestIsAgentAnswerable(
  request: Pick<Request, "kind" | "presentation" | "originatingNodeId">,
): boolean {
  const ordinary: Record<RequestKind, boolean> = {
    "harness.input": true,
    "harness.approval": false,
    "browser.access": false,
    "browser.sign-in": false,
    "browser.password-sign-in": false,
    "integration.access": false,
    "machine.full-disk-access": false,
    "device.access": false,
    "computer.app.access": false,
    "plugin.account": false,
    "plugin.approval": false,
    "plugin.input": false,
    // It asks the person by name; another agent answering would be a guess.
    "person.question": false,
  };
  return ordinary[request.kind] && !request.originatingNodeId && !hasSecretRequestFields(request);
}

/** Durable events may acknowledge a secret field, but never contain its value. */
function validateResolvedRequestEvent(request: Request, context: z.RefinementCtx): void {
  if (request.presentation.kind !== "form" || request.response?.kind !== "form") return;
  const secretFieldIds = new Set(
    request.presentation.fields.filter((field) => field.secret).map((field) => field.id),
  );
  for (const fieldId of secretFieldIds) {
    if ((request.response.answers[fieldId]?.length ?? 0) > 0) {
      context.addIssue({
        code: "custom",
        message: "Request events cannot contain secret answers",
        path: ["response", "answers", fieldId],
      });
    }
  }
}

export const ResolvedRequestEventSchema = ResolvedRequestSchema.superRefine(
  validateResolvedRequestEvent,
);
export const ResolvedRequestEventViewSchema = z
  .union([FulfilledRequestViewSchema, DeclinedRequestViewSchema, WithdrawnRequestViewSchema])
  .superRefine(validateResolvedRequestEvent);

/** One unreadable Request must not hide the rest of a Host response or snapshot. */
export function readableRequestList<T>(schema: z.ZodType<T>, max: number) {
  return z
    .array(z.unknown())
    .max(max)
    .transform((items) =>
      items.flatMap((item) => {
        const result = schema.safeParse(item);
        return result.success ? [result.data] : [];
      }),
    );
}

/** The winning answerer, shared by Request cards and transcript receipts. */
export function requestSettlementLabel(
  request: Pick<Request, "status" | "settlementProvenance">,
): string | null {
  if (!request.settlementProvenance) return null;
  if ("kind" in request.settlementProvenance) {
    return request.status === "fulfilled" || request.status === "declined"
      ? `Answered by ${request.settlementProvenance.title}`
      : null;
  }
  const decision =
    request.status === "fulfilled" ? "Allowed" : request.status === "declined" ? "Declined" : null;
  return decision ? `${decision} on ${request.settlementProvenance.deviceLabel}` : null;
}

export function requestOutcomeText(request: Request): string {
  if (request.status === "pending") return "Pending";
  if (request.status === "cancelled") {
    if (request.cancellationReason === "plugin-interrupted")
      return "Cancelled · Plugin execution was interrupted";
    if (request.cancellationReason === "plugin-expired")
      return "Cancelled · Plugin request expired";
    return `Cancelled · ${request.cancellationReason}`;
  }
  if (request.status === "withdrawn") return "Withdrawn";
  const settlement = requestSettlementLabel(request);
  if (settlement) return settlement;
  const prefix = request.status === "declined" ? "Declined" : "Fulfilled";
  if (request.response.kind === "choice" && request.presentation.kind === "choice") {
    const { options } = request.presentation;
    const optionId = request.response.optionId;
    const chosen = options.find((option) => option.id === optionId);
    // The one way a Request offered to decline it says nothing "Declined" does not.
    if (
      !chosen ||
      (request.status === "declined" && options.filter(requestOptionDeclines).length === 1)
    ) {
      return prefix;
    }
    return `${prefix} · ${chosen.label}`;
  }
  if (request.response.kind === "form") return `${prefix} · Answered`;
  if (request.response.kind === "external") {
    return externalDecisionLabel(request.response.value?.["decision"]) ?? prefix;
  }
  return prefix;
}

/**
 * The receipt of an externally resolved Request. Its response value carries the
 * decision, which is all the receipt says: a status beside it would repeat it.
 */
function externalDecisionLabel(decision: unknown): string | null {
  if (decision === "fulfilled") return "Allowed";
  return decision === "declined" ? "Declined" : null;
}
