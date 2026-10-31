import {
  AssignmentIdSchema,
  AssignmentSummarySchema,
  AgentCapabilityProfileIdSchema,
  BrowserAccessSuggestionSchema,
  BrowserProfileIdSchema,
  IsoDateTimeSchema,
  EnvironmentIdSchema,
  ExecutionEnvironmentKindSchema,
  BrowserProfileGrantIdSchema,
  DelegationModelChoiceSchema,
  HarnessIdSchema,
  HarnessInstanceIdSchema,
  MessageIdSchema,
  PlaceContentPartSchema,
  MessageSchema,
  MessageContentSchema,
  ModelIdSchema,
  ModelProviderIdSchema,
  ModelSelectionSchema,
  RequestIdSchema,
  RequestKindSchema,
  RequestSchema,
  readableRequestList,
  RequestStatusSchema,
  RunSchema,
  ThreadInputPolicySchema,
  ThreadInputSchema,
  ThreadIdSchema,
  ThreadSchema,
  ThreadWriteInputSchema,
  WorkspaceBackingKindSchema,
  WorkspaceIconNameSchema,
  MarkColorSchema,
  WorkspaceIdSchema,
  WorkspaceKindSchema,
  type Workspace,
} from "@opensteer/core";
import { z } from "zod";
import { TriggerControlInputSchema } from "@opensteer/triggers";
import {
  BrowserTabReadInputSchema,
  BrowserTabReadResultSchema,
  BrowserTabWriteInputSchema,
  BrowserTabWriteResultSchema,
  AgentBrowserSessionSummarySchema,
  BrowserSessionIdSchema,
} from "./browser.js";
import { AgentBrowserSignInResultSchema } from "./browser-sources.js";
import { agentToolPayloadMaxSerializedBytes } from "./common.js";
import { PasswordSignInCodeSchema } from "./password-sign-in.js";
import { MachineAliasSchema } from "./shell.js";
import {
  DurableWindowCursorSchema,
  DurableWindowSchema,
  ThreadMessageWindowSchema,
  WorkspaceViewSchema,
  workspaceViewFromWorkspace,
} from "./client.js";

const AgentDurableWindowSchema = z.strictObject(DurableWindowSchema.shape);
const AgentThreadMessageWindowSchema = z.strictObject({
  ...ThreadMessageWindowSchema.shape,
});
/**
 * The Workspace an agent is told about. The icon and colour are presentation
 * for people, and a Runner's strict parser from before them must still read
 * this, so they are left out rather than negotiated.
 */
const agentOmittedWorkspaceFields = { color: true, icon: true } as const;
const AgentWorkspaceViewSchema = z.strictObject({
  ...WorkspaceViewSchema.omit(agentOmittedWorkspaceFields).shape,
  capacity: z.discriminatedUnion("kind", [
    z.strictObject(WorkspaceViewSchema.shape.capacity.options[0].shape),
    z.strictObject(WorkspaceViewSchema.shape.capacity.options[1].shape),
  ]),
  location: z.discriminatedUnion("kind", [
    z.strictObject(WorkspaceViewSchema.shape.location.options[0].shape),
    z.strictObject(WorkspaceViewSchema.shape.location.options[1].shape),
  ]),
  storageIssue: z.strictObject(WorkspaceViewSchema.shape.storageIssue.unwrap().shape).nullable(),
});

export function agentWorkspaceView(workspace: Workspace): z.infer<typeof AgentWorkspaceViewSchema> {
  // A plain object schema drops the key the agent view does not carry.
  return WorkspaceViewSchema.omit(agentOmittedWorkspaceFields).parse(
    workspaceViewFromWorkspace(workspace),
  );
}
const AgentBrowserSessionSummaryStrictSchema = z.strictObject({
  ...AgentBrowserSessionSummarySchema.shape,
  placement: z.strictObject(AgentBrowserSessionSummarySchema.shape.placement.shape),
});

const requestBase = {
  requestId: z.uuid(),
} as const;
export const EnvironmentListInputSchema = z
  .strictObject({
    query: z
      .string()
      .trim()
      .max(256)
      .transform((query) => query || undefined)
      .optional(),
    harnessInstanceId: HarnessInstanceIdSchema.optional(),
    cursor: z.string().min(1).max(2_048).optional(),
    environmentCursor: EnvironmentIdSchema.optional(),
    harnessCursor: HarnessInstanceIdSchema.optional(),
  })
  .superRefine((input, context) => {
    if (input.cursor && !input.harnessInstanceId)
      context.addIssue({ code: "custom", message: "cursor requires harnessInstanceId" });
    if (input.harnessInstanceId && (input.environmentCursor || input.harnessCursor))
      context.addIssue({
        code: "custom",
        message: "Focus cannot be combined with directory cursors",
      });
  });
export type EnvironmentListInput = z.infer<typeof EnvironmentListInputSchema>;

const AgentControlRequestUnionSchema = z.discriminatedUnion("type", [
  EnvironmentListInputSchema.safeExtend({
    ...requestBase,
    type: z.literal("environment.list"),
  }),
  z.strictObject({
    ...requestBase,
    before: DurableWindowCursorSchema.optional(),
    limit: z.number().int().min(1).max(50).default(25),
    type: z.literal("workspace.list"),
  }),
  z.strictObject({
    ...requestBase,
    maxThreads: z.number().int().min(1).max(100).optional(),
    maxWorkspaces: z.number().int().min(1).max(50).optional(),
    harnessCursor: HarnessInstanceIdSchema.optional(),
    modelPage: z
      .strictObject({
        harnessInstanceId: HarnessInstanceIdSchema,
        cursor: z.string().min(1).max(2_048).optional(),
      })
      .optional(),
    threadBefore: DurableWindowCursorSchema.optional(),
    type: z.literal("workspace.inspect"),
    workspaceBefore: DurableWindowCursorSchema.optional(),
  }),
  z.strictObject({
    ...requestBase,
    color: MarkColorSchema.optional(),
    icon: WorkspaceIconNameSchema.optional(),
    name: z.string().trim().min(1).max(160),
    // Absent means this Deployment's default backing; a local directory with
    // no machine named is on the machine the caller runs on.
    storage: z
      .discriminatedUnion("backing", [
        z.strictObject({
          backing: z.literal("local-directory"),
          environmentId: EnvironmentIdSchema.optional(),
        }),
        z.strictObject({ backing: z.literal("portablefs") }),
      ])
      .optional(),
    type: z.literal("workspace.create"),
  }),
  z.strictObject({
    ...requestBase,
    type: z.literal("workspace.mount"),
    workspaceId: WorkspaceIdSchema,
  }),
  z.strictObject({
    ...requestBase,
    assignmentBefore: DurableWindowCursorSchema.optional(),
    before: DurableWindowCursorSchema.optional(),
    maxMessages: z.number().int().min(1).max(100).default(100),
    query: z.string().trim().min(1).max(256).optional(),
    aroundMessageId: MessageIdSchema.optional(),
    threadId: ThreadIdSchema,
    type: z.literal("thread.read"),
  }),
  z.strictObject({
    ...requestBase,
    before: DurableWindowCursorSchema.optional(),
    limit: z.number().int().min(1).max(50).default(25),
    query: z.string().trim().min(1).max(256).optional(),
    type: z.literal("thread.list"),
    workspaceId: WorkspaceIdSchema.optional(),
  }),
  z.strictObject({
    ...requestBase,
    environmentId: EnvironmentIdSchema.optional(),
    harnessInstanceId: HarnessInstanceIdSchema.optional(),
    model: DelegationModelChoiceSchema.optional(),
    observationId: z.string().trim().min(1).max(255).optional(),
    places: z.array(PlaceContentPartSchema).max(63).optional(),
    task: z
      .string()
      .trim()
      .min(1)
      .max(64 * 1_024),
    title: z.string().trim().min(1).max(240).optional(),
    /** A new task Thread's symbol; an existing Thread keeps its own. */
    icon: WorkspaceIconNameSchema.optional(),
    type: z.literal("thread.delegate"),
    threadId: ThreadIdSchema.optional(),
    workspaceId: WorkspaceIdSchema.optional(),
  }),
  z.strictObject({
    ...requestBase,
    assignmentId: AssignmentIdSchema,
    type: z.literal("assignment.cancel"),
  }),
  z.strictObject({
    ...requestBase,
    content: MessageContentSchema,
    delivery: ThreadInputPolicySchema,
    observationId: z.string().trim().min(1).max(255).optional(),
    threadId: z.union([ThreadIdSchema, z.literal("home")]),
    type: z.literal("thread.message"),
  }),
  z.strictObject({
    ...requestBase,
    input: ThreadWriteInputSchema,
    type: z.literal("thread.write"),
  }),
  z.strictObject({
    ...requestBase,
    before: DurableWindowCursorSchema.optional(),
    limit: z.number().int().min(1).max(100).default(50),
    type: z.literal("request.list"),
  }),
  z.strictObject({
    ...requestBase,
    targetRequestId: RequestIdSchema,
    type: z.literal("request.withdraw"),
  }),
  z.strictObject({
    ...requestBase,
    name: z.string().trim().min(1).max(120),
    type: z.literal("browser.profile.create"),
  }),
  z.strictObject({
    ...requestBase,
    site: z.string().trim().min(1).max(2_048).optional(),
    type: z.literal("browser.profile.list"),
  }),
  z.strictObject({
    ...requestBase,
    /** Legacy Runner field, accepted for compatibility and ignored. */
    code: PasswordSignInCodeSchema.optional(),
    reason: z.string().trim().min(1).max(500),
    sessionId: BrowserSessionIdSchema,
    site: z.string().trim().min(1).max(2_048),
    /** Legacy Runner field, accepted for compatibility and ignored. */
    targetId: z.string().min(1).max(512).optional(),
    type: z.literal("browser.sign-in"),
  }),
  z.strictObject({
    ...requestBase,
    reason: z.string().trim().min(1).max(500),
    sessionId: BrowserSessionIdSchema.optional(),
    site: z.string().trim().min(1).max(2_048),
    type: z.literal("sign-in"),
  }),
  z.strictObject({
    ...requestBase,
    reason: z.string().trim().min(1).max(500),
    suggestion: BrowserAccessSuggestionSchema,
    type: z.literal("browser.access.request"),
    workspaceId: WorkspaceIdSchema.optional(),
  }),
  /**
   * The computer is named by the alias the Run's machine-access note listed,
   * which is the only name the agent ever sees for it; the Host resolves the
   * alias against the same reachable set the note was rendered from.
   */
  z.strictObject({
    ...requestBase,
    computer: MachineAliasSchema,
    reason: z.string().trim().min(1).max(500),
    type: z.literal("machine.full-disk-access.request"),
  }),
  z.strictObject({
    ...requestBase,
    input: BrowserTabReadInputSchema,
    type: z.literal("browser.tab.read"),
  }),
  z.strictObject({
    ...requestBase,
    input: BrowserTabWriteInputSchema,
    type: z.literal("browser.tab.write"),
  }),
  z.strictObject({ ...requestBase, type: z.literal("browser.session.list") }),
  z.strictObject({
    ...requestBase,
    environmentId: EnvironmentIdSchema.optional(),
    fresh: z.literal(true).optional(),
    profileId: BrowserProfileIdSchema.optional(),
    sessionId: BrowserSessionIdSchema.optional(),
    type: z.literal("browser.session.open"),
  }),
  z.strictObject({
    ...requestBase,
    reason: z.string().trim().min(1).max(500),
    sessionId: BrowserSessionIdSchema,
    suggestedName: z.string().trim().min(1).max(120).optional(),
    type: z.literal("browser.profile.save"),
  }),
  z.strictObject({
    ...requestBase,
    sessionId: BrowserSessionIdSchema,
    type: z.literal("browser.session.close"),
  }),
  z.strictObject({
    ...requestBase,
    input: TriggerControlInputSchema,
    // The Host admits, authorizes, and derives idempotency per originating tool.
    tool: z.enum(["trigger.read", "trigger.write"]),
    type: z.literal("trigger.control"),
  }),
]);
export const AgentControlRequestSchema = AgentControlRequestUnionSchema.refine(
  (request) =>
    request.type !== "browser.session.open" ||
    [request.fresh, request.profileId, request.sessionId].filter(Boolean).length === 1,
  "Choose exactly one of an existing session to attach, a granted browser profile, or a fresh session",
)
  .refine(
    (request) =>
      request.type !== "workspace.inspect" ||
      request.harnessCursor === undefined ||
      request.modelPage === undefined,
    "Choose either an AI engine profile page or one profile's model page",
  )
  .refine(
    (request) =>
      request.type !== "thread.delegate" ||
      ((request.threadId !== undefined) !== (request.workspaceId !== undefined) &&
        (request.threadId === undefined ||
          (request.environmentId === undefined &&
            request.harnessInstanceId === undefined &&
            request.model === undefined))),
    "Choose one destination; reuse of a Thread cannot change its execution placement",
  )
  .refine(
    (request) =>
      new TextEncoder().encode(JSON.stringify(request)).byteLength <=
      agentToolPayloadMaxSerializedBytes,
    `Agent control request must not exceed ${agentToolPayloadMaxSerializedBytes} serialized bytes`,
  );
export type AgentControlRequest = z.infer<typeof AgentControlRequestSchema>;

const responseBase = {
  requestId: z.uuid(),
} as const;

/**
 * How many of an engine profile's models an agent is shown to choose among,
 * and how many across one inspection, so the largest reply stays bounded.
 */
export const agentHarnessModelsShown = 20;
export const agentInspectionModelsShown = 100;

const AgentModelSummarySchema = z.strictObject({
  modelId: ModelIdSchema,
  providerId: ModelProviderIdSchema,
});
export type AgentModelSummary = z.infer<typeof AgentModelSummarySchema>;

const HarnessSummarySchema = z.strictObject({
  driverKind: HarnessIdSchema,
  enabled: z.boolean(),
  environmentId: EnvironmentIdSchema,
  id: HarnessInstanceIdSchema,
  /** The models this engine profile offers, as its latest catalog reports them. */
  models: z.array(AgentModelSummarySchema).max(agentHarnessModelsShown),
  modelsOmitted: z.number().int().nonnegative(),
  modelsNextCursor: z.string().min(1).max(2_048).optional(),
  name: z.string().min(1).max(120),
});
export type AgentHarnessSummary = z.infer<typeof HarnessSummarySchema>;

const EnvironmentSummarySchema = z.strictObject({
  compatibleHarnessInstanceIds: z.array(HarnessInstanceIdSchema).max(64),
  connected: z.boolean(),
  id: EnvironmentIdSchema,
  kind: ExecutionEnvironmentKindSchema,
  name: z.string().min(1).max(120),
  // An agent choosing where a new Workspace should live needs to know which
  // machines can hold a directory of their own and which cannot.
  workspaceBackings: z.array(WorkspaceBackingKindSchema).max(2),
});

const EnvironmentModelOptionSchema = z.union([
  z.strictObject({
    id: z.string().min(1).max(100),
    values: z.array(z.string().max(255)).min(1).max(32),
    default: z.string().max(255).optional(),
  }),
  z.strictObject({
    id: z.string().min(1).max(100),
    values: z.tuple([z.literal(false), z.literal(true)]),
    default: z.boolean().optional(),
  }),
]);
export const EnvironmentHarnessSummarySchema = HarnessSummarySchema.extend({
  models: z
    .array(
      AgentModelSummarySchema.extend({
        displayName: z.string().min(1).max(120).optional(),
        options: z.array(EnvironmentModelOptionSchema).min(1).max(16).optional(),
      }),
    )
    .max(8),
  status: z.enum([
    "disabled",
    "disconnected",
    "unreported",
    "ready",
    "authentication-required",
    "preparing",
    "unavailable",
    "error",
  ]),
  detail: z.string().min(1).max(500).optional(),
});
export type EnvironmentHarnessSummary = z.infer<typeof EnvironmentHarnessSummarySchema>;
const DelegationDefaultSchema = z.strictObject({
  environmentId: EnvironmentIdSchema,
  harnessInstanceId: HarnessInstanceIdSchema,
  model: z.strictObject({
    modelId: ModelIdSchema,
    options: ModelSelectionSchema.shape.options,
    providerId: ModelProviderIdSchema,
  }),
});
export const EnvironmentDiscoverySchema = z.strictObject({
  delegationDefault: DelegationDefaultSchema,
  environments: z.array(EnvironmentSummarySchema).max(64),
  environmentsNextCursor: EnvironmentIdSchema.optional(),
  harnesses: z
    .array(EnvironmentHarnessSummarySchema)
    .max(64)
    .refine((rows) => rows.reduce((count, row) => count + row.models.length, 0) <= 40),
  harnessesNextCursor: HarnessInstanceIdSchema.optional(),
});
export type EnvironmentDiscovery = z.infer<typeof EnvironmentDiscoverySchema>;

const WorkspaceSummarySchema = z.strictObject({
  id: WorkspaceIdSchema,
  kind: WorkspaceKindSchema,
  name: z.string().min(1).max(160),
  status: z.enum([
    "provisioning",
    "ready",
    "archiving",
    "archived",
    "unavailable",
    "failed",
    "deleting",
    "deleted",
  ]),
});

const AcceptedThreadInputResultSchema = z.strictObject({
  input: ThreadInputSchema,
  message: MessageSchema,
  run: RunSchema.nullable(),
  thread: ThreadSchema,
});

const DeliveredThreadInputResultSchema = AcceptedThreadInputResultSchema.extend({
  /** The open Assignment this input joined, so a correction is seen to reach running work. */
  assignmentId: AssignmentIdSchema.nullable(),
  disposition: z.enum(["cancelled", "pending", "steering", "run-queued"]),
});

export const AgentThreadSummarySchema = z.strictObject({
  doneAt: ThreadSchema.shape.doneAt.optional(),
  environmentConnected: z.boolean(),
  environmentId: ThreadSchema.shape.environmentId,
  id: ThreadSchema.shape.id,
  parentThreadId: ThreadSchema.shape.parentThreadId,
  pendingRequests: ThreadSchema.shape.pendingRequests,
  status: ThreadSchema.shape.status,
  title: ThreadSchema.shape.title.nullable(),
  updatedAt: ThreadSchema.shape.updatedAt,
  workspaceId: ThreadSchema.shape.workspaceId,
  workspaceName: WorkspaceSummarySchema.shape.name,
});

const GrantedBrowserProfileSchema = z.strictObject({
  siteData: z
    .strictObject({ hasData: z.boolean(), savedAt: IsoDateTimeSchema.nullable() })
    .optional(),
  access: z.literal("full-control"),
  grantId: BrowserProfileGrantIdSchema,
  id: BrowserProfileIdSchema,
  name: z.string().min(1).max(120),
});

export const RequestCreationResultSchema = z.strictObject({
  kind: RequestKindSchema,
  replayed: z.boolean(),
  requestId: RequestIdSchema,
  status: RequestStatusSchema,
});
export type RequestCreationResult = z.infer<typeof RequestCreationResultSchema>;

const AgentControlResponseUnionSchema = z.discriminatedUnion("type", [
  EnvironmentDiscoverySchema.extend({
    ...responseBase,
    type: z.literal("environment.list.result"),
  }),
  z.strictObject({
    ...responseBase,
    type: z.literal("workspace.list.result"),
    workspaces: z.array(WorkspaceSummarySchema).max(50),
    window: AgentDurableWindowSchema,
  }),
  z.strictObject({
    ...responseBase,
    profile: z.strictObject({ id: BrowserProfileIdSchema, name: z.string().min(1).max(120) }),
    type: z.literal("browser.profile.create.result"),
  }),
  z.strictObject({
    ...responseBase,
    type: z.literal("workspace.create.result"),
    workspace: AgentWorkspaceViewSchema,
  }),
  z.strictObject({
    ...responseBase,
    path: z.string().min(1).max(4_096),
    type: z.literal("workspace.mount.result"),
    workspaceId: WorkspaceIdSchema,
  }),
  z.strictObject({
    ...responseBase,
    /** Where new delegated work runs unless the caller names an engine or model. */
    delegationDefault: DelegationDefaultSchema,
    environments: z.array(EnvironmentSummarySchema).max(64),
    environmentsTruncated: z.boolean(),
    harnesses: z
      .array(HarnessSummarySchema)
      .max(64)
      .refine(
        (harnesses) =>
          harnesses.reduce((count, { models }) => count + models.length, 0) <=
          agentInspectionModelsShown,
        `An inspection shows at most ${agentInspectionModelsShown} models`,
      ),
    harnessesTruncated: z.boolean(),
    harnessesNextCursor: HarnessInstanceIdSchema.optional(),
    threadWindow: AgentDurableWindowSchema,
    threads: z.array(ThreadSchema).max(100),
    type: z.literal("workspace.inspect.result"),
    workspaceWindow: AgentDurableWindowSchema,
    workspaces: z.array(WorkspaceSummarySchema).max(50),
  }),
  z.strictObject({
    ...responseBase,
    assignments: z.array(AssignmentSummarySchema).max(50),
    assignmentWindow: AgentDurableWindowSchema,
    messages: z.array(MessageSchema).max(100),
    thread: ThreadSchema,
    type: z.literal("thread.read.result"),
    window: AgentThreadMessageWindowSchema,
  }),
  z.strictObject({
    ...responseBase,
    result: AcceptedThreadInputResultSchema.extend({ assignmentId: AssignmentIdSchema }),
    type: z.literal("thread.delegate.result"),
  }),
  z.strictObject({
    ...responseBase,
    assignment: AssignmentSummarySchema,
    type: z.literal("assignment.cancel.result"),
  }),
  z.strictObject({
    ...responseBase,
    threads: z.array(AgentThreadSummarySchema).max(50),
    type: z.literal("thread.list.result"),
    window: AgentDurableWindowSchema,
  }),
  z.strictObject({
    ...responseBase,
    result: DeliveredThreadInputResultSchema,
    type: z.literal("thread.message.result"),
  }),
  z.strictObject({
    ...responseBase,
    /** Done on this Run's own task waits for the Run to end; see `thread_write`. */
    doneWhenRunEnds: z.boolean(),
    thread: AgentThreadSummarySchema,
    type: z.literal("thread.write.result"),
  }),
  z.strictObject({
    ...responseBase,
    requests: readableRequestList(RequestSchema, 100),
    type: z.literal("request.list.result"),
    window: AgentDurableWindowSchema,
  }),
  z.strictObject({
    ...responseBase,
    request: RequestSchema,
    type: z.literal("request.withdraw.result"),
  }),
  z.strictObject({
    ...responseBase,
    profiles: z.array(GrantedBrowserProfileSchema).max(128),
    site: z.string().min(1).max(2_048).optional(),
    type: z.literal("browser.profile.list.result"),
  }),
  z.strictObject({
    ...responseBase,
    result: AgentBrowserSignInResultSchema,
    type: z.literal("browser.sign-in.result"),
  }),
  z.strictObject({
    ...responseBase,
    result: AgentBrowserSignInResultSchema,
    type: z.literal("sign-in.result"),
  }),
  z.strictObject({
    ...responseBase,
    result: RequestCreationResultSchema.extend({ kind: z.literal("browser.access") }),
    type: z.literal("browser.access.request.result"),
  }),
  z.strictObject({
    ...responseBase,
    result: RequestCreationResultSchema.extend({ kind: z.literal("browser.profile.save") }),
    type: z.literal("browser.profile.save.result"),
  }),
  z.strictObject({
    ...responseBase,
    result: RequestCreationResultSchema.extend({ kind: z.literal("machine.full-disk-access") }),
    type: z.literal("machine.full-disk-access.request.result"),
  }),
  z.strictObject({
    ...responseBase,
    session: AgentBrowserSessionSummaryStrictSchema,
    type: z.literal("browser.session.open.result"),
    wasExisting: z.boolean(),
  }),
  z.strictObject({
    ...responseBase,
    sessions: z.array(AgentBrowserSessionSummaryStrictSchema).max(100),
    type: z.literal("browser.session.list.result"),
  }),
  z.strictObject({
    ...responseBase,
    result: BrowserTabReadResultSchema,
    type: z.literal("browser.tab.read.result"),
  }),
  z.strictObject({
    ...responseBase,
    result: BrowserTabWriteResultSchema,
    type: z.literal("browser.tab.write.result"),
  }),
  z.strictObject({
    ...responseBase,
    sessionId: BrowserSessionIdSchema.nullable(),
    type: z.literal("browser.session.close.result"),
  }),
  z.strictObject({
    ...responseBase,
    result: z.unknown(),
    type: z.literal("trigger.control.result"),
  }),
]);
export const agentControlResponseMaxSerializedBytes = agentToolPayloadMaxSerializedBytes;
export const AgentControlResponseSchema = AgentControlResponseUnionSchema.refine(
  (response) =>
    new TextEncoder().encode(JSON.stringify(response)).byteLength <=
    agentControlResponseMaxSerializedBytes,
  `Agent control response must not exceed ${agentControlResponseMaxSerializedBytes} serialized bytes`,
);
export type AgentControlResponse = z.infer<typeof AgentControlResponseSchema>;

export const RunAgentControlPlanSchema = z.strictObject({
  token: z.string().min(1).max(4_096),
  url: z.url(),
});
export type RunAgentControlPlan = z.infer<typeof RunAgentControlPlanSchema>;

export const RunBrowserCdpPlanSchema = z.strictObject({
  token: z.string().min(1).max(4_096),
  url: z.url(),
});
export type RunBrowserCdpPlan = z.infer<typeof RunBrowserCdpPlanSchema>;

export const RunAgentToolsPlanSchema = z.strictObject({
  capabilityProfileId: AgentCapabilityProfileIdSchema,
  token: z.string().min(1).max(4_096),
  url: z.url(),
});
export type RunAgentToolsPlan = z.infer<typeof RunAgentToolsPlanSchema>;

export const RunIntegrationToolsPlanSchema = z.strictObject({
  token: z.string().min(1).max(4_096),
  url: z.url(),
});
export type RunIntegrationToolsPlan = z.infer<typeof RunIntegrationToolsPlanSchema>;

export const RunIntegrationSkillsPlanSchema = z.strictObject({
  token: z.string().min(1).max(4_096),
  url: z.url(),
});
export type RunIntegrationSkillsPlan = z.infer<typeof RunIntegrationSkillsPlanSchema>;

export const IntegrationSkillBundleSchema = z.strictObject({
  plugins: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(64),
        skills: z
          .array(
            z.strictObject({
              files: z
                .array(
                  z.strictObject({
                    content: z.string().max(24 * 1_024 * 1_024),
                    executable: z.boolean(),
                    path: z.string().min(1).max(4_096),
                  }),
                )
                .max(10_000),
              name: z.string().min(1).max(64),
            }),
          )
          .max(1_000),
      }),
    )
    .max(128),
});
export type IntegrationSkillBundle = z.infer<typeof IntegrationSkillBundleSchema>;
