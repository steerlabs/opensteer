import { z } from "zod";
import {
  AppIdSchema,
  AssignmentIdSchema,
  AssignmentStatusSchema,
  BrowserProfileIdSchema,
  BrowserSiteSchema,
  DelegationModelChoiceSchema,
  EnvironmentIdSchema,
  ExecutionEnvironmentKindSchema,
  HarnessIdSchema,
  HarnessInstanceIdSchema,
  MessageIdSchema,
  MessageSchema,
  ModelIdSchema,
  ModelProviderIdSchema,
  ModelSelectionSchema,
  PlaceContentPartSchema,
  PlaceIdentitySchema,
  ProviderSessionIdSchema,
  RequestIdSchema,
  RequestKindSchema,
  RequestStatusSchema,
  RunSchema,
  RunnerIdSchema,
  ThreadIdSchema,
  TriggerOccurrenceIdSchema,
  ThreadSchema,
  WorkspaceBackingKindSchema,
  WorkspaceIdSchema,
  WorkspaceKindSchema,
} from "@opensteer/core";
import {
  TriggerViewSchema,
  TriggerRevisionViewSchema,
  TriggerOccurrenceViewSchema,
  TriggerSummaryViewSchema,
  TriggerWatchActivationViewSchema,
} from "@opensteer/triggers";
export const agentHarnessModelsShown = 20;
export const agentInspectionModelsShown = 100;

const AgentModelSummarySchema = z.object({
  modelId: ModelIdSchema,
  providerId: ModelProviderIdSchema,
});
export type AgentModelSummary = z.infer<typeof AgentModelSummarySchema>;

const HarnessSummarySchema = z.object({
  lightModel: DelegationModelChoiceSchema.optional(),
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

const EnvironmentSummarySchema = z.object({
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
  z.object({
    id: z.string().min(1).max(100),
    values: z.array(z.string().max(255)).min(1).max(32),
    default: z.string().max(255).optional(),
  }),
  z.object({
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
const DelegationDefaultSchema = z.object({
  environmentId: EnvironmentIdSchema,
  harnessInstanceId: HarnessInstanceIdSchema,
  model: z.object({
    modelId: ModelIdSchema,
    options: ModelSelectionSchema.shape.options,
    providerId: ModelProviderIdSchema,
  }),
});
export const EnvironmentDiscoverySchema = z.object({
  delegationDefault: DelegationDefaultSchema.optional(),
  environments: z.array(EnvironmentSummarySchema).max(64),
  environmentsNextCursor: EnvironmentIdSchema.optional(),
  harnesses: z
    .array(EnvironmentHarnessSummarySchema)
    .max(64)
    .refine((rows) => rows.reduce((count, row) => count + row.models.length, 0) <= 40),
  harnessesNextCursor: HarnessInstanceIdSchema.optional(),
});
export type EnvironmentDiscovery = z.infer<typeof EnvironmentDiscoverySchema>;

export const WindowSchema = z.object({
  byteCount: z.number(),
  hasMore: z.boolean(),
  itemCount: z.number(),
  nextBefore: z.string().nullable(),
  totalItems: z.number(),
  threadId: ThreadIdSchema.optional(),
});
const thread = ThreadSchema.shape;
const PageSchema = { hasMore: z.boolean(), nextBefore: z.string().nullable() };

export const ThreadDetailSchema = z.object({
  id: thread.id,
  title: thread.title,
  status: thread.status,
  role: thread.role,
  workspaceId: thread.workspaceId,
  environmentId: thread.environmentId,
  harnessInstanceId: thread.harnessInstanceId,
  modelSelection: thread.modelSelection,
  accessMode: thread.accessMode,
  parentThreadId: thread.parentThreadId,
  pendingRequests: thread.pendingRequests,
  inputQueuePaused: thread.inputQueuePaused,
  doneAt: thread.doneAt,
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
});
export const ThreadSummarySchema = z.object({
  assignmentId: AssignmentIdSchema.nullable(),
  doneAt: thread.doneAt.optional(),
  environmentConnected: z.boolean(),
  environmentId: EnvironmentIdSchema,
  id: ThreadIdSchema,
  parentThreadId: thread.parentThreadId,
  pendingRequests: thread.pendingRequests,
  status: thread.status,
  taskStatus: AssignmentStatusSchema.nullable(),
  title: z.string().nullable(),
  updatedAt: thread.updatedAt,
  workspaceId: WorkspaceIdSchema,
  workspaceName: z.string(),
});
export const ThreadListOutputSchema = z.object({
  threads: z.array(ThreadSummarySchema).max(50),
  ...PageSchema,
});
/** One shape for `thread_delegate`, `task_status` and `task_cancel`. */
export const TaskSchema = z.object({
  /** Null only for a connection's work, which has no Assignment. */
  assignmentId: AssignmentIdSchema.nullable(),
  threadId: ThreadIdSchema,
  runId: RunSchema.shape.id.nullable(),
  runStatus: RunSchema.shape.status.nullable(),
  status: AssignmentStatusSchema,
  title: z.string(),
  objective: z.string().nullable(),
  result: z.string().nullable(),
  pendingRequests: thread.pendingRequests,
  parentThreadId: ThreadIdSchema.nullable(),
  workspaceId: WorkspaceIdSchema,
  environmentId: EnvironmentIdSchema,
  createdAt: thread.createdAt,
  finishedAt: z.string().nullable(),
});
export const ThreadMessageOutputSchema = z.object({
  assignmentId: AssignmentIdSchema.nullable(),
  disposition: z.enum(["cancelled", "pending", "steering", "run-queued"]),
  messageId: MessageIdSchema,
  runId: RunSchema.shape.id.nullable(),
});
export const ThreadInterruptOutputSchema = z.object({
  interruptedRunId: RunSchema.shape.id.nullable(),
});
export const ThreadUpdateOutputSchema = z.object({
  title: thread.title,
  doneAt: thread.doneAt,
  doneWhenRunEnds: z.boolean(),
});
export const ProjectSummarySchema = z.object({
  id: WorkspaceIdSchema,
  kind: WorkspaceKindSchema,
  name: z.string(),
  status: z.string(),
});
export const ProjectListOutputSchema = z.object({
  projects: z.array(ProjectSummarySchema),
  window: WindowSchema,
});
export const ProjectCreateOutputSchema = z.object({
  id: WorkspaceIdSchema,
  slug: z.string(),
  path: z.string(),
});
export const AppPublishOutputSchema = z.object({
  appId: AppIdSchema,
  version: z.number().int(),
  message: z.string(),
});
export const AppListOutputSchema = z.object({
  apps: z.array(
    z.object({
      id: AppIdSchema,
      title: z.string(),
      kind: z.enum(["html", "server"]),
      folder: z.string().optional(),
      start: z.string().optional(),
      threadId: ThreadIdSchema,
      latestVersion: z.number(),
      updatedAt: z.string(),
    }),
  ),
});
export const AppFetchOutputSchema = z.object({
  status: z.number(),
  contentType: z.union([z.string(), z.array(z.string())]).optional(),
  body: z.string(),
  truncated: z.boolean(),
});
export const PluginInstallOutputSchema = z.object({
  pluginId: z.string().nullable(),
  issues: z.array(
    z.object({
      message: z.string().optional(),
      component: z.enum(["manifest", "mcp", "skill"]).optional(),
      entry: z.string().nullable().optional(),
      severity: z.string().optional(),
      code: z.string().optional(),
    }),
  ),
  specialist: z.boolean(),
  registration: z.object({ id: z.string(), status: z.string(), plugin: z.string() }).nullable(),
});
export const PersonMessageOutputSchema = z.object({ messageId: MessageIdSchema });
export const PersonShowOutputSchema = z.object({
  status: z.enum(["sent-unconfirmed", "no-device-connected", "already-requested"]),
  connectedDevices: z.number().int().nonnegative(),
});
export const RequestOutputSchema = z.object({
  id: RequestIdSchema,
  kind: RequestKindSchema,
  status: RequestStatusSchema,
  reason: z.string().nullable().optional(),
  originatingThreadId: ThreadIdSchema.nullable().optional(),
  targetWorkspaceId: WorkspaceIdSchema.nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  title: z.string().optional(),
  settlementProvenance: z.object({ deviceLabel: z.string() }).nullable().optional(),
});
export const RequestListOutputSchema = z.object({
  requests: z.array(RequestOutputSchema),
  window: WindowSchema,
});
export const RequestWithdrawOutputSchema = z.object({ request: RequestOutputSchema });
export const RequestCreationOutputSchema = z.object({
  kind: RequestKindSchema,
  replayed: z.boolean(),
  requestId: RequestIdSchema,
  status: RequestStatusSchema,
});
export const BrowserProfileOutputSchema = z.object({
  id: BrowserProfileIdSchema,
  name: z.string(),
  home: z.object({ runnerId: RunnerIdSchema, name: z.string(), reachable: z.boolean() }).nullable(),
  grantId: z.string().optional(),
  access: z.enum(["read", "read-write"]).optional(),
});
export const BrowserProfileListOutputSchema = z.object({
  profiles: z.array(BrowserProfileOutputSchema),
});
export const SignInOutputSchema = z.object({
  status: z.string(),
  site: z.string().optional(),
  // A login reference grants nothing by itself: each fill needs the Run's
  // current authority over that surface, and saved-password sign-in needs it.
  loginRef: z.string().optional(),
  account: z.string().optional(),
  profileName: z.string().nullable().optional(),
  sourceName: z.string().optional(),
  method: z.string().optional(),
  reason: z.string().optional(),
  passwords: z.string().optional(),
  expiresAt: z.string().optional(),
  requestId: RequestIdSchema.optional(),
  replayed: z.boolean().optional(),
  waitingFor: z.string().optional(),
  guidance: z.string().optional(),
});
export const BrowserSessionSchema = z.object({
  id: z.string(),
  access: z.enum(["read", "read-write"]),
  createdAt: z.string(),
  origin: z.enum(["agent", "trigger", "workspace"]),
  placement: z.object({
    environmentId: EnvironmentIdSchema.optional(),
    runtimeId: z.string().optional(),
    runnerId: z.string().optional(),
    label: z.string().optional(),
    kind: z.string().optional(),
  }),
  profileId: BrowserProfileIdSchema.nullable(),
  runtimeId: z.string(),
  state: z.string(),
  updatedAt: z.string(),
  workspaceId: WorkspaceIdSchema,
  activeAttachmentCount: z.number(),
  attached: z.boolean(),
  profileName: z.string().nullable(),
});
export const BrowserSessionListOutputSchema = z.object({ sessions: z.array(BrowserSessionSchema) });
export const BrowserSessionOpenOutputSchema = z.object({
  session: BrowserSessionSchema,
  wasExisting: z.boolean(),
});
export const BrowserSessionCloseOutputSchema = z.object({
  closed: z.boolean(),
  sessionId: z.string().nullable(),
});
export const BrowserTabReadOutputSchema = z.object({
  totalMatches: z.number().optional(),
  groups: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      color: z.string(),
      collapsed: z.boolean(),
      createdBy: z.string(),
      tabCount: z.number(),
    }),
  ),
  tabs: z.array(
    z.object({
      tabId: z.string(),
      title: z.string(),
      matchedFields: z.array(z.string()).optional(),
      site: z.string(),
      state: z.string(),
      sessionId: z.string().nullable(),
      profileId: BrowserProfileIdSchema.nullable(),
      groupId: z.string().nullable(),
      position: z.number().optional(),
      usedByThisTask: z.boolean(),
      usedByOtherTask: z.boolean(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export const BrowserTabWriteOutputSchema = z.object({
  action: z.string(),
  groupId: z.string().optional(),
  closed: z.array(z.string()).optional(),
  failed: z.array(z.object({ tabId: z.string(), message: z.string() })).optional(),
  restored: z.array(z.object({ tabId: z.string(), sessionId: z.string() })).optional(),
});
const SafeTriggerSchema = TriggerViewSchema.omit({ webhookRouteKey: true });
export const TriggerOutputSchema = z.object({
  trigger: SafeTriggerSchema.optional(),
  revision: TriggerRevisionViewSchema.optional(),
  triggers: z.array(TriggerSummaryViewSchema.omit({ webhookRouteKey: true })).optional(),
  occurrences: z.array(TriggerOccurrenceViewSchema).optional(),
  occurrence: TriggerOccurrenceViewSchema.optional(),
  watch: TriggerWatchActivationViewSchema.nullable().optional(),
  canceledOccurrenceIds: z.array(TriggerOccurrenceIdSchema).optional(),
  activation: TriggerWatchActivationViewSchema.nullable().optional(),
  anchorThreadTitle: z.string().optional(),
  createdByThreadTitle: z.string().nullable().optional(),
  downstreamRuns: z
    .array(
      z.object({
        occurrenceId: TriggerOccurrenceIdSchema,
        run: z.object(RunSchema.shape),
        threadTitle: z.string(),
      }),
    )
    .max(100)
    .optional(),
  downstreamRunsTruncated: z.boolean().optional(),
  replayed: z.boolean().optional(),
});

export const TriggerWriteOutputSchema = TriggerOutputSchema.extend({
  webhook: z.object({ url: z.url(), secret: z.string().min(1) }).optional(),
});

export { AgentMediaContentSchema, IntegrationCallOutputSchema } from "./integration-outputs.js";

/** A timeline entry. `itemId` is a message ID, or an activity event's sequence. */
export const ThreadItemSchema = z.object({
  itemId: z.string(),
  type: z.string(),
  status: z.string(),
  runId: RunSchema.shape.id.nullable(),
  author: MessageSchema.shape.author.optional(),
  title: z.string().nullable(),
  text: z.string().nullable(),
  textTruncated: z.boolean(),
  nextTextOffset: z.number().int().nonnegative().nullable(),
  places: z.array(PlaceContentPartSchema).max(64).optional(),
  createdAt: z.string(),
});
export type ThreadItem = z.infer<typeof ThreadItemSchema>;

export const ThreadWaitOutputSchema = z.object({
  status: z.enum(["running", "settled", "offline", "timed_out"]),
  pendingRequest: z.object({ id: z.string(), kind: z.string() }).optional(),
  run: z.object({ id: RunSchema.shape.id, status: RunSchema.shape.status }).optional(),
  items: z.array(ThreadItemSchema).max(100),
  hasMore: z.boolean(),
});
export const ThreadConfigureOutputSchema = z.object({
  threadId: ThreadIdSchema,
  environmentId: EnvironmentIdSchema,
  harnessInstanceId: HarnessInstanceIdSchema,
  modelSelection: z.object({
    modelId: ModelIdSchema,
    providerId: ModelProviderIdSchema,
    options: ModelSelectionSchema.shape.options,
  }),
  providerSessionId: ProviderSessionIdSchema.nullable(),
});
export const ThreadQueueOutputSchema = z.object({
  paused: z.boolean(),
  items: z
    .array(
      z.object({
        messageId: MessageIdSchema,
        author: MessageSchema.shape.author,
        preview: z.string().max(500),
        truncated: z.boolean(),
        canCancel: z.boolean(),
        canMove: z.boolean(),
        canSteer: z.boolean(),
      }),
    )
    .max(100),
});

export const ThreadReadOutputSchema = z
  .object({
    thread: ThreadDetailSchema,
    recentRuns: z
      .array(
        z.object({
          runId: RunSchema.shape.id,
          status: RunSchema.shape.status,
          assignmentId: AssignmentIdSchema.nullable(),
          modelId: ModelIdSchema,
          createdAt: z.string(),
          startedAt: z.string().nullable(),
          completedAt: z.string().nullable(),
        }),
      )
      .max(50),
    recentPlaces: z
      .array(
        z.object({
          runId: RunSchema.shape.id,
          place: PlaceIdentitySchema,
          title: z.string(),
          site: z.string().nullable(),
        }),
      )
      .max(10),
    items: z.array(ThreadItemSchema).max(100),
    ...PageSchema,
  })
  .refine(
    (result) => new TextEncoder().encode(JSON.stringify(result)).byteLength <= 432 * 1024,
    "Thread history exceeds the agent output byte limit",
  );

export const UseCardOutputSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("ready"),
    site: BrowserSiteSchema,
    cardRef: z.string().regex(/^crd_[0-9a-f]{32}$/u),
    brand: z.string().min(1).max(64),
    lastFour: z.string().regex(/^\d{4}$/u),
  }),
  z.strictObject({
    status: z.literal("pending"),
    site: BrowserSiteSchema,
    requestId: RequestIdSchema,
  }),
  z.strictObject({
    status: z.enum(["resolved", "declined", "needs-approval"]),
    site: BrowserSiteSchema,
    guidance: z.string().optional(),
  }),
  z.strictObject({
    status: z.literal("unavailable"),
    site: BrowserSiteSchema,
    reason: z.enum([
      "unsupported",
      "runtime-outdated",
      "main-browser-required",
      "session-closed",
      "not-allowed",
      "rate-limited",
      "busy",
      "stopped",
      "expired",
      "interrupted",
      "no-saved-card",
      "passwords-off",
      "passwords-not-set-up",
      "passwords-not-responding",
    ]),
  }),
]);
export type UseCardOutput = z.infer<typeof UseCardOutputSchema>;
