import { z } from "zod";
import {
  AppIdSchema,
  AssignmentIdSchema,
  AssignmentSummarySchema,
  BrowserProfileIdSchema,
  EnvironmentIdSchema,
  ExecutionEnvironmentKindSchema,
  HarnessIdSchema,
  HarnessInstanceIdSchema,
  MessageIdSchema,
  MessageSchema,
  ModelIdSchema,
  ModelProviderIdSchema,
  ModelSelectionSchema,
  RequestIdSchema,
  RequestKindSchema,
  RequestStatusSchema,
  RunSchema,
  ThreadIdSchema,
  ThreadInputSchema,
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

export const WindowSchema = z.object({
  byteCount: z.number(),
  hasMore: z.boolean(),
  itemCount: z.number(),
  nextBefore: z.string().nullable(),
  totalItems: z.number(),
  threadId: ThreadIdSchema.optional(),
});
export const ThreadOutputSchema = z.object(ThreadSchema.shape);
export const ThreadSummarySchema = z.object({
  doneAt: ThreadSchema.shape.doneAt.optional(),
  environmentConnected: z.boolean(),
  environmentId: EnvironmentIdSchema,
  id: ThreadIdSchema,
  parentThreadId: ThreadSchema.shape.parentThreadId,
  pendingRequests: ThreadSchema.shape.pendingRequests,
  status: ThreadSchema.shape.status,
  title: z.string().nullable(),
  updatedAt: ThreadSchema.shape.updatedAt,
  workspaceId: WorkspaceIdSchema,
  workspaceName: z.string(),
});
export const MessageOutputSchema = z.object(MessageSchema.shape);
export const ThreadReadOutputSchema = z
  .object({
    assignments: z.array(AssignmentSummarySchema).max(50),
    assignmentWindow: WindowSchema,
    messages: z.array(MessageOutputSchema).max(100),
    thread: ThreadOutputSchema,
    window: WindowSchema,
  })
  .refine(
    (result) => new TextEncoder().encode(JSON.stringify(result)).byteLength <= 432 * 1024,
    "Thread history exceeds the agent output byte limit",
  );
export const ThreadListOutputSchema = z.object({
  threads: z.array(ThreadSummarySchema).max(50),
  window: WindowSchema,
});
export const ThreadDelegateOutputSchema = z.object({
  assignmentId: AssignmentIdSchema,
  input: z.object(ThreadInputSchema.shape),
  message: MessageOutputSchema,
  run: z.object(RunSchema.shape).nullable(),
  thread: ThreadOutputSchema,
});
export const ThreadMessageOutputSchema = ThreadDelegateOutputSchema.extend({
  assignmentId: AssignmentIdSchema.nullable(),
  disposition: z.enum(["cancelled", "pending", "steering", "run-queued"]),
});
export const ThreadWriteOutputSchema = z.object({
  thread: ThreadSummarySchema,
  doneWhenRunEnds: z.boolean(),
});
export const AssignmentCancelOutputSchema = z.object({ assignment: AssignmentSummarySchema });
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
  grantId: z.string().optional(),
  access: z.enum(["read", "read-write"]).optional(),
});
export const BrowserProfileCreateOutputSchema = z.object({ profile: BrowserProfileOutputSchema });
export const BrowserProfileListOutputSchema = z.object({
  profiles: z.array(BrowserProfileOutputSchema),
});
export const SignInOutputSchema = z.object({
  status: z.string(),
  site: z.string().optional(),
  account: z.string().optional(),
  profileName: z.string().nullable().optional(),
  sourceName: z.string().optional(),
  method: z.string().optional(),
  reason: z.string().optional(),
  expiresAt: z.string().optional(),
  requestId: RequestIdSchema.optional(),
  replayed: z.boolean().optional(),
  waitingFor: z.string().optional(),
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
  cancelled: z.number().optional(),
  replayed: z.boolean().optional(),
});
