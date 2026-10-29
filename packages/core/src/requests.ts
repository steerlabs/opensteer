import { z } from "zod";
import { ComputerAppIdentitySchema } from "./computer-app.js";
import {
  AssignmentIdSchema,
  BrowserProfileIdSchema,
  BrowserSourceIdSchema,
  BrowserSurfaceIdSchema,
  RequestIdSchema,
  ExecutionNodeIdSchema,
  RunIdSchema,
  RunnerIdSchema,
  ThreadIdSchema,
  TriggerOccurrenceIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
} from "./ids.js";
import { causalChainMaxDelegations, IsoDateTimeSchema } from "./models.js";
import { BrowserSiteSchema, BrowserSourceSiteSchema } from "./browser-sources.js";

const RequestIdentifierSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.includes("\0"), "Request identifiers cannot contain a null byte");

export const RequestKindSchema = z.enum([
  "harness.approval",
  "harness.input",
  "browser.access",
  "browser.profile.save",
  "browser.profile.import",
  "browser.sign-in",
  "browser.password-sign-in",
  "integration.access",
  "integration.install",
  "machine.full-disk-access",
  "computer.app.access",
]);
type RequestKind = z.infer<typeof RequestKindSchema>;

export const RequestModeSchema = z.enum(["live", "durable"]);
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
  "workspace-deleted",
  "membership-revoked",
  "resource-deleted",
  "authority-revoked",
]);
export type RequestCancellationReason = z.infer<typeof RequestCancellationReasonSchema>;

export const RequestRequiredActorSchema = z.enum(["requester", "workspace-owner", "administrator"]);
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
 * Set when the title names something an agent proposed, such as an integration
 * it researched, rather than something Opensteer vouches for. The title stays
 * the plain name and every surface shows the provenance beside it, so a name
 * like `Gmail — approved by your administrator` never reads as Opensteer's own
 * words.
 */
const RequestAgentProposedSchema = z.literal(true).optional();

const requestPresentationVariants = [
  z.strictObject({
    agentProposed: RequestAgentProposedSchema,
    detail: z.string().max(requestTextMaxLength).optional(),
    kind: z.literal("choice"),
    options: z.array(RequestOptionSchema).min(1).max(32),
    risk: z.enum(["low", "medium", "high"]).optional(),
    title: z.string().trim().min(1).max(requestTitleMaxLength),
  }),
  z.strictObject({
    agentProposed: RequestAgentProposedSchema,
    detail: z.string().max(requestTextMaxLength).optional(),
    fields: z.array(RequestFormFieldSchema).min(1).max(16),
    kind: z.literal("form"),
    title: z.string().trim().min(1).max(requestTitleMaxLength),
  }),
  z.strictObject({
    agentProposed: RequestAgentProposedSchema,
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
    options: z.array(RequestOptionViewSchema).min(1).max(32),
  }),
  z.object({
    ...requestPresentationVariants[1].shape,
    fields: z.array(RequestFormFieldViewSchema).min(1).max(16),
  }),
  z.object({
    ...requestPresentationVariants[2].shape,
    subject: z.object(requestPresentationVariants[2].shape.subject.shape),
  }),
]);
export type RequestPresentation = z.infer<typeof RequestPresentationSchema>;

/**
 * What a surface shows beside the title of a Request whose subject an agent
 * proposed, and beside the proposed integration itself wherever it is listed.
 */
export const requestAgentProposedLabel = "Proposed by an agent";

/**
 * What the label means, for its tooltip and the proposed integration's own page.
 * Only an integration is ever proposed by an agent.
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
    kind: z.literal("browser.profile.save"),
    reason: RequestReasonSchema,
    sessionId: RequestIdentifierSchema,
    suggestedName: z.string().trim().min(1).max(120).optional(),
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
  z.strictObject({
    kind: z.literal("integration.install"),
    manifest: RequestJsonObjectSchema,
    reason: RequestReasonSchema,
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
    machineId: RunnerIdSchema,
    machineName: z.string().trim().min(1).max(160),
    reason: RequestReasonSchema,
  }),
  /** Read-only: the copy-into-a-new-profile flow that browser sign-ins replaced. */
  z.strictObject({
    kind: z.literal("browser.profile.import"),
    reason: RequestReasonSchema,
    sourceId: BrowserSourceIdSchema,
    sourceName: z.string().trim().min(1).max(120),
    site: BrowserSourceSiteSchema,
  }),
  /**
   * An agent wants one website signed in, in one live Browser Session, with
   * the person's own Chrome sign-in. Allowing it remembers the site for the
   * Request's target Workspace. It stays pending while no connected Chrome can
   * supply the sign-in and completes by itself once one can.
   */
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
   * the computer itself — the Mac, or the phone in the owner's hand: nobody can
   * approve it from anywhere else, only decline it.
   */
  /**
   * The vault Mac alone approves saved-login use, with the person present;
   * any client may decline it. Workspace consent covers websites and apps
   * and outlives Browser Sessions. The legacy session payload remains readable
   * so historical Requests retain their original scope and consent wording.
   * `operationId` names live vault authority, never a persisted credential or
   * loginRef; the Request expires unanswered at `expiresAt`.
   */
  z
    .strictObject({
      /** The approving Runner and its computer name when the Request was opened. */
      computerName: z.string().trim().min(1).max(160),
      expiresAt: IsoDateTimeSchema,
      kind: z.literal("browser.password-sign-in"),
      /** Historical page binding; Workspace-scoped Requests have no page or session. */
      tabId: BrowserSurfaceIdSchema.optional(),
      operationId: z.uuid(),
      reason: RequestReasonSchema,
      runnerId: RunnerIdSchema,
      sessionId: z.string().min(1).max(128).optional(),
      scope: z.literal("workspace").optional(),
      permissionVersion: z.literal(5).optional(),
      site: BrowserSiteSchema,
    })
    .refine(
      passwordSignInScopeValid,
      "Password sign-in requires a legacy session or Workspace consent",
    ),
  z
    .strictObject({
      access: z.enum(["read", "read-write"]),
      app: z.strictObject(computerAppIdentityShape).nullable(),
      definitionId: z.enum(["macos-app", "android-phone"]),
      kind: z.literal("computer.app.access"),
      reason: RequestReasonSchema,
      runnerId: RunnerIdSchema,
      setupRequestId: z.uuid(),
      workspaceId: WorkspaceIdSchema,
    })
    .superRefine((payload, context) => {
      if ((payload.app === null) !== (payload.definitionId === "android-phone")) {
        context.addIssue({
          code: "custom",
          message: "A Mac app access request names its app; a phone access request names none",
          path: ["app"],
        });
      }
    }),
] as const;
export const RequestPayloadSchema = z.discriminatedUnion("kind", requestPayloadVariants);
const RequestPayloadViewSchema = z.discriminatedUnion("kind", [
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
  z.object(requestPayloadVariants[7].shape),
  z.object(requestPayloadVariants[8].shape),
  z
    .object(requestPayloadVariants[9].shape)
    .refine(
      passwordSignInScopeValid,
      "Password sign-in requires a legacy session or Workspace consent",
    ),
  z.object({
    ...requestPayloadVariants[10].shape,
    app: z.object(computerAppIdentityShape).nullable(),
  }),
]);
export type RequestPayload = z.infer<typeof RequestPayloadSchema>;

const requestBaseShape = {
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
  /** The subagent of the originating Run that asked; absent for the Run's own agent. */
  originatingNodeId: ExecutionNodeIdSchema.optional(),
  originatingRunId: RunIdSchema.nullable(),
  originatingThreadId: ThreadIdSchema,
  originatingWorkspaceId: WorkspaceIdSchema,
  payload: RequestPayloadSchema,
  presentation: RequestPresentationSchema,
  requestedBy: UserIdSchema,
  requiredActor: RequestRequiredActorSchema,
  targetWorkspaceId: WorkspaceIdSchema,
} as const;
const requestViewBaseShape = {
  ...requestBaseShape,
  payload: RequestPayloadViewSchema,
  presentation: RequestPresentationViewSchema,
} as const;

function validateRequestInvariants(
  request: {
    readonly kind: RequestKind;
    readonly mode: RequestMode;
    readonly originatingOccurrenceId: string | null;
    readonly originatingRunId: string | null;
    readonly payload: RequestPayload;
  },
  context: z.RefinementCtx,
): void {
  if ((request.originatingRunId === null) === (request.originatingOccurrenceId === null)) {
    context.addIssue({
      code: "custom",
      message:
        "A Request originates from exactly one of a Run or a Trigger Occurrence, never both and never neither",
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
        "An integration access Request targets exactly one installed integration or install manifest",
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
    resolvedBy: UserIdSchema,
    response: RequestResponseSchema,
    status: z.literal("fulfilled"),
  })
  .superRefine(validateRequestInvariants);
const FulfilledRequestViewSchema = z
  .object({
    ...requestViewBaseShape,
    cancellationReason: z.null(),
    resolvedAt: IsoDateTimeSchema,
    resolvedBy: UserIdSchema,
    response: RequestResponseViewSchema,
    status: z.literal("fulfilled"),
  })
  .superRefine(validateRequestInvariants);

export const DeclinedRequestSchema = z
  .strictObject({
    ...requestBaseShape,
    cancellationReason: z.null(),
    resolvedAt: IsoDateTimeSchema,
    resolvedBy: UserIdSchema,
    response: RequestResponseSchema,
    status: z.literal("declined"),
  })
  .superRefine(validateRequestInvariants);
const DeclinedRequestViewSchema = z
  .object({
    ...requestViewBaseShape,
    cancellationReason: z.null(),
    resolvedAt: IsoDateTimeSchema,
    resolvedBy: UserIdSchema,
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
const askingSubagent = z.object({ id: ExecutionNodeIdSchema, title: z.string().min(1).max(240) });

export const WaitingRequestSchema = z.object({
  assignments: waitingRequestAssignments,
  /** The subagent of the Run that asked, when it was not the Run's own agent. */
  subagent: askingSubagent.nullable().default(null),
  request: PendingRequestSchema,
});
export const WaitingRequestViewSchema = z.object({
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

function passwordSignInScopeValid(payload: {
  readonly sessionId?: string | undefined;
  readonly tabId?: string | undefined;
  readonly scope?: "workspace" | undefined;
  readonly permissionVersion?: 5 | undefined;
}): boolean {
  return payload.scope === "workspace"
    ? payload.permissionVersion === 5 &&
        payload.sessionId === undefined &&
        payload.tabId === undefined
    : payload.sessionId !== undefined && payload.permissionVersion === undefined;
}

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
